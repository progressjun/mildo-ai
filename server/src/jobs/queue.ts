/**
 * DB 잡 큐 — SELECT ... FOR UPDATE SKIP LOCKED로 여러 워커가 안전하게 나눠 처리한다.
 * 실패 시 지수 백오프(1, 2, 4, 8 ... 분) 재시도, max_attempts 초과 시 failed.
 */
import type { Db, Queryable } from '../db/pool';
import type { AppConfig } from '../config';
import { publish, type WsEvent } from '../events/hub';

export interface JobRow {
  id: number;
  type: string;
  workspace_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  run_at: Date;
}

export interface JobContext {
  db: Db;
  config: AppConfig;
  job: JobRow;
  workspaceId: string | null;
  payload: Record<string, unknown>;
  log: (msg: string, extra?: unknown) => void;
  enqueue: (opts: EnqueueOptions) => Promise<number | null>;
  publish: (workspaceId: string, evt: WsEvent) => Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface EnqueueOptions {
  type: string;
  workspaceId?: string | null;
  payload?: Record<string, unknown>;
  /** 지연 실행 */
  runAt?: Date;
  /** 같은 키의 잡이 대기 · 실행 중이면 새로 만들지 않는다 */
  dedupeKey?: string;
  maxAttempts?: number;
}

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  if (handlers.has(type)) throw new Error(`잡 타입 중복 등록: ${type}`);
  handlers.set(type, handler);
}
export const registeredJobTypes = () => [...handlers.keys()];
/** 테스트용: 등록 초기화 */
export function _resetJobsForTest(): void {
  handlers.clear();
}

export async function enqueue(q: Queryable, o: EnqueueOptions): Promise<number | null> {
  const r = await q.query<{ id: number }>(
    `INSERT INTO jobs (type, workspace_id, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [o.type, o.workspaceId ?? null, JSON.stringify(o.payload ?? {}), o.runAt ?? null, o.dedupeKey ?? null, o.maxAttempts ?? 5],
  );
  return r.rows[0]?.id ?? null;
}

/** 오래 잠긴 실행 중 잡(워커 비정상 종료) 회수 */
export async function reclaimStale(q: Queryable, minutes = 15): Promise<number> {
  const r = await q.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, last_error = coalesce(last_error, '') || ' [회수: 잠금 시간 초과]'
      WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [String(minutes)],
  );
  return r.rowCount;
}

export async function claim(q: Queryable, workerId: string, types?: string[]): Promise<JobRow | null> {
  const r = await q.query<JobRow>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now() AND ($2::text[] IS NULL OR type = ANY($2))
         ORDER BY run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, type, workspace_id, payload, attempts, max_attempts, run_at`,
    [workerId, types ?? null],
  );
  return r.rows[0] ?? null;
}

export async function runJob(db: Db, config: AppConfig, job: JobRow, log = (m: string, e?: unknown) => console.log(`[job ${job.id} ${job.type}] ${m}`, e ?? '')): Promise<'done' | 'retry' | 'failed'> {
  const handler = handlers.get(job.type);
  const ctx: JobContext = {
    db,
    config,
    job,
    workspaceId: job.workspace_id,
    payload: job.payload ?? {},
    log,
    enqueue: (o) => enqueue(db, o),
    publish: (ws, evt) => publish(db, ws, evt),
  };
  try {
    if (!handler) throw new Error(`등록되지 않은 잡 타입: ${job.type}`);
    const result = await handler(ctx);
    await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), result = $2, last_error = NULL WHERE id = $1`, [job.id, JSON.stringify(result ?? null)]);
    return 'done';
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (job.attempts >= job.max_attempts || !handler) {
      await db.query(`UPDATE jobs SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1`, [job.id, msg.slice(0, 2000)]);
      log(`실패(최종): ${msg}`);
      return 'failed';
    }
    const backoffMin = Math.min(60, 2 ** (job.attempts - 1));
    await db.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, last_error = $2, run_at = now() + ($3 || ' minutes')::interval WHERE id = $1`,
      [job.id, msg.slice(0, 2000), String(backoffMin)],
    );
    log(`실패 → ${backoffMin}분 뒤 재시도: ${msg}`);
    return 'retry';
  }
}

/** 대기 중인 잡을 모두 처리 (테스트 · CLI 시드 · 단일 프로세스 개발용) */
export async function drain(db: Db, config: AppConfig, opts: { workerId?: string; types?: string[]; max?: number; log?: JobContext['log'] } = {}): Promise<number> {
  let n = 0;
  const max = opts.max ?? 1000;
  while (n < max) {
    const job = await claim(db, opts.workerId ?? 'drain', opts.types);
    if (!job) break;
    await runJob(db, config, job, opts.log ?? (() => undefined));
    n++;
  }
  return n;
}

/** 워커 루프 — signal이 abort될 때까지 */
export async function workLoop(db: Db, config: AppConfig, signal: AbortSignal, opts: { idleMs?: number; concurrency?: number } = {}): Promise<void> {
  const idle = opts.idleMs ?? 2000;
  const lanes = Math.max(1, opts.concurrency ?? 2);
  let lastReclaim = 0;
  const lane = async (i: number) => {
    while (!signal.aborted) {
      try {
        if (i === 0 && Date.now() - lastReclaim > 60_000) {
          lastReclaim = Date.now();
          await reclaimStale(db);
        }
        const job = await claim(db, `${config.workerId}#${i}`);
        if (!job) {
          await new Promise((r) => setTimeout(r, idle));
          continue;
        }
        await runJob(db, config, job);
      } catch (e) {
        console.error('[worker] loop error', (e as Error).message);
        await new Promise((r) => setTimeout(r, idle));
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
}
