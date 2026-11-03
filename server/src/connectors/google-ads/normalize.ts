/**
 * Google Ads GAQL 행 → 표준 레코드 (순수 함수).
 * 근거: REST 디스커버리 문서 v26(https://googleads.googleapis.com/$discovery/rest?version=v26)의 리소스 · 지표 정의
 *  - metrics.cost_micros · campaign_budget.amount_micros · ad_group_criterion.cpc_bid_micros: 계정 통화의 백만분의 1 (÷1e6 → 원)
 *  - metrics.conversions · conversions_value: double (include_in_conversions_metric 전환만)
 *  - metrics.search_rank_lost_impression_share: 0~1
 *  - segments.date: 계정 시간대 기준 (계정 시간대가 Asia/Seoul이 아니면 경고)
 * 엔티티 id: 캠페인 'gads-cmp-<campaignId>', 키워드 'gads-kw-<adGroupId>-<criterionId>' (다른 매체 id와 충돌하지 않게 접두어)
 */
import type { AdAccount, Campaign, Keyword } from '@/core/types';
import { dec2, inferIntent, isBrandKeyword, maxBidOf, num, type Funnel } from '../naver-sa/media-shared';
import type { GadsRow } from './client';

/** 키워드 입찰가 상한(안전 상한 계산용) — Google 문서에 고정 상한이 없어 넉넉히 둔 값 */
export const GOOGLE_BID_CAP = 10_000_000;

export const micros = (v: unknown) => Math.round(num(v) / 1e6);
export const toMicros = (krwAmount: number) => String(Math.round(krwAmount) * 1_000_000);

export function funnelOfRow(r: GadsRow): Funnel {
  const m = r.metrics ?? {};
  return {
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    cost: micros(m.costMicros),
    conversions: dec2(m.conversions),
    revenue: Math.round(num(m.conversionsValue)),
  };
}

export const campaignEntityId = (campaignId: string | number) => `gads-cmp-${campaignId}`;
export const keywordEntityId = (adGroupId: string | number, criterionId: string | number) => `gads-kw-${adGroupId}-${criterionId}`;

/** 대상 id(접두어가 붙어 있어도) → 캠페인 · 키워드 */
export function googleTarget(targetId: string | undefined): { type: 'campaign'; campaignId: string } | { type: 'keyword'; adGroupId: string; criterionId: string } | null {
  const s = String(targetId ?? '');
  let m = s.match(/gads-kw-(\d+)-(\d+)/);
  if (m) return { type: 'keyword', adGroupId: m[1], criterionId: m[2] };
  m = s.match(/gads-cmp-(\d+)/);
  if (m) return { type: 'campaign', campaignId: m[1] };
  return null;
}

export function campaignStatus(r: GadsRow): Campaign['status'] {
  const c = r.campaign ?? {};
  if (c.status !== 'ENABLED') return 'off';
  if (c.servingStatus && ['ENDED', 'SUSPENDED', 'NONE'].includes(c.servingStatus)) return 'off';
  if (c.primaryStatus === 'LIMITED' || c.primaryStatus === 'MISCONFIGURED' || c.primaryStatus === 'NOT_ELIGIBLE') return 'limited';
  return 'on';
}

export function normCampaign(r: GadsRow, spentToday: number, hour: number, rules: { match: string; intent: Keyword['intent'] }[]): Campaign {
  const daily = r.campaignBudget?.period === undefined || r.campaignBudget.period === 'DAILY';
  return {
    id: campaignEntityId(r.campaign?.id ?? ''),
    media: 'google',
    name: r.campaign?.name ?? String(r.campaign?.id ?? ''),
    intent: inferIntent([r.campaign?.name], rules),
    dailyBudget: daily ? micros(r.campaignBudget?.amountMicros) : 0,
    spentToday,
    status: campaignStatus(r),
    hourOfData: hour,
  };
}

export type GoogleKeywordSnapshot = Omit<Keyword, 'last14' | 'prev14' | 'daily'> & { media: 'google'; campaignId: string; adgroupId: string; matchType?: string };

export const MANUAL_BIDDING = new Set(['MANUAL_CPC', 'ENHANCED_CPC']);

export function normKeyword(
  r: GadsRow,
  lostShare: number,
  s: { brandTerms?: string[]; intentRules?: { match: string; intent: Keyword['intent'] }[]; maxBid?: number; maxBidMultiplier?: number },
): { keyword: GoogleKeywordSnapshot; maxBidDerived: boolean } {
  const k = r.adGroupCriterion ?? {};
  const text = k.keyword?.text ?? '';
  const intent = inferIntent([r.campaign?.name, r.adGroup?.name], s.intentRules);
  const bid = micros(k.cpcBidMicros ?? k.effectiveCpcBidMicros);
  const mb = maxBidOf(bid, s, GOOGLE_BID_CAP);
  const off = k.status !== 'ENABLED' || (r.adGroup?.status && r.adGroup.status !== 'ENABLED') || (r.campaign?.status && r.campaign.status !== 'ENABLED');
  return {
    keyword: {
      id: keywordEntityId(r.adGroup?.id ?? '', k.criterionId ?? ''),
      text,
      intent,
      adgroup: `Google · ${r.adGroup?.name ?? r.adGroup?.id ?? ''}`,
      isBrand: isBrandKeyword(text, intent, s.brandTerms ?? []),
      bid,
      maxBid: mb.value,
      // Google Ads는 평균 게재순위 지표를 제공하지 않는다
      avgRank: 0,
      monthlySearch: 0,
      impressionShareLost: Math.min(1, Math.max(0, lostShare)),
      status: off ? 'off' : 'on',
      landing: k.finalUrls?.[0] ?? '',
      media: 'google',
      campaignId: campaignEntityId(r.campaign?.id ?? ''),
      adgroupId: String(r.adGroup?.id ?? ''),
      matchType: k.keyword?.matchType,
    },
    maxBidDerived: mb.derived,
  };
}

export function accountOf(customer: GadsRow['customer'], customerId: string, avgDailySpend: number, owner = ''): AdAccount {
  return {
    id: `gads-${customerId}`,
    media: 'google',
    name: customer?.descriptiveName ? `Google Ads ${customer.descriptiveName}` : `Google Ads ${customerId}`,
    owner,
    // Google Ads는 후불(월별 청구 · 자동 결제) 구조가 일반적이며 잔액 API를 조회하지 않는다
    balance: -1,
    avgDailySpend,
    autoCharge: 'postpaid',
    paymentMethod: 'Google Ads 결제 설정 (API 미조회)',
    permissions: [],
    status: 'active',
  };
}
