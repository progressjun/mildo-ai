/**
 * 변경 요청 서비스 — 생성 · 상태 전이 · 반영 / 롤백 실행 · 백그라운드 마무리.
 *
 * 동시성: 모든 쓰기는 트랜잭션 + SELECT … FOR UPDATE. 반영 · 롤백은 두 단계로 나눈다.
 *   1단계(잠금): 전이 · 권한 확인 → exec_pending(시도 id) 표시 → 감시 잡(changes.execute) 예약 → 커밋
 *   2단계(잠금 없음): 점검 · 대상 해석 · 커넥터 호출 (인라인 20초 제한)
 *   3단계(잠금): 시도 id가 그대로면 결과 기록(상태 · 이력 · 실행 결과 · 감사 · 이벤트), 아니면 늦은 결과로만 이력에 남김
 * exec_pending이 있는 동안 다른 반영 · 롤백 · 보류 요청은 409 — 같은 건이 두 번 반영되지 않는다.
 * 인라인 제한을 넘기면 상태는 그대로(승인) 두고 '반영 대기(백그라운드)' 이력을 남긴다. 인라인 호출이 끝나면 그 결과로 마무리하고,
 * 프로세스가 죽는 등으로 끝나지 않으면 감시 잡이 같은 계획을 다시 실행한다(절대값 설정만 — 신규 생성 · 키워드 추가는 '결과 확인 필요' 보류).
 * 실행 중인 쪽(인라인 · 감시 잡)은 exec_pending.heartbeat를 주기적으로 갱신한다. 감시 잡 · 정리 스케줄은 heartbeat가 오래됐을 때만 이어받으므로
 * 매체 응답이 느린 동안(재시도 · Retry-After) 다른 프로세스가 같은 계획을 겹쳐 보내지 않는다.
 * 실행 계획은 커넥터를 부르기 전에 exec_pending에 저장한다 — 호출 중 프로세스가 죽어도 감시 잡이 '이미 보냈을 수 있는' 신규 생성을 다시 보내지 않는다.
 * 잠금 전 조회로 정한 액션(예: 반영)과 잠금 뒤 실제 전이(예: 그사이 보류되어 재실행)가 다르면 409 stale로 돌려준다.
 */
import type { ApprovalLevel, ChangeRequest, Dataset, Incident } from '@/core/types';
import { withWorkspaceConfig } from '@/data/config';
import { canRollback, fmtValue } from '@/modules/flow/engine';
import { officialConfig } from '@/modules/adpilot/engine';
import type { AlertIncident } from '@/modules/alert/engine';
import { GFA_DELEGATION } from '@/data/constants';
import type { AppConfig } from '../config';
import type { Db, Queryable } from '../db/pool';
import type { Role } from '../auth/permissions';
import type { WorkspaceCtx } from '../http/context';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { enqueue } from '../jobs/queue';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors';
import { isSafeId, randomToken } from '../lib/ids';
import { kstIso, kstHour, kstToday, nowMs } from '../lib/time';
import { buildDataset } from '../warehouse/dataset';
import { loadWorkspaceConfig } from '../settings/service';
import { scrubSecrets } from '../connectors/http';
import { defaultConnectorResolver, type ConnectorBinding, type ConnectorResolver } from './connector-adapter';
import { bulkIncidentsFor, decideBulk, type StoredBulk } from './bulk';
import {
  appliedBidsSince, engineChanges, getChange, insertChange, logExecution, toChange, toEngineChange, updateChange,
  type ChangeDto, type ChangeRow, type ChangeStatus, type ChangeUpdate, type ExecPending, type ExecPhase, type ExecPlan, type HistoryEntry,
  type ServerExecution,
} from './model';
import {
  ACTION_LABEL, LEVEL_RANK, STATUS_LABEL, canLowerApprover, checkActionPermission, checkEditPermission, checkNotePermission, effectivePct, historyLabel, maxLevel,
  noteEntryOf, resolveTransition, routeApprover, targetStatusOf, type ApproverContext, type ServerAction,
} from './policy';
import {
  evaluateGuards, laterLiveWrites, resolvePlan, resolveRollbackPlan, runPlan, tryBuildDataset, type GuardResult, type PlanLimits, type Resolution, type RunOutcome,
} from './executor';
import type { ConnectionRow } from './targets';
import { getConnection } from './targets';

/* ------------------------------------------------------------------ */
/* 의존성 (테스트에서 주입)                                               */
/* ------------------------------------------------------------------ */

export interface ChangeDeps {
  /** Dataset 빌더 (기본: 웨어하우스 buildDataset, KST 오늘 · 현재 시각) */
  buildDataset: (q: Queryable, ws: string) => Promise<Dataset>;
  /** 커넥션 → 커넥터 정의 · 컨텍스트 */
  resolveConnector: ConnectorResolver;
  /** 인라인 반영 제한 시간 (기본 20초) */
  inlineTimeoutMs: number;
  /** 감시 잡 실행 여유 (인라인 제한 이후, 기본 60초) */
  backgroundGraceMs: number;
  /** 실행 중 표시(heartbeat) 갱신 주기 (기본 10초) */
  heartbeatMs: number;
  /** heartbeat가 이보다 오래되면 실행 프로세스가 멈춘 것으로 보고 감시 잡이 이어받는다 (기본 60초) */
  staleAfterMs: number;
  /** 한 실행의 heartbeat 최대 유지 시간 — 커넥터가 끝없이 멈춰 있어도 이 뒤에는 감시 잡이 이어받는다 (기본 10분) */
  maxInflightMs: number;
  /** 테스트 전용: PATCH의 잠금 전 조회 직후 (경합 재현) */
  onPeek?: (ws: string, id: string) => Promise<void>;
}

const DEFAULT_DEPS: ChangeDeps = {
  buildDataset: (q, ws) => buildDataset(q, ws, { today: kstToday(), hour: kstHour() }),
  resolveConnector: defaultConnectorResolver,
  inlineTimeoutMs: 20_000,
  backgroundGraceMs: 60_000,
  heartbeatMs: 10_000,
  staleAfterMs: 60_000,
  maxInflightMs: 10 * 60_000,
};
let deps: ChangeDeps = { ...DEFAULT_DEPS };
export function configureChanges(p: Partial<ChangeDeps>): void {
  deps = { ...deps, ...p };
}
export function resetChangesConfig(): void {
  deps = { ...DEFAULT_DEPS };
}
export const changeDeps = (): ChangeDeps => deps;

/** 처리 중인 인라인 실행 (테스트 · 우아한 종료에서 기다릴 수 있게) */
const inflight = new Set<Promise<unknown>>();
export async function settleInflight(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** 실행 중 표시 갱신 — 시도 id가 그대로인 동안만, 최대 maxInflightMs */
function startHeartbeat(db: Db, ws: string, id: string, attemptId: string): () => void {
  const started = nowMs();
  const beat = () => {
    if (nowMs() - started > deps.maxInflightMs) { stop(); return; }
    void db.query(
      `UPDATE change_requests SET exec_pending = jsonb_set(exec_pending, '{heartbeat}', to_jsonb($4::text))
        WHERE workspace_id = $1 AND id = $2 AND exec_pending->>'attemptId' = $3`,
      [ws, id, attemptId, new Date(nowMs()).toISOString()],
    ).catch(() => undefined);
  };
  const timer = setInterval(beat, Math.max(10, deps.heartbeatMs));
  timer.unref?.();
  const stop = () => clearInterval(timer);
  return stop;
}

/** 마지막 생존 표시 시각 (heartbeat, 없으면 시작 시각) */
const lastBeatMs = (p: ExecPending): number => {
  const t = Date.parse(p.heartbeat ?? p.since);
  return Number.isFinite(t) ? t : 0;
};

/** 커넥터 호출 전에 실행 계획을 저장 — 시도 id가 바뀌었으면(다른 쪽이 이어받음) false */
async function persistPlan(db: Db, ws: string, id: string, attemptId: string, plan: ExecPlan): Promise<boolean> {
  const r = await db.query(
    `UPDATE change_requests SET exec_pending = jsonb_set(exec_pending, '{plan}', $4::jsonb)
      WHERE workspace_id = $1 AND id = $2 AND exec_pending->>'attemptId' = $3`,
    [ws, id, attemptId, JSON.stringify(plan)],
  );
  return r.rowCount > 0;
}

/** 계산 도중 다른 실행이 이어받아 이 시도의 결과를 기록하지 않음 */
const SUPERSEDED = 'superseded' as const;

/* ------------------------------------------------------------------ */
/* 공통                                                                */
/* ------------------------------------------------------------------ */

export interface Env { db: Db; config: AppConfig }
export interface Actor { userId: string | null; name: string; role: Role | 'system'; ip?: string | null }

const SYSTEM_BY = 'MILDO OS';
const BACKGROUND_BY = 'MILDO OS (백그라운드)';
const nowDate = () => new Date(nowMs());

/** 409 + 현재 변경 요청 */
export class ChangeConflict extends HttpError {
  constructor(message: string, public change: ChangeDto, code = 'conflict') {
    super(409, code, message, { status: change.status });
  }
}

const actorOf = (c: WorkspaceCtx): Actor => ({ userId: c.user.id, name: c.actor, role: c.role, ip: c.ip });

async function loadIncidents(q: Queryable, ws: string): Promise<Incident[]> {
  const r = await q.query<{ id: string; status: Incident['status']; doc: Incident }>(
    'SELECT id, status, doc FROM incidents WHERE workspace_id = $1 ORDER BY detected_at DESC LIMIT 500',
    [ws],
  );
  return r.rows.map((x) => ({ ...(x.doc ?? {}), id: x.id, status: x.status }) as Incident);
}

/** 대량 변경 이슈 적재 (incidents 스키마대로, 이미 있으면 그대로) → 새로 넣은 id */
async function storeBulkIncidents(q: Queryable, ws: string, list: AlertIncident[]): Promise<string[]> {
  const created: string[] = [];
  for (const b of list) {
    const r = await q.query<{ id: string }>(
      `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5::jsonb, $6, $6) ON CONFLICT DO NOTHING RETURNING id`,
      [b.id, ws, b.ruleId, b.severity, JSON.stringify({ ...b, status: 'open' }), nowDate()],
    );
    if (r.rows[0]) {
      created.push(b.id);
      await audit(q, { workspaceId: ws, actor: 'MILDO Alert', action: 'incident.detect', targetType: 'incident', targetId: b.id, detail: { ruleId: b.ruleId, severity: b.severity, title: b.title, related: b.related } });
      await publish(q, ws, { type: 'incident', id: b.id });
    }
  }
  return created;
}

/** 적재된 대량 변경 이슈 (id · 상태 · related · 종료 시각) — bulk.ts decideBulk 입력 */
async function loadStoredBulk(q: Queryable, ws: string): Promise<StoredBulk[]> {
  const r = await q.query<{ id: string; status: string; related: unknown; resolved_ms: number | null }>(
    `SELECT id, status, doc->'related' AS related,
            CASE WHEN status = 'resolved' THEN extract(epoch FROM coalesce(resolved_at, updated_at)) * 1000 END::float8 AS resolved_ms
       FROM incidents WHERE workspace_id = $1 AND id LIKE 'bulk_change:%' ORDER BY detected_at DESC LIMIT 2000`,
    [ws],
  );
  return r.rows.map((x) => ({
    id: x.id, status: x.status,
    related: Array.isArray(x.related) ? x.related.filter((v): v is string => typeof v === 'string') : [],
    resolvedAt: x.resolved_ms === null || x.resolved_ms === undefined ? null : Number(x.resolved_ms),
  }));
}

/** 현재 건이 걸린 대량 변경 실수 감지 (MILDO Alert detectBulkChange · bulk.ts) → 새 이슈만 적재 */
async function detectBulkFor(q: Queryable, ws: string, changeId: string, cfg: Record<string, unknown>): Promise<string[]> {
  const changes = await engineChanges(q, ws, 1000);
  const c = changes.find((x) => x.id === changeId);
  if (!c) return [];
  const stored = await loadStoredBulk(q, ws);
  const toStore = withWorkspaceConfig(cfg, () => decideBulk(bulkIncidentsFor(changes, c), c, stored, changes).toStore);
  return storeBulkIncidents(q, ws, toStore);
}

/* ------------------------------------------------------------------ */
/* 생성                                                                */
/* ------------------------------------------------------------------ */

export interface CreateInput {
  id?: string;
  module: string;
  kind: ChangeRequest['kind'];
  target: string;
  targetId?: string | null;
  before: string | number;
  after: string | number;
  changePct?: number | null;
  reason: string;
  requestedBy?: string;
  approver: ApprovalLevel;
  status?: ChangeStatus;
}

const newChangeId = () => `chg_${randomToken(9)}`;

/**
 * 승인 주체 재판정에 쓰는 대상 정보 — 입찰 대상 키워드가 브랜드 키워드인지(웨어하우스 키워드 문서 isBrand, 출처 무관 하나라도).
 * 화면(AD Pilot)이 브랜드 입찰을 PM 이상으로 보내는 기준을 서버도 적용해, 승인 주체를 AE로 보내 스스로 승인하는 우회를 막는다.
 */
async function approverContextOf(q: Queryable, ws: string, c: { kind: ChangeRequest['kind']; targetId?: string | null }): Promise<ApproverContext> {
  const tid = (c.targetId ?? '').trim();
  if (c.kind !== 'bid' || !tid) return {};
  const r = await q.query(
    `SELECT 1 FROM wh_entities WHERE workspace_id = $1 AND entity_type = 'keyword' AND external_id = $2 AND doc->>'isBrand' = 'true' LIMIT 1`, [ws, tid],
  );
  return { brandKeyword: r.rowCount > 0 };
}

function sameRequest(row: ChangeRow, userId: string, i: CreateInput): boolean {
  return row.requested_by_user === userId && row.module === i.module && row.kind === i.kind && row.target === i.target
    && (row.target_id ?? null) === (i.targetId ?? null) && JSON.stringify(row.before) === JSON.stringify(i.before) && JSON.stringify(row.after) === JSON.stringify(i.after);
}

export async function createChange(env: Env, wc: WorkspaceCtx, input: CreateInput): Promise<{ change: ChangeDto; created: boolean }> {
  const ws = wc.workspace.id;
  const actor = actorOf(wc);
  const at = nowDate();
  const atIso = at.toISOString();
  const cfg = await loadWorkspaceConfig(env.db, ws);
  const actx = await approverContextOf(env.db, ws, input);
  const route = withWorkspaceConfig(cfg, () => routeApprover({
    kind: input.kind, targetId: input.targetId ?? undefined, before: input.before, after: input.after, changePct: input.changePct ?? undefined, approver: input.approver,
  }, actx));
  const notes: string[] = [];
  if (input.requestedBy && input.requestedBy.trim() && input.requestedBy.trim() !== actor.name) notes.push(`요청 경로 표기: ${input.requestedBy.trim().slice(0, 100)}`);
  notes.push(...route.notes);
  const held = input.status === 'held';
  if (input.status && input.status !== 'pending' && !held) notes.push(`요청 상태 '${STATUS_LABEL[input.status]}'는 서버에서 승인 대기로 접수합니다`);
  const history: HistoryEntry[] = [{ at: atIso, by: actor.name, action: '요청 생성', note: input.reason || undefined }];
  if (notes.length) history.push({ at: atIso, by: SYSTEM_BY, action: '서버 접수', note: notes.join(' · ') });
  if (held) history.push({ at: atIso, by: actor.name, action: '자동 보류', note: input.reason || '요청 시점 자동 보류' });

  return env.db.tx(async (q) => {
    let id = input.id && isSafeId(input.id) ? input.id : newChangeId();
    const row0 = {
      createdAt: at, module: input.module, kind: input.kind, target: input.target, targetId: input.targetId ?? null,
      before: input.before, after: input.after, changePct: route.changePct, reason: input.reason, requestedBy: actor.name, requestedByUser: actor.userId,
      approver: route.approver, status: (held ? 'held' : 'pending') as ChangeStatus, history,
    };
    let row = await insertChange(q, ws, { id, ...row0 });
    if (!row) {
      const existing = await getChange(q, ws, id);
      if (existing && actor.userId && sameRequest(existing, actor.userId, input)) return { change: toChange(existing), created: false };
      id = newChangeId();
      row = await insertChange(q, ws, { id, ...row0 });
      if (!row) throw new HttpError(500, 'internal', '변경 요청 id를 만들지 못했습니다');
    }
    await audit(q, {
      workspaceId: ws, userId: actor.userId, actor: actor.name, action: 'change.create', targetType: 'change', targetId: id, ip: actor.ip,
      detail: {
        module: row.module, kind: row.kind, target: row.target, targetId: row.target_id, before: row.before, after: row.after, changePct: row.change_pct,
        approver: row.approver, clientApprover: input.approver, status: row.status, clientId: input.id ?? null, clientRequestedBy: input.requestedBy ?? null,
      },
    });
    await publish(q, ws, { type: 'change', id });
    await detectBulkFor(q, ws, id, cfg);
    return { change: toChange(row), created: true };
  });
}

/* ------------------------------------------------------------------ */
/* 상태 전이 · 수정                                                       */
/* ------------------------------------------------------------------ */

export interface PatchInput {
  patch: {
    status?: ChangeStatus;
    target?: string;
    targetId?: string | null;
    before?: string | number;
    after?: string | number;
    changePct?: number | null;
    reason?: string;
    approver?: ApprovalLevel;
  };
  action?: string;
  note?: string;
}

const EDIT_KEYS = ['target', 'targetId', 'before', 'after', 'changePct', 'reason', 'approver'] as const;
type EditKey = (typeof EDIT_KEYS)[number];

function rowValue(row: ChangeRow, k: EditKey): unknown {
  switch (k) {
    case 'target': return row.target;
    case 'targetId': return row.target_id ?? null;
    case 'before': return row.before;
    case 'after': return row.after;
    case 'changePct': return row.change_pct ?? null;
    case 'reason': return row.reason;
    case 'approver': return row.approver;
  }
}

/** 실제로 값이 바뀌는 수정 필드만 */
function editsOf(row: ChangeRow, p: PatchInput['patch']): Partial<Record<EditKey, unknown>> {
  const out: Partial<Record<EditKey, unknown>> = {};
  for (const k of EDIT_KEYS) {
    if (!(k in p) || p[k] === undefined) continue;
    const v = k === 'targetId' ? (p[k] ?? null) : p[k];
    if (JSON.stringify(v) !== JSON.stringify(rowValue(row, k))) out[k] = v;
  }
  return out;
}

const EXEC_ACTIONS = new Set<ServerAction>(['apply', 'retry', 'rollback']);

async function conflictWith(q: Queryable, ws: string, id: string, message: string, code = 'conflict'): Promise<never> {
  const row = await getChange(q, ws, id);
  if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
  throw new ChangeConflict(message, toChange(row), code);
}

export async function patchChange(env: Env, wc: WorkspaceCtx, id: string, body: PatchInput): Promise<ChangeDto> {
  const ws = wc.workspace.id;
  const peek = await getChange(env.db, ws, id);
  if (!peek) throw notFound('변경 요청을 찾을 수 없습니다');
  let to = targetStatusOf(peek, body.patch.status, body.action);
  const edits = editsOf(peek, body.patch);
  // 현재 상태를 그대로 담은 내용 수정(화면이 patch에 status를 같이 싣는 경우)은 전이가 아니라 수정으로 본다
  if (to && to === peek.status && Object.keys(edits).length) to = null;
  let expected: ServerAction | undefined;
  if (to) {
    const tr = resolveTransition(peek, to);
    expected = tr.ok ? tr.action : undefined;
    if (deps.onPeek) await deps.onPeek(ws, id);
    if (tr.ok && tr.action && EXEC_ACTIONS.has(tr.action)) {
      if (Object.keys(edits).length) await conflictWith(env.db, ws, id, '반영 · 롤백 요청에는 내용 수정을 함께 보낼 수 없습니다 — 승인 대기 상태에서 수정하세요');
      return executeTransition(env, wc, id, to, body, expected);
    }
  }
  if (!to && !Object.keys(edits).length && !body.action?.trim()) throw badRequest('바꿀 상태 · 내용 또는 이력 문구를 보내 주세요');
  return simpleTransition(env, wc, id, to, body, expected);
}

const STALE_MESSAGE = '그사이 다른 사용자 · 시스템이 상태를 바꿨습니다 — 현재 상태를 확인한 뒤 다시 시도해 주세요';

/** 반영 · 롤백이 아닌 전이 · 내용 수정 · 이력 메모 — 한 트랜잭션 */
async function simpleTransition(env: Env, wc: WorkspaceCtx, id: string, to: ChangeStatus | null, body: PatchInput, expected?: ServerAction): Promise<ChangeDto> {
  const ws = wc.workspace.id;
  const actor = actorOf(wc);
  const cfg = await loadWorkspaceConfig(env.db, ws);
  let conflict: { message: string; code: string } | null = null;
  const result = await env.db.tx(async (q) => {
    const row = await getChange(q, ws, id, true);
    if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
    const at = nowDate();
    const atIso = at.toISOString();
    const history = [...(row.history ?? [])];
    const upd: ChangeUpdate = {};
    const edits = editsOf(row, body.patch);
    const auditDetail: Record<string, unknown> = {};
    let current = toEngineChange(row);

    if (Object.keys(edits).length) {
      if (row.status !== 'pending') { conflict = { message: `내용 수정은 승인 대기 상태에서만 할 수 있습니다 (현재 ${STATUS_LABEL[row.status]})`, code: 'not_editable' }; return null; }
      const perm = checkEditPermission(wc.role, wc.user.id, row);
      if (!perm.ok) throw forbidden(perm.reason);
      const next = { ...current } as ChangeRequest;
      if ('target' in edits) next.target = String(edits.target);
      if ('targetId' in edits) next.targetId = (edits.targetId as string | null) ?? undefined;
      if ('before' in edits) next.before = edits.before as string | number;
      if ('after' in edits) next.after = edits.after as string | number;
      if ('changePct' in edits) next.changePct = (edits.changePct as number | null) ?? undefined;
      if ('reason' in edits) next.reason = String(edits.reason);
      // 값만 바꾸고 변경 폭을 안 보내면 예전 변경 폭이 남지 않게 값 기준으로 다시 계산 (계산할 수 없으면 비운다)
      if (('before' in edits || 'after' in edits) && !('changePct' in edits)) {
        const e = effectivePct({ before: next.before, after: next.after, changePct: undefined });
        next.changePct = Number.isFinite(e.computed) ? Math.round(e.computed * 10) / 10 : undefined;
      }
      // 승인 주체: PM 이상이면서 현재 승인 주체를 직접 승인할 수 있는 역할만 낮출 수 있다(CLIENT 건을 PM이 낮춰 스스로 승인하지 못하게).
      // 그 밖에는 현재보다 낮추지 않는다. 예산 · 신규 · 기준 변경은 서버 규칙으로 다시 판정
      const asked = (edits.approver as ApprovalLevel | undefined) ?? row.approver;
      const lowering = LEVEL_RANK[asked] < LEVEL_RANK[row.approver];
      const mayLower = lowering && canLowerApprover(wc.role, row.approver);
      const baseApprover = mayLower ? asked : maxLevel(row.approver, asked);
      const actx = await approverContextOf(q, ws, next);
      const route = withWorkspaceConfig(cfg, () => routeApprover({ ...next, approver: baseApprover }, actx));
      if (lowering && !mayLower) route.notes.unshift(`승인 주체 낮추기 요청(${STATUS_APPROVER(asked)})은 ${STATUS_APPROVER(row.approver)} 승인 권한이 있는 PM 이상만 할 수 있어 ${STATUS_APPROVER(row.approver)} 유지`);
      next.approver = route.approver;
      if (route.changePct !== null && !('changePct' in edits)) next.changePct = route.changePct;
      const diff = (['target', 'targetId', 'before', 'after', 'changePct', 'reason', 'approver'] as const)
        .filter((k) => JSON.stringify((current as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify((next as unknown as Record<string, unknown>)[k] ?? null));
      Object.assign(upd, {
        target: next.target, targetId: next.targetId ?? null, before: next.before, after: next.after, changePct: next.changePct ?? null, reason: next.reason, approver: next.approver,
      });
      history.push({
        at: atIso, by: actor.name, action: '내용 수정',
        note: [diff.map((k) => `${k}: ${fmtField(current, k)} → ${fmtField(next, k)}`).join(' · '), ...route.notes].filter(Boolean).join(' · ') || undefined,
      });
      auditDetail.edit = { before: Object.fromEntries(diff.map((k) => [k, (current as unknown as Record<string, unknown>)[k] ?? null])), after: Object.fromEntries(diff.map((k) => [k, (next as unknown as Record<string, unknown>)[k] ?? null])) };
      current = next;
    }

    let action: ServerAction | null = null;
    if (to) {
      if (row.exec_pending) { conflict = { message: '매체 반영 · 롤백이 진행 중입니다 — 끝난 뒤 다시 시도해 주세요', code: 'executing' }; return null; }
      const tr = resolveTransition({ ...current, status: row.status }, to);
      if (!tr.ok) { conflict = { message: tr.reason!, code: tr.code ?? 'invalid_transition' }; return null; }
      // 잠금 전 조회와 상태가 달라져 다른 액션이 된 경우(반영 · 롤백 전이 포함): 요청한 뜻과 다르므로 바꾸지 않는다
      if (EXEC_ACTIONS.has(tr.action!) || (expected && tr.action !== expected)) { conflict = { message: STALE_MESSAGE, code: 'stale' }; return null; }
      action = tr.action!;
      // 승인 시점 재판정: 요청 뒤 워크스페이스 위임 범위 · 승인 주체 하한이 바뀌었으면 지금 기준으로 올린다 (낮추지는 않는다)
      if (action === 'approve') {
        const actx = await approverContextOf(q, ws, current);
        const reroute = withWorkspaceConfig(cfg, () => routeApprover(current, actx));
        if (LEVEL_RANK[reroute.approver] > LEVEL_RANK[current.approver]) {
          history.push({
            at: atIso, by: SYSTEM_BY, action: '승인 주체 재판정',
            note: `승인 시점 기준(워크스페이스 위임 범위) — ${reroute.notes.join(' · ') || `승인 주체 ${STATUS_APPROVER(current.approver)} → ${STATUS_APPROVER(reroute.approver)}`}`,
          });
          auditDetail.reroute = { from: current.approver, to: reroute.approver };
          current = { ...current, approver: reroute.approver };
          upd.approver = reroute.approver;
          if (!checkActionPermission(wc.role, current.approver, 'approve').ok) {
            // 올린 승인 주체는 저장하고(다음 승인자가 보게) 이 승인은 409로 돌려준다
            upd.history = history;
            await updateChange(q, ws, id, upd, at);
            await audit(q, { workspaceId: ws, userId: actor.userId, actor: actor.name, ip: actor.ip, targetType: 'change', targetId: id, action: 'change.reroute', detail: auditDetail });
            await publish(q, ws, { type: 'change', id });
            conflict = { message: `승인 주체가 ${STATUS_APPROVER(current.approver)}(으)로 바뀌어 현재 역할로는 승인할 수 없습니다 — ${STATUS_APPROVER(current.approver)} 승인을 받아 주세요`, code: 'approver_changed' };
            return null;
          }
        }
      }
      const perm = checkActionPermission(wc.role, current.approver, action);
      if (!perm.ok) throw forbidden(perm.reason);
      history.push({ at: atIso, by: actor.name, action: historyLabel(action, body.action), note: body.note?.trim() || perm.reason });
      upd.status = to;
      auditDetail.from = row.status;
      auditDetail.to = to;
    } else if (!Object.keys(edits).length) {
      const perm = checkNotePermission(wc.role, wc.user.id, row);
      if (!perm.ok) throw forbidden(perm.reason);
      const entry = noteEntryOf(body.action!, body.note);
      history.push({ at: atIso, by: actor.name, action: entry.action, note: entry.note });
      auditDetail.note = { action: entry.action, label: body.action!.trim().slice(0, 60), note: body.note?.trim()?.slice(0, 500) };
    }
    upd.history = history;
    const saved = await updateChange(q, ws, id, upd, at);
    await audit(q, {
      workspaceId: ws, userId: actor.userId, actor: actor.name, ip: actor.ip, targetType: 'change', targetId: id,
      action: action ? `change.${action}` : Object.keys(edits).length ? 'change.update' : 'change.note',
      detail: { ...auditDetail, approver: saved.approver, note: body.note?.trim()?.slice(0, 500) },
    });
    await publish(q, ws, { type: 'change', id });
    if (action === 'approve') await detectBulkFor(q, ws, id, cfg);
    return saved;
  });
  if (!result) {
    const c = conflict as { message: string; code: string } | null;
    await conflictWith(env.db, ws, id, c?.message ?? '처리할 수 없는 상태입니다', c?.code);
  }
  return toChange(result!);
}

const STATUS_APPROVER = (l: ApprovalLevel) => ({ AE: '담당 AE', PM: 'PM', CLIENT: '수면밀도' })[l];

function fmtField(c: ChangeRequest, k: string): string {
  const v = (c as unknown as Record<string, unknown>)[k];
  if (v === undefined || v === null || v === '') return '—';
  if (k === 'before' || k === 'after') return fmtValue(c, v as string | number);
  if (k === 'reason') return String(v).slice(0, 40);
  return String(v);
}

/* ------------------------------------------------------------------ */
/* 반영 · 재실행 · 롤백                                                   */
/* ------------------------------------------------------------------ */

/** 실행 결과 → 기록할 내용 */
interface Finalization {
  status: ChangeStatus;
  history: HistoryEntry[];
  execution: ServerExecution;
  auditAction: string;
  appliedAt?: Date | null;
  rolledBackAt?: Date | null;
  bulkIncidents: AlertIncident[];
  logs: { phase: ExecPhase | 'compensate'; mode: 'none' | 'dry_run' | 'live'; ok: boolean; connectionId?: string; provider?: string; externalId?: string; request?: unknown; response?: unknown; error?: string; appliedValue?: string | number; opAfter?: string | number }[];
  startedAt: Date;
}

function applyExecutionOf(e: ServerExecution | null | undefined): ServerExecution | undefined {
  if (!e) return undefined;
  return e.phase === 'rollback' ? e.applyExecution : e;
}

async function executeTransition(env: Env, wc: WorkspaceCtx, id: string, to: ChangeStatus, body: PatchInput, expected?: ServerAction): Promise<ChangeDto> {
  const ws = wc.workspace.id;
  const actor = actorOf(wc);
  const attemptId = randomToken(9);
  let conflict: { message: string; code: string } | null = null;
  const claimed = await env.db.tx(async (q) => {
    const row = await getChange(q, ws, id, true);
    if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
    const tr = resolveTransition(row, to);
    if (!tr.ok) { conflict = { message: tr.reason!, code: tr.code ?? 'invalid_transition' }; return null; }
    const action = tr.action!;
    // 잠금 전에는 '반영'이었는데 그사이 보류되어 '재실행'이 된 경우 등 — 보류한 사람의 판단을 덮어쓰지 않는다
    if (expected && action !== expected) { conflict = { message: STALE_MESSAGE, code: 'stale' }; return null; }
    const perm = checkActionPermission(wc.role, row.approver, action);
    if (!perm.ok) throw forbidden(perm.reason);
    if (row.exec_pending) { conflict = { message: '이미 매체 반영 · 롤백이 진행 중입니다 — 중복 실행하지 않습니다', code: 'executing' }; return null; }
    if (action === 'rollback') {
      const all = await engineChanges(q, ws, 1000);
      const r = canRollback(all, toEngineChange(row));
      if (!r.ok) { conflict = { message: r.reason, code: 'rollback_order' }; return null; }
      const applyExec = applyExecutionOf(row.execution);
      if (applyExec?.mode === 'live') {
        const later = await laterLiveWrites(q, ws, id, applyExec.plan, row.applied_at ? new Date(row.applied_at) : null);
        if (later.length) {
          conflict = { message: `같은 매체 대상에 이후 live로 반영된 변경 ${later.length}건(${later.map((x) => x.target).join(' · ').slice(0, 200)})이 있어 최신 건부터 롤백해야 합니다`, code: 'rollback_order' };
          return null;
        }
      }
    }
    const phase: ExecPhase = action === 'rollback' ? 'rollback' : action === 'retry' ? 'retry' : 'apply';
    const since = nowDate();
    const pending: ExecPending = {
      attemptId, phase, since: since.toISOString(), by: { userId: actor.userId, name: actor.name }, label: historyLabel(action, body.action), note: body.note?.trim()?.slice(0, 2000) || undefined,
    };
    await updateChange(q, ws, id, { execPending: pending }, since);
    await enqueue(q, {
      type: 'changes.execute', workspaceId: ws, payload: { changeId: id, attemptId },
      runAt: new Date(since.getTime() + deps.inlineTimeoutMs + deps.backgroundGraceMs), dedupeKey: `changes.execute:${ws}:${id}:${attemptId}`,
    });
    return { row, pending };
  });
  if (!claimed) {
    const c = conflict as { message: string; code: string } | null;
    return conflictWith(env.db, ws, id, c?.message ?? '처리할 수 없는 상태입니다', c?.code);
  }
  const { row, pending } = claimed;
  const planRef: { plan?: ExecPlan } = {};
  const stopBeat = startHeartbeat(env.db, ws, id, attemptId);
  const work = computeExecution(env, ws, row, pending, actor.name, planRef);
  const tracked = work
    .then(
      (f) => (f === SUPERSEDED ? currentRow(env.db, ws, id) : finalize(env, ws, id, attemptId, f, actor)),
      (e) => finalize(env, ws, id, attemptId, failureOf(row, pending, e), actor),
    )
    .finally(stopBeat);
  inflight.add(tracked);
  void tracked.finally(() => inflight.delete(tracked)).catch(() => undefined);

  const timer = new Promise<'timeout'>((r) => {
    const t = setTimeout(() => r('timeout'), deps.inlineTimeoutMs);
    void tracked.finally(() => clearTimeout(t)).catch(() => undefined);
  });
  const first = await Promise.race([tracked.then((row2) => ({ row: row2 })), timer]);
  if (first !== 'timeout') return toChange(first.row);
  return deferToBackground(env, ws, id, attemptId, pending, planRef.plan, actor);
}

async function currentRow(q: Queryable, ws: string, id: string): Promise<ChangeRow> {
  const r = await getChange(q, ws, id);
  if (!r) throw notFound('변경 요청을 찾을 수 없습니다');
  return r;
}

/** 인라인 제한 초과 — 상태는 그대로, 백그라운드 마무리 표시 */
async function deferToBackground(env: Env, ws: string, id: string, attemptId: string, pending: ExecPending, plan: ExecPlan | undefined, actor: Actor): Promise<ChangeDto> {
  return env.db.tx(async (q) => {
    const row = await getChange(q, ws, id, true);
    if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
    if (row.exec_pending?.attemptId !== attemptId) return toChange(row); // 그새 마무리됨
    const at = nowDate();
    const label = pending.phase === 'rollback' ? '롤백 대기(백그라운드)' : '반영 대기(백그라운드)';
    const saved = await updateChange(q, ws, id, {
      execPending: { ...row.exec_pending, timedOut: true, plan: plan ?? row.exec_pending.plan },
      history: [...row.history, { at: at.toISOString(), by: SYSTEM_BY, action: label, note: `매체 응답이 ${Math.round(deps.inlineTimeoutMs / 1000)}초 안에 오지 않아 백그라운드에서 이어서 처리합니다 (요청 ${actor.name})` }],
    }, at);
    await audit(q, { workspaceId: ws, userId: actor.userId, actor: actor.name, ip: actor.ip, action: 'change.execute_deferred', targetType: 'change', targetId: id, detail: { phase: pending.phase, attemptId } });
    await publish(q, ws, { type: 'change', id });
    return toChange(saved);
  });
}

function failureOf(row: ChangeRow, pending: ExecPending, e: unknown): Finalization {
  const at = nowDate();
  const msg = `실행 중 오류: ${scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 500)}`;
  const rollback = pending.phase === 'rollback';
  return {
    status: rollback ? 'applied' : 'held',
    history: [{ at: at.toISOString(), by: SYSTEM_BY, action: rollback ? '롤백 실패' : '실행 보류', note: msg }],
    execution: { phase: pending.phase, mode: 'none', ok: false, at: at.toISOString(), error: msg, applyExecution: rollback ? applyExecutionOf(row.execution) : undefined },
    auditAction: rollback ? 'change.rollback_failed' : 'change.apply_held',
    bulkIncidents: [],
    logs: [{ phase: pending.phase, mode: 'none', ok: false, error: msg }],
    startedAt: at,
  };
}

/** 반영 전 점검 입력 모으기 → 워크스페이스 설정을 적용한 상태에서 점검 (+ 현재 값 대조에 쓸 상한 · 위임 범위) */
async function runGuards(env: Env, ws: string, c: ChangeRequest): Promise<GuardResult & { limits: PlanLimits }> {
  const cfg = await loadWorkspaceConfig(env.db, ws);
  const ds = await tryBuildDataset(deps.buildDataset, env.db, ws);
  const changes = await engineChanges(env.db, ws, 1000);
  const incidents = await loadIncidents(env.db, ws);
  const todayStart = new Date(kstIso(kstToday(), 0));
  const todayBids = c.kind === 'bid' && c.targetId ? await appliedBidsSince(env.db, ws, c.targetId, c.id, todayStart) : [];
  const bulkStored = await loadStoredBulk(env.db, ws);
  return withWorkspaceConfig(cfg, () => ({
    ...evaluateGuards({
      data: ds.data, dataError: ds.error, changes, incidents, change: c, today: kstToday(), todayAppliedBids: todayBids, bulkStored,
    }),
    limits: {
      bidCapPct: officialConfig(changes).dailyChangeCapPct,
      tiers: GFA_DELEGATION.map((g) => ({ maxPct: g.maxPct, approver: g.approver })),
    },
  }));
}

/** 2단계: 점검 · 대상 해석 · 커넥터 호출 (트랜잭션 밖) */
async function computeExecution(env: Env, ws: string, row: ChangeRow, pending: ExecPending, by: string, planRef: { plan?: ExecPlan }, knownPlan?: ExecPlan): Promise<Finalization | typeof SUPERSEDED> {
  const startedAt = nowDate();
  const c = toEngineChange(row);
  const rc = { db: env.db, config: env.config, resolver: deps.resolveConnector };
  const at = () => nowDate().toISOString();

  if (pending.phase === 'rollback') {
    const applyExec = applyExecutionOf(row.execution);
    const res: Resolution = knownPlan ? await bindPlan(env, ws, knownPlan) : await resolveRollbackPlan(rc, ws, c, applyExec);
    if (res.kind === 'plan') planRef.plan = res.plan;
    const restore = `직전 상태로 복원: ${fmtValue(c, c.after)} → ${fmtValue(c, c.before)}`;
    const userNote = pending.note ? ` · ${pending.note}` : '';
    if (res.kind === 'record') {
      return {
        status: 'rolled_back', startedAt, bulkIncidents: [], auditAction: 'change.rollback', rolledBackAt: nowDate(),
        history: [{ at: at(), by, action: pending.label, note: `${restore} · 매체 반영 대상 없음 — 기록만 (${res.reason})${userNote}` }],
        execution: { phase: 'rollback', mode: 'none', ok: true, at: at(), note: '매체 반영 대상 없음 — 기록만', reason: res.reason, applyExecution: applyExec } as ServerExecution,
        logs: [{ phase: 'rollback', mode: 'none', ok: true }],
      };
    }
    if (res.kind === 'blocked') {
      return {
        status: 'applied', startedAt, bulkIncidents: [], auditAction: 'change.rollback_failed',
        history: [{ at: at(), by: SYSTEM_BY, action: '롤백 보류', note: res.reason }],
        execution: { phase: 'rollback', mode: 'none', ok: false, at: at(), error: res.reason, applyExecution: applyExec },
        logs: [{ phase: 'rollback', mode: 'none', ok: false, error: res.reason }],
      };
    }
    if (!knownPlan && !(await persistPlan(env.db, ws, row.id, pending.attemptId, res.plan))) return SUPERSEDED;
    const out = await runPlan(res.plan, res.bindings, c);
    const exec = executionOf('rollback', res.plan, out, at());
    exec.applyExecution = applyExec;
    if (!out.ok) {
      return {
        status: 'applied', startedAt, bulkIncidents: [], auditAction: 'change.rollback_failed', execution: exec, logs: logsOf('rollback', res.plan, out),
        history: [{ at: at(), by: SYSTEM_BY, action: '롤백 실패', note: `매체 롤백 실패: ${out.error}${compNote(out)}` }],
      };
    }
    return {
      status: 'rolled_back', startedAt, bulkIncidents: [], auditAction: 'change.rollback', rolledBackAt: nowDate(), execution: exec, logs: logsOf('rollback', res.plan, out),
      history: [{ at: at(), by, action: pending.label, note: `${restore} · ${modeNote(res.plan)}${userNote}` }],
    };
  }

  /* 반영 · 재실행 */
  let guard: (GuardResult & { limits: PlanLimits }) | null = null;
  if (!knownPlan) {
    guard = await runGuards(env, ws, c);
    const checks = { blocks: guard.blocks, warnings: guard.warnings, passes: guard.passes };
    if (!guard.ok) {
      return {
        status: 'held', startedAt, bulkIncidents: guard.bulkIncidents, auditAction: 'change.apply_held',
        history: [{ at: at(), by: SYSTEM_BY, action: '실행 보류', note: guard.blocks.join(' · ') }],
        execution: { phase: pending.phase, mode: 'none', ok: false, at: at(), error: guard.blocks.join(' · '), checks },
        logs: [{ phase: pending.phase, mode: 'none', ok: false, error: guard.blocks.join(' · ').slice(0, 1000) }],
      };
    }
  }
  const checks = guard ? { blocks: guard.blocks, warnings: guard.warnings, passes: guard.passes } : undefined;
  const checkNote = guard ? [...guard.passes, ...guard.warnings].join(' · ') : '';
  const res: Resolution = knownPlan ? await bindPlan(env, ws, knownPlan) : await resolvePlan(rc, ws, c, guard?.limits);
  if (res.kind === 'plan') planRef.plan = res.plan;
  const auditAction = pending.phase === 'retry' ? 'change.retry' : 'change.apply';
  const userNote = pending.note ? ` · ${pending.note}` : '';
  if (res.kind === 'record') {
    return {
      status: 'applied', startedAt, bulkIncidents: [], auditAction, appliedAt: nowDate(),
      history: [{ at: at(), by, action: pending.label, note: [`매체 반영 대상 없음 — 기록만 (${res.reason})`, checkNote].filter(Boolean).join(' · ') + userNote }],
      execution: { phase: pending.phase, mode: 'none', ok: true, at: at(), note: '매체 반영 대상 없음 — 기록만', reason: res.reason, checks } as ServerExecution,
      logs: [{ phase: pending.phase, mode: 'none', ok: true }],
    };
  }
  if (res.kind === 'blocked') {
    return {
      status: 'held', startedAt, bulkIncidents: [], auditAction: 'change.apply_held',
      history: [{ at: at(), by: SYSTEM_BY, action: '실행 보류', note: res.reason }],
      execution: { phase: pending.phase, mode: 'none', ok: false, at: at(), error: res.reason, checks },
      logs: [{ phase: pending.phase, mode: 'none', ok: false, error: res.reason }],
    };
  }
  if (!knownPlan && !(await persistPlan(env.db, ws, row.id, pending.attemptId, res.plan))) return SUPERSEDED;
  const out = await runPlan(res.plan, res.bindings, c);
  const exec = executionOf(pending.phase, res.plan, out, at());
  exec.checks = checks;
  if (res.notes.length) exec.note = res.notes.join(' · ');
  if (!out.ok) {
    return {
      status: 'held', startedAt, bulkIncidents: [], auditAction: 'change.apply_held', execution: exec, logs: logsOf(pending.phase, res.plan, out),
      history: [{ at: at(), by: SYSTEM_BY, action: '실행 보류', note: `매체 반영 실패${res.plan.mode === 'dry_run' ? '(dry_run 검증)' : ''}: ${out.error}${compNote(out)}` }],
    };
  }
  return {
    status: 'applied', startedAt, bulkIncidents: [], auditAction, appliedAt: nowDate(), execution: exec, logs: logsOf(pending.phase, res.plan, out),
    history: [{ at: at(), by, action: pending.label, note: [modeNote(res.plan, out), ...res.notes, checkNote].filter(Boolean).join(' · ') + userNote }],
  };
}

function modeNote(plan: ExecPlan, out?: RunOutcome): string {
  if (plan.mode === 'dry_run') return `dry_run — 매체에 보내지 않고 요청 내용만 기록 (${plan.ops.length}건)`;
  const v = out?.results[0]?.appliedValue;
  const unverified = out?.results.some((r) => r.verifiedLive === false) ? ' · 실계정 연결 전 확인 필요 커넥터 — 매체 화면에서 반영 값을 확인해 주세요' : '';
  return `live 반영 완료 (${plan.ops.length}건${v !== undefined ? ` · 매체 적용값 ${v}` : ''})${unverified}`;
}

function compNote(out: RunOutcome): string {
  if (!out.compensation.length) return '';
  const ok = out.compensation.filter((r) => r.ok).length;
  return ` · 이미 반영된 ${out.compensation.length}건 되돌림 (${ok}건 성공${ok < out.compensation.length ? ' — 매체 화면에서 확인 필요' : ''})`;
}

function executionOf(phase: ExecPhase, plan: ExecPlan, out: RunOutcome, at: string): ServerExecution {
  const first = out.results[0];
  const multi = out.results.length > 1;
  return {
    phase,
    mode: plan.mode,
    ok: out.ok,
    at,
    connectionId: first?.connectionId,
    provider: first?.provider,
    request: multi ? out.results.map((r) => ({ externalId: r.externalId, request: r.request })) : first?.request,
    response: multi ? out.results.map((r) => ({ externalId: r.externalId, response: r.response })) : first?.response,
    error: out.ok ? undefined : out.error,
    appliedValue: out.ok && plan.mode === 'live' ? first?.appliedValue : undefined,
    plan,
    results: out.results,
    compensation: out.compensation.length ? out.compensation : undefined,
    verifiedLive: out.results.length ? out.results.every((r) => r.verifiedLive === true) : undefined,
    logs: out.logs.length ? out.logs : undefined,
  };
}

function logsOf(phase: ExecPhase, plan: ExecPlan, out: RunOutcome): Finalization['logs'] {
  return [
    ...out.results.map((r) => ({ phase, mode: plan.mode, ok: r.ok, connectionId: r.connectionId, provider: r.provider, externalId: r.externalId, request: r.request, response: r.response, error: r.error, appliedValue: r.appliedValue, opAfter: r.value })),
    ...out.compensation.map((r) => ({ phase: 'compensate' as const, mode: plan.mode, ok: r.ok, connectionId: r.connectionId, provider: r.provider, externalId: r.externalId, request: r.request, response: r.response, error: r.error, appliedValue: r.appliedValue, opAfter: r.value })),
  ];
}

/** 저장된 계획 → 커넥터 연결 (백그라운드 재실행) */
async function bindPlan(env: Env, ws: string, plan: ExecPlan): Promise<Resolution> {
  const bindings = new Map<string, ConnectorBinding>();
  for (const op of plan.ops) {
    if (bindings.has(op.connectionId)) continue;
    const conn: ConnectionRow | null = await getConnection(env.db, ws, op.connectionId);
    if (!conn) return { kind: 'blocked', reason: `커넥션(${op.connectionId})이 삭제되어 실행할 수 없습니다` };
    if (conn.status === 'disabled' || conn.write_mode === 'off') return { kind: 'blocked', reason: `커넥션 '${conn.label}'의 쓰기가 꺼져 실행하지 않았습니다` };
    if (plan.mode === 'live' && conn.write_mode !== 'live') return { kind: 'blocked', reason: `커넥션 '${conn.label}'이(가) 더 이상 live가 아니어서 실행하지 않았습니다` };
    if (plan.mode === 'live' && conn.status === 'pending') return { kind: 'blocked', reason: `커넥션 '${conn.label}'이(가) 연결 확인 전(pending)이라 live로 실행하지 않았습니다` };
    const b = await deps.resolveConnector(env.db, env.config, conn);
    if (!b?.def.apply) return { kind: 'blocked', reason: `커넥션 '${conn.label}'의 커넥터가 반영을 지원하지 않습니다` };
    const unsupported = plan.ops.find((o) => o.connectionId === conn.id && !(b.def.capabilities?.writes ?? []).includes(o.kind));
    if (unsupported) return { kind: 'blocked', reason: `커넥션 '${conn.label}'의 커넥터가 더 이상 '${unsupported.kind}' 반영을 지원하지 않습니다` };
    bindings.set(conn.id, b);
  }
  return { kind: 'plan', plan, bindings, notes: ['백그라운드 재실행'] };
}

/** 3단계: 결과 기록 (시도 id가 그대로일 때만) */
async function finalize(env: Env, ws: string, id: string, attemptId: string, f: Finalization, actor: Actor): Promise<ChangeRow> {
  return env.db.tx(async (q) => {
    const row = await getChange(q, ws, id, true);
    if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
    const at = nowDate();
    for (const l of f.logs) {
      await logExecution(q, ws, {
        changeId: id, attemptId, phase: l.phase, mode: l.mode, ok: l.ok, connectionId: l.connectionId ?? null, provider: l.provider ?? null,
        targetExternalId: l.externalId ?? null, request: l.request, response: l.response, error: l.error ?? null, appliedValue: l.appliedValue ?? null,
        opAfter: l.opAfter ?? null, actor: actor.name, startedAt: f.startedAt, finishedAt: at,
      });
    }
    if (row.exec_pending?.attemptId !== attemptId) {
      // 감시 잡이 이어받은 뒤 늦게 끝난 인라인 실행 — 상태는 바꾸지 않고 이력에만
      const saved = await updateChange(q, ws, id, {
        history: [...row.history, { at: at.toISOString(), by: SYSTEM_BY, action: '늦게 도착한 실행 결과', note: `${f.execution.mode} · ${f.execution.ok ? '성공' : `실패: ${f.execution.error ?? ''}`} (상태는 백그라운드 처리 결과 기준)` }],
      }, at);
      await publish(q, ws, { type: 'change', id });
      return saved;
    }
    const from = row.status;
    const saved = await updateChange(q, ws, id, {
      status: f.status,
      history: [...row.history, ...f.history],
      execution: { ...f.execution, attemptId },
      execPending: null,
      ...(f.appliedAt !== undefined ? { appliedAt: f.appliedAt } : {}),
      ...(f.rolledBackAt !== undefined ? { rolledBackAt: f.rolledBackAt } : {}),
    }, at);
    await storeBulkIncidents(q, ws, f.bulkIncidents);
    await audit(q, {
      workspaceId: ws, userId: actor.userId, actor: actor.name, ip: actor.ip, action: f.auditAction, targetType: 'change', targetId: id,
      detail: {
        from, to: f.status, approver: row.approver, phase: f.execution.phase, mode: f.execution.mode, ok: f.execution.ok,
        connectionId: f.execution.connectionId ?? null, provider: f.execution.provider ?? null, error: f.execution.error ?? null, attemptId,
        request: f.execution.request,
      },
    });
    await publish(q, ws, { type: 'change', id });
    return saved;
  });
}

/* ------------------------------------------------------------------ */
/* 백그라운드 마무리 (잡 'changes.execute' { changeId, attemptId? })        */
/* ------------------------------------------------------------------ */

export async function runExecuteJob(env: Env, ws: string, payload: { changeId?: unknown; attemptId?: unknown }): Promise<{ result: string; status?: ChangeStatus }> {
  const changeId = typeof payload.changeId === 'string' ? payload.changeId : '';
  if (!changeId) return { result: 'invalid_payload' };
  const peek = await getChange(env.db, ws, changeId);
  if (!peek) return { result: 'not_found' };
  if (!peek.exec_pending) return { result: 'not_pending', status: peek.status };
  if (typeof payload.attemptId === 'string' && payload.attemptId !== peek.exec_pending.attemptId) return { result: 'superseded', status: peek.status };

  const next = randomToken(9);
  let alive: ExecPending | null = null;
  const takeover = await env.db.tx(async (q) => {
    const row = await getChange(q, ws, changeId, true);
    if (!row?.exec_pending || row.exec_pending.attemptId !== peek.exec_pending!.attemptId) return null;
    // 실행 중인 쪽이 아직 살아 있으면(heartbeat 최신) 이어받지 않는다 — 느린 매체 응답 중에 같은 계획을 겹쳐 보내지 않게
    if (nowMs() - lastBeatMs(row.exec_pending) < deps.staleAfterMs) { alive = row.exec_pending; return null; }
    const at = nowDate();
    const pending: ExecPending = { ...row.exec_pending, attemptId: next, since: at.toISOString(), heartbeat: at.toISOString(), timedOut: true };
    const saved = await updateChange(q, ws, changeId, {
      execPending: pending,
      history: [...row.history, { at: at.toISOString(), by: BACKGROUND_BY, action: pending.phase === 'rollback' ? '롤백 이어서 처리' : '반영 이어서 처리', note: '인라인 실행 결과가 기록되지 않아 백그라운드에서 다시 처리합니다' }],
    }, at);
    return { row: saved, pending };
  });
  if (alive) {
    const p = alive as ExecPending;
    const beat = lastBeatMs(p);
    await enqueue(env.db, {
      type: 'changes.execute', workspaceId: ws, payload: { changeId, attemptId: p.attemptId },
      runAt: new Date(Math.max(nowMs(), beat) + deps.staleAfterMs + 1000), dedupeKey: `changes.execute:${ws}:${changeId}:${p.attemptId}:recheck:${beat}`,
    });
    return { result: 'still_running', status: peek.status };
  }
  if (!takeover) return { result: 'superseded' };
  const { row, pending } = takeover;
  const actor: Actor = { userId: pending.by.userId, name: BACKGROUND_BY, role: 'system' };
  const stopBeat = startHeartbeat(env.db, ws, changeId, next);
  try {
    return await finishTakeover(env, ws, changeId, row, pending, actor);
  } finally {
    stopBeat();
  }
}

async function finishTakeover(env: Env, ws: string, changeId: string, row: ChangeRow, pending: ExecPending, actor: Actor): Promise<{ result: string; status?: ChangeStatus }> {
  const next = pending.attemptId;
  let f: Finalization | typeof SUPERSEDED;
  if (pending.plan && pending.plan.ops.some((o) => !o.idempotent) && pending.plan.mode === 'live') {
    const at = nowDate();
    const msg = '신규 생성 · 키워드 추가 요청의 인라인 결과를 확인하지 못했습니다 — 중복 생성을 막기 위해 다시 보내지 않습니다. 매체 화면에서 반영 여부를 확인한 뒤 재실행 또는 실행 취소하세요';
    const rollback = pending.phase === 'rollback';
    f = {
      status: rollback ? 'applied' : 'held', startedAt: at, bulkIncidents: [], auditAction: rollback ? 'change.rollback_failed' : 'change.apply_held',
      history: [{ at: at.toISOString(), by: BACKGROUND_BY, action: '반영 결과 확인 필요', note: msg }],
      execution: { phase: pending.phase, mode: pending.plan.mode, ok: false, at: at.toISOString(), error: msg, plan: pending.plan },
      logs: [{ phase: pending.phase, mode: pending.plan.mode, ok: false, error: msg }],
    };
  } else {
    try {
      f = await computeExecution(env, ws, row, pending, BACKGROUND_BY, {}, pending.plan);
    } catch (e) {
      f = failureOf(row, pending, e);
    }
  }
  if (f === SUPERSEDED) return { result: 'superseded' };
  const saved = await finalize(env, ws, changeId, next, f, actor);
  return { result: 'finalized', status: saved.status };
}

/** 정체된 실행 표시 회수: heartbeat가 멈춘 지 오래됐는데 감시 잡이 없어진 경우(잡 최종 실패 등) 다시 예약 */
export async function sweepStale(env: Env, olderThanMin = 10): Promise<number> {
  const r = await env.db.query<{ workspace_id: string; id: string; exec_pending: ExecPending }>(
    `SELECT workspace_id, id, exec_pending FROM change_requests
      WHERE exec_pending IS NOT NULL
        AND coalesce(exec_pending->>'heartbeat', exec_pending->>'since')::timestamptz < now() - ($1 || ' minutes')::interval LIMIT 200`,
    [String(olderThanMin)],
  );
  let n = 0;
  for (const x of r.rows) {
    const jid = await enqueue(env.db, {
      type: 'changes.execute', workspaceId: x.workspace_id, payload: { changeId: x.id, attemptId: x.exec_pending.attemptId },
      dedupeKey: `changes.execute:${x.workspace_id}:${x.id}:${x.exec_pending.attemptId}`,
    });
    if (jid) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 반영 전 점검 미리보기 (상태 변경 없음)                                    */
/* ------------------------------------------------------------------ */

export async function preflight(env: Env, ws: string, id: string): Promise<{ check: Omit<GuardResult, 'bulkIncidents'>; target: Record<string, unknown> }> {
  const row = await getChange(env.db, ws, id);
  if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
  const c = toEngineChange(row);
  const g = await runGuards(env, ws, c);
  const res = row.status === 'applied'
    ? await resolveRollbackPlan({ db: env.db, config: env.config, resolver: deps.resolveConnector }, ws, c, applyExecutionOf(row.execution))
    : await resolvePlan({ db: env.db, config: env.config, resolver: deps.resolveConnector }, ws, c, g.limits);
  const target = res.kind === 'plan'
    ? { kind: 'plan', mode: res.plan.mode, ops: res.plan.ops.map((o) => ({ externalId: o.externalId, target: o.target, kind: o.kind, before: o.before, after: o.after, role: o.role, provider: o.provider, connectionId: o.connectionId })), notes: res.notes, for: row.status === 'applied' ? 'rollback' : 'apply' }
    : { kind: res.kind, reason: res.reason, for: row.status === 'applied' ? 'rollback' : 'apply' };
  const { bulkIncidents: _b, limits: _l, ...check } = g;
  return { check, target };
}

export { ACTION_LABEL, LEVEL_RANK };
