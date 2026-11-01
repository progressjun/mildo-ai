/**
 * MILDO Lab 전용 상수 · 시드 — 각 값 옆에 출처(장표 번호) 또는 '모듈 가정' · 'DEMO'를 남긴다.
 * 제안서 기준값은 src/data/constants.ts 를 그대로 가져오고, 여기에는 화면 · 판정 보조 기준과 시연용 시드만 둔다.
 * DEMO 표기 항목은 시연용 테스트 데이터이며 실제 성과 · 실제 검색량이 아니다.
 */
import type { IntentId } from '@/core/types';
import { AD_PILOT, KEYWORD_TEST_RULES, TEST_CARD_RULES } from '@/data/constants';
import { addDays, hashString, rng } from '@/core/util';
import type { CardDay, LabCriteria, Pattern, TestCard } from './engine';

/* ============================== 판정 기준 ============================== */

/** p.26 키워드 테스트 판정 기본값 — "판정 기준값은 온보딩 기간 중 수면밀도 목표 ROAS에 맞춰 확정" */
export const LAB_DEFAULT_CRITERIA: LabCriteria = {
  targetRoas: AD_PILOT.targetRoas, // 400% · p.14 목표 ROAS 초기값 (온보딩 중 확정)
  expandAtPct: KEYWORD_TEST_RULES.expandAtPct, // 100 · p.26 확장 = 목표 ROAS 100% 이상
  keepFromPct: KEYWORD_TEST_RULES.keepFromPct, // 70 · p.26 유지 = 목표 ROAS 70~100%
  minDays: KEYWORD_TEST_RULES.minDays, // 14 · p.26 STEP 2 "14일"
  minClicks: KEYWORD_TEST_RULES.minClicks, // 100 · p.26 STEP 2 "최소 클릭 수" (초기값)
  minJudgeClicks: 30, // 모듈 가정 — 기간(14일)이 지나도 클릭 30회 미만이면 판정 보류 · 표본 부족
};

/** p.28 테스트 카드 기준 + 통계 판정 보조값 */
export const CARD_RULES = {
  days: TEST_CARD_RULES.days, // 14 · p.28 기간 "14일 또는 최소 표본 도달"
  stopDay: TEST_CARD_RULES.stopDay, // 7 · p.28 중단 "7일 차"
  stopCvrDropPct: TEST_CARD_RULES.stopCvrDropPct, // 30 · p.28 중단 "전환율 기존 대비 −30%"
  expandCvrLiftPct: TEST_CARD_RULES.expandCvrLiftPct, // 15 · p.28 확대 "전환율 +15% → 같은 의도 그룹 전체 적용"
  alpha: 0.05, // 모듈 가정 — 두 비율 z-검정 유의수준 (양측)
  power: 0.8, // 모듈 가정 — 필요 표본 계산 검정력
  stopMinConversions: 10, // 모듈 가정 — 기존안 전환 10건 미만이면 중단 판정을 하지 않음 (소표본 오탐 방지)
  wrapupDays: 14, // p.28 "액션 후 2주 — 랩업 · 결과 판정"
  directionalPct: 10, // 모듈 가정 — CPA · ROAS(비율 지표)는 ±10% 이상일 때만 방향 우세/열위로 표기
};

/** 일괄 요청 안전 기준 — p.45 '대량 변경 실수' 탐지 취지를 Lab 일괄 요청에 준용 (모듈 가정) */
export const LAB_BULK = { pmFrom: 6, max: 10 };

/** 네이버 파워링크 글자수 기준 (SPEC §4 lab: 제목 15자 · 설명 45자, 공백 포함 기준 · 매체 최신 정책 확인) */
export const SA_CHAR_LIMITS = { title: 15, description: 45 };

/* ============================ 발굴 · SKU 확장 ============================ */

/**
 * p.36 제한된 SKU 확장 전략 — 라벨은 constants.SKU_EXPANSION 과 같아야 한다 (테스트로 검증).
 * phrase: 구문형 키워드에 들어갈 검색어 표현 / volumeTokens: 데이터 키워드 월간 검색량을 찾을 토큰
 */
export const SKU_TOKENS = {
  problems: [
    { label: '허리 통증', phrase: '허리 편한', volumeTokens: ['허리'], topic: '허리' },
    { label: '꺼짐 · 처짐', phrase: '꺼짐 없는', volumeTokens: ['꺼짐', '처짐'], topic: '꺼짐' },
    { label: '더위 · 통기', phrase: '통기성 좋은', volumeTokens: ['통기'], topic: '통기' },
    { label: '뒤척임 소음', phrase: '소음 적은', volumeTokens: ['소음', '뒤척'], topic: '소음' },
  ],
  situations: [
    { label: '신혼', phrase: '신혼집', volumeTokens: ['신혼'], topic: '신혼' },
    { label: '이사 · 첫 독립', phrase: '첫 독립', volumeTokens: ['이사', '첫 독립', '자취'], topic: '첫 독립' },
    { label: '아이 방', phrase: '아이방', volumeTokens: ['아이방'], topic: '아이방' },
    { label: '부모님 선물', phrase: '부모님 선물', volumeTokens: ['부모님', '선물'], topic: '선물' },
  ],
  criteria: [
    { label: '경도', phrase: '경도', weight: 1.0, topic: '경도' },
    { label: '사이즈', phrase: '사이즈', weight: 1.2, topic: '사이즈' },
    { label: '소재 · 구조', phrase: '구조', weight: 0.7, topic: '구조' },
  ],
} as const;

/** 롱테일 검색량 추정 가정 (모듈 가정 · 데모 추정 — 실제 값은 네이버 키워드 도구 조회 후 확정) */
export const SKU_VOLUME = {
  longTailFactor: 0.05, // 상황 · 문제 키워드 검색량 기하평균의 5%가 결합 구문으로 들어온다고 가정
  fallbackMonthly: 300, // 데이터 키워드에 토큰이 없을 때 기본 월 검색량 가정
  min: 10,
};

/** 우선순위 점수 배점 (모듈 가정 — 화면에 그대로 표기) */
export const SCORE_WEIGHTS = { volume: 40, landing: 30, evidence: 20, intent: 10, volumeCap: 5000, priority: 70, review: 50 };

/**
 * 랜딩 콘텐츠 매핑 (모듈 가정) — URL은 데모 데이터 키워드 랜딩과 같다. 실제 페이지 구성 점검은 SearchTuneOS 제품페이지 진단에서 한다.
 * topics: 해당 랜딩이 다루는 선택 기준 · 상황
 */
export const LANDING_CATALOG: { key: string; label: string; url: string; intents: IntentId[]; topics: string[]; promo?: boolean; product?: boolean }[] = [
  { key: 'guide', label: '선택 가이드', url: 'https://mildo.kr/guide', intents: ['problem'], topics: ['경도', '허리', '단단', '푹신', '사이즈', '구조', '소재', '교체'] },
  { key: 'event', label: '기획전 · 자사몰', url: 'https://mildo.kr/event', intents: ['life'], topics: ['신혼', '혼수', '이사', '집들이', '선물', '부모님', '할인', '기획전'], promo: true },
  { key: 'products', label: '상품 상세', url: 'https://brand.naver.com/mildo/products', intents: ['generic', 'compare'], topics: ['사이즈', '퀸', '킹', '슈퍼싱글', '가격', '구조', '스프링', '리뷰', '후기', '배송', '설치', '비교', '추천'], product: true },
  { key: 'brand', label: '브랜드스토어 메인', url: 'https://brand.naver.com/mildo', intents: ['brand'], topics: ['수면밀도', '밀도'] },
];

/** 구문에서 찾는 선택 기준 · 상황 토픽 (랜딩 매칭용) */
export const PHRASE_TOPICS = [
  '수면밀도', '밀도', '경도', '허리', '단단', '푹신', '사이즈', '구조', '소재', '교체', '신혼', '혼수', '이사', '집들이', '선물', '부모님', '할인', '기획전',
  '퀸', '킹', '슈퍼싱글', '가격', '스프링', '리뷰', '후기', '배송', '설치', '비교', '추천', '소음', '통기', '꺼짐', '아이방', '자취', '첫 독립',
];

/** 연관 검색어 (DEMO — 네이버 연관 검색어 · 월간 검색량 데모 스냅샷, 실제 수치 아님) */
export const RELATED_SEEDS: { seed: string; term: string; monthly: number }[] = [
  { seed: '신혼 매트리스', term: '신혼 매트리스 퀸 사이즈', monthly: 720 },
  { seed: '신혼 매트리스', term: '신혼부부 매트리스 추천', monthly: 1900 },
  { seed: '이사 매트리스', term: '이사 매트리스 버리기', monthly: 1300 },
  { seed: '이사 매트리스', term: '이사 후 매트리스 교체', monthly: 260 },
  { seed: '매트리스 경도', term: '매트리스 경도 비교', monthly: 590 },
  { seed: '매트리스 경도', term: '단단한 매트리스 추천', monthly: 2400 },
  { seed: '허리 편안한 매트리스', term: '허리 편한 매트리스 경도', monthly: 480 },
  { seed: '허리 편안한 매트리스', term: '허리 디스크 매트리스', monthly: 2900 },
  { seed: '아이방 매트리스', term: '아이방 매트리스 슈퍼싱글', monthly: 320 },
  { seed: '아이방 매트리스', term: '초등학생 매트리스 추천', monthly: 880 },
  { seed: '킹 매트리스', term: '킹 사이즈 매트리스 추천', monthly: 1600 },
  { seed: '매트리스 추천', term: '매트리스 브랜드 추천', monthly: 2200 },
  { seed: '매트리스 추천', term: '매트리스 렌탈 추천', monthly: 900 },
  { seed: '통기성 좋은 매트리스', term: '여름 매트리스 추천', monthly: 1100 },
];

/** AI 검색 질의 (DEMO — AI 검색 질의 수집 데모 스냅샷 · 월 검색 전환 추정치는 가정) */
export const AI_QUERY_SEEDS: { engine: string; query: string; phrase: string; monthly: number }[] = [
  { engine: 'ChatGPT', query: '신혼집 매트리스 퀸이랑 킹 중에 뭐가 나아?', phrase: '신혼집 매트리스 퀸 킹 비교', monthly: 260 },
  { engine: '네이버 AI 브리핑', query: '허리가 자주 뻐근한데 매트리스 경도는 어떻게 골라?', phrase: '허리 편한 매트리스 경도 선택', monthly: 210 },
  { engine: 'Perplexity', query: '여름에 덥지 않은 매트리스 소재 추천해줘', phrase: '통기성 매트리스 소재 추천', monthly: 170 },
  { engine: 'Gemini', query: '부모님 선물로 매트리스 사도 괜찮을까', phrase: '부모님 선물 매트리스 추천', monthly: 320 },
  { engine: 'ChatGPT', query: '첫 자취방 매트리스 슈퍼싱글이면 충분해?', phrase: '자취방 슈퍼싱글 매트리스', monthly: 290 },
  { engine: 'Google AI 개요', query: '독립스프링이랑 메모리폼 차이가 뭐야', phrase: '독립스프링 메모리폼 비교', monthly: 540 },
  { engine: '네이버 AI 브리핑', query: '아이 방 매트리스는 몇 년마다 바꿔야 해', phrase: '아이방 매트리스 교체 주기', monthly: 140 },
  { engine: 'Perplexity', query: '매트리스 꺼짐 생기면 보상 받을 수 있어?', phrase: '매트리스 꺼짐 보증 기간', monthly: 230 },
];

/* ============================ VisualTune OS ============================ */

export type HypId = 'A' | 'B' | 'C';

/** p.27 가설 A · B · C (예시 카피 — 수치 · 조건 주장은 근거 확인 필요) */
export const HYPOTHESES: Record<HypId, { id: HypId; name: string; focus: string; copy: string; role: string; claimNote: string | null }> = {
  A: { id: 'A', name: '기능 중심', focus: '경도 · 소재 · 구조', copy: '경도 · 소재 · 구조로 고르는 매트리스', role: '비교 · 검토 단계 고객에게 선택 기준을 먼저 제시', claimNote: null },
  B: { id: 'B', name: '리뷰 · 신뢰 중심', focus: '누적 리뷰 · 구매 후기', copy: '누적 리뷰 6만 개가 고른 매트리스', role: '구매 직전 고객의 불확실성(실사용 평가) 해소', claimNote: '리뷰 수 6만 개는 집계 기준일 · 채널 합산 여부 확인 후 사용' },
  C: { id: 'C', name: '구매 혜택 중심', focus: '배송 · 설치 · 혜택', copy: '전국 무료배송 · 전문 기사 설치', role: '가격 · 배송 부담으로 이탈하는 고객의 구매 결정 지원', claimNote: '배송 · 설치 조건(지역 · 추가 비용 · 계단 운반) 확인 후 사용' },
};
export const HYP_IDS: HypId[] = ['A', 'B', 'C'];

/** p.27 테스트 규칙 */
export const CREATIVE_RULES = [
  { id: 'one_var', label: '한 번에 한 변수', detail: '메시지 / 랜딩 / 타겟 중 하나만 바꾸고 나머지는 고정한다' },
  { id: 'same_target', label: '동일 타겟 · 유사 예산', detail: '두 안의 타겟 · 입찰 전략 · 예산 비중을 같게 둔다 (예산 차이 ±10% 이내 · 모듈 가정)' },
  { id: 'period', label: '14일 또는 최소 표본 도달', detail: '요일 효과를 지우기 위해 최소 14일, 표본 미달이면 판정 보류' },
  { id: 'order', label: '판정 순서 CTR → CVR → CPA → ROAS', detail: '앞 지표가 이겨도 뒤 지표(CVR 유의 열위 · CPA/ROAS ±10% 이상 열위)가 지면 확대하지 않는다' },
] as const;

/** 캠페인별 문안 핵심어 (p.35 키워드 예시에서 한 개씩) */
export const COPY_HEADS: Record<IntentId, string> = {
  brand: '수면밀도',
  generic: '퀸 매트리스',
  problem: '매트리스 경도',
  compare: '매트리스 비교',
  life: '신혼 매트리스',
};

/** VisualTune OS 베리에이션 초안 — 검수 대기 문안 (DEMO · 승인 전 초안, 검수 에이전트 시연용) */
export const VISUALTUNE_DRAFTS: { id: string; hypothesis: HypId; text: string; channel: string }[] = [
  { id: 'vt_1', hypothesis: 'A', text: '허리 통증 완화에 좋은 매트리스, 경도로 고르세요', channel: 'GFA 피드' },
  { id: 'vt_2', hypothesis: 'B', text: '국내 판매 1위 매트리스, 누적 리뷰 6만 개', channel: 'Meta 피드' },
  { id: 'vt_3', hypothesis: 'C', text: '가을 기획전 20% 할인 792,000원 · 무료배송', channel: 'GFA 배너' },
  { id: 'vt_4', hypothesis: 'A', text: '지누스보다 단단한 독립스프링 구조', channel: 'Meta 릴스' },
  { id: 'vt_5', hypothesis: 'C', text: '킹 사이즈 무료배송 · 전문 기사 설치', channel: '카카오 비즈보드' },
  { id: 'vt_6', hypothesis: 'C', text: '가을 이사 · 혼수 기획전 퀸 841,500원', channel: 'GFA 배너' },
  { id: 'vt_7', hypothesis: 'B', text: '의사 추천 척추 교정 매트리스, 100% 만족 보장', channel: 'Meta 피드' },
];

/** 자유 입력 검수 예시 */
export const REVIEW_SAMPLES = [
  '허리 디스크 치료에 도움되는 매트리스',
  '네이버 가구 부문 판매 1위 (2026년 상반기 기준) 수면밀도',
  '오늘의집 집들이 위크 12% 할인 871,200원',
  '11월 기획전 18% 할인 · 무조건 최저가',
  '경도 · 소재 · 구조로 고르는 매트리스',
];

/** 의료 효능 표현 뒤에 붙는 '도움되는 · 좋은' 류 수식어까지 함께 치환 */
const HELPFUL = '(\\s?(도움\\s?되는|도움이\\s?되는|효과\\s?있는|효과적인|좋은))?';

/** 자동 수정 제안 치환표 (검수 결과 초안 — 담당자 확인 후 사용) */
export const REVIEW_FIXES: { ruleId: string; pattern: string; replace: string }[] = [
  { ruleId: 'medical_cure', pattern: `(허리\\s?)?디스크\\s?(치료|개선|예방|완화)(에|용)?${HELPFUL}`, replace: '허리 부담을 고려한 ' },
  { ruleId: 'medical_device', pattern: '척추\\s?교정', replace: '체압 분산' },
  { ruleId: 'medical_cure', pattern: `통증\\s?(제거|해소|완화)(에|용)?${HELPFUL}`, replace: '편안한 지지감의 ' },
  { ruleId: 'medical_cure', pattern: `(치료|완치|치유)(에|용|효과)?${HELPFUL}`, replace: '' },
  { ruleId: 'medical_cure', pattern: '교정', replace: '지지' },
  { ruleId: 'medical_cure', pattern: '(낫는|낫게|회복시키는|회복시)', replace: '' },
  { ruleId: 'medical_device', pattern: '(의료기기|의학적으로|의학적|임상\\s?(입증|증명)(된)?)', replace: '' },
  { ruleId: 'medical_device', pattern: '(병원|의사)\\s?추천', replace: '구매 고객 리뷰로 고른' },
  { ruleId: 'superlative', pattern: '(국내\\s?최대|넘버원|No\\.?\\s?1|최고의|최고|최상의|최상|최초|유일한|유일)', replace: '' },
  { ruleId: 'absolute', pattern: '(100%\\s?(만족|보장)?\\s?(보장)?|무조건|절대|완벽한|완벽하게|완벽|영구적인|영구)', replace: '' },
  { ruleId: 'competitor', pattern: '(베스트슬립|웰퍼니처|퀵슬립|올라인매트리스|지누스|휴도)(보다|대비|처럼)?', replace: '' },
];

/** Lab 추가 검수 규칙 (REVIEW_RULES 보완 · 모듈 가정) */
export const EXTRA_REVIEW_RULES = [
  { id: 'numeric_claim', level: 'check' as const, reason: '수치 주장 — 집계 기준일 · 출처 · 채널 합산 여부 확인 (p.27 "수치 주장은 근거 확인 필요")' },
  { id: 'service_claim', level: 'check' as const, reason: '배송 · 설치 · 보증 조건 표기 — 지역 · 추가 비용 · 기간을 판매 조건과 대조' },
  { id: 'soldout_option', level: 'warn' as const, reason: '품절 옵션 언급 — 랜딩에서 구매할 수 없는 옵션 (상품 재고 데이터 대조 · p.45 품절 랜딩)' },
  { id: 'length', level: 'warn' as const, reason: '글자수 초과 — 네이버 파워링크 제목 15자 · 설명 45자 기준' },
  { id: 'lowest_price', level: 'warn' as const, reason: '최저가 표기 — 비교 대상 · 기간 · 조사 기준 없는 최저가 주장은 표시광고 리스크' },
];

/* ============================ 테스트 카드 (DEMO) ============================ */

function genDays(seed: string, n: number, p: { imps: number; ctr: number; cvr: number; cpc: number; aov: number }): CardDay[] {
  const R = rng(hashString(seed));
  const out: CardDay[] = [];
  for (let i = 0; i < Math.max(0, n); i++) {
    const impressions = Math.round(p.imps * R.noise(0.06));
    const clicks = Math.round(((impressions * p.ctr) / 100) * R.noise(0.04));
    const conversions = Math.max(0, Math.round(((clicks * p.cvr) / 100) * R.noise(0.15)));
    const cost = Math.round(clicks * p.cpc * R.noise(0.03));
    const revenue = Math.round(conversions * p.aov * R.noise(0.04));
    out.push({ impressions, clicks, conversions, cost, revenue });
  }
  return out;
}

/**
 * 진행 중 테스트 카드 3개 (DEMO · 시연용 테스트 데이터). 시작일은 데이터 기준일에서 역산하고,
 * 판정은 engine.judgeTestCard가 아래 일자별 수치로 계산한다 (판정 결과를 여기서 정하지 않는다).
 */
export function demoTestCards(today: string): TestCard[] {
  const mk = (id: string, startOffset: number, base: Omit<TestCard, 'id' | 'start' | 'dailyC' | 'dailyV' | 'source'>, c: Parameters<typeof genDays>[2], v: Parameters<typeof genDays>[2]): TestCard => {
    const start = addDays(today, -startOffset);
    return { id, start, source: 'demo', ...base, dailyC: genDays(`${id}:C:${today}`, startOffset, c), dailyV: genDays(`${id}:V:${today}`, startOffset, v) };
  };
  const common = { plannedDays: CARD_RULES.days, minClicksPerArm: null, stopDay: CARD_RULES.stopDay, stopDropPct: CARD_RULES.stopCvrDropPct, expandLiftPct: CARD_RULES.expandCvrLiftPct };
  return [
    mk('TC-01', 14, {
      ...common,
      title: '문제 해결형 키워드 × 선택 가이드 랜딩',
      hypothesis: '문제 해결형 키워드에 선택 가이드 랜딩을 연결하면 전환율이 오른다',
      variable: '랜딩', media: '네이버 SA', intent: 'problem', primary: 'cvr', metricsLabel: '전환율 · ROAS',
      control: '상품 상세 랜딩 (기존)', variant: '선택 가이드 랜딩 (경도 · 사이즈 · 구조 비교)',
      expandScope: '문제 해결 캠페인 전체 랜딩을 선택 가이드로 교체',
    }, { imps: 24000, ctr: 2.6, cvr: 1.15, cpc: 760, aov: 1_060_000 }, { imps: 24000, ctr: 2.6, cvr: 1.6, cpc: 760, aov: 1_040_000 }),
    mk('TC-02', 9, {
      ...common,
      title: 'VisualTune 메시지 A 기능 vs B 리뷰 · 신뢰',
      hypothesis: '리뷰 · 신뢰 메시지가 기능 메시지보다 Prospecting 신규 고객의 클릭률을 높이고 전환율은 유지한다',
      variable: '메시지', media: '네이버 GFA · Prospecting', intent: null, primary: 'ctr', metricsLabel: 'CTR → CVR → CPA → ROAS',
      control: '가설 A · 경도 · 소재 · 구조로 고르는 매트리스', variant: '가설 B · 누적 리뷰 6만 개가 고른 매트리스',
      expandScope: 'Prospecting 기본 소재를 B 메시지로 교체 (리타겟팅은 별도 테스트)',
      copyControl: '경도 · 소재 · 구조로 고르는 매트리스', copyVariant: '누적 리뷰 6만 개가 고른 매트리스',
    }, { imps: 42000, ctr: 0.55, cvr: 0.34, cpc: 410, aov: 1_020_000 }, { imps: 42000, ctr: 0.66, cvr: 0.33, cpc: 400, aov: 1_020_000 }),
    mk('TC-03', 8, {
      ...common,
      title: '생활 상황 키워드 × 기획전 랜딩',
      hypothesis: '생활 상황(신혼 · 이사) 키워드를 기획전 랜딩으로 보내면 혜택 노출로 전환율이 오른다',
      variable: '랜딩', media: '네이버 SA', intent: 'life', primary: 'cvr', metricsLabel: '전환율 · ROAS',
      control: '상품 상세 (사이즈 옵션 상단)', variant: '가을 이사 · 혼수 기획전 랜딩',
      expandScope: '생활 상황 캠페인 전체를 기획전 랜딩으로 전환',
    }, { imps: 15000, ctr: 2.6, cvr: 1.35, cpc: 760, aov: 1_050_000 }, { imps: 15000, ctr: 2.6, cvr: 0.82, cpc: 760, aov: 980_000 }),
  ];
}

/** 이긴 패턴 라이브러리 시드 (DEMO · 가상 이력 — 실제 테스트 결과 아님) */
export const PATTERN_SEEDS: Pattern[] = [
  {
    id: 'pt_demo_1', title: '생활 상황 키워드 → 사이즈 비교 블록이 상단에 있는 상품 상세', scope: '네이버 SA · 생활 상황', metric: 'CVR', lift: 22, p: 0.03,
    period: '2026-09-01 ~ 09-14', applied: '생활 상황 캠페인 랜딩 상단에 사이즈 비교 고정', condition: '신혼 · 이사 키워드 한정 · 군당 클릭 약 3,100',
    counter: '아이방 키워드는 차이 없음 (CVR +3%, p=0.71) — 사이즈보다 안전 · 소재 정보가 우선', source: 'demo',
  },
  {
    id: 'pt_demo_2', title: 'GFA Prospecting 구매 혜택 메시지 — CTR 우세 · CVR 동일', scope: '네이버 GFA · Prospecting', metric: 'CTR', lift: 17, p: 0.004,
    period: '2026-09-15 ~ 09-28', applied: 'Prospecting 기본 소재를 혜택 메시지로 교체 · 리타겟팅은 기능 메시지 유지', condition: '신규 고객 비중 80% 이상 광고그룹',
    counter: 'CVR −2% (p=0.82) — 클릭 품질 차이는 확인되지 않음, CPA 개선은 CTR 상승분 범위', source: 'demo',
  },
  {
    id: 'pt_demo_3', title: '브랜드 키워드 설명문에 공식 브랜드스토어 명시', scope: '네이버 SA · 브랜드 방어', metric: 'CTR', lift: 9, p: 0.02,
    period: '2026-10-01 ~ 10-14', applied: '브랜드 방어 캠페인 전 소재 설명문 1행 고정', condition: '브랜드 지면에 경쟁사 노출이 있는 날 효과가 큼',
    counter: '경쟁사 노출이 없는 날은 CTR 차이 +2% 수준 (p=0.4)', source: 'demo',
  },
];

/* ============================ 운영 루프 (p.28) ============================ */

export type LoopCadenceId = 'weekly' | 'monthly' | 'quarterly' | 'wrapup' | 'adhoc';
export const LOOP_CADENCE: { id: LoopCadenceId; cycle: string; content: string; output: string; rule: string }[] = [
  { id: 'weekly', cycle: '주간', content: '인사이트 브리프 · 이슈 리마인드', output: '개선 제안', rule: '매주 월 10:00 (p.17 주간 리포트와 같은 시각) · 공휴일이면 다음 영업일' },
  { id: 'monthly', cycle: '월간', content: '성과 리뷰 · 테스트 결과 정리', output: '예산 재배분안', rule: '익월 3영업일 (p.17 월간 리포트)' },
  { id: 'quarterly', cycle: '분기', content: '성장 전략 리뷰 · 네이버 3자 미팅 연계', output: '다음 분기 가설', rule: '분기 마지막 달 셋째 주 수요일 (모듈 가정 · 3자 미팅 일정 협의)' },
  { id: 'wrapup', cycle: '액션 후 2주', content: '랩업 · 결과 판정', output: '확대 · 중단 · 모니터링 지속', rule: '테스트 판정(확대 · 중단 · 모니터링) 결정일 + 14일' },
  { id: 'adhoc', cycle: '수시', content: '파트너 매체 · 내부 레퍼런스 인사이트 공유', output: '이슈 리마인드', rule: '발생 시 공유 · 다음 주간 브리프에 병합' },
];
