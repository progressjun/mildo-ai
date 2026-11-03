/**
 * 알림 채널 — 설정 검증(SSRF 방지) · 암호화 저장(config_enc) · 화면용 마스킹.
 *
 * Slack Incoming Webhook: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 *   URL 형식 `https://hooks.slack.com/services/T…/B…/…` (URL 자체가 비밀값), POST JSON `{ text, blocks }`, 성공 시 200 `ok`.
 * 이메일: 서버 SMTP(lib/mailer.ts, SMTP_HOST 등) · 수신자 목록만 채널에 저장.
 * 일반 웹훅: https 공인 주소만, 선택 서명 비밀값(HMAC-SHA256 → X-Mildo-Signature).
 */
import type { Severity } from '@/core/types';
import { decryptJson, encryptJson } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { z } from '../lib/validate';
import { checkOutboundUrl } from './net';

export type ChannelType = 'slack' | 'email' | 'webhook';
export const CHANNEL_TYPES: readonly ChannelType[] = ['slack', 'email', 'webhook'];

/** 채널이 받을 이벤트 — incident(새 이슈) · sla(SLA 기한 초과 에스컬레이션) · resolved(해결 공유) · report(리포트 발송) · test(테스트 데이터 이슈) */
export type ChannelEvent = 'incident' | 'sla' | 'resolved' | 'report' | 'test';
export const CHANNEL_EVENTS: readonly ChannelEvent[] = ['incident', 'sla', 'resolved', 'report', 'test'];
export const DEFAULT_EVENTS: ChannelEvent[] = ['incident', 'sla', 'report'];

export interface SlackConfig { webhookUrl: string }
export interface EmailConfig { recipients: string[] }
export interface WebhookConfig { url: string; secret?: string }
export type ChannelConfig = SlackConfig | EmailConfig | WebhookConfig;

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

const SlackSchema = z.object({ webhookUrl: z.string().trim().max(500) });
const EmailSchema = z.object({ recipients: z.array(z.string().trim().toLowerCase().email().max(200)).min(1).max(20) });
const WebhookSchema = z.object({ url: z.string().trim().max(1000), secret: z.string().min(16).max(256).optional() });

/** 채널 설정 검증 — 실패하면 400 (사유 한국어) */
export function validateConfig(type: ChannelType, input: unknown): ChannelConfig {
  if (type === 'slack') {
    const r = SlackSchema.safeParse(input);
    if (!r.success) throw badRequest('Slack Incoming Webhook URL을 입력하세요', [{ path: 'config.webhookUrl', message: '필수' }]);
    if (!SLACK_RE.test(r.data.webhookUrl)) {
      throw badRequest('Slack 웹훅 주소는 https://hooks.slack.com/services/… 형식이어야 합니다', [{ path: 'config.webhookUrl', message: 'Slack 앱 설정 → Incoming Webhooks에서 복사한 주소' }]);
    }
    return { webhookUrl: r.data.webhookUrl };
  }
  if (type === 'email') {
    const r = EmailSchema.safeParse(input);
    if (!r.success) throw badRequest('수신자 이메일을 1~20개 입력하세요 (형식 확인)', r.error.issues.map((i) => ({ path: `config.${i.path.join('.')}`, message: i.message })));
    return { recipients: [...new Set(r.data.recipients)] };
  }
  const r = WebhookSchema.safeParse(input);
  if (!r.success) throw badRequest('웹훅 URL을 입력하세요 (서명 비밀값은 16자 이상)', r.error.issues.map((i) => ({ path: `config.${i.path.join('.')}`, message: i.message })));
  const chk = checkOutboundUrl(r.data.url);
  if (!chk.ok) throw badRequest(`웹훅 주소를 쓸 수 없습니다: ${chk.reason}`, [{ path: 'config.url', message: chk.reason }]);
  return r.data.secret ? { url: r.data.url, secret: r.data.secret } : { url: r.data.url };
}

export const encryptConfig = (cfg: ChannelConfig, key: string) => encryptJson(cfg, key);
export const decryptConfig = <T extends ChannelConfig = ChannelConfig>(blob: string, key: string): T => decryptJson<T>(blob, key);

/* ------------------------------ 마스킹 ------------------------------ */

/** URL은 오리진만 보이고 경로(비밀 토큰)는 가린다 */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const rest = `${u.pathname}${u.search}`;
    return `${u.origin}/••••${rest.length > 1 ? `(${rest.length}자)` : ''}`;
  } catch {
    return '••••';
  }
}
export function maskEmail(e: string): string {
  const [local, domain] = e.split('@');
  if (!domain) return '••••';
  return `${local.slice(0, Math.min(2, local.length))}••••@${domain}`;
}

export interface MaskedConfig {
  /** 화면 표시용 요약 (비밀값 없음) */
  target: string;
  webhookUrl?: string;
  url?: string;
  recipients?: string[];
  hasSecret?: boolean;
}
export function maskConfig(type: ChannelType, cfg: ChannelConfig): MaskedConfig {
  if (type === 'slack') {
    const m = maskUrl((cfg as SlackConfig).webhookUrl);
    return { target: `Slack · ${m}`, webhookUrl: m };
  }
  if (type === 'email') {
    const rs = (cfg as EmailConfig).recipients.map(maskEmail);
    return { target: `메일 · ${rs.length}명`, recipients: rs };
  }
  const w = cfg as WebhookConfig;
  const m = maskUrl(w.url);
  return { target: `웹훅 · ${m}`, url: m, hasSecret: !!w.secret };
}

/* ------------------------------ 행 → API ------------------------------ */

export interface ChannelRow {
  id: string;
  workspace_id: string;
  type: ChannelType;
  name: string;
  config_enc: string;
  min_severity: Severity;
  events: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_test_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: Date | null;
}

export interface ChannelView {
  id: string;
  type: ChannelType;
  name: string;
  minSeverity: Severity;
  events: string[];
  enabled: boolean;
  config: MaskedConfig;
  createdAt: string;
  updatedAt: string;
  lastTestAt: string | null;
  lastSentAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

export function channelView(r: ChannelRow, key: string): ChannelView {
  let config: MaskedConfig;
  try {
    config = maskConfig(r.type, decryptConfig(r.config_enc, key));
  } catch {
    config = { target: '설정을 읽을 수 없습니다 (암호화 키 확인)' };
  }
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id, type: r.type, name: r.name, minSeverity: r.min_severity, events: r.events, enabled: r.enabled, config,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, lastTestAt: iso(r.last_test_at), lastSentAt: iso(r.last_sent_at),
    lastStatus: r.last_status, lastError: r.last_error,
  };
}

/** 등급 필터: min_severity P2 → P1 · P2 발송, P3 제외 */
export function severityAllowed(min: Severity, sev: Severity): boolean {
  const rank = (s: Severity) => (s === 'P1' ? 1 : s === 'P2' ? 2 : 3);
  return rank(sev) <= rank(min);
}
