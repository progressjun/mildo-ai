/**
 * 커넥터 카탈로그 · 커넥션 API: 역할별 허용/거부, 테넌트 격리, 입력 검증, 자격증명 암호화 · 마스킹, write_mode live 권한,
 * 연결 확인(성공 → 초기 백필 예약 · 실패 → 오류 상태, 비밀값 가림), 수동 수집 예약, 삭제 시 웨어하우스 정리, 감사 · 이벤트.
 * 실제 네트워크 없음 — google_ads 공급자를 가짜 커넥터로 바꿔 끼우고 가짜 fetch를 주입한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { installConnector } from '../ingest/testkit';
import { setDefaultConnectorFetch, expectOk } from './http';
import { writeBatch } from '../warehouse/write';
import { buildConnectorContext, type ConnectionRow } from './service';
import { kstToday, addDaysStr } from '../lib/time';

let t: TestApp;
let restore: () => void;
const calls: string[] = [];
const SECRET = 'dev-token-SECRET-123456';
const REFRESH = 'refresh-SECRET-abcdef';

beforeAll(async () => {
  restore = installConnector('google_ads', {
    label: 'Google Ads (테스트 가짜)',
    docsUrl: 'https://developers.google.com/google-ads/api/rest/overview',
    verifiedLive: false,
    credentialsSchema: z.object({ developerToken: z.string().min(8), refreshToken: z.string().min(8), customerId: z.string().regex(/^\d{10}$/) }),
    settingsSchema: z.object({ loginCustomerId: z.string().optional() }).strict(),
    credentialFields: [
      { key: 'customerId', label: '고객 ID', secret: false },
      { key: 'developerToken', label: '개발자 토큰', secret: true },
      { key: 'refreshToken', label: '갱신 토큰', secret: true },
    ],
    capabilities: { reads: ['mediaDaily'], writes: ['budget'], intraday: true, maxBackfillDays: 90 },
    async test(ctx) {
      const res = await ctx.http.request<{ name: string }>({ method: 'GET', url: 'https://googleads.example.test/customers', headers: { 'developer-token': String(ctx.credentials.developerToken) } });
      if (ctx.credentials.developerToken !== SECRET) throw new Error(`인증 실패: Bearer ${String(ctx.credentials.developerToken)}`);
      return { ok: true, message: '연결 확인', account: expectOk(res, '계정 조회').name };
    },
    async fetch() { return {}; },
  });
  setDefaultConnectorFetch(async (url) => {
    calls.push(url);
    return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"name":"수면밀도 Google Ads"}' };
  });
  t = await createTestApp();
});
afterAll(async () => {
  setDefaultConnectorFetch(null);
  restore?.();
  await t?.close();
});

const GOOD = { developerToken: SECRET, refreshToken: REFRESH, customerId: '1234567890' };
// 로그인은 분당 10회 제한 — 역할마다 한 번만 로그인해 재사용한다
const clients = new Map<string, Promise<TestClient>>();
const as = (role: 'owner' | 'admin' | 'pm' | 'ae' | 'client' | 'viewer') => {
  if (!clients.has(role)) clients.set(role, t.login(role));
  return clients.get(role)!;
};
const base = () => `/api/w/${t.ws}/connections`;
async function create(c: TestClient, body: Record<string, unknown> = {}) {
  return c.post(base(), { provider: 'google_ads', label: '구글 본계정', credentials: GOOD, ...body });
}

describe('카탈로그', () => {
  it('로그인 필요, 모든 공급자 · 입력 항목 · 기능 · 실계정 검증 여부', async () => {
    expect((await t.anon().get('/api/connectors/catalog')).status).toBe(401);
    const viewer = await as('viewer');
    const r = await viewer.get('/api/connectors/catalog');
    expect(r.status).toBe(200);
    const providers = r.json.providers as { provider: string; verifiedLive: boolean; credentialFields: unknown[]; capabilities: { maxBackfillDays: number }; sourceKind: string }[];
    expect(providers.map((p) => p.provider).sort()).toEqual(['cafe24', 'coupang', 'csv', 'demo', 'google_ads', 'kakao_moment', 'meta', 'naver_commerce', 'naver_gfa', 'naver_sa', 'ohouse']);
    const g = providers.find((p) => p.provider === 'google_ads')!;
    expect(g).toMatchObject({ kind: 'media', channel: 'google', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true });
    expect(g.credentialFields).toHaveLength(3);
    expect(providers.find((p) => p.provider === 'demo')).toMatchObject({ sourceKind: 'demo', defaultPriority: 10, capabilities: { maxBackfillDays: 400, intraday: true } });
    expect(providers.find((p) => p.provider === 'csv')).toMatchObject({ sourceKind: 'csv', defaultPriority: 50 });
  });
});

describe('커넥션 생성 · 조회', () => {
  it('configure 권한(pm · admin · owner)만 만들 수 있다', async () => {
    for (const role of ['viewer', 'client', 'ae'] as const) {
      const c = await as(role);
      expect((await create(c)).status, role).toBe(403);
    }
    expect((await (await as('ae')).get(base())).status).toBe(200); // ae는 읽기 가능
  });

  it('자격증명은 암호화 저장 · 응답 마스킹 · 감사에 값 없음, 상태 pending, 우선순위 기본 100', async () => {
    const pm = await as('pm');
    const r = await create(pm);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('SECRET');
    const conn = r.json.connection;
    expect(conn).toMatchObject({ provider: 'google_ads', channel: 'google', label: '구글 본계정', status: 'pending', writeMode: 'dry_run', priority: 100, sourceKind: 'api', hasCredentials: true, verifiedLive: false });
    expect(conn.credentials).toEqual({ customerId: '1234567890', developerToken: `••••••••(${SECRET.length}자)`, refreshToken: `••••••••(${REFRESH.length}자)` });
    expect(r.json.connections.map((c: { id: string }) => c.id)).toContain(conn.id);
    const row = (await t.db.query<{ credentials_enc: string }>('SELECT credentials_enc FROM connections WHERE id = $1', [conn.id])).rows[0];
    expect(row.credentials_enc).toMatch(/^v1:/);
    expect(row.credentials_enc).not.toContain('SECRET');
    const a = (await t.db.query<{ detail: unknown; actor: string }>(`SELECT detail, actor FROM audit_log WHERE action = 'connection.create' AND target_id = $1`, [conn.id])).rows[0];
    expect(a.actor).toBe('테스트 pm');
    expect(JSON.stringify(a.detail)).not.toContain('SECRET');
    expect(a.detail).toMatchObject({ provider: 'google_ads', fields: ['developerToken', 'refreshToken', 'customerId'] });
    const list = await pm.get(base());
    expect(list.body).not.toContain('SECRET');
  });

  it('입력 검증: 알 수 없는 공급자 · 자격증명 형식(화면 라벨 · 사유만, 값은 알려 주지 않는다) · 설정 · 잘못된 채널', async () => {
    const pm = await as('pm');
    expect((await pm.post(base(), { provider: 'tiktok' })).status).toBe(400);
    const bad = await create(pm, { credentials: { developerToken: 'SECRET1', refreshToken: REFRESH, customerId: 'abc' } });
    expect(bad.status).toBe(400);
    // 내부 키(developerToken · customerId)가 아니라 입력 화면 라벨과 한국어 사유
    expect(bad.json.error.message).toMatch(/개발자 토큰: 값이 너무 짧거나 작습니다/);
    expect(bad.json.error.message).toMatch(/고객 ID: 형식이 올바르지 않습니다/);
    expect(bad.json.error.detail.map((d: { path: string }) => d.path).sort()).toEqual(['customerId', 'developerToken']);
    expect(bad.body).not.toContain('SECRET1');
    expect((await create(pm, { settings: { unknownKey: 1 } })).status).toBe(400);
    expect((await pm.post(base(), { provider: 'csv', channel: 'tiktok' })).status).toBe(400);
    expect((await create(pm, { priority: -1 })).status).toBe(400);
  });

  it('데모 커넥션: 바로 active + 120일 백필 예약, 워크스페이스당 하나', async () => {
    const pm = await as('pm');
    const r = await pm.post(base(), { provider: 'demo' });
    expect(r.status).toBe(200);
    expect(r.json.connection).toMatchObject({ status: 'active', sourceKind: 'demo', source: 'demo', priority: 10, pendingJobs: 1 });
    const job = (await t.db.query<{ payload: { days: number }; dedupe_key: string }>(`SELECT payload, dedupe_key FROM jobs WHERE type = 'ingest.backfill' AND payload->>'connectionId' = $1`, [r.json.connection.id])).rows[0];
    expect(job.payload.days).toBe(120);
    expect((await pm.post(base(), { provider: 'demo' })).status).toBe(409);
  });
});

describe('수정 · write_mode', () => {
  it('live는 live_write(admin · owner)만 켤 수 있고, 끄는 것은 configure로 충분하다. 쓰기 모드 변경은 별도 감사', async () => {
    const pm = await as('pm');
    const admin = await as('admin');
    expect((await create(pm, { writeMode: 'live' })).status).toBe(403);
    const id = (await create(pm, { label: '쓰기 모드 테스트' })).json.connection.id;
    const denied = await pm.patch(`${base()}/${id}`, { writeMode: 'live' });
    expect(denied.status).toBe(403);
    const ok = await admin.patch(`${base()}/${id}`, { writeMode: 'live' });
    expect(ok.status).toBe(200);
    expect(ok.json.connection.writeMode).toBe('live');
    const off = await pm.patch(`${base()}/${id}`, { writeMode: 'off' });
    expect(off.status).toBe(200);
    expect(off.json.connection.writeMode).toBe('off');
    const logs = (await t.db.query<{ actor: string; detail: { before: string; after: string } }>(`SELECT actor, detail FROM audit_log WHERE action = 'connection.write_mode' AND target_id = $1 ORDER BY id`, [id])).rows;
    expect(logs.map((l) => [l.actor, l.detail.before, l.detail.after])).toEqual([['테스트 admin', 'dry_run', 'live'], ['테스트 pm', 'live', 'off']]);
    expect((await (await as('ae')).patch(`${base()}/${id}`, { label: 'x' })).status).toBe(403);
  });

  it('live 커넥션의 자격증명 교체는 live_write만 (반영 대상 계정 바꿔치기 방지) — dry_run으로 내린 뒤에는 configure로 충분', async () => {
    const pm = await as('pm');
    const admin = await as('admin');
    const id = (await create(pm, { label: 'live 자격증명' })).json.connection.id;
    expect((await admin.patch(`${base()}/${id}`, { writeMode: 'live' })).status).toBe(200);
    const denied = await pm.patch(`${base()}/${id}`, { credentials: { refreshToken: 'refresh-OTHER-ACCOUNT-1' } });
    expect(denied.status).toBe(403);
    expect(denied.json.error.message).toMatch(/dry_run/);
    // 같은 요청에서 dry_run으로 내리면서 바꾸는 것은 허용 (live가 아니게 되므로)
    const lowered = await pm.patch(`${base()}/${id}`, { writeMode: 'dry_run', credentials: { refreshToken: 'refresh-OTHER-ACCOUNT-1' } });
    expect(lowered.status).toBe(200);
    expect(lowered.json.connection).toMatchObject({ writeMode: 'dry_run', status: 'pending' });
    expect((await admin.patch(`${base()}/${id}`, { writeMode: 'live' })).status).toBe(200);
    expect((await admin.patch(`${base()}/${id}`, { credentials: { refreshToken: 'refresh-ADMIN-NEW-01' } })).status).toBe(200);
    // 라벨 · 우선순위 같은 비자격증명 수정은 live여도 configure로 가능
    expect((await pm.patch(`${base()}/${id}`, { label: 'live 자격증명 (이름만)' })).status).toBe(200);
  });

  it('설정에 비밀값처럼 보이는 키가 있어도 응답에는 가린다', async () => {
    const pm = await as('pm');
    const id = (await create(pm, { label: '설정 마스킹' })).json.connection.id;
    await t.db.query(`UPDATE connections SET settings = $2 WHERE id = $1`, [id, JSON.stringify({ loginCustomerId: '9876543210', webhookSecret: 'SECRET-IN-SETTINGS', apiToken: '' })]);
    const r = await pm.get(base());
    expect(r.body).not.toContain('SECRET-IN-SETTINGS');
    expect(r.json.connections.find((c: { id: string }) => c.id === id).settings).toEqual({ loginCustomerId: '9876543210', webhookSecret: '••••', apiToken: null });
  });

  it('자격증명 수정: 빈 비밀값은 기존 유지, 새 값만 교체하고 다시 연결 확인(pending)으로', async () => {
    const pm = await as('pm');
    const id = (await create(pm, { label: '자격증명 수정' })).json.connection.id;
    await t.db.query(`UPDATE connections SET status = 'active' WHERE id = $1`, [id]);
    const same = await pm.patch(`${base()}/${id}`, { credentials: { developerToken: '', refreshToken: '' }, label: '이름만 바꿈' });
    expect(same.json.connection).toMatchObject({ label: '이름만 바꿈', status: 'active' });
    const changed = await pm.patch(`${base()}/${id}`, { credentials: { refreshToken: 'refresh-NEW-0000000' } });
    expect(changed.json.connection.status).toBe('pending');
    const row = (await t.db.query<ConnectionRow>('SELECT * FROM connections WHERE id = $1', [id])).rows[0];
    const ctx = buildConnectorContext(t.db, t.config, row);
    expect(ctx.credentials).toEqual({ ...GOOD, refreshToken: 'refresh-NEW-0000000' });
    expect(ctx.dryRun).toBe(true);
    const a = (await t.db.query<{ detail: { fieldsChanged: string[] } }>(`SELECT detail FROM audit_log WHERE action = 'connection.update' AND target_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    expect(a.detail.fieldsChanged).toEqual(['refreshToken']);
    expect(JSON.stringify(a)).not.toContain('NEW-0000000');
    const disabled = await pm.patch(`${base()}/${id}`, { status: 'disabled' });
    expect(disabled.json.connection.status).toBe('disabled');
  });
});

describe('연결 확인 · 수동 수집', () => {
  it('성공: active · 계정 이름 · 초기 백필(최대 백필 일수 이내) 예약 · 감사, 실패: error · 비밀값 가림', async () => {
    const pm = await as('pm');
    const ae = await as('ae');
    const id = (await create(pm, { label: '확인 성공' })).json.connection.id;
    expect((await ae.post(`${base()}/${id}/test`)).status).toBe(403);
    const r = await pm.post(`${base()}/${id}/test`);
    expect(r.status).toBe(200);
    expect(r.json.result).toEqual({ ok: true, message: '연결 확인', account: '수면밀도 Google Ads' });
    expect(r.json.backfillQueued).toBe(true);
    expect(r.json.connection).toMatchObject({ status: 'active', lastError: null, pendingJobs: 1 });
    expect(calls.length).toBeGreaterThan(0);
    const job = (await t.db.query<{ payload: { days: number } }>(`SELECT payload FROM jobs WHERE type = 'ingest.backfill' AND payload->>'connectionId' = $1`, [id])).rows[0];
    expect(job.payload.days).toBe(90);

    const badId = (await create(pm, { label: '확인 실패', credentials: { ...GOOD, developerToken: 'wrong-token-SECRET-zz' } })).json.connection.id;
    const bad = await pm.post(`${base()}/${badId}/test`);
    expect(bad.status).toBe(200);
    expect(bad.json.result.ok).toBe(false);
    expect(bad.json.result.message).toBe('인증 실패: Bearer ••••');
    expect(bad.body).not.toContain('SECRET');
    expect(bad.json.connection).toMatchObject({ status: 'error', lastError: '인증 실패: Bearer ••••' });
    const audits = (await t.db.query<{ detail: { ok: boolean } }>(`SELECT detail FROM audit_log WHERE action = 'connection.test' AND target_id = ANY($1::text[]) ORDER BY id`, [[id, badId]])).rows;
    expect(audits.map((a) => a.detail.ok)).toEqual([true, false]);
  });

  it('지금 수집: operate(ae 이상)만, 중복 예약 방지, 기간 검증(미래 · 최대 백필 일수), CSV · 사용 중지 거부', async () => {
    const pm = await as('pm');
    const ae = await as('ae');
    const id = (await create(pm, { label: '수동 수집' })).json.connection.id;
    for (const role of ['viewer', 'client'] as const) expect((await (await as(role)).post(`${base()}/${id}/sync`)).status, role).toBe(403);
    const r = await ae.post(`${base()}/${id}/sync`);
    expect(r.status).toBe(200);
    expect(r.json.queued).toBe(true);
    expect(r.json.jobIds).toHaveLength(2); // daily + intraday
    const again = await ae.post(`${base()}/${id}/sync`);
    expect(again.json).toMatchObject({ queued: false, alreadyQueued: true });
    const today = kstToday();
    const ranged = await ae.post(`${base()}/${id}/sync`, { from: addDaysStr(today, -30), to: addDaysStr(today, -1) });
    expect(ranged.json).toMatchObject({ queued: true, range: { from: addDaysStr(today, -30), to: addDaysStr(today, -1) } });
    expect((await ae.post(`${base()}/${id}/sync`, { from: addDaysStr(today, -1), to: addDaysStr(today, 1) })).status).toBe(400);
    const old = await ae.post(`${base()}/${id}/sync`, { from: addDaysStr(today, -200), to: addDaysStr(today, -150) });
    expect(old.status).toBe(400);
    expect(old.json.error.code).toBe('range_too_old');
    expect((await ae.post(`${base()}/${id}/sync`, { from: '2026/10/01' })).status).toBe(400);
    const csv = (await pm.post(base(), { provider: 'csv', label: '엑셀 업로드' })).json.connection;
    expect(csv).toMatchObject({ status: 'active', priority: 50, sourceKind: 'csv' });
    expect((await ae.post(`${base()}/${csv.id}/sync`)).status).toBe(400);
    await pm.patch(`${base()}/${id}`, { status: 'disabled' });
    expect((await ae.post(`${base()}/${id}/sync`)).status).toBe(409);
    const audit = (await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'connection.sync' AND target_id = $1`, [id])).rowCount;
    expect(audit).toBeGreaterThanOrEqual(3);
  });
});

describe('삭제 · 테넌트 격리', () => {
  it('삭제하면 그 출처의 웨어하우스 행과 대기 잡이 정리되고 감사 · 이벤트가 남는다', async () => {
    const pm = await as('pm');
    const id = (await create(pm, { label: '삭제 대상' })).json.connection.id;
    await writeBatch(t.db, t.ws, id, { mediaDaily: [{ date: '2026-10-01', media: 'google', impressions: 1, clicks: 1, cost: 1, conversions: 0, revenue: 0 }] });
    await pm.post(`${base()}/${id}/sync`);
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => got.push(e.type));
    expect((await (await as('ae')).del(`${base()}/${id}`)).status).toBe(403);
    const r = await pm.del(`${base()}/${id}`);
    expect(r.status).toBe(200);
    expect(r.json.purgedRows).toBe(1);
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [id])).rowCount).toBe(0);
    expect((await t.db.query(`SELECT 1 FROM jobs WHERE status = 'queued' AND payload->>'connectionId' = $1`, [id])).rowCount).toBe(0);
    // 대기 잡은 실패가 아니라 취소(done + 사유)로 끝난다 — 운영 모니터링의 실패 잡 수에 섞이지 않게
    const cancelled = (await t.db.query<{ status: string; result: { cancelled: string } }>(`SELECT status, result FROM jobs WHERE payload->>'connectionId' = $1`, [id])).rows;
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every((j) => j.status === 'done' && j.result.cancelled === '커넥션 삭제로 취소')).toBe(true);
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'connection.delete' AND target_id = $1`, [id])).rowCount).toBe(1);
    for (let i = 0; i < 20 && !got.includes('dataset'); i++) await new Promise((res) => setTimeout(res, 50));
    off();
    expect(got).toEqual(expect.arrayContaining(['connection', 'dataset']));
    expect((await pm.del(`${base()}/${id}`)).status).toBe(404);
  });

  it('다른 워크스페이스의 커넥션은 보이지도 바뀌지도 않는다 (404)', async () => {
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-conn', '다른 브랜드', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    const foreign = (await t.db.query<{ id: string }>(`INSERT INTO connections (workspace_id, provider, kind, label) VALUES ($1, 'google_ads', 'media', '남의 커넥션') RETURNING id`, [other])).rows[0].id;
    const owner = await as('owner');
    expect((await owner.get(`/api/w/${other}/connections`)).status).toBe(404);
    expect((await owner.patch(`${base()}/${foreign}`, { label: '탈취' })).status).toBe(404);
    expect((await owner.post(`${base()}/${foreign}/test`)).status).toBe(404);
    expect((await owner.post(`${base()}/${foreign}/sync`)).status).toBe(404);
    expect((await owner.del(`${base()}/${foreign}`)).status).toBe(404);
    expect((await owner.patch(`${base()}/not-a-uuid`, { label: 'x' })).status).toBe(404);
    const list = await owner.get(base());
    expect(list.json.connections.map((c: { id: string }) => c.id)).not.toContain(foreign);
    expect((await t.db.query<{ label: string }>('SELECT label FROM connections WHERE id = $1', [foreign])).rows[0].label).toBe('남의 커넥션');
  });
});
