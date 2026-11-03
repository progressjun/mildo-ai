/**
 * 알림 설정 — 화면 · 에이전트 공용 모델 (순수 함수 · React 없음).
 * 서버 계약: docs/SAAS_SPEC.md §6 alerts (GET/POST /notify/channels · PATCH/DELETE …/:id · POST …/:id/test · GET /notify/log),
 * 구현: server/src/alerts/*.ts. 화면 검증은 즉시 안내용이고 최종 판정(SSRF 차단 포함)은 서버가 한다.
 * 데모 모드 예시는 모두 TEST DATA (실제 채널 · 발송 아님).
 */
import type { Severity } from '@/core/types';
import { SEVERITY_LABEL, SLA } from '@/data/constants';
import { WEEKEND_ACK_MIN, WEEKEND_TIERS } from '@/modules/alert/data';
import { detectIncidents, fmtStamp, regimeOf, rotationTable, type DutyRow } from '@/modules/alert/engine';
import { DEMO } from '@/data/demo';

/* ------------------------------ 계약 타입 (서버 응답) ------------------------------ */

export type ChannelType = 'slack' | 'email' | 'webhook';
export type ChannelEvent = 'incident' | 'sla' | 'resolved' | 'report' | 'test';

export interface MaskedConfig { target: string; webhookUrl?: string; url?: string; recipients?: string[]; hasSecret?: boolean }

export interface Channel {
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

export interface LogEntry {
  id: number;
  at: string;
  channelId: string | null;
  channelName: string;
  channelType: string | null;
  event: string;
  refId: string | null;
  severity: Severity | null;
  status: 'sent' | 'failed' | 'skipped';
  attempts: number;
  detail: { subject?: string; target?: string; reason?: string | null; httpStatus?: number | null; retrying?: boolean; stage?: string | null; isTest?: boolean; title?: string };
}

export interface ScanRun {
  id: number;
  trigger: string;
  status: 'ok' | 'warning' | 'failed';
  found: number;
  created: number;
  cleared: number;
  notified: number;
  dataToday: string | null;
  dataHour: number | null;
  dataMode: string | null;
  warning: string | null;
  durationMs: number | null;
  startedAt: string;
}

export interface Policy {
  sla: typeof SLA;
  weekendAckMin: number;
  regime: { off: boolean; label: string; duty: DutyRow | null; forced?: boolean };
  roster: DutyRow[];
  tiers: readonly { tier: string; who: string; what: string; when: string }[];
  today: string;
}

/* ------------------------------ 라벨 ------------------------------ */

export const TYPE_LABEL: Record<ChannelType, string> = { slack: 'Slack', email: '이메일', webhook: '웹훅' };
export const TYPE_ICON: Record<ChannelType, string> = { slack: 'send', email: 'inbox', webhook: 'link' };
export const EVENT_OPTIONS: { id: ChannelEvent; label: string; hint: string }[] = [
  { id: 'incident', label: '새 이슈', hint: '서버 24시간 감지 · 화면 생성 이슈' },
  { id: 'sla', label: 'SLA 기한 초과', hint: '인지 · 1차 조치 · 결과 보고 기한이 지나면 백업 · PM 에스컬레이션' },
  { id: 'resolved', label: '해결 공유', hint: '조치 내용 · 재발 방지 기록 포함' },
  { id: 'report', label: '리포트', hint: '일간 · 주간 · 월간 리포트 발송' },
  { id: 'test', label: '테스트 데이터 이슈', hint: '켜면 위에서 고른 이슈 이벤트(새 이슈 · SLA · 해결 공유)를 데모 데이터 · 테스트 주입 이슈(TEST DATA 표기)에도 보냅니다. 이것만 켜면 TEST DATA 이슈 알림만 받는 시연 채널' },
];

/** 이슈 이벤트 — 'test'(테스트 데이터 이슈)는 이 이벤트들을 TEST DATA 이슈에도 보낼지 정하는 추가 조건 (서버 server/src/alerts/deliver.ts channelWantsIncident와 같은 규칙) */
export const INCIDENT_EVENTS: readonly ChannelEvent[] = ['incident', 'sla', 'resolved'];
export function channelWantsIncident(events: readonly string[], event: string, isTest: boolean): boolean {
  if (!isTest) return events.includes(event);
  if (!events.includes('test')) return false;
  return !INCIDENT_EVENTS.some((e) => events.includes(e)) || events.includes(event);
}

/** 발송 이력 필터 — 이벤트 '테스트 데이터 이슈'(test)는 이벤트 이름이 아니라 TEST DATA 이슈 알림 전체(detail.isTest) — 서버 GET /notify/log?event=test와 같은 규칙 */
export function logMatches(l: LogEntry, f: { status?: string; event?: string; channelId?: string }): boolean {
  if (f.status && l.status !== f.status) return false;
  if (f.channelId && l.channelId !== f.channelId) return false;
  if (f.event) return f.event === 'test' ? !!l.detail?.isTest : l.event === f.event;
  return true;
}
export const EVENT_LABEL: Record<string, string> = {
  ...Object.fromEntries(EVENT_OPTIONS.map((e) => [e.id, e.label])),
  channel_test: '연결 테스트',
};
export const STATUS_TEXT: Record<LogEntry['status'], string> = { sent: '발송', failed: '실패', skipped: '보내지 않음' };
export const TRIGGER_LABEL: Record<string, string> = { schedule: '예약 · 10분마다', ingest: '수집 직후', manual: '수동 실행', job: '잡 큐 (수집 직후 등)' };
export const SEVERITY_SCOPE: { id: Severity; label: string }[] = [
  { id: 'P1', label: 'P1만' },
  { id: 'P2', label: 'P1 · P2' },
  { id: 'P3', label: '전체 (P3 포함)' },
];
export const severityScopeLabel = (s: Severity) => SEVERITY_SCOPE.find((x) => x.id === s)?.label ?? s;
export const severityAllowed = (min: Severity, sev: Severity) => Number(sev.slice(1)) <= Number(min.slice(1));

/* ------------------------------ 입력 검증 (화면 안내용 · 서버가 최종) ------------------------------ */

export interface ChannelDraft {
  type: ChannelType;
  name: string;
  webhookUrl: string;
  url: string;
  secret: string;
  removeSecret: boolean;
  recipients: string;
  minSeverity: Severity;
  events: ChannelEvent[];
  enabled: boolean;
}

export const emptyDraft = (type: ChannelType = 'slack'): ChannelDraft => ({
  type, name: '', webhookUrl: '', url: '', secret: '', removeSecret: false, recipients: '', minSeverity: 'P2', events: ['incident', 'sla'], enabled: true,
});

export function draftFromChannel(c: Channel): ChannelDraft {
  return { ...emptyDraft(c.type), name: c.name, minSeverity: c.minSeverity, events: c.events.filter((e): e is ChannelEvent => EVENT_OPTIONS.some((o) => o.id === e)), enabled: c.enabled };
}

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 서버(server/src/alerts/net.ts)와 같은 내부망 이름 규칙 — 끝까지 일치해야 막는다 (hooks.local-partner.com 같은 공인 이름은 통과) */
const BLOCKED_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.lan$/i, /\.home\.arpa$/i, /^metadata$/i];
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PRIVATE_V4 = /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^192\.0\.[02]\.|^198\.1[89]\.|^198\.51\.100\.|^203\.0\.113\.|^(?:22[4-9]|2[3-5]\d)\./;
/** IPv6: 미지정 · 루프백 · IPv4 매핑/호환 · 고유 로컬 · 링크 로컬 · 멀티캐스트 · 문서용 · NAT64 */
const PRIVATE_V6 = /^(?:::|fc|fd|fe[89ab]|fec|fed|fee|fef|ff|2001:db8|64:ff9b|2002:)/i;

export const parseRecipients = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** 외부 주소 빠른 검사 — https만, 사설 · 루프백 · 링크 로컬 · 내부망 이름 차단 (최종 판정과 발송 시점 주소 검사는 서버) */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'URL 형식이 아닙니다'; }
  if (u.protocol !== 'https:') return 'https:// 주소만 쓸 수 있습니다';
  if (u.username || u.password) return 'URL에 사용자 이름 · 비밀번호를 넣을 수 없습니다';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.includes(':')) return PRIVATE_V6.test(host) ? '사설 · 루프백 · 내부망 주소로는 보낼 수 없습니다' : null;
  if (IPV4_RE.test(host)) return PRIVATE_V4.test(host) || host === '255.255.255.255' ? '사설 · 루프백 · 내부망 주소로는 보낼 수 없습니다' : null;
  if (BLOCKED_NAMES.some((re) => re.test(host))) return '내부망 이름(localhost · .local · .internal 등)으로는 보낼 수 없습니다';
  if (!host.includes('.')) return '도메인 이름 전체를 입력하세요';
  return null;
}

/** 필드별 문제 (없으면 빈 객체). editing=true면 비워 둔 주소 · 비밀값은 '기존 값 유지' */
export function draftProblems(d: ChannelDraft, editing = false): Partial<Record<'name' | 'webhookUrl' | 'url' | 'secret' | 'recipients' | 'events', string>> {
  const p: Partial<Record<'name' | 'webhookUrl' | 'url' | 'secret' | 'recipients' | 'events', string>> = {};
  if (!d.name.trim()) p.name = '채널 이름을 입력하세요';
  else if (d.name.trim().length > 80) p.name = '80자 이내로 입력하세요';
  if (!d.events.length) p.events = '받을 이벤트를 하나 이상 고르세요';
  if (d.type === 'slack') {
    const v = d.webhookUrl.trim();
    if (!v && !editing) p.webhookUrl = 'Slack Incoming Webhook URL을 붙여 넣으세요';
    else if (v && !SLACK_RE.test(v)) p.webhookUrl = 'https://hooks.slack.com/services/… 형식이어야 합니다';
  }
  if (d.type === 'webhook') {
    const v = d.url.trim();
    if (!v && !editing) p.url = '받을 https 주소를 입력하세요';
    else if (v) { const why = urlProblem(v); if (why) p.url = why; }
    if (d.secret && d.secret.length < 16) p.secret = '서명 비밀값은 16자 이상';
  }
  if (d.type === 'email') {
    const rs = parseRecipients(d.recipients);
    if (!rs.length && !editing) p.recipients = '수신자 이메일을 입력하세요 (쉼표 · 줄바꿈으로 구분)';
    else if (rs.length > 20) p.recipients = '최대 20명';
    else { const bad = rs.find((r) => !EMAIL_RE.test(r)); if (bad) p.recipients = `이메일 형식 확인: ${bad}`; }
  }
  return p;
}

/** API 본문: 생성은 전체, 수정은 바뀐 값만 (빈 주소 · 비밀값은 보내지 않아 기존 값 유지) */
export function draftToBody(d: ChannelDraft, editing = false): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (d.type === 'slack' && d.webhookUrl.trim()) config.webhookUrl = d.webhookUrl.trim();
  if (d.type === 'webhook') {
    if (d.url.trim()) config.url = d.url.trim();
    if (d.secret) config.secret = d.secret;
    else if (editing && d.removeSecret) config.secret = null;
  }
  if (d.type === 'email') { const rs = parseRecipients(d.recipients); if (rs.length) config.recipients = rs; }
  const body: Record<string, unknown> = { name: d.name.trim(), minSeverity: d.minSeverity, events: d.events, enabled: d.enabled };
  if (!editing) return { type: d.type, ...body, config };
  return Object.keys(config).length ? { ...body, config } : body;
}

/* ------------------------------ SLA 정책 · 당번 (상수 · 설정 기준) ------------------------------ */

export interface SlaRow { severity: Severity; label: string; ack: string; action: string; report: string; weekendAck: string; escalation: string }
export function slaRows(sla: typeof SLA = SLA, weekendAckMin = WEEKEND_ACK_MIN): SlaRow[] {
  return (['P1', 'P2', 'P3'] as Severity[]).map((s) => ({
    severity: s,
    label: SEVERITY_LABEL[s],
    ack: sla[s].label.ack,
    action: sla[s].label.action,
    report: sla[s].label.report,
    weekendAck: sla[s].ackMin > weekendAckMin ? `${weekendAckMin}분 (당번)` : sla[s].label.ack,
    escalation: s === 'P1' ? '단계 기한 초과 시 백업 · 총괄 PM · 브랜드 담당자 연락' : '단계 기한 초과 시 백업 · 총괄 PM',
  }));
}

export function localPolicy(today: string): Policy {
  const r = regimeOf(today);
  return { sla: SLA, weekendAckMin: WEEKEND_ACK_MIN, regime: { off: r.off, label: r.label, duty: r.duty }, roster: rotationTable(today, 60), tiers: WEEKEND_TIERS, today };
}

/* ------------------------------ 요약 ------------------------------ */

export interface NotifySummary {
  channels: number;
  enabled: number;
  byType: Record<ChannelType, number>;
  p1Covered: boolean;
  slaCovered: boolean;
  /** 테스트 데이터 이슈(TEST DATA)를 받는 켜진 채널이 있는지 */
  testCovered: boolean;
  failing: Channel[];
  log: { sent: number; failed: number; skipped: number; retrying: number };
}
export function summarize(channels: readonly Channel[], log: readonly LogEntry[]): NotifySummary {
  const on = channels.filter((c) => c.enabled);
  const byType = { slack: 0, email: 0, webhook: 0 } as Record<ChannelType, number>;
  for (const c of channels) byType[c.type] = (byType[c.type] ?? 0) + 1;
  return {
    channels: channels.length,
    enabled: on.length,
    byType,
    p1Covered: on.some((c) => c.events.includes('incident')),
    slaCovered: on.some((c) => c.events.includes('sla')),
    testCovered: on.some((c) => c.events.includes('test')),
    failing: on.filter((c) => c.lastStatus === 'failed'),
    log: {
      sent: log.filter((l) => l.status === 'sent').length,
      failed: log.filter((l) => l.status === 'failed').length,
      skipped: log.filter((l) => l.status === 'skipped').length,
      retrying: log.filter((l) => l.status === 'failed' && l.detail.retrying).length,
    },
  };
}

/* ------------------------------ 데모 예시 (TEST DATA) ------------------------------ */

const BASE_MS = Date.parse(DEMO.generatedAt);
const isoAt = (minAgo: number) => new Date(BASE_MS - minAgo * 60_000).toISOString();

export const DEMO_CHANNELS: Channel[] = [
  {
    id: 'demo-slack', type: 'slack', name: '#수면밀도-운영', minSeverity: 'P2', events: ['incident', 'sla', 'resolved'], enabled: true,
    config: { target: 'Slack · https://hooks.slack.com/••••(76자)', webhookUrl: 'https://hooks.slack.com/••••(76자)' },
    createdAt: isoAt(60 * 24 * 14), updatedAt: isoAt(60 * 24 * 3), lastTestAt: isoAt(60 * 24 * 3), lastSentAt: isoAt(2), lastStatus: 'sent', lastError: null,
  },
  {
    id: 'demo-mail', type: 'email', name: '광고주 · PM 메일', minSeverity: 'P1', events: ['incident', 'sla', 'report'], enabled: true,
    config: { target: '메일 · 2명', recipients: ['ma••••@mildo.kr', 'pm••••@progress.media'] },
    createdAt: isoAt(60 * 24 * 14), updatedAt: isoAt(60 * 24 * 14), lastTestAt: isoAt(60 * 24 * 14), lastSentAt: isoAt(2), lastStatus: 'sent', lastError: null,
  },
  {
    id: 'demo-hook', type: 'webhook', name: '사내 온콜 시스템', minSeverity: 'P1', events: ['incident', 'sla'], enabled: true,
    config: { target: '웹훅 · https://oncall.example.com/••••(18자)', url: 'https://oncall.example.com/••••(18자)', hasSecret: true },
    createdAt: isoAt(60 * 24 * 7), updatedAt: isoAt(60 * 24 * 7), lastTestAt: isoAt(60 * 24 * 7), lastSentAt: isoAt(60 * 5), lastStatus: 'failed', lastError: '웹훅 응답 503 · service unavailable',
  },
];

export const DEMO_INCIDENTS = detectIncidents(DEMO);

/** 데모 발송 이력 — 데모 이슈 감지 결과를 채널 필터에 그대로 적용해 만든다 */
export function demoLog(): LogEntry[] {
  const out: LogEntry[] = [];
  let id = 1000;
  DEMO_INCIDENTS.forEach((inc, k) => {
    const minAgo = 2 + k;
    for (const ch of DEMO_CHANNELS) {
      if (!ch.events.includes('incident')) continue;
      const ok = severityAllowed(ch.minSeverity, inc.severity);
      const failed = ch.id === 'demo-hook' && ok;
      out.push({
        id: id++, at: isoAt(minAgo), channelId: ch.id, channelName: ch.name, channelType: ch.type, event: 'incident', refId: inc.id, severity: inc.severity,
        status: !ok ? 'skipped' : failed ? 'failed' : 'sent', attempts: failed ? 2 : 1,
        detail: {
          subject: `[MILDO OS] ${inc.severity} ${inc.title}`, target: ch.config.target,
          reason: !ok ? `채널 등급 기준 ${ch.minSeverity} 밖 (${inc.severity})` : failed ? '웹훅 응답 503 · service unavailable' : null,
          httpStatus: failed ? 503 : ok && ch.type !== 'email' ? 200 : null, retrying: failed, isTest: true,
        },
      });
    }
  });
  const p1 = DEMO_INCIDENTS.find((i) => i.severity === 'P1');
  if (p1) {
    out.push({
      id: id++, at: isoAt(0), channelId: 'demo-slack', channelName: '#수면밀도-운영', channelType: 'slack', event: 'sla', refId: p1.id, severity: 'P1', status: 'sent', attempts: 1,
      detail: { subject: `[MILDO OS] SLA 초과 · P1 인지 기한 초과 · ${p1.title}`, target: DEMO_CHANNELS[0].config.target, stage: 'ack', httpStatus: 200, isTest: true },
    });
  }
  return out.sort((a, b) => b.id - a.id);
}

/** 데모 감지 실행 기록 — 10분 간격 예약 실행 + 수집 직후 실행 */
export function demoRuns(): ScanRun[] {
  const out: ScanRun[] = [];
  for (let k = 0; k < 12; k++) {
    const minAgo = k * 10;
    out.push({
      id: 500 - k, trigger: k === 3 ? 'ingest' : 'schedule', status: 'ok', found: DEMO_INCIDENTS.length, created: k === 11 ? DEMO_INCIDENTS.length : 0, cleared: 0,
      notified: k === 11 ? 18 : 0, dataToday: DEMO.today, dataHour: DEMO.currentHour, dataMode: 'demo', warning: null, durationMs: 140 + ((k * 37) % 90), startedAt: isoAt(minAgo),
    });
  }
  return out;
}

export const fmtIso = (iso: string | null | undefined) => (iso ? fmtStamp(Date.parse(iso)) : '—');
