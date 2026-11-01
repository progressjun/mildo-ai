/**
 * MILDO Watch 전용 상수 · 시드 데이터.
 * 출처 표기: 제안서(2027 v3) 장표 번호. "운영 가정"은 제안서에 수치가 없어 초기값으로 둔 값이며 온보딩 중 확정한다.
 * DEMO 표기 항목(매체 공지 이벤트 · 경쟁사 스냅샷 · 브랜드 지면 스냅샷 · 검색 트렌드 지수)은 시연용 가상 데이터다.
 * 실제 매체 공지 · 실제 경쟁사 활동 · 실제 판매가가 아니다.
 */
import type { IntentId, MediaId } from '@/core/types';

/* ============================== 파이프라인 (p.24 하단) ============================== */

export type StageId = 'detect' | 'diagnose' | 'plan' | 'test' | 'wrapup';
/** 변동 감지 → 24시간 내 영향 진단 → 주간 리포트 실행안 → 소액 테스트 → 랩업 · 확대 (p.24) */
export const PIPELINE: { id: StageId; label: string; short: string; due: string }[] = [
  { id: 'detect', label: '변동 감지', short: '감지', due: '감지 즉시 기록' },
  { id: 'diagnose', label: '24시간 내 영향 진단', short: '영향 진단', due: '감지 후 24시간 (p.24)' },
  { id: 'plan', label: '주간 리포트 실행안', short: '실행안', due: '다음 주간 리포트 월 10:00 (p.17)' },
  { id: 'test', label: '소액 테스트', short: '소액 테스트', due: '14일 또는 최소 표본 (p.26 · p.28)' },
  { id: 'wrapup', label: '랩업 · 확대', short: '랩업', due: '액션 후 2주 랩업 · 결과 판정 (p.28)' },
];
export const STAGE_INDEX: Record<StageId, number> = { detect: 0, diagnose: 1, plan: 2, test: 3, wrapup: 4 };

/* ============================== 매체 변동 선제 트래킹 (p.24) ============================== */

export interface TrackingRow {
  media: MediaId;
  name: string;
  target: string; // 트래킹 대상
  method: string; // 감지 방식
  plan: string; // 수면밀도 실행안
}
/** p.24 표 — 문구는 제안서 표기 그대로 (네이버 GFA 날짜 표기 포함) */
export const MEDIA_TRACKING: TrackingRow[] = [
  { media: 'naver_sa', name: '네이버 SA', target: '검색 광고 지면 · 노출 로직 · 신규 기능', method: '파트너 공지 · 3자 미팅 · 순위 모니터링', plan: '핵심 키워드 영향 진단 → 입찰 · 확장 조정' },
  { media: 'naver_gfa', name: '네이버 GFA', target: '쇼핑 고객 확장 · 잠재고객 확장(Beta) · 다이내믹 소재 (2026.10.28)', method: '파트너 공지 · 테스트 참여', plan: '신규 광고그룹 분리 → 기존 그룹 대비 증분 매출 비교' },
  { media: 'kakao', name: '카카오', target: '카카오톡 지면 · 비즈보드 상품 변화', method: '매체 공지 · 담당자 채널', plan: '리타겟팅 그룹 우선 적용 · CPA 비교' },
  { media: 'google', name: 'Google', target: 'Performance Max · Demand Gen 기능 변화', method: '업데이트 노트 · 계정 진단', plan: '자사몰 전환 기준 소액 테스트' },
  { media: 'meta', name: 'Meta', target: 'Advantage+ · 타겟 정책 변화', method: '업데이트 노트 · 계정 진단', plan: '전환 데이터 충분 시 단계 적용' },
  { media: 'vertical', name: '쿠팡 · 오늘의집', target: '판매 채널 광고 상품 · 지면 변화', method: '채널 공지 · 노출 점검', plan: '채널 ROAS 기준 예산 조정' },
];

/* ============================== 감지 이벤트 시드 (DEMO) ============================== */

export type EventKind = 'product' | 'placement' | 'logic' | 'policy' | 'feature' | 'competitor' | 'demand';
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  product: '신규 상품',
  placement: '광고 지면',
  logic: '노출 로직',
  policy: '정책 변화',
  feature: '기능 변화',
  competitor: '경쟁 · 입찰',
  demand: '수요 변화',
};

export interface TestArmResult { clicks: number; conversions: number; revenue?: number; cost?: number }
export interface TestPlanSeed {
  hypothesis: string;
  arms: string; // 비교 대상
  metric: string;
  /** 해당 캠페인 일 예산 대비 테스트 예산 비율 (없으면 config 기본값) */
  budgetShare?: number;
  days?: number;
  /** 테스트 시작일 (이미 진행 중인 시드) */
  start?: string;
  /** 시드 결과 (DEMO) — control = 기존 그룹, test = 신규 그룹 */
  result?: { control: TestArmResult; test: TestArmResult };
}

export interface EventSeed {
  id: string;
  media: MediaId;
  kind: EventKind;
  title: string;
  summary: string;
  source: string; // 감지 경로
  detectedAt: string; // 'YYYY-MM-DD HH:MM' (KST)
  stage: StageId; // 시연 시작 시점의 단계
  keywords?: string[]; // 영향 키워드 (data.keywords 텍스트)
  intents?: IntentId[];
  campaigns?: string[]; // 영향 캠페인 (data.campaigns 이름)
  accountId?: string;
  plan: string; // 이벤트 단위 실행안
  test?: TestPlanSeed;
  /** 시드 처리 이력 (시연 시작 전 기록) */
  log?: { at: string; by: string; action: string; note?: string }[];
}

/**
 * 시연용 매체 변동 이벤트 (DEMO · 가상 공지).
 * 네이버 GFA 신규 상품 3종과 날짜는 제안서 p.24 표기를 따른다. 그 외 공지 내용은 시연용 가상 이벤트다.
 * 영향 진단 수치는 이 시드가 아니라 engine이 state.data에서 계산한다.
 */
export const EVENT_SEEDS: EventSeed[] = [
  {
    id: 'ev_gfa_products',
    media: 'naver_gfa', kind: 'product',
    title: 'GFA 신규 상품 · 쇼핑 고객 확장 · 잠재고객 확장(Beta) · 다이내믹 소재',
    summary: '제안서 p.24 트래킹 대상 (2026.10.28 표기). 기존 Prospecting 그룹과 섞어 운영하면 증분 매출을 분리할 수 없어 신규 광고그룹으로 분리해 비교한다.',
    source: '파트너 공지 · 테스트 참여',
    detectedAt: '2026-10-28 10:00',
    stage: 'test',
    keywords: ['수면밀도', '밀도 매트리스'],
    campaigns: ['GFA_쇼핑 고객 확장', 'GFA_Prospecting'],
    plan: '신규 광고그룹 분리 → 기존 그룹 대비 증분 매출 비교',
    test: {
      hypothesis: '쇼핑 고객 확장 그룹은 기존 Prospecting 대비 전환율이 같거나 높고, 브랜드 검색량을 1~2일 시차로 끌어올린다',
      arms: '쇼핑 고객 확장 신규 그룹 vs 기존 Prospecting 그룹',
      metric: '전환율 · 신규 CPA · 브랜드 검색 동행',
      start: '2026-10-28',
      result: { control: { clicks: 9860, conversions: 31.2 }, test: { clicks: 4120, conversions: 15.6 } },
    },
    log: [
      { at: '2026-10-28T10:00:00+09:00', by: 'MILDO Watch', action: '감지 · 파트너 공지 수집' },
      { at: '2026-10-28T16:20:00+09:00', by: 'DA AE', action: '영향 진단 완료', note: 'GFA 7일 ROAS · 브랜드 검색 동행 확인' },
      { at: '2026-10-28T17:00:00+09:00', by: 'PM', action: '실행안 확정', note: '신규 광고그룹 분리 · 일 예산 10% 이내' },
      { at: '2026-10-28T18:10:00+09:00', by: 'PM', action: 'Lab 테스트 등록', note: '14일 · 7일차 중간 점검' },
    ],
  },
  {
    id: 'ev_meta_advantage',
    media: 'meta', kind: 'policy',
    title: 'Meta Advantage+ 타겟 확장 기본값 변경 (가상 공지)',
    summary: '넓은 타겟 캠페인의 자동 확장 범위가 넓어지는 변경을 가정한 시연 이벤트. 지출 속도 · 신규 비중 · CPA가 함께 움직이는지 24시간 안에 확인한다.',
    source: '업데이트 노트 · 계정 진단',
    detectedAt: '2026-10-30 16:00',
    stage: 'detect',
    campaigns: ['Meta_넓은 타겟', 'Meta_리타겟팅'],
    plan: '전환 데이터 충분 시 단계 적용 — 넓은 타겟 광고세트 1개에 먼저 적용',
    test: { hypothesis: 'Advantage+ 확장 적용 광고세트가 기존 대비 CPA를 유지하면서 신규 비중을 높인다', arms: 'Advantage+ 적용 광고세트 vs 기존 광고세트', metric: 'CPA · 신규 비중 · 전환율' },
    log: [{ at: '2026-10-30T16:00:00+09:00', by: 'MILDO Watch', action: '감지 · 업데이트 노트 수집' }],
  },
  {
    id: 'ev_google_demandgen',
    media: 'google', kind: 'feature',
    title: 'Google Demand Gen 소재 형식 · 입찰 옵션 업데이트 (가상 공지)',
    summary: '영상 · 이미지 혼합 소재와 전환 가치 입찰 옵션이 추가되는 상황을 가정한 시연 이벤트. 자사몰 전환 기준으로만 판단한다.',
    source: '업데이트 노트 · 계정 진단',
    detectedAt: '2026-10-31 09:00',
    stage: 'detect',
    campaigns: ['Google_Demand Gen'],
    plan: '자사몰 전환 기준 소액 테스트',
    test: { hypothesis: '혼합 소재 광고그룹이 기존 이미지 소재 대비 자사몰 전환율을 15% 이상 높인다', arms: '신규 형식 소재 광고그룹 vs 기존 광고그룹', metric: '자사몰 전환율 · CPA' },
    log: [{ at: '2026-10-31T09:00:00+09:00', by: 'MILDO Watch', action: '감지 · 업데이트 노트 수집' }],
  },
  {
    id: 'ev_kakao_bizboard',
    media: 'kakao', kind: 'placement',
    title: '카카오톡 비즈보드 지면 노출 구좌 변경 (가상 공지)',
    summary: '채팅탭 상단 구좌 노출 방식이 바뀌는 상황을 가정한 시연 이벤트. 리타겟팅 그룹에 먼저 적용해 CPA를 비교한다.',
    source: '매체 공지 · 담당자 채널',
    detectedAt: '2026-10-29 11:00',
    stage: 'plan',
    campaigns: ['카카오_장바구니 리마케팅', '카카오_프로모션'],
    plan: '리타겟팅 그룹 우선 적용 · CPA 비교',
    test: { hypothesis: '변경 구좌를 장바구니 리마케팅 그룹에 먼저 적용하면 CPA가 기존 대비 같거나 낮다', arms: '변경 구좌 적용 리마케팅 그룹 vs 기존 그룹', metric: 'CPA · 전환율' },
    log: [
      { at: '2026-10-29T11:00:00+09:00', by: 'MILDO Watch', action: '감지 · 담당자 채널 공유' },
      { at: '2026-10-29T17:30:00+09:00', by: 'DA AE', action: '영향 진단 완료', note: '리마케팅 CPA 기준선 기록' },
      { at: '2026-10-30T10:00:00+09:00', by: 'PM', action: '실행안 확정', note: '11/2 주간 리포트 반영' },
    ],
  },
  {
    id: 'ev_sa_mobile_logic',
    media: 'naver_sa', kind: 'logic',
    title: '네이버 SA 모바일 검색 결과 광고 노출 영역 변경 (가상 공지)',
    summary: '모바일 파워링크 노출 영역 · 확장 소재 노출 기준이 바뀌는 상황을 가정한 시연 이벤트. 일반 제품 · 비교 검토 키워드의 CPC · 순위를 먼저 본다.',
    source: '파트너 공지 · 3자 미팅 · 순위 모니터링',
    detectedAt: '2026-10-30 10:00',
    stage: 'diagnose',
    keywords: ['매트리스', '퀸 매트리스', '매트리스 추천', '매트리스 비교'],
    intents: ['generic', 'compare'],
    campaigns: ['SA_일반 제품', 'SA_비교 · 검토'],
    plan: '핵심 키워드 영향 진단 → 입찰 · 확장 조정 (AD Pilot 조정 후보로 전달)',
    test: { hypothesis: '확장 소재를 붙인 비교 · 검토 광고그룹이 기존 대비 CTR · 전환율을 유지하면서 CPC 상승을 흡수한다', arms: '확장 소재 적용 광고그룹 vs 기존 광고그룹', metric: 'CTR · 전환율 · CPC' },
    log: [
      { at: '2026-10-30T10:00:00+09:00', by: 'MILDO Watch', action: '감지 · 파트너 공지 수집' },
      { at: '2026-10-30T15:40:00+09:00', by: 'SA Lead AE', action: '영향 진단 완료', note: '일반 · 비교 키워드 CPC 추이 확인' },
    ],
  },
  {
    id: 'ev_ohouse_review',
    media: 'vertical', kind: 'policy',
    title: '오늘의집 상품 광고 검수 기준 강화 (가상 공지)',
    summary: '상품 광고 소재 · 상세 정보 검수 기준이 강화되는 상황을 가정한 시연 이벤트. 계정 검수 상태와 채널 ROAS를 함께 본다.',
    source: '채널 공지 · 노출 점검',
    detectedAt: '2026-10-28 14:00',
    stage: 'diagnose',
    campaigns: ['오늘의집_상품광고', '쿠팡_상품광고'],
    accountId: 'acc_ohouse',
    plan: '채널 ROAS 기준 예산 조정 — 검수 완료 전까지 쿠팡 상품광고로 일시 재배분 검토',
    test: { hypothesis: '검수 기준에 맞춘 상세 정보 보강 소재가 기존 대비 채널 ROAS를 유지한다', arms: '보강 소재 vs 기존 소재', metric: '채널 ROAS · 전환율' },
    log: [
      { at: '2026-10-28T14:00:00+09:00', by: 'MILDO Watch', action: '감지 · 채널 공지 수집' },
      { at: '2026-10-29T10:30:00+09:00', by: 'DA AE', action: '영향 진단 완료', note: '오늘의집 계정 검수 상태 확인' },
    ],
  },
  {
    id: 'ev_sa_expand_beta',
    media: 'naver_sa', kind: 'feature',
    title: '네이버 SA 키워드 확장(베타) 테스트 참여 (가상)',
    summary: '생활 상황 캠페인에 키워드 확장 기능을 붙여 구문형 유입을 늘리는 테스트를 가정한 시연 이벤트. 10/17에 시작한 14일 테스트가 기준일에 끝나 랩업 판정이 가능한 상태.',
    source: '파트너 공지 · 테스트 참여',
    detectedAt: '2026-10-08 10:00',
    stage: 'test',
    intents: ['life'],
    campaigns: ['SA_생활 상황'],
    plan: '생활 상황 캠페인 1개 광고그룹에 확장 적용 → 기존 그룹 대비 전환율 비교',
    test: {
      hypothesis: '키워드 확장을 붙인 생활 상황 광고그룹이 기존 대비 전환율을 15% 이상 높인다',
      arms: '확장 적용 광고그룹 vs 기존 광고그룹',
      metric: '전환율 · ROAS',
      start: '2026-10-17',
      result: { control: { clicks: 6420, conversions: 70.4 }, test: { clicks: 6080, conversions: 91.8 } },
    },
    log: [
      { at: '2026-10-08T10:00:00+09:00', by: 'MILDO Watch', action: '감지 · 파트너 공지 수집' },
      { at: '2026-10-08T15:00:00+09:00', by: 'SA Lead AE', action: '영향 진단 완료' },
      { at: '2026-10-12T10:00:00+09:00', by: 'PM', action: '실행안 확정', note: '10/12 주간 리포트' },
      { at: '2026-10-12T14:00:00+09:00', by: 'PM', action: 'Lab 테스트 등록', note: '14일 · 일 예산 10% · 승인 · 세팅 후 10/17 집행 시작' },
    ],
  },
  {
    id: 'ev_coupang_slot',
    media: 'vertical', kind: 'placement',
    title: '쿠팡 상품광고 검색 상단 구좌 변경 (가상 공지)',
    summary: '검색 결과 상단 상품광고 구좌 수가 바뀌는 상황을 가정한 시연 이벤트. 테스트 후 랩업까지 끝난 기록.',
    source: '채널 공지 · 노출 점검',
    detectedAt: '2026-10-01 10:00',
    stage: 'wrapup',
    campaigns: ['쿠팡_상품광고'],
    plan: '채널 ROAS 기준 예산 조정',
    test: {
      hypothesis: '상단 구좌 입찰 상향 그룹이 기존 대비 전환율을 15% 이상 높인다',
      arms: '상단 구좌 입찰 상향 그룹 vs 기존 그룹',
      metric: '전환율 · 채널 ROAS',
      start: '2026-10-05',
      result: { control: { clicks: 3920, conversions: 92.1 }, test: { clicks: 3760, conversions: 90.4 } },
    },
    log: [
      { at: '2026-10-01T10:00:00+09:00', by: 'MILDO Watch', action: '감지 · 채널 공지 수집' },
      { at: '2026-10-01T16:00:00+09:00', by: 'DA AE', action: '영향 진단 완료' },
      { at: '2026-10-05T10:00:00+09:00', by: 'PM', action: '실행안 확정' },
      { at: '2026-10-05T11:00:00+09:00', by: 'PM', action: 'Lab 테스트 등록' },
      { at: '2026-10-19T10:00:00+09:00', by: 'PM', action: '랩업 기록', note: '유지 · 모니터링 지속 — 전환율 차이 기준 미달' },
    ],
  },
];

/* ============================== 운영 기준 (Watch 진단 · 감지) ============================== */

/**
 * Watch 감지 · 진단 기준 초기값.
 * p.47 주의 기준(광고비 · 클릭 ±30%, 전환 −30%, CPA +30%, ROAS −20%)을 영향 진단 기준으로 쓰고,
 * 키워드 CPC 선제 감지는 AD Pilot 자동 조정 보류 기준(±50%, p.14)보다 낮은 +30%로 둔다 (운영 가정).
 */
export const WATCH_DEFAULTS = {
  diagnoseSlaHours: 24, // p.24 "24시간 내 영향 진단"
  kwRecentDays: 3, // 최근 3일 vs 직전 11일 (운영 가정 · MILDO Alert 키워드 성과 급변과 같은 구간)
  kwCpcUpPct: 30, // 운영 가정 — 선제 감지
  kwMinClicks: 30, // 운영 가정 — 최근 3일 최소 클릭
  mediaSpikePct: 50, // p.44 데이터 급변 ±50% (동요일 · 동시간)
  mediaWindowHours: 2, // 최근 2시간 구간 (운영 가정)
  brandRankMax: 2.0, // 브랜드 키워드 평균 순위 2.0 이상 = 상위에 다른 광고 (MILDO Alert p.45 기준과 동일)
  brandRankDanger: 3.0, // 평균 순위 3.0 이상 = 위험 (운영 가정 — 상위 2개 이상 다른 광고)
  brandLostMin: 0.2, // 노출 기회 손실 20% 이상
  lifeMinConv: 1, // 미등록 생활 상황 검색어 최소 전환
  lifeMinTerms: 2, // 신호로 볼 최소 검색어 수
  trackingZeroHours: 3, // 연속 전환 0 시간 (p.45 전환 추적 단절 — Alert 기준과 동일)
  testBudgetShare: 0.1, // 소액 테스트 = 해당 캠페인 일 예산의 10% (운영 가정)
  testDays: 14, // p.26 · p.28 "14일 또는 최소 표본"
  testMinClicks: 100, // p.26 최소 클릭 초기값 (KEYWORD_TEST_RULES)
  promoShareShiftPct: 5, // 경쟁사 프로모션 영향 추정: 해당 의도 매출 중 점유 이동 가정 (운영 가정)
  searchShiftPct: 30, // 브랜드 검색량 전일 vs 최근 4주 동요일 ±30% (MILDO Alert 외부 환경 기준과 동일)
} as const;

/**
 * 일 예산 소진 예상 기준 — MILDO Board · AD Pilot · Alert · 커맨드 센터와 같은 값 (같은 숫자는 같은 기준으로 계산).
 * 최근 28일(오늘 제외) 매체 시간대별 광고비 누적 비중 곡선으로 오늘 예상 마감 시각을 구하고, 선형 추정이 더 이르면 선형을 쓴다.
 * 23시 전 마감 = 조기 소진 (p.14 '일 예산 조기 소진 예상'), 21시 전 = 저녁 21~23시 피크 전 소진 (모듈 가정 · 시간대 히트맵으로 확인).
 */
export const PACE_RULES = { curveDays: 28, exhaustBeforeHour: 23, peakStartHour: 21 } as const;

/* ============================== 오가닉 · 페이드 통합 아카이빙 (p.25) ============================== */

export type ArchiveItemId = 'serp' | 'creative' | 'price' | 'offline' | 'external' | 'partner';
export interface ArchiveItem { id: ArchiveItemId; label: string; scope: string; cadence: string; cadenceSrc: string; perCompetitor: boolean }
/** p.25 아카이빙 항목 — scope/cadence 중 제안서 표기는 cadenceSrc 'p.25', 나머지는 운영 가정 */
export const ARCHIVE_ITEMS: ArchiveItem[] = [
  { id: 'serp', label: '검색 지면 노출', scope: '페이드 · 오가닉', cadence: '일 1회 스냅샷', cadenceSrc: '운영 가정', perCompetitor: true },
  { id: 'creative', label: '소재 · 프로모션', scope: '광고 소재 · 기획전', cadence: '변경 즉시 알림', cadenceSrc: 'p.25', perCompetitor: true },
  { id: 'price', label: '가격 · 혜택', scope: '판매가 · 쿠폰 · 사은품', cadence: '일 단위', cadenceSrc: 'p.25', perCompetitor: true },
  { id: 'offline', label: '오프라인 동향', scope: '매장 · 팝업 · 제휴', cadence: '주 단위', cadenceSrc: '운영 가정', perCompetitor: true },
  { id: 'external', label: '외부 변수', scope: '검색 트렌드 · 이사 · 혼인 시즌', cadence: '주 단위', cadenceSrc: '운영 가정', perCompetitor: false },
  { id: 'partner', label: '파트너 매체 인사이트', scope: '매체 파트너 공유 자료', cadence: '월간 공유', cadenceSrc: 'p.25', perCompetitor: false },
];

export interface ArchiveRecord {
  id: string;
  date: string;
  competitor: string | null; // RFP.competitors 중 하나 · 공통 항목은 null
  item: ArchiveItemId;
  channel: 'paid' | 'organic' | 'offline' | 'common';
  title: string;
  detail: string;
  /** 검색 지면: 노출 키워드 · 위치 */
  serp?: { keyword: string; position: number };
  /** 소재 · 프로모션: 기간 · 할인 · 테마 */
  promo?: { start: string; end: string; discountRate: number; theme: string };
  /** 가격 · 혜택: 퀸 사이즈 기준 실판매가 (원) */
  price?: { size: string; list: number; effective: number; prevEffective: number; perk?: string };
  /** 오프라인: 기간 */
  period?: { start: string; end: string };
  relatedMedia?: MediaId;
}

/**
 * 경쟁사 아카이브 스냅샷 (DEMO · 가상).
 * 실제 경쟁사의 소재 · 가격 · 매장 활동이 아니다. 화면 동작과 영향도 판정 로직 시연용이다.
 */
export const ARCHIVE_RECORDS: ArchiveRecord[] = [
  { id: 'ar01', date: '2026-10-31', competitor: '퀵슬립', item: 'serp', channel: 'paid', title: "'수면밀도' 검색 결과 파워링크 노출", detail: '브랜드 키워드 검색 결과 상단 광고 영역에 노출 (스냅샷 07:00)', serp: { keyword: '수면밀도', position: 1 } },
  { id: 'ar02', date: '2026-10-31', competitor: '지누스', item: 'serp', channel: 'paid', title: "'밀도 매트리스' 검색 결과 파워링크 노출", detail: '브랜드 키워드 검색 결과 상단 광고 영역 2번째 (스냅샷 07:00)', serp: { keyword: '밀도 매트리스', position: 2 } },
  { id: 'ar03', date: '2026-10-29', competitor: '베스트슬립', item: 'serp', channel: 'paid', title: "'매트리스 추천' 파워링크 1위 신규 진입", detail: '비교 · 검토 핵심 키워드 상단 1위 — 직전 스냅샷 미노출', serp: { keyword: '매트리스 추천', position: 1 } },
  { id: 'ar04', date: '2026-10-24', competitor: '올라인매트리스', item: 'serp', channel: 'organic', title: "'매트리스 경도' 블로그 · 카페 상위 콘텐츠 3건 신규", detail: '오가닉 콘텐츠 영역 상위 10건 중 3건 신규 진입', serp: { keyword: '매트리스 경도', position: 3 } },
  { id: 'ar05', date: '2026-10-17', competitor: '휴도', item: 'serp', channel: 'organic', title: "'신혼 매트리스' 쇼핑 탭 상위 상품 교체", detail: '쇼핑 영역 상위 5개 중 2개 교체', serp: { keyword: '신혼 매트리스', position: 4 } },
  { id: 'ar06', date: '2026-10-30', competitor: '베스트슬립', item: 'creative', channel: 'paid', title: '신혼 · 혼수 기획전 소재 교체 — 최대 20% 할인 문구', detail: 'DA · SA 소재 동시 교체, 기획전 랜딩 신규', promo: { start: '2026-10-30', end: '2026-11-15', discountRate: 20, theme: '신혼' } },
  { id: 'ar07', date: '2026-10-27', competitor: '지누스', item: 'creative', channel: 'paid', title: '11월 쇼핑 행사 사전 알림 소재 노출', detail: '사전 알림 신청형 소재 · 행사 기간 할인율 미공개', promo: { start: '2026-11-20', end: '2026-11-30', discountRate: 0, theme: '쇼핑 행사' } },
  { id: 'ar08', date: '2026-10-22', competitor: '퀵슬립', item: 'creative', channel: 'paid', title: '이사 시즌 기존 매트리스 수거 혜택 소재', detail: '이사 · 입주 타겟 소재, 수거 무료 혜택 강조', promo: { start: '2026-10-22', end: '2026-11-10', discountRate: 10, theme: '이사' } },
  { id: 'ar09', date: '2026-10-12', competitor: '웰퍼니처', item: 'creative', channel: 'paid', title: '가을 침실 교체 기획전 소재', detail: '침대 프레임 + 매트리스 번들 소재', promo: { start: '2026-10-12', end: '2026-10-26', discountRate: 10, theme: '침실 교체' } },
  { id: 'ar10', date: '2026-10-05', competitor: '휴도', item: 'creative', channel: 'organic', title: '포토 리뷰 적립 이벤트 소재', detail: '리뷰 이벤트 · 할인 없음', promo: { start: '2026-10-05', end: '2026-10-31', discountRate: 0, theme: '리뷰' } },
  { id: 'ar11', date: '2026-10-31', competitor: '지누스', item: 'price', channel: 'paid', title: '퀸 사이즈 쿠폰 적용가 인하', detail: '퀸 기준 판매가 389,000원 → 쿠폰 적용 349,000원', price: { size: '퀸', list: 389000, effective: 349000, prevEffective: 389000 } },
  { id: 'ar12', date: '2026-10-30', competitor: '베스트슬립', item: 'price', channel: 'paid', title: '기획전 할인율 10% → 20% 상향', detail: '퀸 기준 699,000원 · 기획전 20% 적용 559,200원', price: { size: '퀸', list: 699000, effective: 559200, prevEffective: 629100 } },
  { id: 'ar13', date: '2026-10-25', competitor: '퀵슬립', item: 'price', channel: 'paid', title: '퀸 사이즈 7% 쿠폰 신규', detail: '퀸 기준 590,000원 → 548,700원', price: { size: '퀸', list: 590000, effective: 548700, prevEffective: 590000 } },
  { id: 'ar14', date: '2026-10-18', competitor: '올라인매트리스', item: 'price', channel: 'paid', title: '구매 사은품 추가 (베개 2개)', detail: '판매가 유지 · 사은품 추가', price: { size: '퀸', list: 450000, effective: 450000, prevEffective: 450000, perk: '베개 2개' } },
  { id: 'ar15', date: '2026-10-09', competitor: '웰퍼니처', item: 'price', channel: 'paid', title: '퀸 사이즈 10% 할인', detail: '퀸 기준 880,000원 → 792,000원', price: { size: '퀸', list: 880000, effective: 792000, prevEffective: 880000 } },
  { id: 'ar16', date: '2026-10-26', competitor: '지누스', item: 'offline', channel: 'offline', title: '수도권 쇼핑몰 팝업스토어 운영', detail: '11/1~11/14 체험형 팝업 (가상)', period: { start: '2026-11-01', end: '2026-11-14' } },
  { id: 'ar17', date: '2026-10-19', competitor: '웰퍼니처', item: 'offline', channel: 'offline', title: '가구 전시장 신규 오픈', detail: '경기 남부 전시장 (가상)', period: { start: '2026-10-19', end: '2026-12-31' } },
  { id: 'ar18', date: '2026-10-08', competitor: '베스트슬립', item: 'offline', channel: 'offline', title: '웨딩 박람회 제휴 부스', detail: '10/10~10/11 박람회 제휴 (가상)', period: { start: '2026-10-10', end: '2026-10-11' } },
  { id: 'ar19', date: '2026-10-28', competitor: null, item: 'external', channel: 'common', title: '가을 혼인 시즌 · 이사 성수기 겹침 구간 (가설)', detail: "'신혼' · '이사' 계열 구문형 검색어 유입을 주간 단위로 추적 — 검색 트렌드 연동 전 가설" },
  { id: 'ar20', date: '2026-10-14', competitor: null, item: 'external', channel: 'common', title: '추석 연휴 이후 이사 수요 회복 구간 (가설)', detail: '연휴 이후 2~3주 이사 · 입주 수요 회복을 가정 — 검증 전' },
  { id: 'ar21', date: '2026-10-15', competitor: null, item: 'partner', channel: 'common', title: '네이버 파트너 월간 인사이트 — 가구 카테고리 검색 광고 경쟁 강도 (가상)', detail: '가구 · 침구 카테고리 평균 CPC 상승 추세 공유 (월간)', relatedMedia: 'naver_sa' },
  { id: 'ar22', date: '2026-10-01', competitor: null, item: 'partner', channel: 'common', title: '카카오 담당자 채널 — 비즈보드 구좌 개편 예고 (가상)', detail: '11월 중 구좌 운영 방식 안내 예정', relatedMedia: 'kakao' },
];

/* ============================== 브랜드 키워드 검색 결과 지면 (DEMO) ============================== */

export interface SerpSeed {
  keyword: string;
  /** 파워링크 영역에 함께 노출된 다른 광고주 (위에서부터, 자사 제외) */
  others: string[];
  brandSearchAd: boolean; // 브랜드검색 광고 영역 자사 노출
  shoppingTop10: { own: number; competitor: number };
  contentTop10: { competitorMentions: number };
}
/** 브랜드 키워드 검색 결과 스냅샷 (DEMO · 07:00 수집 가정). 자사 광고 위치는 data.keywords의 평균 순위로 정한다. */
export const BRAND_SERP_SEEDS: SerpSeed[] = [
  { keyword: '수면밀도', others: ['퀵슬립', '지누스', '가구 플랫폼 (비경쟁)', '베스트슬립'], brandSearchAd: true, shoppingTop10: { own: 7, competitor: 2 }, contentTop10: { competitorMentions: 1 } },
  { keyword: '밀도 매트리스', others: ['베스트슬립', '지누스', '휴도', '침구 쇼핑몰 (비경쟁)'], brandSearchAd: true, shoppingTop10: { own: 5, competitor: 4 }, contentTop10: { competitorMentions: 3 } },
  { keyword: '수면밀도 매트리스', others: ['퀵슬립', '올라인매트리스', '지누스', '가구 플랫폼 (비경쟁)'], brandSearchAd: true, shoppingTop10: { own: 6, competitor: 3 }, contentTop10: { competitorMentions: 2 } },
  { keyword: '밀도매트리스 후기', others: ['리뷰 플랫폼 (비경쟁)', '가구 플랫폼 (비경쟁)', '베스트슬립'], brandSearchAd: false, shoppingTop10: { own: 4, competitor: 3 }, contentTop10: { competitorMentions: 4 } },
];

/* ============================== 외부 변수 · 시즌 캘린더 (가설) ============================== */

export type SeasonKind = 'move' | 'wedding' | 'shopping';
export interface SeasonWindow { id: string; kind: SeasonKind; label: string; start: string; end: string; intents: IntentId[]; prep: string }
export const SEASON_KIND_LABEL: Record<SeasonKind | 'holiday' | 'promo', string> = {
  move: '이사 성수기',
  wedding: '혼인 시즌',
  shopping: '대형 쇼핑 행사',
  holiday: '공휴일 · 연휴',
  promo: '자사 프로모션',
};
/**
 * 시즌 창 (가설). 이사 · 혼인 시즌은 일반적인 관측을 옮긴 가설이고 수면밀도 데이터로 검증 전이다.
 * 대형 쇼핑 행사 일정은 주최 측 발표로 확인이 필요하다.
 */
export const SEASON_WINDOWS: SeasonWindow[] = [
  { id: 'move_fall_26', kind: 'move', label: '가을 이사 성수기', start: '2026-09-01', end: '2026-11-30', intents: ['life'], prep: '생활 상황(이사 · 첫 독립) 광고그룹 예산 · 소재 점검' },
  { id: 'wed_fall_26', kind: 'wedding', label: '가을 혼인 시즌', start: '2026-10-01', end: '2026-11-30', intents: ['life', 'compare'], prep: '신혼 구문형 키워드 테스트 · 사이즈 비교 랜딩 점검' },
  { id: 'shop_nov_26', kind: 'shopping', label: '11월 대형 쇼핑 행사 구간', start: '2026-11-11', end: '2026-11-30', intents: ['generic', 'compare'], prep: '경쟁사 할인율 일 단위 대조 · 일반 제품 CPC 상한 재점검' },
  { id: 'shop_yearend', kind: 'shopping', label: '연말 · 새해 시즌', start: '2026-12-15', end: '2027-01-10', intents: ['generic', 'life'], prep: '성탄 · 신정 연휴 전날 사전 점검 (MILDO Alert)' },
  { id: 'shop_seol_27', kind: 'shopping', label: '설 선물 시즌', start: '2027-01-25', end: '2027-02-05', intents: ['life'], prep: '부모님 선물 구문형 키워드 · 배송 마감 안내 소재' },
  { id: 'move_spring_27', kind: 'move', label: '봄 이사 성수기', start: '2027-03-01', end: '2027-04-30', intents: ['life'], prep: '이사 · 첫 독립 구문형 확장 · 생활 상황 캠페인 예산' },
  { id: 'wed_spring_27', kind: 'wedding', label: '봄 혼인 시즌', start: '2027-04-01', end: '2027-05-31', intents: ['life', 'compare'], prep: '신혼 · 혼수 코프로모션 (p.39) · 사이즈 비교 랜딩' },
  { id: 'shop_family_27', kind: 'shopping', label: '가정의 달 선물 시즌', start: '2027-04-25', end: '2027-05-15', intents: ['life'], prep: '부모님 매트리스 선물 캠페인 · 배송 일정 안내' },
];

/**
 * 월별 수요 가설 지수 (100 = 연평균, 1~12월). DEMO · 가설 — 검색 트렌드 API 연동 후 실측으로 교체한다.
 */
export const DEMAND_HYPOTHESIS: { id: string; label: string; colorVar: string; index: number[] }[] = [
  { id: 'move', label: '이사 · 입주 수요 (가설)', colorVar: '--series-3', index: [88, 104, 124, 118, 98, 86, 82, 88, 108, 120, 112, 92] },
  { id: 'wedding', label: '신혼 · 혼수 수요 (가설)', colorVar: '--series-7', index: [84, 90, 106, 122, 126, 96, 78, 80, 98, 124, 120, 86] },
  { id: 'gift', label: '선물 수요 (가설)', colorVar: '--series-2', index: [118, 112, 86, 92, 132, 88, 80, 84, 112, 90, 92, 124] },
];

/** 생활 상황 구문형 검색어 판별 (p.34 D 생활 변화 수요층 · p.36 상황 축) */
/** '독립스프링'(스프링 구조)은 생활 상황이 아니므로 '첫 독립'만 생활 상황으로 본다 */
export const LIFE_TERM_PATTERN = /(신혼|혼수|이사|입주|자취|첫 독립|아이방|아이 방|부모님|선물)/;

/* ============================== 테스트 · 인사이트 운영 루프 (p.28) ============================== */

export const INSIGHT_LOOP = [
  { cycle: '주간', content: '인사이트 브리프 · 이슈 리마인드', output: '개선 제안', watch: '이번 주 감지 사항 → 영향 → 제안 (이 화면 자동 초안)' },
  { cycle: '월간', content: '성과 리뷰 · 테스트 결과 정리', output: '예산 재배분안', watch: '매체 변동 테스트 결과 · 경쟁사 가격 · 프로모션 누적' },
  { cycle: '분기', content: '성장 전략 리뷰 · 네이버 3자 미팅 연계', output: '다음 분기 가설', watch: '시즌 캘린더 · 매체 신규 상품 로드맵' },
  { cycle: '액션 후 2주', content: '랩업 · 결과 판정', output: '확대 · 중단 · 모니터링 지속', watch: '소액 테스트 랩업 (파이프라인 마지막 단계)' },
  { cycle: '수시', content: '파트너 매체 · 내부 레퍼런스 인사이트 공유', output: '이슈 리마인드', watch: '파트너 매체 인사이트 아카이브' },
] as const;

/** p.21 MILDO OS가 맡는 일 — 이 화면이 맡는 영역 */
export const OS_ROLES = [
  { id: 'watch', label: 'Watch', detail: '매체 변동 · 신규 상품 감지', here: true, route: 'watch' },
  { id: 'archive', label: 'Archive', detail: '오가닉 · 페이드 자동 아카이빙', here: true, route: 'watch' },
  { id: 'lab', label: 'Lab', detail: '키워드 · 소재 상시 테스트', here: false, route: 'lab' },
  { id: 'insight', label: 'Insight', detail: '주간 브리프 · 분기 리뷰 · 랩업', here: true, route: 'watch' },
  { id: 'geo', label: 'GEO', detail: 'AI 검색 노출 진단', here: false, route: 'geo' },
] as const;
