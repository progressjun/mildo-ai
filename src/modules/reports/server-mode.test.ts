/**
 * 리포트 서버 모드 (SSR) — 코멘트 단위 피드백의 '작성 역할'은 멤버십 역할을 읽기 전용으로 보여 주고(역할 전환 버튼 없음 —
 * role/set은 서버 모드에서 버려진다), 권한 밖 안내도 '상단 역할을 바꾸면'이 아니라 팀 · 권한 기준. 데모 모드는 그대로.
 * 스토어는 데모 상태(me 없음)로 두고 화면이 읽는 모드만 SaasTestProvider로 'server'를 준다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import type { Role } from '@/core/permissions';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

function setRole(role: '담당 AE' | 'PM' | '수면밀도') {
  mem['mildo-os/v1'] = JSON.stringify({ changes: [], incidents: [], comments: [], ai: { mode: 'offline' }, role, tf: {} });
}

async function render(mode: 'server' | 'demo', role: Role = 'pm'): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const View = (await import('./View')).default as ComponentType;
  const inner = h(StoreProvider, null, h(View));
  const tree = mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role }, children: inner }) : inner;
  return renderToString(tree).replace(/<!-- -->/g, '');
}

const AUTHOR_SEG = /role="group" aria-label="작성 역할"/;

describe('리포트 · 서버 모드 작성 역할', () => {
  it('서버 모드: 작성 역할은 멤버십 역할 읽기 전용 · 역할 전환 버튼 없음 · 바꾸는 곳은 팀 · 권한', async () => {
    setRole('PM');
    const html = await render('server', 'pm');
    expect(html).toContain('코멘트 단위 피드백');
    expect(html).not.toMatch(AUTHOR_SEG);
    expect(html).not.toContain('작성 역할 (상단 역할과 공유)');
    expect(html).toMatch(/aria-label="작성 역할 \(멤버십\)"[^>]*>PM</);
    expect(html).toContain('역할은 팀 · 권한에서 관리자가 바꿉니다');
    // 피드백이 없을 때 안내도 '상단 역할을 바꾸면'이 아니다
    expect(html).not.toContain('상단 역할을');
    expect(html).toContain('광고주 담당자 계정이 각 섹션 아래');
    // 다른 멤버십 역할은 그 이름으로
    expect(await render('server', 'owner')).toMatch(/aria-label="작성 역할 \(멤버십\)"[^>]*>소유자</);
  });

  it('서버 모드 · 광고주 담당자(client): AE 코멘트 권한 밖 안내는 멤버십 기준', async () => {
    setRole('수면밀도');
    const html = await render('server', 'client');
    expect(html).toMatch(/aria-label="작성 역할 \(멤버십\)"[^>]*>광고주 담당자</);
    expect(html).toContain('현재 멤버십 역할(광고주 담당자)은 AE 코멘트 작성 권한이 없습니다. 역할은 팀 · 권한에서 관리자가 바꿉니다.');
    expect(html).not.toContain('상단 역할을 담당 AE 또는 PM으로 바꾸면');
  });

  it('데모 모드는 그대로: 작성 역할 전환 3개 · 상단 역할 안내', async () => {
    setRole('PM');
    const html = await render('demo');
    expect(html).toMatch(AUTHOR_SEG);
    expect(html).toContain('작성 역할 (상단 역할과 공유)');
    expect(html).not.toContain('작성 역할 (멤버십)');
    expect(html).toContain('상단 역할을 &quot;수면밀도 담당자&quot;로 바꾸면 섹션 단위 피드백을 시연할 수 있습니다.');
    setRole('수면밀도');
    expect(await render('demo')).toContain('상단 역할을 담당 AE 또는 PM으로 바꾸면 작성할 수 있습니다.');
  });
});
