/**
 * 반영 실행기 — 반영 전 점검(가드) · 대상 해석 · 커넥터 호출(dry_run / live) · 부분 실패 되돌림 · 롤백 계획.
 * DB 트랜잭션 밖에서 실행된다(외부 호출 중 행 잠금을 잡지 않는다). 상태 기록은 service.ts가 잠금을 잡고 한다.
 *
 * 점검은 화면과 같은 함수로 한다 — MILDO Flow executionCheck(AD Pilot validateAdpilotExecution · GFA validateGfaExecution ·
 * 일 조정 폭 상한 · 최대 입찰가 · 30% 초과 예산의 수면밀도 승인 · 계정 잔액 · 데이터 가드)를 워크스페이스 설정을 적용한 상태에서 실행하고,
 * 서버 전용 점검(키워드 일 누적 조정 폭, 엔티티 최대 입찰가, 미해결 대량 변경 이슈)을 더한다.
 *
 * 현재 값 대조: 요청의 before는 화면이 보낸 값이라 오래됐거나(그사이 다른 반영 · dry_run 반영 · 매체 화면 수정) 틀릴 수 있다.
 * 웨어하우스에 마지막 수집값이 있고 그 뒤로 이 대상에 live 쓰기가 없었으면 그 값을 '매체 현재 값'으로 보고,
 * 요청 값과 다르면 실행 계획의 before(롤백 복원값) · 재배분 감액 폭을 현재 값 기준으로 바꾼다.
 * live에서는 현재 값 기준 변경 폭이 일 조정 폭 상한(입찰) · 승인 범위(예산)를 넘으면 보내지 않고 보류한다(dry_run은 주의로만).
 */
import type { ApprovalLevel, ChangeRequest, Dataset, Incident } from '@/core/types';
import { APPROVER_LABEL, executionCheck } from '@/modules/flow/engine';
import { officialConfig } from '@/modules/adpilot/engine';
import { activeConfig, detectBulkChange, type AlertIncident } from '@/modules/alert/engine';
import { GFA_DELEGATION } from '@/data/constants';
import type { AppConfig } from '../config';
import type { Db, Queryable } from '../db/pool';
import { redact } from '../audit/audit';
import { scrubSecrets } from '../connectors/http';
import type { ConnectorBinding, ConnectorResolver } from './connector-adapter';
import type { ExecOp, ExecPlan, OpResult, ServerExecution } from './model';
import { LEVEL_RANK, effectivePct, toNum } from './policy';
import { connectionsForChannel, findEntities, getConnection, numOf, parseTarget, type ConnectionRow, type EntityHit } from './targets';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/* 반영 전 점검                                                          */
/* ------------------------------------------------------------------ */

export interface GuardInput {
  data: Dataset | null;
  dataError?: string;
  /** 워크스페이스 변경 목록 (현재 건 포함, 현재 건은 승인 상태로) */
  changes: ChangeRequest[];
  incidents: Incident[];
  change: ChangeRequest;
  today: string;
  /** 같은 키워드의 오늘 반영된 입찰 변경 (반영 시각 순) */
  todayAppliedBids: ChangeRequest[];
  /** DB에 있는 대량 변경 이슈 상태 (id → status) */
  bulkIncidentStatus: Map<string, string>;
}

export interface GuardResult {
  ok: boolean;
  blocks: string[];
  warnings: string[];
  passes: string[];
  /** 새로 적재할 대량 변경 이슈 (현재 건 관련) */
  bulkIncidents: AlertIncident[];
}

/** 동기 함수 — withWorkspaceConfig 안에서 호출한다 */
export function evaluateGuards(g: GuardInput): GuardResult {
  const blocks: string[] = [];
  const warnings: string[] = [];
  const passes: string[] = [];
  const base = g.change;
  const e = effectivePct(base);
  const c: ChangeRequest = {
    ...base,
    status: 'approved',
    changePct: (base.kind === 'bid' || base.kind === 'budget') && finite(e.pct) ? round1(e.pct) : base.changePct,
  };
  if ((base.kind === 'bid' || base.kind === 'budget') && e.mismatch) warnings.push(`변경 폭 대조: 요청 ${round1(base.changePct ?? NaN)}% · 값 기준 ${round1(e.computed)}% — 큰 쪽(${round1(e.pct)}%)으로 점검`);
  const changes = g.changes.map((x) => (x.id === c.id ? c : x));
  if (!changes.some((x) => x.id === c.id)) changes.unshift(c);
  const cfg = officialConfig(changes);

  if (g.data) {
    let ex: ReturnType<typeof executionCheck> | null = null;
    try {
      ex = executionCheck(g.data, changes, g.incidents, c);
    } catch (err) {
      warnings.push(`실행 점검 계산 실패 — 데이터 기반 점검을 건너뜀 (${(err as Error).message})`);
    }
    if (ex) {
      blocks.push(...ex.blocks);
      warnings.push(...ex.warnings);
      passes.push(...ex.passes.filter((p) => !/데모: 로컬 상태 반영/.test(p)));
    }
  } else {
    warnings.push(`데이터셋을 만들 수 없어 데이터 기반 점검(성과 급변 · 전환 추적 단절 · 계정 잔액 · AD Pilot 보류)을 건너뜀${g.dataError ? ` — ${g.dataError}` : ''}`);
    if (c.kind === 'bid' && finite(c.changePct) && Math.abs(c.changePct) > cfg.dailyChangeCapPct) {
      blocks.push(`입찰 변경 폭 ${round1(c.changePct)}% > 일 조정 폭 상한 ${cfg.dailyChangeCapPct}% (p.14 SAFETY)`);
    }
    const pmMax = GFA_DELEGATION[1].maxPct;
    if ((c.kind === 'budget' || c.kind === 'gfa') && finite(c.changePct) && Math.abs(c.changePct) > pmMax && c.approver !== 'CLIENT') {
      blocks.push(`예산 변경 폭 ${round1(c.changePct)}% — ${pmMax}% 초과는 수면밀도 승인 필요 (p.15)`);
    }
  }

  /* 키워드 일 누적 조정 폭 (p.14 '일 조정 폭 상한'은 하루 기준) */
  if (c.kind === 'bid' && g.todayAppliedBids.length) {
    const startBid = toNum(g.todayAppliedBids[0].before);
    const after = toNum(c.after);
    if (finite(startBid) && startBid > 0 && finite(after)) {
      const cum = ((after - startBid) / startBid) * 100;
      if (Math.abs(cum) > cfg.dailyChangeCapPct + 1e-9) {
        blocks.push(`오늘 누적 조정 폭 ${round1(cum)}% (오늘 시작 입찰가 ${startBid}원 → ${after}원, 반영 ${g.todayAppliedBids.length}건 포함) > 일 조정 폭 상한 ${cfg.dailyChangeCapPct}% (p.14 SAFETY)`);
      } else {
        passes.push(`오늘 누적 조정 폭 ${round1(cum)}% · 상한 ${cfg.dailyChangeCapPct}% 이내`);
      }
    }
  }

  /* 대량 변경 실수 (p.45) — 미해결 이슈가 걸린 건은 신규 반영 일시 차단 */
  const bulkIncidents: AlertIncident[] = [];
  let found: AlertIncident[] = [];
  try {
    found = detectBulkChange(changes, { today: g.today, config: activeConfig(changes) });
  } catch {
    found = [];
  }
  for (const b of found) {
    if (!(b.related ?? []).includes(c.id)) continue;
    const st = g.bulkIncidentStatus.get(b.id);
    if (st === 'resolved') {
      passes.push(`대량 변경 이슈 ${b.id} 확인 · 종료됨`);
      continue;
    }
    if (!st) bulkIncidents.push(b);
    blocks.push(`대량 변경 실수 감지 (P1 · ${b.title}) — 이슈 확인 · 종료 전 신규 반영 일시 차단 (p.45)`);
  }

  return { ok: blocks.length === 0, blocks, warnings, passes, bulkIncidents };
}

/* ------------------------------------------------------------------ */
/* 대상 해석 → 실행 계획                                                  */
/* ------------------------------------------------------------------ */

export type Resolution =
  | { kind: 'record'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'plan'; plan: ExecPlan; bindings: Map<string, ConnectorBinding>; notes: string[] };

interface ResolveCtx {
  db: Db;
  config: AppConfig;
  resolver: ConnectorResolver;
}

/** 현재 값 대조에 쓰는 기준 (워크스페이스 설정을 적용한 상태에서 계산해 넘긴다) */
export interface PlanLimits {
  /** 입찰 일 조정 폭 상한 (%) */
  bidCapPct: number;
  /** 위임 범위 (변경 폭 ±maxPct 이내 → approver), 순서대로 */
  tiers: { maxPct: number; approver: ApprovalLevel }[];
}

const approverForPct = (tiers: PlanLimits['tiers'], pct: number): ApprovalLevel => {
  if (!finite(pct) || !tiers.length) return 'CLIENT';
  const t = tiers.find((x) => Math.abs(pct) <= x.maxPct + 1e-9);
  return t?.approver ?? 'CLIENT';
};

export interface Observed {
  value: number;
  at: Date | null;
  /** 'sync' = 마지막 수집값, 'live' = 그 뒤 MILDO OS가 live로 보낸 값(매체 적용값 우선) */
  source: 'sync' | 'live';
  /** 매체 현재 값으로 볼 수 있는지 (live 쓰기 기록에 값이 없으면 false) */
  trusted: boolean;
  reason?: string;
}

/** 대상의 매체 현재 입찰가 · 일 예산 추정 (입찰 · 예산만): 마지막 수집값, 그 뒤 live 쓰기가 있으면 마지막으로 보낸 값 */
export async function observedOf(q: Queryable, ws: string, hit: EntityHit, kind: ChangeRequest['kind']): Promise<Observed | null> {
  const field = kind === 'bid' && hit.entityType === 'keyword' ? 'bid' : kind === 'budget' && hit.entityType === 'campaign' ? 'dailyBudget' : null;
  if (!field || !hit.connection) return null;
  const r = await q.query<{ op_after: unknown; applied_value: unknown; finished_at: Date }>(
    `SELECT op_after, applied_value, finished_at FROM change_executions
      WHERE workspace_id = $1 AND connection_id = $2 AND target_external_id = $3 AND mode = 'live' AND ok AND finished_at > $4
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [ws, hit.connection.id, hit.externalId, hit.updatedAt ?? new Date(0)],
  );
  const w = r.rows[0];
  if (w) {
    const reported = numOf(w.applied_value);
    const v = finite(reported) ? reported : numOf(w.op_after);
    if (finite(v) && v >= 0) return { value: v, at: new Date(w.finished_at), source: 'live', trusted: true };
    return { value: NaN, at: new Date(w.finished_at), source: 'live', trusted: false, reason: '마지막 수집 뒤 live 반영의 값을 알 수 없음' };
  }
  const value = numOf(hit.doc[field]);
  if (!finite(value) || value < 0 || (field === 'bid' && value === 0)) return null;
  return { value, at: hit.updatedAt, source: 'sync', trusted: true };
}

const kstClock = (d: Date | null) => (d ? new Date(d.getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : '시각 미상');

const NON_IDEMPOTENT = new Set<ChangeRequest['kind']>(['gfa', 'keyword_add']);

async function writable(rc: ResolveCtx, conn: ConnectionRow, kind: ChangeRequest['kind'], cache: Map<string, ConnectorBinding | null>): Promise<ConnectorBinding | null> {
  let b = cache.get(conn.id);
  if (b === undefined) {
    b = await rc.resolver(rc.db, rc.config, conn);
    cache.set(conn.id, b);
  }
  if (!b || typeof b.def.apply !== 'function') return null;
  if (!(b.def.capabilities?.writes ?? []).includes(kind)) return null;
  return b;
}

async function pickWritable(rc: ResolveCtx, hits: EntityHit[], kind: ChangeRequest['kind'], cache: Map<string, ConnectorBinding | null>) {
  for (const h of hits) {
    if (!h.connection) continue;
    const b = await writable(rc, h.connection, kind, cache);
    if (b) return { hit: h, binding: b };
  }
  return null;
}

function modeOf(conns: ConnectionRow[]): { mode: 'dry_run' | 'live' } | { blocked: string } {
  for (const c of conns) {
    if (c.status === 'disabled') return { blocked: `대상 커넥션 '${c.label}'이(가) 비활성 상태입니다 — 데이터 연결 화면에서 활성화 후 재실행` };
    if (c.write_mode === 'off') return { blocked: `대상 커넥션 '${c.label}'의 쓰기 모드가 꺼져 있습니다(off) — dry_run 또는 live로 바꾼 뒤 재실행` };
  }
  return { mode: conns.some((c) => c.write_mode !== 'live') ? 'dry_run' : 'live' };
}

/** 변경 요청 → 실행 계획 (반영). limits가 있으면 현재 값 기준 변경 폭도 점검한다 */
export async function resolvePlan(rc: ResolveCtx, ws: string, c: ChangeRequest, limits?: PlanLimits): Promise<Resolution> {
  const ref = parseTarget(c);
  if (ref.type === 'record') return { kind: 'record', reason: ref.reason };
  const cache = new Map<string, ConnectorBinding | null>();
  const notes: string[] = [];

  if (ref.type === 'media') {
    const conns = await connectionsForChannel(rc.db, ws, ref.media);
    const ok: { conn: ConnectionRow; b: ConnectorBinding }[] = [];
    for (const conn of conns) {
      const b = await writable(rc, conn, c.kind, cache);
      if (b) ok.push({ conn, b });
    }
    if (!ok.length) return { kind: 'record', reason: `${ref.media} 매체에 이 변경 종류를 반영할 수 있는 커넥션이 없습니다` };
    if (ok.length > 1) return { kind: 'blocked', reason: `${ref.media} 매체 커넥션이 ${ok.length}개라 반영할 계정을 특정할 수 없습니다 — 대상 id를 지정해 다시 요청하세요` };
    const m = modeOf([ok[0].conn]);
    if ('blocked' in m) return { kind: 'blocked', reason: m.blocked };
    const op: ExecOp = {
      externalId: c.targetId ?? '', entityType: 'new', kind: c.kind, target: c.target, before: c.before, after: c.after, role: 'primary',
      connectionId: ok[0].conn.id, provider: ok[0].conn.provider, idempotent: false,
    };
    return { kind: 'plan', plan: { mode: m.mode, ops: [op] }, bindings: new Map([[ok[0].conn.id, ok[0].b]]), notes };
  }

  const hits = await findEntities(rc.db, ws, ref.entityTypes, { id: ref.id, text: ref.text });
  const label = ref.id ?? ref.text ?? '';
  if (!hits.length) return { kind: 'record', reason: `웨어하우스에서 대상(${label})을 찾지 못했습니다 — 매체 반영 대상 없음` };
  const pick = await pickWritable(rc, hits, c.kind, cache);
  if (!pick) {
    const withConn = hits.filter((h) => h.connection);
    return {
      kind: 'record',
      reason: withConn.length
        ? `대상 커넥션(${withConn.map((h) => h.connection!.provider).join(', ')})이 '${c.kind}' 반영을 지원하지 않습니다`
        : `대상(${label})의 출처가 CSV · 데모 데이터라 반영할 커넥션이 없습니다`,
    };
  }
  const { hit, binding } = pick;
  const doc = hit.doc;

  /* 값 점검 */
  const after = toNum(c.after);
  if (c.kind === 'bid') {
    if (!finite(after) || after <= 0) return { kind: 'blocked', reason: '실행 오류: 입찰가 값이 올바르지 않습니다' };
    const maxBid = numOf(doc.maxBid);
    if (finite(maxBid) && maxBid > 0 && after > maxBid) return { kind: 'blocked', reason: `실행 오류: 입찰가 ${after}원 > 최대 입찰가 ${maxBid}원 (${hit.externalId})` };
  }
  if (c.kind === 'budget' && (!finite(after) || after < 0)) return { kind: 'blocked', reason: '실행 오류: 일 예산 값이 올바르지 않습니다' };

  let externalId = hit.externalId;
  let entityType: ExecOp['entityType'] = hit.entityType;
  if (ref.type === 'entity' && ref.adGroupId) { externalId = `gfa:adgroup:${hit.externalId}:${ref.adGroupId}`; entityType = 'adgroup'; }
  if (ref.type === 'entity' && ref.newName !== undefined) { externalId = `gfa:new:${hit.externalId}:${ref.newName}`; entityType = 'new'; }

  /* 현재 값 대조 (요청 before ↔ 마지막 수집값) */
  let primaryBefore: string | number = c.before;
  let mismatch: { observed: number; requested: number } | null = null;
  const obs = entityType === 'keyword' || entityType === 'campaign' ? await observedOf(rc.db, ws, hit, c.kind) : null;
  if (obs?.trusted) {
    const req = toNum(c.before);
    if (!finite(req) || Math.abs(req - obs.value) > Math.max(1, Math.abs(obs.value) * 0.005)) {
      mismatch = { observed: obs.value, requested: req };
      primaryBefore = obs.value;
      notes.push(`요청 시점 값 ${String(c.before)} ≠ 매체 현재 값 ${obs.value} (${obs.source === 'live' ? '마지막 live 반영' : '마지막 수집'} ${kstClock(obs.at)} 기준) — 현재 값 기준으로 반영 · 롤백`);
    }
  } else if (obs && !obs.trusted) {
    notes.push(`현재 값 대조 생략 — ${obs.reason ?? '현재 값을 알 수 없음'}`);
  }

  const ops: ExecOp[] = [{
    externalId, entityType, kind: c.kind, target: c.target, before: primaryBefore, after: c.after, role: 'primary',
    connectionId: hit.connection!.id, provider: hit.connection!.provider, idempotent: !NON_IDEMPOTENT.has(c.kind) && entityType !== 'new',
  }];
  const bindings = new Map<string, ConnectorBinding>([[hit.connection!.id, binding]]);
  const conns = [hit.connection!];

  /* 예산 재배분: 주는 캠페인 감액도 같이 (한쪽만 반영되면 총 예산이 바뀐다) */
  if (ref.type === 'entity' && ref.donorId && c.kind === 'budget') {
    const before = toNum(primaryBefore);
    const delta = after - before;
    const dHits = await findEntities(rc.db, ws, ['campaign'], { id: ref.donorId });
    const dPick = await pickWritable(rc, dHits, 'budget', cache);
    if (!dPick) return { kind: 'blocked', reason: `재배분 감액 캠페인(${ref.donorId})을 반영할 수 없습니다 — 받는 캠페인만 늘리면 총 예산이 늘어나 보류합니다` };
    const dObs = await observedOf(rc.db, ws, dPick.hit, 'budget');
    if (dObs && !dObs.trusted) return { kind: 'blocked', reason: `재배분 감액 캠페인(${ref.donorId})의 현재 일 예산을 확인할 수 없습니다 — ${dObs.reason}` };
    const donorBudget = dObs ? dObs.value : numOf(dPick.hit.doc.dailyBudget);
    if (!finite(donorBudget) || !finite(delta)) return { kind: 'blocked', reason: `재배분 감액 캠페인(${ref.donorId})의 현재 일 예산을 확인할 수 없습니다` };
    const donorAfter = Math.max(0, donorBudget - delta);
    ops.push({
      externalId: dPick.hit.externalId, entityType: 'campaign', kind: 'budget', target: `${String(dPick.hit.doc.name ?? ref.donorId)} 일 예산 (재배분 감액)`,
      before: donorBudget, after: donorAfter, role: 'donor', connectionId: dPick.hit.connection!.id, provider: dPick.hit.connection!.provider, idempotent: true,
    });
    bindings.set(dPick.hit.connection!.id, dPick.binding);
    conns.push(dPick.hit.connection!);
    notes.push(`재배분: 감액 캠페인 ${dPick.hit.externalId} ${donorBudget} → ${donorAfter}`);
  }

  const m = modeOf(conns);
  if ('blocked' in m) return { kind: 'blocked', reason: m.blocked };
  if (m.mode === 'dry_run' && conns.some((x) => x.write_mode === 'live')) notes.push('커넥션 쓰기 모드가 섞여 있어 전체를 dry_run으로 실행합니다');

  /* 현재 값 기준 변경 폭 점검 — live는 보류, dry_run은 주의로 */
  if (mismatch && limits) {
    const o = mismatch.observed;
    const pct = o > 0 ? ((after - o) / o) * 100 : after > 0 ? Infinity : 0;
    const pctTxt = finite(pct) ? `${round1(pct)}%` : '계산 불가';
    let issue: string | null = null;
    if (c.kind === 'bid' && (!finite(pct) || Math.abs(pct) > limits.bidCapPct + 1e-9)) {
      issue = `매체 현재 입찰가 ${o}원 → ${after}원 = 변경 폭 ${pctTxt} > 일 조정 폭 상한 ${limits.bidCapPct}% (p.14 SAFETY · 요청 값 ${String(c.before)} 기준이 아님) — 현재 값으로 다시 요청하세요`;
    }
    if (c.kind === 'budget') {
      const need = approverForPct(limits.tiers, pct);
      if (LEVEL_RANK[need] > LEVEL_RANK[c.approver]) {
        issue = `매체 현재 일 예산 ${o}원 → ${after}원 = 변경 폭 ${pctTxt} → ${APPROVER_LABEL[need]} 승인 필요 (현재 승인 주체 ${APPROVER_LABEL[c.approver]} · p.15 위임 범위) — 현재 값으로 다시 요청하세요`;
      }
    }
    if (issue) {
      if (m.mode === 'live') return { kind: 'blocked', reason: `실행 오류: ${issue}` };
      notes.push(`dry_run 점검 — live였다면 보류: ${issue}`);
    }
  }
  return { kind: 'plan', plan: { mode: m.mode, ops }, bindings, notes };
}

/**
 * 롤백 순서 (매체 기준): 이 변경 뒤에 같은 매체 대상(외부 id)에 live로 반영되어 아직 '반영' 상태인 다른 변경.
 * Flow canRollback은 같은 targetId 규칙만 보므로(예: 'budget:cmp_2:cmp_5'와 'flow:budget:cmp_2'는 서로 모른다) 실행 기록으로 보강한다.
 */
export async function laterLiveWrites(q: Queryable, ws: string, changeId: string, plan: ExecPlan | undefined, since: Date | null): Promise<{ id: string; target: string }[]> {
  if (!plan?.ops?.length || !since) return [];
  const r = await q.query<{ id: string; target: string }>(
    `SELECT DISTINCT r.id, r.target FROM change_executions e
       JOIN change_requests r ON r.workspace_id = e.workspace_id AND r.id = e.change_id
      WHERE e.workspace_id = $1 AND e.change_id <> $2 AND r.status = 'applied' AND e.mode = 'live' AND e.ok
        AND e.phase IN ('apply', 'retry') AND e.target_external_id = ANY($3) AND e.connection_id::text = ANY($4) AND e.finished_at > $5
      LIMIT 5`,
    [ws, changeId, plan.ops.map((o) => o.externalId), plan.ops.map((o) => o.connectionId), since],
  );
  return r.rows;
}

/** 롤백 계획 — 직전 반영 실행의 계획을 뒤집는다 (after → before) */
export async function resolveRollbackPlan(rc: ResolveCtx, ws: string, c: ChangeRequest, applyExec: ServerExecution | undefined): Promise<Resolution> {
  const prev = applyExec?.plan;
  if (!applyExec || applyExec.mode === 'none' || !prev?.ops?.length) {
    return { kind: 'record', reason: '반영 시 매체에 보내지 않은 건(기록만) — 되돌릴 매체 값이 없어 기록만' };
  }
  if (prev.ops.some((o) => !o.idempotent)) {
    if (applyExec.mode === 'dry_run') return { kind: 'record', reason: 'dry_run으로 기록된 신규 생성 · 키워드 추가 — 되돌릴 매체 값이 없어 기록만' };
    return { kind: 'blocked', reason: '신규 생성 · 키워드 추가는 자동 롤백을 지원하지 않습니다 — 매체 화면에서 OFF · 삭제 후 이력에 남겨 주세요' };
  }
  const cache = new Map<string, ConnectorBinding | null>();
  const bindings = new Map<string, ConnectorBinding>();
  const conns: ConnectionRow[] = [];
  for (const op of prev.ops) {
    if (bindings.has(op.connectionId)) continue;
    const conn = await getConnection(rc.db, ws, op.connectionId);
    if (!conn) return { kind: 'blocked', reason: `반영에 쓴 커넥션(${op.connectionId})이 삭제되어 롤백할 수 없습니다` };
    const b = await writable(rc, conn, op.kind, cache);
    if (!b) return { kind: 'blocked', reason: `커넥션 '${conn.label}'이(가) 더 이상 '${op.kind}' 반영을 지원하지 않아 롤백할 수 없습니다` };
    bindings.set(conn.id, b);
    conns.push(conn);
  }
  const m = modeOf(conns);
  if ('blocked' in m) return { kind: 'blocked', reason: m.blocked };
  if (applyExec.mode === 'live' && m.mode !== 'live') {
    return { kind: 'blocked', reason: 'live로 반영된 변경입니다 — 커넥션 쓰기 모드가 live가 아니어서 매체 값을 되돌릴 수 없습니다 (live로 바꾼 뒤 롤백)' };
  }
  // dry_run 반영 건은 live 커넥션이어도 dry_run으로만 되돌린다 (매체에 보낸 적 없는 값을 live로 덮지 않는다)
  const mode = applyExec.mode === 'dry_run' ? 'dry_run' : m.mode;
  const ops: ExecOp[] = [...prev.ops].reverse().map((o) => ({ ...o, before: o.after, after: o.before, target: `${o.target} (롤백)` }));
  return { kind: 'plan', plan: { mode, ops }, bindings, notes: [] };
}

/* ------------------------------------------------------------------ */
/* 실행                                                                */
/* ------------------------------------------------------------------ */

const MAX_JSON = 20_000;
/** 감사 redact가 놓치는 매체 인증 키 이름까지 (x-api-key · signature · x-customer · access/refresh token · developer-token 등) */
const EXTRA_SECRET_KEY = /(api[-_]?key|signature|x-customer|access[-_]?token|refresh[-_]?token|developer[-_]?token|client[-_]?secret|bearer)/i;
function scrubKeys(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrubKeys(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = EXTRA_SECRET_KEY.test(k) ? (val ? '••••' : val) : scrubKeys(val, depth + 1);
  return out;
}
function bounded(v: unknown): unknown {
  if (v === undefined) return undefined;
  const safe = scrubKeys(redact(v));
  try {
    const s = JSON.stringify(safe);
    if (s === undefined) return null;
    return s.length > MAX_JSON ? { truncated: true, preview: s.slice(0, MAX_JSON) } : safe;
  } catch {
    return { unserializable: true };
  }
}

export interface RunOutcome {
  ok: boolean;
  results: OpResult[];
  compensation: OpResult[];
  error?: string;
  logs: string[];
}

function opChange(c: ChangeRequest, op: ExecOp): ChangeRequest {
  const b = toNum(op.before), a = toNum(op.after);
  return {
    ...c,
    kind: op.kind,
    target: op.target,
    targetId: op.externalId,
    before: op.before,
    after: op.after,
    changePct: finite(b) && finite(a) && b !== 0 ? round1(((a - b) / Math.abs(b)) * 100) : c.changePct,
  };
}

async function callOp(binding: ConnectorBinding, c: ChangeRequest, op: ExecOp, dryRun: boolean, log: (m: string, e?: unknown) => void): Promise<OpResult> {
  const base = { externalId: op.externalId, connectionId: op.connectionId, provider: op.provider, value: op.after };
  try {
    const ctx = await binding.context({ dryRun, log, idempotent: op.idempotent });
    const r = await binding.def.apply!(ctx, opChange(c, op));
    return {
      ...base,
      ok: !!r?.ok,
      request: bounded(r?.request),
      response: bounded(r?.response),
      error: r?.ok ? undefined : scrubSecrets(String(r?.error ?? '매체가 실패를 돌려줬습니다')).slice(0, 1000),
      appliedValue: r?.appliedValue,
    };
  } catch (e) {
    return { ...base, ok: false, error: scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 1000) };
  }
}

/** 계획 실행 — 순서대로, 실패하면 멈추고 live에서 이미 성공한 작업은 되돌린다 */
export async function runPlan(plan: ExecPlan, bindings: Map<string, ConnectorBinding>, c: ChangeRequest): Promise<RunOutcome> {
  const logs: string[] = [];
  const log = (m: string, e?: unknown) => {
    if (logs.length < 50) logs.push(`${m}${e === undefined ? '' : ` ${JSON.stringify(bounded(e)).slice(0, 300)}`}`.slice(0, 400));
  };
  const dryRun = plan.mode === 'dry_run';
  const results: OpResult[] = [];
  const compensation: OpResult[] = [];
  for (const op of plan.ops) {
    const b = bindings.get(op.connectionId);
    const r = b ? await callOp(b, c, op, dryRun, log) : { externalId: op.externalId, connectionId: op.connectionId, provider: op.provider, value: op.after, ok: false, error: '커넥터를 찾을 수 없습니다' };
    results.push(r);
    if (!r.ok) {
      if (!dryRun) {
        for (const done of [...plan.ops.slice(0, results.length - 1)].reverse()) {
          const db = bindings.get(done.connectionId);
          if (!db) continue;
          compensation.push(await callOp(db, c, { ...done, before: done.after, after: done.before, target: `${done.target} (부분 실패 되돌림)` }, false, log));
        }
      }
      return { ok: false, results, compensation, error: r.error ?? '매체 반영 실패', logs };
    }
  }
  return { ok: true, results, compensation, logs };
}

/** 데이터셋 만들기 — 실패하면 null과 사유 */
export async function tryBuildDataset(build: (q: Queryable, ws: string) => Promise<Dataset>, q: Queryable, ws: string): Promise<{ data: Dataset | null; error?: string }> {
  try {
    const data = await build(q, ws);
    if (!data || !Array.isArray(data.keywords) || !Array.isArray(data.campaigns)) return { data: null, error: '데이터셋 형식이 올바르지 않습니다' };
    return { data };
  } catch (e) {
    return { data: null, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
