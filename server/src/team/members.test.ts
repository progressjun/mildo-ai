/** team: 구성원 목록 · 역할 변경 · 제외 · 비활성화 — 권한, 자기 역할 금지, 소유자 권한은 소유자만, 마지막 소유자 보호, 경쟁 상태, 격리 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { addUser, login, loginAs, otherWorkspace } from './testkit';

let t: TestApp;
let owner: TestClient;
let admin: TestClient;
const mem = (ws = t.ws) => `/api/w/${ws}/members`;
beforeAll(async () => {
  t = await createTestApp();
  owner = await login(t, 'owner');
  admin = await login(t, 'admin');
});
afterAll(async () => { await t?.close(); });

async function lastAudit(action: string, targetId: string) {
  return (await t.db.query<{ detail: Record<string, unknown>; user_id: string }>(
    'SELECT detail, user_id FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id DESC LIMIT 1', [action, targetId],
  )).rows[0];
}

describe('목록', () => {
  it('읽기 권한이면 누구나: 역할 · 직함 · 최근 로그인 · 실명 표시, 세션 정보는 팀 관리자에게만', async () => {
    const viewer = await login(t, 'viewer');
    const r = await viewer.get(mem());
    expect(r.status).toBe(200);
    const roles = r.json.members.map((m: { role: string }) => m.role);
    expect(roles.slice(0, 6)).toEqual(['owner', 'admin', 'pm', 'ae', 'client', 'viewer']);
    const me = r.json.members.find((m: { is_me: boolean }) => m.is_me);
    expect(me).toMatchObject({ email: 'viewer@test.local', role: 'viewer', real_name: true, status: 'active', title: null });
    expect(me.last_login_at).toBeTruthy();
    expect(me.last_seen_at).toBeNull();
    expect(me.active_sessions).toBeNull();
    expect(JSON.stringify(r.json)).not.toMatch(/password|token/);
    const byAdmin = await admin.get(mem());
    const vrow = byAdmin.json.members.find((m: { email: string }) => m.email === 'viewer@test.local');
    expect(vrow.active_sessions).toBeGreaterThanOrEqual(1);
    expect(vrow.last_seen_at).toBeTruthy();
  });

  it('비로그인 401 · 비구성원 404 · 잘못된 id 404', async () => {
    expect((await t.anon().get(mem())).status).toBe(401);
    const o = await otherWorkspace(t, 'iso-m', [{ email: 'iso.owner@example.com', role: 'owner' }]);
    expect((await owner.get(mem(o.ws))).status).toBe(404);
    expect((await owner.patch(`${mem(o.ws)}/${o.users['iso.owner@example.com']}`, { role: 'viewer' })).status).toBe(404);
    expect((await owner.del(`${mem(o.ws)}/${o.users['iso.owner@example.com']}`)).status).toBe(404);
    // 우리 워크스페이스 경로로 그쪽 사용자 → 구성원 아님 404
    expect((await owner.patch(`${mem()}/${o.users['iso.owner@example.com']}`, { role: 'viewer' })).status).toBe(404);
    expect((await owner.patch(`${mem()}/not-a-uuid`, { role: 'viewer' })).status).toBe(404);
    const theirs = await (await login(t, 'iso.owner@example.com')).get(mem(o.ws));
    expect(theirs.json.members.map((m: { email: string }) => m.email)).toEqual(['iso.owner@example.com']);
  });
});

describe('역할 변경', () => {
  it('관리자: ae → pm 가능(감사 · 이벤트), 소유자 부여 · 회수는 403, 자기 역할은 403', async () => {
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => got.push(`${e.type}:${e.id}`));
    const id = await addUser(t, 'ae.two@example.com', 'ae');
    const r = await admin.patch(`${mem()}/${id}`, { role: 'pm' });
    expect(r.status).toBe(200);
    expect(r.json.member).toMatchObject({ user_id: id, role: 'pm' });
    expect(r.json.members.length).toBeGreaterThan(6);
    const a = await lastAudit('member.role_change', id);
    expect(a.detail).toMatchObject({ email: 'ae.two@example.com', from: 'ae', to: 'pm' });
    expect(a.user_id).toBe(t.userIds.admin);
    for (let i = 0; i < 20 && !got.includes(`member:${id}`); i++) await new Promise((res) => setTimeout(res, 50));
    off();
    expect(got).toContain(`member:${id}`);

    const grant = await admin.patch(`${mem()}/${id}`, { role: 'owner' });
    expect(grant.status).toBe(403);
    expect(grant.json.error.code).toBe('owner_only');
    const revoke = await admin.patch(`${mem()}/${t.userIds.owner}`, { role: 'admin' });
    expect(revoke.status).toBe(403);
    expect(revoke.json.error.code).toBe('owner_only');
    const self = await admin.patch(`${mem()}/${t.userIds.admin}`, { role: 'pm' });
    expect(self.status).toBe(403);
    expect(self.json.error.code).toBe('self_role');
    const ownerSelf = await owner.patch(`${mem()}/${t.userIds.owner}`, { role: 'admin' });
    expect(ownerSelf.status).toBe(403);
    expect(ownerSelf.json.error.code).toBe('self_role');
  });

  it('팀 관리 권한 없는 역할은 403', async () => {
    for (const role of ['pm', 'ae', 'client', 'viewer'] as const) {
      const c = await login(t, role);
      expect((await c.patch(`${mem()}/${t.userIds.viewer}`, { role: 'client' })).status, role).toBe(403);
      expect((await c.del(`${mem()}/${t.userIds.viewer}`)).status, role).toBe(403);
    }
  });

  it('입력 검증', async () => {
    expect((await owner.patch(`${mem()}/${t.userIds.viewer}`, {})).status).toBe(400);
    expect((await owner.patch(`${mem()}/${t.userIds.viewer}`, { role: 'god' })).status).toBe(400);
    expect((await owner.patch(`${mem()}/${t.userIds.viewer}`, { title: 'x'.repeat(61) })).status).toBe(400);
    expect((await owner.patch(`${mem()}/00000000-0000-4000-8000-000000000000`, { role: 'viewer' })).status).toBe(404);
  });

  it('직함 변경 · 비우기', async () => {
    const r = await admin.patch(`${mem()}/${t.userIds.ae}`, { title: '  검색광고 담당  ' });
    expect(r.json.member.title).toBe('검색광고 담당');
    expect((await lastAudit('member.title_change', t.userIds.ae)).detail).toMatchObject({ to: '검색광고 담당' });
    const cleared = await admin.patch(`${mem()}/${t.userIds.ae}`, { title: null });
    expect(cleared.json.member.title).toBeNull();
  });

  it('소유자는 다른 구성원에게 소유자를 주고 회수할 수 있다', async () => {
    const id = await addUser(t, 'future.owner@example.com', 'admin');
    expect((await owner.patch(`${mem()}/${id}`, { role: 'owner' })).json.member.role).toBe('owner');
    expect((await owner.patch(`${mem()}/${id}`, { role: 'viewer' })).json.member.role).toBe('viewer');
  });
});

describe('마지막 소유자 보호', () => {
  it('유일한 소유자는 나갈 수 없고, 비활성 소유자는 소유자 수에 넣지 않는다', async () => {
    const leave = await owner.del(`${mem()}/${t.userIds.owner}`);
    expect(leave.status).toBe(409);
    expect(leave.json.error.code).toBe('last_owner');
    const dormant = await addUser(t, 'dormant.owner@example.com', 'owner');
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [dormant]);
    expect((await owner.del(`${mem()}/${t.userIds.owner}`)).json.error.code).toBe('last_owner');
    await t.db.query(`DELETE FROM memberships WHERE user_id = $1`, [dormant]);
  });

  it('두 소유자가 동시에 서로를 강등해도 소유자 0명이 되지 않는다', async () => {
    const o2 = await addUser(t, 'co.owner@example.com', 'owner');
    const c2 = await login(t, 'co.owner@example.com');
    const [a, b] = await Promise.all([
      owner.patch(`${mem()}/${o2}`, { role: 'admin' }),
      c2.patch(`${mem()}/${t.userIds.owner}`, { role: 'admin' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const owners = await t.db.query(`SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [t.ws]);
    expect(owners.rowCount).toBe(1);
    // 원래 소유자가 남도록 정리
    const survivor = owners.rows[0] as { user_id: string };
    if (survivor.user_id !== t.userIds.owner) {
      await t.db.query(`UPDATE memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [t.ws, t.userIds.owner]);
    }
    await t.db.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [t.ws, o2]);
  });

  it('소유자가 둘이면 한 명은 나갈 수 있다 (member.leave)', async () => {
    const o3 = await addUser(t, 'leaving.owner@example.com', 'owner');
    const c3 = await login(t, 'leaving.owner@example.com');
    const r = await c3.del(`${mem()}/${o3}`);
    expect(r.status).toBe(200);
    expect(r.json.members).toEqual([]);
    expect((await lastAudit('member.leave', o3)).detail).toMatchObject({ role: 'owner' });
    expect((await c3.get(mem())).status).toBe(404);
  });
});

describe('제외', () => {
  it('관리자가 광고주 담당자를 제외: 멤버십만 지우고 세션은 유지(다른 워크스페이스용)', async () => {
    const id = await addUser(t, 'client.two@example.com', 'client');
    const c = await login(t, 'client.two@example.com');
    const r = await admin.del(`${mem()}/${id}`);
    expect(r.status).toBe(200);
    expect(r.json.members.some((m: { user_id: string }) => m.user_id === id)).toBe(false);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    expect((await c.get(`/api/w/${t.ws}`)).status).toBe(404);
    expect((await lastAudit('member.remove', id)).detail).toMatchObject({ email: 'client.two@example.com', role: 'client' });
    expect((await admin.del(`${mem()}/${id}`)).status).toBe(404);
  });

  it('관리자는 소유자를 제외할 수 없다', async () => {
    const r = await admin.del(`${mem()}/${t.userIds.owner}`);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('owner_only');
  });
});

describe('계정 비활성화', () => {
  it('비활성화하면 세션이 끊기고 로그인할 수 없다, 재활성화하면 다시 로그인', async () => {
    const id = await addUser(t, 'to.disable@example.com', 'ae');
    const c = await login(t, 'to.disable@example.com');
    await t.db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ('pending-before-disable', $1, now() + interval '1 hour')`, [id]);
    const r = await admin.patch(`${mem()}/${id}`, { status: 'disabled' });
    const reset = await t.db.query<{ used_at: Date | null }>(`SELECT used_at FROM password_resets WHERE token_hash = 'pending-before-disable'`);
    expect(reset.rows[0].used_at).not.toBeNull();
    expect(r.status).toBe(200);
    expect(r.json.member.status).toBe('disabled');
    expect((await lastAudit('member.disable', id)).detail).toMatchObject({ revokedSessions: 1 });
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect((await loginAs(t, 'to.disable@example.com')).status).toBe(401);
    expect((await admin.patch(`${mem()}/${id}`, { status: 'active' })).json.member.status).toBe('active');
    expect((await loginAs(t, 'to.disable@example.com')).status).toBe(200);
  });

  it('자기 계정 · 소유자(관리자가) · 관리 범위 밖 다른 워크스페이스 소속 계정은 비활성화 불가', async () => {
    expect((await admin.patch(`${mem()}/${t.userIds.admin}`, { status: 'disabled' })).json.error.code).toBe('self_status');
    expect((await admin.patch(`${mem()}/${t.userIds.owner}`, { status: 'disabled' })).json.error.code).toBe('owner_only');
    const o = await otherWorkspace(t, 'iso-s', [{ email: 'multi@example.com', role: 'pm' }]);
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`, [t.ws, o.users['multi@example.com']]);
    const r = await admin.patch(`${mem()}/${o.users['multi@example.com']}`, { status: 'disabled' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('shared_account');
    // 제외는 가능
    expect((await admin.del(`${mem()}/${o.users['multi@example.com']}`)).status).toBe(200);
  });

  it('비활성화하면 활성 소유자가 0명이 되는 워크스페이스가 생기면 막는다', async () => {
    const o = await otherWorkspace(t, 'iso-o', [{ email: 'sole.owner.elsewhere@example.com', role: 'owner' }]);
    const uid = o.users['sole.owner.elsewhere@example.com'];
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [t.ws, uid]);
    // 우리 소유자가 그 워크스페이스에서도 소유자라 범위 안이지만, 그쪽 활성 소유자가 0명이 된다
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [o.ws, t.userIds.owner]);
    const r = await owner.patch(`${mem()}/${uid}`, { status: 'disabled' });
    expect(r.status).toBe(409);
    expect(['last_owner', 'shared_account']).toContain(r.json.error.code);
    await t.db.query(`UPDATE memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [o.ws, t.userIds.owner]);
    const r2 = await owner.patch(`${mem()}/${uid}`, { status: 'disabled' });
    expect(r2.status).toBe(200);
    await t.db.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [t.ws, uid]);
  });
});
