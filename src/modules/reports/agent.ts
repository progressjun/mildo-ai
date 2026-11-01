/**
 * Reports — MILDO Agent 도구 + 오프라인 브리프 (제안서 p.17–20).
 * 도구는 읽기 전용이다 (리포트 본문 · 시간표 · 절감 계산). 결과는 작은 plain JSON.
 */
import type { AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import type { ModuleAgentKit, ToolContext } from '../types';
import { fmt, fmtDate } from '@/core/util';
import {
  aboutHours, aeTarget, automationRollout, availableMonths, buildTimetable, cadenceStatus, commentTarget, computeSavings, dataNowMinutes, generateReport, nextSends, reinvestPlan,
  reportToMarkdown, scopeOf, type IssueLike, type Report,
} from './engine';
import type { ReportType } from './data';
import { KICKOFF_ASSUMED, REINVEST_DEFAULT, REPORT_META, REPORT_TYPES, SAVINGS_CONFIRM_DAYS, SAVINGS_FLOOR_PCT } from './data';

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : null);

function incidentsOf(ctx: ToolContext): IssueLike[] {
  return ctx.state.incidents as IssueLike[];
}
/** AE 코멘트 (target = reports:<scope>:ae — 월간은 대상 월, 이슈 알림은 이슈별) */
function aeNotesOf(ctx: ToolContext, r: Report) {
  return ctx.state.comments.filter((c) => c.target === aeTarget(scopeOf(r))).map((c) => ({ author: c.author, text: c.text, at: c.at.slice(0, 16).replace('T', ' ') }));
}
/** 섹션 단위 피드백 (state.comments, target = reports:<scope>:<sectionId>) */
function feedbackOf(ctx: ToolContext, r: Report) {
  return r.sections.flatMap((sec) => ctx.state.comments
    .filter((c) => c.target === commentTarget(scopeOf(r), sec.id))
    .map((c) => ({ sectionId: sec.id, sectionTitle: sec.title, author: c.author === '수면밀도' ? '수면밀도 담당자' : c.author, text: c.text, resolved: !!c.resolved })));
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'reports_generate',
      description: '리포트 4종(일간 · 주간 · 월간 · 이슈 알림, 제안서 p.17) 중 하나를 데이터로 생성해 마크다운 본문(문서형)과 메신저 미리보기를 반환합니다. AE 코멘트가 있으면 하단에 병합됩니다.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'issue'], description: '리포트 종류 (기본 daily)' },
          format: { type: 'string', enum: ['doc', 'messenger', 'both'], description: '출력 형식 (기본 both)' },
          month: { type: 'string', description: '월간 리포트 대상 월 YYYY-MM (선택)' },
          incidentId: { type: 'string', description: '이슈 알림 대상 이슈 id (선택, 기본은 열린 이슈 중 등급 · 감지 시각 기준 최우선)' },
        },
      },
      execute: (inp) => {
        const type = (REPORT_TYPES as string[]).includes(String(inp.type)) ? (String(inp.type) as ReportType) : 'daily';
        const format = String(inp.format ?? 'both');
        const r = generateReport(type, ctx.state.data, { incidents: incidentsOf(ctx), month: inp.month ? String(inp.month) : undefined, selectedIssueId: inp.incidentId ? String(inp.incidentId) : null });
        const fb = feedbackOf(ctx, r);
        const md = reportToMarkdown(r, { aeNotes: aeNotesOf(ctx, r), feedback: fb.map((f) => ({ sectionTitle: f.sectionTitle, author: f.author, text: f.text, resolved: f.resolved })) });
        return {
          종류: REPORT_META[type].name, 제목: r.title, 기간: r.periodLabel, 발송: `${REPORT_META[type].when} · ${REPORT_META[type].channel}`, 다음발송: r.nextSend,
          생성기준: r.generatedAt, 잠정: !!r.provisional, 출처: 'TEST DATA · 제안서 p.17',
          섹션: r.sections.map((s) => ({ id: s.id, 제목: s.title, 영역: s.zone })),
          피드백: { 전체: fb.length, 반영대기: fb.filter((f) => !f.resolved && f.author === '수면밀도 담당자').length },
          ...(format !== 'messenger' ? { 문서: md.length > 20000 ? `${md.slice(0, 20000)}\n…(생략)` : md } : {}),
          ...(format !== 'doc' ? { 메신저: r.messenger } : {}),
          ...(type === 'monthly' ? { 선택가능월: availableMonths(ctx.state.data) } : {}),
        };
      },
    },
    {
      name: 'reports_timetable',
      description: '데이터 제공 시간표(제안서 p.18, 07:00→17:00)를 기준일 기준 완료 · 진행 중 · 예정 상태, 리드타임, 채널, 주말 · 공휴일 이동 규칙, 항목별 산출물 요약과 함께 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: { date: { type: 'string', description: '기준일 YYYY-MM-DD (기본: 데이터 기준일)' } },
      },
      execute: (inp) => {
        const t = buildTimetable(ctx.state.data, { date: inp.date ? String(inp.date) : undefined, offHours: ctx.state.offHoursMode, incidents: ctx.state.incidents, changes: ctx.state.changes });
        return {
          기준일: t.date, 휴무: t.off ? t.offLabel : '평일', 현재시각: t.nowMinutes !== null ? `${String(Math.floor(t.nowMinutes / 60)).padStart(2, '0')}:${String(t.nowMinutes % 60).padStart(2, '0')}` : null,
          업무시간: '수면밀도 08–17 (p.18)', 다음영업일: t.nextBusinessDay, 완료: t.done, 남음: t.upcoming,
          항목: t.items.map((i) => ({ 시각: i.time, 항목: i.title, 채널: i.channel, 범위: i.scope, 리드타임: i.lead, 상태: i.statusLabel, 주말규칙: i.offNote ?? null, 실제시각: `${i.effectiveDate} ${i.effectiveTime}`, 산출물: i.output })),
          리포트발송: t.sends.map((s) => ({ 종류: s.name, 주기: s.when, 채널: s.channel, 리드타임: s.lead, 다음: s.next })),
        };
      },
    },
    {
      name: 'reports_savings',
      description: 'SA 업무 자동화 절감(제안서 p.19)을 계산합니다. 업무별 기존 · 자동화 후(분/주), 합계 절감률, 하한 40% 판정, 연간 절감 시간, 재투입 계획을 반환합니다. before로 업무별 기존 분을 바꿔 재계산할 수 있습니다.',
      inputSchema: {
        type: 'object',
        properties: {
          before: { type: 'object', description: '업무명 → 기존 분/주 (선택). 업무명: 일간 성과 조회·취합, 주간 보고서 작성, 입찰·예산 조정, 신규 키워드 발굴·등록, 소재·URL·상태 점검' },
          mode: { type: 'string', enum: ['ratio', 'fixed'], description: 'ratio = 업무별 절감률 유지(기본), fixed = 자동화 후 목표 분 고정' },
          kickoff: { type: 'string', description: '90일 일정 Kick-off 날짜 YYYY-MM-DD (기본 2026-12-01 가정)' },
        },
      },
      execute: (inp) => {
        const before = inp.before && typeof inp.before === 'object' ? Object.fromEntries(Object.entries(inp.before as Record<string, unknown>).map(([k, v]) => [k, Number(v)])) : undefined;
        const s = computeSavings({ before, mode: inp.mode === 'fixed' ? 'fixed' : 'ratio' });
        const ro = automationRollout(inp.kickoff ? String(inp.kickoff) : KICKOFF_ASSUMED, ctx.state.data.today, s);
        return {
          출처: '제안서 p.19 (기존은 가정 · 온보딩 30일 내 실측 확정)',
          업무: s.rows.map((r) => ({ 업무: r.task, 방식: r.how, 기존분: r0(r.before), 자동화후분: r1(r.after), 절감률pct: r1(r.reductionPct), 담당모듈: r.moduleLabel })),
          합계: { 기존분: r0(s.before), 자동화후분: r0(s.after), 절감분: r0(s.saved), 절감률pct: r1(s.reductionPct), 기존약시간: aboutHours(s.before), 자동화후약시간: aboutHours(s.after), 연간절감시간: r0(s.annualSavedHours), 인력환산FTE: r1(s.fte) },
          판정: { 결과: s.verdict.label, 근거: s.verdict.basis, 하한pct: SAVINGS_FLOOR_PCT },
          재투입: reinvestPlan(s.saved, REINVEST_DEFAULT.map((x) => ({ id: x.id, label: x.label, share: x.share }))).map((p) => ({ 영역: p.label, 비중pct: r0(p.sharePct), 분주: r0(p.minutesPerWeek), 연간시간: r0(p.hoursPerYear) })),
          일정90일: {
            출처: '제안서 p.20 · p.22 (업무별 적용 단계는 운영 가정)', kickoff: ro.kickoff, 실측확정기한: ro.confirmDate,
            단계: ro.phases.map((p) => ({ 단계: p.label, 기간: `${p.start}~${p.end}`, 상태: p.status, 가동모듈: p.modules.map((m) => m.label), 적용업무: p.tasks.map((t) => t.task), 단계종료주간분: r0(p.weeklyAfter), 측정기준: p.metric })),
          },
        };
      },
    },
  ],
  briefs: [
    {
      id: 'reports_weekly',
      match: /주간\s?(리포트|보고서?|메일)?|키워드 테스트 결과|개선 제안|이번 주/,
      build: (ctx) => generateReport('weekly', ctx.state.data).brief,
    },
    {
      id: 'reports_monthly',
      match: /월간\s?(리포트|보고서?|미팅)?|채널별 매출( 기여)?|다음 달 계획|월 계획/,
      build: (ctx) => generateReport('monthly', ctx.state.data).brief,
    },
    {
      id: 'reports_issue',
      match: /이슈\s?(알림|리포트|보고)|조치 상태|영향 범위/,
      build: (ctx) => generateReport('issue', ctx.state.data, { incidents: incidentsOf(ctx) }).brief,
    },
    {
      id: 'reports_today',
      match: /(일간|오늘|어제|전일)\s?(리포트|보고서?|성과)|일간|리포트|보고서|발송 현황/,
      build: (ctx): Brief => {
        const b = generateReport('daily', ctx.state.data, { incidents: incidentsOf(ctx) }).brief;
        const cad = cadenceStatus(ctx.state.data, ctx.state.incidents);
        return { ...b, facts: [...b.facts, `리포트 발송 현황: ${cad.map((c) => `${c.name} ${c.stateLabel}`).join(' · ')} (제안서 p.17 주기).`] };
      },
    },
    {
      id: 'reports_timetable',
      match: /시간표|몇 시|발송 시각|브리핑|리드타임|업무시간/,
      build: (ctx): Brief => {
        const t = buildTimetable(ctx.state.data, { offHours: ctx.state.offHoursMode, incidents: ctx.state.incidents, changes: ctx.state.changes });
        const moved = t.items.filter((i) => i.offMode === 'moved');
        const ns = nextSends(ctx.state.data);
        return {
          title: `데이터 제공 시간표 · ${fmtDate(t.date)}`,
          facts: [
            `기준일 ${fmtDate(t.date)} · ${t.off ? t.offLabel : '평일'} · 기준 시각 ${hhmm(dataNowMinutes(ctx.state.data))}. 시간표 ${t.items.length}개 항목 중 완료 ${t.done}건, 남은 항목 ${t.upcoming}건.`,
            ...t.items.filter((i) => i.outputLevel === 'warn' || i.outputLevel === 'danger').map((i) => `${i.time} ${i.title}: ${i.output}.`),
            `다음 발송은 일간 ${ns.daily.label}, 주간 ${ns.weekly.label}, 월간 ${ns.monthly.label}입니다.`,
          ],
          patterns: [],
          interpretation: [t.off ? '주말 · 공휴일에는 자동 수집 · 리포트 발송은 그대로 진행되고, 사람이 하는 점검은 MILDO Alert 상시 감지와 당번 AE 확인으로 대체됩니다. 브랜드팀은 다음 영업일 09:30 브리핑에서 주말 이슈를 한 번에 받습니다.' : '평일에는 수면밀도 업무시간(08–17) 안에 데이터 · 리포트 · 조정안이 순서대로 도착합니다.'],
          conditions: ['시각은 제안서 p.18 기준이며, 주말 · 공휴일 브리핑 이동은 p.44 · p.48 규칙입니다. 16:30 조정안의 주말 처리는 운영 가정으로 온보딩 중 확정합니다.'],
          counter: moved.length ? [`이슈 브리핑이 ${moved.map((i) => `${fmtDate(i.effectiveDate)} ${i.effectiveTime}`).join(', ')}로 미뤄지더라도 P1 이슈는 감지 즉시 PM 에스컬레이션으로 전달됩니다(p.48).`] : [],
          actions: ['담당 AE는 14:00 점검에서 조기 소진 예상 캠페인을 확인하고, 16:30 조정안 공유 전에 AD Pilot 승인 요청을 올립니다.'],
        };
      },
    },
    {
      id: 'reports_savings',
      match: /절감|리소스|업무 시간|자동화 효과|59%|재투입|1,?070분|435분/,
      build: (): Brief => {
        const s = computeSavings();
        const plan = reinvestPlan(s.saved, REINVEST_DEFAULT.map((x) => ({ id: x.id, label: x.label, share: x.share })));
        return {
          title: 'SA 업무 자동화 절감 목표',
          facts: [
            `주간 SA 운영 업무 ${fmt.int(s.before)}분 → 자동화 후 목표 ${fmt.int(s.after)}분, 절감률 −${Math.round(s.reductionPct)}% (약 ${aboutHours(s.before)}시간 → 약 ${aboutHours(s.after)}시간, 제안서 p.19).`,
            `절감 ${fmt.int(s.saved)}분/주는 연간 약 ${fmt.int(s.annualSavedHours)}시간, 주 40시간 기준 ${fmt.dec1(s.fte)}명분입니다.`,
          ],
          patterns: [`도입 브랜드 3곳의 반복 업무 리소스 감소 실적은 최소 ${SAVINGS_FLOOR_PCT}%이며(p.11), 목표는 이 실적을 하한으로 둡니다.`],
          interpretation: ['기존 소요는 가정값이므로 절감률보다 절감 분의 절대량이 수면밀도 실제 업무량에 따라 달라집니다. 실측 전에는 목표를 확정 성과로 보고하지 않습니다.'],
          conditions: [`판정: 하한 −${SAVINGS_FLOOR_PCT}% 이상이면 하한 충족, 업무별 목표 이상이면 목표 달성. 확정은 온보딩 ${SAVINGS_CONFIRM_DAYS}일 내 실측(p.19).`],
          counter: ['자동화 초기에는 검수 · 승인 단계가 추가돼 일시적으로 소요가 늘 수 있습니다. 이 경우 D+60 병행 운영 기간 실측을 별도로 기록합니다(p.20).'],
          actions: [`절감 시간은 ${plan.map((p) => `${p.label} ${fmt.int(p.minutesPerWeek)}분`).join(' · ')}(주간, 가안)로 재투입하고, D+90 리소스 절감 실측 보고에서 확정합니다.`],
        };
      },
    },
    {
      id: 'reports_rollout',
      match: /90일|적용 일정|D\+30|D\+60|D\+90|자동화 일정/,
      build: (ctx): Brief => {
        const ro = automationRollout(KICKOFF_ASSUMED, ctx.state.data.today);
        return {
          title: '자동화 적용 일정 · 90일',
          facts: [
            `Kick-off ${fmtDate(ro.kickoff)} 가정 기준 ${ro.phases.map((p) => `${p.label} ${fmtDate(p.start)}–${fmtDate(p.end)}`).join(', ')} (제안서 p.20). 데이터 기준일 ${fmtDate(ctx.state.data.today)}에서 Kick-off까지 ${ro.daysToKickoff}일.`,
            `단계별 가동 모듈: ${ro.phases.map((p) => `D+${p.day} ${p.modules.map((m) => m.label).join(' · ')}`).join(' → ')} (p.22).`,
          ],
          patterns: [],
          interpretation: [`업무별 적용 단계를 p.20 항목에 맞추면 주간 SA 업무는 ${ro.phases.map((p) => `D+${p.day} ${fmt.int(p.weeklyAfter)}분`).join(' → ')}로 줄어듭니다. D+30은 기존 입찰 로직을 보존하는 단계라 절감을 계상하지 않습니다.`],
          conditions: [`업무별 적용 단계는 운영 가정이며, 기존 소요는 온보딩 ${SAVINGS_CONFIRM_DAYS}일 내(${fmtDate(ro.confirmDate)}까지) 실측으로 확정합니다. Kick-off 날짜는 최종 선정(26.11.24 주차) 후 협의로 확정합니다.`],
          counter: ['데이터 연동 범위가 매체 API 제공 범위보다 좁으면 D+60 자동화 항목 일부가 D+90으로 밀릴 수 있습니다. 이 경우 병행 운영 기간을 늘려 성과 공백을 막습니다.'],
          actions: ['PM은 Kick-off 확정 시 단계별 측정 기준(전월 대비 성과 유지 · 리포트·알림 자동화 가동 · 절감 시간 실측)을 수면밀도와 합의하고, D+90 리소스 절감 실측 보고 일정을 고정합니다.'],
        };
      },
    },
  ],
};
