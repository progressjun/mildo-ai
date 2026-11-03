/**
 * settings 도메인 진입점 (docs/SAAS_SPEC.md §4 · §6) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 *  GET  /w/:ws/config                read      → { config(저장된 덮어쓰기), effective(기본값 병합), defaults, overridden, invalid, preserved, version, updatedAt, updatedBy }
 *  PUT  /w/:ws/config                configure { config, baseVersion?, dryRun? } → 위와 같은 형태 + { changed, dryRun, changes }
 *                                              검증 실패 400 invalid_config(detail = 항목별 사유) · baseVersion 불일치 409 · 감사(이전 → 이후 차이) · 'config' 이벤트
 *                                              billing.*(월 구독료 — 회수 배수의 분모)를 바꾸는 저장은 owner 권한만, 아니면 403 forbidden(detail.paths)
 *  GET  /w/:ws/config/history        read      ?before=&limit= → { entries, nextBefore }  (audit_log target_type = 'workspace_config')
 *  GET  /w/:ws/config/onboarding     read      → { onboarding: { firstRun, steps[데이터 연결 · 팀 초대 · 목표 · 예산 확인 · 알림 채널], done, total } }
 *  POST /w/:ws/config/review         configure { note? } → 기본값 확인 기록(감사 'config.review') + { onboarding }
 *
 * 잡 · 스케줄은 없다(§6 잡 타입 계약에 settings 항목 없음) — 설정은 다른 도메인 잡이 loadWorkspaceConfig로 읽는다.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import { parseBody, z } from '../lib/validate';
import { configHistory, onboardingState, readConfigState, reviewConfig, saveConfig } from './service';

const PutBody = z.object({
  config: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().min(0).optional(),
  dryRun: z.boolean().optional(),
});
const HistoryQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const ReviewBody = z.object({ note: z.string().max(300).optional() });

export const routes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/w/:ws/config', async (req) => {
    const c = await req.workspace('read');
    return readConfigState(db, c.workspace.id);
  });

  app.put('/w/:ws/config', async (req) => {
    const c = await req.workspace('configure');
    const body = parseBody(PutBody, req.body);
    return saveConfig(db, c, body.config, { baseVersion: body.baseVersion, dryRun: body.dryRun });
  });

  app.get('/w/:ws/config/history', async (req) => {
    const c = await req.workspace('read');
    const q = parseBody(HistoryQuery, req.query);
    return configHistory(db, c.workspace.id, q);
  });

  app.get('/w/:ws/config/onboarding', async (req) => {
    const c = await req.workspace('read');
    return { onboarding: await onboardingState(db, c.workspace.id) };
  });

  app.post('/w/:ws/config/review', async (req) => {
    const c = await req.workspace('configure');
    const body = parseBody(ReviewBody, req.body);
    await reviewConfig(db, c, body.note);
    return { onboarding: await onboardingState(db, c.workspace.id) };
  });
};

export function jobs(_reg: JobRegistry): void {
  /* settings 도메인은 잡 · 스케줄을 등록하지 않는다 */
}
