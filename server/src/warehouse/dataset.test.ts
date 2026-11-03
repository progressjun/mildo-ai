/**
 * Dataset 빌더: 데모 커넥터 백필 → 웨어하우스 → buildDataset이 프런트 Dataset 형태와 같고 기존 엔진(이상 감지 · 입찰 제안)이 그대로 돈다.
 * 출처 우선순위(api > csv > demo, 데모는 실데이터와 섞지 않음) · 메타 · GET /api/w/:ws/dataset 권한 · 테넌트 격리.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test/app';
import { setNowForTest } from '../lib/time';
import { buildDataset } from './dataset';
import { writeBatch } from './write';
import { drainIngest, kst, registerDataJobsForTest } from '../ingest/testkit';
import { generateDemoData, DEMO_TODAY } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import { generateBidProposals } from '@/modules/adpilot/engine';
import type { Dataset } from '@/core/types';

const proposalsRun = (d: Dataset) => { generateBidProposals(d); detectIncidents(d); return true; };

let t: TestApp;
let ds: Dataset;
const DEMO = generateDemoData(DEMO_TODAY, 15);

beforeAll(async () => {
  setNowForTest(kst(DEMO_TODAY, 15, 30)); // 2026-10-31(토) 15:30 KST — 생성기 기준일과 같게
  registerDataJobsForTest();
  t = await createTestApp({ demoData: true }); // 시드가 데모 커넥션 + ingest.backfill 120일을 건다
  await drainIngest(t.db, t.config);
  ds = await buildDataset(t.db, t.ws);
}, 120_000);
afterAll(async () => {
  setNowForTest(null);
  await t?.close();
});

describe('데모 커넥터 → Dataset', () => {
  it('오늘 포함 120일(데모 생성기와 같은 길이), 매체 일별 · 시간대 · 판매 · 키워드 · 검색어 · 엔티티가 모두 채워진다', () => {
    expect(ds.today).toBe(DEMO_TODAY);
    expect(ds.currentHour).toBe(15);
    expect(ds.generatedAt).toBe('2026-10-31T15:30:00+09:00');
    expect(ds.dates).toHaveLength(120);
    expect(ds.dates).toEqual(DEMO.dates);
    expect(ds.dates[0]).toBe('2026-07-04');
    expect(ds.dates[ds.dates.length - 1]).toBe(DEMO_TODAY);
    expect(ds.mediaDaily).toHaveLength(120 * 6);
    expect(new Set(ds.mediaHourly.map((r) => r.date)).size).toBe(35);
    expect(ds.mediaHourly.filter((r) => r.date === DEMO_TODAY && r.media === 'meta')).toHaveLength(16);
    expect(ds.salesDaily).toHaveLength(120 * 4);
    expect(ds.keywords).toHaveLength(28);
    expect(ds.campaigns).toHaveLength(16);
    expect(ds.accounts).toHaveLength(7);
    expect(ds.products).toHaveLength(2);
    expect(ds.promotions).toHaveLength(3);
    expect(ds.searchTerms).toHaveLength(15);
    expect(ds.brandSearchDaily).toHaveLength(120);
  });

  it('생성기 값과 같다 (과거 일별 · 시간대 · 오늘 진행 중 · 키워드 14일 · 캠페인 소진)', () => {
    expect(ds.mediaDaily).toEqual(DEMO.mediaDaily);
    // 판매 채널 과거 값은 생성기 기준 시각(23시 고정 — 수집 시각에 따라 흔들리지 않게)에 따라 난수 순서가 달라 날짜 · 채널 구성만 같다
    expect(ds.salesDaily.map((r) => `${r.date}|${r.channel}`)).toEqual(DEMO.salesDaily.map((r) => `${r.date}|${r.channel}`));
    expect(ds.brandSearchDaily.map((r) => r.date)).toEqual(DEMO.dates);
    const demoHourly = DEMO.mediaHourly.filter((r) => r.date >= '2026-09-27');
    expect(ds.mediaHourly).toEqual(demoHourly);
    for (const k of DEMO.keywords) {
      const got = ds.keywords.find((x) => x.id === k.id)!;
      expect(got.daily).toEqual(k.daily);
      expect(got.last14).toEqual(k.last14);
      expect(got.prev14).toEqual(k.prev14);
      expect({ ...got, last14: 0, prev14: 0, daily: 0 }).toEqual({ ...k, last14: 0, prev14: 0, daily: 0 });
    }
    expect(ds.campaigns).toEqual(DEMO.campaigns);
    for (const s of DEMO.searchTerms) {
      const got = ds.searchTerms.find((x) => x.term === s.term)!;
      expect({ ...got, registered: null }).toEqual({ ...s, registered: null });
    }
    expect(ds.searchTerms.find((x) => x.term === '부모님 선물 매트리스')!.registered).toBe(true); // '부모님 매트리스 선물'과 같은 단어 조합
  });

  it('메타: 데모만 있으면 mode=demo, 매체 · 채널별 출처와 최신 날짜 · 시각', () => {
    expect(ds.meta?.mode).toBe('demo');
    const sa = ds.meta!.sources.find((s) => s.channel === 'naver_sa' && s.source === 'demo')!;
    expect(sa).toMatchObject({ kind: 'demo', latestDate: DEMO_TODAY, latestHour: 15 });
    expect(ds.meta!.sources.find((s) => s.channel === 'brandstore')).toMatchObject({ kind: 'demo', latestDate: DEMO_TODAY });
  });

  it('기존 엔진이 그대로 돈다: 이상 감지(오늘 Meta 급등 · 카카오 전환 0) · 입찰 제안', () => {
    const incidents = detectIncidents(ds);
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents.some((i) => i.media === 'meta')).toBe(true);
    const proposals = generateBidProposals(ds);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => Number.isFinite(p.before) && Number.isFinite(p.after))).toBe(true);
  });

  it('같은 기간을 다시 수집해도 행 수 · 값이 같다 (멱등 upsert)', async () => {
    const before = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM wh_media_daily WHERE workspace_id = $1', [t.ws]);
    const conn = (await t.db.query<{ id: string }>(`SELECT id FROM connections WHERE workspace_id = $1 AND provider = 'demo'`, [t.ws])).rows[0];
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('ingest.daily', $1, $2)`, [t.ws, JSON.stringify({ connectionId: conn.id })]);
    await drainIngest(t.db, t.config);
    const after = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM wh_media_daily WHERE workspace_id = $1', [t.ws]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const again = await buildDataset(t.db, t.ws);
    expect(again.mediaDaily).toEqual(ds.mediaDaily);
    expect(again.keywords).toEqual(ds.keywords);
  });

  it('days · today · hour 옵션 (과거 기준 시각, 시간대는 그 시각까지만)', async () => {
    const d = await buildDataset(t.db, t.ws, { today: '2026-10-30', hour: 9, days: 30 });
    expect(d.dates).toHaveLength(30);
    expect(d.dates[0]).toBe('2026-10-01');
    expect(d.today).toBe('2026-10-30');
    expect(d.generatedAt).toBe('2026-10-30T09:30:00+09:00');
    expect(Math.max(...d.mediaHourly.filter((r) => r.date === '2026-10-30').map((r) => r.hour))).toBe(9);
    expect(d.mediaDaily.every((r) => r.date >= '2026-10-01' && r.date <= '2026-10-30')).toBe(true);
  });
});

describe('출처 우선순위', () => {
  it('실연동(api) 출처가 있는 매체는 데모를 빼고, 날짜마다 api > csv를 고른다. 다른 매체는 데모 유지 → mode=mixed', async () => {
    const api = (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, priority) VALUES ($1, 'google_ads', 'media', 'google', 'Google Ads', 'active', 100) RETURNING id`, [t.ws],
    )).rows[0].id;
    const up = (await t.db.query<{ id: string }>(
      `INSERT INTO uploads (workspace_id, template, filename, bytes, status) VALUES ($1, 'media_daily', 'google.csv', 10, 'imported') RETURNING id`, [t.ws],
    )).rows[0].id;
    const row = (date: string, cost: number) => ({ date, media: 'google' as const, impressions: 1000, clicks: 10, cost, conversions: 1, revenue: cost * 3 });
    await writeBatch(t.db, t.ws, api, { mediaDaily: [row('2026-10-29', 777), row('2026-10-30', 888)] });
    await writeBatch(t.db, t.ws, `csv:${up}`, { mediaDaily: [row('2026-10-28', 555), row('2026-10-29', 111)] });
    const d = await buildDataset(t.db, t.ws);
    const g = d.mediaDaily.filter((r) => r.media === 'google');
    expect(g.map((r) => [r.date, r.cost])).toEqual([['2026-10-28', 555], ['2026-10-29', 777], ['2026-10-30', 888]]);
    expect(d.mediaDaily.filter((r) => r.media === 'naver_sa')).toHaveLength(120); // 다른 매체는 데모 그대로
    expect(d.meta!.mode).toBe('mixed');
    expect(d.meta!.sources.filter((s) => s.channel === 'google').map((s) => s.kind).sort()).toEqual(['api', 'csv']);
    // 우선순위를 뒤집으면 csv가 이긴다
    await t.db.query('UPDATE connections SET priority = 10 WHERE id = $1', [api]);
    const d2 = await buildDataset(t.db, t.ws);
    expect(d2.mediaDaily.find((r) => r.media === 'google' && r.date === '2026-10-29')!.cost).toBe(111);
    // 커넥션을 지우면(출처 정보가 없으면) 잔여 행은 쓰지 않는다
    await t.db.query('DELETE FROM connections WHERE id = $1', [api]);
    await t.db.query('DELETE FROM uploads WHERE id = $1', [up]);
    const d3 = await buildDataset(t.db, t.ws);
    expect(d3.mediaDaily.filter((r) => r.media === 'google')).toHaveLength(120);
    expect(d3.meta!.mode).toBe('demo');
  });

  it('빈 워크스페이스는 빈 배열 · mode=live (테스트 데이터 없음)', async () => {
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'empty-ws', '빈', '빈') RETURNING id`, [t.orgId])).rows[0].id;
    const d = await buildDataset(t.db, other);
    expect(d.mediaDaily).toEqual([]);
    expect(d.keywords).toEqual([]);
    expect(d.meta).toMatchObject({ mode: 'live', sources: [] });
    expect(detectIncidents(d)).toBeInstanceOf(Array);
    expect(generateBidProposals(d)).toEqual([]);
  });
});

describe('키워드 매체 (Google Ads 키워드 · 서버 모드 필드)', () => {
  it('키워드 문서의 media · campaignId · adgroupId를 그대로 넘기고, 매체별로 데모 제외를 판단한다', async () => {
    const g = (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, status) VALUES ($1, 'google_ads', 'media', 'google', 'Google Ads 키워드', 'active') RETURNING id`, [t.ws],
    )).rows[0].id;
    const kw = { id: 'gkw-1', text: '매트리스 추천', intent: 'compare' as const, adgroup: '비교', isBrand: false, bid: 900, maxBid: 1440, avgRank: 0, monthlySearch: 0, impressionShareLost: 0, status: 'on' as const, landing: '', media: 'google' as const, campaignId: '111', adgroupId: '222' };
    const days = ['2026-10-25', '2026-10-30'];
    await writeBatch(t.db, t.ws, g, {
      keywords: [kw],
      keywordDaily: days.map((date) => ({ date, keywordId: 'gkw-1', impressions: 100, clicks: 10, cost: 9000, conversions: 1, revenue: 500_000, avgRank: null })),
      searchTermDaily: [{ date: '2026-10-30', term: '구글 매트리스 추천 검색어', impressions: 50, clicks: 5, cost: 4500, conversions: 0, revenue: 0 }],
      campaigns: [{ id: 'gcmp-1', media: 'google', name: 'G 검색 · 비교', dailyBudget: 300_000, spentToday: 12_000, status: 'on', hourOfData: 15, adGroups: [{ id: '222', name: '비교', status: 'on', dailyBudget: 0 }] }],
    }, { keywordChannel: 'google' });
    // 변경 실행기(changes)가 읽는 엔티티 문서: 키워드 maxBid · 캠페인 dailyBudget · name이 그대로 남는다
    const docs = (await t.db.query<{ entity_type: string; doc: Record<string, unknown> }>(`SELECT entity_type, doc FROM wh_entities WHERE source = $1 ORDER BY entity_type`, [g])).rows;
    expect(docs.find((x) => x.entity_type === 'keyword')!.doc).toMatchObject({ maxBid: 1440, campaignId: '111', adgroupId: '222' });
    expect(docs.find((x) => x.entity_type === 'campaign')!.doc).toMatchObject({ dailyBudget: 300_000, name: 'G 검색 · 비교' });
    const demoKw = (await t.db.query<{ doc: { maxBid: number } }>(`SELECT doc FROM wh_entities WHERE source = 'demo' AND entity_type = 'keyword' LIMIT 1`)).rows[0];
    expect(demoKw.doc.maxBid).toBeGreaterThan(0);
    const ent = (await t.db.query<{ channel: string }>(`SELECT channel FROM wh_entities WHERE source = $1 AND external_id = 'gkw-1'`, [g])).rows[0];
    expect(ent.channel).toBe('google');
    const d = await buildDataset(t.db, t.ws);
    const got = d.keywords.find((k) => k.id === 'gkw-1')!;
    expect(got).toMatchObject({ media: 'google', campaignId: '111', adgroupId: '222', bid: 900, maxBid: 1440 });
    expect(got.last14).toEqual({ impressions: 200, clicks: 20, cost: 18_000, conversions: 2, revenue: 1_000_000 });
    expect(d.campaigns.find((c) => c.id === 'gcmp-1')).toMatchObject({ media: 'google', dailyBudget: 300_000, adGroups: [{ id: '222', name: '비교', status: 'on', dailyBudget: 0 }] });
    // Google만 실연동 → 네이버 SA 데모 키워드 28개는 남는다 (데모 키워드에는 media 필드가 없다 = 네이버 SA)
    expect(d.keywords.filter((k) => !k.media)).toHaveLength(28);
    expect(d.searchTerms.find((x) => x.term === '구글 매트리스 추천 검색어')).toMatchObject({ clicks: 5, cost: 4500 });
    expect(d.searchTerms.length).toBeGreaterThan(1); // 네이버 SA 데모 검색어 유지
    expect(d.meta!.sources).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'google', source: g, kind: 'api' })]));
    expect(d.meta!.sources.some((s) => s.channel === 'naver_sa' && s.source === g)).toBe(false);
    expect(proposalsRun(d)).toBe(true);

    // 네이버 SA 키워드가 실연동되면 그 매체의 데모 키워드 · 검색어가 빠진다
    const n = (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, status) VALUES ($1, 'naver_sa', 'media', 'naver_sa', '네이버 SA 키워드', 'active') RETURNING id`, [t.ws],
    )).rows[0].id;
    await writeBatch(t.db, t.ws, n, {
      keywords: [{ ...kw, id: 'nkw-1', text: '퀸 매트리스 실연동', media: 'naver_sa', campaignId: 'cmp-1', adgroupId: 'grp-1' }],
      keywordDaily: [{ date: '2026-10-30', keywordId: 'nkw-1', impressions: 10, clicks: 1, cost: 1000, conversions: 0, revenue: 0, avgRank: 2 }],
    }, { keywordChannel: 'naver_sa' });
    const d2 = await buildDataset(t.db, t.ws);
    expect(d2.keywords.map((k) => [k.id, k.media]).sort()).toEqual([['gkw-1', 'google'], ['nkw-1', 'naver_sa']]);
    expect(d2.searchTerms.map((x) => x.term)).toEqual(['구글 매트리스 추천 검색어']);
    await t.db.query('DELETE FROM connections WHERE id = ANY($1::uuid[])', [[g, n]]);
    const d3 = await buildDataset(t.db, t.ws);
    expect(d3.keywords).toHaveLength(28);
  });

  it('금액은 원 단위 정수, 전환은 소수 둘째 자리, 숫자가 아니면 0으로 쓴다', async () => {
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'units-ws', '단위', '단위') RETURNING id`, [t.orgId])).rows[0].id;
    const c = (await t.db.query<{ id: string }>(`INSERT INTO connections (workspace_id, provider, kind, channel, label, status) VALUES ($1, 'meta', 'media', 'meta', 'Meta', 'active') RETURNING id`, [other])).rows[0].id;
    await writeBatch(t.db, other, c, { mediaDaily: [{ date: '2026-10-30', media: 'meta', impressions: 1000.4, clicks: 10, cost: 12_345.6, conversions: 1.236, revenue: Number.NaN, newCustomers: Number.POSITIVE_INFINITY }] });
    const d = await buildDataset(t.db, other);
    expect(d.mediaDaily.find((r) => r.date === '2026-10-30')).toEqual({ date: '2026-10-30', media: 'meta', impressions: 1000, clicks: 10, cost: 12_346, conversions: 1.24, revenue: 0, newCustomers: 0 });
    expect(d.dates).toHaveLength(120);
  });
});

describe('GET /api/w/:ws/dataset', () => {
  it('모든 역할이 읽을 수 있고, 다른 워크스페이스는 404, 잘못된 쿼리는 400, 미로그인 401', async () => {
    const viewer = await t.login('viewer');
    const r = await viewer.get(`/api/w/${t.ws}/dataset?hour=12`);
    expect(r.status).toBe(200);
    expect(r.json.currentHour).toBe(12);
    expect(r.json.keywords).toHaveLength(28);
    expect(r.json.meta.mode).toBe('demo');
    expect(r.headers['cache-control']).toBe('no-store');
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-ds', '다른', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    expect((await viewer.get(`/api/w/${other}/dataset`)).status).toBe(404);
    expect((await viewer.get(`/api/w/${t.ws}/dataset?today=31-10-2026`)).status).toBe(400);
    expect((await viewer.get(`/api/w/${t.ws}/dataset?hour=25`)).status).toBe(400);
    expect((await t.anon().get(`/api/w/${t.ws}/dataset`)).status).toBe(401);
  });
});
