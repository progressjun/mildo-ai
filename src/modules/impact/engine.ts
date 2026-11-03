/**
 * 성과 증명 엔진 (docs/SAAS_SPEC.md §4 reports-impact) — 순수 함수. 서버(server/src/impact)와 데모 화면이 같은 계산을 쓴다.
 * React · DOM 의존 없음 (서버가 그대로 import한다).
 *
 * 장부(impact_ledger) 한 줄 = 근거 하나:
 *  - change     : 반영된 변경 1건 — 반영 전 7일 vs 후 7일, 대조군(같은 광고그룹 · 의도의 미변경 키워드)으로 증분 추정 (스케일 차분 · 부트스트랩 80% 구간)
 *  - incident   : 해결된 사고 1건 — 추정 손실 × (1 − 조치까지 걸린 시간 ÷ 자연 발견까지 걸린 시간), 자연 발견 = 다음 영업일 09:30 (가정)
 *  - automation : 월 × 자동화 단위 — 자동 실행 건수 × 제안서 p.19 업무별 절감 분 (가정)
 * 월간 요약 = 측정 증분 이익 + 손실 회피 × 공헌이익률 + 절감 시간 × 시간당 인건비, ÷ 월 구독료 = 회수 배수.
 * 모든 추정에 방법 · 전제 · 신뢰도 · 표본 충분성을 붙이고, 확정 팩트와 섞지 않는다.
 */
import { SA_AUTOMATION_SCOPE } from '@/data/constants';
import { fmt, hashString, isOffDay, rng } from '@/core/util';

/* ============================== 기준값 ============================== */

/** 반영 전 · 후 비교 창 (일) */
export const IMPACT_WINDOW_DAYS = 7;
/** 표본 충분성 — 처리군 창마다 클릭 · 전환 하한 (미만이면 'insufficient') */
export const MIN_CLICKS = 30;
export const MIN_CONVERSIONS = 3;
/** 신뢰구간 수준 · 정규 근사 z */
export const CI_LEVEL = 0.8;
export const Z80 = 1.2815515655446004;
export const BOOTSTRAP_ITERATIONS = 2000;
/** 신뢰도 '높음' 조건 — 대조군 단위 수 · 창별 처리군 클릭 */
export const HIGH_CONF_CONTROL_UNITS = 3;
export const HIGH_CONF_CLICKS = 100;
/** 설정 기본값 — 공헌이익률(광고비 차감 전) · 시간당 인건비 · 월 구독료 (src/data/config.ts billing.monthlyFee 기본값과 같은 값) */
export const DEFAULT_MARGIN = 0.4;
export const DEFAULT_HOURLY_COST = 40_000;
export const DEFAULT_MONTHLY_FEE = 5_000_000;
/** 자연 발견 시각 가정 — 24시간 감지가 없으면 다음 영업일 아침 이슈 브리핑(09:30, 제안서 p.18 · p.44)에서 발견 */
export const NATURAL_DISCOVERY = { hour: 9, minute: 30 } as const;

const KST_MS = 9 * 3600_000;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

/* ============================== 날짜 (KST) ============================== */

/** YYYY-MM-DD ± n일 (UTC 산술 — 실행 환경 시간대와 무관) */
export function addDaysUtc(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 800; d = addDaysUtc(d, 1)) out.push(d);
  return out;
}
export const kstDateOf = (ms: number) => new Date(ms + KST_MS).toISOString().slice(0, 10);
export const kstMonthOf = (ms: number) => kstDateOf(ms).slice(0, 7);
export const kstMsOf = (date: string, hour = 0, minute = 0) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
export function kstStamp(ms: number): string {
  if (!fin(ms)) return '—';
  const s = new Date(ms + KST_MS).toISOString();
  return `${s.slice(5, 7).replace(/^0/, '')}/${s.slice(8, 10).replace(/^0/, '')} ${s.slice(11, 16)}`;
}
export const isBusinessDate = (date: string) => !isOffDay(date).off;
export function monthDates(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return datesBetween(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
}
/** 월의 영업일 수 (upTo가 있으면 그날까지) */
export function businessDaysIn(month: string, upTo?: string): number {
  return monthDates(month).filter((d) => (!upTo || d <= upTo) && isBusinessDate(d)).length;
}
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export const isMonthKey = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const monthLabel = (month: string) => `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`;

/* ============================== 설정 ============================== */

export interface ImpactConfig {
  monthlyFee: number;
  margin: number;
  hourlyCost: number;
  sources: { monthlyFee: 'workspace' | 'default'; margin: 'workspace' | 'default'; hourlyCost: 'workspace' | 'default' };
}

/**
 * 워크스페이스 설정(workspaces.config 덮어쓰기)에서 회수 배수 입력을 읽는다.
 *  billing.monthlyFee (settings 스키마) · impact.contributionMargin · impact.hourlyCost (settings 스키마 추가 요청 — 없으면 기본값)
 */
export function impactConfig(raw: unknown): ImpactConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const fee = o.billing?.monthlyFee;
  const margin = o.impact?.contributionMargin ?? o.impact?.margin;
  const hourly = o.impact?.hourlyCost;
  const okFee = fin(fee) && fee > 0;
  const okMargin = fin(margin) && margin > 0 && margin <= 1;
  const okHourly = fin(hourly) && hourly >= 0;
  return {
    monthlyFee: okFee ? fee : DEFAULT_MONTHLY_FEE,
    margin: okMargin ? margin : DEFAULT_MARGIN,
    hourlyCost: okHourly ? hourly : DEFAULT_HOURLY_COST,
    sources: { monthlyFee: okFee ? 'workspace' : 'default', margin: okMargin ? 'workspace' : 'default', hourlyCost: okHourly ? 'workspace' : 'default' },
  };
}

/* ============================== 증분 추정 (변경) ============================== */

export interface DayMetrics { date: string; impressions?: number; clicks: number; cost: number; conversions: number; revenue: number }
export interface WindowSum { from: string; to: string; days: number; daysWithData: number; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
export interface ControlSnapshot {
  /** adgroup = 같은 광고그룹 · intent = 같은 구매 의도 · media = 다른 매체 합계 · none = 대조군 없음 */
  basis: 'adgroup' | 'intent' | 'media' | 'none';
  label: string;
  units: number;
  ids: string[];
  before: WindowSum | null;
  after: WindowSum | null;
}
export interface Sufficiency {
  ok: boolean;
  reasons: string[];
  minClicks: number;
  minConversions: number;
  before: { clicks: number; conversions: number };
  after: { clicks: number; conversions: number };
}
export type Confidence = 'high' | 'medium' | 'low';
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: '높음', medium: '보통', low: '낮음' };

export interface UpliftEstimate {
  kind: 'uplift';
  /** 증분 매출 · 광고비 · 이익(= 증분 매출 × 공헌이익률 − 증분 광고비) — 원 */
  revenue: number;
  cost: number;
  profit: number;
  /** 증분 매출 80% 구간 (spec: estimate.ci) */
  ci: [number, number];
  ciCost: [number, number];
  ciProfit: [number, number];
  se: { revenue: number; cost: number; profit: number };
  /** 증분 매출 · 광고비 부트스트랩 공분산 (소표본 보정 포함) — 공헌이익률이 바뀌어도 이익 구간을 다시 계산하는 데 쓴다 */
  covRevCost: number;
  level: number;
  method: 'did_scaled' | 'pre_post';
  methodLabel: string;
  /** 대조군 변화율 (후 ÷ 전) — 처리군 반영 전 값에 곱해 반사실(반영하지 않았을 때)을 만든다 */
  controlRatio: { revenue: number | null; cost: number | null };
  counterfactual: { revenue: number; cost: number };
  margin: number;
  granularity: 'keyword' | 'media';
  confidence: Confidence;
  confidenceBasis: string;
  assumptions: string[];
  sufficiency: Sufficiency;
  iterations: number;
}

export interface DidInput {
  /** 반영 전 · 후 창의 날짜 (보통 각 7일) */
  beforeDates: string[];
  afterDates: string[];
  /** 처리군(변경 대상) 날짜별 값 */
  treated: Record<string, DayMetrics>;
  /** 대조군 합계 날짜별 값 — 없으면 반영 전후 단순 비교 */
  control?: Record<string, DayMetrics> | null;
  controlUnits?: number;
  margin: number;
  /** 부트스트랩 시드 (같은 입력 → 같은 구간) */
  seed: string;
  iterations?: number;
  granularity?: 'keyword' | 'media';
  minClicks?: number;
  minConversions?: number;
}

function windowSum(rec: Record<string, DayMetrics> | null | undefined, dates: string[]): WindowSum {
  const s: WindowSum = { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '', days: dates.length, daysWithData: 0, impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  for (const d of dates) {
    const r = rec?.[d];
    if (!r) continue;
    s.daysWithData++;
    s.impressions += fin(r.impressions) ? r.impressions : 0;
    s.clicks += fin(r.clicks) ? r.clicks : 0;
    s.cost += fin(r.cost) ? r.cost : 0;
    s.conversions += fin(r.conversions) ? r.conversions : 0;
    s.revenue += fin(r.revenue) ? r.revenue : 0;
  }
  s.conversions = r2(s.conversions);
  return s;
}
export { windowSum as sumWindow };

/** 표본 충분성: 처리군의 반영 전 · 후 창 각각 클릭 ≥ 30 · 전환 ≥ 3 */
export function sufficiency(before: Pick<WindowSum, 'clicks' | 'conversions' | 'days'>, after: Pick<WindowSum, 'clicks' | 'conversions' | 'days'>, minClicks = MIN_CLICKS, minConversions = MIN_CONVERSIONS): Sufficiency {
  const reasons: string[] = [];
  const chk = (label: string, w: Pick<WindowSum, 'clicks' | 'conversions' | 'days'>) => {
    if (!(w.clicks >= minClicks)) reasons.push(`${label} ${w.days}일 클릭 ${fmt.int(w.clicks)} (기준 ${minClicks} 이상)`);
    if (!(w.conversions >= minConversions)) reasons.push(`${label} ${w.days}일 전환 ${fmt.dec1(w.conversions)} (기준 ${minConversions} 이상)`);
  };
  chk('반영 전', before);
  chk('반영 후', after);
  return { ok: reasons.length === 0, reasons, minClicks, minConversions, before: { clicks: before.clicks, conversions: before.conversions }, after: { clicks: after.clicks, conversions: after.conversions } };
}

/** t 분포 양측 80% 분위수 (자유도 df) — 소표본 구간 보정 */
const T80: Record<number, number> = { 1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476, 6: 1.44, 7: 1.415, 8: 1.397, 9: 1.383, 10: 1.372, 12: 1.356, 15: 1.341, 20: 1.325, 30: 1.31 };
export function t80(df: number): number {
  if (!(df >= 1)) return T80[1];
  if (df > 30) return Z80;
  const keys = Object.keys(T80).map(Number).sort((a, b) => a - b);
  const k = keys.filter((x) => x <= df).pop() ?? 1;
  return T80[k];
}
function covariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (n - 1);
}
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * 스케일 차분 추정 (difference-in-differences, 대조군 변화를 처리군 기준선에 맞춰 환산):
 *   증분 = (처리 후 − 처리 전) − (대조 후 − 대조 전) × (처리 전 ÷ 대조 전)  =  처리 후 − 처리 전 × (대조 후 ÷ 대조 전)
 * 대조군이 없거나 대조 전 값이 0이면 반영 전후 단순 비교(처리 후 − 처리 전, 신뢰도 낮음).
 * 80% 구간: 창 안의 날짜를 같은 날짜끼리(처리 · 대조 짝) 복원 추출하는 부트스트랩 (시드 고정 — 같은 입력이면 같은 구간).
 */
export function estimateUplift(input: DidInput): UpliftEstimate {
  const { beforeDates: bd, afterDates: ad, treated, margin } = input;
  const iterations = Math.max(200, Math.min(10_000, Math.round(input.iterations ?? BOOTSTRAP_ITERATIONS)));
  const granularity = input.granularity ?? 'keyword';
  const tb = windowSum(treated, bd), ta = windowSum(treated, ad);
  const control = input.control ?? null;
  const cb = control ? windowSum(control, bd) : null;
  const ca = control ? windowSum(control, ad) : null;
  const useControl = !!(cb && ca && cb.revenue > 0 && cb.cost > 0 && (input.controlUnits ?? 1) > 0);
  const method: UpliftEstimate['method'] = useControl ? 'did_scaled' : 'pre_post';

  const val = (d: string, rec: Record<string, DayMetrics> | null | undefined, k: 'revenue' | 'cost') => {
    const v = rec?.[d]?.[k];
    return fin(v) ? v : 0;
  };
  const tbR = bd.map((d) => val(d, treated, 'revenue')), taR = ad.map((d) => val(d, treated, 'revenue'));
  const tbC = bd.map((d) => val(d, treated, 'cost')), taC = ad.map((d) => val(d, treated, 'cost'));
  const cbR = bd.map((d) => val(d, control, 'revenue')), caR = ad.map((d) => val(d, control, 'revenue'));
  const cbC = bd.map((d) => val(d, control, 'cost')), caC = ad.map((d) => val(d, control, 'cost'));
  const sumIdx = (xs: number[], idx: number[]) => idx.reduce((a, i) => a + xs[i], 0);
  const est = (bi: number[], ai: number[]) => {
    const TbR = sumIdx(tbR, bi), TaR = sumIdx(taR, ai), TbC = sumIdx(tbC, bi), TaC = sumIdx(taC, ai);
    if (!useControl) return { rev: TaR - TbR, cost: TaC - TbC };
    const CbR = sumIdx(cbR, bi), CaR = sumIdx(caR, ai), CbC = sumIdx(cbC, bi), CaC = sumIdx(caC, ai);
    // 복원 추출로 대조 전 합이 0이 되면 그 회차는 단순 비교로 대체 (드묾)
    const rev = CbR > 0 ? TaR - TbR * (CaR / CbR) : TaR - TbR;
    const cost = CbC > 0 ? TaC - TbC * (CaC / CbC) : TaC - TbC;
    return { rev, cost };
  };
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);
  const p = est(all(bd.length), all(ad.length));
  const point = { revenue: p.rev, cost: p.cost, profit: p.rev * margin - p.cost };

  const rand = rng(hashString(`impact:${input.seed}`));
  const revs: number[] = [], costs: number[] = [], profits: number[] = [];
  const draw = (n: number) => Array.from({ length: n }, () => Math.min(n - 1, Math.floor(rand.next() * n)));
  for (let i = 0; i < iterations && bd.length && ad.length; i++) {
    const e = est(draw(bd.length), draw(ad.length));
    revs.push(e.rev); costs.push(e.cost); profits.push(e.rev * margin - e.cost);
  }
  // 소표본 보정: 부트스트랩 표준편차 × √(n/(n−1)) × t(80%, 자유도 n−1) — 7일 창의 백분위 구간은 폭을 과소 추정하기 쉽다
  const n = Math.max(2, Math.min(bd.length, ad.length));
  const corr = Math.sqrt(n / (n - 1));
  const tq = t80(n - 1);
  const band = (xs: number[], pt: number): { ci: [number, number]; se: number } => {
    const se = sd(xs) * corr;
    return { ci: [r0(pt - tq * se), r0(pt + tq * se)], se };
  };
  const bRev = band(revs, point.revenue), bCost = band(costs, point.cost), bProfit = band(profits, point.profit);
  const cov = covariance(revs, costs) * corr * corr;
  const suff = sufficiency(tb, ta, input.minClicks ?? MIN_CLICKS, input.minConversions ?? MIN_CONVERSIONS);
  const ciRev = bRev.ci;
  const units = useControl ? input.controlUnits ?? 1 : 0;

  let confidence: Confidence;
  let confidenceBasis: string;
  if (!useControl) {
    confidence = 'low';
    confidenceBasis = control ? '대조군 반영 전 매출 · 광고비가 0이라 대조 보정 불가 — 반영 전후 단순 비교 (시장 · 계절 변화 미보정)' : '대조군 없음 — 반영 전후 단순 비교 (시장 · 계절 변화 미보정)';
  } else if (granularity === 'media') {
    confidence = 'low';
    confidenceBasis = '캠페인 일별 데이터가 없어 매체 합계로 비교 — 같은 매체의 다른 변화가 섞인다 · 대조군 = 같은 기간 예산 변경이 없는 다른 매체';
  } else if (units >= HIGH_CONF_CONTROL_UNITS && tb.clicks >= HIGH_CONF_CLICKS && ta.clicks >= HIGH_CONF_CLICKS && (ciRev[0] > 0 || ciRev[1] < 0)) {
    confidence = 'high';
    confidenceBasis = `대조군 ${units}개 단위 · 창별 처리군 클릭 ${HIGH_CONF_CLICKS} 이상 · 80% 구간이 0을 포함하지 않음`;
  } else {
    confidence = 'medium';
    const why: string[] = [];
    if (units < HIGH_CONF_CONTROL_UNITS) why.push(`대조군 ${units}개 (높음 기준 ${HIGH_CONF_CONTROL_UNITS}개 이상)`);
    if (tb.clicks < HIGH_CONF_CLICKS || ta.clicks < HIGH_CONF_CLICKS) why.push(`창별 클릭 ${fmt.int(Math.min(tb.clicks, ta.clicks))} (높음 기준 ${HIGH_CONF_CLICKS} 이상)`);
    if (!(ciRev[0] > 0 || ciRev[1] < 0)) why.push('80% 구간이 0을 포함 — 효과 방향 미확정');
    confidenceBasis = `대조군 보정 · ${why.join(' · ')}`;
  }
  if (!suff.ok) {
    confidence = 'low';
    confidenceBasis = `표본 부족 — ${suff.reasons.join(' · ')}`;
  }

  const assumptions = [
    `비교 창: 반영 전 ${bd.length}일(${tb.from}~${tb.to}) vs 반영 후 ${ad.length}일(${ta.from}~${ta.to}) · 반영 당일은 제외`,
    useControl
      ? `대조군이 없었다면 처리군도 대조군과 같은 비율로 변했을 것 (평행 추세 가정 · 대조 매출 ${ratioText(ca!.revenue, cb!.revenue)} · 광고비 ${ratioText(ca!.cost, cb!.cost)})`
      : '반영 외 다른 요인(시장 · 계절 · 프로모션)이 없었다는 가정 — 대조 보정 없음',
    `증분 이익 = 증분 매출 × 공헌이익률 ${fmt.pct(margin * 100, 0)} − 증분 광고비 (공헌이익률은 광고비 차감 전 기준 · 설정값)`,
    '매출은 매체 귀속 전환 매출 기준 — 판매 채널 실매출 · 다른 매체로의 전이 효과는 포함하지 않는다',
    `80% 구간: 같은 날짜끼리 짝지어 복원 추출한 부트스트랩 ${iterations}회의 표준오차 × 소표본 t 보정(자유도 ${n - 1}) — 창이 ${n}일이라 구간이 넓다`,
  ];
  return {
    kind: 'uplift',
    revenue: r0(point.revenue), cost: r0(point.cost), profit: r0(point.profit),
    ci: ciRev, ciCost: bCost.ci, ciProfit: bProfit.ci,
    se: { revenue: r0(bRev.se), cost: r0(bCost.se), profit: r0(bProfit.se) },
    covRevCost: Math.round(cov),
    level: CI_LEVEL,
    method,
    methodLabel: useControl ? (granularity === 'media' ? '매체 단위 스케일 차분 (대조: 미변경 매체)' : '스케일 차분 (대조: 미변경 키워드)') : '반영 전후 단순 비교',
    controlRatio: { revenue: useControl ? r2(ca!.revenue / cb!.revenue) : null, cost: useControl ? r2(ca!.cost / cb!.cost) : null },
    counterfactual: { revenue: r0(useControl ? tb.revenue * (ca!.revenue / cb!.revenue) : tb.revenue), cost: r0(useControl ? tb.cost * (ca!.cost / cb!.cost) : tb.cost) },
    margin, granularity, confidence, confidenceBasis, assumptions, sufficiency: suff, iterations,
  };
}
/** 공헌이익률 m 기준 증분 이익 · 표준오차 (측정 뒤 설정이 바뀌어도 같은 매출 · 광고비 추정에서 다시 계산) */
export function profitAt(u: Pick<UpliftEstimate, 'revenue' | 'cost' | 'se' | 'covRevCost'>, m: number): { profit: number; se: number } {
  const cov = fin(u.covRevCost) ? u.covRevCost : 0;
  const v = m * m * u.se.revenue ** 2 + u.se.cost ** 2 - 2 * m * cov;
  return { profit: r0(u.revenue * m - u.cost), se: Math.sqrt(Math.max(0, v)) };
}
function ratioText(after: number, before: number): string {
  if (!(before > 0)) return '—';
  return fmt.delta((after / before - 1) * 100, 1);
}

/* ============================== 손실 회피 (사고) ============================== */

/** 자연 발견 시각 — 발생 시각 이후 처음 오는 영업일 09:30 (KST, 그날 09:30 전이면 그날) */
export function naturalDiscoveryMs(occurredMs: number): number {
  let date = kstDateOf(occurredMs);
  for (let i = 0; i < 40; i++) {
    const at = kstMsOf(date, NATURAL_DISCOVERY.hour, NATURAL_DISCOVERY.minute);
    if (isBusinessDate(date) && at >= occurredMs) return at;
    date = addDaysUtc(date, 1);
  }
  return occurredMs;
}

export interface IncidentInputForImpact {
  id: string;
  title: string;
  severity: string;
  revenueLossEst?: number | null;
  occurredAt?: string | null;
  detectedAt: string;
  /** 1차 조치 기록 시각 (alerts sla.actionAt) */
  actionAt?: string | null;
  /** 인지 시각 (sla.ackAt) */
  ackAt?: string | null;
  resolvedAt?: string | null;
  isTest?: boolean;
  falsePositive?: boolean;
}
export interface LossEstimate {
  kind: 'loss';
  lossAvoided: number;
  revenueLossEst: number;
  /** 조치까지 ÷ 자연 발견까지 (0~1) */
  ratio: number;
  occurredAt: string;
  actionAt: string;
  actionBasis: 'actionAt' | 'resolvedAt';
  naturalAt: string;
  minutesToAction: number;
  minutesToNatural: number;
  method: 'time_ratio';
  methodLabel: string;
  confidence: Confidence;
  confidenceBasis: string;
  assumptions: string[];
}
export type LossResult = { ok: true; estimate: LossEstimate } | { ok: false; status: 'excluded'; reason: string };

/**
 * 추정 손실 회피 = 이슈 추정 매출 손실 × (1 − 조치까지 걸린 시간 ÷ 자연 발견까지 걸린 시간).
 * 시간 기준점 = 발생 시각(없으면 감지 시각). 조치 시각 = 1차 조치 기록, 없으면 해결 시각.
 */
export function estimateLossAvoided(i: IncidentInputForImpact): LossResult {
  if (i.isTest) return { ok: false, status: 'excluded', reason: '테스트 데이터로 만든 이슈 (TEST DATA) — 성과 집계 제외' };
  if (i.falsePositive) return { ok: false, status: 'excluded', reason: '오탐으로 종료된 이슈 — 막은 손실 없음' };
  const loss = fin(i.revenueLossEst) ? i.revenueLossEst : NaN;
  if (!(loss > 0)) return { ok: false, status: 'excluded', reason: '추정 매출 손실(revenueLossEst)이 없는 이슈' };
  const occ = Date.parse(i.occurredAt ?? '') || Date.parse(i.detectedAt);
  const actionIso = i.actionAt ?? i.resolvedAt ?? null;
  const act = actionIso ? Date.parse(actionIso) : NaN;
  if (!fin(occ) || !fin(act)) return { ok: false, status: 'excluded', reason: '발생 · 조치 시각 기록이 없어 시간 비교 불가' };
  const nat = naturalDiscoveryMs(occ);
  const tNat = Math.max(0, nat - occ);
  const tAct = Math.max(0, act - occ);
  const ratio = tNat > 0 ? Math.min(1, tAct / tNat) : 1;
  const avoided = loss * (1 - ratio);
  const assumptions = [
    `추정 매출 손실 ${fmt.won(loss)}은 MILDO Alert 탐지 시점의 추정치 — 자연 발견 시점까지 방치했을 때의 손실로 보고, 손실은 시간에 비례해 쌓인다고 가정`,
    `자연 발견 = 발생 후 처음 오는 영업일 ${String(NATURAL_DISCOVERY.hour).padStart(2, '0')}:${String(NATURAL_DISCOVERY.minute).padStart(2, '0')} 아침 브리핑 (24시간 감지가 없을 때, 제안서 p.18 · p.44 기준 가정)`,
    `조치 시각 = ${i.actionAt ? '1차 조치 기록' : '해결 처리'} 시각 · 기준점 = ${i.occurredAt ? '발생' : '감지'} 시각`,
  ];
  return {
    ok: true,
    estimate: {
      kind: 'loss',
      lossAvoided: r0(avoided), revenueLossEst: r0(loss), ratio: Math.round(ratio * 10_000) / 10_000,
      occurredAt: new Date(occ).toISOString(), actionAt: new Date(act).toISOString(), actionBasis: i.actionAt ? 'actionAt' : 'resolvedAt', naturalAt: new Date(nat).toISOString(),
      minutesToAction: Math.round(tAct / 60_000), minutesToNatural: Math.round(tNat / 60_000),
      method: 'time_ratio', methodLabel: '시간 비율 추정 (조치 ÷ 자연 발견)',
      confidence: 'low', confidenceBasis: '추정 손실 · 자연 발견 시각 모두 가정값 — 사후 검증 불가한 추정',
      assumptions,
    },
  };
}

/* ============================== 업무 절감 (자동화) ============================== */

export type AutomationUnitId = 'ingest_days' | 'daily_reports' | 'weekly_reports' | 'bid_budget_changes' | 'keyword_changes' | 'detection_days';
export interface AutomationUnit {
  id: AutomationUnitId;
  /** 제안서 p.19 업무 */
  task: string;
  label: string;
  unitLabel: string;
  minutesPerUnit: number;
  /** 업무의 주간 절감 분 (기존 − 자동화 후) */
  taskWeeklySavedMin: number;
  basis: string;
}

const scope = (task: string) => SA_AUTOMATION_SCOPE.find((t) => t.task === task) ?? { task, before: 0, after: 0, how: '' };
const savedOf = (task: string) => Math.max(0, scope(task).before - scope(task).after);
const T_DAILY = '일간 성과 조회·취합', T_WEEKLY = '주간 보고서 작성', T_BID = '입찰·예산 조정', T_KW = '신규 키워드 발굴·등록', T_CHECK = '소재·URL·상태 점검';
/** 가정: 주간 조정 · 키워드 등록 건수 (실측 전) — 업무별 주간 절감 분을 건당으로 나누는 데 쓴다 */
export const ASSUMED_WEEKLY = { bidBudgetChanges: 10, keywordChanges: 5 } as const;

/**
 * 자동화 단위 → 분 (제안서 p.19 SA 업무 자동화 표에서 계산 — 표가 바뀌면 같이 바뀐다).
 * 일간 성과 조회·취합의 절감분은 '자동 수집 · 자동 리포트' 두 수단에 반씩 나눈다 (가정).
 */
export const AUTOMATION_UNITS: AutomationUnit[] = (() => {
  const d = savedOf(T_DAILY), w = savedOf(T_WEEKLY), b = savedOf(T_BID), k = savedOf(T_KW), c = savedOf(T_CHECK);
  const pt = (task: string) => `제안서 p.19 '${task}' 주 ${scope(task).before}→${scope(task).after}분 (절감 ${savedOf(task)}분)`;
  return [
    { id: 'ingest_days', task: T_DAILY, label: '자동 수집 (영업일)', unitLabel: '영업일', minutesPerUnit: r2(d / 5 / 2), taskWeeklySavedMin: d, basis: `${pt(T_DAILY)} ÷ 주 5영업일 ÷ 수집 · 리포트 반분` },
    { id: 'daily_reports', task: T_DAILY, label: '일간 리포트 자동 생성 (영업일)', unitLabel: '영업일', minutesPerUnit: r2(d / 5 / 2), taskWeeklySavedMin: d, basis: `${pt(T_DAILY)} ÷ 주 5영업일 ÷ 수집 · 리포트 반분` },
    { id: 'weekly_reports', task: T_WEEKLY, label: '주간 리포트 자동 생성', unitLabel: '건', minutesPerUnit: w, taskWeeklySavedMin: w, basis: `${pt(T_WEEKLY)} · 주 1건` },
    { id: 'bid_budget_changes', task: T_BID, label: '승인 후 자동 반영 (입찰 · 예산 · 상태)', unitLabel: '건', minutesPerUnit: r2(b / ASSUMED_WEEKLY.bidBudgetChanges), taskWeeklySavedMin: b, basis: `${pt(T_BID)} ÷ 주 ${ASSUMED_WEEKLY.bidBudgetChanges}건 가정` },
    { id: 'keyword_changes', task: T_KW, label: '키워드 등록 · 제외 자동 반영', unitLabel: '건', minutesPerUnit: r2(k / ASSUMED_WEEKLY.keywordChanges), taskWeeklySavedMin: k, basis: `${pt(T_KW)} ÷ 주 ${ASSUMED_WEEKLY.keywordChanges}건 가정` },
    { id: 'detection_days', task: T_CHECK, label: '24시간 자동 감지 가동 (영업일)', unitLabel: '영업일', minutesPerUnit: r2(c / 5), taskWeeklySavedMin: c, basis: `${pt(T_CHECK)} ÷ 주 5영업일` },
  ];
})();

export type AutomationCounts = Record<AutomationUnitId, number> & {
  /** 근거 수치 (분 계산에는 쓰지 않음) */
  evidence?: { ingestRuns?: number; reportsGenerated?: number; incidentsAutoDetected?: number; changesExecuted?: number; scanRuns?: number };
};
export interface HoursEstimate {
  kind: 'hours';
  unit: AutomationUnitId;
  task: string;
  count: number;
  minutesPerUnit: number;
  minutes: number;
  hours: number;
  /** 업무별 월 상한(주간 절감 × 영업일/5)에 걸려 깎인 분 */
  cappedMinutes: number;
  method: 'unit_minutes';
  methodLabel: string;
  confidence: Confidence;
  confidenceBasis: string;
  assumptions: string[];
}

/** 월 자동화 절감 — 단위별 분, 업무별 상한(주간 절감 분 × 월 영업일 ÷ 5)을 넘지 않게 깎는다 */
export function automationSavings(counts: AutomationCounts, businessDays: number): { rows: HoursEstimate[]; minutes: number; hours: number } {
  const byTask = new Map<string, number>();
  const raw = AUTOMATION_UNITS.map((u) => {
    const count = Math.max(0, Math.round(fin(counts[u.id]) ? counts[u.id] : 0));
    return { u, count, minutes: count * u.minutesPerUnit };
  });
  for (const r of raw) byTask.set(r.u.task, (byTask.get(r.u.task) ?? 0) + r.minutes);
  const rows: HoursEstimate[] = raw.map(({ u, count, minutes }) => {
    const cap = (u.taskWeeklySavedMin * Math.max(0, businessDays)) / 5;
    const taskTotal = byTask.get(u.task) ?? 0;
    const scale = taskTotal > cap && taskTotal > 0 ? cap / taskTotal : 1;
    const m = r2(minutes * scale);
    return {
      kind: 'hours', unit: u.id, task: u.task, count, minutesPerUnit: u.minutesPerUnit, minutes: m, hours: r2(m / 60), cappedMinutes: r2(minutes - m),
      method: 'unit_minutes', methodLabel: '자동 실행 건수 × 건당 절감 분',
      confidence: 'medium',
      confidenceBasis: '건수는 서버 실행 기록(사실) · 건당 분은 제안서 p.19 목표치(실측 전 가정)',
      assumptions: [u.basis, `업무별 월 상한 = 주간 절감 ${u.taskWeeklySavedMin}분 × 월 영업일 ${businessDays}일 ÷ 5`, '온보딩 30일 실측(제안서 p.19)으로 건당 분을 교체해야 확정값이 된다'],
    };
  });
  const minutes = r2(rows.reduce((a, r) => a + r.minutes, 0));
  return { rows, minutes, hours: r2(minutes / 60) };
}

/* ============================== 장부 · 월간 요약 ============================== */

export type LedgerStatus = 'pending' | 'measured' | 'insufficient' | 'excluded';
export type SourceType = 'change' | 'incident' | 'automation';
export const STATUS_LABEL: Record<LedgerStatus, string> = { pending: '관측 중', measured: '측정 완료', insufficient: '표본 부족', excluded: '집계 제외' };
export const SOURCE_LABEL: Record<SourceType, string> = { change: '변경 반영', incident: '사고 대응', automation: '업무 자동화' };

export interface LedgerEntry {
  id: string;
  sourceType: SourceType;
  sourceId: string;
  label: string;
  occurredAt: string;
  month: string;
  windowDays: number;
  status: LedgerStatus;
  baseline: WindowSum | null;
  observed: WindowSum | null;
  control: ControlSnapshot | null;
  estimate: UpliftEstimate | LossEstimate | HoursEstimate | null;
  detail: {
    kind?: string;
    target?: string;
    targetId?: string;
    before?: string | number;
    after?: string | number;
    severity?: string;
    reason?: string;
    reasons?: string[];
    /** 화면 이동 (해시 라우트) */
    route?: string;
    mode?: string;
    test?: boolean;
  };
  measuredAt: string | null;
}

export interface Interval { point: number; lo: number; hi: number; level: number }
export interface ImpactComponent {
  id: 'uplift' | 'loss' | 'hours';
  label: string;
  /** 회수 배수 분자에 들어가는 원 환산 값 */
  valueKrw: number;
  valueKrwInterval: Interval | null;
  /** 원값 표기 (예: 증분 매출 · 손실 회피 매출 · 시간) */
  raw: { label: string; value: number; unit: '원' | '시간'; interval?: Interval | null }[];
  method: string;
  conversion: string;
  confidence: Confidence | 'none';
  confidenceBasis: string;
  sample: { measured: number; insufficient: number; pending: number; excluded: number; note: string };
  assumptions: string[];
}
export interface PaybackVerdict { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; basis: string }
export interface ImpactSummary {
  month: string;
  generatedAt: string;
  dataMode: 'demo' | 'live' | 'mixed' | 'example';
  totals: {
    measuredUpliftRevenue: Interval;
    measuredUpliftCost: Interval;
    measuredUpliftProfit: Interval;
    lossAvoidedEst: number;
    hoursSaved: number;
    costOfSubscription: number;
    valueKrw: Interval;
    paybackMultiple: Interval;
  };
  config: ImpactConfig;
  formula: string;
  formulaFilled: string;
  verdict: PaybackVerdict;
  components: ImpactComponent[];
  counts: Record<SourceType, Record<LedgerStatus, number>>;
  conditions: string[];
  counterExamples: string[];
}

const iv = (point: number, se: number): Interval => ({ point: r0(point), lo: r0(point - Z80 * se), hi: r0(point + Z80 * se), level: CI_LEVEL });
const ivMul = (x: Interval, k: number): Interval => ({ point: x.point * k, lo: Math.min(x.lo * k, x.hi * k), hi: Math.max(x.lo * k, x.hi * k), level: x.level });
const isUplift = (e: LedgerEntry['estimate']): e is UpliftEstimate => !!e && e.kind === 'uplift';
const isLoss = (e: LedgerEntry['estimate']): e is LossEstimate => !!e && e.kind === 'loss';
const isHours = (e: LedgerEntry['estimate']): e is HoursEstimate => !!e && e.kind === 'hours';
export const krw = (n: number) => (fin(n) ? `${n < 0 ? '−' : ''}${fmt.krw(Math.abs(n))}원` : '—');
export const krwFull = (n: number) => (fin(n) ? `${n < 0 ? '−' : ''}${fmt.int(Math.abs(n))}원` : '—');
export const times = (n: number) => (fin(n) ? `${fmt.dec1(n)}배` : '—');
export const hoursText = (h: number) => (fin(h) ? `${fmt.dec1(h)}시간` : '—');

function combineConfidence(list: Confidence[]): Confidence | 'none' {
  if (!list.length) return 'none';
  if (list.every((c) => c === 'high')) return 'high';
  const ok = list.filter((c) => c !== 'low').length;
  return ok * 2 >= list.length ? 'medium' : 'low';
}

/** 회수 배수 판정 — 기준: 80% 구간 하한 ≥ 1배면 회수, 점추정만 ≥ 1배면 불확실, 점추정 < 1배면 미회수 */
export function paybackVerdict(p: Interval, anyData: boolean): PaybackVerdict {
  if (!anyData || !fin(p.point)) return { label: '판정 보류', tone: 'neutral', basis: '이 달에 측정 · 추정된 항목이 없습니다 (기준: 장부 측정 완료 1건 이상)' };
  if (p.lo >= 1) return { label: '구독료 회수', tone: 'good', basis: `80% 구간 하한 ${times(p.lo)} ≥ 기준 1배` };
  if (p.point >= 1) return { label: '회수 추정 · 불확실', tone: 'warning', basis: `점추정 ${times(p.point)} ≥ 1배 · 80% 구간 하한 ${times(p.lo)} < 1배` };
  return { label: '미회수', tone: 'critical', basis: `점추정 ${times(p.point)} < 기준 1배` };
}

export const PAYBACK_FORMULA = '회수 배수 = (측정 증분 이익 + 추정 손실 회피 × 공헌이익률 + 절감 시간 × 시간당 인건비) ÷ 월 구독료';

export const COUNTER_EXAMPLES = [
  '대조군 키워드 · 매체가 같은 기간 다른 변화(프로모션 · 품절 · 경쟁사 입찰)를 겪었다면 증분이 과대 또는 과소 추정된다.',
  '7일 창은 고관여 상품의 구매 고려 기간 · 전환 지연을 다 담지 못할 수 있다 — 늦게 잡힌 전환은 다음 수집 때 소급 반영된다.',
  '여러 변경이 같은 키워드 · 매체에 겹치면 효과가 서로 섞인다 (대조군에서는 같은 기간 변경이 있는 단위를 뺀다).',
  '손실 회피는 이슈 추정 손실과 자연 발견 시각(다음 영업일 09:30)이 맞다는 전제의 추정이다 — 업무시간 중 사람이 더 일찍 봤다면 과대 추정이다.',
  '절감 시간은 제안서 p.19 목표 소요시간 기준이다 — 온보딩 30일 실측 전에는 확정값이 아니다.',
  '매출은 매체 귀속 전환 매출이다 — 판매 채널 실매출 · 브랜드 검색 전이 효과는 따로 확인한다.',
];

/** 월간 요약 — 장부 행(이미 측정된 값)만으로 계산한다 */
export function buildSummary(entries: readonly LedgerEntry[], cfg: ImpactConfig, month: string, opts: { generatedAt?: string; dataMode?: ImpactSummary['dataMode'] } = {}): ImpactSummary {
  const inMonth = entries.filter((e) => e.month === month);
  const counts = { change: zeroCounts(), incident: zeroCounts(), automation: zeroCounts() } as ImpactSummary['counts'];
  for (const e of inMonth) counts[e.sourceType][e.status]++;

  const ups = inMonth.filter((e) => e.sourceType === 'change' && e.status === 'measured' && isUplift(e.estimate)).map((e) => e.estimate as UpliftEstimate);
  const seSq = (k: 'revenue' | 'cost') => Math.sqrt(ups.reduce((a, u) => a + u.se[k] ** 2, 0));
  const rev = iv(ups.reduce((a, u) => a + u.revenue, 0), seSq('revenue'));
  const cost = iv(ups.reduce((a, u) => a + u.cost, 0), seSq('cost'));
  // 이익은 현재 설정 공헌이익률로 다시 계산 (측정 시점 설정과 달라도 같은 매출 · 광고비 추정을 쓴다)
  const pa = ups.map((u) => profitAt(u, cfg.margin));
  const profit = iv(pa.reduce((a, x) => a + x.profit, 0), Math.sqrt(pa.reduce((a, x) => a + x.se ** 2, 0)));

  const losses = inMonth.filter((e) => e.sourceType === 'incident' && e.status === 'measured' && isLoss(e.estimate)).map((e) => e.estimate as LossEstimate);
  const lossAvoided = r0(losses.reduce((a, l) => a + l.lossAvoided, 0));

  const hrs = inMonth.filter((e) => e.sourceType === 'automation' && e.status === 'measured' && isHours(e.estimate)).map((e) => e.estimate as HoursEstimate);
  const hoursSaved = r2(hrs.reduce((a, h) => a + h.hours, 0));

  const lossKrw = lossAvoided * cfg.margin;
  const hoursKrw = hoursSaved * cfg.hourlyCost;
  const value: Interval = { point: r0(profit.point + lossKrw + hoursKrw), lo: r0(profit.lo + lossKrw + hoursKrw), hi: r0(profit.hi + lossKrw + hoursKrw), level: CI_LEVEL };
  const fee = cfg.monthlyFee;
  const pb: Interval = fee > 0
    ? { point: Math.round((value.point / fee) * 100) / 100, lo: Math.round((value.lo / fee) * 100) / 100, hi: Math.round((value.hi / fee) * 100) / 100, level: CI_LEVEL }
    : { point: NaN, lo: NaN, hi: NaN, level: CI_LEVEL };
  const anyData = ups.length + losses.length + hrs.length > 0;
  const src = (k: keyof ImpactConfig['sources']) => (cfg.sources[k] === 'workspace' ? '워크스페이스 설정' : '기본값 · 계약 시 확정 필요');

  const components: ImpactComponent[] = [
    {
      id: 'uplift', label: '측정된 증분', valueKrw: profit.point, valueKrwInterval: profit,
      raw: [
        { label: '증분 매출', value: rev.point, unit: '원', interval: rev },
        { label: '증분 광고비', value: cost.point, unit: '원', interval: cost },
        { label: '증분 이익', value: profit.point, unit: '원', interval: profit },
      ],
      method: '반영된 입찰 · 예산 변경마다 반영 전 7일 vs 후 7일, 미변경 대조군 변화를 처리군 기준선에 맞춰 뺀 스케일 차분 · 건별 부트스트랩 80% 구간',
      conversion: `증분 이익 = 증분 매출 × 공헌이익률 ${fmt.pct(cfg.margin * 100, 0)} − 증분 광고비`,
      confidence: combineConfidence(ups.map((u) => u.confidence)),
      confidenceBasis: ups.length ? `측정 ${ups.length}건의 건별 신뢰도 종합 (높음 ${ups.filter((u) => u.confidence === 'high').length} · 보통 ${ups.filter((u) => u.confidence === 'medium').length} · 낮음 ${ups.filter((u) => u.confidence === 'low').length}) · 월 합계 구간은 건별 표준오차를 독립 가정으로 합산한 정규 근사` : '측정 완료된 변경이 없습니다',
      sample: { ...counts.change, note: `표본 기준: 처리군 창마다 클릭 ${MIN_CLICKS} · 전환 ${MIN_CONVERSIONS} 이상 · 표본 부족 건은 합계에서 뺀다` },
      assumptions: [
        '대조군이 없었다면 처리군도 대조군과 같은 비율로 변했을 것 (평행 추세)',
        `공헌이익률 ${fmt.pct(cfg.margin * 100, 0)} (${src('margin')})`,
        '반영 월 기준으로 집계 (월말 7일 안에 반영된 변경은 다음 달 측정 후 이 달에 더해진다)',
      ],
    },
    {
      id: 'loss', label: '추정 손실 회피', valueKrw: r0(lossKrw), valueKrwInterval: null,
      raw: [{ label: '손실 회피 매출 (추정)', value: lossAvoided, unit: '원' }],
      method: '해결된 사고마다 이슈 추정 매출 손실 × (1 − 조치까지 시간 ÷ 자연 발견까지 시간), 자연 발견 = 다음 영업일 09:30',
      conversion: `원 환산 = 손실 회피 매출 × 공헌이익률 ${fmt.pct(cfg.margin * 100, 0)}`,
      confidence: losses.length ? 'low' : 'none',
      confidenceBasis: losses.length ? `추정 ${losses.length}건 · 추정 손실 · 자연 발견 시각 모두 가정값 (추정임)` : '이 달에 해결된 추정 대상 사고가 없습니다',
      sample: { ...counts.incident, note: '테스트 · 오탐 이슈는 제외 · 추정 손실 없는 이슈는 장부에 올리지 않는다' },
      assumptions: ['손실은 시간에 비례해 쌓인다', '자연 발견 = 발생 후 처음 오는 영업일 09:30 아침 브리핑 (24시간 감지가 없을 때)'],
    },
    {
      id: 'hours', label: '절감 시간', valueKrw: r0(hoursKrw), valueKrwInterval: null,
      raw: [{ label: '절감 시간', value: hoursSaved, unit: '시간' }],
      method: '자동 수집 · 리포트 · 감지 · 반영 실행 건수 × 제안서 p.19 업무별 건당 절감 분 (업무별 월 상한 적용)',
      conversion: `원 환산 = 절감 시간 × 시간당 인건비 ${krwFull(cfg.hourlyCost)} (${src('hourlyCost')})`,
      confidence: hrs.some((h) => h.count > 0) ? 'medium' : 'none',
      confidenceBasis: hrs.some((h) => h.count > 0) ? '건수는 서버 실행 기록(사실) · 건당 분은 제안서 목표치(실측 전 가정)' : '이 달에 기록된 자동 실행이 없습니다',
      sample: { ...counts.automation, note: `자동화 단위 ${hrs.filter((h) => h.count > 0).length}/${AUTOMATION_UNITS.length}개 실행 기록` },
      assumptions: AUTOMATION_UNITS.map((u) => `${u.label} ${fmt.dec1(u.minutesPerUnit)}분/${u.unitLabel} — ${u.basis}`),
    },
  ];

  const formulaFilled = `(${krwFull(profit.point)} + ${krwFull(lossAvoided)} × ${fmt.pct(cfg.margin * 100, 0)} + ${fmt.dec1(hoursSaved)}시간 × ${krwFull(cfg.hourlyCost)}) ÷ ${krwFull(fee)} = ${times(pb.point)}`;
  return {
    month,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    dataMode: opts.dataMode ?? 'live',
    totals: {
      measuredUpliftRevenue: rev, measuredUpliftCost: cost, measuredUpliftProfit: profit,
      lossAvoidedEst: lossAvoided, hoursSaved, costOfSubscription: fee, valueKrw: value, paybackMultiple: pb,
    },
    config: cfg,
    formula: PAYBACK_FORMULA,
    formulaFilled,
    verdict: paybackVerdict(pb, anyData),
    components,
    counts,
    conditions: [
      `월 구독료 ${krwFull(fee)} (${src('monthlyFee')})`,
      `공헌이익률 ${fmt.pct(cfg.margin * 100, 0)} (${src('margin')}) — 광고비 차감 전 매출 대비 이익률`,
      `시간당 인건비 ${krwFull(cfg.hourlyCost)} (${src('hourlyCost')})`,
      `비교 창 반영 전 · 후 각 ${IMPACT_WINDOW_DAYS}일 · 표본 기준 클릭 ${MIN_CLICKS} · 전환 ${MIN_CONVERSIONS} 이상 · 구간 수준 ${CI_LEVEL * 100}%`,
      '측정 대상: 매체에 실제(live) 반영된 입찰 · 예산 변경만 — dry_run(기록만) · 롤백 · 기록만 변경은 제외',
    ],
    counterExamples: COUNTER_EXAMPLES,
  };
}
function zeroCounts(): Record<LedgerStatus, number> {
  return { pending: 0, measured: 0, insufficient: 0, excluded: 0 };
}
export { ivMul as _scaleInterval };

/* ============================== 표기 · 내보내기 ============================== */

export function estimateText(e: LedgerEntry): string {
  const x = e.estimate;
  if (!x) return e.detail.reason ?? '—';
  if (x.kind === 'uplift') return `증분 매출 ${krw(x.revenue)} (80% ${krw(x.ci[0])} ~ ${krw(x.ci[1])}) · 이익 ${krw(x.profit)}`;
  if (x.kind === 'loss') return `손실 회피 ${krw(x.lossAvoided)} (추정 · 조치 ${fmt.minutes(x.minutesToAction)} / 자연 발견 ${fmt.minutes(x.minutesToNatural)})`;
  return `${x.count}${AUTOMATION_UNITS.find((u) => u.id === x.unit)?.unitLabel ?? '건'} × ${fmt.dec1(x.minutesPerUnit)}분 = ${hoursText(x.hours)}`;
}

const csvEsc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** 장부 CSV (엑셀 한글 깨짐 방지 BOM) */
export function ledgerCsv(entries: readonly LedgerEntry[]): string {
  const head = ['구분', '대상', '발생 · 반영 시각', '귀속 월', '상태', '사유', '반영 전 매출', '반영 후 매출', '반영 전 클릭', '반영 후 클릭', '대조군', '대조 전 매출', '대조 후 매출', '추정 방법', '증분 매출', '구간 하한', '구간 상한', '증분 광고비', '증분 이익', '손실 회피', '절감 시간', '신뢰도', '원천 id'];
  const rows = entries.map((e) => {
    const x = e.estimate;
    return [
      SOURCE_LABEL[e.sourceType], e.label, e.occurredAt, e.month, STATUS_LABEL[e.status], [e.detail.reason, ...(e.detail.reasons ?? [])].filter(Boolean).join(' · '),
      e.baseline?.revenue ?? '', e.observed?.revenue ?? '', e.baseline?.clicks ?? '', e.observed?.clicks ?? '',
      e.control ? `${e.control.label} (${e.control.units})` : '', e.control?.before?.revenue ?? '', e.control?.after?.revenue ?? '',
      x?.methodLabel ?? '', x?.kind === 'uplift' ? x.revenue : '', x?.kind === 'uplift' ? x.ci[0] : '', x?.kind === 'uplift' ? x.ci[1] : '',
      x?.kind === 'uplift' ? x.cost : '', x?.kind === 'uplift' ? x.profit : '', x?.kind === 'loss' ? x.lossAvoided : '', x?.kind === 'hours' ? x.hours : '',
      x ? CONFIDENCE_LABEL[x.confidence] : '', e.sourceId,
    ];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(csvEsc).join(',')).join('\n');
}

/* ============================== 월간 가치 리포트 ============================== */

export interface ValueReportDoc {
  title: string;
  subtitle: string;
  month: string;
  periodStart: string;
  periodEnd: string;
  sections: { id: string; title: string; zone: 'fact' | 'pattern' | 'ai' | 'cond' | 'counter' | 'action'; lines: string[] }[];
  markdown: string;
  messenger: string;
}

const ZONE_TITLE: Record<ValueReportDoc['sections'][number]['zone'], string> = {
  fact: '확정 팩트', pattern: '반복 관측 패턴', ai: 'AI 해석', cond: '전제 조건 · 기준값', counter: '반례 · 대체 시나리오', action: '다음 액션',
};

/**
 * 월간 가치 리포트 — 구독료 대비 회수 배수와 근거. 영역을 섞지 않는다:
 *  확정 팩트 = 실행 기록 건수 · 측정 원값, 반복 관측 패턴 = 건별 결과에서 반복되는 모습, AI 해석 = 규칙 엔진 해석(추정 포함 명시),
 *  전제 조건 · 반례는 별도 영역.
 */
export function buildValueReport(summary: ImpactSummary, entries: readonly LedgerEntry[], opts: { brand: string; appUrl?: string; dataLabel?: string }): ValueReportDoc {
  const m = summary.month;
  const days = monthDates(m);
  const t = summary.totals;
  const inMonth = entries.filter((e) => e.month === m);
  const ch = inMonth.filter((e) => e.sourceType === 'change');
  const ups = ch.filter((e) => e.status === 'measured' && isUplift(e.estimate));
  const inc = inMonth.filter((e) => e.sourceType === 'incident' && e.status === 'measured' && isLoss(e.estimate));
  const auto = inMonth.filter((e) => e.sourceType === 'automation' && isHours(e.estimate));
  const c = summary.counts;
  const dataLabel = opts.dataLabel ?? (summary.dataMode === 'demo' ? 'TEST DATA (시연용 테스트 데이터 · 실제 성과 아님)' : summary.dataMode === 'mixed' ? '일부 TEST DATA 포함 (매체 · 채널별 출처 확인)' : '연동 데이터 (LIVE)');

  const facts = [
    `데이터: ${dataLabel}.`,
    `변경 반영 장부 ${ch.length}건 — 측정 완료 ${c.change.measured} · 표본 부족 ${c.change.insufficient} · 관측 중 ${c.change.pending} · 집계 제외 ${c.change.excluded}.`,
    ...ups.slice(0, 6).map((e) => `${e.label}: 반영 전 ${IMPACT_WINDOW_DAYS}일 매출 ${krwFull(e.baseline?.revenue ?? NaN)} → 반영 후 ${krwFull(e.observed?.revenue ?? NaN)}${e.control?.before && e.control.after ? ` · 대조군(${e.control.label} ${e.control.units}개) ${krwFull(e.control.before.revenue)} → ${krwFull(e.control.after.revenue)}` : ''}.`),
    `해결된 사고 중 손실 추정 대상 ${inc.length}건 (제외 ${c.incident.excluded}건: 테스트 · 오탐 · 시각 기록 없음).`,
    ...inc.slice(0, 4).map((e) => {
      const x = e.estimate as LossEstimate;
      return `${e.label}: 발생 ${kstStamp(Date.parse(x.occurredAt))} → 조치 ${kstStamp(Date.parse(x.actionAt))} (${fmt.minutes(x.minutesToAction)}) · 이슈 추정 손실 ${krwFull(x.revenueLossEst)}.`;
    }),
    `자동 실행 기록: ${auto.filter((e) => (e.estimate as HoursEstimate).count > 0).map((e) => `${AUTOMATION_UNITS.find((u) => u.id === (e.estimate as HoursEstimate).unit)?.label ?? e.label} ${(e.estimate as HoursEstimate).count}${AUTOMATION_UNITS.find((u) => u.id === (e.estimate as HoursEstimate).unit)?.unitLabel ?? '건'}`).join(' · ') || '없음'}.`,
    `월 구독료 ${krwFull(t.costOfSubscription)} (${summary.config.sources.monthlyFee === 'workspace' ? '워크스페이스 설정' : '기본값'}).`,
  ];

  const patterns: string[] = [];
  if (ups.length) {
    const pos = ups.filter((e) => (e.estimate as UpliftEstimate).ci[0] > 0).length;
    const neg = ups.filter((e) => (e.estimate as UpliftEstimate).ci[1] < 0).length;
    const zero = ups.length - pos - neg;
    patterns.push(`측정된 변경 ${ups.length}건 중 80% 구간이 0보다 큰 건 ${pos} · 0보다 작은 건 ${neg} · 0을 포함하는 건 ${zero}.`);
    const byKind = new Map<string, number[]>();
    for (const e of ups) {
      const k = e.detail.kind === 'budget' ? '예산' : '입찰';
      const arr = byKind.get(k) ?? [];
      arr.push((e.estimate as UpliftEstimate).revenue);
      byKind.set(k, arr);
    }
    for (const [k, arr] of byKind) if (arr.length >= 2) patterns.push(`${k} 변경 ${arr.length}건의 증분 매출 중앙값 ${krw([...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)])}.`);
  }
  const insuff = ch.filter((e) => e.status === 'insufficient');
  if (insuff.length) {
    const clicks = insuff.filter((e) => (e.detail.reasons ?? []).some((r) => r.includes('클릭'))).length;
    patterns.push(`표본 부족 ${insuff.length}건 중 클릭 기준 미달 ${clicks}건 — 저볼륨 키워드 변경은 7일로 판정하기 어렵다.`);
  }
  if (inc.length >= 2) {
    const mins = inc.map((e) => (e.estimate as LossEstimate).minutesToAction).sort((a, b) => a - b);
    patterns.push(`사고 ${inc.length}건의 발생 → 조치 시간 중앙값 ${fmt.minutes(mins[Math.floor(mins.length / 2)])} (자연 발견까지 중앙값 ${fmt.minutes(inc.map((e) => (e.estimate as LossEstimate).minutesToNatural).sort((a, b) => a - b)[Math.floor(inc.length / 2)])}).`);
  }
  if (!patterns.length) patterns.push('반복 관측으로 볼 만큼 측정 건수가 쌓이지 않았다 (변경 측정 · 사고 추정 각 2건 미만).');

  const pb = t.paybackMultiple;
  const interp = [
    `회수 배수 ${times(pb.point)} (80% 구간 ${times(pb.lo)} ~ ${times(pb.hi)}) — 판정 '${summary.verdict.label}' · 기준 ${summary.verdict.basis}.`,
    `구성: 측정 증분 이익 ${krw(t.measuredUpliftProfit.point)} · 손실 회피 원 환산 ${krw(summary.components[1].valueKrw)} (추정) · 절감 시간 원 환산 ${krw(summary.components[2].valueKrw)} (${hoursText(t.hoursSaved)}).`,
    summary.components[0].valueKrw >= summary.components[1].valueKrw + summary.components[2].valueKrw
      ? '회수의 대부분이 측정된 증분(대조군 보정)에서 나와 근거가 상대적으로 단단하다고 본다.'
      : '회수의 상당 부분이 추정(손실 회피) · 가정(건당 절감 분)에서 나온다 — 측정된 증분이 쌓이기 전까지는 보수적으로 읽는다.',
    '규칙 엔진 해석이다 (AI 미연결 시 대체) — 확정 팩트와 구분해 읽는다.',
  ];
  const actions = [
    c.change.pending ? `관측 중 ${c.change.pending}건은 반영 후 7일 데이터가 쌓이면 다음 측정(매일 06:00)에서 이 달에 더해진다.` : '',
    insuff.length ? '표본 부족 변경은 같은 의도 키워드를 묶어 판정하거나 비교 창을 늘리는 방식을 검토한다.' : '',
    summary.config.sources.margin === 'default' || summary.config.sources.hourlyCost === 'default' ? '공헌이익률 · 시간당 인건비를 워크스페이스 설정에서 실제 값으로 확정한다 (지금은 기본값).' : '',
    '온보딩 30일 실측으로 업무별 건당 절감 분을 교체한다 (제안서 p.19).',
  ].filter(Boolean);

  const sections: ValueReportDoc['sections'] = [
    { id: 'fact', title: ZONE_TITLE.fact, zone: 'fact', lines: facts },
    { id: 'pattern', title: ZONE_TITLE.pattern, zone: 'pattern', lines: patterns },
    { id: 'ai', title: ZONE_TITLE.ai, zone: 'ai', lines: interp },
    { id: 'cond', title: ZONE_TITLE.cond, zone: 'cond', lines: [summary.formula, `대입: ${summary.formulaFilled}`, ...summary.conditions] },
    { id: 'counter', title: ZONE_TITLE.counter, zone: 'counter', lines: summary.counterExamples },
    { id: 'action', title: ZONE_TITLE.action, zone: 'action', lines: actions },
  ];
  const title = `월간 가치 리포트 · ${monthLabel(m)}`;
  const subtitle = `${opts.brand} · 구독료 대비 회수 배수와 근거 (측정 · 추정 · 가정 구분)`;
  const table = [
    '| 항목 | 원 환산 | 원값 | 방법 | 신뢰도 |',
    '| --- | ---: | ---: | --- | --- |',
    ...summary.components.map((x) => `| ${x.label} | ${krwFull(x.valueKrw)} | ${x.raw.map((r) => (r.unit === '시간' ? hoursText(r.value) : `${r.label} ${krwFull(r.value)}`)).join(' / ')} | ${x.method.replace(/\|/g, '/')} | ${x.confidence === 'none' ? '측정 없음' : CONFIDENCE_LABEL[x.confidence]} |`),
  ].join('\n');
  const md = [
    `# ${title}`,
    `> ${subtitle} · 대상 기간 ${days[0]} ~ ${days[days.length - 1]} · 데이터: ${dataLabel}`,
    `**회수 배수 ${times(pb.point)}** (80% 구간 ${times(pb.lo)} ~ ${times(pb.hi)}) · 판정: ${summary.verdict.label} — ${summary.verdict.basis}`,
    table,
    ...sections.map((s) => `### ${s.title}\n${s.lines.map((l) => `- ${l}`).join('\n')}`),
    '---',
    `_성과 증명 장부(MILDO OS Cloud)에서 자동 생성 · 증분은 측정, 손실 회피는 추정, 절감 시간은 가정 기반 환산${opts.appUrl ? ` · 장부 보기: ${opts.appUrl}/#impact` : ''}_`,
  ].join('\n\n');
  const messenger = [
    `[MILDO 가치] ${monthLabel(m)} 회수 배수 ${times(pb.point)} (80% ${times(pb.lo)}~${times(pb.hi)}) · ${summary.verdict.label}${summary.dataMode === 'demo' ? ' · TEST DATA' : ''}`,
    `측정 증분 이익 ${krw(t.measuredUpliftProfit.point)} (측정 ${c.change.measured}건) · 손실 회피 ${krw(t.lossAvoidedEst)} 추정 (${inc.length}건) · 절감 ${hoursText(t.hoursSaved)}`,
    `구독료 ${krw(t.costOfSubscription)} · 공헌이익률 ${fmt.pct(summary.config.margin * 100, 0)} · 시간당 ${krw(summary.config.hourlyCost)} 기준`,
  ].join('\n');
  return { title, subtitle, month: m, periodStart: days[0], periodEnd: days[days.length - 1], sections, markdown: md, messenger };
}

/* ============================== 데모 예시 (서버 없음) ============================== */

interface DemoKeyword { id: string; text: string; intent: string; adgroup: string; bid: number; status: string; daily: { impressions: number; clicks: number; cost: number; conversions: number; revenue: number }[] }
interface DemoIncident { id: string; title: string; severity: string; detectedAt: string; occurredAt: string; impact: { revenueLossEst?: number }; isTest?: boolean }

/**
 * 데모 모드 예시 — 데모 Dataset(TEST DATA)의 키워드 14일 일별 값에서 '7일째 반영'을 가정해 같은 추정기로 계산한다.
 * 실제 반영 이력 · 사고 조치 시각 · 자동 실행 기록이 아니므로 화면에 TEST DATA · 예시로 표기한다.
 */
export function buildDemoImpact(d: { today: string; keywords: readonly DemoKeyword[] }, incidents: readonly DemoIncident[], cfg: ImpactConfig = impactConfig(null)): { month: string; entries: LedgerEntry[]; summary: ImpactSummary } {
  const month = d.today.slice(0, 7);
  const dates = datesBetween(addDaysUtc(d.today, -14), addDaysUtc(d.today, -1));
  const before = dates.slice(0, 7), applied = dates[7], after = dates.slice(7, 14);
  const rec = (k: DemoKeyword) => Object.fromEntries(k.daily.slice(-14).map((s, i) => [dates[i], { date: dates[i], ...s }]));
  const on = d.keywords.filter((k) => k.status !== 'off' && k.daily.length >= 14);
  const ranked = [...on].sort((a, b) => sumOf(b.daily, 'clicks') - sumOf(a.daily, 'clicks'));
  const picks = [...ranked.slice(0, 3), ...ranked.slice(-1)].filter((k, i, arr) => arr.findIndex((x) => x.id === k.id) === i);
  const entries: LedgerEntry[] = [];
  for (const k of picks) {
    const peers = on.filter((x) => x.id !== k.id && x.intent === k.intent && !picks.some((p) => p.id === x.id));
    const control: Record<string, DayMetrics> = {};
    for (const p of peers) for (const [date, s] of Object.entries(rec(p))) {
      const c = control[date] ?? { date, clicks: 0, cost: 0, conversions: 0, revenue: 0, impressions: 0 };
      c.clicks += s.clicks; c.cost += s.cost; c.conversions += s.conversions; c.revenue += s.revenue; c.impressions = (c.impressions ?? 0) + s.impressions;
      control[date] = c;
    }
    const treated = rec(k);
    const est = estimateUplift({ beforeDates: before, afterDates: after, treated, control: peers.length ? control : null, controlUnits: peers.length, margin: cfg.margin, seed: `demo:${k.id}`, iterations: 600 });
    entries.push({
      id: `demo-change-${k.id}`, sourceType: 'change', sourceId: `demo:${k.id}`, label: `${k.text} 입찰가 조정 (예시)`, occurredAt: `${applied}T10:00:00+09:00`, month, windowDays: 7,
      status: est.sufficiency.ok ? 'measured' : 'insufficient',
      baseline: sumWindowPublic(treated, before), observed: sumWindowPublic(treated, after),
      control: { basis: peers.length ? 'intent' : 'none', label: peers.length ? '같은 의도 미변경 키워드' : '대조군 없음', units: peers.length, ids: peers.map((p) => p.id), before: peers.length ? sumWindowPublic(control, before) : null, after: peers.length ? sumWindowPublic(control, after) : null },
      estimate: est,
      detail: { kind: 'bid', target: k.text, targetId: k.id, before: k.bid, after: Math.round(k.bid * 1.1 / 10) * 10, route: 'adpilot', mode: 'example', test: true, reasons: est.sufficiency.ok ? undefined : est.sufficiency.reasons },
      measuredAt: null,
    });
  }
  for (const i of incidents.filter((x) => (x.impact?.revenueLossEst ?? 0) > 0).slice(0, 3)) {
    const det = Date.parse(i.detectedAt);
    const r = estimateLossAvoided({ id: i.id, title: i.title, severity: i.severity, revenueLossEst: i.impact.revenueLossEst, occurredAt: i.occurredAt, detectedAt: i.detectedAt, actionAt: new Date(det + 25 * 60_000).toISOString() });
    entries.push({
      id: `demo-incident-${i.id}`, sourceType: 'incident', sourceId: `demo:${i.id}`, label: `${i.severity} ${i.title} (예시)`, occurredAt: i.detectedAt, month, windowDays: 0,
      status: r.ok ? 'measured' : 'excluded', baseline: null, observed: null, control: null, estimate: r.ok ? r.estimate : null,
      detail: { severity: i.severity, route: 'alert', test: true, reason: r.ok ? '예시 가정: 감지 25분 뒤 1차 조치' : r.reason }, measuredAt: null,
    });
  }
  const bdays = businessDaysIn(month, d.today);
  const counts: AutomationCounts = { ingest_days: bdays, daily_reports: bdays, weekly_reports: Math.max(1, Math.floor(bdays / 5)), bid_budget_changes: 18, keyword_changes: 6, detection_days: bdays };
  for (const row of automationSavings(counts, bdays).rows) {
    const u = AUTOMATION_UNITS.find((x) => x.id === row.unit)!;
    entries.push({
      id: `demo-auto-${row.unit}`, sourceType: 'automation', sourceId: `${month}:${row.unit}`, label: u.label, occurredAt: `${month}-01T00:00:00+09:00`, month, windowDays: 0,
      status: 'measured', baseline: null, observed: null, control: null, estimate: row, detail: { reason: '예시 건수 (TEST DATA)', test: true }, measuredAt: null,
    });
  }
  return { month, entries, summary: buildSummary(entries, cfg, month, { dataMode: 'example' }) };
}
const sumOf = (xs: readonly { clicks: number }[], k: 'clicks') => xs.reduce((a, x) => a + (fin(x[k]) ? x[k] : 0), 0);
const sumWindowPublic = (rec: Record<string, DayMetrics>, dates: string[]) => windowSum(rec, dates);
