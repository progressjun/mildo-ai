/** team: 비밀번호 변경 · 재설정(메일 링크, 1회용 · 1시간) · 내 세션 목록 · 강제 종료 · 정리 스케줄 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../../test/app';
import { clearTestOutbox, getTestOutbox } from '../lib/mailer';
import { passwordProblem } from '../lib/crypto';
import { sha256 } from '../lib/ids';
import { passwordHint } from '@/modules/team/engine';
import { addUser, getFrom, linkIn, login, loginAs, postFrom, tokenOf } from './testkit';
import { cleanupExpired, jobs } from './index';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t?.close(); });
beforeEach(() => clearTestOutbox());

const NEXT = 'Changed#Pass2027';
const mailsTo = (to: string) => getTestOutbox().filter((m) => m.to === to);

describe('비밀번호 변경', () => {
  it('비로그인 401 · 현재 비밀번호 불일치 400(감사) · 정책 · 같은 비밀번호 거부', async () => {
    expect((await t.anon().post('/api/auth/password', { current: 'x', next: NEXT })).status).toBe(401);
    await addUser(t, 'pw.user@example.com', 'ae');
    const c = await login(t, 'pw.user@example.com');
    const wrong = await c.post('/api/auth/password', { current: 'Wrong#Pass2027', next: NEXT });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe('invalid_current');
    expect((await t.db.query(`SELECT 1 FROM audit_log a JOIN users u ON u.id = a.user_id WHERE a.action = 'auth.password_change_failed' AND u.email = 'pw.user@example.com'`)).rowCount).toBe(1);
    const weak = await c.post('/api/auth/password', { current: TEST_PASSWORD, next: 'alllowercaseletters' });
    expect(weak.status).toBe(400);
    expect(weak.json.error.code).toBe('weak_password');
    expect(weak.json.error.message).toContain('2가지');
    const same = await c.post('/api/auth/password', { current: TEST_PASSWORD, next: TEST_PASSWORD });
    expect(same.json.error.code).toBe('same_password');
    expect((await c.post('/api/auth/password', { next: NEXT })).status).toBe(400);
  });

  it('성공하면 다른 세션은 모두 끊기고 현재 세션은 유지, 새 비밀번호로만 로그인 · 알림 메일 · 감사', async () => {
    await addUser(t, 'pw.change@example.com', 'pm');
    const here = await login(t, 'pw.change@example.com');
    const laptop = await login(t, 'pw.change@example.com');
    const phone = await login(t, 'pw.change@example.com');
    const r = await here.post('/api/auth/password', { current: TEST_PASSWORD, next: NEXT });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, revokedSessions: 2 });
    expect((await here.get('/api/auth/me')).status).toBe(200);
    expect((await laptop.get('/api/auth/me')).status).toBe(401);
    expect((await phone.get('/api/auth/me')).status).toBe(401);
    expect((await loginAs(t, 'pw.change@example.com', TEST_PASSWORD)).status).toBe(401);
    expect((await loginAs(t, 'pw.change@example.com', NEXT)).status).toBe(200);
    expect(mailsTo('pw.change@example.com').map((m) => m.subject)).toEqual(['[MILDO OS] 비밀번호가 변경되었습니다']);
    const a = await t.db.query<{ detail: { revokedSessions: number }; workspace_id: string | null }>(
      `SELECT a.detail, a.workspace_id FROM audit_log a JOIN users u ON u.id = a.user_id WHERE a.action = 'auth.password_change' AND u.email = 'pw.change@example.com'`,
    );
    expect(a.rows[0]).toMatchObject({ workspace_id: null, detail: { revokedSessions: 2 } });
  });

  it('화면의 비밀번호 안내(passwordHint)는 서버 정책과 같다', () => {
    for (const pw of ['', 'short', 'alllowercaseletters', 'ALLUPPERCASE', '1234567890', 'Abcdefgh12', 'abcdefgh1!', '한글비밀번호입니다아아', 'abc defgh i9']) {
      expect(passwordHint(pw), pw).toBe(passwordProblem(pw));
    }
  });
});

describe('비밀번호 재설정', () => {
  it('없는 이메일도 200 · 메일 없음, 형식 오류는 400', async () => {
    const r = await postFrom(t.anon(), '/api/auth/password-reset', { email: 'nobody@example.com' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, mail: { configured: true } }); // 메일 설정 여부는 서버 전역 사실 — 계정 존재와 무관하게 같다
    expect(getTestOutbox()).toHaveLength(0);
    expect((await postFrom(t.anon(), '/api/auth/password-reset', { email: 'not-email' })).status).toBe(400);
  });

  it('요청 → 메일 링크 → 확인 → 새 비밀번호, 모든 세션 종료, 링크는 1회용', async () => {
    await addUser(t, 'Reset.Me@Example.com', 'viewer');
    const s1 = await login(t, 'reset.me@example.com');
    const r = await postFrom(t.anon(), '/api/auth/password-reset', { email: '  RESET.me@example.com ' });
    expect(r.status).toBe(200);
    const mails = mailsTo('Reset.Me@Example.com');
    expect(mails).toHaveLength(1);
    const link = linkIn(mails[0].text, 'reset');
    expect(link).toMatch(new RegExp(`^${t.config.appUrl.replace(/[/.:]/g, '\\$&')}/\\?reset=`));
    const token = tokenOf(link!, 'reset');
    const stored = await t.db.query<{ token_hash: string; expires_at: Date; created_at: Date }>(
      `SELECT token_hash, expires_at, created_at FROM password_resets WHERE token_hash = $1`, [sha256(token)],
    );
    expect(stored.rowCount).toBe(1);
    const minutes = (new Date(stored.rows[0].expires_at).getTime() - new Date(stored.rows[0].created_at).getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(60);

    const check = await postFrom(t.anon(), '/api/auth/password-reset/check', { token });
    expect(check.json).toMatchObject({ valid: true, email: 'Re••••@Example.com' });
    // 토큰을 URL 경로에 싣는 조회는 없다 (요청 로그에 재설정 토큰이 남지 않게)
    expect((await getFrom(t.anon(), `/api/auth/password-reset/${token}`)).status).toBe(404);

    const weak = await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token, password: 'weak' });
    expect(weak.json.error.code).toBe('weak_password');
    const ok = await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token, password: NEXT });
    expect(ok.status).toBe(200);
    expect(ok.json.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await s1.get('/api/auth/me')).status).toBe(401);
    expect((await loginAs(t, 'reset.me@example.com', NEXT)).status).toBe(200);
    expect((await loginAs(t, 'reset.me@example.com', TEST_PASSWORD)).status).toBe(401);

    const reuse = await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token, password: 'Another#Pass2027' });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error.code).toBe('reset_used');
    expect((await postFrom(t.anon(), '/api/auth/password-reset/check', { token })).json).toEqual({ valid: false, reason: 'used' });
    const actions = (await t.db.query<{ action: string }>(
      `SELECT a.action FROM audit_log a JOIN users u ON u.id = a.user_id WHERE u.email = 'Reset.Me@Example.com' AND a.action LIKE 'auth.password_reset%' ORDER BY a.id`,
    )).rows.map((x) => x.action);
    expect(actions).toEqual(['auth.password_reset_request', 'auth.password_reset']);
  });

  it('만료된 링크 · 새로 요청해 바뀐 이전 링크 · 잘못된 토큰은 거부', async () => {
    await addUser(t, 'expiry@example.com', 'viewer');
    await postFrom(t.anon(), '/api/auth/password-reset', { email: 'expiry@example.com' });
    const first = tokenOf(linkIn(mailsTo('expiry@example.com')[0].text, 'reset')!, 'reset');
    await postFrom(t.anon(), '/api/auth/password-reset', { email: 'expiry@example.com' });
    const second = tokenOf(linkIn(mailsTo('expiry@example.com')[1].text, 'reset')!, 'reset');
    expect((await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token: first, password: NEXT })).json.error.code).toBe('reset_used');
    await t.db.query(`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256(second)]);
    const exp = await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token: second, password: NEXT });
    expect(exp.status).toBe(400);
    expect(exp.json.error.code).toBe('reset_expired');
    expect((await postFrom(t.anon(), '/api/auth/password-reset/check', { token: second })).json.reason).toBe('expired');
    expect((await postFrom(t.anon(), '/api/auth/password-reset/check', { token: 'bad' })).json).toEqual({ valid: false, reason: 'invalid' });
    expect((await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token: 'x'.repeat(43), password: NEXT })).json.error.code).toBe('reset_invalid');
    expect((await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token: 'bad', password: NEXT })).json.error.code).toBe('reset_invalid');
    expect((await loginAs(t, 'expiry@example.com')).status).toBe(200);
  });

  it('비활성 계정은 메일을 보내지 않는다 · 같은 계정은 15분에 3통까지', async () => {
    const id = await addUser(t, 'inactive.reset@example.com', 'viewer');
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);
    expect((await postFrom(t.anon(), '/api/auth/password-reset', { email: 'inactive.reset@example.com' })).status).toBe(200);
    expect(mailsTo('inactive.reset@example.com')).toHaveLength(0);
    await addUser(t, 'bomb@example.com', 'viewer');
    for (let i = 0; i < 5; i++) expect((await postFrom(t.anon(), '/api/auth/password-reset', { email: 'bomb@example.com' })).status).toBe(200);
    expect(mailsTo('bomb@example.com')).toHaveLength(3);
  });

  it('비밀번호를 바꾸면 아직 쓰지 않은 재설정 링크도 무효 · 비활성화된 계정의 링크는 거부', async () => {
    await addUser(t, 'change.kills.reset@example.com', 'viewer');
    await postFrom(t.anon(), '/api/auth/password-reset', { email: 'change.kills.reset@example.com' });
    const token = tokenOf(linkIn(mailsTo('change.kills.reset@example.com')[0].text, 'reset')!, 'reset');
    const c = await login(t, 'change.kills.reset@example.com');
    expect((await c.post('/api/auth/password', { current: TEST_PASSWORD, next: NEXT })).status).toBe(200);
    const late = await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token, password: 'Attacker#Pass2027' });
    expect(late.status).toBe(400);
    expect(late.json.error.code).toBe('reset_used');
    expect((await loginAs(t, 'change.kills.reset@example.com', NEXT)).status).toBe(200);

    const id = await addUser(t, 'disabled.after.mail@example.com', 'viewer');
    await postFrom(t.anon(), '/api/auth/password-reset', { email: 'disabled.after.mail@example.com' });
    const t2 = tokenOf(linkIn(mailsTo('disabled.after.mail@example.com')[0].text, 'reset')!, 'reset');
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);
    expect((await postFrom(t.anon(), '/api/auth/password-reset/check', { token: t2 })).json).toEqual({ valid: false, reason: 'invalid' });
    const r = await postFrom(t.anon(), '/api/auth/password-reset/confirm', { token: t2, password: NEXT });
    expect(r.json.error.code).toBe('reset_invalid');
    const hash = (await t.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id])).rows[0].password_hash;
    expect(hash).toBeTruthy();
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.password_reset' AND user_id = $1`, [id])).rowCount).toBe(0);
  });

  it('X-Forwarded-For 앞쪽을 꾸며도 분당 5회 제한은 프록시가 붙인 주소 기준으로 걸린다', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await t.anon().raw({ method: 'POST', url: '/api/auth/password-reset', payload: { email: 'nobody@example.com' }, headers: { 'x-forwarded-for': `198.51.100.${i + 1}, 10.251.9.9` } })).status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('같은 IP에서 분당 5회 초과 요청은 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await postFrom(t.anon(), '/api/auth/password-reset', { email: 'nobody@example.com' }, '10.251.1.1')).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    // 다른 IP는 영향 없음
    expect((await postFrom(t.anon(), '/api/auth/password-reset', { email: 'nobody@example.com' }, '10.251.1.2')).status).toBe(200);
  });
});

describe('내 세션', () => {
  it('목록은 내 세션만 · current 표시 · id는 토큰 해시가 아닌 짧은 공개 id', async () => {
    await addUser(t, 'sessions@example.com', 'ae');
    const a = await login(t, 'sessions@example.com');
    const b = await login(t, 'sessions@example.com');
    const other = await login(t, 'viewer');
    const r = await a.get('/api/auth/sessions');
    expect(r.status).toBe(200);
    expect(r.json.sessions).toHaveLength(2);
    expect(r.json.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const dbIds = (await t.db.query<{ id: string }>(`SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'sessions@example.com'`)).rows.map((x) => x.id);
    for (const s of r.json.sessions) {
      expect(s.id).toMatch(/^[0-9a-f]{24}$/);
      expect(dbIds).not.toContain(s.id);
      expect(dbIds.some((d) => d.startsWith(s.id))).toBe(false);
      expect(s.ip).toMatch(/^10\./);
    }
    expect(JSON.stringify(r.json)).not.toMatch(/csrf/i);
    expect((await t.anon().get('/api/auth/sessions')).status).toBe(401);

    // 다른 사람 세션 id로는 지울 수 없다
    const theirs = (await other.get('/api/auth/sessions')).json.sessions[0].id;
    expect((await a.del(`/api/auth/sessions/${theirs}`)).status).toBe(404);
    expect((await a.del('/api/auth/sessions/zzz')).status).toBe(404);
    expect((await other.get('/api/auth/me')).status).toBe(200);

    // b 세션 종료
    const bId = (await b.get('/api/auth/sessions')).json.sessions.find((s: { current: boolean }) => s.current).id;
    const del = await a.del(`/api/auth/sessions/${bId}`);
    expect(del.json).toEqual({ ok: true, current: false });
    expect((await b.get('/api/auth/me')).status).toBe(401);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    const au = await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.session_revoke' AND target_id = $1`, [bId]);
    expect(au.rowCount).toBe(1);

    // 현재 세션 종료 = 로그아웃 (쿠키 삭제)
    const aId = (await a.get('/api/auth/sessions')).json.sessions[0].id;
    const self = await a.del(`/api/auth/sessions/${aId}`);
    expect(self.json.current).toBe(true);
    expect((await a.get('/api/auth/me')).status).toBe(401);
  });

  it('다른 기기 모두 로그아웃', async () => {
    await addUser(t, 'others@example.com', 'ae');
    const here = await login(t, 'others@example.com');
    const x = await login(t, 'others@example.com');
    const y = await login(t, 'others@example.com');
    const r = await here.del('/api/auth/sessions');
    expect(r.json).toEqual({ ok: true, revoked: 2 });
    expect((await x.get('/api/auth/me')).status).toBe(401);
    expect((await y.get('/api/auth/me')).status).toBe(401);
    expect((await here.get('/api/auth/sessions')).json.sessions).toHaveLength(1);
  });

  it('쓰기 요청은 CSRF 토큰이 필요하다', async () => {
    const c = await login(t, 'ae');
    const r = await c.raw({ method: 'DELETE', url: '/api/auth/sessions', headers: { 'x-csrf-token': 'forged' } });
    expect(r.status).toBe(403);
    const p = await c.raw({ method: 'POST', url: '/api/auth/password', payload: { current: TEST_PASSWORD, next: NEXT }, headers: { 'x-csrf-token': 'forged' } });
    expect(p.status).toBe(403);
  });
});

describe('정리 스케줄', () => {
  it('team.cleanup: 만료 하루 지난 세션 · 만료 7일 지난 재설정 토큰 삭제', async () => {
    const id = await addUser(t, 'cleanup@example.com', 'viewer');
    await t.db.query(`INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES ('old-s', $1, 'c', now() - interval '2 days'), ('fresh-s', $1, 'c', now() + interval '1 day')`, [id]);
    await t.db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ('old-r', $1, now() - interval '8 days'), ('new-r', $1, now() - interval '1 hour')`, [id]);
    const r = await cleanupExpired(t.db);
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(r.resets).toBeGreaterThanOrEqual(1);
    const left = await t.db.query<{ id: string }>(`SELECT id FROM sessions WHERE user_id = $1`, [id]);
    expect(left.rows.map((x) => x.id)).toEqual(['fresh-s']);
    expect((await t.db.query(`SELECT 1 FROM password_resets WHERE token_hash = 'new-r'`)).rowCount).toBe(1);

    const schedules: { name: string; cron: string }[] = [];
    const jobTypes: string[] = [];
    jobs({ job: (type) => jobTypes.push(type), schedule: (name, cron) => schedules.push({ name, cron }) });
    expect(schedules).toEqual([{ name: 'team.cleanup', cron: '17 4 * * *' }]);
    expect(jobTypes).toEqual([]);
  });
});
