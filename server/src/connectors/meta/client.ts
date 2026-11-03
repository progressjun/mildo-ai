/**
 * Meta Marketing API (Graph API) 클라이언트 — insights · 캠페인 · 광고 세트 · 광고 계정 · 수정(POST /{id}).
 *
 * 공식 문서 (2026-11-02 확인):
 *   - 버전: https://developers.facebook.com/docs/graph-api/changelog  → Graph · Marketing API 최신 v26.0 (2026-07-29)
 *   - Insights: https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/
 *       GET /act_{id}/insights — time_range{since,until} · time_increment(1~90 | monthly | all_days) · level(ad|adset|campaign|account)
 *       breakdowns: hourly_stats_aggregated_by_advertiser_time_zone (시간대) · fields: impressions, clicks, spend, actions, action_values
 *       오류: 100 잘못된 파라미터 · 190 토큰 무효 · 200 권한 · 613 호출 한도 · 3018 37개월 초과
 *   - 광고 세트: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/
 *       daily_budget "defined in your account currency", status ACTIVE|PAUSED|…, 수정은 POST /{ad_set_id}
 *   - 통화 오프셋: https://developers.facebook.com/docs/marketing-api/currencies  → KRW 오프셋 1 (원 = 최소 단위)
 *   - 광고 계정: https://developers.facebook.com/docs/marketing-api/reference/ad-account/
 *       account_status 1 ACTIVE · 2 DISABLED · 3 UNSETTLED · 7 PENDING_RISK_REVIEW · 8 PENDING_SETTLEMENT · 9 IN_GRACE_PERIOD · 100/101 CLOSURE · CLOSED
 *       spend_cap · amount_spent (숫자 문자열 — 통화 오프셋 단위로 보고 오프셋으로 나눈다. KRW는 오프셋 1이라 원 그대로), is_prepay_account
 *   - appsecret_proof: https://developers.facebook.com/docs/graph-api/securing-requests  (HMAC-SHA256(app_secret, access_token) hex)
 * 토큰은 GET은 access_token 쿼리, POST는 본문(form)으로 보낸다. 요청 요약 · 로그에는 남기지 않는다.
 */
import { createHmac } from 'node:crypto';
import type { ConnectorContext } from '../types';
import { callApi, type ErrorInfo, type HttpRequest } from '../naver-sa/media-shared';

export const GRAPH_BASE = 'https://graph.facebook.com';
export const META_VERSION = 'v26.0';
export const META_LABEL = 'Meta 광고';
const PROVIDER = 'meta';

export type MetaCredentials = { accessToken: string; adAccountId: string; appSecret?: string };

export const actId = (v: string) => `act_${String(v).trim().replace(/^act_/, '')}`;

export function appSecretProof(appSecret: string, accessToken: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Graph 오류: { error: { message, type, code, error_subcode, error_user_msg, fbtrace_id } } — 토큰 만료도 400으로 온다 */
export function describeMetaError(status: number, data: unknown): ErrorInfo | null {
  const e = (data as { error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string; error_user_title?: string } } | null)?.error;
  if (!e || typeof e !== 'object') return null;
  const code = Number(e.code);
  const detail = `${e.error_user_msg ?? e.message ?? ''} (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})`;
  if (code === 190 || code === 102 || (e.type === 'OAuthException' && status === 401)) return { kind: 'auth', code: String(code), detail: `${detail} — 시스템 사용자 액세스 토큰을 다시 발급해 주세요` };
  if (code === 10 || (code >= 200 && code <= 299)) return { kind: 'permission', code: String(code), detail: `${detail} — 토큰에 ads_read · ads_management 권한과 광고 계정 접근 권한이 있어야 합니다` };
  if ([4, 17, 32, 341, 613].includes(code) || (code >= 80000 && code <= 80014)) return { kind: 'rate', code: String(code), detail };
  if (code === 3018) return { kind: 'invalid', code: '3018', detail: `${detail} — Insights는 최근 37개월까지만 조회됩니다` };
  if (code === 100) return { kind: 'invalid', code: '100', detail };
  if (code === 1 || code === 2) return { kind: 'server', code: String(code), detail };
  return { code: String(code), detail };
}

export interface MetaAction { action_type: string; value: string }
export interface MetaInsightRow {
  date_start?: string; date_stop?: string; impressions?: string; clicks?: string; spend?: string;
  actions?: MetaAction[]; action_values?: MetaAction[]; campaign_id?: string; adset_id?: string;
  hourly_stats_aggregated_by_advertiser_time_zone?: string; account_currency?: string;
}
export interface MetaCampaign { id: string; name?: string; status?: string; effective_status?: string; daily_budget?: string; lifetime_budget?: string }
export interface MetaAdSet extends MetaCampaign { campaign_id?: string }
export interface MetaAccount {
  id?: string; name?: string; account_status?: number; currency?: string; timezone_name?: string; amount_spent?: string; spend_cap?: string;
  balance?: string; is_prepay_account?: boolean; disable_reason?: number;
}

interface Page<T> { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }

export class MetaClient {
  readonly account: string;
  constructor(private ctx: Pick<ConnectorContext, 'http'>, private creds: MetaCredentials, private o: { version?: string } = {}) {
    this.account = actId(creds.adAccountId);
  }
  get version(): string { return this.o.version ?? META_VERSION; }
  url(path: string): string { return `${GRAPH_BASE}/${this.version}/${path.replace(/^\//, '')}`; }

  private auth(): Record<string, string> {
    const a: Record<string, string> = { access_token: this.creds.accessToken };
    if (this.creds.appSecret) a.appsecret_proof = appSecretProof(this.creds.appSecret, this.creds.accessToken);
    return a;
  }

  /** 토큰 없는 요청 (dry_run 요약용) */
  getRequest(path: string, query: Record<string, string | number | boolean | undefined> = {}): HttpRequest {
    return { method: 'GET', url: this.url(path), query };
  }
  postRequest(objectId: string, params: Record<string, string | number>): HttpRequest {
    return { method: 'POST', url: this.url(objectId), body: params, bodyType: 'form' };
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined>, what: string): Promise<T> {
    const req = this.getRequest(path, { ...query, ...this.auth() });
    return (await callApi<T>(this.ctx, req, { provider: PROVIDER, label: META_LABEL, what, describe: describeMetaError })).data;
  }
  async post<T>(objectId: string, params: Record<string, string | number>, what: string): Promise<T> {
    const req = this.postRequest(objectId, { ...params, ...this.auth() });
    return (await callApi<T>(this.ctx, req, { provider: PROVIDER, label: META_LABEL, what, describe: describeMetaError })).data;
  }

  /** 커서 페이지 (paging.cursors.after — next URL은 따라가지 않는다: 토큰이 들어 있어 같은 파라미터로 after만 바꿔 부른다) */
  async paged<T>(path: string, query: Record<string, string | number | boolean | undefined>, what: string, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const page = await this.get<Page<T>>(path, { ...query, ...(after ? { after } : {}) }, what);
      out.push(...(page?.data ?? []));
      const next = page?.paging?.cursors?.after;
      if (!page?.paging?.next || !next || next === after) break;
      after = next;
    }
    return out;
  }

  insights(query: Record<string, string | number | boolean | undefined>, what: string): Promise<MetaInsightRow[]> {
    return this.paged<MetaInsightRow>(`${this.account}/insights`, { limit: 500, use_account_attribution_setting: true, ...query }, what);
  }
  accountInfo(): Promise<MetaAccount> {
    return this.get<MetaAccount>(this.account, { fields: 'name,account_status,currency,timezone_name,amount_spent,spend_cap,balance,is_prepay_account,disable_reason' }, '광고 계정 조회');
  }
  campaigns(): Promise<MetaCampaign[]> {
    return this.paged<MetaCampaign>(`${this.account}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget', limit: 200 }, '캠페인 조회');
  }
  adsets(): Promise<MetaAdSet[]> {
    return this.paged<MetaAdSet>(`${this.account}/adsets`, { fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget', limit: 200 }, '광고 세트 조회');
  }
}
