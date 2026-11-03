/** 모듈 로컬 저장 미러 — localStorage 'mildo-os/*' 쓰기 가로채기 · 키별 1초 디바운스 PUT · 재시도 · 권한 · 서버 값 반영 · 해제 */
import { afterEach, describe, expect, it } from 'vitest';
import { activeMirror, clearSyncedStorage, installStorageMirror, isRetryable, readSyncedLocal, type StorageMirror } from './storageSync';
import { ApiError } from './api';

/** 메모리 Storage (Storage 인스턴스가 아닌 객체 — 미러는 객체 메서드를 감싼다) */
function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem(k: string, v: string) { m.set(k, String(v)); },
    removeItem(k: string) { m.delete(k); },
    clear() { m.clear(); },
  } as Storage;
}

/** 가짜 타이머 — 등록 순서대로, run(ms)로 시간 진행 */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: now + ms, fn }); return id; },
    clear: (h: unknown) => { q.delete(h as number); },
    async run(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = end;
    },
    size: () => q.size,
  };
}

let mirror: StorageMirror | null = null;
afterEach(() => { mirror?.uninstall(); mirror = null; });

function setup(opts: { fail?: number; failWith?: () => unknown; canWrite?: boolean; init?: Record<string, string> } = {}) {
  const storage = memStorage(opts.init);
  const timers = fakeTimers();
  const puts: [string, unknown][] = [];
  const errors: string[] = [];
  const blocked: string[] = [];
  let failsLeft = opts.fail ?? 0;
  mirror = installStorageMirror({
    storage,
    put: async (k, v) => {
      if (failsLeft > 0) { failsLeft--; throw opts.failWith ? opts.failWith() : new Error('네트워크 오류'); }
      puts.push([k, v]);
    },
    canWrite: () => opts.canWrite ?? true,
    onError: (k) => errors.push(k),
    onBlocked: (k) => blocked.push(k),
    setTimer: timers.set,
    clearTimer: timers.clear,
    retryMs: 100,
    maxRetries: 2,
  });
  return { storage, timers, puts, errors, blocked, mirror };
}

describe('localStorage 미러', () => {
  it('동기화 키 쓰기만 1초 뒤 PUT (값은 JSON 구조), 제외 키 · 다른 키는 보내지 않는다', async () => {
    const t = setup();
    t.storage.setItem('mildo-os/lab/v1', '{"criteria":{"cvr":0.03}}');
    t.storage.setItem('mildo-os/v1', '{"changes":[]}');
    t.storage.setItem('mildo-os/cloud/workspace', 'ws');
    t.storage.setItem('other', 'x');
    expect(t.storage.getItem('mildo-os/lab/v1')).toBe('{"criteria":{"cvr":0.03}}'); // 로컬 쓰기는 그대로
    await t.timers.run(999);
    expect(t.puts).toEqual([]);
    expect([...t.mirror.pendingKeys()]).toEqual(['mildo-os/lab/v1']);
    await t.timers.run(1);
    expect(t.puts).toEqual([['mildo-os/lab/v1', { criteria: { cvr: 0.03 } }]]);
  });
  it('같은 키를 연달아 쓰면 마지막 값 한 번 (키마다 따로 디바운스)', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.storage.setItem('mildo-os/watch/v1', JSON.stringify({ n: i }));
    t.storage.setItem('mildo-os/ops-v1', 'plain text');
    await t.timers.run(1000);
    expect(t.puts).toEqual([['mildo-os/watch/v1', { n: 4 }], ['mildo-os/ops-v1', { __raw: 'plain text' }]]);
  });
  it('removeItem은 value null(서버 삭제)', async () => {
    const t = setup({ init: { 'mildo-os/geo/case/v1': '{}' } });
    t.storage.removeItem('mildo-os/geo/case/v1');
    await t.timers.run(1000);
    expect(t.puts).toEqual([['mildo-os/geo/case/v1', null]]);
  });
  it('실패하면 재시도(최대 2회), 끝내 실패하면 onError', async () => {
    const ok = setup({ fail: 1 });
    ok.storage.setItem('mildo-os/lab/v1', '1');
    await ok.timers.run(1000);
    expect(ok.puts).toEqual([]);
    await ok.timers.run(100);
    expect(ok.puts).toEqual([['mildo-os/lab/v1', 1]]);
    expect(ok.errors).toEqual([]);
    ok.mirror.uninstall();
    const bad = setup({ fail: 9 });
    bad.storage.setItem('mildo-os/lab/v1', '1');
    await bad.timers.run(5000);
    expect(bad.puts).toEqual([]);
    expect(bad.errors).toEqual(['mildo-os/lab/v1']);
  });
  it('다시 보내도 같은 오류(413 크기 · 400 · 403 · 409 상한)는 재시도하지 않고 바로 onError, 5xx · 429 · 네트워크는 재시도', async () => {
    const big = setup({ fail: 9, failWith: () => new ApiError(413, 'too_large', '저장 값이 너무 큽니다 (300KB · 최대 256KB)') });
    big.storage.setItem('mildo-os/lab/v1', '1');
    await big.timers.run(1000);
    expect(big.errors).toEqual(['mildo-os/lab/v1']); // 첫 실패에서 바로
    expect(big.timers.size()).toBe(0); // 재시도 예약 없음
    big.mirror.uninstall();
    const busy = setup({ fail: 1, failWith: () => new ApiError(503, 'http_503', '서버 오류') });
    busy.storage.setItem('mildo-os/lab/v1', '2');
    await busy.timers.run(1000);
    expect(busy.errors).toEqual([]);
    await busy.timers.run(100);
    expect(busy.puts).toEqual([['mildo-os/lab/v1', 2]]);
    for (const st of [400, 403, 404, 409, 413]) expect(isRetryable(new ApiError(st, 'x', 'x')), String(st)).toBe(false);
    for (const st of [0, 408, 429, 500, 502, 503]) expect(isRetryable(new ApiError(st, 'x', 'x')), String(st)).toBe(true);
    expect(isRetryable(new Error('boom'))).toBe(true);
  });
  it('쓰기 권한이 없으면(열람자) 보내지 않고 onBlocked', async () => {
    const t = setup({ canWrite: false });
    t.storage.setItem('mildo-os/lab/v1', '{}');
    await t.timers.run(1000);
    expect(t.puts).toEqual([]);
    expect(t.blocked).toEqual(['mildo-os/lab/v1']);
  });
  it('flush: 대기 중인 쓰기를 바로 보낸다 (로그아웃 · 워크스페이스 전환 전)', async () => {
    const t = setup();
    t.storage.setItem('mildo-os/lab/v1', '{"a":1}');
    await t.mirror.flush();
    expect(t.puts).toEqual([['mildo-os/lab/v1', { a: 1 }]]);
    expect(t.timers.size()).toBe(0);
  });
  it('서버 값 반영: 미러를 거치지 않고 쓰고(다시 PUT 안 함), 서버에 없는 키는 지우고, 보내지 않은 입력은 유지', async () => {
    const t = setup({ init: { 'mildo-os/watch/v1': '{"old":1}', 'mildo-os/geo/live/v1': '[]', 'mildo-os/v1': '{"keep":1}' } });
    t.storage.setItem('mildo-os/ops-v1', '{"draft":true}'); // 아직 안 보냄
    const changed = t.mirror.applyServerState({ 'mildo-os/lab/v1': { server: 1 }, 'mildo-os/watch/v1': { old: 1 }, 'store:tf': {} });
    expect(changed.sort()).toEqual(['mildo-os/geo/live/v1', 'mildo-os/lab/v1']);
    expect(t.storage.getItem('mildo-os/lab/v1')).toBe('{"server":1}');
    expect(t.storage.getItem('mildo-os/geo/live/v1')).toBeNull();
    expect(t.storage.getItem('mildo-os/ops-v1')).toBe('{"draft":true}');
    expect(t.storage.getItem('mildo-os/v1')).toBe('{"keep":1}');
    expect(t.storage.getItem('store:tf')).toBeNull();
    await t.timers.run(1000);
    expect(t.puts).toEqual([['mildo-os/ops-v1', { draft: true }]]);
  });
  it('해제하면 원래 메서드로 돌아가고, 다시 설치하면 이전 미러는 자동 해제', async () => {
    const storage = memStorage();
    const orig = storage.setItem;
    const puts: string[] = [];
    const a = installStorageMirror({ storage, put: async (k) => { puts.push(`a:${k}`); }, debounceMs: 0 });
    const b = installStorageMirror({ storage, put: async (k) => { puts.push(`b:${k}`); }, debounceMs: 0 });
    expect(activeMirror()).toBe(b);
    storage.setItem('mildo-os/lab/v1', '1');
    await new Promise((r) => setTimeout(r, 5));
    expect(puts).toEqual(['b:mildo-os/lab/v1']);
    b.uninstall();
    a.uninstall();
    expect(storage.setItem).toBe(orig);
    expect(activeMirror()).toBeNull();
    storage.setItem('mildo-os/lab/v1', '2');
    await new Promise((r) => setTimeout(r, 5));
    expect(puts).toHaveLength(1);
  });
  it('로그아웃: 동기화 키만 지운다', () => {
    const storage = memStorage({ 'mildo-os/lab/v1': '1', 'mildo-os/watch/v1': '2', 'mildo-os/v1': '3', 'mildo-os/cloud/ai': '4', other: '5' });
    expect(Object.keys(readSyncedLocal(storage)).sort()).toEqual(['mildo-os/lab/v1', 'mildo-os/watch/v1']);
    clearSyncedStorage(storage);
    expect(Object.keys(readSyncedLocal(storage))).toEqual([]);
    expect(storage.getItem('mildo-os/v1')).toBe('3');
    expect(storage.getItem('mildo-os/cloud/ai')).toBe('4');
    expect(storage.getItem('other')).toBe('5');
  });
});
