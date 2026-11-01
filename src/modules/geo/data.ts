/**
 * SearchTuneOS · GEO 전용 상수 · 데모 진단 시드.
 *
 * 출처
 *  - 제안서 p.29 「GEO · AI 검색 대응」 네 축(SEO·구조화 데이터 / AEO 콘텐츠 / GEO 모니터링 / 페이드 AI 지면),
 *    "노출 순위 보장이 아닌 정기 진단 · 개선 방식", 적용 사례 공란 "[브랜드 · 진단 전후 브랜드 언급률 · 인용 수 입력]"
 *  - 제안서 p.9 AI 엔진 SearchTuneOS: 제품페이지 진단, AI 검색 질의별 브랜드 노출 · 인용 점검 / 지표: 검색 커버리지 · 브랜드 언급률
 *  - 제안서 p.27 · p.35 의료 효능 암시 표현 제외 (검수는 constants.ts의 REVIEW_RULES를 그대로 사용)
 *
 * 진단 임계값(제목 길이 · 언급 엔진 수 등)은 제안서에 수치가 없으므로 "운영 초기 기준 · 온보딩 중 확정"으로 둔다.
 * GEO 진단 스냅샷은 시연용 테스트 데이터(DEMO)다. 실제 엔진 응답이 아니며, 실데이터는 수집 연동 후 같은 구조로 채운다.
 */
import type { IntentId } from '@/core/types';

/* ------------------------------ p.29 네 축 ------------------------------ */

export type GeoTabId = 'monitor' | 'audit' | 'faq' | 'paid' | 'case';

export const GEO_AXES = [
  { id: 'seo', name: 'SEO · 구조화 데이터', scope: '제품페이지 메타 · 제목 · 이미지 ALT · JSON-LD 일치 여부', tab: 'audit' as GeoTabId, page: 'p.29' },
  { id: 'aeo', name: 'AEO 콘텐츠', scope: '경도 · 소재 · 사이즈 · 선택 기준 FAQ', tab: 'faq' as GeoTabId, page: 'p.29' },
  { id: 'geo', name: 'GEO 모니터링', scope: '주요 AI 질의별 브랜드 언급 · 인용 출처 · 경쟁사 비교', tab: 'monitor' as GeoTabId, page: 'p.29' },
  { id: 'paid', name: '페이드 AI 지면', scope: '네이버 AI 요약 · 쇼핑 지면 노출 점검 → SA 키워드에 반영', tab: 'paid' as GeoTabId, page: 'p.29' },
] as const;

/** p.29 문구 (원문 그대로) */
export const GEO_INTRO = 'SearchTuneOS로 AI 검색이 수면밀도를 어떻게 이해하고 인용하는지 진단하고, 오가닉 · 페이드 양쪽에서 대응합니다.';
export const GEO_PRINCIPLE = '노출 순위 보장이 아닌 정기 진단 · 개선 방식으로 운영합니다.';
export const GEO_CASE_BLANK = '[브랜드 · 진단 전후 브랜드 언급률 · 인용 수 입력]';
/** p.9 SearchTuneOS 측정 지표 */
export const GEO_METRICS = '검색 커버리지 · 브랜드 언급률';

/* ------------------------------ 엔진 ------------------------------ */

export type GeoEngineId = 'chatgpt' | 'gemini' | 'perplexity' | 'naver_ai' | 'google_aio';

export interface GeoEngineDef {
  id: GeoEngineId;
  name: string;
  short: string;
  /** 엔티티 고정 색 슬롯 (순위로 바꾸지 않음) */
  colorVar: string;
  /** 데모 생성 가정: 기본 브랜드 언급 확률 */
  mentionBase: number;
  /** 데모 생성 가정: 언급 시 경쟁사가 앞에 올 확률 */
  aheadProb: number;
  citeMin: number;
  citeMax: number;
  /** 데모 생성 가정: 경쟁사별 언급 확률 */
  competitorWeights: Record<string, number>;
  /** 데모 생성 가정: 인용 출처 풀 (도메인 · 가중치) */
  citePool: { domain: string; weight: number }[];
}

export const GEO_ENGINES: GeoEngineDef[] = [
  {
    id: 'chatgpt', name: 'ChatGPT', short: 'ChatGPT', colorVar: '--series-3', mentionBase: 0.26, aheadProb: 0.55, citeMin: 0, citeMax: 2,
    competitorWeights: { 지누스: 0.62, 베스트슬립: 0.34, 퀵슬립: 0.3, 올라인매트리스: 0.24, 웰퍼니처: 0.18, 휴도: 0.14 },
    citePool: [{ domain: 'namu.wiki', weight: 3 }, { domain: 'blog.naver.com', weight: 3 }, { domain: 'news', weight: 2 }, { domain: 'mildo.kr', weight: 1.5 }, { domain: 'ohou.se', weight: 1 }],
  },
  {
    id: 'gemini', name: 'Gemini', short: 'Gemini', colorVar: '--series-7', mentionBase: 0.24, aheadProb: 0.55, citeMin: 0, citeMax: 2,
    competitorWeights: { 지누스: 0.58, 베스트슬립: 0.3, 퀵슬립: 0.28, 올라인매트리스: 0.22, 웰퍼니처: 0.2, 휴도: 0.16 },
    citePool: [{ domain: 'youtube.com', weight: 3 }, { domain: 'blog.naver.com', weight: 2.5 }, { domain: 'tistory.com', weight: 1.5 }, { domain: 'mildo.kr', weight: 1.2 }, { domain: 'coupang.com', weight: 1 }],
  },
  {
    id: 'perplexity', name: 'Perplexity', short: 'Perplexity', colorVar: '--series-2', mentionBase: 0.34, aheadProb: 0.5, citeMin: 3, citeMax: 5,
    competitorWeights: { 지누스: 0.55, 베스트슬립: 0.4, 퀵슬립: 0.36, 올라인매트리스: 0.3, 웰퍼니처: 0.24, 휴도: 0.2 },
    citePool: [
      { domain: 'blog.naver.com', weight: 3 }, { domain: 'ohou.se', weight: 2 }, { domain: 'ppomppu.co.kr', weight: 1.5 }, { domain: 'youtube.com', weight: 1.5 },
      { domain: 'mildo.kr', weight: 1.6 }, { domain: 'brand.naver.com/mildo', weight: 1.2 }, { domain: 'coupang.com', weight: 1 }, { domain: 'news', weight: 1 },
    ],
  },
  {
    id: 'naver_ai', name: '네이버 AI 브리핑', short: '네이버 AI', colorVar: '--series-6', mentionBase: 0.86, aheadProb: 0.38, citeMin: 2, citeMax: 4,
    competitorWeights: { 베스트슬립: 0.5, 퀵슬립: 0.46, 올라인매트리스: 0.42, 지누스: 0.36, 웰퍼니처: 0.32, 휴도: 0.26 },
    citePool: [
      { domain: 'blog.naver.com', weight: 4 }, { domain: 'cafe.naver.com', weight: 2.5 }, { domain: 'kin.naver.com', weight: 1.5 },
      { domain: 'brand.naver.com/mildo', weight: 2 }, { domain: 'shopping.naver.com', weight: 1.5 },
    ],
  },
  {
    id: 'google_aio', name: 'Google AI 개요', short: 'Google AI', colorVar: '--series-1', mentionBase: 0.22, aheadProb: 0.55, citeMin: 2, citeMax: 4,
    competitorWeights: { 지누스: 0.6, 베스트슬립: 0.3, 퀵슬립: 0.26, 올라인매트리스: 0.22, 웰퍼니처: 0.2, 휴도: 0.16 },
    citePool: [{ domain: 'youtube.com', weight: 3 }, { domain: 'namu.wiki', weight: 2 }, { domain: 'tistory.com', weight: 2 }, { domain: 'mildo.kr', weight: 1.4 }, { domain: 'ohou.se', weight: 1.2 }, { domain: 'news', weight: 1 }],
  },
];

/** 라이브 진단 열 (Claude 응답 기준) */
export const LIVE_ENGINE = { id: 'claude', name: 'Claude', short: 'Claude', colorVar: '--series-5' } as const;

/** 데모 생성 가정: 구매 의도별 브랜드 언급 배수 · 경쟁사 언급 배수 */
export const INTENT_MENTION_MULT: Record<IntentId, number> = { brand: 2.6, compare: 1.05, generic: 0.95, problem: 0.8, life: 0.72 };
export const INTENT_COMPETITOR_MULT: Record<IntentId, number> = { brand: 0.35, compare: 1.3, generic: 1.1, problem: 0.9, life: 0.85 };

/** 정기 진단 주기 (매주 월요일 · 최근 4회) */
export const GEO_ROUNDS = 4;
export const GEO_ROUND_WEEKDAY = 1;

/* ------------------------------ 질의 세트 ------------------------------ */

export type AeoTopicId = 'hardness' | 'material' | 'size' | 'criteria' | 'brand';

export interface GeoQuery {
  id: string;
  text: string;
  intent: IntentId;
  /** 데모 생성 가정: 질의별 언급 배수 (정보형 질의는 브랜드 언급이 적다) */
  qMult: number;
  /** 연결할 SA 키워드 (data.keywords의 text) */
  kw?: string;
  /** 연결할 검색어 보고서 행 (data.searchTerms의 term) */
  term?: string;
  /** 대응 AEO 주제 */
  topics: AeoTopicId[];
}

/** 주요 AI 질의 20개 — 구매 의도 5종(p.35)에 맞춰 구성. kw/term은 데이터에서 실제로 찾아 연결한다. */
export const GEO_QUERIES: GeoQuery[] = [
  { id: 'q01', text: '수면밀도 매트리스 후기', intent: 'brand', qMult: 1.1, kw: '밀도매트리스 후기', topics: ['brand'] },
  { id: 'q02', text: '밀도 매트리스 경도', intent: 'brand', qMult: 0.95, kw: '밀도 매트리스', term: '밀도 매트리스 경도', topics: ['hardness', 'brand'] },
  { id: 'q03', text: '퀸 매트리스 추천', intent: 'generic', qMult: 1.05, kw: '퀸 매트리스', topics: ['size'] },
  { id: 'q04', text: '슈퍼싱글 매트리스 추천', intent: 'generic', qMult: 0.95, kw: '슈퍼싱글 매트리스', topics: ['size'] },
  { id: 'q05', text: '킹 매트리스 추천', intent: 'generic', qMult: 0.9, kw: '킹 매트리스', topics: ['size'] },
  { id: 'q06', text: '허리 편한 매트리스 추천', intent: 'problem', qMult: 1.15, kw: '허리 편안한 매트리스', topics: ['hardness', 'criteria'] },
  { id: 'q07', text: '매트리스 경도 고르는 법', intent: 'problem', qMult: 0.55, kw: '매트리스 경도', term: '매트리스 경도 고르는 법', topics: ['hardness', 'criteria'] },
  { id: 'q08', text: '단단한 매트리스 푹신한 매트리스 차이', intent: 'problem', qMult: 0.6, kw: '단단한 매트리스', topics: ['hardness'] },
  { id: 'q09', text: '꺼짐 없는 매트리스 고르는 법', intent: 'problem', qMult: 0.75, kw: '꺼짐 없는 매트리스', topics: ['material', 'criteria'] },
  { id: 'q10', text: '여름에 덥지 않은 매트리스', intent: 'problem', qMult: 0.7, kw: '통기성 좋은 매트리스', term: '여름 매트리스 통기성', topics: ['material'] },
  { id: 'q11', text: '매트리스 브랜드 순위', intent: 'compare', qMult: 1.25, kw: '매트리스 순위', topics: ['brand', 'criteria'] },
  { id: 'q12', text: '가성비 매트리스 추천', intent: 'compare', qMult: 0.85, kw: '가성비 매트리스', topics: ['criteria'] },
  { id: 'q13', text: '독립스프링 포켓스프링 차이', intent: 'compare', qMult: 0.5, kw: '독립스프링 매트리스 추천', term: '독립스프링 vs 포켓스프링', topics: ['material'] },
  { id: 'q14', text: '매트리스 추천', intent: 'compare', qMult: 1.1, kw: '매트리스 추천', topics: ['criteria'] },
  { id: 'q15', text: '신혼 매트리스 추천', intent: 'life', qMult: 1.2, kw: '신혼 매트리스', topics: ['size', 'criteria'] },
  { id: 'q16', text: '신혼집 매트리스 사이즈', intent: 'life', qMult: 0.85, kw: '신혼집 매트리스 사이즈', term: '신혼 매트리스 사이즈', topics: ['size'] },
  { id: 'q17', text: '이사 후 매트리스 교체 시기', intent: 'life', qMult: 0.55, kw: '이사 매트리스', term: '이사 후 매트리스 교체 시기', topics: ['criteria'] },
  { id: 'q18', text: '첫 자취 매트리스 추천', intent: 'life', qMult: 0.9, kw: '자취 매트리스', term: '첫 자취 매트리스 추천', topics: ['size', 'criteria'] },
  { id: 'q19', text: '부모님 선물 매트리스 추천', intent: 'life', qMult: 1.0, kw: '부모님 매트리스 선물', term: '부모님 선물 매트리스', topics: ['criteria'] },
  { id: 'q20', text: '아이방 매트리스 추천', intent: 'life', qMult: 0.85, kw: '아이방 매트리스', term: '아이방 슈퍼싱글 매트리스 추천', topics: ['size', 'material'] },
];

/* ------------------------------ 브랜드 · 경쟁사 탐지 ------------------------------ */

/** 브랜드 확정 표현 — 단독 '밀도'는 소재 밀도(고밀도 폼 등)와 구분되지 않아 '확인 필요'로 분리한다 */
export const BRAND_STRONG_PATTERN = '(수면\\s?밀도|밀도\\s?매트리스|㈜\\s?밀도|\\(주\\)\\s?밀도|sleep\\s?mildo|mildo)';
/** 소재 · 물성 문맥의 '밀도' (브랜드 언급으로 세지 않음) */
export const DENSITY_CONTEXT_PATTERN = '((고|저|중|폼|스펀지|높은|낮은|적정|소재|단위)\\s?밀도|밀도\\s?(가|는|를|와|와\\s|감|높|낮|차이|단위|\\d|kg))';

/** RFP 경쟁 6개사 + 표기 변형 */
export const COMPETITOR_ALIASES: Record<string, string[]> = {
  베스트슬립: ['베스트슬립', '베스트 슬립', 'best\\s?sleep'],
  웰퍼니처: ['웰퍼니처', '웰 퍼니처'],
  퀵슬립: ['퀵슬립', '퀵 슬립', 'quick\\s?sleep'],
  올라인매트리스: ['올라인매트리스', '올라인 매트리스', '올라인'],
  지누스: ['지누스', 'zinus'],
  휴도: ['휴도'],
};
/** 참고: RFP 경쟁사 외 자주 함께 언급되는 브랜드 (점유 계산에서는 제외, 순서 계산에는 포함) */
export const OTHER_BRANDS = ['시몬스', '에이스침대', '템퍼', '씰리', '삼분의일', '슬로우베드', '코웨이', '이케아'];

/** 자사 채널 (RFP 명시 채널) — 인용 출처가 이 도메인이면 '자사 인용' */
export const OWNED_DOMAINS = ['mildo.kr', 'brand.naver.com/mildo', 'instagram.com/sleepmildo_official'];

export const CITE_LABEL: Record<string, string> = {
  'mildo.kr': '자사몰',
  'brand.naver.com/mildo': '브랜드스토어',
  'instagram.com/sleepmildo_official': '공식 인스타그램',
  'blog.naver.com': '네이버 블로그',
  'cafe.naver.com': '네이버 카페',
  'kin.naver.com': '지식iN',
  'shopping.naver.com': '네이버 쇼핑',
  'ohou.se': '오늘의집',
  'coupang.com': '쿠팡',
  'youtube.com': '유튜브',
  'namu.wiki': '나무위키',
  'tistory.com': '티스토리',
  'ppomppu.co.kr': '뽐뿌',
  news: '언론 기사',
};

/* ------------------------------ 판정 기준 (운영 초기 기준 · 온보딩 중 확정) ------------------------------ */

export const GEO_RULES = {
  /** 질의 '확보': 5개 엔진 중 3개 이상 언급 */
  coveredEngines: 3,
  /** 질의 '경쟁사 우위': 경쟁사 언급 엔진 3개 이상 & 수면밀도 언급 1개 이하 */
  gapCompetitorEngines: 3,
  gapBrandMax: 1,
  /** 반복 관측: 최근 4회 중 3회 이상 같은 결과 */
  stableRounds: 3,
  /** 엔진별 언급률 기준 */
  engineRateGood: 0.5,
  engineRateLow: 0.25,
} as const;

export const AUDIT_RULES = {
  /** 제목 길이(한글 기준, 검색 결과 잘림 방지) */
  titleMin: 10,
  titleMax: 40,
  /** 메타 설명 길이(한글 기준) */
  descMin: 40,
  descMax: 120,
  /** 이미지 ALT 누락률: ≤10% 통과 · ≤30% 개선 · 초과 실패 */
  altPass: 0.1,
  altWarn: 0.3,
  /** FAQPage 최소 문항 */
  faqMin: 3,
  /** 점수 판정 */
  scorePass: 85,
  scoreWarn: 60,
  /** 가격 일치 허용 오차(원) */
  priceTolerance: 1,
} as const;

/* ------------------------------ AEO 주제 ------------------------------ */

export const AEO_TOPICS: { id: AeoTopicId; label: string; pattern: string; core: boolean }[] = [
  { id: 'hardness', label: '경도', pattern: '(경도|단단|푹신|딱딱|하드|소프트|탄성)', core: true },
  { id: 'material', label: '소재', pattern: '(소재|폼|라텍스|스프링|레이어|원단|커버|내장재)', core: true },
  { id: 'size', label: '사이즈', pattern: '(사이즈|슈퍼싱글|퀸|킹|싱글|더블|규격|치수)', core: true },
  { id: 'criteria', label: '선택 기준', pattern: '(고르는|고를\\s?때|선택\\s?기준|고르기|체형|수면\\s?자세|비교\\s?기준)', core: true },
  { id: 'brand', label: '브랜드 · 구매', pattern: '(수면밀도|배송|설치|반품|체험|보증)', core: false },
];

/** REVIEW_RULES 위반 시 수정 제안 (rule id → 제안) */
export const REVIEW_FIX: Record<string, string> = {
  medical_cure: '질병 · 통증 관련 효능 표현을 삭제하고 경도 · 소재 · 구조 같은 제품 사양 서술로 바꿉니다.',
  medical_device: '의료기기 · 전문가 추천으로 오인될 표현을 삭제합니다.',
  superlative: '출처 · 집계 기간 · 기준을 병기합니다 (예: 네이버 가구 부문 판매 1위, 집계 기간 [입력]).',
  absolute: '절대 표현을 조건 · 범위가 있는 표현으로 바꿉니다.',
  price_claim: '판매가 · 프로모션 기간과 매일 대조합니다 (불일치 시 즉시 수정).',
  competitor: '경쟁사명을 삭제하거나 비교광고 요건(객관적 근거 · 출처)을 검토합니다.',
};

/** 데모 생성 가정: 쇼핑 지면 노출 확률 (구매 의도별) */
export const SHOPPING_EXPOSE: Record<IntentId, number> = { brand: 0.95, generic: 0.72, compare: 0.58, problem: 0.46, life: 0.52 };
