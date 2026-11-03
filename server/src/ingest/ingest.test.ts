/**
 * 수집 파이프라인 · 잡 · 스케줄 · 품질 검사 · 수집 현황 API.
 * 가짜 커넥터(google_ads · naver_sa 자리)로 기간별 응답을 만들고, 잡 큐(drain)로 실제 처리 경로를 탄다. 네트워크 없음.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { setNowForTest, addDaysStr, dateRange } from '../lib/time';
import { runScheduleNow, scheduleContext, registeredSchedules } from '../jobs/scheduler';
import { registeredJobTypes } from '../jobs/queue';
import { drainIngest, installConnector, kst, registerDataJobsForTest } from './testkit';
import { chunkRange, backfillRange, brandTerms, dailyRange, dailyRangeFor, DAILY_RECOLLECT_DAYS } from './pipeline';
import { checkBatch } from './quality';
import type { DateRange, NormalizedBatch } from '../connectors/types';
import type { MediaId } from '@/core/types';

const TODAY = '2026-11-02'; // 월요일
let t: TestApp;
const restores: (() => void)[] = [];
const fetched: { provider: string; range: DateRange; intraday?: string }[] = [];
/** 가짜 응답을 바꿔 끼우는 훅 */
let googleBatch: (range: DateRange, intraday?: string) => NormalizedBatch | Promise<NormalizedBatch>;
let naverBatch: (range: DateRange) => NormalizedBatch;

const day = (date: string, media: MediaId, cost: number, extra: Partial<NonNullable<NormalizedBatch['mediaDaily']>[number]> = {}) =>
  ({ date, media, impressions: 10_000, clicks: 200, cost, conversions: 4, revenue: cost * 3, ...extra });

beforeAll(async () => {
  setNowForTest(kst(TODAY, 15, 20));
  registerDataJobsForTest();
  restores.push(installConnector('google_ads', {
    credentialsSchema: z.object({}).passthrough(), settingsSchema: z.object({}).passthrough(), credentialFields: [],
    capabilities: { reads: ['mediaDaily', 'mediaHourly', 'campaigns'], writes: [], intraday: true, maxBackfillDays: 90 },
    async test() { return { ok: true, message: 'ok' }; },
    async fetch(_ctx, range, opts) {
      fetched.push({ provider: 'google_ads', range, intraday: opts?.intradayDate });
      return googleBatch(range, opts?.intradayDate);
    },
  }));
  restores.push(installConnector('naver_sa', {
    credentialsSchema: z.object({}).passthrough(), settingsSchema: z.object({}).passthrough(), credentialFields: [],
    capabilities: { reads: ['mediaDaily', 'keywordDaily', 'keywords'], writes: [], intraday: false, maxBackfillDays: 400 },
    async test() { return { ok: true, message: 'ok' }; },
    async fetch(_ctx, range) {
      fetched.push({ provider: 'naver_sa', range });
      return naverBatch(range);
    },
  }));
  t = await createTestApp();
});
afterAll(async () => {
  setNowForTest(null);
  restores.forEach((r) => r());
  await t?.close();
});
beforeEach(() => {
  fetched.length = 0;
  googleBatch = (range) => ({ mediaDaily: dateRange(range.from, range.to).filter((d) => d < TODAY).map((d) => day(d, 'google', 500_000)) });
  naverBatch = (range) => ({ mediaDaily: dateRange(range.from, range.to).map((d) => day(d, 'naver_sa', 1_000_000)) });
});

const clients = new Map<string, Promise<TestClient>>();
const as = (role: 'owner' | 'pm' | 'ae' | 'viewer') => {
  if (!clients.has(role)) clients.set(role, t.login(role));
  return clients.get(role)!;
};
async function conn(provider: string, status = 'active', channel: string | null = null, ws = t.ws): Promise<string> {
  return (await t.db.query<{ id: string }>(
    `INSERT INTO connections (workspace_id, provider, kind, channel, label, status) VALUES ($1, $2, 'media', $3, $4, $5) RETURNING id`,
    [ws, provider, channel, `${provider} ${status}`, status],
  )).rows[0].id;
}
async function job(type: string, payload: Record<string, unknown>) {
  await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ($1, $2, $3)`, [type, t.ws, JSON.stringify(payload)]);
}
const runsOf = async (id: string) => (await t.db.query<{ job: string; status: string; range_from: string; range_to: string; rows_in: number; rows_written: number; issues: { code: string; severity: string }[]; error: string | null; source: string }>(
  'SELECT job, status, range_from, range_to, rows_in, rows_written, issues, error, source FROM ingest_runs WHERE connection_id = $1 ORDER BY started_at, range_from', [id],
)).rows;

describe('기간 계산', () => {
  it('daily = 어제 포함 3일, backfill = 31일 묶음 · 최대 백필 일수 상한', () => {
    expect(dailyRange(TODAY)).toEqual({ from: '2026-10-30', to: '2026-11-01' });
    expect(chunkRange({ from: '2026-08-01', to: '2026-10-15' }).map((r) => [r.from, r.to])).toEqual([['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-10-01'], ['2026-10-02', '2026-10-15']]);
    expect(backfillRange(TODAY, 90, { days: 400 })).toEqual({ from: addDaysStr(TODAY, -90), to: '2026-11-01' });
    expect(backfillRange(TODAY, 400, { days: 120 })).toEqual({ from: addDaysStr(TODAY, -120), to: '2026-11-01' });
    expect(backfillRange(TODAY, 400, { from: '2026-10-01', to: '2026-10-05' })).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(() => backfillRange(TODAY, 0, { days: 10 })).toThrow(/지원하지 않습니다/);
  });
});

describe('잡 등록 계약', () => {
  it('잡 타입 · 스케줄 이름 · cron이 명세(§6)와 같다', () => {
    expect(registeredJobTypes().sort()).toEqual(['ingest.backfill', 'ingest.daily', 'ingest.intraday', 'ingest.upload']);
    expect(registeredSchedules()).toEqual([{ name: 'ingest.daily', cron: '0 7 * * *' }, { name: 'ingest.intraday', cron: '10 * * * *' }]);
  });
});

describe('ingest.backfill · daily · intraday', () => {
  it('백필: 31일 묶음으로 나눠 수집 → 묶음마다 ingest_runs, 끝나면 intraday · alerts.scan 예약 · dataset 이벤트', async () => {
    const id = await conn('google_ads', 'active', 'google');
    googleBatch = (range, intraday) => intraday
      ? { mediaHourly: Array.from({ length: 15 }, (_, h) => ({ date: TODAY, hour: h, media: 'google' as const, impressions: 100, clicks: 2, cost: 2000, conversions: 0, revenue: 0 })), campaigns: [{ id: 'g1', media: 'google', name: 'G 검색', dailyBudget: 1_000_000, spentToday: 400_000, status: 'on', hourOfData: 15 }] }
      : { mediaDaily: dateRange(range.from, range.to).map((d) => day(d, 'google', 500_000)) };
    const events: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => events.push(e.type));
    await job('ingest.backfill', { connectionId: id, days: 70 });
    await drainIngest(t.db, t.config);
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.job, r.range_from, r.range_to, r.status])).toEqual([
      ['backfill', '2026-08-24', '2026-09-23', 'succeeded'],
      ['backfill', '2026-09-24', '2026-10-24', 'succeeded'],
      ['backfill', '2026-10-25', '2026-11-01', 'succeeded'],
      ['intraday', TODAY, TODAY, 'succeeded'],
    ]);
    expect(runs.slice(0, 3).reduce((a, r) => a + r.rows_written, 0)).toBe(70);
    expect(runs.every((r) => r.source === id)).toBe(true);
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [id])).rowCount).toBe(70);
    expect((await t.db.query('SELECT 1 FROM wh_media_hourly WHERE source = $1', [id])).rowCount).toBe(15);
    const scan = (await t.db.query<{ dedupe_key: string; status: string }>(`SELECT dedupe_key, status FROM jobs WHERE type = 'alerts.scan'`)).rows;
    expect(scan).toEqual([{ dedupe_key: `alerts.scan:${t.ws}`, status: 'queued' }]);
    for (let i = 0; i < 20 && !events.includes('dataset'); i++) await new Promise((r) => setTimeout(r, 50));
    off();
    expect(events).toEqual(expect.arrayContaining(['dataset', 'connection']));
    const c = (await t.db.query<{ status: string; last_sync_at: Date }>('SELECT status, last_sync_at FROM connections WHERE id = $1', [id])).rows[0];
    expect(c.status).toBe('active');
    expect(new Date(c.last_sync_at).toISOString()).toBe(new Date(kst(TODAY, 15, 20)).toISOString());
  });

  it('백필 일수는 커넥터 최대 보관 일수로 자른다 (google 90일)', async () => {
    const id = await conn('google_ads', 'active', 'google');
    await job('ingest.backfill', { connectionId: id, days: 400 });
    await drainIngest(t.db, t.config);
    const runs = (await runsOf(id)).filter((r) => r.job === 'backfill');
    expect(runs[0].range_from).toBe(addDaysStr(TODAY, -90));
    expect(runs[runs.length - 1].range_to).toBe('2026-11-01');
    expect(runs).toHaveLength(3);
  });

  it('daily: 어제 포함 3일을 다시 받아 덮어쓴다(멱등 · 늦은 전환 반영)', async () => {
    const id = await conn('google_ads', 'active', 'google');
    await job('ingest.daily', { connectionId: id });
    await drainIngest(t.db, t.config);
    googleBatch = (range) => ({ mediaDaily: dateRange(range.from, range.to).map((d) => day(d, 'google', 500_000, { conversions: 9 })) });
    await job('ingest.daily', { connectionId: id });
    await drainIngest(t.db, t.config);
    expect(fetched.map((f) => f.range)).toEqual([{ from: '2026-10-30', to: '2026-11-01' }, { from: '2026-10-30', to: '2026-11-01' }]);
    const rows = (await t.db.query<{ conversions: number }>('SELECT conversions FROM wh_media_daily WHERE source = $1 ORDER BY date', [id])).rows;
    expect(rows.map((r) => r.conversions)).toEqual([9, 9, 9]);
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.job, r.rows_in, r.rows_written])).toEqual([['daily', 3, 3], ['daily', 3, 3]]);
  });

  it('워크스페이스 전체 daily(connectionId 없음): 대상만 수집, CSV · 사용 중지 · 확인 전 · 당일 미지원은 건너뛴다', async () => {
    await t.db.query(`DELETE FROM connections WHERE workspace_id = $1`, [t.ws]);
    const g = await conn('google_ads', 'error', 'google');
    const n = await conn('naver_sa', 'active', 'naver_sa');
    await conn('naver_sa', 'pending', 'naver_sa');
    await conn('naver_sa', 'disabled', 'naver_sa');
    await conn('csv', 'active');
    await job('ingest.daily', {});
    await drainIngest(t.db, t.config);
    expect(fetched.map((f) => f.provider).sort()).toEqual(['google_ads', 'naver_sa']);
    expect((await t.db.query<{ status: string }>('SELECT status FROM connections WHERE id = $1', [g])).rows[0].status).toBe('active'); // 오류 → 성공하면 회복
    fetched.length = 0;
    await job('ingest.intraday', {});
    await drainIngest(t.db, t.config);
    expect(fetched.map((f) => [f.provider, f.intraday])).toEqual([['google_ads', TODAY]]);
    void n;
  });

  it('수집 실패: ingest_runs failed · 커넥션 error · 비밀값 가림 · 잡은 재시도 대기', async () => {
    const id = await conn('google_ads', 'active', 'google');
    googleBatch = () => { throw new Error('API 오류: access_token=ya29.SECRETSECRET 만료'); };
    await job('ingest.daily', { connectionId: id });
    await drainIngest(t.db, t.config);
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/access_token=••••/);
    expect(runs[0].error).not.toContain('SECRET');
    const c = (await t.db.query<{ status: string; last_error: string }>('SELECT status, last_error FROM connections WHERE id = $1', [id])).rows[0];
    expect(c.status).toBe('error');
    expect(c.last_error).not.toContain('SECRET');
    const j = (await t.db.query<{ status: string; attempts: number; last_error: string }>(`SELECT status, attempts, last_error FROM jobs WHERE type = 'ingest.daily' AND payload->>'connectionId' = $1`, [id])).rows[0];
    expect(j).toMatchObject({ status: 'queued', attempts: 1 });
    expect(j.last_error).not.toContain('SECRET');
  });

  it('수집 중(매체 호출 동안) 커넥션이 삭제되면 결과를 쓰지 않고(고아 행 없음) 잡은 재시도 없이 끝난다', async () => {
    const id = await conn('google_ads', 'active', 'google');
    googleBatch = async (range) => {
      // 매체 API 응답을 기다리는 사이 다른 사용자가 커넥션을 삭제한 상황
      await t.db.query('DELETE FROM connections WHERE id = $1', [id]);
      return { mediaDaily: dateRange(range.from, range.to).map((d) => day(d, 'google', 500_000)) };
    };
    await job('ingest.backfill', { connectionId: id, days: 70 });
    await drainIngest(t.db, t.config);
    expect(fetched).toHaveLength(1); // 첫 묶음에서 멈춘다
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [id])).rowCount).toBe(0);
    const j = (await t.db.query<{ status: string; attempts: number; result: { runs: { status: string }[] } }>(`SELECT status, attempts, result FROM jobs WHERE type = 'ingest.backfill' AND payload->>'connectionId' = $1`, [id])).rows[0];
    expect(j).toMatchObject({ status: 'done', attempts: 1 });
    expect(j.result.runs).toHaveLength(1);
  });

  it('같은 커넥션의 수집 두 개가 동시에 돌아도 쓰기가 하나씩 처리돼 둘 다 성공한다 (행 잠금)', async () => {
    const id = await conn('google_ads', 'active', 'google');
    const row = (await t.db.query<import('../connectors/service').ConnectionRow>('SELECT * FROM connections WHERE id = $1', [id])).rows[0];
    const { ingestConnection } = await import('./pipeline');
    googleBatch = (range) => ({
      mediaDaily: dateRange(range.from, range.to).map((d) => day(d, 'google', 500_000)),
      campaigns: [{ id: 'g-c1', media: 'google', name: 'G 검색', dailyBudget: 1_000_000, spentToday: 0, status: 'on', hourOfData: 15 }],
    });
    const runs = await Promise.all([
      ingestConnection(t.db, t.config, row, { job: 'daily', range: { from: '2026-10-30', to: '2026-11-01' } }),
      ingestConnection(t.db, t.config, row, { job: 'backfill', range: { from: '2026-10-20', to: '2026-11-01' } }),
    ]);
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [id])).rowCount).toBe(13);
    expect((await t.db.query(`SELECT 1 FROM wh_entities WHERE source = $1 AND entity_type = 'campaign'`, [id])).rowCount).toBe(1);
  });

  it('삭제된 커넥션의 잡은 오류 없이 끝난다', async () => {
    await job('ingest.backfill', { connectionId: '00000000-0000-4000-8000-000000000000', days: 10 });
    await job('ingest.daily', { connectionId: '00000000-0000-4000-8000-000000000000' });
    await drainIngest(t.db, t.config);
    const done = (await t.db.query<{ status: string }>(`SELECT status FROM jobs WHERE payload->>'connectionId' = '00000000-0000-4000-8000-000000000000'`)).rows;
    expect(done.map((d) => d.status)).toEqual(['done', 'done']);
  });
});

describe('스케줄', () => {
  it('07:00 daily · 매시 10분 intraday: 활성 워크스페이스의 대상 커넥션마다 하나, 같은 날 · 같은 시각 중복 없음', async () => {
    await t.db.query(`DELETE FROM jobs`);
    await t.db.query(`DELETE FROM connections WHERE workspace_id = $1`, [t.ws]);
    const g = await conn('google_ads', 'active', 'google');
    const n = await conn('naver_sa', 'error', 'naver_sa');
    await conn('naver_sa', 'pending', 'naver_sa');
    await conn('csv', 'active');
    const susp = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name, status) VALUES ($1, 'suspended-ws', '정지', '정지', 'suspended') RETURNING id`, [t.orgId])).rows[0].id;
    await conn('google_ads', 'active', 'google', susp);
    const sctx = scheduleContext(t.db, t.config);
    await runScheduleNow('ingest.daily', sctx);
    await runScheduleNow('ingest.daily', sctx);
    const daily = (await t.db.query<{ cid: string; dedupe_key: string }>(`SELECT payload->>'connectionId' AS cid, dedupe_key FROM jobs WHERE type = 'ingest.daily' ORDER BY dedupe_key`)).rows;
    expect(daily.map((d) => d.cid).sort()).toEqual([g, n].sort());
    expect(daily.map((d) => d.dedupe_key)).toEqual(expect.arrayContaining([`ingest.daily:${g}:${TODAY}`]));
    await runScheduleNow('ingest.intraday', sctx);
    const intra = (await t.db.query<{ cid: string; dedupe_key: string }>(`SELECT payload->>'connectionId' AS cid, dedupe_key FROM jobs WHERE type = 'ingest.intraday'`)).rows;
    expect(intra).toEqual([{ cid: g, dedupe_key: `ingest.intraday:${g}:${TODAY}T15` }]);
  });
});

describe('데이터 품질 검사', () => {
  it('음수 · 형식 오류 · 미래 날짜는 제외(partial), 중복 키 · 클릭>노출 · 전환>클릭 · 비용 0 · 누락 날짜는 경고', async () => {
    const id = await conn('google_ads', 'active', 'google');
    googleBatch = () => ({
      mediaDaily: [
        day('2026-10-30', 'google', 500_000),                     // 중복 키 (마지막 값 사용)
        day('2026-10-30', 'google', 510_000, { clicks: 20_000 }), // 클릭 > 노출
        day('2026-11-01', 'google', 0, { clicks: 50, conversions: 80 }), // 비용 0 · 전환 > 클릭
        day('2026-10-31', 'google', -5),                          // 음수 → 제외 (10-31 누락으로도 잡힘)
        day('2026-11-05', 'google', 1),                           // 미래
        { ...day('2026-10-30', 'google', 1), media: 'tiktok' as MediaId }, // 알 수 없는 매체
        day('2026-09-01', 'google', 1),                           // 요청 기간 밖
      ],
    });
    await job('ingest.daily', { connectionId: id });
    await drainIngest(t.db, t.config);
    const [run] = await runsOf(id);
    expect(run.status).toBe('partial');
    expect(run.rows_in).toBe(7);
    expect(run.rows_written).toBe(2);
    const codes = Object.fromEntries(run.issues.map((i) => [i.code, i.severity]));
    expect(codes).toMatchObject({
      negative_values: 'error', future_dates: 'error', invalid_rows: 'error', out_of_range: 'info', duplicate_keys: 'warning',
      clicks_gt_impressions: 'warning', conversions_gt_clicks: 'warning', zero_cost_with_clicks: 'warning', missing_dates: 'warning',
    });
    const cost = (await t.db.query<{ cost: number }>(`SELECT cost FROM wh_media_daily WHERE source = $1 AND date = '2026-10-30'`, [id])).rows[0].cost;
    expect(cost).toBe(510_000);
  });

  it('같은 요일 평균 대비 ±80% 급변 · 네이버 SA 키워드 합계와 매체 합계 차이(10% 초과) 경고', async () => {
    const id = await conn('naver_sa', 'active', 'naver_sa');
    naverBatch = (range) => ({
      mediaDaily: dateRange(range.from, range.to).map((d) => day(d, 'naver_sa', d === '2026-10-26' ? 3_000_000 : 1_000_000)),
      keywords: [{ id: 'k1', text: '퀸 매트리스', intent: 'generic', adgroup: 'G', isBrand: false, bid: 1000, maxBid: 1600, avgRank: 3, monthlySearch: 0, impressionShareLost: 0, status: 'on', landing: '' }],
      keywordDaily: dateRange(range.from, range.to).map((d) => ({ date: d, keywordId: 'k1', impressions: 100, clicks: 10, cost: d === '2026-10-20' ? 700_000 : 990_000, conversions: 1, revenue: 1 })),
    });
    await job('ingest.backfill', { connectionId: id, from: '2026-09-28', to: '2026-10-27' });
    await drainIngest(t.db, t.config);
    const issues = (await runsOf(id)).flatMap((r) => r.issues) as { code: string; severity: string; detail: { items: { date: string }[] } }[];
    const jump = issues.find((i) => i.code === 'day_jump')!;
    expect(jump.severity).toBe('warning');
    expect(jump.detail.items.map((x) => x.date)).toEqual(['2026-10-26', '2026-10-26']); // 광고비 · 매출
    const mm = issues.find((i) => i.code === 'keyword_media_mismatch')!;
    expect(mm.severity).toBe('warning');
    expect(mm.detail.items.map((x) => x.date)).toEqual(['2026-10-20', '2026-10-26']);
  });

  it('당일 수집: 지난 시간대 중 빠진 시간 경고', () => {
    const r = checkBatch({ mediaHourly: [0, 1, 2, 5].map((h) => ({ date: TODAY, hour: h, media: 'meta' as const, impressions: 1, clicks: 0, cost: 1, conversions: 0, revenue: 0 })) },
      { range: { from: TODAY, to: TODAY }, job: 'intraday', today: TODAY, hour: 7, provider: 'meta', channel: 'meta' });
    expect(r.issues.find((i) => i.code === 'missing_hours')).toMatchObject({ severity: 'warning', detail: { hours: [3, 4, 6] } });
    const demo = checkBatch({ mediaDaily: [day('2026-10-30', 'naver_sa', 1000)], keywordDaily: [{ date: '2026-10-30', keywordId: 'k', impressions: 1, clicks: 1, cost: 10, conversions: 0, revenue: 0 }] },
      { range: { from: '2026-10-30', to: '2026-10-30' }, job: 'daily', today: TODAY, hour: 7, provider: 'demo', channel: null });
    expect(demo.issues.find((i) => i.code === 'keyword_media_mismatch')!.severity).toBe('info');
  });
});

describe('GET /ingest/runs · /ingest/quality', () => {
  it('읽기 권한이면 누구나, 필터 · 페이지, 품질 요약(오류 · 경고 · 지연), 다른 워크스페이스 404', async () => {
    const viewer = await as('viewer');
    const all = await viewer.get(`/api/w/${t.ws}/ingest/runs?limit=3`);
    expect(all.status).toBe(200);
    expect(all.json.runs).toHaveLength(3);
    expect(all.json.nextBefore).toBeTruthy();
    expect(all.json.runs[0]).toHaveProperty('issueCounts');
    const failed = await viewer.get(`/api/w/${t.ws}/ingest/runs?status=failed`);
    expect(failed.json.runs.every((r: { status: string }) => r.status === 'failed')).toBe(true);
    expect((await viewer.get(`/api/w/${t.ws}/ingest/runs?status=nope`)).status).toBe(400);
    const stale = await conn('google_ads', 'active', 'google');
    await t.db.query(`UPDATE connections SET last_sync_at = $2 WHERE id = $1`, [stale, new Date(kst(TODAY, 15, 20) - 30 * 3600_000).toISOString()]);
    const q = await viewer.get(`/api/w/${t.ws}/ingest/quality`);
    expect(q.status).toBe(200);
    const codes = (q.json.issues as { code: string; connectionId: string }[]).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['negative_values', 'stale_connection', 'stale_data']));
    expect(q.json.summary.error).toBeGreaterThan(0);
    expect(q.json.summary.warning).toBeGreaterThan(0);
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-ing', '다른', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    expect((await viewer.get(`/api/w/${other}/ingest/runs`)).status).toBe(404);
    expect((await viewer.get(`/api/w/${other}/ingest/quality`)).status).toBe(404);
    expect((await t.anon().get(`/api/w/${t.ws}/ingest/runs`)).status).toBe(401);
  });
});

describe('판매 채널 재수집 기간 · 백필 자격증명 회전 · 브랜드 판정어', () => {
  const sales: { provider: string; range: DateRange; intraday?: string; token?: string }[] = [];
  const salesRow = (date: string, channel: 'coupang' | 'own_mall') => ({ date, channel, visitors: 0, detailViews: 0, carts: 0, orders: 3, revenue: 300_000, adAttributedRevenue: 0 });
  beforeAll(() => {
    restores.push(installConnector('coupang', {
      credentialsSchema: z.object({}).passthrough(), settingsSchema: z.object({}).passthrough(), credentialFields: [],
      capabilities: { reads: ['salesDaily'], writes: [], intraday: false, maxBackfillDays: 400 },
      async test() { return { ok: true, message: 'ok' }; },
      async fetch(_ctx, range) {
        sales.push({ provider: 'coupang', range });
        return { salesDaily: dateRange(range.from, range.to).map((d) => salesRow(d, 'coupang')) };
      },
    }));
    // OAuth 갱신 토큰 회전: 호출마다 받은 토큰의 다음 번호를 저장한다(카페24 · 네이버처럼 이전 토큰은 폐기)
    restores.push(installConnector('cafe24', {
      credentialsSchema: z.object({ refreshToken: z.string() }).passthrough(), settingsSchema: z.object({}).passthrough(), credentialFields: [],
      capabilities: { reads: ['salesDaily'], writes: [], intraday: true, maxBackfillDays: 400 },
      async test() { return { ok: true, message: 'ok' }; },
      async fetch(ctx, range, opts) {
        const token = String(ctx.credentials.refreshToken);
        sales.push({ provider: 'cafe24', range, intraday: opts?.intradayDate, token });
        await ctx.saveCredentials!({ ...ctx.credentials, refreshToken: `rt-${Number(token.split('-').pop()) + 1}` });
        return opts?.intradayDate ? {} : { salesDaily: dateRange(range.from, range.to).map((d) => salesRow(d, 'own_mall')) };
      },
    }));
  });
  beforeEach(() => { sales.length = 0; });
  async function salesConn(provider: 'coupang' | 'cafe24', channel: string, creds?: Record<string, unknown>): Promise<string> {
    const { encryptCredentials } = await import('../connectors/credentials');
    return (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, credentials_enc) VALUES ($1, $2, 'sales', $3, $4, 'active', $5) RETURNING id`,
      [t.ws, provider, channel, `${provider} 판매`, creds ? encryptCredentials(creds, t.config.encryptionKey) : null],
    )).rows[0].id;
  }

  it('daily 재수집: 판매 채널(def.kind sales)은 어제 포함 14일(늦은 취소 · 반품), 매체는 3일 그대로', async () => {
    expect(dailyRangeFor({ kind: 'sales' }, TODAY)).toEqual({ from: '2026-10-19', to: '2026-11-01' });
    expect(dailyRangeFor({ kind: 'media' }, TODAY)).toEqual({ from: '2026-10-30', to: '2026-11-01' });
    expect(dailyRangeFor(null, TODAY)).toEqual(dailyRange(TODAY));
    expect(DAILY_RECOLLECT_DAYS).toEqual({ media: 3, sales: 14 });
    await t.db.query(`DELETE FROM connections WHERE workspace_id = $1`, [t.ws]);
    const cp = await salesConn('coupang', 'coupang');
    const g = await conn('google_ads', 'active', 'google');
    // 커넥션 하나 (수동 수집 · 연결 직후와 같은 잡)
    await job('ingest.daily', { connectionId: cp, trigger: 'manual' });
    await drainIngest(t.db, t.config);
    expect(sales.map((f) => f.range)).toEqual([{ from: '2026-10-19', to: '2026-11-01' }]);
    expect((await t.db.query('SELECT 1 FROM wh_sales_daily WHERE source = $1', [cp])).rowCount).toBe(14);
    // 워크스페이스 전체 예약 daily: 커넥터 종류마다 기간이 다르다
    sales.length = 0;
    fetched.length = 0;
    await job('ingest.daily', {});
    await drainIngest(t.db, t.config);
    expect(sales.map((f) => f.range)).toEqual([{ from: '2026-10-19', to: '2026-11-01' }]);
    expect(fetched.filter((f) => f.provider === 'google_ads').map((f) => f.range)).toEqual([{ from: '2026-10-30', to: '2026-11-01' }]);
    expect((await runsOf(cp)).map((r) => [r.job, r.range_from, r.range_to])).toEqual([['daily', '2026-10-19', '2026-11-01'], ['daily', '2026-10-19', '2026-11-01']]);
    expect((await runsOf(g)).map((r) => [r.job, r.range_from])).toEqual([['daily', '2026-10-30']]);
  });

  it('백필: 묶음마다 · 끝의 intraday 전에 커넥션 행을 다시 읽어 앞 묶음이 회전 저장한 자격증명으로 이어 간다', async () => {
    const id = await salesConn('cafe24', 'own_mall', { refreshToken: 'rt-0' });
    await job('ingest.backfill', { connectionId: id, days: 70 });
    await drainIngest(t.db, t.config);
    expect(sales.map((f) => [f.intraday ? 'intraday' : 'backfill', f.range.from, f.token])).toEqual([
      ['backfill', '2026-08-24', 'rt-0'],
      ['backfill', '2026-09-24', 'rt-1'],
      ['backfill', '2026-10-25', 'rt-2'],
      ['intraday', TODAY, 'rt-3'],
    ]);
    const { decryptCredentials } = await import('../connectors/credentials');
    const row = (await t.db.query<{ credentials_enc: string }>('SELECT credentials_enc FROM connections WHERE id = $1', [id])).rows[0];
    expect(decryptCredentials(row.credentials_enc, t.config.encryptionKey)).toEqual({ refreshToken: 'rt-4' });
    expect((await runsOf(id)).every((r) => r.status === 'succeeded')).toBe(true);
  });

  it('브랜드 판정어: 워크스페이스 brand_name + 설정 brand.name(비어 있지 않은 문자열만) + brandKeywords', async () => {
    const ws = (await t.db.query<{ id: string }>(
      `INSERT INTO workspaces (org_id, slug, name, brand_name, config) VALUES ($1, 'brand-terms', '브랜드', '수면밀도', $2) RETURNING id`,
      [t.orgId, JSON.stringify({ brand: { name: ' 슬립밀도 ' }, brandKeywords: ['sumyeon', ' ', 3] })],
    )).rows[0].id;
    expect((await brandTerms(t.db, ws)).sort()).toEqual(['sumyeon', '수면밀도', '슬립밀도'].sort());
    for (const name of ['', '   ', 123, null]) {
      await t.db.query(`UPDATE workspaces SET config = $2 WHERE id = $1`, [ws, JSON.stringify({ brand: { name } })]);
      expect(await brandTerms(t.db, ws), String(name)).toEqual(['수면밀도']);
    }
  });

  it('엔티티 목록이 전부 형식 오류(id 없음)면 빈 스냅샷으로 넘기지 않는다 (기존 상품 · 프로모션을 지우지 않게)', () => {
    const base = { range: { from: '2026-11-01', to: '2026-11-01' }, job: 'daily' as const, today: TODAY, hour: 7, provider: 'cafe24', channel: 'own_mall' };
    const bad = checkBatch({ products: [{ name: 'id 없음' } as never], promotions: [] }, base);
    expect(bad.batch.products).toBeUndefined();
    expect(bad.issues.map((i) => i.code)).toContain('invalid_entities');
    expect(bad.batch.promotions).toEqual([]); // 진짜 빈 목록은 그대로 (= 전부 사라짐)
    expect(checkBatch({}, base).batch.products).toBeUndefined();
  });
});
