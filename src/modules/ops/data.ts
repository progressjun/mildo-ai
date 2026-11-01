/**
 * 전담 TF · 온보딩 · 계약 · RFP 커버리지 — 모듈 전용 상수 (출처 장표 · RFP 항목 주석).
 * 공용 상수(TF_ROLES · DECISION_MATRIX · OWNERSHIP · ONBOARDING_* · CONTRACT_TERMS · RFP)는 src/data/constants.ts에서 읽고,
 * 여기에는 그 상수에 없는 제안서 · RFP 원문 값과 화면 운영 가정만 둔다. 가정값은 '가정'으로 표기한다.
 */
import type { MediaId } from '@/core/types';

/* ============================== p.52 전담 TF ============================== */

/** p.52 장표의 빈칸 표기 그대로 */
export const TF_PLACEHOLDER = { name: '[성명]', years: '[n]년', allocation: '[n]%' } as const;

/** 연차 · 투입률 입력 허용 범위 (입력 검증용) */
export const TF_INPUT_RULES = { yearsMax: 45, allocationMin: 1, allocationMax: 100 } as const;

/**
 * 휴가 시뮬레이터 운영 가정 (제안서 기준값 아님 · 화면에서 수정 가능)
 *  - 투입률 미입력 인원은 '전담 7인 TF'(p.51) 표기에 따라 100%로 가정
 *  - 부재 인원 업무 중 백업이 인수하는 비율: 50% (일 운영 · 이슈 대응은 인수, 전략 · 보고는 복귀 후 처리 가정)
 *  - 과부하 기준: 합산 투입률 100% 초과
 */
export const LEAVE_ASSUMPTIONS = { assumedAllocation: 100, transferPct: 50, overloadPct: 100, defaultDays: 7 } as const;

/** 백업 적합성 판단용 업무 영역 (p.52 담당 기준) — 총괄 PM은 Lead AE 백업이 제안서 구조라 예외 */
export const ROLE_DOMAIN: Record<string, string> = {
  pm: '총괄', sa_lead: '매체 운영', sa_ae: '매체 운영', da_ae: '매체 운영', global_ae: '매체 운영', analyst: '데이터 · 개발', dev: '데이터 · 개발',
};

/** RFP [기본 요건] 인력 · 백업: "매체별 전담자(SA · DA · 총괄)" */
export const RFP_DEDICATED_COVERAGE = [
  { key: 'SA', label: 'SA 전담', roles: ['sa_lead', 'sa_ae'] },
  { key: 'DA', label: 'DA 전담', roles: ['da_ae'] },
  { key: 'LEAD', label: '총괄', roles: ['pm'] },
] as const;

/** 대행 계정 로그인 사용자명 ↔ TF 역할 (data.accounts.permissions.user 기준) */
export const ROLE_ACCOUNT_USER: Record<string, string> = {
  pm: 'PM', sa_lead: 'SA Lead AE', sa_ae: 'SA AE', da_ae: 'DA AE', global_ae: '글로벌 매체 AE',
};

/* ============================== p.48 주말 · 공휴일 당번 ============================== */

/** p.48 당번 순번 대상 — MILDO Alert와 같은 규칙 (매체 AE 4인 순환, 주말은 토 · 일 같은 당번, 평일 공휴일은 일자 순번) */
export const ON_DUTY_POOL = ['sa_lead', 'sa_ae', 'da_ae', 'global_ae'] as const;
export const WEEKEND_TIERS = [
  { tier: '1차', who: 'MILDO Alert', what: '24시간 감지 · 1차 진단', when: '상시' },
  { tier: '2차', who: '당번 AE', what: '주말 · 공휴일 순번제', when: '30분 내 확인' },
  { tier: '3차', who: 'PM 에스컬레이션', what: '브랜드 담당자 연락', when: 'P1 한정' },
] as const;
export const HOLIDAY_PRECHECK = '연휴 전날 사전 점검 · 예산 · 소재 · 결제 잔액 (p.48)';

/* ============================== p.53 커뮤니케이션 ============================== */

export const COMM_STRUCTURE = {
  client: '수면밀도 담당자',
  single: '메인 PM',
  singleNote: '단일 창구',
  experts: ['Lead AE', '매체 전문가', '개발자'],
  channels: ['전용 메신저 채널', '주간 미팅', '월간 리뷰'],
} as const;

/** DECISION_MATRIX 행 ↔ 대표 승인 주체 (null = 승인 요청으로 집계하지 않는 유형). 실제 분류는 engine.decisionTypeOf (kind · approver) */
export const DECISION_APPROVER: Record<string, 'AE' | 'PM' | 'CLIENT' | null> = {
  '승인 범위 내 운영 조정': 'AE',
  '예산 · 구조 변경': 'CLIENT',
  '알림 · 시스템 기준': 'PM',
  '전략 방향': null,
};

/* ============================== p.54 · p.20 온보딩 ============================== */

/** 최종 선정 26.11.24 주차(RFP) → 계약 후 다음 주 화요일 시작 가정. Kick-off 일정은 RFP상 '협의' */
export const DEFAULT_KICKOFF = '2026-12-01';
export const ONBOARDING_WEEKS = 12;
/** D+30 측정 기준 '전월 대비 성과 유지'(p.20) 판정 허용 폭 — 운영 가정 (온보딩 중 확정) */
export const BASELINE_TOLERANCE_PCT = 10;
export const ONBOARDING_PRINCIPLES = [
  { title: '병행 운영', text: '기존 입찰 로직을 그대로 유지한 채 병행 운영합니다 (p.54).' },
  { title: '단계적 전환', text: '검증이 끝난 영역부터 단계적으로 전환합니다 (p.54).' },
  { title: '기준선 먼저', text: 'D+30까지 성과 기준선을 확정하고 전월 대비 성과 유지를 측정 기준으로 둡니다 (p.20).' },
  { title: '절감 실측', text: '리소스 절감 목표는 도입 브랜드 실적(최소 40%)을 하한으로 두고 온보딩 30일 내 실측으로 확정합니다 (p.19).' },
] as const;

/* ============================== p.55–57 회사 · 레퍼런스 ============================== */

export const COMPANY_FACTS = [
  { id: 'gmv', value: '3,500억 원', label: '연간 광고 취급액', basis: '2024', page: 'p.56' },
  { id: 'media', value: '30여 개', label: '공식 대행 매체', basis: '네이버 · 카카오 · 쿠팡 · 당근 등', page: 'p.56' },
  { id: 'staff', value: '179명', label: '임직원', basis: '2026.04', page: 'p.56' },
  { id: 'poy', value: '2년 연속', label: '네이버 Partner of the Year', basis: '2024 · 2025 네이버 파트너 어워즈', page: 'p.56' },
  { id: 'bedding', value: '월 약 15억 원', label: '침구 카테고리 운영', basis: '침구 카테고리 월 합산 운영 규모', page: 'p.57' },
  { id: 'cozyma', value: 'Best Performance Campaign', label: '코지마 · 2025 네이버 파트너 어워즈', basis: 'SA + DA 통합 운영 · 2025.12.08 시상', page: 'p.55 · p.7' },
] as const;

export const COMPANY_HISTORY = [
  { year: '2008', text: '4명으로 검색광고 대행 시작' },
  { year: '2024', text: '네이버 Partner of the Year · Strategic Partner · 공식 대행사 평점 1위' },
  { year: '2025', text: '네이버 프리미어 파트너 · Partner of the Year 2년 연속 · 코지마 Best Performance Campaign' },
  { year: '2026', text: 'Shopify 파트너십 강화 · 자체 AI 엔진 5종 운영' },
] as const;

/** p.5 왜 프로그레스미디어인가 */
export const WHY_US = [
  { title: '직접 만드는 회사', points: ['자체 AI 엔진 5종 운영', 'A 뷰티 브랜드 전용 대시보드 개발', 'TF 안에 솔루션 개발자 상주'] },
  { title: '매체를 움직이는 회사', points: ['네이버 프리미어 파트너', 'Partner of the Year 2년 연속', '30여 개 매체 공식 대행'] },
  { title: '카테고리를 아는 회사', points: ['침구 카테고리 월 약 15억 원 운영', '코지마 Best Performance Campaign', '고관여 내구재 운영 경험'] },
  { title: '멈추지 않는 회사', points: ['24시간 이상 감지', 'P1 이슈 30분 내 1차 조치', '담당자별 1:1 백업'] },
] as const;
/** p.5 · p.11 검증된 결과 */
export const RESOURCE_SAVING_CLAIM = { brands: 3, minPct: 40, text: '도입 브랜드 3곳 · 반복 업무 리소스 40% 이상 감소', page: 'p.11' } as const;

/** p.57 침구 카테고리 월 합산 운영 규모 — 레퍼런스 월 광고비 합과 대조 */
export const BEDDING_MONTHLY_CLAIM = 1_500_000_000;
export const BEDDING_MATCH_TOLERANCE_PCT = 5;

export type ReferenceField = 'period' | 'monthly' | 'metric';
export interface ReferenceRow {
  id: string;
  brand: string;
  category: string;
  /** 침구 카테고리 월 합산(p.57)에 포함되는 레퍼런스 */
  bedding: boolean;
  period: string;
  monthly: string;
  /** 확정 성과 (장표 기재) */
  results: string[];
  /** 성과 수치 빈칸 */
  metric: string;
}
/** p.57 고관여 내구재 레퍼런스 — RFP "브랜드(카테고리) · 운영 기간 · 월 광고비 · 성과 수치를 같은 양식으로 (블라인드 처리 가능)" */
export const REFERENCES: ReferenceRow[] = [
  { id: 'homuro', brand: '호무로', category: '프리미엄 침구', bedding: true, period: '약 3년', monthly: '월 약 4억 원', results: ['업무 리소스 40%+ 감소'], metric: '[ROAS · 매출 성장률]' },
  { id: 'bedding_blind', brand: '대형 침구 브랜드', category: '침구 · NDA 블라인드', bedding: true, period: '[입력]', monthly: '월 약 11억 원', results: [], metric: '[ROAS · 매출 성장률]' },
  { id: 'cozyma', brand: '코지마', category: '안마의자 · 고관여 내구재', bedding: false, period: '[입력]', monthly: '[입력]', results: ['2025 네이버 Best Performance Campaign', '업무 리소스 40%+ 감소'], metric: '[ROAS]' },
];
export const REFERENCE_FIELD_LABEL: Record<ReferenceField, string> = { period: '운영 기간', monthly: '월 광고비', metric: '성과 수치' };

/* ============================== p.58 수수료 · 계약 ============================== */

/** p.58 수수료 표 행 ↔ p.37 매체 배분 가안 (네이버 SA · DA는 SA 43% + GFA 18%) */
export const FEE_MEDIA_MAP: Record<string, MediaId[]> = {
  '네이버 SA · DA': ['naver_sa', 'naver_gfa'],
  카카오: ['kakao'],
  구글: ['google'],
  메타: ['meta'],
  '버티컬 매체': ['vertical'],
};
/** 수수료율 입력 검증 범위 (%) */
export const FEE_INPUT_RANGE = { min: 0, max: 30 } as const;
/** 연간 광고비 입력 상한 (원) — RFP 약 50억(운영 방향에 따라 변동)의 200배 · 표시 단위(억) 범위를 넘는 오입력 방지 (운영 가정) */
export const ANNUAL_BUDGET_MAX = 1_000_000_000_000;
/** 연간 광고비 입력값 정규화 — 숫자가 아니거나 0 이하면 0, 상한 초과는 상한으로 (계산기 · 저장본 공통) */
export function clampAnnualBudget(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), ANNUAL_BUDGET_MAX);
}

/* ============================== RFP 커버리지 ============================== */

export type RfpGroup = 'p1' | 'p2' | 'growth' | 'base' | 'submit';
export const RFP_GROUP_LABEL: Record<RfpGroup, string> = {
  p1: '[1순위] 리소스 절감 & 데이터 자동화',
  p2: '[2순위] 광고 모니터링 & 테스트 전략',
  growth: '매출 성장 고도화',
  base: '[기본 요건] 운영 안정성 & 인력',
  submit: '필수 제출물',
};
export type EvalId = 'automation' | 'stability' | 'strategy' | 'people' | 'cost' | 'reference';
/** 입력이 끝나야 '구현됨'이 되는 항목의 입력 출처 */
export type InputNeed = 'tf' | 'fees' | 'references' | 'geo_case';

export interface RfpItem {
  id: string;
  group: RfpGroup;
  /** RFP 원문 (요약 없이 핵심 문구 유지) */
  text: string;
  modules: string[];
  pages: string;
  criterion: EvalId;
  need?: InputNeed;
}

/** RFP '제안 요청 사항' 전 항목 + '필수 제출물' 2)~7) */
export const RFP_ITEMS: RfpItem[] = [
  { id: 'p1_scope', group: 'p1', text: 'SA 키워드 중심(+소재) 리소스 절감 전체 제안: 대시보드 · 리포팅 · 데이터 자동화 범위, 적용 일정, 실제 화면', modules: ['board', 'adpilot', 'reports'], pages: 'p.8–20', criterion: 'automation' },
  { id: 'p1_custom', group: 'p1', text: '브랜드 상황에 맞는 데이터 관리 & 커스텀 역량 (판단 항목: 안정성 · 속도 · 유연성 · 선제성 · 전문성)', modules: ['board', 'agent', 'home'], pages: 'p.8–11', criterion: 'automation' },
  { id: 'p1_timetable', group: 'p1', text: '리포팅 · 데이터 시간표 (브랜드 업무시간 최적화): 구분별 리드타임 & 최적화 항목 진단 및 제안', modules: ['reports'], pages: 'p.17–18', criterion: 'automation' },
  { id: 'p2_tracking', group: 'p2', text: '운영 매체 신규 상품 · 광고 지면 · 노출 로직 변동 선제 트래킹', modules: ['watch'], pages: 'p.24', criterion: 'strategy' },
  { id: 'p2_archive', group: 'p2', text: '광고 외 데이터 자동 아카이빙 · 자동화 역량을 활용한 인사이트: 오가닉 / 페이드 지면 구분 없이 브랜드에 영향을 줄 수 있는 인사이트 · 전략', modules: ['watch'], pages: 'p.25', criterion: 'strategy' },
  { id: 'p2_keyword', group: 'p2', text: '신규 키워드 발굴: 롱테일 · 구문 형식 키워드 발굴 → 테스트 → 확장 제안', modules: ['lab', 'adpilot'], pages: 'p.26, p.36', criterion: 'strategy' },
  { id: 'p2_external', group: 'p2', text: '외부 변수 트래킹 및 선제 인사이트 · 액션: 경쟁사 동향(온/오프라인), 서드파티 · 외부 데이터, 내부 레퍼런스 · 파트너 매체사 인사이트, 분기별 성장 전략 리뷰, 액션 후 랩업', modules: ['watch', 'lab'], pages: 'p.25, p.28', criterion: 'strategy' },
  { id: 'p2_geo', group: 'p2', text: 'GEO & AI 대응: 오가닉 · 페이드 지면 AI 대응 전략, AI 지면 노출 진단과 인사이트 (실제 집행 사례와 수치)', modules: ['geo'], pages: 'p.29', criterion: 'reference', need: 'geo_case' },
  { id: 'g_campaign', group: 'growth', text: '운영 캠페인 개선 및 브랜드스토어 전환율 · 자사몰 활성화 방안 (판매 제품 수가 적은 한계 극복 운영 전략)', modules: ['growth', 'lab', 'flow'], pages: 'p.30–36, p.41', criterion: 'strategy' },
  { id: 'g_dasa', group: 'growth', text: 'DA → SA 전환 트래킹: DA → SA 성과 & 대표 키워드의 매출 기여 트래킹', modules: ['growth'], pages: 'p.40', criterion: 'strategy' },
  { id: 'g_market', group: 'growth', text: '타겟 데이터 기반 시장 인사이트: 수면밀도가 고려할 채널 선정의 기준이 될 수 있는 수준', modules: ['growth'], pages: 'p.34, p.37–39', criterion: 'strategy' },
  { id: 'b_critical', group: 'base', text: '크리티컬 이슈 탐지 기준 (탐지 기준 · 알림 방식 · 조치 보고): 광고 OFF · 미노출 / 계정 · 소재 이슈 / 데이터 급변 / 매체 · 외부 환경 / 주말 · 공휴일 + 추가 이슈 유형', modules: ['alert'], pages: 'p.43–49', criterion: 'stability' },
  { id: 'b_account', group: 'base', text: '광고 계정 · 결제 구조: 권한 · 결제 구조 명시', modules: ['alert', 'ops'], pages: 'p.50', criterion: 'stability' },
  { id: 'b_people', group: 'base', text: '인력 · 백업: 매체별 전담자(SA · DA · 총괄) 및 실명 · 연차 · 투입률, 담당자별 백업 인력 지정, 휴가 · 전사 일정에도 응답 공백 최소화', modules: ['ops'], pages: 'p.51–53', criterion: 'people', need: 'tf' },
  { id: 'b_onboard', group: 'base', text: '온보딩 플랜: 계정 · 입찰 로직 인수, 성과 공백 최소화, 정착 루틴 재현 시점 제시', modules: ['ops'], pages: 'p.20, p.54', criterion: 'people' },
  { id: 's2', group: 'submit', text: '2) 리소스 절감안 제안', modules: ['reports', 'adpilot'], pages: 'p.11, p.19–20', criterion: 'automation' },
  { id: 's3', group: 'submit', text: '3) 운영 안정성 기준 제안', modules: ['alert'], pages: 'p.43–50', criterion: 'stability' },
  { id: 's4', group: 'submit', text: '4) TF 명단 (실명 · 연차 · 투입률 · 백업)', modules: ['ops'], pages: 'p.52', criterion: 'people', need: 'tf' },
  { id: 's5', group: 'submit', text: '5) 대시보드 · 자동 알림 실제 화면, 리포트 샘플', modules: ['board', 'alert', 'reports'], pages: 'p.12–13, p.46, p.60', criterion: 'automation' },
  { id: 's6', group: 'submit', text: '6) 견적 · 수수료 제안', modules: ['ops'], pages: 'p.58', criterion: 'cost', need: 'fees' },
  { id: 's7', group: 'submit', text: '7) 간략한 회사소개 · 고관여 내구재 레퍼런스 (브랜드(카테고리) · 운영 기간 · 월 광고비 · 성과 수치 같은 양식)', modules: ['ops'], pages: 'p.55–57', criterion: 'reference', need: 'references' },
];

/** p.29 GEO 장표 공란 표기 */
export const GEO_CASE_BLANK = '[브랜드 · 진단 전후 브랜드 언급률 · 인용 수 입력]';

/** RFP 기타 문구 (원문) */
export const RFP_NOTES = {
  priority: '우선 협상 대상자는 리소스 절감 자동화 · 운영 안정성 점수가 우선 시 되며, 점수가 동일할 경우 수수료 조건을 종합 고려하여 협상 예정',
  undisclosed: '배점 및 세부 채점표는 공개하지 않습니다.',
  pt: '경쟁 PT 업체당 80분: 발표 40분 · 라이브 데모 15분 · Q&A 25분 (실무자 필수 참석)',
  scope: [
    '운영 과제는 전체 운영 관점의 제안을, 신규 상품 · 지면 과제는 매체별 상세 실행안을 담아 주세요.',
    '브랜드 컨셉 · DA 소재 제작 · 브랜드 시장 방향성 기획은 이번 제안 범위가 아니며, DA 기획안 소개 · 시연은 필요하지 않습니다.',
  ],
  qualification: '참가 자격: 전문 TF 인력 구성 가능 (네이버 공식 대행 필수)',
} as const;

/** RFP 필수 제출물 1) · 8) 및 기타 제출 서류 — 체크리스트 */
export const SUBMISSION_DOCS = [
  { id: 'deck', label: '1) 제안서 PPT + PDF 별도 첨부', rule: '양식 자유 · 표지 포함 60장 이내 · 2)~7) 항목 포함 (PT 발표용 별도 제작 시 80장 제한)' },
  { id: 'bizreg', label: '8) 법인 사업자 등록증', rule: '제안서와 별도 파일로 제출' },
  { id: 'naver', label: '네이버 공식 대행 자격', rule: '참가 자격 · 전문 TF 인력 구성 가능' },
  { id: 'nda', label: '비밀유지확약서', rule: '최종 선정 대행사에 한해 별도 양식 전달 예정' },
] as const;
/** 제안서 v3 장표 수 (표지 p.1 ~ 부록 p.60) · RFP 상한 */
export const PROPOSAL_PAGES = 60;
export const RFP_PAGE_LIMIT = 60;

/** 제출 마감 이전 내부 확정 목표 — 운영 가정 (마감 3영업일 전) */
export const INTERNAL_FREEZE_BUSINESS_DAYS = 3;
