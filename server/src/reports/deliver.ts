/**
 * 리포트 발송 — '리포트 발송(report)' 이벤트를 켠 알림 채널마다 보내고, 결과를 reports.delivered[]와 발송 이력(notifications)에 남긴다.
 *
 *  Slack · 웹훅: alerts 도메인의 notify.send 잡으로 보낸다 (재시도 · 웹훅 서명 · SSRF 차단을 같이 쓴다). 본문 = 메신저형 요약 + 보관함 링크.
 *                잡 계약 (docs/SAAS_SPEC.md §6): notify.send { channelId, event: 'report', refId: <리포트 id>, payload: { title, text, link } }.
 *                notify.send 잡이 없는 환경이면 같은 메시지 형식으로 바로 보낸다(deps.directSender).
 *  메일:         리포트 마크다운 전문을 본문으로 바로 보낸다 (notify.send는 본문을 2,900자로 자르므로). SMTP 미설정이면 '보내지 않음'으로 남긴다.
 * 비밀값(웹훅 URL · 수신자)은 가린 표시만 기록한다.
 */
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import type { AppConfig } from '../config';
import { enqueue } from '../jobs/queue';
import { nowMs } from '../lib/time';
import { decryptConfig, maskConfig, type ChannelConfig, type ChannelRow, type EmailConfig } from '../alerts/channels';
import { loadWorkspaceInfo, NOTIFY_MAX_ATTEMPTS, recordNotification } from '../alerts/deliver';
import { buildMessage } from '../alerts/messages';
import { deps } from './deps';
import { REPORT_COLS, type DeliveryRecord, type ReportRow } from './generate';

const MAX_RECORDS = 60;
const SLACK_TEXT_MAX = 2900;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const reportLink = (appUrl: string) => `${appUrl}/#impact`;

export interface DeliverResult { row: ReportRow; records: DeliveryRecord[] }

/** 리포트 상태 — 발송 기록 중 한 번이라도 보냈거나(대기 포함) → delivered, 보낸 적 없이 실패만 → failed, 기록 없음 · 건너뜀만 → generated */
export function statusOf(records: readonly DeliveryRecord[]): ReportRow['status'] {
  if (records.some((x) => x.status === 'sent' || x.status === 'queued')) return 'delivered';
  if (records.some((x) => x.status === 'failed')) return 'failed';
  return 'generated';
}

/** 리포트 하나를 채널로 보낸다 (by = 감사 · 이력에 남길 행위자) */
export async function deliverReport(q: Queryable, config: AppConfig, wsId: string, reportId: string, by: string): Promise<DeliverResult> {
  const r = await one<ReportRow>(q, `SELECT ${REPORT_COLS} FROM reports WHERE workspace_id = $1 AND id = $2`, [wsId, reportId]);
  if (!r) throw new Error('리포트를 찾을 수 없습니다');
  const ws = await loadWorkspaceInfo(q, wsId);
  const chans = (await q.query<ChannelRow>(`SELECT * FROM notification_channels WHERE workspace_id = $1 AND enabled AND 'report' = ANY(events) ORDER BY created_at`, [wsId])).rows;
  const at = new Date(nowMs()).toISOString();
  const link = reportLink(config.appUrl);
  const testTag = r.data_mode === 'demo' ? ' [TEST DATA]' : '';
  const title = clip(`${r.title}${testTag}`, 200);
  const records: DeliveryRecord[] = [];
  const queue = deps.queueAvailable();

  if (!chans.length) {
    records.push({ channelId: null, channelType: null, channelName: '—', via: 'none', status: 'skipped', reason: "'리포트 발송' 이벤트를 켠 알림 채널이 없습니다 (알림 설정에서 채널을 추가하세요)", at, by });
  }
  for (const ch of chans) {
    const base = { channelId: ch.id, channelType: ch.type, channelName: ch.name, at, by };
    let cfg: ChannelConfig;
    try {
      cfg = decryptConfig(ch.config_enc, config.encryptionKey);
    } catch {
      const reason = '채널 설정을 복호화할 수 없습니다 (암호화 키 변경 여부 확인)';
      records.push({ ...base, via: 'none', status: 'failed', reason });
      await recordNotification(q, { workspaceId: wsId, channelId: ch.id, channelType: ch.type, event: 'report', refId: r.id, status: 'failed', detail: { reason, title } });
      continue;
    }
    const target = maskConfig(ch.type, cfg).target;
    if (ch.type === 'email') {
      const text = `${r.markdown}\n\n보관함에서 열기: ${link}\n워크스페이스 ${ws?.brand_name || ws?.name || ''} · MILDO OS Cloud 자동 발송`;
      const out = await deps.emailSender(config, { to: (cfg as EmailConfig).recipients, subject: `[MILDO OS] ${title}`, text });
      const status: DeliveryRecord['status'] = out.sent ? 'sent' : config.smtp || config.env === 'test' ? 'failed' : 'skipped';
      records.push({ ...base, via: 'direct', status, target, reason: out.sent ? null : out.reason ?? '사유 미상' });
      await recordNotification(q, {
        workspaceId: wsId, channelId: ch.id, channelType: ch.type, event: 'report', refId: r.id, status,
        detail: { subject: `[MILDO OS] ${title}`, target, via: 'direct', reason: out.sent ? null : out.reason ?? null, bytes: Buffer.byteLength(text) },
      });
      continue;
    }
    const text = clip(r.messenger || r.markdown, SLACK_TEXT_MAX);
    if (queue) {
      const jobId = await enqueue(q, {
        type: 'notify.send', workspaceId: wsId, maxAttempts: NOTIFY_MAX_ATTEMPTS,
        payload: { channelId: ch.id, event: 'report', refId: r.id, payload: { title, text, link } },
        dedupeKey: `notify:${ch.id}:report:${r.id}`,
      });
      records.push(jobId
        ? { ...base, via: 'notify.send', status: 'queued', jobId, target }
        : { ...base, via: 'notify.send', status: 'skipped', target, reason: '같은 리포트가 이 채널로 이미 발송 대기 중입니다' });
      continue;
    }
    if (!ws) { records.push({ ...base, via: 'direct', status: 'failed', target, reason: '워크스페이스 없음' }); continue; }
    const msg = buildMessage({ event: 'report', workspace: ws, appUrl: config.appUrl, generic: { title, text, link } });
    const out = await deps.directSender(config, ch.type, cfg, msg, { deliveryId: `report-${r.id}`, event: 'report' });
    records.push({ ...base, via: 'direct', status: out.status, target, reason: out.reason ?? null });
    await recordNotification(q, { workspaceId: wsId, channelId: ch.id, channelType: ch.type, event: 'report', refId: r.id, status: out.status, detail: { subject: msg.subject, target, via: 'direct', httpStatus: out.httpStatus ?? null, reason: out.reason ?? null } });
  }

  const ok = records.some((x) => x.status === 'sent' || x.status === 'queued');
  const all = [...(Array.isArray(r.delivered) ? r.delivered : []), ...records].slice(-MAX_RECORDS);
  const status = statusOf(all);
  const row = await one<ReportRow>(
    q,
    `UPDATE reports SET delivered = $3, status = $4, delivered_at = CASE WHEN $5 THEN $6::timestamptz ELSE delivered_at END WHERE workspace_id = $1 AND id = $2 RETURNING ${REPORT_COLS}`,
    [wsId, r.id, JSON.stringify(all), status, ok, at],
  );
  return { row: row!, records };
}

/**
 * 잡 큐로 보낸 기록의 최종 결과 반영 — notify.send가 남긴 발송 이력(notifications.job_id) · 잡 상태로 queued를 sent · failed · skipped로 바꾼다.
 * 조회 때 호출해 보관함이 실제 발송 결과를 보여 준다.
 */
export async function syncDelivered(q: Queryable, row: ReportRow): Promise<ReportRow> {
  const list = Array.isArray(row.delivered) ? row.delivered : [];
  const pending = list.filter((d) => d.status === 'queued' && d.jobId);
  if (!pending.length) return row;
  const ids = pending.map((d) => d.jobId!);
  const notes = new Map((await q.query<{ job_id: number; status: 'sent' | 'failed' | 'skipped'; detail: { reason?: string | null; retrying?: boolean } }>(
    `SELECT job_id, status, detail FROM notifications WHERE workspace_id = $1 AND job_id = ANY($2::bigint[])`, [row.workspace_id, ids],
  )).rows.map((n) => [Number(n.job_id), n]));
  const jobs = new Map((await q.query<{ id: number; status: string; last_error: string | null }>(`SELECT id, status, last_error FROM jobs WHERE id = ANY($1::bigint[])`, [ids])).rows.map((j) => [Number(j.id), j]));
  let changed = false;
  const next = list.map((d) => {
    if (d.status !== 'queued' || !d.jobId) return d;
    const n = notes.get(Number(d.jobId));
    const j = jobs.get(Number(d.jobId));
    if (n && !(n.status === 'failed' && n.detail?.retrying)) { changed = true; return { ...d, status: n.status, reason: n.detail?.reason ?? null }; }
    if (j?.status === 'failed') { changed = true; return { ...d, status: 'failed' as const, reason: j.last_error ?? '발송 잡 실패' }; }
    if (!j) { changed = true; return { ...d, status: 'failed' as const, reason: '발송 잡을 찾을 수 없습니다' }; }
    return d;
  });
  if (!changed) return row;
  const status = statusOf(next);
  const upd = await one<ReportRow>(q, `UPDATE reports SET delivered = $3, status = $4 WHERE workspace_id = $1 AND id = $2 RETURNING ${REPORT_COLS}`, [row.workspace_id, row.id, JSON.stringify(next), status]);
  return upd ?? row;
}
