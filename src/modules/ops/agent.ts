/**
 * 전담 TF · 온보딩 · 계약 · RFP 커버리지 — MILDO Agent 도구 + 오프라인 브리프.
 * 도구는 모두 읽기 전용이다 (상태를 바꾸지 않음). 수수료 · 레퍼런스 등 제출 전 입력값은 화면의 로컬 저장값(local.ts)을 읽고,
 * 도구 입력으로 값을 주면 그 값으로 가정 계산만 한다. 결과는 작은 plain JSON, 숫자는 반올림.
 */
import type { AgentTool } from '@/ai/claude';
import { CONTRACT_TERMS, RFP, TF_ROLES } from '@/data/constants';
import { addDays } from '@/core/util';
import type { ModuleAgentKit, ToolContext } from '../types';
import {
  annualCost, backupGraph, contractCheck, ddayLabel, decisionLoad, dutyBlocks, feeBrief, feeCalc, isDateStr, LEAVE_PRESETS, onboardingBrief, onboardingPlan,
  opsSummary, ownershipStatus, performanceBaseline, rfpBrief, roleLabel, round, simulateLeave, tfBrief, tfMissing, tfRoster, type FeeInput, type OpsInputs,
} from './engine';
import { loadOpsLocal } from './local';
import { LEAVE_ASSUMPTIONS } from './data';

const { r0, r1, r2 } = round;
const SRC_PROP = '제안서 p.51–59 · RFP 기준 (TF 성명 · 수수료 등 미입력 칸은 제출 전 입력 대상)';

function inputsOf(ctx: ToolContext): OpsInputs {
  const l = loadOpsLocal();
  return { tf: ctx.state.tf, backupOverrides: l.backupOverrides, refs: l.refs, fees: l.fees, annualBudget: l.annualBudget, contract: l.contract, geoCaseDone: !!l.docs.geo_case };
}
async function registryIds(): Promise<string[] | null> {
  try {
    const { MODULES } = await import('../registry');
    return MODULES.map((m) => m.id);
  } catch {
    return null;
  }
}
const ROLE_IDS: string[] = TF_ROLES.map((r) => r.id);
function roleIdsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v.map(String)) {
    const id = ROLE_IDS.find((x) => x === s) ?? TF_ROLES.find((r) => r.role === s)?.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'ops_tf',
      description: '전담 7인 TF 명단(역할 · 성명 · 연차 · 투입률 · 백업)의 미입력 · 오입력 칸, 1:1 백업 그래프(상호 백업 · 단방향 · 공백 · 집중), 주말 · 공휴일 당번 순번을 반환합니다. absent를 주면 휴가 시뮬레이션(백업 인수 · 과부하 · 응답 공백 · 당번 충돌) 결과를 함께 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          absent: { type: 'array', items: { type: 'string', enum: ROLE_IDS }, description: `부재 인원 역할 id (${TF_ROLES.map((r) => `${r.id}=${r.role}`).join(', ')})` },
          start: { type: 'string', description: '부재 시작일 YYYY-MM-DD (기본: 데이터 기준일 +2일)' },
          days: { type: 'number', description: '부재 일수 (기본 7)' },
          transferPct: { type: 'number', description: '백업이 인수하는 업무 비율 % (기본 50, 운영 가정)' },
          overloadPct: { type: 'number', description: '과부하 기준 합산 투입률 % (기본 100)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const i = inputsOf(ctx);
        const rows = tfRoster(i.tf, i.backupOverrides);
        const m = tfMissing(rows);
        const g = backupGraph(rows);
        const absent = roleIdsOf(inp.absent);
        const start = isDateStr(inp.start) ? inp.start : addDays(d.today, 2);
        const sim2 = absent.length
          ? simulateLeave(rows, absent, { start, days: num(inp.days) ?? LEAVE_ASSUMPTIONS.defaultDays, transferPct: num(inp.transferPct), overloadPct: num(inp.overloadPct) })
          : null;
        const blocks = dutyBlocks(d.today, 42).slice(0, 6);
        return {
          출처: SRC_PROP,
          명단: rows.map((r) => ({
            역할: r.role, 성명: r.name || '[성명] 미입력', 연차: r.years !== null && !r.invalid.years ? r.years : r.raw.years ? `오입력(${r.raw.years})` : '[n]년 미입력',
            담당: r.scope, 투입률pct: r.allocation !== null && !r.invalid.allocation ? r.allocation : r.raw.allocation ? `오입력(${r.raw.allocation})` : '[n]% 미입력', 백업: r.backupRole,
          })),
          미입력: { 전체칸: m.cells, 미입력칸: m.total, 성명: m.name, 연차: m.years, 투입률: m.allocation, 오입력인원: m.invalid, 입력FTE: r2(m.fte) },
          RFP전담자: m.dedicated.map((x) => `${x.label} ${x.ok ? '지정' : '미지정'}`),
          백업: {
            상호백업: g.mutualPairs.map(([a, b]) => `${roleLabel(a)} ↔ ${roleLabel(b)}`),
            이슈: g.issues.map((x) => `${x.level === 'gap' ? '공백' : x.level === 'warn' ? '주의' : '참고'} · ${x.text}`),
          },
          당번: blocks.map((b) => ({ 기간: `${b.start}~${b.end}`, 사유: [...new Set(b.labels)].join(' · '), 당번: [...new Set(b.duties.map((x) => x.role))].join(' · '), 백업: [...new Set(b.duties.map((x) => x.backup))].join(' · '), 다음영업일브리핑: `${b.briefing} 09:30` })),
          휴가시뮬레이션: sim2
            ? {
                부재: sim2.absent.map(roleLabel), 기간: sim2.period ? `${sim2.period.start}~${sim2.period.end}` : null,
                가정: { 인수비율pct: sim2.assumptions.transferPct, 과부하기준pct: sim2.assumptions.overloadPct, 미입력투입률가정pct: sim2.assumptions.assumedAllocation, 가정적용: sim2.assumptions.assumedRoles },
                부하: sim2.members.filter((x) => !x.absent).map((x) => ({ 역할: x.role, 기본pct: r0(x.base), 인수: x.incoming.map((t) => `${t.fromRole} ${r0(t.alloc)}%${t.fallback ? ' (공백 · PM 대행)' : t.hops > 1 ? ` (${t.hops}차 백업)` : ''}`), 합계pct: r0(x.load), 판정: x.overload ? `과부하 · 기준 ${sim2.assumptions.overloadPct}% 초과` : '가능' })),
                응답공백: sim2.gaps.map((x) => `${x.role}: ${x.reason}${x.fallbackId ? ' → PM 대행' : ''}`),
                당번충돌: sim2.dutyConflicts.map((c) => `${c.date} ${c.role} 부재 → ${c.replacement}`),
              }
            : { 안내: `absent에 역할 id를 넣으면 계산합니다. 프리셋: ${LEAVE_PRESETS.map((p) => `${p.label}=${p.absent.join('+')}`).join(', ')}` },
        };
      },
    },
    {
      name: 'ops_fee_calc',
      description: '매체별 수수료율 · 페이백(p.58)을 연 광고비 배분(p.37, 기본 연 50억)에 적용해 매체별 연 수수료 · 순 수수료 · 실효 수수료율 · 연간 총 비용과 계약 조건(기간 · 해지 · 솔루션 이용료 · 계정 소유) 미입력 항목을 반환합니다. fees를 주면 그 요율로 가정 계산합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          fees: { type: 'object', description: `매체명 → 수수료율 % (매체명: ${CONTRACT_TERMS.fees.map((f) => f.media).join(', ')}). 생략 시 화면 입력값`, additionalProperties: { type: 'number' } },
          paybackPct: { type: 'object', description: '매체명 → 페이백율 % (0이면 미적용)', additionalProperties: { type: 'number' } },
          annualBudget: { type: 'number', description: '연간 광고비 (원, 기본 RFP 약 50억)' },
        },
      },
      execute: (inp) => {
        const i = inputsOf(ctx);
        const fees: Record<string, FeeInput | undefined> = { ...(i.fees ?? {}) };
        const fIn = (inp.fees && typeof inp.fees === 'object' ? inp.fees : {}) as Record<string, unknown>;
        const pIn = (inp.paybackPct && typeof inp.paybackPct === 'object' ? inp.paybackPct : {}) as Record<string, unknown>;
        for (const f of CONTRACT_TERMS.fees) {
          const fv = num(fIn[f.media]);
          const pv = num(pIn[f.media]);
          if (fv !== undefined) fees[f.media] = { ...fees[f.media], fee: String(fv) };
          if (pv !== undefined) fees[f.media] = { ...fees[f.media], payback: pv > 0 ? 'yes' : 'no', paybackPct: String(pv) };
        }
        const budget = num(inp.annualBudget) ?? i.annualBudget ?? RFP.annualBudget;
        const f = feeCalc(fees, budget);
        const c = contractCheck(i.contract);
        const cost = annualCost(f, c);
        return {
          출처: '제안서 p.58 수수료 · 계약 · p.37 배분 가안 (VAT 별도)',
          연간광고비: r0(f.annualBudget),
          매체: f.rows.map((r) => ({
            매체: r.media, 배분비중pct: r1(r.share * 100), 연광고비: r0(r.budget), 수수료율pct: r.feePct, 연수수료: r.fee !== null ? r0(r.fee) : null,
            페이백: r.payback === 'unset' ? '[적용 여부] 미입력' : r.payback === 'yes' ? `적용 ${r.paybackPct ?? '[율 미입력]'}%` : '미적용',
            순수수료: r.net !== null ? r0(r.net) : null, 실효율pct: r2(r.effectivePct), 미입력: r.missing,
          })),
          합계: { 수수료: r0(f.totals.fee), 페이백: r0(f.totals.payback), 순수수료: r0(f.totals.net), 월평균순수수료: r0(f.totals.monthlyNet), 실효수수료율pct: r2(f.totals.effectivePct), 입력매체광고비: r0(f.totals.enteredBudget) },
          수수료율1pp당연간: r0(f.perPointKrw),
          계약: c.items.map((x) => ({ 항목: x.label, 값: x.value, 상태: x.status === 'ok' ? '확정' : x.status === 'invalid' ? '오입력' : '미입력', 근거: x.basis })),
          연간총비용: { 광고비: r0(cost.media), 순수수료: r0(cost.fee), 솔루션이용료: r0(cost.solution), 합계: r0(cost.total), 부대비용비율pct: r2(cost.overheadPct) },
          미입력: { 수수료율: f.missing.fee, 페이백여부: f.missing.payback, 페이백율: f.missing.paybackPct, 오입력: f.missing.invalid, 계약: c.missing },
          경고: f.warnings,
          평가: `비용 · 계약 조건 비중 ${RFP.evaluation.find((e) => e.id === 'cost')?.weight ?? 10}% · 동점 시 수수료 조건 종합 고려 (RFP)`,
        };
      },
    },
    {
      name: 'ops_rfp_coverage',
      description: 'RFP 요청 항목([1순위] · [2순위] · 매출 성장 · [기본 요건])과 필수 제출물 2)~7)이 어떤 MILDO OS 모듈 · 제안서 장표로 대응되는지와 상태(구현됨 / 입력 필요), 선정 기준 6개 비중별 준비도, 선정 일정과 제출 마감 D-day를 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'input', 'done'], description: '상태 필터 (기본 all)' },
        },
      },
      execute: async (inp) => {
        const d = ctx.state.data;
        const ids = await registryIds();
        const s = opsSummary(d, inputsOf(ctx), ids, ctx.state.changes);
        const filter = inp.status === 'input' || inp.status === 'done' ? inp.status : 'all';
        return {
          출처: 'RFP 제안 요청 사항 · 필수 제출물 · 대행사 선정 기준 / 상태는 입력 완료 여부 기준 자체 점검',
          기준시각: `${d.today} ${d.currentHour}시`,
          제출마감: { 일시: `${s.schedule.deadline.date} ${s.schedule.deadline.hour}시`, Dday: ddayLabel(s.schedule.deadline.days), 남은시간: s.schedule.deadline.hoursLeft, 내부확정목표: s.schedule.deadline.freeze },
          일정: s.schedule.rows.map((r) => ({ 단계: r.step, 일시: r.date, 상태: { done: '완료', now: '진행 중', next: '다음', upcoming: '예정', tbd: '협의' }[r.status], Dday: r.ddayLabel })),
          커버리지: s.coverage.filter((r) => filter === 'all' || r.status === filter).map((r) => ({ 구분: r.groupLabel, 항목: r.text, 모듈: r.modules, 장표: r.pages, 상태: r.status === 'done' ? '구현됨' : '입력 필요', 비고: r.note })),
          집계: { 전체: s.coverage.length, 구현됨: s.coverageDone, 입력필요: s.coverage.length - s.coverageDone },
          평가비중: s.eval.rows.map((e) => ({ 기준: e.label, 비중: e.weight, 항목: e.items, 구현됨: e.done, 가중준비도: r1(e.weighted) })),
          가중준비도합계: r1(s.eval.total),
          우선협상: `리소스 절감 자동화 · 운영 안정성(${s.eval.priorityWeight}%) 우선, 동점 시 수수료 · 준비도 ${r1(s.eval.priorityReady)}/${s.eval.priorityWeight}`,
        };
      },
    },
    {
      name: 'ops_onboarding',
      description: 'Kick-off 날짜 기준 90일 온보딩(p.54 · p.20) W1~W12 작업 기간 · 마일스톤(D+30 · D+60 · D+90) 실제 날짜 · 기간 내 공휴일 · 단계별 측정 기준과 D+30 성과 기준선(최근 30일 TEST DATA), 계정 · 결제 · 권한 인수 점검 결과를 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: { kickoff: { type: 'string', description: 'Kick-off 날짜 YYYY-MM-DD (기본: 화면 입력값, 없으면 2026-12-01 가정)' } },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const kickoff = isDateStr(inp.kickoff) ? inp.kickoff : loadOpsLocal().kickoff;
        const p = onboardingPlan(kickoff, d.today);
        const b = performanceBaseline(d);
        const own = ownershipStatus(d, ctx.state.changes);
        return {
          출처: '제안서 p.20 · p.54 (Kick-off는 RFP상 협의 — 가정 날짜)',
          Kickoff: p.kickoff, 유효: p.valid, Kickoff까지일: p.daysToKickoff, 최종선정주: `${p.selection.weekStart}~${p.selection.weekEnd}`, 선정후간격일: p.selection.gapDays,
          작업: p.tasks.map((t) => ({ 작업: t.task, 주차: `W${t.start}–W${t.end}`, 기간: `${t.from}~${t.to}` })),
          마일스톤: p.milestones.map((m) => ({ 이름: m.label, 날짜: m.date, 휴무: m.off.off ? `${m.off.label} → 보고 ${m.reportDay}` : null })),
          단계: p.phases.map((ph) => ({ 단계: ph.label, 기간: `${ph.from}~${ph.to}`, 항목: ph.items, 측정기준: ph.metric })),
          공휴일: p.holidays.map((h) => `W${h.week} ${h.date} ${h.label}`),
          성과기준선: { 출처: 'TEST DATA (시연용 테스트 데이터)', 기간: `${b.from}~${b.to}`, ROASpct: r0(b.roas), CPA: r0(b.cpa), 광고비: r0(b.cost), 허용폭pct: b.tolerancePct, ROAS하한pct: r0(b.roasFloor), CPA상한: r0(b.cpaCeiling) },
          인수점검: { 계정수: own.summary.accounts, 소유수면밀도: own.summary.ownerOk, 비실명권한: own.summary.nonRealName, 결제위험: own.summary.paymentRisk, 검수상태: own.summary.review, 항목: own.rows.map((r) => `${r.item}: ${r.live}`) },
          의사결정: decisionLoad(ctx.state.changes).map((x) => `${x.type} → ${x.decider} (${x.lead})${x.pending !== null ? ` · 승인 대기 ${x.pending}건` : ''}`),
        };
      },
    },
  ],
  briefs: [
    { id: 'ops_tf', match: /(TF|인력|백업|담당자|투입률|휴가|연차|실명|전담|당번|공백)/i, build: (ctx) => tfBrief(ctx.state.data, inputsOf(ctx)) },
    { id: 'ops_fee', match: /(수수료|페이백|계약|해지|견적|솔루션\s?이용료|비용 조건)/, build: (ctx) => feeBrief(inputsOf(ctx)) },
    { id: 'ops_rfp', match: /(RFP|커버리지|제출|평가|선정 기준|비중|마감|D-?day|선정 일정|경쟁 PT|레퍼런스)/i, build: (ctx) => rfpBrief(ctx.state.data, inputsOf(ctx)) },
    { id: 'ops_onboarding', match: /(온보딩|인수|킥오프|kick-?off|90일|D\+30|D\+60|D\+90|정착)/i, build: (ctx) => onboardingBrief(ctx.state.data, loadOpsLocal().kickoff) },
  ],
};

