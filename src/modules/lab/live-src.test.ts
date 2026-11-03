/**
 * 실연동(LIVE) 데이터에서의 출처 태그 (SSR) — 데이터셋에서 계산한 값은 LIVE DATA를 따르고, 데이터셋과 무관한 시연용 예시
 * (데모 테스트 카드 · 가상 이력 패턴 · 연관 검색어/AI 질의 스냅샷 · 48 진입점 데모 추정 검색량 · VisualTune 초안)는 TEST DATA로 남는다.
 * 데모 데이터셋에 실연동 메타(mode 'live')를 붙여 스토어가 LIVE 데이터로 시작하게 한다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';

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
/** 제목이 prefix로 시작하는 태그 — 한 개 이상이고 모두 TEST DATA(시연용 예시)여야 한다 */
function expectFixture(tags: Tag[], prefix: string) {
  const hit = tags.filter((t) => t.title.startsWith(prefix));
  expect(hit.length, prefix).toBeGreaterThan(0);
  for (const t of hit) {
    expect(t.label, prefix).toBe('TEST DATA');
    expect(t.tone).toBe('demo');
    expect(t.title).toContain('워크스페이스 데이터와 무관한 시연용 예시입니다');
  }
  return hit.length;
}

async function renderTab(name: string): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { useLabModel } = await import('./parts');
  const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
    DiscoverTab: () => import('./DiscoverTab'), CardsTab: () => import('./CardsTab'), ReviewTab: () => import('./ReviewTab'),
  };
  const Comp = (await loaders[name]())[name] as ComponentType<Record<string, unknown>>;
  function Harness() {
    const m = useLabModel();
    return h(Comp, { m, draft: null, onMakeCard: () => undefined, onDraftUsed: () => undefined, onOpenCards: () => undefined });
  }
  return renderToString(h(StoreProvider, null, h(Harness))).replace(/<!-- -->/g, '');
}

describe('MILDO Lab · LIVE 데이터 출처 태그', () => {
  it('데모 메타가 실연동이면 데이터 태그는 LIVE DATA', async () => {
    const { DEMO } = await import('@/data/demo');
    expect(DEMO.meta?.mode).toBe('live');
    const tags = srcTags(await renderTab('DiscoverTab'));
    expect(tags.some((t) => t.label === 'LIVE DATA')).toBe(true);
  });

  it('테스트 카드 탭: 데모 예시 카드 · 가상 이력 패턴은 TEST DATA', async () => {
    const tags = srcTags(await renderTab('CardsTab'));
    expectFixture(tags, '시연용 예시 테스트 카드 · 실제 테스트 결과 아님');
    expectFixture(tags, '가상 이력 · 실제 테스트 결과 아님');
  });

  it('발굴 탭: 연관 검색어 · AI 질의 스냅샷 · 48 진입점 데모 추정은 TEST DATA, 검색어 보고서(실측)는 LIVE DATA', async () => {
    const tags = srcTags(await renderTab('DiscoverTab'));
    expect(expectFixture(tags, '데모 스냅샷 · 실제 검색량 아님')).toBeGreaterThanOrEqual(2);
    expectFixture(tags, '검색량은 데모 추정');
  });

  it('후보 상세 태그: 스냅샷 후보는 TEST DATA, 검색어 보고서 · 48 진입점은 데이터 출처, AI 확장은 AI 해석', async () => {
    const { StoreProvider } = await import('@/core/store');
    const { CandidateSrc } = await import('./DiscoverTab');
    const one = (source: Parameters<typeof CandidateSrc>[0]['source']) => srcTags(renderToString(h(StoreProvider, null, h(CandidateSrc, { source }))));
    for (const s of ['related', 'ai_query'] as const) expectFixture(one(s), '데모 스냅샷 · 실제 검색량 아님');
    for (const s of ['search_term', 'sku48', null] as const) expect(one(s).map((t) => t.label)).toEqual(['LIVE DATA']);
    expect(renderToString(h(StoreProvider, null, h(CandidateSrc, { source: 'ai_expand' })))).toContain('AI 해석');
  });

  it('검수 탭: VisualTune 초안은 TEST DATA', async () => {
    expectFixture(srcTags(await renderTab('ReviewTab')), 'VisualTune 초안은 시연용');
  });
});
