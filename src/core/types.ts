/**
 * MILDO OS 도메인 타입.
 * 모든 수치 데이터는 출처 구분(SourceKind)을 갖는다.
 *  - RFP     : 수면밀도 2027 RFP에 명시된 확정 정보
 *  - PROPOSAL: 프로그레스미디어 2027 제안서(v3)에 명시된 기준·약속
 *  - DEMO    : 시연용 테스트 데이터 (실제 성과 데이터 아님)
 *  - AI      : AI 해석 결과
 */
export type SourceKind = 'RFP' | 'PROPOSAL' | 'DEMO' | 'AI' | 'LIVE';

export type MediaId = 'naver_sa' | 'naver_gfa' | 'google' | 'meta' | 'kakao' | 'vertical';
export type SalesChannelId = 'brandstore' | 'ohouse' | 'coupang' | 'own_mall';

/** 네이버 SA 구매 의도별 5개 캠페인 (제안서 p.35) */
export type IntentId = 'brand' | 'generic' | 'problem' | 'compare' | 'life';

export type Severity = 'P1' | 'P2' | 'P3';

export interface MediaMeta {
  id: MediaId;
  name: string;
  short: string;
  role: string; // 제안서 p.37 역할
  setting: string;
  judgeMetric: string;
  share: number; // 배분 가안 비율 (0~1)
  annualBudget: number; // 원
  colorVar: string; // CSS 변수명 (차트 색 고정)
}

export interface SalesChannelMeta {
  id: SalesChannelId;
  name: string;
  colorVar: string;
}

export interface FunnelCounts {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  revenue: number;
}

export interface DailyMediaRow extends FunnelCounts {
  date: string; // YYYY-MM-DD
  media: MediaId;
  newCustomers: number;
}

export interface HourlyMediaRow extends FunnelCounts {
  date: string;
  hour: number; // 0~23
  weekday: number; // 0=일 ~ 6=토
  media: MediaId;
}

export interface DailySalesRow {
  date: string;
  channel: SalesChannelId;
  visitors: number;
  detailViews: number;
  carts: number;
  orders: number;
  revenue: number;
  adAttributedRevenue: number; // 광고 경유 매출 (추정)
}

export interface KeywordStats {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  revenue: number;
}

export interface Keyword {
  id: string;
  text: string;
  intent: IntentId;
  adgroup: string;
  isBrand: boolean;
  bid: number; // 현재 입찰가 (원)
  maxBid: number; // 최대 입찰가 (안전 상한)
  avgRank: number;
  monthlySearch: number; // 월간 검색량 (PC+모바일)
  impressionShareLost: number; // 노출 기회 손실률 0~1 (순위/예산)
  status: 'on' | 'off' | 'test';
  landing: string;
  last14: KeywordStats;
  prev14: KeywordStats;
  /** 최근 14일 일자별 (스파크라인/급변 탐지용) */
  daily: KeywordStats[];
}

export interface Campaign {
  id: string;
  media: MediaId;
  name: string;
  intent?: IntentId;
  dailyBudget: number;
  spentToday: number; // 오늘 현재까지 소진액
  status: 'on' | 'off' | 'limited';
  hourOfData: number; // spentToday 기준 시각
}

export interface AdAccount {
  id: string;
  media: MediaId | SalesChannelId;
  name: string;
  owner: string; // 소유 주체 (제안서 p.50: 수면밀도)
  balance: number; // 비즈머니/선결제 잔액, 후불이면 -1
  avgDailySpend: number;
  autoCharge: 'ok' | 'failed' | 'off' | 'postpaid';
  paymentMethod: string;
  permissions: { user: string; role: string; realName: boolean; lastLogin: string }[];
  status: 'active' | 'review' | 'restricted';
}

export interface SearchTermRow {
  term: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  revenue: number;
  registered: boolean; // 이미 등록된 키워드인지
}

export interface Product {
  id: string;
  name: string;
  options: { id: string; label: string; price: number; inStock: boolean }[];
  landing: string;
}

export interface Promotion {
  id: string;
  name: string;
  channel: SalesChannelId;
  start: string;
  end: string;
  discountRate: number;
  adCopyPrice?: number; // 소재 문구 표기가
  status: 'planned' | 'live' | 'ended';
}

export interface Dataset {
  generatedAt: string; // 기준 시각 ISO
  today: string; // YYYY-MM-DD (기준일)
  currentHour: number;
  dates: string[]; // 오름차순 (daily 범위)
  mediaDaily: DailyMediaRow[];
  mediaHourly: HourlyMediaRow[]; // 최근 35일
  salesDaily: DailySalesRow[];
  keywords: Keyword[];
  campaigns: Campaign[];
  accounts: AdAccount[];
  searchTerms: SearchTermRow[];
  products: Product[];
  promotions: Promotion[];
  /** 브랜드 키워드(수면밀도·밀도 매트리스) 일자별 검색량 — DA→SA 분석용 */
  brandSearchDaily: { date: string; volume: number }[];
  /** 서버 모드: 데이터 출처 메타 (없으면 데모 데이터) */
  meta?: DatasetMeta;
}

export interface DatasetMeta {
  /** demo = 테스트 데이터만, live = 실연동 데이터만, mixed = 일부 매체 · 채널만 실연동 */
  mode: 'demo' | 'live' | 'mixed';
  builtAt: string;
  /** 매체 · 채널별 사용 출처와 최신 데이터 시각 */
  sources: { channel: string; source: string; kind: 'api' | 'csv' | 'demo'; latestDate: string | null; latestHour?: number | null }[];
}

/* ---------- 운영 상태 (스토어) ---------- */

export type ChangeKind = 'bid' | 'budget' | 'status' | 'keyword_add' | 'keyword_exclude' | 'gfa' | 'setting' | 'alert_rule' | 'test';
export type ApprovalLevel = 'AE' | 'PM' | 'CLIENT'; // 담당 AE / PM / 수면밀도 승인

export interface ChangeRequest {
  id: string;
  createdAt: string;
  module: string; // adpilot / gfa / lab / alert ...
  kind: ChangeKind;
  target: string; // 키워드/캠페인/광고그룹명
  targetId?: string;
  before: string | number;
  after: string | number;
  changePct?: number; // 변경 폭 (%)
  reason: string; // 왜
  requestedBy: string; // 누가
  approver: ApprovalLevel;
  status: 'pending' | 'approved' | 'applied' | 'rejected' | 'rolled_back' | 'held';
  history: { at: string; by: string; action: string; note?: string }[];
  /** 서버 모드: 매체 반영 실행 결과 (dry_run = 호출 내용만 기록, live = 실제 API 호출) */
  execution?: ChangeExecution;
}

export interface ChangeExecution {
  mode: 'dry_run' | 'live' | 'none';
  ok: boolean;
  at: string;
  connectionId?: string;
  provider?: string;
  /** 보낸(또는 보낼) 요청 요약 — 비밀값 제외 */
  request?: unknown;
  response?: unknown;
  error?: string;
}

export interface Incident {
  id: string;
  ruleId: string;
  severity: Severity;
  title: string;
  media?: MediaId | SalesChannelId;
  target?: string;
  detectedAt: string;
  occurredAt: string;
  detectPath: string; // 감지 경로
  metric?: string;
  observed?: number;
  baseline?: number;
  deltaPct?: number;
  causeCandidates: string[];
  impact: { impressionsLost?: number; spendAtRisk?: number; revenueLossEst?: number };
  assignee?: string;
  backup?: string;
  status: 'open' | 'ack' | 'action' | 'resolved';
  timeline: { at: string; by: string; action: string }[];
  actionNote?: string;
  preventNote?: string;
  isTest: boolean; // 테스트 데이터로 생성된 이슈
  autoActions: string[]; // 시스템 자동 조치 (자동 조정 보류 등)
}

export interface Toast {
  id: string;
  tone: 'info' | 'good' | 'warning' | 'critical';
  title: string;
  body?: string;
  route?: string;
}

export interface AiSettings {
  mode: 'auto' | 'artifact' | 'anthropic' | 'offline';
  apiKey: string;
  model: string;
}
