/**
 * 보안 헤더 (devops 도메인이 강화 · 소유). 기본: 클릭재킹 방지, MIME 스니핑 방지, 리퍼러 최소화.
 */
import fp from '../auth/fp';
import type { FastifyInstance } from 'fastify';

export const securityPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    return payload;
  });
});
