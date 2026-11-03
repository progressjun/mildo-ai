/**
 * 감사 로그 조회 (docs/SAAS_SPEC.md §6 team) — 권한 configure
 *   GET /api/w/:ws/audit?action=&userId=&from=&to=&before=&limit=&auth=&targetType=&targetId=  → { entries, nextBefore }
 *   GET /api/w/:ws/audit.csv?(같은 필터)                                                         → text/csv (UTF-8 BOM)
 *   GET /api/w/:ws/audit/facets                                                                  → { actions, users } (필터 선택지)
 *
 * action: 작업 코드 접두어(예: 'invite.' · 'change'), from/to: KST 날짜(포함), before: 커서(이 id보다 오래된 것), limit: 기본 100 · 최대 200.
 * auth=1: 이 워크스페이스 구성원의 계정 기록(로그인 · 로그인 실패 · 비밀번호 · 세션 종료 — workspace_id 없음)을 함께 본다.
 * 상세(detail)는 저장 시 audit()가 비밀값 키를 가렸고, 읽을 때 한 번 더 redact()한다.
 * CSV 내보내기도 'audit.export'로 기록한다.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { badRequest } from '../lib/errors';
import { audit, redact } from '../audit/audit';
import { addDaysStr, kstIso, kstToday } from '../lib/time';
import { auditCsv, actionLabel, type AuditEntry } from '@/modules/audit/engine';
import type { Queryable } from '../db/pool';

/** 달력에 있는 날짜인지 (2026-02-31 · 2026-13-01 같은 값은 DB · 날짜 계산에서 500이 되므로 400으로 막는다) */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s < '1970-01-01' || s > '9998-12-31') return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(isCalendarDate, '달력에 없는 날짜');
const AuditQuery = z.object({
  action: z.string().trim().max(80).regex(/^[A-Za-z0-9_.]+$/, '영문 · 숫자 · _ · . 만').optional(),
  userId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid').optional(),
  from: DATE.optional(),
  to: DATE.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  auth: z.enum(['0', '1', 'true', 'false']).optional(),
  targetType: z.string().trim().max(60).optional(),
  targetId: z.string().trim().max(200).optional(),
});
export type AuditQueryInput = z.infer<typeof AuditQuery>;

/** 빈 문자열 · 공백뿐인 쿼리 값은 없는 것으로 (같은 키가 여러 번이면 마지막 값) */
function cleanQuery(q: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((q ?? {}) as Record<string, unknown>)) {
    const raw = Array.isArray(v) ? v[v.length - 1] : v;
    const val = typeof raw === 'string' ? raw.trim() : raw;
    if (val !== '' && val !== undefined && val !== null) out[k] = val;
  }
  return out;
}

export function parseAuditQuery(raw: unknown): AuditQueryInput {
  const f = parseBody(AuditQuery, cleanQuery(raw));
  if (f.from && f.to && f.from > f.to) throw badRequest('시작일이 종료일보다 늦습니다', [{ path: 'from', message: 'from > to' }]);
  return f;
}

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function auditWhere(wsId: string, f: AuditQueryInput): { sql: string; params: unknown[] } {
  const params: unknown[] = [wsId];
  const includeAccount = f.auth === '1' || f.auth === 'true';
  const conds: string[] = [
    includeAccount
      ? `(a.workspace_id = $1 OR (a.workspace_id IS NULL AND a.action LIKE 'auth.%' AND a.user_id IN (SELECT user_id FROM memberships WHERE workspace_id = $1)))`
      : 'a.workspace_id = $1',
  ];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replace('?', `$${params.length}`));
  };
  if (f.action) add(`a.action LIKE ? ESCAPE '\\'`, likePrefix(f.action));
  if (f.userId) add('a.user_id = ?::uuid', f.userId);
  if (f.from) add('a.at >= ?::timestamptz', kstIso(f.from));
  if (f.to) add('a.at < ?::timestamptz', kstIso(addDaysStr(f.to, 1)));
  if (f.targetType) add('a.target_type = ?', f.targetType);
  if (f.targetId) add('a.target_id = ?', f.targetId);
  if (f.before) add('a.id < ?::bigint', f.before);
  return { sql: conds.join(' AND '), params };
}

interface AuditRow {
  id: number; at: Date; actor: string; user_id: string | null; user_email: string | null; action: string;
  target_type: string | null; target_id: string | null; detail: Record<string, unknown>; ip: string | null; workspace_id: string | null;
}

export async function queryAudit(q: Queryable, wsId: string, f: AuditQueryInput, limit: number): Promise<AuditEntry[]> {
  const w = auditWhere(wsId, f);
  const rows = await q.query<AuditRow>(
    `SELECT a.id, a.at, a.actor, a.user_id, u.email AS user_email, a.action, a.target_type, a.target_id, a.detail, a.ip, a.workspace_id
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${w.sql} ORDER BY a.id DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    w.params,
  );
  return rows.rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    actor: r.actor,
    user_id: r.user_id,
    user_email: r.user_email,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    detail: redact(r.detail ?? {}),
    ip: r.ip,
    account: r.workspace_id === null,
  }));
}

export const CSV_MAX_ROWS = 50_000;

export const auditRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/w/:ws/audit', async (req) => {
    const c = await req.workspace('configure');
    const f = parseAuditQuery(req.query);
    const limit = f.limit ?? 100;
    const rows = await queryAudit(db, c.workspace.id, f, limit + 1);
    const entries = rows.slice(0, limit);
    return { entries, nextBefore: rows.length > limit ? entries[entries.length - 1].id : null };
  });

  app.get('/w/:ws/audit.csv', async (req, reply) => {
    const c = await req.workspace('configure');
    const f = parseAuditQuery(req.query);
    const rows = await queryAudit(db, c.workspace.id, { ...f, limit: undefined }, CSV_MAX_ROWS + 1);
    const truncated = rows.length > CSV_MAX_ROWS;
    const entries = rows.slice(0, CSV_MAX_ROWS);
    const { before: _b, limit: _l, ...filters } = f;
    await audit(db, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'audit.export', ip: c.ip,
      detail: { filters, rows: entries.length, truncated },
    });
    const filename = `audit-${c.workspace.slug}-${kstToday()}.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .header('x-audit-rows', String(entries.length))
      .header('x-audit-truncated', truncated ? 'true' : 'false');
    return reply.send(auditCsv(entries));
  });

  app.get('/w/:ws/audit/facets', async (req) => {
    const c = await req.workspace('configure');
    const actions = await db.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND at > now() - interval '180 days'
        GROUP BY action ORDER BY n DESC, action LIMIT 200`,
      [c.workspace.id],
    );
    const users = await db.query<{ id: string; name: string; email: string; member: boolean }>(
      `SELECT u.id, u.name, u.email, EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = $1 AND m.user_id = u.id) AS member
         FROM users u
        WHERE u.id IN (SELECT user_id FROM memberships WHERE workspace_id = $1)
           OR u.id IN (SELECT DISTINCT user_id FROM audit_log WHERE workspace_id = $1 AND user_id IS NOT NULL)
        ORDER BY lower(u.name) LIMIT 500`,
      [c.workspace.id],
    );
    return {
      actions: actions.rows.map((r) => ({ action: r.action, label: actionLabel(r.action), count: r.n })),
      users: users.rows,
    };
  });
};
