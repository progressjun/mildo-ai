/**
 * 네이버 커머스API 응답 픽스처 — 공식 문서(OpenAPI 스키마)의 필드 이름 · 형태 그대로 (테스트 전용).
 *   인증 토큰 { access_token, expires_in, token_type } · 조건형 상품 주문 { timestamp, traceId, data:{ contents[{ productOrderId, content:{ order, productOrder } }], pagination } }
 *   상품 목록 { contents[{ originProductNo, channelProducts[] }], page, size, totalElements, totalPages, first, last } · 원상품 { originProduct, smartstoreChannelProduct }
 */
import type { NaverProductOrderContent } from './client';
import type { Handler } from './sales-testkit';

export const NAVER_CREDS = { clientId: 'aaaabbbbcccc', clientSecret: '$2a$10$abcdefghijklmnopqrstuv' };
export const NAVER_TOKEN = 'naver-commerce-token-0001';

interface PoSpec {
  orderId: string;
  productOrderId: string;
  paid: string;
  status?: string;
  qty?: number;
  remainQty?: number;
  pay: number;
  remainPay?: number;
  product: number;
  remainProduct?: number;
  inflowPath?: string;
  claimStatus?: string;
}

export function po(s: PoSpec): NaverProductOrderContent {
  const qty = s.qty ?? 1;
  return {
    productOrderId: s.productOrderId,
    content: {
      order: { orderId: s.orderId, orderDate: s.paid, paymentDate: s.paid, ordererNo: '10001' },
      productOrder: {
        productOrderId: s.productOrderId,
        productOrderStatus: s.status ?? 'PAYED',
        claimStatus: s.claimStatus ?? null,
        quantity: qty, initialQuantity: qty, remainQuantity: s.remainQty ?? qty,
        unitPrice: Math.round(s.product / qty), optionPrice: 0,
        totalProductAmount: s.product, initialProductAmount: s.product, remainProductAmount: s.remainProduct ?? s.product,
        totalPaymentAmount: s.pay, initialPaymentAmount: s.pay, remainPaymentAmount: s.remainPay ?? s.pay,
        productId: '1001', originalProductId: '9001', productName: '수면밀도 매트리스', productOption: '퀸',
        inflowPath: s.inflowPath ?? '네이버 쇼핑',
      },
    },
  };
}

/**
 * 날짜별 결제 상품 주문 (KST 하루 구간으로 조회되는 결과). 2026-11-01은 2페이지.
 * 2026-11-01 기대값: 주문 3건(O1 · O3 · O5), net 2,570,000 · gross 2,680,000 · 광고 경유 990,000
 * 2026-11-02 기대값: 주문 2건(O7 · O8), net 1,480,000
 */
export const NAVER_ORDERS: Record<string, NaverProductOrderContent[][]> = {
  '2026-11-01': [
    [
      po({ orderId: 'O1', productOrderId: 'PO1', paid: '2026-11-01T09:15:00.000+09:00', pay: 990_000, product: 1_100_000, inflowPath: '검색광고(SA)' }),
      po({ orderId: 'O1', productOrderId: 'PO2', paid: '2026-11-01T09:15:00.000+09:00', status: 'DELIVERED', pay: 290_000, product: 290_000 }),
      po({ orderId: 'O2', productOrderId: 'PO3', paid: '2026-11-01T11:00:00.000+09:00', status: 'CANCELED', pay: 790_000, product: 790_000, claimStatus: 'CANCEL_DONE' }),
      // UTC 표기 14:59:59Z = KST 23:59:59 → 11-01
      po({ orderId: 'O3', productOrderId: 'PO4', paid: '2026-11-01T14:59:59.000Z', status: 'PURCHASE_DECIDED', pay: 500_000, product: 500_000 }),
    ],
    [
      po({ orderId: 'O4', productOrderId: 'PO5', paid: '2026-11-01T15:00:00.000+09:00', status: 'RETURNED', pay: 990_000, product: 990_000, claimStatus: 'RETURN_DONE' }),
      // 수량 클레임: 2개 중 1개 취소 → 잔여 1개 · 잔여 결제 790,000
      po({ orderId: 'O5', productOrderId: 'PO6', paid: '2026-11-01T18:30:00.000+09:00', qty: 2, remainQty: 1, pay: 1_580_000, remainPay: 790_000, product: 1_580_000, remainProduct: 790_000 }),
      po({ orderId: 'O6', productOrderId: 'PO7', paid: '2026-11-01T20:00:00.000+09:00', status: 'PAYMENT_WAITING', pay: 290_000, product: 290_000 }),
    ],
  ],
  '2026-11-02': [
    [
      // UTC 15:00Z = KST 다음 날 00:00 → 11-02 (자정 넘김)
      po({ orderId: 'O7', productOrderId: 'PO8', paid: '2026-11-01T15:00:00.000Z', pay: 1_190_000, product: 1_190_000 }),
      po({ orderId: 'O7', productOrderId: 'PO8', paid: '2026-11-01T15:00:00.000Z', pay: 1_190_000, product: 1_190_000 }),
      po({ orderId: 'O8', productOrderId: 'PO9', paid: '2026-11-02T13:00:00.000+09:00', status: 'EXCHANGED', pay: 290_000, product: 290_000 }),
    ],
  ],
};

export const NAVER_SEARCH = {
  contents: [
    { originProductNo: 9001, groupProductNo: null, channelProducts: [
      { originProductNo: 9001, channelProductNo: 1001, channelServiceType: 'WINDOW', name: '윈도 상품', statusType: 'SALE', salePrice: 790_000, stockQuantity: 30 },
      { originProductNo: 9001, channelProductNo: 1002, channelServiceType: 'STOREFARM', name: '수면밀도 매트리스', statusType: 'SALE', channelProductDisplayStatusType: 'ON', salePrice: 790_000, discountedPrice: 671_500, stockQuantity: 30 },
    ] },
    { originProductNo: 9002, channelProducts: [
      { originProductNo: 9002, channelProductNo: 1003, channelServiceType: 'STOREFARM', name: '토퍼', statusType: 'OUTOFSTOCK', salePrice: 290_000, stockQuantity: 0 },
    ] },
  ],
  page: 1, size: 300, totalElements: 2, totalPages: 1, first: true, last: true,
};

export const NAVER_ORIGIN: Record<string, unknown> = {
  9001: {
    originProduct: {
      statusType: 'SALE', name: '수면밀도 매트리스', salePrice: 790_000, stockQuantity: 30,
      detailAttribute: { optionInfo: { optionCombinationGroupNames: { optionGroupName1: '사이즈' }, optionCombinations: [
        { id: 11, optionName1: '슈퍼싱글', stockQuantity: 10, price: 0, usable: true },
        { id: 12, optionName1: '퀸', stockQuantity: 20, price: 200_000, usable: true },
        { id: 13, optionName1: '킹', stockQuantity: 0, price: 400_000, usable: true },
      ], useStockManagement: true } },
      customerBenefit: { immediateDiscountPolicy: { discountMethod: { value: 15, unitType: 'PERCENT', startDate: '2026-10-20T00:00:00.000+09:00', endDate: '2026-11-03T23:59:00.000+09:00' } } },
    },
    smartstoreChannelProduct: { channelProductName: '수면밀도 매트리스 (주력)', channelProductDisplayStatusType: 'ON' },
  },
  9002: {
    originProduct: {
      statusType: 'OUTOFSTOCK', name: '토퍼', salePrice: 290_000, stockQuantity: 0,
      // 기간 없는 상시 할인 → 프로모션 아님
      customerBenefit: { immediateDiscountPolicy: { discountMethod: { value: 29_000, unitType: 'WON' } } },
    },
  },
};

const json = (data: unknown, status = 200) => ({ status, data });

/** 네이버 커머스API 가짜 서버. opts.orders로 날짜별 페이지를 바꿀 수 있다 */
export function naverHandler(opts: { orders?: Record<string, NaverProductOrderContent[][]>; token?: string; onToken?: (body: Record<string, unknown>) => void } = {}): Handler {
  const orders = opts.orders ?? NAVER_ORDERS;
  return (r) => {
    if (r.url.hostname !== 'api.commerce.naver.com') return null;
    const p = r.url.pathname;
    if (r.method === 'POST' && p === '/external/v1/oauth2/token') {
      opts.onToken?.(r.body as Record<string, unknown>);
      return json({ access_token: opts.token ?? NAVER_TOKEN, expires_in: 10_800, token_type: 'Bearer' });
    }
    if (r.headers.authorization !== `Bearer ${opts.token ?? NAVER_TOKEN}`) return json({ code: 'GW.AUTHN', message: '요청을 보낼 권한이 없습니다.', timestamp: '2026-11-03T10:00:00.000+09:00' }, 401);
    if (r.method === 'GET' && p === '/external/v1/pay-order/seller/product-orders') {
      const day = String(r.url.searchParams.get('from') ?? '').slice(0, 10);
      const page = Number(r.url.searchParams.get('page') ?? 1);
      const pages = orders[day] ?? [[]];
      const contents = pages[page - 1] ?? [];
      return json({ timestamp: '2026-11-03T10:00:00.000+09:00', traceId: 't-1', data: { contents, pagination: { page, size: 300, hasNext: page < pages.length } } });
    }
    if (r.method === 'POST' && p === '/external/v1/products/search') return json(NAVER_SEARCH);
    const m = p.match(/^\/external\/v2\/products\/origin-products\/(\d+)$/);
    if (r.method === 'GET' && m) return NAVER_ORIGIN[m[1]] ? json(NAVER_ORIGIN[m[1]]) : json({ code: 'NOT_FOUND', message: '상품 없음' }, 404);
    if (r.method === 'GET' && p === '/external/v1/seller/channels') return json([{ channelNo: 1, channelType: 'STOREFARM', name: '수면밀도 브랜드스토어', url: 'https://brand.naver.com/mildo' }]);
    if (r.method === 'GET' && p === '/external/v1/seller/account') return json({ accountId: 'mildo', accountUid: 'ncp_1', grade: 'FIRST' });
    return null;
  };
}
