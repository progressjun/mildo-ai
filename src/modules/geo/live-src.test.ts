/**
 * 실연동(LIVE) 데이터에서의 출처 태그 (SSR) — GEO 진단 수치는 데모 진단 스냅샷(buildGeoSnapshot)이라 워크스페이스 데이터가
 * 실연동이어도 TEST DATA로 남고, 데이터셋에서 계산한 값(판매 데이터 대조 등)은 LIVE DATA를 따른다.
 * 데모 데이터셋에 실연동 메타(mode 'live')를 붙여 스토어가 LIVE 데이터로 시작하게 한다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import { auditHtml, buildGeoSnapshot, demoCaseFromSnapshot, EMPTY_CASE, sampleProductHtml, visibilitySummary } from './engine';

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
function expectFixture(tags: Tag[], prefix: string): number {
  const hit = tags.filter((t) => t.title.startsWith(prefix));
  expect(hit.length, prefix).toBeGreaterThan(0);
  for (const t of hit) expect([t.label, t.tone], prefix).toEqual(['TEST DATA', 'demo']);
  return hit.length;
}
const hasLive = (tags: Tag[]) => tags.some((t) => t.label === 'LIVE DATA');
async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

const SNAP_TITLE = '데모 진단 스냅샷 · 실제 엔진 응답 아님';

describe('SearchTuneOS · LIVE 데이터 출처 태그', () => {
  it('첫 화면: 핵심 지표(스냅샷)는 TEST DATA, 머리말 데이터 태그는 LIVE DATA', async () => {
    expect(DEMO.meta?.mode).toBe('live');
    const View = (await import('./View')).default as ComponentType;
    const tags = srcTags(await wrap(h(View)));
    expect(hasLive(tags)).toBe(true);
    // 핵심 지표 카드 + 진단 탭(기본 탭)의 매트릭스 · 추이 · 경쟁 · 인용 · 의도 · 반복 패턴 카드
    expect(expectFixture(tags, SNAP_TITLE)).toBeGreaterThanOrEqual(7);
  });

  it('진단 탭: 스냅샷에서 나온 카드는 모두 TEST DATA (데이터 출처 태그 없음)', async () => {
    const { MonitorTab } = await import('./MonitorTab');
    const snap = buildGeoSnapshot(DEMO.today);
    const vis = visibilitySummary(snap);
    const tags = srcTags(await wrap(h(MonitorTab, { snap, vis, roundIndex: 3, onRound: () => undefined, live: [], latest: {}, onLive: () => undefined, onClearLive: () => undefined })));
    const demoTags = tags.filter((t) => t.label !== 'AI 해석');
    expect(demoTags.length).toBeGreaterThanOrEqual(7);
    expect(demoTags.every((t) => t.title.startsWith(SNAP_TITLE) && t.label === 'TEST DATA')).toBe(true);
  });

  it('진단 전후: 데모 값으로 채운 사례 · 정기 진단 기록 형식은 TEST DATA', async () => {
    const { CaseTab } = await import('./CaseTab');
    const snap = buildGeoSnapshot(DEMO.today);
    const filled = srcTags(await wrap(h(CaseTab, { value: demoCaseFromSnapshot(snap), onChange: () => undefined, snap })));
    expectFixture(filled, '데모 스냅샷으로 채운 값 · 실제 집행 수치 아님');
    expectFixture(filled, SNAP_TITLE);
    // 직접 입력(데모 값 아님)이면 사례 카드의 데모 태그가 없다 — 기록 형식(스냅샷)만
    const typed = srcTags(await wrap(h(CaseTab, { value: EMPTY_CASE, onChange: () => undefined, snap })));
    expect(typed.some((t) => t.title.startsWith('데모 스냅샷으로 채운 값'))).toBe(false);
    expectFixture(typed, SNAP_TITLE);
  });

  it('제품페이지 진단: 샘플 HTML 진단은 TEST DATA(실제 제품페이지 아님), 판매 데이터 대조는 LIVE DATA', async () => {
    const { AuditTab } = await import('./AuditTab');
    const html = sampleProductHtml(DEMO, 'defect');
    const audit = auditHtml(html, DEMO);
    const sample = srcTags(await wrap(h(AuditTab, { d: DEMO, html, onHtml: () => undefined, audit, sampleKind: 'defect', onSample: () => undefined })));
    expect(expectFixture(sample, '샘플 HTML은 시연용 예시 페이지 · 실제 제품페이지 아님')).toBe(2);
    expect(hasLive(sample)).toBe(true);
    // 붙여넣은 HTML(실제 페이지)이면 샘플 태그가 없다
    const custom = srcTags(await wrap(h(AuditTab, { d: DEMO, html, onHtml: () => undefined, audit, sampleKind: 'custom', onSample: () => undefined })));
    expect(custom.some((t) => t.title.startsWith('샘플 HTML'))).toBe(false);
  });
});
