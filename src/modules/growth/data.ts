/**
 * 매출 성장 고도화 모듈 전용 상수 — 제안서 p.30–42.
 * 장표에 명시된 값은 장표 번호를, 툴이 계산을 위해 둔 초기 가정은 "가정 · 온보딩 중 확정"을 주석으로 남긴다.
 * src/data/constants.ts 의 TARGET_GROUPS · SA_CAMPAIGNS · MEDIA · NEW_MEDIA_PILOT · CO_PROMOTIONS · GROWTH_CALENDAR 를 함께 쓴다.
 */
import type { IntentId, MediaId } from '@/core/types';

/* ------------------------------ p.30 성장 공식 ------------------------------ */
export const GROWTH_FORMULA = [
  { id: 'time', title: '줄인 시간', detail: '반복 구간 축소 → 성장 실험에 재투입', tab: 'partner', route: 'flow' },
  { id: 'power', title: '매체 파워', detail: '매체 협력 → 최선의 구좌 확보', tab: 'partner', route: 'growth' },
  { id: 'demand', title: '새 수요', detail: '신규 매체 발굴 · 브랜드 코프로모션', tab: 'demand', route: 'growth' },
  { id: 'basics', title: '기본기', detail: '캠페인 · 전환율 · 자사몰 · DA→SA', tab: 'alloc', route: 'growth' },
] as const;
/** p.31 하단 */
export const TIME_REINVEST = { to: '키워드 확장 · 신규 매체 · 코프로모션 실험에 재투입', reference: '도입 브랜드 반복 업무 40%+ 감소' } as const;

/* ------------------------------ p.32 매체 협력 구좌 ------------------------------ */
export const MEDIA_PARTNERSHIPS = [
  { media: '네이버', relation: '프리미어 파트너 · Partner of the Year 2년 연속', slots: '기획전 · 퀵윈 · 신규 상품 우선 테스트 · 3자 미팅', use: '브랜드스토어 시즌 기획전 · 신규 지면 선점', placeholder: false },
  { media: '카카오', relation: '공식 대행 · 단독 프로모션 진행 경험', slots: '프로모션 · 신규 지면 협의', use: '시즌 프로모션 · 리타겟팅', placeholder: false },
  { media: '당근', relation: '공식 대행 · 대행사 중 광고 취급액 1위', slots: '지역 기반 광고 상품', use: '이사 · 입주 지역 수요 테스트', placeholder: false },
  { media: '쿠팡', relation: '공식 매체 협업', slots: '판매 채널 광고 상품', use: '판매 채널 매출 직접 견인', placeholder: false },
  { media: 'Google · Meta · 오늘의집', relation: '[파트너 등급 · 협업 범위 입력]', slots: '신규 기능 베타 · 계정 진단', use: '자사몰 신규 고객 · 판매 채널 노출', placeholder: true },
] as const;
export const PARTNERSHIP_NOTE = '지원 · 구좌는 각 매체 기준과 승인에 따르며, 확보를 위해 프로그레스미디어가 직접 협의합니다.';

/* ------------------------------ p.33 네이버 3자 협업 ------------------------------ */
export const NAVER_TRIPARTITE = {
  parties: [
    { name: '수면밀도', role: '브랜드 · 의사결정' },
    { name: '프로그레스미디어', role: '전담 운영 · 프리미어 파트너' },
    { name: '네이버', role: '파트너 채널 · 최우선 매체' },
  ],
  cadence: '분기 정례 + 주요 시즌 기획전 전',
  meeting: '정기 3자 미팅 · 수면밀도 × 네이버 × 프로그레스미디어',
  steps: [
    { title: '정기 3자 미팅', detail: '운영 현황 · 성장 과제 · 신규 상품을 세 회사가 함께 점검', gain: '의사결정 속도 · 네이버 인사이트 직접 확보' },
    { title: '기획전 · 커머스 협업', detail: '브랜드스토어 시즌 기획전과 네이버 프로모션 연계', gain: '신규 구매 수요 · 집중 매출' },
    { title: '퀵윈 · 광고 지원', detail: '집행 계획에 맞는 광고 · 리워드 지원 프로그램 참여', gain: '추가 지원 · 혜택 확보' },
    { title: '신규 상품 선제 테스트', detail: '네이버 신규 광고 상품 · 기능 테스트 우선 참여 협의', gain: '신규 지면 · 타겟 선점' },
    { title: '공동 컨설팅', detail: '네이버 파트너 채널과 계정 · 상품 믹스 공동 진단', gain: '운영 조건 최적화' },
  ],
  note: '네이버의 각종 지원 · 혜택을 받을 수 있도록 프로그레스미디어가 적극 지원합니다 · 최종 조건은 네이버 프로그램 기준과 승인을 따릅니다.',
} as const;

/* ------------------------------ p.34 타겟 그룹 ↔ 운영 단위 ------------------------------ */
export const TARGET_PRINCIPLE = '건강 상태를 추정해 개인을 타겟팅하지 않고, 고객이 직접 검색한 키워드와 제품 선택 맥락으로 운영합니다';
/** 타겟 그룹을 실제 운영 단위(SA 의도 캠페인 · DA 캠페인)에 연결 — 연결 방식은 툴 설계(가정) */
export const TARGET_GROUP_LINKS: Record<'A' | 'B' | 'C' | 'D' | 'E', { intents: IntentId[]; campaigns: string[]; media: MediaId[]; metric: string }> = {
  A: { intents: ['generic'], campaigns: ['GFA_Prospecting', 'Meta_넓은 타겟'], media: ['naver_gfa', 'meta'], metric: '신규 비중 · CPA' },
  B: { intents: ['compare'], campaigns: ['SA_비교 · 검토'], media: ['naver_sa'], metric: '전환율 · CPA' },
  C: { intents: ['problem'], campaigns: ['SA_문제 해결'], media: ['naver_sa'], metric: '체류 · 전환율' },
  D: { intents: ['life'], campaigns: ['SA_생활 상황'], media: ['naver_sa'], metric: '신규 키워드 전환' },
  E: { intents: [], campaigns: ['GFA_리타겟팅', 'Meta_리타겟팅', '카카오_장바구니 리마케팅'], media: ['kakao'], metric: '전환 · CPA' },
};

/* ------------------------------ p.35 랜딩 유형 ------------------------------ */
/** 랜딩 URL → SA_CAMPAIGNS.landing 유형 (데모 URL 기준) */
export const LANDING_TYPES: { re: RegExp; type: string }[] = [
  { re: /brand\.naver\.com\/mildo\/products/, type: '상품 상세' },
  { re: /brand\.naver\.com\/mildo\/?$/, type: '브랜드스토어 메인' },
  { re: /mildo\.kr\/guide/, type: '선택 가이드' },
  { re: /mildo\.kr\/(event|review|compare)/, type: '기획전 · 자사몰' },
];

/* ------------------------------ p.37 예산 재배분 시뮬레이터 ------------------------------ */
/** 반응 곡선 적합 기간 (일) — 명세: 최근 90일 일별 데이터 */
export const CURVE_WINDOW_DAYS = 90;
/**
 * 매체별 반응 곡선 사전 가정 (매출 = a · 광고비^b) — 가정 · 온보딩 중 증액 테스트 · 홀드아웃으로 교체.
 * 일 광고비 변동폭이 좁으면 b를 데이터로 식별할 수 없으므로 이 값을 쓴다.
 * capMult: 현재 일 광고비 대비 곡선이 유효한 상한 배수 (볼륨 한계). SA는 노출 기회 손실률로 계산한다.
 */
export const CURVE_PRIORS: Record<MediaId, { b: number; capMult: number | null; why: string }> = {
  naver_sa: { b: 0.55, capMult: null, why: '검색량 상한 · 순위 상승 시 CPC 상승' },
  naver_gfa: { b: 0.7, capMult: 2.5, why: '도달 확장 여지 · 빈도 증가 시 체감' },
  google: { b: 0.7, capMult: 2.5, why: '검색 + Demand Gen 확장 여지' },
  meta: { b: 0.75, capMult: 2.5, why: '넓은 타겟 · Advantage+ 확장 여지' },
  kakao: { b: 0.55, capMult: 1.5, why: '리마케팅 모수(방문 · 장바구니) 한정' },
  vertical: { b: 0.6, capMult: 1.6, why: '판매 채널 광고 지면 한정' },
};
/** SA 볼륨 한계: 노출 점유 확대 시 CPC 상승 가정 (+30%) — 가정 */
export const SA_CPC_INFLATION = 1.3;
/** 매체별 최소/최대 비중 가드레일 — 초기값 · 수면밀도 협의 후 확정 (가안 p.37 비중 기준 ±) */
export const ALLOCATION_GUARDRAILS: Record<MediaId, { min: number; max: number }> = {
  naver_sa: { min: 0.35, max: 0.5 },
  naver_gfa: { min: 0.12, max: 0.24 },
  google: { min: 0.08, max: 0.16 },
  meta: { min: 0.08, max: 0.16 },
  kakao: { min: 0.05, max: 0.1 },
  vertical: { min: 0.05, max: 0.1 },
};
/**
 * 예산 제약 신호 (재배분 입력).
 * 조기 소진 대상 · 예상 마감 시각은 MILDO Board · AD Pilot · 커맨드 센터와 같은 계산(AD Pilot paceCampaigns:
 * 최근 28일 매체 시간대별 소진 곡선 + 선형 외삽, 23시 전 마감)을 그대로 쓴다 — 같은 숫자는 같은 계산.
 * recentHours: 급변 확인 구간 (현재 시각 포함 최근 n시간, p.47 동요일 · 동시간 기준선과 비교) — 초기값
 * peakStartHour: 저녁 피크 시작 (21~23시) — 이 시각 전 마감이면 피크 전 소진 (Board · AD Pilot과 같은 값)
 * runwayMinDays: 계정 잔액 1일치 미만이면 증액 보류 (p.44 계정 · 결제 기준)
 */
export const PACE_RULES = { recentHours: 2, peakStartHour: 21, runwayMinDays: 1 } as const;
/** p.37 재배분 원칙 + 1회 재배분 폭 상한 (초기값) */
export const REBALANCE_RULES = { principle: '한계 효율 비교 → 월 1회 재배분 → 분기 구조 리뷰', stepCapPct: 20, note: '연 50억 원 가정 · VAT · 수수료 별도' } as const;

/* ------------------------------ p.40 DA → SA 기여 ------------------------------ */
export const DA_SA_PATH = ['DA 노출', '브랜드 검색 증가', 'SA 클릭', '구매'] as const;
export const DA_SA_METHODS = [
  { id: 'm1', name: 'METHOD 1', title: '시계열 리프트', detail: 'DA 집행 강도와 브랜드 · 대표 키워드 검색량, SA 전환의 동행 관계 추적' },
  { id: 'm2', name: 'METHOD 2', title: '홀드아웃 테스트', detail: '기간 · 지역 · 타겟 단위로 DA를 끈 그룹과 비교해 순증 효과 측정' },
  { id: 'm3', name: 'METHOD 3', title: '대표 키워드 기여', detail: '대표 키워드별 SA 매출 중 DA 경유 비중을 산정해 키워드 단위 기여 리포트' },
] as const;
export const DA_SA_MAX_LAG = 7;
/** METHOD 3: 비브랜드 의도별 DA 경유 비중 — 데모 가정 (실측은 네이버 브랜드 검색 · 경로 데이터 연동 후) */
export const DA_SHARE_ASSUMPTION: Record<Exclude<IntentId, 'brand'>, number> = { generic: 0.06, problem: 0.08, compare: 0.12, life: 0.1 };
/** METHOD 2 홀드아웃 단위 — 기본 홀드아웃 비중 · 그룹 간 잡음 배수는 가정 */
export const HOLDOUT_UNITS = [
  { id: 'region', label: '지역 단위', holdoutShare: 0.3, noiseMult: 1.0, minDays: 14, desc: '일부 지역 DA 미집행 · 같은 기간 지역 간 비교', measure: '지역별 브랜드 검색량 · SA 전환 (지역 리포트)' },
  { id: 'audience', label: '타겟 단위', holdoutShare: 0.2, noiseMult: 0.8, minDays: 14, desc: '타겟 일부를 DA 노출에서 제외(홀드아웃 오디언스)', measure: '매체 리프트 측정 지원 여부 확인 필요' },
  { id: 'period', label: '기간 단위', holdoutShare: 0.5, noiseMult: 1.8, minDays: 28, desc: '주 단위 DA ON/OFF 교차 — 요일 · 시즌 요인이 상쇄되지 않음', measure: '주차별 브랜드 검색량 · SA 전환' },
] as const;
export type HoldoutUnitId = (typeof HOLDOUT_UNITS)[number]['id'];

/* ------------------------------ p.41 전환 개선 ------------------------------ */
export const FUNNEL_PLAYBOOK = [
  { stage: 'visit', label: '유입 키워드', diag: '키워드별 상세 도달률', metricLabel: '상세 도달률', bsAction: '의도별 랜딩 분리', omAction: '전용 혜택 랜딩', omNote: '채널 간 혜택 차이를 명확히' },
  { stage: 'detail', label: '상품 상세', diag: '체류 · 리뷰 조회율', metricLabel: '장바구니 담기율', bsAction: '상단 구매 근거 배치 제안', omAction: '방문자 리타겟팅', omNote: '구글 · 메타 · 카카오 재유입' },
  { stage: 'cart', label: '장바구니', diag: '담기 후 이탈률', metricLabel: '장바구니 → 구매', bsAction: '혜택 · 배송 안내 강화', omAction: 'CRM 연계 검토', omNote: '카카오 채널 · 알림톡' },
  { stage: 'order', label: '구매', diag: '결제 완료율', metricLabel: '방문 대비 구매', bsAction: '이탈 고객 리타겟팅', omAction: '퍼널 분석', omNote: '유입 채널별 랜딩 · 이탈 구간' },
] as const;
export type FunnelStage = (typeof FUNNEL_PLAYBOOK)[number]['stage'];
/** 단계 판정 기준 (초기값): 다른 채널 대비 −20% 이하 또는 직전 14일 대비 −10% 이하 → 개선 우선 */
export const FUNNEL_RULES = { gapPct: -20, trendPct: -10, cannibalCombinedPct: 3, windowDays: 14 } as const;

/* ------------------------------ p.38 신규 매체 ------------------------------ */
/** 후보 × 기준 점수(1~5) — 데모 평가 · 온보딩 중 매체 미팅 후 확정 */
export const NEW_MEDIA_SCORES: Record<string, Record<'fit' | 'context' | 'measure' | 'cost' | 'brand', number>> = {
  '지역 커뮤니티 · 당근': { fit: 4, context: 5, measure: 3, cost: 4, brand: 3 },
  '영상 · YouTube': { fit: 4, context: 4, measure: 2, cost: 2, brand: 5 },
  '금융 · 리워드 앱': { fit: 3, context: 2, measure: 4, cost: 4, brand: 2 },
  '웨딩 · 이사 플랫폼': { fit: 4, context: 5, measure: 3, cost: 3, brand: 4 },
  '네이버 신규 지면': { fit: 4, context: 3, measure: 5, cost: 4, brand: 4 },
};
/** 후보별 예상 CPA 배수 (현재 DA 평균 CPA 대비) — 데모 가정 */
export const NEW_MEDIA_CPA_MULT: Record<string, number> = {
  '지역 커뮤니티 · 당근': 1.1, '영상 · YouTube': 1.35, '금융 · 리워드 앱': 0.95, '웨딩 · 이사 플랫폼': 1.15, '네이버 신규 지면': 0.9,
};
/** 파일럿 기본 예산 (후보당 4주) · 상위 N개 — 초기값 */
export const PILOT_DEFAULTS = { budgetPerPilot: 40_000_000, topN: 3, precision: 0.25, confidence: 0.95 } as const;

/* ------------------------------ p.39 코프로모션 ------------------------------ */
export const CO_PROMO_PRINCIPLES = {
  matching: '프로그레스미디어 운영 광고주 중 카테고리 비경쟁 브랜드를 양사 동의 하에 제안',
  rules: '고객 데이터 공유 없음 · 브랜드별 성과 분리 측정',
} as const;
/**
 * 구매 순간 ↔ 관련 SA 키워드 (검색 수요 연결용 정규식).
 * '독립스프링'(제품 구조)이 '첫 독립'(생활 상황)으로 잡히지 않도록 '첫 독립'만 매칭한다.
 * 숙면 환경은 침구 · 베개 · 조명 · 공기 파트너와 맞닿는 수면 환경 검색(통기 · 경도 · 꺼짐 · 단단)만 연결 — 통증 · 허리 등 건강 맥락 키워드는 코프로모션 근거로 쓰지 않는다 (p.34 원칙).
 */
export const CO_PROMO_KEYWORDS: Record<string, string> = {
  '신혼': '신혼',
  '이사 · 입주': '이사|입주|첫\\s?독립|자취|집들이',
  '숙면 환경': '통기|경도|꺼짐|단단|베개|침구',
  '선물': '선물|부모님',
};

/* ------------------------------ p.42 캘린더 연결 ------------------------------ */
export const CALENDAR_LINKS: Record<string, { route: string; label: string }[]> = {
  '2027 Q1': [{ route: 'ops', label: '온보딩' }, { route: 'board', label: '성과 기준선' }],
  '2027 Q2': [{ route: 'lab', label: '구문형 확장' }, { route: 'geo', label: '문제 해결형 랜딩' }],
  '2027 Q3': [{ route: 'growth', label: '전환 · DA→SA' }],
  '2027 Q4': [{ route: 'flow', label: '연말 프로모션' }, { route: 'reports', label: '연간 리뷰' }],
};
export const QUARTER_START: Record<string, string> = { '2027 Q1': '2027-01-01', '2027 Q2': '2027-04-01', '2027 Q3': '2027-07-01', '2027 Q4': '2027-10-01' };
export const CALENDAR_NOTE = '네이버 연계 · 코프로모션은 협업 제안 가안이며 확정 일정이 아닙니다.';
