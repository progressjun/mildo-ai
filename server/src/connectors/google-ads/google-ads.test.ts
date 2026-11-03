/** Google Ads 커넥터 — OAuth 토큰 · 헤더 · GAQL 정규화(micros · KST) · 오류 매핑 · mutate 반영(dry_run · live). 실제 네트워크 없음. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connector, QUERIES } from './index';
import { GoogleAdsClient, _resetGoogleTokenCacheForTest, describeGoogleError } from './client';
import { googleTarget, micros, toMicros } from './normalize';
import { CUSTOMER, googleRoutes } from './fixtures';
import { fakeCtx, fakeHttp, type FakeRoute } from '../naver-sa/fake-http';
import { setNowForTest } from '../../lib/time';
import type { ChangeRequest } from '@/core/types';

const CREDS = { clientId: '1234567890-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret', refreshToken: '1//0test-refresh-token', customerId: '123-456-7890' };
const NOW = Date.parse('2026-11-02T05:30:00Z'); // 14:30 KST
const TODAY = '2026-11-02';

beforeAll(() => setNowForTest(NOW));
afterAll(() => setNowForTest(null));
beforeEach(() => _resetGoogleTokenCacheForTest());

const change = (p: Partial<ChangeRequest>): ChangeRequest => ({
  id: 'c1', createdAt: '2026-11-02T05:00:00Z', module: 'adpilot', kind: 'bid', target: '수면밀도 입찰가', targetId: 'gads-kw-5001-9001',
  before: 1500, after: 1700, reason: 't', requestedBy: 'AD Pilot', approver: 'AE', status: 'approved', history: [], ...p,
});
const search = (req: { body?: unknown }) => String((req.body as { query?: string })?.query ?? '');

describe('인증 · 헤더', () => {
  it('갱신 토큰 → 액세스 토큰(form), Bearer · login-customer-id(하이픈 제거) · 개발자 토큰은 값이 있을 때만, 토큰 캐시', async () => {
    const http = fakeHttp(googleRoutes({ today: TODAY }));
    const g = new GoogleAdsClient({ http }, { ...CREDS, customerId: '1234567890', loginCustomerId: '987-654-3210' }, { now: () => NOW });
    await g.search(QUERIES.customer, 'x');
    await g.search(QUERIES.customer, 'y');
    const token = http.callsTo('oauth2/v3/token');
    expect(token).toHaveLength(1);
    expect(token[0]).toMatchObject({ method: 'POST', bodyType: 'form', body: { grant_type: 'refresh_token', client_id: CREDS.clientId, client_secret: CREDS.clientSecret, refresh_token: CREDS.refreshToken } });
    const s = http.callsTo('googleAds:searchStream')[0];
    expect(s.url).toBe(`https://googleads.googleapis.com/v26/customers/${CUSTOMER}/googleAds:searchStream`);
    expect(s.headers).toMatchObject({ Authorization: 'Bearer ya29.test-access-token', 'login-customer-id': '9876543210' });
    expect(s.headers?.['developer-token']).toBeUndefined();
    expect(s.body).toEqual({ query: QUERIES.customer });

    const g2 = new GoogleAdsClient({ http }, { ...CREDS, customerId: '1234567890', developerToken: 'legacy-dev-token' }, { now: () => NOW, version: 'v25' });
    expect(g2.headers('t')['developer-token']).toBe('legacy-dev-token');
    expect(g2.url('/x')).toContain('/v25/customers/1234567890/x');
  });

  it('invalid_grant → 갱신 토큰 만료 안내, test()는 ok:false', async () => {
    const http = fakeHttp([{ match: 'oauth2/v3/token', reply: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } }]);
    const r = await connector.test(fakeCtx(CREDS, {}, http));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Google Ads 인증 실패.*갱신 토큰이 만료/);
  });

  it('401 UNAUTHENTICATED · Test 등급 프로젝트(CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION) · 할당량 오류 해석', () => {
    expect(describeGoogleError(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } })).toMatchObject({ kind: 'auth' });
    const proj = describeGoogleError(403, [{ error: { code: 403, status: 'PERMISSION_DENIED', message: 'x', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'not approved' }] }] } }]);
    expect(proj).toMatchObject({ kind: 'permission', code: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' });
    expect(proj!.detail).toMatch(/Explorer 등급/);
    expect(describeGoogleError(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, message: 'Too many requests' }] }] } })).toMatchObject({ kind: 'rate' });
  });
});

describe('수집 (fetch)', () => {
  it('일별 · 시간대 · 캠페인 · 키워드 · 검색어 · 계정 — micros ÷ 1e6, 오늘 이후 잘림, 검색어 합산', async () => {
    const http = fakeHttp(googleRoutes({ today: TODAY }));
    const b = await connector.fetch(fakeCtx(CREDS, { brandTerms: ['수면밀도'], keywordDays: 2, hourlyDays: 2 }, http), { from: '2026-10-30', to: '2026-11-30' });

    expect(b.mediaDaily!.map((r) => r.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(b.mediaDaily![2]).toEqual({ date: '2026-11-01', media: 'google', impressions: 10001, clicks: 301, cost: 150001, conversions: 4.5, revenue: 1234568 });
    expect(search(http.callsTo('searchStream').find((c) => search(c).startsWith('SELECT segments.date, metrics'))!)).toContain("BETWEEN '2026-10-30' AND '2026-11-02'");

    // 시간대: 최근 2일, 오늘은 14시 이후 제외
    expect(b.mediaHourly!.map((r) => `${r.date} ${r.hour}`)).toEqual(['2026-11-01 0', '2026-11-01 13', '2026-11-01 22', '2026-11-02 0', '2026-11-02 13']);
    expect(b.mediaHourly![0]).toMatchObject({ cost: 2500, revenue: 100000, conversions: 0.5 });

    const cmp = Object.fromEntries(b.campaigns!.map((c) => [c.id, c]));
    expect(cmp['gads-cmp-111']).toEqual({ id: 'gads-cmp-111', media: 'google', name: '브랜드 검색', intent: 'brand', dailyBudget: 300000, spentToday: 45679, status: 'on', hourOfData: 14 });
    expect(cmp['gads-cmp-222'].status).toBe('limited');
    expect(cmp['gads-cmp-333']).toMatchObject({ status: 'off', dailyBudget: 0 });

    const kw = Object.fromEntries(b.keywords!.map((k) => [k.id, k]));
    expect(kw['gads-kw-5001-9001']).toMatchObject({ text: '수면밀도', adgroup: 'Google · 브랜드', isBrand: true, bid: 1500, maxBid: 3000, impressionShareLost: 0.37, status: 'on', landing: 'https://mildo.kr', avgRank: 0 });
    expect(kw['gads-kw-5002-9002']).toMatchObject({ bid: 800, status: 'off', intent: 'brand', impressionShareLost: 0 });
    expect(b.keywordDaily).toEqual([{ date: '2026-11-02', keywordId: 'gads-kw-5001-9001', impressions: 500, clicks: 40, cost: 61000, conversions: 2, revenue: 900000, avgRank: null }]);
    expect(b.searchTermDaily).toEqual([{ date: '2026-11-02', term: '수면밀도 매트리스', impressions: 80, clicks: 7, cost: 10000, conversions: 1, revenue: 500000 }]);
    expect(b.accounts![0]).toMatchObject({ id: `gads-${CUSTOMER}`, media: 'google', balance: -1, autoCharge: 'postpaid', avgDailySpend: 100000 });
    expect(b.warnings!.map((w) => w.code)).toEqual(['keyword_window', 'max_bid_default', 'automated_bidding']);
    expect(search(http.callsTo('searchStream').find((c) => search(c).includes('FROM search_term_view'))!)).toContain("BETWEEN '2026-11-01' AND '2026-11-02'");
  });

  it('통화 · 시간대가 KRW · Asia/Seoul이 아니면 경고, intraday는 키워드 · 검색어 생략', async () => {
    const http = fakeHttp(googleRoutes({ today: TODAY, currency: 'USD', timeZone: 'America/New_York' }));
    const b = await connector.fetch(fakeCtx(CREDS, {}, http), { from: TODAY, to: TODAY }, { intradayDate: TODAY });
    expect(b.warnings!.map((w) => w.code)).toEqual(expect.arrayContaining(['currency_not_krw', 'timezone_not_kst']));
    expect(b.keywords).toBeUndefined();
    expect(b.searchTermDaily).toBeUndefined();
    expect(http.calls.some((c) => search(c).includes('FROM ad_group_criterion'))).toBe(false);
    expect(b.mediaDaily).toHaveLength(1);
  });

  it('searchStream 배열 안의 오류 객체 · HTTP 403 → 한국어 메시지', async () => {
    const http = fakeHttp([
      { match: 'oauth2/v3/token', reply: { data: { access_token: 't', expires_in: 3600 } } },
      { match: 'searchStream', reply: { status: 403, data: [{ error: { code: 403, status: 'PERMISSION_DENIED', message: "User doesn't have permission to access customer." } }] } },
    ]);
    await expect(connector.fetch(fakeCtx(CREDS, {}, http), { from: TODAY, to: TODAY })).rejects.toThrow(/Google Ads 권한 없음.*login-customer-id/);
    const mid = fakeHttp([
      { match: 'oauth2/v3/token', reply: { data: { access_token: 't', expires_in: 3600 } } },
      { match: 'searchStream', reply: { data: [{ results: [] }, { error: { code: 500, status: 'INTERNAL', message: 'Internal error encountered.' } }] } },
    ]);
    const r = await connector.test(fakeCtx(CREDS, {}, mid));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/서버 오류/);
  });
});

describe('반영 (apply)', () => {
  it('대상 id 해석 · 금액 변환', () => {
    expect(googleTarget('gads-kw-5001-9001')).toEqual({ type: 'keyword', adGroupId: '5001', criterionId: '9001' });
    expect(googleTarget('budget:gads-cmp-111:gads-cmp-222')).toEqual({ type: 'campaign', campaignId: '111' });
    expect(googleTarget('cmp-a001-01-1')).toBeNull();
    expect(toMicros(1700)).toBe('1700000000');
    expect(micros('1700000000')).toBe(1700);
  });

  it('dry_run 입찰가: 네트워크 없이 사전 조회 GAQL → adGroupCriteria:mutate(updateMask cpcBidMicros) 단계', async () => {
    const http = fakeHttp([]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http, { dryRun: true }), change({}));
    expect(http.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, appliedValue: 1700 });
    const steps = (r.request as { steps: { url: string; body: { operations?: unknown[]; query?: string } }[] }).steps;
    expect(steps[0].body.query).toContain(`ad_group_criterion.resource_name = 'customers/${CUSTOMER}/adGroupCriteria/5001~9001'`);
    expect(steps[1].url).toBe(`https://googleads.googleapis.com/v26/customers/${CUSTOMER}/adGroupCriteria:mutate`);
    expect(steps[1].body).toEqual({
      operations: [{ updateMask: 'cpcBidMicros', update: { resourceName: `customers/${CUSTOMER}/adGroupCriteria/5001~9001`, cpcBidMicros: '1700000000' } }],
      partialFailure: false, validateOnly: false, responseContentType: 'MUTABLE_RESOURCE',
    });
    expect(JSON.stringify(r.request)).not.toContain(CREDS.refreshToken);
  });

  const preRoutes = (pre: object[], mutateReply: FakeRoute['reply']): FakeRoute[] => [
    { match: 'oauth2/v3/token', reply: { data: { access_token: 'ya29.live', expires_in: 3600 } } },
    { match: 'googleAds:searchStream', reply: { data: [{ results: pre }] } },
    { match: ':mutate', reply: mutateReply },
  ];

  it('live 입찰가: 수동 입찰이면 mutate, 응답의 cpcBidMicros를 반영 값으로 · 자동 입찰이면 멈춤', async () => {
    const http = fakeHttp(preRoutes(
      [{ campaign: { biddingStrategyType: 'MANUAL_CPC' }, adGroupCriterion: { cpcBidMicros: '1500000000', status: 'ENABLED' } }],
      { data: { results: [{ resourceName: `customers/${CUSTOMER}/adGroupCriteria/5001~9001`, adGroupCriterion: { cpcBidMicros: '1700000000' } }] } },
    ));
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({}));
    expect(r).toMatchObject({ ok: true, appliedValue: 1700 });
    expect(http.callsTo(':mutate')[0].headers?.Authorization).toBe('Bearer ya29.live');

    const auto = fakeHttp(preRoutes([{ campaign: { biddingStrategyType: 'TARGET_ROAS' }, adGroupCriterion: { cpcBidMicros: '1500000000' } }], { data: {} }));
    const r2 = await connector.apply!(fakeCtx(CREDS, {}, auto), change({}));
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/자동 입찰 전략\(TARGET_ROAS\)/);
    expect(auto.callsTo(':mutate')).toHaveLength(0);
  });

  it('live 일 예산: 사전 조회한 예산 리소스로 campaignBudgets:mutate · 공유 예산 · 기간 예산 · 값 불일치는 멈춤', async () => {
    const ok = fakeHttp(preRoutes(
      [{ campaign: { id: '111' }, campaignBudget: { resourceName: `customers/${CUSTOMER}/campaignBudgets/777`, amountMicros: '300000000000', explicitlyShared: false, referenceCount: '1', period: 'DAILY' } }],
      (req) => ({ data: { results: [{ resourceName: 'x', campaignBudget: { amountMicros: ((req.body as { operations: { update: { amountMicros: string } }[] }).operations[0].update.amountMicros) } }] } }),
    ));
    const r = await connector.apply!(fakeCtx(CREDS, {}, ok), change({ kind: 'budget', targetId: 'budget:gads-cmp-111:', before: 300000, after: 360000 }));
    expect(r).toMatchObject({ ok: true, appliedValue: 360000 });
    expect(ok.callsTo('campaignBudgets:mutate')[0].body).toMatchObject({ operations: [{ updateMask: 'amountMicros', update: { resourceName: `customers/${CUSTOMER}/campaignBudgets/777`, amountMicros: '360000000000' } }] });
    expect(search(ok.callsTo('searchStream')[0])).toContain('WHERE campaign.id = 111');

    for (const [budget, re] of [
      [{ resourceName: 'b', amountMicros: '300000000000', explicitlyShared: true, referenceCount: '3', period: 'DAILY' }, /공유 예산\(캠페인 3개/],
      [{ resourceName: 'b', amountMicros: '300000000000', period: 'CUSTOM_PERIOD' }, /기간 예산/],
      [{ resourceName: 'b', amountMicros: '450000000000', period: 'DAILY' }, /요청 시점 값\(300,000원\)과 다릅니다/],
    ] as const) {
      const http = fakeHttp(preRoutes([{ campaignBudget: budget }], { data: {} }));
      const x = await connector.apply!(fakeCtx(CREDS, {}, http), change({ kind: 'budget', targetId: 'gads-cmp-111', before: 300000, after: 360000 }));
      expect(x.ok).toBe(false);
      expect(x.error).toMatch(re);
      expect(http.callsTo(':mutate')).toHaveLength(0);
    }
  });

  it('상태: 캠페인 PAUSED · 키워드 ENABLED (updateMask status), mutate 400 → ok:false 한국어', async () => {
    const http = fakeHttp(preRoutes([], { data: { results: [{ resourceName: 'r', campaign: { status: 'PAUSED' } }] } }));
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({ kind: 'status', targetId: 'gads-cmp-111', before: 'on', after: 'off' }));
    expect(r).toMatchObject({ ok: true, appliedValue: 'off' });
    expect(http.callsTo('campaigns:mutate')[0].body).toMatchObject({ operations: [{ updateMask: 'status', update: { resourceName: `customers/${CUSTOMER}/campaigns/111`, status: 'PAUSED' } }] });

    const dry = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([]), { dryRun: true }), change({ kind: 'status', targetId: 'gads-kw-5001-9001', after: 'on' }));
    expect((dry.request as { steps: { body: unknown }[] }).steps[0].body).toMatchObject({ operations: [{ update: { status: 'ENABLED' } }] });

    const bad = fakeHttp(preRoutes([], { status: 400, data: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.', details: [{ errors: [{ errorCode: { fieldError: 'IMMUTABLE_FIELD' }, message: 'The field is immutable.' }] }] } } }));
    const x = await connector.apply!(fakeCtx(CREDS, {}, bad), change({ kind: 'status', targetId: 'gads-cmp-111', after: 'off' }));
    expect(x.ok).toBe(false);
    expect(x.error).toMatch(/요청 오류.*fieldError=IMMUTABLE_FIELD/);
  });
});

describe('정의', () => {
  it('자격증명 스키마(고객 ID 하이픈 제거 · 10자리) · 필드 안내 · verifiedLive=false', () => {
    const parsed = connector.credentialsSchema.parse(CREDS);
    expect(parsed.customerId).toBe('1234567890');
    expect(parsed.loginCustomerId).toBeUndefined();
    expect(parsed.developerToken).toBeUndefined();
    expect(connector.credentialsSchema.safeParse({ ...CREDS, customerId: '12-34' }).success).toBe(false);
    expect(connector.credentialsSchema.parse({ ...CREDS, loginCustomerId: '' }).loginCustomerId).toBeUndefined();
    expect(connector.verifiedLive).toBe(false);
    expect(connector.credentialFields.find((f) => f.key === 'developerToken')!.help).toMatch(/2026-09-09/);
    expect(connector.capabilities).toMatchObject({ writes: ['bid', 'budget', 'status'], intraday: true });
    expect(connector.settingsSchema.parse({})).toMatchObject({ apiVersion: 'v26', hourlyDays: 35, emitKeywords: true });
  });
});
