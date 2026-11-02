import { defineConfig } from 'vitest/config';
import path from 'node:path';

// 서버 테스트 — 실제 PostgreSQL(TEST_DATABASE_URL, 기본: 로컬 소켓 /tmp:55432). 테스트 파일마다 임시 스키마.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test' },
    globalSetup: ['server/test/global-setup.ts'],
  },
});
