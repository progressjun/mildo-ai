/**
 * 역할 → 권한 (docs/SAAS_SPEC.md §2). 서버의 모든 쓰기 판정은 이 표를 쓴다.
 * 프런트도 같은 파일을 import해 버튼 활성 여부를 맞출 수 있다(순수 모듈).
 */
import { withJosa } from './util';

export type Role = 'owner' | 'admin' | 'pm' | 'ae' | 'client' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'admin', 'pm', 'ae', 'client', 'viewer'];

export type Permission =
  | 'read'
  | 'comment'
  | 'request'        // 변경 요청 생성
  | 'approve:AE'
  | 'approve:PM'
  | 'approve:CLIENT'
  | 'operate'        // 이슈 처리 · 수동 수집 · 리포트 발송
  | 'configure'      // 커넥션 · 알림 채널 · 워크스페이스 설정
  | 'manage_team'
  | 'live_write'     // 커넥션 쓰기 모드를 live로
  | 'owner';

const MATRIX: Record<Role, readonly Permission[]> = {
  viewer: ['read'],
  client: ['read', 'comment', 'request', 'approve:AE', 'approve:PM', 'approve:CLIENT'],
  ae: ['read', 'comment', 'request', 'approve:AE', 'operate'],
  pm: ['read', 'comment', 'request', 'approve:AE', 'approve:PM', 'operate', 'configure'],
  admin: ['read', 'comment', 'request', 'approve:AE', 'approve:PM', 'operate', 'configure', 'manage_team', 'live_write'],
  owner: ['read', 'comment', 'request', 'approve:AE', 'approve:PM', 'approve:CLIENT', 'operate', 'configure', 'manage_team', 'live_write', 'owner'],
};

export const can = (role: Role, perm: Permission): boolean => MATRIX[role]?.includes(perm) ?? false;
export const permissionsOf = (role: Role): Permission[] => [...(MATRIX[role] ?? [])];

/** 프런트 데모 3역할(store.role)로 표시용 매핑 */
export function demoRoleOf(role: Role): '담당 AE' | 'PM' | '수면밀도' {
  if (role === 'client') return '수면밀도';
  if (role === 'pm' || role === 'admin' || role === 'owner') return 'PM';
  return '담당 AE';
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: '소유자', admin: '관리자', pm: 'PM', ae: '담당 AE', client: '광고주 담당자', viewer: '열람자',
};

/* ------------------------------------------------------------------ */
/* 변경 요청 화면 권한 — 서버 판정(server/src/changes/policy.ts checkActionPermission)과 같은 규칙       */
/* ------------------------------------------------------------------ */

/** 승인 등급 (src/core/types ApprovalLevel과 같은 값) */
export type ApprovalLevel = 'AE' | 'PM' | 'CLIENT';
export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ['AE', 'PM', 'CLIENT'];
const LEVEL_LABEL: Record<ApprovalLevel, string> = { AE: '담당 AE', PM: 'PM', CLIENT: '수면밀도' };

/**
 * 화면 권한 판정 주체.
 *  - 데모 모드: 데모 3역할 문자열(store.role — 상단 역할 선택으로 시연, 기존 규칙 그대로)
 *  - 서버 모드: 멤버십 역할 { member } — 서버와 같은 권한표 · 같은 전이별 판정으로 버튼을 켜고 끈다
 *    (데모 매핑 demoRoleOf는 표시용이라 viewer → '담당 AE', owner → 'PM'처럼 권한이 달라진다 — 판정에 쓰지 않는다)
 */
export interface MemberActor { member: Role }
export type Actor = string | MemberActor;
export const isMemberActor = (a: unknown): a is MemberActor =>
  !!a && typeof a === 'object' && typeof (a as MemberActor).member === 'string';
/** 표시 이름: 데모 3역할은 그대로, 멤버십 역할은 한국어 이름 */
export const actorLabel = (a: Actor): string => (isMemberActor(a) ? ROLE_LABEL[a.member] ?? a.member : a || '미지정');

/** 역할이 승인할 수 있는 등급 (approve:AE|PM|CLIENT) */
export function approvalLevelsOf(role: Role): ApprovalLevel[] {
  return APPROVAL_LEVELS.filter((l) => can(role, `approve:${l}` as Permission));
}
/** 승인 등급 목록 문구 ('담당 AE · PM' · 없으면 '없음') */
export function approvalScopeText(role: Role): string {
  const l = approvalLevelsOf(role);
  return l.length ? l.map((x) => LEVEL_LABEL[x]).join(' · ') : '없음';
}

/** 변경 요청 상태 전이 액션 (MILDO Flow FlowAction + 서버 '재실행') */
export type ChangeAction = 'approve' | 'reject' | 'cancel' | 'hold' | 'resume' | 'apply' | 'retry' | 'rollback';
export interface PermCheck { ok: boolean; reason: string }

const READ_ONLY_REASON = (role: Role) => `${ROLE_LABEL[role]} 역할은 읽기 전용입니다 — 요청 · 승인 · 반영 권한이 없습니다`;

/**
 * 전이별 권한 — 서버 checkActionPermission과 같은 판정 (ok 값이 같아야 한다 · permissions.test.ts가 대조):
 *   승인 · 반려 · 실행 취소 = approve:<등급>
 *   보류 · 보류 해제 = operate
 *   반영 · 재실행 · 롤백 = approve:<등급> + operate (광고주 담당자는 승인 · 반려까지, CLIENT 건 반영은 소유자만)
 */
export function changeActionCheck(role: Role, approver: ApprovalLevel, action: ChangeAction): PermCheck {
  const lvl = LEVEL_LABEL[approver] ?? approver;
  const who = ROLE_LABEL[role] ?? role;
  const canLvl = can(role, `approve:${approver}` as Permission);
  const canOp = can(role, 'operate');
  if (!can(role, 'request') && !canLvl && !canOp) return { ok: false, reason: READ_ONLY_REASON(role) };
  switch (action) {
    case 'approve':
    case 'reject':
    case 'cancel':
      return canLvl
        ? { ok: true, reason: `${who} 승인 범위 (${approvalScopeText(role)} 건)` }
        : { ok: false, reason: `${lvl} 승인 건 — 현재 역할 ${who}의 승인 범위는 ${approvalScopeText(role)}` };
    case 'hold':
    case 'resume':
      return canOp
        ? { ok: true, reason: `${who} 운영 권한` }
        : { ok: false, reason: `보류 · 보류 해제는 운영 권한(담당 AE · PM · 관리자 · 소유자)이 필요합니다 — 현재 역할 ${who}` };
    case 'apply':
    case 'retry':
    case 'rollback':
      if (!canLvl) return { ok: false, reason: `${lvl} 승인 건의 반영 · 롤백은 ${lvl} 승인 권한이 있는 운영 역할만 할 수 있습니다 — 현재 역할 ${who}의 승인 범위는 ${approvalScopeText(role)}` };
      if (!canOp) return { ok: false, reason: `매체 반영 · 롤백은 운영 권한(담당 AE · PM · 관리자 · 소유자)이 필요합니다 — ${withJosa(who, '은/는')} 승인 · 반려까지 합니다` };
      return { ok: true, reason: `${who} 승인 범위 (${approvalScopeText(role)} 건) · 운영 권한` };
  }
}

/** 변경 요청 만들기 (POST /changes — 'request') */
export function requestCheck(role: Role): PermCheck {
  return can(role, 'request')
    ? { ok: true, reason: `${ROLE_LABEL[role]} 요청 권한` }
    : { ok: false, reason: `${READ_ONLY_REASON(role)} (변경 요청은 담당 AE · PM · 관리자 · 소유자 · 광고주 담당자)` };
}

/** 이슈 등록 · 처리 · 알림 발송 (POST/PATCH /incidents — 'operate') */
export function operateCheck(role: Role): PermCheck {
  return can(role, 'operate')
    ? { ok: true, reason: `${ROLE_LABEL[role]} 운영 권한` }
    : { ok: false, reason: `이슈 등록 · 처리는 운영 권한(담당 AE · PM · 관리자 · 소유자)이 필요합니다 — 현재 역할 ${ROLE_LABEL[role]}` };
}
