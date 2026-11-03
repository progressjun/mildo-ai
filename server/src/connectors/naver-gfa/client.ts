/**
 * 네이버 성과형 디스플레이 광고(GFA) API 클라이언트 — 네이버 로그인 OAuth(갱신 토큰) · 성과 API · 광고 API · 계정 API.
 *
 * 공식 문서 (2026-11-02 확인):
 *   - 시작하기: https://naver-ad-api.github.io/developers/docs/intro
 *       "네이버 성과형 디스플레이 API는 베타 테스트 중으로, 공식 파트너사인 경우에 한해 API 사용 신청 및 권한 부여가 가능"
 *   - 애플리케이션 · 사용 신청: https://naver-ad-api.github.io/developers/docs/prepare/developers-my-application
 *       네이버 개발자 센터 애플리케이션(네이버 로그인) Client ID를 GFA 대표 관리 계정 > 설정 > API 관리 > "API 사용 신청"에 등록
 *   - 요청: https://naver-ad-api.github.io/developers/docs/basic-concept/basic-request
 *       기반 URL https://openapi.naver.com/v1/ad-api/{version}(기본 1.0), 관리 계정 경유 시 헤더 AccessManagerAccountNo
 *   - 응답 · 오류: https://naver-ad-api.github.io/developers/docs/basic-concept/basic-response
 *       { error: { code, detailCode, message, description } }, 400 · 401 AUTH_ERROR · 403 · 422 · 429 · 500
 *   - FAQ: https://naver-ad-api.github.io/developers/docs/faq  인증 실패 { errorMessage, errorCode:"024" } (토큰 만료 · 권한 부여 전 동의)
 *   - OpenAPI 명세(YAML): https://naver-ad-api.github.io/developers/redocusaurus/plugin-redoc-0.yaml(계정) · -1(광고) · -2(성과)
 *       과거 성과: GET /adAccounts/{no}/performance/past/{campaigns|adSets|creatives|assetGroups}?startDate&endDate&timeUnit(daily|hourly)&limit(1000)&next
 *         조회 기간 최대 31일, 2년 전 ~ 전일(전일은 금일 02시부터), next 토큰 10분 유효
 *       실시간 성과: GET /adAccounts/{no}/performance/realtime/creatives?targetDate(today|yesterday)&timeUnit(daily|hourly)&since
 *       전환 성과: /performance/conversion/past/{aggregationType} · /performance/conversion/realtime/creatives (일별만, convType별)
 *       캠페인 목록 GET /adAccounts/{no}/campaigns(page · size ≤100), ON/OFF POST /adAccounts/{no}/campaigns/activate?campaignNos&activated
 *       캠페인 조회 GET /campaigns/{campaignNo} (OpenCampaignView: objective · subType · cboActivated · budget('CBO 예산') · performanceMax.budget('일 예산'))
 *       캠페인 지출 한도 다중 변경 POST /campaigns/editSpendLimit?campaignNos&campaignSpendLimit — ADVoost 쇼핑(objective PMAX)은 이 값이
 *         performanceMax.budget(일 예산)으로 반영, 캠페인당 2시간에 1회 (명세 설명 · 2026-08-26 업데이트 공지)
 *       광고 그룹 목록 GET /adAccounts/{no}/adSets(campaignNo · page · size), ON/OFF POST /adAccounts/{no}/adSets/activate?adSetNos&activated, 조회 GET /adSets/{adSetNo}
 *       광고 그룹 예산/입찰가/비용관리 다중 변경 POST /adSets/edit — 본문 oneOf(AdSetEditBudgetParam 등), discriminator propertyName=editType
 *   - 업데이트 공지: https://naver-ad-api.github.io/developers/blog/2026-08-26-update (ADVoost 쇼핑 예산 = performanceMax.budget, 변경은 지출 한도 API)
 *   - 네이버 로그인 토큰 갱신: https://developers.naver.com/docs/login/devguide/devguide.md
 *       GET/POST https://nid.naver.com/oauth2.0/token?grant_type=refresh_token&client_id&client_secret&refresh_token, 접근 토큰 기본 3600초
 */
import { createHash } from 'node:crypto';
import type { ConnectorContext } from '../types';
import { MediaApiError, callApi, errorMessage, type ErrorInfo, type HttpRequest } from '../naver-sa/media-shared';

export const GFA_BASE = 'https://openapi.naver.com/v1/ad-api';
export const NAVER_TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';
export const GFA_LABEL = '네이버 성과형 디스플레이(GFA)';
const PROVIDER = 'naver_gfa';

export type GfaCredentials = { clientId: string; clientSecret: string; refreshToken: string; adAccountNo: string; managerAccountNo?: string };

export function describeGfaError(status: number, data: unknown): ErrorInfo | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as { error?: unknown; error_description?: string; errorCode?: string; errorMessage?: string };
  // 네이버 로그인 토큰 응답 오류 (HTTP 200에 담겨 올 수 있음)
  if (typeof o.error === 'string') {
    return { kind: 'auth', code: o.error, detail: `${o.error_description ?? o.error} — 네이버 로그인 갱신 토큰 · Client ID · Client Secret을 확인해 주세요` };
  }
  if (o.errorCode) {
    const gw = /GatewayException/.test(o.errorMessage ?? '');
    return {
      kind: o.errorCode === '024' ? 'auth' : status === 429 ? 'rate' : undefined,
      code: o.errorCode,
      detail: `${o.errorMessage ?? ''}${gw ? ' — API 사용 권한 부여 전에 서비스 동의를 한 토큰일 수 있습니다. 네이버 \'연결된 서비스 관리\'에서 동의를 철회한 뒤 다시 로그인해 토큰을 발급해 주세요 (공식 FAQ)' : ''}`,
    };
  }
  const e = o.error as { code?: string; detailCode?: string; message?: string; description?: string } | undefined;
  if (e && typeof e === 'object') {
    const detail = [e.message, e.description, e.detailCode].filter(Boolean).join(' · ');
    if (e.code === 'AUTH_ERROR') return { kind: 'auth', code: e.code, detail };
    if (e.code === 'LIMIT_EXCEEDED' || status === 429) return { kind: 'rate', code: e.code, detail };
    return { code: e.detailCode ?? e.code, detail };
  }
  return null;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
export function _resetGfaTokenCacheForTest(): void {
  tokenCache.clear();
}

export async function gfaAccessToken(ctx: Pick<ConnectorContext, 'http'>, c: GfaCredentials, now: () => number): Promise<string> {
  const key = createHash('sha256').update(`${c.clientId}|${c.refreshToken}`).digest('hex');
  const hit = tokenCache.get(key);
  if (hit && hit.exp - 60_000 > now()) return hit.token;
  const res = await callApi<{ access_token?: string; expires_in?: string | number }>(
    ctx,
    { method: 'POST', url: NAVER_TOKEN_URL, query: { grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken } },
    { provider: PROVIDER, label: GFA_LABEL, what: '네이버 로그인 접근 토큰 갱신', describe: describeGfaError },
  );
  const token = res.data?.access_token;
  if (!token) throw new MediaApiError(PROVIDER, 'auth', errorMessage('auth', GFA_LABEL, '접근 토큰 갱신', res.status, '응답에 access_token이 없습니다'), res.status);
  tokenCache.set(key, { token, exp: now() + Math.max(60, Number(res.data.expires_in ?? 3600)) * 1000 });
  return token;
}

export interface GfaPerfRow {
  campaignNo?: number; adSetNo?: number; creativeNo?: number; assetGroupNo?: number; targetDate?: string; hour?: string;
  impCount?: number; clickCount?: number; vplayCount?: number; sales?: number; convCount?: number; convSales?: number; convType?: string; updatedAt?: string;
}
/** OpenCampaignView (광고 API 명세) 중 이 커넥터가 쓰는 필드 */
export interface GfaCampaign {
  no: number; name?: string; activated?: boolean; deleted?: boolean; status?: string; budgetExhausted?: boolean; spendLimit?: number;
  /** CBO 활성화 여부 · CBO 예산(명세: '예산 최적화 캠페인의 총 예산') · CBO 입찰 전략 · 비용 관리 */
  cboActivated?: boolean; budget?: number; bidGoal?: string; bidStrategy?: string; bidStrategyValue?: number;
  objective?: string; subType?: string;
  /** ADVoost 쇼핑(objective PMAX) 설정 — budget = 일 예산 */
  performanceMax?: { budget?: number } | null;
}
/** OpenAdSetListView · OpenAdSetView 중 이 커넥터가 쓰는 필드 */
export interface GfaAdSet {
  no: number; name?: string; campaignNo?: number; campaignName?: string; activated?: boolean; deleted?: boolean; status?: string;
  budgetType?: 'DAILY' | 'TOTAL'; budgetAmount?: number; bidPrice?: number; bidType?: string;
}
/** SuccessResponse (광고 API 명세) */
export interface GfaSuccess { success?: boolean; message?: string; description?: string }
export interface GfaAccount { no?: number; name?: string; disabled?: boolean; role?: string }

export class GfaClient {
  constructor(private ctx: Pick<ConnectorContext, 'http'>, private creds: GfaCredentials, private o: { version?: string; now?: () => number } = {}) {}

  get accountNo(): string { return String(this.creds.adAccountNo); }
  url(path: string): string { return `${GFA_BASE}/${this.o.version ?? '1.0'}/adAccounts/${this.accountNo}${path}`; }

  /** 요청 (token 기본값은 dry_run 요약용 자리 표시 — 요약에는 헤더 이름만 남는다). body가 있으면 JSON */
  request(method: HttpRequest['method'], path: string, query?: HttpRequest['query'], token = '(발급 토큰)', body?: unknown): HttpRequest {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (this.creds.managerAccountNo) headers.AccessManagerAccountNo = String(this.creds.managerAccountNo);
    return { method, url: this.url(path), query, headers, ...(body !== undefined ? { body, bodyType: 'json' as const } : {}) };
  }

  async call<T>(method: HttpRequest['method'], path: string, what: string, query?: HttpRequest['query'], body?: unknown): Promise<T> {
    const token = await gfaAccessToken(this.ctx, this.creds, this.o.now ?? Date.now);
    return (await callApi<T>(this.ctx, this.request(method, path, query, token, body), { provider: PROVIDER, label: GFA_LABEL, what, describe: describeGfaError })).data;
  }

  /** next 토큰 페이지 (과거 성과 · 과거 전환 성과) */
  async pastRows(path: string, query: Record<string, string | number>, what: string, maxPages = 100): Promise<GfaPerfRow[]> {
    const out: GfaPerfRow[] = [];
    let next: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const d = await this.call<{ rows?: GfaPerfRow[]; next?: string }>('GET', path, what, { ...query, limit: 1000, ...(next ? { next } : {}) });
      out.push(...(d?.rows ?? []));
      if (!d?.next || d.next === next) break;
      next = d.next;
    }
    return out;
  }

  async realtime(path: string, query: Record<string, string>, what: string): Promise<GfaPerfRow[]> {
    return (await this.call<{ rows?: GfaPerfRow[] }>('GET', path, what, query))?.rows ?? [];
  }

  /** page · size 페이지 (Spring Page: content · last) */
  async pages<T>(path: string, what: string, query: Record<string, string | number | boolean> = {}, maxPages = 100): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < maxPages; page++) {
      const d = await this.call<{ content?: T[]; last?: boolean; totalPages?: number }>('GET', path, what, { ...query, page, size: 100 });
      out.push(...(d?.content ?? []));
      if (d?.last !== false || (d.totalPages !== undefined && page + 1 >= d.totalPages)) break;
    }
    return out;
  }

  account(): Promise<GfaAccount> {
    return this.call<GfaAccount>('GET', '', '광고 계정 조회');
  }
}
