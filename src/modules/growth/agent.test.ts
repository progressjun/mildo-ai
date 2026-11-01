/**
 * 매출 성장 에이전트 킷 — 도구 이름 · 결과 크기 · pending 생성 · 오프라인 브리프 매칭 검증.
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '@/core/store';
import type { ChangeRequest } from '@/core/types';
import { DEMO } from '@/data/demo';
import type { ToolContext } from '../types';
import { agentKit } from './agent';

function makeCtx(data = DEMO) {
  const created: ChangeRequest[] = [];
  const state: AppState = {
    data, changes: [], incidents: [], toasts: [], comments: [], ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' },
    role: 'PM', offHoursMode: false, tf: {}, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  const actions = {
    toast: () => undefined,
    addChange: (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'> & { status?: ChangeRequest['status'] }) => {
      const ch = { id: `chg_${created.length}`, createdAt: '2026-10-31T15:30:00+09:00', history: [], status: c.status ?? 'pending', ...c } as ChangeRequest;
      created.push(ch);
      return ch;
    },
    updateChange: () => undefined, addIncident: () => undefined, updateIncident: () => undefined,
  } as unknown as ToolContext['actions'];
  return { ctx: { state, actions, navigate: () => undefined } as ToolContext, created };
}

describe('growth agentKit', () => {
  it('도구 ≥ 2개 · 이름 growth_ 접두사 · 필수 3종(growth_reallocate · growth_da_sa · growth_funnel) 포함', () => {
    const { ctx } = makeCtx();
    const tools = agentKit.tools(ctx);
    const names = tools.map((t) => t.name);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    for (const n of names) expect(n).toMatch(/^growth_[a-z_]+$/);
    for (const n of ['growth_reallocate', 'growth_da_sa', 'growth_funnel']) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  it('읽기 도구: 데모 · 빈 데이터 모두 32KB 이하 JSON, NaN 없음', async () => {
    const emptyData = { ...DEMO, dates: [], mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [] };
    for (const data of [DEMO, emptyData]) {
      const { ctx } = makeCtx(data);
      for (const t of agentKit.tools(ctx)) {
        if (t.inputSchema?.required?.length) continue;
        const r = await t.execute({});
        const s = JSON.stringify(r);
        expect(s.length, t.name).toBeLessThan(32_000);
        expect(s, t.name).not.toMatch(/NaN|undefined/);
      }
    }
  });

  it('growth_reallocate: 비중 입력(%) 반영 · 균등화 결과 · DA→SA 기여 토글', async () => {
    const { ctx } = makeCtx();
    const t = agentKit.tools(ctx).find((x) => x.name === 'growth_reallocate')!;
    const r = (await t.execute({ shares: { naver_sa: 50, kakao: 5 } })) as { 매체: { 매체: string; 시나리오비중pct: number }[]; 합계: { 균등화증분pct: number }; DA_SA기여반영: boolean };
    expect(r.매체.find((m) => m.매체 === '네이버 SA')!.시나리오비중pct).toBeGreaterThan(45);
    expect(r.합계.균등화증분pct).toBeGreaterThan(0);
    const c = (await t.execute({ daSaCredit: true })) as { DA_SA기여반영: boolean };
    expect(c.DA_SA기여반영).toBe(true);
  });

  it('growth_da_sa: 데모 최적 시차 1~2일 · growth_funnel: 자사몰 장바구니 단계 · 품절 랜딩', async () => {
    const { ctx } = makeCtx();
    const tools = agentKit.tools(ctx);
    const ds = (await tools.find((x) => x.name === 'growth_da_sa')!.execute({})) as { 최적시차일: number };
    expect([1, 2]).toContain(ds.최적시차일);
    const f = (await tools.find((x) => x.name === 'growth_funnel')!.execute({})) as { 우선단계: string; 품절랜딩: string[] };
    expect(f.우선단계).toBe('장바구니');
    expect(f.품절랜딩.join(' ')).toContain('킹 매트리스');
  });

  it('상태 변경 도구는 pending ChangeRequest만 만든다 (수면밀도 승인) · 한도 초과 파일럿 차단', async () => {
    const { ctx, created } = makeCtx();
    const tools = agentKit.tools(ctx);
    const realloc = tools.find((x) => x.name === 'growth_request_reallocation')!;
    expect(realloc.inputSchema?.required).toContain('which');
    const r = (await realloc.execute({ which: 'optimized' })) as { 생성: boolean };
    expect(r.생성).toBe(true);
    expect(created[0]).toMatchObject({ status: 'pending', approver: 'CLIENT', module: 'growth', kind: 'budget' });
    const pilot = tools.find((x) => x.name === 'growth_request_pilot')!;
    const over = (await pilot.execute({ name: '영상 · YouTube', budget: 400_000_000 })) as { 생성: boolean; 사유: string };
    expect(over.생성).toBe(false);
    expect(over.사유).toContain('5%');
    const ok = (await pilot.execute({ name: '네이버 신규 지면', budget: 40_000_000 })) as { 생성: boolean };
    expect(ok.생성).toBe(true);
    expect(created[1]).toMatchObject({ status: 'pending', approver: 'CLIENT', kind: 'test' });
    expect(((await pilot.execute({ name: '없는 매체', budget: 1 })) as { 생성: boolean }).생성).toBe(false);
  });

  it('오프라인 브리프 ≥ 2개 · 질문 매칭 · 구조 준수', () => {
    const { ctx } = makeCtx();
    const briefs = agentKit.briefs ?? [];
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    const q: Record<string, string> = {
      growth_alloc: '예산 재배분 한계 ROAS 어떻게 봐야 해?', growth_dasa: 'DA→SA 기여 홀드아웃 설계', growth_funnel: '자사몰 장바구니 이탈 개선',
      growth_new_media: '신규 매체 파일럿 우선순위', growth_campaign: '타겟 그룹별 SA 캠페인 구조', growth_overview: '매출 성장 과제',
    };
    for (const b of briefs) {
      expect(q[b.id], b.id).toBeTruthy();
      expect(b.match.test(q[b.id]), b.id).toBe(true);
      const brief = b.build(ctx);
      const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
      expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(all).not.toMatch(/NaN|undefined|Infinity/);
      expect(brief.actions.length).toBeGreaterThan(0);
    }
  });
});
