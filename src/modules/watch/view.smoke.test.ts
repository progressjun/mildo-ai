/**
 * 화면 렌더 스모크 테스트 (SSR) — 모든 탭 · 모든 이벤트 상세 드로어가 예외 · NaN 없이 렌더되는지 확인.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import { archiveRows, buildEvents, competitorIncident } from './engine';

beforeAll(() => {
  const inc = competitorIncident(archiveRows(DEMO).find((r) => r.id === 'ar12')!, DEMO);
  const mem: Record<string, string> = { 'mildo-os/v1': JSON.stringify({ incidents: [inc], changes: [], role: 'PM' }) };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

async function renderTab(name: string, extra: Record<string, unknown> = {}) {
  const { StoreProvider } = await import('@/core/store');
  const { useWatch } = await import('./hooks');
  const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
    TrackingTab: () => import('./TrackingTab'), ArchiveTab: () => import('./ArchiveTab'), SerpTab: () => import('./SerpTab'),
    ExternalTab: () => import('./ExternalTab'), BriefTab: () => import('./BriefTab'), EventDrawer: () => import('./EventDrawer'),
  };
  const Comp = (await loaders[name]())[name] as ComponentType<Record<string, unknown>>;
  function Harness() {
    const w = useWatch();
    return h(Comp, { w, onOpen: () => undefined, onClose: () => undefined, ...extra });
  }
  return renderToString(h(StoreProvider, null, h(Harness)));
}

const clean = (html: string) => {
  expect(html).not.toMatch(/NaN|undefined|Infinity/);
};

describe('MILDO Watch 화면 렌더', () => {
  it('기본 화면(View) — 블랙 패널 파이프라인 · 트래킹 표 · 이벤트 피드', async () => {
    const { StoreProvider } = await import('@/core/store');
    const View = (await import('./View')).default;
    const html = renderToString(h(StoreProvider, null, h(View)));
    expect(html).toContain('MILDO Watch');
    expect(html).toContain('24시간 내 영향 진단');
    expect(html).toContain('잠재고객 확장(Beta)');
    expect(html).toContain('매트리스 추천');
    expect(html).toContain('TEST DATA');
    clean(html);
  });

  it.each(['TrackingTab', 'ArchiveTab', 'SerpTab', 'ExternalTab', 'BriefTab'])('%s', async (name) => {
    const html = await renderTab(name);
    expect(html.length).toBeGreaterThan(1500);
    clean(html);
  });

  it('아카이브 — 6개사 매트릭스 · Alert P3 생성됨 표시', async () => {
    const html = await renderTab('ArchiveTab');
    for (const c of ['베스트슬립', '웰퍼니처', '퀵슬립', '올라인매트리스', '지누스', '휴도']) expect(html).toContain(c);
    expect(html).toContain('Alert P3 생성됨');
    expect(html).toContain('변경 즉시 알림');
  });

  it.each(buildEvents(DEMO).map((e) => e.id))('이벤트 상세 드로어 %s', async (id) => {
    const html = await renderTab('EventDrawer', { id });
    expect(html).toContain('24시간 내 영향 진단');
    clean(html);
  });
});
