/**
 * MILDO Flow · 실연동(LIVE) 데이터에서의 출처 태그 (SSR) — 시연 이력(seed_flow_*) 상세의 태그는 실연동이어도 TEST DATA,
 * 실제 요청 상세에는 시연 이력 태그가 없다. 데모 데이터셋에 실연동 메타(mode 'live')를 붙여 스토어가 LIVE 데이터로 시작하게 한다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';
import { DEMO } from '@/data/demo';
import { seedChanges } from './engine';

vi.mock('@/data/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/demo')>();
  const meta = { mode: 'live', builtAt: '2026-10-31T06:30:00.000Z', sources: [{ channel: 'naver_sa', source: 'conn_live', kind: 'api', latestDate: '2026-10-31', latestHour: 15 }] };
  return { ...actual, DEMO: { ...actual.DEMO, meta } };
});

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

interface Tag { title: string; tone: string; label: string }
const srcTags = (html: string): Tag[] =>
  [...html.matchAll(/<span class="src [^"]*" title="([^"]*)" data-source="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ title: m[1], tone: m[2], label: m[3] }));

async function drawer(changes: ChangeRequest[], id: string): Promise<Tag[]> {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents: [], comments: [], role: 'PM', tf: {} });
  const { StoreProvider } = await import('@/core/store');
  const { useFlow } = await import('./useFlow');
  const { ChangeDrawer } = await import('./ChangeDrawer');
  function Harness() { return h(ChangeDrawer, { ctx: useFlow(), id, onClose: () => undefined }); }
  return srcTags(renderToString(h(StoreProvider, null, h(Harness))));
}

describe('MILDO Flow · LIVE 데이터 출처 태그', () => {
  it('시연 이력 상세: 시연 이력 태그는 TEST DATA', async () => {
    expect(DEMO.meta?.mode).toBe('live');
    const seed = seedChanges(DEMO)[0];
    const tags = await drawer([seed], seed.id);
    const fx = tags.filter((t) => t.title.startsWith('시연용 이력 · 실제 운영 이력 아님'));
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ label: 'TEST DATA', tone: 'demo' });
    expect(fx[0].title).toContain('워크스페이스 데이터와 무관한 시연용 예시입니다');
  });

  it('실제 요청 상세에는 시연 이력 태그가 없다', async () => {
    const seed = seedChanges(DEMO)[0];
    const real: ChangeRequest = { ...seed, id: 'chg_real_1' };
    const tags = await drawer([real], real.id);
    expect(tags.some((t) => t.title.startsWith('시연용 이력'))).toBe(false);
  });
});
