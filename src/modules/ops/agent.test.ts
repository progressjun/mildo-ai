import { describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import type { AppState } from '@/core/store';
import type { ToolContext } from '../types';
import { agentKit } from './agent';

function ctx(tf: AppState['tf'] = {}): ToolContext {
  const state = {
    data: DEMO, changes: [], incidents: [], toasts: [], comments: [], ai: { mode: 'offline', apiKey: '', model: 'x' }, role: 'PM', offHoursMode: false, tf,
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  } as AppState;
  return { state, actions: {} as ToolContext['actions'], navigate: () => undefined };
}
const tool = (name: string, c = ctx()) => agentKit.tools(c).find((t) => t.name === name)!;

describe('ops agentKit', () => {
  it('도구 4개 · 이름 규칙 · 결과 32KB 미만', async () => {
    const tools = agentKit.tools(ctx());
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.map((t) => t.name)).toEqual(['ops_tf', 'ops_fee_calc', 'ops_rfp_coverage', 'ops_onboarding']);
    for (const t of tools) {
      expect(t.name).toMatch(/^ops_[a-z_]+$/);
      const r = await t.execute({});
      const s = JSON.stringify(r);
      expect(s.length, t.name).toBeLessThan(32_000);
      expect(s, t.name).not.toMatch(/NaN|Infinity/);
    }
  });
  it('ops_tf: 미입력 21칸 · 휴가 시뮬레이션 과부하', async () => {
    const r = (await tool('ops_tf').execute({ absent: ['sa_ae'] })) as Record<string, any>;
    expect(r.미입력.미입력칸).toBe(21);
    const lead = r.휴가시뮬레이션.부하.find((x: any) => x.역할 === 'SA Lead AE');
    expect(lead.합계pct).toBe(150);
    expect(lead.판정).toContain('과부하');
    const pair = (await tool('ops_tf').execute({ absent: ['SA Lead AE', 'sa_ae'] })) as Record<string, any>;
    expect(pair.휴가시뮬레이션.응답공백.length).toBe(2);
  });
  it('ops_tf: 스토어 TF 입력 반영', async () => {
    const r = (await tool('ops_tf', ctx({ pm: { id: 'pm', name: '김총괄', years: '12', allocation: '60' } })).execute({})) as Record<string, any>;
    expect(r.미입력.미입력칸).toBe(18);
    expect(r.명단[0].성명).toBe('김총괄');
  });
  it('ops_fee_calc: 요율 가정 계산', async () => {
    const r = (await tool('ops_fee_calc').execute({ fees: { '네이버 SA · DA': 10, 카카오: 10, 구글: 10, 메타: 10, '버티컬 매체': 10 }, paybackPct: { 카카오: 0 } })) as Record<string, any>;
    expect(r.합계.수수료).toBe(500_000_000);
    expect(r.합계.실효수수료율pct).toBe(10);
    expect(r.미입력.수수료율).toBe(0);
    expect(r.미입력.페이백여부).toBe(4);
  });
  it('ops_rfp_coverage: D-16 · 입력 필요 필터', async () => {
    const r = (await tool('ops_rfp_coverage').execute({ status: 'input' })) as Record<string, any>;
    expect(r.제출마감.Dday).toBe('D-16');
    expect(r.커버리지.every((x: any) => x.상태 === '입력 필요')).toBe(true);
    expect(r.집계.입력필요).toBe(r.커버리지.length);
  });
  it('ops_onboarding: Kick-off 입력 · 잘못된 날짜는 기본값', async () => {
    const r = (await tool('ops_onboarding').execute({ kickoff: '2027-01-04' })) as Record<string, any>;
    expect(r.Kickoff).toBe('2027-01-04');
    expect(r.마일스톤[0].날짜).toBe('2027-02-03');
    const d = (await tool('ops_onboarding').execute({ kickoff: 'x' })) as Record<string, any>;
    expect(d.Kickoff).toBe('2026-12-01');
  });
  it('ops_rfp 브리프는 도구와 같은 커버리지 집계 (레지스트리 읽은 뒤)', async () => {
    const r = (await tool('ops_rfp_coverage').execute({})) as Record<string, any>;
    const brief = agentKit.briefs!.find((x) => x.id === 'ops_rfp')!.build(ctx());
    expect(brief.facts[1]).toContain(`${r.집계.전체}개 중 ${r.집계.구현됨}개`);
  });
  it('ops_tf 당번표는 MILDO Alert 당번 순번과 같다', async () => {
    const { offBlocks, onDutyFor } = await import('../alert/engine');
    const r = (await tool('ops_tf').execute({})) as Record<string, any>;
    const blocks = offBlocks(DEMO.today, 42).slice(0, 6);
    expect(r.당번.map((x: any) => x.기간)).toEqual(blocks.map((b) => `${b.start}~${b.end}`));
    expect(r.당번.map((x: any) => x.당번)).toEqual(blocks.map((b) => [...new Set(b.dates.map((d) => onDutyFor(d)!.role))].join(' · ')));
  });
  it('오프라인 브리프 4개 · 질문 매칭', () => {
    const b = agentKit.briefs!;
    expect(b.length).toBeGreaterThanOrEqual(2);
    const pick = (q: string) => b.find((x) => x.match.test(q))?.id;
    expect(pick('TF 백업 공백 있어?')).toBe('ops_tf');
    expect(pick('수수료 총액은?')).toBe('ops_fee');
    expect(pick('RFP 제출 준비 상황')).toBe('ops_rfp');
    expect(pick('90일 온보딩 일정')).toBe('ops_onboarding');
    for (const x of b) {
      const brief = x.build(ctx());
      const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
      expect(brief.facts.length).toBeGreaterThan(0);
      expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(all).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
