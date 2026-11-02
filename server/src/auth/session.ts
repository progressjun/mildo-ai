/** 세션: 랜덤 토큰(쿠키) → SHA-256 저장. CSRF 토큰은 세션마다 별도. */
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import { randomToken, sha256 } from '../lib/ids';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  real_name: boolean;
}

export interface SessionInfo {
  id: string;
  csrfToken: string;
  user: SessionUser;
  expiresAt: string;
}

export async function createSession(q: Queryable, userId: string, ttlHours: number, meta: { ip?: string; userAgent?: string } = {}): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const r = await one<{ expires_at: Date }>(
    q,
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5, $6) RETURNING expires_at`,
    [sha256(token), userId, csrfToken, String(ttlHours), meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300)],
  );
  await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { token, csrfToken, expiresAt: new Date(r!.expires_at).toISOString() };
}

export async function loadSession(q: Queryable, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  const row = await one<{ sid: string; csrf_token: string; expires_at: Date; last_seen_at: Date; id: string; email: string; name: string; status: 'active' | 'disabled'; real_name: boolean }>(
    q,
    `SELECT s.id AS sid, s.csrf_token, s.expires_at, s.last_seen_at, u.id, u.email, u.name, u.status, u.real_name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row || row.status !== 'active') return null;
  // 5분마다 마지막 사용 시각 갱신
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await q.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.sid]);
  }
  return {
    id: row.sid,
    csrfToken: row.csrf_token,
    expiresAt: new Date(row.expires_at).toISOString(),
    user: { id: row.id, email: row.email, name: row.name, status: row.status, real_name: row.real_name },
  };
}

export async function destroySession(q: Queryable, sessionId: string): Promise<void> {
  await q.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function destroyUserSessions(q: Queryable, userId: string, exceptSessionId?: string): Promise<number> {
  const r = await q.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)', [userId, exceptSessionId ?? null]);
  return r.rowCount;
}
