/** 네이버 검색광고 커넥터 — 서명 · 정규화 · 페이지 · 오류 · 반영(dry_run · live). 실제 네트워크 호출 없음 (가짜 ConnectorHttp). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connector, naverTarget, parseTestRegistration } from './index';
import { NaverSaClient, naverAuthHeaders, signNaver, statRows } from './client';
import { funnelOf, landingOf, normCampaign } from './normalize';
import { fakeCtx, fakeHttp } from './fake-http';
import { CID_BRAND, CID_DELETED, CID_GENERIC, CID_SHOP, GRP_GENERIC, KW_BRAND, KW_GENERIC, KW_GENERIC2, naverRoutes, statFor } from './fixtures';
import { sign as scriptSign } from '../../../../scripts/naver-searchad';
import { createConnectorHttp } from '../http';
import { setNowForTest } from '../../lib/time';
import type { ChangeRequest } from '@/core/types';

const CREDS = { apiKey: 'test-api-key-0123', secretKey: 'test-secret-key-0123', customerId: '1234567' };
// 2026-11-02 14:30 KST
const NOW = Date.parse('2026-11-02T05:30:00Z');
const TODAY = '2026-11-02';

beforeAll(() => setNowForTest(NOW));
afterAll(() => setNowForTest(null));

const change = (p: Partial<ChangeRequest>): ChangeRequest => ({
  id: 'chg-1', createdAt: '2026-11-02T05:00:00Z', module: 'adpilot', kind: 'bid', target: '퀸 매트리스 입찰가', targetId: KW_GENERIC,
  before: 900, after: 1000, reason: 'test', requestedBy: 'AD Pilot', approver: 'AE', status: 'approved', history: [], ...p,
});

describe('서명 (X-Signature)', () => {
  it('HMAC-SHA256(secret, `${ts}.${METHOD}.${path}`) Base64 — 독립 계산 벡터 · 기존 스크립트와 일치', () => {
    // python: base64(hmac.new(b'test-secret-key-0123', b'1700000000000.GET./ncc/campaigns', sha256).digest())
    expect(signNaver('test-secret-key-0123', '1700000000000', 'GET', '/ncc/campaigns')).toBe('ZqyqamFxN/+i4CKhYwxfTGXFh7uS+hIrGfKMp+8jxZ8=');
    expect(signNaver('test-secret-key-0123', '1700000000000', 'put', '/ncc/keywords/nkw-a001-01-000000001234567')).toBe('uw4yNd0dNYAzFAdbfLLMMXaivm3IoP3dh5BfV3r8nk4=');
    expect(signNaver('k', '1', 'GET', '/stats')).toBe(scriptSign('k', '1', 'GET', '/stats'));
  });

  it('헤더: X-Timestamp · X-API-KEY · X-Customer · X-Signature, 서명 경로에 쿼리 미포함', async () => {
    const h = naverAuthHeaders(CREDS, 'GET', '/ncc/campaigns', 1_700_000_000_000);
    expect(h).toMatchObject({ 'X-Timestamp': '1700000000000', 'X-API-KEY': CREDS.apiKey, 'X-Customer': '1234567', 'X-Signature': 'ZqyqamFxN/+i4CKhYwxfTGXFh7uS+hIrGfKMp+8jxZ8=' });
    const http = fakeHttp([{ match: '/ncc/campaigns', reply: { data: [] } }]);
    const c = new NaverSaClient({ http }, CREDS, { now: () => 1_700_000_000_000 });
    await c.campaigns();
    const call = http.calls[0];
    expect(call.url).toBe('https://api.searchad.naver.com/ncc/campaigns');
    expect(call.query).toMatchObject({ recordSize: 1000 });
    expect(call.headers?.['X-Signature']).toBe('ZqyqamFxN/+i4CKhYwxfTGXFh7uS+hIrGfKMp+8jxZ8=');
  });
});

describe('페이지 조회', () => {
  it('recordSize만큼 차면 마지막 id를 baseSearchId로 다음 페이지, 중복 id는 한 번만', async () => {
    const ids = ['nkw-a001-01-000000000000001', 'nkw-a001-01-000000000000002', 'nkw-a001-01-000000000000003'];
    const http = fakeHttp([{
      match: '/ncc/keywords',
      reply: (req) => {
        const base = req.query?.baseSearchId as string | undefined;
        if (!base) return { data: ids.slice(0, 2).map((id) => ({ nccKeywordId: id, nccAdgroupId: GRP_GENERIC, keyword: id })) };
        if (base === ids[1]) return { data: [{ nccKeywordId: ids[1], nccAdgroupId: GRP_GENERIC, keyword: 'dup' }, { nccKeywordId: ids[2], nccAdgroupId: GRP_GENERIC, keyword: 'k3' }] };
        return { data: [] };
      },
    }]);
    const c = new NaverSaClient({ http }, CREDS, { now: () => 1, pageSize: 2 });
    const rows = await c.keywords(GRP_GENERIC);
    expect(rows.map((r) => r.nccKeywordId)).toEqual(ids);
    expect(http.calls.map((x) => x.query?.baseSearchId)).toEqual([undefined, ids[1], ids[2]]);
    expect(http.calls.every((x) => x.query?.nccAdgroupId === GRP_GENERIC)).toBe(true);
  });
});

describe('정규화', () => {
  it('구매완료 전환 우선, 없으면 전체 전환으로 채우고 표시 · VAT 제외 옵션', () => {
    const row = { impCnt: 100, clkCnt: 10, salesAmt: 11000, ccnt: 5, convAmt: 500000, purchaseCcnt: 2, purchaseConvAmt: 300000 };
    expect(funnelOf(row, 'purchase', 'vat_included')).toEqual({ funnel: { impressions: 100, clicks: 10, cost: 11000, conversions: 2, revenue: 300000 }, fallback: false });
    expect(funnelOf(row, 'all', 'vat_excluded').funnel).toEqual({ impressions: 100, clicks: 10, cost: 10000, conversions: 5, revenue: 500000 });
    expect(funnelOf({ ...row, purchaseCcnt: null, purchaseConvAmt: null }, 'purchase', 'vat_included')).toMatchObject({ funnel: { conversions: 5, revenue: 500000 }, fallback: true });
    expect(funnelOf({}, 'purchase', 'vat_included')).toEqual({ funnel: { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }, fallback: false });
  });

  it('응답 래퍼(summaryStatResponse · dailyStatResponse)와 data 직접 형태 모두', () => {
    expect(statRows({ data: [{ id: 'a' }] })).toHaveLength(1);
    expect(statRows({ summaryStatResponse: { data: [{ id: 'a' }, { id: 'b' }] } })).toHaveLength(2);
    expect(statRows({ dailyStatResponse: { data: [{ dateStart: '2026-11-01' }] } })).toHaveLength(1);
    expect(statRows(null)).toEqual([]);
  });

  it('캠페인 상태 · 예산 · 의도, 랜딩 URL', () => {
    expect(normCampaign({ nccCampaignId: 'cmp-x-1-1', name: '브랜드 방어', userLock: false, dailyBudget: 300000, useDailyBudget: true }, 12345.6, 13, {}))
      .toEqual({ id: 'cmp-x-1-1', media: 'naver_sa', name: '브랜드 방어', intent: 'brand', dailyBudget: 300000, spentToday: 12346, status: 'on', hourOfData: 13 });
    expect(normCampaign({ nccCampaignId: 'c', name: '쇼핑', userLock: true, useDailyBudget: false, dailyBudget: 0 }, 0, 0, {}).status).toBe('off');
    expect(normCampaign({ nccCampaignId: 'c', name: '비교 검토', statusReason: 'CAMPAIGN_LIMITED_BY_BUDGET' }, 0, 0, {})).toMatchObject({ status: 'limited', intent: 'compare', dailyBudget: 0 });
    expect(normCampaign({ nccCampaignId: 'c', name: '공유', sharedBudgetId: 'sb-1', sharedDailyBudget: 900000 }, 0, 0, { intentRules: [{ match: '공유', intent: 'life' }] })).toMatchObject({ dailyBudget: 900000, intent: 'life' });
    expect(landingOf('{"pc":{"final":"https://a.example/x"}}')).toBe('https://a.example/x');
    expect(landingOf(null)).toBe('');
  });
});

describe('수집 (fetch)', () => {
  it('일별 · 시간대 · 키워드 · 캠페인 · 계정 — 단위(원 정수) · KST 날짜 · 삭제 제외', async () => {
    const http = fakeHttp(naverRoutes({ today: TODAY }));
    const ctx = fakeCtx(CREDS, { brandTerms: ['수면밀도'], keywordDays: 2, fetchSearchVolume: true }, http);
    const b = await connector.fetch(ctx, { from: '2026-10-31', to: '2026-11-05' });

    // 기간은 오늘(KST)까지로 잘린다 · 삭제 캠페인 제외
    expect(b.mediaDaily!.map((r) => r.date)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    const live = [CID_BRAND, CID_GENERIC, CID_SHOP];
    const sum = (date: string, k: 'impCnt' | 'salesAmt' | 'purchaseCcnt' | 'purchaseConvAmt') => live.reduce((s, id) => s + Number(statFor(id, date)[k]), 0);
    const d1 = b.mediaDaily!.find((r) => r.date === '2026-11-01')!;
    expect(d1).toEqual({ date: '2026-11-01', media: 'naver_sa', impressions: sum('2026-11-01', 'impCnt'), clicks: expect.any(Number), cost: sum('2026-11-01', 'salesAmt'), conversions: sum('2026-11-01', 'purchaseCcnt'), revenue: sum('2026-11-01', 'purchaseConvAmt') });
    expect(http.calls.some((c) => String(c.query?.ids ?? '').includes(CID_DELETED))).toBe(false);

    // 시간대: 오늘은 현재 시각(14시) 이후 시간 제외 (픽스처는 9 · 10 · 23시)
    const todayHours = b.mediaHourly!.filter((r) => r.date === TODAY).map((r) => r.hour);
    expect(todayHours).toEqual([9, 10]);
    expect(b.mediaHourly!.filter((r) => r.date === '2026-11-01').map((r) => r.hour)).toEqual([9, 10, 23]);
    expect(http.calls.filter((c) => c.query?.breakdown === 'hh24')).toHaveLength(3);

    // 캠페인 스냅샷
    const brand = b.campaigns!.find((c) => c.id === CID_BRAND)!;
    expect(brand).toEqual({ id: CID_BRAND, media: 'naver_sa', name: '브랜드 방어', intent: 'brand', dailyBudget: 300000, spentToday: statFor(CID_BRAND, TODAY).salesAmt, status: 'on', hourOfData: 13 });
    expect(b.campaigns!.find((c) => c.id === CID_GENERIC)!.status).toBe('limited');
    expect(b.campaigns!.find((c) => c.id === CID_SHOP)!).toMatchObject({ status: 'off', dailyBudget: 0 });
    expect(b.campaigns!.some((c) => c.id === CID_DELETED)).toBe(false);

    // 키워드: 파워링크(WEB_SITE) 광고그룹만, 그룹 입찰가 사용 키워드는 그룹 입찰가
    const kw = Object.fromEntries(b.keywords!.map((k) => [k.id, k]));
    expect(Object.keys(kw).sort()).toEqual([KW_BRAND, KW_GENERIC, KW_GENERIC2].sort());
    expect(kw[KW_BRAND]).toMatchObject({ text: '수면밀도', intent: 'brand', isBrand: true, bid: 1200, maxBid: 2400, avgRank: 2.4, status: 'on', landing: 'https://brand.naver.com/mildo', monthlySearch: 310, impressionShareLost: 0 });
    expect(kw[KW_GENERIC]).toMatchObject({ intent: 'generic', isBrand: false, bid: 900, adgroup: '매트리스 일반', monthlySearch: 10000 });
    expect(kw[KW_GENERIC2]).toMatchObject({ bid: 700, status: 'off' });

    // 키워드 일별: keywordDays=2 → 11-01, 11-02만 + 경고
    expect([...new Set(b.keywordDaily!.map((r) => r.date))]).toEqual(['2026-11-01', '2026-11-02']);
    expect(b.keywordDaily!.find((r) => r.keywordId === KW_BRAND && r.date === '2026-11-01')).toMatchObject({ cost: statFor(KW_BRAND, '2026-11-01').salesAmt, avgRank: 2.4, conversions: 2, revenue: 780000 });
    expect(b.warnings!.map((w) => w.code)).toEqual(expect.arrayContaining(['keyword_window', 'impression_share_unavailable', 'max_bid_default']));

    // 계정: 비즈머니 · 7일 평균 소진(합계 픽스처 70,000 × 캠페인 3개 ÷ 7)
    expect(b.accounts).toEqual([{ id: 'nsa-1234567', media: 'naver_sa', name: '네이버 검색광고 1234567', owner: '', balance: 1_500_000, avgDailySpend: 30000, autoCharge: 'off', paymentMethod: '비즈머니(선결제)', permissions: [], status: 'active' }]);
  });

  it('긴 기간은 캠페인별 일자 통계(timeIncrement=1, 92일 구간)로 호출 수를 줄인다', async () => {
    const http = fakeHttp(naverRoutes({ today: TODAY }));
    const ctx = fakeCtx(CREDS, { keywordDays: 0, hourlyDays: 0 }, http);
    const b = await connector.fetch(ctx, { from: '2026-06-01', to: '2026-10-31' });
    expect(b.mediaDaily).toHaveLength(153);
    const daily = http.calls.filter((c) => c.query?.timeIncrement === '1');
    // 캠페인 3개 × ceil(153/92)=2 구간
    expect(daily).toHaveLength(6);
    expect(daily.map((c) => JSON.parse(String(c.query!.timeRange)))).toContainEqual({ since: '2026-06-01', until: '2026-08-31' });
    expect(b.mediaHourly).toEqual([]);
    expect(b.keywordDaily).toEqual([]);
  });

  it('구매완료 지표가 없으면 전체 전환으로 채우고 경고 · intraday는 키워드를 건너뛴다', async () => {
    const http = fakeHttp(naverRoutes({ today: TODAY, omitPurchase: true }));
    const b = await connector.fetch(fakeCtx(CREDS, {}, http), { from: TODAY, to: TODAY }, { intradayDate: TODAY });
    expect(b.mediaDaily![0]).toMatchObject({ date: TODAY, conversions: 9 });
    expect(b.keywords).toBeUndefined();
    expect(http.callsTo('/ncc/keywords')).toHaveLength(0);
    expect(b.warnings!.map((w) => w.code)).toContain('conversion_fallback');
    expect(b.mediaHourly!.every((r) => r.date === TODAY && r.hour <= 14)).toBe(true);
    expect(b.accounts).toHaveLength(1);
  });
});

describe('부분 실패', () => {
  it('키워드 단계 서버 오류(500)는 경고로 남기고 일별 · 캠페인은 저장, 인증 오류(401)는 수집 전체 실패', async () => {
    const routes = naverRoutes({ today: TODAY });
    const broken = fakeHttp([{ method: 'GET', match: '/ncc/adgroups', reply: { status: 500, data: { title: 'Internal Server Error' } } }, ...routes]);
    const b = await connector.fetch(fakeCtx(CREDS, {}, broken), { from: '2026-11-01', to: TODAY });
    expect(b.mediaDaily).toHaveLength(2);
    expect(b.campaigns).toHaveLength(3);
    expect(b.keywords).toBeUndefined();
    expect(b.keywordDaily).toBeUndefined();
    expect(b.warnings!.find((w) => w.code === 'keywords_failed')!.message).toMatch(/키워드 수집 실패 — 나머지 데이터는 저장했습니다: 네이버 검색광고 서버 오류/);
    expect(b.accounts).toHaveLength(1);

    const auth = fakeHttp([{ method: 'GET', match: '/ncc/adgroups', reply: { status: 401, data: { title: 'Unauthorized' } } }, ...routes]);
    await expect(connector.fetch(fakeCtx(CREDS, {}, auth), { from: '2026-11-01', to: TODAY })).rejects.toThrow(/인증 실패/);
  });
});

describe('오류 매핑', () => {
  it('401 → 한국어 인증 실패, 타임스탬프 오류 → NTP 안내, test()는 ok:false', async () => {
    const http = fakeHttp([{ match: '/billing/bizmoney', reply: { status: 401, data: { type: 'urn:naver:api:problem:unauthorized', title: 'Unauthorized', detail: 'Invalid API key' } } }]);
    const r = await connector.test(fakeCtx(CREDS, {}, http));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/네이버 검색광고 인증 실패/);
    expect(r.message).toContain('Invalid API key');

    const ts = fakeHttp([{ match: '/billing/bizmoney', reply: { status: 403, data: { type: 'urn:naver:api:problem:invalid-timestamp', title: 'Invalid Timestamp', detail: 'Request has expired.' } } }]);
    const r2 = await connector.test(fakeCtx(CREDS, {}, ts));
    expect(r2.message).toMatch(/인증 실패.*NTP/);
  });

  it('429는 http 래퍼가 재시도 — 재시도 후 성공하면 정상, 끝까지 429면 호출 한도 메시지', async () => {
    let n = 0;
    const waits: number[] = [];
    const http = createConnectorHttp({
      log: () => {}, maxRetries: 2, timeoutMs: 1000, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5,
      fetchImpl: async (url) => {
        if (url.includes('/billing/bizmoney')) {
          n++;
          return n < 2
            ? { status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => '{"title":"Too Many Requests"}' }
            : { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"bizmoney":1000}' };
        }
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '[]' };
      },
    });
    const ok = await connector.test(fakeCtx(CREDS, {}, http));
    expect(ok.ok).toBe(true);
    expect(waits).toEqual([1000]);

    const always = createConnectorHttp({
      log: () => {}, maxRetries: 1, timeoutMs: 1000, sleep: async () => {},
      fetchImpl: async () => ({ status: 429, headers: new Headers(), text: async () => '{"title":"Too Many Requests"}' }),
    });
    const bad = await connector.test(fakeCtx(CREDS, {}, always));
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/호출 한도 초과/);
  });

  it('쓰기 래퍼처럼 4xx를 예외로 던져도 같은 메시지 · 자격증명 형식 오류', async () => {
    const http = fakeHttp([{ match: '/ncc/campaigns', reply: { status: 401, data: { title: 'Unauthorized' } } }], { mode: 'throw' });
    await expect(connector.fetch(fakeCtx(CREDS, {}, http), { from: TODAY, to: TODAY })).rejects.toThrow(/인증 실패/);
    const r = await connector.test(fakeCtx({ apiKey: 'x', secretKey: '', customerId: 'abc' }, {}, fakeHttp([])));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/자격증명을 확인/);
  });
});

describe('반영 (apply)', () => {
  it('대상 id 해석: 접두어(budget:)가 붙어도 nkw · cmp · grp 추출', () => {
    expect(naverTarget(KW_GENERIC)).toEqual({ type: 'keyword', id: KW_GENERIC });
    expect(naverTarget(`budget:${CID_BRAND}:`)).toEqual({ type: 'campaign', id: CID_BRAND });
    expect(naverTarget('seed:bid:k1')).toBeNull();
  });

  it('dry_run 입찰가: 네트워크 호출 없이 GET(사전 확인) → PUT ?fields=bidAmt 단계를 돌려준다', async () => {
    const http = fakeHttp([]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http, { dryRun: true }), change({}));
    expect(http.calls).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.appliedValue).toBe(1000);
    const req = r.request as { dryRun: boolean; steps: { method: string; url: string; query?: unknown; body?: unknown; headers?: string[] }[] };
    expect(req.dryRun).toBe(true);
    expect(req.steps.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET https://api.searchad.naver.com/ncc/keywords/${KW_GENERIC}`,
      `PUT https://api.searchad.naver.com/ncc/keywords/${KW_GENERIC}`,
    ]);
    expect(req.steps[1]).toMatchObject({ query: { fields: 'bidAmt' }, body: { nccKeywordId: KW_GENERIC, bidAmt: 1000, useGroupBidAmt: false } });
    // 비밀값은 헤더 이름만
    expect(JSON.stringify(r.request)).not.toContain(CREDS.secretKey);
    expect(JSON.stringify(r.request)).not.toContain(CREDS.apiKey);
  });

  it('live 입찰가: 사전 조회한 광고그룹 ID로 PUT, 서명 경로 = /ncc/keywords/{id}, 응답 입찰가를 반영 값으로', async () => {
    const http = fakeHttp([
      { method: 'GET', match: `/ncc/keywords/${KW_GENERIC}`, reply: { data: { nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, keyword: '퀸 매트리스', bidAmt: 900, useGroupBidAmt: false } } },
      { method: 'PUT', match: `/ncc/keywords/${KW_GENERIC}`, reply: (req) => ({ data: { nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, bidAmt: (req.body as { bidAmt: number }).bidAmt } }) },
    ]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({}));
    expect(r).toMatchObject({ ok: true, appliedValue: 1000 });
    const put = http.calls[1];
    expect(put.body).toEqual({ nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, bidAmt: 1000, useGroupBidAmt: false });
    expect(put.query).toEqual({ fields: 'bidAmt' });
    expect(put.headers?.['X-Signature']).toBe(signNaver(CREDS.secretKey, put.headers!['X-Timestamp'], 'PUT', `/ncc/keywords/${KW_GENERIC}`));
  });

  it('변경 실행기가 붙인 entity.adgroupId: dry_run 요청에 그대로 싣고, live에서 매체 값과 다르면 PUT 없이 멈춘다', async () => {
    const withEntity = (adgroupId: string) => ({ ...change({}), entity: { type: 'keyword' as const, externalId: KW_GENERIC, adgroupId } });
    const dry = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([]), { dryRun: true }), withEntity(GRP_GENERIC));
    const steps = (dry.request as { steps: { body?: unknown }[] }).steps;
    expect(steps[1].body).toMatchObject({ nccAdgroupId: GRP_GENERIC });
    // 형식이 아닌 값은 쓰지 않는다
    const bad = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([]), { dryRun: true }), withEntity('../../etc'));
    expect((bad.request as { steps: { body?: { nccAdgroupId?: string } }[] }).steps[1].body?.nccAdgroupId).toBe('(사전 확인 결과)');

    const http = fakeHttp([{ method: 'GET', match: `/ncc/keywords/${KW_GENERIC}`, reply: { data: { nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, bidAmt: 900, useGroupBidAmt: false } } }]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), withEntity('grp-a001-01-000000000099999'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/광고그룹.*다릅니다/);
    expect(http.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('현재 값이 요청 시점과 다르면 PUT 없이 멈춘다 · 범위 밖 입찰가는 호출 전 거절', async () => {
    const http = fakeHttp([{ method: 'GET', match: '/ncc/keywords/', reply: { data: { nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, bidAmt: 1500 } } }]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({}));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/요청 시점 값\(900원\)과 다릅니다/);
    expect(http.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    const none = fakeHttp([]);
    const big = await connector.apply!(fakeCtx(CREDS, {}, none), change({ after: 200000 }));
    expect(big.ok).toBe(false);
    expect(big.error).toMatch(/70~100,000원/);
    expect(none.calls).toHaveLength(0);
  });

  it('하루 예산: 공유 예산 캠페인은 멈추고, 일반 캠페인은 ?fields=budget로 반영', async () => {
    const shared = fakeHttp([{ method: 'GET', match: '/ncc/campaigns/', reply: { data: { nccCampaignId: CID_BRAND, name: 'x', sharedBudgetId: 'sbg-1', useDailyBudget: false } } }]);
    const r1 = await connector.apply!(fakeCtx(CREDS, {}, shared), change({ kind: 'budget', targetId: `budget:${CID_BRAND}:`, before: 300000, after: 360000 }));
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/공유 예산/);

    const http = fakeHttp([
      { method: 'GET', match: '/ncc/campaigns/', reply: { data: { nccCampaignId: CID_BRAND, name: 'x', dailyBudget: 300000, useDailyBudget: true } } },
      { method: 'PUT', match: '/ncc/campaigns/', reply: { data: { nccCampaignId: CID_BRAND, dailyBudget: 360000, useDailyBudget: true } } },
    ]);
    const r2 = await connector.apply!(fakeCtx(CREDS, {}, http), change({ kind: 'budget', targetId: CID_BRAND, before: 300000, after: 360000 }));
    expect(r2).toMatchObject({ ok: true, appliedValue: 360000 });
    expect(http.calls[1]).toMatchObject({ method: 'PUT', query: { fields: 'budget' }, body: { nccCampaignId: CID_BRAND, dailyBudget: 360000, useDailyBudget: true } });
  });

  it('ON/OFF: 캠페인은 userLock 바로 변경, 키워드는 광고그룹 ID 확인 후 · 해석 불가 값 거절', async () => {
    const http = fakeHttp([{ method: 'PUT', match: '/ncc/campaigns/', reply: { data: { nccCampaignId: CID_GENERIC, userLock: true } } }]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({ kind: 'status', targetId: CID_GENERIC, before: 'on', after: 'off' }));
    expect(r).toMatchObject({ ok: true, appliedValue: 'off' });
    expect(http.calls[0]).toMatchObject({ query: { fields: 'userLock' }, body: { nccCampaignId: CID_GENERIC, userLock: true } });

    const dry = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([]), { dryRun: true }), change({ kind: 'status', targetId: KW_GENERIC, before: 'off', after: 'on' }));
    expect((dry.request as { steps: unknown[] }).steps).toHaveLength(2);
    expect(dry.appliedValue).toBe('on');

    const bad = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([])), change({ kind: 'status', after: 'maybe' }));
    expect(bad.ok).toBe(false);
    const unsupported = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([])), change({ kind: 'keyword_exclude' }));
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error).toMatch(/keyword_exclude/);
  });

  describe('테스트 키워드 등록 (keyword_add)', () => {
    const GRP_TEST = 'grp-a001-01-000000099999999';
    const add = (p: Partial<ChangeRequest> = {}) => change({ kind: 'keyword_add', target: '퀸 매트리스 추천 → GENERIC_TEST 등록', targetId: 'term:퀸 매트리스 추천', before: '미등록', after: 'GENERIC_TEST · 입찰 1,200원', ...p });

    it('after 해석: 의도 · 입찰가 (AD Pilot proposalChangeInput 형식)', () => {
      expect(parseTestRegistration('GENERIC_TEST · 입찰 1,200원')).toEqual({ intent: 'generic', bid: 1200 });
      expect(parseTestRegistration('BRAND_TEST · 입찰 70원')).toEqual({ intent: 'brand', bid: 70 });
      expect(parseTestRegistration('TEST 그룹 · 입찰 상한 내')).toEqual({ intent: null, bid: null });
    });

    it('dry_run: 네트워크 없이 중복 확인 GET → POST /ncc/keywords?nccAdgroupId=<설정한 테스트 광고그룹> 단계', async () => {
      const http = fakeHttp([]);
      const r = await connector.apply!(fakeCtx(CREDS, { testAdgroups: { generic: GRP_TEST } }, http, { dryRun: true }), add());
      expect(http.calls).toHaveLength(0);
      expect(r).toMatchObject({ ok: true, appliedValue: 1200 });
      const steps = (r.request as { steps: { method: string; url: string; query?: unknown; body?: unknown }[] }).steps;
      expect(steps.map((x) => `${x.method} ${x.url}`)).toEqual(['GET https://api.searchad.naver.com/ncc/keywords', 'POST https://api.searchad.naver.com/ncc/keywords']);
      expect(steps[1]).toMatchObject({ query: { nccAdgroupId: GRP_TEST }, body: [{ keyword: '퀸 매트리스 추천', bidAmt: 1200, useGroupBidAmt: false, userLock: false }] });
      expect(JSON.stringify(r.request)).not.toContain(CREDS.secretKey);
    });

    it('테스트 광고그룹 설정이 없거나 값이 해석되지 않으면 보내지 않고 이유를 돌려준다', async () => {
      const http = fakeHttp([]);
      const noGrp = await connector.apply!(fakeCtx(CREDS, {}, http), add());
      expect(noGrp.ok).toBe(false);
      expect(noGrp.error).toMatch(/testAdgroups\.generic/);
      const badAfter = await connector.apply!(fakeCtx(CREDS, { testAdgroups: { generic: GRP_TEST } }, http), add({ after: 'TEST 그룹 · 입찰 상한 내' }));
      expect(badAfter.error).toMatch(/구매 의도/);
      const tooLow = await connector.apply!(fakeCtx(CREDS, { testAdgroups: { generic: GRP_TEST } }, http), add({ after: 'GENERIC_TEST · 입찰 50원' }));
      expect(tooLow.error).toMatch(/70~100,000원/);
      const notTerm = await connector.apply!(fakeCtx(CREDS, { testAdgroups: { generic: GRP_TEST } }, http), add({ targetId: 'lab:term:abc' }));
      expect(notTerm.ok).toBe(false);
      expect(http.calls).toHaveLength(0);
      expect(connector.settingsSchema.safeParse({ testAdgroups: { generic: 'not-a-group' } }).success).toBe(false);
    });

    it('live: 같은 키워드가 이미 있으면 다시 만들지 않고, 없으면 POST(서명 경로 /ncc/keywords) 후 새 키워드 id를 반영 값으로', async () => {
      const dup = fakeHttp([{ method: 'GET', match: '/ncc/keywords', reply: { data: [{ nccKeywordId: 'nkw-a001-01-000000000000777', nccAdgroupId: GRP_TEST, keyword: '퀸매트리스 추천' }] } }]);
      const d = await connector.apply!(fakeCtx(CREDS, { testAdgroups: { generic: GRP_TEST } }, dup), add());
      expect(d).toMatchObject({ ok: true, appliedValue: 'nkw-a001-01-000000000000777' });
      // 응답 표식: 원래 있던 키워드 → existing (롤백 대상 아님)
      expect(d.response).toMatchObject({ existing: { nccKeywordId: 'nkw-a001-01-000000000000777' } });
      expect(dup.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

      const http = fakeHttp([
        { method: 'GET', match: '/ncc/keywords', reply: { data: [{ nccKeywordId: 'nkw-a001-01-000000000000001', nccAdgroupId: GRP_TEST, keyword: '다른 키워드' }] } },
        { method: 'POST', match: '/ncc/keywords', reply: (req) => ({ data: (req.body as { keyword: string; bidAmt: number }[]).map((k) => ({ ...k, nccKeywordId: 'nkw-a001-01-000000000000888', nccAdgroupId: GRP_TEST })) }) },
      ]);
      const r = await connector.apply!(fakeCtx(CREDS, { testAdgroups: { generic: GRP_TEST } }, http), add());
      expect(r).toMatchObject({ ok: true, appliedValue: 'nkw-a001-01-000000000000888' });
      expect(r.response).toMatchObject({ created: [{ nccKeywordId: 'nkw-a001-01-000000000000888' }] });
      const post = http.calls.find((c) => c.method === 'POST')!;
      expect(post.query).toEqual({ nccAdgroupId: GRP_TEST });
      expect(post.headers?.['X-Signature']).toBe(signNaver(CREDS.secretKey, post.headers!['X-Timestamp'], 'POST', '/ncc/keywords'));
    });
  });

  it('live 실패(400)는 ok:false + 한국어 오류, 요청 요약 유지', async () => {
    const http = fakeHttp([
      { method: 'GET', match: '/ncc/keywords/', reply: { data: { nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, bidAmt: 900 } } },
      { method: 'PUT', match: '/ncc/keywords/', reply: { status: 400, data: { code: 1002, title: 'Invalid parameter', detail: 'bidAmt' } } },
    ]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({}));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/요청 오류 \(키워드 입찰가 변경, HTTP 400\).*Invalid parameter/);
    expect((r.request as { steps: unknown[] }).steps).toHaveLength(2);
  });
});

describe('정의', () => {
  it('카탈로그 필드 · 능력 · verifiedLive=false · 스키마 기본값', () => {
    expect(connector.verifiedLive).toBe(false);
    expect(connector.docsUrl).toMatch(/^https:\/\/naver\.github\.io\/searchad-apidoc/);
    expect(connector.credentialFields.map((f) => [f.key, f.secret])).toEqual([['apiKey', true], ['secretKey', true], ['customerId', false]]);
    expect(connector.credentialFields.every((f) => /[가-힣]/.test(f.label) && !!f.help)).toBe(true);
    expect(connector.capabilities.writes).toEqual(['bid', 'budget', 'status', 'keyword_add']);
    expect(connector.capabilities.reads).not.toContain('searchTermDaily');
    expect(connector.credentialsSchema.parse({ apiKey: 'abcdefgh1', secretKey: 'abcdefgh2', customerId: 1234567 })).toEqual({ apiKey: 'abcdefgh1', secretKey: 'abcdefgh2', customerId: '1234567' });
    expect(connector.settingsSchema.parse({})).toMatchObject({ conversionMetric: 'purchase', costBasis: 'vat_included', keywordDays: 31, hourlyDays: 7, allowDrift: false });
  });
});
