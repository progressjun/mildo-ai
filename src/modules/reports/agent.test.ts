/**
 * Reports 에이전트 키트 — 도구 실행 · 결과 크기(32KB) · 오프라인 브리프 구조 · 질문 매칭 우선순위 검증.
 */
import { describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import type { AppState } from '@/core/store';
import type { ToolContext } from '../types';
import { detectIncidents } from '@/modules/alert/engine';
import { agentKit } from './agent';
import { commentTarget } from './engine';

function makeCtx(patch: Partial<AppState> = {}): ToolContext {
  const state: AppState = {
    data: DEMO, changes: [], incidents: detectIncidents(DEMO), toasts: [], comments: [],
    ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' }, role: 'PM', offHoursMode: false, tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
    ...patch,
  };
  return { state, actions: {} as ToolContext['actions'], navigate: () => undefined };
}
const tool = (ctx: ToolContext, name: string) => agentKit.tools(ctx).find((t) => t.name === name)!;
const size = (r: unknown) => JSON.stringify(r).length;
/** orchestrator.offlineAnswer와 같은 점수 (매칭 길이 합) */
function bestBrief(q: string): string | undefined {
  const scored = (agentKit.briefs ?? []).map((b) => {
    const re = new RegExp(b.match.source, b.match.flags.includes('g') ? b.match.flags : `${b.match.flags}g`);
    const hits = q.match(re) ?? [];
    return { id: b.id, score: hits.reduce((a, h) => a + h.length, 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.id;
}

describe('reports agentKit', () => {
  it('도구 3개 · 브리프 2개 이상 · 이름 규칙', () => {
    const tools = agentKit.tools(makeCtx());
    expect(tools.map((t) => t.name)).toEqual(['reports_generate', 'reports_timetable', 'reports_savings']);
    for (const t of tools) expect(t.name).toMatch(/^reports_[a-z_]+$/);
    expect((agentKit.briefs ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('reports_generate: 4종 모두 32KB 이하 · 메신저 · 문서 · 섹션 · 피드백 병합', async () => {
    const ctx = makeCtx({ comments: [
      { id: 'c1', target: commentTarget('daily', 'media'), author: '수면밀도', text: 'GFA는 신규 CPA로 봐 주세요', at: '2026-10-31T06:00:00.000Z' },
      { id: 'c2', target: 'reports:daily:ae', author: '담당 AE', text: 'GFA 충전 요청 완료', at: '2026-10-31T06:10:00.000Z' },
    ] });
    for (const type of ['daily', 'weekly', 'monthly', 'issue']) {
      const r = (await tool(ctx, 'reports_generate').execute({ type })) as Record<string, unknown>;
      expect(size(r), type).toBeLessThan(32_000);
      expect(String(r.메신저), type).toContain('[MILDO');
      expect(String(r.문서), type).toContain('## 확정 팩트');
      expect(JSON.stringify(r), type).not.toMatch(/NaN|undefined|Infinity/);
    }
    const daily = (await tool(ctx, 'reports_generate').execute({ type: 'daily', format: 'doc' })) as Record<string, unknown>;
    expect(daily.메신저).toBeUndefined();
    expect(String(daily.문서)).toContain('GFA 충전 요청 완료');
    expect(String(daily.문서)).toContain('GFA는 신규 CPA로 봐 주세요');
    expect(daily.피드백).toEqual({ 전체: 1, 반영대기: 1 });
    const bad = (await tool(ctx, 'reports_generate').execute({ type: 'nope' })) as Record<string, unknown>;
    expect(bad.종류).toBe('일간');
  });

  it('reports_timetable: 토요일 이동 규칙 · 상태 · 산출물', async () => {
    const r = (await tool(makeCtx(), 'reports_timetable').execute({})) as { 휴무: string; 항목: { 시각: string; 실제시각: string; 산출물: string }[] };
    expect(r.휴무).toBe('토요일');
    expect(r.항목.find((i) => i.시각 === '09:30')!.실제시각).toBe('2026-11-02 09:30');
    expect(r.항목.find((i) => i.시각 === '14:00')!.산출물).toContain('Meta_넓은 타겟');
    expect(size(r)).toBeLessThan(32_000);
  });

  it('reports_savings: 기본 −59% · 기존 수정 재계산 · 90일 일정', async () => {
    const t = tool(makeCtx(), 'reports_savings');
    const base = (await t.execute({})) as { 합계: { 기존분: number; 자동화후분: number; 절감률pct: number }; 판정: { 결과: string }; 일정90일: { 단계: { 단계종료주간분: number }[] } };
    expect(base.합계).toMatchObject({ 기존분: 1070, 자동화후분: 435 });
    expect(Math.round(base.합계.절감률pct)).toBe(59);
    expect(base.판정.결과).toBe('하한 충족');
    expect(base.일정90일.단계.map((p) => p.단계종료주간분)).toEqual([1070, 525, 435]);
    const edited = (await t.execute({ before: { '주간 보고서 작성': '480' } })) as { 합계: { 기존분: number } };
    expect(edited.합계.기존분).toBe(1310);
  });

  it('오프라인 브리프: 구조 · 번호 매기기 없음 · NaN 없음', () => {
    const ctx = makeCtx();
    for (const b of agentKit.briefs ?? []) {
      const brief = b.build(ctx);
      expect(brief.title, b.id).toBeTruthy();
      expect(brief.facts.length, b.id).toBeGreaterThan(0);
      const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
      expect(all, b.id).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(all, b.id).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it('reports_generate: 월간 · 이슈 코멘트는 대상 월 · 이슈 단위로만 병합된다', async () => {
    const kakao = detectIncidents(DEMO).find((i) => i.ruleId === 'tracking_break')!;
    const ctx = makeCtx({ comments: [
      { id: 'm9', target: 'reports:monthly-2026-09:channels', author: '수면밀도', text: '9월 자사몰 객단가 확인', at: '2026-10-31T06:00:00.000Z' },
      { id: 'm10', target: 'reports:monthly-2026-10:channels', author: '수면밀도', text: '10월 쿠팡 비중 확인', at: '2026-10-31T06:00:00.000Z' },
      { id: 'ik', target: `reports:issue-${kakao.id}:ae`, author: '담당 AE', text: '카카오 픽셀 재설치 요청', at: '2026-10-31T06:10:00.000Z' },
    ] });
    const g = tool(ctx, 'reports_generate');
    const oct = (await g.execute({ type: 'monthly', month: '2026-10', format: 'doc' })) as Record<string, unknown>;
    expect(String(oct.문서)).toContain('10월 쿠팡 비중 확인');
    expect(String(oct.문서)).not.toContain('9월 자사몰 객단가 확인');
    const sep = (await g.execute({ type: 'monthly', month: '2026-09', format: 'doc' })) as Record<string, unknown>;
    expect(String(sep.문서)).toContain('9월 자사몰 객단가 확인');
    const issueK = (await g.execute({ type: 'issue', incidentId: kakao.id, format: 'doc' })) as Record<string, unknown>;
    expect(String(issueK.문서)).toContain('카카오 픽셀 재설치 요청');
    const issueTop = (await g.execute({ type: 'issue', format: 'doc' })) as Record<string, unknown>;
    expect(String(issueTop.문서)).not.toContain('카카오 픽셀 재설치 요청');
  });

  it('시간표 브리프 기준 시각은 데이터 기준 시각(generatedAt)에서 읽는다', () => {
    const b = agentKit.briefs!.find((x) => x.id === 'reports_timetable')!;
    expect(b.build(makeCtx()).facts[0]).toContain('기준 시각 15:30');
    const early = makeCtx({ data: { ...DEMO, generatedAt: '2026-10-31T07:45:00+09:00', currentHour: 7 } });
    expect(b.build(early).facts[0]).toContain('기준 시각 07:45');
  });

  it('질문 매칭: 리포트 종류별로 맞는 브리프가 가장 높은 점수', () => {
    expect(bestBrief('주간 리포트 보여줘')).toBe('reports_weekly');
    expect(bestBrief('이번 월간 리포트 채널별 매출 기여는?')).toBe('reports_monthly');
    expect(bestBrief('어제 성과 리포트')).toBe('reports_today');
    expect(bestBrief('이슈 알림 리포트 조치 상태')).toBe('reports_issue');
    expect(bestBrief('데이터 시간표에서 브리핑은 몇 시?')).toBe('reports_timetable');
    expect(bestBrief('자동화로 업무 시간 절감 얼마나 돼?')).toBe('reports_savings');
    expect(bestBrief('90일 적용 일정')).toBe('reports_rollout');
    // 일반 수치 질문('40%')이 절감 브리프로 끌려가지 않는다
    expect(bestBrief('ROAS 40% 하락 원인')).toBeUndefined();
  });
});
