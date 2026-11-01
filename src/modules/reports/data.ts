/**
 * Reports 모듈 전용 상수 — 제안서 장표 번호를 주석으로 남긴다.
 * 수치 · 일정은 src/data/constants.ts(REPORT_CADENCE · DATA_TIMETABLE · SA_AUTOMATION_SCOPE · ONBOARDING_PHASES)를 기준으로 하고,
 * 여기에는 그 표에 없는 메타(리드타임 표기 · 주말 규칙 · 재투입 가안 · 시연 피드백 이력)만 둔다.
 */
import type { MediaId } from '@/core/types';
import { REPORT_CADENCE } from '@/data/constants';

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'issue';
export const REPORT_TYPES: ReportType[] = ['daily', 'weekly', 'monthly', 'issue'];

/** p.18 하단 리포트별 리드타임 (이슈 알림 감지 즉시 · 일간 D+1 08:00 · 주간 월 10:00 · 월간 익월 3영업일) */
const REPORT_LEAD: Record<ReportType, string> = { daily: 'D+1 08:00', weekly: '월 10:00', monthly: '익월 3영업일', issue: '감지 즉시' };
type CadenceRow = (typeof REPORT_CADENCE)[number];
const cadenceOf = (t: ReportType): CadenceRow => REPORT_CADENCE.find((c) => c.id === t) ?? REPORT_CADENCE[0];

/**
 * p.17 리포트 4종 — 이름 · 주기 · 채널 · 내용은 constants.ts REPORT_CADENCE에서 그대로 읽는다 (값을 여기서 다시 쓰지 않음).
 * lead는 p.18 하단 표기.
 */
export const REPORT_META: Record<ReportType, { name: string; when: string; channel: CadenceRow['channel']; content: string; lead: string; page: string }> = Object.fromEntries(
  REPORT_TYPES.map((t) => {
    const c = cadenceOf(t);
    return [t, { name: c.name, when: c.when, channel: c.channel, content: c.content, lead: REPORT_LEAD[t], page: 'p.17' }];
  }),
) as Record<ReportType, { name: string; when: string; channel: CadenceRow['channel']; content: string; lead: string; page: string }>;

/** 월간 리포트 발송일 = 익월 n번째 영업일 (p.17) */
export const MONTHLY_BUSINESS_DAY = 3;
/** 주간 리포트 발송 시각 (월 10:00, p.17) */
export const WEEKLY_SEND = { weekday: 1, minutes: 10 * 60 } as const;
/** 일간 리포트 발송 시각 (매일 08:00, p.17 · p.18) */
export const DAILY_SEND_MIN = 8 * 60;

/**
 * p.18 데이터 제공 시간표 항목별 메타.
 * - lead: 데이터 기준 시점 → 제공 시점. p.18 하단 표기(D+1 08:00 등)가 있는 항목은 그대로, 나머지는 운영 가정.
 * - owner: 실행 주체. 'system'은 주말 · 공휴일에도 자동 실행, 'ae'는 업무시간 작업.
 * - offDay: 주말 · 공휴일 처리. 이슈 브리핑은 p.44 '다음 영업일 09:30 브리핑' 규칙, 점검은 p.48 '1차 MILDO Alert 상시 → 2차 당번 AE 30분 내 확인'.
 */
export const TIMETABLE_META: Record<string, { scope: string; lead: string; owner: 'system' | 'ae'; offDay: 'run' | 'move_next_business' | 'alert_duty' | 'merge_next'; offNote: string; route: string; page: string }> = {
  '07:00': { scope: '전일 00–24시 매체 · 판매 채널', lead: '전일 마감 → 7시간', owner: 'system', offDay: 'run', offNote: '자동 수집 · 검증은 매일 실행', route: 'board', page: 'p.18 · p.12' },
  '08:00': { scope: '전일 성과 · 월 누적 소진', lead: 'D+1 08:00 (p.18)', owner: 'system', offDay: 'run', offNote: '자동 발송 · 확인은 당번 AE', route: 'reports', page: 'p.18 · p.17' },
  '09:30': { scope: '전일 17:00 → 당일 09:00 (야간 · 주말 포함)', lead: '야간 감지분 → 당일 09:30', owner: 'ae', offDay: 'move_next_business', offNote: '주말 · 공휴일 → 다음 영업일 09:30 브리핑 (p.44)', route: 'alert', page: 'p.18 · p.44' },
  '11:00': { scope: '당일 00–10시 · 동요일 · 동시간 대비', lead: '시간 단위 (매체 집계 지연 1시간 가정)', owner: 'ae', offDay: 'alert_duty', offNote: 'MILDO Alert 상시 감지 + 당번 AE 30분 내 확인 (p.48)', route: 'alert', page: 'p.18 · p.47' },
  '14:00': { scope: '당일 00–13시 캠페인별 일 예산 소진', lead: '시간 단위 → 예상 마감 시각', owner: 'ae', offDay: 'alert_duty', offNote: '예산 소진 예상은 Alert 자동 알림 + 당번 AE 확인 (p.48)', route: 'board', page: 'p.18 · p.14' },
  '16:30': { scope: 'AD Pilot 조정 후보 · 승인 요청', lead: '익일 00시 반영 전 7.5시간 (운영 가정)', owner: 'ae', offDay: 'merge_next', offNote: '주말 · 공휴일 조정안은 다음 영업일 16:30 조정안에 병합 · 그 사이 자동 조정은 사전 승인 범위 안에서만 (운영 가정)', route: 'adpilot', page: 'p.18 · p.14' },
  '17:00': { scope: '당일 00–16시 소진 · 성과 · 미결 이슈', lead: '당일 16시 데이터 → 17:00 (운영 가정)', owner: 'system', offDay: 'run', offNote: '자동 발송 · 미결 이슈는 당번 AE 인계', route: 'reports', page: 'p.18' },
};

/**
 * 시간대 소진 곡선 기간 — 최근 28일(오늘 제외) 같은 매체의 시간대별 광고비 비중.
 * MILDO Board 예산 소진 현황 · AD Pilot 조기 소진 판정 · MILDO Alert 예산 소진 예측과 같은 기간 · 같은 산식이라
 * 리포트 · 시간표의 예상 마감 시각이 세 화면과 일치한다 (p.14 · p.44).
 */
export const PACE_CURVE_DAYS = 28;

/*
 * 영업일 · 공휴일은 모듈 로컬 표를 두지 않고 공용 src/core/util.ts KR_HOLIDAYS · isOffDay를 그대로 쓴다
 * (월간 발송일 '익월 3영업일' · 다음 달 영업일 수 · 주간 발송일 · 이슈 브리핑 이동일이 MILDO Alert 당번 체계와 같은 달력을 쓰도록).
 */

/** 월간 미팅 시각 (운영 가정 — p.17은 '익월 3영업일'만 명시) */
export const MONTHLY_SEND_MIN = 10 * 60;

/**
 * 키워드 테스트 판정 보조 기준 — MILDO Lab 판정(p.26)과 같은 값. 주간 리포트는 Lab 엔진(buildPipeline) 결과를 우선 쓰고,
 * Lab 엔진을 쓸 수 없을 때만 이 값으로 같은 규칙을 재계산한다.
 * minJudgeClicks: 기간(14일)이 지나도 클릭이 이 값 미만이면 판정 보류 · 표본 부족 (MILDO Lab 모듈 가정과 동일)
 */
export const TEST_JUDGE_MIN_CLICKS = 30;

/** 수면밀도 업무시간 (p.18 '수면밀도 업무시간 08–17') */
export const BUSINESS_HOURS = { from: 8 * 60, to: 17 * 60 } as const;
/** 시간표 축 범위 (분) */
export const TIMELINE_RANGE = { from: 6 * 60 + 30, to: 17 * 60 + 30 } as const;

/** p.11 · p.19 도입 브랜드 실적 (반복 업무 리소스 최소 40% 감소) — 목표의 하한 */
export const SAVINGS_FLOOR_PCT = 40;
/** p.19 '온보딩 30일 내 실측으로 확정' */
export const SAVINGS_CONFIRM_DAYS = 30;
/** 인력 환산 가정: 주 40시간 = 2,400분 (근로기준법 법정 근로시간 기준 · 가정) */
export const WEEK_MINUTES_PER_FTE = 2400;
export const WEEKS_PER_YEAR = 52;

/** p.19 업무 → MILDO OS 담당 모듈 (자동화 수단) */
export const TASK_MODULE: Record<string, { route: string; label: string }> = {
  '일간 성과 조회·취합': { route: 'board', label: 'MILDO Board · 일간 리포트' },
  '주간 보고서 작성': { route: 'reports', label: '주간 리포트 + AE 코멘트' },
  '입찰·예산 조정': { route: 'adpilot', label: 'AD Pilot · GFA Control' },
  '신규 키워드 발굴·등록': { route: 'lab', label: 'MILDO Lab · 검색어 후보' },
  '소재·URL·상태 점검': { route: 'alert', label: 'MILDO Alert 자동 점검' },
};

/**
 * 절감 시간 재투입 계획 — p.11 '키워드 확장 · 테스트 · 분석', p.19 '키워드 확장과 전환 개선 실험에 재투입'.
 * 배분 비율은 가안 (온보딩 중 수면밀도와 확정).
 */
export const REINVEST_DEFAULT = [
  { id: 'keyword', label: '키워드 확장', detail: '롱테일 · 구문형 후보 검토 · 테스트 그룹 등록 (p.26, p.36)', share: 40, route: 'lab' },
  { id: 'test', label: '테스트 · 전환 개선 실험', detail: '소재 · 랜딩 A/B, 브랜드스토어 · 자사몰 전환 개선 (p.27, p.41)', share: 35, route: 'lab' },
  { id: 'analysis', label: '분석', detail: 'DA→SA 기여 · 한계 효율 재배분 · 인사이트 브리프 (p.37, p.40)', share: 25, route: 'growth' },
] as const;

/** p.20 / p.54 온보딩 시작 가정 (최종 선정 26.11.24 주차 → 12/1 시작 가정, 협의로 확정) */
export const KICKOFF_ASSUMED = '2026-12-01';

/** 판단 지표 보조 — 매체별 ROAS 단독 판정 대상 여부 (p.37 판단 지표 기준) */
export const ROAS_JUDGED: Record<MediaId, boolean> = {
  naver_sa: true, naver_gfa: false, google: false, meta: false, kakao: false, vertical: true,
};

/**
 * 시연용 피드백 반영 이력 (TEST DATA) — p.31 '자동 리포트 + AE 코멘트 · 코멘트 단위 피드백'이 반복되는 모습.
 * 실제 운영에서는 state.comments 기록이 이 표를 대체한다.
 */
export const FEEDBACK_HISTORY = [
  { date: '2026-10-06', report: '월간 (9월)', section: '채널별 매출 기여', from: '수면밀도', text: '자사몰은 객단가 추이를 같이 보여 주세요.', reply: '채널 표에 객단가 · 광고 경유 비중 열 추가', doneDate: '2026-10-07' },
  { date: '2026-10-19', report: '주간 (10/12–10/18)', section: '키워드 테스트 결과', from: '수면밀도', text: '신혼 관련 키워드는 11월 기획전 랜딩과 묶어서 판단해 주세요.', reply: '생활 상황 캠페인 랜딩을 기획전으로 분리 후 재테스트 등록', doneDate: '2026-10-20' },
  { date: '2026-10-26', report: '주간 (10/19–10/25)', section: '개선 제안', from: '수면밀도', text: '입찰 상향 후보는 예상 비용 증가분을 같이 적어 주세요.', reply: '후보별 일 조정 폭 상한 · 예상 비용 변화 병기', doneDate: '2026-10-26' },
  { date: '2026-10-30', report: '일간 (10/29)', section: '매체별 성과', from: '수면밀도', text: 'GFA는 ROAS 말고 신규 CPA 기준으로 판단해 주세요.', reply: '매체별 판단 지표(p.37) 열 추가 · ROAS 단독 판정 제외', doneDate: '2026-10-30' },
] as const;

/** p.11 도입 브랜드 리소스 절감 실적 (브랜드명 블라인드 · 브랜드별 실측 보고서는 Q&A 근거자료) — 절감 목표의 하한 근거 */
export const REFERENCE_BRANDS = [
  { id: 'A', name: 'A 뷰티 브랜드', category: '뷰티 · 고빈도 구매 카테고리', result: '반복 업무 리소스 40%+ 감소' },
  { id: 'C', name: 'C 안마기기 브랜드', category: '고관여 내구재', result: '반복 업무 리소스 40%+ 감소' },
  { id: 'H', name: 'H 침구 브랜드', category: '수면밀도와 동일 카테고리', result: '반복 업무 리소스 40%+ 감소' },
] as const;

/** p.20 자동화 적용 일정 · 90일 — 장표 부제 */
export const ROLLOUT_SUB = '기존 성과를 지키며 인수하고, MILDO OS를 단계별로 가동해 90일 안에 자동화 운영을 정착시킵니다.';

/** p.22 MILDO OS 단계별 가동 (D+30 Board → D+60 Watch · Alert → D+90 Lab · Flow) */
export const MODULE_ROLLOUT: Record<'d30' | 'd60' | 'd90', { label: string; route: string }[]> = {
  d30: [{ label: 'MILDO Board', route: 'board' }],
  d60: [{ label: 'MILDO Watch', route: 'watch' }, { label: 'MILDO Alert', route: 'alert' }],
  d90: [{ label: 'MILDO Lab', route: 'lab' }, { label: 'MILDO Flow', route: 'flow' }],
};

/**
 * p.19 업무별 자동화 적용 단계 — p.20 단계 항목에 맞춘 배치 (운영 가정 · 온보딩 중 확정).
 *  - D+30 인수 · 보존: 기존 입찰 로직 문서화 · 유지 → 자동화 적용 없음 (성과 기준선 확정 · 기존 소요 실측)
 *  - D+60 구축 · 병행: Board v1 · 데이터 연동(일간 취합 · 주간 보고), Watch · Alert 가동(소재·URL·상태 점검), 키워드 발굴·테스트 시작
 *  - D+90 정착 · 고도화: AD Pilot 자동 조정(입찰·예산 조정)
 */
export const TASK_PHASE: Record<string, 'd60' | 'd90'> = {
  '일간 성과 조회·취합': 'd60',
  '주간 보고서 작성': 'd60',
  '소재·URL·상태 점검': 'd60',
  '신규 키워드 발굴·등록': 'd60',
  '입찰·예산 조정': 'd90',
};
