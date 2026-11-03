/**
 * 마이그레이션 러너 — server/migrations/*.sql을 파일명 순서로 한 번씩 적용한다(트랜잭션 단위).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool';

export function migrationsDir(): string {
  // 번들(server/dist/*.mjs)과 소스(server/src/db/*.ts) 양쪽에서 server/migrations를 찾는다
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../../migrations'), join(here, '../migrations'), join(process.cwd(), 'server/migrations')];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error('server/migrations 폴더를 찾지 못했습니다');
}

export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  // 앱 · 워커 · migrate 명령이 동시에 시작해도 같은 파일을 두 번 적용하지 않도록 스키마 단위 advisory lock
  const lock = await db.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('mildo_migrate:' || current_schema()))");
    return await migrateLocked(db, dir);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('mildo_migrate:' || current_schema()))").catch(() => undefined);
    lock.release();
  }
}

async function migrateLocked(db: Db, dir: string): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.tx(async (q) => {
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
