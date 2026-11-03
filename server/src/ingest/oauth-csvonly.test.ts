/**
 * 카페24 OAuth 인증 코드 흐름(connectors/oauth.ts, ingest/index.ts에서 등록) · CSV 전용 공급자(오늘의집) 커넥션 거절 · 카탈로그 선택 필드.
 *
 *   POST /api/w/:ws/connections/:id/oauth/cafe24/start   configure — { url } (cafe24AuthorizeUrl, redirect_uri = APP_URL/api/oauth/cafe24/callback, 서명된 state)
 *   GET  /api/oauth/cafe24/callback?code&state           state 검증(위조 · 만료 · 재사용 · 다른 워크스페이스) → 코드 교환 → 저장 · 감사 · 이벤트 → 302
 * 네트워크 없음 — 카페24 토큰 엔드포인트는 문서 형식의 가짜 서버(cafe24/fixtures.ts)를 기본 fetch로 끼운다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { setDefaultConnectorFetch } from '../connectors/http';
import { decryptCredentials, encryptCredentials } from '../connectors/credentials';
import { newOAuthState, OAUTH_STATE_TTL_MS, signOAuthState, verifyOAuthState } from '../connectors/oauth';
import { _resetCafe24InflightForTest } from '../connectors/cafe24/client';
import { CAFE24_CREDS, cafe24Handler, cafe24State } from '../connectors/cafe24/fixtures';
import { handlerFetch } from '../connectors/naver-commerce/sales-testkit';
import { csvGuide } from '../connectors/ohouse';
import { nowMs, setNowForTest } from '../lib/time';
import { drainIngest, registerDataJobsForTest } from './testkit';

let t: TestApp;
let st = cafe24State();
const APP = { mallId: CAFE24_CREDS.mallId, clientId: CAFE24_CREDS.clientId, clientSecret: CAFE24_CREDS.clientSecret };

beforeAll(async () => {
  setDefaultConnectorFetch(handlerFetch((r) => cafe24Handler(st)(r)));
  registerDataJobsForTest();
  t = await createTestApp();
});
afterAll(async () => {
  setDefaultConnectorFetch(null);
  setNowForTest(null);
  await t?.close();
});
beforeEach(() => {
  st = cafe24State();
  _resetCafe24InflightForTest();
  setNowForTest(null);
});

// 로그인은 분당 10회 제한 — 역할마다 한 번만 로그인해 재사용한다
const clients = new Map<string, Promise<TestClient>>();
const as = (role: 'owner' | 'admin' | 'pm' | 'ae' | 'viewer') => {
  if (!clients.has(role)) clients.set(role, t.login(role));
  return clients.get(role)!;
};
const base = () => `/api/w/${t.ws}/connections`;
const callbackUri = () => `${t.config.appUrl}/api/oauth/cafe24/callback`;

/** 앱 정보(쇼핑몰 ID · Client ID · Client Secret)만으로 카페24 커넥션 만들기 → 승인 대기(pending) */
async function cafe24Conn(label = '카페24 자사몰'): Promise<string> {
  const r = await (await as('pm')).post(base(), { provider: 'cafe24', label, credentials: APP });
  expect(r.status, r.body).toBe(200);
  return r.json.connection.id as string;
}
async function start(c: TestClient, id: string, ws = t.ws) {
  return c.post(`/api/w/${ws}/connections/${id}/oauth/cafe24/start`, {});
}
async function startState(id: string): Promise<string> {
  const r = await start(await as('pm'), id);
  expect(r.status, r.body).toBe(200);
  return new URL(r.json.url).searchParams.get('state')!;
}
const callback = (c: TestClient, q: Record<string, string>) => c.get(`/api/oauth/cafe24/callback?${new URLSearchParams(q).toString()}`);
const errorOf = (r: { status: number; headers: Record<string, unknown> }) => {
  expect(r.status).toBe(302);
  const loc = new URL(String(r.headers.location));
  expect(loc.hash).toBe('#connections');
  return loc.searchParams.get('oauth_error');
};
const credsOf = async (id: string) => {
  const row = (await t.db.query<{ credentials_enc: string; status: string; last_error: string | null }>('SELECT credentials_enc, status, last_error FROM connections WHERE id = $1', [id])).rows[0];
  return { creds: decryptCredentials<Record<string, unknown>>(row.credentials_enc, t.config.encryptionKey), status: row.status, lastError: row.last_error };
};
const oauthAudits = async (id: string) => (await t.db.query<{ detail: Record<string, unknown>; user_id: string | null }>(
  `SELECT detail, user_id FROM audit_log WHERE action = 'connection.oauth' AND target_id = $1 ORDER BY id`, [id],
)).rows;

describe('카페24 인증 시작', () => {
  it('앱 정보만으로 커넥션을 만들 수 있고(승인 대기), 연결 확인은 인증 시작 버튼을 안내한다', async () => {
    const id = await cafe24Conn();
    const v = await credsOf(id);
    expect(v.status).toBe('pending');
    expect(v.creds).toEqual(APP);
    const r = await (await as('pm')).post(`${base()}/${id}/test`);
    expect(r.status).toBe(200);
    expect(r.json.result.ok).toBe(false);
    expect(r.json.result.message).toContain("'카페24 인증 시작'");
    expect(st.tokenCalls).toHaveLength(0);
    // 승인 전 수동 수집: 토큰 필드 오류가 아니라 같은 인증 시작 안내로 실패한다 (토큰 엔드포인트 호출 없음)
    expect((await (await as('ae')).post(`${base()}/${id}/sync`)).status).toBe(200);
    await drainIngest(t.db, t.config);
    const run = (await t.db.query<{ status: string; error: string }>(`SELECT status, error FROM ingest_runs WHERE connection_id = $1 ORDER BY started_at DESC LIMIT 1`, [id])).rows[0];
    expect(run.status).toBe('failed');
    expect(run.error).toBe(r.json.result.message);
    expect(st.tokenCalls).toHaveLength(0);
    // 앱 정보가 틀리면(쇼핑몰 ID 형식) 승인 대기로도 받지 않는다
    const bad = await (await as('pm')).post(base(), { provider: 'cafe24', credentials: { ...APP, mallId: 'bad.host/x' } });
    expect(bad.status).toBe(400);
  });

  it('configure(pm 이상)만: ae · viewer 403, 응답 url은 문서 형식(cafe24AuthorizeUrl) · 콜백 주소 · 서명된 state(워크스페이스 · 커넥션 · 사용자 · nonce · 10분)', async () => {
    const id = await cafe24Conn();
    expect((await start(await as('ae'), id)).status).toBe(403);
    expect((await start(await as('viewer'), id)).status).toBe(403);
    expect((await start(t.anon(), id)).status).toBe(401);
    const r = await start(await as('pm'), id);
    expect(r.status).toBe(200);
    const u = new URL(r.json.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://mildomall.cafe24api.com/api/v2/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CAFE24_CREDS.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(callbackUri());
    expect(u.searchParams.get('scope')).toContain('mall.read_order');
    const state = u.searchParams.get('state')!;
    const v = verifyOAuthState(t.config.sessionSecret, state, nowMs());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.state).toMatchObject({ ws: t.ws, cid: id, uid: t.userIds.pm });
      expect(v.state.n.length).toBeGreaterThanOrEqual(16);
      expect(v.state.exp - nowMs()).toBeGreaterThan(OAUTH_STATE_TTL_MS - 5_000);
      expect(v.state.exp - nowMs()).toBeLessThanOrEqual(OAUTH_STATE_TTL_MS);
    }
    // 응답 · state에 비밀값이 없다
    expect(r.body).not.toContain(CAFE24_CREDS.clientSecret);
    expect(Buffer.from(state.split('.')[0], 'base64url').toString('utf8')).not.toContain(CAFE24_CREDS.clientSecret);
    // 시작만으로는 토큰 엔드포인트를 부르지 않는다
    expect(st.tokenCalls).toHaveLength(0);
  });

  it('카페24가 아닌 커넥션 400, 다른 워크스페이스 커넥션 · 멤버가 아닌 워크스페이스 404', async () => {
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'oauth-other', '다른 브랜드', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    const foreign = (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, credentials_enc) VALUES ($1, 'cafe24', 'sales', 'own_mall', '남의 카페24', $2) RETURNING id`,
      [other, encryptCredentials(APP, t.config.encryptionKey)],
    )).rows[0].id;
    const owner = await as('owner');
    expect((await start(owner, foreign)).status).toBe(404);
    expect((await start(owner, foreign, other)).status).toBe(404);
    const demo = await owner.post(base(), { provider: 'demo' });
    const demoId = demo.json.connection?.id ?? (await t.db.query<{ id: string }>(`SELECT id FROM connections WHERE workspace_id = $1 AND provider = 'demo'`, [t.ws])).rows[0].id;
    const r = await start(owner, demoId);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('oauth_unsupported');
  });
});

describe('카페24 콜백', () => {
  it('정상: 인증 코드를 바로 교환(문서 형식 · 같은 redirect_uri) → 토큰 암호화 저장 · 상태 pending · 감사(값 없음) · connection 이벤트 → #connections', async () => {
    const id = await cafe24Conn();
    const state = await startState(id);
    st.authCode = 'cb-code-0001';
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => { if (e.type === 'connection' && e.id === id) got.push(e.type); });
    const r = await callback(t.anon(), { code: 'cb-code-0001', state });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`${t.config.appUrl}/#connections`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(st.tokenCalls.map((c) => c.body)).toEqual([{ grant_type: 'authorization_code', code: 'cb-code-0001', redirect_uri: callbackUri() }]);
    expect(st.tokenCalls[0].auth).toBe(`Basic ${Buffer.from(`${CAFE24_CREDS.clientId}:${CAFE24_CREDS.clientSecret}`).toString('base64')}`);
    const v = await credsOf(id);
    expect(v.creds).toMatchObject({ ...APP, accessToken: 'c24-access-1001', refreshToken: 'c24-refresh-1001', redirectUri: callbackUri() });
    expect(v.creds).not.toHaveProperty('authCode');
    expect(v.status).toBe('pending');
    expect(v.lastError).toBeNull();
    const audits = await oauthAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(t.userIds.pm);
    expect(audits[0].detail).toMatchObject({ provider: 'cafe24', ok: true });
    const allAudit = JSON.stringify((await t.db.query(`SELECT detail FROM audit_log WHERE target_id = $1`, [id])).rows);
    for (const secret of ['c24-access-1001', 'c24-refresh-1001', CAFE24_CREDS.clientSecret, 'cb-code-0001']) expect(allAudit).not.toContain(secret);
    for (let i = 0; i < 20 && !got.length; i++) await new Promise((res) => setTimeout(res, 50));
    off();
    expect(got).toContain('connection');
    // 같은 state를 다시 쓰면(콜백 재전송 · 뒤로 가기) 거절 — 토큰 엔드포인트를 다시 부르지 않는다
    st.authCode = 'cb-code-0002';
    expect(errorOf(await callback(t.anon(), { code: 'cb-code-0002', state }))).toBe('state_used');
    expect(st.tokenCalls).toHaveLength(1);
    // 이제 연결 확인이 실제 토큰으로 돈다 (승인 안내가 아니라 쇼핑몰 조회)
    st.access = 'c24-access-1001';
    const test = await (await as('pm')).post(`${base()}/${id}/test`);
    expect(test.json.result.message).not.toContain('인증 시작');
  });

  it('위조 · 변조 · 다른 비밀값 · 형식 오류 · 누락 state는 state_invalid, 10분이 지나면 state_expired — 교환 · 저장 없음', async () => {
    const id = await cafe24Conn();
    const good = await startState(id);
    const before = await credsOf(id);
    const [body, sig] = good.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const tampered = `${Buffer.from(JSON.stringify({ ...decoded, uid: t.userIds.owner }), 'utf8').toString('base64url')}.${sig}`;
    const wrongSecret = signOAuthState('another-secret-0123456789abcdef0123', decoded);
    const farFuture = signOAuthState(t.config.sessionSecret, { ...decoded, exp: nowMs() + 24 * 3600_000 });
    st.authCode = 'cb-code-x';
    for (const s of [tampered, wrongSecret, farFuture, `${body}.`, 'not-a-state', `${body}.${sig}.x`]) {
      expect(errorOf(await callback(t.anon(), { code: 'cb-code-x', state: s })), s).toBe('state_invalid');
    }
    expect(errorOf(await callback(t.anon(), { code: 'cb-code-x' }))).toBe('state_invalid');
    // 만료: 시작 후 10분이 지나 돌아온 콜백
    setNowForTest(nowMs() + OAUTH_STATE_TTL_MS + 1_000);
    expect(errorOf(await callback(t.anon(), { code: 'cb-code-x', state: good }))).toBe('state_expired');
    setNowForTest(null);
    expect(st.tokenCalls).toHaveLength(0);
    expect((await credsOf(id)).creds).toEqual(before.creds);
    expect(await oauthAudits(id)).toHaveLength(0);
  });

  it('다른 워크스페이스: 서명이 맞아도 state의 (워크스페이스, 커넥션) 쌍이 아니면 connection_missing, 멤버가 아닌 워크스페이스는 forbidden', async () => {
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'oauth-cross', '남의 브랜드', '남') RETURNING id`, [t.orgId])).rows[0].id;
    const foreign = (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, credentials_enc) VALUES ($1, 'cafe24', 'sales', 'own_mall', '남의 카페24', $2) RETURNING id`,
      [other, encryptCredentials(APP, t.config.encryptionKey)],
    )).rows[0].id;
    const sign = (ws: string, cid: string, uid = t.userIds.pm) => signOAuthState(t.config.sessionSecret, newOAuthState({ ws, cid, uid, now: nowMs() }));
    st.authCode = 'cb-code-y';
    // 내 워크스페이스로 서명했지만 커넥션은 남의 것
    expect(errorOf(await callback(t.anon(), { code: 'cb-code-y', state: sign(t.ws, foreign) }))).toBe('connection_missing');
    // 남의 워크스페이스 · 남의 커넥션 (pm은 그 워크스페이스 멤버가 아니다)
    expect(errorOf(await callback(t.anon(), { code: 'cb-code-y', state: sign(other, foreign) }))).toBe('forbidden');
    expect(st.tokenCalls).toHaveLength(0);
    const row = (await t.db.query<{ credentials_enc: string }>('SELECT credentials_enc FROM connections WHERE id = $1', [foreign])).rows[0];
    expect(decryptCredentials(row.credentials_enc, t.config.encryptionKey)).toEqual(APP);
  });

  it('세션이 있으면 state의 사용자와 같아야 한다 (session_mismatch), 같은 사용자 세션이면 정상 처리', async () => {
    const id = await cafe24Conn();
    const state = await startState(id);
    st.authCode = 'cb-code-z';
    expect(errorOf(await callback(await as('owner'), { code: 'cb-code-z', state }))).toBe('session_mismatch');
    expect(st.tokenCalls).toHaveLength(0);
    const ok = await callback(await as('pm'), { code: 'cb-code-z', state });
    expect(ok.headers.location).toBe(`${t.config.appUrl}/#connections`);
    expect(st.tokenCalls).toHaveLength(1);
  });

  it('시작한 사용자가 그사이 configure 권한을 잃으면 forbidden', async () => {
    const id = await cafe24Conn();
    const state = await startState(id);
    await t.db.query(`UPDATE memberships SET role = 'ae' WHERE user_id = $1 AND workspace_id = $2`, [t.userIds.pm, t.ws]);
    try {
      st.authCode = 'cb-code-r';
      expect(errorOf(await callback(t.anon(), { code: 'cb-code-r', state }))).toBe('forbidden');
      expect(st.tokenCalls).toHaveLength(0);
    } finally {
      await t.db.query(`UPDATE memberships SET role = 'pm' WHERE user_id = $1 AND workspace_id = $2`, [t.userIds.pm, t.ws]);
    }
  });

  it('운영자가 거절(error=access_denied) → denied, 코드 없음 → code_missing, 교환 실패 → exchange_failed + last_error(비밀값 가림) — 실패도 감사', async () => {
    const id = await cafe24Conn();
    expect(errorOf(await callback(t.anon(), { error: 'access_denied', state: await startState(id) }))).toBe('denied');
    expect(errorOf(await callback(t.anon(), { state: await startState(id) }))).toBe('code_missing');
    st.authCode = 'the-real-code';
    expect(errorOf(await callback(t.anon(), { code: 'expired-or-wrong-code', state: await startState(id) }))).toBe('exchange_failed');
    const v = await credsOf(id);
    expect(v.creds).toEqual(APP);
    expect(v.lastError).toMatch(/카페24 인증 코드 교환 실패/);
    expect(v.lastError).not.toContain(CAFE24_CREDS.clientSecret);
    const audits = await oauthAudits(id);
    expect(audits.map((a) => [a.detail.ok, a.detail.error])).toEqual([[false, 'denied'], [false, 'code_missing'], [false, 'exchange_failed']]);
    expect(JSON.stringify(audits)).not.toContain('expired-or-wrong-code');
  });
});

describe('CSV 전용 공급자 · 카탈로그 선택 필드', () => {
  it('오늘의집: POST /connections → 400 csv_only + csvGuide 안내, 행을 만들지 않는다', async () => {
    const pm = await as('pm');
    const r = await pm.post(base(), { provider: 'ohouse', label: '오늘의집' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('csv_only');
    expect(r.json.error.message).toBe(csvGuide.message);
    expect(r.json.error.detail).toEqual({ template: 'sales_daily', channel: 'ohouse' });
    expect((await t.db.query(`SELECT 1 FROM connections WHERE provider = 'ohouse'`)).rowCount).toBe(0);
    // 권한 검사가 먼저 (ae는 403)
    expect((await (await as('ae')).post(base(), { provider: 'ohouse' })).status).toBe(403);
  });

  it('카탈로그: CSV 전용 공급자만 csvOnly { template, channel, message }, 카페24는 oauth { startLabel, redirectUri }', async () => {
    const r = await (await as('viewer')).get('/api/connectors/catalog');
    const providers = r.json.providers as { provider: string; available: boolean; csvOnly?: unknown; oauth?: unknown }[];
    const oh = providers.find((p) => p.provider === 'ohouse')!;
    expect(oh.available).toBe(false);
    expect(oh.csvOnly).toEqual({ template: 'sales_daily', channel: 'ohouse', message: csvGuide.message });
    expect(providers.filter((p) => p.csvOnly).map((p) => p.provider)).toEqual(['ohouse']);
    expect(providers.find((p) => p.provider === 'cafe24')!.oauth).toEqual({ startLabel: '카페24 인증 시작', redirectUri: callbackUri() });
    expect(providers.filter((p) => p.oauth).map((p) => p.provider)).toEqual(['cafe24']);
  });
});
