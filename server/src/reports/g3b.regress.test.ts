/**
 * QA 회귀 (G3b · reports) — 실제 PostgreSQL · data 도메인 데모 커넥터 120일 TEST DATA · 가짜 HTTPS 포스터 (실제 네트워크 없음)
 *  - 데이터가 없는 기간(2020-01-01 등)의 리포트는 만들지 않는다 (400 no_data) — 0원을 확정 팩트로 적은 리포트가 보관 · 발송되지 않게
 *  - delivered_at은 실제로 보낸 기록이 있을 때만 — 대기열에 넣기만 하면 비워 두고, 워커가 보낸 뒤 보관함 조회가 채운다
 *  - 서버 SMTP가 없으면 메일 채널은 대기열에 넣지 않고 바로 '보내지 않음'(사유 SMTP_HOST)
 *  - 가치 리포트: 판정 보류면 회수 배수를 계산하지 않음으로 적고, 0원 ≥ 0원 + 0원을 '측정 증분이 대부분'으로 해석하지 않는다
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { _resetJobsForTest, drain, registerJob } from '../jobs/queue';
import { _resetSchedulesForTest, registerSchedule } from '../jobs/scheduler';
import { clearTestOutbox } from '../lib/mailer';
import { setNowForTest } from '../lib/time';
import { encryptConfig } from '../alerts/channels';
import { setAlertDepsForTest } from '../alerts/deps';
import type { HttpPoster } from '../alerts/net';
import { jobs as alertJobs } from '../alerts';
import { registerIngestJobs } from '../ingest/jobs';
import { jobs as impactJobs } from '../impact';
import { jobs as reportJobs } from './index';
import { deliverReport, SMTP_MISSING } from './deliver';
import { periodCoverage } from './generate';

const kst = (date: string, h = 0, m = 0) => Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const TODAY = '2026-11-03';
const HOOK = 'https://hooks.partner.example.com/mildo/g3b-report-hook';

let t: TestApp;
let pm: TestClient, ae: TestClient, admin: TestClient, owner: TestClient;
let turn = 0;
const op = () => [pm, ae, admin, owner][turn++ % 4];
let restoreAlerts: () => void;
const poster: HttpPoster = async () => ({ status: 200, body: 'ok', headers: {} });
const W = (p: string) => `/api/w/${t.ws}${p}`;

beforeAll(async () => {
  setNowForTest(kst(TODAY, 9, 5));
  t = await createTestApp({ demoData: true, config: { appUrl: 'https://os.mildo.test' } });
  _resetJobsForTest();
  _resetSchedulesForTest();
  const reg = { job: registerJob, schedule: registerSchedule };
  registerIngestJobs(reg);
  alertJobs(reg);
  reportJobs(reg);
  impactJobs(reg);
  restoreAlerts = setAlertDepsForTest({ poster });
  await drain(t.db, t.config, { types: ['ingest.backfill'] });
  await t.db.query(`DELETE FROM jobs`);
  [pm, ae, admin, owner] = await Promise.all([t.login('pm'), t.login('ae'), t.login('admin'), t.login('owner')]);
}, 120_000);
afterAll(async () => {
  restoreAlerts?.();
  setNowForTest(null);
  await t?.close();
});
beforeEach(async () => {
  for (const tbl of ['reports', 'notifications', 'notification_channels', 'jobs', 'impact_ledger']) await t.db.query(`DELETE FROM ${tbl}`);
  clearTestOutbox();
  setNowForTest(kst(TODAY, 9, 5));
});

async function addChannel(type: 'email' | 'webhook', name: string, cfg: Record<string, unknown>): Promise<string> {
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO notification_channels (workspace_id, type, name, config_enc, min_severity, events, enabled) VALUES ($1, $2, $3, $4, 'P3', '{report}', true) RETURNING id`,
    [t.ws, type, name, encryptConfig(cfg as never, t.config.encryptionKey)],
  );
  return r.rows[0].id;
}

describe('데이터가 없는 기간의 리포트', () => {
  it('주간 2020-01-01 · 일간 2019-06-03 → 400 no_data, 보관함에 남기지 않는다 (보관 중인 데이터 범위 안내)', async () => {
    const w = await op().post(W('/reports/generate'), { type: 'weekly', periodStart: '2020-01-01' });
    expect(w.status).toBe(400);
    expect(w.json.error.code).toBe('no_data');
    expect(w.json.error.message).toMatch(/2020-01-01 ~ 2020-01-07에 수집된 데이터가 없어/);
    expect(w.json.error.message).toMatch(/보관 중인 데이터 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/);
    const d = await op().post(W('/reports/generate'), { type: 'daily', periodStart: '2019-06-03' });
    expect(d.status).toBe(400);
    expect(d.json.error.code).toBe('no_data');
    expect(Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports`)).rows[0].n)).toBe(0);
    // 데이터가 있는 기간은 그대로 만든다
    expect((await op().post(W('/reports/generate'), { type: 'weekly', periodStart: '2026-10-26' })).status).toBe(201);
  });

  it('periodCoverage: 매체 · 판매 채널 일별 행이 있는 날짜 수', () => {
    const ds = { mediaDaily: [{ date: '2026-10-01' }, { date: '2026-10-02' }], salesDaily: [{ date: '2026-10-02' }, { date: '2026-10-05' }] } as never;
    expect(periodCoverage(ds, '2026-10-01', '2026-10-07')).toBe(3);
    expect(periodCoverage(ds, '2020-01-01', '2020-01-07')).toBe(0);
  });
});

describe('발송 시각 · SMTP 없음', () => {
  it('대기열에 넣기만 한 발송은 delivered_at을 비워 두고, 워커가 보낸 뒤 보관함 조회가 채운다', async () => {
    await addChannel('webhook', '파트너 웹훅', { url: HOOK });
    const rep = (await op().post(W('/reports/generate'), { type: 'daily' })).json.report;
    const d = await op().post(W(`/reports/${rep.id}/deliver`));
    expect(d.status).toBe(200);
    expect(d.json.results.map((x: { status: string }) => x.status)).toEqual(['queued']);
    expect(d.json.report.deliveredAt).toBeNull();
    await drain(t.db, t.config, { types: ['notify.send'] });
    const after = (await pm.get(W(`/reports/${rep.id}`))).json.report;
    expect(after.delivered.map((x: { status: string }) => x.status)).toEqual(['sent']);
    expect(after.status).toBe('delivered');
    expect(typeof after.deliveredAt).toBe('string');
  });

  it('서버 SMTP 미설정(운영 환경): 메일 채널은 대기열에 넣지 않고 바로 보내지 않음 · delivered_at 없음 · 상태 생성됨 · 발송 이력에 사유', async () => {
    const mail = await addChannel('email', 'QA 메일', { recipients: ['qa@brand.kr'] });
    const rep = (await op().post(W('/reports/generate'), { type: 'daily' })).json.report;
    const prod = { ...t.config, env: 'production' as const, smtp: null };
    const out = await deliverReport(t.db, prod, t.ws, rep.id, '테스트 pm');
    expect(out.records).toEqual([expect.objectContaining({ channelId: mail, status: 'skipped', reason: SMTP_MISSING })]);
    expect(out.row.status).toBe('generated');
    expect(out.row.delivered_at).toBeNull();
    expect(Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'notify.send'`)).rows[0].n)).toBe(0);
    const log = (await t.db.query<{ status: string; detail: { reason: string } }>(`SELECT status, detail FROM notifications WHERE ref_id = $1`, [rep.id])).rows;
    expect(log).toEqual([expect.objectContaining({ status: 'skipped', detail: expect.objectContaining({ reason: SMTP_MISSING }) })]);
    // 웹훅이 함께 있으면 웹훅만 대기열에
    const hook = await addChannel('webhook', '웹훅', { url: HOOK });
    const out2 = await deliverReport(t.db, prod, t.ws, rep.id, '테스트 pm');
    const by = Object.fromEntries(out2.records.map((r) => [r.channelId, r.status]));
    expect(by).toEqual({ [mail]: 'skipped', [hook]: 'queued' });
    const jobsFor = (await t.db.query<{ payload: { channelId: string } }>(`SELECT payload FROM jobs WHERE type = 'notify.send'`)).rows.map((j) => j.payload.channelId);
    expect(jobsFor).toEqual([hook]);
  });
});

describe('가치 리포트 — 판정 보류 문구', () => {
  it('측정 · 추정 항목이 없으면 회수 배수 0.0배가 아니라 계산하지 않음, AI 해석은 측정 증분이 대부분이라고 하지 않는다', async () => {
    const r = await op().post(W('/reports/generate'), { type: 'value', month: '2026-10' });
    expect(r.status).toBe(201);
    const md: string = r.json.report.markdown;
    const msg: string = r.json.report.messenger;
    expect(md).toContain('판정 보류');
    expect(md).not.toContain('회수의 대부분이 측정된 증분');
    expect(md).not.toMatch(/회수 배수 0\.0배/);
    expect(md).toContain('**회수 배수 —** (계산하지 않음)');
    expect(md).toContain('= 계산하지 않음 (판정 보류)');
    expect(msg).toMatch(/^\[MILDO 가치\] 2026년 10월 회수 배수 — \(계산하지 않음\) · 판정 보류 · TEST DATA/);
    expect(msg).not.toMatch(/0\.0배/);
  });
});
