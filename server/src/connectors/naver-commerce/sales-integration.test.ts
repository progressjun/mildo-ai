/**
 * connectors-sales × data 도메인 통합 (실제 PostgreSQL · 네트워크 없음 — 공급자 가짜 서버를 connectors/http.ts 래퍼 아래 FetchLike로 꽂는다):
 *  - 카탈로그: 판매 채널 4종 · verifiedLive=false · 한국어 안내 · 오늘의집은 CSV 전용(수집 항목 없음)
 *  - 커넥션 생성(POST /api/w/:ws/connections, data 도메인 service): 이 도메인 자격증명 스키마로 검증(400) · ae 거부(403) · 비밀값 마스킹 · 감사
 *  - 연결 확인(POST …/:id/test) → 성공 시 초기 백필(ingest.backfill 120일) → 수집 잡 실행(ingest) → wh_sales_daily · wh_entities
 *  - buildDataset: brandstore · coupang · own_mall 행이 출처 종류 'api'로, 오늘의집은 CSV 업로드(출처 'csv')로
 *  - 카페24 갱신 토큰 회전: ctx.saveCredentials → connections.credentials_enc 암호화 저장 · 감사(connection.credentials_refreshed, 값 없음)
 *  - 테넌트 격리: 다른 워크스페이스 커넥션 404
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../../test/app';
import { drainIngest, kst, registerDataJobsForTest } from '../../ingest/testkit';
import { setDefaultConnectorFetch } from '../http';
import { decryptCredentials, encryptCredentials } from '../credentials';
import { buildDataset } from '../../warehouse/dataset';
import { setNowForTest } from '../../lib/time';
import { combine, handlerFetch } from './sales-testkit';
import { NAVER_CREDS, naverHandler } from './fixtures';
import { _resetNaverCommerceTokenCacheForTest } from './client';
import { COUPANG_CREDS, coupangHandler } from '../coupang/fixtures';
import { CAFE24_CREDS, cafe24Handler, cafe24State } from '../cafe24/fixtures';
import { _resetCafe24InflightForTest } from '../cafe24/client';

const TODAY = '2026-11-03';
let t: TestApp;
const u: Record<string, TestClient> = {};
const c24 = cafe24State();
const fetchImpl = handlerFetch(combine(naverHandler(), coupangHandler(), cafe24Handler(c24)));
const ids: Record<string, string> = {};
const base = () => `/api/w/${t.ws}/connections`;

beforeAll(async () => {
  setNowForTest(kst(TODAY, 10, 0));
  registerDataJobsForTest();
  _resetNaverCommerceTokenCacheForTest();
  _resetCafe24InflightForTest();
  setDefaultConnectorFetch(fetchImpl);
  t = await createTestApp();
  for (const r of ['owner', 'pm', 'ae', 'viewer']) u[r] = await t.login(r);
});
afterAll(async () => {
  setDefaultConnectorFetch(null);
  setNowForTest(null);
  await t?.close();
});

describe('카탈로그', () => {
  it('판매 채널 4종 — 채널 매핑 · 실계정 미검증 · 문서 URL · 한국어 안내, 오늘의집은 CSV 전용(수집 항목 없음)', async () => {
    const r = await u.viewer.get('/api/connectors/catalog');
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.json.providers as { provider: string }[]).map((p) => [p.provider, p as any]));
    expect(by.naver_commerce).toMatchObject({ kind: 'sales', channel: 'brandstore', verifiedLive: false, available: true });
    expect(by.coupang).toMatchObject({ kind: 'sales', channel: 'coupang', verifiedLive: false, available: true });
    expect(by.cafe24).toMatchObject({ kind: 'sales', channel: 'own_mall', verifiedLive: false, available: true });
    expect(by.ohouse).toMatchObject({ kind: 'sales', channel: 'ohouse', verifiedLive: false, available: false, label: '오늘의집' });
    for (const p of ['naver_commerce', 'coupang', 'cafe24']) {
      expect(by[p].docsUrl).toMatch(/^https:\/\//);
      expect(by[p].capabilities.reads).toEqual(['salesDaily', 'products', 'promotions']);
      expect(by[p].capabilities.writes).toEqual([]);
      expect(by[p].credentialFields.every((f: { label: string; help?: string }) => /[가-힣]/.test(f.label) && !!f.help)).toBe(true);
    }
  });
});

describe('커넥션 생성 → 연결 확인 → 초기 백필 → Dataset', () => {
  it('생성: 형식 오류 400 · ae 403 · 비밀값 마스킹 · 감사(값 없음)', async () => {
    const bad = await u.pm.post(base(), { provider: 'naver_commerce', credentials: { ...NAVER_CREDS, clientSecret: 'not-bcrypt-salt' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/clientSecret/);
    expect((await u.ae.post(base(), { provider: 'coupang', credentials: COUPANG_CREDS })).status).toBe(403);

    for (const [provider, credentials] of [['naver_commerce', NAVER_CREDS], ['coupang', COUPANG_CREDS], ['cafe24', CAFE24_CREDS]] as const) {
      const r = await u.pm.post(base(), { provider, credentials });
      expect(r.status).toBe(200);
      const view = r.json.connection;
      ids[provider] = view.id;
      expect(view).toMatchObject({ provider, kind: 'sales', status: 'pending', sourceKind: 'api', verifiedLive: false });
      const raw = JSON.stringify(r.json);
      for (const secret of [NAVER_CREDS.clientSecret, COUPANG_CREDS.secretKey, COUPANG_CREDS.accessKey, CAFE24_CREDS.clientSecret, CAFE24_CREDS.refreshToken]) expect(raw).not.toContain(secret);
    }
    const views = (await u.viewer.get(base())).json.connections as { provider: string; channel: string; credentials: Record<string, string | null> }[];
    const naver = views.find((v) => v.provider === 'naver_commerce')!;
    expect(naver.channel).toBe('brandstore');
    expect(naver.credentials.clientId).toBe(NAVER_CREDS.clientId);
    expect(naver.credentials.clientSecret).toMatch(/^••••/);
    expect(views.find((v) => v.provider === 'coupang')!.credentials.vendorId).toBe('A00012345');
    expect(views.find((v) => v.provider === 'cafe24')!.channel).toBe('own_mall');
    const audit = await t.db.query<{ detail: unknown }>(`SELECT detail FROM audit_log WHERE action = 'connection.create' AND workspace_id = $1`, [t.ws]);
    expect(audit.rows).toHaveLength(3);
    expect(JSON.stringify(audit.rows)).not.toMatch(/\$2a\$10\$|cp-secret|c24-secret|c24-refresh/);
  });

  it('연결 확인 성공 → active · 초기 백필 예약 → 수집 잡이 wh_sales_daily · 상품 · 프로모션을 쓴다', async () => {
    for (const p of ['naver_commerce', 'coupang', 'cafe24']) {
      const r = await u.pm.post(`${base()}/${ids[p]}/test`, {});
      expect(r.status).toBe(200);
      expect(r.json.result.ok, `${p}: ${r.json.result.message}`).toBe(true);
      expect(r.json.backfillQueued).toBe(true);
      expect(r.json.connection.status).toBe('active');
    }
    const ran = await drainIngest(t.db, t.config);
    expect(ran).toBe(3);
    const runs = await t.db.query<{ connection_id: string; status: string; job: string; error: string | null }>(`SELECT connection_id, status, job, error FROM ingest_runs WHERE workspace_id = $1 ORDER BY started_at`, [t.ws]);
    expect(runs.rows.filter((x) => x.status === 'failed')).toEqual([]);
    // 120일 백필 = 31일 묶음 4개 + 오늘 당일 수집 1개 (커넥션마다)
    for (const p of ['naver_commerce', 'coupang', 'cafe24']) expect(runs.rows.filter((x) => x.connection_id === ids[p]).map((x) => x.job)).toEqual(['backfill', 'backfill', 'backfill', 'backfill', 'intraday']);

    const rows = await t.db.query<{ source: string; channel: string; n: number; orders: number; revenue: string }>(
      `SELECT source, channel, count(*)::int AS n, sum(orders)::int AS orders, sum(revenue)::bigint::text AS revenue FROM wh_sales_daily WHERE workspace_id = $1 GROUP BY 1, 2 ORDER BY 2`, [t.ws],
    );
    expect(rows.rows).toEqual([
      { source: ids.naver_commerce, channel: 'brandstore', n: 121, orders: 5, revenue: '4050000' },
      { source: ids.coupang, channel: 'coupang', n: 121, orders: 4, revenue: '3210000' },
      { source: ids.cafe24, channel: 'own_mall', n: 121, orders: 3, revenue: '2420000' },
    ]);
    const ents = await t.db.query<{ source: string; entity_type: string; n: number }>(`SELECT source, entity_type, count(*)::int AS n FROM wh_entities WHERE workspace_id = $1 GROUP BY 1, 2 ORDER BY 2, 1`, [t.ws]);
    const count = (src: string, type: string) => ents.rows.find((r) => r.source === src && r.entity_type === type)?.n ?? 0;
    expect([count(ids.naver_commerce, 'product'), count(ids.coupang, 'product'), count(ids.cafe24, 'product')]).toEqual([2, 2, 3]);
    // 정액 쿠폰 · 사은품 혜택은 할인율(%)이 없어 프로모션에서 빠진다 (경고 promotions_skipped)
    expect([count(ids.naver_commerce, 'promotion'), count(ids.coupang, 'promotion'), count(ids.cafe24, 'promotion')]).toEqual([1, 2, 1]);
  });

  it('buildDataset: 세 채널이 실데이터(api) 출처로, 값은 공급자 응답 그대로', async () => {
    const d = await buildDataset(t.db, t.ws, { today: TODAY, hour: 10 });
    const row = (ch: string, date: string) => d.salesDaily.find((r) => r.channel === ch && r.date === date);
    expect(row('brandstore', '2026-11-01')).toEqual({ date: '2026-11-01', channel: 'brandstore', visitors: 0, detailViews: 0, carts: 0, orders: 3, revenue: 2_570_000, adAttributedRevenue: 990_000 });
    expect(row('brandstore', '2026-11-02')).toMatchObject({ orders: 2, revenue: 1_480_000 });
    expect(row('coupang', '2026-11-01')).toMatchObject({ orders: 2, revenue: 1_730_000 });
    expect(row('coupang', '2026-11-02')).toMatchObject({ orders: 2, revenue: 1_480_000 });
    expect(row('own_mall', '2026-11-01')).toEqual({ date: '2026-11-01', channel: 'own_mall', visitors: 5400, detailViews: 2500, carts: 240, orders: 2, revenue: 1_230_000, adAttributedRevenue: 940_000 });
    expect(row('own_mall', '2026-11-02')).toMatchObject({ visitors: 6100, detailViews: 3400, carts: 290, orders: 1, revenue: 1_190_000 });
    expect(row('brandstore', '2026-10-15')).toMatchObject({ orders: 0, revenue: 0 });
    for (const [ch, p] of [['brandstore', 'naver_commerce'], ['coupang', 'coupang'], ['own_mall', 'cafe24']]) {
      expect(d.meta?.sources).toContainEqual(expect.objectContaining({ channel: ch, source: ids[p], kind: 'api', latestDate: TODAY }));
    }
    expect(d.products.map((p) => p.id).sort()).toEqual(['c24-11', 'c24-12', 'c24-13', 'cpg-80240831', 'cpg-80240832', 'ncm-9001', 'ncm-9002']);
    expect(d.products.find((p) => p.id === 'ncm-9001')?.options.map((o) => o.price)).toEqual([790_000, 990_000, 1_190_000]);
    expect(d.promotions.map((p) => `${p.channel}:${p.id}:${p.status}`)).toEqual(expect.arrayContaining(['brandstore:ncm-promo-9001:live', 'coupang:cpg-coupon-2246326:live', 'own_mall:c24-benefit-3:live']));
  });

  it('카페24 갱신 토큰 회전: 연결 확인 때 받은 새 갱신 토큰이 암호화 저장되고, 백필은 저장된 액세스 토큰을 다시 쓴다', async () => {
    expect(c24.tokenCalls).toHaveLength(1);
    const row = await t.db.query<{ credentials_enc: string }>(`SELECT credentials_enc FROM connections WHERE id = $1`, [ids.cafe24]);
    expect(row.rows[0].credentials_enc).not.toContain('c24-refresh');
    const creds = decryptCredentials<Record<string, unknown>>(row.rows[0].credentials_enc, t.config.encryptionKey);
    expect(creds).toMatchObject({ mallId: 'mildomall', refreshToken: 'c24-refresh-1001', accessToken: 'c24-access-1001' });
    expect(creds).not.toHaveProperty('authCode');
    const a = await t.db.query<{ detail: unknown; actor: string }>(`SELECT detail, actor FROM audit_log WHERE action = 'connection.credentials_refreshed' AND target_id = $1`, [ids.cafe24]);
    expect(a.rows).toHaveLength(1);
    expect(JSON.stringify(a.rows[0].detail)).not.toMatch(/c24-(refresh|access)-/);
    const view = (await u.pm.get(base())).json.connections.find((c: { id: string }) => c.id === ids.cafe24);
    expect(JSON.stringify(view)).not.toMatch(/c24-(refresh|access)-/);
  });

  it('수동 수집(operate): 일 수집 + 당일 수집이 예약되고 다시 돌아도 같은 값(멱등)', async () => {
    expect((await u.viewer.post(`${base()}/${ids.coupang}/sync`, {})).status).toBe(403);
    const r = await u.ae.post(`${base()}/${ids.coupang}/sync`, {});
    expect(r.status).toBe(200);
    expect(r.json.queued).toBe(true);
    expect(r.json.jobIds).toHaveLength(2);
    expect(await drainIngest(t.db, t.config)).toBe(2);
    const sum = await t.db.query<{ orders: number; revenue: string }>(`SELECT sum(orders)::int AS orders, sum(revenue)::bigint::text AS revenue FROM wh_sales_daily WHERE workspace_id = $1 AND source = $2`, [t.ws, ids.coupang]);
    expect(sum.rows[0]).toEqual({ orders: 4, revenue: '3210000' });
  });

  it('카페24: 액세스 토큰이 만료된 뒤 여러 묶음 백필 — 앞 묶음이 회전시킨 갱신 토큰을 뒤 묶음(같은 커넥션 행)이 다시 쓰지 않는다', async () => {
    const before = c24.tokenCalls.length;
    setNowForTest(kst(TODAY, 13, 0)); // 연결 확인 때 받은 액세스 토큰(2시간)이 만료된 시각
    try {
      const r = await u.pm.post(`${base()}/${ids.cafe24}/sync`, { from: '2026-09-01', to: '2026-11-02' });
      expect(r.status).toBe(200);
      expect(r.json.queued).toBe(true);
      expect(await drainIngest(t.db, t.config)).toBe(1);
      const runs = await t.db.query<{ job: string; status: string; error: string | null }>(
        `SELECT job, status, error FROM ingest_runs WHERE connection_id = $1 AND triggered_by = 'manual' ORDER BY started_at`, [ids.cafe24],
      );
      // 63일 = 31일 묶음 3개 + 당일 수집 — 모두 성공 (예전에는 둘째 묶음이 폐기된 갱신 토큰으로 invalid_grant)
      expect(runs.rows.map((x) => `${x.job}:${x.status}`)).toEqual(['backfill:succeeded', 'backfill:succeeded', 'backfill:succeeded', 'intraday:succeeded']);
      expect(c24.tokenCalls.slice(before).map((x) => x.body.refresh_token)).toEqual(['c24-refresh-1001']);
      const creds = decryptCredentials<Record<string, unknown>>((await t.db.query<{ credentials_enc: string }>(`SELECT credentials_enc FROM connections WHERE id = $1`, [ids.cafe24])).rows[0].credentials_enc, t.config.encryptionKey);
      expect(creds).toMatchObject({ refreshToken: 'c24-refresh-1002', accessToken: 'c24-access-1002' });
    } finally {
      setNowForTest(kst(TODAY, 10, 0));
    }
  });
});

describe('오늘의집 — CSV 경로', () => {
  it('커넥션은 만들 수 있지만 연결 확인은 CSV 안내 · 예약 수집 대상 아님, 판매 채널 일별 CSV로 들어간 행은 출처 csv', async () => {
    const c = await u.pm.post(base(), { provider: 'ohouse' });
    expect(c.status).toBe(200);
    const test = await u.pm.post(`${base()}/${c.json.connection.id}/test`, {});
    expect(test.json.result.ok).toBe(false);
    expect(test.json.result.message).toMatch(/sales_daily/);
    expect(test.json.backfillQueued).toBe(false);

    const content = ['일자,판매채널,방문자,상세조회,장바구니,주문,매출', '2026-11-01,오늘의집,1200,700,80,15,14500000', '2026-11-02,ohouse,1300,720,85,16,15200000'].join('\n');
    const up = await u.pm.post(`/api/w/${t.ws}/uploads`, { template: 'sales_daily', filename: 'ohouse-2026-11.csv', content });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(await drainIngest(t.db, t.config)).toBeGreaterThanOrEqual(1);
    const d = await buildDataset(t.db, t.ws, { today: TODAY, hour: 10 });
    expect(d.salesDaily.find((r) => r.channel === 'ohouse' && r.date === '2026-11-01')).toMatchObject({ visitors: 1200, detailViews: 700, carts: 80, orders: 15, revenue: 14_500_000 });
    expect(d.meta?.sources).toContainEqual(expect.objectContaining({ channel: 'ohouse', kind: 'csv', latestDate: '2026-11-02' }));
    expect(d.meta?.mode).toBe('live');
  });
});

describe('테넌트 격리', () => {
  it('다른 워크스페이스의 판매 채널 커넥션은 연결 확인 · 수집 모두 404, 남의 워크스페이스 목록도 404(존재 비노출)', async () => {
    const other = await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'sales-other', '다른 브랜드', '다른') RETURNING id`, [t.orgId]);
    const ws2 = other.rows[0].id;
    const foreign = await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, credentials_enc) VALUES ($1, 'coupang', 'sales', 'coupang', '남의 쿠팡', 'active', $2) RETURNING id`,
      [ws2, encryptCredentials(COUPANG_CREDS, t.config.encryptionKey)],
    );
    expect((await u.pm.post(`${base()}/${foreign.rows[0].id}/test`, {})).status).toBe(404);
    expect((await u.pm.post(`${base()}/${foreign.rows[0].id}/sync`, {})).status).toBe(404);
    expect((await u.pm.get(`/api/w/${ws2}/connections`)).status).toBe(404);
    const leaked = await t.db.query(`SELECT 1 FROM wh_sales_daily WHERE workspace_id = $1`, [ws2]);
    expect(leaked.rowCount).toBe(0);
  });
});
