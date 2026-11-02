/** 서버 전역 컨텍스트 · Fastify 타입 확장 */
import type { Db } from '../db/pool';
import type { AppConfig } from '../config';
import type { EventHub } from '../events/hub';
import type { SessionInfo } from '../auth/session';
import type { Permission, Role } from '../auth/permissions';

export interface ServerContext {
  db: Db;
  config: AppConfig;
  events: EventHub;
}

export interface WorkspaceRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  brand_name: string;
  timezone: string;
  plan: string;
  status: string;
  config: Record<string, unknown>;
}

export interface WorkspaceCtx {
  user: SessionInfo['user'];
  session: SessionInfo;
  workspace: WorkspaceRow;
  role: Role;
  /** 감사 · 이력에 쓰는 행위자 표시 (이름) */
  actor: string;
  ip: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: ServerContext;
  }
  interface FastifyRequest {
    session: SessionInfo | null;
    /** 로그인 사용자 — 없으면 401 */
    requireUser(): SessionInfo;
    /** :ws 파라미터 워크스페이스 + 멤버십 + 권한(기본 read) 확인 — 멤버가 아니면 404 */
    workspace(perm?: Permission): Promise<WorkspaceCtx>;
  }
}
