/**
 * 성과 증명 측정 (impact.measure 잡 · POST /impact/measure) — 웨어하우스 · 변경 요청 · 이슈 · 실행 기록 → impact_ledger.
 * 계산은 순수 엔진(src/modules/impact/engine.ts)이 하고, 여기서는 입력을 모으고 장부에 쓴다.
 *
 *  변경 (change):   매체에 실제(live) 반영된 입찰 · 예산 변경 — 반영 당일 제외 전 7일 vs 후 7일. 후 7일이 어제까지 다 쌓여야 측정한다.
 *                   반영 전후 구분 = change_requests.applied_at(서버가 반영을 끝낸 시각) · rolled_back_at (변경 이력 문구는 쓰지 않는다).
 *                   반영 방식은 change_executions(시도별 기록 — 마지막 반영 시도)로 판정하고, 기록이 없으면 change_requests.execution을 본다:
 *                   dry_run · 기록만(none)은 매체가 바뀌지 않았으므로 '집계 제외 · 매체 미반영'으로 장부에 남긴다.
 *                   입찰: wh_keyword_daily, 대조군 = 같은 광고그룹(3개 이상 데이터가 있으면) 또는 같은 의도 · 브랜드 구분의 미변경 키워드.
 *                   예산: 캠페인 일별 표가 없어 wh_media_daily(해당 매체), 대조군 = 같은 기간 예산 변경이 없는 다른 매체 합계 (신뢰도 낮음) ·
 *                         재배분(budget:<받는>:<주는>)이면 주는 캠페인의 매체도 대조군에서 뺀다.
 *                   측정에 쓴 값이 TEST DATA(데모 출처)뿐이면 '집계 제외 · TEST DATA 반영'으로 남긴다 (실연동 성과와 섞지 않는다).
 *                   측정 · 표본 부족 · 제외는 확정 상태 — 다시 계산하지 않는다(force 제외). 관측 중(pending)은 매일 다시 본다.
 *  사고 (incident): 서버 24시간 감지(source 'scan')가 만든 해결된 이슈 중 추정 매출 손실이 있는 것 — 테스트 · 오탐 · 화면에서 사람이 등록한 이슈는
 *                   제외 행으로 남긴다. 다시 열린 이슈는 관측 중으로 되돌린다. 영업일(자연 발견 시각)은 워크스페이스 공휴일 설정을 따른다.
 *  자동화 (automation): 이번 달 · 지난달의 자동 실행 기록 건수 (데모 커넥션 · TEST DATA 실행은 세지 않는다).
 */
import type { Db, Queryable } from '../db/pool';
import { one } from '../db/pool';
import { kstHour, kstToday, nowMs, addDaysStr } from '../lib/time';
import { withWorkspaceConfig, type WorkspaceConfig } from '@/data/config';
import { loadWorkspaceConfig } from '../settings/service';
import {
  addDaysUtc, AUTOMATION_UNITS, automationSavings, businessDaysIn, datesBetween, estimateLossAvoided, estimateUplift, impactConfig, isBusinessDate,
  kstDateOf, kstMonthOf, kstMsOf, nextMonth, prevMonth, sumWindow, IMPACT_WINDOW_DAYS,
  type AutomationCounts, type ControlSnapshot, type DayMetrics, type ExclusionCode, type LedgerEntry, type LedgerStatus, type SourceType,
} from '@/modules/impact/engine';

/* ============================== 설정 ============================== */

/**
 * 회수 배수 입력 — workspaces.config 원본에서 읽는다: billing.monthlyFee(settings 스키마) · impact.contributionMargin · impact.hourlyCost.
 * settings의 loadWorkspaceConfig는 스키마 밖 키(impact.*)를 걸러 내므로 원본을 직접 읽고 엔진(impactConfig)이 범위를 검증한다.
 */
export async function loadImpactConfig(q: Queryable, wsId: string) {
  const r = await one<{ config: unknown }>(q, 'SELECT config FROM workspaces WHERE id = $1', [wsId]);
  return impactConfig(r?.config ?? null);
}

/* ============================== 장부 행 ============================== */

export interface LedgerRow {
  id: string;
  source_type: SourceType;
  source_id: string;
  label: string;
  occurred_at: Date | string;
  window_days: number;
  status: LedgerStatus;
  baseline: LedgerEntry['baseline'];
  observed: LedgerEntry['observed'];
  control: LedgerEntry['control'];
  estimate: LedgerEntry['estimate'];
  measured_at: Date | string | null;
  month: string | null;
  detail: LedgerEntry['detail'] | null;
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

export function toEntry(r: LedgerRow): LedgerEntry {
  const occ = new Date(r.occurred_at).getTime();
  return {
    id: r.id, sourceType: r.source_type, sourceId: r.source_id, label: r.label, occurredAt: new Date(occ).toISOString(), month: r.month ?? kstMonthOf(occ),
    windowDays: r.window_days, status: r.status, baseline: r.baseline ?? null, observed: r.observed ?? null, control: r.control ?? null, estimate: r.estimate ?? null,
    detail: r.detail ?? {}, measuredAt: iso(r.measured_at),
  };
}

type EntryInput = Omit<LedgerEntry, 'id' | 'measuredAt'>;

async function upsertEntry(q: Queryable, wsId: string, e: EntryInput): Promise<void> {
  await q.query(
    `INSERT INTO impact_ledger (workspace_id, source_type, source_id, label, occurred_at, window_days, status, baseline, observed, control, estimate, measured_at, month, detail, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $7 = 'pending' THEN NULL ELSE $12::timestamptz END, $13, $14, $12::timestamptz)
     ON CONFLICT (workspace_id, source_type, source_id) DO UPDATE SET
       label = EXCLUDED.label, occurred_at = EXCLUDED.occurred_at, window_days = EXCLUDED.window_days, status = EXCLUDED.status,
       baseline = EXCLUDED.baseline, observed = EXCLUDED.observed, control = EXCLUDED.control, estimate = EXCLUDED.estimate,
       measured_at = EXCLUDED.measured_at, month = EXCLUDED.month, detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`,
    [
      wsId, e.sourceType, e.sourceId, e.label.slice(0, 300), e.occurredAt, e.windowDays, e.status,
      e.baseline ? JSON.stringify(e.baseline) : null, e.observed ? JSON.stringify(e.observed) : null, e.control ? JSON.stringify(e.control) : null,
      e.estimate ? JSON.stringify(e.estimate) : null, new Date(nowMs()).toISOString(), e.month, JSON.stringify(e.detail ?? {}),
    ],
  );
}

/* ============================== 출처 선택 (Dataset 빌더와 같은 규칙) ============================== */

type SourceKind = 'api' | 'csv' | 'demo';
interface SourceInfo { kind: SourceKind; priority: number; createdMs: number }

/** 출처 키(커넥션 id · 'csv:<업로드 id>' · 'demo') → 종류 · 우선순위 (server/src/warehouse/dataset.ts와 같은 기본값: api 100 > csv 50 > demo 10) */
async function loadSources(q: Queryable, wsId: string): Promise<Map<string, SourceInfo>> {
  const m = new Map<string, SourceInfo>();
  const conns = (await q.query<{ id: string; provider: string; priority: number; created_at: Date }>('SELECT id, provider, priority, created_at FROM connections WHERE workspace_id = $1', [wsId])).rows;
  const prio = new Map<string, number>();
  for (const c of conns) {
    prio.set(c.id, c.priority);
    if (c.provider === 'demo') m.set('demo', { kind: 'demo', priority: c.priority, createdMs: new Date(c.created_at).getTime() });
    else m.set(c.id, { kind: c.provider === 'csv' ? 'csv' : 'api', priority: c.priority, createdMs: new Date(c.created_at).getTime() });
  }
  if (!m.has('demo')) m.set('demo', { kind: 'demo', priority: 10, createdMs: 0 });
  const ups = (await q.query<{ id: string; connection_id: string | null; created_at: Date }>(`SELECT id, connection_id, created_at FROM uploads WHERE workspace_id = $1 AND status = 'imported'`, [wsId])).rows;
  for (const u of ups) m.set(`csv:${u.id}`, { kind: 'csv', priority: u.connection_id ? prio.get(u.connection_id) ?? 50 : 50, createdMs: new Date(u.created_at).getTime() });
  return m;
}

/** 키마다 우선순위가 가장 높은 출처 하나 — 실데이터 출처가 하나라도 있으면 데모 행은 뺀다 (테스트 데이터와 실데이터를 섞지 않는다) */
function pickRows<R extends { source: string }>(rows: R[], sources: Map<string, SourceInfo>, key: (r: R) => string): { rows: R[]; kinds: Set<SourceKind> } {
  const hasReal = rows.some((r) => { const s = sources.get(r.source); return s && s.kind !== 'demo'; });
  const best = new Map<string, { r: R; s: SourceInfo }>();
  for (const r of rows) {
    const s = sources.get(r.source);
    if (!s || (hasReal && s.kind === 'demo')) continue;
    const k = key(r);
    const cur = best.get(k);
    if (!cur || s.priority > cur.s.priority || (s.priority === cur.s.priority && s.createdMs > cur.s.createdMs)) best.set(k, { r, s });
  }
  const kinds = new Set<SourceKind>([...best.values()].map((x) => x.s.kind));
  return { rows: [...best.values()].map((x) => x.r), kinds };
}

interface MetricRow { date: string; source: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
const toDay = (r: MetricRow): DayMetrics => ({ date: r.date, impressions: Number(r.impressions), clicks: Number(r.clicks), cost: Number(r.cost), conversions: Number(r.conversions), revenue: Number(r.revenue) });
function addInto(rec: Record<string, DayMetrics>, d: DayMetrics): void {
  const c = rec[d.date] ?? { date: d.date, impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  c.impressions = (c.impressions ?? 0) + (d.impressions ?? 0);
  c.clicks += d.clicks; c.cost += d.cost; c.conversions += d.conversions; c.revenue += d.revenue;
  rec[d.date] = c;
}

/* ============================== 변경 ============================== */

interface ExecJson { mode?: string; ok?: boolean; provider?: string; phase?: string; applyExecution?: ExecJson | null }
interface ChangeRowLite {
  id: string; kind: string; module: string; target: string; target_id: string | null; before: unknown; after: unknown; status: string;
  applied_at: Date; rolled_back_at: Date | null; execution: ExecJson | null;
}
/** change_executions 한 줄 (반영 · 재시도 · 보상 단계만) */
export interface ExecAttemptRow { change_id: string; attempt_id: string; phase: string; mode: 'none' | 'dry_run' | 'live'; ok: boolean; provider: string | null }

/** 반영 방식 판정 결과 */
export type ApplyClass =
  | { kind: 'live'; provider: string | null; basis: 'executions' | 'execution' }
  | { kind: 'dry_run'; basis: 'executions' | 'execution' }
  | { kind: 'none'; basis: 'executions' | 'execution' }
  | { kind: 'failed'; basis: 'executions' | 'execution' }
  | { kind: 'unknown' };

/**
 * 반영 방식 — 마지막 반영 시도(change_executions의 apply · retry 단계, attempt 단위)가 기준.
 * 한 시도의 작업이 모두 성공한 live면 live, 보상(되돌림) 기록이 있거나 실패한 작업이 있으면 failed, 아니면 그 시도의 mode(dry_run · none).
 * 시도 기록이 없으면(이전 버전 · 외부 입력) change_requests.execution을 본다 — 롤백 실행 기록이면 그 안의 직전 반영 기록(applyExecution).
 */
export function classifyApply(execution: ExecJson | null, attempts: readonly ExecAttemptRow[]): ApplyClass {
  const applies = attempts.filter((a) => a.phase === 'apply' || a.phase === 'retry');
  if (applies.length) {
    const last = applies[applies.length - 1].attempt_id;
    const rows = attempts.filter((a) => a.attempt_id === last);
    const ops = rows.filter((a) => a.phase === 'apply' || a.phase === 'retry');
    if (rows.some((a) => a.phase === 'compensate') || ops.some((a) => !a.ok)) return { kind: 'failed', basis: 'executions' };
    if (ops.every((a) => a.mode === 'live')) return { kind: 'live', provider: ops.find((a) => a.provider)?.provider ?? null, basis: 'executions' };
    return ops.some((a) => a.mode === 'dry_run') ? { kind: 'dry_run', basis: 'executions' } : { kind: 'none', basis: 'executions' };
  }
  const ex = execution?.phase === 'rollback' ? execution.applyExecution ?? null : execution;
  if (!ex || !ex.mode) return { kind: 'unknown' };
  if (ex.ok === false) return { kind: 'failed', basis: 'execution' };
  if (ex.mode === 'live') return { kind: 'live', provider: ex.provider ?? null, basis: 'execution' };
  return ex.mode === 'dry_run' ? { kind: 'dry_run', basis: 'execution' } : { kind: 'none', basis: 'execution' };
}

const NOT_APPLIED_REASON = {
  dry_run: '매체 미반영 — dry_run(호출 내용만 기록하고 매체에 보내지 않음) · 매체 값이 바뀌지 않아 증분 추정 대상이 아님',
  none: '매체 미반영 — 기록만 변경 (반영할 커넥션 없음 · 매체 쓰기 미지원) · 서버가 매체를 바꾸지 않아 증분 추정 대상이 아님',
  unknown: '매체 미반영 — 반영 실행 기록 없음 (화면 기록 · 수동 반영) · 언제 매체에 적용됐는지 확인할 수 없음',
} as const;

const KIND_LABEL: Record<string, string> = { bid: '입찰가', budget: '일 예산' };
const fmtVal = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('ko-KR') : String(v ?? '—'));

/** 예산 변경 targetId → 캠페인 id (server/src/changes/targets.ts 규칙: budget:<받는>:<주는> · gfa:budget:<id> · flow:budget:<id>) */
export function budgetCampaignOf(targetId: string | null): string | null {
  const t = (targetId ?? '').trim();
  if (!t) return null;
  let m = t.match(/^budget:([^:]+)(?::.*)?$/);
  if (m) return m[1];
  m = t.match(/^(?:gfa|flow):budget:(.+)$/);
  if (m) return m[1];
  return /^[A-Za-z0-9_.-]+$/.test(t) ? t : null;
}
/** 예산 재배분의 주는 캠페인 ('budget:<받는>:<주는>' — 주는 쪽이 비어 있으면 없음) */
export function budgetDonorOf(targetId: string | null): string | null {
  const m = (targetId ?? '').trim().match(/^budget:[^:]+:([^:]+)$/);
  return m ? m[1] : null;
}

export interface MeasureResult {
  changes: Record<LedgerStatus, number> & { skipped: number };
  incidents: Record<LedgerStatus, number>;
  automation: { months: string[]; rows: number; hours: number };
  at: string;
}
const zero = () => ({ pending: 0, measured: 0, insufficient: 0, excluded: 0 });

interface Ctx {
  q: Queryable;
  wsId: string;
  /** 측정에 쓸 수 있는 마지막 확정 날짜 */
  lastFinal: string;
  margin: number;
  sources: Map<string, SourceInfo>;
  keywordDocs: Map<string, { intent: string; adgroup: string; isBrand: boolean; status: string; text: string }>;
  campaignDocs: Map<string, { media: string; name: string }>;
  /** 반영된 변경 전체 (대조군 오염 판단) — 반영 방식 판정 포함 */
  applied: { id: string; kind: string; targetId: string | null; appliedMs: number; cls: ApplyClass }[];
  attempts: Map<string, ExecAttemptRow[]>;
}

const TEST_SOURCE_REASON = 'TEST DATA(데모 출처) 값으로만 계산됨 — 이 대상의 실연동 데이터가 없어 성과 집계 제외 (추정값은 참고용으로만 남김)';

/** 대조군에서 뺄 변경: 매체가 바뀌었을 수 있는 것 (live · 기록만(수동 반영 가능) · 기록 없음). dry_run · 실패는 매체가 그대로라 뺄 필요 없다 */
const touchesMedia = (cls: ApplyClass) => cls.kind === 'live' || cls.kind === 'none' || cls.kind === 'unknown';
function changedTargets(ctx: Ctx, kinds: readonly string[], fromMs: number, toMs: number, exceptId: string): (string | null)[] {
  return ctx.applied.filter((a) => a.id !== exceptId && kinds.includes(a.kind) && a.appliedMs >= fromMs && a.appliedMs < toMs && touchesMedia(a.cls)).map((a) => a.targetId);
}

async function measureChange(ctx: Ctx, c: ChangeRowLite): Promise<EntryInput> {
  const appliedMs = new Date(c.applied_at).getTime();
  const D = kstDateOf(appliedMs);
  const beforeDates = datesBetween(addDaysUtc(D, -IMPACT_WINDOW_DAYS), addDaysUtc(D, -1));
  const afterDates = datesBetween(addDaysUtc(D, 1), addDaysUtc(D, IMPACT_WINDOW_DAYS));
  const base: EntryInput = {
    sourceType: 'change', sourceId: c.id, label: `${c.target} ${KIND_LABEL[c.kind] ?? c.kind} ${fmtVal(c.before)} → ${fmtVal(c.after)}`,
    occurredAt: new Date(appliedMs).toISOString(), month: kstMonthOf(appliedMs), windowDays: IMPACT_WINDOW_DAYS, status: 'pending',
    baseline: null, observed: null, control: null, estimate: null,
    detail: {
      kind: c.kind, target: c.target, targetId: c.target_id ?? undefined, before: c.before as string | number, after: c.after as string | number, route: 'flow',
      appliedAt: new Date(appliedMs).toISOString(), rolledBackAt: c.rolled_back_at ? new Date(c.rolled_back_at).toISOString() : undefined,
    },
  };
  const cls = classifyApply(c.execution, ctx.attempts.get(c.id) ?? []);
  base.detail.mode = cls.kind;
  const exclude = (reason: string, exclusion: ExclusionCode): EntryInput => ({ ...base, status: 'excluded', detail: { ...base.detail, reason, exclusion } });
  if (cls.kind === 'dry_run' || cls.kind === 'none' || cls.kind === 'unknown') return exclude(NOT_APPLIED_REASON[cls.kind], 'not_applied');
  if (cls.kind === 'failed') return exclude('매체 반영 실패 (마지막 반영 시도 실패 · 되돌림) — 매체 값이 바뀌었는지 확정할 수 없어 집계 제외', 'apply_failed');
  if (cls.provider === 'demo') return exclude('데모 커넥션 반영 (TEST DATA 시뮬레이션) — 성과 집계 제외', 'demo');
  if (c.rolled_back_at && kstDateOf(new Date(c.rolled_back_at).getTime()) <= afterDates[afterDates.length - 1]) return exclude(`관측 기간(반영 후 ${IMPACT_WINDOW_DAYS}일) 중 롤백 (${kstDateOf(new Date(c.rolled_back_at).getTime())})`, 'rolled_back');
  const lastAfter = afterDates[afterDates.length - 1];
  if (lastAfter > ctx.lastFinal) return { ...base, detail: { ...base.detail, reason: `반영 후 ${IMPACT_WINDOW_DAYS}일(~${lastAfter}) 데이터가 쌓이면 측정 (매일 06:00)` } };

  const winFrom = beforeDates[0], winTo = lastAfter;
  const fromMs = kstMsOf(addDaysUtc(D, -IMPACT_WINDOW_DAYS));
  const toMs = kstMsOf(addDaysUtc(D, IMPACT_WINDOW_DAYS + 1));

  if (c.kind === 'bid') {
    const kw = (c.target_id ?? '').trim();
    if (!kw) return exclude('대상 키워드 id가 없어 웨어하우스와 연결할 수 없음', 'unlinked');
    const doc = ctx.keywordDocs.get(kw);
    const changed = new Set(changedTargets(ctx, ['bid', 'status', 'keyword_exclude'], fromMs, toMs, c.id).filter((x): x is string => !!x));
    const peerOk = (id: string, d: { status: string }) => id !== kw && !changed.has(id) && d.status !== 'off';
    const adgroupPeers = doc?.adgroup ? [...ctx.keywordDocs].filter(([id, d]) => peerOk(id, d) && d.adgroup === doc.adgroup).map(([id]) => id) : [];
    const intentPeers = doc ? [...ctx.keywordDocs].filter(([id, d]) => peerOk(id, d) && d.intent === doc.intent && d.isBrand === doc.isBrand).map(([id]) => id) : [];
    const ids = [...new Set([kw, ...adgroupPeers, ...intentPeers])];
    const raw = (await ctx.q.query<MetricRow & { keyword_id: string }>(
      `SELECT keyword_id, date, source, impressions, clicks, cost, conversions, revenue FROM wh_keyword_daily WHERE workspace_id = $1 AND keyword_id = ANY($2::text[]) AND date BETWEEN $3 AND $4`,
      [ctx.wsId, ids, winFrom, winTo],
    )).rows;
    const picked = pickRows(raw, ctx.sources, (r) => `${r.keyword_id}|${r.date}`);
    const byKw = new Map<string, Record<string, DayMetrics>>();
    for (const r of picked.rows) {
      const rec = byKw.get(r.keyword_id) ?? {};
      rec[r.date] = toDay(r);
      byKw.set(r.keyword_id, rec);
    }
    const withData = (list: string[]) => list.filter((id) => beforeDates.some((d) => (byKw.get(id)?.[d]?.clicks ?? 0) > 0));
    const ag = withData(adgroupPeers);
    const it = withData(intentPeers);
    const basis: ControlSnapshot['basis'] = ag.length >= 3 ? 'adgroup' : it.length >= 1 ? 'intent' : 'none';
    const peers = basis === 'adgroup' ? ag : basis === 'intent' ? it : [];
    const control: Record<string, DayMetrics> = {};
    for (const id of peers) for (const d of Object.values(byKw.get(id) ?? {})) addInto(control, d);
    const treated = byKw.get(kw) ?? {};
    const est = estimateUplift({ beforeDates, afterDates, treated, control: peers.length ? control : null, controlUnits: peers.length, margin: ctx.margin, seed: `${ctx.wsId}:${c.id}`, granularity: 'keyword' });
    const snap: ControlSnapshot = {
      basis, units: peers.length, ids: peers.slice(0, 50),
      label: basis === 'adgroup' ? `같은 광고그룹 '${doc?.adgroup}' 미변경 키워드` : basis === 'intent' ? `같은 의도(${doc?.intent}) 미변경 키워드` : '대조군 없음 (같은 광고그룹 · 의도의 미변경 키워드 데이터 없음)',
      before: peers.length ? sumWindow(control, beforeDates) : null, after: peers.length ? sumWindow(control, afterDates) : null,
    };
    const reasons = [...est.sufficiency.reasons, ...(doc ? [] : ['키워드 엔티티(의도 · 광고그룹)가 없어 대조군을 구성하지 못함'])];
    const fromTest = picked.kinds.has('demo');
    return {
      ...base, status: fromTest ? 'excluded' : est.sufficiency.ok ? 'measured' : 'insufficient',
      baseline: sumWindow(treated, beforeDates), observed: sumWindow(treated, afterDates), control: snap, estimate: est,
      detail: { ...base.detail, reasons: reasons.length ? reasons : undefined, test: fromTest || undefined, ...(fromTest ? { reason: TEST_SOURCE_REASON, exclusion: 'demo' as const } : {}) },
    };
  }

  // 예산 — 매체 단위
  const cid = budgetCampaignOf(c.target_id);
  const camp = cid ? ctx.campaignDocs.get(cid) : undefined;
  if (!camp?.media) return exclude('대상 캠페인을 웨어하우스에서 찾을 수 없어 매체를 정할 수 없음', 'unlinked');
  // 대조군에서 뺄 매체: 같은 창에 예산이 바뀐 다른 변경의 받는 · 주는 캠페인 매체 + 이 변경이 재배분이면 주는 캠페인 매체 (예산이 줄어 대조군을 끌어내린다)
  const mediaOf = (id: string | null) => (id ? ctx.campaignDocs.get(id)?.media || null : null);
  const changedMedia = new Set(changedTargets(ctx, ['budget'], fromMs, toMs, c.id).flatMap((t) => [mediaOf(budgetCampaignOf(t)), mediaOf(budgetDonorOf(t))]).filter((m): m is string => !!m));
  const donorMedia = mediaOf(budgetDonorOf(c.target_id));
  if (donorMedia && donorMedia !== camp.media) changedMedia.add(donorMedia);
  const raw = (await ctx.q.query<MetricRow & { media: string }>(
    `SELECT media, date, source, impressions, clicks, cost, conversions, revenue FROM wh_media_daily WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
    [ctx.wsId, winFrom, winTo],
  )).rows;
  const picked = pickRows(raw, ctx.sources, (r) => `${r.media}|${r.date}`);
  const treated: Record<string, DayMetrics> = {};
  const control: Record<string, DayMetrics> = {};
  const controlMedia = new Set<string>();
  for (const r of picked.rows) {
    if (r.media === camp.media) addInto(treated, toDay(r));
    else if (!changedMedia.has(r.media)) { addInto(control, toDay(r)); controlMedia.add(r.media); }
  }
  const est = estimateUplift({ beforeDates, afterDates, treated, control: controlMedia.size ? control : null, controlUnits: controlMedia.size, margin: ctx.margin, seed: `${ctx.wsId}:${c.id}`, granularity: 'media' });
  const fromTest = picked.kinds.has('demo');
  const reasons = [...(est.sufficiency.ok ? [] : est.sufficiency.reasons), ...(donorMedia && donorMedia !== camp.media ? [`재배분으로 예산이 준 매체(${donorMedia})는 대조군에서 뺌`] : [])];
  return {
    ...base, status: fromTest ? 'excluded' : est.sufficiency.ok ? 'measured' : 'insufficient',
    label: `${c.target} (${camp.media}) ${KIND_LABEL.budget} ${fmtVal(c.before)} → ${fmtVal(c.after)}`,
    baseline: sumWindow(treated, beforeDates), observed: sumWindow(treated, afterDates),
    control: { basis: controlMedia.size ? 'media' : 'none', label: controlMedia.size ? '같은 기간 예산 변경이 없는 다른 매체 합계' : '대조군 없음', units: controlMedia.size, ids: [...controlMedia], before: controlMedia.size ? sumWindow(control, beforeDates) : null, after: controlMedia.size ? sumWindow(control, afterDates) : null },
    estimate: est,
    detail: { ...base.detail, reasons: reasons.length ? reasons : undefined, test: fromTest || undefined, ...(fromTest ? { reason: TEST_SOURCE_REASON, exclusion: 'demo' as const } : {}) },
  };
}

/* ============================== 자동화 건수 ============================== */

async function tableExists(q: Queryable, name: string): Promise<boolean> {
  const r = await one<{ ok: boolean }>(q, 'SELECT to_regclass($1) IS NOT NULL AS ok', [name]);
  return !!r?.ok;
}

/** 월(KST)의 자동 실행 건수 — 데모 커넥션 · TEST DATA 실행은 세지 않는다 */
export async function automationCounts(q: Queryable, wsId: string, month: string, upTo: string, wcfg: WorkspaceConfig | null = null): Promise<AutomationCounts> {
  const from = new Date(kstMsOf(`${month}-01`)).toISOString();
  const to = new Date(kstMsOf(`${nextMonth(month)}-01`)).toISOString();
  // 영업일 = 공휴일(KR_HOLIDAYS + 워크스페이스 추가 · 제외 공휴일) · 주말 제외 — 리포트 발송 일정과 같은 달력
  const bizDates = (rows: { d: string }[]) => withWorkspaceConfig(wcfg, () => new Set(rows.map((r) => String(r.d)).filter((d) => d <= upTo && isBusinessDate(d))).size);
  const kd = `to_char(%s AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
  const ingest = (await q.query<{ d: string }>(
    `SELECT DISTINCT ${kd.replace('%s', 'r.started_at')} AS d FROM ingest_runs r LEFT JOIN connections c ON c.id = r.connection_id
      WHERE r.workspace_id = $1 AND r.job IN ('daily', 'intraday') AND r.status IN ('succeeded', 'partial') AND r.started_at >= $2 AND r.started_at < $3
        AND COALESCE(c.provider, '') <> 'demo'`,
    [wsId, from, to],
  )).rows;
  const ingestRuns = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM ingest_runs r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.workspace_id = $1 AND r.started_at >= $2 AND r.started_at < $3 AND r.status IN ('succeeded', 'partial') AND COALESCE(c.provider, '') <> 'demo'`, [wsId, from, to]);
  const daily = (await q.query<{ d: string }>(
    `SELECT DISTINCT ${kd.replace('%s', 'generated_at')} AS d FROM reports WHERE workspace_id = $1 AND type = 'daily' AND trigger = 'schedule' AND COALESCE(data_mode, 'demo') <> 'demo' AND generated_at >= $2 AND generated_at < $3`,
    [wsId, from, to],
  )).rows;
  const weekly = await one<{ n: number }>(q, `SELECT count(DISTINCT period_start)::int AS n FROM reports WHERE workspace_id = $1 AND type = 'weekly' AND trigger = 'schedule' AND COALESCE(data_mode, 'demo') <> 'demo' AND generated_at >= $2 AND generated_at < $3`, [wsId, from, to]);
  const reportsGenerated = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM reports WHERE workspace_id = $1 AND trigger <> 'manual' AND COALESCE(data_mode, 'demo') <> 'demo' AND generated_at >= $2 AND generated_at < $3`, [wsId, from, to]);
  // live 반영 성공 = 시도 기록(change_executions)에 성공한 live 반영이 있거나, 시도 기록이 없으면 execution(롤백이면 직전 반영 기록)이 live 성공 · 데모 커넥션 제외
  const liveChanges = (kinds: string[]) => one<{ n: number }>(q,
    `SELECT count(*)::int AS n FROM change_requests c
      WHERE c.workspace_id = $1 AND c.applied_at >= $2 AND c.applied_at < $3 AND c.kind = ANY($4::text[])
        AND (
          EXISTS (SELECT 1 FROM change_executions e WHERE e.workspace_id = c.workspace_id AND e.change_id = c.id AND e.phase IN ('apply', 'retry') AND e.mode = 'live' AND e.ok AND COALESCE(e.provider, '') <> 'demo')
          OR (NOT EXISTS (SELECT 1 FROM change_executions e WHERE e.workspace_id = c.workspace_id AND e.change_id = c.id AND e.phase IN ('apply', 'retry'))
              AND (CASE WHEN c.execution->>'phase' = 'rollback' THEN c.execution->'applyExecution' ELSE c.execution END) @> '{"mode":"live","ok":true}'::jsonb
              AND COALESCE((CASE WHEN c.execution->>'phase' = 'rollback' THEN c.execution->'applyExecution' ELSE c.execution END)->>'provider', '') <> 'demo')
        )`,
    [wsId, from, to, kinds]);
  const bid = await liveChanges(['bid', 'budget', 'status']);
  const kw = await liveChanges(['keyword_add', 'keyword_exclude']);
  const all = await liveChanges(['bid', 'budget', 'status', 'keyword_add', 'keyword_exclude', 'gfa']);
  let detectionDays = 0;
  let scanRuns = 0;
  if (await tableExists(q, 'alert_scan_runs')) {
    const runs = (await q.query<{ d: string }>(
      `SELECT DISTINCT ${kd.replace('%s', 'started_at')} AS d FROM alert_scan_runs WHERE workspace_id = $1 AND trigger IN ('schedule', 'ingest') AND status <> 'failed'
         AND COALESCE(data_mode, 'demo') <> 'demo' AND started_at >= $2 AND started_at < $3`,
      [wsId, from, to],
    )).rows;
    detectionDays = bizDates(runs);
    scanRuns = (await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM alert_scan_runs WHERE workspace_id = $1 AND trigger IN ('schedule', 'ingest') AND status <> 'failed' AND COALESCE(data_mode, 'demo') <> 'demo' AND started_at >= $2 AND started_at < $3`, [wsId, from, to]))?.n ?? 0;
  }
  const autoInc = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM incidents WHERE workspace_id = $1 AND doc->>'source' = 'scan' AND COALESCE((doc->>'isTest')::boolean, false) = false AND detected_at >= $2 AND detected_at < $3`, [wsId, from, to]);
  return {
    ingest_days: bizDates(ingest),
    daily_reports: bizDates(daily),
    weekly_reports: weekly?.n ?? 0,
    bid_budget_changes: bid?.n ?? 0,
    keyword_changes: kw?.n ?? 0,
    detection_days: detectionDays,
    evidence: { ingestRuns: ingestRuns?.n ?? 0, reportsGenerated: reportsGenerated?.n ?? 0, incidentsAutoDetected: autoInc?.n ?? 0, changesExecuted: all?.n ?? 0, scanRuns },
  };
}

const EVIDENCE_TEXT: Record<string, (e: NonNullable<AutomationCounts['evidence']>) => string> = {
  ingest_days: (e) => `자동 수집 실행 ${e.ingestRuns ?? 0}회 (데모 커넥션 제외)`,
  daily_reports: (e) => `예약 생성 리포트 ${e.reportsGenerated ?? 0}건 (TEST DATA 리포트 제외)`,
  weekly_reports: (e) => `예약 생성 리포트 ${e.reportsGenerated ?? 0}건`,
  bid_budget_changes: (e) => `live 반영 성공 변경 ${e.changesExecuted ?? 0}건`,
  keyword_changes: (e) => `live 반영 성공 변경 ${e.changesExecuted ?? 0}건`,
  detection_days: (e) => `예약 · 수집 직후 감지 실행 ${e.scanRuns ?? 0}회 · 자동 감지 이슈 ${e.incidentsAutoDetected ?? 0}건`,
};

/* ============================== 측정 실행 ============================== */

export async function measureWorkspace(db: Db, wsId: string, opts: { force?: boolean } = {}): Promise<MeasureResult> {
  const q: Queryable = db;
  const today = kstToday();
  // 확정된 날짜만 쓴다: 전일 확정 수집(07:00) 전이면 그저께까지 (06:00 예약 측정은 그저께까지의 창만 측정)
  const lastFinal = addDaysStr(today, kstHour() >= 8 ? -1 : -2);
  const cfg = await loadImpactConfig(q, wsId);
  // 영업일 계산(자연 발견 시각 · 자동화 영업일 · 월 상한)은 워크스페이스 공휴일 설정을 따른다 (동기 계산만 withWorkspaceConfig 안에서)
  const wcfg = await loadWorkspaceConfig(q, wsId).catch(() => null);
  const sources = await loadSources(q, wsId);
  const ents = (await q.query<{ entity_type: string; external_id: string; doc: Record<string, unknown> }>(
    `SELECT entity_type, external_id, doc FROM wh_entities WHERE workspace_id = $1 AND entity_type IN ('keyword', 'campaign')`, [wsId],
  )).rows;
  const keywordDocs: Ctx['keywordDocs'] = new Map();
  const campaignDocs: Ctx['campaignDocs'] = new Map();
  for (const e of ents) {
    if (e.entity_type === 'keyword') keywordDocs.set(e.external_id, { intent: String(e.doc.intent ?? 'generic'), adgroup: String(e.doc.adgroup ?? ''), isBrand: !!e.doc.isBrand, status: String(e.doc.status ?? 'on'), text: String(e.doc.text ?? e.external_id) });
    else campaignDocs.set(e.external_id, { media: String(e.doc.media ?? ''), name: String(e.doc.name ?? e.external_id) });
  }
  const since = new Date(nowMs() - 400 * 86_400_000).toISOString();
  const result: MeasureResult = { changes: { ...zero(), skipped: 0 }, incidents: zero(), automation: { months: [], rows: 0, hours: 0 }, at: new Date(nowMs()).toISOString() };

  /* 변경 — 반영된 변경 전체(대조군 오염 판단용 · 측정 창 여유 14일)와 시도별 실행 기록 */
  const done = new Map((await q.query<{ source_id: string; status: LedgerStatus }>(
    `SELECT source_id, status FROM impact_ledger WHERE workspace_id = $1 AND source_type = 'change'`, [wsId],
  )).rows.map((r) => [r.source_id, r.status]));
  const appliedAll = (await q.query<ChangeRowLite>(
    `SELECT id, kind, module, target, target_id, before, after, status, applied_at, rolled_back_at, execution FROM change_requests
      WHERE workspace_id = $1 AND applied_at IS NOT NULL AND applied_at >= $2 ORDER BY applied_at, id`,
    [wsId, new Date(Date.parse(since) - 14 * 86_400_000).toISOString()],
  )).rows;
  const attempts = new Map<string, ExecAttemptRow[]>();
  if (appliedAll.length) {
    const rows = (await q.query<ExecAttemptRow>(
      `SELECT change_id, attempt_id, phase, mode, ok, provider FROM change_executions
        WHERE workspace_id = $1 AND change_id = ANY($2::text[]) AND phase IN ('apply', 'retry', 'compensate') ORDER BY id`,
      [wsId, appliedAll.map((c) => c.id)],
    )).rows;
    for (const r of rows) {
      const list = attempts.get(r.change_id) ?? [];
      list.push(r);
      attempts.set(r.change_id, list);
    }
  }
  const applied = appliedAll.map((c) => ({ id: c.id, kind: c.kind, targetId: c.target_id, appliedMs: new Date(c.applied_at).getTime(), cls: classifyApply(c.execution, attempts.get(c.id) ?? []) }));
  const ctx: Ctx = { q, wsId, lastFinal, margin: cfg.margin, sources, keywordDocs, campaignDocs, applied, attempts };
  const changes = appliedAll.filter((c) => (c.kind === 'bid' || c.kind === 'budget') && new Date(c.applied_at).getTime() >= Date.parse(since));
  for (const c of changes) {
    const prev = done.get(c.id);
    if (!opts.force && prev && prev !== 'pending') { result.changes.skipped++; continue; }
    const e = await measureChange(ctx, c);
    await upsertEntry(q, wsId, e);
    result.changes[e.status]++;
  }

  /* 사고 */
  const incs = (await q.query<{ id: string; severity: string; status: string; doc: Record<string, any>; detected_at: Date; resolved_at: Date | null }>(
    `SELECT id, severity, status, doc, detected_at, resolved_at FROM incidents WHERE workspace_id = $1 AND status = 'resolved' AND COALESCE(resolved_at, updated_at) >= $2`,
    [wsId, since],
  )).rows;
  for (const i of incs) {
    const doc = i.doc ?? {};
    const loss = Number(doc.impact?.revenueLossEst);
    if (!(loss > 0)) continue;
    const det = new Date(i.detected_at).getTime();
    // 서버 24시간 감지(alerts scan)가 만든 이슈만 — 화면에서 사람이 등록한 이슈(source 'client')는 발생 시각 · 추정 손실이 입력값이다
    const r = withWorkspaceConfig(wcfg, () => estimateLossAvoided({
      id: i.id, title: String(doc.title ?? i.id), severity: i.severity, revenueLossEst: loss,
      occurredAt: typeof doc.occurredAt === 'string' ? doc.occurredAt : null, detectedAt: typeof doc.detectedAt === 'string' ? doc.detectedAt : new Date(det).toISOString(),
      actionAt: doc.sla?.actionAt ?? null, ackAt: doc.sla?.ackAt ?? null, resolvedAt: doc.sla?.resolvedAt ?? (i.resolved_at ? new Date(i.resolved_at).toISOString() : null),
      isTest: !!doc.isTest, falsePositive: !!doc.falsePositive, autoDetected: doc.source === 'scan',
    }));
    const status: LedgerStatus = r.ok ? 'measured' : 'excluded';
    await upsertEntry(q, wsId, {
      sourceType: 'incident', sourceId: i.id, label: `${i.severity} ${String(doc.title ?? i.id)}`, occurredAt: new Date(det).toISOString(), month: kstMonthOf(det), windowDays: 0,
      status, baseline: null, observed: null, control: null, estimate: r.ok ? r.estimate : null,
      detail: { severity: i.severity, target: typeof doc.target === 'string' ? doc.target : undefined, route: 'alert', reason: r.ok ? undefined : r.reason, exclusion: r.ok ? undefined : r.code, test: !!doc.isTest || undefined },
    });
    result.incidents[status]++;
  }
  // 다시 열린 이슈 → 관측 중
  await q.query(
    `UPDATE impact_ledger l SET status = 'pending', estimate = NULL, measured_at = NULL, updated_at = now(), detail = (l.detail - 'exclusion') || '{"reason":"다시 열린 이슈 — 해결되면 다시 추정"}'::jsonb
      FROM incidents i WHERE l.workspace_id = $1 AND l.source_type = 'incident' AND i.workspace_id = l.workspace_id AND i.id = l.source_id AND i.status <> 'resolved' AND l.status <> 'pending'`,
    [wsId],
  );

  /* 자동화 (이번 달 · 지난달) */
  const cur = today.slice(0, 7);
  for (const month of [prevMonth(cur), cur]) {
    const upTo = month === cur ? today : `${month}-31`;
    const counts = await automationCounts(q, wsId, month, upTo, wcfg);
    const bdays = withWorkspaceConfig(wcfg, () => businessDaysIn(month, month === cur ? today : undefined));
    const sav = automationSavings(counts, bdays);
    for (const row of sav.rows) {
      const u = AUTOMATION_UNITS.find((x) => x.id === row.unit)!;
      const sourceId = `${month}:${row.unit}`;
      if (row.count <= 0) {
        await q.query(`DELETE FROM impact_ledger WHERE workspace_id = $1 AND source_type = 'automation' AND source_id = $2`, [wsId, sourceId]);
        continue;
      }
      await upsertEntry(q, wsId, {
        sourceType: 'automation', sourceId, label: u.label, occurredAt: new Date(kstMsOf(`${month}-01`)).toISOString(), month, windowDays: 0,
        status: 'measured', baseline: null, observed: null, control: null, estimate: row,
        detail: { reason: `${EVIDENCE_TEXT[row.unit]?.(counts.evidence ?? {}) ?? ''} · 월 영업일 ${bdays}일${month === cur ? ' (오늘까지)' : ''}`, route: row.unit.includes('report') ? 'impact' : row.unit === 'detection_days' ? 'notify' : row.unit === 'ingest_days' ? 'connections' : 'flow' },
      });
      result.automation.rows++;
      if (month === cur) result.automation.hours += row.hours;
    }
    result.automation.months.push(month);
  }
  result.automation.hours = Math.round(result.automation.hours * 100) / 100;
  return result;
}

/** 워크스페이스 데이터 출처 — 실연동 커넥션(데모 · CSV 제외 api) 또는 가져온 업로드가 있으면 live, 데모와 같이 있으면 mixed, 없으면 demo */
export async function workspaceDataMode(q: Queryable, wsId: string): Promise<'demo' | 'live' | 'mixed'> {
  const r = await one<{ real: number; demo: number }>(
    q,
    `SELECT (SELECT count(*)::int FROM connections WHERE workspace_id = $1 AND provider <> 'demo' AND status <> 'disabled')
            + (SELECT count(*)::int FROM uploads WHERE workspace_id = $1 AND status = 'imported') AS real,
            (SELECT count(*)::int FROM connections WHERE workspace_id = $1 AND provider = 'demo' AND status <> 'disabled') AS demo`,
    [wsId],
  );
  if (!r || r.real === 0) return 'demo';
  return r.demo > 0 ? 'mixed' : 'live';
}
