/**
 * 리포트 · 실연동(LIVE) 데이터에서의 출처 표기 (SSR) — 리포트 수치 태그와 인쇄본 머리말은 데이터 출처(LIVE DATA)를 따르고,
 * 시연용 예시 이력(최근 피드백 반영 이력 FEEDBACK_HISTORY)은 실연동이어도 TEST DATA로 남는다.
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

async function renderView(): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const View = (await import('./View')).default as ComponentType;
  return renderToString(h(StoreProvider, null, h(View))).replace(/<!-- -->/g, '');
}

describe('리포트 · LIVE 데이터 출처 표기', () => {
  it('최근 피드백 반영 이력(시연용 예시)은 TEST DATA, 리포트 수치 태그는 LIVE DATA', async () => {
    const tags = srcTags(await renderView());
    const hist = tags.filter((t) => t.title.startsWith('시연용 예시 이력 · 실제 피드백 이력 아님'));
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ label: 'TEST DATA', tone: 'demo' });
    expect(tags.filter((t) => t.label === 'LIVE DATA').length).toBeGreaterThanOrEqual(2);
  });

  it('인쇄본 머리말은 데이터 출처를 따른다 (LIVE에서 TEST DATA로 찍지 않는다)', async () => {
    const html = await renderView();
    expect(html).toMatch(/reports-print-only">[^<]*MILDO OS 자동 리포트 · LIVE DATA \(매체 · 판매 채널 실연동 데이터\)</);
    expect(html).not.toContain('TEST DATA (시연용 테스트 데이터)');
  });
});
