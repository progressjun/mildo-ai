/**
 * state 도메인 진입점 (platform 담당) — 코멘트 API · 모듈 로컬 입력(workspace_state) 보관 API.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';

export const routes: FastifyPluginAsync = async () => {
  /* 구현 예정 */
};

export function jobs(_reg: JobRegistry): void {
  /* 없음 */
}
