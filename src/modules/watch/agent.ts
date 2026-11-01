/**
 * MILDO Watch 에이전트 도구 — MILDO Agent가 Claude tool use로 호출한다.
 * 결과는 작은 plain JSON (숫자 반올림). 상태를 바꾸는 도구(watch_request_test)는 ChangeRequest를 pending으로만 만든다.
 */
import type { ChangeRequest } from '@/core/types';
import type { ModuleAgentKit, ToolContext } from '../types';
import { RFP } from '@/data/constants';
import { addDays } from '@/core/util';
import { evidenceLine, executionRisks, linkedIncidents, roundN, STAGE_LABEL, testChangePayload, KIND_LABEL, type StageId } from './engine';
import { ARCHIVE_ITEMS, MEDIA_TRACKING } from './data';
import { getWatchStore } from './progress';
import { changesBrief, competitorsBrief, computeWatch, seasonBrief, weeklyBriefOf } from './briefs';

const snap = (ctx: ToolContext) => computeWatch(ctx.state.data, { changes: ctx.state.changes, overrides: getWatchStore().progress });
const mediaName = (m: string) => MEDIA_TRACKING.find((t) => t.media === m)?.name ?? m;
const asOf = (ctx: ToolContext) => `${ctx.state.data.today} ${String(ctx.state.data.currentHour).padStart(2, '0')}:30`;
const STAGES: StageId[] = ['detect', 'diagnose', 'plan', 'test', 'wrapup'];

/**
 * MILDO Agent는 화면을 그릴 때의 ctx로 도구 묶음을 만든다 — 한 번의 Claude 응답 안에서 ctx.state는 그 시점 스냅샷이라
 * 같은 응답에서 방금 만든 승인 요청이 보이지 않는다(같은 대상을 두 번 요청하면 중복 생성).
 * 이 도구 묶음이 만든 요청을 스냅샷에 더해 읽기 · 중복 확인이 최신 이력을 보게 한다.
 */
function liveCtx(ctx: ToolContext): ToolContext {
  const made: ChangeRequest[] = [];
  return {
    ...ctx,
    get state() {
      const base = ctx.state;
      const extra = made.filter((m) => !base.changes.some((c) => c.id === m.id));
      return extra.length ? { ...base, changes: [...extra, ...base.changes] } : base;
    },
    actions: {
      ...ctx.actions,
      addChange: ((c: Parameters<ToolContext['actions']['addChange']>[0]) => {
        const ch = ctx.actions.addChange(c);
        if (ch && typeof ch === 'object' && 'id' in ch) made.push(ch as ChangeRequest);
        return ch;
      }) as ToolContext['actions']['addChange'],
    },
  };
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx0) => {
    const ctx = liveCtx(ctx0);
    return [
    {
      name: 'watch_changes',
      description: 'MILDO Watch 매체 변동 이벤트(매체 공지 · 데이터 감지 신호)의 파이프라인 단계, 24시간 영향 진단(판정 · 근거 수치 · 기준), 영향 범위, 다음 액션, 소액 테스트 설계 · 랩업 판정을 반환한다. TEST DATA 기준.',
      inputSchema: {
        type: 'object',
        properties: {
          media: { type: 'string', enum: ['all', 'naver_sa', 'naver_gfa', 'google', 'meta', 'kakao', 'vertical'], description: '매체 필터 (기본 all)' },
          stage: { type: 'string', enum: ['open', 'all', ...STAGES], description: '단계 필터 (기본 open = 랩업 · 종료 제외)' },
        },
      },
      execute: (input) => {
        const s = snap(ctx);
        const media = (input.media as string) || 'all';
        const stage = (input.stage as string) || 'open';
        const list = s.events.filter((e) => (media === 'all' || e.media === media) && (stage === 'all' ? true : stage === 'open' ? !e.closed && e.stage !== 'wrapup' : e.stage === stage));
        return {
          asOf: asOf(ctx),
          dataKind: 'TEST DATA · 매체 공지 이벤트는 시연용 가상 공지 (GFA 신규 상품 3종은 제안서 p.24 표기)',
          pipeline: { 감지: s.counts.detect, 영향진단: s.counts.diagnose, 실행안: s.counts.plan, 소액테스트: s.counts.test, 랩업: s.counts.wrapup, 관찰종료: s.counts.closed },
          nextWeeklyReport: s.report.label,
          events: list.slice(0, 14).map((e) => ({
            id: e.id,
            origin: e.origin === 'notice' ? '매체 공지' : '데이터 감지',
            media: mediaName(e.media),
            kind: KIND_LABEL[e.kind],
            title: e.title,
            detectedAt: e.detectedAt,
            stage: e.closed ? '관찰 종료' : STAGE_LABEL[e.stage],
            due: e.due.label,
            overdue: e.due.overdue,
            diagnosis: { verdict: e.diag.label, basis: e.diag.basis, evidence: e.diag.evidence.filter((x) => x.level !== 'ok').slice(0, 4).map(evidenceLine), causes: e.diag.causes.slice(0, 3).map((c) => ({ label: c.label, score: c.score, basis: c.basis })) },
            affected: { scope: e.diag.affected.scope, spendPerDay: roundN(e.diag.affected.spendPerDay, -3), revenuePerDay: roundN(e.diag.affected.revenuePerDay, -3) },
            keywords: e.keywords.slice(0, 6),
            plan: e.plan,
            next: { action: e.next.action ? e.next.label : null, blocked: e.next.disabled ?? null },
            test: e.test ? {
              arms: e.design.arms, perDay: e.design.perDay, days: e.design.days, approver: e.design.approverLabel,
              judge: e.judge.verdict === 'pending' ? null : { label: e.judge.label, basis: e.judge.basis },
              executionRisks: e.closed || e.stage === 'wrapup' ? [] : executionRisks(e, ctx.state.data).map(evidenceLine),
            } : null,
            labRequest: e.testChange ? { id: e.testChange.id, status: e.testChange.status } : null,
            alertIssues: linkedIncidents(e, ctx.state.incidents, ctx.state.data).map((i) => ({ id: i.id, severity: i.severity, title: i.title, status: i.status })),
          })),
        };
      },
    },
    {
      name: 'watch_competitors',
      description: '경쟁 6개사 오가닉 · 페이드 아카이브(검색 지면 · 소재 · 프로모션 · 가격 · 혜택 · 오프라인 · 외부 변수 · 파트너 인사이트)의 변경 기록과 영향도 판정 근거, 브랜드 키워드 검색 결과 지면 침투 점검 결과를 반환한다. 시연용 가상 스냅샷.',
      inputSchema: {
        type: 'object',
        properties: {
          competitor: { type: 'string', enum: ['all', ...RFP.competitors], description: '경쟁사 필터 (기본 all)' },
          item: { type: 'string', enum: ['all', ...ARCHIVE_ITEMS.map((i) => i.id)], description: '아카이빙 항목 필터 (기본 all)' },
          days: { type: 'number', description: '조회 기간 (일, 기본 30)' },
        },
      },
      execute: (input) => {
        const s = snap(ctx);
        const days = Math.max(1, Math.min(120, Number(input.days) || 30));
        const comp = (input.competitor as string) || 'all';
        const item = (input.item as string) || 'all';
        const from = ctx.state.data.today;
        const since = addDays(from, -(days - 1));
        const rows = s.archive.filter((r) => r.date >= since && (comp === 'all' || r.competitor === comp) && (item === 'all' || r.item === item));
        const created = new Set(getWatchStore().alerts);
        return {
          asOf: asOf(ctx),
          dataKind: '시연용 가상 스냅샷 · 실제 경쟁사 활동 아님',
          window: `${since} ~ ${from}`,
          cadence: ARCHIVE_ITEMS.map((i) => ({ item: i.label, scope: i.scope, cadence: i.cadence, source: i.cadenceSrc })),
          byCompetitor: s.matrix.byCompetitor.map((c) => ({ competitor: c.competitor, changes30d: c.count, high: c.high, latest: c.latest ? `${c.latest.date} ${c.latest.title}` : null })),
          records: rows.slice(0, 15).map((r) => ({ id: r.id, date: r.date, competitor: r.competitor ?? '공통', item: r.itemLabel, channel: r.channel, title: r.title, impact: r.impact.label, basis: r.impact.basis, facts: r.impact.facts, alertP3: r.alertable ? (created.has(`watch_competitor:${r.id}:${ctx.state.data.today}`) || ctx.state.incidents.some((i) => i.id === `watch_competitor:${r.id}:${ctx.state.data.today}`) ? '생성됨' : '생성 가능 (화면 버튼)') : null })),
          brandSerp: s.serp.map((x) => ({ keyword: x.keyword, ownPosition: x.ownPos, avgRank: roundN(x.avgRank, 1), lostShare: roundN(x.lost * 100, 0), verdict: x.label, competitorsAbove: x.competitorsAbove, basis: x.basis, roasVsBrandTarget: roundN(x.roasVsTarget, 0) })),
        };
      },
    },
    {
      name: 'watch_weekly_brief',
      description: 'p.28 주간 인사이트 브리프 자동 초안(이번 주 감지 사항 → 영향 → 제안)을 마크다운으로 반환한다. 확정 팩트 · 반복 관측 패턴 · 전제 · 반례 · 다음 액션 구분, 발송 일정 포함.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const s = snap(ctx);
        return { asOf: asOf(ctx), period: s.brief.period.label, delivery: s.brief.delivery, counts: s.brief.counts, markdown: s.brief.markdown };
      },
    },
    {
      name: 'watch_external',
      description: '외부 변수: 시즌 캘린더(이사 성수기 · 혼인 시즌 · 대형 쇼핑 행사는 가설, 공휴일, 자사 프로모션)와 D-day · 사전 준비, 브랜드 검색량 전일 vs 4주 동요일 비교, 구매 의도별 노출 추이를 반환한다.',
      inputSchema: { type: 'object', properties: { horizonDays: { type: 'number', description: '캘린더 조회 기간 (기본 120일)' } } },
      execute: (input) => {
        const s = snap(ctx);
        const h = Math.max(7, Math.min(365, Number(input.horizonDays) || 120));
        const y = s.trend.yesterday;
        return {
          asOf: asOf(ctx),
          calendar: s.calendar.filter((c) => c.dday <= h).slice(0, 12).map((c) => ({ kind: c.kindLabel, label: c.label, start: c.start, end: c.end, dday: c.dday, active: c.active, prep: c.prep, basis: c.basis })),
          brandSearch: y ? { date: y.date, volume: y.volume, base4wSameWeekday: roundN(y.base, 0), deltaPct: roundN(y.deltaPct, 1), threshold: `±${s.cfg.searchShiftPct}%`, last7VsPrev28Pct: roundN(s.trend.last7Delta, 1), dataKind: 'TEST DATA' } : null,
          intentExposure: s.exposure.map((e) => ({ intent: e.name, impressions14d: e.last, deltaPct: roundN(e.delta, 1), newKeywords: e.newKeywords })),
        };
      },
    },
    {
      name: 'watch_request_test',
      description: '실행안 단계의 매체 변동 이벤트를 MILDO Lab 소액 테스트로 등록 요청한다. ChangeRequest(kind test)를 승인 대기(pending)로만 만들고 실제 집행은 사람이 승인한다. 진단 보류 · 단계 불일치면 이유를 반환한다.',
      inputSchema: { type: 'object', properties: { eventId: { type: 'string', description: 'watch_changes의 이벤트 id' } }, required: ['eventId'] },
      execute: (input) => {
        const s = snap(ctx);
        const ev = s.events.find((e) => e.id === input.eventId);
        if (!ev) return { ok: false, reason: `이벤트 ${String(input.eventId)} 없음 — watch_changes로 id 확인` };
        if (ev.testChange) return { ok: false, reason: `이미 등록 요청됨 (${ev.testChange.id} · ${ev.testChange.status})` };
        if (ev.closed) return { ok: false, reason: '관찰 종료된 이벤트' };
        if (ev.stage !== 'plan') return { ok: false, reason: `현재 단계 '${STAGE_LABEL[ev.stage]}' — 실행안 확정 후 등록 (p.24 파이프라인 순서)` };
        if (ev.next.disabled) return { ok: false, reason: ev.next.disabled };
        const c = ctx.actions.addChange(testChangePayload(ev, ctx.state.role));
        return { ok: true, changeId: c.id, status: c.status, approver: ev.design.approverLabel, approverBasis: ev.design.approverBasis, test: `${ev.design.arms} · 일 ${ev.design.perDay}원 × ${ev.design.days}일`, note: '승인 · 반영은 MILDO Flow에서 사람이 처리' };
      },
    },
  ];
  },
  briefs: [
    { id: 'watch-changes', match: /매체 변동|변동 감지|신규 상품|지면 변화|노출 로직|업데이트 노트|선제 트래킹|MILDO Watch|와치|Watch/i, build: (ctx) => changesBrief(snap(ctx)) },
    { id: 'watch-competitors', match: /경쟁사|경쟁 6|아카이브|아카이빙|지면 침투|브랜드 지면|가격 변경|베스트슬립|웰퍼니처|퀵슬립|올라인|지누스|휴도/, build: (ctx) => competitorsBrief(snap(ctx)) },
    { id: 'watch-season', match: /시즌|이사 철|이사 성수기|혼인|혼수|외부 변수|검색 트렌드|공휴일|캘린더/, build: (ctx) => seasonBrief(snap(ctx)) },
    { id: 'watch-weekly', match: /주간 (인사이트 )?브리프|인사이트 브리프|이번 주 감지|인사이트 루프/, build: (ctx) => weeklyBriefOf(snap(ctx)) },
  ],
};
