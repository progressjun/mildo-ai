/**
 * 성과 증명 에이전트 도구 · 오프라인 브리프 — MILDO Agent가 tool use로 호출한다.
 * 서버 모드에서는 성과 증명 화면이 마지막으로 읽은 서버 값(요약 · 장부 · 보관함)을, 데모 모드에서는 데모 데이터로 만든 예시(TEST DATA)를 쓴다.
 * 상태를 바꾸는 도구는 두지 않는다 (즉시 측정 · 리포트 발송은 사람이 화면에서, 권한 확인 후).
 */
import type { Brief } from '@/ai/prompts';
import type { ModuleAgentKit, ToolContext } from '../types';
import { fmt } from '@/core/util';
import {
  buildDemoImpact, CONFIDENCE_LABEL, estimateText, hoursText, krw, monthLabel, SOURCE_LABEL, statusText, times,
  type ImpactSummary, type LedgerEntry, type LedgerStatus, type SourceType,
} from './engine';
import { getImpactSnapshot } from './live';

interface Source { demo: boolean; summary: ImpactSummary; entries: LedgerEntry[]; asOf: string; reports: { type: string; title: string; status: string; generatedAt: string }[] }

function sourceOf(ctx: ToolContext | null): Source {
  const s = getImpactSnapshot();
  if (s?.summary) {
    return {
      demo: false, summary: s.summary, entries: (s.entries ?? []).filter((e) => e.month === s.summary!.month), asOf: new Date(s.at).toISOString(),
      reports: (s.reports ?? []).slice(0, 10).map((r) => ({ type: r.type, title: r.title, status: r.status, generatedAt: r.generatedAt })),
    };
  }
  const data = ctx?.state?.data;
  const ex = data ? buildDemoImpact(data, ctx?.state?.incidents ?? []) : null;
  if (ex) return { demo: true, summary: ex.summary, entries: ex.entries, asOf: '데모 기준 시각', reports: [] };
  return { demo: true, summary: buildDemoImpact({ today: '2026-10-31', keywords: [] }, []).summary, entries: [], asOf: '데모 기준 시각', reports: [] };
}

const kindText = (demo: boolean, s: ImpactSummary) => (demo ? 'TEST DATA 예시' : s.dataMode === 'live' ? '서버 장부 · LIVE DATA' : s.dataMode === 'demo' ? '서버 장부 · TEST DATA(데모 커넥션)만 연결' : '서버 장부 · TEST DATA 포함');

export function impactBrief(ctx: ToolContext): Brief {
  const src = sourceOf(ctx);
  const s = src.summary;
  const t = s.totals;
  const c = s.counts;
  const ups = src.entries.filter((e) => e.sourceType === 'change' && e.status === 'measured');
  const notApplied = src.entries.filter((e) => e.sourceType === 'change' && e.status === 'excluded' && e.detail.exclusion === 'not_applied').length;
  const facts = [
    `${monthLabel(s.month)} 장부 · 출처 ${kindText(src.demo, s)}.`,
    `변경 반영 측정 완료 ${c.change.measured}건 · 표본 부족 ${c.change.insufficient} · 관측 중 ${c.change.pending} · 집계 제외 ${c.change.excluded}.`,
    `해결된 사고 손실 추정 ${c.incident.measured}건 · 자동화 단위 ${c.automation.measured}개.`,
    ...(notApplied ? [`매체 미반영(dry_run · 기록만) 변경 ${notApplied}건은 매체 값이 바뀌지 않아 증분 추정에서 제외했다.`] : []),
    `월 구독료 ${krw(t.costOfSubscription)} (${s.config.sources.monthlyFee === 'workspace' ? '워크스페이스 설정' : '기본값'}).`,
  ];
  const patterns: string[] = [];
  if (ups.length) {
    const pos = ups.filter((e) => e.estimate?.kind === 'uplift' && e.estimate.ci[0] > 0).length;
    patterns.push(`측정된 변경 ${ups.length}건 중 80% 구간 하한이 0보다 큰 건 ${pos}건 — 나머지는 효과 방향이 아직 확정되지 않았다.`);
  }
  const insuff = src.entries.filter((e) => e.status === 'insufficient');
  if (insuff.length) {
    const has = (w: string) => insuff.filter((e) => (e.detail.reasons ?? []).some((r) => r.includes(w))).length;
    patterns.push(`표본 부족 ${insuff.length}건 — 클릭 기준 미달 ${has('클릭')}건 · 전환 기준 미달 ${has('전환')}건 (기준: 창마다 클릭 30 · 전환 3 이상).`);
  }
  const pb = t.paybackMultiple;
  const interpretation = [
    `회수 배수 ${times(pb.point)} (80% 구간 ${times(pb.lo)} ~ ${times(pb.hi)}), 판정 '${s.verdict.label}' — 기준 ${s.verdict.basis}.`,
    `구성: 측정 증분 이익 ${krw(t.measuredUpliftProfit.point)} (측정) · 손실 회피 ${krw(t.lossAvoidedEst)} × 공헌이익률 ${fmt.pct(s.config.margin * 100, 0)} (추정) · 절감 ${hoursText(t.hoursSaved)} × 시간당 ${krw(s.config.hourlyCost)} (가정).`,
    s.components[0].valueKrw >= s.components[1].valueKrw + s.components[2].valueKrw
      ? '회수의 대부분이 대조군으로 측정한 증분에서 나와 근거가 상대적으로 단단하다고 본다.'
      : '회수의 상당 부분이 추정(손실 회피) · 가정(건당 절감 분)에서 나와, 측정 증분이 쌓이기 전까지는 보수적으로 읽는 편이 맞다.',
  ];
  const actions = [
    c.change.pending ? `관측 중 ${c.change.pending}건은 반영 후 7일 데이터가 쌓이면 매일 06:00 측정에서 반영된다.` : '',
    insuff.length ? '표본 부족 변경은 같은 의도 키워드를 묶어 판정하거나 비교 창을 늘리는 방식을 검토한다.' : '',
    s.config.sources.margin === 'default' || s.config.sources.hourlyCost === 'default' ? '공헌이익률 · 시간당 인건비를 실제 값으로 확정한다 (지금은 기본값).' : '',
    src.demo ? '서버에 연결하면 실제 반영 이력 · 사고 조치 기록 · 자동 실행 기록으로 다시 계산된다.' : '성과 증명 화면 장부에서 근거 행을 열어 전제와 원천 화면을 확인한다.',
  ].filter(Boolean);
  return {
    title: `성과 증명 · ${monthLabel(s.month)} 회수 배수`,
    facts,
    patterns,
    interpretation,
    conditions: [s.formula, ...s.conditions.slice(0, 4)],
    counter: s.counterExamples.slice(0, 4),
    actions,
  };
}

const compactEntry = (e: LedgerEntry) => ({
  type: SOURCE_LABEL[e.sourceType], label: e.label, at: e.occurredAt, status: statusText(e), estimate: estimateText(e),
  confidence: e.estimate ? CONFIDENCE_LABEL[e.estimate.confidence] : null, reason: [e.detail.reason, ...(e.detail.reasons ?? [])].filter(Boolean).join(' · ') || null,
  route: e.detail.route ?? null, test: !!e.detail.test,
});

export const agentKit: ModuleAgentKit = {
  tools: (ctx) => [
    {
      name: 'impact_summary',
      description: '성과 증명 월간 요약 — 회수 배수(구독료 대비) · 80% 구간 · 판정 기준 · 구성 요소(측정 증분 · 추정 손실 회피 · 절감 시간)별 방법 · 신뢰도 · 표본 · 전제 · 반례. 서버 모드는 화면이 읽은 서버 값, 데모는 TEST DATA 예시.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const src = sourceOf(ctx);
        const s = src.summary;
        return {
          source: kindText(src.demo, s), asOf: src.asOf, month: s.month,
          paybackMultiple: s.totals.paybackMultiple, verdict: s.verdict, formula: s.formula, formulaFilled: s.formulaFilled,
          totals: { measuredUpliftRevenue: s.totals.measuredUpliftRevenue, measuredUpliftProfit: s.totals.measuredUpliftProfit, lossAvoidedEst: s.totals.lossAvoidedEst, hoursSaved: s.totals.hoursSaved, costOfSubscription: s.totals.costOfSubscription },
          config: s.config,
          components: s.components.map((c) => ({ id: c.id, label: c.label, valueKrw: c.valueKrw, method: c.method, conversion: c.conversion, confidence: c.confidence, confidenceBasis: c.confidenceBasis, sample: c.sample })),
          counts: s.counts, conditions: s.conditions, counterExamples: s.counterExamples, recentReports: src.reports,
        };
      },
    },
    {
      name: 'impact_ledger',
      description: '성과 증명 장부 행 — 변경(반영 전 · 후 · 대조군 · 증분 추정) · 사고(손실 회피 추정) · 자동화(절감 시간). type(change · incident · automation) · status(measured · insufficient · pending · excluded)로 거를 수 있다.',
      inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['change', 'incident', 'automation'] }, status: { type: 'string', enum: ['measured', 'insufficient', 'pending', 'excluded'] } } },
      execute: (input) => {
        const src = sourceOf(ctx);
        const type = input.type as SourceType | undefined;
        const status = input.status as LedgerStatus | undefined;
        const rows = src.entries.filter((e) => (!type || e.sourceType === type) && (!status || e.status === status));
        return { source: kindText(src.demo, src.summary), month: src.summary.month, total: rows.length, entries: rows.slice(0, 40).map(compactEntry) };
      },
    },
  ],
  briefs: [
    { id: 'impact-payback', match: /성과\s*증명|회수|구독료|ROI|payback|가치\s*리포트|증분|손실\s*회피|절감\s*시간|장부/i, build: impactBrief },
  ],
};
