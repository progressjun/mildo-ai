/**
 * impact 도메인 진입점 (docs/SAAS_SPEC.md §4 reports-impact · §6) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 * API
 *  GET  /w/:ws/impact/summary?month=YYYY-MM          read     → { summary }   회수 배수 · 구성 요소(방법 · 신뢰도 · 표본) · 전제 · 반례
 *  GET  /w/:ws/impact/ledger?month=&type=&status=    read     → { entries }   장부 (변경 → 전/후/대조/추정/상태)
 *  GET  /w/:ws/impact/ledger.csv?month=              read     → text/csv
 *  POST /w/:ws/impact/measure { force? }              operate  → { result, summary }  즉시 측정 (매일 06:00 예약 측정과 같은 계산)
 *
 * 잡: impact.measure (스케줄 impact.measure — 매일 06:00 KST, 워크스페이스마다)
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import { enqueue } from '../jobs/queue';
import { publish } from '../events/hub';
import { audit } from '../audit/audit';
import { parseBody, z } from '../lib/validate';
import { kstToday } from '../lib/time';
import { isMonthKey, ledgerCsv } from '@/modules/impact/engine';
import { measureWorkspace } from './measure';
import { listEntries, summaryFor } from './service';

const Month = z.string().refine(isMonthKey, { message: 'YYYY-MM 형식이어야 합니다' });
const SummaryQuery = z.object({ month: Month.optional() });
const LedgerQuery = z.object({
  month: Month.optional(),
  type: z.enum(['change', 'incident', 'automation']).optional(),
  status: z.enum(['pending', 'measured', 'insufficient', 'excluded']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});
const MeasureBody = z.object({ force: z.boolean().optional() });

const thisMonth = () => kstToday().slice(0, 7);

export const routes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/w/:ws/impact/summary', async (req) => {
    const c = await req.workspace('read');
    const qy = parseBody(SummaryQuery, req.query);
    const { summary } = await summaryFor(db, c.workspace.id, qy.month ?? thisMonth());
    return { summary };
  });

  app.get('/w/:ws/impact/ledger', async (req) => {
    const c = await req.workspace('read');
    const qy = parseBody(LedgerQuery, req.query);
    return { entries: await listEntries(db, c.workspace.id, qy) };
  });

  app.get('/w/:ws/impact/ledger.csv', async (req, reply) => {
    const c = await req.workspace('read');
    const qy = parseBody(LedgerQuery, req.query);
    const entries = await listEntries(db, c.workspace.id, { ...qy, limit: 2000 });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="impact-ledger-${qy.month ?? 'all'}.csv"`);
    return ledgerCsv(entries);
  });

  // 즉시 측정: 사용자당 분당 6회 (웨어하우스 범위 조회가 무겁다)
  app.post('/w/:ws/impact/measure', { config: { rateLimit: { max: 6, timeWindow: '1 minute', keyGenerator: (req: { session: { user: { id: string } } | null; ip: string }) => `impact:${req.session?.user.id ?? req.ip}` } } }, async (req) => {
    const c = await req.workspace('operate');
    const body = parseBody(MeasureBody, req.body);
    const result = await measureWorkspace(db, c.workspace.id, { force: body.force });
    await audit(db, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'impact.measure', targetType: 'workspace', targetId: c.workspace.id, ip: c.ip,
      detail: { force: !!body.force, changes: result.changes, incidents: result.incidents, automation: result.automation },
    });
    await publish(db, c.workspace.id, { type: 'report', id: 'impact' });
    const { summary } = await summaryFor(db, c.workspace.id, thisMonth());
    return { result, summary };
  });
};

export function jobs(reg: JobRegistry): void {
  reg.job('impact.measure', async (ctx) => {
    if (!ctx.workspaceId) return { skipped: '워크스페이스 없음' };
    const force = (ctx.payload as { force?: unknown }).force === true;
    const result = await measureWorkspace(ctx.db, ctx.workspaceId, { force });
    await audit(ctx.db, {
      workspaceId: ctx.workspaceId, actor: 'system', action: 'impact.measure', targetType: 'workspace', targetId: ctx.workspaceId,
      detail: { trigger: 'schedule', changes: result.changes, incidents: result.incidents, automation: result.automation },
    });
    await ctx.publish(ctx.workspaceId, { type: 'report', id: 'impact' });
    return result;
  });

  // 매일 06:00 KST — 전일 확정 수집(07:00) 전이므로 그저께까지 확정된 창만 측정한다 (measure.ts lastFinal)
  reg.schedule('impact.measure', '0 6 * * *', async (s) => {
    const today = kstToday();
    for (const w of await s.activeWorkspaces()) {
      await enqueue(s.db, { type: 'impact.measure', workspaceId: w.id, payload: {}, dedupeKey: `impact.measure:${w.id}:${today}`, maxAttempts: 3 });
    }
  });
}
