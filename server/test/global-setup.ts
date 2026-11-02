/** 서버 테스트 전역 준비: 테스트 DB 존재 확인 (없으면 생성) */
import pg from 'pg';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mildo@/mildo_test?host=/tmp&port=55432';

export default async function setup(): Promise<void> {
  // postgres://user@/dbname?host=... 형식(호스트 생략)도 처리
  const dbName = (TEST_DB_URL.match(/\/([A-Za-z0-9_]+)(\?|$)/)?.[1]) ?? 'mildo_test';
  const admin = new pg.Client({ connectionString: TEST_DB_URL.replace(`/${dbName}`, '/postgres') });
  await admin.connect();
  const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!r.rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
}
