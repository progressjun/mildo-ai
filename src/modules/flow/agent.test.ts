/**
 * MILDO Flow 에이전트 도구 · 오프라인 브리프 테스트.
 * 읽기 도구는 화면과 같은 엔진 결과를 작은 JSON으로, 요청 도구는 pending만 만든다.
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '@/core/store';
import type { ChangeRequest } from '@/core/types';
import { DEMO } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import type { ToolContext } from '../types';
import { agentKit } from './agent';
import { seedChanges } from './engine';

function makeCtx(changes: ChangeRequest[] = [], role: AppState['role'] = 'PM') {
  const created: ChangeRequest[] = [];
  const state: AppState = {
    data: DEMO, changes, incidents: detectIncidents(DEMO), toasts: [], comments: [],
    ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' }, role, offHoursMode: false, tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  const actions = {
    toast: () => undefined,
    addChange: (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'> & { status?: ChangeRequest['status'] }) => {
      const change = { id: `chg_${created.length}`, createdAt: '2026-10-31T15:30:00+09:00', history: [], status: c.status ?? 'pending', ...c } as ChangeRequest;
      created.push(change);
      return change;
    },
    updateChange: () => undefined, addIncident: () => undefined, updateIncident: () => undefined,
  } as unknown as ToolContext['actions'];
  const ctx: ToolContext = { state, actions, navigate: () => undefined };
  const tool = (name: string) => agentKit.tools(ctx).find((t) => t.name === name)!;
  return { ctx, created, tool };
}
/** 계약은 UTF-8 바이트 기준 32KB (한글은 3바이트) */
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('flow agent tools', () => {
  it('도구 이름 규칙 · 필수 도구 포함', () => {
    const { ctx } = makeCtx();
    const names = agentKit.tools(ctx).map((t) => t.name);
    for (const n of ['flow_pending', 'flow_promo_check', 'flow_promo_report']) expect(names).toContain(n);
    for (const n of names) expect(n).toMatch(/^flow_[a-z_]+$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it('flow_pending: 역할 기준 처리 목록 · 실행 점검 · 32KB 이하', async () => {
    const { tool } = makeCtx(seedChanges(DEMO));
    const r = (await tool('flow_pending').execute({})) as Json;
    expect(r.건수['승인 대기']).toBeGreaterThan(0);
    expect(r.목록.length).toBeGreaterThan(0);
    expect(r.목록.every((x: Json) => ['승인 대기', '승인', '보류'].includes(x.상태))).toBe(true);
    expect(r.내가처리할것.권한밖승인대기.length).toBeGreaterThan(0); // PM은 수면밀도 승인 건 처리 불가
    expect(r.비고).toBeNull();
    expect(r.대량변경감지).toEqual([]); // 시연 이력은 대량 변경 아님
    // 승인 대기 → 반영 대기의 실행 점검은 AD Pilot · GFA Control과 같은 검증을 포함한다
    const kakaoHeld = r.목록.find((x: Json) => x.상태 === '보류');
    expect(kakaoHeld).toBeTruthy();
    expect(size(r)).toBeLessThan(32_000);
    const client = (await tool('flow_pending').execute({ role: '수면밀도', status: 'all', limit: 5 })) as Json;
    expect(client.내가처리할것.권한밖승인대기).toEqual([]);
    expect(client.목록.length).toBeLessThanOrEqual(5);
  });

  it('flow_pending: 대량 변경 감지 (MILDO Alert 기준) · 반영 대기 GFA 증액의 실행 보류 사유', async () => {
    const burst: ChangeRequest[] = Array.from({ length: 10 }, (_, k) => ({
      id: `b_${k}`, createdAt: `2026-10-31T14:${String(k).padStart(2, '0')}:00+09:00`, module: 'adpilot', kind: 'bid', target: `키워드 ${k}`, targetId: `kw_${k + 1}`,
      before: 1000, after: 1050, changePct: 5, reason: '테스트 일괄 변경', requestedBy: 'AD Pilot', approver: 'AE', status: 'pending', history: [{ at: `2026-10-31T14:${String(k).padStart(2, '0')}:00+09:00`, by: 'AD Pilot', action: '요청 생성' }],
    }));
    const gfa = DEMO.campaigns.find((c) => c.name === 'GFA_Prospecting')!;
    const approved: ChangeRequest = { ...burst[0], id: 'gfa_up', module: 'gfa', kind: 'budget', target: 'GFA_Prospecting 일 예산', targetId: `gfa:budget:${gfa.id}`, before: gfa.dailyBudget, after: gfa.dailyBudget * 1.1, changePct: 10, requestedBy: 'PM', status: 'approved', createdAt: '2026-10-30T10:00:00+09:00' };
    const { tool } = makeCtx([...burst, approved]);
    const r = (await tool('flow_pending').execute({ limit: 40 })) as Json;
    expect(r.대량변경감지).toHaveLength(1);
    expect(r.대량변경감지[0].관련요청수).toBe(10);
    const g = r.목록.find((x: Json) => x.id === 'gfa_up');
    expect(g.실행점검.통과).toBe(false);
    expect(g.실행점검.보류사유.join(' ')).toMatch(/GFA Control 실행 검증/);
  });

  it('flow_pending: 빈 이력이면 시연 이력 안내', async () => {
    const { tool } = makeCtx([]);
    const r = (await tool('flow_pending').execute({})) as Json;
    expect(r.목록).toEqual([]);
    expect(String(r.비고)).toMatch(/시연용 이력/);
    expect(JSON.stringify(r)).not.toMatch(/NaN/);
  });

  it('flow_promo_check: 프로모션별 판정 · 실패 항목 · 조치 요청 승인 주체', async () => {
    const { tool } = makeCtx();
    const r = (await tool('flow_promo_check').execute({})) as Json;
    expect(r.프로모션).toHaveLength(DEMO.promotions.length);
    const p1 = r.프로모션.find((p: Json) => p.id === 'promo_1');
    expect(p1.판정).toBe('즉시 조치');
    expect(p1.항목.some((i: Json) => i.항목군 === '랜딩' && i.결과 === 'fail' && i.조치요청?.승인주체 === 'PM')).toBe(true);
    expect(size(r)).toBeLessThan(32_000);
    const one = (await tool('flow_promo_check').execute({ promoId: '집들이' })) as Json;
    expect(one.프로모션).toHaveLength(1);
    expect(((await tool('flow_promo_check').execute({ promoId: '없는 기획전' })) as Json).error).toBeTruthy();
  });

  it('flow_promo_report: 진행 중 프로모션 기본 · 채널 비중 · 마크다운', async () => {
    const { tool } = makeCtx();
    const r = (await tool('flow_promo_report').execute({})) as Json;
    expect(r.프로모션.id).toBe('promo_1');
    expect(r.집계가능).toBe(true);
    expect(r.채널비중).toHaveLength(4);
    expect(String(r.리포트)).toContain('### 확정 팩트');
    expect(r.다음기획반영.length).toBeGreaterThan(0);
    expect(size(r)).toBeLessThan(32_000);
    const pre = (await tool('flow_promo_report').execute({ promoId: 'promo_3', includeMarkdown: false })) as Json;
    expect(pre.집계가능).toBe(false);
    expect(pre.리포트).toBeUndefined();
  });

  it('flow_timeline: 이슈 단계 · 최근 활동', async () => {
    const { tool } = makeCtx(seedChanges(DEMO));
    const r = (await tool('flow_timeline').execute({})) as Json;
    expect(r.단계별.감지).toBe(detectIncidents(DEMO).length);
    expect(r.이슈.length).toBeGreaterThan(0);
    expect(r.최근활동.length).toBeGreaterThan(0);
    expect(size(r)).toBeLessThan(32_000);
  });

  it('flow_request_change: dryRun은 만들지 않고, 실제 요청은 pending · 승인 주체 자동 결정', async () => {
    const { tool, created } = makeCtx();
    const dry = (await tool('flow_request_change').execute({ type: 'budget', target: 'SA_일반 제품', pct: 20, reason: '피크 시간대 전 소진 방지 요청', dryRun: true })) as Json;
    expect(dry.생성).toBe(false);
    expect(dry.승인주체).toBe('PM');
    expect(created).toHaveLength(0);
    const real = (await tool('flow_request_change').execute({ type: 'budget', target: 'SA_일반 제품', pct: 35, reason: '피크 시간대 전 소진 방지 요청' })) as Json;
    expect(real.생성).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('pending');
    expect(created[0].approver).toBe('CLIENT');
    expect(created[0].requestedBy).toBe('MILDO Agent');
    const bad = (await tool('flow_request_change').execute({ type: 'bid', target: '신혼 매트리스', pct: 40, reason: '노출 손실 회복 요청' })) as Json;
    expect(bad.생성).toBe(false);
    expect(bad.오류.join(' ')).toMatch(/상한/);
    expect(((await tool('flow_request_change').execute({ type: 'nope', reason: 'x' })) as Json).error).toBeTruthy();
    expect(created).toHaveLength(1);
  });
});

describe('flow offline briefs', () => {
  const samples: Record<string, string> = {
    flow_pending: '지금 승인 대기 중인 요청 뭐 있어?',
    flow_promo_check: '기획전 오픈 전 체크리스트 결과 알려줘',
    flow_promo_report: '가을 기획전 프로모션 성과 리포트',
    flow_ops: '감지 → 배정 → 조치 → 보고 운영 프로세스 현황',
  };
  it('브리프 2개 이상 · 질문 매칭 · 영역 구조 · 번호 매기기 · NaN 없음', () => {
    const briefs = agentKit.briefs ?? [];
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    for (const changes of [[], seedChanges(DEMO)]) {
      const { ctx } = makeCtx(changes);
      for (const b of briefs) {
        if (samples[b.id]) expect(b.match.test(samples[b.id]), b.id).toBe(true);
        const brief = b.build(ctx);
        const all = [brief.title, ...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
        expect(all, b.id).not.toMatch(/NaN|undefined|Infinity/);
        expect(all, b.id).not.toMatch(/^\s*\d+[.)]\s/m);
        expect(brief.facts.length + brief.patterns.length + brief.interpretation.length, b.id).toBeGreaterThan(0);
      }
    }
  });
});
