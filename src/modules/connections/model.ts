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
}

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

export const JOB_LABEL: Record<string, string> = { daily: '전일 확정(3일)', intraday: '당일 시간대', backfill: '기간 수집', upload: 'CSV 업로드' };
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
  return { mode: 'live', label: 'LIVE DATA', basis: live.length ? `실데이터 ${[...new Set(live)].join(' · ')}` : '연결된 출처 없음' };
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
