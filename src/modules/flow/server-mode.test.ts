/**
 * MILDO Flow 서버 모드 화면 (SSR) — 역할은 멤버십 기준 읽기 전용(역할 전환 버튼 없음), 시연 이력 불러오기 안내 · '시연 이력' 범위 없음,
 * 권한 밖 안내는 팀 · 권한 기준. 같은 화면의 데모 모드 동작(역할 전환 · 시연 이력)은 그대로인지 함께 확인한다.
 * 스토어는 데모 상태(me 없음)로 두고 화면이 읽는 모드만 SaasTestProvider로 'server'를 준다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';
import type { Role } from '@/core/permissions';
import { DEMO } from '@/data/demo';
import { seedChanges } from './engine';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const SEEDS = seedChanges(DEMO);
function setStore(changes: ChangeRequest[], role: '담당 AE' | 'PM' | '수면밀도' = 'PM') {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents: [], comments: [], ai: { mode: 'offline' }, role, tf: {} });
}

async function render(node: ReactNode, mode: 'server' | 'demo', role: Role = 'admin'): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const inner = h(StoreProvider, null, node);
  const tree = mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role } }, inner) : inner;
  return renderToString(tree).replace(/<!-- -->/g, '');
}

async function harness(which: 'board' | 'drawer', id = ''): Promise<ComponentType> {
  const { useFlow } = await import('./useFlow');
  const { BoardTab } = await import('./BoardTab');
  const { ChangeDrawer } = await import('./ChangeDrawer');
  const noop = () => undefined;
  return function Harness() {
    const ctx = useFlow();
    return which === 'board' ? h(BoardTab, { ctx, onOpen: noop, onNew: noop }) : h(ChangeDrawer, { ctx, id, onClose: noop });
  };
}

const ROLE_SEG = /role="group" aria-label="현재 역할"/;

describe('MILDO Flow · 서버 모드', () => {
  it('헤더: 역할 전환 버튼 대신 멤버십 역할을 읽기 전용으로 표시 · 시연 이력 건수 문구 없음', async () => {
    setStore([]);
    const View = (await import('./View')).default as ComponentType;
    const html = await render(h(View), 'server', 'admin');
    expect(html).not.toMatch(ROLE_SEG);
    expect(html).toMatch(/aria-label="현재 역할 \(멤버십\)"[^>]*>관리자</);
    expect(html).toContain('로그인 계정의 멤버십 역할로 정해지고 서버가 최종 판정합니다');
    expect(html).toContain('승인 범위');
    expect(html).not.toContain('시연 이력 0건 포함');
    // 다른 멤버십 역할도 그 이름으로
    expect(await render(h(View), 'server', 'client')).toMatch(/aria-label="현재 역할 \(멤버십\)"[^>]*>광고주 담당자</);
  });

  it('데모 모드 헤더는 그대로: 역할 전환 3개 · 시연 이력 건수', async () => {
    setStore(SEEDS);
    const View = (await import('./View')).default as ComponentType;
    const html = await render(h(View), 'demo');
    expect(html).toMatch(ROLE_SEG);
    expect(html).not.toContain('현재 역할 (멤버십)');
    expect(html).toContain(`시연 이력 ${SEEDS.length}건 포함`);
  });

  it('요청 · 승인 보드: 서버 모드에는 시연 이력 불러오기 안내 · 시연 이력 · 이번 세션 범위가 없다 (데모 모드에는 있다)', async () => {
    setStore([]);
    const server = await render(h(await harness('board')), 'server');
    expect(server).not.toContain('시연용 이력이 비어 있습니다');
    expect(server).not.toContain('시연 이력 불러오기');
    expect(server).not.toContain('>시연 이력</button>');
    expect(server).not.toContain('>이번 세션</button>');
    expect(server).toContain('>전체 0</button>');
    expect(server).toContain('워크스페이스 전체 이력');

    const demo = await render(h(await harness('board')), 'demo');
    expect(demo).toContain('시연용 이력이 비어 있습니다');
    expect(demo).toContain('시연 이력 불러오기');
    expect(demo).toContain('>시연 이력</button>');
    expect(demo).toContain('>이번 세션</button>');
  });

  it('상세: 권한 밖이면 서버 모드는 멤버십 역할 안내, 데모 모드는 상단 역할 전환 안내', async () => {
    const base = SEEDS.find((c) => c.approver === 'PM') ?? SEEDS[0];
    const c: ChangeRequest = { ...base, id: 'srv_pm_1', approver: 'PM', status: 'pending' };
    setStore([c], '담당 AE');
    const server = await render(h(await harness('drawer', c.id)), 'server', 'ae');
    expect(server).toContain('승인 권한은 멤버십 역할로 정해집니다 — 팀 · 권한에서 관리자가 바꿉니다');
    expect(server).not.toContain('상단 역할 선택에서');
    const demo = await render(h(await harness('drawer', c.id)), 'demo');
    expect(demo).toContain('상단 역할 선택에서 PM(으)로 바꾸면 처리할 수 있습니다');
    expect(demo).not.toContain('멤버십 역할로 정해집니다');
  });
});
