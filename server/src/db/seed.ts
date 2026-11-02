/**
 * 초기 데이터 — 조직 · 수면밀도 워크스페이스 · 사용자 · 데모 커넥션.
 * 데모 커넥션은 data 도메인의 'ingest.backfill' 잡이 현재 날짜 기준 테스트 데이터를 웨어하우스에 채운다.
 */
import type { Db } from './pool';
import { one } from './pool';
import { hashPassword } from '../lib/crypto';
import { enqueue } from '../jobs/queue';

export interface SeedUser { email: string; name: string; password: string; role: 'owner' | 'admin' | 'pm' | 'ae' | 'client' | 'viewer' }

export interface SeedResult { orgId: string; workspaceId: string; users: Record<string, string>; demoConnectionId: string | null }

export async function seed(db: Db, opts: { users: SeedUser[]; demoData?: boolean; slug?: string; brand?: string; orgName?: string }): Promise<SeedResult> {
  return db.tx(async (q) => {
    const slug = opts.slug ?? 'mildo';
    const existing = await one<{ id: string; org_id: string }>(q, 'SELECT id, org_id FROM workspaces WHERE slug = $1', [slug]);
    let orgId: string;
    let wsId: string;
    if (existing) {
      orgId = existing.org_id;
      wsId = existing.id;
    } else {
      orgId = (await one<{ id: string }>(q, 'INSERT INTO organizations (name) VALUES ($1) RETURNING id', [opts.orgName ?? 'Progress Media']))!.id;
      wsId = (await one<{ id: string }>(
        q,
        `INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, slug, `${opts.brand ?? '수면밀도'} 퍼포먼스`, opts.brand ?? '수면밀도'],
      ))!.id;
    }
    const users: Record<string, string> = {};
    for (const u of opts.users) {
      const hash = await hashPassword(u.password);
      const row = await one<{ id: string }>(
        q,
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [u.email, u.name, hash],
      );
      users[u.email] = row!.id;
      await q.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [wsId, row!.id, u.role],
      );
    }
    let demoConnectionId: string | null = null;
    if (opts.demoData) {
      const c = await one<{ id: string }>(q, `SELECT id FROM connections WHERE workspace_id = $1 AND provider = 'demo'`, [wsId]);
      demoConnectionId = c?.id ?? (await one<{ id: string }>(
        q,
        `INSERT INTO connections (workspace_id, provider, kind, label, status, priority, write_mode)
         VALUES ($1, 'demo', 'other', '데모 데이터 (테스트용)', 'active', 10, 'dry_run') RETURNING id`,
        [wsId],
      ))!.id;
      await enqueue(q, { type: 'ingest.backfill', workspaceId: wsId, payload: { connectionId: demoConnectionId, days: 120 }, dedupeKey: `seed-demo:${wsId}` });
    }
    return { orgId, workspaceId: wsId, users, demoConnectionId };
  });
}
