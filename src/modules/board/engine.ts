/**
 * MILDO Board (Pro-board) 엔진 — 순수 함수만 둔다 (React import 금지).
 * 제안서 p.12 통합 데이터 아키텍처 · p.13 MILDO Board(매체 통합 성과 · 키워드 성과 필터 · 예산 소진 현황) · p.9 Pro-board.
 * 집계는 src/core/selectors.ts 를 그대로 써서 Home · Reports · Agent 와 같은 숫자를 낸다.
 */
import type { AdAccount, Dataset, IntentId, Keyword, KeywordStats, MediaId, Product, SalesChannelId } from '@/core/types';
import type { Brief } from '@/ai/prompts';
import { AD_PILOT, DATA_TIMETABLE, GFA_DELEGATION, MEDIA, MEDIA_IDS, REPORT_CADENCE, SALES_CHANNELS, SALES_CHANNEL_IDS, SA_CAMPAIGNS, INTENT_IDS } from '@/data/constants';
import {
  byMedia, campaignPacing, mediaRows, monthlyPacing, previousRange, rangeOf, salesByChannel, totalsOf, type Totals,
} from '@/core/selectors';
import { addDays, clamp, daysInMonth, fmt, fmtDate, isOffDay, metrics, monthKey, parseDate, sum, weekday, WEEKDAY_KO } from '@/core/util';
import { toCsv } from '@/core/download';
import { BOARD_PERIODS, BOARD_RULES as R, DAILY_BATCH_TIME, EXTERNAL_SOURCES, MEDIA_JUDGE_NOTE, SALES_NOTE, SOURCE_METHOD } from './data';

const SALES_NOTE_TEXT = `${SALES_NOTE.replace(/\.$/, '')}(p.12).`;
/** p.17 일간 리포트 시각 · 월간 리포트 시점 */
const DAILY_REPORT_TIME = (REPORT_CADENCE.find((r) => r.id === 'daily')?.when ?? '08:00').replace(/^매일\s*/, '');
const MONTHLY_REPORT_WHEN = REPORT_CADENCE.find((r) => r.id === 'monthly')?.when ?? '익월 3영업일';
/** p.18 예산 소진율 점검 시각 */
const PACE_CHECK_TIME = DATA_TIMETABLE.find((t) => t.title.includes('예산 소진'))?.time ?? '14:00';
/** p.15 위임 범위 문장 (GFA_DELEGATION에서 생성) */
export function delegationText(): string {
  return GFA_DELEGATION.map((g, i) => {
    const lo = i === 0 ? 0 : GFA_DELEGATION[i - 1].maxPct;
    const range = Number.isFinite(g.maxPct) ? (lo === 0 ? `±${g.maxPct}% 이내` : `±${lo}~${g.maxPct}%`) : `${lo}% 초과`;
    return `${josa(range, '은/는')} ${g.label}`;
  }).join(', ');
}

/* ================================================================== */
/* 공통                                                                */
/* ================================================================== */

export type BoardPeriod = (typeof BOARD_PERIODS)[number]['id'];
export const BOARD_PERIOD_IDS: BoardPeriod[] = BOARD_PERIODS.map((p) => p.id);
export type Level = 'ok' | 'warn' | 'danger' | 'na';

const fin = (v: number) => Number.isFinite(v);
const nz = (v: number) => (Number.isFinite(v) ? v : 0);
const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : null);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
export const round = { r0, r1, r2 };

/**
 * 받침에 맞는 조사 (동적으로 들어가는 매체 · 채널 · 캠페인 이름 뒤).
 * 숫자 · 영문 · 기호는 읽는 소리 기준(예: 'SA' 에이 → 받침 없음, '%' 퍼센트 → 받침 없음, '만' → 받침 ㄴ).
 */
type JosaPair = '이/가' | '은/는' | '을/를' | '과/와' | '으로/로';
const DIGIT_TAIL: Record<string, 'none' | 'rieul' | 'other'> = { '0': 'other', '1': 'rieul', '2': 'none', '3': 'other', '4': 'none', '5': 'none', '6': 'other', '7': 'rieul', '8': 'rieul', '9': 'none' };
const LATIN_TAIL: Record<string, 'none' | 'rieul' | 'other'> = { l: 'rieul', r: 'none', m: 'other', n: 'other', k: 'none', t: 'none', p: 'none', b: 'none', d: 'none', g: 'other' };
function tailOf(word: string): 'none' | 'rieul' | 'other' {
  const w = word.replace(/[\s)\]'"’”·]+$/u, '');
  const ch = w.slice(-1);
  if (!ch) return 'none';
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other';
  }
  if (/\d/.test(ch)) return DIGIT_TAIL[ch];
  if (/le$/i.test(w)) return 'rieul'; // Google · Apple (구글 · 애플)
  if (/[a-z]/i.test(ch)) return LATIN_TAIL[ch.toLowerCase()] ?? 'none';
  return 'none';
}
export function josa(word: string, pair: JosaPair): string {
  const t = tailOf(word);
  const [withTail, noTail] = pair.split('/');
  if (pair === '으로/로') return `${word}${t === 'other' ? withTail : noTail}`;
  return `${word}${t === 'none' ? noTail : withTail}`;
}
/** 최대 n개를 나열하고 나머지는 '외 N개' */
export function listMore<T>(arr: readonly T[], n: number, f: (x: T) => string, sep = ', '): string {
  const head = arr.slice(0, n).map(f).join(sep);
  return arr.length > n ? `${head} 외 ${arr.length - n}개` : head;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
}

/** 시각(소수 시간) → 'HH:MM'. 24시 이상이면 '당일 마감 없음' */
export function clock(hour: number | null | undefined): string {
  if (hour === null || hour === undefined || !Number.isFinite(hour)) return '—';
  if (hour >= 24) return '당일 마감 없음';
  const h = Math.floor(Math.max(0, hour));
  const m = Math.min(59, Math.round((Math.max(0, hour) - h) * 60));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 데이터 기준 시각 (generatedAt) → 'HH:MM' */
export function asOfClock(d: Dataset): string {
  const m = /T(\d{2}):(\d{2})/.exec(d.generatedAt ?? '');
  return m ? `${m[1]}:${m[2]}` : `${String(d.currentHour).padStart(2, '0')}:00`;
}

/** 프리셋 이름 */
export function periodLabel(p: BoardPeriod): string {
  return BOARD_PERIODS.find((x) => x.id === p)?.label ?? p;
}

export function isBoardPeriod(v: unknown): v is BoardPeriod {
  return typeof v === 'string' && (BOARD_PERIOD_IDS as string[]).includes(v);
}

/* ================================================================== */
/* 기간 · KPI                                                           */
/* ================================================================== */

export interface PeriodWindow {
  preset: BoardPeriod;
  label: string;
  from: string;
  to: string;
  days: number;
  prevFrom: string;
  prevTo: string;
  rangeText: string;
  prevText: string;
  includesToday: boolean;
}

function rangeText(from: string, to: string): string {
  return from === to ? fmtDate(from) : `${fmtDate(from, false)}–${fmtDate(to, false)}`;
}

export function periodWindow(d: Dataset, preset: BoardPeriod): PeriodWindow {
  const r = rangeOf(d, preset);
  const prev = previousRange(r);
  return {
    preset,
    label: r.label,
    from: r.from,
    to: r.to,
    days: daysBetween(r.from, r.to) + 1,
    prevFrom: prev.from,
    prevTo: prev.to,
    rangeText: rangeText(r.from, r.to),
    prevText: rangeText(prev.from, prev.to),
    includesToday: r.to >= d.today,
  };
}

export interface BoardKpis {
  win: PeriodWindow;
  cur: Totals;
  prev: Totals;
  sales: number;
  prevSales: number;
  adAttributed: number;
  prevAdAttributed: number;
  /** 광고비 대비 실매출 (배) = 판매 채널 실매출 ÷ 광고비 */
  mer: number;
  prevMer: number;
  /** 실매출 중 광고 경유 비중 (0~1) */
  adShareOfSales: number;
  deltas: { cost: number; revenue: number; roas: number; sales: number; mer: number; cpa: number; cvr: number; cac: number; conversions: number; newCustomers: number };
  hasData: boolean;
}

export function boardKpis(d: Dataset, preset: BoardPeriod): BoardKpis {
  const win = periodWindow(d, preset);
  const cur = totalsOf(mediaRows(d, win.from, win.to));
  const prev = totalsOf(mediaRows(d, win.prevFrom, win.prevTo));
  const sc = salesByChannel(d, win.from, win.to);
  const sp = salesByChannel(d, win.prevFrom, win.prevTo);
  const sales = sum(sc, (c) => c.revenue);
  const prevSales = sum(sp, (c) => c.revenue);
  const adAttributed = sum(sc, (c) => c.adAttributedRevenue);
  const prevAdAttributed = sum(sp, (c) => c.adAttributedRevenue);
  const mer = cur.cost > 0 ? sales / cur.cost : NaN;
  const prevMer = prev.cost > 0 ? prevSales / prev.cost : NaN;
  const pc = metrics.pctChange;
  return {
    win, cur, prev, sales, prevSales, adAttributed, prevAdAttributed, mer, prevMer,
    adShareOfSales: sales > 0 ? adAttributed / sales : NaN,
    deltas: {
      cost: pc(cur.cost, prev.cost),
      revenue: pc(cur.revenue, prev.revenue),
      roas: fin(cur.roas) && fin(prev.roas) ? pc(cur.roas, prev.roas) : NaN,
      sales: pc(sales, prevSales),
      mer: fin(mer) && fin(prevMer) ? pc(mer, prevMer) : NaN,
      cpa: fin(cur.cpa) && fin(prev.cpa) ? pc(cur.cpa, prev.cpa) : NaN,
      cvr: fin(cur.cvr) && fin(prev.cvr) ? pc(cur.cvr, prev.cvr) : NaN,
      cac: fin(cur.cac) && fin(prev.cac) ? pc(cur.cac, prev.cac) : NaN,
      conversions: pc(cur.conversions, prev.conversions),
      newCustomers: pc(cur.newCustomers, prev.newCustomers),
    },
    hasData: cur.cost > 0 || sales > 0,
  };
}

export interface KpiDay { date: string; cost: number; revenue: number; roas: number; sales: number; mer: number; cpa: number; cvr: number; cac: number }

/** KPI 스파크라인용 일자별 값 (추이 구간 = 최소 14일 · 오늘 제외) */
export function kpiDaily(d: Dataset, win: PeriodWindow): KpiDay[] {
  const tw = trendWindow(d, win);
  const sales = new Map<string, number>();
  for (const r of d.salesDaily) if (r.date >= tw.from && r.date <= tw.to) sales.set(r.date, (sales.get(r.date) ?? 0) + nz(r.revenue));
  const media = new Map<string, (typeof d.mediaDaily)[number][]>();
  for (const r of d.mediaDaily) {
    if (r.date < tw.from || r.date > tw.to) continue;
    const a = media.get(r.date);
    if (a) a.push(r); else media.set(r.date, [r]);
  }
  return d.dates.filter((x) => x >= tw.from && x <= tw.to).map((date) => {
    const t = totalsOf(media.get(date) ?? []);
    const s = sales.get(date) ?? 0;
    return { date, cost: t.cost, revenue: t.revenue, roas: t.roas, sales: s, mer: t.cost > 0 ? s / t.cost : NaN, cpa: t.cpa, cvr: t.cvr, cac: t.cac };
  });
}

/* ================================================================== */
/* 01 매체 통합 성과                                                     */
/* ================================================================== */

export interface Flag { level: Level; label: string; basis: string }
/** 변동 판정 심각도 (표 정렬용) — 높을수록 심각. DataTable 첫 클릭(내림차순)에 위험 → 주의 → 정상 → 판정 불가 순 */
export const FLAG_SEVERITY: Record<Level, number> = { danger: 3, warn: 2, ok: 1, na: 0 };

/** 직전 기간 대비 변동 판정 — p.47 이상 징후 기준(ROAS −20/−35 · CPA +30/+50 · 광고비 ±30/±50)을 기간 비교에 준용 */
export function changeFlag(cur: Pick<Totals, 'cost' | 'roas' | 'cpa'>, prev: Pick<Totals, 'cost' | 'roas' | 'cpa'>): Flag {
  if (!(nz(prev.cost) > 0)) return { level: 'na', label: '비교 불가', basis: '직전 기간 집행 없음' };
  if (!(nz(cur.cost) > 0)) return { level: 'na', label: '집행 없음', basis: '선택 기간 광고비 0' };
  const roasD = fin(cur.roas) && fin(prev.roas) ? metrics.pctChange(cur.roas, prev.roas) : NaN;
  const cpaD = fin(cur.cpa) && fin(prev.cpa) ? metrics.pctChange(cur.cpa, prev.cpa) : NaN;
  const costD = metrics.pctChange(cur.cost, prev.cost);
  const hits: { level: Level; text: string }[] = [];
  if (fin(roasD) && roasD <= -R.roasDropDangerPct) hits.push({ level: 'danger', text: `ROAS ${fmt.delta(roasD, 0)} (기준 −${R.roasDropDangerPct}%)` });
  else if (fin(roasD) && roasD <= -R.roasDropWarnPct) hits.push({ level: 'warn', text: `ROAS ${fmt.delta(roasD, 0)} (기준 −${R.roasDropWarnPct}%)` });
  if (fin(cpaD) && cpaD >= R.cpaRiseDangerPct) hits.push({ level: 'danger', text: `CPA ${fmt.delta(cpaD, 0)} (기준 +${R.cpaRiseDangerPct}%)` });
  else if (fin(cpaD) && cpaD >= R.cpaRiseWarnPct) hits.push({ level: 'warn', text: `CPA ${fmt.delta(cpaD, 0)} (기준 +${R.cpaRiseWarnPct}%)` });
  if (fin(costD) && Math.abs(costD) >= R.costSwingDangerPct) hits.push({ level: 'danger', text: `광고비 ${fmt.delta(costD, 0)} (기준 ±${R.costSwingDangerPct}%)` });
  else if (fin(costD) && Math.abs(costD) >= R.costSwingWarnPct) hits.push({ level: 'warn', text: `광고비 ${fmt.delta(costD, 0)} (기준 ±${R.costSwingWarnPct}%)` });
  if (!hits.length) {
    return { level: 'ok', label: '기준 내', basis: `ROAS −${R.roasDropWarnPct}% · CPA +${R.cpaRiseWarnPct}% · 광고비 ±${R.costSwingWarnPct}% 이내` };
  }
  const level: Level = hits.some((h) => h.level === 'danger') ? 'danger' : 'warn';
  return { level, label: level === 'danger' ? '점검 필요' : '주의', basis: hits.map((h) => h.text).join(' · ') };
}

export interface MediaRow {
  media: MediaId;
  name: string;
  short: string;
  role: string;
  judgeMetric: string;
  colorVar: string;
  cost: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
  newCustomers: number;
  roas: number;
  cpa: number;
  cvr: number;
  ctr: number;
  cac: number;
  /** 신규 고객 비중 = 신규 고객 ÷ 전환 */
  newShare: number;
  /** 광고비 비중 (0~1) */
  share: number;
  revenueShare: number;
  /** p.37 배분 가안 비중 (0~1) */
  planShare: number;
  /** 집행 비중 − 가안 비중 (pp) */
  planGapPp: number;
  prev: { cost: number; revenue: number; roas: number; cpa: number };
  deltas: { cost: number; revenue: number; roas: number; cpa: number };
  judge: { metric: string; value: string; note: string };
  flag: Flag;
}

export function mediaComparison(d: Dataset, win: PeriodWindow): MediaRow[] {
  const cur = byMedia(d, win.from, win.to);
  const prev = byMedia(d, win.prevFrom, win.prevTo);
  const totalRev = sum(cur, (r) => r.revenue);
  const ownMall = salesByChannel(d, win.from, win.to).find((c) => c.channel === 'own_mall')?.revenue ?? 0;
  return MEDIA_IDS.map((m, i) => {
    const c = cur[i];
    const p = prev[i];
    const meta = MEDIA[m];
    const newShare = c.conversions > 0 ? c.newCustomers / c.conversions : NaN;
    const judgeValue: Record<MediaId, string> = {
      naver_sa: `ROAS ${fmt.roas(c.roas)} · 매출 ${fmt.krw(c.revenue)}`,
      naver_gfa: `신규 CPA ${fmt.won(c.cac)}`,
      // 증분 매출은 홀드아웃 없이는 측정되지 않는다 — 자사몰 실매출 총액은 참고값(Google 귀속 아님)
      google: `증분 미측정 · 자사몰 실매출 ${fmt.krw(ownMall)}`,
      meta: `CPA ${fmt.won(c.cpa)} · 신규 ${fmt.ratio(newShare, 0)}`,
      kakao: `전환 ${fmt.dec1(c.conversions)} · CPA ${fmt.won(c.cpa)}`,
      vertical: `ROAS ${fmt.roas(c.roas)}`,
    };
    return {
      media: m, name: meta.name, short: meta.short, role: meta.role, judgeMetric: meta.judgeMetric, colorVar: meta.colorVar,
      cost: c.cost, revenue: c.revenue, conversions: c.conversions, clicks: c.clicks, impressions: c.impressions, newCustomers: c.newCustomers,
      roas: c.roas, cpa: c.cpa, cvr: c.cvr, ctr: c.ctr, cac: c.cac, newShare,
      share: c.share, revenueShare: totalRev > 0 ? c.revenue / totalRev : 0,
      planShare: meta.share, planGapPp: (c.share - meta.share) * 100,
      prev: { cost: p.cost, revenue: p.revenue, roas: p.roas, cpa: p.cpa },
      deltas: {
        cost: metrics.pctChange(c.cost, p.cost),
        revenue: metrics.pctChange(c.revenue, p.revenue),
        roas: fin(c.roas) && fin(p.roas) ? metrics.pctChange(c.roas, p.roas) : NaN,
        cpa: fin(c.cpa) && fin(p.cpa) ? metrics.pctChange(c.cpa, p.cpa) : NaN,
      },
      judge: { metric: meta.judgeMetric, value: judgeValue[m], note: MEDIA_JUDGE_NOTE[m] ?? '' },
      flag: changeFlag(c, p),
    };
  });
}

export type TrendMetric = 'cost' | 'revenue' | 'roas' | 'cpa' | 'conversions';
export const TREND_METRICS: { id: TrendMetric; label: string }[] = [
  { id: 'cost', label: '광고비' },
  { id: 'revenue', label: '광고 매출' },
  { id: 'roas', label: 'ROAS' },
  { id: 'cpa', label: 'CPA' },
  { id: 'conversions', label: '전환' },
];

export interface TrendSeries { id: string; label: string; colorVar: string; points: { x: string; y: number }[] }

/** 추이 표시 구간: 오늘(부분일)은 제외, 최소 14일 */
export function trendWindow(d: Dataset, win: PeriodWindow, minDays: number = R.trendMinDays) {
  const yesterday = addDays(d.today, -1);
  const to = win.to >= d.today ? yesterday : win.to;
  let from = win.from > to ? to : win.from;
  let extended = false;
  if (daysBetween(from, to) + 1 < minDays) {
    from = addDays(to, -(minDays - 1));
    extended = true;
  }
  return { from, to, extended, excludedToday: win.to >= d.today };
}

function metricOf(t: Totals, metric: TrendMetric): number {
  return metric === 'roas' ? t.roas : metric === 'cpa' ? t.cpa : t[metric];
}

/** 매체별 일자 추이 (total=true 면 선택 매체 합계 1개 시리즈) */
export function mediaTrend(d: Dataset, win: PeriodWindow, medias: MediaId[], metric: TrendMetric, total = false): { series: TrendSeries[]; from: string; to: string; extended: boolean; excludedToday: boolean } {
  const tw = trendWindow(d, win);
  const dates = d.dates.filter((x) => x >= tw.from && x <= tw.to);
  const byDate = new Map<string, Map<MediaId, (typeof d.mediaDaily)[number]>>();
  for (const r of d.mediaDaily) {
    if (r.date < tw.from || r.date > tw.to) continue;
    let m = byDate.get(r.date);
    if (!m) { m = new Map(); byDate.set(r.date, m); }
    m.set(r.media, r);
  }
  const rowsFor = (date: string, ms: MediaId[]) => ms.map((m) => byDate.get(date)?.get(m)).filter((x): x is NonNullable<typeof x> => !!x);
  // 합계 시리즈는 특정 매체 색을 쓰지 않는다 (색은 엔티티에 고정)
  const series: TrendSeries[] = total
    ? [{ id: 'total', label: medias.length === MEDIA_IDS.length ? '전체 매체 합계' : `선택 ${medias.length}개 매체 합계`, colorVar: '--ink-2', points: dates.map((x) => ({ x, y: metricOf(totalsOf(rowsFor(x, medias)), metric) })) }]
    : medias.map((m) => ({ id: m, label: MEDIA[m].short, colorVar: MEDIA[m].colorVar, points: dates.map((x) => ({ x, y: metricOf(totalsOf(rowsFor(x, [m])), metric) })) }));
  return { series, ...tw };
}

/* ================================================================== */
/* 02 키워드 성과 필터                                                   */
/* ================================================================== */

export type KeywordWindow = 7 | 14;
export type SignalId = 'soldout' | 'cpc_spike' | 'conv_drop' | 'opportunity' | 'new' | 'no_conv';
export interface Signal { id: SignalId; label: string; tone: 'critical' | 'serious' | 'warning' | 'good' | 'outline'; basis: string }

export const SIGNAL_LABEL: Record<SignalId, string> = {
  soldout: '랜딩 옵션 품절',
  cpc_spike: 'CPC 급변',
  conv_drop: '전환 급감',
  opportunity: '고효율 · 노출 손실',
  new: '신규 집행',
  no_conv: '전환 없음',
};

export interface Verdict { key: 'high' | 'met' | 'below' | 'noconv' | 'none'; label: string; tone: 'good' | 'neutral' | 'warning' | 'outline'; basis: string; sampleOk: boolean }

export interface LandingInfo {
  kind: 'product' | 'store' | 'guide' | 'event' | 'other';
  label: string;
  productId?: string;
  productName?: string;
  optionId?: string;
  optionLabel?: string;
  inStock?: boolean;
}

export interface KeywordRow {
  id: string;
  text: string;
  intent: IntentId;
  intentName: string;
  adgroup: string;
  status: Keyword['status'];
  isBrand: boolean;
  /** 제품군 (사이즈 옵션) */
  group: string;
  groupLabel: string;
  cur: KeywordStats;
  prev: KeywordStats;
  ctr: number;
  cpc: number;
  cvr: number;
  cpa: number;
  roas: number;
  prevRoas: number;
  costDelta: number;
  revenueDelta: number;
  convDelta: number;
  roasDelta: number;
  target: number;
  ratioPct: number;
  verdict: Verdict;
  daily: KeywordStats[];
  dailyDates: string[];
  lost: number;
  rank: number;
  bid: number;
  maxBid: number;
  monthlySearch: number;
  landing: string;
  landingInfo: LandingInfo;
  anomaly: { cpcDelta: number; convDelta: number; clicksRecent: number; expectedConvRecent: number };
  signals: Signal[];
  isNew: boolean;
}

const emptyStats = (): KeywordStats => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 });

export function aggStats(rows: readonly KeywordStats[]): KeywordStats {
  const s = emptyStats();
  for (const r of rows) {
    s.impressions += nz(r.impressions);
    s.clicks += nz(r.clicks);
    s.cost += nz(r.cost);
    s.conversions += nz(r.conversions);
    s.revenue += nz(r.revenue);
  }
  s.conversions = Math.round(s.conversions * 100) / 100;
  return s;
}

/** 키워드 일별 배열의 날짜 (마지막 원소 = 어제) */
export function keywordDates(d: Dataset, n = 14): string[] {
  const y = addDays(d.today, -1);
  return Array.from({ length: n }, (_, i) => addDays(y, -(n - 1 - i)));
}

/** 사이즈 옵션 라벨 → 제품군 키 */
const OPTION_ALIASES: Record<string, string[]> = { 슈퍼싱글: ['슈퍼싱글', 'SS'], 퀸: ['퀸'], 킹: ['킹'] };
function textHasOption(text: string, label: string): boolean {
  const aliases = OPTION_ALIASES[label] ?? [label];
  return aliases.some((a) => text.includes(a));
}

/** 키워드 → 제품군(사이즈). 상품 옵션 라벨 기준, 없으면 '사이즈 미지정' */
export function productGroupOf(text: string, products: readonly Product[]): { id: string; label: string } {
  const labels: string[] = [];
  for (const p of products) for (const o of p.options) if (!labels.includes(o.label)) labels.push(o.label);
  const hit = labels.find((l) => textHasOption(text, l));
  return hit ? { id: `size:${hit}`, label: hit } : { id: 'none', label: '사이즈 미지정' };
}

export function productGroups(products: readonly Product[]): { id: string; label: string; inStock: boolean | null }[] {
  const out: { id: string; label: string; inStock: boolean | null }[] = [];
  for (const p of products) {
    for (const o of p.options) {
      const id = `size:${o.label}`;
      const ex = out.find((g) => g.id === id);
      // 주력 상품(첫 상품) 옵션 재고를 제품군 재고로 본다
      if (!ex) out.push({ id, label: o.label, inStock: o.inStock });
    }
  }
  out.push({ id: 'none', label: '사이즈 미지정', inStock: null });
  return out;
}

/** 랜딩 URL → 표준 상품 키 (상품 상세면 상품 id · 옵션 id 매칭) */
export function landingInfo(k: Pick<Keyword, 'landing' | 'text'>, products: readonly Product[]): LandingInfo {
  const url = k.landing ?? '';
  const product = products.find((p) => url === p.landing || url.startsWith(`${p.landing}/`) || url.startsWith(`${p.landing}?`));
  if (product) {
    const option = product.options.find((o) => textHasOption(k.text, o.label));
    return {
      kind: 'product', label: '상품 상세', productId: product.id, productName: product.name,
      optionId: option?.id, optionLabel: option?.label, inStock: option ? option.inStock : undefined,
    };
  }
  if (/\/guide(\/|$|\?)/.test(url)) return { kind: 'guide', label: '선택 가이드' };
  if (/\/event(\/|$|\?)/.test(url)) return { kind: 'event', label: '기획전 · 자사몰' };
  if (/brand\.naver\.com\/[^/]+\/?$/.test(url)) return { kind: 'store', label: '브랜드스토어 메인' };
  return { kind: 'other', label: url ? 'URL' : '랜딩 없음' };
}

/** 최근 3일 vs 같은 창의 나머지 날 (CPC · 일평균 전환) */
export function keywordAnomaly(daily: readonly KeywordStats[], days: number = R.keywordAnomalyDays) {
  if (daily.length <= days) return { cpcDelta: NaN, convDelta: NaN, clicksRecent: sum(daily, (x) => nz(x.clicks)), expectedConvRecent: NaN };
  const recent = aggStats(daily.slice(-days));
  const base = aggStats(daily.slice(0, -days));
  const baseDays = daily.length - days;
  const cpcR = metrics.cpc(recent.cost, recent.clicks);
  const cpcB = metrics.cpc(base.cost, base.clicks);
  const convPerDayB = base.conversions / baseDays;
  const convPerDayR = recent.conversions / days;
  return {
    cpcDelta: fin(cpcR) && fin(cpcB) && cpcB > 0 ? metrics.pctChange(cpcR, cpcB) : NaN,
    convDelta: convPerDayB > 0 ? metrics.pctChange(convPerDayR, convPerDayB) : NaN,
    clicksRecent: recent.clicks,
    expectedConvRecent: convPerDayB * days,
  };
}

export function keywordVerdict(cur: KeywordStats, isBrand: boolean): Verdict & { target: number; ratioPct: number } {
  const target = isBrand ? R.brandTargetRoas : R.targetRoas;
  const roas = metrics.roas(cur.revenue, cur.cost);
  const ratioPct = fin(roas) ? (roas / target) * 100 : NaN;
  const base = { target, ratioPct };
  if (!(cur.cost > 0)) return { ...base, key: 'none', label: '집행 없음', tone: 'outline', basis: '선택 창 광고비 0', sampleOk: false };
  if (!(cur.conversions > 0)) return { ...base, key: 'noconv', label: '전환 없음', tone: 'warning', basis: `클릭 ${fmt.int(cur.clicks)} · 목표 ROAS ${target}%`, sampleOk: false };
  const sampleOk = cur.conversions >= R.minConversionsForVerdict;
  const key: Verdict['key'] = ratioPct >= R.highEfficiencyRatio * 100 ? 'high' : ratioPct >= 100 ? 'met' : 'below';
  const label = key === 'high' ? '고효율' : key === 'met' ? '목표 달성' : '목표 미달';
  const tone: Verdict['tone'] = !sampleOk ? 'outline' : key === 'high' ? 'good' : key === 'met' ? 'neutral' : 'warning';
  const basis = `${isBrand ? '브랜드 ' : ''}목표 ${target}% 대비 ${fmt.int(ratioPct)}%${sampleOk ? '' : ` · 전환 ${fmt.dec1(cur.conversions)}건 < ${R.minConversionsForVerdict}건 표본 부족`}`;
  return { ...base, key, label, tone, basis, sampleOk };
}

export function keywordRows(d: Dataset, window: KeywordWindow = 14): KeywordRow[] {
  const dates = keywordDates(d, 14);
  return (d.keywords ?? []).map((k) => {
    const daily = k.daily ?? [];
    const cur = window === 14 ? { ...k.last14 } : aggStats(daily.slice(-7));
    const prev = window === 14 ? { ...k.prev14 } : aggStats(daily.slice(-14, -7));
    const roas = metrics.roas(cur.revenue, cur.cost);
    const prevRoas = metrics.roas(prev.revenue, prev.cost);
    const v = keywordVerdict(cur, k.isBrand);
    const li = landingInfo(k, d.products ?? []);
    const grp = productGroupOf(k.text, d.products ?? []);
    const an = keywordAnomaly(daily);
    const isNew = !(prev.impressions > 0) && cur.impressions > 0;
    const signals: Signal[] = [];
    if (li.kind === 'product' && li.optionLabel && li.inStock === false) {
      signals.push({ id: 'soldout', label: SIGNAL_LABEL.soldout, tone: 'critical', basis: `${li.productName ?? '상품'} ${li.optionLabel} 옵션 품절 · 랜딩 상품 상세` });
    }
    if (fin(an.cpcDelta) && an.clicksRecent >= R.keywordAnomalyMinClicks && Math.abs(an.cpcDelta) >= R.keywordAnomalyPct) {
      signals.push({ id: 'cpc_spike', label: SIGNAL_LABEL.cpc_spike, tone: 'serious', basis: `최근 ${R.keywordAnomalyDays}일 CPC ${fmt.delta(an.cpcDelta, 0)} (기준 ±${R.keywordAnomalyPct}% · 클릭 ${fmt.int(an.clicksRecent)})` });
    }
    if (fin(an.convDelta) && an.expectedConvRecent >= R.keywordAnomalyMinExpectedConv && an.convDelta <= -R.keywordAnomalyPct) {
      signals.push({ id: 'conv_drop', label: SIGNAL_LABEL.conv_drop, tone: 'serious', basis: `최근 ${R.keywordAnomalyDays}일 일평균 전환 ${fmt.delta(an.convDelta, 0)} (기준 −${R.keywordAnomalyPct}%)` });
    }
    if (fin(v.ratioPct) && v.ratioPct >= R.highEfficiencyRatio * 100 && nz(k.impressionShareLost) >= R.lostShareTrigger) {
      signals.push({ id: 'opportunity', label: SIGNAL_LABEL.opportunity, tone: 'good', basis: `목표 대비 ${fmt.int(v.ratioPct)}% (기준 ${Math.round(R.highEfficiencyRatio * 100)}%) · 노출 손실 ${fmt.ratio(k.impressionShareLost, 0)} (기준 ${fmt.ratio(R.lostShareTrigger, 0)}) · 전환 ${fmt.dec1(cur.conversions)}건` });
    }
    if (isNew) signals.push({ id: 'new', label: SIGNAL_LABEL.new, tone: 'outline', basis: '직전 창 노출 0 · 비교 기준 없음' });
    if (cur.clicks >= R.keywordNoConvMinClicks && !(cur.conversions > 0)) {
      signals.push({ id: 'no_conv', label: SIGNAL_LABEL.no_conv, tone: 'warning', basis: `클릭 ${fmt.int(cur.clicks)} (기준 ${R.keywordNoConvMinClicks}회 이상) · 전환 0` });
    }
    return {
      id: k.id, text: k.text, intent: k.intent, intentName: SA_CAMPAIGNS[k.intent]?.name ?? k.intent, adgroup: k.adgroup, status: k.status, isBrand: k.isBrand,
      group: grp.id, groupLabel: grp.label,
      cur, prev,
      ctr: metrics.ctr(cur.clicks, cur.impressions), cpc: metrics.cpc(cur.cost, cur.clicks), cvr: metrics.cvr(cur.conversions, cur.clicks),
      cpa: metrics.cpa(cur.cost, cur.conversions), roas, prevRoas,
      costDelta: isNew ? NaN : metrics.pctChange(cur.cost, prev.cost),
      revenueDelta: isNew ? NaN : metrics.pctChange(cur.revenue, prev.revenue),
      convDelta: isNew ? NaN : metrics.pctChange(cur.conversions, prev.conversions),
      roasDelta: fin(roas) && fin(prevRoas) ? metrics.pctChange(roas, prevRoas) : NaN,
      target: v.target, ratioPct: v.ratioPct, verdict: v,
      daily, dailyDates: dates.slice(-daily.length || undefined),
      lost: nz(k.impressionShareLost), rank: k.avgRank, bid: k.bid, maxBid: k.maxBid, monthlySearch: k.monthlySearch,
      landing: k.landing, landingInfo: li, anomaly: an, signals, isNew,
    };
  });
}

/** 키워드 보고서 합계 ↔ 같은 기간 네이버 SA 매체 집계 (범위가 다르다는 사실을 화면에 그대로 표기) */
export function keywordScope(d: Dataset, window: KeywordWindow = 14) {
  const dates = keywordDates(d, window);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const keywordCost = sum(keywordRows(d, window), (r) => r.cur.cost);
  const saMediaCost = totalsOf(mediaRows(d, from, to, 'naver_sa')).cost;
  return { from, to, keywordCost, saMediaCost, keywords: (d.keywords ?? []).length };
}

export interface KeywordFilter {
  intents?: IntentId[];
  status?: 'all' | 'on' | 'test' | 'off';
  query?: string;
  group?: string;
  signal?: 'all' | SignalId | 'any';
  verdict?: 'all' | Verdict['key'];
}

export function filterKeywords(rows: readonly KeywordRow[], f: KeywordFilter = {}): KeywordRow[] {
  const q = (f.query ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return rows.filter((r) => {
    if (f.intents && f.intents.length && !f.intents.includes(r.intent)) return false;
    if (f.status && f.status !== 'all' && r.status !== f.status) return false;
    if (f.group && f.group !== 'all' && r.group !== f.group) return false;
    if (f.signal && f.signal !== 'all') {
      if (f.signal === 'any' ? r.signals.length === 0 : !r.signals.some((s) => s.id === f.signal)) return false;
    }
    if (f.verdict && f.verdict !== 'all' && r.verdict.key !== f.verdict) return false;
    if (q) {
      const hay = `${r.text} ${r.adgroup} ${r.intentName}`.toLowerCase().replace(/\s+/g, '');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export type KeywordSort = 'cost' | 'revenue' | 'roas' | 'conversions' | 'costDelta' | 'ratio' | 'lost';
export function sortKeywords(rows: readonly KeywordRow[], by: KeywordSort = 'cost'): KeywordRow[] {
  const key = (r: KeywordRow) => ({ cost: r.cur.cost, revenue: r.cur.revenue, roas: r.roas, conversions: r.cur.conversions, costDelta: r.costDelta, ratio: r.ratioPct, lost: r.lost }[by]);
  return [...rows].sort((a, b) => {
    const va = key(a), vb = key(b);
    if (fin(va) !== fin(vb)) return fin(va) ? -1 : 1;
    return nz(vb) - nz(va);
  });
}

export interface StatsSummary {
  count: number;
  cur: KeywordStats;
  prev: KeywordStats;
  roas: number;
  prevRoas: number;
  cpa: number;
  cvr: number;
  costDelta: number;
  revenueDelta: number;
  convDelta: number;
  roasDelta: number;
}

export function keywordSummary(rows: readonly KeywordRow[]): StatsSummary {
  const cur = aggStats(rows.map((r) => r.cur));
  const prev = aggStats(rows.map((r) => r.prev));
  const roas = metrics.roas(cur.revenue, cur.cost);
  const prevRoas = metrics.roas(prev.revenue, prev.cost);
  return {
    count: rows.length, cur, prev, roas, prevRoas,
    cpa: metrics.cpa(cur.cost, cur.conversions), cvr: metrics.cvr(cur.conversions, cur.clicks),
    costDelta: metrics.pctChange(cur.cost, prev.cost), revenueDelta: metrics.pctChange(cur.revenue, prev.revenue),
    convDelta: metrics.pctChange(cur.conversions, prev.conversions),
    roasDelta: fin(roas) && fin(prevRoas) ? metrics.pctChange(roas, prevRoas) : NaN,
  };
}

export interface Rollup extends StatsSummary { id: string; label: string; costShare: number; inStock?: boolean | null; signals: number }

/** p.13 "구매 의도 · 제품군별 키워드 묶음 조회" */
export function intentRollup(rows: readonly KeywordRow[]): Rollup[] {
  const total = sum(rows, (r) => r.cur.cost);
  return INTENT_IDS.map((i) => {
    const rs = rows.filter((r) => r.intent === i);
    const s = keywordSummary(rs);
    return { ...s, id: i, label: SA_CAMPAIGNS[i].name, costShare: total > 0 ? s.cur.cost / total : 0, signals: sum(rs, (r) => r.signals.filter((x) => x.id !== 'new').length) };
  }).filter((r) => r.count > 0);
}

export function groupRollup(rows: readonly KeywordRow[], products: readonly Product[]): Rollup[] {
  const total = sum(rows, (r) => r.cur.cost);
  return productGroups(products).map((g) => {
    const rs = rows.filter((r) => r.group === g.id);
    const s = keywordSummary(rs);
    return { ...s, id: g.id, label: g.label, costShare: total > 0 ? s.cur.cost / total : 0, inStock: g.inStock, signals: sum(rs, (r) => r.signals.filter((x) => x.id !== 'new').length) };
  }).filter((r) => r.count > 0);
}

/** CSV 내보내기 — 엑셀 한글 BOM 포함 (src/core/download.toCsv) */
export function keywordCsv(rows: readonly KeywordRow[], window: KeywordWindow = 14): string {
  const cols = [
    { key: 'text', label: '키워드' }, { key: 'intent', label: '구매 의도' }, { key: 'adgroup', label: '광고그룹' }, { key: 'status', label: '상태' },
    { key: 'group', label: '제품군' }, { key: 'impressions', label: `노출(${window}일)` }, { key: 'clicks', label: '클릭' }, { key: 'cost', label: '광고비(원)' },
    { key: 'conversions', label: '전환' }, { key: 'revenue', label: '매출(원)' }, { key: 'roas', label: 'ROAS(%)' }, { key: 'target', label: '목표 ROAS(%)' },
    { key: 'ratio', label: '목표 대비(%)' }, { key: 'verdict', label: '판정' }, { key: 'cpa', label: 'CPA(원)' }, { key: 'cvr', label: 'CVR(%)' },
    { key: 'ctr', label: 'CTR(%)' }, { key: 'cpc', label: 'CPC(원)' }, { key: 'prevCost', label: '직전 광고비(원)' }, { key: 'prevConv', label: '직전 전환' },
    { key: 'prevRoas', label: '직전 ROAS(%)' }, { key: 'costDelta', label: '광고비 증감(%)' }, { key: 'convDelta', label: '전환 증감(%)' },
    { key: 'lost', label: '노출 기회 손실(%)' }, { key: 'rank', label: '평균 순위' }, { key: 'search', label: '월간 검색량' }, { key: 'bid', label: '입찰가(원)' },
    { key: 'landing', label: '랜딩' }, { key: 'signals', label: '신호' }, { key: 'source', label: '출처' },
  ];
  // 필터 결과 0행이어도 머리글만 있는 CSV를 만든다 (빈 문자열이면 아티팩트 저장이 bad_request로 거절되어 아무 반응이 없다)
  if (!rows.length) return toCsv([Object.fromEntries(cols.map((c) => [c.key, '']))], cols).split('\n')[0];
  const blank = (v: number | null) => (v === null ? '' : v);
  const data = rows.map((r) => ({
    text: r.text, intent: r.intentName, adgroup: r.adgroup, status: r.status, group: r.groupLabel,
    impressions: r.cur.impressions, clicks: r.cur.clicks, cost: Math.round(r.cur.cost), conversions: blank(r2(r.cur.conversions)), revenue: Math.round(r.cur.revenue),
    roas: blank(r0(r.roas)), target: r.target, ratio: blank(r0(r.ratioPct)), verdict: `${r.verdict.label} (${r.verdict.basis})`,
    cpa: blank(r0(r.cpa)), cvr: blank(r2(r.cvr)), ctr: blank(r2(r.ctr)), cpc: blank(r0(r.cpc)),
    prevCost: Math.round(r.prev.cost), prevConv: blank(r2(r.prev.conversions)), prevRoas: blank(r0(r.prevRoas)),
    costDelta: blank(r1(r.costDelta)), convDelta: blank(r1(r.convDelta)), lost: blank(r1(r.lost * 100)), rank: r.rank, search: r.monthlySearch, bid: r.bid,
    landing: `${r.landingInfo.label} ${r.landing}`, signals: r.signals.map((s) => `${s.label}: ${s.basis}`).join(' / '), source: 'TEST DATA (시연용)',
  }));
  return toCsv(data, cols);
}

/* ================================================================== */
/* 03 예산 소진 현황                                                     */
/* ================================================================== */

const curveCache = new WeakMap<Dataset, Map<string, number[]>>();

/** 매체의 최근 N일(오늘 제외) 시간대별 누적 광고비 비중 (h시 종료 시점까지) — 데이터 없으면 균등 */
export function hourlyCostCurve(d: Dataset, media: MediaId, days: number = R.curveDays): number[] {
  let byData = curveCache.get(d);
  if (!byData) { byData = new Map(); curveCache.set(d, byData); }
  const key = `${media}:${days}`;
  const hit = byData.get(key);
  if (hit) return hit;
  const from = addDays(d.today, -days);
  const byH = new Array<number>(24).fill(0);
  let tot = 0;
  for (const r of d.mediaHourly ?? []) {
    if (r.media !== media || r.date >= d.today || r.date < from || r.hour < 0 || r.hour > 23) continue;
    byH[r.hour] += nz(r.cost);
    tot += nz(r.cost);
  }
  let acc = 0;
  const cum = tot > 0 ? byH.map((v) => (acc += v) / tot) : byH.map((_, h) => (h + 1) / 24);
  byData.set(key, cum);
  return cum;
}

/** 누적 곡선 × 소진 배수 → 예산 도달 시각 (소수 시간). 배수 ≤ 1 이면 당일 도달 없음 */
export function curveExhaustHour(cum: readonly number[], ratio: number): number | null {
  if (!fin(ratio) || ratio <= 1) return null;
  const need = 1 / ratio;
  for (let h = 0; h < 24; h++) {
    if (cum[h] >= need) {
      const prev = h > 0 ? cum[h - 1] : 0;
      const frac = cum[h] - prev > 0 ? (need - prev) / (cum[h] - prev) : 1;
      return h + clamp(frac, 0, 1);
    }
  }
  return null;
}

export interface CampaignPaceRow {
  id: string;
  name: string;
  media: MediaId;
  status: 'on' | 'off' | 'limited';
  dailyBudget: number;
  spentToday: number;
  hourOfData: number;
  pacePct: number;
  /** 시간대 곡선상 지금까지 기대 소진율 (%) */
  expectedPct: number;
  /** 오늘 예상 수요 ÷ 일 예산 */
  projectedRatio: number;
  projectedSpend: number;
  /** 예산 부족 예상액 (예상 수요 − 일 예산, 0 이상) */
  shortfall: number;
  linearExhaustHour: number | null;
  linearEarly: boolean;
  curveExhaustHour: number | null;
  /** 판정에 쓴 예상 마감 시각: 시간대 가중이 23시 전이면 그 값, 아니면 선형이 23시 전이면 선형, 둘 다 아니면 시간대 가중 */
  exhaustHour: number | null;
  exhaustMethod: '시간대 가중' | '선형' | null;
  earlyExhaust: boolean;
  missesPeak: boolean;
  level: 'critical' | 'warning' | 'ok' | 'off';
  label: string;
  basis: string;
}

export function campaignPaceRows(d: Dataset): CampaignPaceRow[] {
  const list = d.campaigns ?? [];
  if (!list.length) return [];
  const linear = campaignPacing(d);
  return list.map((c, i) => {
    const lin = linear[i];
    const cum = hourlyCostCurve(d, c.media);
    const hour = clamp(Math.round(nz(c.hourOfData)), 0, 23);
    const cumNow = cum[hour];
    const budget = nz(c.dailyBudget);
    const spent = nz(c.spentToday);
    const ratio = budget > 0 && cumNow > 0 ? spent / (budget * cumNow) : NaN;
    const off = c.status === 'off';
    const curveHour = off ? null : curveExhaustHour(cum, ratio);
    const linHour = lin && fin(lin.exhaustHour as number) && budget > 0 ? (lin.exhaustHour as number) : null;
    const linearEarly = !off && budget > 0 && !!lin?.earlyExhaust;
    const curveEarly = curveHour !== null && curveHour < R.exhaustBeforeHour;
    // 판정 시각과 표시 시각을 일치시킨다 (시간대 가중이 23시 이후인데 선형만 조기면 선형 시각을 쓴다)
    const exhaust = curveEarly ? curveHour : linearEarly ? linHour : curveHour;
    const exhaustMethod: CampaignPaceRow['exhaustMethod'] = exhaust === null ? null : curveEarly || !linearEarly ? '시간대 가중' : '선형';
    const earlyExhaust = linearEarly || curveEarly;
    const missesPeak = earlyExhaust && exhaust !== null && exhaust < R.peakStartHour;
    // 선형 추정만 조기인 경우 예상 수요도 선형 기준(23시 마감 시점 환산)으로 본다
    const linRatio = linHour !== null && linHour > 0 ? 24 / linHour : NaN;
    const demandRatio = exhaustMethod === '선형' && fin(linRatio) ? linRatio : ratio;
    const projectedSpend = fin(demandRatio) ? budget * demandRatio : spent;
    const pacePct = budget > 0 ? (spent / budget) * 100 : NaN;
    const via = exhaustMethod === '선형' ? ' · 선형 추정' : '';
    let level: CampaignPaceRow['level'] = 'ok';
    let label = '정상';
    let basis = `소진 ${fmt.pct(pacePct, 0)} · 시간대 기대 ${fmt.pct(cumNow * 100, 0)} · 예상 수요 ${fmt.ratio(ratio, 0)}`;
    if (off) { level = 'off'; label = '중지'; basis = '캠페인 상태 OFF'; }
    else if (!(budget > 0)) { level = 'ok'; label = '예산 미설정'; basis = '일 예산 0'; }
    else if (missesPeak) { level = 'critical'; label = '피크 전 소진'; basis = `예상 마감 ${clock(exhaust)}${via} · ${R.peakStartHour}~23시 피크 전 (기준 ${R.exhaustBeforeHour}시 전 마감)`; }
    else if (earlyExhaust) { level = 'warning'; label = '조기 소진 예상'; basis = `예상 마감 ${clock(exhaust)}${via} (기준 ${R.exhaustBeforeHour}시 전 마감)`; }
    return {
      id: c.id, name: c.name, media: c.media, status: c.status, dailyBudget: budget, spentToday: spent, hourOfData: hour,
      pacePct, expectedPct: cumNow * 100, projectedRatio: demandRatio, projectedSpend, shortfall: Math.max(0, projectedSpend - budget),
      linearExhaustHour: linHour, linearEarly, curveExhaustHour: curveHour, exhaustHour: off || !(budget > 0) ? null : exhaust, exhaustMethod: off || !(budget > 0) ? null : exhaustMethod,
      earlyExhaust, missesPeak, level, label, basis,
    };
  });
}

export interface MonthPaceRow {
  media: MediaId;
  name: string;
  colorVar: string;
  budget: number;
  spent: number;
  projected: number;
  pacePct: number;
  expectedPct: number;
  projectedPct: number;
  status: 'over' | 'under' | 'ok';
  statusLabel: string;
  basis: string;
  /** 월 예산 도달일 (실측: 누적 소진이 예산을 넘은 날) */
  reachedDate: string | null;
  /** 아직 미도달 시 현재 속도 기준 예상 도달일 (월 내) */
  projectedReachDate: string | null;
  next: { month: string; budget: number; days: number; runRate7: number; projectedPct: number; recommendedDaily: number; adjustPct: number };
}

function statusText(status: 'over' | 'under' | 'ok', projectedPct: number) {
  const over = Math.round(R.monthOverRatio * 100);
  const under = Math.round(R.monthUnderRatio * 100);
  if (status === 'over') return { statusLabel: '초과 예상', basis: `예상 월말 ${fmt.pct(projectedPct, 0)} (기준 ${over}% 초과)` };
  if (status === 'under') return { statusLabel: '미달 예상', basis: `예상 월말 ${fmt.pct(projectedPct, 0)} (기준 ${under}% 미만)` };
  return { statusLabel: '허용 범위', basis: `예상 월말 ${fmt.pct(projectedPct, 0)} (허용 ${under}~${over}%)` };
}

export function monthPaceRows(d: Dataset): MonthPaceRow[] {
  const mk = monthKey(d.today);
  const first = `${mk}-01`;
  const dim = daysInMonth(d.today);
  const nextFirst = addDays(first, dim);
  const nextDays = daysInMonth(nextFirst);
  const y = addDays(d.today, -1);
  const w7from = addDays(y, -6);
  return monthlyPacing(d).map((p) => {
    const rows = d.mediaDaily.filter((r) => r.media === p.media && monthKey(r.date) === mk).sort((a, b) => (a.date < b.date ? -1 : 1));
    let acc = 0;
    let reachedDate: string | null = null;
    for (const r of rows) {
      acc += nz(r.cost);
      if (p.budget > 0 && acc >= p.budget) { reachedDate = r.date; break; }
    }
    let projectedReachDate: string | null = null;
    if (!reachedDate && p.exhaustDay !== null && p.exhaustDay <= dim) projectedReachDate = `${mk}-${String(Math.max(1, p.exhaustDay)).padStart(2, '0')}`;
    const projectedPct = p.budget > 0 ? (p.projected / p.budget) * 100 : NaN;
    const st = statusText(p.status, projectedPct);
    const run7 = sum(mediaRows(d, w7from, y, p.media), (r) => r.cost) / 7;
    const nextBudget = MEDIA[p.media].annualBudget / 12;
    const recommendedDaily = nextBudget / nextDays;
    return {
      media: p.media, name: MEDIA[p.media].name, colorVar: MEDIA[p.media].colorVar,
      budget: p.budget, spent: p.spent, projected: p.projected, pacePct: p.pacePct, expectedPct: p.expectedPct, projectedPct,
      status: p.status, ...st, reachedDate, projectedReachDate,
      next: {
        month: monthKey(nextFirst), budget: nextBudget, days: nextDays, runRate7: run7,
        projectedPct: nextBudget > 0 ? ((run7 * nextDays) / nextBudget) * 100 : NaN,
        recommendedDaily, adjustPct: run7 > 0 ? metrics.pctChange(recommendedDaily, run7) : NaN,
      },
    };
  });
}

export interface BudgetPacing {
  month: { key: string; budget: number; spent: number; projected: number; pacePct: number; expectedPct: number; projectedPct: number; status: 'over' | 'under' | 'ok'; statusLabel: string; basis: string; isLastDay: boolean; daysLeft: number };
  media: MonthPaceRow[];
  campaigns: CampaignPaceRow[];
  early: CampaignPaceRow[];
  warnings: string[];
}

export function budgetPacing(d: Dataset): BudgetPacing {
  const media = monthPaceRows(d);
  const campaigns = campaignPaceRows(d);
  const budget = sum(media, (m) => m.budget);
  const spent = sum(media, (m) => m.spent);
  const projected = sum(media, (m) => m.projected);
  const projectedPct = budget > 0 ? (projected / budget) * 100 : NaN;
  const status: 'over' | 'under' | 'ok' = projected > budget * R.monthOverRatio ? 'over' : projected < budget * R.monthUnderRatio ? 'under' : 'ok';
  const dim = daysInMonth(d.today);
  const dom = Number(d.today.slice(8, 10));
  const early = campaigns.filter((c) => c.earlyExhaust).sort((a, b) => (a.exhaustHour ?? 99) - (b.exhaustHour ?? 99));
  const warnings: string[] = [];
  for (const c of early) warnings.push(`${c.name} ${c.label} · ${c.basis}`);
  for (const m of media) if (m.status !== 'ok') warnings.push(`${m.name} 월 예산 ${m.statusLabel} · ${m.basis}`);
  return {
    month: {
      key: monthKey(d.today), budget, spent, projected,
      pacePct: budget > 0 ? (spent / budget) * 100 : NaN,
      expectedPct: media[0]?.expectedPct ?? NaN,
      projectedPct, status, ...statusText(status, projectedPct),
      isLastDay: dom === dim, daysLeft: dim - dom,
    },
    media, campaigns, early, warnings,
  };
}

/* ================================================================== */
/* 판매 채널 실매출                                                      */
/* ================================================================== */

export interface ChannelRow {
  channel: SalesChannelId;
  name: string;
  colorVar: string;
  revenue: number;
  orders: number;
  visitors: number;
  detailViews: number;
  carts: number;
  cvr: number;
  aov: number;
  adAttributedRevenue: number;
  adShare: number;
  share: number;
  prevRevenue: number;
  revenueDelta: number;
  ordersDelta: number;
  cvrDelta: number;
  detailRate: number;
  cartRate: number;
}

export function channelRows(d: Dataset, win: PeriodWindow): ChannelRow[] {
  const cur = salesByChannel(d, win.from, win.to);
  const prev = salesByChannel(d, win.prevFrom, win.prevTo);
  const total = sum(cur, (c) => c.revenue);
  return SALES_CHANNEL_IDS.map((ch, i) => {
    const c = cur[i];
    const p = prev[i];
    return {
      channel: ch, name: SALES_CHANNELS[ch].name, colorVar: SALES_CHANNELS[ch].colorVar,
      revenue: c.revenue, orders: c.orders, visitors: c.visitors, detailViews: c.detailViews, carts: c.carts,
      cvr: c.cvr, aov: c.aov, adAttributedRevenue: c.adAttributedRevenue,
      adShare: c.revenue > 0 ? c.adAttributedRevenue / c.revenue : NaN,
      share: total > 0 ? c.revenue / total : 0,
      prevRevenue: p.revenue,
      revenueDelta: metrics.pctChange(c.revenue, p.revenue),
      ordersDelta: metrics.pctChange(c.orders, p.orders),
      cvrDelta: fin(c.cvr) && fin(p.cvr) ? metrics.pctChange(c.cvr, p.cvr) : NaN,
      detailRate: c.visitors > 0 ? (c.detailViews / c.visitors) * 100 : NaN,
      cartRate: c.detailViews > 0 ? (c.carts / c.detailViews) * 100 : NaN,
    };
  });
}

export interface Reconciliation {
  sales: number;
  adCost: number;
  mediaRevenue: number;
  channelAdRevenue: number;
  organicRevenue: number;
  organicShare: number;
  gapPct: number;
  within: boolean;
  mer: number;
  basis: string;
}

/** 매체가 보고한 광고 매출 ↔ 판매 채널 광고 경유 추정 매출 대조 (p.12 "광고비와 실제 매출을 한 화면에서 연결") */
export function reconciliation(d: Dataset, win: PeriodWindow): Reconciliation {
  const t = totalsOf(mediaRows(d, win.from, win.to));
  const ch = salesByChannel(d, win.from, win.to);
  const sales = sum(ch, (c) => c.revenue);
  const channelAdRevenue = sum(ch, (c) => c.adAttributedRevenue);
  const gapPct = channelAdRevenue > 0 ? metrics.pctChange(t.revenue, channelAdRevenue) : NaN;
  const within = fin(gapPct) && Math.abs(gapPct) <= R.reconTolerancePct;
  return {
    sales, adCost: t.cost, mediaRevenue: t.revenue, channelAdRevenue,
    organicRevenue: Math.max(0, sales - channelAdRevenue), organicShare: sales > 0 ? Math.max(0, sales - channelAdRevenue) / sales : NaN,
    gapPct, within, mer: t.cost > 0 ? sales / t.cost : NaN,
    basis: fin(gapPct) ? `채널 광고 경유 추정 대비 ${fmt.delta(gapPct)} (허용 ±${R.reconTolerancePct}%)` : '비교 데이터 없음',
  };
}

export function channelTrend(d: Dataset, win: PeriodWindow): { series: TrendSeries[]; from: string; to: string; extended: boolean; excludedToday: boolean } {
  const tw = trendWindow(d, win);
  const dates = d.dates.filter((x) => x >= tw.from && x <= tw.to);
  const idx = new Map<string, number>();
  for (const r of d.salesDaily) {
    if (r.date < tw.from || r.date > tw.to) continue;
    idx.set(`${r.date}:${r.channel}`, nz(r.revenue));
  }
  const series = SALES_CHANNEL_IDS.map((c) => ({
    id: c, label: SALES_CHANNELS[c].name, colorVar: SALES_CHANNELS[c].colorVar,
    points: dates.map((x) => ({ x, y: idx.get(`${x}:${c}`) ?? NaN })),
  }));
  return { series, ...tw };
}

/* ================================================================== */
/* 시간대 × 요일 히트맵                                                  */
/* ================================================================== */

export type HeatMetric = 'cost' | 'conversions' | 'roas';
/** 월~일 순서 (weekday index) */
export const HEAT_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface HeatmapResult {
  rows: string[];
  cols: string[];
  values: number[][];
  from: string;
  to: string;
  days: number;
  top: { weekday: number; label: string; hour: number; value: number; r: number; c: number }[];
  /** 시간대별 전환 비중 ÷ 광고비 비중 (1 초과 = 광고비 대비 전환 효율 높음) */
  hourEfficiency: { hour: number; costShare: number; convShare: number; index: number }[];
  hasData: boolean;
}

export function hourWeekHeatmap(d: Dataset, metric: HeatMetric, media: MediaId | 'all' = 'all', days: number = R.heatmapDays): HeatmapResult {
  const to = addDays(d.today, -1);
  const from = addDays(d.today, -days);
  const cost = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const conv = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const rev = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const dayCount = new Array<number>(7).fill(0);
  const seen = new Set<string>();
  for (const r of d.mediaHourly ?? []) {
    if (r.date < from || r.date > to || r.hour < 0 || r.hour > 23) continue;
    if (media !== 'all' && r.media !== media) continue;
    const wd = fin(r.weekday) ? r.weekday : weekday(r.date);
    cost[wd][r.hour] += nz(r.cost);
    conv[wd][r.hour] += nz(r.conversions);
    rev[wd][r.hour] += nz(r.revenue);
    if (!seen.has(r.date)) { seen.add(r.date); dayCount[wd] += 1; }
  }
  const values = HEAT_WEEK_ORDER.map((wd) => Array.from({ length: 24 }, (_, h) => {
    const n = dayCount[wd];
    if (!n) return NaN;
    if (metric === 'roas') return cost[wd][h] > 0 ? (rev[wd][h] / cost[wd][h]) * 100 : NaN;
    return (metric === 'cost' ? cost[wd][h] : conv[wd][h]) / n;
  }));
  const cells: HeatmapResult['top'] = [];
  values.forEach((row, ri) => row.forEach((v, h) => {
    if (fin(v)) cells.push({ weekday: HEAT_WEEK_ORDER[ri], label: `${WEEKDAY_KO[HEAT_WEEK_ORDER[ri]]} ${h}시`, hour: h, value: v, r: ri, c: h });
  }));
  cells.sort((a, b) => b.value - a.value);
  const costH = Array.from({ length: 24 }, (_, h) => sum(cost, (row) => row[h]));
  const convH = Array.from({ length: 24 }, (_, h) => sum(conv, (row) => row[h]));
  const ct = sum(costH, (x) => x);
  const vt = sum(convH, (x) => x);
  return {
    rows: HEAT_WEEK_ORDER.map((wd) => WEEKDAY_KO[wd]),
    cols: Array.from({ length: 24 }, (_, h) => String(h)),
    values, from, to, days: seen.size,
    top: cells.slice(0, 3),
    hourEfficiency: costH.map((c, h) => {
      const cs = ct > 0 ? c / ct : NaN;
      const vs = vt > 0 ? convH[h] / vt : NaN;
      return { hour: h, costShare: cs, convShare: vs, index: fin(cs) && cs > 0 && fin(vs) ? vs / cs : NaN };
    }),
    hasData: seen.size > 0,
  };
}

/* ================================================================== */
/* 데이터 수집 · 검증 · 표준화 (p.12)                                    */
/* ================================================================== */

export interface SourceStatus {
  id: string;
  group: 'media' | 'sales' | 'external';
  name: string;
  method: string;
  lastDate: string | null;
  lastHour: number | null;
  days: number;
  missingDays: number;
  rows: number;
  inDataset: boolean;
  account?: { name: string; status: AdAccount['status']; autoCharge: AdAccount['autoCharge']; balance: number; avgDailySpend: number; label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; issues: string[] };
  state: 'ok' | 'warn' | 'snapshot';
  note: string;
  route?: string;
}

/**
 * 계정 · 결제 · 권한 점검 (p.44 계정 · 결제 기준 · p.50 접근 권한 = 담당자 실명 계정).
 * 해당하는 항목을 모두 모아 보여주고, 가장 높은 등급을 배지 톤으로 쓴다.
 */
export function accountInfo(a: AdAccount | undefined): SourceStatus['account'] {
  if (!a) return undefined;
  const runway = a.balance >= 0 && a.avgDailySpend > 0 ? a.balance / a.avgDailySpend : Infinity;
  const issues: { text: string; tone: 'warning' | 'critical' }[] = [];
  if (a.status === 'restricted') issues.push({ text: '계정 제재', tone: 'critical' });
  if (a.autoCharge === 'failed') {
    issues.push(fin(runway) && runway < 1 ? { text: `자동충전 실패 · 잔액 ${fmt.dec1(runway)}일치`, tone: 'critical' } : { text: '자동충전 실패', tone: 'warning' });
  } else if (fin(runway) && runway < 1) {
    issues.push({ text: `잔액 ${fmt.dec1(runway)}일치`, tone: 'warning' });
  }
  if (a.status === 'review') issues.push({ text: '검수 · 확인 필요', tone: 'warning' });
  const nonReal = (a.permissions ?? []).filter((p) => !p.realName);
  if (nonReal.length) issues.push({ text: `비실명 권한 ${nonReal.map((p) => `${p.user}(${p.role})`).join(', ')}`, tone: 'warning' });
  const tone: 'good' | 'warning' | 'critical' = issues.some((i) => i.tone === 'critical') ? 'critical' : issues.length ? 'warning' : 'good';
  return {
    name: a.name, status: a.status, autoCharge: a.autoCharge, balance: a.balance, avgDailySpend: a.avgDailySpend,
    label: issues.length ? issues.map((i) => i.text).join(' · ') : '정상', tone, issues: issues.map((i) => i.text),
  };
}

export function sourceStatuses(d: Dataset): SourceStatus[] {
  const allDates = d.dates ?? [];
  const out: SourceStatus[] = [];
  for (const m of MEDIA_IDS) {
    const rows = d.mediaDaily.filter((r) => r.media === m);
    const have = new Set(rows.map((r) => r.date));
    const lastDate = rows.length ? rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date) : null;
    const todayHours = (d.mediaHourly ?? []).filter((r) => r.media === m && r.date === d.today).map((r) => r.hour);
    const lastHour = todayHours.length ? Math.max(...todayHours) : null;
    const missing = allDates.filter((x) => !have.has(x)).length;
    // 광고 계정 매칭: 버티컬은 쿠팡 · 오늘의집 광고 계정 중 상태가 가장 나쁜 것
    const accs = m === 'vertical' ? d.accounts.filter((a) => a.media === 'coupang' || a.media === 'ohouse') : d.accounts.filter((a) => a.media === m);
    const infos = accs.map((a) => accountInfo(a)!).filter(Boolean);
    const worst = infos.find((i) => i.tone === 'critical') ?? infos.find((i) => i.tone === 'warning') ?? infos[0];
    const st: SourceStatus['state'] = missing > 0 || !rows.length || (worst && worst.tone !== 'good') ? 'warn' : 'ok';
    out.push({
      id: m, group: 'media', name: MEDIA[m].name, method: SOURCE_METHOD[m] ?? '협의', lastDate, lastHour, days: have.size, missingDays: missing,
      rows: rows.length + (d.mediaHourly ?? []).filter((r) => r.media === m).length, inDataset: true, account: worst, state: st,
      note: !rows.length ? '수집 데이터 없음' : missing ? `결측 ${missing}일` : worst && worst.tone !== 'good' ? `계정 ${worst.label}` : '일 · 시간대 수집 정상',
      route: worst && worst.tone !== 'good' ? 'alert' : undefined,
    });
  }
  for (const c of SALES_CHANNEL_IDS) {
    const rows = d.salesDaily.filter((r) => r.channel === c);
    const have = new Set(rows.map((r) => r.date));
    const lastDate = rows.length ? rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date) : null;
    const missing = allDates.filter((x) => !have.has(x)).length;
    const bad = rows.filter((r) => r.adAttributedRevenue > r.revenue + 1).length;
    out.push({
      id: c, group: 'sales', name: SALES_CHANNELS[c].name, method: SOURCE_METHOD[c] ?? '협의', lastDate, lastHour: null, days: have.size, missingDays: missing,
      rows: rows.length, inDataset: true, state: missing > 0 || !rows.length || bad > 0 ? 'warn' : 'ok',
      note: !rows.length ? '수집 데이터 없음' : bad ? `광고 경유 > 총매출 ${bad}건` : missing ? `결측 ${missing}일` : '일 단위 수집 정상 (오늘은 부분일)',
    });
  }
  for (const e of EXTERNAL_SOURCES) {
    const rows = e.id === 'brand_search' ? (d.brandSearchDaily ?? []) : [];
    const lastDate = rows.length ? rows[rows.length - 1].date : null;
    out.push({
      id: e.id, group: 'external', name: e.name, method: SOURCE_METHOD[e.id] ?? '', lastDate, lastHour: null, days: rows.length, missingDays: 0, rows: rows.length,
      inDataset: e.inDataset, state: e.inDataset ? (rows.length ? 'ok' : 'warn') : 'snapshot',
      note: e.inDataset ? (rows.length ? `${e.cadence} · DA→SA 분석 입력` : '수집 데이터 없음') : `${e.cadence} · 이 데이터셋 미포함 (해당 모듈 스냅샷)`,
      route: e.route,
    });
  }
  return out;
}

export interface ValidationCheck {
  id: string;
  source: string;
  label: string;
  level: 'ok' | 'warn';
  detail: string;
  basis: string;
  route?: string;
}

/** 동요일 · 동시간 기준선 (최근 4주 같은 요일) */
function sameSlotBaseline(d: Dataset, media: MediaId, hour: number) {
  const refs = [7, 14, 21, 28].map((k) => addDays(d.today, -k));
  const rows = (d.mediaHourly ?? []).filter((r) => r.media === media && r.hour === hour && refs.includes(r.date));
  const n = rows.length;
  return {
    n,
    cost: n ? sum(rows, (r) => nz(r.cost)) / n : NaN,
    clicks: n ? sum(rows, (r) => nz(r.clicks)) / n : NaN,
    conversions: n ? sum(rows, (r) => nz(r.conversions)) / n : NaN,
    convAlways: n > 0 && rows.every((r) => nz(r.conversions) > 0),
  };
}

export interface TodaySignal { media: MediaId; kind: 'spike' | 'zero_conv'; fromHour: number; toHour: number; observed: number; baseline: number; deltaPct: number; clickRatio?: number; text: string; basis: string }

/** 오늘 시간대 데이터 검증: 광고비 급변(최근 2시간 ±50%) · 전환 0 연속(클릭 정상) */
export function todaySignals(d: Dataset): TodaySignal[] {
  const out: TodaySignal[] = [];
  const H = d.currentHour;
  for (const m of MEDIA_IDS) {
    const today = (d.mediaHourly ?? []).filter((r) => r.media === m && r.date === d.today);
    if (!today.length) continue;
    const at = (h: number) => today.find((r) => r.hour === h);
    // 광고비 급변
    const hs = Array.from({ length: R.hourlySpikeHours }, (_, i) => H - i).filter((h) => h >= 0);
    const obs = sum(hs, (h) => nz(at(h)?.cost ?? NaN));
    const base = sum(hs, (h) => nz(sameSlotBaseline(d, m, h).cost));
    const dp = base > 0 ? metrics.pctChange(obs, base) : NaN;
    if (fin(dp) && Math.abs(dp) >= R.hourlySpikePct) {
      const from = Math.min(...hs);
      out.push({
        media: m, kind: 'spike', fromHour: from, toHour: H, observed: obs, baseline: base, deltaPct: dp,
        text: `${MEDIA[m].short} ${from}~${H}시 광고비 ${fmt.delta(dp, 0)}`,
        basis: `동요일 · 동시간 4주 평균 ${fmt.krw(base)} → ${fmt.krw(obs)} (기준 ±${R.hourlySpikePct}% · p.44)`,
      });
    }
    // 전환 0 연속 (현재 시각까지)
    let streak = 0;
    for (let h = H; h >= 0; h--) {
      const r = at(h);
      if (!r || nz(r.conversions) > 0) break;
      streak += 1;
    }
    if (streak >= R.zeroConvStreakHours) {
      const from = H - streak + 1;
      const hrs = Array.from({ length: streak }, (_, i) => from + i);
      const clicks = sum(hrs, (h) => nz(at(h)?.clicks ?? 0));
      const bl = hrs.map((h) => sameSlotBaseline(d, m, h));
      const baseClicks = sum(bl, (b) => nz(b.clicks));
      const baseConv = sum(bl, (b) => nz(b.conversions));
      const normallyConverts = bl.every((b) => b.convAlways);
      const clickRatio = baseClicks > 0 ? clicks / baseClicks : NaN;
      if (normallyConverts && fin(clickRatio) && clickRatio >= R.zeroConvClickFloor) {
        out.push({
          media: m, kind: 'zero_conv', fromHour: from, toHour: H, observed: 0, baseline: baseConv, deltaPct: -100, clickRatio,
          text: `${MEDIA[m].short} ${from}시 이후 전환 0 · 클릭 기준선 대비 ${fmt.ratio(clickRatio, 0)}`,
          basis: `${streak}시간 연속 전환 0 (기준 ${R.zeroConvStreakHours}시간) · 같은 시간 최근 4주 매주 전환 발생 · 클릭 ${Math.round(R.zeroConvClickFloor * 100)}% 이상 유지 → 전환 추적 단절 의심`,
        });
      }
    }
  }
  return out;
}

export function validationChecks(d: Dataset): ValidationCheck[] {
  const out: ValidationCheck[] = [];
  const y = addDays(d.today, -1);
  const allDates = d.dates ?? [];
  // 결측일
  const missingMedia = MEDIA_IDS.filter((m) => {
    const have = new Set(d.mediaDaily.filter((r) => r.media === m).map((r) => r.date));
    return allDates.some((x) => !have.has(x));
  });
  out.push({
    id: 'missing_days', source: '광고 매체', label: '일자 결측',
    level: missingMedia.length || !d.mediaDaily.length ? 'warn' : 'ok',
    detail: !d.mediaDaily.length ? '매체 일별 데이터 없음' : missingMedia.length ? `결측 매체: ${missingMedia.map((m) => MEDIA[m].short).join(', ')}` : `${MEDIA_IDS.length}개 매체 × ${allDates.length}일 모두 수집`,
    basis: '기준일까지 전 일자 행 존재',
  });
  // 일 합계 ↔ 시간대 합계 (전일)
  const gaps = MEDIA_IDS.map((m) => {
    const day = d.mediaDaily.find((r) => r.media === m && r.date === y);
    const hs = (d.mediaHourly ?? []).filter((r) => r.media === m && r.date === y);
    const hsum = sum(hs, (r) => nz(r.cost));
    return { m, gap: day && day.cost > 0 && hs.length ? metrics.pctChange(hsum, day.cost) : NaN };
  });
  const measured = gaps.filter((g) => fin(g.gap));
  const worst = measured.reduce<{ m: MediaId; gap: number } | null>((a, g) => (!a || Math.abs(g.gap) > Math.abs(a.gap) ? g : a), null);
  const outOfTol = measured.filter((g) => Math.abs(g.gap) > R.dailyHourlyTolerancePct);
  out.push({
    id: 'daily_vs_hourly', source: '광고 매체', label: '일 합계 ↔ 시간대 합계 (전일)',
    level: !measured.length || outOfTol.length ? 'warn' : 'ok',
    detail: !measured.length ? '비교할 전일 데이터 없음' : outOfTol.length ? `허용 범위 밖: ${outOfTol.map((g) => `${MEDIA[g.m].short} ${fmt.delta(g.gap)}`).join(', ')}` : `최대 차이 ${worst ? `${MEDIA[worst.m].short} ${fmt.delta(worst.gap)}` : '—'}`,
    basis: `허용 ±${R.dailyHourlyTolerancePct}% (집계 시차 · 보정 · 모듈 가정)`,
  });
  // 오늘 시간대 신호
  const sig = todaySignals(d);
  const spikes = sig.filter((s) => s.kind === 'spike');
  const zeros = sig.filter((s) => s.kind === 'zero_conv');
  out.push({
    id: 'hourly_spike', source: '광고 매체', label: `오늘 광고비 급변 (최근 ${R.hourlySpikeHours}시간)`,
    level: spikes.length ? 'warn' : 'ok',
    detail: spikes.length ? spikes.map((s) => `${s.text} · ${s.basis}`).join(' / ') : '전 매체 동요일 · 동시간 기준 범위 내',
    basis: `동요일 · 동시간 ±${R.hourlySpikePct}% (p.44 데이터 급변)`, route: spikes.length ? 'alert' : undefined,
  });
  out.push({
    id: 'zero_conv', source: '광고 매체', label: '전환 수집 연속성',
    level: zeros.length ? 'warn' : 'ok',
    detail: zeros.length ? zeros.map((s) => `${s.text} · ${s.basis}`).join(' / ') : '전환 0 연속 구간 없음',
    basis: `${R.zeroConvStreakHours}시간 연속 전환 0 + 클릭 정상 → 추적 단절 의심 (p.45)`, route: zeros.length ? 'alert' : undefined,
  });
  // 판매 채널 정합성
  const salesY = d.salesDaily.filter((r) => r.date === y);
  const badAttr = d.salesDaily.filter((r) => r.adAttributedRevenue > r.revenue + 1).length;
  out.push({
    id: 'sales_coverage', source: '판매 채널', label: '판매 채널 전일 수집',
    level: salesY.length === SALES_CHANNEL_IDS.length && !badAttr ? 'ok' : 'warn',
    detail: `${salesY.length}/${SALES_CHANNEL_IDS.length}개 채널 전일 데이터${badAttr ? ` · 광고 경유 > 총매출 ${badAttr}건` : ''}`,
    basis: '전 채널 전일 행 존재 · 광고 경유 ≤ 총매출',
  });
  // 계정 상태 (수집 중단 위험)
  const accIssues = (d.accounts ?? []).map((a) => ({ a, info: accountInfo(a)! })).filter((x) => x.info && x.info.tone !== 'good');
  out.push({
    id: 'account_state', source: '계정 · 결제', label: '광고 계정 상태 (집행 · 수집 중단 위험)',
    level: accIssues.length ? 'warn' : 'ok',
    detail: accIssues.length ? accIssues.map((x) => `${x.a.name}: ${x.info.label}${x.a.autoCharge === 'failed' && x.a.balance >= 0 ? ` (잔액 ${fmt.krw(x.a.balance)} · 일 평균 ${fmt.krw(x.a.avgDailySpend)})` : ''}`).join(' / ') : '전 계정 정상',
    basis: '잔액 1일치 미만 · 자동충전 실패 · 검수 상태 · 비실명 권한 계정 (p.44 · p.50)', route: accIssues.length ? 'alert' : undefined,
  });
  // 키워드 보고서
  const kwShort = (d.keywords ?? []).filter((k) => (k.daily ?? []).length < 14).length;
  out.push({
    id: 'keyword_report', source: '네이버 SA', label: '키워드 · 검색어 보고서',
    level: !(d.keywords ?? []).length || kwShort ? 'warn' : 'ok',
    detail: `키워드 ${(d.keywords ?? []).length}개 · 일별 14일${kwShort ? ` (14일 미만 ${kwShort}개)` : ''} · 검색어 ${(d.searchTerms ?? []).length}개 (미등록 ${(d.searchTerms ?? []).filter((t) => !t.registered).length})`,
    basis: '최근 14일 · 직전 14일 단위 수집',
  });
  return out;
}

export interface CollectionSummary {
  batchTime: string;
  batchDate: string;
  hourlyThrough: number | null;
  asOf: string;
  offDay: { off: boolean; label: string };
  media: { ok: number; total: number };
  sales: { ok: number; total: number };
  external: { inDataset: number; total: number };
  warnings: number;
  /** 전일분 배치 상태: 기준 시각이 배치 시각 전이면 pending, 지났는데 전일 행이 빠진 원천이 있으면 missing */
  batch: { state: 'done' | 'pending' | 'missing'; missing: string[]; text: string };
  timetable: { time: string; title: string; channel: string; done: boolean; state: 'done' | 'pending' | 'moved'; note?: string }[];
}

export function collectionSummary(d: Dataset): CollectionSummary {
  const src = sourceStatuses(d);
  const checks = validationChecks(d);
  const asOf = asOfClock(d);
  const hours = (d.mediaHourly ?? []).filter((r) => r.date === d.today).map((r) => r.hour);
  const off = isOffDay(d.today);
  const y = addDays(d.today, -1);
  const missing = [
    ...MEDIA_IDS.filter((m) => !d.mediaDaily.some((r) => r.media === m && r.date === y)).map((m) => MEDIA[m].short),
    ...SALES_CHANNEL_IDS.filter((c) => !d.salesDaily.some((r) => r.channel === c && r.date === y)).map((c) => SALES_CHANNELS[c].name),
  ];
  const batchState: CollectionSummary['batch']['state'] = asOf < DAILY_BATCH_TIME ? 'pending' : missing.length ? 'missing' : 'done';
  const batchText = batchState === 'done' ? `${DAILY_BATCH_TIME} 완료`
    : batchState === 'pending' ? `${DAILY_BATCH_TIME} 예정`
      : `${DAILY_BATCH_TIME} 배치 · 전일분 누락 ${missing.length}개 원천`;
  return {
    batch: { state: batchState, missing, text: batchText },
    batchTime: DAILY_BATCH_TIME,
    batchDate: y,
    hourlyThrough: hours.length ? Math.max(...hours) : null,
    asOf,
    offDay: off,
    media: { ok: src.filter((s) => s.group === 'media' && s.days > 0).length, total: MEDIA_IDS.length },
    sales: { ok: src.filter((s) => s.group === 'sales' && s.days > 0).length, total: SALES_CHANNEL_IDS.length },
    external: { inDataset: src.filter((s) => s.group === 'external' && s.inDataset && s.days > 0).length, total: EXTERNAL_SOURCES.length },
    warnings: checks.filter((c) => c.level === 'warn').length,
    timetable: DATA_TIMETABLE.map((t) => {
      // p.18: 주말 · 공휴일 이슈 브리핑은 다음 영업일 09:30으로 이동
      const moved = off.off && t.kind === 'brief';
      // 수집 · 검증 항목은 시각이 지나도 전일 행이 빠져 있으면 완료로 보지 않는다
      const dataGap = t.kind === 'data' && missing.length > 0;
      const done = !moved && !dataGap && t.time <= asOf;
      const note = moved ? `${off.label} · 다음 영업일 09:30` : dataGap && t.time <= asOf ? `전일분 누락: ${missing.join(', ')}` : undefined;
      return { time: t.time, title: t.title, channel: t.channel, done, state: moved ? 'moved' as const : done ? 'done' as const : 'pending' as const, note };
    }),
  };
}

export interface KeyMapping { source: string; raw: string; date: string; channel: string; keyword: string; product: string; note?: string }

export function standardKeyStats(d: Dataset) {
  const options = sum(d.products ?? [], (p) => p.options.length);
  const soldout = sum(d.products ?? [], (p) => p.options.filter((o) => !o.inStock).length);
  const hourlyDays = new Set((d.mediaHourly ?? []).map((r) => r.date)).size;
  return [
    { id: 'date', label: '날짜', value: `${(d.dates ?? []).length}일`, detail: d.dates?.length ? `${fmtDate(d.dates[0], false)}~${fmtDate(d.today, false)} 일별 · 최근 ${hourlyDays}일 시간대` : '데이터 없음' },
    { id: 'channel', label: '채널', value: `${MEDIA_IDS.length + SALES_CHANNEL_IDS.length}개`, detail: `광고 매체 ${MEDIA_IDS.length} · 판매 채널 ${SALES_CHANNEL_IDS.length}` },
    { id: 'keyword', label: '키워드', value: `${(d.keywords ?? []).length}개`, detail: `구매 의도 ${INTENT_IDS.length}분류 · 검색어 보고서 ${(d.searchTerms ?? []).length}개` },
    { id: 'product', label: '상품', value: `${(d.products ?? []).length}개 · 옵션 ${options}`, detail: soldout ? `품절 옵션 ${soldout}개` : '품절 옵션 없음' },
  ];
}

/** 원천 레코드 → 표준 키 매핑 예시 (실제 데이터에서 뽑는다) */
export function keyMappingSamples(d: Dataset): KeyMapping[] {
  const y = addDays(d.today, -1);
  const out: KeyMapping[] = [];
  const products = d.products ?? [];
  const kws = d.keywords ?? [];
  const kw = kws.find((k) => landingInfo(k, products).inStock === false)
    ?? kws.find((k) => { const li = landingInfo(k, products); return li.kind === 'product' && !!li.optionId; })
    ?? kws[0];
  if (kw) {
    const li = landingInfo(kw, products);
    out.push({
      source: '네이버 SA 키워드 보고서', raw: `'${kw.text}' · ${kw.adgroup} · 랜딩 ${li.label}`, date: y, channel: 'naver_sa',
      keyword: `${kw.id} (${SA_CAMPAIGNS[kw.intent]?.name ?? kw.intent})`,
      product: li.productId ? `${li.productId}${li.optionId ? `:${li.optionId}` : ''}` : `— (${li.label})`,
      note: li.inStock === false ? `${li.optionLabel} 옵션 품절 → 품절 랜딩 신호` : undefined,
    });
  }
  const camp = (d.campaigns ?? []).find((c) => c.intent) ?? d.campaigns?.[0];
  if (camp) {
    out.push({ source: `${MEDIA[camp.media].name} 캠페인`, raw: `'${camp.name}' 일 예산 ${fmt.krw(camp.dailyBudget)}`, date: d.today, channel: camp.media, keyword: camp.intent ? `의도 ${SA_CAMPAIGNS[camp.intent].name} 묶음` : '—', product: '—' });
  }
  const s = d.salesDaily.find((r) => r.date === y && r.channel === 'brandstore');
  if (s) {
    out.push({ source: '브랜드스토어 주문', raw: `${fmtDate(y)} 주문 ${fmt.int(s.orders)}건 · ${fmt.krw(s.revenue)}`, date: y, channel: 'brandstore', keyword: '유입 키워드 (연동 범위 협의)', product: products[0]?.id ?? '—' });
  }
  const promo = (d.promotions ?? []).find((p) => p.status === 'live');
  if (promo) {
    out.push({ source: '프로모션 일정', raw: `'${promo.name}' · 할인 ${promo.discountRate}%`, date: `${fmtDate(promo.start, false)}–${fmtDate(promo.end, false)}`, channel: promo.channel, keyword: '기획전 랜딩 키워드', product: products[0]?.id ?? '—' });
  }
  return out;
}

/* ================================================================== */
/* 오프라인 브리프 (규칙 엔진) · AI 프롬프트 데이터                       */
/* ================================================================== */

function topBy<T>(arr: readonly T[], f: (x: T) => number, n = 1): T[] {
  return [...arr].filter((x) => fin(f(x))).sort((a, b) => f(b) - f(a)).slice(0, n);
}

export function periodBrief(d: Dataset, preset: BoardPeriod = 'last7'): Brief {
  const k = boardKpis(d, preset);
  const w = k.win;
  const title = `MILDO Board 기간 성과 · ${w.label} (${w.rangeText})`;
  if (!k.hasData) {
    return { title, facts: [`${w.label} 구간에 광고비 · 판매 채널 매출 데이터가 없습니다.`], patterns: [], interpretation: ['데이터가 없으므로 판단하지 않습니다.'], conditions: ['수집 상태를 데이터 수집 탭에서 먼저 확인합니다.'], counter: [], actions: ['담당 AE가 수집 원천별 결측 여부를 확인하고, 결측 원인을 개발자에게 전달합니다.'] };
  }
  const rows = mediaComparison(d, w);
  const active = rows.filter((r) => r.cost > 0);
  const bestRoas = topBy(active, (r) => r.roas)[0];
  const worstRoas = topBy(active, (r) => -r.roas)[0];
  const flagged = rows.filter((r) => r.flag.level === 'warn' || r.flag.level === 'danger');
  const ch = channelRows(d, w);
  const rec = reconciliation(d, w);
  const topCh = topBy(ch, (c) => c.revenue)[0];
  const pacing = budgetPacing(d);
  const facts = [
    `${w.label}(${w.rangeText}) 광고비 ${fmt.krw(k.cur.cost)}(직전 ${w.prevText} 대비 ${fmt.delta(k.deltas.cost)}), 광고 매출 ${fmt.krw(k.cur.revenue)}, ROAS ${fmt.roas(k.cur.roas)}(${fmt.delta(k.deltas.roas)}). 시연용 테스트 데이터 기준입니다.`,
    `판매 채널 실매출은 ${fmt.krw(k.sales)}(${fmt.delta(k.deltas.sales)})이고 광고비 대비 실매출(MER)은 ${fmt.dec1(k.mer)}배(직전 ${fmt.dec1(k.prevMer)}배)입니다. 실매출 중 광고 경유 추정 비중은 ${fmt.ratio(k.adShareOfSales, 0)}입니다.`,
    `CPA ${fmt.won(k.cur.cpa)}(${fmt.delta(k.deltas.cpa)}), CVR ${fmt.pct(k.cur.cvr, 2)}(${fmt.delta(k.deltas.cvr)}), 신규 고객 CAC ${fmt.won(k.cur.cac)}(${fmt.delta(k.deltas.cac)}, 신규 ${fmt.int(k.cur.newCustomers)}명).`,
  ];
  if (bestRoas && worstRoas && bestRoas.media !== worstRoas.media) {
    facts.push(`매체별 ROAS는 ${bestRoas.name} ${fmt.roas(bestRoas.roas)}가 가장 높고 ${worstRoas.name} ${fmt.roas(worstRoas.roas)}가 가장 낮습니다. 광고비 비중은 ${active.map((r) => `${r.short} ${fmt.ratio(r.share, 0)}`).join(' · ')}입니다.`);
  }
  const patterns: string[] = [];
  const sa = rows.find((r) => r.media === 'naver_sa');
  if (sa && sa.share > 0) {
    const gapPp = (sa.revenueShare - sa.share) * 100;
    patterns.push(Math.abs(gapPp) < 2
      ? `네이버 SA는 광고비 비중 ${fmt.ratio(sa.share, 0)}와 광고 매출 비중 ${fmt.ratio(sa.revenueShare, 0)}가 비슷합니다(차이 ${gapPp.toFixed(1)}pp).`
      : gapPp > 0
        ? `네이버 SA는 광고비 비중 ${fmt.ratio(sa.share, 0)}에 광고 매출 비중 ${fmt.ratio(sa.revenueShare, 0)}(+${gapPp.toFixed(1)}pp)로 매출 귀속이 광고비 비중보다 큽니다. 수요 회수 매체(p.37)는 DA가 만든 수요를 마지막에 회수하므로, 이 차이를 SA 단독 효율로 읽지 않습니다.`
        : `네이버 SA는 광고비 비중 ${fmt.ratio(sa.share, 0)}에 광고 매출 비중 ${fmt.ratio(sa.revenueShare, 0)}(${gapPp.toFixed(1)}pp)로 매출 귀속이 광고비 비중보다 작습니다. 수요 회수 매체에서 이 방향은 비브랜드 키워드 효율 저하나 브랜드 검색량 감소 여부를 먼저 확인할 신호입니다.`);
  }
  const prospect = rows.filter((r) => r.media === 'meta' || r.media === 'naver_gfa').filter((r) => r.cost > 0 && fin(r.newShare));
  const allNew = k.cur.conversions > 0 ? k.cur.newCustomers / k.cur.conversions : NaN;
  if (prospect.length && fin(allNew)) {
    const higher = prospect.filter((r) => r.newShare > allNew);
    patterns.push(`신규 고객 비중은 ${prospect.map((r) => `${r.short} ${fmt.ratio(r.newShare, 0)}`).join(' · ')}로 전체 평균 ${fmt.ratio(allNew, 0)} 대비 ${higher.length === prospect.length ? '모두 높습니다' : higher.length ? `${higher.map((r) => r.short).join(' · ')}만 높습니다` : '높지 않습니다'}. 신규 획득 역할(p.37) 매체는 ROAS와 함께 이 비중으로 판단합니다.`);
  }
  if (topCh) patterns.push(`판매 채널 중 ${josa(topCh.name, '이/가')} 실매출의 ${fmt.ratio(topCh.share, 0)}를 차지합니다. 매체 집계 광고 매출은 ${rec.basis}입니다.`);
  const interpretation = [
    `MER ${fmt.dec1(k.mer)}배는 광고 외 유입을 포함한 합산 매출 기준이라 광고 ROAS ${fmt.roas(k.cur.roas)}보다 CAC 회수 판단에 가깝습니다. 다만 오가닉 매출이 광고 노출의 지연 효과인지 독립 수요인지는 이 데이터만으로 구분되지 않습니다.`,
  ];
  if (flagged.length) interpretation.push(`직전 대비 변동 기준을 넘은 매체는 ${flagged.map((r) => `${r.short}(${r.flag.basis})`).join(', ')}입니다. 기간이 짧을수록 요일 구성 차이가 섞이므로 7일 이상 구간에서 같은 방향이 유지되는지 확인한 뒤 조정합니다.`);
  else interpretation.push(`매체별 변동은 ROAS −${R.roasDropWarnPct}% · CPA +${R.cpaRiseWarnPct}% · 광고비 ±${R.costSwingWarnPct}% 기준 안에 있어 구조 조정보다 키워드 · 시간대 단위 조정 여지를 먼저 봅니다.`);
  const conditions = [
    `목표 ROAS ${R.targetRoas}%(브랜드 ${R.brandTargetRoas}%)는 제안서 p.14 초기값이며 온보딩 중 확정합니다. 매체 변동 판정은 p.47 이상 징후 기준을 기간 비교에 준용한 모듈 가정입니다.`,
    w.includesToday ? `이 구간은 오늘(${d.currentHour}시 기준) 부분일을 포함하므로 직전 기간 대비 증감이 낮게 나올 수 있습니다.` : `오늘(부분일)은 포함하지 않은 완결 구간입니다.`,
  ];
  const counter = [
    `광고 매출은 매체별 귀속 기준이라 매체 간 중복이 있을 수 있습니다. 판매 채널 실매출을 분모로 둔 MER이 함께 오르지 않으면 매체 ROAS 개선을 실매출 증가로 보지 않습니다.`,
  ];
  if (worstRoas && (worstRoas.media === 'meta' || worstRoas.media === 'naver_gfa')) counter.push(`${worstRoas.name}의 낮은 ROAS는 신규 수요 환기 역할을 감안하면 감액 근거가 되지 않을 수 있으며, 브랜드 검색량 동행(DA→SA) 결과와 함께 판단합니다.`);
  const actions = [
    flagged.length
      ? `담당 AE가 다음 일간 리포트(${DAILY_REPORT_TIME}) 전까지 변동 기준을 넘은 매체(${flagged.map((r) => r.short).join(', ')})의 키워드 · 시간대 원인을 확인하고, PM이 예산 구조 변경 필요 여부를 판단합니다.`
      : `담당 AE가 다음 일간 리포트(${DAILY_REPORT_TIME})에서 같은 기준으로 변동을 다시 확인하고, 매체 간 구조 조정은 월간 리뷰(${MONTHLY_REPORT_WHEN})에서 PM이 한계 효율 비교로 판단합니다.`,
  ];
  if (pacing.early.length) actions.push(`오늘 조기 소진 예상 캠페인 ${pacing.early.length}개(${listMore(pacing.early, 3, (c) => `${c.name} ${clock(c.exhaustHour)}`)})는 AD Pilot에서 예산 재배분 · 입찰 조정안을 만들고 위임 범위에 따라 승인합니다.`);
  return { title, facts, patterns, interpretation, conditions, counter, actions };
}

export function pacingBrief(d: Dataset): Brief {
  const p = budgetPacing(d);
  const title = `MILDO Board 예산 소진 현황 · ${fmtDate(d.today)} ${asOfClock(d)} 기준`;
  if (!p.media.length && !p.campaigns.length) {
    return { title, facts: ['예산 · 캠페인 데이터가 없습니다.'], patterns: [], interpretation: ['판단하지 않습니다.'], conditions: [], counter: [], actions: ['담당 AE가 캠페인 · 예산 수집 상태를 확인합니다.'] };
  }
  const m = p.month;
  const facts = [
    `${m.key} 월 예산(연 배분 ÷ 12) ${fmt.krw(m.budget)} 대비 소진 ${fmt.krw(m.spent)}(${fmt.pct(m.pacePct, 0)}), 기대 소진율 ${fmt.pct(m.expectedPct, 0)}, 예상 월말 ${fmt.pct(m.projectedPct, 0)}입니다. 시연용 테스트 데이터 기준입니다.`,
  ];
  const reached = p.media.filter((x) => x.reachedDate);
  if (reached.length) facts.push(`월 예산에 이미 도달한 매체는 ${reached.map((x) => `${x.name}(${fmtDate(x.reachedDate!)})`).join(', ')}입니다.`);
  if (p.early.length) facts.push(`오늘 ${d.currentHour}시 기준 일 예산 조기 소진 예상 캠페인은 ${p.early.map((c) => `${c.name}(소진 ${fmt.pct(c.pacePct, 0)} · 예상 마감 ${clock(c.exhaustHour)})`).join(', ')}입니다.`);
  else facts.push(`오늘 ${d.currentHour}시 기준 ${R.exhaustBeforeHour}시 전 마감이 예상되는 캠페인은 없습니다.`);
  const patterns: string[] = [];
  const both = p.early.filter((c) => c.curveExhaustHour !== null && c.linearExhaustHour !== null);
  const curveFirst = both.filter((c) => c.curveExhaustHour! < c.linearExhaustHour!);
  if (p.early.length) {
    const rest = [...new Set(p.early.map((c) => c.media))].map((mm) => {
      const cum = hourlyCostCurve(d, mm);
      const h = clamp(d.currentHour, 0, 23);
      return `${MEDIA[mm].short} ${fmt.ratio(1 - cum[h], 0)}`;
    });
    patterns.push(`조기 소진 캠페인 ${p.early.length}개 중 ${curveFirst.length}개는 시간대 가중 예상(최근 ${R.curveDays}일 매체별 시간대 소진 곡선)이 선형 추정보다 이른 마감 시각을 냅니다. 같은 곡선에서 ${d.currentHour + 1}시 이후 남은 소진 비중은 ${rest.join(' · ')}이며, 이 비중이 클수록 선형 추정이 마감 시각을 늦게 잡습니다.`);
  } else {
    patterns.push(`시간대 가중 예상은 최근 ${R.curveDays}일 매체별 시간대 소진 곡선 기준이며, 현재 소진 속도로는 모든 캠페인이 ${R.exhaustBeforeHour}시 이후까지 예산이 남습니다.`);
  }
  const peak = p.early.filter((c) => c.missesPeak);
  if (peak.length) patterns.push(`${josa(peak.map((c) => c.name).join(', '), '은/는')} ${R.peakStartHour}~23시 피크 전에 예산이 닫히는 패턴으로, 전환 효율이 높은 시간대 노출을 놓칩니다.`);
  const promos = (d.promotions ?? []).filter((x) => x.start.slice(0, 7) <= m.key && x.end.slice(0, 7) >= m.key && x.status !== 'planned');
  const interpretation = [
    m.status === 'over'
      ? `월 단위로는 ${josa(m.basis, '으로/로')} 연 배분 ÷ 12 기준을 넘습니다. ${promos.length ? `이번 달 진행 프로모션(${promos.map((x) => x.name).join(', ')}) 수요가 반영된 결과일 수 있어, ` : ''}초과분을 줄일지 시즌 배분으로 인정할지는 수면밀도 승인 사항입니다.`
      : `월 단위로는 ${m.basis}입니다.`,
  ];
  if (p.early.length) interpretation.push(`조기 소진 캠페인은 예산 부족 예상액이 ${p.early.map((c) => `${c.name} ${fmt.krw(c.shortfall)}`).join(', ')}입니다. 증액은 캠페인 ROAS가 목표 이상일 때만 의미가 있으며, 같은 매체 안의 저소진 캠페인 재원 이동을 먼저 검토합니다.`);
  const next = p.media.filter((x) => fin(x.next.projectedPct));
  const nextOver = next.filter((x) => x.next.projectedPct > R.monthOverRatio * 100);
  const conditions = [
    `조기 소진 기준은 ${R.exhaustBeforeHour}시 전 마감 예상(공용 선형 페이싱과 같은 기준), 피크 시간은 ${R.peakStartHour}~23시(모듈 가정)입니다. 월 상태는 예상 월말 ${Math.round(R.monthOverRatio * 100)}% 초과 · ${Math.round(R.monthUnderRatio * 100)}% 미만 기준입니다.`,
  ];
  if (nextOver.length) conditions.push(`최근 7일 속도를 유지하면 ${nextOver[0].next.month} 예상 소진이 ${nextOver.map((x) => `${x.name} ${fmt.pct(x.next.projectedPct, 0)}`).join(', ')}로 월 예산을 넘습니다.`);
  const spikes = todaySignals(d).filter((x) => x.kind === 'spike');
  const counter = [
    `오늘 소진 속도는 ${d.currentHour}시까지의 관측치이며, 수집 이상이나 일시적 급변이 섞이면 예상 마감이 과대 추정될 수 있습니다.${spikes.length ? ` 현재 급변 신호(${spikes.map((x) => `${x.text}`).join(', ')})가 있는 매체는 자동 조정을 보류하고 원인 확인을 먼저 합니다.` : ''}`,
  ];
  const overMedia = p.media.filter((x) => x.status === 'over');
  const actions = [
    p.early.length
      ? `담당 AE가 ${PACE_CHECK_TIME} 예산 소진율 점검(p.18)에서 조기 소진 캠페인의 재배분 · 입찰 조정안을 AD Pilot으로 올리고, 위임 범위(일 예산 ${delegationText()})에 따라 승인합니다(p.15).`
      : `담당 AE가 ${PACE_CHECK_TIME} 예산 소진율 점검(p.18)에서 같은 기준으로 캠페인별 예상 마감을 다시 확인합니다.`,
    overMedia.length
      ? `PM이 월 예산 초과 예상 매체(${overMedia.map((x) => x.name).join(', ')})의 다음 달 일 예산을 권장치(${listMore(overMedia, 3, (x) => `${x.name} ${fmt.krw(x.next.recommendedDaily)}/일`)}) 기준으로 수면밀도와 확정합니다.`
      : `PM이 월간 리뷰(${MONTHLY_REPORT_WHEN})에서 다음 달 매체별 일 예산(연 배분 ÷ 12 ÷ 일수)을 수면밀도와 확정합니다.`,
  ];
  return { title, facts, patterns, interpretation, conditions, counter, actions };
}

export function keywordBrief(d: Dataset, filter: KeywordFilter = {}, window: KeywordWindow = 14): Brief {
  const rows = filterKeywords(keywordRows(d, window), filter);
  const s = keywordSummary(rows);
  const title = `MILDO Board 키워드 성과 · 최근 ${window}일 · ${rows.length}개`;
  if (!rows.length) return { title, facts: ['조건에 맞는 키워드가 없습니다.'], patterns: [], interpretation: ['판단하지 않습니다.'], conditions: [], counter: [], actions: ['필터 조건을 넓혀 다시 조회합니다.'] };
  const intents = intentRollup(rows);
  const best = topBy(intents, (r) => r.roas)[0];
  const worst = topBy(intents, (r) => -r.roas)[0];
  const sold = rows.filter((r) => r.signals.some((x) => x.id === 'soldout'));
  const spike = rows.filter((r) => r.signals.some((x) => x.id === 'cpc_spike'));
  const opp = rows.filter((r) => r.signals.some((x) => x.id === 'opportunity'));
  const lowSample = rows.filter((r) => !r.verdict.sampleOk).length;
  const facts = [
    `조회 키워드 ${rows.length}개의 최근 ${window}일 광고비 ${fmt.krw(s.cur.cost)}(직전 대비 ${fmt.delta(s.costDelta)}), 매출 ${fmt.krw(s.cur.revenue)}, ROAS ${fmt.roas(s.roas)}, 전환 ${fmt.dec1(s.cur.conversions)}건입니다. 시연용 테스트 데이터 기준입니다.`,
  ];
  if (best && worst && best.id !== worst.id) facts.push(`구매 의도별 ROAS는 ${best.label} ${fmt.roas(best.roas)}가 가장 높고 ${worst.label} ${fmt.roas(worst.roas)}가 가장 낮습니다.`);
  if (sold.length) facts.push(`랜딩 옵션 품절 신호: ${sold.map((r) => `'${r.text}'(${r.signals.find((x) => x.id === 'soldout')!.basis})`).join(', ')}.`);
  if (spike.length) facts.push(`CPC 급변 신호: ${spike.map((r) => `'${r.text}'(${r.signals.find((x) => x.id === 'cpc_spike')!.basis})`).join(', ')}.`);
  const patterns: string[] = [];
  if (opp.length) patterns.push(`고효율 · 노출 손실 신호 키워드 ${opp.length}개(${opp.slice(0, 4).map((r) => `'${r.text}' 손실 ${fmt.ratio(r.lost, 0)}`).join(', ')})는 목표 대비 ${Math.round(R.highEfficiencyRatio * 100)}% 이상이면서 노출 기회 손실 ${fmt.ratio(R.lostShareTrigger, 0)} 이상으로 순위 · 예산 제약에 걸린 상태입니다.`);
  const lowByIntent = intents.map((i) => ({ label: i.label, n: i.count, low: rows.filter((r) => r.intent === i.id && !r.verdict.sampleOk).length })).filter((x) => x.low > 0);
  patterns.push(lowSample
    ? `전환 ${R.minConversionsForVerdict}건 미만으로 표본 부족 표기된 키워드가 ${lowSample}개입니다(${lowByIntent.map((x) => `${x.label} ${x.low}/${x.n}`).join(' · ')}). 이 키워드들의 ${window}일 판정은 전환 1~2건 차이로 바뀔 수 있어 확대 · 중단 근거로 쓰지 않습니다.`
    : `조회 키워드 모두 전환 ${R.minConversionsForVerdict}건 이상으로 ${window}일 판정 표본을 갖췄습니다.`);
  const brandRows = rows.filter((r) => r.isBrand);
  const nonBrand = keywordSummary(rows.filter((r) => !r.isBrand));
  const brandS = keywordSummary(brandRows);
  const interpretation = [
    brandRows.length && nonBrand.count
      ? `브랜드 키워드 ROAS ${fmt.roas(brandS.roas)}, 비브랜드 ${fmt.roas(nonBrand.roas)}로 묶음 ROAS ${fmt.roas(s.roas)}에서 브랜드를 빼면 ${fmt.roas(nonBrand.roas)}입니다. 비브랜드 확장 여지는 이 값과 노출 손실로 판단하고, 브랜드는 점유 방어 기준(목표 ${R.brandTargetRoas}%)으로 따로 봅니다.`
      : brandRows.length
        ? `조회 결과가 브랜드 키워드뿐이므로 목표 ROAS ${R.brandTargetRoas}%(점유 방어 기준) 대비로만 판단합니다.`
        : `조회 결과가 비브랜드 키워드뿐이며 묶음 ROAS ${fmt.roas(s.roas)}는 목표 ${R.targetRoas}% 대비 ${fmt.int((s.roas / R.targetRoas) * 100)}%입니다.`,
  ];
  if (spike.length) interpretation.push(`CPC 급변 키워드는 경쟁사 입찰 상승 또는 집계 이상이 원인 후보이며, AD Pilot 자동 조정은 원인 확인 전까지 보류하는 것이 p.14 기준입니다.`);
  const conditions = [`목표 ROAS ${R.targetRoas}% · 브랜드 ${R.brandTargetRoas}% · 고효율 ${Math.round(R.highEfficiencyRatio * 100)}% · 노출 손실 ${fmt.ratio(R.lostShareTrigger, 0)} · 급변 ±${R.keywordAnomalyPct}%(최근 ${R.keywordAnomalyDays}일, 클릭 ${R.keywordAnomalyMinClicks}회 이상)는 제안서 p.14 초기값과 모듈 가정입니다.`];
  const counter = [`노출 손실이 큰 고효율 키워드도 검색량 상한(월간 검색량)에 막히면 입찰 상향의 한계 효율이 빠르게 떨어집니다. 상향 후 7일 CPC · 전환 실측으로 확대 여부를 다시 판정합니다.`];
  const actions: string[] = [];
  if (sold.length) actions.push(`담당 AE가 품절 랜딩 키워드(${sold.map((r) => `'${r.text}'`).join(', ')})의 랜딩 교체 또는 일시 중지를 당일 처리합니다(p.45).`);
  if (spike.length) actions.push(`담당 AE가 CPC 급변 키워드(${spike.map((r) => `'${r.text}'`).join(', ')})의 원인을 확인한 뒤 AD Pilot 조정 후보로 넘깁니다.`);
  if (opp.length) actions.push(`SA Lead AE가 고효율 · 노출 손실 키워드의 입찰 상향안(최대 입찰가 내 · 일 조정 폭 ${AD_PILOT.dailyChangeCapPct}% 상한)을 AD Pilot에서 승인 요청합니다.`);
  if (!actions.length) actions.push(`담당 AE가 다음 주간 리포트에서 같은 필터 조건으로 직전 대비 변화를 다시 확인합니다.`);
  return { title, facts, patterns, interpretation, conditions, counter, actions };
}

export function channelBrief(d: Dataset, preset: BoardPeriod = 'last7'): Brief {
  const w = periodWindow(d, preset);
  const rows = channelRows(d, w);
  const rec = reconciliation(d, w);
  const title = `MILDO Board 판매 채널 실매출 · ${w.label} (${w.rangeText})`;
  if (!(rec.sales > 0)) return { title, facts: ['판매 채널 매출 데이터가 없습니다.'], patterns: [], interpretation: ['판단하지 않습니다.'], conditions: [SALES_NOTE_TEXT], counter: [], actions: ['PM이 판매 채널 데이터 제공 범위를 수면밀도와 확인합니다.'] };
  const top = topBy(rows, (r) => r.revenue)[0];
  const lowCvr = topBy(rows, (r) => -r.cvr)[0];
  const facts = [
    `${w.label} 판매 채널 실매출 ${fmt.krw(rec.sales)}, 광고비 ${fmt.krw(rec.adCost)}, MER ${fmt.dec1(rec.mer)}배입니다. 채널별 매출은 ${rows.map((r) => `${r.name} ${fmt.krw(r.revenue)}(${fmt.ratio(r.share, 0)})`).join(' · ')}입니다. 시연용 테스트 데이터 기준입니다.`,
    `광고 경유 추정 매출은 ${fmt.krw(rec.channelAdRevenue)}, 광고 외 매출은 ${fmt.krw(rec.organicRevenue)}(${fmt.ratio(rec.organicShare, 0)})입니다. 매체 집계 광고 매출은 ${rec.basis}입니다.`,
  ];
  const aovs = rows.map((r) => r.aov).filter(fin);
  const aovList = rows.map((r) => `${r.name} ${fmt.krw(r.aov)}`).join(' · ');
  const aovSpread = aovs.length > 1 && Math.min(...aovs) > 0 ? ((Math.max(...aovs) - Math.min(...aovs)) / Math.min(...aovs)) * 100 : NaN;
  const patterns = [
    `채널 CVR은 ${rows.map((r) => `${r.name} ${fmt.pct(r.cvr, 2)}`).join(' · ')}이며, 객단가는 ${fin(aovSpread) ? `${josa(aovList, '으로/로')} 최고 · 최저 차이가 ${fmt.pct(aovSpread, 0)}입니다` : `${aovList}입니다`}.${fin(aovSpread) && aovSpread < 10 ? ' 객단가 차이가 작으므로 채널 간 매출 차이는 주로 유입 · 전환 수에서 납니다.' : ''}`,
  ];
  const interpretation = [
    !top ? '채널 비중을 판단할 데이터가 부족합니다.'
      : top.channel === 'brandstore'
        ? `${top.name} 비중이 ${fmt.ratio(top.share, 0)}로 가장 커서 네이버 SA · GFA 효율 변화가 실매출에 가장 크게 전달됩니다. 채널 간 잠식이 있을 수 있어 개별 채널 증감보다 합산 매출 기준으로 판단합니다.`
        : `${top.name} 비중이 ${fmt.ratio(top.share, 0)}로 가장 큽니다. 이 채널의 유입이 어떤 매체에서 오는지는 판매 채널 유입 경로 연동 범위에 따라 달라지므로, 채널 간 잠식을 감안해 합산 매출 기준으로 판단합니다.`,
  ];
  if (lowCvr) interpretation.push(`${lowCvr.name} CVR ${fmt.pct(lowCvr.cvr, 2)}는 유입 대비 구매 전환이 가장 낮은 구간으로, 전용 혜택 랜딩 · 리타겟팅 개선의 우선 대상 후보입니다(p.41).`);
  return {
    title, facts, patterns, interpretation,
    conditions: [`광고 경유 매출은 판매 채널 유입 경로 기준 추정치이며 매체 귀속 매출과 기준이 다릅니다. 대조 허용 범위 ±${R.reconTolerancePct}%는 모듈 가정입니다. ${SALES_NOTE_TEXT}`],
    counter: ['광고 외 매출이 늘어도 광고 노출의 지연 효과가 섞여 있으면 광고 감액 시 함께 줄어들 수 있습니다. 홀드아웃 없이 광고 외 매출을 독립 수요로 단정하지 않습니다.'],
    actions: [`데이터 애널리스트가 월간 리포트(${MONTHLY_REPORT_WHEN})에 채널별 매출 기여와 광고 경유 비중 추이를 넣고, PM이 다음 달 채널별 프로모션 · 예산 계획에 반영합니다.`],
  };
}


export function dataBrief(d: Dataset): Brief {
  const s = collectionSummary(d);
  const checks = validationChecks(d);
  const warn = checks.filter((c) => c.level === 'warn');
  const src = sourceStatuses(d);
  const title = `MILDO Board 데이터 수집 · 검증 · ${fmtDate(d.today)} ${s.asOf} 기준`;
  const facts = [
    `전일(${fmtDate(s.batchDate)}) 데이터 수집 · 검증 배치는 ${s.batch.text}${s.batch.missing.length ? `(${s.batch.missing.join(', ')})` : ''}이며, 오늘 시간대 데이터는 ${s.hourlyThrough === null ? '아직 없습니다' : `${s.hourlyThrough}시까지 반영되어 있습니다`}. 광고 매체 ${s.media.ok}/${s.media.total}, 판매 채널 ${s.sales.ok}/${s.sales.total}, 외부 데이터 ${s.external.inDataset}/${s.external.total}이 이 데이터셋에 들어 있습니다. 시연용 테스트 데이터 기준입니다.`,
    `검증 ${checks.length}항목 중 확인 필요 ${warn.length}항목입니다.${warn.length ? ` ${warn.map((c) => `${c.label}: ${c.detail}`).join(' / ')}` : ''}`,
  ];
  const snapshot = src.filter((x) => x.state === 'snapshot');
  const patterns = [
    `광고 매체 · 판매 채널은 날짜 · 채널 키로 묶이고, 키워드는 구매 의도 5분류, 상품은 랜딩 URL과 옵션 라벨로 표준 키에 매핑됩니다.${snapshot.length ? ` ${josa(snapshot.map((x) => x.name).join(', '), '은/는')} 이 데이터셋에 없고 해당 모듈 스냅샷으로 봅니다.` : ''}`,
  ];
  const interpretation = [
    warn.some((c) => c.id === 'zero_conv' || c.id === 'hourly_spike')
      ? '오늘 시간대 신호는 수집 경로의 이상(픽셀 · 집계 지연)인지 실제 성과 변화인지 이 데이터만으로는 구분되지 않습니다. 원인이 확정될 때까지 해당 매체 수치로 자동 조정이나 판정을 하지 않는 것이 안전합니다.'
      : '오늘 시간대 데이터에서 수집 이상 신호는 관측되지 않았습니다.',
  ];
  return {
    title, facts, patterns, interpretation,
    conditions: [`급변 기준은 동요일 · 동시간 ±${R.hourlySpikePct}%(p.44), 전환 0은 ${R.zeroConvStreakHours}시간 연속 + 클릭 기준선 ${Math.round(R.zeroConvClickFloor * 100)}% 이상(모듈 가정)입니다. ${SALES_NOTE_TEXT}`],
    counter: ['전환 0 구간은 실제 수요 공백일 수도 있습니다. 같은 시간 클릭이 정상이고 최근 4주 같은 시간에 매주 전환이 있었다는 점이 추적 단절 쪽 근거이며, 픽셀 점검 결과로 확정합니다.'],
    actions: [warn.length ? '담당 AE가 확인 필요 항목을 MILDO Alert 이슈와 대조해 인지 처리하고, 솔루션 개발자가 수집 경로(픽셀 · API 응답)를 점검해 결과를 이슈 타임라인에 남깁니다.' : '담당 AE가 다음 수집 배치(익일 07:00) 결과를 확인합니다.'],
  };
}

/** AiInsight 프롬프트용 데이터 (작게) */
export function boardPromptPayload(d: Dataset, preset: BoardPeriod): string {
  const k = boardKpis(d, preset);
  const rows = mediaComparison(d, k.win);
  const ch = channelRows(d, k.win);
  const p = budgetPacing(d);
  const kw = keywordRows(d, 14);
  const flagged = kw.filter((r) => r.signals.some((s) => s.id !== 'new'));
  const payload = {
    출처: 'TEST DATA (시연용 테스트 데이터 · 실제 성과 아님)',
    기준: { 기준일: d.today, 기준시각: asOfClock(d), 목표ROAS: R.targetRoas, 브랜드목표ROAS: R.brandTargetRoas, 변동판정: `ROAS −${R.roasDropWarnPct}/−${R.roasDropDangerPct}% · CPA +${R.cpaRiseWarnPct}/+${R.cpaRiseDangerPct}% · 광고비 ±${R.costSwingWarnPct}/±${R.costSwingDangerPct}% (p.47 준용)` },
    기간: { 이름: k.win.label, 범위: `${k.win.from}~${k.win.to}`, 직전: `${k.win.prevFrom}~${k.win.prevTo}`, 오늘부분일포함: k.win.includesToday },
    KPI: {
      광고비: r0(k.cur.cost), 광고비증감pct: r1(k.deltas.cost), 광고매출: r0(k.cur.revenue), ROAS: r0(k.cur.roas), ROAS증감pct: r1(k.deltas.roas),
      실매출: r0(k.sales), 실매출증감pct: r1(k.deltas.sales), MER배: r2(k.mer), 직전MER배: r2(k.prevMer), 광고경유비중pct: r1(k.adShareOfSales * 100),
      CPA: r0(k.cur.cpa), CPA증감pct: r1(k.deltas.cpa), CVRpct: r2(k.cur.cvr), 신규CAC: r0(k.cur.cac), 신규고객: r0(k.cur.newCustomers),
    },
    매체: rows.map((r) => ({ 매체: r.name, 역할: r.role, 판단지표: r.judgeMetric, 광고비: r0(r.cost), 비중pct: r1(r.share * 100), 가안비중pct: r1(r.planShare * 100), ROAS: r0(r.roas), CPA: r0(r.cpa), CVRpct: r2(r.cvr), 신규비중pct: r1(r.newShare * 100), ROAS증감pct: r1(r.deltas.roas), 판정: `${r.flag.label} · ${r.flag.basis}` })),
    판매채널: ch.map((c) => ({ 채널: c.name, 매출: r0(c.revenue), 비중pct: r1(c.share * 100), 주문: r0(c.orders), CVRpct: r2(c.cvr), 객단가: r0(c.aov), 광고경유pct: r1(c.adShare * 100), 매출증감pct: r1(c.revenueDelta) })),
    예산: { 월소진pct: r1(p.month.pacePct), 예상월말pct: r1(p.month.projectedPct), 조기소진: p.early.map((c) => `${c.name} ${clock(c.exhaustHour)} · ${c.basis}`) },
    키워드신호: flagged.slice(0, 10).map((r) => ({ 키워드: r.text, 신호: r.signals.filter((s) => s.id !== 'new').map((s) => `${s.label}: ${s.basis}`) })),
  };
  return JSON.stringify(payload);
}

export function boardPrompt(d: Dataset, preset: BoardPeriod): string {
  return [
    '과제: MILDO Board(Pro-board) 화면의 선택 기간 성과를 해석한다. 매체 통합 성과, 판매 채널 실매출(MER), 예산 소진, 키워드 신호를 함께 본다.',
    '해석 축: CAC 회수 구조(MER · 신규 CAC), 매체의 퍼널 역할(p.37 역할 · 판단 지표), 단기 성과와 중장기 효율 분리, 확장 시 비용 구조 변화.',
    '데이터는 시연용 테스트 데이터다. 수치를 인용할 때 TEST DATA임을 밝힌다. 판단마다 기준값과 반례를 붙인다.',
    `데이터(JSON): ${boardPromptPayload(d, preset)}`,
  ].join('\n');
}
