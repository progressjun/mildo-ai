/**
 * 카페24 커넥터 — OAuth(인증 코드 교환 · 갱신 · 회전 저장 · 401 재시도 · 동시 갱신 묶음) · 주문 offset 페이지 · 상한 분할 ·
 * 결제일 KST · 취소/반품 품주 제외 · Analytics 방문/조회/장바구니 · 상품/품목 재고 · 혜택 프로모션 · 오류 해석. 네트워크 없음.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connector, credentialsSchema, fetchCafe24 } from './index';
import { Cafe24Client, _resetCafe24InflightForTest, cafe24AuthorizeUrl, describeCafe24Error, exchangeCafe24AuthCode, findRows } from './client';
import { cafe24OrderLine } from './normalize';
import { CAFE24_CREDS, CAFE24_ORDERS, cafe24Handler, cafe24State, order } from './fixtures';
import { combine, fakeCtx, handlerHttp, type Handler } from '../naver-commerce/sales-testkit';
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
  it('결제일(pay_date) 구간 · embed=items · 취소/미결제 주문과 C1/C2/C3 품주 제외 · 교환 유지 · Analytics 방문/조회/장바구니', async () => {
    const { http, ctx } = setup({ settings: { fetchProducts: false, fetchPromotions: false } });
    const b = await fetchCafe24(ctx, { from: '2026-10-31', to: '2026-11-02' });
    expect(b.salesDaily).toEqual([
      { date: '2026-10-31', channel: 'own_mall', visitors: 0, detailViews: 2500, carts: 240, orders: 0, revenue: 0, adAttributedRevenue: 0 },
      { date: '2026-11-01', channel: 'own_mall', visitors: 5400, detailViews: 2500, carts: 240, orders: 2, revenue: 1_230_000, adAttributedRevenue: 0 },
      { date: '2026-11-02', channel: 'own_mall', visitors: 6100, detailViews: 3400, carts: 290, orders: 1, revenue: 1_190_000, adAttributedRevenue: 0 },
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
  it('상품 + 품목(판매가 + 추가금액, 재고 사용 시 수량 > 0) · 판매안함 · 대표 도메인 랜딩 · 기간할인 혜택(12%) · 사은품 혜택(0%)', async () => {
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
    expect(b.promotions).toEqual([
      { id: 'c24-benefit-3', name: '가을 이사 기획전', channel: 'own_mall', start: '2026-10-20', end: '2026-11-05', discountRate: 12, status: 'live' },
      { id: 'c24-benefit-5', name: '사은품 증정', channel: 'own_mall', start: '2026-11-10', end: '2026-11-20', discountRate: 0, status: 'planned' },
    ]);
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
