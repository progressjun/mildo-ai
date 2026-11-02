/**
 * 테스트 앱: 임시 스키마 DB + Fastify(inject) + 역할별 시드 사용자 + 로그인된 HTTP 클라이언트(쿠키 · CSRF 자동).
 *
 *   const t = await createTestApp();
 *   const pm = await t.login('pm');            // 'owner' | 'admin' | 'pm' | 'ae' | 'client' | 'viewer'
 *   const r = await pm.get(`/api/w/${t.ws}`);  // { status, json, headers }
 *   await pm.post(`/api/w/${t.ws}/...`, body);
 *   afterAll(() => t.close());
 */
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config';
import { EventHub } from '../src/events/hub';
import { buildApp } from '../src/http/app';
import { seed } from '../src/db/seed';
import { createTestDb, type TestDb } from './db';
import type { Db } from '../src/db/pool';
import type { Role } from '../src/auth/permissions';

export const TEST_PASSWORD = 'TestPass#2027';
export const ROLE_EMAIL: Record<Role, string> = {
  owner: 'owner@test.local', admin: 'admin@test.local', pm: 'pm@test.local', ae: 'ae@test.local', client: 'client@test.local', viewer: 'viewer@test.local',
};

export interface TestResponse<T = any> { status: number; json: T; headers: Record<string, unknown>; body: string }
export interface TestClient {
  email: string;
  get<T = any>(url: string): Promise<TestResponse<T>>;
  post<T = any>(url: string, body?: unknown): Promise<TestResponse<T>>;
  put<T = any>(url: string, body?: unknown): Promise<TestResponse<T>>;
  patch<T = any>(url: string, body?: unknown): Promise<TestResponse<T>>;
  del<T = any>(url: string): Promise<TestResponse<T>>;
  /** 원시 요청 (헤더 · 페이로드 직접) */
  raw<T = any>(o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<TestResponse<T>>;
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  events: EventHub;
  testDb: TestDb;
  /** 시드 워크스페이스 id */
  ws: string;
  orgId: string;
  userIds: Record<Role, string>;
  login(role: Role | string, password?: string): Promise<TestClient>;
  anon(): TestClient;
  close(): Promise<void>;
}

export async function createTestApp(opts: { config?: Partial<AppConfig>; demoData?: boolean } = {}): Promise<TestApp> {
  const testDb = await createTestDb();
  const config = loadConfig({ databaseUrl: 'test', staticDir: null, logLevel: 'silent', ...opts.config });
  const events = new EventHub(testDb.db);
  await events.start();
  const app = await buildApp({ db: testDb.db, config, events });
  await app.ready();
  const roles = Object.keys(ROLE_EMAIL) as Role[];
  const s = await seed(testDb.db, {
    users: roles.map((r) => ({ email: ROLE_EMAIL[r], name: `테스트 ${r}`, password: TEST_PASSWORD, role: r })),
    demoData: opts.demoData ?? false,
  });
  const userIds = Object.fromEntries(roles.map((r) => [r, s.users[ROLE_EMAIL[r]]])) as Record<Role, string>;

  const makeClient = (email: string, cookies: Record<string, string>): TestClient => {
    const send = async <T,>(o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<TestResponse<T>> => {
      const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await app.inject({
        method: o.method as 'GET',
        url: o.url,
        payload: o.payload as never,
        headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...(cookies.mildo_csrf ? { 'x-csrf-token': cookies.mildo_csrf } : {}), ...(o.headers ?? {}) },
      });
      for (const c of res.cookies) {
        if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) delete cookies[c.name];
        else cookies[c.name] = c.value;
      }
      let json: unknown = null;
      try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
      return { status: res.statusCode, json: json as T, headers: res.headers as Record<string, unknown>, body: res.body };
    };
    return {
      email,
      get: (url) => send({ method: 'GET', url }),
      post: (url, body) => send({ method: 'POST', url, payload: body ?? {} }),
      put: (url, body) => send({ method: 'PUT', url, payload: body ?? {} }),
      patch: (url, body) => send({ method: 'PATCH', url, payload: body ?? {} }),
      del: (url) => send({ method: 'DELETE', url }),
      raw: (o) => send(o),
    };
  };

  return {
    app, db: testDb.db, config, events, testDb, ws: s.workspaceId, orgId: s.orgId, userIds,
    async login(role, password = TEST_PASSWORD) {
      const email = (ROLE_EMAIL as Record<string, string>)[role] ?? role;
      const cookies: Record<string, string> = {};
      const c = makeClient(email, cookies);
      const r = await c.post('/api/auth/login', { email, password });
      if (r.status !== 200) throw new Error(`로그인 실패 ${email}: ${r.status} ${r.body}`);
      return c;
    },
    anon: () => makeClient('anon', {}),
    async close() {
      await app.close();
      await events.stop();
      await testDb.dispose();
    },
  };
}
