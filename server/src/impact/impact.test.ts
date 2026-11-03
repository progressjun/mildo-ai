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
import { budgetCampaignOf, measureWorkspace } from './measure';

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
async function insertChange(id: string, o: { kind: 'bid' | 'budget'; target: string; targetId: string; appliedAt: string; mode?: 'live' | 'dry_run' | 'none'; ok?: boolean; status?: string; rolledBackAt?: string; provider?: string }) {
  const exec = o.mode === undefined ? { mode: 'live', ok: true, at: o.appliedAt, provider: o.provider ?? 'naver_sa' } : { mode: o.mode, ok: o.ok ?? true, at: o.appliedAt, provider: o.provider ?? 'naver_sa' };
  await t.db.query(
    `INSERT INTO change_requests (id, workspace_id, module, kind, target, target_id, before, after, reason, requested_by, approver, status, history, execution, applied_at, rolled_back_at)
     VALUES ($1, $2, 'adpilot', $3, $4, $5, '700', '800', '테스트', '담당 AE', 'AE', $6, '[]', $7, $8, $9)`,
    [id, t.ws, o.kind, o.target, o.targetId, o.status ?? 'applied', JSON.stringify(exec), o.appliedAt, o.rolledBackAt ?? null],
  );
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
  for (const [kw, ag] of [['kw1', 'AG-1'], ['kw2', 'AG-1'], ['kw3', 'AG-1'], ['kw4', 'AG-1'], ['kw5', 'AG-1'], ['kw6', 'AG-2']] as const) {
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
    expect(e.control).toMatchObject({ basis: 'adgroup', units: 3 });
    expect([...e.control!.ids].sort()).toEqual(['kw2', 'kw4', 'kw5']); // kw3는 같은 창에 (dry_run) 변경이 있어 제외
    expect(x.ci[0]).toBeLessThanOrEqual(TRUE_REV);
    expect(x.ci[1]).toBeGreaterThanOrEqual(TRUE_REV);
    expect(Math.abs(x.revenue - TRUE_REV) / TRUE_REV).toBeLessThan(0.35);
    // 광고비 증분은 점추정이 진짜 값에서 표준오차 2.6배(약 99%) 안
    expect(Math.abs(x.cost - UPLIFT_COST * 7)).toBeLessThanOrEqual(2.6 * x.se.cost);
    // 데모 출처(9e9 매출)는 실데이터가 있어 섞이지 않았다
    expect(e.baseline!.revenue).toBeLessThan(30_000_000);
    expect(e.baseline).toMatchObject({ from: '2026-10-06', to: '2026-10-12', days: 7, clicks: 700 });
    expect(e.observed).toMatchObject({ from: '2026-10-14', to: '2026-10-20' });
    expect(e.detail).toMatchObject({ kind: 'bid', targetId: 'kw1', route: 'flow', mode: 'live' });
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
    expect(dry.status).toBe('excluded');
    expect(dry.detail.reason).toContain('dry_run');
    const rb = bySource(es, 'chg-bid-kw5-rb');
    expect(rb.status).toBe('excluded');
    expect(rb.detail.reason).toContain('롤백');
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
    expect(bySource(es, 'inc-test')).toMatchObject({ status: 'excluded' });
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
    // live 반영 성공 입찰 · 예산: kw1 · kw6 · kw2-late · budget-gfa · kw5(롤백됐어도 실행은 됨) = 5, dry_run 제외
    expect(by['2026-10:bid_budget_changes'].count).toBe(5);
    const expected = automationSavings({ ingest_days: 20, daily_reports: 5, weekly_reports: 2, bid_budget_changes: 5, keyword_changes: 0, detection_days: 10 }, businessDaysIn('2026-10'));
    expect(es.reduce((a, e) => a + (e.estimate as { hours: number }).hours, 0)).toBeCloseTo(expected.hours, 1);
  });

  it('확정 상태는 다시 계산하지 않고, 관측 중 · 다시 열린 이슈는 갱신된다', async () => {
    await t.db.query(`UPDATE incidents SET status = 'ack', resolved_at = NULL WHERE id = 'inc-1' AND workspace_id = $1`, [t.ws]);
    const r = await measureWorkspace(t.db, t.ws);
    expect(r.changes.skipped).toBe(5);
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
    const profit = ups.reduce((a, u) => a + Math.round(u.revenue * 0.4 - u.cost), 0);
    expect(s.totals.measuredUpliftRevenue.point).toBe(ups.reduce((a, u) => a + u.revenue, 0));
    expect(s.totals.measuredUpliftProfit.point).toBe(profit);
    expect(s.totals.lossAvoidedEst).toBe(loss);
    expect(s.totals.hoursSaved).toBeCloseTo(hours, 1);
    expect(s.totals.costOfSubscription).toBe(5_000_000);
    expect(s.totals.paybackMultiple.point).toBeCloseTo((profit + loss * 0.4 + s.totals.hoursSaved * 40_000) / 5_000_000, 2);
    expect(s.totals.paybackMultiple.lo).toBeLessThanOrEqual(s.totals.paybackMultiple.point);
    expect(s.totals.paybackMultiple.hi).toBeGreaterThanOrEqual(s.totals.paybackMultiple.point);
    expect(s.counts.change).toEqual({ measured: 2, insufficient: 1, pending: 1, excluded: 2 });
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
    const profit = ups.reduce((a, u) => a + Math.round(u.revenue * 0.3 - u.cost), 0);
    expect(s.totals.measuredUpliftProfit.point).toBe(profit);
    expect(s.totals.paybackMultiple.point).toBeCloseTo((profit + s.totals.lossAvoidedEst * 0.3 + s.totals.hoursSaved * 50_000) / 2_500_000, 2);
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
