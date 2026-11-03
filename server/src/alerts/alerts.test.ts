/**
 * alerts 도메인 통합 테스트 (실제 PostgreSQL · 가짜 Dataset 빌더 · 가짜 HTTPS 포스터 — 실제 네트워크 없음)
 * 감지 잡(중복 방지 · 운영자 처리 보존 · stillDetected) · 이슈 API(권한 · 격리 · 검증 · 감사 · 이벤트) · SLA 에스컬레이션(단계당 1회) ·
 * 알림 채널(SSRF · 마스킹 · 테스트 발송) · notify.send(Slack · 메일 · 웹훅 서명 · 재시도 · 필터) · 발송 이력 · 스케줄.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import type { ChangeRequest } from '@/core/types';
import { detectBulkChange, onDutyFor, regimeOf } from '@/modules/alert/engine';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { registerJob, drain, _resetJobsForTest } from '../jobs/queue';
import { registerSchedule, runScheduleNow, scheduleContext, _resetSchedulesForTest } from '../jobs/scheduler';
import { clearTestOutbox, getTestOutbox } from '../lib/mailer';
import { setNowForTest } from '../lib/time';
import { jobs } from './index';
import { scanWorkspace } from './scan';
import { setAlertDepsForTest } from './deps';
import type { HttpPoster, PostResult } from './net';

// 가짜 테스트 주소 — 비밀값 스캐너 오탐을 피하려고 조각으로 조립
const SLACK = ['https://hooks.slack.com', 'services', 'T0AAA1111', 'B0BBB2222', 'abcdefghijklmnopqrstuvwx'].join('/');
const HOOK = 'https://hooks.partner.example.com/mildo/secret-path-7788';
const HOOK_SECRET = 'whsec_0123456789abcdef';
const enc = encodeURIComponent;

/** 실연동 데이터로 표시한 데모 Dataset (기본 픽스처) — meta가 없거나 demo면 서버는 감지 이슈를 TEST DATA(isTest)로 둔다 */
const LIVE: Dataset = { ...DEMO, meta: { mode: 'live', builtAt: DEMO.generatedAt, sources: [] } };

let t: TestApp;
let restore: () => void;
let dataset: Dataset | (() => Dataset) = LIVE;
const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
let respond: (url: string) => PostResult = () => ({ status: 200, body: 'ok', headers: {} });
const poster: HttpPoster = async (o) => {
  posts.push({ url: o.url, body: o.body, headers: o.headers });
  return respond(o.url);
};
const ALERT_JOBS = ['alerts.scan', 'alerts.sla', 'notify.send'];
const run = () => drain(t.db, t.config, { types: ALERT_JOBS });

let pm: TestClient, ae: TestClient, viewer: TestClient, client: TestClient, admin: TestClient;
let otherWs: string;

beforeAll(async () => {
  t = await createTestApp({ config: { appUrl: 'https://os.mildo.test' } });
  _resetJobsForTest();
  _resetSchedulesForTest();
  jobs({ job: registerJob, schedule: registerSchedule });
  restore = setAlertDepsForTest({
    buildDataset: async () => (typeof dataset === 'function' ? dataset() : dataset),
    poster,
  });
  [pm, ae, viewer, client, admin] = await Promise.all([t.login('pm'), t.login('ae'), t.login('viewer'), t.login('client'), t.login('admin')]);
  otherWs = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-brand', '다른 브랜드', '다른') RETURNING id`, [t.orgId])).rows[0].id;
});
afterAll(async () => {
  restore?.();
  setNowForTest(null);
  await t?.close();
});

async function reset() {
  await t.db.query('DELETE FROM incidents');
  await t.db.query('DELETE FROM notifications');
  await t.db.query('DELETE FROM notification_channels');
  await t.db.query('DELETE FROM jobs');
  await t.db.query('DELETE FROM alert_scan_runs');
  await t.db.query('DELETE FROM audit_log');
  posts.length = 0;
  clearTestOutbox();
  respond = () => ({ status: 200, body: 'ok', headers: {} });
  dataset = LIVE;
  setNowForTest(null);
  await t.db.query(`UPDATE workspaces SET config = '{}'::jsonb WHERE id = $1`, [t.ws]);
}
const W = (p: string) => `/api/w/${t.ws}${p}`;
/** 준비용 감지 (HTTP 수동 감지는 사용자당 분당 12회 제한이 있어 준비 단계는 직접 호출) */
const scan = () => scanWorkspace(t.db, t.ws, { trigger: 'manual' });
const count = async (sql: string, params: unknown[] = []) => Number((await t.db.query<{ n: number }>(sql, params)).rows[0].n);

/* ============================== 감지 잡 ============================== */

describe('alerts.scan — 서버 24시간 감지', () => {
  beforeEach(reset);

  it('감지 잡을 두 번 돌려도 이슈는 한 번만 생긴다 (결정적 id) · 실행 기록 · 감사 · 이벤트', async () => {
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => got.push(`${e.type}:${e.id ?? ''}`));
    // data 도메인 계약: 수집 성공 후 payload { reason: 'ingest' }로 enqueue
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('alerts.scan', $1, '{"reason":"ingest","connectionId":null}')`, [t.ws]);
    await run();
    const n1 = await count('SELECT count(*)::int AS n FROM incidents WHERE workspace_id = $1', [t.ws]);
    expect(n1).toBe(10);
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('alerts.scan', $1, '{"trigger":"schedule"}')`, [t.ws]);
    await run();
    expect(await count('SELECT count(*)::int AS n FROM incidents WHERE workspace_id = $1', [t.ws])).toBe(10);
    const jobsRes = (await t.db.query<{ result: { found: number; created: number } }>(`SELECT result FROM jobs WHERE type = 'alerts.scan' ORDER BY id`)).rows;
    expect(jobsRes.map((j) => [j.result.found, j.result.created])).toEqual([[10, 10], [10, 0]]);
    const runs = (await t.db.query<{ trigger: string; status: string; created: number }>(`SELECT trigger, status, created FROM alert_scan_runs ORDER BY id`)).rows;
    expect(runs).toEqual([{ trigger: 'ingest', status: 'ok', created: 10 }, { trigger: 'schedule', status: 'ok', created: 0 }]);
    // 열 · 문서 동기화, 서버 필드
    const row = (await t.db.query<{ status: string; severity: string; rule_id: string; doc: Record<string, unknown> }>(
      `SELECT status, severity, rule_id, doc FROM incidents WHERE id = 'tracking_break:카카오:2026-10-31'`)).rows[0];
    expect(row).toMatchObject({ status: 'open', severity: 'P1', rule_id: 'tracking_break' });
    expect(row.doc).toMatchObject({ source: 'scan', dataDate: '2026-10-31', stillDetected: true, status: 'open', isTest: false, dataMode: 'live' });
    expect(typeof row.doc.notifiedAt).toBe('string');
    // 영향 추정 금액은 원 단위 정수로 저장
    const impacts = (await t.db.query<{ doc: { impact: Record<string, number> } }>(`SELECT doc FROM incidents WHERE workspace_id = $1`, [t.ws])).rows.flatMap((r) => Object.values(r.doc.impact ?? {}));
    expect(impacts.length).toBeGreaterThan(5);
    expect(impacts.every((v) => Number.isInteger(v))).toBe(true);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'incident.scan'`)).toBe(1);
    for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    off();
    expect(got.some((g) => g.startsWith('incident:'))).toBe(true);
  });

  it('재감지해도 운영자가 바꾼 상태 · 담당 · 메모 · 타임라인은 그대로', async () => {
    await pm.post(W('/alerts/scan'));
    const id = 'tracking_break:카카오:2026-10-31';
    const p = await ae.patch(W(`/incidents/${enc(id)}`), { patch: { status: 'action', assignee: 'DA AE', actionNote: '픽셀 재설치 요청' }, action: '1차 조치 · 픽셀 재설치 요청' });
    expect(p.status).toBe(200);
    const before = p.json.incident;
    const r = await pm.post(W('/alerts/scan'));
    expect(r.json).toMatchObject({ found: 10, created: 0 });
    const after = (await viewer.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(after.status).toBe('action');
    expect(after.assignee).toBe('DA AE');
    expect(after.actionNote).toBe('픽셀 재설치 요청');
    expect(after.timeline).toEqual(before.timeline);
    expect(after.sla).toEqual(before.sla);
  });

  it('같은 날 열린 감지 이슈가 더 이상 안 잡히면 stillDetected=false + 타임라인 한 번 (자동 해결 안 함), 다시 잡히면 true', async () => {
    await pm.post(W('/alerts/scan'));
    // 탐지 결과에서 카카오 전환 추적 단절만 빠지도록: 시간별 데이터에서 카카오 오늘 행 제거 → 다른 규칙으로도 안 잡히게 tracking id만 확인
    const id = 'tracking_break:카카오:2026-10-31';
    const withoutKakaoToday: Dataset = { ...LIVE, mediaHourly: DEMO.mediaHourly.map((h) => (h.media === 'kakao' && h.date === DEMO.today ? { ...h, conversions: h.conversions + 1, revenue: h.revenue + 1000 } : h)) };
    dataset = withoutKakaoToday;
    const r1 = await pm.post(W('/alerts/scan'));
    expect(r1.json.cleared).toBeGreaterThanOrEqual(1);
    const inc1 = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(inc1.status).toBe('open');
    expect(inc1.stillDetected).toBe(false);
    const notes = (x: { timeline: { action: string }[] }) => x.timeline.filter((e) => e.action.includes('더 이상 잡히지 않음')).length;
    expect(notes(inc1)).toBe(1);
    await pm.post(W('/alerts/scan'));
    const inc2 = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(notes(inc2)).toBe(1);
    dataset = LIVE;
    const r3 = await pm.post(W('/alerts/scan'));
    expect(r3.json.redetected).toBeGreaterThanOrEqual(1);
    const inc3 = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(inc3.stillDetected).toBe(true);
    expect(inc3.timeline.at(-1).action).toContain('다시 감지됨');
  });

  it('데이터가 없으면 오류 없이 끝내고 경고를 남긴다 (빌더 예외 · 빈 Dataset)', async () => {
    dataset = () => { throw new Error('buildDataset: data 도메인 구현 예정'); };
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.scan', $1)`, [t.ws]);
    await run();
    const j = (await t.db.query<{ status: string; result: { warning: string; found: number } }>(`SELECT status, result FROM jobs WHERE type = 'alerts.scan'`)).rows[0];
    expect(j.status).toBe('done');
    expect(j.result.found).toBe(0);
    expect(j.result.warning).toContain('데이터를 불러오지 못해');
    dataset = { ...DEMO, mediaHourly: [], mediaDaily: [], salesDaily: [] };
    const r = await pm.post(W('/alerts/scan'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ found: 0, created: 0 });
    expect(r.json.warning).toContain('비어 있어');
    const runs = (await viewer.get(W('/alerts/runs'))).json.runs;
    expect(runs.map((x: { status: string }) => x.status)).toEqual(['warning', 'warning']);
  });

  it('탐지 중 예외: 감지 기록에 failed로 남기고 잡은 재시도, 이슈 · 알림 잡은 반쯤 남지 않는다', async () => {
    await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['incident'] });
    dataset = { ...LIVE, mediaHourly: null as unknown as Dataset['mediaHourly'] };
    await t.db.query(`INSERT INTO jobs (type, workspace_id, payload) VALUES ('alerts.scan', $1, '{"trigger":"schedule"}')`, [t.ws]);
    await run();
    const j = (await t.db.query<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM jobs WHERE type = 'alerts.scan'`)).rows[0];
    expect(j.status).toBe('queued'); // 재시도 대기
    expect(j.last_error).toBeTruthy();
    const runs = (await viewer.get(W('/alerts/runs'))).json.runs;
    expect(runs[0]).toMatchObject({ status: 'failed', trigger: 'schedule' });
    expect(runs[0].warning).toContain('감지 실패');
    expect(await count('SELECT count(*)::int AS n FROM incidents WHERE workspace_id = $1', [t.ws])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM jobs WHERE type = 'notify.send'`)).toBe(0);
  });

  it('실데이터(meta.mode live)에서는 데모 소재 목록을 쓰지 않는다', async () => {
    dataset = { ...DEMO, meta: { mode: 'live', builtAt: DEMO.generatedAt, sources: [] } };
    const r = await pm.post(W('/alerts/scan'));
    expect(r.status).toBe(200);
    const ids: string[] = (await pm.get(W('/incidents'))).json.incidents.map((i: { id: string }) => i.id);
    expect(ids.some((i) => i.startsWith('creative_'))).toBe(false);
  });

  it('수동 감지 권한: ae 이상 operate, client · viewer 403, 다른 워크스페이스 404', async () => {
    expect((await viewer.post(W('/alerts/scan'))).status).toBe(403);
    expect((await client.post(W('/alerts/scan'))).status).toBe(403);
    expect((await ae.post(W('/alerts/scan'))).status).toBe(200);
    expect((await pm.post(`/api/w/${otherWs}/alerts/scan`)).status).toBe(404);
    expect((await t.anon().post(W('/alerts/scan'))).status).toBe(401);
  });
});

/* ============================== 이슈 API ============================== */

describe('이슈 API', () => {
  beforeEach(reset);
  const holdId = 'adpilot_hold:매트리스 추천:2026-10-31';
  const hold = {
    id: holdId, ruleId: 'data_spike', severity: 'P2', title: 'AD Pilot 자동 조정 보류 · 매트리스 추천', media: 'naver_sa', target: '매트리스 추천',
    detectedAt: new Date().toISOString(), occurredAt: DEMO.generatedAt, detectPath: 'AD Pilot 이상 보류 규칙 (p.14)', causeCandidates: ['경쟁 입찰 — CPC 상승'],
    impact: { spendAtRisk: 120000 }, status: 'open', timeline: [{ at: new Date().toISOString(), by: 'AD Pilot', action: '감지 · 자동 조정 보류' }], isTest: false, autoActions: ['AD Pilot 자동 조정 보류'],
  };

  it('POST: 클라이언트 생성 이슈 저장 · id 중복이면 기존 그대로 · 감사 · 권한 · 검증', async () => {
    const r = await ae.post(W('/incidents'), { incident: hold });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    expect(r.json.incident).toMatchObject({ id: holdId, source: 'client', status: 'open', severity: 'P2' });
    expect(r.json.incident.createdBy).toContain('테스트 ae');
    const dup = await pm.post(W('/incidents'), { incident: { ...hold, title: '덮어쓰기 시도', severity: 'P1' } });
    expect(dup.status).toBe(200);
    expect(dup.json.created).toBe(false);
    expect(dup.json.incident.title).toBe(hold.title);
    expect(dup.json.incident.severity).toBe('P2');
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'incident.create' AND target_id = $1`, [holdId])).toBe(1);
    expect((await client.post(W('/incidents'), { incident: { ...hold, id: 'x:1' } })).status).toBe(403);
    expect((await viewer.post(W('/incidents'), { incident: { ...hold, id: 'x:2' } })).status).toBe(403);
    const bad = await ae.post(W('/incidents'), { incident: { ...hold, id: 'bad\nid', severity: 'P9' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('bad_request');
    expect((await ae.post(W('/incidents'), { incident: { id: 'only-id' } })).status).toBe(400);
  });

  it('GET: 열린 이슈(등급순) 먼저, 해결 이슈는 뒤, 읽기 권한 · 다른 워크스페이스 404', async () => {
    await scan();
    await ae.patch(W(`/incidents/${enc('brand_intrusion:브랜드 키워드:2026-10-31')}`), { patch: { status: 'resolved' }, action: '해결' });
    const list = (await viewer.get(W('/incidents'))).json.incidents as { id: string; status: string; severity: string }[];
    expect(list).toHaveLength(10);
    expect(list.at(-1)!.status).toBe('resolved');
    const open = list.filter((i) => i.status !== 'resolved');
    expect(open.map((i) => i.severity)).toEqual([...open.map((i) => i.severity)].sort());
    expect((await client.get(W('/incidents'))).status).toBe(200);
    expect((await pm.get(`/api/w/${otherWs}/incidents`)).status).toBe(404);
  });

  it('PATCH: 상태 흐름 · 서버 시각 SLA · 타임라인 · 되돌림 409 · 재오픈 · resolved_at 동기화', async () => {
    await ae.post(W('/incidents'), { incident: hold });
    const url = W(`/incidents/${enc(holdId)}`);
    const a = await ae.patch(url, { patch: { status: 'ack', sla: { ackAt: '2020-01-01T00:00:00+09:00' } }, action: '인지' });
    expect(a.status).toBe(200);
    expect(a.json.incident.status).toBe('ack');
    expect(a.json.incident.sla.ackAt).not.toBe('2020-01-01T00:00:00+09:00');
    expect(Math.abs(Date.parse(a.json.incident.sla.ackAt) - Date.now())).toBeLessThan(60_000);
    expect(a.json.incident.timeline.at(-1)).toMatchObject({ by: '테스트 ae (담당 AE)', action: '인지' });
    const back = await ae.patch(url, { patch: { status: 'open' }, action: '되돌리기' });
    expect(back.status).toBe(409);
    expect(back.json.error.code).toBe('conflict');
    const res = await pm.patch(url, { patch: { status: 'resolved', preventNote: '보류 기준 재검토' }, action: '해결' });
    expect(res.json.incident.status).toBe('resolved');
    expect((await t.db.query(`SELECT resolved_at FROM incidents WHERE id = $1`, [holdId])).rows[0].resolved_at).not.toBeNull();
    const re = await pm.patch(url, { patch: {}, action: 'reopen' });
    expect(re.status).toBe(200);
    expect(re.json.incident.status).toBe('open');
    const row = (await t.db.query<{ resolved_at: Date | null; status: string; doc: { status: string } }>(`SELECT resolved_at, status, doc FROM incidents WHERE id = $1`, [holdId])).rows[0];
    expect(row.resolved_at).toBeNull();
    expect(row.status).toBe('open');
    expect(row.doc.status).toBe('open');
    const actions = (await t.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id`, [holdId])).rows.map((r) => r.action);
    expect(actions).toEqual(['incident.create', 'incident.update', 'incident.update', 'incident.reopen']);
  });

  it('PATCH 권한 · 격리 · 검증: viewer · client 403, 없는 id 404, 다른 워크스페이스 이슈 404, 알 수 없는 필드는 무시', async () => {
    await ae.post(W('/incidents'), { incident: hold });
    await t.db.query(
      `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc) VALUES ('secret:other:1', $1, 'x', 'P1', 'open', '{"id":"secret:other:1","title":"다른 브랜드 이슈"}')`,
      [otherWs],
    );
    const url = W(`/incidents/${enc(holdId)}`);
    expect((await viewer.patch(url, { patch: { status: 'ack' } })).status).toBe(403);
    expect((await client.patch(url, { patch: { status: 'ack' } })).status).toBe(403);
    expect((await ae.patch(W('/incidents/nope:1'), { patch: { status: 'ack' } })).status).toBe(404);
    expect((await ae.patch(W(`/incidents/${enc('secret:other:1')}`), { patch: { status: 'ack' } })).status).toBe(404);
    expect((await ae.patch(`/api/w/${otherWs}/incidents/${enc('secret:other:1')}`, { patch: { status: 'ack' } })).status).toBe(404);
    expect((await ae.patch(url, { patch: { status: 'done' } })).status).toBe(400);
    const r = await ae.patch(url, { patch: { title: '바꿔치기', severity: 'P3', escalations: { ack: {} } }, action: '정보' });
    expect(r.status).toBe(200);
    expect(r.json.incident.title).toBe(hold.title);
    expect(r.json.incident.severity).toBe('P2');
    expect(r.json.incident.escalations).toBeUndefined();
  });

  it('이슈 id에 한글 · 공백 · 슬래시가 있어도 경로로 처리된다', async () => {
    const id = 'budget_forecast:SA/브랜드 캠페인:2026-10-31';
    expect((await ae.post(W('/incidents'), { incident: { ...hold, id } })).status).toBe(201);
    const r = await ae.patch(W(`/incidents/${enc(id)}`), { patch: { status: 'ack' }, action: '인지' });
    expect(r.status).toBe(200);
    expect(r.json.incident.id).toBe(id);
  });
});

/* ============================== 알림 채널 ============================== */

describe('알림 채널 API', () => {
  beforeEach(reset);

  it('생성 · 목록: 설정은 암호화 저장, 응답 · 감사 기록은 마스킹', async () => {
    const r = await pm.post(W('/notify/channels'), { type: 'slack', name: '#mildo-ops', config: { webhookUrl: SLACK }, minSeverity: 'P2', events: ['incident', 'sla'] });
    expect(r.status).toBe(201);
    expect(r.body).not.toContain('abcdefghijklmnop');
    expect(r.json.channel).toMatchObject({ type: 'slack', name: '#mildo-ops', minSeverity: 'P2', events: ['incident', 'sla'], enabled: true });
    expect(r.json.channel.config.webhookUrl).toMatch(/^https:\/\/hooks\.slack\.com\/••••/);
    const raw = (await t.db.query<{ config_enc: string }>('SELECT config_enc FROM notification_channels')).rows[0].config_enc;
    expect(raw).toMatch(/^v1:/);
    expect(raw).not.toContain('hooks.slack.com');
    const list = await viewer.get(W('/notify/channels'));
    expect(list.status).toBe(200);
    expect(list.json.channels).toHaveLength(1);
    expect(list.body).not.toContain('abcdefghijklmnop');
    const auditRows = (await t.db.query<{ detail: unknown }>(`SELECT detail FROM audit_log WHERE action = 'notify.channel.create'`)).rows;
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows[0].detail)).not.toContain('abcdefghijklmnop');
  });

  it('SSRF · 형식 검증: http · 루프백 · 메타데이터 주소 · 가짜 Slack 도메인은 400', async () => {
    for (const url of ['http://127.0.0.1/hook', 'http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254/latest', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'http://hooks.example.com/x', 'https://10.0.0.8/x']) {
      const r = await pm.post(W('/notify/channels'), { type: 'webhook', name: 'hook', config: { url } });
      expect(r.status, url).toBe(400);
    }
    expect((await pm.post(W('/notify/channels'), { type: 'slack', name: 's', config: { webhookUrl: 'https://hooks.slack.com.attacker.io/services/a/b/c' } })).status).toBe(400);
    expect((await pm.post(W('/notify/channels'), { type: 'email', name: 'm', config: { recipients: ['nope'] } })).status).toBe(400);
    expect((await pm.post(W('/notify/channels'), { type: 'sms', name: 'm', config: {} })).status).toBe(400);
    expect((await pm.post(W('/notify/channels'), { type: 'slack', name: 's', config: { webhookUrl: SLACK }, events: ['everything'] })).status).toBe(400);
    expect(await count('SELECT count(*)::int AS n FROM notification_channels')).toBe(0);
  });

  it('권한: configure(pm · admin · owner)만 변경, ae · client · viewer 403, 다른 워크스페이스 404', async () => {
    const body = { type: 'email', name: '운영 메일', config: { recipients: ['ops@mildo.kr'] } };
    expect((await ae.post(W('/notify/channels'), body)).status).toBe(403);
    expect((await client.post(W('/notify/channels'), body)).status).toBe(403);
    expect((await viewer.post(W('/notify/channels'), body)).status).toBe(403);
    const c = await admin.post(W('/notify/channels'), body);
    expect(c.status).toBe(201);
    const id = c.json.channel.id;
    expect((await ae.patch(W(`/notify/channels/${id}`), { enabled: false })).status).toBe(403);
    expect((await ae.del(W(`/notify/channels/${id}`))).status).toBe(403);
    expect((await ae.post(W(`/notify/channels/${id}/test`))).status).toBe(403);
    expect((await pm.get(`/api/w/${otherWs}/notify/channels`)).status).toBe(404);
    expect((await pm.patch(`/api/w/${otherWs}/notify/channels/${id}`, { enabled: false })).status).toBe(404);
    // 다른 워크스페이스의 채널 id를 내 워크스페이스 경로로 → 404
    const foreign = (await t.db.query<{ id: string }>(`INSERT INTO notification_channels (workspace_id, type, name, config_enc) VALUES ($1, 'email', 'x', 'v1:a:b:c') RETURNING id`, [otherWs])).rows[0].id;
    expect((await pm.patch(W(`/notify/channels/${foreign}`), { enabled: false })).status).toBe(404);
    expect((await pm.del(W(`/notify/channels/${foreign}`))).status).toBe(404);
    expect((await pm.post(W(`/notify/channels/${foreign}/test`))).status).toBe(404);
  });

  it('수정: 빈 값은 기존 유지 · 비밀값 추가/삭제 · 등급/이벤트/켜기 · 감사 · 삭제', async () => {
    const c = await pm.post(W('/notify/channels'), { type: 'webhook', name: '파트너 웹훅', config: { url: HOOK } });
    const id = c.json.channel.id;
    expect(c.json.channel.config.hasSecret).toBe(false);
    const p1 = await pm.patch(W(`/notify/channels/${id}`), { config: { url: '', secret: HOOK_SECRET }, minSeverity: 'P1', events: ['incident', 'resolved'], enabled: false });
    expect(p1.status).toBe(200);
    expect(p1.json.channel).toMatchObject({ minSeverity: 'P1', events: ['incident', 'resolved'], enabled: false });
    expect(p1.json.channel.config.hasSecret).toBe(true);
    expect(p1.body).not.toContain(HOOK_SECRET);
    expect(p1.body).not.toContain('secret-path');
    expect((await pm.patch(W(`/notify/channels/${id}`), { config: { url: 'https://192.168.1.1/x' } })).status).toBe(400);
    const p2 = await pm.patch(W(`/notify/channels/${id}`), { config: { secret: null } });
    expect(p2.json.channel.config.hasSecret).toBe(false);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'notify.channel.update'`)).toBe(2);
    const d = await pm.del(W(`/notify/channels/${id}`));
    expect(d.json).toEqual({ ok: true });
    expect((await pm.get(W('/notify/channels'))).json.channels).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'notify.channel.delete'`)).toBe(1);
  });

  it('테스트 발송: Slack 실제 형식(가짜 포스터) · 결과 기록 · 실패 사유 표시', async () => {
    const c = await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK } });
    const id = c.json.channel.id;
    const r = await pm.post(W(`/notify/channels/${id}/test`));
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ ok: true, status: 'sent', httpStatus: 200 });
    expect(r.json.channel.lastStatus).toBe('sent');
    expect(r.json.channel.lastTestAt).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(SLACK);
    const payload = JSON.parse(posts[0].body);
    expect(typeof payload.text).toBe('string');
    expect(payload.blocks[0]).toMatchObject({ type: 'header', text: { type: 'plain_text', text: 'MILDO OS 알림 채널 연결 확인' } });
    // 예시 이슈로 보내기
    await scan();
    respond = () => ({ status: 404, body: 'no_service', headers: {} });
    const r2 = await pm.post(W(`/notify/channels/${id}/test`), { sample: true });
    expect(r2.json.result).toMatchObject({ ok: false, status: 'failed', httpStatus: 404 });
    expect(r2.json.result.reason).toContain('no_service');
    expect(r2.json.channel.lastError).toContain('no_service');
    const sample = JSON.parse(posts[1].body);
    expect(sample.blocks[0].text.text).toContain('[연결 확인 · 예시]');
    const log = await viewer.get(W('/notify/log?event=channel_test'));
    expect(log.json.entries.map((e: { status: string }) => e.status)).toEqual(['failed', 'sent']);
    expect(log.body).not.toContain('abcdefghijklmnop');
  });
});

/* ============================== 발송 (notify.send) ============================== */

describe('notify.send — 채널별 발송 · 필터 · 재시도 · 이력', () => {
  beforeEach(reset);

  async function setupChannels() {
    const slack = (await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK }, minSeverity: 'P1', events: ['incident', 'sla'] })).json.channel;
    const mail = (await pm.post(W('/notify/channels'), { type: 'email', name: '운영 메일', config: { recipients: ['ops@mildo.kr', 'pm@mildo.kr'] }, minSeverity: 'P2', events: ['incident'] })).json.channel;
    const hook = (await pm.post(W('/notify/channels'), { type: 'webhook', name: '파트너', config: { url: HOOK, secret: HOOK_SECRET }, minSeverity: 'P3', events: ['incident', 'resolved'] })).json.channel;
    const off = (await pm.post(W('/notify/channels'), { type: 'webhook', name: '꺼진 채널', config: { url: HOOK }, enabled: false })).json.channel;
    return { slack, mail, hook, off };
  }

  it('새 이슈 → 등급 · 이벤트에 맞는 채널만 발송, Slack Block Kit · 메일 제목 · 웹훅 서명 · 이력', async () => {
    const ch = await setupChannels();
    await scan();
    // P1 2건 → Slack(P1만) 2, 메일(P2 이상) 10, 웹훅(P3 이상) 10
    const queued = (await t.db.query<{ payload: { channelId: string } }>(`SELECT payload FROM jobs WHERE type = 'notify.send'`)).rows;
    const by = (id: string) => queued.filter((q) => q.payload.channelId === id).length;
    expect([by(ch.slack.id), by(ch.mail.id), by(ch.hook.id), by(ch.off.id)]).toEqual([2, 10, 10, 0]);
    // 등급 기준 밖 Slack 8건은 skipped 기록
    expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE status = 'skipped' AND channel_id = $1`, [ch.slack.id])).toBe(8);
    await run();
    const slackPosts = posts.filter((p) => p.url === SLACK);
    expect(slackPosts).toHaveLength(2);
    const sp = JSON.parse(slackPosts[0].body);
    expect(sp.text).toMatch(/^\[P1\] /);
    const blocks = sp.blocks as { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { url?: string }[] }[];
    // 실데이터 이슈(테스트 · 에스컬레이션 · 미감지 안내 없음): header · 요약 fields · 근거 · 원인 · 영향/SLA fields · 다음 조치 · context · 버튼
    expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'section', 'section', 'section', 'context', 'actions']);
    expect(blocks[0].text!.text).toMatch(/^\[P1\] /);
    expect(blocks[1].fields!.map((f) => f.text.split('\n')[0])).toEqual(['*등급*', '*상태*', '*기준*', '*관측 · 변화*', '*대상*', '*판정 기준*']);
    expect(blocks[3].text!.text).toContain('*원인 후보 상위 2*');
    expect(blocks[4].fields![0].text).toContain('영향 (추정)');
    expect(blocks[4].fields![1].text).toContain('SLA 기한');
    expect(blocks.at(-1)!.elements![0].url).toBe('https://os.mildo.test/#alert');
    // 메일
    const mails = getTestOutbox();
    expect(mails).toHaveLength(10);
    expect(mails.filter((m) => m.subject.startsWith('[MILDO OS] P1 '))).toHaveLength(2);
    expect(mails[0].to).toEqual(['ops@mildo.kr', 'pm@mildo.kr']);
    expect(mails[0].text).toContain('https://os.mildo.test/#alert');
    // 웹훅 서명 검증
    const hp = posts.filter((p) => p.url === HOOK);
    expect(hp).toHaveLength(10);
    const h0 = hp[0];
    const expected = `sha256=${createHmac('sha256', HOOK_SECRET).update(`${h0.headers['x-mildo-timestamp']}.${h0.body}`).digest('hex')}`;
    expect(h0.headers['x-mildo-signature']).toBe(expected);
    const wj = JSON.parse(h0.body);
    expect(wj).toMatchObject({ event: 'incident', workspace: { id: t.ws, slug: 'mildo' }, incident: { url: 'https://os.mildo.test/#alert' } });
    expect(Object.keys(wj)).toEqual(expect.arrayContaining(['event', 'workspace', 'incident']));
    // 이력
    expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE status = 'sent'`)).toBe(22);
    const log = await viewer.get(W('/notify/log?status=sent&limit=5'));
    expect(log.json.entries).toHaveLength(5);
    expect(log.json.nextBefore).toBeTypeOf('number');
    expect(log.body).not.toContain(HOOK_SECRET);
    expect(log.body).not.toContain('secret-path');
    const ch2 = (await pm.get(W('/notify/channels'))).json.channels.find((c: { id: string }) => c.id === ch.slack.id);
    expect(ch2.lastStatus).toBe('sent');
    expect(ch2.lastSentAt).toBeTruthy();
  });

  it('재시도: 5xx는 재시도(같은 이력 줄 갱신), 4xx는 바로 실패 · 재시도 없음', async () => {
    const slack = (await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK }, minSeverity: 'P1', events: ['incident'] })).json.channel;
    await scan();
    respond = () => ({ status: 503, body: 'service unavailable', headers: {} });
    await run();
    const rows = (await t.db.query<{ status: string; attempts: number; detail: { retrying: boolean; httpStatus: number } }>(`SELECT status, attempts, detail FROM notifications WHERE channel_id = $1 AND status <> 'skipped'`, [slack.id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'failed' && r.detail.retrying && r.detail.httpStatus === 503)).toBe(true);
    const jobsQueued = (await t.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE type = 'notify.send'`)).rows;
    expect(jobsQueued.every((j) => j.status === 'queued' && j.attempts === 1)).toBe(true);
    // 다음 시도에서 성공 → 같은 줄이 sent로
    respond = () => ({ status: 200, body: 'ok', headers: {} });
    await t.db.query(`UPDATE jobs SET run_at = now() WHERE type = 'notify.send'`);
    await run();
    const after = (await t.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM notifications WHERE channel_id = $1 AND status <> 'skipped'`, [slack.id])).rows;
    expect(after).toHaveLength(2);
    expect(after.every((r) => r.status === 'sent' && r.attempts === 2)).toBe(true);
    // 4xx(삭제된 웹훅)는 재시도하지 않는다
    await t.db.query('DELETE FROM incidents');
    await t.db.query('DELETE FROM notifications');
    await t.db.query('DELETE FROM jobs');
    respond = () => ({ status: 404, body: 'no_service', headers: {} });
    await scan();
    await run();
    const j = (await t.db.query<{ status: string }>(`SELECT status FROM jobs WHERE type = 'notify.send'`)).rows;
    expect(j.every((x) => x.status === 'done')).toBe(true);
    const n = (await t.db.query<{ status: string; detail: { reason: string; retrying: boolean } }>(`SELECT status, detail FROM notifications WHERE channel_id = $1 AND status <> 'skipped'`, [slack.id])).rows;
    expect(n.every((x) => x.status === 'failed' && !x.detail.retrying && x.detail.reason.includes('no_service'))).toBe(true);
  });

  it('테스트 데이터 이슈는 test 이벤트를 켠 채널만 · 해결 시 resolved 채널 · 발송 전 해결되면 skipped', async () => {
    const ch = await setupChannels();
    const testCh = (await pm.post(W('/notify/channels'), { type: 'webhook', name: '시연 채널', config: { url: 'https://demo.example.com/hook' }, minSeverity: 'P3', events: ['test'] })).json.channel;
    const inc = { id: 'tracking_break:카카오:2026-10-31:test-1', ruleId: 'tracking_break', severity: 'P1', title: '[테스트] 카카오 전환 추적 단절', isTest: true, status: 'open' };
    await ae.post(W('/incidents'), { incident: inc });
    const q1 = (await t.db.query<{ payload: { channelId: string } }>(`SELECT payload FROM jobs WHERE type = 'notify.send'`)).rows.map((r) => r.payload.channelId);
    expect(q1).toEqual([testCh.id]);
    await run();
    expect(posts.map((p) => p.url)).toEqual(['https://demo.example.com/hook']);
    expect(JSON.parse(posts[0].body).incident.isTest).toBe(true);
    // 실제 이슈 해결 → resolved 이벤트 채널(웹훅)만
    await t.db.query('DELETE FROM jobs');
    posts.length = 0;
    const real = { id: 'manual:점검:2026-10-31', ruleId: 'campaign_off', severity: 'P2', title: '캠페인 OFF 확인', status: 'open' };
    await ae.post(W('/incidents'), { incident: real });
    // 발송 전에 해결 → incident 알림은 skipped
    await ae.patch(W(`/incidents/${enc(real.id)}`), { patch: { status: 'resolved', actionNote: '재개 완료' }, action: '해결' });
    await run();
    const rows = (await t.db.query<{ channel_id: string; event: string; status: string; detail: { reason?: string } }>(`SELECT channel_id, event, status, detail FROM notifications WHERE ref_id = $1 ORDER BY id`, [real.id])).rows;
    const resolved = rows.filter((r) => r.event === 'resolved');
    expect(resolved.map((r) => [r.channel_id, r.status])).toEqual([[ch.hook.id, 'sent']]);
    const skippedIncident = rows.filter((r) => r.event === 'incident' && r.status === 'skipped' && r.detail.reason?.includes('이미 해결'));
    expect(skippedIncident.length).toBe(2); // 메일 · 웹훅
    const resolvedPost = posts.find((p) => JSON.parse(p.body).event === 'resolved');
    expect(JSON.parse(resolvedPost!.body).incident.actionNote).toBe('재개 완료');
  });

  it('채널이 꺼지거나 삭제되면 발송하지 않고 skipped 기록', async () => {
    const ch = await setupChannels();
    await scan();
    await pm.patch(W(`/notify/channels/${ch.mail.id}`), { enabled: false });
    await pm.del(W(`/notify/channels/${ch.hook.id}`));
    await run();
    expect(getTestOutbox()).toHaveLength(0);
    expect(posts.filter((p) => p.url === HOOK)).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE status = 'skipped' AND detail->>'reason' = '채널이 꺼져 있습니다'`)).toBe(10);
    expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE status = 'skipped' AND detail->>'reason' = '채널이 삭제되었습니다'`)).toBe(10);
  });
});

/* ============================== SLA ============================== */

describe('alerts.sla — 기한 초과 에스컬레이션 (단계당 1회)', () => {
  beforeEach(reset);

  it('P1: 인지 15분 → 1차 조치 30분 → 결과 2시간, 단계마다 한 번만 · sla 채널만 알림 · 감사 · 운영자 처리 단계는 제외', async () => {
    const tue = Date.parse('2026-11-03T10:00:00+09:00'); // 평일
    setNowForTest(tue);
    const slack = (await pm.post(W('/notify/channels'), { type: 'slack', name: '#pm-escalation', config: { webhookUrl: SLACK }, minSeverity: 'P2', events: ['sla'] })).json.channel;
    await pm.post(W('/notify/channels'), { type: 'email', name: '감지만', config: { recipients: ['ae@mildo.kr'] }, events: ['incident'] });
    const id = 'tracking_break:네이버 SA:2026-11-03';
    await ae.post(W('/incidents'), { incident: { id, ruleId: 'tracking_break', severity: 'P1', title: '네이버 SA 전환 추적 단절', media: 'naver_sa', detectedAt: '2026-11-03T10:00:00+09:00' } });
    await t.db.query(`DELETE FROM jobs`);
    const sweep = async (min: number) => {
      setNowForTest(tue + min * 60_000);
      await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
      await run();
    };
    const esc = async () => (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    const escLines = (i: { timeline: { action: string }[] }) => i.timeline.filter((e) => e.action.startsWith('에스컬레이션:')).map((e) => e.action);

    await sweep(10);
    expect(escLines(await esc())).toEqual([]);
    await sweep(16);
    let inc = await esc();
    expect(escLines(inc)).toHaveLength(1);
    expect(escLines(inc)[0]).toMatch(/^에스컬레이션: 인지 기한 초과 \(목표 15분/);
    expect(inc.escalations.ack.notified).toBe(1);
    await sweep(17);
    await sweep(20);
    expect(escLines(await esc())).toHaveLength(1);
    // 인지 처리 후 30분 경과 → 1차 조치만
    setNowForTest(tue + 21 * 60_000);
    await ae.patch(W(`/incidents/${enc(id)}`), { patch: { status: 'ack' }, action: '인지' });
    await sweep(31);
    inc = await esc();
    expect(escLines(inc)).toHaveLength(2);
    expect(escLines(inc)[1]).toMatch(/^에스컬레이션: 1차 조치 기한 초과/);
    await sweep(45);
    expect(escLines(await esc())).toHaveLength(2);
    await sweep(121);
    inc = await esc();
    expect(escLines(inc)).toHaveLength(3);
    expect(escLines(inc)[2]).toMatch(/^에스컬레이션: 결과 보고 기한 초과/);
    await sweep(180);
    expect(escLines(await esc())).toHaveLength(3);
    // 알림: sla 채널(Slack)로 단계마다 1건, 감지 전용 메일 채널은 sla 미구독
    const slaPosts = posts.filter((p) => p.url === SLACK).map((p) => JSON.parse(p.body).blocks[0].text.text as string);
    expect(slaPosts).toHaveLength(3);
    expect(slaPosts[0]).toContain('[SLA 초과 · P1] 인지 기한 초과');
    expect(slaPosts[1]).toContain('1차 조치 기한 초과');
    expect(slaPosts[2]).toContain('결과 보고 기한 초과');
    const slaRows = (await t.db.query<{ event: string; channel_id: string; detail: { stage: string } }>(`SELECT event, channel_id, detail FROM notifications WHERE event = 'sla' ORDER BY id`)).rows;
    expect(slaRows.map((r) => [r.channel_id, r.detail.stage])).toEqual([[slack.id, 'ack'], [slack.id, 'action'], [slack.id, 'report']]);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'incident.escalate' AND target_id = $1`, [id])).toBe(3);
  });

  it('주말: 담당이 없으면 당번표로 채우고, 해결된 이슈는 에스컬레이션하지 않는다', async () => {
    const sat = Date.parse('2026-11-07T14:00:00+09:00');
    setNowForTest(sat);
    const id = 'manual:주말 점검:2026-11-07';
    const r = await ae.post(W('/incidents'), { incident: { id, ruleId: 'campaign_off', severity: 'P2', title: '캠페인 OFF', media: 'meta' } });
    const duty = onDutyFor('2026-11-07')!;
    expect(r.json.incident.assignee).toBe(duty.role);
    expect(r.json.incident.onDuty).toBe(true);
    // 주말 P2 인지 기한 30분
    setNowForTest(sat + 31 * 60_000);
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    const inc = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    const line = inc.timeline.find((e: { action: string }) => e.action.startsWith('에스컬레이션: 인지'));
    expect(line.action).toContain('30분');
    expect(line.action).toContain(`당번 ${duty.role}`);
    // 해결 후에는 더 이상 없음
    await ae.patch(W(`/incidents/${enc(id)}`), { patch: { status: 'resolved' }, action: '해결' });
    setNowForTest(sat + 600 * 60_000);
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    const after = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(after.timeline.filter((e: { action: string }) => e.action.startsWith('에스컬레이션:'))).toHaveLength(1);
  });
});

/* ============================== 스케줄 · 정책 ============================== */

describe('스케줄 · 정책', () => {
  beforeEach(reset);

  it('alerts.scan: 활성 워크스페이스마다 10분 슬롯 dedupe, alerts.sla: 열린 이슈가 있는 워크스페이스만', async () => {
    const ctx = scheduleContext(t.db, t.config);
    setNowForTest(Date.parse('2026-11-03T10:01:00+09:00'));
    await runScheduleNow('alerts.scan', ctx);
    await runScheduleNow('alerts.scan', ctx);
    const scans = (await t.db.query<{ workspace_id: string; dedupe_key: string }>(`SELECT workspace_id, dedupe_key FROM jobs WHERE type = 'alerts.scan' ORDER BY workspace_id`)).rows;
    expect(scans).toHaveLength(2); // 시드 + 다른 브랜드 (둘 다 active), 같은 슬롯 중복 없음
    expect(new Set(scans.map((s) => s.workspace_id))).toEqual(new Set([t.ws, otherWs]));
    expect(scans.every((s) => s.dedupe_key.startsWith('alerts.scan:'))).toBe(true);
    await runScheduleNow('alerts.sla', ctx);
    expect(await count(`SELECT count(*)::int AS n FROM jobs WHERE type = 'alerts.sla'`)).toBe(0);
    await t.db.query(`INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc) VALUES ('x:1', $1, 'x', 'P3', 'open', '{"id":"x:1"}')`, [t.ws]);
    await runScheduleNow('alerts.sla', ctx);
    await runScheduleNow('alerts.sla', ctx);
    const sla = (await t.db.query<{ workspace_id: string }>(`SELECT workspace_id FROM jobs WHERE type = 'alerts.sla'`)).rows;
    expect(sla).toEqual([{ workspace_id: t.ws }]);
  });

  it('정책: SLA 표 · 당번표 · 현재 체계 (읽기 권한)', async () => {
    setNowForTest(Date.parse('2026-11-03T10:00:00+09:00'));
    const r = await client.get(W('/alerts/policy'));
    expect(r.status).toBe(200);
    expect(r.json.sla.P1).toMatchObject({ ackMin: 15, actionMin: 30, reportMin: 120 });
    expect(r.json.weekendAckMin).toBe(30);
    expect(r.json.regime.off).toBe(false);
    expect(r.json.roster.length).toBeGreaterThan(5);
    expect(r.json.roster[0]).toHaveProperty('role');
    expect((await pm.get(`/api/w/${otherWs}/alerts/policy`)).status).toBe(404);
  });
});

/* ============================== 리뷰 보강: 정직성 · 교차 요청 · 견고성 ============================== */

describe('테스트 데이터 감지 이슈 (TEST DATA 표기 · test 채널만)', () => {
  beforeEach(reset);

  it('meta 없음 · demo 데이터로 감지한 이슈는 isTest — test 이벤트 채널만 발송, 본문에 TEST DATA', async () => {
    const realCh = (await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['incident', 'sla'] })).json.channel;
    const demoCh = (await pm.post(W('/notify/channels'), { type: 'webhook', name: '시연', config: { url: 'https://demo.example.com/hook' }, minSeverity: 'P3', events: ['test'] })).json.channel;
    dataset = DEMO; // data 도메인 데모 커넥터 = meta 없음 또는 mode demo
    const r = await scan();
    expect(r.created).toBe(10);
    const docs = (await t.db.query<{ doc: { isTest: boolean; dataMode: string } }>(`SELECT doc FROM incidents WHERE workspace_id = $1`, [t.ws])).rows;
    expect(docs.every((d) => d.doc.isTest === true && d.doc.dataMode === 'demo')).toBe(true);
    const targets = (await t.db.query<{ payload: { channelId: string } }>(`SELECT payload FROM jobs WHERE type = 'notify.send'`)).rows.map((x) => x.payload.channelId);
    expect(targets).toHaveLength(10);
    expect(new Set(targets)).toEqual(new Set([demoCh.id]));
    expect(targets).not.toContain(realCh.id);
    await run();
    expect(posts.every((p) => p.url === 'https://demo.example.com/hook')).toBe(true);
    const body = JSON.parse(posts[0].body);
    expect(body.incident.isTest).toBe(true);
  });

  it('mixed: 그 매체 출처가 전부 demo면 isTest, 실연동 출처가 있으면 실이슈', async () => {
    dataset = {
      ...DEMO,
      meta: {
        mode: 'mixed', builtAt: DEMO.generatedAt,
        sources: [
          { channel: 'kakao', source: 'conn-kakao', kind: 'api', latestDate: DEMO.today },
          { channel: 'meta', source: 'demo', kind: 'demo', latestDate: DEMO.today },
        ],
      },
    };
    await scan();
    const rows = (await t.db.query<{ id: string; doc: { isTest: boolean; media: string } }>(`SELECT id, doc FROM incidents WHERE workspace_id = $1`, [t.ws])).rows;
    const by = (m: string) => rows.filter((x) => x.doc.media === m);
    expect(by('kakao').length).toBeGreaterThan(0);
    expect(by('kakao').every((x) => x.doc.isTest === false)).toBe(true);
    expect(by('meta').length).toBeGreaterThan(0);
    expect(by('meta').every((x) => x.doc.isTest === true)).toBe(true);
  });
});

describe("이벤트 'notify' (알림 채널 · 발송 결과)", () => {
  beforeEach(reset);

  it('채널 생성 · 수정 · 테스트 발송 · 발송 결과 · 삭제마다 notify 이벤트(id = 채널 id)', async () => {
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => got.push(`${e.type}:${e.id ?? ''}`));
    const id = (await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['incident'] })).json.channel.id;
    await pm.patch(W(`/notify/channels/${id}`), { name: '#ops-2' });
    await pm.post(W(`/notify/channels/${id}/test`));
    await ae.post(W('/incidents'), { incident: { id: 'manual:notify-event:1', ruleId: 'campaign_off', severity: 'P2', title: '캠페인 OFF' } });
    await run();
    await pm.del(W(`/notify/channels/${id}`));
    const mine = () => got.filter((g) => g === `notify:${id}`).length;
    for (let i = 0; i < 40 && mine() < 5; i++) await new Promise((r) => setTimeout(r, 50));
    off();
    expect(mine()).toBe(5);
    // 다른 워크스페이스로는 가지 않는다
    expect(got.every((g) => !g.includes(otherWs))).toBe(true);
  });
});

describe('다른 도메인이 직접 넣은 이슈 (changes 대량 변경 bulk_change)', () => {
  beforeEach(reset);

  /** changes/service.ts storeBulkIncidents와 같은 방식으로 적재 */
  async function insertBulk(nowMsVal: number) {
    const chg = {
      id: 'chg-bulk-1', createdAt: '2026-11-03T09:58:00+09:00', module: 'adpilot', kind: 'bid', target: '매트리스 추천', targetId: 'kw-1', before: 1000, after: 1500, changePct: 50,
      reason: '테스트', requestedBy: '담당 AE', approver: 'AE', status: 'applied', history: [],
    } as unknown as ChangeRequest;
    const [b] = detectBulkChange([chg], { today: '2026-11-03' });
    expect(b.id).toMatch(/^bulk_change:/);
    await t.db.query(
      `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5::jsonb, $6, $6) ON CONFLICT DO NOTHING`,
      [b.id, t.ws, b.ruleId, b.severity, JSON.stringify({ ...b, status: 'open' }), new Date(nowMsVal)],
    );
    return b.id;
  }

  it('SLA 잡이 한 번 알림 접수(on-call) → 다시 보내지 않음 · PATCH로 해결 · 해결 공유', async () => {
    const tue = Date.parse('2026-11-03T10:00:00+09:00');
    setNowForTest(tue);
    const slack = (await pm.post(W('/notify/channels'), { type: 'slack', name: '#oncall', config: { webhookUrl: SLACK }, minSeverity: 'P1', events: ['incident', 'sla', 'resolved'] })).json.channel;
    const id = await insertBulk(tue);
    const sla = async () => { await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]); await run(); };
    await sla();
    const sent = () => posts.filter((p) => p.url === SLACK).map((p) => JSON.parse(p.body).blocks[0].text.text as string);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatch(/^\[P1\] /);
    let inc = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(typeof inc.notifiedAt).toBe('string');
    expect(inc.timeline.at(-1).action).toContain('알림 접수');
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'incident.intake' AND target_id = $1`, [id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE ref_id = $1 AND event = 'incident' AND status = 'sent' AND channel_id = $2`, [id, slack.id])).toBe(1);
    await sla();
    expect(sent()).toHaveLength(1);
    // 운영자가 해결 (대량 변경 이슈는 해결 전까지 반영을 막는다 — changes 도메인)
    const r = await pm.patch(W(`/incidents/${enc(id)}`), { patch: { status: 'resolved', actionNote: '롤백 완료' }, action: '해결 · 롤백 완료' });
    expect(r.status).toBe(200);
    expect(r.json.incident.status).toBe('resolved');
    const row = (await t.db.query<{ status: string; resolved_at: Date | null }>(`SELECT status, resolved_at FROM incidents WHERE id = $1`, [id])).rows[0];
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
    await run();
    expect(sent().at(-1)).toMatch(/^\[해결 · P1\]/);
    inc = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(inc.sla.resolvedAt).toBeTruthy();
  });

  it('감지 · 화면 생성 이슈는 접수 대상이 아니다 (중복 알림 없음)', async () => {
    await pm.post(W('/notify/channels'), { type: 'slack', name: '#ops', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['incident'] });
    await scan();
    await run();
    const before = posts.length;
    expect(before).toBe(10);
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    expect(posts.length).toBe(before);
  });
});

describe('SLA 견고성 · 클라이언트 SLA 기록 · 당번 체계 강제', () => {
  beforeEach(reset);
  const tue = Date.parse('2026-11-03T10:00:00+09:00');

  it('화면이 만든 이슈의 sla 기록은 받지 않는다 — 미리 인지로 채워 에스컬레이션을 피할 수 없다', async () => {
    setNowForTest(tue);
    await pm.post(W('/notify/channels'), { type: 'slack', name: '#pm', config: { webhookUrl: SLACK }, minSeverity: 'P2', events: ['sla'] });
    const id = 'manual:sla-bypass:1';
    const r = await ae.post(W('/incidents'), {
      incident: { id, ruleId: 'tracking_break', severity: 'P1', title: '전환 추적 단절', media: 'naver_sa', detectedAt: '2026-11-03T10:00:00+09:00', sla: { ackAt: '2026-11-03T10:00:00+09:00', actionAt: '2026-11-03T10:00:00+09:00', reportAt: '2026-11-03T10:00:00+09:00' } },
    });
    expect(r.status).toBe(201);
    expect(r.json.incident.sla).toEqual({});
    setNowForTest(tue + 16 * 60_000);
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    const inc = (await pm.get(W('/incidents'))).json.incidents.find((i: { id: string }) => i.id === id);
    expect(inc.escalations?.ack).toBeTruthy();
    // 처음부터 '인지' 상태로 만들면 인지 시각은 서버 수신 시각
    setNowForTest(tue + 20 * 60_000);
    const a = await ae.post(W('/incidents'), { incident: { id: 'manual:sla-bypass:2', ruleId: 'campaign_off', severity: 'P2', title: 'x', status: 'ack', sla: { ackAt: '2020-01-01T00:00:00+09:00' } } });
    expect(a.json.incident.sla.ackAt).toBe('2026-11-03T10:20:00+09:00');
  });

  it('깨진 이슈 문서 하나가 있어도 다른 이슈의 에스컬레이션은 계속된다 (잡 성공 · 오류 기록)', async () => {
    setNowForTest(tue);
    await t.db.query(
      `INSERT INTO incidents (id, workspace_id, rule_id, severity, status, doc, detected_at) VALUES ('broken:1', $1, 'x', 'P1', 'open', $2::jsonb, $3)`,
      [t.ws, JSON.stringify({ id: 'broken:1', detectedAt: '2026-11-03T09:00:00+09:00', timeline: 5, source: 'client' }), new Date(tue - 3600_000)],
    );
    const id = 'manual:good:1';
    await ae.post(W('/incidents'), { incident: { id, ruleId: 'tracking_break', severity: 'P1', title: '정상 이슈', detectedAt: '2026-11-03T10:00:00+09:00' } });
    setNowForTest(tue + 16 * 60_000);
    await t.db.query(`DELETE FROM jobs`);
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    const j = (await t.db.query<{ status: string; result: { escalated: { id: string }[]; errors: { id: string }[] } }>(`SELECT status, result FROM jobs WHERE type = 'alerts.sla'`)).rows[0];
    expect(j.status).toBe('done');
    expect(j.result.escalated.map((e) => e.id)).toContain(id);
    expect(j.result.errors.map((e) => e.id)).toContain('broken:1');
  });

  it('설정 offHoursMode=true면 평일에도 당번표로 배정 · 정책 응답에 강제 표시', async () => {
    setNowForTest(tue);
    await t.db.query(`UPDATE workspaces SET config = '{"offHoursMode": true}'::jsonb WHERE id = $1`, [t.ws]);
    const duty = regimeOf('2026-11-03', true).duty!;
    const r = await ae.post(W('/incidents'), { incident: { id: 'manual:forced:1', ruleId: 'campaign_off', severity: 'P2', title: '캠페인 OFF', media: 'meta' } });
    expect(r.json.incident.assignee).toBe(duty.role);
    expect(r.json.incident.onDuty).toBe(true);
    const p = await viewer.get(W('/alerts/policy'));
    expect(p.json.regime).toMatchObject({ off: true, forced: true });
    // 설정이 없으면 평일 매체 담당
    await t.db.query(`UPDATE workspaces SET config = '{}'::jsonb WHERE id = $1`, [t.ws]);
    const r2 = await ae.post(W('/incidents'), { incident: { id: 'manual:forced:2', ruleId: 'campaign_off', severity: 'P2', title: '캠페인 OFF', media: 'meta' } });
    expect(r2.json.incident.onDuty).toBe(false);
  });

  it('형식이 틀린 채널 id는 500이 아니라 404 · 400', async () => {
    const bogus = '-'.repeat(36);
    expect((await pm.patch(W(`/notify/channels/${bogus}`), { enabled: false })).status).toBe(404);
    expect((await pm.post(W(`/notify/channels/${bogus}/test`))).status).toBe(404);
    expect((await viewer.get(W(`/notify/log?channelId=${bogus}`))).status).toBe(400);
  });
});
