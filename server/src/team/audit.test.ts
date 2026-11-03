/** team: 감사 로그 조회 — 권한(configure), 필터(작업 접두어 · 사용자 · KST 날짜 · 대상), 커서 페이지, 계정 기록 포함, 가림, CSV, 격리 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { login, otherWorkspace } from './testkit';

let t: TestApp;
let pm: TestClient;
let otherWs: string;
const url = (q = '', ws = t.ws) => `/api/w/${ws}/audit${q}`;

async function insertAudit(rows: { ws?: string | null; user?: string | null; actor?: string; action: string; at?: string; detail?: unknown; targetType?: string; targetId?: string }[]) {
  for (const r of rows) {
    await t.db.query(
      `INSERT INTO audit_log (workspace_id, user_id, actor, action, target_type, target_id, detail, ip, at) VALUES ($1, $2, $3, $4, $5, $6, $7, '10.0.0.1', COALESCE($8::timestamptz, now()))`,
      [r.ws === undefined ? t.ws : r.ws, r.user ?? null, r.actor ?? '시스템', r.action, r.targetType ?? null, r.targetId ?? null, JSON.stringify(r.detail ?? {}), r.at ?? null],
    );
  }
}

beforeAll(async () => {
  t = await createTestApp();
  pm = await login(t, 'pm');
  const o = await otherWorkspace(t, 'audit-other', [{ email: 'audit.other@example.com', role: 'owner' }]);
  otherWs = o.ws;
  await insertAudit([
    { action: 'invite.create', user: t.userIds.admin, actor: '테스트 admin', at: '2026-10-30T03:00:00Z', targetType: 'invite', targetId: 'inv-1' },
    { action: 'invite.revoke', user: t.userIds.admin, actor: '테스트 admin', at: '2026-10-31T14:59:00Z', targetType: 'invite', targetId: 'inv-1' }, // KST 10-31 23:59
    { action: 'member.role_change', user: t.userIds.owner, actor: '테스트 owner', at: '2026-10-31T15:00:00Z', detail: { from: 'ae', to: 'pm' } }, // KST 11-01 00:00
    { action: 'change.approve', user: t.userIds.pm, actor: '테스트 pm', at: '2026-11-01T02:00:00Z', targetType: 'change', targetId: 'chg-1' },
    { action: 'connection.update', user: t.userIds.pm, actor: '테스트 pm', at: '2026-11-01T03:00:00Z', detail: { label: '네이버', credentials: { apiKey: 'AKIA-SECRET' }, token: 'tok-123', nested: { password: 'pw' } } },
    { action: 'auth.loginXfailed', at: '2026-11-01T04:00:00Z' }, // LIKE '_' 이스케이프 확인용
    { action: 'change.apply', ws: null, user: t.userIds.pm, at: '2026-11-01T05:00:00Z' }, // 워크스페이스 없는 비-auth 기록
    { action: 'invite.create', ws: o.ws, user: o.users['audit.other@example.com'], actor: '다른 조직', at: '2026-11-01T06:00:00Z' },
    { action: 'auth.login', ws: null, user: o.users['audit.other@example.com'], actor: '다른 조직', at: '2026-11-01T07:00:00Z' },
  ]);
});
afterAll(async () => { await t?.close(); });

describe('권한 · 격리', () => {
  it('configure(pm · admin · owner)만 조회, ae · client · viewer 403, 비로그인 401, 다른 워크스페이스 404', async () => {
    expect((await pm.get(url())).status).toBe(200);
    for (const role of ['admin', 'owner'] as const) expect((await (await login(t, role)).get(url())).status).toBe(200);
    for (const role of ['ae', 'client', 'viewer'] as const) {
      const c = await login(t, role);
      expect((await c.get(url())).status, role).toBe(403);
      expect((await c.get(`/api/w/${t.ws}/audit.csv`)).status, role).toBe(403);
    }
    expect((await t.anon().get(url())).status).toBe(401);
    expect((await pm.get(url('', otherWs))).status).toBe(404);
    expect((await pm.get(`/api/w/${otherWs}/audit.csv`)).status).toBe(404);
  });

  it('다른 워크스페이스 · 비구성원 계정 기록은 섞이지 않는다', async () => {
    const all = await pm.get(url('?auth=1&limit=200'));
    const actors = all.json.entries.map((e: { actor: string }) => e.actor);
    expect(actors).not.toContain('다른 조직');
    expect(all.json.entries.some((e: { action: string }) => e.action === 'change.apply')).toBe(false);
  });
});

describe('필터', () => {
  it('작업 접두어 · 이스케이프', async () => {
    const r = await pm.get(url('?action=invite.'));
    expect(r.json.entries.map((e: { action: string }) => e.action)).toEqual(['invite.revoke', 'invite.create']);
    const exact = await pm.get(url('?action=member.role'));
    expect(exact.json.entries).toHaveLength(1);
    expect(exact.json.entries[0]).toMatchObject({ action: 'member.role_change', detail: { from: 'ae', to: 'pm' }, actor: '테스트 owner', user_email: 'owner@test.local' });
    const esc = await pm.get(url('?action=auth.login_'));
    expect(esc.json.entries.map((e: { action: string }) => e.action)).not.toContain('auth.loginXfailed');
    expect((await pm.get(url('?action=x%25'))).status).toBe(400);
  });

  it('사용자 · 대상 필터', async () => {
    const r = await pm.get(url(`?userId=${t.userIds.admin}`));
    expect(r.json.entries.map((e: { action: string }) => e.action).sort()).toEqual(['invite.create', 'invite.revoke']);
    const tg = await pm.get(url('?targetType=change&targetId=chg-1'));
    expect(tg.json.entries.map((e: { action: string }) => e.action)).toEqual(['change.approve']);
    expect((await pm.get(url('?userId=nope'))).status).toBe(400);
  });

  it('KST 날짜 경계: from · to 포함, 자정 기준은 KST', async () => {
    const oct31 = await pm.get(url('?from=2026-10-31&to=2026-10-31'));
    expect(oct31.json.entries.map((e: { action: string }) => e.action)).toEqual(['invite.revoke']);
    const nov1 = await pm.get(url('?from=2026-11-01&to=2026-11-01'));
    expect(nov1.json.entries.map((e: { action: string }) => e.action)).toEqual(['auth.loginXfailed', 'connection.update', 'change.approve', 'member.role_change']);
    const bad = await pm.get(url('?from=2026-11-02&to=2026-11-01'));
    expect(bad.status).toBe(400);
    expect((await pm.get(url('?from=2026/11/01'))).status).toBe(400);
    expect((await pm.get(url('?from=&to=&action='))).status).toBe(200);
    // 달력에 없는 날짜는 DB · 날짜 계산 오류(500)가 아니라 400
    for (const q of ['?from=2026-02-31', '?to=2026-13-01', '?from=2026-00-10', '?to=9999-12-31', '?from=2025-02-29']) {
      const r = await pm.get(url(q));
      expect(r.status, q).toBe(400);
      expect(r.json.error.code, q).toBe('bad_request');
    }
    expect((await pm.raw({ method: 'GET', url: `/api/w/${t.ws}/audit.csv?to=2026-02-30` })).status).toBe(400);
    expect((await pm.get(url('?from=2024-02-29&to=2024-02-29'))).status).toBe(200);
    // 공백뿐인 값은 없는 것으로
    const blank = await pm.get(url('?action=%20%20&targetType=%20&from=%20'));
    expect(blank.status).toBe(200);
    expect(blank.json.entries.length).toBeGreaterThan(0);
  });

  it('auth=1이면 구성원의 계정 기록(로그인 등)을 함께 보여 준다', async () => {
    const without = await pm.get(url('?action=auth.login&limit=200'));
    expect(without.json.entries.every((e: { account: boolean }) => !e.account)).toBe(true);
    const withAuth = await pm.get(url('?action=auth.login&auth=1&limit=200'));
    const acct = withAuth.json.entries.filter((e: { account: boolean }) => e.account);
    expect(acct.length).toBeGreaterThan(0);
    expect(acct.every((e: { user_email: string }) => e.user_email.endsWith('@test.local'))).toBe(true);
  });

  it('상세의 비밀값은 가려서 돌려준다', async () => {
    const r = await pm.get(url('?action=connection.update'));
    const d = r.json.entries[0].detail;
    expect(d.label).toBe('네이버');
    expect(d.credentials).toBe('••••');
    expect(d.token).toBe('••••');
    expect(d.nested.password).toBe('••••');
    expect(JSON.stringify(r.json)).not.toMatch(/AKIA-SECRET|tok-123/);
  });
});

describe('커서 페이지', () => {
  it('limit 기본 100 · before 커서 · 마지막 페이지 nextBefore null · 최대 200', async () => {
    await insertAudit(Array.from({ length: 230 }, (_, i) => ({ action: 'state.put', actor: '페이지', detail: { i } })));
    const p1 = await pm.get(url('?action=state.'));
    expect(p1.json.entries).toHaveLength(100);
    expect(typeof p1.json.nextBefore).toBe('number');
    expect(p1.json.nextBefore).toBe(p1.json.entries[99].id);
    const ids1 = p1.json.entries.map((e: { id: number }) => e.id);
    expect([...ids1].sort((a: number, b: number) => b - a)).toEqual(ids1);
    const p2 = await pm.get(url(`?action=state.&before=${p1.json.nextBefore}`));
    expect(p2.json.entries).toHaveLength(100);
    expect(Math.max(...p2.json.entries.map((e: { id: number }) => e.id))).toBeLessThan(Math.min(...ids1));
    const p3 = await pm.get(url(`?action=state.&before=${p2.json.nextBefore}`));
    expect(p3.json.entries).toHaveLength(30);
    expect(p3.json.nextBefore).toBeNull();
    const big = await pm.get(url('?action=state.&limit=200'));
    expect(big.json.entries).toHaveLength(200);
    expect((await pm.get(url('?limit=201'))).status).toBe(400);
    expect((await pm.get(url('?before=-1'))).status).toBe(400);
  });
});

describe('CSV · 선택지', () => {
  it('UTF-8 BOM · 한국어 머리글 · 필터 반영 · 수식 주입 방지 · 내보내기도 감사 기록', async () => {
    await insertAudit([{ action: 'comment.create', actor: '=HYPERLINK("http://evil")', detail: { text: 'a,"b"' } }]);
    const r = await pm.raw({ method: 'GET', url: `/api/w/${t.ws}/audit.csv?action=comment.` });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/csv');
    expect(String(r.headers['content-disposition'])).toMatch(/attachment; filename="audit-mildo-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(r.body.charCodeAt(0)).toBe(0xfeff);
    const lines = r.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('ID,시각(KST),행위자,이메일,작업,작업 설명,대상 유형,대상 ID,상세(JSON),IP,기록 범위');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]).toContain('comment.create');
    expect(lines[1]).toContain('코멘트 작성');
    expect(r.headers['x-audit-rows']).toBe('1');
    const exp = await pm.get(url('?action=audit.export'));
    expect(exp.json.entries[0]).toMatchObject({ action: 'audit.export', detail: { filters: { action: 'comment.' }, rows: 1, truncated: false } });

    const range = await pm.raw({ method: 'GET', url: `/api/w/${t.ws}/audit.csv?from=2026-10-31&to=2026-10-31` });
    expect(range.body).toContain('2026-10-31 23:59:00');
    expect(range.body.slice(1).trim().split('\r\n')).toHaveLength(2);
  });

  it('필터 선택지: 작업 코드(설명 · 건수) · 사용자', async () => {
    const r = await pm.get(`/api/w/${t.ws}/audit/facets`);
    expect(r.status).toBe(200);
    const inviteCreate = r.json.actions.find((a: { action: string }) => a.action === 'invite.create');
    expect(inviteCreate).toMatchObject({ label: '초대 발송', count: 1 });
    expect(r.json.users.map((u: { email: string }) => u.email)).toEqual(expect.arrayContaining(['owner@test.local', 'pm@test.local']));
    expect(r.json.users.map((u: { email: string }) => u.email)).not.toContain('audit.other@example.com');
    expect((await (await login(t, 'ae')).get(`/api/w/${t.ws}/audit/facets`)).status).toBe(403);
  });
});

describe('실제 작업이 감사 로그에 남는다', () => {
  it('초대 · 역할 변경 · 제외가 화면 조회 API에 보인다', async () => {
    const owner = await login(t, 'owner');
    const inv = await owner.post(`/api/w/${t.ws}/invites`, { email: 'audited@example.com', role: 'viewer' });
    await owner.del(`/api/w/${t.ws}/invites/${inv.json.invite.id}`);
    await owner.patch(`/api/w/${t.ws}/members/${t.userIds.viewer}`, { role: 'client' });
    await owner.patch(`/api/w/${t.ws}/members/${t.userIds.viewer}`, { role: 'viewer' });
    const r = await pm.get(url(`?userId=${t.userIds.owner}&limit=10`));
    const actions = r.json.entries.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 4)).toEqual(['member.role_change', 'member.role_change', 'invite.revoke', 'invite.create']);
    expect(JSON.stringify(r.json)).not.toContain('/?invite=');
  });
});
