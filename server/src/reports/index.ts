/**
 * reports 도메인 진입점 (docs/SAAS_SPEC.md §4 reports-impact · §6) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 * API (보관함)
 *  GET  /w/:ws/reports?type=&limit=&before=        read     → { reports, nextBefore }   최신순 (본문 제외 · excerpt)
 *  GET  /w/:ws/reports/schedule                    read     → { schedule, today }       다음 예약 생성 · 발송 시각 (KST)
 *  GET  /w/:ws/reports/:id                         read     → { report }                마크다운 · 메신저 · 구조화 본문 · 발송 기록
 *  POST /w/:ws/reports/generate { type, periodStart?, month?, incidentId?, deliver? }  operate → { report }  (201)
 *  POST /w/:ws/reports/:id/deliver                 operate  → { report, results }
 *
 * 잡: reports.generate { type, periodStart?, month?, incidentId?, trigger?, deliver? } — 예약 · 이슈 생성은 대상당 한 번(dedupe) + 자동 발송
 * 스케줄 (KST): reports.daily 매일 08:00 · reports.weekly 매일 10:00 확인(월요일 · 휴무면 다음 영업일) · reports.monthly 매일 10:00 확인(3영업일) ·
 *               reports.value 매월 1일 09:00 · reports.issue 5분마다 (P1 이슈 중 이슈 리포트가 없는 것)
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import { one } from '../db/pool';
import { enqueue } from '../jobs/queue';
import { publish } from '../events/hub';
import { audit } from '../audit/audit';
import { notFound } from '../lib/errors';
import { parseBody, z } from '../lib/validate';
import { addDaysStr, kstParts, kstToday, nowMs } from '../lib/time';
import { withWorkspaceConfig } from '@/data/config';
import { loadWorkspaceConfig } from '../settings/service';
import { deliverReport, syncDelivered } from './deliver';
import { generateAndStore, getReport, REPORT_COLS, SERVER_REPORT_TYPES, toDto, type ReportRow, type ServerReportType } from './generate';
import { isMonthlySendDay, isWeeklySendDay, monthlyTargetFor, upcomingRuns, weeklyPeriodFor } from './schedule';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다');
const MonthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM 형식이어야 합니다');
const TypeEnum = z.enum(SERVER_REPORT_TYPES as unknown as [ServerReportType, ...ServerReportType[]]);
const IncidentIdStr = z.string().regex(/^[A-Za-z0-9_:.\-]{1,160}$/);

const ListQuery = z.object({
  type: TypeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime({ offset: true }).optional(),
});
const GenerateBody = z.object({
  type: TypeEnum,
  periodStart: DateStr.optional(),
  month: MonthStr.optional(),
  incidentId: IncidentIdStr.optional(),
  deliver: z.boolean().optional(),
});
const JobPayload = z.object({
  type: TypeEnum,
  periodStart: DateStr.optional(),
  month: MonthStr.optional(),
  incidentId: IncidentIdStr.optional(),
  trigger: z.enum(['schedule', 'incident', 'manual']).default('schedule'),
  deliver: z.boolean().default(true),
});

const perUser = (name: string) => (req: { session: { user: { id: string } } | null; ip: string }) => `${name}:${req.session?.user.id ?? req.ip}`;

export const routes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;

  app.get('/w/:ws/reports', async (req) => {
    const c = await req.workspace('read');
    const qy = parseBody(ListQuery, req.query);
    const rows = (await db.query<ReportRow>(
      `SELECT ${REPORT_COLS} FROM reports WHERE workspace_id = $1 AND ($2::text IS NULL OR type = $2) AND ($3::timestamptz IS NULL OR generated_at < $3)
        ORDER BY generated_at DESC, id DESC LIMIT $4`,
      [c.workspace.id, qy.type ?? null, qy.before ?? null, qy.limit],
    )).rows;
    const synced = await Promise.all(rows.map((r) => syncDelivered(db, r)));
    return { reports: synced.map((r) => toDto(r)), nextBefore: rows.length === qy.limit ? new Date(rows[rows.length - 1].generated_at).toISOString() : null };
  });

  app.get('/w/:ws/reports/schedule', async (req) => {
    const c = await req.workspace('read');
    const cfg = await loadWorkspaceConfig(db, c.workspace.id);
    const p = kstParts();
    const schedule = withWorkspaceConfig(cfg, () => upcomingRuns(p.date, p.hour, p.minute));
    return { schedule, today: p.date };
  });

  app.get('/w/:ws/reports/:id', async (req) => {
    const c = await req.workspace('read');
    const { id } = req.params as { id: string };
    const row = await getReport(db, c.workspace.id, id);
    if (!row) throw notFound('리포트를 찾을 수 없습니다');
    return { report: toDto(await syncDelivered(db, row), true) };
  });

  // 생성: 사용자당 분당 10회 (Dataset 빌드가 무겁다)
  app.post('/w/:ws/reports/generate', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: perUser('report-gen') } } }, async (req, reply) => {
    const c = await req.workspace('operate');
    const body = parseBody(GenerateBody, req.body);
    const { row } = await generateAndStore(db, c.workspace.id, {
      type: body.type, periodStart: body.periodStart, month: body.month, incidentId: body.incidentId, trigger: 'manual', dedupe: false, userId: c.user.id, actor: c.actor,
    }, config.appUrl);
    await audit(db, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'report.generate', targetType: 'report', targetId: row.id, ip: c.ip,
      detail: { type: row.type, periodStart: row.period_start, periodEnd: row.period_end, dataMode: row.data_mode, trigger: 'manual' },
    });
    let out = row;
    if (body.deliver) {
      const d = await deliverReport(db, config, c.workspace.id, row.id, c.actor);
      out = d.row;
      await audit(db, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'report.deliver', targetType: 'report', targetId: row.id, ip: c.ip,
        detail: { channels: d.records.length, results: d.records.map((x) => ({ channel: x.channelName, type: x.channelType, via: x.via, status: x.status })) },
      });
    }
    await publish(db, c.workspace.id, { type: 'report', id: row.id });
    reply.status(201);
    return { report: toDto(out, true) };
  });

  app.post('/w/:ws/reports/:id/deliver', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: perUser('report-deliver') } } }, async (req) => {
    const c = await req.workspace('operate');
    const { id } = req.params as { id: string };
    const row = await getReport(db, c.workspace.id, id);
    if (!row) throw notFound('리포트를 찾을 수 없습니다');
    const d = await deliverReport(db, config, c.workspace.id, row.id, c.actor);
    await audit(db, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'report.deliver', targetType: 'report', targetId: row.id, ip: c.ip,
      detail: { type: row.type, channels: d.records.length, results: d.records.map((x) => ({ channel: x.channelName, type: x.channelType, via: x.via, status: x.status, reason: x.reason ?? null })) },
    });
    await publish(db, c.workspace.id, { type: 'report', id: row.id });
    return { report: toDto(d.row, true), results: d.records };
  });
};

/** 이슈 리포트를 만들 P1 이슈 — 최근 48시간 감지 · 테스트 아님 · 아직 이슈 리포트 없음 */
async function p1WithoutReport(db: Parameters<typeof one>[0], wsId: string, sinceIso: string): Promise<string[]> {
  return (await db.query<{ id: string }>(
    `SELECT i.id FROM incidents i
      WHERE i.workspace_id = $1 AND i.severity = 'P1' AND i.detected_at >= $2 AND COALESCE((i.doc->>'isTest')::boolean, false) = false
        AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.workspace_id = i.workspace_id AND r.type = 'issue' AND (r.ref_id = i.id OR r.dedupe_key = 'issue:' || i.id))
      ORDER BY i.detected_at LIMIT 20`,
    [wsId, sinceIso],
  )).rows.map((r) => r.id);
}

export function jobs(reg: JobRegistry): void {
  reg.job('reports.generate', async (ctx) => {
    if (!ctx.workspaceId) return { skipped: '워크스페이스 없음' };
    const p = parseBody(JobPayload, ctx.payload);
    const scheduled = p.trigger !== 'manual';
    const { row, created } = await generateAndStore(ctx.db, ctx.workspaceId, {
      type: p.type, periodStart: p.periodStart, month: p.month, incidentId: p.incidentId, trigger: p.trigger, dedupe: scheduled, actor: 'system',
    }, ctx.config.appUrl);
    let delivered = 0;
    if (created) {
      await audit(ctx.db, {
        workspaceId: ctx.workspaceId, actor: 'system', action: 'report.generate', targetType: 'report', targetId: row.id,
        detail: { type: row.type, periodStart: row.period_start, periodEnd: row.period_end, dataMode: row.data_mode, trigger: p.trigger },
      });
      if (p.deliver) {
        const d = await deliverReport(ctx.db, ctx.config, ctx.workspaceId, row.id, 'system');
        delivered = d.records.filter((x) => x.status === 'queued' || x.status === 'sent').length;
        await audit(ctx.db, {
          workspaceId: ctx.workspaceId, actor: 'system', action: 'report.deliver', targetType: 'report', targetId: row.id,
          detail: { type: row.type, channels: d.records.length, results: d.records.map((x) => ({ channel: x.channelName, type: x.channelType, via: x.via, status: x.status })) },
        });
      }
      await ctx.publish(ctx.workspaceId, { type: 'report', id: row.id });
    }
    return { reportId: row.id, type: row.type, created, delivered };
  });

  // 일간 — 매일 08:00 · 전일 성과
  reg.schedule('reports.daily', '0 8 * * *', async (s) => {
    const day = addDaysStr(kstToday(), -1);
    for (const w of await s.activeWorkspaces()) {
      await enqueue(s.db, { type: 'reports.generate', workspaceId: w.id, payload: { type: 'daily', periodStart: day, trigger: 'schedule' }, dedupeKey: `reports.generate:daily:${w.id}:${day}`, maxAttempts: 3 });
    }
  });

  // 주간 — 매일 10:00에 '이번 주 발송일(월 · 휴무면 다음 영업일)'인지 확인 (워크스페이스 공휴일 설정 반영)
  reg.schedule('reports.weekly', '0 10 * * *', async (s) => {
    const today = kstToday();
    for (const w of await s.activeWorkspaces()) {
      const cfg = await loadWorkspaceConfig(s.db, w.id);
      if (!withWorkspaceConfig(cfg, () => isWeeklySendDay(today))) continue;
      const { start } = weeklyPeriodFor(today);
      await enqueue(s.db, { type: 'reports.generate', workspaceId: w.id, payload: { type: 'weekly', periodStart: start, trigger: 'schedule' }, dedupeKey: `reports.generate:weekly:${w.id}:${start}`, maxAttempts: 3 });
    }
  });

  // 월간 — 매일 10:00에 '이번 달 3영업일'인지 확인 · 지난달
  reg.schedule('reports.monthly', '0 10 * * *', async (s) => {
    const today = kstToday();
    for (const w of await s.activeWorkspaces()) {
      const cfg = await loadWorkspaceConfig(s.db, w.id);
      if (!withWorkspaceConfig(cfg, () => isMonthlySendDay(today))) continue;
      const month = monthlyTargetFor(today);
      await enqueue(s.db, { type: 'reports.generate', workspaceId: w.id, payload: { type: 'monthly', month, trigger: 'schedule' }, dedupeKey: `reports.generate:monthly:${w.id}:${month}`, maxAttempts: 3 });
    }
  });

  // 월간 가치 리포트 — 매월 1일 09:00 · 지난달 성과 증명 (06:00 측정 이후)
  reg.schedule('reports.value', '0 9 1 * *', async (s) => {
    const cur = kstToday().slice(0, 7);
    const [y, m] = cur.split('-').map(Number);
    const month = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    for (const w of await s.activeWorkspaces()) {
      await enqueue(s.db, { type: 'reports.generate', workspaceId: w.id, payload: { type: 'value', month, trigger: 'schedule' }, dedupeKey: `reports.generate:value:${w.id}:${month}`, maxAttempts: 3 });
    }
  });

  // 이슈 — 5분마다 P1 이슈 중 이슈 리포트가 없는 것 (이슈당 1건 · 잡 · 리포트 양쪽 중복 방지)
  reg.schedule('reports.issue', '*/5 * * * *', async (s) => {
    const since = new Date(nowMs() - 48 * 3600_000).toISOString();
    for (const w of await s.activeWorkspaces()) {
      for (const id of await p1WithoutReport(s.db, w.id, since)) {
        await enqueue(s.db, { type: 'reports.generate', workspaceId: w.id, payload: { type: 'issue', incidentId: id, trigger: 'incident' }, dedupeKey: `reports.generate:issue:${w.id}:${id}`, maxAttempts: 3 });
      }
    }
  });
}
