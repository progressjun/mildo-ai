/** fastify-plugin 없이 캡슐화를 끄는 최소 래퍼 (플러그인 데코레이터를 상위 스코프에 노출) */
import type { FastifyPluginAsync } from 'fastify';
export default function fp<T extends FastifyPluginAsync>(fn: T): T {
  (fn as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
  return fn;
}
