import { describe, expect, it } from 'vitest';
import type { AppState } from '@/core/store';
import type { ToolContext } from '../types';
import { DEMO } from '@/data/demo';
import { detectIncidents } from './engine';
import { agentKit } from './agent';

const state: AppState = {
  data: DEMO, changes: [], incidents: detectIncidents(DEMO).slice(0, 6), toasts: [], comments: [],
  ai: { mode: 'offline', apiKey: '', model: '' }, role: 'PM', offHoursMode: false, tf: {},
  demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
};
const ctx = { state, actions: {} as ToolContext['actions'], navigate: () => undefined } as ToolContext;
const tools = agentKit.tools(ctx);
const run = async (name: string, input: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.execute(input);

describe('MILDO Alert agentKit', () => {
  it('도구 ≥ 2 · 브리프 ≥ 2 · 이름 규칙 alert_*', () => {
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(agentKit.briefs!.length).toBeGreaterThanOrEqual(2);
    for (const t of tools) expect(t.name).toMatch(/^alert_[a-z_]+$/);
  });
  it.each(['alert_scan', 'alert_account_check', 'alert_holiday_check', 'alert_sla_report'])('%s → 32KB 이하 JSON', async (name) => {
    const r = await run(name);
    const s = JSON.stringify(r);
    expect(s.length).toBeLessThan(32_000);
    expect(s).not.toContain('NaN');
  });
  it('alert_scan은 스토어 미적재 탐지 결과도 포함 (notYetLoaded)', async () => {
    const r = (await run('alert_scan')) as { incidents: { id: string; notYetLoaded: boolean }[]; autoAdjustHeld: string[] };
    expect(r.incidents.some((i) => i.notYetLoaded)).toBe(true);
    expect(r.incidents.some((i) => i.id.startsWith('tracking_break:'))).toBe(true);
    expect(r.autoAdjustHeld).toContain('kakao');
    const p1 = (await run('alert_scan', { severity: 'P1' })) as { incidents: { severity: string }[] };
    expect(p1.incidents.every((i) => i.severity === 'P1')).toBe(true);
  });
  it('alert_incident_report → p.49 양식 마크다운, 없는 id는 오류 + 후보', async () => {
    const id = state.incidents[0].id;
    const r = (await run('alert_incident_report', { id })) as { markdown: string };
    expect(r.markdown).toContain('### 재발 방지');
    const bad = (await run('alert_incident_report', { id: 'nope' })) as { error: string; available: unknown[] };
    expect(bad.error).toBeTruthy();
    expect(bad.available.length).toBeGreaterThan(0);
  });
  it('alert_account_check · alert_holiday_check 핵심 값', async () => {
    const acc = (await run('alert_account_check', { accountId: 'acc_gfa' })) as { runwayDays: number; result: string }[];
    expect(acc).toHaveLength(1);
    expect(acc[0].runwayDays).toBeLessThan(1);
    expect(acc[0].result).toBe('fail');
    const hol = (await run('alert_holiday_check', { block: 'long' })) as { block: { start: string; days: number } };
    expect(hol.block.start).toBe('2026-12-25');
    expect(hol.block.days).toBe(3);
  });
  it('오프라인 브리프: 질문 매칭 → 확정 팩트 · 해석 · 다음 액션 분리', () => {
    const pick = (q: string) => agentKit.briefs!.find((b) => b.match.test(q))!;
    expect(pick('GFA 잔액 충전 필요해?').id).toBe('alert_accounts');
    expect(pick('이번 연휴 당번 누구야').id).toBe('alert_holiday');
    expect(pick('지난달 SLA 달성률').id).toBe('alert_sla');
    expect(pick('지금 열린 이슈 정리해줘').id).toBe('alert_issues');
    for (const b of agentKit.briefs!) {
      const r = b.build(ctx);
      expect(r.facts.length).toBeGreaterThan(0);
      expect(r.conditions.length).toBeGreaterThan(0);
      const text = [...r.facts, ...r.patterns, ...r.interpretation, ...r.actions].join('\n');
      expect(text).not.toMatch(/NaN|undefined/);
      expect(/^\s*\d+[.)]\s/m.test(text)).toBe(false);
    }
  });
});
