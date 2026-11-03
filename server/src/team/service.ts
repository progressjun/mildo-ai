/**
 * team 도메인 공용 헬퍼 — 초대 표시 형태, 세션 공개 id, 쿠키 발급(코어 로그인과 같은 방식), 메일 발송(시간 제한).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import { SESSION_COOKIE, CSRF_COOKIE } from '../auth/plugin';
import { sendMail, type Mail, type MailResult } from '../lib/mailer';
import { randomToken, sha256 } from '../lib/ids';
import { HttpError } from '../lib/errors';
import { clientIp, rateKeyOf, securityOptionsFromEnv } from '../http/security';
import type { RuleProblem } from '@/modules/team/rules';
import type { Role } from '../auth/permissions';

export const INVITE_TTL_DAYS = 7;
export const RESET_TTL_MINUTES = 60;
/** 같은 사용자에게 15분 안에 보낼 수 있는 재설정 메일 수 (여러 IP에서 메일 폭탄 방지) */
export const RESET_MAX_PER_15MIN = 3;
/** 워크스페이스당 1시간에 보낼 수 있는 초대 메일 수 (초대 생성 + 다시 보내기) — 우리 SMTP로 임의 주소에 스팸을 보내는 것 방지 */
export const INVITE_MAX_PER_HOUR = 100;
/**
 * 초대 수락 화면의 기존 계정 비밀번호 확인 잠금 — 로그인 실패(auth.login_failed, 로그인 화면 · 초대 수락 합산)가
 * 이 창 안에 이만큼 쌓이면 막는다. 초대 링크를 쥔 다른 워크스페이스 관리자가 수락 화면으로 비밀번호를 추측해
 * 로그인 잠금(http/security.ts)을 우회하지 못하게 한다. 환경변수와 무관하게 항상 켜져 있다.
 */
export const ACCEPT_FAIL_MAX = 10;
export const ACCEPT_FAIL_WINDOW_MIN = 15;

/**
 * 라우트 속도 제한 키 — @fastify/rate-limit 기본 키(req.ip)는 trustProxy=true라서 클라이언트가 X-Forwarded-For를 꾸며
 * 우회할 수 있다. devops 보안 계층과 같은 방식(TRUST_PROXY_HOPS개의 앞단 프록시만 믿음)으로 고른 IP를 쓴다.
 */
export function rateLimitKey(config: AppConfig): (req: FastifyRequest) => string {
  const hops = securityOptionsFromEnv(process.env, config.env).proxyHops;
  return (req) => rateKeyOf(clientIp(req, hops));
}

/**
 * 같은 이메일의 최근 로그인 실패 수 (감사 로그 기준이라 서버 여러 대여도 같은 값). 창 안, 그리고 마지막 성공 로그인 ·
 * 비밀번호 재설정 뒤의 실패만 센다. 로그인 화면(코어 auth.login_failed, 입력한 이메일이 actor)과 초대 수락 실패를 합친다.
 */
export async function recentFailedLogins(q: Queryable, email: string, windowMin: number): Promise<{ failures: number; retryAfterSec: number }> {
  const r = await one<{ n: number; left_sec: number | null }>(
    q,
    `WITH u AS (SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1),
     since AS (
       SELECT greatest(
         now() - make_interval(mins => $2::int),
         coalesce((SELECT max(at) FROM audit_log WHERE action IN ('auth.login', 'auth.password_reset') AND user_id = (SELECT id FROM u)), '-infinity'::timestamptz)
       ) AS t
     )
     SELECT count(*)::int AS n, ceil(extract(epoch FROM (min(at) + make_interval(mins => $2::int) - now())))::int AS left_sec
       FROM audit_log WHERE action = 'auth.login_failed' AND lower(actor) = lower($1) AND at > (SELECT t FROM since)`,
    [email, windowMin],
  );
  return { failures: r?.n ?? 0, retryAfterSec: Math.max(1, r?.left_sec ?? windowMin * 60) };
}

/** 쓰기 요청의 CSRF 헤더가 현재 세션과 맞는지 (코어가 CSRF 검사를 면제한 공개 엔드포인트에서 세션으로 인증할 때) */
export function csrfMatches(req: FastifyRequest): boolean {
  const header = req.headers['x-csrf-token'];
  return !!req.session && typeof header === 'string' && header.length > 0 && header === req.session.csrfToken;
}
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function problem(p: RuleProblem): HttpError {
  return new HttpError(p.status, p.code, p.message);
}

export const normalizeEmail = (s: string) => s.trim().toLowerCase();

/** 초대 상태 SQL (accepted > revoked > expired > pending) */
export const INVITE_STATUS_SQL = `CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
  WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END`;

export type InviteStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  status: InviteStatus;
  invited_by: string | null;
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

/** 초대 목록 · 단건 조회 (token_hash는 절대 내보내지 않는다) */
export const INVITE_SELECT = `SELECT i.id, i.email, i.role, ${INVITE_STATUS_SQL} AS status, i.invited_by, ib.name AS invited_by_name, ab.name AS accepted_by_name,
    i.created_at, i.expires_at, i.accepted_at, i.revoked_at, i.revoke_reason, i.mail_sent_at, i.mail_error, i.send_count
  FROM invites i LEFT JOIN users ib ON ib.id = i.invited_by LEFT JOIN users ab ON ab.id = i.accepted_by`;

export async function loadInvite(q: Queryable, wsId: string, id: string): Promise<InviteView | null> {
  if (!UUID_RE.test(id)) return null;
  return one<InviteView>(q, `${INVITE_SELECT} WHERE i.workspace_id = $1 AND i.id = $2`, [wsId, id]);
}

export const inviteLink = (config: AppConfig, token: string) => `${config.appUrl}/?invite=${encodeURIComponent(token)}`;
export const resetLink = (config: AppConfig, token: string) => `${config.appUrl}/?reset=${encodeURIComponent(token)}`;

/**
 * 비밀번호 재설정 토큰 발급 — 이 사용자의 이전 미사용 링크는 무효로 하고 새 링크만 유효(RESET_TTL_MINUTES · 1회용).
 * 트랜잭션 안에서 부른다. 토큰은 해시로만 저장하고 로그 · 감사에 남기지 않는다.
 * 쓰는 곳: 로그인 화면의 재설정 메일(account.ts) · 관리자의 재설정 링크 발급(members.ts) · 운영자 CLI(db/cli.ts reset-link)
 */
export async function issueResetToken(q: Queryable, userId: string, ip: string | null): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32);
  await q.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const r = await one<{ expires_at: Date }>(
    q,
    `INSERT INTO password_resets (token_hash, user_id, expires_at, ip) VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4) RETURNING expires_at`,
    [sha256(token), userId, String(RESET_TTL_MINUTES), ip],
  );
  return { token, expiresAt: new Date(r!.expires_at).toISOString() };
}

/** 최근 15분 안에 이 사용자에게 발급한 재설정 링크 수 (RESET_MAX_PER_15MIN과 비교) */
export async function recentResetCount(q: Queryable, userId: string): Promise<number> {
  const r = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '15 minutes'`, [userId]);
  return r?.n ?? 0;
}

/** 재설정 메일 본문 — issuedBy가 있으면 관리자가 발급했다고 적는다 */
export function resetMail(config: AppConfig, name: string, token: string, issuedBy?: string): { subject: string; text: string; html: string } {
  const { text, html } = mailBody(
    [
      issuedBy ? `${name}님, 워크스페이스 관리자 ${issuedBy}님이 MILDO OS 비밀번호 재설정 링크를 발급했습니다.` : `${name}님, MILDO OS 비밀번호 재설정을 요청하셨습니다.`,
      `아래 링크에서 새 비밀번호를 정해 주세요. 링크는 ${RESET_TTL_MINUTES}분 동안 한 번만 쓸 수 있습니다.`,
      issuedBy ? '요청한 적이 없다면 이 메일을 무시하고 관리자에게 알려 주세요. 비밀번호는 바뀌지 않습니다.' : '요청한 적이 없다면 이 메일을 무시해 주세요. 비밀번호는 바뀌지 않습니다.',
    ],
    { href: resetLink(config, token), label: '비밀번호 재설정' },
  );
  return { subject: '[MILDO OS] 비밀번호 재설정', text, html };
}

/** 세션 공개 id — 세션 행 id(토큰 해시)가 아니라 그 해시의 앞부분 (화면 · API에 노출) */
export const publicSessionId = (sessionRowId: string) => sha256(`session:${sessionRowId}`).slice(0, 24);

/**
 * 코어 로그인(auth/routes.ts)과 같은 쿠키 이름 · 옵션으로 세션 쿠키를 붙인다.
 * 세션 행은 트랜잭션 안에서 createSession으로 만들고, 커밋된 뒤에 이 함수로 쿠키를 붙인다.
 */
export function setSessionCookies(reply: FastifyReply, config: AppConfig, s: { token: string; csrfToken: string }): void {
  const cookieOpts = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies };
  const maxAge = config.sessionTtlHours * 3600;
  reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts, httpOnly: true, maxAge });
  reply.setCookie(CSRF_COOKIE, s.csrfToken, { ...cookieOpts, httpOnly: false, maxAge });
}

export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  const cookieOpts = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies };
  reply.clearCookie(SESSION_COOKIE, cookieOpts);
  reply.clearCookie(CSRF_COOKIE, cookieOpts);
}

/** 메일 발송 — SMTP가 느려도 API가 오래 붙잡히지 않게 시간 제한 (초과 시 발송은 계속, 응답은 '지연') */
export async function sendMailWithin(config: AppConfig, mail: Mail, ms = 10_000): Promise<MailResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MailResult>((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, reason: '메일 서버 응답이 늦습니다 (발송 결과 미확인) — 링크를 복사해 직접 전달할 수 있습니다' }), ms);
  });
  try {
    return await Promise.race([
      sendMail(config, mail).catch((e: unknown) => ({ sent: false, reason: (e as Error)?.message ?? '메일 발송 실패' }) as MailResult),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESC[c]);

/** 메일 본문 (텍스트 + 단순 HTML). 링크는 본문에만 넣고 로그 · 감사에는 남기지 않는다 */
export function mailBody(lines: string[], link?: { href: string; label: string }): { text: string; html: string } {
  const text = [...lines, ...(link ? ['', `${link.label}: ${link.href}`] : []), '', '— MILDO OS'].join('\n');
  const html = [
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6">',
    ...lines.map((l) => (l ? `<p style="margin:0 0 8px">${escHtml(l)}</p>` : '')),
    link ? `<p style="margin:16px 0"><a href="${escHtml(link.href)}">${escHtml(link.label)}</a></p>` : '',
    '<p style="margin:16px 0 0;opacity:0.7;font-size:12px">MILDO OS</p>',
    '</div>',
  ].join('');
  return { text, html };
}
