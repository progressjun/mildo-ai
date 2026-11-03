/**
 * 계정 보안 (docs/SAAS_SPEC.md §6 team)
 *   POST   /api/auth/password { current, next }                로그인 → { ok, revokedSessions }  (다른 세션 모두 종료)
 *   POST   /api/auth/password-reset { email }                  -      → { ok } (항상 200 · 계정 존재 여부를 알리지 않음, IP당 분당 5회)
 *   POST   /api/auth/password-reset/check { token }            -      → { valid, reason?, email? (가린 형태) }  (토큰을 URL 경로에 넣지 않는다 — 요청 로그에 남지 않게)
 *   POST   /api/auth/password-reset/confirm { token, password } -     → { ok, revokedSessions } (1회용 · 1시간, 모든 세션 종료)
 *   GET    /api/auth/sessions                                  로그인 → { sessions } (내 세션만, current 표시)
 *   DELETE /api/auth/sessions/:id                              로그인 → { ok, current }
 *   DELETE /api/auth/sessions                                  로그인 → { ok, revoked } (현재 세션을 뺀 나머지 모두)
 *
 * 세션 id는 DB 행 id(토큰의 SHA-256)가 아니라 그 값을 한 번 더 해시한 앞 24자(publicSessionId)로만 노출한다.
 * 400을 쓰는 이유: 현재 비밀번호 불일치에 401을 주면 화면이 '세션 만료'로 오해한다.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { one } from '../db/pool';
import { randomToken, sha256 } from '../lib/ids';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { audit } from '../audit/audit';
import { destroySession, destroyUserSessions } from '../auth/session';
import {
  RESET_MAX_PER_15MIN, RESET_TTL_MINUTES, TOKEN_RE, clearSessionCookies, mailBody, normalizeEmail, publicSessionId, rateLimitKey, resetLink, sendMailWithin,
} from './service';
import type { AppConfig } from '../config';

const ChangeBody = z.object({ current: z.string().min(1).max(200), next: z.string().max(200) });
const ResetBody = z.object({ email: z.string().trim().toLowerCase().max(200).email() });
const ConfirmBody = z.object({ token: z.string().max(200), password: z.string().max(200) });
const CheckBody = z.object({ token: z.string().max(200) });

/** 'abcdef@x.com' → 'ab••••@x.com' */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '••••';
  return `${local.slice(0, Math.min(2, local.length))}••••@${domain}`;
}

function notifyPasswordChanged(config: AppConfig, to: string, name: string, how: '변경' | '재설정', ip: string): void {
  const { text, html } = mailBody([
    `${name}님, MILDO OS 계정 비밀번호가 ${how}되었습니다.`,
    `요청 IP: ${ip || '알 수 없음'} · 다른 기기의 로그인 세션은 모두 종료되었습니다.`,
    '본인이 한 일이 아니라면 바로 비밀번호를 재설정하고 워크스페이스 관리자에게 알려 주세요.',
  ]);
  // 보안 알림은 응답을 붙잡지 않는다 (실패해도 비밀번호 변경은 유효)
  void sendMailWithin(config, { to, subject: `[MILDO OS] 비밀번호가 ${how}되었습니다`, text, html });
}

export const accountRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const keyGenerator = rateLimitKey(config);

  app.post('/auth/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator } } }, async (req) => {
    const s = req.requireUser();
    const body = parseBody(ChangeBody, req.body);
    const u = await one<{ password_hash: string | null; email: string; name: string }>(db, 'SELECT password_hash, email, name FROM users WHERE id = $1', [s.user.id]);
    if (!u || !(await verifyPassword(body.current, u.password_hash))) {
      await audit(db, { workspaceId: null, userId: s.user.id, actor: s.user.name, action: 'auth.password_change_failed', ip: req.ip });
      throw new HttpError(400, 'invalid_current', '현재 비밀번호가 맞지 않습니다');
    }
    const pp = passwordProblem(body.next);
    if (pp) throw new HttpError(400, 'weak_password', pp);
    if (body.next === body.current) throw new HttpError(400, 'same_password', '현재 비밀번호와 다른 비밀번호를 입력해 주세요');
    const hash = await hashPassword(body.next);
    const revoked = await db.tx(async (q) => {
      await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [s.user.id, hash]);
      const n = await destroyUserSessions(q, s.user.id, s.id);
      await q.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [s.user.id]);
      await audit(q, { workspaceId: null, userId: s.user.id, actor: s.user.name, action: 'auth.password_change', ip: req.ip, detail: { revokedSessions: n } });
      return n;
    });
    notifyPasswordChanged(config, u.email, u.name, '변경', req.ip);
    return { ok: true, revokedSessions: revoked };
  });

  app.post('/auth/password-reset', { config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator } } }, async (req) => {
    const body = parseBody(ResetBody, req.body);
    const email = normalizeEmail(body.email);
    const u = await one<{ id: string; name: string; email: string; status: string }>(db, 'SELECT id, name, email, status FROM users WHERE lower(email) = $1', [email]);
    if (u && u.status === 'active') {
      const recent = await one<{ n: number }>(
        db, `SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '15 minutes'`, [u.id],
      );
      if ((recent?.n ?? 0) < RESET_MAX_PER_15MIN) {
        const token = randomToken(32);
        await db.tx(async (q) => {
          // 새 링크만 유효 (이전에 보낸 링크는 무효)
          await q.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [u.id]);
          await q.query(
            `INSERT INTO password_resets (token_hash, user_id, expires_at, ip) VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
            [sha256(token), u.id, String(RESET_TTL_MINUTES), req.ip],
          );
          await audit(q, { workspaceId: null, userId: u.id, actor: u.name, action: 'auth.password_reset_request', ip: req.ip });
        });
        const { text, html } = mailBody(
          [
            `${u.name}님, MILDO OS 비밀번호 재설정을 요청하셨습니다.`,
            `아래 링크에서 새 비밀번호를 정해 주세요. 링크는 ${RESET_TTL_MINUTES}분 동안 한 번만 쓸 수 있습니다.`,
            '요청한 적이 없다면 이 메일을 무시해 주세요. 비밀번호는 바뀌지 않습니다.',
          ],
          { href: resetLink(config, token), label: '비밀번호 재설정' },
        );
        // 응답 시간으로 계정 존재 여부가 드러나지 않게 발송을 기다리지 않는다
        void sendMailWithin(config, { to: u.email, subject: '[MILDO OS] 비밀번호 재설정', text, html });
      }
    }
    return { ok: true };
  });

  app.post('/auth/password-reset/check', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator } } }, async (req) => {
    const { token } = parseBody(CheckBody, req.body);
    if (!TOKEN_RE.test(token)) return { valid: false, reason: 'invalid' };
    const r = await one<{ expires_at: Date; used_at: Date | null; email: string; status: string }>(
      db, 'SELECT r.expires_at, r.used_at, u.email, u.status FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = $1', [sha256(token)],
    );
    if (!r || r.status !== 'active') return { valid: false, reason: 'invalid' };
    if (r.used_at) return { valid: false, reason: 'used' };
    if (new Date(r.expires_at).getTime() <= Date.now()) return { valid: false, reason: 'expired' };
    return { valid: true, email: maskEmail(r.email), expiresAt: new Date(r.expires_at).toISOString() };
  });

  app.post('/auth/password-reset/confirm', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator } } }, async (req, reply) => {
    const body = parseBody(ConfirmBody, req.body);
    if (!TOKEN_RE.test(body.token)) throw new HttpError(400, 'reset_invalid', '재설정 링크가 올바르지 않습니다. 비밀번호 재설정을 다시 요청해 주세요');
    const pp = passwordProblem(body.password);
    if (pp) throw new HttpError(400, 'weak_password', pp);
    const hash = await hashPassword(body.password);
    const out = await db.tx(async (q) => {
      const r = await one<{ user_id: string; expires_at: Date; used_at: Date | null; email: string; name: string; status: string }>(
        q,
        `SELECT r.user_id, r.expires_at, r.used_at, u.email, u.name, u.status FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.token_hash = $1 FOR UPDATE OF r`,
        [sha256(body.token)],
      );
      if (!r || r.status !== 'active') throw new HttpError(400, 'reset_invalid', '재설정 링크가 올바르지 않습니다. 비밀번호 재설정을 다시 요청해 주세요');
      if (r.used_at) throw new HttpError(400, 'reset_used', '이미 사용했거나 새 링크로 바뀐 재설정 링크입니다. 가장 최근 메일의 링크를 쓰거나 다시 요청해 주세요');
      if (new Date(r.expires_at).getTime() <= Date.now()) {
        throw new HttpError(400, 'reset_expired', `재설정 링크가 만료되었습니다 (${RESET_TTL_MINUTES}분). 다시 요청해 주세요`);
      }
      await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [r.user_id, hash]);
      await q.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
      const n = await destroyUserSessions(q, r.user_id);
      await audit(q, { workspaceId: null, userId: r.user_id, actor: r.name, action: 'auth.password_reset', ip: req.ip, detail: { revokedSessions: n } });
      return { userId: r.user_id, email: r.email, name: r.name, revoked: n };
    });
    if (req.session?.user.id === out.userId) clearSessionCookies(reply, config);
    notifyPasswordChanged(config, out.email, out.name, '재설정', req.ip);
    return { ok: true, revokedSessions: out.revoked };
  });

  app.get('/auth/sessions', async (req) => {
    const s = req.requireUser();
    const rows = await db.query<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; ip: string | null; user_agent: string | null }>(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC, created_at DESC`,
      [s.user.id],
    );
    return {
      sessions: rows.rows.map((r) => ({
        id: publicSessionId(r.id),
        current: r.id === s.id,
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        expires_at: r.expires_at,
        ip: r.ip,
        user_agent: r.user_agent,
      })),
    };
  });

  app.delete('/auth/sessions/:id', async (req, reply) => {
    const s = req.requireUser();
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{24}$/.test(id)) throw notFound('세션을 찾을 수 없습니다');
    const rows = await db.query<{ id: string; ip: string | null; user_agent: string | null }>(
      'SELECT id, ip, user_agent FROM sessions WHERE user_id = $1', [s.user.id],
    );
    const hit = rows.rows.find((r) => publicSessionId(r.id) === id);
    if (!hit) throw notFound('세션을 찾을 수 없습니다');
    await destroySession(db, hit.id);
    const current = hit.id === s.id;
    await audit(db, {
      workspaceId: null, userId: s.user.id, actor: s.user.name, action: 'auth.session_revoke', ip: req.ip,
      targetType: 'session', targetId: id, detail: { current, sessionIp: hit.ip, userAgent: (hit.user_agent ?? '').slice(0, 120) },
    });
    if (current) clearSessionCookies(reply, config);
    return { ok: true, current };
  });

  app.delete('/auth/sessions', async (req) => {
    const s = req.requireUser();
    const n = await destroyUserSessions(db, s.user.id, s.id);
    await audit(db, { workspaceId: null, userId: s.user.id, actor: s.user.name, action: 'auth.sessions_revoke_others', ip: req.ip, detail: { revoked: n } });
    return { ok: true, revoked: n };
  });
};
