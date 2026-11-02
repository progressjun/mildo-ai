/** API 서버 시작 — `npm run server:dev` (개발) / `node server/dist/index.mjs` (배포) */
import { loadConfig } from './config';
import { createDb } from './db/pool';
import { migrate } from './db/migrate';
import { EventHub } from './events/hub';
import { buildApp } from './http/app';

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { max: 20 });
  if (process.env.MIGRATE_ON_START !== 'false') {
    const applied = await migrate(db);
    if (applied.length) console.log(`[migrate] 적용: ${applied.join(', ')}`);
  }
  const events = new EventHub(db);
  await events.start();
  const app = await buildApp({ db, config, events }, { logger: true });
  await app.listen({ port: config.port, host: config.host });
  const shutdown = async (sig: string) => {
    console.log(`[server] ${sig} 수신 — 종료 중`);
    try {
      await app.close();
      await events.stop();
      await db.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[server] 시작 실패', e);
  process.exit(1);
});
