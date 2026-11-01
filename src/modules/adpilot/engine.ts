/**
 * AD Pilot 입찰 · 예산 최적화 + GFA Control v1 엔진 (제안서 p.14–16).
 * 순수 함수만 둔다 (React 의존 없음). 모든 판정은 Dataset 에서 계산하며 결과 수치는 시연용 테스트 데이터 기준이다.
 *
 * 규칙 (p.14)
 *  - 고효율(ROAS ≥ 목표×1.3) + 노출 기회 손실 ≥ 25%      → 입찰 상향 (최대 입찰가 내, 일 조정 폭 상한 20%)
 *  - 목표 ROAS 미달 지속(최근 14일 · 직전 14일) + 전환 ≥ 3 → 입찰 하향
 *  - 일 예산 조기 소진 예상                               → 예산 재배분 · 입찰 조정 제안
 *  - 신규 구매 의도 키워드(검색어 보고서 미등록 + 전환)     → 테스트 그룹 등록 후보
 *  - 성과 급변 · 수집 데이터 이상(최근 3일 CPC/전환 ±50%)   → 자동 조정 보류 · 알림
 *  - 브랜드 키워드 별도 기준(목표 ROAS 800%, 순위 방어 우선)
 */
import type {
  AdAccount, ApprovalLevel, Campaign, ChangeKind, ChangeRequest, Dataset, Incident, IntentId, Keyword, KeywordStats, MediaId,
} from '@/core/types';
import { AD_PILOT, CAUSE_CANDIDATES, GFA_DELEGATION, INTENT_IDS, KEYWORD_TEST_RULES, MEDIA, MEDIA_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { campaignPacing, mediaRows, monthlyPacing, previousRange, rangeOf, totalsOf } from '@/core/selectors';
import { addDays, clamp, fmt, fmtDate, metrics, sum, weekday } from '@/core/util';
import type { Brief } from '@/ai/prompts';
import {
  GFA_AD_GROUPS, GFA_DEMO_ACCOUNTS, GFA_DEMO_CAMPAIGNS, GFA_MAIN_ACCOUNT_ID, MODULE_ASSUMPTIONS,
} from './data';

/* ================================================================== */
/* 계약 타입 (다른 모듈이 사용) — 필드 유지                                */
/* ================================================================== */

export interface BidProposal {
  id: string;
  keywordId: string;
  keyword: string;
  rule: string;
  action: 'bid_up' | 'bid_down' | 'hold' | 'budget_shift' | 'test_candidate';
  before: number;
  after: number;
  changePct: number;
  reason: string;
  expected: string;
  guard: string[];
}

/* ================================================================== */
/* 설정                                                                */
/* ================================================================== */

export interface AdPilotConfig {
  targetRoas: number;
  brandTargetRoas: number;
  dailyChangeCapPct: number;
  highEfficiencyRoasRatio: number;
  lostShareTrigger: number;
  minConversionsForDown: number;
  anomalyHoldPct: number;
  anomalyWindowDays: number;
  anomalyMinClicks: number;
  anomalyMinExpectedConv: number;
  brandRankTarget: number;
  minStepPct: number;
  exhaustBeforeHour: number;
  bulkWarnCount: number;
  bulkBlockCount: number;
  clickElasticity: number;
  cpcElasticity: number;
  minBid: number;
  donorPaceMax: number;
  /** 반영된 현재 입찰가 (키워드 id → 원). 없으면 데이터의 시작 입찰가 */
  currentBids?: Record<string, number>;
}

export type NumericConfigKey = Exclude<keyof AdPilotConfig, 'currentBids'>;

export const DEFAULT_CONFIG: AdPilotConfig = {
  targetRoas: AD_PILOT.targetRoas,
  brandTargetRoas: AD_PILOT.brandTargetRoas,
  dailyChangeCapPct: AD_PILOT.dailyChangeCapPct,
  highEfficiencyRoasRatio: AD_PILOT.highEfficiencyRoasRatio,
  lostShareTrigger: AD_PILOT.lostShareTrigger,
  minConversionsForDown: AD_PILOT.minConversionsForDown,
  anomalyHoldPct: AD_PILOT.anomalyHoldPct,
  ...MODULE_ASSUMPTIONS,
};

/** 편집 가능한 기준값 메타 (SAFETY 패널 · 기준 변경 요청) */
export const CONFIG_FIELDS: { key: NumericConfigKey; label: string; unit: string; min: number; max: number; step: number; approver: ApprovalLevel; source: string }[] = [
  { key: 'targetRoas', label: '목표 ROAS', unit: '%', min: 50, max: 5000, step: 10, approver: 'CLIENT', source: 'p.14 · 온보딩 중 확정' },
  { key: 'brandTargetRoas', label: '브랜드 목표 ROAS', unit: '%', min: 50, max: 10000, step: 50, approver: 'CLIENT', source: 'p.14 브랜드 별도 기준' },
  { key: 'brandRankTarget', label: '브랜드 순위 방어 기준', unit: '위 이내', min: 1, max: 10, step: 0.5, approver: 'PM', source: '모듈 가정' },
  { key: 'dailyChangeCapPct', label: '일 조정 폭 상한', unit: '%', min: 1, max: 100, step: 1, approver: 'CLIENT', source: 'p.14 · 사전 합의' },
  { key: 'highEfficiencyRoasRatio', label: '고효율 기준 (목표 대비 배수)', unit: '배', min: 1, max: 5, step: 0.05, approver: 'PM', source: 'p.14' },
  { key: 'lostShareTrigger', label: '노출 기회 손실 기준', unit: '비율', min: 0.01, max: 0.95, step: 0.01, approver: 'PM', source: 'p.14' },
  { key: 'minConversionsForDown', label: '하향 전 최소 전환', unit: '건', min: 0, max: 100, step: 1, approver: 'PM', source: 'p.14' },
  { key: 'anomalyHoldPct', label: '급변 보류 기준', unit: '±%', min: 5, max: 500, step: 5, approver: 'PM', source: 'p.14 · p.44' },
  { key: 'bulkWarnCount', label: '대량 변경 경고', unit: '건 이상', min: 1, max: 100, step: 1, approver: 'PM', source: 'p.45 · 모듈 가정' },
  { key: 'bulkBlockCount', label: '대량 변경 차단', unit: '건 이상', min: 2, max: 200, step: 1, approver: 'PM', source: 'p.45 · 모듈 가정' },
];

const BOUNDS: Record<NumericConfigKey, [number, number]> = {
  targetRoas: [50, 5000],
  brandTargetRoas: [50, 10000],
  dailyChangeCapPct: [1, 100],
  highEfficiencyRoasRatio: [1, 5],
  lostShareTrigger: [0.01, 0.95],
  minConversionsForDown: [0, 100],
  anomalyHoldPct: [5, 500],
  anomalyWindowDays: [1, 7],
  anomalyMinClicks: [0, 10000],
  anomalyMinExpectedConv: [0, 1000],
  brandRankTarget: [1, 10],
  minStepPct: [0.5, 50],
  exhaustBeforeHour: [1, 24],
  bulkWarnCount: [1, 100],
  bulkBlockCount: [2, 200],
  clickElasticity: [0, 3],
  cpcElasticity: [0, 3],
  minBid: [10, 100000],
  donorPaceMax: [0.1, 1],
};
const NUMERIC_KEYS = Object.keys(BOUNDS) as NumericConfigKey[];

/** 부분 설정 → 전체 설정. 숫자가 아니거나 NaN/Infinity 인 값은 기본값, 범위 밖은 경계값으로 보정 */
export function resolveConfig(input?: Partial<AdPilotConfig> | null): AdPilotConfig {
  const out: AdPilotConfig = { ...DEFAULT_CONFIG };
  if (!input) return out;
  for (const k of NUMERIC_KEYS) {
    const v = input[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp(v, BOUNDS[k][0], BOUNDS[k][1]);
  }
  if (out.bulkBlockCount <= out.bulkWarnCount) out.bulkBlockCount = out.bulkWarnCount + 1;
  if (input.currentBids) out.currentBids = input.currentBids;
  return out;
}

export const CONFIG_TARGET_PREFIX = 'adpilot.cfg.';

/** 공식 기준 = 기본값 + 반영(applied)된 기준 변경 요청 */
export function officialConfig(changes: readonly ChangeRequest[] | undefined): AdPilotConfig {
  const patch: Partial<AdPilotConfig> = {};
  const applied = (changes ?? [])
    .filter((c) => c.module === 'adpilot' && c.kind === 'setting' && c.status === 'applied' && c.targetId?.startsWith(CONFIG_TARGET_PREFIX))
    .sort((a, b) => appliedAt(a).localeCompare(appliedAt(b)));
  for (const c of applied) {
    const key = c.targetId!.slice(CONFIG_TARGET_PREFIX.length) as NumericConfigKey;
    const v = Number(c.after);
    if (NUMERIC_KEYS.includes(key) && Number.isFinite(v)) (patch as Record<string, number>)[key] = v;
  }
  return resolveConfig(patch);
}

export function configDiff(a: AdPilotConfig, b: AdPilotConfig): { key: NumericConfigKey; before: number; after: number }[] {
  return CONFIG_FIELDS.filter((f) => a[f.key] !== b[f.key]).map((f) => ({ key: f.key, before: a[f.key], after: b[f.key] }));
}

/* ================================================================== */
/* 공통 헬퍼                                                            */
/* ================================================================== */

const round10 = (v: number) => Math.round(v / 10) * 10;
const floor10 = (v: number) => Math.floor(v / 10) * 10;
const ceil10 = (v: number) => Math.ceil(v / 10) * 10;
const round1 = (v: number) => Math.round(v * 10) / 10;
const finite = (v: number) => typeof v === 'number' && Number.isFinite(v);
const safeNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** 정수 % (천 단위 구분) — '4,442%' */
export const pct0 = (v: number) => (Number.isFinite(v) ? `${fmt.int(v)}%` : '—');

function aggregate(rows: readonly KeywordStats[]): KeywordStats {
  return {
    impressions: sum(rows, (r) => safeNum(r.impressions)),
    clicks: sum(rows, (r) => safeNum(r.clicks)),
    cost: sum(rows, (r) => safeNum(r.cost)),
    conversions: sum(rows, (r) => safeNum(r.conversions)),
    revenue: sum(rows, (r) => safeNum(r.revenue)),
  };
}

/** 시각(소수) → 'HH:MM' */
export function clock(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return '—';
  if (h >= 24) return '24시 이후';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const H = mm === 60 ? hh + 1 : hh;
  return `${String(H).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}

function appliedAt(c: ChangeRequest): string {
  const h = [...(c.history ?? [])].reverse().find((x) => /반영|적용|실행/.test(x.action));
  return h?.at ?? c.createdAt ?? '';
}

export const APPROVER_LABEL: Record<ApprovalLevel, string> = { AE: '담당 AE', PM: 'PM', CLIENT: '수면밀도 승인' };
export const AUTO_CHARGE_LABEL: Record<AdAccount['autoCharge'], string> = { ok: '정상', failed: '실패', off: '미사용', postpaid: '후불' };
export const ACCOUNT_STATUS_LABEL: Record<AdAccount['status'], string> = { active: '정상', review: '검수 · 확인 필요', restricted: '제재' };
export type Role = '담당 AE' | 'PM' | '수면밀도';

/** 역할별 승인 권한 (AE는 AE건, PM은 AE·PM건, 수면밀도는 전부) */
export function canApprove(role: Role | string, approver: ApprovalLevel): { ok: boolean; reason: string } {
  const allowed: Record<string, ApprovalLevel[]> = { '담당 AE': ['AE'], PM: ['AE', 'PM'], '수면밀도': ['AE', 'PM', 'CLIENT'] };
  const list = allowed[role] ?? [];
  if (list.includes(approver)) return { ok: true, reason: `${role} 승인 범위` };
  return { ok: false, reason: `${APPROVER_LABEL[approver]} 범위 건입니다 · 현재 역할 ${role}의 승인 범위는 ${list.length ? list.map((a) => APPROVER_LABEL[a]).join(' · ') : '없음'}` };
}

/* ================================================================== */
/* 승인 라우팅 (p.15 GFA_DELEGATION — AD Pilot 예산 · 입찰도 같은 폭 기준)   */
/* ================================================================== */

export type GfaChangeType = 'budget' | 'adgroup' | 'new_campaign' | 'status_check';

export interface Route {
  approver: ApprovalLevel;
  label: string;
  rowIndex: number;
  range: string;
  reason: string;
}

function rowRoute(i: number, reason: string): Route {
  const row = GFA_DELEGATION[i];
  return { approver: row.approver, label: row.label, rowIndex: i, range: row.range, reason };
}

/** 변경 폭(%) → 승인 주체: ±10% 이내 AE, ±10~30% PM, 30% 초과 수면밀도 (경계값은 '이내'에 포함) */
export function routeByPct(pct: number): Route {
  if (!Number.isFinite(pct)) return rowRoute(2, '변경 폭을 계산할 수 없어 최상위 승인으로 보냅니다');
  const a = Math.abs(pct);
  const i = GFA_DELEGATION.findIndex((r) => a <= r.maxPct + 1e-9);
  const idx = i < 0 ? 2 : i;
  return rowRoute(idx, `변경 폭 ${fmt.delta(pct)} → ${GFA_DELEGATION[idx].range}`);
}

/** GFA 변경 유형 · 폭 → 승인 주체 (p.15) */
export function routeGfaChange(type: GfaChangeType, pct?: number): Route {
  switch (type) {
    case 'status_check': return rowRoute(0, '상태 점검은 담당 AE 위임 범위');
    case 'adgroup': return rowRoute(1, '광고그룹 ON/OFF는 PM 승인');
    case 'new_campaign': return rowRoute(2, '신규 캠페인은 수면밀도 승인');
    case 'budget':
    default: return routeByPct(pct ?? NaN);
  }
}

const LEVEL_ORDER: ApprovalLevel[] = ['AE', 'PM', 'CLIENT'];
function atLeast(a: ApprovalLevel, min: ApprovalLevel): ApprovalLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(min) ? a : min;
}

/* ================================================================== */
/* 키워드 급변 · 수집 이상 (최근 N일 vs 직전 창)                           */
/* ================================================================== */

export interface CauseCandidate { cause: string; score: number; evidence: string }

export interface KeywordAnomaly {
  triggered: boolean;
  kind: 'spike' | 'collection' | null;
  windowDays: number;
  cpcDelta: number;
  convDelta: number;
  clickDelta: number;
  recentClicks: number;
  expectedConv: number;
  cpcEligible: boolean;
  convEligible: boolean;
  basis: string;
  causes: CauseCandidate[];
}

export function keywordAnomaly(k: Keyword, data: Dataset | null, cfgIn?: Partial<AdPilotConfig>): KeywordAnomaly {
  const cfg = resolveConfig(cfgIn);
  const n = Math.round(cfg.anomalyWindowDays);
  const daily = Array.isArray(k.daily) ? k.daily : [];
  const empty: KeywordAnomaly = {
    triggered: false, kind: null, windowDays: n, cpcDelta: NaN, convDelta: NaN, clickDelta: NaN, recentClicks: 0, expectedConv: 0,
    cpcEligible: false, convEligible: false, basis: '일자별 데이터 부족 — 급변 판정 불가', causes: [],
  };
  if (daily.length < n + 3) return empty;
  const invalid = daily.some((r) => [r.impressions, r.clicks, r.cost, r.conversions, r.revenue].some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0));
  const recentRows = daily.slice(-n);
  const baseRows = daily.slice(0, -n);
  const r = aggregate(recentRows);
  const b = aggregate(baseRows);
  const bDays = baseRows.length;
  const cpcR = metrics.cpc(r.cost, r.clicks);
  const cpcB = metrics.cpc(b.cost, b.clicks);
  const cpcDelta = finite(cpcR) && finite(cpcB) ? metrics.pctChange(cpcR, cpcB) : NaN;
  const convPerDayR = r.conversions / n;
  const convPerDayB = b.conversions / bDays;
  const convDelta = convPerDayB > 0 ? metrics.pctChange(convPerDayR, convPerDayB) : NaN;
  const clickDelta = b.clicks > 0 ? metrics.pctChange(r.clicks / n, b.clicks / bDays) : NaN;
  const expectedConv = convPerDayB * n;
  const cpcEligible = r.clicks >= cfg.anomalyMinClicks && b.clicks > 0;
  const convEligible = expectedConv >= cfg.anomalyMinExpectedConv;
  const missing = r.impressions === 0 && b.impressions > 0;
  const lim = cfg.anomalyHoldPct;
  const cpcHit = cpcEligible && finite(cpcDelta) && Math.abs(cpcDelta) >= lim;
  const convHit = convEligible && finite(convDelta) && Math.abs(convDelta) >= lim;
  const collection = invalid || missing;
  const triggered = collection || cpcHit || convHit;
  const parts: string[] = [];
  if (collection) parts.push(invalid ? '수집값 이상(음수 · 비수치)' : `최근 ${n}일 노출 0 (직전 일평균 ${fmt.int(b.impressions / bDays)})`);
  parts.push(`CPC ${n}일 ${fmt.delta(cpcDelta, 0)}${cpcEligible ? '' : ' (표본 부족)'}`);
  parts.push(`전환 ${fmt.delta(convDelta, 0)}${convEligible ? '' : ' (표본 부족)'}`);
  const basis = `${parts.join(' · ')} — 기준 ±${lim}%`;
  const out: KeywordAnomaly = {
    triggered, kind: collection ? 'collection' : triggered ? 'spike' : null, windowDays: n,
    cpcDelta, convDelta, clickDelta, recentClicks: r.clicks, expectedConv, cpcEligible, convEligible, basis, causes: [],
  };
  if (triggered) out.causes = rankCauses(k, out, data, r, b, bDays);
  return out;
}

/** 원인 후보(p.47 CAUSE_CANDIDATES)를 데이터 근거로 순위화 */
export function rankCauses(k: Keyword, an: Pick<KeywordAnomaly, 'cpcDelta' | 'convDelta' | 'clickDelta' | 'windowDays'>, data: Dataset | null, r?: KeywordStats, b?: KeywordStats, bDays?: number): CauseCandidate[] {
  const out: CauseCandidate[] = [];
  const [competitor, landing, promo, outage] = CAUSE_CANDIDATES;
  const cpcUp = finite(an.cpcDelta) ? an.cpcDelta : 0;
  const convDown = finite(an.convDelta) ? -an.convDelta : 0;
  const clicksStable = finite(an.clickDelta) ? Math.abs(an.clickDelta) < 30 : false;
  if (cpcUp > 0) {
    out.push({ cause: competitor, score: cpcUp / 50 + (clicksStable ? 0.5 : 0), evidence: `CPC ${fmt.delta(an.cpcDelta, 0)}${clicksStable ? ` · 클릭 ${fmt.delta(an.clickDelta, 0)}(유지)` : ''} — 같은 클릭에 단가만 상승` });
  }
  const sold = data ? soldoutLanding(data, k) : null;
  if (convDown > 0 || sold) {
    const cpcFlat = Math.abs(cpcUp) < 20;
    out.push({ cause: landing, score: (convDown / 50) * (cpcFlat ? 1 : 0.5) + (sold ? 2 : 0), evidence: sold ? `랜딩 옵션 '${sold.option}' 품절 · 전환 ${fmt.delta(an.convDelta, 0)}` : `전환 ${fmt.delta(an.convDelta, 0)}${cpcFlat ? ' · CPC 변화 작음' : ''}` });
  }
  if (data) {
    const from = addDays(data.today, -(an.windowDays - 1));
    const changed = data.promotions.filter((p) => (p.start >= from && p.start <= data.today) || (p.end >= from && p.end < data.today));
    if (changed.length) out.push({ cause: promo, score: 1, evidence: `최근 ${an.windowDays}일 프로모션 변경 ${changed.map((p) => p.name).join(', ')}` });
  }
  if (r && b && bDays && b.impressions > 0) {
    const impDelta = metrics.pctChange(r.impressions / an.windowDays, b.impressions / bDays);
    if (r.impressions === 0) out.push({ cause: outage, score: 3, evidence: '최근 노출 0 — 수집 누락 또는 매체 장애 의심' });
    else if (impDelta <= -50) out.push({ cause: outage, score: 1, evidence: `노출 ${fmt.delta(impDelta, 0)}` });
  }
  return out.filter((c) => c.score > 0).sort((a, b2) => b2.score - a.score).map((c) => ({ ...c, score: Math.round(c.score * 100) / 100 }));
}

/* ================================================================== */
/* 품절 랜딩 (p.45) — 키워드 문구에 품절 옵션명이 있고 랜딩이 해당 상품일 때     */
/* ================================================================== */

const normUrl = (u: string) => (u ?? '').trim().replace(/\/+$/, '').toLowerCase();

export function soldoutLanding(data: Dataset, k: Pick<Keyword, 'text' | 'landing'>): { product: string; option: string } | null {
  for (const p of data.products ?? []) {
    if (normUrl(p.landing) !== normUrl(k.landing)) continue;
    for (const o of p.options) if (!o.inStock && o.label && k.text.includes(o.label)) return { product: p.name, option: o.label };
  }
  return null;
}

/* ================================================================== */
/* 입찰 시뮬레이션 (탄력성 가정 — 실측 아님)                                */
/* ================================================================== */

export interface DayStats { clicks: number; cost: number; conversions: number; revenue: number; cpc: number; roas: number }
export interface BidSimulation {
  before: number;
  after: number;
  bidChangePct: number;
  assumptions: { clickElasticity: number; cpcElasticity: number; cvr: '불변' };
  base: DayStats;
  projected: DayStats;
  delta: { clicksPct: number; costPct: number; convPct: number; revenuePct: number };
  incrementalRoas: number;
  clickCapped: boolean;
}

function dayStats(clicks: number, cost: number, conversions: number, revenue: number): DayStats {
  return { clicks, cost, conversions, revenue, cpc: metrics.cpc(cost, clicks), roas: metrics.roas(revenue, cost) };
}

/**
 * 입찰 변경 효과 추정 (일 기준).
 * 클릭 = 기준 × (입찰비)^클릭탄력성 — 상향 시 노출 손실분 회수가 상한, CPC = 기준 × (입찰비)^CPC탄력성, CVR 불변.
 */
export function simulateBidChange(
  k: Pick<Keyword, 'last14' | 'impressionShareLost'>,
  before: number,
  after: number,
  cfgIn?: Partial<AdPilotConfig>,
  days = 14,
): BidSimulation {
  const cfg = resolveConfig(cfgIn);
  const s = k.last14 ?? { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  const d = days > 0 ? days : 14;
  const base = dayStats(safeNum(s.clicks) / d, safeNum(s.cost) / d, safeNum(s.conversions) / d, safeNum(s.revenue) / d);
  const r = before > 0 && after > 0 && finite(before) && finite(after) ? after / before : 1;
  let clickMult = r ** cfg.clickElasticity;
  let clickCapped = false;
  if (r > 1) {
    const lost = clamp(safeNum(k.impressionShareLost), 0, 0.95);
    const cap = 1 / (1 - lost);
    if (clickMult > cap) { clickMult = cap; clickCapped = true; }
  }
  const cpcMult = r ** cfg.cpcElasticity;
  const projected = dayStats(base.clicks * clickMult, base.cost * clickMult * cpcMult, base.conversions * clickMult, base.revenue * clickMult);
  const dCost = projected.cost - base.cost;
  const dRev = projected.revenue - base.revenue;
  return {
    before, after, bidChangePct: round1((r - 1) * 100),
    assumptions: { clickElasticity: cfg.clickElasticity, cpcElasticity: cfg.cpcElasticity, cvr: '불변' },
    base, projected,
    delta: {
      clicksPct: metrics.pctChange(projected.clicks, base.clicks),
      costPct: metrics.pctChange(projected.cost, base.cost),
      convPct: metrics.pctChange(projected.conversions, base.conversions),
      revenuePct: metrics.pctChange(projected.revenue, base.revenue),
    },
    incrementalRoas: Math.abs(dCost) > 1e-9 ? (dRev / dCost) * 100 : NaN,
    clickCapped,
  };
}

/** 입찰 수준별 곡선 (−30% ~ +30%) */
export function simulateCurve(k: Pick<Keyword, 'last14' | 'impressionShareLost'>, current: number, cfgIn?: Partial<AdPilotConfig>, steps: number[] = [-30, -20, -10, 0, 10, 20, 30]) {
  return steps.map((p) => {
    const bid = round10(current * (1 + p / 100));
    const s = simulateBidChange(k, current, bid, cfgIn);
    return { pct: p, bid, cost: s.projected.cost, revenue: s.projected.revenue, roas: s.projected.roas, incrementalRoas: s.incrementalRoas };
  });
}

function simText(s: BidSimulation): string {
  return `일 기준 클릭 ${fmt.delta(s.delta.clicksPct)} · 비용 ${fmt.delta(s.delta.costPct)}(${s.projected.cost - s.base.cost >= 0 ? '+' : ''}${fmt.krw(s.projected.cost - s.base.cost)}) · 전환 ${fmt.delta(s.delta.convPct)} · 증분 ROAS ${fmt.roas(s.incrementalRoas)} (탄력성 가정)`;
}

/* ================================================================== */
/* 키워드 진단                                                          */
/* ================================================================== */

export type Verdict = 'up' | 'defend' | 'down' | 'hold' | 'keep' | 'watch' | 'test' | 'capped' | 'off';
export type VerdictTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'outline' | 'accent';
export const VERDICT_META: Record<Verdict, { label: string; tone: VerdictTone; icon: string }> = {
  up: { label: '입찰 상향', tone: 'good', icon: 'up' },
  defend: { label: '방어 상향', tone: 'good', icon: 'shield' },
  down: { label: '입찰 하향', tone: 'serious', icon: 'down' },
  hold: { label: '자동 조정 보류', tone: 'warning', icon: 'alert' },
  keep: { label: '유지', tone: 'neutral', icon: 'check' },
  watch: { label: '관찰', tone: 'outline', icon: 'watch' },
  test: { label: '테스트 중', tone: 'outline', icon: 'lab' },
  capped: { label: '상한 도달', tone: 'neutral', icon: 'stop' },
  off: { label: 'OFF', tone: 'neutral', icon: 'pause' },
};

export type RuleId = 'high_efficiency' | 'below_target' | 'early_exhaust' | 'new_intent' | 'anomaly' | 'brand' | 'soldout';
export const RULE_LABEL: Record<RuleId, string> = {
  high_efficiency: '고효율 · 노출 손실',
  below_target: '목표 미달 지속',
  early_exhaust: '일 예산 조기 소진',
  new_intent: '신규 구매 의도',
  anomaly: '성과 급변 · 데이터 이상',
  brand: '브랜드 별도 기준',
  soldout: '품절 랜딩',
};

export interface KeywordDiagnosis {
  id: string;
  text: string;
  intent: IntentId;
  adgroup: string;
  isBrand: boolean;
  status: Keyword['status'] | 'off';
  roas: number;
  prevRoas: number;
  target: number;
  ratioPct: number;
  prevRatioPct: number;
  conversions: number;
  clicks: number;
  cost: number;
  cpc: number;
  cvr: number;
  lost: number;
  rank: number;
  startBid: number;
  bid: number;
  maxBid: number;
  verdict: Verdict;
  ruleId: RuleId | null;
  basis: string;
  note: string;
  proposedBid: number | null;
  proposedPct: number | null;
  limitedBy: string[];
  anomaly: KeywordAnomaly;
  soldout: { product: string; option: string } | null;
}

function pctOf(v: number, t: number) {
  return finite(v) && t > 0 ? (v / t) * 100 : NaN;
}

function planUp(start: number, current: number, maxBid: number, wanted: number, cfg: AdPilotConfig): { after: number; pct: number; limitedBy: string[] } | { capped: string } {
  if (!(current > 0)) return { capped: '현재 입찰가 없음' };
  if (current >= maxBid) return { capped: `최대 입찰가 ${fmt.won(maxBid)} 도달` };
  const capAbs = floor10(start * (1 + cfg.dailyChangeCapPct / 100));
  if (capAbs <= current) return { capped: `오늘 조정 한도 소진 (시작가 ${fmt.won(start)} 대비 상한 ${cfg.dailyChangeCapPct}%)` };
  const w = clamp(wanted, cfg.minStepPct, cfg.dailyChangeCapPct);
  let after = round10(current * (1 + w / 100));
  const limitedBy: string[] = [];
  if (after > capAbs) { after = capAbs; limitedBy.push(`일 조정 폭 상한 ${cfg.dailyChangeCapPct}%`); }
  if (after > maxBid) { after = floor10(maxBid); limitedBy.push(`최대 입찰가 ${fmt.won(maxBid)}`); }
  if (after <= current) return { capped: '조정 여유 없음' };
  return { after, pct: round1((after / current - 1) * 100), limitedBy };
}

function planDown(start: number, current: number, wanted: number, cfg: AdPilotConfig): { after: number; pct: number; limitedBy: string[] } | { capped: string } {
  if (!(current > 0)) return { capped: '현재 입찰가 없음' };
  const floorAbs = Math.max(cfg.minBid, ceil10(start * (1 - cfg.dailyChangeCapPct / 100)));
  if (floorAbs >= current) return { capped: `오늘 하향 한도 소진 · 최소 ${fmt.won(floorAbs)}` };
  const w = clamp(wanted, cfg.minStepPct, cfg.dailyChangeCapPct);
  let after = round10(current * (1 - w / 100));
  const limitedBy: string[] = [];
  if (after < floorAbs) { after = floorAbs; limitedBy.push(`일 조정 폭 상한 ${cfg.dailyChangeCapPct}%`); }
  if (after >= current) return { capped: '조정 여유 없음' };
  return { after, pct: round1((after / current - 1) * 100), limitedBy };
}

/** 전 키워드 판정 — 판정마다 기준값 · 근거 수치를 함께 반환 */
export function diagnoseKeywords(data: Dataset, cfgIn?: Partial<AdPilotConfig>, statusOverride?: Record<string, 'on' | 'off'>): KeywordDiagnosis[] {
  const cfg = resolveConfig(cfgIn);
  if (!data || !Array.isArray(data.keywords)) return [];
  return data.keywords.map((k) => diagnoseKeyword(data, k, cfg, statusOverride?.[k.id]));
}

export function diagnoseKeyword(data: Dataset, k: Keyword, cfg: AdPilotConfig, statusOverride?: 'on' | 'off'): KeywordDiagnosis {
  const s = k.last14 ?? { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  const p = k.prev14 ?? { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  const roas = metrics.roas(safeNum(s.revenue), safeNum(s.cost));
  const prevRoas = metrics.roas(safeNum(p.revenue), safeNum(p.cost));
  const target = k.isBrand ? cfg.brandTargetRoas : cfg.targetRoas;
  const ratioPct = pctOf(roas, target);
  const prevRatioPct = pctOf(prevRoas, target);
  const startBid = safeNum(k.bid);
  const current = cfg.currentBids && finite(cfg.currentBids[k.id]) ? cfg.currentBids[k.id] : startBid;
  const lost = clamp(safeNum(k.impressionShareLost), 0, 1);
  const rank = safeNum(k.avgRank);
  const conv = safeNum(s.conversions);
  const anomaly = keywordAnomaly(k, data, cfg);
  const soldout = soldoutLanding(data, k);
  const status = statusOverride === 'off' ? 'off' : k.status;
  const base: KeywordDiagnosis = {
    id: k.id, text: k.text, intent: k.intent, adgroup: k.adgroup, isBrand: k.isBrand, status,
    roas, prevRoas, target, ratioPct, prevRatioPct, conversions: conv, clicks: safeNum(s.clicks), cost: safeNum(s.cost),
    cpc: metrics.cpc(safeNum(s.cost), safeNum(s.clicks)), cvr: metrics.cvr(conv, safeNum(s.clicks)),
    lost, rank, startBid, bid: current, maxBid: safeNum(k.maxBid),
    verdict: 'keep', ruleId: null, basis: '', note: '', proposedBid: null, proposedPct: null, limitedBy: [], anomaly, soldout,
  };
  const roasTxt = `ROAS ${fmt.roas(roas)} · ${k.isBrand ? '브랜드 ' : ''}목표 ${fmt.roas(target)} 대비 ${pct0(ratioPct)}`;
  const set = (v: Verdict, ruleId: RuleId | null, basis: string, note = '') => Object.assign(base, { verdict: v, ruleId, basis, note });

  if (status === 'off') return set('off', null, roasTxt, '광고 OFF 반영됨 — 입찰 조정 대상 아님');
  if (k.status === 'test') return set('test', null, `${roasTxt} · 클릭 ${fmt.int(base.clicks)}`, `테스트 그룹 — MILDO Lab 판정 대상 (${KEYWORD_TEST_RULES.minDays}일 또는 클릭 ${KEYWORD_TEST_RULES.minClicks}회)`);
  if (anomaly.triggered) return set('hold', 'anomaly', anomaly.basis, `원인 후보: ${anomaly.causes.map((c) => c.cause).join(' > ') || '확인 필요'}`);
  if (soldout) return set('hold', 'soldout', `랜딩 옵션 '${soldout.option}' 품절 · ${roasTxt}`, '구매할 수 없는 페이지 — 입찰 조정 보류, 광고 일시 중지 검토 (p.45)');
  if (!finite(roas) || base.clicks <= 0) return set('watch', null, `클릭 ${fmt.int(base.clicks)} · 비용 ${fmt.won(base.cost)}`, '집행 표본 없음 — 판정 보류');

  if (k.isBrand) {
    const rankGap = rank - cfg.brandRankTarget;
    const needDefense = lost >= cfg.lostShareTrigger || rankGap > 0;
    const basis = `${roasTxt} · 순위 ${rank.toFixed(1)}위(기준 ≤ ${cfg.brandRankTarget}위) · 노출 손실 ${fmt.ratio(lost, 0)}(기준 ≥ ${fmt.ratio(cfg.lostShareTrigger, 0)})`;
    if (roas >= cfg.brandTargetRoas && needDefense) {
      const plan = planUp(startBid, current, base.maxBid, Math.max(lost * 50, rankGap * 10), cfg);
      if ('capped' in plan) return set('capped', 'brand', basis, plan.capped);
      Object.assign(base, { proposedBid: plan.after, proposedPct: plan.pct, limitedBy: plan.limitedBy });
      return set('defend', 'brand', basis, '점유 방어 · 순위 방어 우선');
    }
    if (roas < cfg.brandTargetRoas) return set('watch', 'brand', basis, '브랜드 목표 미달 — 순위 방어 우선이라 자동 하향하지 않고 PM 검토');
    return set('keep', 'brand', basis, '순위 · 점유 기준 충족');
  }

  const highEff = roas >= target * cfg.highEfficiencyRoasRatio;
  if (highEff && lost >= cfg.lostShareTrigger) {
    const basis = `${roasTxt}(기준 ≥ ${pct0(cfg.highEfficiencyRoasRatio * 100)}) · 노출 손실 ${fmt.ratio(lost, 0)}(기준 ≥ ${fmt.ratio(cfg.lostShareTrigger, 0)}) · 순위 ${rank.toFixed(1)}위`;
    const plan = planUp(startBid, current, base.maxBid, lost * 50, cfg);
    if ('capped' in plan) return set('capped', 'high_efficiency', basis, plan.capped);
    Object.assign(base, { proposedBid: plan.after, proposedPct: plan.pct, limitedBy: plan.limitedBy });
    return set('up', 'high_efficiency', basis, '노출 기회 회수');
  }
  const below = roas < target;
  const prevBelow = finite(prevRoas) && prevRoas < target;
  if (below) {
    const basis = `${roasTxt} · 직전 14일 ${pct0(prevRatioPct)} · 전환 ${fmt.dec1(conv)}건(기준 ≥ ${cfg.minConversionsForDown}건)`;
    if (!finite(prevRoas)) return set('watch', 'below_target', basis, '직전 14일 데이터 없음 — 지속 미달 판정 불가');
    if (!prevBelow) return set('watch', 'below_target', basis, '직전 14일은 목표 충족 — 지속 미달 아님');
    if (conv < cfg.minConversionsForDown) return set('watch', 'below_target', basis, `전환 ${fmt.dec1(conv)}건 < ${cfg.minConversionsForDown}건 — 하향 보류(표본 부족)`);
    const plan = planDown(startBid, current, (1 - roas / target) * 100, cfg);
    if ('capped' in plan) return set('capped', 'below_target', basis, plan.capped);
    Object.assign(base, { proposedBid: plan.after, proposedPct: plan.pct, limitedBy: plan.limitedBy });
    return set('down', 'below_target', basis, '효율 회복');
  }
  if (highEff) return set('keep', 'high_efficiency', `${roasTxt} · 노출 손실 ${fmt.ratio(lost, 0)}(기준 ≥ ${fmt.ratio(cfg.lostShareTrigger, 0)} 미달)`, '고효율 · 노출 손실 작음 — 유지');
  return set('keep', null, `${roasTxt} · 노출 손실 ${fmt.ratio(lost, 0)}`, '목표 이상 · 고효율 기준 미만 — 유지');
}

/* ================================================================== */
/* 캠페인 소진 예측 (선형 = campaignPacing, 시간대 가중 = mediaHourly 곡선)   */
/* ================================================================== */

const curveCache = new WeakMap<Dataset, Map<string, number[]>>();

/** 매체의 최근 28일(오늘 제외) 시간대별 누적 광고비 비중 (0시~h시 종료까지) */
export function hourlyCostCurve(data: Dataset, media: MediaId, days = 28): number[] {
  let byData = curveCache.get(data);
  if (!byData) { byData = new Map(); curveCache.set(data, byData); }
  const key = `${media}:${days}`;
  const hit = byData.get(key);
  if (hit) return hit;
  const from = addDays(data.today, -days);
  const byH = new Array<number>(24).fill(0);
  let tot = 0;
  for (const r of data.mediaHourly ?? []) {
    if (r.media !== media || r.date >= data.today || r.date < from || r.hour < 0 || r.hour > 23) continue;
    const c = safeNum(r.cost);
    byH[r.hour] += c;
    tot += c;
  }
  let acc = 0;
  const cum = tot > 0 ? byH.map((v) => (acc += v) / tot) : byH.map((_, h) => (h + 1) / 24);
  byData.set(key, cum);
  return cum;
}

export interface CampaignPace {
  id: string;
  name: string;
  media: MediaId;
  intent?: IntentId;
  status: Campaign['status'];
  dailyBudget: number;
  spentToday: number;
  hourOfData: number;
  pacePct: number;
  linearExhaustHour: number | null;
  linearEarly: boolean;
  curveExhaustHour: number | null;
  /** 오늘 예상 수요(시간대 가중) / 일 예산 */
  projectedRatio: number;
  projectedSpend: number;
  earlyExhaust: boolean;
  missesPeak: boolean;
}

function curveExhaust(cum: number[], ratio: number): number | null {
  if (!(ratio > 1) || !finite(ratio)) return null;
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

/** 캠페인별 예상 마감 — 선형(campaignPacing)과 시간대 가중 곡선을 함께 계산 */
export function paceCampaigns(data: Dataset, campaigns?: readonly Campaign[], cfgIn?: Partial<AdPilotConfig>): CampaignPace[] {
  const cfg = resolveConfig(cfgIn);
  const list = campaigns ?? data.campaigns ?? [];
  if (!list.length) return [];
  const linear = campaignPacing({ ...data, campaigns: [...list] });
  return list.map((c, i) => {
    const lin = linear[i];
    const cum = hourlyCostCurve(data, c.media);
    const hour = clamp(Math.round(safeNum(c.hourOfData)), 0, 23);
    const cumNow = cum[hour];
    const budget = safeNum(c.dailyBudget);
    const spent = safeNum(c.spentToday);
    const ratio = budget > 0 && cumNow > 0 ? spent / (budget * cumNow) : NaN;
    const curveHour = c.status === 'off' ? null : curveExhaust(cum, ratio);
    const linHour = lin && finite(lin.exhaustHour as number) ? (lin.exhaustHour as number) : null;
    const linearEarly = c.status !== 'off' && budget > 0 && !!lin?.earlyExhaust;
    const curveEarly = curveHour !== null && curveHour < cfg.exhaustBeforeHour;
    const exhaust = curveHour ?? (linearEarly ? linHour : null);
    return {
      id: c.id, name: c.name, media: c.media, intent: c.intent, status: c.status,
      dailyBudget: budget, spentToday: spent, hourOfData: hour,
      pacePct: budget > 0 ? (spent / budget) * 100 : NaN,
      linearExhaustHour: linHour, linearEarly,
      curveExhaustHour: curveHour,
      projectedRatio: ratio,
      projectedSpend: finite(ratio) ? budget * ratio : spent,
      earlyExhaust: linearEarly || curveEarly,
      missesPeak: exhaust !== null && exhaust < 21,
    };
  });
}

/* ================================================================== */
/* 매체 단위 수집 · 급변 가드 (오늘 시간대 데이터)                          */
/* ================================================================== */

export interface MediaGuard {
  media: MediaId;
  hold: boolean;
  kind: 'data_spike' | 'tracking_break' | null;
  windowHours: number[];
  costDelta: number;
  clicksDelta: number;
  convDelta: number;
  zeroRunHours: number;
  zeroRunFrom: number | null;
  histZeroRate: number;
  basis: string;
}

/** 오늘 최근 2시간: 광고비 · 클릭은 동요일 · 동시간(최근 4주) 평균, 전환은 최근 7일 동시간 대비. 전환 0 연속은 추적 단절 의심 */
export function mediaGuards(data: Dataset, cfgIn?: Partial<AdPilotConfig>): Record<MediaId, MediaGuard> {
  const cfg = resolveConfig(cfgIn);
  const out = {} as Record<MediaId, MediaGuard>;
  const H = clamp(Math.round(safeNum(data?.currentHour)), 0, 23);
  const wd = data ? weekday(data.today) : 0;
  const win = H > 0 ? [H - 1, H] : [H];
  const hourly = data?.mediaHourly ?? [];
  const from28 = data ? addDays(data.today, -28) : '';
  const from7 = data ? addDays(data.today, -7) : '';
  for (const m of MEDIA_IDS) {
    const g: MediaGuard = { media: m, hold: false, kind: null, windowHours: win, costDelta: NaN, clicksDelta: NaN, convDelta: NaN, zeroRunHours: 0, zeroRunFrom: null, histZeroRate: NaN, basis: '시간대 데이터 없음' };
    out[m] = g;
    if (!data) continue;
    const todayRows = hourly.filter((r) => r.media === m && r.date === data.today);
    if (!todayRows.length) continue;
    const tCost = sum(todayRows.filter((r) => win.includes(r.hour)), (r) => safeNum(r.cost));
    const tClicks = sum(todayRows.filter((r) => win.includes(r.hour)), (r) => safeNum(r.clicks));
    const tConv = sum(todayRows.filter((r) => win.includes(r.hour)), (r) => safeNum(r.conversions));
    let bCost = 0, bClicks = 0;
    for (const h of win) {
      const rows = hourly.filter((r) => r.media === m && r.hour === h && r.weekday === wd && r.date < data.today && r.date >= from28);
      if (rows.length) {
        bCost += sum(rows, (r) => safeNum(r.cost)) / rows.length;
        bClicks += sum(rows, (r) => safeNum(r.clicks)) / rows.length;
      }
    }
    const conv7 = hourly.filter((r) => r.media === m && win.includes(r.hour) && r.date < data.today && r.date >= from7);
    const days7 = new Set(conv7.map((r) => r.date)).size;
    const bConv = days7 ? sum(conv7, (r) => safeNum(r.conversions)) / days7 : NaN;
    g.costDelta = bCost > 0 ? metrics.pctChange(tCost, bCost) : NaN;
    g.clicksDelta = bClicks > 0 ? metrics.pctChange(tClicks, bClicks) : NaN;
    g.convDelta = bConv > 0 ? metrics.pctChange(tConv, bConv) : NaN;
    // 전환 0 연속 (클릭은 발생)
    let run = 0;
    let runClicks = 0;
    for (let h = H; h >= 0; h--) {
      const r = todayRows.find((x) => x.hour === h);
      if (!r || r.clicks <= 0 || r.conversions !== 0) break;
      run++;
      runClicks += r.clicks;
    }
    const hist = hourly.filter((r) => r.media === m && r.date < data.today && r.date >= from28 && r.hour <= H && r.clicks > 0);
    g.histZeroRate = hist.length ? hist.filter((r) => r.conversions === 0).length / hist.length : NaN;
    let runBaseClicks = 0;
    for (let h = H - run + 1; h <= H; h++) {
      const rows = hourly.filter((r) => r.media === m && r.hour === h && r.weekday === wd && r.date < data.today && r.date >= from28);
      if (rows.length) runBaseClicks += sum(rows, (r) => r.clicks) / rows.length;
    }
    g.zeroRunHours = run;
    g.zeroRunFrom = run > 0 ? H - run + 1 : null;
    const trackingBreak = run >= 2 && finite(g.histZeroRate) && g.histZeroRate < 0.05 && runBaseClicks > 0 && runClicks >= runBaseClicks * 0.5;
    const spike = (finite(g.costDelta) && Math.abs(g.costDelta) >= cfg.anomalyHoldPct) || (finite(g.clicksDelta) && Math.abs(g.clicksDelta) >= cfg.anomalyHoldPct);
    const winTxt = win.length > 1 ? `${win[0]}~${win[win.length - 1]}시` : `${win[0]}시`;
    if (trackingBreak) {
      g.hold = true;
      g.kind = 'tracking_break';
      g.basis = `${g.zeroRunFrom}시 이후 ${run}시간 전환 0 · 클릭 ${fmt.int(runClicks)}회(동시간 평균 ${fmt.int(runBaseClicks)}회) · 최근 4주 동시간대 전환 0 발생률 ${fmt.ratio(g.histZeroRate, 0)}`;
    } else if (spike) {
      g.hold = true;
      g.kind = 'data_spike';
      g.basis = `오늘 ${winTxt} 광고비 ${fmt.delta(g.costDelta, 0)} · 클릭 ${fmt.delta(g.clicksDelta, 0)}(동요일 · 동시간 4주 평균 대비) · 전환 ${fmt.delta(g.convDelta, 0)}(최근 7일 동시간 대비) — 기준 ±${cfg.anomalyHoldPct}%`;
    } else {
      g.basis = `오늘 ${winTxt} 광고비 ${fmt.delta(g.costDelta, 0)} · 클릭 ${fmt.delta(g.clicksDelta, 0)} · 전환 ${fmt.delta(g.convDelta, 0)} — 기준 ±${cfg.anomalyHoldPct}% 이내`;
    }
  }
  return out;
}

/* ================================================================== */
/* 캠페인 효율 · 예산 제안                                               */
/* ================================================================== */

export interface CampaignEfficiency { roas: number; target: number; ratioPct: number; source: string; newCpa: number; prevNewCpa: number; efficient: boolean; judgeNote: string }

export function campaignEfficiency(data: Dataset, c: Pick<Campaign, 'media' | 'intent'>, cfgIn?: Partial<AdPilotConfig>): CampaignEfficiency {
  const cfg = resolveConfig(cfgIn);
  const r = rangeOf(data, 'last14');
  const pr = previousRange(r);
  const mt = totalsOf(mediaRows(data, r.from, r.to, c.media));
  const mp = totalsOf(mediaRows(data, pr.from, pr.to, c.media));
  const newCpa = mt.newCustomers > 0 ? mt.cost / mt.newCustomers : NaN;
  const prevNewCpa = mp.newCustomers > 0 ? mp.cost / mp.newCustomers : NaN;
  if (c.media === 'naver_sa' && c.intent) {
    const ks = (data.keywords ?? []).filter((k) => k.intent === c.intent);
    const cost = sum(ks, (k) => safeNum(k.last14?.cost));
    const rev = sum(ks, (k) => safeNum(k.last14?.revenue));
    const roas = metrics.roas(rev, cost);
    const target = c.intent === 'brand' ? cfg.brandTargetRoas : cfg.targetRoas;
    return { roas, target, ratioPct: pctOf(roas, target), source: `${SA_CAMPAIGNS[c.intent].name} 키워드 ${ks.length}개 최근 14일`, newCpa, prevNewCpa, efficient: finite(roas) && roas >= target, judgeNote: `판단 지표 ${SA_CAMPAIGNS[c.intent].metric}` };
  }
  const target = cfg.targetRoas;
  return {
    roas: mt.roas, target, ratioPct: pctOf(mt.roas, target), source: `${MEDIA[c.media].name} 최근 14일`, newCpa, prevNewCpa,
    efficient: finite(mt.roas) && mt.roas >= target,
    judgeNote: `${MEDIA[c.media].name} 판단 지표는 ${MEDIA[c.media].judgeMetric}(p.37) — ROAS 단독으로 중단 근거로 쓰지 않음`,
  };
}

/* ================================================================== */
/* 신규 구매 의도 후보 (검색어 보고서)                                     */
/* ================================================================== */

export function classifyIntent(term: string): IntentId {
  const t = term ?? '';
  if (/(수면밀도|밀도\s?매트리스|밀도매트리스)/.test(t)) return 'brand';
  if (/(신혼|이사|자취|첫\s?독립|아이\s?방|부모님|선물|입주|집들이)/.test(t)) return 'life';
  if (/(허리|디스크|꺼짐|처짐|통기|더위|소음|경도|단단|푹신|뒤척|보상)/.test(t)) return 'problem';
  if (/(추천|비교|vs|VS|순위|가성비|후기|리뷰)/.test(t)) return 'compare';
  return 'generic';
}

const MEDICAL_CONTEXT = /(디스크|통증|척추|허리\s?아플|허리\s?통증|교정)/;

export interface TestCandidate {
  term: string;
  intent: IntentId;
  clicks: number;
  conversions: number;
  cost: number;
  revenue: number;
  roas: number;
  cpc: number;
  suggestedBid: number;
  bidCap: number;
  adgroup: string;
  landing: string;
  cautions: string[];
  score: number;
}

function median(arr: number[]): number {
  const a = arr.filter(finite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 검색어 보고서 미등록 + 전환 발생 → 테스트 그룹 등록 후보 */
export function testCandidates(data: Dataset, cfgIn?: Partial<AdPilotConfig>): TestCandidate[] {
  const cfg = resolveConfig(cfgIn);
  const existing = new Set((data?.keywords ?? []).map((k) => k.text.replace(/\s+/g, '')));
  return (data?.searchTerms ?? [])
    .filter((t) => !t.registered && safeNum(t.conversions) > 0 && !existing.has(t.term.replace(/\s+/g, '')))
    .map((t) => {
      const intent = classifyIntent(t.term);
      const group = (data.keywords ?? []).filter((k) => k.intent === intent && k.status === 'on');
      const med = median(group.map((k) => k.bid));
      const cpc = metrics.cpc(safeNum(t.cost), safeNum(t.clicks));
      const bidCap = finite(med) ? round10(med) : 1000;
      const suggestedBid = Math.max(cfg.minBid, round10(finite(cpc) ? Math.min(cpc, bidCap) : bidCap));
      const roas = metrics.roas(safeNum(t.revenue), safeNum(t.cost));
      const cautions: string[] = [];
      if (MEDICAL_CONTEXT.test(t.term)) cautions.push('의료 연관 검색 맥락 — 문안 · 랜딩 의료 효능 표현 금지 (검수 필수)');
      if (intent === 'brand') cautions.push('브랜드 검색어 — 브랜드 방어 캠페인 편입 검토 (브랜드 별도 기준)');
      if (safeNum(t.clicks) < KEYWORD_TEST_RULES.minClicks) cautions.push(`누적 클릭 ${fmt.int(t.clicks)}회 < 테스트 판정 최소 ${KEYWORD_TEST_RULES.minClicks}회 — 등록 후 표본 확보 필요`);
      return {
        term: t.term, intent, clicks: safeNum(t.clicks), conversions: safeNum(t.conversions), cost: safeNum(t.cost), revenue: safeNum(t.revenue),
        roas, cpc, suggestedBid, bidCap, adgroup: `${intent.toUpperCase()}_TEST`, landing: SA_CAMPAIGNS[intent].landing, cautions,
        score: Math.round(safeNum(t.conversions) * 10 * (finite(roas) ? Math.min(3, roas / cfg.targetRoas) : 0)) / 10,
      };
    })
    .sort((a, b) => b.score - a.score || b.conversions - a.conversions);
}

/* ================================================================== */
/* 조정 후보 생성 (계약 함수)                                             */
/* ================================================================== */

export interface AdPilotProposal extends BidProposal {
  ruleId: RuleId;
  targetType: 'keyword' | 'campaign' | 'media' | 'search_term';
  /** ChangeRequest.targetId 로 쓰는 키 */
  changeTargetId: string;
  kind: ChangeKind;
  media: MediaId;
  intent?: IntentId;
  isBrand: boolean;
  /** 판정 배지 옆에 보여줄 기준값 · 근거 */
  basis: string;
  approver: ApprovalLevel;
  approverReason: string;
  unit: 'won' | 'budget' | 'none';
  priority: number;
  holdKind?: 'keyword_anomaly' | 'collection' | 'soldout' | 'data_spike' | 'tracking_break' | 'account' | 'efficiency' | 'monthly_over';
  causes?: CauseCandidate[];
  sim?: BidSimulation;
  donor?: { id: string; name: string; before: number; after: number };
  /** 비용 영향 (일, 원) — 대량 변경 점검용 */
  costDelta: number;
}

const ACTION_ORDER: Record<BidProposal['action'], number> = { hold: 0, bid_up: 1, bid_down: 2, budget_shift: 3, test_candidate: 4 };

function keywordProposals(data: Dataset, cfg: AdPilotConfig, diag: KeywordDiagnosis[]): AdPilotProposal[] {
  const out: AdPilotProposal[] = [];
  const kwById = new Map(data.keywords.map((k) => [k.id, k]));
  for (const d of diag) {
    const k = kwById.get(d.id)!;
    const common = { keywordId: d.id, keyword: d.text, targetType: 'keyword' as const, changeTargetId: d.id, media: 'naver_sa' as MediaId, intent: d.intent, isBrand: d.isBrand };
    if (d.verdict === 'hold') {
      const sold = d.ruleId === 'soldout';
      out.push({
        ...common,
        id: `hold:${d.id}:${data.today}`,
        rule: RULE_LABEL[d.ruleId ?? 'anomaly'],
        ruleId: d.ruleId ?? 'anomaly',
        action: 'hold', before: d.bid, after: d.bid, changePct: 0,
        reason: sold
          ? `'${d.text}' 랜딩(${k.landing})의 '${d.soldout!.option}' 옵션이 품절입니다. 구매할 수 없는 페이지로 클릭이 유입되므로 입찰 조정을 보류하고 광고 일시 중지를 검토합니다.`
          : `최근 ${d.anomaly.windowDays}일 성과가 기준 이상 급변했습니다. 잘못된 신호로 입찰이 움직이지 않도록 자동 조정을 보류하고 원인을 먼저 확인합니다.`,
        expected: sold ? '일시 중지 시 품절 랜딩 유입 비용 차단 · 재입고 후 재개' : '원인 확인 후 재판정 · 1시간 내 원인 보고 (p.44 데이터 급변)',
        guard: sold ? ['품절 랜딩 → 입찰 상향 차단', '광고 OFF는 PM 승인 (p.15 ON/OFF)'] : ['자동 조정 보류', `기준 ±${cfg.anomalyHoldPct}% · 최소 표본 클릭 ${cfg.anomalyMinClicks}회`],
        kind: sold ? 'status' : 'bid',
        basis: d.basis,
        approver: 'PM', approverReason: '보류 해제 · 일시 중지 판단은 PM',
        unit: 'won', priority: sold ? 2 : 1,
        holdKind: sold ? 'soldout' : d.anomaly.kind === 'collection' ? 'collection' : 'keyword_anomaly',
        causes: sold ? rankCauses(k, d.anomaly, data) : d.anomaly.causes,
        costDelta: 0,
      });
      continue;
    }
    if ((d.verdict === 'up' || d.verdict === 'defend' || d.verdict === 'down') && d.proposedBid !== null && d.proposedPct !== null) {
      const sim = simulateBidChange(k, d.bid, d.proposedBid, cfg);
      let route = routeByPct(d.proposedPct);
      let approverReason = route.reason;
      if (d.isBrand && LEVEL_ORDER.indexOf(route.approver) < 1) {
        route = { ...route, approver: 'PM', label: 'PM' };
        approverReason = `${route.reason} · 브랜드 키워드는 PM 이상 (브랜드 별도 기준)`;
      }
      const guard = [
        `일 조정 폭 상한 ${cfg.dailyChangeCapPct}% 이내 (${fmt.delta(d.proposedPct)})`,
        `최대 입찰가 ${fmt.won(d.maxBid)} 이내`,
        `급변 없음 (${d.anomaly.basis.split(' — ')[0]})`,
      ];
      if (d.verdict === 'down') guard.push(`최소 전환 ${cfg.minConversionsForDown}건 충족 (${fmt.dec1(d.conversions)}건)`);
      if (d.isBrand) guard.push(`브랜드 별도 기준 (목표 ${fmt.roas(cfg.brandTargetRoas)} · 순위 ≤ ${cfg.brandRankTarget}위)`);
      if (d.limitedBy.length) guard.push(`제한 적용: ${d.limitedBy.join(' · ')}`);
      out.push({
        ...common,
        id: `${d.verdict === 'down' ? 'bid_down' : 'bid_up'}:${d.id}:${data.today}`,
        rule: RULE_LABEL[d.ruleId ?? 'high_efficiency'],
        ruleId: d.ruleId ?? 'high_efficiency',
        action: d.verdict === 'down' ? 'bid_down' : 'bid_up',
        before: d.bid, after: d.proposedBid, changePct: d.proposedPct,
        reason: d.verdict === 'down'
          ? `최근 14일과 직전 14일 모두 목표 ROAS에 못 미쳤고 전환이 ${fmt.dec1(d.conversions)}건으로 판단 표본을 확보했습니다. 입찰을 낮춰 CPC를 줄이고 효율을 회복합니다.`
          : d.verdict === 'defend'
            ? `브랜드 키워드 순위 ${d.rank.toFixed(1)}위 · 노출 손실 ${fmt.ratio(d.lost, 0)}로 점유 방어가 필요합니다. 브랜드 목표 ROAS를 충족해 순위 방어를 우선합니다.`
            : `목표 대비 ${pct0(d.ratioPct)} 효율인데 노출 기회의 ${fmt.ratio(d.lost, 0)}를 잃고 있습니다. 평균 순위 ${d.rank.toFixed(1)}위로 순위 제한형 손실이라 입찰 상향으로 회수합니다.`,
        expected: simText(sim),
        guard,
        kind: 'bid',
        basis: d.basis,
        approver: route.approver, approverReason,
        unit: 'won',
        priority: d.verdict === 'defend' ? 3 : d.verdict === 'up' ? 4 : 5,
        sim,
        costDelta: sim.projected.cost - sim.base.cost,
      });
    }
  }
  return out;
}

function mediaHoldProposals(data: Dataset, cfg: AdPilotConfig, guards: Record<MediaId, MediaGuard>, paces: CampaignPace[]): AdPilotProposal[] {
  const out: AdPilotProposal[] = [];
  for (const m of MEDIA_IDS) {
    const g = guards[m];
    if (!g?.hold) continue;
    const cs = paces.filter((p) => p.media === m);
    const early = cs.filter((p) => p.earlyExhaust);
    const tb = g.kind === 'tracking_break';
    out.push({
      id: `hold:media_${m}:${data.today}`,
      keywordId: `media_${m}`,
      keyword: `${MEDIA[m].name} · 캠페인 ${cs.length}개`,
      rule: RULE_LABEL.anomaly, ruleId: 'anomaly',
      action: 'hold', before: 0, after: 0, changePct: 0,
      reason: tb
        ? `${MEDIA[m].name} 전환이 ${g.zeroRunFrom}시 이후 0인데 클릭은 정상입니다. 픽셀 · 스크립트 누락 가능성이 있어 전환 기반 자동 조정을 즉시 보류합니다 (p.45 전환 추적 단절).`
        : `${MEDIA[m].name} 광고비가 동시간 대비 급변했습니다.${early.length ? ` ${early.map((e) => `${e.name} 조기 소진 예상 ${clock(e.curveExhaustHour ?? e.linearExhaustHour)}`).join(', ')}도 이 급변의 영향일 수 있어` : ''} 원인 확인 전까지 예산 · 입찰 자동 조정을 보류합니다.`,
      expected: tb ? '추적 정상화 확인 전 자동 조정 없음 · 30분 내 1차 조치 (P1)' : '1시간 내 원인 보고 · 정상화 후 재판정 (P2)',
      guard: ['자동 조정 보류', tb ? '전환 0 연속 2시간 이상 · 동시간대 전환 0 발생률 5% 미만' : `광고비 · 클릭 ±${cfg.anomalyHoldPct}% (동요일 · 동시간)`],
      kind: 'budget', basis: g.basis,
      targetType: 'media', changeTargetId: `media:${m}`, media: m, isBrand: false,
      approver: 'PM', approverReason: '보류 해제 판단은 PM',
      unit: 'none', priority: tb ? 0 : 1, holdKind: tb ? 'tracking_break' : 'data_spike',
      causes: tb
        ? [{ cause: CAUSE_CANDIDATES[3], score: 2, evidence: '클릭 정상 · 전환만 0 — 추적 스크립트 · 집계 확인' }, { cause: CAUSE_CANDIDATES[1], score: 1, evidence: '랜딩 변경 시 전환 태그 누락 가능' }]
        : [{ cause: CAUSE_CANDIDATES[0], score: finite(g.costDelta) && finite(g.clicksDelta) && g.costDelta > g.clicksDelta ? 1.5 : 0.8, evidence: `광고비 ${fmt.delta(g.costDelta, 0)} > 클릭 ${fmt.delta(g.clicksDelta, 0)} — 단가 상승 동반` }, { cause: CAUSE_CANDIDATES[3], score: 0.7, evidence: '1~2시간 뒤 정상화되면 집계 지연' }],
      costDelta: 0,
    });
  }
  return out;
}

export interface BudgetContext {
  accountsByCampaign?: Record<string, AdAccount | undefined>;
}

/** 조기 소진 캠페인의 입찰 조정 대안: 같은 의도 키워드 중 효율이 가장 낮은 키워드 입찰 하향으로 소진 속도 완화 */
export function bidAlternative(data: Dataset, c: Pick<Campaign, 'media' | 'intent'>, cfgIn?: Partial<AdPilotConfig>): string | null {
  const cfg = resolveConfig(cfgIn);
  if (c.media !== 'naver_sa' || !c.intent) return null;
  const target = c.intent === 'brand' ? cfg.brandTargetRoas : cfg.targetRoas;
  const low = (data.keywords ?? [])
    .filter((k) => k.intent === c.intent && k.status === 'on' && safeNum(k.last14?.cost) > 0 && !soldoutLanding(data, k) && !keywordAnomaly(k, data, cfg).triggered)
    .map((k) => ({ k, roas: metrics.roas(safeNum(k.last14.revenue), safeNum(k.last14.cost)) }))
    .filter((x) => finite(x.roas) && x.roas < target * cfg.highEfficiencyRoasRatio)
    .sort((a, b) => a.roas - b.roas)
    .slice(0, 2);
  if (!low.length) return null;
  return `입찰 조정 대안: 저효율 키워드 ${low.map((x) => `${x.k.text}(ROAS ${fmt.roas(x.roas)})`).join(' · ')} 입찰 하향 · 저효율 시간대 조정으로 소진 속도 완화`;
}

function budgetProposals(data: Dataset, cfg: AdPilotConfig, guards: Record<MediaId, MediaGuard>, paces: CampaignPace[], ctx?: BudgetContext): AdPilotProposal[] {
  const out: AdPilotProposal[] = [];
  const monthly = monthlyPacing(data);
  const usedDonors = new Set<string>();
  const early = paces
    .filter((p) => p.earlyExhaust && p.status !== 'off' && !guards[p.media]?.hold)
    .map((p) => ({ p, eff: campaignEfficiency(data, p, cfg) }))
    .sort((a, b) => (safeNum(b.eff.ratioPct) - safeNum(a.eff.ratioPct)));
  const accountOf = (id: string) => ctx?.accountsByCampaign?.[id] ?? (data.campaigns.find((c) => c.id === id)?.media === 'naver_gfa' ? data.accounts.find((a) => a.id === GFA_MAIN_ACCOUNT_ID) : undefined);
  for (const { p, eff } of early) {
    const exhaust = p.curveExhaustHour ?? p.linearExhaustHour;
    const shortfall = Math.max(0, p.projectedSpend - p.dailyBudget);
    const paceBasis = `예상 마감 ${clock(exhaust)}(시간대 가중 · 선형 ${clock(p.linearExhaustHour)}) · 기준 ${cfg.exhaustBeforeHour}시 전 · 소진 ${pct0(p.pacePct)}`;
    const effBasis = `ROAS ${fmt.roas(eff.roas)} · 목표 ${fmt.roas(eff.target)} 대비 ${pct0(eff.ratioPct)}`;
    const common = {
      keywordId: p.id, keyword: p.name, rule: RULE_LABEL.early_exhaust, ruleId: 'early_exhaust' as RuleId,
      targetType: 'campaign' as const, media: p.media, intent: p.intent, isBrand: p.intent === 'brand', unit: 'budget' as const, kind: 'budget' as ChangeKind,
    };
    const acc = accountOf(p.id);
    const bidAlt = bidAlternative(data, p, cfg);
    const runway = acc && acc.balance >= 0 && acc.avgDailySpend > 0 ? acc.balance / acc.avgDailySpend : Infinity;
    if (acc && (runway < 1 || acc.autoCharge === 'failed')) {
      out.push({
        ...common, id: `hold:${p.id}:${data.today}`, action: 'hold', before: p.dailyBudget, after: p.dailyBudget, changePct: 0,
        reason: `${p.name}은 ${clock(exhaust)} 소진이 예상되지만 계정 잔액이 ${runway.toFixed(2)}일치이고 자동충전 상태가 '${AUTO_CHARGE_LABEL[acc.autoCharge]}'입니다. 증액 · 재배분은 잔액을 더 빨리 소진시키므로 충전 확인 전까지 보류합니다.`,
        expected: '충전 확인 후 재판정 · 계정 · 결제 P1 (MILDO Alert)', guard: ['잔액 1일치 미만 → 증액 실행 보류 (p.44)', '자동충전 실패'],
        basis: `${paceBasis} · 계정 잔액 ${fmt.krw(acc.balance)} / 일 평균 ${fmt.krw(acc.avgDailySpend)} = ${runway.toFixed(2)}일치(기준 1일치)`,
        changeTargetId: `budget:${p.id}:`, approver: 'PM', approverReason: '보류 해제 판단은 PM', priority: 1, holdKind: 'account', costDelta: 0,
      });
      continue;
    }
    if (!eff.efficient) {
      out.push({
        ...common, id: `hold:${p.id}:${data.today}`, action: 'hold', before: p.dailyBudget, after: p.dailyBudget, changePct: 0,
        reason: `${p.name}은 ${clock(exhaust)} 소진이 예상되지만 ${eff.source} ROAS가 목표에 못 미쳐 증액 근거가 부족합니다. 예산은 유지하고 저효율 시간대 · 입찰 조정으로 소진 속도를 늦추는 쪽을 검토합니다. ${eff.judgeNote}.`,
        expected: bidAlt ? `예산 유지 · ${bidAlt}` : '예산 유지 · 시간대 입찰 조정 검토', guard: ['증액 전제: 캠페인 ROAS ≥ 목표'],
        basis: `${paceBasis} · ${effBasis}`, changeTargetId: `budget:${p.id}:`, approver: 'PM', approverReason: '조정 방향 결정은 PM', priority: 6, holdKind: 'efficiency', costDelta: 0,
      });
      continue;
    }
    const donor = paces
      .filter((d) => d.media === p.media && d.id !== p.id && d.status !== 'off' && !d.earlyExhaust && d.intent !== 'brand' && !usedDonors.has(d.id) && finite(d.projectedRatio) && d.projectedRatio < cfg.donorPaceMax)
      .map((d) => ({ d, surplus: d.dailyBudget * (1 - d.projectedRatio) }))
      .sort((a, b) => b.surplus - a.surplus)[0];
    const shift = donor ? Math.floor(Math.min(shortfall, donor.surplus * 0.8) / 10000) * 10000 : 0;
    if (donor && shift >= 10000) {
      usedDonors.add(donor.d.id);
      const after = p.dailyBudget + shift;
      const pct = round1((after / p.dailyBudget - 1) * 100);
      const route = routeByPct(pct);
      const newRatio = p.projectedSpend / after;
      const newExhaust = curveExhaust(hourlyCostCurve(data, p.media), newRatio);
      out.push({
        ...common, id: `budget_shift:${p.id}:${data.today}`, action: 'budget_shift', before: p.dailyBudget, after, changePct: pct,
        reason: `${p.name}이 ${clock(exhaust)}에 일 예산을 소진해 ${p.missesPeak ? '21~23시 피크 시간대를 놓칩니다' : '마감 전 노출이 끊깁니다'}. 같은 매체의 ${donor.d.name}은 예상 소진율 ${fmt.ratio(donor.d.projectedRatio, 0)}로 미소진분이 있어, 총액을 늘리지 않고 ${fmt.krw(shift)}원을 옮깁니다.`,
        expected: `예상 마감 ${clock(exhaust)} → ${newExhaust === null ? '마감 전 소진 없음' : clock(newExhaust)} · 추가 집행 ${fmt.krw(shift)} × 평균 ROAS ${fmt.roas(eff.roas)} ≈ 매출 +${fmt.krw((shift * eff.roas) / 100)} (평균 ROAS 가정 · 한계 ROAS는 더 낮을 수 있음)`,
        guard: ['총 일 예산 불변 (재배분)', `재원: ${donor.d.name} 예상 소진율 ${fmt.ratio(donor.d.projectedRatio, 0)} < ${fmt.ratio(cfg.donorPaceMax, 0)}`, '브랜드 방어 캠페인은 재원에서 제외', `잔여 부족분 ${fmt.krw(Math.max(0, shortfall - shift))} — 추가 증액은 월 페이싱 확인 후`, ...(bidAlt ? [bidAlt] : [])],
        basis: `${paceBasis} · ${effBasis}`,
        changeTargetId: `budget:${p.id}:${donor.d.id}`,
        donor: { id: donor.d.id, name: donor.d.name, before: donor.d.dailyBudget, after: donor.d.dailyBudget - shift },
        approver: route.approver, approverReason: route.reason, priority: 7, costDelta: shift,
      });
      continue;
    }
    const mp = monthly.find((x) => x.media === p.media);
    if (mp && mp.status === 'over') {
      out.push({
        ...common, id: `hold:${p.id}:${data.today}`, action: 'hold', before: p.dailyBudget, after: p.dailyBudget, changePct: 0,
        reason: `${p.name}은 ${clock(exhaust)} 소진이 예상되고 효율도 목표 이상이지만 같은 매체에 재원으로 쓸 미소진 캠페인이 없고, ${MEDIA[p.media].name} 월 예산이 초과 페이스입니다. 순증액은 보류하고 월 예산 협의 안건으로 올립니다.`,
        expected: bidAlt ? `순증액 보류 · ${bidAlt}` : '순증액 보류 · 익월 배분 시 반영 검토', guard: ['월 예산 초과 페이스에서 순증액 금지', ...(bidAlt ? [bidAlt] : [])],
        basis: `${paceBasis} · ${effBasis} · 월 소진 ${fmt.pct(mp.pacePct, 1)}(기대 ${fmt.pct(mp.expectedPct, 1)})`,
        changeTargetId: `budget:${p.id}:`, approver: 'CLIENT', approverReason: '예산 · 구조 변경은 수면밀도 승인 (p.53)', priority: 6, holdKind: 'monthly_over', costDelta: 0,
      });
      continue;
    }
    const inc = Math.max(10000, Math.round(Math.min(shortfall, p.dailyBudget * 0.3) / 10000) * 10000);
    const after = p.dailyBudget + inc;
    const pct = round1((after / p.dailyBudget - 1) * 100);
    const route = routeByPct(pct);
    out.push({
      ...common, id: `budget_shift:${p.id}:${data.today}`, action: 'budget_shift', before: p.dailyBudget, after, changePct: pct,
      reason: `${p.name}이 ${clock(exhaust)}에 소진될 것으로 예상되고 재원으로 쓸 같은 매체 캠페인이 없어 일 예산 증액을 제안합니다. 월 예산 페이싱은 여유 범위입니다.`,
      expected: `추가 집행 ${fmt.krw(inc)} × 평균 ROAS ${fmt.roas(eff.roas)} ≈ 매출 +${fmt.krw((inc * eff.roas) / 100)} (평균 ROAS 가정)`,
      guard: ['월 예산 페이싱 여유 확인', '증액 전제: 캠페인 ROAS ≥ 목표', ...(bidAlt ? [bidAlt] : [])],
      basis: `${paceBasis} · ${effBasis}`, changeTargetId: `budget:${p.id}:`, approver: route.approver, approverReason: route.reason, priority: 7, costDelta: inc,
    });
  }
  return out;
}

function testProposals(data: Dataset, cfg: AdPilotConfig): AdPilotProposal[] {
  return testCandidates(data, cfg).map((t) => ({
    id: `test_candidate:${t.term}:${data.today}`,
    keywordId: `term:${t.term}`,
    keyword: t.term,
    rule: RULE_LABEL.new_intent, ruleId: 'new_intent' as RuleId,
    action: 'test_candidate' as const,
    before: 0, after: t.suggestedBid, changePct: 0,
    reason: `검색어 보고서에서 미등록 상태로 전환 ${fmt.dec1(t.conversions)}건이 발생했습니다. '${SA_CAMPAIGNS[t.intent].name}' 의도로 분류해 테스트 전용 그룹(${t.adgroup})에 입찰 상한을 두고 등록합니다.`,
    expected: `테스트 ${KEYWORD_TEST_RULES.minDays}일 또는 클릭 ${KEYWORD_TEST_RULES.minClicks}회 → MILDO Lab 판정 (확장 ≥ 목표 100% · 유지 70~100% · 제외 < 70%)`,
    guard: [`테스트 입찰 상한 ${fmt.won(t.bidCap)} (같은 의도 MAIN 입찰 중앙값)`, ...t.cautions],
    kind: 'keyword_add' as ChangeKind,
    basis: `미등록 · 클릭 ${fmt.int(t.clicks)} · 전환 ${fmt.dec1(t.conversions)}건 · ROAS ${fmt.roas(t.roas)} · CPC ${fmt.won(t.cpc)}`,
    targetType: 'search_term' as const, changeTargetId: `term:${t.term}`, media: 'naver_sa' as MediaId, intent: t.intent, isBrand: t.intent === 'brand',
    approver: (t.intent === 'brand' ? 'PM' : 'AE') as ApprovalLevel,
    approverReason: t.intent === 'brand' ? '브랜드 검색어 편입은 PM' : '테스트 전용 그룹 · 입찰 상한 내 등록 — 승인 범위 내 운영 조정 (p.53)',
    unit: 'won' as const, priority: 8,
    costDelta: (t.suggestedBid * t.clicks) / 14,
  }));
}

/**
 * AD Pilot 조정 후보 (p.14 규칙). 시그니처 유지: generateBidProposals(data, config?)
 * 결과는 BidProposal 을 확장한 AdPilotProposal — 판정 근거(basis) · 승인 주체 · 시뮬레이션 포함.
 */
export function generateBidProposals(data: Dataset, config?: Partial<AdPilotConfig>, ctx?: BudgetContext): AdPilotProposal[] {
  if (!data || !Array.isArray(data.keywords)) return [];
  const cfg = resolveConfig(config);
  const diag = diagnoseKeywords(data, cfg);
  const guards = mediaGuards(data, cfg);
  const paces = paceCampaigns(data, data.campaigns, cfg);
  const all = [
    ...keywordProposals(data, cfg, diag),
    ...mediaHoldProposals(data, cfg, guards, paces),
    ...budgetProposals(data, cfg, guards, paces, ctx),
    ...testProposals(data, cfg),
  ];
  return all.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.priority - b.priority || Math.abs(b.changePct) - Math.abs(a.changePct));
}

/* ================================================================== */
/* 반영 상태 (state.changes → 현재 입찰가 · 예산 · 상태)                    */
/* ================================================================== */

const byAppliedOrder = (a: ChangeRequest, b: ChangeRequest) => appliedAt(a).localeCompare(appliedAt(b));

/** 반영(applied)된 AD Pilot 입찰 변경을 순서대로 적용한 현재 입찰가 (롤백된 건은 제외 = 직전 상태) */
export function effectiveBids(data: Dataset, changes: readonly ChangeRequest[]): Record<string, number> {
  const bids: Record<string, number> = {};
  for (const k of data?.keywords ?? []) bids[k.id] = k.bid;
  const applied = (changes ?? []).filter((c) => c.module === 'adpilot' && c.kind === 'bid' && c.status === 'applied' && c.targetId && c.targetId in bids).sort(byAppliedOrder);
  for (const c of applied) {
    const v = Number(c.after);
    if (Number.isFinite(v) && v > 0) bids[c.targetId!] = v;
  }
  return bids;
}

/** 반영된 키워드 상태 변경 (품절 일시 중지 등) */
export function effectiveKeywordStatus(changes: readonly ChangeRequest[]): Record<string, 'on' | 'off'> {
  const out: Record<string, 'on' | 'off'> = {};
  for (const c of (changes ?? []).filter((x) => x.module === 'adpilot' && x.kind === 'status' && x.status === 'applied' && x.targetId).sort(byAppliedOrder)) {
    out[c.targetId!] = String(c.after) === 'off' ? 'off' : 'on';
  }
  return out;
}

/** 대상의 가장 최근 변경 요청 */
export function latestChangeFor(changes: readonly ChangeRequest[], module: string, targetId: string, kind?: ChangeKind): ChangeRequest | undefined {
  let best: ChangeRequest | undefined;
  for (const c of changes ?? []) {
    if (c.module !== module || c.targetId !== targetId || (kind && c.kind !== kind)) continue;
    if (!best || (c.createdAt ?? '') > (best.createdAt ?? '')) best = c;
  }
  return best;
}

/** 롤백 가능 여부: 반영 상태이며 같은 대상의 가장 최근 반영 건일 때 (직전 상태로만 복원) */
export function canRollback(changes: readonly ChangeRequest[], c: ChangeRequest): { ok: boolean; reason: string } {
  if (c.status !== 'applied') return { ok: false, reason: '반영된 건만 롤백할 수 있습니다' };
  const later = (changes ?? []).filter((x) => x.id !== c.id && x.module === c.module && x.targetId === c.targetId && x.kind === c.kind && x.status === 'applied' && appliedAt(x) > appliedAt(c));
  if (later.length) return { ok: false, reason: '이후 반영된 변경이 있어 최신 건부터 롤백해야 합니다' };
  return { ok: true, reason: `직전 상태(${c.before})로 복원` };
}

/** 반영된 예산 변경을 캠페인에 적용 (AD Pilot 재배분 + GFA 일 예산 변경) */
export function effectiveCampaigns(data: Dataset, changes: readonly ChangeRequest[], extra: readonly Campaign[] = []): Campaign[] {
  const list = [...(data?.campaigns ?? []), ...extra].map((c) => ({ ...c }));
  const byId = new Map(list.map((c) => [c.id, c]));
  const applied = (changes ?? []).filter((c) => c.status === 'applied' && c.targetId && (c.module === 'adpilot' || c.module === 'gfa')).sort(byAppliedOrder);
  for (const c of applied) {
    const tid = c.targetId!;
    if (c.module === 'adpilot' && c.kind === 'budget' && tid.startsWith('budget:')) {
      const [, recv, donor] = tid.split(':');
      const r = byId.get(recv);
      const amount = Number(c.after) - Number(c.before);
      if (r && Number.isFinite(amount)) {
        r.dailyBudget = Number(c.after);
        const d = donor ? byId.get(donor) : undefined;
        if (d) d.dailyBudget = Math.max(0, d.dailyBudget - amount);
      }
    }
    if (c.module === 'gfa' && c.kind === 'budget' && tid.startsWith('gfa:budget:')) {
      const r = byId.get(tid.slice('gfa:budget:'.length));
      const v = Number(c.after);
      if (r && Number.isFinite(v) && v >= 0) r.dailyBudget = v;
    }
  }
  return list;
}

/* ================================================================== */
/* GFA Control v1 (p.15)                                               */
/* ================================================================== */

export type CheckLevel = 'ok' | 'info' | 'warn' | 'critical';
export interface CheckIssue { level: CheckLevel; text: string; basis: string }

export interface GfaAdGroupView { id: string; name: string; share: number; status: 'on' | 'off'; note?: string; dailyBudget: number }
export interface GfaCampaignView {
  campaign: Campaign;
  accountId: string;
  demo: boolean;
  pace: CampaignPace;
  adGroups: GfaAdGroupView[];
  issues: CheckIssue[];
  level: CheckLevel;
}
export interface GfaAccountView {
  account: AdAccount;
  demo: boolean;
  runwayDays: number;
  exhaustAt: { date: string; hour: number } | null;
  remainingToday: number;
  campaigns: GfaCampaignView[];
  issues: CheckIssue[];
  level: CheckLevel;
}

const LEVEL_RANK: Record<CheckLevel, number> = { ok: 0, info: 1, warn: 2, critical: 3 };
const worst = (issues: CheckIssue[]): CheckLevel => issues.reduce<CheckLevel>((w, i) => (LEVEL_RANK[i.level] > LEVEL_RANK[w] ? i.level : w), 'ok');

/** 데모 GFA 캠페인 (data.ts) → Campaign: 오늘 소진액은 GFA 시간대 곡선 × paceMult */
export function gfaDemoCampaigns(data: Dataset): (Campaign & { accountId: string })[] {
  const cum = hourlyCostCurve(data, 'naver_gfa');
  const h = clamp(Math.round(safeNum(data?.currentHour)), 0, 23);
  return GFA_DEMO_CAMPAIGNS.map(({ paceMult, ...c }) => ({
    ...c, hourOfData: h, spentToday: c.status === 'off' ? 0 : Math.round(c.dailyBudget * cum[h] * paceMult),
  }));
}

export function gfaAccountsBase(data: Dataset): { account: AdAccount; demo: boolean }[] {
  const main = data?.accounts?.find((a) => a.id === GFA_MAIN_ACCOUNT_ID) ?? data?.accounts?.find((a) => a.media === 'naver_gfa');
  return [...(main ? [{ account: main, demo: false }] : []), ...GFA_DEMO_ACCOUNTS.map((a) => ({ account: a, demo: true }))];
}

/** 광고그룹 상태: 기본(DEMO) + 반영된 ON/OFF 변경 */
export function gfaAdGroups(campaign: Campaign, changes: readonly ChangeRequest[]): GfaAdGroupView[] {
  const base = GFA_AD_GROUPS[campaign.name] ?? [];
  const applied = (changes ?? []).filter((c) => c.module === 'gfa' && c.kind === 'status' && c.status === 'applied' && c.targetId?.startsWith(`gfa:adgroup:${campaign.id}:`)).sort(byAppliedOrder);
  return base.map((g) => {
    let status = g.status;
    for (const c of applied) if (c.targetId === `gfa:adgroup:${campaign.id}:${g.id}`) status = String(c.after) === 'off' ? 'off' : 'on';
    return { ...g, status, dailyBudget: Math.round(campaign.dailyBudget * g.share) };
  });
}

/** 반영된 신규 캠페인 요청 → 캠페인 */
export function gfaNewCampaigns(data: Dataset, changes: readonly ChangeRequest[]): (Campaign & { accountId: string })[] {
  return (changes ?? [])
    .filter((c) => c.module === 'gfa' && c.kind === 'gfa' && c.status === 'applied' && c.targetId?.startsWith('gfa:new:'))
    .map((c) => {
      const [, , accountId] = c.targetId!.split(':');
      return { id: `new_${c.id}`, media: 'naver_gfa' as MediaId, name: c.target, dailyBudget: Number(c.after) || 0, spentToday: 0, status: 'on' as const, hourOfData: data.currentHour, accountId };
    });
}

/** GFA 다계정 예산 · 상태 점검 */
export function gfaOverview(data: Dataset, changes: readonly ChangeRequest[] = [], cfgIn?: Partial<AdPilotConfig>): GfaAccountView[] {
  if (!data) return [];
  const cfg = resolveConfig(cfgIn);
  const demo = gfaDemoCampaigns(data);
  const created = gfaNewCampaigns(data, changes);
  const all = effectiveCampaigns(data, changes, [...demo, ...created]).filter((c) => c.media === 'naver_gfa');
  const accountOf = (id: string) => demo.find((d) => d.id === id)?.accountId ?? created.find((d) => d.id === id)?.accountId ?? GFA_MAIN_ACCOUNT_ID;
  const paces = paceCampaigns(data, all, cfg);
  const guard = mediaGuards(data, cfg).naver_gfa;
  const cum = hourlyCostCurve(data, 'naver_gfa');
  const H = clamp(Math.round(safeNum(data.currentHour)), 0, 23);
  return gfaAccountsBase(data).map(({ account, demo: isDemo }) => {
    const cs = all.filter((c) => accountOf(c.id) === account.id);
    const campaigns: GfaCampaignView[] = cs.map((c) => {
      const pace = paces[all.indexOf(c)];
      const adGroups = gfaAdGroups(c, changes);
      const issues: CheckIssue[] = [];
      if (c.status === 'off') issues.push({ level: 'info', text: '캠페인 OFF', basis: '집행 없음' });
      if (pace.earlyExhaust) issues.push({ level: 'warn', text: `조기 소진 예상 ${clock(pace.curveExhaustHour ?? pace.linearExhaustHour)}`, basis: `시간대 가중 예상 · 기준 ${cfg.exhaustBeforeHour}시 전 · 소진 ${pct0(pace.pacePct)}` });
      else if (c.status !== 'off' && finite(pace.projectedRatio) && pace.projectedRatio < 0.8) issues.push({ level: 'info', text: `소진 미달 예상 ${fmt.ratio(pace.projectedRatio, 0)}`, basis: '시간대 가중 예상 소진율 80% 미만' });
      const off = adGroups.filter((g) => g.status === 'off');
      if (c.status !== 'off' && off.length) issues.push({ level: 'info', text: `광고그룹 OFF ${off.length}개`, basis: off.map((g) => `${g.name}${g.note ? ` (${g.note})` : ''}`).join(', ') });
      if (guard.hold && c.status !== 'off') issues.push({ level: 'critical', text: guard.kind === 'tracking_break' ? '전환 추적 단절 의심' : '데이터 급변', basis: guard.basis });
      return { campaign: c, accountId: account.id, demo: !data.campaigns.some((x) => x.id === c.id), pace, adGroups, issues, level: worst(issues) };
    });
    const runwayDays = account.balance < 0 ? Infinity : account.avgDailySpend > 0 ? account.balance / account.avgDailySpend : Infinity;
    const remainingToday = sum(campaigns.filter((c) => c.campaign.status !== 'off'), (c) => Math.max(0, Math.min(c.pace.projectedSpend, c.campaign.dailyBudget) - c.campaign.spentToday));
    let exhaustAt: GfaAccountView['exhaustAt'] = null;
    if (account.balance >= 0 && account.avgDailySpend > 0) {
      if (account.balance <= remainingToday && remainingToday > 0) {
        const share = account.balance / remainingToday;
        const rest = 1 - cum[H];
        const target = cum[H] + rest * share;
        const hh = cum.findIndex((v) => v >= target);
        exhaustAt = { date: data.today, hour: hh < 0 ? 23 : hh };
      } else {
        let left = account.balance - remainingToday;
        let day = 1;
        while (day <= 30) {
          if (left <= account.avgDailySpend) {
            const hh = cum.findIndex((v) => v * account.avgDailySpend >= left);
            exhaustAt = { date: addDays(data.today, day), hour: hh < 0 ? 23 : hh };
            break;
          }
          left -= account.avgDailySpend;
          day++;
        }
      }
    }
    const issues: CheckIssue[] = [];
    if (account.balance >= 0 && runwayDays < 1) issues.push({ level: 'critical', text: `잔액 ${runwayDays.toFixed(2)}일치`, basis: `잔액 ${fmt.krw(account.balance)} < 일 평균 소진 ${fmt.krw(account.avgDailySpend)} · 기준 1일치 미만 (p.44)` });
    else if (account.balance >= 0 && runwayDays < 3 && Number.isFinite(runwayDays)) issues.push({ level: 'warn', text: `잔액 ${runwayDays.toFixed(1)}일치`, basis: '3일치 미만 — 충전 일정 확인' });
    if (account.autoCharge === 'failed') issues.push({ level: 'critical', text: '자동충전 실패', basis: account.paymentMethod });
    if (account.status !== 'active') issues.push({ level: account.status === 'restricted' ? 'critical' : 'warn', text: account.status === 'review' ? '계정 검수 · 확인 필요' : '계정 제재', basis: `계정 상태 '${ACCOUNT_STATUS_LABEL[account.status]}' (p.44 계정 제재 · 검수)` });
    const unnamed = account.permissions.filter((p) => !p.realName);
    if (unnamed.length) issues.push({ level: 'warn', text: `비실명 권한 ${unnamed.length}개`, basis: unnamed.map((p) => `${p.user}(${p.role})`).join(', ') });
    if (account.owner !== '수면밀도') issues.push({ level: 'warn', text: '소유 주체 확인', basis: `소유 ${account.owner} · 기준 수면밀도 소유 (p.50)` });
    return { account, demo: isDemo, runwayDays, exhaustAt, remainingToday, campaigns, issues, level: worst([...issues, ...campaigns.flatMap((c) => c.issues)]) };
  });
}

export interface GfaRequestDraft {
  type: Exclude<GfaChangeType, 'status_check'>;
  accountId: string;
  campaignId?: string;
  pct?: number;
  adGroupId?: string;
  toStatus?: 'on' | 'off';
  newName?: string;
  newBudget?: number;
  objective?: string;
  reason?: string;
}

export interface GfaRequestPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  route: Route;
  kind: ChangeKind;
  target: string;
  targetId: string;
  before: string | number;
  after: string | number;
  changePct?: number;
}

/** 변경 요청 폼 → 요청 내용 · 승인 주체 · 경고 (제출 전 검증) */
export function planGfaRequest(views: GfaAccountView[], d: GfaRequestDraft): GfaRequestPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const acc = views.find((v) => v.account.id === d.accountId);
  if (!acc) errors.push('계정을 선택하세요');
  const cv = acc?.campaigns.find((c) => c.campaign.id === d.campaignId);
  const lowBalance = !!acc && (acc.runwayDays < 1 || acc.account.autoCharge === 'failed');
  if (d.type === 'budget') {
    const pct = Number(d.pct);
    const route = routeGfaChange('budget', pct);
    if (!cv) errors.push('캠페인을 선택하세요');
    if (!Number.isFinite(pct) || pct === 0) errors.push('변경 폭(%)을 입력하세요');
    if (Number.isFinite(pct) && pct <= -100) errors.push('일 예산을 0 이하로 줄일 수 없습니다 — 캠페인 OFF로 요청하세요');
    if (Number.isFinite(pct) && pct > 100) errors.push('일 예산 2배 초과 변경은 차단됩니다 — 신규 캠페인 · 구조 변경으로 요청하세요');
    if (Number.isFinite(pct) && pct > 0 && lowBalance) warnings.push(`계정 잔액 ${acc!.runwayDays.toFixed(2)}일치 · 자동충전 '${AUTO_CHARGE_LABEL[acc!.account.autoCharge]}' — 승인되어도 충전 확인 전 실행 보류`);
    if (cv && Number.isFinite(pct) && pct < 0 && cv.pace.earlyExhaust) warnings.push('조기 소진 예상 캠페인을 감액하면 마감이 더 빨라집니다');
    const before = cv?.campaign.dailyBudget ?? 0;
    const after = Math.round((before * (1 + (Number.isFinite(pct) ? pct : 0) / 100)) / 10000) * 10000;
    return { ok: !errors.length, errors, warnings, route, kind: 'budget', target: cv ? `${cv.campaign.name} 일 예산` : '—', targetId: `gfa:budget:${d.campaignId ?? ''}`, before, after, changePct: Number.isFinite(pct) ? pct : undefined };
  }
  if (d.type === 'adgroup') {
    const route = routeGfaChange('adgroup');
    const g = cv?.adGroups.find((x) => x.id === d.adGroupId);
    if (!cv) errors.push('캠페인을 선택하세요');
    if (!g) errors.push('광고그룹을 선택하세요');
    const to = d.toStatus ?? (g?.status === 'on' ? 'off' : 'on');
    if (g && g.status === to) errors.push(`이미 ${to.toUpperCase()} 상태입니다`);
    if (to === 'on' && lowBalance) warnings.push('계정 잔액 부족 — ON 실행은 충전 확인 전 보류');
    if (g?.note) warnings.push(`광고그룹 메모: ${g.note}`);
    return { ok: !errors.length, errors, warnings, route, kind: 'status', target: g ? `${cv!.campaign.name} · ${g.name}` : '—', targetId: `gfa:adgroup:${d.campaignId ?? ''}:${d.adGroupId ?? ''}`, before: g?.status ?? '—', after: to };
  }
  const route = routeGfaChange('new_campaign');
  const name = (d.newName ?? '').trim();
  const budget = Number(d.newBudget);
  if (!name) errors.push('캠페인 이름을 입력하세요');
  if (!Number.isFinite(budget) || budget <= 0) errors.push('일 예산을 입력하세요');
  if (acc && acc.campaigns.some((c) => c.campaign.name === name)) errors.push('같은 이름의 캠페인이 있습니다');
  if (lowBalance) warnings.push('계정 잔액 부족 — 승인되어도 충전 확인 전 실행 보류');
  if (acc && Number.isFinite(budget) && acc.account.balance >= 0 && budget > acc.account.balance) warnings.push(`일 예산이 계정 잔액 ${fmt.krw(acc.account.balance)}보다 큽니다`);
  return { ok: !errors.length, errors, warnings, route, kind: 'gfa', target: name || '—', targetId: `gfa:new:${d.accountId}:${name}`, before: '—', after: Number.isFinite(budget) ? budget : 0 };
}

/** 실행 단계 검증 — 지원 API 범위 내 실행, 오류 시 보류 · 보고 (p.15 04) */
export function validateGfaExecution(views: GfaAccountView[], c: ChangeRequest): { ok: boolean; reason: string } {
  if (c.status !== 'approved') return { ok: false, reason: '승인된 건만 실행할 수 있습니다' };
  const tid = c.targetId ?? '';
  let accountId: string | undefined;
  let increases = false;
  if (tid.startsWith('gfa:budget:')) {
    const cid = tid.slice('gfa:budget:'.length);
    accountId = views.find((v) => v.campaigns.some((x) => x.campaign.id === cid))?.account.id;
    increases = Number(c.after) > Number(c.before);
    if (!(Number(c.after) >= 0)) return { ok: false, reason: '실행 오류: 일 예산 값이 올바르지 않습니다' };
  } else if (tid.startsWith('gfa:adgroup:')) {
    const cid = tid.split(':')[2];
    accountId = views.find((v) => v.campaigns.some((x) => x.campaign.id === cid))?.account.id;
    increases = String(c.after) === 'on';
  } else if (tid.startsWith('gfa:new:')) {
    accountId = tid.split(':')[2];
    increases = true;
  } else {
    return { ok: false, reason: '실행 오류: 지원 API 범위 밖 요청' };
  }
  const acc = views.find((v) => v.account.id === accountId);
  if (!acc) return { ok: false, reason: '실행 오류: 계정을 찾을 수 없습니다' };
  if (acc.account.status === 'restricted') return { ok: false, reason: '계정 제재 상태 — 실행 보류 · 보고' };
  if (increases && (acc.runwayDays < 1 || acc.account.autoCharge === 'failed')) {
    return { ok: false, reason: `잔액 ${Number.isFinite(acc.runwayDays) ? acc.runwayDays.toFixed(2) : '—'}일치 · 자동충전 '${AUTO_CHARGE_LABEL[acc.account.autoCharge]}' — 증액 · ON 실행 보류 · 보고 (충전 확인 후 재실행)` };
  }
  return { ok: true, reason: '지원 API 범위 내 실행 (데모: 로컬 상태 반영)' };
}

/* ================================================================== */
/* 자동 입찰 검증 · 대량 변경 점검                                         */
/* ================================================================== */

export interface VerifyItem { id: string; label: string; level: 'pass' | 'warn' | 'block'; detail: string }
export interface BidVerification { items: VerifyItem[]; blocked: boolean; warned: boolean; changePct: number; startPct: number; route: Route; sim: BidSimulation }

/** 입찰 변경 검증: SAFETY 규칙 대조 + 탄력성 시뮬레이션 */
export function verifyBidChange(data: Dataset, k: Keyword, after: number, cfgIn?: Partial<AdPilotConfig>): BidVerification {
  const cfg = resolveConfig(cfgIn);
  const current = cfg.currentBids && finite(cfg.currentBids[k.id]) ? cfg.currentBids[k.id] : k.bid;
  const start = k.bid;
  const a = finite(after) ? after : NaN;
  const changePct = current > 0 && finite(a) ? round1((a / current - 1) * 100) : NaN;
  const startPct = start > 0 && finite(a) ? round1((a / start - 1) * 100) : NaN;
  const d = diagnoseKeyword(data, k, cfg);
  const items: VerifyItem[] = [];
  const add = (id: string, label: string, level: VerifyItem['level'], detail: string) => items.push({ id, label, level, detail });
  if (!finite(a) || a <= 0) add('value', '입찰가 값', 'block', '0보다 큰 숫자를 입력하세요');
  else if (a === current) add('noop', '변경 여부', 'block', '현재 입찰가와 같습니다');
  add('cap', `일 조정 폭 상한 ${cfg.dailyChangeCapPct}%`, finite(startPct) && Math.abs(startPct) <= cfg.dailyChangeCapPct + 1e-9 ? 'pass' : 'block', `시작가 ${fmt.won(start)} 대비 ${fmt.delta(startPct)}`);
  add('max', '최대 입찰가', finite(a) && a <= k.maxBid ? 'pass' : 'block', `${fmt.won(a)} / 상한 ${fmt.won(k.maxBid)}`);
  add('min', '최소 입찰가', finite(a) && a >= cfg.minBid ? 'pass' : 'block', `최소 ${fmt.won(cfg.minBid)}`);
  add('anomaly', '성과 급변 · 데이터 이상', d.anomaly.triggered ? 'warn' : 'pass', d.anomaly.triggered ? `${d.anomaly.basis} — 자동 조정 보류 중, 수동 변경은 PM 이상 승인` : d.anomaly.basis);
  const up = finite(a) && a > current;
  if (d.soldout) add('soldout', '품절 랜딩', up ? 'block' : 'warn', `'${d.soldout.option}' 품절 — ${up ? '입찰 상향 차단' : '일시 중지 검토'}`);
  if (finite(a) && a < current) {
    add('mindown', `하향 전 최소 전환 ${cfg.minConversionsForDown}건`, d.conversions >= cfg.minConversionsForDown ? 'pass' : 'warn', `최근 14일 전환 ${fmt.dec1(d.conversions)}건`);
    if (k.isBrand) add('brand', '브랜드 순위 방어', 'warn', '브랜드 키워드 하향 — 순위 방어 우선, PM 승인');
  }
  if (up) add('efficiency', '상향 효율 전제', finite(d.roas) && d.roas >= d.target ? 'pass' : 'warn', `ROAS ${fmt.roas(d.roas)} · 목표 ${fmt.roas(d.target)}`);
  if (k.status === 'test') add('test', '테스트 그룹', 'warn', 'MILDO Lab 테스트 중 — 판정 전 입찰 변경은 표본을 흔듭니다');
  let route = routeByPct(changePct);
  if ((k.isBrand || d.anomaly.triggered || d.soldout) && LEVEL_ORDER.indexOf(route.approver) < 1) route = { ...route, approver: 'PM', label: 'PM', reason: `${route.reason} · 브랜드 · 보류 대상은 PM 이상` };
  const sim = simulateBidChange(k, current, finite(a) && a > 0 ? a : current, cfg);
  return { items, blocked: items.some((i) => i.level === 'block'), warned: items.some((i) => i.level === 'warn'), changePct, startPct, route, sim };
}

export interface BulkItem { kind: ChangeKind; changePct: number; costDelta?: number }
export interface BulkCheck { level: 'ok' | 'warn' | 'block'; reasons: string[]; count: number; costDelta: number }

/** 대량 변경 실수 방지 (p.45): N건 이상 경고 · M건 이상 차단, 입찰 상한 초과 차단, 비용 영향 경고 */
export function checkBulk(items: readonly BulkItem[], cfgIn?: Partial<AdPilotConfig>, dailyBudget?: number): BulkCheck {
  const cfg = resolveConfig(cfgIn);
  const reasons: string[] = [];
  let level: BulkCheck['level'] = 'ok';
  const n = items?.length ?? 0;
  const costDelta = sum(items ?? [], (i) => safeNum(i.costDelta));
  if (n === 0) return { level: 'block', reasons: ['선택한 건이 없습니다'], count: 0, costDelta: 0 };
  if (n >= cfg.bulkBlockCount) { level = 'block'; reasons.push(`한 번에 ${n}건 — 기준 ${cfg.bulkBlockCount}건 이상 차단, 나눠서 요청`); }
  else if (n >= cfg.bulkWarnCount) { level = 'warn'; reasons.push(`한 번에 ${n}건 — 기준 ${cfg.bulkWarnCount}건 이상, 2단계 확인 필요`); }
  const over = (items ?? []).filter((i) => i.kind === 'bid' && (!finite(i.changePct) || Math.abs(i.changePct) > cfg.dailyChangeCapPct + 1e-9));
  if (over.length) { level = 'block'; reasons.push(`일 조정 폭 상한 ${cfg.dailyChangeCapPct}% 초과 ${over.length}건`); }
  if (dailyBudget && dailyBudget > 0 && Math.abs(costDelta) > dailyBudget * 0.1) {
    if (level === 'ok') level = 'warn';
    reasons.push(`예상 일 비용 영향 ${fmt.krw(costDelta)} — 일 예산 ${fmt.krw(dailyBudget)}의 ${pct0((Math.abs(costDelta) / dailyBudget) * 100)}`);
  }
  if (!reasons.length) reasons.push(`${n}건 · 기준 이내`);
  return { level, reasons, count: n, costDelta };
}

/* ================================================================== */
/* 알림 (보류 → MILDO Alert 이슈)                                         */
/* ================================================================== */

export function holdIncident(data: Dataset, p: AdPilotProposal, at: string): Incident {
  const tb = p.holdKind === 'tracking_break';
  const sev = tb || p.holdKind === 'account' ? 'P1' : 'P2';
  return {
    id: `adpilot_hold:${p.keyword}:${data.today}`,
    ruleId: tb ? 'tracking_break' : p.holdKind === 'soldout' ? 'soldout_landing' : p.holdKind === 'account' ? 'account_payment' : 'data_spike',
    severity: sev,
    title: `AD Pilot 자동 조정 보류 · ${p.keyword}`,
    media: p.media,
    target: p.keyword,
    detectedAt: at,
    occurredAt: data.generatedAt,
    detectPath: `AD Pilot ${RULE_LABEL[p.ruleId]} 규칙 (p.14)`,
    metric: p.holdKind === 'keyword_anomaly' ? 'CPC · 전환 (최근 3일)' : p.holdKind === 'tracking_break' ? '전환' : p.holdKind === 'data_spike' ? '광고비' : undefined,
    causeCandidates: (p.causes ?? []).map((c) => `${c.cause} — ${c.evidence}`),
    impact: { spendAtRisk: p.sim ? Math.round(p.sim.base.cost) : undefined },
    status: 'open',
    timeline: [{ at, by: 'AD Pilot', action: `감지 · 자동 조정 보류 (${p.basis})` }],
    isTest: true,
    autoActions: ['AD Pilot 자동 조정 보류'],
  };
}

/* ================================================================== */
/* 요약 · 오프라인 브리프                                                 */
/* ================================================================== */

export function proposalCounts(ps: readonly AdPilotProposal[]) {
  return {
    total: ps.length,
    up: ps.filter((p) => p.action === 'bid_up').length,
    down: ps.filter((p) => p.action === 'bid_down').length,
    budget: ps.filter((p) => p.action === 'budget_shift').length,
    test: ps.filter((p) => p.action === 'test_candidate').length,
    hold: ps.filter((p) => p.action === 'hold').length,
  };
}

export function saKeywordTotals(data: Dataset) {
  const ks = data?.keywords ?? [];
  const t = (arr: Keyword[]) => {
    const cost = sum(arr, (k) => safeNum(k.last14?.cost));
    const revenue = sum(arr, (k) => safeNum(k.last14?.revenue));
    const conversions = sum(arr, (k) => safeNum(k.last14?.conversions));
    return { cost, revenue, conversions, roas: metrics.roas(revenue, cost), cpa: metrics.cpa(cost, conversions) };
  };
  return { brand: t(ks.filter((k) => k.isBrand)), nonBrand: t(ks.filter((k) => !k.isBrand)), all: t(ks) };
}

/** 의도별 성과 (최근 14일) */
export function intentSummary(data: Dataset, cfgIn?: Partial<AdPilotConfig>) {
  const cfg = resolveConfig(cfgIn);
  return INTENT_IDS.map((i) => {
    const ks = (data?.keywords ?? []).filter((k) => k.intent === i);
    const cost = sum(ks, (k) => safeNum(k.last14?.cost));
    const revenue = sum(ks, (k) => safeNum(k.last14?.revenue));
    const conversions = sum(ks, (k) => safeNum(k.last14?.conversions));
    const target = i === 'brand' ? cfg.brandTargetRoas : cfg.targetRoas;
    const roas = metrics.roas(revenue, cost);
    return { intent: i, name: SA_CAMPAIGNS[i].name, keywords: ks.length, cost, revenue, conversions, roas, target, ratioPct: pctOf(roas, target) };
  });
}

/** AD Pilot 조정안 브리프 (AI 미연결 시 규칙 엔진 해석) */
export function adpilotBrief(data: Dataset, changes: readonly ChangeRequest[], cfgIn?: Partial<AdPilotConfig>): Brief {
  const cfg = resolveConfig(cfgIn);
  const ps = generateBidProposals(data, cfg);
  const n = proposalCounts(ps);
  const ups = ps.filter((p) => p.action === 'bid_up');
  const t = saKeywordTotals(data);
  const diag = diagnoseKeywords(data, cfg);
  const lowSample = diag.filter((d) => d.verdict === 'watch' && d.ruleId === 'below_target' && d.note.includes('표본'));
  const rankLimited = ups.filter((p) => {
    const k = data.keywords.find((x) => x.id === p.keywordId);
    return k && k.avgRank >= 3;
  });
  const incRoas = ups.map((p) => p.sim?.incrementalRoas ?? NaN).filter(finite);
  const minInc = incRoas.length ? Math.min(...incRoas) : NaN;
  const pending = (changes ?? []).filter((c) => c.module === 'adpilot' && c.status === 'pending').length;
  const facts = [
    `AD Pilot 조정 후보는 ${n.total}건입니다. 입찰 상향 ${n.up}건, 하향 ${n.down}건, 예산 재배분 · 증액 ${n.budget}건, 테스트 그룹 등록 후보 ${n.test}건이고 자동 조정 보류가 ${n.hold}건입니다. 기준은 목표 ROAS ${fmt.roas(cfg.targetRoas)}, 브랜드 ${fmt.roas(cfg.brandTargetRoas)}, 일 조정 폭 상한 ${cfg.dailyChangeCapPct}%입니다. (TEST DATA)`,
    `네이버 SA 키워드 최근 14일 비브랜드 ROAS ${fmt.roas(t.nonBrand.roas)}(광고비 ${fmt.krw(t.nonBrand.cost)}), 브랜드 ROAS ${fmt.roas(t.brand.roas)}(광고비 ${fmt.krw(t.brand.cost)})입니다. 승인 대기 중인 AD Pilot 변경은 ${pending}건입니다. (TEST DATA)`,
    ...ups.slice(0, 3).map((p) => `${p.keyword}: ${fmt.won(p.before)} → ${fmt.won(p.after)}(${fmt.delta(p.changePct)}). 근거 ${p.basis}.`),
  ];
  const patterns: string[] = [];
  if (ups.length) patterns.push(`상향 후보 ${ups.length}개 중 ${rankLimited.length}개는 평균 순위 3위 이하입니다. 같은 키워드의 캠페인 예산이 조기 소진되지 않는 한 노출 손실은 예산이 아니라 순위에서 생기는 구조로 읽힙니다.`);
  if (lowSample.length) patterns.push(`목표 ROAS를 두 기간 연속 밑돈 키워드 ${lowSample.length}개(${lowSample.map((d) => d.text).join(', ')})는 전환이 ${cfg.minConversionsForDown}건 미만이라 하향하지 않았습니다. 전환 1건이 ROAS를 크게 흔드는 표본 크기입니다.`);
  const holds = ps.filter((p) => p.action === 'hold');
  if (holds.length) patterns.push(`보류 ${holds.length}건은 ${holds.map((h) => `${h.keyword}(${h.holdKind === 'tracking_break' ? '전환 추적 단절' : h.holdKind === 'data_spike' ? '데이터 급변' : h.holdKind === 'keyword_anomaly' ? 'CPC 급변' : h.holdKind === 'soldout' ? '품절 랜딩' : h.holdKind === 'account' ? '잔액 부족' : '증액 전제 미충족'})`).join(', ')}입니다.`);
  const interpretation = [
    finite(minInc)
      ? `상향 후보의 증분 ROAS 추정 최저값은 ${fmt.roas(minInc)}로 목표 ${fmt.roas(cfg.targetRoas)}${minInc >= cfg.targetRoas ? '를 넘습니다. 탄력성 가정이 맞다면 상향분의 추가 광고비는 목표 효율로 회수되는 범위입니다' : '에 못 미치는 건이 있습니다. 평균 ROAS는 높아도 추가 비용의 회수 효율은 목표 미만일 수 있어 해당 건은 폭을 줄이는 쪽이 안전합니다'}.`
      : '상향 후보가 없어 증분 효율을 계산할 대상이 없습니다.',
    `브랜드 키워드 상향은 효율이 아니라 점유 방어 목적입니다. 브랜드 ROAS가 목표의 수십 배여도 순위가 밀리면 경쟁사 광고가 브랜드 검색 지면을 가져가므로, CAC 관점에서는 이미 확보한 수요의 회수 비용으로 봅니다.`,
  ];
  const conditions = [
    `탄력성 가정 클릭 ${cfg.clickElasticity} · CPC ${cfg.cpcElasticity} · CVR 불변. 실측이 아니며 반영 후 7일 실측으로 보정합니다.`,
    `급변 보류 ±${cfg.anomalyHoldPct}%는 최근 ${cfg.anomalyWindowDays}일 클릭 ${cfg.anomalyMinClicks}회 이상 · 기대 전환 ${cfg.anomalyMinExpectedConv}건 이상일 때만 판정합니다.`,
  ];
  const counter = [
    '노출 손실이 경쟁사의 일시적 입찰 상승 때문이라면 상향은 CPC만 올리고 순위를 되찾지 못할 수 있습니다. 반영 후 3일 내 순위 · CPC를 확인해 개선이 없으면 롤백합니다.',
  ];
  const actions = [
    `담당 AE: 승인 범위(±10% 이내) 후보는 16:30 익일 조정안 공유 전에 승인 요청까지 마칩니다.`,
    `PM: 브랜드 · ±10~${cfg.dailyChangeCapPct}% 후보와 보류 ${n.hold}건의 해제 여부를 결정합니다. 판정 기준은 원인 확인(1시간 내) 여부입니다.`,
    '반영 7일 후 예측 대비 실측(클릭 · 비용 · 전환)을 비교해 탄력성 가정을 갱신합니다.',
  ];
  return { title: 'AD Pilot 조정안 해석', facts, patterns, interpretation, conditions, counter, actions };
}

export function holdsBrief(data: Dataset, cfgIn?: Partial<AdPilotConfig>): Brief {
  const cfg = resolveConfig(cfgIn);
  const holds = generateBidProposals(data, cfg).filter((p) => p.action === 'hold');
  const facts = holds.length
    ? holds.map((h) => `${h.keyword}: ${h.basis}.`)
    : ['현재 자동 조정 보류 건이 없습니다. (TEST DATA)'];
  const patterns = holds.filter((h) => h.causes?.length).map((h) => `${h.keyword} 원인 후보 순위: ${h.causes!.map((c) => `${c.cause}(${c.evidence})`).join(' > ')}.`);
  return {
    title: '자동 조정 보류 현황',
    facts,
    patterns,
    interpretation: [
      '보류는 판단을 미루는 것이 아니라 잘못된 데이터로 입찰이 움직이는 것을 막는 장치입니다. 전환 추적 단절 상태에서 자동입찰을 돌리면 전환 0을 실제 성과로 읽고 입찰을 낮추게 됩니다.',
      'CPC 급등형 급변은 경쟁 입찰 상승 가능성이 가장 높게 계산됩니다. 이 경우 맞대응 상향보다 순위 하락 시 손실 매출과 추가 CPC 비용을 비교해 결정하는 편이 CAC 관점에서 안전합니다.',
    ],
    conditions: [`급변 기준 ±${cfg.anomalyHoldPct}% (p.14 · p.44), 전환 추적 단절은 전환 0 연속 2시간 이상 · 최근 4주 동시간대 전환 0 발생률 5% 미만.`],
    counter: ['매체 집계 지연이면 1~2시간 뒤 정상화됩니다. 정상화되면 오탐으로 기록하고 보류를 해제합니다.'],
    actions: ['담당 AE: P1(전환 추적 단절)은 30분 내 1차 조치, P2(급변)는 1시간 내 원인 보고.', 'PM: 원인 확인 후 보류 해제 여부 결정.'],
  };
}

export function budgetBrief(data: Dataset, cfgIn?: Partial<AdPilotConfig>): Brief {
  const cfg = resolveConfig(cfgIn);
  const paces = paceCampaigns(data, data.campaigns, cfg);
  const early = paces.filter((p) => p.earlyExhaust);
  const ps = generateBidProposals(data, cfg).filter((p) => p.ruleId === 'early_exhaust' || p.holdKind === 'data_spike');
  return {
    title: '일 예산 조기 소진 · 재배분',
    facts: early.length
      ? early.map((p) => `${p.name}: 오늘 ${p.hourOfData}시 기준 소진 ${pct0(p.pacePct)}, 예상 마감 ${clock(p.curveExhaustHour ?? p.linearExhaustHour)}(시간대 가중) · 선형 추정 ${clock(p.linearExhaustHour)}. (TEST DATA)`)
      : ['조기 소진 예상 캠페인이 없습니다. (TEST DATA)'],
    patterns: [
      '선형 추정은 남은 시간의 소진 속도를 현재와 같다고 보지만 매트리스 수요는 21~23시가 피크라 실제 마감은 더 빨라집니다. 시간대 가중 추정은 최근 28일 매체별 시간대 광고비 비중을 씁니다.',
    ],
    interpretation: ps.map((p) => `${p.keyword}: ${p.action === 'hold' ? '보류' : `${fmt.krw(p.before)} → ${fmt.krw(p.after)}`} — ${p.reason}`),
    conditions: [`조기 소진 기준 ${cfg.exhaustBeforeHour}시 전 마감. 재배분 재원은 같은 매체 · 비브랜드 · 예상 소진율 ${fmt.ratio(cfg.donorPaceMax, 0)} 미만 캠페인.`, '증액 전제는 캠페인 ROAS ≥ 목표이며 평균 ROAS 기준이라 한계 ROAS는 더 낮을 수 있습니다.'],
    counter: ['조기 소진이 데이터 급변(예: 특정 시간 광고비 급등) 때문이라면 증액은 이상 지출을 키웁니다. 해당 매체는 원인 확인 전까지 보류합니다.'],
    actions: ['담당 AE: ±10% 이내 재배분은 14:00 소진율 점검 직후 승인 요청.', 'PM: 순증액 · 월 예산 초과 페이스 매체는 수면밀도 승인 안건으로 정리.'],
  };
}

export function gfaBrief(data: Dataset, changes: readonly ChangeRequest[], cfgIn?: Partial<AdPilotConfig>): Brief {
  const views = gfaOverview(data, changes, cfgIn);
  const pending = (changes ?? []).filter((c) => c.module === 'gfa' && c.status === 'pending');
  const held = (changes ?? []).filter((c) => c.module === 'gfa' && c.status === 'held');
  return {
    title: 'GFA Control v1 점검',
    facts: views.map((v) => `${v.account.name}: 잔액 ${v.account.balance < 0 ? '후불' : fmt.krw(v.account.balance)} · 일 평균 소진 ${fmt.krw(v.account.avgDailySpend)} · ${Number.isFinite(v.runwayDays) ? `${v.runwayDays.toFixed(2)}일치` : '소진 없음'} · 자동충전 '${AUTO_CHARGE_LABEL[v.account.autoCharge]}' · 캠페인 ${v.campaigns.length}개${v.exhaustAt ? ` · 잔액 소진 예상 ${fmtDate(v.exhaustAt.date)} ${v.exhaustAt.hour}시경` : ''}.${v.demo ? ' (DEMO 가정 계정)' : ' (TEST DATA)'}`),
    patterns: views.flatMap((v) => v.issues.filter((i) => i.level === 'critical' || i.level === 'warn').map((i) => `${v.account.name} — ${i.text}: ${i.basis}.`)),
    interpretation: [
      '잔액이 1일치 미만이고 자동충전이 실패한 계정에서는 예산 증액 · 광고그룹 ON 요청이 승인되어도 실행 단계에서 보류됩니다. 잔액이 먼저 풀리지 않으면 GFA 노출이 끊기고, 1~2일 시차로 동행하는 브랜드 검색량에도 영향이 갑니다.',
    ],
    conditions: ['위임 범위(예시 · 계약 시 확정): 일 예산 ±10% 이내 · 상태 점검 담당 AE, ±10~30% · 광고그룹 ON/OFF PM, 30% 초과 · 신규 캠페인 수면밀도 승인 (p.15).'],
    counter: ['자동충전 실패가 카드 한도 일시 문제라면 당일 해소될 수 있습니다. 충전 확인 후 보류 건을 재실행합니다.'],
    actions: [
      `PM: 수면밀도 결제 담당자에게 충전 요청 (승인 대기 ${pending.length}건 · 실행 보류 ${held.length}건).`,
      '담당 AE: 조기 소진 예상 캠페인의 증액 요청은 충전 확인 후 제출.',
    ],
  };
}

/* ================================================================== */
/* ChangeRequest 입력 생성 (View · Agent 공용)                            */
/* ================================================================== */

export type ChangeInput = Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'>;

export function proposalTargetLabel(p: AdPilotProposal): string {
  if (p.action === 'budget_shift') return `${p.keyword} 일 예산${p.donor ? ` ← ${p.donor.name}` : ''}`;
  if (p.action === 'test_candidate') return `${p.keyword} → ${p.intent ? `${p.intent.toUpperCase()}_TEST` : 'TEST'} 등록`;
  if (p.holdKind === 'soldout') return `${p.keyword} 광고 일시 중지`;
  return `${p.keyword} 입찰가`;
}

/** 조정 후보 → 승인 요청 입력. 보류(품절 제외)는 요청 대상이 아니므로 null */
export function proposalChangeInput(p: AdPilotProposal, requestedBy: string): ChangeInput | null {
  const base = { module: 'adpilot', target: proposalTargetLabel(p), requestedBy, approver: p.approver };
  if (p.action === 'hold') {
    if (p.holdKind !== 'soldout') return null;
    return { ...base, kind: 'status', targetId: p.changeTargetId, before: 'on', after: 'off', reason: `${p.reason} 근거: ${p.basis}` };
  }
  if (p.action === 'test_candidate') {
    return { ...base, kind: 'keyword_add', targetId: p.changeTargetId, before: '미등록', after: `${p.intent ? p.intent.toUpperCase() : 'GENERIC'}_TEST · 입찰 ${fmt.won(p.after)}`, reason: `${p.reason} 근거: ${p.basis}` };
  }
  return { ...base, kind: p.kind, targetId: p.changeTargetId, before: p.before, after: p.after, changePct: p.changePct, reason: `${p.reason} 근거: ${p.basis}` };
}

/** 자동 입찰 검증 화면의 수동 입찰 변경 → 승인 요청 입력 */
export function bidChangeInput(k: Keyword, before: number, after: number, v: BidVerification, requestedBy: string, note?: string): ChangeInput {
  return {
    module: 'adpilot', kind: 'bid', target: `${k.text} 입찰가`, targetId: k.id, before, after, changePct: v.changePct,
    reason: `${note?.trim() ? `${note.trim()} ` : ''}자동 입찰 검증 — ${simText(v.sim)}. 검증: ${v.items.map((i) => `${i.label} ${i.level === 'pass' ? '통과' : i.level === 'warn' ? '주의' : '차단'}`).join(', ')}`,
    requestedBy, approver: v.route.approver,
  };
}

/** 기준 변경 승인 요청 입력 (항목별 1건) */
export function settingChangeInputs(official: AdPilotConfig, draft: AdPilotConfig, requestedBy: string): ChangeInput[] {
  return configDiff(official, draft).map(({ key, before, after }) => {
    const f = CONFIG_FIELDS.find((x) => x.key === key)!;
    return {
      module: 'adpilot', kind: 'setting', target: `AD Pilot 기준 · ${f.label}`, targetId: `${CONFIG_TARGET_PREFIX}${key}`, before, after,
      changePct: before !== 0 ? round1(((after - before) / Math.abs(before)) * 100) : undefined,
      reason: `${f.label} ${before}${f.unit} → ${after}${f.unit} (${f.source}). 변경 시 조정 후보 판정이 즉시 바뀝니다.`,
      requestedBy, approver: f.approver,
    };
  });
}

/** GFA 요청 계획 → 승인 요청 입력 */
export function gfaChangeInput(plan: GfaRequestPlan, d: GfaRequestDraft, requestedBy: string): ChangeInput {
  const what = d.type === 'budget' ? `일 예산 ${fmt.delta(Number(d.pct))}` : d.type === 'adgroup' ? `광고그룹 ${String(plan.after).toUpperCase()}` : `신규 캠페인${d.objective ? ` (${d.objective})` : ''}`;
  return {
    module: 'gfa', kind: plan.kind, target: plan.target, targetId: plan.targetId, before: plan.before, after: plan.after, changePct: plan.changePct,
    reason: `${what}. ${d.reason?.trim() || '사유 미입력'} · 승인 라우팅: ${plan.route.reason}${plan.warnings.length ? ` · 주의: ${plan.warnings.join(' / ')}` : ''}`,
    requestedBy, approver: plan.route.approver,
  };
}

/** AI 프롬프트용 스냅샷 (작은 JSON) */
export function proposalsSnapshot(ps: readonly AdPilotProposal[], cfg: AdPilotConfig) {
  return {
    기준: { 목표ROAS: cfg.targetRoas, 브랜드목표ROAS: cfg.brandTargetRoas, 일조정폭상한pct: cfg.dailyChangeCapPct, 노출손실기준: cfg.lostShareTrigger, 최소전환: cfg.minConversionsForDown, 급변보류pct: cfg.anomalyHoldPct },
    후보: ps.slice(0, 40).map((p) => ({
      대상: p.keyword, 규칙: p.rule, 조치: p.action, 현재: Math.round(p.before), 제안: Math.round(p.after), 변경pct: p.changePct,
      근거: p.basis, 예상: p.expected, 승인: APPROVER_LABEL[p.approver], 원인후보: p.causes?.map((c) => c.cause),
    })),
  };
}
