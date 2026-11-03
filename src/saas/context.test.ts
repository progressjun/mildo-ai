/** 세션 컨텍스트 — AI 서버 백엔드 연결(configureServerAi): 워크스페이스가 정해지면 그 id, 로그아웃 · 세션 만료면 null */
import { describe, expect, it, vi } from 'vitest';

const calls: { workspaceId: string | null }[] = [];
vi.mock('@/ai/claude', () => ({ configureServerAi: (o: { workspaceId: string | null }) => { calls.push(o); } }));

describe('configureAi', () => {
  it('로그인 전에는 해제 호출 없음 · 워크스페이스 연결 · 전환 · 로그아웃 시 null 한 번', async () => {
    const { configureAi } = await import('./context');
    await configureAi(null);
    expect(calls).toEqual([]);
    await configureAi('ws-1');
    await configureAi('ws-2');
    await configureAi(null);
    await configureAi(null);
    expect(calls).toEqual([{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }, { workspaceId: null }]);
  });
});

describe('claimBrowserFor (공용 PC: 개인 AI 키가 다음 사용자에게 남지 않게)', () => {
  const mem = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  };
  it('같은 사용자가 다시 로그인하면 AI 설정(개인 키)을 유지한다', async () => {
    const { claimBrowserFor } = await import('./context');
    const s = mem({ 'mildo-os/cloud/user': 'u1', 'mildo-os/cloud/ai': '{"apiKey":"sk-ant-1"}' });
    claimBrowserFor('u1', s);
    expect(s.m.get('mildo-os/cloud/ai')).toBe('{"apiKey":"sk-ant-1"}');
    expect(s.m.get('mildo-os/cloud/user')).toBe('u1');
  });
  it('다른 사용자가 로그인하면 이전 사용자의 AI 설정을 지운다 · 처음 로그인은 지우지 않는다', async () => {
    const { claimBrowserFor } = await import('./context');
    const s = mem({ 'mildo-os/cloud/user': 'u1', 'mildo-os/cloud/ai': '{"apiKey":"sk-ant-1"}', 'mildo-os/cloud/workspace': 'ws-1' });
    claimBrowserFor('u2', s);
    expect(s.m.has('mildo-os/cloud/ai')).toBe(false);
    expect(s.m.get('mildo-os/cloud/user')).toBe('u2');
    expect(s.m.get('mildo-os/cloud/workspace')).toBe('ws-1');
    const first = mem({ 'mildo-os/cloud/ai': '{"mode":"server"}' });
    claimBrowserFor('u3', first);
    expect(first.m.get('mildo-os/cloud/ai')).toBe('{"mode":"server"}');
    expect(first.m.get('mildo-os/cloud/user')).toBe('u3');
  });
  it('로그아웃하면 AI 설정 · 사용자 표시를 지운다', async () => {
    const { claimBrowserFor } = await import('./context');
    const s = mem({ 'mildo-os/cloud/user': 'u1', 'mildo-os/cloud/ai': '{"apiKey":"sk-ant-1"}', 'mildo-os/lab/v1': '{}' });
    claimBrowserFor(null, s);
    expect([...s.m.keys()]).toEqual(['mildo-os/lab/v1']);
    // 저장소가 없거나 예외를 던져도 앱은 멈추지 않는다
    expect(() => claimBrowserFor('u1', null)).not.toThrow();
    expect(() => claimBrowserFor('u1', { getItem: () => { throw new Error('denied'); }, setItem: () => undefined, removeItem: () => undefined })).not.toThrow();
  });
  it('스토어의 서버 모드 AI 저장 키와 같은 키를 지운다', async () => {
    const store = (await import('node:fs')).readFileSync(new URL('../core/store.tsx', import.meta.url), 'utf8');
    expect(store).toContain("const CLOUD_AI_KEY = 'mildo-os/cloud/ai'");
  });
});
