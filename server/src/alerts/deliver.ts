/**
 * 알림 발송 — 채널 선택(이벤트 · 등급 필터) → notify.send 잡 → 채널별 발송(Slack · 메일 · 웹훅) → 발송 이력(notifications).
 *
 * 잡 계약 (docs/SAAS_SPEC.md §6): notify.send `{ channelId, event, refId, payload }`.
 *   event: incident · sla · resolved (refId = 이슈 id, payload.stage = SLA 단계) · report 등 그 밖의 이벤트(payload = { title, text, link?, severity? }).
 * 재시도: 429 · 5xx · 네트워크 오류만(지수 백오프, 최대 4회). 4xx(잘못된 주소 · 삭제된 웹훅)와 SSRF 차단은 재시도하지 않는다.
 */
import { createHmac } from 'node:crypto';
import type { Severity } from '@/core/types';
import { withWorkspaceConfig } from '@/data/config';
import type { Queryable } from '../db/pool';
import { loadWorkspaceConfig } from '../settings/service';
import { one } from '../db/pool';
import type { AppConfig } from '../config';
import type { JobContext } from '../jobs/queue';
import { enqueue } from '../jobs/queue';
import { sendMail } from '../lib/mailer';
import { nowMs } from '../lib/time';
import { deps } from './deps';
import { OutboundBlockedError } from './net';
import { buildMessage, type Message, type MessageInput, type WorkspaceInfo } from './messages';
import { decryptConfig, maskConfig, severityAllowed, type ChannelConfig, type ChannelRow, type ChannelType, type EmailConfig, type SlackConfig, type WebhookConfig } from './channels';
import { getIncident, type EscStage, type StoredIncident } from './incidents';

export const NOTIFY_MAX_ATTEMPTS = 4;

export interface SendOutcome {
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
  httpStatus?: number;
  /** 다시 보내면 성공할 수 있는 실패 (429 · 5xx · 네트워크) */
  retryable?: boolean;
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 웹훅 서명: HMAC-SHA256(secret, `${timestamp}.${body}`) → 'sha256=<hex>' (수신 측은 같은 계산 후 시간 차 5분 이내인지 확인) */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function httpOutcome(status: number, body: string, kind: string): SendOutcome {
  if (status >= 200 && status < 300) return { status: 'sent', httpStatus: status };
  const detail = clip(body.trim().replace(/\s+/g, ' '), 200);
  const retryable = status === 429 || status >= 500 || status === 0;
  return { status: 'failed', httpStatus: status, retryable, reason: `${kind} 응답 ${status}${detail ? ` · ${detail}` : ''}` };
}

/** 채널 하나로 메시지 보내기 (테스트 발송 · 잡 공용) */
export async function sendToChannel(config: AppConfig, type: ChannelType, cfg: ChannelConfig, msg: Message, meta: { deliveryId: string; event: string }): Promise<SendOutcome> {
  try {
    if (type === 'slack') {
      const r = await deps.poster({ url: (cfg as SlackConfig).webhookUrl, body: JSON.stringify(msg.slack), headers: {} });
      // Slack은 성공 시 200 'ok', 실패 시 4xx + 오류 코드 텍스트 (invalid_payload · no_service · channel_is_archived 등)
      if (r.status === 200) return { status: 'sent', httpStatus: 200 };
      return httpOutcome(r.status, r.body, 'Slack');
    }
    if (type === 'webhook') {
      const w = cfg as WebhookConfig;
      const body = JSON.stringify(msg.webhook);
      const ts = String(Math.floor(nowMs() / 1000));
      const headers: Record<string, string> = { 'x-mildo-event': meta.event, 'x-mildo-delivery': meta.deliveryId, 'x-mildo-timestamp': ts };
      if (w.secret) headers['x-mildo-signature'] = signWebhook(w.secret, ts, body);
      const r = await deps.poster({ url: w.url, body, headers });
      return httpOutcome(r.status, r.body, '웹훅');
    }
    const e = cfg as EmailConfig;
    if (config.env !== 'test' && !config.smtp) return { status: 'skipped', reason: '서버 SMTP가 설정되지 않아 메일을 보내지 않았습니다 (SMTP_HOST)' };
    const r = await sendMail(config, { to: e.recipients, subject: msg.subject, text: msg.text });
    if (r.sent) return { status: 'sent' };
    return { status: 'failed', retryable: true, reason: clip(`메일 발송 실패 · ${r.reason ?? '사유 미상'}`) };
  } catch (err) {
    if (err instanceof OutboundBlockedError) return { status: 'failed', retryable: false, reason: err.message };
    return { status: 'failed', retryable: true, reason: clip(`전송 오류 · ${(err as Error)?.message ?? String(err)}`) };
  }
}

/* ------------------------------ 발송 이력 ------------------------------ */

export interface NotificationRecord {
  workspaceId: string;
  channelId: string | null;
  channelType?: ChannelType | null;
  event: string;
  refId?: string | null;
  severity?: Severity | null;
  status: 'sent' | 'failed' | 'skipped';
  detail: Record<string, unknown>;
  jobId?: number | null;
  attempts?: number;
}

/** 잡 하나는 한 줄 — 재시도 때 같은 줄을 갱신 */
export async function recordNotification(q: Queryable, r: NotificationRecord): Promise<void> {
  const params = [r.workspaceId, r.channelId, r.event, r.refId ?? null, r.status, JSON.stringify(r.detail), r.jobId ?? null, r.attempts ?? 1, r.channelType ?? null, r.severity ?? null];
  if (r.jobId) {
    await q.query(
      `INSERT INTO notifications (workspace_id, channel_id, event, ref_id, status, detail, job_id, attempts, channel_type, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_id) WHERE job_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, attempts = EXCLUDED.attempts, at = now()`,
      params,
    );
    return;
  }
  await q.query(
    `INSERT INTO notifications (workspace_id, channel_id, event, ref_id, status, detail, job_id, attempts, channel_type, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    params,
  );
}

async function markChannel(q: Queryable, channelId: string, o: SendOutcome, test = false): Promise<void> {
  await q.query(
    `UPDATE notification_channels SET last_status = $2, last_error = $3,
            last_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE last_sent_at END,
            last_test_at = CASE WHEN $4 THEN now() ELSE last_test_at END
      WHERE id = $1`,
    [channelId, o.status, o.status === 'sent' ? null : o.reason ?? null, test],
  );
}

/* ------------------------------ 채널 선택 · 잡 생성 ------------------------------ */

interface ChannelPick { id: string; type: ChannelType; min_severity: Severity; events: string[]; enabled: boolean }

/**
 * 이슈 알림을 받을 채널마다 notify.send 잡을 만든다. 테스트 데이터 이슈는 'test' 이벤트를 켠 채널만 받는다.
 * 등급 기준에 못 미쳐 보내지 않은 경우도 이력(skipped)에 남긴다.
 */
export async function fanOutIncident(q: Queryable, wsId: string, o: { event: 'incident' | 'sla' | 'resolved'; incident: StoredIncident; stage?: EscStage }): Promise<{ enqueued: number; skipped: number }> {
  const chans = (await q.query<ChannelPick>(`SELECT id, type, min_severity, events, enabled FROM notification_channels WHERE workspace_id = $1 ORDER BY created_at`, [wsId])).rows;
  const key = o.incident.isTest ? 'test' : o.event;
  let enqueued = 0, skipped = 0;
  for (const ch of chans) {
    if (!ch.enabled || !ch.events.includes(key)) continue;
    if (!severityAllowed(ch.min_severity, o.incident.severity)) {
      skipped++;
      await recordNotification(q, {
        workspaceId: wsId, channelId: ch.id, channelType: ch.type, event: o.event, refId: o.incident.id, severity: o.incident.severity, status: 'skipped',
        detail: { reason: `채널 등급 기준 ${ch.min_severity} 밖 (${o.incident.severity})`, title: o.incident.title, stage: o.stage ?? null },
      });
      continue;
    }
    const id = await enqueue(q, {
      type: 'notify.send', workspaceId: wsId, maxAttempts: NOTIFY_MAX_ATTEMPTS,
      payload: { channelId: ch.id, event: o.event, refId: o.incident.id, payload: o.stage ? { stage: o.stage } : {} },
      dedupeKey: `notify:${ch.id}:${o.event}:${o.stage ?? '-'}:${o.incident.id}`,
    });
    if (id) enqueued++;
  }
  return { enqueued, skipped };
}

/** 이슈가 아닌 알림(리포트 등)을 해당 이벤트를 켠 채널로 보낸다 — reports 도메인 등에서 쓴다 */
/** 메일 본문 전문 상한 (리포트 마크다운) — Slack · 웹훅은 text(2,900자)만 쓴다 */
export const EMAIL_BODY_MAX = 100_000;

/**
 * 이슈가 아닌 알림(리포트 등)을 채널별 notify.send 잡으로 만든다.
 * 반환값은 새로 만든 잡 수(기존 호출 호환). 채널별 잡 id가 필요하면 o.onEnqueued로 받는다.
 * o.body: 메일 채널에만 쓰는 본문 전문 (없으면 text).
 */
export async function fanOutGeneric(
  q: Queryable,
  wsId: string,
  o: { event: string; refId?: string; title: string; text: string; body?: string; link?: string; severity?: Severity; onEnqueued?: (e: { channelId: string; jobId: string }) => void },
): Promise<number> {
  const chans = (await q.query<ChannelPick>(`SELECT id, type, min_severity, events, enabled FROM notification_channels WHERE workspace_id = $1 AND enabled ORDER BY created_at`, [wsId])).rows;
  let n = 0;
  for (const ch of chans) {
    if (!ch.events.includes(o.event)) continue;
    if (o.severity && !severityAllowed(ch.min_severity, o.severity)) continue;
    const body = ch.type === 'email' && o.body ? o.body.slice(0, EMAIL_BODY_MAX) : undefined;
    const id = await enqueue(q, {
      type: 'notify.send', workspaceId: wsId, maxAttempts: NOTIFY_MAX_ATTEMPTS,
      payload: { channelId: ch.id, event: o.event, refId: o.refId ?? null, payload: { title: o.title, text: o.text, ...(body ? { body } : {}), link: o.link, severity: o.severity } },
      dedupeKey: o.refId ? `notify:${ch.id}:${o.event}:${o.refId}` : undefined,
    });
    if (id) {
      n++;
      o.onEnqueued?.({ channelId: ch.id, jobId: String(id) });
    }
  }
  return n;
}

/* ------------------------------ notify.send 잡 ------------------------------ */

export async function loadWorkspaceInfo(q: Queryable, wsId: string): Promise<WorkspaceInfo | null> {
  return one<WorkspaceInfo>(q, 'SELECT id, slug, name, brand_name FROM workspaces WHERE id = $1', [wsId]);
}

export async function notifySendJob(ctx: JobContext): Promise<SendOutcome & { channelId: string | null }> {
  const { db, config, job } = ctx;
  const wsId = ctx.workspaceId;
  const p = ctx.payload as { channelId?: string; event?: string; refId?: string | null; payload?: Record<string, unknown> };
  const event = String(p.event ?? 'incident');
  const refId = p.refId ?? null;
  if (!wsId || !p.channelId) return { status: 'skipped', reason: '잡 입력 누락 (workspaceId · channelId)', channelId: null };

  const base = { workspaceId: wsId, event, refId, jobId: job.id, attempts: job.attempts };
  const ch = await one<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE id = $1 AND workspace_id = $2', [p.channelId, wsId]);
  if (!ch) {
    await recordNotification(db, { ...base, channelId: null, status: 'skipped', detail: { reason: '채널이 삭제되었습니다' } });
    return { status: 'skipped', reason: '채널 삭제됨', channelId: null };
  }
  const rec = { ...base, channelId: ch.id, channelType: ch.type };
  if (!ch.enabled) {
    await recordNotification(db, { ...rec, status: 'skipped', detail: { reason: '채널이 꺼져 있습니다' } });
    return { status: 'skipped', reason: '채널 꺼짐', channelId: ch.id };
  }
  const ws = await loadWorkspaceInfo(db, wsId);
  if (!ws) return { status: 'skipped', reason: '워크스페이스 없음', channelId: ch.id };

  let input: MessageInput;
  let severity: Severity | null = null;
  const stage = (p.payload?.stage as EscStage | undefined) ?? undefined;
  if (event === 'incident' || event === 'sla' || event === 'resolved') {
    const inc = refId ? await getIncident(db, wsId, refId) : null;
    if (!inc) {
      await recordNotification(db, { ...rec, status: 'skipped', detail: { reason: '이슈를 찾을 수 없습니다' } });
      return { status: 'skipped', reason: '이슈 없음', channelId: ch.id };
    }
    severity = inc.severity;
    if (inc.status === 'resolved' && event !== 'resolved') {
      await recordNotification(db, { ...rec, severity, status: 'skipped', detail: { reason: '발송 전에 이미 해결된 이슈', title: inc.title, stage: stage ?? null } });
      return { status: 'skipped', reason: '이미 해결됨', channelId: ch.id };
    }
    input = { event, workspace: ws, appUrl: config.appUrl, incident: inc, stage };
  } else {
    const g = p.payload ?? {};
    severity = (g.severity as Severity | undefined) ?? null;
    input = { event: 'report', workspace: ws, appUrl: config.appUrl, generic: { title: String(g.title ?? 'MILDO OS 알림').slice(0, 200), text: String(g.text ?? '').slice(0, 2900), body: ch.type === 'email' && typeof g.body === 'string' ? g.body.slice(0, EMAIL_BODY_MAX) : undefined, link: typeof g.link === 'string' ? g.link : undefined, severity: severity ?? undefined } };
  }

  let cfg: ChannelConfig;
  try {
    cfg = decryptConfig(ch.config_enc, config.encryptionKey);
  } catch {
    const o: SendOutcome = { status: 'failed', reason: '채널 설정을 복호화할 수 없습니다 (암호화 키 변경 여부 확인)' };
    await recordNotification(db, { ...rec, severity, status: 'failed', detail: { reason: o.reason } });
    await markChannel(db, ch.id, o);
    return { ...o, channelId: ch.id };
  }
  // SLA 기한 표기는 워크스페이스 설정의 SLA를 따른다
  const wcfg = await loadWorkspaceConfig(db, wsId);
  const msg = withWorkspaceConfig(wcfg, () => buildMessage(input));
  const out = await sendToChannel(config, ch.type, cfg, msg, { deliveryId: `job-${job.id}`, event });
  const final = job.attempts >= job.max_attempts;
  const retrying = out.status === 'failed' && !!out.retryable && !final;
  await recordNotification(db, {
    ...rec, severity, status: out.status,
    detail: {
      subject: msg.subject, target: maskConfig(ch.type, cfg).target, stage: stage ?? null, httpStatus: out.httpStatus ?? null,
      reason: out.reason ?? null, retrying, nextRetryMin: retrying ? Math.min(60, 2 ** (job.attempts - 1)) : null, isTest: !!input.incident?.isTest,
    },
  });
  await markChannel(db, ch.id, out);
  // 발송 결과 → 알림 설정 화면(발송 이력 · 채널 마지막 결과) 갱신용 이벤트. 이벤트 실패가 발송 결과를 바꾸지 않게 삼킨다
  await ctx.publish(wsId, { type: 'notify', id: ch.id }).catch(() => undefined);
  if (out.status === 'failed' && out.retryable) throw new Error(out.reason ?? '발송 실패');
  return { ...out, channelId: ch.id };
}
