/**
 * reports 도메인 통합 테스트 (실제 PostgreSQL · data 도메인 데모 커넥터 + 수집 잡으로 120일 TEST DATA 적재 · 가짜 HTTPS 포스터 — 실제 네트워크 없음)
 * 생성(일간 · 주간 · 월간 · 이슈 · 가치) · 코멘트 반영 · 출처 표기 · 보관함 API · 발송(notify.send 잡 · 메일 직접 · 큐 없는 환경) ·
 * 예약(08:00 · 월 10:00 휴무 이동 · 3영업일 · 1일 09:00 · P1 5분) · 중복 방지 · 권한 · 테넌트 격리 · 입력 검증 · 감사 · 이벤트.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { _resetJobsForTest, drain, registerJob, registeredJobTypes } from '../jobs/queue';
import { _resetSchedulesForTest, registerSchedule, registeredSchedules, runScheduleNow, scheduleContext } from '../jobs/scheduler';
import { clearTestOutbox, getTestOutbox } from '../lib/mailer';
import { setNowForTest } from '../lib/time';
import { encryptConfig } from '../alerts/channels';
import { setAlertDepsForTest } from '../alerts/deps';
import type { HttpPoster } from '../alerts/net';
import { jobs as alertJobs } from '../alerts';
import { registerIngestJobs } from '../ingest/jobs';
import { jobs as impactJobs } from '../impact';
import { jobs as reportJobs } from './index';
import { setReportDepsForTest } from './deps';
import { planFor, relabel } from './generate';
import { isMonthlySendDay, isWeeklySendDay, monthlySendDate, upcomingRuns, weeklyPeriodFor, weeklySendDate } from './schedule';

const kst = (date: string, h = 0, m = 0) => Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const TODAY = '2026-11-02'; // 월요일
// 가짜 테스트 주소 — 비밀값 스캐너 오탐을 피하려고 조각으로 조립
const SLACK = ['https://hooks.slack.com', 'services', 'T0AAA1111', 'B0BBB2222', 'reportsecretpath0001'].join('/');
const HOOK = 'https://hooks.partner.example.com/mildo/report-hook-secret-7788';

let t: TestApp;
let pm: TestClient, ae: TestClient, viewer: TestClient, client: TestClient, admin: TestClient, owner: TestClient;
/** 생성 · 발송 API는 사용자당 분당 횟수 제한이 있어 운영 권한 사용자를 돌려 쓴다 */
let turn = 0;
const op = () => [ae, pm, admin, owner][turn++ % 4];
let restoreAlerts: () => void;
const posts: { url: string; body: string }[] = [];
const poster: HttpPoster = async (o) => {
  posts.push({ url: o.url, body: o.body });
  return { status: 200, body: 'ok', headers: {} };
};
const W = (p: string) => `/api/w/${t.ws}${p}`;
const count = async (sql: string, params: unknown[] = []) => Number(Object.values((await t.db.query<Record<string, unknown>>(sql, params)).rows[0])[0]);
const runJobs = (types = ['reports.generate', 'notify.send', 'impact.measure']) => drain(t.db, t.config, { types });

beforeAll(async () => {
  setNowForTest(kst(TODAY, 8, 5));
  t = await createTestApp({ demoData: true, config: { appUrl: 'https://os.mildo.test' } });
  _resetJobsForTest();
  _resetSchedulesForTest();
  const reg = { job: registerJob, schedule: registerSchedule };
  registerIngestJobs(reg);
  alertJobs(reg);
  reportJobs(reg);
  impactJobs(reg);
  restoreAlerts = setAlertDepsForTest({ poster });
  // data 도메인 데모 커넥터 + 백필 잡 (seed가 넣은 ingest.backfill) → wh_* 120일 TEST DATA
  await drain(t.db, t.config, { types: ['ingest.backfill'] });
  await t.db.query(`DELETE FROM jobs`);
  [pm, ae, viewer, client, admin, owner] = await Promise.all([t.login('pm'), t.login('ae'), t.login('viewer'), t.login('client'), t.login('admin'), t.login('owner')]);
}, 120_000);
afterAll(async () => {
  restoreAlerts?.();
  setNowForTest(null);
  await t?.close();
});

async function resetOps() {
  await t.db.query('DELETE FROM reports');
  await t.db.query('DELETE FROM notifications');
  await t.db.query('DELETE FROM notification_channels');
  await t.db.query('DELETE FROM jobs');
  await t.db.query('DELETE FROM incidents');
  await t.db.query('DELETE FROM comments');
  await t.db.query('DELETE FROM audit_log');
  posts.length = 0;
  clearTestOutbox();
  setNowForTest(kst(TODAY, 8, 5));
}

async function addChannel(type: 'slack' | 'email' | 'webhook', name: string, cfg: Record<string, unknown>, events = ['incident', 'report'], enabled = true): Promise<string> {
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO notification_channels (workspace_id, type, name, config_enc, min_severity, events, enabled) VALUES ($1, $2, $3, $4, 'P3', $5, $6) RETURNING id`,
    [t.ws, type, name, encryptConfig(cfg as never, t.config.encryptionKey), events, enabled],
  );
  return r.rows[0].id;
}

async function addIncident(id: string, o: { severity?: 'P1' | 'P2'; isTest?: boolean; detectedAt?: string; title?: string } = {}) {
  const det = o.detectedAt ?? '2026-11-02T07:40:00+09:00';
  const doc = {
    id, ruleId: 'budget_exhaust', severity: o.severity ?? 'P1', title: o.title ?? 'GFA 캠페인 예산 조기 소진', media: 'naver_gfa', target: 'GFA 리타겟팅', detectedAt: det, occurredAt: det,
    detectPath: 'MILDO Alert 서버 감지', causeCandidates: ['일 예산 부족'], impact: { revenueLossEst: 1_200_000, spendAtRisk: 300_000 }, assignee: '담당 AE', status: 'open',
    timeline: [{ at: det, by: 'system', action: '이슈 생성' }], isTest: !!o.isTest, autoActions: ['자동 조정 보류'], source: 'scan',
  };
  await t.db.query(`INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at) VALUES ($1, $2, 'budget_exhaust', $3, 'open', $4, $5)`, [id, t.ws, doc.severity, JSON.stringify(doc), det]);
}

/* ============================== 순수 규칙 ============================== */

describe('발송 일정 규칙 (KST · 영업일)', () => {
  it('주간: 월요일 · 휴무면 다음 영업일, 대상 = 직전 주 월~일', () => {
    expect(weeklySendDate('2026-11-04')).toBe('2026-11-02');
    expect(isWeeklySendDay('2026-11-02')).toBe(true);
    expect(isWeeklySendDay('2026-11-03')).toBe(false);
    // 2026-10-05(월) 대체공휴일 → 10/06(화)
    expect(weeklySendDate('2026-10-05')).toBe('2026-10-06');
    expect(isWeeklySendDay('2026-10-05')).toBe(false);
    expect(isWeeklySendDay('2026-10-06')).toBe(true);
    expect(weeklyPeriodFor('2026-10-06')).toEqual({ start: '2026-09-28', end: '2026-10-04' });
  });
  it('월간: 3영업일 · 일정 미리보기', () => {
    expect(monthlySendDate('2026-11')).toBe('2026-11-04');
    expect(monthlySendDate('2026-10')).toBe('2026-10-06'); // 10/1 · 10/2 · (10/5 휴무) · 10/6
    expect(isMonthlySendDay('2026-11-04')).toBe(true);
    const runs = upcomingRuns('2026-11-02', 9, 0);
    expect(runs.find((r) => r.type === 'daily')!.at).toBe('2026-11-03T08:00:00+09:00');
    expect(runs.find((r) => r.type === 'weekly')!.at).toBe('2026-11-02T10:00:00+09:00');
    expect(runs.find((r) => r.type === 'monthly')).toMatchObject({ at: '2026-11-04T10:00:00+09:00', covers: '2026-10' });
    expect(runs.find((r) => r.type === 'value')).toMatchObject({ at: '2026-12-01T09:00:00+09:00', covers: '2026-11' });
  });
  it('기간 계산: 일간 = 전일, 주간 = 지정 주, 월간 = 마감 월 전체, 미래는 당긴다', () => {
    const now = { today: TODAY, hour: 9 };
    expect(planFor({ type: 'daily', dedupe: true }, now)).toMatchObject({ today: TODAY, periodStart: '2026-11-01', dedupeKey: 'daily:2026-11-01' });
    expect(planFor({ type: 'daily', periodStart: '2026-12-01' }, now)).toMatchObject({ periodStart: '2026-11-01', dedupeKey: null });
    expect(planFor({ type: 'weekly', periodStart: '2026-10-26', dedupe: true }, now)).toMatchObject({ today: TODAY, periodStart: '2026-10-26', periodEnd: '2026-11-01', dedupeKey: 'weekly:2026-10-26' });
    expect(planFor({ type: 'monthly', month: '2026-10' }, now)).toMatchObject({ today: '2026-11-01', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(planFor({ type: 'value' }, now)).toMatchObject({ month: '2026-10' });
    expect(planFor({ type: 'issue', incidentId: 'i1', dedupe: true }, now).dedupeKey).toBe('issue:i1');
  });
  it('출처 표기: 연동 데이터면 TEST DATA 문구를 LIVE로, 혼합이면 일부 TEST DATA', () => {
    const md = '> 데이터: TEST DATA (시연용 테스트 데이터 · 실제 성과 아님) · 제안서 기준값은 장표 번호 병기\n[MILDO 일간] 11/1(일) 성과 · TEST DATA\nROAS 420% (TEST DATA).';
    const live = relabel(md, 'live', '2026-11-02T08:00:00+09:00');
    expect(live).not.toContain('TEST DATA');
    expect(live).toContain('LIVE DATA (연동 출처 · 데이터 기준 2026-11-02T08:00:00+09:00)');
    expect(live).toContain('ROAS 420%.');
    const mixed = relabel(md, 'mixed');
    expect(mixed).toContain('일부 TEST DATA 포함');
    expect(mixed).not.toContain('일부 일부');
    expect(relabel(md, 'demo')).toBe(md);
  });
});

/* ============================== 생성 ============================== */

describe('POST /reports/generate — 종류별 생성 (데모 커넥터 TEST DATA)', () => {
  beforeEach(resetOps);

  it('일간: 전일 성과 · 마크다운 · 메신저 · TEST DATA 표기 · 감사 · 이벤트', async () => {
    const events: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => events.push(`${e.type}:${e.id}`));
    const r = await ae.post(W('/reports/generate'), { type: 'daily' });
    expect(r.status).toBe(201);
    const rep = r.json.report;
    expect(rep).toMatchObject({ type: 'daily', periodStart: '2026-11-01', periodEnd: '2026-11-01', trigger: 'manual', status: 'generated', dataMode: 'demo' });
    expect(rep.title).toContain('일간 리포트');
    expect(rep.markdown).toMatch(/^# 일간 리포트/);
    expect(rep.markdown).toContain('TEST DATA');
    expect(rep.markdown).toContain('## 확정 팩트');
    expect(rep.markdown).toContain('규칙 엔진 해석');
    expect(rep.messenger).toContain('[MILDO 일간]');
    expect(rep.doc.sections.length).toBeGreaterThan(2);
    expect(rep.markdown).not.toMatch(/NaN|undefined/);
    const a = await t.db.query(`SELECT action, actor, target_id FROM audit_log WHERE action = 'report.generate'`);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ actor: '테스트 ae', target_id: rep.id });
    for (let i = 0; i < 20 && !events.length; i++) await new Promise((res) => setTimeout(res, 50));
    off();
    expect(events).toContain(`report:${rep.id}`);
  });

  it('주간 · 월간 · 가치 리포트 기간과 영역', async () => {
    const w = await op().post(W('/reports/generate'), { type: 'weekly', periodStart: '2026-10-26' });
    expect(w.status).toBe(201);
    expect(w.json.report).toMatchObject({ type: 'weekly', periodStart: '2026-10-26', periodEnd: '2026-11-01' });
    expect(w.json.report.markdown).toContain('주간 리포트');
    const m = await op().post(W('/reports/generate'), { type: 'monthly', month: '2026-10' });
    expect(m.status).toBe(201);
    expect(m.json.report).toMatchObject({ type: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31', scope: 'monthly-2026-10' });
    expect(m.json.report.markdown).toContain('월간 리포트');
    const v = await op().post(W('/reports/generate'), { type: 'value', month: '2026-10' });
    expect(v.status).toBe(201);
    expect(v.json.report).toMatchObject({ type: 'value', periodStart: '2026-10-01', periodEnd: '2026-10-31', dataMode: 'demo' });
    for (const h of ['### 확정 팩트', '### 반복 관측 패턴', '### AI 해석', '### 전제 조건 · 기준값', '### 반례 · 대체 시나리오']) expect(v.json.report.markdown).toContain(h);
    expect(v.json.report.markdown).toContain('회수 배수');
    expect(v.json.report.markdown).toContain('TEST DATA');
  });

  it('이슈: 지정 이슈 리포트 · 없는 이슈는 404', async () => {
    await addIncident('inc-p1-a', { title: 'GFA 캠페인 예산 조기 소진' });
    const r = await op().post(W('/reports/generate'), { type: 'issue', incidentId: 'inc-p1-a' });
    expect(r.status).toBe(201);
    expect(r.json.report).toMatchObject({ type: 'issue', refId: 'inc-p1-a', scope: 'issue-inc-p1-a' });
    expect(r.json.report.title).toContain('GFA 캠페인 예산 조기 소진');
    expect(r.json.report.messenger).toContain('[MILDO 이슈 · P1]');
    expect((await op().post(W('/reports/generate'), { type: 'issue', incidentId: 'nope-123' })).status).toBe(404);
  });

  it('AE 해석 · 섹션 피드백(광고주 담당자) 코멘트가 본문에 붙는다', async () => {
    const first = await op().post(W('/reports/generate'), { type: 'daily' });
    const sec = first.json.report.doc.sections[0];
    await t.db.query(
      `INSERT INTO comments (id, workspace_id, target, author, author_role, text) VALUES ('c-ae', $1, 'reports:daily:ae', '테스트 ae', 'ae', 'GFA 충전 요청 완료 · 17시 재확인'),
                                                                                   ('c-cl', $1, $2, '광고주 김', 'client', 'GFA는 신규 CPA 기준으로 봐 주세요')`,
      [t.ws, `reports:daily:${sec.id}`],
    );
    const r = await op().post(W('/reports/generate'), { type: 'daily' });
    expect(r.json.report.markdown).toContain('## 담당 AE 해석 · 다음 액션');
    expect(r.json.report.markdown).toContain('GFA 충전 요청 완료');
    expect(r.json.report.markdown).toContain(`[${sec.title}] GFA는 신규 CPA 기준으로 봐 주세요 — 광고주 김 (광고주 담당자) · 반영 대기`);
    expect(r.json.report.aeComment).toContain('GFA 충전 요청 완료');
  });

  it('입력 검증 · 권한 (viewer · client는 생성 불가, 읽기는 가능)', async () => {
    expect((await op().post(W('/reports/generate'), { type: 'yearly' })).status).toBe(400);
    expect((await op().post(W('/reports/generate'), { type: 'daily', periodStart: '2026/11/01' })).status).toBe(400);
    expect((await op().post(W('/reports/generate'), { type: 'monthly', month: '2026-13' })).status).toBe(400);
    expect((await viewer.post(W('/reports/generate'), { type: 'daily' })).status).toBe(403);
    expect((await client.post(W('/reports/generate'), { type: 'daily' })).status).toBe(403);
    expect((await t.anon().get(W('/reports'))).status).toBe(401);
    expect((await viewer.get(W('/reports'))).status).toBe(200);
  });
});

/* ============================== 보관함 ============================== */

describe('GET /reports · /reports/:id — 보관함 · 격리', () => {
  beforeAll(resetOps);

  it('목록(최신순 · 종류 필터 · 페이지) · 단건(본문) · 일정', async () => {
    for (let i = 0; i < 3; i++) {
      setNowForTest(kst(TODAY, 8, 10 + i));
      await op().post(W('/reports/generate'), { type: 'daily' });
    }
    setNowForTest(kst(TODAY, 8, 20));
    await op().post(W('/reports/generate'), { type: 'weekly' });
    const all = await viewer.get(W('/reports?limit=2'));
    expect(all.status).toBe(200);
    expect(all.json.reports).toHaveLength(2);
    expect(all.json.reports[0].type).toBe('weekly');
    expect(all.json.reports[0].markdown).toBeUndefined();
    expect(all.json.reports[0].excerpt).toContain('[MILDO 주간]');
    expect(all.json.nextBefore).toBeTruthy();
    const page2 = await viewer.get(W(`/reports?limit=2&before=${encodeURIComponent(all.json.nextBefore)}`));
    expect(page2.json.reports).toHaveLength(2);
    expect(new Set([...all.json.reports, ...page2.json.reports].map((r: { id: string }) => r.id)).size).toBe(4);
    const daily = await viewer.get(W('/reports?type=daily'));
    expect(daily.json.reports).toHaveLength(3);
    expect((await viewer.get(W('/reports?type=yearly'))).status).toBe(400);
    const one = await viewer.get(W(`/reports/${daily.json.reports[0].id}`));
    expect(one.status).toBe(200);
    expect(one.json.report.markdown).toContain('# 일간 리포트');
    expect((await viewer.get(W('/reports/not-a-uuid'))).status).toBe(404);
    expect((await viewer.get(W('/reports/00000000-0000-0000-0000-000000000000'))).status).toBe(404);
    const sch = await viewer.get(W('/reports/schedule'));
    expect(sch.status).toBe(200);
    expect(sch.json.schedule.map((s: { type: string }) => s.type)).toEqual(['daily', 'weekly', 'monthly', 'value', 'issue']);
  });

  it('다른 워크스페이스: 멤버가 아니면 404, 멤버여도 다른 워크스페이스 리포트 id는 404', async () => {
    const other = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-rep', '다른 브랜드', '다른') RETURNING id`, [t.orgId])).rows[0].id;
    const id = (await viewer.get(W('/reports?limit=1'))).json.reports[0].id;
    expect((await pm.get(`/api/w/${other}/reports`)).status).toBe(404);
    expect((await pm.post(`/api/w/${other}/reports/generate`, { type: 'daily' })).status).toBe(404);
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'pm')`, [other, t.userIds.pm]);
    expect((await pm.get(`/api/w/${other}/reports`)).json.reports).toEqual([]);
    expect((await pm.get(`/api/w/${other}/reports/${id}`)).status).toBe(404);
    expect((await pm.post(`/api/w/${other}/reports/${id}/deliver`)).status).toBe(404);
  });
});

/* ============================== 발송 ============================== */

describe('POST /reports/:id/deliver — 채널 발송 · 기록', () => {
  beforeEach(resetOps);

  it("'리포트 발송' 이벤트를 켠 채널만: Slack · 웹훅은 notify.send 잡, 메일은 마크다운 전문 직접 발송 → 결과 반영", async () => {
    const slack = await addChannel('slack', '운영 Slack', { webhookUrl: SLACK });
    const mail = await addChannel('email', '광고주 메일', { recipients: ['brand@client.test'] });
    const hook = await addChannel('webhook', '사내 웹훅', { url: HOOK });
    await addChannel('slack', '이슈 전용', { webhookUrl: SLACK }, ['incident']);
    await addChannel('email', '꺼진 채널', { recipients: ['off@client.test'] }, ['report'], false);
    const gen = await op().post(W('/reports/generate'), { type: 'daily' });
    const id = gen.json.report.id;
    const r = await op().post(W(`/reports/${id}/deliver`));
    expect(r.status).toBe(200);
    const byCh = Object.fromEntries(r.json.results.map((x: { channelId: string }) => [x.channelId, x]));
    expect(Object.keys(byCh).sort()).toEqual([slack, mail, hook].sort());
    expect(byCh[slack]).toMatchObject({ via: 'notify.send', status: 'queued', channelType: 'slack' });
    expect(byCh[hook]).toMatchObject({ via: 'notify.send', status: 'queued' });
    expect(byCh[mail]).toMatchObject({ via: 'direct', status: 'sent' });
    expect(r.json.report.status).toBe('delivered');
    // 비밀값(웹훅 경로 · 수신자 전체 주소)은 응답에 없다
    expect(r.body).not.toContain('reportsecretpath0001');
    expect(r.body).not.toContain('report-hook-secret-7788');
    expect(r.body).not.toContain('brand@client.test');
    // 메일 = 마크다운 전문 + 보관함 링크
    const out = getTestOutbox();
    expect(out).toHaveLength(1);
    expect(out[0].to).toEqual(['brand@client.test']);
    expect(out[0].subject).toContain('일간 리포트');
    expect(out[0].text).toContain(gen.json.report.markdown.slice(0, 200));
    expect(out[0].text).toContain('https://os.mildo.test/#impact');
    // notify.send 잡 계약
    const jobs = (await t.db.query<{ payload: { channelId: string; event: string; refId: string; payload: { title: string; text: string; link: string } } }>(`SELECT payload FROM jobs WHERE type = 'notify.send'`)).rows;
    expect(jobs).toHaveLength(2);
    for (const j of jobs) expect(j.payload).toMatchObject({ event: 'report', refId: id, payload: { link: 'https://os.mildo.test/#impact' } });
    expect(jobs[0].payload.payload.text).toContain('[MILDO 일간]');
    expect(jobs[0].payload.payload.title).toContain('[TEST DATA]');
    await runJobs(['notify.send']);
    expect(posts.map((p) => p.url).sort()).toEqual([HOOK, SLACK].sort());
    expect(JSON.parse(posts.find((p) => p.url === HOOK)!.body)).toMatchObject({ event: 'report' });
    const after = await viewer.get(W(`/reports/${id}`));
    const st = Object.fromEntries(after.json.report.delivered.map((x: { channelId: string; status: string }) => [x.channelId, x.status]));
    expect(st).toEqual({ [slack]: 'sent', [mail]: 'sent', [hook]: 'sent' });
    expect(await count(`SELECT count(*) FROM notifications WHERE event = 'report' AND ref_id = $1 AND status = 'sent'`, [id])).toBe(3);
    const a = await t.db.query<{ detail: { results: { status: string }[] } }>(`SELECT detail FROM audit_log WHERE action = 'report.deliver'`);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].detail.results).toHaveLength(3);
    expect(JSON.stringify(a.rows[0].detail)).not.toContain('reportsecretpath0001');
  });

  it('같은 리포트를 대기 중에 다시 보내면 중복 잡을 만들지 않는다 · 큐가 없으면 바로 발송', async () => {
    const slack = await addChannel('slack', '운영 Slack', { webhookUrl: SLACK }, ['report']);
    const id = (await op().post(W('/reports/generate'), { type: 'daily' })).json.report.id;
    await op().post(W(`/reports/${id}/deliver`));
    const again = await op().post(W(`/reports/${id}/deliver`));
    expect(again.json.results[0]).toMatchObject({ channelId: slack, status: 'skipped' });
    expect(again.json.report.status).toBe('delivered');
    expect(await count(`SELECT count(*) FROM jobs WHERE type = 'notify.send'`)).toBe(1);
    const sent: string[] = [];
    const restore = setReportDepsForTest({ queueAvailable: () => false, directSender: async (_c, type, _cfg, msg) => { sent.push(`${type}:${msg.subject}`); return { status: 'sent', httpStatus: 200 }; } });
    try {
      const d = await op().post(W(`/reports/${id}/deliver`));
      expect(d.json.results[0]).toMatchObject({ via: 'direct', status: 'sent' });
      expect(sent[0]).toMatch(/^slack:\[MILDO OS\] 일간 리포트/);
      expect(await count(`SELECT count(*) FROM notifications WHERE event = 'report' AND channel_id = $1`, [slack])).toBe(1);
    } finally {
      restore();
    }
  });

  it('채널이 없으면 건너뜀 기록 · 권한: viewer · client 발송 불가', async () => {
    const id = (await op().post(W('/reports/generate'), { type: 'daily' })).json.report.id;
    const r = await op().post(W(`/reports/${id}/deliver`));
    expect(r.json.results).toEqual([expect.objectContaining({ status: 'skipped', via: 'none' })]);
    expect(r.json.report.status).toBe('generated');
    expect((await viewer.post(W(`/reports/${id}/deliver`))).status).toBe(403);
    expect((await client.post(W(`/reports/${id}/deliver`))).status).toBe(403);
    expect((await op().post(W('/reports/00000000-0000-0000-0000-000000000000/deliver'))).status).toBe(404);
  });

  it('생성과 함께 발송 (deliver: true)', async () => {
    await addChannel('email', '광고주 메일', { recipients: ['brand@client.test'] }, ['report']);
    const r = await op().post(W('/reports/generate'), { type: 'weekly', deliver: true });
    expect(r.status).toBe(201);
    expect(r.json.report.status).toBe('delivered');
    expect(getTestOutbox()).toHaveLength(1);
  });
});

/* ============================== 예약 · 잡 ============================== */

describe('예약 생성 · 자동 발송 (reports.generate 잡)', () => {
  beforeEach(resetOps);
  const ctx = () => scheduleContext(t.db, t.config);
  const queued = async (type = 'reports.generate') => (await t.db.query<{ payload: Record<string, unknown>; dedupe_key: string }>(`SELECT payload, dedupe_key FROM jobs WHERE type = $1 AND status = 'queued' AND workspace_id = $2 ORDER BY id`, [type, t.ws])).rows;

  it('잡 · 스케줄 등록 (spec §6 잡 이름)', () => {
    expect(registeredJobTypes()).toEqual(expect.arrayContaining(['reports.generate', 'impact.measure', 'notify.send']));
    const s = Object.fromEntries(registeredSchedules().map((x) => [x.name, x.cron]));
    expect(s).toMatchObject({
      'reports.daily': '0 8 * * *', 'reports.weekly': '0 10 * * *', 'reports.monthly': '0 10 * * *', 'reports.value': '0 9 1 * *', 'reports.issue': '*/5 * * * *', 'impact.measure': '0 6 * * *',
    });
  });

  it('일간 08:00: 워크스페이스마다 전일 리포트 한 건 · 자동 발송 · 다시 돌려도 중복 없음', async () => {
    await addChannel('email', '광고주 메일', { recipients: ['brand@client.test'] }, ['report']);
    setNowForTest(kst(TODAY, 8, 0));
    await runScheduleNow('reports.daily', ctx());
    await runScheduleNow('reports.daily', ctx());
    const q = await queued();
    expect(q).toHaveLength(1);
    expect(q[0].payload).toMatchObject({ type: 'daily', periodStart: '2026-11-01', trigger: 'schedule' });
    await runJobs();
    const rows = (await t.db.query<{ trigger: string; dedupe_key: string; status: string }>(`SELECT trigger, dedupe_key, status FROM reports WHERE workspace_id = $1`, [t.ws])).rows;
    expect(rows).toEqual([{ trigger: 'schedule', dedupe_key: 'daily:2026-11-01', status: 'delivered' }]);
    expect(getTestOutbox()).toHaveLength(1);
    // 잡이 끝난 뒤 다시 예약 → 잡은 다시 생기지만 리포트 · 발송은 한 번
    await runScheduleNow('reports.daily', ctx());
    await runJobs();
    expect(await count(`SELECT count(*) FROM reports WHERE workspace_id = $1`, [t.ws])).toBe(1);
    expect(getTestOutbox()).toHaveLength(1);
    expect(await count(`SELECT count(*) FROM audit_log WHERE action = 'report.generate' AND actor = 'system' AND workspace_id = $1`, [t.ws])).toBe(1);
  });

  it('주간 10:00: 월요일 발송 · 화요일은 없음 · 월요일 공휴일이면 화요일로 이동', async () => {
    setNowForTest(kst('2026-11-02', 10, 0));
    await runScheduleNow('reports.weekly', ctx());
    expect((await queued()).map((j) => j.payload)).toEqual([expect.objectContaining({ type: 'weekly', periodStart: '2026-10-26' })]);
    await t.db.query('DELETE FROM jobs');
    setNowForTest(kst('2026-11-03', 10, 0));
    await runScheduleNow('reports.weekly', ctx());
    expect(await queued()).toHaveLength(0);
    setNowForTest(kst('2026-10-05', 10, 0));
    await runScheduleNow('reports.weekly', ctx());
    expect(await queued()).toHaveLength(0);
    setNowForTest(kst('2026-10-06', 10, 0));
    await runScheduleNow('reports.weekly', ctx());
    expect((await queued()).map((j) => j.payload)).toEqual([expect.objectContaining({ type: 'weekly', periodStart: '2026-09-28' })]);
    await runJobs(['reports.generate']);
    const r = (await t.db.query<{ period_start: string; period_end: string }>(`SELECT period_start, period_end FROM reports WHERE type = 'weekly' AND workspace_id = $1`, [t.ws])).rows;
    expect(r).toEqual([{ period_start: '2026-09-28', period_end: '2026-10-04' }]);
  });

  it('월간 3영업일 10:00 · 가치 리포트 1일 09:00 (지난달)', async () => {
    setNowForTest(kst('2026-11-03', 10, 0));
    await runScheduleNow('reports.monthly', ctx());
    expect(await queued()).toHaveLength(0);
    setNowForTest(kst('2026-11-04', 10, 0));
    await runScheduleNow('reports.monthly', ctx());
    expect((await queued()).map((j) => j.payload)).toEqual([expect.objectContaining({ type: 'monthly', month: '2026-10' })]);
    await t.db.query('DELETE FROM jobs');
    setNowForTest(kst('2026-11-01', 9, 0));
    await runScheduleNow('reports.value', ctx());
    expect((await queued()).map((j) => j.payload)).toEqual([expect.objectContaining({ type: 'value', month: '2026-10' })]);
    await runJobs(['reports.generate']);
    expect(await count(`SELECT count(*) FROM reports WHERE type = 'value' AND dedupe_key = 'value:2026-10' AND trigger = 'schedule' AND workspace_id = $1`, [t.ws])).toBe(1);
  });

  it('이슈: P1 감지 → 5분 확인에서 이슈 리포트 한 건 · 테스트 · P2 이슈는 대상 아님 · 중복 없음', async () => {
    setNowForTest(kst(TODAY, 8, 0));
    await addIncident('inc-live-1');
    await addIncident('inc-test-1', { isTest: true });
    await addIncident('inc-p2-1', { severity: 'P2' });
    await runScheduleNow('reports.issue', ctx());
    await runScheduleNow('reports.issue', ctx());
    expect((await queued()).map((j) => j.payload)).toEqual([expect.objectContaining({ type: 'issue', incidentId: 'inc-live-1', trigger: 'incident' })]);
    await runJobs();
    const r = (await t.db.query<{ ref_id: string; trigger: string; title: string }>(`SELECT ref_id, trigger, title FROM reports WHERE type = 'issue'`)).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ref_id: 'inc-live-1', trigger: 'incident' });
    await runScheduleNow('reports.issue', ctx());
    expect(await queued()).toHaveLength(0);
  });

  it('잡 입력이 잘못되면 실패로 끝난다 (재시도 없이 사유 기록)', async () => {
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload, max_attempts) VALUES ('reports.generate', $1, '{"type":"yearly"}', 1)`, [t.ws]);
    await runJobs(['reports.generate']);
    const j = (await t.db.query<{ status: string; last_error: string }>(`SELECT status, last_error FROM jobs WHERE type = 'reports.generate'`)).rows[0];
    expect(j.status).toBe('failed');
    expect(j.last_error).toContain('입력값');
  });
});
