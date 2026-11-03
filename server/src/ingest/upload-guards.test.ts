/**
 * CSV 업로드 가드 (QA 회귀):
 *  - 템플릿 예시 행(표시 있음 · 예전 템플릿의 표시 없는 예시 값)은 미리보기에서 경고하고 가져오지 않는다 → 네이버 SA 데모가 예시 1행으로 바뀌지 않는다
 *  - 미리보기(dryRun)가 워커와 같은 검사(음수 지표 · 미래 날짜)를 보여 주고, 쓸 행이 없으면 가져오기를 막는다
 *  - 일부 제외된 업로드의 이력은 실제로 쓴 기간 · 결과(partial)를 남긴다, 모두 제외되면 실패로 남긴다
 *  - CSV 커넥션을 지우면 그 커넥션으로 올린 업로드와 웨어하우스 행(csv:<업로드 id>)도 지운다
 *  - 자격증명 검증 오류는 내부 키가 아니라 화면 라벨 · 스키마 사유로 안내한다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { setNowForTest } from '../lib/time';
import { drainIngest, kst, registerDataJobsForTest } from './testkit';
import { buildDataset } from '../warehouse/dataset';
import { importUpload } from './pipeline';
import { templateCsv } from '@/modules/connections/csv';

const TODAY = '2026-11-03';
let t: TestApp;
beforeAll(async () => {
  setNowForTest(kst(TODAY, 10, 0));
  registerDataJobsForTest();
  t = await createTestApp({ demoData: true });
  await drainIngest(t.db, t.config); // 데모 120일
}, 120_000);
afterAll(async () => {
  setNowForTest(null);
  await t?.close();
});

const clients = new Map<string, Promise<TestClient>>();
const as = (role: 'owner' | 'pm' | 'ae') => {
  if (!clients.has(role)) clients.set(role, t.login(role));
  return clients.get(role)!;
};
const url = () => `/api/w/${t.ws}/uploads`;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

const GOOGLE_ROWS = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']
  .map((d) => `${d},google,90000,1800,3000000,30,12000000,20`);

describe('템플릿 예시 행', () => {
  it('예전 템플릿(표시 없는 예시 값) 아래에 실제 행을 붙여도 예시 행은 경고 · 제외 — 네이버 SA 데모가 그대로 남는다', async () => {
    const before = await buildDataset(t.db, t.ws);
    const saDays = before.mediaDaily.filter((r) => r.media === 'naver_sa').length;
    expect(saDays).toBe(120);
    const legacy = ['﻿일자,매체,노출,클릭,광고비,전환,전환매출,신규 고객', '2026-10-30,naver_sa,120000,2400,1850000,21,22000000,13', ...GOOGLE_ROWS].join('\r\n');
    const ae = await as('ae');
    const dry = await ae.post(url(), { template: 'media_daily', filename: 'legacy.csv', content: legacy, dryRun: true });
    expect(dry.status).toBe(200);
    expect(codes(dry.json.issues)).toContain('template_example_row');
    expect(dry.json.issues.find((i: { code: string }) => i.code === 'template_example_row').message).toContain('2행');
    expect(dry.json.summary).toMatchObject({ rows: 8, validRows: 7, invalidRows: 1, channels: ['google'] });
    expect(dry.json.preview.some((r: { media: string }) => r.media === 'naver_sa')).toBe(false);

    const r = await ae.post(url(), { template: 'media_daily', filename: 'legacy.csv', content: legacy });
    expect(r.status).toBe(200);
    await drainIngest(t.db, t.config);
    const id = r.json.upload.id as string;
    expect((await t.db.query(`SELECT media FROM wh_media_daily WHERE source = $1 GROUP BY media`, [`csv:${id}`])).rows).toEqual([{ media: 'google' }]);
    const after = await buildDataset(t.db, t.ws);
    expect(after.mediaDaily.filter((x) => x.media === 'naver_sa')).toHaveLength(120);
    expect(after.keywords.length).toBe(before.keywords.length);
    expect(after.meta!.sources.find((s) => s.channel === 'naver_sa')!.kind).toBe('demo');
    expect(after.meta!.sources.find((s) => s.channel === 'google')!.kind).toBe('csv');
    expect((await (await as('pm')).del(`${url()}/${id}`)).status).toBe(200);
  });

  it('새 템플릿은 예시 행 일자 칸에 표시가 있고, 그대로 올리면 예시 행만 있어 가져오지 않는다', async () => {
    const csv = templateCsv('media_daily');
    expect(csv).toContain('2026-10-30 (예시 행 — 지우고 쓰세요)');
    const ae = await as('ae');
    const dry = await ae.post(url(), { template: 'media_daily', filename: 'mildo_media_daily.csv', content: csv, dryRun: true });
    expect(codes(dry.json.issues)).toEqual(expect.arrayContaining(['template_example_row', 'no_valid_rows']));
    const r = await ae.post(url(), { template: 'media_daily', filename: 'mildo_media_daily.csv', content: csv });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('예시 행');
    const dl = await ae.get('/api/uploads/templates/media_daily.csv');
    expect(dl.body).toContain('(예시 행 — 지우고 쓰세요)');
  });
});

describe('미리보기 = 워커 검사', () => {
  const BAD = [
    '일자,매체,노출수,클릭수,광고비(원),전환수,전환매출(원)',
    '2026-10-28,구글,"101,111","2,011","-₩3,010,000",11,"₩30,100,000"',
    '2026-10-29,구글,-5,"2,022","3,020,000",-12,"30,200,000"',
    '2026-11-20,구글,100,10,"1,000",1,"10,000"',
  ].join('\n');

  it('음수 지표 · 미래 날짜를 한국어 이슈로 보여 주고 정상 행으로 세지 않으며, 쓸 행이 없으면 가져오기를 막는다', async () => {
    const ae = await as('ae');
    const dry = await ae.post(url(), { template: 'media_daily', filename: '붙여넣기.csv', content: BAD, dryRun: true });
    expect(dry.status).toBe(200);
    expect(codes(dry.json.issues)).toEqual(expect.arrayContaining(['negative_values', 'future_dates', 'no_valid_rows']));
    const neg = dry.json.issues.find((i: { code: string }) => i.code === 'negative_values');
    expect(neg).toMatchObject({ severity: 'error' });
    expect(neg.message).toMatch(/음수 지표가 있는 2행을 제외/);
    expect(neg.message).toContain('-3,010,000');
    expect(dry.json.issues.find((i: { code: string }) => i.code === 'future_dates').message).toContain(`오늘(${TODAY}) 이후 날짜 1행`);
    expect(dry.json.summary).toMatchObject({ rows: 3, validRows: 0, invalidRows: 3, records: 0 });
    expect(dry.json.preview).toEqual([]);
    const before = (await t.db.query('SELECT 1 FROM uploads')).rowCount;
    const r = await ae.post(url(), { template: 'media_daily', filename: '붙여넣기.csv', content: BAD });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_upload');
    expect((await t.db.query('SELECT 1 FROM uploads')).rowCount).toBe(before);
  });

  it('일부만 제외되면 가져오고, 업로드 이력은 실제로 쓴 기간 · 결과 partial · 오류 사유를 남긴다', async () => {
    const mixed = [BAD, '2026-10-30,카카오,1000,20,"50,000",1,"90,000"'].join('\n');
    const ae = await as('ae');
    const dry = await ae.post(url(), { template: 'media_daily', filename: 'mixed.csv', content: mixed, dryRun: true });
    expect(dry.json.summary).toMatchObject({ rows: 4, validRows: 1, invalidRows: 3, dateFrom: '2026-10-30', dateTo: '2026-10-30', channels: ['kakao'] });
    expect(dry.json.preview).toHaveLength(1);
    const r = await ae.post(url(), { template: 'media_daily', filename: 'mixed.csv', content: mixed });
    expect(r.status).toBe(200);
    await drainIngest(t.db, t.config);
    const list = await ae.get(url());
    const up = list.json.uploads.find((u: { id: string }) => u.id === r.json.upload.id);
    expect(up.status).toBe('imported');
    expect(up.summary).toMatchObject({ outcome: 'partial', rowsWritten: 1, dateFrom: '2026-10-30', dateTo: '2026-10-30', issueCounts: { error: 2 } });
    expect(up.summary.issueSummary.join(' ')).toContain('음수 지표');
    const run = (await t.db.query<{ status: string; rows_written: number }>('SELECT status, rows_written FROM ingest_runs WHERE upload_id = $1', [up.id])).rows[0];
    expect(run).toMatchObject({ status: 'partial', rows_written: 1 });
    expect((await (await as('pm')).del(`${url()}/${up.id}`)).status).toBe(200);
  });

  it('검사 전에 들어온 업로드(예전 버전 · 기준일이 바뀐 경우)가 모두 제외되면 0행 가져옴이 아니라 실패 · 사유로 남는다', async () => {
    const ins = await t.db.query<{ id: string }>(
      `INSERT INTO uploads (workspace_id, template, filename, bytes, status, content) VALUES ($1, 'media_daily', 'old.csv', 10, 'received', $2) RETURNING id`,
      [t.ws, BAD],
    );
    const id = ins.rows[0].id;
    const res = await importUpload(t.db, id);
    expect(res.status).toBe('failed');
    const row = (await t.db.query<{ status: string; summary: { error: string } }>('SELECT status, summary FROM uploads WHERE id = $1', [id])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.summary.error).toContain('가져올 수 있는 행이 없습니다');
    await t.db.query('DELETE FROM uploads WHERE id = $1', [id]);
  });
});

describe('CSV 커넥션 삭제', () => {
  it('그 커넥션으로 올린 업로드와 웨어하우스 행을 함께 지우고, 응답 · 감사에 업로드 수를 남긴다', async () => {
    const pm = await as('pm');
    const conn = await pm.post(`/api/w/${t.ws}/connections`, { provider: 'csv', label: 'QA CSV 2', priority: 200 });
    expect(conn.status).toBe(200);
    const connId = conn.json.connection.id as string;
    const csv = ['일자,매체,노출,클릭,광고비,전환,전환매출', '2026-11-01,kakao,1000,20,50000,1,90000', '2026-11-02,kakao,1100,22,52000,1,95000'].join('\n');
    const up = await pm.post(url(), { template: 'media_daily', filename: 'kakao.csv', content: csv, connectionId: connId });
    expect(up.status).toBe(200);
    await drainIngest(t.db, t.config);
    const uploadId = up.json.upload.id as string;
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [`csv:${uploadId}`])).rowCount).toBe(2);
    const mid = await buildDataset(t.db, t.ws);
    expect(mid.meta!.sources.find((s) => s.channel === 'kakao')!.kind).toBe('csv');

    const r = await pm.del(`/api/w/${t.ws}/connections/${connId}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, purgedRows: 2, purgedUploads: 1 });
    expect((await t.db.query('SELECT 1 FROM uploads WHERE id = $1', [uploadId])).rowCount).toBe(0);
    expect((await t.db.query('SELECT 1 FROM wh_media_daily WHERE source = $1', [`csv:${uploadId}`])).rowCount).toBe(0);
    const audit = (await t.db.query<{ detail: { purgedUploads: number; purgedRows: number } }>(`SELECT detail FROM audit_log WHERE action = 'connection.delete' AND target_id = $1`, [connId])).rows[0];
    expect(audit.detail).toMatchObject({ purgedRows: 2, purgedUploads: 1 });
    const after = await buildDataset(t.db, t.ws);
    expect(after.meta!.sources.find((s) => s.channel === 'kakao')!.kind).toBe('demo');
    expect(after.mediaDaily.filter((x) => x.media === 'kakao')).toHaveLength(120);
  });
});

describe('자격증명 검증 문구', () => {
  it('내부 키가 아니라 화면 라벨 · 스키마 사유 (Meta 광고 계정 ID)', async () => {
    const pm = await as('pm');
    const r = await pm.post(`/api/w/${t.ws}/connections`, { provider: 'meta', label: 'Meta', credentials: { accessToken: 'EAAB-fake-token-123456', adAccountId: 'act_123' } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe('자격증명 항목을 확인해 주세요 — 광고 계정 ID: 광고 계정 ID는 숫자입니다 (act_ 접두어는 자동 처리)');
    expect(r.json.error.message).not.toContain('adAccountId');
    expect(r.json.error.detail).toEqual([{ path: 'adAccountId', label: '광고 계정 ID', reason: '광고 계정 ID는 숫자입니다 (act_ 접두어는 자동 처리)' }]);
    expect(r.body).not.toContain('EAAB-fake-token-123456');
    const missing = await pm.post(`/api/w/${t.ws}/connections`, { provider: 'meta', label: 'Meta', credentials: { adAccountId: '1234567' } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.message).toMatch(/시스템 사용자 액세스 토큰: /);
    expect(missing.json.error.message).not.toMatch(/Invalid input|accessToken/);
  });
});
