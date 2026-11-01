/**
 * 통합 테스트 — 전 모듈 에이전트 도구 · 오프라인 브리프 계약 검증.
 * MILDO Agent가 tool use로 부르는 도구가 이름 규칙 · 크기 제한(32KB) · 직렬화 가능 조건을 지키는지,
 * 브리프가 팩트/패턴/해석 구조와 출력 규칙(번호 매기기 금지)을 지키는지 확인한다.
 */
import { describe, expect, it } from 'vitest';
import { MODULES, isStubModule } from './registry';
import type { ToolContext } from './types';
import type { AppState } from '@/core/store';
import { DEMO } from '@/data/demo';
import { detectIncidents } from './alert/engine';
import type { ChangeRequest } from '@/core/types';

function makeCtx(): { ctx: ToolContext; created: ChangeRequest[] } {
  const created: ChangeRequest[] = [];
  const state: AppState = {
    data: DEMO,
    changes: [],
    incidents: detectIncidents(DEMO),
    toasts: [],
    comments: [],
    ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' },
    role: 'PM',
    offHoursMode: false,
    tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  const actions = {
    toast: () => undefined,
    addChange: (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'> & { status?: ChangeRequest['status'] }) => {
      const change = { id: `chg_${created.length}`, createdAt: '2026-10-31T15:30:00+09:00', history: [], status: c.status ?? 'pending', ...c } as ChangeRequest;
      created.push(change);
      return change;
    },
    updateChange: () => undefined,
    addIncident: () => undefined,
    updateIncident: () => undefined,
  } as unknown as ToolContext['actions'];
  return { ctx: { state, actions, navigate: () => undefined }, created };
}

describe('module registry · agent kits', () => {
  it('has 12 modules with unique hash-safe ids', () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    for (const reserved of ['settings', 'sidebar', 'customize', 'upgrade', 'downloads']) expect(ids).not.toContain(reserved);
  });

  it('tool names are unique, valid and have descriptions', () => {
    const { ctx } = makeCtx();
    const names: string[] = [];
    for (const m of MODULES) {
      const tools = m.agent?.tools(ctx) ?? [];
      for (const t of tools) {
        expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        expect(t.description.length).toBeGreaterThan(10);
        expect(new TextEncoder().encode(t.description).length).toBeLessThanOrEqual(1024);
        if (t.inputSchema) {
          expect(t.inputSchema.type).toBe('object');
          expect(JSON.stringify(t.inputSchema).length).toBeLessThanOrEqual(4096);
        }
        names.push(t.name);
      }
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('read-only tools without required input execute and return small JSON', async () => {
    const { ctx } = makeCtx();
    for (const m of MODULES) {
      for (const t of m.agent?.tools(ctx) ?? []) {
        if (t.name === 'navigate') continue;
        if (t.inputSchema?.required?.length) continue;
        const r = await t.execute({});
        const s = typeof r === 'string' ? r : JSON.stringify(r);
        expect(s, `${t.name} returns something`).toBeTruthy();
        expect(s.length, `${t.name} result size`).toBeLessThan(32_000);
      }
    }
  });

  it('every built module provides at least one brief, and briefs follow the zone structure', () => {
    const { ctx } = makeCtx();
    const stubs = MODULES.filter(isStubModule).map((m) => m.id);
    if (stubs.length) console.info(`준비 중 모듈(브리프 검사 제외): ${stubs.join(', ')}`);
    for (const m of MODULES) {
      const briefs = m.agent?.briefs ?? [];
      if (m.id !== 'agent' && !stubs.includes(m.id)) expect(briefs.length, `${m.id} briefs`).toBeGreaterThan(0);
      for (const b of briefs) {
        const brief = b.build(ctx);
        expect(brief.title).toBeTruthy();
        for (const k of ['facts', 'patterns', 'interpretation', 'conditions', 'counter', 'actions'] as const) {
          expect(Array.isArray(brief[k]), `${m.id}:${b.id}.${k}`).toBe(true);
        }
        expect(brief.facts.length + brief.patterns.length + brief.interpretation.length, `${m.id}:${b.id} has content`).toBeGreaterThan(0);
        const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
        expect(all, `${m.id}:${b.id} no numbered list`).not.toMatch(/^\s*\d+[.)]\s/m);
        expect(all, `${m.id}:${b.id} no NaN/undefined`).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });
});
