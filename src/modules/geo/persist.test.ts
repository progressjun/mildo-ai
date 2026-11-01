import { afterEach, describe, expect, it } from 'vitest';
import { clearGeoLocal, loadCase, loadLive, onGeoReset, saveCase, saveLive } from './persist';
import { EMPTY_CASE, type LiveRecord } from './engine';

/** vitest(node)에는 localStorage가 없어 메모리 대체본을 붙인다 */
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
} as Storage;

const rec: LiveRecord = { queryId: 'q01', query: '퀸 매트리스 추천', at: '2026-10-31T06:30:00.000Z', backend: 'artifact', mentioned: true, position: 1, order: ['수면밀도'], competitors: [], citations: [], chars: 10, excerpt: '수면밀도' } as unknown as LiveRecord;

describe('GEO 로컬 저장 · 시연 상태 초기화', () => {
  afterEach(() => mem.clear());

  it('clearGeoLocal: 라이브 기록 · 진단 전후 입력을 지우고 열린 화면에 알린다', () => {
    saveLive([rec]);
    saveCase({ ...EMPTY_CASE, brand: '수면밀도', beforeRate: 30 });
    expect(loadLive()).toHaveLength(1);
    expect(loadCase().brand).toBe('수면밀도');
    let notified = 0;
    const off = onGeoReset(() => { notified += 1; });
    clearGeoLocal();
    expect(loadLive()).toEqual([]);
    expect(loadCase()).toMatchObject({ brand: '', beforeRate: null });
    expect(notified).toBe(1);
    off();
    clearGeoLocal();
    expect(notified).toBe(1);
  });
});
