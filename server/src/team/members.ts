/**
 * 구성원 (docs/SAAS_SPEC.md §6 team)
 *   GET    /api/w/:ws/members                                  read        → { members }
 *   PATCH  /api/w/:ws/members/:userId { role?, title?, status? } manage_team → { member, members }
 *   DELETE /api/w/:ws/members/:userId                          manage_team → { ok, members }
 *   POST   /api/w/:ws/members/:userId/password-reset           manage_team → { ok, email, expiresAt, mail: { sent, reason? }, link? }
 *          비밀번호 재설정 링크 발급(60분 · 1회용, 이전 링크 무효). SMTP가 설정되어 있으면 본인 메일로 보내고 링크는 돌려주지 않는다.
 *          메일을 보내지 못했으면(SMTP 미설정 · 실패 · 지연) 관리자가 직접 전달할 link를 돌려준다(초대 링크와 같은 방식).
 *          판정: @/modules/team/rules passwordResetIssueProblem (계정 비활성화와 같은 관리 범위). 링크 · 토큰은 로그 · 감사에 남기지 않는다.
 *
 * 판정 규칙은 @/modules/team/rules(화면과 공유)를 쓴다. 역할 · 제외 · 비활성화는 워크스페이스 멤버십 행을 잠근 트랜잭션 안에서
 * 소유자 수를 다시 세어 판정한다(두 소유자가 서로를 동시에 강등해 소유자가 0명이 되는 경쟁 상태 방지).
 * 제외(DELETE)는 멤버십만 지운다 — 다른 워크스페이스 접속에 쓰는 세션은 그대로 둔다.
 * 비활성화(status=disabled)는 계정 단위(모든 워크스페이스 로그인 차단)라서 관리 범위 밖 워크스페이스에 소속된 계정에는 쓰지 못한다.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { one, type Queryable } from '../db/pool';
import { HttpError, notFound, forbidden } from '../lib/errors';
import { audit } from '../audit/audit';
import { publish, publishAccessChange } from '../events/hub';
import { destroyUserSessions } from '../auth/session';
import { can, ROLES, type Role } from '../auth/permissions';
import { passwordResetIssueProblem, removalProblem, roleChangeProblem, statusChangeProblem, type MemberTarget } from '@/modules/team/rules';
import { mailConfigured, SMTP_NOT_CONFIGURED, type MailResult } from '../lib/mailer';
import { RESET_MAX_PER_15MIN, UUID_RE, issueResetToken, problem, rateLimitKey, recentResetCount, resetLink, resetMail, sendMailWithin } from './service';

export interface MemberView {
  user_id: string;
  email: string;
  name: string;
  real_name: boolean;
  status: 'active' | 'disabled';
  role: Role;
  title: string | null;
  joined_at: string;
  last_login_at: string | null;
  /** 팀 관리 권한자에게만: 유효 세션의 마지막 사용 시각 · 수 */
  last_seen_at: string | null;
  active_sessions: number | null;
  is_me: boolean;
}

const PatchBody = z
  .object({
    role: z.enum(ROLES as unknown as [Role, ...Role[]]).optional(),
    title: z.union([z.string().trim().max(60), z.null()]).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((b) => b.role !== undefined || b.title !== undefined || b.status !== undefined, { message: '바꿀 항목(role · title · status)이 없습니다' });

const ROLE_SORT = `array_position(ARRAY['owner','admin','pm','ae','client','viewer']::text[], m.role)`;

async function listMembers(q: Queryable, wsId: string, meId: string, manager: boolean): Promise<MemberView[]> {
  const r = await q.query<Omit<MemberView, 'is_me'>>(
    `SELECT u.id AS user_id, u.email, u.name, u.real_name, u.status, m.role, m.title, m.created_at AS joined_at, u.last_login_at,
            s.last_seen_at, coalesce(s.n, 0)::int AS active_sessions
       FROM memberships m JOIN users u ON u.id = m.user_id
       LEFT JOIN LATERAL (SELECT max(last_seen_at) AS last_seen_at, count(*) AS n FROM sessions WHERE user_id = u.id AND expires_at > now()) s ON true
      WHERE m.workspace_id = $1
      ORDER BY ${ROLE_SORT}, lower(u.name), u.email`,
    [wsId],
  );
  return r.rows.map((m) => ({
    ...m,
    last_seen_at: manager ? m.last_seen_at : null,
    active_sessions: manager ? m.active_sessions : null,
    is_me: m.user_id === meId,
  }));
}

interface LockedMember { user_id: string; email: string; name: string; role: Role; title: string | null; status: 'active' | 'disabled' }

/** 워크스페이스 멤버십 전체를 잠그고 읽는다 (소유자 수 판정용) */
async function lockMembers(q: Queryable, wsId: string): Promise<LockedMember[]> {
  return (await q.query<LockedMember>(
    `SELECT m.user_id, u.email, u.name, m.role, m.title, u.status FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY m.user_id FOR UPDATE OF m`,
    [wsId],
  )).rows;
}

const activeOwnerCount = (rows: LockedMember[]) => rows.filter((r) => r.role === 'owner' && r.status === 'active').length;

/** 대상이 actor가 관리하지 못하는 다른 워크스페이스에도 소속된 수 — actor가 manage_team이 아닌 곳, 또는 대상이 소유자인데 actor가 소유자가 아닌 곳 */
async function outsideScopeCount(q: Queryable, targetId: string, actorId: string, wsId: string): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM memberships t
      WHERE t.user_id = $1 AND t.workspace_id <> $3
        AND NOT EXISTS (SELECT 1 FROM memberships a WHERE a.user_id = $2 AND a.workspace_id = t.workspace_id
                          AND (a.role = 'owner' OR (a.role = 'admin' AND t.role <> 'owner')))`,
    [targetId, actorId, wsId],
  );
  return r?.n ?? 0;
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;

  app.get('/w/:ws/members', async (req) => {
    const c = await req.workspace('read');
    return { members: await listMembers(db, c.workspace.id, c.user.id, can(c.role, 'manage_team')) };
  });

  app.patch('/w/:ws/members/:userId', async (req) => {
    const c = await req.workspace('manage_team');
    const { userId } = req.params as { userId: string };
    if (!UUID_RE.test(userId)) throw notFound('구성원을 찾을 수 없습니다');
    const body = parseBody(PatchBody, req.body);
    const wsId = c.workspace.id;

    await db.tx(async (q) => {
      const rows = await lockMembers(q, wsId);
      const actor = rows.find((r) => r.user_id === c.user.id);
      // 잠금 대기 중 내 권한이 바뀌었을 수 있다 → 잠근 뒤 다시 확인
      if (!actor || !can(actor.role, 'manage_team')) throw forbidden();
      const t = rows.find((r) => r.user_id === userId);
      if (!t) throw notFound('구성원을 찾을 수 없습니다');
      const target: MemberTarget = { isSelf: t.user_id === c.user.id, role: t.role, active: t.status === 'active' };
      const base = { workspaceId: wsId, userId: c.user.id, actor: c.actor, targetType: 'user', targetId: userId, ip: c.ip };
      let changed = false;

      if (body.role !== undefined && body.role !== t.role) {
        const p = roleChangeProblem(actor.role, target, body.role, activeOwnerCount(rows));
        if (p) throw problem(p);
        await q.query('UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [wsId, userId, body.role]);
        await audit(q, { ...base, action: 'member.role_change', detail: { email: t.email, name: t.name, from: t.role, to: body.role } });
        await publishAccessChange(q, userId); // 열린 SSE가 바뀐 역할로 다시 확인
        t.role = body.role;
        target.role = body.role;
        changed = true;
      }

      if (body.title !== undefined) {
        const title = body.title ? body.title : null;
        if (title !== (t.title ?? null)) {
          await q.query('UPDATE memberships SET title = $3 WHERE workspace_id = $1 AND user_id = $2', [wsId, userId, title]);
          await audit(q, { ...base, action: 'member.title_change', detail: { email: t.email, from: t.title, to: title } });
          changed = true;
        }
      }

      if (body.status !== undefined && body.status !== t.status) {
        await q.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        // 관리 범위 밖 소속: actor가 manage_team이 아닌 워크스페이스, 또는 대상이 소유자인데 actor가 소유자가 아닌 워크스페이스
        const outside = await outsideScopeCount(q, userId, c.user.id, wsId);
        // 비활성화하면 활성 소유자가 0명이 되는 워크스페이스 (이 워크스페이스 포함)
        const orphans = await one<{ n: number }>(
          q,
          `SELECT count(*)::int AS n FROM memberships t
            WHERE t.user_id = $1 AND t.role = 'owner'
              AND NOT EXISTS (SELECT 1 FROM memberships o JOIN users ou ON ou.id = o.user_id
                               WHERE o.workspace_id = t.workspace_id AND o.role = 'owner' AND o.user_id <> $1 AND ou.status = 'active')`,
          [userId],
        );
        const p = statusChangeProblem(actor.role, target, body.status, outside > 0, body.status === 'disabled' ? (orphans?.n ?? 0) : 0);
        if (p) throw problem(p);
        await q.query('UPDATE users SET status = $2 WHERE id = $1', [userId, body.status]);
        const revoked = body.status === 'disabled' ? await destroyUserSessions(q, userId) : 0;
        if (body.status === 'disabled') await publishAccessChange(q, userId); // 세션이 없어도(이미 만료) 신호는 보낸다
        // 비활성화 전에 보낸 재설정 링크가 재활성화 뒤에 다시 살아나지 않게 무효화
        if (body.status === 'disabled') await q.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
        await audit(q, {
          ...base,
          action: body.status === 'disabled' ? 'member.disable' : 'member.enable',
          detail: { email: t.email, name: t.name, role: t.role, revokedSessions: revoked },
        });
        changed = true;
      }

      if (changed) await publish(q, wsId, { type: 'member', id: userId });
    });

    const members = await listMembers(db, wsId, c.user.id, true);
    return { member: members.find((m) => m.user_id === userId) ?? null, members };
  });

  app.delete('/w/:ws/members/:userId', async (req) => {
    const c = await req.workspace('manage_team');
    const { userId } = req.params as { userId: string };
    if (!UUID_RE.test(userId)) throw notFound('구성원을 찾을 수 없습니다');
    const wsId = c.workspace.id;
    const self = userId === c.user.id;

    await db.tx(async (q) => {
      const rows = await lockMembers(q, wsId);
      const actor = rows.find((r) => r.user_id === c.user.id);
      if (!actor || !can(actor.role, 'manage_team')) throw forbidden();
      const t = rows.find((r) => r.user_id === userId);
      if (!t) throw notFound('구성원을 찾을 수 없습니다');
      const p = removalProblem(actor.role, { isSelf: self, role: t.role, active: t.status === 'active' }, activeOwnerCount(rows));
      if (p) throw problem(p);
      const del = await q.query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [wsId, userId]);
      if (!del.rowCount) throw new HttpError(409, 'conflict', '이미 제외된 구성원입니다');
      await audit(q, {
        workspaceId: wsId, userId: c.user.id, actor: c.actor, action: self ? 'member.leave' : 'member.remove', targetType: 'user', targetId: userId, ip: c.ip,
        detail: { email: t.email, name: t.name, role: t.role },
      });
      // 제외된 사람의 열린 SSE(이 워크스페이스)를 닫는다 — 세션은 다른 워크스페이스 접속에 쓰므로 그대로 둔다.
      // member 이벤트보다 먼저 보내야(같은 트랜잭션의 NOTIFY는 보낸 순서대로 전달) 제외된 사람의 스트림이 이 이벤트도 받지 않는다
      await publishAccessChange(q, userId);
      await publish(q, wsId, { type: 'member', id: userId });
    });

    return { ok: true, members: self ? [] : await listMembers(db, wsId, c.user.id, true) };
  });
  // 발급한 관리자별 분당 10회 (대상 계정별 상한은 RESET_MAX_PER_15MIN)
  const ipKey = rateLimitKey(config);
  app.post('/w/:ws/members/:userId/password-reset', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => (req.session ? `reset-issue:${req.session.user.id}` : ipKey(req)) } },
  }, async (req) => {
    const c = await req.workspace('manage_team');
    const { userId } = req.params as { userId: string };
    if (!UUID_RE.test(userId)) throw notFound('구성원을 찾을 수 없습니다');
    const wsId = c.workspace.id;

    const issued = await db.tx(async (q) => {
      const rows = await lockMembers(q, wsId);
      const actor = rows.find((r) => r.user_id === c.user.id);
      if (!actor || !can(actor.role, 'manage_team')) throw forbidden();
      const t = rows.find((r) => r.user_id === userId);
      if (!t) throw notFound('구성원을 찾을 수 없습니다');
      await q.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const target: MemberTarget = { isSelf: t.user_id === c.user.id, role: t.role, active: t.status === 'active' };
      const p = passwordResetIssueProblem(actor.role, target, (await outsideScopeCount(q, userId, c.user.id, wsId)) > 0);
      if (p) throw problem(p);
      if ((await recentResetCount(q, userId)) >= RESET_MAX_PER_15MIN) {
        throw new HttpError(429, 'reset_rate_limited', `이 계정에는 15분 안에 재설정 링크를 ${RESET_MAX_PER_15MIN}번까지 발급할 수 있습니다. 잠시 후 다시 시도해 주세요`);
      }
      const tok = await issueResetToken(q, userId, c.ip);
      await audit(q, {
        workspaceId: wsId, userId: c.user.id, actor: c.actor, action: 'member.password_reset_issue', targetType: 'user', targetId: userId, ip: c.ip,
        detail: { email: t.email, name: t.name, role: t.role, delivery: mailConfigured(config) ? 'mail' : 'link' },
      });
      return { ...tok, email: t.email, name: t.name };
    });

    const mail: MailResult = mailConfigured(config)
      ? await sendMailWithin(config, { to: issued.email, ...resetMail(config, issued.name, issued.token, c.actor) })
      : { sent: false, reason: `${SMTP_NOT_CONFIGURED} — 메일을 보내지 않았습니다` };
    // 메일로 보냈으면 링크를 관리자에게 돌려주지 않는다 (본인만 받는다). 못 보냈으면 관리자가 직접 전달할 수 있게 돌려준다
    return {
      ok: true as const,
      email: issued.email,
      expiresAt: issued.expiresAt,
      mail: { sent: mail.sent, ...(mail.sent ? {} : { reason: mail.reason ?? '메일 발송 실패' }) },
      ...(mail.sent ? {} : { link: resetLink(config, issued.token) }),
    };
  });
};
