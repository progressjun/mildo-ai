import { describe, expect, it } from 'vitest';
import { collectTools } from './orchestrator';
import { MODULES } from '@/modules/registry';
import { DEMO } from '@/data/demo';
import type { ToolContext } from '@/modules/types';

const ctx = {
  state: { data: DEMO, changes: [], incidents: [], toasts: [], comments: [], ai: { mode: 'offline', apiKey: '', model: '' }, role: 'PM', offHoursMode: false, tf: {}, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 } },
  actions: {},
  navigate: () => undefined,
} as unknown as ToolContext;

describe('MILDO Agent 도구 배치', () => {
  it('모듈별 라운드 로빈 — 앞 N개만 남아도 모든 모듈의 대표 도구가 포함된다', () => {
    const all = collectTools(ctx);
    const modulesWithTools = MODULES.filter((m) => (m.agent?.tools(ctx).length ?? 0) > 0).map((m) => m.id);
    const firstN = all.slice(0, modulesWithTools.length).map((t) => t.module);
    expect(new Set(firstN)).toEqual(new Set(modulesWithTools));
    // 각 모듈의 첫 도구가 그 모듈 kit의 첫 도구와 같다
    for (const m of MODULES) {
      const kit = m.agent?.tools(ctx) ?? [];
      if (!kit.length) continue;
      expect(all.find((t) => t.module === m.id)?.tool.name).toBe(kit[0].name);
    }
  });
  it('navigate(화면 열기 버튼) 도구는 대표 도구 바로 뒤에 있어 런타임 상한 20개에 잘리지 않는다 (회귀)', () => {
    const all = collectTools(ctx);
    const modulesWithTools = MODULES.filter((m) => (m.agent?.tools(ctx).length ?? 0) > 0).length;
    const idx = all.findIndex((t) => t.tool.name === 'navigate');
    expect(idx).toBe(modulesWithTools);
    expect(all.slice(0, 20).map((t) => t.tool.name)).toContain('navigate');
  });
  it('도구 이름은 중복 없이 전부 포함된다', () => {
    const all = collectTools(ctx);
    const total = MODULES.reduce((s, m) => s + (m.agent?.tools(ctx).length ?? 0), 0);
    expect(all.length).toBe(total);
    expect(new Set(all.map((t) => t.tool.name)).size).toBe(all.length);
  });
});

describe('MILDO Agent 도구 결과 크기 (런타임 계약 32KB)', () => {
  it('모든 도구를 빈 입력으로 실행해도 오류 없이 32KB(UTF-8) 이하 결과를 낸다', async () => {
    const { compact } = await import('@/ai/claude');
    const enc = new TextEncoder();
    const all = collectTools(ctx);
    expect(all.length).toBeGreaterThan(0);
    for (const { tool } of all) {
      let raw: unknown;
      try {
        raw = await tool.execute({});
      } catch (e) {
        // 필수 입력이 있는 도구(예: navigate)는 빈 입력에 오류를 던질 수 있다 — Claude가 오류로 받는다 (계약)
        const required = (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [];
        expect(required.length, `${tool.name} threw without required input: ${(e as Error).message}`).toBeGreaterThan(0);
        continue;
      }
      const r = compact(raw);
      const s = typeof r === 'string' ? r : JSON.stringify(r);
      expect(typeof s, tool.name).toBe('string');
      expect(enc.encode(s).length, tool.name).toBeGreaterThan(0);
      expect(enc.encode(s).length, tool.name).toBeLessThanOrEqual(32768);
    }
  });
});
