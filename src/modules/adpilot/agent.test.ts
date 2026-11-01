import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/core/types';
import type { AppState } from '@/core/store';
import { generateDemoData } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import type { ToolContext } from '../types';
import { agentKit } from './agent';

function ctx(role: AppState['role'] = 'PM', withIncidents = false) {
  const changes: ChangeRequest[] = [];
  const data = generateDemoData();
  const state = { data, changes, incidents: withIncidents ? detectIncidents(data) : [], toasts: [], comments: [], role, offHoursMode: false, tf: {} } as unknown as AppState;
  const actions = {
    toast: () => undefined,
    addChange: (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'>) => {
      const full: ChangeRequest = { id: `chg_${changes.length + 1}`, createdAt: '2026-10-31T06:00:00Z', status: 'pending', history: [{ at: '2026-10-31T06:00:00Z', by: c.requestedBy, action: '요청 생성' }], ...c };
      changes.unshift(full);
      return full;
    },
    updateChange: () => undefined,
    addIncident: () => undefined,
    updateIncident: () => undefined,
  } as unknown as ToolContext['actions'];
  return { state, actions, navigate: () => undefined, changes } as ToolContext & { changes: ChangeRequest[] };
}

describe('agentKit', () => {
  it('도구 2개 이상 · 이름 규칙 · 필수 도구 포함', () => {
    const tools = agentKit.tools(ctx());
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const names = tools.map((t) => t.name);
    for (const n of ['adpilot_proposals', 'adpilot_request_change', 'gfa_route_change']) expect(names).toContain(n);
    for (const n of names) expect(n).toMatch(/^(adpilot|gfa)_[a-z_]+$/);
  });

  it('모든 도구 실행 결과는 32KB 이하 plain JSON', async () => {
    const c = ctx();
    for (const t of agentKit.tools(c)) {
      const input = t.name === 'adpilot_simulate' ? { keyword: '퀸 매트리스', changePct: 10 } : t.name === 'gfa_route_change' ? { type: 'budget', pct: 25 } : t.name === 'adpilot_request_change' ? { keyword: '퀸 매트리스', bid: 1500 } : {};
      const r = await t.execute(input);
      const s = JSON.stringify(r);
      expect(s.length).toBeLessThan(32_000);
      // 계약은 UTF-8 바이트 기준 32KB (한글은 3바이트)
      expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(32_768);
      expect(s).not.toMatch(/NaN/);
    }
  });

  it('adpilot_request_change: 후보 → pending 생성, 중복 요청 방지, 보류 후보 · SAFETY 차단 건은 생성하지 않음', async () => {
    const c = ctx();
    const tools = agentKit.tools(c);
    const list = (await tools.find((t) => t.name === 'adpilot_proposals')!.execute({ action: 'bid_up' })) as { 후보: { proposalId: string }[] };
    const id = list.후보[0].proposalId;
    const req = tools.find((t) => t.name === 'adpilot_request_change')!;
    const r1 = (await req.execute({ proposalId: id })) as { changeId?: string };
    expect(r1.changeId).toBeDefined();
    expect(c.changes[0].status).toBe('pending');
    expect(c.changes[0].module).toBe('adpilot');
    const again = (await agentKit.tools(c).find((t) => t.name === 'adpilot_request_change')!.execute({ proposalId: id })) as { 결과?: string };
    expect(again.결과).toBe('이미 요청됨');
    const holds = (await tools.find((t) => t.name === 'adpilot_proposals')!.execute({ action: 'hold' })) as { 후보: { proposalId: string; 대상: string }[] };
    const anomaly = holds.후보.find((h) => h.대상 === '매트리스 추천')!;
    const r2 = (await req.execute({ proposalId: anomaly.proposalId })) as { error?: string };
    expect(r2.error).toBeDefined();
    const r3 = (await req.execute({ keyword: '퀸 매트리스', bid: 5000 })) as { error?: string };
    expect(r3.error).toContain('SAFETY');
  });

  it('gfa_route_change: 위임 범위 경계 · 역할 권한', async () => {
    const t = agentKit.tools(ctx('담당 AE')).find((x) => x.name === 'gfa_route_change')!;
    expect(((await t.execute({ type: 'budget', pct: 10 })) as { 승인주체: string }).승인주체).toBe('담당 AE');
    const pm = (await t.execute({ type: 'budget', pct: 25 })) as { 승인주체: string; 현재역할승인가능: boolean };
    expect(pm.승인주체).toBe('PM');
    expect(pm.현재역할승인가능).toBe(false);
    expect(((await t.execute({ type: 'new_campaign' })) as { 승인주체: string }).승인주체).toBe('수면밀도 승인');
  });

  it('오프라인 브리프 2개 이상 · 질문 매칭 · Brief 구조', () => {
    const briefs = agentKit.briefs ?? [];
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    const c = ctx();
    const q = (text: string) => briefs.find((b) => b.match.test(text));
    expect(q('오늘 입찰 조정 후보 정리해줘')?.id).toBe('adpilot-proposals');
    expect(q('GFA 승인 주체가 누구야?')?.id).toBe('gfa-control');
    expect(q('매트리스 추천 왜 보류됐어?')?.id).toBe('adpilot-holds');
    expect(q('일 예산 조기 소진 캠페인은?')?.id).toBe('adpilot-budget');
    expect(q('ROAS 400% 이상 키워드')?.id).not.toBe('adpilot-holds');
    for (const b of briefs) {
      const r = b.build(c);
      expect(r.facts.length).toBeGreaterThan(0);
      expect(Array.isArray(r.actions)).toBe(true);
    }
  });
  it('adpilot_proposals: MILDO Alert 이슈 연계 보류 · 하향 0건 사유 · 민감도(공식 기준 아님)를 함께 반환', async () => {
    const c = ctx('PM', true);
    const t = agentKit.tools(c).find((x) => x.name === 'adpilot_proposals')!;
    const r = (await t.execute({ action: 'hold' })) as { 후보: { 대상: string; 연계이슈?: string[] }[]; 하향규칙: { 건수: number; 설명: string; 민감도: { 목표ROAS: number; 하향후보: string[] } | string | null } };
    const kakao = r.후보.find((p) => p.대상.startsWith('카카오'))!;
    expect(kakao.연계이슈?.join(' ')).toContain('tracking_break');
    expect(r.하향규칙.건수).toBe(0);
    expect(r.하향규칙.설명).toContain('하향 0건');
    expect(typeof r.하향규칙.민감도 === 'object' && r.하향규칙.민감도 !== null && r.하향규칙.민감도.하향후보.length > 0).toBe(true);
    // 보류 브리프는 Alert 연계를 반복 관측 패턴으로 보여준다
    const hb = agentKit.briefs!.find((b) => b.id === 'adpilot-holds')!.build(c);
    expect(hb.patterns.join(' ')).toContain('MILDO Alert');
  });

  it('adpilot_request_change: 같은 키워드에 진행 중 변경이 있으면 수동 요청을 새로 만들지 않는다', async () => {
    const c = ctx();
    const req = agentKit.tools(c).find((t) => t.name === 'adpilot_request_change')!;
    const first = (await req.execute({ keyword: '퀸 매트리스', bid: 1500 })) as { changeId?: string };
    expect(first.changeId).toBeDefined();
    const second = (await agentKit.tools(c).find((t) => t.name === 'adpilot_request_change')!.execute({ keyword: '퀸 매트리스', bid: 1520 })) as { 결과?: string };
    expect(second.결과).toBe('이미 진행 중인 변경이 있음');
    expect(c.changes.length).toBe(1);
  });

  it('브리프 매칭: GFA 잔액 질문은 예산 브리프가 아니라 GFA 브리프로 간다', () => {
    const q = (text: string) => (agentKit.briefs ?? []).find((b) => b.match.test(text))?.id;
    expect(q('GFA 잔액 언제 소진돼?')).toBe('gfa-control');
    expect(q('입찰 하향 후보가 왜 없어?')).toBe('adpilot-proposals');
  });
});
