/**
 * QA 회귀 (정직성 · SAAS_SPEC §0): 서버 감지 이슈의 감지 타임라인 · 자동 조치가 실제 발송 요청 결과를 적는다.
 * 채널이 없는데 '감지 · 메신저 알림 (AE + 백업 + PM)' · '메신저 즉시 알림 발송 · …'으로 보낸 것처럼 남던 문제.
 * 실제 PostgreSQL · 가짜 Dataset · 실제 네트워크 없음 (발송 잡은 만들기만 하고 실행하지 않는다).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import { createTestApp, type TestApp } from '../../test/app';
import { setNowForTest } from '../lib/time';
import { scanWorkspace } from './scan';
import { setAlertDepsForTest } from './deps';
import { encryptConfig } from './channels';

const LIVE: Dataset = { ...DEMO, meta: { mode: 'live', builtAt: DEMO.generatedAt, sources: [] } };
const SLACK = ['https://hooks.slack.com', 'services', 'T0AAA1111', 'B0BBB2222', 'abcdefghijklmnopqrstuvwx'].join('/');

let t: TestApp;
let restore: () => void;
let dataset: Dataset = LIVE;

beforeAll(async () => {
  t = await createTestApp();
  restore = setAlertDepsForTest({ buildDataset: async () => dataset, poster: async () => ({ status: 200, body: 'ok', headers: {} }) });
});
afterAll(async () => {
  restore?.();
  setNowForTest(null);
  await t?.close();
});
beforeEach(async () => {
  for (const tb of ['incidents', 'notifications', 'notification_channels', 'jobs', 'alert_scan_runs']) await t.db.query(`DELETE FROM ${tb}`);
  dataset = LIVE;
});

interface Doc { title: string; severity: string; isTest?: boolean; timeline: { by: string; action: string }[]; autoActions: string[] }
const docs = async () => (await t.db.query<{ id: string; doc: Doc }>(`SELECT id, doc FROM incidents WHERE workspace_id = $1 ORDER BY id`, [t.ws])).rows;

async function addChannel(o: { minSeverity: 'P1' | 'P2' | 'P3'; events: string[] }) {
  await t.db.query(
    `INSERT INTO notification_channels (workspace_id, type, name, config_enc, min_severity, events, enabled) VALUES ($1, 'slack', '#ops', $2, $3, $4, true)`,
    [t.ws, encryptConfig({ webhookUrl: SLACK }, t.config.encryptionKey), o.minSeverity, o.events],
  );
}

describe('서버 감지 이슈 · 알림 문구 = 실제 발송 요청 결과', () => {
  it('알림 채널이 없으면 감지 타임라인 · 자동 조치가 "알림 미발송"으로 남고 보냈다는 문구가 없다', async () => {
    const r = await scanWorkspace(t.db, t.ws, { trigger: 'manual' });
    expect(r.created).toBeGreaterThan(0);
    expect(r.notified).toBe(0);
    const rows = await docs();
    expect(rows.length).toBe(r.created);
    for (const { doc } of rows) {
      const first = doc.timeline[0];
      expect(first.by).toBe('MILDO Alert');
      expect(first.action).toMatch(/^감지 · 알림 미발송 \(/);
      expect(first.action).not.toMatch(/메신저 알림|메일 알림/);
      expect(doc.autoActions.some((a) => /^(메신저|메일) (즉시 )?알림 발송/.test(a))).toBe(false);
      expect(doc.autoActions.some((a) => a.startsWith('알림 미발송 · 이 이벤트를 받는 켜진 알림 채널 없음'))).toBe(true);
    }
  });

  it('채널이 있으면 발송 요청한 채널 수를 적고 결과는 발송 이력 기준이라고 밝힌다 · 등급 기준 밖이면 그 사유', async () => {
    await addChannel({ minSeverity: 'P1', events: ['incident'] });
    const r = await scanWorkspace(t.db, t.ws, { trigger: 'manual' });
    expect(r.created).toBeGreaterThan(0);
    const rows = await docs();
    const p1 = rows.filter((x) => x.doc.severity === 'P1');
    const lower = rows.filter((x) => x.doc.severity !== 'P1');
    expect(p1.length).toBeGreaterThan(0);
    expect(lower.length).toBeGreaterThan(0);
    for (const { doc } of p1) {
      expect(doc.timeline[0].action).toBe('감지 · 알림 채널 1곳에 발송 요청 (결과는 알림 설정 › 발송 이력)');
      expect(doc.autoActions.some((a) => a.startsWith('알림 채널 1곳에 발송 요청 · 규칙상 수신 ') && a.endsWith('실제 발송 결과는 알림 설정 › 발송 이력'))).toBe(true);
    }
    for (const { doc } of lower) {
      expect(doc.timeline[0].action).toBe('감지 · 알림 미발송 (켜진 채널 1곳이 이 등급을 받지 않음)');
    }
    // 발송 잡 수 = P1 이슈 수 (보낸 것처럼 적은 건이 실제 잡과 일치)
    const jobs = (await t.db.query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE type = 'notify.send' AND workspace_id = $1`, [t.ws])).rows[0];
    expect(Number(jobs.n)).toBe(p1.length);
    expect(r.notified).toBe(p1.length);
  });

  it('테스트 데이터 이슈: test 이벤트 채널이 없으면 그 사유로 미발송', async () => {
    dataset = { ...DEMO, meta: { mode: 'demo', builtAt: DEMO.generatedAt, sources: [] } };
    await addChannel({ minSeverity: 'P3', events: ['incident'] });
    await scanWorkspace(t.db, t.ws, { trigger: 'manual' });
    const rows = await docs();
    expect(rows.length).toBeGreaterThan(0);
    for (const { doc } of rows) {
      expect(doc.isTest).toBe(true);
      expect(doc.timeline[0].action).toBe("감지 · 알림 미발송 (테스트 데이터 이슈를 받는 켜진 알림 채널 없음 ('test' 이벤트))");
    }
  });

  it('이미 있는 이슈의 타임라인은 다시 감지돼도 바꾸지 않는다 (운영자 처리 보존)', async () => {
    await scanWorkspace(t.db, t.ws, { trigger: 'manual' });
    const before = await docs();
    await addChannel({ minSeverity: 'P3', events: ['incident'] });
    const r2 = await scanWorkspace(t.db, t.ws, { trigger: 'manual' });
    expect(r2.created).toBe(0);
    const after = await docs();
    expect(after.map((x) => x.doc.timeline)).toEqual(before.map((x) => x.doc.timeline));
  });
});
