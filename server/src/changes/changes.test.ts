/**
 * changes API (실제 PostgreSQL): 생성 · 클라이언트 id 멱등 · 승인 주체 재판정 · 역할별 전이 권한 · 불가능 전이 409 · 테넌트 격리 ·
 * 대량 변경 이슈 · 반영 전 점검 → 보류 · 커넥터 dry_run / live / 실패 · 재배분 + 부분 실패 되돌림 · 롤백 · 동시 반영 1회 ·
 * 인라인 제한 초과 → 백그라운드 · 감시 잡 복구 · 감사 · 이벤트. 커넥터는 가짜(주입), 네트워크 호출 없음.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeRequest, Dataset } from '@/core/types';
import { generateDemoData } from '@/data/demo';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { registerJob, drain, _resetJobsForTest } from '../jobs/queue';
import { registerSchedule, _resetSchedulesForTest } from '../jobs/scheduler';
import type { ApplyResult, ConnectorDef } from '../connectors/types';
import { connector as naverSaStub } from '../connectors/naver-sa';
import { configureChanges, jobs, resetChangesConfig, settleInflight } from './index';
import { sweepStale } from './service';
import { setNowForTest } from '../lib/time';
import type { ConnectorResolver } from './connector-adapter';

let t: TestApp;
const u: Record<string, TestClient> = {};
const DATA: Dataset = generateDemoData('2026-11-02', 10);
const events: { type: string; id?: string }[] = [];

interface Call { dryRun: boolean; change: ChangeRequest; connectionId: string }
let calls: Call[] = [];
let behavior: (c: Call) => Promise<ApplyResult>;
const okBehavior = async (c: Call): Promise<ApplyResult> => ({
  ok: true,
  request: { method: 'PUT', path: `/ncc/keywords/${c.change.targetId}`, body: { bidAmt: c.change.after }, accessToken: 'secret-token' },
  response: c.dryRun ? undefined : { nccKeywordId: c.change.targetId, bidAmt: c.change.after },
  appliedValue: c.dryRun ? undefined : c.change.after,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeDef: ConnectorDef = {
  ...naverSaStub,
  capabilities: { reads: [], writes: ['bid', 'budget', 'status', 'keyword_add'], intraday: false, maxBackfillDays: 0 },
  async apply(ctx, change) {
    const call = { dryRun: ctx.dryRun, change, connectionId: ctx.connectionId };
    calls.push(call);
    return behavior(call);
  },
};
const readOnlyDef: ConnectorDef = { ...naverSaStub, provider: 'meta', capabilities: { reads: ['mediaDaily'], writes: [], intraday: false, maxBackfillDays: 30 } };
const resolver: ConnectorResolver = async (_db, _cfg, conn) => {
  const def = conn.provider === 'naver_sa' ? fakeDef : conn.provider === 'meta' ? readOnlyDef : null;
  if (!def) return null;
  return {
    def,
    context: async ({ dryRun, log }) => ({
      workspaceId: conn.workspace_id, connectionId: conn.id, credentials: {}, settings: {}, dryRun, log,
      http: { request: async () => { throw new Error('테스트 중 네트워크 호출 금지'); } },
    }),
  };
};

beforeAll(async () => {
  t = await createTestApp();
  for (const r of ['owner', 'admin', 'pm', 'ae', 'client', 'viewer']) u[r] = await t.login(r);
  _resetJobsForTest();
  _resetSchedulesForTest();
  jobs({ job: registerJob, schedule: registerSchedule });
  t.events.subscribe(t.ws, (e) => events.push({ type: e.type, id: e.id }));
});
afterAll(async () => {
  await settleInflight();
  resetChangesConfig();
  await t?.close();
});
beforeEach(async () => {
  await settleInflight();
  for (const tbl of ['change_executions', 'change_requests', 'incidents', 'jobs', 'wh_entities', 'connections']) await t.db.query(`DELETE FROM ${tbl}`);
  calls = [];
  behavior = okBehavior;
  events.length = 0;
  configureChanges({ resolveConnector: resolver, buildDataset: async () => DATA, inlineTimeoutMs: 20_000, backgroundGraceMs: 60_000, onPeek: undefined });
});

/* ---------- 헬퍼 ---------- */

const base = (p: string) => `/api/w/${t.ws}/changes${p}`;
const bid = (o: Record<string, unknown> = {}) => ({
  module: 'adpilot', kind: 'bid', target: '수면밀도 입찰가', targetId: 'kw_1', before: 270, after: 280, changePct: 3.7, reason: '고효율 · 노출 손실', requestedBy: 'AD Pilot', approver: 'AE', ...o,
});
async function create(by: TestClient, change: Record<string, unknown>) {
  const r = await by.post(base(''), { change });
  if (r.status !== 201 && r.status !== 200) throw new Error(`생성 실패 ${r.status} ${r.body}`);
  return r.json.change as ChangeRequest & { execution?: Record<string, any>; executing?: unknown };
}
const patch = (by: TestClient, id: string, body: Record<string, unknown>) => by.patch(base(`/${id}`), body);
const to = (by: TestClient, id: string, status: string, extra: Record<string, unknown> = {}) => patch(by, id, { patch: { status }, ...extra });
async function approved(change: Record<string, unknown> = {}, by = u.ae) {
  const c = await create(by, bid(change));
  const a = await to(by, c.id, 'approved');
  expect(a.status).toBe(200);
  return c;
}
async function addConnection(provider: string, channel: string, writeMode: 'off' | 'dry_run' | 'live' = 'dry_run', label = provider): Promise<string> {
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, write_mode) VALUES ($1, $2, 'media', $3, $4, 'active', $5) RETURNING id`,
    [t.ws, provider, channel, label, writeMode],
  );
  return r.rows[0].id;
}
async function addEntity(type: string, id: string, source: string, doc: Record<string, unknown>) {
  await t.db.query(`INSERT INTO wh_entities (workspace_id, entity_type, external_id, source, channel, doc) VALUES ($1, $2, $3, $4, 'naver_sa', $5)`, [t.ws, type, id, source, JSON.stringify(doc)]);
}
async function saWithKeyword(writeMode: 'off' | 'dry_run' | 'live' = 'dry_run') {
  const conn = await addConnection('naver_sa', 'naver_sa', writeMode, '네이버 SA 본계정');
  await addEntity('keyword', 'kw_1', conn, { id: 'kw_1', text: '수면밀도', bid: 270, maxBid: 540 });
  return conn;
}
const auditActions = async (id: string) =>
  (await t.db.query<{ action: string; detail: any }>(`SELECT action, detail FROM audit_log WHERE target_type = 'change' AND target_id = $1 ORDER BY id`, [id])).rows;
const last = (a: readonly any[]): any => a[a.length - 1];

/* ---------- 생성 · 목록 ---------- */

describe('생성 · 목록 · 입력 검증', () => {
  it('서버가 id · 시각 · 요청자 · 상태 · 이력을 정하고, 목록은 최신순 · 상태 필터', async () => {
    const r = await u.ae.post(base(''), { change: { ...bid(), status: 'applied', createdAt: '2020-01-01T00:00:00Z', history: [{ at: 'x', by: 'y', action: '반영' }] } });
    expect(r.status).toBe(201);
    const c = r.json.change;
    expect(c.id).toMatch(/^chg_/);
    expect(c.status).toBe('pending');
    expect(c.requestedBy).toBe('테스트 ae');
    expect(c.createdAt.startsWith('2020')).toBe(false);
    expect(c.history[0]).toMatchObject({ by: '테스트 ae', action: '요청 생성', note: '고효율 · 노출 손실' });
    expect(c.history[1].note).toMatch(/요청 경로 표기: AD Pilot/);
    expect(c.history[1].note).toMatch(/승인 대기로 접수/);
    expect(typeof c.before).toBe('number');
    const s = await create(u.pm, bid({ kind: 'status', target: '킹 매트리스 광고', targetId: 'kw_9', before: 'on', after: 'off', changePct: undefined }));
    expect(s.before).toBe('on');
    const list = await u.viewer.get(base(''));
    expect(list.status).toBe(200);
    expect(list.json.changes.map((x: ChangeRequest) => x.id)).toEqual([s.id, c.id]);
    await to(u.ae, c.id, 'approved');
    const f = await u.viewer.get(base('?status=approved'));
    expect(f.json.changes.map((x: ChangeRequest) => x.id)).toEqual([c.id]);
    expect((await u.viewer.get(base('?status=bogus'))).status).toBe(400);
  });

  it('자동 보류 기록(held)은 그대로 접수', async () => {
    const c = await create(u.ae, bid({ status: 'held', reason: 'MILDO Alert 연계 자동 보류' }));
    expect(c.status).toBe('held');
    expect(last(c.history).action).toBe('자동 보류');
  });

  it('입력 검증 · 열람자 거부', async () => {
    for (const bad of [
      bid({ kind: 'bogus' }), bid({ approver: 'BOSS' }), bid({ before: null }), bid({ reason: 'x'.repeat(2001) }), bid({ target: '' }),
      bid({ changePct: '5' }), bid({ module: '모듈!' }),
    ]) {
      const r = await u.ae.post(base(''), { change: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await u.ae.post(base(''), {})).status).toBe(400);
    expect((await u.viewer.post(base(''), { change: bid() })).status).toBe(403);
    expect((await t.anon().get(base(''))).status).toBe(401);
  });

  it('클라이언트 id: 형식이 맞으면 그대로, 같은 요청 재전송은 같은 건, 내용이 다르면 서버 id', async () => {
    const a = await u.ae.post(base(''), { change: bid({ id: 'chg_client_001' }) });
    expect(a.status).toBe(201);
    expect(a.json.change.id).toBe('chg_client_001');
    const again = await u.ae.post(base(''), { change: bid({ id: 'chg_client_001' }) });
    expect(again.status).toBe(200);
    expect(again.json.change.id).toBe('chg_client_001');
    const other = await u.ae.post(base(''), { change: bid({ id: 'chg_client_001', after: 290 }) });
    expect(other.status).toBe(201);
    expect(other.json.change.id).not.toBe('chg_client_001');
    const byPm = await u.pm.post(base(''), { change: bid({ id: 'chg_client_001' }) });
    expect(byPm.json.change.id).not.toBe('chg_client_001');
    const unsafe = await u.ae.post(base(''), { change: bid({ id: 'bad id!' }) });
    expect(unsafe.status).toBe(201);
    expect(unsafe.json.change.id).toMatch(/^chg_/);
    const n = await t.db.query(`SELECT count(*)::int AS n FROM change_requests WHERE id = 'chg_client_001'`);
    expect(n.rows[0]).toMatchObject({ n: 1 });
  });

  it('승인 주체 서버 재판정 (예산 변경 폭 · 신규 캠페인), 클라이언트 값보다 낮추지 않음', async () => {
    const pm = await create(u.ae, bid({ module: 'flow', kind: 'budget', target: 'SA_일반 제품 일 예산', targetId: 'flow:budget:cmp_2', before: 2000000, after: 2500000, changePct: 25, approver: 'AE' }));
    expect(pm.approver).toBe('PM');
    expect(pm.history.map((h) => h.note).join(' ')).toMatch(/승인 주체 담당 AE → PM/);
    const client = await create(u.ae, bid({ module: 'flow', kind: 'budget', targetId: 'flow:budget:cmp_2', before: 2000000, after: 2700000, changePct: 35, approver: 'PM' }));
    expect(client.approver).toBe('CLIENT');
    const lied = await create(u.ae, bid({ module: 'flow', kind: 'budget', targetId: 'flow:budget:cmp_2', before: 2000000, after: 3000000, changePct: 5, approver: 'AE' }));
    expect(lied.approver).toBe('CLIENT');
    expect(lied.changePct).toBe(50);
    const kept = await create(u.ae, bid({ module: 'flow', kind: 'budget', targetId: 'flow:budget:cmp_2', before: 2000000, after: 2100000, changePct: 5, approver: 'PM' }));
    expect(kept.approver).toBe('PM');
    const fresh = await create(u.ae, bid({ module: 'gfa', kind: 'gfa', target: '가을 신규', targetId: 'gfa:new:acc_gfa:가을 신규', before: '—', after: 500000, changePct: undefined, approver: 'PM' }));
    expect(fresh.approver).toBe('CLIENT');
    const audit = await auditActions(lied.id);
    expect(audit[0]).toMatchObject({ action: 'change.create', detail: { approver: 'CLIENT', clientApprover: 'AE' } });
  });
});

/* ---------- 전이 · 권한 ---------- */

describe('상태 전이 · 역할별 권한', () => {
  it('AE 건: AE · 광고주 승인 가능, 열람자 거부, 반영은 운영 권한 필요(광고주 불가)', async () => {
    const c = await create(u.ae, bid());
    expect((await to(u.viewer, c.id, 'approved')).status).toBe(403);
    const a = await to(u.client, c.id, 'approved', { action: '승인', note: '광고주 확인' });
    expect(a.status).toBe(200);
    expect(last(a.json.change.history)).toMatchObject({ by: '테스트 client', action: '승인', note: '광고주 확인' });
    const denied = await to(u.client, c.id, 'applied');
    expect(denied.status).toBe(403);
    expect(denied.json.error.message).toMatch(/운영 권한/);
    const ok = await to(u.ae, c.id, 'applied');
    expect(ok.status).toBe(200);
    expect(ok.json.change.status).toBe('applied');
  });

  it('PM 건: AE 승인 거부 · PM 승인, AE 반영 거부', async () => {
    const c = await create(u.pm, bid({ approver: 'PM' }));
    expect((await to(u.ae, c.id, 'approved')).status).toBe(403);
    expect((await to(u.pm, c.id, 'approved')).status).toBe(200);
    expect((await to(u.ae, c.id, 'applied')).status).toBe(403);
    expect((await to(u.admin, c.id, 'applied')).json.change.status).toBe('applied');
  });

  it('CLIENT 건: PM · 관리자 승인 거부, 광고주 · 소유자 승인, 반영은 approve:CLIENT + operate(소유자)만', async () => {
    const c = await create(u.pm, bid({ module: 'flow', kind: 'budget', target: '비교 캠페인 일 예산', targetId: 'flow:budget:cmp_x', before: 1000000, after: 1400000, changePct: 40, approver: 'CLIENT' }));
    expect(c.approver).toBe('CLIENT');
    expect((await to(u.pm, c.id, 'approved')).status).toBe(403);
    expect((await to(u.admin, c.id, 'approved')).status).toBe(403);
    expect((await to(u.client, c.id, 'approved')).status).toBe(200);
    expect((await to(u.pm, c.id, 'applied')).status).toBe(403);
    expect((await to(u.client, c.id, 'applied')).status).toBe(403);
    const ok = await to(u.owner, c.id, 'applied');
    expect(ok.status).toBe(200);
    expect(ok.json.change.execution).toMatchObject({ mode: 'none', ok: true, note: '매체 반영 대상 없음 — 기록만' });
  });

  it('보류 · 해제는 운영 권한, 승인 전 보류 건은 승인 대기로만 해제', async () => {
    const c = await create(u.pm, bid({ approver: 'PM' }));
    expect((await to(u.client, c.id, 'held')).status).toBe(403);
    const h = await to(u.ae, c.id, 'held', { note: '데이터 확인 중' });
    expect(h.status).toBe(200);
    expect(last(h.json.change.history)).toMatchObject({ action: '보류', note: '데이터 확인 중' });
    const bad = await to(u.ae, c.id, 'approved');
    expect(bad.status).toBe(409);
    expect(bad.json.error.code).toBe('not_approved_before');
    const r = await patch(u.ae, c.id, { patch: {}, action: 'resume' });
    expect(r.status).toBe(200);
    expect(r.json.change.status).toBe('pending');
    expect(last(r.json.change.history).action).toBe('보류 해제');
  });

  it('승인 뒤 보류 → 해제는 승인으로, 실행 취소 · 반려는 승인 등급 권한', async () => {
    const c = await approved();
    expect((await to(u.ae, c.id, 'held')).status).toBe(200);
    const r = await patch(u.ae, c.id, { patch: {}, action: '보류 해제' });
    expect(r.json.change.status).toBe('approved');
    const cancel = await to(u.ae, c.id, 'rejected', { action: '실행 취소', note: '중복 요청' });
    expect(cancel.status).toBe(200);
    expect(last(cancel.json.change.history).action).toBe('실행 취소');
  });

  it('불가능 전이 · 같은 전이 재요청 · 종료 상태는 409 + 현재 변경 요청', async () => {
    const c = await create(u.ae, bid());
    const skip = await to(u.ae, c.id, 'applied');
    expect(skip.status).toBe(409);
    expect(skip.json.error.code).toBe('invalid_transition');
    expect(skip.json.change.status).toBe('pending');
    expect((await to(u.ae, c.id, 'approved')).status).toBe(200);
    const twice = await to(u.ae, c.id, 'approved');
    expect(twice.status).toBe(409);
    expect(twice.json.error.code).toBe('same_status');
    expect(twice.json.change).toMatchObject({ id: c.id, status: 'approved' });
    await to(u.ae, c.id, 'rejected');
    const dead = await to(u.ae, c.id, 'approved');
    expect(dead.status).toBe(409);
    expect(dead.json.error.message).toMatch(/종료 상태/);
    expect((await to(u.ae, 'missing_id', 'approved')).status).toBe(404);
    expect((await patch(u.ae, c.id, { patch: { status: 'done' } })).status).toBe(400);
    expect((await patch(u.ae, c.id, { patch: {} })).status).toBe(400);
  });

  it('내용 수정: 승인 대기 · 요청자 또는 PM 이상, 승인 주체는 PM 이상만 낮춤', async () => {
    const c = await create(u.ae, bid({ module: 'flow', kind: 'budget', target: 'SA_생활 상황 일 예산', targetId: 'flow:budget:cmp_5', before: 1000000, after: 1250000, changePct: 25 }));
    expect(c.approver).toBe('PM');
    expect((await patch(u.client, c.id, { patch: { after: 1200000 } })).status).toBe(403);
    const down = await patch(u.ae, c.id, { patch: { after: 1050000, changePct: 5, approver: 'AE' } });
    expect(down.status).toBe(200);
    expect(down.json.change).toMatchObject({ after: 1050000, approver: 'PM' });
    expect(last(down.json.change.history).action).toBe('내용 수정');
    const pmDown = await patch(u.pm, c.id, { patch: { approver: 'AE' } });
    expect(pmDown.json.change.approver).toBe('AE');
    // 현재 상태를 같이 실은 수정은 전이(409 same_status)가 아니라 수정
    const withStatus = await patch(u.ae, c.id, { patch: { status: 'pending', reason: '사유 보강' } });
    expect(withStatus.status).toBe(200);
    expect(withStatus.json.change).toMatchObject({ status: 'pending', reason: '사유 보강' });
    const up = await patch(u.ae, c.id, { patch: { after: 1500000, changePct: 50 } });
    expect(up.json.change.approver).toBe('CLIENT');
    const same = await patch(u.client, c.id, { patch: { status: 'approved', target: c.target } });
    expect(same.status).toBe(200);
    const late = await patch(u.pm, c.id, { patch: { after: 1100000 } });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe('not_editable');
    const audit = await auditActions(c.id);
    expect(audit.map((a) => a.action)).toEqual(['change.create', 'change.update', 'change.update', 'change.update', 'change.update', 'change.approve']);
    expect(audit[1].detail.edit.after).toMatchObject({ after: 1050000 });
  });

  it('이력 메모만 남기기 (상태 변경 없음)', async () => {
    const c = await approved();
    const r = await patch(u.ae, c.id, { patch: {}, action: '재실행 보류', note: '여전히 보류 사유 있음' });
    expect(r.status).toBe(200);
    expect(r.json.change.status).toBe('approved');
    expect(last(r.json.change.history)).toMatchObject({ action: '재실행 보류', note: '여전히 보류 사유 있음' });
    expect((await patch(u.viewer, c.id, { patch: {}, action: '메모' })).status).toBe(403);
  });
});

/* ---------- 테넌트 격리 ---------- */

describe('테넌트 격리', () => {
  it('다른 워크스페이스의 변경 요청은 보이지도 바뀌지도 않는다', async () => {
    const other = await t.db.query<{ id: string }>(
      `INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, $2, '다른 브랜드', '다른') RETURNING id`, [t.orgId, `other-${Date.now() % 100000}`],
    );
    const ows = other.rows[0].id;
    await t.db.query(
      `INSERT INTO change_requests (id, workspace_id, module, kind, target, before, after, requested_by, approver, status) VALUES ('chg_other', $1, 'adpilot', 'bid', 'x', '1', '2', 'x', 'AE', 'pending')`,
      [ows],
    );
    expect((await u.pm.get(base('/chg_other'))).status).toBe(404);
    expect((await to(u.owner, 'chg_other', 'approved')).status).toBe(404);
    expect((await u.pm.get(`/api/w/${ows}/changes`)).status).toBe(404);
    expect((await u.owner.patch(`/api/w/${ows}/changes/chg_other`, { patch: { status: 'approved' } })).status).toBe(404);
    expect((await u.pm.get(base(''))).json.changes.some((c: ChangeRequest) => c.id === 'chg_other')).toBe(false);
    const st = await t.db.query<{ status: string }>(`SELECT status FROM change_requests WHERE id = 'chg_other'`);
    expect(st.rows[0].status).toBe('pending');
  });
});

/* ---------- 대량 변경 ---------- */

describe('대량 변경 실수 감지 (detectBulkChange)', () => {
  it('같은 요청자 10분 내 10건 → P1 이슈 적재 · 이벤트, 미해결이면 반영 보류, 종료 후 재실행', async () => {
    const ids: string[] = [];
    for (const k of DATA.keywords.slice(0, 10)) {
      const after = Math.round(k.bid * 1.05);
      ids.push((await create(u.ae, bid({ target: `${k.text} 입찰가`, targetId: k.id, before: k.bid, after, changePct: ((after - k.bid) / k.bid) * 100 }))).id);
    }
    const inc = await t.db.query<{ id: string; rule_id: string; severity: string; status: string; doc: any }>(`SELECT * FROM incidents`);
    expect(inc.rows).toHaveLength(1);
    expect(inc.rows[0]).toMatchObject({ rule_id: 'bulk_change', severity: 'P1', status: 'open' });
    expect(inc.rows[0].doc.related).toEqual(expect.arrayContaining(ids));
    for (let i = 0; i < 30 && !events.some((e) => e.type === 'incident'); i++) await sleep(30);
    expect(events).toContainEqual({ type: 'incident', id: inc.rows[0].id });

    await to(u.ae, ids[0], 'approved');
    const held = await to(u.ae, ids[0], 'applied');
    expect(held.status).toBe(200);
    expect(held.json.change.status).toBe('held');
    expect(last(held.json.change.history)).toMatchObject({ action: '실행 보류' });
    expect(last(held.json.change.history).note).toMatch(/대량 변경 실수 감지/);

    await t.db.query(`UPDATE incidents SET status = 'resolved'`);
    const retry = await to(u.ae, ids[0], 'applied', { action: '재실행 · 반영' });
    expect(retry.json.change.status).toBe('applied');
    expect(last(retry.json.change.history).action).toBe('재실행 · 반영');
    expect((await auditActions(ids[0])).map((a) => a.action)).toContain('change.retry');
  });
});

/* ---------- 반영 전 점검 ---------- */

describe('반영 전 점검 → 보류', () => {
  it('일 조정 폭 상한 초과 입찰은 보류 · 매체 호출 없음', async () => {
    await saWithKeyword('live');
    const c = await approved({ before: 270, after: 340, changePct: 25.9 });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution).toMatchObject({ mode: 'none', ok: false, phase: 'apply' });
    expect(r.json.change.execution.error).toMatch(/일 조정 폭 상한 20%/);
    expect(calls).toHaveLength(0);
    expect((await auditActions(c.id)).map((a) => a.action)).toContain('change.apply_held');
  });

  it('GFA Control 실행 검증(계정 잔액 1일치 미만 · 자동충전 실패) → 보류', async () => {
    const conn = await addConnection('naver_sa', 'naver_gfa', 'live');
    await addEntity('campaign', 'cmp_6', conn, { id: 'cmp_6', name: 'GFA_Prospecting', dailyBudget: 1200000 });
    const c = await approved({ module: 'gfa', kind: 'budget', target: 'GFA_Prospecting 일 예산', targetId: 'gfa:budget:cmp_6', before: 1200000, after: 1260000, changePct: 5 });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/GFA Control 실행 검증/);
    expect(calls).toHaveLength(0);
  });

  it('키워드 일 누적 조정 폭 상한', async () => {
    await saWithKeyword('dry_run');
    const a = await approved({ before: 270, after: 310, changePct: 14.8 });
    expect((await to(u.ae, a.id, 'applied')).json.change.status).toBe('applied');
    const b = await approved({ before: 310, after: 350, changePct: 12.9 });
    const r = await to(u.ae, b.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/오늘 누적 조정 폭 29.6%/);
  });

  it('엔티티 최대 입찰가 초과는 보류 (Dataset에 없는 실계정 키워드 id)', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('keyword', 'nkw-777', conn, { id: 'nkw-777', text: '허리 매트리스', bid: 520, maxBid: 560 });
    const c = await approved({ module: 'flow', target: '허리 매트리스 입찰가', targetId: 'nkw-777', before: 520, after: 600, changePct: 15.4 });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/최대 입찰가 560원/);
    expect(calls).toHaveLength(0);
  });

  it('데이터셋을 만들 수 없으면 데이터 점검을 건너뛰고 사유를 남긴다', async () => {
    configureChanges({ buildDataset: async () => { throw new Error('웨어하우스 비어 있음'); } });
    await saWithKeyword('dry_run');
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('applied');
    expect(last(r.json.change.history).note).toMatch(/데이터셋을 만들 수 없어 .*웨어하우스 비어 있음/);
    expect(r.json.change.execution.checks.warnings.join(' ')).toMatch(/데이터셋을 만들 수 없어/);
  });

  it('반영 전 점검 미리보기 (상태 변경 없음)', async () => {
    const conn = await saWithKeyword('dry_run');
    const c = await create(u.ae, bid());
    const r = await u.viewer.get(base(`/${c.id}/preflight`));
    expect(r.status).toBe(200);
    expect(r.json.check.ok).toBe(true);
    expect(r.json.target).toMatchObject({ kind: 'plan', mode: 'dry_run', for: 'apply' });
    expect(r.json.target.ops[0]).toMatchObject({ externalId: 'kw_1', connectionId: conn, after: 280 });
    expect((await u.viewer.get(base(`/${c.id}`))).json.change.status).toBe('pending');
    expect(calls).toHaveLength(0);
  });
});

/* ---------- 매체 반영 ---------- */

describe('매체 반영 (커넥터 apply)', () => {
  it('dry_run: 요청 내용만 기록 · 상태 반영 · 실행 기록 · 감사 · 이벤트, 비밀값은 가림', async () => {
    const conn = await saWithKeyword('dry_run');
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied', { action: '실행 · 반영' });
    expect(r.status).toBe(200);
    const ch = r.json.change;
    expect(ch.status).toBe('applied');
    expect(ch.appliedAt).toBeTruthy();
    expect(ch.execution).toMatchObject({ mode: 'dry_run', ok: true, connectionId: conn, provider: 'naver_sa', phase: 'apply' });
    expect(ch.execution.request).toMatchObject({ method: 'PUT', body: { bidAmt: 280 }, accessToken: '••••' });
    expect(last(ch.history)).toMatchObject({ action: '실행 · 반영' });
    expect(last(ch.history).note).toMatch(/dry_run — 매체에 보내지 않고/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ dryRun: true, connectionId: conn, change: { targetId: 'kw_1', after: 280, before: 270, kind: 'bid' } });
    const full = (await u.viewer.get(base(`/${c.id}`))).json.change;
    expect(full.execution.plan.ops[0]).toMatchObject({ externalId: 'kw_1', connectionId: conn, idempotent: true });
    const listed = (await u.viewer.get(base(''))).json.changes.find((x: ChangeRequest) => x.id === c.id);
    expect(listed.execution).toMatchObject({ mode: 'dry_run', ok: true, connectionId: conn });
    expect(listed.execution.plan).toBeUndefined();
    const ex = await u.viewer.get(base(`/${c.id}/executions`));
    expect(ex.json.executions).toHaveLength(1);
    expect(ex.json.executions[0]).toMatchObject({ phase: 'apply', mode: 'dry_run', ok: true, targetExternalId: 'kw_1' });
    const audit = await auditActions(c.id);
    expect(audit.map((a) => a.action)).toEqual(['change.create', 'change.approve', 'change.apply']);
    expect(audit[2].detail).toMatchObject({ from: 'approved', to: 'applied', mode: 'dry_run', ok: true });
    expect(JSON.stringify(audit)).not.toContain('secret-token');
    for (let i = 0; i < 30 && events.filter((e) => e.type === 'change' && e.id === c.id).length < 3; i++) await sleep(30);
    expect(events.filter((e) => e.type === 'change' && e.id === c.id).length).toBeGreaterThanOrEqual(3);
  });

  it('live 성공: 실제 호출 · 매체 적용값 기록', async () => {
    await saWithKeyword('live');
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.execution).toMatchObject({ mode: 'live', ok: true, appliedValue: 280, response: { bidAmt: 280 } });
    expect(last(r.json.change.history).note).toMatch(/live 반영 완료 \(1건 · 매체 적용값 280\)/);
    expect(calls[0].dryRun).toBe(false);
  });

  it('live 실패 · 예외 → 보류 + 오류 기록, 이후 재실행 성공', async () => {
    await saWithKeyword('live');
    const c = await approved();
    behavior = async () => ({ ok: false, request: { bidAmt: 280 }, error: 'INVALID_BID_AMOUNT' });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution).toMatchObject({ mode: 'live', ok: false, error: 'INVALID_BID_AMOUNT' });
    expect(last(r.json.change.history)).toMatchObject({ action: '실행 보류' });
    behavior = async () => { throw new Error('ECONNRESET upstream rejected access_token=abcdefghijkl1234'); };
    const r2 = await to(u.ae, c.id, 'applied', { action: '재실행 · 반영' });
    expect(r2.json.change.status).toBe('held');
    expect(r2.json.change.execution.error).toMatch(/ECONNRESET/);
    expect(JSON.stringify(r2.json)).not.toContain('abcdefghijkl1234');
    behavior = okBehavior;
    const r3 = await to(u.ae, c.id, 'applied', { action: '재실행 · 반영' });
    expect(r3.json.change.status).toBe('applied');
    const ex = await u.viewer.get(base(`/${c.id}/executions`));
    expect(ex.json.executions.map((e: any) => e.ok)).toEqual([true, false, false]);
  });

  it('쓰기 모드 off → 보류, 반영을 지원하지 않는 커넥터 · 대상 없음 · 내부 기준은 기록만', async () => {
    await saWithKeyword('off');
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/쓰기 모드가 꺼져/);

    const meta = await addConnection('meta', 'meta', 'live');
    await addEntity('campaign', 'cmp_11', meta, { id: 'cmp_11', name: 'Meta_신규', dailyBudget: 900000 });
    const m = await approved({ module: 'flow', kind: 'budget', target: 'Meta 일 예산', targetId: 'flow:budget:cmp_11', before: 900000, after: 850000, changePct: -5.6 });
    const mr = await to(u.ae, m.id, 'applied');
    expect(mr.json.change.status).toBe('applied');
    expect(mr.json.change.execution).toMatchObject({ mode: 'none', ok: true, note: '매체 반영 대상 없음 — 기록만' });
    expect(mr.json.change.execution.reason).toMatch(/지원하지 않습니다/);

    const none = await approved({ module: 'flow', targetId: 'kw_404' });
    expect((await to(u.ae, none.id, 'applied')).json.change.execution.reason).toMatch(/찾지 못했습니다/);

    const s = await create(u.pm, bid({ kind: 'setting', target: 'AD Pilot 기준 · 급변 보류 기준', targetId: 'adpilot.cfg.anomalyHoldPct', before: 50, after: 40, changePct: -20, approver: 'PM' }));
    await to(u.pm, s.id, 'approved');
    const sr = await to(u.pm, s.id, 'applied');
    expect(sr.json.change.execution).toMatchObject({ mode: 'none', ok: true, note: '매체 반영 대상 없음 — 기록만' });
    expect(calls).toHaveLength(0);
  });

  it('예산 재배분: 받는 캠페인 증액 + 주는 캠페인 감액, 주는 쪽 실패 시 이미 반영한 쪽을 되돌린다', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('campaign', 'cmp_2', conn, { id: 'cmp_2', name: 'SA_일반 제품', dailyBudget: 2160000 });
    await addEntity('campaign', 'cmp_5', conn, { id: 'cmp_5', name: 'SA_생활 상황', dailyBudget: 760000 });
    const shift = { kind: 'budget', target: 'SA_일반 제품 일 예산 ← SA_생활 상황', targetId: 'budget:cmp_2:cmp_5', before: 2160000, after: 2376000, changePct: 10 };
    const a = await approved(shift);
    const r = await to(u.ae, a.id, 'applied');
    expect(r.json.change.status).toBe('applied');
    expect(calls.map((c) => [c.change.targetId, c.change.before, c.change.after])).toEqual([['cmp_2', 2160000, 2376000], ['cmp_5', 760000, 544000]]);
    expect(r.json.change.execution.request).toHaveLength(2);

    // 다음 수집 전 두 번째 재배분: 웨어하우스의 cmp_5는 아직 760,000이지만 매체 값은 첫 반영으로 544,000 —
    // 감액 기준은 마지막 live 반영값(544,000)이어야 총 예산이 그대로다 (760,000 기준이면 636,000으로 되레 증액)
    calls = [];
    const b = await approved({ ...shift, before: 2376000, after: 2500000, changePct: 5.2 });
    behavior = async (c) => (c.change.targetId === 'cmp_5' && c.change.after !== 760000 ? { ok: false, request: {}, error: 'BUDGET_LOCKED' } : okBehavior(c));
    const f = await to(u.ae, b.id, 'applied');
    expect(f.json.change.status).toBe('held');
    expect(calls.map((c) => [c.change.targetId, c.change.after])).toEqual([['cmp_2', 2500000], ['cmp_5', 420000], ['cmp_2', 2376000]]);
    expect(f.json.change.execution.compensation).toHaveLength(1);
    expect(last(f.json.change.history).note).toMatch(/BUDGET_LOCKED .*이미 반영된 1건 되돌림 \(1건 성공\)/);
  });

  it('주는 캠페인을 반영할 수 없으면 받는 쪽만 늘리지 않고 보류', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('campaign', 'cmp_2', conn, { id: 'cmp_2', dailyBudget: 2160000 });
    const a = await approved({ kind: 'budget', target: 'x', targetId: 'budget:cmp_2:cmp_404', before: 2160000, after: 2376000, changePct: 10 });
    const r = await to(u.ae, a.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/총 예산이 늘어나/);
    expect(calls).toHaveLength(0);
  });
});

/* ---------- 롤백 ---------- */

describe('롤백', () => {
  it('live 키워드 추가: 커넥터가 새로 만든 키워드만 OFF로 되돌리고, 원래 있던 키워드였으면 기록만, 근거가 없으면 보류', async () => {
    await addConnection('naver_sa', 'naver_sa', 'live', 'SA live');
    const kwAdd = (term: string) => approved({ module: 'lab', kind: 'keyword_add', target: `${term} 등록`, targetId: `term:${term}`, before: '미등록', after: 'GENERIC_TEST · 입찰 500원', changePct: undefined });

    behavior = async (c) => c.change.kind === 'keyword_add'
      ? { ok: true, request: {}, response: { created: [{ nccKeywordId: 'nkw-new-0001' }] }, appliedValue: 'nkw-new-0001' }
      : { ok: true, request: {}, response: {}, appliedValue: c.change.after };
    const a = await kwAdd('허리 매트리스');
    expect((await to(u.ae, a.id, 'applied')).json.change.status).toBe('applied');
    const ra = await to(u.ae, a.id, 'rolled_back');
    expect(ra.json.change.status).toBe('rolled_back');
    expect(calls[1]).toMatchObject({ dryRun: false, change: { kind: 'status', targetId: 'nkw-new-0001', before: 'on', after: 'off' } });

    calls = [];
    behavior = async () => ({ ok: true, request: {}, response: { existing: { nccKeywordId: 'nkw-old-0002' } }, appliedValue: 'nkw-old-0002' });
    const b = await kwAdd('경도 매트리스');
    await to(u.ae, b.id, 'applied');
    const rb = await to(u.ae, b.id, 'rolled_back');
    expect(rb.json.change.status).toBe('rolled_back');
    expect(calls).toHaveLength(1); // 원래 있던 키워드는 건드리지 않는다
    expect(JSON.stringify(rb.json.change.execution)).toMatch(/원래 매체에 있던 키워드/);

    calls = [];
    behavior = async () => ({ ok: true, request: {}, response: { something: 'else' }, appliedValue: 'x' });
    const c = await kwAdd('토퍼 추천');
    await to(u.ae, c.id, 'applied');
    const rc = await to(u.ae, c.id, 'rolled_back');
    expect(rc.json.change.status).toBe('applied');
    expect(last(rc.json.change.history)).toMatchObject({ action: '롤백 보류' });
    expect(calls).toHaveLength(1);
  });

  it('직전 값으로 되돌리는 요청(after → before)을 같은 경로로 보낸다', async () => {
    await saWithKeyword('live');
    const c = await approved();
    await to(u.ae, c.id, 'applied');
    const r = await to(u.ae, c.id, 'rolled_back');
    expect(r.status).toBe(200);
    const ch = r.json.change;
    expect(ch.status).toBe('rolled_back');
    expect(ch.rolledBackAt).toBeTruthy();
    expect(calls[1]).toMatchObject({ dryRun: false, change: { targetId: 'kw_1', before: 280, after: 270 } });
    expect(ch.execution).toMatchObject({ phase: 'rollback', mode: 'live', ok: true, applyExecution: { mode: 'live', ok: true } });
    expect(last(ch.history)).toMatchObject({ action: '롤백' });
    expect(last(ch.history).note).toMatch(/직전 상태로 복원/);
    expect((await auditActions(c.id)).map((a) => a.action)).toContain('change.rollback');
    expect((await to(u.ae, c.id, 'applied')).status).toBe(409);
  });

  it('live로 반영한 건은 커넥션이 live가 아니면 롤백하지 않고 반영 상태 유지', async () => {
    const conn = await saWithKeyword('live');
    const c = await approved();
    await to(u.ae, c.id, 'applied');
    await t.db.query(`UPDATE connections SET write_mode = 'dry_run' WHERE id = $1`, [conn]);
    const r = await to(u.ae, c.id, 'rolled_back');
    expect(r.json.change.status).toBe('applied');
    expect(last(r.json.change.history)).toMatchObject({ action: '롤백 보류' });
    expect(calls).toHaveLength(1);
    await t.db.query(`UPDATE connections SET write_mode = 'live' WHERE id = $1`, [conn]);
    const again = await to(u.ae, c.id, 'rolled_back');
    expect(again.json.change.status).toBe('rolled_back');
    expect(again.json.change.execution.applyExecution.mode).toBe('live');
  });

  it('롤백 실패는 반영 상태 유지 · 기록만 반영한 건은 기록만 롤백 · 최신 건부터', async () => {
    await saWithKeyword('live');
    const a = await approved();
    await to(u.ae, a.id, 'applied');
    const b = await approved({ before: 280, after: 290, changePct: 3.6 });
    await to(u.ae, b.id, 'applied');
    const order = await to(u.ae, a.id, 'rolled_back');
    expect(order.status).toBe(409);
    expect(order.json.error.code).toBe('rollback_order');
    behavior = async () => ({ ok: false, request: {}, error: 'TIMEOUT' });
    const fail = await to(u.ae, b.id, 'rolled_back');
    expect(fail.json.change.status).toBe('applied');
    expect(last(fail.json.change.history)).toMatchObject({ action: '롤백 실패' });
    behavior = okBehavior;
    expect((await to(u.ae, b.id, 'rolled_back')).json.change.status).toBe('rolled_back');
    expect((await to(u.ae, a.id, 'rolled_back')).json.change.status).toBe('rolled_back');

    const s = await approved({ kind: 'test', target: '테스트', targetId: 'x' });
    await to(u.ae, s.id, 'applied');
    const sr = await to(u.ae, s.id, 'rolled_back');
    expect(sr.json.change).toMatchObject({ status: 'rolled_back', execution: { mode: 'none', ok: true } });
  });

  it('롤백 권한: 광고주는 불가, 승인 등급 밖 운영자도 불가', async () => {
    await saWithKeyword('dry_run');
    const c = await create(u.pm, bid({ approver: 'PM' }));
    await to(u.pm, c.id, 'approved');
    await to(u.pm, c.id, 'applied');
    expect((await to(u.client, c.id, 'rolled_back')).status).toBe(403);
    expect((await to(u.ae, c.id, 'rolled_back')).status).toBe(403);
    expect((await to(u.pm, c.id, 'rolled_back')).json.change.status).toBe('rolled_back');
  });
});

/* ---------- 동시성 · 백그라운드 ---------- */

describe('동시성 · 백그라운드 마무리', () => {
  it('같은 건을 동시에 반영해도 매체 호출은 1번, 나머지는 409', async () => {
    await saWithKeyword('live');
    const c = await approved();
    behavior = async (x) => { await sleep(150); return okBehavior(x); };
    const rs = await Promise.all([to(u.ae, c.id, 'applied'), to(u.pm, c.id, 'applied'), to(u.ae, c.id, 'applied')]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(calls).toHaveLength(1);
    const conflictBody = rs.find((r) => r.status === 409)!.json;
    expect(['executing', 'same_status']).toContain(conflictBody.error.code);
    expect(conflictBody.change.id).toBe(c.id);
    const final = await u.viewer.get(base(`/${c.id}`));
    expect(final.json.change.status).toBe('applied');
    expect(final.json.change.history.filter((h: any) => h.action === '반영')).toHaveLength(1);
  });

  it('반영 중에는 보류 · 실행 취소도 409', async () => {
    await saWithKeyword('live');
    const c = await approved();
    let release!: () => void;
    behavior = async (x) => { await new Promise<void>((r) => { release = r; }); return okBehavior(x); };
    const p = to(u.ae, c.id, 'applied');
    for (let i = 0; i < 50 && !calls.length; i++) await sleep(10);
    const h = await to(u.ae, c.id, 'held');
    expect(h.status).toBe(409);
    expect(h.json.error.code).toBe('executing');
    expect(h.json.change.executing).toMatchObject({ phase: 'apply' });
    release();
    expect((await p).json.change.status).toBe('applied');
  });

  it('인라인 제한 초과 → 승인 상태 + 반영 대기(백그라운드), 늦게 끝난 결과로 마무리, 감시 잡은 할 일 없음', async () => {
    configureChanges({ inlineTimeoutMs: 60, backgroundGraceMs: 0 });
    await saWithKeyword('live');
    const c = await approved();
    behavior = async (x) => { await sleep(300); return okBehavior(x); };
    const r = await to(u.ae, c.id, 'applied');
    expect(r.status).toBe(200);
    expect(r.json.change.status).toBe('approved');
    expect(r.json.change.executing).toMatchObject({ phase: 'apply', background: true });
    expect(last(r.json.change.history)).toMatchObject({ action: '반영 대기(백그라운드)' });
    await settleInflight();
    const done = await u.viewer.get(base(`/${c.id}`));
    expect(done.json.change.status).toBe('applied');
    expect(done.json.change.executing).toBeUndefined();
    await sleep(80);
    expect(await drain(t.db, t.config, { types: ['changes.execute'] })).toBe(1);
    const job = await t.db.query<{ status: string; result: any }>(`SELECT status, result FROM jobs WHERE type = 'changes.execute'`);
    expect(job.rows[0]).toMatchObject({ status: 'done', result: { result: 'not_pending' } });
    expect(calls).toHaveLength(1);
    expect((await auditActions(c.id)).map((a) => a.action)).toEqual(['change.create', 'change.approve', 'change.execute_deferred', 'change.apply']);
  });

  it('감시 잡: 결과가 기록되지 않은 실행(프로세스 중단)은 저장된 계획으로 다시 실행, 신규 생성은 확인 필요 보류', async () => {
    const conn = await saWithKeyword('live');
    const c = await approved();
    const plan = { mode: 'live', ops: [{ externalId: 'kw_1', entityType: 'keyword', kind: 'bid', target: 't', before: 270, after: 280, role: 'primary', connectionId: conn, provider: 'naver_sa', idempotent: true }] };
    await t.db.query(`UPDATE change_requests SET exec_pending = $2 WHERE id = $1`, [c.id, JSON.stringify({ attemptId: 'dead1', phase: 'apply', since: '2026-01-01T00:00:00Z', by: { userId: null, name: '테스트 ae' }, label: '반영', plan })]);
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('changes.execute', $1, $2)`, [t.ws, JSON.stringify({ changeId: c.id, attemptId: 'dead1' })]);
    expect(await drain(t.db, t.config, { types: ['changes.execute'] })).toBe(1);
    const after = (await u.viewer.get(base(`/${c.id}`))).json.change;
    expect(after.status).toBe('applied');
    expect(after.history.map((h: any) => h.action)).toContain('반영 이어서 처리');
    expect(calls).toHaveLength(1);

    calls = [];
    const g = await approved({ module: 'lab', kind: 'keyword_add', target: '허리 매트리스 등록', targetId: 'term:허리 매트리스', before: '미등록', after: 'GENERIC_TEST · 입찰 500원', changePct: undefined });
    const gplan = { mode: 'live', ops: [{ ...plan.ops[0], kind: 'keyword_add', externalId: 'term:허리 매트리스', entityType: 'new', idempotent: false }] };
    await t.db.query(`UPDATE change_requests SET exec_pending = $2 WHERE id = $1`, [g.id, JSON.stringify({ attemptId: 'dead2', phase: 'apply', since: '2026-01-01T00:00:00Z', by: { userId: null, name: 'x' }, label: '반영', plan: gplan })]);
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('changes.execute', $1, $2)`, [t.ws, JSON.stringify({ changeId: g.id })]);
    await drain(t.db, t.config, { types: ['changes.execute'] });
    const gh = (await u.viewer.get(base(`/${g.id}`))).json.change;
    expect(gh.status).toBe('held');
    expect(last(gh.history as any[]).action).toBe('반영 결과 확인 필요');
    expect(calls).toHaveLength(0);
  });

  it('키워드 추가(대상 엔티티 없음)는 매체 커넥션 기준으로 보내고, 커넥션이 여럿이면 보류', async () => {
    await addConnection('naver_sa', 'naver_sa', 'dry_run', 'SA 1');
    const c = await approved({ module: 'lab', kind: 'keyword_add', target: '허리 매트리스 등록', targetId: 'term:허리 매트리스', before: '미등록', after: 'GENERIC_TEST · 입찰 500원', changePct: undefined });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.execution).toMatchObject({ mode: 'dry_run', ok: true });
    expect(calls[0].change).toMatchObject({ kind: 'keyword_add', targetId: 'term:허리 매트리스' });
    await addConnection('naver_sa', 'naver_sa', 'dry_run', 'SA 2');
    const d = await approved({ module: 'lab', kind: 'keyword_add', target: '경도 매트리스 등록', targetId: 'term:경도 매트리스', before: '미등록', after: 'GENERIC_TEST', changePct: undefined });
    const r2 = await to(u.ae, d.id, 'applied');
    expect(r2.json.change.status).toBe('held');
    expect(r2.json.change.execution.error).toMatch(/특정할 수 없습니다/);
  });
});

/* ---------- 리뷰 보강: 권한 우회 · 현재 값 대조 · 롤백 순서 · 감시 잡 ---------- */

describe('승인 주체 하한 · 낮추기 권한', () => {
  it('점검 기준 · 알림 기준 · 충전은 서버가 승인 주체 하한을 강제 (AE가 상한을 스스로 올리지 못함)', async () => {
    const cap = await create(u.ae, bid({ kind: 'setting', target: 'AD Pilot 기준 · 일 조정 폭 상한', targetId: 'adpilot.cfg.dailyChangeCapPct', before: 20, after: 1000, changePct: 4900, approver: 'AE' }));
    expect(cap.approver).toBe('CLIENT');
    expect(cap.history.map((h) => h.note).join(' ')).toMatch(/일 조정 폭 상한.*승인 주체 담당 AE → 수면밀도/);
    expect((await to(u.ae, cap.id, 'approved')).status).toBe(403);
    expect((await to(u.pm, cap.id, 'approved')).status).toBe(403);
    const pmField = await create(u.ae, bid({ kind: 'setting', target: 'AD Pilot 기준 · 급변 보류 기준', targetId: 'adpilot.cfg.anomalyHoldPct', before: 50, after: 500, changePct: 900, approver: 'AE' }));
    expect(pmField.approver).toBe('PM');
    const rule = await create(u.ae, bid({ module: 'alert', kind: 'alert_rule', target: '탐지 기준 · 대량 변경', targetId: 'alert_rule:bulkBatch', before: 10, after: 999, changePct: undefined, approver: 'AE' }));
    expect(rule.approver).toBe('PM');
    const topup = await create(u.ae, bid({ module: 'alert', kind: 'setting', target: 'SA 계정 충전', targetId: 'alert:account:acc_sa:topup', before: 100000, after: 900000, changePct: 800, approver: 'AE' }));
    expect(topup.approver).toBe('CLIENT');
    // 하한은 내용 수정으로도 내려가지 않는다
    const down = await patch(u.owner, cap.id, { patch: { approver: 'AE' } });
    expect(down.json.change.approver).toBe('CLIENT');
  });

  it('PM · 관리자는 CLIENT 건의 승인 주체를 낮춰 스스로 승인할 수 없다 · 소유자는 가능', async () => {
    const c = await create(u.ae, bid({ kind: 'status', target: '브랜드 캠페인 OFF', targetId: 'cmp_1', before: 'on', after: 'off', changePct: undefined, approver: 'CLIENT' }));
    const r = await patch(u.pm, c.id, { patch: { approver: 'PM' } });
    expect(r.status).toBe(200);
    expect(r.json.change.approver).toBe('CLIENT');
    expect(last(r.json.change.history).note).toMatch(/수면밀도 유지/);
    const both = await patch(u.pm, c.id, { patch: { approver: 'AE', status: 'approved' } });
    expect(both.status).toBe(403);
    expect((await patch(u.admin, c.id, { patch: { approver: 'PM' } })).json.change.approver).toBe('CLIENT');
    expect((await u.viewer.get(base(`/${c.id}`))).json.change.status).toBe('pending');
    const o = await patch(u.owner, c.id, { patch: { approver: 'PM' } });
    expect(o.json.change.approver).toBe('PM');
  });
});

describe('이력 메모 문구', () => {
  it("'반영'처럼 읽히는 메모는 '메모'로 남겨 반영 시각 · 롤백 순서를 바꾸지 못한다", async () => {
    await saWithKeyword('dry_run');
    const a = await approved();
    await to(u.ae, a.id, 'applied');
    const b = await approved({ before: 280, after: 290, changePct: 3.6 });
    await to(u.ae, b.id, 'applied');
    const n = await patch(u.ae, a.id, { patch: {}, action: '반영 확인', note: '매체 화면 확인' });
    expect(n.status).toBe(200);
    expect(n.json.change.status).toBe('applied');
    expect(last(n.json.change.history)).toMatchObject({ action: '메모', note: '반영 확인 — 매체 화면 확인' });
    const r = await to(u.ae, a.id, 'rolled_back');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('rollback_order');
    expect(last((await patch(u.ae, b.id, { patch: {}, action: '재실행 보류', note: '사유 유지' })).json.change.history).action).toBe('재실행 보류');
  });
});

describe('매체 현재 값 대조 (요청 before ↔ 마지막 수집 · 마지막 live 반영)', () => {
  it('live: 현재 값 기준 상한 초과는 보류, 통과하면 현재 값으로 반영 · 롤백, 수집 전 연속 반영은 마지막 live 값 기준', async () => {
    await saWithKeyword('live'); // 수집값 bid 270
    // 화면이 오래된 400을 before로 보냄: 요청 기준 5% · 매체 기준 270 → 420 = 55.6%
    const stale = await approved({ module: 'flow', before: 400, after: 420, changePct: 5 });
    const r = await to(u.ae, stale.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/매체 현재 입찰가 270원 → 420원 = 변경 폭 55.6% > 일 조정 폭 상한 20%/);
    expect(calls).toHaveLength(0);

    const d = await approved({ module: 'flow', before: 285, after: 290, changePct: 1.8 });
    const ok = await to(u.ae, d.id, 'applied');
    expect(ok.json.change.status).toBe('applied');
    expect(last(ok.json.change.history).note).toMatch(/요청 시점 값 285 ≠ 매체 현재 값 270 \(마지막 수집/);
    expect((await u.viewer.get(base(`/${d.id}`))).json.change.execution.plan.ops[0]).toMatchObject({ before: 270, after: 290 });

    // 다음 수집 전: 웨어하우스는 아직 270이지만 마지막 live 반영값 290을 현재 값으로 본다 → 대조 통과(주의 없음)
    const e = await approved({ module: 'flow', before: 290, after: 300, changePct: 3.4 });
    const eo = await to(u.ae, e.id, 'applied');
    expect(eo.json.change.status).toBe('applied');
    expect(last(eo.json.change.history).note).not.toMatch(/요청 시점 값/);

    expect((await to(u.ae, e.id, 'rolled_back')).json.change.status).toBe('rolled_back');
    expect(last(calls).change).toMatchObject({ targetId: 'kw_1', after: 290 });
    expect((await to(u.ae, d.id, 'rolled_back')).json.change.status).toBe('rolled_back');
    expect(last(calls).change).toMatchObject({ targetId: 'kw_1', after: 270 });
  });

  it('live 예산: 현재 값 기준 변경 폭이 승인 범위를 넘으면 재승인 필요로 보류, dry_run은 주의만', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('campaign', 'cmp_9', conn, { id: 'cmp_9', name: 'SA_신규 라인', dailyBudget: 1000000 });
    const c = await approved({ module: 'flow', kind: 'budget', target: 'SA_신규 라인 일 예산', targetId: 'flow:budget:cmp_9', before: 2000000, after: 2100000, changePct: 5 });
    expect(c.approver).toBe('AE');
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/매체 현재 일 예산 1000000원 → 2100000원 = 변경 폭 110% → 수면밀도 승인 필요/);
    expect(calls).toHaveLength(0);

    await t.db.query(`UPDATE connections SET write_mode = 'dry_run' WHERE id = $1`, [conn]);
    const d = await approved({ module: 'flow', kind: 'budget', target: 'SA_신규 라인 일 예산', targetId: 'flow:budget:cmp_9', before: 2000000, after: 2100000, changePct: 5 });
    const dr = await to(u.ae, d.id, 'applied');
    expect(dr.json.change.status).toBe('applied');
    expect(dr.json.change.execution).toMatchObject({ mode: 'dry_run', ok: true });
    expect(last(dr.json.change.history).note).toMatch(/dry_run 점검 — live였다면 보류/);
  });

  it('같은 키워드가 비활성 커넥션(우선순위 높음)과 활성 커넥션에 있으면 활성 커넥션으로', async () => {
    const old = await addConnection('naver_sa', 'naver_sa', 'live', '구 계정');
    await t.db.query(`UPDATE connections SET status = 'disabled', priority = 500 WHERE id = $1`, [old]);
    await addEntity('keyword', 'kw_1', old, { id: 'kw_1', text: '수면밀도', bid: 270, maxBid: 540 });
    const cur = await saWithKeyword('dry_run');
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.execution).toMatchObject({ mode: 'dry_run', ok: true, connectionId: cur });
  });
});

describe('롤백 순서 (매체 대상 기준)', () => {
  it('targetId 규칙이 달라도 같은 캠페인에 이후 live 반영이 남아 있으면 409, 최신 건을 먼저 롤백하면 가능', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('campaign', 'cmp_2', conn, { id: 'cmp_2', name: 'SA_일반 제품', dailyBudget: 2160000 });
    await addEntity('campaign', 'cmp_5', conn, { id: 'cmp_5', name: 'SA_생활 상황', dailyBudget: 760000 });
    const a = await approved({ kind: 'budget', target: 'SA_일반 제품 일 예산 ← SA_생활 상황', targetId: 'budget:cmp_2:cmp_5', before: 2160000, after: 2376000, changePct: 10 });
    expect((await to(u.ae, a.id, 'applied')).json.change.status).toBe('applied');
    const b = await approved({ module: 'flow', kind: 'budget', target: 'SA_일반 제품 일 예산', targetId: 'flow:budget:cmp_2', before: 2376000, after: 2450000, changePct: 3.1 });
    expect((await to(u.ae, b.id, 'applied')).json.change.status).toBe('applied');
    const r = await to(u.ae, a.id, 'rolled_back');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('rollback_order');
    expect(r.json.error.message).toMatch(/이후 live로 반영된 변경 1건/);
    expect((await to(u.ae, b.id, 'rolled_back')).json.change.status).toBe('rolled_back');
    const ok = await to(u.ae, a.id, 'rolled_back');
    expect(ok.json.change.status).toBe('rolled_back');
    expect(calls.slice(-2).map((c) => [c.change.targetId, c.change.after])).toEqual([['cmp_5', 760000], ['cmp_2', 2160000]]);
  });
});

describe('경합 · 감시 잡 (heartbeat · 계획 선저장)', () => {
  it('잠금 전 조회 뒤 다른 사람이 보류하면 반영 요청이 재실행으로 바뀌지 않고 409 stale', async () => {
    await saWithKeyword('live');
    const c = await approved();
    configureChanges({
      onPeek: async (_ws, id) => {
        if (id !== c.id) return;
        await t.db.query(`UPDATE change_requests SET status = 'held', history = history || $2::jsonb WHERE id = $1`, [c.id, JSON.stringify([{ at: new Date().toISOString(), by: '테스트 pm', action: '보류', note: '사고 대응' }])]);
      },
    });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('stale');
    expect(r.json.change.status).toBe('held');
    expect(calls).toHaveLength(0);
  });

  it('실행 쪽 heartbeat가 최신이면 감시 잡 · 정리 스케줄이 이어받지 않는다, 오래되면 다시 예약', async () => {
    const conn = await saWithKeyword('live');
    const c = await approved();
    const plan = { mode: 'live', ops: [{ externalId: 'kw_1', entityType: 'keyword', kind: 'bid', target: 't', before: 270, after: 280, role: 'primary', connectionId: conn, provider: 'naver_sa', idempotent: true }] };
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    await t.db.query(`UPDATE change_requests SET exec_pending = $2 WHERE id = $1`, [c.id, JSON.stringify({ attemptId: 'alive1', phase: 'apply', since: old, heartbeat: new Date().toISOString(), by: { userId: null, name: '테스트 ae' }, label: '반영', plan })]);
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('changes.execute', $1, $2)`, [t.ws, JSON.stringify({ changeId: c.id, attemptId: 'alive1' })]);
    expect(await drain(t.db, t.config, { types: ['changes.execute'] })).toBe(1);
    const jobs1 = await t.db.query<{ status: string; result: any; dedupe_key: string | null }>(`SELECT status, result, dedupe_key FROM jobs WHERE type = 'changes.execute' ORDER BY id`);
    expect(jobs1.rows[0]).toMatchObject({ status: 'done', result: { result: 'still_running' } });
    expect(jobs1.rows[1]).toMatchObject({ status: 'queued' });
    expect(jobs1.rows[1].dedupe_key).toMatch(/:alive1:recheck:/);
    expect(calls).toHaveLength(0);
    expect((await u.viewer.get(base(`/${c.id}`))).json.change).toMatchObject({ status: 'approved', executing: { phase: 'apply' } });
    expect(await sweepStale({ db: t.db, config: t.config })).toBe(0);

    await t.db.query(`UPDATE change_requests SET exec_pending = exec_pending || jsonb_build_object('heartbeat', $2::text) WHERE id = $1`, [c.id, old]);
    await t.db.query(`DELETE FROM jobs`);
    expect(await sweepStale({ db: t.db, config: t.config })).toBe(1);
    await drain(t.db, t.config, { types: ['changes.execute'] });
    expect((await u.viewer.get(base(`/${c.id}`))).json.change.status).toBe('applied');
    expect(calls).toHaveLength(1);
  });

  it('커넥터 호출 전에 계획을 저장 — 호출 중 프로세스가 멈추면 감시 잡은 신규 등록을 다시 보내지 않는다', async () => {
    await addConnection('naver_sa', 'naver_sa', 'live', 'SA 1');
    const g = await approved({ module: 'lab', kind: 'keyword_add', target: '허리 매트리스 등록', targetId: 'term:허리 매트리스', before: '미등록', after: 'GENERIC_TEST · 입찰 500원', changePct: undefined });
    let release!: () => void;
    behavior = async (x) => { await new Promise<void>((r) => { release = r; }); return okBehavior(x); };
    const p = to(u.ae, g.id, 'applied');
    for (let i = 0; i < 100 && !calls.length; i++) await sleep(10);
    expect(calls).toHaveLength(1);
    const row = await t.db.query<{ exec_pending: any }>(`SELECT exec_pending FROM change_requests WHERE id = $1`, [g.id]);
    expect(row.rows[0].exec_pending.plan.ops[0]).toMatchObject({ kind: 'keyword_add', idempotent: false });
    // 이 시점에 API 프로세스가 멈춘 것으로 보고(heartbeat 오래됨) 감시 잡을 당겨 실행
    await t.db.query(`UPDATE change_requests SET exec_pending = exec_pending || '{"heartbeat":"2026-01-01T00:00:00Z"}'::jsonb WHERE id = $1`, [g.id]);
    await t.db.query(`UPDATE jobs SET run_at = now() WHERE type = 'changes.execute'`);
    await drain(t.db, t.config, { types: ['changes.execute'] });
    expect(calls).toHaveLength(1);
    const gh = (await u.viewer.get(base(`/${g.id}`))).json.change;
    expect(gh.status).toBe('held');
    expect(last(gh.history as any[]).action).toBe('반영 결과 확인 필요');
    release();
    const late = await p;
    expect(late.json.change.status).toBe('held');
    expect(last(late.json.change.history).action).toBe('늦게 도착한 실행 결과');
  });
});

/* ---------- 리뷰 3차 보강 ---------- */

describe('대량 변경 가드 — 변경 건 기준 window · 날짜 넘김 · 종료 뒤 재발', () => {
  const KST = (hhmm: string, day = '2026-11-02') => Date.parse(`${day}T${hhmm}:00+09:00`);
  afterEach(() => setNowForTest(null));
  async function burst(at: number, n: number, offset = 0): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      setNowForTest(at + i * 30_000);
      const k = DATA.keywords[(i + offset) % DATA.keywords.length];
      const after = Math.round(k.bid * 1.05);
      ids.push((await create(u.ae, bid({ target: `${k.text} 입찰가`, targetId: k.id, before: k.bid, after, changePct: ((after - k.bid) / k.bid) * 100 }))).id);
    }
    return ids;
  }
  const incidents = async () => (await t.db.query<{ id: string; status: string; doc: any }>(`SELECT id, status, doc FROM incidents ORDER BY detected_at, id`)).rows;

  it('같은 날 두 번째 일괄 변경은 종료된 첫 이슈와 별개로 감지 · 차단, 첫 묶음 건은 통과', async () => {
    const first = await burst(KST('10:00'), 10);
    let inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0].id).toBe('bulk_change:adpilot · 테스트 ae:2026-11-02');
    // PM이 11:00에 확인 · 종료
    await t.db.query(`UPDATE incidents SET status = 'resolved', resolved_at = $1`, [new Date(KST('11:00'))]);
    // 15:00 두 번째 묶음 (첫 묶음과 같은 크기 — 엔진 단독으로는 '가장 큰 window'만 보고해 놓친다)
    const second = await burst(KST('15:00'), 10, 10);
    inc = await incidents();
    expect(inc).toHaveLength(2);
    const follow = inc.find((i) => i.id !== 'bulk_change:adpilot · 테스트 ae:2026-11-02')!;
    expect(follow.id).toBe(`bulk_change:adpilot · 테스트 ae:2026-11-02:${second[0]}`);
    expect(follow.status).toBe('open');
    expect(follow.doc.related).toEqual(second);
    expect(follow.doc.title).toMatch(/이후 재발/);

    setNowForTest(KST('15:30'));
    await to(u.ae, second[3], 'approved');
    const held = await to(u.ae, second[3], 'applied');
    expect(held.json.change.status).toBe('held');
    expect(held.json.change.execution.error).toContain(follow.id);
    await to(u.ae, first[2], 'approved');
    const ok = await to(u.ae, first[2], 'applied');
    expect(ok.json.change.status).toBe('applied');
    expect(ok.json.change.execution.checks.passes.join(' ')).toMatch(/대량 변경 이슈 .* 확인 · 종료됨/);
    expect(await incidents()).toHaveLength(2);
  });

  it('어제 확인 · 종료된 묶음의 건을 오늘 반영해도 새 이슈를 만들지 않고 통과 (이슈 id 날짜 = 묶음 첫 건 날짜)', async () => {
    const ids = await burst(KST('16:00'), 10);
    await t.db.query(`UPDATE incidents SET status = 'resolved', resolved_at = $1`, [new Date(KST('17:00'))]);
    setNowForTest(KST('09:00', '2026-11-03'));
    await to(u.ae, ids[5], 'approved');
    const r = await to(u.ae, ids[5], 'applied');
    expect(r.json.change.status).toBe('applied');
    const inc = await incidents();
    expect(inc.map((i) => i.id)).toEqual(['bulk_change:adpilot · 테스트 ae:2026-11-02']);
  });

  it('이슈가 열려 있는 동안 묶음에 더해진 건은 종료 후 통과, 종료 뒤에 더해진 건은 재발로 차단', async () => {
    const ids = await burst(KST('10:00'), 10);
    const late = await burst(KST('10:05'), 1, 10); // 이슈 적재 뒤 같은 window에 추가 (열린 이슈의 related에는 없음)
    expect((await incidents())).toHaveLength(1);
    await to(u.ae, late[0], 'approved');
    expect((await to(u.ae, late[0], 'applied')).json.change.status).toBe('held');
    await t.db.query(`UPDATE incidents SET status = 'resolved', resolved_at = $1`, [new Date(KST('10:06'))]);
    const retry = await to(u.ae, late[0], 'applied', { action: '재실행 · 반영' });
    expect(retry.json.change.status).toBe('applied');
    const after = await burst(KST('10:08'), 1, 11); // 종료 뒤 같은 window에 추가 → 재발
    await to(u.ae, after[0], 'approved');
    const blocked = await to(u.ae, after[0], 'applied');
    expect(blocked.json.change.status).toBe('held');
    expect(blocked.json.change.execution.error).toMatch(/대량 변경 실수 감지/);
    expect((await incidents()).map((i) => i.id)).toContain(`bulk_change:adpilot · 테스트 ae:2026-11-02:${after[0]}`);
    expect(ids).toHaveLength(10);
  });
});

describe('값 · 단위 · 정직성 점검', () => {
  it('change_pct는 숫자로 응답 · 같은 changePct를 실은 반영 요청은 수정으로 보지 않는다', async () => {
    await saWithKeyword('dry_run');
    const c = await approved();
    const got = (await u.viewer.get(base(`/${c.id}`))).json.change;
    expect(got.changePct).toBe(3.7);
    const r = await patch(u.ae, c.id, { patch: { status: 'applied', changePct: 3.7, before: 270, after: 280 }, action: '반영' });
    expect(r.status).toBe(200);
    expect(r.json.change.status).toBe('applied');
    expect(r.json.change.history.map((h: any) => h.action)).not.toContain('내용 수정');
    const audit = await auditActions(c.id);
    expect(typeof audit[0].detail.changePct).toBe('number');
  });

  it('요청 변경 폭이 값과 다르면 입찰도 큰 쪽을 저장, 값만 고치면 변경 폭을 다시 계산', async () => {
    const lie = await create(u.ae, bid({ before: 270, after: 400, changePct: 3 }));
    expect(lie.changePct).toBe(48.1);
    expect(lie.history.map((h) => h.note).join(' ')).toMatch(/변경 폭 대조: 요청 3% · 값 기준 48.1%/);
    const c = await create(u.ae, bid());
    const e = await patch(u.ae, c.id, { patch: { after: 300 } });
    expect(e.json.change).toMatchObject({ after: 300, changePct: 11.1 });
  });

  it('입찰가 · 예산은 원 단위 정수만 매체로 보낸다', async () => {
    await saWithKeyword('live');
    const c = await approved({ after: 280.5, changePct: 3.9 });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/원 단위 정수가 아닙니다/);
    expect(calls).toHaveLength(0);
  });

  it('재배분 증액분이 감액 캠페인 예산 이상이면 0원으로 깎지 않고 보류 (총 예산 유지)', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('campaign', 'cmp_2', conn, { id: 'cmp_2', name: 'SA_일반 제품', dailyBudget: 2160000 });
    await addEntity('campaign', 'cmp_5', conn, { id: 'cmp_5', name: 'SA_생활 상황', dailyBudget: 100000 });
    const a = await approved({ kind: 'budget', target: 'SA_일반 제품 일 예산 ← SA_생활 상황', targetId: 'budget:cmp_2:cmp_5', before: 2160000, after: 2376000, changePct: 10 });
    const r = await to(u.ae, a.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/감액 후 0원 이하/);
    expect(calls).toHaveLength(0);
  });

  it('데모 커넥터는 live 설정이어도 dry_run 시뮬레이션으로 기록 (매체 반영됨으로 보이지 않게)', async () => {
    const demo = await addConnection('demo', 'naver_sa', 'live', '데모 데이터');
    await t.db.query(`UPDATE connections SET kind = 'other', channel = NULL WHERE id = $1`, [demo]);
    await addEntity('keyword', 'kw_1', 'demo', { id: 'kw_1', text: '수면밀도', bid: 270, maxBid: 540 });
    const demoDef: ConnectorDef = { ...fakeDef, provider: 'demo' };
    configureChanges({ resolveConnector: async (db, cfg, conn) => (conn.provider === 'demo' ? { def: demoDef, context: async ({ dryRun, log }) => ({ workspaceId: conn.workspace_id, connectionId: conn.id, credentials: {}, settings: {}, dryRun, log, http: { request: async () => { throw new Error('no network'); } } }) } : resolver(db, cfg, conn)) });
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'demo' });
    expect(calls[0].dryRun).toBe(true);
    expect(last(r.json.change.history).note).toMatch(/데모 커넥터\(TEST DATA\).*시뮬레이션/);
  });

  it('live인데 연결 확인 전(pending) 커넥션이면 보내지 않고 보류', async () => {
    const conn = await saWithKeyword('live');
    await t.db.query(`UPDATE connections SET status = 'pending' WHERE id = $1`, [conn]);
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/연결 확인 전\(pending\)/);
    expect(calls).toHaveLength(0);
    // dry_run은 매체에 보내지 않으므로 그대로 진행
    await t.db.query(`UPDATE connections SET write_mode = 'dry_run' WHERE id = $1`, [conn]);
    expect((await to(u.ae, c.id, 'applied', { action: '재실행 · 반영' })).json.change.execution).toMatchObject({ mode: 'dry_run', ok: true });
    // dry_run으로 반영한 건의 롤백은 커넥션이 live + 연결 확인 전이어도 dry_run으로 기록 (매체 호출 없음)
    await t.db.query(`UPDATE connections SET write_mode = 'live' WHERE id = $1`, [conn]);
    const rb = await to(u.ae, c.id, 'rolled_back');
    expect(rb.json.change).toMatchObject({ status: 'rolled_back', execution: { phase: 'rollback', mode: 'dry_run', ok: true } });
    expect(calls.every((x) => x.dryRun)).toBe(true);
  });

  it('live 실행 기록에 실계정 검증 여부(verifiedLive)와 확인 필요 문구 · 커넥터에는 대상 엔티티(광고그룹 id) 전달', async () => {
    const conn = await addConnection('naver_sa', 'naver_sa', 'live');
    await addEntity('keyword', 'kw_1', conn, { id: 'kw_1', text: '수면밀도', bid: 270, maxBid: 540, adgroupId: 'grp-a001-01-000000000001', campaignId: 'cmp-a001-01-000000000001', secretLike: 'x' });
    const c = await approved();
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.execution).toMatchObject({ mode: 'live', ok: true, verifiedLive: false });
    expect(last(r.json.change.history).note).toMatch(/실계정 연결 전 확인 필요/);
    expect((calls[0].change as any).entity).toEqual({ type: 'keyword', externalId: 'kw_1', text: '수면밀도', adgroupId: 'grp-a001-01-000000000001', campaignId: 'cmp-a001-01-000000000001' });
    expect((calls[0].change as any).execution).toBeUndefined();
    // 롤백도 같은 엔티티 정보로
    await to(u.ae, c.id, 'rolled_back');
    expect((calls[1].change as any).entity?.adgroupId).toBe('grp-a001-01-000000000001');
  });

  it('요청 요약 문자열 안의 토큰 · 서명(URL 쿼리)도 저장 · 응답 · 감사 전에 가린다', async () => {
    await saWithKeyword('live');
    const c = await approved();
    behavior = async (x) => ({
      ok: true,
      request: { steps: [{ method: 'POST', url: `https://graph.facebook.com/v21.0/123?access_token=EAABtokenvalue123456&appsecret_proof=deadbeefcafe0123&fields=id` }], note: 'Authorization: Bearer abcdefghijklmnop' },
      response: { ok: true },
      appliedValue: x.change.after,
    });
    const r = await to(u.ae, c.id, 'applied');
    expect(r.json.change.status).toBe('applied');
    const dump = JSON.stringify(r.json) + JSON.stringify((await u.viewer.get(base(`/${c.id}/executions`))).json) + JSON.stringify(await auditActions(c.id));
    for (const secret of ['EAABtokenvalue123456', 'deadbeefcafe0123', 'abcdefghijklmnop']) expect(dump).not.toContain(secret);
    expect(dump).toContain('fields=id');
  });

  it('일 누적 조정 폭은 첫 반영의 실행 계획 값(매체 현재 값 보정)을 시작 값으로 본다', async () => {
    await saWithKeyword('dry_run'); // 수집값 270
    const a = await approved({ module: 'flow', before: 300, after: 310, changePct: 3.3 }); // 요청 before 300은 오래된 값 → 계획 before 270
    expect((await to(u.ae, a.id, 'applied')).json.change.status).toBe('applied');
    const b = await approved({ module: 'flow', before: 310, after: 330, changePct: 6.5 });
    const r = await to(u.ae, b.id, 'applied');
    // 270 → 330 = 22.2% > 20% (요청 값 300 기준이면 10%라 통과했을 것)
    expect(r.json.change.status).toBe('held');
    expect(r.json.change.execution.error).toMatch(/오늘 시작 입찰가 270원 → 330원/);
  });
});

describe('승인 시점 승인 주체 재판정', () => {
  it('요청 뒤 위임 범위가 좁아지면 승인 시점에 올리고, 권한 밖이면 409 approver_changed (올린 값은 저장)', async () => {
    const c = await create(u.ae, bid({ module: 'flow', kind: 'budget', target: 'SA 일 예산', targetId: 'flow:budget:cmp_2', before: 2000000, after: 2160000, changePct: 8 }));
    expect(c.approver).toBe('AE');
    await t.db.query(`UPDATE workspaces SET config = $2 WHERE id = $1`, [t.ws, JSON.stringify({ delegation: { aeMaxPct: 5, pmMaxPct: 30 } })]);
    try {
      const r = await to(u.ae, c.id, 'approved');
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('approver_changed');
      expect(r.json.change).toMatchObject({ status: 'pending', approver: 'PM' });
      expect(last(r.json.change.history).action).toBe('승인 주체 재판정');
      const ok = await to(u.pm, c.id, 'approved');
      expect(ok.status).toBe(200);
      expect(ok.json.change).toMatchObject({ status: 'approved', approver: 'PM' });
      expect((await auditActions(c.id)).map((a) => a.action)).toEqual(['change.create', 'change.reroute', 'change.approve']);
    } finally {
      await t.db.query(`UPDATE workspaces SET config = '{}'::jsonb WHERE id = $1`, [t.ws]);
    }
  });
});
