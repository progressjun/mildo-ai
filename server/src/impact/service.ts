/**
 * 성과 증명 조회 — 장부 행 목록 · 월간 요약 · 월간 가치 리포트 본문(reports 도메인이 reports.type='value'로 저장).
 */
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import { nowMs } from '../lib/time';
import { buildSummary, buildValueReport, type ImpactSummary, type LedgerEntry, type LedgerStatus, type SourceType, type ValueReportDoc } from '@/modules/impact/engine';
import { loadImpactConfig, toEntry, workspaceDataMode, type LedgerRow } from './measure';

export interface LedgerQuery { month?: string; type?: SourceType; status?: LedgerStatus; limit?: number }

/** 화면 · CSV 목록 상한 */
export const LIST_MAX = 2000;
/** 월간 요약은 그 달 장부 전체로 계산한다 (목록 상한에 잘려 합계가 줄지 않게) — 이 값은 비정상 증가 방어용 */
const SUMMARY_MAX = 100_000;

export async function listEntries(q: Queryable, wsId: string, f: LedgerQuery = {}, max = LIST_MAX): Promise<LedgerEntry[]> {
  const limit = Math.min(Math.max(f.limit ?? 500, 1), max);
  const rows = (await q.query<LedgerRow>(
    `SELECT id, source_type, source_id, label, occurred_at, window_days, status, baseline, observed, control, estimate, measured_at, month, detail
       FROM impact_ledger
      WHERE workspace_id = $1 AND ($2::text IS NULL OR month = $2) AND ($3::text IS NULL OR source_type = $3) AND ($4::text IS NULL OR status = $4)
      ORDER BY occurred_at DESC, id LIMIT $5`,
    [wsId, f.month ?? null, f.type ?? null, f.status ?? null, limit],
  )).rows;
  return rows.map(toEntry);
}

export async function summaryFor(q: Queryable, wsId: string, month: string): Promise<{ summary: ImpactSummary; entries: LedgerEntry[] }> {
  const [cfg, entries, mode] = await Promise.all([loadImpactConfig(q, wsId), listEntries(q, wsId, { month, limit: SUMMARY_MAX }, SUMMARY_MAX), workspaceDataMode(q, wsId)]);
  const summary = buildSummary(entries, cfg, month, { generatedAt: new Date(nowMs()).toISOString(), dataMode: mode });
  return { summary, entries };
}

/** 월간 가치 리포트 본문 — 지난달 요약 + 근거 (확정 팩트 / 반복 관측 패턴 / AI 해석 · 전제 조건 · 반례) */
export async function valueReportFor(q: Queryable, wsId: string, month: string, appUrl?: string): Promise<{ doc: ValueReportDoc; summary: ImpactSummary; dataMode: 'demo' | 'live' | 'mixed' }> {
  const { summary, entries } = await summaryFor(q, wsId, month);
  const ws = await one<{ brand_name: string; name: string }>(q, 'SELECT brand_name, name FROM workspaces WHERE id = $1', [wsId]);
  const doc = buildValueReport(summary, entries, { brand: ws?.brand_name || ws?.name || '워크스페이스', appUrl });
  return { doc, summary, dataMode: summary.dataMode === 'example' ? 'demo' : summary.dataMode };
}
