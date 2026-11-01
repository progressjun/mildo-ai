/**
 * MILDO Alert 전용 상수 · 시드 데이터.
 * 출처 표기: 제안서(2027 v3) 장표 번호. "운영 가정"은 제안서에 수치가 없어 초기값으로 둔 값이며
 * 제안서 p.44 하단 원칙("수치 기준은 초기값이며, 온보딩 중 수면밀도 데이터로 오탐률을 보며 조정")을 따른다.
 * DEMO 표기 항목은 시연용 테스트 데이터다 (실제 운영 이력 아님).
 */
import type { MediaId, SalesChannelId, Severity } from '@/core/types';

/** 탐지 규칙 메타 — 규칙 id → 이슈 유형(p.44 6유형 / p.45 추가 6종) · 기본 등급 · 출처 장표 */
export const RULES: Record<string, { typeId: string; label: string; severity: Severity; page: string; basis: string }> = {
  campaign_off: { typeId: 'ad_off', label: '캠페인 중지', severity: 'P1', page: 'p.44', basis: '캠페인 상태 OFF · 제한' },
  budget_exhausted: { typeId: 'ad_off', label: '예산 소진 중지', severity: 'P1', page: 'p.44', basis: '오늘 소진액 ≥ 일 예산' },
  budget_forecast: { typeId: 'ad_off', label: '예산 소진 중지 예상', severity: 'P2', page: 'p.44', basis: '최근 28일 시간대 소진 곡선 기준 예상 마감 시각(MILDO Board · AD Pilot 동일 기준) · 미노출 구간 평소 매출 비중 ≥ 20% (비중 기준은 운영 가정)' },
  keyword_no_impression: { typeId: 'ad_off', label: '핵심 키워드 노출 0', severity: 'P1', page: 'p.44', basis: '최근일 노출 0 · 직전 평균 노출 ≥ 10 (핵심 = 브랜드 또는 월 검색 5,000 이상, 운영 가정)' },
  media_no_impression: { typeId: 'ad_off', label: '매체 미노출', severity: 'P1', page: 'p.44', basis: '최근 감지 구간 노출 0 · 동요일 동시간 평균 노출 > 0' },
  account_payment: { typeId: 'account_payment', label: '잔액 · 자동충전', severity: 'P1', page: 'p.44', basis: '선결제 잔액 < 일 평균 소진(1일치) · 자동충전 실패' },
  account_permission: { typeId: 'account_payment', label: '권한 정책 위반', severity: 'P2', page: 'p.50', basis: '담당자 실명 계정 · 최소 권한 원칙 위반 상태 (비실명 · 30일 미사용 권한). 권한 변경 이벤트는 p.44 P1 — 권한 변경 이력 연동 전' },
  account_status: { typeId: 'account_payment', label: '계정 제재 · 검수', severity: 'P2', page: 'p.44', basis: '계정 상태 restricted → P1, review → P2' },
  creative_rejected: { typeId: 'creative_landing', label: '소재 반려', severity: 'P2', page: 'p.44', basis: '매체 검수 결과 반려' },
  creative_pending: { typeId: 'creative_landing', label: '검수 보류', severity: 'P2', page: 'p.44', basis: '검수 대기 24시간 초과 (운영 가정)' },
  landing_error: { typeId: 'creative_landing', label: 'URL 오류', severity: 'P2', page: 'p.44', basis: '랜딩 응답 코드 4xx · 5xx' },
  soldout_landing: { typeId: 'soldout_landing', label: '품절 · 옵션 품절 랜딩', severity: 'P2', page: 'p.45', basis: '키워드가 지정한 옵션이 품절인 상세 페이지로 랜딩' },
  price_mismatch: { typeId: 'price_mismatch', label: '가격 · 프로모션 불일치', severity: 'P2', page: 'p.45', basis: '소재 표기가 ≠ 판매가 × (1 − 할인율), 허용 오차 ±1%' },
  brand_intrusion: { typeId: 'brand_intrusion', label: '브랜드 키워드 침투', severity: 'P2', page: 'p.45', basis: '브랜드 키워드 평균 순위 ≥ 2.0 또는 노출 기회 손실 ≥ 20% (SERP 스냅샷 연동 전 추정 · 수치는 운영 가정)' },
  invalid_traffic: { typeId: 'invalid_traffic', label: '무효 트래픽 급증', severity: 'P2', page: 'p.45', basis: '클릭 동요일 · 동시간 대비 +80% 이상 · CVR −60% 이하 (수치는 운영 가정, 전환 추적 단절 매체 제외)' },
  tracking_break: { typeId: 'tracking_break', label: '전환 추적 단절', severity: 'P1', page: 'p.45', basis: '연속 3시간 전환 0 · 클릭 정상(기준 50% 이상) · 최근 7일 동시간 0 기록 비율 10% 이하 (p.45 전환 0 패턴의 수치화, 운영 가정)' },
  data_spike: { typeId: 'data_spike', label: '데이터 급변', severity: 'P2', page: 'p.44 · p.47', basis: '광고비 · 클릭 동요일 · 동시간 ±50%, 전환 최근 7일 동시간 −50%, CPA +50%, ROAS −35%' },
  anomaly_warn: { typeId: 'data_spike', label: '성과 이상 징후 · 주의', severity: 'P3', page: 'p.47', basis: '주의 기준(광고비 · 클릭 ±30%, 전환 −30%, CPA +30%, ROAS −20%) 도달' },
  keyword_spike: { typeId: 'data_spike', label: '키워드 성과 급변', severity: 'P2', page: 'p.14 · p.44', basis: '성과 급변 ±50% (p.14) · 최근 3일 CPC · 전환 vs 직전 11일 평균 (비교 구간은 운영 가정)' },
  media_delay: { typeId: 'external', label: '매체 장애 · 집계 지연', severity: 'P3', page: 'p.44', basis: '현재 시각 시간별 데이터 미수신 · 다른 매체는 수신 · 최근 7일 같은 시간 수신 이력 있음 (판정 방식은 운영 가정)' },
  search_volume: { typeId: 'external', label: '검색량 급변', severity: 'P3', page: 'p.44', basis: '브랜드 검색량 전일 vs 최근 4주 동요일 평균 ±30% (수치는 운영 가정)' },
  bulk_change: { typeId: 'bulk_change', label: '대량 변경 실수', severity: 'P1', page: 'p.45', basis: '10분 내 동일 요청자 10건 이상(운영 가정) · 입찰 일 조정 폭 상한 20% 초과(p.14) · 30% 초과 예산 변경의 수면밀도 승인 누락(p.15)' },
};

/** 이슈 유형 라벨 (p.44 6유형 + p.45 추가 6종) */
export const TYPE_LABEL: Record<string, string> = {
  ad_off: '광고 OFF · 미노출',
  account_payment: '계정 · 결제',
  creative_landing: '소재 · 랜딩',
  data_spike: '데이터 급변',
  external: '매체 · 외부 환경',
  weekend: '주말 · 공휴일',
  tracking_break: '전환 추적 단절',
  soldout_landing: '품절 · 옵션 품절 랜딩',
  price_mismatch: '가격 · 프로모션 불일치',
  brand_intrusion: '브랜드 키워드 침투',
  invalid_traffic: '무효 트래픽 급증',
  bulk_change: '대량 변경 실수',
};

/** 이슈 유형별 알림 방식 (p.44 표 · p.45는 등급 기준으로 같은 채널 적용) */
export const NOTIFY_BY_TYPE: Record<string, { channel: '메신저' | '메일'; to: string }> = {
  ad_off: { channel: '메신저', to: 'AE + 백업 + PM' },
  account_payment: { channel: '메신저', to: 'PM + 브랜드 담당자' },
  creative_landing: { channel: '메신저', to: '담당 AE' },
  data_spike: { channel: '메신저', to: '담당 AE · 원인 후보 포함' },
  external: { channel: '메일', to: '담당 AE · 주간 리포트' },
  tracking_break: { channel: '메신저', to: 'AE + 백업 + PM' },
  soldout_landing: { channel: '메신저', to: '담당 AE' },
  price_mismatch: { channel: '메신저', to: '담당 AE + PM' },
  brand_intrusion: { channel: '메신저', to: '담당 AE' },
  invalid_traffic: { channel: '메신저', to: '담당 AE' },
  bulk_change: { channel: '메신저', to: 'AE + 백업 + PM' },
};

/** 매체 → 담당 TF 역할 (p.52 담당 범위) */
export const MEDIA_OWNER_ROLE: Record<MediaId | SalesChannelId, string> = {
  naver_sa: 'sa_ae',
  naver_gfa: 'da_ae',
  kakao: 'da_ae',
  vertical: 'da_ae',
  coupang: 'da_ae',
  ohouse: 'da_ae',
  brandstore: 'da_ae',
  own_mall: 'global_ae',
  google: 'global_ae',
  meta: 'global_ae',
};

/** 계정 권한 목록의 사용자 표기 ↔ TF 역할 (데모 계정 권한 표기 기준) */
export const ROLE_ACCOUNT_USER: Record<string, string> = {
  pm: 'PM',
  sa_lead: 'SA Lead AE',
  sa_ae: 'SA AE',
  da_ae: 'DA AE',
  global_ae: '글로벌 매체 AE',
};

/** p.48 주말 · 공휴일 당번 순번 대상 (매체 AE 4인) — 순번 방식은 운영 가정 (주말은 토·일 동일 당번) */
export const ON_DUTY_POOL = ['sa_lead', 'sa_ae', 'da_ae', 'global_ae'] as const;

/** p.48 주말 · 공휴일 대응 체계 3단계 */
export const WEEKEND_TIERS = [
  { tier: '1차', who: 'MILDO Alert', what: '24시간 감지 · 1차 진단', when: '상시' },
  { tier: '2차', who: '당번 AE', what: '주말 · 공휴일 순번제', when: '30분 내 확인' },
  { tier: '3차', who: 'PM 에스컬레이션', what: '브랜드 담당자 연락', when: 'P1 한정' },
] as const;
/** p.44 주말 · 공휴일 행: 30분 내 확인 · 다음 영업일 09:30 브리핑 */
export const WEEKEND_ACK_MIN = 30;
export const NEXT_BRIEFING = '09:30';

/**
 * 시간대 소진 곡선 기간 — 최근 28일(오늘 제외) 매체별 시간대 광고비 · 매출 비중.
 * MILDO Board(board/data.ts curveDays) · AD Pilot(hourlyCostCurve 28일)과 같은 기준이라
 * 세 화면의 캠페인 예상 마감 시각이 같게 나온다 (운영 가정 · 온보딩 중 요일별 곡선 검토).
 */
export const PACE_CURVE_DAYS = 28;

/** 탐지 보조 기준 (운영 가정 · 온보딩 중 조정) */
export const DETECT_DEFAULTS = {
  windowHours: 2, // 동시간 비교 구간 (최근 n시간)
  minConvForRatio: 1, // 전환 · CPA · ROAS 판정 최소 기대 전환 (구간 기준선) — 미만이면 '표본 부족 · 참고'
  trackingZeroHours: 3, // p.45 '전환 0 패턴' — 연속 시간
  trackingClickRatio: 0.5, // 클릭 정상 판단: 기준선 대비 50% 이상
  trackingZeroRateMax: 0.1, // 최근 7일 동시간 0 기록 비율 상한
  keywordSpikePct: 50, // p.14 AD Pilot '성과 급변 · 수집 데이터 이상(최근 3일 CPC/전환 ±50%)'
  keywordRecentDays: 3,
  keywordMinConv: 3, // 전환 변화 판정 최소 직전 전환
  budgetLostShare: 0.2, // 예산 소진 예상: 미노출 구간 평소 매출 비중 20% 이상
  brandRank: 2.0,
  brandLost: 0.2,
  invalidClickPct: 80,
  invalidCvrDropPct: 60,
  runwayWarnDays: 3, // 주말 2일 + 1일 버퍼
  staleLoginDays: 30,
  creativePendingHours: 24,
  searchVolumePct: 30,
  bulkBatch: 10,
  bulkWindowMin: 10,
} as const;

/** 소재 검수 상태 (DEMO — 매체 검수 API 연동 전 시연용) */
export interface CreativeReview {
  id: string;
  media: MediaId;
  name: string;
  copy: string;
  landing: string;
  status: 'approved' | 'pending' | 'rejected';
  submittedAt: string; // 데이터 시각 (KST)
  reason?: string;
  landingStatus: number; // 랜딩 크롤러 응답 코드
}
export const DEMO_CREATIVES: CreativeReview[] = [
  { id: 'cr_sa_promo', media: 'naver_sa', name: 'SA 확장소재 · 가을 이사 · 혼수 기획전', copy: '가을 이사 · 혼수 기획전 15% 할인', landing: 'https://brand.naver.com/mildo/products', status: 'approved', submittedAt: '2026-10-19T10:00:00+09:00', landingStatus: 200 },
  { id: 'cr_gfa_review', media: 'naver_gfa', name: 'GFA 쇼핑 고객 확장 · 리뷰 신뢰형', copy: '누적 리뷰로 고른 매트리스', landing: 'https://brand.naver.com/mildo/products', status: 'approved', submittedAt: '2026-10-26T11:20:00+09:00', landingStatus: 200 },
  { id: 'cr_gfa_firm', media: 'naver_gfa', name: 'GFA Prospecting · 경도 비교형', copy: '경도 · 소재 · 구조로 고르는 매트리스', landing: 'https://mildo.kr/guide', status: 'pending', submittedAt: '2026-10-31T13:10:00+09:00', landingStatus: 200 },
  { id: 'cr_meta_ship', media: 'meta', name: 'Meta 넓은 타겟 · 구매 혜택형', copy: '전국 무료배송 · 전문 기사 설치', landing: 'https://mildo.kr/event', status: 'approved', submittedAt: '2026-10-22T09:40:00+09:00', landingStatus: 200 },
  { id: 'cr_kakao_cart', media: 'kakao', name: '카카오 장바구니 리마케팅 · 기획전', copy: '장바구니에 담은 매트리스, 기획전 15%', landing: 'https://brand.naver.com/mildo/products', status: 'approved', submittedAt: '2026-10-20T15:00:00+09:00', landingStatus: 200 },
  { id: 'cr_google_dg', media: 'google', name: 'Google Demand Gen · 비교 영상', copy: '구조 · 리뷰로 비교하는 매트리스', landing: 'https://mildo.kr', status: 'approved', submittedAt: '2026-10-15T14:00:00+09:00', landingStatus: 200 },
  { id: 'cr_ohouse_week', media: 'vertical', name: '오늘의집 집들이 위크', copy: '집들이 위크 12% 할인', landing: 'https://ohou.se/productions/mildo', status: 'approved', submittedAt: '2026-10-26T10:00:00+09:00', landingStatus: 200 },
];

/** 월간 SLA 리포트용 지난 이력 (DEMO · 2026-10-01 ~ 10-30, 실제 운영 이력 아님) */
export interface SlaHistoryRow {
  id: string;
  date: string;
  hour: number;
  severity: Severity;
  typeId: string;
  ruleId: string;
  media: MediaId;
  title: string;
  ackMin: number | null;
  actionMin: number | null;
  reportMin: number | null;
  falsePositive: boolean;
  recurrence: boolean; // 같은 유형 · 대상 30일 내 재발
  mediaDelayMin: number; // 매체 검수 · 집계 지연 (SLA 산정에서 제외, 별도 표기)
  metric?: string; // 이상 징후 지표 (오탐률 산정용)
}
type H = [string, number, Severity, string, string, MediaId, string, number | null, number | null, number | null, boolean, boolean, number, string?];
const HIST: H[] = [
  ['2026-10-02', 21, 'P2', 'data_spike', 'data_spike', 'meta', 'Meta 광고비 급변 +57%', 22, 95, 150, false, false, 0, 'cost'],
  ['2026-10-03', 10, 'P1', 'ad_off', 'budget_exhausted', 'naver_sa', 'SA_브랜드 방어 예산 소진 중지', 9, 24, 95, false, false, 0],
  ['2026-10-05', 14, 'P2', 'creative_landing', 'creative_pending', 'naver_gfa', 'GFA 소재 검수 보류 26시간', 40, 180, 420, false, false, 120],
  ['2026-10-06', 11, 'P3', 'external', 'search_volume', 'naver_sa', '네이버 SA 확장소재 정책 변경 공지', 300, null, 2880, false, false, 0],
  ['2026-10-07', 20, 'P2', 'data_spike', 'data_spike', 'naver_sa', 'SA 클릭 급증 +62% (집계 지연 정상화)', 15, null, null, true, false, 0, 'clicks'],
  ['2026-10-09', 9, 'P1', 'account_payment', 'account_payment', 'naver_gfa', 'GFA 자동충전 실패', 12, 28, 110, false, false, 0],
  ['2026-10-11', 22, 'P2', 'soldout_landing', 'soldout_landing', 'naver_sa', '슈퍼싱글 옵션 품절 랜딩', 25, 70, 110, false, false, 0],
  ['2026-10-12', 13, 'P3', 'external', 'search_volume', 'vertical', '경쟁사 오늘의집 기획전 시작', 600, null, 4320, false, false, 0],
  ['2026-10-13', 16, 'P2', 'data_spike', 'data_spike', 'google', 'Google 광고비 −55% (매체 집계 지연)', 30, null, null, true, false, 0, 'cost'],
  ['2026-10-14', 15, 'P1', 'tracking_break', 'tracking_break', 'google', 'Google 전환 태그 누락 (자사몰 배포 후)', 14, 41, 150, false, false, 0],
  ['2026-10-16', 10, 'P2', 'price_mismatch', 'price_mismatch', 'vertical', '쿠팡 소재 할인가 불일치', 35, 200, 460, false, false, 0],
  ['2026-10-18', 19, 'P2', 'data_spike', 'data_spike', 'kakao', '카카오 전환 −52%', 28, 210, 280, false, false, 0, 'conversions'],
  ['2026-10-19', 12, 'P3', 'data_spike', 'anomaly_warn', 'google', 'Google CPA +34% (주의)', 400, null, null, true, false, 0, 'cpa'],
  ['2026-10-20', 11, 'P2', 'creative_landing', 'landing_error', 'naver_sa', '기획전 URL 404', 18, 52, 240, false, false, 0],
  ['2026-10-21', 15, 'P3', 'external', 'search_volume', 'naver_gfa', 'GFA 신규 지면 베타 공지', 900, null, 5760, false, false, 0],
  ['2026-10-22', 16, 'P1', 'ad_off', 'campaign_off', 'kakao', '카카오 캠페인 중지 (소재 일괄 반려)', 8, 61, 118, false, false, 35],
  ['2026-10-23', 14, 'P3', 'data_spike', 'anomaly_warn', 'meta', 'Meta ROAS −24% (주의)', 1300, null, 6000, false, false, 0, 'roas'],
  ['2026-10-24', 23, 'P2', 'invalid_traffic', 'invalid_traffic', 'meta', 'Meta 특정 지역 클릭 급증', 26, 260, 600, false, false, 0, 'clicks'],
  ['2026-10-26', 9, 'P2', 'data_spike', 'data_spike', 'naver_gfa', 'GFA 노출 급감 −58% (매체 집계 지연)', 20, null, null, true, false, 90, 'cost'],
  ['2026-10-27', 18, 'P1', 'account_payment', 'account_payment', 'naver_gfa', 'GFA 잔액 1일치 미만', 6, 18, 70, false, true, 0],
  ['2026-10-28', 10, 'P3', 'external', 'search_volume', 'naver_sa', '브랜드 검색량 +38% (방송 노출)', 700, null, 7200, false, false, 0],
  ['2026-10-29', 15, 'P2', 'data_spike', 'keyword_spike', 'naver_sa', "'가성비 매트리스' CPC +54%", 42, 150, 480, false, false, 0, 'cpc'],
];
export const SLA_HISTORY: SlaHistoryRow[] = HIST.map((h, i) => ({
  id: `hist_${i + 1}`, date: h[0], hour: h[1], severity: h[2], typeId: h[3], ruleId: h[4], media: h[5], title: h[6],
  ackMin: h[7], actionMin: h[8], reportMin: h[9], falsePositive: h[10], recurrence: h[11], mediaDelayMin: h[12], metric: h[13],
}));

/** p.48 연휴 전날 사전 점검 항목 */
export const PRECHECK_GROUPS = ['예산', '소재', '결제 잔액', '권한 · 당번'] as const;

/** 테스트 이슈 주입 (라이브 데모 07:00–10:00, 제안서 p.60) */
export const TEST_SCENARIOS = [
  { id: 'ad_off', label: '광고 OFF', detail: 'SA_브랜드 방어 캠페인 중지', icon: 'stop' },
  { id: 'payment', label: '결제 실패', detail: '카카오모먼트 자동충전 실패 · 잔액 0.4일치', icon: 'wallet' },
  { id: 'spike', label: '광고비 급변', detail: 'Google 최근 2시간 광고비 +85%', icon: 'trend' },
  { id: 'creative', label: '소재 반려', detail: 'GFA 리뷰 신뢰형 소재 반려', icon: 'x' },
] as const;
export type TestScenarioId = (typeof TEST_SCENARIOS)[number]['id'];
