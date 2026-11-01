/**
 * MILDO Lab 엔진 — 제안서 p.26–28 · p.36 (+ VisualTune OS p.27 · 검수)
 * 순수 함수만 둔다 (React import 금지). 성과 수치는 Dataset(시연용 테스트 데이터)에서 계산한다.
 *  - 발굴: 검색어 보고서 미등록 후보 · 연관 검색어 · AI 검색 질의 · SKU 확장 48 진입점 → 의도 · 검색량 · 랜딩 · 우선순위
 *  - 판정: 키워드 테스트 STEP 1~4 (확장 ≥ 목표 ROAS 100% · 유지 70~100% · 제외 < 70% · 전환 없음)
 *  - 테스트 카드: 두 비율 z-검정 · 필요 표본 · 7일차 중단 · +15% 확대 · 2주 랩업
 *  - 소재: SA 문안 생성(15/45자) · 검수 에이전트(REVIEW_RULES + 데이터 대조)
 */
import type { ApprovalLevel, ChangeKind, ChangeRequest, Dataset, IntentId, Keyword, Product, Promotion } from '@/core/types';
import type { Brief } from '@/ai/prompts';
import { AD_PILOT, INTENT_IDS, REVIEW_RULES, SA_CAMPAIGNS, SKU_EXPANSION } from '@/data/constants';
import { addDays, clamp, fmt, fmtDate, isOffDay, parseDate, twoProportionZ, weekday } from '@/core/util';
import {
  AI_QUERY_SEEDS, CARD_RULES, COPY_HEADS, EXTRA_REVIEW_RULES, HYPOTHESES, LAB_BULK, LAB_DEFAULT_CRITERIA, LANDING_CATALOG, LOOP_CADENCE,
  PHRASE_TOPICS, RELATED_SEEDS, REVIEW_FIXES, SA_CHAR_LIMITS, SCORE_WEIGHTS, SKU_TOKENS, SKU_VOLUME, VISUALTUNE_DRAFTS, type HypId, type LoopCadenceId,
} from './data';

/* ================================================================== */
/* 공통                                                                */
/* ================================================================== */


/** 다른 모듈에서 들어온 요청의 출처 표기 */
const SOURCE_MODULE_LABEL: Record<string, string> = { adpilot: 'AD Pilot', watch: 'MILDO Watch', geo: 'SearchTuneOS', growth: '매출 성장', flow: 'MILDO Flow', alert: 'MILDO Alert', board: 'MILDO Board', reports: '리포트' };
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const n0 = (v: unknown): number => (finite(v) ? v : 0);
/** JSON 출력용 반올림 — 유한하지 않으면 null */
export function rn(v: number, d = 0): number | null {
  if (!finite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
export function norm(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}
export function daysBetween(from: string, to: string): number {
  if (!from || !to) return NaN;
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
}
const round10 = (v: number) => Math.round(v / 10) * 10;
export const pct0 = (v: number) => (finite(v) ? `${fmt.int(v)}%` : '—');
export function pText(p: number): string {
  if (!finite(p)) return 'p=—';
  if (p < 0.001) return 'p<0.001';
  return `p=${p.toFixed(p < 0.1 ? 3 : 2)}`;
}
/** 부호 있는 % (음수는 − 기호) */
export function sg(v: number, d = 0): string {
  if (!finite(v)) return '—';
  const r = Number(Math.abs(v).toFixed(d));
  return `${v > 0 && r > 0 ? '+' : v < 0 && r > 0 ? '−' : ''}${r.toFixed(d)}%`;
}
export const INTENT_NAME = (i: IntentId | null | undefined) => (i && SA_CAMPAIGNS[i] ? SA_CAMPAIGNS[i].name : '미분류');

export interface Stats { impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
export const EMPTY_STATS: Stats = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
export function sumStats(rows: readonly Partial<Stats>[]): Stats {
  const s = { ...EMPTY_STATS };
  for (const r of rows ?? []) {
    s.impressions += n0(r?.impressions);
    s.clicks += n0(r?.clicks);
    s.cost += n0(r?.cost);
    s.conversions += n0(r?.conversions);
    s.revenue += n0(r?.revenue);
  }
  s.conversions = Math.round(s.conversions * 100) / 100;
  return s;
}
/** 전환이 없으면 매출이 있어도 ROAS 0 (집계 반올림 오차 방지), 비용이 없으면 NaN */
export function roasOf(s: Partial<Stats>): number {
  const cost = n0(s.cost);
  if (cost <= 0) return NaN;
  return n0(s.conversions) > 0 ? (n0(s.revenue) / cost) * 100 : 0;
}
export const ctrOf = (s: Partial<Stats>) => (n0(s.impressions) > 0 ? (n0(s.clicks) / n0(s.impressions)) * 100 : NaN);
export const cvrOf = (s: Partial<Stats>) => (n0(s.clicks) > 0 ? (n0(s.conversions) / n0(s.clicks)) * 100 : NaN);
export const cpaOf = (s: Partial<Stats>) => (n0(s.conversions) > 0 ? n0(s.cost) / n0(s.conversions) : NaN);
export const cpcOf = (s: Partial<Stats>) => (n0(s.clicks) > 0 ? n0(s.cost) / n0(s.clicks) : NaN);
const liftOf = (v: number, c: number) => (finite(v) && finite(c) && c !== 0 ? ((v - c) / Math.abs(c)) * 100 : NaN);

/** 승인 권한 — AE는 AE건, PM은 AE·PM건, 수면밀도는 전부 (SPEC §4 flow) */
export const APPROVER_LABEL: Record<ApprovalLevel, string> = { AE: '담당 AE', PM: 'PM', CLIENT: '수면밀도 승인' };
export function canApprove(role: string, approver: ApprovalLevel): { ok: boolean; reason: string } {
  const r = role === '수면밀도' ? 3 : role === 'PM' ? 2 : role === '담당 AE' ? 1 : 0;
  const need = approver === 'CLIENT' ? 3 : approver === 'PM' ? 2 : 1;
  return r >= need ? { ok: true, reason: '' } : { ok: false, reason: `${APPROVER_LABEL[approver]} 권한 필요 · 현재 역할 ${role || '미지정'}` };
}

/* ================================================================== */
/* 구매 의도 분류                                                        */
/* ================================================================== */

const NON_PURCHASE = /(버리기|버리는|폐기|수거|중고|렌탈|대여|세탁|청소|분리수거)/;
const MEDICAL_CONTEXT = /(디스크|통증|척추|허리\s?아플|교정|질환|병원)/;

export interface IntentResult { intent: IntentId; secondary: IntentId | null; purchase: boolean; medical: boolean }
export function classifyIntent(term: string): IntentResult {
  const t = String(term ?? '');
  const hits: IntentId[] = [];
  if (/(수면밀도|밀도\s?매트리스|밀도매트리스)/.test(t)) hits.push('brand');
  if (/(신혼|혼수|이사|자취|첫\s?독립|아이\s?방|초등|학생|부모님|선물|입주|집들이)/.test(t)) hits.push('life');
  if (/(허리|디스크|꺼짐|처짐|통기|더위|덥지|여름|소음|뒤척|경도|단단|푹신|보상|보증|교체)/.test(t)) hits.push('problem');
  if (/(추천|비교|vs|VS|순위|가성비|후기|리뷰|차이|브랜드)/.test(t)) hits.push('compare');
  const intent = hits[0] ?? 'generic';
  return { intent, secondary: hits.find((h) => h !== intent) ?? null, purchase: !NON_PURCHASE.test(t), medical: MEDICAL_CONTEXT.test(t) };
}

/* ================================================================== */
/* 랜딩 매칭 · 검색량 추정                                                */
/* ================================================================== */

export interface LandingMatch { level: 'good' | 'partial' | 'none'; key: string; url: string; label: string; notes: string[]; gaps: string[] }
export const LANDING_LEVEL_META: Record<LandingMatch['level'], { label: string; tone: 'good' | 'warning' | 'serious' }> = {
  good: { label: '매칭', tone: 'good' },
  partial: { label: '부분 매칭', tone: 'warning' },
  none: { label: '없음', tone: 'serious' },
};

export function phraseTopics(phrase: string): string[] {
  const t = norm(phrase);
  return PHRASE_TOPICS.filter((topic) => t.includes(norm(topic)));
}

function soldOutOptions(data: Dataset): { product: Product; label: string }[] {
  const out: { product: Product; label: string }[] = [];
  for (const p of data?.products ?? []) for (const o of p.options ?? []) if (o && o.inStock === false) out.push({ product: p, label: o.label });
  return out;
}
function livePromotions(data: Dataset): Promotion[] {
  const today = data?.today ?? '';
  return (data?.promotions ?? []).filter((p) => p.status !== 'ended' && p.end >= today && (p.status === 'live' || p.start <= today));
}

/** 구문 → 랜딩 (토픽 커버리지가 가장 큰 랜딩, 동점이면 의도 기본 랜딩) + 품절 · 기획전 종료 · 콘텐츠 공백 점검 */
export function landingFor(data: Dataset, phrase: string, intentIn?: IntentId): LandingMatch {
  const ci = classifyIntent(phrase);
  const intent = intentIn ?? ci.intent;
  const topics = phraseTopics(phrase);
  let best = LANDING_CATALOG.find((l) => l.intents.includes(intent)) ?? LANDING_CATALOG[0];
  let bestScore = -1;
  for (const l of LANDING_CATALOG) {
    const cover = topics.filter((t) => l.topics.includes(t)).length + (l.intents.includes(intent) ? 0.5 : 0);
    if (cover > bestScore) { best = l; bestScore = cover; }
  }
  const covered = new Set(LANDING_CATALOG.flatMap((l) => l.topics));
  const gaps = topics.filter((t) => !covered.has(t));
  const notes: string[] = [];
  let level: LandingMatch['level'] = gaps.length ? 'partial' : 'good';
  if (gaps.length) notes.push(`'${gaps.join(' · ')}' 전용 콘텐츠 없음 — 선택 가이드 보강 · FAQ(SearchTuneOS) 연계`);
  const others = LANDING_CATALOG.filter((l) => l.key !== best.key && topics.some((t) => l.topics.includes(t) && !best.topics.includes(t)));
  if (others.length) notes.push(`보조 랜딩: ${others.map((l) => l.label).join(' · ')}`);
  for (const so of soldOutOptions(data)) {
    if (norm(phrase).includes(norm(so.label))) {
      level = 'partial';
      notes.push(`${so.label} 옵션 품절 — 랜딩에서 구매 불가 (${so.product.name})`);
    } else if (topics.includes('사이즈') && best.product) {
      notes.push(`사이즈 비교 시 ${so.label} 품절 표시 필요`);
    }
  }
  if (best.promo) {
    const all = livePromotions(data);
    const own = all.filter((p) => p.channel === 'brandstore' || p.channel === 'own_mall');
    const live = own.length ? own : all;
    if (!live.length) {
      level = 'partial';
      notes.push('진행 중 기획전 없음 — 기획전 랜딩이 비어 있음');
    } else {
      const soonest = [...live].sort((a, b) => a.end.localeCompare(b.end))[0];
      const left = daysBetween(data.today, soonest.end);
      if (finite(left) && left <= 7) {
        level = 'partial';
        notes.push(`'${soonest.name}' ${fmtDate(soonest.end)} 종료 (D-${Math.max(0, left)}) — 종료 후 랜딩 교체 필요`);
      }
    }
  }
  if (!ci.purchase) {
    level = 'none';
    notes.unshift('구매 의도 낮음 (폐기 · 렌탈 등) — 랜딩 매칭 대상 아님');
  }
  return { level, key: best.key, url: best.url, label: best.label, notes, gaps };
}

/** 데이터 키워드 중 토큰을 포함하는 키워드의 최대 월간 검색량 */
export function tokenVolume(data: Dataset, tokens: readonly string[]): number | null {
  let best = 0;
  for (const k of data?.keywords ?? []) {
    const t = norm(k.text);
    if (tokens.some((tok) => tok && t.includes(norm(tok)))) best = Math.max(best, n0(k.monthlySearch));
  }
  return best > 0 ? best : null;
}

/** 일반 구문 검색량 추정 (데모 추정) — 단어별 데이터 검색량 상위 2개의 기하평균 × 롱테일 계수 */
export function estimatePhraseVolume(data: Dataset, phrase: string): { volume: number; note: string } {
  const words = String(phrase ?? '').split(/\s+/).filter((w) => w && w !== '매트리스');
  const vols = words.map((w) => tokenVolume(data, [w])).filter((v): v is number => v !== null).sort((a, b) => b - a);
  if (!vols.length) return { volume: SKU_VOLUME.fallbackMonthly, note: `데모 추정 · 데이터 키워드 근거 없음 → 기본 ${SKU_VOLUME.fallbackMonthly} 가정` };
  const g = vols.length >= 2 ? Math.sqrt(vols[0] * vols[1]) : vols[0];
  const v = Math.max(SKU_VOLUME.min, round10(g * SKU_VOLUME.longTailFactor));
  return { volume: v, note: `데모 추정 · 단어 검색량 ${vols.slice(0, 2).map((x) => fmt.int(x)).join(' · ')} 기하평균 × ${SKU_VOLUME.longTailFactor}` };
}

/** 테스트 그룹 입찰 상한 — 같은 의도 MAIN(on) 키워드 입찰가 중앙값 (데이터) */
export function testBidCap(data: Dataset, intent: IntentId): number {
  const bids = (data?.keywords ?? []).filter((k) => k.intent === intent && k.status === 'on' && finite(k.bid)).map((k) => k.bid).sort((a, b) => a - b);
  if (!bids.length) return 1000;
  const m = Math.floor(bids.length / 2);
  return round10(bids.length % 2 ? bids[m] : (bids[m - 1] + bids[m]) / 2);
}

/* ================================================================== */
/* 발굴 후보                                                             */
/* ================================================================== */

export type CandidateSource = 'search_term' | 'related' | 'ai_query' | 'sku48' | 'ai_expand';
export const SOURCE_LABEL: Record<CandidateSource, string> = {
  search_term: '검색어 보고서', related: '연관 검색어', ai_query: 'AI 검색 질의', sku48: 'SKU 확장 48', ai_expand: 'AI 확장',
};
export type CandidateStatus = 'new' | 'requested' | 'testing' | 'existing' | 'rejected';
export const CANDIDATE_STATUS_LABEL: Record<CandidateStatus, string> = { new: '미등록', requested: '등록 요청', testing: '테스트 중', existing: '등록 키워드', rejected: '반려' };

export interface Candidate {
  id: string;
  phrase: string;
  source: CandidateSource;
  origin: string;
  intent: IntentId;
  secondary: IntentId | null;
  purchase: boolean;
  medical: boolean;
  volume: number;
  volumeKind: 'impressions' | 'monthly_est' | 'monthly_demo';
  volumeNote: string;
  evidence: { clicks: number; conversions: number; cost: number; revenue: number; roas: number; ratioPct: number } | null;
  landing: LandingMatch;
  score: number;
  parts: { volume: number; landing: number; evidence: number; intent: number };
  tier: 'priority' | 'review' | 'hold';
  flags: string[];
  status: CandidateStatus;
  statusNote: string;
  bidCap: number;
  sku?: { problem: string; situation: string; criterion: string; index: number; head: string };
}
export const TIER_META: Record<Candidate['tier'], { label: string; tone: 'accent' | 'neutral' | 'outline' }> = {
  priority: { label: '우선', tone: 'accent' },
  review: { label: '검토', tone: 'neutral' },
  hold: { label: '보류', tone: 'outline' },
};

/**
 * 키워드 테스트 그룹 등록 요청인가 (Lab 후보 등록 · AD Pilot 테스트 그룹 등록).
 * kind 'test'(Watch 소액 테스트 · Growth 파일럿 등)는 키워드가 아니므로 여기서 제외하고 incomingTests()로 따로 받는다.
 */
export function isRegistration(c: ChangeRequest): boolean {
  if (!c) return false;
  if (c.kind === 'keyword_add' && c.module === 'lab') return !String(c.targetId ?? '').startsWith('labdec:');
  // AD Pilot · SearchTuneOS(GEO)는 같은 형식(targetId 'term:…', after '<INTENT>_TEST …')으로 등록 요청을 보낸다
  if (c.kind === 'keyword_add' && (c.module === 'adpilot' || c.module === 'geo')) return /_TEST/.test(String(c.after));
  return false;
}

/** 다른 모듈이 Lab으로 보낸 테스트 요청 (Watch 감지 → 소액 테스트 · Growth 파일럿 · 홀드아웃) — Lab 테스트 카드 요청(labcard:)은 제외 */
export interface IncomingTest { change: ChangeRequest; origin: string; route: string; title: string; summary: string; before: string; after: string }
/** 변경 전후 값 표기 — 숫자(예산 원 단위)는 금액으로 */
const changeValue = (v: unknown): string => (typeof v === 'number' ? (finite(v) ? `${fmt.krw(v)}원` : '—') : String(v ?? ''));
/** 아직 처리할 수 있는 요청 (승인 대기 · 승인 · 보류) */
export const isOpenChange = (c: Pick<ChangeRequest, 'status'>) => c.status === 'pending' || c.status === 'approved' || c.status === 'held';
export function incomingTests(changes: readonly ChangeRequest[] = []): IncomingTest[] {
  return [...(changes ?? [])]
    .filter((c) => c && c.kind === 'test' && !String(c.targetId ?? '').startsWith('labcard:'))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((c) => {
      const fromWatch = c.module === 'watch' || /MILDO Watch/.test(String(c.reason ?? ''));
      const origin = fromWatch ? 'MILDO Watch' : c.module === 'growth' ? '매출 성장' : c.module === 'lab' ? 'MILDO Lab' : String(c.module ?? '기타');
      const route = fromWatch ? 'watch' : c.module === 'growth' ? 'growth' : c.module === 'lab' ? 'lab' : String(c.module ?? 'flow');
      const before = changeValue(c.before);
      const after = changeValue(c.after);
      return { change: c, origin, route, title: String(c.target ?? ''), summary: `${before} → ${after}`, before, after };
    });
}
const isActiveStatus = (s: ChangeRequest['status']) => s !== 'rejected' && s !== 'rolled_back';

export function candidateStatus(data: Dataset, changes: readonly ChangeRequest[], phrase: string): { status: CandidateStatus; note: string } {
  const p = norm(phrase);
  const kw = (data?.keywords ?? []).find((k) => norm(k.text) === p);
  if (kw) return { status: kw.status === 'test' ? 'testing' : 'existing', note: kw.status === 'test' ? `테스트 그룹 키워드 (${kw.adgroup})` : `등록 키워드 (${kw.adgroup})` };
  const st = (data?.searchTerms ?? []).find((t) => t.registered && norm(t.term) === p);
  if (st) return { status: 'testing', note: '검색어 보고서 등록 구문 · 테스트 그룹 집행' };
  const reg = [...(changes ?? [])].filter((c) => isRegistration(c) && norm(c.target) === p).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (reg) {
    if (reg.status === 'pending' || reg.status === 'held') return { status: 'requested', note: `등록 요청 · ${APPROVER_LABEL[reg.approver]} 승인 대기` };
    if (reg.status === 'approved' || reg.status === 'applied') return { status: 'testing', note: reg.status === 'applied' ? '테스트 그룹 반영 완료' : '승인 · 반영 대기' };
    return { status: 'rejected', note: reg.status === 'rolled_back' ? '롤백됨' : '반려 — 사유 확인 후 재요청 가능' };
  }
  return { status: 'new', note: '미등록' };
}

interface CandInput {
  phrase: string; source: CandidateSource; origin: string; volume: number; volumeKind: Candidate['volumeKind']; volumeNote: string;
  evidence?: Candidate['evidence']; sku?: Candidate['sku'];
}
function intentGroupRoas(data: Dataset, intent: IntentId): number {
  return roasOf(sumStats((data?.keywords ?? []).filter((k) => k.intent === intent && k.status === 'on').map((k) => k.last14)));
}

export function scoreCandidate(input: { volume: number; landing: LandingMatch; evidence: Candidate['evidence']; purchase: boolean; intent: IntentId; groupRoasRatio: number }) {
  const W = SCORE_WEIGHTS;
  const volume = Math.round(W.volume * clamp(Math.log10(Math.max(0, n0(input.volume)) + 1) / Math.log10(W.volumeCap + 1), 0, 1) * 10) / 10;
  const landing = input.landing.level === 'good' ? W.landing : input.landing.level === 'partial' ? W.landing / 2 : 0;
  let evidence = 0;
  if (input.evidence) {
    const e = input.evidence;
    evidence = e.conversions > 0 ? W.evidence * clamp(n0(e.ratioPct) / 150, 0, 1) * (e.conversions >= 1 ? 1 : 0.6) : 0;
  } else {
    evidence = finite(input.groupRoasRatio) && input.groupRoasRatio >= 100 ? 6 : 2; // 같은 의도 그룹 ROAS 간접 근거
  }
  evidence = Math.round(evidence * 10) / 10;
  const intent = !input.purchase ? 0 : input.intent === 'brand' ? W.intent / 2 : W.intent;
  let score = Math.round(volume + landing + evidence + intent);
  if (!input.purchase) score = Math.min(score, 30);
  const tier: Candidate['tier'] = score >= W.priority ? 'priority' : score >= W.review ? 'review' : 'hold';
  return { score, tier, parts: { volume, landing, evidence, intent } };
}

function buildCandidate(data: Dataset, changes: readonly ChangeRequest[], inp: CandInput, target: number = AD_PILOT.targetRoas): Candidate {
  const ci = classifyIntent(inp.phrase);
  const landing = landingFor(data, inp.phrase, ci.intent);
  const groupRatio = (intentGroupRoas(data, ci.intent) / (ci.intent === 'brand' ? AD_PILOT.brandTargetRoas : target)) * 100;
  const sc = scoreCandidate({ volume: inp.volume, landing, evidence: inp.evidence ?? null, purchase: ci.purchase, intent: ci.intent, groupRoasRatio: groupRatio });
  const flags: string[] = [];
  if (ci.medical) flags.push('의료 연관 검색 맥락 — 문안 · 랜딩 의료 효능 표현 금지 (검수 필수)');
  if (ci.intent === 'brand') flags.push(`브랜드 검색어 — 브랜드 방어 캠페인 편입 검토 (브랜드 기준 ROAS ${AD_PILOT.brandTargetRoas}%)`);
  if (!ci.purchase) flags.push('구매 의도 낮음 — 제외 키워드 후보');
  if (inp.evidence && inp.evidence.clicks < LAB_DEFAULT_CRITERIA.minClicks) flags.push(`보고서 클릭 ${fmt.int(inp.evidence.clicks)}회 — 등록 후 최소 클릭 ${LAB_DEFAULT_CRITERIA.minClicks}회 확보 필요`);
  const st = candidateStatus(data, changes, inp.phrase);
  return {
    id: `${inp.source}:${norm(inp.phrase)}`,
    phrase: inp.phrase, source: inp.source, origin: inp.origin,
    intent: ci.intent, secondary: ci.secondary, purchase: ci.purchase, medical: ci.medical,
    volume: Math.max(0, Math.round(n0(inp.volume))), volumeKind: inp.volumeKind, volumeNote: inp.volumeNote,
    evidence: inp.evidence ?? null, landing, score: sc.score, parts: sc.parts, tier: sc.tier, flags,
    status: st.status, statusNote: st.note, bidCap: testBidCap(data, ci.intent), sku: inp.sku,
  };
}

/** 소스 1 — 검색어 보고서: 미등록 + 기존 키워드와 중복 아님 */
export function searchTermCandidates(data: Dataset, changes: readonly ChangeRequest[] = [], target: number = AD_PILOT.targetRoas): Candidate[] {
  const kw = new Set((data?.keywords ?? []).map((k) => norm(k.text)));
  return (data?.searchTerms ?? [])
    .filter((t) => t && !t.registered && !kw.has(norm(t.term)))
    .map((t) => {
      const roas = roasOf(t);
      const ci = classifyIntent(t.term);
      const tgt = ci.intent === 'brand' ? AD_PILOT.brandTargetRoas : target;
      return buildCandidate(data, changes, {
        phrase: t.term, source: 'search_term', origin: '검색어 보고서 (미등록)',
        volume: n0(t.impressions), volumeKind: 'impressions', volumeNote: `검색어 보고서 노출 ${fmt.int(t.impressions)} · 클릭 ${fmt.int(t.clicks)} (실측 · TEST DATA)`,
        evidence: { clicks: n0(t.clicks), conversions: n0(t.conversions), cost: n0(t.cost), revenue: n0(t.revenue), roas, ratioPct: finite(roas) ? (roas / tgt) * 100 : NaN },
      }, target);
    });
}

/** 소스 2 — 연관 검색어 (데모 스냅샷) */
export function relatedCandidates(data: Dataset, changes: readonly ChangeRequest[] = [], seeds = RELATED_SEEDS, target: number = AD_PILOT.targetRoas): Candidate[] {
  return seeds.map((s) => buildCandidate(data, changes, {
    phrase: s.term, source: 'related', origin: `연관: ${s.seed}`, volume: s.monthly, volumeKind: 'monthly_demo', volumeNote: `연관 검색어 월간 검색량 ${fmt.int(s.monthly)} (데모 스냅샷)`,
  }, target));
}

/** 소스 3 — AI 검색 질의 (데모 스냅샷) */
export function aiQueryCandidates(data: Dataset, changes: readonly ChangeRequest[] = [], seeds = AI_QUERY_SEEDS, target: number = AD_PILOT.targetRoas): Candidate[] {
  return seeds.map((s) => buildCandidate(data, changes, {
    phrase: s.phrase, source: 'ai_query', origin: `${s.engine}: "${s.query}"`, volume: s.monthly, volumeKind: 'monthly_demo', volumeNote: `AI 질의 → 검색 전환 추정 월 ${fmt.int(s.monthly)} (데모 가정)`,
  }, target));
}

/** p.36 SKU 확장 생성기 — 제품 1 × 문제 4 × 상황 4 × 비교 3 = 48 */
export function skuEntries(data: Dataset, changes: readonly ChangeRequest[] = [], target: number = AD_PILOT.targetRoas): Candidate[] {
  const out: Candidate[] = [];
  const F = SKU_VOLUME.fallbackMonthly;
  let index = 0;
  for (const p of SKU_TOKENS.problems) {
    for (const s of SKU_TOKENS.situations) {
      for (const c of SKU_TOKENS.criteria) {
        index += 1;
        const sv = tokenVolume(data, s.volumeTokens);
        const pv = tokenVolume(data, p.volumeTokens);
        const est = Math.max(SKU_VOLUME.min, round10(Math.sqrt((sv ?? F) * (pv ?? F)) * SKU_VOLUME.longTailFactor * c.weight));
        const phrase = `${s.phrase} ${p.phrase} 매트리스 ${c.phrase}`;
        out.push(buildCandidate(data, changes, {
          phrase, source: 'sku48', origin: `${p.label} × ${s.label} × ${c.label}`,
          volume: est, volumeKind: 'monthly_est',
          volumeNote: `데모 추정 · √(상황 ${sv ? fmt.int(sv) : `가정 ${F}`} × 문제 ${pv ? fmt.int(pv) : `가정 ${F}`}) × ${SKU_VOLUME.longTailFactor} × 비교 가중 ${c.weight}`,
          sku: { problem: p.label, situation: s.label, criterion: c.label, index, head: `${s.phrase} 매트리스 ${c.phrase}` },
        }, target));
      }
    }
  }
  return out;
}

export function skuFormula() {
  const n = { product: 1, problems: SKU_EXPANSION.problems.length, situations: SKU_EXPANSION.situations.length, criteria: SKU_EXPANSION.criteria.length };
  return { ...n, total: n.product * n.problems * n.situations * n.criteria };
}

/** AI 확장 응답 파싱 (askJson 결과) — 형식이 틀려도 예외 없이 걸러낸다 */
export function parseAiCandidates(raw: unknown, data: Dataset, changes: readonly ChangeRequest[] = []): Candidate[] {
  const arr: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { candidates?: unknown[] }).candidates) ? (raw as { candidates: unknown[] }).candidates : [];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const it of arr.slice(0, 40)) {
    const o = (typeof it === 'string' ? { phrase: it } : it) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    const phrase = String(o.phrase ?? o.keyword ?? o.term ?? '').replace(/\s+/g, ' ').trim();
    if (phrase.length < 3 || phrase.length > 40 || !/[가-힣]/.test(phrase) || seen.has(norm(phrase))) continue;
    seen.add(norm(phrase));
    const monthly = Number(o.monthly ?? o.volume);
    const est = estimatePhraseVolume(data, phrase);
    const rationale = typeof o.rationale === 'string' ? o.rationale.slice(0, 120) : '';
    out.push(buildCandidate(data, changes, {
      phrase, source: 'ai_expand', origin: rationale ? `AI: ${rationale}` : 'AI 구문형 확장',
      volume: finite(monthly) && monthly > 0 ? monthly : est.volume, volumeKind: 'monthly_est',
      volumeNote: finite(monthly) && monthly > 0 ? `AI 추정 월 ${fmt.int(monthly)} · 검증 필요` : est.note,
    }));
  }
  return out;
}

/**
 * 저장된 후보(AI 확장 등)를 현재 데이터 · 요청 이력 기준으로 다시 계산한다.
 * 저장 시점의 상태를 그대로 쓰면 등록 요청 후에도 '미등록'으로 남아 중복 요청이 생기고, 품절 · 기획전 종료 메모도 낡는다.
 */
export function refreshCandidate(data: Dataset, changes: readonly ChangeRequest[], c: Candidate | null | undefined, target: number = AD_PILOT.targetRoas): Candidate | null {
  if (!c || typeof c.phrase !== 'string' || !c.phrase.trim()) return null;
  const source: CandidateSource = (Object.keys(SOURCE_LABEL) as CandidateSource[]).includes(c.source) ? c.source : 'ai_expand';
  const kind: Candidate['volumeKind'] = c.volumeKind === 'impressions' || c.volumeKind === 'monthly_demo' ? c.volumeKind : 'monthly_est';
  return buildCandidate(data, changes, {
    phrase: c.phrase, source, origin: String(c.origin ?? SOURCE_LABEL[source]), volume: n0(c.volume), volumeKind: kind, volumeNote: String(c.volumeNote ?? ''),
    evidence: c.evidence ?? undefined, sku: c.sku,
  }, target);
}

/** 전체 후보 — 소스별 생성 → 구문 단위 중복 제거(실측 근거가 있는 소스 우선) → 우선순위순 */
export function discoverCandidates(data: Dataset, changes: readonly ChangeRequest[] = [], extra: readonly Candidate[] = [], target: number = AD_PILOT.targetRoas): { all: Candidate[]; excludedExisting: number; excludedRegistered: number } {
  const order: CandidateSource[] = ['search_term', 'related', 'ai_query', 'ai_expand', 'sku48'];
  const fresh = (extra ?? []).map((c) => refreshCandidate(data, changes, c, target)).filter((c): c is Candidate => !!c);
  const pool = [...searchTermCandidates(data, changes, target), ...relatedCandidates(data, changes, RELATED_SEEDS, target), ...aiQueryCandidates(data, changes, AI_QUERY_SEEDS, target), ...fresh, ...skuEntries(data, changes, target)];
  pool.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  const seen = new Map<string, Candidate>();
  let excludedExisting = 0;
  for (const c of pool) {
    const k = norm(c.phrase);
    if (seen.has(k)) continue;
    if (c.status === 'existing') { excludedExisting += 1; continue; }
    seen.set(k, c);
  }
  // 검색어 보고서에서 이미 등록(registered)됐거나 등록 키워드와 같은 구문 — 발굴 대상에서 빼고 파이프라인에서 판정
  const kw = new Set((data?.keywords ?? []).map((k) => norm(k.text)));
  const excludedRegistered = (data?.searchTerms ?? []).filter((t) => t && (t.registered || kw.has(norm(t.term)))).length;
  const all = [...seen.values()].sort((a, b) => b.score - a.score || b.volume - a.volume);
  return { all, excludedExisting, excludedRegistered };
}

/** 확장 판정 키워드의 연관 후보 — 같은 상황 · 문제 토픽이나 핵심 단어를 공유하는 미등록 후보 (p.26 '연관 키워드 추가 발굴') */
export function relatedCandidatesFor(phrase: string, pool: readonly Candidate[], limit = 3): Candidate[] {
  const generic = new Set(['추천', '비교', '후기', '리뷰']);
  const topics = phraseTopics(phrase).filter((t) => !generic.has(t));
  const words = String(phrase ?? '').split(/\s+/).filter((w) => w.length >= 2 && w !== '매트리스' && !generic.has(w));
  const key = norm(phrase);
  if (!key || (!topics.length && !words.length)) return [];
  return (pool ?? [])
    .filter((c) => c.status === 'new' && c.purchase && norm(c.phrase) !== key && !norm(c.phrase).includes(key)
      && (topics.some((t) => phraseTopics(c.phrase).includes(t)) || words.some((w) => c.phrase.includes(w))))
    .sort((a, b) => b.score - a.score || b.volume - a.volume)
    .slice(0, Math.max(0, limit));
}

/** 등록 요청 페이로드 (pending ChangeRequest로만 생성 — 실제 등록은 승인 후) */
export function registrationPayload(c: Candidate, requestedBy: string, batchSize = 1) {
  return {
    module: 'lab', kind: 'keyword_add' as ChangeKind, target: c.phrase, targetId: `labreg:${norm(c.phrase)}`,
    before: '미등록', after: `${c.intent.toUpperCase()}_TEST · 입찰 상한 ${fmt.won(c.bidCap)}`,
    reason: `${SOURCE_LABEL[c.source]} · 우선순위 ${c.score}점(${TIER_META[c.tier].label}) · 의도 ${INTENT_NAME(c.intent)} · 랜딩 ${c.landing.label}(${LANDING_LEVEL_META[c.landing.level].label})${c.flags.length ? ` · ${c.flags[0]}` : ''}`,
    requestedBy, approver: (batchSize >= LAB_BULK.pmFrom ? 'PM' : 'AE') as ApprovalLevel,
  };
}

export function bulkCheck(n: number): { level: 'ok' | 'warn' | 'block'; approver: ApprovalLevel; reason: string } {
  if (n > LAB_BULK.max) return { level: 'block', approver: 'PM', reason: `한 번에 ${LAB_BULK.max}건 초과 (${n}건) — 대량 변경 방지 기준(p.45 준용)으로 차단, 나눠서 요청` };
  if (n >= LAB_BULK.pmFrom) return { level: 'warn', approver: 'PM', reason: `${n}건 일괄 — ${LAB_BULK.pmFrom}건 이상은 PM 승인으로 상향` };
  return { level: 'ok', approver: 'AE', reason: `${n}건 — 담당 AE 승인 범위` };
}

/* ================================================================== */
/* 키워드 테스트 판정 (p.26 STEP 1~4)                                    */
/* ================================================================== */

export interface LabCriteria { targetRoas: number; expandAtPct: number; keepFromPct: number; minDays: number; minClicks: number; minJudgeClicks: number }

export function resolveCriteria(c?: Partial<LabCriteria> | null): LabCriteria {
  const d = LAB_DEFAULT_CRITERIA;
  const pos = (v: unknown, def: number) => (finite(v) && v > 0 ? v : def);
  const out: LabCriteria = {
    targetRoas: pos(c?.targetRoas, d.targetRoas),
    expandAtPct: pos(c?.expandAtPct, d.expandAtPct),
    keepFromPct: pos(c?.keepFromPct, d.keepFromPct),
    minDays: Math.round(pos(c?.minDays, d.minDays)),
    minClicks: Math.round(pos(c?.minClicks, d.minClicks)),
    minJudgeClicks: Math.round(pos(c?.minJudgeClicks, d.minJudgeClicks)),
  };
  if (out.keepFromPct >= out.expandAtPct) out.keepFromPct = Math.max(1, out.expandAtPct - 1);
  if (out.minJudgeClicks > out.minClicks) out.minJudgeClicks = out.minClicks;
  return out;
}

export type KwVerdict = 'running' | 'insufficient' | 'expand' | 'keep' | 'exclude';
export const KW_VERDICT_META: Record<KwVerdict, { label: string; tone: 'neutral' | 'outline' | 'good' | 'warning' | 'serious'; icon: string; action: string }> = {
  running: { label: '집행 중', tone: 'neutral', icon: 'clock', action: '14일 또는 최소 클릭 도달까지 집행' },
  insufficient: { label: '판정 보류 · 표본 부족', tone: 'outline', icon: 'pause', action: '연장 · 입찰 상한 내 상향 · 그룹 합산 판정' },
  expand: { label: '확장', tone: 'good', icon: 'up', action: '본 그룹 이관 · 연관 키워드 추가 발굴' },
  keep: { label: '유지', tone: 'warning', icon: 'refresh', action: '입찰 · 랜딩 조정 후 재테스트' },
  exclude: { label: '제외', tone: 'serious', icon: 'x', action: '제외 키워드 등록 · 사유 기록' },
};

export interface KwJudgement {
  verdict: KwVerdict;
  ready: boolean;
  readyBy: 'days' | 'clicks' | null;
  days: number | null;
  stats: Stats;
  ctr: number; cvr: number; cpc: number; roas: number; ratioPct: number; target: number;
  progressDays: number | null;
  progressClicks: number;
  badge: string;
  basis: string;
  action: string;
  cautions: string[];
}

export function judgeKeywordTest(
  s: Partial<Stats> | null | undefined, days: number | null, cIn?: Partial<LabCriteria> | null,
  extra?: { monthlySearch?: number; maxBid?: number; bid?: number; isBrand?: boolean },
): KwJudgement {
  const c = resolveCriteria(cIn);
  const stats = sumStats([s ?? {}]);
  const target = extra?.isBrand ? AD_PILOT.brandTargetRoas : c.targetRoas;
  const roas = roasOf(stats);
  const ratioPct = finite(roas) ? (roas / target) * 100 : NaN;
  const d = finite(days) ? Math.max(0, days) : null;
  const readyDays = d !== null && d >= c.minDays;
  const readyClicks = stats.clicks >= c.minClicks;
  const ready = readyDays || readyClicks;
  const cautions: string[] = [];
  let verdict: KwVerdict;
  let badge: string;
  let basis: string;
  let action: string;
  const progressTxt = `${d === null ? '일자 정보 없음' : `${d}/${c.minDays}일`} · 클릭 ${fmt.int(stats.clicks)}/${c.minClicks}`;
  if (!ready) {
    verdict = 'running';
    badge = `집행 중 · ${progressTxt}`;
    basis = `STEP 2 — ${c.minDays}일 또는 클릭 ${c.minClicks}회 도달 전 (${progressTxt})`;
    action = `${c.minDays}일 또는 클릭 ${c.minClicks}회 도달까지 집행 · 입찰 변경 없음`;
  } else if (stats.clicks < c.minJudgeClicks) {
    verdict = 'insufficient';
    badge = `판정 보류 · 표본 부족 (클릭 ${fmt.int(stats.clicks)} < ${c.minJudgeClicks})`;
    basis = `${readyDays ? `${d}일 경과` : '클릭 기준 도달'}했지만 클릭 ${fmt.int(stats.clicks)}회 · 전환 ${fmt.dec1(stats.conversions)}건 — 판정 최소 클릭 ${c.minJudgeClicks}회 미달`;
    const perDay = d && d > 0 ? stats.clicks / d : NaN;
    const need = finite(perDay) && perDay > 0 ? Math.ceil((c.minClicks - stats.clicks) / perDay) : Infinity;
    if (!finite(need) || need > 28) {
      action = `볼륨 한계 — 일 평균 클릭 ${finite(perDay) ? fmt.dec1(perDay) : '0'}회로 최소 클릭 ${c.minClicks}회까지 28일 이상 필요${extra?.monthlySearch ? ` (월 검색량 ${fmt.int(extra.monthlySearch)})` : ''}: 같은 의도 TEST 그룹 합산 판정 또는 상위 구문으로 통합, 미달 시 볼륨 한계 사유로 제외`;
    } else {
      action = `${need}일 연장 또는 입찰 상한${extra?.maxBid ? ` ${fmt.won(extra.maxBid)}` : ''} 내 상향 후 재판정`;
    }
    if (stats.clicks === 0 && stats.impressions > 0) cautions.push(`노출 ${fmt.int(stats.impressions)} · 클릭 0 — 순위 · 문안 점검`);
  } else if (stats.conversions <= 0) {
    verdict = 'exclude';
    badge = `제외 · 전환 없음 (클릭 ${fmt.int(stats.clicks)})`;
    basis = `클릭 ${fmt.int(stats.clicks)}회 · 전환 0 — 제외 기준 "전환 없음" (p.26)`;
    action = KW_VERDICT_META.exclude.action;
  } else if (!finite(ratioPct)) {
    // 전환은 있는데 광고비가 0 · 누락 — ROAS를 계산할 수 없으므로 제외로 단정하지 않는다
    verdict = 'insufficient';
    badge = '판정 보류 · 광고비 데이터 없음';
    basis = `클릭 ${fmt.int(stats.clicks)}회 · 전환 ${fmt.dec1(stats.conversions)}건 · 광고비 ${fmt.won(stats.cost)} — ROAS 계산 불가`;
    action = '광고비 수집(07:00 검증) 확인 후 재판정';
  } else if (ratioPct >= c.expandAtPct) {
    verdict = 'expand';
    badge = `확장 · 목표 ROAS ${fmt.int(target)}% 대비 ${pct0(ratioPct)}`;
    basis = `ROAS ${fmt.roas(roas)} ≥ 목표의 ${c.expandAtPct}% · CTR ${fmt.pct(ctrOf(stats), 2)} · CVR ${fmt.pct(cvrOf(stats), 2)} · 클릭 ${fmt.int(stats.clicks)}`;
    action = KW_VERDICT_META.expand.action;
  } else if (ratioPct >= c.keepFromPct) {
    verdict = 'keep';
    badge = `유지 · 목표 대비 ${pct0(ratioPct)} (기준 ${c.keepFromPct}~${c.expandAtPct}%)`;
    basis = `ROAS ${fmt.roas(roas)} · 목표 ROAS ${fmt.int(target)}%의 ${pct0(ratioPct)} · CVR ${fmt.pct(cvrOf(stats), 2)}`;
    action = KW_VERDICT_META.keep.action;
  } else {
    verdict = 'exclude';
    badge = `제외 · 목표 대비 ${pct0(ratioPct)} (기준 < ${c.keepFromPct}%)`;
    basis = `ROAS ${fmt.roas(roas)} · 목표 ROAS ${fmt.int(target)}%의 ${pct0(ratioPct)} — 제외 기준 미만`;
    action = KW_VERDICT_META.exclude.action;
  }
  if ((verdict === 'expand' || verdict === 'keep') && stats.conversions < AD_PILOT.minConversionsForDown) {
    cautions.push(`전환 ${fmt.dec1(stats.conversions)}건 < ${AD_PILOT.minConversionsForDown}건 — 소수 전환에 ROAS가 좌우됨 · 2주 랩업에서 재확인`);
  }
  if (extra?.isBrand) cautions.push(`브랜드 키워드 — 브랜드 목표 ROAS ${AD_PILOT.brandTargetRoas}% 기준`);
  return {
    verdict, ready, readyBy: readyDays ? 'days' : readyClicks ? 'clicks' : null, days: d, stats,
    ctr: ctrOf(stats), cvr: cvrOf(stats), cpc: cpcOf(stats), roas, ratioPct, target,
    progressDays: d === null ? null : clamp(d / c.minDays, 0, 1), progressClicks: clamp(stats.clicks / c.minClicks, 0, 1),
    badge, basis, action, cautions,
  };
}

/** 데이터 키워드의 테스트 시작 추정 — 직전 14일에 노출이 있으면 28일 누적, 없으면 최근 14일 중 첫 노출일부터 */
/** 판정 기한 유예 — 기간 기준을 넘긴 뒤 1주(주간 리포트 1회분) 안에 판정 · 조치가 없으면 기한 경과 (모듈 가정) */
export const OVERDUE_GRACE_DAYS = 7;

export function inferTestStart(data: Dataset, k: Keyword, cIn?: Partial<LabCriteria> | null): { start: string | null; days: number; stats: Stats; isNew: boolean; overdue: boolean; basis: string } {
  const daily = Array.isArray(k?.daily) ? k.daily : [];
  const end = addDays(data.today, -1);
  const len = daily.length;
  const winStart = addDays(end, -(Math.max(1, len) - 1));
  const crit = resolveCriteria(cIn);
  if (n0(k?.prev14?.impressions) > 0) {
    const days = len + 14;
    return {
      start: addDays(winStart, -14), days, stats: sumStats([k.prev14, k.last14]), isNew: false, overdue: days > crit.minDays + OVERDUE_GRACE_DAYS,
      basis: `직전 14일부터 집행 — ${days}일 누적 (판정 기준 ${crit.minDays}일${days >= crit.minDays ? ' 경과' : ''})`,
    };
  }
  const i = daily.findIndex((x) => n0(x?.impressions) > 0);
  if (i < 0) return { start: null, days: 0, stats: sumStats(daily), isNew: true, overdue: false, basis: '최근 14일 노출 없음 — 집행 확인 필요' };
  const days = len - i;
  return { start: addDays(winStart, i), days, stats: sumStats(daily.slice(i)), isNew: true, overdue: days > crit.minDays + OVERDUE_GRACE_DAYS, basis: `${fmtDate(addDays(winStart, i))} 첫 노출 — 신규 ${days}일 집행` };
}

export interface PipelineItem {
  id: string;
  phrase: string;
  source: 'keyword' | 'search_term' | 'request';
  sourceLabel: string;
  intent: IntentId;
  adgroup: string;
  step: 1 | 2 | 3 | 4;
  start: string | null;
  days: number | null;
  isNew: boolean;
  overdue: boolean;
  judgement: KwJudgement;
  registration?: ChangeRequest;
  decision?: ChangeRequest;
  keywordId?: string;
  bid?: number;
  maxBid?: number;
  landing: string;
  notes: string[];
}

export function latestByTargetId(changes: readonly ChangeRequest[], targetId: string): ChangeRequest | undefined {
  return [...(changes ?? [])].filter((c) => c.targetId === targetId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}
const stepOf = (v: KwVerdict): 1 | 2 | 3 | 4 => (v === 'running' ? 2 : v === 'insufficient' ? 3 : 4);

export function buildPipeline(data: Dataset, changes: readonly ChangeRequest[] = [], cIn?: Partial<LabCriteria> | null): PipelineItem[] {
  const crit = resolveCriteria(cIn);
  const items: PipelineItem[] = [];
  const taken = new Set<string>();
  // 품절 옵션이 들어간 구문 — 본 그룹 이관 · 재테스트 전에 랜딩 재고를 확인해야 한다 (p.45 품절 랜딩, 상품 데이터 대조)
  const soldNotes = (phrase: string) => soldOutOptions(data).filter((so) => norm(phrase).includes(norm(so.label))).map((so) => `${so.label} 옵션 품절 — 랜딩에서 구매 불가 (${so.product.name}) · 이관 전 랜딩 · 문안 교체`);
  for (const k of data?.keywords ?? []) {
    if (k.status !== 'test') continue;
    const st = inferTestStart(data, k, crit);
    const j = judgeKeywordTest(st.stats, st.days, crit, { monthlySearch: k.monthlySearch, maxBid: k.maxBid, bid: k.bid, isBrand: k.isBrand });
    const id = `kw:${k.id}`;
    const decision = latestByTargetId(changes, `labdec:${id}`);
    // 판정 · 보류 조치를 이미 요청했으면 기한 경과로 세지 않는다
    const overdue = st.overdue && !(decision && isActiveStatus(decision.status));
    const notes = [st.basis, ...soldNotes(k.text)];
    if (overdue) notes.push(`판정 기한 경과 — ${st.days}일 집행 (기준 ${crit.minDays}일 + 유예 ${OVERDUE_GRACE_DAYS}일)`);
    items.push({
      id, phrase: k.text, source: 'keyword', sourceLabel: st.isNew ? '테스트 그룹 · 신규' : '테스트 그룹 키워드', intent: k.intent, adgroup: k.adgroup,
      step: stepOf(j.verdict), start: st.start, days: st.days, isNew: st.isNew, overdue, judgement: j, decision,
      keywordId: k.id, bid: k.bid, maxBid: k.maxBid, landing: k.landing, notes,
    });
    taken.add(norm(k.text));
  }
  for (const t of data?.searchTerms ?? []) {
    if (!t.registered || taken.has(norm(t.term))) continue;
    const ci = classifyIntent(t.term);
    const j = judgeKeywordTest(t, null, crit, { isBrand: ci.intent === 'brand' });
    const id = `st:${norm(t.term)}`;
    items.push({
      id, phrase: t.term, source: 'search_term', sourceLabel: '검색어 보고서 등록 구문', intent: ci.intent, adgroup: `${ci.intent.toUpperCase()}_TEST`,
      step: stepOf(j.verdict), start: null, days: null, isNew: false, overdue: false, judgement: j, decision: latestByTargetId(changes, `labdec:${id}`),
      landing: landingFor(data, t.term, ci.intent).url, notes: ['검색어 보고서 누적 · 일자별 데이터 미연동 — 클릭 기준으로만 판정', ...soldNotes(t.term)],
    });
    taken.add(norm(t.term));
  }
  const regs = [...(changes ?? [])].filter((c) => isRegistration(c) && isActiveStatus(c.status)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const c of regs) {
    const key = norm(c.target);
    if (taken.has(key)) continue;
    taken.add(key);
    const ci = classifyIntent(c.target);
    const approved = c.status === 'approved' || c.status === 'applied';
    const j = judgeKeywordTest(EMPTY_STATS, 0, crit);
    items.push({
      id: `req:${c.id}`, phrase: c.target, source: 'request', sourceLabel: c.module === 'lab' ? 'Lab 등록 요청' : `${SOURCE_MODULE_LABEL[c.module] ?? c.module} ${c.module === 'adpilot' ? '후보' : '테스트 요청'}`,
      intent: ci.intent, adgroup: `${ci.intent.toUpperCase()}_TEST`, step: approved ? 2 : 1, start: null, days: approved ? 0 : null, isNew: true, overdue: false,
      judgement: approved ? { ...j, badge: '집행 대기 · Day 0 · 데이터 수집 전', basis: `${c.status === 'applied' ? '테스트 그룹 반영' : '승인 완료 · 반영 대기'} — 익일 07:00 수집부터 집계` } : { ...j, badge: `STEP 1 · ${APPROVER_LABEL[c.approver]} 승인 대기`, basis: c.reason },
      registration: c, landing: landingFor(data, c.target, ci.intent).url, notes: [String(c.after), ...soldNotes(c.target)],
    });
  }
  return items;
}

/** STEP 4 판정 반영 요청 페이로드 */
export function decisionPayload(item: PipelineItem, requestedBy: string) {
  const j = item.judgement;
  const stock = (item.notes ?? []).filter((n) => n.includes('품절'));
  const base = { module: 'lab', target: item.phrase, targetId: `labdec:${item.id}`, requestedBy, reason: `${j.badge} — ${j.basis}${[...j.cautions, ...stock].length ? ` · ${[...j.cautions, ...stock].join(' · ')}` : ''}` };
  if (j.verdict === 'expand') return { ...base, kind: 'keyword_add' as ChangeKind, before: `${item.adgroup} (테스트 그룹)`, after: `${item.intent.toUpperCase()}_MAIN 이관 · 연관 키워드 추가 발굴`, approver: 'PM' as ApprovalLevel };
  if (j.verdict === 'keep') return { ...base, kind: 'setting' as ChangeKind, before: '테스트 판정: 유지', after: '입찰 · 랜딩 조정 후 재테스트 (14일)', approver: 'AE' as ApprovalLevel };
  if (j.verdict === 'exclude') return { ...base, kind: 'keyword_exclude' as ChangeKind, before: item.adgroup, after: '제외 키워드 등록 · 사유 기록', approver: 'AE' as ApprovalLevel };
  return { ...base, kind: 'setting' as ChangeKind, before: '판정 보류 · 표본 부족', after: j.action.slice(0, 80), approver: 'AE' as ApprovalLevel };
}

export function pipelineSummary(items: readonly PipelineItem[]) {
  const byStep = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<1 | 2 | 3 | 4, number>;
  const byVerdict: Record<KwVerdict, number> = { running: 0, insufficient: 0, expand: 0, keep: 0, exclude: 0 };
  for (const i of items) {
    byStep[i.step] += 1;
    if (i.source !== 'request' || i.step === 2) byVerdict[i.judgement.verdict] += 1;
  }
  return {
    byStep, byVerdict, total: items.length,
    overdue: items.filter((i) => i.overdue).length,
    awaitingDecision: items.filter((i) => i.step === 4 && (!i.decision || !isActiveStatus(i.decision.status))).length,
  };
}

/** 같은 테스트 그룹의 판정 보류 항목 합산 판정 (롱테일 볼륨 한계 대응) */
export function groupPools(items: readonly PipelineItem[], cIn?: Partial<LabCriteria> | null) {
  const groups = new Map<string, PipelineItem[]>();
  for (const i of items) if (i.judgement.verdict === 'insufficient') groups.set(i.adgroup, [...(groups.get(i.adgroup) ?? []), i]);
  return [...groups.entries()].filter(([, v]) => v.length >= 2).map(([adgroup, v]) => {
    const stats = sumStats(v.map((x) => x.judgement.stats));
    const days = Math.max(...v.map((x) => n0(x.days)));
    return { adgroup, count: v.length, phrases: v.map((x) => x.phrase), stats, judgement: judgeKeywordTest(stats, days, cIn) };
  });
}

/* ================================================================== */
/* 테스트 카드 (p.28) · 두 비율 z-검정                                   */
/* ================================================================== */

export type CardVariable = '메시지' | '랜딩' | '타겟';
export type CardMetric = 'ctr' | 'cvr';
export interface CardDay { impressions: number; clicks: number; conversions: number; cost: number; revenue: number }
export interface TestCard {
  id: string;
  title: string;
  hypothesis: string;
  variable: CardVariable;
  media: string;
  intent: IntentId | null;
  control: string;
  variant: string;
  copyControl?: string;
  copyVariant?: string;
  primary: CardMetric;
  metricsLabel: string;
  start: string;
  plannedDays: number;
  minClicksPerArm: number | null;
  stopDay: number;
  stopDropPct: number;
  expandLiftPct: number;
  expandScope: string;
  source: 'demo' | 'user';
  dailyC: CardDay[];
  dailyV: CardDay[];
  createdBy?: string;
}
export interface CardDecision { verdict: 'expand' | 'stop' | 'monitor'; at: string; by: string; note: string; changeId?: string }
export interface Wrapup { at: string; outcome: 'expand' | 'stop' | 'monitor'; result: string; learnings: string; addedToLibrary: boolean }
export interface Pattern { id: string; title: string; scope: string; metric: string; lift: number; p: number | null; period: string; applied: string; condition: string; counter: string; source: 'demo' | 'user' }

export type CardVerdict = 'planned' | 'running' | 'stop' | 'expand' | 'monitor' | 'insufficient';
export const CARD_VERDICT_META: Record<CardVerdict, { label: string; tone: 'neutral' | 'outline' | 'good' | 'warning' | 'serious' | 'critical'; icon: string }> = {
  planned: { label: '집행 전', tone: 'outline', icon: 'calendar' },
  running: { label: '진행 중', tone: 'neutral', icon: 'clock' },
  stop: { label: '중단', tone: 'critical', icon: 'stop' },
  expand: { label: '확대', tone: 'good', icon: 'up' },
  monitor: { label: '모니터링 지속', tone: 'warning', icon: 'watch' },
  insufficient: { label: '판정 보류 · 표본 부족', tone: 'outline', icon: 'pause' },
};

/** 역정규분포 (Acklam 근사) */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 기준 비율 p1에서 상대 효과 liftPct를 검출하는 데 필요한 군당 표본 (양측 α, 검정력) */
export function requiredSamplePerArm(p1: number, liftPct: number, alpha = CARD_RULES.alpha, power = CARD_RULES.power): number {
  if (!(finite(p1) && p1 > 0 && p1 < 1) || !(finite(liftPct) && liftPct !== 0)) return NaN;
  const p2 = p1 * (1 + liftPct / 100);
  if (!(p2 > 0 && p2 < 1)) return NaN;
  const za = normInv(1 - alpha / 2);
  const zb = normInv(power);
  const pbar = (p1 + p2) / 2;
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return finite(n) ? Math.ceil(n) : NaN;
}

export interface ArmStats extends Stats { ctr: number; cvr: number; cpa: number; roas: number }
function arm(rows: readonly CardDay[]): ArmStats {
  const s = sumStats(rows);
  return { ...s, ctr: ctrOf(s), cvr: cvrOf(s), cpa: cpaOf(s), roas: roasOf(s) };
}
export interface MetricCheck { metric: 'ctr' | 'cvr' | 'cpa' | 'roas'; label: string; c: number; v: number; lift: number; p: number | null; status: 'win' | 'lose' | 'tie' | 'na'; note: string }
export interface CardJudgement {
  verdict: CardVerdict;
  elapsed: number;
  dataDays: number;
  C: ArmStats;
  V: ArmStats;
  liftCvr: number; liftCtr: number;
  pCvr: number; pCtr: number;
  primaryLift: number; primaryP: number;
  required: number; have: number; sampleOk: boolean;
  checks: MetricCheck[];
  badge: string;
  basis: string;
  action: string;
  stopCheck: { evaluated: boolean; triggered: boolean; note: string };
  endDate: string;
}

export function judgeTestCard(card: TestCard, today: string, rules: Partial<typeof CARD_RULES> = {}): CardJudgement {
  const R = { ...CARD_RULES, ...rules };
  const elapsed = Math.max(0, n0(daysBetween(card.start, today)));
  const dataDays = Math.min(card.dailyC?.length ?? 0, card.dailyV?.length ?? 0, elapsed);
  const C = arm((card.dailyC ?? []).slice(0, dataDays));
  const V = arm((card.dailyV ?? []).slice(0, dataDays));
  const zCvr = twoProportionZ(Math.round(C.conversions), C.clicks, Math.round(V.conversions), V.clicks);
  const zCtr = twoProportionZ(C.clicks, C.impressions, V.clicks, V.impressions);
  const liftCvr = liftOf(V.cvr, C.cvr);
  const liftCtr = liftOf(V.ctr, C.ctr);
  const primaryLift = card.primary === 'ctr' ? liftCtr : liftCvr;
  const primaryP = card.primary === 'ctr' ? zCtr.p : zCvr.p;
  const base = (card.primary === 'ctr' ? C.ctr : C.cvr) / 100;
  const required = requiredSamplePerArm(base, n0(card.expandLiftPct) || R.expandCvrLiftPct, R.alpha, R.power);
  const have = card.primary === 'ctr' ? Math.min(C.impressions, V.impressions) : Math.min(C.clicks, V.clicks);
  const denomLabel = card.primary === 'ctr' ? '노출' : '클릭';
  const sampleOk = finite(required) && have >= required;
  const plannedDays = n0(card.plannedDays) || R.days;
  const endDate = addDays(card.start, plannedDays);
  const pctLabel = card.primary === 'ctr' ? 'CTR' : 'CVR';

  const dirStatus = (lift: number, lowerIsBetter: boolean): MetricCheck['status'] => {
    if (!finite(lift)) return 'na';
    const good = lowerIsBetter ? lift <= -R.directionalPct : lift >= R.directionalPct;
    const bad = lowerIsBetter ? lift >= R.directionalPct : lift <= -R.directionalPct;
    return good ? 'win' : bad ? 'lose' : 'tie';
  };
  const sigStatus = (lift: number, p: number): MetricCheck['status'] => (!finite(lift) || !finite(p) ? 'na' : p < R.alpha ? (lift > 0 ? 'win' : 'lose') : 'tie');
  const checks: MetricCheck[] = [
    { metric: 'ctr', label: 'CTR', c: C.ctr, v: V.ctr, lift: liftCtr, p: finite(zCtr.p) ? zCtr.p : null, status: sigStatus(liftCtr, zCtr.p), note: `두 비율 z-검정 ${pText(zCtr.p)}` },
    { metric: 'cvr', label: 'CVR', c: C.cvr, v: V.cvr, lift: liftCvr, p: finite(zCvr.p) ? zCvr.p : null, status: sigStatus(liftCvr, zCvr.p), note: `두 비율 z-검정 ${pText(zCvr.p)} · 전환 ${fmt.int(C.conversions)} vs ${fmt.int(V.conversions)}` },
    { metric: 'cpa', label: 'CPA', c: C.cpa, v: V.cpa, lift: liftOf(V.cpa, C.cpa), p: null, status: dirStatus(liftOf(V.cpa, C.cpa), true), note: `비율 지표 — ±${R.directionalPct}% 이상만 방향 표기` },
    { metric: 'roas', label: 'ROAS', c: C.roas, v: V.roas, lift: liftOf(V.roas, C.roas), p: null, status: dirStatus(liftOf(V.roas, C.roas), false), note: `비율 지표 — ±${R.directionalPct}% 이상만 방향 표기` },
  ];

  // 중단 기준 (p.28): 7일 차 전환율 기존 대비 −30% — 기존안 최소 전환 확보 시에만 평가
  const stopEval = dataDays >= n0(card.stopDay || R.stopDay) && C.conversions >= R.stopMinConversions;
  const stopTriggered = stopEval && finite(liftCvr) && liftCvr <= -(n0(card.stopDropPct) || R.stopCvrDropPct);
  const stopCheck = {
    evaluated: stopEval,
    triggered: stopTriggered,
    note: dataDays < n0(card.stopDay || R.stopDay)
      ? `${card.stopDay}일 차 중단 점검 전 (${dataDays}일 경과)`
      : C.conversions < R.stopMinConversions
        ? `기존안 전환 ${fmt.int(C.conversions)}건 < ${R.stopMinConversions}건 — 중단 판정 보류`
        : `CVR ${sg(liftCvr, 0)} (중단 기준 −${card.stopDropPct}%)`,
  };

  let verdict: CardVerdict;
  let badge: string;
  let basis: string;
  let action: string;
  const reqTxt = finite(required) ? `필요 군당 ${denomLabel} ${fmt.int(required)}` : '필요 표본 계산 불가';
  if (dataDays <= 0) {
    verdict = 'planned';
    badge = `집행 전 · 시작 ${fmtDate(card.start)}`;
    basis = `${plannedDays}일 또는 최소 표본 · 중단 ${card.stopDay}일 차 CVR −${card.stopDropPct}% · 확대 ${pctLabel} +${card.expandLiftPct}%`;
    action = '승인 후 동일 타겟 · 유사 예산으로 집행 시작';
  } else if (stopTriggered) {
    verdict = 'stop';
    badge = `중단 · ${dataDays}일 차 CVR ${sg(liftCvr, 0)} (기준 −${card.stopDropPct}%)`;
    basis = `CVR ${fmt.pct(C.cvr, 2)} → ${fmt.pct(V.cvr, 2)} · ${pText(zCvr.p)}${finite(zCvr.p) && zCvr.p >= R.alpha ? ' — 유의성 미확보 상태의 손실 방지 중단' : ' — 열위 유의'}`;
    action = '변형안 집행 중단 · 기존안 복귀 · 2주 후 랩업에 원인 기록';
  } else if (dataDays < plannedDays && !(card.minClicksPerArm && Math.min(C.clicks, V.clicks) >= card.minClicksPerArm)) {
    verdict = 'running';
    badge = `진행 중 · ${dataDays}/${plannedDays}일 · 중간 ${pctLabel} ${sg(primaryLift, 0)}`;
    basis = `중간 결과 ${pText(primaryP)} · ${reqTxt} (현재 ${fmt.int(have)}) — 기간 종료 전 확대 판정 안 함`;
    action = `${fmtDate(endDate)} 종료 후 ${card.primary === 'ctr' ? 'CTR → CVR → CPA → ROAS 순' : 'CVR · ROAS'} 판정`;
  } else if (finite(primaryP) && primaryP < R.alpha && primaryLift >= n0(card.expandLiftPct)) {
    const later = checks.slice(card.primary === 'ctr' ? 1 : 2).find((x) => x.status === 'lose');
    if (later) {
      verdict = 'monitor';
      badge = `모니터링 지속 · ${pctLabel} ${sg(primaryLift, 0)} 우세 · ${later.label} 열위`;
      basis = `판정 순서 CTR → CVR → CPA → ROAS — ${later.label} ${sg(later.lift, 0)} (${later.note})`;
      action = '확대 보류 · 후속 지표 열위 원인(클릭 품질 · 랜딩) 분리 테스트';
    } else {
      verdict = 'expand';
      badge = `확대 · ${pctLabel} ${sg(primaryLift, 0)} (기준 +${card.expandLiftPct}%) · ${pText(primaryP)}`;
      basis = `${pctLabel} ${fmt.pct(card.primary === 'ctr' ? C.ctr : C.cvr, 2)} → ${fmt.pct(card.primary === 'ctr' ? V.ctr : V.cvr, 2)} · ${dataDays}일 · 군당 ${denomLabel} ${fmt.int(have)}`;
      action = card.expandScope || '같은 의도 그룹 전체 적용';
    }
  } else if (finite(primaryP) && primaryP < R.alpha && primaryLift > 0) {
    verdict = 'monitor';
    badge = `모니터링 지속 · ${pctLabel} ${sg(primaryLift, 0)} (확대 기준 +${card.expandLiftPct}% 미달)`;
    basis = `효과는 유의(${pText(primaryP)})하지만 확대 기준 미달`;
    action = '부분 적용 검토 · 다음 가설로 효과 크기 확대 시도';
  } else if (finite(primaryP) && primaryP < R.alpha && primaryLift < 0) {
    verdict = 'stop';
    badge = `중단 · ${pctLabel} ${sg(primaryLift, 0)} 열위 · ${pText(primaryP)}`;
    basis = `기간 종료 · 변형안 열위 유의`;
    action = '기존안 유지 · 랩업에 실패 패턴 기록';
  } else if (!sampleOk) {
    verdict = 'insufficient';
    badge = `판정 보류 · 표본 부족 (군당 ${denomLabel} ${fmt.int(have)} / ${finite(required) ? fmt.int(required) : '—'})`;
    basis = `${pctLabel} ${sg(primaryLift, 0)} · ${pText(primaryP)} — +${card.expandLiftPct}% 효과 검출에 ${reqTxt}`;
    action = '기간 연장 또는 같은 의도 그룹으로 범위 확대 후 재판정';
  } else {
    verdict = 'monitor';
    badge = `모니터링 지속 · 차이 없음 (${pText(primaryP)})`;
    basis = `표본 충분(군당 ${denomLabel} ${fmt.int(have)}) · ${pctLabel} ${sg(primaryLift, 0)}`;
    action = '기존안 유지 · 변수 교체 후 재테스트';
  }
  return { verdict, elapsed, dataDays, C, V, liftCvr, liftCtr, pCvr: zCvr.p, pCtr: zCtr.p, primaryLift, primaryP, required, have, sampleOk, checks, badge, basis, action, stopCheck, endDate };
}

/** 누적 지표 일자별 (차트용) */
export function cumulativeSeries(card: TestCard, metric: CardMetric, days?: number): { c: number[]; v: number[] } {
  const n = Math.min(card.dailyC?.length ?? 0, card.dailyV?.length ?? 0, days ?? Infinity);
  const c: number[] = [];
  const v: number[] = [];
  for (let i = 1; i <= n; i++) {
    const a = sumStats(card.dailyC.slice(0, i));
    const b = sumStats(card.dailyV.slice(0, i));
    c.push(metric === 'ctr' ? ctrOf(a) : cvrOf(a));
    v.push(metric === 'ctr' ? ctrOf(b) : cvrOf(b));
  }
  return { c, v };
}

/** 사용자 카드 id — 기존 카드 · 요청 이력(labcard:)과 겹치지 않는 가장 작은 번호 (Lab 기록 초기화 후에도 이력과 섞이지 않게) */
export function nextUserCardId(cards: readonly Pick<TestCard, 'id'>[] = [], changes: readonly Pick<ChangeRequest, 'targetId'>[] = []): string {
  const used = new Set<string>((cards ?? []).map((c) => c.id));
  for (const ch of changes ?? []) {
    const m = String(ch?.targetId ?? '').match(/^labcard:([^:]+)/);
    if (m) used.add(m[1]);
  }
  for (let n = 1; n < 1000; n++) {
    const id = `TC-U${String(n).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  return `TC-U${used.size + 1}`;
}

export function wrapupDue(decision: CardDecision | undefined): string | null {
  return decision?.at ? addDays(decision.at, CARD_RULES.wrapupDays) : null;
}

/** 테스트 카드 생성 입력 검증 (p.27 한 번에 한 변수 · 동일 타겟 · 유사 예산) */
export function validateCardInput(i: { title: string; hypothesis: string; variable: string; control: string; variant: string; sameTarget: boolean; budgetGapPct: number; start: string; today: string }): string[] {
  const e: string[] = [];
  if (!i.title?.trim()) e.push('카드 제목을 입력하세요');
  if (!i.hypothesis?.trim() || i.hypothesis.trim().length < 10) e.push('가설은 "~하면 ~가 오른다" 형태로 10자 이상 입력하세요');
  if (!['메시지', '랜딩', '타겟'].includes(i.variable)) e.push('변수는 메시지 / 랜딩 / 타겟 중 하나만 선택합니다');
  if (!i.control?.trim() || !i.variant?.trim()) e.push('기존안과 변형안을 모두 입력하세요');
  else if (norm(i.control) === norm(i.variant)) e.push('기존안과 변형안이 같습니다');
  if (!i.sameTarget) e.push('동일 타겟 조건을 확인하세요 (p.27)');
  if (!finite(i.budgetGapPct) || Math.abs(i.budgetGapPct) > 10) e.push('두 안의 예산 차이는 ±10% 이내여야 합니다 (유사 예산)');
  if (i.start && i.today && i.start < i.today) e.push('시작일은 데이터 기준일 이후여야 합니다');
  return e;
}

/* ================================================================== */
/* SA 광고 문안 생성 (VisualTune · p.27 × p.35)                         */
/* ================================================================== */

export function charLen(s: string): number {
  return Array.from(String(s ?? '')).length;
}
export interface AdCopy { id: string; campaign: IntentId; hypothesis: HypId; title: string; description: string; source: 'rule' | 'ai'; titleLen: number; descLen: number; titleOk: boolean; descOk: boolean }
export function makeCopy(campaign: IntentId, hypothesis: HypId, title: string, description: string, source: AdCopy['source'], idx: number): AdCopy {
  const t = String(title ?? '').trim();
  const d = String(description ?? '').trim();
  return {
    id: `${source}:${campaign}:${hypothesis}:${idx}:${norm(t).slice(0, 12)}`, campaign, hypothesis, title: t, description: d, source,
    titleLen: charLen(t), descLen: charLen(d), titleOk: charLen(t) > 0 && charLen(t) <= SA_CHAR_LIMITS.title, descOk: charLen(d) > 0 && charLen(d) <= SA_CHAR_LIMITS.description,
  };
}

const md = (s: string) => { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}`; };

/** 규칙 기반 문안 — 캠페인 핵심어 · p.35 메시지 · 진행 중 프로모션(데이터)으로 조합 */
export function generateSaCopies(data: Dataset, campaign: IntentId, hyp: HypId): AdCopy[] {
  const head = COPY_HEADS[campaign] ?? '매트리스';
  const msg = SA_CAMPAIGNS[campaign]?.message ?? '';
  const landing = SA_CAMPAIGNS[campaign]?.landing ?? '';
  const promo = livePromotions(data).filter((p) => p.channel === 'brandstore').sort((a, b) => b.discountRate - a.discountRate)[0] ?? livePromotions(data)[0];
  const main = data?.products?.[0];
  const queen = main?.options?.find((o) => o.label === '퀸' && o.inStock) ?? main?.options?.find((o) => o.inStock);
  const promoPrice = promo && queen ? Math.round(queen.price * (1 - promo.discountRate / 100)) : NaN;
  let titles: string[];
  let descs: string[];
  if (hyp === 'A') {
    titles = [head.includes('경도') ? `${head} 비교하기` : head.includes('비교') ? `경도로 ${head}` : `${head} 경도 비교`, '경도로 고르는 매트리스', `${head}, 구조부터`];
    descs = ['경도 · 소재 · 구조를 비교하고 내게 맞는 매트리스를 고르세요.', `${msg}. ${landing}에서 확인하세요.`];
  } else if (hyp === 'B') {
    titles = [`리뷰로 고른 ${campaign === 'brand' ? '수면밀도' : '매트리스'}`, `${head} 구매 리뷰`, '누적 리뷰 6만 매트리스'];
    descs = ['구매 고객 리뷰로 경도와 사이즈를 먼저 확인하세요.', `${msg}. 실구매 리뷰 기준으로 비교하세요.`];
  } else {
    titles = [`${head} 무료배송`, '무료배송 · 기사 설치', promo ? `${promo.name.split(' ')[0]} 기획전 ${promo.discountRate}% 할인` : `${head} 사이즈별 가격`];
    descs = [
      '전국 무료배송 · 전문 기사 설치. 사이즈별 가격을 확인하세요.',
      promo && finite(promoPrice) ? `${promo.name} ${queen?.label} ${fmt.int(promoPrice)}원 · ~${md(promo.end)}` : `${msg}. 배송 · 설치 조건을 확인하세요.`,
    ];
  }
  return titles.map((t, i) => makeCopy(campaign, hyp, t, descs[i % descs.length], 'rule', i));
}

export function parseAiCopies(raw: unknown, campaign: IntentId, hyp: HypId): AdCopy[] {
  const arr: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { copies?: unknown[] }).copies) ? (raw as { copies: unknown[] }).copies : [];
  const out: AdCopy[] = [];
  arr.slice(0, 12).forEach((it, i) => {
    const o = it as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return;
    const title = String(o.title ?? o.headline ?? '').trim();
    const description = String(o.description ?? o.desc ?? '').trim();
    if (!title || !description) return;
    const h = (['A', 'B', 'C'] as HypId[]).includes(o.hypothesis as HypId) ? (o.hypothesis as HypId) : hyp;
    out.push(makeCopy(campaign, h, title.slice(0, 40), description.slice(0, 90), 'ai', i));
  });
  return out;
}

/* ================================================================== */
/* 검수 에이전트 (REVIEW_RULES + 데이터 대조)                             */
/* ================================================================== */

export type ReviewLevel = 'block' | 'warn' | 'check' | 'pass';
export const REVIEW_LEVEL_META: Record<ReviewLevel, { label: string; tone: 'critical' | 'serious' | 'warning' | 'good'; icon: string; rank: number }> = {
  block: { label: '차단', tone: 'critical', icon: 'x', rank: 3 },
  warn: { label: '경고', tone: 'serious', icon: 'alert', rank: 2 },
  check: { label: '확인', tone: 'warning', icon: 'search', rank: 1 },
  pass: { label: '통과', tone: 'good', icon: 'check', rank: 0 },
};
/** 검수 규칙 id → 화면 · 브리프 표기 */
export const RULE_LABEL: Record<string, string> = {
  medical_cure: '의료 효능 암시', medical_device: '의료기기 오인 · 전문가 추천', superlative: '최상급 · 순위', absolute: '절대 표현', price_claim: '가격 · 할인 대조',
  competitor: '경쟁사명', numeric_claim: '수치 주장', service_claim: '배송 · 설치 조건', soldout_option: '품절 옵션', length: '글자수', lowest_price: '최저가 표기',
};
export const ruleLabel = (id: string) => RULE_LABEL[id] ?? id;
const maxLevel = (levels: ReviewLevel[]): ReviewLevel => levels.reduce<ReviewLevel>((a, b) => (REVIEW_LEVEL_META[b].rank > REVIEW_LEVEL_META[a].rank ? b : a), 'pass');

export interface ReviewFinding { ruleId: string; level: ReviewLevel; match: string; reason: string; suggestion: string; basis: string }
export interface PriceRef { amount: number; label: string; kind: 'list' | 'promo'; status: 'live' | 'planned' | 'ended' | 'list'; end?: string; rate?: number; inStock: boolean }
export interface PriceCheck { raw: string; amount: number; kind: 'won' | 'manwon' | 'percent'; status: 'match' | 'list' | 'planned' | 'ended' | 'mismatch' | 'unchecked'; ref: string | null; note: string }
export interface ReviewResult { text: string; level: ReviewLevel; findings: ReviewFinding[]; prices: PriceCheck[]; suggested: string; suggestedLevel: ReviewLevel; changed: boolean }

/** 대조 기준 가격 — 상품 옵션 정가 + 프로모션(주력 상품 기준) 할인가 (데이터) */
export function priceReferences(data: Dataset | null | undefined): PriceRef[] {
  const out: PriceRef[] = [];
  const main = data?.products?.[0];
  for (const p of data?.products ?? []) for (const o of p.options ?? []) out.push({ amount: o.price, label: `${p.name} ${o.label} 정가`, kind: 'list', status: 'list', inStock: o.inStock });
  for (const pr of data?.promotions ?? []) {
    const status: PriceRef['status'] = pr.status === 'ended' || (data?.today && pr.end < data.today) ? 'ended' : pr.status === 'planned' || (data?.today && pr.start > data.today) ? 'planned' : 'live';
    for (const o of main?.options ?? []) {
      out.push({ amount: Math.round(o.price * (1 - pr.discountRate / 100)), label: `${pr.name} ${o.label} ${pr.discountRate}%`, kind: 'promo', status, end: pr.end, rate: pr.discountRate, inStock: o.inStock });
    }
  }
  return out;
}

function checkPrices(text: string, data: Dataset | null | undefined): PriceCheck[] {
  const out: PriceCheck[] = [];
  if (!data) return out;
  const refs = priceReferences(data);
  if (!refs.length && !(data.promotions ?? []).length) return out;
  const today = data.today;
  const describe = (r: PriceRef, raw: string, amount: number, kind: PriceCheck['kind'], note0 = ''): PriceCheck => {
    const left = r.end ? daysBetween(today, r.end) : NaN;
    if (r.status === 'list') return { raw, amount, kind, status: 'list', ref: r.label, note: `${r.label} 일치 — 할인 기간 중 정가 표기는 혼동 여부 확인${r.inStock ? '' : ' · 해당 옵션 품절'}${note0}` };
    if (r.status === 'planned') return { raw, amount, kind, status: 'planned', ref: r.label, note: `예정 프로모션 가격 — 시작 전 노출 금지${note0}` };
    if (r.status === 'ended') return { raw, amount, kind, status: 'ended', ref: r.label, note: `종료된 프로모션 가격${note0}` };
    return { raw, amount, kind, status: 'match', ref: r.label, note: `${r.label} 할인가 일치${finite(left) ? ` · ${fmtDate(r.end!)} 종료 (D-${Math.max(0, left)})${left <= 3 ? ' — 종료 후 소재 교체' : ''}` : ''}${r.inStock ? '' : ' · 해당 옵션 품절'}${note0}` };
  };
  const pick = (cands: PriceRef[]) => cands.find((r) => r.status === 'live') ?? cands.find((r) => r.status === 'list') ?? cands.find((r) => r.status === 'planned') ?? cands[0];
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s?원/g)) {
    const amount = Number(m[1].replace(/,/g, ''));
    const hit = refs.filter((r) => Math.abs(r.amount - amount) <= 100);
    out.push(hit.length ? describe(pick(hit), m[0], amount, 'won') : { raw: m[0], amount, kind: 'won', status: 'mismatch', ref: null, note: '판매가 · 프로모션 할인가와 불일치 — 가격 불일치 (p.45)' });
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?만\s?원/g)) {
    const amount = Number(m[1]) * 10000;
    const hit = refs.filter((r) => Math.abs(r.amount - amount) < 10000);
    out.push(hit.length ? describe(pick(hit), m[0], amount, 'manwon', ` · 만 원 단위 표기 (실제 ${fmt.int(pick(hit).amount)}원)`) : { raw: m[0], amount, kind: 'manwon', status: 'mismatch', ref: null, note: '만 원 단위 표기가 판매가 · 할인가와 맞지 않음' });
  }
  for (const m of text.matchAll(/(\d{1,2})\s?%\s?(할인|세일|OFF|off)/g)) {
    const rate = Number(m[1]);
    const promos = (data.promotions ?? []).filter((p) => p.discountRate === rate);
    if (!promos.length) { out.push({ raw: m[0], amount: rate, kind: 'percent', status: 'mismatch', ref: null, note: `진행 · 예정 프로모션에 ${rate}% 할인 없음 — 가격 불일치` }); continue; }
    const live = promos.find((p) => p.status === 'live' && p.end >= today);
    const pr = live ?? promos[0];
    const left = daysBetween(today, pr.end);
    out.push(live
      ? { raw: m[0], amount: rate, kind: 'percent', status: 'match', ref: pr.name, note: `${pr.name} ${rate}% 일치 · ${fmtDate(pr.end)} 종료 (D-${Math.max(0, left)})` }
      : pr.status === 'planned'
        ? { raw: m[0], amount: rate, kind: 'percent', status: 'planned', ref: pr.name, note: `${pr.name}(${fmtDate(pr.start)} 시작 예정) 할인율 — 시작 전 노출 금지` }
        : { raw: m[0], amount: rate, kind: 'percent', status: 'ended', ref: pr.name, note: `${pr.name} 종료 — 할인율 표기 제거` });
  }
  return out;
}

const SOURCE_QUALIFIER = /(기준|집계|출처|조사|\d{4}\s?(년|\.))/;
/** 자동 수정안이 넣는 입력란 — 출처 병기로 인정하지 않는다 (실제 근거를 채워야 확인 단계로 내려간다) */
const FILL_PLACEHOLDER = /\[[^\]]*입력\]/g;
const SUPERLATIVE_PLACEHOLDER = '[출처 · 집계 기간 입력]';
/** 수치 주장 — '6만 개' · '3,000명' · '10년' 그리고 단위 없는 '6만' · '3천'도 잡는다 (가격 표기는 가격 대조에서 따로 처리) */
const NUMERIC_CLAIM = /(\d[\d,]*(?:\.\d+)?\s?(?:만|천)\s?(?:개|명|건|회|가지)?|\d[\d,]*(?:\.\d+)?\s?(?:개|명|건|년|회|가지))/g;
const LOWEST_PRICE = /(최저\s?가격|최저가)/g;
const SERVICE_CLAIM = /(무료\s?배송|무료\s?설치|기사\s?설치|평생|무상\s?(?:A\/S|AS)|보증)/g;

export function reviewCopy(text: string, data?: Dataset | null, opts: { limit?: number; skipFix?: boolean } = {}): ReviewResult {
  const t = String(text ?? '');
  const findings: ReviewFinding[] = [];
  const push = (f: ReviewFinding) => { if (!findings.some((x) => x.ruleId === f.ruleId && x.match === f.match)) findings.push(f); };
  const qualified = SOURCE_QUALIFIER.test(t.replace(FILL_PLACEHOLDER, ''));
  const hasPlaceholder = new RegExp(FILL_PLACEHOLDER.source).test(t);
  for (const rule of REVIEW_RULES) {
    if (rule.id === 'price_claim') continue;
    const re = new RegExp(rule.pattern, 'g');
    for (const m of t.matchAll(re)) {
      const match = m[0];
      let level = rule.level as ReviewLevel;
      let suggestion = '';
      if (rule.id === 'superlative') {
        if (qualified) { level = 'check'; suggestion = '출처 · 기간 표기 확인됨 — 원문 집계 자료와 대조'; }
        else if (hasPlaceholder) suggestion = `${SUPERLATIVE_PLACEHOLDER} 칸을 실제 출처 · 집계 기간으로 채운 뒤 재검수 (예: 네이버 가구 부문 판매 1위, 2026년 상반기 기준)`;
        else suggestion = `'${match}'에 출처 · 집계 기간 · 기준 병기 (예: 네이버 가구 부문 판매 1위, 집계 기간 명시) 또는 삭제`;
      } else if (rule.id === 'medical_cure' || rule.id === 'medical_device') suggestion = '의료 효능 표현 삭제 — 경도 · 지지감 · 체압 분산 등 제품 속성 표현으로 교체';
      else if (rule.id === 'absolute') suggestion = `'${match}' 삭제 또는 조건 · 범위를 밝힌 표현으로 교체`;
      else if (rule.id === 'competitor') suggestion = '경쟁사명 삭제 — 비교광고는 객관 근거 · 법무 검토 후';
      push({ ruleId: rule.id, level, match, reason: rule.reason, suggestion, basis: 'REVIEW_RULES (p.27 · p.35)' });
    }
  }
  const prices = checkPrices(t, data);
  // 대조할 판매가 · 프로모션 데이터가 없으면 불일치로 단정하지 않고 '대조 필요(확인)'로 둔다
  if (!data || (!prices.length && !priceReferences(data).length)) {
    for (const m of t.matchAll(new RegExp(REVIEW_RULES.find((r) => r.id === 'price_claim')!.pattern, 'g'))) {
      prices.push({ raw: m[0], amount: NaN, kind: /%/.test(m[0]) ? 'percent' : 'won', status: 'unchecked', ref: null, note: '데이터 없이 검수 — 판매가 대조 필요' });
    }
  }
  const priceRule = REVIEW_RULES.find((r) => r.id === 'price_claim')!;
  for (const p of prices) {
    const level: ReviewLevel = p.status === 'mismatch' || p.status === 'ended' ? 'block' : p.status === 'planned' ? 'warn' : 'check';
    push({ ruleId: 'price_claim', level, match: p.raw, reason: priceRule.reason, suggestion: p.note, basis: p.ref ? `데이터 대조: ${p.ref}` : '데이터 대조 (products · promotions)' });
  }
  const priceRaw = prices.map((p) => p.raw).join(' ');
  for (const m of t.matchAll(NUMERIC_CLAIM)) {
    if (priceRaw.includes(m[0].trim()) || /%/.test(m[0]) || /^(19|20)\d{2}\s?년$/.test(m[0].trim())) continue;
    push({ ruleId: 'numeric_claim', level: 'check', match: m[0].trim(), reason: EXTRA_REVIEW_RULES[0].reason, suggestion: '집계 기준일 · 출처를 문안 또는 랜딩에 병기', basis: 'Lab 추가 규칙' });
  }
  for (const m of t.matchAll(LOWEST_PRICE)) push({ ruleId: 'lowest_price', level: 'warn', match: m[0], reason: EXTRA_REVIEW_RULES[4].reason, suggestion: "'최저가' 삭제 또는 비교 대상 · 기간 · 조사 기준 병기", basis: 'Lab 추가 규칙' });
  for (const m of t.matchAll(SERVICE_CLAIM)) push({ ruleId: 'service_claim', level: 'check', match: m[0], reason: EXTRA_REVIEW_RULES[1].reason, suggestion: '판매 조건 페이지의 배송 · 설치 범위와 같은지 대조', basis: 'Lab 추가 규칙' });
  for (const so of data ? soldOutOptions(data) : []) {
    if (t.includes(so.label)) push({ ruleId: 'soldout_option', level: 'warn', match: so.label, reason: EXTRA_REVIEW_RULES[2].reason, suggestion: `${so.label} 재입고 전 문구에서 제외하거나 재고 있는 옵션으로 교체`, basis: `데이터 대조: ${so.product.name} ${so.label} inStock=false` });
  }
  if (opts.limit && charLen(t) > opts.limit) push({ ruleId: 'length', level: 'warn', match: `${charLen(t)}자`, reason: EXTRA_REVIEW_RULES[3].reason, suggestion: `${opts.limit}자 이내로 축약 (현재 ${charLen(t)}자)`, basis: '네이버 파워링크 글자수' });
  const level = t.trim() ? maxLevel(findings.map((f) => f.level)) : 'pass';
  let suggested = t;
  let suggestedLevel = level;
  if (!opts.skipFix && (level === 'block' || level === 'warn')) {
    suggested = applyFixes(t, findings, data);
    suggestedLevel = reviewCopy(suggested, data, { limit: opts.limit, skipFix: true }).level;
  }
  return { text: t, level, findings, prices, suggested, suggestedLevel, changed: suggested !== t };
}

/** 안전한 치환만 자동 적용 (의료 · 절대 · 최상급 · 경쟁사 · 가격 불일치) — 결과는 초안 */
export function applyFixes(text: string, findings: readonly ReviewFinding[], data?: Dataset | null): string {
  let s = String(text ?? '');
  const ids = new Set(findings.filter((f) => f.level === 'block' || f.level === 'warn').map((f) => f.ruleId));
  for (const fx of REVIEW_FIXES) if (ids.has(fx.ruleId)) s = s.replace(new RegExp(fx.pattern, 'g'), fx.replace);
  if (ids.has('superlative') && !SOURCE_QUALIFIER.test(s.replace(FILL_PLACEHOLDER, ''))) s = s.replace(/1위(?!\s?\[)/g, `1위${SUPERLATIVE_PLACEHOLDER}`);
  if (ids.has('lowest_price')) s = s.replace(LOWEST_PRICE, '');
  if (data && ids.has('price_claim')) {
    const live = (data.promotions ?? []).filter((p) => p.status === 'live' && p.end >= data.today).sort((a, b) => b.discountRate - a.discountRate);
    const refs = priceReferences(data).filter((r) => r.status === 'live' && r.inStock);
    for (const f of findings.filter((x) => x.ruleId === 'price_claim' && (x.level === 'block'))) {
      if (/%/.test(f.match) && live[0]) s = s.replace(f.match, f.match.replace(/\d{1,2}(?=\s?%)/, String(live[0].discountRate)));
      const won = f.match.match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s?원/);
      if (won && refs.length) {
        const amt = Number(won[1].replace(/,/g, ''));
        const near = [...refs].sort((a, b) => Math.abs(a.amount - amt) - Math.abs(b.amount - amt))[0];
        s = s.replace(f.match, `${fmt.int(near.amount)}원`);
      }
    }
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,·]+|[\s,·]+$/g, '').replace(/,\s*,/g, ',').trim();
}

/** 검수 대상 전체 문안 (가설 · 캠페인 메시지 · 프로모션 소재가 · VisualTune 초안 · 테스트 카드 · AI 문안) */
export interface CopyItem { id: string; source: string; text: string; limit?: number }
export function collectCopies(data: Dataset, cards: readonly TestCard[] = [], aiCopies: readonly AdCopy[] = []): CopyItem[] {
  const out: CopyItem[] = [];
  for (const h of Object.values(HYPOTHESES)) out.push({ id: `hyp:${h.id}`, source: `가설 ${h.id} · ${h.name} (p.27)`, text: h.copy });
  for (const i of INTENT_IDS) out.push({ id: `camp:${i}`, source: `SA 캠페인 메시지 · ${SA_CAMPAIGNS[i].name} (p.35)`, text: SA_CAMPAIGNS[i].message });
  for (const p of data?.promotions ?? []) if (finite(p.adCopyPrice)) out.push({ id: `promo:${p.id}`, source: `프로모션 소재 표기가 · ${p.name}`, text: `${p.name} ${fmt.int(p.adCopyPrice)}원 · ${p.discountRate}% 할인` });
  for (const d of VISUALTUNE_DRAFTS) out.push({ id: `vt:${d.id}`, source: `VisualTune 초안 · 가설 ${d.hypothesis} · ${d.channel} (DEMO)`, text: d.text });
  for (const c of cards) {
    if (c.copyControl) out.push({ id: `card:${c.id}:C`, source: `${c.id} 기존안`, text: c.copyControl });
    if (c.copyVariant) out.push({ id: `card:${c.id}:V`, source: `${c.id} 변형안`, text: c.copyVariant });
  }
  for (const a of aiCopies) {
    out.push({ id: `ai:${a.id}:t`, source: `AI 문안 제목 · ${SA_CAMPAIGNS[a.campaign].name} × ${a.hypothesis}`, text: a.title, limit: SA_CHAR_LIMITS.title });
    out.push({ id: `ai:${a.id}:d`, source: `AI 문안 설명 · ${SA_CAMPAIGNS[a.campaign].name} × ${a.hypothesis}`, text: a.description, limit: SA_CHAR_LIMITS.description });
  }
  return out;
}

export function reviewAll(data: Dataset, items: readonly CopyItem[]) {
  const rows = items.map((i) => ({ item: i, result: reviewCopy(i.text, data, { limit: i.limit }) }));
  const count: Record<ReviewLevel, number> = { block: 0, warn: 0, check: 0, pass: 0 };
  const byRule: Record<string, number> = {};
  for (const r of rows) {
    count[r.result.level] += 1;
    for (const f of r.result.findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  }
  return { rows, count, byRule, total: rows.length };
}

/* ================================================================== */
/* 테스트 · 인사이트 운영 루프 캘린더 (p.28)                              */
/* ================================================================== */

export interface LoopEvent { date: string; cadence: LoopCadenceId | 'test_end' | 'stop_check'; title: string; output: string; shiftedFrom?: string; ref?: string }
export function nextBusinessDay(date: string): string {
  let d = date;
  for (let i = 0; i < 10 && isOffDay(d).off; i++) d = addDays(d, 1);
  return d;
}
export function nthBusinessDay(year: number, month1: number, n: number): string {
  let d = `${year}-${String(month1).padStart(2, '0')}-01`;
  let k = 0;
  for (let i = 0; i < 31; i++) {
    if (!isOffDay(d).off) { k += 1; if (k === n) return d; }
    d = addDays(d, 1);
  }
  return d;
}
function nthWeekday(year: number, month1: number, wd: number, n: number): string {
  let d = `${year}-${String(month1).padStart(2, '0')}-01`;
  while (weekday(d) !== wd) d = addDays(d, 1);
  return addDays(d, 7 * (n - 1));
}

export function loopCalendar(today: string, cards: readonly TestCard[] = [], decisions: Record<string, CardDecision | undefined> = {}, weeks = 8) {
  const from = addDays(today, -((weekday(today) + 6) % 7)); // 이번 주 월요일
  const to = addDays(from, weeks * 7 - 1);
  const events: LoopEvent[] = [];
  const inRange = (d: string) => d >= from && d <= to;
  const cad = (id: LoopCadenceId) => LOOP_CADENCE.find((c) => c.id === id)!;
  const add = (date: string, cadence: LoopEvent['cadence'], title: string, output: string, ref?: string) => {
    const shifted = cadence === 'stop_check' || cadence === 'test_end' ? date : nextBusinessDay(date);
    if (inRange(shifted)) events.push({ date: shifted, cadence, title, output, ref, shiftedFrom: shifted !== date ? date : undefined });
  };
  for (let d = from; d <= to; d = addDays(d, 7)) add(d, 'weekly', `주간 ${cad('weekly').content}`, cad('weekly').output);
  const y0 = parseDate(from).getFullYear();
  const m0 = parseDate(from).getMonth() + 1;
  for (let i = 0; i < 4; i++) {
    const m = ((m0 - 1 + i) % 12) + 1;
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const d = nthBusinessDay(y, m, 3);
    if (inRange(d)) events.push({ date: d, cadence: 'monthly', title: `월간 ${cad('monthly').content}`, output: cad('monthly').output });
    if (m % 3 === 0) add(nthWeekday(y, m, 3, 3), 'quarterly', `분기 ${cad('quarterly').content}`, cad('quarterly').output);
  }
  for (const c of cards) {
    const dec = decisions[c.id];
    if (dec) add(addDays(dec.at, CARD_RULES.wrapupDays), 'wrapup', `${c.id} 랩업 · 결과 판정`, cad('wrapup').output, c.id);
    add(addDays(c.start, c.stopDay), 'stop_check', `${c.id} ${c.stopDay}일 차 중단 점검 (CVR −${c.stopDropPct}%)`, '중단 · 지속', c.id);
    add(addDays(c.start, c.plannedDays), 'test_end', `${c.id} 테스트 종료 · 판정`, '확대 · 중단 · 모니터링', c.id);
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.cadence.localeCompare(b.cadence));
  return { from, to, events };
}

/* ================================================================== */
/* 브리프 (오프라인 규칙 엔진) · AI 프롬프트                             */
/* ================================================================== */

const q = (s: string) => `'${s}'`;

export function pipelineBrief(data: Dataset, changes: readonly ChangeRequest[] = [], cIn?: Partial<LabCriteria> | null): Brief {
  const c = resolveCriteria(cIn);
  const items = buildPipeline(data, changes, c);
  const s = pipelineSummary(items);
  const pools = groupPools(items, c);
  const decided = items.filter((i) => i.step === 4);
  const insuff = items.filter((i) => i.judgement.verdict === 'insufficient');
  const running = items.filter((i) => i.step === 2);
  const facts: string[] = [];
  const patterns: string[] = [];
  const interpretation: string[] = [];
  const actions: string[] = [];
  if (!items.length) {
    facts.push('현재 테스트 그룹 키워드와 등록 요청이 없습니다 (TEST DATA 기준).');
  } else {
    facts.push(`테스트 파이프라인 ${items.length}건 (TEST DATA): STEP 1 후보 등록 ${s.byStep[1]} · STEP 2 집행 ${s.byStep[2]} · STEP 3 검증 보류 ${s.byStep[3]} · STEP 4 판정 ${s.byStep[4]}. 판정 분포는 확장 ${s.byVerdict.expand} · 유지 ${s.byVerdict.keep} · 제외 ${s.byVerdict.exclude} · 판정 보류 ${s.byVerdict.insufficient}입니다.`);
    for (const i of decided.slice(0, 4)) facts.push(`${q(i.phrase)} ${i.judgement.badge} — 클릭 ${fmt.int(i.judgement.stats.clicks)} · 전환 ${fmt.dec1(i.judgement.stats.conversions)}건 · ROAS ${fmt.roas(i.judgement.roas)} (${i.sourceLabel}).`);
    if (insuff.length) facts.push(`판정 보류 ${insuff.length}건: ${insuff.map((i) => `${q(i.phrase)} 클릭 ${fmt.int(i.judgement.stats.clicks)}회`).join(' · ')} — 판정 최소 클릭 ${c.minJudgeClicks}회 미달.`);
    for (const i of running.slice(0, 3)) facts.push(`${q(i.phrase)} 집행 중 — ${i.judgement.badge.replace(/^집행 중 · /, '')}.`);
  }
  const overdue = items.filter((i) => i.overdue);
  if (overdue.length) {
    const perDay = overdue.map((i) => (n0(i.days) > 0 ? i.judgement.stats.clicks / n0(i.days) : NaN)).filter(finite);
    const lo = perDay.length ? Math.min(...perDay) : NaN;
    const hi = perDay.length ? Math.max(...perDay) : NaN;
    const range = !finite(lo) ? '' : fmt.dec1(lo) === fmt.dec1(hi) ? `${fmt.dec1(lo)}회` : `${fmt.dec1(lo)}~${fmt.dec1(hi)}회`;
    // 가장 빠른 키워드 기준 남은 일수 (클릭 기준 도달까지)
    const remain = overdue.map((i) => {
      const pd = n0(i.days) > 0 ? i.judgement.stats.clicks / n0(i.days) : 0;
      const left = Math.max(0, c.minClicks - i.judgement.stats.clicks);
      return left === 0 ? 0 : pd > 0 ? Math.ceil(left / pd) : Infinity;
    });
    const need = remain.length ? Math.min(...remain) : Infinity;
    patterns.push(`테스트 그룹 키워드 ${overdue.length}개가 판정 기준 ${c.minDays}일을 넘겨 ${Math.max(...overdue.map((i) => n0(i.days)))}일째 집행 중입니다.${range ? ` 일 평균 클릭 ${range}로, 가장 빠른 키워드도 클릭 ${c.minClicks}회까지 ${finite(need) ? `약 ${fmt.int(need)}일 더` : '현재 속도로는 기한 없이'} 걸리는 속도라 기간 연장만으로는 표본이 쌓이지 않는 구조가 반복됩니다.` : ''}`);
  }
  const vols = insuff.map((i) => n0((data?.keywords ?? []).find((k) => k.id === i.keywordId)?.monthlySearch)).filter((v) => v > 0);
  if (vols.length >= 2) patterns.push(`판정 보류 키워드 ${vols.length}개는 월 검색량 ${fmt.int(Math.min(...vols))}~${fmt.int(Math.max(...vols))} 구간의 롱테일 구문입니다. 개별 구문 볼륨으로는 ${c.minDays}일 안에 클릭 ${c.minClicks}회에 도달하지 않는 패턴이 반복됩니다.`);
  for (const p of pools) {
    const pj = p.judgement;
    interpretation.push(`${p.adgroup} 판정 보류 ${p.count}개를 합산하면 클릭 ${fmt.int(p.stats.clicks)}회 · 전환 ${fmt.dec1(p.stats.conversions)}건 · ROAS ${fmt.roas(roasOf(p.stats))}로 합산 기준 판정은 ${KW_VERDICT_META[pj.verdict].label}입니다${pj.cautions.length ? `. 다만 ${pj.cautions[0]}` : ''}. 개별 구문 단위 판정보다 같은 의도 그룹으로 묶어 상위 구문(상황 + 매트리스)으로 통합하는 쪽이 CAC 회수 판단을 빠르게 만듭니다. 가정: 그룹 내 구문 간 전환율이 크게 다르지 않다.`);
  }
  const lowConv = decided.filter((i) => i.judgement.cautions.some((x) => x.startsWith('전환')));
  if (lowConv.length) interpretation.push(`${lowConv.map((i) => q(i.phrase)).join(' · ')} — ROAS 기준으로는 확장 판정이지만 전환이 ${AD_PILOT.minConversionsForDown}건 미만이라 1건의 전환 유무로 결과가 뒤집힐 수 있습니다. 본 그룹 이관 후에도 입찰은 테스트 상한 안에서 시작하고 2주 랩업에서 재판정하는 것이 비용 측면에서 안전합니다.`);
  if (!interpretation.length && items.length) interpretation.push('현재 판정 결과는 목표 ROAS 대비 비율로만 계산되었습니다. 볼륨(검색량)과 CAC 회수 기간은 본 그룹 이관 후 2주 랩업에서 함께 확인합니다.');
  const conditions = [
    `판정 기준(p.26): 확장 ≥ 목표 ROAS ${fmt.int(c.targetRoas)}%의 ${c.expandAtPct}% · 유지 ${c.keepFromPct}~${c.expandAtPct}% · 제외 < ${c.keepFromPct}% 또는 전환 없음. 집행 기준 ${c.minDays}일 또는 클릭 ${c.minClicks}회. 판정 최소 클릭 ${c.minJudgeClicks}회는 모듈 가정이며 기준값은 온보딩 중 수면밀도 목표 ROAS에 맞춰 확정합니다.`,
  ];
  const hiItems = insuff.filter((i) => finite(i.judgement.ratioPct) && i.judgement.ratioPct >= c.expandAtPct);
  const hiClicks = hiItems.map((i) => i.judgement.stats.clicks);
  const counter = [
    hiItems.length
      ? `ROAS만 보면 판정 보류 키워드 ${hiItems.length}개도 목표 대비 ${pct0(Math.min(...hiItems.map((i) => i.judgement.ratioPct)))} 이상으로 확장 구간이지만, 클릭 ${fmt.int(Math.min(...hiClicks))}~${fmt.int(Math.max(...hiClicks))}회 · 전환 합계 ${fmt.dec1(hiItems.reduce((a, i) => a + i.judgement.stats.conversions, 0))}건의 소표본(판정 최소 클릭 ${c.minJudgeClicks}회 미달)으로 계산된 값이라 판정 근거로 쓰지 않습니다.`
      : '판정 결과는 최근 집행 기간의 TEST DATA 기준이며 시즌(가을 이사 · 혼수) 효과가 섞여 있을 수 있습니다.',
  ];
  if (decided.length) actions.push(`담당 AE: STEP 4 판정 ${decided.length}건을 승인 요청합니다. 본 그룹 이관(확장)은 PM 승인, 제외 · 재테스트는 담당 AE 승인이며, 반영 후 2주 랩업에서 목표 ROAS 대비 비율과 전환 수로 재판정합니다.`);
  if (insuff.length) actions.push(`SA AE: 판정 보류 ${insuff.length}건은 이번 주 안에 그룹 합산 판정으로 전환하거나 입찰 상한 내 상향을 요청하고, 7일 후 클릭 ${c.minClicks}회 도달 여부로 재확인합니다. 미달 시 볼륨 한계 사유로 제외합니다.`);
  if (running.length) actions.push(`담당 AE: 집행 중 ${running.length}건은 클릭 ${c.minClicks}회 도달 시점에 자동 판정됩니다. 그 전에는 입찰을 바꾸지 않습니다 (표본 흔들림 방지).`);
  return { title: 'MILDO Lab 테스트 판정', facts, patterns, interpretation, conditions, counter, actions };
}

/** 콘텐츠 공백 · 기획전 종료로 부분 매칭이 반복되는 축 요약 */
export function gapText(entries: readonly Candidate[]): string {
  const gaps = new Map<string, number>();
  for (const e of entries) for (const g of e.landing.gaps) gaps.set(g, (gaps.get(g) ?? 0) + 1);
  const promo = entries.filter((e) => e.landing.notes.some((n) => n.includes('종료 후 랜딩 교체'))).length;
  const parts: string[] = [];
  if (gaps.size) parts.push(`${[...gaps.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `'${g}' ${n}개`).join(' · ')}는 전용 콘텐츠가 없어 부분 매칭으로 반복 분류됩니다.`);
  if (promo) parts.push(`기획전 랜딩으로 가는 ${promo}개는 진행 중 기획전 종료가 임박해 랜딩 교체 일정이 필요합니다.`);
  return parts.join(' ') || '콘텐츠 공백은 확인되지 않았습니다.';
}

export function discoveryBrief(data: Dataset, changes: readonly ChangeRequest[] = [], extra: readonly Candidate[] = [], cIn?: Partial<LabCriteria> | null): Brief {
  const crit = resolveCriteria(cIn);
  const { all, excludedExisting, excludedRegistered } = discoverCandidates(data, changes, extra, crit.targetRoas);
  const st = all.filter((c) => c.source === 'search_term');
  const sku = skuEntries(data, changes, crit.targetRoas);
  const f = skuFormula();
  const top = all.filter((c) => c.status === 'new' && c.purchase).slice(0, 5);
  const SRC_SHORT: Record<CandidateSource, string> = { search_term: '검색어 보고서', related: '연관 검색어', ai_query: 'AI 검색 질의', sku48: 'SKU 확장 진입점', ai_expand: 'AI 확장' };
  const bySource = (Object.keys(SOURCE_LABEL) as CandidateSource[])
    .map((s) => [s, all.filter((c) => c.source === s).length] as const)
    .filter(([s, n]) => n > 0 || s !== 'ai_expand')
    .map(([s, n]) => `${SRC_SHORT[s]} ${n}개`).join(' · ');
  const stConv = st.filter((c) => c.evidence && c.evidence.conversions > 0);
  const stHigh = st.filter((c) => c.evidence && finite(c.evidence.ratioPct) && c.evidence.ratioPct >= crit.expandAtPct);
  const skuGood = sku.filter((c) => c.landing.level === 'good');
  const soldLabels = [...new Set(soldOutOptions(data).map((s) => s.label))];
  const soldNotes = all.filter((c) => c.landing.notes.some((n) => n.includes('품절 — 랜딩')));
  const nonPurchase = all.filter((c) => !c.purchase);
  const medical = all.filter((c) => c.medical);
  const gapCount = new Map<string, number>();
  for (const e of [...sku, ...all]) for (const g of e.landing.gaps) gapCount.set(g, (gapCount.get(g) ?? 0) + 1);
  const gapTop = [...gapCount.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 5);
  const excludedTxt = [
    excludedRegistered ? `검색어 보고서의 등록 구문 ${excludedRegistered}개는 테스트 파이프라인에서 판정` : '',
    excludedExisting ? `등록 키워드와 같은 구문 ${excludedExisting}개는 제외` : '',
  ].filter(Boolean).join(' · ');
  return {
    title: '롱테일 · 구문형 키워드 발굴',
    facts: [
      `후보 ${all.length}개 (${bySource} · 구문 중복 제거)${excludedTxt ? ` · ${excludedTxt}` : ''}. SKU 확장은 제품 ${f.product} × 문제 ${f.problems} × 상황 ${f.situations} × 비교 ${f.criteria} = 검색 진입점 ${f.total}개입니다 (p.36).`,
      st.length
        ? `검색어 보고서 미등록 구문 ${st.length}개 중 전환 발생 ${stConv.length}개, 목표 ROAS(일반 ${fmt.int(crit.targetRoas)}% · 브랜드 ${AD_PILOT.brandTargetRoas}%) 대비 ${crit.expandAtPct}% 이상 ${stHigh.length}개입니다 (TEST DATA).`
        : '검색어 보고서에 미등록 구문이 없습니다 (TEST DATA).',
      ...top.map((c) => `${q(c.phrase)} ${c.score}점 — ${SOURCE_LABEL[c.source]} · ${INTENT_NAME(c.intent)} · ${c.volumeKind === 'impressions' ? `노출 ${fmt.int(c.volume)}` : `월 ${fmt.int(c.volume)} (추정)`} · 랜딩 ${c.landing.label} ${LANDING_LEVEL_META[c.landing.level].label}${c.evidence ? ` · ROAS ${fmt.roas(c.evidence.roas)}` : ''}.`),
    ],
    patterns: [
      `48 진입점 중 랜딩이 완전히 맞는 조합은 ${skuGood.length}개${skuGood.length ? `(${[...new Set(skuGood.map((x) => `${x.sku?.situation} × ${x.sku?.problem}`))].join(' · ')})` : ''}입니다. ${gapText(sku)}`,
      ...(soldNotes.length ? [`${soldLabels.map((l) => q(l)).join(' · ')} 옵션이 들어간 후보 ${soldNotes.length}개는 해당 옵션 품절로 랜딩에서 구매할 수 없습니다 (상품 재고 데이터 대조).`] : []),
    ],
    interpretation: [
      '등록 순서는 실측 근거가 있는 검색어 보고서 구문이 먼저이고, 48 진입점은 추정 검색량이라 랜딩이 맞는 조합부터 소액 테스트하는 것이 테스트 비용 대비 학습 속도가 빠릅니다. 롱테일 구문은 개별 볼륨이 작아 같은 의도 그룹으로 묶어 판정 표본을 확보하는 운영을 전제로 합니다.',
    ],
    conditions: [
      `우선순위 점수 = 검색량 ${SCORE_WEIGHTS.volume} + 랜딩 매칭 ${SCORE_WEIGHTS.landing} + 근거(검색어 보고서 성과) ${SCORE_WEIGHTS.evidence} + 구매 의도 ${SCORE_WEIGHTS.intent} (모듈 가정). ${SCORE_WEIGHTS.priority}점 이상 우선 · ${SCORE_WEIGHTS.review}점 이상 검토. 48 진입점 검색량은 데이터 키워드 검색량 기반 데모 추정이며 실제 값은 키워드 도구 조회 후 확정합니다.`,
    ],
    counter: [
      ...(nonPurchase.length ? [`${nonPurchase.map((c) => q(c.phrase)).join(' · ')} — 검색량이 있어도 폐기 · 렌탈 의도라 등록 대상이 아니라 제외 키워드 후보입니다.`] : []),
      ...(medical.length ? [`${medical.map((c) => q(c.phrase)).slice(0, 3).join(' · ')} — 의료 연관 검색 맥락이라 전환이 있어도 문안 · 랜딩 검수 통과 전에는 등록하지 않습니다.`] : []),
    ],
    actions: [
      `SA AE: 우선 등급 후보를 테스트 전용 그룹에 등록 요청합니다 (입찰 상한 = 같은 의도 본 그룹 입찰 중앙값, ${LAB_BULK.pmFrom}건 이상 일괄은 PM 승인). 등록 후 ${crit.minDays}일 또는 클릭 ${crit.minClicks}회 도달 시 자동 판정합니다.`,
      ...(gapTop.length ? [`SearchTuneOS 담당: 부분 매칭으로 분류된 콘텐츠 공백(${gapTop.join(' · ')})을 선택 가이드 · FAQ 보강 목록으로 넘기고, 보강 후 같은 후보의 랜딩 매칭을 다시 계산합니다.`] : []),
      ...(soldNotes.length ? [`담당 AE: ${soldLabels.join(' · ')} 옵션 재입고 전에는 해당 옵션이 들어간 후보를 등록하지 않거나 재고 있는 사이즈 랜딩으로 연결합니다.`] : []),
    ],
  };
}

export function reviewBrief(data: Dataset, cards: readonly TestCard[] = [], aiCopies: readonly AdCopy[] = []): Brief {
  const r = reviewAll(data, collectCopies(data, cards, aiCopies));
  const blocks = r.rows.filter((x) => x.result.level === 'block');
  const warns = r.rows.filter((x) => x.result.level === 'warn');
  // 차단 · 경고 지적만 센다 (가격 일치 '확인'까지 세면 위반이 많은 규칙처럼 읽힌다)
  const severe: Record<string, number> = {};
  for (const x of r.rows) for (const f of x.result.findings) if (f.level === 'block' || f.level === 'warn') severe[f.ruleId] = (severe[f.ruleId] ?? 0) + 1;
  const topRule = Object.entries(severe).sort((a, b) => b[1] - a[1])[0];
  // VisualTune 초안에서 차단 사유가 된 규칙 (데이터로 집계)
  const vtBlock = new Map<string, number>();
  for (const x of blocks.filter((b) => b.item.id.startsWith('vt:'))) {
    for (const id of new Set(x.result.findings.filter((f) => f.level === 'block').map((f) => (f.ruleId === 'price_claim' ? '가격 · 할인 불일치' : ruleLabel(f.ruleId))))) vtBlock.set(id, (vtBlock.get(id) ?? 0) + 1);
  }
  const vtTxt = [...vtBlock.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}건`).join(' · ');
  return {
    title: '문안 검수 에이전트',
    facts: [
      `검수 대상 ${r.total}건 — 차단 ${r.count.block} · 경고 ${r.count.warn} · 확인 ${r.count.check} · 통과 ${r.count.pass}.`,
      ...blocks.slice(0, 4).map((x) => `차단: ${q(x.item.text)} — ${x.result.findings.filter((f) => f.level === 'block').map((f) => `${f.match}(${f.ruleId === 'price_claim' ? '가격 불일치' : ruleLabel(f.ruleId)})`).join(' · ')} → 수정안 ${q(x.result.suggested)} (${REVIEW_LEVEL_META[x.result.suggestedLevel].label}).`),
      ...warns.slice(0, 3).map((x) => `경고: ${q(x.item.text)} — ${x.result.findings.filter((f) => f.level === 'warn').map((f) => f.match).join(' · ')}.`),
    ],
    patterns: topRule ? [`차단 · 경고가 가장 많이 나온 규칙은 ${ruleLabel(topRule[0])} (${topRule[1]}건)입니다.${vtTxt ? ` VisualTune 초안의 차단 사유는 ${vtTxt}입니다.` : ''}`] : [],
    interpretation: ['차단 문안은 매체 검수 반려 · 표시광고 리스크로 소재 교체 비용이 발생하므로, 제작 단계에서 걸러내는 쪽이 운영 리소스를 줄입니다. 가격 · 할인율은 판매가 데이터와 매일 대조해야 기획전 종료 직후 불일치가 남지 않습니다.'],
    conditions: ['검수 규칙: 의료 효능 암시 · 의료기기 오인 차단, 최상급 · 순위는 출처 병기 시 확인, 절대 표현 · 경쟁사명 경고, 가격 표기는 상품 옵션가 × (1 − 할인율)과 대조해 불일치 시 차단 (REVIEW_RULES, p.27 · p.35 · p.45).'],
    counter: ['자동 수정안은 치환 초안이라 문맥이 어색할 수 있습니다. 최종 문안은 담당 AE가 확인하고, 수치 주장(리뷰 수 등)은 집계 기준일 근거를 첨부합니다.'],
    actions: [`담당 AE: 차단 ${r.count.block}건은 오늘 중 수정안으로 교체 요청, 경고 ${r.count.warn}건은 출처 · 근거 보완 후 재검수합니다. 가격 문구는 기획전 종료일 전날 다시 대조합니다.`],
  };
}

export function creativeBrief(data: Dataset, cards: readonly TestCard[], patterns: readonly Pattern[] = []): Brief {
  const js = cards.map((c) => ({ c, j: judgeTestCard(c, data.today) }));
  const facts = js.map(({ c, j }) => `${c.id} ${c.title} — ${j.badge}. ${j.basis} (TEST DATA).`);
  if (!facts.length) facts.push('진행 중인 테스트 카드가 없습니다.');
  const stop = js.filter((x) => x.j.verdict === 'stop');
  const exp = js.filter((x) => x.j.verdict === 'expand');
  const run = js.filter((x) => x.j.verdict === 'running');
  return {
    title: 'VisualTune · 테스트 카드 판정',
    facts,
    patterns: patterns.slice(0, 3).map((p) => `${p.title} — ${p.metric} ${sg(p.lift, 0)}${p.p !== null ? ` (${pText(p.p)})` : ''} · ${p.period} (${p.source === 'demo' ? 'DEMO 가상 이력' : '랩업 기록'}).`),
    interpretation: [
      ...exp.map(({ c, j }) => {
        const cpa = j.checks.find((x) => x.metric === 'cpa');
        const cpaTxt = cpa && finite(cpa.lift) ? ` 테스트 기간 CPA ${sg(cpa.lift, 0)}` : '';
        const why = c.primary === 'cvr'
          ? `${c.variable} 변경은 클릭 단가를 거의 바꾸지 않고 전환율만 움직이는 구조라${cpaTxt ? `${cpaTxt}가` : ' CPA 변화가'} 같은 의도 그룹 확대 시 CAC 개선으로 이어질 가능성이 높습니다. 가정: 그룹 내 다른 키워드도 같은 ${c.variable} 효과를 받는다.`
          : `CTR 상승은 같은 노출에서 클릭을 늘리지만, CVR이 유지돼야 CPA가 개선됩니다.${cpaTxt ? `${cpaTxt}를` : ' CPA를'} 확대 후 2주 랩업에서 다시 확인합니다. 가정: 확대 지면의 클릭 품질이 테스트 지면과 같다.`;
        return `${c.id} 카드는 ${c.primary === 'ctr' ? 'CTR' : '전환율'} ${sg(j.primaryLift, 0)}가 확대 기준 +${c.expandLiftPct}%를 넘고 유의합니다(${pText(j.primaryP)}). ${why}`;
      }),
      ...stop.map(({ c, j }) => {
        const promoLanding = /기획전/.test(`${c.variant} ${c.hypothesis}`);
        const why = promoLanding
          ? '기획전 랜딩은 혜택 노출은 늘리지만 사이즈 · 옵션 선택 정보가 아래로 밀려 결정을 늦추는 것으로 해석합니다(가설 — 랩업에서 스크롤 · 이탈 지점으로 확인).'
          : `변형안의 ${c.variable} 변경이 클릭 이후 결정 단계에 마찰을 만든 것으로 보이며, 원인은 랩업에서 분리 테스트로 확인합니다(가설).`;
        return `${c.id} 카드는 ${j.dataDays}일 차 전환율 ${sg(j.liftCvr, 0)}로 중단 기준 −${c.stopDropPct}%에 도달했습니다. ${finite(j.pCvr) && j.pCvr >= CARD_RULES.alpha ? `유의성은 아직 확보되지 않았지만(${pText(j.pCvr)}) 손실 방지 기준이 우선입니다. ` : ''}${why}`;
      }),
      ...run.map(({ c, j }) => `${c.id} 카드는 중간 ${c.primary === 'ctr' ? 'CTR' : 'CVR'} ${sg(j.primaryLift, 0)}입니다. 판정 순서상 CTR 다음 CVR을 확인해야 하므로 기간 종료 전 확대하지 않습니다.`),
    ],
    conditions: [`테스트 카드 기준(p.28): 기간 ${CARD_RULES.days}일 또는 최소 표본 · 중단 ${CARD_RULES.stopDay}일 차 전환율 −${CARD_RULES.stopCvrDropPct}% · 확대 전환율 +${CARD_RULES.expandCvrLiftPct}% → 같은 의도 그룹 전체 적용. 유의수준 ${CARD_RULES.alpha} · 검정력 ${CARD_RULES.power}는 모듈 가정입니다. 소재 테스트는 한 번에 한 변수 · 동일 타겟 · 유사 예산 · CTR → CVR → CPA → ROAS 순 판정(p.27).`],
    counter: ['두 비율 z-검정은 일자 간 독립을 가정합니다. 기획전 시작 · 종료처럼 기간 중 외부 변수가 바뀌면 효과가 섞이므로 랩업에서 기간 분할 결과를 함께 확인합니다.'],
    actions: [
      ...exp.map(({ c }) => `PM: ${c.id} 확대(${c.expandScope}) 승인 요청 → 결정일 + 14일 랩업에서 전환율 유지 여부로 재판정.`),
      ...stop.map(({ c }) => `담당 AE: ${c.id} 변형안 중단 · 기존안 복귀를 오늘 반영하고 원인을 랩업 카드에 기록.`),
      ...run.map(({ c, j }) => `담당 AE: ${c.id} 카드는 ${fmtDate(j.endDate)} 종료 시점에 자동 판정합니다.`),
    ],
  };
}

/** AI 해석용 데이터 스냅샷 + 과제 */
export function labPrompt(data: Dataset, changes: readonly ChangeRequest[], cIn: Partial<LabCriteria> | null, cards: readonly TestCard[]): string {
  const c = resolveCriteria(cIn);
  const items = buildPipeline(data, changes, c);
  const { all } = discoverCandidates(data, changes, [], c.targetRoas);
  const snap = {
    출처: 'TEST DATA (시연용 테스트 데이터) · 제안서 p.26–28 · p.36 기준',
    기준일: `${data.today} ${data.currentHour}시`,
    판정기준: c,
    파이프라인: items.map((i) => ({ 키워드: i.phrase, 출처: i.sourceLabel, 단계: i.step, 판정: i.judgement.badge, 클릭: i.judgement.stats.clicks, 전환: rn(i.judgement.stats.conversions, 2), ROAS: rn(i.judgement.roas), 일수: i.days, 주의: i.judgement.cautions })),
    상위후보: all.slice(0, 12).map((x) => ({ 구문: x.phrase, 출처: SOURCE_LABEL[x.source], 의도: INTENT_NAME(x.intent), 점수: x.score, 검색량: x.volume, 검색량근거: x.volumeKind, 랜딩: `${x.landing.label} ${x.landing.level}`, ROAS: x.evidence ? rn(x.evidence.roas) : null })),
    테스트카드: cards.map((x) => { const j = judgeTestCard(x, data.today); return { id: x.id, 가설: x.hypothesis, 변수: x.variable, 판정: j.badge, 근거: j.basis, CVR상승pct: rn(j.liftCvr, 1), CTR상승pct: rn(j.liftCtr, 1), pCVR: rn(j.pCvr, 3), pCTR: rn(j.pCtr, 3) }; }),
  };
  return `과제: MILDO Lab의 키워드 테스트 파이프라인 · 발굴 후보 · 테스트 카드를 읽고 이번 주 판정과 다음 테스트 우선순위를 정리하라. 롱테일 볼륨 한계, 소수 전환에 따른 판정 불확실성, 확장 시 CAC 회수 구조를 반드시 다룬다. 의료 효능 표현은 제안하지 않는다.\n\n데이터(JSON):\n${JSON.stringify(snap)}`;
}

/** AI 구문형 확장 프롬프트 (askJson) */
export function expandPrompt(data: Dataset): string {
  return `수면밀도(매트리스) 네이버 SA 롱테일 · 구문형 키워드 후보를 만든다. 제품 1개 × 고객 문제(${SKU_EXPANSION.problems.join(', ')}) × 구매 상황(${SKU_EXPANSION.situations.join(', ')}) × 비교 기준(${SKU_EXPANSION.criteria.join(', ')}) 조합에서, 실제 사람이 검색할 법한 2~5어절 구문을 20개 제안하라.
규칙: 이미 등록된 키워드와 중복 금지(${(data.keywords ?? []).map((k) => k.text).join(', ')}). 의료 효능 표현(치료 · 교정 · 통증 완화) 금지. 폐기 · 렌탈 등 구매 의도가 낮은 구문 금지. 경쟁사명 금지.
JSON 배열로만 답한다: [{"phrase": "구문", "intent": "brand|generic|problem|compare|life", "rationale": "근거 한 문장", "monthly": 추정 월 검색량(숫자)}]`;
}

export function copyPrompt(campaign: IntentId, hyp: HypId): string {
  const c = SA_CAMPAIGNS[campaign];
  const h = HYPOTHESES[hyp];
  return `네이버 파워링크 광고 문안을 만든다. 브랜드: 수면밀도(매트리스). 캠페인: ${c.name} (키워드 예: ${c.keywords.join(', ')} · 메시지 예: "${c.message}" · 랜딩: ${c.landing}). 가설 ${h.id} ${h.name}: ${h.focus}.
규칙: 제목 ${SA_CHAR_LIMITS.title}자 이내, 설명 ${SA_CHAR_LIMITS.description}자 이내(공백 포함). 의료 효능 암시(치료 · 교정 · 통증 완화 · 디스크) 금지, 최상급 · 순위 표현 금지, 절대 표현 금지, 경쟁사명 금지, 가격 · 할인율은 쓰지 않는다.
JSON 배열로만 답한다: [{"title": "...", "description": "...", "hypothesis": "${h.id}"}] 4개.`;
}

/** 주간 인사이트 브리프 초안 (p.28 주간 산출물 · 마크다운) */
export function weeklyDraft(data: Dataset, changes: readonly ChangeRequest[], cIn: Partial<LabCriteria> | null, cards: readonly TestCard[], patterns: readonly Pattern[]): string {
  const p = pipelineBrief(data, changes, cIn);
  const cr = creativeBrief(data, cards, patterns);
  const d = discoveryBrief(data, changes, [], cIn);
  // 단락 문장 (번호 · 글머리표 없이) — SPEC §0 문구 원칙, briefToMarkdown과 같은 형식
  const sec = (h: string, lines: string[]) => (lines.length ? `### ${h}\n${lines.join('\n\n')}\n` : '');
  // 다음 주간 발송일 — 운영 루프 캘린더와 같은 규칙 (월요일 · 공휴일이면 다음 영업일)
  const monday = nextBusinessDay(addDays(data.today, ((8 - weekday(data.today)) % 7) || 7));
  return [
    `## MILDO Lab 주간 인사이트 브리프 · ${fmtDate(monday)} 발송분`,
    `기준 ${fmtDate(data.today)} ${data.currentHour}시 · TEST DATA · 제안서 p.28 주간 산출물(개선 제안)`,
    '',
    sec('확정 팩트', [...p.facts.slice(0, 3), ...cr.facts.slice(0, 3), d.facts[1]].filter(Boolean)),
    sec('반복 관측 패턴', [...p.patterns, ...d.patterns.slice(0, 1)]),
    sec('AI 해석', [...p.interpretation.slice(0, 1), ...cr.interpretation.slice(0, 2)]),
    sec('전제 조건 · 기준값', [...p.conditions, ...cr.conditions]),
    sec('반례 · 대체 시나리오', [...p.counter, ...cr.counter]),
    sec('다음 액션', [...p.actions, ...cr.actions].slice(0, 6)),
  ].join('\n');
}

/** 화면 하단 AI 해석의 규칙 엔진 결과 — 판정 · 카드 · 발굴 브리프를 한 형식으로 합친다 */
export function labBrief(data: Dataset, changes: readonly ChangeRequest[], cIn: Partial<LabCriteria> | null, cards: readonly TestCard[], patterns: readonly Pattern[]): Brief {
  const p = pipelineBrief(data, changes, cIn);
  const c = creativeBrief(data, cards, patterns);
  const d = discoveryBrief(data, changes, [], cIn);
  return {
    title: 'MILDO Lab 운영 해석',
    facts: [...p.facts.slice(0, 3), ...c.facts.slice(0, 3), ...d.facts.slice(0, 2)],
    patterns: [...p.patterns.slice(0, 2), ...d.patterns.slice(0, 1), ...c.patterns.slice(0, 1)],
    interpretation: [...p.interpretation.slice(0, 2), ...c.interpretation.slice(0, 2)],
    conditions: [...p.conditions, ...c.conditions.slice(0, 1)],
    counter: [...p.counter, ...c.counter, ...d.counter.slice(0, 1)],
    actions: [...p.actions.slice(0, 2), ...c.actions.slice(0, 2), ...d.actions.slice(0, 1)],
  };
}

/* ================================================================== */
/* 화면 요약 · 오늘 처리할 항목 (첫 화면 상태)                            */
/* ================================================================== */

export type LabTabId = 'discover' | 'pipeline' | 'cards' | 'creative' | 'review' | 'loop';
export interface LabTodo { id: string; tone: 'critical' | 'warning' | 'accent' | 'neutral'; tab: LabTabId; label: string; title: string; basis: string; rank: number }

/** 첫 화면 요약 타일 + 오늘 처리할 항목 — 모든 항목에 판정 기준 · 근거 수치를 붙인다 */
export function labOverview(
  data: Dataset, changes: readonly ChangeRequest[] = [], cIn: Partial<LabCriteria> | null = null, cards: readonly TestCard[] = [],
  decisions: Record<string, CardDecision | undefined> = {}, extra: { aiCandidates?: readonly Candidate[]; aiCopies?: readonly AdCopy[]; role?: string } = {},
) {
  const crit = resolveCriteria(cIn);
  const role = extra.role ?? 'PM';
  const pipeline = buildPipeline(data, changes, crit);
  const ps = pipelineSummary(pipeline);
  const pools = groupPools(pipeline, crit);
  const disc = discoverCandidates(data, changes, extra.aiCandidates ?? [], crit.targetRoas);
  const sku = skuEntries(data, changes, crit.targetRoas);
  const fresh = disc.all.filter((c) => c.status === 'new' && c.purchase);
  const stNew = fresh.filter((c) => c.source === 'search_term');
  const stHigh = stNew.filter((c) => c.evidence && finite(c.evidence.ratioPct) && c.evidence.ratioPct >= crit.expandAtPct);
  const judged = cards.map((c) => ({ c, j: judgeTestCard(c, data.today) }));
  const review = reviewAll(data, collectCopies(data, cards, extra.aiCopies ?? []));
  const cal = loopCalendar(data.today, cards, decisions, 8);
  const incoming = incomingTests(changes).filter((x) => isOpenChange(x.change));
  const labPending = (changes ?? []).filter((c) => (c.module === 'lab' || isRegistration(c)) && c.status === 'pending');
  const mine = labPending.filter((c) => canApprove(role, c.approver).ok);
  const nextOf = (k: LoopEvent['cadence']) => cal.events.find((e) => e.cadence === k && e.date >= data.today) ?? null;

  const todos: LabTodo[] = [];
  const blocks = review.rows.filter((r) => r.result.level === 'block');
  if (blocks.length) {
    const first = blocks[0];
    const f = first.result.findings.find((x) => x.level === 'block');
    todos.push({
      id: 'review-block', tone: 'critical', tab: 'review', label: `차단 ${blocks.length}건`, rank: 0,
      title: `검수 차단 문안 ${blocks.length}건 — 집행 · 테스트 카드 등록 불가`,
      basis: `${first.item.source}: '${first.item.text}'${f ? ` · ${f.match} (${f.ruleId === 'price_claim' ? '판매가 대조 불일치' : ruleLabel(f.ruleId)})` : ''} · 차단 기준 REVIEW_RULES (p.27 · p.35)`,
    });
  }
  for (const { c, j } of judged) {
    if (decisions[c.id]) continue;
    if (j.verdict === 'stop') {
      todos.push({ id: `card-stop:${c.id}`, tone: 'critical', tab: 'cards', label: '중단 결정', rank: 1, title: `${c.id} ${c.title} — 중단 결정 필요`, basis: `${j.badge} · ${j.basis}` });
    } else if (j.verdict === 'expand') {
      todos.push({ id: `card-expand:${c.id}`, tone: 'accent', tab: 'cards', label: '확대 결정', rank: 2, title: `${c.id} ${c.title} — 확대 승인 요청 (PM)`, basis: `${j.badge} · 확대 범위: ${c.expandScope}` });
    }
  }
  if (ps.awaitingDecision) {
    const ds = pipeline.filter((i) => i.step === 4 && (!i.decision || !isActiveStatus(i.decision.status)));
    todos.push({
      id: 'pipe-decide', tone: 'accent', tab: 'pipeline', label: `STEP 4 · ${ds.length}건`, rank: 3,
      title: `키워드 판정 ${ds.length}건 — 반영 승인 요청 전`,
      basis: ds.slice(0, 2).map((i) => `'${i.phrase}' ${i.judgement.badge}`).join(' · '),
    });
  }
  if (ps.overdue) {
    const od = pipeline.filter((i) => i.overdue);
    const pool = pools[0];
    todos.push({
      id: 'pipe-overdue', tone: 'warning', tab: 'pipeline', label: `기한 경과 ${od.length}건`, rank: 4,
      title: `테스트 그룹 ${od.length}개 판정 기한 경과 — 판정 보류 · 표본 부족`,
      basis: `${Math.max(...od.map((i) => n0(i.days)))}일 집행 · 기준 ${crit.minDays}일 또는 클릭 ${crit.minClicks}회 · 판정 최소 클릭 ${crit.minJudgeClicks}회${pool ? ` · ${pool.adgroup} 합산 ${pool.judgement.badge}` : ''}`,
    });
  }
  for (const pr of livePromotions(data)) {
    const left = daysBetween(data.today, pr.end);
    if (!(finite(left) && left >= 0 && left <= 7)) continue;
    const affected = new Set([...sku, ...disc.all].filter((c) => c.landing.notes.some((n) => n.includes(pr.name))).map((c) => norm(c.phrase))).size;
    // 기획전명을 랜딩 · 문안에 그대로 쓴 카드 (공백 무시 비교)
    const cardsHit = cards.filter((c) => norm(`${c.control} ${c.variant} ${c.copyControl ?? ''} ${c.copyVariant ?? ''}`).includes(norm(pr.name))).map((c) => c.id);
    const parts = [
      `할인 ${pr.discountRate}%`,
      affected ? `기획전 랜딩 후보 ${affected}개 부분 매칭` : '',
      finite(pr.adCopyPrice) ? `소재 표기가 ${fmt.int(pr.adCopyPrice)}원 교체 대상` : '',
      cardsHit.length ? `${cardsHit.join(' · ')} 카드 랜딩 · 문안 영향` : '',
      '기준: 종료 7일 전부터 표시',
    ].filter(Boolean);
    todos.push({
      id: `promo-end:${pr.id}`, tone: 'warning', tab: affected ? 'discover' : 'review', label: `D-${left}`, rank: 5,
      title: `'${pr.name}' ${fmtDate(pr.end)} 종료 — ${affected ? '기획전 랜딩 · ' : ''}가격 문구 교체 일정`,
      basis: parts.join(' · '),
    });
  }
  if (stNew.length) {
    todos.push({
      id: 'disc-st', tone: 'neutral', tab: 'discover', label: `미등록 ${stNew.length}개`, rank: 6,
      title: `검색어 보고서 미등록 전환 구문 ${stNew.length}개 — 테스트 그룹 등록 후보`,
      basis: `목표 ROAS ${fmt.int(crit.targetRoas)}%의 ${crit.expandAtPct}% 이상 ${stHigh.length}개 · 우선 등급 ${stNew.filter((c) => c.tier === 'priority').length}개 (점수 ≥ ${SCORE_WEIGHTS.priority})`,
    });
  }
  if (incoming.length) {
    todos.push({
      id: 'incoming', tone: 'neutral', tab: 'cards', label: `수신 ${incoming.length}건`, rank: 7,
      title: `다른 모듈 테스트 요청 ${incoming.length}건 — 테스트 카드로 설계`,
      basis: incoming.slice(0, 2).map((x) => `${x.origin}: ${x.title}`).join(' · '),
    });
  }
  if (mine.length) {
    todos.push({
      id: 'mine', tone: 'neutral', tab: 'pipeline', label: `${role} 승인`, rank: 8,
      title: `현재 역할(${role})이 승인할 Lab 요청 ${mine.length}건`,
      basis: mine.slice(0, 3).map((c) => `${c.target} (${APPROVER_LABEL[c.approver]})`).join(' · '),
    });
  }
  todos.sort((a, b) => a.rank - b.rank);

  const cardCount: Partial<Record<CardVerdict, number>> = {};
  for (const { j } of judged) cardCount[j.verdict] = (cardCount[j.verdict] ?? 0) + 1;
  return {
    crit, pipeline, ps, pools, disc, sku, judged, review, cal, incoming, labPending, mine, todos,
    tiles: {
      discover: { fresh: fresh.length, priority: fresh.filter((c) => c.tier === 'priority').length, searchTerm: stNew.length, searchTermHigh: stHigh.length, sku48: sku.length, skuGood: sku.filter((c) => c.landing.level === 'good').length },
      pipeline: { total: ps.total, byStep: ps.byStep, awaiting: ps.awaitingDecision, overdue: ps.overdue, byVerdict: ps.byVerdict },
      cards: { total: cards.length, byVerdict: cardCount, decided: cards.filter((c) => decisions[c.id]).length },
      review: { total: review.total, ...review.count },
      loop: { weekly: nextOf('weekly'), testEnd: nextOf('test_end'), monthly: nextOf('monthly') },
    },
  };
}

/** 수신 요청 초안의 매체 · 지면 — 테스트 카드 폼의 선택지와 같은 문자열 */
export const INCOMING_MEDIA = { pilot: '신규 매체 파일럿' } as const;

/** 다른 모듈 테스트 요청 → 테스트 카드 초안 (가설 · 변수 추정) */
export function incomingToDraft(x: IncomingTest): { title: string; hypothesis: string; variable: CardVariable; media: string; intent: IntentId | null; control: string; variant: string; primary: CardMetric } {
  const c = x.change;
  const reason = String(c.reason ?? '');
  const hyp = reason.match(/가설:\s*([^.]+?)(?:\.|$)/)?.[1]?.trim();
  const blob = `${c.target} ${x.before} ${x.after} ${reason}`;
  const variable: CardVariable = /(소재|메시지|문구|카피)/.test(blob) ? '메시지' : /(랜딩|상세|기획전 페이지)/.test(blob) ? '랜딩' : '타겟';
  const media = /(파일럿|신규 매체)/.test(blob) ? INCOMING_MEDIA.pilot
    : /GFA/.test(blob) ? '네이버 GFA · Prospecting' : /(Meta|메타)/.test(blob) ? 'Meta · 넓은 타겟' : /(Google|구글)/.test(blob) ? 'Google · Demand Gen' : /카카오/.test(blob) ? '카카오 · 리마케팅' : '네이버 SA';
  const ci = classifyIntent(blob);
  return {
    title: String(c.target ?? '').slice(0, 60),
    hypothesis: hyp && hyp.length >= 10 ? hyp : `${String(c.target ?? '')} 변경을 소액으로 적용하면 같은 예산 대비 증분 전환이 늘어난다`,
    variable, media, intent: media === '네이버 SA' ? ci.intent : null,
    control: x.before || '기존 운영', variant: x.after, primary: variable === '메시지' ? 'ctr' : 'cvr',
  };
}
