/**
 * settings 도메인 — GET/PUT /api/w/:ws/config · 이력 · 온보딩 · 목표 확인.
 * 권한(역할별 허용 · 거부) · 입력 검증(항목별 사유) · 테넌트 격리 · 감사(이전 → 이후 차이) · 이벤트 · 버전 충돌 · 보존 키 · loadWorkspaceConfig 검증.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import type { Role } from '../auth/permissions';
import { loadEffectiveConfig, loadWorkspaceConfig } from './service';
import { DEFAULT_AI_MONTHLY_TOKENS, DEFAULT_CONFIG, withWorkspaceConfig } from '@/data/config';
import { DEFAULT_MONTHLY_TOKEN_LIMIT, monthlyTokenLimit } from '../ai/service';
import { AD_PILOT, SLA } from '@/data/constants';
import { officialConfig, resolveConfig } from '@/modules/adpilot/engine';
import { aiEnabled } from '../ai/service';
import { routeApprover } from '../changes/policy';
import { evaluateGuards } from '../changes/executor';
import { impactConfig } from '@/modules/impact/engine';
import type { ChangeRequest } from '@/core/types';

let t: TestApp;
let W: (p?: string) => string;
let otherWs: string;
let secondWs: string;

beforeAll(async () => {
  t = await createTestApp();
  W = (p = '') => `/api/w/${t.ws}/config${p}`;
  // 같은 조직의 다른 워크스페이스 — 시드 사용자는 멤버가 아니다
  otherWs = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-co', '다른 브랜드', '다른') RETURNING id`, [t.orgId])).rows[0].id;
  // owner만 멤버인 두 번째 워크스페이스 (설정이 섞이지 않는지)
  secondWs = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'second-co', '두 번째', '두번째') RETURNING id`, [t.orgId])).rows[0].id;
  await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [secondWs, t.userIds.owner]);
});
afterAll(async () => { await t?.close(); });

/** 로그인 속도 제한(devops) 때문에 역할마다 한 번만 로그인해 재사용 */
const clients = new Map<string, TestClient>();
async function as(role: Role): Promise<TestClient> {
  let c = clients.get(role);
  if (!c) clients.set(role, (c = await t.login(role)));
  return c;
}

const resetStored = (config: unknown = {}) => t.db.query(`UPDATE workspaces SET config = $2::jsonb WHERE id = $1`, [t.ws, JSON.stringify(config)]);
const auditRows = () => t.db.query<{ action: string; actor: string; target_type: string; target_id: string; detail: any; user_id: string }>(
  `SELECT action, actor, target_type, target_id, detail, user_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'config.%' ORDER BY id`, [t.ws],
);

describe('GET /config', () => {
  it('열람자도 읽는다 — 덮어쓰기 없음 · 전체 설정 = 기본값 · 버전 0', async () => {
    const viewer = await as('viewer');
    const r = await viewer.get(W());
    expect(r.status).toBe(200);
    expect(r.json.config).toEqual({});
    expect(r.json.defaults).toEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    expect(r.json.effective).toEqual(r.json.defaults);
    expect(r.json.effective.targets.roas).toBe(400);
    expect(r.json.overridden).toEqual([]);
    expect(r.json.invalid).toEqual([]);
    expect(r.json.version).toBe(0);
    expect(r.json.updatedBy).toBeNull();
  });

  it('로그인 안 하면 401, 멤버가 아닌 워크스페이스 · 잘못된 id는 404', async () => {
    expect((await t.anon().get(W())).status).toBe(401);
    const pm = await as('pm');
    expect((await pm.get(`/api/w/${otherWs}/config`)).status).toBe(404);
    expect((await pm.get(`/api/w/${otherWs}/config/history`)).status).toBe(404);
    expect((await pm.get(`/api/w/${otherWs}/config/onboarding`)).status).toBe(404);
    expect((await pm.put(`/api/w/${otherWs}/config`, { config: { targets: { roas: 500 } } })).status).toBe(404);
    expect((await pm.get('/api/w/not-a-uuid/config')).status).toBe(404);
  });
});

describe('PUT /config — 권한', () => {
  it('설정 권한(configure)이 없는 역할은 403: ae · client · viewer, pm · admin · owner는 저장', async () => {
    await resetStored();
    for (const role of ['ae', 'client', 'viewer'] as const) {
      const c = await as(role);
      const r = await c.put(W(), { config: { targets: { roas: 500 } } });
      expect(r.status, role).toBe(403);
      expect(r.json.error.code).toBe('forbidden');
    }
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({});
    for (const role of ['pm', 'admin', 'owner'] as const) {
      const c = await as(role);
      const r = await c.put(W(), { config: { targets: { roas: 450 } } });
      expect(r.status, role).toBe(200);
    }
    await resetStored();
  });
});

describe('PUT /config — 저장 · 감사 · 이벤트', () => {
  it('덮어쓰기 저장 → 전체 설정 반영 · DB 저장 · 버전 증가 · 감사에 이전 → 이후 차이 · config 이벤트', async () => {
    await resetStored();
    await t.db.query(`UPDATE workspaces SET config_version = 0 WHERE id = $1`, [t.ws]);
    await t.db.query(`DELETE FROM audit_log WHERE workspace_id = $1 AND action LIKE 'config.%'`, [t.ws]);
    const events: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => events.push(`${e.type}:${e.id}`));
    const pm = await as('pm');
    const r = await pm.put(W(), {
      config: { targets: { roas: 500 }, budget: { allocation: { naver_sa: 0.5, naver_gfa: 0.11 } }, sla: { P1: { ackMin: 10 } }, brand: { competitors: ['시몬스', '에이스'] } },
      baseVersion: 0,
    });
    expect(r.status).toBe(200);
    expect(r.json.changed).toBe(true);
    expect(r.json.version).toBe(1);
    expect(r.json.effective.targets.roas).toBe(500);
    expect(r.json.effective.targets.brandRoas).toBe(800);
    expect(r.json.effective.budget.allocation).toMatchObject({ naver_sa: 0.5, naver_gfa: 0.11, google: 0.12 });
    expect(r.json.updatedBy).toEqual({ id: t.userIds.pm, name: '테스트 pm' });
    expect(r.json.overridden.sort()).toEqual(['brand.competitors', 'budget.allocation.naver_gfa', 'budget.allocation.naver_sa', 'sla.P1.ackMin', 'targets.roas']);
    const stored = (await t.db.query<{ config: any; config_version: number; config_updated_by: string }>(`SELECT config, config_version, config_updated_by FROM workspaces WHERE id = $1`, [t.ws])).rows[0];
    expect(stored.config.targets).toEqual({ roas: 500 });
    expect(stored.config_version).toBe(1);
    expect(stored.config_updated_by).toBe(t.userIds.pm);

    const logs = (await auditRows()).rows;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'config.update', actor: '테스트 pm', target_type: 'workspace_config', target_id: '1', user_id: t.userIds.pm });
    const ch = logs[0].detail.changes as { path: string; before: unknown; after: unknown; label: string; beforeSource: string; afterSource: string }[];
    expect(ch.find((c) => c.path === 'targets.roas')).toEqual({ path: 'targets.roas', label: '목표 ROAS', before: 400, after: 500, beforeSource: 'default', afterSource: 'override' });
    expect(ch.find((c) => c.path === 'budget.allocation.naver_sa')).toMatchObject({ before: 0.43, after: 0.5 });
    expect(ch.find((c) => c.path === 'sla.P1.ackMin')).toMatchObject({ before: 15, after: 10, label: 'P1 인지' });
    expect(ch.find((c) => c.path === 'brand.competitors')!.before).toHaveLength(6);

    for (let i = 0; i < 20 && !events.length; i++) await new Promise((res) => setTimeout(res, 50));
    off();
    expect(events).toContain('config:workspace');

    // GET이 같은 값을 돌려준다 · 다른 도메인이 쓰는 loadWorkspaceConfig도
    const g = await (await as('viewer')).get(W());
    expect(g.json.config.targets).toEqual({ roas: 500 });
    expect(g.json.version).toBe(1);
    expect(await loadWorkspaceConfig(t.db, t.ws)).toEqual(stored.config);
    expect((await loadEffectiveConfig(t.db, t.ws)).delegation).toEqual({ aeMaxPct: 10, pmMaxPct: 30 });
  });

  it('바뀐 게 없으면 기록 · 버전 증가 없음, 같은 값을 명시 저장하면 출처(기본값 → 덮어쓰기)만 바뀐 것으로 기록', async () => {
    const pm = await as('pm');
    const cur = (await pm.get(W())).json;
    const before = (await auditRows()).rows.length;
    const same = await pm.put(W(), { config: cur.config });
    expect(same.status).toBe(200);
    expect(same.json.changed).toBe(false);
    expect(same.json.version).toBe(cur.version);
    expect((await auditRows()).rows.length).toBe(before);
    const pin = await pm.put(W(), { config: { ...cur.config, delegation: { aeMaxPct: 10 } } });
    expect(pin.json.changed).toBe(true);
    expect(pin.json.changes).toEqual([{ path: 'delegation.aeMaxPct', label: '담당 AE 위임 (일 예산 변경 폭)', before: 10, after: 10, beforeSource: 'default', afterSource: 'override' }]);
  });

  it('dryRun은 검증 · 차이만 돌려주고 저장 · 감사하지 않는다', async () => {
    const pm = await as('pm');
    const cur = (await pm.get(W())).json;
    const n = (await auditRows()).rows.length;
    const r = await pm.put(W(), { config: { ...cur.config, safety: { dailyChangeCapPct: 15 } }, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json.dryRun).toBe(true);
    expect(r.json.changes).toEqual([expect.objectContaining({ path: 'safety.dailyChangeCapPct', before: 20, after: 15 })]);
    expect(r.json.effective.safety.dailyChangeCapPct).toBe(15);
    expect((await pm.get(W())).json.version).toBe(cur.version);
    expect((await auditRows()).rows.length).toBe(n);
  });

  it('baseVersion이 지금 버전과 다르면 409 (다른 관리자가 먼저 저장)', async () => {
    const admin = await as('admin');
    const cur = (await admin.get(W())).json;
    const r = await admin.put(W(), { config: { targets: { roas: 520 } }, baseVersion: cur.version - 1 });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('conflict');
    expect(r.json.error.detail.version).toBe(cur.version);
    expect((await admin.get(W())).json.config.targets.roas).toBe(500);
  });

  it('전부 기본값으로 → config.reset 기록', async () => {
    const owner = await as('owner');
    const r = await owner.put(W(), { config: {} });
    expect(r.status).toBe(200);
    expect(r.json.config).toEqual({});
    expect(r.json.effective).toEqual(r.json.defaults);
    const last = (await auditRows()).rows.at(-1)!;
    expect(last.action).toBe('config.reset');
    expect(last.detail.changes.map((c: { path: string }) => c.path)).toEqual(expect.arrayContaining(['targets.roas', 'brand.competitors']));
  });
});

describe('PUT /config — 소유자 전용 항목 · CSRF · 본문 오염', () => {
  it('billing.monthlyFee(회수 배수의 분모)는 owner만 바꾼다 — pm · admin은 403(dryRun 포함) · 저장 · 감사 없음, 값을 그대로 두면 다른 항목은 저장', async () => {
    await resetStored();
    const n0 = (await auditRows()).rows.length;
    for (const role of ['pm', 'admin'] as const) {
      const c = await as(role);
      const r = await c.put(W(), { config: { billing: { monthlyFee: 2_000_000 }, targets: { roas: 450 } } });
      expect(r.status, role).toBe(403);
      expect(r.json.error.code).toBe('forbidden');
      expect(r.json.error.message).toContain('소유자만');
      expect(r.json.error.detail.paths).toEqual(['billing.monthlyFee']);
      expect((await c.put(W(), { config: { billing: { monthlyFee: 2_000_000 } }, dryRun: true })).status, `${role} dryRun`).toBe(403);
    }
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({});
    expect((await auditRows()).rows.length).toBe(n0);

    const owner = await as('owner');
    const o = await owner.put(W(), { config: { billing: { monthlyFee: 7_000_000 } } });
    expect(o.status).toBe(200);
    expect(o.json.effective.billing.monthlyFee).toBe(7_000_000);
    const pm = await as('pm');
    // 저장된 구독료를 그대로 두면 다른 항목은 저장된다
    const keep = await pm.put(W(), { config: { billing: { monthlyFee: 7_000_000 }, targets: { roas: 450 } } });
    expect(keep.status).toBe(200);
    expect(keep.json.changes.map((x: { path: string }) => x.path)).toEqual(['targets.roas']);
    // 구독료 덮어쓰기를 지우는 저장(전체 기본값 포함)도 바꾸는 것이다
    const drop = await pm.put(W(), { config: { targets: { roas: 450 } } });
    expect(drop.status).toBe(403);
    expect((await pm.put(W(), { config: {} })).status).toBe(403);
    expect((await pm.get(W())).json.config).toEqual({ billing: { monthlyFee: 7_000_000 }, targets: { roas: 450 } });
    await resetStored();
  });

  it('x-csrf-token이 쿠키와 다르면 403 · 저장 안 함', async () => {
    await resetStored();
    const pm = await as('pm');
    const r = await pm.raw({ method: 'PUT', url: W(), payload: { config: { targets: { roas: 555 } } }, headers: { 'x-csrf-token': 'forged-token' } });
    expect(r.status).toBe(403);
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({});
  });

  it('__proto__ · constructor.prototype 키가 든 본문은 거부되고 저장 · 전역 오염이 없다', async () => {
    await resetStored();
    const pm = await as('pm');
    for (const body of ['{"config":{"__proto__":{"polluted":1}}}', '{"config":{"targets":{"constructor":{"prototype":{"polluted":1}}}}}']) {
      const r = await pm.raw({ method: 'PUT', url: W(), payload: body, headers: { 'content-type': 'application/json' } });
      expect(r.status, body).toBe(400);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({});
  });
});

describe('PUT /config — 입력 검증', () => {
  it('항목별 사유와 함께 400 · 저장 안 함', async () => {
    await resetStored();
    const pm = await as('pm');
    const r = await pm.put(W(), { config: { targets: { roas: 20 }, timetable: { collect: '7시' }, modules: ['board', 'payroll'], foo: 1 } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_config');
    const paths = (r.json.error.detail as { path: string }[]).map((d) => d.path).sort();
    expect(paths).toEqual(['foo', 'modules', 'targets.roas', 'timetable.collect']);
    expect(r.json.error.message).toContain('목표 ROAS');
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({});
  });

  it('매체 배분 합계 100% · 대량 변경 차단 > 경고 · PM 상한 > AE 위임', async () => {
    const pm = await as('pm');
    const a = await pm.put(W(), { config: { budget: { allocation: { naver_sa: 0.6 } } } });
    expect(a.status).toBe(400);
    expect(a.json.error.detail).toEqual([{ path: 'budget.allocation', message: expect.stringContaining('100%') }]);
    expect((await pm.put(W(), { config: { safety: { bulkWarnCount: 20 } } })).json.error.detail[0].path).toBe('safety.bulkWarnCount');
    expect((await pm.put(W(), { config: { delegation: { pmMaxPct: 5 } } })).json.error.detail[0].path).toBe('delegation.pmMaxPct');
  });

  it('본문 형식: config 누락 · 배열 · 문자열 → 400', async () => {
    const pm = await as('pm');
    expect((await pm.put(W(), {})).status).toBe(400);
    expect((await pm.put(W(), { config: [1] })).status).toBe(400);
    expect((await pm.put(W(), { config: 'x' })).status).toBe(400);
  });
});

describe('저장된 값 해석 · 보존', () => {
  it('잘못 저장된 항목(직접 SQL 등)은 무시하고 경고 · GET은 invalid로 알려 준다 · 다음 저장에서 정리', async () => {
    await resetStored({ targets: { roas: 'high', brandRoas: 900 }, safety: { dailyChangeCapPct: 500 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = await loadWorkspaceConfig(t.db, t.ws);
    expect(cfg).toEqual({ targets: { brandRoas: 900 } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('targets.roas');
    await loadWorkspaceConfig(t.db, t.ws);
    expect(warn).toHaveBeenCalledTimes(1); // 같은 내용은 한 번만
    warn.mockRestore();
    const pm = await as('pm');
    const g = (await pm.get(W())).json;
    expect(g.config).toEqual({ targets: { brandRoas: 900 } });
    expect(g.invalid.map((i: { path: string }) => i.path).sort()).toEqual(['safety.dailyChangeCapPct', 'targets.roas']);
    const s = await pm.put(W(), { config: g.config });
    expect(s.json.changed).toBe(true);
    expect(s.json.invalid).toEqual([]);
    const last = (await auditRows()).rows.at(-1)!;
    expect(last.detail.droppedInvalid.sort()).toEqual(['safety.dailyChangeCapPct', 'targets.roas']);
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({ targets: { brandRoas: 900 } });
  });

  it('스키마 밖 최상위 키(다른 도메인 값)는 보존하고, 새로 넣거나 바꾸면 거부', async () => {
    await resetStored({ futureKey: { a: 1 }, targets: { roas: 450 } });
    const pm = await as('pm');
    const g = (await pm.get(W())).json;
    expect(g.preserved).toEqual(['futureKey']);
    expect(g.config).toEqual({ targets: { roas: 450 } });
    expect((await loadWorkspaceConfig(t.db, t.ws))).toEqual({ targets: { roas: 450 } });
    const ok = await pm.put(W(), { config: { targets: { roas: 460 } } });
    expect(ok.status).toBe(200);
    expect((await t.db.query(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config).toEqual({ futureKey: { a: 1 }, targets: { roas: 460 } });
    const echo = await pm.put(W(), { config: { targets: { roas: 470 }, futureKey: { a: 1 } } });
    expect(echo.status).toBe(200);
    const changed = await pm.put(W(), { config: { futureKey: { a: 2 } } });
    expect(changed.status).toBe(400);
    expect(changed.json.error.detail).toEqual([{ path: 'futureKey', message: '이 화면에서 바꿀 수 없는 항목입니다' }]);
    await resetStored();
  });

  it('워크스페이스마다 따로 저장된다 (owner가 두 곳에 속해도 섞이지 않음)', async () => {
    await resetStored();
    const owner = await as('owner');
    const r = await owner.put(`/api/w/${secondWs}/config`, { config: { targets: { roas: 900 } } });
    expect(r.status).toBe(200);
    expect((await owner.get(W())).json.config).toEqual({});
    expect((await owner.get(`/api/w/${secondWs}/config`)).json.effective.targets.roas).toBe(900);
    expect(await loadWorkspaceConfig(t.db, t.ws)).toEqual({});
    expect((await loadWorkspaceConfig(t.db, secondWs)).targets).toEqual({ roas: 900 });
    // 다른 워크스페이스 이력은 보이지 않는다
    const h = (await owner.get(W('/history'))).json.entries as { changes: { after: unknown }[] }[];
    expect(h.some((e) => e.changes.some((c) => c.after === 900))).toBe(false);
  });

  it('잠긴(읽기 전용) 워크스페이스는 읽기만 · 저장 423', async () => {
    const owner = await as('owner');
    await t.db.query(`UPDATE workspaces SET status = 'suspended' WHERE id = $1`, [secondWs]);
    expect((await owner.get(`/api/w/${secondWs}/config`)).status).toBe(200);
    expect((await owner.put(`/api/w/${secondWs}/config`, { config: {} })).status).toBe(423);
    await t.db.query(`UPDATE workspaces SET status = 'active' WHERE id = $1`, [secondWs]);
  });
});

describe('GET /config/history', () => {
  it('최근 순 · 변경 항목 · 페이지 넘김 · 열람자도 읽기', async () => {
    await resetStored();
    const pm = await as('pm');
    for (const roas of [410, 420, 430]) expect((await pm.put(W(), { config: { targets: { roas } } })).status).toBe(200);
    const viewer = await as('viewer');
    const r = await viewer.get(W('/history?limit=2'));
    expect(r.status).toBe(200);
    expect(r.json.entries).toHaveLength(2);
    expect(r.json.entries[0]).toMatchObject({ action: 'config.update', actor: '테스트 pm', changes: [{ path: 'targets.roas', label: '목표 ROAS', before: 420, after: 430 }] });
    expect(r.json.entries[0].id).toBeGreaterThan(r.json.entries[1].id);
    expect(typeof r.json.nextBefore).toBe('number');
    const next = await viewer.get(W(`/history?limit=2&before=${r.json.nextBefore}`));
    expect(next.json.entries[0].changes[0]).toMatchObject({ before: 400, after: 410 });
    expect((await viewer.get(W('/history?limit=0'))).status).toBe(400);
  });
});

describe('온보딩 · 목표 확인', () => {
  it('첫 실행 판정 · 단계별 완료 감지 (데이터 연결 · 팀 초대 · 목표 · 예산 확인 · 알림 채널)', async () => {
    await resetStored();
    await t.db.query(`DELETE FROM audit_log WHERE workspace_id = $1 AND action = 'config.review'`, [t.ws]);
    const viewer = await as('viewer');
    let o = (await viewer.get(W('/onboarding'))).json.onboarding;
    expect(o.firstRun).toBe(true);
    expect(o.steps.map((s: { id: string }) => s.id)).toEqual(['data', 'team', 'goals', 'notify']);
    expect(o.steps.map((s: { href: string }) => s.href)).toEqual(['#connections', '#team', '#workspace', '#notify']);
    expect(o.steps.find((s: { id: string }) => s.id === 'team').done).toBe(true); // 시드 구성원 6명
    expect(o.steps.find((s: { id: string }) => s.id === 'data').done).toBe(false);
    expect(o.total).toBe(4);

    // 데모 커넥션은 실데이터가 아니다
    await t.db.query(`INSERT INTO connections (workspace_id, provider, kind, label, status) VALUES ($1, 'demo', 'other', '데모', 'active')`, [t.ws]);
    o = (await viewer.get(W('/onboarding'))).json.onboarding;
    expect(o.firstRun).toBe(true);
    expect(o.steps[0].detail).toContain('데모 데이터만');

    // 알림 채널
    await t.db.query(`INSERT INTO notification_channels (workspace_id, type, name, config_enc) VALUES ($1, 'email', '운영 메일', 'enc')`, [t.ws]);
    o = (await viewer.get(W('/onboarding'))).json.onboarding;
    expect(o.steps.find((s: { id: string }) => s.id === 'notify').done).toBe(true);

    // 목표 · 예산 확인: ae · client · viewer는 403, 다른 워크스페이스는 404, pm은 기록
    for (const role of ['ae', 'client', 'viewer'] as const) expect((await (await as(role)).post(W('/review'), {})).status, role).toBe(403);
    expect((await (await as('pm')).post(`/api/w/${otherWs}/config/review`, {})).status).toBe(404);
    expect((await (await as('pm')).post(W('/review'), { note: 'x'.repeat(301) })).status).toBe(400);
    expect((await auditRows()).rows.filter((x) => x.action === 'config.review')).toHaveLength(0);
    const pm = await as('pm');
    const rv = await pm.post(W('/review'), { note: '제안서 기준 그대로 운영' });
    expect(rv.status).toBe(200);
    const goals = rv.json.onboarding.steps.find((s: { id: string }) => s.id === 'goals');
    expect(goals.done).toBe(true);
    expect(typeof goals.at).toBe('string');
    expect(rv.json.onboarding.firstRun).toBe(true); // 확인은 덮어쓰기가 아니다
    const review = (await auditRows()).rows.find((x) => x.action === 'config.review')!;
    expect(review.detail.note).toBe('제안서 기준 그대로 운영');
    expect(review.detail.reviewed.targets.roas).toBe(400);
    const hist = (await viewer.get(W('/history'))).json.entries;
    expect(hist[0].action).toBe('config.review');

    // 실데이터 연결 → 첫 실행 아님
    await t.db.query(`INSERT INTO connections (workspace_id, provider, kind, channel, label, status) VALUES ($1, 'naver_sa', 'media', 'naver_sa', '네이버 SA', 'active')`, [t.ws]);
    o = (await viewer.get(W('/onboarding'))).json.onboarding;
    expect(o.firstRun).toBe(false);
    expect(o.steps[0].done).toBe(true);
    expect(o.done).toBe(4);
  });

  it('덮어쓴 설정이 있으면 첫 실행이 아니다', async () => {
    await t.db.query(`DELETE FROM connections WHERE workspace_id = $1`, [t.ws]);
    await resetStored({ safety: { dailyChangeCapPct: 15 } });
    const o = (await (await as('viewer')).get(W('/onboarding'))).json.onboarding;
    expect(o.firstRun).toBe(false);
    await resetStored();
  });
});

describe('엔진 연동 · 계약', () => {
  it('loadWorkspaceConfig → withWorkspaceConfig: 그 안에서만 엔진이 워크스페이스 값을 쓴다', async () => {
    await resetStored({ targets: { roas: 640 }, sla: { P1: { ackMin: 12 } } });
    const cfg = await loadWorkspaceConfig(t.db, t.ws);
    const seen = withWorkspaceConfig(cfg, () => ({ target: resolveConfig().targetRoas, ack: SLA.P1.ackMin, label: SLA.P1.label.ack }));
    expect(seen).toEqual({ target: 640, ack: 12, label: '12분' });
    expect(AD_PILOT.targetRoas).toBe(400);
    expect(SLA.P1.ackMin).toBe(15);
    await resetStored();
  });

  it('AI 월 한도 기본값이 ai 도메인과 같고, 저장한 ai.monthlyTokenLimit을 ai 도메인이 그대로 읽는다', async () => {
    expect(DEFAULT_AI_MONTHLY_TOKENS).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
    const pm = await as('pm');
    expect((await pm.put(W(), { config: { ai: { monthlyTokenLimit: 5_000_000 } } })).status).toBe(200);
    const raw = (await t.db.query<{ config: Record<string, unknown> }>(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config;
    expect(monthlyTokenLimit(raw)).toBe(5_000_000);
    await resetStored();
  });

  it('ai: ai.enabled=false · 한도를 PUT이 지우지 않고 ai 도메인(aiEnabled · monthlyTokenLimit)이 읽는다', async () => {
    await resetStored();
    const owner = await as('owner');
    const r = await owner.put(W(), { config: { ai: { enabled: false, monthlyTokenLimit: 2_000_000 } } });
    expect(r.status).toBe(200);
    expect(r.json.effective.ai).toEqual({ enabled: false, monthlyTokenLimit: 2_000_000 });
    const raw = (await t.db.query<{ config: Record<string, unknown> }>(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config;
    expect(raw.ai).toEqual({ enabled: false, monthlyTokenLimit: 2_000_000 });
    expect(aiEnabled(raw)).toBe(false);
    expect(monthlyTokenLimit(raw)).toBe(2_000_000);
    // AI 사용량 API가 같은 한도를 보고한다
    const u = await owner.get(`/api/w/${t.ws}/ai/usage`);
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ limit: 2_000_000, enabled: false, available: false });
    await resetStored();
  });

  it('alerts: offHoursMode(최상위 boolean)를 저장하면 loadWorkspaceConfig가 그대로 돌려준다 (scan.ts가 cfg.offHoursMode로 읽음) · 문자열은 400', async () => {
    await resetStored();
    const pm = await as('pm');
    expect((await pm.put(W(), { config: { offHoursMode: 'on' } })).json.error.detail).toEqual([{ path: 'offHoursMode', message: '켜기 · 끄기 값이어야 합니다' }]);
    const r = await pm.put(W(), { config: { offHoursMode: true } });
    expect(r.status).toBe(200);
    expect(r.json.changes).toEqual([expect.objectContaining({ path: 'offHoursMode', before: false, after: true })]);
    const cfg = await loadWorkspaceConfig(t.db, t.ws);
    expect((cfg as { offHoursMode?: unknown }).offHoursMode === true).toBe(true);
    expect((await loadEffectiveConfig(t.db, t.ws)).offHoursMode).toBe(true);
    await resetStored();
    expect((await loadEffectiveConfig(t.db, t.ws)).offHoursMode).toBe(false);
  });

  it('reports-impact: billing.monthlyFee · impact.contributionMargin · impact.hourlyCost를 PUT이 보존하고 impact 엔진이 원본에서 같은 키로 읽는다', async () => {
    await resetStored();
    const owner = await as('owner');
    const cfg = { billing: { monthlyFee: 8_000_000 }, impact: { contributionMargin: 0.32, hourlyCost: 60_000 } };
    const r = await owner.put(W(), { config: cfg });
    expect(r.status).toBe(200);
    const raw = (await t.db.query<{ config: unknown }>(`SELECT config FROM workspaces WHERE id = $1`, [t.ws])).rows[0].config;
    expect(raw).toEqual(cfg);
    expect(impactConfig(raw)).toMatchObject({ monthlyFee: 8_000_000, margin: 0.32, hourlyCost: 60_000, sources: { monthlyFee: 'workspace', margin: 'workspace', hourlyCost: 'workspace' } });
    expect((await owner.put(W(), { config: { impact: { contributionMargin: 0 } } })).status).toBe(400);
    await resetStored();
  });

  it('changes: 저장한 위임 범위 · 일 조정 폭 상한을 서버 승인 라우팅(routeApprover) · 반영 전 점검(evaluateGuards)이 쓴다', async () => {
    await resetStored();
    const pm = await as('pm');
    expect((await pm.put(W(), { config: { delegation: { aeMaxPct: 5, pmMaxPct: 15 }, safety: { dailyChangeCapPct: 10 } } })).status).toBe(200);
    const cfg = await loadWorkspaceConfig(t.db, t.ws);
    const budget = { kind: 'budget' as const, targetId: 'cmp_1', before: 100_000, after: 108_000, changePct: 8, approver: 'AE' as const };
    expect(routeApprover(budget).approver).toBe('AE');
    expect(withWorkspaceConfig(cfg, () => routeApprover(budget).approver)).toBe('PM');
    expect(withWorkspaceConfig(cfg, () => routeApprover({ ...budget, after: 120_000, changePct: 20 }).approver)).toBe('CLIENT');
    expect(withWorkspaceConfig(cfg, () => officialConfig([]).dailyChangeCapPct)).toBe(10);
    const bid = {
      id: 'chg_cap', module: 'adpilot', kind: 'bid', title: '입찰 +12%', targetId: 'kw_1', before: 1000, after: 1120, changePct: 12,
      status: 'approved', approver: 'AE', requestedBy: 'AE', requestedAt: '2026-11-03T09:00:00+09:00', history: [],
    } as unknown as ChangeRequest;
    const guard = (c: ChangeRequest) => evaluateGuards({ change: c, changes: [], incidents: [], data: null, today: '2026-11-03', todayAppliedBids: [], bulkIncidentStatus: new Map() });
    expect(guard(bid).blocks.some((b) => b.includes('일 조정 폭 상한'))).toBe(false);
    const inside = withWorkspaceConfig(cfg, () => guard(bid));
    expect(inside.blocks.some((b) => b.includes('일 조정 폭 상한 10%'))).toBe(true);
    await resetStored();
  });

  it('GET /api/w/:ws(코어)의 workspace.config가 저장된 덮어쓰기와 같다 — 프런트가 applyWorkspaceConfig에 넘기는 값', async () => {
    const pm = await as('pm');
    await pm.put(W(), { config: { modules: ['board', 'alert', 'flow'] } });
    const w = await pm.get(`/api/w/${t.ws}`);
    expect(w.json.workspace.config).toEqual({ modules: ['board', 'alert', 'flow'] });
    await resetStored();
  });
});
