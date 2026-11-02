/** 인증 코어: 로그인 · 로그아웃 · 내 정보. (초대 · 비밀번호 변경/재설정 · 세션 관리는 team 도메인) */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { one } from '../db/pool';
import { verifyPassword } from '../lib/crypto';
import { createSession, destroySession } from './session';
import { SESSION_COOKIE, CSRF_COOKIE } from './plugin';
import { HttpError } from '../lib/errors';
import { audit } from '../audit/audit';
import { permissionsOf, demoRoleOf, type Role } from './permissions';

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const cookieOpts = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies };

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parseBody(LoginBody, req.body);
    const user = await one<{ id: string; name: string; password_hash: string | null; status: string }>(
      db, 'SELECT id, name, password_hash, status FROM users WHERE lower(email) = lower($1)', [body.email],
    );
    const ok = user && user.status === 'active' && (await verifyPassword(body.password, user.password_hash));
    if (!ok) {
      await audit(db, { workspaceId: null, userId: user?.id ?? null, actor: body.email, action: 'auth.login_failed', ip: req.ip });
      throw new HttpError(401, 'invalid_credentials', '이메일 또는 비밀번호가 맞지 않습니다');
    }
    const s = await createSession(db, user!.id, config.sessionTtlHours, { ip: req.ip, userAgent: req.headers['user-agent'] });
    await audit(db, { workspaceId: null, userId: user!.id, actor: user!.name, action: 'auth.login', ip: req.ip });
    const maxAge = config.sessionTtlHours * 3600;
    reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts, httpOnly: true, maxAge });
    reply.setCookie(CSRF_COOKIE, s.csrfToken, { ...cookieOpts, httpOnly: false, maxAge });
    return { ok: true, csrfToken: s.csrfToken, expiresAt: s.expiresAt };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.session) {
      await destroySession(db, req.session.id);
      await audit(db, { workspaceId: null, userId: req.session.user.id, actor: req.session.user.name, action: 'auth.logout', ip: req.ip });
    }
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    reply.clearCookie(CSRF_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const s = req.requireUser();
    const ws = (await db.query<{ id: string; slug: string; name: string; brand_name: string; role: Role; status: string }>(
      `SELECT w.id, w.slug, w.name, w.brand_name, w.status, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 AND w.status <> 'archived' ORDER BY w.created_at`, [s.user.id],
    )).rows;
    return {
      user: s.user,
      csrfToken: s.csrfToken,
      workspaces: ws.map((w) => ({ ...w, permissions: permissionsOf(w.role), demoRole: demoRoleOf(w.role) })),
    };
  });
};
