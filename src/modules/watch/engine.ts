/**
 * MILDO Watch 엔진 (순수 함수 · React 없음).
 *
 * 제안서 기준
 *  - p.24 매체 변동 선제 트래킹: 변동 감지 → 24시간 내 영향 진단 → 주간 리포트 실행안 → 소액 테스트 → 랩업 · 확대
 *  - p.25 오가닉 · 페이드 통합 아카이빙: 경쟁 6개사 × 6개 항목, 수집 주기, 영향도
 *  - p.28 테스트 · 인사이트 운영 루프: 주간 인사이트 브리프, 액션 후 2주 랩업 (중단 7일차 −30% · 확대 +15%)
 *  - p.47 성과 이상 징후 주의 기준을 영향 진단 기준으로 사용, p.44 매체 · 외부 환경 = P3
 *
 * 매체 공지 이벤트 · 경쟁사 스냅샷은 data.ts의 시연용 가상 데이터(DEMO)이고,
 * 영향 진단 · 데이터 감지 신호 · 침투 판정 · 테스트 판정은 모두 state.data(Dataset)에서 계산한다.
 * 기준 시각은 data.today / data.currentHour (generatedAt)이며 new Date()로 '오늘'을 정하지 않는다.
 */
import type { ChangeRequest, Dataset, Incident, IntentId, Keyword, KeywordStats, MediaId, Promotion } from '@/core/types';
import type { Brief } from '@/ai/prompts';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, CAUSE_CANDIDATES, GFA_DELEGATION, INTENT_IDS, KEYWORD_TEST_RULES, MEDIA, MEDIA_IDS, OS_SCENARIO, REPORT_CADENCE, RFP,
  SA_CAMPAIGNS, TEST_CARD_RULES,
} from '@/data/constants';
import { campaignPacing, keywordMetrics, mediaRows, previousRange, rangeOf, totalsOf } from '@/core/selectors';
import { addDays, fmt, fmtDate, isOffDay, KR_HOLIDAYS, mean, metrics, sum, twoProportionZ, weekday } from '@/core/util';
import {
  ARCHIVE_ITEMS, ARCHIVE_RECORDS, BRAND_SERP_SEEDS, EVENT_KIND_LABEL, EVENT_SEEDS, LIFE_TERM_PATTERN, MEDIA_TRACKING, PIPELINE, SEASON_KIND_LABEL,
  SEASON_WINDOWS, STAGE_INDEX, WATCH_DEFAULTS,
  type ArchiveItemId, type ArchiveRecord, type EventKind, type EventSeed, type SeasonKind, type SerpSeed, type StageId, type TestArmResult, type TestPlanSeed,
} from './data';

/* ============================== 공통 ============================== */

const HOUR = 3_600_000;
const KST = 9 * HOUR;
const pad2 = (n: number) => String(n).padStart(2, '0');
const fin = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (v: number) => Math.round(v * 10) / 10;

export type Level = 'danger' | 'warn' | 'ok' | 'info';
export type ToneKey = 'neutral' | 'good' | 'warning' | 'serious' | 'critical' | 'accent' | 'dark' | 'outline';

/** 감지 · 진단 근거 한 줄 */
export interface WatchEvidence {
  label: string;
  value: string; // 관측값 (포맷 완료)
  base?: string; // 비교 기준값
  delta?: number; // 증감률 %
  threshold?: string; // 판정 기준
  level: Level;
  note?: string;
}

/** 'YYYY-MM-DD HH:MM' · 'YYYY-MM-DD' · ISO → ms (KST 기준, 실행 환경 시간대와 무관) */
export function kstMs(s: string | undefined): number {
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00+09:00`);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/);
  if (m) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:00+09:00`);
  return Date.parse(s);
}
export function kstParts(ms: number): { date: string; hh: string; mi: string } {
  const d = new Date(ms + KST);
  return { date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`, hh: pad2(d.getUTCHours()), mi: pad2(d.getUTCMinutes()) };
}
/** ms → '2026-10-31T15:30:00+09:00' (데이터 기준 시각 기록용) */
export function kstIso(ms: number): string {
  const d = new Date(ms + KST);
  const p = kstParts(ms);
  return `${p.date}T${p.hh}:${p.mi}:${pad2(d.getUTCSeconds())}+09:00`;
}
/** ms → '10/31(토) 15:30' */
export function fmtKst(ms: number, withTime = true): string {
  if (!Number.isFinite(ms)) return '—';
  const p = kstParts(ms);
  return withTime ? `${fmtDate(p.date)} ${p.hh}:${p.mi}` : fmtDate(p.date);
}
/** 데이터 기준 시각 (generatedAt, 없으면 today currentHour:30) */
export function dataNowMs(d: Pick<Dataset, 'generatedAt' | 'today' | 'currentHour'>): number {
  const t = Date.parse(d.generatedAt);
  return Number.isFinite(t) ? t : kstMs(`${d.today} ${pad2(d.currentHour)}:30`);
}
function dayNum(date: string): number {
  const [y, m, dd] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, dd) / 86_400_000);
}
/** a − b (일) */
export function dayDiff(a: string, b: string): number {
  if (!a || !b) return NaN;
  return dayNum(a) - dayNum(b);
}
export function fmtHoursLeft(h: number): string {
  if (!Number.isFinite(h)) return '—';
  const mins = Math.round(Math.abs(h) * 60);
  const txt = mins >= 48 * 60 ? `${Math.round(mins / 1440)}일` : mins >= 60 ? `${Math.floor(mins / 60)}시간${mins % 60 ? ` ${mins % 60}분` : ''}` : `${mins}분`;
  return h < 0 ? `${txt} 초과` : `${txt} 남음`;
}

/** 다음 주간 리포트 (p.17 주간 · 월 10:00 · 메일). 월요일이 공휴일이면 다음 영업일 10:00 */
export function nextWeeklyReport(d: Pick<Dataset, 'generatedAt' | 'today' | 'currentHour'>, nowMs = dataNowMs(d)): { date: string; ms: number; label: string } {
  const cad = REPORT_CADENCE.find((c) => c.id === 'weekly');
  const hhmm = cad?.when.match(/(\d{2}:\d{2})/)?.[1] ?? '10:00';
  let date = d.today;
  for (let i = 0; i < 21; i++) {
    if (weekday(date) === 1) {
      let rd = date;
      for (let k = 0; k < 7 && isOffDay(rd).off; k++) rd = addDays(rd, 1);
      const ms = kstMs(`${rd} ${hhmm}`);
      if (ms > nowMs) return { date: rd, ms, label: `${fmtDate(rd)} ${hhmm} 주간 리포트 (${cad?.channel ?? '메일'})` };
    }
    date = addDays(date, 1);
  }
  return { date: addDays(d.today, 7), ms: NaN, label: '다음 주간 리포트' };
}

/* ============================== 설정 ============================== */

type AnomKey = 'cost' | 'clicks' | 'conversions' | 'cpa' | 'roas';
export interface WatchConfig {
  diagnoseSlaHours: number;
  kwRecentDays: number;
  kwCpcUpPct: number;
  kwMinClicks: number;
  mediaSpikePct: number;
  mediaWindowHours: number;
  brandRankMax: number;
  brandLostMin: number;
  lifeMinConv: number;
  lifeMinTerms: number;
  trackingZeroHours: number;
  testBudgetShare: number;
  testDays: number;
  testMinClicks: number;
  promoShareShiftPct: number;
  searchShiftPct: number;
  stopDay: number;
  stopCvrDropPct: number;
  expandCvrLiftPct: number;
  targetRoas: number;
  brandTargetRoas: number;
  adPilotHoldPct: number;
  warn: Record<AnomKey, number>;
  danger: Record<AnomKey, number>;
}

export function resolveWatchConfig(p: Partial<WatchConfig> = {}): WatchConfig {
  const warn = { cost: 30, clicks: 30, conversions: 30, cpa: 30, roas: 20 } as Record<AnomKey, number>;
  const danger = { cost: 50, clicks: 50, conversions: 50, cpa: 50, roas: 35 } as Record<AnomKey, number>;
  for (const t of ANOMALY_THRESHOLDS) {
    warn[t.metric as AnomKey] = t.warnPct;
    danger[t.metric as AnomKey] = t.dangerPct;
  }
  return {
    ...WATCH_DEFAULTS,
    testMinClicks: KEYWORD_TEST_RULES.minClicks,
    testDays: TEST_CARD_RULES.days,
    stopDay: TEST_CARD_RULES.stopDay,
    stopCvrDropPct: TEST_CARD_RULES.stopCvrDropPct,
    expandCvrLiftPct: TEST_CARD_RULES.expandCvrLiftPct,
    targetRoas: AD_PILOT.targetRoas,
    brandTargetRoas: AD_PILOT.brandTargetRoas,
    adPilotHoldPct: AD_PILOT.anomalyHoldPct,
    warn,
    danger,
    ...p,
  };
}

function lvUp(delta: number, warn: number, danger: number): Level {
  if (!fin(delta)) return 'info';
  return delta >= danger ? 'danger' : delta >= warn ? 'warn' : 'ok';
}
function lvDown(delta: number, warn: number, danger: number): Level {
  if (!fin(delta)) return 'info';
  return delta <= -danger ? 'danger' : delta <= -warn ? 'warn' : 'ok';
}
function lvBoth(delta: number, warn: number, danger: number): Level {
  if (!fin(delta)) return 'info';
  const a = Math.abs(delta);
  return a >= danger ? 'danger' : a >= warn ? 'warn' : 'ok';
}

/* ============================== 데이터 계산 헬퍼 ============================== */

function aggStats(rows: readonly KeywordStats[]): KeywordStats {
  return {
    impressions: sum(rows, (r) => r.impressions),
    clicks: sum(rows, (r) => r.clicks),
    cost: sum(rows, (r) => r.cost),
    conversions: sum(rows, (r) => r.conversions),
    revenue: sum(rows, (r) => r.revenue),
  };
}

/** 키워드 최근 N일 vs 그 이전 일자 (일별 daily 기준) — CPC · 일 평균 전환 변화 */
export function keywordRecentShift(k: Keyword, days: number = WATCH_DEFAULTS.kwRecentDays) {
  const n = k.daily?.length ?? 0;
  if (n < days + 3) return null;
  const recent = aggStats(k.daily.slice(n - days));
  const prior = aggStats(k.daily.slice(0, n - days));
  const priorDays = n - days;
  const cpcRecent = metrics.cpc(recent.cost, recent.clicks);
  const cpcPrior = metrics.cpc(prior.cost, prior.clicks);
  const convRecent = recent.conversions / days;
  const convPrior = prior.conversions / priorDays;
  return {
    days, priorDays,
    recentClicks: recent.clicks,
    cpcRecent, cpcPrior,
    cpcDelta: fin(cpcRecent) && fin(cpcPrior) ? metrics.pctChange(cpcRecent, cpcPrior) : NaN,
    convRecent, convPrior,
    convDelta: priorDays > 0 && convPrior > 0 ? metrics.pctChange(convRecent, convPrior) : NaN,
  };
}

/** 오늘 최근 N시간 매체 지표 vs 동요일 · 동시간(최근 4주) 평균 / 전환은 최근 7일 동시간 평균 (p.47 기준선) */
export function mediaHourWindow(d: Dataset, media: MediaId, hours: number = WATCH_DEFAULTS.mediaWindowHours) {
  const h1 = d.currentHour;
  const h0 = Math.max(0, h1 - Math.max(1, hours) + 1);
  const pick = (date: string) => d.mediaHourly.filter((r) => r.date === date && r.media === media && r.hour >= h0 && r.hour <= h1);
  const today = pick(d.today);
  const sameWd = [7, 14, 21, 28].map((n) => pick(addDays(d.today, -n))).filter((rows) => rows.length > 0);
  const last7 = [1, 2, 3, 4, 5, 6, 7].map((n) => pick(addDays(d.today, -n))).filter((rows) => rows.length > 0);
  const cost = sum(today, (r) => r.cost);
  const clicks = sum(today, (r) => r.clicks);
  const conv = sum(today, (r) => r.conversions);
  const baseCost = mean(sameWd.map((rows) => sum(rows, (r) => r.cost)));
  const baseClicks = mean(sameWd.map((rows) => sum(rows, (r) => r.clicks)));
  const baseConv = mean(last7.map((rows) => sum(rows, (r) => r.conversions)));
  const ch = (a: number, b: number) => (fin(b) && b > 0 ? metrics.pctChange(a, b) : NaN);
  return {
    h0, h1, hasToday: today.length > 0, baseDays: sameWd.length,
    cost, baseCost, costDelta: ch(cost, baseCost),
    clicks, baseClicks, clicksDelta: ch(clicks, baseClicks),
    conv, baseConv, convDelta: ch(conv, baseConv),
  };
}

/** 연속 전환 0 시간 (클릭은 정상) — p.45 전환 추적 단절 패턴. 진단을 보류할 근거로만 쓴다 (탐지는 MILDO Alert) */
export function trackingZero(d: Dataset, media: MediaId) {
  let zeroHours = 0;
  let since: number | null = null;
  let clicksOk = true;
  for (let h = d.currentHour; h >= 0; h--) {
    const row = d.mediaHourly.find((r) => r.date === d.today && r.media === media && r.hour === h);
    if (!row || row.conversions > 0 || row.clicks <= 0) break;
    const base = [1, 2, 3, 4, 5, 6, 7]
      .map((n) => d.mediaHourly.find((r) => r.date === addDays(d.today, -n) && r.media === media && r.hour === h))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const baseConv = mean(base.map((r) => r.conversions));
    const baseClicks = mean(base.map((r) => r.clicks));
    if (!fin(baseConv) || baseConv <= 0) break; // 평소에도 전환이 없는 시간대는 단절 근거가 아님
    if (fin(baseClicks) && baseClicks > 0 && row.clicks < baseClicks * 0.5) clicksOk = false;
    zeroHours++;
    since = h;
  }
  return { zeroHours, since, clicksOk };
}

function mediaWeek(d: Dataset, media: MediaId) {
  const r = rangeOf(d, 'last7');
  const p = previousRange(r);
  const cur = totalsOf(mediaRows(d, r.from, r.to, media));
  const prev = totalsOf(mediaRows(d, p.from, p.to, media));
  return {
    range: r, cur, prev,
    costDelta: prev.cost > 0 ? metrics.pctChange(cur.cost, prev.cost) : NaN,
    roasDelta: fin(cur.roas) && fin(prev.roas) ? metrics.pctChange(cur.roas, prev.roas) : NaN,
    cpaDelta: fin(cur.cpa) && fin(prev.cpa) ? metrics.pctChange(cur.cpa, prev.cpa) : NaN,
  };
}

function nameOfMedia(m: MediaId): string {
  return MEDIA_TRACKING.find((t) => t.media === m)?.name ?? MEDIA[m]?.name ?? m;
}

/* ============================== 이벤트 ============================== */

export interface ProgressLog { at: string; by: string; action: string; note?: string }

export interface WatchEvent {
  id: string;
  origin: 'notice' | 'signal';
  media: MediaId;
  kind: EventKind;
  title: string;
  summary: string;
  source: string; // 감지 경로
  detectedAt: string; // 'YYYY-MM-DD HH:MM' KST
  initialStage: StageId;
  keywords: string[];
  intents: IntentId[];
  campaigns: string[];
  accountId?: string;
  plan: string;
  test?: TestPlanSeed;
  seedLog: ProgressLog[];
  /** 데이터 감지 신호 근거 */
  signal?: { rule: string; basis: string; page: string; evidence: WatchEvidence[]; causes: CauseScore[] };
  related: string[];
  archiveRefs: string[];
  /** p.23 작동 시나리오 D+0 연결 (수요 변화 신호) */
  scenario?: boolean;
}
export interface CauseScore { label: string; score: number; basis: string }

function fromSeed(s: EventSeed): WatchEvent {
  return {
    id: s.id, origin: 'notice', media: s.media, kind: s.kind, title: s.title, summary: s.summary, source: s.source,
    detectedAt: s.detectedAt, initialStage: s.stage, keywords: [...(s.keywords ?? [])], intents: [...(s.intents ?? [])],
    campaigns: [...(s.campaigns ?? [])], accountId: s.accountId, plan: s.plan, test: s.test, seedLog: [...(s.log ?? [])],
    related: [], archiveRefs: [],
  };
}

function saCampaignOf(d: Dataset, intent: IntentId): string | undefined {
  return d.campaigns.find((c) => c.media === 'naver_sa' && c.intent === intent)?.name;
}

/**
 * 데이터 감지 신호 — state.data에서 계산한다 (하드코딩 결과 아님).
 *  - 키워드 CPC 선제 감지: 최근 3일 CPC +30% 이상 (최근 3일 클릭 30 이상)
 *  - 매체 지출 로직 변화 후보: 오늘 최근 2시간 광고비 · 클릭 동요일 · 동시간 대비 ±50% (p.44)
 *  - 브랜드 키워드 지면 침투 의심: 평균 순위 ≥ 2.0 또는 노출 기회 손실 ≥ 20%
 *  - 생활 상황 수요 변화: 검색어 보고서 미등록 생활 상황 구문형 (전환 ≥ 1) 2개 이상 또는 신규 노출 키워드
 *  - 브랜드 검색량 급변: 전일 vs 최근 4주 동요일 평균 ±30%
 */
export function detectSignals(d: Dataset, cfg: WatchConfig = resolveWatchConfig(), records: readonly ArchiveRecord[] = ARCHIVE_RECORDS): WatchEvent[] {
  const out: WatchEvent[] = [];
  const nowP = kstParts(dataNowMs(d));
  const nowStr = `${nowP.date} ${nowP.hh}:${nowP.mi}`;
  const collectStr = `${d.today} 07:00`; // p.18 전일 데이터 수집 · 검증 완료 시각
  const recentFrom = addDays(d.today, -7);

  // 키워드 CPC 선제 감지
  for (const k of d.keywords) {
    if (k.isBrand) continue;
    const s = keywordRecentShift(k, cfg.kwRecentDays);
    if (!s || s.recentClicks < cfg.kwMinClicks || !fin(s.cpcDelta) || s.cpcDelta < cfg.kwCpcUpPct) continue;
    const serpHits = records.filter((r) => r.item === 'serp' && r.serp?.keyword === k.text && r.date >= recentFrom && r.date <= d.today && r.competitor);
    const hold = Math.abs(s.cpcDelta) >= cfg.adPilotHoldPct || (fin(s.convDelta) && Math.abs(s.convDelta) >= cfg.adPilotHoldPct);
    const ev: WatchEvidence[] = [
      { label: `'${k.text}' CPC (최근 ${s.days}일)`, value: fmt.won(s.cpcRecent), base: `직전 ${s.priorDays}일 ${fmt.won(s.cpcPrior)}`, delta: s.cpcDelta, threshold: `+${cfg.kwCpcUpPct}% 이상 선제 감지 · ±${cfg.adPilotHoldPct}% AD Pilot 보류 (p.14)`, level: lvUp(s.cpcDelta, cfg.kwCpcUpPct, cfg.adPilotHoldPct) },
      { label: '일 평균 전환', value: `${fmt.dec1(s.convRecent)}건`, base: `직전 ${fmt.dec1(s.convPrior)}건`, delta: s.convDelta, threshold: `−${cfg.warn.conversions}% 주의 (p.47)`, level: lvDown(s.convDelta, cfg.warn.conversions, cfg.danger.conversions) },
    ];
    const causes: CauseScore[] = [
      { label: CAUSE_CANDIDATES[0], score: serpHits.length ? 80 : 55, basis: serpHits.length ? `아카이브 ${serpHits.map((h) => `${fmtDate(h.date)} ${h.competitor} ${h.serp?.position}위`).join(' · ')} — CPC 상승 구간과 겹침` : 'CPC 상승 · 클릭 유지 패턴 (경쟁 입찰 상승 시 전형적)' },
      { label: '노출 로직 변화', score: 40, basis: '같은 기간 네이버 SA 공지 이벤트 여부를 함께 확인' },
      { label: CAUSE_CANDIDATES[3], score: 15, basis: '일 단위 수집 지연이면 다음 수집(07:00)에서 해소' },
    ];
    out.push({
      id: `sig_kw_cpc:${k.id}`, origin: 'signal', media: 'naver_sa', kind: 'competitor',
      title: `'${k.text}' CPC ${fmt.delta(s.cpcDelta, 0)} · 전환 ${fmt.delta(s.convDelta, 0)} (최근 ${s.days}일)`,
      summary: `${SA_CAMPAIGNS[k.intent]?.name ?? k.intent} 키워드의 클릭 단가가 직전 ${s.priorDays}일 대비 올랐다. 순위 모니터링 · 경쟁사 지면 스냅샷과 대조해 원인을 분리한다.${hold ? ' AD Pilot 성과 급변 기준(±50%) 도달 — 자동 조정 보류 대상.' : ''}`,
      source: '순위 · CPC 모니터링 (데이터 감지)', detectedAt: collectStr, initialStage: 'detect',
      keywords: [k.text], intents: [k.intent], campaigns: [saCampaignOf(d, k.intent)].filter((x): x is string => !!x),
      plan: hold ? 'AD Pilot 자동 조정 보류 유지 → 경쟁사 지면 스냅샷 대조 → 입찰 상한 · 랜딩 재점검안을 주간 리포트로' : '경쟁사 지면 스냅샷 대조 → 입찰 상한 재점검안을 주간 리포트로',
      test: { hypothesis: `'${k.text}'를 비교 · 검토 랜딩으로 분리하면 CPC 상승 구간에서도 전환율을 유지한다`, arms: '리뷰 · 비교 랜딩 광고그룹 vs 기존 상품 상세 랜딩', metric: '전환율 · CPA' },
      seedLog: [{ at: `${d.today}T07:00:00+09:00`, by: 'MILDO Watch', action: '감지 · 키워드 CPC 모니터링' }],
      signal: { rule: 'kw_cpc', basis: `최근 ${cfg.kwRecentDays}일 CPC +${cfg.kwCpcUpPct}% 이상 · 클릭 ${cfg.kwMinClicks} 이상 (운영 가정)`, page: 'p.24 · p.14', evidence: ev, causes },
      related: [], archiveRefs: serpHits.map((h) => h.id),
    });
  }

  // 매체 지출 로직 변화 후보 (오늘 최근 N시간)
  for (const m of MEDIA_IDS) {
    const w = mediaHourWindow(d, m, cfg.mediaWindowHours);
    if (!w.hasToday || w.baseDays < 2) continue;
    const hitCost = fin(w.costDelta) && Math.abs(w.costDelta) >= cfg.mediaSpikePct;
    const hitClicks = fin(w.clicksDelta) && Math.abs(w.clicksDelta) >= cfg.mediaSpikePct;
    if (!hitCost && !hitClicks) continue;
    const pace = campaignPacing(d).filter((c) => c.media === m);
    const early = pace.filter((c) => c.earlyExhaust);
    const up = (hitCost ? w.costDelta : w.clicksDelta) > 0;
    const ev: WatchEvidence[] = [
      { label: `광고비 ${w.h0}~${w.h1}시`, value: `${fmt.krw(w.cost)}원`, base: `동요일 · 동시간 ${fmt.krw(w.baseCost)}원`, delta: w.costDelta, threshold: `±${cfg.mediaSpikePct}% (p.44)`, level: lvBoth(w.costDelta, cfg.warn.cost, cfg.danger.cost) },
      { label: `클릭 ${w.h0}~${w.h1}시`, value: fmt.int(w.clicks), base: `동요일 · 동시간 ${fmt.int(w.baseClicks)}`, delta: w.clicksDelta, threshold: `±${cfg.mediaSpikePct}% (p.44)`, level: lvBoth(w.clicksDelta, cfg.warn.clicks, cfg.danger.clicks) },
      { label: `전환 ${w.h0}~${w.h1}시`, value: `${fmt.dec1(w.conv)}건`, base: `최근 7일 동시간 ${fmt.dec1(w.baseConv)}건`, delta: w.convDelta, threshold: `−${cfg.warn.conversions}% 주의 (p.47)`, level: lvDown(w.convDelta, cfg.warn.conversions, cfg.danger.conversions) },
    ];
    for (const c of early) ev.push({ label: `${c.name} 일 예산 소진`, value: fmt.pct(c.pacePct, 0), base: `예상 마감 ${fmt.dec1(c.exhaustHour ?? NaN)}시`, threshold: '23시 이전 마감 = 조기 소진', level: 'warn' });
    out.push({
      id: `sig_media_spike:${m}:${d.today}`, origin: 'signal', media: m, kind: 'logic',
      title: `${nameOfMedia(m)} 오늘 ${w.h0}~${w.h1}시 광고비 ${fmt.delta(w.costDelta, 0)} · 전환 ${fmt.delta(w.convDelta, 0)} (동요일 · 동시간 대비)`,
      summary: up
        ? '지출 속도가 평소 같은 시간대보다 빠르다. 매체 측 자동 확장 · 입찰 로직 변화 여부를 업데이트 노트와 대조하고, 원인 확인 전에는 증액하지 않는다. 데이터 급변 이슈는 MILDO Alert와 같은 근거로 처리한다.'
        : '지출이 평소 같은 시간대보다 크게 줄었다. 노출 제한 · 정책 변화 여부를 확인한다.',
      source: '시간대별 수집 · 동요일 동시간 비교 (데이터 감지)', detectedAt: nowStr, initialStage: 'detect',
      keywords: [], intents: [], campaigns: (early.length ? early : pace).map((c) => c.name),
      plan: '업데이트 노트 · 계정 진단으로 매체 측 변화 여부 확인 → 원인 확인 전 증액 보류 · MILDO Alert 데이터 급변 이슈와 함께 보고',
      test: { hypothesis: '자동 확장 범위를 제한한 광고세트가 기존 대비 CPA를 유지한다', arms: '확장 제한 광고세트 vs 기존 광고세트', metric: 'CPA · 신규 비중' },
      seedLog: [{ at: `${nowP.date}T${nowP.hh}:${nowP.mi}:00+09:00`, by: 'MILDO Watch', action: '감지 · 시간대별 지출 모니터링' }],
      signal: {
        rule: 'media_spike', basis: `오늘 최근 ${cfg.mediaWindowHours}시간 광고비 · 클릭 동요일 · 동시간 평균 대비 ±${cfg.mediaSpikePct}%`, page: 'p.24 · p.44 · p.47', evidence: ev,
        causes: [
          { label: '매체 정책 · 기능 변화', score: 50, basis: '같은 매체 최근 공지 이벤트와 시기 대조' },
          { label: CAUSE_CANDIDATES[0], score: 35, basis: '클릭 단가 변화 동반 여부 확인' },
          { label: CAUSE_CANDIDATES[3], score: 20, basis: '시간대 집계 지연이면 다음 수집에서 해소' },
        ],
      },
      related: [], archiveRefs: [],
    });
  }

  // 브랜드 키워드 지면 침투 의심
  const brandKw = d.keywords.filter((k) => k.isBrand && (k.avgRank >= cfg.brandRankMax || k.impressionShareLost >= cfg.brandLostMin));
  if (brandKw.length) {
    const ranks = brandKw.map((k) => k.avgRank);
    const refs = records.filter((r) => r.item === 'serp' && r.competitor && brandKw.some((k) => k.text === r.serp?.keyword) && r.date >= recentFrom && r.date <= d.today);
    out.push({
      id: `sig_brand_serp:${d.today}`, origin: 'signal', media: 'naver_sa', kind: 'competitor',
      title: `브랜드 키워드 ${brandKw.length}개 검색 결과 다른 광고 상위 노출 의심 (평균 순위 ${fmt.dec1(Math.min(...ranks))}~${fmt.dec1(Math.max(...ranks))}위)`,
      summary: '자사 브랜드 검색 결과에서 자사 광고 평균 순위가 1위가 아니다. 브랜드 지면 스냅샷으로 경쟁사 침투 여부를 확인하고, 방어 입찰은 AD Pilot 브랜드 기준(목표 ROAS 800% · 순위 방어 우선)으로 판단한다.',
      source: '브랜드 지면 점검 · 순위 모니터링 (데이터 감지)', detectedAt: collectStr, initialStage: 'detect',
      keywords: brandKw.map((k) => k.text), intents: ['brand'], campaigns: [saCampaignOf(d, 'brand')].filter((x): x is string => !!x),
      plan: '브랜드 방어 입찰 검토 → AD Pilot 조정 후보 (브랜드 목표 ROAS 800% · 순위 방어 우선)',
      test: { hypothesis: '브랜드 키워드 입찰을 상향한 그룹이 순위 1위를 유지하면서 브랜드 ROAS 800% 이상을 지킨다', arms: '방어 입찰 상향 그룹 vs 기존 입찰', metric: '평균 순위 · 브랜드 ROAS' },
      seedLog: [{ at: `${d.today}T07:00:00+09:00`, by: 'MILDO Watch', action: '감지 · 브랜드 지면 점검' }],
      signal: {
        rule: 'brand_serp', basis: `브랜드 키워드 평균 순위 ≥ ${cfg.brandRankMax.toFixed(1)} 또는 노출 기회 손실 ≥ ${Math.round(cfg.brandLostMin * 100)}%`, page: 'p.25 · p.45',
        evidence: brandKw.map((k) => ({ label: `'${k.text}' 평균 순위`, value: `${fmt.dec1(k.avgRank)}위`, base: `노출 기회 손실 ${fmt.ratio(k.impressionShareLost, 0)}`, threshold: `순위 ≥ ${cfg.brandRankMax.toFixed(1)} · 손실 ≥ ${Math.round(cfg.brandLostMin * 100)}%`, level: (k.avgRank >= cfg.brandRankMax + 1 ? 'danger' : 'warn') as Level })),
        causes: [
          { label: '경쟁사 브랜드 키워드 입찰', score: refs.length ? 85 : 60, basis: refs.length ? `아카이브 ${refs.map((r) => `${r.competitor} '${r.serp?.keyword}' ${r.serp?.position}위`).join(' · ')}` : '평균 순위 하락 패턴' },
          { label: '자사 입찰가 · 품질지수 변화', score: 30, basis: '최근 입찰 변경 이력 (MILDO Flow) 확인' },
        ],
      },
      related: [], archiveRefs: refs.map((r) => r.id),
    });
  }

  // 생활 상황 수요 변화 (p.23 D+0 시나리오)
  const lifeTerms = d.searchTerms.filter((t) => !t.registered && LIFE_TERM_PATTERN.test(t.term) && t.conversions >= cfg.lifeMinConv);
  const newKw = d.keywords.filter((k) => k.prev14.impressions === 0 && k.last14.impressions > 0);
  if (lifeTerms.length >= cfg.lifeMinTerms || newKw.length > 0) {
    const conv = sum(lifeTerms, (t) => t.conversions);
    const clicks = sum(lifeTerms, (t) => t.clicks);
    const extRefs = records.filter((r) => r.item === 'external' && r.date >= addDays(d.today, -14) && r.date <= d.today);
    const ev: WatchEvidence[] = lifeTerms.map((t) => ({
      label: `미등록 '${t.term}'`, value: `전환 ${fmt.dec1(t.conversions)}건`, base: `클릭 ${fmt.int(t.clicks)} · CVR ${fmt.pct(metrics.cvr(t.conversions, t.clicks))}`,
      threshold: `미등록 · 전환 ≥ ${cfg.lifeMinConv}`, level: 'warn' as Level,
    }));
    for (const k of newKw) ev.push({ label: `신규 노출 '${k.text}'`, value: `노출 ${fmt.int(k.last14.impressions)}`, base: '직전 14일 노출 0', threshold: '직전 14일 0 → 최근 14일 노출 발생', level: 'warn' });
    out.push({
      id: `sig_life_demand:${d.today}`, origin: 'signal', media: 'naver_sa', kind: 'demand', scenario: true,
      title: `생활 상황 구문형 검색어 유입 — 미등록 ${lifeTerms.length}개 · 전환 ${fmt.dec1(conv)}건${newKw.length ? ` · 신규 노출 '${newKw[0].text}'` : ''}`,
      summary: '신혼 · 이사 · 첫 독립 · 선물 같은 생활 변화 상황의 구문형 검색어가 등록되지 않은 채 전환을 만들고 있다. p.23 작동 시나리오 D+0 (MILDO Watch 감지) → D+1 AD Pilot 확장 후보로 이어진다.',
      source: '검색어 보고서 · 신규 키워드 노출 (데이터 감지)', detectedAt: collectStr, initialStage: 'detect',
      keywords: [...newKw.map((k) => k.text), ...d.keywords.filter((k) => k.intent === 'life' && k.status === 'on').map((k) => k.text)].slice(0, 6),
      intents: ['life'], campaigns: [saCampaignOf(d, 'life')].filter((x): x is string => !!x),
      plan: '구문형 후보를 MILDO Lab 테스트 그룹으로 등록 · 생활 상황 캠페인 예산 · 랜딩(사이즈 비교) 점검',
      test: { hypothesis: '생활 상황 구문형 후보를 테스트 전용 그룹으로 등록하면 기존 생활 상황 그룹 대비 전환율이 같거나 높다', arms: '구문형 후보 테스트 그룹 vs 기존 생활 상황 그룹', metric: '전환율 · ROAS', days: 14 },
      seedLog: [{ at: `${d.today}T07:00:00+09:00`, by: 'MILDO Watch', action: '감지 · 검색어 보고서 · 신규 노출' }],
      signal: {
        rule: 'life_demand', basis: `미등록 생활 상황 구문형(전환 ≥ ${cfg.lifeMinConv}) ${cfg.lifeMinTerms}개 이상 또는 직전 14일 0 → 노출 발생 키워드`, page: 'p.23 · p.24 · p.36', evidence: ev,
        causes: [
          { label: '시즌 수요 (가을 혼인 · 이사, 가설)', score: 55, basis: '시즌 캘린더 · 외부 변수 아카이브 대조 — 검색 트렌드 연동 전 가설' },
          { label: '검색 결과 노출 확대 (매체 측)', score: 25, basis: '같은 기간 네이버 SA 기능 이벤트 여부' },
        ],
      },
      related: [], archiveRefs: extRefs.map((r) => r.id),
    });
    void clicks;
  }

  // 브랜드 검색량 급변 (외부 변수)
  const bs = brandSearchTrend(d, 28, cfg);
  if (bs.yesterday && fin(bs.yesterday.deltaPct) && Math.abs(bs.yesterday.deltaPct) >= cfg.searchShiftPct) {
    const y = bs.yesterday;
    out.push({
      id: `sig_brand_search:${y.date}`, origin: 'signal', media: 'naver_sa', kind: 'demand',
      title: `브랜드 검색량 ${fmt.delta(y.deltaPct, 0)} (${fmtDate(y.date)} vs 최근 4주 동요일)`,
      summary: '브랜드 검색량이 평소 같은 요일 대비 크게 달라졌다. GFA 집행 · 경쟁사 프로모션 · 외부 이슈와 시기를 대조한다.',
      source: '브랜드 검색량 수집 (데이터 감지)', detectedAt: collectStr, initialStage: 'detect',
      keywords: d.keywords.filter((k) => k.isBrand).map((k) => k.text), intents: ['brand'], campaigns: [saCampaignOf(d, 'brand')].filter((x): x is string => !!x),
      plan: 'GFA 집행 강도 · 경쟁사 아카이브 대조 → 브랜드 방어 예산 점검',
      seedLog: [{ at: `${d.today}T07:00:00+09:00`, by: 'MILDO Watch', action: '감지 · 브랜드 검색량' }],
      signal: { rule: 'brand_search', basis: `전일 vs 최근 4주 동요일 평균 ±${cfg.searchShiftPct}%`, page: 'p.25 · p.44', evidence: [{ label: '브랜드 검색량', value: fmt.int(y.volume), base: `동요일 평균 ${fmt.int(y.base)}`, delta: y.deltaPct, threshold: `±${cfg.searchShiftPct}%`, level: 'danger' }], causes: [{ label: '외부 변수 · 프로모션', score: 50, basis: '시즌 캘린더 · 아카이브 대조' }] },
      related: [], archiveRefs: [],
    });
  }
  return out;
}

/** 공지 이벤트(시드) + 데이터 감지 신호 → 관련 이벤트 · 아카이브 연결 */
export function buildEvents(d: Dataset, cfg: WatchConfig = resolveWatchConfig(), seeds: readonly EventSeed[] = EVENT_SEEDS, records: readonly ArchiveRecord[] = ARCHIVE_RECORDS): WatchEvent[] {
  const notices = seeds.map(fromSeed);
  const signals = detectSignals(d, cfg, records);
  const all = [...notices, ...signals];
  for (const e of all) {
    const t = kstMs(e.detectedAt);
    e.related = all.filter((o) => o.id !== e.id && o.media === e.media && Math.abs(kstMs(o.detectedAt) - t) <= 7 * 24 * HOUR).map((o) => o.id);
    if (e.origin === 'notice' && e.keywords.length) {
      const refs = records.filter((r) => r.serp && e.keywords.includes(r.serp.keyword) && Math.abs(dayDiff(r.date, e.detectedAt.slice(0, 10))) <= 7).map((r) => r.id);
      e.archiveRefs = [...new Set([...e.archiveRefs, ...refs])];
    }
  }
  return all.sort((a, b) => kstMs(b.detectedAt) - kstMs(a.detectedAt));
}

/* ============================== 영향 진단 (24시간 내) ============================== */

export type Verdict = 'high' | 'impact' | 'watch' | 'hold' | 'nodata';
export const VERDICT_META: Record<Verdict, { label: string; tone: ToneKey; icon: string; rank: number }> = {
  high: { label: '영향 큼', tone: 'serious', icon: 'alert', rank: 4 },
  impact: { label: '영향 있음', tone: 'warning', icon: 'alert', rank: 3 },
  hold: { label: '진단 보류 · 데이터 이상', tone: 'critical', icon: 'shield', rank: 2 },
  watch: { label: '영향 미미 · 관찰', tone: 'neutral', icon: 'watch', rank: 1 },
  nodata: { label: '데이터 없음', tone: 'outline', icon: 'inbox', rank: 0 },
};

export interface Diagnosis {
  verdict: Verdict;
  label: string;
  basis: string; // 배지 옆 근거 (기준값 포함)
  evidence: WatchEvidence[];
  affected: { keywords: number; spendPerDay: number; revenuePerDay: number; impressionsPerDay: number; scope: string };
  holdReason?: string;
  causes: CauseScore[];
  week: { roas: number; roasDelta: number; cpa: number; cpaDelta: number; cost: number; costDelta: number; rangeLabel: string };
}

export function evidenceLine(e: WatchEvidence): string {
  const parts = [`${e.label} ${e.value}`];
  if (e.base) parts.push(e.base);
  if (fin(e.delta)) parts.push(fmt.delta(e.delta, 0));
  if (e.threshold) parts.push(`기준 ${e.threshold}`);
  return parts.join(' · ');
}

export function diagnoseEvent(ev: WatchEvent, d: Dataset, cfg: WatchConfig = resolveWatchConfig()): Diagnosis {
  const evidence: WatchEvidence[] = [...(ev.signal?.evidence ?? [])];
  const wk = mediaWeek(d, ev.media);
  const week = { roas: wk.cur.roas, roasDelta: wk.roasDelta, cpa: wk.cur.cpa, cpaDelta: wk.cpaDelta, cost: wk.cur.cost, costDelta: wk.costDelta, rangeLabel: `${fmtDate(wk.range.from, false)}~${fmtDate(wk.range.to, false)}` };
  const name = nameOfMedia(ev.media);
  const noData = wk.cur.cost <= 0 && wk.prev.cost <= 0;

  if (!noData) {
    evidence.push(
      { label: `${name} 광고비 7일`, value: `${fmt.krw(wk.cur.cost)}원`, base: `직전 7일 ${fmt.krw(wk.prev.cost)}원`, delta: wk.costDelta, threshold: `±${cfg.warn.cost}% 주의 (p.47)`, level: lvBoth(wk.costDelta, cfg.warn.cost, cfg.danger.cost) },
      { label: `${name} ROAS 7일`, value: fmt.roas(wk.cur.roas), base: `직전 7일 ${fmt.roas(wk.prev.roas)}`, delta: wk.roasDelta, threshold: `−${cfg.warn.roas}% 주의 (p.47)`, level: lvDown(wk.roasDelta, cfg.warn.roas, cfg.danger.roas) },
      { label: `${name} CPA 7일`, value: fmt.won(wk.cur.cpa), base: `직전 7일 ${fmt.won(wk.prev.cpa)}`, delta: wk.cpaDelta, threshold: `+${cfg.warn.cpa}% 주의 (p.47)`, level: lvUp(wk.cpaDelta, cfg.warn.cpa, cfg.danger.cpa) },
    );
    if (!ev.signal || ev.signal.rule !== 'media_spike') {
      const w = mediaHourWindow(d, ev.media, cfg.mediaWindowHours);
      if (w.hasToday && w.baseDays >= 2) {
        evidence.push({ label: `오늘 ${w.h0}~${w.h1}시 광고비`, value: `${fmt.krw(w.cost)}원`, base: `동요일 · 동시간 ${fmt.krw(w.baseCost)}원`, delta: w.costDelta, threshold: `±${cfg.warn.cost}% 주의 · ±${cfg.danger.cost}% 위험 (p.47)`, level: lvBoth(w.costDelta, cfg.warn.cost, cfg.danger.cost) });
      }
    }
  }

  // 영향 키워드
  const kwSet = d.keywords.filter((k) => ev.keywords.includes(k.text) || (ev.intents.length > 0 && ev.intents.includes(k.intent) && !ev.keywords.length));
  if (!ev.signal || ev.signal.rule !== 'kw_cpc') {
    const shifts = kwSet.map((k) => ({ k, s: keywordRecentShift(k, cfg.kwRecentDays) })).filter((x) => x.s && fin(x.s.cpcDelta) && x.s.recentClicks >= cfg.kwMinClicks);
    const worst = shifts.sort((a, b) => (b.s!.cpcDelta) - (a.s!.cpcDelta))[0];
    if (worst?.s) {
      evidence.push({ label: `'${worst.k.text}' CPC 최근 ${worst.s.days}일`, value: fmt.won(worst.s.cpcRecent), base: `직전 ${fmt.won(worst.s.cpcPrior)}`, delta: worst.s.cpcDelta, threshold: `+${cfg.kwCpcUpPct}% (운영 가정)`, level: lvUp(worst.s.cpcDelta, cfg.kwCpcUpPct, cfg.adPilotHoldPct), note: `영향 키워드 ${kwSet.length}개 중 CPC 상승 폭 최대` });
    }
  }
  if (kwSet.length) {
    const below = kwSet.filter((k) => {
      const roas = keywordMetrics(k).roas;
      return fin(roas) && roas < (k.isBrand ? cfg.brandTargetRoas : cfg.targetRoas);
    });
    evidence.push({ label: '영향 키워드 목표 ROAS 미달', value: `${below.length} / ${kwSet.length}개`, threshold: `목표 ROAS ${cfg.targetRoas}% · 브랜드 ${cfg.brandTargetRoas}% (p.14)`, level: below.length ? 'warn' : 'ok', note: below.length ? below.map((k) => k.text).slice(0, 3).join(' · ') : undefined });
  }

  // 영향 캠페인 (일 예산 소진)
  const pace = campaignPacing(d).filter((c) => ev.campaigns.includes(c.name));
  if (!ev.signal || ev.signal.rule !== 'media_spike') {
    for (const c of pace.filter((p) => p.earlyExhaust)) {
      evidence.push({ label: `${c.name} 일 예산 소진`, value: fmt.pct(c.pacePct, 0), base: `예상 마감 ${fmt.dec1(c.exhaustHour ?? NaN)}시`, threshold: '23시 이전 마감 = 조기 소진', level: 'warn' });
    }
  }

  // 계정 상태
  if (ev.accountId) {
    const acc = d.accounts.find((a) => a.id === ev.accountId);
    if (acc) {
      if (acc.status !== 'active') evidence.push({ label: `${acc.name} 계정 상태`, value: acc.status === 'review' ? '검수 · 확인 필요 (review)' : '제한 (restricted)', threshold: 'active 외 상태 = 노출 영향 (p.44)', level: 'danger' });
      const runway = acc.balance >= 0 && acc.avgDailySpend > 0 ? acc.balance / acc.avgDailySpend : NaN;
      if (fin(runway)) evidence.push({ label: '잔액 소진 예상', value: `${fmt.dec1(runway)}일`, base: `잔액 ${fmt.krw(acc.balance)}원 · 일 평균 ${fmt.krw(acc.avgDailySpend)}원`, threshold: '1일치 미만 위험 (p.44)', level: runway < 1 ? 'danger' : runway < 3 ? 'warn' : 'ok' });
    }
  }

  // 전환 추적 단절 → 진단 보류
  const tz = trackingZero(d, ev.media);
  let holdReason: string | undefined;
  if (tz.zeroHours >= cfg.trackingZeroHours && tz.clicksOk) {
    holdReason = `${name} 오늘 ${tz.since}시 이후 전환 0 (${tz.zeroHours}시간 · 클릭 정상)`;
    evidence.unshift({ label: `${name} 전환 0 구간`, value: `${tz.zeroHours}시간`, base: `${tz.since}시~${d.currentHour}시 · 클릭 정상`, threshold: `연속 ${cfg.trackingZeroHours}시간 = 전환 추적 단절 의심 (p.45)`, level: 'danger', note: 'MILDO Alert P1 · 자동 조정 보류' });
  }

  // 영향 범위 (일 평균)
  let affected: Diagnosis['affected'];
  if (kwSet.length) {
    affected = {
      keywords: kwSet.length,
      spendPerDay: sum(kwSet, (k) => k.last14.cost) / 14,
      revenuePerDay: sum(kwSet, (k) => k.last14.revenue) / 14,
      impressionsPerDay: sum(kwSet, (k) => k.last14.impressions) / 14,
      scope: `영향 키워드 ${kwSet.length}개 · 최근 14일 일 평균`,
    };
  } else {
    const mediaCamps = d.campaigns.filter((c) => c.media === ev.media);
    const allBudget = sum(mediaCamps, (c) => c.dailyBudget);
    const evBudget = sum(mediaCamps.filter((c) => ev.campaigns.includes(c.name)), (c) => c.dailyBudget);
    const share = ev.campaigns.length && allBudget > 0 ? evBudget / allBudget : 1;
    affected = {
      keywords: 0,
      spendPerDay: (wk.cur.cost / 7) * share,
      revenuePerDay: (wk.cur.revenue / 7) * share,
      impressionsPerDay: (wk.cur.impressions / 7) * share,
      scope: ev.campaigns.length ? `영향 캠페인 ${ev.campaigns.length}개 (매체 일 예산 비중 ${fmt.ratio(share, 0)}) · 최근 7일 일 평균` : `${name} 전체 · 최근 7일 일 평균`,
    };
  }

  const causes = [...(ev.signal?.causes ?? [])];
  if (!causes.length && ev.origin === 'notice') {
    causes.push({ label: `${EVENT_KIND_LABEL[ev.kind]} (공지)`, score: 50, basis: `${ev.source} — 공지 시점 전후 지표 대조` });
    causes.push({ label: CAUSE_CANDIDATES[0], score: 25, basis: '같은 기간 CPC · 순위 변화 동반 여부' });
  }

  let verdict: Verdict;
  if (noData && !ev.signal) verdict = 'nodata';
  else if (holdReason) verdict = 'hold';
  else if (evidence.some((e) => e.level === 'danger')) verdict = 'high';
  else if (evidence.some((e) => e.level === 'warn')) verdict = 'impact';
  else verdict = 'watch';

  const primary = evidence.find((e) => e.level === 'danger') ?? evidence.find((e) => e.level === 'warn');
  const basis =
    verdict === 'nodata' ? `${name} 최근 14일 집행 데이터 없음 — 수집 확인 필요`
      : verdict === 'hold' ? `${holdReason} — 기준 연속 ${cfg.trackingZeroHours}시간 (p.45)`
        : primary ? `${primary.label} ${primary.value}${fin(primary.delta) ? ` (${fmt.delta(primary.delta, 0)})` : ''} · 기준 ${primary.threshold ?? '—'}`
          : `p.47 주의 기준 미도달 (광고비 · 클릭 ±${cfg.warn.cost}%, CPA +${cfg.warn.cpa}%, ROAS −${cfg.warn.roas}%)`;

  return { verdict, label: VERDICT_META[verdict].label, basis, evidence, affected, holdReason, causes: causes.sort((a, b) => b.score - a.score), week };
}

/* ============================== 소액 테스트 · 랩업 판정 ============================== */

export interface TestDesign {
  hypothesis: string;
  arms: string;
  metric: string;
  baseBudget: number;
  sharePct: number;
  perDay: number;
  total: number;
  days: number;
  minClicks: number;
  stopRule: string;
  expandRule: string;
  approver: 'AE' | 'PM' | 'CLIENT';
  approverLabel: string;
  approverBasis: string;
}

/** 소액 테스트 설계 — 예산은 영향 캠페인 일 예산 × 비율 (운영 가정), 승인 주체는 p.15 위임 범위 */
export function testDesign(ev: WatchEvent, d: Dataset, cfg: WatchConfig = resolveWatchConfig()): TestDesign {
  const camps = d.campaigns.filter((c) => ev.campaigns.includes(c.name));
  const pool = camps.length ? camps : d.campaigns.filter((c) => c.media === ev.media);
  const baseBudget = sum(pool, (c) => c.dailyBudget);
  const share = ev.test?.budgetShare ?? cfg.testBudgetShare;
  const sharePct = Math.max(0, share * 100);
  const perDay = Math.round((baseBudget * share) / 10_000) * 10_000;
  const days = ev.test?.days ?? cfg.testDays;
  const tier = GFA_DELEGATION.find((t) => sharePct <= t.maxPct) ?? GFA_DELEGATION[GFA_DELEGATION.length - 1];
  // 테스트는 신규 광고그룹 ON을 동반하므로 최소 PM (p.15 '광고그룹 ON/OFF → PM')
  const approver = tier.approver === 'AE' ? 'PM' : tier.approver;
  const approverLabel = GFA_DELEGATION.find((t) => t.approver === approver)?.label ?? approver;
  return {
    hypothesis: ev.test?.hypothesis ?? `${ev.title} 대응안이 기존 대비 전환율을 유지한다`,
    arms: ev.test?.arms ?? '신규 그룹 vs 기존 그룹',
    metric: ev.test?.metric ?? '전환율 · ROAS',
    baseBudget, sharePct, perDay, total: perDay * days, days,
    minClicks: cfg.testMinClicks,
    stopRule: `${cfg.stopDay}일차 전환율 기존 대비 −${cfg.stopCvrDropPct}% → 중단 (p.28)`,
    expandRule: `전환율 +${cfg.expandCvrLiftPct}% → 같은 의도 그룹 전체 적용 (p.28)`,
    approver, approverLabel,
    approverBasis: `일 예산 비중 ${fmt.pct(sharePct, 0)} · 신규 광고그룹 ON → ${approverLabel} (p.15 위임 범위: ±10~30% · ON/OFF PM, 30% 초과 · 신규 캠페인 수면밀도)`,
  };
}

export type TestVerdict = 'pending' | 'running' | 'stop' | 'expand' | 'keep' | 'insufficient';
export const TEST_VERDICT_META: Record<TestVerdict, { label: string; tone: ToneKey; icon: string }> = {
  pending: { label: '결과 수집 전', tone: 'outline', icon: 'clock' },
  running: { label: '진행 중', tone: 'neutral', icon: 'clock' },
  stop: { label: '중단', tone: 'critical', icon: 'stop' },
  expand: { label: '확대', tone: 'good', icon: 'up' },
  keep: { label: '유지 · 모니터링 지속', tone: 'neutral', icon: 'watch' },
  insufficient: { label: '판정 보류', tone: 'warning', icon: 'alert' },
};
export interface TestJudgement {
  verdict: TestVerdict;
  label: string;
  basis: string;
  daysElapsed: number;
  days: number;
  cvrControl: number;
  cvrTest: number;
  lift: number;
  p: number;
}

/** p.28 테스트 카드 기준 판정: 7일차 전환율 −30% → 중단, 기간 종료 후 +15% 이상 · p<0.05 → 확대, 표본 부족 → 보류 */
export function judgeTest(result: { control: TestArmResult; test: TestArmResult } | undefined, daysElapsed: number, days: number, cfg: WatchConfig = resolveWatchConfig()): TestJudgement {
  const base = { daysElapsed: fin(daysElapsed) ? Math.max(0, daysElapsed) : 0, days, cvrControl: NaN, cvrTest: NaN, lift: NaN, p: NaN };
  if (!result) return { ...base, verdict: 'pending', label: TEST_VERDICT_META.pending.label, basis: 'Lab 테스트 등록 후 결과 수집 — 판정 불가' };
  const c = result.control, t = result.test;
  const cvrControl = metrics.cvr(c.conversions, c.clicks);
  const cvrTest = metrics.cvr(t.conversions, t.clicks);
  // 부동소수 경계 오차 방지 (예: 0.7/1.0 → −29.9999…%) — 소수 6자리 반올림 후 기준 비교
  const lift = fin(cvrControl) && cvrControl > 0 && fin(cvrTest) ? Math.round((cvrTest / cvrControl - 1) * 100 * 1e6) / 1e6 : NaN;
  const { p } = twoProportionZ(c.conversions, c.clicks, t.conversions, t.clicks);
  const out = { ...base, cvrControl, cvrTest, lift, p };
  const pTxt = fin(p) ? `p=${p.toFixed(3)}` : 'p 계산 불가';
  const cvrTxt = `전환율 ${fmt.pct(cvrTest, 2)} vs 기존 ${fmt.pct(cvrControl, 2)} (${fmt.delta(lift)})`;
  if (!fin(lift)) return { ...out, verdict: 'insufficient', label: '판정 보류 · 기존 그룹 전환 없음', basis: `기존 그룹 클릭 ${fmt.int(c.clicks)} · 전환 ${fmt.dec1(c.conversions)} — 비교 기준 없음` };
  if (out.daysElapsed < cfg.stopDay) return { ...out, verdict: 'running', label: `진행 중 · ${out.daysElapsed}/${days}일`, basis: `${cfg.stopDay}일차 중간 점검 전 — 현재 ${cvrTxt}` };
  if (lift <= -cfg.stopCvrDropPct) return { ...out, verdict: 'stop', label: `중단 · 전환율 ${fmt.delta(lift, 0)}`, basis: `${cvrTxt} · 기준 ${cfg.stopDay}일차 −${cfg.stopCvrDropPct}% 이하 → 중단 (p.28)` };
  if (out.daysElapsed < days) return { ...out, verdict: 'running', label: `진행 중 · ${out.daysElapsed}/${days}일`, basis: `중단 기준 미도달 · 기간 종료 후 판정 — 현재 ${cvrTxt}` };
  if (Math.min(c.clicks, t.clicks) < cfg.testMinClicks) return { ...out, verdict: 'insufficient', label: '판정 보류 · 표본 부족', basis: `그룹별 최소 클릭 ${cfg.testMinClicks} 미달 (기존 ${fmt.int(c.clicks)} · 신규 ${fmt.int(t.clicks)}) — 기간 연장` };
  if (lift >= cfg.expandCvrLiftPct) {
    if (fin(p) && p < 0.05) return { ...out, verdict: 'expand', label: `확대 · 전환율 ${fmt.delta(lift, 0)}`, basis: `${cvrTxt} · 기준 +${cfg.expandCvrLiftPct}% 이상 · ${pTxt} (두 비율 z-검정) → 같은 의도 그룹 전체 적용` };
    return { ...out, verdict: 'insufficient', label: '판정 보류 · 유의성 부족', basis: `${cvrTxt} · 확대 기준 +${cfg.expandCvrLiftPct}% 충족, ${pTxt} ≥ 0.05 — 기간 연장 후 재판정` };
  }
  return { ...out, verdict: 'keep', label: `유지 · 전환율 ${fmt.delta(lift, 0)}`, basis: `${cvrTxt} · 확대 기준 +${cfg.expandCvrLiftPct}% 미달 · 중단 기준 −${cfg.stopCvrDropPct}% 미도달 → 모니터링 지속` };
}

/* ============================== 파이프라인 진행 ============================== */

export interface EventProgress {
  stage: StageId;
  closed?: boolean;
  log: ProgressLog[];
  testStart?: string;
  wrapup?: { verdict: TestVerdict; label: string };
}
export type ProgressMap = Record<string, EventProgress>;

export function defaultProgress(ev: WatchEvent): EventProgress {
  return { stage: ev.initialStage, log: [...ev.seedLog], testStart: ev.test?.start };
}

function liveTestChange(ev: WatchEvent, changes: readonly ChangeRequest[]): ChangeRequest | undefined {
  return changes.find((c) => c.kind === 'test' && c.targetId === ev.id && c.status !== 'rejected' && c.status !== 'rolled_back');
}

/**
 * 현재 단계 = 로컬 진행 기록 + Lab 테스트 등록(ChangeRequest kind 'test') 반영.
 * 등록 요청이 MILDO Flow에서 반려 · 롤백되면 실행안 단계로 되돌린다 (승인 이력이 기준).
 */
export function stageOf(ev: WatchEvent, overrides: ProgressMap, changes: readonly ChangeRequest[] = []): { progress: EventProgress; stage: StageId; testChange?: ChangeRequest; testRejected?: ChangeRequest } {
  const progress = overrides[ev.id] ?? defaultProgress(ev);
  const testChange = liveTestChange(ev, changes);
  let stage = progress.stage;
  let testRejected: ChangeRequest | undefined;
  if (testChange && STAGE_INDEX[stage] < STAGE_INDEX.test) stage = 'test';
  if (!testChange) {
    testRejected = changes.find((c) => c.kind === 'test' && c.targetId === ev.id && (c.status === 'rejected' || c.status === 'rolled_back'));
    if (testRejected && stage === 'test') stage = 'plan';
  }
  return { progress, stage, testChange, testRejected };
}

export type StepAction = 'diagnose' | 'plan' | 'test' | 'wrapup';
export interface NextStep { action: StepAction | null; label: string; disabled?: string; canClose: boolean }

export function nextStep(ev: WatchEvent, stage: StageId, diag: Diagnosis, judge: TestJudgement, closed = false): NextStep {
  if (closed) return { action: null, label: '관찰 종료', canClose: false };
  switch (stage) {
    case 'detect':
      return { action: 'diagnose', label: '영향 진단 완료', disabled: diag.verdict === 'nodata' ? '집행 데이터 없음 — 수집 확인 후 진단' : undefined, canClose: false };
    case 'diagnose':
      return { action: 'plan', label: '실행안 확정 · 주간 리포트 반영', canClose: diag.verdict === 'watch' || diag.verdict === 'nodata' };
    case 'plan':
      return {
        action: 'test', label: 'Lab 테스트 등록',
        disabled: diag.verdict === 'hold' ? `${diag.holdReason} — 전환 추적 확인 후 등록 (MILDO Alert)` : !ev.test ? '테스트 설계 없음' : undefined,
        canClose: true,
      };
    case 'test':
      return { action: 'wrapup', label: '랩업 기록', disabled: judge.verdict === 'pending' || judge.verdict === 'running' ? `${judge.label} — ${judge.basis}` : undefined, canClose: false };
    default:
      return { action: null, label: '랩업 완료', canClose: false };
  }
}

const STEP_TO: Record<StepAction, StageId> = { diagnose: 'diagnose', plan: 'plan', test: 'test', wrapup: 'wrapup' };
const STEP_LABEL: Record<StepAction, string> = { diagnose: '영향 진단 완료', plan: '실행안 확정', test: 'Lab 테스트 등록', wrapup: '랩업 기록' };

/** 단계 진행 (불변 갱신). 역행 · 중복 진행은 무시한다 */
export function advanceProgress(
  map: ProgressMap, ev: WatchEvent, action: StepAction | 'close', by: string, at: string, opts: { note?: string; testStart?: string; wrapup?: EventProgress['wrapup']; changes?: readonly ChangeRequest[] } = {},
): ProgressMap {
  const { progress, stage } = stageOf(ev, map, opts.changes ?? []);
  if (progress.closed) return map;
  if (action === 'close') {
    return { ...map, [ev.id]: { ...progress, stage, closed: true, log: [...progress.log, { at, by, action: '관찰 종료', note: opts.note }] } };
  }
  const to = STEP_TO[action];
  if (STAGE_INDEX[to] !== STAGE_INDEX[stage] + 1) return map;
  return {
    ...map,
    [ev.id]: {
      ...progress,
      stage: to,
      testStart: action === 'test' ? (opts.testStart ?? progress.testStart) : progress.testStart,
      wrapup: action === 'wrapup' ? opts.wrapup : progress.wrapup,
      log: [...progress.log, { at, by, action: STEP_LABEL[action], note: opts.note }],
    },
  };
}

export interface StageDue { label: string; dueMs: number | null; remainingH: number | null; overdue: boolean; urgent: boolean }

export function stageDue(ev: WatchEvent, stage: StageId, d: Dataset, progress: EventProgress, cfg: WatchConfig = resolveWatchConfig(), nowMs = dataNowMs(d), closed = false): StageDue {
  const none = (label: string): StageDue => ({ label, dueMs: null, remainingH: null, overdue: false, urgent: false });
  if (closed) return none('관찰 종료 · 기록 보관');
  if (stage === 'detect') {
    const due = kstMs(ev.detectedAt) + cfg.diagnoseSlaHours * HOUR;
    const rem = (due - nowMs) / HOUR;
    return { label: `진단 기한 ${fmtKst(due)} · ${fmtHoursLeft(rem)}`, dueMs: due, remainingH: rem, overdue: rem < 0, urgent: rem >= 0 && rem <= 2 };
  }
  if (stage === 'diagnose') {
    const w = nextWeeklyReport(d, nowMs);
    return { label: `실행안 → ${w.label}`, dueMs: w.ms, remainingH: (w.ms - nowMs) / HOUR, overdue: false, urgent: false };
  }
  if (stage === 'plan') return none('주간 리포트 공유 후 Lab 테스트 등록 (승인 요청)');
  if (stage === 'test') {
    const start = progress.testStart ?? ev.test?.start ?? d.today;
    const days = ev.test?.days ?? cfg.testDays;
    const end = addDays(start, days);
    const elapsed = Math.max(0, dayDiff(d.today, start));
    return { label: `테스트 ${Math.min(elapsed, days)}/${days}일 · 랩업 ${fmtDate(end)} (액션 후 2주, p.28)`, dueMs: kstMs(end), remainingH: (kstMs(end) - nowMs) / HOUR, overdue: elapsed > days + 7, urgent: elapsed >= days };
  }
  return none(progress.wrapup ? `랩업 · ${progress.wrapup.label}` : '랩업 완료');
}

/* ============================== 종합 평가 (화면 · 도구 · 브리프 공용) ============================== */

export interface EvaluatedEvent extends WatchEvent {
  stage: StageId;
  closed: boolean;
  progress: EventProgress;
  diag: Diagnosis;
  design: TestDesign;
  judge: TestJudgement;
  due: StageDue;
  next: NextStep;
  testChange?: ChangeRequest;
  testRejected?: ChangeRequest;
}

export function evaluateEvents(
  d: Dataset, opts: { cfg?: WatchConfig; overrides?: ProgressMap; changes?: readonly ChangeRequest[]; nowMs?: number; events?: WatchEvent[] } = {},
): EvaluatedEvent[] {
  const cfg = opts.cfg ?? resolveWatchConfig();
  const events = opts.events ?? buildEvents(d, cfg);
  const nowMs = opts.nowMs ?? dataNowMs(d);
  return events.map((ev) => {
    const { progress, stage, testChange, testRejected } = stageOf(ev, opts.overrides ?? {}, opts.changes ?? []);
    const diag = diagnoseEvent(ev, d, cfg);
    const design = testDesign(ev, d, cfg);
    const start = progress.testStart ?? ev.test?.start;
    const result = STAGE_INDEX[stage] >= STAGE_INDEX.test && start ? ev.test?.result : undefined;
    const judge = judgeTest(result, start ? dayDiff(d.today, start) : 0, design.days, cfg);
    const closed = !!progress.closed;
    return { ...ev, stage, closed, progress, diag, design, judge, testChange, testRejected, due: stageDue(ev, stage, d, progress, cfg, nowMs, closed), next: nextStep(ev, stage, diag, judge, closed) };
  });
}

export function pipelineCounts(events: readonly EvaluatedEvent[]): Record<StageId, number> & { closed: number; open: number } {
  const c = { detect: 0, diagnose: 0, plan: 0, test: 0, wrapup: 0, closed: 0, open: 0 };
  for (const e of events) {
    if (e.closed) { c.closed++; continue; }
    c[e.stage]++;
    if (e.stage !== 'wrapup') c.open++;
  }
  return c;
}

/** p.24 표 + 매체별 진행 현황 · 판단 지표 (TEST DATA) */
export function trackingOverview(d: Dataset, events: readonly EvaluatedEvent[]) {
  return MEDIA_TRACKING.map((row) => {
    const wk = mediaWeek(d, row.media);
    const evs = events.filter((e) => e.media === row.media);
    const open = evs.filter((e) => !e.closed && e.stage !== 'wrapup');
    const worst = [...open].sort((a, b) => VERDICT_META[b.diag.verdict].rank - VERDICT_META[a.diag.verdict].rank)[0];
    return {
      ...row,
      role: MEDIA[row.media]?.role ?? '',
      judgeMetric: MEDIA[row.media]?.judgeMetric ?? '',
      colorVar: MEDIA[row.media]?.colorVar ?? '--series-1',
      roas: wk.cur.roas, roasDelta: wk.roasDelta, cpa: wk.cur.cpa, cpaDelta: wk.cpaDelta, cost: wk.cur.cost,
      total: evs.length, open: open.length,
      notices: evs.filter((e) => e.origin === 'notice').length,
      signals: evs.filter((e) => e.origin === 'signal').length,
      worst: worst ? { verdict: worst.diag.verdict, label: worst.diag.label, basis: worst.diag.basis, id: worst.id } : null,
    };
  });
}

/** Lab 테스트 등록용 ChangeRequest 페이로드 (pending — 실제 반영은 사람이 승인) */
export function testChangePayload(ev: EvaluatedEvent | (WatchEvent & { diag: Diagnosis; design: TestDesign }), requestedBy: string) {
  const g = ev.design;
  return {
    module: 'lab',
    kind: 'test' as const,
    target: `${nameOfMedia(ev.media)} · ${ev.title}`.slice(0, 80),
    targetId: ev.id,
    before: '실행안 (주간 리포트)',
    after: `소액 테스트 ${g.days}일 · 일 ${fmt.krw(g.perDay)}원 (총 ${fmt.krw(g.total)}원)`,
    changePct: Math.round(g.sharePct),
    reason: `MILDO Watch 감지(${ev.source}) → 영향 진단: ${ev.diag.label} · ${ev.diag.basis}. 실행안: ${ev.plan}. 가설: ${g.hypothesis}. 비교: ${g.arms}. ${g.stopRule} · ${g.expandRule}.`,
    requestedBy,
    approver: g.approver,
  };
}

/* ============================== 오가닉 · 페이드 아카이브 (p.25) ============================== */

export type ImpactLevel = 'high' | 'mid' | 'low';
export const IMPACT_META: Record<ImpactLevel, { label: string; tone: ToneKey; score: number }> = {
  high: { label: '영향도 높음', tone: 'serious', score: 3 },
  mid: { label: '영향도 중간', tone: 'warning', score: 2 },
  low: { label: '영향도 낮음', tone: 'neutral', score: 1 },
};
export interface ArchiveImpact { level: ImpactLevel; label: string; basis: string; facts: string[]; intents: IntentId[] }

/** 자사 퀸 사이즈 판매가 (상품 옵션) */
export function ourQueenPrice(d: Dataset): number {
  for (const p of d.products) {
    const q = p.options.find((o) => o.label === '퀸');
    if (q) return q.price;
  }
  return NaN;
}
/** 해당 일자에 진행(또는 예정)인 자사 프로모션 */
export function ourPromosOn(d: Dataset, from: string, to = from): Promotion[] {
  return d.promotions.filter((p) => p.start <= to && from <= p.end && p.status !== 'ended');
}

export function archiveImpact(rec: ArchiveRecord, d: Dataset, events: readonly { media: MediaId; detectedAt: string }[] = []): ArchiveImpact {
  const mk = (level: ImpactLevel, basis: string, facts: string[] = [], intents: IntentId[] = []): ArchiveImpact => ({ level, label: IMPACT_META[level].label, basis, facts, intents });
  switch (rec.item) {
    case 'price': {
      const p = rec.price;
      if (!p || !(p.prevEffective > 0)) return mk('low', '가격 스냅샷 비교 기준 없음');
      const drop = ((p.prevEffective - p.effective) / p.prevEffective) * 100;
      const theirDisc = p.list > 0 ? ((p.list - p.effective) / p.list) * 100 : 0;
      const promos = ourPromosOn(d, rec.date);
      const ourDisc = promos.length ? Math.max(...promos.map((x) => x.discountRate)) : 0;
      const queen = ourQueenPrice(d);
      const ourEff = fin(queen) ? queen * (1 - ourDisc / 100) : NaN;
      const gap = fin(ourEff) && ourEff > 0 ? ((p.effective - ourEff) / ourEff) * 100 : NaN;
      const facts = [
        `${p.size} 실판매가 ${fmt.won(p.effective)} (직전 ${fmt.won(p.prevEffective)} · ${fmt.delta(-drop, 0)})`,
        fin(ourEff) ? `자사 ${p.size} ${ourDisc ? `프로모션가 ${fmt.won(ourEff)} (${ourDisc}%)` : `판매가 ${fmt.won(ourEff)}`} 대비 ${fmt.delta(gap, 0)}` : '자사 비교 가격 없음',
      ];
      if (p.perk) facts.push(`사은품 ${p.perk}`);
      const intents: IntentId[] = ['generic', 'compare'];
      if (drop >= 10) return mk('high', `실판매가 ${fmt.delta(-drop, 0)} · 기준 −10% 이상 높음 · −5% 이상 중간`, facts, intents);
      if (drop >= 5 || (theirDisc > 0 && theirDisc >= ourDisc && ourDisc > 0) || p.perk) return mk('mid', p.perk && drop < 5 ? '판매가 유지 · 혜택 추가 → 중간' : `실판매가 ${fmt.delta(-drop, 0)} · 할인율 ${fmt.pct(theirDisc, 0)} (자사 ${ourDisc}%) · 기준 −5% 이상 또는 할인율 ≥ 자사 → 중간`, facts, intents);
      return mk('low', `실판매가 변동 ${fmt.delta(-drop, 0)} · 기준 −5% 미만 → 낮음`, facts, intents);
    }
    case 'creative': {
      const pr = rec.promo;
      if (!pr) return mk('low', '프로모션 정보 없음');
      const overlap = ourPromosOn(d, pr.start, pr.end);
      const ourDisc = overlap.length ? Math.max(...overlap.map((x) => x.discountRate)) : 0;
      const life = LIFE_TERM_PATTERN.test(pr.theme);
      const intents: IntentId[] = life ? ['life', 'compare'] : ['generic', 'compare'];
      const facts = [
        `기간 ${fmtDate(pr.start, false)}~${fmtDate(pr.end, false)} · 할인 ${pr.discountRate ? `${pr.discountRate}%` : '미표기'} · 테마 ${pr.theme}`,
        overlap.length ? `자사 ${overlap.map((o) => `'${o.name}'(${o.discountRate}%)`).join(' · ')}과 기간 중복` : '자사 프로모션과 기간 중복 없음',
      ];
      const discTxt = pr.discountRate > 0 ? `할인 ${pr.discountRate}%` : '할인율 미표기';
      if (overlap.length && pr.discountRate > 0 && pr.discountRate >= ourDisc) return mk('high', `자사 기획전과 기간 중복 · 할인 ${pr.discountRate}% ≥ 자사 ${ourDisc}% → 높음`, facts, intents);
      if (overlap.length || life) return mk('mid', overlap.length ? `자사 기획전과 기간 중복 · ${discTxt} (자사 최대 ${ourDisc}%) · 기준 할인율 ≥ 자사면 높음 → 중간` : `생활 상황 테마(${pr.theme}) · 자사 기간 중복 없음 → 중간`, facts, intents);
      return mk('low', '기간 중복 없음 · 생활 상황 테마 아님 → 낮음', facts, intents);
    }
    case 'serp': {
      const s = rec.serp;
      if (!s) return mk('low', '지면 정보 없음');
      const kw = d.keywords.find((k) => k.text === s.keyword);
      const facts = [`'${s.keyword}' ${rec.channel === 'paid' ? '파워링크' : '오가닉'} ${s.position}번째`];
      if (kw) facts.push(`자사 평균 순위 ${fmt.dec1(kw.avgRank)}위 · 노출 기회 손실 ${fmt.ratio(kw.impressionShareLost, 0)} (TEST DATA)`);
      const intents: IntentId[] = kw ? [kw.intent] : [];
      if (kw?.isBrand && rec.channel === 'paid') return mk('high', '자사 브랜드 키워드 검색 결과 경쟁사 광고 노출 = 침투 (p.45) → 높음', facts, intents);
      if (kw && rec.channel === 'paid' && s.position <= 2) return mk('mid', `운영 키워드 상단 ${s.position}위 진입 · 기준 2위 이내 → 중간`, facts, intents);
      if (kw && rec.channel === 'organic' && s.position <= 3) return mk('mid', `운영 키워드 오가닉 상위 ${s.position}번째 · 기준 3번째 이내 → 중간`, facts, intents);
      return mk('low', kw ? '상위 노출 기준 밖 → 낮음' : '운영 키워드 아님 → 낮음', facts, intents);
    }
    case 'offline': {
      const p = rec.period;
      if (!p) return mk('low', '기간 정보 없음');
      const overlap = ourPromosOn(d, p.start, p.end);
      const facts = [`기간 ${fmtDate(p.start, false)}~${fmtDate(p.end, false)}`, overlap.length ? `자사 ${overlap.map((o) => `'${o.name}'`).join(' · ')}과 기간 중복` : '자사 프로모션과 기간 중복 없음'];
      return overlap.length ? mk('mid', '자사 프로모션 기간과 겹치는 오프라인 활동 → 중간', facts, ['life']) : mk('low', '자사 프로모션 기간과 겹치지 않음 → 낮음', facts);
    }
    case 'external': {
      const active = SEASON_WINDOWS.filter((w) => w.start <= rec.date && rec.date <= w.end);
      return active.length
        ? mk('mid', `시즌 창 진행 중 (${active.map((w) => w.label).join(' · ')}, 가설) → 중간`, active.map((w) => `${w.label} ${fmtDate(w.start, false)}~${fmtDate(w.end, false)}`), ['life'])
        : mk('low', '진행 중인 시즌 창 없음 → 낮음');
    }
    case 'partner': {
      const m = rec.relatedMedia;
      const near = m ? events.filter((e) => e.media === m && Math.abs(dayDiff(e.detectedAt.slice(0, 10), rec.date)) <= 30).length : 0;
      return near ? mk('mid', `관련 매체(${nameOfMedia(m!)}) 변동 이벤트 ${near}건과 시기 겹침 → 중간`, [`관련 매체 ${nameOfMedia(m!)}`]) : mk('low', '관련 매체 변동 이벤트 없음 → 낮음');
    }
  }
}

export interface ArchiveRow extends ArchiveRecord { impact: ArchiveImpact; itemLabel: string; cadence: string; alertable: boolean }

export function archiveRows(d: Dataset, records: readonly ArchiveRecord[] = ARCHIVE_RECORDS, events: readonly { media: MediaId; detectedAt: string }[] = []): ArchiveRow[] {
  return records
    .filter((r) => r.date <= d.today)
    .map((r) => {
      const item = ARCHIVE_ITEMS.find((i) => i.id === r.item);
      return { ...r, impact: archiveImpact(r, d, events), itemLabel: item?.label ?? r.item, cadence: item?.cadence ?? '', alertable: (r.item === 'price' || r.item === 'creative') && !!r.competitor };
    })
    .sort((a, b) => (a.date === b.date ? IMPACT_META[b.impact.level].score - IMPACT_META[a.impact.level].score : a.date < b.date ? 1 : -1));
}

export interface MatrixCell { count: number; latest?: ArchiveRow; level?: ImpactLevel; rows: ArchiveRow[] }
/** 경쟁 6개사 × 아카이빙 항목 매트릭스 (최근 N일) */
export function archiveMatrix(d: Dataset, rows: readonly ArchiveRow[], days = 30, competitors: readonly string[] = RFP.competitors) {
  const from = addDays(d.today, -(days - 1));
  const inWin = rows.filter((r) => r.date >= from && r.date <= d.today);
  const cell = (list: ArchiveRow[]): MatrixCell => {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
    const level = sorted.reduce<ImpactLevel | undefined>((acc, r) => (!acc || IMPACT_META[r.impact.level].score > IMPACT_META[acc].score ? r.impact.level : acc), undefined);
    return { count: sorted.length, latest: sorted[0], level, rows: sorted };
  };
  return {
    from, to: d.today, days,
    items: ARCHIVE_ITEMS.map((it) => ({
      item: it,
      cells: it.perCompetitor ? competitors.map((c) => ({ competitor: c, ...cell(inWin.filter((r) => r.item === it.id && r.competitor === c)) })) : [],
      common: it.perCompetitor ? null : cell(inWin.filter((r) => r.item === it.id)),
    })),
    byCompetitor: competitors.map((c) => {
      const list = inWin.filter((r) => r.competitor === c);
      return { competitor: c, count: list.length, high: list.filter((r) => r.impact.level === 'high').length, latest: [...list].sort((a, b) => (a.date < b.date ? 1 : -1))[0] };
    }),
  };
}

/** 경쟁사 가격 · 프로모션 변경 → MILDO Alert P3 이슈 (p.44 매체 · 외부 환경 · 24시간 내 영향 분석). AlertIncident 확장 필드 포함 */
export function competitorIncident(row: ArchiveRow, d: Dataset, cfg: WatchConfig = resolveWatchConfig()): Incident & Record<string, unknown> {
  const nowMs = dataNowMs(d);
  const p = kstParts(nowMs);
  const detectedAt = `${p.date}T${p.hh}:${p.mi}:00+09:00`;
  const intents = row.impact.intents.length ? row.impact.intents : (['generic', 'compare'] as IntentId[]);
  const kws = d.keywords.filter((k) => intents.includes(k.intent));
  const revPerDay = sum(kws, (k) => k.last14.revenue) / 14;
  const lossEst = revPerDay * (cfg.promoShareShiftPct / 100) * 7;
  const evidence: Record<string, unknown>[] = [];
  if (row.price) {
    const drop = row.price.prevEffective > 0 ? ((row.price.effective - row.price.prevEffective) / row.price.prevEffective) * 100 : NaN;
    evidence.push({ label: `${row.competitor} ${row.price.size} 실판매가`, observed: row.price.effective, baseline: row.price.prevEffective, deltaPct: drop, unit: 'won', baseLabel: '직전 스냅샷', threshold: '−10% 이상 높음 · −5% 이상 중간', level: row.impact.level === 'high' ? 'warn' : 'info' });
    const promos = ourPromosOn(d, row.date);
    const ourDisc = promos.length ? Math.max(...promos.map((x) => x.discountRate)) : 0;
    const q = ourQueenPrice(d);
    if (fin(q)) evidence.push({ label: `자사 ${row.price.size} ${ourDisc ? '프로모션가' : '판매가'}`, observed: q * (1 - ourDisc / 100), unit: 'won', level: 'info', note: ourDisc ? `${promos[0].name} ${ourDisc}%` : undefined });
  }
  if (row.promo) {
    const overlap = ourPromosOn(d, row.promo.start, row.promo.end);
    const ourDisc = overlap.length ? Math.max(...overlap.map((x) => x.discountRate)) : 0;
    evidence.push({ label: `${row.competitor} 프로모션 할인율`, observed: row.promo.discountRate, baseline: ourDisc, unit: 'pct', baseLabel: '기간 중복 자사 기획전', threshold: '기간 중복 · 할인율 ≥ 자사 → 높음', level: row.impact.level === 'high' ? 'warn' : 'info', note: `${fmtDate(row.promo.start, false)}~${fmtDate(row.promo.end, false)} · ${row.promo.theme}` });
  }
  evidence.push({ label: '영향 의도 키워드 일 매출', observed: revPerDay, unit: 'krw', level: 'info', note: `${intents.map((i) => SA_CAMPAIGNS[i]?.name ?? i).join(' · ')} · 최근 14일 평균 (TEST DATA)` });
  const target = `${row.competitor} · ${row.itemLabel}`;
  return {
    id: `watch_competitor:${row.id}:${d.today}`,
    ruleId: 'watch_competitor',
    severity: 'P3',
    title: `경쟁사 ${row.itemLabel} 변경 — ${row.competitor} ${row.title}`,
    target,
    detectedAt,
    occurredAt: `${row.date}T07:00:00+09:00`,
    detectPath: `MILDO Watch · 경쟁사 아카이빙 (${row.cadence})`,
    metric: row.price ? '경쟁사 실판매가' : '경쟁사 프로모션 할인율',
    observed: row.price ? row.price.effective : row.promo?.discountRate,
    baseline: row.price ? row.price.prevEffective : undefined,
    deltaPct: row.price && row.price.prevEffective > 0 ? ((row.price.effective - row.price.prevEffective) / row.price.prevEffective) * 100 : undefined,
    causeCandidates: [CAUSE_CANDIDATES[2]],
    impact: { revenueLossEst: Math.round(lossEst) },
    assignee: 'SA Lead AE',
    backup: 'SA AE',
    status: 'open',
    timeline: [{ at: detectedAt, by: 'MILDO Watch', action: `감지 · P3 이슈 생성 (${row.impact.label})` }],
    isTest: false,
    autoActions: ['24시간 내 영향 분석 · 대응안 (p.44 매체 · 외부 환경)', '주간 인사이트 브리프 · 주간 리포트 반영 예약'],
    // MILDO Alert 확장 필드 (AlertIncident 호환)
    typeId: 'external',
    ruleLabel: '경쟁사 프로모션 · 가격 변경',
    basis: `경쟁사 가격 · 프로모션 변경 감지 · ${row.impact.basis}`,
    page: 'p.25 · p.44',
    evidence,
    causes: [{ label: CAUSE_CANDIDATES[2], score: IMPACT_META[row.impact.level].score * 30, basis: row.impact.basis }],
    impactNote: `추정 — 영향 의도 키워드 일 매출 ${fmt.krw(revPerDay)}원 × 점유 이동 가정 ${cfg.promoShareShiftPct}% × 7일 (운영 가정 · 실측 아님)`,
    ownerRoleId: 'sa_lead',
    assigneeRoleId: 'sa_lead',
    backupRoleId: 'sa_ae',
  };
}

/* ============================== 브랜드 키워드 검색 결과 지면 점검 ============================== */

export interface SerpSlot { pos: number; advertiser: string; own: boolean; competitor: boolean }
export type SerpVerdict = 'above' | 'below' | 'clear' | 'nodata';
export const SERP_VERDICT_META: Record<SerpVerdict, { label: string; tone: ToneKey; icon: string }> = {
  above: { label: '침투 · 자사보다 상위', tone: 'serious', icon: 'alert' },
  below: { label: '침투 · 자사보다 하위', tone: 'warning', icon: 'alert' },
  clear: { label: '침투 없음', tone: 'good', icon: 'check' },
  nodata: { label: '스냅샷 없음', tone: 'outline', icon: 'inbox' },
};
export interface SerpCheck {
  keyword: string;
  keywordId: string;
  avgRank: number;
  lost: number;
  ownPos: number;
  slots: SerpSlot[];
  competitorsAbove: string[];
  competitorsAll: string[];
  verdict: SerpVerdict;
  label: string;
  basis: string;
  roas: number;
  roasVsTarget: number;
  brandSearchAd: boolean | null;
  shopping: { own: number; competitor: number } | null;
  content: { competitorMentions: number } | null;
  archiveRefs: string[];
}

/** 브랜드 키워드 검색 결과 지면 (스냅샷 DEMO + 자사 순위는 data.keywords에서) — 경쟁사 침투 여부 */
export function brandSerpCheck(d: Dataset, cfg: WatchConfig = resolveWatchConfig(), seeds: readonly SerpSeed[] = BRAND_SERP_SEEDS, records: readonly ArchiveRecord[] = ARCHIVE_RECORDS): SerpCheck[] {
  const comp = new Set<string>(RFP.competitors);
  return d.keywords.filter((k) => k.isBrand).map((k) => {
    const seed = seeds.find((s) => s.keyword === k.text);
    const ownPos = Math.min(5, Math.max(1, Math.round(fin(k.avgRank) ? k.avgRank : 1)));
    const others = [...(seed?.others ?? [])];
    const slots: SerpSlot[] = [];
    for (let pos = 1; pos <= 5; pos++) {
      if (pos === ownPos) slots.push({ pos, advertiser: '수면밀도 (자사)', own: true, competitor: false });
      else {
        const a = others.shift();
        if (a) slots.push({ pos, advertiser: a, own: false, competitor: comp.has(a) });
      }
    }
    const competitorsAbove = slots.filter((s) => s.pos < ownPos && s.competitor).map((s) => s.advertiser);
    const competitorsAll = slots.filter((s) => s.competitor).map((s) => s.advertiser);
    const verdict: SerpVerdict = !seed ? 'nodata' : competitorsAbove.length ? 'above' : competitorsAll.length ? 'below' : 'clear';
    const roas = keywordMetrics(k).roas;
    return {
      keyword: k.text, keywordId: k.id, avgRank: k.avgRank, lost: k.impressionShareLost, ownPos, slots,
      competitorsAbove, competitorsAll, verdict, label: SERP_VERDICT_META[verdict].label,
      basis: `자사 평균 순위 ${fmt.dec1(k.avgRank)}위 · 노출 기회 손실 ${fmt.ratio(k.impressionShareLost, 0)} · 기준 경쟁사 광고 1개 이상 = 침투 (p.45)`,
      roas, roasVsTarget: fin(roas) ? (roas / cfg.brandTargetRoas) * 100 : NaN,
      brandSearchAd: seed ? seed.brandSearchAd : null,
      shopping: seed ? seed.shoppingTop10 : null,
      content: seed ? seed.contentTop10 : null,
      archiveRefs: records.filter((r) => r.item === 'serp' && r.serp?.keyword === k.text).map((r) => r.id),
    };
  });
}

/* ============================== 외부 변수 · 시즌 캘린더 · 검색 트렌드 ============================== */

export type CalendarKind = SeasonKind | 'holiday' | 'promo';
export interface CalendarItem { id: string; kind: CalendarKind; kindLabel: string; label: string; start: string; end: string; dday: number; active: boolean; intents: IntentId[]; prep: string; basis: string }

function holidayBlocks(from: string, to: string): { start: string; end: string; labels: string[] }[] {
  const dates = Object.keys(KR_HOLIDAYS).filter((x) => x >= from && x <= to).sort();
  const blocks: { start: string; end: string; labels: string[] }[] = [];
  for (const dt of dates) {
    const last = blocks[blocks.length - 1];
    if (last && addDays(last.end, 1) === dt) {
      last.end = dt;
      if (!last.labels.includes(KR_HOLIDAYS[dt])) last.labels.push(KR_HOLIDAYS[dt]);
    } else blocks.push({ start: dt, end: dt, labels: [KR_HOLIDAYS[dt]] });
  }
  return blocks;
}

/** 시즌 캘린더 (이사 · 혼인 · 대형 쇼핑 행사는 가설, 공휴일은 KR_HOLIDAYS, 자사 프로모션은 data.promotions) */
export function seasonCalendar(d: Dataset, horizonDays = 120): CalendarItem[] {
  const from = d.today;
  const to = addDays(d.today, horizonDays);
  const items: CalendarItem[] = [];
  for (const w of SEASON_WINDOWS) {
    if (w.end < from || w.start > to) continue;
    items.push({ id: w.id, kind: w.kind, kindLabel: SEASON_KIND_LABEL[w.kind], label: w.label, start: w.start, end: w.end, dday: dayDiff(w.start, from), active: w.start <= from && from <= w.end, intents: [...w.intents], prep: w.prep, basis: w.kind === 'shopping' ? '가설 · 행사 일정 확인 필요' : '가설 · 수면밀도 데이터 검증 전' });
  }
  for (const b of holidayBlocks(from, to)) {
    items.push({ id: `hol_${b.start}`, kind: 'holiday', kindLabel: SEASON_KIND_LABEL.holiday, label: b.labels.join(' · '), start: b.start, end: b.end, dday: dayDiff(b.start, from), active: b.start <= from && from <= b.end, intents: [], prep: `연휴 전날(${fmtDate(addDays(b.start, -1))}) 사전 점검 — 예산 · 소재 · 결제 잔액 (MILDO Alert)`, basis: '관공서 공휴일 (KR_HOLIDAYS · 대체공휴일 고시 확인)' });
  }
  for (const p of d.promotions) {
    if (p.end < from || p.start > to) continue;
    items.push({ id: p.id, kind: 'promo', kindLabel: SEASON_KIND_LABEL.promo, label: `${p.name} (${p.discountRate}%)`, start: p.start, end: p.end, dday: dayDiff(p.start, from), active: p.start <= from && from <= p.end, intents: [], prep: '경쟁사 가격 · 프로모션 일 단위 대조 · 소재 표기가 점검 (MILDO Flow)', basis: `자사 프로모션 · ${p.status === 'live' ? '진행 중' : p.status === 'planned' ? '예정' : '종료'} (TEST DATA)` });
  }
  return items.sort((a, b) => (a.start === b.start ? a.label.localeCompare(b.label) : a.start < b.start ? -1 : 1));
}

function monthAdd(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
/** 12개월 시즌 띠 (행: 시즌 종류, 열: 월) */
export function monthGrid(d: Dataset, months = 12) {
  const startYm = d.today.slice(0, 7);
  const cols = Array.from({ length: months }, (_, i) => {
    const ym = monthAdd(startYm, i);
    const first = `${ym}-01`;
    const last = addDays(`${monthAdd(ym, 1)}-01`, -1);
    const m = Number(ym.slice(5, 7));
    return { ym, first, last, label: i === 0 || m === 1 ? `${ym.slice(2, 4)}.${m}월` : `${m}월` };
  });
  const horizonEnd = cols[cols.length - 1]?.last ?? d.today;
  const all = seasonCalendar(d, Math.max(0, dayDiff(horizonEnd, d.today)));
  const kinds: CalendarKind[] = ['move', 'wedding', 'shopping', 'holiday', 'promo'];
  return {
    cols,
    rows: kinds.map((k) => ({
      kind: k,
      label: SEASON_KIND_LABEL[k],
      cells: cols.map((c) => all.filter((it) => it.kind === k && it.start <= c.last && c.first <= it.end).map((it) => it.label)),
    })),
  };
}

/** 브랜드 검색량 추이 (TEST DATA) + 전일 vs 최근 4주 동요일 평균 */
export function brandSearchTrend(d: Dataset, days = 56, cfg: WatchConfig = resolveWatchConfig()) {
  const y = addDays(d.today, -1);
  const rows = d.brandSearchDaily.filter((r) => r.date <= y);
  const byDate = new Map(rows.map((r) => [r.date, r.volume]));
  const tail = rows.slice(-Math.max(1, days));
  const points = tail.map((r) => {
    const idx = rows.indexOf(r);
    const win = rows.slice(Math.max(0, idx - 6), idx + 1).map((x) => x.volume);
    return { date: r.date, volume: r.volume, ma7: win.length === 7 ? mean(win) : NaN };
  });
  const yv = byDate.get(y);
  const baseVals = [7, 14, 21, 28].map((n) => byDate.get(addDays(y, -n))).filter((v): v is number => fin(v));
  const base = mean(baseVals);
  const deltaPct = fin(yv) && fin(base) && base > 0 ? metrics.pctChange(yv, base) : NaN;
  const last7 = mean(rows.slice(-7).map((r) => r.volume));
  const prev28 = mean(rows.slice(-35, -7).map((r) => r.volume));
  return {
    points,
    yesterday: fin(yv) ? { date: y, volume: yv, base, deltaPct, level: lvBoth(deltaPct, cfg.searchShiftPct / 2, cfg.searchShiftPct) } : null,
    last7, prev28, last7Delta: fin(last7) && fin(prev28) && prev28 > 0 ? metrics.pctChange(last7, prev28) : NaN,
  };
}

/** 구매 의도별 노출 추이 (최근 14일 vs 직전 14일, TEST DATA) — 검색 수요 변화의 대리 지표 */
export function intentExposure(d: Dataset) {
  return INTENT_IDS.map((intent) => {
    const kws = d.keywords.filter((k) => k.intent === intent);
    const last = sum(kws, (k) => k.last14.impressions);
    const prev = sum(kws, (k) => k.prev14.impressions);
    const cl = sum(kws, (k) => k.last14.clicks);
    const cp = sum(kws, (k) => k.prev14.clicks);
    return {
      intent, name: SA_CAMPAIGNS[intent]?.name ?? intent, keywords: kws.length,
      last, prev, delta: prev > 0 ? metrics.pctChange(last, prev) : NaN,
      clicks: cl, clicksDelta: cp > 0 ? metrics.pctChange(cl, cp) : NaN,
      newKeywords: kws.filter((k) => k.prev14.impressions === 0 && k.last14.impressions > 0).map((k) => k.text),
    };
  });
}

/* ============================== 주간 인사이트 브리프 (p.28) ============================== */

export interface WeeklyBriefResult {
  period: { from: string; to: string; label: string };
  delivery: string;
  counts: { events: number; notices: number; signals: number; impact: number; archive: number; archiveHigh: number; serpAbove: number; upcoming: number };
  brief: Brief;
  markdown: string;
}

export function weeklyBrief(
  d: Dataset, events: readonly EvaluatedEvent[], archive: readonly ArchiveRow[], serp: readonly SerpCheck[], calendar: readonly CalendarItem[], cfg: WatchConfig = resolveWatchConfig(), nowMs = dataNowMs(d),
): WeeklyBriefResult {
  const from = addDays(d.today, -6);
  const to = d.today;
  const label = `${fmtDate(from)}~${fmtDate(to)}`;
  const inWeek = (date: string) => date >= from && date <= to;
  const evs = events.filter((e) => inWeek(e.detectedAt.slice(0, 10)));
  const impactEvs = evs.filter((e) => e.diag.verdict === 'high' || e.diag.verdict === 'impact').sort((a, b) => VERDICT_META[b.diag.verdict].rank - VERDICT_META[a.diag.verdict].rank);
  const holdEvs = events.filter((e) => e.diag.verdict === 'hold' && !e.closed);
  const arc = archive.filter((r) => inWeek(r.date));
  const arcHigh = arc.filter((r) => r.impact.level === 'high');
  const serpAbove = serp.filter((s) => s.verdict === 'above');
  const upcoming = calendar.filter((c) => c.dday >= 0 && c.dday <= 30);
  const activeSeason = calendar.filter((c) => c.active && c.kind !== 'promo' && c.kind !== 'holiday');
  const pendingDiag = events.filter((e) => e.stage === 'detect' && !e.closed);
  const wrapReady = events.filter((e) => e.stage === 'test' && !e.closed && e.judge.verdict !== 'pending' && e.judge.verdict !== 'running');
  const report = nextWeeklyReport(d, nowMs);
  const mediaName = (m: MediaId) => nameOfMedia(m);
  const titled = (e: EvaluatedEvent) => (e.title.startsWith(mediaName(e.media)) || e.title.includes(MEDIA[e.media]?.short ?? '\u0000') ? e.title : `${mediaName(e.media)} · ${e.title}`);

  const facts: string[] = [];
  facts.push(`이번 주(${label}) 매체 변동 감지 ${evs.length}건 — 매체 공지 ${evs.filter((e) => e.origin === 'notice').length}건, 데이터 감지 ${evs.filter((e) => e.origin === 'signal').length}건. 이 중 p.47 주의 기준 이상으로 영향이 확인된 건은 ${impactEvs.length}건이다 (TEST DATA).`);
  for (const e of impactEvs.slice(0, 4)) facts.push(`${titled(e)}: ${e.diag.label} — ${e.diag.basis}.`);
  if (arc.length) facts.push(`경쟁사 아카이브 변경 ${arc.length}건 (영향도 높음 ${arcHigh.length}건)${arcHigh.length ? ` — ${arcHigh.slice(0, 3).map((r) => `${r.competitor ?? '공통'} ${r.title}`).join(' / ')}` : ''}. 시연용 가상 스냅샷이다.`);
  if (serp.length) facts.push(`브랜드 키워드 ${serp.length}개 중 ${serpAbove.length}개에서 경쟁사 광고가 자사보다 위에 노출된다 (자사 평균 순위 ${serp.map((s) => `${s.keyword} ${fmt.dec1(s.avgRank)}위`).join(', ')}).`);
  if (!evs.length && !arc.length) facts.push(`이번 주(${label}) 기록된 감지 사항이 없다.`);

  const patterns: string[] = [];
  const lifeComp = arc.filter((r) => r.item === 'creative' && r.promo && LIFE_TERM_PATTERN.test(r.promo.theme));
  if (lifeComp.length) {
    const overlapWithOurs = lifeComp.filter((r) => ourPromosOn(d, r.promo!.start, r.promo!.end).length > 0);
    patterns.push(`생활 상황 테마(신혼 · 이사) 경쟁사 프로모션 ${lifeComp.length}건이 이번 주에 기록됐고, 그중 ${overlapWithOurs.length}건이 자사 진행 기획전 기간과 겹친다. 관측 범위는 아카이브 스냅샷 1주.`);
  }
  const priceDrops = archive.filter((r) => r.item === 'price' && r.price && r.date >= addDays(d.today, -13) && r.price.prevEffective > 0 && (r.price.prevEffective - r.price.effective) / r.price.prevEffective >= 0.05);
  if (priceDrops.length) patterns.push(`최근 14일 경쟁사 실판매가 5% 이상 인하가 ${priceDrops.length}건 (${[...new Set(priceDrops.map((r) => r.competitor))].join(' · ')}) — 11월 쇼핑 행사 구간 전 가격 경쟁이 앞당겨지는 패턴인지 다음 주까지 관측한다.`);
  const kwSig = events.filter((e) => e.signal?.rule === 'kw_cpc');
  if (kwSig.length && kwSig.some((e) => e.archiveRefs.length)) patterns.push(`CPC 급등 키워드와 같은 기간 경쟁사 파워링크 신규 진입이 아카이브에 함께 기록됐다 (${kwSig.filter((e) => e.archiveRefs.length).map((e) => e.keywords[0]).join(' · ')}). 한 키워드 사례라 반복 패턴으로 확정하지 않는다.`);
  if (activeSeason.length) patterns.push(`진행 중인 시즌 창: ${activeSeason.map((c) => c.label).join(' · ')} (가설). 생활 상황 구문형 유입과 시기가 겹치지만 시즌 효과인지 검증 전이다.`);

  const interpretation: string[] = [];
  if (impactEvs.length) interpretation.push(`규칙 기반 해석: 이번 주 영향이 큰 변동은 ${[...new Set(impactEvs.map((e) => mediaName(e.media)))].join(' · ')}에 몰려 있다. 공지 이벤트와 데이터 변화가 같은 시기에 겹쳐도 공지가 원인이라는 근거는 아니므로, 소액 테스트로 분리 측정한 뒤 확대 여부를 판단한다.`);
  if (arcHigh.length) interpretation.push('규칙 기반 해석: 경쟁사 가격 인하 · 기획전은 일반 제품 · 비교 검토 키워드의 CVR과 CPC에 먼저 나타날 가능성이 높다. 자사 할인율을 따라가기보다 CPA 상한을 지키는 선에서 입찰을 유지하고, 차이는 혜택 · 배송 메시지로 보완하는 안을 우선 검토한다.');

  const conditions = [
    `영향 진단 기준: p.47 주의 기준 (광고비 · 클릭 ±${cfg.warn.cost}%, 전환 −${cfg.warn.conversions}%, CPA +${cfg.warn.cpa}%, ROAS −${cfg.warn.roas}%), 위험 기준 ±${cfg.danger.cost}% · ROAS −${cfg.danger.roas}%. 진단 기한 감지 후 ${cfg.diagnoseSlaHours}시간 (p.24).`,
    `소액 테스트: 영향 캠페인 일 예산의 ${Math.round(cfg.testBudgetShare * 100)}% × ${cfg.testDays}일 (운영 가정), 중단 ${cfg.stopDay}일차 전환율 −${cfg.stopCvrDropPct}% · 확대 +${cfg.expandCvrLiftPct}% (p.28), 그룹별 최소 클릭 ${cfg.testMinClicks}.`,
    '경쟁사 영향도: 실판매가 −10% 이상 높음 · −5% 이상 중간, 자사 기획전과 기간 중복 · 할인율 ≥ 자사면 높음, 브랜드 키워드 지면 경쟁사 광고 = 높음 (운영 가정).',
  ];
  const counter: string[] = [];
  if (holdEvs.length) counter.push(`${holdEvs.map((e) => e.diag.holdReason).filter(Boolean).join(' / ')} — 이 매체의 변동 진단은 전환 추적 확인 전까지 보류한다. 성과 하락처럼 보이는 수치가 집계 문제일 수 있다.`);
  counter.push('경쟁사 스냅샷은 하루 1회 수집 기준이라 장중 변경은 다음 날 반영된다. 가격 인하가 일시 쿠폰이면 영향은 1~2일에 그칠 수 있다.');
  counter.push('시즌 가설(이사 · 혼인)은 일반 관측이며 수면밀도 데이터로 검증되지 않았다. 생활 상황 유입 증가가 매체 측 노출 확대 때문일 가능성도 같이 본다.');

  const actions: string[] = [];
  for (const e of pendingDiag.slice(0, 3)) actions.push(`${titled(e)}: 영향 진단 (${e.due.label}) — 담당 AE, 판정 기준 p.47 주의 기준.`);
  for (const e of events.filter((x) => x.stage === 'diagnose' && !x.closed).slice(0, 3)) actions.push(`${mediaName(e.media)}: ${e.plan} — ${report.label}에 실행안으로 반영, PM 확인.`);
  for (const e of events.filter((x) => x.stage === 'plan' && !x.closed).slice(0, 3)) actions.push(`${mediaName(e.media)}: Lab 소액 테스트 등록 (일 ${fmt.krw(e.design.perDay)}원 × ${e.design.days}일, 승인 ${e.design.approverLabel})${e.next.disabled ? ` — 보류: ${e.next.disabled}` : ''}.`);
  for (const e of wrapReady.slice(0, 2)) actions.push(`${titled(e)}: 랩업 판정 ${e.judge.label} — ${e.judge.basis}. PM 기록 후 수면밀도 공유.`);
  for (const r of arcHigh.filter((x) => x.alertable).slice(0, 2)) actions.push(`${r.competitor} ${r.itemLabel} 변경: MILDO Alert P3 등록 · 24시간 내 영향 분석 (p.44) — SA Lead AE.`);
  if (serpAbove.length) actions.push(`브랜드 키워드 ${serpAbove.map((s) => `'${s.keyword}'`).join(' · ')}: 방어 입찰 검토를 AD Pilot 조정 후보로 전달 (브랜드 목표 ROAS ${cfg.brandTargetRoas}% · 순위 방어 우선) — SA Lead AE, PM 승인.`);
  for (const c of upcoming.slice(0, 2)) actions.push(`${c.label} D-${c.dday} (${c.kindLabel}, ${c.basis}): ${c.prep}.`);

  const brief: Brief = { title: `MILDO Watch 주간 인사이트 브리프 · ${label}`, facts, patterns, interpretation, conditions, counter, actions };
  const sec = (h: string, lines: string[]) => (lines.length ? `### ${h}\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '');
  const markdown = [
    `## MILDO Watch 주간 인사이트 브리프 (자동 초안) · ${label}`,
    `TEST DATA 기준 · 구성: 이번 주 감지 사항 → 영향 → 제안 · 발송 ${report.label} · 담당 AE 해석 · 다음 액션 보강 후 발송`,
    '',
    sec('확정 팩트', facts),
    sec('반복 관측 패턴', patterns),
    sec('AI 해석', interpretation.length ? interpretation.map((x) => x.replace(/^규칙 기반 해석: /, '(규칙 기반 · AI 미사용) ')) : []),
    sec('전제 조건 · 기준값', conditions),
    sec('반례 · 대체 시나리오', counter),
    sec('다음 액션', actions),
  ].filter((x) => x !== '').join('\n');

  return {
    period: { from, to, label },
    delivery: report.label,
    counts: { events: evs.length, notices: evs.filter((e) => e.origin === 'notice').length, signals: evs.filter((e) => e.origin === 'signal').length, impact: impactEvs.length, archive: arc.length, archiveHigh: arcHigh.length, serpAbove: serpAbove.length, upcoming: upcoming.length },
    brief,
    markdown,
  };
}

/* ============================== 재노출 (화면 · 도구에서 쓰는 상수) ============================== */

export { PIPELINE, STAGE_INDEX, OS_SCENARIO };
export const STAGE_LABEL: Record<StageId, string> = Object.fromEntries(PIPELINE.map((p) => [p.id, p.label])) as Record<StageId, string>;
export const KIND_LABEL = EVENT_KIND_LABEL;
export function roundN(v: number | undefined, digits = 0): number | null {
  if (!fin(v)) return null;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
export { r1 };
export type { ArchiveItemId, StageId };
