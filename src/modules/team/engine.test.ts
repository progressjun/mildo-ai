/** 팀 화면 순수 함수 — 비밀번호 안내 · 시각 표기 · 기기 요약 · 구성원별 가능 작업 · 요약 */
import { describe, expect, it } from 'vitest';
import { fmtKst, memberActions, passwordHint, relTime, summarizeTeam, uaSummary, type Member } from './engine';
import { demoInvites, demoMembers } from './demo';

const NOW = Date.parse('2026-11-02T03:00:00Z'); // KST 12:00

describe('표기', () => {
  it('passwordHint', () => {
    expect(passwordHint('short')).toMatch(/10자/);
    expect(passwordHint('alllowercaseletters')).toMatch(/2가지/);
    expect(passwordHint('Abcdefgh12')).toBeNull();
  });
  it('fmtKst · relTime', () => {
    expect(fmtKst('2026-11-01T15:30:00Z', NOW)).toBe('11.02 00:30');
    expect(fmtKst('2025-12-31T15:30:00Z', NOW)).toBe('01.01 00:30');
    expect(fmtKst('2025-12-30T15:30:00Z', NOW)).toBe('2025.12.31 00:30');
    expect(fmtKst(null, NOW)).toBe('—');
    expect(fmtKst('garbage', NOW)).toBe('—');
    expect(relTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('방금');
    expect(relTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5분 전');
    expect(relTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3시간 전');
    expect(relTime(new Date(NOW + 2 * 86_400_000 + 1000).toISOString(), NOW)).toBe('2일 후');
  });
  it('uaSummary', () => {
    expect(uaSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome · macOS');
    expect(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS');
    expect(uaSummary('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130 Safari/537.36 Edg/130')).toBe('Edge · Windows');
    expect(uaSummary(null)).toBe('알 수 없는 기기');
  });
});

describe('구성원별 가능 작업 (서버 규칙과 같음)', () => {
  const members = demoMembers(NOW);
  const byId = (id: string) => members.find((m) => m.user_id === id)!;
  it('admin: 소유자 역할 선택지 없음 · 소유자 행은 잠김 · 자기 행 잠김', () => {
    const asAdmin = members.map((m) => ({ ...m, is_me: m.user_id === 'demo-admin' }));
    const pm = memberActions('admin', asAdmin.find((m) => m.user_id === 'demo-pm')!, asAdmin);
    expect(pm.roleOptions).toEqual(['admin', 'pm', 'ae', 'client', 'viewer']);
    expect(pm.remove).toBeNull();
    const owner = memberActions('admin', asAdmin.find((m) => m.user_id === 'demo-owner')!, asAdmin);
    expect(owner.roleOptions).toEqual(['owner']);
    expect(owner.roleBlocked?.code).toBe('owner_only');
    expect(owner.remove?.code).toBe('owner_only');
    const self = memberActions('admin', asAdmin.find((m) => m.user_id === 'demo-admin')!, asAdmin);
    expect(self.roleOptions).toEqual(['admin']);
    expect(self.roleBlocked?.code).toBe('self_role');
    expect(self.disable?.code).toBe('self_status');
  });
  it('owner: 소유자 지정 가능 · 유일한 소유자는 나갈 수 없다', () => {
    const asOwner: Member[] = members.map((m) => ({ ...m, is_me: m.user_id === 'demo-owner' }));
    const pm = memberActions('owner', asOwner.find((m) => m.user_id === 'demo-pm')!, asOwner);
    expect(pm.roleOptions).toContain('owner');
    const self = memberActions('owner', asOwner.find((m) => m.user_id === 'demo-owner')!, asOwner);
    expect(self.remove?.code).toBe('last_owner');
  });
  it('팀 관리 권한 없으면 선택지 없음', () => {
    const a = memberActions('viewer', byId('demo-pm'), members);
    expect(a.roleOptions).toEqual(['pm']);
    expect(a.remove?.status).toBe(403);
    expect(memberActions(null, byId('demo-pm'), members).remove?.status).toBe(403);
  });
});

describe('요약', () => {
  it('summarizeTeam: 역할별 · 활성 소유자 · 대기 초대 · 30일 미접속 · 메일 실패', () => {
    const s = summarizeTeam(demoMembers(NOW), demoInvites(NOW), NOW);
    expect(s.members).toBe(7);
    expect(s.disabled).toBe(1);
    expect(s.owners).toBe(1);
    expect(s.pending).toBe(2);
    expect(s.expired).toBe(1);
    expect(s.dormant.map((m) => m.user_id)).toEqual(['demo-ae2']);
    expect(s.mailFailed.map((i) => i.email)).toEqual(['brand.lead@example.com']);
    expect(s.byRole.find((r) => r.role === 'ae')?.count).toBe(2);
  });
});

describe('장기 미접속 판정', () => {
  it('막 합류해 아직 로그인 전이면 미접속이 아니고, 합류 · 로그인 30일 초과면 미접속', async () => {
    const { isDormant } = await import('./engine');
    const day = 86_400_000;
    const base = { status: 'active' as const, last_login_at: null as string | null, joined_at: new Date(NOW - 2 * day).toISOString() };
    expect(isDormant(base, NOW)).toBe(false);
    expect(isDormant({ ...base, joined_at: new Date(NOW - 31 * day).toISOString() }, NOW)).toBe(true);
    expect(isDormant({ ...base, joined_at: new Date(NOW - 90 * day).toISOString(), last_login_at: new Date(NOW - 3 * day).toISOString() }, NOW)).toBe(false);
    expect(isDormant({ ...base, status: 'disabled', joined_at: new Date(NOW - 90 * day).toISOString() }, NOW)).toBe(false);
  });
});
