/**
 * MILDO Watch 에이전트 도구 · 오프라인 브리프 테스트.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/core/types';
import type { AppState } from '@/core/store';
import type { ToolContext } from '../types';
import { DEMO } from '@/data/demo';
import { agentKit } from './agent';
import { resetWatchStore } from './progress';

function makeCtx(changes: ChangeRequest[] = []) {
  const created: ChangeRequest[] = [];
  const state: AppState = {
    data: DEMO, changes, incidents: [], toasts: [], comments: [],
    ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' }, role: 'PM', offHoursMode: false, tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
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
const tool = (ctx: ToolContext, name: string) => agentKit.tools(ctx).find((t) => t.name === name)!;

describe('MILDO Watch agent kit', () => {
  resetWatchStore();

  it('도구 2개 이상 · watch_ 접두사 · 브리프 2개 이상', () => {
    const { ctx } = makeCtx();
    const tools = agentKit.tools(ctx);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    for (const t of tools) expect(t.name).toMatch(/^watch_[a-z_]+$/);
    for (const n of ['watch_changes', 'watch_competitors', 'watch_weekly_brief']) expect(tools.some((t) => t.name === n)).toBe(true);
    expect((agentKit.briefs ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('조회 도구는 32KB 이하 JSON을 반환하고 NaN이 없다', async () => {
    const { ctx } = makeCtx();
    for (const t of agentKit.tools(ctx)) {
      if (t.inputSchema?.required?.length) continue;
      const r = await t.execute({});
      const s = JSON.stringify(r);
      // 계약 한도는 UTF-8 바이트 기준 32KB (한글은 글자당 3바이트)
      expect(new TextEncoder().encode(s).length, t.name).toBeLessThanOrEqual(32_768);
      expect(s, t.name).not.toMatch(/NaN|Infinity/);
    }
  });

  it('watch_changes는 데모 시나리오(Meta 급등 · 매트리스 추천 CPC · 카카오 보류)를 담는다', async () => {
    const { ctx } = makeCtx();
    const r = (await tool(ctx, 'watch_changes').execute({ stage: 'all' })) as { events: { id: string; diagnosis: { verdict: string } }[] };
    expect(r.events.some((e) => e.id.startsWith('sig_media_spike:meta'))).toBe(true);
    expect(r.events.some((e) => e.id.startsWith('sig_kw_cpc:'))).toBe(true);
    expect(r.events.find((e) => e.id === 'ev_kakao_bizboard')!.diagnosis.verdict).toContain('보류');
    const meta = (await tool(ctx, 'watch_changes').execute({ media: 'meta' })) as { events: unknown[] };
    expect(meta.events.length).toBe(2);
  });

  it('watch_competitors 필터 · 브랜드 지면 점검', async () => {
    const { ctx } = makeCtx();
    const r = (await tool(ctx, 'watch_competitors').execute({ competitor: '지누스', item: 'price' })) as { records: { competitor: string; item: string }[]; brandSerp: unknown[] };
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records.every((x) => x.competitor === '지누스' && x.item === '가격 · 혜택')).toBe(true);
    expect(r.brandSerp.length).toBe(DEMO.keywords.filter((k) => k.isBrand).length);
  });

  it('watch_request_test는 실행안 단계만 pending ChangeRequest(kind test)로 등록하고, 보류 · 단계 불일치는 거절한다', async () => {
    const { ctx, created } = makeCtx();
    const t = tool(ctx, 'watch_request_test');
    expect(((await t.execute({ eventId: 'nope' })) as { ok: boolean }).ok).toBe(false);
    const early = (await t.execute({ eventId: 'ev_meta_advantage' })) as { ok: boolean; reason: string };
    expect(early.ok).toBe(false);
    expect(early.reason).toContain('실행안');
    const hold = (await t.execute({ eventId: 'ev_kakao_bizboard' })) as { ok: boolean; reason: string };
    expect(hold.ok).toBe(false);
    expect(hold.reason).toContain('전환');
    expect(created).toHaveLength(0);

    // 카카오 전환이 정상인 데이터에서는 등록된다
    const data = JSON.parse(JSON.stringify(DEMO));
    for (const r of data.mediaHourly) if (r.date === data.today && r.media === 'kakao' && r.hour >= 13) r.conversions = 0.3;
    const ok = makeCtx();
    ok.ctx.state.data = data;
    const res = (await tool(ok.ctx, 'watch_request_test').execute({ eventId: 'ev_kakao_bizboard' })) as { ok: boolean; status: string };
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pending');
    expect(ok.created[0].kind).toBe('test');
    expect(ok.created[0].targetId).toBe('ev_kakao_bizboard');
    // 등록 후에는 테스트 단계로 반영 → 중복 등록 거절
    const again = makeCtx(ok.created);
    again.ctx.state.data = data;
    const dup = (await tool(again.ctx, 'watch_request_test').execute({ eventId: 'ev_kakao_bizboard' })) as { ok: boolean };
    expect(dup.ok).toBe(false);
  });

  it('watch_request_test — 같은 응답 안(ctx.state는 호출 시점 스냅샷)에서 같은 이벤트를 두 번 요청해도 1건만 만든다', async () => {
    const data = JSON.parse(JSON.stringify(DEMO));
    for (const r of data.mediaHourly) if (r.date === data.today && r.media === 'kakao' && r.hour >= 13) r.conversions = 0.3;
    const { ctx } = makeCtx([]);
    ctx.state.data = data;
    const created: ChangeRequest[] = [];
    (ctx.actions as { addChange: unknown }).addChange = (c: Partial<ChangeRequest>) => {
      const ch = { id: `snap_${created.length}`, createdAt: '2026-10-31T15:30:00+09:00', history: [], status: 'pending', ...c } as ChangeRequest;
      created.push(ch);
      return ch;
    };
    const tools = agentKit.tools(ctx);
    const t = tools.find((x) => x.name === 'watch_request_test')!;
    expect(((await t.execute({ eventId: 'ev_kakao_bizboard' })) as { ok: boolean }).ok).toBe(true);
    const dup = (await t.execute({ eventId: 'ev_kakao_bizboard' })) as { ok: boolean; reason: string };
    expect(dup.ok).toBe(false);
    expect(dup.reason).toContain('이미 등록 요청됨');
    expect(created).toHaveLength(1);
    // 같은 응답의 조회 도구도 테스트 단계로 본다
    const ch = (await tools.find((x) => x.name === 'watch_changes')!.execute({})) as { events: { id: string; stage: string }[] };
    expect(ch.events.find((e) => e.id === 'ev_kakao_bizboard')?.stage).toMatch(/테스트|test/);
  });

  it('오프라인 브리프: 질문 매칭 · 영역 구조 · 번호 매기기 · NaN 없음', () => {
    const { ctx } = makeCtx();
    const q = { 'watch-changes': '매체 변동 상황 알려줘', 'watch-competitors': '경쟁사 가격 변경 있어?', 'watch-season': '이사 성수기 시즌 준비', 'watch-weekly': '주간 인사이트 브리프 초안' } as Record<string, string>;
    for (const b of agentKit.briefs ?? []) {
      expect(b.match.test(q[b.id]), b.id).toBe(true);
      const brief = b.build(ctx);
      const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
      expect(brief.facts.length + brief.patterns.length + brief.interpretation.length).toBeGreaterThan(0);
      expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(all).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
