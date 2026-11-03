/** 팀 규칙 (서버 판정과 공유) — 역할별 부여 가능 범위 · 자기 역할 금지 · 소유자 권한 · 마지막 소유자 보호 */
import { describe, expect, it } from 'vitest';
import { grantableRoles, invitableRoles, inviteRoleProblem, removalProblem, roleChangeProblem, statusChangeProblem, type MemberTarget } from './rules';

const T = (role: MemberTarget['role'], o: Partial<MemberTarget> = {}): MemberTarget => ({ isSelf: false, role, active: true, ...o });

describe('부여 가능 역할', () => {
  it('owner는 전부, admin은 owner 제외, 나머지는 없음', () => {
    expect(grantableRoles('owner')).toEqual(['owner', 'admin', 'pm', 'ae', 'client', 'viewer']);
    expect(grantableRoles('admin')).toEqual(['admin', 'pm', 'ae', 'client', 'viewer']);
    for (const r of ['pm', 'ae', 'client', 'viewer'] as const) expect(grantableRoles(r)).toEqual([]);
    expect(grantableRoles(null)).toEqual([]);
    expect(invitableRoles('owner')).toEqual(['admin', 'pm', 'ae', 'client', 'viewer']);
    expect(invitableRoles('admin')).not.toContain('owner');
  });

  it('초대: 소유자 역할은 admin 403 · owner 400, 팀 관리 권한 없으면 403', () => {
    expect(inviteRoleProblem('admin', 'owner')).toMatchObject({ status: 403, code: 'owner_only' });
    expect(inviteRoleProblem('owner', 'owner')).toMatchObject({ status: 400, code: 'owner_invite' });
    expect(inviteRoleProblem('pm', 'viewer')).toMatchObject({ status: 403 });
    expect(inviteRoleProblem('admin', 'admin')).toBeNull();
  });
});

describe('역할 변경', () => {
  it('자기 역할 · 소유자 권한 · 마지막 소유자', () => {
    expect(roleChangeProblem('owner', T('owner', { isSelf: true }), 'admin', 2)?.code).toBe('self_role');
    expect(roleChangeProblem('admin', T('admin', { isSelf: true }), 'pm', 1)?.code).toBe('self_role');
    expect(roleChangeProblem('admin', T('pm'), 'owner', 1)?.code).toBe('owner_only');
    expect(roleChangeProblem('admin', T('owner'), 'admin', 2)?.code).toBe('owner_only');
    expect(roleChangeProblem('owner', T('owner'), 'admin', 1)?.code).toBe('last_owner');
    expect(roleChangeProblem('owner', T('owner'), 'admin', 2)).toBeNull();
    expect(roleChangeProblem('owner', T('owner', { active: false }), 'admin', 1)).toBeNull();
    expect(roleChangeProblem('admin', T('ae'), 'pm', 1)).toBeNull();
    expect(roleChangeProblem('pm', T('ae'), 'viewer', 1)?.status).toBe(403);
  });
});

describe('제외 · 비활성화', () => {
  it('제외: 관리자는 소유자를 못 빼고, 마지막 활성 소유자는 나갈 수 없다', () => {
    expect(removalProblem('admin', T('owner'), 2)?.code).toBe('owner_only');
    expect(removalProblem('owner', T('owner', { isSelf: true }), 1)?.code).toBe('last_owner');
    expect(removalProblem('owner', T('owner', { isSelf: true }), 2)).toBeNull();
    expect(removalProblem('admin', T('admin', { isSelf: true }), 1)).toBeNull();
    expect(removalProblem('viewer', T('viewer', { isSelf: true }), 1)?.status).toBe(403);
  });

  it('비활성화: 자기 계정 · 소유자(관리자가) · 소유자 0명 · 범위 밖 소속', () => {
    expect(statusChangeProblem('admin', T('ae', { isSelf: true }), 'disabled', false, 0)?.code).toBe('self_status');
    expect(statusChangeProblem('admin', T('owner'), 'disabled', false, 0)?.code).toBe('owner_only');
    expect(statusChangeProblem('owner', T('owner'), 'disabled', false, 1)?.code).toBe('last_owner');
    expect(statusChangeProblem('admin', T('ae'), 'disabled', true, 0)?.code).toBe('shared_account');
    expect(statusChangeProblem('admin', T('ae'), 'disabled', false, 0)).toBeNull();
    expect(statusChangeProblem('admin', T('ae', { active: false }), 'active', false, 0)).toBeNull();
  });
});
