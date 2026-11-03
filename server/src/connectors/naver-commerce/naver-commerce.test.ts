/**
 * 네이버 커머스API 커넥터 — 문서 테스트 벡터(전자서명) · 토큰 · 페이지 · KST 날짜 · 취소/반품 제외 · 수량 클레임 · 상품/옵션/재고 · 프로모션 · 오류 해석.
 * 네트워크 없음: 문서 스키마 모양의 가짜 서버(fixtures.ts)를 ConnectorHttp로 꽂는다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connector, credentialsSchema, fetchNaverCommerce, settingsSchema } from './index';
import { NaverCommerceClient, _resetNaverCommerceTokenCacheForTest, clientSecretSign, describeNaverCommerceError } from './client';
import { naverOrderLine } from './normalize';
import { NAVER_CREDS, NAVER_ORDERS, NAVER_TOKEN, naverHandler, po } from './fixtures';
import { combine, fakeCtx, handlerHttp, type Handler } from './sales-testkit';
import { SalesApiError, SalesAcc, kstDateOf, safeLanding } from './sales-shared';
import { setNowForTest } from '../../lib/time';

const NOW = Date.parse('2026-11-03T10:00:00+09:00');
beforeEach(() => { setNowForTest(NOW); _resetNaverCommerceTokenCacheForTest(); });
afterEach(() => { setNowForTest(null); });

const ctxWith = (h: Handler, settings: Record<string, unknown> = {}, creds: Record<string, unknown> = NAVER_CREDS) => {
  const http = handlerHttp(h);
  return { http, ctx: fakeCtx(creds, settings, http, { connectionId: 'conn-naver-1' }) };
};

describe('전자서명 (문서 테스트 벡터)', () => {
  it('Base64(bcrypt(`${client_id}_${timestamp}`, client_secret)) — 인증 가이드 Node.js · Python 예시 결과와 같다', () => {
    expect(clientSecretSign('aaaabbbbcccc', '$2a$10$abcdefghijklmnopqrstuv', 1643961623299))
      .toBe('JDJhJDEwJGFiY2RlZmdoaWprbG1ub3BxcnN0dXVCVldZSk42T0VPdEx1OFY0cDQxa2IuTnpVaUEzbmsy');
  });

  it('해시 함수를 주입할 수 있다 (password = clientId_timestamp, salt = 시크릿)', () => {
    const seen: [string, string][] = [];
    const sign = clientSecretSign('id-1', '$2a$04$saltsaltsaltsaltsaltsa', 1700000000000, (p, s) => { seen.push([p, s]); return 'HASHED'; });
    expect(seen).toEqual([['id-1_1700000000000', '$2a$04$saltsaltsaltsaltsaltsa']]);
    expect(sign).toBe(Buffer.from('HASHED').toString('base64'));
  });

  it('토큰 요청: form 본문에 전자서명만 — 시크릿 원문은 보내지 않는다. SELLER는 account_id 포함', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { http, ctx } = ctxWith(naverHandler({ onToken: (b) => bodies.push(b) }));
    const client = new NaverCommerceClient(ctx, NAVER_CREDS, { now: () => NOW, hash: (p) => `h(${p})` });
    expect(await client.token()).toBe(NAVER_TOKEN);
    expect(http.calls[0].url.toString()).toBe('https://api.commerce.naver.com/external/v1/oauth2/token');
    expect(bodies[0]).toEqual({
      client_id: 'aaaabbbbcccc', timestamp: String(NOW), grant_type: 'client_credentials',
      client_secret_sign: Buffer.from(`h(aaaabbbbcccc_${NOW})`).toString('base64'), type: 'SELF',
    });
    expect(JSON.stringify(http.calls)).not.toContain(NAVER_CREDS.clientSecret);

    _resetNaverCommerceTokenCacheForTest();
    const seller = new NaverCommerceClient(ctx, { ...NAVER_CREDS, accountId: 'ncp_seller_1' }, { now: () => NOW, hash: () => 'x', tokenType: 'SELLER' });
    await seller.token();
    expect(bodies[1]).toMatchObject({ type: 'SELLER', account_id: 'ncp_seller_1' });
  });

  it('잘못된 시크릿 형식은 자격증명 검증에서 막는다', () => {
    const r = credentialsSchema.safeParse({ clientId: 'abcdefgh', clientSecret: 'plain-secret' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('$2a$');
    expect(credentialsSchema.safeParse(NAVER_CREDS).success).toBe(true);
  });
});

describe('토큰 캐시 · GW.AUTHN 재발급', () => {
  it('토큰은 유효 시간 동안 재사용하고, 401 GW.AUTHN이면 한 번 재발급 후 다시 부른다', async () => {
    let tokenCalls = 0;
    let current = 'tok-A';
    const h: Handler = (r) => {
      if (r.url.pathname.endsWith('/oauth2/token')) { tokenCalls++; return { data: { access_token: current, expires_in: 10_800, token_type: 'Bearer' } }; }
      if (r.headers.authorization !== `Bearer ${current}`) return { status: 401, data: { code: 'GW.AUTHN', message: '요청을 보낼 권한이 없습니다.' } };
      return { data: { accountId: 'mildo' } };
    };
    const { ctx } = ctxWith(h);
    const client = new NaverCommerceClient(ctx, NAVER_CREDS, { now: () => NOW, hash: () => 'x' });
    await client.account();
    await client.account();
    expect(tokenCalls).toBe(1);
    current = 'tok-B'; // 서버가 토큰을 만료시킴
    expect((await client.account()).accountId).toBe('mildo');
    expect(tokenCalls).toBe(2);
  });
});

describe('주문 → 판매 채널 일별', () => {
  it('하루 구간 · 페이지 순회 · 결제일 KST 묶음 · 취소/반품/미결제 제외 · 수량 클레임 잔여 값 · 주문번호 중복 제거', async () => {
    const { http, ctx } = ctxWith(naverHandler(), { fetchProducts: false });
    const b = await fetchNaverCommerce(ctx, { from: '2026-10-31', to: '2026-11-02' });
    expect(b.salesDaily).toEqual([
      { date: '2026-10-31', channel: 'brandstore', visitors: 0, detailViews: 0, carts: 0, orders: 0, revenue: 0, adAttributedRevenue: 0 },
      { date: '2026-11-01', channel: 'brandstore', visitors: 0, detailViews: 0, carts: 0, orders: 3, revenue: 2_570_000, adAttributedRevenue: 990_000 },
      { date: '2026-11-02', channel: 'brandstore', visitors: 0, detailViews: 0, carts: 0, orders: 2, revenue: 1_480_000, adAttributedRevenue: 0 },
    ]);
    const orderCalls = http.calls.filter((c) => c.url.pathname.endsWith('/product-orders'));
    expect(orderCalls.map((c) => `${c.url.searchParams.get('from')}~${c.url.searchParams.get('to')} p${c.url.searchParams.get('page')}`)).toEqual([
      '2026-10-31T00:00:00.000+09:00~2026-10-31T23:59:59.999+09:00 p1',
      '2026-11-01T00:00:00.000+09:00~2026-11-01T23:59:59.999+09:00 p1',
      '2026-11-01T00:00:00.000+09:00~2026-11-01T23:59:59.999+09:00 p2',
      '2026-11-02T00:00:00.000+09:00~2026-11-02T23:59:59.999+09:00 p1',
    ]);
    expect(orderCalls[0].url.searchParams.get('rangeType')).toBe('PAYED_DATETIME');
    expect(orderCalls[0].url.searchParams.get('quantityClaimCompatibility')).toBe('true');
    expect(orderCalls[0].url.searchParams.get('pageSize')).toBe('300');
    expect(b.warnings?.map((w) => w.code)).toEqual(['funnel_unavailable']);
  });

  it('매출 기준 gross = 할인 전 상품 주문 금액(잔여)', async () => {
    const { ctx } = ctxWith(naverHandler(), { fetchProducts: false, revenueBasis: 'gross' });
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-01', to: '2026-11-01' });
    expect(b.salesDaily?.[0]).toMatchObject({ orders: 3, revenue: 2_680_000, adAttributedRevenue: 1_100_000 });
  });

  it('오늘은 현재 시각까지만 조회하고, 당일 수집에는 상품 · 경고를 붙이지 않는다', async () => {
    const { http, ctx } = ctxWith(naverHandler());
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-03', to: '2026-11-03' }, { intradayDate: '2026-11-03' });
    expect(b.salesDaily).toHaveLength(1);
    expect(b.products).toBeUndefined();
    expect(b.warnings).toBeUndefined();
    const c = http.calls.find((x) => x.url.pathname.endsWith('/product-orders'))!;
    expect(c.url.searchParams.get('to')).toBe('2026-11-03T10:00:00.000+09:00');
  });

  it('미래 날짜는 자르고, 범위가 오늘 이전으로 끝나면 비어 있지 않다', async () => {
    const { ctx } = ctxWith(naverHandler(), { fetchProducts: false });
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-09' });
    expect(b.salesDaily?.map((r) => r.date)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('상태 코드 해석: 요청 중 클레임은 남기고 완료 상태만 뺀다', () => {
    const req = naverOrderLine(po({ orderId: 'X', productOrderId: 'P', paid: '2026-11-01T10:00:00+09:00', pay: 100, product: 100, claimStatus: 'CANCEL_REQUEST' }), 'net', []);
    expect(req).toMatchObject({ orderId: 'X', revenue: 100 });
    for (const status of ['CANCELED', 'RETURNED', 'CANCELED_BY_NOPAYMENT', 'PAYMENT_WAITING']) {
      expect(naverOrderLine(po({ orderId: 'X', productOrderId: 'P', paid: '2026-11-01T10:00:00+09:00', status, pay: 100, product: 100 }), 'net', [])).toEqual({ excluded: 'status', status });
    }
    expect(naverOrderLine(po({ orderId: 'X', productOrderId: 'P', paid: '2026-11-01T10:00:00+09:00', qty: 1, remainQty: 0, pay: 100, product: 100 }), 'net', [])).toMatchObject({ excluded: 'zero_quantity' });
  });

  it('KST 날짜 변환 · 0행 채우기 (공용 도우미)', () => {
    expect(kstDateOf('2026-11-01T14:59:59.999Z')).toBe('2026-11-01');
    expect(kstDateOf('2026-11-01T15:00:00.000Z')).toBe('2026-11-02');
    expect(kstDateOf('2026-11-01T23:30:00')).toBe('2026-11-01'); // 오프셋 없음 = KST
    expect(kstDateOf('2026-11-01T07:30:00-08:00')).toBe('2026-11-02');
    const acc = new SalesAcc();
    acc.add('2026-11-01', 'A', 100);
    acc.add('2026-11-01', 'A', 50);
    expect(acc.rows('brandstore', { from: '2026-10-31', to: '2026-11-01' }).map((r) => [r.date, r.orders, r.revenue])).toEqual([['2026-10-31', 0, 0], ['2026-11-01', 1, 150]]);
  });
});

describe('상품 · 옵션 · 재고 · 프로모션', () => {
  it('스마트스토어 채널 상품 · 조합형 옵션 가격(판매가 + 옵션가) · 재고 · 즉시 할인 프로모션 · 랜딩 템플릿', async () => {
    const { http, ctx } = ctxWith(naverHandler(), { productUrlTemplate: 'https://brand.naver.com/mildo/products/{channelProductNo}' });
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.products).toEqual([
      { id: 'ncm-9001', name: '수면밀도 매트리스 (주력)', landing: 'https://brand.naver.com/mildo/products/1002', options: [
        { id: '11', label: '슈퍼싱글', price: 790_000, inStock: true },
        { id: '12', label: '퀸', price: 990_000, inStock: true },
        { id: '13', label: '킹', price: 1_190_000, inStock: false },
      ] },
      { id: 'ncm-9002', name: '토퍼', landing: 'https://brand.naver.com/mildo/products/1003', options: [{ id: '1003', label: '단일 상품', price: 290_000, inStock: false }] },
    ]);
    expect(b.promotions).toEqual([
      { id: 'ncm-promo-9001', name: '수면밀도 매트리스 (주력) 즉시 할인', channel: 'brandstore', start: '2026-10-20', end: '2026-11-03', discountRate: 15, adCopyPrice: 671_500, status: 'live' },
    ]);
    const search = http.calls.find((c) => c.url.pathname.endsWith('/products/search'))!;
    expect(search.method).toBe('POST');
    expect(search.body).toMatchObject({ productStatusTypes: ['SALE', 'OUTOFSTOCK', 'WAIT', 'SUSPENSION'], page: 1 });
  });

  it('템플릿이 없으면 채널 URL · optionDetailLimit을 넘는 상품은 목록 정보로 단일 옵션 + 경고', async () => {
    const { http, ctx } = ctxWith(naverHandler(), { optionDetailLimit: 1 });
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.products?.[0].landing).toBe('https://brand.naver.com/mildo');
    expect(b.products?.[1].options).toEqual([{ id: '1003', label: '단일 상품', price: 290_000, inStock: false }]);
    expect(http.calls.filter((c) => c.url.pathname.includes('/origin-products/'))).toHaveLength(1);
    expect(b.warnings?.map((w) => w.code)).toContain('option_detail_limit');
  });

  it('상품 조회가 권한 오류여도 주문 집계는 저장하고 경고로 남긴다', async () => {
    const deny: Handler = (r) => (r.url.pathname.endsWith('/products/search') ? { status: 403, data: { code: 'GW.AUTHZ', message: '접근 권한 없음' } } : null);
    const { ctx } = ctxWith(combine(deny, naverHandler()));
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.salesDaily?.[0].orders).toBe(2);
    expect(b.products).toBeUndefined();
    const w = b.warnings?.find((x) => x.code === 'products_failed');
    expect(w?.message).toMatch(/권한 없음.*API 그룹/);
  });
});

describe('오류 해석', () => {
  it('게이트웨이 코드: GW.RATE_LIMIT → 한도, GW.AUTHN → 인증, 403 → 권한(API 그룹)', () => {
    expect(describeNaverCommerceError(429, { code: 'GW.RATE_LIMIT', message: '요청량 초과' })).toMatchObject({ kind: 'rate', code: 'GW.RATE_LIMIT' });
    expect(describeNaverCommerceError(429, { code: 'GW.QUOTA_LIMIT', message: '쿼터 초과' })).toMatchObject({ kind: 'rate' });
    expect(describeNaverCommerceError(401, { code: 'GW.AUTHN', message: '요청을 보낼 권한이 없습니다.' })).toMatchObject({ kind: 'auth' });
    expect(describeNaverCommerceError(403, { code: 'X', message: 'no' })?.detail).toMatch(/API 그룹/);
    expect(describeNaverCommerceError(400, { code: 'BAD', message: '잘못된 요청', invalidInputs: [{ name: 'from', message: '형식 오류' }] })?.detail).toContain('from: 형식 오류');
  });

  it('호출 한도 초과는 수집 전체 실패(잡 재시도)로 올린다', async () => {
    const limited: Handler = (r) => (r.url.pathname.endsWith('/product-orders') ? { status: 429, data: { code: 'GW.RATE_LIMIT', message: '요청량 초과' } } : null);
    const { ctx } = ctxWith(combine(limited, naverHandler()));
    await expect(fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-02' })).rejects.toMatchObject({ kind: 'rate' });
    await expect(fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-02' })).rejects.toBeInstanceOf(SalesApiError);
  });

  it('토큰 발급 400은 인증 실패 메시지(애플리케이션 ID · 시크릿 · 서버 시각)', async () => {
    const bad: Handler = (r) => (r.url.pathname.endsWith('/oauth2/token') ? { status: 400, data: { code: 'BadRequest', message: 'client_secret_sign 검증 실패' } } : null);
    const { ctx } = ctxWith(bad);
    const r = await connector.test(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/인증 실패.*서버 시각/);
    expect(r.message).not.toContain(NAVER_CREDS.clientSecret);
  });
});

describe('연결 확인 · 정의', () => {
  it('test(): 스토어 이름 · 계정 · 어제 결제 건수 · CSV 안내', async () => {
    const { ctx } = ctxWith(naverHandler({ orders: { '2026-11-02': NAVER_ORDERS['2026-11-02'] } }));
    const r = await connector.test(ctx);
    expect(r).toMatchObject({ ok: true, account: '네이버 커머스API 수면밀도 브랜드스토어' });
    expect(r.message).toMatch(/스토어 수면밀도 브랜드스토어 · 계정 mildo · 어제 결제 상품 주문 3건/);
    expect(r.message).toMatch(/CSV/);
  });

  it('판매 채널 brandstore · 읽기 전용 · 문서 URL · 한국어 자격증명 안내', () => {
    expect(connector).toMatchObject({ provider: 'naver_commerce', kind: 'sales', channel: 'brandstore', verifiedLive: false });
    expect(connector.docsUrl).toMatch(/^https:\/\/apicenter\.commerce\.naver\.com\//);
    expect(connector.capabilities).toEqual({ reads: ['salesDaily', 'products', 'promotions'], writes: [], intraday: true, maxBackfillDays: 400 });
    expect(connector.apply).toBeUndefined();
    expect(connector.credentialFields.find((f) => f.key === 'clientSecret')?.secret).toBe(true);
    expect(connector.credentialFields.every((f) => /[가-힣]/.test(f.label) && !!f.help)).toBe(true);
  });
});

describe('랜딩 주소 검사 (리뷰 보강)', () => {
  it('상품 URL 템플릿은 https만 — javascript: · data: · http: 템플릿은 설정 저장(400) 단계에서 거부', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'http://brand.naver.com/mildo/products/{channelProductNo}']) {
      expect(settingsSchema.safeParse({ productUrlTemplate: bad }).success, bad).toBe(false);
    }
    expect(settingsSchema.safeParse({ productUrlTemplate: 'https://brand.naver.com/mildo/products/{channelProductNo}' }).success).toBe(true);
  });

  it('채널 정보 API의 URL이 https가 아니면 랜딩을 비운다 (화면 링크로 쓰지 않는다)', async () => {
    const odd: Handler = (r) => (r.url.pathname.endsWith('/seller/channels') ? { data: [{ channelNo: 1, channelType: 'STOREFARM', name: 'x', url: 'javascript:alert(1)' }] } : null);
    const { ctx } = ctxWith(combine(odd, naverHandler()));
    const b = await fetchNaverCommerce(ctx, { from: '2026-11-02', to: '2026-11-02' });
    expect(b.products?.map((p) => p.landing)).toEqual(['', '']);
    expect(safeLanding('https://brand.naver.com/mildo')).toBe('https://brand.naver.com/mildo');
    expect(safeLanding('http://brand.naver.com/mildo')).toBe('');
    expect(safeLanding(' JavaScript:alert(1)')).toBe('');
  });

  it('광고 경유 매출(추정)은 매출을 넘지 않는다 (SalesAcc 행 단계에서 자름)', () => {
    const acc = new SalesAcc();
    acc.add('2026-11-01', 'A', 100, 100);
    expect(acc.rows('brandstore', { from: '2026-11-01', to: '2026-11-01' }, new Map([['2026-11-01', { adRevenue: 500 }]]))[0]).toMatchObject({ revenue: 100, adAttributedRevenue: 100 });
    expect(acc.rows('brandstore', { from: '2026-11-01', to: '2026-11-01' })[0]).toMatchObject({ revenue: 100, adAttributedRevenue: 100 });
  });
});
