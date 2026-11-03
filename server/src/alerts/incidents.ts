/**
 * 이슈 문서 모델 — 저장 형식 · 클라이언트 생성 이슈 정규화 · 상태 전이 · 처리 기록(타임라인 · SLA 시각) 병합.
 * incidents.doc = src/core/types.ts Incident + MILDO Alert 확장 필드(AlertIncident) + 서버 필드(아래 ServerFields).
 * status · severity · rule_id 열은 doc과 항상 같게 유지한다.
 */
import type { Incident, MediaId, SalesChannelId, Severity } from '@/core/types';
import { backupOf, msToKstIso, regimeOf, roleLabel, STATUS_LABEL, type AlertIncident } from '@/modules/alert/engine';
import { MEDIA_OWNER_ROLE } from '@/modules/alert/data';
import type { Queryable } from '../db/pool';
import { nowMs, kstToday } from '../lib/time';
import { conflict } from '../lib/errors';
import { z } from '../lib/validate';
import type { EscStage } from '@/modules/notify/message';

export type { EscStage };

export type IncidentStatus = Incident['status'];
export const STATUSES: readonly IncidentStatus[] = ['open', 'ack', 'action', 'resolved'];
export const SEVERITIES: readonly Severity[] = ['P1', 'P2', 'P3'];
export const sevRank = (s: Severity | string) => (s === 'P1' ? 1 : s === 'P2' ? 2 : 3);

export type SlaKey = 'ackAt' | 'assignedAt' | 'actionAt' | 'reportAt' | 'preventAt' | 'resolvedAt';
export const SLA_KEYS: readonly SlaKey[] = ['ackAt', 'assignedAt', 'actionAt', 'reportAt', 'preventAt', 'resolvedAt'];

export interface ServerFields {
  /** scan = 서버 감지, client = 화면 · 다른 모듈이 만든 이슈 (AD Pilot 보류 · 테스트 주입 등) */
  source?: 'scan' | 'client';
  /** 감지 기준일 (Dataset.today) — 같은 날 재감지 여부 판정용 */
  dataDate?: string;
  /** 데이터 기준 시각 (Dataset.generatedAt) */
  dataAsOf?: string;
  /** 마지막 감지에서도 잡혔는지 (false = 열려 있지만 더 이상 감지되지 않음 · 운영자 확인 필요) */
  stillDetected?: boolean;
  clearedAt?: string;
  /** SLA 단계별 에스컬레이션 기록 (단계당 1회) */
  escalations?: Partial<Record<EscStage, { at: string; deadline: string; notified: number }>>;
  createdBy?: string;
}
export type StoredIncident = AlertIncident & ServerFields;

/** 서버 시각 (KST ISO, +09:00) — 프런트 데이터 시계가 'Z' 표기를 세션 경과로 환산하므로 KST 표기로 남긴다 */
export const nowIso = () => msToKstIso(nowMs());

/* ------------------------------ 검증 스키마 ------------------------------ */

/** 이슈 id: 규칙:대상:날짜 형식(한글 · 공백 포함) — 제어 문자 · 경로 문자(? # \)는 금지 */
export const IncidentId = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !/[\u0000-\u001f\u007f?#\\]/.test(s) && s.trim() === s, { message: '이슈 id 형식이 올바르지 않습니다' });

const Num = z.number().finite();
const Iso = z.string().max(40);
const Text = (n: number) => z.string().max(n);

const TimelineEntry = z.object({ at: Iso, by: Text(120), action: Text(500) });

/** POST /incidents 본문의 incident — 알려진 필드는 형식을 검사하고 확장 필드(evidence · causes 등)는 그대로 둔다 */
export const IncidentInput = z.looseObject({
  id: IncidentId,
  ruleId: z.string().min(1).max(100),
  severity: z.enum(['P1', 'P2', 'P3']),
  title: z.string().min(1).max(300),
  media: z.string().max(40).optional(),
  target: Text(300).optional(),
  detectedAt: Iso.optional(),
  occurredAt: Iso.optional(),
  detectPath: Text(500).optional(),
  metric: Text(100).optional(),
  observed: Num.optional(),
  baseline: Num.optional(),
  deltaPct: Num.optional(),
  causeCandidates: z.array(Text(500)).max(20).optional(),
  impact: z.object({ impressionsLost: Num.optional(), spendAtRisk: Num.optional(), revenueLossEst: Num.optional() }).optional(),
  assignee: Text(100).optional(),
  backup: Text(100).optional(),
  status: z.enum(['open', 'ack', 'action', 'resolved']).optional(),
  timeline: z.array(TimelineEntry).max(200).optional(),
  actionNote: Text(2000).optional(),
  preventNote: Text(2000).optional(),
  isTest: z.boolean().optional(),
  autoActions: z.array(Text(500)).max(30).optional(),
});

const SlaPatch = z.object(Object.fromEntries(SLA_KEYS.map((k) => [k, Iso.optional()])) as Record<SlaKey, z.ZodOptional<z.ZodString>>).partial();

/** PATCH /incidents/:id 본문의 patch — 운영자가 바꿀 수 있는 필드만 (나머지는 무시) */
export const IncidentPatch = z.object({
  status: z.enum(['open', 'ack', 'action', 'resolved']).optional(),
  assignee: Text(100).optional(),
  backup: Text(100).optional(),
  assigneeRoleId: Text(40).optional(),
  backupRoleId: Text(40).optional(),
  actionNote: Text(2000).optional(),
  preventNote: Text(2000).optional(),
  falsePositive: z.boolean().optional(),
  sla: SlaPatch.optional(),
});
export type IncidentPatchInput = z.infer<typeof IncidentPatch>;

const SERVER_KEYS: (keyof ServerFields)[] = ['source', 'dataDate', 'dataAsOf', 'stillDetected', 'clearedAt', 'escalations', 'createdBy'];
const MAX_DOC_BYTES = 96 * 1024;

/* ------------------------------ 클라이언트 생성 이슈 ------------------------------ */

/** 화면 · 다른 모듈이 만든 이슈를 저장 형식으로: 서버 필드 제거, 감지 시각 보정, 담당 미지정 시 당번표 · 매체 담당 배정 */
export function normalizeClientIncident(input: z.infer<typeof IncidentInput>, by: string, atMs = nowMs()): StoredIncident {
  const raw = { ...(input as Record<string, unknown>) };
  for (const k of SERVER_KEYS) delete raw[k];
  const at = msToKstIso(atMs);
  const det = input.detectedAt ? Date.parse(input.detectedAt) : NaN;
  // 감지 시각은 SLA 기준점 — 최근 24시간 ~ 5분 뒤 범위 밖이면 서버 수신 시각으로 둔다 (과거 · 미래로 꾸며 SLA를 피하지 못하게)
  const detectedAt = Number.isFinite(det) && det >= atMs - 24 * 3600_000 && det <= atMs + 5 * 60_000 ? msToKstIso(det) : at;
  const doc = {
    causeCandidates: [],
    impact: {},
    autoActions: [],
    timeline: [],
    detectPath: '화면에서 생성',
    isTest: false,
    status: 'open' as IncidentStatus,
    ...raw,
    detectedAt,
    occurredAt: input.occurredAt ?? detectedAt,
    source: 'client' as const,
    createdBy: by,
  } as unknown as StoredIncident;
  if (!doc.timeline.length) doc.timeline = [{ at: detectedAt, by, action: '이슈 생성' }];
  if (!doc.assignee) Object.assign(doc, rosterAssignment(doc, kstToday(atMs)));
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_DOC_BYTES) throw conflict('이슈 문서가 너무 큽니다 (96KB 초과)');
  return doc;
}

/** p.48 담당 배정: 주말 · 공휴일이면 당번표, 평일이면 매체 담당 (없으면 총괄 PM) */
export function rosterAssignment(i: Pick<Incident, 'media'>, date: string): Pick<StoredIncident, 'assignee' | 'backup' | 'assigneeRoleId' | 'backupRoleId' | 'onDuty' | 'ownerRoleId'> {
  const regime = regimeOf(date);
  const owner = (i.media && MEDIA_OWNER_ROLE[i.media as MediaId | SalesChannelId]) || 'pm';
  const assigneeRoleId = regime.off && regime.duty ? regime.duty.roleId : owner;
  const backupRoleId = backupOf(assigneeRoleId);
  return { ownerRoleId: owner, assigneeRoleId, backupRoleId, assignee: roleLabel(assigneeRoleId), backup: roleLabel(backupRoleId), onDuty: regime.off };
}

/* ------------------------------ 상태 전이 · 처리 기록 ------------------------------ */

const ORDER: Record<IncidentStatus, number> = { open: 0, ack: 1, action: 2, resolved: 3 };
export type Transition = 'same' | 'forward' | 'reopen';

/** 허용 흐름: open → ack → action → resolved (앞 단계 건너뛰기 허용 · 오탐 즉시 종료 등), resolved → open(재오픈). 그 밖의 되돌림은 거부 */
export function transitionOf(from: IncidentStatus, to: IncidentStatus): Transition | null {
  if (from === to) return 'same';
  if (from === 'resolved' && to === 'open') return 'reopen';
  if (ORDER[to] > ORDER[from]) return 'forward';
  return null;
}

export interface PatchOutcome { doc: StoredIncident; transition: Transition; from: IncidentStatus; to: IncidentStatus; changed: string[] }

/**
 * 운영자 처리 반영 (순수 함수). SLA 시각은 서버 시계가 원본: 이미 기록된 시각은 바꾸지 않고, 새로 기록하는 시각은 서버 시각으로 찍는다
 * (화면이 보낸 시각으로 SLA 달성을 꾸밀 수 없게). 상태 전이에 맞는 SLA 시각은 자동으로 채운다.
 */
export function applyIncidentPatch(cur: StoredIncident, patch: IncidentPatchInput, actionIn: string | undefined, by: string, at = nowIso()): PatchOutcome {
  const from = cur.status;
  const reopenAsked = actionIn?.trim().toLowerCase() === 'reopen';
  const to: IncidentStatus = patch.status ?? (reopenAsked ? 'open' : from);
  const transition = transitionOf(from, to);
  if (!transition) {
    throw conflict(`'${STATUS_LABEL[from]}' 상태에서 '${STATUS_LABEL[to]}'(으)로 되돌릴 수 없습니다. 해결된 이슈만 다시 열 수 있습니다`, { from, to });
  }
  const doc: StoredIncident = { ...cur, timeline: [...(cur.timeline ?? [])] };
  const sla = { ...(cur.sla ?? {}) } as Record<SlaKey, string | undefined>;
  const changed: string[] = [];
  const setField = <K extends keyof StoredIncident>(k: K, v: StoredIncident[K] | undefined) => {
    if (v === undefined || doc[k] === v) return;
    doc[k] = v as StoredIncident[K];
    changed.push(String(k));
  };
  setField('assignee', patch.assignee);
  setField('backup', patch.backup);
  setField('assigneeRoleId', patch.assigneeRoleId);
  setField('backupRoleId', patch.backupRoleId);
  setField('actionNote', patch.actionNote);
  setField('preventNote', patch.preventNote);
  setField('falsePositive', patch.falsePositive);

  // 화면이 기록하려는 SLA 시각: 처음 기록이면 서버 시각, 이미 있으면 유지 (resolvedAt은 해결 전이로만)
  for (const k of SLA_KEYS) {
    if (patch.sla?.[k] === undefined || k === 'resolvedAt') continue;
    if (!sla[k]) { sla[k] = at; changed.push(`sla.${k}`); }
  }
  if (patch.assignee !== undefined && !sla.assignedAt) { sla.assignedAt = at; changed.push('sla.assignedAt'); }

  if (transition !== 'same') {
    doc.status = to;
    changed.push('status');
    if (to === 'ack' || to === 'action' || to === 'resolved') sla.ackAt = sla.ackAt ?? at;
    if (to === 'action') sla.actionAt = sla.actionAt ?? at;
    if (to === 'resolved') sla.resolvedAt = at;
    if (transition === 'reopen') {
      delete sla.resolvedAt;
      doc.falsePositive = patch.falsePositive ?? false;
    }
  }
  doc.sla = Object.fromEntries(Object.entries(sla).filter(([, v]) => !!v)) as StoredIncident['sla'];

  const action = (actionIn && !reopenAsked ? actionIn.trim() : '') ||
    (transition === 'reopen' ? '재오픈' : transition === 'forward' ? STATUS_LABEL[to] : changed.length ? '정보 갱신' : '확인');
  doc.timeline.push({ at, by, action: action.slice(0, 500) });
  return { doc, transition, from, to, changed };
}

/* ------------------------------ 저장소 ------------------------------ */

interface IncidentRow { id: string; status: IncidentStatus; severity: Severity; rule_id: string; doc: StoredIncident; detected_at: Date; resolved_at: Date | null }

/** 열 값이 원본 — doc에 같은 값을 맞춰 돌려준다 */
export function rowToIncident(r: IncidentRow): StoredIncident {
  return { ...r.doc, id: r.id, status: r.status, severity: r.severity, ruleId: r.rule_id };
}

/** 열린 이슈 전부(등급 · 최신 순) + 최근 해결 500건 */
export async function listIncidents(q: Queryable, wsId: string): Promise<StoredIncident[]> {
  const open = await q.query<IncidentRow>(
    `SELECT id, status, severity, rule_id, doc, detected_at, resolved_at FROM incidents
      WHERE workspace_id = $1 AND status <> 'resolved'
      ORDER BY severity, detected_at DESC LIMIT 2000`,
    [wsId],
  );
  const resolved = await q.query<IncidentRow>(
    `SELECT id, status, severity, rule_id, doc, detected_at, resolved_at FROM incidents
      WHERE workspace_id = $1 AND status = 'resolved'
      ORDER BY resolved_at DESC NULLS LAST, updated_at DESC LIMIT 500`,
    [wsId],
  );
  return [...open.rows, ...resolved.rows].map(rowToIncident);
}

export async function getIncident(q: Queryable, wsId: string, id: string, forUpdate = false): Promise<StoredIncident | null> {
  const r = await q.query<IncidentRow>(
    `SELECT id, status, severity, rule_id, doc, detected_at, resolved_at FROM incidents WHERE workspace_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [wsId, id],
  );
  return r.rows[0] ? rowToIncident(r.rows[0]) : null;
}

/** 새 이슈만 넣는다 (같은 id가 있으면 아무것도 바꾸지 않고 false) */
export async function insertIncident(q: Queryable, wsId: string, doc: StoredIncident): Promise<boolean> {
  const det = Date.parse(doc.detectedAt);
  const r = await q.query(
    `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [doc.id, wsId, doc.ruleId, doc.severity, doc.status, JSON.stringify(doc), Number.isFinite(det) ? new Date(det) : new Date(nowMs()),
      doc.status === 'resolved' ? new Date(nowMs()) : null],
  );
  return r.rowCount > 0;
}

/** 문서 · 동기화 열 갱신 */
export async function saveIncident(q: Queryable, wsId: string, doc: StoredIncident, opts: { resolvedAt?: 'set' | 'clear' | 'keep' } = {}): Promise<void> {
  const mode = opts.resolvedAt ?? 'keep';
  await q.query(
    `UPDATE incidents SET doc = $3, status = $4, severity = $5, rule_id = $6, updated_at = now(),
            resolved_at = CASE WHEN $7 = 'set' THEN $8::timestamptz WHEN $7 = 'clear' THEN NULL ELSE resolved_at END
      WHERE workspace_id = $1 AND id = $2`,
    [wsId, doc.id, JSON.stringify(doc), doc.status, doc.severity, doc.ruleId, mode, new Date(nowMs())],
  );
}
