/**
 * 감사 로그 — 모든 상태 변경을 남긴다. 비밀값으로 보이는 키는 저장 전에 가린다.
 */
import type { Queryable } from '../db/pool';

const SECRET_KEY = /(secret|token|password|passwd|apikey|api_key|credential|webhook|authorization|cookie|private)/i;

export function redact<T>(v: T, depth = 0): T {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? (val ? '••••' : val) : redact(val, depth + 1);
  }
  return out as T;
}

export interface AuditEntry {
  workspaceId: string | null;
  userId?: string | null;
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string | null;
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (workspace_id, user_id, actor, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.workspaceId, e.userId ?? null, e.actor, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(redact(e.detail ?? {})), e.ip ?? null],
  );
}
