/**
 * warehouse 도메인 진입점 (docs/SAAS_SPEC.md §4) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 *   GET /api/w/:ws/dataset?today=YYYY-MM-DD&hour=0..23&days=1..400  (read) → Dataset (src/core/types.ts, meta 포함)
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import { z, parseBody } from '../lib/validate';
import { buildDataset } from './dataset';

export { buildDataset } from './dataset';

const Query = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  hour: z.coerce.number().int().min(0).max(23).optional(),
  days: z.coerce.number().int().min(1).max(400).optional(),
});

export const routes: FastifyPluginAsync = async (app) => {
  app.get('/w/:ws/dataset', async (req, reply) => {
    const c = await req.workspace('read');
    const qs = parseBody(Query, req.query);
    const ds = await buildDataset(app.ctx.db, c.workspace.id, qs);
    reply.header('cache-control', 'no-store');
    return ds;
  });
};

export function jobs(_reg: JobRegistry): void {
  /* 웨어하우스 쓰기는 ingest 잡이 맡는다 */
}
