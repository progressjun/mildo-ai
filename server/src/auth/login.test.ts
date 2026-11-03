/**
 * 로그인 속도 제한 · 잠금 순서 (운영 기본값 LOGIN_FAIL_MAX=10 · 로그인 라우트 IP당 분당 10회).
 *  - 같은 이메일로 10회 실패한 다음 시도는 라우트 속도 제한(rate_limited)이 아니라 잠금 안내(login_locked, 대기 시간)를 받는다
 *  - 잠금 감사 기록에 가입 계정의 user_id가 남아 워크스페이스 감사 로그(auth=1)에 보인다
 *  - 라우트 속도 제한 429 문구에도 대기 시간(초)이 실린다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../../test/app';
import { rateLimitedError } from '../http/app';

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let t: TestApp;
beforeAll(async () => {
  // NODE_ENV=test는 잠금이 꺼져 있다 — 운영 기본값(10회 · 15분)으로 켠다
  t = await withEnv({ LOGIN_FAIL_MAX: '10', LOGIN_FAIL_WINDOW_MIN: '15' }, () => createTestApp());
});
afterAll(async () => {
  await t.close();
});

const loginFrom = (ip: string, email: string, password: string) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-forwarded-for': ip } });

describe('로그인 실패 반복', () => {
  it('같은 IP에서 10회 실패한 다음 시도는 잠금 안내(login_locked · 대기 시간)를 받는다 — 일반 속도 제한 문구가 아니다', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 10; i++) {
      const r = await loginFrom(ip, 'client@test.local', 'Wrong#Pass123');
      expect(r.statusCode, `시도 ${i + 1}`).toBe(401);
    }
    const r = await loginFrom(ip, 'client@test.local', 'Wrong#Pass123');
    expect(r.statusCode).toBe(429);
    const body = r.json() as { error: { code: string; message: string; detail?: { retryAfterSec?: number } } };
    expect(body.error.code).toBe('login_locked');
    expect(body.error.message).toMatch(/약 \d+분 뒤 다시 시도하거나 비밀번호 재설정/);
    expect(body.error.detail?.retryAfterSec).toBeGreaterThan(0);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('잠금 감사 기록에는 가입 계정의 user_id가 남고, 워크스페이스 감사 로그(auth=1)에 보인다', async () => {
    const rows = await t.db.query<{ user_id: string | null }>(`SELECT user_id FROM audit_log WHERE action = 'auth.login_locked' AND lower(actor) = 'client@test.local'`);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((x) => x.user_id === t.userIds.client)).toBe(true);
    const owner = await t.login('owner');
    const r = await owner.get(`/api/w/${t.ws}/audit?auth=1&action=auth.login_`);
    expect(r.status).toBe(200);
    const actions = (r.json.entries as Array<{ action: string; actor: string }>).filter((e) => e.actor.toLowerCase() === 'client@test.local').map((e) => e.action);
    expect(actions).toContain('auth.login_locked');
    expect(actions.filter((a) => a === 'auth.login_failed')).toHaveLength(10);
  });

  it('가입되지 않은 이메일의 잠금 기록은 user_id 없이 남는다 (계정 존재 여부와 무관하게 같은 응답)', async () => {
    const ip = '203.0.113.78';
    for (let i = 0; i < 10; i++) expect((await loginFrom(ip, 'nobody@test.local', 'Wrong#Pass123')).statusCode).toBe(401);
    const r = await loginFrom(ip, 'nobody@test.local', 'Wrong#Pass123');
    expect(r.statusCode).toBe(429);
    expect((r.json() as { error: { code: string } }).error.code).toBe('login_locked');
    const rows = await t.db.query<{ user_id: string | null }>(`SELECT user_id FROM audit_log WHERE action = 'auth.login_locked' AND actor = 'nobody@test.local'`);
    expect(rows.rows.map((x) => x.user_id)).toEqual([null]);
  });

  it('여러 이메일로 IP당 분당 10회를 넘기면 라우트 속도 제한 — 로그인 전용 문구에 대기 시간(초)이 실린다', async () => {
    const ip = '203.0.113.79';
    for (let i = 0; i < 10; i++) expect((await loginFrom(ip, `spray${i}@test.local`, 'Wrong#Pass123')).statusCode).toBe(401);
    const r = await loginFrom(ip, 'owner@test.local', TEST_PASSWORD);
    expect(r.statusCode).toBe(429);
    const body = r.json() as { error: { code: string; message: string; detail?: { retryAfterSec?: number } } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toMatch(/^로그인 시도가 너무 많습니다\. \d+초 후 다시 시도해 주세요$/);
    expect(body.error.detail?.retryAfterSec).toBe(Number(r.headers['retry-after']));
  });
});

describe('rateLimitedError', () => {
  it('retry-after가 있으면 초 단위 대기 시간, 없으면 잠시 후', () => {
    expect(rateLimitedError('/api/w/x/ai/messages', '42').message).toBe('요청이 너무 많습니다. 42초 후 다시 시도해 주세요');
    expect(rateLimitedError('/api/auth/login?x=1', 7)).toEqual({ code: 'rate_limited', message: '로그인 시도가 너무 많습니다. 7초 후 다시 시도해 주세요', detail: { retryAfterSec: 7 } });
    expect(rateLimitedError('/api/x', undefined)).toEqual({ code: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요' });
  });
});
