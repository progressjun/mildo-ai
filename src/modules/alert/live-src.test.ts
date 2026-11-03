/**
 * MILDO Alert · 실연동(LIVE) 데이터에서의 출처 태그 (SSR) — 시연용 예시 소재 목록(DEMO_CREATIVES)에서 나온 점검 행 · 규칙 점검 대상과
 * 월간 SLA 리포트의 지난 이력(SLA_HISTORY)은 워크스페이스 데이터가 실연동이어도 TEST DATA로 남고, 데이터셋에서 계산한 값은 LIVE DATA.
 * 데모 데이터셋에 실연동 메타(mode 'live')를 붙여 스토어가 LIVE 데이터로 시작하게 한다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import { DEMO_CREATIVES, type CreativeReview } from './data';
import { holidayPrecheck, offBlocks } from './engine';

vi.mock('@/data/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/demo')>();
  const meta = { mode: 'live', builtAt: '2026-10-31T06:30:00.000Z', sources: [{ channel: 'naver_sa', source: 'conn_live', kind: 'api', latestDate: '2026-10-31', latestHour: 15 }] };
  return { ...actual, DEMO: { ...actual.DEMO, meta } };
});

beforeAll(() => {
  const mem: Record<string, string> = { 'mildo-os/v1': JSON.stringify({ incidents: [], changes: [], role: 'PM' }) };
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
function fixtures(tags: Tag[], prefix: string): Tag[] {
  const hit = tags.filter((t) => t.title.startsWith(prefix));
  for (const t of hit) {
    expect([t.label, t.tone], prefix).toEqual(['TEST DATA', 'demo']);
    expect(t.title).toContain('워크스페이스 데이터와 무관한 시연용 예시입니다');
  }
  return hit;
}

async function render(name: string): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { useAlert } = await import('./hooks');
  const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
    RulesTab: () => import('./RulesTab'), HolidayTab: () => import('./HolidayTab'), SlaTab: () => import('./SlaTab'),
  };
  const Tab = (await loaders[name]())[name] as ComponentType<Record<string, unknown>>;
  function Harness() { return h(Tab, { ctx: useAlert(), onOpen: () => undefined }); }
  return renderToString(h(StoreProvider, null, h(Harness))).replace(/<!-- -->/g, '');
}

/** 예시 소재 목록에서 사전 점검 항목이 되는 소재 (반려 · 검수 대기 · 랜딩 오류) */
const CREATIVE_ITEMS = DEMO_CREATIVES.filter((c) => c.status !== 'approved').length + DEMO_CREATIVES.filter((c) => c.landingStatus >= 400).length;

describe('MILDO Alert · 시연용 예시 소재 · 지난 이력 출처', () => {
  it('엔진: 소재 목록을 넘기지 않으면(시연용 예시 소재) 소재 점검 항목에 fixture 표시, 실제 소재 목록을 넘기면 없음', () => {
    expect(CREATIVE_ITEMS).toBeGreaterThan(0);
    const block = offBlocks(DEMO.today, 30)[0];
    expect(block).toBeTruthy();
    const demo = holidayPrecheck(DEMO, block);
    const creativeRows = demo.items.filter((i) => i.fixture);
    expect(creativeRows).toHaveLength(CREATIVE_ITEMS);
    expect(creativeRows.every((i) => i.group === '소재')).toBe(true);
    // 품절 랜딩 · 가격 불일치(데이터셋에서 계산)는 소재 그룹이어도 fixture가 아니다
    expect(demo.items.filter((i) => i.group === '소재' && !i.fixture).length).toBeGreaterThan(0);
    expect(demo.items.filter((i) => i.group !== '소재').every((i) => !i.fixture)).toBe(true);

    const real: CreativeReview[] = DEMO_CREATIVES.map((c) => ({ ...c, id: `real_${c.id}` }));
    const live = holidayPrecheck(DEMO, block, { creatives: real });
    expect(live.items.filter((i) => i.group === '소재').length).toBe(demo.items.filter((i) => i.group === '소재').length);
    expect(live.items.some((i) => i.fixture)).toBe(false);
  });

  it('연휴 전날 사전 점검: 예시 소재 행은 TEST DATA, 점검 카드(데이터셋 계산)는 LIVE DATA', async () => {
    expect(DEMO.meta?.mode).toBe('live');
    const tags = srcTags(await render('HolidayTab'));
    expect(fixtures(tags, '시연용 예시 소재 · 매체 소재 검수 연동 전')).toHaveLength(CREATIVE_ITEMS);
    expect(tags.some((t) => t.label === 'LIVE DATA')).toBe(true);
  });

  it('규칙 엔진 가동 현황: 소재 검수 · 랜딩 규칙의 점검 대상(예시 소재 목록)은 TEST DATA', async () => {
    const tags = srcTags(await render('RulesTab'));
    expect(fixtures(tags, '시연용 예시 소재 목록 · 매체 소재 검수 연동 전')).toHaveLength(3);
    expect(tags.some((t) => t.label === 'LIVE DATA')).toBe(true);
  });

  it('월간 SLA 리포트: 지난 이력(10월 예시)이 들어간 지표 · 표 · 차트는 TEST DATA', async () => {
    const tags = srcTags(await render('SlaTab'));
    // 지표 5개 + 월간 리포트 + 등급별 달성률 차트
    expect(fixtures(tags, '지난 이력(10월)은 시연용 예시').length).toBeGreaterThanOrEqual(7);
  });
});
