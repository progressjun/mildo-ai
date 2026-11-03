/**
 * impact 도메인 통합 테스트 (실제 PostgreSQL · 합성 웨어하우스 데이터 — 실제 네트워크 없음)
 * 변경 증분 추정(알려진 증분을 구간 안에서 되찾기 · 대조군 구성 · 표본 부족 · 관측 중 · dry_run · 롤백 제외 · 예산은 매체 단위) ·
 * 사고 손실 회피(시간 비율 · 테스트 제외 · 재오픈) · 자동화 절감(실행 기록 건수 × 건당 분 · 데모 제외) · 월간 요약 산식 · 설정 값 ·
 * 가치 리포트 · 예약 잡 · 권한 · 테넌트 격리 · 입력 검증 · 감사.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { _resetJobsForTest, drain, registerJob } from '../jobs/queue';
import { _resetSchedulesForTest, registerSchedule, runScheduleNow, scheduleContext } from '../jobs/scheduler';
import { setNowForTest } from '../lib/time';
import { rng } from '@/core/util';
import { automationSavings, businessDaysIn, datesBetween, type LedgerEntry, type LossEstimate, type UpliftEstimate } from '@/modules/impact/engine';
import { jobs as impactJobs } from './index';
import { jobs as reportJobs } from '../reports';
import { budgetCampaignOf, classifyApply, measureWorkspace } from './measure';

const kst = (date: string, h = 0, m = 0) => Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const TODAY = '2026-11-02';
const D = '2026-10-13'; // 반영일 (화)
const UPLIFT_REV = 300_000; // 하루 증분 매출 (반영 후 kw1)
const UPLIFT_COST = 60_000; // 하루 증분 광고비
const TRUE_REV = UPLIFT_REV * 7;
/** 고정 시드 합성 데이터 (결정적). 80% 구간의 포함률 자체는 src/modules/impact/engine.test.ts가 30개 시드로 검사한다 */
const SEED = Number(process.env.IMPACT_TEST_SEED ?? 19);

let t: TestApp;
let pm: TestClient, ae: TestClient, viewer: TestClient, client: TestClient;
let conn: string;
const W = (p: string) => `/api/w/${t.ws}${p}`;

async function insertKeywordDaily(rows: { date: string; kw: string; clicks: number; cost: number; conv: number; rev: number; imps?: number }[], source: string) {
  for (const r of rows) {
    await t.db.query(
      `INSERT INTO wh_keyword_daily (workspace_id, date, keyword_id, source, impressions, clicks, cost, conversions, revenue) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [t.ws, r.date, r.kw, source, r.imps ?? r.clicks * 20, r.clicks, r.cost, r.conv, r.rev],
    );
  }
}
async function insertEntity(type: 'keyword' | 'campaign', id: string, doc: Record<string, unknown>, source: string, channel: string) {
  await t.db.query(`INSERT INTO wh_entities (workspace_id, entity_type, external_id, source, channel, doc) VALUES ($1, $2, $3, $4, $5, $6)`, [t.ws, type, id, source, channel, JSON.stringify({ id, ...doc })]);
}
async function insertChange(id: string, o: {
  kind: 'bid' | 'budget' | 'status'; target: string; targetId: string; appliedAt: string; mode?: 'live' | 'dry_run' | 'none'; ok?: boolean; status?: string; rolledBackAt?: string; provider?: string;
  /** execution JSON을 직접 지정 (null = 실행 기록 JSON 없음 · 시도 기록만) */
  execution?: Record<string, unknown> | null;
  /** change_executions 시도 기록 (changes 도메인 executor가 남기는 형식) */
  attempts?: { attempt: string; phase: 'apply' | 'retry' | 'rollback' | 'compensate'; mode: 'live' | 'dry_run' | 'none'; ok: boolean; provider?: string }[];
}) {
  const exec = o.execution !== undefined ? o.execution
    : o.mode === undefined ? { mode: 'live', ok: true, at: o.appliedAt, provider: o.provider ?? 'naver_sa' } : { mode: o.mode, ok: o.ok ?? true, at: o.appliedAt, provider: o.provider ?? 'naver_sa' };
  await t.db.query(
    `INSERT INTO change_requests (id, workspace_id, module, kind, target, target_id, before, after, reason, requested_by, approver, status, history, execution, applied_at, rolled_back_at)
     VALUES ($1, $2, 'adpilot', $3, $4, $5, '700', '800', '테스트', '담당 AE', 'AE', $6, '[]', $7, $8, $9)`,
    [id, t.ws, o.kind, o.target, o.targetId, o.status ?? 'applied', exec === null ? null : JSON.stringify(exec), o.appliedAt, o.rolledBackAt ?? null],
  );
  for (const a of o.attempts ?? []) {
    await t.db.query(
      `INSERT INTO change_executions (workspace_id, change_id, attempt_id, phase, mode, ok, provider, target_external_id, actor, started_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '담당 AE', $9, $9)`,
      [t.ws, id, a.attempt, a.phase, a.mode, a.ok, a.provider ?? 'naver_sa', o.targetId, o.appliedAt],
    );
  }
}

/** 공통 일별 변동(f) · 반영 후 시장 +10%를 처리군 · 대조군이 같이 겪고, kw1에만 반영 후 증분을 더한다 */
async function seedSynthetic() {
  const r = rng(SEED);
  const dates = datesBetween('2026-10-01', '2026-10-31');
  const rows: Parameters<typeof insertKeywordDaily>[0] = [];
  const media: { date: string; media: string; cost: number; rev: number; clicks: number; conv: number }[] = [];
  for (const date of dates) {
    const f = r.noise(0.1);
    const shock = date > D ? 1.1 : 1;
    const after = date > D;
    const base = (b: number) => b * f * shock * r.noise(0.02);
    // kw1 처리군 (입찰 변경) — 클릭 100 · 전환 5/일
    rows.push({ date, kw: 'kw1', clicks: 100, conv: 5, cost: Math.round(base(500_000) + (after ? UPLIFT_COST : 0)), rev: Math.round(base(2_000_000) + (after ? UPLIFT_REV : 0)) });
    // 같은 광고그룹 대조군 kw2 · kw3(dry_run 변경 있음 → 제외) · kw4 · kw5
    for (const [kw, k] of [['kw2', 1], ['kw3', 0.8], ['kw4', 1.2], ['kw5', 0.9]] as const) {
      rows.push({ date, kw, clicks: Math.round(120 * k), conv: 6 * k, cost: Math.round(base(600_000 * k)), rev: Math.round(base(2_400_000 * k)) });
    }
    // 같은 광고그룹 kw7 — 같은 창에 live 상태 변경이 있어 대조군에서 빠진다 (난수를 쓰지 않아 다른 행의 값은 그대로)
    rows.push({ date, kw: 'kw7', clicks: 110, conv: 5.5, cost: Math.round(550_000 * f * shock), rev: Math.round(2_200_000 * f * shock) });
    // 저볼륨 kw6 (표본 부족)
    rows.push({ date, kw: 'kw6', clicks: 2, conv: 0.2, cost: 1_500, rev: 10_000 });
    for (const [m, k] of [['naver_sa', 3], ['naver_gfa', 1], ['google', 1.5], ['meta', 1.2], ['kakao', 0.6], ['vertical', 0.4]] as const) {
      const extra = m === 'naver_gfa' && after ? 400_000 : 0;
      media.push({ date, media: m, cost: Math.round(base(1_000_000 * k)), rev: Math.round(base(4_000_000 * k) + extra), clicks: Math.round(1500 * k), conv: Math.round(60 * k) });
    }
  }
  await insertKeywordDaily(rows, conn);
  for (const m of media) {
    await t.db.query(`INSERT INTO wh_media_daily (workspace_id, date, media, source, impressions, clicks, cost, conversions, revenue) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [t.ws, m.date, m.media, conn, m.clicks * 30, m.clicks, m.cost, m.conv, m.rev]);
  }
  // 데모 출처 행은 실데이터가 있으면 빠진다 (섞이면 추정이 틀어지도록 큰 값)
  await insertKeywordDaily(dates.map((date) => ({ date, kw: 'kw1', clicks: 9999, conv: 999, cost: 9e8, rev: 9e9 })), 'demo');
  for (const [kw, ag] of [['kw1', 'AG-1'], ['kw2', 'AG-1'], ['kw3', 'AG-1'], ['kw4', 'AG-1'], ['kw5', 'AG-1'], ['kw7', 'AG-1'], ['kw6', 'AG-2']] as const) {
    await insertEntity('keyword', kw, { text: `키워드 ${kw}`, intent: 'generic', adgroup: ag, isBrand: false, status: 'on', bid: 700, maxBid: 2000 }, conn, 'naver_sa');
  }
  await insertEntity('campaign', 'cmp-gfa-1', { media: 'naver_gfa', name: 'GFA 리타겟팅', dailyBudget: 500_000, status: 'on' }, conn, 'naver_gfa');
}

beforeAll(async () => {
  setNowForTest(kst(TODAY, 9, 0));
  t = await createTestApp({ config: { appUrl: 'https://os.mildo.test' } });
  _resetJobsForTest();
  _resetSchedulesForTest();
  const reg = { job: registerJob, schedule: registerSchedule };
  impactJobs(reg);
  reportJobs(reg);
  conn = (await t.db.query<{ id: string }>(`INSERT INTO connections (workspace_id, provider, kind, channel, label, status) VALUES ($1, 'naver_sa', 'media', 'naver_sa', '네이버 검색광고', 'active') RETURNING id`, [t.ws])).rows[0].id;
  await seedSynthetic();
  await insertChange('chg-bid-kw1', { kind: 'bid', target: '키워드 kw1', targetId: 'kw1', appliedAt: `${D}T10:00:00+09:00` });
  await insertChange('chg-bid-kw6', { kind: 'bid', target: '키워드 kw6', targetId: 'kw6', appliedAt: `${D}T10:00:00+09:00` });
  await insertChange('chg-bid-kw2-late', { kind: 'bid', target: '키워드 kw2', targetId: 'kw2', appliedAt: '2026-10-29T10:00:00+09:00' });
  await insertChange('chg-bid-kw3-dry', { kind: 'bid', target: '키워드 kw3', targetId: 'kw3', appliedAt: '2026-10-10T10:00:00+09:00', mode: 'dry_run' });
  await insertChange('chg-budget-gfa', { kind: 'budget', target: 'GFA 리타겟팅', targetId: 'gfa:budget:cmp-gfa-1', appliedAt: `${D}T11:00:00+09:00` });
  await insertChange('chg-bid-kw5-rb', { kind: 'bid', target: '키워드 kw5', targetId: 'kw5', appliedAt: '2026-10-02T10:00:00+09:00', status: 'rolled_back', rolledBackAt: '2026-10-04T10:00:00+09:00' });
  // 기록만(none) 반영 — 매체 미반영
  await insertChange('chg-bid-kw6-none', { kind: 'bid', target: '키워드 kw6', targetId: 'kw6', appliedAt: '2026-10-22T10:00:00+09:00', execution: { phase: 'apply', mode: 'none', ok: true, at: '2026-10-22T10:00:00+09:00', note: '매체 반영 대상 없음 — 기록만' } });
  // dry_run 반영 후 롤백: 현재 execution은 롤백 기록 → 직전 반영 기록(applyExecution)이 dry_run이라 '관측 중 롤백'이 아니라 매체 미반영
  await insertChange('chg-bid-kw4-rbdry', {
    kind: 'bid', target: '키워드 kw4', targetId: 'kw4', appliedAt: '2026-10-24T10:00:00+09:00', status: 'rolled_back', rolledBackAt: '2026-10-27T10:00:00+09:00',
    execution: { phase: 'rollback', mode: 'none', ok: true, at: '2026-10-27T10:00:00+09:00', applyExecution: { phase: 'apply', mode: 'dry_run', ok: true, at: '2026-10-24T10:00:00+09:00', provider: 'naver_sa' } },
  });
  // execution JSON 없이 시도 기록만 있는 live 상태 변경 (첫 시도 실패 → 재시도 성공) — kw7은 kw1 측정 창에 매체가 바뀌어 대조군에서 빠진다
  await insertChange('chg-status-kw7', {
    kind: 'status', target: '키워드 kw7', targetId: 'kw7', appliedAt: '2026-10-15T10:00:00+09:00', execution: null,
    attempts: [{ attempt: 'a1', phase: 'apply', mode: 'live', ok: false }, { attempt: 'a2', phase: 'retry', mode: 'live', ok: true }],
  });
  // 사고: 평일 14:00 발생 → 14:30 1차 조치 · 테스트 이슈 · 열린 이슈
  const inc = (id: string, o: { isTest?: boolean; status?: string; resolved?: boolean }) => t.db.query(
    `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at, resolved_at) VALUES ($1, $2, 'budget_exhaust', 'P1', $3, $4, '2026-10-13T14:05:00+09:00', $5)`,
    [id, t.ws, o.status ?? 'resolved', JSON.stringify({
      id, title: `예산 조기 소진 ${id}`, severity: 'P1', occurredAt: '2026-10-13T14:00:00+09:00', detectedAt: '2026-10-13T14:05:00+09:00', impact: { revenueLossEst: 1_000_000 },
      sla: { ackAt: '2026-10-13T14:12:00+09:00', actionAt: '2026-10-13T14:30:00+09:00', resolvedAt: '2026-10-13T15:00:00+09:00' }, isTest: !!o.isTest, source: 'scan', status: o.status ?? 'resolved', timeline: [],
    }), o.resolved === false ? null : '2026-10-13T15:00:00+09:00'],
  );
  await inc('inc-1', {});
  await inc('inc-test', { isTest: true });
  await inc('inc-open', { status: 'action', resolved: false });
  // 자동화 실행 기록 (10월): 영업일 07:00 자동 수집 · 예약 일간 리포트 5건 · 주간 2건 · 예약 감지
  const bdays = datesBetween('2026-10-01', '2026-10-31').filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && d !== '2026-10-05' && d !== '2026-10-09');
  for (const d of bdays) {
    await t.db.query(`INSERT INTO ingest_runs (workspace_id, connection_id, job, status, started_at, finished_at) VALUES ($1, $2, 'daily', 'succeeded', $3, $3)`, [t.ws, conn, `${d}T07:00:00+09:00`]);
  }
  for (const d of bdays.slice(0, 5)) {
    await t.db.query(`INSERT INTO reports (workspace_id, type, period_start, period_end, generated_at, title, markdown, trigger, data_mode) VALUES ($1, 'daily', $2, $2, $3, '일간', '-', 'schedule', 'live')`, [t.ws, d, `${d}T08:00:00+09:00`]);
  }
  for (const d of ['2026-10-12', '2026-10-19']) {
    await t.db.query(`INSERT INTO reports (workspace_id, type, period_start, period_end, generated_at, title, markdown, trigger, data_mode) VALUES ($1, 'weekly', $2, $2, $3, '주간', '-', 'schedule', 'live')`, [t.ws, d, `${d}T10:00:00+09:00`]);
  }
  // TEST DATA 리포트는 세지 않는다
  await t.db.query(`INSERT INTO reports (workspace_id, type, period_start, period_end, generated_at, title, markdown, trigger, data_mode) VALUES ($1, 'daily', '2026-10-20', '2026-10-20', '2026-10-20T08:00:00+09:00', '일간', '-', 'schedule', 'demo')`, [t.ws]);
  for (const d of bdays.slice(0, 10)) {
    await t.db.query(`INSERT INTO alert_scan_runs (workspace_id, trigger, status, data_mode, started_at) VALUES ($1, 'schedule', 'ok', 'live', $2)`, [t.ws, `${d}T09:10:00+09:00`]);
  }
  [pm, ae, viewer, client] = await Promise.all([t.login('pm'), t.login('ae'), t.login('viewer'), t.login('client')]);
}, 120_000);
afterAll(async () => {
  setNowForTest(null);
  await t?.close();
});

const ledger = async () => (await viewer.get(W('/impact/ledger'))).json.entries as LedgerEntry[];
const bySource = (es: LedgerEntry[], id: string) => es.find((e) => e.sourceId === id)!;

describe('impact.measure — 장부 측정', () => {
  it('예약 06:00 → impact.measure 잡 → 장부 (확정된 그저께까지만 사용)', async () => {
    setNowForTest(kst(TODAY, 6, 0));
    await runScheduleNow('impact.measure', scheduleContext(t.db, t.config));
    await runScheduleNow('impact.measure', scheduleContext(t.db, t.config));
    expect(Number((await t.db.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'impact.measure' AND workspace_id = $1`, [t.ws])).rows[0].n)).toBe(1);
    await drain(t.db, t.config, { types: ['impact.measure'] });
    const j = (await t.db.query<{ status: string; result: { changes: { measured: number } } }>(`SELECT status, result FROM jobs WHERE type = 'impact.measure'`)).rows[0];
    expect(j.status).toBe('done');
    expect(j.result.changes.measured).toBeGreaterThanOrEqual(2);
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'impact.measure' AND actor = 'system'`)).rowCount).toBe(1);
    setNowForTest(kst(TODAY, 9, 0));
  });

  it('입찰 변경: 대조군(같은 광고그룹 · 같은 기간 변경 없는 키워드) 보정으로 알려진 증분을 80% 구간 안에서 되찾는다', async () => {
    const e = bySource(await ledger(), 'chg-bid-kw1');
    expect(e.status).toBe('measured');
    expect(e.month).toBe('2026-10');
    const x = e.estimate as UpliftEstimate;
    expect(x.method).toBe('did_scaled');
    // kw7은 같은 창(반영 전 7일 ~ 후 7일)에 live 상태 변경이 있어 제외 · kw3의 변경은 dry_run(매체 미반영)이라 대조군에 남는다
    expect(e.control).toMatchObject({ basis: 'adgroup', units: 4 });
    expect([...e.control!.ids].sort()).toEqual(['kw2', 'kw3', 'kw4', 'kw5']);
    expect(x.ci[0]).toBeLessThanOrEqual(TRUE_REV);
    expect(x.ci[1]).toBeGreaterThanOrEqual(TRUE_REV);
    expect(Math.abs(x.revenue - TRUE_REV) / TRUE_REV).toBeLessThan(0.35);
    // 광고비 증분은 점추정이 진짜 값에서 표준오차 2.6배(약 99%) 안
    expect(Math.abs(x.cost - UPLIFT_COST * 7)).toBeLessThanOrEqual(2.6 * x.se.cost);
    // 데모 출처(9e9 매출)는 실데이터가 있어 섞이지 않았다
    expect(e.baseline!.revenue).toBeLessThan(30_000_000);
    expect(e.baseline).toMatchObject({ from: '2026-10-06', to: '2026-10-12', days: 7, clicks: 700 });
    expect(e.observed).toMatchObject({ from: '2026-10-14', to: '2026-10-20' });
    expect(e.detail).toMatchObject({ kind: 'bid', targetId: 'kw1', route: 'flow', mode: 'live', appliedAt: new Date(`${D}T10:00:00+09:00`).toISOString() });
    expect(e.occurredAt).toBe(new Date(`${D}T10:00:00+09:00`).toISOString());
    expect(x.assumptions.join(' ')).toContain('평행 추세');
  });

  it('표본 부족 · 관측 중 · dry_run · 롤백 · 사유 표시', async () => {
    const es = await ledger();
    const low = bySource(es, 'chg-bid-kw6');
    expect(low.status).toBe('insufficient');
    expect(low.detail.reasons).toEqual(expect.arrayContaining(['반영 전 7일 클릭 14 (기준 30 이상)', '반영 전 7일 전환 1.4 (기준 3 이상)']));
    const late = bySource(es, 'chg-bid-kw2-late');
    expect(late.status).toBe('pending');
    expect(late.detail.reason).toContain('2026-11-05');
    const dry = bySource(es, 'chg-bid-kw3-dry');
    expect(dry).toMatchObject({ status: 'excluded', estimate: null, detail: { exclusion: 'not_applied', mode: 'dry_run' } });
    expect(dry.detail.reason).toMatch(/^매체 미반영 — dry_run/);
    const none = bySource(es, 'chg-bid-kw6-none');
    expect(none).toMatchObject({ status: 'excluded', estimate: null, detail: { exclusion: 'not_applied', mode: 'none' } });
    expect(none.detail.reason).toMatch(/^매체 미반영 — 기록만/);
    const rbDry = bySource(es, 'chg-bid-kw4-rbdry');
    expect(rbDry).toMatchObject({ status: 'excluded', detail: { exclusion: 'not_applied', mode: 'dry_run', rolledBackAt: new Date('2026-10-27T10:00:00+09:00').toISOString() } });
    const rb = bySource(es, 'chg-bid-kw5-rb');
    expect(rb).toMatchObject({ status: 'excluded', detail: { exclusion: 'rolled_back', mode: 'live' } });
    expect(rb.detail.reason).toContain('롤백');
    // 상태 변경은 증분 추정 대상(입찰 · 예산)이 아니라 장부에 없다
    expect(es.find((x) => x.sourceId === 'chg-status-kw7')).toBeUndefined();
    // CSV · 상태 표기: '집계 제외 · 매체 미반영'
    const csv = (await viewer.get(W('/impact/ledger.csv?month=2026-10'))).body;
    expect(csv.split('\n').find((l: string) => l.includes('chg-bid-kw3-dry'))).toContain('집계 제외 · 매체 미반영');
  });

  it('반영 방식 판정: 마지막 반영 시도 기준 (재시도 성공 · 보상 · 실패 · dry_run · 기록만 · 기록 없음)', () => {
    const at = (attempt: string, phase: string, mode: 'live' | 'dry_run' | 'none', ok: boolean, provider: string | null = 'naver_sa') => ({ change_id: 'c', attempt_id: attempt, phase, mode, ok, provider });
    expect(classifyApply(null, [at('a1', 'apply', 'live', false), at('a2', 'retry', 'live', true, 'google_ads')])).toEqual({ kind: 'live', provider: 'google_ads', basis: 'executions' });
    expect(classifyApply(null, [at('a1', 'apply', 'live', true), at('a1', 'apply', 'live', false), at('a1', 'compensate', 'live', true)])).toMatchObject({ kind: 'failed' });
    expect(classifyApply({ mode: 'live', ok: true }, [at('a1', 'apply', 'dry_run', true)])).toMatchObject({ kind: 'dry_run', basis: 'executions' });
    expect(classifyApply(null, [at('a1', 'apply', 'none', true)])).toMatchObject({ kind: 'none' });
    // 롤백 시도는 반영 판정에 쓰지 않는다
    expect(classifyApply({ phase: 'rollback', mode: 'live', ok: true, applyExecution: { mode: 'live', ok: true, provider: 'meta' } }, [at('r1', 'rollback', 'live', true)])).toEqual({ kind: 'live', provider: 'meta', basis: 'execution' });
    expect(classifyApply({ mode: 'live', ok: false }, [])).toMatchObject({ kind: 'failed', basis: 'execution' });
    expect(classifyApply(null, [])).toEqual({ kind: 'unknown' });
  });

  it('예산 변경: 캠페인 → 매체(GFA) 단위, 대조군 = 다른 매체 · 신뢰도 낮음', async () => {
    expect(budgetCampaignOf('gfa:budget:cmp-gfa-1')).toBe('cmp-gfa-1');
    expect(budgetCampaignOf('budget:c1:c2')).toBe('c1');
    expect(budgetCampaignOf('flow:budget:c9')).toBe('c9');
    const e = bySource(await ledger(), 'chg-budget-gfa');
    expect(e.status).toBe('measured');
    const x = e.estimate as UpliftEstimate;
    expect(x.granularity).toBe('media');
    expect(x.confidence).toBe('low');
    expect(e.control).toMatchObject({ basis: 'media', units: 5 });
    expect(Math.abs(x.revenue - 400_000 * 7)).toBeLessThanOrEqual(2.6 * x.se.revenue);
    expect(x.confidenceBasis).toContain('매체 합계');
  });

  it('사고: 손실 회피 = 추정 손실 × (1 − 30분 ÷ 자연 발견 1,170분) · 테스트 이슈 제외 · 열린 이슈 없음', async () => {
    const es = (await viewer.get(W('/impact/ledger?type=incident'))).json.entries as LedgerEntry[];
    expect(es.every((e) => e.sourceType === 'incident')).toBe(true);
    const e = bySource(es, 'inc-1');
    expect(e.status).toBe('measured');
    const x = e.estimate as LossEstimate;
    expect(x.lossAvoided).toBe(Math.round(1_000_000 * (1 - 30 / 1170)));
    expect(x).toMatchObject({ minutesToAction: 30, minutesToNatural: 1170, actionBasis: 'actionAt', confidence: 'low' });
    expect(bySource(es, 'inc-test')).toMatchObject({ status: 'excluded', detail: { exclusion: 'test' } });
    expect(bySource(es, 'inc-test').detail.reason).toContain('TEST DATA');
    expect(es.find((x2) => x2.sourceId === 'inc-open')).toBeUndefined();
  });

  it('자동화: 실행 기록 건수 × 제안서 p.19 건당 분 (TEST DATA 리포트 · 데모 커넥션 제외)', async () => {
    const es = ((await viewer.get(W('/impact/ledger?type=automation&month=2026-10'))).json.entries as LedgerEntry[]);
    const by = Object.fromEntries(es.map((e) => [e.sourceId, e.estimate as { count: number; hours: number }]));
    expect(by['2026-10:ingest_days'].count).toBe(20);
    expect(by['2026-10:daily_reports'].count).toBe(5);
    expect(by['2026-10:weekly_reports'].count).toBe(2);
    expect(by['2026-10:detection_days'].count).toBe(10);
    // live 반영 성공 입찰 · 예산 · 상태: kw1 · kw6 · kw2-late · budget-gfa · kw5(롤백됐어도 실행은 됨) · kw7(시도 기록만 · 재시도 성공) = 6
    // dry_run · 기록만 · dry_run 후 롤백은 세지 않는다
    expect(by['2026-10:bid_budget_changes'].count).toBe(6);
    const expected = automationSavings({ ingest_days: 20, daily_reports: 5, weekly_reports: 2, bid_budget_changes: 6, keyword_changes: 0, detection_days: 10 }, businessDaysIn('2026-10'));
    expect(es.reduce((a, e) => a + (e.estimate as { hours: number }).hours, 0)).toBeCloseTo(expected.hours, 1);
  });

  it('확정 상태는 다시 계산하지 않고, 관측 중 · 다시 열린 이슈는 갱신된다', async () => {
    await t.db.query(`UPDATE incidents SET status = 'ack', resolved_at = NULL WHERE id = 'inc-1' AND workspace_id = $1`, [t.ws]);
    const r = await measureWorkspace(t.db, t.ws);
    expect(r.changes.skipped).toBe(7);
    expect(r.changes.pending).toBe(1);
    const e = bySource(await ledger(), 'inc-1');
    expect(e.status).toBe('pending');
    expect(e.detail.reason).toContain('다시 열린');
    await t.db.query(`UPDATE incidents SET status = 'resolved', resolved_at = '2026-10-13T15:00:00+09:00' WHERE id = 'inc-1' AND workspace_id = $1`, [t.ws]);
    await measureWorkspace(t.db, t.ws);
    expect(bySource(await ledger(), 'inc-1').status).toBe('measured');
  });
});

describe('GET /impact/summary — 회수 배수', () => {
  it('회수 배수 = (증분 이익 + 손실 회피 × 40% + 절감 시간 × 40,000원) ÷ 5,000,000원 · 구성 요소마다 방법 · 신뢰도 · 표본 · 전제', async () => {
    const r = await viewer.get(W('/impact/summary?month=2026-10'));
    expect(r.status).toBe(200);
    const s = r.json.summary;
    const es = (await ledger()).filter((e) => e.month === '2026-10');
    const ups = es.filter((e) => e.sourceType === 'change' && e.status === 'measured').map((e) => e.estimate as UpliftEstimate);
    expect(ups).toHaveLength(2);
    const loss = (bySource(es, 'inc-1').estimate as LossEstimate).lossAvoided;
    const hours = es.filter((e) => e.sourceType === 'automation').reduce((a, e) => a + (e.estimate as { hours: number }).hours, 0);
    // 측정 당시와 같은 공헌이익률(40%) → 건별 저장 이익의 합
    const profit = ups.reduce((a, u) => a + u.profit, 0);
    expect(s.totals.measuredUpliftRevenue.point).toBe(ups.reduce((a, u) => a + u.revenue, 0));
    expect(s.totals.measuredUpliftProfit.point).toBe(profit);
    expect(s.totals.lossAvoidedEst).toBe(loss);
    expect(s.totals.hoursSaved).toBeCloseTo(hours, 1);
    expect(s.totals.costOfSubscription).toBe(5_000_000);
    const value = profit + loss * 0.4 + s.totals.hoursSaved * 40_000;
    expect(s.totals.valueKrw.point).toBe(Math.round(value));
    expect(s.totals.paybackMultiple.point).toBe(Math.round((value / 5_000_000) * 100) / 100);
    expect(s.totals.paybackMultiple.lo).toBeLessThanOrEqual(s.totals.paybackMultiple.point);
    expect(s.totals.paybackMultiple.hi).toBeGreaterThanOrEqual(s.totals.paybackMultiple.point);
    expect(s.counts.change).toEqual({ measured: 2, insufficient: 1, pending: 1, excluded: 4 });
    expect(s.components[0].sample.note).toContain('매체 미반영(dry_run · 기록만) 3건');
    expect(s.config.sources).toEqual({ monthlyFee: 'default', margin: 'default', hourlyCost: 'default' });
    expect(s.dataMode).toBe('live');
    expect(s.formula).toContain('÷ 월 구독료');
    for (const c of s.components) {
      expect(c.method).toBeTruthy();
      expect(c.confidenceBasis).toBeTruthy();
      expect(c.assumptions.length).toBeGreaterThan(0);
      expect(c.sample).toHaveProperty('measured');
    }
    expect(s.counterExamples.length).toBeGreaterThan(3);
  });

  it('워크스페이스 설정(월 구독료 · 공헌이익률 · 시간당 인건비)을 쓰고 출처를 표시한다', async () => {
    await t.db.query(`UPDATE workspaces SET config = $2 WHERE id = $1`, [t.ws, JSON.stringify({ billing: { monthlyFee: 2_500_000 }, impact: { contributionMargin: 0.3, hourlyCost: 50_000 } })]);
    const s = (await viewer.get(W('/impact/summary?month=2026-10'))).json.summary;
    expect(s.totals.costOfSubscription).toBe(2_500_000);
    expect(s.config).toMatchObject({ margin: 0.3, hourlyCost: 50_000, sources: { monthlyFee: 'workspace', margin: 'workspace', hourlyCost: 'workspace' } });
    const ups = (await ledger()).filter((e) => e.month === '2026-10' && e.sourceType === 'change' && e.status === 'measured').map((e) => e.estimate as UpliftEstimate);
    // 공헌이익률이 바뀌면 같은 매출 · 광고비 추정에서 다시 계산하고, 합계를 낸 뒤 한 번만 반올림
    const profit = ups.reduce((a, u) => a + (u.revenue * 0.3 - u.cost), 0);
    expect(s.totals.measuredUpliftProfit.point).toBe(Math.round(profit));
    const value = profit + s.totals.lossAvoidedEst * 0.3 + s.totals.hoursSaved * 50_000;
    expect(s.totals.valueKrw.point).toBe(Math.round(value));
    expect(s.totals.paybackMultiple.point).toBe(Math.round((value / 2_500_000) * 100) / 100);
    await t.db.query(`UPDATE workspaces SET config = '{}' WHERE id = $1`, [t.ws]);
  });

  it('가치 리포트 (reports.type = value): 회수 배수 · 영역 구분 · LIVE 표기', async () => {
    const r = await pm.post(W('/reports/generate'), { type: 'value', month: '2026-10' });
    expect(r.status).toBe(201);
    const md: string = r.json.report.markdown;
    expect(md).toContain('# 월간 가치 리포트 · 2026년 10월');
    expect(md).toContain('연동 데이터 (LIVE)');
    for (const h of ['### 확정 팩트', '### 반복 관측 패턴', '### AI 해석', '### 전제 조건 · 기준값', '### 반례 · 대체 시나리오', '### 다음 액션']) expect(md).toContain(h);
    expect(md).toContain('키워드 kw1 입찰가');
    expect(r.json.report.messenger).toMatch(/^\[MILDO 가치\] 2026년 10월 회수 배수/);
    expect(r.json.report.doc.summary.totals.paybackMultiple.point).toBeTypeOf('number');
  });

  it('CSV 내보내기 · 이번 달 기본값 · 빈 달', async () => {
    const csv = await viewer.get(W('/impact/ledger.csv?month=2026-10'));
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.body).toContain('증분 매출');
    expect(csv.body).toContain('키워드 kw1');
    const cur = await viewer.get(W('/impact/summary'));
    expect(cur.json.summary.month).toBe('2026-11');
    const empty = await viewer.get(W('/impact/summary?month=2025-01'));
    expect(empty.json.summary.verdict.label).toBe('판정 보류');
  });
});

describe('권한 · 격리 · 검증', () => {
  it('읽기는 모든 멤버, 즉시 측정은 operate(AE 이상) · 감사 · 다른 워크스페이스 404 · 형식 오류 400', async () => {
    expect((await client.get(W('/impact/summary?month=2026-10'))).status).toBe(200);
    expect((await viewer.post(W('/impact/measure'), {})).status).toBe(403);
    expect((await client.post(W('/impact/measure'), {})).status).toBe(403);
    const m = await ae.post(W('/impact/measure'), { force: true });
    expect(m.status).toBe(200);
    expect(m.json.result.changes.measured).toBe(2);
    expect(m.json.summary.month).toBe('2026-11');
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'impact.measure' AND actor = '테스트 ae'`)).rowCount).toBe(1);
    expect((await ae.post(W('/impact/measure'), { force: 'yes' })).status).toBe(400);
    expect((await viewer.get(W('/impact/summary?month=2026-13'))).status).toBe(400);
    expect((await viewer.get(W('/impact/ledger?type=nope'))).status).toBe(400);
    expect((await t.anon().get(W('/impact/summary'))).status).toBe(401);
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-impact', '다른', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    expect((await pm.get(`/api/w/${other}/impact/summary`)).status).toBe(404);
    expect((await pm.get(`/api/w/${other}/impact/ledger`)).status).toBe(404);
    expect((await pm.post(`/api/w/${other}/impact/measure`, {})).status).toBe(404);
    // 멤버가 된 다른 워크스페이스에는 이 워크스페이스 장부가 보이지 않는다
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'pm')`, [other, t.userIds.pm]);
    expect((await pm.get(`/api/w/${other}/impact/ledger`)).json.entries).toEqual([]);
    expect((await pm.get(`/api/w/${other}/impact/summary?month=2026-10`)).json.summary.totals.measuredUpliftRevenue.point).toBe(0);
  });
});

describe('측정 규칙 보강 — TEST DATA 출처 · 수동 등록 이슈 · 재배분 대조군 · 워크스페이스 공휴일 · CSV 수식', () => {
  const summaryOct = async () => (await viewer.get(W('/impact/summary?month=2026-10'))).json.summary;

  it('live 반영이어도 측정 값이 TEST DATA(데모 출처)뿐이면 집계 제외 · 회수 배수에 더하지 않는다 · CSV 수식 주입 방지', async () => {
    const before = await summaryOct();
    // 같은 의도 · 광고그룹 이웃이 없는 키워드 — 웨어하우스 행은 데모 출처뿐
    await insertKeywordDaily(datesBetween('2026-10-01', '2026-10-31').map((date) => ({ date, kw: 'kw-demo', clicks: 300, conv: 20, cost: 300_000, rev: date > D ? 3_000_000 : 1_000_000 })), 'demo');
    await insertEntity('keyword', 'kw-demo', { text: '데모 키워드', intent: 'brand_only', adgroup: 'AG-DEMO', isBrand: true, status: 'on', bid: 500 }, conn, 'naver_sa');
    await insertChange('chg-bid-demo-src', { kind: 'bid', target: '=HYPERLINK("http://evil")', targetId: 'kw-demo', appliedAt: `${D}T10:00:00+09:00` });
    await measureWorkspace(t.db, t.ws);
    const e = bySource(await ledger(), 'chg-bid-demo-src');
    expect(e).toMatchObject({ status: 'excluded', detail: { exclusion: 'demo', test: true, mode: 'live' } });
    expect(e.detail.reason).toContain('TEST DATA');
    expect((e.estimate as UpliftEstimate).revenue).toBeGreaterThan(0); // 참고용 추정은 남는다
    const after = await summaryOct();
    expect(after.totals.measuredUpliftRevenue.point).toBe(before.totals.measuredUpliftRevenue.point);
    expect(after.counts.change.excluded).toBe(before.counts.change.excluded + 1);
    const line = ((await viewer.get(W('/impact/ledger.csv?month=2026-10'))).body as string).split('\n').find((l) => l.includes('chg-bid-demo-src'))!;
    expect(line).toContain(`,"'=HYPERLINK(""http://evil"")`);
    expect(line).toContain('집계 제외 · TEST DATA 반영');
  });

  it('사람이 화면에서 등록한 이슈(source client)는 손실 회피에서 제외 · 서버 감지 이슈만 더한다', async () => {
    const before = await summaryOct();
    await t.db.query(
      `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at, resolved_at) VALUES ('inc-manual', $1, 'manual', 'P1', 'resolved', $2, '2026-10-20T10:00:00+09:00', '2026-10-20T11:00:00+09:00')`,
      [t.ws, JSON.stringify({
        id: 'inc-manual', title: '수동 등록 이슈', severity: 'P1', occurredAt: '2026-10-17T00:00:00+09:00', detectedAt: '2026-10-20T10:00:00+09:00', impact: { revenueLossEst: 50_000_000 },
        sla: { ackAt: '2026-10-20T10:01:00+09:00', actionAt: '2026-10-20T10:02:00+09:00' }, isTest: false, source: 'client', status: 'resolved', timeline: [],
      })],
    );
    await measureWorkspace(t.db, t.ws);
    const e = bySource((await viewer.get(W('/impact/ledger?type=incident'))).json.entries, 'inc-manual');
    expect(e).toMatchObject({ status: 'excluded', estimate: null, detail: { exclusion: 'manual' } });
    const after = await summaryOct();
    expect(after.totals.lossAvoidedEst).toBe(before.totals.lossAvoidedEst);
    expect(after.counts.incident.excluded).toBe(before.counts.incident.excluded + 1);
  });

  it('예산 재배분(budget:<받는>:<주는>): 주는 캠페인의 매체는 대조군에서 뺀다', async () => {
    await insertEntity('campaign', 'cmp-meta-1', { media: 'meta', name: 'Meta 전환', dailyBudget: 300_000, status: 'on' }, conn, 'meta');
    await insertChange('chg-budget-realloc', { kind: 'budget', target: 'GFA ← Meta 재배분', targetId: 'budget:cmp-gfa-1:cmp-meta-1', appliedAt: `${D}T12:00:00+09:00` });
    await measureWorkspace(t.db, t.ws);
    const e = bySource(await ledger(), 'chg-budget-realloc');
    expect(e.control?.basis).toBe('media');
    expect(e.control?.ids).not.toContain('meta');
    expect(e.control?.ids).not.toContain('naver_gfa');
    expect(e.control?.units).toBe(4);
    expect(e.detail.reasons).toEqual(expect.arrayContaining(['재배분으로 예산이 준 매체(meta)는 대조군에서 뺌']));
  });

  it('워크스페이스 추가 공휴일은 자연 발견 시각 · 자동화 영업일에 반영된다', async () => {
    await t.db.query(`UPDATE workspaces SET config = $2 WHERE id = $1`, [t.ws, JSON.stringify({ holidays: { extra: { '2026-10-14': '창립기념일' } } })]);
    try {
      await measureWorkspace(t.db, t.ws);
      const es = await ledger();
      // 10/13(화) 14:00 발생 → 10/14가 휴무라 자연 발견은 10/15 09:30 (1,170분 + 1,440분)
      expect((bySource(es, 'inc-1').estimate as LossEstimate).minutesToNatural).toBe(1170 + 1440);
      // 10/14 07:00 수집 실행은 영업일이 아니어서 빠진다 (20 → 19)
      expect((bySource(es, '2026-10:ingest_days').estimate as { count: number }).count).toBe(19);
    } finally {
      await t.db.query(`UPDATE workspaces SET config = '{}' WHERE id = $1`, [t.ws]);
    }
    await measureWorkspace(t.db, t.ws);
    expect((bySource(await ledger(), 'inc-1').estimate as LossEstimate).minutesToNatural).toBe(1170);
  });
});
