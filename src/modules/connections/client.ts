/**
 * 데이터 연결 API 클라이언트 (서버 모드) + 마지막으로 읽은 상태 스냅샷(에이전트 도구용).
 * 경로 · 응답 형태는 docs/SAAS_SPEC.md §6 data 행.
 */
import { api as baseApi, wsPath, type ApiOptions } from '@/saas/api';
import type { CatalogProvider, ConnectionView, QualityItem, QualitySummary, RunView, UploadView, WriteMode } from './model';
import type { CsvIssue, UploadTemplate } from './csv';

/** 이 화면은 오류를 직접 안내한다 — 전역 오류 토스트를 끈다 */
const api = <T,>(path: string, o: ApiOptions = {}) => baseApi<T>(path, { ...o, silent: true } as ApiOptions);

export interface UploadResult {
  upload: UploadView | null;
  preview: (Record<string, unknown> & { _line: number })[];
  issues: CsvIssue[];
  columns: { headers: string[]; mapping: Record<string, string | null>; missing: string[]; unmapped: string[] };
  summary: { rows: number; validRows: number; invalidRows: number; records: number; dateFrom: string | null; dateTo: string | null; channels: string[]; delimiter: string; headers: string[] };
  jobId?: number | null;
}

export const connectionsApi = {
  catalog: () => api<{ providers: CatalogProvider[] }>('/api/connectors/catalog'),
  list: (ws: string) => api<{ connections: ConnectionView[] }>(wsPath(ws, '/connections')),
  create: (ws: string, body: { provider: string; label?: string; credentials?: Record<string, string>; priority?: number; writeMode?: WriteMode; channel?: string | null }) =>
    api<{ connection: ConnectionView; connections: ConnectionView[] }>(wsPath(ws, '/connections'), { method: 'POST', body }),
  patch: (ws: string, id: string, body: { label?: string; credentials?: Record<string, string>; priority?: number; writeMode?: WriteMode; status?: 'active' | 'disabled' }) =>
    api<{ connection: ConnectionView; connections: ConnectionView[] }>(wsPath(ws, `/connections/${id}`), { method: 'PATCH', body }),
  remove: (ws: string, id: string) => api<{ ok: boolean; purgedRows: number; connections: ConnectionView[] }>(wsPath(ws, `/connections/${id}`), { method: 'DELETE' }),
  test: (ws: string, id: string) => api<{ result: { ok: boolean; message: string; account?: string }; backfillQueued: boolean; connection: ConnectionView; connections: ConnectionView[] }>(wsPath(ws, `/connections/${id}/test`), { method: 'POST', body: {} }),
  sync: (ws: string, id: string, range?: { from: string; to: string }) =>
    api<{ queued: boolean; alreadyQueued: boolean; connection: ConnectionView; connections: ConnectionView[] }>(wsPath(ws, `/connections/${id}/sync`), { method: 'POST', body: range ?? {} }),
  runs: (ws: string, q: { limit?: number; before?: string | null; status?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.limit) p.set('limit', String(q.limit));
    if (q.before) p.set('before', q.before);
    if (q.status) p.set('status', q.status);
    const s = p.toString();
    return api<{ runs: RunView[]; nextBefore: string | null }>(wsPath(ws, `/ingest/runs${s ? `?${s}` : ''}`));
  },
  quality: (ws: string) => api<{ issues: QualityItem[]; summary: QualitySummary }>(wsPath(ws, '/ingest/quality')),
  uploads: (ws: string) => api<{ uploads: UploadView[] }>(wsPath(ws, '/uploads')),
  upload: (ws: string, body: { template: UploadTemplate; filename: string; content: string; mapping?: Record<string, string | null>; dryRun?: boolean; channel?: string | null; connectionId?: string | null }) =>
    api<UploadResult>(wsPath(ws, '/uploads'), { method: 'POST', body }),
  removeUpload: (ws: string, id: string) => api<{ ok: boolean; purgedRows: number }>(wsPath(ws, `/uploads/${id}`), { method: 'DELETE' }),
};

/* ---------- 스냅샷 (화면이 마지막으로 읽은 서버 상태 — MILDO Agent 도구가 읽는다) ---------- */

export interface Snapshot {
  workspaceId: string;
  at: number;
  connections: ConnectionView[];
  runs: RunView[];
  quality: { issues: QualityItem[]; summary: QualitySummary } | null;
}

let snapshot: Snapshot | null = null;
export function setSnapshot(s: Snapshot | null): void {
  snapshot = s;
}
export function getSnapshot(): Snapshot | null {
  return snapshot;
}
