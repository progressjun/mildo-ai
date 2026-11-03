/**
 * 팀 · 권한 규칙 (docs/SAAS_SPEC.md §2 역할 표 · §4 team) — 순수 모듈.
 * 서버(server/src/team)가 최종 판정에 쓰고, 화면은 같은 함수로 버튼 · 선택지를 미리 막는다(판정 기준이 한 곳).
 *
 * 규칙 요약
 *   팀 관리(manage_team)는 admin · owner만.
 *   소유자 권한을 주거나 회수(소유자 역할 변경 · 제외 · 계정 비활성화)하는 일은 소유자만.
 *   자기 역할 · 자기 계정 상태는 직접 바꾸지 않는다(다른 관리자에게 요청).
 *   활성 소유자가 0명이 되는 변경은 막는다(마지막 소유자 보호).
 *   초대로는 소유자 권한을 줄 수 없다(가입 후 소유자가 역할을 바꾼다 — 소유권 이전은 두 단계).
 */
import { can, ROLES, ROLE_LABEL, type Role } from '@/core/permissions';

export { ROLE_LABEL };
export type { Role };

/** 화면 · 정렬 순서 (권한이 넓은 순) */
export const ROLE_ORDER: readonly Role[] = ROLES;
/** 초대로 줄 수 있는 역할 (invites.role CHECK와 같다) */
export const INVITABLE_ROLES: readonly Role[] = ['admin', 'pm', 'ae', 'client', 'viewer'];

export const ROLE_DESC: Record<Role, string> = {
  owner: '모든 권한 · 소유자 지정 · 광고주(CLIENT) 승인 · 실반영(live) 켜기',
  admin: '팀 관리 · 커넥션 · 설정 · 실반영(live) 켜기 · AE · PM 등급 승인',
  pm: '커넥션 · 설정 · 이슈 처리 · AE · PM 등급 승인',
  ae: '변경 요청 · 이슈 처리 · AE 등급 승인',
  client: '광고주 담당자: 의견 · 요청 · AE · PM · CLIENT 등급 승인',
  viewer: '읽기 전용',
};

export interface RuleProblem {
  status: 400 | 403 | 409;
  code: string;
  message: string;
}

const FORBIDDEN: RuleProblem = { status: 403, code: 'forbidden', message: '팀을 관리할 권한이 없습니다 (관리자 · 소유자만)' };
const OWNER_ONLY: RuleProblem = { status: 403, code: 'owner_only', message: '소유자 권한을 주거나 회수하는 일은 소유자만 할 수 있습니다' };
export const LAST_OWNER: RuleProblem = {
  status: 409,
  code: 'last_owner',
  message: '마지막 소유자입니다. 다른 구성원을 먼저 소유자로 지정한 뒤 다시 시도해 주세요',
};

/** 변경 대상 구성원 */
export interface MemberTarget {
  /** 요청한 사람 자신인지 */
  isSelf: boolean;
  role: Role;
  /** 계정이 활성 상태인지 (비활성 소유자는 소유자 수에 넣지 않는다) */
  active: boolean;
}

/** actor가 다른 구성원에게 주거나 회수할 수 있는 역할 */
export function grantableRoles(actor: Role | null | undefined): Role[] {
  if (!actor || !can(actor, 'manage_team')) return [];
  return can(actor, 'owner') ? [...ROLE_ORDER] : ROLE_ORDER.filter((r) => r !== 'owner');
}

/** 초대할 수 있는 역할 */
export function invitableRoles(actor: Role | null | undefined): Role[] {
  return grantableRoles(actor).filter((r) => INVITABLE_ROLES.includes(r));
}

export function inviteRoleProblem(actor: Role, role: Role): RuleProblem | null {
  if (!can(actor, 'manage_team')) return FORBIDDEN;
  if (role === 'owner') {
    if (!can(actor, 'owner')) return OWNER_ONLY;
    return {
      status: 400,
      code: 'owner_invite',
      message: '소유자 권한은 초대로 줄 수 없습니다. 관리자로 초대하고, 가입한 뒤 구성원 표에서 소유자로 바꿔 주세요',
    };
  }
  if (!INVITABLE_ROLES.includes(role)) return { status: 400, code: 'bad_role', message: '알 수 없는 역할입니다' };
  return null;
}

/**
 * 역할 변경 판정.
 * @param activeOwners 워크스페이스의 활성 소유자 수 (대상 포함)
 */
export function roleChangeProblem(actor: Role, target: MemberTarget, to: Role, activeOwners: number): RuleProblem | null {
  if (!can(actor, 'manage_team')) return FORBIDDEN;
  if (target.isSelf) {
    return { status: 403, code: 'self_role', message: '자기 역할은 직접 바꿀 수 없습니다. 다른 관리자 · 소유자에게 요청해 주세요' };
  }
  if ((to === 'owner' || target.role === 'owner') && !can(actor, 'owner')) return OWNER_ONLY;
  if (target.role === 'owner' && to !== 'owner' && target.active && activeOwners <= 1) return LAST_OWNER;
  return null;
}

/** 구성원 제외 판정 — 자기 자신(나가기)도 허용하되 마지막 소유자는 막는다 */
export function removalProblem(actor: Role, target: MemberTarget, activeOwners: number): RuleProblem | null {
  if (!can(actor, 'manage_team')) return FORBIDDEN;
  if (target.role === 'owner' && !target.isSelf && !can(actor, 'owner')) return OWNER_ONLY;
  if (target.role === 'owner' && target.active && activeOwners <= 1) return LAST_OWNER;
  return null;
}

/**
 * 계정 비활성화 · 재활성화 판정.
 * @param outsideScope 대상이 actor가 관리하지 못하는 다른 워크스페이스에도 소속되어 있는지
 *   (계정 비활성화는 모든 워크스페이스 로그인을 막으므로 그때는 '제외'를 쓰게 한다)
 * @param orphans 비활성화하면 활성 소유자가 0명이 되는 워크스페이스 수 (이 워크스페이스 포함)
 */
export function statusChangeProblem(actor: Role, target: MemberTarget, to: 'active' | 'disabled', outsideScope: boolean, orphans: number): RuleProblem | null {
  if (!can(actor, 'manage_team')) return FORBIDDEN;
  if (target.isSelf) return { status: 403, code: 'self_status', message: '자기 계정은 직접 비활성화 · 재활성화할 수 없습니다' };
  if (target.role === 'owner' && !can(actor, 'owner')) return OWNER_ONLY;
  if (to === 'disabled' && orphans > 0) return LAST_OWNER;
  if (outsideScope) {
    return {
      status: 409,
      code: 'shared_account',
      message: '관리 범위 밖의 다른 워크스페이스에도 소속된 계정입니다. 계정 비활성화 대신 이 워크스페이스에서 제외해 주세요',
    };
  }
  return null;
}

/** 역할 → 권한 표 (화면 · 에이전트 도구용) */
export const PERMISSION_LABEL: Record<string, string> = {
  read: '읽기',
  comment: '코멘트',
  request: '변경 요청',
  'approve:AE': 'AE 등급 승인',
  'approve:PM': 'PM 등급 승인',
  'approve:CLIENT': 'CLIENT 등급 승인',
  operate: '이슈 처리 · 수동 수집 · 리포트 발송',
  configure: '커넥션 · 알림 · 설정',
  manage_team: '팀 관리',
  live_write: '실반영(live) 켜기',
  owner: '소유자 지정',
};
