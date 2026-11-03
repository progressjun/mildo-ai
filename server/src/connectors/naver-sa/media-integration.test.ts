/**
 * connectors-media × 다른 도메인 계약 (실제 PostgreSQL · 네트워크 호출 없음):
 *  - 카탈로그(GET /api/connectors/catalog): 5개 매체 공급자 · verifiedLive=false · 한국어 자격증명 안내
 *  - 커넥션 생성(POST /api/w/:ws/connections): 이 도메인 자격증명 스키마로 검증(형식 오류 400) · 비밀값 마스킹 · 권한(ae 거부) · 감사
 *  - 연결 확인(POST …/:id/test): 테스트 중 네트워크 차단 → 한국어 실패 메시지, 비밀값 비노출
 *  - 웨어하우스(writeBatch): 이 도메인 fetch 결과(NormalizedBatch)가 그대로 적재된다
 *  - 변경 요청 반영(changes API, 기본 해석기 = 실제 레지스트리): dry_run이면 이 커넥터가 만든 요청 단계가 실행 기록에 남고 매체 호출은 없다
 *  - 테넌트 격리: 다른 워크스페이스 커넥션은 404
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/core/types';
import { generateDemoData } from '@/data/demo';
import { createTestApp, type TestApp, type TestClient } from '../../../test/app';
import { encryptCredentials } from '../credentials';
import { writeBatch } from '../../warehouse/write';
import { configureChanges, resetChangesConfig, settleInflight } from '../../changes/index';
import { connector as naverSa } from './index';
import { fakeCtx, fakeHttp } from './fake-http';
import { naverRoutes, KW_GENERIC } from './fixtures';
import { setNowForTest } from '../../lib/time';

let t: TestApp;
const u: Record<string, TestClient> = {};
// 10시 기준 데모 데이터 (14시 데이터는 카카오 매체 자동 조정 보류 시나리오가 있어 반영 전 점검에서 보류된다 — changes 도메인 안전장치)
const BASE_DATA = generateDemoData('2026-11-02', 10);
// 이 도메인 커넥터가 만든 엔티티가 Dataset에 들어온 상태 (실서비스에서는 수집 → Dataset 빌더 경로)
const DATA = {
  ...BASE_DATA,
  keywords: [...BASE_DATA.keywords, { ...BASE_DATA.keywords[1], id: 'gads-kw-5001-9001', text: '수면밀도', adgroup: '브랜드', bid: 1500, maxBid: 3000, media: 'google' as const, campaignId: 'gads-cmp-111', adgroupId: '5001' }],
  campaigns: [
    ...BASE_DATA.campaigns,
    { id: 'kakao-cmp-1001', media: 'kakao' as const, name: '방문 리마케팅', dailyBudget: 300000, spentToday: 90000, status: 'on' as const, hourOfData: 10 },
    { id: 'meta-adset-22', media: 'meta' as const, name: '리타겟팅 · 장바구니', dailyBudget: 150000, spentToday: 40000, status: 'on' as const, hourOfData: 10 },
    { id: 'gfa-cmp-1', media: 'naver_gfa' as const, name: '쇼핑 고객 확장', dailyBudget: 300000, spentToday: 90000, status: 'on' as const, hourOfData: 10, adGroups: [{ id: '11', name: '리타겟팅', status: 'on' as const, dailyBudget: 300000 }] },
  ],
};
const MEDIA = ['naver_sa', 'google_ads', 'meta', 'kakao_moment', 'naver_gfa'];

beforeAll(async () => {
  t = await createTestApp();
  for (const r of ['owner', 'pm', 'ae', 'viewer']) u[r] = await t.login(r);
});
afterAll(async () => {
  await settleInflight();
  resetChangesConfig();
  await t?.close();
});
beforeEach(async () => {
  await settleInflight();
  for (const tbl of ['change_executions', 'change_requests', 'incidents', 'jobs', 'wh_entities', 'wh_media_daily', 'wh_keyword_daily', 'wh_media_hourly', 'connections']) await t.db.query(`DELETE FROM ${tbl}`);
  resetChangesConfig();
  configureChanges({ buildDataset: async () => DATA });
});

async function insertConnection(ws: string, provider: string, channel: string, creds: Record<string, unknown>, writeMode = 'dry_run', settings: Record<string, unknown> = {}): Promise<string> {
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, write_mode, credentials_enc, settings) VALUES ($1, $2, 'media', $3, $4, 'active', $5, $6, $7) RETURNING id`,
    [ws, provider, channel, `${provider} 테스트`, writeMode, encryptCredentials(creds, t.config.encryptionKey), JSON.stringify(settings)],
  );
  return r.rows[0].id;
}
const entity = (type: string, id: string, source: string, channel: string, doc: object) =>
  t.db.query(`INSERT INTO wh_entities (workspace_id, entity_type, external_id, source, channel, doc) VALUES ($1, $2, $3, $4, $5, $6)`, [t.ws, type, id, source, channel, JSON.stringify(doc)]);

const changes = (p = '') => `/api/w/${t.ws}/changes${p}`;
async function approveAndApply(change: Partial<ChangeRequest>): Promise<{ status: string; execution: Record<string, any> }> {
  const c = await u.pm.post(changes(''), { change: { reason: '통합 테스트', requestedBy: 'AD Pilot', ...change } });
  expect([200, 201]).toContain(c.status);
  const id = c.json.change.id as string;
  expect((await u.pm.patch(changes(`/${id}`), { patch: { status: 'approved' } })).status).toBe(200);
  const r = await u.pm.patch(changes(`/${id}`), { patch: { status: 'applied' }, action: '실행 · 반영' });
  expect(r.status).toBe(200);
  return r.json.change;
}

describe('카탈로그 · 커넥션', () => {
  it('카탈로그에 5개 매체 공급자 — 수집 가능 · 실계정 미검증 · 한국어 안내', async () => {
    const r = await u.viewer.get('/api/connectors/catalog');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries((r.json.providers as { provider: string }[]).map((p) => [p.provider, p as any]));
    for (const p of MEDIA) {
      expect(byId[p]).toBeTruthy();
      expect(byId[p].verifiedLive).toBe(false);
      expect(byId[p].available).toBe(true);
      expect(byId[p].docsUrl).toMatch(/^https:\/\//);
      expect(byId[p].credentialFields.length).toBeGreaterThan(0);
      expect(byId[p].credentialFields.every((f: { label: string; help?: string }) => /[가-힣]/.test(f.label) && !!f.help)).toBe(true);
    }
    expect(byId.naver_sa.capabilities.writes).toEqual(['bid', 'budget', 'status', 'keyword_add']);
    expect(byId.google_ads.capabilities.writes).toEqual(['bid', 'budget', 'status']);
    expect(byId.meta.capabilities.writes).toEqual(['budget', 'status']);
    expect(byId.kakao_moment.capabilities.writes).toEqual(['budget', 'status']);
    expect(byId.naver_gfa.capabilities.writes).toEqual(['budget', 'status']);
  });

  it('생성: 자격증명 형식 검증(400) · ae 거부(403) · 비밀값 마스킹 · 감사, 다른 워크스페이스 404', async () => {
    const base = `/api/w/${t.ws}/connections`;
    const good = { clientId: '1234567890-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-integration-secret', refreshToken: '1//0integration-refresh', customerId: '123-456-7890' };
    const bad = await u.pm.post(base, { provider: 'google_ads', credentials: { ...good, customerId: '12-34' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/customerId/);
    expect((await u.ae.post(base, { provider: 'google_ads', credentials: good })).status).toBe(403);

    const ok = await u.pm.post(base, { provider: 'google_ads', credentials: good });
    expect(ok.status).toBe(200);
    const view = ok.json.connection;
    expect(view).toMatchObject({ provider: 'google_ads', channel: 'google', writeMode: 'dry_run', verifiedLive: false });
    expect(view.credentials.customerId).toBe('1234567890');
    expect(view.credentials.clientSecret).not.toContain('integration-secret');
    expect(JSON.stringify(ok.json)).not.toContain(good.refreshToken);
    const audit = await t.db.query<{ detail: unknown }>(`SELECT detail FROM audit_log WHERE action = 'connection.create' AND target_id = $1`, [view.id]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain(good.clientSecret);

    // 연결 확인: 테스트 환경은 실제 네트워크 차단 → 한국어 실패 메시지, 비밀값 비노출
    const test = await u.pm.post(`${base}/${view.id}/test`, {});
    expect(test.status).toBe(200);
    const result = test.json.result ?? test.json;
    expect(JSON.stringify(test.json)).toMatch(/Google Ads/);
    expect(JSON.stringify(test.json)).not.toContain(good.clientSecret);
    expect(result.ok ?? false).toBe(false);

    const other = await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'media-other', '다른', '다른') RETURNING id`, [t.orgId]);
    const foreign = await insertConnection(other.rows[0].id, 'meta', 'meta', { accessToken: 'EAAforeign-token-0123456789', adAccountId: '1' });
    expect((await u.pm.post(`${base}/${foreign}/test`, {})).status).toBe(404);
  });
});

describe('웨어하우스 적재', () => {
  it('네이버 검색광고 fetch 결과가 wh_* · wh_entities에 그대로 들어간다', async () => {
    setNowForTest(Date.parse('2026-11-02T05:30:00Z'));
    try {
      const conn = await insertConnection(t.ws, 'naver_sa', 'naver_sa', { apiKey: 'test-api-key-0123', secretKey: 'test-secret-key-0123', customerId: '1234567' });
      const batch = await naverSa.fetch(fakeCtx({ apiKey: 'test-api-key-0123', secretKey: 'test-secret-key-0123', customerId: '1234567' }, { keywordDays: 2 }, fakeHttp(naverRoutes({ today: '2026-11-02' }))), { from: '2026-10-31', to: '2026-11-02' });
      const w = await writeBatch(t.db, t.ws, conn, batch, { replaceEntities: true, keywordChannel: 'naver_sa' });
      expect(w.byTable.mediaDaily).toBe(3);
      const kw = await t.db.query<{ doc: Record<string, unknown> }>(`SELECT doc FROM wh_entities WHERE workspace_id = $1 AND entity_type = 'keyword' AND external_id = $2 AND source = $3`, [t.ws, KW_GENERIC, conn]);
      expect(kw.rows[0].doc).toMatchObject({ id: KW_GENERIC, text: '퀸 매트리스', bid: 900, maxBid: 1800, media: 'naver_sa' });
      const daily = await t.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM wh_keyword_daily WHERE workspace_id = $1 AND source = $2`, [t.ws, conn]);
      expect(Number(daily.rows[0].n)).toBe(batch.keywordDaily!.length);
      const acc = await t.db.query<{ doc: Record<string, unknown> }>(`SELECT doc FROM wh_entities WHERE workspace_id = $1 AND entity_type = 'account'`, [t.ws]);
      expect(acc.rows[0].doc).toMatchObject({ id: 'nsa-1234567', balance: 1_500_000 });
    } finally {
      setNowForTest(null);
    }
  });
});

describe('변경 요청 반영 (기본 해석기 · dry_run)', () => {
  it('Google 키워드 입찰 · 카카오 캠페인 예산 · Meta 광고 세트 OFF — 커넥터가 만든 요청 단계만 기록, 매체 호출 없음', async () => {
    const g = await insertConnection(t.ws, 'google_ads', 'google', { clientId: '1234567890-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x', refreshToken: '1//0x-refresh', customerId: '1234567890' });
    await entity('keyword', 'gads-kw-5001-9001', g, 'google', { id: 'gads-kw-5001-9001', text: '수면밀도', bid: 1500, maxBid: 3000, media: 'google' });
    const gb = await approveAndApply({ module: 'adpilot', kind: 'bid', target: '수면밀도 입찰가', targetId: 'gads-kw-5001-9001', before: 1500, after: 1650, changePct: 10, approver: 'AE' });
    expect(gb.status).toBe('applied');
    expect(gb.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'google_ads' });
    expect(JSON.stringify(gb.execution.request)).toContain('adGroupCriteria:mutate');
    expect(JSON.stringify(gb.execution.request)).toContain('1650000000');
    expect(JSON.stringify(gb.execution)).not.toContain('GOCSPX-x');
    expect(gb.execution.request).toMatchObject({ dryRun: true, what: '키워드 CPC 입찰가 변경' });
    expect(gb.execution.request.steps.map((x: { method: string; url: string }) => `${x.method} ${x.url}`)).toEqual([
      'POST https://googleads.googleapis.com/v26/customers/1234567890/googleAds:searchStream',
      'POST https://googleads.googleapis.com/v26/customers/1234567890/adGroupCriteria:mutate',
    ]);

    const k = await insertConnection(t.ws, 'kakao_moment', 'kakao', { accessToken: 'kakao-business-token-0123', adAccountId: '1111' });
    await entity('campaign', 'kakao-cmp-1001', k, 'kakao', { id: 'kakao-cmp-1001', media: 'kakao', name: '방문 리마케팅', dailyBudget: 300000, spentToday: 0, status: 'on', hourOfData: 10 });
    const kb = await approveAndApply({ module: 'adpilot', kind: 'budget', target: '방문 리마케팅 일 예산', targetId: 'budget:kakao-cmp-1001:', before: 300000, after: 330000, changePct: 10, approver: 'PM' });
    expect(kb.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'kakao_moment' });
    expect(JSON.stringify(kb.execution.request)).toContain('/campaigns/dailyBudgetAmount');
    expect(JSON.stringify(kb.execution.request)).toContain('330000');

    const m = await insertConnection(t.ws, 'meta', 'meta', { accessToken: 'EAAintegration-token-0123456789', adAccountId: '1234567' });
    await entity('campaign', 'meta-adset-22', m, 'meta', { id: 'meta-adset-22', media: 'meta', name: '리타겟팅 · 장바구니', dailyBudget: 150000, spentToday: 0, status: 'on', hourOfData: 10 });
    const ms = await approveAndApply({ module: 'adpilot', kind: 'status', target: '리타겟팅 · 장바구니 일시 중지', targetId: 'meta-adset-22', before: 'on', after: 'off', approver: 'PM' });
    expect(ms.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'meta' });
    expect(JSON.stringify(ms.execution.request)).toContain('PAUSED');
    expect(JSON.stringify(ms.execution)).not.toContain('EAAintegration');

    const exec = await t.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM change_executions WHERE workspace_id = $1 AND mode = 'dry_run' AND ok`, [t.ws]);
    expect(Number(exec.rows[0].n)).toBe(3);
  });

  it('GFA Control: 광고그룹 OFF(gfa:adgroup:<캠페인>:<광고 그룹 번호>) · 캠페인 일 예산(gfa:budget:) — 실제 광고 그룹 번호로 요청 단계 기록', async () => {
    const gfaCreds = { clientId: 'gfa-client-id', clientSecret: 'gfa-integration-secret', refreshToken: 'gfa-refresh-token-0123', adAccountNo: '1017' };
    const c = await insertConnection(t.ws, 'naver_gfa', 'naver_gfa', gfaCreds);
    await entity('campaign', 'gfa-cmp-1', c, 'naver_gfa', DATA.campaigns.find((x) => x.id === 'gfa-cmp-1')!);
    const off = await approveAndApply({ module: 'gfa', kind: 'status', target: '쇼핑 고객 확장 · 리타겟팅', targetId: 'gfa:adgroup:gfa-cmp-1:11', before: 'on', after: 'off', approver: 'PM' });
    expect(off.status).toBe('applied');
    expect(off.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'naver_gfa' });
    const offSteps = off.execution.request.steps as { method: string; url: string; query?: Record<string, unknown> }[];
    expect(offSteps[0]).toMatchObject({ method: 'POST', url: 'https://openapi.naver.com/v1/ad-api/1.0/adAccounts/1017/adSets/activate', query: { adSetNos: '11', activated: false } });

    // 감액 (데모 Dataset의 GFA 계정은 잔액 1일치 미만 · 자동충전 실패라 증액은 changes 도메인 GFA Control 검증이 보류한다 — 의도된 안전장치)
    const b = await approveAndApply({ module: 'gfa', kind: 'budget', target: '쇼핑 고객 확장 일 예산', targetId: 'gfa:budget:gfa-cmp-1', before: 300000, after: 270000, changePct: -10, approver: 'PM' });
    expect(b.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'naver_gfa' });
    expect(JSON.stringify(b.execution.request)).toContain('"campaignSpendLimit":270000');
    expect(JSON.stringify(b.execution.request)).toContain('editSpendLimit');
    expect(JSON.stringify(b.execution.request)).toContain('AdSetEditBudgetParam');
    expect(JSON.stringify(b.execution)).not.toContain(gfaCreds.clientSecret);
    expect(JSON.stringify(b.execution)).not.toContain(gfaCreds.refreshToken);
  });

  it('AD Pilot 테스트 후보 등록(keyword_add, term:<검색어>) → 네이버 검색광고 커넥션의 테스트 광고그룹으로 POST 단계 기록', async () => {
    const GRP = 'grp-a001-01-000000099999999';
    await insertConnection(t.ws, 'naver_sa', 'naver_sa', { apiKey: 'test-api-key-0123', secretKey: 'test-secret-key-0123', customerId: '1234567' }, 'dry_run', { testAdgroups: { generic: GRP } });
    const r = await approveAndApply({ module: 'adpilot', kind: 'keyword_add', target: '퀸 매트리스 추천 → GENERIC_TEST 등록', targetId: 'term:퀸 매트리스 추천', before: '미등록', after: 'GENERIC_TEST · 입찰 1,200원', approver: 'AE' });
    expect(r.status).toBe('applied');
    expect(r.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'naver_sa' });
    const steps = r.execution.request.steps as { method: string; url: string; query?: unknown; body?: unknown }[];
    expect(steps.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.searchad.naver.com/ncc/keywords', query: { nccAdgroupId: GRP }, body: [{ keyword: '퀸 매트리스 추천', bidAmt: 1200 }] });
    expect(JSON.stringify(r.execution)).not.toContain('test-secret-key-0123');
  });
});
