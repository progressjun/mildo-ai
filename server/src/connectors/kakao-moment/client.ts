/**
 * 카카오모먼트 API 클라이언트 — 보고서 · 캠페인 · 광고그룹 · 광고계정 · 일 예산 · ON/OFF.
 *
 * 공식 문서 (2026-11-02 확인, 기반 URL https://apis.moment.kakao.com/openapi/v4):
 *   - 이해하기 · API 목록: https://developers.kakao.com/docs/latest/ko/kakaomoment/common
 *   - 보고서: https://developers.kakao.com/docs/latest/ko/kakaomoment/report
 *       GET /adAccounts/report · /campaigns/report(campaignId 최대 5) · /adGroups/report(adGroupId 최대 40)
 *       start · end(yyyyMMdd, 최대 31일, 전일까지) · datePreset(TODAY 등) · timeUnit(DAY|ALL) · level · dimension(HOUR 등) · metricsGroup[]
 *       오늘은 datePreset=TODAY로만, 특정 일자 보고서는 다음날 08시 전까지 변동 가능
 *       호출 제한: 광고계정 · 캠페인 · 소재 보고서 5초에 1회, 광고그룹 보고서 1초에 1회
 *   - 타입 정보: https://developers.kakao.com/docs/latest/ko/kakaomoment/type-info
 *       BASIC: imp · click · ctr · cost / PIXEL_SDK_CONVERSION: conv_purchase_1d · 7d(구매) · conv_purchase_p_1d · 7d(구매 금액)
 *       Dimension HOUR 값 '00'~'23' · 'total'
 *   - 캠페인: https://developers.kakao.com/docs/latest/ko/kakaomoment/campaign
 *       GET /campaigns · /campaigns/{id}(dailyBudgetAmount · isDailyBudgetAmountOver · config · systemConfig)
 *       PUT /campaigns/dailyBudgetAmount { id, dailyBudgetAmount } — 5만~10억 원, 10원 단위 · 사용자 · 광고계정마다 5초에 1회
 *       PUT /campaigns/onOff { id, config: ON|OFF } — 5초에 1회, 응답 본문 없음
 *   - 광고그룹: https://developers.kakao.com/docs/latest/ko/kakaomoment/ad-group
 *       GET /adGroups?campaignId= · /adGroups/{id}, PUT /adGroups/dailyBudgetAmount(1만~5억 원, 10원 단위, 1초에 1회) · /adGroups/onOff(1초에 1회)
 *   - 광고계정: https://developers.kakao.com/docs/latest/ko/kakaomoment/ad-account  GET /adAccounts/{id} · /adAccounts/balance(cash · freeCash)
 *   - 에러: https://developers.kakao.com/docs/latest/ko/kakaomoment/error-code  { code:-813, msg, extras:{ detailCode, detailMsg } }, -10 요청 횟수 초과, -813/429 쿼터 초과
 *   - 인증: https://developers.kakao.com/docs/latest/ko/business-auth/rest-api  비즈니스 토큰(Authorization: Bearer) — 갱신 토큰 없음, 장기 미사용 시 만료
 */
import type { ConnectorContext } from '../types';
import { callApi, pause, type ErrorInfo, type HttpRequest } from '../naver-sa/media-shared';

export const KAKAO_BASE = 'https://apis.moment.kakao.com/openapi/v4';
export const KAKAO_LABEL = '카카오모먼트';
const PROVIDER = 'kakao_moment';

export type KakaoCredentials = { accessToken: string; adAccountId: string };

export function describeKakaoError(status: number, data: unknown): ErrorInfo | null {
  const d = data as { code?: number; msg?: string; message?: string; extras?: { detailCode?: number; detailMsg?: string; message?: string; status?: number } } | null;
  if (!d || typeof d !== 'object' || d.code === undefined || d.code === 200 || d.code === 0) return null;
  const code = Number(d.code);
  const detail = [d.extras?.detailMsg ?? d.extras?.message ?? d.message ?? d.msg, d.extras?.detailCode ? `(${d.extras.detailCode})` : ''].filter(Boolean).join(' ');
  if (code === -401) return { kind: 'auth', code: '-401', detail: `${detail} — 비즈니스 토큰이 만료되었거나 철회되었습니다. 비즈니스 인증으로 토큰을 다시 발급해 주세요` };
  if (code === -402) return { kind: 'permission', code: '-402', detail: `${detail} — 필요한 비즈니스 동의항목(moment_management 등)에 동의가 없습니다` };
  if (code === -5 || status === 403) return { kind: 'permission', code: String(code), detail };
  if (code === -10 || status === 429) return { kind: 'rate', code: String(code), detail };
  if (status >= 500 || code === -1) return { kind: 'server', code: String(code), detail };
  return { kind: status >= 400 ? undefined : 'invalid', code: String(d.extras?.detailCode ?? code), detail };
}

/** 문서상 호출 간격 (ms) */
export const INTERVAL = { report: 5000, adGroupReport: 1000, campaignWrite: 5000, adGroupWrite: 1000 } as const;
const lastCall = new Map<string, number>();
export function _resetKakaoThrottleForTest(): void {
  lastCall.clear();
}

export interface KakaoReportRow { start?: string; end?: string; dimensions?: Record<string, string | number>; metrics?: Record<string, number> }
export interface KakaoCampaign {
  id: number; name?: string; config?: string; systemConfig?: string; dailyBudgetAmount?: number | null; isDailyBudgetAmountOver?: boolean;
  statusDescription?: string; campaignTypeGoal?: { campaignType?: string; goal?: string };
}
export interface KakaoAdGroup extends KakaoCampaign { bidAmount?: number; pricingType?: string }
export interface KakaoAccount { id?: number; name?: string; config?: string; isAdminStop?: boolean; isOutOfBalance?: boolean; statusDescription?: string; type?: string }

export class KakaoClient {
  constructor(private ctx: Pick<ConnectorContext, 'http'>, private creds: KakaoCredentials, private o: { now?: () => number } = {}) {}

  get accountId(): string { return String(this.creds.adAccountId); }

  request(method: HttpRequest['method'], path: string, query?: HttpRequest['query'], body?: unknown): HttpRequest {
    return {
      method,
      url: `${KAKAO_BASE}${path}`,
      query,
      headers: { Authorization: `Bearer ${this.creds.accessToken}`, adAccountId: this.accountId },
      ...(body !== undefined ? { body, bodyType: 'json' as const } : {}),
    };
  }

  /** 버킷별 최소 간격을 지켜 호출 */
  private async throttle(bucket: keyof typeof INTERVAL): Promise<void> {
    const now = this.o.now ?? Date.now;
    const key = `${this.accountId}|${bucket}`;
    const last = lastCall.get(key);
    if (last !== undefined) {
      const wait = INTERVAL[bucket] - (now() - last);
      if (wait > 0) await pause(wait);
    }
    lastCall.set(key, now());
  }

  async call<T>(method: HttpRequest['method'], path: string, what: string, o: { query?: HttpRequest['query']; body?: unknown; bucket?: keyof typeof INTERVAL } = {}): Promise<T> {
    if (o.bucket) await this.throttle(o.bucket);
    const res = await callApi<T>(this.ctx, this.request(method, path, o.query, o.body), { provider: PROVIDER, label: KAKAO_LABEL, what, describe: describeKakaoError });
    return res.data;
  }

  async report(scope: 'adAccounts' | 'campaigns' | 'adGroups', query: Record<string, string>, what: string): Promise<KakaoReportRow[]> {
    const d = await this.call<{ data?: KakaoReportRow[] }>('GET', `/${scope}/report`, what, { query, bucket: scope === 'adGroups' ? 'adGroupReport' : 'report' });
    return (d?.data ?? []).filter((r) => r && r.metrics && Object.keys(r.metrics).length);
  }

  async campaigns(): Promise<KakaoCampaign[]> {
    return (await this.call<{ content?: KakaoCampaign[] }>('GET', '/campaigns', '캠페인 목록 조회'))?.content ?? [];
  }
  campaign(id: number | string): Promise<KakaoCampaign> {
    return this.call<KakaoCampaign>('GET', `/campaigns/${id}`, '캠페인 조회');
  }
  async adGroups(campaignId: number | string): Promise<KakaoAdGroup[]> {
    return (await this.call<{ content?: KakaoAdGroup[] }>('GET', '/adGroups', '광고그룹 목록 조회', { query: { campaignId: String(campaignId) } }))?.content ?? [];
  }
  adGroup(id: number | string): Promise<KakaoAdGroup> {
    return this.call<KakaoAdGroup>('GET', `/adGroups/${id}`, '광고그룹 조회');
  }
  account(): Promise<KakaoAccount> {
    return this.call<KakaoAccount>('GET', `/adAccounts/${this.accountId}`, '광고계정 조회');
  }
  balance(): Promise<{ cash?: number; freeCash?: number }> {
    return this.call<{ cash?: number; freeCash?: number }>('GET', '/adAccounts/balance', '실시간 잔액 조회');
  }
  write(path: '/campaigns/dailyBudgetAmount' | '/campaigns/onOff' | '/adGroups/dailyBudgetAmount' | '/adGroups/onOff', body: Record<string, unknown>, what: string): Promise<unknown> {
    return this.call<unknown>('PUT', path, what, { body, bucket: path.startsWith('/campaigns') ? 'campaignWrite' : 'adGroupWrite' });
  }
}
