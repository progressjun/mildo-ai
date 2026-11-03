/**
 * 네이버 검색광고 응답 → 표준 레코드 (순수 함수, 테스트 대상).
 * 필드 근거: https://naver.github.io/searchad-apidoc/ (Campaign · Adgroup · AdKeyword 정의, ncc-report.json의 StatResponse)
 *  - salesAmt: "Cost Summation (VAT included)" — 기본은 매체 보고 그대로(VAT 포함), 설정 costBasis='vat_excluded'면 ÷1.1
 *  - ccnt · convAmt: 전체 전환수 · 전환매출액, purchaseCcnt · purchaseConvAmt: 구매완료 전환(2026-03-30 제공 시작, 최근 2년 소급)
 *  - avgRnk: 평균 노출 순위 (파워링크)
 *  - Campaign.userLock=true → OFF, statusReason CAMPAIGN_LIMITED_BY_BUDGET → 예산 제한
 */
import type { Campaign, Keyword } from '@/core/types';
import { inferIntent, isBrandKeyword, krw, maxBidOf, num, type Funnel } from './media-shared';
import type { NaverAdgroup, NaverCampaign, NaverKeyword, NaverStatRow } from './client';

export type ConversionMetric = 'purchase' | 'all';
export type CostBasis = 'vat_included' | 'vat_excluded';

/** 문서: 키워드 입찰가 70 ~ 100,000원 */
export const NAVER_BID_MIN = 70;
export const NAVER_BID_MAX = 100_000;

export function funnelOf(row: NaverStatRow, metric: ConversionMetric, basis: CostBasis): { funnel: Funnel; fallback: boolean } {
  const rawCost = num(row.salesAmt);
  const cost = basis === 'vat_excluded' ? Math.round(rawCost / 1.1) : krw(rawCost);
  const hasPurchase = row.purchaseCcnt !== undefined && row.purchaseCcnt !== null;
  const usePurchase = metric === 'purchase' && hasPurchase;
  return {
    funnel: {
      impressions: num(row.impCnt),
      clicks: num(row.clkCnt),
      cost,
      conversions: usePurchase ? num(row.purchaseCcnt) : num(row.ccnt),
      revenue: usePurchase ? num(row.purchaseConvAmt) : num(row.convAmt),
    },
    fallback: metric === 'purchase' && !hasPurchase && (num(row.ccnt) > 0 || num(row.convAmt) > 0),
  };
}

export const isDeleted = (x: { status?: string; delFlag?: boolean }) => x.delFlag === true || x.status === 'DELETED';

export function campaignStatus(c: NaverCampaign): Campaign['status'] {
  if (c.userLock || c.status === 'PAUSED') return 'off';
  if (c.statusReason === 'CAMPAIGN_LIMITED_BY_BUDGET') return 'limited';
  return 'on';
}

/** 하루 예산: useDailyBudget이면 dailyBudget, 공유 예산이면 공유 예산 하루 한도, 아니면 0(제한 없음) */
export function campaignBudget(c: NaverCampaign): number {
  if (c.useDailyBudget && num(c.dailyBudget) > 0) return krw(c.dailyBudget);
  if (c.sharedBudgetId && num(c.sharedDailyBudget) > 0) return krw(c.sharedDailyBudget);
  return 0;
}

export function normCampaign(
  c: NaverCampaign,
  spentToday: number,
  hourOfData: number,
  s: { intentRules?: { match: string; intent: Keyword['intent'] }[] },
): Campaign {
  return {
    id: c.nccCampaignId,
    media: 'naver_sa',
    name: c.name,
    intent: inferIntent([c.name], s.intentRules),
    dailyBudget: campaignBudget(c),
    spentToday: krw(spentToday),
    status: campaignStatus(c),
    hourOfData,
  };
}

export function keywordStatus(k: NaverKeyword, ag?: NaverAdgroup): Keyword['status'] {
  if (k.userLock || k.status === 'PAUSED' || ag?.userLock) return 'off';
  return 'on';
}

/** links(JSON 문자열 또는 객체)에서 첫 URL */
export function landingOf(links: unknown): string {
  let v = links;
  if (typeof v === 'string') {
    if (/^https?:\/\//.test(v)) return v;
    try { v = JSON.parse(v); } catch { return ''; }
  }
  // 너비 우선 · 선언 순서 (pc가 mobile보다 먼저)
  const queue: unknown[] = [v];
  while (queue.length) {
    const x = queue.shift();
    if (typeof x === 'string' && /^https?:\/\//.test(x)) return x;
    if (x && typeof x === 'object') queue.push(...Object.values(x as Record<string, unknown>));
  }
  return '';
}

export type KeywordSnapshot = Omit<Keyword, 'last14' | 'prev14' | 'daily'> & { media: 'naver_sa'; campaignId: string; adgroupId: string };

export function normKeyword(
  k: NaverKeyword,
  ag: NaverAdgroup | undefined,
  cmp: NaverCampaign | undefined,
  avgRank: number,
  monthlySearch: number,
  s: { brandTerms?: string[]; intentRules?: { match: string; intent: Keyword['intent'] }[]; maxBid?: number; maxBidMultiplier?: number },
): { keyword: KeywordSnapshot; maxBidDerived: boolean } {
  const intent = inferIntent([cmp?.name, ag?.name], s.intentRules);
  const bid = krw(k.useGroupBidAmt ? ag?.bidAmt : k.bidAmt) || krw(k.bidAmt) || krw(ag?.bidAmt);
  const mb = maxBidOf(bid, s, NAVER_BID_MAX);
  return {
    keyword: {
      id: k.nccKeywordId,
      text: k.keyword,
      intent,
      adgroup: ag?.name ?? k.nccAdgroupId,
      isBrand: isBrandKeyword(k.keyword, intent, s.brandTerms ?? []),
      bid,
      maxBid: mb.value,
      avgRank: Math.round(avgRank * 10) / 10,
      monthlySearch,
      impressionShareLost: 0,
      status: keywordStatus(k, ag),
      landing: landingOf(k.links),
      media: 'naver_sa',
      campaignId: cmp?.nccCampaignId ?? k.nccCampaignId ?? '',
      adgroupId: k.nccAdgroupId,
    },
    maxBidDerived: mb.derived,
  };
}

/** 시간대 breakdown 이름('00시~01시' · '00' 등) → 시 */
export function breakdownHour(name: unknown): number | null {
  const m = String(name ?? '').trim().match(/^(\d{1,2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}
