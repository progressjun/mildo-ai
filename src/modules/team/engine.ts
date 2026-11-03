/**
 * 팀 · 권한 화면 — 순수 함수 · 타입 (서버 응답 형태는 server/src/team/*.ts와 같다).
 */
import { ROLE_LABEL, type Role } from '@/core/permissions';
import { grantableRoles, passwordResetIssueProblem, removalProblem, roleChangeProblem, statusChangeProblem, type MemberTarget, type RuleProblem } from './rules';

export interface Member {
  user_id: string;
  email: string;
  name: string;
  real_name: boolean;
  status: 'active' | 'disabled';
  role: Role;
  title: string | null;
  joined_at: string;
  last_login_at: string | null;
  last_seen_at: string | null;
  active_sessions: number | null;
  is_me: boolean;
}

export type InviteStatus = 'pending' | 'expired' | 'accepted' | 'revoked';
export interface Invite {
  id: string;
  email: string;
  role: Role;
  status: InviteStatus;
  invited_by_name: string | null;
  accepted_by_name: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  mail_sent_at: string | null;
  mail_error: string | null;
  send_count: number;
}

export interface MailResult { sent: boolean; reason?: string }
export interface InviteResult { invite: Invite; link: string; mail?: MailResult }
/** POST /w/:ws/members/:userId/password-reset — 메일로 보냈으면 link 없음, 못 보냈으면(SMTP 미설정 · 실패) 직접 전달할 link */
export interface ResetLinkResult { ok: true; email: string; expiresAt: string; mail: MailResult; link?: string }

export interface SessionRow {
  id: string;
  current: boolean;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

/** 서버 lib/crypto.ts passwordProblem과 같은 규칙 (account.test.ts가 일치를 검사) */
export function passwordHint(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds < 2) return '영문 대소문자 · 숫자 · 기호 중 2가지 이상을 섞어 주세요';
  return null;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const INVITE_STATUS_META: Record<InviteStatus, { label: string; tone: 'accent' | 'warning' | 'good' | 'neutral' }> = {
  pending: { label: '수락 대기', tone: 'accent' },
  expired: { label: '만료', tone: 'warning' },
  accepted: { label: '수락됨', tone: 'good' },
  revoked: { label: '취소됨', tone: 'neutral' },
};

/** ISO → KST 'MM.DD HH:mm' (연도가 다르면 'YYYY.MM.DD HH:mm') */
export function fmtKst(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 9 * 3600_000).toISOString();
  const nowYear = new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 4);
  const md = `${d.slice(5, 7)}.${d.slice(8, 10)} ${d.slice(11, 16)}`;
  return d.slice(0, 4) === nowYear ? md : `${d.slice(0, 4)}.${md}`;
}

/** 상대 시각 ('방금' · 'n분 전' · 'n시간 전' · 'n일 전' · 'n일 후') */
export function relTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diff = nowMs - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '전' : '후';
  if (abs < 60_000) return diff >= 0 ? '방금' : '곧';
  if (abs < 3600_000) return `${Math.floor(abs / 60_000)}분 ${suffix}`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3600_000)}시간 ${suffix}`;
  return `${Math.floor(abs / 86_400_000)}일 ${suffix}`;
}

/** User-Agent → '브라우저 · OS' (모르면 원문 앞부분) */
export function uaSummary(ua: string | null | undefined): string {
  if (!ua) return '알 수 없는 기기';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Whale\//.test(ua) ? 'Whale' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : /node|undici|lightmyrequest/i.test(ua) ? '스크립트' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  if (!browser && !os) return ua.slice(0, 40);
  return [browser, os].filter(Boolean).join(' · ');
}

export const DORMANT_DAYS = 30;
/** 장기 미접속: 활성 계정인데 최근 로그인(없으면 합류 시각)이 30일을 넘음 — 막 합류해 아직 로그인 전인 사람은 넣지 않는다 */
export function isDormant(m: Pick<Member, 'status' | 'last_login_at' | 'joined_at'>, nowMs = Date.now()): boolean {
  if (m.status !== 'active') return false;
  const ref = Date.parse(m.last_login_at ?? m.joined_at);
  return Number.isFinite(ref) && nowMs - ref > DORMANT_DAYS * 86_400_000;
}

export const activeOwners = (members: Member[]) => members.filter((m) => m.role === 'owner' && m.status === 'active').length;

const targetOf = (m: Member): MemberTarget => ({ isSelf: m.is_me, role: m.role, active: m.status === 'active' });

/** 화면용: 이 구성원에 대해 내가 할 수 있는 일 · 막힌 이유 (서버 판정과 같은 규칙) */
export function memberActions(me: Role | null, m: Member, members: Member[]): {
  roleOptions: Role[];
  roleBlocked: RuleProblem | null;
  remove: RuleProblem | null;
  disable: RuleProblem | null;
  /** 비밀번호 재설정 링크 발급 */
  resetLink: RuleProblem | null;
} {
  if (!me) {
    const p: RuleProblem = { status: 403, code: 'forbidden', message: '로그인이 필요합니다' };
    return { roleOptions: [], roleBlocked: p, remove: p, disable: p, resetLink: p };
  }
  const owners = activeOwners(members);
  const t = targetOf(m);
  const options = grantableRoles(me).filter((r) => r === m.role || !roleChangeProblem(me, t, r, owners));
  const anyOther = options.some((r) => r !== m.role);
  const roleBlocked = anyOther ? null : (roleChangeProblem(me, t, m.role === 'owner' ? 'admin' : 'owner', owners) ?? roleChangeProblem(me, t, 'viewer', owners));
  return {
    roleOptions: anyOther ? options : [m.role],
    roleBlocked,
    remove: removalProblem(me, t, owners),
    // 다른 워크스페이스 소속 여부는 서버만 안다 (화면은 나머지 규칙으로 미리 막고, 서버가 최종 판정)
    disable: statusChangeProblem(me, t, m.status === 'active' ? 'disabled' : 'active', false, m.role === 'owner' && m.status === 'active' && owners <= 1 ? 1 : 0),
    resetLink: passwordResetIssueProblem(me, t, false),
  };
}

export interface TeamSummary {
  members: number;
  active: number;
  disabled: number;
  byRole: { role: Role; label: string; count: number }[];
  owners: number;
  pending: number;
  expired: number;
  /** 30일 넘게 로그인하지 않은 활성 구성원 (로그인 기록이 없으면 합류 후 30일) */
  dormant: Member[];
  /** 메일 발송 실패한 대기 초대 */
  mailFailed: Invite[];
}

export function summarizeTeam(members: Member[], invites: Invite[], nowMs = Date.now()): TeamSummary {
  const roles: Role[] = ['owner', 'admin', 'pm', 'ae', 'client', 'viewer'];
  return {
    members: members.length,
    active: members.filter((m) => m.status === 'active').length,
    disabled: members.filter((m) => m.status === 'disabled').length,
    byRole: roles.map((role) => ({ role, label: ROLE_LABEL[role], count: members.filter((m) => m.role === role).length })).filter((r) => r.count > 0),
    owners: activeOwners(members),
    pending: invites.filter((i) => i.status === 'pending').length,
    expired: invites.filter((i) => i.status === 'expired').length,
    dormant: members.filter((m) => isDormant(m, nowMs)),
    mailFailed: invites.filter((i) => i.status === 'pending' && !!i.mail_error),
  };
}
