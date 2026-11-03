/**
 * SSE(/api/w/:ws/events) 접근 재확인 — 연결 뒤 세션이 끝나거나(강제 종료 · 비밀번호 변경 · DB에서 직접 삭제) 멤버십에서 제외되면
 * 스트림이 닫히고, 그 뒤의 워크스페이스 이벤트는 전달되지 않는다. 유효한 세션의 스트림은 계속 받는다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp, type TestClient, type TestResponse } from '../../test/app';
import { publish } from './hub';
import { RECHECK_MS } from './routes';

let t: TestApp;
/** 마지막 테스트가 서버를 닫아 남은 스트림 본문을 읽는다 — 그 뒤에는 DB · 이벤트만 정리 */
let appClosed = false;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  if (!appClosed) return t.close();
  await t.events.stop();
  await t.testDb.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 스트림을 열고 구독이 붙을 때까지 기다린다 (inject는 응답이 끝나야 결과를 돌려준다).
 * 결과 약속을 객체로 감싸 돌려준다 — async 함수가 약속을 그대로 돌려주면 그 약속이 끝날 때까지 기다리게 된다.
 */
async function openStream(c: TestClient): Promise<{ done: Promise<TestResponse> }> {
  const before = t.events.listenerCount(t.ws);
  const done = c.get(`/api/w/${t.ws}/events`);
  for (let i = 0; i < 100 && t.events.listenerCount(t.ws) <= before; i++) await sleep(10);
  expect(t.events.listenerCount(t.ws)).toBe(before + 1);
  return { done };
}

/** 스트림이 끝나기를 기다린다 (끝나지 않으면 null) */
async function ended(s: { done: Promise<TestResponse> }, ms = 3000): Promise<TestResponse | null> {
  return Promise.race([s.done, sleep(ms).then(() => null)]);
}

/** 이벤트가 NOTIFY → 구독자까지 닿을 시간 */
const settle = () => sleep(150);

describe('SSE 스트림 — 세션 · 멤버십 재확인', () => {
  let ownerStream: { done: Promise<TestResponse> };
  let owner: TestClient;

  beforeAll(async () => {
    owner = await t.login('owner');
    ownerStream = await openStream(owner);
  });

  it('세션 강제 종료(DELETE /auth/sessions/:id) 뒤에는 그 세션의 스트림이 닫히고 이후 이벤트를 받지 않는다', async () => {
    const a = await t.login('client');
    const b = await t.login('client');
    const stream = await openStream(a);
    await publish(t.db, t.ws, { type: 'member', id: 'evt-before-revoke' });
    await settle();
    const list = await b.get('/api/auth/sessions');
    const other = (list.json.sessions as Array<{ id: string; current: boolean }>).filter((s) => !s.current);
    expect(other.length).toBeGreaterThan(0);
    for (const s of other) expect((await b.del(`/api/auth/sessions/${s.id}`)).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(401);
    await publish(t.db, t.ws, { type: 'member', id: 'evt-after-revoke' });
    const res = await ended(stream);
    expect(res, '강제 종료된 세션의 스트림이 닫혀야 한다').not.toBeNull();
    expect(res!.body).toContain('evt-before-revoke');
    expect(res!.body).not.toContain('evt-after-revoke');
  });

  it('다른 기기에서 비밀번호를 바꾸면 기존 세션의 스트림이 닫힌다', async () => {
    const a = await t.login('ae');
    const b = await t.login('ae');
    const stream = await openStream(a);
    const r = await b.post('/api/auth/password', { current: TEST_PASSWORD, next: 'NewAePass#2028x' });
    expect(r.status).toBe(200);
    expect(r.json.revokedSessions).toBeGreaterThan(0);
    await publish(t.db, t.ws, { type: 'change', id: 'evt-after-password' });
    const res = await ended(stream);
    expect(res).not.toBeNull();
    expect(res!.body).not.toContain('evt-after-password');
  });

  it('멤버십에서 제외되면 제외 이벤트를 포함해 이후 이벤트를 받지 않는다', async () => {
    const v = await t.login('viewer');
    const stream = await openStream(v);
    const viewerId = t.userIds.viewer;
    const del = await owner.del(`/api/w/${t.ws}/members/${viewerId}`);
    expect(del.status).toBe(200);
    expect((await v.get(`/api/w/${t.ws}`)).status).toBe(404);
    await publish(t.db, t.ws, { type: 'member', id: 'evt-after-removal' });
    const res = await ended(stream);
    expect(res).not.toBeNull();
    expect(res!.body).not.toContain(viewerId);
    expect(res!.body).not.toContain('evt-after-removal');
  });

  it('신호 없이 DB에서 직접 지운 세션도 다음 이벤트 전에 확인해 전달하지 않는다', async () => {
    const pm = await t.login('pm');
    const stream = await openStream(pm);
    // 로그인 쿠키(토큰)는 클라이언트 안에 있어 행 id를 모른다 → 이 사용자의 세션을 모두 지운다 (운영자 SQL과 같은 상황)
    await t.db.query('DELETE FROM sessions WHERE user_id = $1', [t.userIds.pm]);
    await sleep(RECHECK_MS + 100);
    await publish(t.db, t.ws, { type: 'incident', id: 'evt-after-sql-delete' });
    const res = await ended(stream);
    expect(res).not.toBeNull();
    expect(res!.body).not.toContain('evt-after-sql-delete');
  });

  it('유효한 세션의 스트림은 다른 사람의 세션 종료 · 제외와 무관하게 계속 이벤트를 받는다', async () => {
    await publish(t.db, t.ws, { type: 'comment', id: 'evt-owner-still-live' });
    await settle();
    expect(await ended(ownerStream, 300)).toBeNull();
    // 서버를 닫으면 스트림이 끝난다 — 본문으로 받은 이벤트 확인
    appClosed = true;
    const closing = t.app.close();
    const res = await ended(ownerStream);
    await closing;
    expect(res).not.toBeNull();
    for (const id of ['evt-before-revoke', 'evt-after-revoke', 'evt-after-password', 'evt-after-removal', 'evt-after-sql-delete', 'evt-owner-still-live']) {
      expect(res!.body).toContain(id);
    }
  });
});
