/**
 * alerts 도메인 진입점 (docs/SAAS_SPEC.md §4 alerts · §6) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 * API
 *  GET    /w/:ws/incidents                    read      → { incidents }  열린 이슈 전부 + 최근 해결 500건
 *  POST   /w/:ws/incidents  { incident }      operate   → { incident, created }  클라이언트 생성 이슈(AD Pilot 보류 · 테스트 주입), id 중복이면 기존 그대로
 *  PATCH  /w/:ws/incidents/:id { patch, action } operate → { incident }  상태 흐름 open → ack → action → resolved, 해결 후 재오픈
 *  POST   /w/:ws/alerts/scan                  operate   → { found, created, cleared, notified, warning? }
 *  GET    /w/:ws/alerts/runs                  read      → { runs }  감지 실행 기록 (24시간 감지 증빙)
 *  GET    /w/:ws/alerts/policy                read      → { sla, regime, roster, tiers }
 *  GET    /w/:ws/notify/channels              read      → { channels }  (설정 값 마스킹)
 *  POST   /w/:ws/notify/channels              configure → { channel }
 *  PATCH  /w/:ws/notify/channels/:id          configure → { channel }
 *  DELETE /w/:ws/notify/channels/:id          configure → { ok }
 *  POST   /w/:ws/notify/channels/:id/test     configure → { result, channel }
 *  GET    /w/:ws/notify/log?channelId=&status=&event=&before=&limit=  read → { entries, nextBefore }
 *         event=test는 이벤트 이름이 아니라 TEST DATA 이슈 알림(detail.isTest) 전체 — 저장되는 event는 incident · sla · resolved 그대로다
 *
 * 잡: alerts.scan · alerts.sla(SLA 에스컬레이션 + 다른 도메인이 직접 넣은 이슈 알림 접수) · notify.send (스케줄: 감지 10분마다, SLA 1분마다)
 *
 * 이벤트: 이슈 변경 → 'incident', 알림 채널 생성 · 수정 · 삭제 · 테스트 발송 · 발송 결과 → 'notify'(id = 채널 id).
 * 플랫폼 SSE 목록에 'notify'가 있으면 알림 설정 화면이 onServerEvent('notify')로 다른 사용자의 변경을 반영한다.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Severity } from '@/core/types';
import { SLA } from '@/data/constants';
import { withWorkspaceConfig } from '@/data/config';
import { regimeOf, rotationTable } from '@/modules/alert/engine';
import { WEEKEND_ACK_MIN, WEEKEND_TIERS } from '@/modules/alert/data';
import type { JobRegistry } from '../domains';
import { one } from '../db/pool';
import { enqueue } from '../jobs/queue';
import { publish } from '../events/hub';
import { audit } from '../audit/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { parseBody, z } from '../lib/validate';
import { kstToday, nowMs } from '../lib/time';
import { loadWorkspaceConfig } from '../settings/service';
import {
  applyIncidentPatch, getIncident, IncidentId, IncidentInput, IncidentPatch, insertIncident, listIncidents, normalizeClientIncident, nowIso, saveIncident,
} from './incidents';
import { scanWorkspace } from './scan';
import { intakeSweep, slaSweep } from './sla';
import {
  CHANNEL_EVENTS, CHANNEL_TYPES, channelView, decryptConfig, DEFAULT_EVENTS, encryptConfig, maskConfig, validateConfig, type ChannelConfig, type ChannelRow,
} from './channels';
import { fanOutIncident, loadWorkspaceInfo, notifySendJob, recordNotification, sendToChannel } from './deliver';
import { buildMessage } from './messages';
import { ROLE_LABEL } from '../auth/permissions';

const MAX_CHANNELS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Uuid = z.string().regex(UUID_RE);

const IncidentCreateBody = z.object({ incident: IncidentInput });
const IncidentPatchBody = z.object({ patch: IncidentPatch.default({}), action: z.string().max(500).optional() });

const ChannelCreateBody = z.object({
  type: z.enum(CHANNEL_TYPES as [string, ...string[]]),
  name: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.unknown()),
  minSeverity: z.enum(['P1', 'P2', 'P3']).default('P2'),
  events: z.array(z.enum(CHANNEL_EVENTS as [string, ...string[]])).min(1).max(CHANNEL_EVENTS.length).default(DEFAULT_EVENTS),
  enabled: z.boolean().default(true),
});
const ChannelPatchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  minSeverity: z.enum(['P1', 'P2', 'P3']).optional(),
  events: z.array(z.enum(CHANNEL_EVENTS as [string, ...string[]])).min(1).max(CHANNEL_EVENTS.length).optional(),
  enabled: z.boolean().optional(),
});
const ChannelTestBody = z.object({ sample: z.boolean().optional() });
const LogQuery = z.object({
  channelId: Uuid.optional(),
  status: z.enum(['sent', 'failed', 'skipped']).optional(),
  event: z.string().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const byLabel = (actor: string, role: keyof typeof ROLE_LABEL) => `${actor} (${ROLE_LABEL[role]})`;

export const routes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const key = config.encryptionKey;

  /* ============================== 이슈 ============================== */

  app.get('/w/:ws/incidents', async (req) => {
    const c = await req.workspace('read');
    return { incidents: await listIncidents(db, c.workspace.id) };
  });

  app.post('/w/:ws/incidents', async (req, reply) => {
    const c = await req.workspace('operate');
    const body = parseBody(IncidentCreateBody, req.body);
    const by = byLabel(c.actor, c.role);
    const wcfg = await loadWorkspaceConfig(db, c.workspace.id);
    const offHoursMode = (wcfg as { offHoursMode?: unknown }).offHoursMode === true;
    const doc = withWorkspaceConfig(wcfg, () => normalizeClientIncident(body.incident, by, nowMs(), { offHoursMode }));
    // 새로 저장되면 같은 트랜잭션에서 '새 이슈' 알림 잡을 만든다 (알림 접수 기록 — SLA 잡의 접수 대상에서 빠진다)
    if (doc.status !== 'resolved') doc.notifiedAt = nowIso();
    const out = await db.tx(async (q) => {
      const created = await insertIncident(q, c.workspace.id, doc);
      const incident = await getIncident(q, c.workspace.id, doc.id);
      if (created) {
        await audit(q, {
          workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'incident.create', targetType: 'incident', targetId: doc.id, ip: c.ip,
          detail: { severity: doc.severity, ruleId: doc.ruleId, title: doc.title, isTest: doc.isTest, source: 'client' },
        });
        if (incident && incident.status !== 'resolved') await fanOutIncident(q, c.workspace.id, { event: 'incident', incident });
        await publish(q, c.workspace.id, { type: 'incident', id: doc.id });
      }
      return { incident, created };
    });
    reply.status(out.created ? 201 : 200);
    return out;
  });

  app.patch('/w/:ws/incidents/:id', async (req) => {
    const c = await req.workspace('operate');
    const id = parseBody(z.object({ id: IncidentId }), req.params).id;
    const body = parseBody(IncidentPatchBody, req.body);
    const by = byLabel(c.actor, c.role);
    return db.tx(async (q) => {
      const cur = await getIncident(q, c.workspace.id, id, true);
      if (!cur) throw notFound('이슈를 찾을 수 없습니다');
      const r = applyIncidentPatch(cur, body.patch, body.action, by);
      await saveIncident(q, c.workspace.id, r.doc, { resolvedAt: r.to === 'resolved' && r.from !== 'resolved' ? 'set' : r.transition === 'reopen' ? 'clear' : 'keep' });
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: r.transition === 'reopen' ? 'incident.reopen' : 'incident.update', targetType: 'incident', targetId: id, ip: c.ip,
        detail: { from: r.from, to: r.to, changed: r.changed, action: r.doc.timeline[r.doc.timeline.length - 1]?.action, severity: r.doc.severity },
      });
      if (r.to === 'resolved' && r.from !== 'resolved') await fanOutIncident(q, c.workspace.id, { event: 'resolved', incident: r.doc });
      await publish(q, c.workspace.id, { type: 'incident', id });
      return { incident: r.doc };
    });
  });

  // 수동 감지: 사용자당 분당 12회 (같은 사무실 IP를 쓰는 여러 운영자가 서로 막지 않도록 사용자 기준)
  const perUser = (name: string) => (req: { session: { user: { id: string } } | null; ip: string }) => `${name}:${req.session?.user.id ?? req.ip}`;
  app.post('/w/:ws/alerts/scan', { config: { rateLimit: { max: 12, timeWindow: '1 minute', keyGenerator: perUser('scan') } } }, async (req) => {
    const c = await req.workspace('operate');
    const r = await scanWorkspace(db, c.workspace.id, { trigger: 'manual', actor: c.actor });
    await audit(db, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'alerts.scan', targetType: 'workspace', targetId: c.workspace.id, ip: c.ip,
      detail: { found: r.found, created: r.created, cleared: r.cleared, warning: r.warning ?? null },
    });
    return { found: r.found, created: r.created, cleared: r.cleared, redetected: r.redetected, notified: r.notified, createdIds: r.createdIds.slice(0, 100), warning: r.warning ?? null, dataToday: r.dataToday ?? null };
  });

  app.get('/w/:ws/alerts/runs', async (req) => {
    const c = await req.workspace('read');
    const runs = (await db.query(
      `SELECT id, trigger, status, found, created, cleared, notified, data_today AS "dataToday", data_hour AS "dataHour", data_mode AS "dataMode",
              warning, duration_ms AS "durationMs", started_at AS "startedAt", finished_at AS "finishedAt"
         FROM alert_scan_runs WHERE workspace_id = $1 ORDER BY started_at DESC, id DESC LIMIT 200`,
      [c.workspace.id],
    )).rows;
    return { runs };
  });

  app.get('/w/:ws/alerts/policy', async (req) => {
    const c = await req.workspace('read');
    const cfg = await loadWorkspaceConfig(db, c.workspace.id);
    const today = kstToday();
    // 설정(settings)이 SLA 상수를 덮어쓰면 그 값 — withWorkspaceConfig 안에서 읽는다
    const sla = withWorkspaceConfig(cfg, () => JSON.parse(JSON.stringify(SLA)) as typeof SLA);
    const forced = (cfg as { offHoursMode?: unknown }).offHoursMode === true;
    const { regime, roster } = withWorkspaceConfig(cfg, () => ({ regime: regimeOf(today, forced), roster: rotationTable(today, 60) }));
    return { sla, weekendAckMin: WEEKEND_ACK_MIN, regime: { off: regime.off, label: regime.label, duty: regime.duty, forced: regime.forced }, roster, tiers: WEEKEND_TIERS, today };
  });

  /* ============================== 알림 채널 ============================== */

  const loadChannel = async (wsId: string, id: string) => {
    if (!UUID_RE.test(id)) throw notFound('채널을 찾을 수 없습니다');
    const ch = await one<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE id = $1 AND workspace_id = $2', [id, wsId]);
    if (!ch) throw notFound('채널을 찾을 수 없습니다');
    return ch;
  };

  app.get('/w/:ws/notify/channels', async (req) => {
    const c = await req.workspace('read');
    const rows = (await db.query<ChannelRow>('SELECT * FROM notification_channels WHERE workspace_id = $1 ORDER BY created_at', [c.workspace.id])).rows;
    return { channels: rows.map((r) => channelView(r, key)) };
  });

  app.post('/w/:ws/notify/channels', async (req, reply) => {
    const c = await req.workspace('configure');
    const body = parseBody(ChannelCreateBody, req.body);
    const type = body.type as ChannelRow['type'];
    const cfg = validateConfig(type, body.config);
    const count = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM notification_channels WHERE workspace_id = $1', [c.workspace.id]);
    if ((count?.n ?? 0) >= MAX_CHANNELS) throw conflict(`채널은 워크스페이스당 ${MAX_CHANNELS}개까지 만들 수 있습니다`);
    const row = await db.tx(async (q) => {
      const r = await one<ChannelRow>(
        q,
        `INSERT INTO notification_channels (workspace_id, type, name, config_enc, min_severity, events, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [c.workspace.id, type, body.name, encryptConfig(cfg, key), body.minSeverity, [...new Set(body.events)], body.enabled, c.user.id],
      );
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'notify.channel.create', targetType: 'notification_channel', targetId: r!.id, ip: c.ip,
        detail: { type, name: body.name, target: maskConfig(type, cfg).target, minSeverity: body.minSeverity, events: body.events, enabled: body.enabled },
      });
      await publish(q, c.workspace.id, { type: 'notify', id: r!.id });
      return r!;
    });
    reply.status(201);
    return { channel: channelView(row, key) };
  });

  app.patch('/w/:ws/notify/channels/:id', async (req) => {
    const c = await req.workspace('configure');
    const ch = await loadChannel(c.workspace.id, (req.params as { id: string }).id);
    const body = parseBody(ChannelPatchBody, req.body);
    let enc = ch.config_enc;
    let target: string | undefined;
    if (body.config) {
      let cur: Record<string, unknown> = {};
      try { cur = decryptConfig(ch.config_enc, key) as unknown as Record<string, unknown>; } catch { cur = {}; }
      // 비어 있는 값은 '기존 값 유지' (화면은 마스킹된 값만 알고 있다). 웹훅 서명 비밀값을 지우려면 secret: null
      const merged: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(body.config)) {
        if (v === null) delete merged[k];
        else if (v === '' || (Array.isArray(v) && !v.length)) continue;
        else merged[k] = v;
      }
      const cfg: ChannelConfig = validateConfig(ch.type, merged);
      enc = encryptConfig(cfg, key);
      target = maskConfig(ch.type, cfg).target;
    }
    const row = await db.tx(async (q) => {
      const r = await one<ChannelRow>(
        q,
        `UPDATE notification_channels SET name = COALESCE($3, name), config_enc = $4, min_severity = COALESCE($5, min_severity),
                events = COALESCE($6, events), enabled = COALESCE($7, enabled), updated_at = now()
          WHERE id = $1 AND workspace_id = $2 RETURNING *`,
        [ch.id, c.workspace.id, body.name ?? null, enc, body.minSeverity ?? null, body.events ? [...new Set(body.events)] : null, body.enabled ?? null],
      );
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'notify.channel.update', targetType: 'notification_channel', targetId: ch.id, ip: c.ip,
        detail: {
          before: { name: ch.name, minSeverity: ch.min_severity, events: ch.events, enabled: ch.enabled },
          after: { name: r!.name, minSeverity: r!.min_severity, events: r!.events, enabled: r!.enabled },
          configChanged: !!body.config, target: target ?? null,
        },
      });
      await publish(q, c.workspace.id, { type: 'notify', id: ch.id });
      return r!;
    });
    return { channel: channelView(row, key) };
  });

  app.delete('/w/:ws/notify/channels/:id', async (req) => {
    const c = await req.workspace('configure');
    const ch = await loadChannel(c.workspace.id, (req.params as { id: string }).id);
    await db.tx(async (q) => {
      await q.query('DELETE FROM notification_channels WHERE id = $1 AND workspace_id = $2', [ch.id, c.workspace.id]);
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'notify.channel.delete', targetType: 'notification_channel', targetId: ch.id, ip: c.ip,
        detail: { type: ch.type, name: ch.name },
      });
      await publish(q, c.workspace.id, { type: 'notify', id: ch.id });
    });
    return { ok: true };
  });

  app.post('/w/:ws/notify/channels/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: perUser('notify-test') } } }, async (req) => {
    const c = await req.workspace('configure');
    const ch = await loadChannel(c.workspace.id, (req.params as { id: string }).id);
    const body = parseBody(ChannelTestBody, req.body);
    let cfg: ChannelConfig;
    try { cfg = decryptConfig(ch.config_enc, key); } catch { throw badRequest('채널 설정을 읽을 수 없습니다. 설정을 다시 저장해 주세요'); }
    const ws = (await loadWorkspaceInfo(db, c.workspace.id))!;
    const latest = body.sample
      ? (await listIncidents(db, c.workspace.id)).find((i) => i.status !== 'resolved')
      : undefined;
    const wcfg = await loadWorkspaceConfig(db, c.workspace.id);
    const msg = withWorkspaceConfig(wcfg, () => latest
      ? buildMessage({ event: 'incident', workspace: ws, appUrl: config.appUrl, incident: { ...latest, title: `[연결 확인 · 예시] ${latest.title}`, isTest: true } })
      : buildMessage({
        event: 'channel_test', workspace: ws, appUrl: config.appUrl,
        generic: { title: 'MILDO OS 알림 채널 연결 확인', text: `${c.actor}님이 '${ch.name}' 채널 테스트를 보냈습니다. 이 채널은 ${ch.min_severity} 이상 · ${ch.events.join(', ')} 이벤트를 받습니다. 실제 알림에는 등급 · 기준 · 관측 · 변화 · 원인 후보 · 영향 추정 · SLA 기한이 함께 갑니다.` },
      }));
    const result = await sendToChannel(config, ch.type, cfg, msg, { deliveryId: `test-${nowMs()}`, event: 'channel_test' });
    await recordNotification(db, {
      workspaceId: c.workspace.id, channelId: ch.id, channelType: ch.type, event: 'channel_test', refId: latest?.id ?? null, status: result.status,
      detail: { subject: msg.subject, target: maskConfig(ch.type, cfg).target, httpStatus: result.httpStatus ?? null, reason: result.reason ?? null, by: c.actor, sample: !!latest },
    });
    const row = await one<ChannelRow>(
      db,
      `UPDATE notification_channels SET last_test_at = now(), last_status = $2, last_error = $3, last_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE last_sent_at END
        WHERE id = $1 RETURNING *`,
      [ch.id, result.status, result.status === 'sent' ? null : result.reason ?? null],
    );
    await audit(db, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'notify.channel.test', targetType: 'notification_channel', targetId: ch.id, ip: c.ip,
      detail: { status: result.status, httpStatus: result.httpStatus ?? null, reason: result.reason ?? null },
    });
    await publish(db, c.workspace.id, { type: 'notify', id: ch.id });
    return { result: { ok: result.status === 'sent', status: result.status, httpStatus: result.httpStatus ?? null, reason: result.reason ?? null }, channel: channelView(row!, key) };
  });

  app.get('/w/:ws/notify/log', async (req) => {
    const c = await req.workspace('read');
    const qy = parseBody(LogQuery, req.query);
    const rows = (await db.query<{ id: number; at: Date; channel_id: string | null; channel_name: string | null; channel_type: string | null; event: string; ref_id: string | null; severity: Severity | null; status: string; attempts: number; detail: Record<string, unknown> }>(
      `SELECT n.id, n.at, n.channel_id, c.name AS channel_name, COALESCE(n.channel_type, c.type) AS channel_type, n.event, n.ref_id, n.severity, n.status, n.attempts, n.detail
         FROM notifications n LEFT JOIN notification_channels c ON c.id = n.channel_id
        WHERE n.workspace_id = $1 AND ($2::uuid IS NULL OR n.channel_id = $2) AND ($3::text IS NULL OR n.status = $3)
          AND ($4::text IS NULL OR ($4 = 'test' AND COALESCE(n.detail->>'isTest', 'false') = 'true') OR ($4 <> 'test' AND n.event = $4))
          AND ($5::bigint IS NULL OR n.id < $5)
        ORDER BY n.id DESC LIMIT $6`,
      [c.workspace.id, qy.channelId ?? null, qy.status ?? null, qy.event ?? null, qy.before ?? null, qy.limit],
    )).rows;
    return {
      entries: rows.map((r) => ({
        id: r.id, at: new Date(r.at).toISOString(), channelId: r.channel_id, channelName: r.channel_name ?? '(삭제된 채널)', channelType: r.channel_type, event: r.event,
        refId: r.ref_id, severity: r.severity, status: r.status, attempts: r.attempts, detail: r.detail,
      })),
      nextBefore: rows.length === qy.limit ? rows[rows.length - 1].id : null,
    };
  });
};

export function jobs(reg: JobRegistry): void {
  reg.job('alerts.scan', async (ctx) => {
    if (!ctx.workspaceId) return { skipped: 'workspaceId 없음' };
    // 계기: 예약(trigger: 'schedule') · 수집 직후(data 도메인이 reason: 'ingest'로 넣는다)
    const r = await scanWorkspace(ctx.db, ctx.workspaceId, { trigger: String(ctx.payload.trigger ?? ctx.payload.reason ?? 'job').slice(0, 40) });
    if (r.warning) ctx.log(`경고: ${r.warning}`);
    return { ...r, createdIds: r.createdIds.slice(0, 50) };
  });
  reg.job('alerts.sla', async (ctx) => {
    if (!ctx.workspaceId) return { skipped: 'workspaceId 없음' };
    // 다른 도메인이 직접 넣은 이슈(대량 변경 등)를 먼저 알림 접수 → 같은 실행에서 SLA 판정
    const intake = await intakeSweep(ctx.db, ctx.workspaceId);
    const r = await slaSweep(ctx.db, ctx.workspaceId);
    const errors = [...intake.errors, ...r.errors];
    if (errors.length) ctx.log(`이슈 ${errors.length}건 처리 실패 (나머지는 계속 처리): ${errors.slice(0, 3).map((e) => `${e.id} · ${e.error}`).join(' | ')}`);
    return { checked: r.checked, escalated: r.escalated.slice(0, 50), notified: r.notified, intake: intake.notified.slice(0, 50), errors: errors.slice(0, 20) };
  });
  reg.job('notify.send', notifySendJob);

  // 24시간 감지: 10분마다 활성 워크스페이스 전부 (수집 직후 감지는 data 도메인이 alerts.scan을 enqueue)
  reg.schedule('alerts.scan', '*/10 * * * *', async (s) => {
    const slot = Math.floor(nowMs() / 600_000);
    for (const w of await s.activeWorkspaces()) {
      await enqueue(s.db, { type: 'alerts.scan', workspaceId: w.id, payload: { trigger: 'schedule' }, dedupeKey: `alerts.scan:${w.id}:${slot}`, maxAttempts: 2 });
    }
  });
  // SLA 타이머: 1분마다, 열린 이슈가 있는 활성 워크스페이스만 (이전 잡이 대기 · 실행 중이면 건너뜀)
  reg.schedule('alerts.sla', '* * * * *', async (s) => {
    const rows = (await s.db.query<{ workspace_id: string }>(
      `SELECT DISTINCT i.workspace_id FROM incidents i JOIN workspaces w ON w.id = i.workspace_id AND w.status = 'active' WHERE i.status <> 'resolved'`,
    )).rows;
    for (const r of rows) await enqueue(s.db, { type: 'alerts.sla', workspaceId: r.workspace_id, dedupeKey: `alerts.sla:${r.workspace_id}`, maxAttempts: 1 });
  });
}
