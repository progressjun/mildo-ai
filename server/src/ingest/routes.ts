/**
 * 수집 현황 · 데이터 품질 API (docs/SAAS_SPEC.md §6 data)
 *   GET /api/w/:ws/ingest/runs?connectionId=&uploadId=&status=&limit=&before=  (read) → { runs, nextBefore }
 *   GET /api/w/:ws/ingest/quality (read) → { issues, summary }
 *     최근 14일 실행(커넥션 × 실행 종류별 마지막 · 업로드)의 품질 이슈 + 수집 지연 · 연결 오류 · 최신 데이터 날짜 점검
 */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { getConnector } from '../connectors/registry';
import { sourceKeyOf, toRunSummary, type ConnectionRow } from '../connectors/service';
import { addDaysStr, kstParts, nowMs } from '../lib/time';
import type { QualityIssue } from './quality';

const RunsQuery = z.object({
  connectionId: z.string().uuid().optional(),
  uploadId: z.string().uuid().optional(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime({ offset: true }).optional(),
});

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export interface QualityItem extends QualityIssue {
  runId: string | null;
  connectionId: string | null;
  uploadId: string | null;
  label: string;
  provider: string | null;
  job: string | null;
  at: string | null;
}

/** 커넥션이 26시간 넘게 수집되지 않으면 지연 */
const STALE_HOURS = 26;

export const ingestRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/w/:ws/ingest/runs', async (req) => {
    const c = await req.workspace('read');
    const qs = parseBody(RunsQuery, req.query);
    const limit = qs.limit ?? 50;
    const rows = (await db.query(
      `SELECT r.*, c.label AS connection_label, c.provider, u.filename AS upload_filename, u.template AS upload_template
         FROM ingest_runs r
         LEFT JOIN connections c ON c.id = r.connection_id
         LEFT JOIN uploads u ON u.id = r.upload_id
        WHERE r.workspace_id = $1
          AND ($2::uuid IS NULL OR r.connection_id = $2)
          AND ($3::uuid IS NULL OR r.upload_id = $3)
          AND ($4::text IS NULL OR r.status = $4)
          AND ($5::timestamptz IS NULL OR r.started_at < $5)
        ORDER BY r.started_at DESC LIMIT $6`,
      [c.workspace.id, qs.connectionId ?? null, qs.uploadId ?? null, qs.status ?? null, qs.before ?? null, limit],
    )).rows as Record<string, any>[];
    const runs = rows.map((r) => ({
      ...toRunSummary(r),
      connectionId: r.connection_id ?? null,
      uploadId: r.upload_id ?? null,
      source: r.source ?? null,
      trigger: r.triggered_by ?? null,
      label: r.connection_label ?? (r.upload_filename ? `업로드 · ${r.upload_filename}` : '삭제된 출처'),
      provider: r.provider ?? (r.upload_id ? 'csv' : null),
      issues: Array.isArray(r.issues) ? r.issues : [],
      stats: r.stats ?? {},
      durationMs: r.finished_at && r.started_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null,
    }));
    return { runs, nextBefore: rows.length === limit ? iso(rows[rows.length - 1].started_at) : null };
  });

  app.get('/w/:ws/ingest/quality', async (req) => {
    const c = await req.workspace('read');
    const ws = c.workspace.id;
    const now = kstParts();
    const yesterday = addDaysStr(now.date, -1);
    const items: QualityItem[] = [];
    const conns = (await db.query<ConnectionRow>('SELECT * FROM connections WHERE workspace_id = $1 ORDER BY priority DESC, created_at', [ws])).rows;
    const byId = new Map(conns.map((x) => [x.id, x]));

    // 커넥션 · 실행 종류(daily · intraday · backfill)별 마지막 '끝난' 실행 + 업로드 실행 — 최근 14일
    // (매시 도는 당일 수집이 07:00 전일 확정 수집의 이슈를 가리지 않게 종류별로 본다)
    const since = new Date(nowMs() - 14 * 86_400_000).toISOString();
    const lastRuns = (await db.query(
      `SELECT DISTINCT ON (connection_id, job) * FROM ingest_runs
        WHERE workspace_id = $1 AND connection_id IS NOT NULL AND upload_id IS NULL AND status <> 'running' AND started_at > $2
        ORDER BY connection_id, job, started_at DESC`, [ws, since],
    )).rows as Record<string, any>[];
    const uploadRuns = (await db.query(
      `SELECT r.*, u.filename FROM ingest_runs r JOIN uploads u ON u.id = r.upload_id
        WHERE r.workspace_id = $1 AND r.status <> 'running' AND r.started_at > $2
        ORDER BY r.started_at DESC LIMIT 20`, [ws, since],
    )).rows as Record<string, any>[];
    for (const r of [...lastRuns, ...uploadRuns]) {
      const conn = r.connection_id ? byId.get(r.connection_id) : undefined;
      const label = r.upload_id ? `업로드 · ${r.filename}` : conn?.label ?? '삭제된 커넥션';
      const base = { runId: r.id as string, connectionId: (r.connection_id as string) ?? null, uploadId: (r.upload_id as string) ?? null, label, provider: conn?.provider ?? (r.upload_id ? 'csv' : null), job: r.job as string, at: iso(r.finished_at ?? r.started_at) };
      if (r.status === 'failed') items.push({ ...base, code: 'run_failed', severity: 'error', message: `마지막 수집 실패: ${String(r.error ?? '사유 미상').slice(0, 300)}` });
      for (const i of (Array.isArray(r.issues) ? r.issues : []) as QualityIssue[]) items.push({ ...base, code: i.code, severity: i.severity, message: i.message, detail: i.detail });
    }

    // 커넥션 상태 · 지연 · 최신 데이터 날짜
    const latest = (await db.query<{ source: string; latest: string }>(
      `SELECT source, max(date)::text AS latest FROM (
         SELECT source, date FROM wh_media_daily WHERE workspace_id = $1 AND date <= $2
         UNION ALL SELECT source, date FROM wh_sales_daily WHERE workspace_id = $1 AND date <= $2) t GROUP BY source`, [ws, now.date],
    )).rows;
    const latestBy = new Map(latest.map((l) => [l.source, l.latest]));
    for (const conn of conns) {
      if (conn.status === 'disabled' || conn.provider === 'csv') continue;
      const base = { runId: null, connectionId: conn.id, uploadId: null, label: conn.label, provider: conn.provider, job: null, at: iso(conn.updated_at) };
      const def = getConnector(conn.provider);
      if (conn.status === 'error') items.push({ ...base, code: 'connection_error', severity: 'error', message: `연결 오류: ${String(conn.last_error ?? '사유 미상').slice(0, 300)}` });
      if (conn.status === 'pending') items.push({ ...base, code: 'not_tested', severity: 'info', message: '연결 확인 전입니다 — 자격증명을 넣고 연결 확인을 눌러 주세요' });
      if (!conn.last_sync_at) {
        if (conn.status !== 'pending') items.push({ ...base, code: 'never_synced', severity: 'info', message: '아직 수집한 적이 없습니다 — 지금 수집 또는 다음 예약(매일 07:00)을 기다리세요' });
        continue;
      }
      const hoursSince = (nowMs() - new Date(conn.last_sync_at).getTime()) / 3_600_000;
      if (hoursSince > STALE_HOURS) items.push({ ...base, code: 'stale_connection', severity: 'warning', message: `마지막 수집이 ${Math.floor(hoursSince)}시간 전입니다 (기준 ${STALE_HOURS}시간) — 예약 수집이 돌지 않았거나 실패했습니다`, detail: { lastSyncAt: iso(conn.last_sync_at) } });
      const l = latestBy.get(sourceKeyOf(conn));
      if ((def?.capabilities.reads.includes('mediaDaily') || def?.capabilities.reads.includes('salesDaily')) && (!l || l < yesterday)) {
        items.push({ ...base, code: 'stale_data', severity: 'warning', message: l ? `최신 일별 데이터가 ${l}입니다 — 어제(${yesterday}) 데이터가 아직 없습니다` : '웨어하우스에 일별 데이터가 없습니다', detail: { latestDate: l ?? null, expected: yesterday } });
      }
    }
    const order = { error: 0, warning: 1, info: 2 } as const;
    items.sort((a, b) => order[a.severity] - order[b.severity] || String(b.at ?? '').localeCompare(String(a.at ?? '')));
    const summary = {
      error: items.filter((i) => i.severity === 'error').length,
      warning: items.filter((i) => i.severity === 'warning').length,
      info: items.filter((i) => i.severity === 'info').length,
      connections: conns.length,
      checkedAt: new Date(nowMs()).toISOString(),
    };
    return { issues: items.slice(0, 200), summary };
  });
};
