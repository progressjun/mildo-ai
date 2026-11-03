/** team: 초대 → 수락 → 로그인 전체 흐름, 만료 · 취소 · 재발송 · 대체, 기존 계정 수락, 권한 · 테넌트 격리 · 감사 · 메일 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { clearTestOutbox, getTestOutbox } from '../lib/mailer';
import { sha256 } from '../lib/ids';
import { acceptVia, addUser, getFrom, linkIn, login, loginAs, otherWorkspace, tokenOf } from './testkit';

let t: TestApp;
let owner: TestClient;
let admin: TestClient;
beforeAll(async () => {
  t = await createTestApp();
  owner = await login(t, 'owner');
  admin = await login(t, 'admin');
});
afterAll(async () => { await t?.close(); });
beforeEach(() => clearTestOutbox());

const inv = (ws = t.ws) => `/api/w/${ws}/invites`;
const NEW_PW = 'NewMember#2027';

describe('초대 생성', () => {
  it('이메일 정규화 · 7일 만료 · 링크 · 메일 · 토큰은 해시만 저장 · 감사', async () => {
    const r = await owner.post(inv(), { email: '  New.Person@Example.COM ', role: 'ae' });
    expect(r.status).toBe(200);
    expect(r.json.invite).toMatchObject({ email: 'new.person@example.com', role: 'ae', status: 'pending', invited_by_name: '테스트 owner', send_count: 1 });
    expect(r.json.invite.token_hash).toBeUndefined();
    expect(r.json.link).toMatch(new RegExp(`^${t.config.appUrl.replace(/[/.:]/g, '\\$&')}/\\?invite=[A-Za-z0-9_-]{40,}$`));
    expect(r.json.mail.sent).toBe(true);
    const days = (Date.parse(r.json.invite.expires_at) - Date.parse(r.json.invite.created_at)) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    const token = tokenOf(r.json.link, 'invite');
    const row = await t.db.query<{ token_hash: string }>('SELECT token_hash FROM invites WHERE id = $1', [r.json.invite.id]);
    expect(row.rows[0].token_hash).toBe(sha256(token));
    expect(row.rows[0].token_hash).not.toContain(token);

    const mails = getTestOutbox();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('new.person@example.com');
    expect(mails[0].subject).toContain('수면밀도');
    expect(linkIn(mails[0].text, 'invite')).toBe(r.json.link);
    expect(mails[0].html).toContain(r.json.link.replace(/&/g, '&amp;'));

    const a = await t.db.query<{ action: string; detail: Record<string, unknown>; user_id: string }>(
      `SELECT action, detail, user_id FROM audit_log WHERE action = 'invite.create' AND target_id = $1`, [r.json.invite.id],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].user_id).toBe(t.userIds.owner);
    expect(a.rows[0].detail).toMatchObject({ email: 'new.person@example.com', role: 'ae' });
    expect(JSON.stringify(a.rows[0].detail)).not.toContain(token);
  });

  it('권한: pm · ae · client · viewer는 403, 비로그인 401, 관리자는 소유자를 초대할 수 없다', async () => {
    for (const role of ['pm', 'ae', 'client', 'viewer'] as const) {
      const c = await login(t, role);
      const r = await c.post(inv(), { email: `x-${role}@example.com`, role: 'viewer' });
      expect(r.status, role).toBe(403);
      expect((await c.get(inv())).status, role).toBe(403);
    }
    expect((await t.anon().post(inv(), { email: 'a@example.com', role: 'viewer' })).status).toBe(401);
    const byAdmin = await admin.post(inv(), { email: 'boss@example.com', role: 'owner' });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.json.error.code).toBe('owner_only');
    const byOwner = await owner.post(inv(), { email: 'boss@example.com', role: 'owner' });
    expect(byOwner.status).toBe(400);
    expect(byOwner.json.error.code).toBe('owner_invite');
    const okAdmin = await admin.post(inv(), { email: 'second.admin@example.com', role: 'admin' });
    expect(okAdmin.status).toBe(200);
  });

  it('입력 검증 · 이미 구성원이면 409', async () => {
    expect((await owner.post(inv(), { email: 'not-an-email', role: 'ae' })).status).toBe(400);
    expect((await owner.post(inv(), { email: 'ok@example.com', role: 'superuser' })).status).toBe(400);
    expect((await owner.post(inv(), { role: 'ae' })).status).toBe(400);
    const dup = await owner.post(inv(), { email: 'PM@test.local', role: 'viewer' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('already_member');
  });

  it('같은 이메일을 다시 초대하면 이전 링크는 무효(대체)', async () => {
    const a = await owner.post(inv(), { email: 'twice@example.com', role: 'viewer' });
    const b = await owner.post(inv(), { email: 'twice@example.com', role: 'pm' });
    expect(b.status).toBe(200);
    expect((await getFrom(t.anon(), `/api/invites/${tokenOf(a.json.link, 'invite')}`)).status).toBe(404);
    const g = await getFrom(t.anon(), `/api/invites/${tokenOf(b.json.link, 'invite')}`);
    expect(g.status).toBe(200);
    expect(g.json.role).toBe('pm');
    const list = await owner.get(inv());
    const old = list.json.invites.find((i: { id: string }) => i.id === a.json.invite.id);
    expect(old).toMatchObject({ status: 'revoked', revoke_reason: 'superseded' });
  });
});

describe('초대 수락 → 로그인', () => {
  it('새 계정: 공개 조회 → 비밀번호 정책 → 수락(세션 쿠키) → me · 워크스페이스 · 재로그인, 재사용 불가', async () => {
    const created = await owner.post(inv(), { email: 'Flow.User@Example.com', role: 'pm' });
    const token = tokenOf(created.json.link, 'invite');

    const info = await getFrom(t.anon(), `/api/invites/${token}`);
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({
      email: 'flow.user@example.com', role: 'pm', role_label: 'PM', expired: false, accepted: false, existing_user: false,
      workspace: { id: t.ws, brand_name: '수면밀도' },
    });
    expect(info.json.workspace.name).toContain('수면밀도');

    const guest = t.anon();
    const weak = await acceptVia(guest, token, { name: '흐름 사용자', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.json.error.code).toBe('weak_password');
    const noName = await acceptVia(guest, token, { password: NEW_PW });
    expect(noName.status).toBe(400);

    const ok = await acceptVia(guest, token, { name: '흐름 사용자', password: NEW_PW });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, newUser: true, workspaceId: t.ws, role: 'pm' });
    expect(typeof ok.json.csrfToken).toBe('string');

    const me = await guest.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({ email: 'flow.user@example.com', name: '흐름 사용자' });
    expect(me.json.workspaces.map((w: { id: string; role: string }) => [w.id, w.role])).toEqual([[t.ws, 'pm']]);
    expect(me.json.csrfToken).toBe(ok.json.csrfToken);
    // CSRF 토큰이 쿠키와 같아 쓰기 요청도 된다
    expect((await guest.post('/api/auth/logout')).status).toBe(200);

    const relog = await loginAs(t, 'FLOW.user@example.com', NEW_PW);
    expect(relog.status).toBe(200);

    const again = await acceptVia(t.anon(), token, { name: 'x', password: NEW_PW });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('invite_used');
    const after = await getFrom(t.anon(), `/api/invites/${token}`);
    expect(after.json.accepted).toBe(true);

    const list = await owner.get(inv());
    expect(list.json.invites.find((i: { id: string }) => i.id === created.json.invite.id)).toMatchObject({ status: 'accepted', accepted_by_name: '흐름 사용자' });
    const members = await owner.get(`/api/w/${t.ws}/members`);
    expect(members.json.members.find((m: { email: string }) => m.email === 'flow.user@example.com')).toMatchObject({ role: 'pm', status: 'active' });
    const a = await t.db.query<{ action: string; detail: { newUser: boolean } }>(
      `SELECT action, detail FROM audit_log WHERE action = 'invite.accept' AND target_id = $1`, [created.json.invite.id],
    );
    expect(a.rows[0].detail.newUser).toBe(true);
  });

  it('수락하면 같은 워크스페이스 SSE 구독자에게 member 이벤트', async () => {
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => got.push(e.type));
    const created = await owner.post(inv(), { email: 'event.user@example.com', role: 'viewer' });
    await acceptVia(t.anon(), tokenOf(created.json.link, 'invite'), { name: '이벤트', password: NEW_PW });
    for (let i = 0; i < 20 && got.filter((x) => x === 'member').length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    off();
    expect(got.filter((x) => x === 'member').length).toBeGreaterThanOrEqual(2);
  });

  it('기존 계정(다른 워크스페이스 소속): 비밀번호 없으면 401, 틀리면 401 · 감사, 맞으면 멤버십 추가', async () => {
    const other = await otherWorkspace(t, 'other-a', [{ email: 'shared@example.com', role: 'pm', name: '공유 사용자' }]);
    const created = await owner.post(inv(), { email: 'shared@example.com', role: 'client' });
    const token = tokenOf(created.json.link, 'invite');
    expect((await getFrom(t.anon(), `/api/invites/${token}`)).json.existing_user).toBe(true);
    const none = await acceptVia(t.anon(), token, {});
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe('password_required');
    const wrong = await acceptVia(t.anon(), token, { password: 'Wrong#Password1' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('invalid_credentials');
    const failed = await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.login_failed' AND user_id = $1 AND detail->>'via' = 'invite'`, [other.users['shared@example.com']]);
    expect(failed.rowCount).toBe(1);
    const c = t.anon();
    const ok = await acceptVia(c, token, { name: '무시되는 이름', password: 'TestPass#2027' });
    expect(ok.status).toBe(200);
    expect(ok.json.newUser).toBe(false);
    const me = await c.get('/api/auth/me');
    expect(me.json.user.name).toBe('공유 사용자');
    expect(new Map(me.json.workspaces.map((w: { id: string; role: string }) => [w.id, w.role]))).toEqual(new Map([[other.ws, 'pm'], [t.ws, 'client']]));
  });

  it('초대받은 계정으로 이미 로그인해 있으면 비밀번호 없이 수락하고 세션을 유지한다', async () => {
    await otherWorkspace(t, 'other-b', [{ email: 'loggedin@example.com', role: 'viewer' }]);
    const c = await login(t, 'loggedin@example.com');
    const before = (await c.get('/api/auth/me')).json.csrfToken;
    const created = await owner.post(inv(), { email: 'loggedin@example.com', role: 'ae' });
    const token = tokenOf(created.json.link, 'invite');
    expect((await getFrom(c, `/api/invites/${token}`)).json.signed_in_as_invitee).toBe(true);
    const ok = await acceptVia(c, token, {});
    expect(ok.status).toBe(200);
    expect(ok.json.csrfToken).toBe(before);
    expect((await c.get(`/api/w/${t.ws}`)).json.role).toBe('ae');
  });

  it('세션만으로 수락할 때는 CSRF 헤더가 맞아야 한다 (코어가 면제한 경로 — 다른 사이트에서 몰래 수락시키기 방지)', async () => {
    await otherWorkspace(t, 'other-csrf', [{ email: 'csrf.victim@example.com', role: 'viewer' }]);
    const c = await login(t, 'csrf.victim@example.com');
    const created = await owner.post(inv(), { email: 'csrf.victim@example.com', role: 'admin' });
    const token = tokenOf(created.json.link, 'invite');
    for (const headers of [{ 'x-csrf-token': 'forged' }, { 'x-csrf-token': '' }]) {
      const r = await c.raw({ method: 'POST', url: `/api/invites/${token}/accept`, payload: {}, headers: { ...headers, 'x-forwarded-for': `10.252.0.${headers['x-csrf-token'].length + 1}` } });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('csrf');
    }
    const uid = (await t.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'csrf.victim@example.com'`)).rows[0].id;
    expect((await t.db.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [t.ws, uid])).rowCount).toBe(0);
    expect((await getFrom(t.anon(), `/api/invites/${token}`)).json.accepted).toBe(false);
    // 같은 클라이언트가 정상 CSRF 헤더로 보내면 수락된다
    expect((await acceptVia(c, token, {})).status).toBe(200);
  });

  it('기존 계정 비밀번호 확인은 로그인 실패 잠금을 따른다 (로그인 화면 실패 포함 15분 10회 → 맞는 비밀번호도 429)', async () => {
    const other = await otherWorkspace(t, 'other-lock', [{ email: 'locked.target@example.com', role: 'pm' }]);
    const uid = other.users['locked.target@example.com'];
    const created = await owner.post(inv(), { email: 'locked.target@example.com', role: 'viewer' });
    const token = tokenOf(created.json.link, 'invite');
    // 로그인 화면 실패 9회(대소문자 섞인 입력) + 초대 수락 실패 1회 = 10회
    for (let i = 0; i < 9; i++) {
      await t.db.query(`INSERT INTO audit_log (workspace_id, user_id, actor, action, ip) VALUES (NULL, $1, 'Locked.Target@Example.com', 'auth.login_failed', '10.0.0.9')`, [uid]);
    }
    expect((await acceptVia(t.anon(), token, { password: 'Wrong#Password1' })).status).toBe(401);
    const locked = await acceptVia(t.anon(), token, { password: 'TestPass#2027' });
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe('login_locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    const a = await t.db.query(`SELECT detail FROM audit_log WHERE action = 'auth.login_locked' AND user_id = $1`, [uid]);
    expect(a.rowCount).toBe(1);
    expect((await t.db.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [t.ws, uid])).rowCount).toBe(0);
    // 잠금이 풀리면(창 밖으로 밀어냄) 맞는 비밀번호로 수락된다
    await t.db.query(`UPDATE audit_log SET at = now() - interval '16 minutes' WHERE action = 'auth.login_failed' AND lower(actor) = 'locked.target@example.com'`);
    expect((await acceptVia(t.anon(), token, { password: 'TestPass#2027' })).status).toBe(200);
  });

  it('다른 계정으로 로그인한 채 새 계정 초대를 수락하면 새 계정으로 바뀌고 이전 세션은 정리된다', async () => {
    const created = await owner.post(inv(), { email: 'switch@example.com', role: 'viewer' });
    const c = await login(t, 'viewer');
    const count = async () => (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [t.userIds.viewer])).rows[0].n;
    const before = await count();
    const ok = await acceptVia(c, tokenOf(created.json.link, 'invite'), { name: '전환', password: NEW_PW });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/auth/me')).json.user.email).toBe('switch@example.com');
    expect(await count()).toBe(before - 1);
  });

  it('비활성 계정은 초대할 수 없다', async () => {
    const id = await addUser(t, 'disabled.x@example.com', 'viewer');
    await t.db.query(`DELETE FROM memberships WHERE user_id = $1`, [id]);
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);
    const r = await owner.post(inv(), { email: 'disabled.x@example.com', role: 'viewer' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('account_disabled');
  });
});

describe('만료 · 취소 · 재발송', () => {
  it('만료된 초대: 조회는 expired, 수락은 410, 재발송하면 새 링크만 유효', async () => {
    const created = await owner.post(inv(), { email: 'late@example.com', role: 'viewer' });
    const token = tokenOf(created.json.link, 'invite');
    await t.db.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [created.json.invite.id]);
    const info = await getFrom(t.anon(), `/api/invites/${token}`);
    expect(info.status).toBe(200);
    expect(info.json.expired).toBe(true);
    const acc = await acceptVia(t.anon(), token, { name: '늦음', password: NEW_PW });
    expect(acc.status).toBe(410);
    expect(acc.json.error.code).toBe('invite_expired');
    expect((await owner.get(inv())).json.invites.find((i: { id: string }) => i.id === created.json.invite.id).status).toBe('expired');

    const re = await admin.post(`${inv()}/${created.json.invite.id}/resend`);
    expect(re.status).toBe(200);
    expect(re.json.invite).toMatchObject({ status: 'pending', send_count: 2 });
    const fresh = tokenOf(re.json.link, 'invite');
    expect(fresh).not.toBe(token);
    expect((await getFrom(t.anon(), `/api/invites/${token}`)).status).toBe(404);
    expect(getTestOutbox().map((m) => linkIn(m.text, 'invite'))).toContain(re.json.link);
    const ok = await acceptVia(t.anon(), fresh, { name: '늦음', password: NEW_PW });
    expect(ok.status).toBe(200);
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'invite.resend' AND target_id = $1`, [created.json.invite.id])).rowCount).toBe(1);
  });

  it('취소된 초대: 조회 · 수락 404, 다시 취소해도 그대로, 수락된 초대 취소는 409', async () => {
    const created = await admin.post(inv(), { email: 'revoked@example.com', role: 'viewer' });
    const token = tokenOf(created.json.link, 'invite');
    const del = await admin.del(`${inv()}/${created.json.invite.id}`);
    expect(del.status).toBe(200);
    expect(del.json.invite.status).toBe('revoked');
    expect((await getFrom(t.anon(), `/api/invites/${token}`)).status).toBe(404);
    expect((await acceptVia(t.anon(), token, { name: 'x', password: NEW_PW })).status).toBe(404);
    expect((await admin.del(`${inv()}/${created.json.invite.id}`)).status).toBe(200);
    expect((await admin.post(`${inv()}/${created.json.invite.id}/resend`)).status).toBe(409);
    const audits = await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'invite.revoke' AND target_id = $1`, [created.json.invite.id]);
    expect(audits.rowCount).toBe(1);

    const acc = await owner.post(inv(), { email: 'accepted.then@example.com', role: 'viewer' });
    await acceptVia(t.anon(), tokenOf(acc.json.link, 'invite'), { name: '수락', password: NEW_PW });
    const no = await owner.del(`${inv()}/${acc.json.invite.id}`);
    expect(no.status).toBe(409);
    expect(no.json.error.code).toBe('invite_accepted');
  });

  it('잘못된 토큰 · id 형식은 404', async () => {
    expect((await t.anon().get('/api/invites/short')).status).toBe(404);
    expect((await getFrom(t.anon(), `/api/invites/${'a'.repeat(43)}`)).status).toBe(404);
    expect((await acceptVia(t.anon(), 'b'.repeat(43), { name: 'x', password: NEW_PW })).status).toBe(404);
    expect((await owner.del(`${inv()}/not-a-uuid`)).status).toBe(404);
    expect((await owner.del(`${inv()}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });
});

describe('테넌트 격리', () => {
  it('다른 워크스페이스의 초대는 보이지도 · 취소되지도 않는다', async () => {
    const o = await otherWorkspace(t, 'other-c', [{ email: 'owner.c@example.com', role: 'owner' }]);
    const oc = await login(t, 'owner.c@example.com');
    const theirs = await oc.post(inv(o.ws), { email: 'their.invitee@example.com', role: 'viewer' });
    expect(theirs.status).toBe(200);
    // 우리 소유자는 그 워크스페이스 멤버가 아니다 → 404
    expect((await owner.get(inv(o.ws))).status).toBe(404);
    expect((await owner.post(inv(o.ws), { email: 'x@example.com', role: 'viewer' })).status).toBe(404);
    // 우리 워크스페이스 경로로 그쪽 초대 id → 404
    expect((await owner.del(`${inv()}/${theirs.json.invite.id}`)).status).toBe(404);
    expect((await owner.post(`${inv()}/${theirs.json.invite.id}/resend`)).status).toBe(404);
    expect((await owner.get(inv())).json.invites.some((i: { id: string }) => i.id === theirs.json.invite.id)).toBe(false);
    expect((await oc.get(inv(o.ws))).json.invites.map((i: { email: string }) => i.email)).toEqual(['their.invitee@example.com']);
  });
});

describe('SMTP 미설정', () => {
  it('메일을 못 보내도 링크를 돌려주고 사유를 남긴다', async () => {
    const t2 = await createTestApp({ config: { env: 'development', smtp: null } });
    try {
      const o = await login(t2, 'owner');
      const r = await o.post(`/api/w/${t2.ws}/invites`, { email: 'nosmtp@example.com', role: 'viewer' });
      expect(r.status).toBe(200);
      expect(r.json.link).toContain('/?invite=');
      expect(r.json.mail.sent).toBe(false);
      expect(r.json.mail.reason).toContain('SMTP');
      expect(r.json.invite.mail_error).toContain('SMTP');
      expect(r.json.invite.mail_sent_at).toBeNull();
      const acc = await acceptVia(t2.anon(), tokenOf(r.json.link, 'invite'), { name: '복사 링크', password: NEW_PW });
      expect(acc.status).toBe(200);
    } finally {
      await t2.close();
    }
  });
});

describe('속도 제한', () => {
  it('같은 IP에서 초대 수락 시도는 분당 10회까지 (토큰 추측 방지)', async () => {
    const c = t.anon();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await c.raw({ method: 'POST', url: `/api/invites/${'z'.repeat(43)}/accept`, payload: {}, headers: { 'x-forwarded-for': '10.250.0.9' } });
      codes.push(r.status);
    }
    expect(codes.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('X-Forwarded-For 앞쪽을 바꿔 가며 보내도 우회되지 않는다 (프록시가 붙인 마지막 주소 기준)', async () => {
    const c = t.anon();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await c.raw({ method: 'POST', url: `/api/invites/${'y'.repeat(43)}/accept`, payload: {}, headers: { 'x-forwarded-for': `203.0.113.${i + 1}, 10.250.0.10` } });
      codes.push(r.status);
    }
    expect(codes.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('워크스페이스당 시간당 초대 메일 상한 — 넘으면 생성 · 다시 보내기 429, 다른 워크스페이스는 영향 없음', async () => {
    const o = await otherWorkspace(t, 'invite-budget', [{ email: 'budget.owner@example.com', role: 'owner' }]);
    const oc = await login(t, 'budget.owner@example.com');
    const first = await oc.post(inv(o.ws), { email: 'first.in.budget@example.com', role: 'viewer' });
    expect(first.status).toBe(200);
    await t.db.query(
      `INSERT INTO audit_log (workspace_id, user_id, actor, action) SELECT $1, $2, 'budget', 'invite.create' FROM generate_series(1, 99)`,
      [o.ws, o.users['budget.owner@example.com']],
    );
    const over = await oc.post(inv(o.ws), { email: 'over.budget@example.com', role: 'viewer' });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('invite_rate_limited');
    expect((await oc.post(`${inv(o.ws)}/${first.json.invite.id}/resend`)).status).toBe(429);
    expect((await t.db.query(`SELECT 1 FROM invites WHERE lower(email) = 'over.budget@example.com'`)).rowCount).toBe(0);
    expect((await owner.post(inv(), { email: 'unaffected@example.com', role: 'viewer' })).status).toBe(200);
  });
});
