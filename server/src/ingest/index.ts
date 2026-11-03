/**
 * ingest 도메인 진입점 (docs/SAAS_SPEC.md §4) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 * data 도메인의 API를 한곳에서 등록한다 (connectors/index.ts는 코어 계약 파일이라 비워 둔다):
 *   커넥터 카탈로그 · 커넥션 CRUD/확인/수동 수집 (connectors/catalog.ts · connectors/service.ts)
 *   수집 현황 · 데이터 품질 (ingest/routes.ts) · CSV 업로드 · 템플릿 (ingest/uploads.ts)
 * Dataset 조회(GET /api/w/:ws/dataset)는 warehouse/index.ts.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import { catalogRoutes } from '../connectors/catalog';
import { connectionRoutes } from '../connectors/service';
import { ingestRoutes } from './routes';
import { uploadRoutes } from './uploads';
import { registerIngestJobs } from './jobs';

export const routes: FastifyPluginAsync = async (app) => {
  await app.register(catalogRoutes);
  await app.register(connectionRoutes);
  await app.register(ingestRoutes);
  await app.register(uploadRoutes);
};

export function jobs(reg: JobRegistry): void {
  registerIngestJobs(reg);
}
