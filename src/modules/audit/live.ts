/**
 * 서버 모드에서 화면이 마지막으로 불러온 감사 기록 — MILDO Agent 도구 · 브리프가 읽는다.
 */
import type { AuditEntry } from './engine';

export interface AuditSnapshot { workspaceId: string; entries: AuditEntry[]; at: string }
let snap: AuditSnapshot | null = null;

export function setAuditSnapshot(workspaceId: string, entries: AuditEntry[]): void {
  snap = { workspaceId, entries: entries.slice(0, 500), at: new Date().toISOString() };
}
export const getAuditSnapshot = (): AuditSnapshot | null => snap;
export function _resetAuditSnapshot(): void {
  snap = null;
}
