/** 워크스페이스 설정 — 에이전트 도구 · 브리프: 기본값 · 적용된 설정 · LIVE 스냅샷 출처 구분, 번호 매기기 없음 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyWorkspaceConfig, mergeConfig, DEFAULT_CONFIG } from '@/data/config';
import type { ToolContext } from '../types';
import { agentKit } from './agent';
import { _resetWorkspaceSnapshot, setWorkspaceSnapshot } from './live';
import { demoState } from './model';

const ctx = {} as ToolContext;
const tool = (name: string) => agentKit.tools(ctx).find((t) => t.name === name)!;

afterEach(() => {
  applyWorkspaceConfig(null);
  _resetWorkspaceSnapshot();
});

describe('workspace_config 도구', () => {
  it('서버 미연결: 기본값 출처 · 바꾼 항목 0 · 섹션 요약', async () => {
    const r = (await tool('workspace_config').execute({})) as Record<string, any>;
    expect(r.출처).toContain('기본값');
    expect(r.바꾼항목수).toBe(0);
    expect(r.설정.목표.목표ROASpct).toBe(400);
    expect(r.설정.위임범위[0]).toBe('일 예산 ±10% 이내 · 상태 점검 → 담당 AE');
    expect(r.설정.SLA.P1).toEqual({ 인지: '15분', 일차조치: '30분', 결과보고: '2시간' });
    expect(JSON.stringify(r).length).toBeLessThan(32_000);
  });

  it('플랫폼이 적용한 워크스페이스 설정을 읽는다 · 섹션 필터', async () => {
    applyWorkspaceConfig({ targets: { roas: 520 }, delegation: { aeMaxPct: 15, pmMaxPct: 40 } });
    const r = (await tool('workspace_config').execute({ section: 'targets' })) as Record<string, any>;
    expect(r.출처).toContain('적용됨');
    expect(r.바꾼항목수).toBe(3);
    expect(r.바꾼항목).toContainEqual({ 항목: '목표 ROAS', 기본값: '400%', 현재: '520%' });
    expect(Object.keys(r.설정)).toEqual(['목표']);
  });

  it('화면이 불러온 서버 상태(LIVE)가 있으면 버전 · 변경자와 함께', async () => {
    const st = { ...demoState(), config: { safety: { dailyChangeCapPct: 15 } }, effective: mergeConfig(DEFAULT_CONFIG, { safety: { dailyChangeCapPct: 15 } }), version: 4, updatedAt: '2026-11-02T01:00:00.000Z', updatedBy: { id: 'u1', name: '김PM' } };
    setWorkspaceSnapshot('', { state: st });
    const r = (await tool('workspace_config').execute({ section: 'safety' })) as Record<string, any>;
    expect(r.출처).toBe('LIVE 서버 설정');
    expect(r.버전).toBe(4);
    expect(r.마지막변경).toBe('2026.11.02 10:00 김PM');
    expect(r.설정.SAFETY.일조정폭상한pct).toBe(15);
  });

  it('변경 이력 도구: 서버 기록이 없으면 안내', async () => {
    const r = (await tool('workspace_config_history').execute({})) as Record<string, any>;
    expect(r.이력).toEqual([]);
    expect(r.안내).toContain('서버에 연결');
  });
});

describe('브리프', () => {
  const zones = ['facts', 'patterns', 'interpretation', 'conditions', 'counter', 'actions'] as const;
  it('기본값 · 바꾼 설정 모두 구조를 지키고 번호 매기기 · NaN이 없다', () => {
    for (const cfg of [null, { targets: { roas: 550 }, safety: { dailyChangeCapPct: 30 }, delegation: { aeMaxPct: 15 }, sla: { P1: { actionMin: null } } }]) {
      applyWorkspaceConfig(cfg);
      for (const b of agentKit.briefs!) {
        const brief = b.build(ctx);
        for (const k of zones) expect(Array.isArray(brief[k])).toBe(true);
        const all = zones.flatMap((k) => brief[k]).join('\n');
        expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
        expect(all).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
    applyWorkspaceConfig({ targets: { roas: 550 } });
    const b = agentKit.briefs!.find((x) => x.id === 'workspace_config')!.build(ctx);
    expect(b.patterns[0]).toContain('목표 ROAS 400% → 550%');
    expect(b.interpretation[0]).toContain('715%');
  });

  it('질문 매칭', () => {
    const cfg = agentKit.briefs!.find((x) => x.id === 'workspace_config')!;
    const onb = agentKit.briefs!.find((x) => x.id === 'workspace_onboarding')!;
    expect(cfg.match.test('지금 목표 ROAS 설정이 몇이야')).toBe(true);
    expect(cfg.match.test('위임 범위 알려줘')).toBe(true);
    expect(onb.match.test('온보딩 어디까지 했어')).toBe(true);
    expect(onb.build(ctx).facts[0]).toContain('TEST DATA');
  });
});
