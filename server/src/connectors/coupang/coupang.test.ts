/**
 * 쿠팡 Wing 커넥터 — CEA HMAC 서명(문서 규칙 재계산) · 발주서 상태별 · nextToken 페이지 · 31일 미만 구간 · 결제일 KST 묶음 ·
 * 취소/환불대기 순수량 · 금액 객체(units/nanos) · 상품/옵션 재고 · 즉시할인 쿠폰 · 오류 해석. 네트워크 없음.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connector, credentialsSchema, fetchCoupang } from './index';
import { CoupangClient, coupangAuthorization, coupangQuery, coupangSignature, coupangSignedDate, describeCoupangError, money } from './client';
import { coupangLines } from './normalize';
import { COUPANG_CREDS, coupangHandler, sheet, verifyCoupangAuth } from './fixtures';
import { combine, fakeCtx, handlerHttp, type Handler } from '../naver-commerce/sales-testkit';
import { setNowForTest } from '../../lib/time';

const NOW = Date.parse('2026-11-03T10:00:00+09:00');
beforeEach(() => setNowForTest(NOW));
afterEach(() => setNowForTest(null));

const ctxWith = (h: Handler, settings: Record<string, unknown> = {}, creds: Record<string, unknown> = COUPANG_CREDS) => {
  const http = handlerHttp(h);
  return { http, ctx: fakeCtx(creds, settings, http) };
};

describe('HMAC 서명 (문서 규칙)', () => {
  it('signed-date = UTC yyMMddTHHmmssZ (문서 Node.js 예제: toISOString().substr(2,17)에서 - : 제거 + Z)', () => {
    expect(coupangSignedDate(Date.parse('2026-11-03T00:41:55.123Z'))).toBe('261103T004155Z');
    expect(coupangSignedDate(NOW)).toBe('261103T010000Z'); // KST 10:00 = UTC 01:00
    const iso = new Date(NOW).toISOString();
    expect(coupangSignedDate(NOW)).toBe(`${iso.substr(2, 17).replace(/:/gi, '').replace(/-/gi, '')}Z`);
  });

  it('signature = hex(HMAC-SHA256(secret, signedDate + METHOD + path + query)) · Authorization 형식', () => {
    const path = '/v2/providers/openapi/apis/api/v4/vendors/A00012345/returnRequests';
    const query = 'createdAtFrom=2018-08-09&createdAtTo=2018-08-09&status=UC';
    const expected = createHmac('sha256', 'secret-x').update(`180809T000000ZGET${path}${query}`).digest('hex');
    expect(coupangSignature('secret-x', '180809T000000Z', 'GET', path, query)).toBe(expected);
    const auth = coupangAuthorization({ accessKey: 'ak-1', secretKey: 'secret-x' }, 'GET', path, query, Date.parse('2018-08-09T00:00:00Z'));
    expect(auth).toBe(`CEA algorithm=HmacSHA256, access-key=ak-1, signed-date=180809T000000Z, signature=${expected}`);
  });

  it('서명한 쿼리 문자열을 그대로 URL에 붙인다 — 서버 쪽 재계산과 일치, 다른 시크릿이면 불일치', () => {
    const http = handlerHttp(() => ({ data: {} }));
    const client = new CoupangClient(fakeCtx(COUPANG_CREDS, {}, http), COUPANG_CREDS, { now: () => NOW });
    const req = client.request('GET', '/v2/providers/openapi/apis/api/v5/vendors/A00012345/ordersheets', { createdAtFrom: '2026-11-01+09:00', createdAtTo: '2026-11-02+09:00', status: 'ACCEPT', maxPerPage: 50 });
    expect(req.query).toBeUndefined();
    expect(req.url).toBe('https://api-gateway.coupang.com/v2/providers/openapi/apis/api/v5/vendors/A00012345/ordersheets?createdAtFrom=2026-11-01%2B09%3A00&createdAtTo=2026-11-02%2B09%3A00&status=ACCEPT&maxPerPage=50');
    const r = { method: 'GET', url: new URL(req.url), headers: { authorization: req.headers!.Authorization } };
    expect(verifyCoupangAuth(r)).toBe(true);
    expect(verifyCoupangAuth(r, 'other-secret')).toBe(false);
    expect(req.headers!['Content-Type']).toBe('application/json;charset=UTF-8');
    expect(coupangQuery({ a: 1, b: undefined, c: '', d: 'x y' })).toBe('a=1&d=x+y');
  });
});

describe('발주서 → 판매 채널 일별', () => {
  it('상태 6종 · nextToken · 결제일 KST 묶음(오프셋 -08:00 · Z 포함) · 취소 · 환불대기 · 중복 배송번호 · net 할인 차감', async () => {
    const { http, ctx } = ctxWith(coupangHandler(), { fetchProducts: false, fetchPromotions: false });
    const b = await fetchCoupang(ctx, { from: '2026-11-01', to: '2026-11-02' });
    expect(b.salesDaily).toEqual([
      { date: '2026-11-01', channel: 'coupang', visitors: 0, detailViews: 0, carts: 0, orders: 2, revenue: 1_730_000, adAttributedRevenue: 0 },
      { date: '2026-11-02', channel: 'coupang', visitors: 0, detailViews: 0, carts: 0, orders: 2, revenue: 1_480_000, adAttributedRevenue: 0 },
    ]);
    const calls = http.calls.filter((c) => c.url.pathname.endsWith('/ordersheets'));
    expect(new Set(calls.map((c) => c.url.searchParams.get('status')))).toEqual(new Set(['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING']));
    // 생성일 구간은 결제일 기준 lookback 2일 앞당김, 날짜 + '+09:00'
    expect(calls[0].url.searchParams.get('createdAtFrom')).toBe('2026-10-30+09:00');
    expect(calls[0].url.searchParams.get('createdAtTo')).toBe('2026-11-02+09:00');
    expect(calls.filter((c) => c.url.searchParams.get('status') === 'ACCEPT').map((c) => c.url.searchParams.get('nextToken'))).toEqual([null, '1']);
    expect(b.warnings?.map((w) => w.code)).toEqual(['funnel_unavailable']);
  });

  it('gross = 판매가 × 순수량 (할인 차감 없음)', async () => {
    const { ctx } = ctxWith(coupangHandler(), { fetchProducts: false, fetchPromotions: false, revenueBasis: 'gross' });
    const b = await fetchCoupang(ctx, { from: '2026-11-01', to: '2026-11-01' });
    expect(b.salesDaily?.[0]).toMatchObject({ orders: 2, revenue: 1_780_000 });
  });

  it('긴 기간은 31일 미만(30일) 생성일 묶음으로 나눈다', async () => {
    const { http, ctx } = ctxWith(coupangHandler(), { fetchProducts: false, fetchPromotions: false, statuses: ['ACCEPT'], createdLookbackDays: 0 });
    await fetchCoupang(ctx, { from: '2026-09-01', to: '2026-11-02' });
    const windows = [...new Set(http.calls.filter((c) => c.url.pathname.endsWith('/ordersheets')).map((c) => `${c.url.searchParams.get('createdAtFrom')}~${c.url.searchParams.get('createdAtTo')}`))];
    expect(windows).toEqual(['2026-09-01+09:00~2026-09-30+09:00', '2026-10-01+09:00~2026-10-30+09:00', '2026-10-31+09:00~2026-11-02+09:00']);
  });

  it('순수량 규칙: shippingCount − holdCountForCancel − cancelCount, 금액 객체 nanos', () => {
    const s = sheet({ box: 1, orderId: 9, paidAt: '2026-11-01T10:00:00+09:00', items: [
      { vendorItemId: 1, price: 1000, count: 3, cancel: 1, hold: 1 },
      { vendorItemId: 2, price: 500, count: 2, cancel: 2 },
    ] });
    expect(coupangLines(s, 'gross')).toMatchObject({ lines: [{ date: '2026-11-01', orderId: '9', revenue: 1000, quantity: 1 }], excluded: 1 });
    expect(money({ units: 19_900, nanos: 500_000_000 })).toBe(19_900.5);
    expect(money(null)).toBe(0);
    expect(money(3000)).toBe(3000);
  });
});

describe('상품 · 재고 · 즉시할인 쿠폰', () => {
  it('승인 상품 → 옵션(vendorItemId) · 옵션별 재고/판매 상태 · 주문의 판매 페이지 URL', async () => {
    const { ctx } = ctxWith(coupangHandler());
    const b = await fetchCoupang(ctx, { from: '2026-11-01', to: '2026-11-02' });
    expect(b.products).toEqual([
      { id: 'cpg-80240831', name: '수면밀도 매트리스', landing: 'https://www.coupang.com/vp/products/31846051', options: [
        { id: '7001', label: '퀸', price: 950_000, inStock: true },
        { id: '7002', label: '슈퍼싱글', price: 790_000, inStock: false },
      ] },
      { id: 'cpg-80240832', name: '수면밀도 토퍼', landing: 'https://www.coupang.com/vp/products/31846052', options: [
        { id: '7003', label: '퀸', price: 290_000, inStock: false },
      ] },
    ]);
    expect(b.promotions).toEqual([
      { id: 'cpg-coupon-2246326', name: '쿠팡 11월 매트리스 위크', channel: 'coupang', start: '2026-11-01', end: '2026-11-07', discountRate: 10, status: 'live' },
      { id: 'cpg-coupon-2245939', name: '즉시할인 쿠폰 2245939 (정액 30,000원)', channel: 'coupang', start: '2026-10-01', end: '2026-10-31', discountRate: 0, status: 'ended' },
      { id: 'cpg-coupon-2300001', name: '블랙프라이데이', channel: 'coupang', start: '2026-11-20', end: '2026-11-30', discountRate: 20, status: 'planned' },
    ]);
  });

  it('inventoryLimit을 넘는 옵션은 상품 조회의 판매가능수량(maximumBuyCount)으로 판단 + 경고', async () => {
    const { http, ctx } = ctxWith(coupangHandler(), { inventoryLimit: 1, fetchPromotions: false });
    const b = await fetchCoupang(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(http.calls.filter((c) => c.url.pathname.endsWith('/inventories'))).toHaveLength(1);
    expect(b.products?.[0].options[1]).toEqual({ id: '7002', label: '슈퍼싱글', price: 790_000, inStock: false });
    expect(b.products?.[1].options[0]).toEqual({ id: '7003', label: '퀸', price: 290_000, inStock: true }); // maximumBuyCount 3
    expect(b.warnings?.map((w) => w.code)).toContain('inventory_partial');
  });

  it('당일 수집은 상품 · 쿠폰 스냅샷을 건너뛴다', async () => {
    const { http, ctx } = ctxWith(coupangHandler());
    const b = await fetchCoupang(ctx, { from: '2026-11-03', to: '2026-11-03' }, { intradayDate: '2026-11-03' });
    expect(b.products).toBeUndefined();
    expect(http.calls.some((c) => c.url.pathname.includes('seller-products') || c.url.pathname.endsWith('/coupons'))).toBe(false);
  });
});

describe('오류 해석 · 연결 확인', () => {
  it('401 서명 오류 → 인증(서명 시각 안내), 403 → 호출 허용 IP 안내, vendorId 오류 → 요청 오류, 200 + code ERROR → 요청 오류', () => {
    expect(describeCoupangError(401, { code: 401, message: 'Specified signature is expired.' })).toMatchObject({ kind: 'auth' });
    expect(describeCoupangError(401, { code: 401, message: 'x' })?.detail).toMatch(/서버 시각/);
    expect(describeCoupangError(403, { code: 'ERROR', message: 'Not allowed IP' })?.detail).toMatch(/호출 허용 IP/);
    expect(describeCoupangError(400, { code: 'ERROR', message: 'Invalid vendor ID' })).toMatchObject({ kind: 'invalid' });
    expect(describeCoupangError(200, { code: 'ERROR', message: '유효한 옵션이 없습니다' })).toMatchObject({ kind: 'invalid' });
    expect(describeCoupangError(200, { code: 'SUCCESS' })).toBeNull();
  });

  it('잘못된 Secret Key면 test()가 한국어 인증 실패를 돌려주고 비밀값은 메시지에 없다', async () => {
    const { ctx } = ctxWith(coupangHandler(), {}, { ...COUPANG_CREDS, secretKey: 'wrong-secret-0000' });
    const r = await connector.test(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/쿠팡 Wing Open API 인증 실패/);
    expect(r.message).not.toContain('wrong-secret-0000');
  });

  it('test(): 판매자 ID · 상품 목록 · 어제 결제완료 발주서', async () => {
    const yesterday = { ACCEPT: [[sheet({ box: 1, orderId: 1, paidAt: '2026-11-02T09:00:00+09:00', items: [{ vendorItemId: 1, price: 1000, count: 1 }] })]] };
    const { http, ctx } = ctxWith(coupangHandler({ sheets: yesterday }));
    const r = await connector.test(ctx);
    expect(r).toMatchObject({ ok: true, account: '쿠팡 Wing Open API A00012345' });
    expect(r.message).toMatch(/판매자 ID A00012345 · 상품 목록 조회됨 · 어제 생성된 결제완료\(ACCEPT\) 발주서 1건/);
    const sheetCall = http.calls.find((c) => c.url.pathname.endsWith('/ordersheets'))!;
    expect(sheetCall.url.searchParams.get('createdAtFrom')).toBe('2026-11-02+09:00');
  });

  it('호출 한도 초과(429)는 수집 실패로 올린다 (래퍼 재시도 후)', async () => {
    const limited: Handler = (r) => (r.url.pathname.endsWith('/ordersheets') ? { status: 429, data: { code: 429, message: 'Too Many Requests' } } : null);
    const { ctx } = ctxWith(combine(limited, coupangHandler()));
    await expect(fetchCoupang(ctx, { from: '2026-11-02', to: '2026-11-02' })).rejects.toMatchObject({ kind: 'rate' });
  });

  it('자격증명 형식 · 정의', () => {
    expect(credentialsSchema.safeParse({ ...COUPANG_CREDS, vendorId: 'a00012345' }).data?.vendorId).toBe('A00012345');
    expect(credentialsSchema.safeParse({ ...COUPANG_CREDS, vendorId: '12345' }).success).toBe(false);
    expect(connector).toMatchObject({ provider: 'coupang', kind: 'sales', channel: 'coupang', verifiedLive: false });
    expect(connector.docsUrl).toMatch(/^https:\/\/developers\.coupang\.com\//);
    expect(connector.capabilities.writes).toEqual([]);
    expect(connector.credentialFields.filter((f) => f.secret).map((f) => f.key)).toEqual(['accessKey', 'secretKey']);
  });
});
