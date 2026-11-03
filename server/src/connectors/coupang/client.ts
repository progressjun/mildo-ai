/**
 * 쿠팡 Wing Open API 클라이언트 — HMAC 서명 · 발주서(주문) · 상품 · 재고 · 즉시할인 쿠폰.
 *
 * 공식 문서 (Coupang Developer Center, 2026-11-03 확인 — 2026-07 리뉴얼된 developers.coupang.com):
 *   - HMAC Signature 생성: https://developers.coupang.com/ko/getting-started/creating-hmac-signature
 *       signed-date = UTC yyMMdd'T'HHmmss'Z' · message = signed-date + METHOD + path + query(‘?’ 없는 쿼리 문자열)
 *       signature = hex(HMAC-SHA256(secretKey, message))
 *       Authorization: CEA algorithm=HmacSHA256, access-key={accessKey}, signed-date={signedDate}, signature={signature}
 *       예제(PHP · Python · Node.js)는 서명한 쿼리 문자열을 그대로 URL에 붙여 보낸다 — 여기서도 쿼리를 직접 만들어 서명 · 전송에 같은 문자열을 쓴다
 *   - Node.js Examples: https://developers.coupang.com/ko/getting-started/nodejs-examples  (signed-date 생성식, Content-Type application/json;charset=UTF-8)
 *   - 발주서 목록 조회(일단위 페이징): https://developers.coupang.com/ko/api/shipments/po-list-query-paging-by-day?market=KR
 *       GET /v2/providers/openapi/apis/api/v5/vendors/{vendorId}/ordersheets?createdAtFrom=yyyy-mm-dd+09:00&createdAtTo=…(최대 31일)
 *       &status(필수: ACCEPT · INSTRUCT · DEPARTURE · DELIVERING · FINAL_DELIVERY · NONE_TRACKING)&maxPerPage(기본 50)&nextToken
 *       응답 { code, message, data[{ shipmentBoxId, orderId, orderedAt, paidAt, status, orderItems[{ vendorItemId, sellerProductId,
 *       sellerProductName, shippingCount, cancelCount, holdCountForCancel, canceled, salesPrice{units,nanos}, orderPrice, discountPrice,
 *       productSalesPageUrl … }] }], nextToken(마지막이면 빈 값) }. 금액은 { currencyCode, units, nanos } 객체.
 *       발주 가능 수량 = shippingCount − (holdCountForCancel + cancelCount). 반품 완료 건은 발주서 목록에서 조회되지 않는다.
 *   - 상품 목록 페이징 조회: https://developers.coupang.com/ko/api/products/product-list-paging-query?market=KR
 *       GET /v2/providers/seller_api/apis/api/v1/marketplace/seller-products?vendorId&nextToken&maxPerPage(최대 100)&status
 *   - 상품 조회: https://developers.coupang.com/ko/api/products/querying-product?market=KR
 *       GET …/seller-products/{sellerProductId} → data.items[{ vendorItemId, itemName, salePrice, maximumBuyCount }]
 *   - 상품 아이템별 수량/가격/상태 조회: https://developers.coupang.com/ko/api/products/query-quantitypricestatus-by-product-items?market=KR
 *       GET …/vendor-items/{vendorItemId}/inventories → data{ amountInStock, salePrice, onSale }
 *   - [즉시할인쿠폰] 목록 조회(status): https://developers.coupang.com/ko/api/promotions/instant-discount-coupon-query-a-list-of-coupons-status?market=KR
 *       GET /v2/providers/fms/apis/api/v2/vendors/{vendorId}/coupons?status(STANDBY · APPLIED · PAUSED · EXPIRED · DETACHED)&page&size&sort
 *       → data.content[{ couponId, promotionName, discount, type(RATE · PRICE · FIXED_WITH_QUANTITY), startAt, endAt, status }]
 *   - Open API Key 발급(호출 허용 IP 등록 필요): https://developers.coupang.com/ko/getting-started/issue-open-api-keynew
 */
import { createHmac } from 'node:crypto';
import type { ConnectorContext } from '../types';
import { callSales, type ApiResponse, type ErrorInfo, type HttpRequest } from '../naver-commerce/sales-shared';

export const COUPANG_BASE = 'https://api-gateway.coupang.com';
export const COUPANG_LABEL = '쿠팡 Wing Open API';
const PROVIDER = 'coupang';

export interface CoupangCredentials { vendorId: string; accessKey: string; secretKey: string }

/** UTC yyMMdd'T'HHmmss'Z' (문서 Node.js 예제: new Date().toISOString().substr(2,17) 에서 '-' ':' 제거 + 'Z') */
export function coupangSignedDate(ms: number): string {
  return `${new Date(ms).toISOString().slice(2, 19).replace(/[-:]/g, '')}Z`;
}

/** hex(HMAC-SHA256(secretKey, signedDate + METHOD + path + query)) */
export function coupangSignature(secretKey: string, signedDate: string, method: string, path: string, query: string): string {
  return createHmac('sha256', secretKey).update(`${signedDate}${method.toUpperCase()}${path}${query}`).digest('hex');
}

export function coupangAuthorization(c: Pick<CoupangCredentials, 'accessKey' | 'secretKey'>, method: string, path: string, query: string, ms: number): string {
  const dt = coupangSignedDate(ms);
  return `CEA algorithm=HmacSHA256, access-key=${c.accessKey}, signed-date=${dt}, signature=${coupangSignature(c.secretKey, dt, method, path, query)}`;
}

/**
 * 쿼리 문자열 (undefined 제외). 발주서 문서의 예시 엔드포인트 · 파라미터 설명이 정한 형태
 * `createdAtFrom=2025-07-15%2B09:00` 그대로 — '+'는 %2B로, ':'는 인코딩하지 않는다. 나머지는 URLSearchParams 규칙.
 * 서명(message)과 전송 URL에 같은 문자열을 쓰므로 서명 · 전송이 어긋나지 않는다.
 */
export function coupangQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  return qs.toString().replace(/%3A/gi, ':');
}

/** 금액: { units, nanos } 객체(v5) 또는 숫자 → 원 */
export function money(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (v && typeof v === 'object') {
    const o = v as { units?: unknown; nanos?: unknown };
    const u = Number(o.units ?? 0);
    const n = Number(o.nanos ?? 0);
    return (Number.isFinite(u) ? u : 0) + (Number.isFinite(n) ? n / 1e9 : 0);
  }
  return 0;
}

/** 오류 본문: { code: 'ERROR' | 400, message } (문서 오류 사양 예: 'Invalid vendor ID', 'endTime-startTime range should less than31.') */
export function describeCoupangError(status: number, data: unknown): ErrorInfo | null {
  if (!data || typeof data !== 'object') {
    if (typeof data === 'string' && data.trim()) return { detail: data.trim().slice(0, 300) };
    return null;
  }
  const d = data as { code?: unknown; message?: string; errorMessage?: string; httpStatus?: number };
  const text = [d.message, d.errorMessage].filter((x) => typeof x === 'string' && x.trim()).join(' — ');
  const code = d.code !== undefined ? String(d.code) : undefined;
  // 200 본문에 오류를 담는 경우 (code: 'ERROR')
  if (status >= 200 && status < 300) return code === 'ERROR' ? { kind: 'invalid', code, detail: text || 'code=ERROR' } : null;
  if (status === 401) return { kind: 'auth', code, detail: `${text} — Access Key · Secret Key와 서버 시각(UTC 서명 시각)을 확인해 주세요`.trim() };
  if (status === 403) return { kind: 'permission', code, detail: `${text} — Wing의 Open API 키 화면에서 이 서버의 호출 허용 IP를 등록했는지 확인해 주세요`.trim() };
  if (/vendor\s*id/i.test(text)) return { kind: 'invalid', code, detail: `${text} — 판매자 ID(vendorId, 예: A00012345)를 확인해 주세요` };
  return text || code ? { code, detail: text || code } : null;
}

export interface CoupangMoney { currencyCode?: string; units?: number; nanos?: number }
export interface CoupangOrderItem {
  vendorItemId?: number;
  vendorItemName?: string;
  productId?: number;
  sellerProductId?: number;
  sellerProductName?: string;
  sellerProductItemName?: string;
  shippingCount?: number;
  cancelCount?: number;
  holdCountForCancel?: number;
  canceled?: boolean;
  salesPrice?: CoupangMoney | number | null;
  orderPrice?: CoupangMoney | number | null;
  discountPrice?: CoupangMoney | number | null;
  productSalesPageUrl?: string;
}
export interface CoupangOrderSheet {
  shipmentBoxId?: number | string;
  orderId?: number | string;
  orderedAt?: string;
  paidAt?: string;
  status?: string;
  orderItems?: CoupangOrderItem[];
}
export interface CoupangOrderSheetsResponse { code?: number | string; message?: string; data?: CoupangOrderSheet[]; nextToken?: string | null }

export interface CoupangSellerProductSummary { sellerProductId?: number; sellerProductName?: string; productId?: number; statusName?: string; brand?: string }
export interface CoupangSellerProductsResponse { code?: string; message?: string; nextToken?: string | null; data?: CoupangSellerProductSummary[] }
export interface CoupangProductItem { sellerProductItemId?: number; vendorItemId?: number | null; itemName?: string; salePrice?: number; originalPrice?: number; maximumBuyCount?: number }
export interface CoupangProductDetail { code?: string; data?: { sellerProductId?: number; sellerProductName?: string; displayProductName?: string; statusName?: string; productId?: number; items?: CoupangProductItem[] } }
export interface CoupangInventory { code?: string; data?: { sellerItemId?: number; amountInStock?: number; salePrice?: number; onSale?: boolean } }
export interface CoupangCoupon { couponId?: number; promotionName?: string | null; discount?: number; maxDiscountPrice?: number; type?: string; startAt?: string; endAt?: string; status?: string }
export interface CoupangCouponsResponse {
  code?: number; message?: string; errorMessage?: string;
  data?: { success?: boolean; content?: CoupangCoupon[]; pagination?: { currentPage?: number; totalPages?: number }; Pagination?: { currentPage?: number; totalPages?: number }[] | { currentPage?: number; totalPages?: number } };
}

/** 발주서 상태 (일단위 페이징 조회의 status 필수값 전체) */
export const ORDER_SHEET_STATUSES = ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'] as const;
export type OrderSheetStatus = (typeof ORDER_SHEET_STATUSES)[number];

export class CoupangClient {
  constructor(
    private ctx: Pick<ConnectorContext, 'http'>,
    private creds: CoupangCredentials,
    private o: { baseUrl?: string; now?: () => number } = {},
  ) {}

  get base(): string { return (this.o.baseUrl ?? COUPANG_BASE).replace(/\/$/, ''); }
  get vendorId(): string { return this.creds.vendorId; }

  /** 서명된 요청 — 쿼리는 서명 문자열과 같은 문자열을 URL에 직접 붙인다 */
  request(method: HttpRequest['method'], path: string, params: Record<string, string | number | boolean | undefined> = {}, body?: unknown): HttpRequest {
    const query = coupangQuery(params);
    return {
      method,
      url: `${this.base}${path}${query ? `?${query}` : ''}`,
      headers: {
        Authorization: coupangAuthorization(this.creds, method, path, query, (this.o.now ?? Date.now)()),
        'Content-Type': 'application/json;charset=UTF-8',
      },
      ...(body !== undefined ? { body, bodyType: 'json' as const } : {}),
    };
  }

  async call<T>(method: HttpRequest['method'], path: string, what: string, params?: Record<string, string | number | boolean | undefined>, timeoutMs?: number): Promise<ApiResponse<T>> {
    const req = this.request(method, path, params);
    if (timeoutMs) req.timeoutMs = timeoutMs;
    return callSales<T>(this.ctx, req, { provider: PROVIDER, label: COUPANG_LABEL, what, describe: describeCoupangError });
  }

  /** 발주서 한 페이지 (createdAt 날짜 구간 · 상태 하나). 문서: 주문이 많으면 타임아웃이 날 수 있어 60초로 늘린다 */
  async orderSheets(from: string, to: string, status: OrderSheetStatus, nextToken?: string, maxPerPage = 50): Promise<CoupangOrderSheetsResponse> {
    return (await this.call<CoupangOrderSheetsResponse>('GET', `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(this.vendorId)}/ordersheets`, '발주서(주문) 조회', {
      createdAtFrom: `${from}+09:00`, createdAtTo: `${to}+09:00`, status, maxPerPage, nextToken: nextToken || undefined,
    }, 60_000)).data ?? {};
  }

  async sellerProducts(nextToken?: string, status?: string, maxPerPage = 100): Promise<CoupangSellerProductsResponse> {
    return (await this.call<CoupangSellerProductsResponse>('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', '상품 목록 조회', {
      vendorId: this.vendorId, nextToken: nextToken || undefined, maxPerPage, status,
    })).data ?? {};
  }

  async sellerProduct(sellerProductId: number | string): Promise<CoupangProductDetail> {
    return (await this.call<CoupangProductDetail>('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${encodeURIComponent(String(sellerProductId))}`, '상품 조회')).data ?? {};
  }

  async inventory(vendorItemId: number | string): Promise<CoupangInventory> {
    return (await this.call<CoupangInventory>('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(String(vendorItemId))}/inventories`, '옵션 재고 조회')).data ?? {};
  }

  async coupons(status: 'STANDBY' | 'APPLIED', page: number, size = 50): Promise<CoupangCouponsResponse> {
    return (await this.call<CoupangCouponsResponse>('GET', `/v2/providers/fms/apis/api/v2/vendors/${encodeURIComponent(this.vendorId)}/coupons`, '즉시할인 쿠폰 조회', {
      status, page, size, sort: 'desc',
    })).data ?? {};
  }
}
