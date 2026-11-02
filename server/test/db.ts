/**
 * 테스트 DB: 테스트 파일마다 임시 스키마(t_<랜덤>)를 만들고 마이그레이션을 적용한다. afterAll에서 dispose()로 지운다.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createDb, type Db } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { TEST_DB_URL } from './global-setup';

export interface TestDb { db: Db; schema: string; dispose: () => Promise<void> }

export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = createDb(TEST_DB_URL, { searchPath: schema, max: 5 });
  await migrate(db);
  return {
    db,
    schema,
    dispose: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: TEST_DB_URL });
      await a.connect();
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}
