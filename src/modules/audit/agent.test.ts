/** 감사 로그 에이전트 도구 · 브리프 — 예시(TEST DATA) · 서버(LIVE) 경로, 접두어 · 개수 제한 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import { _resetAuditSnapshot, setAuditSnapshot } from './live';
import { demoAuditEntries } from './demo';

const fetchAudit = vi.fn(async (_ws: string, f: { action?: string }) => ({
  entries: demoAuditEntries().filter((e) => !f.action || e.action.startsWith(f.action)).map((e) => ({ ...e, actor: `${e.actor}*` })),
  nextBefore: null,
}));
vi.mock('./api', () => ({ fetchAudit: (...a: unknown[]) => fetchAudit(...(a as [string, { action?: string }])) }));

const ctx = {} as ToolContext;
afterEach(() => { _resetAuditSnapshot(); fetchAudit.mockClear(); });

describe('audit agent kit', () => {
  it('예시 경로: 접두어 필터 · 개수 제한 · TEST DATA 표시', async () => {
    const { agentKit } = await import('./agent');
    const [tool] = agentKit.tools(ctx);
    expect(tool.name).toBe('audit_recent');
    const r = (await tool.execute({ action: 'change.', limit: 3 })) as { 출처: string; 건수: number; 기록: { 코드: string }[] };
    expect(r.출처).toBe('TEST DATA');
    expect(r.건수).toBe(3);
    expect(r.기록.every((e) => e.코드.startsWith('change.'))).toBe(true);
    expect(fetchAudit).not.toHaveBeenCalled();
    const bad = (await tool.execute({ action: "x'; DROP", limit: 9999 })) as { 건수: number };
    expect(bad.건수).toBe(0);
  });

  it('서버 경로: 화면이 불러온 적 있으면 서버에서 다시 읽는다 (계정 기록 포함)', async () => {
    const { agentKit } = await import('./agent');
    setAuditSnapshot('00000000-0000-4000-8000-000000000001', demoAuditEntries());
    const r = (await agentKit.tools(ctx)[0].execute({ action: 'member.' })) as { 출처: string; 기록: { 행위자: string }[] };
    expect(r.출처).toBe('LIVE');
    expect(fetchAudit).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', { action: 'member.', auth: true }, null, 30);
    expect(r.기록.every((e) => e.행위자.endsWith('*'))).toBe(true);
  });

  it('브리프: 구조 · 번호 매기기 없음 · "감사합니다"에는 반응하지 않음', async () => {
    const { agentKit } = await import('./agent');
    const b = agentKit.briefs![0];
    expect(b.match.test('감사 로그에서 누가 바꿨는지 알려줘')).toBe(true);
    expect(b.match.test('감사합니다')).toBe(false);
    const brief = b.build(ctx);
    expect(brief.facts[0]).toContain('TEST DATA');
    expect(brief.patterns.join(' ')).toContain('로그인 실패');
    const all = Object.values(brief).flat().join('\n');
    expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
    expect(all).not.toMatch(/NaN|undefined|Infinity/);
  });
});
