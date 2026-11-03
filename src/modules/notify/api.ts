/**
 * 알림 설정 서버 API (서버 모드 전용) — 계약: docs/SAAS_SPEC.md §6 alerts, 구현: server/src/alerts/index.ts.
 * 화면이 오류를 직접 보여 주므로 전역 오류 토스트는 끈다(silent). 불러온 값은 에이전트 도구용 스냅샷에도 남긴다.
 */
import { api, wsPath } from '@/saas/api';
import type { Channel, LogEntry, Policy, ScanRun } from './model';
import { setNotifySnapshot } from './live';

const silent = { silent: true } as const;

export async function fetchChannels(ws: string): Promise<Channel[]> {
  const r = await api<{ channels: Channel[] }>(wsPath(ws, '/notify/channels'), silent);
  setNotifySnapshot(ws, { channels: r.channels });
  return r.channels;
}

export async function fetchLog(ws: string, q: { status?: string; event?: string; channelId?: string; before?: number | null; limit?: number } = {}): Promise<{ entries: LogEntry[]; nextBefore: number | null }> {
  const p = new URLSearchParams();
  if (q.status) p.set('status', q.status);
  if (q.event) p.set('event', q.event);
  if (q.channelId) p.set('channelId', q.channelId);
  if (q.before) p.set('before', String(q.before));
  p.set('limit', String(q.limit ?? 100));
  const r = await api<{ entries: LogEntry[]; nextBefore: number | null }>(wsPath(ws, `/notify/log?${p.toString()}`), silent);
  if (!q.status && !q.event && !q.channelId && !q.before) setNotifySnapshot(ws, { log: r.entries });
  return r;
}

export async function fetchRuns(ws: string): Promise<ScanRun[]> {
  const r = await api<{ runs: ScanRun[] }>(wsPath(ws, '/alerts/runs'), silent);
  setNotifySnapshot(ws, { runs: r.runs });
  return r.runs;
}

export const fetchPolicy = (ws: string) => api<Policy>(wsPath(ws, '/alerts/policy'), silent);

export const createChannel = (ws: string, body: Record<string, unknown>) =>
  api<{ channel: Channel }>(wsPath(ws, '/notify/channels'), { method: 'POST', body, ...silent });

export const updateChannel = (ws: string, id: string, body: Record<string, unknown>) =>
  api<{ channel: Channel }>(wsPath(ws, `/notify/channels/${encodeURIComponent(id)}`), { method: 'PATCH', body, ...silent });

export const deleteChannel = (ws: string, id: string) =>
  api<{ ok: true }>(wsPath(ws, `/notify/channels/${encodeURIComponent(id)}`), { method: 'DELETE', ...silent });

export const testChannel = (ws: string, id: string, sample = false) =>
  api<{ result: { ok: boolean; status: string; httpStatus: number | null; reason: string | null }; channel: Channel }>(
    wsPath(ws, `/notify/channels/${encodeURIComponent(id)}/test`), { method: 'POST', body: { sample }, ...silent });

export const runScan = (ws: string) =>
  api<{ found: number; created: number; cleared: number; notified: number; warning: string | null }>(wsPath(ws, '/alerts/scan'), { method: 'POST', body: {}, ...silent });
