/**
 * OAuth 인증 코드 흐름 — 카페24 (docs/SAAS_SPEC.md §6 data · connectors-sales 카페24 OAuth).
 * 공식 문서: https://apidocs.cafe24.com/docs/guide/oauth2-authentication
 *   인증 코드는 브라우저에서만 받는다(GET https://{mall_id}.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id&state&redirect_uri&scope),
 *   코드는 1분 유효 · 1회용이고, 토큰 교환의 redirect_uri는 앱에 등록한 값 · 인증 요청 때 보낸 값과 같아야 한다.
 *
 *   POST /api/w/:ws/connections/:id/oauth/cafe24/start   권한 configure (live 커넥션은 live_write — 자격증명 교체와 같은 규칙)
 *     → { url, redirectUri, expiresAt }   url = cafe24AuthorizeUrl({ mallId, clientId, redirectUri, state })
 *     화면은 window.location.assign(url)로 같은 탭에서 카페24 승인 화면으로 이동한다(팝업 · 새 창 아님).
 *   GET /api/oauth/cafe24/callback?code&state   세션 불필요 — 세션이 있으면 state의 사용자와 같아야 한다
 *     state 검증 → 사용자 권한 다시 확인 → state 1회용 기록 → 커넥션 확인 → 인증 코드를 그 자리에서(코드 유효 1분 안에) 토큰으로 교환
 *     (exchangeCafe24AuthCode — 새 토큰은 ctx.saveCredentials로 암호화 저장) → 상태 pending(연결 확인 필요) · 감사 'connection.oauth'(값 없음)
 *     · 'connection' 이벤트 → 302 `${APP_URL}/#connections`
 *     실패: 302 `${APP_URL}/?oauth_error=<코드>#connections` — 화면(src/modules/connections/oauth.ts)이 코드별 한국어 안내를 보여 준다.
 *     URL에는 코드만 싣는다(임의 문구를 화면에 그대로 보여 주지 않는다). 교환 실패 사유는 커넥션 last_error · 감사에 남긴다(비밀값 가림).
 *
 * state = base64url(JSON { v, p, ws, cid, uid, n, exp }) + '.' + base64url(HMAC-SHA256(SESSION_SECRET, 'mildo-oauth-state:v1:' + 본문))
 *   워크스페이스 · 커넥션 · 시작한 사용자 · nonce(16바이트)를 묶고 10분 뒤 만료. 위조 · 변조(서명 불일치) · 만료 · 재사용(oauth_state_uses)을 거절한다.
 *   커넥션은 state의 (워크스페이스, 커넥션) 쌍으로만 읽는다 — 서명된 값을 바꿀 수 없으므로 다른 워크스페이스 커넥션에 토큰을 넣을 수 없다.
 * 교환에는 저장된 앱 정보(쇼핑몰 ID · Client ID · Client Secret)만 넘긴다 — 코드 교환이 거절됐을 때 예전 갱신 토큰으로 조용히 넘어가 성공처럼 보이지 않게.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { one, type Queryable } from '../db/pool';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { can, type Role } from '../auth/permissions';
import { forbidden, notFound, HttpError } from '../lib/errors';
import { nowMs } from '../lib/time';
import { scrubSecrets } from './http';
import { decryptCredentials, OAUTH_APPS, type Credentials } from './credentials';
import { buildConnectorContext, loadConnection, type ConnectionRow } from './service';
import { cafe24AuthorizeUrl, exchangeCafe24AuthCode, type Cafe24Credentials } from './cafe24/client';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const STATE_CONTEXT = 'mildo-oauth-state:v1:';

/** 콜백 실패 코드 — 화면 안내 문구는 src/modules/connections/oauth.ts OAUTH_ERROR_TEXT */
export const OAUTH_ERROR_CODES = [
  'state_invalid', 'state_expired', 'state_used', 'session_mismatch', 'forbidden', 'connection_missing', 'credentials_missing', 'code_missing', 'denied', 'exchange_failed',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** 공급자 앱에 등록할 콜백 주소 */
export const oauthRedirectUri = (appUrl: string, provider: string) => `${appUrl.replace(/\/+$/, '')}/api/oauth/${provider}/callback`;
export const oauthSuccessRedirect = (appUrl: string) => `${appUrl.replace(/\/+$/, '')}/#connections`;
export const oauthErrorRedirect = (appUrl: string, code: OAuthErrorCode) => `${appUrl.replace(/\/+$/, '')}/?oauth_error=${encodeURIComponent(code)}#connections`;

/* ---------- state ---------- */

export interface OAuthState {
  v: 1;
  p: 'cafe24';
  /** 워크스페이스 id */
  ws: string;
  /** 커넥션 id */
  cid: string;
  /** 시작한 사용자 id */
  uid: string;
  /** nonce (base64url 16바이트) */
  n: string;
  /** 만료 시각 (epoch ms) */
  exp: number;
}

const UUID = z.string().regex(/^[0-9a-f-]{36}$/i);
const StateSchema = z.object({
  v: z.literal(1), p: z.literal('cafe24'), ws: UUID, cid: UUID, uid: UUID, n: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), exp: z.number().int().positive(),
}).strict();

const mac = (secret: string, body: string) => createHmac('sha256', secret).update(`${STATE_CONTEXT}${body}`).digest();

export function signOAuthState(secret: string, s: OAuthState): string {
  const body = Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

export function newOAuthState(o: { ws: string; cid: string; uid: string; now: number }): OAuthState {
  return { v: 1, p: 'cafe24', ws: o.ws, cid: o.cid, uid: o.uid, n: randomBytes(16).toString('base64url'), exp: o.now + OAUTH_STATE_TTL_MS };
}

export type StateCheck = { ok: true; state: OAuthState } | { ok: false; code: 'state_invalid' | 'state_expired' };

/** 서명(상수 시간 비교) · 형식 · 만료 확인. 만료 시각이 발급 한도(10분)보다 먼 값도 거절한다 */
export function verifyOAuthState(secret: string, token: unknown, now: number): StateCheck {
  const bad: StateCheck = { ok: false, code: 'state_invalid' };
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return bad;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return bad;
  const want = mac(secret, parts[0]);
  const got = Buffer.from(parts[1], 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return bad;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return bad; }
  const r = StateSchema.safeParse(raw);
  if (!r.success) return bad;
  if (r.data.exp <= now) return { ok: false, code: 'state_expired' };
  if (r.data.exp - now > OAUTH_STATE_TTL_MS + 60_000) return bad;
  return { ok: true, state: r.data as OAuthState };
}

/** state 1회용 — 처음 쓰면 true. 만료 하루 지난 기록은 지운다(앱 시계 기준) */
async function consumeState(q: Queryable, s: OAuthState): Promise<boolean> {
  const now = nowMs();
  await q.query('DELETE FROM oauth_state_uses WHERE expires_at < $1', [new Date(now - 86_400_000).toISOString()]);
  const r = await q.query(
    `INSERT INTO oauth_state_uses (nonce_hash, workspace_id, connection_id, user_id, used_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (nonce_hash) DO NOTHING`,
    [createHash('sha256').update(s.n).digest('hex'), s.ws, s.cid, s.uid, new Date(now).toISOString(), new Date(s.exp).toISOString()],
  );
  return r.rowCount === 1;
}

/* ---------- 라우트 ---------- */

const appCredentials = (row: ConnectionRow, encryptionKey: string): Credentials | null => {
  let creds: Credentials;
  try { creds = decryptCredentials<Credentials>(row.credentials_enc, encryptionKey); } catch { return null; }
  const r = OAUTH_APPS[row.provider]?.appSchema.safeParse(creds);
  return r?.success ? r.data : null;
};

const qs = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export const oauthRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/w/:ws/connections/:id/oauth/cafe24/start', limited, async (req) => {
    const c = await req.workspace('configure');
    const { id } = req.params as { id: string };
    const row = await loadConnection(db, c.workspace.id, id);
    if (!row) throw notFound('커넥션을 찾을 수 없습니다');
    if (row.provider !== 'cafe24') throw new HttpError(400, 'oauth_unsupported', '카페24 커넥션에서만 인증을 시작할 수 있습니다');
    if (row.write_mode === 'live' && !can(c.role, 'live_write')) {
      throw forbidden('실제 반영(live) 중인 커넥션의 인증(자격증명)은 관리자 · 소유자만 바꿀 수 있습니다 — 먼저 쓰기 모드를 dry_run으로 내리세요');
    }
    const creds = appCredentials(row, config.encryptionKey);
    if (!creds) throw new HttpError(400, 'oauth_not_ready', '쇼핑몰 ID · Client ID · Client Secret을 먼저 저장해 주세요 (커넥션 설정)');
    const redirectUri = oauthRedirectUri(config.appUrl, 'cafe24');
    const state = newOAuthState({ ws: c.workspace.id, cid: row.id, uid: c.user.id, now: nowMs() });
    const url = cafe24AuthorizeUrl({ mallId: String(creds.mallId), clientId: String(creds.clientId), redirectUri, state: signOAuthState(config.sessionSecret, state) });
    return { url, redirectUri, expiresAt: new Date(state.exp).toISOString() };
  });

  app.get('/oauth/cafe24/callback', limited, async (req, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    const q = (req.query ?? {}) as Record<string, unknown>;
    const fail = (code: OAuthErrorCode) => reply.redirect(oauthErrorRedirect(config.appUrl, code), 302);

    const check = verifyOAuthState(config.sessionSecret, q.state, nowMs());
    if (!check.ok) return fail(check.code);
    const st = check.state;
    if (req.session && req.session.user.id !== st.uid) return fail('session_mismatch');

    // 시작한 사용자가 지금도 이 워크스페이스에서 커넥션을 바꿀 수 있는지 (10분 사이 역할 변경 · 비활성화)
    const member = await one<{ role: Role; name: string }>(
      db,
      `SELECT m.role, u.name FROM memberships m
         JOIN users u ON u.id = m.user_id AND u.status = 'active'
         JOIN workspaces w ON w.id = m.workspace_id AND w.status = 'active'
        WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [st.ws, st.uid],
    );
    if (!member || !can(member.role, 'configure')) return fail('forbidden');
    if (!(await consumeState(db, st))) return fail('state_used');

    const row = await loadConnection(db, st.ws, st.cid);
    if (!row || row.provider !== 'cafe24') return fail('connection_missing');
    if (row.write_mode === 'live' && !can(member.role, 'live_write')) return fail('forbidden');
    const who = { workspaceId: st.ws, userId: st.uid, actor: member.name, targetType: 'connection', targetId: row.id, ip: req.ip };
    const failWithAudit = async (code: OAuthErrorCode, message?: string) => {
      await db.tx(async (t) => {
        if (message) await t.query(`UPDATE connections SET last_error = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2`, [row.id, st.ws, message]);
        await audit(t, { ...who, action: 'connection.oauth', detail: { provider: row.provider, ok: false, error: code, ...(message ? { message } : {}) } });
        await publish(t, st.ws, { type: 'connection', id: row.id });
      });
      return fail(code);
    };

    if (q.error !== undefined) return failWithAudit('denied');
    const code = qs(q.code, 512);
    if (!code) return failWithAudit('code_missing');
    const creds = appCredentials(row, config.encryptionKey);
    if (!creds) return failWithAudit('credentials_missing');

    const redirectUri = oauthRedirectUri(config.appUrl, 'cafe24');
    let saved: Cafe24Credentials;
    try {
      const ctx = buildConnectorContext(db, config, row, { dryRun: true });
      saved = await exchangeCafe24AuthCode(ctx, creds as unknown as Cafe24Credentials, code, redirectUri, { now: nowMs });
    } catch (e) {
      const message = scrubSecrets(`카페24 인증 코드 교환 실패: ${(e as Error)?.message ?? String(e)}`).slice(0, 500);
      return failWithAudit('exchange_failed', message);
    }
    await db.tx(async (t) => {
      // 자격증명이 바뀌었으니 다시 연결 확인을 받는다 (PATCH 자격증명 변경과 같은 규칙)
      await t.query(
        `UPDATE connections SET status = CASE WHEN status = 'disabled' THEN status ELSE 'pending' END, last_error = NULL, updated_at = now() WHERE id = $1 AND workspace_id = $2`,
        [row.id, st.ws],
      );
      await audit(t, {
        ...who, action: 'connection.oauth',
        detail: { provider: row.provider, ok: true, fields: Object.keys(saved).filter((k) => (saved as unknown as Record<string, unknown>)[k] !== undefined).sort(), scopes: saved.scopes ?? [] },
      });
      await publish(t, st.ws, { type: 'connection', id: row.id });
    });
    return reply.redirect(oauthSuccessRedirect(config.appUrl), 302);
  });
};

