/**
 * 알림 설정 에이전트 도구 · 오프라인 브리프 — MILDO Agent가 tool use로 호출한다.
 * 서버 모드에서는 알림 설정 화면이 마지막으로 읽은 서버 값(가린 값)을, 데모 모드에서는 예시(TEST DATA)를 쓴다.
 * 상태를 바꾸는 도구는 두지 않는다 (채널 추가 · 삭제 · 테스트 발송은 사람이 화면에서, 권한 확인 후).
 */
import type { Brief } from '@/ai/prompts';
import type { ModuleAgentKit, ToolContext } from '../types';
import { regimeOf, type AlertIncident } from '@/modules/alert/engine';
import { buildMessage } from './message';
import { getNotifySnapshot } from './live';
import {
  DEMO_CHANNELS, demoLog, demoRuns, EVENT_LABEL, fmtIso, severityScopeLabel, slaRows, STATUS_TEXT, summarize, TYPE_LABEL, TRIGGER_LABEL,
  type Channel, type LogEntry, type ScanRun,
} from './model';

interface Source { demo: boolean; channels: Channel[]; log: LogEntry[]; runs: ScanRun[]; asOf: string }

function sourceOf(): Source {
  const s = getNotifySnapshot();
  if (s?.channels) return { demo: false, channels: s.channels, log: s.log ?? [], runs: s.runs ?? [], asOf: new Date(s.at).toISOString() };
  return { demo: true, channels: DEMO_CHANNELS, log: demoLog(), runs: demoRuns(), asOf: '데모 기준 시각' };
}

const todayOf = (ctx: ToolContext, demo: boolean) => (demo ? ctx.state.data.today : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10));

function coverage(channels: readonly Channel[]) {
  const on = channels.filter((c) => c.enabled);
  return {
    incident: on.filter((c) => c.events.includes('incident')).length,
    sla: on.filter((c) => c.events.includes('sla')).length,
    p1: on.filter((c) => c.events.includes('incident')).length,
    p2: on.filter((c) => c.events.includes('incident') && c.minSeverity !== 'P1').length,
    p3: on.filter((c) => c.events.includes('incident') && c.minSeverity === 'P3').length,
    distinctTypesForP1: new Set(on.filter((c) => c.events.includes('incident')).map((c) => c.type)).size,
  };
}

export function notifyBrief(ctx: ToolContext): Brief {
  const src = sourceOf();
  const sum = summarize(src.channels, src.log);
  const cov = coverage(src.channels);
  const regime = regimeOf(todayOf(ctx, src.demo));
  const kind = src.demo ? 'TEST DATA 예시' : '서버 저장 값';
  const facts = [
    `알림 채널 ${sum.enabled}/${sum.channels}개 켜짐 (Slack ${sum.byType.slack} · 메일 ${sum.byType.email} · 웹훅 ${sum.byType.webhook}) · 출처 ${kind}.`,
    ...src.channels.slice(0, 6).map((c) => `${c.name} (${TYPE_LABEL[c.type]}) · ${severityScopeLabel(c.minSeverity)} · 이벤트 ${c.events.map((e) => EVENT_LABEL[e] ?? e).join(', ')} · ${c.enabled ? '켜짐' : '꺼짐'} · 마지막 결과 ${c.lastStatus ? STATUS_TEXT[c.lastStatus as LogEntry['status']] ?? c.lastStatus : '발송 전'}${c.lastError ? ` (${c.lastError})` : ''}.`),
    `발송 이력 ${src.log.length}건 중 발송 ${sum.log.sent} · 실패 ${sum.log.failed} (재시도 대기 ${sum.log.retrying}) · 보내지 않음 ${sum.log.skipped}.`,
    `SLA 목표: ${slaRows().map((r) => `${r.severity} 인지 ${r.ack} · 1차 조치 ${r.action} · 결과 보고 ${r.report}`).join(', ')}, 주말 · 공휴일 인지 ${slaRows()[1].weekendAck} (제안서 p.48–49).`,
    regime.off ? `오늘은 ${regime.label} · 당번 ${regime.duty?.role ?? '—'} · 백업 ${regime.duty?.backup ?? '—'} (P1은 총괄 PM 에스컬레이션).` : '오늘은 평일 운영 체계 · 매체 담당 배정.',
  ];
  const patterns: string[] = [];
  const failReasons = new Map<string, number>();
  for (const l of src.log) if (l.status === 'failed') failReasons.set(`${l.channelName} · ${l.detail.reason ?? '사유 미상'}`, (failReasons.get(`${l.channelName} · ${l.detail.reason ?? '사유 미상'}`) ?? 0) + 1);
  for (const [k, n] of [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) patterns.push(`같은 실패가 ${n}회 반복: ${k}.`);
  const sevSkipped = src.log.filter((l) => l.status === 'skipped' && (l.detail.reason ?? '').includes('등급 기준')).length;
  if (sevSkipped) patterns.push(`등급 기준 밖이라 보내지 않은 건 ${sevSkipped}건 (예: P2 이슈를 P1 전용 채널이 건너뜀) — 의도한 필터인지 확인.`);
  const lastRun = src.runs[0];
  if (lastRun) patterns.push(`최근 감지 실행 ${src.runs.length}회 기록, 마지막 ${fmtIso(lastRun.startedAt)} (${TRIGGER_LABEL[lastRun.trigger] ?? lastRun.trigger} · 감지 ${lastRun.found}건 · 신규 ${lastRun.created}건).`);
  const interpretation = [
    cov.incident === 0
      ? '새 이슈를 받는 켜진 채널이 0개라 서버가 감지해도 사람이 알 수 없다. 이 상태에서는 인지 SLA를 지킬 수단이 없다.'
      : `P1을 받는 켜진 채널 ${cov.p1}개, 채널 종류 ${cov.distinctTypesForP1}가지. ${cov.distinctTypesForP1 < 2 ? '한 종류에만 의존하면 그 서비스 장애 시 P1 인지 15분을 지키기 어렵다고 본다.' : '서로 다른 종류로 이중화되어 한쪽 장애에도 인지 경로가 남는다고 본다.'}`,
    cov.sla === 0 ? 'SLA 기한 초과를 받는 채널이 없어 에스컬레이션이 타임라인에만 남는다. 백업 · PM이 보는 채널에 SLA 이벤트를 켜는 편이 낫다.' : `SLA 기한 초과를 받는 채널 ${cov.sla}개 — 단계마다 한 번만 보내므로 알림 피로는 제한적이다.`,
  ];
  const actions: string[] = [];
  if (cov.incident === 0) actions.push("알림 설정에서 Slack 또는 웹훅 채널을 추가하고 '새 이슈' · 'SLA 기한 초과'를 켠 뒤 테스트 발송.");
  if (sum.failing.length) actions.push(`실패 채널(${sum.failing.map((c) => c.name).join(', ')}) 주소 · 권한 확인 후 테스트 발송 — 4xx는 자동 재시도하지 않는다.`);
  if (cov.distinctTypesForP1 === 1) actions.push('P1용으로 다른 종류 채널(예: Slack + 웹훅 온콜)을 하나 더 두어 이중화.');
  if (!actions.length) actions.push('월 1회 채널별 테스트 발송으로 웹훅 만료 · 수신자 변경을 확인.');
  return {
    title: '알림 채널 · 발송 상태',
    facts,
    patterns,
    interpretation,
    conditions: [
      '발송 성공은 수신 서버가 2xx(Slack은 200 ok)로 받았다는 뜻이며 사람이 읽었다는 뜻은 아니다 — 인지 SLA는 이슈 화면의 인지 기록 시각(서버 시계)으로 잰다.',
      '메일은 서버 SMTP 설정이 있어야 발송된다. 없으면 이력에 사유와 함께 보내지 않음으로 남는다.',
      src.demo ? '지금 수치는 데모 예시(TEST DATA)이며 서버 연결 시 실제 값으로 바뀐다.' : '서버 값은 알림 설정 화면을 마지막으로 연 시점 기준이다.',
    ],
    counter: [
      '채널을 늘릴수록 같은 알림이 여러 곳에 중복되어 알림 피로가 생길 수 있다. P3는 메일 · 주간 리포트로 모으는 편이 낫다 (p.44).',
      '테스트 데이터 이슈는 기본적으로 보내지 않는다. 라이브 데모 채널만 테스트 데이터 이슈 이벤트를 켠다.',
    ],
    actions,
  };
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx) => [
    {
      name: 'notify_channels_status',
      description: '알림 설정: 채널 목록(종류 · 가린 대상 · 받는 등급 · 이벤트 · 켜짐 · 마지막 결과), 등급별 수신 채널 수, 최근 발송 결과(성공 · 실패 · 보내지 않음 · 실패 사유), SLA 정책, 오늘 당번, 마지막 감지 실행을 반환한다. 비밀값은 포함하지 않는다.',
      inputSchema: { type: 'object', properties: { includeLog: { type: 'boolean', description: '최근 실패 · 보내지 않음 이력 5건 포함 (기본 true)' } } },
      execute: (input) => {
        const src = sourceOf();
        const sum = summarize(src.channels, src.log);
        const regime = regimeOf(todayOf(ctx, src.demo));
        const lastRun = src.runs[0];
        return {
          source: src.demo ? 'demo' : 'server',
          dataKind: src.demo ? 'TEST DATA (예시 · 실제 발송 아님)' : '서버 저장 값 (주소 · 비밀값은 가린 값)',
          asOf: src.asOf,
          channels: src.channels.map((c) => ({ name: c.name, type: c.type, target: c.config.target, minSeverity: c.minSeverity, events: c.events, enabled: c.enabled, lastStatus: c.lastStatus, lastError: c.lastError, lastSentAt: c.lastSentAt })),
          coverage: coverage(src.channels),
          delivery: {
            ...sum.log,
            recentProblems: input.includeLog === false ? undefined : src.log.filter((l) => l.status !== 'sent').slice(0, 5).map((l) => ({ at: l.at, channel: l.channelName, event: l.event, status: l.status, reason: l.detail.reason ?? null })),
          },
          slaPolicy: slaRows().map((r) => ({ severity: r.severity, ack: r.ack, action: r.action, report: r.report, weekendAck: r.weekendAck })),
          onDuty: regime.off ? { mode: '주말 · 공휴일 체계', label: regime.label, onDuty: regime.duty?.role, backup: regime.duty?.backup } : { mode: '평일 · 매체 담당' },
          lastScan: lastRun ? { at: lastRun.startedAt, trigger: lastRun.trigger, status: lastRun.status, found: lastRun.found, created: lastRun.created, warning: lastRun.warning } : null,
        };
      },
    },
    {
      name: 'notify_message_preview',
      description: '이슈 하나가 알림 채널로 갈 때의 실제 메시지 형식(메일 제목 · 본문, Slack 대체 텍스트)을 만든다 — 등급 · 기준 · 관측 · 변화 · 원인 후보 상위 2 · 영향 추정 · SLA 기한 · 링크. incidentId가 없으면 열린 P1 → 첫 열린 이슈.',
      inputSchema: { type: 'object', properties: { incidentId: { type: 'string', description: '이슈 id (선택)' } } },
      execute: (input) => {
        const list = (ctx.state.incidents as AlertIncident[]).filter((i) => i.status !== 'resolved');
        const inc = (input.incidentId ? (ctx.state.incidents as AlertIncident[]).find((i) => i.id === input.incidentId) : undefined) ?? list.find((i) => i.severity === 'P1') ?? list[0];
        if (!inc) return { error: '열린 이슈가 없습니다' };
        const m = buildMessage({ event: 'incident', appUrl: '<MILDO OS 주소>', workspace: { id: 'ws', slug: 'ws', name: '워크스페이스', brand_name: '수면밀도' }, incident: inc, sentAtMs: 0 });
        return { incidentId: inc.id, subject: m.subject, slackText: m.slack.text, body: m.text.slice(0, 4000), isTest: !!inc.isTest };
      },
    },
  ],
  briefs: [
    { id: 'notify_status', match: /(알림\s?(채널|설정|발송)|채널|슬랙|slack|웹훅|webhook|이메일\s?알림|발송\s?(이력|실패)|에스컬레이션|SMTP)/i, build: (ctx) => notifyBrief(ctx) },
  ],
};
