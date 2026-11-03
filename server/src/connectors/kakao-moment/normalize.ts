/**
 * 카카오모먼트 보고서 · 엔티티 → 표준 레코드 (순수 함수).
 *  - 지표 이름은 타입 정보 문서(MetricsGroup)의 키: imp · click · cost · conv_purchase_{1d|7d} · conv_purchase_p_{1d|7d}
 *  - 보고서 일자: 문서 표기는 yyyyMMdd, 예시 응답은 yyyy-MM-dd — 둘 다 받는다 (KST)
 *  - 시간대 보고서(dimension=HOUR): 값 '00'~'23'(+ 'total'). 응답 dimensions의 키 이름은 문서 예시가 없어
 *    'hour' 등 hour가 들어간 키를 먼저 찾고, 없으면 id 키를 뺀 두 자리 숫자 값을 쓴다 (TODO: 실계정 응답으로 키 이름 확인)
 * 엔티티 id: 'kakao-cmp-<campaignId>' · 'kakao-grp-<adGroupId>'
 */
import type { AdAccount, Campaign, Keyword } from '@/core/types';
import { dec2, inferIntent, krw, num, type Funnel } from '../naver-sa/media-shared';
import type { KakaoAccount, KakaoAdGroup, KakaoCampaign, KakaoReportRow } from './client';

export type ConversionWindow = '1d' | '7d';

export function funnelOfReport(r: KakaoReportRow, w: ConversionWindow): Funnel {
  const m = r.metrics ?? {};
  return { impressions: num(m.imp), clicks: num(m.click), cost: krw(m.cost), conversions: dec2(m[`conv_purchase_${w}`]), revenue: krw(m[`conv_purchase_p_${w}`]) };
}

const ID_KEYS = /_id$/;
export function hourOfReport(r: KakaoReportRow): number | null | 'total' {
  const dims = r.dimensions ?? {};
  const entries = Object.entries(dims);
  const named = entries.find(([k]) => /hour/i.test(k));
  const v = named ? named[1] : entries.find(([k, x]) => !ID_KEYS.test(k) && /^(\d{2}|total)$/.test(String(x)))?.[1];
  if (v === undefined) return null;
  if (String(v) === 'total') return 'total';
  const h = Number(String(v).slice(0, 2));
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

export const campaignEntityId = (id: number | string) => `kakao-cmp-${id}`;
export const adGroupEntityId = (id: number | string) => `kakao-grp-${id}`;
export function kakaoTarget(targetId: string | undefined): { type: 'campaign' | 'adgroup'; id: string } | null {
  const m = String(targetId ?? '').match(/kakao-(cmp|grp)-(\d+)/);
  return m ? { type: m[1] === 'cmp' ? 'campaign' : 'adgroup', id: m[2] } : null;
}

export const isLive = (x: { config?: string }) => x.config !== 'DEL';
export function statusOf(x: KakaoCampaign): Campaign['status'] {
  if (x.config === 'OFF') return 'off';
  if (x.systemConfig && x.systemConfig !== 'ON') return 'off';
  if (x.isDailyBudgetAmountOver) return 'limited';
  return 'on';
}

/** 예산 단위: 캠페인 일 예산이 있으면 캠페인, 없으면 광고그룹(일 예산 있는 것), 둘 다 없으면 캠페인(일 예산 0 = 한도 없음) */
export function budgetUnits(
  campaigns: KakaoCampaign[],
  adGroups: Map<number, KakaoAdGroup[]>,
  spentCampaign: Map<string, number>,
  spentAdGroup: Map<string, number>,
  o: { hour: number; intentRules?: { match: string; intent: Keyword['intent'] }[] },
): Campaign[] {
  const rows: Campaign[] = [];
  for (const c of campaigns.filter(isLive)) {
    const groups = (adGroups.get(c.id) ?? []).filter(isLive).filter((g) => num(g.dailyBudgetAmount) > 0);
    if (num(c.dailyBudgetAmount) > 0 || !groups.length) {
      rows.push({ id: campaignEntityId(c.id), media: 'kakao', name: c.name ?? String(c.id), intent: inferIntent([c.name], o.intentRules), dailyBudget: krw(c.dailyBudgetAmount), spentToday: spentCampaign.get(String(c.id)) ?? 0, status: statusOf(c), hourOfData: o.hour });
      continue;
    }
    for (const g of groups) {
      rows.push({
        id: adGroupEntityId(g.id), media: 'kakao', name: `${c.name ?? c.id} · ${g.name ?? g.id}`, intent: inferIntent([c.name, g.name], o.intentRules),
        dailyBudget: krw(g.dailyBudgetAmount), spentToday: spentAdGroup.get(String(g.id)) ?? 0, status: statusOf(c) === 'off' ? 'off' : statusOf(g), hourOfData: o.hour,
      });
    }
  }
  return rows;
}

export function accountOf(a: KakaoAccount, id: string, bal: { cash?: number; freeCash?: number }, avgDailySpend: number, s: { autoCharge: 'ok' | 'off'; owner?: string }): AdAccount {
  return {
    id: `kakao-${id}`,
    media: 'kakao',
    name: a.name ? `카카오모먼트 ${a.name}` : `카카오모먼트 ${id}`,
    owner: s.owner ?? '',
    balance: krw(bal.cash) + krw(bal.freeCash),
    avgDailySpend,
    autoCharge: s.autoCharge,
    paymentMethod: `캐시(유상 ${krw(bal.cash).toLocaleString('ko-KR')}원 · 무상 ${krw(bal.freeCash).toLocaleString('ko-KR')}원)`,
    permissions: [],
    status: a.isAdminStop ? 'restricted' : a.config === 'DEL' ? 'restricted' : 'active',
  };
}
