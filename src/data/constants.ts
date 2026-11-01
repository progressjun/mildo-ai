/**
 * 출처가 확정된 상수.
 * RFP_*      : 수면밀도 2027 디지털 퍼포먼스 마케팅대행사 선정 RFP (2026.10)
 * PROPOSAL_* : 프로그레스미디어 「수면밀도 2027 퍼포먼스 마케팅 제안」(2026.11, v3) — 장표 번호 표기
 * 수치를 바꿀 때는 출처 장표와 함께 바꾼다.
 */
import type { IntentId, MediaId, MediaMeta, SalesChannelId, SalesChannelMeta, Severity } from '@/core/types';

/* ============================== RFP 확정 정보 ============================== */

export const RFP = {
  brand: '수면밀도',
  company: '㈜밀도',
  brandStory: '22년 허리 디스크 환자가 만든 매트리스 브랜드, 네이버/오늘의집 가구 부문 판매 1위',
  channels: {
    homepage: 'https://mildo.kr',
    brandstore: 'https://brand.naver.com/mildo',
    instagram: 'https://www.instagram.com/sleepmildo_official/',
  },
  salesChannels: ['네이버 공식몰', '오늘의집', '쿠팡', '자사몰'],
  kpi: '매출 증대 및 브랜드 운영 리소스 절감 (SA 키워드 중심 데이터 자동화 · 선제 모니터링 · 운영 안정성)',
  annualBudget: 5_000_000_000, // 약 50억
  media: ['네이버(SA/DA)', '카카오', '구글', '메타', '쿠팡 · 오늘의집 외 버티컬'],
  contractMonths: 12,
  /** 네이버 결제수 기준 상위 세그먼트 */
  segments: [
    { id: 'f41_50', label: '여성 41~50세', share: 0.2 },
    { id: 'f31_40', label: '여성 31~40세', share: 0.16 },
    { id: 'm31_35', label: '남성 31~35세', share: 0.077 },
    { id: 'm41_45', label: '남성 41~45세', share: 0.074 },
  ],
  competitors: ['베스트슬립', '웰퍼니처', '퀵슬립', '올라인매트리스', '지누스', '휴도'],
  schedule: [
    { step: 'RFP 전달', date: '26.10.27~28' },
    { step: '제안서 질의응답', date: '26.10.28~11.06' },
    { step: '제안서 제출 마감', date: '26.11.16 (월) 17시' },
    { step: '경쟁 PT 참여 업체 선정', date: '26.11.17 (화) 14시' },
    { step: '경쟁 PT (발표 40 · 라이브 데모 15 · Q&A 25분)', date: '26.11.19~20' },
    { step: '최종 선정 및 계약', date: '26.11.24 주차' },
    { step: 'Kick-off OT', date: '협의' },
  ],
  /** 대행사 선정 기준 (비중) */
  evaluation: [
    { id: 'automation', label: '리소스 절감 자동화', detail: '자동화 · 대시보드 · 데이터 시간표', weight: 25 },
    { id: 'stability', label: '운영 안정성', detail: '이슈 탐지 · 결제·계정 점검', weight: 20 },
    { id: 'strategy', label: '퍼포먼스 전략 · 선제 제안', detail: '광고 모니터링 · 테스트 전략, 매출 성장 고도화', weight: 20 },
    { id: 'people', label: '인력 · 백업 · 온보딩', detail: '전담자 · 백업 체계 · 온보딩 플랜', weight: 15 },
    { id: 'cost', label: '비용 · 계약 조건', detail: '수수료·페이백 · 기간 · 해지 조건', weight: 10 },
    { id: 'reference', label: '업종 레퍼런스 · GEO·AI', detail: '매트리스·침구 사례 · AI 검색', weight: 10 },
  ],
  /** 판단 항목 (리소스 절감 & 데이터 자동화) */
  judgeCriteria: ['안정성', '속도', '유연성', '선제성', '전문성'],
} as const;

/* ============================ 제안서(v3) 기준 ============================ */

/** p.37 매체별 역할 · 세팅 · 예산 (연 50억 가정, VAT·수수료 별도) */
export const MEDIA: Record<MediaId, MediaMeta> = {
  naver_sa: {
    id: 'naver_sa', name: '네이버 SA', short: 'SA', role: '수요 회수',
    setting: '구매 의도별 5개 캠페인 · AD Pilot 입찰', judgeMetric: 'ROAS · 매출',
    share: 0.43, annualBudget: 2_150_000_000, colorVar: '--series-1',
  },
  naver_gfa: {
    id: 'naver_gfa', name: '네이버 GFA', short: 'GFA', role: '수요 환기',
    setting: 'Prospecting · 쇼핑 고객 확장 · 리타겟팅 분리', judgeMetric: '신규 CPA · SA 기여',
    share: 0.18, annualBudget: 900_000_000, colorVar: '--series-2',
  },
  google: {
    id: 'google', name: 'Google', short: 'Google', role: '신규 수요',
    setting: '검색 + Demand Gen', judgeMetric: '자사몰 증분 매출',
    share: 0.12, annualBudget: 600_000_000, colorVar: '--series-3',
  },
  meta: {
    id: 'meta', name: 'Meta', short: 'Meta', role: '신규 고객',
    setting: '넓은 타겟 · 리타겟팅 · Advantage+ 검토', judgeMetric: 'CPA · 신규 비중',
    share: 0.12, annualBudget: 600_000_000, colorVar: '--series-4',
  },
  kakao: {
    id: 'kakao', name: '카카오', short: '카카오', role: '재방문',
    setting: '방문 · 장바구니 · 프로모션 리마케팅', judgeMetric: '전환 · CPA',
    share: 0.08, annualBudget: 400_000_000, colorVar: '--series-5',
  },
  vertical: {
    id: 'vertical', name: '버티컬 · 신규', short: '버티컬', role: '판매 채널 · 테스트',
    setting: '쿠팡 · 오늘의집 광고 + 신규 매체 파일럿', judgeMetric: '채널 ROAS',
    share: 0.07, annualBudget: 350_000_000, colorVar: '--series-6',
  },
};
export const MEDIA_IDS: MediaId[] = ['naver_sa', 'naver_gfa', 'google', 'meta', 'kakao', 'vertical'];

export const SALES_CHANNELS: Record<SalesChannelId, SalesChannelMeta> = {
  brandstore: { id: 'brandstore', name: '네이버 브랜드스토어', colorVar: '--series-1' },
  ohouse: { id: 'ohouse', name: '오늘의집', colorVar: '--series-2' },
  coupang: { id: 'coupang', name: '쿠팡', colorVar: '--series-3' },
  own_mall: { id: 'own_mall', name: '자사몰', colorVar: '--series-7' },
};
export const SALES_CHANNEL_IDS: SalesChannelId[] = ['brandstore', 'ohouse', 'coupang', 'own_mall'];

/** p.35 네이버 SA 캠페인 · 메시지 구조 */
export const SA_CAMPAIGNS: Record<IntentId, {
  id: IntentId; name: string; keywords: string[]; message: string; landing: string; metric: string;
}> = {
  brand: { id: 'brand', name: '브랜드 방어', keywords: ['수면밀도', '밀도 매트리스'], message: '수면밀도 공식 브랜드스토어', landing: '브랜드스토어 메인', metric: '점유 · 전환' },
  generic: { id: 'generic', name: '일반 제품', keywords: ['매트리스', '퀸 매트리스', '매트리스 가격'], message: '수면밀도 매트리스, 경도 · 사이즈 비교부터', landing: '상품 상세', metric: 'CTR · ROAS' },
  problem: { id: 'problem', name: '문제 해결', keywords: ['허리 편안한 매트리스', '매트리스 경도'], message: '내게 맞는 매트리스 선택 기준 확인하기', landing: '선택 가이드', metric: '체류 · 전환율' },
  compare: { id: 'compare', name: '비교 · 검토', keywords: ['매트리스 추천', '매트리스 비교'], message: '구조 · 리뷰로 비교하는 매트리스', landing: '리뷰 · 비교', metric: '전환율 · CPA' },
  life: { id: 'life', name: '생활 상황', keywords: ['신혼 매트리스', '이사 매트리스'], message: '신혼집 매트리스, 사이즈부터 비교하세요', landing: '기획전 · 자사몰', metric: '신규 키워드 전환' },
};
export const INTENT_IDS: IntentId[] = ['brand', 'generic', 'problem', 'compare', 'life'];

/** p.34 구매 의도별 타겟 그룹 */
export const TARGET_GROUPS = [
  { id: 'A', name: '핵심 구매층', desc: '여성 31~50세 구매 특성 기준 · 유사 수요 검증', basis: 'RFP 데이터' },
  { id: 'B', name: '고관여 비교층', desc: '구조 · 소재 · 내구성을 비교하는 고객 · 제품 신뢰 · 경도 · 후기', basis: 'RFP 데이터' },
  { id: 'C', name: '편안함 탐색층', desc: '허리 편안함 · 수면 환경 검색 의도 · 내게 맞는 매트리스 가이드', basis: '테스트 가설' },
  { id: 'D', name: '생활 변화 수요층', desc: '신혼 · 이사 · 첫 독립 · 침실 교체 · 상황별 사이즈 · 제품 선택', basis: '테스트 가설' },
  { id: 'E', name: '구매 직전 고객', desc: '상세 조회 · 장바구니 · 미구매 방문 · 혜택 · 배송 · 구매 결정 지원', basis: '동의 데이터' },
] as const;

/** p.36 제한된 SKU 확장 전략: 제품 1 × 문제 4 × 상황 4 × 비교 3 = 48 */
export const SKU_EXPANSION = {
  problems: ['허리 통증', '꺼짐 · 처짐', '더위 · 통기', '뒤척임 소음'],
  situations: ['신혼', '이사 · 첫 독립', '아이 방', '부모님 선물'],
  criteria: ['경도', '사이즈', '소재 · 구조'],
} as const;

/** p.14 AD Pilot 규칙 · SAFETY */
export const AD_PILOT = {
  dailyChangeCapPct: 20, // 일 조정 폭 상한 (키워드별, 사전 합의 전 기본값)
  minConversionsForDown: 3, // 입찰 하향 전 최소 전환 확보
  targetRoas: 400, // 목표 ROAS(%) — 온보딩 중 확정 (초기값)
  brandTargetRoas: 800,
  lostShareTrigger: 0.25, // 고효율 키워드 노출 기회 손실 25% 이상
  highEfficiencyRoasRatio: 1.3, // 목표 대비 130% 이상 = 고효율
  anomalyHoldPct: 50, // 성과 급변 ±50% → 자동 조정 보류
} as const;

/** p.15 GFA Control v1 위임 범위 (예시, 계약 시 확정) */
export const GFA_DELEGATION = [
  { range: '일 예산 ±10% 이내 · 상태 점검', maxPct: 10, approver: 'AE' as const, label: '담당 AE' },
  { range: '일 예산 ±10~30% · 광고그룹 ON/OFF', maxPct: 30, approver: 'PM' as const, label: 'PM' },
  { range: '30% 초과 · 신규 캠페인', maxPct: Infinity, approver: 'CLIENT' as const, label: '수면밀도 승인' },
];

/** p.18 데이터 제공 시간표 (수면밀도 업무시간 08–17) */
export const DATA_TIMETABLE = [
  { time: '07:00', title: '전일 데이터 수집·검증 완료', detail: '매체 · 판매 채널 API/파일 수집 → 키 표준화 → 검증', channel: '시스템', kind: 'data' },
  { time: '08:00', title: '일간 리포트 발송', detail: '전일 성과 · 예산 소진 · 주요 변동', channel: '메신저', kind: 'report' },
  { time: '09:30', title: '이슈 브리핑', detail: '야간 · 주말 포함 이슈 요약', channel: '메신저', kind: 'brief' },
  { time: '11:00', title: '오전 성과 점검', detail: '동요일·동시간 대비 이상 여부', channel: '대시보드', kind: 'check' },
  { time: '14:00', title: '예산 소진율 점검 · 조정', detail: '일 예산 대비 소진 속도 · 예상 마감 시점', channel: '대시보드', kind: 'check' },
  { time: '16:30', title: '익일 조정안 공유', detail: 'AD Pilot 조정 후보 · 승인 요청', channel: '메신저', kind: 'plan' },
  { time: '17:00', title: '일 마감 요약', detail: '당일 소진 · 성과 · 미결 이슈', channel: '메신저', kind: 'report' },
] as const;

/** p.17 리포트 주기 */
export const REPORT_CADENCE = [
  { id: 'daily', name: '일간', when: '매일 08:00', channel: '메신저', content: '전일 성과 · 예산 소진 · 주요 변동' },
  { id: 'weekly', name: '주간', when: '월 10:00', channel: '메일', content: '키워드 테스트 결과 · 개선 제안' },
  { id: 'monthly', name: '월간', when: '익월 3영업일', channel: '미팅', content: '채널별 매출 기여 · 다음 달 계획' },
  { id: 'issue', name: '이슈 알림', when: '감지 즉시', channel: '메신저', content: '원인 · 영향 범위 · 조치 상태' },
] as const;

/** p.19 SA 업무 자동화 범위 · 절감 목표 (분/주, 기존은 가정) */
export const SA_AUTOMATION_SCOPE = [
  { task: '일간 성과 조회·취합', how: '자동 수집 · 자동 리포트', before: 300, after: 90 },
  { task: '주간 보고서 작성', how: '자동 생성 + AE 코멘트', before: 240, after: 100 },
  { task: '입찰·예산 조정', how: '조정안 자동 · 승인 후 반영', before: 200, after: 110 },
  { task: '신규 키워드 발굴·등록', how: '후보 자동 추출 · 승인 후 등록', before: 180, after: 90 },
  { task: '소재·URL·상태 점검', how: '자동 점검 · 이상 시 알림', before: 150, after: 45 },
] as const;

/** p.20 / p.54 자동화 적용 일정 · 90일 온보딩 */
export const ONBOARDING_PHASES = [
  { id: 'd30', label: 'D+30 인수 · 보존', items: ['계정·권한·결제 구조 인수', '기존 입찰 로직 문서화·유지', '성과 기준선 확정'], metric: '전월 대비 성과 유지' },
  { id: 'd60', label: 'D+60 구축 · 병행', items: ['MILDO Board v1 · 데이터 연동', 'Watch · Alert 가동 · 오탐 정리', '키워드 발굴·테스트 시작'], metric: '리포트·알림 자동화 가동' },
  { id: 'd90', label: 'D+90 정착 · 고도화', items: ['AD Pilot 자동 조정 · Lab · Flow 정착', '운영 루틴 정착 리뷰', '리소스 절감 실측 보고'], metric: '절감 시간 실측 · 성과 개선' },
] as const;

export const ONBOARDING_GANTT = [
  { task: '계정 · 권한 · 결제 인수', start: 1, end: 3 },
  { task: '기존 입찰 로직 문서화 · 보존', start: 1, end: 4 },
  { task: '병행 운영 · 기존 로직 유지', start: 2, end: 8 },
  { task: '데이터 연동 · Pro-board 구축', start: 3, end: 7 },
  { task: '알림 기준 튜닝', start: 5, end: 10 },
  { task: 'AD Pilot 자동 조정 단계 적용', start: 8, end: 12 },
] as const;
export const ONBOARDING_MILESTONES = [
  { week: 4, label: 'D+30 계정 인수 완료' },
  { week: 8, label: 'D+60 일간 루틴 재현' },
  { week: 12, label: 'D+90 전체 루틴 정착' },
] as const;

/** p.44 크리티컬 이슈 탐지 기준 */
export const CRITICAL_ISSUE_TYPES: {
  id: string; type: string; criteria: string; notify: string; action: string; severity: Severity | '전 등급';
}[] = [
  { id: 'ad_off', type: '광고 OFF · 미노출', criteria: '핵심 키워드 노출 0 · 캠페인 중지 · 예산 소진 중지', notify: '메신저 즉시 · AE + 백업 + PM', action: '30분 내 1차 조치 · 2시간 내 결과 보고', severity: 'P1' },
  { id: 'account_payment', type: '계정 · 결제', criteria: '잔액 1일치 미만 · 자동충전 실패 · 권한 변경 · 계정 제재', notify: '메신저 즉시 · PM + 브랜드 담당자', action: '30분 내 1차 조치 · 원인 · 영향 보고', severity: 'P1' },
  { id: 'creative_landing', type: '소재 · 랜딩', criteria: '소재 반려 · 검수 보류 · URL 오류 · 품절 페이지', notify: '메신저 · 담당 AE', action: '1시간 내 수정 · 당일 보고', severity: 'P2' },
  { id: 'data_spike', type: '데이터 급변', criteria: '광고비 · 클릭 · 전환이 동요일 · 동시간 대비 ±50%', notify: '메신저 · 원인 후보 포함', action: '1시간 내 원인 보고 · 자동 조정 보류', severity: 'P2' },
  { id: 'external', type: '매체 · 외부 환경', criteria: '매체 장애 · 정책 변경 · 경쟁사 프로모션 · 검색량 급변', notify: '메일 · 주간 리포트', action: '24시간 내 영향 분석 · 대응안', severity: 'P3' },
  { id: 'weekend', type: '주말 · 공휴일', criteria: '위 기준을 그대로 적용 · 24시간 감지', notify: '당번 AE · P1은 PM 에스컬레이션', action: '30분 내 확인 · 다음 영업일 09:30 브리핑', severity: '전 등급' },
];

/** p.45 추가 탐지 이슈 제안 */
export const EXTRA_DETECTORS = [
  { id: 'tracking_break', title: '전환 추적 단절', why: '픽셀 · 스크립트가 빠지면 자동입찰이 잘못된 데이터로 움직입니다', auto: '전환 0 패턴 감지 → 자동 조정 즉시 보류', severity: 'P1' as Severity },
  { id: 'soldout_landing', title: '품절 · 옵션 품절 랜딩', why: '구매할 수 없는 페이지로 광고비가 새어 나갑니다', auto: '품절 감지 → 해당 그룹 일시 중지 제안', severity: 'P2' as Severity },
  { id: 'price_mismatch', title: '가격 · 프로모션 불일치', why: '광고 문구와 실제 판매가가 다르면 신뢰와 정책 리스크가 생깁니다', auto: '소재 문구 · 판매가 매일 대조', severity: 'P2' as Severity },
  { id: 'brand_intrusion', title: '브랜드 키워드 침투', why: '브랜드 검색 결과에 경쟁사 광고가 노출됩니다', auto: '브랜드 지면 상시 점검 → 방어 입찰 제안', severity: 'P2' as Severity },
  { id: 'invalid_traffic', title: '무효 트래픽 급증', why: '특정 시간 · 지역에서 전환 없는 클릭이 몰립니다', auto: '이상 패턴 감지 → 지역 · IP 제외 · 매체 신고', severity: 'P2' as Severity },
  { id: 'bulk_change', title: '대량 변경 실수', why: '한 번에 많은 입찰 · 예산이 잘못 바뀝니다', auto: '변경 폭 상한 · 승인 라우팅 · 즉시 롤백', severity: 'P1' as Severity },
];

/** p.47 성과 이상 징후 모니터링 기준 (초기값) */
export const ANOMALY_THRESHOLDS = [
  { metric: 'cost', label: '광고비', baseline: '동요일 · 동시간 평균', warnPct: 30, dangerPct: 50, direction: 'both' as const },
  { metric: 'clicks', label: '클릭', baseline: '동요일 · 동시간 평균', warnPct: 30, dangerPct: 50, direction: 'both' as const },
  { metric: 'conversions', label: '전환', baseline: '최근 7일 동시간', warnPct: 30, dangerPct: 50, direction: 'down' as const },
  { metric: 'cpa', label: 'CPA', baseline: '최근 7일 평균', warnPct: 30, dangerPct: 50, direction: 'up' as const },
  { metric: 'roas', label: 'ROAS', baseline: '최근 7일 평균', warnPct: 20, dangerPct: 35, direction: 'down' as const },
];
export const CAUSE_CANDIDATES = ['경쟁사 입찰 상승', '랜딩 오류 · 품절', '가격 · 프로모션 변경', '매체 장애 · 집계 지연'];

/** p.49 조치 보고 · SLA (분) */
export const SLA: Record<Severity, { ackMin: number; actionMin: number | null; reportMin: number | null; label: { ack: string; action: string; report: string } }> = {
  P1: { ackMin: 15, actionMin: 30, reportMin: 120, label: { ack: '15분', action: '30분', report: '2시간' } },
  P2: { ackMin: 60, actionMin: 240, reportMin: null, label: { ack: '1시간', action: '4시간', report: '당일' } },
  P3: { ackMin: 1440, actionMin: null, reportMin: null, label: { ack: '1일', action: '협의', report: '주간' } },
};
export const INCIDENT_REPORT_TEMPLATE = [
  { key: 'occur', label: '발생 · 감지', fields: '발생 시각 · 감지 경로 · 담당자' },
  { key: 'cause', label: '원인', fields: '원인 분류 · 근거 데이터' },
  { key: 'impact', label: '영향', fields: '노출 · 광고비 · 추정 매출 손실' },
  { key: 'action', label: '조치', fields: '조치 내용 · 완료 시각' },
  { key: 'prevent', label: '재발 방지', fields: '탐지 기준 · 체크리스트 업데이트' },
] as const;

/** p.43 5단계 안전망 */
export const SAFETY_NET = [
  { step: '예방', detail: '연휴 · 기획전 전 사전 점검' },
  { step: '감지', detail: 'MILDO Alert 24시간' },
  { step: '대응', detail: 'P1 30분 내 1차 조치' },
  { step: '보고', detail: '모든 이슈 같은 양식' },
  { step: '재발 방지', detail: '탐지 기준 업데이트' },
] as const;

/** p.52 전담 7인 TF (실명 · 연차 · 투입률은 제출 전 입력) */
export const TF_ROLES = [
  { id: 'pm', role: '총괄 PM', scope: '총괄 · 단일 창구', backup: 'sa_lead' },
  { id: 'sa_lead', role: 'SA Lead AE', scope: '네이버 SA 전략 · 키워드 구조', backup: 'sa_ae' },
  { id: 'sa_ae', role: 'SA AE', scope: 'SA 일 운영 · 키워드 테스트', backup: 'sa_lead' },
  { id: 'da_ae', role: 'DA AE', scope: '네이버 DA · 카카오 · 버티컬', backup: 'global_ae' },
  { id: 'global_ae', role: '글로벌 매체 AE', scope: '구글 · 메타', backup: 'da_ae' },
  { id: 'analyst', role: '데이터 애널리스트', scope: '기여 분석 · 리포트', backup: 'dev' },
  { id: 'dev', role: '솔루션 개발자', scope: '연동 · 대시보드 · 알림', backup: 'analyst' },
] as const;

/** p.53 커뮤니케이션 · 의사결정 체계 */
export const DECISION_MATRIX = [
  { type: '승인 범위 내 운영 조정', decider: '담당 AE', lead: '즉시' },
  { type: '예산 · 구조 변경', decider: 'PM 제안 → 수면밀도 승인', lead: '당일' },
  { type: '알림 · 시스템 기준', decider: '개발자 + PM', lead: '주간' },
  { type: '전략 방향', decider: '수면밀도', lead: '월간 리뷰' },
] as const;

/** p.50 계정 · 결제 · 권한 구조 */
export const OWNERSHIP = [
  { item: '광고 계정', owner: '수면밀도', role: '운영 권한 위임', approval: '수면밀도' },
  { item: '결제 수단', owner: '수면밀도 [협의]', role: '잔액 모니터링 · 충전 요청', approval: '수면밀도' },
  { item: '접근 권한', owner: '담당자 실명 계정', role: '최소 권한 · 교체 시 즉시 회수', approval: 'PM → 수면밀도 통보' },
  { item: '예산 · 구조 변경', owner: '—', role: '조정안 작성 · 근거 제시', approval: '수면밀도 승인' },
  { item: '운영 데이터', owner: '수면밀도', role: '계약 종료 시 전체 이관', approval: '—' },
] as const;

/** p.26 키워드 테스트 판정 (목표 ROAS 대비) */
export const KEYWORD_TEST_RULES = {
  minDays: 14,
  minClicks: 100, // "14일 또는 최소 클릭 수" — 초기값
  expandAtPct: 100, // 목표 ROAS 100% 이상 → 확장
  keepFromPct: 70, // 70~100% → 유지
} as const;

/** p.28 테스트 카드 중단 · 확대 기준 */
export const TEST_CARD_RULES = { stopDay: 7, stopCvrDropPct: 30, expandCvrLiftPct: 15, days: 14 } as const;

/** p.38 신규 매체 파일럿 규칙 */
export const NEW_MEDIA_PILOT = {
  maxBudgetShare: 0.05, weeks: 4, rule: '증분 매출 기준으로 확대 또는 중단',
  criteria: [
    { id: 'fit', label: '타겟 적합도', desc: '여성 31~50세 · 30대 남성 도달 비중' },
    { id: 'context', label: '구매 맥락', desc: '이사 · 신혼 · 침실 교체 순간과의 접점' },
    { id: 'measure', label: '매출 측정', desc: '브랜드스토어 · 자사몰 전환 귀속 가능 여부' },
    { id: 'cost', label: '테스트 비용', desc: '유의미한 표본을 확보할 최소 예산' },
    { id: 'brand', label: '브랜드 적합성', desc: '가격대 · 톤이 맞는 지면' },
  ],
  candidates: [
    { name: '지역 커뮤니티 · 당근', touch: '이사 · 입주 지역', hypothesis: '입주 단지 인근 지역 타겟 신규 구매' },
    { name: '영상 · YouTube', touch: '비교 · 리뷰 콘텐츠', hypothesis: 'Demand Gen으로 신규 수요 · 브랜드 검색 증가' },
    { name: '금융 · 리워드 앱', touch: '30~40대 생활 결제', hypothesis: '혜택형 광고로 신규 구매' },
    { name: '웨딩 · 이사 플랫폼', touch: '신혼 · 이사 준비', hypothesis: '생활 변화 시점 선점' },
    { name: '네이버 신규 지면', touch: '쇼핑 고객 확장', hypothesis: '기존 그룹 대비 증분 매출' },
  ],
} as const;

/** p.39 코프로모션 */
export const CO_PROMOTIONS = [
  { moment: '신혼', partners: '웨딩 · 가전 · 가구 브랜드', idea: '신혼 가구 패키지 공동 기획전', format: '공동 기획전 · 브랜드스토어' },
  { moment: '이사 · 입주', partners: '이사 · 입주청소 · 인테리어 브랜드', idea: '입주 시즌 공동 혜택', format: '번들 · 사은품' },
  { moment: '숙면 환경', partners: '침구 · 베개 · 조명 · 공기 브랜드', idea: '침실 완성 번들', format: '쇼핑라이브 공동 방송' },
  { moment: '선물', partners: '가정의 달 · 효도 선물 브랜드', idea: '부모님 매트리스 공동 캠페인', format: '시즌 공동 광고 캠페인' },
] as const;

/** p.42 2027 분기별 성장 캘린더 (협업 제안 가안) */
export const GROWTH_CALENDAR = [
  { q: '2027 Q1', theme: '기준선 · 안정화', core: '온보딩 · MILDO OS 정착 · 성과 기준선', naver: '새해 수면 환경 기획전', newMedia: '코프로모션 파트너 매칭' },
  { q: '2027 Q2', theme: '키워드 확장', core: '롱테일 · 구문형 확장 · 문제 해결형 랜딩', naver: '신혼 · 이사 시즌 기획전', newMedia: '신규 매체 파일럿 · 신혼 · 가정의 달 코프로모션' },
  { q: '2027 Q3', theme: '전환 고도화', core: '브랜드스토어 전환율 · 자사몰 CRM · DA→SA 재배분', naver: '침실 환경 기획전', newMedia: '신규 매체 확대 판단 · 숙면 환경 번들' },
  { q: '2027 Q4', theme: '연말 · 연간 리뷰', core: '연말 프로모션 · 연간 성과 리뷰', naver: '연말 구매 수요 기획전', newMedia: '연말 공동 기획전 · 2028 계획' },
] as const;

/** p.31 브랜드 ↔ 대행사 반복 구간 축소 (MILDO Flow) */
export const FLOW_SEGMENTS = [
  { seg: '데이터 요청', now: '브랜드 요청 → 대행사 취합 → 엑셀 회신', after: '브랜드팀이 대시보드에서 직접 조회', effect: '즉시 조회' },
  { seg: '보고 · 피드백', now: '보고서 작성 → 회의 → 수정 반복', after: '자동 리포트 + AE 코멘트 · 코멘트 단위 피드백', effect: '보고 왕복 축소' },
  { seg: '예산 · 세팅 변경', now: '메신저 요청 → 확인 → 반영 → 재확인', after: '요청 · 승인 · 반영 이력을 한 화면에서', effect: '누락 · 오류 감소' },
  { seg: '프로모션 준비', now: '일정 · 가격 · 소재 · 랜딩 개별 확인', after: '프로모션 체크리스트 · 오픈 전 자동 점검', effect: '오픈 사고 예방' },
  { seg: '프로모션 결과', now: '종료 후 별도 취합 · 보고', after: '프로모션별 리포트 자동 생성', effect: '다음 기획에 즉시 반영' },
] as const;

/** p.9 AI 엔진 5종 + MILDO OS */
export const AI_ENGINES = [
  { id: 'proboard', name: 'Pro-board', kind: '통합 데이터 · 대시보드', apply: 'SA · GFA · 구글 · 메타 · 판매 채널 실적 취합, 키워드 · 상품별 리포트', metric: '보고 소요시간 · 데이터 리드타임' },
  { id: 'adpilot', name: 'AD Pilot', kind: '자동입찰 · 최적화', apply: 'SA 키워드 효율 판정, 입찰 · 예산 조정 후보 생성 → 승인 후 반영', metric: 'CPC · ROAS 안정성 · 입찰 반복 업무' },
  { id: 'gfa', name: 'GFA Control v1', kind: 'DA 운영 제어', apply: 'GFA 다계정 관리, 변경 승인 라우팅, 예산 · 상태 점검, 변경 이력', metric: '세팅 오류 · 승인 리드타임' },
  { id: 'visualtune', name: 'VisualTune OS', kind: 'AI 크리에이티브', apply: '승인 제품 자산 기반 소재 베리에이션 · A/B 테스트 준비', metric: '제작 시간 · 테스트 속도' },
  { id: 'searchtune', name: 'SearchTuneOS', kind: 'SEO · AEO · GEO', apply: '제품페이지 진단, AI 검색 질의별 브랜드 노출 · 인용 점검', metric: '검색 커버리지 · 브랜드 언급률' },
] as const;

/** p.60 라이브 데모 시나리오 (15분) */
export const LIVE_DEMO = [
  { from: '00:00', to: '03:00', sec: [0, 180], title: 'Pro-board 데이터 조회', detail: '매체별 광고비 · 매출 · 핵심 키워드 필터', route: 'board' },
  { from: '03:00', to: '07:00', sec: [180, 420], title: 'SA 키워드 자동화', detail: '키워드 진단 · 신규 후보 발굴 · 자동 입찰 검증', route: 'adpilot' },
  { from: '07:00', to: '10:00', sec: [420, 600], title: '이슈 감지 자동 알림', detail: '테스트 데이터로 OFF · 급변 탐지와 알림 이력', route: 'alert' },
  { from: '10:00', to: '13:00', sec: [600, 780], title: '맞춤형 자동 리포팅', detail: '수면밀도 업무 맞춤 보고서 조회 · 출력', route: 'reports' },
  { from: '13:00', to: '15:00', sec: [780, 900], title: '운영 프로세스', detail: '감지 → 배정 → 조치 → 보고', route: 'flow' },
] as const;

/** p.23 MILDO OS 작동 시나리오 (가상 시나리오 · 실제 성과 데이터 아님) */
export const OS_SCENARIO = [
  { day: 'D+0', engine: 'MILDO Watch', action: '신혼 관련 검색 트렌드 · 유입 변화 감지', route: 'watch' },
  { day: 'D+1', engine: 'AD Pilot', action: '확장 후보 키워드와 입찰 테스트안 도출', route: 'adpilot' },
  { day: 'D+1', engine: 'SearchTuneOS', action: '관련 제품 · 정보 페이지 검색 적합성 진단', route: 'geo' },
  { day: 'D+2', engine: 'VisualTune OS', action: '승인 제품 이미지로 메시지 · 구도 후보 제작', route: 'lab' },
  { day: 'D+3', engine: 'GFA Control', action: '광고그룹 예산 · 운영 변경안 승인 후 반영', route: 'adpilot' },
  { day: 'D+7~14', engine: 'MILDO Lab + 전담 TF', action: '성과 판정 · 확대 · 중단 · 2주 후 랩업', route: 'lab' },
] as const;

/** p.58 수수료 · 계약 (제출 전 입력 필요 항목) */
export const CONTRACT_TERMS = {
  fees: [
    { media: '네이버 SA · DA', fee: null as number | null, payback: '[적용 여부]' },
    { media: '카카오', fee: null as number | null, payback: '[적용 여부]' },
    { media: '구글', fee: null as number | null, payback: '[적용 여부]' },
    { media: '메타', fee: null as number | null, payback: '[적용 여부]' },
    { media: '버티컬 매체', fee: null as number | null, payback: '[적용 여부]' },
  ],
  months: 12,
  termination: '[통보 기한 입력]',
  solutionFee: '[포함 여부 입력]',
  accountOwner: '수면밀도 소유',
} as const;

/** 의료 효능 암시 등 검수 금지 표현 (p.27, p.35 "의료 효능 암시 표현 제외") */
export const REVIEW_RULES = [
  { id: 'medical_cure', pattern: '(치료|완치|치유|교정|낫는|낫게|회복시|통증\\s?(제거|해소|완화)|디스크\\s?(개선|예방|치료))', level: 'block', reason: '의료 효능 암시 — 매트리스는 의료기기가 아니므로 질병 치료·예방·교정 효능 표현 불가' },
  { id: 'medical_device', pattern: '(의료기기|의학적|임상\\s?(입증|증명)|병원\\s?추천|의사\\s?추천|척추\\s?교정)', level: 'block', reason: '의료기기 오인 · 근거 없는 전문가 추천 표현' },
  { id: 'superlative', pattern: '(최고|최상|최초|유일|1위|넘버원|No\\.?\\s?1|국내\\s?최대)', level: 'warn', reason: '최상급 · 순위 표현은 출처 · 기간 · 기준 병기 필요 (예: 네이버 가구 부문 판매 1위, 집계 기간)' },
  { id: 'absolute', pattern: '(100%|무조건|절대|완벽|영구)', level: 'warn', reason: '절대적 표현 — 표시광고 리스크' },
  { id: 'price_claim', pattern: '(\\d{1,3}(,\\d{3})+\\s?원|\\d+\\s?만\\s?원|\\d+\\s?%\\s?(할인|세일|OFF))', level: 'check', reason: '가격 · 할인 표기 — 판매가 · 프로모션 기간과 매일 대조 (가격 불일치 탐지)' },
  { id: 'competitor', pattern: '(베스트슬립|웰퍼니처|퀵슬립|올라인매트리스|지누스|휴도)', level: 'warn', reason: '경쟁사명 사용 — 비교광고 요건 검토' },
] as const;

export const SEVERITY_LABEL: Record<Severity, string> = { P1: 'P1 · 즉시', P2: 'P2 · 1시간 내', P3: 'P3 · 24시간 내' };
