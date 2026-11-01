/**
 * Reports 엔진 — Pro-board 분석 · 리포팅 + 데이터 시간표 + 절감 실측 (제안서 p.17–20).
 * 순수 함수만 둔다 (React import 금지). 모든 성과 수치는 Dataset(시연용 TEST DATA)에서 계산한다.
 *
 * 리포트 본문은 구조화된 Report(섹션 → 블록)로 만들고, 같은 객체에서
 *  - 문서형 마크다운(메일 · 미팅) : reportToMarkdown
 *  - 메신저형 미리보기(짧게)      : report.messenger
 *  - 규칙 엔진 해석(Brief)        : report.brief  (AI 미연결 시 해석 섹션 · 에이전트 오프라인 답변)
 * 을 함께 만든다. 섹션은 확정 팩트 / 반복 관측 패턴 / AI 해석 / 다음 액션 영역(zone)으로 구분한다.
 */
import type { ChangeRequest, Dataset, Incident, IntentId, Keyword, KeywordStats, MediaId, Severity } from '@/core/types';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, CAUSE_CANDIDATES, DATA_TIMETABLE, DECISION_MATRIX, INTENT_IDS, KEYWORD_TEST_RULES, MEDIA, MEDIA_IDS,
  ONBOARDING_PHASES, SALES_CHANNELS, SA_AUTOMATION_SCOPE, SA_CAMPAIGNS, SLA,
} from '@/data/constants';
import { mediaRows, previousRange, rangeOf, salesByChannel, totalsOf, keywordMetrics, type Totals } from '@/core/selectors';
import { addDays, daysInMonth, fmt, fmtDate, isOffDay, KR_HOLIDAYS, mean, metrics, monthKey, parseDate, sum, weekday, WEEKDAY_KO } from '@/core/util';
import type { Brief } from '@/ai/prompts';
// AD Pilot 조정 후보는 AD Pilot 엔진의 공개 API(generateBidProposals · BidProposal)로 읽는다 — 주간 리포트 개선 제안이 AD Pilot 화면과 같은 숫자를 쓰도록
import { generateBidProposals, type BidProposal } from '@/modules/adpilot/engine';
import {
  BUSINESS_HOURS, DAILY_SEND_MIN, EXTRA_HOLIDAYS, MODULE_ROLLOUT, MONTHLY_BUSINESS_DAY, PACE_CURVE_DAYS, REPORT_META, ROAS_JUDGED, SAVINGS_CONFIRM_DAYS, SAVINGS_FLOOR_PCT, TASK_MODULE,
  TASK_PHASE, TIMETABLE_META, WEEKLY_SEND, WEEKS_PER_YEAR, WEEK_MINUTES_PER_FTE, KICKOFF_ASSUMED, type ReportType,
} from './data';

/** 공용 KR_HOLIDAYS + 데이터 기간 2026 공휴일 보완 (data.ts EXTRA_HOLIDAYS) */
export const REPORT_HOLIDAYS: Record<string, string> = { ...EXTRA_HOLIDAYS, ...KR_HOLIDAYS };
/** isOffDay(공용) + 2026 공휴일 보완 */
export function offDayOf(date: string): { off: boolean; label: string } {
  const h = REPORT_HOLIDAYS[date];
  if (h) return { off: true, label: h };
  return isOffDay(date);
}

export type { ReportType } from './data';

/* ============================== 공통 타입 ============================== */

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'accent';
export type Level = 'danger' | 'warn' | 'info' | 'ok';
export type Cell = string | { text: string; tone?: Tone; badge?: boolean };
export interface Column { label: string; align?: 'left' | 'right' }
export interface Item { level: Level; title: string; text: string; basis?: string; route?: string; owner?: string }
export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'table'; columns: Column[]; rows: Cell[][]; caption?: string }
  | { kind: 'items'; items: Item[] }
  | { kind: 'stats'; items: { label: string; value: string; delta?: number; invert?: boolean; foot?: string }[] };
export type Zone = 'fact' | 'pattern' | 'ai' | 'action';
export const ZONE_LABEL: Record<Zone, string> = { fact: '확정 팩트', pattern: '반복 관측 패턴', ai: 'AI 해석', action: '다음 액션 · 개선 제안' };
export interface ReportSection { id: string; title: string; zone: Zone; blocks: Block[]; note?: string }
export interface Report {
  type: ReportType;
  title: string;
  subtitle: string;
  periodLabel: string;
  from?: string;
  to?: string;
  schedule: string;
  channel: string;
  nextSend: string;
  generatedAt: string;
  provisional?: boolean;
  empty?: boolean;
  sections: ReportSection[];
  /** 리포트 종류별 영역 제목 (기본 ZONE_LABEL) */
  zoneLabels?: Partial<Record<Zone, string>>;
  messenger: string;
  brief: Brief;
  /**
   * 코멘트 범위 — state.comments target = reports:<scope>:<sectionId>.
   * 일간 · 주간은 종류(데이터 기준일당 1건), 월간은 대상 월(monthly-2026-10), 이슈 알림은 이슈별(issue-<id>)로 나눠
   * 다른 월 · 다른 이슈의 섹션 피드백이 섞이지 않게 한다.
   */
  scope?: string;
}
export const zoneLabelOf = (r: Pick<Report, 'zoneLabels'>, z: Zone) => r.zoneLabels?.[z] ?? ZONE_LABEL[z];
export const scopeOf = (r: Pick<Report, 'type' | 'scope'>) => r.scope ?? r.type;

/** Alert가 만든 이슈(AlertIncident)의 선택 필드를 구조적으로만 읽는다 (alert 모듈 타입 의존 없음) */
export interface IssueLike extends Incident {
  basis?: string;
  page?: string;
  ruleLabel?: string;
  impactNote?: string;
  causes?: { label: string; score: number; basis: string }[];
  evidence?: { label: string; observed: number; baseline?: number; deltaPct?: number; unit?: string; threshold?: string; note?: string; baseLabel?: string }[];
  recurrence?: { count: number; dates: string[] };
}

/* ============================== 포맷 헬퍼 ============================== */

const fin = (v: number) => Number.isFinite(v);
export const won = (v: number) => (fin(v) ? `${fmt.krw(v)}원` : '—');
const pct1 = (v: number) => fmt.pct(v, 1);
const pct2 = (v: number) => fmt.pct(v, 2);
const delta = (v: number) => fmt.delta(v, 1);
const intf = (v: number) => fmt.int(v);
const dec1 = (v: number) => fmt.dec1(v);
const pp = (v: number) => (fin(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%p` : '—');
/** 배수 표기 (MER — MILDO Board와 같은 단위 '5.8배') */
const times = (v: number) => (fin(v) ? `${fmt.dec1(v)}배` : '—');
/** MER = 판매 채널 실매출 ÷ 광고비 (MILDO Board와 같은 정의) */
export const merOf = (sales: number, cost: number) => (cost > 0 && fin(sales) ? sales / cost : NaN);
const safeDiv = (a: number, b: number) => (b !== 0 && fin(a) && fin(b) ? a / b : NaN);
export const pctChange = (cur: number, prev: number) => metrics.pctChange(cur, prev);
const hhmmOf = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
export function clockOf(hourFloat: number): string {
  if (!fin(hourFloat)) return '—';
  const total = Math.round(hourFloat * 60);
  return hhmmOf(Math.max(0, Math.min(24 * 60 - 1, total)));
}
/** ISO(오프셋 포함) → KST 날짜 · 시각 (실행 환경 시간대와 무관) */
export function kst(iso: string): { date: string; time: string; ms: number } {
  const ms = Date.parse(iso);
  if (!fin(ms)) return { date: '', time: '', ms: NaN };
  const s = new Date(ms + 9 * 3600_000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16), ms };
}
function kstFromMs(ms: number): string {
  if (!fin(ms)) return '—';
  const s = new Date(ms + 9 * 3600_000).toISOString();
  return `${fmtDate(s.slice(0, 10))} ${s.slice(11, 16)}`;
}
/** 데이터 기준 시각(분) — generatedAt의 HH:MM, 없으면 currentHour:00 */
export function dataNowMinutes(d: Dataset): number {
  const m = d.generatedAt?.match(/T(\d{2}):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return (fin(d.currentHour) ? d.currentHour : 0) * 60;
}
export function dataStamp(d: Dataset): string {
  return `${fmtDate(d.today)} ${hhmmOf(dataNowMinutes(d))}`;
}
const intentName = (i: IntentId) => SA_CAMPAIGNS[i]?.name ?? i;

/* ============================== 영업일 ============================== */

export function isBusinessDay(date: string): boolean {
  return !offDayOf(date).off;
}
export function nextBusinessDay(date: string, includeSelf = false): string {
  let d = includeSelf ? date : addDays(date, 1);
  for (let i = 0; i < 30 && !isBusinessDay(d); i++) d = addDays(d, 1);
  return d;
}
/** 해당 월의 n번째 영업일 */
export function nthBusinessDay(month: string, n: number): string {
  let d = `${month}-01`;
  let count = 0;
  for (let i = 0; i < 40; i++) {
    if (isBusinessDay(d)) {
      count++;
      if (count >= n) return d;
    }
    d = addDays(d, 1);
  }
  return d;
}
export function nextMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export function prevMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`;
const rangeLabel = (from: string, to: string) => (from === to ? fmtDate(from) : `${fmtDate(from, false)}–${fmtDate(to, false)}`);

/** from부터 days일 안의 주말 · 공휴일 묶음 → 다음 영업일 09:30 브리핑 (p.44) */
export function upcomingOffBlocks(from: string, days: number): { start: string; end: string; days: number; labels: string[]; brief: string }[] {
  const out: { start: string; end: string; days: number; labels: string[]; brief: string }[] = [];
  let cur: { start: string; end: string; days: number; labels: string[] } | null = null;
  for (let i = 0; i <= days; i++) {
    const d = addDays(from, i);
    if (!isBusinessDay(d)) {
      if (!cur) cur = { start: d, end: d, days: 0, labels: [] };
      cur.end = d;
      cur.days++;
      const h = REPORT_HOLIDAYS[d];
      if (h && !cur.labels.includes(h)) cur.labels.push(h);
    } else if (cur) {
      out.push({ ...cur, brief: nextBusinessDay(cur.end) });
      cur = null;
    }
  }
  if (cur) out.push({ ...cur, brief: nextBusinessDay(cur.end) });
  return out;
}

/** 다음 발송 시각 (p.17 · p.18) */
export function nextSends(d: Dataset): Record<ReportType, { date: string; time: string; label: string }> {
  const now = dataNowMinutes(d);
  const dailyDate = now < DAILY_SEND_MIN ? d.today : addDays(d.today, 1);
  let wk = d.today;
  for (let i = 0; i < 8; i++) {
    const cand = addDays(d.today, i);
    if (weekday(cand) === WEEKLY_SEND.weekday && (i > 0 || now < WEEKLY_SEND.minutes)) { wk = cand; break; }
  }
  const weeklyDate = isBusinessDay(wk) ? wk : nextBusinessDay(wk);
  const monthlyThis = nthBusinessDay(monthKey(d.today), MONTHLY_BUSINESS_DAY);
  const monthlyDate = monthlyThis > d.today ? monthlyThis : nthBusinessDay(nextMonthKey(monthKey(d.today)), MONTHLY_BUSINESS_DAY);
  return {
    daily: { date: dailyDate, time: '08:00', label: `${fmtDate(dailyDate)} 08:00` },
    weekly: { date: weeklyDate, time: '10:00', label: `${fmtDate(weeklyDate)} 10:00` },
    monthly: { date: monthlyDate, time: '10:00', label: `${fmtDate(monthlyDate)} (익월 ${MONTHLY_BUSINESS_DAY}영업일)` },
    issue: { date: d.today, time: hhmmOf(now), label: '감지 즉시' },
  };
}

/* ============================== 집계 헬퍼 ============================== */

const totalsFor = (d: Dataset, from: string, to: string, media?: MediaId) => totalsOf(mediaRows(d, from, to, media));
const salesTotal = (d: Dataset, from: string, to: string) => sum(salesByChannel(d, from, to), (c) => c.revenue);
const hasDate = (d: Dataset, date: string) => d.dates.includes(date);
const newShareOf = (t: Totals) => safeDiv(t.newCustomers, t.conversions) * 100;

export interface KpiRow { id: string; label: string; cur: number; prev: number; cmp?: number; unit: 'krw' | 'roas' | 'pct2' | 'dec1' | 'int' | 'times'; invert?: boolean }
function fmtUnit(u: KpiRow['unit'], v: number) {
  return u === 'krw' ? won(v) : u === 'roas' ? fmt.roas(v) : u === 'pct2' ? pct2(v) : u === 'dec1' ? dec1(v) : u === 'times' ? times(v) : intf(v);
}
export function kpiRows(cur: Totals, prev: Totals, sales: number, salesPrev: number, cmp?: Totals, salesCmp?: number): KpiRow[] {
  return [
    { id: 'cost', label: '광고비', cur: cur.cost, prev: prev.cost, cmp: cmp?.cost, unit: 'krw' },
    { id: 'revenue', label: '광고 매출 (매체 귀속)', cur: cur.revenue, prev: prev.revenue, cmp: cmp?.revenue, unit: 'krw' },
    { id: 'roas', label: 'ROAS', cur: cur.roas, prev: prev.roas, cmp: cmp?.roas, unit: 'roas' },
    { id: 'conversions', label: '전환', cur: cur.conversions, prev: prev.conversions, cmp: cmp?.conversions, unit: 'dec1' },
    { id: 'cpa', label: 'CPA', cur: cur.cpa, prev: prev.cpa, cmp: cmp?.cpa, unit: 'krw', invert: true },
    { id: 'cvr', label: 'CVR', cur: cur.cvr, prev: prev.cvr, cmp: cmp?.cvr, unit: 'pct2' },
    { id: 'cac', label: '신규 고객 CAC', cur: cur.cac, prev: prev.cac, cmp: cmp?.cac, unit: 'krw', invert: true },
    { id: 'sales', label: '판매 채널 실매출', cur: sales, prev: salesPrev, cmp: salesCmp, unit: 'krw' },
    { id: 'mer', label: 'MER (실매출 ÷ 광고비)', cur: merOf(sales, cur.cost), prev: merOf(salesPrev, prev.cost), cmp: cmp && salesCmp !== undefined ? merOf(salesCmp, cmp.cost) : undefined, unit: 'times' },
  ];
}
function kpiTable(rows: KpiRow[], curLabel: string, prevLabel: string, cmpLabel?: string): Block {
  const cols: Column[] = [{ label: '지표' }, { label: curLabel, align: 'right' }, { label: `${prevLabel} 대비`, align: 'right' }];
  if (cmpLabel) cols.push({ label: `${cmpLabel} 대비`, align: 'right' });
  return {
    kind: 'table', columns: cols,
    rows: rows.map((r) => {
      const dv = (base?: number): Cell => {
        if (base === undefined) return '—';
        const ch = pctChange(r.cur, base);
        const good = r.invert ? ch < 0 : ch > 0;
        return { text: delta(ch), tone: !fin(ch) || Math.abs(ch) < 0.05 ? 'neutral' : good ? 'good' : 'critical' };
      };
      const row: Cell[] = [r.label, fmtUnit(r.unit, r.cur), dv(r.prev)];
      if (cmpLabel) row.push(dv(r.cmp));
      return row;
    }),
  };
}
function statsBlock(rows: KpiRow[], ids: string[]): Block {
  return {
    kind: 'stats',
    items: ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean).map((r) => ({ label: r.label, value: fmtUnit(r.unit, r.cur), delta: pctChange(r.cur, r.prev), invert: r.invert })),
  };
}

/* ============================== 탐지 · 점검 (리포트용) ============================== */

/**
 * 매체별 일 단위 변동 — p.47 지표별 기준선을 일 단위에 적용한다.
 *  광고비 · 클릭: '동요일 · 동시간 평균' → 최근 4주 같은 요일(7 · 14 · 21 · 28일 전) 평균
 *  전환: '최근 7일 동시간' → 직전 7일 일평균,  CPA · ROAS: '최근 7일 평균' → 직전 7일 합계 기준
 */
export interface MediaShift { media: MediaId; metric: string; label: string; cur: number; base: number; baseLabel: string; deltaPct: number; level: Level; threshold: string }
export function mediaDayShifts(d: Dataset, date: string): MediaShift[] {
  const wkDates = [1, 2, 3, 4].map((k) => addDays(date, -7 * k)).filter((x) => hasDate(d, x));
  const d7Dates = [1, 2, 3, 4, 5, 6, 7].map((k) => addDays(date, -k)).filter((x) => hasDate(d, x));
  if (!hasDate(d, date) || wkDates.length < 2 || d7Dates.length < 4) return [];
  const out: MediaShift[] = [];
  for (const m of MEDIA_IDS) {
    const cur = totalsFor(d, date, date, m);
    const wk = wkDates.map((x) => totalsFor(d, x, x, m));
    const d7 = d7Dates.map((x) => totalsFor(d, x, x, m));
    const base: Record<string, { v: number; label: string }> = {
      cost: { v: mean(wk.map((x) => x.cost)), label: `동요일 ${wk.length}주 평균` },
      clicks: { v: mean(wk.map((x) => x.clicks)), label: `동요일 ${wk.length}주 평균` },
      conversions: { v: mean(d7.map((x) => x.conversions)), label: `최근 ${d7.length}일 평균` },
      cpa: { v: safeDiv(sum(d7, (x) => x.cost), sum(d7, (x) => x.conversions)), label: `최근 ${d7.length}일 평균` },
      roas: { v: metrics.roas(sum(d7, (x) => x.revenue), sum(d7, (x) => x.cost)), label: `최근 ${d7.length}일 평균` },
    };
    for (const t of ANOMALY_THRESHOLDS) {
      const b = base[t.metric];
      if (!b) continue;
      const cv = t.metric === 'cpa' ? cur.cpa : t.metric === 'roas' ? cur.roas : (cur as unknown as Record<string, number>)[t.metric];
      const dp = pctChange(cv, b.v);
      const v = t.direction === 'up' ? dp : t.direction === 'down' ? -dp : Math.abs(dp);
      const level: Level = !fin(v) ? 'ok' : v >= t.dangerPct ? 'danger' : v >= t.warnPct ? 'warn' : 'ok';
      const sign = t.direction === 'both' ? '±' : t.direction === 'up' ? '+' : '−';
      out.push({ media: m, metric: t.metric, label: t.label, cur: cv, base: b.v, baseLabel: b.label, deltaPct: dp, level, threshold: `주의 ${sign}${t.warnPct}% · 위험 ${sign}${t.dangerPct}%` });
    }
  }
  return out;
}

/**
 * 급변 신호 → 원인 후보 1순위 (p.47 원인 후보 4종, 규칙 엔진 순위 · 확정 원인 아님)
 *  CPC 상승(클릭 유지) → 경쟁사 입찰 상승 / CPC 급락 → 매체 장애 · 집계 지연 /
 *  CPC 정상 · 전환만 하락 → 품절 랜딩이면 랜딩 오류 · 품절, 아니면 가격 · 프로모션 변경
 */
export function spikeCause(s: Pick<KeywordSpike, 'cpcDelta' | 'convDelta' | 'clickDelta' | 'cpcHit' | 'convHit'>, soldout: boolean): { label: string; basis: string } {
  const [competitor, landing, price, media] = CAUSE_CANDIDATES;
  if (s.cpcHit && s.cpcDelta > 0) return { label: competitor, basis: `CPC ${delta(s.cpcDelta)} · 일 클릭 ${delta(s.clickDelta)} — 클릭 대비 단가 상승` };
  if (s.cpcHit && s.cpcDelta < 0) return { label: media, basis: `CPC ${delta(s.cpcDelta)} — 단가 급락은 집계 지연 · 매체 장애 신호` };
  if (s.convHit && soldout) return { label: landing, basis: `일 전환 ${delta(s.convDelta)} · 랜딩 옵션 품절` };
  if (s.convHit) return { label: price, basis: `일 전환 ${delta(s.convDelta)} · CPC ${delta(s.cpcDelta)} (단가 변화 없이 전환만 하락)` };
  return { label: '—', basis: '기준 이내' };
}

/** 키워드 최근 n일 CPC · 전환 급변 (p.14 성과 급변 ±50% → 자동 조정 보류) */
export interface KeywordSpike {
  keyword: Keyword; cpcRecent: number; cpcBase: number; cpcDelta: number; convRecent: number; convBase: number; convDelta: number; clickDelta: number;
  cpcHit: boolean; convHit: boolean; flagged: boolean; reason: string; cause: { label: string; basis: string };
}
export function keywordSpikes(d: Dataset, recentDays = 3, holdPct: number = AD_PILOT.anomalyHoldPct): KeywordSpike[] {
  const out: KeywordSpike[] = [];
  const soldoutIds = new Set(soldoutLandings(d).map((s) => s.keyword.id));
  for (const k of d.keywords) {
    const daily = k.daily ?? [];
    if (daily.length < recentDays + 4) continue;
    const recent = daily.slice(-recentDays);
    const base = daily.slice(0, -recentDays).filter((x) => x.impressions > 0);
    if (base.length < 4) continue;
    const cpcRecent = metrics.cpc(sum(recent, (x) => x.cost), sum(recent, (x) => x.clicks));
    const cpcBase = metrics.cpc(sum(base, (x) => x.cost), sum(base, (x) => x.clicks));
    const convRecent = sum(recent, (x) => x.conversions) / recent.length;
    const convBase = sum(base, (x) => x.conversions) / base.length;
    const cpcDelta = pctChange(cpcRecent, cpcBase);
    const convDelta = pctChange(convRecent, convBase);
    const baseConvTotal = sum(base, (x) => x.conversions);
    const cpcHit = fin(cpcDelta) && Math.abs(cpcDelta) >= holdPct && sum(recent, (x) => x.clicks) >= 10;
    const convHit = fin(convDelta) && Math.abs(convDelta) >= holdPct && baseConvTotal >= AD_PILOT.minConversionsForDown;
    const clickDelta = pctChange(sum(recent, (x) => x.clicks) / recent.length, sum(base, (x) => x.clicks) / base.length);
    const parts: string[] = [];
    if (cpcHit) parts.push(`CPC ${delta(cpcDelta)}`);
    if (convHit) parts.push(`일 전환 ${delta(convDelta)}`);
    const sig = { cpcDelta, convDelta, clickDelta, cpcHit, convHit };
    out.push({ keyword: k, cpcRecent, cpcBase, cpcDelta, convRecent, convBase, convDelta, clickDelta, cpcHit, convHit, flagged: cpcHit || convHit, reason: parts.join(' · '), cause: spikeCause(sig, soldoutIds.has(k.id)) });
  }
  return out;
}

/** 계정 · 결제 · 권한 점검 (p.44 잔액 1일치 미만 · 자동충전 실패, p.50 실명 계정) */
export function accountChecks(d: Dataset): Item[] {
  const out: Item[] = [];
  for (const a of d.accounts) {
    const runway = a.balance >= 0 && a.avgDailySpend > 0 ? a.balance / a.avgDailySpend : null;
    const low = runway !== null && runway < 1;
    if (low || a.autoCharge === 'failed') {
      const parts: string[] = [];
      if (runway !== null) parts.push(`잔액 ${won(a.balance)} ÷ 일 평균 소진 ${won(a.avgDailySpend)} = ${dec1(runway)}일`);
      if (a.autoCharge === 'failed') parts.push('자동충전 실패');
      out.push({ level: 'danger', title: `${a.name} 잔액 · 결제`, text: parts.join(' · '), basis: '잔액 1일치 미만 · 자동충전 실패 → P1 (p.44)', route: 'alert', owner: 'PM → 수면밀도 충전 승인' });
    } else if (runway !== null && runway < 3 && a.autoCharge !== 'ok') {
      out.push({ level: 'warn', title: `${a.name} 잔액`, text: `잔액 ${dec1(runway)}일치 · 자동충전 ${a.autoCharge === 'off' ? '미설정' : a.autoCharge}`, basis: '잔액 3일치 미만 · 자동충전 없음 (운영 가정)', route: 'alert', owner: '담당 AE' });
    }
    if (a.status !== 'active') {
      out.push({ level: a.status === 'restricted' ? 'danger' : 'warn', title: `${a.name} 계정 상태`, text: a.status === 'review' ? '검수 · 확인 필요 상태' : '제재 · 제한 상태', basis: '계정 제재 · 검수 보류 (p.44)', route: 'alert', owner: 'PM' });
    }
    for (const p of a.permissions) {
      if (!p.realName) out.push({ level: 'warn', title: `${a.name} 비실명 권한`, text: `${p.user} (${p.role}) · 마지막 로그인 ${p.lastLogin}`, basis: '접근 권한은 담당자 실명 계정 · 교체 시 즉시 회수 (p.50)', route: 'alert', owner: 'PM → 수면밀도 통보' });
    }
  }
  return out;
}

/** 품절 옵션으로 랜딩되는 키워드 (p.45 품절 · 옵션 품절 랜딩) */
export function soldoutLandings(d: Dataset): { keyword: Keyword; product: string; option: string; cost14: number }[] {
  const out: { keyword: Keyword; product: string; option: string; cost14: number }[] = [];
  for (const p of d.products) {
    for (const o of p.options) {
      if (o.inStock) continue;
      for (const k of d.keywords) {
        if (k.status === 'off') continue;
        if (k.landing === p.landing && k.text.includes(o.label)) out.push({ keyword: k, product: p.name, option: o.label, cost14: k.last14.cost });
      }
    }
  }
  return out;
}

/* ---------- 시간대 프로필 · 캠페인 일 예산 예상 마감 ---------- */

type HourIdx = Map<string, { cost: number; revenue: number; conversions: number; clicks: number }>;
function hourIndex(d: Dataset): HourIdx {
  const m: HourIdx = new Map();
  for (const r of d.mediaHourly) m.set(`${r.date}|${r.media}|${r.hour}`, r);
  return m;
}
/**
 * 매체 시간대 비중 (24시간 합 = 1) — 최근 PACE_CURVE_DAYS(28)일(오늘 제외) 시간대별 합 ÷ 전체 합, 데이터가 없으면 균등.
 * MILDO Board · AD Pilot · MILDO Alert의 시간대 소진 곡선과 같은 기간 · 같은 산식 (예상 마감 시각이 화면 간 일치).
 */
export function hourProfile(d: Dataset, media: MediaId, field: 'cost' | 'revenue' = 'cost', days: number = PACE_CURVE_DAYS): number[] {
  const from = addDays(d.today, -days);
  const byH = new Array<number>(24).fill(0);
  let tot = 0;
  for (const r of d.mediaHourly) {
    if (r.media !== media || r.date >= d.today || r.date < from || !(r.hour >= 0 && r.hour <= 23)) continue;
    const v = fin(r[field]) ? Math.max(0, r[field]) : 0;
    byH[r.hour] += v;
    tot += v;
  }
  return tot > 0 ? byH.map((v) => v / tot) : Array.from({ length: 24 }, () => 1 / 24);
}
export interface CampaignForecast { id: string; name: string; media: MediaId; dailyBudget: number; spentToday: number; pace: number; expectedShare: number; exhaustHour: number | null; lostRevShare: number; flag: boolean }
/**
 * 시간대 소진 곡선 기준 예상 마감 시각 · 미노출 구간 평소 매출 비중 (≥ 20%면 조기 소진 경고).
 * 판정 대상은 상태 'on' 캠페인 — MILDO Alert 예산 소진 예측과 같은 기준.
 */
export function campaignForecasts(d: Dataset, lostShareFlag = 0.2): CampaignForecast[] {
  const prof = new Map<MediaId, { cost: number[]; rev: number[] }>();
  return d.campaigns.map((c) => {
    if (!prof.has(c.media)) prof.set(c.media, { cost: hourProfile(d, c.media, 'cost'), rev: hourProfile(d, c.media, 'revenue') });
    const p = prof.get(c.media)!;
    const h = Math.max(0, Math.min(23, c.hourOfData));
    const expectedShare = sum(p.cost.slice(0, h + 1), (x) => x);
    const spentShare = c.dailyBudget > 0 ? c.spentToday / c.dailyBudget : NaN;
    const pace = expectedShare > 0 && fin(spentShare) ? spentShare / expectedShare : NaN;
    let exhaustHour: number | null = null;
    let lostRevShare = 0;
    if (fin(pace) && pace > 1 && c.status === 'on') {
      let cum = expectedShare;
      for (let hh = h + 1; hh < 24; hh++) {
        const next = cum + p.cost[hh];
        if (next * pace >= 1) {
          const need = 1 / pace - cum;
          const frac = p.cost[hh] > 0 ? Math.max(0, Math.min(1, need / p.cost[hh])) : 0;
          exhaustHour = hh + frac;
          lostRevShare = (1 - frac) * p.rev[hh] + sum(p.rev.slice(hh + 1), (x) => x);
          break;
        }
        cum = next;
      }
    }
    return { id: c.id, name: c.name, media: c.media, dailyBudget: c.dailyBudget, spentToday: c.spentToday, pace, expectedShare, exhaustHour, lostRevShare, flag: exhaustHour !== null && lostRevShare >= lostShareFlag };
  });
}

/**
 * 11:00 오전 점검 — 당일 0~uptoHour 누적을 p.47 기준선과 비교한다.
 * 광고비: 최근 4주 동요일 같은 시간대 누적 평균, 전환: 최근 7일 같은 시간대 누적 평균.
 */
export interface IntradayRow { media: MediaId; cost: number; costBase: number; costDelta: number; conv: number; convBase: number; convDelta: number; level: Level }
export function intradayCheck(d: Dataset, uptoHour: number): IntradayRow[] {
  const idx = hourIndex(d);
  const H = Math.max(0, Math.min(d.currentHour, uptoHour));
  const costT = ANOMALY_THRESHOLDS.find((t) => t.metric === 'cost')!;
  const convT = ANOMALY_THRESHOLDS.find((t) => t.metric === 'conversions')!;
  const agg = (date: string, m: MediaId) => {
    let cost = 0, conv = 0;
    for (let h = 0; h <= H; h++) {
      const r = idx.get(`${date}|${m}|${h}`);
      if (!r) return null;
      cost += r.cost; conv += r.conversions;
    }
    return { cost, conv };
  };
  return MEDIA_IDS.map((m) => {
    const cur = agg(d.today, m);
    const ok = (x: { cost: number; conv: number } | null): x is { cost: number; conv: number } => !!x;
    const wkBases = [1, 2, 3, 4].map((k) => agg(addDays(d.today, -7 * k), m)).filter(ok);
    const d7Bases = [1, 2, 3, 4, 5, 6, 7].map((k) => agg(addDays(d.today, -k), m)).filter(ok);
    const costBase = wkBases.length ? mean(wkBases.map((b) => b.cost)) : NaN;
    const convBase = d7Bases.length ? mean(d7Bases.map((b) => b.conv)) : NaN;
    const costDelta = cur ? pctChange(cur.cost, costBase) : NaN;
    const convDelta = cur && convBase >= 1 ? pctChange(cur.conv, convBase) : NaN;
    const cl = fin(costDelta) ? (Math.abs(costDelta) >= costT.dangerPct ? 2 : Math.abs(costDelta) >= costT.warnPct ? 1 : 0) : 0;
    const vl = fin(convDelta) ? (-convDelta >= convT.dangerPct ? 2 : -convDelta >= convT.warnPct ? 1 : 0) : 0;
    const lv = Math.max(cl, vl);
    return { media: m, cost: cur?.cost ?? NaN, costBase, costDelta, conv: cur?.conv ?? NaN, convBase, convDelta, level: lv === 2 ? 'danger' : lv === 1 ? 'warn' : 'ok' };
  });
}

/** 07:00 수집 · 검증: 대상일 행 수 · 시간별 합계 ↔ 일 합계 대조 */
export function dataValidation(d: Dataset, date: string, tolerancePct = 5) {
  const mediaRowsN = d.mediaDaily.filter((r) => r.date === date).length;
  const salesRowsN = d.salesDaily.filter((r) => r.date === date).length;
  const missingMedia = MEDIA_IDS.filter((m) => !d.mediaDaily.some((r) => r.date === date && r.media === m));
  let maxDiff = 0;
  let hourlyChecked = 0;
  for (const m of MEDIA_IDS) {
    const day = d.mediaDaily.find((r) => r.date === date && r.media === m);
    const hrs = d.mediaHourly.filter((r) => r.date === date && r.media === m);
    if (!day || !hrs.length || day.cost <= 0) continue;
    hourlyChecked++;
    maxDiff = Math.max(maxDiff, Math.abs(pctChange(sum(hrs, (r) => r.cost), day.cost)));
  }
  const ok = mediaRowsN >= MEDIA_IDS.length && salesRowsN >= 1 && maxDiff <= tolerancePct;
  return { date, mediaRows: mediaRowsN, salesRows: salesRowsN, missingMedia, hourlyChecked, maxDiffPct: maxDiff, tolerancePct, ok };
}

/* ---------- 패턴 ---------- */

export function weekdayPattern(d: Dataset, to: string, days = 28) {
  const from = addDays(to, -(days - 1));
  const by = Array.from({ length: 7 }, () => ({ cost: 0, revenue: 0, dates: new Set<string>() }));
  for (const r of mediaRows(d, from, to)) {
    const w = weekday(r.date);
    by[w].cost += r.cost; by[w].revenue += r.revenue; by[w].dates.add(r.date);
  }
  const perDay = by.map((b) => (b.dates.size ? b.revenue / b.dates.size : NaN));
  const overall = mean(perDay.filter(fin));
  return by.map((b, w) => ({ weekday: w, label: WEEKDAY_KO[w], days: b.dates.size, revenuePerDay: perDay[w], roas: metrics.roas(b.revenue, b.cost), index: overall > 0 ? (perDay[w] / overall) * 100 : NaN }));
}
/** 최근 days일(오늘 제외) 시간대 [fromH, toH] 전환 비중 */
export function hourShare(d: Dataset, fromH: number, toH: number, days = 28): number {
  const from = addDays(d.today, -days);
  let tot = 0, part = 0;
  for (const r of d.mediaHourly) {
    if (r.date >= d.today || r.date < from) continue;
    tot += r.conversions;
    if (r.hour >= fromH && r.hour <= toH) part += r.conversions;
  }
  return tot > 0 ? part / tot : NaN;
}
/** 최근 weeks주 연속 목표 ROAS 미만 매체 */
export function belowTargetStreak(d: Dataset, end: string, weeks = 4, target: number = AD_PILOT.targetRoas) {
  return MEDIA_IDS.map((m) => {
    const list: number[] = [];
    for (let w = 0; w < weeks; w++) {
      const to = addDays(end, -7 * w);
      const from = addDays(to, -6);
      if (!hasDate(d, from)) break;
      list.push(totalsFor(d, from, to, m).roas);
    }
    let streak = 0;
    for (const v of list) { if (fin(v) && v < target) streak++; else break; }
    return { media: m, streak, weeks: list.length, latest: list[0] ?? NaN };
  });
}
export function targetHitDays(d: Dataset, from: string, to: string, target: number = AD_PILOT.targetRoas) {
  let days = 0, hits = 0;
  for (const date of d.dates) {
    if (date < from || date > to) continue;
    days++;
    if (totalsFor(d, date, date).roas >= target) hits++;
  }
  return { days, hits };
}

/* ---------- 키워드 테스트 판정 (p.26) ---------- */

export type TestVerdict = 'expand' | 'keep' | 'exclude' | 'hold';
export const VERDICT_LABEL: Record<TestVerdict, string> = { expand: '확장', keep: '유지', exclude: '제외', hold: '판정 보류' };
export const VERDICT_TONE: Record<TestVerdict, Tone> = { expand: 'good', keep: 'warning', exclude: 'critical', hold: 'neutral' };
export interface TestJudgement { keyword: Keyword; days: number; stats: KeywordStats; roas: number; ratioPct: number; verdict: TestVerdict; basis: string; lowVolume: boolean; action: string }
export function judgeKeywordTest(k: Keyword, cfg: { targetRoas?: number; minDays?: number; minClicks?: number; expandAtPct?: number; keepFromPct?: number } = {}): TestJudgement {
  const target = cfg.targetRoas ?? AD_PILOT.targetRoas;
  const minDays = cfg.minDays ?? KEYWORD_TEST_RULES.minDays;
  const minClicks = cfg.minClicks ?? KEYWORD_TEST_RULES.minClicks;
  const expandAt = cfg.expandAtPct ?? KEYWORD_TEST_RULES.expandAtPct;
  const keepFrom = cfg.keepFromPct ?? KEYWORD_TEST_RULES.keepFromPct;
  const s = k.last14;
  const days = (k.daily ?? []).filter((x) => x.impressions > 0).length;
  const roas = metrics.roas(s.revenue, s.cost);
  const ratioPct = target > 0 && fin(roas) ? (roas / target) * 100 : NaN;
  const sampleOk = days >= minDays || s.clicks >= minClicks;
  const lowVolume = s.clicks < minClicks;
  let verdict: TestVerdict;
  let basis: string;
  let action: string;
  if (!sampleOk) {
    verdict = 'hold';
    basis = `표본 부족 · 집행 ${days}일 · 클릭 ${intf(s.clicks)} (기준 ${minDays}일 또는 클릭 ${minClicks})`;
    action = '테스트 지속 · 기준 도달 시 재판정';
  } else if (!(s.conversions > 0)) {
    verdict = 'exclude';
    basis = `전환 없음 · ${days}일 · 클릭 ${intf(s.clicks)}`;
    action = '제외 키워드 등록 · 사유 기록';
  } else if (ratioPct >= expandAt) {
    verdict = 'expand';
    basis = `목표 ROAS ${target}% 대비 ${fmt.roas(ratioPct)} (확장 ≥ ${expandAt}%)`;
    action = '본 그룹 이관 · 연관 키워드 추가 발굴';
  } else if (ratioPct >= keepFrom) {
    verdict = 'keep';
    basis = `목표 ROAS ${target}% 대비 ${fmt.roas(ratioPct)} (유지 ${keepFrom}~${expandAt}%)`;
    action = '입찰 · 랜딩 조정 후 재테스트';
  } else {
    verdict = 'exclude';
    basis = `목표 ROAS ${target}% 대비 ${fmt.roas(ratioPct)} (제외 < ${keepFrom}%)`;
    action = '제외 키워드 등록 · 사유 기록';
  }
  return { keyword: k, days, stats: s, roas, ratioPct, verdict, basis, lowVolume, action };
}

/** AD Pilot 규칙(p.14) 중 리포트 개선 제안에 쓰는 후보 — 판정 근거 수치 포함 */
/**
 * 규칙 엔진 보조 후보 (AD Pilot 엔진을 쓸 수 없을 때의 대체) — 일 조정 폭 상한(p.14)을 넘지 않게 10원 단위로 내림/올림한다.
 * 주간 리포트 개선 제안은 adPilotSummary(AD Pilot 엔진 결과)를 우선 사용한다.
 */
export function bidCandidates(d: Dataset) {
  const spikes = new Set(keywordSpikes(d).filter((s) => s.flagged).map((s) => s.keyword.id));
  const up: { k: Keyword; roas: number; target: number; lost: number; newBid: number; capPct: number }[] = [];
  const down: { k: Keyword; roas: number; prevRoas: number; target: number; conv: number; newBid: number }[] = [];
  for (const k of d.keywords) {
    if (k.status !== 'on' || spikes.has(k.id)) continue;
    const m = keywordMetrics(k);
    const target = k.isBrand ? AD_PILOT.brandTargetRoas : AD_PILOT.targetRoas;
    const capPct = AD_PILOT.dailyChangeCapPct;
    if (fin(m.roas) && m.roas >= target * AD_PILOT.highEfficiencyRoasRatio && k.impressionShareLost >= AD_PILOT.lostShareTrigger && k.bid < k.maxBid) {
      const newBid = Math.min(k.maxBid, Math.floor((k.bid * (1 + capPct / 100)) / 10) * 10);
      up.push({ k, roas: m.roas, target, lost: k.impressionShareLost, newBid, capPct: pctChange(newBid, k.bid) });
    } else if (fin(m.roas) && m.roas < target && fin(m.prevRoas) && m.prevRoas < target && k.last14.conversions >= AD_PILOT.minConversionsForDown) {
      down.push({ k, roas: m.roas, prevRoas: m.prevRoas, target, conv: k.last14.conversions, newBid: Math.ceil((k.bid * (1 - capPct / 100)) / 10) * 10 });
    }
  }
  up.sort((a, b) => b.lost - a.lost);
  down.sort((a, b) => a.roas - b.roas);
  return { up, down, spikes: keywordSpikes(d).filter((s) => s.flagged) };
}

/** AD Pilot 조정 후보 요약 — AD Pilot 화면 · 승인 요청과 같은 숫자 (generateBidProposals, p.14) */
export interface AdPilotSummary {
  source: 'adpilot' | 'rule';
  up: BidProposal[]; down: BidProposal[]; hold: BidProposal[]; shift: BidProposal[]; tests: BidProposal[];
}
export function adPilotSummary(d: Dataset): AdPilotSummary {
  let list: BidProposal[] | null = null;
  try {
    list = generateBidProposals(d) as BidProposal[];
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) {
    // AD Pilot 엔진 오류 시 규칙 엔진 보조 후보로 대체 (같은 p.14 기준)
    const bc = bidCandidates(d);
    const mk = (k: Keyword, action: BidProposal['action'], after: number, rule: string, reason: string): BidProposal => ({
      id: `rule_${action}_${k.id}`, keywordId: k.id, keyword: k.text, rule, action, before: k.bid, after, changePct: Math.round(pctChange(after, k.bid) * 10) / 10, reason, expected: '', guard: [],
    });
    return {
      source: 'rule',
      up: bc.up.map((u) => mk(u.k, 'bid_up', u.newBid, '고효율 · 노출 손실', `ROAS ${fmt.roas(u.roas)} · 노출 손실 ${pct1(u.lost * 100)}`)),
      down: bc.down.map((u) => mk(u.k, 'bid_down', u.newBid, '목표 미달', `ROAS ${fmt.roas(u.roas)} (직전 ${fmt.roas(u.prevRoas)})`)),
      hold: bc.spikes.map((s) => mk(s.keyword, 'hold', s.keyword.bid, '성과 급변 · 데이터 이상', s.reason)),
      shift: [], tests: termCandidates(d).map((t) => ({ id: `rule_test_${t.term}`, keywordId: '', keyword: t.term, rule: '검색어 후보', action: 'test_candidate' as const, before: 0, after: 0, changePct: 0, reason: '', expected: '', guard: [] })),
    };
  }
  const by = (a: BidProposal['action']) => list!.filter((p) => p.action === a);
  return { source: 'adpilot', up: by('bid_up'), down: by('bid_down'), hold: by('hold'), shift: by('budget_shift'), tests: by('test_candidate') };
}

/** 검색어 보고서 미등록 + 전환 발생 → 테스트 그룹 등록 후보 (p.14, p.26) */
export function termCandidates(d: Dataset) {
  return d.searchTerms
    .filter((t) => !t.registered && t.conversions > 0)
    .map((t) => ({ ...t, roas: metrics.roas(t.revenue, t.cost), cpa: metrics.cpa(t.cost, t.conversions) }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** 4주 연속 목표 미달 매체 문장 — 판단 지표가 ROAS가 아닌 매체는 그 지표를 병기 (p.37) */
function streakSentence(media: MediaId[], target: number): string {
  const nonRoas = media.filter((m) => !ROAS_JUDGED[m]);
  const roasJudged = media.filter((m) => ROAS_JUDGED[m]);
  const parts = [`${media.map((m) => MEDIA[m].short).join(' · ')}: 4주 연속 주간 ROAS 목표 ${target}% 미만.`];
  if (nonRoas.length) parts.push(`이 중 ${nonRoas.map((m) => `${MEDIA[m].short}(${MEDIA[m].judgeMetric})`).join(', ')}는 판단 지표가 ROAS가 아니므로(p.37) ROAS 단독 축소 판단 대상이 아닙니다.`);
  if (roasJudged.length) parts.push(`${roasJudged.map((m) => MEDIA[m].short).join(' · ')}는 ROAS가 판단 지표이므로 입찰 · 예산 조정 검토 대상입니다.`);
  return parts.join(' ');
}

/* ============================== 일간 리포트 ============================== */

export interface ReportOptions { incidents?: IssueLike[]; month?: string; selectedIssueId?: string | null }

function emptyReport(type: ReportType, d: Dataset, reason: string): Report {
  const meta = REPORT_META[type];
  return {
    type, title: `${meta.name} 리포트`, subtitle: reason, periodLabel: '—', schedule: meta.when, channel: meta.channel,
    nextSend: nextSends(d)[type].label, generatedAt: dataStamp(d), empty: true,
    sections: [{ id: 'empty', title: '데이터 없음', zone: 'fact', blocks: [{ kind: 'p', text: reason }] }],
    messenger: `[MILDO ${meta.name}] ${reason}`,
    brief: { title: `${meta.name} 리포트`, facts: [reason], patterns: [], interpretation: [], conditions: [], counter: [], actions: ['데이터 수집 상태를 07:00 수집 · 검증 단계에서 확인합니다.'] },
  };
}

export function buildDailyReport(d: Dataset, opts: ReportOptions = {}): Report {
  const y = rangeOf(d, 'yesterday');
  if (!hasDate(d, y.from)) return emptyReport('daily', d, `전일(${y.from}) 데이터가 수집되지 않았습니다.`);
  const db = previousRange(y);
  const wk = { from: addDays(y.from, -7), to: addDays(y.to, -7) };
  const cur = totalsFor(d, y.from, y.to);
  const prev = totalsFor(d, db.from, db.to);
  const wkT = totalsFor(d, wk.from, wk.to);
  const sales = salesTotal(d, y.from, y.to);
  const rows = kpiRows(cur, prev, sales, salesTotal(d, db.from, db.to), wkT, salesTotal(d, wk.from, wk.to));
  const target = AD_PILOT.targetRoas;

  // 매체별
  const mediaTable: Block = {
    kind: 'table',
    columns: [{ label: '매체' }, { label: '역할 (p.37)' }, { label: '광고비', align: 'right' }, { label: '비중', align: 'right' }, { label: 'ROAS', align: 'right' }, { label: 'CPA', align: 'right' }, { label: 'CVR', align: 'right' }, { label: '신규 비중', align: 'right' }, { label: '광고비 동요일 대비', align: 'right' }, { label: '판단 지표' }],
    rows: MEDIA_IDS.map((m) => {
      const t = totalsFor(d, y.from, y.to, m);
      const w = totalsFor(d, wk.from, wk.to, m);
      const ch = pctChange(t.cost, w.cost);
      return [MEDIA[m].name, MEDIA[m].role, won(t.cost), pct1(safeDiv(t.cost, cur.cost) * 100), fmt.roas(t.roas), won(t.cpa), pct2(t.cvr), pct1(newShareOf(t)),
        { text: delta(ch), tone: !fin(ch) || Math.abs(ch) < 30 ? 'neutral' : 'warning' }, MEDIA[m].judgeMetric];
    }),
  };

  // 예산 소진 (월 누적, 전일 마감 기준)
  const mk = monthKey(y.to);
  const dim = daysInMonth(y.to);
  const dom = Number(y.to.slice(8, 10));
  const expectedPct = (dom / dim) * 100;
  const pacing = MEDIA_IDS.map((m) => {
    const budget = MEDIA[m].annualBudget / 12;
    const spent = sum(d.mediaDaily.filter((r) => r.media === m && monthKey(r.date) === mk && r.date <= y.to), (r) => r.cost);
    const pace = safeDiv(spent, budget) * 100;
    const projected = dom > 0 ? (spent / dom) * dim : NaN;
    const projPct = safeDiv(projected, budget) * 100;
    return { m, budget, spent, pace, projPct, gap: pace - expectedPct };
  });
  const totBudget = sum(pacing, (p) => p.budget);
  const totSpent = sum(pacing, (p) => p.spent);
  const totPace = safeDiv(totSpent, totBudget) * 100;
  const pacingTable: Block = {
    kind: 'table',
    columns: [{ label: '매체' }, { label: '월 예산 (연 배분/12)', align: 'right' }, { label: '누적 소진', align: 'right' }, { label: '소진율', align: 'right' }, { label: `기대 ${pct1(expectedPct)} 대비`, align: 'right' }, { label: '월말 예상 (기준 90~105%)', align: 'right' }],
    rows: [
      ...pacing.map((p): Cell[] => [MEDIA[p.m].name, won(p.budget), won(p.spent), pct1(p.pace), { text: pp(p.gap), tone: Math.abs(p.gap) >= 5 ? 'warning' : 'neutral' },
        { text: pct1(p.projPct), tone: p.projPct > 105 ? 'warning' : p.projPct < 90 ? 'warning' : 'good', badge: true }]),
      ['합계', won(totBudget), won(totSpent), pct1(totPace), pp(totPace - expectedPct), pct1(safeDiv(totSpent / Math.max(1, dom) * dim, totBudget) * 100)],
    ],
    caption: `${fmtDate(`${mk}-01`, false)}–${fmtDate(y.to, false)} 마감분 · 월말 예상 = 일평균 × ${dim}일 · 기준 90~105% (운영 가정)`,
  };

  // 주요 변동
  const shifts = mediaDayShifts(d, y.from).filter((s) => s.level !== 'ok');
  const spikes = keywordSpikes(d).filter((s) => s.flagged);
  const accounts = accountChecks(d);
  const soldout = soldoutLandings(d);
  // 같은 매체의 지표 변동은 한 항목으로 묶는다 (위험 지표가 있으면 위험)
  const shiftVal = (s: MediaShift, v: number) => (s.metric === 'roas' ? fmt.roas(v) : s.metric === 'cpa' || s.metric === 'cost' ? won(v) : dec1(v));
  const shiftMedia = MEDIA_IDS.filter((m) => shifts.some((s) => s.media === m));
  const changeItems: Item[] = [
    ...shiftMedia.map((m): Item => {
      const list = shifts.filter((s) => s.media === m);
      return {
        level: list.some((s) => s.level === 'danger') ? 'danger' : 'warn',
        title: `${MEDIA[m].name} ${list.map((s) => `${s.label} ${delta(s.deltaPct)}`).join(' · ')}`,
        text: `${fmtDate(y.from)} ${list.map((s) => `${s.label} ${shiftVal(s, s.cur)} (${s.baseLabel} ${shiftVal(s, s.base)})`).join(' · ')}${ROAS_JUDGED[m] ? '' : ` · 판단 지표 ${MEDIA[m].judgeMetric} (p.37)`}`,
        basis: `${list.map((s) => `${s.label} ${s.threshold}`).join(' / ')} (p.47, 일 단위 적용)`, route: 'alert', owner: '담당 AE',
      };
    }),
    ...spikes.map((s): Item => ({
      level: 'warn', title: `'${s.keyword.text}' 최근 3일 ${s.reason}`,
      text: `CPC ${won(s.cpcRecent)} (직전 ${won(s.cpcBase)}) · 일 전환 ${dec1(s.convRecent)} (직전 ${dec1(s.convBase)}) → AD Pilot 자동 조정 보류 · 원인 후보 1순위 ${s.cause.label} (${s.cause.basis}, 규칙 엔진 순위)`,
      basis: `성과 급변 ±${AD_PILOT.anomalyHoldPct}% → 자동 조정 보류 · 알림 (p.14)`, route: 'adpilot', owner: '담당 AE',
    })),
    ...accounts,
    ...soldout.map((s): Item => ({
      level: 'warn', title: `'${s.keyword.text}' → ${s.option} 옵션 품절 랜딩`,
      text: `${s.product} ${s.option} 재고 없음 · 최근 14일 광고비 ${won(s.cost14)}`, basis: '품절 · 옵션 품절 랜딩 → 그룹 일시 중지 제안 (p.45)', route: 'alert', owner: '담당 AE',
    })),
  ];
  changeItems.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  if (!changeItems.length) changeItems.push({ level: 'ok', title: '기준 초과 변동 없음', text: '매체 · 키워드 · 계정 점검 항목이 모두 기준 이내입니다.', basis: 'p.44 · p.47 기준' });

  // 발송 이후 변동 (재생성 시점이 발송 시각 이후면 추가)
  const now = dataNowMinutes(d);
  const forecasts = campaignForecasts(d).filter((f) => f.flag);
  // 08:00 점검 결과 · 예산 예상에 이미 있는 대상은 이슈 목록에서 제외 (같은 건 중복 표기 방지)
  const covered = [
    ...d.accounts.filter((a) => accounts.some((x) => x.title.startsWith(a.name))).map((a) => a.name),
    ...spikes.map((s) => `'${s.keyword.text}'`), ...soldout.map((s) => `'${s.keyword.text}'`), ...forecasts.map((f) => f.name),
  ];
  const openIssues = sortIssues((opts.incidents ?? []).filter((i) => i.status !== 'resolved' && !covered.some((t) => t && (i.title.includes(t) || i.target === t))));
  const todaySection: ReportSection | null = now > DAILY_SEND_MIN ? {
    id: 'today', title: `발송 이후 변동 · ${fmtDate(d.today)} ${hhmmOf(now)} 재생성`, zone: 'fact',
    note: '08:00 발송본에는 없는 항목 · 재생성 시점 데이터 기준',
    blocks: [
      { kind: 'items', items: [
        ...forecasts.map((f): Item => ({ level: 'warn', title: `${f.name} 일 예산 조기 소진 예상 · ${clockOf(f.exhaustHour ?? NaN)} 마감`, text: `소진 페이스 ${dec1(f.pace)}배 · 오늘 ${d.currentHour}시까지 ${won(f.spentToday)} / 일 예산 ${won(f.dailyBudget)} · 미노출 구간 평소 매출 비중 ${pct1(f.lostRevShare * 100)}`, basis: `최근 ${PACE_CURVE_DAYS}일 시간대 소진 곡선 · 미노출 구간 매출 비중 ≥ 20% (p.14 · p.44) · MILDO Board · AD Pilot · Alert와 같은 기준`, route: 'adpilot', owner: 'PM 제안 → 수면밀도 승인 (예산 변경, p.53)' })),
        ...openIssues.slice(0, 6).map((i): Item => ({ level: i.severity === 'P1' ? 'danger' : i.severity === 'P2' ? 'warn' : 'info', title: `${i.severity} ${i.title}`, text: `상태 ${ISSUE_STATUS[i.status]} · 담당 ${i.assignee ?? '미배정'}${i.backup ? ` (백업 ${i.backup})` : ''}`, basis: i.basis ?? i.detectPath, route: 'alert' })),
        ...(forecasts.length + openIssues.length === 0 ? [{ level: 'ok' as Level, title: '발송 이후 신규 변동 없음', text: 'MILDO Alert 열린 이슈 0건 · 조기 소진 예상 캠페인 0건' }] : []),
      ] },
    ],
  } : null;

  // 반복 관측 패턴
  const wp = weekdayPattern(d, y.to, 28);
  const ranked = [...wp].filter((w) => fin(w.index)).sort((a, b) => b.index - a.index);
  const hits = targetHitDays(d, addDays(y.to, -6), y.to, target);
  const streak = belowTargetStreak(d, y.to, 4, target).filter((s) => s.streak >= 4);
  const night = hourShare(d, 20, 23, 28);
  const patterns: string[] = [];
  if (ranked.length >= 3) patterns.push(`최근 28일 요일별 일평균 광고 매출 지수(전체 평균 = 100) 상위 ${ranked.slice(0, 2).map((w) => `${w.label}요일 ${intf(w.index)}`).join(' · ')}, 최저 ${ranked[ranked.length - 1].label}요일 ${intf(ranked[ranked.length - 1].index)}. 전일(${WEEKDAY_KO[weekday(y.from)]}요일) 지수는 ${intf(wp[weekday(y.from)].index)}입니다. 요일 효과가 있어 전일 대비보다 동요일 대비를 우선 봅니다.`);
  patterns.push(`최근 7일 중 전체 ROAS가 목표 ${target}% 이상인 날은 ${hits.hits}일 / ${hits.days}일입니다.`);
  if (streak.length) patterns.push(streakSentence(streak.map((s) => s.media), target));
  if (fin(night)) patterns.push(`최근 28일 전환의 ${pct1(night * 100)}가 20~23시에 발생합니다. 저녁 시간대 이전 예산 소진은 전환 피크 구간 미노출로 이어집니다.`);

  const sections: ReportSection[] = [
    { id: 'kpi', title: `전일 성과 · ${fmtDate(y.from)}`, zone: 'fact', blocks: [statsBlock(rows, ['cost', 'revenue', 'roas', 'sales', 'mer', 'cac']), kpiTable(rows, fmtDate(y.from), `전일(${fmtDate(db.from, false)})`, `동요일(${fmtDate(wk.from, false)})`)] },
    { id: 'media', title: '매체별 성과 · 동일 기준', zone: 'fact', blocks: [mediaTable] },
    { id: 'pacing', title: `예산 소진 · ${monthLabel(mk)} 누적`, zone: 'fact', blocks: [pacingTable] },
    { id: 'changes', title: '주요 변동 · 점검 결과', zone: 'fact', blocks: [{ kind: 'items', items: changeItems }] },
    ...(todaySection ? [todaySection] : []),
    { id: 'patterns', title: '요일 · 시간대 · 목표 달성 패턴', zone: 'pattern', blocks: patterns.map((t) => ({ kind: 'p' as const, text: t })) },
  ];

  const danger = changeItems.filter((i) => i.level === 'danger').length;
  const warn = changeItems.filter((i) => i.level === 'warn').length;
  const r = (id: string) => rows.find((x) => x.id === id)!;
  const messenger = [
    `[MILDO 일간] ${fmtDate(y.from)} 성과 · TEST DATA`,
    `광고비 ${won(cur.cost)} (전일 ${delta(pctChange(cur.cost, prev.cost))} · 동요일 ${delta(pctChange(cur.cost, wkT.cost))})`,
    `광고 매출 ${won(cur.revenue)} · ROAS ${fmt.roas(cur.roas)} (목표 ${target}%)`,
    `실매출 ${won(sales)} · MER ${times(r('mer').cur)} · 신규 CAC ${won(cur.cac)}`,
    `${monthLabel(mk)} 예산 소진 ${pct1(totPace)} (기대 ${pct1(expectedPct)})`,
    `주요 변동: 위험 ${danger} · 주의 ${warn}${changeItems[0] && changeItems[0].level !== 'ok' ? ` — ${changeItems.filter((i) => i.level !== 'ok').slice(0, 2).map((i) => i.title).join(' / ')}` : ''}`,
    `전체 리포트 · 코멘트 → MILDO OS 리포트`,
  ].join('\n');

  const mer = r('mer').cur;
  const livePromos = d.promotions.filter((x) => x.start <= y.to && x.end >= `${mk}-01`);
  const brief: Brief = {
    title: `일간 리포트 · ${fmtDate(y.from)}`,
    facts: [
      `${fmtDate(y.from)} 광고비 ${won(cur.cost)}, 매체 귀속 광고 매출 ${won(cur.revenue)}, ROAS ${fmt.roas(cur.roas)} (TEST DATA). 전일 대비 광고비 ${delta(pctChange(cur.cost, prev.cost))}, 동요일 대비 ${delta(pctChange(cur.cost, wkT.cost))}.`,
      `판매 채널 실매출 ${won(sales)}, MER ${times(mer)}, 신규 고객 ${intf(cur.newCustomers)}명 · CAC ${won(cur.cac)}.`,
      `${monthLabel(mk)} 누적 소진 ${pct1(totPace)} (기대 ${pct1(expectedPct)}), 점검 결과 위험 ${danger}건 · 주의 ${warn}건.`,
    ],
    patterns: patterns.slice(0, 3),
    interpretation: [
      `실매출이 매체 귀속 광고 매출의 ${dec1(safeDiv(sales, cur.revenue))}배입니다. 귀속 밖 매출(오가닉 · 브랜드 검색 · 채널 간 이동)이 크다는 전제에서, 매체 축소 판단은 ROAS 단독이 아니라 MER과 매체별 판단 지표(p.37)를 함께 봐야 합니다.`,
      totPace - expectedPct > 3
        ? `월 누적 소진이 기대 대비 ${pp(totPace - expectedPct)} 앞서 있습니다. ${livePromos.length ? `같은 기간 진행 중인 기획전(${livePromos.map((x) => x.name).join(' · ')})의 수요 반영 여부를` : '초과 소진이 특정 캠페인 · 시간대에 몰렸는지를'} 확인하기 전에는 일 예산 일괄 삭감보다 캠페인 · 시간대 단위 조정이 비용 구조상 안전합니다.`
        : `월 누적 소진은 기대 범위(${pp(totPace - expectedPct)}) 안에 있어 예산 구조 변경 필요성은 낮습니다.`,
    ],
    conditions: [`목표 ROAS ${target}% · 브랜드 ${AD_PILOT.brandTargetRoas}%는 초기값이며 온보딩 중 확정합니다 (p.14). 변동 기준은 p.47 이상 징후 기준을 일 단위에 적용했습니다.`],
    counter: [`하루 데이터는 요일 효과가 크므로${ranked.length >= 3 ? `(최근 28일 ${ranked.slice(0, 2).map((w) => `${w.label}요일`).join(' · ')} 강세 · ${ranked[ranked.length - 1].label}요일 약세)` : ''} 전일 대비보다 동요일 대비를 우선 봅니다. 동요일 대비도 기준 이내라면 단일일 변동만으로 입찰 · 예산을 바꾸지 않습니다.`],
    actions: [
      danger ? `담당 AE는 위험 ${danger}건을 MILDO Alert에서 30분 내 1차 조치하고(P1, p.44), 결과를 17:00 일 마감 요약에 반영합니다.` : '담당 AE는 14:00 예산 소진율 점검에서 캠페인별 예상 마감 시각을 재확인합니다.',
      'PM은 월말 예상 소진이 105%를 넘는 매체의 다음 달 일 예산 상한을 월간 리포트 계획에 반영합니다.',
    ],
  };

  return {
    type: 'daily', title: `일간 리포트 · ${fmtDate(y.from)} 성과`, subtitle: REPORT_META.daily.content,
    periodLabel: fmtDate(y.from), from: y.from, to: y.to, schedule: `${fmtDate(d.today)} 08:00 발송분`, channel: REPORT_META.daily.channel,
    nextSend: nextSends(d).daily.label, generatedAt: dataStamp(d), sections, messenger, brief,
  };
}

/* ============================== 주간 리포트 ============================== */

export function buildWeeklyReport(d: Dataset, opts: ReportOptions = {}): Report {
  const w = rangeOf(d, 'last7');
  if (!hasDate(d, w.from)) return emptyReport('weekly', d, '최근 7일 데이터가 부족합니다.');
  const pw = previousRange(w);
  const cur = totalsFor(d, w.from, w.to);
  const prev = totalsFor(d, pw.from, pw.to);
  const rows = kpiRows(cur, prev, salesTotal(d, w.from, w.to), salesTotal(d, pw.from, pw.to));
  const target = AD_PILOT.targetRoas;

  const mediaTable: Block = {
    kind: 'table',
    columns: [{ label: '매체' }, { label: '광고비', align: 'right' }, { label: '직전 주 대비', align: 'right' }, { label: 'ROAS', align: 'right' }, { label: 'ROAS 변화', align: 'right' }, { label: 'CPA', align: 'right' }, { label: '신규 비중', align: 'right' }, { label: '판단 지표 (p.37)' }],
    rows: MEDIA_IDS.map((m) => {
      const t = totalsFor(d, w.from, w.to, m);
      const p = totalsFor(d, pw.from, pw.to, m);
      const rd = pctChange(t.roas, p.roas);
      return [MEDIA[m].name, won(t.cost), delta(pctChange(t.cost, p.cost)), fmt.roas(t.roas), { text: delta(rd), tone: !fin(rd) || Math.abs(rd) < 10 ? 'neutral' : rd > 0 ? 'good' : 'critical' }, won(t.cpa), pct1(newShareOf(t)), MEDIA[m].judgeMetric];
    }),
  };

  // 키워드 테스트 결과
  const tests = d.keywords.filter((k) => k.status === 'test').map((k) => judgeKeywordTest(k));
  const vc = (v: TestVerdict) => tests.filter((t) => t.verdict === v).length;
  const testTable: Block = {
    kind: 'table',
    columns: [{ label: '키워드' }, { label: '캠페인' }, { label: '집행일', align: 'right' }, { label: '클릭', align: 'right' }, { label: '전환', align: 'right' }, { label: 'ROAS', align: 'right' }, { label: '판정' }, { label: '근거' }, { label: '다음 조치' }],
    rows: tests.map((t): Cell[] => [t.keyword.text, intentName(t.keyword.intent), `${t.days}일`, intf(t.stats.clicks), dec1(t.stats.conversions), t.stats.conversions > 0 ? fmt.roas(t.roas) : '— (전환 0)',
      { text: VERDICT_LABEL[t.verdict], tone: VERDICT_TONE[t.verdict], badge: true }, `${t.basis}${t.lowVolume ? ` · 클릭 ${KEYWORD_TEST_RULES.minClicks} 미만 · 월 검색량 ${intf(t.keyword.monthlySearch)}` : ''}`, t.action]),
    caption: `판정 기준 (p.26, 목표 ROAS ${target}% 대비): 확장 ${KEYWORD_TEST_RULES.expandAtPct}% 이상 · 유지 ${KEYWORD_TEST_RULES.keepFromPct}~${KEYWORD_TEST_RULES.expandAtPct}% · 제외 ${KEYWORD_TEST_RULES.keepFromPct}% 미만 또는 전환 없음 · 표본 ${KEYWORD_TEST_RULES.minDays}일 또는 클릭 ${KEYWORD_TEST_RULES.minClicks} (초기값 · 온보딩 중 확정)`,
  };

  // 신규 후보
  const cands = termCandidates(d);
  const candTable: Block = {
    kind: 'table',
    columns: [{ label: '검색어 (미등록)' }, { label: '클릭', align: 'right' }, { label: '전환', align: 'right' }, { label: '광고비', align: 'right' }, { label: 'ROAS', align: 'right' }],
    rows: cands.slice(0, 8).map((t) => [t.term, intf(t.clicks), dec1(t.conversions), won(t.cost), fmt.roas(t.roas)]),
    caption: `검색어 보고서 ${d.searchTerms.length}건 중 미등록 · 전환 발생 ${cands.length}건 → 테스트 그룹 등록 후보 (p.14 · p.26)`,
  };

  // 구매 의도별 (최근 14일 vs 직전 14일)
  const intentRows = INTENT_IDS.map((i) => {
    const ks = d.keywords.filter((k) => k.intent === i);
    const a = { cost: sum(ks, (k) => k.last14.cost), rev: sum(ks, (k) => k.last14.revenue), clicks: sum(ks, (k) => k.last14.clicks), conv: sum(ks, (k) => k.last14.conversions) };
    const b = { cost: sum(ks, (k) => k.prev14.cost), rev: sum(ks, (k) => k.prev14.revenue), clicks: sum(ks, (k) => k.prev14.clicks) };
    return { i, n: ks.length, roas: metrics.roas(a.rev, a.cost), prevRoas: metrics.roas(b.rev, b.cost), cpc: metrics.cpc(a.cost, a.clicks), prevCpc: metrics.cpc(b.cost, b.clicks), cvr: metrics.cvr(a.conv, a.clicks) };
  });
  const intentTable: Block = {
    kind: 'table',
    columns: [{ label: '캠페인 (구매 의도, p.35)' }, { label: '키워드', align: 'right' }, { label: 'ROAS 14일', align: 'right' }, { label: '직전 14일', align: 'right' }, { label: 'CPC 변화', align: 'right' }, { label: 'CVR', align: 'right' }, { label: '판단 지표' }],
    rows: intentRows.map((r) => [intentName(r.i), `${r.n}개`, fmt.roas(r.roas), fmt.roas(r.prevRoas), delta(pctChange(r.cpc, r.prevCpc)), pct2(r.cvr), SA_CAMPAIGNS[r.i].metric]),
  };

  // 개선 제안 — AD Pilot 조정 후보(같은 엔진 · 같은 숫자) + 리포트 점검 결과
  const ap = adPilotSummary(d);
  const apLabel = ap.source === 'adpilot' ? 'AD Pilot 조정 후보' : 'AD Pilot 규칙(p.14) 보조 계산';
  const spikes = keywordSpikes(d).filter((x) => x.flagged);
  const spikeIds = new Set(spikes.map((x) => x.keyword.id));
  const fc = campaignForecasts(d).filter((f) => f.flag);
  const soldout = soldoutLandings(d);
  const soldoutIds = new Set(soldout.map((x) => x.keyword.id));
  const kwById = new Map(d.keywords.map((k) => [k.id, k]));
  const bidText = (x: BidProposal) => `'${x.keyword}' ${won(x.before)} → ${won(x.after)} (${delta(x.changePct)}) · ${x.rule}`;
  const improve: Item[] = [];
  if (ap.up.length) improve.push({ level: 'info', title: `입찰 상향 후보 ${ap.up.length}건`, text: ap.up.slice(0, 4).map(bidText).join(' / '), basis: `${apLabel} · ROAS ≥ 목표 × ${AD_PILOT.highEfficiencyRoasRatio} · 노출 기회 손실 ≥ ${AD_PILOT.lostShareTrigger * 100}% · 브랜드는 목표 ${AD_PILOT.brandTargetRoas}% · 일 조정 폭 ${AD_PILOT.dailyChangeCapPct}% · 최대 입찰가 내 (p.14)`, route: 'adpilot', owner: '담당 AE (승인 범위 내 운영 조정, p.53)' });
  if (ap.down.length) improve.push({ level: 'info', title: `입찰 하향 후보 ${ap.down.length}건`, text: ap.down.slice(0, 4).map(bidText).join(' / '), basis: `${apLabel} · 목표 ROAS ${target}% 미달 · 최소 전환 ${AD_PILOT.minConversionsForDown}건 확보 후 하향 · 일 조정 폭 ${AD_PILOT.dailyChangeCapPct}% (p.14)`, route: 'adpilot', owner: '담당 AE' });
  for (const sp of spikes) improve.push({ level: 'warn', title: `'${sp.keyword.text}' 자동 조정 보류`, text: `최근 3일 ${sp.reason} · 원인 후보 1순위 ${sp.cause.label} (${sp.cause.basis}) · 규칙 엔진 순위이며 확정 원인 아님`, basis: `성과 급변 ±${AD_PILOT.anomalyHoldPct}% → 자동 조정 보류 · 알림 (p.14)`, route: 'adpilot', owner: '담당 AE → 원인 확인 후 수동 판단' });
  const otherHolds = ap.hold.filter((x) => !spikeIds.has(x.keywordId) && !soldoutIds.has(x.keywordId));
  if (otherHolds.length) improve.push({ level: 'warn', title: `그 외 자동 조정 보류 ${otherHolds.length}건`, text: otherHolds.slice(0, 5).map((x) => `${x.keyword} (${x.rule})`).join(' / '), basis: `${apLabel} · 데이터 급변 · 추적 단절 · 잔액 · 월 예산 초과 시 자동 조정 보류 (p.14 · p.44)`, route: 'adpilot', owner: '담당 AE → 원인 확인 후 재판정' });
  if (fc.length || ap.shift.length) improve.push({
    level: 'warn', title: `일 예산 조기 소진 예상 ${fc.length}건 → 예산 재배분 ${ap.shift.length}건`,
    text: [...fc.map((f) => `${f.name} ${clockOf(f.exhaustHour ?? NaN)} 마감 예상 (페이스 ${dec1(f.pace)}배)`), ...ap.shift.map((x) => `재배분안 ${x.keyword} 일 예산 ${won(x.before)} → ${won(x.after)} (${delta(x.changePct)})`)].join(' / '),
    basis: `최근 ${PACE_CURVE_DAYS}일 시간대 소진 곡선 · 미노출 구간 매출 비중 ≥ 20% (p.14 · p.44) · 총 일 예산 불변 재배분`, route: 'adpilot', owner: 'PM 제안 → 수면밀도 승인 (p.53)',
  });
  if (cands.length) improve.push({ level: 'info', title: `테스트 그룹 등록 후보 ${cands.length}건`, text: cands.slice(0, 3).map((t) => `'${t.term}' 전환 ${dec1(t.conversions)}`).join(' / '), basis: '검색어 보고서 미등록 + 전환 발생 → 테스트 전용 그룹 · 입찰 상한 (p.26)', route: 'lab', owner: '담당 AE' });
  for (const so of soldout) improve.push({ level: 'warn', title: `'${so.keyword.text}' 랜딩 점검`, text: `${so.option} 옵션 품절 상세로 랜딩 · 최근 14일 광고비 ${won(so.cost14)}`, basis: '품절 랜딩 → 해당 그룹 일시 중지 제안 (p.45)', route: 'alert', owner: '담당 AE' });
  const expandT = tests.filter((t) => t.verdict === 'expand');
  if (expandT.length) improve.push({ level: 'info', title: `확장 판정 ${expandT.length}건 본 그룹 이관 검토`, text: expandT.map((t) => `'${t.keyword.text}'`).join(' · '), basis: `확장 = 목표 ROAS 대비 ${KEYWORD_TEST_RULES.expandAtPct}% 이상 (p.26) · 이관은 담당자 승인 후 일괄 반영`, route: 'lab', owner: '담당 AE → PM 확인' });

  const lowVol = tests.filter((t) => t.lowVolume && t.verdict === 'expand');
  const patterns: string[] = [];
  const cpcUp = intentRows.filter((r) => pctChange(r.cpc, r.prevCpc) >= 5);
  if (cpcUp.length) patterns.push(`CPC 상승(직전 14일 대비 +5% 이상): ${cpcUp.map((r) => `${intentName(r.i)} ${delta(pctChange(r.cpc, r.prevCpc))} · ROAS ${fmt.roas(r.prevRoas)} → ${fmt.roas(r.roas)}`).join(', ')}. 단가 상승이 효율 하락과 같은 방향으로 관측됩니다.`);
  const stable = intentRows.filter((r) => fin(r.roas) && fin(r.prevRoas) && r.roas >= target && r.prevRoas >= target);
  if (stable.length) patterns.push(`최근 14일 · 직전 14일 모두 목표 ROAS ${target}% 이상: ${stable.map((r) => intentName(r.i)).join(', ')} (${stable.length}/${intentRows.length}개 캠페인). 키워드 단위 ROAS(검색광고 귀속)와 매체 합계 ROAS는 귀속 범위가 달라 직접 비교하지 않습니다.`);
  const lostUp = ap.up.map((x) => kwById.get(x.keywordId)).filter((k): k is Keyword => !!k && k.impressionShareLost >= AD_PILOT.lostShareTrigger);
  if (lostUp.length) patterns.push(`입찰 상향 후보 ${ap.up.length}개 중 ${lostUp.length}개가 노출 기회 손실 ${pct1(Math.min(...lostUp.map((k) => k.impressionShareLost)) * 100)}~${pct1(Math.max(...lostUp.map((k) => k.impressionShareLost)) * 100)} 구간에 있습니다(기준 ${AD_PILOT.lostShareTrigger * 100}%). 순위 · 예산 제약으로 회수하지 못한 수요가 14일 집계에서 반복 관측됩니다.`);
  if (lowVol.length) patterns.push(`확장 판정 ${lowVol.length}건 모두 클릭 ${KEYWORD_TEST_RULES.minClicks}건 미만(월 검색량 ${lowVol.map((t) => intf(t.keyword.monthlySearch)).join(' · ')}) — 볼륨 한계로 단독 확장 효과는 작습니다.`);

  const sections: ReportSection[] = [
    { id: 'summary', title: `주간 성과 · ${rangeLabel(w.from, w.to)}`, zone: 'fact', blocks: [statsBlock(rows, ['cost', 'revenue', 'roas', 'cpa', 'sales', 'mer']), kpiTable(rows, rangeLabel(w.from, w.to), '직전 7일'), mediaTable] },
    { id: 'tests', title: `키워드 테스트 결과 · 확장 ${vc('expand')} · 유지 ${vc('keep')} · 제외 ${vc('exclude')} · 보류 ${vc('hold')}`, zone: 'fact', blocks: tests.length ? [testTable] : [{ kind: 'p', text: '진행 중인 테스트 키워드가 없습니다.' }] },
    { id: 'candidates', title: '신규 구매 의도 후보 · 검색어 보고서', zone: 'fact', blocks: cands.length ? [candTable] : [{ kind: 'p', text: '미등록 · 전환 발생 검색어가 없습니다.' }] },
    { id: 'intent', title: 'SA 캠페인(구매 의도)별 효율 · 최근 14일', zone: 'fact', blocks: [intentTable] },
    { id: 'patterns', title: '키워드 · 캠페인 효율 패턴', zone: 'pattern', blocks: (patterns.length ? patterns : ['관측 기간 내 반복 패턴이 기준을 넘지 않았습니다.']).map((t) => ({ kind: 'p' as const, text: t })) },
    { id: 'improve', title: `개선 제안 ${improve.length}건 · 규칙 기반`, zone: 'action', note: '모든 변경은 승인 후 반영 · 이력 기록 · 롤백 가능 (p.14)', blocks: [{ kind: 'items', items: improve.length ? improve : [{ level: 'ok', title: '규칙 기준 개선 후보 없음', text: '현재 기준값에서 조정 후보가 생성되지 않았습니다.' }] }] },
  ];

  const ns = nextSends(d);
  const messenger = [
    `[MILDO 주간] ${rangeLabel(w.from, w.to)} · TEST DATA`,
    `광고비 ${won(cur.cost)} (직전 주 ${delta(pctChange(cur.cost, prev.cost))}) · ROAS ${fmt.roas(cur.roas)}`,
    `실매출 ${won(rows.find((r) => r.id === 'sales')!.cur)} · MER ${times(rows.find((r) => r.id === 'mer')!.cur)}`,
    `키워드 테스트 ${tests.length}건: 확장 ${vc('expand')} · 유지 ${vc('keep')} · 제외 ${vc('exclude')} · 보류 ${vc('hold')}`,
    `신규 후보 ${cands.length}건 · 개선 제안 ${improve.length}건 — 입찰 상향 ${ap.up.length} · 하향 ${ap.down.length} · 자동 조정 보류 ${ap.hold.length} · 조기 소진 ${fc.length} · 예산 재배분 ${ap.shift.length}`,
    `메일 본문 ${ns.weekly.label} 발송 → 코멘트 단위 피드백`,
  ].join('\n');

  const brief: Brief = {
    title: `주간 리포트 · ${rangeLabel(w.from, w.to)}`,
    facts: [
      `최근 7일 광고비 ${won(cur.cost)} (직전 7일 대비 ${delta(pctChange(cur.cost, prev.cost))}), ROAS ${fmt.roas(cur.roas)} → 직전 ${fmt.roas(prev.roas)} (TEST DATA).`,
      `키워드 테스트 ${tests.length}건 판정: 확장 ${vc('expand')} · 유지 ${vc('keep')} · 제외 ${vc('exclude')} · 보류 ${vc('hold')}. 검색어 보고서 미등록 · 전환 발생 후보 ${cands.length}건.`,
      `${apLabel}(AD Pilot 화면과 같은 기준) 입찰 상향 ${ap.up.length}건, 하향 ${ap.down.length}건, 자동 조정 보류 ${ap.hold.length}건, 예산 재배분 ${ap.shift.length}건. 일 예산 조기 소진 예상 ${fc.length}건.`,
    ],
    patterns: patterns.slice(0, 3),
    interpretation: [
      lowVol.length ? `확장 판정 중 ${lowVol.length}건은 규칙상 확장이지만 클릭 · 전환 표본이 작아 ROAS 신뢰 구간이 넓습니다. 본 그룹 이관은 같은 의도의 구문형 키워드를 묶어 표본을 키운 뒤 판단하는 것이 CAC 회수 관점에서 안전합니다.` : '확장 판정 키워드는 표본 기준을 충족해 본 그룹 이관 판단이 가능합니다.',
      ap.up.length ? `고효율 키워드 노출 손실 회수는 단기 매출을 늘리지만 CPC 상승을 동반합니다. 상향 폭을 일 ${AD_PILOT.dailyChangeCapPct}%로 제한하고 2주 후 한계 ROAS를 확인하는 단계적 확장이 비용 구조상 유리합니다.` : '입찰 상향 후보가 없어 이번 주는 효율 유지 중심으로 운영합니다.',
    ],
    conditions: [`목표 ROAS ${target}%, 고효율 ${AD_PILOT.highEfficiencyRoasRatio}배, 노출 손실 ${AD_PILOT.lostShareTrigger * 100}%, 일 조정 폭 ${AD_PILOT.dailyChangeCapPct}%, 급변 보류 ±${AD_PILOT.anomalyHoldPct}%는 p.14 초기값입니다.`],
    counter: [spikes.length
      ? (spikes[0].cause.label === CAUSE_CANDIDATES[3]
        ? `'${spikes[0].keyword.text}'의 급변(${spikes[0].reason})이 집계 지연이 아니라 실제 경쟁 환경 변화라면 다음 수집 주기에도 유지됩니다. 이 경우 입찰 상한 안에서 수동 조정을 검토합니다.`
        : `'${spikes[0].keyword.text}'의 급변(${spikes[0].reason})이 ${spikes[0].cause.label}이 아니라 매체 집계 지연이라면 다음 수집 주기에 정상화됩니다. 이 경우 보류를 해제하고 기존 규칙으로 복귀합니다.`)
      : '입찰 상향 후보의 노출 손실이 순위가 아니라 캠페인 예산 제약에서 온 것이라면 입찰 상향만으로는 회수되지 않습니다. 이 경우 예산 재배분과 함께 판단합니다.'],
    actions: [`담당 AE는 ${ns.weekly.label} 메일 발송 전 개선 제안 ${improve.length}건 중 승인 범위 내 항목(입찰 조정 · 테스트 등록)을 AD Pilot · Lab 승인 요청으로 올리고, 예산 재배분은 PM 제안 → 수면밀도 승인으로 라우팅합니다(p.53).`],
  };

  return {
    type: 'weekly', title: `주간 리포트 · ${rangeLabel(w.from, w.to)}`, subtitle: REPORT_META.weekly.content, zoneLabels: { action: '개선 제안 · 다음 액션' },
    periodLabel: rangeLabel(w.from, w.to), from: w.from, to: w.to, schedule: `${ns.weekly.label} 발송 예정 (미리보기)`, channel: REPORT_META.weekly.channel,
    nextSend: ns.weekly.label, generatedAt: dataStamp(d), sections, messenger, brief,
  };
}

/* ============================== 월간 리포트 ============================== */

export interface MonthPeriod { month: string; from: string; to: string; label: string; provisional: boolean; days: number; dim: number; prevMonth: string; prevFrom: string; prevTo: string; prevPartial: boolean }
export function monthPeriod(d: Dataset, month?: string): MonthPeriod | null {
  const y = addDays(d.today, -1);
  const mk = month && /^\d{4}-\d{2}$/.test(month) ? month : monthKey(y);
  const dim = daysInMonth(`${mk}-01`);
  const lastDay = `${mk}-${String(dim).padStart(2, '0')}`;
  const from = `${mk}-01`;
  const to = lastDay < y ? lastDay : y;
  if (to < from) return null;
  const days = Number(to.slice(8, 10));
  const pm = prevMonthKey(mk);
  const pdim = daysInMonth(`${pm}-01`);
  const prevTo = `${pm}-${String(Math.min(days, pdim)).padStart(2, '0')}`;
  const prevFrom = `${pm}-01`;
  return { month: mk, from, to, label: `${monthLabel(mk)} (${rangeLabel(from, to)})`, provisional: to < lastDay, days, dim, prevMonth: pm, prevFrom, prevTo, prevPartial: !hasDate(d, prevFrom) };
}
/** 월간 리포트 대상 월 목록 (데이터 첫날 이후 시작하는 월, 최신순) */
export function availableMonths(d: Dataset): string[] {
  const y = addDays(d.today, -1);
  const out: string[] = [];
  let m = monthKey(y);
  for (let i = 0; i < 12; i++) {
    if (`${m}-01` < (d.dates[0] ?? '')) break;
    out.push(m);
    m = prevMonthKey(m);
  }
  return out;
}

export function buildMonthlyReport(d: Dataset, opts: ReportOptions = {}): Report {
  const p = monthPeriod(d, opts.month);
  if (!p || !hasDate(d, p.from)) return emptyReport('monthly', d, '대상 월 데이터가 부족합니다.');
  const cur = totalsFor(d, p.from, p.to);
  const prev = totalsFor(d, p.prevFrom, p.prevTo);
  const ch = salesByChannel(d, p.from, p.to);
  const chPrev = salesByChannel(d, p.prevFrom, p.prevTo);
  const sales = sum(ch, (c) => c.revenue);
  const salesPrev = sum(chPrev, (c) => c.revenue);
  const rows = kpiRows(cur, prev, sales, salesPrev);
  const prevLabel = `${monthLabel(p.prevMonth)} 같은 ${p.days}일${p.prevPartial ? ' (일부 미수집)' : ''}`;

  const chanTable: Block = {
    kind: 'table',
    columns: [{ label: '판매 채널' }, { label: '실매출', align: 'right' }, { label: '비중', align: 'right' }, { label: '비중 변화', align: 'right' }, { label: '전월 대비', align: 'right' }, { label: '주문', align: 'right' }, { label: 'CVR', align: 'right' }, { label: '객단가', align: 'right' }, { label: '광고 경유 비중', align: 'right' }],
    rows: [
      ...ch.map((c): Cell[] => {
        const pv = chPrev.find((x) => x.channel === c.channel)!;
        const share = safeDiv(c.revenue, sales) * 100;
        const pshare = safeDiv(pv.revenue, salesPrev) * 100;
        return [SALES_CHANNELS[c.channel].name, won(c.revenue), pct1(share), pp(share - pshare), delta(pctChange(c.revenue, pv.revenue)), intf(c.orders), pct2(c.cvr), won(c.aov), pct1(safeDiv(c.adAttributedRevenue, c.revenue) * 100)];
      }),
      ['합계', won(sales), '100.0%', '—', delta(pctChange(sales, salesPrev)), intf(sum(ch, (c) => c.orders)), pct2(safeDiv(sum(ch, (c) => c.orders), sum(ch, (c) => c.visitors)) * 100), won(safeDiv(sales, sum(ch, (c) => c.orders))), pct1(safeDiv(sum(ch, (c) => c.adAttributedRevenue), sales) * 100)],
    ],
    caption: '광고 경유 비중 = 광고 경유 매출(추정) ÷ 채널 실매출 · 합산 매출 기준 판단 (p.41)',
  };

  const budgetFor = (m: MediaId) => (MEDIA[m].annualBudget / 12) * (p.days / p.dim);
  const mediaTable: Block = {
    kind: 'table',
    columns: [{ label: '매체' }, { label: '광고비', align: 'right' }, { label: '집행 비중', align: 'right' }, { label: '배분 가안 (p.37)', align: 'right' }, { label: '예산 대비 (기준 90~105%)', align: 'right' }, { label: 'ROAS', align: 'right' }, { label: 'ROAS 전월 대비', align: 'right' }, { label: 'CPA', align: 'right' }, { label: '신규 비중', align: 'right' }, { label: '판단 지표' }],
    rows: MEDIA_IDS.map((m): Cell[] => {
      const t = totalsFor(d, p.from, p.to, m);
      const pv = totalsFor(d, p.prevFrom, p.prevTo, m);
      const vsBudget = safeDiv(t.cost, budgetFor(m)) * 100;
      return [MEDIA[m].name, won(t.cost), pct1(safeDiv(t.cost, cur.cost) * 100), pct1(MEDIA[m].share * 100), { text: pct1(vsBudget), tone: vsBudget > 105 || vsBudget < 90 ? 'warning' : 'good', badge: true }, fmt.roas(t.roas), delta(pctChange(t.roas, pv.roas)), won(t.cpa), pct1(newShareOf(t)), MEDIA[m].judgeMetric];
    }),
    caption: `예산 대비 = 광고비 ÷ (연 배분/12 × ${p.days}/${p.dim}일) · 기준 90~105% (운영 가정)`,
  };

  // 패턴
  const wp = weekdayPattern(d, p.to, Math.min(28, p.days));
  const ranked = [...wp].filter((x) => fin(x.index)).sort((a, b) => b.index - a.index);
  const weekly: { label: string; roas: number; cost: number }[] = [];
  for (let k = 0; k < 4; k++) {
    const to = addDays(p.to, -7 * k);
    const from = addDays(to, -6);
    if (from < p.from) break;
    const t = totalsFor(d, from, to);
    weekly.unshift({ label: rangeLabel(from, to), roas: t.roas, cost: t.cost });
  }
  const shareShift = ch.map((c) => {
    const pv = chPrev.find((x) => x.channel === c.channel)!;
    return { c: c.channel, diff: safeDiv(c.revenue, sales) * 100 - safeDiv(pv.revenue, salesPrev) * 100 };
  }).filter((x) => Math.abs(x.diff) >= 1);
  const patterns: string[] = [];
  if (ranked.length >= 3) patterns.push(`월 중 요일별 일평균 광고 매출 지수(전체 평균 = 100) 상위 ${ranked.slice(0, 2).map((x) => `${x.label}요일 ${intf(x.index)}`).join(' · ')}, 최저 ${ranked[ranked.length - 1].label}요일 ${intf(ranked[ranked.length - 1].index)}.`);
  if (weekly.length >= 3) {
    const rising = weekly.every((x, i) => i === 0 || x.cost >= weekly[i - 1].cost);
    patterns.push(`주차별 광고비 · ROAS: ${weekly.map((x) => `${x.label} ${won(x.cost)} · ${fmt.roas(x.roas)}`).join(' / ')}.${rising ? ' 광고비가 주차마다 증가했습니다.' : ''}`);
  }
  patterns.push(shareShift.length ? `판매 채널 비중 변화(±1%p 이상): ${shareShift.map((x) => `${SALES_CHANNELS[x.c].name} ${pp(x.diff)}`).join(' · ')}.` : '판매 채널 비중은 전월 대비 ±1%p 이내로 유지됐습니다.');
  const streak = belowTargetStreak(d, p.to, 4).filter((s) => s.streak >= 4);
  if (streak.length) patterns.push(streakSentence(streak.map((s) => s.media), AD_PILOT.targetRoas));

  // 다음 달 계획
  const nm = nextMonthKey(p.month);
  const ndim = daysInMonth(`${nm}-01`);
  const nDates = Array.from({ length: ndim }, (_, i) => `${nm}-${String(i + 1).padStart(2, '0')}`);
  const offDays = nDates.filter((x) => !isBusinessDay(x));
  const holidays = nDates.filter((x) => REPORT_HOLIDAYS[x]);
  const nFirst = `${nm}-01`;
  const nLast = `${nm}-${String(ndim).padStart(2, '0')}`;
  const promos = d.promotions.filter((x) => x.start <= nLast && x.end >= nFirst);
  const curPacing = MEDIA_IDS.map((m) => ({ m, vs: safeDiv(totalsFor(d, p.from, p.to, m).cost, budgetFor(m)) * 100 }));
  const planBudget: Block = {
    kind: 'table',
    columns: [{ label: '매체' }, { label: `${monthLabel(nm)} 예산 (연 배분/12)`, align: 'right' }, { label: '일 평균', align: 'right' }, { label: `${monthLabel(p.month)} 일평균 집행`, align: 'right' }, { label: `${monthLabel(p.month)} 대비`, align: 'right' }],
    rows: MEDIA_IDS.map((m) => {
      const nb = MEDIA[m].annualBudget / 12;
      const curDaily = totalsFor(d, p.from, p.to, m).cost / Math.max(1, p.days);
      const nDaily = nb / ndim;
      return [MEDIA[m].name, won(nb), won(nDaily), won(curDaily), delta(pctChange(nDaily, curDaily))];
    }),
    caption: '연 50억 배분 가안 기준 (p.37) · 월 1회 재배분 → 분기 구조 리뷰 원칙 · 확정은 수면밀도 승인',
  };
  const tests = d.keywords.filter((k) => k.status === 'test').map((k) => judgeKeywordTest(k));
  const over = curPacing.filter((x) => x.vs > 105);
  const planItems: Item[] = [
    ...promos.map((x): Item => ({ level: 'info', title: `${x.name} · ${SALES_CHANNELS[x.channel].name}`, text: `${rangeLabel(x.start, x.end)} · 할인 ${x.discountRate}% · ${x.status === 'planned' ? '예정' : x.status === 'live' ? '진행 중 (월 초 종료)' : '종료'}${x.adCopyPrice ? ` · 소재 표기가 ${won(x.adCopyPrice)}` : ' · 소재 표기가 미등록'}`, basis: '프로모션 체크리스트 · 오픈 전 자동 점검 (p.31)', route: 'flow', owner: '담당 AE · PM' })),
    { level: 'info', title: `영업일 ${ndim - offDays.length}일 · 주말 · 공휴일 ${offDays.length}일`, text: holidays.length ? `공휴일: ${holidays.map((x) => `${fmtDate(x)} ${REPORT_HOLIDAYS[x]}`).join(' · ')}` : '공휴일 없음 · 주말은 당번 체계 (p.48)', basis: '주말 · 공휴일 동일 기준 · 당번 AE · 다음 영업일 09:30 브리핑 (p.44)', route: 'alert', owner: 'PM (당번 순번)' },
    ...(over.length ? [{ level: 'warn' as Level, title: `월 예산 초과 집행 매체 ${over.length}개 → 일 예산 상한 점검`, text: over.map((x) => `${MEDIA[x.m].short} ${pct1(x.vs)}`).join(' · '), basis: '예산 대비 105% 초과 (운영 가정) · 예산 · 구조 변경은 PM 제안 → 수면밀도 승인 (p.53)', route: 'growth', owner: 'PM 제안 → 수면밀도 승인' }] : []),
    { level: 'info', title: `키워드 테스트 ${tests.length}건 이어서 판정`, text: tests.map((t) => `'${t.keyword.text}' ${VERDICT_LABEL[t.verdict]}`).join(' · ') || '진행 중 테스트 없음', basis: '14일 또는 최소 클릭 수 도달 시 판정 (p.26)', route: 'lab', owner: '담당 AE' },
    { level: 'info', title: '한계 효율 재배분 검토', text: '매체별 반응 곡선 · 한계 ROAS로 다음 달 배분안 작성 (예측이 아닌 시나리오)', basis: '월 1회 재배분 → 분기 구조 리뷰 (p.37)', route: 'growth', owner: 'PM · 데이터 애널리스트' },
  ];

  const ns = nextSends(d);
  const reportDate = nthBusinessDay(nm, MONTHLY_BUSINESS_DAY);
  const sections: ReportSection[] = [
    { id: 'summary', title: `${monthLabel(p.month)} 성과 요약`, zone: 'fact', blocks: [statsBlock(rows, ['sales', 'mer', 'cost', 'roas', 'cpa', 'cac']), kpiTable(rows, p.label, prevLabel)] },
    { id: 'channels', title: '채널별 매출 기여', zone: 'fact', blocks: [chanTable] },
    { id: 'media', title: '매체별 성과 · 배분', zone: 'fact', blocks: [mediaTable] },
    { id: 'patterns', title: '월중 · 채널 구성 패턴', zone: 'pattern', blocks: patterns.map((t) => ({ kind: 'p' as const, text: t })) },
    { id: 'plan', title: `다음 달 계획 · ${monthLabel(nm)}`, zone: 'action', note: '협의 가안 · 확정은 월간 미팅에서 수면밀도 승인', blocks: [planBudget, { kind: 'items', items: planItems }] },
  ];

  const top = [...ch].sort((a, b) => b.revenue - a.revenue);
  const messenger = [
    `[MILDO 월간] ${p.label}${p.provisional ? ' · 잠정' : ''} · TEST DATA`,
    `판매 채널 실매출 ${won(sales)} (전월 같은 기간 ${delta(pctChange(sales, salesPrev))}) · MER ${times(rows.find((r) => r.id === 'mer')!.cur)}`,
    `채널 비중: ${top.map((c) => `${SALES_CHANNELS[c.channel].name} ${pct1(safeDiv(c.revenue, sales) * 100)}`).join(' · ')}`,
    `광고비 ${won(cur.cost)} · ROAS ${fmt.roas(cur.roas)} · CPA ${won(cur.cpa)}`,
    `${monthLabel(nm)} 계획: 월 예산 ${won(sum(MEDIA_IDS, (m) => MEDIA[m].annualBudget / 12))} · 프로모션 ${promos.length}건 · 영업일 ${ndim - offDays.length}일`,
    `월간 미팅 ${fmtDate(reportDate)} (익월 ${MONTHLY_BUSINESS_DAY}영업일)`,
  ].join('\n');

  const brief: Brief = {
    title: `월간 리포트 · ${p.label}`,
    facts: [
      `${p.label} 판매 채널 실매출 ${won(sales)}, 전월 같은 ${p.days}일 대비 ${delta(pctChange(sales, salesPrev))} (TEST DATA${p.provisional ? ' · 마감 전 잠정' : ''}).`,
      `광고비 ${won(cur.cost)}, ROAS ${fmt.roas(cur.roas)}, MER ${times(rows.find((r) => r.id === 'mer')!.cur)}. 채널 비중 1위 ${SALES_CHANNELS[top[0].channel].name} ${pct1(safeDiv(top[0].revenue, sales) * 100)}.`,
    ],
    patterns: patterns.slice(0, 3),
    interpretation: [
      `채널별 판단은 합산 매출 기준으로 합니다(p.41). 특정 채널 비중 상승이 다른 채널 잠식인지 순증인지는 합산 실매출 증감과 함께 봐야 하며, 합산이 늘지 않은 비중 이동은 성장으로 해석하지 않습니다.`,
      over.length ? `월 예산 대비 105%를 넘겨 집행한 매체는 ${over.map((x) => MEDIA[x.m].short).join(' · ')}입니다. 초과분이 시즌 수요 회수였는지는 같은 기간 한계 ROAS로 확인한 뒤 다음 달 일 예산 상한에 반영하는 것이 안전합니다.` : '모든 매체가 월 예산 기준 범위 안에서 집행됐습니다.',
    ],
    conditions: ['월 예산 = 연 50억 배분 가안(p.37) ÷ 12. 광고 경유 매출은 추정치입니다. 잠정 리포트는 월 마감 후 확정 수치로 다시 생성합니다.'],
    counter: ['전월 대비 증감은 요일 구성 · 기획전 일정 차이를 포함합니다. 기획전이 한쪽 기간에만 있었다면 기획전 기간을 제외한 비교를 함께 확인합니다.'],
    actions: [`PM은 ${fmtDate(reportDate)} 월간 미팅 전 ${monthLabel(nm)} 배분안과 프로모션 ${promos.length}건 체크리스트를 공유하고, 예산 · 구조 변경은 수면밀도 승인으로 확정합니다(p.53).`],
  };

  return {
    type: 'monthly', title: `월간 리포트 · ${p.label}`, subtitle: REPORT_META.monthly.content, zoneLabels: { action: '다음 달 계획' },
    periodLabel: p.label, from: p.from, to: p.to, schedule: `${fmtDate(reportDate)} 월간 미팅 (익월 ${MONTHLY_BUSINESS_DAY}영업일)`, channel: REPORT_META.monthly.channel,
    nextSend: ns.monthly.label, generatedAt: dataStamp(d), provisional: p.provisional, sections, messenger, brief, scope: `monthly-${p.month}`,
  };
}

/* ============================== 이슈 알림 ============================== */

export const ISSUE_STATUS: Record<Incident['status'], string> = { open: '미확인', ack: '인지', action: '조치 중', resolved: '해결' };
const SEV_ORDER: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };
export function sortIssues<T extends Incident>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (b.detectedAt > a.detectedAt ? 1 : b.detectedAt < a.detectedAt ? -1 : 0));
}
function evidenceText(e: NonNullable<IssueLike['evidence']>[number]): string {
  if (e.unit === 'text') return `${e.label}: ${e.note ?? '—'}`;
  const v = (x: number | undefined) => (x === undefined ? '—' : e.unit === 'krw' || e.unit === 'won' ? won(x) : e.unit === 'roas' ? fmt.roas(x) : e.unit === 'pct' ? pct1(x) : e.unit === 'days' ? `${dec1(x)}일` : e.unit === 'hours' ? `${dec1(x)}시간` : dec1(x));
  return `${e.label} ${v(e.observed)}${e.baseline !== undefined ? ` (${e.baseLabel ?? '기준'} ${v(e.baseline)})` : ''}${e.deltaPct !== undefined && fin(e.deltaPct) ? ` ${delta(e.deltaPct)}` : ''}${e.threshold ? ` · 기준 ${e.threshold}` : ''}`;
}
export function slaDeadlines(i: Incident): { ack: string; action: string; report: string } {
  const s = SLA[i.severity];
  const base = kst(i.detectedAt).ms;
  const at = (min: number | null, label: string) => (min === null || !fin(base) ? label : `${kstFromMs(base + min * 60_000)} (${label})`);
  return { ack: at(s.ackMin, s.label.ack), action: at(s.actionMin, s.label.action), report: at(s.reportMin, s.label.report) };
}

export function buildIssueReport(d: Dataset, incidents: readonly IssueLike[], selectedId?: string | null): Report {
  const meta = REPORT_META.issue;
  const all = sortIssues(incidents);
  const open = all.filter((i) => i.status !== 'resolved');
  if (!all.length) {
    const r = emptyReport('issue', d, '감지된 이슈가 없습니다. MILDO Alert가 24시간 감지 중입니다.');
    return { ...r, empty: false, title: '이슈 알림 · 열린 이슈 없음', sections: [{ id: 'summary', title: '이슈 현황', zone: 'fact', blocks: [{ kind: 'items', items: [{ level: 'ok', title: '열린 이슈 0건', text: '크리티컬 6유형 · 추가 탐지 6종 · 성과 이상 징후 기준 모두 이내 (p.44–47)' }] }] }] };
  }
  const sel = all.find((i) => i.id === selectedId) ?? open[0] ?? all[0];
  const cnt = (s: Severity) => open.filter((i) => i.severity === s).length;
  const summaryTable: Block = {
    kind: 'table',
    columns: [{ label: '등급' }, { label: '이슈' }, { label: '대상' }, { label: '상태' }, { label: '담당 · 백업' }, { label: '감지' }],
    rows: all.slice(0, 14).map((i): Cell[] => [{ text: i.severity, tone: i.severity === 'P1' ? 'critical' : i.severity === 'P2' ? 'serious' : 'warning', badge: true }, `${i.title}${i.isTest ? ' [테스트]' : ''}`, i.target ?? i.media ?? '—', { text: ISSUE_STATUS[i.status], tone: i.status === 'resolved' ? 'good' : i.status === 'open' ? 'warning' : 'neutral' }, `${i.assignee ?? '미배정'}${i.backup ? ` · ${i.backup}` : ''}`, kst(i.detectedAt).time || '—']),
    caption: `열린 이슈 ${open.length}건 (P1 ${cnt('P1')} · P2 ${cnt('P2')} · P3 ${cnt('P3')}) · 전체 ${all.length}건`,
  };
  const det = kst(sel.detectedAt);
  const occ = kst(sel.occurredAt);
  const evid = sel.evidence?.length ? sel.evidence.map(evidenceText) : sel.metric ? [`${sel.metric} ${sel.observed !== undefined ? dec1(sel.observed) : '—'}${sel.baseline !== undefined ? ` (기준 ${dec1(sel.baseline)})` : ''}${sel.deltaPct !== undefined ? ` ${delta(sel.deltaPct)}` : ''}`] : [];
  const detectBlock: Block = {
    kind: 'table', columns: [{ label: '항목' }, { label: '내용' }],
    rows: [
      ['등급', { text: `${sel.severity} · ${sel.severity === 'P1' ? '즉시' : sel.severity === 'P2' ? '1시간 내' : '24시간 내'}`, tone: sel.severity === 'P1' ? 'critical' : 'serious', badge: true }],
      ['발생 · 감지', `발생 ${occ.date ? `${fmtDate(occ.date)} ${occ.time}` : '—'} · 감지 ${det.date ? `${fmtDate(det.date)} ${det.time}` : '—'}`],
      ['감지 경로', sel.detectPath || '—'],
      ['판정 기준', `${sel.basis ?? sel.ruleLabel ?? sel.ruleId}${sel.page ? ` (${sel.page})` : ''}`],
      ...evid.slice(0, 5).map((t, n): Cell[] => [n === 0 ? '근거 수치' : '', t]),
      ['데이터', sel.isTest ? '테스트 주입 이슈 (isTest)' : 'TEST DATA 기반 탐지'],
    ],
  };
  const causes = sel.causes?.length ? sel.causes.map((c) => ({ label: c.label, score: c.score, basis: c.basis })) : sel.causeCandidates.map((c, n) => ({ label: c.split(' — ')[0], score: NaN, basis: c.split(' — ')[1] ?? `후보 ${n + 1}순위` }));
  const causeBlock: Block = {
    kind: 'table', columns: [{ label: '원인 후보' }, { label: '점수', align: 'right' }, { label: '데이터 근거' }],
    rows: causes.slice(0, 4).map((c) => [c.label, fin(c.score) ? intf(c.score) : '—', c.basis]),
    caption: `규칙 엔진 순위 · 확정 원인 아님${sel.recurrence?.count ? ` · 최근 같은 유형 ${sel.recurrence.count}회 (${sel.recurrence.dates.slice(0, 3).join(', ')})` : ''}`,
  };
  const imp = sel.impact ?? {};
  const impactBlock: Block = {
    kind: 'table', columns: [{ label: '영향' }, { label: '추정', align: 'right' }],
    rows: [
      ['미노출 (노출 손실)', imp.impressionsLost !== undefined ? `${intf(imp.impressionsLost)}회` : '—'],
      ['영향 광고비', imp.spendAtRisk !== undefined ? won(imp.spendAtRisk) : '—'],
      ['추정 매출 손실', imp.revenueLossEst !== undefined ? won(imp.revenueLossEst) : '—'],
      ['대상', `${sel.target ?? '—'}${sel.media ? ` · ${(MEDIA as Record<string, { name: string }>)[sel.media]?.name ?? (SALES_CHANNELS as Record<string, { name: string }>)[sel.media]?.name ?? sel.media}` : ''}`],
    ],
    caption: sel.impactNote ?? '추정치 · 최근 7일 효율 기준 (TEST DATA)',
  };
  const sla = slaDeadlines(sel);
  const detOff = det.date ? offDayOf(det.date) : { off: false, label: '' };
  const briefDay = det.date && detOff.off ? nextBusinessDay(det.date) : null;
  const statusItems: Item[] = [
    { level: sel.status === 'resolved' ? 'ok' : sel.status === 'open' ? 'warn' : 'info', title: `상태 ${ISSUE_STATUS[sel.status]}`, text: `담당 ${sel.assignee ?? '미배정'}${sel.backup ? ` · 백업 ${sel.backup}` : ''}`, basis: `SLA ${sel.severity}: 인지 ${sla.ack} · 1차 조치 ${sla.action} · 결과 보고 ${sla.report} (p.49)`, route: 'alert' },
    ...(briefDay ? [{ level: 'info' as Level, title: `${detOff.label} 감지 · 주말 · 공휴일 체계`, text: `당번 AE 30분 내 확인${sel.severity === 'P1' ? ' · P1은 PM 에스컬레이션 · 브랜드 담당자 연락' : ''} · 브랜드팀 브리핑은 ${fmtDate(briefDay)} 09:30`, basis: '주말 · 공휴일도 같은 기준 · 24시간 감지 · 다음 영업일 09:30 브리핑 (p.44 · p.48)', route: 'alert', owner: '당번 AE' }] : []),
    ...sel.autoActions.slice(0, 6).map((a): Item => ({ level: 'info', title: '자동 조치', text: a })),
    ...(sel.actionNote ? [{ level: 'info' as Level, title: '1차 조치 메모', text: sel.actionNote }] : []),
    ...sel.timeline.slice(-4).map((t): Item => ({ level: 'info', title: `${kst(t.at).time || '—'} ${t.by}`, text: t.action })),
  ];

  const sections: ReportSection[] = [
    { id: 'summary', title: `이슈 현황 · 열린 이슈 ${open.length}건`, zone: 'fact', blocks: [summaryTable] },
    { id: 'detect', title: `감지 · ${sel.title}`, zone: 'fact', blocks: [detectBlock] },
    { id: 'impact', title: '영향 범위 (추정)', zone: 'fact', blocks: [impactBlock] },
    { id: 'cause', title: '원인 후보 · 재발 이력', zone: 'pattern', blocks: [causeBlock] },
    { id: 'status', title: '조치 상태', zone: 'action', blocks: [{ kind: 'items', items: statusItems }] },
  ];

  const messenger = [
    `[MILDO 이슈 · ${sel.severity}] ${sel.title}${sel.isTest ? ' [테스트]' : ''}`,
    `감지 ${det.date ? `${fmtDate(det.date)} ${det.time}` : '—'} · ${sel.detectPath.split(' · ')[0] || 'MILDO Alert'}`,
    evid[0] ? `근거: ${evid[0]}` : '',
    causes.length ? `원인 후보: ${causes.slice(0, 2).map((c) => c.label).join(' / ')}` : '',
    `영향: 광고비 ${imp.spendAtRisk !== undefined ? won(imp.spendAtRisk) : '—'} · 추정 매출 손실 ${imp.revenueLossEst !== undefined ? won(imp.revenueLossEst) : '—'}`,
    `조치: ${sel.autoActions[0] ?? '담당 AE 확인'} · 담당 ${sel.assignee ?? '미배정'} · ${ISSUE_STATUS[sel.status]}`,
    `SLA 인지 ${sla.ack.split(' (')[0]} · 1차 조치 ${sla.action.split(' (')[0]}`,
    open.length > 1 ? `그 외 열린 이슈 ${open.length - 1}건 (P1 ${cnt('P1') - (sel.severity === 'P1' && sel.status !== 'resolved' ? 1 : 0)} · P2 ${cnt('P2') - (sel.severity === 'P2' && sel.status !== 'resolved' ? 1 : 0)})` : '',
  ].filter(Boolean).join('\n');

  const brief: Brief = {
    title: `이슈 알림 · ${sel.title}`,
    facts: [`${sel.severity} ${sel.title}. 감지 ${det.date ? `${fmtDate(det.date)} ${det.time}` : '—'}, 상태 ${ISSUE_STATUS[sel.status]}, 담당 ${sel.assignee ?? '미배정'}.`, ...evid.slice(0, 2).map((t) => `근거: ${t}.`), `열린 이슈 ${open.length}건 (P1 ${cnt('P1')} · P2 ${cnt('P2')} · P3 ${cnt('P3')}).`],
    patterns: sel.recurrence?.count ? [`같은 유형이 최근 ${sel.recurrence.count}회 반복됐습니다 (${sel.recurrence.dates.slice(0, 3).join(', ')}).`] : [],
    interpretation: causes.length ? [`원인 후보 1순위는 '${causes[0].label}'이며 근거는 ${causes[0].basis}입니다. 규칙 엔진 순위이므로 매체 화면 확인 전에는 확정하지 않습니다.`] : [],
    conditions: [`SLA ${sel.severity}: 인지 ${SLA[sel.severity].label.ack} · 1차 조치 ${SLA[sel.severity].label.action} · 결과 보고 ${SLA[sel.severity].label.report} (p.49).`],
    counter: ['매체 집계 지연이면 다음 수집 주기에 수치가 소급 반영됩니다. 이 경우 오탐으로 기록하고 탐지 기준을 조정합니다(p.43 재발 방지).'],
    actions: [
      `담당 ${sel.assignee ?? 'AE'}는 SLA 1차 조치 시한(${sla.action.split(' (')[0]}) 전에 조치 메모를 남기고, 결과 보고는 같은 양식(p.49)으로 MILDO Alert에서 생성합니다.`,
      ...(briefDay ? [`${detOff.label} 감지 건이므로 당번 AE가 30분 내 확인하고, 브랜드팀에는 ${fmtDate(briefDay)} 09:30 이슈 브리핑에서 조치 결과까지 묶어 공유합니다(p.44 · p.48).`] : []),
    ],
  };

  return {
    type: 'issue', title: `이슈 알림 · ${sel.severity} ${sel.title}`, subtitle: meta.content, zoneLabels: { pattern: '원인 후보 · 반복 관측', action: '조치 상태 · 다음 액션' }, periodLabel: det.date ? `${fmtDate(det.date)} ${det.time} 감지` : '—',
    schedule: '감지 즉시', channel: meta.channel, nextSend: '감지 즉시', generatedAt: dataStamp(d), sections, messenger, brief, scope: `issue-${sel.id}`,
  };
}

/* ============================== 디스패처 · 출력 ============================== */

export function generateReport(type: ReportType, d: Dataset, opts: ReportOptions = {}): Report {
  switch (type) {
    case 'daily': return buildDailyReport(d, opts);
    case 'weekly': return buildWeeklyReport(d, opts);
    case 'monthly': return buildMonthlyReport(d, opts);
    case 'issue': return buildIssueReport(d, opts.incidents ?? [], opts.selectedIssueId);
  }
}

/** 섹션 코멘트 target — scope는 리포트 종류 또는 scopeOf(report) (월간 · 이슈는 대상별) */
export const commentTarget = (scope: ReportType | string, sectionId: string) => `reports:${scope}:${sectionId}`;
export const aeTarget = (scope: ReportType | string) => `reports:${scope}:ae`;

const cellText = (c: Cell) => (typeof c === 'string' ? c : c.text);
const mdEsc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
export const LEVEL_ORDER: Record<Level, number> = { danger: 0, warn: 1, info: 2, ok: 3 };
/** '담당 AE' 같은 담당자 표기에서 앞의 '담당'을 떼어 '담당: AE'처럼 중복 없이 쓴다 */
export const ownerText = (owner: string) => owner.replace(/^담당\s+(?=AE)/, '');
const levelMark: Record<Level, string> = { danger: '[위험]', warn: '[주의]', info: '[참고]', ok: '[정상]' };

export function blockToMarkdown(b: Block): string {
  switch (b.kind) {
    case 'p': return b.text;
    case 'stats': return b.items.map((s) => `**${s.label}** ${s.value}${s.delta !== undefined && fin(s.delta) ? ` (${delta(s.delta)})` : ''}`).join(' · ');
    case 'items': return b.items.map((i) => `- ${levelMark[i.level]} **${mdEsc(i.title)}** ${mdEsc(i.text)}${i.basis ? ` — 기준: ${mdEsc(i.basis)}` : ''}${i.owner ? ` — 담당: ${mdEsc(ownerText(i.owner))}` : ''}`).join('\n');
    case 'table': {
      const head = `| ${b.columns.map((c) => mdEsc(c.label)).join(' | ')} |`;
      const sep = `| ${b.columns.map((c) => (c.align === 'right' ? '---:' : '---')).join(' | ')} |`;
      const body = b.rows.map((r) => `| ${r.map((c) => mdEsc(cellText(c))).join(' | ')} |`).join('\n');
      return [head, sep, body, b.caption ? `\n_${b.caption}_` : ''].filter(Boolean).join('\n');
    }
  }
}

export interface MarkdownExtras {
  interpretation?: { text: string; by: 'ai' | 'rule' } | null;
  aeNotes?: { author: string; text: string; at: string }[];
  feedback?: { sectionTitle: string; author: string; text: string; resolved?: boolean }[];
}
export function reportToMarkdown(r: Report, extras: MarkdownExtras = {}): string {
  const out: string[] = [];
  out.push(`# ${r.title}`);
  out.push(`> ${r.subtitle} · ${r.channel} · ${r.schedule} · 생성 기준 ${r.generatedAt}${r.provisional ? ' · 잠정' : ''}`);
  out.push('> 데이터: TEST DATA (시연용 테스트 데이터 · 실제 성과 아님) · 제안서 기준값은 장표 번호 병기');
  const zones: Zone[] = ['fact', 'pattern', 'ai', 'action'];
  for (const z of zones) {
    const secs = r.sections.filter((s) => s.zone === z);
    if (z === 'ai') {
      if (extras.interpretation?.text) {
        out.push(`## ${zoneLabelOf(r, 'ai')}`);
        out.push(extras.interpretation.by === 'ai' ? '_Claude 생성 · AI 해석 — 확정 팩트와 구분해 읽습니다_' : '_규칙 엔진 해석 · AI 미연결_');
        out.push(extras.interpretation.text.replace(/^#{1,3}\s/gm, '#### '));
      }
      continue;
    }
    if (!secs.length) continue;
    out.push(`## ${zoneLabelOf(r, z)}`);
    for (const s of secs) {
      out.push(`### ${s.title}`);
      if (s.note) out.push(`_${s.note}_`);
      for (const b of s.blocks) out.push(blockToMarkdown(b));
    }
  }
  if (extras.aeNotes?.length) {
    out.push('## 담당 AE 해석 · 다음 액션');
    for (const n of extras.aeNotes) out.push(`**${n.author}** · ${n.at}\n\n${n.text}`);
  }
  if (extras.feedback?.length) {
    out.push('## 수면밀도 피드백 (코멘트 단위)');
    out.push(extras.feedback.map((f) => `- [${mdEsc(f.sectionTitle)}] ${mdEsc(f.text)} — ${f.author} · ${f.resolved ? '반영 완료' : '반영 대기'}`).join('\n'));
  }
  out.push('---');
  out.push('_보고서는 시스템이 만들고, 담당 AE는 해석과 다음 액션을 덧붙입니다 (제안서 p.17) · MILDO OS · 프로그레스미디어_');
  return out.join('\n\n');
}

/** AI 해석 요청 지시문 (ANALYST_RULES 뒤에 붙인다) */
export function aiPrompt(r: Report, md: string): string {
  return [
    `과제: 아래는 MILDO OS가 데이터로 자동 생성한 수면밀도 ${r.title} 본문(확정 팩트 · 반복 관측 패턴 · 규칙 기반 제안)이다.`,
    '리포트 하단에 붙일 해석만 작성한다. 확정 팩트를 다시 나열하지 않는다. 본문에 있는 수치만 인용하고, 수치는 시연용 TEST DATA임을 전제한다.',
    '소제목은 "### AI 해석", "### 전제 조건 · 기준값", "### 반례 · 대체 시나리오", "### 다음 액션" 네 개만 쓴다. 전체 700자 이내.',
    'CAC 회수 구조, 퍼널 내 역할(유입 / 전환 / 리텐션), 단기 성과와 중장기 효율, 확장 시 비용 구조 변화 관점으로 해석한다.',
    '',
    '[리포트 본문]',
    md.slice(0, 14000),
  ].join('\n');
}

/* ============================== 데이터 시간표 (p.18) ============================== */

export type SlotStatus = 'done' | 'now' | 'upcoming';
export interface TimetableItem {
  time: string; minutes: number; title: string; detail: string; channel: string; kind: string;
  scope: string; lead: string; owner: 'system' | 'ae'; page: string; route: string;
  status: SlotStatus; statusLabel: string;
  offMode: 'run' | 'moved' | 'duty' | 'merged' | null; offNote?: string;
  effectiveDate: string; effectiveTime: string;
  output: string; outputLevel: Level;
}
export interface Timetable {
  date: string; isToday: boolean; off: boolean; offLabel: string; forced: boolean; nowMinutes: number | null;
  nextBusinessDay: string; items: TimetableItem[]; done: number; upcoming: number;
  band: { from: number; to: number }; inBusinessHours: boolean | null;
  sends: { type: ReportType; name: string; when: string; channel: string; lead: string; next: string }[];
}
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };

export function buildTimetable(d: Dataset, opts: { date?: string; offHours?: boolean; incidents?: readonly Incident[]; changes?: readonly ChangeRequest[] } = {}): Timetable {
  const date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : d.today;
  const isToday = date === d.today;
  const offInfo = offDayOf(date);
  const forced = !!opts.offHours && !offInfo.off;
  const off = offInfo.off || !!opts.offHours;
  const nowMin = dataNowMinutes(d);
  const nbd = nextBusinessDay(date);
  const y = addDays(d.today, -1);
  const statusFor = (eDate: string, eMin: number): SlotStatus => {
    if (eDate < d.today) return 'done';
    if (eDate > d.today) return 'upcoming';
    if (nowMin >= eMin + 30) return 'done';
    if (nowMin >= eMin) return 'now';
    return 'upcoming';
  };

  // 오늘 산출물 미리보기 (데이터에서 계산)
  const outputs: Record<string, { text: string; level: Level }> = {};
  if (isToday) {
    const v = dataValidation(d, y);
    outputs['07:00'] = { text: `전일(${fmtDate(y, false)}) 매체 ${v.mediaRows}행 · 판매 채널 ${v.salesRows}행 수집 · 시간별 합계 ↔ 일 합계 차이 최대 ${pct1(v.maxDiffPct)} (허용 ±${v.tolerancePct}%)${v.missingMedia.length ? ` · 누락 ${v.missingMedia.map((m) => MEDIA[m].short).join(', ')}` : ''}`, level: v.ok ? 'ok' : 'warn' };
    const dt = totalsFor(d, y, y);
    const sales = salesTotal(d, y, y);
    outputs['08:00'] = { text: `전일 광고비 ${won(dt.cost)} · ROAS ${fmt.roas(dt.roas)} (목표 ${AD_PILOT.targetRoas}%) · 실매출 ${won(sales)} · MER ${times(merOf(sales, dt.cost))}`, level: 'info' };
    const openI = (opts.incidents ?? []).filter((i) => i.status !== 'resolved');
    const c = (s: Severity) => openI.filter((i) => i.severity === s).length;
    outputs['09:30'] = { text: `열린 이슈 ${openI.length}건 (P1 ${c('P1')} · P2 ${c('P2')} · P3 ${c('P3')})${c('P1') ? ` · P1은 ${SLA.P1.label.action} 내 1차 조치 (p.49)` : ''}`, level: c('P1') ? 'danger' : openI.length ? 'warn' : 'ok' };
    const ic = intradayCheck(d, 10);
    const worst = [...ic].filter((r) => fin(r.costDelta)).sort((a, b) => Math.abs(b.costDelta) - Math.abs(a.costDelta))[0];
    const flagged = ic.filter((r) => r.level !== 'ok');
    outputs['11:00'] = { text: flagged.length ? `기준 초과 ${flagged.length}개 매체: ${flagged.map((r) => `${MEDIA[r.media].short} 광고비 ${delta(r.costDelta)} · 전환 ${delta(r.convDelta)}`).join(' / ')} (광고비 동요일 · 동시간 ±30%, 전환 최근 7일 동시간 −30%)` : `00–10시 이상 없음 · 광고비 편차 최대 ${worst ? `${delta(worst.costDelta)} (${MEDIA[worst.media].short})` : '—'} · 기준 광고비 동요일 · 동시간 ±30%, 전환 최근 7일 동시간 −30%`, level: flagged.some((r) => r.level === 'danger') ? 'danger' : flagged.length ? 'warn' : 'ok' };
    const fc = campaignForecasts(d);
    const ff = fc.filter((f) => f.flag);
    outputs['14:00'] = { text: ff.length ? `조기 소진 예상 ${ff.length}건: ${ff.map((f) => `${f.name} ${clockOf(f.exhaustHour ?? NaN)}`).join(' · ')} (미노출 구간 매출 비중 ≥ 20%)` : '조기 소진 예상 캠페인 없음', level: ff.length ? 'warn' : 'ok' };
    const pend = (opts.changes ?? []).filter((x) => x.status === 'pending');
    const ap = adPilotSummary(d);
    const apText = `AD Pilot 조정 후보 입찰 상향 ${ap.up.length} · 하향 ${ap.down.length} · 예산 재배분 ${ap.shift.length} · 보류 ${ap.hold.length}`;
    outputs['16:30'] = { text: `${apText} · ${pend.length ? `승인 대기 ${pend.length}건 (${[...new Set(pend.map((x) => x.module))].join(' · ')}) → 익일 반영` : '승인 요청 전 (현재 승인 대기 0건)'}`, level: 'info' };
    const spent = sum(fc, (f) => f.spentToday);
    const budget = sum(fc, (f) => f.dailyBudget);
    const proj = sum(fc, (f) => Math.min(f.dailyBudget, fin(f.pace) && f.expectedShare > 0 ? f.spentToday / f.expectedShare : f.spentToday));
    outputs['17:00'] = { text: `현재 소진 ${won(spent)} / 일 예산 합계 ${won(budget)} · 예상 일 소진 ${won(proj)} (${pct1(safeDiv(proj, budget) * 100)}) · 미결 이슈 ${openI.length}건`, level: 'info' };
  }

  const items: TimetableItem[] = DATA_TIMETABLE.map((t) => {
    const meta = TIMETABLE_META[t.time] ?? { scope: '—', lead: '—', owner: 'ae' as const, offDay: 'run' as const, offNote: '', route: 'reports', page: 'p.18' };
    const minutes = toMin(t.time);
    let offMode: TimetableItem['offMode'] = null;
    let eDate = date;
    let eTime = t.time;
    if (off) {
      if (meta.offDay === 'move_next_business') { offMode = 'moved'; eDate = nbd; eTime = '09:30'; }
      else if (meta.offDay === 'alert_duty') offMode = 'duty';
      else if (meta.offDay === 'merge_next') { offMode = 'merged'; eDate = nbd; eTime = t.time; }
      else offMode = 'run';
    }
    const status = statusFor(eDate, toMin(eTime));
    const statusLabel = offMode === 'moved' ? `${fmtDate(eDate)} ${eTime} 이동` : offMode === 'merged' ? `${fmtDate(eDate)} 조정안에 병합` : status === 'done' ? '완료' : status === 'now' ? '진행 중' : '예정';
    const out = outputs[t.time] ?? { text: isToday ? '—' : date < d.today ? '해당일 산출물 (이력)' : '해당일 데이터 수집 후 생성', level: 'info' as Level };
    return {
      time: t.time, minutes, title: t.title, detail: t.detail, channel: t.channel, kind: t.kind,
      scope: meta.scope, lead: meta.lead, owner: meta.owner, page: meta.page, route: meta.route,
      status, statusLabel, offMode, offNote: off ? meta.offNote : undefined, effectiveDate: eDate, effectiveTime: eTime,
      output: out.text, outputLevel: out.level,
    };
  });
  const ns = nextSends(d);
  return {
    date, isToday, off, offLabel: offInfo.off ? offInfo.label : forced ? '주말 모드 시뮬레이션' : '평일', forced, nowMinutes: isToday ? nowMin : null,
    nextBusinessDay: nbd, items, done: items.filter((i) => i.status === 'done').length, upcoming: items.filter((i) => i.status !== 'done').length,
    band: { from: BUSINESS_HOURS.from, to: BUSINESS_HOURS.to }, inBusinessHours: isToday ? !off && nowMin >= BUSINESS_HOURS.from && nowMin < BUSINESS_HOURS.to : null,
    sends: (['issue', 'daily', 'weekly', 'monthly'] as ReportType[]).map((type) => ({ type, name: REPORT_META[type].name, when: REPORT_META[type].when, channel: REPORT_META[type].channel, lead: REPORT_META[type].lead, next: ns[type].label })),
  };
}

/* ============================== SA 업무 자동화 절감 (p.19) ============================== */

export type SavingsMode = 'ratio' | 'fixed';
export interface SavingsRow {
  task: string; how: string; route: string; moduleLabel: string;
  defaultBefore: number; defaultAfter: number; before: number; after: number; saved: number; reductionPct: number;
  measured: number | null; measuredReductionPct: number | null; edited: boolean;
}
export interface Verdict { label: string; tone: Tone; basis: string }
export interface SavingsResult {
  mode: SavingsMode; rows: SavingsRow[];
  before: number; after: number; saved: number; reductionPct: number;
  beforeHours: number; afterHours: number; savedHours: number; annualSavedHours: number; fte: number;
  floorPct: number; targetPct: number; meetsFloor: boolean; verdict: Verdict; edited: boolean;
  measured: { tasks: number; before: number; after: number; reductionPct: number; verdict: Verdict } | null;
}
const clean = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
/** 약 n시간 (반올림) */
export const aboutHours = (min: number) => (fin(min) ? Math.round(min / 60) : NaN);
/** 제안서 p.19 기준 목표 절감률 (기본값에서 계산: 1,070 → 435 = −59%) */
export const DEFAULT_TARGET_PCT = (() => {
  const b = sum(SA_AUTOMATION_SCOPE, (t) => t.before);
  const a = sum(SA_AUTOMATION_SCOPE, (t) => t.after);
  return b > 0 ? (1 - a / b) * 100 : 0;
})();

export function computeSavings(input: { before?: Record<string, number>; measured?: Record<string, number | null | undefined>; mode?: SavingsMode } = {}): SavingsResult {
  const mode: SavingsMode = input.mode ?? 'ratio';
  const rows: SavingsRow[] = SA_AUTOMATION_SCOPE.map((t) => {
    const before = clean(input.before?.[t.task], t.before);
    const ratio = t.before > 0 ? t.after / t.before : 1;
    const after = before === t.before ? t.after : mode === 'ratio' ? Math.round(before * ratio * 10) / 10 : Math.min(t.after, before);
    const mRaw = input.measured?.[t.task];
    const measured = typeof mRaw === 'number' && Number.isFinite(mRaw) && mRaw >= 0 ? mRaw : null;
    return {
      task: t.task, how: t.how, route: TASK_MODULE[t.task]?.route ?? 'reports', moduleLabel: TASK_MODULE[t.task]?.label ?? '',
      defaultBefore: t.before, defaultAfter: t.after, before, after, saved: before - after,
      reductionPct: before > 0 ? (1 - after / before) * 100 : 0,
      measured, measuredReductionPct: measured !== null && before > 0 ? (1 - measured / before) * 100 : null,
      edited: before !== t.before,
    };
  });
  const before = sum(rows, (r) => r.before);
  const after = sum(rows, (r) => r.after);
  const saved = before - after;
  const reductionPct = before > 0 ? (saved / before) * 100 : 0;
  const targetPct = DEFAULT_TARGET_PCT;
  const meetsFloor = reductionPct >= SAVINGS_FLOOR_PCT;
  const verdict: Verdict = meetsFloor
    ? { label: '하한 충족', tone: 'good', basis: `하한 −${SAVINGS_FLOOR_PCT}% 대비 목표 −${Math.round(reductionPct)}% (도입 브랜드 실적, p.11 · p.19)` }
    : { label: '하한 미달', tone: 'critical', basis: `하한 −${SAVINGS_FLOOR_PCT}% 대비 −${Math.round(reductionPct)}% — 업무 범위 · 자동화 수단 재검토` };
  const mRows = rows.filter((r) => r.measured !== null);
  let measured: SavingsResult['measured'] = null;
  if (mRows.length) {
    const mb = sum(mRows, (r) => r.before);
    const ma = sum(mRows, (r) => r.measured ?? 0);
    const mp = mb > 0 ? (1 - ma / mb) * 100 : 0;
    const tgt = mb > 0 ? (1 - sum(mRows, (r) => r.after) / mb) * 100 : 0;
    const v: Verdict = mp >= tgt - 0.05
      ? { label: '목표 달성', tone: 'good', basis: `목표 −${Math.round(tgt)}% 대비 실측 −${Math.round(mp)}% (실측 ${mRows.length}/${rows.length}개 업무)` }
      : mp >= SAVINGS_FLOOR_PCT
        ? { label: '하한 충족 · 목표 미달', tone: 'warning', basis: `하한 −${SAVINGS_FLOOR_PCT}% 이상 · 목표 −${Math.round(tgt)}% 대비 실측 −${Math.round(mp)}%` }
        : { label: '하한 미달', tone: 'critical', basis: `하한 −${SAVINGS_FLOOR_PCT}% 대비 실측 −${Math.round(mp)}% — 원인 업무 재설계` };
    measured = { tasks: mRows.length, before: mb, after: ma, reductionPct: mp, verdict: v };
  }
  return {
    mode, rows, before, after, saved, reductionPct,
    beforeHours: before / 60, afterHours: after / 60, savedHours: saved / 60, annualSavedHours: (saved * WEEKS_PER_YEAR) / 60,
    fte: saved / WEEK_MINUTES_PER_FTE, floorPct: SAVINGS_FLOOR_PCT, targetPct, meetsFloor, verdict, edited: rows.some((r) => r.edited), measured,
  };
}

/** 업무 단위 실측 판정 — 목표(업무별 절감률) · 하한 40% 대비 */
export function measuredVerdict(measuredPct: number | null, targetPct: number): Verdict | null {
  if (measuredPct === null || !fin(measuredPct)) return null;
  if (measuredPct >= targetPct - 0.05) return { label: '목표 달성', tone: 'good', basis: `목표 −${Math.round(targetPct)}% 대비 −${Math.round(measuredPct)}%` };
  if (measuredPct >= SAVINGS_FLOOR_PCT) return { label: '하한 충족', tone: 'warning', basis: `하한 −${SAVINGS_FLOOR_PCT}% · 목표 −${Math.round(targetPct)}% 대비 −${Math.round(measuredPct)}%` };
  return { label: '하한 미달', tone: 'critical', basis: `하한 −${SAVINGS_FLOOR_PCT}% 대비 −${Math.round(measuredPct)}%` };
}

/** 절감 시간 재투입 계획 — 비율 합이 100이 아니면 정규화, 합 0이면 균등 */
export function reinvestPlan(savedMinutes: number, shares: readonly { id: string; label: string; share: number }[]) {
  const s = shares.map((x) => ({ ...x, share: clean(x.share, 0) }));
  const total = sum(s, (x) => x.share);
  const saved = fin(savedMinutes) && savedMinutes > 0 ? savedMinutes : 0;
  return s.map((x) => {
    const w = total > 0 ? x.share / total : s.length ? 1 / s.length : 0;
    return { id: x.id, label: x.label, sharePct: w * 100, minutesPerWeek: saved * w, hoursPerYear: (saved * w * WEEKS_PER_YEAR) / 60 };
  });
}

/* ============================== 자동화 적용 일정 90일 (p.20) ============================== */

export function onboardingSchedule(kickoff: string) {
  const k = /^\d{4}-\d{2}-\d{2}$/.test(kickoff) && fin(Date.parse(kickoff)) ? kickoff : KICKOFF_ASSUMED;
  const ends = [30, 60, 90];
  return ONBOARDING_PHASES.map((p, i) => ({
    id: p.id, label: p.label, items: [...p.items], metric: p.metric,
    start: i === 0 ? k : addDays(k, ends[i - 1] + 1), end: addDays(k, ends[i]), day: ends[i],
  }));
}

/** 날짜 차이 (to − from, 일) — 잘못된 날짜면 NaN */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from).getTime();
  const b = parseDate(to).getTime();
  return fin(a) && fin(b) ? Math.round((b - a) / 86400000) : NaN;
}

export type PhaseStatus = 'before' | 'now' | 'done';
export interface RolloutPhase {
  id: 'd30' | 'd60' | 'd90'; label: string; items: string[]; metric: string; start: string; end: string; day: number;
  status: PhaseStatus; modules: { label: string; route: string }[];
  tasks: { task: string; saved: number; route: string; moduleLabel: string }[];
  weeklyAfter: number; reductionPct: number;
}
/**
 * p.20 자동화 적용 일정 · 90일 × p.19 절감 목표 — 단계가 끝날 때 주간 SA 업무 예상 소요(목표 기준).
 * D+30은 기존 로직 보존 단계라 절감 0, 이후 TASK_PHASE에 배치된 업무가 적용된다 (배치는 운영 가정).
 */
export function automationRollout(kickoff: string, today: string, s: SavingsResult = computeSavings()): { kickoff: string; daysToKickoff: number; confirmDate: string; phases: RolloutPhase[] } {
  const sched = onboardingSchedule(kickoff);
  const k = sched[0]?.start ?? KICKOFF_ASSUMED;
  let weekly = s.before;
  const phases = sched.map((p): RolloutPhase => {
    const id = p.id as RolloutPhase['id'];
    const tasks = id === 'd30' ? [] : s.rows.filter((r) => TASK_PHASE[r.task] === id);
    weekly -= sum(tasks, (r) => r.saved);
    const status: PhaseStatus = today < p.start ? 'before' : today > p.end ? 'done' : 'now';
    return {
      id, label: p.label, items: p.items, metric: p.metric, start: p.start, end: p.end, day: p.day, status,
      modules: MODULE_ROLLOUT[id] ? [...MODULE_ROLLOUT[id]] : [],
      tasks: tasks.map((r) => ({ task: r.task, saved: r.saved, route: r.route, moduleLabel: r.moduleLabel })),
      weeklyAfter: Math.max(0, weekly), reductionPct: s.before > 0 ? (1 - Math.max(0, weekly) / s.before) * 100 : 0,
    };
  });
  return { kickoff: k, daysToKickoff: daysBetween(today, k), confirmDate: addDays(k, SAVINGS_CONFIRM_DAYS), phases };
}

/* ============================== 리포트 발송 현황 (p.17) ============================== */

export interface CadenceStatus {
  type: ReportType; name: string; when: string; channel: string; content: string;
  /** 최근 발송 (데이터 기준 시각까지) */
  last: string | null;
  next: string;
  state: 'sent' | 'scheduled' | 'live';
  stateLabel: string;
  detail: string;
  alert: number;
}
/** 리포트 4종의 최근 발송 · 다음 발송 · 현재 상태 (데이터 기준일 · 기준 시각 기준) */
export function cadenceStatus(d: Dataset, incidents: readonly Incident[] = []): CadenceStatus[] {
  const now = dataNowMinutes(d);
  const ns = nextSends(d);
  const meta = (t: ReportType) => ({ type: t, name: REPORT_META[t].name, when: REPORT_META[t].when, channel: REPORT_META[t].channel, content: REPORT_META[t].content });
  // 일간: 오늘 08:00 이후면 오늘 발송분(전일 성과)
  const dailyLast = now >= DAILY_SEND_MIN ? d.today : addDays(d.today, -1);
  const dailyCovers = addDays(dailyLast, -1);
  // 주간: 가장 최근 월요일 10:00 (휴무면 다음 영업일)
  let mon = d.today;
  for (let i = 0; i < 8; i++) {
    const c = addDays(d.today, -i);
    if (weekday(c) === WEEKLY_SEND.weekday && (i > 0 || now >= WEEKLY_SEND.minutes)) { mon = c; break; }
  }
  const weeklyLast = isBusinessDay(mon) ? mon : nextBusinessDay(mon);
  // 월간: 이번 달 3영업일이 지났으면 이번 달, 아니면 전월
  const mk = monthKey(d.today);
  const thisMonthly = nthBusinessDay(mk, MONTHLY_BUSINESS_DAY);
  const monthlyLast = thisMonthly <= d.today ? thisMonthly : nthBusinessDay(prevMonthKey(mk), MONTHLY_BUSINESS_DAY);
  const reportedMonth = prevMonthKey(monthKey(monthlyLast));
  const open = incidents.filter((i) => i.status !== 'resolved');
  const p1 = open.filter((i) => i.severity === 'P1').length;
  const latest = [...incidents].map((i) => kst(i.detectedAt)).filter((x) => x.date).sort((a, b) => b.ms - a.ms)[0];
  const hasDaily = hasDate(d, dailyCovers);
  return [
    {
      ...meta('daily'), last: hasDaily ? `${fmtDate(dailyLast)} 08:00` : null, next: ns.daily.label, state: hasDaily ? 'sent' : 'scheduled',
      stateLabel: hasDaily ? `${fmtDate(dailyLast)} 08:00 발송 완료` : '전일 데이터 수집 대기',
      detail: hasDaily ? `${fmtDate(dailyCovers)} 성과 · ${hhmmOf(now)} 재생성 가능` : '07:00 수집 · 검증 후 발송', alert: 0,
    },
    {
      ...meta('weekly'), last: `${fmtDate(weeklyLast)} 10:00`, next: ns.weekly.label, state: 'scheduled',
      stateLabel: `다음 ${ns.weekly.label}`, detail: `최근 발송 ${fmtDate(weeklyLast)} 10:00 · 이번 주 미리보기 생성`, alert: 0,
    },
    {
      ...meta('monthly'), last: fmtDate(monthlyLast), next: ns.monthly.label, state: 'scheduled',
      stateLabel: `다음 미팅 ${fmtDate(ns.monthly.date)}`, detail: `최근 ${fmtDate(monthlyLast)} ${monthLabel(reportedMonth)} 리포트 · ${monthLabel(monthKey(addDays(d.today, -1)))} 잠정 미리보기`, alert: 0,
    },
    {
      ...meta('issue'), last: latest ? `${fmtDate(latest.date)} ${latest.time}` : null, next: '감지 즉시', state: 'live',
      stateLabel: open.length ? `열린 이슈 ${open.length}건${p1 ? ` · P1 ${p1}` : ''}` : '열린 이슈 0건',
      detail: latest ? `최근 감지 ${fmtDate(latest.date)} ${latest.time} · MILDO Alert 24시간` : 'MILDO Alert 24시간 감지 중', alert: p1,
    },
  ];
}

/* ============================== 요약 (에이전트 · 홈) ============================== */

export function decisionOwner(kind: 'ops' | 'budget' | 'rule' | 'strategy'): string {
  const idx = { ops: 0, budget: 1, rule: 2, strategy: 3 }[kind];
  return DECISION_MATRIX[idx]?.decider ?? 'PM';
}
