/**
 * 데이터 연결 화면 모델 (순수) — 서버 API 응답 형태(server/src/connectors/service.ts · catalog.ts · ingest/routes.ts)와
 * 표시 라벨 · 판정 도우미. React · DOM 없음.
 */
import type { DatasetMeta } from '@/core/types';
import { MEDIA, SALES_CHANNELS } from '@/data/constants';

export type Severity = 'error' | 'warning' | 'info';
export type WriteMode = 'off' | 'dry_run' | 'live';
export type ConnStatus = 'pending' | 'active' | 'error' | 'disabled';
export type SourceKind = 'api' | 'csv' | 'demo';

export interface CredentialField { key: string; label: string; help?: string; secret: boolean; optional?: boolean }
export interface Capabilities { reads: string[]; writes: string[]; intraday: boolean; maxBackfillDays: number }

export interface CatalogProvider {
  provider: string;
  kind: 'media' | 'sales' | 'other';
  channel: string | null;
  label: string;
  docsUrl: string;
  verifiedLive: boolean;
  credentialFields: CredentialField[];
  capabilities: Capabilities;
  sourceKind: SourceKind;
  defaultPriority: number;
  available: boolean;
  /** API 수집 근거가 없는 공급자(예: 오늘의집)의 CSV 업로드 경로 — 이 공급자는 커넥션을 만들 수 없다(서버 400 csv_only) */
  csvOnly?: CsvOnlyGuide;
  /** 브라우저 승인(OAuth 인증 코드) 흐름 — redirectUri는 공급자 앱에 등록할 콜백 주소 (서버 모드 카탈로그에만) */
  oauth?: { startLabel: string; redirectUri: string };
}

export interface CsvOnlyGuide { template: string; channel: string | null; message: string }

export interface RunSummary {
  id: string;
  job: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  rowsIn: number;
  rowsWritten: number;
  issueCounts: { error: number; warning: number; info: number };
  error: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ConnectionView {
  id: string;
  provider: string;
  providerLabel: string;
  kind: string;
  channel: string | null;
  label: string;
  status: ConnStatus;
  writeMode: WriteMode;
  priority: number;
  sourceKind: SourceKind;
  source: string;
  settings: Record<string, unknown>;
  credentials: Record<string, string | null>;
  hasCredentials: boolean;
  verifiedLive: boolean;
  docsUrl: string;
  capabilities: Capabilities | null;
  lastTestAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  pendingJobs: number;
  lastRun: RunSummary | null;
}

export interface QualityIssue { code: string; severity: Severity; message: string; detail?: unknown }

export interface RunView extends RunSummary {
  connectionId: string | null;
  uploadId: string | null;
  source: string | null;
  trigger: string | null;
  label: string;
  provider: string | null;
  issues: QualityIssue[];
  stats: Record<string, number>;
  durationMs: number | null;
}

export interface QualityItem extends QualityIssue {
  runId: string | null;
  connectionId: string | null;
  uploadId: string | null;
  label: string;
  provider: string | null;
  job: string | null;
  at: string | null;
}
export interface QualitySummary { error: number; warning: number; info: number; connections: number; checkedAt: string }

export interface UploadView {
  id: string;
  connectionId: string | null;
  template: string;
  filename: string;
  bytes: number;
  mapping: Record<string, string>;
  channel: string | null;
  status: 'received' | 'imported' | 'failed';
  summary: Record<string, unknown>;
  createdAt: string | null;
  importedAt: string | null;
}

/* ---------- 라벨 ---------- */

export const STATUS_META: Record<ConnStatus, { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; hint: string }> = {
  active: { label: '수집 중', tone: 'good', hint: '연결 확인 완료 · 예약 수집 대상' },
  pending: { label: '연결 확인 필요', tone: 'warning', hint: '자격증명을 넣고 연결 확인을 눌러야 수집이 시작됩니다' },
  error: { label: '오류', tone: 'critical', hint: '마지막 확인 · 수집이 실패했습니다. 예약 수집은 계속 재시도합니다' },
  disabled: { label: '사용 중지', tone: 'neutral', hint: '수집 · 반영을 하지 않습니다 (데이터는 유지)' },
};

export const WRITE_MODE_META: Record<WriteMode, { label: string; tone: 'neutral' | 'accent' | 'critical'; desc: string }> = {
  off: { label: '반영 끔', tone: 'neutral', desc: '승인된 변경도 이 커넥션으로는 보내지 않습니다' },
  dry_run: { label: 'dry_run', tone: 'accent', desc: '보낼 요청을 기록만 하고 매체에는 보내지 않습니다 (기본값)' },
  live: { label: 'live · 실제 반영', tone: 'critical', desc: '승인된 변경을 매체 API로 실제 호출합니다' },
};

export const RUN_STATUS_META: Record<RunSummary['status'], { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral' }> = {
  running: { label: '실행 중', tone: 'neutral' },
  succeeded: { label: '성공', tone: 'good' },
  partial: { label: '일부 제외', tone: 'warning' },
  failed: { label: '실패', tone: 'critical' },
};

export const JOB_LABEL: Record<string, string> = { daily: '전일 확정 재수집', intraday: '당일 시간대', backfill: '기간 수집', upload: 'CSV 업로드' };

/** 예약 · 수동 daily 재수집 일수 (어제 포함) — 서버 ingest/pipeline.ts DAILY_RECOLLECT_DAYS와 같다: 매체 3일(늦은 전환), 판매 채널 14일(늦은 취소 · 반품) */
export const DAILY_RECOLLECT_DAYS = { media: 3, sales: 14 } as const;
export const dailyRecollectDays = (kind: string | null | undefined): number => (kind === 'sales' ? DAILY_RECOLLECT_DAYS.sales : DAILY_RECOLLECT_DAYS.media);

/** CSV 전용 공급자 안내 한 줄 — 'CSV 업로드 전용 — 판매 채널 일별 템플릿(sales_daily, 채널 ohouse)' */
export function csvOnlyLabel(g: CsvOnlyGuide, templateLabel: string): string {
  return `CSV 업로드 전용 — ${templateLabel} 템플릿(${g.template}${g.channel ? `, 채널 ${g.channel}` : ''})`;
}
export const SEVERITY_META: Record<Severity, { label: string; tone: 'critical' | 'warning' | 'neutral' }> = {
  error: { label: '오류', tone: 'critical' }, warning: { label: '경고', tone: 'warning' }, info: { label: '참고', tone: 'neutral' },
};
export const KIND_LABEL: Record<string, string> = { media: '매체', sales: '판매 채널', other: '기타 · 업로드' };
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = { api: 'API', csv: 'CSV', demo: 'TEST DATA' };

export const READ_LABEL: Record<string, string> = {
  mediaDaily: '매체 일별', mediaHourly: '시간대', salesDaily: '판매 일별', keywordDaily: '키워드 일별', searchTermDaily: '검색어',
  brandSearchDaily: '브랜드 검색량', keywords: '키워드', campaigns: '캠페인', accounts: '계정 · 잔액', products: '상품 · 재고', promotions: '프로모션',
};
export const WRITE_LABEL: Record<string, string> = {
  bid: '입찰가', budget: '일 예산', status: 'ON/OFF', keyword_add: '키워드 추가', keyword_exclude: '제외 키워드', gfa: 'GFA 설정', setting: '설정', alert_rule: '감지 규칙', test: '테스트',
};

export function channelLabel(ch: string | null | undefined): string {
  if (!ch) return '—';
  if (ch in MEDIA) return MEDIA[ch as keyof typeof MEDIA].name;
  if (ch in SALES_CHANNELS) return SALES_CHANNELS[ch as keyof typeof SALES_CHANNELS].name;
  if (ch === 'brand_search') return '브랜드 검색량';
  return ch;
}

/* ---------- 시각 ---------- */

const KST_FMT = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** ISO → 'MM.DD HH:mm' (KST) */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const parts = Object.fromEntries(KST_FMT.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return `${parts.month}.${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

/** KST 기준 날짜 'YYYY-MM-DD' (서버 lib/time kstToday와 같은 기준) */
export function kstDateOf(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * CSV 미래 날짜 판정 기준일 — 화면 Dataset 기준일과 실제 오늘(KST) 중 늦은 날.
 * 서버는 실제 오늘(KST)로 판정하므로, 데모(기준일 고정) 미리보기가 실제로는 지난 날짜를 미래라고 하지 않게 한다.
 */
export function csvCheckDay(datasetToday: string, nowMs: number): string {
  const real = kstDateOf(nowMs);
  return datasetToday > real ? datasetToday : real;
}

/** 경과 시간 표시 ('3분 전', '5시간 전', '2일 전') */
export function ago(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '없음';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const m = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  return `${Math.round(ms / 60_000)}분`;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/* ---------- 판정 도우미 ---------- */

/** 데이터 출처 표시: Dataset 메타 → TEST DATA · LIVE · 일부 LIVE */
export function sourceModeOf(meta: DatasetMeta | undefined): { mode: 'demo' | 'live' | 'mixed'; label: string; basis: string } {
  if (!meta) return { mode: 'demo', label: 'TEST DATA', basis: '서버 미연결 — 시연용 생성기 데이터 (실제 성과 아님)' };
  const live = meta.sources.filter((s) => s.kind !== 'demo').map((s) => channelLabel(s.channel));
  const demo = meta.sources.filter((s) => s.kind === 'demo').map((s) => channelLabel(s.channel));
  if (meta.mode === 'demo') return { mode: 'demo', label: 'TEST DATA', basis: `모든 매체 · 채널이 데모 출처 (${demo.length}개)` };
  if (meta.mode === 'mixed') return { mode: 'mixed', label: '일부 LIVE', basis: `실데이터 ${[...new Set(live)].join(' · ')} / 데모 ${[...new Set(demo)].join(' · ')}` };
  // 출처가 하나도 없으면 LIVE라고 부르지 않는다 (플랫폼 배지와 같은 '데이터 없음')
  if (!live.length) return { mode: 'live', label: '데이터 없음', basis: '연결된 출처 없음 — 매체 API를 연결하거나 CSV를 올리세요' };
  return { mode: 'live', label: 'LIVE DATA', basis: `실데이터 ${[...new Set(live)].join(' · ')}` };
}

/** 긴 목록 문구를 max자 안에서 구분자(' · ' · ' / ') 단위로 자르고 '…'을 붙인다 (전체 문구는 title로) */
export function clipList(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf(' · '), cut.lastIndexOf(' / '));
  const head = (at > max * 0.4 ? cut.slice(0, at) : cut).replace(/[\s·/,]+$/u, '');
  return `${head} …`;
}

/** CSV 가져오기 버튼 잠금 사유 (없으면 null) — 예시 내용(TEST DATA)은 실데이터로 가져오지 않는다 */
export function uploadImportLock(o: { server: boolean; canOperate: boolean; isSample: boolean; serverPreview: boolean; blocking: number }): string | null {
  if (!o.server) return '서버 연결 시 가져올 수 있습니다';
  if (!o.canOperate) return '담당 AE 이상';
  if (o.isSample) return '예시 내용(TEST DATA)은 미리보기만 할 수 있습니다 — 실제 파일을 올려 주세요';
  if (!o.serverPreview) return '미리보기를 먼저 누르세요';
  if (o.blocking) return '오류를 먼저 해결하세요';
  return null;
}

/** 업로드 이력 상태 — 서버 업로드 summary.outcome(가져옴 · 일부 제외 · 0행)과 status로 판정. 0행이면 '가져옴'(초록)이라고 하지 않는다 */
export function uploadStatusMeta(u: Pick<UploadView, 'status' | 'summary'>): { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; title?: string; runFilter?: 'partial' | 'failed' } {
  const sm = u.summary ?? {};
  const why = Array.isArray(sm.issueSummary) ? (sm.issueSummary as unknown[]).map(String).join('\n') : undefined;
  if (u.status === 'failed') {
    const err = sm.error ? String(sm.error) : '';
    return { label: `실패${err ? ` · ${err.slice(0, 40)}${err.length > 40 ? '…' : ''}` : ''}`, tone: 'critical', title: err || undefined, runFilter: 'failed' };
  }
  if (u.status !== 'imported') return { label: '가져오는 중', tone: 'neutral' };
  const written = Number(sm.rowsWritten ?? sm.records ?? 0);
  if (sm.outcome === 'empty' || (sm.rowsWritten !== undefined && written === 0)) return { label: '가져온 행 없음 · 모두 제외', tone: 'warning', title: why, runFilter: 'partial' };
  if (sm.outcome === 'partial') return { label: `일부 제외 · ${written.toLocaleString('ko-KR')}행 가져옴`, tone: 'warning', title: why, runFilter: 'partial' };
  return { label: '가져옴', tone: 'good' };
}

/** 수집 현황 빈 표 문구 — 필터 때문에 비었는지, 정말 실행이 없는지 구분한다 */
export function runsEmptyText(server: boolean, filter: 'all' | 'failed' | 'partial', loaded: number, hasMore: boolean): string {
  if (filter !== 'all' && loaded > 0) return `불러온 실행 중 조건(${filter === 'failed' ? '실패' : '일부 제외'})에 맞는 실행이 없습니다${hasMore ? ' — 더 보기로 이전 실행을 불러올 수 있습니다' : ''}`;
  return server ? '아직 수집 실행이 없습니다' : '예시 실행이 없습니다';
}

/** 커넥션 삭제 확인 문구 — 실제로 지우는 범위(CSV 커넥션은 그 커넥션으로 올린 업로드까지) */
export function deleteScopeText(c: Pick<ConnectionView, 'provider' | 'sourceKind'>, uploads: number): string {
  const what = c.sourceKind === 'csv'
    ? `이 커넥션으로 올린 업로드${uploads ? ` ${uploads}개` : ''}와 그 웨어하우스 데이터, 수집 이력을 모두 지웁니다`
    : '이 커넥션으로 수집한 웨어하우스 데이터와 수집 이력, 대기 중인 수집을 모두 지웁니다';
  return `${what}. 같은 매체에 다른 출처가 있으면 그 값이 다시 쓰입니다${c.provider === 'demo' ? ' (데모 TEST DATA를 지우면 실데이터만 남습니다)' : ''}. 되돌릴 수 없고 감사 로그에 남습니다.`;
}

/** 출처별 최신 날짜가 기준일 전날보다 오래되면 지연 */
export function staleSources(meta: DatasetMeta | undefined, today: string): { channel: string; source: string; kind: string; latestDate: string | null }[] {
  if (!meta) return [];
  const y = addDays(today, -1);
  return meta.sources.filter((s) => s.channel !== 'brand_search' && (!s.latestDate || s.latestDate < y));
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function qualityCounts(items: { severity: Severity }[]): Record<Severity, number> {
  const c = { error: 0, warning: 0, info: 0 };
  for (const i of items) c[i.severity]++;
  return c;
}

/** 커넥션 카드 요약 문장 (판정 + 기준) */
export function connectionVerdict(c: ConnectionView, nowMs: number): { tone: 'good' | 'warning' | 'critical' | 'neutral'; label: string; basis: string } {
  if (c.status === 'disabled') return { tone: 'neutral', label: '사용 중지', basis: '수집 · 반영 안 함' };
  if (c.status === 'error') return { tone: 'critical', label: '오류', basis: c.lastError ? c.lastError.slice(0, 120) : '사유 미상' };
  if (c.status === 'pending') return { tone: 'warning', label: '연결 확인 필요', basis: '연결 확인 성공 후 예약 수집 시작' };
  if (c.sourceKind === 'csv') return { tone: 'good', label: '업로드 수집', basis: '파일을 올릴 때마다 가져옴' };
  if (!c.lastSyncAt) return { tone: 'warning', label: '수집 전', basis: c.pendingJobs ? '수집 대기열 등록됨' : '지금 수집 또는 07:00 예약 대기' };
  const h = (nowMs - Date.parse(c.lastSyncAt)) / 3_600_000;
  if (h > 26) return { tone: 'warning', label: '수집 지연', basis: `마지막 수집 ${Math.floor(h)}시간 전 (기준 26시간)` };
  if (c.lastRun?.status === 'partial') return { tone: 'warning', label: '일부 행 제외', basis: `오류 ${c.lastRun.issueCounts.error}건 · 경고 ${c.lastRun.issueCounts.warning}건 (최근 실행)` };
  return { tone: 'good', label: '정상', basis: `마지막 수집 ${ago(c.lastSyncAt, nowMs)} · 기준 26시간 이내` };
}

/** 쓰기 모드 live 확인 문구 (두 번째 단계에서 그대로 입력) */
export const LIVE_CONFIRM_TEXT = '실제 반영에 동의합니다';

/** 기간 지정 수집 가능 범위 */
export function syncBounds(today: string, cap: Capabilities | null): { min: string; max: string; maxDays: number } {
  const maxDays = Math.min(400, Math.max(0, cap?.maxBackfillDays ?? 0));
  return { min: addDays(today, -maxDays), max: today, maxDays };
}

export function validateSyncRange(from: string, to: string, today: string, cap: Capabilities | null): string | null {
  const b = syncBounds(today, cap);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return '날짜를 YYYY-MM-DD로 입력해 주세요';
  if (from > to) return '시작일이 종료일보다 늦습니다';
  if (to > today) return '미래 날짜는 수집할 수 없습니다';
  if (b.maxDays <= 0) return '이 커넥터는 기간 지정 수집을 지원하지 않습니다';
  if (from < b.min) return `최근 ${b.maxDays}일(${b.min} 이후)까지만 수집할 수 있습니다`;
  return null;
}

/** CSV 파일 바이트 → 텍스트 (UTF-8 우선, 실패하면 EUC-KR — 엑셀 한글 CSV) */
export function decodeCsvBytes(buf: ArrayBuffer): { text: string; encoding: 'utf-8' | 'euc-kr' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('euc-kr').decode(buf), encoding: 'euc-kr' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8' };
    }
  }
}
