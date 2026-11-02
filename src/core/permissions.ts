/**
 * 역할 → 권한 (docs/SAAS_SPEC.md §2). 서버의 모든 쓰기 판정은 이 표를 쓴다.
 * 프런트도 같은 파일을 import해 버튼 활성 여부를 맞출 수 있다(순수 모듈).
 */
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
