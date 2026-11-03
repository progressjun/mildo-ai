/**
 * MILDO Board 전용 상수 — 출처(장표 번호) 또는 '모듈 가정'을 주석으로 남긴다.
 * 제안서 수치는 src/data/constants.ts 를 그대로 쓰고, 여기에는 화면 · 판정에 필요한 보조 기준만 둔다.
 */
import type { RangePreset } from '@/core/selectors';
import { AD_PILOT, ANOMALY_THRESHOLDS, DATA_TIMETABLE, KEYWORD_TEST_RULES } from '@/data/constants';

/** p.13 기간 선택 (어제 / 최근 7 · 14 · 30일 / 이번 달) — selectors.rangeOf 프리셋을 그대로 사용 */
export const BOARD_PERIODS: { id: Extract<RangePreset, 'yesterday' | 'last7' | 'last14' | 'last30' | 'mtd'>; label: string }[] = [
  { id: 'yesterday', label: '어제' },
  { id: 'last7', label: '최근 7일' },
  { id: 'last14', label: '최근 14일' },
  { id: 'last30', label: '최근 30일' },
  { id: 'mtd', label: '이번 달' },
];

const threshold = (metric: string) => ANOMALY_THRESHOLDS.find((t) => t.metric === metric)!;

/** 판정 기준 — 각 값 옆 주석이 화면의 '기준' 표기와 같다 */
export const BOARD_RULES = {
  /* 매체 비교 변동 판정: p.47 성과 이상 징후 기준(시간 단위)을 기간 비교에 준용 — 모듈 가정 */
  roasDropWarnPct: threshold('roas').warnPct, // 20
  roasDropDangerPct: threshold('roas').dangerPct, // 35
  cpaRiseWarnPct: threshold('cpa').warnPct, // 30
  cpaRiseDangerPct: threshold('cpa').dangerPct, // 50
  costSwingWarnPct: threshold('cost').warnPct, // 30
  costSwingDangerPct: threshold('cost').dangerPct, // 50

  /* 키워드 판정: p.14 AD Pilot 기준 */
  targetRoas: AD_PILOT.targetRoas, // 400% (온보딩 중 확정)
  brandTargetRoas: AD_PILOT.brandTargetRoas, // 800%
  highEfficiencyRatio: AD_PILOT.highEfficiencyRoasRatio, // 목표 대비 130%
  lostShareTrigger: AD_PILOT.lostShareTrigger, // 노출 기회 손실 25%
  minConversionsForVerdict: AD_PILOT.minConversionsForDown, // 전환 3건 미만 → 표본 부족 표기
  keywordAnomalyPct: AD_PILOT.anomalyHoldPct, // 최근 3일 CPC · 전환 ±50%
  keywordAnomalyDays: 3, // SPEC §4 adpilot "최근 3일"
  keywordAnomalyMinClicks: 20, // 모듈 가정: 최근 3일 클릭 20회 미만이면 CPC 급변 판정 안 함 (소표본 오탐 방지)
  keywordAnomalyMinExpectedConv: 1, // 모듈 가정: 기준선 기대 전환 1건 미만이면 전환 급변 판정 안 함
  keywordNoConvMinClicks: 20, // 모듈 가정: 클릭 20회 이상 · 전환 0 → '전환 없음' 신호
  keywordMinClicksForTest: KEYWORD_TEST_RULES.minClicks, // p.26 최소 클릭 100 (참고 표기)

  /* 월 예산 페이싱: selectors.monthlyPacing 과 같은 기준 */
  monthOverRatio: 1.05, // 예상 월말 소진 > 105% → 초과 예상
  monthUnderRatio: 0.9, // < 90% → 미달 예상

  /* 캠페인 일 예산: selectors.campaignPacing 과 같은 23시 기준 + 시간대 가중 곡선 */
  exhaustBeforeHour: 23, // 23시 전 마감 예상 → 조기 소진
  peakStartHour: 21, // 모듈 가정: 매트리스 저녁 피크 21~23시 (시간대 × 요일 히트맵으로 확인)
  curveDays: 28, // 시간대 가중 곡선: 최근 4주(오늘 제외)

  /* 수집 검증 (p.12 검증 · 정제) */
  hourlySpikePct: 50, // p.44 데이터 급변: 동요일 · 동시간 대비 ±50%
  hourlySpikeHours: 2, // 모듈 가정: 최근 2시간 합계로 판정 (1시간 노이즈 완화)
  zeroConvStreakHours: 3, // 모듈 가정: 3시간 연속 전환 0
  zeroConvClickFloor: 0.7, // 모듈 가정: 같은 시간 클릭이 기준선의 70% 이상이면 '클릭 정상'
  dailyHourlyTolerancePct: 5, // 모듈 가정: 일 합계 ↔ 시간대 합계 차이 ±5% (집계 시차 · 보정)
  reconTolerancePct: 10, // 모듈 가정: 매체 집계 광고 매출 ↔ 판매 채널 광고 경유 추정 ±10%
  heatmapDays: 28, // SPEC §4 "최근 4주"
  trendMinDays: 14, // 일자별 추이 최소 표시 기간 (어제 · 7일 선택 시 14일로 확장)
} as const;

/** p.12 통합 데이터 아키텍처 — 원천 그룹 */
export const SOURCE_GROUPS = [
  { id: 'media', label: '광고 매체', detail: '네이버 SA·DA · 카카오 · 구글 · 메타 (+ 버티컬, p.37)' },
  { id: 'sales', label: '판매 채널', detail: '브랜드스토어 · 오늘의집 · 쿠팡 · 자사몰' },
  { id: 'external', label: '외부 데이터', detail: '지면 아카이브 · AI 검색 · 경쟁사' },
] as const;

/** p.12 통합 데이터 레이어 단계 */
export const LAYER_STEPS = ['API · 파일 연동 수집', '검증 · 정제', '날짜 · 채널 · 키워드 · 상품 키 표준화'] as const;
export const LAYER_OUTPUT = '광고비 대비 채널별 실매출';
/** p.12 원문 주석 */
export const SALES_NOTE = '판매 채널 데이터는 제공 범위와 방식을 온보딩 시 협의해 연동합니다.';

/**
 * 원천별 연동 방식 — 모듈 가정 (온보딩 시 확정). 매체 · 판매 채널 id 는 Dataset 키와 같다.
 */
export const SOURCE_METHOD: Record<string, string> = {
  naver_sa: '검색광고 API (일 · 시간대)',
  naver_gfa: 'GFA 보고서 API',
  google: 'Google Ads API',
  meta: 'Marketing API',
  kakao: '카카오모먼트 보고서 API',
  vertical: '쿠팡 · 오늘의집 광고센터 파일',
  brandstore: '커머스 API · 정산 파일 (협의)',
  ohouse: '파트너 센터 파일 (협의)',
  coupang: 'Wing 파일 (협의)',
  own_mall: '자사몰 DB · GA4 (협의)',
  brand_search: '검색 트렌드 (브랜드 키워드 검색량)',
  archive: 'MILDO Watch 지면 아카이브',
  ai_search: 'SearchTuneOS AI 검색 진단',
};

/** 외부 데이터 원천 — Dataset 포함 여부를 명시 (포함되지 않은 것은 해당 모듈 스냅샷) */
export const EXTERNAL_SOURCES = [
  { id: 'brand_search', name: '브랜드 검색량', inDataset: true, route: 'growth', cadence: '일 단위' },
  { id: 'archive', name: '지면 아카이브 · 경쟁사', inDataset: false, route: 'watch', cadence: '변경 즉시 · 일 단위 (p.25)' },
  { id: 'ai_search', name: 'AI 검색 노출 · 인용', inDataset: false, route: 'geo', cadence: '정기 진단 (p.29)' },
] as const;

/** p.12 표준화 키 */
export const STANDARD_KEYS = [
  { id: 'date', label: '날짜', rule: 'YYYY-MM-DD (KST) · 시간대 0~23시' },
  { id: 'channel', label: '채널', rule: '광고 매체 6 · 판매 채널 4 고정 코드' },
  { id: 'keyword', label: '키워드', rule: '키워드 id + 구매 의도 5분류 (p.35)' },
  { id: 'product', label: '상품', rule: '상품 id : 옵션 id (랜딩 URL 매칭)' },
] as const;

/** p.37 매체별 판단 지표 → 화면에 보여줄 계산 값 */
export const MEDIA_JUDGE_NOTE: Record<string, string> = {
  naver_sa: 'ROAS와 매출 규모를 함께 본다',
  naver_gfa: 'SA 기여는 DA→SA 분석(매출 성장)에서 시차 상관으로 본다',
  google: '증분 매출은 홀드아웃 설계가 필요하며 현재 값은 자사몰 실매출 총액',
  meta: '신규 고객 획득 효율로 본다',
  kakao: '재방문 전환과 CPA로 본다',
  vertical: '판매 채널 내 광고 ROAS로 본다',
};

/** p.18 전일 데이터 수집 · 검증 완료 시각 */
export const DAILY_BATCH_TIME: string = DATA_TIMETABLE[0].time; // '07:00' (모듈 로드 시 기본값 — 계산에는 dailyBatchTime() 사용)
/** 일 배치 기준 시각 — 워크스페이스 설정(timetable.collect)이 DATA_TIMETABLE을 제자리에서 바꾸므로 호출 시점에 읽는다 */
export const dailyBatchTime = (): string => DATA_TIMETABLE[0]?.time ?? DAILY_BATCH_TIME;

/** 키워드 집계 창 (검색광고 보고서는 최근 14일 · 직전 14일 단위로 수집) */
export const KEYWORD_WINDOWS = [
  { id: '7', label: '최근 7일' },
  { id: '14', label: '최근 14일' },
] as const;
