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
    // 재설정: 열자마자 링크를 먼저 확인 (POST /auth/password-reset/check) — 확인 전에는 폼 대신 안내
    const checking = await render({ mode: 'server' }, h(ResetScreen, { token: 'tok_reset_123', onDone: () => undefined }));
    expect(checking).toContain('재설정 링크를 확인하는 중');
    expect(checking).not.toContain('id="reset-password"');
    // 쓸 수 있는 링크: 가린 이메일 · 유효 시각 · 새 비밀번호 · 확인
    const rst = await render({ mode: 'server' }, h(ResetScreen, { token: 'tok_reset_123', onDone: () => undefined, initialCheck: { valid: true, reason: null, email: 'p***@mildo.local', expiresAt: '2026-11-03T01:30:00Z' } }));
    expect(rst).toContain('id="reset-password"');
    expect(rst).toContain('id="reset-password2"');
    expect(rst).toContain('10자 이상');
    expect(rst).toContain('p***@mildo.local');
    expect(rst).toContain('11/3 10:30까지');
    // 확인 API를 쓸 수 없을 때(null)는 폼을 보여 주고 confirm이 판정
    expect(await render({ mode: 'server' }, h(ResetScreen, { token: 'tok_reset_123', onDone: () => undefined, initialCheck: null }))).toContain('id="reset-password"');
    // 사용된 · 만료된 링크: 폼 없이 사유 + 다시 받기
    const used = await render({ mode: 'server' }, h(ResetScreen, { token: 'tok_reset_123', onDone: () => undefined, initialCheck: { valid: false, reason: 'used', email: null, expiresAt: null } }));
    expect(used).toContain('이미 사용했거나 새 링크로 바뀐 재설정 링크입니다');
    expect(used).toContain('재설정 메일 다시 받기');
    expect(used).not.toContain('id="reset-password"');
    const expired = await render({ mode: 'server' }, h(ResetScreen, { token: 'tok_reset_123', onDone: () => undefined, initialCheck: { valid: false, reason: 'expired', email: null, expiresAt: null } }));
    expect(expired).toContain('재설정 링크가 만료되었습니다');
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
  it('재설정 메일 요청 결과: SMTP 미설정이면 "보냈다"고 하지 않고 관리자의 링크 발급을 안내, 설정돼 있으면 요청 접수(발송 결과를 단정하지 않음)', async () => {
    const { forgotOutcome, FORGOT_NOTICE, FORGOT_BUTTON } = await import('./AuthScreens');
    expect(forgotOutcome({ mail: { configured: false } })).toBe('no_mail');
    expect(forgotOutcome({ mail: { configured: true } })).toBe('requested');
    expect(forgotOutcome({})).toBe('requested'); // 이전 서버(mail 없음)
    expect(FORGOT_NOTICE.no_mail).toMatch(/SMTP/);
    expect(FORGOT_NOTICE.no_mail).toMatch(/메일은 보내지 않았습니다/);
    expect(FORGOT_NOTICE.no_mail).toMatch(/재설정 링크 발급/);
    expect(FORGOT_BUTTON.no_mail).not.toMatch(/보냈습니다/);
    for (const k of ['requested', 'no_mail'] as const) expect(FORGOT_NOTICE[k]).not.toMatch(/메일로 보냈습니다/);
    expect(FORGOT_BUTTON.requested).not.toMatch(/메일을 보냈습니다/);
  });

  it('로그인 429: 서버 문구(대기 시간 · 잠금 안내)를 그대로 보인다', async () => {
    const { authErrorMessage } = await import('./AuthScreens');
    const { ApiError } = await import('./api');
    expect(authErrorMessage(new ApiError(429, 'rate_limited', '로그인 시도가 너무 많습니다. 42초 후 다시 시도해 주세요'), 'login')).toBe('로그인 시도가 너무 많습니다. 42초 후 다시 시도해 주세요');
    const lock = '로그인 실패가 15분 안에 10회에 이르러 이 계정의 로그인을 잠시 막았습니다. 약 14분 뒤 다시 시도하거나 비밀번호 재설정을 이용해 주세요';
    expect(authErrorMessage(new ApiError(429, 'login_locked', lock, { retryAfterSec: 801 }), 'login')).toBe(lock);
  });

  it('초대 수락 · 재설정 오류: 서버의 한국어 사유를 그대로 (잠금 · 비활성 · 워크스페이스 잠김 · 보안 토큰 · 링크 사용됨/만료)', async () => {
    const { authErrorMessage } = await import('./AuthScreens');
    const { ApiError } = await import('./api');
    const E = (status: number, code: string, msg: string) => new ApiError(status, code, msg);
    expect(authErrorMessage(E(409, 'invite_used', 'x'), 'invite')).toBe('이미 수락한 초대입니다. 로그인해 주세요.');
    expect(authErrorMessage(E(401, 'password_required', '이미 가입된 이메일입니다. 이 계정의 비밀번호를 입력해 주세요'), 'invite')).toBe('이미 가입된 이메일입니다. 이 계정의 비밀번호를 입력해 주세요');
    expect(authErrorMessage(E(401, 'invalid_credentials', '비밀번호가 맞지 않습니다. 비밀번호를 잊었다면 로그인 화면에서 재설정해 주세요'), 'invite')).toMatch(/비밀번호가 맞지 않습니다/);
    expect(authErrorMessage(E(403, 'account_disabled', '비활성화된 계정입니다. 워크스페이스 관리자에게 문의해 주세요'), 'invite')).toMatch(/비활성화된 계정/);
    expect(authErrorMessage(E(423, 'workspace_locked', '이 워크스페이스는 현재 새 구성원을 받을 수 없습니다'), 'invite')).toMatch(/새 구성원을 받을 수 없습니다/);
    expect(authErrorMessage(E(429, 'login_locked', '로그인 실패가 15분 안에 10회를 넘어 이 계정의 로그인을 잠시 막았습니다. 약 15분 뒤 다시 시도하거나 비밀번호 재설정을 이용해 주세요'), 'invite')).toMatch(/약 15분 뒤/);
    expect(authErrorMessage(E(429, 'login_locked', '로그인 실패가 15분 안에 10회를 넘어 이 계정의 로그인을 잠시 막았습니다. 약 3분 뒤 다시 시도하거나 비밀번호 재설정을 이용해 주세요'), 'login')).toMatch(/약 3분 뒤/);
    expect(authErrorMessage(E(403, 'csrf', '보안 토큰이 맞지 않습니다. 새로고침 후 다시 시도해 주세요'), 'invite')).toMatch(/보안 토큰/);
    expect(authErrorMessage(E(410, 'invite_expired', '초대 링크가 만료되었습니다 (7일). 관리자에게 초대를 다시 보내 달라고 요청해 주세요'), 'invite')).toMatch(/7일/);
    expect(authErrorMessage(E(400, 'reset_used', '이미 사용했거나 새 링크로 바뀐 재설정 링크입니다. 가장 최근 메일의 링크를 쓰거나 다시 요청해 주세요'), 'reset')).toMatch(/가장 최근 메일/);
    expect(authErrorMessage(E(400, 'reset_expired', 'x'), 'reset')).toMatch(/재설정 링크가 만료되었습니다/);
    expect(authErrorMessage(E(400, 'reset_invalid', 'x'), 'reset')).toMatch(/재설정 링크가 올바르지 않습니다/);
    expect(authErrorMessage(E(400, 'weak_password', '비밀번호는 10자 이상이어야 합니다'), 'reset')).toBe('비밀번호는 10자 이상이어야 합니다');
  });
  it('초대: 이미 수락 · 만료 상태는 폼보다 먼저, 로그인 중인 초대 대상은 수락 버튼만, 기존 계정은 비밀번호만', async () => {
    const { InviteScreen } = await import('./AuthScreens');
    const InviteView = ({ info }: { info: import('./sync').InviteInfo }) => h(InviteScreen, { token: 'tok_invite_123', onDone: () => undefined, initialInfo: info });
    const base = { email: 'n@x.io', role: 'pm' as const, workspaceName: '수면밀도 퍼포먼스', brandName: '수면밀도', expiresAt: null, invitedBy: '운영 책임자' };
    const accepted = await render({ mode: 'server' }, h(InviteView, { info: { ...base, accepted: true } }));
    expect(accepted).toContain('이미 수락한 초대입니다');
    expect(accepted).not.toContain('id="invite-password"');
    const expired = await render({ mode: 'server' }, h(InviteView, { info: { ...base, expired: true } }));
    expect(expired).toContain('초대 링크가 만료되었습니다');
    expect(expired).not.toContain('id="invite-name"');
    const me = await render({ mode: 'server' }, h(InviteView, { info: { ...base, existingUser: true, signedInAsInvitee: true } }));
    expect(me).toContain('초대받은 계정으로 로그인되어 있습니다');
    expect(me).not.toContain('id="invite-password"');
    expect(me).toContain('초대 수락하고 시작하기');
    const existing = await render({ mode: 'server' }, h(InviteView, { info: { ...base, existingUser: true } }));
    expect(existing).toContain('id="invite-password"');
    expect(existing).not.toContain('id="invite-name"');
    expect(existing).not.toContain('id="invite-password2"');
    const fresh = await render({ mode: 'server' }, h(InviteView, { info: base }));
    expect(fresh).toContain('id="invite-name"');
    expect(fresh).toContain('id="invite-password2"');
    expect(fresh).toContain('PM');
    expect(fresh).toContain('운영 책임자');
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
