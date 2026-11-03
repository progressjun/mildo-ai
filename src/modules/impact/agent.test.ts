/** 성과 증명 에이전트 도구 · 브리프 — 데모 예시(TEST DATA) 경로 · 서버 스냅샷(LIVE) 경로 · 장부 필터 · 매체 미반영 표기 · 영역 구조 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import type { ToolContext } from '../types';
import { agentKit } from './agent';
import { buildSummary, impactConfig, type LedgerEntry } from './engine';
import { _resetImpactSnapshotForTest, setImpactSnapshot } from './live';

const ctx = { state: { data: DEMO, incidents: [] } } as unknown as ToolContext;
afterEach(() => _resetImpactSnapshotForTest());

const tool = (name: string) => agentKit.tools(ctx).find((t) => t.name === name)!;

function serverEntries(): LedgerEntry[] {
  const base = { windowDays: 7, month: '2026-10', baseline: null, observed: null, control: null, estimate: null, measuredAt: null };
  return [
    { ...base, id: 'x1', sourceType: 'change', sourceId: 'chg-dry', label: '킹 매트리스 입찰가 900 → 990', occurredAt: '2026-10-15T01:00:00.000Z', status: 'excluded', detail: { exclusion: 'not_applied', mode: 'dry_run', reason: '매체 미반영 — dry_run', route: 'flow' } },
    { ...base, id: 'x2', sourceType: 'change', sourceId: 'chg-pend', label: '퀸 매트리스 입찰가', occurredAt: '2026-10-29T01:00:00.000Z', status: 'pending', detail: { reason: '반영 후 7일 데이터가 쌓이면 측정', route: 'flow' } },
  ];
}

describe('impact agent kit', () => {
  it('도구 ≥ 1 · 브리프 ≥ 1 (관리 모듈 규칙)', () => {
    expect(agentKit.tools(ctx).map((t) => t.name)).toEqual(['impact_summary', 'impact_ledger']);
    expect(agentKit.briefs?.length).toBeGreaterThanOrEqual(1);
  });

  it('데모 경로: TEST DATA 예시로 회수 배수 · 구성 요소 · 전제 · 반례', async () => {
    const r = (await tool('impact_summary').execute({})) as { source: string; paybackMultiple: { point: number }; components: { id: string; method: string; confidenceBasis: string }[]; conditions: string[]; counterExamples: string[]; formula: string };
    expect(r.source).toBe('TEST DATA 예시');
    expect(Number.isFinite(r.paybackMultiple.point)).toBe(true);
    expect(r.components.map((c) => c.id)).toEqual(['uplift', 'loss', 'hours']);
    for (const c of r.components) expect(c.method.length).toBeGreaterThan(10);
    expect(r.formula).toContain('÷ 월 구독료');
    expect(r.counterExamples.length).toBeGreaterThan(2);
    const l = (await tool('impact_ledger').execute({ type: 'change' })) as { entries: { type: string; test: boolean }[] };
    expect(l.entries.length).toBeGreaterThan(0);
    expect(l.entries.every((e) => e.type === '변경 반영' && e.test)).toBe(true);
  });

  it("서버 경로: 화면이 읽은 서버 장부 · '집계 제외 · 매체 미반영' · 상태 필터", async () => {
    const entries = serverEntries();
    setImpactSnapshot('ws-1', { summary: buildSummary(entries, impactConfig(null), '2026-10', { dataMode: 'live' }), entries, month: '2026-10' });
    const s = (await tool('impact_summary').execute({})) as { source: string; verdict: { label: string } };
    expect(s.source).toBe('서버 장부 · LIVE DATA');
    expect(s.verdict.label).toBe('판정 보류');
    const ex = (await tool('impact_ledger').execute({ status: 'excluded' })) as { total: number; entries: { status: string; reason: string }[] };
    expect(ex.total).toBe(1);
    expect(ex.entries[0]).toMatchObject({ status: '집계 제외 · 매체 미반영' });
    const brief = agentKit.briefs![0].build(ctx);
    expect(brief.facts.join(' ')).toContain('매체 미반영(dry_run · 기록만) 변경 1건');
    expect(brief.actions.join(' ')).toContain('관측 중 1건');
  });

  it('브리프: 질문 매칭 · 영역 구조 · 번호 매기기 없음 · NaN 없음', () => {
    const b = agentKit.briefs![0];
    expect(b.match.test('이번 달 성과 증명 회수 배수 알려줘')).toBe(true);
    expect(b.match.test('구독료 대비 ROI가 얼마야')).toBe(true);
    const brief = b.build(ctx);
    expect(brief.title).toContain('회수 배수');
    expect(brief.facts[0]).toContain('TEST DATA 예시');
    for (const k of ['facts', 'patterns', 'interpretation', 'conditions', 'counter', 'actions'] as const) expect(Array.isArray(brief[k])).toBe(true);
    const all = Object.values(brief).flat().join('\n');
    expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
    expect(all).not.toMatch(/NaN|undefined|Infinity/);
  });
});
