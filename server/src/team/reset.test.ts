/**
 * team: 비밀번호 재설정의 정직한 안내 · 복구 경로
 *  - SMTP가 없으면 POST /auth/password-reset이 mail.configured=false를 알리고(계정 존재와 무관한 서버 전역 사실) 링크를 만들지 않는다
 *  - 관리자 · 소유자는 팀 화면에서 구성원의 재설정 링크를 발급할 수 있다 (POST /w/:ws/members/:userId/password-reset)
 *    메일로 보냈으면 링크를 돌려주지 않고, 못 보냈으면 직접 전달할 링크를 돌려준다 · 권한 · 관리 범위 · 감사
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { clearTestOutbox, getTestOutbox, setTestMailConfigured } from '../lib/mailer';
import { addUser, login, loginAs, otherWorkspace, postFrom, tokenOf, linkIn } from './testkit';

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
afterEach(() => setTestMailConfigured(true));

const NEXT = 'Recovered#Pass2027';
const issue = (c: TestClient, userId: string) => c.post(`/api/w/${t.ws}/members/${userId}/password-reset`, {});
const resetRows = async (userId: string) => (await t.db.query<{ used_at: Date | null }>('SELECT used_at FROM password_resets WHERE user_id = $1', [userId])).rows;

describe('로그인 화면의 재설정 요청 — SMTP 미설정', () => {
  it('mail.configured=false를 알리고 링크를 만들지 않는다 (가입 여부와 같은 응답) · 요청은 감사에 남는다', async () => {
    setTestMailConfigured(false);
    const id = await addUser(t, 'no.smtp@example.com', 'ae');
    const known = await postFrom(t.anon(), '/api/auth/password-reset', { email: 'no.smtp@example.com' });
    const unknown = await postFrom(t.anon(), '/api/auth/password-reset', { email: 'nobody.here@example.com' });
    expect(known.status).toBe(200);
    expect(known.json).toEqual({ ok: true, mail: { configured: false } });
    expect(unknown.json).toEqual(known.json);
    expect(await resetRows(id)).toHaveLength(0);
    expect(getTestOutbox()).toHaveLength(0);
    const a = await t.db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM audit_log WHERE action = 'auth.password_reset_request' AND user_id = $1`, [id]);
    expect(a.rows[0]?.detail).toMatchObject({ delivered: false, reason: 'smtp_not_configured' });
  });

  it('SMTP가 있으면 mail.configured=true · 메일 발송', async () => {
    await addUser(t, 'with.smtp@example.com', 'ae');
    const r = await postFrom(t.anon(), '/api/auth/password-reset', { email: 'with.smtp@example.com' });
    expect(r.json).toEqual({ ok: true, mail: { configured: true } });
    expect(getTestOutbox().filter((m) => m.to === 'with.smtp@example.com')).toHaveLength(1);
  });
});

describe('관리자의 재설정 링크 발급', () => {
  it('SMTP 미설정: 직접 전달할 링크를 돌려주고, 그 링크로 비밀번호를 바꿔 로그인할 수 있다 · 감사에 링크는 없다', async () => {
    setTestMailConfigured(false);
    const id = await addUser(t, 'locked.out@example.com', 'pm');
    const r = await issue(owner, id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, email: 'locked.out@example.com', mail: { sent: false } });
    expect(r.json.mail.reason).toMatch(/SMTP/);
    expect(r.json.link).toMatch(/\/\?reset=[A-Za-z0-9_-]+$/);
    const token = tokenOf(r.json.link, 'reset');
    // 다른 사람이 로그인 화면에서 재설정을 요청해도(SMTP 없음) 발급된 링크는 무효가 되지 않는다
    await postFrom(t.anon(), '/api/auth/password-reset', { email: 'locked.out@example.com' });
    expect((await postFrom(t.anon(), '/api/auth/password-reset/check', { token })).json).toMatchObject({ valid: true });
    expect((await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token, password: NEXT })).status).toBe(200);
    expect((await loginAs(t, 'locked.out@example.com', NEXT)).status).toBe(200);
    const a = await t.db.query<{ detail: Record<string, unknown>; workspace_id: string }>(
      `SELECT detail, workspace_id FROM audit_log WHERE action = 'member.password_reset_issue' AND target_id = $1`, [id],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].workspace_id).toBe(t.ws);
    expect(a.rows[0].detail).toMatchObject({ email: 'locked.out@example.com', delivery: 'link' });
    expect(JSON.stringify(a.rows[0].detail)).not.toContain(token);
  });

  it('SMTP 설정: 본인 메일로 보내고 링크는 관리자에게 돌려주지 않는다 · 이전 링크는 무효', async () => {
    const id = await addUser(t, 'mail.reset@example.com', 'client');
    const first = await issue(admin, id);
    expect(first.status).toBe(200);
    expect(first.json.mail).toEqual({ sent: true });
    expect(first.json.link).toBeUndefined();
    const mails = getTestOutbox().filter((m) => m.to === 'mail.reset@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('관리자');
    const firstToken = tokenOf(linkIn(mails[0].text, 'reset')!, 'reset');
    await issue(admin, id);
    expect((await postFrom(t.anon(), '/api/auth/password-reset/check', { token: firstToken })).json).toMatchObject({ valid: false, reason: 'used' });
  });

  it('권한 · 범위: 팀 관리 권한 없음 403 · 자기 자신 · 소유자(관리자가) · 비활성 · 관리 범위 밖 계정은 거부', async () => {
    const pm = await login(t, 'pm');
    const target = await addUser(t, 'scope.target@example.com', 'viewer');
    expect((await issue(pm, target)).status).toBe(403);
    expect((await issue(admin, t.userIds.admin)).json.error.code).toBe('self_reset');
    expect((await issue(admin, t.userIds.owner)).json.error.code).toBe('owner_only');
    expect((await issue(owner, t.userIds.owner)).json.error.code).toBe('self_reset');
    const disabled = await addUser(t, 'disabled.target@example.com', 'ae');
    expect((await admin.patch(`/api/w/${t.ws}/members/${disabled}`, { status: 'disabled' })).status).toBe(200);
    expect((await issue(admin, disabled)).json.error.code).toBe('inactive_account');
    const o = await otherWorkspace(t, 'reset-iso', [{ email: 'shared.reset@example.com', role: 'pm' }]);
    const shared = o.users['shared.reset@example.com'];
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`, [t.ws, shared]);
    const r = await issue(admin, shared);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('shared_account');
    expect(await resetRows(shared)).toHaveLength(0);
    // 다른 워크스페이스의 구성원은 이 워크스페이스 경로로 찾을 수 없다
    const outsider = await otherWorkspace(t, 'reset-iso2', [{ email: 'outsider.reset@example.com', role: 'ae' }]);
    expect((await issue(owner, outsider.users['outsider.reset@example.com'])).status).toBe(404);
    expect((await issue(owner, 'not-a-uuid')).status).toBe(404);
  });

  it('같은 계정에 15분 안에 3번까지 (메일 폭탄 방지)', async () => {
    const id = await addUser(t, 'many.reset@example.com', 'ae');
    for (let i = 0; i < 3; i++) expect((await issue(owner, id)).status).toBe(200);
    const over = await issue(owner, id);
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('reset_rate_limited');
  });
});
