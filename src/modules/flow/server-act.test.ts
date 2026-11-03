/**
 * MILDO Flow 서버 모드 액션 — 반영 · 롤백은 서버가 판정하므로 화면은 '요청을 보냈다'만 알리고(낙관적 '반영했습니다 · 롤백 가능' 없음),
 * 시연 이력 자동 적재는 데모 모드에서만, 셸의 서버 모드 CSS 가림(역할 전환 숨김)은 화면이 직접 읽기 전용으로 그리므로 없어야 한다.
 * 알림은 useActions만 가짜로 바꿔 모은다 (스토어 상태 · 권한 · 실행 점검은 실제 그대로).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest, Toast } from '@/core/types';
import { DEMO } from '@/data/demo';
import { canRollback, executionCheck, seedChanges } from './engine';
import type { FlowCtx } from './useFlow';

const toasts: Omit<Toast, 'id'>[] = [];
const updates: { id: string; patch: Partial<ChangeRequest>; action: string }[] = [];
vi.mock('@/core/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/store')>();
  return {
    ...actual,
    useActions: () => ({
      toast: (t: Omit<Toast, 'id'>) => { toasts.push(t); },
      updateChange: (id: string, patch: Partial<ChangeRequest>, action: string) => { updates.push({ id, patch, action }); },
      addChange: (c: ChangeRequest) => c,
      addIncident: () => undefined,
      updateIncident: () => undefined,
    }),
  };
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
beforeEach(() => { toasts.length = 0; updates.length = 0; });

const SEEDS = seedChanges(DEMO);
/** PM이 처리할 수 있고 실행 점검을 통과하는 승인 완료 건 */
const APPROVED: ChangeRequest = (() => {
  const c = SEEDS.map((s) => ({ ...s, id: `srv_${s.id}`, approver: 'PM' as const, status: 'approved' as const })).find((s) => executionCheck(DEMO, [s], [], s).ok);
  if (!c) throw new Error('실행 점검을 통과하는 시연 이력이 없습니다');
  return c;
})();
const APPLIED: ChangeRequest = { ...APPROVED, id: 'srv_applied_1', status: 'applied' };

function setStore(changes: ChangeRequest[]) {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents: [], comments: [], ai: { mode: 'offline' }, role: 'PM', tf: {} });
}

/** useFlow 컨텍스트를 SSR로 한 번 그려서 꺼낸다 (mode = 화면이 읽는 SaaS 모드) */
async function flowCtx(mode: 'server' | 'demo'): Promise<FlowCtx> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const { useFlow } = await import('./useFlow');
  let ctx: FlowCtx | null = null;
  function Probe() { ctx = useFlow(); return null; }
  const inner: ReactNode = h(StoreProvider, null, h(Probe));
  renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role: 'pm' }, children: inner }) : inner);
  if (!ctx) throw new Error('useFlow 컨텍스트 없음');
  return ctx;
}

describe('MILDO Flow · 서버 모드 반영 · 롤백 알림', () => {
  it('반영: 서버 모드는 "반영 요청을 보냈습니다"(낙관적 반영 완료 · 롤백 가능 문구 없음), 데모 모드는 그대로 "반영했습니다 · 롤백 가능"', async () => {
    expect(canRollback([APPLIED], APPLIED).ok).toBe(true);
    setStore([APPROVED]);
    const server = await flowCtx('server');
    expect(server.server).toBe(true);
    expect(server.act(APPROVED, 'apply')).toBe(true);
    expect(updates).toEqual([expect.objectContaining({ id: APPROVED.id, patch: { status: 'applied' }, action: '반영' })]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'info', title: '반영 요청을 보냈습니다', route: 'flow' });
    expect(toasts[0].body).toContain(APPROVED.target);
    expect(toasts[0].body).toContain('결과는 이어서 알립니다');
    expect(toasts[0].body).not.toContain('롤백 가능');
    expect(toasts.some((t) => t.title === '반영했습니다')).toBe(false);

    toasts.length = 0;
    const demo = await flowCtx('demo');
    expect(demo.server).toBe(false);
    expect(demo.act(APPROVED, 'apply')).toBe(true);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'good', title: '반영했습니다' })]);
    expect(toasts[0].body).toContain('롤백 가능');
  });

  it('롤백: 서버 모드는 "롤백 요청을 보냈습니다", 데모 모드는 "롤백했습니다"', async () => {
    setStore([APPLIED]);
    const server = await flowCtx('server');
    expect(server.act(APPLIED, 'rollback')).toBe(true);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'info', title: '롤백 요청을 보냈습니다', route: 'flow' })]);
    toasts.length = 0;
    const demo = await flowCtx('demo');
    expect(demo.act(APPLIED, 'rollback')).toBe(true);
    expect(toasts).toEqual([expect.objectContaining({ title: '롤백했습니다' })]);
  });

  it('일괄 반영: 서버 모드 요약은 "일괄 반영 요청", 데모 모드는 "일괄 반영" (건별 알림은 생략)', async () => {
    setStore([APPROVED]);
    const server = await flowCtx('server');
    expect(server.bulk([APPROVED], 'apply')).toBe(1);
    expect(toasts.map((t) => t.title)).toEqual(['일괄 반영 요청 1/1건']);
    expect(updates).toEqual([expect.objectContaining({ action: '일괄 반영' })]);
    toasts.length = 0;
    const demo = await flowCtx('demo');
    expect(demo.bulk([APPROVED], 'apply')).toBe(1);
    expect(toasts.map((t) => t.title)).toEqual(['일괄 반영 1/1건']);
  });

  it('실행 점검 보류 · 권한 밖은 두 모드 모두 같은 경고 (서버 모드도 보낼 수 없는 건은 막는다)', async () => {
    const pending: ChangeRequest = { ...APPROVED, id: 'srv_pending', status: 'pending' };
    setStore([pending]);
    const server = await flowCtx('server');
    expect(server.act(pending, 'apply')).toBe(false);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'warning', title: '승인된 건만 반영할 수 있습니다' })]);
    expect(updates).toEqual([]);
  });
});

describe('MILDO Flow · 시연 이력 자동 적재', () => {
  it('서버 모드는 적재하지 않고(세션 1회 기회도 쓰지 않음), 데모 모드는 세션당 한 번만 적재', async () => {
    const { autoLoadSeeds } = await import('./useFlow');
    const load = vi.fn(() => 7);
    expect(autoLoadSeeds(true, load)).toBe(0);
    expect(autoLoadSeeds(true, load)).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(autoLoadSeeds(false, load)).toBe(7);
    expect(autoLoadSeeds(false, load)).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('셸 CSS · 서버 모드 역할 전환 가림 제거', () => {
  it('app.css에 Flow · 리포트 역할 전환을 숨기던 서버 모드 규칙이 없다 (화면이 직접 읽기 전용으로 그린다)', () => {
    const css = readFileSync(join(__dirname, '../../styles/app.css'), 'utf8');
    expect(css).not.toMatch(/data-saas=['"]?server['"]?\]\s*\.flow-role/);
    expect(css).not.toMatch(/aria-label=['"]?작성 역할/);
    expect(css).not.toMatch(/aria-label=['"]?현재 역할/);
  });
});
