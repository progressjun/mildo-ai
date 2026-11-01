/**
 * MILDO Flow 전용 상수 · 시연용 시드.
 * 출처: 제안서(v3) p.31 반복 구간 축소 · p.53 커뮤니케이션 · 의사결정 체계 · p.15 GFA Control 위임 범위 · p.14 AD Pilot SAFETY · p.45 추가 탐지.
 * 제안서에 수치가 없는 운영 기본값은 '운영 기본값 · 온보딩 중 확정'으로 표기한다.
 */
import type { ApprovalLevel, ChangeKind, ChangeRequest, MediaId, SalesChannelId } from '@/core/types';

/* ---------------------------------------------------------------- */
/* 상태 · 모듈 라벨                                                    */
/* ---------------------------------------------------------------- */

export type FlowStatus = ChangeRequest['status'];

/** 보드 컬럼 순서 (스펙: 승인 대기 / 승인 / 반영 / 반려 / 롤백 / 보류) */
export const STATUS_ORDER: FlowStatus[] = ['pending', 'approved', 'applied', 'rejected', 'rolled_back', 'held'];

export const STATUS_META: Record<FlowStatus, { label: string; short: string; tone: 'warning' | 'accent' | 'good' | 'neutral' | 'serious' | 'critical'; icon: string; desc: string }> = {
  pending: { label: '승인 대기', short: '대기', tone: 'warning', icon: 'clock', desc: '승인 주체의 결정 전' },
  approved: { label: '승인', short: '승인', tone: 'accent', icon: 'check', desc: '승인 완료 · 반영 대기' },
  applied: { label: '반영', short: '반영', tone: 'good', icon: 'check', desc: '매체 반영 완료 · 롤백 가능' },
  rejected: { label: '반려', short: '반려', tone: 'neutral', icon: 'x', desc: '반려 · 실행 취소 (종료)' },
  rolled_back: { label: '롤백', short: '롤백', tone: 'serious', icon: 'rollback', desc: '직전 상태로 복원 (종료)' },
  held: { label: '보류', short: '보류', tone: 'critical', icon: 'pause', desc: '실행 점검 · 결정 보류' },
};

export const MODULE_LABEL: Record<string, string> = {
  adpilot: 'AD Pilot', gfa: 'GFA Control', lab: 'MILDO Lab', alert: 'MILDO Alert', flow: 'MILDO Flow', watch: 'MILDO Watch',
  reports: '리포트', growth: '매출 성장', home: '커맨드 센터', agent: 'MILDO Agent', geo: 'SearchTuneOS', ops: '전담 TF', board: 'MILDO Board',
};
/** 모듈 → 화면 라우트 (GFA Control은 AD Pilot 화면 안에 있음) */
export const MODULE_ROUTE: Record<string, string> = { gfa: 'adpilot' };

export const KIND_LABEL: Record<ChangeKind, string> = {
  bid: '입찰', budget: '예산', status: 'ON/OFF', keyword_add: '키워드 추가', keyword_exclude: '키워드 제외',
  gfa: 'GFA 신규', setting: '세팅', alert_rule: '알림 기준', test: '테스트',
};

/* ---------------------------------------------------------------- */
/* 결정 유형별 소요 (p.53) → 판정용 시한                                */
/* ---------------------------------------------------------------- */

export const LEAD_RULES: Record<string, { minutes?: number; endHour?: number; label: string; note: string }> = {
  '즉시': { minutes: 60, label: '즉시 · 60분 내', note: '운영 기본값 · 온보딩 중 확정' },
  '당일': { endHour: 17, label: '당일 · 17:00 전', note: '수면밀도 업무시간 08–17 (p.18) · 주말 · 공휴일 · 17시 이후 요청은 다음 영업일' },
  '주간': { minutes: 7 * 1440, label: '주간 · 7일 내', note: '주간 미팅 주기 (p.53)' },
  '월간 리뷰': { minutes: 30 * 1440, label: '월간 리뷰 · 30일 내', note: '월간 리뷰 주기 (p.53)' },
};

/** p.53 커뮤니케이션 채널 */
export const COMM_CHANNELS = [
  { name: '전용 메신저 채널', use: '승인 요청 · 이슈 알림 · 일간 리포트', cadence: '상시' },
  { name: '주간 미팅', use: '키워드 테스트 결과 · 알림 기준 · 개선 제안', cadence: '주 1회' },
  { name: '월간 리뷰', use: '채널별 매출 기여 · 전략 방향 · 다음 달 계획', cadence: '월 1회' },
] as const;

/* ---------------------------------------------------------------- */
/* 신규 요청 유형 → 승인 주체 라우팅                                     */
/* ---------------------------------------------------------------- */

export type RequestType = 'budget' | 'bid' | 'onoff' | 'new_campaign' | 'creative' | 'keyword' | 'alert_rule' | 'strategy';

export const REQUEST_TYPES: {
  id: RequestType; label: string; kind: ChangeKind; needsPct: boolean; fixed?: ApprovalLevel; basis: string; page: string;
}[] = [
  { id: 'budget', label: '일 예산 변경', kind: 'budget', needsPct: true, basis: '변경 폭 기준 위임 범위: ±10% 이내 담당 AE · ±10~30% PM · 30% 초과 수면밀도 승인', page: 'p.15' },
  { id: 'bid', label: 'SA 키워드 입찰가 변경', kind: 'bid', needsPct: true, basis: '변경 폭 기준 위임 범위 + 일 조정 폭 상한 20% (SAFETY)', page: 'p.14' },
  { id: 'onoff', label: '캠페인 · 키워드 ON/OFF', kind: 'status', needsPct: false, fixed: 'PM', basis: '광고그룹 ON/OFF → PM', page: 'p.15' },
  { id: 'new_campaign', label: '신규 캠페인 · 구조 변경', kind: 'setting', needsPct: false, fixed: 'CLIENT', basis: '신규 캠페인 → 수면밀도 승인 · 예산 · 구조 변경은 PM 제안 → 수면밀도 승인', page: 'p.15 · p.53' },
  { id: 'creative', label: '소재 · 랜딩 교체', kind: 'setting', needsPct: false, fixed: 'AE', basis: '승인 범위 내 운영 조정 → 담당 AE (검수 규칙 통과 전제)', page: 'p.53' },
  { id: 'keyword', label: '키워드 추가 · 제외', kind: 'keyword_add', needsPct: false, fixed: 'AE', basis: '승인 범위 내 운영 조정 — 테스트 전용 그룹 · 입찰 상한 내 등록', page: 'p.26 · p.53' },
  { id: 'alert_rule', label: '알림 · 탐지 기준', kind: 'alert_rule', needsPct: false, fixed: 'PM', basis: '알림 · 시스템 기준 → 개발자 + PM', page: 'p.53' },
  { id: 'strategy', label: '전략 방향 · 월 예산 재배분', kind: 'setting', needsPct: false, fixed: 'CLIENT', basis: '전략 방향 → 수면밀도 (월간 리뷰)', page: 'p.53' },
];

/** 일괄 처리 한 번에 허용하는 최대 건수 (운영 기본값 · 대량 변경 실수 방지 p.45) */
export const FLOW_BULK_LIMIT = 8;
/** 계정 잔액 확보 목표 (MILDO Alert 계정 점검 기준과 같은 3일치) */
export const RUNWAY_TARGET_DAYS = 3;
/** 프로모션 리포트에서 효율 · 잠식 판단을 쓰는 최소 변화폭 (±%, 운영 기본값) — 미만이면 '판단 근거 부족' */
export const MATERIAL_PCT = 3;
/** 오픈 전 기획전 기간 예산 기본 증액률 (운영 기본값 · 참고 기획전 증감이 5% 미만일 때) */
export const DEFAULT_PROMO_UPLIFT_PCT = 10;
/** 소재 가격 · 판매가 대조 허용 오차 (%) — 원 단위 반올림 차이만 허용 */
export const PRICE_TOLERANCE_PCT = 1;

/* ---------------------------------------------------------------- */
/* 프로모션 점검 범위 (판매 채널 ↔ 유입 매체 · 계정)                      */
/* ---------------------------------------------------------------- */

/** 판매 채널별 유입 매체 · 계정 · 랜딩 도메인 (p.37 매체 역할 기준 데모 가정) */
export const PROMO_CHANNEL_SCOPE: Record<SalesChannelId, { media: MediaId[]; campaignMatch?: string; accounts: string[]; domain: string; note: string }> = {
  brandstore: { media: ['naver_sa', 'naver_gfa', 'kakao'], accounts: ['naver_sa', 'naver_gfa', 'kakao'], domain: 'brand.naver.com', note: '네이버 SA · GFA · 카카오 리마케팅이 브랜드스토어로 유입' },
  ohouse: { media: ['vertical'], campaignMatch: '오늘의집', accounts: ['ohouse'], domain: 'ohou.se', note: '오늘의집 상품광고 · 오늘의집 광고 계정' },
  coupang: { media: ['vertical'], campaignMatch: '쿠팡', accounts: ['coupang'], domain: 'coupang.com', note: '쿠팡 상품광고 · 쿠팡 광고센터' },
  own_mall: { media: ['google', 'meta'], accounts: ['google', 'meta'], domain: 'mildo.kr', note: 'Google · Meta 신규 수요가 자사몰로 유입' },
};

export const CHECK_GROUPS = ['일정', '가격', '소재', '랜딩', '예산', '재고', '결제 잔액'] as const;
export type CheckGroup = (typeof CHECK_GROUPS)[number];

/** 프로모션 등록 소재 (DEMO — 시연용 소재 문구, 실제 집행 소재 아님) */
export interface PromoCreative {
  id: string;
  promoId: string;
  media: MediaId;
  name: string;
  copy: string;
  landing: string;
  status: 'approved' | 'pending' | 'rejected' | 'draft';
}
export const PROMO_CREATIVES: PromoCreative[] = [
  { id: 'pc_1a', promoId: 'promo_1', media: 'naver_sa', name: 'SA 확장소재 · 기획전', copy: '가을 이사 · 혼수 기획전 15% 할인', landing: 'https://brand.naver.com/mildo/products', status: 'approved' },
  { id: 'pc_1b', promoId: 'promo_1', media: 'naver_gfa', name: 'GFA 쇼핑 고객 확장 · 가격형', copy: '혼수 매트리스 퀸 841,500원 · 기획전 15%', landing: 'https://brand.naver.com/mildo/products', status: 'approved' },
  { id: 'pc_1c', promoId: 'promo_1', media: 'kakao', name: '카카오 장바구니 리마케팅 · 기획전', copy: '장바구니에 담은 매트리스, 기획전 15%', landing: 'https://brand.naver.com/mildo/products', status: 'approved' },
  { id: 'pc_2a', promoId: 'promo_2', media: 'vertical', name: '오늘의집 집들이 위크', copy: '집들이 위크 12% 할인', landing: 'https://ohou.se/productions/mildo', status: 'approved' },
  { id: 'pc_2b', promoId: 'promo_2', media: 'vertical', name: '오늘의집 상품광고 · 가격형', copy: '집들이 위크 퀸 871,200원', landing: 'https://ohou.se/productions/mildo', status: 'approved' },
  { id: 'pc_3a', promoId: 'promo_3', media: 'naver_sa', name: 'SA 확장소재 · 연말 기획전 (초안)', copy: '연말 수면 환경 기획전 최대 20% 할인', landing: 'https://brand.naver.com/mildo/products', status: 'draft' },
  { id: 'pc_3b', promoId: 'promo_3', media: 'naver_gfa', name: 'GFA · 킹 사이즈 가격형 (초안)', copy: '킹 사이즈 975,800원 · 연말 기획전 18%', landing: 'https://brand.naver.com/mildo/products', status: 'draft' },
  { id: 'pc_3c', promoId: 'promo_3', media: 'naver_gfa', name: 'GFA · 선택 가이드형 (초안)', copy: '경도 · 소재 · 구조로 고르는 연말 매트리스', landing: 'https://mildo.kr/guide', status: 'draft' },
];

/** 시연용 이력 id 접두사 (TEST DATA 표기 · 다른 모듈 계산에 영향 없음) */
export const SEED_PREFIX = 'seed_flow_';
