/**
 * 화면 렌더 스모크 테스트 (SSR) — 데모 이슈를 적재한 상태로 모든 탭 · 드로어가 예외 없이 렌더되는지 확인.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import type { Incident } from '@/core/types';
import { DEMO } from '@/data/demo';
import { detectIncidents, detectTestIncidents } from './engine';

/** 다른 모듈(MILDO Watch 등)이 만든 최소 필드 이슈도 렌더되어야 한다 */
const foreign: Incident = {
  id: 'watch:경쟁사 가격:2026-10-31', ruleId: 'competitor_price', severity: 'P3', title: '경쟁사 가격 · 프로모션 변경', target: '베스트슬립',
  detectedAt: '2026-10-31T11:00:00.000Z', occurredAt: '2026-10-31T10:00:00.000Z', detectPath: 'MILDO Watch', causeCandidates: ['가격 · 프로모션 변경 — 경쟁사 기획전'],
  impact: {}, status: 'ack', timeline: [{ at: '2026-10-31T11:00:00.000Z', by: 'MILDO Watch', action: 'P3 생성' }], isTest: false, autoActions: [],
};
const seeded = [...detectIncidents(DEMO), ...detectTestIncidents(DEMO, 'ad_off', { seq: 1 }), foreign];

beforeAll(() => {
  const mem: Record<string, string> = { 'mildo-os/v1': JSON.stringify({ incidents: seeded, changes: [], role: 'PM' }) };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

async function render(name: string, extra: Record<string, unknown> = {}) {
  const { StoreProvider } = await import('@/core/store');
  const { useAlert } = await import('./hooks');
  const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
    QueueTab: () => import('./QueueTab'), NotifyTab: () => import('./NotifyTab'), AnomalyTab: () => import('./AnomalyTab'), RulesTab: () => import('./RulesTab'),
    HolidayTab: () => import('./HolidayTab'), AccountsTab: () => import('./AccountsTab'), SlaTab: () => import('./SlaTab'), IncidentDrawer: () => import('./IncidentDrawer'),
  };
  const Tab = (await loaders[name]())[name] as ComponentType<Record<string, unknown>>;
  function Harness() {
    const ctx = useAlert();
    return h(Tab, { ctx, onOpen: () => undefined, onClose: () => undefined, ...extra });
  }
  return renderToString(h(StoreProvider, null, h(Harness)));
}

describe('MILDO Alert 화면 렌더', () => {
  it('기본 화면(View) — 안전망 스트립 · 이슈 큐', async () => {
    const { StoreProvider } = await import('@/core/store');
    const View = (await import('./View')).default;
    const html = renderToString(h(StoreProvider, null, h(View)));
    expect(html).toContain('MILDO Alert');
    expect(html).toContain('5단계 안전망');
    expect(html).toContain('전환 추적 단절');
    expect(html).toContain('TEST DATA');
  });
  it.each(['QueueTab', 'NotifyTab', 'AnomalyTab', 'RulesTab', 'HolidayTab', 'AccountsTab', 'SlaTab'])('%s', async (name) => {
    const html = await render(name);
    expect(html.length).toBeGreaterThan(1000);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });
  it('이슈 상세 드로어 — 근거 · 원인 · 영향 · 보고서 · 타임라인', async () => {
    for (const inc of seeded) {
      const html = await render('IncidentDrawer', { id: inc.id });
      expect(html).toContain('감지 근거 수치');
      expect(html).toContain('원인 후보');
      expect(html).not.toContain('undefined');
      expect(html).toContain('이슈 보고서');
      expect(html).not.toContain('NaN');
    }
  });
});
