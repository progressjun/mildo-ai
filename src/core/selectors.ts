/**
 * Pro-board 공통 집계 — 여러 모듈(Board · Reports · Home · Agent)이 같은 숫자를 쓰도록 한 곳에서 계산한다.
 * 모든 함수는 순수 함수 (Dataset → 결과).
 */
import type { Dataset, DailyMediaRow, FunnelCounts, Keyword, MediaId, SalesChannelId } from './types';
import { MEDIA, MEDIA_IDS, SALES_CHANNEL_IDS } from '@/data/constants';
import { addDays, daysInMonth, metrics, monthKey, sum } from './util';

export interface Totals extends FunnelCounts {
  newCustomers: number;
  ctr: number; cpc: number; cvr: number; cpa: number; roas: number; cac: number;
}

export function totalsOf(rows: readonly (FunnelCounts & { newCustomers?: number })[]): Totals {
  const t = {
    impressions: sum(rows, (r) => r.impressions),
    clicks: sum(rows, (r) => r.clicks),
    cost: sum(rows, (r) => r.cost),
    conversions: sum(rows, (r) => r.conversions),
    revenue: sum(rows, (r) => r.revenue),
    newCustomers: sum(rows, (r) => r.newCustomers ?? 0),
  };
  return {
    ...t,
    ctr: metrics.ctr(t.clicks, t.impressions),
    cpc: metrics.cpc(t.cost, t.clicks),
    cvr: metrics.cvr(t.conversions, t.clicks),
    cpa: metrics.cpa(t.cost, t.conversions),
    roas: metrics.roas(t.revenue, t.cost),
    cac: t.newCustomers > 0 ? t.cost / t.newCustomers : NaN,
  };
}

/** [from, to] 포함 범위 */
export function mediaRows(d: Dataset, from: string, to: string, media?: MediaId | MediaId[]): DailyMediaRow[] {
  const set = media ? new Set(Array.isArray(media) ? media : [media]) : null;
  return d.mediaDaily.filter((r) => r.date >= from && r.date <= to && (!set || set.has(r.media)));
}

/** 기간 프리셋 → [from, to]. '어제'가 일간 리포트 기준. 오늘은 진행 중(부분일). */
export type RangePreset = 'yesterday' | 'today' | 'last7' | 'last14' | 'last30' | 'mtd';
export function rangeOf(d: Dataset, p: RangePreset): { from: string; to: string; label: string } {
  const y = addDays(d.today, -1);
  switch (p) {
    case 'today': return { from: d.today, to: d.today, label: `오늘 (${d.currentHour}시 기준)` };
    case 'yesterday': return { from: y, to: y, label: '어제' };
    case 'last7': return { from: addDays(y, -6), to: y, label: '최근 7일' };
    case 'last14': return { from: addDays(y, -13), to: y, label: '최근 14일' };
    case 'last30': return { from: addDays(y, -29), to: y, label: '최근 30일' };
    case 'mtd': return { from: `${monthKey(d.today)}-01`, to: d.today, label: '이번 달 누적' };
  }
}
/** 같은 길이의 직전 기간 */
export function previousRange(r: { from: string; to: string }): { from: string; to: string } {
  const len = Math.round((new Date(r.to).getTime() - new Date(r.from).getTime()) / 86400000) + 1;
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}

export function byMedia(d: Dataset, from: string, to: string): (Totals & { media: MediaId; share: number })[] {
  const all = totalsOf(mediaRows(d, from, to));
  return MEDIA_IDS.map((m) => {
    const t = totalsOf(mediaRows(d, from, to, m));
    return { ...t, media: m, share: all.cost > 0 ? t.cost / all.cost : 0 };
  });
}

/** 일자별 시계열 (매체별 또는 합계) */
export function dailySeries(d: Dataset, from: string, to: string, field: keyof FunnelCounts | 'roas' | 'cpa', media?: MediaId) {
  const out: { date: string; value: number }[] = [];
  for (const date of d.dates) {
    if (date < from || date > to) continue;
    const rows = d.mediaDaily.filter((r) => r.date === date && (!media || r.media === media));
    const t = totalsOf(rows);
    out.push({ date, value: field === 'roas' ? t.roas : field === 'cpa' ? t.cpa : (t as unknown as Record<string, number>)[field] });
  }
  return out;
}

export function salesByChannel(d: Dataset, from: string, to: string) {
  return SALES_CHANNEL_IDS.map((c) => {
    const rows = d.salesDaily.filter((r) => r.channel === c && r.date >= from && r.date <= to);
    const revenue = sum(rows, (r) => r.revenue);
    const orders = sum(rows, (r) => r.orders);
    const visitors = sum(rows, (r) => r.visitors);
    return {
      channel: c as SalesChannelId,
      revenue, orders, visitors,
      detailViews: sum(rows, (r) => r.detailViews),
      carts: sum(rows, (r) => r.carts),
      adAttributedRevenue: sum(rows, (r) => r.adAttributedRevenue),
      cvr: visitors > 0 ? (orders / visitors) * 100 : NaN,
      aov: orders > 0 ? revenue / orders : NaN,
    };
  });
}

/** 예산 소진 현황: 월 예산(연 배분/12) 대비 MTD 소진 + 예상 마감 */
export function monthlyPacing(d: Dataset) {
  const mk = monthKey(d.today);
  const dim = daysInMonth(d.today);
  const dayOfMonth = Number(d.today.slice(8, 10));
  const elapsedDays = dayOfMonth - 1 + d.currentHour / 24; // 오늘은 부분일
  return MEDIA_IDS.map((m) => {
    const budget = MEDIA[m].annualBudget / 12;
    const spent = sum(d.mediaDaily.filter((r) => r.media === m && monthKey(r.date) === mk), (r) => r.cost);
    const dailyRun = elapsedDays > 0 ? spent / elapsedDays : 0;
    const projected = dailyRun * dim;
    const daysToExhaust = dailyRun > 0 ? (budget - spent) / dailyRun : Infinity;
    const expectedPct = elapsedDays / dim;
    return {
      media: m, budget, spent, projected,
      pacePct: budget > 0 ? (spent / budget) * 100 : 0,
      expectedPct: expectedPct * 100,
      /** 예상 소진 완료일 (월말 이전이면 조기 소진) */
      exhaustDay: Number.isFinite(daysToExhaust) ? Math.min(dim + 30, dayOfMonth + Math.floor(daysToExhaust)) : null,
      status: projected > budget * 1.05 ? 'over' as const : projected < budget * 0.9 ? 'under' as const : 'ok' as const,
    };
  });
}

/** 캠페인 일 예산 소진: 현재 시각 기준 소진 속도 → 예상 마감 시각 */
export function campaignPacing(d: Dataset) {
  return d.campaigns.map((c) => {
    const hoursElapsed = c.hourOfData + 1;
    const perHour = c.spentToday / hoursElapsed;
    const remain = c.dailyBudget - c.spentToday;
    const hoursLeft = perHour > 0 ? remain / perHour : Infinity;
    const exhaustHour = c.hourOfData + 1 + hoursLeft;
    return {
      ...c,
      pacePct: (c.spentToday / c.dailyBudget) * 100,
      exhaustHour: Number.isFinite(exhaustHour) ? exhaustHour : null,
      earlyExhaust: Number.isFinite(exhaustHour) && exhaustHour < 23,
    };
  });
}

export function keywordMetrics(k: Keyword) {
  const s = k.last14;
  const p = k.prev14;
  return {
    ctr: metrics.ctr(s.clicks, s.impressions),
    cpc: metrics.cpc(s.cost, s.clicks),
    cvr: metrics.cvr(s.conversions, s.clicks),
    cpa: metrics.cpa(s.cost, s.conversions),
    roas: metrics.roas(s.revenue, s.cost),
    prevRoas: metrics.roas(p.revenue, p.cost),
    costDelta: metrics.pctChange(s.cost, p.cost),
    convDelta: metrics.pctChange(s.conversions, p.conversions),
  };
}

/** 헤드라인 KPI (어제 vs 그 전날, 최근7일 vs 직전7일) */
export function headline(d: Dataset) {
  const y = rangeOf(d, 'yesterday');
  const py = previousRange(y);
  const w = rangeOf(d, 'last7');
  const pw = previousRange(w);
  const t = (r: { from: string; to: string }) => totalsOf(mediaRows(d, r.from, r.to));
  const sales = (r: { from: string; to: string }) => sum(salesByChannel(d, r.from, r.to), (c) => c.revenue);
  return {
    yesterday: t(y), dayBefore: t(py), last7: t(w), prev7: t(pw),
    salesYesterday: sales(y), salesDayBefore: sales(py), sales7: sales(w), salesPrev7: sales(pw),
  };
}
