/**
 * AD Pilot · GFA 탭 (SSR) — 실연동(LIVE) 데이터에서도 시연용 가정 계정 카드는 TEST DATA로 남고 실제 계정 카드는 LIVE DATA,
 * 서버 모드에서는 '상단 바의 역할 선택' 안내 대신 멤버십 역할 기준 안내(서버 모드에는 역할 선택이 없다).
 * 데모 데이터셋에 실연동 메타(mode 'live')를 붙여 스토어가 LIVE 데이터로 시작하게 한다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

vi.mock('@/data/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/demo')>();
  const meta = { mode: 'live', builtAt: '2026-10-31T06:30:00.000Z', sources: [{ channel: 'naver_gfa', source: 'csv:up_1', kind: 'csv', latestDate: '2026-10-31', latestHour: 15 }] };
  return { ...actual, DEMO: { ...actual.DEMO, meta } };
});

beforeAll(() => {
  const mem: Record<string, string> = { 'mildo-os/v1': JSON.stringify({ changes: [], incidents: [], role: 'PM' }) };
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

async function renderGfa(mode: 'server' | 'demo' = 'demo'): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const { useAdPilot } = await import('./useAdPilot');
  const { GfaTab } = await import('./GfaTab');
  function Harness() { return h(GfaTab, { ap: useAdPilot() }); }
  const inner: ReactNode = h(StoreProvider, null, h(Harness));
  return renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role: 'pm' }, children: inner }) : inner).replace(/<!-- -->/g, '');
}

describe('AD Pilot · GFA 탭', () => {
  it('LIVE 데이터: 시연용 가정 계정 카드는 TEST DATA, 데이터셋 계정 카드는 LIVE DATA', async () => {
    const { useAdPilot } = await import('./useAdPilot');
    const { StoreProvider } = await import('@/core/store');
    let demoAccounts = 0;
    let realAccounts = 0;
    function Count() { const ap = useAdPilot(); demoAccounts = ap.gfa.filter((v) => v.demo).length; realAccounts = ap.gfa.length - demoAccounts; return null; }
    renderToString(h(StoreProvider, null, h(Count)));
    expect(demoAccounts).toBeGreaterThan(0);
    expect(realAccounts).toBeGreaterThan(0);

    const tags = srcTags(await renderGfa());
    const fixture = tags.filter((t) => t.title.startsWith('시연용 가정 계정 · 실제 계정 아님'));
    expect(fixture).toHaveLength(demoAccounts);
    expect(fixture.every((t) => t.label === 'TEST DATA' && t.tone === 'demo')).toBe(true);
    expect(tags.filter((t) => t.label === 'LIVE DATA').length).toBeGreaterThanOrEqual(realAccounts);
  });

  it('서버 모드: 승인 권한 안내는 멤버십 역할 기준 (상단 바 역할 선택 안내 없음), 데모 모드는 그대로', async () => {
    const server = await renderGfa('server');
    expect(server).toContain('승인 권한은 로그인 계정의 멤버십 역할로 정해지고 서버가 최종 판정합니다 — 역할은 팀 · 권한에서 관리자가 바꿉니다.');
    expect(server).not.toContain('상단 바의 역할 선택');
    const demo = await renderGfa('demo');
    expect(demo).toContain('역할 전환은 상단 바의 역할 선택에서 합니다 (승인 권한 시연).');
    expect(demo).not.toContain('멤버십 역할로 정해지고');
  });
});
