/**
 * 화면 렌더 스모크 테스트 (SSR) — 모든 탭 · 드로어가 데모 데이터와 빈 데이터에서 예외 없이 렌더되는지,
 * 핵심 데모 시나리오 문구가 화면에 실제로 나타나는지 확인한다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import { keywordRows, periodWindow } from './engine';

beforeAll(() => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const empty: Dataset = {
  generatedAt: '2026-10-31T15:30:00+09:00', today: '2026-10-31', currentHour: 15, dates: [],
  mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
};

async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

describe('MILDO Board 화면 렌더', () => {
  it('View: 기본 화면(최근 7일 · 01 매체 통합 성과)이 렌더되고 핵심 상태가 첫 화면에 보인다', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    expect(html).toContain('MILDO Board');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('07:00 완료');
    expect(html).toContain('MER');
    expect(html).toContain('SA_일반 제품');
    expect(html).toContain('킹 매트리스');
    expect(html).toContain('네이버 SA');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('각 탭: 데모 데이터', async () => {
    const win = periodWindow(DEMO, 'last7');
    const { MediaTab } = await import('./MediaTab');
    const { KeywordTab, KeywordDrawer } = await import('./KeywordTab');
    const { PacingTab } = await import('./PacingTab');
    const { SalesTab } = await import('./SalesTab');
    const { HourlyTab } = await import('./HourlyTab');
    const { DataTab } = await import('./DataTab');
    const media = await wrap(h(MediaTab, { d: DEMO, win }));
    expect(media).toContain('판단 지표');
    const kw = await wrap(h(KeywordTab, { d: DEMO }));
    expect(kw).toContain('랜딩 옵션 품절');
    expect(kw).toContain('CPC 급변');
    const pace = await wrap(h(PacingTab, { d: DEMO }));
    expect(pace).toContain('피크 전 소진');
    expect(pace).toContain('Meta_넓은 타겟');
    const sales = await wrap(h(SalesTab, { d: DEMO, win }));
    expect(sales).toContain('네이버 브랜드스토어');
    const hourly = await wrap(h(HourlyTab, { d: DEMO }));
    expect(hourly).toContain('전환 효율 지수');
    expect(hourly).toContain('board-heat-grid');
    expect(hourly).toContain('상위 3개 슬롯');
    expect((hourly.match(/<td /g) ?? []).length).toBeGreaterThanOrEqual(7 * 24);
    expect(hourly).not.toMatch(/#[0-9a-fA-F]{6}/);
    const data = await wrap(h(DataTab, { d: DEMO, incidents: [] }));
    expect(data).toContain('추적 단절 의심');
    expect(data).toContain('자동충전 실패');
    expect(data).toContain('p_main:k');
    expect(data).toContain('비실명 권한');
    expect(data).toContain('agency-shared@');
    for (const html of [media, kw, pace, sales, hourly, data]) expect(html).not.toMatch(/NaN|undefined/);
    const row = keywordRows(DEMO).find((r) => r.text === '매트리스 추천')!;
    const drawer = await wrap(h(KeywordDrawer, { row, onClose: () => undefined }));
    expect(drawer).toContain('최근 3일 CPC');
    expect(drawer).toContain('최근 14일 vs 직전 14일');
    // 판정 시각과 표시 시각 일치
    expect(pace).toContain('20:22');
    expect(pace).toContain('18:06');
    expect(pace).not.toContain('selectors.');
  });

  it('수집 배치 전(06:30)에는 "07:00 완료"를 표시하지 않는다', async () => {
    const { PipelineStrip } = await import('./DataTab');
    const { generateDemoData } = await import('@/data/demo');
    const early = generateDemoData('2026-10-31', 6);
    const html = await wrap(h(PipelineStrip, { d: early, mer: 4, merLabel: '최근 7일', onOpen: () => undefined }));
    expect(html).toContain('07:00 예정');
    expect(html).not.toContain('07:00 완료');
    const emptyHtml = await wrap(h(PipelineStrip, { d: empty, mer: NaN, merLabel: '최근 7일', onOpen: () => undefined }));
    expect(emptyHtml).not.toContain('07:00 완료');
    expect(emptyHtml).toContain('전일분 누락');
  });

  it('각 탭: 빈 데이터에서도 예외 없음', async () => {
    const win = periodWindow(empty, 'last7');
    const { MediaTab } = await import('./MediaTab');
    const { KeywordTab } = await import('./KeywordTab');
    const { PacingTab } = await import('./PacingTab');
    const { SalesTab } = await import('./SalesTab');
    const { HourlyTab } = await import('./HourlyTab');
    const { DataTab, PipelineStrip } = await import('./DataTab');
    for (const node of [
      h(MediaTab, { d: empty, win }), h(KeywordTab, { d: empty }), h(PacingTab, { d: empty }), h(SalesTab, { d: empty, win }),
      h(HourlyTab, { d: empty }), h(DataTab, { d: empty, incidents: [] }), h(PipelineStrip, { d: empty, mer: NaN, merLabel: '최근 7일', onOpen: () => undefined }),
    ]) {
      const html = await wrap(node);
      expect(html.length).toBeGreaterThan(100);
      expect(html).not.toMatch(/NaN|undefined/);
    }
  });
});
