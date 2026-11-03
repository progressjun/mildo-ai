/** platform(state) 도메인: 코멘트 · workspace_state API — 권한 · 테넌트 격리 · 입력 검증 · 감사 · 이벤트 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient, type TestResponse } from '../../test/app';
import { canonicalJson, STATE_MAX_KEYS } from './service';
import type { Role } from '../auth/permissions';

let t: TestApp;
let otherWs: string;
const c: Partial<Record<Role, TestClient>> = {};

beforeAll(async () => {
  t = await createTestApp();
  for (const r of ['owner', 'admin', 'pm', 'ae', 'client', 'viewer'] as Role[]) c[r] = await t.login(r);
  const o = await t.db.query<{ id: string }>(
    `INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-state', '다른 브랜드', '다른') RETURNING id`, [t.orgId],
  );
  otherWs = o.rows[0].id;
});
afterAll(async () => { await t?.close(); });

const url = (p: string, ws = t.ws) => `/api/w/${ws}${p}`;

/** 이벤트 허브 구독 → fn 실행 → 받은 이벤트 */
async function captureEvents(fn: () => Promise<unknown>, ws = t.ws): Promise<string[]> {
  const got: string[] = [];
  const off = t.events.subscribe(ws, (e) => got.push(`${e.type}:${e.id ?? ''}`));
  try {
    await fn();
    for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    off();
  }
  return got;
}

describe('코멘트 API', () => {
  it('작성 → 목록: 작성자는 세션 사용자 이름 · 역할, 클라이언트 id를 그대로 쓴다 · 감사 · comment 이벤트', async () => {
    let r: TestResponse | null = null;
    const events = await captureEvents(async () => {
      r = await c.client!.post(url('/comments'), { comment: { id: 'cm_client_1', target: 'reports:daily:fact', text: '  배송 지연 문구 확인 부탁드립니다  ', author: '위조된 이름' } });
    });
    expect(r!.status).toBe(201);
    expect(r!.json.comment).toMatchObject({ id: 'cm_client_1', target: 'reports:daily:fact', author: '테스트 client', authorUser: t.userIds.client, authorRole: 'client', text: '배송 지연 문구 확인 부탁드립니다', resolved: false });
    expect(Date.parse(r!.json.comment.at)).toBeGreaterThan(0);
    expect(events).toContain('comment:cm_client_1');

    const list = await c.viewer!.get(url('/comments'));
    expect(list.status).toBe(200);
    expect(list.json.comments.map((x: { id: string }) => x.id)).toContain('cm_client_1');

    const a = await t.db.query<{ action: string; actor: string; target_id: string; detail: { target: string } }>(`SELECT action, actor, target_id, detail FROM audit_log WHERE action = 'comment.create'`);
    expect(a.rows[0]).toMatchObject({ actor: '테스트 client', target_id: 'cm_client_1', detail: { target: 'reports:daily:fact' } });
  });

  it('id를 보내지 않으면 서버가 만든다 · target 필터 · 시간순', async () => {
    const r1 = await c.ae!.post(url('/comments'), { comment: { target: 'reports:weekly:ai', text: '첫 번째' } });
    const r2 = await c.pm!.post(url('/comments'), { comment: { target: 'reports:weekly:ai', text: '두 번째' } });
    expect(r1.status).toBe(201);
    expect(r1.json.comment.id).toMatch(/^cm_/);
    expect(r1.json.comment.authorRole).toBe('ae');
    const list = await c.ae!.get(url('/comments?target=reports:weekly:ai'));
    expect(list.json.comments.map((x: { text: string }) => x.text)).toEqual(['첫 번째', '두 번째']);
    expect(list.json.comments.every((x: { target: string }) => x.target === 'reports:weekly:ai')).toBe(true);
    expect(r2.json.comment.authorRole).toBe('pm');
  });

  it('같은 id 재시도는 멱등(200), 다른 사람 · 다른 내용이면 409', async () => {
    const body = { comment: { id: 'cm_retry', target: 'flow:chg_1', text: '확인했습니다' } };
    expect((await c.pm!.post(url('/comments'), body)).status).toBe(201);
    const again = await c.pm!.post(url('/comments'), body);
    expect(again.status).toBe(200);
    expect(again.json.comment.id).toBe('cm_retry');
    expect((await c.ae!.post(url('/comments'), body)).status).toBe(409);
    expect((await c.pm!.post(url('/comments'), { comment: { ...body.comment, text: '다른 내용' } })).status).toBe(409);
    const n = await t.db.query(`SELECT 1 FROM comments WHERE id = 'cm_retry'`);
    expect(n.rowCount).toBe(1);
  });

  it('입력 검증: 빈 내용 · 대상 없음 · 잘못된 id · 너무 긴 내용 → 400', async () => {
    expect((await c.pm!.post(url('/comments'), { comment: { target: 'x', text: '   ' } })).status).toBe(400);
    expect((await c.pm!.post(url('/comments'), { comment: { text: '대상 없음' } })).status).toBe(400);
    expect((await c.pm!.post(url('/comments'), { comment: { id: '../../etc', target: 'x', text: 'y' } })).status).toBe(400);
    expect((await c.pm!.post(url('/comments'), { comment: { target: 'x', text: 'a'.repeat(4001) } })).status).toBe(400);
    const r = await c.pm!.post(url('/comments'), {});
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/입력값을 확인/);
  });

  it('해결 처리(PATCH resolved) → 감사 before/after · 이벤트, 되돌리기 가능, 같은 값이면 기록 없음', async () => {
    const events = await captureEvents(async () => {
      const r = await c.ae!.patch(url('/comments/cm_client_1'), { resolved: true });
      expect(r.status).toBe(200);
      expect(r.json.comment).toMatchObject({ id: 'cm_client_1', resolved: true });
      expect(r.json.comment.resolvedAt).toBeTruthy();
    });
    expect(events).toContain('comment:cm_client_1');
    const same = await c.ae!.patch(url('/comments/cm_client_1'), { resolved: true });
    expect(same.status).toBe(200);
    const reopen = await c.pm!.patch(url('/comments/cm_client_1'), { resolved: false });
    expect(reopen.json.comment).toMatchObject({ resolved: false, resolvedAt: null });
    const a = await t.db.query<{ action: string; detail: { before: { resolved: boolean }; after: { resolved: boolean } } }>(
      `SELECT action, detail FROM audit_log WHERE target_id = 'cm_client_1' AND action IN ('comment.resolve', 'comment.reopen') ORDER BY id`,
    );
    expect(a.rows.map((x) => x.action)).toEqual(['comment.resolve', 'comment.reopen']);
    expect(a.rows[0].detail).toMatchObject({ before: { resolved: false }, after: { resolved: true } });
    expect((await c.ae!.patch(url('/comments/cm_client_1'), { resolved: 'yes' })).status).toBe(400);
    expect((await c.ae!.patch(url('/comments/nope'), { resolved: true })).status).toBe(404);
    expect((await c.ae!.patch(url('/comments/bad%20id'), { resolved: true })).status).toBe(404);
  });

  it('권한: viewer는 읽기만(작성 · 해결 403), 비로그인 401', async () => {
    expect((await c.viewer!.post(url('/comments'), { comment: { target: 'x', text: 'y' } })).status).toBe(403);
    expect((await c.viewer!.patch(url('/comments/cm_client_1'), { resolved: true })).status).toBe(403);
    expect((await t.anon().get(url('/comments'))).status).toBe(401);
    for (const r of ['owner', 'admin', 'pm', 'ae', 'client'] as Role[]) {
      const res = await c[r]!.post(url('/comments'), { comment: { id: `cm_perm_${r}`, target: 'perm', text: r } });
      expect(res.status, r).toBe(201);
    }
  });

  it('테넌트 격리: 다른 워크스페이스는 404, 다른 워크스페이스 코멘트는 보이지 않는다', async () => {
    await t.db.query(`INSERT INTO comments (id, workspace_id, target, author, text) VALUES ('cm_other', $1, 'x', '남', '다른 워크스페이스')`, [otherWs]);
    expect((await c.owner!.get(url('/comments', otherWs))).status).toBe(404);
    expect((await c.owner!.post(url('/comments', otherWs), { comment: { target: 'x', text: 'y' } })).status).toBe(404);
    expect((await c.owner!.patch(url('/comments/cm_other'), { resolved: true })).status).toBe(404);
    const list = await c.owner!.get(url('/comments'));
    expect(list.json.comments.some((x: { id: string }) => x.id === 'cm_other')).toBe(false);
    const still = await t.db.query<{ resolved: boolean }>(`SELECT resolved FROM comments WHERE id = 'cm_other'`);
    expect(still.rows[0].resolved).toBe(false);
  });
});

describe('workspace_state API', () => {
  it('PUT → GET: 슬래시가 들어간 키(그대로 · %2F 인코딩 모두), 감사 · state 이벤트', async () => {
    const value = { baselines: { cvr: 0.031 }, notes: ['a', 'b'], updated: '2026-11-02' };
    let r: TestResponse | null = null;
    const events = await captureEvents(async () => { r = await c.ae!.put(url('/state/mildo-os/lab/v1'), { value }); });
    expect(r!.status).toBe(200);
    expect(r!.json).toMatchObject({ key: 'mildo-os/lab/v1', state: { 'mildo-os/lab/v1': value }, unchanged: false });
    expect(events).toContain('state:mildo-os/lab/v1');
    const enc = await c.pm!.put(url(`/state/${encodeURIComponent('mildo-os/watch/v1')}`), { value: { done: [1, 2] } });
    expect(enc.status).toBe(200);
    expect(enc.json.key).toBe('mildo-os/watch/v1');
    const g = await c.viewer!.get(url('/state'));
    expect(g.status).toBe(200);
    expect(g.json.state).toEqual({ 'mildo-os/lab/v1': value, 'mildo-os/watch/v1': { done: [1, 2] } });
    const a = await t.db.query<{ action: string; user_id: string; detail: { key: string; created: boolean } }>(`SELECT action, user_id, detail FROM audit_log WHERE action = 'state.update' ORDER BY id`);
    expect(a.rows[0]).toMatchObject({ user_id: t.userIds.ae, detail: { key: 'mildo-os/lab/v1', created: true } });
    expect(JSON.stringify(a.rows[0].detail)).not.toContain('0.031'); // 값 자체는 감사에 넣지 않는다 (크기만)
    const row = await t.db.query<{ updated_by: string }>(`SELECT updated_by FROM workspace_state WHERE key = 'mildo-os/lab/v1'`);
    expect(row.rows[0].updated_by).toBe(t.userIds.ae);
  });

  it('같은 값을 다시 보내면 기록 · 이벤트 없이 unchanged (키 순서 무관)', async () => {
    const before = await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'state.update'`);
    const r = await c.ae!.put(url('/state/mildo-os/lab/v1'), { value: { updated: '2026-11-02', notes: ['a', 'b'], baselines: { cvr: 0.031 } } });
    expect(r.json.unchanged).toBe(true);
    const after = await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'state.update'`);
    expect(after.rowCount).toBe(before.rowCount);
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });

  it('문자열 · 숫자 · 배열 값도 저장, value=null · DELETE는 삭제', async () => {
    expect((await c.pm!.put(url('/state/mildo-os/ops-v1'), { value: 'plain text' })).status).toBe(200);
    expect((await c.pm!.put(url('/state/mildo-os/geo/case/v1'), { value: [1, 2, 3] })).status).toBe(200);
    let g = await c.pm!.get(url('/state'));
    expect(g.json.state['mildo-os/ops-v1']).toBe('plain text');
    expect(g.json.state['mildo-os/geo/case/v1']).toEqual([1, 2, 3]);
    const del = await c.pm!.put(url('/state/mildo-os/ops-v1'), { value: null });
    expect(del.json).toMatchObject({ unchanged: false, state: { 'mildo-os/ops-v1': null } });
    expect((await c.pm!.put(url('/state/mildo-os/ops-v1'), { value: null })).json.unchanged).toBe(true);
    const d2 = await c.pm!.del(url('/state/mildo-os/geo/case/v1'));
    expect(d2.json).toEqual({ ok: true, deleted: true });
    expect((await c.pm!.del(url('/state/mildo-os/geo/case/v1'))).json.deleted).toBe(false);
    g = await c.pm!.get(url('/state'));
    expect(Object.keys(g.json.state).sort()).toEqual(['mildo-os/lab/v1', 'mildo-os/watch/v1']);
    const a = await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'state.delete'`);
    expect(a.rowCount).toBe(2);
  });

  it('입력 검증: 키 형식(대문자 · 공백 · 120자 초과) 400, value 없음 400, 256KB 초과 413', async () => {
    expect((await c.pm!.put(url('/state/Mildo-OS/x'), { value: 1 })).status).toBe(400);
    expect((await c.pm!.put(url(`/state/${encodeURIComponent('has space')}`), { value: 1 })).status).toBe(400);
    expect((await c.pm!.put(url(`/state/${'a'.repeat(121)}`), { value: 1 })).status).toBe(400);
    expect((await c.pm!.put(url(`/state/${'a'.repeat(120)}`), { value: 1 })).status).toBe(200);
    expect((await c.pm!.put(url('/state/mildo-os/x'), {})).status).toBe(400);
    const big = await c.pm!.put(url('/state/mildo-os/big'), { value: 'x'.repeat(256 * 1024) });
    expect(big.status).toBe(413);
    expect(big.json.error.message).toMatch(/256KB/);
    const ok = await c.pm!.put(url('/state/mildo-os/big'), { value: 'x'.repeat(256 * 1024 - 2) });
    expect(ok.status).toBe(200);
    await c.pm!.del(url('/state/mildo-os/big'));
    await c.pm!.del(url(`/state/${'a'.repeat(120)}`));
  });

  it(`키 수 상한(${STATE_MAX_KEYS}개)을 넘는 새 키는 409, 기존 키 갱신은 허용`, async () => {
    await t.db.query(
      `INSERT INTO workspace_state (workspace_id, key, value) SELECT $1, 'bulk/' || g, '1'::jsonb FROM generate_series(1, $2::int) g`,
      [t.ws, STATE_MAX_KEYS - 2],
    );
    const full = await c.pm!.put(url('/state/mildo-os/one-more'), { value: 1 });
    expect(full.status).toBe(409);
    expect((await c.pm!.put(url('/state/mildo-os/lab/v1'), { value: { replaced: true } })).status).toBe(200);
    await t.db.query(`DELETE FROM workspace_state WHERE key LIKE 'bulk/%'`);
  });

  it('권한: viewer · 비로그인은 쓰기 불가, client는 쓰기 가능(comment 권한)', async () => {
    expect((await c.viewer!.put(url('/state/mildo-os/lab/v1'), { value: 1 })).status).toBe(403);
    expect((await c.viewer!.del(url('/state/mildo-os/lab/v1'))).status).toBe(403);
    expect((await t.anon().get(url('/state'))).status).toBe(401);
    expect((await t.anon().put(url('/state/mildo-os/lab/v1'), { value: 1 })).status).toBe(401);
    expect((await c.client!.put(url('/state/mildo-os/client-note'), { value: 'ok' })).status).toBe(200);
  });

  it('CSRF: 토큰이 없거나 틀리면 403', async () => {
    const r = await c.pm!.raw({ method: 'PUT', url: url('/state/mildo-os/x'), payload: { value: 1 }, headers: { 'x-csrf-token': 'forged' } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('csrf');
  });

  it('테넌트 격리: 다른 워크스페이스 404, 값이 섞이지 않는다', async () => {
    await t.db.query(`INSERT INTO workspace_state (workspace_id, key, value) VALUES ($1, 'mildo-os/lab/v1', '{"other":true}')`, [otherWs]);
    expect((await c.owner!.get(url('/state', otherWs))).status).toBe(404);
    expect((await c.owner!.put(url('/state/mildo-os/lab/v1', otherWs), { value: 1 })).status).toBe(404);
    const g = await c.owner!.get(url('/state'));
    expect(g.json.state['mildo-os/lab/v1']).toEqual({ replaced: true });
    const other = await t.db.query<{ value: unknown }>(`SELECT value FROM workspace_state WHERE workspace_id = $1`, [otherWs]);
    expect(other.rows[0].value).toEqual({ other: true });
  });
});
