/**
 * warehouse 도메인 진입점 (docs/SAAS_SPEC.md §4) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';

export const routes: FastifyPluginAsync = async () => {
  /* 구현 예정 */
};

export function jobs(_reg: JobRegistry): void {
  /* 구현 예정 */
}
