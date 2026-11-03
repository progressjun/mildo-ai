/**
 * QA 회귀 (G3b · alerts) — 실제 PostgreSQL · 가짜 HTTPS 포스터 (실제 네트워크 없음)
 *  - TEST DATA 이슈도 채널의 이벤트 필터를 따른다: '해결 공유'를 끈 채널은 TEST DATA 해결 알림을 받지 않는다 ('test'는 추가 조건)
 *  - 발송 이력 이벤트 필터 '테스트 데이터 이슈'(event=test)는 TEST DATA 이슈 알림(detail.isTest)을 돌려준다
 *  - incidents.detected_at 열만 앞당겨도 SLA 에스컬레이션 · 이슈 API가 그 시각을 쓴다
 *  - 리포트 notify.send가 끝나면 'report' 이벤트를 낸다 (보관함이 '발송 대기'에서 실제 결과로 바뀌게)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { registerJob, drain, _resetJobsForTest, enqueue } from '../jobs/queue';
import { registerSchedule, _resetSchedulesForTest } from '../jobs/scheduler';
import { clearTestOutbox } from '../lib/mailer';
import { jobs } from './index';
import { setAlertDepsForTest } from './deps';
import { channelWantsIncident } from './deliver';
import { rowToIncident } from './incidents';
import type { HttpPoster } from './net';

const SLACK = ['https://hooks.slack.com', 'services', 'T0QAQA111', 'B0QAQA222', 'g3bregressionpath000001'].join('/');
const HOOK = 'https://hooks.partner.example.com/mildo/g3b-hook-0001';
const enc = encodeURIComponent;
const LIVE: Dataset = { ...DEMO, meta: { mode: 'live', builtAt: DEMO.generatedAt, sources: [] } };

let t: TestApp;
let restore: () => void;
let pm: TestClient, ae: TestClient;
const posts: { url: string; body: string }[] = [];
const poster: HttpPoster = async (o) => {
  posts.push({ url: o.url, body: o.body });
  return { status: 200, body: 'ok', headers: {} };
};
const run = () => drain(t.db, t.config, { types: ['alerts.sla', 'notify.send'] });
const W = (p: string) => `/api/w/${t.ws}${p}`;

beforeAll(async () => {
  t = await createTestApp({ config: { appUrl: 'https://os.mildo.test' } });
  _resetJobsForTest();
  _resetSchedulesForTest();
  jobs({ job: registerJob, schedule: registerSchedule });
  restore = setAlertDepsForTest({ buildDataset: async () => LIVE, poster });
  [pm, ae] = await Promise.all([t.login('pm'), t.login('ae')]);
});
afterAll(async () => {
  restore?.();
  await t?.close();
});
beforeEach(async () => {
  for (const tbl of ['incidents', 'notifications', 'notification_channels', 'jobs', 'audit_log']) await t.db.query(`DELETE FROM ${tbl}`);
  posts.length = 0;
  clearTestOutbox();
});

describe('채널 선택 규칙 (channelWantsIncident)', () => {
  it("실이슈는 그 이벤트를 켠 채널만, TEST DATA 이슈는 'test' + 그 이벤트 (test만 켠 채널은 TEST DATA 전용 시연 채널)", () => {
    expect(channelWantsIncident(['incident', 'sla'], 'resolved', false)).toBe(false);
    expect(channelWantsIncident(['incident', 'resolved'], 'resolved', false)).toBe(true);
    // QA 재현: [새 이슈, SLA, 테스트 데이터 이슈] · 해결 공유 끔 → TEST DATA 해결 알림 받지 않음
    expect(channelWantsIncident(['incident', 'sla', 'test'], 'resolved', true)).toBe(false);
    expect(channelWantsIncident(['incident', 'sla', 'test'], 'incident', true)).toBe(true);
    expect(channelWantsIncident(['incident', 'sla'], 'incident', true)).toBe(false);
    expect(channelWantsIncident(['test'], 'resolved', true)).toBe(true);
    expect(channelWantsIncident(['test', 'report'], 'sla', true)).toBe(true);
    expect(channelWantsIncident(['test'], 'incident', false)).toBe(false);
  });
});

describe("TEST DATA 이슈 해결 알림은 '해결 공유'를 켠 채널만", () => {
  it('QA Slack(새 이슈 · SLA · 테스트 데이터 이슈, 해결 공유 끔)은 TEST DATA 해결 알림을 받지 않는다 · 해결 공유를 켠 채널은 받는다', async () => {
    const qa = (await pm.post(W('/notify/channels'), { type: 'slack', name: 'QA Slack', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['incident', 'sla', 'test'] })).json.channel;
    const share = (await pm.post(W('/notify/channels'), { type: 'webhook', name: '해결 공유', config: { url: HOOK }, minSeverity: 'P3', events: ['incident', 'resolved', 'test'] })).json.channel;
    const inc = { id: 'qa_manual:테스트 주입 P2', ruleId: 'qa_manual', severity: 'P2', title: '테스트 주입 P2', isTest: true, status: 'open' };
    expect((await ae.post(W('/incidents'), { incident: inc })).status).toBe(201);
    await run();
    await t.db.query('DELETE FROM jobs');
    expect((await ae.patch(W(`/incidents/${enc(inc.id)}`), { patch: { status: 'resolved', actionNote: '확인' }, action: '해결' })).status).toBe(200);
    const resolvedJobs = (await t.db.query<{ payload: { channelId: string; event: string } }>(`SELECT payload FROM jobs WHERE type = 'notify.send'`)).rows
      .filter((j) => j.payload.event === 'resolved').map((j) => j.payload.channelId);
    expect(resolvedJobs).toEqual([share.id]);
    expect(resolvedJobs).not.toContain(qa.id);
    await run();
    const resolvedRows = (await t.db.query<{ channel_id: string }>(`SELECT channel_id FROM notifications WHERE event = 'resolved'`)).rows.map((r) => r.channel_id);
    expect(resolvedRows).toEqual([share.id]);
  });
});

describe("발송 이력 이벤트 필터 '테스트 데이터 이슈'", () => {
  it('event=test는 TEST DATA 이슈 알림(detail.isTest)을 돌려준다 — 등급 밖으로 보내지 않은 행 포함, 실이슈 알림은 빠진다', async () => {
    // TEST DATA 전용 시연 채널('테스트 데이터 이슈'만) — 실이슈는 받지 않는다
    await pm.post(W('/notify/channels'), { type: 'slack', name: '시연', config: { webhookUrl: SLACK }, minSeverity: 'P1', events: ['test'] });
    await ae.post(W('/incidents'), { incident: { id: 'qa:test-p1', ruleId: 'qa_manual', severity: 'P1', title: '테스트 P1', isTest: true, status: 'open' } });
    await ae.post(W('/incidents'), { incident: { id: 'qa:test-p2', ruleId: 'qa_manual', severity: 'P2', title: '테스트 P2 (등급 밖)', isTest: true, status: 'open' } });
    await pm.post(W('/notify/channels'), { type: 'webhook', name: '실운영', config: { url: HOOK }, minSeverity: 'P3', events: ['incident'] });
    await ae.post(W('/incidents'), { incident: { id: 'qa:real-p2', ruleId: 'qa_manual', severity: 'P2', title: '실이슈 P2', status: 'open' } });
    await run();
    const all = (await pm.get(W('/notify/log'))).json.entries as { refId: string; event: string; status: string; detail: { isTest?: boolean } }[];
    expect(all.length).toBe(3);
    const test = await pm.get(W('/notify/log?event=test'));
    expect(test.status).toBe(200);
    const refs = (test.json.entries as { refId: string; status: string; event: string }[]).map((e) => `${e.refId}:${e.status}`).sort();
    expect(refs).toEqual(['qa:test-p1:sent', 'qa:test-p2:skipped']);
    expect((test.json.entries as { event: string }[]).every((e) => e.event === 'incident')).toBe(true);
    // 기존 이벤트 필터는 그대로
    expect(((await pm.get(W('/notify/log?event=incident'))).json.entries as unknown[]).length).toBe(3);
  });
});

describe('감지 시각 열(detected_at)이 SLA 기준점', () => {
  it('열만 3시간 앞당겨도 alerts.sla가 인지 · 1차 조치 · 결과 보고 에스컬레이션을 기록하고, GET /incidents도 그 시각을 보여 준다', async () => {
    await pm.post(W('/notify/channels'), { type: 'slack', name: '#pm', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['sla'] });
    const id = 'account_payment:네이버 GFA (수면밀도):2026-11-03';
    await ae.post(W('/incidents'), { incident: { id, ruleId: 'account_payment', severity: 'P1', title: 'GFA 결제 실패', status: 'open' } });
    // 첫 실행: 방금 감지 → 에스컬레이션 없음
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    const first = ((await ae.get(W('/incidents'))).json.incidents as { id: string; escalations?: Record<string, unknown> }[]).find((x) => x.id === id)!;
    expect(first.escalations ?? {}).toEqual({});
    // QA 시나리오 SQL: 열만 앞당긴다 (doc.detectedAt은 그대로)
    await t.db.query(`UPDATE incidents SET detected_at = now() - interval '3 hours' WHERE workspace_id = $1 AND id = $2`, [t.ws, id]);
    await t.db.query(`INSERT INTO jobs (type, workspace_id) VALUES ('alerts.sla', $1)`, [t.ws]);
    await run();
    const res = (await t.db.query<{ result: { escalated: { stage: string }[] } }>(`SELECT result FROM jobs WHERE type = 'alerts.sla' ORDER BY id DESC LIMIT 1`)).rows[0].result;
    expect(res.escalated.map((e) => e.stage).sort()).toEqual(['ack', 'action', 'report']);
    const list = (await ae.get(W('/incidents'))).json.incidents as { id: string; detectedAt: string; escalations?: Record<string, unknown> }[];
    const inc = list.find((x) => x.id === id)!;
    const col = (await t.db.query<{ detected_at: Date }>(`SELECT detected_at FROM incidents WHERE workspace_id = $1 AND id = $2`, [t.ws, id])).rows[0].detected_at;
    expect(Math.abs(Date.parse(inc.detectedAt) - new Date(col).getTime())).toBeLessThan(1000);
    expect(Object.keys(inc.escalations ?? {}).sort()).toEqual(['ack', 'action', 'report']);
  });

  it('rowToIncident: 열과 문서가 같은 순간이면 문서 표기 유지, 다르면 열 값(KST 표기)', () => {
    const doc = { id: 'x', ruleId: 'r', severity: 'P2', title: 't', status: 'open', detectedAt: '2026-11-03T17:22:51+09:00' } as never;
    const same = rowToIncident({ id: 'x', status: 'open', severity: 'P2', rule_id: 'r', doc, detected_at: new Date('2026-11-03T08:22:51.400Z'), resolved_at: null });
    expect(same.detectedAt).toBe('2026-11-03T17:22:51+09:00');
    const moved = rowToIncident({ id: 'x', status: 'open', severity: 'P2', rule_id: 'r', doc, detected_at: new Date('2026-11-03T06:38:00.000Z'), resolved_at: null });
    expect(moved.detectedAt).toBe('2026-11-03T15:38:00+09:00');
  });
});

describe("리포트 notify.send 결과 → 'report' 이벤트", () => {
  it("발송(sent) · 보내지 않음(채널 꺼짐) 모두 끝나면 report 이벤트(id = 리포트 id)를 낸다", async () => {
    const got: string[] = [];
    const off = t.events.subscribe(t.ws, (e) => got.push(`${e.type}:${e.id ?? ''}`));
    const on = (await pm.post(W('/notify/channels'), { type: 'slack', name: '리포트', config: { webhookUrl: SLACK }, minSeverity: 'P3', events: ['report'] })).json.channel;
    const offCh = (await pm.post(W('/notify/channels'), { type: 'webhook', name: '꺼짐', config: { url: HOOK }, minSeverity: 'P3', events: ['report'], enabled: false })).json.channel;
    const rid = '11111111-2222-4333-8444-555555555555';
    await enqueue(t.db, { type: 'notify.send', workspaceId: t.ws, payload: { channelId: on.id, event: 'report', refId: rid, payload: { title: '일간 리포트', text: '요약' } } });
    await enqueue(t.db, { type: 'notify.send', workspaceId: t.ws, payload: { channelId: offCh.id, event: 'report', refId: rid, payload: { title: '일간 리포트', text: '요약' } } });
    await run();
    await new Promise((r) => setTimeout(r, 300));
    off();
    expect(got.filter((x) => x === `report:${rid}`).length).toBe(2);
    const st = (await t.db.query<{ status: string }>(`SELECT status FROM notifications WHERE ref_id = $1 ORDER BY id`, [rid])).rows.map((r) => r.status);
    expect(st.sort()).toEqual(['sent', 'skipped']);
  });
});
