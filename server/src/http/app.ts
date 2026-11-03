/**
 * Fastify 앱 생성 — 서버(index.ts)와 테스트(server/test/app.ts)가 같이 쓴다.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerContext } from './context';
import { authPlugin } from '../auth/plugin';
import { authRoutes } from '../auth/routes';
import { tenancyRoutes } from '../tenancy/routes';
import { eventRoutes } from '../events/routes';
import { registerAllRoutes } from '../domains';
import { HttpError } from '../lib/errors';
import { securityPlugin, securityOptionsFromEnv } from './security';
import './context';

export const VERSION = process.env.APP_VERSION ?? '1.0.0';

export async function buildApp(ctx: ServerContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // trustProxy: 앞단 프록시 홉 수만 신뢰 (true면 클라이언트가 X-Forwarded-For로 IP를 위조할 수 있다 — 감사 로그 · 로그인 제한 키)
  const proxyHops = securityOptionsFromEnv(process.env, ctx.config.env).proxyHops;
  const app = Fastify({
    logger: opts.logger
      ? {
          level: ctx.config.logLevel,
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
          serializers: {
            // 초대 · 비밀번호 재설정 토큰이 URL에 실려 로그 저장소로 새지 않도록 가린다
            req: (req: { method?: string; url?: string; ip?: string; id?: string }) => ({ method: req.method, url: maskTokenUrl(String(req.url ?? '')), ip: req.ip, reqId: req.id }),
          },
        }
      : false,
    // 함수형: 소켓부터 오른쪽으로 proxyHops개만 신뢰 (security.ts clientIp와 같은 규칙 · 숫자형은 inject에서 XFF를 읽지 않는다)
    trustProxy: (_addr: string, i: number) => i < proxyHops,
    bodyLimit: 25 * 1024 * 1024, // CSV 업로드
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => {
      const h = req.headers['x-request-id'];
      const v = Array.isArray(h) ? h[0] : h;
      return typeof v === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(v) ? v : randomUUID();
    },
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
    if (e.statusCode === 429) return reply.status(429).send({ error: rateLimitedError(req.url, reply.getHeader('retry-after')) });
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

/**
 * 라우트 속도 제한(@fastify/rate-limit) 429 본문 — 플러그인이 붙인 retry-after(초)를 문구 · detail에 싣는다.
 * 로그인은 로그인 전용 문구(화면이 서버 문구를 그대로 보여 준다 — src/saas/AuthScreens.tsx authErrorMessage).
 */
export function rateLimitedError(url: string, retryAfter: unknown): { code: 'rate_limited'; message: string; detail?: { retryAfterSec: number } } {
  const sec = Math.ceil(Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter));
  const wait = Number.isFinite(sec) && sec > 0 ? `${sec}초 후` : '잠시 후';
  const login = url.split('?')[0] === '/api/auth/login';
  return {
    code: 'rate_limited',
    message: login ? `로그인 시도가 너무 많습니다. ${wait} 다시 시도해 주세요` : `요청이 너무 많습니다. ${wait} 다시 시도해 주세요`,
    ...(Number.isFinite(sec) && sec > 0 ? { detail: { retryAfterSec: sec } } : {}),
  };
}

/** 로그용 URL 마스킹: /api/invites/<token>… 경로와 ?invite= · ?reset= · ?token= 쿼리 값 */
export function maskTokenUrl(url: string): string {
  return url
    .replace(/(\/api\/invites\/)[^/?#]+/, '$1•••')
    .replace(/([?&](?:invite|reset|token)=)[^&#]*/gi, '$1•••');
}
