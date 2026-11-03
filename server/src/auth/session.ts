/**
 * 세션: 랜덤 토큰(쿠키) → SHA-256 저장. CSRF 토큰은 세션마다 별도.
 * 세션을 지우면 접근 변경 신호(events/hub publishAccessChange)를 보낸다 — 그 세션으로 열린 SSE(/events)가 바로 닫힌다.
 */
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import { randomToken, sha256 } from '../lib/ids';
import { publishAccessChange } from '../events/hub';

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
  const r = await q.query<{ user_id: string }>('DELETE FROM sessions WHERE id = $1 RETURNING user_id', [sessionId]);
  for (const userId of new Set(r.rows.map((x) => x.user_id))) await publishAccessChange(q, userId);
}

export async function destroyUserSessions(q: Queryable, userId: string, exceptSessionId?: string): Promise<number> {
  const r = await q.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)', [userId, exceptSessionId ?? null]);
  if (r.rowCount) await publishAccessChange(q, userId);
  return r.rowCount;
}
