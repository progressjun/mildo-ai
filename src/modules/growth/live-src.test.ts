/**
 * 실연동(LIVE) 데이터에서의 출처 태그 (SSR) — 신규 매체 후보 점수(1~5)는 데모 평가라 워크스페이스 데이터가 실연동이어도
 * TEST DATA로 남고, 데이터셋에서 계산한 코프로모션 검색 수요 · 파일럿 계산은 LIVE DATA를 따른다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';

vi.mock('@/data/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/demo')>();
  const meta = { mode: 'live', builtAt: '2026-10-31T06:30:00.000Z', sources: [{ channel: 'naver_sa', source: 'conn_live', kind: 'api', latestDate: '2026-10-31', latestHour: 15 }] };
  return { ...actual, DEMO: { ...actual.DEMO, meta } };
});

beforeAll(() => {
  const mem: Record<string, string> = {};
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

describe('매출 성장 · LIVE 데이터 출처 태그', () => {
  it('신규 매체 발굴: 후보 점수(데모 평가)는 TEST DATA, 검색 수요 · 파일럿 계산은 LIVE DATA', async () => {
    expect(DEMO.meta?.mode).toBe('live');
    const { StoreProvider } = await import('@/core/store');
    const { DemandTab } = await import('./DemandTab');
    const tags = srcTags(renderToString(h(StoreProvider, null, h(DemandTab, { d: DEMO, marginalRoas: 3.2 }))));
    const scores = tags.filter((t) => t.title.startsWith('후보 점수는 데모 평가'));
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ label: 'TEST DATA', tone: 'demo' });
    expect(scores[0].title).toContain('워크스페이스 데이터와 무관한 시연용 예시입니다');
    expect(tags.filter((t) => t.label === 'LIVE DATA').length).toBeGreaterThanOrEqual(2);
  });
});
