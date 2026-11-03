/** 실시간 이벤트(SSE) 클라이언트 — 연결 · 이벤트 전달 · 끊김 → 백오프 재연결 → 놓친 변경 다시 불러오기 · 디바운스 · 구독 · 연결 표시 */
import { describe, expect, it } from 'vitest';
import { createRefetchScheduler, emitServerEvent, onServerEvent, ServerEvents, type ConnStatus } from './events';
import { connLabel } from './TopbarParts';

class FakeES {
  static all: FakeES[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.all.push(this); }
  addEventListener(t: string, fn: (e: MessageEvent) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  close() { this.closed = true; }
  emit(t: string, data?: unknown) { (this.listeners.get(t) ?? []).forEach((fn) => fn({ data: data === undefined ? '' : JSON.stringify(data) } as MessageEvent)); }
  fail() { this.onerror?.(new Event('error')); }
}

function timers() {
  const q: { fn: () => void; ms: number }[] = [];
  return { set: (fn: () => void, ms: number) => { q.push({ fn, ms }); return q.length; }, clear: () => undefined, q, fire: () => q.shift()!.fn() };
}

function setup() {
  FakeES.all = [];
  const t = timers();
  const got: string[] = [];
  const statuses: ConnStatus[] = [];
  let reconnected = 0;
  const errors: number[] = [];
  const ev = new ServerEvents({
    url: '/api/w/ws1/events',
    onEvent: (e) => got.push(`${e.type}:${e.id ?? ''}`),
    onStatus: (s) => statuses.push(s),
    onReconnected: () => { reconnected++; },
    onError: (n) => errors.push(n),
    EventSourceImpl: FakeES as never,
    setTimer: t.set,
    clearTimer: t.clear,
    rand: () => 0,
    offlineAfter: 3,
  });
  return { ev, t, got, statuses, errors, get reconnected() { return reconnected; }, es: () => FakeES.all[FakeES.all.length - 1] };
}

describe('ServerEvents', () => {
  it('hello → live, 이름 있는 이벤트를 data와 함께 전달', () => {
    const s = setup();
    s.ev.start();
    expect(s.es().url).toBe('/api/w/ws1/events');
    expect(s.statuses).toEqual(['connecting']);
    s.es().emit('hello', { ws: 'ws1' });
    expect(s.statuses.at(-1)).toBe('live');
    s.es().emit('change', { ws: 'ws1', type: 'change', id: 'chg_1', at: '2026-11-02T00:00:00Z' });
    s.es().emit('incident', { ws: 'ws1', type: 'incident', id: 'i9' });
    s.es().emit('state');
    // alerts 알림 채널 이벤트도 같은 연결로 받는다 (알림 설정 화면이 onServerEvent('notify')로 구독)
    s.es().emit('notify', { ws: 'ws1', type: 'notify', id: 'ch_1' });
    expect(s.got).toEqual(['change:chg_1', 'incident:i9', 'state:', 'notify:ch_1']);
    expect(s.ev.lastEventAt).toBeTruthy();
    expect(s.reconnected).toBe(0);
  });
  it('끊기면 닫고 백오프(1 · 2 · 4초)로 다시 연결, 연속 실패 3회부터 offline 표시, 다시 붙으면 onReconnected', () => {
    const s = setup();
    s.ev.start();
    s.es().emit('hello');
    const first = s.es();
    first.fail();
    expect(first.closed).toBe(true);
    expect(s.statuses.at(-1)).toBe('reconnecting');
    expect(s.t.q.map((x) => x.ms)).toEqual([1000]);
    s.t.fire();
    expect(FakeES.all).toHaveLength(2);
    s.es().fail();
    expect(s.t.q.map((x) => x.ms)).toEqual([2000]);
    s.t.fire();
    s.es().fail();
    expect(s.statuses.at(-1)).toBe('offline');
    expect(s.t.q.map((x) => x.ms)).toEqual([4000]);
    expect(s.errors).toEqual([1, 2, 3]);
    s.t.fire();
    s.es().emit('hello');
    expect(s.statuses.at(-1)).toBe('live');
    expect(s.reconnected).toBe(1);
    // 연결이 다시 성공하면 백오프 초기화
    s.es().fail();
    expect(s.t.q.map((x) => x.ms)).toEqual([1000]);
  });
  it('닫힌 이전 연결의 이벤트는 무시, stop 후에는 다시 연결하지 않는다', () => {
    const s = setup();
    s.ev.start();
    const first = s.es();
    first.fail();
    first.emit('change', { type: 'change', id: 'late' });
    expect(s.got).toEqual([]);
    s.ev.stop();
    expect(s.t.q).toHaveLength(1);
    s.t.fire();
    expect(FakeES.all).toHaveLength(1);
  });
  it('reconnectNow: 대기 없이 바로 새 연결', () => {
    const s = setup();
    s.ev.start();
    s.es().fail();
    s.ev.reconnectNow();
    expect(FakeES.all).toHaveLength(2);
    expect(FakeES.all[0].closed).toBe(true);
  });
  it('EventSource가 없는 환경은 offline', () => {
    const statuses: string[] = [];
    const g = globalThis as { EventSource?: unknown };
    const saved = g.EventSource;
    delete g.EventSource;
    try {
      new ServerEvents({ url: 'x', onEvent: () => undefined, onStatus: (st) => statuses.push(st) }).start();
    } finally {
      if (saved) g.EventSource = saved;
    }
    expect(statuses).toEqual(['offline']);
  });
});

describe('다시 불러오기 디바운스 (300ms)', () => {
  it('같은 대상은 마지막 뒤 한 번, 대상마다 따로', () => {
    const t = timers();
    const ran: string[] = [];
    const s = createRefetchScheduler<string>((x) => { ran.push(x); }, 300, { set: t.set, clear: (h) => { t.q.splice((h as number) - 1, 1, { fn: () => undefined, ms: -1 }); } });
    s.schedule('changes');
    s.schedule('changes');
    s.schedule('incidents');
    s.schedule('changes');
    expect(s.pending().sort()).toEqual(['changes', 'incidents']);
    expect(t.q.filter((x) => x.ms === 300)).toHaveLength(2);
    t.q.forEach((x) => x.fn());
    expect(ran.sort()).toEqual(['changes', 'incidents']);
    expect(s.pending()).toEqual([]);
  });
  it('실제 타이머: 300ms 안의 여러 이벤트 → 한 번', async () => {
    const ran: string[] = [];
    const s = createRefetchScheduler<string>((x) => { ran.push(x); }, 30);
    for (let i = 0; i < 5; i++) s.schedule('comments');
    await new Promise((r) => setTimeout(r, 80));
    expect(ran).toEqual(['comments']);
    s.schedule('dataset');
    s.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual(['comments']);
  });
});

describe('다른 화면용 구독', () => {
  it('종류별 · 전체(*) 구독, 해제', () => {
    const a: string[] = [];
    const all: string[] = [];
    const off1 = onServerEvent('connection', (e) => a.push(e.id ?? ''));
    const off2 = onServerEvent('*', (e) => all.push(e.type));
    emitServerEvent({ type: 'connection', id: 'c1' });
    emitServerEvent({ type: 'report', id: 'r1' });
    off1();
    emitServerEvent({ type: 'connection', id: 'c2' });
    off2();
    emitServerEvent({ type: 'report' });
    expect(a).toEqual(['c1']);
    expect(all).toEqual(['connection', 'report', 'connection']);
  });
});

describe('연결 표시 문구', () => {
  it('상태별 문구 · 색 · 재연결 대기 초', () => {
    expect(connLabel({ status: 'live', lastEventAt: null, attempt: 0 })).toMatchObject({ text: '실시간 연결', tone: 'good' });
    expect(connLabel({ status: 'connecting', lastEventAt: null, attempt: 0 }).text).toBe('연결 중');
    expect(connLabel({ status: 'reconnecting', lastEventAt: null, attempt: 2, retryInMs: 3900 })).toMatchObject({ text: '재연결 대기 4초', tone: 'warning' });
    expect(connLabel({ status: 'offline', lastEventAt: null, attempt: 5 })).toMatchObject({ text: '실시간 연결 끊김', tone: 'critical' });
    expect(connLabel({ status: 'offline', lastEventAt: null, attempt: 5 }).title).toMatch(/최신이 아닐 수/);
  });
});
