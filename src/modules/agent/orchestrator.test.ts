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
  it('도구 이름은 중복 없이 전부 포함된다', () => {
    const all = collectTools(ctx);
    const total = MODULES.reduce((s, m) => s + (m.agent?.tools(ctx).length ?? 0), 0);
    expect(all.length).toBe(total);
    expect(new Set(all.map((t) => t.tool.name)).size).toBe(all.length);
  });
});
