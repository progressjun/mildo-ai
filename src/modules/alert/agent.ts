/**
 * MILDO Alert 에이전트 도구 — MILDO Agent가 Claude tool use로 호출한다.
 * 결과는 작은 plain JSON (숫자 반올림). 상태를 바꾸는 도구는 두지 않는다 (이슈 처리는 사람이 화면에서).
 */
import type { ModuleAgentKit, ToolContext } from '../types';
import type { Incident } from '@/core/types';
import {
  activeConfig, checkAccounts, detectIncidents, withAppliedTopups, fmtDateShort, fmtStamp, heldMedia, historyRecords, holidayPrecheck, incidentReport, nextAction,
  offBlocks, onDutyFor, primaryEvidence, regimeOf, rotationTable, sessionRecords, slaReport, slaState, typeOf, type AlertIncident,
} from './engine';
import { DEMO_CREATIVES, TYPE_LABEL } from './data';
import { accountsBrief, holidayBrief, issuesBrief, slaBrief } from './briefs';

const r0 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.round(v));
const r1 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const nowOf = (ctx: ToolContext) => Date.parse(ctx.state.data.generatedAt);
/**
 * ISO → 데이터 기준 시각(ms). Alert가 남긴 처리 시각은 데이터 시계(+09:00)라 그대로 쓰고,
 * 다른 모듈이 실제 시각(…Z)으로 남긴 감지 시각은 데이터 기준 시각으로 본다
 * (도구는 화면 세션 시계에 접근하지 않으므로 SLA 경과를 0부터 계산 — 실제 시각과 섞여 수십 시간이 어긋나는 것을 막는다).
 */
const toMsOf = (ctx: ToolContext) => (iso: string) => (iso.endsWith('Z') ? nowOf(ctx) : Date.parse(iso));

/** 스토어 이슈 + 아직 적재되지 않은 최신 탐지 결과 */
function currentIncidents(ctx: ToolContext): (AlertIncident & { fresh?: boolean })[] {
  const stored = ctx.state.incidents as AlertIncident[];
  const found = detectIncidents(ctx.state.data, { config: activeConfig(ctx.state.changes), creatives: DEMO_CREATIVES });
  const fresh = found.filter((f) => !stored.some((s) => s.id === f.id)).map((f) => ({ ...f, fresh: true }));
  return [...stored, ...fresh];
}

function compactIncident(i: AlertIncident & { fresh?: boolean }, nowMs: number, toMs: (iso: string) => number) {
  const st = slaState(i, nowMs, toMs);
  return {
    id: i.id,
    severity: i.severity,
    type: TYPE_LABEL[typeOf(i)] ?? i.ruleId,
    title: i.title,
    target: i.target,
    media: i.media,
    status: i.status,
    isTest: i.isTest,
    notYetLoaded: i.fresh ?? false,
    evidence: primaryEvidence(i),
    basis: i.basis ? `${i.basis} (제안서 ${i.page})` : undefined,
    causes: (i.causes ?? []).slice(0, 3).map((c) => ({ label: c.label, score: c.score, basis: c.basis })),
    impact: { impressionsLost: r0(i.impact?.impressionsLost), spendAtRisk: r0(i.impact?.spendAtRisk), revenueLossEst: r0(i.impact?.revenueLossEst), note: i.impactNote },
    autoActions: i.autoActions,
    assignee: i.assignee,
    backup: i.backup,
    onDuty: i.onDuty ?? false,
    sla: { stage: st.stageLabel, deadline: st.deadlineMs ? fmtStamp(st.deadlineMs) : null, remainingMin: r0(st.remainingMin ?? undefined), overdue: st.overdue },
    nextAction: nextAction(i.ruleId),
    recurrence30d: i.recurrence?.count ?? 0,
  };
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx) => [
    {
      name: 'alert_scan',
      description: 'MILDO Alert 현재 이슈 목록(등급 · 감지 근거 수치 · 판정 기준 · 원인 후보 순위 · 영향 · SLA 단계 · 담당)과 자동 조정 보류 매체를 반환한다. TEST DATA 기준.',
      inputSchema: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['P1', 'P2', 'P3', 'all'], description: '등급 필터 (기본 all)' },
          includeResolved: { type: 'boolean', description: '해결된 이슈 포함 여부 (기본 false)' },
        },
      },
      execute: (input) => {
        const sev = (input.severity as string) ?? 'all';
        const all = currentIncidents(ctx);
        const list = all.filter((i) => (input.includeResolved ? true : i.status !== 'resolved') && (sev === 'all' || i.severity === sev));
        const regime = regimeOf(ctx.state.data.today, ctx.state.offHoursMode);
        const nowMs = nowOf(ctx);
        return {
          asOf: `${ctx.state.data.today} ${String(ctx.state.data.currentHour).padStart(2, '0')}:30`,
          dataKind: 'TEST DATA (시연용)',
          regime: regime.off ? { mode: '주말 · 공휴일 체계', label: regime.label, onDuty: regime.duty?.role, backup: regime.duty?.backup, escalation: 'P1 → PM' } : { mode: '평일' },
          counts: (() => { const o = all.filter((i) => i.status !== 'resolved'); return { open: o.length, P1: o.filter((i) => i.severity === 'P1').length, P2: o.filter((i) => i.severity === 'P2').length, P3: o.filter((i) => i.severity === 'P3').length, returned: Math.min(20, list.length), matched: list.length }; })(),
          autoAdjustHeld: heldMedia(all, ctx.state.changes),
          incidents: list.slice(0, 20).map((i) => compactIncident(i, nowMs, toMsOf(ctx))),
        };
      },
    },
    {
      name: 'alert_account_check',
      description: '광고 계정별 소유 · 잔액 · 일 평균 소진 · 잔액 소진 예상 일수(runway) · 소진 예상 시각 · 자동충전 · 권한(실명 · 미접속) · 상태 점검 결과를 반환한다 (제안서 p.50).',
      inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: '특정 계정 id (예: acc_gfa). 생략 시 전체' } } },
      execute: (input) => {
        const checks = checkAccounts(withAppliedTopups(ctx.state.data, ctx.state.changes), activeConfig(ctx.state.changes)).filter((c) => !input.accountId || c.account.id === input.accountId);
        return checks.map((c) => ({
          id: c.account.id,
          name: c.account.name,
          owner: c.account.owner,
          payment: c.account.paymentMethod,
          balance: c.prepaid ? r0(c.account.balance) : '후불',
          avgDailySpend: r0(c.account.avgDailySpend),
          runwayDays: c.prepaid ? r1(c.runwayDays) : null,
          exhaustAt: c.exhaustAtMs ? fmtStamp(c.exhaustAtMs) : null,
          autoCharge: c.account.autoCharge,
          status: c.account.status,
          result: c.worst,
          findings: c.findings.filter((f) => f.level !== 'ok').map((f) => `${f.label}: ${f.detail}`),
          permissions: c.account.permissions.map((p) => ({ user: p.user, role: p.role, realName: p.realName, lastLogin: p.lastLogin })),
        }));
      },
    },
    {
      name: 'alert_incident_report',
      description: '이슈 id를 받아 제안서 p.49 이슈 보고서 양식(발생 · 감지 / 원인 / 영향 / 조치 / 재발 방지 + SLA · 타임라인) 마크다운을 반환한다. id를 모르면 alert_scan으로 먼저 조회한다.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '이슈 id (alert_scan 결과의 id)' } }, required: ['id'] },
      execute: (input) => {
        const id = String(input.id ?? '');
        const all = currentIncidents(ctx);
        const inc = all.find((i) => i.id === id) ?? all.find((i) => i.id.includes(id) || i.title.includes(id));
        if (!inc) return { error: `이슈를 찾지 못했습니다: ${id}`, available: all.slice(0, 10).map((i) => ({ id: i.id, title: i.title })) };
        return { id: inc.id, markdown: incidentReport(inc as Incident, { nowMs: nowOf(ctx), toMs: toMsOf(ctx) }) };
      },
    },
    {
      name: 'alert_holiday_check',
      description: '주말 · 공휴일 대응(p.48): 당번 순번, 지정한 휴무 구간의 연휴 전날 사전 점검(예산 · 소재 · 결제 잔액 · 권한 · 당번) 결과를 현재 데이터로 계산해 반환한다.',
      inputSchema: { type: 'object', properties: { block: { type: 'string', enum: ['current', 'next', 'long'], description: 'current=현재/가장 가까운 휴무, next=그다음, long=다음 3일 이상 연휴 (기본 current)' } } },
      execute: (input) => {
        const data = withAppliedTopups(ctx.state.data, ctx.state.changes);
        const blocks = offBlocks(data.today, 120);
        const which = (input.block as string) ?? 'current';
        const block = which === 'long' ? blocks.find((b) => b.days >= 3 && b.start > data.today) : which === 'next' ? blocks[1] : blocks[0];
        if (!block) return { error: '대상 휴무 구간 없음' };
        const names = Object.fromEntries(Object.entries(ctx.state.tf).filter(([, v]) => v.name?.trim()).map(([k, v]) => [k, v.name]));
        const pc = holidayPrecheck(data, block, { config: activeConfig(ctx.state.changes), tfNames: names });
        return {
          block: { start: block.start, end: block.end, days: block.days, labels: block.labels, checkDay: block.prevBusinessDay, nextBusinessDay: block.nextBusinessDay },
          coverHours: r1(pc.coverHours),
          summary: { fail: pc.items.filter((i) => i.level === 'fail').length, warn: pc.items.filter((i) => i.level === 'warn').length, pass: pc.items.filter((i) => i.level === 'pass').length },
          items: pc.items.map((i) => ({ group: i.group, item: i.item, level: i.level, detail: i.detail, action: i.action })),
          rotation: rotationTable(data.today, 30).map((d) => ({ date: d.date, label: d.label, onDuty: d.role, backup: d.backup })),
          today: onDutyFor(data.today) ? { onDuty: onDutyFor(data.today)!.role, briefing: `${fmtDateShort(blocks[0]?.nextBusinessDay ?? data.today)} 09:30` } : null,
          note: '현재 데이터 기준 시뮬레이션 · 실제 점검은 연휴 전날 17:00 데이터로 재실행',
        };
      },
    },
    {
      name: 'alert_sla_report',
      description: '월간 SLA 리포트(p.49): 등급별 인지 · 1차 조치 · 결과 보고 달성률, 오탐률, 재발 건수, 매체 지연(별도 표기)을 지난 이력(DEMO)과 이번 세션 처리 이력으로 계산한다.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const rec = [...historyRecords(), ...sessionRecords(ctx.state.incidents, toMsOf(ctx))];
        const rep = slaReport(rec);
        const row = (x: (typeof rep.rows)[number]) => ({ severity: x.severity, total: x.total, ackPct: r1(x.ack.pct), actionPct: r1(x.action.pct), reportPct: r1(x.report.pct), falsePositive: x.falsePositive.n, recurrence: x.recurrence, mediaDelay: x.mediaDelay });
        return { month: '2026-10', dataKind: '지난 이력 DEMO + 이번 세션', rows: rep.rows.map(row), total: { ...row(rep.total), severity: 'ALL' }, byMedia: rep.byMedia };
      },
    },
  ],
  briefs: [
    { id: 'alert_accounts', match: /(계정|결제|잔액|충전|권한|비실명|runway)/i, build: (ctx) => accountsBrief(withAppliedTopups(ctx.state.data, ctx.state.changes), activeConfig(ctx.state.changes)) },
    { id: 'alert_holiday', match: /(주말|공휴일|연휴|당번|사전\s?점검|휴일)/, build: (ctx) => holidayBrief(withAppliedTopups(ctx.state.data, ctx.state.changes), activeConfig(ctx.state.changes), Object.fromEntries(Object.entries(ctx.state.tf).map(([k, v]) => [k, v.name]))) },
    { id: 'alert_sla', match: /(SLA|달성률|오탐|재발|월간\s?리포트)/i, build: (ctx) => slaBrief(ctx.state.incidents, toMsOf(ctx)) },
    { id: 'alert_issues', match: /(이슈|알림|장애|급변|탐지|이상|P1|P2|전환\s?(0|추적)|alert)/i, build: (ctx) => issuesBrief(ctx.state.data, currentIncidents(ctx), nowOf(ctx), toMsOf(ctx), ctx.state.offHoursMode, ctx.state.changes) },
  ],
};
