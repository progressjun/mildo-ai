/** 팀 · 권한 에이전트 도구 · 브리프 — 예시(TEST DATA) · 서버 실데이터(LIVE) 경로 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import { _resetTeamSnapshot, setTeamSnapshot } from './live';
import { demoMembers } from './demo';

vi.mock('./api', () => ({
  fetchMembers: vi.fn(async () => demoMembers(Date.parse('2026-11-02T03:00:00Z')).slice(0, 3).map((m) => ({ ...m, name: m.name.replace(' (예시)', ' (서버)') }))),
  fetchInvites: vi.fn(async () => []),
}));

const ctx = {} as ToolContext;
afterEach(() => _resetTeamSnapshot());

describe('team agent kit', () => {
  it('화면을 열지 않았으면 예시 데이터임을 밝힌다', async () => {
    const { agentKit } = await import('./agent');
    const tools = agentKit.tools(ctx);
    expect(tools.map((t) => t.name)).toEqual(['team_members', 'team_role_matrix']);
    const r = (await tools[0].execute({})) as Record<string, unknown>;
    expect(r.출처).toBe('TEST DATA');
    expect(String(r.안내)).toContain('예시');
    expect(r.활성소유자).toBe(1);
    expect(String(r.소유자판정)).toContain('기준 2명');
  });

  it('서버에서 불러온 적이 있으면 다시 읽어 LIVE로 돌려준다', async () => {
    const { agentKit } = await import('./agent');
    setTeamSnapshot('00000000-0000-4000-8000-000000000001', { members: demoMembers(), invites: [] });
    const r = (await agentKit.tools(ctx)[0].execute({})) as { 출처: string; 구성원: { 이름: string }[] };
    expect(r.출처).toBe('LIVE');
    expect(r.구성원.map((m) => m.이름)).toEqual(['운영 책임자 (서버)', '운영 관리자 (서버)', '김PM (서버)']);
  });

  it('역할 표 도구 · 한 역할만', async () => {
    const { agentKit } = await import('./agent');
    const all = (await agentKit.tools(ctx)[1].execute({})) as { 역할: Record<string, { 팀관리: boolean }>; 규칙: string[] };
    expect(Object.keys(all.역할)).toHaveLength(6);
    expect(all.역할['관리자'].팀관리).toBe(true);
    expect(all.역할['PM'].팀관리).toBe(false);
    const one = (await agentKit.tools(ctx)[1].execute({ role: 'client' })) as { 역할: Record<string, unknown> };
    expect(Object.keys(one.역할)).toEqual(['광고주 담당자']);
  });

  it('브리프: 구조 · 기준 · 반례 · 번호 매기기 없음', async () => {
    const { agentKit } = await import('./agent');
    const b = agentKit.briefs![0];
    expect(b.match.test('팀원 권한 점검해 줘')).toBe(true);
    expect(b.match.test('감사합니다')).toBe(false);
    for (const q of ['초대 링크 다시 보내 줘', '계정 비활성화 기준', '소유자 몇 명이야', '팀 멤버 목록', '구성원 초대 현황']) expect(b.match.test(q), q).toBe(true);
    // 광고 · 판매 질문을 가로채지 않는다
    for (const q of ['키워드 비활성화해도 될까?', '캠페인 비활성화 기준', '이번 달 멤버십 회원 매출', '친구 초대 이벤트 성과']) expect(b.match.test(q), q).toBe(false);
    const brief = b.build(ctx);
    expect(brief.facts.join(' ')).toContain('TEST DATA');
    expect(brief.interpretation.join(' ')).toContain('소유자가 한 명');
    expect(brief.conditions.join(' ')).toContain('2명 이상');
    expect(brief.counter.length).toBeGreaterThan(0);
    const all = Object.values(brief).flat().join('\n');
    expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
    expect(all).not.toMatch(/NaN|undefined|Infinity/);
  });
});
