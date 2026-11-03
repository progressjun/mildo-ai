/**
 * changes × 실제 커넥터 레지스트리 (기본 해석기): 데모 커넥터 시연 반영 · 네이버 검색광고 dry_run(네트워크 호출 없음) ·
 * 자격증명 복호화 · 비밀 헤더 비노출 · 지원하지 않는 공급자는 기록만.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Dataset } from '@/core/types';
import { generateDemoData } from '@/data/demo';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { encryptCredentials } from '../connectors/credentials';
import { configureChanges, resetChangesConfig, settleInflight } from './index';
import { defaultConnectorResolver } from './connector-adapter';
import type { ConnectionRow } from './targets';

let t: TestApp;
let ae: TestClient;
let viewer: TestClient;
const DATA: Dataset = generateDemoData('2026-11-02', 10);
const NAVER_KW = 'nkw-a001-01-000000000001';

beforeAll(async () => {
  t = await createTestApp();
  ae = await t.login('ae');
  viewer = await t.login('viewer');
});
afterAll(async () => {
  await settleInflight();
  resetChangesConfig();
  await t?.close();
});
beforeEach(async () => {
  for (const tbl of ['change_executions', 'change_requests', 'incidents', 'wh_entities', 'connections']) await t.db.query(`DELETE FROM ${tbl}`);
  resetChangesConfig();
  configureChanges({ buildDataset: async () => DATA });
});

const base = (p: string) => `/api/w/${t.ws}/changes${p}`;
async function conn(provider: string, channel: string | null, writeMode: string, creds?: Record<string, unknown>): Promise<string> {
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, write_mode, credentials_enc)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7) RETURNING id`,
    [t.ws, provider, provider === 'demo' ? 'other' : 'media', channel, `${provider} 연결`, writeMode, creds ? encryptCredentials(creds, t.config.encryptionKey) : null],
  );
  return r.rows[0].id;
}
const entity = (type: string, id: string, source: string, doc: Record<string, unknown>) =>
  t.db.query(`INSERT INTO wh_entities (workspace_id, entity_type, external_id, source, channel, doc) VALUES ($1, $2, $3, $4, 'naver_sa', $5)`, [t.ws, type, id, source, JSON.stringify(doc)]);
async function approvedBid(o: Record<string, unknown> = {}) {
  const r = await ae.post(base(''), { change: { module: 'flow', kind: 'bid', target: '수면밀도 입찰가', targetId: 'kw_1', before: 270, after: 280, changePct: 3.7, reason: '테스트', approver: 'AE', ...o } });
  expect(r.status).toBe(201);
  expect((await ae.patch(base(`/${r.json.change.id}`), { patch: { status: 'approved' } })).status).toBe(200);
  return r.json.change.id as string;
}

describe('기본 해석기 (connectors/service buildConnectorContext)', () => {
  it('레지스트리 정의 · 자격증명 복호화 · dryRun 플래그, 모르는 공급자는 null', async () => {
    const id = await conn('naver_sa', 'naver_sa', 'dry_run', { apiKey: 'license-0000-1111', secretKey: 'secret-key-2222', customerId: '1234567' });
    const row = (await t.db.query<ConnectionRow>('SELECT * FROM connections WHERE id = $1', [id])).rows[0];
    const b = await defaultConnectorResolver(t.db, t.config, row);
    expect(b?.def.provider).toBe('naver_sa');
    const ctx = await b!.context({ dryRun: true, log: () => undefined });
    expect(ctx).toMatchObject({ dryRun: true, connectionId: id, credentials: { customerId: '1234567' } });
    expect(await defaultConnectorResolver(t.db, t.config, { ...row, provider: 'nope' })).toBeNull();
  });
});

describe('실제 커넥터로 반영', () => {
  it('데모 워크스페이스: 데모 출처 엔티티 → 데모 커넥터 시뮬레이션 (dry_run, TEST DATA)', async () => {
    const demo = await conn('demo', null, 'dry_run');
    await entity('keyword', 'kw_1', 'demo', { id: 'kw_1', text: '수면밀도', bid: 270, maxBid: 540 });
    const id = await approvedBid();
    const r = await ae.patch(base(`/${id}`), { patch: { status: 'applied' } });
    expect(r.status).toBe(200);
    expect(r.json.change.status).toBe('applied');
    expect(r.json.change.execution).toMatchObject({ mode: 'dry_run', ok: true, provider: 'demo', connectionId: demo, request: { simulated: true, targetId: 'kw_1', after: 280 } });
  });

  it('네이버 검색광고 dry_run: 보낼 단계만 기록, 네트워크 호출 없음, 인증 헤더 값은 저장하지 않음', async () => {
    const sa = await conn('naver_sa', 'naver_sa', 'dry_run', { apiKey: 'license-0000-1111', secretKey: 'secret-key-2222', customerId: '1234567' });
    await entity('keyword', NAVER_KW, sa, { id: NAVER_KW, text: '수면밀도', bid: 270, maxBid: 540 });
    const id = await approvedBid({ targetId: NAVER_KW });
    const r = await ae.patch(base(`/${id}`), { patch: { status: 'applied' } });
    const ex = r.json.change.execution;
    expect(r.json.change.status).toBe('applied');
    expect(ex).toMatchObject({ mode: 'dry_run', ok: true, provider: 'naver_sa', connectionId: sa });
    expect(ex.request.steps.map((s: { method: string }) => s.method)).toEqual(['GET', 'PUT']);
    expect(ex.request.steps[1].body).toMatchObject({ nccKeywordId: NAVER_KW, bidAmt: 280 });
    const dump = JSON.stringify(await viewer.get(base(`/${id}/executions`))) + JSON.stringify(r.json);
    expect(dump).not.toContain('license-0000-1111');
    expect(dump).not.toContain('secret-key-2222');
    const audit = await t.db.query(`SELECT detail FROM audit_log WHERE target_id = $1`, [id]);
    expect(JSON.stringify(audit.rows)).not.toContain('license-0000-1111');
  });

  it('반영 기능이 없는 공급자 커넥션은 기록만', async () => {
    const g = await conn('cafe24', 'own_mall', 'live');
    await entity('campaign', 'c-1', g, { id: 'c-1', dailyBudget: 100000 });
    const id = await approvedBid({ kind: 'budget', target: '자사몰 일 예산', targetId: 'flow:budget:c-1', before: 100000, after: 105000, changePct: 5 });
    const r = await ae.patch(base(`/${id}`), { patch: { status: 'applied' } });
    expect(r.json.change.execution).toMatchObject({ mode: 'none', ok: true, note: '매체 반영 대상 없음 — 기록만' });
  });
});
