/**
 * 감사 로그 서버 API (서버 모드 전용) — 계약: docs/SAAS_SPEC.md §6 team, 구현: server/src/team/auditLog.ts.
 */
import { api, ApiError, wsPath } from '@/saas/api';
import { buildAuditQuery, type AuditEntry, type AuditFilters } from './engine';

export interface AuditPage { entries: AuditEntry[]; nextBefore: number | null }
export interface AuditFacets { actions: { action: string; label: string; count: number }[]; users: { id: string; name: string; email: string; member: boolean }[] }

export const fetchAudit = (ws: string, f: AuditFilters, before?: number | null, limit = 100) =>
  api<AuditPage>(wsPath(ws, `/audit${buildAuditQuery(f, { before, limit })}`), { silent: true });

export const fetchFacets = (ws: string) => api<AuditFacets>(wsPath(ws, '/audit/facets'), { silent: true });

/** CSV 원문 (UTF-8 BOM 포함) — 서버도 내보내기를 'audit.export'로 감사 기록한다 */
export async function fetchAuditCsv(ws: string, f: AuditFilters): Promise<{ csv: string; rows: number; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(wsPath(ws, `/audit.csv${buildAuditQuery(f)}`), { credentials: 'same-origin', headers: { accept: 'text/csv' } });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `내려받기 실패 (${res.status})`;
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* JSON 아님 */ }
    throw new ApiError(res.status, `http_${res.status}`, msg);
  }
  // Response.text()는 BOM을 지운다 → 엑셀 한글 깨짐 방지를 위해 다시 붙인다
  const csv = text.charCodeAt(0) === 0xfeff ? text : `﻿${text}`;
  return { csv, rows: Number(res.headers.get('x-audit-rows') ?? NaN), truncated: res.headers.get('x-audit-truncated') === 'true' };
}
