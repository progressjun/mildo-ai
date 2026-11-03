/**
 * Meta Insights · 엔티티 → 표준 레코드 (순수 함수).
 *  - spend는 계정 통화의 기본 단위 문자열("12345" · "98.45"), impressions · clicks는 문자열 정수
 *  - 구매 전환: actions / action_values에서 설정 purchaseActionTypes 순서대로 처음 나온 유형 하나만 쓴다
 *    (omni_purchase는 픽셀 · 앱 등 구매를 합친 값이라 purchase · offsite_conversion.fb_pixel_purchase와 같이 더하면 중복)
 *  - 예산(daily_budget)은 통화 최소 단위 — KRW 오프셋 1(문서 확인), 그 밖의 통화는 오프셋 100으로 가정하고 경고
 *  - 시간대: hourly_stats_aggregated_by_advertiser_time_zone "HH:MM:SS - HH:MM:SS" → 시 (광고 계정 시간대 기준)
 * 엔티티 id: 'meta-cmp-<campaignId>'(캠페인 예산 CBO) · 'meta-adset-<adSetId>'(광고 세트 예산)
 */
import type { AdAccount, Campaign, Keyword } from '@/core/types';
import { dec2, inferIntent, krw, num, parseHour, type Funnel } from '../naver-sa/media-shared';
import type { MetaAccount, MetaAction, MetaAdSet, MetaCampaign, MetaInsightRow } from './client';

export const DEFAULT_PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

/** 통화 최소 단위 배수 — 문서로 확인한 값은 KRW 1뿐이다. 그 외 통화는 오프셋 100으로 가정하고 수집 시 경고, 반영은 KRW만 */
export const currencyOffset = (currency: string | undefined) => (!currency || currency === 'KRW' ? 1 : 100);

function pick(list: MetaAction[] | undefined, types: string[]): { type: string | null; value: number } {
  if (!list?.length) return { type: null, value: 0 };
  for (const t of types) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return { type: t, value: num(hit.value) };
  }
  return { type: null, value: 0 };
}

export function funnelOfInsight(r: MetaInsightRow, purchaseTypes: string[] = DEFAULT_PURCHASE_TYPES): Funnel {
  const conv = pick(r.actions, purchaseTypes);
  // 매출은 전환과 같은 유형으로 맞춘다 (없으면 같은 우선순위로)
  const rev = conv.type ? pick(r.action_values, [conv.type]) : pick(r.action_values, purchaseTypes);
  return { impressions: num(r.impressions), clicks: num(r.clicks), cost: krw(r.spend), conversions: dec2(conv.value), revenue: krw(rev.value) };
}

export const hourOfInsight = (r: MetaInsightRow) => parseHour(r.hourly_stats_aggregated_by_advertiser_time_zone);

const HIDDEN = new Set(['DELETED', 'ARCHIVED']);
export const isLive = (x: { effective_status?: string; status?: string }) => !HIDDEN.has(x.effective_status ?? '') && !HIDDEN.has(x.status ?? '');

export function statusOf(x: { effective_status?: string; status?: string }): Campaign['status'] {
  const s = x.effective_status ?? x.status ?? '';
  if (s === 'ACTIVE') return 'on';
  if (['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(s)) return 'off';
  return 'limited';
}

export const campaignEntityId = (id: string) => `meta-cmp-${id}`;
export const adsetEntityId = (id: string) => `meta-adset-${id}`;
export function metaTarget(targetId: string | undefined): { type: 'campaign' | 'adset'; id: string } | null {
  const m = String(targetId ?? '').match(/meta-(cmp|adset)-(\d+)/);
  return m ? { type: m[1] === 'cmp' ? 'campaign' : 'adset', id: m[2] } : null;
}

/**
 * 예산 단위 행: 캠페인에 일 예산이 있으면(CBO) 캠페인 하나, 아니면 그 캠페인의 광고 세트들.
 * 평생 예산만 있는 단위는 일 예산 0 (lifetime 개수를 돌려준다)
 */
export function budgetUnits(
  campaigns: MetaCampaign[],
  adsets: MetaAdSet[],
  spentByCampaign: Map<string, number>,
  spentByAdset: Map<string, number>,
  o: { offset: number; hour: number; intentRules?: { match: string; intent: Keyword['intent'] }[] },
): { rows: Campaign[]; lifetimeOnly: number } {
  const rows: Campaign[] = [];
  let lifetimeOnly = 0;
  const byCampaign = new Map<string, MetaAdSet[]>();
  for (const a of adsets.filter(isLive)) {
    const k = a.campaign_id ?? '';
    byCampaign.set(k, [...(byCampaign.get(k) ?? []), a]);
  }
  for (const c of campaigns.filter(isLive)) {
    const intent = inferIntent([c.name], o.intentRules);
    if (num(c.daily_budget) > 0 || num(c.lifetime_budget) > 0) {
      if (!(num(c.daily_budget) > 0)) lifetimeOnly++;
      rows.push({ id: campaignEntityId(c.id), media: 'meta', name: c.name ?? c.id, intent, dailyBudget: Math.round(num(c.daily_budget) / o.offset), spentToday: spentByCampaign.get(c.id) ?? 0, status: statusOf(c), hourOfData: o.hour });
      continue;
    }
    for (const a of byCampaign.get(c.id) ?? []) {
      if (!(num(a.daily_budget) > 0)) lifetimeOnly++;
      const off = statusOf(c) === 'off' ? 'off' : statusOf(a);
      rows.push({ id: adsetEntityId(a.id), media: 'meta', name: `${c.name ?? c.id} · ${a.name ?? a.id}`, intent: inferIntent([c.name, a.name], o.intentRules), dailyBudget: Math.round(num(a.daily_budget) / o.offset), spentToday: spentByAdset.get(a.id) ?? 0, status: off, hourOfData: o.hour });
    }
  }
  return { rows, lifetimeOnly };
}

export function accountOf(a: MetaAccount, id: string, avgDailySpend: number, offset: number, owner = ''): { account: AdAccount; balanceKnown: boolean } {
  const st = Number(a.account_status);
  const status: AdAccount['status'] = st === 1 || st === 201 ? 'active' : [2, 100, 101, 202].includes(st) ? 'restricted' : 'review';
  const cap = num(a.spend_cap);
  const prepay = a.is_prepay_account === true;
  // 남은 금액을 계산할 수 있는 경우: 지출 한도(spend_cap)가 있을 때 (한도 - 누적 지출). 선불 잔액 필드는 문서에 없다
  const remaining = cap > 0 ? Math.max(0, Math.round((cap - num(a.amount_spent)) / offset)) : null;
  return {
    account: {
      id: `meta-${id.replace(/^act_/, '')}`,
      media: 'meta',
      name: a.name ? `Meta ${a.name}` : `Meta ${id}`,
      owner,
      balance: remaining ?? -1,
      avgDailySpend,
      autoCharge: prepay ? 'off' : 'postpaid',
      paymentMethod: prepay ? `선불${cap > 0 ? ' · 계정 지출 한도 기준 잔여' : ''}` : `후불(결제 수단)${cap > 0 ? ' · 계정 지출 한도 기준 잔여' : ''}`,
      permissions: [],
      status,
    },
    balanceKnown: remaining !== null || !prepay,
  };
}
