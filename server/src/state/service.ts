/**
 * state 도메인 저장 계층 — 코멘트(comments) · 모듈 로컬 입력(workspace_state).
 * 라우트(index.ts)와 다른 도메인(예: 리포트가 섹션 피드백을 읽을 때)이 같이 쓴다. 모든 쿼리는 workspace_id로 범위를 좁힌다.
 */
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import type { Role } from '../auth/permissions';

/** 키 형식 — 프런트 localStorage 키('mildo-os/lab/v1' 등)를 그대로 쓴다 */
export const STATE_KEY_RE = /^[a-z0-9:/._-]{1,120}$/;
/** 값 하나의 최대 크기 (JSON 직렬화 바이트) */
export const STATE_VALUE_MAX_BYTES = 256 * 1024;
/** 워크스페이스당 최대 키 수 (모듈 로컬 입력용 — 무한 증가 방지) */
export const STATE_MAX_KEYS = 500;
/**
 * 워크스페이스당 저장 값 합계 상한 (JSON 바이트). 로그인할 때마다 GET /state로 전부 내려받으므로
 * 키 수 상한 × 값 상한(500 × 256KB = 128MB)까지 커지지 않게 한다. 모듈 로컬 입력은 보통 수십 KB다.
 */
export const STATE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

export interface CommentRow {
  id: string;
  workspace_id: string;
  target: string;
  author: string;
  author_user: string | null;
  author_role: string | null;
  text: string;
  at: Date | string;
  resolved: boolean;
  resolved_at: Date | string | null;
  resolved_by: string | null;
}

/** API 응답 형식 (프런트 store Comment와 같은 키 + 서버 메타) */
export interface CommentDto {
  id: string;
  target: string;
  /** 작성자 이름 (세션 사용자 이름) */
  author: string;
  authorUser: string | null;
  /** 작성 시점 멤버십 역할 */
  authorRole: Role | null;
  text: string;
  at: string;
  resolved: boolean;
  resolvedAt: string | null;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export function toCommentDto(r: CommentRow): CommentDto {
  return {
    id: r.id,
    target: r.target,
    author: r.author,
    authorUser: r.author_user,
    authorRole: (r.author_role as Role | null) ?? null,
    text: r.text,
    at: iso(r.at)!,
    resolved: r.resolved,
    resolvedAt: iso(r.resolved_at),
  };
}

const COMMENT_COLS = 'id, workspace_id, target, author, author_user, author_role, text, at, resolved, resolved_at, resolved_by';

export async function listComments(q: Queryable, workspaceId: string, opts: { target?: string; limit?: number } = {}): Promise<CommentDto[]> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 5000);
  // 최근 limit건을 시간순(오래된 것 먼저)으로 — 프런트는 뒤에 붙이며 쌓는다
  const r = await q.query<CommentRow>(
    `SELECT * FROM (
       SELECT ${COMMENT_COLS} FROM comments
        WHERE workspace_id = $1 AND ($2::text IS NULL OR target = $2)
        ORDER BY at DESC, id DESC LIMIT $3
     ) t ORDER BY at ASC, id ASC`,
    [workspaceId, opts.target ?? null, limit],
  );
  return r.rows.map(toCommentDto);
}

export async function getComment(q: Queryable, workspaceId: string, id: string): Promise<CommentRow | null> {
  return one<CommentRow>(q, `SELECT ${COMMENT_COLS} FROM comments WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
}

/** 새 코멘트 — 같은 id가 이미 있으면 null (호출자가 멱등 재시도 · 충돌을 판정) */
export async function insertComment(
  q: Queryable,
  workspaceId: string,
  c: { id: string; target: string; text: string; author: string; authorUser: string; authorRole: Role },
): Promise<CommentRow | null> {
  return one<CommentRow>(
    q,
    `INSERT INTO comments (id, workspace_id, target, author, author_user, author_role, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, id) DO NOTHING
     RETURNING ${COMMENT_COLS}`,
    [c.id, workspaceId, c.target, c.author, c.authorUser, c.authorRole, c.text],
  );
}

export async function setCommentResolved(q: Queryable, workspaceId: string, id: string, resolved: boolean, userId: string): Promise<CommentRow | null> {
  return one<CommentRow>(
    q,
    `UPDATE comments
        SET resolved = $3,
            resolved_at = CASE WHEN $3 THEN now() ELSE NULL END,
            resolved_by = CASE WHEN $3 THEN $4::uuid ELSE NULL END,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${COMMENT_COLS}`,
    [workspaceId, id, resolved, userId],
  );
}

/* ---------- workspace_state ---------- */

export function stateValueBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export async function loadState(q: Queryable, workspaceId: string): Promise<Record<string, unknown>> {
  const r = await q.query<{ key: string; value: unknown }>('SELECT key, value FROM workspace_state WHERE workspace_id = $1 ORDER BY key', [workspaceId]);
  const out: Record<string, unknown> = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

export async function getStateRow(q: Queryable, workspaceId: string, key: string): Promise<{ value: unknown; updated_at: Date } | null> {
  return one(q, 'SELECT value, updated_at FROM workspace_state WHERE workspace_id = $1 AND key = $2', [workspaceId, key]);
}

/** 이 키를 뺀 나머지 값의 합계 크기 (jsonb 텍스트 바이트 — JSON.stringify 크기와 거의 같다) */
export async function stateBytesExcept(q: Queryable, workspaceId: string, key: string): Promise<number> {
  const r = await one<{ n: string | number }>(
    q,
    'SELECT coalesce(sum(octet_length(value::text)), 0)::bigint AS n FROM workspace_state WHERE workspace_id = $1 AND key <> $2',
    [workspaceId, key],
  );
  return Number(r?.n ?? 0);
}

export async function countStateKeys(q: Queryable, workspaceId: string): Promise<number> {
  const r = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM workspace_state WHERE workspace_id = $1', [workspaceId]);
  return r?.n ?? 0;
}

export async function upsertState(q: Queryable, workspaceId: string, key: string, value: unknown, userId: string): Promise<{ updated_at: Date }> {
  const r = await one<{ updated_at: Date }>(
    q,
    `INSERT INTO workspace_state (workspace_id, key, value, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING updated_at`,
    [workspaceId, key, JSON.stringify(value), userId],
  );
  return r!;
}

export async function deleteState(q: Queryable, workspaceId: string, key: string): Promise<boolean> {
  const r = await q.query('DELETE FROM workspace_state WHERE workspace_id = $1 AND key = $2', [workspaceId, key]);
  return r.rowCount > 0;
}

/** jsonb 비교용 정규화 (키 순서 무관) */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
