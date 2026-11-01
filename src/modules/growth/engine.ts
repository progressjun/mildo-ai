/**
 * 매출 성장 고도화 엔진 — 제안서 p.30–42. 순수 함수만 둔다 (React import 금지).
 *  - 예산 배분 · 한계 효율 재배분 (p.37): 로그-로그 반응 곡선 적합 → 한계 ROAS → 균등화 재배분 (가드레일 · 볼륨 한계)
 *  - DA → SA 전환 기여 (p.40): 시차 상관 · 분산 시차 회귀 · 홀드아웃 설계 · 대표 키워드 기여
 *  - 브랜드스토어 · 자사몰 전환 개선 (p.41): 퍼널 · 단계 진단 · 랜딩 점검 · 채널 간 잠식
 *  - 타겟 그룹 (p.34) · SA 캠페인 구조 (p.35) · SKU 확장 (p.36) · 신규 매체 (p.38) · 코프로모션 (p.39) · 캘린더 (p.42)
 * 모든 성과 수치는 Dataset(시연용 테스트 데이터)에서 계산한다. 빈 데이터 · 0 나누기 · NaN을 방어한다.
 */
import type { AdAccount, ApprovalLevel, Campaign, ChangeKind, ChangeRequest, DailyMediaRow, Dataset, IntentId, Keyword, MediaId, SalesChannelId } from '@/core/types';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, CO_PROMOTIONS, GROWTH_CALENDAR, INTENT_IDS, MEDIA, MEDIA_IDS, NEW_MEDIA_PILOT, RFP, SA_AUTOMATION_SCOPE, SA_CAMPAIGNS,
  SALES_CHANNELS, SKU_EXPANSION, TARGET_GROUPS,
} from '@/data/constants';
import { addDays, clamp, fmt, linreg, mean, normCdf, parseDate, pearson, stdev, sum, weekday } from '@/core/util';
// 일 예산 소진 · 캠페인 효율은 MILDO Board · AD Pilot · 커맨드 센터와 같은 계산을 쓴다 (같은 숫자는 같은 계산)
import { campaignEfficiency, hourlyCostCurve, paceCampaigns, resolveConfig } from '@/modules/adpilot/engine';
import {
  ALLOCATION_GUARDRAILS, CALENDAR_LINKS, CO_PROMO_KEYWORDS, CURVE_PRIORS, CURVE_WINDOW_DAYS, DA_SA_MAX_LAG, DA_SHARE_ASSUMPTION, FUNNEL_PLAYBOOK,
  FUNNEL_RULES, GROWTH_FORMULA, HOLDOUT_UNITS, LANDING_TYPES, MEDIA_PARTNERSHIPS, NAVER_TRIPARTITE, NEW_MEDIA_CPA_MULT, NEW_MEDIA_SCORES, PACE_RULES, PILOT_DEFAULTS,
  QUARTER_START, REBALANCE_RULES, SA_CPC_INFLATION, TARGET_GROUP_LINKS, type FunnelStage, type HoldoutUnitId,
} from './data';

/* ================================ 공통 ================================ */

const fin = (v: number): boolean => Number.isFinite(v);
export const safeDiv = (a: number, b: number): number => (fin(a) && fin(b) && b !== 0 ? a / b : NaN);
const pctOf = (a: number, b: number): number => safeDiv(a, b) * 100;
/** 증감률 (%) — 기준 0이면 NaN */
export const deltaPct = (cur: number, prev: number): number => (fin(cur) && fin(prev) && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : NaN);
const round = (v: number, digits = 0): number => (fin(v) ? Math.round(v * 10 ** digits) / 10 ** digits : NaN);
/** 소수 둘째 자리 문자열 (NaN → '—') */
export const f2 = (v: number): string => (fin(v) ? v.toFixed(2) : '—');
/** 정수 % 표기 — 계산 불가(NaN)면 '—' ('—%'로 보이지 않게) */
export const pctInt = (v: number): string => (fin(v) ? `${fmt.int(v)}%` : '—');

/** 기준일(오늘, 부분일)을 뺀 완결 일자 */
export function completeDates(d: Dataset): string[] {
  return d.dates.filter((x) => x < d.today);
}
/** 완결 일자 중 마지막 n일 */
export function lastDays(d: Dataset, n: number): string[] {
  const c = completeDates(d);
  return c.slice(Math.max(0, c.length - Math.max(0, Math.floor(n))));
}
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
}

const dayIndexCache = new WeakMap<Dataset, Map<string, DailyMediaRow>>();
function mediaDay(d: Dataset, date: string, m: MediaId): DailyMediaRow | undefined {
  let idx = dayIndexCache.get(d);
  if (!idx) {
    idx = new Map();
    for (const r of d.mediaDaily) idx.set(`${r.date}|${r.media}`, r);
    dayIndexCache.set(d, idx);
  }
  return idx.get(`${date}|${m}`);
}

/** 표준정규 역함수 (normCdf 이분 탐색) */
export function normInv(p: number): number {
  if (!fin(p) || p <= 0 || p >= 1) return NaN;
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 다중 회귀 (절편 포함 X를 받는다) — 계수 · 표준오차 · R² */
export function ols(X: number[][], y: number[]): { coef: number[]; se: number[]; r2: number; n: number } | null {
  const n = Math.min(X.length, y.length);
  const k = X[0]?.length ?? 0;
  if (n <= k + 1 || k === 0) return null;
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gauss-Jordan 역행렬
  const aug = xtx.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
    if (Math.abs(aug[piv][c]) < 1e-12) return null;
    [aug[c], aug[piv]] = [aug[piv], aug[c]];
    const pv = aug[c][c];
    for (let j = 0; j < 2 * k; j++) aug[c][j] /= pv;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = aug[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j++) aug[r][j] -= f * aug[c][j];
    }
  }
  const inv = aug.map((row) => row.slice(k));
  const coef = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const my = mean(y.slice(0, n));
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = X[i].reduce((s, v, j) => s + v * coef[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const s2 = ssRes / (n - k);
  const se = inv.map((row, i) => Math.sqrt(Math.max(0, row[i] * s2)));
  return { coef, se, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, n };
}

/* ======================= p.37 반응 곡선 · 한계 ROAS ======================= */

export interface LogLogFit { n: number; b: number; a: number; se: number; r2: number; ciLow: number; ciHigh: number }

/** ln(매출) = ln(a) + b · ln(광고비) — 광고비 · 매출이 양수인 날만 */
export function fitLogLog(costs: readonly number[], revenues: readonly number[]): LogLogFit {
  const xs: number[] = [];
  const ys: number[] = [];
  const n0 = Math.min(costs.length, revenues.length);
  for (let i = 0; i < n0; i++) {
    if (costs[i] > 0 && revenues[i] > 0 && fin(costs[i]) && fin(revenues[i])) {
      xs.push(Math.log(costs[i]));
      ys.push(Math.log(revenues[i]));
    }
  }
  const n = xs.length;
  const none: LogLogFit = { n, b: NaN, a: NaN, se: NaN, r2: NaN, ciLow: NaN, ciHigh: NaN };
  if (n < 5) return none;
  const mx = mean(xs);
  const sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
  if (!(sxx > 1e-12)) return none;
  const f = linreg(xs, ys);
  const s2 = xs.reduce((s, v, i) => s + (ys[i] - (f.a + f.b * v)) ** 2, 0) / (n - 2);
  const se = Math.sqrt(s2 / sxx);
  return { n, b: f.b, a: Math.exp(f.a), se, r2: f.r2, ciLow: f.b - 1.96 * se, ciHigh: f.b + 1.96 * se };
}

export type BSource = 'data' | 'prior' | 'manual';
export interface ResponseCurve {
  media: MediaId;
  days: number;
  avgDailyCost: number;
  avgDailyRevenue: number;
  /** 일 광고비 변동계수 (표준편차 / 평균) — 곡선 식별 가능 범위 */
  costCv: number;
  /** 관측 평균 ROAS (%) */
  roas: number;
  fit: LogLogFit;
  /** 데이터로 체감(b<1)이 통계적으로 확인됐는지 (95% 상한 < 1) */
  identified: boolean;
  identifyNote: string;
  priorB: number;
  priorWhy: string;
  b: number;
  bSource: BSource;
  /** 현재 운영점(평균 일 광고비 · 매출)을 지나도록 보정한 계수 */
  a: number;
  capMult: number;
  capDaily: number;
  capBasis: string;
  valid: boolean;
  /** DA→SA 기여 반영 시 메모 */
  creditNote?: string;
}

export const B_RANGE = { min: 0.2, max: 0.95 } as const;

/** SA 볼륨 한계: 노출 기회 손실 회수(1/(1−손실률)) × CPC 상승 가정 */
export function saVolumeCap(d: Dataset): { mult: number; lostShare: number; basis: string } {
  const kws = d.keywords.filter((k) => k.status !== 'off');
  const imps = sum(kws, (k) => k.last14.impressions);
  const lost = imps > 0 ? sum(kws, (k) => k.impressionShareLost * k.last14.impressions) / imps : NaN;
  if (!fin(lost) || lost < 0 || lost >= 0.95) {
    return { mult: 1.5, lostShare: NaN, basis: '키워드 노출 데이터 없음 → 현재 광고비의 1.5배 가정' };
  }
  const mult = (1 / (1 - lost)) * SA_CPC_INFLATION;
  return { mult, lostShare: lost, basis: `노출 기회 손실 ${fmt.ratio(lost)} 회수 × CPC +${Math.round((SA_CPC_INFLATION - 1) * 100)}% 가정 → 현재의 ${fmt.dec1(mult)}배` };
}

export function fitResponseCurves(d: Dataset, opts: { days?: number; bOverride?: Partial<Record<MediaId, number>> } = {}): ResponseCurve[] {
  const days = opts.days ?? CURVE_WINDOW_DAYS;
  const dates = lastDays(d, days);
  const sa = saVolumeCap(d);
  return MEDIA_IDS.map((m) => {
    const rows = dates.map((dt) => mediaDay(d, dt, m)).filter((r): r is DailyMediaRow => !!r);
    const costs = rows.map((r) => r.cost);
    const revs = rows.map((r) => r.revenue);
    const avgC = rows.length ? mean(costs) : NaN;
    const avgR = rows.length ? mean(revs) : NaN;
    const fit = fitLogLog(costs, revs);
    const identified = fin(fit.b) && fin(fit.ciHigh) && fit.ciHigh < 1 && fit.b > B_RANGE.min;
    const prior = CURVE_PRIORS[m];
    const override = opts.bOverride?.[m];
    let b: number;
    let bSource: BSource;
    if (override !== undefined && fin(override)) {
      b = clamp(override, 0.05, 0.98);
      bSource = 'manual';
    } else if (identified) {
      b = clamp(fit.b, B_RANGE.min, B_RANGE.max);
      bSource = 'data';
    } else {
      b = prior.b;
      bSource = 'prior';
    }
    const identifyNote = !fin(fit.b)
      ? `표본 부족 (${fit.n}일) — 적합 불가`
      : identified
        ? `체감 확인 — 적합 b ${f2(fit.b)} · 95% 상한 ${f2(fit.ciHigh)} < 1`
        : `체감 미식별 — 적합 b ${f2(fit.b)} (95% 구간 ${f2(fit.ciLow)}~${f2(fit.ciHigh)})가 1을 포함하거나 넘음 · 일 광고비 변동폭이 좁아 곡선 형태를 데이터로 확정할 수 없음`;
    const valid = fin(avgC) && fin(avgR) && avgC > 0 && avgR > 0;
    const a = valid ? avgR / Math.pow(avgC, b) : NaN;
    const capMult = m === 'naver_sa' ? sa.mult : prior.capMult ?? 2;
    return {
      media: m, days: rows.length, avgDailyCost: avgC, avgDailyRevenue: avgR, costCv: rows.length >= 2 && avgC > 0 ? stdev(costs) / avgC : NaN, roas: pctOf(avgR, avgC), fit, identified, identifyNote,
      priorB: prior.b, priorWhy: prior.why, b, bSource, a, capMult, capDaily: valid ? avgC * capMult : NaN,
      capBasis: m === 'naver_sa' ? sa.basis : `현재 일 광고비의 ${fmt.dec1(capMult)}배 (${prior.why}) — 가정`,
      valid,
    };
  });
}

/** 일 광고비 s에서의 일 매출 (볼륨 한계 이후는 증가 없음) */
export function curveRevenue(c: ResponseCurve, dailySpend: number): number {
  if (!c.valid || !fin(c.a)) return NaN;
  if (!(dailySpend > 0)) return 0;
  return c.a * Math.pow(Math.min(dailySpend, c.capDaily), c.b);
}
/** 한계 ROAS (원/원) = dR/ds = a · b · s^(b−1). 볼륨 한계 이상이면 0 */
export function curveMarginal(c: ResponseCurve, dailySpend: number): number {
  if (!c.valid || !fin(c.a)) return NaN;
  if (dailySpend >= c.capDaily) return 0;
  return c.a * c.b * Math.pow(Math.max(dailySpend, 1), c.b - 1);
}

/* ---------------- 배분 평가 ---------------- */

export type Shares = Record<MediaId, number>;
export type Guardrails = Record<MediaId, { min: number; max: number }>;

/**
 * 가드레일 입력 점검 — 최소 > 최대, 최소 합계 > 100%, 최대 합계 < 100%이면 가드레일 안에서 예산을 모두 배분할 수 없다
 * (균등화는 가드레일을 해제해 계산하므로 화면에서 입력 오류로 알려 준다).
 */
export function guardrailIssues(guard: Guardrails): string[] {
  const out: string[] = [];
  const inverted = MEDIA_IDS.filter((m) => (guard[m]?.min ?? 0) > (guard[m]?.max ?? 1) + 1e-9);
  if (inverted.length) out.push(`${inverted.map((m) => MEDIA[m].short).join(' · ')} 최소 > 최대`);
  const minSum = sum(MEDIA_IDS, (m) => guard[m]?.min ?? 0);
  const maxSum = sum(MEDIA_IDS, (m) => guard[m]?.max ?? 1);
  if (minSum > 1 + 1e-9) out.push(`최소 합계 ${fmt.int(minSum * 100)}% > 100%`);
  if (maxSum < 1 - 1e-9) out.push(`최대 합계 ${fmt.int(maxSum * 100)}% < 100%`);
  return out;
}
/** p.37 배분 가안 (SA 43% · GFA 18% · Google 12% · Meta 12% · 카카오 8% · 버티컬 7%) */
export const PROPOSAL_SHARES: Shares = Object.fromEntries(MEDIA_IDS.map((m) => [m, MEDIA[m].share])) as Shares;

export function normalizeShares(s: Partial<Record<MediaId, number>>): Shares {
  const raw = MEDIA_IDS.map((m) => Math.max(0, fin(s[m] ?? NaN) ? (s[m] as number) : 0));
  const tot = raw.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return { ...PROPOSAL_SHARES };
  return Object.fromEntries(MEDIA_IDS.map((m, i) => [m, raw[i] / tot])) as Shares;
}

/** 한 매체 비중을 바꾸면 나머지를 기존 비율대로 조정해 합계 100%를 유지 */
export function rebalanceShares(shares: Shares, media: MediaId, value: number): Shares {
  const v = clamp(fin(value) ? value : 0, 0, 1);
  const others = MEDIA_IDS.filter((m) => m !== media);
  const rest = sum(others, (m) => Math.max(0, shares[m] ?? 0));
  const out = { ...shares, [media]: v } as Shares;
  const remain = 1 - v;
  for (const m of others) out[m] = rest > 0 ? (Math.max(0, shares[m] ?? 0) / rest) * remain : remain / others.length;
  return out;
}

export interface MediaOutcome {
  media: MediaId;
  share: number;
  annualSpend: number;
  dailySpend: number;
  annualRevenue: number;
  roas: number;
  /** 한계 ROAS (%) */
  marginalRoas: number;
  capped: boolean;
  overCapAnnual: number;
  guard: { min: number; max: number };
  guardFlag: 'below' | 'above' | null;
}
export interface AllocationEval {
  budget: number;
  rows: MediaOutcome[];
  totalRevenue: number;
  totalRoas: number;
  spread: { max: number; min: number; maxMedia: MediaId | null; minMedia: MediaId | null; gapPct: number };
  capped: MediaId[];
  guardViolations: MediaId[];
  valid: boolean;
}

export function evaluateAllocation(curves: readonly ResponseCurve[], shares: Shares, budget: number, guard: Guardrails = ALLOCATION_GUARDRAILS): AllocationEval {
  const B = fin(budget) && budget > 0 ? budget : 0;
  const rows: MediaOutcome[] = MEDIA_IDS.map((m) => {
    const c = curves.find((x) => x.media === m);
    const share = Math.max(0, shares[m] ?? 0);
    const annualSpend = B * share;
    const daily = annualSpend / 365;
    const rev = c ? curveRevenue(c, daily) * 365 : NaN;
    const marg = c ? curveMarginal(c, daily) * 100 : NaN;
    const capped = !!c && c.valid && daily > c.capDaily;
    const g = guard[m] ?? { min: 0, max: 1 };
    const eps = 1e-6;
    return {
      media: m, share, annualSpend, dailySpend: daily, annualRevenue: rev, roas: pctOf(rev, annualSpend), marginalRoas: marg,
      capped, overCapAnnual: capped && c ? (daily - c.capDaily) * 365 : 0, guard: g,
      guardFlag: share < g.min - eps ? 'below' : share > g.max + eps ? 'above' : null,
    };
  });
  const validRows = rows.filter((r) => fin(r.annualRevenue));
  const totalRevenue = validRows.length ? sum(validRows, (r) => r.annualRevenue) : NaN;
  const spendCovered = sum(validRows, (r) => r.annualSpend);
  const mr = rows.filter((r) => fin(r.marginalRoas) && r.share > 0);
  const maxR = mr.reduce<MediaOutcome | null>((a, r) => (!a || r.marginalRoas > a.marginalRoas ? r : a), null);
  const minR = mr.reduce<MediaOutcome | null>((a, r) => (!a || r.marginalRoas < a.marginalRoas ? r : a), null);
  return {
    budget: B, rows, totalRevenue, totalRoas: pctOf(totalRevenue, spendCovered),
    spread: {
      max: maxR?.marginalRoas ?? NaN, min: minR?.marginalRoas ?? NaN, maxMedia: maxR?.media ?? null, minMedia: minR?.media ?? null,
      gapPct: maxR && minR ? deltaPct(maxR.marginalRoas, minR.marginalRoas) : NaN,
    },
    capped: rows.filter((r) => r.capped).map((r) => r.media),
    guardViolations: rows.filter((r) => r.guardFlag).map((r) => r.media),
    valid: validRows.length > 0 && B > 0,
  };
}

/* ---------------- 한계 효율 균등화 ---------------- */

export type BindReason = 'min' | 'max' | 'step' | 'cap' | 'fixed';
export interface EqualizeResult {
  shares: Shares;
  /** 균등화된 한계 ROAS (%) */
  marginalRoas: number;
  binding: Record<MediaId, BindReason | null>;
  relaxed: ('step' | 'guard')[];
  feasible: boolean;
  note: string;
}

export function equalizeMarginal(
  curves: readonly ResponseCurve[], budget: number,
  opts: { base?: Shares; guard?: Guardrails; stepCapPct?: number | null } = {},
): EqualizeResult {
  const base = normalizeShares(opts.base ?? PROPOSAL_SHARES);
  const guard = opts.guard ?? ALLOCATION_GUARDRAILS;
  const stepCap = opts.stepCapPct === undefined ? REBALANCE_RULES.stepCapPct : opts.stepCapPct;
  const nullBind = Object.fromEntries(MEDIA_IDS.map((m) => [m, null])) as Record<MediaId, BindReason | null>;
  const B = fin(budget) && budget > 0 ? budget : 0;
  const curveOf = (m: MediaId) => curves.find((c) => c.media === m && c.valid && fin(c.a));
  if (!B || !MEDIA_IDS.some((m) => curveOf(m))) {
    return { shares: base, marginalRoas: NaN, binding: nullBind, relaxed: [], feasible: false, note: '반응 곡선을 적합할 데이터가 없습니다 — 가안 배분 유지' };
  }
  type Bound = { m: MediaId; lo: number; hi: number; loWhy: BindReason; hiWhy: BindReason };
  const build = (useStep: boolean, useGuard: boolean): Bound[] => MEDIA_IDS.map((m) => {
    const c = curveOf(m);
    if (!c) return { m, lo: base[m] * B, hi: base[m] * B, loWhy: 'fixed', hiWhy: 'fixed' };
    let lo = 0;
    let hi = B;
    let loWhy: BindReason = 'min';
    let hiWhy: BindReason = 'max';
    if (useGuard) {
      lo = (guard[m]?.min ?? 0) * B;
      hi = (guard[m]?.max ?? 1) * B;
    }
    if (useStep && stepCap !== null && fin(stepCap)) {
      const sLo = base[m] * B * (1 - stepCap / 100);
      const sHi = base[m] * B * (1 + stepCap / 100);
      if (sLo > lo) { lo = sLo; loWhy = 'step'; }
      if (sHi < hi) { hi = sHi; hiWhy = 'step'; }
    }
    const capA = c.capDaily * 365;
    if (fin(capA) && capA < hi) { hi = capA; hiWhy = 'cap'; }
    if (lo > hi) lo = hi;
    return { m, lo, hi, loWhy, hiWhy };
  });
  const tries: { step: boolean; guard: boolean; relaxed: ('step' | 'guard')[] }[] = [
    { step: true, guard: true, relaxed: [] }, { step: false, guard: true, relaxed: ['step'] }, { step: false, guard: false, relaxed: ['step', 'guard'] },
  ];
  let bounds: Bound[] | null = null;
  let relaxed: ('step' | 'guard')[] = [];
  for (const t of tries) {
    const bd = build(t.step, t.guard);
    const sLo = sum(bd, (x) => x.lo);
    const sHi = sum(bd, (x) => x.hi);
    if (sLo <= B * (1 + 1e-9) && sHi >= B * (1 - 1e-9)) { bounds = bd; relaxed = t.relaxed; break; }
  }
  if (!bounds) {
    const bd = build(false, false);
    const sHi = sum(bd, (x) => x.hi);
    const sh = Object.fromEntries(bd.map((x) => [x.m, sHi > 0 ? x.hi / sHi : base[x.m]])) as Shares;
    return { shares: sh, marginalRoas: NaN, binding: Object.fromEntries(bd.map((x) => [x.m, 'cap'])) as Record<MediaId, BindReason | null>, relaxed: ['step', 'guard'], feasible: false, note: `매체별 볼륨 한계 합계(${fmt.krw(sHi)})가 예산(${fmt.krw(B)})보다 작습니다 — 초과분은 매출로 이어지지 않는 시나리오` };
  }
  const bd = bounds;
  const spendAt = (lam: number): number[] => bd.map((x) => {
    const c = curveOf(x.m);
    if (!c || x.lo === x.hi) return x.lo;
    const daily = Math.pow((c.a * c.b) / lam, 1 / (1 - c.b));
    return clamp(daily * 365, x.lo, x.hi);
  });
  let lo = 1e-8;
  let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (sum(spendAt(mid), (v) => v) > B) lo = mid;
    else hi = mid;
  }
  const lam = Math.sqrt(lo * hi);
  const spends = spendAt(lam);
  // 반올림 잔차를 경계에 걸리지 않은 매체에 비례 배분
  const resid = B - sum(spends, (v) => v);
  const interior = bd.map((x, i) => (spends[i] > x.lo + 1 && spends[i] < x.hi - 1 ? i : -1)).filter((i) => i >= 0);
  const inSum = sum(interior, (i) => spends[i]);
  if (Math.abs(resid) > 0 && inSum > 0) for (const i of interior) spends[i] += (resid * spends[i]) / inSum;
  const tol = B * 1e-6;
  const binding = Object.fromEntries(bd.map((x, i) => [x.m, x.lo === x.hi ? x.loWhy : spends[i] <= x.lo + tol ? x.loWhy : spends[i] >= x.hi - tol ? x.hiWhy : null])) as Record<MediaId, BindReason | null>;
  const shares = Object.fromEntries(bd.map((x, i) => [x.m, spends[i] / B])) as Shares;
  const note = relaxed.length === 0
    ? `가드레일 · 1회 재배분 폭 ±${stepCap ?? '—'}% · 볼륨 한계 안에서 한계 ROAS 균등화`
    : relaxed.includes('guard')
      ? '가드레일 안에서는 예산을 모두 배분할 수 없어 가드레일을 해제한 결과 — 구조 리뷰 필요'
      : '1회 재배분 폭 상한 안에서는 합계가 맞지 않아 상한을 해제한 결과 (분기 구조 리뷰 대상)';
  return { shares, marginalRoas: lam * 100, binding, relaxed, feasible: true, note };
}

/* ---------------- DA → SA 기여 반영 ---------------- */

/** GFA 곡선에 SA 경유 매출(halo)을 얹고, 같은 금액을 SA 곡선에서 빼서 운영점 합계를 유지 */
export function applyDaSaCredit(curves: readonly ResponseCurve[], haloRoas: number): ResponseCurve[] {
  const gfa = curves.find((c) => c.media === 'naver_gfa');
  const sa = curves.find((c) => c.media === 'naver_sa');
  if (!gfa?.valid || !sa?.valid || !(haloRoas > 0) || !fin(haloRoas)) return curves.slice();
  const haloDaily = (gfa.avgDailyCost * haloRoas) / 100;
  const moved = Math.min(haloDaily, sa.avgDailyRevenue * 0.8);
  const gRev = gfa.avgDailyRevenue + moved;
  const sRev = sa.avgDailyRevenue - moved;
  return curves.map((c) => {
    if (c.media === 'naver_gfa') return { ...c, a: c.a * (gRev / c.avgDailyRevenue), avgDailyRevenue: gRev, roas: pctOf(gRev, c.avgDailyCost), creditNote: `SA 경유 매출 일 ${fmt.krw(moved)} 가산 (METHOD 1 · 3 추정)` };
    if (c.media === 'naver_sa') return { ...c, a: c.a * (sRev / c.avgDailyRevenue), avgDailyRevenue: sRev, roas: pctOf(sRev, c.avgDailyCost), creditNote: `GFA 경유분 일 ${fmt.krw(moved)} 차감` };
    return c;
  });
}

/* ---------------- 시뮬레이터 묶음 ---------------- */

export interface AllocationInput {
  budget?: number;
  shares?: Partial<Record<MediaId, number>>;
  bOverride?: Partial<Record<MediaId, number>>;
  guard?: Guardrails;
  stepCapPct?: number | null;
  daSaCredit?: boolean;
}
export interface AllocationModel {
  budget: number;
  curves: ResponseCurve[];
  baseline: AllocationEval;
  scenario: AllocationEval;
  optimized: AllocationEval;
  equalize: EqualizeResult;
  scenarioShares: Shares;
  upliftScenario: number;
  upliftScenarioPct: number;
  upliftOptimized: number;
  upliftOptimizedPct: number;
  /** b ±0.1 민감도: 균등화안 증분 범위 · 증감 방향 유지 여부 */
  sensitivity: { low: number; high: number; lowPct: number; highPct: number; stable: boolean; flipped: MediaId[] };
  credit: { on: boolean; haloRoas: number; basis: string };
  identifiedCount: number;
}

function curvesFor(d: Dataset, input: AllocationInput, haloRoas: number, shift = 0): ResponseCurve[] {
  let curves = fitResponseCurves(d, { bOverride: input.bOverride });
  if (shift !== 0) curves = fitResponseCurves(d, { bOverride: Object.fromEntries(curves.map((c) => [c.media, c.b + shift])) });
  return input.daSaCredit ? applyDaSaCredit(curves, haloRoas) : curves;
}

export function allocationModel(d: Dataset, input: AllocationInput = {}): AllocationModel {
  const budget = fin(input.budget ?? NaN) && (input.budget as number) > 0 ? (input.budget as number) : RFP.annualBudget;
  const guard = input.guard ?? ALLOCATION_GUARDRAILS;
  const stepCapPct = input.stepCapPct === undefined ? REBALANCE_RULES.stepCapPct : input.stepCapPct;
  const halo = input.daSaCredit ? daSaAnalysis(d).halo : null;
  const haloRoas = halo?.haloRoas ?? NaN;
  const curves = curvesFor(d, input, haloRoas);
  const baseline = evaluateAllocation(curves, PROPOSAL_SHARES, budget, guard);
  const scenarioShares = input.shares ? normalizeShares({ ...PROPOSAL_SHARES, ...input.shares }) : { ...PROPOSAL_SHARES };
  const scenario = evaluateAllocation(curves, scenarioShares, budget, guard);
  const equalize = equalizeMarginal(curves, budget, { base: PROPOSAL_SHARES, guard, stepCapPct });
  const optimized = evaluateAllocation(curves, equalize.shares, budget, guard);
  const ups: number[] = [];
  const upsPct: number[] = [];
  const dir = (s: Shares, m: MediaId) => Math.sign(Math.round((s[m] - PROPOSAL_SHARES[m]) * 1000));
  const flipped = new Set<MediaId>();
  for (const shift of [-0.1, 0.1]) {
    const cv = curvesFor(d, input, haloRoas, shift);
    const b0 = evaluateAllocation(cv, PROPOSAL_SHARES, budget, guard);
    const eq = equalizeMarginal(cv, budget, { base: PROPOSAL_SHARES, guard, stepCapPct });
    const o = evaluateAllocation(cv, eq.shares, budget, guard);
    ups.push(o.totalRevenue - b0.totalRevenue);
    upsPct.push(deltaPct(o.totalRevenue, b0.totalRevenue));
    if (equalize.feasible && eq.feasible) for (const m of MEDIA_IDS) if (dir(eq.shares, m) !== dir(equalize.shares, m)) flipped.add(m);
  }
  const fins = ups.filter(fin);
  const finsPct = upsPct.filter(fin);
  return {
    budget, curves, baseline, scenario, optimized, equalize, scenarioShares,
    upliftScenario: scenario.totalRevenue - baseline.totalRevenue,
    upliftScenarioPct: deltaPct(scenario.totalRevenue, baseline.totalRevenue),
    upliftOptimized: optimized.totalRevenue - baseline.totalRevenue,
    upliftOptimizedPct: deltaPct(optimized.totalRevenue, baseline.totalRevenue),
    sensitivity: {
      low: fins.length ? Math.min(...fins) : NaN, high: fins.length ? Math.max(...fins) : NaN,
      lowPct: finsPct.length ? Math.min(...finsPct) : NaN, highPct: finsPct.length ? Math.max(...finsPct) : NaN,
      stable: flipped.size === 0, flipped: [...flipped],
    },
    credit: { on: !!input.daSaCredit && fin(haloRoas), haloRoas, basis: halo?.basis ?? '' },
    identifiedCount: curves.filter((c) => c.identified).length,
  };
}

/* ---------------- 일 예산 조기 소진 → 예산 제약 신호 (재배분 입력) ---------------- */

export type ConstraintVerdict = 'raise' | 'hold' | 'bid';
export const CONSTRAINT_LABEL: Record<ConstraintVerdict, string> = { raise: '증액 후보', hold: '증액 보류', bid: '입찰 조정 우선' };
/** 증액 보류 사유: 계정 · 결제 / 매체 광고비 급변 / 캠페인 내 키워드 CPC 급등 */
export type HoldKind = 'account' | 'spike' | 'cpc';
export interface HourlyDelta { deltaPct: number; hours: number[]; observed: number; baseline: number; baselineDays: number }
export interface BudgetConstraint {
  id: string;
  campaign: string;
  media: MediaId;
  intent?: IntentId;
  dailyBudget: number;
  spentToday: number;
  pacePct: number;
  /** 예상 마감 시각 — MILDO Board · AD Pilot과 같은 값 (시간대 가중이 기준 전이면 그 값, 아니면 선형) */
  exhaustHour: number | null;
  exhaustMethod: '시간대 가중' | '선형' | null;
  /** 21~23시 저녁 피크 전 마감 */
  missesPeak: boolean;
  /** 최근 28일 같은 매체 시간대 곡선상 지금까지의 기대 소진 비율 (0~1) */
  expectedShare: number;
  /** 소진 배수 = 현재 소진율 ÷ 기대 소진 비율 (오늘 예상 수요 ÷ 일 예산) */
  paceIndex: number;
  /** 예상 수요 − 일 예산 (원, 0 이상) */
  shortfall: number;
  /** 최근 시간대 광고비 — 최근 4주 같은 요일 · 같은 시간 평균 대비 */
  recent: HourlyDelta;
  /** 캠페인 효율 (AD Pilot campaignEfficiency: SA는 의도 키워드 14일, 그 외 매체 14일) */
  campaignRoas: number;
  campaignTarget: number;
  campaignRatioPct: number;
  campaignEfficient: boolean;
  /** 가안 운영점의 매체 한계 ROAS (%) */
  marginalRoas: number;
  /** 균등화 한계 ROAS (%) — 증액 판단 기준 */
  threshold: number;
  verdict: ConstraintVerdict;
  holdKind: HoldKind | null;
  basis: string;
}

/**
 * 최근 n시간(현재 시각 포함) 매체 광고비 vs 최근 4주 같은 요일 · 같은 시간 평균 (p.47 '동요일 · 동시간' 기준선).
 * 시간별 데이터가 없으면 NaN.
 */
export function recentHourlyDelta(d: Dataset, m: MediaId, hours = 2): HourlyDelta {
  const n = Math.max(1, Math.floor(hours));
  const hrs = Array.from({ length: n }, (_, i) => d.currentHour - n + 1 + i).filter((h) => h >= 0);
  const hs = new Set(hrs);
  const wd = weekday(d.today);
  const rows = d.mediaHourly.filter((r) => r.media === m && hs.has(r.hour));
  const todayRows = rows.filter((r) => r.date === d.today);
  const past = Array.from(new Set(rows.filter((r) => r.date < d.today && r.weekday === wd).map((r) => r.date))).sort().slice(-4);
  const base = past.map((dt) => sum(rows.filter((r) => r.date === dt), (r) => r.cost));
  const observed = sum(todayRows, (r) => r.cost);
  const baseline = base.length ? mean(base) : NaN;
  return { deltaPct: todayRows.length ? deltaPct(observed, baseline) : NaN, hours: hrs, observed, baseline, baselineDays: base.length };
}

/** 캠페인 → 광고 계정 (매체 일치, 버티컬은 캠페인명 접두사로 쿠팡 · 오늘의집 계정) */
export function accountForCampaign(d: Dataset, c: Pick<Campaign, 'media' | 'name'>): AdAccount | undefined {
  const direct = d.accounts.find((a) => a.media === c.media);
  if (direct) return direct;
  if (c.media === 'vertical') {
    if (/^쿠팡/.test(c.name)) return d.accounts.find((a) => a.media === 'coupang');
    if (/^오늘의집/.test(c.name)) return d.accounts.find((a) => a.media === 'ohouse');
  }
  return undefined;
}
/** 잔액 소진 예상 일수 (후불 · 소진 기준 없음이면 Infinity) */
export function accountRunway(a: AdAccount | undefined): number {
  if (!a || !(a.balance >= 0) || !(a.avgDailySpend > 0)) return Infinity;
  return a.balance / a.avgDailySpend;
}

/**
 * 오늘 일 예산 조기 소진 예상 캠페인 → 재배분 관점 판정.
 * 대상 · 예상 마감: AD Pilot paceCampaigns (Board · 커맨드 센터와 같은 28일 시간대 곡선 + 선형, 23시 전 마감).
 * 판정 순서 — 증액 보류: 계정 잔액 1일치 미만 · 자동충전 실패 · 계정 검수/제한(p.44), 최근 2시간 광고비 동요일 · 동시간 ±30%(p.47 주의),
 * 캠페인 내 키워드 최근 3일 CPC +50% 이상(경쟁 입찰 상승 · AD Pilot 자동 조정 보류 기준) →
 * 증액 후보: 매체 한계 ROAS ≥ 균등화 기준이고 캠페인 ROAS ≥ 목표 → 그 외 입찰 조정 우선.
 */
export function budgetConstraints(d: Dataset, model?: AllocationModel): BudgetConstraint[] {
  const paces = (d.campaigns?.length ? paceCampaigns(d) : []).filter((p) => p.status !== 'off' && p.dailyBudget > 0 && p.earlyExhaust);
  if (!paces.length) return [];
  const m = model ?? allocationModel(d);
  const before = resolveConfig().exhaustBeforeHour;
  const warn = ANOMALY_THRESHOLDS.find((t) => t.metric === 'cost')?.warnPct ?? 30;
  const thr = m.equalize.marginalRoas;
  const spikes = keywordCpcSpikes(d);
  const out = paces.map((p): BudgetConstraint => {
    const curveEarly = p.curveExhaustHour !== null && p.curveExhaustHour < before;
    const exhaustHour = curveEarly ? p.curveExhaustHour : p.linearEarly ? p.linearExhaustHour : p.curveExhaustHour;
    const exhaustMethod: BudgetConstraint['exhaustMethod'] = exhaustHour === null ? null : curveEarly || !p.linearEarly ? '시간대 가중' : '선형';
    const missesPeak = exhaustHour !== null && exhaustHour < PACE_RULES.peakStartHour;
    const cum = hourlyCostCurve(d, p.media);
    const expectedShare = cum[clamp(Math.round(p.hourOfData), 0, 23)] ?? NaN;
    const recent = recentHourlyDelta(d, p.media, PACE_RULES.recentHours);
    const eff = campaignEfficiency(d, p);
    const marg = m.baseline.rows.find((r) => r.media === p.media)?.marginalRoas ?? NaN;
    const short = MEDIA[p.media].short;
    const hrs = recent.hours.length ? `${recent.hours[0]}~${recent.hours[recent.hours.length - 1]}시` : '최근 시간대';
    const acc = accountForCampaign(d, p);
    const runway = accountRunway(acc);
    const kwSpikes = p.media === 'naver_sa' && p.intent ? spikes.filter((s) => s.intent === p.intent) : [];
    const pace = `예상 마감 ${exhaustText(exhaustHour)} (${exhaustMethod ?? '—'} · 기준 ${before}시 전${missesPeak ? ` · ${PACE_RULES.peakStartHour}~23시 피크 전` : ''})`;
    const effTxt = `캠페인 ROAS ${fmt.roas(eff.roas)} (목표 ${fmt.roas(eff.target)} 대비 ${fmt.int(eff.ratioPct)}%)`;
    let verdict: ConstraintVerdict;
    let holdKind: HoldKind | null = null;
    let basis: string;
    if (acc && (runway < PACE_RULES.runwayMinDays || acc.autoCharge === 'failed' || acc.status !== 'active')) {
      verdict = 'hold';
      holdKind = 'account';
      const st = acc.status === 'review' ? ' · 계정 검수/확인 필요' : acc.status === 'restricted' ? ' · 계정 제한' : '';
      basis = `${acc.name} 잔액 ${Number.isFinite(runway) ? `${runway.toFixed(2)}일치` : '후불'} (기준 ${PACE_RULES.runwayMinDays}일치) · 자동충전 ${acc.autoCharge === 'failed' ? '실패' : acc.autoCharge === 'ok' ? '정상' : acc.autoCharge === 'off' ? '미사용' : '후불'}${st} — 증액은 잔액을 더 빨리 소진시켜 계정 · 결제 확인(MILDO Alert P1) 전 보류 · ${pace}`;
    } else if (fin(recent.deltaPct) && Math.abs(recent.deltaPct) >= warn) {
      verdict = 'hold';
      holdKind = 'spike';
      basis = `오늘 ${hrs} ${short} 광고비 동요일 · 동시간 ${recent.baselineDays}주 평균 대비 ${fmt.delta(recent.deltaPct, 0)} (기준 ±${warn}%) — 소진 가속이 수요 증가가 아닌 데이터 급변일 수 있어 MILDO Alert 확인 전 증액 판단 보류 · ${pace}`;
    } else if (kwSpikes.length) {
      verdict = 'hold';
      holdKind = 'cpc';
      basis = `캠페인 내 ${kwSpikes.slice(0, 2).map((s) => `'${s.keyword}' 최근 3일 CPC ${fmt.delta(s.deltaPct, 0)}`).join(' · ')} (기준 +${AD_PILOT.anomalyHoldPct}%, AD Pilot 자동 조정 보류 기준) — 소진 가속이 경쟁 입찰 상승 때문일 수 있어 증액 대신 원인 확인 · ${pace}`;
    } else if (fin(marg) && fin(thr) && marg >= thr && eff.efficient) {
      verdict = 'raise';
      basis = `${short} 한계 ROAS ${fmt.roas(marg)} ≥ 균등화 기준 ${fmt.roas(thr)} · ${effTxt} · 최근 ${PACE_RULES.recentHours}시간 광고비 ${fmt.delta(recent.deltaPct, 0)} (기준 ±${warn}% 이내) — 예산 제약으로 노출이 끊기는 구간 · ${pace}`;
    } else {
      verdict = 'bid';
      basis = !fin(marg) || !fin(thr)
        ? `한계 ROAS를 계산할 데이터가 없어 증액 근거 없음 — 입찰 조정 우선 · ${pace}`
        : marg < thr
          ? `${short} 한계 ROAS ${fmt.roas(marg)} < 균등화 기준 ${fmt.roas(thr)} — 증액보다 입찰 · 타겟 조정이 먼저 · ${pace}`
          : `${effTxt} — 목표 미달 캠페인은 증액보다 입찰 · 타겟 조정이 먼저 · ${pace}`;
    }
    return {
      id: p.id, campaign: p.name, media: p.media, intent: p.intent, dailyBudget: p.dailyBudget, spentToday: p.spentToday, pacePct: p.pacePct,
      exhaustHour, exhaustMethod, missesPeak, expectedShare, paceIndex: p.projectedRatio, shortfall: Math.max(0, p.projectedSpend - p.dailyBudget), recent,
      campaignRoas: eff.roas, campaignTarget: eff.target, campaignRatioPct: eff.ratioPct, campaignEfficient: eff.efficient,
      marginalRoas: marg, threshold: thr, verdict, holdKind, basis,
    };
  });
  return out.sort((a, b) => (a.exhaustHour ?? 99) - (b.exhaustHour ?? 99) || a.id.localeCompare(b.id));
}

/** 예상 마감 시각 표기 (24시 이후는 '자정 이후') */
export function exhaustText(h: number | null): string {
  if (h === null || !fin(h)) return '소진 없음';
  if (h >= 24) return '자정 이후';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm === 60 ? 59 : mm).padStart(2, '0')}`;
}

/** 매체별 한계 ROAS 곡선 (가안 배분 대비 배수) — 차트용 */
export function marginalCurvePoints(curves: readonly ResponseCurve[], budget: number, mults: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
  return curves.map((c) => ({
    media: c.media,
    points: mults.map((k) => {
      const daily = (budget * PROPOSAL_SHARES[c.media] * k) / 365;
      return { x: `${Math.round(k * 100)}%`, y: curveMarginal(c, daily) * 100 };
    }),
  }));
}

/* ============================ p.40 DA → SA ============================ */

/** 동요일 ±1주 평균 대비 비율 − 1 (요일 · 시즌 공통 요인 제거) */
export function sameWeekdayAdjust(values: readonly number[]): number[] {
  return values.map((v, i) => {
    if (i < 7 || i + 7 >= values.length) return NaN;
    const ref = (values[i - 7] + values[i + 7]) / 2;
    return ref > 0 && fin(v) ? v / ref - 1 : NaN;
  });
}
/** 동요일 ±1주 평균 대비 편차 (절대값, 회귀 계수용) */
export function sameWeekdayDeviation(values: readonly number[]): number[] {
  return values.map((v, i) => {
    if (i < 7 || i + 7 >= values.length) return NaN;
    const ref = (values[i - 7] + values[i + 7]) / 2;
    return fin(ref) && fin(v) ? v - ref : NaN;
  });
}
function laggedPairs(x: readonly number[], y: readonly number[], lag: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let t = lag; t < y.length; t++) {
    if (fin(x[t - lag]) && fin(y[t])) { xs.push(x[t - lag]); ys.push(y[t]); }
  }
  return { xs, ys };
}

export interface LagRow { lag: number; raw: number; adjusted: number; saAdjusted: number; n: number; significant: boolean; saSignificant: boolean }
export interface Method3Row { keyword: string; intent: IntentId; isBrand: boolean; revenue14: number; share: number; shareBasis: 'METHOD 1 추정' | '데모 가정'; daRevenue: number }
export interface DaSaResult {
  valid: boolean;
  dates: string[];
  gfaCost: number[];
  brandSearch: number[];
  saConv: number[];
  n: number;
  lags: LagRow[];
  /** 다중 비교 보정 유의 임계 |r| */
  threshold: number;
  bestLag: number | null;
  bestR: number;
  rawBestLag: number | null;
  slope: { lag: number | null; perMillion: number; t: number; r2: number; n: number };
  dl: { coefs: { lag: number; perMillion: number; t: number }[]; r2: number; cumulativePerMillion: number; lagsUsed: number[] };
  daShareBrand: number;
  avgGfaDaily: number;
  avgBrandSearch: number;
  saLink: { significant: boolean; maxAbsR: number; lag: number | null };
  method3: { rows: Method3Row[]; totalRevenue: number; daRevenue: number; daShareOfSa: number };
  halo: { haloRoas: number; haloDaily: number; gfaDaily: number; saDaily: number; basis: string };
}

const daSaCache = new WeakMap<Dataset, DaSaResult>();

export function daSaAnalysis(d: Dataset, maxLag = DA_SA_MAX_LAG): DaSaResult {
  if (maxLag === DA_SA_MAX_LAG) {
    const hit = daSaCache.get(d);
    if (hit) return hit;
  }
  const bsMap = new Map(d.brandSearchDaily.map((r) => [r.date, r.volume]));
  const dates = completeDates(d).filter((dt) => bsMap.has(dt) && !!mediaDay(d, dt, 'naver_gfa'));
  const gfaCost = dates.map((dt) => mediaDay(d, dt, 'naver_gfa')?.cost ?? NaN);
  const brandSearch = dates.map((dt) => bsMap.get(dt) ?? NaN);
  const saConv = dates.map((dt) => mediaDay(d, dt, 'naver_sa')?.conversions ?? NaN);
  const ag = sameWeekdayAdjust(gfaCost);
  const ab = sameWeekdayAdjust(brandSearch);
  const asa = sameWeekdayAdjust(saConv);
  const nEff = ag.filter(fin).length;
  // 시차 8개 다중 비교 보정 (Bonferroni, 양측 5%)
  const zc = normInv(1 - 0.05 / (2 * (maxLag + 1)));
  const lags: LagRow[] = [];
  for (let k = 0; k <= maxLag; k++) {
    const raw = laggedPairs(gfaCost, brandSearch, k);
    const adj = laggedPairs(ag, ab, k);
    const sa = laggedPairs(ag, asa, k);
    const rAdj = pearson(adj.xs, adj.ys);
    const rSa = pearson(sa.xs, sa.ys);
    const thr = adj.xs.length > 3 ? zc / Math.sqrt(adj.xs.length) : NaN;
    lags.push({
      lag: k, raw: pearson(raw.xs, raw.ys), adjusted: rAdj, saAdjusted: rSa, n: adj.xs.length,
      significant: fin(rAdj) && fin(thr) && rAdj > thr, saSignificant: fin(rSa) && fin(thr) && Math.abs(rSa) > thr,
    });
  }
  const threshold = nEff > 3 ? zc / Math.sqrt(Math.max(4, lags[0]?.n ?? nEff)) : NaN;
  const best = lags.filter((l) => fin(l.adjusted)).reduce<LagRow | null>((a, l) => (!a || l.adjusted > a.adjusted ? l : a), null);
  const bestLag = best && best.significant ? best.lag : null;
  const rawBest = lags.filter((l) => fin(l.raw)).reduce<LagRow | null>((a, l) => (!a || l.raw > a.raw ? l : a), null);
  // 최적 시차 단순 회귀 (편차 기준: 검색 수 / 광고비 100만원)
  const dg = sameWeekdayDeviation(gfaCost);
  const db = sameWeekdayDeviation(brandSearch);
  let slope = { lag: bestLag, perMillion: NaN, t: NaN, r2: NaN, n: 0 };
  if (bestLag !== null) {
    const p = laggedPairs(dg, db, bestLag);
    const f = ols(p.xs.map((x) => [1, x / 1e6]), p.ys);
    if (f) slope = { lag: bestLag, perMillion: f.coef[1], t: safeDiv(f.coef[1], f.se[1]), r2: f.r2, n: f.n };
  }
  // 분산 시차 회귀 (시차 0~3 동시 투입)
  const dlLags = [0, 1, 2, 3];
  const X: number[][] = [];
  const Y: number[] = [];
  for (let t = 3; t < dates.length; t++) {
    const row = dlLags.map((k) => dg[t - k]);
    if (row.every(fin) && fin(db[t])) { X.push([1, ...row.map((v) => v / 1e6)]); Y.push(db[t]); }
  }
  const dlFit = ols(X, Y);
  const coefs = dlFit ? dlLags.map((k, i) => ({ lag: k, perMillion: dlFit.coef[i + 1], t: safeDiv(dlFit.coef[i + 1], dlFit.se[i + 1]) })) : [];
  // 누적 효과: 시차 ≥1, t ≥ 2인 양(+)의 계수 합 (시차 0은 공통 요인 혼재 가능성이 있어 제외)
  const used = coefs.filter((c) => c.lag >= 1 && c.t >= 2 && c.perMillion > 0);
  let cumulative = used.length ? sum(used, (c) => c.perMillion) : NaN;
  if (!fin(cumulative) && fin(slope.perMillion) && slope.t >= 2) cumulative = slope.perMillion;
  const avgGfa = mean(gfaCost.filter(fin));
  const avgBs = mean(brandSearch.filter(fin));
  const daShareBrand = fin(cumulative) && avgBs > 0 ? clamp((cumulative * avgGfa) / 1e6 / avgBs, 0, 0.9) : 0;
  const saMax = lags.filter((l) => fin(l.saAdjusted)).reduce<LagRow | null>((a, l) => (!a || Math.abs(l.saAdjusted) > Math.abs(a.saAdjusted) ? l : a), null);

  // METHOD 3 — 대표 키워드별 DA 경유 비중
  const shareOf = (k: Keyword): { share: number; basis: Method3Row['shareBasis'] } => (k.isBrand || k.intent === 'brand'
    ? { share: daShareBrand, basis: 'METHOD 1 추정' }
    : { share: DA_SHARE_ASSUMPTION[k.intent as Exclude<IntentId, 'brand'>] ?? 0, basis: '데모 가정' });
  const kwAll = d.keywords.filter((k) => k.last14.revenue > 0);
  const totalKwRev = sum(kwAll, (k) => k.last14.revenue);
  const daKwRev = sum(kwAll, (k) => k.last14.revenue * shareOf(k).share);
  const reps: Keyword[] = [];
  for (const it of INTENT_IDS) {
    const list = kwAll.filter((k) => k.intent === it).sort((a, b) => b.last14.revenue - a.last14.revenue);
    reps.push(...(it === 'brand' ? list : list.slice(0, 2)));
  }
  const rows: Method3Row[] = reps.map((k) => {
    const s = shareOf(k);
    return { keyword: k.text, intent: k.intent, isBrand: k.isBrand, revenue14: k.last14.revenue, share: s.share, shareBasis: s.basis, daRevenue: k.last14.revenue * s.share };
  });
  const daShareOfSa = totalKwRev > 0 ? daKwRev / totalKwRev : NaN;
  // halo: SA 매체 매출 × DA 경유 비중 / GFA 광고비 (최근 14일)
  const d14 = lastDays(d, 14);
  const sa14 = sum(d14, (dt) => mediaDay(d, dt, 'naver_sa')?.revenue ?? 0);
  const gfa14 = sum(d14, (dt) => mediaDay(d, dt, 'naver_gfa')?.cost ?? 0);
  const haloDaily = d14.length && fin(daShareOfSa) ? (sa14 * daShareOfSa) / d14.length : NaN;
  const haloRoas = pctOf(sa14 * (fin(daShareOfSa) ? daShareOfSa : NaN), gfa14);

  const res: DaSaResult = {
    valid: nEff >= 20, dates, gfaCost, brandSearch, saConv, n: nEff, lags, threshold, bestLag, bestR: best?.adjusted ?? NaN, rawBestLag: rawBest?.lag ?? null,
    slope,
    dl: { coefs, r2: dlFit?.r2 ?? NaN, cumulativePerMillion: cumulative, lagsUsed: used.map((c) => c.lag) },
    daShareBrand, avgGfaDaily: avgGfa, avgBrandSearch: avgBs,
    saLink: { significant: !!saMax?.saSignificant, maxAbsR: saMax ? Math.abs(saMax.saAdjusted) : NaN, lag: saMax?.lag ?? null },
    method3: { rows, totalRevenue: totalKwRev, daRevenue: daKwRev, daShareOfSa },
    halo: {
      haloRoas, haloDaily, gfaDaily: d14.length ? gfa14 / d14.length : NaN, saDaily: d14.length ? sa14 / d14.length : NaN,
      basis: `SA 매출 중 DA 경유 ${fmt.ratio(daShareOfSa)} (브랜드 키워드는 METHOD 1 추정 ${fmt.ratio(daShareBrand)}, 비브랜드는 데모 가정) ÷ GFA 광고비 · 최근 ${d14.length}일`,
    },
  };
  if (maxLag === DA_SA_MAX_LAG) daSaCache.set(d, res);
  return res;
}

/* ---------------- METHOD 2 홀드아웃 설계 ---------------- */

export interface HoldoutInput {
  unit: HoldoutUnitId;
  metric: 'brand_search' | 'sa_brand_conv';
  mdePct: number;
  alpha?: number;
  power?: number;
  holdoutShare?: number;
  /** 달성 가능한 최소 검출 효과를 계산할 기간 (일) */
  days?: number;
}
export interface HoldoutResult {
  valid: boolean;
  unit: HoldoutUnitId;
  unitLabel: string;
  metric: HoldoutInput['metric'];
  metricLabel: string;
  mu: number;
  cv: number;
  holdoutShare: number;
  zAlpha: number;
  zBeta: number;
  /** 그룹(또는 ON/OFF 각 구간)당 필요 일수 */
  requiredDays: number;
  /** 권장 테스트 기간 (최소 기간 · 주 단위 올림, 기간 단위는 ON+OFF 합계) */
  recommendedDays: number;
  mdeAtDays: number;
  daysForMde: number;
  expectedEffectPct: number;
  detectable: boolean;
  unspentSpend: number;
  revenueAtRisk: number;
  note: string;
}

export function holdoutDesign(d: Dataset, input: HoldoutInput): HoldoutResult {
  const unit = HOLDOUT_UNITS.find((u) => u.id === input.unit) ?? HOLDOUT_UNITS[0];
  const alpha = clamp(input.alpha ?? 0.05, 0.001, 0.5);
  const power = clamp(input.power ?? 0.8, 0.5, 0.999);
  const p = clamp(input.holdoutShare ?? unit.holdoutShare, 0.05, 0.95);
  const mde = Math.abs(input.mdePct) / 100;
  const ds = daSaAnalysis(d);
  let mu = NaN;
  let cv = NaN;
  let metricLabel = '';
  if (input.metric === 'brand_search') {
    metricLabel = '브랜드 검색량 (일)';
    mu = mean(lastDays(d, 28).map((dt) => d.brandSearchDaily.find((r) => r.date === dt)?.volume ?? NaN).filter(fin));
    const adj = sameWeekdayAdjust(ds.brandSearch).filter(fin);
    cv = adj.length >= 5 ? stdev(adj) : NaN;
  } else {
    metricLabel = 'SA 브랜드 키워드 전환 (일)';
    const brand = d.keywords.filter((k) => k.isBrand);
    const len = Math.max(0, ...brand.map((k) => k.daily.length));
    const daily = Array.from({ length: len }, (_, i) => sum(brand, (k) => k.daily[i]?.conversions ?? 0));
    mu = daily.length ? mean(daily) : NaN;
    cv = daily.length >= 5 && mu > 0 ? stdev(daily) / mu : NaN;
  }
  const zA = normInv(1 - alpha / 2);
  const zB = normInv(power);
  const k = unit.noiseMult;
  const isPeriod = unit.id === 'period';
  const pH = isPeriod ? 1 : p;
  const pC = isPeriod ? 1 : 1 - p;
  const variance = mu > 0 && fin(cv) ? 1 / (mu * pH) + 1 / (mu * pC) + 2 * (cv * k) ** 2 : NaN;
  const zz = (zA + zB) ** 2;
  const requiredDays = mde > 0 && fin(variance) ? Math.ceil((zz * variance) / mde ** 2) : NaN;
  const recommendedDays = fin(requiredDays) ? Math.ceil(Math.max(unit.minDays, requiredDays * (isPeriod ? 2 : 1)) / 7) * 7 : NaN;
  const days = Math.max(1, input.days ?? 28);
  const mdeAtDays = fin(variance) ? Math.sqrt((zz * variance) / (isPeriod ? days / 2 : days)) * 100 : NaN;
  // DA를 끈 그룹에서 줄어드는 비율 = DA 경유 비중 (전환 지표는 검색 감소가 같은 비율로 이어진다는 가정)
  const expected = ds.daShareBrand * 100;
  const testDaysOff = fin(recommendedDays) ? (isPeriod ? recommendedDays / 2 : recommendedDays) : NaN;
  const gfaDaily = ds.halo.gfaDaily;
  const unspent = fin(testDaysOff) && fin(gfaDaily) ? gfaDaily * (isPeriod ? 1 : p) * testDaysOff : NaN;
  const gfaCurve = fitResponseCurves(d).find((c) => c.media === 'naver_gfa');
  const roasAll = (fin(gfaCurve?.roas ?? NaN) ? (gfaCurve as ResponseCurve).roas : 0) + (fin(ds.halo.haloRoas) ? ds.halo.haloRoas : 0);
  const valid = fin(requiredDays) && requiredDays > 0;
  const detectable = valid && fin(expected) && expected >= Math.abs(input.mdePct);
  return {
    valid, unit: unit.id, unitLabel: unit.label, metric: input.metric, metricLabel, mu, cv, holdoutShare: p, zAlpha: zA, zBeta: zB,
    requiredDays, recommendedDays, mdeAtDays, daysForMde: days, expectedEffectPct: expected, detectable,
    unspentSpend: unspent, revenueAtRisk: fin(unspent) ? (unspent * roasAll) / 100 : NaN,
    note: !valid
      ? '지표 데이터가 부족해 필요 기간을 계산할 수 없습니다'
      : `${unit.label} · 홀드아웃 ${fmt.ratio(isPeriod ? 0.5 : p, 0)}${isPeriod ? ' (기간)' : ''} · 유의수준 ${fmt.ratio(alpha, 0)} · 검정력 ${fmt.ratio(power, 0)} · 그룹 간 잡음 배수 ${k} (가정)`,
  };
}

/* ======================= p.41 브랜드스토어 · 자사몰 전환 ======================= */

export interface FunnelTotals { visitors: number; detailViews: number; carts: number; orders: number; revenue: number }
export interface FunnelRates { detail: number; cart: number; order: number; cvr: number; aov: number }
export function channelTotals(d: Dataset, channel: SalesChannelId, from: string, to: string): FunnelTotals {
  const rows = d.salesDaily.filter((r) => r.channel === channel && r.date >= from && r.date <= to);
  return {
    visitors: sum(rows, (r) => r.visitors), detailViews: sum(rows, (r) => r.detailViews), carts: sum(rows, (r) => r.carts),
    orders: sum(rows, (r) => r.orders), revenue: sum(rows, (r) => r.revenue),
  };
}
export function funnelRates(t: FunnelTotals): FunnelRates {
  return { detail: pctOf(t.detailViews, t.visitors), cart: pctOf(t.carts, t.detailViews), order: pctOf(t.orders, t.carts), cvr: pctOf(t.orders, t.visitors), aov: safeDiv(t.revenue, t.orders) };
}
const STAGE_RATE: Record<FunnelStage, keyof FunnelRates> = { visit: 'detail', detail: 'cart', cart: 'order', order: 'cvr' };

export interface ChannelFunnel { channel: SalesChannelId; name: string; cur: FunnelTotals; prev: FunnelTotals; rates: FunnelRates; prevRates: FunnelRates }
export interface StageDiag {
  stage: FunnelStage;
  label: string;
  diag: string;
  metricLabel: string;
  bs: { cur: number; prev: number; trendPct: number };
  om: { cur: number; prev: number; trendPct: number };
  /** 자사몰 vs 브랜드스토어 격차 (%) — 음수면 자사몰이 낮음 */
  gapPct: number;
  focus: 'own_mall' | 'brandstore' | null;
  reasons: string[];
  bsAction: string;
  omAction: string;
  omNote: string;
}
export interface LandingFinding {
  mismatches: { keyword: string; intent: IntentId; expected: string; actual: string; cost14: number; revenue14: number }[];
  soldout: { keyword: string; product: string; option: string; cost14: number }[];
  mismatchCost: number;
  mismatchCostShare: number;
}
export interface Cannibalization {
  valid: boolean;
  bs: { cur: number; prev: number; deltaPct: number };
  om: { cur: number; prev: number; deltaPct: number };
  combined: { cur: number; prev: number; deltaPct: number };
  omShare: { cur: number; prev: number };
  dailyCorr: number;
  flag: 'suspect' | 'none' | 'nodata';
  basis: string;
  benefitGap: string | null;
}
export interface FunnelDiagnosis {
  valid: boolean;
  window: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  brandstore: ChannelFunnel;
  ownMall: ChannelFunnel;
  stages: StageDiag[];
  priority: StageDiag | null;
  upside: { stage: FunnelStage | null; channel: SalesChannelId | null; targetRate: number; addOrders: number; addRevenue14: number; addRevenueMonthly: number; basis: string };
  landing: LandingFinding;
  cannibal: Cannibalization;
}

export function landingType(url: string): string {
  return LANDING_TYPES.find((t) => t.re.test(url))?.type ?? '기타';
}

export function landingFindings(d: Dataset): LandingFinding {
  const kws = d.keywords.filter((k) => k.status !== 'off');
  const mismatches = kws
    .filter((k) => landingType(k.landing) !== SA_CAMPAIGNS[k.intent].landing)
    .map((k) => ({ keyword: k.text, intent: k.intent, expected: SA_CAMPAIGNS[k.intent].landing, actual: landingType(k.landing), cost14: k.last14.cost, revenue14: k.last14.revenue }));
  const soldout: LandingFinding['soldout'] = [];
  for (const p of d.products) {
    for (const o of p.options) {
      if (o.inStock) continue;
      for (const k of kws) {
        if (k.landing.startsWith(p.landing) && k.text.includes(o.label)) soldout.push({ keyword: k.text, product: p.name, option: o.label, cost14: k.last14.cost });
      }
    }
  }
  const totalCost = sum(kws, (k) => k.last14.cost);
  const mismatchCost = sum(mismatches, (m) => m.cost14);
  return { mismatches, soldout, mismatchCost, mismatchCostShare: safeDiv(mismatchCost, totalCost) };
}

export function cannibalization(d: Dataset, days: number = FUNNEL_RULES.windowDays): Cannibalization {
  const cur = lastDays(d, days);
  const empty: Cannibalization = {
    valid: false, bs: { cur: NaN, prev: NaN, deltaPct: NaN }, om: { cur: NaN, prev: NaN, deltaPct: NaN }, combined: { cur: NaN, prev: NaN, deltaPct: NaN },
    omShare: { cur: NaN, prev: NaN }, dailyCorr: NaN, flag: 'nodata', basis: '판매 채널 데이터 없음', benefitGap: null,
  };
  if (!cur.length) return empty;
  const from = cur[0];
  const to = cur[cur.length - 1];
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);
  const rev = (c: SalesChannelId, f: string, t: string) => sum(d.salesDaily.filter((r) => r.channel === c && r.date >= f && r.date <= t), (r) => r.revenue);
  const bsC = rev('brandstore', from, to);
  const bsP = rev('brandstore', prevFrom, prevTo);
  const omC = rev('own_mall', from, to);
  const omP = rev('own_mall', prevFrom, prevTo);
  if (bsC + omC <= 0) return empty;
  const bsD = deltaPct(bsC, bsP);
  const omD = deltaPct(omC, omP);
  const coD = deltaPct(bsC + omC, bsP + omP);
  const last28 = lastDays(d, days * 2);
  const series = (c: SalesChannelId) => last28.map((dt) => d.salesDaily.find((r) => r.date === dt && r.channel === c)?.revenue ?? NaN);
  const diff = (v: number[]) => v.slice(1).map((x, i) => x - v[i]);
  const corr = pearson(diff(series('brandstore')), diff(series('own_mall')));
  const opposite = fin(bsD) && fin(omD) && ((bsD >= 5 && omD <= -5) || (bsD <= -5 && omD >= 5));
  const flat = fin(coD) && Math.abs(coD) < FUNNEL_RULES.cannibalCombinedPct;
  const flag: Cannibalization['flag'] = !fin(bsD) || !fin(omD) ? 'nodata' : opposite && flat ? 'suspect' : 'none';
  const live = d.promotions.filter((p) => p.start <= d.today && p.end >= d.today && p.status !== 'ended');
  const bsPromo = live.filter((p) => p.channel === 'brandstore');
  const omPromo = live.filter((p) => p.channel === 'own_mall');
  const benefitGap = bsPromo.length && !omPromo.length
    ? `브랜드스토어 ${bsPromo.map((p) => `${p.name} ${p.discountRate}%`).join(' · ')} 진행 중 · 자사몰 전용 혜택 없음`
    : omPromo.length && !bsPromo.length ? `자사몰 ${omPromo.map((p) => `${p.name} ${p.discountRate}%`).join(' · ')} 진행 중 · 브랜드스토어 혜택 없음` : null;
  return {
    valid: true,
    bs: { cur: bsC, prev: bsP, deltaPct: bsD }, om: { cur: omC, prev: omP, deltaPct: omD }, combined: { cur: bsC + omC, prev: bsP + omP, deltaPct: coD },
    omShare: { cur: safeDiv(omC, bsC + omC), prev: safeDiv(omP, bsP + omP) }, dailyCorr: corr, flag,
    basis: flag === 'suspect'
      ? `한 채널 증가(±5% 이상)가 다른 채널 감소로 상쇄되고 합산 변화가 ±${FUNNEL_RULES.cannibalCombinedPct}% 이내`
      : `브랜드스토어 ${fmt.delta(bsD)} · 자사몰 ${fmt.delta(omD)} · 합산 ${fmt.delta(coD)} — 반대 방향 상쇄 패턴 없음`,
    benefitGap,
  };
}

export function funnelDiagnosis(d: Dataset, days: number = FUNNEL_RULES.windowDays): FunnelDiagnosis {
  const cur = lastDays(d, days);
  const from = cur[0] ?? d.today;
  const to = cur[cur.length - 1] ?? d.today;
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);
  const mk = (c: SalesChannelId): ChannelFunnel => {
    const curT = cur.length ? channelTotals(d, c, from, to) : { visitors: 0, detailViews: 0, carts: 0, orders: 0, revenue: 0 };
    const prevT = cur.length ? channelTotals(d, c, prevFrom, prevTo) : { visitors: 0, detailViews: 0, carts: 0, orders: 0, revenue: 0 };
    return { channel: c, name: SALES_CHANNELS[c].name, cur: curT, prev: prevT, rates: funnelRates(curT), prevRates: funnelRates(prevT) };
  };
  const bs = mk('brandstore');
  const om = mk('own_mall');
  const stages: StageDiag[] = FUNNEL_PLAYBOOK.map((p) => {
    const key = STAGE_RATE[p.stage];
    const b = { cur: bs.rates[key], prev: bs.prevRates[key], trendPct: deltaPct(bs.rates[key], bs.prevRates[key]) };
    const o = { cur: om.rates[key], prev: om.prevRates[key], trendPct: deltaPct(om.rates[key], om.prevRates[key]) };
    const gap = deltaPct(o.cur, b.cur);
    const reverseGap = deltaPct(b.cur, o.cur);
    const reasons: string[] = [];
    let focus: StageDiag['focus'] = null;
    if (fin(gap) && gap <= FUNNEL_RULES.gapPct) {
      focus = 'own_mall';
      reasons.push(`자사몰 ${p.metricLabel} ${fmt.pct(o.cur)} — 브랜드스토어 ${fmt.pct(b.cur)} 대비 ${fmt.delta(gap)} (기준 ${FUNNEL_RULES.gapPct}%)`);
    } else if (fin(reverseGap) && reverseGap <= FUNNEL_RULES.gapPct) {
      focus = 'brandstore';
      reasons.push(`브랜드스토어 ${p.metricLabel} ${fmt.pct(b.cur)} — 자사몰 ${fmt.pct(o.cur)} 대비 ${fmt.delta(reverseGap)} (기준 ${FUNNEL_RULES.gapPct}%)`);
    }
    if (fin(b.trendPct) && b.trendPct <= FUNNEL_RULES.trendPct) {
      reasons.push(`브랜드스토어 직전 ${days}일 대비 ${fmt.delta(b.trendPct)} (기준 ${FUNNEL_RULES.trendPct}%)`);
      focus = focus ?? 'brandstore';
    }
    if (fin(o.trendPct) && o.trendPct <= FUNNEL_RULES.trendPct) {
      reasons.push(`자사몰 직전 ${days}일 대비 ${fmt.delta(o.trendPct)} (기준 ${FUNNEL_RULES.trendPct}%)`);
      focus = focus ?? 'own_mall';
    }
    return { stage: p.stage, label: p.label, diag: p.diag, metricLabel: p.metricLabel, bs: b, om: o, gapPct: gap, focus, reasons, bsAction: p.bsAction, omAction: p.omAction, omNote: p.omNote };
  });
  const landing = landingFindings(d);
  const visit = stages.find((s) => s.stage === 'visit');
  if (visit && (landing.mismatches.length || landing.soldout.length)) {
    if (landing.mismatches.length) visit.reasons.push(`의도-랜딩 불일치 ${landing.mismatches.length}개 키워드 · SA 광고비의 ${fmt.ratio(landing.mismatchCostShare)} (p.35 랜딩 구조 기준)`);
    if (landing.soldout.length) visit.reasons.push(`품절 옵션 랜딩 ${landing.soldout.map((s) => `'${s.keyword}' → ${s.option} 품절`).join(' · ')}`);
    visit.focus = visit.focus ?? 'brandstore';
  }
  // 우선 단계: 단계 지표(유입·상세·장바구니) 중 채널 간 격차가 가장 큰 곳
  const cands = stages.filter((s) => s.stage !== 'order' && s.focus && fin(s.gapPct));
  const priority = cands.reduce<StageDiag | null>((a, s) => {
    const g = Math.abs(s.focus === 'own_mall' ? s.gapPct : deltaPct(s.bs.cur, s.om.cur));
    const ga = a ? Math.abs(a.focus === 'own_mall' ? a.gapPct : deltaPct(a.bs.cur, a.om.cur)) : -1;
    return g > ga ? s : a;
  }, null);
  let upside: FunnelDiagnosis['upside'] = { stage: null, channel: null, targetRate: NaN, addOrders: NaN, addRevenue14: NaN, addRevenueMonthly: NaN, basis: '' };
  if (priority && priority.focus) {
    const low = priority.focus === 'own_mall' ? om : bs;
    const high = priority.focus === 'own_mall' ? bs : om;
    const key = STAGE_RATE[priority.stage];
    const curRate = low.rates[key];
    const target = curRate + (high.rates[key] - curRate) / 2;
    const baseCount = priority.stage === 'visit' ? low.cur.visitors : priority.stage === 'detail' ? low.cur.detailViews : low.cur.carts;
    // 해당 단계 비율만 개선되고 나머지 단계 비율은 유지된다고 가정
    const downstream = priority.stage === 'visit' ? safeDiv(low.cur.orders, low.cur.detailViews) : priority.stage === 'detail' ? safeDiv(low.cur.orders, low.cur.carts) : 1;
    const addOrders = (baseCount * (target - curRate)) / 100 * downstream;
    const add14 = addOrders * low.rates.aov;
    upside = {
      stage: priority.stage, channel: low.channel, targetRate: target, addOrders, addRevenue14: add14, addRevenueMonthly: (add14 * 30) / Math.max(1, cur.length),
      basis: `${low.name} ${priority.metricLabel} ${fmt.pct(curRate)} → ${fmt.pct(target)} (${high.name}와의 격차 절반 회복 가정 · 다른 단계 비율 유지)`,
    };
  }
  return {
    valid: bs.cur.visitors + om.cur.visitors > 0,
    window: { from, to, prevFrom, prevTo, days: cur.length },
    brandstore: bs, ownMall: om, stages, priority, upside, landing, cannibal: cannibalization(d, days),
  };
}

/* ======================= p.35 SA 5개 캠페인 성과 ======================= */

export type CampaignVerdict = 'expand' | 'keep' | 'check' | 'nodata';
export const CAMPAIGN_VERDICT_LABEL: Record<CampaignVerdict, string> = { expand: '확대 여지', keep: '유지', check: '효율 점검', nodata: '데이터 없음' };
export interface CampaignPerf {
  intent: IntentId;
  name: string;
  message: string;
  landing: string;
  metric: string;
  keywords: number;
  testKeywords: number;
  examples: string[];
  cost: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
  roas: number;
  cvr: number;
  cpa: number;
  ctr: number;
  prevRoas: number;
  roasDelta: number;
  revenueShare: number;
  costShare: number;
  lostShare: number;
  monthlySearch: number;
  target: number;
  ratioPct: number;
  verdict: CampaignVerdict;
  basis: string;
  landingMismatch: number;
  actualLandings: string[];
  /** 키워드 단위 확대 여지 (p.14 고효율 기준: ROAS ≥ 목표 × 1.3 · 노출 손실 ≥ 25%) */
  expandKeywords: { keyword: string; ratioPct: number; lostShare: number }[];
}

/** 키워드 단위 고효율 · 노출 손실 (AD Pilot 입찰 상향 후보와 같은 기준, 브랜드는 브랜드 목표) */
export function expandKeywordsOf(list: readonly Keyword[]): CampaignPerf['expandKeywords'] {
  return list
    .filter((k) => k.status === 'on' && k.last14.cost > 0)
    .map((k) => {
      const target = k.isBrand ? AD_PILOT.brandTargetRoas : AD_PILOT.targetRoas;
      return { keyword: k.text, ratioPct: pctOf(pctOf(k.last14.revenue, k.last14.cost), target), lostShare: k.impressionShareLost };
    })
    .filter((k) => fin(k.ratioPct) && k.ratioPct >= AD_PILOT.highEfficiencyRoasRatio * 100 && k.lostShare >= AD_PILOT.lostShareTrigger)
    .sort((a, b) => b.lostShare - a.lostShare);
}

export function saCampaignPerformance(d: Dataset): CampaignPerf[] {
  const kws = d.keywords.filter((k) => k.status !== 'off');
  const totRev = sum(kws, (k) => k.last14.revenue);
  const totCost = sum(kws, (k) => k.last14.cost);
  return INTENT_IDS.map((it) => {
    const c = SA_CAMPAIGNS[it];
    const list = kws.filter((k) => k.intent === it);
    const s = (f: (k: Keyword) => number) => sum(list, f);
    const cost = s((k) => k.last14.cost);
    const revenue = s((k) => k.last14.revenue);
    const conv = s((k) => k.last14.conversions);
    const clicks = s((k) => k.last14.clicks);
    const imps = s((k) => k.last14.impressions);
    const prevCost = s((k) => k.prev14.cost);
    const prevRev = s((k) => k.prev14.revenue);
    const roas = pctOf(revenue, cost);
    const prevRoas = pctOf(prevRev, prevCost);
    const target = it === 'brand' ? AD_PILOT.brandTargetRoas : AD_PILOT.targetRoas;
    const ratio = pctOf(roas, target);
    const lost = imps > 0 ? s((k) => k.impressionShareLost * k.last14.impressions) / imps : NaN;
    const verdict: CampaignVerdict = !(cost > 0) ? 'nodata'
      : ratio >= AD_PILOT.highEfficiencyRoasRatio * 100 && lost >= AD_PILOT.lostShareTrigger ? 'expand'
        : ratio >= 100 ? 'keep' : 'check';
    const actual = Array.from(new Set(list.map((k) => landingType(k.landing))));
    return {
      intent: it, name: c.name, message: c.message, landing: c.landing, metric: c.metric,
      keywords: list.length, testKeywords: list.filter((k) => k.status === 'test').length,
      examples: [...list].sort((a, b) => b.monthlySearch - a.monthlySearch).slice(0, 3).map((k) => k.text),
      cost, revenue, conversions: conv, clicks, impressions: imps, roas, cvr: pctOf(conv, clicks), cpa: safeDiv(cost, conv), ctr: pctOf(clicks, imps),
      prevRoas, roasDelta: deltaPct(roas, prevRoas), revenueShare: safeDiv(revenue, totRev), costShare: safeDiv(cost, totCost), lostShare: lost,
      monthlySearch: s((k) => k.monthlySearch), target, ratioPct: ratio, verdict,
      basis: verdict === 'nodata' ? '최근 14일 집행 없음'
        : `목표 ROAS ${fmt.int(target)}% 대비 ${fmt.int(ratio)}% · 노출 손실 ${fmt.ratio(lost)} (기준 확대 ${AD_PILOT.highEfficiencyRoasRatio * 100}% 이상 + 손실 ${AD_PILOT.lostShareTrigger * 100}% 이상 · 유지 100% 이상)`,
      landingMismatch: list.filter((k) => landingType(k.landing) !== c.landing).length,
      actualLandings: actual,
      expandKeywords: expandKeywordsOf(list),
    };
  });
}

/** 최근 n일 CPC가 그 이전 기간 대비 +pct% 이상 오른 키워드 (경쟁 입찰 상승 신호) */
export function keywordCpcSpikes(d: Dataset, days = 3, pct: number = AD_PILOT.anomalyHoldPct): { keyword: string; intent: IntentId; deltaPct: number }[] {
  const out: { keyword: string; intent: IntentId; deltaPct: number }[] = [];
  for (const k of d.keywords) {
    if (k.status === 'off') continue;
    const n = k.daily.length;
    if (n <= days + 2) continue;
    const recent = k.daily.slice(n - days);
    const before = k.daily.slice(0, n - days);
    const cpc = (rows: typeof recent) => safeDiv(sum(rows, (r) => r.cost), sum(rows, (r) => r.clicks));
    const dl = deltaPct(cpc(recent), cpc(before));
    if (fin(dl) && dl >= pct) out.push({ keyword: k.text, intent: k.intent, deltaPct: dl });
  }
  return out.sort((a, b) => b.deltaPct - a.deltaPct);
}
/** 최근 14일 목표 ROAS 미달 키워드 (브랜드는 브랜드 목표) */
export function belowTargetKeywords(d: Dataset): { keyword: string; roas: number; target: number }[] {
  return d.keywords
    .filter((k) => k.status !== 'off' && k.last14.cost > 0)
    .map((k) => ({ keyword: k.text, roas: pctOf(k.last14.revenue, k.last14.cost), target: k.isBrand ? AD_PILOT.brandTargetRoas : AD_PILOT.targetRoas }))
    .filter((k) => fin(k.roas) && k.roas < k.target)
    .sort((a, b) => a.roas / a.target - b.roas / b.target);
}

/* ======================= p.34 타겟 그룹 ======================= */

export interface GroupMetric { label: string; value: number; kind: 'roas' | 'pct' | 'won' | 'int' | 'krw' | 'ratio' }
export interface TargetGroupView { id: string; name: string; desc: string; basis: string; campaigns: string[]; metric: string; metrics: GroupMetric[]; dataNote: string }

export function rfpSegmentSummary() {
  const segs = RFP.segments.map((s) => ({ ...s }));
  const top4 = sum(segs, (s) => s.share);
  const female = sum(segs.filter((s) => s.id.startsWith('f')), (s) => s.share);
  return { segments: segs, top4Share: top4, female3150Share: female };
}

export function targetGroupView(d: Dataset): TargetGroupView[] {
  const last30 = lastDays(d, 30);
  const mediaT = (ms: MediaId[]) => {
    const rows = last30.flatMap((dt) => ms.map((m) => mediaDay(d, dt, m))).filter((r): r is DailyMediaRow => !!r);
    const cost = sum(rows, (r) => r.cost);
    const conv = sum(rows, (r) => r.conversions);
    const rev = sum(rows, (r) => r.revenue);
    return { cost, conv, rev, newShare: safeDiv(sum(rows, (r) => r.newCustomers), conv), cpa: safeDiv(cost, conv), roas: pctOf(rev, cost) };
  };
  const kwT = (intents: IntentId[]) => {
    const list = d.keywords.filter((k) => intents.includes(k.intent) && k.status !== 'off');
    const cost = sum(list, (k) => k.last14.cost);
    const rev = sum(list, (k) => k.last14.revenue);
    const conv = sum(list, (k) => k.last14.conversions);
    const clicks = sum(list, (k) => k.last14.clicks);
    return { roas: pctOf(rev, cost), cvr: pctOf(conv, clicks), search: sum(list, (k) => k.monthlySearch), cpa: safeDiv(cost, conv) };
  };
  const campaignBudget = (names: string[]) => sum(d.campaigns.filter((c) => names.includes(c.name)), (c) => c.dailyBudget);
  return TARGET_GROUPS.map((g) => {
    const link = TARGET_GROUP_LINKS[g.id];
    const metrics: GroupMetric[] = [];
    let dataNote = '';
    if (g.id === 'A') {
      const t = mediaT(link.media);
      metrics.push({ label: 'GFA · Meta 신규 비중', value: t.newShare, kind: 'ratio' }, { label: 'GFA · Meta CPA', value: t.cpa, kind: 'won' }, { label: '연결 캠페인 일 예산', value: campaignBudget(link.campaigns), kind: 'krw' });
      dataNote = '최근 30일 매체 합계 · 연령 · 성별 성과는 매체 리포트 연동 후';
    } else if (g.id === 'E') {
      const t = mediaT(link.media);
      metrics.push({ label: '카카오 ROAS', value: t.roas, kind: 'roas' }, { label: '카카오 CPA', value: t.cpa, kind: 'won' }, { label: '리타겟팅 일 예산', value: campaignBudget(link.campaigns), kind: 'krw' });
      dataNote = '최근 30일 · 리타겟팅 캠페인 단위 성과 분리는 캠페인 리포트 연동 후';
    } else {
      const t = kwT(link.intents);
      metrics.push({ label: 'SA ROAS', value: t.roas, kind: 'roas' }, { label: 'SA 전환율', value: t.cvr, kind: 'pct' }, { label: '월간 검색량', value: t.search, kind: 'int' });
      dataNote = '최근 14일 · 연결 의도 키워드 합계';
    }
    return { id: g.id, name: g.name, desc: g.desc, basis: g.basis, campaigns: link.campaigns, metric: link.metric, metrics, dataNote };
  });
}

/* ======================= p.36 SKU 확장 ======================= */

export function skuExpansionSummary() {
  const products = 1; // p.36 "제품 1개"
  const p = SKU_EXPANSION.problems.length;
  const s = SKU_EXPANSION.situations.length;
  const c = SKU_EXPANSION.criteria.length;
  const examples: string[] = [];
  for (let i = 0; i < Math.min(p, s); i++) examples.push(`${SKU_EXPANSION.problems[i]} × ${SKU_EXPANSION.situations[i]} × ${SKU_EXPANSION.criteria[i % c]}`);
  return { products, problems: p, situations: s, criteria: c, total: products * p * s * c, examples };
}

/* ======================= p.38 신규 매체 ======================= */

export type CriterionId = (typeof NEW_MEDIA_PILOT.criteria)[number]['id'];
export const DEFAULT_WEIGHTS: Record<CriterionId, number> = Object.fromEntries(NEW_MEDIA_PILOT.criteria.map((c) => [c.id, 20])) as Record<CriterionId, number>;
export type ScoreTable = Record<string, Record<CriterionId, number>>;
export interface MediaScore { name: string; touch: string; hypothesis: string; total: number; rank: number; parts: Record<CriterionId, number> }

export function scoreNewMedia(weights: Record<CriterionId, number> = DEFAULT_WEIGHTS, scores: ScoreTable = NEW_MEDIA_SCORES): MediaScore[] {
  const ids = NEW_MEDIA_PILOT.criteria.map((c) => c.id);
  const wsum = sum(ids, (id) => Math.max(0, fin(weights[id]) ? weights[id] : 0));
  const list = NEW_MEDIA_PILOT.candidates.map((cand) => {
    const sc = scores[cand.name] ?? ({} as Record<CriterionId, number>);
    const parts = Object.fromEntries(ids.map((id) => {
      const w = Math.max(0, fin(weights[id]) ? weights[id] : 0);
      const v = clamp(fin(sc[id]) ? sc[id] : 0, 0, 5);
      return [id, wsum > 0 ? ((w * v) / 5 / wsum) * 100 : NaN];
    })) as Record<CriterionId, number>;
    const total = wsum > 0 ? sum(ids, (id) => parts[id]) : NaN;
    return { name: cand.name, touch: cand.touch, hypothesis: cand.hypothesis, total, rank: 0, parts };
  });
  const sorted = [...list].sort((a, b) => (fin(b.total) ? b.total : -1) - (fin(a.total) ? a.total : -1) || a.name.localeCompare(b.name));
  sorted.forEach((s, i) => { s.rank = i + 1; });
  return sorted;
}

export interface PilotInput { name: string; budget: number }
export interface PilotRow {
  name: string;
  budget: number;
  weeks: number;
  cpa: number;
  expectedConv: number;
  minConv: number;
  budgetForMin: number;
  breakEvenConv: number;
  threshold: number;
  feasible: boolean;
  status: 'ok' | 'short' | 'off';
  /** 이미 승인 흐름에 올라간 후보 (예산 고정) */
  requested: boolean;
}
export interface PilotPlan {
  cap: number;
  /** 배정 합계 (이미 요청한 금액 포함) */
  total: number;
  /** 승인 흐름에 올라간 금액 합계 */
  committedTotal: number;
  overCap: boolean;
  remaining: number;
  minConv: number;
  baseCpa: number;
  aov: number;
  threshold: number;
  thresholdBasis: string;
  rows: PilotRow[];
  rule: string;
}

/** 필요 전환 수: 포아송 상대오차 ±precision (신뢰수준 confidence) → n = (z / precision)² */
export function requiredConversions(precision: number = PILOT_DEFAULTS.precision, confidence: number = PILOT_DEFAULTS.confidence): number {
  const z = normInv(1 - (1 - clamp(confidence, 0.5, 0.999)) / 2);
  const p = Math.abs(precision);
  return p > 0 && fin(z) ? Math.ceil((z / p) ** 2) : NaN;
}

export function defaultPilots(ranked: readonly MediaScore[]): PilotInput[] {
  return ranked.map((r) => ({ name: r.name, budget: r.rank <= PILOT_DEFAULTS.topN ? PILOT_DEFAULTS.budgetPerPilot : 0 }));
}

export function pilotPlan(d: Dataset, pilots: readonly PilotInput[], opts: { annualBudget?: number; marginalRoas?: number; precision?: number; committed?: Record<string, number> } = {}): PilotPlan {
  const committed = opts.committed ?? {};
  const annual = opts.annualBudget ?? RFP.annualBudget;
  const cap = annual * NEW_MEDIA_PILOT.maxBudgetShare;
  const last30 = lastDays(d, 30);
  const da: MediaId[] = ['naver_gfa', 'meta', 'google'];
  const daRows = last30.flatMap((dt) => da.map((m) => mediaDay(d, dt, m))).filter((r): r is DailyMediaRow => !!r);
  const allRows = last30.flatMap((dt) => MEDIA_IDS.map((m) => mediaDay(d, dt, m))).filter((r): r is DailyMediaRow => !!r);
  const baseCpa = safeDiv(sum(daRows, (r) => r.cost), sum(daRows, (r) => r.conversions));
  const aov = safeDiv(sum(allRows, (r) => r.revenue), sum(allRows, (r) => r.conversions));
  const thr = fin(opts.marginalRoas ?? NaN) && (opts.marginalRoas as number) > 0 ? (opts.marginalRoas as number) : AD_PILOT.targetRoas;
  const thresholdBasis = fin(opts.marginalRoas ?? NaN) && (opts.marginalRoas as number) > 0 ? '기존 매체 한계 ROAS · 균등화 기준' : `목표 ROAS ${AD_PILOT.targetRoas}% (한계 ROAS 계산 불가 시)`;
  const minConv = requiredConversions(opts.precision ?? PILOT_DEFAULTS.precision);
  const rows: PilotRow[] = pilots.map((p) => {
    const requested = fin(committed[p.name] ?? NaN) && committed[p.name] > 0;
    const budget = requested ? committed[p.name] : Math.max(0, fin(p.budget) ? p.budget : 0);
    const cpa = baseCpa * (NEW_MEDIA_CPA_MULT[p.name] ?? 1);
    const expectedConv = safeDiv(budget, cpa);
    const feasible = budget > 0 && fin(expectedConv) && expectedConv >= minConv;
    return {
      name: p.name, budget, weeks: NEW_MEDIA_PILOT.weeks, cpa, expectedConv: budget > 0 ? expectedConv : 0, minConv,
      budgetForMin: fin(cpa) ? minConv * cpa : NaN, breakEvenConv: safeDiv((budget * thr) / 100, aov), threshold: thr, feasible,
      status: budget <= 0 ? 'off' : feasible ? 'ok' : 'short', requested,
    };
  });
  const inRows = new Set(rows.map((r) => r.name));
  const committedOther = sum(Object.entries(committed).filter(([n, v]) => !inRows.has(n) && fin(v) && v > 0), ([, v]) => v);
  const total = sum(rows, (r) => r.budget) + committedOther;
  const committedTotal = sum(rows.filter((r) => r.requested), (r) => r.budget) + committedOther;
  return {
    cap, total, committedTotal, overCap: total > cap + 1e-6, remaining: cap - total, minConv, baseCpa, aov, threshold: thr, thresholdBasis, rows,
    rule: `${NEW_MEDIA_PILOT.weeks}주 · 연 예산 ${Math.round(NEW_MEDIA_PILOT.maxBudgetShare * 100)}% 이내 · 증분 ROAS ${fmt.int(thr)}% 이상 확대 · 미달 중단 · 전환 ${fmt.int(minConv)}건 미만 판정 보류`,
  };
}

/* ======================= p.39 코프로모션 ======================= */

export function coPromoDemand(d: Dataset) {
  return CO_PROMOTIONS.map((c) => {
    const re = new RegExp(CO_PROMO_KEYWORDS[c.moment] ?? '^$');
    const list = d.keywords.filter((k) => re.test(k.text));
    const cost = sum(list, (k) => k.last14.cost);
    const rev = sum(list, (k) => k.last14.revenue);
    return { ...c, keywords: list.map((k) => k.text), monthlySearch: sum(list, (k) => k.monthlySearch), roas: pctOf(rev, cost), revenue14: rev };
  });
}

/* ======================= p.42 캘린더 · p.30 성장 공식 ======================= */

/** 분기 시작일 + 3개월 − 1일 */
function quarterEnd(start: string): string {
  const [y, mo] = start.split('-').map(Number);
  const ny = mo + 3 > 12 ? y + 1 : y;
  const nm = ((mo + 2) % 12) + 1;
  return addDays(`${ny}-${String(nm).padStart(2, '0')}-01`, -1);
}

export function calendarView(d: Dataset) {
  return GROWTH_CALENDAR.map((q) => {
    const start = QUARTER_START[q.q] ?? '';
    const end = start ? quarterEnd(start) : '';
    const daysUntil = start ? daysBetween(d.today, start) : NaN;
    const status: 'upcoming' | 'current' | 'past' | 'unknown' = !start ? 'unknown' : d.today < start ? 'upcoming' : d.today > end ? 'past' : 'current';
    return { ...q, start, end, daysUntil, status, links: CALENDAR_LINKS[q.q] ?? [] };
  });
}

export function automationSavings() {
  const before = sum(SA_AUTOMATION_SCOPE, (t) => t.before);
  const after = sum(SA_AUTOMATION_SCOPE, (t) => t.after);
  return { before, after, saved: before - after, pct: pctOf(before - after, before) };
}

export interface FormulaPillar { id: string; title: string; detail: string; tab: string; route: string; value: string; foot: string }

export function growthFormula(d: Dataset, model?: AllocationModel): FormulaPillar[] {
  const sv = automationSavings();
  const m = model ?? allocationModel(d);
  const f = funnelDiagnosis(d);
  const ds = daSaAnalysis(d);
  const ranked = scoreNewMedia();
  const named = MEDIA_PARTNERSHIPS.filter((p) => !p.placeholder).length;
  const top = ranked[0];
  const base = Object.fromEntries(GROWTH_FORMULA.map((g) => [g.id, g])) as Record<(typeof GROWTH_FORMULA)[number]['id'], (typeof GROWTH_FORMULA)[number]>;
  const pillar = (id: keyof typeof base, value: string, foot: string): FormulaPillar => ({ id, title: base[id].title, detail: base[id].detail, tab: base[id].tab, route: base[id].route, value, foot });
  const priGap = f.priority ? (f.priority.focus === 'own_mall' ? f.priority.gapPct : deltaPct(f.priority.bs.cur, f.priority.om.cur)) : NaN;
  return [
    pillar('time', `주 ${fmt.int(sv.saved)}분`, `SA 업무 ${fmt.int(sv.before)} → ${fmt.int(sv.after)}분 (${fmt.delta(-sv.pct, 0)}) · p.19 목표 · 온보딩 30일 내 실측 확정`),
    pillar('power', `${named}개 매체`, `제안서 명시 관계 ${named} · 입력 필요 ${MEDIA_PARTNERSHIPS.length - named} · 구좌는 매체 승인 기준 · 네이버 3자 미팅 ${NAVER_TRIPARTITE.cadence}`),
    pillar('demand', fmt.krw(RFP.annualBudget * NEW_MEDIA_PILOT.maxBudgetShare), `파일럿 한도 연 ${Math.round(NEW_MEDIA_PILOT.maxBudgetShare * 100)}% · 1순위 ${top && fin(top.total) ? `${top.name} ${fmt.int(top.total)}점` : '—'} · 코프로모션 ${CO_PROMOTIONS.length}개 구매 순간`),
    pillar('basics', fin(m.upliftOptimizedPct) ? fmt.delta(m.upliftOptimizedPct) : '—',
      `균등화 재배분 예상 매출 (시나리오) · DA→SA 최적 시차 ${ds.bestLag !== null ? `${ds.bestLag}일` : '미확인'} · ${f.priority ? `${f.priority.label} 격차 ${fmt.delta(priGap)} (기준 ${FUNNEL_RULES.gapPct}%)` : '퍼널 격차 기준 미달'}`),
  ];
}

/* ======================= 성장 과제 신호 (첫 화면) ======================= */

export interface GrowthSignal { id: string; tab: string; tone: 'serious' | 'warning' | 'neutral' | 'good'; title: string; basis: string }

export function growthSignals(d: Dataset, model?: AllocationModel): GrowthSignal[] {
  const out: GrowthSignal[] = [];
  const m = model ?? allocationModel(d);
  const sp = m.baseline.spread;
  if (fin(sp.gapPct) && sp.maxMedia && sp.minMedia) {
    out.push({
      id: 'marginal_gap', tab: 'alloc', tone: sp.gapPct >= 50 ? 'serious' : sp.gapPct >= 20 ? 'warning' : 'neutral',
      title: `한계 ROAS 격차 ${fmt.int(sp.gapPct)}% — ${MEDIA[sp.maxMedia].name} ${fmt.roas(sp.max)} vs ${MEDIA[sp.minMedia].name} ${fmt.roas(sp.min)}`,
      basis: `가안 배분(p.37) 기준 · 균등화 시 예상 매출 ${fmt.delta(m.upliftOptimizedPct)} (${fmt.krw(m.upliftOptimized)}, 곡선 b ±0.1 범위 ${fmt.krw(m.sensitivity.low)}~${fmt.krw(m.sensitivity.high)}) · 시나리오`,
    });
  }
  const bc = budgetConstraints(d, m);
  if (bc.length) {
    const hold = bc.filter((x) => x.verdict === 'hold');
    const groups = (['raise', 'hold', 'bid'] as const)
      .map((v) => ({ v, list: bc.filter((x) => x.verdict === v) }))
      .filter((g) => g.list.length)
      .map((g) => `${CONSTRAINT_LABEL[g.v]} ${g.list.map((x) => x.campaign).join(' · ')}`);
    out.push({
      id: 'budget_constraint', tab: 'alloc', tone: hold.length ? 'serious' : 'warning',
      title: `오늘 일 예산 조기 소진 예상 ${bc.length}개 캠페인 — ${groups.join(' / ')}`,
      basis: `예상 마감 ${resolveConfig().exhaustBeforeHour}시 전 (최근 28일 시간대 소진 곡선 · MILDO Board · AD Pilot과 같은 계산) · ${bc.map((x) => `${x.campaign} ${exhaustText(x.exhaustHour)} · 소진 배수 ${f2(x.paceIndex)}${x.holdKind === 'account' ? ' · 계정 잔액 1일치 미만' : x.holdKind === 'spike' ? ` · 최근 ${PACE_RULES.recentHours}시간 광고비 ${fmt.delta(x.recent.deltaPct, 0)}` : x.holdKind === 'cpc' ? ' · 키워드 CPC 급등' : ''}`).join(' / ')} · 증액 판단 기준 한계 ROAS ${fmt.roas(m.equalize.marginalRoas)}`,
    });
  }
  const ds = daSaAnalysis(d);
  if (ds.valid) {
    const credit = allocationModel(d, { daSaCredit: true });
    const g0 = m.equalize.shares.naver_gfa;
    const g1 = credit.equalize.shares.naver_gfa;
    out.push({
      id: 'da_sa', tab: 'dasa', tone: ds.bestLag !== null ? 'warning' : 'neutral',
      title: ds.bestLag !== null
        ? `GFA → 브랜드 검색 ${ds.bestLag}일 시차 동행 (r ${f2(ds.bestR)}) · 브랜드 검색의 약 ${fmt.ratio(ds.daShareBrand, 0)}가 DA 경유 추정`
        : 'GFA → 브랜드 검색 시차 동행이 유의 기준에 미달',
      basis: `요일 · 시즌 보정 후 r > ${f2(ds.threshold)} 기준 (시차 8개 다중 비교 보정) · SA 기여 반영 시 균등화안 GFA 비중 ${fmt.ratio(g0)} → ${fmt.ratio(g1)} · 홀드아웃 검증 전 재배분 보류`,
    });
  }
  const f = funnelDiagnosis(d);
  if (f.priority) {
    const isOm = f.priority.focus === 'own_mall';
    out.push({
      id: 'funnel', tab: 'funnel', tone: 'serious',
      title: `${isOm ? '자사몰' : '브랜드스토어'} ${f.priority.metricLabel} ${fmt.pct(isOm ? f.priority.om.cur : f.priority.bs.cur)} — ${isOm ? '브랜드스토어' : '자사몰'} ${fmt.pct(isOm ? f.priority.bs.cur : f.priority.om.cur)} 대비 ${fmt.delta(isOm ? f.priority.gapPct : deltaPct(f.priority.bs.cur, f.priority.om.cur))}`,
      basis: `기준 채널 간 ${FUNNEL_RULES.gapPct}% · 격차 절반 회복 시 월 ${fmt.krw(f.upside.addRevenueMonthly)} (시나리오) · 액션: ${isOm ? f.priority.omAction : f.priority.bsAction}`,
    });
  }
  if (f.landing.mismatches.length || f.landing.soldout.length) {
    out.push({
      id: 'landing', tab: 'funnel', tone: f.landing.soldout.length ? 'serious' : 'warning',
      title: `의도-랜딩 불일치 ${f.landing.mismatches.length}개 키워드${f.landing.soldout.length ? ` · 품절 옵션 랜딩 ${f.landing.soldout.length}건` : ''}`,
      basis: `p.35 캠페인별 랜딩 기준 · 불일치 키워드 광고비 비중 ${fmt.ratio(f.landing.mismatchCostShare)} (최근 14일)${f.landing.soldout.length ? ` · ${f.landing.soldout.map((s) => `'${s.keyword}' ${s.option} 품절`).join(', ')}` : ''}`,
    });
  }
  const perf = saCampaignPerformance(d);
  const camps = perf.filter((c) => c.verdict === 'expand');
  const starKw = perf.flatMap((c) => c.expandKeywords.map((k) => ({ ...k, campaign: c.name })));
  if (camps.length || starKw.length) {
    out.push({
      id: 'sa_expand', tab: 'target', tone: 'good',
      title: `SA 확대 여지 — 캠페인 ${camps.length}개${camps.length ? ` (${camps.map((c) => c.name).join(' · ')})` : ''} · 키워드 ${starKw.length}개`,
      basis: `목표 ROAS 대비 ${AD_PILOT.highEfficiencyRoasRatio * 100}% 이상 · 노출 손실 ${AD_PILOT.lostShareTrigger * 100}% 이상 (p.14 고효율 기준, 브랜드 목표 ${AD_PILOT.brandTargetRoas}%) · ${starKw.slice(0, 4).map((k) => `${k.keyword} 손실 ${fmt.ratio(k.lostShare, 0)}`).join(', ')}${starKw.length > 4 ? ` 외 ${starKw.length - 4}개` : ''} · 확대분은 검색량 상한 안에서만 매출로 이어짐`,
    });
  }
  const ranked = scoreNewMedia();
  const plan = pilotPlan(d, defaultPilots(ranked), { marginalRoas: m.equalize.marginalRoas });
  const short = plan.rows.filter((r) => r.status === 'short');
  if (ranked.length) {
    out.push({
      id: 'new_media', tab: 'demand', tone: short.length ? 'warning' : 'neutral',
      title: `신규 매체 1순위 ${ranked[0].name} ${fmt.int(ranked[0].total)}점 · 파일럿 ${plan.rows.filter((r) => r.budget > 0).length}개 ${fmt.krw(plan.total)} / 한도 ${fmt.krw(plan.cap)}`,
      basis: `판정 기준 증분 ROAS ${fmt.int(plan.threshold)}% (${plan.thresholdBasis}) · 필요 전환 ${fmt.int(plan.minConv)}건${short.length ? ` · 표본 부족 예상 ${short.map((r) => r.name).join(', ')}` : ''}`,
    });
  }
  return out;
}

/* ======================= 승인 요청 (ChangeRequest 페이로드) ======================= */

export interface ChangePayload {
  module: string;
  kind: ChangeKind;
  target: string;
  /** 결정적 키 — 중복 요청 방지 · 파일럿 한도 누적 계산에 쓴다 */
  targetId: string;
  before: string | number;
  after: string | number;
  changePct?: number;
  reason: string;
  requestedBy: string;
  approver: ApprovalLevel;
}
const sharesText = (s: Shares) => MEDIA_IDS.map((m) => `${MEDIA[m].short} ${fmt.ratio(s[m])}`).join(' · ');
export const PILOT_TARGET_PREFIX = 'growth-pilot:';
/** 승인 흐름에서 아직 살아 있는 요청 (반려 · 롤백 제외) */
const ACTIVE_STATUS: ReadonlySet<ChangeRequest['status']> = new Set(['pending', 'approved', 'applied', 'held']);

/** 가안 대비 최대 비중 이동 (%p) */
export function maxShareMove(shares: Shares): number {
  return Math.max(0, ...MEDIA_IDS.map((m) => Math.abs((shares[m] ?? 0) - PROPOSAL_SHARES[m]) * 100).filter(fin));
}

/** 재배분안 → 예산 · 구조 변경은 'PM 제안 → 수면밀도 승인' (p.53) */
export function reallocationChange(model: AllocationModel, which: 'optimized' | 'scenario', requestedBy: string): ChangePayload {
  const shares = which === 'optimized' ? model.equalize.shares : model.scenarioShares;
  const ev = which === 'optimized' ? model.optimized : model.scenario;
  const after = sharesText(shares);
  return {
    module: 'growth', kind: 'budget', target: `연간 매체 배분 (${fmt.krw(model.budget)}) · 월 재배분`, targetId: `growth-realloc:${Math.round(model.budget)}:${after}`,
    before: sharesText(PROPOSAL_SHARES), after, changePct: round(maxShareMove(shares), 1),
    reason: `${which === 'optimized' ? '한계 ROAS 균등화안' : '시나리오 배분'} · 예상 매출 ${fmt.delta(deltaPct(ev.totalRevenue, model.baseline.totalRevenue))} (시나리오, TEST DATA) · 전체 ROAS ${fmt.roas(model.baseline.totalRoas)} → ${fmt.roas(ev.totalRoas)}${model.credit.on ? ' · DA→SA 기여 반영' : ''} · 곡선 가정 b ±0.1 민감도 ${fmt.delta(model.sensitivity.lowPct)}~${fmt.delta(model.sensitivity.highPct)}`,
    requestedBy, approver: 'CLIENT',
  };
}
/** 신규 매체 파일럿 → 신규 캠페인 = 수면밀도 승인 (GFA 위임 범위 기준). after = 파일럿 예산(원) */
export function pilotChange(row: PilotRow, requestedBy: string): ChangePayload {
  return {
    module: 'growth', kind: 'test', target: `신규 매체 파일럿 · ${row.name} · ${row.weeks}주`, targetId: `${PILOT_TARGET_PREFIX}${row.name}`, before: '미집행', after: Math.round(row.budget),
    reason: `p.38 파일럿 규칙 · ${row.weeks}주 ${fmt.krw(row.budget)} · 예상 전환 ${fmt.int(row.expectedConv)}건 (판정 필요 ${fmt.int(row.minConv)}건${row.status === 'short' ? ' — 표본 부족 예상' : ''}) · 증분 ROAS ${fmt.int(row.threshold)}% 이상 확대 · 미달 중단 · CPA 가정 데모`,
    requestedBy, approver: 'CLIENT',
  };
}
export function holdoutChange(h: HoldoutResult, mdePct: number, requestedBy: string): ChangePayload {
  return {
    module: 'growth', kind: 'test', target: `DA→SA 홀드아웃 테스트 · ${h.unitLabel}`, targetId: `growth-holdout:${h.unit}:${h.metric}`, before: 'GFA 전 지역 · 전 타겟 집행',
    after: `${h.unitLabel} 홀드아웃 ${fmt.ratio(h.unit === 'period' ? 0.5 : h.holdoutShare, 0)} · ${fmt.int(h.recommendedDays)}일`,
    reason: `METHOD 2 · ${h.metricLabel} 최소 검출 효과 ${fmt.int(mdePct)}% · 그룹당 필요 ${fmt.int(h.requiredDays)}일 · 미집행 광고비 ${fmt.krw(h.unspentSpend)} · 예상 매출 영향 ${fmt.krw(h.revenueAtRisk)} (추정)`,
    requestedBy, approver: 'CLIENT',
  };
}

/** 같은 대상(targetId)의 살아 있는 growth 요청 — 중복 생성 방지 */
export function activeDuplicate(changes: readonly ChangeRequest[] | undefined, targetId: string): ChangeRequest | null {
  return (changes ?? []).find((c) => c.module === 'growth' && c.targetId === targetId && ACTIVE_STATUS.has(c.status)) ?? null;
}
/** 승인 흐름에 올라간 파일럿 예산 (후보명 → 원) — 연 예산 5% 한도는 이미 요청한 금액까지 합산한다 */
export function pilotCommitments(changes: readonly ChangeRequest[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes ?? []) {
    if (c.module !== 'growth' || c.kind !== 'test' || !c.targetId?.startsWith(PILOT_TARGET_PREFIX) || !ACTIVE_STATUS.has(c.status)) continue;
    const name = c.targetId.slice(PILOT_TARGET_PREFIX.length);
    const v = typeof c.after === 'number' ? c.after : Number(String(c.after).replace(/[^\d.]/g, ''));
    if (fin(v) && v > 0) out[name] = (out[name] ?? 0) + v;
  }
  return out;
}

/* ======================= AI 프롬프트 (버튼 클릭 시에만 사용) ======================= */

export type PromptKind = 'overview' | 'alloc' | 'dasa' | 'funnel' | 'demand' | 'target';
const r0 = (v: number) => (fin(v) ? Math.round(v) : null);
const r2 = (v: number) => (fin(v) ? Math.round(v * 100) / 100 : null);

export function allocationSnapshot(m: AllocationModel) {
  return {
    예산: r0(m.budget),
    매체: m.curves.map((c) => {
      const b = m.baseline.rows.find((r) => r.media === c.media);
      const o = m.optimized.rows.find((r) => r.media === c.media);
      return {
        매체: MEDIA[c.media].name, 역할: MEDIA[c.media].role, 관측ROAS: r0(c.roas), 적합b: r2(c.fit.b), 적합b95상한: r2(c.fit.ciHigh), 적용b: r2(c.b), b출처: c.bSource,
        가안비중: r2(PROPOSAL_SHARES[c.media]), 가안한계ROAS: r0(b?.marginalRoas ?? NaN), 균등화비중: r2(m.equalize.shares[c.media]), 균등화제약: m.equalize.binding[c.media], 균등화후ROAS: r0(o?.roas ?? NaN),
      };
    }),
    균등화한계ROAS: r0(m.equalize.marginalRoas),
    예상매출증분pct: r2(m.upliftOptimizedPct),
    민감도b01: [r2(m.sensitivity.lowPct), r2(m.sensitivity.highPct)],
    DA_SA기여반영: m.credit.on,
  };
}
export function daSaSnapshot(ds: DaSaResult) {
  return {
    표본일수: ds.n, 최적시차: ds.bestLag, 최적상관: r2(ds.bestR), 유의임계: r2(ds.threshold), 원계열최적시차: ds.rawBestLag,
    시차별: ds.lags.map((l) => ({ 시차: l.lag, 원계열r: r2(l.raw), 보정r: r2(l.adjusted), SA전환r: r2(l.saAdjusted) })),
    분산시차계수_검색per100만원: ds.dl.coefs.map((c) => ({ 시차: c.lag, 계수: r0(c.perMillion), t: r2(c.t) })),
    브랜드검색중DA경유: r2(ds.daShareBrand), SA매출중DA경유: r2(ds.method3.daShareOfSa), GFA_SA경유ROAS: r0(ds.halo.haloRoas), SA전환동행유의: ds.saLink.significant,
  };
}
export function funnelSnapshot(f: FunnelDiagnosis) {
  return {
    기간: f.window,
    단계: f.stages.map((s) => ({ 단계: s.label, 지표: s.metricLabel, 브랜드스토어: r2(s.bs.cur), 자사몰: r2(s.om.cur), 격차pct: r2(s.gapPct), 근거: s.reasons })),
    우선단계: f.priority?.label ?? null, 개선시나리오월매출: r0(f.upside.addRevenueMonthly),
    랜딩불일치: f.landing.mismatches.length, 품절랜딩: f.landing.soldout.map((s) => s.keyword),
    잠식: { 판정: f.cannibal.flag, 브랜드스토어pct: r2(f.cannibal.bs.deltaPct), 자사몰pct: r2(f.cannibal.om.deltaPct), 합산pct: r2(f.cannibal.combined.deltaPct), 혜택차이: f.cannibal.benefitGap },
  };
}

export function growthPrompt(kind: PromptKind, d: Dataset, extra?: unknown): string {
  const head = '아래 데이터는 시연용 테스트 데이터(TEST DATA)다. 제안서 p.30–42 매출 성장 고도화 관점에서 해석한다.';
  const task: Record<PromptKind, string> = {
    overview: '성장 공식(줄인 시간 · 매체 파워 · 새 수요 · 기본기) 기준으로 이번 분기 우선순위를 CAC 회수 구조와 확장 시 비용 구조 변화로 판단하라.',
    alloc: '매체별 한계 ROAS와 균등화 재배분안을 해석하라. 곡선 b가 데이터로 식별되지 않은 매체는 가정임을 분리하고, 볼륨 한계 · 가드레일 · DA→SA 기여 반영 여부에 따른 대체 시나리오를 제시하라.',
    dasa: 'DA→SA 전환 기여 세 방법(시계열 리프트 · 홀드아웃 · 대표 키워드)의 결과를 해석하라. 요일 · 시즌 공통 요인 보정 전후 차이, 브랜드 검색과 SA 전환 동행의 차이, 재배분 결정 전에 필요한 검증을 쓴다.',
    funnel: '브랜드스토어 · 자사몰 퍼널 단계별 격차와 랜딩 점검 결과를 해석하라. 광고 운영으로 바꿀 수 있는 부분부터, 두 채널 합산 매출 기준과 채널 간 잠식을 고려해 쓴다.',
    demand: '신규 매체 후보 점수와 파일럿 계획을 해석하라. 증분 매출 기준과 기존 매체 한계 ROAS 대비 기회비용, 표본 부족 위험을 쓴다.',
    target: '구매 의도별 타겟 그룹과 SA 5개 캠페인 성과를 해석하라. 볼륨(검색량) 한계와 노출 손실, 랜딩 구조를 근거로 쓴다. 건강 상태 추정 타겟팅은 제안하지 않는다.',
  };
  let data: unknown;
  switch (kind) {
    case 'alloc': data = extra ?? allocationSnapshot(allocationModel(d)); break;
    case 'dasa': data = daSaSnapshot(daSaAnalysis(d)); break;
    case 'funnel': data = funnelSnapshot(funnelDiagnosis(d)); break;
    case 'demand': data = extra ?? { 점수: scoreNewMedia().map((s) => ({ 후보: s.name, 점수: r0(s.total) })) }; break;
    case 'target': data = saCampaignPerformance(d).map((c) => ({ 캠페인: c.name, ROAS: r0(c.roas), 목표: c.target, 목표대비: r0(c.ratioPct), CVR: r2(c.cvr), 매출비중: r2(c.revenueShare), 노출손실: r2(c.lostShare), 월검색량: c.monthlySearch, 판정: CAMPAIGN_VERDICT_LABEL[c.verdict], 랜딩불일치: c.landingMismatch })); break;
    default: data = growthSignals(d).map((s) => ({ 과제: s.title, 근거: s.basis }));
  }
  return `${head}\n과제: ${task[kind]}\n\n데이터(JSON):\n${JSON.stringify(data)}`;
}
