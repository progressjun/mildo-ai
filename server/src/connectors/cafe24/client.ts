/**
 * 카페24 Admin API · Cafe24 Analytics API 클라이언트 — OAuth 2.0(인증 코드 · 갱신 토큰) · 주문 · 상품 · 품목 · 혜택 · 방문 통계.
 *
 * 공식 문서 (2026-11-03 확인, API 버전 2026-09-01 최신):
 *   - 시작하기: https://apidocs.cafe24.com/docs/guide/intro   (Base URL https://{mall_id}.cafe24api.com/api/v2, 에러 { error: { code, message, more_info } })
 *   - OAuth 2.0 인증 가이드: https://apidocs.cafe24.com/docs/guide/oauth2-authentication
 *       인증 코드: GET https://{mall_id}.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id&state&redirect_uri&scope (브라우저에서만, 코드는 1분 유효 · 1회용)
 *       토큰: POST https://{mall_id}.cafe24api.com/api/v2/oauth/token, Authorization: Basic base64(client_id:client_secret),
 *             form grant_type=authorization_code&code&redirect_uri  또는  grant_type=refresh_token&refresh_token
 *       응답 { access_token, expires_at, refresh_token, refresh_token_expires_at, client_id, mall_id, user_id, scopes[], issued_at, shop_no }
 *       Access Token 2시간 · Refresh Token 2주. 갱신하면 새 Refresh Token이 오고 이전 것은 폐기된다 → 받은 즉시 저장(ctx.saveCredentials)
 *       expires_at · issued_at은 오프셋 없는 일시라 두 값의 차이(유효 시간)만 쓰고, 만료 시각은 우리 서버 시각 기준으로 다시 계산한다.
 *   - Versioning: https://apidocs.cafe24.com/docs/guide/versioning   (X-Cafe24-Api-Version: yyyy-mm-dd, Admin · Analytics API 공통)
 *   - 주문 목록 조회: https://apidocs.cafe24.com/docs/admin/get-orders
 *       GET /admin/orders?shop_no&start_date&end_date(한 호출 3개월 미만)&date_type=pay_date&embed=items&limit(최대 1000)&offset(최대 15000)
 *       주문: paid(T/F/M) · canceled(T/F/M) · payment_date · actual_order_amount{ order_price_amount, payment_amount … }
 *       · order_place_id(주문경로: cafe24 · mobile · mobile_d · NCHECKOUT · inpark · auction · sk11st · gmarket · coupang · shopn) · order_place_name
 *       품주: item_no(품주 아이디) · original_item_no(기존 품주 아이디 — 교환으로 생긴 새 품주가 가리키는 원래 품주)
 *   - 주문 품주 목록 조회(embed=items 필드): https://apidocs.cafe24.com/docs/admin/get-orders-by-order-id-items
 *       product_price · option_price · quantity · payment_amount(품목별 결제금액) · status_code(N1 정상 · N2 교환상품 · C1 입금전취소 · C2 배송전취소 · C3 반품 · E1 교환)
 *   - 상품 목록 조회: https://apidocs.cafe24.com/docs/admin/get-products  (limit 최대 100, 5,000개 넘으면 since_product_no, embed=variants)
 *   - 상품 품목 목록 조회: https://apidocs.cafe24.com/docs/admin/get-products-by-product-no-variants  (variant_code · options[{name,value}] · additional_amount · quantity · use_inventory · selling)
 *   - 쇼핑몰 정보 조회: https://apidocs.cafe24.com/docs/admin/get-store  (scope mall.read_store)
 *   - 혜택 목록 · 상세: https://apidocs.cafe24.com/docs/admin/get-benefits · https://apidocs.cafe24.com/docs/admin/get-benefits-by-benefit-no  (period_sale.discount_value · discount_value_unit P/W)
 *   - Cafe24 Analytics API: https://developers.cafe24.com/docs/ko/api/cafe24data/
 *       https://ca-api.cafe24data.com — Bearer(Admin 토큰과 같은 토큰), scope mall.read_analytics, 토큰 버킷(초당 2개 보충)
 *       GET /visitors/view?mall_id&shop_no&start_date&end_date&format_type=day&limit(50~1000)&offset → 행 { date, visit_count, first_visit_count, re_visit_count }
 *       GET /products/view(상품별 상세 조회수 count) · GET /carts/action(상품별 장바구니 담긴수 add_cart_count)
 *       · GET /visitpaths/adsales(광고 매체별 order_count · order_amount — "네이버, 다음, 구글, 크리테오 등 광고 매체별 … 구매 관련 분석") — 기간 합계라 날짜별로 하루씩 부른다
 *       응답을 감싸는 키 이름은 문서 예시가 비어 있어 확인하지 못했다 → 문서에 적힌 행 속성(date · visit_count 등)을 가진 배열을 찾아 읽는다.
 *       (일본어 문서: 카페24 승인을 받은 협력사에만 제공되는 베타 API — 권한이 없으면 방문 지표는 0 + 경고)
 */
import { createHash } from 'node:crypto';
import type { ConnectorContext } from '../types';
import { SalesApiError, callSales, parseInstant, type ApiResponse, type ErrorInfo, type HttpRequest } from '../naver-commerce/sales-shared';

export const CAFE24_LABEL = '카페24 Admin API';
export const CAFE24_ANALYTICS_BASE = 'https://ca-api.cafe24data.com';
export const CAFE24_API_VERSION = '2026-09-01';
/** 이 커넥터가 쓰는 권한 범위 (앱 등록 · 인증 코드 요청 시) */
export const CAFE24_SCOPES = ['mall.read_order', 'mall.read_product', 'mall.read_store', 'mall.read_promotion', 'mall.read_analytics'] as const;
const PROVIDER = 'cafe24';

export interface Cafe24Credentials {
  mallId: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  /** 1회용 인증 코드 (발급 후 1분 유효) — 교환하면 지운다 */
  authCode?: string;
  refreshToken?: string;
  accessToken?: string;
  /** ISO (서버 시각 기준 재계산) */
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  scopes?: string[];
}

export const cafe24Base = (mallId: string) => `https://${mallId}.cafe24api.com/api/v2`;

/** 인증 코드 요청 URL (브라우저로 열어 쇼핑몰 운영자가 승인) */
export function cafe24AuthorizeUrl(o: { mallId: string; clientId: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: o.clientId, state: o.state, redirect_uri: o.redirectUri, scope: (o.scopes ?? CAFE24_SCOPES).join(' ') });
  return `${cafe24Base(o.mallId)}/oauth/authorize?${q.toString()}`;
}

/** Admin · Analytics 오류: { error: { code, message, more_info } } · OAuth: { error: 'invalid_grant', error_description } */
export function describeCafe24Error(status: number, data: unknown): ErrorInfo | null {
  if (!data || typeof data !== 'object') return typeof data === 'string' && data.trim() ? { detail: data.trim().slice(0, 300) } : null;
  const e = (data as { error?: unknown; error_description?: string }).error;
  if (typeof e === 'string') {
    const desc = (data as { error_description?: string }).error_description ?? e;
    if (e === 'invalid_grant') return { kind: 'auth', code: e, detail: `인증 코드 또는 갱신 토큰이 만료 · 사용됨 (${desc}) — 카페24 앱 승인을 다시 받아 인증 코드(1분 유효)나 갱신 토큰을 넣어 주세요` };
    if (e === 'invalid_client' || e === 'unauthorized_client') return { kind: 'auth', code: e, detail: `Client ID · Client Secret을 확인해 주세요 (${desc})` };
    if (e === 'invalid_token') return { kind: 'auth', code: e, detail: desc };
    if (e === 'insufficient_scope') return { kind: 'permission', code: e, detail: `앱 권한 범위가 부족합니다 (${desc})` };
    return { code: e, detail: desc };
  }
  if (e && typeof e === 'object') {
    const o = e as { code?: string | number; message?: string };
    const detail = [o.message, o.code !== undefined ? `code ${o.code}` : ''].filter(Boolean).join(' · ');
    if (status === 403) return { kind: 'permission', code: o.code !== undefined ? String(o.code) : undefined, detail: `${detail} — 앱 권한 범위(${CAFE24_SCOPES.join(', ')})와 쇼핑몰의 앱 승인 상태를 확인해 주세요` };
    return { code: o.code !== undefined ? String(o.code) : undefined, detail };
  }
  return null;
}

interface TokenResponse {
  access_token?: string;
  expires_at?: string;
  refresh_token?: string;
  refresh_token_expires_at?: string;
  issued_at?: string;
  scopes?: string[];
  mall_id?: string;
  shop_no?: string;
}

const ACCESS_TTL_MS = 2 * 3600_000;
const REFRESH_TTL_MS = 14 * 86_400_000;
/** 만료 5분 전이면 갱신 (문서 예시의 refresh_threshold) */
const MARGIN_MS = 5 * 60_000;

/** 유효 시간 = expires_at − issued_at (같은 기준 일시끼리의 차이), 해석 불가면 문서 기본값 */
function lifetime(expiresAt: string | undefined, issuedAt: string | undefined, fallback: number): number {
  const e = parseInstant(expiresAt);
  const i = parseInstant(issuedAt);
  const d = e !== null && i !== null ? e - i : NaN;
  return Number.isFinite(d) && d > 0 ? d : fallback;
}

/** 같은 커넥션의 동시 갱신을 한 번으로 묶는다 (갱신 토큰은 1회용 — 동시에 두 번 쓰면 하나는 invalid_grant) */
const inflight = new Map<string, Promise<Cafe24Credentials>>();

/**
 * 이 프로세스에서 이미 써 버린 갱신 토큰 · 인증 코드 → 그 교환으로 받은 자격증명.
 * 백필은 커넥션 행을 한 번 읽어 31일 묶음마다 같은 자격증명으로 수집하므로, 앞 묶음이 갱신 토큰을 회전(이전 것 폐기)시키면
 * 뒤 묶음은 폐기된 갱신 토큰을 다시 쓰게 된다(invalid_grant → 백필 실패). 1회용 값은 한 번 쓰면 다시 쓸 수 없으므로
 * 그 결과로 바꿔 끼우는 것이 언제나 맞다 — 새 값은 이미 ctx.saveCredentials로 저장돼 있다. 키는 원문이 아닌 해시.
 */
const consumed = new Map<string, { next: Cafe24Credentials; at: number }>();
const CONSUMED_TTL_MS = 15 * 86_400_000;
const CONSUMED_MAX = 2000;
const consumedKey = (connectionId: string, kind: 'refresh' | 'code', value: string) => createHash('sha256').update(`${connectionId}|${kind}|${value}`).digest('hex');
function rememberConsumed(key: string, next: Cafe24Credentials, now: number): void {
  consumed.set(key, { next, at: now });
  if (consumed.size > CONSUMED_MAX) {
    for (const [k, v] of consumed) if (now - v.at > CONSUMED_TTL_MS || consumed.size > CONSUMED_MAX) consumed.delete(k);
  }
}

export interface Cafe24Order {
  order_id?: string;
  /** 주문경로 (문서: cafe24 · mobile · mobile_d · NCHECKOUT · inpark · auction · sk11st · gmarket · coupang · shopn) */
  order_place_id?: string;
  order_place_name?: string;
  market_id?: string;
  paid?: string;
  canceled?: string;
  order_date?: string;
  payment_date?: string | null;
  payment_amount?: string | number;
  actual_order_amount?: { order_price_amount?: string | number; payment_amount?: string | number; coupon_discount_price?: string | number; membership_discount_amount?: string | number; set_product_discount_amount?: string | number; app_discount_amount?: string | number; market_other_discount_amount?: string | number };
  items?: Cafe24OrderItem[];
}
export interface Cafe24OrderItem {
  /** 품주 아이디 */
  item_no?: number | string;
  /** 기존 품주 아이디 (교환으로 새로 생긴 품주가 가리키는 원래 품주) */
  original_item_no?: number | string | (number | string)[] | null;
  order_item_code?: string;
  product_no?: number;
  product_name?: string;
  variant_code?: string;
  option_value?: string;
  product_price?: string | number;
  option_price?: string | number;
  quantity?: number;
  payment_amount?: string | number;
  order_status?: string;
  status_code?: string;
}
export interface Cafe24Variant {
  variant_code?: string;
  options?: { name?: string; value?: string }[] | null;
  display?: string;
  selling?: string;
  additional_amount?: string | number;
  use_inventory?: string;
  quantity?: number;
}
export interface Cafe24Product {
  product_no?: number;
  product_code?: string;
  product_name?: string;
  price?: string | number;
  display?: string;
  selling?: string;
  variants?: Cafe24Variant[] | null;
}
export interface Cafe24Benefit {
  benefit_no?: number;
  use_benefit?: string;
  benefit_name?: string;
  benefit_division?: string;
  benefit_type?: string;
  use_benefit_period?: string;
  benefit_start_date?: string | null;
  benefit_end_date?: string | null;
  period_sale?: { discount_value?: string; discount_value_unit?: string }[] | { discount_value?: string; discount_value_unit?: string } | null;
}

export class Cafe24Client {
  private creds: Cafe24Credentials;
  constructor(
    private ctx: Pick<ConnectorContext, 'http' | 'connectionId' | 'saveCredentials'>,
    creds: Cafe24Credentials,
    private o: { now?: () => number; apiVersion?: string; shopNo?: number; analyticsBase?: string } = {},
  ) {
    this.creds = { ...creds };
  }

  get base(): string { return cafe24Base(this.creds.mallId); }
  get mallId(): string { return this.creds.mallId; }
  get shopNo(): number { return this.o.shopNo ?? 1; }
  get scopes(): string[] { return this.creds.scopes ?? []; }
  /** 현재 자격증명 사본 (토큰 갱신 · 교환 후 값) */
  get credentials(): Cafe24Credentials { return { ...this.creds }; }
  private now(): number { return (this.o.now ?? Date.now)(); }
  private key(): string { return createHash('sha256').update(`${this.ctx.connectionId}|${this.creds.mallId}|${this.creds.clientId}`).digest('hex'); }

  /**
   * 토큰 엔드포인트 요청 (Basic 인증 · form). 재시도하지 않는다(retries 0): 인증 코드 · 갱신 토큰은 1회용이라
   * 서버가 이미 소비한 뒤(5xx · 시간 초과) 같은 값으로 다시 보내면 invalid_grant가 되고 새 토큰을 잃는다 — 실패는 수집 잡 재시도로 넘긴다.
   */
  tokenRequest(grant: { grant_type: 'authorization_code'; code: string; redirect_uri: string } | { grant_type: 'refresh_token'; refresh_token: string }): HttpRequest {
    return {
      method: 'POST',
      url: `${this.base}/oauth/token`,
      headers: { Authorization: `Basic ${Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`, 'utf-8').toString('base64')}` },
      bodyType: 'form',
      body: grant,
      retries: 0,
      timeoutMs: 30_000,
    };
  }

  /** 이 프로세스에서 이미 소비된 갱신 토큰 · 인증 코드를 들고 있으면 그 결과 자격증명으로 바꿔 끼운다 (연쇄 회전도 따라간다) */
  private adoptConsumed(): void {
    for (let i = 0; i < 20; i++) {
      const hit = (this.creds.authCode && consumed.get(consumedKey(this.ctx.connectionId, 'code', this.creds.authCode)))
        || (this.creds.refreshToken && consumed.get(consumedKey(this.ctx.connectionId, 'refresh', this.creds.refreshToken)))
        || null;
      if (!hit || hit.next.mallId !== this.creds.mallId || hit.next.clientId !== this.creds.clientId) return;
      this.creds = { ...hit.next };
    }
  }

  private async grant(req: HttpRequest, what: string): Promise<Cafe24Credentials> {
    const res = await callSales<TokenResponse>(this.ctx, req, { provider: PROVIDER, label: CAFE24_LABEL, what, describe: (s, d) => {
      const info = describeCafe24Error(s, d);
      return s === 400 || s === 401 ? { ...info, kind: 'auth' } : info;
    } });
    const t = res.data ?? {};
    if (!t.access_token) throw new SalesApiError(PROVIDER, 'auth', `${CAFE24_LABEL} ${what} 응답에 access_token이 없습니다`);
    const now = this.now();
    const next: Cafe24Credentials = {
      mallId: this.creds.mallId,
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
      ...(this.creds.redirectUri ? { redirectUri: this.creds.redirectUri } : {}),
      accessToken: t.access_token,
      accessTokenExpiresAt: new Date(now + lifetime(t.expires_at, t.issued_at, ACCESS_TTL_MS)).toISOString(),
      refreshToken: t.refresh_token ?? this.creds.refreshToken,
      refreshTokenExpiresAt: new Date(now + lifetime(t.refresh_token_expires_at, t.issued_at, REFRESH_TTL_MS)).toISOString(),
      ...(Array.isArray(t.scopes) ? { scopes: t.scopes.map(String) } : this.creds.scopes ? { scopes: this.creds.scopes } : {}),
    };
    const body = (req.body ?? {}) as { grant_type?: string; code?: string; refresh_token?: string };
    const used = body.grant_type === 'authorization_code' && body.code ? consumedKey(this.ctx.connectionId, 'code', body.code)
      : body.grant_type === 'refresh_token' && body.refresh_token ? consumedKey(this.ctx.connectionId, 'refresh', body.refresh_token) : null;
    if (used) rememberConsumed(used, next, now);
    this.creds = next;
    // 새 갱신 토큰은 받는 즉시 저장한다 (이전 갱신 토큰은 이미 폐기됨)
    if (this.ctx.saveCredentials) await this.ctx.saveCredentials(next as unknown as Record<string, unknown>);
    return next;
  }

  /**
   * 유효한 액세스 토큰 — 남은 시간이 5분 미만이면 갱신, 없으면 인증 코드 교환.
   * 새 인증 코드(교환하면 지워지므로 남아 있다 = 운영자가 다시 승인)가 있으면 액세스 토큰이 아직 유효해도 먼저 교환한다
   * — 권한 범위를 늘리려고 다시 승인한 경우 옛 토큰을 계속 쓰다 코드(1분 유효)를 흘려보내지 않도록.
   */
  async accessToken(force = false): Promise<string> {
    this.adoptConsumed();
    const exp = parseInstant(this.creds.accessTokenExpiresAt);
    const pendingCode = !!(this.creds.authCode && this.creds.redirectUri);
    if (!force && !pendingCode && this.creds.accessToken && exp !== null && exp - MARGIN_MS > this.now()) return this.creds.accessToken;
    const key = this.key();
    const running = inflight.get(key);
    if (running) return (this.creds = await running).accessToken!;
    const p = (async () => {
      // 새로 넣은 인증 코드가 있으면 먼저 쓴다 (교환하면 지워지므로, 남아 있다는 것은 운영자가 다시 승인했다는 뜻)
      let codeError: SalesApiError | null = null;
      if (this.creds.authCode && this.creds.redirectUri) {
        try {
          return await this.grant(this.tokenRequest({ grant_type: 'authorization_code', code: this.creds.authCode, redirect_uri: this.creds.redirectUri }), '인증 코드 교환');
        } catch (e) {
          if (!(e instanceof SalesApiError) || e.kind !== 'auth') throw e;
          if (!this.creds.refreshToken) {
            // 갱신 토큰 없이 아직 유효한 액세스 토큰만 있으면 그것으로 계속한다 (이 수집 동안은 지난 코드를 다시 시도하지 않는다)
            if (!force && this.creds.accessToken && exp !== null && exp - MARGIN_MS > this.now()) {
              this.creds = { ...this.creds, authCode: undefined };
              return { ...this.creds };
            }
            throw e;
          }
          codeError = e; // 1분이 지난 코드 등 — 갱신 토큰으로 이어서 시도
        }
      }
      if (this.creds.refreshToken) {
        try {
          return await this.grant(this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.creds.refreshToken }), '토큰 갱신');
        } catch (e) {
          // 저장된 만료 시각은 참고만 한다(새로 붙여 넣은 갱신 토큰일 수 있다) — 서버가 거절했고 그 시각이 지났으면 만료로 안내
          const rexp = parseInstant(this.creds.refreshTokenExpiresAt);
          if (e instanceof SalesApiError && e.kind === 'auth' && rexp !== null && rexp <= this.now()) {
            throw new SalesApiError(PROVIDER, 'auth', `${CAFE24_LABEL} 갱신 토큰이 만료되었습니다(발급 후 2주) — 카페24 앱 승인을 다시 받아 인증 코드나 새 갱신 토큰을 넣어 주세요`, e.status, e.code);
          }
          throw codeError ?? e;
        }
      }
      if (this.creds.authCode) throw new SalesApiError(PROVIDER, 'auth', `${CAFE24_LABEL} 인증 코드 교환에는 앱에 등록한 Redirect URI가 필요합니다`);
      throw new SalesApiError(PROVIDER, 'auth', `${CAFE24_LABEL} 인증이 필요합니다 — 갱신 토큰(refresh token) 또는 방금 받은 인증 코드를 넣어 주세요`);
    })();
    inflight.set(key, p);
    try {
      return (await p).accessToken!;
    } finally {
      inflight.delete(key);
    }
  }

  request(method: HttpRequest['method'], url: string, query?: HttpRequest['query'], token = '(발급 토큰)'): HttpRequest {
    return {
      method,
      url,
      query,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': this.o.apiVersion ?? CAFE24_API_VERSION },
    };
  }

  /** 401이면 토큰을 강제로 갱신해 한 번 더 부른다 */
  async call<T>(url: string, what: string, query?: HttpRequest['query']): Promise<ApiResponse<T>> {
    const opts = { provider: PROVIDER, label: CAFE24_LABEL, what, describe: describeCafe24Error };
    try {
      return await callSales<T>(this.ctx, this.request('GET', url, query, await this.accessToken()), opts);
    } catch (e) {
      if (!(e instanceof SalesApiError) || e.status !== 401 || !this.creds.refreshToken) throw e;
      return callSales<T>(this.ctx, this.request('GET', url, query, await this.accessToken(true)), opts);
    }
  }

  admin<T>(path: string, what: string, query?: HttpRequest['query']): Promise<ApiResponse<T>> {
    return this.call<T>(`${this.base}/admin${path}`, what, query);
  }
  analytics<T>(path: string, what: string, query?: HttpRequest['query']): Promise<ApiResponse<T>> {
    return this.call<T>(`${(this.o.analyticsBase ?? CAFE24_ANALYTICS_BASE).replace(/\/$/, '')}${path}`, what, { mall_id: this.creds.mallId, shop_no: this.shopNo, ...(query ?? {}) });
  }

  async store(): Promise<{ shop_name?: string; mall_id?: string; primary_domain?: string; base_domain?: string }> {
    return (await this.admin<{ store?: { shop_name?: string; mall_id?: string; primary_domain?: string; base_domain?: string } }>('/store', '쇼핑몰 정보 조회', { shop_no: this.shopNo })).data?.store ?? {};
  }

  async orders(from: string, to: string, offset: number, limit: number): Promise<Cafe24Order[]> {
    const res = await this.admin<{ orders?: Cafe24Order[] }>('/orders', '주문 조회', {
      shop_no: this.shopNo, start_date: from, end_date: to, date_type: 'pay_date', embed: 'items', limit, offset,
    });
    return Array.isArray(res.data?.orders) ? res.data!.orders! : [];
  }

  async products(sinceProductNo: number | undefined, limit = 100): Promise<Cafe24Product[]> {
    const res = await this.admin<{ products?: Cafe24Product[] }>('/products', '상품 조회', {
      shop_no: this.shopNo, embed: 'variants', limit, ...(sinceProductNo !== undefined ? { since_product_no: sinceProductNo } : {}),
    });
    return Array.isArray(res.data?.products) ? res.data!.products! : [];
  }

  async benefits(offset: number, limit = 100): Promise<Cafe24Benefit[]> {
    const res = await this.admin<{ benefits?: Cafe24Benefit[] }>('/benefits', '혜택 조회', { shop_no: this.shopNo, use_benefit: 'T', offset, limit });
    return Array.isArray(res.data?.benefits) ? res.data!.benefits! : [];
  }

  async benefit(no: number | string): Promise<Cafe24Benefit> {
    return (await this.admin<{ benefit?: Cafe24Benefit }>(`/benefits/${encodeURIComponent(String(no))}`, '혜택 상세 조회', { shop_no: this.shopNo })).data?.benefit ?? {};
  }

  /** Analytics 목록 응답에서 문서의 행 속성(required)을 가진 배열을 찾는다 (감싸는 키 이름은 문서 예시에 없음) */
  async analyticsRows(path: string, what: string, query: Record<string, string | number>, required: string[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const limit = 1000;
    for (let offset = 0, page = 0; page < 50; page++, offset += limit) {
      const data = (await this.analytics<unknown>(path, what, { ...query, limit, offset })).data;
      const rows = findRows(data, required);
      out.push(...rows);
      if (rows.length < limit) break;
    }
    return out;
  }
}

/** 객체 · 배열에서 required 속성을 모두 가진 행 배열을 찾는다 (1단계 중첩까지) */
export function findRows(data: unknown, required: string[]): Record<string, unknown>[] {
  const ok = (a: unknown): a is Record<string, unknown>[] => Array.isArray(a) && (a.length === 0 || (a[0] !== null && typeof a[0] === 'object' && required.every((k) => k in (a[0] as object))));
  if (ok(data)) return data;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (ok(v) && (v as unknown[]).length) return v;
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const w of Object.values(v as Record<string, unknown>)) if (ok(w) && (w as unknown[]).length) return w;
    }
  }
  return [];
}

/** 테스트: 동시 갱신 묶음 · 소비된 1회용 값 기록을 비운다 (테스트끼리 같은 커넥션 id · 갱신 토큰을 쓰므로) */
export function _resetCafe24InflightForTest(): void {
  inflight.clear();
  consumed.clear();
}

/**
 * OAuth 콜백 라우트용: 방금 받은 인증 코드(1분 유효 · 1회용)를 바로 토큰으로 바꾸고 ctx.saveCredentials로 저장한다.
 * 돌려주는 값은 저장된 자격증명(인증 코드 제외) — 호출한 쪽은 비밀값을 응답 · 로그 · 감사에 넣지 않는다.
 */
export async function exchangeCafe24AuthCode(
  ctx: Pick<ConnectorContext, 'http' | 'connectionId' | 'saveCredentials'>,
  creds: Pick<Cafe24Credentials, 'mallId' | 'clientId' | 'clientSecret'> & Partial<Cafe24Credentials>,
  code: string,
  redirectUri: string,
  o: { now?: () => number; apiVersion?: string } = {},
): Promise<Cafe24Credentials> {
  const client = new Cafe24Client(ctx, { ...creds, authCode: code, redirectUri, accessToken: undefined, accessTokenExpiresAt: undefined }, o);
  await client.accessToken(true);
  return client.credentials;
}
