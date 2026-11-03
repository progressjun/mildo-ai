/**
 * 알림 메시지 (순수 함수 · React 없음 — 서버 alerts 도메인과 알림 설정 화면 미리보기가 같이 쓴다) — Slack Block Kit · 이메일(텍스트) · 일반 웹훅 JSON. 같은 내용(등급 · 제목 · 기준 · 관측 · 변화 · 원인 후보 상위 2 · 영향 추정 · SLA 기한 · 링크)을
 * 채널 형식에 맞춰 만든다. 모든 금액 영향은 '추정'으로 표기한다.
 *
 * Block Kit 참조: https://docs.slack.dev/reference/block-kit/blocks (header 텍스트 150자, section text 3000자, fields 10개 · 각 2000자)
 * Incoming Webhook은 `text`가 필수(알림 미리보기 · 접근성 대체 텍스트), `blocks`는 선택.
 */
import type { Severity } from '@/core/types';
import { SEVERITY_LABEL } from '@/data/constants';
import { fmt } from '@/core/util';
import { evidenceText, fmtStamp, fmtValue, nextAction, primaryEvidence, slaTargets, STATUS_LABEL, type Evidence } from '@/modules/alert/engine';
import type { AlertIncident } from '@/modules/alert/engine';

/** SLA 에스컬레이션 단계 */
export type EscStage = 'ack' | 'action' | 'report';

/** 알림 대상 이슈: MILDO Alert 이슈 + 서버 감지 필드(선택) */
export type NotifyIncident = AlertIncident & {
  stillDetected?: boolean;
  escalations?: Partial<Record<EscStage, { at: string; deadline: string; notified: number }>>;
};

export type MessageEvent = 'incident' | 'sla' | 'resolved' | 'report' | 'channel_test';

export interface WorkspaceInfo { id: string; slug: string; name: string; brand_name?: string }

export interface MessageInput {
  event: MessageEvent;
  workspace: WorkspaceInfo;
  appUrl: string;
  incident?: NotifyIncident;
  stage?: EscStage;
  /** report · channel_test 등 이슈가 아닌 알림 */
  generic?: { title: string; text: string; link?: string; severity?: Severity };
  /** 발송 시각 (ms) — 웹훅 sentAt */
  sentAtMs?: number;
}

export interface Message {
  /** 메일 제목 · Slack 대체 텍스트 */
  subject: string;
  /** 메일 본문 (텍스트) */
  text: string;
  slack: { text: string; blocks: unknown[] };
  webhook: Record<string, unknown>;
}

const STAGE_LABEL: Record<EscStage, string> = { ack: '인지', action: '1차 조치', report: '결과 보고' };
export const stageLabel = (s: EscStage) => STAGE_LABEL[s];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Slack mrkdwn 제어 문자 이스케이프 (&, <, >) */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 대표 근거 (위험 → 주의 → 첫 근거) */
function mainEvidence(i: NotifyIncident): Evidence | undefined {
  return i.evidence?.find((e) => e.level === 'danger') ?? i.evidence?.find((e) => e.level === 'warn') ?? i.evidence?.[0];
}

/** 기준 · 관측 · 변화 세 값 — 기준값이 있는 위험 · 주의 근거를 먼저 쓴다 (판정 기준은 대표 근거의 기준값) */
export function basisTriplet(i: NotifyIncident): { label: string; baseline: string; observed: string; delta: string; threshold?: string } {
  const main = mainEvidence(i);
  const withBase = (lv: string) => i.evidence?.find((e) => e.level === lv && e.baseline !== undefined && e.unit !== 'text');
  const ev = withBase('danger') ?? withBase('warn') ?? main;
  const threshold = ev?.threshold ?? (main?.threshold ? (ev && ev !== main ? `${main.label} ${main.threshold}` : main.threshold) : undefined);
  if (ev && ev.unit !== 'text') {
    return {
      label: ev.label,
      baseline: ev.baseline !== undefined ? `${fmtValue(ev.unit, ev.baseline)}${ev.baseLabel ? ` (${ev.baseLabel})` : ''}` : '—',
      observed: fmtValue(ev.unit, ev.observed),
      delta: ev.deltaPct !== undefined && Number.isFinite(ev.deltaPct) ? fmt.delta(ev.deltaPct) : '—',
      threshold,
    };
  }
  const num = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : fmt.int(v));
  return {
    label: i.metric ?? ev?.label ?? '지표',
    baseline: num(i.baseline),
    observed: ev?.unit === 'text' ? ev.note ?? '—' : num(i.observed),
    delta: i.deltaPct !== undefined && Number.isFinite(i.deltaPct) ? fmt.delta(i.deltaPct) : '—',
    threshold,
  };
}

/** 원인 후보 상위 2 (점수순 · 근거 포함) */
export function topCauses(i: NotifyIncident, n = 2): string[] {
  if (i.causes?.length) {
    return [...i.causes].sort((a, b) => b.score - a.score).slice(0, n).map((c) => `${c.label} (점수 ${Math.round(c.score)}) — ${c.basis}`);
  }
  return (i.causeCandidates ?? []).slice(0, n);
}

/** 영향 추정 (모두 추정치) — 0 · 미산출 값은 빼고, 수치가 없으면 엔진의 영향 설명을 쓴다 */
export function impactLines(i: NotifyIncident): string[] {
  const out: string[] = [];
  const im = i.impact ?? {};
  const pos = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
  if (pos(im.spendAtRisk)) out.push(`광고비 영향 추정 ${fmt.won(im.spendAtRisk)}`);
  if (pos(im.revenueLossEst)) out.push(`매출 영향 추정 ${fmt.won(im.revenueLossEst)}`);
  if (pos(im.impressionsLost)) out.push(`노출 손실 추정 ${fmt.int(im.impressionsLost)}회`);
  if (out.length) return out;
  if (i.impactNote) return [clip(`수치 추정 없음 · ${i.impactNote}`, 400)];
  return ['수치 추정 없음 (영향 산출 근거 부족)'];
}

/** SLA 단계별 기한 (감지 시각 기준, 주말 · 공휴일 당번이면 인지 30분) */
export function slaDeadlines(i: NotifyIncident): { stage: EscStage; label: string; deadlineMs: number; target: string }[] {
  const det = Date.parse(i.detectedAt);
  if (!Number.isFinite(det)) return [];
  const t = slaTargets(i.severity, det, !!i.onDuty);
  const rows: { stage: EscStage; label: string; deadlineMs: number; target: string }[] = [
    { stage: 'ack', label: '인지', deadlineMs: det + t.ackMin * 60_000, target: t.ack },
  ];
  if (t.actionMin !== null) rows.push({ stage: 'action', label: '1차 조치', deadlineMs: det + t.actionMin * 60_000, target: t.action });
  if (t.reportMin !== null) rows.push({ stage: 'report', label: '결과 보고', deadlineMs: det + t.reportMin * 60_000, target: t.report });
  return rows;
}

function headline(m: MessageInput): string {
  const i = m.incident;
  if (!i) return m.generic?.title ?? 'MILDO OS 알림';
  const sev = i.severity;
  if (m.event === 'sla' && m.stage) return `[SLA 초과 · ${sev}] ${STAGE_LABEL[m.stage]} 기한 초과 · ${i.title}`;
  if (m.event === 'resolved') return `[해결 · ${sev}] ${i.title}`;
  return `[${sev}] ${i.title}`;
}

export function buildMessage(m: MessageInput): Message {
  const link = `${m.appUrl}/#alert`;
  const brand = m.workspace.brand_name || m.workspace.name;
  const i = m.incident;
  const head = headline(m);
  const subject = clip(`[MILDO OS] ${head.replace(/^\[([^\]]+)\] /, '$1 ')}`, 200);

  if (!i) {
    const g = m.generic ?? { title: 'MILDO OS 알림', text: '' };
    const glink = g.link ?? m.appUrl;
    const text = [`${g.title}`, '', g.text, '', `열기: ${glink}`, '', `워크스페이스 ${brand} · MILDO OS Cloud 자동 발송`].join('\n');
    return {
      subject: clip(`[MILDO OS] ${g.title}`, 200),
      text,
      slack: {
        text: clip(`[MILDO OS] ${g.title}`, 300),
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: clip(g.title, 150) } },
          ...(g.text ? [{ type: 'section', text: { type: 'mrkdwn', text: clip(esc(g.text), 3000) } }] : []),
          { type: 'context', elements: [{ type: 'mrkdwn', text: clip(esc(`${brand} · MILDO OS Cloud 자동 발송`), 3000) }] },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'MILDO OS 열기' }, url: glink }] },
        ],
      },
      webhook: { event: m.event, workspace: { id: m.workspace.id, slug: m.workspace.slug, name: m.workspace.name }, message: { title: g.title, text: g.text, link: glink, severity: g.severity ?? null }, sentAt: new Date(m.sentAtMs ?? Date.now()).toISOString() },
    };
  }

  const b = basisTriplet(i);
  const causes = topCauses(i);
  const impacts = impactLines(i);
  const deadlines = slaDeadlines(i);
  const slaText = deadlines.map((d) => `${d.label} ${fmtStamp(d.deadlineMs)} (${d.target})`).join(' · ') || '—';
  const evidenceLines = (i.evidence ?? []).filter((e) => e.level === 'danger' || e.level === 'warn').slice(0, 3).map(evidenceText);
  const primary = primaryEvidence(i);
  const who = `담당 ${i.assignee ?? '미배정'}${i.backup ? ` · 백업 ${i.backup}` : ''}${i.onDuty ? ' · 주말 · 공휴일 당번 체계' : ''}`;
  const escLine = m.event === 'sla' && m.stage
    ? `에스컬레이션: ${STAGE_LABEL[m.stage]} 기한(${fmtStamp(deadlines.find((d) => d.stage === m.stage)?.deadlineMs ?? NaN)})이 지났습니다. 백업 ${i.backup ?? '담당'} · PM 확인 요청${i.severity === 'P1' ? ' · P1은 브랜드 담당자 연락' : ''}`
    : null;
  const resolvedLine = m.event === 'resolved'
    ? `조치: ${i.actionNote || '기록 없음'}${i.preventNote ? ` · 재발 방지: ${i.preventNote}` : ''}${i.falsePositive ? ' · 오탐 종료' : ''}`
    : null;
  const testLine = i.isTest ? 'TEST DATA · 테스트 데이터로 만든 이슈입니다 (실제 성과 아님)' : null;
  const notDetected = i.stillDetected === false ? '최근 감지에서는 더 이상 잡히지 않음 · 운영자 확인 후 해결 처리 필요' : null;

  const text = [
    head,
    '',
    ...(testLine ? [testLine, ''] : []),
    ...(escLine ? [escLine, ''] : []),
    ...(resolvedLine ? [resolvedLine, ''] : []),
    `등급: ${SEVERITY_LABEL[i.severity]} · 상태: ${STATUS_LABEL[i.status] ?? i.status}`,
    `대상: ${i.target ?? i.media ?? '—'}`,
    `${b.label} — 기준 ${b.baseline} · 관측 ${b.observed} · 변화 ${b.delta}${b.threshold ? ` · 판정 기준 ${b.threshold}` : ''}`,
    ...(evidenceLines.length ? ['', '감지 근거', ...evidenceLines.map((l) => `- ${l}`)] : []),
    '',
    '원인 후보 상위 2',
    ...(causes.length ? causes.map((c) => `- ${c}`) : ['- 원인 후보 산출 전']),
    '',
    `영향 (추정): ${impacts.join(' · ')}`,
    `SLA 기한: ${slaText}`,
    `다음 조치: ${nextAction(i.ruleId)}`,
    who,
    ...(notDetected ? [notDetected] : []),
    '',
    `이슈 열기: ${link}`,
    `감지 경로: ${i.detectPath} · 감지 ${fmtStamp(Date.parse(i.detectedAt))}`,
    `워크스페이스 ${brand} · MILDO OS Cloud 자동 발송 · 이슈 id ${i.id}`,
  ].join('\n');

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(head, 150) } },
  ];
  const notes = [testLine, escLine, resolvedLine, notDetected].filter((x): x is string => !!x);
  if (notes.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(notes.map((n) => `*${esc(n)}*`).join('\n'), 3000) } });
  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*등급*\n${esc(SEVERITY_LABEL[i.severity])}` },
      { type: 'mrkdwn', text: `*상태*\n${esc(STATUS_LABEL[i.status] ?? i.status)}` },
      { type: 'mrkdwn', text: `*기준*\n${clip(esc(`${b.label} ${b.baseline}`), 2000)}` },
      { type: 'mrkdwn', text: `*관측 · 변화*\n${clip(esc(`${b.observed} · ${b.delta}`), 2000)}` },
      { type: 'mrkdwn', text: `*대상*\n${clip(esc(i.target ?? i.media ?? '—'), 2000)}` },
      { type: 'mrkdwn', text: `*판정 기준*\n${clip(esc(b.threshold ?? '규칙 기준 (아래 근거)'), 2000)}` },
    ],
  });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*감지 근거*\n${esc(evidenceLines.length ? evidenceLines.join('\n') : primary)}`, 3000) } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*원인 후보 상위 2*\n${causes.length ? causes.map((c) => `• ${esc(c)}`).join('\n') : '• 원인 후보 산출 전'}`, 3000) } });
  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*영향 (추정)*\n${clip(esc(impacts.join('\n')), 2000)}` },
      { type: 'mrkdwn', text: `*SLA 기한*\n${clip(esc(deadlines.map((d) => `${d.label} ${fmtStamp(d.deadlineMs)}`).join('\n') || '—'), 2000)}` },
    ],
  });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*다음 조치*\n${esc(nextAction(i.ruleId))}`, 3000) } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(esc(`${who} · ${brand} · 감지 ${fmtStamp(Date.parse(i.detectedAt))} · ${i.detectPath}`), 3000) }] });
  blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '이슈 열기' }, url: link, ...(i.severity === 'P1' && m.event !== 'resolved' ? { style: 'danger' } : {}) }] });

  const webhookIncident = {
    id: i.id, ruleId: i.ruleId, severity: i.severity, status: i.status, title: i.title, media: i.media ?? null, target: i.target ?? null,
    detectedAt: i.detectedAt, occurredAt: i.occurredAt, metric: i.metric ?? null, observed: i.observed ?? null, baseline: i.baseline ?? null, deltaPct: i.deltaPct ?? null,
    basis: b, evidence: primary, causes, impact: { ...(i.impact ?? {}), estimate: true }, assignee: i.assignee ?? null, backup: i.backup ?? null, onDuty: !!i.onDuty,
    sla: deadlines.map((d) => ({ stage: d.stage, deadline: new Date(d.deadlineMs).toISOString(), target: d.target })),
    escalation: m.event === 'sla' ? m.stage ?? null : null,
    stillDetected: i.stillDetected ?? null, isTest: !!i.isTest, actionNote: i.actionNote ?? null, preventNote: i.preventNote ?? null, url: link,
  };

  return {
    subject,
    text,
    slack: { text: clip(`${head} · ${primary}`, 300), blocks },
    webhook: { event: m.event, workspace: { id: m.workspace.id, slug: m.workspace.slug, name: m.workspace.name }, incident: webhookIncident, sentAt: new Date(m.sentAtMs ?? Date.now()).toISOString() },
  };
}
