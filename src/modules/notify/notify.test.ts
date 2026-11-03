/**
 * 알림 설정 모듈: 입력 검증(서버와 같은 기준의 즉시 안내) · API 본문 · 데모 예시 · 요약 · 메시지 형식 · 에이전트 도구 · 브리프 · 화면 렌더(SSR, 데모 모드).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import type { ToolContext } from '../types';
import type { AppState } from '@/core/store';
import {
  DEMO_CHANNELS, demoLog, demoRuns, draftProblems, draftToBody, emptyDraft, localPolicy, parseRecipients, severityAllowed, slaRows, summarize, urlProblem, type Channel,
} from './model';
import { buildMessage } from './message';
import { agentKit, notifyBrief } from './agent';
import { setNotifySnapshot, _resetNotifySnapshotForTest } from './live';

function ctx(): ToolContext {
  const state = {
    data: DEMO, changes: [], incidents: detectIncidents(DEMO), toasts: [], comments: [], ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' },
    role: 'PM', offHoursMode: false, tf: {}, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  } as unknown as AppState;
  return { state, actions: {} as ToolContext['actions'], navigate: () => undefined };
}

afterEach(() => _resetNotifySnapshotForTest());

describe('입력 검증 (화면 즉시 안내)', () => {
  it('Slack 주소 형식', () => {
    expect(draftProblems({ ...emptyDraft('slack'), name: '#ops', webhookUrl: 'https://hooks.slack.com/services/T1/B2/xyz' })).toEqual({});
    expect(draftProblems({ ...emptyDraft('slack'), name: '#ops', webhookUrl: 'https://hooks.slack.com.evil.io/services/T1/B2/xyz' }).webhookUrl).toBeTruthy();
    expect(draftProblems({ ...emptyDraft('slack'), name: '' }).name).toBeTruthy();
    // 편집: 비워 두면 기존 주소 유지
    expect(draftProblems({ ...emptyDraft('slack'), name: '#ops' }, true)).toEqual({});
  });
  it.each(['http://127.0.0.1/x', 'http://169.254.169.254/latest', 'https://127.0.0.1/x', 'https://169.254.169.254/x', 'https://10.0.0.1/x', 'https://192.168.1.2/x', 'https://172.16.0.9/x', 'https://localhost/x', 'https://[::1]/x', 'http://hooks.example.com/x', 'nope'])('웹훅 차단 %s', (url) => {
    expect(urlProblem(url)).toBeTruthy();
    expect(draftProblems({ ...emptyDraft('webhook'), name: 'h', url }).url).toBeTruthy();
  });
  it('웹훅 허용 · 비밀값 길이 · 이메일', () => {
    expect(urlProblem('https://hooks.partner.example.com/mildo')).toBeNull();
    expect(draftProblems({ ...emptyDraft('webhook'), name: 'h', url: 'https://hooks.example.com/x', secret: 'short' }).secret).toBeTruthy();
    expect(parseRecipients('A@x.com, a@x.com;\nb@y.kr')).toEqual(['a@x.com', 'b@y.kr']);
    expect(draftProblems({ ...emptyDraft('email'), name: 'm', recipients: 'a@x.com, bad' }).recipients).toContain('bad');
    expect(draftProblems({ ...emptyDraft('email'), name: 'm', recipients: 'a@x.com' })).toEqual({});
    expect(draftProblems({ ...emptyDraft('email'), name: 'm', events: [], recipients: 'a@x.com' }).events).toBeTruthy();
  });
  it('API 본문: 생성은 전체, 편집은 빈 주소 · 비밀값을 보내지 않고 지우기는 null', () => {
    const create = draftToBody({ ...emptyDraft('webhook'), name: ' h ', url: 'https://hooks.example.com/x', secret: 's'.repeat(20) });
    expect(create).toEqual({ type: 'webhook', name: 'h', minSeverity: 'P2', events: ['incident', 'sla'], enabled: true, config: { url: 'https://hooks.example.com/x', secret: 's'.repeat(20) } });
    expect(draftToBody({ ...emptyDraft('webhook'), name: 'h' }, true)).toEqual({ name: 'h', minSeverity: 'P2', events: ['incident', 'sla'], enabled: true });
    expect(draftToBody({ ...emptyDraft('webhook'), name: 'h', removeSecret: true }, true)).toMatchObject({ config: { secret: null } });
  });
});

describe('데모 예시 · 요약 · 정책', () => {
  it('데모 채널은 가린 값만 가진다', () => {
    const s = JSON.stringify(DEMO_CHANNELS);
    expect(s).not.toMatch(/hooks\.slack\.com\/services\//);
    for (const r of DEMO_CHANNELS.flatMap((c) => c.config.recipients ?? [])) expect(r).toMatch(/^.{0,2}••••@/);
    for (const c of DEMO_CHANNELS) expect(c.config.target).toBeTruthy();
  });
  it('데모 발송 이력은 채널 등급 필터를 그대로 따른다', () => {
    const log = demoLog();
    for (const l of log.filter((x) => x.event === 'incident')) {
      const ch = DEMO_CHANNELS.find((c) => c.id === l.channelId)!;
      expect(l.status === 'skipped', `${ch.name} ${l.severity}`).toBe(!severityAllowed(ch.minSeverity, l.severity!));
    }
    const sum = summarize(DEMO_CHANNELS, log);
    expect(sum.channels).toBe(3);
    expect(sum.failing.map((c) => c.name)).toEqual(['사내 온콜 시스템']);
    expect(sum.log.retrying).toBeGreaterThan(0);
    expect(demoRuns()).toHaveLength(12);
  });
  it('SLA 표 · 당번표 (상수 기준)', () => {
    const rows = slaRows();
    expect(rows.map((r) => [r.severity, r.ack, r.action, r.report])).toEqual([['P1', '15분', '30분', '2시간'], ['P2', '1시간', '4시간', '당일'], ['P3', '1일', '협의', '주간']]);
    expect(rows[1].weekendAck).toContain('30분');
    const p = localPolicy('2026-10-31');
    expect(p.regime.off).toBe(true);
    expect(p.roster[0].date).toBe('2026-10-31');
  });
});

describe('메시지 형식 (서버 발송과 같은 함수)', () => {
  it('원인 후보 상위 2 · 영향 추정 · SLA 기한 · 링크', () => {
    const inc = detectIncidents(DEMO).find((i) => i.severity === 'P1')!;
    const m = buildMessage({ event: 'incident', appUrl: 'https://os.test', workspace: { id: 'w', slug: 'w', name: 'W', brand_name: '수면밀도' }, incident: inc, sentAtMs: 0 });
    expect(m.subject).toMatch(/^\[MILDO OS\] P1 /);
    expect(m.text).toContain('원인 후보 상위 2');
    expect(m.text).toContain('SLA 기한');
    expect(m.text).toContain('https://os.test/#alert');
    expect(m.text).not.toMatch(/NaN|undefined/);
  });
});

describe('에이전트 도구 · 브리프', () => {
  it('notify_channels_status: 데모 → TEST DATA, 비밀값 없음', async () => {
    const tool = agentKit.tools(ctx()).find((t) => t.name === 'notify_channels_status')!;
    const r = (await tool.execute({})) as { source: string; dataKind: string; channels: unknown[]; coverage: { incident: number }; delivery: { recentProblems: unknown[] } };
    expect(r.source).toBe('demo');
    expect(r.dataKind).toContain('TEST DATA');
    expect(r.channels).toHaveLength(3);
    expect(r.coverage.incident).toBe(3);
    expect(r.delivery.recentProblems.length).toBeGreaterThan(0);
    expect(JSON.stringify(r).length).toBeLessThan(32_000);
  });
  it('notify_channels_status: 화면이 읽은 서버 값이 있으면 그것을 쓴다', async () => {
    const ch: Channel = { ...DEMO_CHANNELS[0], id: 'srv-1', name: '#live-ops', lastStatus: 'sent' };
    setNotifySnapshot('ws-1', { channels: [ch], log: [], runs: [] });
    const tool = agentKit.tools(ctx()).find((t) => t.name === 'notify_channels_status')!;
    const r = (await tool.execute({})) as { source: string; channels: { name: string }[] };
    expect(r.source).toBe('server');
    expect(r.channels.map((c) => c.name)).toEqual(['#live-ops']);
  });
  it('notify_message_preview', async () => {
    const tool = agentKit.tools(ctx()).find((t) => t.name === 'notify_message_preview')!;
    const r = (await tool.execute({})) as { subject: string; body: string };
    expect(r.subject).toMatch(/^\[MILDO OS\] P1/);
    expect(r.body).toContain('영향 (추정)');
  });
  it('브리프: 구조 · 번호 매기기 없음 · 채널 없을 때 경고', () => {
    const b = notifyBrief(ctx());
    expect(b.facts.length).toBeGreaterThan(2);
    const all = [...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions].join('\n');
    expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
    expect(all).not.toMatch(/NaN|undefined|Infinity/);
    expect(all).toContain('TEST DATA');
    setNotifySnapshot('ws-1', { channels: [], log: [], runs: [] });
    const empty = notifyBrief(ctx());
    expect(empty.interpretation[0]).toContain('0개');
    expect(empty.actions[0]).toContain('채널을 추가');
    expect(agentKit.briefs![0].match.test('슬랙 알림 채널 상태 알려줘')).toBe(true);
  });
});

describe('화면 렌더 (SSR · 데모 모드)', () => {
  beforeAll(() => {
    const mem: Record<string, string> = {};
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; },
      clear: () => undefined, key: () => null, length: 0,
    } as Storage;
  });
  async function render(el: (mod: Record<string, unknown>) => ReturnType<typeof h>) {
    const { StoreProvider } = await import('@/core/store');
    const mod = (await import('./View')) as Record<string, unknown>;
    return renderToString(h(StoreProvider, null, el(mod)));
  }
  it('기본 화면: 안내 · TEST DATA · 예시 채널 · 미리보기, 버튼은 읽기 전용', async () => {
    const html = await render((m) => h(m.default as ComponentType));
    expect(html).toContain('알림 설정');
    expect(html).toContain('서버 연결 시 실제로 동작합니다');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('#수면밀도-운영');
    expect(html).toContain('메시지 미리보기');
    expect(html).toContain('원인 후보 상위 2');
    expect(html).toContain('데모 모드 · 서버 연결 시 사용');
    expect(html).not.toContain('hooks.slack.com/services/');
    expect(html).not.toMatch(/NaN|undefined/);
  });
  it.each(['LogTab', 'RunsTab'])('%s', async (name) => {
    const html = await render((m) => {
      const Tab = m[name] as ComponentType<Record<string, unknown>>;
      const useNotifyData = m.useNotifyData as (ws: string | null) => unknown;
      function Harness() { return h(Tab, { d: useNotifyData(null), ws: null, canOperate: false }); }
      return h(Harness);
    });
    expect(html.length).toBeGreaterThan(1000);
    expect(html).toContain('TEST DATA');
    expect(html).not.toMatch(/NaN|undefined/);
  });
  it.each(['PolicyTab', 'RosterTab'])('%s', async (name) => {
    const html = await render((m) => h(m[name] as ComponentType<Record<string, unknown>>, { policy: localPolicy('2026-10-31'), demo: true }));
    expect(html.length).toBeGreaterThan(800);
    expect(html).not.toMatch(/NaN|undefined/);
    if (name === 'PolicyTab') expect(html).toContain('15분');
    if (name === 'RosterTab') expect(html).toContain('당번');
  });
  it('채널 편집 창 (편집: 기존 값 유지 안내 · 비밀값 미표시)', async () => {
    const html = await render((m) => h(m.ChannelForm as ComponentType<Record<string, unknown>>, {
      ws: 'ws-1', init: { ...emptyDraft('webhook'), name: '사내 온콜 시스템' }, channel: DEMO_CHANNELS[2], onClose: () => undefined, onSaved: async () => undefined,
    }));
    expect(html).toContain('비워 두면 기존 주소 유지');
    expect(html).toContain('X-Mildo-Signature');
    expect(html).not.toMatch(/NaN|undefined/);
  });
});

describe('화면 규칙 (정적 검사)', () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts'));
  it.each(files)('%s: window.alert/confirm/prompt/open · 하드코딩 색 없음', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src).not.toMatch(/window\.(alert|confirm|prompt|open)\s*\(/);
    expect(src).not.toMatch(/(^|[^&\w])#[0-9a-fA-F]{3,8}\b/m);
    expect(src).not.toMatch(/(^|[^.\w])(confirm|alert|prompt)\(/m);
  });
});
