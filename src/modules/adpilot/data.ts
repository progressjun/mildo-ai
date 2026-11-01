/**
 * AD Pilot · GFA Control v1 모듈 전용 상수 · 시드 데이터.
 * 출처 표기:
 *  - p.14 AD Pilot 규칙 · SAFETY / p.15 GFA Control v1 흐름 · 위임 범위 / p.16 운영 화면 구성
 *  - "모듈 가정" 표기 값은 제안서에 수치가 없어 이 툴이 둔 초기값이다 (온보딩 중 확정).
 *  - "DEMO" 표기 계정 · 캠페인 · 광고그룹은 시연용 가정이며 실제 계정이 아니다.
 */
import type { AdAccount, Campaign } from '@/core/types';

/* ------------------------------------------------------------------ */
/* p.14 AD Pilot 규칙 표 (조건 · 예시 → 자동 조정)                         */
/* ------------------------------------------------------------------ */
export const RULE_TABLE = [
  { id: 'high_efficiency', cond: '고효율 키워드 노출 기회 감소', auto: '입찰 상향 · 최대 입찰가 내' },
  { id: 'below_target', cond: '목표 ROAS 미달 지속 · 최소 전환 확보 후', auto: '입찰 하향' },
  { id: 'early_exhaust', cond: '일 예산 조기 소진 예상', auto: '예산 재배분 · 입찰 조정 제안' },
  { id: 'new_intent', cond: '신규 구매 의도 키워드 발견', auto: '테스트 그룹 등록 후보' },
  { id: 'anomaly', cond: '성과 급변 · 수집 데이터 이상', auto: '자동 조정 보류 · 알림' },
] as const;

/** p.14 SAFETY 4항목 */
export const SAFETY_ITEMS = [
  { id: 'cap', title: '일 조정 폭 상한', detail: '키워드별 변동 한도 사전 합의' },
  { id: 'brand', title: '브랜드 키워드 별도 기준', detail: '점유 방어와 효율을 함께 판단' },
  { id: 'log', title: '변경 이력 전체 기록', detail: '누가 · 언제 · 왜' },
  { id: 'rollback', title: '즉시 롤백', detail: '직전 입찰 상태로 복원' },
] as const;

/* ------------------------------------------------------------------ */
/* 모듈 가정 (제안서에 수치가 없는 운영 파라미터 — 온보딩 중 확정)            */
/* ------------------------------------------------------------------ */
export const MODULE_ASSUMPTIONS = {
  /** 급변 판정 창: 최근 3일 vs 같은 14일 창의 직전 11일 (SPEC §4 "최근 3일 CPC/전환 ±50%") */
  anomalyWindowDays: 3,
  /** 급변 판정 최소 표본: 최근 3일 클릭 20회 이상일 때만 CPC 급변 판정 (소표본 오탐 방지) */
  anomalyMinClicks: 20,
  /** 급변 판정 최소 표본: 기준선 기대 전환 1건 이상일 때만 전환 급변 판정 */
  anomalyMinExpectedConv: 1,
  /** 브랜드 순위 방어 기준 (평균 순위 2위 이내) */
  brandRankTarget: 2,
  /** 1회 최소 조정 폭 (%) — 이보다 작은 조정은 제안하지 않음 */
  minStepPct: 5,
  /** 일 예산 조기 소진 판정 시각 (campaignPacing 과 같은 23시 기준) */
  exhaustBeforeHour: 23,
  /** 대량 변경 실수 방지: 한 번에 N건 이상 경고 · M건 이상 차단 (p.45 대량 변경 실수) */
  bulkWarnCount: 5,
  bulkBlockCount: 15,
  /** 입찰 시뮬레이션 탄력성 가정 — 실측 아님 (반영 후 7일 실측으로 보정) */
  clickElasticity: 0.6,
  cpcElasticity: 0.7,
  /** 네이버 SA 최소 입찰가 (원) */
  minBid: 70,
  /** 재배분 재원 조건: 시간대 가중 예상 소진율 95% 미만인 같은 매체 캠페인 */
  donorPaceMax: 0.95,
} as const;

/* ------------------------------------------------------------------ */
/* p.15 GFA Control v1 흐름 · 기대 효과                                   */
/* ------------------------------------------------------------------ */
export const GFA_FLOW_STEPS = [
  { no: '01', title: '성과 · 예산 모니터링', detail: 'Pro-board에서 소진 속도와 성과 이상 확인' },
  { no: '02', title: '변경 요청', detail: '예산 · 광고그룹 상태 조정안 생성' },
  { no: '03', title: '승인 라우팅', detail: '담당 AE → PM → 광고주, 위임 범위별 차등' },
  { no: '04', title: '실행 · 이력', detail: '지원 API 범위 내 실행, 오류 시 보류 · 보고' },
] as const;
export const GFA_EFFECTS = ['수동 변경 부담 감소', '설정 오류 감소', '책임자 · 실행 결과 추적'] as const;

/* ------------------------------------------------------------------ */
/* GFA 다계정 (DEMO) — 주 계정은 data.accounts 의 acc_gfa 를 그대로 쓴다     */
/* ------------------------------------------------------------------ */
export const GFA_MAIN_ACCOUNT_ID = 'acc_gfa';

/** 데모 추가 계정 (시연용 가정 · 실제 계정 아님) */
export const GFA_DEMO_ACCOUNTS: AdAccount[] = [
  {
    id: 'gfa_mall', media: 'naver_gfa', name: '네이버 GFA · 자사몰 전환 (DEMO 가정)', owner: '수면밀도',
    balance: 6_200_000, avgDailySpend: 410_000, autoCharge: 'ok', paymentMethod: '비즈머니 · 자동충전 카드', status: 'active',
    permissions: [
      { user: 'DA AE', role: '운영', realName: true, lastLogin: '2026-10-31' },
      { user: 'PM', role: '관리자', realName: true, lastLogin: '2026-10-30' },
    ],
  },
  {
    id: 'gfa_pilot', media: 'naver_gfa', name: '네이버 GFA · 신규 지면 파일럿 (DEMO 가정)', owner: '수면밀도',
    balance: 1_500_000, avgDailySpend: 0, autoCharge: 'off', paymentMethod: '비즈머니 · 수동 충전', status: 'active',
    permissions: [{ user: 'DA AE', role: '운영', realName: true, lastLogin: '2026-10-29' }],
  },
];

/** 데모 추가 캠페인 — spentToday 는 엔진이 GFA 시간대 소진 곡선 × paceMult 로 계산 */
export const GFA_DEMO_CAMPAIGNS: (Omit<Campaign, 'spentToday' | 'hourOfData'> & { accountId: string; paceMult: number })[] = [
  { id: 'gfa_c_mall_rt', media: 'naver_gfa', name: 'GFA_자사몰 방문자 리타겟팅', dailyBudget: 420_000, status: 'on', accountId: 'gfa_mall', paceMult: 0.96 },
  { id: 'gfa_c_beta', media: 'naver_gfa', name: 'GFA_잠재고객 확장(Beta) 테스트', dailyBudget: 200_000, status: 'off', accountId: 'gfa_pilot', paceMult: 0 },
];

/** 광고그룹 (DEMO 가정) — 캠페인 이름 기준. share = 캠페인 일 예산 중 비중 */
export const GFA_AD_GROUPS: Record<string, { id: string; name: string; share: number; status: 'on' | 'off'; note?: string }[]> = {
  'GFA_Prospecting': [
    { id: 'ag_pros_interest', name: '관심사 · 홈 인테리어', share: 0.4, status: 'on' },
    { id: 'ag_pros_lookalike', name: '유사 타겟 · 구매자 1%', share: 0.35, status: 'on' },
    { id: 'ag_pros_demo', name: '여성 31~50세 · 전국', share: 0.25, status: 'on' },
  ],
  'GFA_쇼핑 고객 확장': [
    { id: 'ag_shop_bed', name: '쇼핑 고객 확장 · 침구 · 매트리스', share: 0.6, status: 'on' },
    { id: 'ag_shop_furn', name: '쇼핑 고객 확장 · 가구 · 인테리어', share: 0.4, status: 'on' },
  ],
  'GFA_리타겟팅': [
    { id: 'ag_rt_detail', name: '상세 조회 7일 · 미구매', share: 0.55, status: 'on' },
    { id: 'ag_rt_cart', name: '장바구니 14일', share: 0.45, status: 'on' },
  ],
  'GFA_자사몰 방문자 리타겟팅': [
    { id: 'ag_mall_visit', name: '자사몰 방문 30일', share: 0.7, status: 'on' },
    { id: 'ag_mall_dynamic', name: '다이내믹 소재 · 조회 상품', share: 0.3, status: 'off', note: '소재 검수 대기' },
  ],
  'GFA_잠재고객 확장(Beta) 테스트': [
    { id: 'ag_beta_lookalike', name: '잠재고객 확장(Beta) · 매트리스 관심', share: 1, status: 'off', note: '수면밀도 승인 전 대기' },
  ],
};

/** GFA 신규 캠페인 요청 목적 (p.24 GFA 신규 지면 · p.37 GFA 세팅) */
export const GFA_OBJECTIVES = ['Prospecting', '쇼핑 고객 확장', '잠재고객 확장(Beta)', '리타겟팅', '다이내믹 소재'] as const;
