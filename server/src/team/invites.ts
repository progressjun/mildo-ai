/**
 * 초대 (docs/SAAS_SPEC.md §6 team)
 *   POST   /api/w/:ws/invites { email, role }      manage_team → { invite, link, mail }  (메일 발송 실패 · SMTP 미설정이어도 link 반환)
 *   GET    /api/w/:ws/invites                      manage_team → { invites }  (pending · expired · accepted · revoked)
 *   DELETE /api/w/:ws/invites/:id                  manage_team → { invite }   (취소)
 *   POST   /api/w/:ws/invites/:id/resend           manage_team → { invite, link, mail }  (새 토큰 · 7일 재연장, 이전 링크는 무효)
 *   GET    /api/invites/:token                     -           → { workspace, role, email, expired, ... }
 *   POST   /api/invites/:token/accept { name, password }  -    → 세션 쿠키 발급 (코어 로그인과 같은 쿠키)
 *
 * 토큰은 randomToken(32바이트) 원문을 링크에만 담고 DB에는 SHA-256만 저장한다. 링크는 감사 · 로그에 남기지 않는다.
 * 보호: 워크스페이스당 시간당 초대 메일 100건(INVITE_MAX_PER_HOUR), 수락의 기존 계정 비밀번호 확인은 로그인 실패 잠금(15분 10회)을 따르고,
 * 비밀번호 없이 세션으로 수락할 때는 CSRF 헤더를 확인한다(코어가 이 경로를 CSRF에서 면제). 공개 경로 속도 제한 키는 rateLimitKey(프록시 hops 기준 IP).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { one } from '../db/pool';
import { randomToken, sha256 } from '../lib/ids';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/crypto';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { createSession, destroySession } from '../auth/session';
import { ROLES, ROLE_LABEL, type Role } from '../auth/permissions';
import { inviteRoleProblem } from '@/modules/team/rules';
import {
  ACCEPT_FAIL_MAX, ACCEPT_FAIL_WINDOW_MIN, INVITE_MAX_PER_HOUR, INVITE_SELECT, INVITE_TTL_DAYS, TOKEN_RE, UUID_RE, csrfMatches, inviteLink, loadInvite,
  mailBody, normalizeEmail, problem, rateLimitKey, recentFailedLogins, sendMailWithin, setSessionCookies,
  type InviteView,
} from './service';
import type { AppConfig } from '../config';
import type { MailResult } from '../lib/mailer';
import type { WorkspaceCtx } from '../http/context';
import type { Queryable } from '../db/pool';

const InviteBody = z.object({
  email: z.string().trim().toLowerCase().max(200).email(),
  role: z.enum(ROLES as unknown as [Role, ...Role[]]),
});
const AcceptBody = z.object({
  name: z.string().trim().max(60).optional(),
  password: z.string().max(200).optional(),
});
const ListQuery = z.object({ status: z.enum(['pending', 'expired', 'accepted', 'revoked']).optional() });

async function deliverInvite(config: AppConfig, c: WorkspaceCtx, email: string, role: Role, link: string): Promise<MailResult> {
  const ws = c.workspace;
  const { text, html } = mailBody(
    [
      `${c.user.name}님이 ${ws.name}(${ws.brand_name}) 워크스페이스에 ${ROLE_LABEL[role]} 역할로 초대했습니다.`,
      `아래 링크에서 초대를 수락하면 바로 로그인됩니다. 링크는 ${INVITE_TTL_DAYS}일 동안 한 번만 쓸 수 있습니다.`,
      '초대받을 일이 없었다면 이 메일을 무시해 주세요. 아무 일도 일어나지 않습니다.',
    ],
    { href: link, label: '초대 수락하기' },
  );
  return sendMailWithin(config, { to: email, subject: `[MILDO OS] ${ws.brand_name} 워크스페이스 초대`, text, html });
}

async function recordMail(q: Queryable, inviteId: string, mail: MailResult): Promise<void> {
  await q.query(
    `UPDATE invites SET send_count = send_count + 1, mail_sent_at = CASE WHEN $2 THEN now() ELSE mail_sent_at END, mail_error = $3 WHERE id = $1`,
    [inviteId, mail.sent, mail.sent ? null : (mail.reason ?? '메일 발송 실패').slice(0, 300)],
  );
}

/** 이미 구성원 · 비활성 계정이면 초대하지 않는다 */
async function assertInvitable(q: Queryable, wsId: string, email: string): Promise<void> {
  const u = await one<{ id: string; status: string; member: boolean }>(
    q,
    `SELECT u.id, u.status, EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = $1 AND m.user_id = u.id) AS member
       FROM users u WHERE lower(u.email) = $2`,
    [wsId, email],
  );
  if (u?.member) throw new HttpError(409, 'already_member', '이미 이 워크스페이스의 구성원입니다');
  if (u?.status === 'disabled') throw new HttpError(409, 'account_disabled', '비활성화된 계정입니다. 계정을 다시 활성화한 뒤 초대해 주세요');
}

/** 워크스페이스당 시간당 초대 메일 상한 (감사 로그 기준이라 서버 여러 대여도 같은 값) */
async function assertInviteBudget(q: Queryable, wsId: string): Promise<void> {
  const r = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM audit_log
      WHERE workspace_id = $1 AND action IN ('invite.create', 'invite.resend') AND at > now() - interval '1 hour'`,
    [wsId],
  );
  if ((r?.n ?? 0) >= INVITE_MAX_PER_HOUR) {
    throw new HttpError(429, 'invite_rate_limited', `초대는 워크스페이스당 1시간에 ${INVITE_MAX_PER_HOUR}건까지 보낼 수 있습니다. 잠시 후 다시 시도해 주세요`);
  }
}

export const inviteRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const keyGenerator = rateLimitKey(config);

  app.post('/w/:ws/invites', async (req) => {
    const c = await req.workspace('manage_team');
    const body = parseBody(InviteBody, req.body);
    const p = inviteRoleProblem(c.role, body.role);
    if (p) throw problem(p);
    await assertInviteBudget(db, c.workspace.id);
    const email = normalizeEmail(body.email);
    const token = randomToken(32);
    const inviteId = await db.tx(async (q) => {
      // 같은 이메일 동시 초대 직렬화
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`, [c.workspace.id, email]);
      await assertInvitable(q, c.workspace.id, email);
      const sup = await q.query(
        `UPDATE invites SET revoked_at = now(), revoked_by = $3, revoke_reason = 'superseded'
          WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [c.workspace.id, email, c.user.id],
      );
      const row = await one<{ id: string; expires_at: Date }>(
        q,
        `INSERT INTO invites (workspace_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id, expires_at`,
        [c.workspace.id, email, body.role, sha256(token), c.user.id, String(INVITE_TTL_DAYS)],
      );
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'invite.create', targetType: 'invite', targetId: row!.id, ip: c.ip,
        detail: { email, role: body.role, expiresAt: new Date(row!.expires_at).toISOString(), superseded: sup.rowCount },
      });
      await publish(q, c.workspace.id, { type: 'member', id: `invite:${row!.id}` });
      return row!.id;
    });
    const link = inviteLink(config, token);
    const mail = await deliverInvite(config, c, email, body.role, link);
    await recordMail(db, inviteId, mail);
    return { invite: await loadInvite(db, c.workspace.id, inviteId), link, mail };
  });

  app.get('/w/:ws/invites', async (req) => {
    const c = await req.workspace('manage_team');
    const qy = parseBody(ListQuery, req.query);
    const rows = await db.query<InviteView>(
      `SELECT * FROM (${INVITE_SELECT} WHERE i.workspace_id = $1) x WHERE ($2::text IS NULL OR x.status = $2)
        ORDER BY CASE x.status WHEN 'pending' THEN 0 WHEN 'expired' THEN 1 WHEN 'accepted' THEN 2 ELSE 3 END, x.created_at DESC LIMIT 300`,
      [c.workspace.id, qy.status ?? null],
    );
    return { invites: rows.rows };
  });

  app.delete('/w/:ws/invites/:id', async (req) => {
    const c = await req.workspace('manage_team');
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('초대를 찾을 수 없습니다');
    await db.tx(async (q) => {
      const row = await one<{ id: string; email: string; role: Role; accepted_at: Date | null; revoked_at: Date | null }>(
        q, 'SELECT id, email, role, accepted_at, revoked_at FROM invites WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [c.workspace.id, id],
      );
      if (!row) throw notFound('초대를 찾을 수 없습니다');
      if (row.accepted_at) throw new HttpError(409, 'invite_accepted', '이미 수락된 초대는 취소할 수 없습니다. 구성원 표에서 제외해 주세요');
      if (row.revoked_at) return; // 이미 취소됨 (멱등)
      await q.query(`UPDATE invites SET revoked_at = now(), revoked_by = $2, revoke_reason = 'revoked' WHERE id = $1`, [id, c.user.id]);
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'invite.revoke', targetType: 'invite', targetId: id, ip: c.ip,
        detail: { email: row.email, role: row.role },
      });
      await publish(q, c.workspace.id, { type: 'member', id: `invite:${id}` });
    });
    return { invite: await loadInvite(db, c.workspace.id, id) };
  });

  app.post('/w/:ws/invites/:id/resend', async (req) => {
    const c = await req.workspace('manage_team');
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('초대를 찾을 수 없습니다');
    await assertInviteBudget(db, c.workspace.id);
    const token = randomToken(32);
    const target = await db.tx(async (q) => {
      const row = await one<{ id: string; email: string; role: Role; accepted_at: Date | null; revoked_at: Date | null }>(
        q, 'SELECT id, email, role, accepted_at, revoked_at FROM invites WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [c.workspace.id, id],
      );
      if (!row) throw notFound('초대를 찾을 수 없습니다');
      if (row.accepted_at) throw new HttpError(409, 'invite_accepted', '이미 수락된 초대입니다');
      if (row.revoked_at) throw new HttpError(409, 'invite_revoked', '취소된 초대입니다. 새로 초대해 주세요');
      const p = inviteRoleProblem(c.role, row.role);
      if (p) throw problem(p);
      await assertInvitable(q, c.workspace.id, row.email);
      await q.query(
        `UPDATE invites SET token_hash = $2, expires_at = now() + ($3 || ' days')::interval WHERE id = $1`,
        [id, sha256(token), String(INVITE_TTL_DAYS)],
      );
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'invite.resend', targetType: 'invite', targetId: id, ip: c.ip,
        detail: { email: row.email, role: row.role },
      });
      await publish(q, c.workspace.id, { type: 'member', id: `invite:${id}` });
      return row;
    });
    const link = inviteLink(config, token);
    const mail = await deliverInvite(config, c, target.email, target.role, link);
    await recordMail(db, id, mail);
    return { invite: await loadInvite(db, c.workspace.id, id), link, mail };
  });

  // ---------- 공개 (로그인 불필요) ----------
  interface PublicInvite {
    id: string; workspace_id: string; email: string; role: Role; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
    ws_name: string; ws_brand: string; ws_status: string; invited_by_name: string | null;
  }
  const PUBLIC_SELECT = `SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
      w.name AS ws_name, w.brand_name AS ws_brand, w.status AS ws_status, ib.name AS invited_by_name
    FROM invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users ib ON ib.id = i.invited_by WHERE i.token_hash = $1`;
  const NOT_FOUND = () => new HttpError(404, 'invite_not_found', '초대를 찾을 수 없습니다. 취소되었거나 새 링크로 바뀌었을 수 있습니다');

  app.get('/invites/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator } } }, async (req) => {
    const { token } = req.params as { token: string };
    if (!TOKEN_RE.test(token)) throw NOT_FOUND();
    const inv = await one<PublicInvite>(db, PUBLIC_SELECT, [sha256(token)]);
    if (!inv || inv.revoked_at || inv.ws_status === 'archived') throw NOT_FOUND();
    const existing = await one<{ id: string }>(db, 'SELECT id FROM users WHERE lower(email) = $1', [inv.email]);
    const expired = !inv.accepted_at && new Date(inv.expires_at).getTime() <= Date.now();
    return {
      workspace: { id: inv.workspace_id, name: inv.ws_name, brand_name: inv.ws_brand },
      email: inv.email,
      role: inv.role,
      role_label: ROLE_LABEL[inv.role],
      invited_by_name: inv.invited_by_name,
      expires_at: new Date(inv.expires_at).toISOString(),
      expired,
      accepted: !!inv.accepted_at,
      existing_user: !!existing,
      signed_in_as_invitee: !!existing && req.session?.user.id === existing.id,
    };
  });

  app.post('/invites/:token/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!TOKEN_RE.test(token)) throw NOT_FOUND();
    const body = parseBody(AcceptBody, req.body);
    const hash = sha256(token);
    const inv = await one<PublicInvite>(db, PUBLIC_SELECT, [hash]);
    const checkState = (i: Pick<PublicInvite, 'revoked_at' | 'accepted_at' | 'expires_at' | 'ws_status'> | null) => {
      if (!i || i.revoked_at || i.ws_status === 'archived') throw NOT_FOUND();
      if (i.ws_status !== 'active') throw new HttpError(423, 'workspace_locked', '이 워크스페이스는 현재 새 구성원을 받을 수 없습니다');
      if (i.accepted_at) throw new HttpError(409, 'invite_used', '이미 수락한 초대입니다. 로그인해 주세요');
      if (new Date(i.expires_at).getTime() <= Date.now()) {
        throw new HttpError(410, 'invite_expired', `초대 링크가 만료되었습니다 (${INVITE_TTL_DAYS}일). 관리자에게 초대를 다시 보내 달라고 요청해 주세요`);
      }
    };
    checkState(inv);
    const invite = inv!;

    // 1단계(트랜잭션 밖): 기존 계정 확인 — 실패 기록이 롤백되지 않게
    const existing = await one<{ id: string; name: string; status: string; password_hash: string | null }>(
      db, 'SELECT id, name, status, password_hash FROM users WHERE lower(email) = $1', [invite.email],
    );
    const signedInAsInvitee = !!existing && req.session?.user.id === existing.id;
    // 코어는 이 경로를 CSRF 검사에서 뺐다(로그인 전 요청). 비밀번호 없이 세션만으로 수락할 때는 CSRF 헤더를 직접 확인한다.
    if (signedInAsInvitee && !csrfMatches(req)) {
      throw new HttpError(403, 'csrf', '보안 토큰이 맞지 않습니다. 새로고침 후 다시 시도해 주세요');
    }
    if (existing) {
      if (existing.status !== 'active') throw new HttpError(403, 'account_disabled', '비활성화된 계정입니다. 워크스페이스 관리자에게 문의해 주세요');
      if (!signedInAsInvitee) {
        if (!body.password) throw new HttpError(401, 'password_required', '이미 가입된 이메일입니다. 이 계정의 비밀번호를 입력해 주세요');
        // 로그인 잠금 우회 방지: 로그인 화면 · 초대 수락의 실패를 합쳐 센다 (감사 로그 기준)
        const lock = await recentFailedLogins(db, invite.email, ACCEPT_FAIL_WINDOW_MIN);
        if (lock.failures >= ACCEPT_FAIL_MAX) {
          await audit(db, {
            workspaceId: null, userId: existing.id, actor: invite.email, action: 'auth.login_locked', ip: req.ip,
            detail: { via: 'invite', failures: lock.failures, windowMin: ACCEPT_FAIL_WINDOW_MIN },
          });
          reply.header('retry-after', String(lock.retryAfterSec));
          throw new HttpError(
            429, 'login_locked',
            `비밀번호 확인 실패가 ${ACCEPT_FAIL_WINDOW_MIN}분 안에 ${ACCEPT_FAIL_MAX}회를 넘어 잠시 막았습니다. 약 ${Math.max(1, Math.ceil(lock.retryAfterSec / 60))}분 뒤 다시 시도하거나 비밀번호를 재설정해 주세요`,
          );
        }
        if (!(await verifyPassword(body.password, existing.password_hash))) {
          await audit(db, { workspaceId: null, userId: existing.id, actor: invite.email, action: 'auth.login_failed', ip: req.ip, detail: { via: 'invite' } });
          throw new HttpError(401, 'invalid_credentials', '비밀번호가 맞지 않습니다. 비밀번호를 잊었다면 로그인 화면에서 재설정해 주세요');
        }
      }
    } else {
      if (!body.name) throw badRequest('이름을 입력해 주세요', [{ path: 'name', message: 'required' }]);
      const pp = passwordProblem(body.password ?? '');
      if (pp) throw new HttpError(400, 'weak_password', pp);
    }
    const newHash = existing ? null : await hashPassword(body.password!);

    // 2단계(트랜잭션): 초대 잠금 · 재확인 → 계정 · 멤버십 · 수락 표시 · 세션
    const out = await db.tx(async (q) => {
      const locked = await one<PublicInvite>(q, `${PUBLIC_SELECT} FOR UPDATE OF i`, [hash]);
      checkState(locked);
      let userId: string;
      let userName: string;
      if (existing) {
        userId = existing.id;
        userName = existing.name;
      } else {
        const created = await one<{ id: string; name: string }>(
          q,
          `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT ((lower(email))) DO NOTHING RETURNING id, name`,
          [invite.email, body.name, newHash],
        );
        if (!created) throw new HttpError(409, 'conflict', '같은 이메일로 방금 계정이 만들어졌습니다. 다시 시도해 주세요');
        userId = created.id;
        userName = created.name;
      }
      const m = await q.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [invite.workspace_id, userId, invite.role],
      );
      const role = m.rowCount
        ? invite.role
        : ((await one<{ role: Role }>(q, 'SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [invite.workspace_id, userId]))!.role);
      await q.query('UPDATE invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [invite.id, userId]);
      await audit(q, {
        workspaceId: invite.workspace_id, userId, actor: userName, action: 'invite.accept', targetType: 'invite', targetId: invite.id, ip: req.ip,
        detail: { email: invite.email, role, newUser: !existing, alreadyMember: !m.rowCount },
      });
      await publish(q, invite.workspace_id, { type: 'member', id: userId });
      if (signedInAsInvitee) return { userId, role, session: null };
      const session = await createSession(q, userId, config.sessionTtlHours, { ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(q, { workspaceId: null, userId, actor: userName, action: 'auth.login', ip: req.ip, detail: { via: 'invite' } });
      if (req.session) await destroySession(q, req.session.id); // 다른 계정으로 로그인돼 있던 세션은 정리
      return { userId, role, session };
    });

    if (out.session) setSessionCookies(reply, config, out.session);
    return {
      ok: true,
      newUser: !existing,
      workspaceId: invite.workspace_id,
      role: out.role,
      csrfToken: out.session?.csrfToken ?? req.session!.csrfToken,
      expiresAt: out.session?.expiresAt ?? req.session!.expiresAt,
    };
  });
};
