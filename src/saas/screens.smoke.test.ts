/**
 * 플랫폼 화면 렌더 스모크 (SSR) — 로그인 · 초대 · 재설정 · 워크스페이스 없음 화면, 서버 모드 셸 진입 분기,
 * 서버 모드 스토어가 동기화 전에는 모듈 화면 대신 시작 화면을 그리는지, 데모 모드 셸이 지금과 같은지(역할 선택 · TEST DATA).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Me, SaasValue, WorkspaceDetail } from './context';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const WS = { id: '11111111-1111-1111-1111-111111111111', slug: 'mildo', name: '수면밀도 퍼포먼스', brand_name: '수면밀도', status: 'active', role: 'pm' as const, permissions: ['read', 'comment', 'request', 'approve:AE', 'approve:PM', 'operate', 'configure'] as never, demoRole: 'PM' as const };
const ME: Me = { user: { id: 'u1', email: 'pm@mildo.local', name: '김PM' }, workspaces: [WS] };
const DETAIL: WorkspaceDetail = { workspace: { ...WS, config: {} }, role: 'pm', permissions: WS.permissions, demoRole: 'PM' };

async function render(value: Partial<SaasValue>, node: ReactNode): Promise<string> {
  const { SaasTestProvider } = await import('./context');
  return renderToString(h(SaasTestProvider, { value, children: node })).replace(/<!-- -->/g, '');
}

describe('로그인 전 화면', () => {
  it('로그인: 이메일 · 비밀번호 · 재설정 메일 링크 · 세션 만료 안내', async () => {
    const { LoginScreen } = await import('./AuthScreens');
    const html = await render({ mode: 'server', notice: '세션이 만료되었습니다' }, h(LoginScreen));
    expect(html).toContain('id="login-email"');
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
    expect(html).toContain('비밀번호 재설정 메일 받기');
    expect(html).toContain('세션이 만료되었습니다');
    expect(html).toContain('MILDO');
    expect(html).not.toMatch(/\b1\.\s/); // 번호 매기기 없음
  });
  it('초대 수락: 초대 정보를 확인하는 동안 안내, 재설정: 새 비밀번호 · 확인', async () => {
    const { InviteScreen, ResetScreen, AuthScreens } = await import('./AuthScreens');
    const inv = await render({ mode: 'server' }, h(InviteScreen, { token: 'tok_invite_123', onDone: () => undefined }));
    expect(inv).toContain('초대 수락');
    expect(inv).toContain('초대 정보를 확인하는 중');
    const rst = await render({ mode: 'server' }, h(ResetScreen, { token: 'tok_reset_123', onDone: () => undefined }));
    expect(rst).toContain('id="reset-password"');
    expect(rst).toContain('id="reset-password2"');
    expect(rst).toContain('10자 이상');
    const routed = await render({ mode: 'server' }, h(AuthScreens, { tokens: { invite: null, reset: 'tok_reset_123' }, onTokensUsed: () => undefined }));
    expect(routed).toContain('새 비밀번호 정하기');
  });
  it('소속 워크스페이스 없음 · 워크스페이스 오류', async () => {
    const { NoWorkspaceScreen, WorkspaceErrorScreen } = await import('./AuthScreens');
    const none = await render({ mode: 'server', me: { ...ME, workspaces: [] } }, h(NoWorkspaceScreen));
    expect(none).toContain('소속된 워크스페이스가 없습니다');
    expect(none).toContain('pm@mildo.local');
    const err = await render({ mode: 'server', me: ME }, h(WorkspaceErrorScreen, { message: '서버 오류가 발생했습니다' }));
    expect(err).toContain('다시 시도');
  });
  it('인증 오류 문구: 속도 제한 · 잘못된 비밀번호 · 만료 링크', async () => {
    const { authErrorMessage } = await import('./AuthScreens');
    const { ApiError } = await import('./api');
    expect(authErrorMessage(new ApiError(429, 'rate_limited', 'x'), 'login')).toMatch(/로그인 시도가 너무 많습니다/);
    expect(authErrorMessage(new ApiError(401, 'invalid_credentials', '이메일 또는 비밀번호가 맞지 않습니다'), 'login')).toBe('이메일 또는 비밀번호가 맞지 않습니다');
    expect(authErrorMessage(new ApiError(404, 'not_found', 'x'), 'invite')).toMatch(/초대 링크가 만료/);
    expect(authErrorMessage(new ApiError(410, 'gone', 'x'), 'reset')).toMatch(/재설정 링크가 만료/);
    expect(authErrorMessage(new ApiError(0, 'network', 'x'), 'forgot')).toMatch(/연결할 수 없습니다/);
  });
});

describe('진입 분기 (AppGate)', () => {
  it('확인 중 → 시작 화면, 서버 모드 로그인 전 → 로그인, 워크스페이스 정보 전 → 여는 중', async () => {
    const { AppGate } = await import('./Gate');
    expect(await render({ mode: 'checking' }, h(AppGate))).toContain('서버 연결을 확인하고 있습니다');
    expect(await render({ mode: 'server', me: null }, h(AppGate))).toContain('id="login-email"');
    expect(await render({ mode: 'server', me: ME, workspace: WS, detail: null }, h(AppGate))).toContain('워크스페이스를 여는 중');
    expect(await render({ mode: 'server', me: ME, workspace: WS, detail: null, detailError: '권한이 없습니다' }, h(AppGate))).toContain('권한이 없습니다');
    expect(await render({ mode: 'server', me: { ...ME, workspaces: [] }, workspace: null }, h(AppGate))).toContain('소속된 워크스페이스가 없습니다');
  });
  it('서버 모드 스토어는 서버 데이터를 불러오기 전에는 모듈 화면을 그리지 않는다 (모듈 로컬 입력을 먼저 localStorage에)', async () => {
    const { StoreProvider } = await import('@/core/store');
    const html = await render({ mode: 'server', me: ME, workspace: WS, detail: DETAIL, can: () => true }, h(StoreProvider, null, h('div', { id: 'module-probe' }, 'MODULE')));
    expect(html).not.toContain('module-probe');
    expect(html).toContain('워크스페이스를 준비하는 중');
  });
  it('데모 모드 스토어는 지금처럼 바로 그린다', async () => {
    const { StoreProvider } = await import('@/core/store');
    const html = renderToString(h(StoreProvider, null, h('div', { id: 'module-probe' }, 'MODULE')));
    expect(html).toContain('module-probe');
  });
});

describe('상단 바 부품 · 출처 태그', () => {
  it('사용자 메뉴: 이름 · 한국어 역할 · (메뉴 열기 버튼), 워크스페이스 전환은 둘 이상일 때만', async () => {
    const { UserMenu, WorkspaceSwitcher } = await import('./TopbarParts');
    const menu = await render({ mode: 'server', me: ME, workspace: WS, detail: DETAIL }, h(UserMenu));
    expect(menu).toContain('김PM');
    expect(menu).toContain('PM');
    expect(menu).toContain('aria-haspopup="menu"');
    expect(await render({ mode: 'server', me: ME, workspace: WS }, h(WorkspaceSwitcher))).toBe('');
    const two = { ...ME, workspaces: [WS, { ...WS, id: '22222222-2222-2222-2222-222222222222', brand_name: '다른 브랜드', role: 'viewer' as const }] };
    const sw = await render({ mode: 'server', me: two, workspace: WS, switchWorkspace: () => undefined }, h(WorkspaceSwitcher));
    expect(sw).toContain('id="workspace-select"');
    expect(sw).toContain('다른 브랜드 · 열람자');
  });
  it('Src DEMO: 스토어 밖 · 데모 데이터는 TEST DATA (기존 툴팁)', async () => {
    const { Src } = await import('@/ui/primitives');
    const html = renderToString(h(Src, { kind: 'DEMO' }));
    expect(html).toContain('TEST DATA');
    expect(html).toContain('class="src demo"');
    expect(html).toContain('시연용 테스트 데이터');
    const titled = renderToString(h(Src, { kind: 'DEMO', title: '모듈 설명' }));
    expect(titled).toContain('title="모듈 설명"');
    expect(renderToString(h(Src, { kind: 'PROPOSAL', page: 'p.14' })).replace(/<!-- -->/g, '')).toContain('제안서 p.14');
  });
});
