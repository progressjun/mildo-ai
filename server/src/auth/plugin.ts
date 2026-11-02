/**
 * 요청마다 세션을 읽고(쿠키 mildo_sid), 쓰기 요청은 CSRF(헤더 x-csrf-token = 쿠키 mildo_csrf)를 확인한다.
 * req.requireUser() · req.workspace(perm) 데코레이터를 제공한다.
 */
import fp from './fp';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadSession } from './session';
import { can, type Permission, type Role } from './permissions';
import { forbidden, notFound, unauthorized, HttpError } from '../lib/errors';
import { one } from '../db/pool';
import type { WorkspaceCtx, WorkspaceRow } from '../http/context';

export const SESSION_COOKIE = 'mildo_sid';
export const CSRF_COOKIE = 'mildo_csrf';

/** 로그인 전에도 허용하는 쓰기 엔드포인트 (CSRF 대상 아님 — 속도 제한 대상) */
const CSRF_EXEMPT = [/^\/api\/auth\/login$/, /^\/api\/auth\/password-reset(\/.*)?$/, /^\/api\/invites\/[^/]+\/accept$/, /^\/api\/setup$/];

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('session', null);
  app.decorateRequest('requireUser', function (this: FastifyRequest) {
    if (!this.session) throw unauthorized();
    return this.session;
  });
  app.decorateRequest('workspace', async function (this: FastifyRequest, perm: Permission = 'read'): Promise<WorkspaceCtx> {
    const session = this.requireUser();
    const wsId = (this.params as Record<string, string> | undefined)?.ws;
    if (!wsId || !/^[0-9a-f-]{36}$/i.test(wsId)) throw notFound('워크스페이스를 찾을 수 없습니다');
    const row = await one<WorkspaceRow & { role: Role; m_title: string | null }>(
      app.ctx.db,
      `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $2 WHERE w.id = $1`,
      [wsId, session.user.id],
    );
    if (!row) throw notFound('워크스페이스를 찾을 수 없습니다');
    if (row.status !== 'active' && perm !== 'read') throw new HttpError(423, 'workspace_locked', '이 워크스페이스는 현재 읽기 전용입니다');
    if (!can(row.role, perm)) throw forbidden();
    const { role, m_title: _t, ...workspace } = row;
    return { user: session.user, session, workspace, role, actor: session.user.name, ip: this.ip };
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies?.[SESSION_COOKIE];
    req.session = token ? await loadSession(app.ctx.db, token) : null;
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const path = req.url.split('?')[0];
    if (CSRF_EXEMPT.some((re) => re.test(path))) return;
    if (!req.session) return; // 401은 라우트가 판정 (로그인 불필요 라우트 허용)
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || header !== req.session.csrfToken) {
      throw new HttpError(403, 'csrf', '보안 토큰이 맞지 않습니다. 새로고침 후 다시 시도해 주세요');
    }
  });
});
