/**
 * CSV 업로드 API: 미리보기(dryRun, 저장 없음) · 가져오기(ingest.upload 잡) · 템플릿 다운로드(UTF-8 BOM) · 크기 제한 ·
 * 역할별 허용/거부 · 테넌트 격리 · 감사 · 업로드 삭제 시 데이터 정리 · 키워드 CSV → 엔티티 · Dataset 반영.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { dateRange, setNowForTest } from '../lib/time';
import { drainIngest, kst, registerDataJobsForTest } from './testkit';
import { buildDataset } from '../warehouse/dataset';

const TODAY = '2026-11-02';
let t: TestApp;
beforeAll(async () => {
  setNowForTest(kst(TODAY, 10, 0));
  registerDataJobsForTest();
  t = await createTestApp();
});
afterAll(async () => {
  setNowForTest(null);
  await t?.close();
});

const clients = new Map<string, Promise<TestClient>>();
const as = (role: 'owner' | 'pm' | 'ae' | 'client' | 'viewer') => {
  if (!clients.has(role)) clients.set(role, t.login(role));
  return clients.get(role)!;
};
const url = () => `/api/w/${t.ws}/uploads`;

const MEDIA_CSV = [
  '﻿일자,매체,캠페인,노출수,클릭수,총비용(VAT포함),전환수,전환매출액',
  '2026.10.29,네이버 검색광고,SA_브랜드,"12,000",480,"396,000",8,"8,720,000"',
  '2026.10.29,네이버 검색광고,SA_일반,30000,600,"510,000",5,"5,400,000"',
  '2026.10.30,메타,넓은 타겟,90000,990,"520,000",2,2100000',
  '2026.10.30,메타,넓은 타겟,abc,10,100,0,0',
].join('\r\n');

describe('미리보기 (dryRun)', () => {
  it('operate(ae 이상)만, 저장 없이 정규화 앞 20행 · 열 매핑 · 이슈 · 요약', async () => {
    for (const role of ['viewer', 'client'] as const) {
      expect((await (await as(role)).post(url(), { template: 'media_daily', filename: 'a.csv', content: MEDIA_CSV, dryRun: true })).status, role).toBe(403);
    }
    const ae = await as('ae');
    const r = await ae.post(url(), { template: 'media_daily', filename: 'sa.csv', content: MEDIA_CSV, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json.upload).toBeNull();
    expect(r.json.preview).toHaveLength(3);
    expect(r.json.preview[0]).toMatchObject({ date: '2026-10-29', media: 'naver_sa', impressions: 12000, cost: 396000, _line: 2 });
    expect(r.json.columns.mapping).toMatchObject({ date: '일자', media: '매체', cost: '총비용(VAT포함)', revenue: '전환매출액' });
    expect(r.json.columns.unmapped).toEqual(['캠페인']);
    expect(r.json.summary).toMatchObject({ rows: 4, invalidRows: 1, records: 2, dateFrom: '2026-10-29', dateTo: '2026-10-30' });
    expect(r.json.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['invalid_rows', 'duplicate_keys']));
    expect((await t.db.query('SELECT 1 FROM uploads')).rowCount).toBe(0);
  });

  it('사용자 열 매핑 · 고정 매체 · 입력 검증(템플릿 · 크기 · 빈 파일)', async () => {
    const ae = await as('ae');
    const csv = '기간,소진\n2026-10-30,"1,000"';
    const r = await ae.post(url(), { template: 'media_daily', filename: 'k.csv', content: csv, mapping: { cost: '소진' }, channel: 'kakao', dryRun: true });
    expect(r.json.preview[0]).toMatchObject({ date: '2026-10-30', media: 'kakao', cost: 1000 });
    expect((await ae.post(url(), { template: 'entities', filename: 'x.csv', content: csv })).status).toBe(400);
    expect((await ae.post(url(), { template: 'media_daily', filename: 'x.csv', content: '  ' })).status).toBe(400);
    const big = await ae.post(url(), { template: 'media_daily', filename: 'big.csv', content: 'a'.repeat(20 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
  });
});

describe('가져오기', () => {
  it('저장 + ingest.upload 예약 → 워커가 가져오면 imported · 웨어하우스(csv:<id>) · ingest_runs · 감사 · 원본 비움', async () => {
    const ae = await as('ae');
    const r = await ae.post(url(), { template: 'media_daily', filename: 'sa.csv', content: MEDIA_CSV });
    expect(r.status).toBe(200);
    const up = r.json.upload;
    expect(up).toMatchObject({ template: 'media_daily', filename: 'sa.csv', status: 'received' });
    expect(r.json.jobId).toBeTypeOf('number');
    await drainIngest(t.db, t.config);
    const row = (await t.db.query<{ status: string; content: string | null; summary: { rowsWritten: number } }>('SELECT status, content, summary FROM uploads WHERE id = $1', [up.id])).rows[0];
    expect(row.status).toBe('imported');
    expect(row.content).toBeNull();
    expect(row.summary.rowsWritten).toBe(2);
    const wh = (await t.db.query<{ media: string; cost: number }>('SELECT media, cost FROM wh_media_daily WHERE source = $1 ORDER BY media', [`csv:${up.id}`])).rows;
    expect(wh).toEqual([{ media: 'meta', cost: 520000 }, { media: 'naver_sa', cost: 906000 }]);
    const run = (await t.db.query<{ job: string; status: string; rows_in: number; rows_written: number; issues: { code: string }[]; range_from: string }>('SELECT job, status, rows_in, rows_written, issues, range_from FROM ingest_runs WHERE upload_id = $1', [up.id])).rows[0];
    expect(run).toMatchObject({ job: 'upload', status: 'partial', rows_in: 4, rows_written: 2, range_from: '2026-10-29' });
    expect(run.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['invalid_rows', 'duplicate_keys']));
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'upload.create' AND target_id = $1`, [up.id])).rowCount).toBe(1);
    expect((await t.db.query(`SELECT 1 FROM jobs WHERE type = 'alerts.scan' AND dedupe_key = $1`, [`alerts.scan:${t.ws}`])).rowCount).toBe(1);
    const list = await (await as('viewer')).get(url());
    expect(list.json.uploads[0]).toMatchObject({ id: up.id, status: 'imported' });
    expect(list.body).not.toContain('SA_일반'); // 원본 내용은 목록에 없다
    const ds = await buildDataset(t.db, t.ws);
    expect(ds.mediaDaily.find((x) => x.media === 'naver_sa' && x.date === '2026-10-29')!.cost).toBe(906000);
    expect(ds.meta!.sources.find((s) => s.channel === 'naver_sa')).toMatchObject({ kind: 'csv', source: `csv:${up.id}`, latestDate: '2026-10-29' });
    expect(ds.meta!.mode).toBe('live');
  });

  it('필수 열이 없으면 400 invalid_upload (이슈 · 미리보기 포함), 저장하지 않는다', async () => {
    const before = (await t.db.query('SELECT 1 FROM uploads')).rowCount;
    const r = await (await as('ae')).post(url(), { template: 'sales_daily', filename: 's.csv', content: '일자,채널\n2026-10-30,쿠팡' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_upload');
    expect(r.json.error.detail.issues[0].code).toBe('missing_columns');
    expect((await t.db.query('SELECT 1 FROM uploads')).rowCount).toBe(before);
  });

  it('키워드 일별 CSV: 새 키워드 엔티티(의도 추정 · 입찰가 추정) → Dataset 키워드 last14 반영', async () => {
    const lines = ['일자,키워드,광고그룹,노출수,클릭수,총비용,전환수,전환매출액'];
    for (const d of dateRange('2026-10-19', '2026-11-01')) lines.push(`${d},퀸 매트리스 추천,G_비교,1000,20,"24,000",1,"1,000,000"`);
    const r = await (await as('pm')).post(url(), { template: 'keyword_daily', filename: 'kw.csv', content: lines.join('\n') });
    expect(r.status).toBe(200);
    await drainIngest(t.db, t.config);
    const ds = await buildDataset(t.db, t.ws);
    const kw = ds.keywords.find((k) => k.text === '퀸 매트리스 추천')!;
    expect(kw).toMatchObject({ intent: 'compare', adgroup: 'G_비교', bid: 1200, maxBid: 1920, status: 'on' });
    expect(kw.id).toMatch(/^csv:[0-9a-f]{12}$/);
    expect(kw.daily).toHaveLength(14);
    expect(kw.last14).toEqual({ impressions: 14000, clicks: 280, cost: 336000, conversions: 14, revenue: 14000000 });
  });

  it('업로드 삭제: configure만, 그 업로드의 웨어하우스 행 정리 · 감사, 다른 워크스페이스 업로드는 404', async () => {
    const up = (await t.db.query<{ id: string }>(`SELECT id FROM uploads WHERE filename = 'sa.csv'`)).rows[0].id;
    expect((await (await as('ae')).del(`${url()}/${up}`)).status).toBe(403);
    const r = await (await as('pm')).del(`${url()}/${up}`);
    expect(r.status).toBe(200);
    expect(r.json.purgedRows).toBe(2);
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [`csv:${up}`])).rowCount).toBe(0);
    expect((await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'upload.delete' AND target_id = $1`, [up])).rowCount).toBe(1);
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-up', '다른', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    const foreign = (await t.db.query<{ id: string }>(`INSERT INTO uploads (workspace_id, template, filename, bytes) VALUES ($1, 'media_daily', 'x.csv', 1) RETURNING id`, [other])).rows[0].id;
    const owner = await as('owner');
    expect((await owner.del(`${url()}/${foreign}`)).status).toBe(404);
    expect((await owner.get(`/api/w/${other}/uploads`)).status).toBe(404);
    expect((await owner.post(`/api/w/${other}/uploads`, { template: 'media_daily', filename: 'a.csv', content: MEDIA_CSV, dryRun: true })).status).toBe(404);
    const foreignConn = (await t.db.query<{ id: string }>(`INSERT INTO connections (workspace_id, provider, kind, label) VALUES ($1, 'csv', 'other', '남의 CSV') RETURNING id`, [other])).rows[0].id;
    expect((await owner.post(url(), { template: 'media_daily', filename: 'a.csv', content: MEDIA_CSV, connectionId: foreignConn })).status).toBe(404);
  });
});

describe('템플릿', () => {
  it('목록 · CSV 다운로드(UTF-8 BOM · 첨부), 없는 템플릿 404, 미로그인 401', async () => {
    const viewer = await as('viewer');
    const list = await viewer.get('/api/uploads/templates');
    expect(list.json.templates.map((x: { id: string }) => x.id)).toEqual(['media_daily', 'media_hourly', 'sales_daily', 'keyword_daily', 'search_term_daily']);
    const r = await viewer.get('/api/uploads/templates/media_daily.csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="mildo_media_daily.csv"');
    expect(r.body.charCodeAt(0)).toBe(0xfeff);
    expect(r.body).toContain('일자,매체,노출,클릭,광고비,전환,전환매출,신규 고객');
    expect((await viewer.get('/api/uploads/templates/entities.csv')).status).toBe(404);
    expect((await viewer.get('/api/uploads/templates/media_daily.xlsx')).status).toBe(404);
    expect((await t.anon().get('/api/uploads/templates/media_daily.csv')).status).toBe(401);
  });
});
