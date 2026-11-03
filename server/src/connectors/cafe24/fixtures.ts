/**
 * 카페24 Admin · Analytics API 응답 픽스처 — 공식 문서 응답 예시의 필드 이름 · 형태 그대로 (테스트 전용).
 *   토큰 { access_token, expires_at, refresh_token, refresh_token_expires_at, client_id, mall_id, user_id, scopes, issued_at, shop_no, token_type }
 *   주문 { orders[{ order_id, paid, canceled, payment_date, actual_order_amount, items[] }] } · 상품 { products[{ …, variants[] }] }
 *   Analytics 행 { date, visit_count } · { product_no, count } · { product_no, add_cart_count } · { ad, order_count, order_amount } — 감싸는 키 이름은 문서에 없어 임의('view' 등)
 */
import type { Cafe24Order } from './client';
import type { Handler } from '../naver-commerce/sales-testkit';

export const CAFE24_CREDS = { mallId: 'mildomall', clientId: 'BrIfqEKoPxeE', clientSecret: 'c24-secret-xYz789', refreshToken: 'c24-refresh-0001' };
export const CAFE24_SCOPES_ALL = ['mall.read_order', 'mall.read_product', 'mall.read_store', 'mall.read_promotion', 'mall.read_analytics'];

const item = (o: { code: string; productNo: number; price: number; option?: number; qty: number; pay: number; status?: string }) => ({
  shop_no: 1, item_no: 1, order_item_code: o.code, variant_code: `P0000${o.productNo}000A`, product_no: o.productNo, product_code: `P0000${o.productNo}`,
  product_name: '수면밀도 매트리스', option_value: '사이즈=퀸', product_price: o.price, option_price: o.option ?? 0, additional_discount_price: 0, coupon_discount_price: 0,
  app_item_discount_amount: 0, payment_amount: o.pay, quantity: o.qty, order_status: o.status === 'C2' ? 'C40' : o.status === 'C3' ? 'R40' : 'N40', status_code: o.status ?? 'N1',
});

export function order(o: { id: string; paid: string; paidFlag?: string; canceled?: string; items: ReturnType<typeof item>[] }): Cafe24Order {
  return {
    order_id: o.id, paid: o.paidFlag ?? 'T', canceled: o.canceled ?? 'F', order_date: o.paid, payment_date: o.paid,
    payment_amount: String(o.items.reduce((s, i) => s + i.payment_amount, 0)),
    actual_order_amount: { order_price_amount: String(o.items.reduce((s, i) => s + (i.product_price + i.option_price) * i.quantity, 0)), payment_amount: String(o.items.reduce((s, i) => s + i.payment_amount, 0)) },
    items: o.items as never,
  };
}

/**
 * 결제일 구간별 주문. 2026-11-01 기대값: 주문 2건(A · C), net 940,000 + 290,000 = 1,230,000, gross 990,000 + 290,000 = 1,280,000
 * 2026-11-02 기대값: 주문 1건(E), net 1,190,000
 */
export const CAFE24_ORDERS: Cafe24Order[] = [
  order({ id: '20261101-0000001', paid: '2026-11-01T10:00:00+09:00', items: [
    item({ code: '20261101-0000001-01', productNo: 11, price: 790_000, option: 200_000, qty: 1, pay: 940_000 }),
    item({ code: '20261101-0000001-02', productNo: 12, price: 290_000, qty: 1, pay: 290_000, status: 'C2' }), // 배송전취소
  ] }),
  order({ id: '20261101-0000002', paid: '2026-11-01T11:00:00+09:00', canceled: 'T', items: [item({ code: '20261101-0000002-01', productNo: 11, price: 790_000, qty: 1, pay: 790_000 })] }),
  order({ id: '20261101-0000003', paid: '2026-11-01T23:59:00+09:00', items: [item({ code: '20261101-0000003-01', productNo: 12, price: 290_000, qty: 1, pay: 290_000 })] }),
  order({ id: '20261101-0000004', paid: '2026-11-01T12:00:00+09:00', items: [item({ code: '20261101-0000004-01', productNo: 11, price: 790_000, qty: 1, pay: 790_000, status: 'C3' })] }), // 반품
  order({ id: '20261102-0000005', paid: '2026-11-02T00:00:30+09:00', items: [item({ code: '20261102-0000005-01', productNo: 11, price: 990_000, qty: 1, pay: 1_190_000, status: 'E1' })] }), // 교환(매출 유지)
  order({ id: '20261102-0000006', paid: '2026-11-02T09:00:00+09:00', paidFlag: 'F', items: [item({ code: '20261102-0000006-01', productNo: 11, price: 790_000, qty: 1, pay: 790_000 })] }),
];

export const CAFE24_PRODUCTS = [
  { shop_no: 1, product_no: 11, product_code: 'P000000K', product_name: '수면밀도 매트리스', price: '790000.00', retail_price: '990000.00', display: 'T', selling: 'T', variants: [
    { shop_no: 1, variant_code: 'P000000K000A', options: [{ name: '사이즈', value: '슈퍼싱글' }], display: 'T', selling: 'T', additional_amount: '0.00', use_inventory: 'T', quantity: 6, safety_inventory: 1 },
    { shop_no: 1, variant_code: 'P000000K000B', options: [{ name: '사이즈', value: '퀸' }], display: 'T', selling: 'T', additional_amount: '200000.00', use_inventory: 'T', quantity: 0, safety_inventory: 0 },
  ] },
  { shop_no: 1, product_no: 12, product_code: 'P000000L', product_name: '수면밀도 토퍼', price: '290000.00', display: 'T', selling: 'T', variants: [] },
  { shop_no: 1, product_no: 13, product_code: 'P000000M', product_name: '단종 베개', price: '50000.00', display: 'F', selling: 'F', variants: [
    { shop_no: 1, variant_code: 'P000000M000A', options: [], selling: 'T', additional_amount: '0.00', use_inventory: 'F', quantity: 0 },
  ] },
];

export const CAFE24_BENEFITS = [
  { shop_no: 1, benefit_no: 3, use_benefit: 'T', benefit_name: '가을 이사 기획전', benefit_division: 'D', benefit_type: 'DP', use_benefit_period: 'T', benefit_start_date: '2026-10-20T00:00:00+09:00', benefit_end_date: '2026-11-05T23:59:00+09:00' },
  { shop_no: 1, benefit_no: 4, use_benefit: 'T', benefit_name: '신규 상품 할인', benefit_division: 'D', benefit_type: 'DN', use_benefit_period: null, benefit_start_date: null, benefit_end_date: null },
  { shop_no: 1, benefit_no: 5, use_benefit: 'T', benefit_name: '사은품 증정', benefit_division: 'P', benefit_type: 'PG', use_benefit_period: 'T', benefit_start_date: '2026-11-10T00:00:00+09:00', benefit_end_date: '2026-11-20T23:55:00+09:00' },
];

export const CAFE24_VISITORS = [
  { date: '2026-11-01', hour: 0, visit_count: 5400, first_visit_count: 3000, re_visit_count: 2400 },
  { date: '2026-11-02', hour: 0, visit_count: 6100, first_visit_count: 3500, re_visit_count: 2600 },
];

export interface Cafe24FakeState {
  /** 현재 유효한 액세스 토큰 · 갱신 토큰 */
  access: string;
  refresh: string;
  authCode?: string;
  /** 토큰 엔드포인트 호출 기록 */
  tokenCalls: { auth: string | undefined; body: Record<string, unknown> }[];
  issued: number;
  analytics: 'ok' | 'forbidden';
}

export function cafe24State(over: Partial<Cafe24FakeState> = {}): Cafe24FakeState {
  return { access: 'c24-access-0001', refresh: CAFE24_CREDS.refreshToken, tokenCalls: [], issued: 0, analytics: 'ok', ...over };
}

const ok = (data: unknown, status = 200) => ({ status, data });

/** 날짜마다 n건씩 만든 대량 주문의 [offset, offset+limit) 구간 (offset 상한 테스트) */
function bulkOrders(from: string, to: string, perDay: number, offset: number, limit: number): Cafe24Order[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.push(d);
  const out: Cafe24Order[] = [];
  for (let k = offset; k < Math.min(offset + limit, days.length * perDay); k++) {
    const d = days[Math.floor(k / perDay)];
    out.push(order({ id: `${d}-${k % perDay}`, paid: `${d}T12:00:00+09:00`, items: [item({ code: `${d}-${k % perDay}-01`, productNo: 11, price: 1, qty: 1, pay: 1 })] }));
  }
  return out;
}

export function cafe24Handler(st: Cafe24FakeState, opts: { orders?: Cafe24Order[]; bulkPerDay?: number } = {}): Handler {
  const orders = opts.orders ?? CAFE24_ORDERS;
  return (r) => {
    const host = r.url.hostname;
    if (host === `${CAFE24_CREDS.mallId}.cafe24api.com` && r.method === 'POST' && r.url.pathname === '/api/v2/oauth/token') {
      const body = r.body as Record<string, string>;
      st.tokenCalls.push({ auth: r.headers.authorization, body });
      if (r.headers.authorization !== `Basic ${Buffer.from(`${CAFE24_CREDS.clientId}:${CAFE24_CREDS.clientSecret}`).toString('base64')}`) return ok({ error: 'invalid_client', error_description: 'client authentication failed' }, 401);
      const valid = body.grant_type === 'refresh_token' ? body.refresh_token === st.refresh : body.grant_type === 'authorization_code' && !!st.authCode && body.code === st.authCode && !!body.redirect_uri;
      if (!valid) return ok({ error: 'invalid_grant', error_description: 'Validation error: refresh_token' }, 400);
      st.issued++;
      st.authCode = undefined;
      st.access = `c24-access-${1000 + st.issued}`;
      st.refresh = `c24-refresh-${1000 + st.issued}`;
      // 문서 예시처럼 오프셋 없는 일시 — 차이(2시간 · 14일)만 의미가 있다
      return ok({ access_token: st.access, expires_at: '2021-03-01T14:00:00.000', refresh_token: st.refresh, refresh_token_expires_at: '2021-03-15T12:00:00.000', client_id: CAFE24_CREDS.clientId, mall_id: CAFE24_CREDS.mallId, user_id: 'mildo', scopes: CAFE24_SCOPES_ALL, issued_at: '2021-03-01T12:00:00.000', shop_no: '1', token_type: 'Bearer' });
    }
    const authed = r.headers.authorization === `Bearer ${st.access}`;
    if (host === `${CAFE24_CREDS.mallId}.cafe24api.com`) {
      if (!authed) return ok({ error: { code: 401, message: 'Invalid access_token' } }, 401);
      const p = r.url.pathname;
      const sp = r.url.searchParams;
      if (p === '/api/v2/admin/store') return ok({ store: { shop_no: 1, shop_name: '수면밀도 공식몰', mall_id: CAFE24_CREDS.mallId, base_domain: 'mildomall.cafe24.com', primary_domain: 'mildo.kr' } });
      if (p === '/api/v2/admin/orders') {
        const from = sp.get('start_date') ?? '';
        const to = sp.get('end_date') ?? '';
        const offset = Number(sp.get('offset') ?? 0);
        const limit = Number(sp.get('limit') ?? 10);
        if (opts.bulkPerDay) return ok({ orders: bulkOrders(from, to, opts.bulkPerDay, offset, limit) });
        const inRange = orders.filter((o) => { const d = String(o.payment_date).slice(0, 10); return d >= from && d <= to; });
        return ok({ orders: inRange.slice(offset, offset + limit) });
      }
      if (p === '/api/v2/admin/products') {
        const since = sp.get('since_product_no');
        return ok({ products: CAFE24_PRODUCTS.filter((x) => since === null || x.product_no > Number(since)) });
      }
      if (p === '/api/v2/admin/benefits') return ok({ benefits: Number(sp.get('offset') ?? 0) === 0 ? CAFE24_BENEFITS : [] });
      if (p === '/api/v2/admin/benefits/3') return ok({ benefit: { ...CAFE24_BENEFITS[0], period_sale: [{ product_list: [], discount_purchasing_quantity: 'F', discount_value: '12', discount_value_unit: 'P', discount_truncation_unit: 'O', discount_truncation_method: 'L' }] } });
      return null;
    }
    if (host === 'ca-api.cafe24data.com') {
      if (!authed) return ok({ error: { code: 401, message: 'Invalid access_token' } }, 401);
      if (st.analytics === 'forbidden') return ok({ error: { code: 403, message: 'insufficient scope: mall.read_analytics' } }, 403);
      const sp = r.url.searchParams;
      if (sp.get('mall_id') !== CAFE24_CREDS.mallId) return ok({ error: { code: 422, message: 'mall_id required' } }, 422);
      const d = sp.get('start_date') ?? '';
      if (r.url.pathname === '/visitors/view') return ok({ view: CAFE24_VISITORS.filter((v) => v.date >= d && v.date <= (sp.get('end_date') ?? '')) });
      if (r.url.pathname === '/products/view') return ok({ view: d === '2026-11-02' ? [{ product_no: 11, product_name: '매트리스', count: 3000 }, { product_no: 12, product_name: '토퍼', count: 400 }] : [{ product_no: 11, product_name: '매트리스', count: 2500 }] });
      // 광고 매체별 매출 (기간 합계) — 11/02는 Analytics 집계가 주문 API 매출(1,190,000)보다 커서 매출로 잘리는 경우
      if (r.url.pathname === '/visitpaths/adsales') return ok({ adsales: d === '2026-11-02' ? [{ ad: '네이버 파워링크', order_count: 1, order_amount: 800_000, join_count: 0 }, { ad: '구글 애즈', order_count: 1, order_amount: 600_000, join_count: 0 }] : d === '2026-11-01' ? [{ ad: '네이버 파워링크', order_count: 1, order_amount: 940_000, join_count: 0 }] : [] });
      if (r.url.pathname === '/carts/action') return ok({ action: d === '2026-11-02' ? [{ product_no: 11, product_name: '매트리스', count: 3000, add_cart_count: 290, add_cart_rate: 9.7 }] : [{ product_no: 11, product_name: '매트리스', count: 2500, add_cart_count: 240, add_cart_rate: 9.6 }] });
      return null;
    }
    return null;
  };
}
