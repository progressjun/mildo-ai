/**
 * 수집 잡 · 스케줄 (docs/SAAS_SPEC.md §6 잡 타입 계약)
 *   ingest.daily     { connectionId?, trigger? }            어제 포함 3일 재수집 (connectionId 없으면 워크스페이스의 모든 대상 커넥션)
 *   ingest.intraday  { connectionId?, trigger? }            오늘 시간대 + 캠페인 오늘 소진 (intraday 지원 커넥터만)
 *   ingest.backfill  { connectionId, days? | from?, to? }   31일 묶음, maxBackfillDays · 400일 상한
 *   ingest.upload    { uploadId }                           CSV 업로드 가져오기
 * 스케줄(KST): 매일 07:00 ingest.daily · 매시 10분 ingest.intraday — 활성 워크스페이스의 대상 커넥션마다 하나씩(dedupe).
 * 대상 커넥션: 상태 active · error(일시 오류 재시도), CSV 제외. 수동 요청(trigger=manual)은 연결 확인 전(pending)도 허용.
 */
import type { Db } from '../db/pool';
import type { AppConfig } from '../config';
import type { JobRegistry } from '../domains';
import type { JobContext } from '../jobs/queue';
import { enqueue } from '../jobs/queue';
import { getConnector } from '../connectors/registry';
import { loadConnection, type ConnectionRow } from '../connectors/service';
import { kstParts } from '../lib/time';
import { backfillConnection, backfillRange, dailyRange, importUpload, ingestConnection, type IngestRunResult } from './pipeline';

const SCHEDULED_STATUSES = ['active', 'error'];

function eligible(conn: ConnectionRow, kind: 'daily' | 'intraday' | 'backfill', manual: boolean): string | null {
  const def = getConnector(conn.provider);
  if (!def) return `알 수 없는 공급자 ${conn.provider}`;
  if (conn.provider === 'csv') return 'CSV 커넥션은 업로드로 수집합니다';
  if (conn.status === 'disabled') return '사용 중지된 커넥션';
  if (!manual && !SCHEDULED_STATUSES.includes(conn.status) && kind !== 'backfill') return `상태 ${conn.status} — 연결 확인 후 수집합니다`;
  if (kind === 'intraday' && !def.capabilities.intraday) return '당일 시간대 수집 미지원 커넥터';
  if (!def.capabilities.reads.length) return '수집 항목이 없는 커넥터 (구현 중)';
  return null;
}

async function targets(db: Db, ctx: JobContext): Promise<ConnectionRow[]> {
  const wsId = ctx.workspaceId;
  if (!wsId) throw new Error('워크스페이스가 없는 수집 잡');
  const id = typeof ctx.payload.connectionId === 'string' ? ctx.payload.connectionId : null;
  if (id) {
    const c = await loadConnection(db, wsId, id);
    return c ? [c] : [];
  }
  return (await db.query<ConnectionRow>(`SELECT * FROM connections WHERE workspace_id = $1 ORDER BY priority DESC`, [wsId])).rows;
}

type Summary = { connectionId: string; skipped?: string; runs?: Pick<IngestRunResult, 'runId' | 'status' | 'rowsIn' | 'rowsWritten'>[]; error?: string };
const brief = (r: IngestRunResult) => ({ runId: r.runId, status: r.status, rowsIn: r.rowsIn, rowsWritten: r.rowsWritten });

/** 커넥션마다 실행하고, 하나라도 실패하면 마지막에 던져 잡을 재시도시킨다(성공한 커넥션은 멱등이라 다시 돌아도 안전) */
async function forEachConn(db: Db, ctx: JobContext, kind: 'daily' | 'intraday', run: (c: ConnectionRow) => Promise<IngestRunResult[]>): Promise<{ results: Summary[] }> {
  const manual = ctx.payload.trigger === 'manual';
  const list = await targets(db, ctx);
  const results: Summary[] = [];
  const errors: string[] = [];
  for (const c of list) {
    const why = eligible(c, kind, manual);
    if (why) { results.push({ connectionId: c.id, skipped: why }); continue; }
    try {
      results.push({ connectionId: c.id, runs: (await run(c)).map(brief) });
    } catch (e) {
      const msg = (e as Error).message;
      results.push({ connectionId: c.id, error: msg });
      errors.push(`${c.label}: ${msg}`);
    }
  }
  if (errors.length) throw new Error(`수집 실패 ${errors.length}건 — ${errors.join(' / ').slice(0, 1500)}`);
  return { results };
}

export function registerIngestJobs(reg: JobRegistry): void {
  reg.job('ingest.daily', async (ctx) => {
    const today = kstParts().date;
    return forEachConn(ctx.db, ctx, 'daily', async (c) => [await ingestConnection(ctx.db, ctx.config, c, { job: 'daily', range: dailyRange(today), trigger: String(ctx.payload.trigger ?? 'schedule'), log: ctx.log })]);
  });

  reg.job('ingest.intraday', async (ctx) => {
    const today = kstParts().date;
    return forEachConn(ctx.db, ctx, 'intraday', async (c) => [await ingestConnection(ctx.db, ctx.config, c, { job: 'intraday', range: { from: today, to: today }, intradayDate: today, trigger: String(ctx.payload.trigger ?? 'schedule'), log: ctx.log })]);
  });

  reg.job('ingest.backfill', async (ctx) => {
    const list = await targets(ctx.db, ctx);
    const c = list[0];
    if (!c || typeof ctx.payload.connectionId !== 'string') return { skipped: '커넥션 없음 (삭제됨)' };
    const why = eligible(c, 'backfill', true);
    if (why) return { connectionId: c.id, skipped: why };
    const def = getConnector(c.provider)!;
    const today = kstParts().date;
    const range = backfillRange(today, def.capabilities.maxBackfillDays, {
      days: typeof ctx.payload.days === 'number' ? ctx.payload.days : undefined,
      from: typeof ctx.payload.from === 'string' ? ctx.payload.from : undefined,
      to: typeof ctx.payload.to === 'string' ? ctx.payload.to : undefined,
    });
    const runs = await backfillConnection(ctx.db, ctx.config, c, range, { trigger: String(ctx.payload.trigger ?? 'initial'), log: ctx.log });
    return { connectionId: c.id, range, runs: runs.map(brief) };
  });

  reg.job('ingest.upload', async (ctx) => {
    const id = typeof ctx.payload.uploadId === 'string' ? ctx.payload.uploadId : null;
    if (!id) return { skipped: 'uploadId 없음' };
    const r = await importUpload(ctx.db, id, { trigger: 'upload', finalAttempt: ctx.job.attempts >= ctx.job.max_attempts });
    return brief(r);
  });

  reg.schedule('ingest.daily', '0 7 * * *', async (s) => {
    await enqueueScheduled(s.db, 'ingest.daily');
  });
  reg.schedule('ingest.intraday', '10 * * * *', async (s) => {
    await enqueueScheduled(s.db, 'ingest.intraday');
  });
}

/** 스케줄: 활성 워크스페이스의 대상 커넥션마다 잡 하나 (같은 날 · 같은 시각 중복 방지) */
export async function enqueueScheduled(db: Db, type: 'ingest.daily' | 'ingest.intraday'): Promise<number> {
  const p = kstParts();
  const rows = (await db.query<ConnectionRow>(
    `SELECT c.* FROM connections c JOIN workspaces w ON w.id = c.workspace_id
      WHERE w.status = 'active' AND c.status = ANY($1::text[]) AND c.provider <> 'csv' ORDER BY w.created_at, c.priority DESC`,
    [SCHEDULED_STATUSES],
  )).rows;
  let n = 0;
  for (const c of rows) {
    if (eligible(c, type === 'ingest.daily' ? 'daily' : 'intraday', false)) continue;
    const key = type === 'ingest.daily' ? `ingest.daily:${c.id}:${p.date}` : `ingest.intraday:${c.id}:${p.date}T${p.hour}`;
    const id = await enqueue(db, { type, workspaceId: c.workspace_id, payload: { connectionId: c.id, trigger: 'schedule' }, dedupeKey: key });
    if (id !== null) n++;
  }
  return n;
}

export type { AppConfig };
