/**
 * team 서버 테스트 공용 — 로그인 속도 제한(IP당 분당 10회)에 걸리지 않게 요청마다 다른 IP(x-forwarded-for)로 로그인한다.
 */
import type { TestApp, TestClient } from '../../test/app';
import { TEST_PASSWORD, ROLE_EMAIL } from '../../test/app';
import type { Role } from '../auth/permissions';
import { seed } from '../db/seed';

let n = 0;
export const nextIp = () => {
  n++;
  return `10.${70 + Math.floor(n / 60000)}.${Math.floor(n / 250) % 240}.${(n % 250) + 1}`;
};

export async function loginAs(t: TestApp, email: string, password = TEST_PASSWORD): Promise<{ client: TestClient; status: number; json: any }> {
  const client = t.anon();
  const r = await client.raw({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-forwarded-for': nextIp() } });
  return { client, status: r.status, json: r.json };
}

export async function login(t: TestApp, who: Role | string, password = TEST_PASSWORD): Promise<TestClient> {
  const email = (ROLE_EMAIL as Record<string, string>)[who] ?? who;
  const r = await loginAs(t, email, password);
  if (r.status !== 200) throw new Error(`로그인 실패 ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.client;
}

/** 시드 워크스페이스(slug 'mildo')에 사용자 추가 */
export async function addUser(t: TestApp, email: string, role: Role, name = email.split('@')[0]): Promise<string> {
  const r = await seed(t.db, { users: [{ email, name, password: TEST_PASSWORD, role }] });
  return r.users[email];
}

/** 다른 조직 · 워크스페이스 + 그 안의 사용자 */
export async function otherWorkspace(t: TestApp, slug: string, users: { email: string; role: Role; name?: string }[]): Promise<{ ws: string; users: Record<string, string> }> {
  const r = await seed(t.db, {
    slug, brand: `브랜드-${slug}`, orgName: `조직-${slug}`,
    users: users.map((u) => ({ email: u.email, name: u.name ?? u.email.split('@')[0], password: TEST_PASSWORD, role: u.role })),
  });
  return { ws: r.workspaceId, users: r.users };
}

export const tokenOf = (link: string, key: 'invite' | 'reset') => new URL(link).searchParams.get(key) ?? '';
/** 메일 본문에서 링크 추출 */
export function linkIn(text: string, key: 'invite' | 'reset'): string | null {
  const m = text.match(new RegExp(`https?://\\S+/\\?${key}=[A-Za-z0-9_%-]+`));
  return m ? m[0] : null;
}

/** 다른 IP에서 보낸 쓰기 요청 (공개 엔드포인트 속도 제한 회피) */
export function postFrom<T = any>(c: TestClient, url: string, body: unknown = {}, ip = nextIp()) {
  return c.raw<T>({ method: 'POST', url, payload: body, headers: { 'x-forwarded-for': ip } });
}
export function getFrom<T = any>(c: TestClient, url: string, ip = nextIp()) {
  return c.raw<T>({ method: 'GET', url, headers: { 'x-forwarded-for': ip } });
}
/** POST /api/invites/:token/accept (요청마다 다른 IP) */
export const acceptVia = (c: TestClient, token: string, body: unknown = {}) => postFrom(c, `/api/invites/${token}/accept`, body);
