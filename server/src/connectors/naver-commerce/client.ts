/**
 * 네이버 커머스API 클라이언트 — 전자서명(bcrypt) · 인증 토큰 · 상품 주문 · 상품 조회.
 *
 * 공식 문서 (커머스API 2.91.0, 2026-11-03 확인):
 *   - 인증 가이드: https://apicenter.commerce.naver.com/docs/auth
 *       OAuth2 Client Credentials. 전자서명 = Base64( BCrypt.hashpw(`${client_id}_${timestamp}`, client_secret) )
 *       — 애플리케이션 시크릿이 bcrypt salt다. timestamp는 밀리초 Unix 시간(5분간 유효).
 *       문서 코드 예시(Node.js · Python): client_id 'aaaabbbbcccc', secret '$2a$10$abcdefghijklmnopqrstuv', timestamp 1643961623299
 *       → 'JDJhJDEwJGFiY2RlZmdoaWprbG1ub3BxcnN0dXVCVldZSk42T0VPdEx1OFY0cDQxa2IuTnpVaUEzbmsy' (테스트 벡터로 사용)
 *       401 + 게이트웨이 코드 GW.AUTHN → 토큰 만료 가능성이 높으니 재발급 후 재호출(문서 권장 fallback)
 *   - 인증 토큰 발급 요청: https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth
 *       POST https://api.commerce.naver.com/external/v1/oauth2/token (application/x-www-form-urlencoded)
 *       client_id · timestamp · grant_type=client_credentials · client_secret_sign · type(SELF | SELLER) · account_id(SELLER일 때)
 *       응답 { access_token, expires_in(초), token_type }. 유효 3시간, 남은 시간 30분 미만이면 새 토큰 발급
 *   - 제약 사항: https://apicenter.commerce.naver.com/docs/restriction  (429 · GW.RATE_LIMIT / GW.QUOTA_LIMIT, 토큰 버킷)
 *   - RESTful API: https://apicenter.commerce.naver.com/docs/restful-api  (호스트 · 일시 형식 yyyy-MM-dd'T'HH:mm:ss.SSS+09:00)
 *   - 조건형 상품 주문 상세 내역 조회: https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-with-conditions-pay-order-seller
 *       GET /v1/pay-order/seller/product-orders?from&to(포함, 생략 시 from+24시간)&rangeType(기본 PAYED_DATETIME)&page&pageSize(최대 300)
 *       &quantityClaimCompatibility(수량 클레임 대응 시 true) → data.contents[{ productOrderId, content:{ order, productOrder, … } }] · data.pagination.hasNext
 *   - 상품 목록 조회: https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product
 *       POST /v1/products/search { productStatusTypes, page, size(최대 500), orderType } → contents[{ originProductNo, channelProducts[] }] · last
 *   - 원상품 조회: https://apicenter.commerce.naver.com/docs/commerce-api/current/read-origin-product-product
 *       GET /v2/products/origin-products/{originProductNo} → originProduct.detailAttribute.optionInfo(optionCombinations · optionStandards)
 *       · originProduct.customerBenefit.immediateDiscountPolicy.discountMethod
 *   - 채널 정보 · 계정 정보: https://apicenter.commerce.naver.com/docs/commerce-api/current/get-channels-by-account-no-sellers
 *       GET /v1/seller/channels · GET /v1/seller/account (https://apicenter.commerce.naver.com/docs/commerce-api/current/get-account-info-by-account-no-sellers)
 */
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { ConnectorContext } from '../types';
import { SalesApiError, callSales, errorMessage, type ApiResponse, type ErrorInfo, type HttpRequest } from './sales-shared';

export const NAVER_COMMERCE_BASE = 'https://api.commerce.naver.com/external';
export const NAVER_COMMERCE_LABEL = '네이버 커머스API';
const PROVIDER = 'naver_commerce';

export interface NaverCommerceCredentials {
  clientId: string;
  /** 애플리케이션 시크릿 = bcrypt salt ($2a$NN$ + 22자) */
  clientSecret: string;
  /** type=SELLER(솔루션사가 판매자 리소스를 호출)일 때 판매자 ID 또는 UID */
  accountId?: string;
}

/** bcrypt(password, salt) — 테스트에서 바꿔 끼울 수 있다 */
export type HashFn = (password: string, salt: string) => string;
export const bcryptHash: HashFn = (password, salt) => bcrypt.hashSync(password, salt);

/** 전자서명: Base64(bcrypt(`${clientId}_${timestamp}`, clientSecret)) — 문서 Node.js 예시와 같은 표준 Base64 */
export function clientSecretSign(clientId: string, clientSecret: string, timestamp: number | string, hash: HashFn = bcryptHash): string {
  return Buffer.from(hash(`${clientId}_${timestamp}`, clientSecret), 'utf-8').toString('base64');
}

/** 오류 본문: { code, message, timestamp, traceId, invalidInputs[] } (문서 OAuth2ErrorResponse · 게이트웨이 오류 예시) */
export function describeNaverCommerceError(status: number, data: unknown): ErrorInfo | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { code?: string; message?: string; invalidInputs?: { name?: string; message?: string }[]; traceId?: string };
  const inputs = Array.isArray(d.invalidInputs) ? d.invalidInputs.map((i) => [i?.name, i?.message].filter(Boolean).join(': ')).filter(Boolean) : [];
  const text = [d.message, inputs.length ? `[${inputs.join('; ')}]` : '', d.traceId ? `traceId ${d.traceId}` : ''].filter(Boolean).join(' ');
  const code = typeof d.code === 'string' ? d.code : undefined;
  if (code === 'GW.AUTHN' || status === 401) return { kind: 'auth', code: code ?? '401', detail: text || undefined };
  if (code === 'GW.RATE_LIMIT' || code === 'GW.QUOTA_LIMIT' || status === 429) return { kind: 'rate', code: code ?? '429', detail: text || undefined };
  if (code === 'GW.AUTHZ' || status === 403) return { kind: 'permission', code: code ?? '403', detail: `${text} — 커머스API센터 애플리케이션의 API 그룹 권한을 확인해 주세요` };
  return text || code ? { code, detail: text || code } : null;
}

/* ---------------- 인증 토큰 (프로세스 메모리 캐시) ---------------- */

const tokenCache = new Map<string, { token: string; exp: number }>();
export function _resetNaverCommerceTokenCacheForTest(): void {
  tokenCache.clear();
}
/** 남은 유효 시간이 이보다 짧으면 새로 발급받는다 (문서: 30분 미만이면 새 토큰) */
const REFRESH_MARGIN_MS = 30 * 60_000;

export interface NaverCommerceClientOptions {
  baseUrl?: string;
  now?: () => number;
  hash?: HashFn;
  /** SELF(기본, 자기 스토어) · SELLER(솔루션사 — accountId 필요) */
  tokenType?: 'SELF' | 'SELLER';
}

export interface NaverOrder {
  orderId?: string;
  orderDate?: string;
  paymentDate?: string;
  ordererNo?: string;
}
export interface NaverProductOrder {
  productOrderId?: string;
  productOrderStatus?: string;
  claimType?: string | null;
  claimStatus?: string | null;
  quantity?: number;
  initialQuantity?: number;
  remainQuantity?: number;
  unitPrice?: number;
  optionPrice?: number;
  totalProductAmount?: number;
  initialProductAmount?: number;
  remainProductAmount?: number;
  totalPaymentAmount?: number;
  initialPaymentAmount?: number;
  remainPaymentAmount?: number;
  productId?: string;
  originalProductId?: string;
  productName?: string;
  productOption?: string;
  inflowPath?: string;
}
export interface NaverProductOrderContent {
  productOrderId?: string;
  content?: { order?: NaverOrder; productOrder?: NaverProductOrder };
}
export interface NaverProductOrdersResponse {
  timestamp?: string;
  traceId?: string;
  data?: { contents?: NaverProductOrderContent[]; pagination?: { page?: number; size?: number; hasNext?: boolean } };
}

export interface NaverChannelProduct {
  originProductNo?: number;
  channelProductNo?: number;
  channelServiceType?: string;
  name?: string;
  statusType?: string;
  channelProductDisplayStatusType?: string;
  salePrice?: number;
  discountedPrice?: number;
  stockQuantity?: number;
  sellerManagementCode?: string;
}
export interface NaverProductSearchResponse {
  contents?: { originProductNo?: number; groupProductNo?: number; channelProducts?: NaverChannelProduct[] }[];
  page?: number;
  size?: number;
  totalElements?: number;
  totalPages?: number;
  first?: boolean;
  last?: boolean;
}

export interface NaverOptionCombination {
  id?: number;
  optionName1?: string;
  optionName2?: string;
  optionName3?: string;
  optionName4?: string;
  stockQuantity?: number;
  price?: number;
  usable?: boolean;
  sellerManagerCode?: string;
}
export interface NaverOriginProduct {
  originProduct?: {
    statusType?: string;
    name?: string;
    salePrice?: number;
    stockQuantity?: number;
    detailAttribute?: {
      optionInfo?: {
        optionCombinations?: NaverOptionCombination[];
        optionStandards?: (NaverOptionCombination & { optionName1?: string; optionName2?: string })[];
        useStockManagement?: boolean;
      };
    };
    customerBenefit?: {
      immediateDiscountPolicy?: { discountMethod?: { value?: number; unitType?: string; startDate?: string; endDate?: string } };
    };
  };
  smartstoreChannelProduct?: { channelProductName?: string; channelProductDisplayStatusType?: string };
}

export interface NaverChannelInfo { channelNo?: number; channelType?: string; name?: string; url?: string }

/** 판매 상태 (상품 목록 조회 productStatusTypes) — 판매 중 · 품절 · 판매 대기 · 판매 중지 */
export const PRODUCT_STATUSES = ['SALE', 'OUTOFSTOCK', 'WAIT', 'SUSPENSION'] as const;

export class NaverCommerceClient {
  constructor(
    private ctx: Pick<ConnectorContext, 'http' | 'connectionId'>,
    private creds: NaverCommerceCredentials,
    private o: NaverCommerceClientOptions = {},
  ) {}

  get base(): string { return (this.o.baseUrl ?? NAVER_COMMERCE_BASE).replace(/\/$/, ''); }
  private now(): number { return (this.o.now ?? Date.now)(); }
  private get tokenType(): 'SELF' | 'SELLER' { return this.o.tokenType ?? (this.creds.accountId ? 'SELLER' : 'SELF'); }
  private cacheKey(): string {
    return createHash('sha256').update(`${this.ctx.connectionId}|${this.creds.clientId}|${this.creds.clientSecret}|${this.tokenType}|${this.creds.accountId ?? ''}`).digest('hex');
  }

  /** 토큰 발급 요청 본문 (form). 비밀값(client_secret)은 보내지 않고 전자서명만 보낸다 */
  tokenRequest(timestamp: number): HttpRequest {
    const type = this.tokenType;
    if (type === 'SELLER' && !this.creds.accountId) {
      throw new SalesApiError(PROVIDER, 'invalid', `${NAVER_COMMERCE_LABEL} 토큰 유형 SELLER에는 판매자 ID(accountId)가 필요합니다`);
    }
    let sign: string;
    try {
      sign = clientSecretSign(this.creds.clientId, this.creds.clientSecret, timestamp, this.o.hash);
    } catch (e) {
      throw new SalesApiError(PROVIDER, 'auth', `${NAVER_COMMERCE_LABEL} 전자서명 생성 실패 — 애플리케이션 시크릿 형식($2a$… bcrypt salt)을 확인해 주세요 (${(e as Error).message})`);
    }
    return {
      method: 'POST',
      url: `${this.base}/v1/oauth2/token`,
      bodyType: 'form',
      body: {
        client_id: this.creds.clientId,
        timestamp: String(timestamp),
        grant_type: 'client_credentials',
        client_secret_sign: sign,
        type,
        ...(type === 'SELLER' ? { account_id: this.creds.accountId } : {}),
      },
    };
  }

  async token(force = false): Promise<string> {
    const key = this.cacheKey();
    const hit = tokenCache.get(key);
    if (!force && hit && hit.exp - REFRESH_MARGIN_MS > this.now()) return hit.token;
    const ts = this.now();
    const res = await callSales<{ access_token?: string; expires_in?: number; token_type?: string }>(this.ctx, this.tokenRequest(ts), {
      provider: PROVIDER, label: NAVER_COMMERCE_LABEL, what: '인증 토큰 발급', describe: (s, d) => {
        const info = describeNaverCommerceError(s, d);
        // 토큰 발급의 400 · 403은 대부분 애플리케이션 ID · 시크릿 · 서명 문제
        if (s === 400 || s === 403) return { ...info, kind: 'auth', detail: `${info?.detail ?? ''} — 애플리케이션 ID · 시크릿, 서버 시각(timestamp 5분 유효)을 확인해 주세요`.trim() };
        return info;
      },
    });
    const token = res.data?.access_token;
    if (!token) throw new SalesApiError(PROVIDER, 'auth', errorMessage('auth', NAVER_COMMERCE_LABEL, '인증 토큰 발급', res.status, '응답에 access_token이 없습니다'));
    const ttl = Number(res.data?.expires_in);
    tokenCache.set(key, { token, exp: ts + (Number.isFinite(ttl) && ttl > 0 ? ttl : 10_800) * 1000 });
    return token;
  }

  /** 인증 헤더가 붙은 요청 (토큰은 호출 시점에 넣는다 — 화면 · 로그에는 남지 않는다) */
  request(method: HttpRequest['method'], path: string, query?: HttpRequest['query'], body?: unknown, token = '(발급 토큰)'): HttpRequest {
    return {
      method,
      url: `${this.base}${path}`,
      query,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body, bodyType: 'json' as const } : {}),
    };
  }

  /** 401(GW.AUTHN)이면 토큰을 다시 받아 한 번 더 부른다 (문서 권장 fallback) */
  async call<T>(method: HttpRequest['method'], path: string, what: string, query?: HttpRequest['query'], body?: unknown): Promise<ApiResponse<T>> {
    const opts = { provider: PROVIDER, label: NAVER_COMMERCE_LABEL, what, describe: describeNaverCommerceError };
    try {
      return await callSales<T>(this.ctx, this.request(method, path, query, body, await this.token()), opts);
    } catch (e) {
      if (!(e instanceof SalesApiError) || e.kind !== 'auth' || e.status !== 401) throw e;
      tokenCache.delete(this.cacheKey());
      return callSales<T>(this.ctx, this.request(method, path, query, body, await this.token(true)), opts);
    }
  }

  /** 결제 일시 기준 상품 주문 한 페이지 (from · to 포함, 24시간 이내 구간) */
  async productOrders(from: string, to: string, page: number, pageSize = 300): Promise<NaverProductOrdersResponse> {
    return (await this.call<NaverProductOrdersResponse>('GET', '/v1/pay-order/seller/product-orders', '상품 주문 조회', {
      from, to, rangeType: 'PAYED_DATETIME', page, pageSize, quantityClaimCompatibility: true,
    })).data ?? {};
  }

  async searchProducts(page: number, size: number): Promise<NaverProductSearchResponse> {
    return (await this.call<NaverProductSearchResponse>('POST', '/v1/products/search', '상품 목록 조회', undefined, {
      productStatusTypes: [...PRODUCT_STATUSES], page, size, orderType: 'NO',
    })).data ?? {};
  }

  async originProduct(originProductNo: number | string): Promise<NaverOriginProduct> {
    return (await this.call<NaverOriginProduct>('GET', `/v2/products/origin-products/${encodeURIComponent(String(originProductNo))}`, '원상품 조회')).data ?? {};
  }

  /** 계정 하위 채널 (문서 스키마는 단일 객체, 실응답이 배열이어도 받는다) */
  async channels(): Promise<NaverChannelInfo[]> {
    const d = (await this.call<NaverChannelInfo | NaverChannelInfo[]>('GET', '/v1/seller/channels', '채널 정보 조회')).data;
    return Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : [];
  }

  async account(): Promise<{ accountId?: string; accountUid?: string; grade?: string }> {
    return (await this.call<{ accountId?: string; accountUid?: string; grade?: string }>('GET', '/v1/seller/account', '계정 정보 조회')).data ?? {};
  }
}
