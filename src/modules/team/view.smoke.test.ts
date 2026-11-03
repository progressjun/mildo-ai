/**
 * 팀 · 권한 화면 렌더 (SSR) — 데모 모드 예시 + 안내, 서버 모드 역할별 조작 노출(관리자 · 소유자 · 열람자), 모든 탭, 확인 중 · 워크스페이스 없음 상태.
 * 화면 규칙: 하드코딩 색상 없음 · window.alert/confirm/prompt/open 없음.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '@/core/permissions';
import { demoInvites, demoMembers, demoSessions } from './demo';
import type { TeamHandlers, TeamScreenProps, TeamTab } from './View';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

const NOW = Date.parse('2026-11-02T03:00:00Z');
const noop = () => undefined;
const HANDLERS: TeamHandlers = {
  onRole: noop, onTitle: noop, onStatus: noop, onRemove: noop, onResetLink: noop, onInvite: async () => false, onResend: noop, onRevoke: noop,
  onRevokeSession: noop, onRevokeOthers: noop, onChangePassword: async () => false, onReload: noop,
};

async function screen(myRole: Role, meId: string, tab: TeamTab = 'members', extra: Partial<TeamScreenProps> = {}): Promise<string> {
  const { TeamScreen } = await import('./View');
  const members = demoMembers(NOW).map((m) => ({ ...m, is_me: m.user_id === meId }));
  const manage = myRole === 'owner' || myRole === 'admin';
  return wrap(h(TeamScreen, {
    mode: 'server', workspaceName: '수면밀도 퍼포먼스', myRole, members, invites: manage ? demoInvites(NOW) : null, sessions: demoSessions(NOW),
    error: null, busy: null, lastInvite: null, nowMs: NOW, handlers: HANDLERS, initialTab: tab, ...extra,
  }));
}

describe('팀 · 권한 화면', () => {
  it('데모 모드: 예시 안내 · TEST DATA · 구성원 표 · 조작 꺼짐', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    for (const s of ['팀 · 권한', '예시 화면', 'TEST DATA', '서버(MILDO OS Cloud)에 연결하지 않은 시연 모드', '구성원', '활성 소유자', '단일 소유자', '30일 미접속', '운영 책임자 (예시)', '내 계정 보안', '역할 · 권한 표', '조작 버튼이 꺼져 있습니다']) {
      expect(html, s).toContain(s);
    }
    expect(html).toMatch(/<select[^>]*disabled/);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  }, 30_000);

  it('서버 모드 · 관리자: 역할 선택(소유자 제외) · 제외 버튼 · LIVE 표시, 소유자 행은 선택 불가', async () => {
    const html = await screen('admin', 'demo-admin');
    expect(html).toContain('LIVE');
    expect(html).not.toContain('예시 화면');
    expect(html).toContain('aria-label="김PM (예시) 역할"');
    expect(html).not.toContain('aria-label="운영 책임자 (예시) 역할"');
    expect(html).not.toContain('aria-label="운영 관리자 (예시) 역할"');
    const pmSelect = html.match(/aria-label="김PM \(예시\) 역할"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
    expect(pmSelect).not.toContain('소유자');
    expect(pmSelect).toContain('관리자');
    expect(html).toContain('나가기');
    expect(html).toContain('제외');
    expect(html).toContain('유효 세션');
    expect(html).not.toMatch(/<select[^>]*disabled/);
  });

  it('서버 모드 · 소유자: 소유자 지정 선택지', async () => {
    const html = await screen('owner', 'demo-owner');
    const pmSelect = html.match(/aria-label="김PM \(예시\) 역할"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
    expect(pmSelect).toContain('소유자');
  });

  it('서버 모드 · 열람자: 선택 · 제외 · 세션 수 없음, 초대 탭은 권한 안내', async () => {
    const html = await screen('viewer', 'demo-viewer');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('정말 제외');
    expect(html).not.toContain('유효 세션');
    const inv = await screen('viewer', 'demo-viewer', 'invites');
    expect(inv).toContain('초대는 관리자 · 소유자만 할 수 있습니다');
  });

  it('비밀번호 재설정 링크: 관리자 · 소유자는 다른 구성원에 발급 버튼(소유자 계정은 소유자만 — 관리자에게는 꺼짐 + 이유), 열람자에게는 없음', async () => {
    const admin = await screen('admin', 'demo-admin');
    expect(admin).toContain('재설정 링크');
    // 관리자 화면에서 소유자 행의 발급 버튼은 꺼져 있고 이유가 title로 보인다
    expect(admin).toMatch(/<button[^>]*disabled=""[^>]*title="소유자 계정의 재설정 링크는 소유자만 발급할 수 있습니다"/);
    const owner = await screen('owner', 'demo-owner');
    expect(owner).not.toContain('소유자 계정의 재설정 링크는 소유자만 발급할 수 있습니다');
    const viewer = await screen('viewer', 'demo-viewer');
    expect(viewer).not.toContain('재설정 링크');
  });

  it('재설정 링크 결과: 메일을 못 보냈으면 복사할 링크 + 사유, 메일로 보냈으면 링크를 보이지 않는다', async () => {
    const link = 'https://app.example.com/?reset=resetTOKEN_abc123xyz7890';
    const notSent = await screen('admin', 'demo-admin', 'members', {
      lastReset: { ok: true, name: '김PM (예시)', email: 'pm@example.com', expiresAt: '2026-11-02T04:00:00Z', mail: { sent: false, reason: 'SMTP가 설정되지 않았습니다 (SMTP_HOST) — 메일을 보내지 않았습니다' }, link },
    });
    for (const t of ['메일은 보내지 않았습니다', link, '재설정 링크 복사', 'SMTP가 설정되지 않았습니다', '본인에게만 전달하세요']) expect(notSent, t).toContain(t);
    const sent = await screen('admin', 'demo-admin', 'members', {
      lastReset: { ok: true, name: '김PM (예시)', email: 'pm@example.com', expiresAt: '2026-11-02T04:00:00Z', mail: { sent: true } },
    });
    expect(sent).toContain('재설정 링크 메일을 보냈습니다');
    expect(sent).not.toContain('?reset=');
  });

  it('초대 탭: 초대 폼(소유자 역할 없음) · 대기 · 만료 · 메일 미발송 · 복사 가능한 링크', async () => {
    const { demoInvites: inv } = await import('./demo');
    const html = await screen('admin', 'demo-admin', 'invites', {
      lastInvite: { invite: inv(NOW)[1], link: 'https://app.example.com/?invite=abcDEF123_-xyz0987654321', mail: { sent: false, reason: 'SMTP가 설정되지 않았습니다 (SMTP_HOST)' } },
    });
    for (const s of ['구성원 초대', '초대할 이메일', '초대 보내기', '수락 대기', '만료', '미발송', '다시 보내기', '초대 링크 복사', 'https://app.example.com/?invite=abcDEF123_-xyz0987654321', 'SMTP가 설정되지 않았습니다']) {
      expect(html, s).toContain(s);
    }
    const roleSelect = html.match(/id="team-invite-role"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
    expect(roleSelect).not.toContain('소유자');
    expect(roleSelect).toContain('담당 AE');
  });

  it('내 계정 보안 탭: 세션 표(현재 세션 · 다른 기기 로그아웃) · 비밀번호 변경', async () => {
    const html = await screen('ae', 'demo-ae', 'account');
    for (const s of ['내 접속 세션', '현재 세션', 'Chrome · macOS', 'Safari · iOS', '다른 기기 1곳 로그아웃', '비밀번호 변경', '현재 비밀번호', '새 비밀번호 확인', '10자 이상']) {
      expect(html, s).toContain(s);
    }
  });

  it('역할 · 권한 표 탭: 6개 역할 × 권한, 규칙 설명', async () => {
    const html = await screen('pm', 'demo-pm', 'roles');
    for (const s of ['소유자', '관리자', 'PM', '담당 AE', '광고주 담당자', '열람자', '팀 관리', '실반영(live) 켜기', '마지막 소유자 보호']) expect(html, s).toContain(s);
    expect(html).not.toMatch(/^\s*\d+[.)]\s/m);
  });

  it('불러오는 중 · 오류 표시', async () => {
    const html = await screen('admin', 'demo-admin', 'members', { members: null, error: '구성원: 서버 오류' });
    expect(html).toContain('불러오지 못한 항목이 있습니다');
    expect(html).toContain('구성원을 불러오는 중입니다');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('서버 모드 확인 중 · 워크스페이스 없음', async () => {
    const { SaasTestProvider } = await import('@/saas/context');
    const View = (await import('./View')).default as ComponentType;
    const checking = await wrap(h(SaasTestProvider, { value: { mode: 'checking' }, children: h(View) }));
    expect(checking).toContain('서버 연결을 확인하는 중입니다');
    const none = await wrap(h(SaasTestProvider, { value: { mode: 'server', workspace: null }, children: h(View) }));
    expect(none).toContain('워크스페이스가 없습니다');
  });
});

describe('화면 규칙', () => {
  it('팀 · 감사 모듈 파일에 하드코딩 색상 · 브라우저 기본 대화상자가 없다', () => {
    for (const dir of ['src/modules/team', 'src/modules/audit']) {
      for (const f of readdirSync(dir).filter((x) => /\.(tsx|css)$/.test(x))) {
        const src = readFileSync(join(dir, f), 'utf8');
        expect(src, `${dir}/${f} hex color`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(src, `${dir}/${f} dialogs`).not.toMatch(/window\.(alert|confirm|prompt|open)\s*\(|\b(alert|confirm|prompt)\s*\(/);
      }
    }
  });
});
