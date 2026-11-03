/**
 * MILDO Alert 재스캔 · 서버 모드 — 화면에서 직접 탐지하지 않고(화면의 소재 목록은 시연용 예시 DEMO_CREATIVES라 실연동 워크스페이스에
 * 예시 소재 이슈를 올리게 된다) 서버 감지(POST /api/w/:ws/alerts/scan)를 실행한다. 새 이슈는 서버가 저장하고 incident 이벤트로 들어온다.
 * 데모 모드는 그대로 화면에서 탐지해 새 이슈만 적재한다. API · 알림은 가짜로 바꿔 모은다.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Incident, Toast } from '@/core/types';
import type { WorkspaceSummary } from '@/saas/context';

const calls: { path: string; method?: string }[] = [];
let reply: () => Promise<unknown> = async () => ({ found: 0, created: 0 });
vi.mock('@/saas/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/saas/api')>();
  return { ...actual, api: vi.fn(async (path: string, o: { method?: string } = {}) => { calls.push({ path, method: o.method }); return reply(); }) };
});
const toasts: Omit<Toast, 'id'>[] = [];
const added: Incident[] = [];
vi.mock('@/core/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/store')>();
  return {
    ...actual,
    useActions: () => ({
      toast: (t: Omit<Toast, 'id'>) => { toasts.push(t); },
      addIncident: (i: Incident) => { added.push(i); },
      updateIncident: () => undefined, updateChange: () => undefined, addChange: (c: unknown) => c,
    }),
  };
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
beforeEach(() => { calls.length = 0; toasts.length = 0; added.length = 0; reply = async () => ({ found: 0, created: 0 }); });

const WS: WorkspaceSummary = { id: 'ws_1', slug: 'mildo', name: '수면밀도', brand_name: '수면밀도', status: 'active', role: 'pm', permissions: ['read', 'operate'], demoRole: 'PM' };

type AlertCtx = ReturnType<typeof import('./hooks').useAlert>;
async function alertCtx(mode: 'server' | 'demo'): Promise<AlertCtx> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const { useAlert } = await import('./hooks');
  let ctx: AlertCtx | null = null;
  function Probe() { ctx = useAlert(); return null; }
  const inner: ReactNode = h(StoreProvider, null, h(Probe));
  renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role: 'pm', workspace: WS }, children: inner }) : inner);
  if (!ctx) throw new Error('useAlert 컨텍스트 없음');
  return ctx;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MILDO Alert · 재스캔', () => {
  it('serverRescan: 서버 감지 결과를 알린다 (신규 있으면 주의 · 없으면 정상 · 경고 문구 포함)', async () => {
    const { serverRescan } = await import('./hooks');
    const seen: Omit<Toast, 'id'>[] = [];
    const call = vi.fn(async () => ({ found: 5, created: 2, warning: '데이터 기준 시각이 3시간 지났습니다' })) as unknown as typeof import('@/saas/api').api;
    expect(await serverRescan('ws_9', (t) => seen.push(t), call)).toBe(2);
    expect(call).toHaveBeenCalledWith('/api/w/ws_9/alerts/scan', expect.objectContaining({ method: 'POST' }));
    expect(seen).toEqual([expect.objectContaining({ tone: 'warning', title: '서버 재스캔 완료 · 신규 2건', route: 'alert' })]);
    expect(seen[0].body).toBe('서버 탐지 5건 중 기존 3건은 처리 이력 유지 · 데이터 기준 시각이 3시간 지났습니다');

    seen.length = 0;
    const none = vi.fn(async () => ({ found: 4, created: 0 })) as unknown as typeof import('@/saas/api').api;
    expect(await serverRescan('ws_9', (t) => seen.push(t), none)).toBe(0);
    expect(seen).toEqual([expect.objectContaining({ tone: 'good', title: '서버 재스캔 완료 · 신규 0건', body: '서버 탐지 4건 중 기존 4건은 처리 이력 유지' })]);
  });

  it('serverRescan: 실패(권한 없음 등)는 사유와 함께 알리고 0건', async () => {
    const { serverRescan } = await import('./hooks');
    const { ApiError } = await import('@/saas/api');
    const seen: Omit<Toast, 'id'>[] = [];
    const fail = vi.fn(async () => { throw new ApiError(403, 'forbidden', '이 작업을 할 권한이 없습니다'); }) as unknown as typeof import('@/saas/api').api;
    expect(await serverRescan('ws_9', (t) => seen.push(t), fail)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tone: 'critical', title: '서버 재스캔을 실행하지 못했습니다' });
    expect(seen[0].body).toContain('권한');
  });

  it('서버 모드 화면 재스캔: 서버 감지를 호출하고 화면에서 이슈를 만들지 않는다', async () => {
    reply = async () => ({ found: 3, created: 1 });
    const ctx = await alertCtx('server');
    expect(ctx.rescan()).toBe(0);
    await flush();
    expect(calls).toEqual([{ path: '/api/w/ws_1/alerts/scan', method: 'POST' }]);
    expect(added).toEqual([]);
    expect(toasts.map((t) => t.title)).toEqual(['서버 재스캔 완료 · 신규 1건']);
  });

  it('데모 모드 화면 재스캔: 그대로 화면에서 탐지해 새 이슈를 적재 (API 호출 없음)', async () => {
    const ctx = await alertCtx('demo');
    const n = ctx.rescan();
    expect(n).toBeGreaterThan(0);
    expect(added).toHaveLength(n);
    expect(calls).toEqual([]);
    expect(toasts[0].title).toBe(`재스캔 완료 · 신규 ${n}건`);
  });
});
