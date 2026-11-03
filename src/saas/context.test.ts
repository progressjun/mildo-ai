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
