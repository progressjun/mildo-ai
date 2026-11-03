/**
 * 구성원 (docs/SAAS_SPEC.md §6 team)
 *   GET    /api/w/:ws/members                                  read        → { members }
 *   PATCH  /api/w/:ws/members/:userId { role?, title?, status? } manage_team → { member, members }
 *   DELETE /api/w/:ws/members/:userId                          manage_team → { ok, members }
 *
 * 판정 규칙은 @/modules/team/rules(화면과 공유)를 쓴다. 역할 · 제외 · 비활성화는 워크스페이스 멤버십 행을 잠근 트랜잭션 안에서
 * 소유자 수를 다시 세어 판정한다(두 소유자가 서로를 동시에 강등해 소유자가 0명이 되는 경쟁 상태 방지).
 * 제외(DELETE)는 멤버십만 지운다 — 다른 워크스페이스 접속에 쓰는 세션은 그대로 둔다.
 * 비활성화(status=disabled)는 계정 단위(모든 워크스페이스 로그인 차단)라서 관리 범위 밖 워크스페이스에 소속된 계정에는 쓰지 못한다.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { one, type Queryable } from '../db/pool';
import { HttpError, notFound, forbidden } from '../lib/errors';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { destroyUserSessions } from '../auth/session';
import { can, ROLES, type Role } from '../auth/permissions';
import { removalProblem, roleChangeProblem, statusChangeProblem, type MemberTarget } from '@/modules/team/rules';
import { UUID_RE, problem } from './service';

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

export const memberRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

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
        const outside = await one<{ n: number }>(
          q,
          `SELECT count(*)::int AS n FROM memberships t
            WHERE t.user_id = $1 AND t.workspace_id <> $3
              AND NOT EXISTS (SELECT 1 FROM memberships a WHERE a.user_id = $2 AND a.workspace_id = t.workspace_id
                                AND (a.role = 'owner' OR (a.role = 'admin' AND t.role <> 'owner')))`,
          [userId, c.user.id, wsId],
        );
        // 비활성화하면 활성 소유자가 0명이 되는 워크스페이스 (이 워크스페이스 포함)
        const orphans = await one<{ n: number }>(
          q,
          `SELECT count(*)::int AS n FROM memberships t
            WHERE t.user_id = $1 AND t.role = 'owner'
              AND NOT EXISTS (SELECT 1 FROM memberships o JOIN users ou ON ou.id = o.user_id
                               WHERE o.workspace_id = t.workspace_id AND o.role = 'owner' AND o.user_id <> $1 AND ou.status = 'active')`,
          [userId],
        );
        const p = statusChangeProblem(actor.role, target, body.status, (outside?.n ?? 0) > 0, body.status === 'disabled' ? (orphans?.n ?? 0) : 0);
        if (p) throw problem(p);
        await q.query('UPDATE users SET status = $2 WHERE id = $1', [userId, body.status]);
        const revoked = body.status === 'disabled' ? await destroyUserSessions(q, userId) : 0;
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
      await publish(q, wsId, { type: 'member', id: userId });
    });

    return { ok: true, members: self ? [] : await listMembers(db, wsId, c.user.id, true) };
  });
};
