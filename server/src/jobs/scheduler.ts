/**
 * 스케줄 — 워커 프로세스에서 croner로 실행(Asia/Seoul). 스케줄 함수는 보통 워크스페이스마다 잡을 enqueue한다.
 * 같은 스케줄이 여러 워커에서 돌 수 있으므로 enqueue 시 dedupeKey(예: `ingest.daily:<ws>:<date>`)를 쓴다.
 */
import { Cron } from 'croner';
import type { Db } from '../db/pool';
import type { AppConfig } from '../config';

export interface ScheduleContext {
  db: Db;
  config: AppConfig;
  /** 활성 워크스페이스 id 목록 */
  activeWorkspaces: () => Promise<{ id: string; slug: string }[]>;
}
export type ScheduleFn = (ctx: ScheduleContext) => Promise<void>;

interface ScheduleDef { name: string; cron: string; fn: ScheduleFn }
const schedules: ScheduleDef[] = [];

export function registerSchedule(name: string, cron: string, fn: ScheduleFn): void {
  if (schedules.some((s) => s.name === name)) throw new Error(`스케줄 이름 중복: ${name}`);
  // 형식 검사(잘못된 cron은 등록 시점에 실패)
  new Cron(cron, { timezone: 'Asia/Seoul', paused: true }).stop();
  schedules.push({ name, cron, fn });
}
export const registeredSchedules = () => schedules.map((s) => ({ name: s.name, cron: s.cron }));
export function _resetSchedulesForTest(): void {
  schedules.length = 0;
}

export function scheduleContext(db: Db, config: AppConfig): ScheduleContext {
  return {
    db,
    config,
    activeWorkspaces: async () => (await db.query<{ id: string; slug: string }>(`SELECT id, slug FROM workspaces WHERE status = 'active' ORDER BY created_at`)).rows,
  };
}

/** 이름으로 즉시 실행 (테스트 · 운영 수동 실행) */
export async function runScheduleNow(name: string, ctx: ScheduleContext): Promise<void> {
  const s = schedules.find((x) => x.name === name);
  if (!s) throw new Error(`스케줄 없음: ${name}`);
  await s.fn(ctx);
}

export function startScheduler(ctx: ScheduleContext): () => void {
  const jobs = schedules.map(
    (s) =>
      new Cron(s.cron, { timezone: 'Asia/Seoul', protect: true, catch: (e) => console.error(`[schedule ${s.name}]`, (e as Error).message) }, async () => {
        await s.fn(ctx);
      }),
  );
  return () => jobs.forEach((j) => j.stop());
}
