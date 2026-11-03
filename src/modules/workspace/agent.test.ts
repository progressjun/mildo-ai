/** 워크스페이스 설정 — 에이전트 도구 · 브리프: 기본값 · 적용된 설정 · LIVE 스냅샷 출처 구분, 번호 매기기 없음 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureServerAi } from '@/ai/claude';
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
  configureServerAi({ workspaceId: null });
  vi.unstubAllGlobals();
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

  it('워크스페이스를 바꾸면 이전 워크스페이스 스냅샷이 아니라 지금 워크스페이스(serverAiWorkspace) 설정 · 이력을 서버에서 읽는다', async () => {
    const old = { ...demoState(), config: { targets: { roas: 900 } }, effective: mergeConfig(DEFAULT_CONFIG, { targets: { roas: 900 } }), version: 7 };
    setWorkspaceSnapshot('ws-a', { state: old, history: [{ id: 1, at: '2026-11-01T00:00:00.000Z', actor: 'A 워크스페이스 PM', userId: null, action: 'config.update', version: 7, changes: [] }] });
    configureServerAi({ workspaceId: 'ws-b' });
    const urls: string[] = [];
    const eff = mergeConfig(DEFAULT_CONFIG, { targets: { roas: 450 } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes('/config/history')
        ? { entries: [{ id: 9, at: '2026-11-02T00:00:00.000Z', actor: 'B 워크스페이스 PM', userId: null, action: 'config.update', version: 2, changes: [] }], nextBefore: null }
        : { ...demoState(), config: { targets: { roas: 450 } }, effective: eff, version: 2 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = (await tool('workspace_config').execute({ section: 'targets' })) as Record<string, any>;
    expect(urls[0]).toBe('/api/w/ws-b/config');
    expect(r.출처).toBe('LIVE 서버 설정');
    expect(r.버전).toBe(2);
    expect(r.설정.목표.목표ROASpct).toBe(450);
    const h = (await tool('workspace_config_history').execute({})) as Record<string, any>;
    expect(urls).toContain('/api/w/ws-b/config/history');
    expect(urls.some((u) => u.includes('ws-a'))).toBe(false);
    expect(h.이력[0].누가).toBe('B 워크스페이스 PM');
    // 서버를 못 읽어도 다른 워크스페이스 스냅샷은 쓰지 않는다
    _resetWorkspaceSnapshot();
    setWorkspaceSnapshot('ws-a', { state: old });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const off = (await tool('workspace_config').execute({ section: 'targets' })) as Record<string, any>;
    expect(off.설정.목표.목표ROASpct).toBe(400);
    expect(off.출처).not.toBe('LIVE 서버 설정');
  });

  it('AI · 성과 증명 · 당번 체계 강제 섹션', async () => {
    applyWorkspaceConfig({ ai: { monthlyTokenLimit: 1_000_000 }, billing: { monthlyFee: 6_000_000 }, impact: { contributionMargin: 0.3 }, offHoursMode: true });
    const ai = (await tool('workspace_config').execute({ section: 'ai' })) as Record<string, any>;
    expect(ai.설정).toEqual({ AI: { 사용: true, 월한도토큰: 1_000_000 } });
    const im = (await tool('workspace_config').execute({ section: 'impact' })) as Record<string, any>;
    expect(im.설정.성과증명입력).toMatchObject({ 월구독료원: 6_000_000, 공헌이익률pct: 30, 일배회수필요증분매출원: 20_000_000, 일배회수필요절감시간: 150 });
    const dt = (await tool('workspace_config').execute({ section: 'detect' })) as Record<string, any>;
    expect(dt.설정.당번체계강제).toContain('켜짐');
  });

  it('AI 사용량 도구: 서버 미연결이면 설정 한도만 · 안내', async () => {
    const r = (await tool('workspace_ai_usage').execute({})) as Record<string, any>;
    expect(r.출처).toBe('없음');
    expect(r.설정.월한도토큰).toBe(30_000_000);
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
