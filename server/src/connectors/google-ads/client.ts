/**
 * Google Ads API (REST) 클라이언트 — OAuth 갱신 토큰 · GAQL searchStream · mutate.
 *
 * 공식 문서 (2026-11-02 확인):
 *   - 버전 · 종료일: https://developers.google.com/google-ads/api/docs/sunset-dates  → 최신 v26 (2026-10-14 출시, 2027-11 종료 예정)
 *   - REST 인증: https://developers.google.com/google-ads/api/rest/auth
 *       토큰: POST https://www.googleapis.com/oauth2/v3/token (grant_type=refresh_token, client_id, client_secret, refresh_token)
 *       헤더: Authorization: Bearer · login-customer-id(관리자 계정 경유 시, 하이픈 없이)
 *   - 개발자 토큰: https://developers.google.com/google-ads/api/docs/api-policy/developer-token
 *       2026-09-09 개발자 토큰 폐지 — 헤더는 선택이며 서버가 무시한다. 접근 등급은 Cloud 프로젝트 기준.
 *       Test 등급 프로젝트로 운영 계정 호출 시 v25+는 CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION.
 *       → developer-token 헤더는 자격증명에 값이 있을 때만 보낸다(이전 버전 고정용).
 *   - 검색: https://developers.google.com/google-ads/api/rest/common/search  (POST v26/customers/{id}/googleAds:searchStream { query })
 *   - REST 스키마(디스커버리 문서): https://googleads.googleapis.com/$discovery/rest?version=v26
 *       SearchGoogleAdsStreamResponse { results[], fieldMask, requestId, queryResourceConsumption } — 응답은 이 배치들의 JSON 배열
 *       MutateCampaignBudgetsRequest { operations[{ updateMask, update }], partialFailure, validateOnly, responseContentType }
 *       int64(metrics.impressions · cost_micros · amount_micros · cpc_bid_micros)는 JSON 문자열
 *   - 필드 호환: https://developers.google.com/google-ads/api/fields/v26/customer · keyword_view · search_term_view
 *       segments.hour는 customer와 함께 선택 가능, keyword_view에는 없음
 */
import { createHash } from 'node:crypto';
import type { ConnectorContext } from '../types';
import { MediaApiError, callApi, errorMessage, type ErrorInfo, type HttpRequest } from '../naver-sa/media-shared';

export const GOOGLE_ADS_BASE = 'https://googleads.googleapis.com';
export const GOOGLE_TOKEN_URL = 'https://www.googleapis.com/oauth2/v3/token';
export const GOOGLE_ADS_VERSION = 'v26';
export const GOOGLE_LABEL = 'Google Ads';
const PROVIDER = 'google_ads';

export type GoogleAdsCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
  developerToken?: string;
};

/** Google API 오류: { error: { code, message, status, details:[{ '@type': …GoogleAdsFailure, errors:[{ errorCode:{…}, message }] }] } } (searchStream은 배열로 감쌀 수 있음) */
export function describeGoogleError(status: number, data: unknown): ErrorInfo | null {
  const raw = Array.isArray(data) ? (data.find((x) => x && typeof x === 'object' && 'error' in x) as { error?: unknown } | undefined) : (data as { error?: unknown } | null);
  const err = raw && typeof raw === 'object' ? (raw as { error?: { code?: number; message?: string; status?: string; details?: unknown[] } }).error : undefined;
  if (!err || typeof err !== 'object') {
    // OAuth 토큰 엔드포인트: { error: 'invalid_grant', error_description }
    const o = data as { error?: string; error_description?: string } | null;
    if (o && typeof o.error === 'string') {
      if (o.error === 'invalid_grant') return { kind: 'auth', code: 'invalid_grant', detail: `갱신 토큰이 만료 · 취소되었습니다 (${o.error_description ?? o.error}) — OAuth 동의를 다시 받아 갱신 토큰을 교체해 주세요` };
      if (o.error === 'invalid_client' || o.error === 'unauthorized_client') return { kind: 'auth', code: o.error, detail: `OAuth 클라이언트 ID · 비밀번호를 확인해 주세요 (${o.error_description ?? o.error})` };
      return { code: o.error, detail: o.error_description ?? o.error };
    }
    return null;
  }
  const failures = (err.details ?? []).flatMap((d) => ((d as { errors?: { errorCode?: Record<string, string>; message?: string }[] })?.errors ?? []));
  const codes = failures.map((f) => Object.entries(f.errorCode ?? {}).map(([k, v]) => `${k}=${v}`).join(',')).filter(Boolean);
  const msg = failures[0]?.message ?? err.message ?? '';
  const detail = [msg, codes.length ? `[${codes.join('; ')}]` : ''].filter(Boolean).join(' ');
  const all = codes.join(' ');
  if (/CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION/.test(all)) {
    return { kind: 'permission', code: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', detail: `Cloud 프로젝트가 Test 등급이라 운영 계정을 호출할 수 없습니다 — Cloud Console의 Google Ads API 개요 화면에서 Explorer 등급 이상을 신청해 주세요 (${detail})` };
  }
  if (err.status === 'UNAUTHENTICATED' || status === 401) return { kind: 'auth', code: err.status, detail };
  if (err.status === 'PERMISSION_DENIED') return { kind: 'permission', code: err.status, detail: `${detail} — 관리자 계정 경유라면 login-customer-id(관리자 고객 ID)를 확인해 주세요` };
  if (err.status === 'RESOURCE_EXHAUSTED' || /quotaError|RESOURCE_TEMPORARILY_EXHAUSTED/.test(all)) return { kind: 'rate', code: err.status, detail };
  if (err.status === 'NOT_FOUND') return { kind: 'not_found', code: err.status, detail };
  if (err.status === 'INVALID_ARGUMENT') return { kind: 'invalid', code: codes[0] ?? err.status, detail };
  return { code: err.status, detail };
}

/* ---------------- 액세스 토큰 (프로세스 메모리 캐시) ---------------- */

const tokenCache = new Map<string, { token: string; exp: number }>();
export function _resetGoogleTokenCacheForTest(): void {
  tokenCache.clear();
}

export async function googleAccessToken(ctx: Pick<ConnectorContext, 'http'>, c: GoogleAdsCredentials, now: () => number): Promise<string> {
  const key = createHash('sha256').update(`${c.clientId}|${c.refreshToken}`).digest('hex');
  const hit = tokenCache.get(key);
  if (hit && hit.exp - 60_000 > now()) return hit.token;
  const res = await callApi<{ access_token?: string; expires_in?: number }>(
    ctx,
    { method: 'POST', url: GOOGLE_TOKEN_URL, bodyType: 'form', body: { grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken } },
    { provider: PROVIDER, label: GOOGLE_LABEL, what: 'OAuth 액세스 토큰 갱신', describe: describeGoogleError },
  );
  const token = res.data?.access_token;
  if (!token) throw new MediaApiError(PROVIDER, 'auth', errorMessage('auth', GOOGLE_LABEL, 'OAuth 액세스 토큰 갱신', res.status, '응답에 access_token이 없습니다'), res.status);
  tokenCache.set(key, { token, exp: now() + Math.max(60, Number(res.data.expires_in ?? 3600)) * 1000 });
  return token;
}

export const cleanCustomerId = (v: string) => String(v ?? '').replace(/[-\s]/g, '');

/** GAQL 행 (REST JSON은 lowerCamelCase) */
export interface GadsRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; testAccount?: boolean };
  campaign?: { id?: string; name?: string; status?: string; servingStatus?: string; primaryStatus?: string; advertisingChannelType?: string; biddingStrategyType?: string; resourceName?: string };
  campaignBudget?: { id?: string; resourceName?: string; amountMicros?: string; explicitlyShared?: boolean; referenceCount?: string; period?: string };
  adGroup?: { id?: string; name?: string; status?: string };
  adGroupCriterion?: { criterionId?: string; status?: string; cpcBidMicros?: string; effectiveCpcBidMicros?: string; finalUrls?: string[]; keyword?: { text?: string; matchType?: string }; resourceName?: string };
  searchTermView?: { searchTerm?: string; status?: string };
  segments?: { date?: string; hour?: number };
  metrics?: { impressions?: string; clicks?: string; costMicros?: string; conversions?: number; conversionsValue?: number; searchRankLostImpressionShare?: number; searchImpressionShare?: number };
}

export class GoogleAdsClient {
  readonly customerId: string;
  constructor(
    private ctx: Pick<ConnectorContext, 'http'>,
    private creds: GoogleAdsCredentials,
    private o: { version?: string; now?: () => number } = {},
  ) {
    this.customerId = cleanCustomerId(creds.customerId);
  }

  get version(): string { return this.o.version ?? GOOGLE_ADS_VERSION; }
  url(path: string): string { return `${GOOGLE_ADS_BASE}/${this.version}/customers/${this.customerId}${path}`; }

  headers(token: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (this.creds.loginCustomerId) h['login-customer-id'] = cleanCustomerId(this.creds.loginCustomerId);
    if (this.creds.developerToken) h['developer-token'] = this.creds.developerToken;
    return h;
  }

  /** dry_run 요약용 요청 (토큰 자리만 표시 — 요약에는 헤더 이름만 남는다) */
  searchRequest(query: string, token = '(발급 토큰)'): HttpRequest {
    return { method: 'POST', url: this.url('/googleAds:searchStream'), headers: this.headers(token), body: { query }, bodyType: 'json' };
  }
  mutateRequest(service: 'campaignBudgets' | 'adGroupCriteria' | 'campaigns', operations: unknown[], token = '(발급 토큰)'): HttpRequest {
    return {
      method: 'POST',
      url: this.url(`/${service}:mutate`),
      headers: this.headers(token),
      body: { operations, partialFailure: false, validateOnly: false, responseContentType: 'MUTABLE_RESOURCE' },
      bodyType: 'json',
    };
  }

  private token(): Promise<string> {
    return googleAccessToken(this.ctx, this.creds, this.o.now ?? Date.now);
  }

  /** GAQL searchStream → 모든 배치의 results 이어 붙이기 */
  async search(query: string, what: string): Promise<GadsRow[]> {
    const res = await callApi<unknown>(this.ctx, this.searchRequest(query, await this.token()), { provider: PROVIDER, label: GOOGLE_LABEL, what, describe: describeGoogleError });
    const batches = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    const out: GadsRow[] = [];
    for (const b of batches) {
      if (b && typeof b === 'object' && 'error' in (b as object)) {
        const info = describeGoogleError(500, [b]) ?? {};
        throw new MediaApiError(PROVIDER, info.kind ?? 'server', errorMessage(info.kind ?? 'server', GOOGLE_LABEL, what, res.status, info.detail), res.status, info.code, b);
      }
      out.push(...(((b as { results?: GadsRow[] })?.results) ?? []));
    }
    return out;
  }

  async mutate<T = unknown>(service: 'campaignBudgets' | 'adGroupCriteria' | 'campaigns', operations: unknown[], what: string): Promise<{ results?: T[] }> {
    const res = await callApi<{ results?: T[] }>(this.ctx, this.mutateRequest(service, operations, await this.token()), { provider: PROVIDER, label: GOOGLE_LABEL, what, describe: describeGoogleError });
    return res.data ?? {};
  }
}

/** GAQL 문자열 리터럴 (작은따옴표 · 역슬래시 이스케이프) */
export const gaqlString = (s: string) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
