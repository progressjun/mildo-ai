/**
 * MILDO Alert 탐지 엔진 (순수 함수 · React 없음).
 * Shell이 앱 시작 시 detectIncidents(data)를 호출해 이슈를 스토어에 넣는다.
 * 같은 이슈는 항상 같은 id를 가진다: `${ruleId}:${target}:${today}`.
 *
 * 기준 (제안서 v3)
 *  - p.44 크리티컬 이슈 6유형 · p.45 추가 탐지 6종 · p.47 성과 이상 징후 기준(주의/위험)
 *  - p.48 주말 · 공휴일 대응 · p.49 SLA · 이슈 보고서 양식 · p.50 계정 · 결제 · 권한
 * 기준선은 mediaHourly로 실제 계산한다 (동요일 = 최근 4주 같은 요일 같은 시간 평균).
 */
import type {
  AdAccount, Campaign, ChangeRequest, Dataset, HourlyMediaRow, Incident, Keyword, MediaId, Promotion, SalesChannelId, Severity,
} from '@/core/types';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, CAUSE_CANDIDATES, INCIDENT_REPORT_TEMPLATE, MEDIA, MEDIA_IDS, SALES_CHANNELS, SLA, TF_ROLES,
} from '@/data/constants';
import { monthlyPacing } from '@/core/selectors';
import { addDays, fmt, isOffDay, mean, metrics, sum } from '@/core/util';
import { MODULE_LABEL } from '@/modules/flow/data';
import {
  DEMO_CREATIVES, DETECT_DEFAULTS, MEDIA_OWNER_ROLE, NOTIFY_BY_TYPE, ON_DUTY_POOL, PACE_CURVE_DAYS, ROLE_ACCOUNT_USER, RULES, SLA_HISTORY, TYPE_LABEL,
  WEEKEND_ACK_MIN, type CreativeReview, type TestScenarioId,
} from './data';

/* ============================== 타입 ============================== */

export type Level = 'danger' | 'warn' | 'ok';
export type MetricKey = 'cost' | 'clicks' | 'conversions' | 'cpa' | 'roas';
export type ValueUnit = 'krw' | 'int' | 'dec' | 'pct' | 'roas' | 'won' | 'hours' | 'days' | 'ratio' | 'times' | 'rank' | 'text';

/** 감지 근거 수치 (드로어 · 보고서 · 에이전트 공용) */
export interface Evidence {
  label: string;
  observed: number;
  baseline?: number;
  deltaPct?: number;
  unit: ValueUnit;
  baseLabel?: string; // 비교 기준 (동요일 · 동시간 평균 등)
  threshold?: string; // 판정 기준값 표기
  level?: Level | 'info';
  note?: string;
}
export interface CauseScore { label: string; score: number; basis: string }

export interface AlertIncident extends Incident {
  typeId: string;
  ruleLabel: string;
  basis: string; // 판정 기준
  page: string; // 제안서 장표
  evidence: Evidence[];
  causes: CauseScore[];
  impactNote?: string;
  ownerRoleId?: string;
  assigneeRoleId?: string;
  backupRoleId?: string;
  onDuty?: boolean;
  holdMedia?: MediaId;
  related?: string[];
  recurrence?: { count: number; dates: string[] };
  /** 처리 단계 기록 (데이터 기준 시각 ISO) */
  sla?: { ackAt?: string; assignedAt?: string; actionAt?: string; reportAt?: string; preventAt?: string; resolvedAt?: string };
  falsePositive?: boolean;
}

export interface Threshold { warn: number; danger: number }
export interface AlertConfig {
  thresholds: Record<MetricKey, Threshold>;
  windowHours: number;
  minConvForRatio: number;
  trackingZeroHours: number;
  trackingClickRatio: number;
  trackingZeroRateMax: number;
  keywordSpikePct: number;
  keywordRecentDays: number;
  keywordMinConv: number;
  budgetLostShare: number;
  brandRank: number;
  brandLost: number;
  invalidClickPct: number;
  invalidCvrDropPct: number;
  runwayWarnDays: number;
  staleLoginDays: number;
  creativePendingHours: number;
  searchVolumePct: number;
  bulkBatch: number;
  bulkWindowMin: number;
}

export interface DetectOptions {
  config?: Partial<AlertConfig>;
  creatives?: CreativeReview[];
  /** state.offHoursMode — 평일에도 주말 · 공휴일 당번 체계로 배정 */
  offHours?: boolean;
}

/* ============================== 설정 ============================== */

export function defaultConfig(): AlertConfig {
  const thresholds = {} as Record<MetricKey, Threshold>;
  for (const t of ANOMALY_THRESHOLDS) thresholds[t.metric as MetricKey] = { warn: t.warnPct, danger: t.dangerPct };
  return { thresholds, ...DETECT_DEFAULTS, keywordSpikePct: AD_PILOT.anomalyHoldPct };
}

export function resolveConfig(partial?: Partial<AlertConfig>): AlertConfig {
  const base = defaultConfig();
  if (!partial) return base;
  return { ...base, ...partial, thresholds: { ...base.thresholds, ...(partial.thresholds ?? {}) } };
}

/** 탐지 기준 편집 대상 (기준 변경은 ChangeRequest kind 'alert_rule', approver 'PM') */
export const CONFIG_FIELDS: { key: string; label: string; kind: 'threshold' | 'number'; unit: string; page: string; min: number; max: number }[] = [
  ...ANOMALY_THRESHOLDS.map((t) => ({ key: t.metric, label: `${t.label} · ${t.baseline}`, kind: 'threshold' as const, unit: '%', page: 'p.47', min: 5, max: 200 })),
  { key: 'windowHours', label: '동시간 비교 구간', kind: 'number', unit: '시간', page: '운영 가정', min: 1, max: 6 },
  { key: 'trackingZeroHours', label: '전환 추적 단절 · 연속 전환 0', kind: 'number', unit: '시간', page: 'p.45', min: 1, max: 12 },
  { key: 'keywordSpikePct', label: '키워드 급변 · 최근 3일 CPC/전환', kind: 'number', unit: '%', page: 'p.14', min: 10, max: 200 },
];

export function encodeThreshold(t: Threshold): string {
  return `주의 ${t.warn}% · 위험 ${t.danger}%`;
}
export function parseThreshold(v: string | number): Threshold | null {
  const m = String(v).match(/주의\s*([\d.]+)\s*%.*위험\s*([\d.]+)\s*%/);
  if (!m) return null;
  const warn = Number(m[1]);
  const danger = Number(m[2]);
  return Number.isFinite(warn) && Number.isFinite(danger) && warn > 0 && danger >= warn ? { warn, danger } : null;
}

/** 반영(applied)된 alert_rule 변경을 시간순으로 적용한 현재 탐지 기준 */
export function activeConfig(changes: readonly ChangeRequest[]): AlertConfig {
  const cfg = defaultConfig();
  const applied = changes
    .filter((c) => c.kind === 'alert_rule' && c.status === 'applied' && c.targetId?.startsWith('alert_rule:'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of applied) {
    const key = c.targetId!.slice('alert_rule:'.length);
    const field = CONFIG_FIELDS.find((f) => f.key === key);
    if (!field) continue;
    if (field.kind === 'threshold') {
      const t = parseThreshold(c.after);
      if (t) cfg.thresholds[key as MetricKey] = t;
    } else {
      const n = Number(String(c.after).match(/-?[\d.]+/)?.[0]);
      if (Number.isFinite(n) && n >= field.min && n <= field.max) (cfg as unknown as Record<string, number>)[key] = n;
    }
  }
  return cfg;
}

/* ============================== 시간 (KST 고정) ============================== */

const HOUR_MS = 3_600_000;
const KST_MS = 9 * HOUR_MS;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function kstIso(date: string, hour: number, minute = 0): string {
  const totalMin = Math.round(hour * 60 + minute);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return msToKstIso(Date.parse(`${date}T00:00:00+09:00`) + totalMin * 60_000);
  return `${date}T${pad2(h)}:${pad2(m)}:00+09:00`;
}
export function msToKstIso(ms: number): string {
  const d = new Date(ms + KST_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+09:00`;
}
export function kstDate(ms: number): string {
  return msToKstIso(ms).slice(0, 10);
}
export function fmtClock(ms: number): string {
  return Number.isFinite(ms) ? msToKstIso(ms).slice(11, 16) : '—';
}
export function fmtStamp(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const s = msToKstIso(ms);
  return `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))} ${s.slice(11, 16)}`;
}
const dayStartMs = (date: string) => Date.parse(`${date}T00:00:00+09:00`);
function dayNum(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
export function dayDiff(a: string, b: string): number {
  return dayNum(a) - dayNum(b);
}
/** 다음 영업일 (from 다음 날부터) */
export function nextBusinessDay(from: string): string {
  let d = addDays(from, 1);
  for (let i = 0; i < 30 && isOffDay(d).off; i++) d = addDays(d, 1);
  return d;
}
export function prevBusinessDay(from: string): string {
  let d = addDays(from, -1);
  for (let i = 0; i < 30 && isOffDay(d).off; i++) d = addDays(d, -1);
  return d;
}

/* ============================== 포맷 ============================== */

export function fmtValue(unit: ValueUnit, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'krw': return `${fmt.krw(v)}원`;
    case 'won': return fmt.won(v);
    case 'int': return fmt.int(v);
    case 'dec': return v >= 10 ? fmt.int(v) : fmt.dec1(v);
    case 'pct': return fmt.pct(v);
    case 'roas': return fmt.roas(v);
    case 'hours': return `${fmt.dec1(v)}시간`;
    case 'days': return `${fmt.dec1(v)}일`;
    case 'ratio': return fmt.ratio(v, 0);
    case 'times': return `${v.toFixed(2)}배`;
    case 'rank': return `${v.toFixed(1)}위`;
    default: return String(v);
  }
}
export function evidenceText(e: Evidence): string {
  const parts = [e.unit === 'text' ? `${e.label} ${e.note ?? ''}`.trim() : `${e.label} ${fmtValue(e.unit, e.observed)}`];
  if (e.baseline !== undefined) parts.push(`기준 ${fmtValue(e.unit, e.baseline)}`);
  if (e.deltaPct !== undefined && Number.isFinite(e.deltaPct)) parts.push(fmt.delta(e.deltaPct));
  if (e.threshold) parts.push(`판정 ${e.threshold}`);
  return parts.join(' · ');
}
/** 대표 근거 한 줄 (큐 · 알림 카드) */
export function primaryEvidence(inc: Pick<AlertIncident, 'evidence'> & Partial<Incident>): string {
  const ev = inc.evidence?.find((e) => e.level === 'danger') ?? inc.evidence?.find((e) => e.level === 'warn') ?? inc.evidence?.[0];
  if (ev) return evidenceText(ev);
  if (inc.metric && inc.observed !== undefined) return `${inc.metric} ${fmt.int(inc.observed)}${inc.deltaPct !== undefined ? ` · ${fmt.delta(inc.deltaPct)}` : ''}`;
  return '근거 수치 없음';
}

/* ============================== TF · 당번 ============================== */

export function roleLabel(id: string | undefined): string {
  if (!id) return '—';
  return TF_ROLES.find((r) => r.id === id)?.role ?? id;
}
export function backupOf(id: string): string {
  return TF_ROLES.find((r) => r.id === id)?.backup ?? 'pm';
}
export function roleIdByLabel(label: string | undefined): string | undefined {
  return TF_ROLES.find((r) => r.role === label)?.id;
}

export interface DutyRow { date: string; label: string; roleId: string; role: string; backupId: string; backup: string; escalation: string }
/** p.48 주말 · 공휴일 당번 순번 (주말은 토 · 일 같은 당번, 평일 공휴일은 일자 순번) */
export function onDutyFor(date: string): DutyRow | null {
  const off = isOffDay(date);
  if (!off.off) return null;
  const w = new Date(`${date}T12:00:00Z`).getUTCDay();
  const anchor = w === 0 ? addDays(date, -1) : date;
  const isWeekend = w === 0 || w === 6;
  const idx = isWeekend ? Math.floor(dayNum(anchor) / 7) % ON_DUTY_POOL.length : dayNum(date) % ON_DUTY_POOL.length;
  const roleId = ON_DUTY_POOL[(idx + ON_DUTY_POOL.length) % ON_DUTY_POOL.length];
  const backupId = backupOf(roleId);
  return { date, label: off.label, roleId, role: roleLabel(roleId), backupId, backup: roleLabel(backupId), escalation: '총괄 PM (P1 한정)' };
}

export interface OffBlock { start: string; end: string; days: number; dates: string[]; labels: string[]; hasHoliday: boolean; prevBusinessDay: string; nextBusinessDay: string }
/** 기준일부터 n일 안의 연속 휴무 구간 (기준일이 휴무면 진행 중 구간 포함) */
export function offBlocks(from: string, horizonDays: number): OffBlock[] {
  const out: OffBlock[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const labels = cur.map((d) => isOffDay(d).label);
    out.push({
      start: cur[0], end: cur[cur.length - 1], days: cur.length, dates: [...cur], labels,
      hasHoliday: labels.some((l) => l !== '토요일' && l !== '일요일'),
      prevBusinessDay: prevBusinessDay(cur[0]), nextBusinessDay: nextBusinessDay(cur[cur.length - 1]),
    });
    cur = [];
  };
  // 진행 중 구간의 시작을 찾는다
  let start = from;
  for (let i = 0; i < 10 && isOffDay(addDays(start, -1)).off; i++) start = addDays(start, -1);
  const total = horizonDays + dayDiff(from, start);
  for (let i = 0; i <= total; i++) {
    const d = addDays(start, i);
    if (isOffDay(d).off) cur.push(d);
    else flush();
  }
  flush();
  return out;
}

export function rotationTable(from: string, horizonDays: number): DutyRow[] {
  return offBlocks(from, horizonDays).flatMap((b) => b.dates.map((d) => onDutyFor(d)!)).filter(Boolean);
}

/** 현재 운영 체계: 주말 · 공휴일이거나 강제 모드면 당번 체계 */
export function regimeOf(date: string, forced = false): { off: boolean; label: string; forced: boolean; duty: DutyRow | null } {
  const o = isOffDay(date);
  const duty = onDutyFor(date);
  if (o.off) return { off: true, label: o.label, forced: false, duty };
  if (forced) {
    // 평일 강제 시뮬레이션: 가장 가까운 토요일 순번을 사용
    let d = date;
    for (let i = 0; i < 7 && !isOffDay(d).off; i++) d = addDays(d, 1);
    return { off: true, label: '주말 모드 시뮬레이션', forced: true, duty: onDutyFor(d) };
  }
  return { off: false, label: '평일', forced: false, duty: null };
}

/* ============================== 시간별 집계 · 기준선 ============================== */

interface Agg { impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
const zeroAgg = (): Agg => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 });
type HourIdx = Map<string, HourlyMediaRow>;
const hk = (date: string, media: string, hour: number) => `${date}|${media}|${hour}`;

export function buildHourIndex(data: Dataset): HourIdx {
  const m: HourIdx = new Map();
  for (const r of data.mediaHourly) m.set(hk(r.date, r.media, r.hour), r);
  return m;
}
function aggHours(idx: HourIdx, date: string, media: MediaId, hours: number[]): Agg | null {
  const a = zeroAgg();
  for (const h of hours) {
    const r = idx.get(hk(date, media, h));
    if (!r) return null;
    a.impressions += r.impressions; a.clicks += r.clicks; a.cost += r.cost; a.conversions += r.conversions; a.revenue += r.revenue;
  }
  return a;
}
function meanAgg(list: (Agg | null)[], minDays = 2): { agg: Agg; days: number } | null {
  const ok = list.filter((x): x is Agg => !!x);
  if (ok.length < minDays) return null;
  const a = zeroAgg();
  for (const x of ok) { a.impressions += x.impressions; a.clicks += x.clicks; a.cost += x.cost; a.conversions += x.conversions; a.revenue += x.revenue; }
  const n = ok.length;
  return { agg: { impressions: a.impressions / n, clicks: a.clicks / n, cost: a.cost / n, conversions: a.conversions / n, revenue: a.revenue / n }, days: n };
}
const sameWeekdayDates = (today: string) => [1, 2, 3, 4].map((k) => addDays(today, -7 * k));
const last7Dates = (today: string) => [1, 2, 3, 4, 5, 6, 7].map((k) => addDays(today, -k));
const ALL_HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 캐시 키 = mediaHourly 배열 (배열을 교체하면 다시 계산) */
const profileCache = new WeakMap<readonly HourlyMediaRow[], Map<string, number[]>>();
/**
 * 매체 시간대 비중 (24시간 합 = 1) — 최근 PACE_CURVE_DAYS일(오늘 제외)의 시간대별 합 ÷ 전체 합. 없으면 균등.
 * MILDO Board · AD Pilot의 시간대 가중 소진 곡선과 같은 기간 · 같은 산식이라 예상 마감 시각이 화면 간 일치한다.
 * (이상 징후 기준선은 p.47대로 동요일 · 동시간을 따로 계산한다 — evaluateMedia)
 */
export function hourProfile(data: Dataset, media: MediaId, field: 'cost' | 'revenue' | 'impressions' = 'cost', _idx?: HourIdx, days = PACE_CURVE_DAYS): number[] {
  const rows = data.mediaHourly ?? [];
  let byData = profileCache.get(rows);
  if (!byData) { byData = new Map(); profileCache.set(rows, byData); }
  const key = `${data.today}|${media}|${field}|${days}`;
  const hit = byData.get(key);
  if (hit) return hit;
  const from = addDays(data.today, -days);
  const byH = new Array<number>(24).fill(0);
  let tot = 0;
  for (const r of rows) {
    if (r.media !== media || r.date >= data.today || r.date < from || !(r.hour >= 0 && r.hour <= 23)) continue;
    const v = Number.isFinite(r[field]) ? Math.max(0, r[field]) : 0;
    byH[r.hour] += v;
    tot += v;
  }
  const out = tot > 0 ? byH.map((v) => v / tot) : ALL_HOURS.map(() => 1 / 24);
  byData.set(key, out);
  return out;
}
const pct = (cur: number, base: number) => (base > 0 ? ((cur - base) / base) * 100 : cur > 0 ? Infinity : NaN);
function levelOf(delta: number, th: Threshold, dir: 'both' | 'up' | 'down'): Level {
  if (!Number.isFinite(delta)) return 'ok';
  const v = dir === 'up' ? delta : dir === 'down' ? -delta : Math.abs(delta);
  return v >= th.danger ? 'danger' : v >= th.warn ? 'warn' : 'ok';
}
const thresholdText = (th: Threshold, dir: 'both' | 'up' | 'down') => {
  const s = dir === 'both' ? '±' : dir === 'up' ? '+' : '−';
  return `주의 ${s}${th.warn}% · 위험 ${s}${th.danger}%`;
};

export interface MetricEval {
  metric: MetricKey;
  label: string;
  baseLabel: string;
  observed: number;
  baseline: number;
  deltaPct: number;
  threshold: Threshold;
  direction: 'both' | 'up' | 'down';
  level: Level;
  sampleOk: boolean;
  note?: string;
}
export interface MediaEval {
  media: MediaId;
  hours: number[];
  today: Agg;
  sameWeekday: Agg | null;
  sameWeekdayDays: number;
  last7Same: Agg | null;
  expectedConv: number;
  evals: MetricEval[];
  level: Level;
  triggering: MetricEval[];
  derived: { ctrD: number; cpcD: number; cpmD: number; cvrD: number; impsD: number };
}

/** p.47 기준으로 매체 하나를 평가 (최근 windowHours 시간 vs 기준선) */
export function evaluateMedia(data: Dataset, media: MediaId, cfgIn?: AlertConfig, idx = buildHourIndex(data), excludeConv = false): MediaEval | null {
  const cfg = cfgIn ?? defaultConfig();
  const ch = data.currentHour;
  const w = Math.max(1, Math.min(6, Math.round(cfg.windowHours)));
  const hours = Array.from({ length: Math.min(w, ch + 1) }, (_, i) => ch - Math.min(w, ch + 1) + 1 + i);
  const today = aggHours(idx, data.today, media, hours);
  if (!today) return null;
  const sw = meanAgg(sameWeekdayDates(data.today).map((d) => aggHours(idx, d, media, hours)));
  const l7 = meanAgg(last7Dates(data.today).map((d) => aggHours(idx, d, media, hours)), 3);
  const daily7 = data.mediaDaily.filter((r) => r.media === media && r.date >= addDays(data.today, -7) && r.date <= addDays(data.today, -1));
  const d7cost = sum(daily7, (r) => r.cost);
  const d7conv = sum(daily7, (r) => r.conversions);
  const d7rev = sum(daily7, (r) => r.revenue);
  const expectedConv = l7?.agg.conversions ?? 0;
  const sampleOk = expectedConv >= cfg.minConvForRatio;
  const th = cfg.thresholds;
  const evals: MetricEval[] = [];
  const hrLabel = hours.length > 1 ? `${hours[0]}~${hours[hours.length - 1]}시` : `${hours[0]}시`;
  if (sw) {
    evals.push({ metric: 'cost', label: '광고비', baseLabel: `동요일 · 동시간 평균 (${sw.days}주, ${hrLabel})`, observed: today.cost, baseline: sw.agg.cost, deltaPct: pct(today.cost, sw.agg.cost), threshold: th.cost, direction: 'both', level: 'ok', sampleOk: true });
    evals.push({ metric: 'clicks', label: '클릭', baseLabel: `동요일 · 동시간 평균 (${sw.days}주, ${hrLabel})`, observed: today.clicks, baseline: sw.agg.clicks, deltaPct: pct(today.clicks, sw.agg.clicks), threshold: th.clicks, direction: 'both', level: 'ok', sampleOk: true });
  }
  if (l7) {
    evals.push({ metric: 'conversions', label: '전환', baseLabel: `최근 7일 동시간 (${hrLabel})`, observed: today.conversions, baseline: l7.agg.conversions, deltaPct: pct(today.conversions, l7.agg.conversions), threshold: th.conversions, direction: 'down', level: 'ok', sampleOk });
  }
  if (d7conv > 0 && d7cost > 0) {
    const cpaNow = metrics.cpa(today.cost, today.conversions);
    const cpaBase = d7cost / d7conv;
    evals.push({ metric: 'cpa', label: 'CPA', baseLabel: '최근 7일 평균', observed: cpaNow, baseline: cpaBase, deltaPct: Number.isFinite(cpaNow) ? pct(cpaNow, cpaBase) : NaN, threshold: th.cpa, direction: 'up', level: 'ok', sampleOk, note: Number.isFinite(cpaNow) ? undefined : '구간 전환 0 · CPA 산출 불가' });
    const roasNow = metrics.roas(today.revenue, today.cost);
    const roasBase = (d7rev / d7cost) * 100;
    evals.push({ metric: 'roas', label: 'ROAS', baseLabel: '최근 7일 평균', observed: roasNow, baseline: roasBase, deltaPct: pct(roasNow, roasBase), threshold: th.roas, direction: 'down', level: 'ok', sampleOk });
  }
  for (const e of evals) {
    e.level = levelOf(e.deltaPct, e.threshold, e.direction);
    if (!e.sampleOk && !e.note) e.note = `표본 부족 · 참고 (구간 기대 전환 ${fmt.dec1(expectedConv)}건 < ${cfg.minConvForRatio}건)`;
    if (excludeConv && (e.metric === 'conversions' || e.metric === 'cpa' || e.metric === 'roas')) e.note = '전환 추적 단절 이슈로 통합 · 단독 판정 제외';
  }
  const triggering = evals.filter((e) => e.level !== 'ok' && e.sampleOk && !(excludeConv && (e.metric === 'conversions' || e.metric === 'cpa' || e.metric === 'roas')));
  const level: Level = triggering.some((e) => e.level === 'danger') ? 'danger' : triggering.length ? 'warn' : 'ok';
  const b = sw?.agg;
  const ratio = (n1: number, d1: number) => (d1 > 0 ? n1 / d1 : NaN);
  const derived = b
    ? {
      ctrD: pct(ratio(today.clicks, today.impressions), ratio(b.clicks, b.impressions)),
      cpcD: pct(ratio(today.cost, today.clicks), ratio(b.cost, b.clicks)),
      cpmD: pct(ratio(today.cost, today.impressions), ratio(b.cost, b.impressions)),
      cvrD: pct(ratio(today.conversions, today.clicks), ratio(b.conversions, b.clicks)),
      impsD: pct(today.impressions, b.impressions),
    }
    : { ctrD: NaN, cpcD: NaN, cpmD: NaN, cvrD: NaN, impsD: NaN };
  return { media, hours, today, sameWeekday: b ?? null, sameWeekdayDays: sw?.days ?? 0, last7Same: l7?.agg ?? null, expectedConv, evals, level, triggering, derived };
}

/** 오늘 남은 시간(현재 시 이후) 동요일 평균 합 */
function remainingBaseline(data: Dataset, media: MediaId, idx: HourIdx, field: keyof Agg): number {
  const hrs = ALL_HOURS.filter((h) => h > data.currentHour);
  if (!hrs.length) return 0;
  const m = meanAgg(sameWeekdayDates(data.today).map((d) => aggHours(idx, d, media, hrs)));
  return m ? m.agg[field] : 0;
}

/** 최근 7일 매체 효율 (ROAS %, 노출/원) */
function mediaEfficiency(data: Dataset, media: MediaId) {
  const rows = data.mediaDaily.filter((r) => r.media === media && r.date >= addDays(data.today, -7) && r.date <= addDays(data.today, -1));
  const cost = sum(rows, (r) => r.cost);
  return {
    roas: cost > 0 ? (sum(rows, (r) => r.revenue) / cost) * 100 : NaN,
    impsPerWon: cost > 0 ? sum(rows, (r) => r.impressions) / cost : NaN,
    dailyCost: rows.length ? cost / rows.length : NaN,
  };
}

/** 오늘 시간대 추이 vs 기준선 (동요일 4주 평균 · 최근 7일 평균) — 차트용 */
export function hourlySeries(data: Dataset, media: MediaId, field: keyof Agg, idx = buildHourIndex(data)) {
  const hours = Array.from({ length: data.currentHour + 1 }, (_, h) => h);
  const avg = (dates: string[], h: number) => {
    const v = dates.map((d) => idx.get(hk(d, media, h))?.[field]).filter((x): x is number => x !== undefined);
    return v.length ? mean(v) : NaN;
  };
  return hours.map((h) => ({
    hour: h,
    today: idx.get(hk(data.today, media, h))?.[field] ?? NaN,
    sameWeekday: avg(sameWeekdayDates(data.today), h),
    last7: avg(last7Dates(data.today), h),
  }));
}

/* ============================== 원인 후보 순위 ============================== */

interface Signals {
  search: boolean;
  baseLabel: string;
  costD: number; clicksD: number; impsD: number; cpcD: number; cpmD: number; ctrD: number; cvrD: number;
  clicksNormal: boolean;
  zeroConv?: boolean;
  soldOutKeywords: number;
  landingPartialSoldOut?: boolean;
}
interface CauseCtx { promosNear: Promotion[]; liveCount: number; priceMismatch: number }

const clampScore = (v: number) => Math.round(Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)));

/** CAUSE_CANDIDATES(p.47)를 데이터 근거로 순위화. 점수는 근거 강도 지표(0~100)이며 확률이 아니다. */
export function rankCauses(sig: Signals, ctx: CauseCtx): CauseScore[] {
  const out: CauseScore[] = [];
  const unit = sig.search ? 'CPC' : 'CPM';
  const comp = sig.search ? sig.cpcD : sig.cpmD;
  let compScore = Number.isFinite(comp) && comp > 0 ? comp / 0.8 : 0;
  const ctrUp = Number.isFinite(sig.ctrD) && sig.ctrD >= 30;
  if (ctrUp) compScore *= 0.7;
  out.push({
    label: CAUSE_CANDIDATES[0],
    score: clampScore(compScore),
    basis: Number.isFinite(comp)
      ? `${unit} ${fmt.delta(comp)} (${sig.baseLabel} 대비)${comp >= 20 ? ' · 단가 상승이 광고비 증가를 주도' : ' · 단가 변화 작음'}${ctrUp ? ' · CTR 동반 상승은 경쟁 입찰만으로 설명되지 않음' : ''}`
      : '단가 기준선 없음',
  });
  let landing = Number.isFinite(sig.cvrD) && sig.cvrD < 0 ? -sig.cvrD : 0;
  if (!sig.clicksNormal) landing *= 0.5;
  if (sig.soldOutKeywords > 0) landing += 25;
  else if (sig.landingPartialSoldOut) landing += 10;
  if (sig.zeroConv) landing = Math.min(landing, 25);
  out.push({
    label: CAUSE_CANDIDATES[1],
    score: clampScore(landing),
    basis: `CVR ${fmt.delta(sig.cvrD)}${sig.soldOutKeywords ? ` · 품절 옵션 랜딩 키워드 ${sig.soldOutKeywords}개` : sig.landingPartialSoldOut ? ' · 랜딩 상품 일부 옵션 품절' : ''}${sig.zeroConv ? ' · 랜딩 오류는 전환을 줄이지만 매출까지 0으로 고정되는 경우는 드묾' : ''}`,
  });
  const promo = (ctx.promosNear.length ? 45 : 0) + (ctx.priceMismatch ? 40 : 0) + (ctx.liveCount ? 8 : 0);
  out.push({
    label: CAUSE_CANDIDATES[2],
    score: clampScore(promo),
    basis: ctx.promosNear.length
      ? `${ctx.promosNear.map((p) => p.name).join(', ')} 시작 · 종료 ±1일`
      : `진행 중 프로모션 ${ctx.liveCount}건 · 기준일 ±1일 시작 · 종료 없음${ctx.priceMismatch ? ` · 가격 불일치 ${ctx.priceMismatch}건` : ''}`,
  });
  let media = 0;
  const notes: string[] = [];
  if (sig.zeroConv) { media += 60; notes.push('전환 · 매출 동시 0 기록'); }
  if (Number.isFinite(sig.costD) && sig.costD >= 30 && Number.isFinite(sig.impsD) && Math.abs(sig.impsD) <= 10) { media += 40; notes.push(`광고비 ${fmt.delta(sig.costD)} · 노출 ${fmt.delta(sig.impsD)} — 비용만 늘어난 집계 불일치 패턴`); }
  if (Number.isFinite(sig.impsD) && sig.impsD <= -90) { media += 60; notes.push(`노출 ${fmt.delta(sig.impsD)}`); }
  out.push({ label: CAUSE_CANDIDATES[3], score: clampScore(media), basis: notes.length ? notes.join(' · ') : '집계 공백 · 불일치 신호 없음' });
  if (ctrUp && Number.isFinite(sig.cvrD) && sig.cvrD <= -30) {
    out.push({ label: '무효 트래픽 · 저품질 클릭', score: clampScore((sig.ctrD - sig.cvrD) / 1.6), basis: `CTR ${fmt.delta(sig.ctrD)} · CVR ${fmt.delta(sig.cvrD)} — 클릭은 늘고 전환은 줄어드는 패턴 (p.45 무효 트래픽 기준 미만이면 관찰)` });
  }
  return out.sort((a, b) => b.score - a.score);
}
const causeStrings = (c: CauseScore[]) => c.filter((x) => x.score > 0).map((x) => `${x.label} — ${x.basis}`);

/** 매체 하나의 원인 후보 순위 (이상 징후 화면용 · 이슈 여부와 무관) */
export function mediaCauses(data: Dataset, media: MediaId, cfgIn?: AlertConfig, creatives: readonly CreativeReview[] = DEMO_CREATIVES): CauseScore[] {
  const ev = evaluateMedia(data, media, cfgIn);
  if (!ev || !ev.sameWeekday) return [];
  const d = ev.derived;
  const clicksD = pct(ev.today.clicks, ev.sameWeekday.clicks);
  let zeroConv = false;
  const r = data.mediaHourly.filter((x) => x.date === data.today && x.media === media && x.hour > data.currentHour - (cfgIn ?? defaultConfig()).trackingZeroHours);
  if (r.length && r.every((x) => x.conversions <= 1e-9 && x.revenue <= 0)) zeroConv = true;
  return rankCauses({
    search: media === 'naver_sa' || media === 'google', baseLabel: '동요일 · 동시간',
    costD: pct(ev.today.cost, ev.sameWeekday.cost), clicksD, impsD: d.impsD, cpcD: d.cpcD, cpmD: d.cpmD, ctrD: d.ctrD, cvrD: d.cvrD,
    clicksNormal: Number.isFinite(clicksD) && clicksD > -30, zeroConv,
    soldOutKeywords: media === 'naver_sa' ? soldOutKeywords(data).length : 0,
    landingPartialSoldOut: mediaLandsOnPartialSoldOut(data, media, creatives),
  }, promoContext(data));
}

/* ============================== 이슈 생성 공통 ============================== */

const SEV_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };

function soldOutKeywords(data: Dataset): { keyword: Keyword; option: string; product: string }[] {
  const out: { keyword: Keyword; option: string; product: string }[] = [];
  for (const p of data.products) {
    for (const o of p.options.filter((x) => !x.inStock)) {
      for (const k of data.keywords) {
        if (k.status === 'off' || k.landing !== p.landing) continue;
        if (k.text.includes(o.label)) out.push({ keyword: k, option: o.label, product: p.name });
      }
    }
  }
  return out;
}
/** 매체의 랜딩(SA = 키워드 랜딩, 그 외 = 소재 랜딩)이 일부 옵션 품절 상품 상세인지 */
function mediaLandsOnPartialSoldOut(data: Dataset, media: MediaId, creatives: readonly CreativeReview[]): boolean {
  const pages = new Set(data.products.filter((p) => p.options.some((o) => !o.inStock)).map((p) => p.landing));
  if (!pages.size) return false;
  if (media === 'naver_sa') return data.keywords.some((k) => k.status !== 'off' && pages.has(k.landing));
  return creatives.some((c) => c.media === media && c.status !== 'rejected' && pages.has(c.landing));
}
function promoContext(data: Dataset): CauseCtx {
  const lo = addDays(data.today, -1);
  const hi = addDays(data.today, 1);
  return {
    promosNear: data.promotions.filter((p) => (p.start >= lo && p.start <= hi) || (p.end >= lo && p.end <= hi)),
    liveCount: data.promotions.filter((p) => p.status === 'live').length,
    priceMismatch: checkPromoPrices(data).filter((x) => !x.ok).length,
  };
}

interface MakeFields {
  severity?: Severity;
  title: string;
  media?: MediaId | SalesChannelId;
  occurredAt?: string;
  metric?: string; observed?: number; baseline?: number; deltaPct?: number;
  evidence: Evidence[];
  causes?: CauseScore[];
  causeCandidates?: string[];
  impact?: Incident['impact'];
  impactNote?: string;
  autoActions?: string[];
  holdMedia?: MediaId;
  ownerRoleId?: string;
  related?: string[];
}
function makeIncident(data: Dataset, ruleId: string, target: string, f: MakeFields, forcedOff = false): AlertIncident {
  const rule = RULES[ruleId];
  const severity = f.severity ?? rule.severity;
  const regime = regimeOf(data.today, forcedOff);
  const ownerRoleId = f.ownerRoleId ?? (f.media ? MEDIA_OWNER_ROLE[f.media] : 'pm');
  const assigneeRoleId = regime.off && regime.duty ? regime.duty.roleId : ownerRoleId;
  const backupRoleId = backupOf(assigneeRoleId);
  const notify = NOTIFY_BY_TYPE[rule.typeId] ?? { channel: severity === 'P3' ? '메일' : '메신저', to: '담당 AE' };
  const channel = severity === 'P3' ? '메일' : notify.channel;
  const auto = [...(f.autoActions ?? [])];
  auto.push(`${channel} ${severity === 'P1' ? '즉시 ' : ''}알림 발송 · ${notify.to}`);
  if (regime.off) {
    auto.push(`주말 · 공휴일 체계: 당번 ${roleLabel(assigneeRoleId)} 30분 내 확인 요청`);
    const acc = f.media ? data.accounts.find((a) => a.media === f.media) : undefined;
    const has = (rid: string) => !!acc?.permissions.some((p) => p.user === ROLE_ACCOUNT_USER[rid] && p.realName);
    if (acc && !has(assigneeRoleId)) {
      const mediaOwner = f.media ? MEDIA_OWNER_ROLE[f.media] : undefined;
      const actor = [ownerRoleId, mediaOwner, backupRoleId, 'pm', ...TF_ROLES.map((r) => r.id)].find((r): r is string => !!r && has(r));
      auto.push(`당번 ${roleLabel(assigneeRoleId)} ${acc.name.replace(/ \(수면밀도\)/, '')} 권한 없음 → 1차 조치 ${actor ? roleLabel(actor) : '권한 보유자'} 대행`);
    }
    if (severity === 'P1') auto.push('P1 → PM 에스컬레이션 · 브랜드 담당자 연락');
    else auto.push(`다음 영업일 ${fmtDateShort(nextBusinessDay(data.today))} 09:30 이슈 브리핑 포함`);
  }
  const hist = SLA_HISTORY.filter((h) => h.ruleId === ruleId && f.media === h.media && dayDiff(data.today, h.date) <= 30 && dayDiff(data.today, h.date) > 0);
  const detectedAt = data.generatedAt;
  return {
    id: `${ruleId}:${target}:${data.today}`,
    ruleId,
    typeId: rule.typeId,
    ruleLabel: rule.label,
    basis: rule.basis,
    page: rule.page,
    severity,
    title: f.title,
    media: f.media,
    target,
    detectedAt,
    occurredAt: f.occurredAt ?? detectedAt,
    detectPath: `MILDO Alert 규칙 엔진 · ${rule.label} (${rule.page})${TYPE_LABEL[rule.typeId] && TYPE_LABEL[rule.typeId] !== rule.label ? ` · ${TYPE_LABEL[rule.typeId]} 유형` : ''}`,
    metric: f.metric, observed: f.observed, baseline: f.baseline, deltaPct: f.deltaPct,
    causeCandidates: f.causeCandidates ?? causeStrings(f.causes ?? []),
    causes: f.causes ?? [],
    evidence: f.evidence,
    impact: f.impact ?? {},
    impactNote: f.impactNote,
    assignee: roleLabel(assigneeRoleId),
    backup: roleLabel(backupRoleId),
    ownerRoleId, assigneeRoleId, backupRoleId,
    onDuty: regime.off,
    status: 'open',
    timeline: [{ at: detectedAt, by: 'MILDO Alert', action: `감지 · ${channel} 알림 (${notify.to})` }],
    isTest: false,
    autoActions: auto,
    holdMedia: f.holdMedia,
    related: f.related,
    recurrence: hist.length ? { count: hist.length, dates: hist.map((h) => h.date) } : undefined,
  };
}
function fmtDateShort(d: string): string {
  const w = ['일', '월', '화', '수', '목', '금', '토'][new Date(`${d}T12:00:00Z`).getUTCDay()];
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${w})`;
}
export { fmtDateShort };

/**
 * 데이터 기준 시각 (KST) — Dataset.generatedAt의 실제 시 · 분 (상단 바 '데이터 기준'과 같은 값).
 * 데모 데이터는 generatedAt이 'HH:30'이라 기존 표기와 같다. generatedAt을 읽지 못하면 today · currentHour:30.
 */
export function dataAsOf(data: Pick<Dataset, 'generatedAt' | 'today' | 'currentHour'>): { date: string; clock: string; label: string } {
  const ms = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  const date = Number.isFinite(ms) ? kstDate(ms) : data.today;
  const clock = Number.isFinite(ms) ? fmtClock(ms) : `${pad2(data.currentHour)}:30`;
  return { date, clock, label: `${fmtDateShort(date)} ${clock}` };
}

/* ============================== 서버 알림 발송 표기 (정직성 · SAAS_SPEC §0) ============================== */

/** 엔진이 감지 시 적는 '알림 발송' 자동 조치 문구 (화면 시연용 — 실제 발송이 아님) */
const SIM_NOTIFY_RE = /^(메신저|메일) (즉시 )?알림 발송 · /;
/** 서버 발송 요청 결과: enqueued = 발송 잡을 만든 채널 수, skipped = 등급 기준 밖이라 보내지 않은 채널 수. null = 아직 모름 (화면에서 만든 이슈 — 서버가 저장하며 채널로 보낸다) */
export type DeliveryResult = { enqueued: number; skipped: number } | null;

function deliveryReason(d: { enqueued: number; skipped: number }, isTest: boolean): string {
  if (d.skipped > 0) return `켜진 채널 ${d.skipped}곳이 이 등급을 받지 않음`;
  return isTest ? "테스트 데이터 이슈를 받는 켜진 알림 채널 없음 ('test' 이벤트)" : '이 이벤트를 받는 켜진 알림 채널 없음';
}

/**
 * 서버 모드 이슈 문서의 알림 문구를 실제 발송 요청 결과로 바꾼다 (순수 함수 · 새 객체).
 * 엔진의 감지 타임라인('감지 · 메신저 알림 (…)')과 자동 조치('메신저 즉시 알림 발송 · …')는 데모 시뮬레이션 문구라,
 * 서버에서 채널이 없거나 발송이 막혔을 때도 '보냈다'고 읽힌다. 실제 결과는 발송 이력(notifications)이 원본이다.
 */
export function withDeliveryNote<T extends Pick<AlertIncident, 'severity' | 'ruleId' | 'timeline' | 'autoActions'> & { typeId?: string; isTest?: boolean }>(inc: T, d: DeliveryResult): T {
  const typeId = inc.typeId ?? RULES[inc.ruleId]?.typeId ?? 'external';
  const route = NOTIFY_BY_TYPE[typeId] ?? { channel: inc.severity === 'P3' ? '메일' : '메신저', to: '담당 AE' };
  const isTest = !!inc.isTest;
  const none = d !== null && d.enqueued === 0;
  const short = d === null
    ? '알림은 서버가 켜진 채널로 발송 (결과는 알림 설정 › 발송 이력)'
    : d.enqueued > 0 ? `알림 채널 ${d.enqueued}곳에 발송 요청 (결과는 알림 설정 › 발송 이력)` : `알림 미발송 (${deliveryReason(d, isTest)})`;
  const auto = d === null
    ? `알림: 서버가 이 이슈를 받는 켜진 채널로 발송 · 규칙상 수신 ${route.to} · 실제 발송 결과는 알림 설정 › 발송 이력`
    : d.enqueued > 0
      ? `알림 채널 ${d.enqueued}곳에 발송 요청 · 규칙상 수신 ${route.to} · 실제 발송 결과는 알림 설정 › 발송 이력`
      : `알림 미발송 · ${deliveryReason(d, isTest)} · 규칙상 수신 ${route.to} — 알림 설정에서 채널 · 등급 · 이벤트 확인`;
  // 첫 줄 = 엔진 감지 기록 ('감지 · …' · 테스트 주입은 '테스트 이슈 감지 · …') — 머리말은 두고 알림 부분만 바꾼다
  const timeline = (inc.timeline ?? []).map((t, k) => {
    const m = k === 0 && t.by === 'MILDO Alert' ? /^((?:테스트 이슈 )?감지) · /.exec(t.action) : null;
    return m ? { ...t, action: `${m[1]} · ${short}` } : t;
  });
  const autoActions = (inc.autoActions ?? []).map((a) => {
    if (SIM_NOTIFY_RE.test(a)) return auto;
    // 당번 호출 · P1 에스컬레이션도 알림으로 전달된다 — 보낸 채널이 없으면 직접 연락이 필요하다고 적는다
    if (none && (/30분 내 확인 요청$/.test(a) || a === 'P1 → PM 에스컬레이션 · 브랜드 담당자 연락')) return `${a} (알림 미발송 — 직접 연락 필요)`;
    return a;
  });
  return { ...inc, timeline, autoActions };
}

/* ============================== 개별 검사 (화면 · 도구 공용) ============================== */

export interface BudgetForecast {
  campaign: Campaign;
  pace: number; // 오늘 종료 시 예상 소진 / 일 예산
  spentShare: number;
  expectedShare: number;
  exhaustHour: number | null; // 소수 시각 (19.6 = 19:36)
  lostRevShare: number; // 미노출 구간의 평소 매출 비중
  flag: boolean;
  revenueLossEst: number;
  impressionsLost: number;
}
export function budgetForecasts(data: Dataset, cfgIn?: AlertConfig, idx = buildHourIndex(data)): BudgetForecast[] {
  const cfg = cfgIn ?? defaultConfig();
  const profiles = new Map<MediaId, { cost: number[]; rev: number[] }>();
  return data.campaigns.map((c) => {
    if (!profiles.has(c.media)) profiles.set(c.media, { cost: hourProfile(data, c.media, 'cost', idx), rev: hourProfile(data, c.media, 'revenue', idx) });
    const prof = profiles.get(c.media)!;
    const h = Math.max(0, Math.min(23, c.hourOfData));
    const expectedShare = sum(prof.cost.slice(0, h + 1), (x) => x);
    const spentShare = c.dailyBudget > 0 ? c.spentToday / c.dailyBudget : NaN;
    const pace = expectedShare > 0 && Number.isFinite(spentShare) ? spentShare / expectedShare : NaN;
    let exhaustHour: number | null = null;
    let lostRevShare = 0;
    if (Number.isFinite(pace) && pace > 1 && c.status === 'on') {
      let cum = expectedShare;
      for (let hh = h + 1; hh < 24; hh++) {
        const next = cum + prof.cost[hh];
        if (next * pace >= 1) {
          const need = 1 / pace - cum;
          const frac = prof.cost[hh] > 0 ? Math.max(0, Math.min(1, need / prof.cost[hh])) : 0;
          exhaustHour = hh + frac;
          lostRevShare = (1 - frac) * prof.rev[hh] + sum(prof.rev.slice(hh + 1), (x) => x);
          break;
        }
        cum = next;
      }
    }
    const eff = mediaEfficiency(data, c.media);
    const dayNormal = c.dailyBudget * (Number.isFinite(pace) ? pace : 1);
    const revenueLossEst = exhaustHour !== null && Number.isFinite(eff.roas) ? (dayNormal * eff.roas) / 100 * lostRevShare : 0;
    const impressionsLost = exhaustHour !== null && Number.isFinite(eff.impsPerWon) ? dayNormal * (1 - 1 / pace) * eff.impsPerWon : 0;
    return { campaign: c, pace, spentShare, expectedShare, exhaustHour, lostRevShare, flag: exhaustHour !== null && lostRevShare >= cfg.budgetLostShare, revenueLossEst, impressionsLost };
  });
}

export interface PriceCheck { promotion: Promotion; ok: boolean; expected: number | null; option: string | null; diffPct: number | null; note: string }
/** p.45 가격 · 프로모션 불일치: 소재 표기가 vs 판매가 × (1 − 할인율), 허용 오차 ±1% */
export function checkPromoPrices(data: Dataset): PriceCheck[] {
  const out: PriceCheck[] = [];
  for (const p of data.promotions) {
    if (p.status !== 'live') continue;
    if (p.end < data.today) { out.push({ promotion: p, ok: false, expected: null, option: null, diffPct: null, note: `종료일 ${p.end} 경과 · 소재 노출 중` }); continue; }
    if (p.adCopyPrice === undefined) { out.push({ promotion: p, ok: true, expected: null, option: null, diffPct: null, note: '소재 가격 표기 없음 · 대조 대상 아님' }); continue; }
    let best: { exp: number; label: string; diff: number; inStock: boolean } | null = null;
    for (const prod of data.products) {
      for (const o of prod.options) {
        const exp = o.price * (1 - p.discountRate / 100);
        const diff = exp > 0 ? ((p.adCopyPrice - exp) / exp) * 100 : NaN;
        if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { exp, label: `${prod.name} ${o.label}`, diff, inStock: o.inStock };
      }
    }
    if (!best) { out.push({ promotion: p, ok: false, expected: null, option: null, diffPct: null, note: '대조할 판매가 없음' }); continue; }
    const ok = Math.abs(best.diff) <= 1 && best.inStock;
    out.push({
      promotion: p, ok, expected: Math.round(best.exp), option: best.label, diffPct: best.diff,
      note: Math.abs(best.diff) > 1 ? `표기가 ${fmt.won(p.adCopyPrice)} ≠ 판매가 기준 ${fmt.won(best.exp)} (${fmt.delta(best.diff)})` : best.inStock ? `일치 · ${best.label} ${fmt.won(best.exp)}` : `가격 일치 · 해당 옵션(${best.label}) 품절`,
    });
  }
  return out;
}

export interface AccountFinding { level: 'fail' | 'warn' | 'ok' | 'info'; label: string; detail: string }
export interface AccountCheck {
  account: AdAccount;
  prepaid: boolean;
  runwayDays: number;
  exhaustAtMs: number | null;
  findings: AccountFinding[];
  worst: AccountFinding['level'];
  nonRealName: number;
  stale: number;
}
const LEVEL_RANK = { fail: 0, warn: 1, info: 2, ok: 3 } as const;
function accountMedia(a: AdAccount): MediaId {
  return (MEDIA_IDS as string[]).includes(a.media) ? (a.media as MediaId) : 'vertical';
}
/** 잔액 소진 예상 시각 — 매체 시간대 소진 곡선으로 기준 시각부터 순차 차감 */
export function exhaustTime(data: Dataset, a: AdAccount, idx = buildHourIndex(data)): number | null {
  if (a.balance < 0 || a.avgDailySpend <= 0) return null;
  const prof = hourProfile(data, accountMedia(a), 'cost', idx);
  const startMs = Date.parse(data.generatedAt);
  const startHour = new Date(startMs + KST_MS).getUTCHours() + new Date(startMs + KST_MS).getUTCMinutes() / 60;
  let remain = a.balance;
  let t = Math.floor(startHour);
  let frac = startHour - t; // 현재 시 경과분
  let dayOffset = 0;
  for (let i = 0; i < 24 * 60; i++) {
    const hourSpend = a.avgDailySpend * prof[t] * (1 - frac);
    if (hourSpend >= remain) {
      const f = hourSpend > 0 ? remain / hourSpend : 0;
      const hourFloat = t + frac + f * (1 - frac);
      return dayStartMs(addDays(data.today, dayOffset)) + hourFloat * HOUR_MS;
    }
    remain -= hourSpend;
    frac = 0;
    t++;
    if (t >= 24) { t = 0; dayOffset++; }
  }
  return null;
}
export function checkAccounts(data: Dataset, cfgIn?: AlertConfig, idx = buildHourIndex(data)): AccountCheck[] {
  const cfg = cfgIn ?? defaultConfig();
  return data.accounts.map((a) => {
    const f: AccountFinding[] = [];
    const prepaid = a.balance >= 0;
    const runwayDays = prepaid && a.avgDailySpend > 0 ? a.balance / a.avgDailySpend : prepaid ? Infinity : NaN;
    const exhaustAtMs = exhaustTime(data, a, idx);
    f.push(a.owner === '수면밀도' ? { level: 'ok', label: '소유', detail: '수면밀도 소유 (p.50)' } : { level: 'warn', label: '소유', detail: `소유 주체 ${a.owner} — 수면밀도 소유 원칙과 다름 (p.50)` });
    if (prepaid) {
      if (runwayDays < 1) f.push({ level: 'fail', label: '잔액', detail: `잔액 ${fmt.krw(a.balance)}원 < 일 평균 소진 ${fmt.krw(a.avgDailySpend)}원 (1일치 미만, ${fmt.dec1(runwayDays)}일)` });
      else if (runwayDays < cfg.runwayWarnDays) f.push({ level: 'warn', label: '잔액', detail: `${fmt.dec1(runwayDays)}일치 — 주말 · 연휴 대비 ${cfg.runwayWarnDays}일치 미만` });
      else f.push({ level: 'ok', label: '잔액', detail: `${fmt.dec1(runwayDays)}일치` });
    } else {
      f.push({ level: 'info', label: '잔액', detail: `후불 · ${a.paymentMethod} — 카드 한도는 수면밀도 확인 필요` });
    }
    if (a.autoCharge === 'failed') f.push({ level: 'fail', label: '자동충전', detail: '자동충전 실패 — 결제 수단 확인 · 수동 충전 요청 (승인: 수면밀도)' });
    else if (a.autoCharge === 'off' && prepaid && runwayDays < 7) f.push({ level: 'warn', label: '자동충전', detail: `수동 충전 계정 · ${fmt.dec1(runwayDays)}일치 — 충전 요청 일정 확인` });
    else f.push({ level: 'ok', label: '자동충전', detail: a.autoCharge === 'ok' ? '정상' : a.autoCharge === 'postpaid' ? '후불' : '수동 충전 · 잔액 여유' });
    const nonReal = a.permissions.filter((p) => !p.realName);
    const stale = a.permissions.filter((p) => dayDiff(data.today, p.lastLogin) > cfg.staleLoginDays);
    for (const p of nonReal) f.push({ level: 'fail', label: '권한', detail: `비실명 계정 ${p.user} (${p.role}) · 마지막 로그인 ${p.lastLogin} — 실명 계정 · 최소 권한 원칙 위반 (p.50)` });
    for (const p of stale.filter((x) => x.realName)) f.push({ level: 'warn', label: '권한', detail: `${p.user} ${dayDiff(data.today, p.lastLogin)}일 미접속 — 미사용 권한 회수 대상` });
    if (!nonReal.length && !stale.length) f.push({ level: 'ok', label: '권한', detail: `실명 ${a.permissions.length}명 · 미사용 없음` });
    if (a.status === 'restricted') f.push({ level: 'fail', label: '상태', detail: '계정 제재 — 광고 집행 중단 위험' });
    else if (a.status === 'review') f.push({ level: 'warn', label: '상태', detail: '계정 검수 · 확인 필요 — 매체 요청 서류 · 소재 확인' });
    else f.push({ level: 'ok', label: '상태', detail: '정상' });
    const worst = f.reduce<AccountFinding['level']>((w, x) => (LEVEL_RANK[x.level] < LEVEL_RANK[w] ? x.level : w), 'ok');
    return { account: a, prepaid, runwayDays, exhaustAtMs, findings: f, worst, nonRealName: nonReal.length, stale: stale.length };
  });
}

export interface KeywordShift {
  keyword: Keyword;
  baseDays: number;
  cpcRecent: number; cpcBase: number; cpcD: number;
  convRecent: number; convBase: number;
  /** 일 전환 변화 (표본과 무관하게 계산 · 판정은 convSampleOk일 때만) */
  convD: number;
  /** 직전 기간 전환 ≥ keywordMinConv — 미만이면 전환 변화는 참고 */
  convSampleOk: boolean;
  clicksRecent: number; clicksBase: number; clicksD: number;
  roasRecent: number; roasBase: number;
  costD: number; impsD: number; cvrD: number;
  excessCost: number; revenueGap: number;
  hitCpc: boolean; hitConv: boolean; hit: boolean;
}
/** 키워드 최근 n일 vs 직전 기간 (일평균) — p.14 성과 급변 판정 */
export function keywordShifts(data: Dataset, cfgIn?: AlertConfig): KeywordShift[] {
  const cfg = cfgIn ?? defaultConfig();
  const rd = cfg.keywordRecentDays;
  const out: KeywordShift[] = [];
  for (const k of data.keywords) {
    if (k.status === 'off' || k.daily.length < rd + 4) continue;
    const recent = k.daily.slice(-rd);
    const base = k.daily.slice(0, -rd);
    const s = (rows: typeof recent, f: (x: (typeof recent)[number]) => number) => sum(rows, f);
    const rc = s(recent, (x) => x.cost), rk = s(recent, (x) => x.clicks), rv = s(recent, (x) => x.conversions), rr = s(recent, (x) => x.revenue), ri = s(recent, (x) => x.impressions);
    const bc = s(base, (x) => x.cost), bk = s(base, (x) => x.clicks), bv = s(base, (x) => x.conversions), br = s(base, (x) => x.revenue), bi = s(base, (x) => x.impressions);
    const bn = base.length;
    const cpcRecent = rk > 0 ? rc / rk : NaN;
    const cpcBase = bk > 0 ? bc / bk : NaN;
    const cpcD = pct(cpcRecent, cpcBase);
    const convSampleOk = bv >= cfg.keywordMinConv;
    const convD = bn > 0 ? pct(rv / rd, bv / bn) : NaN;
    const th = cfg.keywordSpikePct;
    const hitCpc = Number.isFinite(cpcD) && Math.abs(cpcD) >= th;
    const hitConv = convSampleOk && Number.isFinite(convD) && Math.abs(convD) >= th;
    out.push({
      keyword: k, baseDays: bn,
      cpcRecent, cpcBase, cpcD,
      convRecent: rv / rd, convBase: bv / bn, convD, convSampleOk,
      clicksRecent: rk / rd, clicksBase: bk / bn, clicksD: pct(rk / rd, bk / bn),
      roasRecent: rc > 0 ? (rr / rc) * 100 : NaN, roasBase: bc > 0 ? (br / bc) * 100 : NaN,
      costD: pct(rc / rd, bc / bn), impsD: pct(ri / rd, bi / bn), cvrD: pct(rk > 0 ? rv / rk : NaN, bk > 0 ? bv / bk : NaN),
      excessCost: Math.max(0, rc - (bc / bn) * rd), revenueGap: Math.max(0, (br / bn) * rd - rr),
      hitCpc, hitConv, hit: hitCpc || hitConv,
    });
  }
  return out;
}

/** 규칙별 1차 조치 권고 (알림 카드 · 보고서 · 에이전트 공용) */
export function nextAction(ruleId: string): string {
  switch (ruleId) {
    case 'tracking_break': return '매체 픽셀 · 전환 API 수신 상태와 최근 사이트 배포 이력 확인, 자동 입찰 보류 유지, 다음 수집 주기(1시간)에 소급 반영 여부 재확인';
    case 'account_payment': return '수면밀도 결제 담당자에게 충전 요청 · 자동충전 카드 한도 · 유효기간 확인, 소진 예상 시각 전 충전 완료 확인';
    case 'account_permission': return '공유 계정 권한 회수 요청 (PM → 수면밀도 통보), 실명 계정으로 대체';
    case 'account_status': return '매체 계정 알림 · 요청 서류 확인 후 제출, 집행 중단 시 대체 채널 예산 이동안 준비';
    case 'data_spike': return '원인 후보 1순위부터 확인 → 1시간 내 원인 보고, 확인 전 자동 조정 보류 유지, 필요 시 일 예산 상한 임시 하향 승인 요청';
    case 'anomaly_warn': return '다음 수집 주기에 같은 방향 지속 여부 확인, 지속 시 원인 확인 · 주간 리포트 기록';
    case 'keyword_spike': return '경쟁 지면 · 순위 확인, 입찰 상한 유지 · 자동 조정 보류, 3일 지속 시 비교 · 검토 캠페인 예산 재배분 검토';
    case 'budget_forecast': return '시간대 입찰 하향 또는 예산 재배분 승인 요청 (AD Pilot), 증액은 한계 ROAS 확인 후';
    case 'budget_exhausted': return '증액 · 재배분 승인 요청 (위임 범위 기준), 미승인 시 익일 일 예산 재설정';
    case 'campaign_off': return '변경 이력 확인 → 재개 또는 중지 사유 보고, 소재 검수 상태 확인';
    case 'media_no_impression': case 'keyword_no_impression': return '계정 · 결제 · 캠페인 · 키워드 상태 확인 → 재개, 원인 보고';
    case 'soldout_landing': return '옵션 지정 키워드 일시 중지 승인 요청 또는 대체 랜딩(재고 옵션) 지정';
    case 'price_mismatch': return '소재 가격 문구 교체 요청 · 판매가 대조 재확인';
    case 'brand_intrusion': return '브랜드 지면 스냅샷 확인 → 방어 입찰 승인 요청 (브랜드 기준 목표 ROAS 800%)';
    case 'invalid_traffic': return '지역 · IP · 지면 제외 적용 승인, 매체 무효 클릭 신고';
    case 'creative_rejected': case 'creative_pending': return '반려 · 보류 사유 대응 수정 문안 작성(MILDO Lab 검수) → 재검수 요청';
    case 'landing_error': return '해당 소재 일시 중지 · URL 교체';
    case 'search_volume': return '24시간 내 영향 분석 · 대응안, 주간 리포트 포함';
    case 'media_delay': return '매체 상태 페이지 · 수집 커넥터 로그 확인, 수신 재개 후 이상 징후 재판정 · 24시간 내 영향 분석';
    case 'bulk_change': return '신규 반영 차단 유지 · 변경 목록 검토 → 오류 건 즉시 롤백 (MILDO Flow)';
    default: return '원인 확인 · 조치 내용 기록';
  }
}

/* ============================== 탐지 ============================== */

/**
 * 데이터셋 → 이슈 목록. Shell은 detectIncidents(data)로 호출한다 (두 번째 인자는 선택).
 * 결과는 등급(P1→P3) · 추정 매출 영향 순.
 */
export function detectIncidents(data: Dataset, opts: DetectOptions = {}): AlertIncident[] {
  const cfg = resolveConfig(opts.config);
  const creatives = opts.creatives ?? DEMO_CREATIVES;
  const out: AlertIncident[] = [];
  if (!data || !data.today) return out;
  const idx = buildHourIndex(data);
  const ctxPromo = promoContext(data);
  const soldOut = soldOutKeywords(data);
  const nowMs = Date.parse(data.generatedAt);
  const ch = data.currentHour;
  const hourAt = (h: number) => kstIso(data.today, h);
  const mk = (ruleId: string, target: string, f: MakeFields) => makeIncident(data, ruleId, target, f, !!opts.offHours);

  /* ---- 전환 추적 단절 (p.45, P1) ---- */
  const trackingBroken = new Set<MediaId>();
  for (const m of MEDIA_IDS) {
    let run = 0;
    for (let h = ch; h >= 0; h--) {
      const r = idx.get(hk(data.today, m, h));
      if (!r || r.conversions > 1e-9 || r.revenue > 0) break;
      run++;
    }
    if (run < cfg.trackingZeroHours) continue;
    const hours = Array.from({ length: run }, (_, i) => ch - run + 1 + i);
    const today = aggHours(idx, data.today, m, hours);
    const base = meanAgg(last7Dates(data.today).map((d) => aggHours(idx, d, m, hours)), 3);
    if (!today || !base) continue;
    const clickRatio = base.agg.clicks > 0 ? today.clicks / base.agg.clicks : NaN;
    let zeroCnt = 0, cnt = 0;
    for (const d of last7Dates(data.today)) for (const h of hours) {
      const r = idx.get(hk(d, m, h));
      if (!r) continue;
      cnt++;
      if (r.conversions <= 1e-9) zeroCnt++;
    }
    const zeroRate = cnt ? zeroCnt / cnt : NaN;
    if (!(clickRatio >= cfg.trackingClickRatio) || !(zeroRate <= cfg.trackingZeroRateMax)) continue;
    trackingBroken.add(m);
    const others = MEDIA_IDS.filter((o) => o !== m).filter((o) => (aggHours(idx, data.today, o, hours)?.conversions ?? 0) > 0);
    const rest = remainingBaseline(data, m, idx, 'cost');
    const p0 = Math.exp(-base.agg.conversions);
    out.push(mk('tracking_break', MEDIA[m].name, {
      title: `${MEDIA[m].name} 전환 추적 단절 의심 · ${hours[0]}시 이후 전환 0`,
      media: m,
      occurredAt: hourAt(hours[0]),
      metric: '전환', observed: 0, baseline: base.agg.conversions, deltaPct: -100,
      evidence: [
        { label: '전환 0 지속', observed: run, unit: 'hours', threshold: `≥ ${cfg.trackingZeroHours}시간`, level: 'danger', note: `${hours[0]}~${ch}시 전환 · 매출 모두 0` },
        { label: '클릭', observed: today.clicks, baseline: base.agg.clicks, deltaPct: pct(today.clicks, base.agg.clicks), unit: 'int', baseLabel: '최근 7일 동시간 평균', threshold: `기준 대비 ≥ ${Math.round(cfg.trackingClickRatio * 100)}% (트래픽 정상)`, level: 'info' },
        { label: '전환', observed: 0, baseline: base.agg.conversions, deltaPct: -100, unit: 'dec', baseLabel: '최근 7일 동시간 평균', level: 'danger' },
        { label: '최근 7일 동시간 0 기록 비율', observed: zeroRate * 100, unit: 'pct', threshold: `≤ ${Math.round(cfg.trackingZeroRateMax * 100)}%`, level: 'info', note: '평소 이 시간대에 0이 거의 기록되지 않음 → 0 고정은 집계 경로 이상 신호' },
        { label: '기대 전환 기준 우연 확률(참고)', observed: p0 * 100, unit: 'pct', level: 'info', note: `기대 ${fmt.dec1(base.agg.conversions)}건 · 전환량만으로는 판정 불가 · 판정 근거는 0 기록 패턴` },
      ],
      causes: [
        { label: '전환 스크립트 · 픽셀 누락', score: others.length ? 85 : 65, basis: `클릭 정상(기준 대비 ${fmt.ratio(clickRatio, 0)}) · 전환 · 매출 동시 0${others.length ? ` · 같은 시간 다른 매체 전환 정상(${others.length}개 매체) → 매체 연동 · 태그 문제 가능성` : ''}` },
        { label: CAUSE_CANDIDATES[3], score: 55, basis: '매체 전환 집계가 1~3시간 늦게 소급 반영되는 경우 있음 → 다음 수집 주기 재확인' },
        { label: CAUSE_CANDIDATES[1], score: soldOut.length ? 30 : 20, basis: '랜딩 오류는 전환을 줄이지만 0 고정은 드묾 · 랜딩 응답 점검 병행' },
        { label: CAUSE_CANDIDATES[2], score: clampScore(ctxPromo.promosNear.length ? 30 : 5), basis: `기준일 ±1일 프로모션 시작 · 종료 ${ctxPromo.promosNear.length}건` },
      ],
      impact: { spendAtRisk: today.cost + rest, revenueLossEst: base.agg.revenue },
      impactNote: `광고비 영향 = 단절 구간 집행 ${fmt.krw(today.cost)}원 + 오늘 남은 시간 동요일 평균 ${fmt.krw(rest)}원 (자동 입찰이 잘못된 전환 신호로 집행될 수 있는 금액). 매출 영향은 실제 손실이 아니라 미집계 매출일 수 있음 (최근 7일 동시간 평균 매출 ${fmt.krw(base.agg.revenue)}원).`,
      autoActions: [`AD Pilot · ${MEDIA[m].name} 자동 입찰 조정 즉시 보류`, '전환 기반 자동 판정(Lab 테스트 · AD Pilot) 해당 매체 제외'],
      holdMedia: m,
    }));
  }

  /* ---- 매체 · 외부 환경: 매체 장애 · 집계 지연 (p.44, P3) ---- */
  const reporting = MEDIA_IDS.filter((m) => idx.has(hk(data.today, m, ch)));
  for (const m of MEDIA_IDS) {
    if (idx.has(hk(data.today, m, ch)) || !reporting.length) continue;
    const seen = last7Dates(data.today).filter((d) => idx.has(hk(d, m, ch))).length;
    if (seen < 3) continue;
    let lastHour = -1;
    for (let h = ch - 1; h >= 0; h--) if (idx.has(hk(data.today, m, h))) { lastHour = h; break; }
    const gapHours = ch - lastHour;
    const rest = remainingBaseline(data, m, idx, 'cost');
    out.push(mk('media_delay', MEDIA[m].name, {
      title: `${MEDIA[m].name} 시간별 데이터 미수신 · ${lastHour >= 0 ? `${lastHour + 1}시` : '0시'} 이후 ${gapHours}시간`, media: m,
      occurredAt: hourAt(Math.max(0, lastHour + 1)),
      metric: '데이터 수신', observed: 0,
      evidence: [
        { label: '미수신 구간', observed: gapHours, unit: 'hours', threshold: '현재 시각 미수신', level: 'warn', note: `마지막 수신 ${lastHour >= 0 ? `${lastHour}시` : '오늘 없음'} · 다른 매체 ${reporting.length}개 ${ch}시 수신` },
        { label: '최근 7일 같은 시간 수신', observed: seen, unit: 'int', threshold: '≥ 3일 (평소 수신되는 시간대)', level: 'info' },
      ],
      causes: [
        { label: CAUSE_CANDIDATES[3], score: 70, basis: `${MEDIA[m].name}만 ${ch}시 데이터가 없음 — 매체 API 장애 · 집계 지연 가능` },
        { label: '연동 토큰 · 권한 만료', score: 40, basis: '수집 커넥터 인증 상태 확인' },
      ],
      impact: {},
      impactNote: `미수신 구간은 이상 징후 판정 불가 · 오늘 남은 시간 평소 광고비 ${fmt.krw(rest)}원이 감시 공백 (손실 추정 아님)`,
      autoActions: ['다음 수집 주기 재수집 예약', `${MEDIA[m].name} 이상 징후 판정 일시 제외 (데이터 수신 후 재판정)`],
    }));
  }

  /* ---- 매체 미노출 · 데이터 급변 · 무효 트래픽 (p.44 · p.45 · p.47) ---- */
  const spikeMedia = new Set<MediaId>();
  for (const m of MEDIA_IDS) {
    const ev = evaluateMedia(data, m, cfg, idx, trackingBroken.has(m));
    if (!ev || !ev.sameWeekday) continue;
    const b = ev.sameWeekday;
    const hrs = ev.hours;
    const hrLabel = hrs.length > 1 ? `${hrs[0]}~${hrs[hrs.length - 1]}시` : `${hrs[0]}시`;
    if (ev.today.impressions === 0 && b.impressions > 0) {
      const restRev = remainingBaseline(data, m, idx, 'revenue');
      out.push(mk('media_no_impression', MEDIA[m].name, {
        title: `${MEDIA[m].name} 미노출 · ${hrLabel} 노출 0`, media: m, occurredAt: hourAt(hrs[0]),
        metric: '노출', observed: 0, baseline: b.impressions, deltaPct: -100,
        evidence: [{ label: '노출', observed: 0, baseline: b.impressions, deltaPct: -100, unit: 'int', baseLabel: '동요일 · 동시간 평균', threshold: '노출 0', level: 'danger' }],
        causes: [{ label: CAUSE_CANDIDATES[3], score: 70, basis: '매체 전체 노출 0 — 계정 · 결제 · 집계 상태 동시 확인' }],
        impact: { impressionsLost: b.impressions, revenueLossEst: b.revenue + restRev },
        impactNote: '동요일 평균 기준 구간 손실 + 오늘 남은 시간 평균 매출',
        autoActions: ['계정 상태 · 결제 잔액 · 캠페인 상태 자동 재조회'],
      }));
      continue;
    }
    const d = ev.derived;
    const clicksD = pct(ev.today.clicks, b.clicks);
    const costD = pct(ev.today.cost, b.cost);
    // 무효 트래픽 (p.45): 클릭 급증 + CVR 급락 — 전환 추적 단절 매체는 CVR을 믿을 수 없어 제외
    if (!trackingBroken.has(m) && Number.isFinite(clicksD) && clicksD >= cfg.invalidClickPct && Number.isFinite(d.cvrD) && d.cvrD <= -cfg.invalidCvrDropPct) {
      out.push(mk('invalid_traffic', MEDIA[m].name, {
        title: `${MEDIA[m].name} 무효 트래픽 의심 · 클릭 ${fmt.delta(clicksD, 0)} · CVR ${fmt.delta(d.cvrD, 0)}`, media: m, occurredAt: hourAt(hrs[0]),
        metric: '클릭', observed: ev.today.clicks, baseline: b.clicks, deltaPct: clicksD,
        evidence: [
          { label: '클릭', observed: ev.today.clicks, baseline: b.clicks, deltaPct: clicksD, unit: 'int', baseLabel: '동요일 · 동시간 평균', threshold: `≥ +${cfg.invalidClickPct}%`, level: 'danger' },
          { label: 'CVR', observed: metrics.cvr(ev.today.conversions, ev.today.clicks), baseline: metrics.cvr(b.conversions, b.clicks), deltaPct: d.cvrD, unit: 'pct', threshold: `≤ −${cfg.invalidCvrDropPct}%`, level: 'danger' },
        ],
        causes: [{ label: '무효 트래픽 · 저품질 클릭', score: 80, basis: `CTR ${fmt.delta(d.ctrD)} · CVR ${fmt.delta(d.cvrD)}` }],
        impact: { spendAtRisk: Math.max(0, ev.today.cost - b.cost) },
        autoActions: ['지역 · IP · 지면 제외 후보 추출', '매체 무효 클릭 신고 양식 준비'],
      }));
    }
    if (ev.level === 'ok') continue;
    const top = [...ev.triggering].sort((x, y) => Math.abs(y.deltaPct) / y.threshold.danger - Math.abs(x.deltaPct) / x.threshold.danger)[0];
    const isDanger = ev.level === 'danger';
    if (isDanger) spikeMedia.add(m);
    const sig: Signals = {
      search: m === 'naver_sa' || m === 'google',
      baseLabel: '동요일 · 동시간',
      costD, clicksD, impsD: d.impsD, cpcD: d.cpcD, cpmD: d.cpmD, ctrD: d.ctrD, cvrD: d.cvrD,
      clicksNormal: Number.isFinite(clicksD) && clicksD > -30,
      soldOutKeywords: m === 'naver_sa' ? soldOut.length : 0,
      landingPartialSoldOut: mediaLandsOnPartialSoldOut(data, m, creatives),
    };
    const restCost = remainingBaseline(data, m, idx, 'cost');
    const restRev = remainingBaseline(data, m, idx, 'revenue');
    const excess = Math.max(0, ev.today.cost - b.cost);
    const revGap = Math.max(0, b.revenue - ev.today.revenue);
    const revRatio = b.revenue > 0 ? revGap / b.revenue : 0;
    const costRatio = Number.isFinite(costD) ? Math.max(0, costD / 100) : 0;
    const metricsLabel = ev.triggering.map((t) => `${t.label} ${fmt.delta(t.deltaPct, 0)}`).join(' · ');
    out.push(mk(isDanger ? 'data_spike' : 'anomaly_warn', MEDIA[m].name, {
      severity: isDanger ? 'P2' : 'P3',
      title: `${MEDIA[m].name} ${isDanger ? '데이터 급변' : '이상 징후 주의'} · ${metricsLabel} (${hrLabel})`,
      media: m,
      occurredAt: hourAt(hrs[0]),
      metric: top.label, observed: top.observed, baseline: top.baseline, deltaPct: top.deltaPct,
      evidence: ev.evals.map((e) => ({
        label: e.label, observed: e.observed, baseline: e.baseline, deltaPct: e.deltaPct,
        unit: e.metric === 'cost' ? 'krw' : e.metric === 'clicks' ? 'int' : e.metric === 'conversions' ? 'dec' : e.metric === 'cpa' ? 'won' : 'roas',
        baseLabel: e.baseLabel, threshold: thresholdText(e.threshold, e.direction),
        level: e.sampleOk && !e.note?.startsWith('전환 추적') ? e.level : 'info', note: e.note,
      })),
      causes: rankCauses(sig, ctxPromo),
      impact: {
        spendAtRisk: excess + restCost * costRatio,
        revenueLossEst: revGap + restRev * revRatio,
        impressionsLost: Number.isFinite(d.impsD) && d.impsD < 0 ? b.impressions - ev.today.impressions : undefined,
      },
      impactNote: `광고비 영향 = 구간 초과 집행 ${fmt.krw(excess)}원 + 같은 증가율이 오늘 남은 시간에 이어질 때 ${fmt.krw(restCost * costRatio)}원. 매출 영향 = 구간 매출 감소 ${fmt.krw(revGap)}원 + 같은 감소율 지속 시 ${fmt.krw(restRev * revRatio)}원. 추세 지속 가정이며 예측이 아님.`,
      autoActions: isDanger ? [`AD Pilot · ${MEDIA[m].name} 자동 조정 보류 (원인 확인 전)`, '1시간 내 원인 보고 요청'] : ['주간 리포트 관찰 항목 등록'],
      holdMedia: isDanger ? m : undefined,
    }));
  }

  /* ---- 캠페인: 중지 · 예산 소진 · 소진 예상 (p.44 광고 OFF · 미노출) ---- */
  const forecasts = budgetForecasts(data, cfg, idx);
  for (const fc of forecasts) {
    const c = fc.campaign;
    const eff = mediaEfficiency(data, c.media);
    const prof = hourProfile(data, c.media, 'revenue', idx);
    const restShare = sum(prof.slice(ch + 1), (x) => x);
    if (c.status === 'off' || c.status === 'limited') {
      const dayRev = Number.isFinite(eff.roas) ? (c.dailyBudget * eff.roas) / 100 : 0;
      const off = c.status === 'off';
      out.push(mk('campaign_off', c.name, {
        severity: off ? 'P1' : 'P2',
        title: `${c.name} 캠페인 ${off ? '중지 · 미노출' : '제한 상태'}`,
        media: c.media, occurredAt: kstIso(data.today, c.hourOfData),
        metric: '캠페인 상태', evidence: [
          { label: '캠페인 상태', observed: 0, unit: 'text', threshold: off ? 'OFF → P1' : 'limited → P2', level: 'danger', note: off ? '집행 중지' : '노출 제한' },
          { label: '일 예산', observed: c.dailyBudget, unit: 'krw', level: 'info' },
          { label: '오늘 남은 시간 평소 매출 비중', observed: restShare * 100, unit: 'pct', level: 'info', note: `최근 ${PACE_CURVE_DAYS}일 시간대 매출 곡선 기준` },
        ],
        causes: [
          { label: '수동 변경 · 일정 종료', score: 60, basis: '변경 이력(MILDO Flow) · 캠페인 일정 확인' },
          { label: '소재 반려 · 검수 보류', score: 45, basis: '소재 검수 상태 확인' },
          { label: CAUSE_CANDIDATES[3], score: 25, basis: '매체 상태 조회 지연 가능' },
        ],
        impact: { revenueLossEst: dayRev * restShare * (off ? 1 : 0.5), impressionsLost: Number.isFinite(eff.impsPerWon) ? c.dailyBudget * restShare * eff.impsPerWon : undefined },
        impactNote: `오늘 남은 시간(평소 매출 비중 ${fmt.ratio(restShare, 0)}) × 일 예산 × 최근 7일 ${MEDIA[c.media].name} ROAS ${fmt.roas(eff.roas)} 기준 추정${off ? '' : ' · 제한 상태는 50% 손실 가정'}.`,
        autoActions: ['캠페인 상태 · 소재 검수 상태 자동 재조회'],
      }));
      continue;
    }
    if (c.spentToday >= c.dailyBudget && c.dailyBudget > 0) {
      out.push(mk('budget_exhausted', c.name, {
        title: `${c.name} 일 예산 소진 · 집행 중지`, media: c.media, occurredAt: kstIso(data.today, c.hourOfData),
        metric: '예산 소진율', observed: (c.spentToday / c.dailyBudget) * 100, baseline: 100,
        evidence: [{ label: '예산 소진율', observed: (c.spentToday / c.dailyBudget) * 100, unit: 'pct', threshold: '≥ 100%', level: 'danger' }],
        causes: [{ label: '소진 속도 상승', score: 70, basis: '시간대 입찰 · 일 예산 확인' }],
        impact: { revenueLossEst: Number.isFinite(eff.roas) ? (c.dailyBudget * eff.roas) / 100 * restShare : undefined },
        autoActions: ['예산 증액 · 재배분 승인 요청 준비 (GFA_DELEGATION 기준)'],
      }));
      continue;
    }
    if (fc.flag && fc.exhaustHour !== null) {
      const eh = fc.exhaustHour;
      const spike = spikeMedia.has(c.media);
      out.push(mk('budget_forecast', c.name, {
        title: `${c.name} 일 예산 조기 소진 예상 · ${fmtHour(eh)} 마감`,
        media: c.media, occurredAt: kstIso(data.today, c.hourOfData),
        metric: '소진 페이스', observed: fc.pace, baseline: 1, deltaPct: (fc.pace - 1) * 100,
        evidence: [
          { label: '오늘 소진', observed: c.spentToday, unit: 'krw', baseline: c.dailyBudget, note: `일 예산 대비 ${fmt.ratio(fc.spentShare, 0)}`, level: 'info' },
          { label: '같은 시각 평소 소진 비중', observed: fc.expectedShare * 100, unit: 'pct', baseLabel: `최근 ${PACE_CURVE_DAYS}일 시간대 소진 곡선 (Board · AD Pilot 동일 기준)`, level: 'info' },
          { label: '소진 페이스', observed: fc.pace, unit: 'times', threshold: '> 1.00배', level: 'warn', note: `오늘 종료 시 예상 소진 = 일 예산 × ${fc.pace.toFixed(2)}` },
          { label: '예상 마감 시각', observed: eh, unit: 'text', level: 'info', note: fmtHour(eh) },
          { label: '미노출 구간 평소 매출 비중', observed: fc.lostRevShare * 100, unit: 'pct', threshold: `≥ ${Math.round(cfg.budgetLostShare * 100)}%`, level: 'danger' },
        ],
        causes: [
          ...(spike ? [{ label: `${MEDIA[c.media].name} 데이터 급변과 동일 원인`, score: 80, basis: `같은 매체 데이터 급변 이슈가 열려 있음 → 소진 가속의 원인 후보` }] : []),
          { label: '수요 증가 · 입찰 경쟁', score: spike ? 40 : 60, basis: `소진 페이스 ${fc.pace.toFixed(2)}배 · 시간대별 입찰 확인` },
          { label: '일 예산 과소 설정', score: 40, basis: `월 예산(연 배분/12) 대비 일 예산 확인 · ${MEDIA[c.media].name} 배분 ${fmt.ratio(MEDIA[c.media].share, 0)}` },
        ],
        impact: { revenueLossEst: fc.revenueLossEst, impressionsLost: fc.impressionsLost },
        impactNote: `현재 페이스 유지 시 ${fmtHour(eh)} 이후 미노출 · 미노출 구간 평소 매출 비중 ${fmt.ratio(fc.lostRevShare, 0)} × 오늘 예상 집행 수요 × 최근 7일 ROAS ${fmt.roas(eff.roas)} 기준 추정. 마감 시각은 최근 ${PACE_CURVE_DAYS}일 시간대 소진 곡선 기준 (MILDO Board · AD Pilot과 같은 값).`,
        autoActions: ['AD Pilot 예산 재배분 · 시간대 입찰 조정 후보 생성', `마감 예상 1시간 전(${fmtHour(Math.max(ch + 1, eh - 1))}) 재알림 예약`],
        related: spike ? [`data_spike:${MEDIA[c.media].name}:${data.today}`] : undefined,
      }));
    }
  }

  /* ---- 핵심 키워드 노출 0 (p.44) ---- */
  for (const k of data.keywords) {
    if (k.status !== 'on' || k.daily.length < 3) continue;
    const core = k.isBrand || k.monthlySearch >= 5000;
    if (!core) continue;
    const last = k.daily[k.daily.length - 1];
    const prevAvg = mean(k.daily.slice(0, -1).map((x) => x.impressions));
    if (last.impressions === 0 && prevAvg >= 10) {
      out.push(mk('keyword_no_impression', k.text, {
        title: `핵심 키워드 '${k.text}' 노출 0`, media: 'naver_sa', occurredAt: kstIso(addDays(data.today, -1), 0),
        metric: '노출', observed: 0, baseline: prevAvg, deltaPct: -100,
        evidence: [{ label: '최근일 노출', observed: 0, baseline: prevAvg, deltaPct: -100, unit: 'int', baseLabel: '직전 평균', threshold: '노출 0', level: 'danger' }],
        causes: [{ label: '키워드 · 광고그룹 OFF 또는 검수 보류', score: 70, basis: '키워드 상태 · 검수 결과 확인' }, { label: CAUSE_CANDIDATES[0], score: 40, basis: `평균 순위 ${k.avgRank} · 입찰가 ${fmt.won(k.bid)}` }],
        impact: { impressionsLost: prevAvg, revenueLossEst: k.last14.revenue / Math.max(1, k.daily.length) },
        impactNote: '일 기준 · 직전 평균',
      }));
    }
  }

  /* ---- 키워드 성과 급변 (p.14 · 최근 3일 CPC/전환 ±50%) ---- */
  const rd = cfg.keywordRecentDays;
  for (const ks of keywordShifts(data, cfg).filter((x) => x.hit)) {
    const k = ks.keyword;
    const th = cfg.keywordSpikePct;
    const landingPartial = data.products.some((p) => p.landing === k.landing && p.options.some((o) => !o.inStock));
    const causes = rankCauses({
      search: true, baseLabel: `직전 ${ks.baseDays}일`, costD: ks.costD, clicksD: ks.clicksD, impsD: ks.impsD,
      cpcD: ks.cpcD, cpmD: NaN, ctrD: NaN, cvrD: ks.cvrD, clicksNormal: Number.isFinite(ks.clicksD) && ks.clicksD > -30, soldOutKeywords: soldOut.some((s) => s.keyword.id === k.id) ? 1 : 0, landingPartialSoldOut: landingPartial,
    }, ctxPromo);
    out.push(mk('keyword_spike', k.text, {
      title: `'${k.text}' 최근 ${rd}일 ${[ks.hitCpc ? `CPC ${fmt.delta(ks.cpcD, 0)}` : '', Number.isFinite(ks.convD) ? `전환 ${fmt.delta(ks.convD, 0)}${ks.convSampleOk ? '' : '(표본 부족 · 참고)'}` : ''].filter(Boolean).join(' · ')}`,
      media: 'naver_sa', occurredAt: kstIso(addDays(data.today, -rd), 0),
      metric: ks.hitCpc ? 'CPC' : '전환', observed: ks.hitCpc ? ks.cpcRecent : ks.convRecent, baseline: ks.hitCpc ? ks.cpcBase : ks.convBase, deltaPct: ks.hitCpc ? ks.cpcD : ks.convD,
      evidence: [
        { label: 'CPC', observed: ks.cpcRecent, baseline: ks.cpcBase, deltaPct: ks.cpcD, unit: 'won', baseLabel: `직전 ${ks.baseDays}일 평균`, threshold: `±${th}% (p.14)`, level: ks.hitCpc ? 'danger' : 'ok' },
        { label: '일 전환', observed: ks.convRecent, baseline: ks.convBase, deltaPct: ks.convD, unit: 'dec', baseLabel: `직전 ${ks.baseDays}일 평균`, threshold: `±${th}% · 직전 전환 ≥ ${cfg.keywordMinConv}건`, level: !ks.convSampleOk ? 'info' : ks.hitConv ? 'danger' : Number.isFinite(ks.convD) && Math.abs(ks.convD) >= 30 ? 'warn' : 'ok', note: ks.convSampleOk ? undefined : `직전 ${ks.baseDays}일 전환 ${fmt.dec1(ks.convBase * ks.baseDays)}건 < ${cfg.keywordMinConv}건 · 표본 부족으로 참고만 표시` },
        { label: '일 클릭', observed: ks.clicksRecent, baseline: ks.clicksBase, deltaPct: ks.clicksD, unit: 'dec', baseLabel: `직전 ${ks.baseDays}일 평균`, level: 'info' },
        { label: 'ROAS', observed: ks.roasRecent, baseline: ks.roasBase, deltaPct: pct(ks.roasRecent, ks.roasBase), unit: 'roas', baseLabel: `목표 ${k.isBrand ? AD_PILOT.brandTargetRoas : AD_PILOT.targetRoas}%`, level: 'info' },
      ],
      causes,
      impact: { spendAtRisk: ks.excessCost, revenueLossEst: ks.revenueGap },
      impactNote: `최근 ${rd}일 합계 기준 · 직전 ${ks.baseDays}일 일평균 대비 초과 광고비 · 매출 감소분`,
      autoActions: [`AD Pilot '${k.text}' 자동 조정 보류 · 알림 (p.14 성과 급변 ±${AD_PILOT.anomalyHoldPct}%)`],
      holdMedia: 'naver_sa',
    }));
  }

  /* ---- 품절 · 옵션 품절 랜딩 (p.45) ---- */
  for (const s of soldOut) {
    const k = s.keyword;
    const n = Math.max(1, k.daily.length);
    const samePage = data.keywords.filter((x) => x.landing === k.landing && x.id !== k.id && x.status !== 'off');
    out.push(mk('soldout_landing', k.text, {
      title: `'${k.text}' → ${s.option} 옵션 품절 상세로 랜딩`, media: 'naver_sa',
      metric: '품절 옵션', observed: 0,
      evidence: [
        { label: `${s.product} · ${s.option}`, observed: 0, unit: 'text', threshold: 'inStock = false', level: 'danger', note: '옵션 품절' },
        { label: '키워드 일 평균 광고비', observed: k.last14.cost / n, unit: 'krw', baseLabel: '최근 14일', level: 'info' },
        { label: '키워드 일 평균 클릭', observed: k.last14.clicks / n, unit: 'dec', level: 'info' },
        { label: '같은 상세로 랜딩하는 키워드', observed: samePage.length, unit: 'int', level: 'info', note: '다른 옵션 구매 가능 · 옵션 지정 키워드만 이슈 처리' },
      ],
      causes: [{ label: CAUSE_CANDIDATES[1], score: 90, basis: `${s.option} 재고 0 · 키워드가 해당 옵션을 지정` }],
      impact: { spendAtRisk: k.last14.cost / n, revenueLossEst: k.last14.revenue / n, impressionsLost: undefined },
      impactNote: '일 기준 · 랜딩 옵션 구매 불가 가정 상한 (다른 사이즈 구매 전환은 반영하지 않음)',
      autoActions: [`'${k.text}' 키워드 · ${k.adgroup} 그룹 일시 중지 제안 (승인 후 반영)`, '재입고 시 자동 재개 조건 등록'],
    }));
  }

  /* ---- 가격 · 프로모션 불일치 (p.45) ---- */
  for (const pc of checkPromoPrices(data).filter((x) => !x.ok)) {
    out.push(mk('price_mismatch', pc.promotion.name, {
      title: `${pc.promotion.name} 소재 가격 표기 불일치`, media: pc.promotion.channel,
      evidence: [
        { label: '소재 표기가', observed: pc.promotion.adCopyPrice ?? NaN, unit: 'won', level: 'danger' },
        { label: '판매가 × (1 − 할인율)', observed: pc.expected ?? NaN, unit: 'won', level: 'info', note: pc.option ?? undefined },
        { label: '차이', observed: pc.diffPct ?? NaN, unit: 'pct', threshold: '±1%', level: 'danger', note: pc.note },
      ],
      causes: [{ label: CAUSE_CANDIDATES[2], score: 85, basis: pc.note }],
      impact: {},
      impactNote: '표시광고 · 매체 정책 리스크 · 신뢰 손상 (금액 추정 불가)',
      autoActions: ['해당 소재 교체 요청 · 판매가 매일 대조 유지'],
    }));
  }

  /* ---- 브랜드 키워드 침투 (p.45) ---- */
  const brandHits = data.keywords.filter((k) => k.isBrand && k.status !== 'off' && (k.avgRank >= cfg.brandRank || k.impressionShareLost >= cfg.brandLost));
  if (brandHits.length) {
    const n = (k: Keyword) => Math.max(1, k.daily.length);
    const lostImps = sum(brandHits, (k) => (k.last14.impressions / n(k)) * (k.impressionShareLost / Math.max(0.01, 1 - k.impressionShareLost)));
    const lostRev = 0.5 * sum(brandHits, (k) => (k.last14.revenue / n(k)) * (k.impressionShareLost / Math.max(0.01, 1 - k.impressionShareLost)));
    out.push(mk('brand_intrusion', '브랜드 키워드', {
      title: `브랜드 키워드 ${brandHits.length}개 상위 지면 경쟁사 노출 추정 · 평균 순위 ${fmt.dec1(mean(brandHits.map((k) => k.avgRank)))}위`,
      media: 'naver_sa',
      evidence: brandHits.map((k) => ({ label: `'${k.text}' 평균 순위`, observed: k.avgRank, unit: 'rank' as const, threshold: `순위 ≥ ${cfg.brandRank} 또는 손실 ≥ ${Math.round(cfg.brandLost * 100)}%`, level: 'warn' as const, note: `노출 기회 손실 ${fmt.ratio(k.impressionShareLost, 0)} · 입찰가 ${fmt.won(k.bid)} / 상한 ${fmt.won(k.maxBid)}` })),
      causes: [
        { label: CAUSE_CANDIDATES[0], score: 70, basis: '브랜드 검색어 상위 지면에 타사 광고가 있을 때 평균 순위가 1위 밖으로 밀림 · SERP 스냅샷으로 확인 필요' },
        { label: '브랜드 캠페인 예산 · 입찰 부족', score: 50, basis: '노출 기회 손실(순위 · 예산) 비중 확인' },
      ],
      impact: { impressionsLost: lostImps, revenueLossEst: lostRev },
      impactNote: '일 기준 · 노출 손실분이 현재 브랜드 키워드 효율의 50%로 전환된다는 가정 (하위 순위 CTR 감소 반영 · 상한 추정)',
      autoActions: [`방어 입찰 제안 → AD Pilot 브랜드 기준 (목표 ROAS ${AD_PILOT.brandTargetRoas}% · 순위 방어 우선)`, 'MILDO Watch 브랜드 지면 스냅샷 점검 요청'],
    }));
  }

  /* ---- 계정 · 결제 · 권한 · 상태 (p.44 · p.50) ---- */
  for (const ac of checkAccounts(data, cfg, idx)) {
    const a = ac.account;
    const m = accountMedia(a);
    const mediaName = (MEDIA_IDS as string[]).includes(a.media) ? MEDIA[a.media as MediaId].name : SALES_CHANNELS[a.media as SalesChannelId]?.name ?? a.media;
    const pay = ac.findings.filter((f) => f.level === 'fail' && (f.label === '잔액' || f.label === '자동충전'));
    if (pay.length) {
      const eff = mediaEfficiency(data, m);
      const exhaust = ac.exhaustAtMs;
      const exDate = exhaust ? kstDate(exhaust) : data.today;
      const nb = isOffDay(exDate).off ? nextBusinessDay(exDate) : exDate;
      const resumeMs = Date.parse(`${nb}T09:30:00+09:00`);
      const outageH = exhaust && resumeMs > exhaust ? (resumeMs - exhaust) / HOUR_MS : 0;
      const prof = hourProfile(data, m, 'cost', idx);
      // 미조치 시 중단 구간의 평소 소진 (시간대 곡선 기준)
      let outageSpend = 0;
      if (exhaust && outageH > 0) {
        for (let t = exhaust; t < resumeMs; t += HOUR_MS) {
          const hh = new Date(t + KST_MS).getUTCHours();
          outageSpend += a.avgDailySpend * prof[hh] * Math.min(1, (resumeMs - t) / HOUR_MS);
        }
      }
      out.push(mk('account_payment', a.name, {
        title: `${a.name} ${pay.map((p) => (p.label === '잔액' ? '잔액 1일치 미만' : '자동충전 실패')).join(' · ')}`,
        media: a.media,
        metric: '잔액', observed: a.balance, baseline: a.avgDailySpend, deltaPct: pct(a.balance, a.avgDailySpend),
        evidence: [
          { label: '잔액', observed: a.balance, baseline: a.avgDailySpend, unit: 'krw', baseLabel: '일 평균 소진', threshold: '< 1일치', level: ac.runwayDays < 1 ? 'danger' : 'info' },
          { label: '잔액 소진 예상 일수', observed: ac.runwayDays, unit: 'days', threshold: '< 1일 → P1', level: ac.runwayDays < 1 ? 'danger' : 'ok' },
          { label: '소진 예상 시각', observed: exhaust ?? NaN, unit: 'text', level: 'info', note: exhaust ? `${fmtStamp(exhaust)} (시간대 소진 곡선 기준)` : '—' },
          { label: '자동충전', observed: 0, unit: 'text', threshold: 'failed → P1', level: a.autoCharge === 'failed' ? 'danger' : 'ok', note: a.autoCharge === 'failed' ? '자동충전 실패' : a.autoCharge },
          { label: '결제 수단', observed: 0, unit: 'text', level: 'info', note: a.paymentMethod },
        ],
        causes: [
          ...(a.autoCharge === 'failed' ? [{ label: '자동충전 카드 한도 · 유효기간', score: 75, basis: '자동충전 실패 기록 · 결제 수단 소유 수면밀도 [협의] (p.50)' }] : []),
          { label: '소진 속도 대비 충전 단위 부족', score: 50, basis: `일 평균 소진 ${fmt.krw(a.avgDailySpend)}원 대비 잔액 ${fmt.ratio(ac.runwayDays, 0)}` },
        ],
        impact: { spendAtRisk: outageSpend, revenueLossEst: Number.isFinite(eff.roas) ? (outageSpend * eff.roas) / 100 : undefined, impressionsLost: Number.isFinite(eff.impsPerWon) ? outageSpend * eff.impsPerWon : undefined },
        impactNote: exhaust
          ? `미조치 시 ${fmtStamp(exhaust)} 잔액 소진 → ${isOffDay(exDate).off ? `다음 영업일 ${fmtDateShort(nb)} 09:30` : '당일 조치'}까지 ${fmt.dec1(outageH)}시간 미노출. 해당 구간 평소 소진 ${fmt.krw(outageSpend)}원 × 최근 7일 ROAS ${fmt.roas(eff.roas)} 기준 추정.`
          : '잔액 정보 없음',
        autoActions: ['충전 요청 초안 생성 (승인: 수면밀도)', '잔액 1시간 단위 재조회'],
        ownerRoleId: MEDIA_OWNER_ROLE[a.media],
      }));
    }
    if (ac.nonRealName) {
      const p = a.permissions.filter((x) => !x.realName);
      const admin = p.some((x) => /관리자/.test(x.role));
      out.push(mk('account_permission', a.name, {
        title: `${a.name} 비실명 공유 계정 ${p.map((x) => `${x.user}(${x.role})`).join(', ')}`,
        media: a.media,
        evidence: [
          ...p.map((x) => ({ label: `${x.user} · ${x.role}`, observed: dayDiff(data.today, x.lastLogin), unit: 'text' as const, threshold: '실명 계정 · 최소 권한 (p.50)', level: 'danger' as const, note: `비실명 · 마지막 로그인 ${x.lastLogin} (${dayDiff(data.today, x.lastLogin)}일 전)` })),
          { label: '등급 근거', observed: 0, unit: 'text' as const, threshold: '권한 변경 이벤트 → P1 (p.44) · 정책 위반 상태 → P2', level: 'info' as const, note: '권한 변경 이력 미연동 · 현재 권한 목록의 실명 · 최소 권한 위반으로 판정' },
        ],
        causes: [{ label: '이전 대행 · 공용 계정 미회수', score: 70, basis: '담당자 교체 시 즉시 회수 원칙 (p.50)' }],
        impact: { spendAtRisk: admin ? a.avgDailySpend : undefined },
        impactNote: admin ? `관리자 권한 — 캠페인 · 결제 변경 가능. 일 평균 소진 ${fmt.krw(a.avgDailySpend)}원이 통제 범위 밖에 있음 (금액 손실 추정 아님).` : '조회 · 운영 권한',
        autoActions: ['권한 회수 요청 초안 (PM → 수면밀도 통보, p.50)'],
        ownerRoleId: 'pm',
      }));
    }
    if (a.status !== 'active') {
      const restricted = a.status === 'restricted';
      out.push(mk('account_status', a.name, {
        severity: restricted ? 'P1' : 'P2',
        title: `${a.name} ${restricted ? '계정 제재' : '계정 검수 · 확인 필요'}`,
        media: a.media,
        evidence: [
          { label: '계정 상태', observed: 0, unit: 'text', threshold: 'restricted → P1 · review → P2', level: restricted ? 'danger' : 'warn', note: a.status },
          { label: '일 평균 소진', observed: a.avgDailySpend, unit: 'krw', level: 'info' },
          { label: '최근 접속', observed: 0, unit: 'text', level: 'info', note: a.permissions.map((x) => `${x.user} ${x.lastLogin}`).join(', ') },
        ],
        causes: [{ label: '매체 정기 검수 · 서류 요청', score: 60, basis: `${mediaName} 계정 알림 확인` }, { label: '소재 · 상품 정보 검수', score: 40, basis: '집들이 위크 등 진행 중 프로모션 소재 확인' }],
        impact: { spendAtRisk: a.avgDailySpend },
        impactNote: `검수 결과에 따라 집행 중단 시 일 ${fmt.krw(a.avgDailySpend)}원 집행 불가 (위험 노출액, 손실 확정 아님)`,
        autoActions: ['매체 계정 알림 · 요청 서류 확인 요청'],
      }));
    }
  }

  /* ---- 소재 · 랜딩 (p.44) ---- */
  for (const cr of creatives) {
    const age = (nowMs - Date.parse(cr.submittedAt)) / HOUR_MS;
    if (cr.status === 'rejected') {
      out.push(mk('creative_rejected', cr.name, {
        title: `${cr.name} 소재 반려`, media: cr.media,
        evidence: [{ label: '검수 결과', observed: 0, unit: 'text', threshold: '반려', level: 'danger', note: cr.reason ?? '사유 미기재' }, { label: '소재 문구', observed: 0, unit: 'text', level: 'info', note: cr.copy }],
        causes: [{ label: '매체 정책 · 표현 기준', score: 80, basis: cr.reason ?? '반려 사유 확인' }],
        impact: { spendAtRisk: mediaEfficiency(data, cr.media).dailyCost * 0.25 },
        impactNote: '소재 1개 비중 25% 가정 · 일 기준',
        autoActions: ['MILDO Lab 검수 에이전트로 수정 문안 생성 요청', '대체 소재 자동 노출 확인'],
      }));
    } else if (cr.status === 'pending' && age > cfg.creativePendingHours) {
      out.push(mk('creative_pending', cr.name, {
        title: `${cr.name} 검수 보류 ${Math.floor(age)}시간`, media: cr.media,
        evidence: [{ label: '검수 대기', observed: age, unit: 'hours', threshold: `> ${cfg.creativePendingHours}시간`, level: 'danger' }],
        causes: [{ label: '매체 검수 지연', score: 70, basis: '매체 지연은 SLA 산정에서 별도 표기' }],
        impact: {},
        autoActions: ['매체 담당자 검수 요청'],
      }));
    }
    if (cr.landingStatus >= 400 || !/^https:\/\//.test(cr.landing)) {
      out.push(mk('landing_error', `${cr.name} 랜딩`, {
        title: `${cr.name} 랜딩 URL 오류 (${cr.landingStatus})`, media: cr.media,
        evidence: [{ label: '랜딩 응답', observed: cr.landingStatus, unit: 'int', threshold: '4xx · 5xx 또는 https 아님', level: 'danger', note: cr.landing }],
        causes: [{ label: CAUSE_CANDIDATES[1], score: 90, basis: `응답 코드 ${cr.landingStatus}` }],
        impact: { spendAtRisk: mediaEfficiency(data, cr.media).dailyCost * 0.25 },
        autoActions: ['해당 소재 일시 중지 제안', 'URL 교체 요청'],
      }));
    }
  }

  /* ---- 매체 · 외부 환경: 검색량 급변 (p.44, P3) ---- */
  const bs = data.brandSearchDaily;
  if (bs.length >= 29) {
    const y = addDays(data.today, -1);
    const yv = bs.find((x) => x.date === y)?.volume;
    const base = [7, 14, 21, 28].map((k) => bs.find((x) => x.date === addDays(y, -k))?.volume).filter((v): v is number => v !== undefined);
    if (yv !== undefined && base.length >= 2) {
      const bm = mean(base);
      const dlt = pct(yv, bm);
      if (Number.isFinite(dlt) && Math.abs(dlt) >= cfg.searchVolumePct) {
        out.push(mk('search_volume', '브랜드 검색량', {
          title: `브랜드 검색량 ${fmt.delta(dlt, 0)} (전일 · 동요일 4주 평균 대비)`, media: 'naver_sa', occurredAt: kstIso(y, 0),
          evidence: [{ label: '브랜드 검색량', observed: yv, baseline: bm, deltaPct: dlt, unit: 'int', baseLabel: '최근 4주 동요일 평균', threshold: `±${cfg.searchVolumePct}%`, level: 'warn' }],
          causes: [{ label: 'GFA 집행 · 외부 노출', score: 50, basis: '브랜드 검색량은 GFA 집행에 1~2일 시차로 동행 (MILDO Growth DA→SA 분석)' }],
          impact: {},
          autoActions: ['24시간 내 영향 분석 · 주간 리포트 포함'],
        }));
      }
    }
  }

  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.impact.revenueLossEst ?? 0) - (a.impact.revenueLossEst ?? 0));
}

export function fmtHour(h: number): string {
  if (!Number.isFinite(h)) return '—';
  const hh = Math.floor(h);
  const mm = Math.min(59, Math.round((h - hh) * 60));
  return `${pad2(hh)}:${pad2(mm)}`;
}

/* ============================== 대량 변경 실수 (p.45, state.changes 기반) ============================== */

export function detectBulkChange(changes: readonly ChangeRequest[], opts: { today?: string; config?: Partial<AlertConfig> } = {}): AlertIncident[] {
  const cfg = resolveConfig(opts.config);
  const live = changes.filter((c) => c.status !== 'rejected' && c.status !== 'rolled_back' && (c.kind === 'bid' || c.kind === 'budget' || c.kind === 'gfa' || c.kind === 'status'));
  const out: AlertIncident[] = [];
  const byKey = new Map<string, ChangeRequest[]>();
  for (const c of live) {
    const k = `${c.module}|${c.requestedBy}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(c);
  }
  const mk = (target: string, title: string, list: ChangeRequest[], evidence: Evidence[], basisNote: string): AlertIncident => {
    const first = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const day = opts.today ?? kstDate(Date.parse(first.createdAt));
    const rule = RULES.bulk_change;
    return {
      id: `bulk_change:${target}:${day}`, ruleId: 'bulk_change', typeId: rule.typeId, ruleLabel: rule.label, basis: rule.basis, page: rule.page,
      severity: 'P1', title, target, media: undefined,
      detectedAt: first.createdAt, occurredAt: first.createdAt,
      detectPath: `MILDO Alert · 변경 이력 감시 (MILDO Flow) · ${basisNote}`,
      causeCandidates: ['일괄 승인 · 반영 조작 실수', '규칙 설정값 오입력 (상한 · 목표 ROAS)'],
      causes: [{ label: '일괄 승인 · 반영 조작 실수', score: 70, basis: basisNote }, { label: '규칙 설정값 오입력', score: 50, basis: 'AD Pilot SAFETY 설정 확인' }],
      evidence,
      impact: {}, impactNote: '변경 대상 · 폭 기준 (금액 추정은 반영 후 1시간 성과로 확인)',
      assignee: 'PM', backup: roleLabel('sa_lead'), assigneeRoleId: 'pm', backupRoleId: 'sa_lead', ownerRoleId: 'pm',
      status: 'open',
      timeline: [{ at: first.createdAt, by: 'MILDO Alert', action: '감지 · 메신저 즉시 알림 (AE + 백업 + PM)' }],
      isTest: false,
      autoActions: ['신규 반영 일시 차단 (승인 대기 유지)', '즉시 롤백 후보 목록 생성 (MILDO Flow)'],
      related: list.map((c) => c.id),
    };
  };
  for (const [k, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // 슬라이딩 윈도
    let best: ChangeRequest[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const t0 = Date.parse(sorted[i].createdAt);
      const win = sorted.filter((c) => { const t = Date.parse(c.createdAt); return t >= t0 && t - t0 <= cfg.bulkWindowMin * 60_000; });
      if (win.length > best.length) best = win;
    }
    if (best.length >= cfg.bulkBatch) {
      const [module, by] = k.split('|');
      // 대상(target)은 이슈 id · 서버 대량 변경 가드의 계열 키라 모듈 id 그대로, 제목은 화면 표기(모듈 한글 · 제품명)
      out.push(mk(`${module} · ${by}`, `${MODULE_LABEL[module] ?? module} ${by} ${cfg.bulkWindowMin}분 내 ${best.length}건 일괄 변경`, best, [
        { label: `${cfg.bulkWindowMin}분 내 변경 건수`, observed: best.length, unit: 'int', threshold: `≥ ${cfg.bulkBatch}건`, level: 'danger' },
        { label: '평균 변경 폭', observed: mean(best.map((c) => Math.abs(c.changePct ?? 0))), unit: 'pct', level: 'info' },
      ], `동일 요청자 ${cfg.bulkWindowMin}분 내 ${best.length}건`));
    }
  }
  const over = live.filter((c) => c.kind === 'bid' && (c.status === 'applied' || c.status === 'approved') && Math.abs(c.changePct ?? 0) > AD_PILOT.dailyChangeCapPct);
  for (const c of over) {
    out.push(mk(c.target, `'${c.target}' 입찰 변경 폭 ${fmt.delta(c.changePct ?? 0, 0)} — 일 조정 상한 초과`, [c], [
      { label: '변경 폭', observed: Math.abs(c.changePct ?? 0), unit: 'pct', threshold: `≤ ${AD_PILOT.dailyChangeCapPct}% (p.14 SAFETY)`, level: 'danger', note: `${c.before} → ${c.after}` },
    ], 'AD Pilot 일 조정 폭 상한 초과'));
  }
  const routing = live.filter((c) => (c.kind === 'budget' || c.kind === 'gfa') && Math.abs(c.changePct ?? 0) > 30 && c.approver !== 'CLIENT' && (c.status === 'applied' || c.status === 'approved'));
  for (const c of routing) {
    out.push(mk(c.target, `'${c.target}' 예산 ${fmt.delta(c.changePct ?? 0, 0)} — 수면밀도 승인 없이 반영`, [c], [
      { label: '변경 폭', observed: Math.abs(c.changePct ?? 0), unit: 'pct', threshold: '30% 초과 → 수면밀도 승인 (p.15)', level: 'danger', note: `승인 주체 ${c.approver}` },
    ], '승인 라우팅 불일치'));
  }
  return out;
}

/* ============================== SLA (p.49) ============================== */

export interface SlaTargets { ackMin: number; actionMin: number | null; reportMin: number | null; ack: string; action: string; report: string; offDay: boolean }
export function slaTargets(sev: Severity, detectedMs: number, forcedOff = false): SlaTargets {
  const date = kstDate(detectedMs);
  const off = forcedOff || isOffDay(date).off;
  const s = SLA[sev];
  const ackMin = off ? Math.min(s.ackMin, WEEKEND_ACK_MIN) : s.ackMin;
  const minutesToMidnight = Math.max(60, (dayStartMs(date) + 24 * HOUR_MS - detectedMs) / 60_000);
  const reportMin = s.reportMin ?? (sev === 'P2' ? minutesToMidnight : sev === 'P3' ? 7 * 1440 : null);
  return {
    ackMin, actionMin: s.actionMin, reportMin,
    ack: off && ackMin !== s.ackMin ? `${ackMin}분 (주말 · 공휴일 당번)` : s.label.ack,
    action: s.label.action, report: s.label.report, offDay: off,
  };
}

export type SlaStage = 'ack' | 'action' | 'report' | 'close' | 'done';
export interface SlaState {
  stage: SlaStage;
  stageLabel: string;
  targets: SlaTargets;
  deadlineMs: number | null;
  remainingMin: number | null;
  overdue: boolean;
  elapsed: { ack?: number; action?: number; report?: number };
  achieved: { ack?: boolean; action?: boolean; report?: boolean };
}
/** toMs: ISO → 데이터 기준 시각(ms). 실제 시각 기록(Z)은 화면이 데이터 시계로 환산해 넘긴다. */
export function slaState(inc: AlertIncident | Incident, nowMs: number, toMs: (iso: string) => number = Date.parse, forcedOff = false): SlaState {
  const a = inc as AlertIncident;
  const det = toMs(inc.detectedAt);
  const targets = slaTargets(inc.severity, det, forcedOff || !!a.onDuty);
  const s = a.sla ?? {};
  const ackAt = s.ackAt ? toMs(s.ackAt) : undefined;
  const actionAt = s.actionAt ? toMs(s.actionAt) : undefined;
  const reportAt = s.reportAt ? toMs(s.reportAt) : undefined;
  const elapsed = {
    ack: ackAt !== undefined ? (ackAt - det) / 60_000 : undefined,
    action: actionAt !== undefined ? (actionAt - det) / 60_000 : undefined,
    report: reportAt !== undefined ? (reportAt - det) / 60_000 : undefined,
  };
  const achieved = {
    ack: elapsed.ack !== undefined ? elapsed.ack <= targets.ackMin : undefined,
    action: elapsed.action !== undefined && targets.actionMin !== null ? elapsed.action <= targets.actionMin : undefined,
    report: elapsed.report !== undefined && targets.reportMin !== null ? elapsed.report <= targets.reportMin : undefined,
  };
  let stage: SlaStage;
  const st = inc.status;
  if (st === 'resolved') stage = 'done';
  else if (ackAt === undefined && st === 'open') stage = 'ack';
  else if (actionAt === undefined && st !== 'action' && targets.actionMin !== null) stage = 'action';
  else if (reportAt === undefined && targets.reportMin !== null) stage = 'report';
  else stage = 'close';
  const targetMin = stage === 'ack' ? targets.ackMin : stage === 'action' ? targets.actionMin : stage === 'report' ? targets.reportMin : null;
  const deadlineMs = targetMin !== null ? det + targetMin * 60_000 : null;
  const remainingMin = deadlineMs !== null ? (deadlineMs - nowMs) / 60_000 : null;
  const label = { ack: `인지 ${targets.ack}`, action: `1차 조치 ${targets.action}`, report: `결과 보고 ${targets.report}`, close: '해결 · 재발 방지 대기', done: '해결' }[stage];
  return { stage, stageLabel: label, targets, deadlineMs, remainingMin, overdue: remainingMin !== null && remainingMin < 0, elapsed, achieved };
}
export function fmtRemain(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return '—';
  const neg = min < 0;
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = Math.floor(a % 60);
  const s = Math.floor((a * 60) % 60);
  const body = h > 0 ? `${h}시간 ${pad2(m)}분` : `${pad2(m)}:${pad2(s)}`;
  return neg ? `${body} 초과` : `${body} 남음`;
}

/* ============================== 월간 SLA 리포트 (p.49) ============================== */

export interface SlaRecord {
  id: string; date: string; hour: number; severity: Severity; typeId: string; ruleId: string; media?: string; title: string;
  ackMin: number | null; actionMin: number | null; reportMin: number | null;
  falsePositive: boolean; recurrence: boolean; mediaDelayMin: number; source: 'history' | 'session'; metric?: string;
}
export function historyRecords(): SlaRecord[] {
  return SLA_HISTORY.map((h) => ({ ...h, source: 'history' as const }));
}
export function sessionRecords(incidents: readonly Incident[], toMs: (iso: string) => number = Date.parse): SlaRecord[] {
  return incidents.map((i) => i as AlertIncident).filter((i) => i.sla?.ackAt || (i.status === 'resolved' && !i.isTest)).map((i) => {
    const det = toMs(i.detectedAt);
    const m = (iso?: string) => (iso ? Math.max(0, (toMs(iso) - det) / 60_000) : null);
    const hist = SLA_HISTORY.filter((h) => h.ruleId === i.ruleId && h.media === i.media);
    return {
      id: i.id, date: kstDate(det), hour: new Date(det + KST_MS).getUTCHours(), severity: i.severity, typeId: i.typeId ?? RULES[i.ruleId]?.typeId ?? i.ruleId, ruleId: i.ruleId,
      media: i.media, title: i.title, ackMin: m(i.sla?.ackAt), actionMin: m(i.sla?.actionAt), reportMin: m(i.sla?.reportAt),
      falsePositive: !!i.falsePositive, recurrence: hist.length > 0 || !!i.recurrence, mediaDelayMin: 0, source: 'session' as const,
      metric: i.metric,
    };
  });
}
export interface SlaRow {
  severity: Severity; total: number;
  ack: { ok: number; n: number; pct: number }; action: { ok: number; n: number; pct: number }; report: { ok: number; n: number; pct: number };
  falsePositive: { n: number; pct: number }; recurrence: number; mediaDelay: { n: number; min: number };
}
export function recordTargets(r: SlaRecord): { ack: number; action: number | null; report: number } {
  const off = isOffDay(r.date).off;
  const s = SLA[r.severity];
  const ack = off ? Math.min(s.ackMin, WEEKEND_ACK_MIN) : s.ackMin;
  const report = s.reportMin ?? (r.severity === 'P2' ? Math.max(60, (24 - r.hour) * 60) : 7 * 1440);
  return { ack, action: s.actionMin, report };
}
export function slaReport(records: readonly SlaRecord[]): { rows: SlaRow[]; total: SlaRow; byMedia: { media: string; n: number; delayed: number; delayMin: number }[] } {
  const rate = (ok: number, n: number) => ({ ok, n, pct: n > 0 ? (ok / n) * 100 : NaN });
  const build = (sev: Severity | 'ALL', list: readonly SlaRecord[]): SlaRow => {
    let ackOk = 0, ackN = 0, actOk = 0, actN = 0, repOk = 0, repN = 0;
    for (const r of list) {
      const t = recordTargets(r);
      if (r.ackMin !== null) { ackN++; if (r.ackMin <= t.ack) ackOk++; }
      if (r.falsePositive) continue;
      if (t.action !== null && r.actionMin !== null) { actN++; if (r.actionMin - r.mediaDelayMin <= t.action) actOk++; }
      if (r.reportMin !== null) { repN++; if (r.reportMin - r.mediaDelayMin <= t.report) repOk++; }
    }
    const fp = list.filter((r) => r.falsePositive).length;
    const delayed = list.filter((r) => r.mediaDelayMin > 0);
    return {
      severity: sev === 'ALL' ? 'P1' : sev, total: list.length,
      ack: rate(ackOk, ackN), action: rate(actOk, actN), report: rate(repOk, repN),
      falsePositive: { n: fp, pct: list.length ? (fp / list.length) * 100 : NaN },
      recurrence: list.filter((r) => r.recurrence).length,
      mediaDelay: { n: delayed.length, min: sum(delayed, (r) => r.mediaDelayMin) },
    };
  };
  const rows = (['P1', 'P2', 'P3'] as Severity[]).map((s) => build(s, records.filter((r) => r.severity === s)));
  const mediaSet = Array.from(new Set(records.map((r) => r.media ?? '—')));
  return {
    rows,
    total: build('ALL', records),
    byMedia: mediaSet.map((m) => {
      const l = records.filter((r) => (r.media ?? '—') === m);
      return { media: m, n: l.length, delayed: l.filter((r) => r.mediaDelayMin > 0).length, delayMin: sum(l, (r) => r.mediaDelayMin) };
    }).sort((a, b) => b.n - a.n),
  };
}
/** 지표별 오탐률 (이상 징후 기준 튜닝용) */
export function falsePositiveByMetric(records: readonly SlaRecord[]): Record<string, { n: number; fp: number }> {
  const out: Record<string, { n: number; fp: number }> = {};
  for (const r of records) {
    if (!r.metric) continue;
    // 키워드 CPC 급변은 키워드 급변 기준(keywordSpikePct)의 오탐으로 집계
    const k = r.metric === 'cpc' ? 'keywordSpikePct' : r.metric;
    out[k] ??= { n: 0, fp: 0 };
    out[k].n++;
    if (r.falsePositive) out[k].fp++;
  }
  return out;
}

/* ============================== 연휴 전날 사전 점검 (p.48) ============================== */

export interface PrecheckItem {
  group: '예산' | '소재' | '결제 잔액' | '권한 · 당번'; item: string; level: 'pass' | 'warn' | 'fail'; detail: string; action: string;
  /** 시연용 예시 소재 목록(DEMO_CREATIVES)에서 나온 항목 — 워크스페이스 데이터가 실연동이어도 TEST DATA로 표시한다 */
  fixture?: true;
}
export function holidayPrecheck(data: Dataset, block: OffBlock, opts: { creatives?: CreativeReview[]; config?: Partial<AlertConfig>; tfNames?: Record<string, string> } = {}): { items: PrecheckItem[]; coverHours: number; from: string; to: string } {
  const cfg = resolveConfig(opts.config);
  const creatives = opts.creatives ?? DEMO_CREATIVES;
  const idx = buildHourIndex(data);
  const items: PrecheckItem[] = [];
  const startMs = data.today >= block.start ? Date.parse(data.generatedAt) : Date.parse(`${block.prevBusinessDay}T17:00:00+09:00`);
  const endMs = Date.parse(`${block.nextBusinessDay}T09:30:00+09:00`);
  const coverHours = Math.max(0, (endMs - startMs) / HOUR_MS);
  const needDays = coverHours / 24;

  // 결제 잔액
  for (const ac of checkAccounts(data, cfg, idx)) {
    const a = ac.account;
    if (!ac.prepaid) {
      items.push({ group: '결제 잔액', item: a.name, level: 'warn', detail: `${a.paymentMethod} — 연휴 기간 예상 집행 ${fmt.krw(a.avgDailySpend * needDays)}원 · 한도 정보 미연동`, action: '카드 한도 여유 확인 (수면밀도)' });
      continue;
    }
    const ok = ac.runwayDays >= needDays + 0.5 && a.autoCharge !== 'failed';
    const level = a.autoCharge === 'failed' || ac.runwayDays < needDays ? 'fail' : ok ? 'pass' : 'warn';
    const shortfall = Math.max(0, a.avgDailySpend * (needDays + 0.5) - a.balance);
    items.push({
      group: '결제 잔액', item: a.name, level,
      detail: `잔액 ${fmt.krw(a.balance)}원 · ${fmt.dec1(ac.runwayDays)}일치 / 필요 ${fmt.dec1(needDays)}일 + 버퍼 0.5일${a.autoCharge === 'failed' ? ' · 자동충전 실패' : a.autoCharge === 'off' ? ' · 수동 충전' : ''}`,
      action: level === 'pass' ? '—' : `연휴 전 ${fmt.krw(Math.ceil(shortfall / 10000) * 10000)}원 이상 충전 요청 (승인: 수면밀도)`,
    });
  }
  // 예산
  const fcs = budgetForecasts(data, cfg, idx).filter((f) => f.exhaustHour !== null && (f.flag || f.exhaustHour < 23));
  for (const f of fcs) {
    items.push({ group: '예산', item: f.campaign.name, level: f.flag ? 'fail' : 'warn', detail: `오늘 페이스 ${f.pace.toFixed(2)}배 · 예상 마감 ${fmtHour(f.exhaustHour!)}${f.flag ? ` · 미노출 구간 매출 비중 ${fmt.ratio(f.lostRevShare, 0)}` : ''} — 연휴 중 같은 패턴 반복 가능`, action: '일 예산 · 시간대 입찰 상한 사전 승인 (GFA_DELEGATION · AD Pilot)' });
  }
  if (!fcs.length) items.push({ group: '예산', item: '캠페인 일 예산', level: 'pass', detail: '조기 소진 예상 캠페인 없음', action: '—' });
  const inMonth = block.dates.filter((d) => d.slice(0, 7) === data.today.slice(0, 7)).length;
  if (inMonth > 0) {
    const short = monthlyPacing(data).map((p) => ({ p, remain: p.budget - p.spent, need: (MEDIA[p.media].annualBudget / 365) * inMonth })).filter((x) => x.remain < x.need);
    const over = short.filter((x) => x.remain <= 0);
    if (short.length) {
      items.push({
        group: '예산', item: '월 예산 잔여 (연 배분/12)', level: 'warn',
        detail: `${over.length ? `초과 집행 ${over.length}개 매체 (${over.map((x) => `${MEDIA[x.p.media].short} ${fmt.krw(x.remain)}원`).join(', ')})` : ''}${over.length && short.length > over.length ? ' · ' : ''}${short.length > over.length ? `잔여 부족 ${short.length - over.length}개 매체` : ''} — 연휴 중 이번 달 ${inMonth}일 집행 예정`,
        action: '월 예산 초과분 승인 · 다음 달 이월 또는 일 예산 하향 (수면밀도 승인)',
      });
    } else items.push({ group: '예산', item: '월 예산 잔여 (연 배분/12)', level: 'pass', detail: `연휴 중 이번 달 ${inMonth}일 집행분 잔여 충분`, action: '—' });
  }
  // 소재 (소재 목록을 넘기지 않으면 시연용 예시 소재 — 그 항목은 fixture로 표시)
  const fx = creatives === DEMO_CREATIVES ? { fixture: true as const } : {};
  for (const cr of creatives) {
    if (cr.status === 'rejected') items.push({ group: '소재', item: cr.name, level: 'fail', detail: `반려 · ${cr.reason ?? ''}`, action: '대체 소재 검수 완료 후 연휴 진입', ...fx });
    else if (cr.status === 'pending') items.push({ group: '소재', item: cr.name, level: 'warn', detail: `검수 대기 (${cr.submittedAt.slice(5, 16).replace('T', ' ')} 제출)`, action: '연휴 전 검수 완료 확인 · 미완료 시 기존 소재 유지', ...fx });
    if (cr.landingStatus >= 400) items.push({ group: '소재', item: `${cr.name} 랜딩`, level: 'fail', detail: `응답 ${cr.landingStatus}`, action: 'URL 교체', ...fx });
  }
  for (const s of soldOutKeywords(data)) items.push({ group: '소재', item: `'${s.keyword.text}' 랜딩`, level: 'fail', detail: `${s.option} 옵션 품절 상세로 랜딩`, action: '연휴 전 키워드 일시 중지 또는 대체 랜딩 승인' });
  for (const pc of checkPromoPrices(data)) {
    if (!pc.ok) items.push({ group: '소재', item: pc.promotion.name, level: 'fail', detail: pc.note, action: '소재 가격 문구 교체' });
  }
  for (const p of data.promotions) {
    if (p.status === 'ended') continue;
    if (p.end >= block.start && p.end <= block.end) items.push({ group: '소재', item: p.name, level: 'warn', detail: `연휴 중 종료 (${p.end}) — 종료 후 할인가 문구 노출 위험`, action: '종료 시각 소재 교체 예약' });
    if (p.start >= block.start && p.start <= block.end) items.push({ group: '소재', item: p.name, level: p.adCopyPrice ? 'pass' : 'warn', detail: `연휴 중 시작 (${p.start})${p.adCopyPrice ? '' : ' · 소재 가격 표기 미등록'}`, action: p.adCopyPrice ? '—' : '오픈 소재 · 가격 표기 사전 검수' });
  }
  if (!items.some((i) => i.group === '소재')) items.push({ group: '소재', item: '소재 · 랜딩 · 가격', level: 'pass', detail: '반려 · 품절 랜딩 · 가격 불일치 없음', action: '—' });
  // 권한 · 당번
  const duties = block.dates.map((d) => onDutyFor(d)).filter((x): x is DutyRow => !!x);
  const uniq = Array.from(new Map(duties.map((d) => [d.roleId, d])).values());
  for (const d of uniq) {
    const name = opts.tfNames?.[d.roleId];
    const user = ROLE_ACCOUNT_USER[d.roleId];
    const missing = data.accounts.filter((a) => !a.permissions.some((p) => p.user === user && p.realName));
    items.push({
      group: '권한 · 당번', item: `당번 ${d.role}${name ? ` (${name})` : ''} · ${duties.filter((x) => x.roleId === d.roleId).map((x) => fmtDateShort(x.date)).join(' ')}`,
      level: missing.length ? 'warn' : name ? 'pass' : 'warn',
      detail: `${missing.length ? `권한 없는 계정 ${missing.length}개: ${missing.map((a) => a.name.replace(/ \(수면밀도\)/, '')).join(', ')}` : '전 계정 실명 권한 보유'}${name ? '' : ' · 당번 성명 미입력'}`,
      action: missing.length ? `P1 발생 시 1차 조치는 백업 ${d.backup} 또는 PM 대행 · 필요 시 연휴 한정 권한 부여(수면밀도 통보)` : name ? '—' : '전담 TF 화면에서 성명 입력',
    });
  }
  for (const a of data.accounts) {
    for (const p of a.permissions.filter((x) => !x.realName)) items.push({ group: '권한 · 당번', item: `${a.name} ${p.user}`, level: 'fail', detail: `비실명 ${p.role} 권한`, action: '연휴 전 회수 (PM → 수면밀도 통보)' });
  }
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  items.sort((x, y) => ['예산', '소재', '결제 잔액', '권한 · 당번'].indexOf(x.group) - ['예산', '소재', '결제 잔액', '권한 · 당번'].indexOf(y.group) || order[x.level] - order[y.level]);
  return { items, coverHours, from: msToKstIso(startMs), to: msToKstIso(endMs) };
}

/* ============================== 알림 이력 ============================== */

export interface NotifyEntry { id: string; atMs: number; severity: Severity; channel: '메신저' | '메일'; to: string; kind: '감지' | '에스컬레이션' | 'SLA 초과' | '조치 공유'; title: string; body: string; incidentId: string; isTest: boolean }
export function notificationLog(incidents: readonly Incident[], nowMs: number, toMs: (iso: string) => number = Date.parse): NotifyEntry[] {
  const out: NotifyEntry[] = [];
  for (const raw of incidents) {
    const i = raw as AlertIncident;
    const typeId = i.typeId ?? RULES[i.ruleId]?.typeId ?? 'external';
    const n = NOTIFY_BY_TYPE[typeId] ?? { channel: i.severity === 'P3' ? '메일' : '메신저', to: '담당 AE' };
    const channel = i.severity === 'P3' ? '메일' : n.channel;
    const det = toMs(i.detectedAt);
    const cause = i.causes?.[0]?.label ?? i.causeCandidates?.[0]?.split(' — ')[0] ?? '원인 확인 중';
    out.push({ id: `${i.id}#d`, atMs: det, severity: i.severity, channel, to: n.to, kind: '감지', title: i.title, body: `${primaryEvidence(i)} · 원인 후보 ${cause}`, incidentId: i.id, isTest: i.isTest });
    if (i.onDuty) {
      out.push({ id: `${i.id}#duty`, atMs: det, severity: i.severity, channel: '메신저', to: `당번 ${i.assignee ?? 'AE'}`, kind: '감지', title: `[당번] ${i.title}`, body: '30분 내 확인 요청 (p.48)', incidentId: i.id, isTest: i.isTest });
      if (i.severity === 'P1') out.push({ id: `${i.id}#esc`, atMs: det + 60_000, severity: 'P1', channel: '메신저', to: 'PM · 브랜드 담당자', kind: '에스컬레이션', title: `[P1 에스컬레이션] ${i.title}`, body: '주말 · 공휴일 P1 — PM 에스컬레이션 · 브랜드 담당자 연락', incidentId: i.id, isTest: i.isTest });
    }
    const st = slaState(i, nowMs, toMs);
    if (st.overdue && st.deadlineMs !== null && st.stage !== 'done') {
      out.push({ id: `${i.id}#sla-${st.stage}`, atMs: st.deadlineMs, severity: i.severity, channel: '메신저', to: `백업 ${i.backup ?? ''} + PM`, kind: 'SLA 초과', title: `[SLA 초과] ${st.stageLabel} · ${i.title}`, body: '목표 시간 초과 — 백업 · PM 재알림', incidentId: i.id, isTest: i.isTest });
    }
    for (const [k, t] of (i.timeline ?? []).entries()) {
      if (k === 0 || t.by === 'MILDO Alert') continue;
      out.push({ id: `${i.id}#t${k}`, atMs: toMs(t.at), severity: i.severity, channel: i.severity === 'P3' ? '메일' : '메신저', to: 'AE + 백업 + PM', kind: '조치 공유', title: `${t.action} · ${i.title}`, body: `${t.by}`, incidentId: i.id, isTest: i.isTest });
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/* ============================== 이슈 보고서 (p.49 양식) ============================== */

export function incidentReport(raw: Incident, ctx: { nowMs: number; toMs?: (iso: string) => number; nameOf?: (roleLabel?: string) => string } = { nowMs: NaN }): string {
  const i = raw as AlertIncident;
  const toMs = ctx.toMs ?? Date.parse;
  const name = ctx.nameOf ?? ((r?: string) => r ?? '—');
  const st = slaState(i, Number.isFinite(ctx.nowMs) ? ctx.nowMs : toMs(i.detectedAt), toMs);
  const t = (iso?: string) => (iso ? fmtStamp(toMs(iso)) : '—');
  const sec = (key: (typeof INCIDENT_REPORT_TEMPLATE)[number]['key']) => {
    const s = INCIDENT_REPORT_TEMPLATE.find((x) => x.key === key)!;
    return `### ${s.label}\n_${s.fields}_\n`;
  };
  const cellText = (v: string) => v.replace(/\|/g, '/').replace(/\n/g, ' ');
  const ev = (i.evidence ?? []).map((e) => {
    const observed = e.unit === 'text' ? e.note ?? '—' : `${fmtValue(e.unit, e.observed)}${e.note ? ` (${e.note})` : ''}`;
    const base = e.unit !== 'text' && e.baseline !== undefined ? fmtValue(e.unit, e.baseline) : '—';
    return `| ${cellText(e.label)} | ${cellText(observed)} | ${base}${e.baseLabel ? ` (${cellText(e.baseLabel)})` : ''} | ${e.deltaPct !== undefined ? fmt.delta(e.deltaPct) : '—'} | ${cellText(e.threshold ?? '—')} |`;
  });
  const causes = (i.causes?.length ? i.causes.map((c) => `${c.label} (근거 강도 ${c.score}) — ${c.basis}`) : i.causeCandidates ?? []).map((c) => `- ${c}`);
  const imp = i.impact ?? {};
  const ach = (v?: boolean) => (v === undefined ? '진행 중' : v ? '달성' : '미달');
  const lines = [
    `## 이슈 보고서 · ${i.title}`,
    `등급 ${i.severity} · 유형 ${TYPE_LABEL[typeOf(i)] ?? i.ruleId} · 상태 ${STATUS_LABEL[i.status]}${i.isTest ? ' · 테스트 주입 이슈' : ''} · 데이터 TEST DATA (시연용, 실제 성과 아님)`,
    '',
    sec('occur'),
    `발생 시각 ${t(i.occurredAt)} · 감지 시각 ${t(i.detectedAt)}. 감지 경로: ${i.detectPath}. 담당 ${name(i.assignee)} · 백업 ${name(i.backup)}${i.onDuty ? ' (주말 · 공휴일 당번 체계)' : ''}.`,
    '',
    sec('cause'),
    `원인 분류: ${i.causes?.[0]?.label ?? '확인 중'} (규칙 엔진 순위 · 확정 아님). 판정 기준: ${i.basis} (제안서 ${i.page}).`,
    '',
    '| 지표 | 관측 | 기준 | 변화 | 판정 기준 |',
    '|---|---|---|---|---|',
    ...ev,
    '',
    ...causes,
    '',
    sec('impact'),
    `노출 ${imp.impressionsLost !== undefined ? `${fmt.int(imp.impressionsLost)}회` : '—'} · 광고비 ${imp.spendAtRisk !== undefined ? `${fmt.krw(imp.spendAtRisk)}원` : '—'} · 추정 매출 손실 ${imp.revenueLossEst !== undefined ? `${fmt.krw(imp.revenueLossEst)}원` : '—'}.${i.impactNote ? ` 산출: ${i.impactNote}` : ''}`,
    '',
    sec('action'),
    `자동 조치: ${(i.autoActions ?? []).join(' · ') || '—'}.`,
    `조치 내용: ${i.actionNote || '미기록'} · 1차 조치 ${t(i.sla?.actionAt)} · 결과 보고 ${t(i.sla?.reportAt)} · 해결 ${t(i.sla?.resolvedAt)}.`,
    '',
    sec('prevent'),
    i.preventNote || preventSuggestion(i),
    '',
    '### SLA',
    `인지 목표 ${st.targets.ack} → ${st.elapsed.ack !== undefined ? `${Math.round(st.elapsed.ack)}분 · ${ach(st.achieved.ack)}` : '미인지'}. 1차 조치 목표 ${st.targets.action} → ${st.elapsed.action !== undefined ? `${Math.round(st.elapsed.action)}분 · ${ach(st.achieved.action)}` : '진행 중'}. 결과 보고 목표 ${st.targets.report} → ${st.elapsed.report !== undefined ? `${Math.round(st.elapsed.report)}분 · ${ach(st.achieved.report)}` : '진행 중'}.`,
    i.recurrence ? `재발: 최근 30일 같은 유형 · 대상 ${i.recurrence.count}회 (${i.recurrence.dates.join(', ')}).` : '',
    '',
    '### 타임라인',
    ...(i.timeline ?? []).map((x) => `- ${t(x.at)} ${x.by} · ${x.action}`),
  ];
  return lines.filter((l, k, arr) => !(l === '' && arr[k - 1] === '')).join('\n');
}
export const STATUS_LABEL: Record<Incident['status'], string> = { open: '미인지', ack: '인지 · 배정', action: '조치 중', resolved: '해결' };

export function preventSuggestion(i: Pick<AlertIncident, 'ruleId'>): string {
  switch (i.ruleId) {
    case 'tracking_break': return '사이트 · 태그 배포 체크리스트에 전환 스크립트 확인 항목 추가, 배포 직후 1시간 전환 0 감시 강화(연속 2시간), 매체별 테스트 전환 발송 절차 문서화.';
    case 'account_payment': return '자동충전 카드 유효기간 · 한도 월 1회 점검, 잔액 기준을 1일치 → 2일치로 상향 검토(주말 대비), 연휴 전날 사전 점검 항목 유지.';
    case 'data_spike': case 'anomaly_warn': return '오탐이면 해당 지표 기준값 · 비교 구간 조정(탐지 기준 변경 요청), 실제 이상이면 원인 유형을 원인 후보 가중치에 반영.';
    case 'soldout_landing': return '재고 연동: 옵션 품절 시 옵션 지정 키워드 자동 일시 중지 제안 → 재입고 시 재개, 상품 상세 대체 랜딩 사전 지정.';
    case 'keyword_spike': return '경쟁 입찰 상승이 확인되면 키워드 순위 방어 기준 · 입찰 상한 재설정, 3일 연속 지속 시 비교 · 검토 캠페인 예산 재배분 검토.';
    case 'budget_forecast': case 'budget_exhausted': return '시간대 입찰 비중 조정 규칙 추가(저녁 피크 전 소진 방지), 일 예산 상향은 한계 ROAS 확인 후 승인.';
    case 'account_permission': return '분기 1회 권한 감사, 담당자 교체 시 24시간 내 회수 체크리스트, 공용 계정 신규 발급 금지.';
    case 'brand_intrusion': return '브랜드 지면 스냅샷 일 2회 수집 연동, 브랜드 키워드 순위 1위 유지 입찰 기준(목표 ROAS 800%) 적용.';
    default: return '탐지 기준 · 체크리스트 업데이트 항목을 기록한다.';
  }
}

/* ============================== 테스트 이슈 주입 (라이브 데모) ============================== */

/** 데이터 사본에 시나리오를 주입한다 (원본 불변) */
export function injectScenario(data: Dataset, creatives: CreativeReview[], kind: TestScenarioId): { data: Dataset; creatives: CreativeReview[] } {
  const d: Dataset = { ...data, campaigns: data.campaigns.map((c) => ({ ...c })), accounts: data.accounts.map((a) => ({ ...a })), mediaHourly: data.mediaHourly };
  let cr = creatives.map((c) => ({ ...c }));
  if (kind === 'ad_off') {
    const c = d.campaigns.find((x) => x.intent === 'brand') ?? d.campaigns[0];
    if (c) c.status = 'off';
  } else if (kind === 'payment') {
    const a = d.accounts.find((x) => x.media === 'kakao') ?? d.accounts.find((x) => x.balance >= 0);
    if (a) { a.autoCharge = 'failed'; a.balance = Math.round(a.avgDailySpend * 0.4); }
  } else if (kind === 'spike') {
    const w = DETECT_DEFAULTS.windowHours;
    d.mediaHourly = data.mediaHourly.map((r) => (r.date === data.today && r.media === 'google' && r.hour > data.currentHour - w
      ? { ...r, cost: Math.round(r.cost * 1.85), clicks: Math.round(r.clicks * 1.18), conversions: Math.round(r.conversions * 0.55 * 100) / 100, revenue: Math.round(r.revenue * 0.55) }
      : r));
  } else if (kind === 'creative') {
    cr = cr.map((c) => (c.id === 'cr_gfa_review' ? { ...c, status: 'rejected' as const, reason: '수치 주장(누적 리뷰 수) 근거 자료 미제출 — 매체 검수 반려' } : c));
  }
  return { data: d, creatives: cr };
}
const SCENARIO_RULES: Record<TestScenarioId, string[]> = {
  ad_off: ['campaign_off'],
  payment: ['account_payment'],
  spike: ['data_spike', 'anomaly_warn'],
  creative: ['creative_rejected'],
};
/** 주입 데이터로 엔진을 다시 돌려 새로 생긴 이슈만 반환 (isTest = true) */
/** 테스트 주입 이슈 id의 원래 탐지 id (…:test-<n> 접미사 제거) — 같은 시나리오 중복 주입 판정용 */
export function testBaseId(id: string): string {
  return id.replace(/:test-\d+$/, '');
}
export function detectTestIncidents(data: Dataset, kind: TestScenarioId, opts: DetectOptions & { atIso?: string; seq?: number } = {}): AlertIncident[] {
  const creatives = opts.creatives ?? DEMO_CREATIVES;
  const base = new Set(detectIncidents(data, { ...opts, creatives }).map((i) => i.id));
  const inj = injectScenario(data, creatives, kind);
  const found = detectIncidents(inj.data, { ...opts, creatives: inj.creatives }).filter((i) => !base.has(i.id) && SCENARIO_RULES[kind].includes(i.ruleId));
  const at = opts.atIso ?? data.generatedAt;
  const seq = opts.seq ?? 1;
  return found.map((i) => ({
    ...i,
    id: `${i.id}:test-${seq}`,
    title: `[테스트] ${i.title}`,
    isTest: true,
    detectedAt: at,
    occurredAt: msToKstIso(Date.parse(at) - 2 * 60_000),
    detectPath: `${i.detectPath} · 테스트 데이터 주입 (라이브 데모)`,
    timeline: [{ at, by: 'MILDO Alert', action: `테스트 이슈 감지 · ${i.timeline[0]?.action.replace(/^감지 · /, '') ?? '알림 발송'}` }],
  }));
}

/* ============================== 운영 요약 ============================== */

/** 이슈 유형 id — 다른 모듈(AD Pilot 등)이 만든 최소 필드 이슈는 ruleId로 유형을 찾는다 */
export function typeOf(i: Incident | AlertIncident): string {
  return (i as AlertIncident).typeId ?? RULES[i.ruleId]?.typeId ?? 'external';
}
/**
 * 반영(applied)된 충전 요청 합계 — targetId 'alert:account:<계정 id>:topup'
 * (이전 형식 'alert:<이슈 id>:topup'은 대상 계정명으로 매칭) · AD Pilot appliedTopup · Flow effectiveBalance와 같은 규칙
 */
export function appliedTopupFor(changes: readonly ChangeRequest[] | undefined, account: Pick<AdAccount, 'id' | 'name'>): number {
  let total = 0;
  for (const c of changes ?? []) {
    if (c.status !== 'applied' || typeof c.targetId !== 'string' || !/^alert:.+:topup$/.test(c.targetId)) continue;
    const mine = c.targetId === `alert:account:${account.id}:topup` || (!c.targetId.startsWith('alert:account:') && String(c.target ?? '').startsWith(`${account.name} `));
    if (!mine) continue;
    const add = Number(c.after) - Number(c.before);
    if (Number.isFinite(add) && add > 0) total += add;
  }
  return total;
}
/** 반영된 충전을 계정 잔액에 더한 데이터 (충전 반영이 없으면 같은 객체를 그대로 돌려준다 — 메모 · 인덱스 재사용) */
export function withAppliedTopups(data: Dataset, changes: readonly ChangeRequest[] | undefined): Dataset {
  let touched = false;
  const accounts = data.accounts.map((a) => {
    const add = a.balance >= 0 ? appliedTopupFor(changes, a) : 0;
    if (!add) return a;
    touched = true;
    return { ...a, balance: a.balance + add };
  });
  return touched ? { ...data, accounts } : data;
}

/** 보류 해제 요청(alert:<이슈>:release)이 반영(applied)된 이슈 id — AD Pilot openHoldIncidents와 같은 규칙 */
export function releasedIncidentIds(changes: readonly ChangeRequest[] = []): Set<string> {
  return new Set(
    changes
      .filter((c) => c.status === 'applied' && typeof c.targetId === 'string' && c.targetId.startsWith('alert:') && c.targetId.endsWith(':release'))
      .map((c) => c.targetId!.slice('alert:'.length, -':release'.length)),
  );
}
/** 자동 조정 보류 매체 — 열린 이슈 중 보류 해제가 반영되지 않은 것 (changes 생략 시 해제 반영을 보지 않음) */
export function heldMedia(incidents: readonly Incident[], changes?: readonly ChangeRequest[]): MediaId[] {
  const released = releasedIncidentIds(changes);
  return Array.from(new Set(incidents.filter((i) => i.status !== 'resolved' && !released.has(i.id)).map((i) => (i as AlertIncident).holdMedia).filter((m): m is MediaId => !!m)));
}
export function incidentRecurrence(i: Pick<AlertIncident, 'ruleId' | 'media'>, today: string): { count: number; dates: string[] } {
  const h = SLA_HISTORY.filter((x) => x.ruleId === i.ruleId && x.media === i.media && dayDiff(today, x.date) <= 30 && dayDiff(today, x.date) > 0);
  return { count: h.length, dates: h.map((x) => x.date) };
}
export function sevCounts(incidents: readonly Incident[]) {
  const open = incidents.filter((i) => i.status !== 'resolved');
  return { open: open.length, P1: open.filter((i) => i.severity === 'P1').length, P2: open.filter((i) => i.severity === 'P2').length, P3: open.filter((i) => i.severity === 'P3').length };
}
