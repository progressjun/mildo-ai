/**
 * 쿠팡 Wing Open API 응답 픽스처 — 공식 문서 응답 예시의 필드 이름 · 형태 그대로 (테스트 전용).
 *   발주서 { code:200, message:'OK', data[{ shipmentBoxId, orderId, orderedAt, paidAt, status, orderItems[…] }], nextToken }
 *   금액 { units, nanos } · 상품 목록 { code:'SUCCESS', nextToken, data[] } · 상품 조회 { data:{ items[] } } · 재고 { data:{ amountInStock, salePrice, onSale } }
 */
import { createHmac } from 'node:crypto';
import type { CoupangOrderSheet } from './client';
import type { Handler } from '../naver-commerce/sales-testkit';

export const COUPANG_CREDS = { vendorId: 'A00012345', accessKey: 'cp-access-key-0001', secretKey: 'cp-secret-key-0001-xyz' };

const won = (units: number) => ({ currencyCode: 'KRW', units, nanos: 0 });

interface ItemSpec { vendorItemId: number; sellerProductId?: number; price: number; count: number; cancel?: number; hold?: number; canceled?: boolean; discount?: number }
export function sheet(o: { box: number; orderId: number; paidAt: string; status?: string; items: ItemSpec[] }): CoupangOrderSheet {
  return {
    shipmentBoxId: o.box,
    orderId: o.orderId,
    orderedAt: o.paidAt,
    paidAt: o.paidAt,
    status: o.status ?? 'ACCEPT',
    orderItems: o.items.map((i, n) => ({
      sequenceNo: String(n + 1).padStart(3, '0'),
      vendorItemId: i.vendorItemId,
      vendorItemName: `수면밀도 매트리스, 옵션 ${i.vendorItemId}`,
      productId: (i.sellerProductId ?? 80240831) === 80240832 ? 31846052 : 31846051,
      sellerProductId: i.sellerProductId ?? 80240831,
      sellerProductName: '수면밀도 매트리스',
      sellerProductItemName: `옵션 ${i.vendorItemId}`,
      shippingCount: i.count,
      cancelCount: i.cancel ?? 0,
      holdCountForCancel: i.hold ?? 0,
      canceled: i.canceled ?? false,
      salesPrice: won(i.price),
      orderPrice: won(i.price * i.count),
      discountPrice: i.discount ? won(i.discount) : null,
      productSalesPageUrl: `https://www.coupang.com/vp/products/${(i.sellerProductId ?? 80240831) === 80240832 ? 31846052 : 31846051}`,
    })) as never,
  } as CoupangOrderSheet;
}

/**
 * 상태별 발주서 (주문 생성일 구간 조회 결과). ACCEPT는 2페이지(nextToken).
 * 결제일 KST 2026-11-01: 주문 2건(1001 · 1003), gross 990,000 + 790,000×1 = 1,780,000, net 1,780,000 − 50,000 = 1,730,000
 * 결제일 KST 2026-11-02: 주문 2건(1004 · 1005) gross 290,000 + 1,190,000 = 1,480,000
 */
export const COUPANG_SHEETS: Record<string, CoupangOrderSheet[][]> = {
  ACCEPT: [
    [
      sheet({ box: 5001, orderId: 1001, paidAt: '2026-11-01T10:00:00.000000+09:00', items: [{ vendorItemId: 7001, price: 990_000, count: 1, discount: 50_000 }] }),
      // 전량 취소 (canceled)
      sheet({ box: 5002, orderId: 1002, paidAt: '2026-11-01T11:00:00.000000+09:00', items: [{ vendorItemId: 7002, price: 790_000, count: 1, cancel: 1, canceled: true }] }),
    ],
    [
      // 2개 중 1개 환불 대기 → 순수량 1
      sheet({ box: 5003, orderId: 1003, paidAt: '2026-11-01T14:59:00.000000Z', items: [{ vendorItemId: 7002, price: 790_000, count: 2, hold: 1 }] }),
    ],
  ],
  INSTRUCT: [[
    // 문서 예시처럼 다른 오프셋(-08:00): 2026-11-01T07:30-08:00 = KST 11-02 00:30 → 11-02
    sheet({ box: 5004, orderId: 1004, paidAt: '2026-11-01T07:30:00.000000-08:00', status: 'INSTRUCT', items: [{ vendorItemId: 7003, sellerProductId: 80240832, price: 290_000, count: 1 }] }),
  ]],
  FINAL_DELIVERY: [[
    sheet({ box: 5005, orderId: 1005, paidAt: '2026-11-02T20:00:00.000000+09:00', status: 'FINAL_DELIVERY', items: [{ vendorItemId: 7001, price: 1_190_000, count: 1 }] }),
    // 같은 배송번호가 다른 상태에서 또 보여도 한 번만
    sheet({ box: 5001, orderId: 1001, paidAt: '2026-11-01T10:00:00.000000+09:00', status: 'FINAL_DELIVERY', items: [{ vendorItemId: 7001, price: 990_000, count: 1, discount: 50_000 }] }),
  ]],
};

export const COUPANG_PRODUCTS = [
  { sellerProductId: 80240831, sellerProductName: '수면밀도 매트리스', displayCategoryCode: 77413, categoryId: 2102, productId: 31846051, vendorId: 'A00012345', saleStartedAt: '2026-01-01T00:00:00', saleEndedAt: '2099-12-31T00:00:00', brand: '수면밀도', statusName: 'APPROVED', createdAt: '2026-01-01T00:00:00' },
  { sellerProductId: 80240832, sellerProductName: '수면밀도 토퍼', displayCategoryCode: 77413, categoryId: 2102, productId: 31846052, vendorId: 'A00012345', statusName: 'APPROVED', createdAt: '2026-01-01T00:00:00' },
];
export const COUPANG_DETAILS: Record<string, unknown> = {
  80240831: { code: 'SUCCESS', message: '', data: { sellerProductId: 80240831, sellerProductName: '수면밀도 매트리스', statusName: '승인완료', productId: 31846051, items: [
    { sellerProductItemId: 1271845812, vendorItemId: 7001, itemId: 1, itemName: '퀸', originalPrice: 0, salePrice: 990_000, maximumBuyCount: 5 },
    { sellerProductItemId: 1271845813, vendorItemId: 7002, itemId: 2, itemName: '슈퍼싱글', originalPrice: 0, salePrice: 790_000, maximumBuyCount: 0 },
  ] } },
  80240832: { code: 'SUCCESS', message: '', data: { sellerProductId: 80240832, sellerProductName: '수면밀도 토퍼', statusName: '승인완료', productId: 31846052, items: [
    { sellerProductItemId: 1271845814, vendorItemId: 7003, itemId: 3, itemName: '퀸', salePrice: 290_000, maximumBuyCount: 3 },
  ] } },
};
export const COUPANG_INVENTORY: Record<string, unknown> = {
  7001: { code: 'SUCCESS', message: '', data: { sellerItemId: 7001, amountInStock: 12, salePrice: 950_000, onSale: true } },
  7002: { code: 'SUCCESS', message: '', data: { sellerItemId: 7002, amountInStock: 0, salePrice: 790_000, onSale: true } },
  7003: { code: 'SUCCESS', message: '', data: { sellerItemId: 7003, amountInStock: 4, salePrice: 290_000, onSale: false } },
};
export const COUPANG_COUPONS = {
  APPLIED: [
    { contractId: 63, vendorContractId: null, promotionName: '쿠팡 11월 매트리스 위크', couponId: 2246326, status: 'APPLIED', type: 'RATE', maxDiscountPrice: 40_000, discount: 10, startAt: '2026-11-01 00:00:00', endAt: '2026-11-07 23:59:00', wowExclusive: 'false' },
    { contractId: 63, vendorContractId: null, promotionName: null, couponId: 2245939, status: 'APPLIED', type: 'PRICE', maxDiscountPrice: 30_000, discount: 30_000, startAt: '2026-10-01 00:00:00', endAt: '2026-10-31 23:59:00', wowExclusive: 'false' },
  ],
  STANDBY: [
    { contractId: 63, promotionName: '블랙프라이데이', couponId: 2300001, status: 'STANDBY', type: 'RATE', discount: 20, startAt: '2026-11-20 00:00:00', endAt: '2026-11-30 23:59:00' },
  ],
};

/** 서명 검증: Authorization 헤더를 문서 규칙으로 다시 계산해 맞는지 본다 */
export function verifyCoupangAuth(r: { method: string; url: URL; headers: Record<string, string> }, secretKey = COUPANG_CREDS.secretKey, accessKey = COUPANG_CREDS.accessKey): boolean {
  const m = /^CEA algorithm=HmacSHA256, access-key=([^,]+), signed-date=(\d{6}T\d{6}Z), signature=([0-9a-f]{64})$/.exec(r.headers.authorization ?? '');
  if (!m || m[1] !== accessKey) return false;
  const query = r.url.search.replace(/^\?/, '');
  const expected = createHmac('sha256', secretKey).update(`${m[2]}${r.method}${r.url.pathname}${query}`).digest('hex');
  return expected === m[3];
}

const ok = (data: unknown, status = 200) => ({ status, data });

export function coupangHandler(opts: { sheets?: Record<string, CoupangOrderSheet[][]>; secretKey?: string } = {}): Handler {
  const sheets = opts.sheets ?? COUPANG_SHEETS;
  return (r) => {
    if (r.url.hostname !== 'api-gateway.coupang.com') return null;
    if (!verifyCoupangAuth(r, opts.secretKey ?? COUPANG_CREDS.secretKey)) return ok({ code: 401, message: 'Specified signature is expired or invalid.' }, 401);
    const p = r.url.pathname;
    const sp = r.url.searchParams;
    if (p === `/v2/providers/openapi/apis/api/v5/vendors/${COUPANG_CREDS.vendorId}/ordersheets`) {
      const status = sp.get('status') ?? '';
      const page = Number(sp.get('nextToken') || 0);
      const pages = sheets[status] ?? [[]];
      // 생성일 구간 밖이면 비운다 (paidAt 날짜로 근사)
      const from = (sp.get('createdAtFrom') ?? '').slice(0, 10);
      const to = (sp.get('createdAtTo') ?? '').slice(0, 10);
      const data = (pages[page] ?? []).filter((s) => { const d = String(s.orderedAt).slice(0, 10); return d >= addDays(from, -1) && d <= to; });
      return ok({ code: 200, message: 'OK', data, nextToken: page + 1 < pages.length ? String(page + 1) : '' });
    }
    if (p === '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products') {
      const status = sp.get('status');
      const data = !status || status === 'APPROVED' ? COUPANG_PRODUCTS.slice(0, Number(sp.get('maxPerPage') ?? 100)) : [];
      return ok({ code: 'SUCCESS', message: '', nextToken: '', data });
    }
    let m = p.match(/^\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/seller-products\/(\d+)$/);
    if (m) return COUPANG_DETAILS[m[1]] ? ok(COUPANG_DETAILS[m[1]]) : ok({ code: 'ERROR', message: '상품 없음' }, 400);
    m = p.match(/^\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/vendor-items\/(\d+)\/inventories$/);
    if (m) return COUPANG_INVENTORY[m[1]] ? ok(COUPANG_INVENTORY[m[1]]) : ok({ code: 'ERROR', message: `유효한 옵션이 없습니다:[vendorItemId=${m[1]}]` }, 400);
    if (p === `/v2/providers/fms/apis/api/v2/vendors/${COUPANG_CREDS.vendorId}/coupons`) {
      const content = (COUPANG_COUPONS as Record<string, unknown[]>)[sp.get('status') ?? ''] ?? [];
      return ok({ code: 200, message: 'OK', httpStatus: 200, httpStatusMessage: 'OK', errorMessage: '', data: { success: true, content, pagination: { currentPage: 1, countPerPage: 50, totalPages: 1, totalElements: content.length } } });
    }
    return null;
  };
}

function addDays(d: string, n: number): string {
  if (!d) return d;
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
