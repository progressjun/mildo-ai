/**
 * QA 회귀 (G3b · 알림 설정) — 채널 목록 종류 표기 한 번 · 발송 이력 '테스트 데이터 이슈' 필터 · TEST DATA 이슈 채널 선택 규칙(서버와 같은 규칙).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { channelWantsIncident, demoLog, DEMO_CHANNELS, EVENT_OPTIONS, logMatches, type Channel, type LogEntry } from './model';

beforeAll(() => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const ch = (type: Channel['type'], target: string, hasSecret = false): Pick<Channel, 'type' | 'config'> => ({ type, config: { target, hasSecret } });

describe('채널 목록 주소 요약 — 종류를 한 번만', () => {
  it("서버 마스킹 값이 이미 종류로 시작하면 그대로 ('Slack · Slack · …' 아님)", async () => {
    const { channelTargetText } = await import('./View');
    expect(channelTargetText(ch('slack', 'Slack · https://hooks.slack.com/••••(47자)'))).toBe('Slack · https://hooks.slack.com/••••(47자)');
    expect(channelTargetText(ch('email', '메일 · 2명'))).toBe('메일 · 2명');
    expect(channelTargetText(ch('webhook', '웹훅 · https://hooks.example.com/••••(18자)'))).toBe('웹훅 · https://hooks.example.com/••••(18자)');
    // 종류 표기가 없는 값(오류 문구 등)만 앞에 붙인다
    expect(channelTargetText(ch('slack', '설정을 읽을 수 없습니다 (암호화 키 확인)'))).toBe('Slack · 설정을 읽을 수 없습니다 (암호화 키 확인)');
  });

  it('데모 화면(SSR) 채널 탭에 종류가 두 번 나오지 않는다', async () => {
    const { StoreProvider } = await import('@/core/store');
    const View = (await import('./View')).default as ComponentType;
    const html = renderToString(h(StoreProvider, null, h(View))).replace(/<!-- -->/g, '');
    expect(html).not.toMatch(/Slack · Slack · |이메일 · 메일 · |웹훅 · 웹훅 · /);
    for (const c of DEMO_CHANNELS) expect(html).toContain(c.config.target);
  });
});

describe("발송 이력 필터 '테스트 데이터 이슈'", () => {
  const row = (o: Partial<LogEntry>): LogEntry => ({
    id: 1, at: '2026-11-03T00:00:00.000Z', channelId: 'c1', channelName: 'QA', channelType: 'slack', event: 'incident', refId: 'r', severity: 'P2', status: 'sent', attempts: 1, detail: {}, ...o,
  });
  it('event=test는 이벤트 이름이 아니라 detail.isTest (서버 GET /notify/log?event=test와 같은 규칙)', () => {
    expect(logMatches(row({ detail: { isTest: true } }), { event: 'test' })).toBe(true);
    expect(logMatches(row({ event: 'resolved', detail: { isTest: true } }), { event: 'test' })).toBe(true);
    expect(logMatches(row({ detail: { isTest: false } }), { event: 'test' })).toBe(false);
    expect(logMatches(row({ event: 'sla' }), { event: 'sla' })).toBe(true);
    expect(logMatches(row({ status: 'failed' }), { status: 'sent' })).toBe(false);
    expect(logMatches(row({}), {})).toBe(true);
    // 데모 이력(모두 TEST DATA)도 '테스트 데이터 이슈'로 고르면 비지 않는다
    expect(demoLog().filter((l) => logMatches(l, { event: 'test' })).length).toBeGreaterThan(0);
  });
});

describe('TEST DATA 이슈 채널 선택 — 화면 규칙 (서버와 같은 표)', () => {
  it.each([
    [['incident', 'sla', 'test'], 'resolved', true, false],
    [['incident', 'sla', 'test'], 'incident', true, true],
    [['incident', 'sla'], 'incident', true, false],
    [['test'], 'resolved', true, true],
    [['incident', 'resolved'], 'resolved', false, true],
    [['test'], 'incident', false, false],
  ] as const)('%j · %s · isTest=%s → %s', (events, event, isTest, want) => {
    // 서버 규칙(server/src/alerts/deliver.ts channelWantsIncident)은 server/src/alerts/g3b.regress.test.ts가 같은 표로 검사한다
    expect(channelWantsIncident(events, event, isTest)).toBe(want);
  });
  it("'테스트 데이터 이슈' 안내는 추가 조건임을 말한다", () => {
    const hint = EVENT_OPTIONS.find((o) => o.id === 'test')!.hint;
    expect(hint).toContain('위에서 고른 이슈 이벤트');
    expect(hint).toContain('TEST DATA 이슈 알림만 받는 시연 채널');
  });
});
