/**
 * change_requests 행 ↔ ChangeRequest(src/core/types.ts) 변환 · 조회 쿼리.
 * before / after는 jsonb로 저장해 string | number 타입을 그대로 보존한다.
 */
import type { ApprovalLevel, ChangeExecution, ChangeKind, ChangeRequest } from '@/core/types';
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';

export type ChangeStatus = ChangeRequest['status'];
export type HistoryEntry = ChangeRequest['history'][number];

export const CHANGE_KINDS: readonly ChangeKind[] = ['bid', 'budget', 'status', 'keyword_add', 'keyword_exclude', 'gfa', 'setting', 'alert_rule', 'test'];
export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ['AE', 'PM', 'CLIENT'];
export const CHANGE_STATUSES: readonly ChangeStatus[] = ['pending', 'approved', 'applied', 'rejected', 'rolled_back', 'held'];

/** 실행 단계 */
export type ExecPhase = 'apply' | 'retry' | 'rollback';

/** 매체 반영 단위 작업 — 한 변경 요청이 여러 대상에 쓰일 수 있다(예: 예산 재배분 = 받는 캠페인 + 주는 캠페인) */
export interface ExecOp {
  /** 커넥터에 넘길 targetId (wh_entities.external_id 또는 GFA 광고그룹 규칙 'gfa:adgroup:<cid>:<agid>') */
  externalId: string;
  entityType: 'keyword' | 'campaign' | 'account' | 'adgroup' | 'new';
  kind: ChangeKind;
  target: string;
  before: string | number;
  after: string | number;
  role: 'primary' | 'donor';
  connectionId: string;
  provider: string;
  /** 같은 값을 두 번 보내도 결과가 같은지 (절대값 설정 = true, 신규 생성 · 키워드 추가 = false) */
  idempotent: boolean;
}

export interface ExecPlan {
  mode: 'dry_run' | 'live';
  ops: ExecOp[];
}

export interface OpResult {
  externalId: string;
  connectionId: string;
  provider: string;
  /** 이 작업이 설정하려 한 값 (op.after) */
  value?: string | number;
  ok: boolean;
  request?: unknown;
  response?: unknown;
  error?: string;
  appliedValue?: string | number;
}

/** 서버 실행 결과 (ChangeExecution + 서버 확장 필드) */
export interface ServerExecution extends ChangeExecution {
  phase?: ExecPhase;
  note?: string;
  /** 기록만 · 보류의 사유 */
  reason?: string;
  appliedValue?: string | number;
  attemptId?: string;
  plan?: ExecPlan;
  results?: OpResult[];
  /** 부분 실패 후 되돌린 작업 */
  compensation?: OpResult[];
  /** 반영 전 점검 결과 */
  checks?: { blocks: string[]; warnings: string[]; passes: string[] };
  /** 롤백 실행 시: 직전 반영 실행 기록 */
  applyExecution?: ServerExecution;
}

export interface ExecPending {
  attemptId: string;
  phase: ExecPhase;
  since: string;
  by: { userId: string | null; name: string };
  label: string;
  note?: string;
  timedOut?: boolean;
  plan?: ExecPlan;
  /** 실행 중 프로세스가 살아 있다는 표시 (주기 갱신) — 감시 잡은 이 값이 오래됐을 때만 이어받는다 */
  heartbeat?: string;
}

export interface ChangeRow {
  id: string;
  workspace_id: string;
  created_at: Date;
  updated_at: Date;
  module: string;
  kind: ChangeKind;
  target: string;
  target_id: string | null;
  before: string | number | null;
  after: string | number | null;
  change_pct: number | null;
  reason: string;
  requested_by: string;
  requested_by_user: string | null;
  approver: ApprovalLevel;
  status: ChangeStatus;
  history: HistoryEntry[];
  execution: ServerExecution | null;
  exec_pending: ExecPending | null;
  applied_at: Date | null;
  rolled_back_at: Date | null;
  version: number;
}

/** API 응답 DTO — ChangeRequest + 서버 표시 필드(updatedAt · appliedAt · executing) */
export type ChangeDto = ChangeRequest & {
  execution?: ServerExecution;
  updatedAt: string;
  appliedAt?: string;
  rolledBackAt?: string;
  /** 매체 반영 · 롤백이 진행 중이면 단계와 시작 시각 */
  executing?: { phase: ExecPhase; since: string; background: boolean };
  version: number;
};

const iso = (d: Date | string | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);

/** compact: 목록용 — 실행 계획 · 단계별 결과 · 직전 실행의 상세는 빼고 요약만 (단건 조회 · 실행 기록 API에서 전체) */
export function toChange(r: ChangeRow, opts: { compact?: boolean } = {}): ChangeDto {
  const out: ChangeDto = {
    id: r.id,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    module: r.module,
    kind: r.kind,
    target: r.target,
    before: r.before ?? '',
    after: r.after ?? '',
    reason: r.reason,
    requestedBy: r.requested_by,
    approver: r.approver,
    status: r.status,
    history: Array.isArray(r.history) ? r.history : [],
    version: r.version ?? 0,
  };
  if (r.target_id !== null && r.target_id !== undefined) out.targetId = r.target_id;
  if (r.change_pct !== null && r.change_pct !== undefined && Number.isFinite(Number(r.change_pct))) out.changePct = Number(r.change_pct);
  if (r.execution) out.execution = opts.compact ? compactExecution(r.execution) : r.execution;
  if (r.applied_at) out.appliedAt = iso(r.applied_at);
  if (r.rolled_back_at) out.rolledBackAt = iso(r.rolled_back_at);
  if (r.exec_pending) out.executing = { phase: r.exec_pending.phase, since: r.exec_pending.since, background: !!r.exec_pending.timedOut };
  return out;
}

function compactExecution(e: ServerExecution): ServerExecution {
  const { plan: _p, results: _r, compensation, applyExecution, ...rest } = e;
  const out: ServerExecution = { ...rest };
  if (compensation?.length) out.compensation = compensation.map(({ request: _q, response: _s, ...c }) => c);
  if (applyExecution) out.applyExecution = compactExecution(applyExecution);
  return out;
}

/** ChangeRequest 형태 (엔진 입력용) */
export function toEngineChange(r: ChangeRow): ChangeRequest {
  const d = toChange(r);
  const { updatedAt: _u, appliedAt: _a, rolledBackAt: _r, executing: _e, version: _v, ...rest } = d;
  return rest;
}

const COLS = `id, workspace_id, created_at, updated_at, module, kind, target, target_id, before, after, change_pct, reason, requested_by,
  requested_by_user, approver, status, history, execution, exec_pending, applied_at, rolled_back_at, version`;

export async function getChange(q: Queryable, ws: string, id: string, lock = false): Promise<ChangeRow | null> {
  return one<ChangeRow>(q, `SELECT ${COLS} FROM change_requests WHERE workspace_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [ws, id]);
}

export async function listChanges(q: Queryable, ws: string, opts: { status?: ChangeStatus; limit?: number; since?: Date } = {}): Promise<ChangeRow[]> {
  const params: unknown[] = [ws];
  let where = 'workspace_id = $1';
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  if (opts.since) { params.push(opts.since); where += ` AND created_at >= $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  const r = await q.query<ChangeRow>(`SELECT ${COLS} FROM change_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  return r.rows;
}

/** 엔진 판정용 변경 목록: 최근 변경 + 기간과 무관하게 반영된 기준 변경(AD Pilot 설정 · 알림 기준) */
export async function engineChanges(q: Queryable, ws: string, limit = 1000): Promise<ChangeRequest[]> {
  const recent = await listChanges(q, ws, { limit });
  const cfg = await q.query<ChangeRow>(
    `SELECT ${COLS} FROM change_requests WHERE workspace_id = $1 AND status = 'applied' AND kind IN ('setting', 'alert_rule') ORDER BY created_at DESC LIMIT 500`,
    [ws],
  );
  const seen = new Set(recent.map((r) => r.id));
  return [...recent, ...cfg.rows.filter((r) => !seen.has(r.id))].map(toEngineChange);
}

export interface InsertChange {
  id: string;
  createdAt: Date;
  module: string;
  kind: ChangeKind;
  target: string;
  targetId: string | null;
  before: string | number;
  after: string | number;
  changePct: number | null;
  reason: string;
  requestedBy: string;
  requestedByUser: string | null;
  approver: ApprovalLevel;
  status: ChangeStatus;
  history: HistoryEntry[];
}

/** 같은 id가 이미 있으면 null */
export async function insertChange(q: Queryable, ws: string, c: InsertChange): Promise<ChangeRow | null> {
  return one<ChangeRow>(
    q,
    `INSERT INTO change_requests (id, workspace_id, created_at, updated_at, module, kind, target, target_id, before, after, change_pct, reason,
       requested_by, requested_by_user, approver, status, history)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb)
     ON CONFLICT (workspace_id, id) DO NOTHING
     RETURNING ${COLS}`,
    [c.id, ws, c.createdAt, c.module, c.kind, c.target, c.targetId, JSON.stringify(c.before), JSON.stringify(c.after), c.changePct, c.reason,
      c.requestedBy, c.requestedByUser, c.approver, c.status, JSON.stringify(c.history)],
  );
}

export interface ChangeUpdate {
  status?: ChangeStatus;
  target?: string;
  targetId?: string | null;
  before?: string | number;
  after?: string | number;
  changePct?: number | null;
  reason?: string;
  approver?: ApprovalLevel;
  history?: HistoryEntry[];
  execution?: ServerExecution | null;
  execPending?: ExecPending | null;
  appliedAt?: Date | null;
  rolledBackAt?: Date | null;
}

export async function updateChange(q: Queryable, ws: string, id: string, u: ChangeUpdate, at: Date): Promise<ChangeRow> {
  const sets: string[] = ['updated_at = $3', 'version = version + 1'];
  const params: unknown[] = [ws, id, at];
  const add = (col: string, v: unknown, cast = '') => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
  if (u.status !== undefined) add('status', u.status);
  if (u.target !== undefined) add('target', u.target);
  if (u.targetId !== undefined) add('target_id', u.targetId);
  if (u.before !== undefined) add('before', JSON.stringify(u.before), '::jsonb');
  if (u.after !== undefined) add('after', JSON.stringify(u.after), '::jsonb');
  if (u.changePct !== undefined) add('change_pct', u.changePct);
  if (u.reason !== undefined) add('reason', u.reason);
  if (u.approver !== undefined) add('approver', u.approver);
  if (u.history !== undefined) add('history', JSON.stringify(u.history), '::jsonb');
  if (u.execution !== undefined) add('execution', u.execution === null ? null : JSON.stringify(u.execution), '::jsonb');
  if (u.execPending !== undefined) add('exec_pending', u.execPending === null ? null : JSON.stringify(u.execPending), '::jsonb');
  if (u.appliedAt !== undefined) add('applied_at', u.appliedAt);
  if (u.rolledBackAt !== undefined) add('rolled_back_at', u.rolledBackAt);
  const row = await one<ChangeRow>(q, `UPDATE change_requests SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING ${COLS}`, params);
  if (!row) throw new Error(`변경 요청 갱신 실패: ${id}`);
  return row;
}

export interface ExecutionLogEntry {
  changeId: string;
  attemptId: string;
  phase: ExecPhase | 'compensate';
  mode: 'none' | 'dry_run' | 'live';
  ok: boolean;
  connectionId?: string | null;
  provider?: string | null;
  targetExternalId?: string | null;
  request?: unknown;
  response?: unknown;
  error?: string | null;
  appliedValue?: string | number | null;
  /** 이 작업이 설정한 값 (op.after) */
  opAfter?: string | number | null;
  actor: string;
  startedAt: Date;
  finishedAt: Date;
}

export async function logExecution(q: Queryable, ws: string, e: ExecutionLogEntry): Promise<void> {
  await q.query(
    `INSERT INTO change_executions (workspace_id, change_id, attempt_id, phase, mode, ok, connection_id, provider, target_external_id, request, response, error,
       applied_value, op_after, actor, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15, $16, $17)`,
    [ws, e.changeId, e.attemptId, e.phase, e.mode, e.ok, e.connectionId ?? null, e.provider ?? null, e.targetExternalId ?? null,
      e.request === undefined ? null : JSON.stringify(e.request), e.response === undefined ? null : JSON.stringify(e.response), e.error ?? null,
      e.appliedValue === undefined || e.appliedValue === null ? null : JSON.stringify(e.appliedValue),
      e.opAfter === undefined || e.opAfter === null ? null : JSON.stringify(e.opAfter), e.actor, e.startedAt, e.finishedAt],
  );
}

export interface ExecutionLogRow {
  id: number;
  attempt_id: string;
  phase: string;
  mode: string;
  ok: boolean;
  connection_id: string | null;
  provider: string | null;
  target_external_id: string | null;
  request: unknown;
  response: unknown;
  error: string | null;
  applied_value: unknown;
  actor: string;
  started_at: Date;
  finished_at: Date;
}

export async function listExecutions(q: Queryable, ws: string, changeId: string): Promise<ExecutionLogRow[]> {
  const r = await q.query<ExecutionLogRow>(
    `SELECT id, attempt_id, phase, mode, ok, connection_id, provider, target_external_id, request, response, error, applied_value, actor, started_at, finished_at
       FROM change_executions WHERE workspace_id = $1 AND change_id = $2 ORDER BY id DESC LIMIT 200`,
    [ws, changeId],
  );
  return r.rows;
}
