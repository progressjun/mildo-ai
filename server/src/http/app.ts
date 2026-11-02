/**
 * Fastify 앱 생성 — 서버(index.ts)와 테스트(server/test/app.ts)가 같이 쓴다.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerContext } from './context';
import { authPlugin } from '../auth/plugin';
import { authRoutes } from '../auth/routes';
import { tenancyRoutes } from '../tenancy/routes';
import { eventRoutes } from '../events/routes';
import { registerAllRoutes } from '../domains';
import { HttpError } from '../lib/errors';
import { securityPlugin } from './security';
import './context';

export const VERSION = process.env.APP_VERSION ?? '1.0.0';

export async function buildApp(ctx: ServerContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: ctx.config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] } : false,
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // CSV 업로드
  });
  app.decorate('ctx', ctx);

  await app.register(cookie, { secret: ctx.config.sessionSecret });
  await app.register(rateLimit, { global: false });
  await app.register(securityPlugin);
  await app.register(authPlugin);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, detail: err.detail } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요' } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message ?? '요청을 처리할 수 없습니다' } });
    req.log?.error?.(err);
    if (ctx.config.env !== 'production') console.error('[api error]', err);
    return reply.status(500).send({ error: { code: 'internal', message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요' } });
  });

  app.get('/api/health', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true, version: VERSION, time: new Date().toISOString() };
  });

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(tenancyRoutes, { prefix: '/api' });
  await app.register(eventRoutes, { prefix: '/api' });
  await registerAllRoutes(app);

  // 프로덕션: 빌드된 프런트를 같은 오리진에서 서빙 (해시 라우팅이므로 index.html 하나)
  if (ctx.config.staticDir) {
    const root = resolve(ctx.config.staticDir);
    if (existsSync(root)) {
      await app.register(fastifyStatic, { root, prefix: '/', index: ['index.html'], cacheControl: true, maxAge: '1h' });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'API 경로를 찾을 수 없습니다' } });
        return reply.sendFile('index.html');
      });
    }
  }
  if (!ctx.config.staticDir) {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: '경로를 찾을 수 없습니다' } }));
  }
  return app;
}
