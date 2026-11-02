/**
 * 워크스페이스 설정 읽기 — settings 도메인이 검증 · 기본값 병합을 완성한다. 다른 도메인은 이 함수만 쓴다:
 *   const cfg = await loadWorkspaceConfig(db, wsId);
 *   const result = withWorkspaceConfig(cfg, () => detectIncidents(dataset, ...));   // src/data/config.ts
 */
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import type { WorkspaceConfig } from '@/data/config';

export async function loadWorkspaceConfig(q: Queryable, workspaceId: string): Promise<WorkspaceConfig> {
  const r = await one<{ config: WorkspaceConfig }>(q, 'SELECT config FROM workspaces WHERE id = $1', [workspaceId]);
  return r?.config ?? {};
}
