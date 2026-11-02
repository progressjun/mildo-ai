/** 워커 시작 — 잡 큐 처리 + 스케줄(KST). `npm run worker:dev` / `node server/dist/worker.mjs` */
import { loadConfig } from './config';
import { createDb } from './db/pool';
import { migrate } from './db/migrate';
import { workLoop } from './jobs/queue';
import { scheduleContext, startScheduler, registeredSchedules } from './jobs/scheduler';
import { registerAllJobs } from './domains';
import { registeredJobTypes } from './jobs/queue';

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { max: 10 });
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(db);
  registerAllJobs();
  console.log(`[worker] ${config.workerId} 잡 ${registeredJobTypes().length}종 · 스케줄 ${registeredSchedules().length}개`);
  const ac = new AbortController();
  const stopScheduler = process.env.SCHEDULER === 'off' ? () => undefined : startScheduler(scheduleContext(db, config));
  const loop = workLoop(db, config, ac.signal, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) });
  const shutdown = async (sig: string) => {
    console.log(`[worker] ${sig} 수신 — 진행 중 잡을 마치고 종료`);
    stopScheduler();
    ac.abort();
    await loop.catch(() => undefined);
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[worker] 시작 실패', e);
  process.exit(1);
});
