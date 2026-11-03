/**
 * 카페24 커넥터 — OAuth(인증 코드 교환 · 갱신 · 회전 저장 · 401 재시도 · 동시 갱신 묶음) · 주문 offset 페이지 · 상한 분할 ·
 * 결제일 KST · 취소/반품 품주 제외 · Analytics 방문/조회/장바구니 · 상품/품목 재고 · 혜택 프로모션 · 오류 해석. 네트워크 없음.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connector, credentialsSchema, fetchCafe24, settingsSchema } from './index';
import { Cafe24Client, _resetCafe24InflightForTest, cafe24AuthorizeUrl, describeCafe24Error, exchangeCafe24AuthCode, findRows } from './client';
import { cafe24OrderLine } from './normalize';
import { CAFE24_CREDS, CAFE24_ORDERS, cafe24Handler, cafe24State, order } from './fixtures';
import { combine, fakeCtx, handlerFetch, handlerHttp, type Handler } from '../naver-commerce/sales-testkit';
import { createConnectorHttp } from '../http';
import type { Cafe24Order } from './client';
import { setNowForTest } from '../../lib/time';

const NOW = Date.parse('2026-11-03T10:00:00+09:00');
const iso = (ms: number) => new Date(ms).toISOString();
beforeEach(() => { setNowForTest(NOW); _resetCafe24InflightForTest(); });
afterEach(() => setNowForTest(null));

function setup(o: { creds?: Record<string, unknown>; settings?: Record<string, unknown>; state?: ReturnType<typeof cafe24State>; extra?: Handler; orders?: Parameters<typeof cafe24Handler>[1] } = {}) {
  const st = o.state ?? cafe24State();
  const h = o.extra ? combine(o.extra, cafe24Handler(st, o.orders)) : cafe24Handler(st, o.orders);
  const http = handlerHttp(h);
  const saved: Record<string, unknown>[] = [];
  const ctx = fakeCtx(o.creds ?? CAFE24_CREDS, o.settings ?? {}, http, { saved, connectionId: 'conn-c24' });
  return { st, http, saved, ctx };
}

describe('OAuth 2.0', () => {
  it('인증 코드 교환: Basic 인증 · form(grant_type · code · redirect_uri) → 토큰 저장(인증 코드 삭제 · 만료 시각은 서버 기준 재계산)', async () => {
    const st = cafe24State({ authCode: 'auth-code-1' });
    const creds = { mallId: 'mildomall', clientId: CAFE24_CREDS.clientId, clientSecret: CAFE24_CREDS.clientSecret, authCode: 'auth-code-1', redirectUri: 'https://app.mildo.kr/oauth/cafe24' };
    const { http, saved, ctx } = setup({ creds, state: st, settings: { fetchProducts: false, fetchPromotions: false, fetchAnalytics: false } });
    await fetchCafe24(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(st.tokenCalls).toHaveLength(1);
    expect(st.tokenCalls[0].auth).toBe(`Basic ${Buffer.from('BrIfqEKoPxeE:c24-secret-xYz789').toString('base64')}`);
    expect(st.tokenCalls[0].body).toEqual({ grant_type: 'authorization_code', code: 'auth-code-1', redirect_uri: 'https://app.mildo.kr/oauth/cafe24' });
    expect(http.calls[0].url.toString()).toBe('https://mildomall.cafe24api.com/api/v2/oauth/token');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      mallId: 'mildomall', clientId: 'BrIfqEKoPxeE', clientSecret: 'c24-secret-xYz789', redirectUri: 'https://app.mildo.kr/oauth/cafe24',
      accessToken: 'c24-access-1001', accessTokenExpiresAt: iso(NOW + 2 * 3600_000),
      refreshToken: 'c24-refresh-1001', refreshTokenExpiresAt: iso(NOW + 14 * 86_400_000),
      scopes: ['mall.read_order', 'mall.read_product', 'mall.read_store', 'mall.read_promotion', 'mall.read_analytics'],
    });
    expect(saved[0]).not.toHaveProperty('authCode');
    // 이후 API 호출은 Bearer + 버전 헤더
    const api = http.calls.find((c) => c.url.pathname === '/api/v2/admin/orders')!;
    expect(api.headers.authorization).toBe('Bearer c24-access-1001');
    expect(api.headers['x-cafe24-api-version']).toBe('2026-09-01');
  });

  it('유효한 액세스 토큰은 그대로 쓰고, 만료 5분 전이면 갱신 토큰으로 갱신 · 새 갱신 토큰 즉시 저장(회전)', async () => {
    const st = cafe24State({ access: 'live-access' });
    const valid = { ...CAFE24_CREDS, accessToken: 'live-access', accessTokenExpiresAt: iso(NOW + 60 * 60_000) };
    const a = setup({ creds: valid, state: st, settings: { fetchProducts: false, fetchPromotions: false, fetchAnalytics: false } });
    await fetchCafe24(a.ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(st.tokenCalls).toHaveLength(0);

    const expiring = { ...CAFE24_CREDS, accessToken: 'live-access', accessTokenExpiresAt: iso(NOW + 4 * 60_000) };
    const b = setup({ creds: expiring, state: st, settings: { fetchProducts: false, fetchPromotions: false, fetchAnalytics: false } });
    const client = new Cafe24Client(b.ctx, expiring as never, { now: () => NOW });
    expect(await client.accessToken()).toBe('c24-access-1001');
    expect(st.tokenCalls[0].body).toEqual({ grant_type: 'refresh_token', refresh_token: 'c24-refresh-0001' });
    expect(b.saved[0]).toMatchObject({ refreshToken: 'c24-refresh-1001', accessToken: 'c24-access-1001' });
    // 다음 갱신은 회전된 새 갱신 토큰으로
    expect(await client.accessToken(true)).toBe('c24-access-1002');
    expect(st.tokenCalls[1].body).toEqual({ grant_type: 'refresh_token', refresh_token: 'c24-refresh-1001' });
  });

  it('API 401이면 강제 갱신 후 한 번 더 부른다', async () => {
    const st = cafe24State({ access: 'server-side-new' });
    const stale = { ...CAFE24_CREDS, accessToken: 'revoked-access', accessTokenExpiresAt: iso(NOW + 60 * 60_000) };
    const { saved, ctx } = setup({ creds: stale, state: st });
    const client = new Cafe24Client(ctx, stale as never, { now: () => NOW });
    expect((await client.store()).shop_name).toBe('수면밀도 공식몰');
    expect(st.tokenCalls).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  it('새 인증 코드가 있으면 먼저 교환하고, 코드가 만료됐으면 갱신 토큰으로 이어서 시도한다', async () => {
    const st = cafe24State({ authCode: 'fresh-code' });
    const creds = { ...CAFE24_CREDS, authCode: 'fresh-code', redirectUri: 'https://app.mildo.kr/cb' };
    const a = setup({ creds, state: st });
    await new Cafe24Client(a.ctx, creds as never, { now: () => NOW }).accessToken();
    expect(st.tokenCalls.map((c) => c.body.grant_type)).toEqual(['authorization_code']);
    expect(a.saved[0]).not.toHaveProperty('authCode');

    const st2 = cafe24State(); // 서버에는 그 코드가 없다(1분 경과)
    _resetCafe24InflightForTest();
    const b = setup({ creds: { ...creds, authCode: 'stale-code' }, state: st2 });
    expect(await new Cafe24Client(b.ctx, { ...creds, authCode: 'stale-code' } as never, { now: () => NOW }).accessToken()).toBe('c24-access-1001');
    expect(st2.tokenCalls.map((c) => c.body.grant_type)).toEqual(['authorization_code', 'refresh_token']);
    expect(b.saved[0]).not.toHaveProperty('authCode');
  });

  it('같은 커넥션의 동시 갱신은 한 번으로 묶는다 (갱신 토큰 1회용)', async () => {
    const st = cafe24State();
    const { ctx } = setup({ state: st });
    const c1 = new Cafe24Client(ctx, CAFE24_CREDS as never, { now: () => NOW });
    const c2 = new Cafe24Client(ctx, CAFE24_CREDS as never, { now: () => NOW });
    const [t1, t2] = await Promise.all([c1.accessToken(), c2.accessToken()]);
    expect(t1).toBe('c24-access-1001');
    expect(t2).toBe('c24-access-1001');
    expect(st.tokenCalls).toHaveLength(1);
  });

  it('갱신 토큰 만료 · invalid_grant · 인증 정보 없음 → 한국어 인증 실패', async () => {
    // 저장된 만료 시각이 지났고 서버도 거절 → 만료 안내
    const expired = { ...CAFE24_CREDS, refreshTokenExpiresAt: iso(NOW - 1000) };
    const a = setup({ creds: expired, state: cafe24State({ refresh: 'rotated-elsewhere' }) });
    const r1 = await connector.test(a.ctx);
    expect(r1.ok).toBe(false);
    expect(r1.message).toMatch(/갱신 토큰이 만료/);
    // 만료 시각이 지났어도 새로 붙여 넣은 갱신 토큰이면 서버가 받아 준다
    const pasted = setup({ creds: { ...CAFE24_CREDS, refreshTokenExpiresAt: iso(NOW - 1000) } });
    expect((await connector.test(pasted.ctx)).ok).toBe(true);

    const b = setup({ creds: { ...CAFE24_CREDS, refreshToken: 'already-used-refresh' } });
    const r2 = await connector.test(b.ctx);
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/인증 실패.*앱 승인을 다시/);
    expect(r2.message).not.toContain('c24-secret-xYz789');

    expect(describeCafe24Error(401, { error: 'invalid_client', error_description: 'x' })).toMatchObject({ kind: 'auth' });
    expect(describeCafe24Error(403, { error: { code: 403, message: 'scope' } })?.detail).toMatch(/권한 범위/);
  });

  it('OAuth 콜백용 교환 도우미: 갱신 토큰이 있어도 받은 코드를 먼저 교환하고 저장한다', async () => {
    const st = cafe24State({ authCode: 'callback-code' });
    const { saved, ctx } = setup({ state: st });
    const next = await exchangeCafe24AuthCode(ctx, CAFE24_CREDS, 'callback-code', 'https://app.mildo.kr/api/oauth/cafe24/callback', { now: () => NOW });
    expect(st.tokenCalls.map((c) => c.body)).toEqual([{ grant_type: 'authorization_code', code: 'callback-code', redirect_uri: 'https://app.mildo.kr/api/oauth/cafe24/callback' }]);
    expect(next).toMatchObject({ accessToken: 'c24-access-1001', refreshToken: 'c24-refresh-1001', redirectUri: 'https://app.mildo.kr/api/oauth/cafe24/callback' });
    expect(next).not.toHaveProperty('authCode');
    expect(saved).toEqual([next]);
  });

  it('인증 코드 요청 URL (문서 형식: response_type · client_id · state · redirect_uri · scope 공백 구분)', () => {
    const u = new URL(cafe24AuthorizeUrl({ mallId: 'mildomall', clientId: 'cid', redirectUri: 'https://app.mildo.kr/cb', state: 'xyz' }));
    expect(`${u.origin}${u.pathname}`).toBe('https://mildomall.cafe24api.com/api/v2/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'cid', state: 'xyz', redirect_uri: 'https://app.mildo.kr/cb', scope: 'mall.read_order mall.read_product mall.read_store mall.read_promotion mall.read_analytics' });
  });

  it('자격증명 검증: 갱신 토큰 또는 인증 코드 필요, 인증 코드에는 Redirect URI 필요, mall_id 소문자', () => {
    const base = { mallId: 'MildoMall', clientId: 'BrIfqEKoPxeE', clientSecret: 'secret-1' };
    expect(credentialsSchema.safeParse(base).success).toBe(false);
    expect(credentialsSchema.safeParse({ ...base, authCode: 'code-123' }).success).toBe(false);
    expect(credentialsSchema.safeParse({ ...base, authCode: 'code-123', redirectUri: 'https://app.mildo.kr/cb' }).success).toBe(true);
    expect(credentialsSchema.safeParse({ ...base, refreshToken: 'refresh-1' }).data?.mallId).toBe('mildomall');
  });
});

describe('주문 → 판매 채널 일별', () => {
  it('결제일(pay_date) 구간 · embed=items · 취소/미결제 주문과 C1/C2/C3 품주 제외 · 교환 유지 · Analytics 방문/조회/장바구니/광고 매출', async () => {
    const { http, ctx } = setup({ settings: { fetchProducts: false, fetchPromotions: false } });
    const b = await fetchCafe24(ctx, { from: '2026-10-31', to: '2026-11-02' });
    expect(b.salesDaily).toEqual([
      { date: '2026-10-31', channel: 'own_mall', visitors: 0, detailViews: 2500, carts: 240, orders: 0, revenue: 0, adAttributedRevenue: 0 },
      { date: '2026-11-01', channel: 'own_mall', visitors: 5400, detailViews: 2500, carts: 240, orders: 2, revenue: 1_230_000, adAttributedRevenue: 940_000 },
      // Analytics 광고 매출 1,400,000 > 주문 API 매출 1,190,000 → 매출로 자른다
      { date: '2026-11-02', channel: 'own_mall', visitors: 6100, detailViews: 3400, carts: 290, orders: 1, revenue: 1_190_000, adAttributedRevenue: 1_190_000 },
    ]);
    const ad = http.calls.filter((c) => c.url.pathname === '/visitpaths/adsales');
    expect(ad.map((c) => `${c.url.origin} ${c.url.searchParams.get('start_date')}~${c.url.searchParams.get('end_date')} ${c.url.searchParams.get('mall_id')}`)).toEqual([
      'https://ca-api.cafe24data.com 2026-10-31~2026-10-31 mildomall', 'https://ca-api.cafe24data.com 2026-11-01~2026-11-01 mildomall', 'https://ca-api.cafe24data.com 2026-11-02~2026-11-02 mildomall',
    ]);
    const oc = http.calls.find((c) => c.url.pathname === '/api/v2/admin/orders')!;
    expect(Object.fromEntries(oc.url.searchParams)).toEqual({ shop_no: '1', start_date: '2026-10-31', end_date: '2026-11-02', date_type: 'pay_date', embed: 'items', limit: '500', offset: '0' });
    const vc = http.calls.find((c) => c.url.pathname === '/visitors/view')!;
    expect(vc.url.origin).toBe('https://ca-api.cafe24data.com');
    expect(Object.fromEntries(vc.url.searchParams)).toMatchObject({ mall_id: 'mildomall', shop_no: '1', start_date: '2026-10-31', end_date: '2026-11-02', format_type: 'day', limit: '1000', offset: '0' });
    expect(http.calls.filter((c) => c.url.pathname === '/products/view').map((c) => c.url.searchParams.get('start_date'))).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(b.warnings).toBeUndefined();
  });

  it('gross = (판매가 + 옵션가) × 수량', () => {
    expect(cafe24OrderLine(CAFE24_ORDERS[0], 'gross')).toEqual({ date: '2026-11-01', orderId: '20261101-0000001', revenue: 990_000, items: 1 });
    expect(cafe24OrderLine(CAFE24_ORDERS[1], 'net')).toBeNull(); // canceled T
    expect(cafe24OrderLine(CAFE24_ORDERS[3], 'net')).toBeNull(); // 반품 품주만
    expect(cafe24OrderLine({ ...CAFE24_ORDERS[2], items: undefined }, 'net')).toMatchObject({ revenue: 290_000, items: 0 }); // 품주 없으면 주문 금액
  });

  it('offset 페이지: limit만큼 꽉 차면 다음 offset', async () => {
    const many = Array.from({ length: 25 }, (_, i) => order({ id: `20261102-${String(i).padStart(7, '0')}`, paid: '2026-11-02T12:00:00+09:00', items: [] }));
    const { http, ctx } = setup({ settings: { fetchProducts: false, fetchPromotions: false, fetchAnalytics: false, pageSize: 10 }, orders: { orders: many.map((o) => ({ ...o, actual_order_amount: { payment_amount: '1000' } })) } });
    const b = await fetchCafe24(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(http.calls.filter((c) => c.url.pathname === '/api/v2/admin/orders').map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '10', '20']);
    expect(b.salesDaily?.[0]).toMatchObject({ orders: 25, revenue: 25_000 });
    expect(b.warnings?.map((w) => w.code)).toEqual(['funnel_disabled']);
  });

  it('offset 상한(15,000)에 닿으면 그 구간을 하루씩 다시 나눠 빠짐없이 센다 (주문번호 중복 제거)', async () => {
    const { http, ctx } = setup({ settings: { fetchProducts: false, fetchPromotions: false, fetchAnalytics: false, pageSize: 1000 }, orders: { bulkPerDay: 8_500 } });
    const b = await fetchCafe24(ctx, { from: '2026-11-01', to: '2026-11-02' });
    expect(b.salesDaily?.map((r) => [r.date, r.orders, r.revenue])).toEqual([['2026-11-01', 8_500, 8_500], ['2026-11-02', 8_500, 8_500]]);
    const windows = http.calls.filter((c) => c.url.pathname === '/api/v2/admin/orders').map((c) => `${c.url.searchParams.get('start_date')}~${c.url.searchParams.get('end_date')}`);
    expect(windows.filter((w) => w === '2026-11-01~2026-11-02')).toHaveLength(16); // offset 0 ~ 15000
    expect(windows.filter((w) => w === '2026-11-01~2026-11-01')).toHaveLength(9);
  });

  it('Analytics 권한이 없으면 방문 지표 0 + 경고, 주문 · 매출은 그대로', async () => {
    const st = cafe24State({ analytics: 'forbidden' });
    const { ctx } = setup({ state: st, settings: { fetchProducts: false, fetchPromotions: false } });
    const b = await fetchCafe24(ctx, { from: '2026-11-01', to: '2026-11-01' });
    expect(b.salesDaily?.[0]).toMatchObject({ visitors: 0, detailViews: 0, carts: 0, orders: 2, revenue: 1_230_000 });
    const w = b.warnings?.find((x) => x.code === 'analytics_unavailable');
    expect(w?.message).toMatch(/mall\.read_analytics/);
  });

  it('조회수 · 장바구니는 최근 funnelDays만 (그 이전은 0 + 경고)', async () => {
    const { http, ctx } = setup({ settings: { fetchProducts: false, fetchPromotions: false, funnelDays: 2 } });
    const b = await fetchCafe24(ctx, { from: '2026-11-01', to: '2026-11-02' });
    expect(http.calls.filter((c) => c.url.pathname === '/carts/action').map((c) => c.url.searchParams.get('start_date'))).toEqual(['2026-11-02']);
    expect(b.salesDaily?.[0]).toMatchObject({ date: '2026-11-01', visitors: 5400, detailViews: 0, carts: 0 });
    expect(b.warnings?.map((x) => x.code)).toEqual(['funnel_window']);
  });

  it('Analytics 응답 행 찾기: 감싸는 키 이름과 무관하게 문서 속성으로', () => {
    expect(findRows({ view: [{ date: '2026-11-01', visit_count: 1 }] }, ['date', 'visit_count'])).toHaveLength(1);
    expect(findRows([{ date: '2026-11-01', visit_count: 1 }], ['date', 'visit_count'])).toHaveLength(1);
    expect(findRows({ data: { items: [{ product_no: 1, count: 2 }] } }, ['product_no', 'count'])).toHaveLength(1);
    expect(findRows({ other: [{ x: 1 }] }, ['date', 'visit_count'])).toEqual([]);
  });
});

describe('상품 · 품목 재고 · 혜택', () => {
  it('상품 + 품목(판매가 + 추가금액, 재고 사용 시 수량 > 0) · 판매안함 · 대표 도메인 랜딩 · 기간할인 혜택(12%) · 사은품 혜택은 경고로', async () => {
    const { http, ctx } = setup({ settings: { fetchAnalytics: false } });
    const b = await fetchCafe24(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.products).toEqual([
      { id: 'c24-11', name: '수면밀도 매트리스', landing: 'https://mildo.kr', options: [
        { id: 'P000000K000A', label: '슈퍼싱글', price: 790_000, inStock: true },
        { id: 'P000000K000B', label: '퀸', price: 990_000, inStock: false },
      ] },
      { id: 'c24-12', name: '수면밀도 토퍼', landing: 'https://mildo.kr', options: [{ id: 'P000000L', label: '기본', price: 290_000, inStock: true }] },
      { id: 'c24-13', name: '단종 베개', landing: 'https://mildo.kr', options: [{ id: 'P000000M000A', label: '기본', price: 50_000, inStock: false }] },
    ]);
    // 사은품(PG)은 판매가 대비 할인율이 없어 프로모션에 넣지 않는다 — 0%로 넣으면 Flow가 '할인율 0%' 실패로 거짓 판정
    expect(b.promotions).toEqual([
      { id: 'c24-benefit-3', name: '가을 이사 기획전', channel: 'own_mall', start: '2026-10-20', end: '2026-11-05', discountRate: 12, status: 'live' },
    ]);
    const skipped = b.warnings?.find((w) => w.code === 'promotions_skipped');
    expect(skipped?.message).toMatch(/할인율\(%\)로 나타낼 수 없는 혜택 1건\(사은품 증정 \(PG\)\)/);
    expect(skipped?.detail).toEqual({ count: 1 });
    const pc = http.calls.find((c) => c.url.pathname === '/api/v2/admin/products')!;
    expect(Object.fromEntries(pc.url.searchParams)).toEqual({ shop_no: '1', embed: 'variants', limit: '100' });
  });

  it('상품 URL 템플릿 {productNo}', async () => {
    const { ctx } = setup({ settings: { fetchAnalytics: false, fetchPromotions: false, productUrlTemplate: 'https://mildo.kr/product/detail.html?product_no={productNo}' } });
    const b = await fetchCafe24(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.products?.[0].landing).toBe('https://mildo.kr/product/detail.html?product_no=11');
  });
});

describe('연결 확인 · 정의', () => {
  it('test(): 쇼핑몰 이름 · 어제 결제 주문 · 갱신 토큰 회전 저장', async () => {
    const { saved, ctx } = setup();
    const r = await connector.test(ctx);
    expect(r).toMatchObject({ ok: true, account: '카페24 Admin API 수면밀도 공식몰' });
    expect(r.message).toMatch(/쇼핑몰 수면밀도 공식몰 \(mildomall\) · 어제 결제 주문 1건/);
    expect(r.message).not.toMatch(/승인되지 않은 권한/);
    expect(saved[0]).toMatchObject({ refreshToken: 'c24-refresh-1001' });
  });

  it('권한 범위가 부족하면 test() 메시지에 알린다', async () => {
    const st = cafe24State({ access: 'acc-token-1' });
    const creds = { ...CAFE24_CREDS, accessToken: 'acc-token-1', accessTokenExpiresAt: iso(NOW + 3600_000), scopes: ['mall.read_order', 'mall.read_product', 'mall.read_store'] };
    const { ctx } = setup({ creds, state: st });
    const r = await connector.test(ctx);
    expect(r.message).toMatch(/승인되지 않은 권한: mall\.read_promotion, mall\.read_analytics \(방문자 · 상세 조회 · 장바구니는 0으로 저장\)/);
  });

  it('판매 채널 own_mall · 읽기 전용 · 문서 URL', () => {
    expect(connector).toMatchObject({ provider: 'cafe24', kind: 'sales', channel: 'own_mall', verifiedLive: false });
    expect(connector.docsUrl).toMatch(/^https:\/\/apidocs\.cafe24\.com\//);
    expect(connector.capabilities).toEqual({ reads: ['salesDaily', 'products', 'promotions'], writes: [], intraday: true, maxBackfillDays: 400 });
    expect(connector.credentialFields.filter((f) => f.secret).map((f) => f.key)).toEqual(['clientSecret', 'refreshToken', 'authCode']);
  });
});

/* ---------------- 리뷰 보강: 1회용 토큰 · 이중 집계 · 주소 검사 ---------------- */

const noSnap = { fetchProducts: false, fetchPromotions: false, fetchAnalytics: false };
const it24 = (o: { no: number; status?: string; pay: number; price?: number; qty?: number; original?: number }) => ({
  shop_no: 1, item_no: o.no, order_item_code: `X-${o.no}`, product_no: 11, product_price: o.price ?? o.pay, option_price: 0, quantity: o.qty ?? 1,
  payment_amount: o.pay, status_code: o.status ?? 'N1', ...(o.original !== undefined ? { original_item_no: o.original } : {}),
});
const ord = (id: string, items: ReturnType<typeof it24>[], extra: Partial<Cafe24Order> = {}): Cafe24Order => ({ ...order({ id, paid: '2026-11-02T10:00:00+09:00', items: items as never }), ...extra });

describe('1회용 갱신 토큰 · 인증 코드 (리뷰 보강)', () => {
  it('백필 묶음이 같은 (오래된) 자격증명으로 다시 수집해도 이미 회전된 갱신 토큰을 다시 쓰지 않는다', async () => {
    const st = cafe24State();
    // 백필: 커넥션 행을 한 번 읽어 묶음마다 같은 자격증명(갱신 토큰 R0, 액세스 토큰 없음)으로 수집한다
    const first = setup({ state: st, settings: noSnap });
    await fetchCafe24(first.ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(st.tokenCalls.map((c) => c.body.refresh_token)).toEqual(['c24-refresh-0001']);
    // 2시간 넘게 지나 다음 묶음 — 같은 행(R0)을 들고 오지만 R0은 서버에서 이미 폐기됨
    setNowForTest(NOW + 3 * 3600_000);
    const second = setup({ state: st, settings: noSnap });
    const b = await fetchCafe24(second.ctx, { from: '2026-11-01', to: '2026-11-02' });
    expect(b.salesDaily?.map((r) => r.orders)).toEqual([2, 1]);
    // 두 번째 갱신은 회전된 R1001로 (R0으로 다시 보냈다면 invalid_grant → 백필 실패)
    expect(st.tokenCalls.map((c) => c.body.refresh_token)).toEqual(['c24-refresh-0001', 'c24-refresh-1001']);
    expect(second.saved.at(-1)).toMatchObject({ refreshToken: 'c24-refresh-1002', accessToken: 'c24-access-1002' });
  });

  it('액세스 토큰이 아직 유효해도 새로 넣은 인증 코드(다시 승인)를 먼저 교환한다 — 권한 범위 변경이 바로 반영된다', async () => {
    const st = cafe24State({ access: 'old-access', authCode: 'reapproved-code' });
    const creds = { ...CAFE24_CREDS, accessToken: 'old-access', accessTokenExpiresAt: iso(NOW + 90 * 60_000), authCode: 'reapproved-code', redirectUri: 'https://app.mildo.kr/cb' };
    const { saved, ctx } = setup({ creds, state: st, settings: noSnap });
    await fetchCafe24(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(st.tokenCalls.map((c) => c.body.grant_type)).toEqual(['authorization_code']);
    expect(saved[0]).toMatchObject({ accessToken: 'c24-access-1001' });
    expect(saved[0]).not.toHaveProperty('authCode');
  });

  it('지난 인증 코드 + 갱신 토큰 없음 + 유효한 액세스 토큰이면 그 토큰으로 계속한다', async () => {
    const st = cafe24State({ access: 'only-access' });
    const creds = { mallId: 'mildomall', clientId: CAFE24_CREDS.clientId, clientSecret: CAFE24_CREDS.clientSecret, accessToken: 'only-access', accessTokenExpiresAt: iso(NOW + 90 * 60_000), authCode: 'expired-code', redirectUri: 'https://app.mildo.kr/cb' };
    const { ctx } = setup({ creds, state: st, settings: noSnap });
    const b = await fetchCafe24(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.salesDaily?.[0].orders).toBe(1);
    expect(st.tokenCalls).toHaveLength(1); // 코드 교환 한 번만 시도
  });

  it('토큰 요청은 재시도하지 않는다 (retries 0) — 래퍼가 5xx를 재시도하면 이미 소비된 갱신 토큰을 다시 보낸다', async () => {
    const st = cafe24State();
    let tokenHits = 0;
    let storeHits = 0;
    const flaky: Handler = (r) => {
      if (r.url.pathname === '/api/v2/oauth/token') { tokenHits++; return { status: 503, data: { error: { code: 503, message: 'busy' } } }; }
      if (r.url.pathname === '/api/v2/admin/store') { storeHits++; return { status: 503, data: { error: { code: 503, message: 'busy' } } }; }
      return null;
    };
    const http = createConnectorHttp({ fetchImpl: handlerFetch(combine(flaky, cafe24Handler(st))), log: () => {}, maxRetries: 3, timeoutMs: 5_000, sleep: async () => {}, resolveHost: null });
    const ctx = fakeCtx<Record<string, unknown>, Record<string, unknown>>(CAFE24_CREDS, {}, http, { connectionId: 'conn-c24-retry' });
    const client = new Cafe24Client(ctx, CAFE24_CREDS as never, { now: () => NOW });
    expect(client.tokenRequest({ grant_type: 'refresh_token', refresh_token: 'x' })).toMatchObject({ retries: 0 });
    await expect(client.accessToken()).rejects.toMatchObject({ kind: 'server' });
    expect(tokenHits).toBe(1);
    // 일반 조회(멱등)는 래퍼 재시도를 그대로 탄다 (대조)
    const ok = new Cafe24Client(ctx, { ...CAFE24_CREDS, accessToken: 'c24-access-0001', accessTokenExpiresAt: iso(NOW + 3600_000) } as never, { now: () => NOW });
    await expect(ok.store()).rejects.toMatchObject({ kind: 'server' });
    expect(storeHits).toBe(4);
  });
});

describe('자사몰 매출 이중 집계 방지 (리뷰 보강)', () => {
  it('마켓 연동 주문(order_place_id coupang · shopn 등)은 자사몰에서 빼고 경고, 설정으로 끌 수 있다', async () => {
    const orders = [
      ord('M-1', [it24({ no: 1, pay: 500_000 })], { order_place_id: 'coupang', order_place_name: '쿠팡' }),
      ord('M-2', [it24({ no: 1, pay: 300_000 })], { order_place_id: 'shopn', order_place_name: '스마트스토어' }),
      ord('O-1', [it24({ no: 1, pay: 200_000 })], { order_place_id: 'cafe24' }),
      ord('O-2', [it24({ no: 1, pay: 100_000 })], { order_place_id: 'NCHECKOUT' }), // 자사몰에서 네이버페이로 결제
    ];
    const st = cafe24State();
    const a = setup({ state: st, settings: noSnap, orders: { orders } });
    const b = await fetchCafe24(a.ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.salesDaily?.[0]).toMatchObject({ orders: 2, revenue: 300_000 });
    const w = b.warnings?.find((x) => x.code === 'market_orders_excluded');
    expect(w?.message).toMatch(/마켓 연동 주문 2건\(쿠팡 1건, 스마트스토어 1건\)/);
    const off = setup({ state: st, settings: { ...noSnap, excludeMarketOrders: false }, orders: { orders } });
    expect((await fetchCafe24(off.ctx, { from: '2026-11-02', to: '2026-11-02' })).salesDaily?.[0]).toMatchObject({ orders: 4, revenue: 1_100_000 });
  });

  it('교환: 원래 품주(E1)와 새 품주(N2, original_item_no)는 한 번만 센다 — 금액이 둘 다 실려도 · 한쪽만 실려도', () => {
    const both = ord('E-1', [it24({ no: 1, status: 'E1', pay: 990_000 }), it24({ no: 2, status: 'N2', pay: 990_000, original: 1 }), it24({ no: 3, pay: 290_000 })]);
    expect(cafe24OrderLine(both, 'net')).toMatchObject({ revenue: 1_280_000, items: 3 });
    const newOnlyZero = ord('E-2', [it24({ no: 1, status: 'E1', pay: 990_000 }), it24({ no: 2, status: 'N2', pay: 0, price: 990_000, original: 1 })]);
    expect(cafe24OrderLine(newOnlyZero, 'net')).toMatchObject({ revenue: 990_000 });
    expect(cafe24OrderLine(newOnlyZero, 'gross')).toMatchObject({ revenue: 990_000 });
    // 짝이 없는 교환 품주(원래 품주가 다른 주문)는 그대로 센다
    const orphan = ord('E-3', [it24({ no: 5, status: 'N2', pay: 400_000, original: 99 })]);
    expect(cafe24OrderLine(orphan, 'net')).toMatchObject({ revenue: 400_000 });
  });
});

describe('주소 검사 (리뷰 보강)', () => {
  it('쇼핑몰 ID는 DNS 라벨 규칙 — 점 · 슬래시 · @ · 끝 하이픈 · 1자는 거부 (API 호스트를 바꿀 수 없다)', () => {
    const base = { clientId: 'BrIfqEKoPxeE', clientSecret: 'secret-1', refreshToken: 'refresh-1' };
    for (const bad of ['evil.com', 'mall/x', 'mall@evil', 'mall#x', 'abc-', '-abc', 'a', 'mall x', `${'a'.repeat(50)}`, 'mall.cafe24api.com.evil']) {
      expect(credentialsSchema.safeParse({ ...base, mallId: bad }).success, bad).toBe(false);
    }
    for (const good of ['mildomall', 'mildo-mall', 'ab', 'MildoMall2']) expect(credentialsSchema.safeParse({ ...base, mallId: good }).success, good).toBe(true);
  });

  it('상품 URL 템플릿은 https만 (javascript: · data: · http: 거부), 대표 도메인 랜딩도 https', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://mildo.kr/p/{productNo}', 'https://user:pw@mildo.kr/{productNo}', 'mildo.kr/{productNo}']) {
      expect(settingsSchema.safeParse({ productUrlTemplate: bad }).success, bad).toBe(false);
    }
    expect(settingsSchema.safeParse({ productUrlTemplate: 'https://mildo.kr/product/detail.html?product_no={productNo}' }).success).toBe(true);
  });

  it('광고 매체별 매출 조회만 실패하면 광고 경유 매출만 0 + 경고, 방문 · 조회 · 장바구니 · 주문은 그대로', async () => {
    const deny: Handler = (r) => (r.url.pathname === '/visitpaths/adsales' ? { status: 403, data: { error: { code: 403, message: 'not allowed' } } } : null);
    const { http, ctx } = setup({ extra: deny, settings: { fetchProducts: false, fetchPromotions: false } });
    const b = await fetchCafe24(ctx, { from: '2026-11-01', to: '2026-11-02' });
    expect(b.salesDaily?.map((r) => [r.visitors, r.detailViews, r.carts, r.orders, r.adAttributedRevenue])).toEqual([[5400, 2500, 240, 2, 0], [6100, 3400, 290, 1, 0]]);
    expect(b.warnings?.map((w) => w.code)).toEqual(['ad_revenue_unavailable']);
    expect(http.calls.filter((c) => c.url.pathname === '/visitpaths/adsales')).toHaveLength(1); // 실패 후 같은 기간 재호출 안 함
  });
});
