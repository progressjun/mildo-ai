/** 코어 기반 테스트: 인증 · CSRF · 테넌트 격리 · 권한 표 · 감사 · 잡 큐 · 이벤트 · 암호화 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app';
import { can, permissionsOf } from '../src/auth/permissions';
import { encryptSecret, decryptSecret, hashPassword, verifyPassword, passwordProblem, mask } from '../src/lib/crypto';
import { enqueue, claim, runJob, registerJob, drain, _resetJobsForTest } from '../src/jobs/queue';
import { publish } from '../src/events/hub';
import { redact } from '../src/audit/audit';
import { kstParts, addDaysStr, dateRange, setNowForTest } from '../src/lib/time';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t?.close(); });

describe('인증', () => {
  it('로그인 → me → 로그아웃, 잘못된 비밀번호는 401 · 감사 기록', async () => {
    const bad = await t.anon().post('/api/auth/login', { email: 'pm@test.local', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe('invalid_credentials');
    const pm = await t.login('pm');
    const me = await pm.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe('pm@test.local');
    expect(me.json.workspaces).toHaveLength(1);
    expect(me.json.workspaces[0].role).toBe('pm');
    expect(me.json.workspaces[0].demoRole).toBe('PM');
    expect(me.json.user.password_hash).toBeUndefined();
    const out = await pm.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect((await pm.get('/api/auth/me')).status).toBe(401);
    const logs = await t.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'auth.%'`);
    expect(logs.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login', 'auth.logout']));
  });

  it('쓰기 요청은 CSRF 토큰이 맞아야 한다', async () => {
    const ae = await t.login('ae');
    const ok = await ae.post('/api/auth/logout');
    expect(ok.status).toBe(200);
    const ae2 = await t.login('ae');
    const r = await ae2.raw({ method: 'POST', url: '/api/auth/logout', headers: { 'x-csrf-token': 'forged' } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('csrf');
  });
});

describe('테넌트 격리 · 권한', () => {
  it('멤버가 아닌 워크스페이스는 404, 잘못된 id도 404', async () => {
    const other = await t.db.query<{ id: string }>(
      `INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-brand', '다른 브랜드', '다른') RETURNING id`, [t.orgId],
    );
    const pm = await t.login('pm');
    expect((await pm.get(`/api/w/${t.ws}`)).status).toBe(200);
    expect((await pm.get(`/api/w/${other.rows[0].id}`)).status).toBe(404);
    expect((await pm.get('/api/w/not-a-uuid')).status).toBe(404);
    expect((await t.anon().get(`/api/w/${t.ws}`)).status).toBe(401);
  });

  it('워크스페이스 정보에 역할 · 권한이 들어 있다', async () => {
    const client = await t.login('client');
    const r = await client.get(`/api/w/${t.ws}`);
    expect(r.json.role).toBe('client');
    expect(r.json.demoRole).toBe('수면밀도');
    expect(r.json.permissions).toContain('approve:CLIENT');
    expect(r.json.permissions).not.toContain('configure');
  });

  it('권한 표: viewer는 읽기만, ae는 AE 승인만, owner는 전부', () => {
    expect(permissionsOf('viewer')).toEqual(['read']);
    expect(can('ae', 'approve:AE')).toBe(true);
    expect(can('ae', 'approve:PM')).toBe(false);
    expect(can('pm', 'configure')).toBe(true);
    expect(can('pm', 'manage_team')).toBe(false);
    expect(can('admin', 'approve:CLIENT')).toBe(false);
    expect(can('owner', 'approve:CLIENT')).toBe(true);
    expect(can('client', 'operate')).toBe(false);
  });
});

describe('잡 큐', () => {
  it('dedupe · 실패 재시도 · 최종 실패', async () => {
    _resetJobsForTest();
    let calls = 0;
    registerJob('test.flaky', async () => { calls++; if (calls < 2) throw new Error('일시 오류'); return { ok: true }; });
    registerJob('test.always', async () => { throw new Error('항상 실패'); });
    const a = await enqueue(t.db, { type: 'test.flaky', workspaceId: t.ws, dedupeKey: 'k1' });
    const b = await enqueue(t.db, { type: 'test.flaky', workspaceId: t.ws, dedupeKey: 'k1' });
    expect(a).toBeTypeOf('number');
    expect(b).toBeNull();
    const j1 = await claim(t.db, 'w1', ['test.flaky']);
    await t.db.query(`UPDATE jobs SET status='queued', attempts=0, locked_at=NULL WHERE id=$1`, [j1!.id]);
    const j2 = await claim(t.db, 'w1', ['test.flaky']);
    expect(await runJob(t.db, t.config, j2!, () => undefined)).toBe('retry');
    await t.db.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [j2!.id]);
    expect(await drain(t.db, t.config, { types: ['test.flaky'] })).toBe(1);
    const done = await t.db.query<{ status: string; result: unknown }>('SELECT status, result FROM jobs WHERE id = $1', [a]);
    expect(done.rows[0]).toMatchObject({ status: 'done', result: { ok: true } });
    const f = await enqueue(t.db, { type: 'test.always', maxAttempts: 1 });
    await drain(t.db, t.config, { types: ['test.always'] });
    const fr = await t.db.query<{ status: string; last_error: string }>('SELECT status, last_error FROM jobs WHERE id = $1', [f]);
    expect(fr.rows[0].status).toBe('failed');
    expect(fr.rows[0].last_error).toContain('항상 실패');
  });
});

describe('이벤트 허브', () => {
  it('publish → 같은 워크스페이스 구독자만 받는다', async () => {
    const got: string[] = [];
    const other: string[] = [];
    const off1 = t.events.subscribe(t.ws, (e) => got.push(`${e.type}:${e.id}`));
    const off2 = t.events.subscribe('00000000-0000-0000-0000-000000000000', (e) => other.push(e.type));
    await publish(t.db, t.ws, { type: 'change', id: 'c1' });
    for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    off1(); off2();
    expect(got).toEqual(['change:c1']);
    expect(other).toEqual([]);
  });
});

describe('보안 유틸', () => {
  it('비밀값 암호화 왕복 · 변조 감지 · 마스킹 · 감사 가림', () => {
    const key = t.config.encryptionKey;
    const enc = encryptSecret('secret-token-123', key);
    expect(enc).not.toContain('secret-token');
    expect(decryptSecret(enc, key)).toBe('secret-token-123');
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(mask('abcdefghijkl')).toBe('abcd••••(12자)');
    expect(redact({ apiKey: 'x', nested: { webhookUrl: 'https://hooks', name: 'ok' } })).toEqual({ apiKey: '••••', nested: { webhookUrl: '••••', name: 'ok' } });
  });
  it('비밀번호 해시 · 정책', async () => {
    const h = await hashPassword('Abcdefgh12');
    expect(await verifyPassword('Abcdefgh12', h)).toBe(true);
    expect(await verifyPassword('abcdefgh12', h)).toBe(false);
    expect(passwordProblem('short')).toMatch(/10자/);
    expect(passwordProblem('alllowercaseletters')).toMatch(/2가지/);
    expect(passwordProblem('Abcdefgh12')).toBeNull();
  });
  it('KST 시간 헬퍼', () => {
    setNowForTest(Date.parse('2026-10-31T06:30:00Z'));
    expect(kstParts()).toMatchObject({ date: '2026-10-31', hour: 15, minute: 30, weekday: 6 });
    setNowForTest(Date.parse('2026-10-31T15:30:00Z'));
    expect(kstParts().date).toBe('2026-11-01');
    setNowForTest(null);
    expect(addDaysStr('2026-02-28', 1)).toBe('2026-03-01');
    expect(dateRange('2026-10-30', '2026-11-01')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});

describe('헬스', () => {
  it('GET /api/health', async () => {
    const r = await t.anon().get('/api/health');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });
});
