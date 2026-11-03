/**
 * 팀 · 권한 서버 API 호출 (서버 모드 전용) — 계약: docs/SAAS_SPEC.md §6 team, 구현: server/src/team/*.ts.
 * 오류는 ApiError(code · message 한국어)로 던진다. 화면이 직접 안내하므로 전역 오류 토스트는 끈다(silent).
 */
import { api, wsPath } from '@/saas/api';
import type { Role } from '@/core/permissions';
import type { Invite, InviteResult, Member, ResetLinkResult, SessionRow } from './engine';
import { setTeamSnapshot } from './live';

const silent = { silent: true } as const;

export async function fetchMembers(ws: string): Promise<Member[]> {
  const r = await api<{ members: Member[] }>(wsPath(ws, '/members'), silent);
  setTeamSnapshot(ws, { members: r.members });
  return r.members;
}

export async function fetchInvites(ws: string): Promise<Invite[]> {
  const r = await api<{ invites: Invite[] }>(wsPath(ws, '/invites'), silent);
  setTeamSnapshot(ws, { invites: r.invites });
  return r.invites;
}

export const createInvite = (ws: string, email: string, role: Role) =>
  api<InviteResult>(wsPath(ws, '/invites'), { method: 'POST', body: { email, role }, ...silent });

export const resendInvite = (ws: string, id: string) =>
  api<InviteResult>(wsPath(ws, `/invites/${encodeURIComponent(id)}/resend`), { method: 'POST', body: {}, ...silent });

export const revokeInvite = (ws: string, id: string) =>
  api<{ invite: Invite }>(wsPath(ws, `/invites/${encodeURIComponent(id)}`), { method: 'DELETE', ...silent });

export const patchMember = (ws: string, userId: string, patch: { role?: Role; title?: string | null; status?: 'active' | 'disabled' }) =>
  api<{ member: Member | null; members: Member[] }>(wsPath(ws, `/members/${encodeURIComponent(userId)}`), { method: 'PATCH', body: patch, ...silent });

/** 비밀번호 재설정 링크 발급 — 메일로 보냈으면 link 없음 */
export const issueResetLink = (ws: string, userId: string) =>
  api<ResetLinkResult>(wsPath(ws, `/members/${encodeURIComponent(userId)}/password-reset`), { method: 'POST', body: {}, ...silent });

export const removeMember = (ws: string, userId: string) =>
  api<{ ok: true; members: Member[] }>(wsPath(ws, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE', ...silent });

export const fetchSessions = async () => (await api<{ sessions: SessionRow[] }>('/api/auth/sessions', silent)).sessions;

export const revokeSession = (id: string) => api<{ ok: true; current: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', ...silent });

export const revokeOtherSessions = () => api<{ ok: true; revoked: number }>('/api/auth/sessions', { method: 'DELETE', ...silent });

export const changePassword = (current: string, next: string) =>
  api<{ ok: true; revokedSessions: number }>('/api/auth/password', { method: 'POST', body: { current, next }, ...silent });
