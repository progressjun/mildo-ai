/**
 * 성과 증명 · 리포트 보관함 서버 API (서버 모드 전용) — 계약: docs/SAAS_SPEC.md §6 reports · impact, 구현: server/src/reports · server/src/impact.
 * 화면이 오류를 직접 보여 주므로 전역 오류 토스트는 끈다(silent). 불러온 값은 에이전트 도구용 스냅샷(live.ts)에도 남긴다.
 */
import { api, wsPath } from '@/saas/api';
import type { ImpactSummary, LedgerEntry } from './engine';
import { setImpactSnapshot } from './live';

const silent = { silent: true } as const;

export type ReportKind = 'daily' | 'weekly' | 'monthly' | 'issue' | 'value';
export const REPORT_KIND_LABEL: Record<ReportKind, string> = { daily: '일간', weekly: '주간', monthly: '월간', issue: '이슈', value: '가치' };
export const TRIGGER_LABEL: Record<string, string> = { schedule: '예약 생성', incident: 'P1 감지', manual: '화면에서 생성' };

export interface DeliveryRecord {
  channelId: string | null;
  channelType: 'slack' | 'email' | 'webhook' | null;
  channelName: string;
  via: 'notify.send' | 'direct' | 'none';
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  jobId?: number | null;
  target?: string;
  reason?: string | null;
  at: string;
  by: string;
}
export interface ReportItem {
  id: string;
  type: ReportKind;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string;
  status: 'generated' | 'delivered' | 'failed';
  trigger: 'schedule' | 'incident' | 'manual';
  scope: string | null;
  refId: string | null;
  dataMode: 'demo' | 'live' | 'mixed' | null;
  dataAsOf: string | null;
  messenger: string | null;
  aeComment: string | null;
  delivered: DeliveryRecord[];
  deliveredAt: string | null;
  excerpt: string;
  markdown?: string;
}
export interface ScheduleRow { type: ReportKind; at: string; covers: string; rule: string }

export async function fetchSummary(ws: string, month: string): Promise<ImpactSummary> {
  const r = await api<{ summary: ImpactSummary }>(wsPath(ws, `/impact/summary?month=${encodeURIComponent(month)}`), silent);
  setImpactSnapshot(ws, { summary: r.summary });
  return r.summary;
}

export async function fetchLedger(ws: string, month?: string): Promise<LedgerEntry[]> {
  const q = month ? `?month=${encodeURIComponent(month)}` : '';
  const r = await api<{ entries: LedgerEntry[] }>(wsPath(ws, `/impact/ledger${q}`), silent);
  setImpactSnapshot(ws, { entries: r.entries, month });
  return r.entries;
}

export const measureNow = (ws: string, force = false) =>
  api<{ result: { changes: Record<string, number>; incidents: Record<string, number>; automation: { hours: number } }; summary: ImpactSummary }>(wsPath(ws, '/impact/measure'), { method: 'POST', body: { force }, ...silent });

export async function fetchReports(ws: string, q: { type?: ReportKind | ''; before?: string | null; limit?: number } = {}): Promise<{ reports: ReportItem[]; nextBefore: string | null }> {
  const p = new URLSearchParams();
  if (q.type) p.set('type', q.type);
  if (q.before) p.set('before', q.before);
  p.set('limit', String(q.limit ?? 30));
  const r = await api<{ reports: ReportItem[]; nextBefore: string | null }>(wsPath(ws, `/reports?${p.toString()}`), silent);
  if (!q.type && !q.before) setImpactSnapshot(ws, { reports: r.reports });
  return r;
}

export const fetchReport = (ws: string, id: string) => api<{ report: ReportItem }>(wsPath(ws, `/reports/${encodeURIComponent(id)}`), silent).then((r) => r.report);
export const fetchSchedule = (ws: string) => api<{ schedule: ScheduleRow[]; today: string }>(wsPath(ws, '/reports/schedule'), silent);
export const generateReport = (ws: string, body: { type: ReportKind; periodStart?: string; month?: string; deliver?: boolean }) =>
  api<{ report: ReportItem }>(wsPath(ws, '/reports/generate'), { method: 'POST', body, ...silent }).then((r) => r.report);
export const deliverReport = (ws: string, id: string) =>
  api<{ report: ReportItem; results: DeliveryRecord[] }>(wsPath(ws, `/reports/${encodeURIComponent(id)}/deliver`), { method: 'POST', body: {}, ...silent });
