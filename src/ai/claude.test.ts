import { afterEach, describe, expect, it, vi } from 'vitest';

type Opts = Record<string, unknown>;
const g = globalThis as unknown as { window?: unknown };

/** claude.ai 런타임 흉내 — 모듈 캐시(samplePromise)를 매번 새로 */
async function load(sample: ((input: unknown, opts: Opts) => Promise<unknown>) & { limits?: () => Promise<unknown>; json?: unknown }) {
  vi.resetModules();
  g.window = { claude: { use: async (n: string) => (n === 'sample' ? sample : null) } };
  return import('./claude');
}

afterEach(() => {
  delete g.window;
});

const settings = { mode: 'auto' as const, apiKey: '', model: 'claude-opus-5-5' };

describe('claude.ts — 아티팩트 런타임 계약', () => {
  it('도구 결과는 UTF-8 바이트 기준 32KB 이하로 자른다 (한글 3바이트)', async () => {
    const { compact, TOOL_RESULT_MAX_BYTES } = await load(Object.assign(async () => ({ text: '' }), {}));
    const big = { rows: Array.from({ length: 3000 }, (_, i) => ({ 키워드: `신혼 매트리스 사이즈 ${i}`, 판정: '확장 · 목표 ROAS 400% 대비 132%' })) };
    const out = compact(big);
    expect(typeof out).toBe('string');
    const bytes = new TextEncoder().encode(out as string).length;
    expect(bytes).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(bytes).toBeLessThanOrEqual(32768);
    expect(out as string).not.toMatch(/�/);
    const small = { a: 1 };
    expect(compact(small)).toBe(small);
  });

  it('채팅(cache:false)은 런타임이 도구를 지원하지 않아도 cache:false를 유지', async () => {
    const seen: Opts[] = [];
    const sample = Object.assign(async (_i: unknown, o: Opts) => { seen.push(o); return { text: 'ok', truncated: false }; }, { limits: async () => ({ maxPromptBytes: 262144 }) });
    const { ask } = await load(sample);
    await ask(settings, [{ role: 'user', content: 'q' }], { cache: false, tools: [{ name: 't', description: 'd', execute: () => 1 }] });
    expect(seen[0].tools).toBeUndefined();
    expect(seen[0].cache).toBe(false);
  });

  it('도구를 붙이면 cache를 넘기지 않는다 (tools + cache 동시 지정 금지)', async () => {
    const seen: Opts[] = [];
    const sample = Object.assign(async (_i: unknown, o: Opts) => { seen.push(o); return { text: 'ok', truncated: false }; }, { limits: async () => ({ maxPromptBytes: 262144, tools: { maxCount: 20 } }) });
    const { ask } = await load(sample);
    await ask(settings, [{ role: 'user', content: 'q' }], { cache: false, tools: [{ name: 't', description: 'd', execute: () => 1 }] });
    expect(Array.isArray(seen[0].tools)).toBe(true);
    expect('cache' in seen[0]).toBe(false);
  });

  it('not_granted 뒤에는 백엔드가 규칙 엔진으로 바뀌고 구독자에게 알린다 (재요청 없음)', async () => {
    let calls = 0;
    const sample = Object.assign(async () => { calls += 1; throw { code: 'not_granted', message: 'no' }; }, { limits: async () => ({ maxPromptBytes: 1 }) });
    const { ask, onBackendChange, resolveBackend } = await load(sample);
    const fn = vi.fn();
    const off = onBackendChange(fn);
    expect(await resolveBackend(settings)).toBe('artifact');
    await expect(ask(settings, 'q')).rejects.toMatchObject({ code: 'not_granted' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await resolveBackend(settings)).toBe('none');
    await expect(ask(settings, 'q')).rejects.toMatchObject({ code: 'no_backend' });
    expect(calls).toBe(1);
    off();
  });

  it('rate_limited는 백엔드를 바꾸지 않는다 (컨트롤 유지 · 수동 재시도)', async () => {
    const sample = Object.assign(async () => { throw { code: 'rate_limited', message: 'slow down' }; }, {});
    const { ask, onBackendChange, resolveBackend } = await load(sample);
    const fn = vi.fn();
    onBackendChange(fn);
    await expect(ask(settings, 'q')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fn).not.toHaveBeenCalled();
    expect(await resolveBackend(settings)).toBe('artifact');
  });
});
