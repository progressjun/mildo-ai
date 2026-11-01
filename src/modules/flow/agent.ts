/**
 * MILDO Flow — MILDO Agent 도구 + 오프라인 브리프.
 * 읽기 도구는 state.changes · state.incidents · state.data를 화면과 같은 엔진 함수로 계산한다.
 * 상태를 바꾸는 도구(flow_request_change)는 ChangeRequest를 pending으로만 만든다 (승인 · 반영은 사람이).
 */
import type { AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import type { ChangeRequest, MediaId } from '@/core/types';
import { MEDIA_IDS } from '@/data/constants';
import type { ModuleAgentKit, ToolContext } from '../types';
import { makeClock } from './clock';
import { REQUEST_TYPES, STATUS_META, type RequestType } from './data';
import {
  APPROVER_LABEL, EMPTY_DRAFT, bulkChangeAlerts, canAct, checkAllPromotions, decisionOf, executionCheck, flowSummary, fmtStamp, fmtValue, isSeed, leadState,
  moduleLabel, opsBrief, opsCases, opsEvents, pendingBrief, planRequest, promoCheckBrief, promoPhase, promoReport, roleScopeLabel, seedChanges, slaText,
  STAGE_LABEL, stageCounts, type RequestDraft,
} from './engine';

const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : null);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const ROLES = ['담당 AE', 'PM', '수면밀도'] as const;
const OPEN_STATUSES: ChangeRequest['status'][] = ['pending', 'approved', 'held'];

function clockOf(ctx: ToolContext) {
  return makeClock(ctx.state.data.generatedAt);
}
/** 시연 이력이 스토어에 아직 없으면 (MILDO Flow 화면을 열기 전) 건수를 알려 준다 */
function seedNote(ctx: ToolContext): string | null {
  const missing = seedChanges(ctx.state.data).filter((s) => !ctx.state.changes.some((c) => c.id === s.id)).length;
  return missing ? `시연용 이력 ${missing}건은 MILDO Flow 화면을 열면 불러옵니다 (현재 집계에 미포함 · TEST DATA)` : null;
}
function pickPromo(ctx: ToolContext, promoId?: unknown) {
  const d = ctx.state.data;
  const list = d.promotions ?? [];
  const q = typeof promoId === 'string' ? promoId.trim() : '';
  if (q) return list.find((p) => p.id === q) ?? list.find((p) => p.name.includes(q)) ?? null;
  return list.find((p) => promoPhase(p, d.today) === 'live') ?? list[0] ?? null;
}

function changeView(ctx: ToolContext, c: ChangeRequest) {
  const clk = clockOf(ctx);
  const l = leadState(c, clk.nowMs, clk.toMs);
  const dec = decisionOf(c);
  const ex = c.status === 'approved' ? executionCheck(ctx.state.data, ctx.state.changes, ctx.state.incidents, c) : null;
  return {
    id: c.id,
    상태: STATUS_META[c.status]?.label ?? c.status,
    모듈: moduleLabel(c.module),
    대상: c.target,
    변경: `${fmtValue(c, c.before)} → ${fmtValue(c, c.after)}`,
    변경pct: r1(c.changePct ?? NaN),
    승인주체: APPROVER_LABEL[c.approver],
    현재역할처리가능: canAct(ctx.state.role, c.approver).ok,
    결정유형: `${dec.row.type} · ${dec.row.decider} · ${dec.row.lead}`,
    소요: l.text,
    기준초과: l.overdue,
    요청자: c.requestedBy,
    요청시각: fmtStamp(l.createdMs),
    사유: c.reason.slice(0, 220),
    실행점검: ex ? { 통과: ex.ok, 보류사유: ex.blocks, 주의: ex.warnings } : undefined,
    마지막이력: c.history.length ? `${c.history[c.history.length - 1].action} · ${c.history[c.history.length - 1].by}${c.history[c.history.length - 1].note ? ` · ${String(c.history[c.history.length - 1].note).slice(0, 120)}` : ''}` : null,
    시연이력: isSeed(c) || undefined,
  };
}

/** 대상 이름 → 캠페인 · 키워드 id (정확히 일치 우선, 없으면 포함) */
function resolveTarget(ctx: ToolContext, type: RequestType, target: string): string {
  const d = ctx.state.data;
  const t = target.trim();
  if (!t) return '';
  const kw = d.keywords.find((k) => k.text === t) ?? d.keywords.find((k) => k.text.includes(t));
  const cmp = d.campaigns.find((c) => c.name === t) ?? d.campaigns.find((c) => c.name.includes(t));
  if (type === 'bid') return kw?.id ?? '';
  if (type === 'budget') return cmp?.id ?? '';
  if (type === 'onoff') return (d.keywords.find((k) => k.text === t) ?? (cmp ? undefined : kw))?.id ?? cmp?.id ?? '';
  return '';
}

function pendingTool(ctx: ToolContext): AgentTool {
  return {
    name: 'flow_pending',
    description: 'MILDO Flow 요청 · 승인 · 반영 이력에서 진행 중 요청(승인 대기 · 반영 대기 · 보류)과 상태별 건수, 현재 역할 기준 처리 목록, 결정 소요(p.53 기준 충족 여부), 반영 전 실행 점검 결과를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: [...ROLES], description: '이 역할 기준으로 처리할 것을 계산 (기본: 현재 사용자 역할)' },
        status: { type: 'string', enum: ['open', 'pending', 'approved', 'held', 'all'], description: '목록 상태 필터 (기본 open = 승인 대기 · 반영 대기 · 보류)' },
        limit: { type: 'number', description: '최대 건수 (기본 20)' },
      },
    },
    execute: (inp) => {
      const clk = clockOf(ctx);
      const role = ROLES.includes(inp.role as (typeof ROLES)[number]) ? String(inp.role) : ctx.state.role;
      const status = String(inp.status ?? 'open');
      const limit = Math.max(1, Math.min(40, Number(inp.limit) || 20));
      const changes = ctx.state.changes ?? [];
      const s = flowSummary(changes, role, clk.nowMs, clk.toMs, ctx.state.data.today);
      const list = changes
        .filter((c) => (status === 'all' ? true : status === 'open' ? OPEN_STATUSES.includes(c.status) : c.status === status))
        .sort((a, b) => (clk.toMs(b.createdAt) || 0) - (clk.toMs(a.createdAt) || 0))
        .slice(0, limit);
      return {
        기준: { 기준시각: fmtStamp(clk.nowMs), 역할: role, 승인범위: roleScopeLabel(role), 권한규칙: '담당 AE는 AE건, PM은 AE · PM건, 수면밀도는 전부 (p.53)', 출처: 'TEST DATA · 이번 세션 + 시연 이력' },
        건수: Object.fromEntries(Object.entries(s.byStatus).map(([k, v]) => [STATUS_META[k as ChangeRequest['status']].label, v])),
        내가처리할것: { 승인: s.queue.approve.length, 반영: s.queue.apply.length, 보류판단: s.queue.held.length, 권한밖승인대기: s.queue.blocked.map((c) => `${c.target} → ${APPROVER_LABEL[c.approver]}`) },
        결정소요: { 결정건수: s.decided, 평균분: r0(s.avgDecisionMin), 기준충족률: r3(s.metRate), 기준초과대기: s.overdue.map((c) => c.target) },
        대량변경감지: bulkChangeAlerts(changes, ctx.state.data.today, ctx.state.incidents).map((b) => ({ 제목: b.title, 근거: b.basis, 관련요청수: b.related.length, Alert이슈적재: b.logged, 기준: 'MILDO Alert 대량 변경 실수 (p.45)' })),
        목록: list.map((c) => changeView(ctx, c)),
        비고: seedNote(ctx),
      };
    },
  };
}

function promoCheckTool(ctx: ToolContext): AgentTool {
  return {
    name: 'flow_promo_check',
    description: '프로모션별 오픈 전 자동 점검(일정 · 가격 · 소재 · 랜딩 · 예산 · 재고 · 결제 잔액) 결과를 반환합니다. 프로모션마다 판정(오픈 가능 · 조치 후 오픈 · 오픈 보류 등)과 기준, 실패 · 주의 항목의 근거 · 조치 · 승인 주체 · 조치 요청 진행 상태를 포함합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        promoId: { type: 'string', description: '프로모션 id 또는 이름 일부 (생략 시 전체)' },
        includePass: { type: 'boolean', description: '통과 항목까지 포함 (기본 false)' },
      },
    },
    execute: (inp) => {
      const d = ctx.state.data;
      const target = inp.promoId ? pickPromo(ctx, inp.promoId) : null;
      if (inp.promoId && !target) return { error: '프로모션을 찾지 못했습니다', 목록: (d.promotions ?? []).map((p) => `${p.id} ${p.name}`) };
      const checks = checkAllPromotions(d, { changes: ctx.state.changes, incidents: ctx.state.incidents }).filter((c) => !target || c.promotion.id === target.id);
      return {
        기준: { 판정규칙: '실패 0건 = 오픈 가능 · 주의는 담당자 확인', 가격대조: '판매가 × (1 − 할인율) · 허용 오차 ±1%', 출처: '제안서 p.31 · p.45 · p.44 · TEST DATA' },
        프로모션: checks.map((c) => ({
          id: c.promotion.id, 이름: c.promotion.name, 채널: c.channelName, 단계: c.phaseLabel,
          기간: `${c.promotion.start} ~ ${c.promotion.end}`, 할인율: c.promotion.discountRate,
          D: c.phase === 'pre' ? `오픈 D-${c.dday}` : c.phase === 'live' ? `종료 D-${c.dday}` : `종료 후 ${c.dday}일`,
          판정: c.verdict.label, 판정근거: c.verdict.basis,
          항목군: c.byGroup,
          항목: c.items.filter((i) => inp.includePass || i.level === 'fail' || i.level === 'warn').map((i) => ({
            항목군: i.group, 항목: i.label, 결과: i.level, 내용: i.detail.slice(0, 260), 기준: i.basis, 조치: i.action,
            조치요청: i.fix ? { 라벨: i.fix.label, 승인주체: APPROVER_LABEL[i.fix.input.approver], 진행: i.fixState ? STATUS_META[i.fixState.status].label : '미요청' } : undefined,
          })),
        })),
      };
    },
  };
}

function promoReportTool(ctx: ToolContext): AgentTool {
  return {
    name: 'flow_promo_report',
    description: '프로모션 기간 vs 직전 동일 기간의 채널 매출 · 주문 · 객단가 · 관련 매체 광고비 · ROAS · 광고비 대비 실매출 · 판매 채널 비중을 계산한 프로모션 리포트(마크다운 본문 포함)와 다음 기획에 즉시 반영할 항목을 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        promoId: { type: 'string', description: '프로모션 id 또는 이름 일부 (생략 시 진행 중 프로모션)' },
        includeMarkdown: { type: 'boolean', description: '마크다운 본문 포함 (기본 true)' },
      },
    },
    execute: (inp) => {
      const p = pickPromo(ctx, inp.promoId);
      if (!p) return { error: '프로모션이 없습니다' };
      const r = promoReport(ctx.state.data, p, { changes: ctx.state.changes, incidents: ctx.state.incidents });
      return {
        프로모션: { id: p.id, 이름: p.name, 채널: r.channelName, 단계: promoPhase(p, ctx.state.data.today), 할인율: p.discountRate },
        기간: r.period, 직전동기간: r.prev, 집계가능: r.ready,
        지표: r.rows.map((x) => ({ 지표: x.label, 기간: x.unit === 'pct' || x.unit === 'x' || x.unit === 'ratio' ? r3(x.cur) : r0(x.cur), 직전: x.unit === 'pct' || x.unit === 'x' || x.unit === 'ratio' ? r3(x.prev) : r0(x.prev), 증감pct: x.unit === 'ratio' ? undefined : r1(x.delta), 증감pp: x.unit === 'ratio' ? r1(x.pp ?? NaN) : undefined, 단위: x.unit })),
        채널비중: r.mix.map((m) => ({ 채널: m.name, 기획전채널: m.isPromo, 기간비중: r3(m.curShare), 직전비중: r3(m.prevShare), 비중변화pp: r1(m.shareDeltaPp), 매출증감pct: r1(m.delta) })),
        다음기획반영: r.next,
        리포트: inp.includeMarkdown === false ? undefined : r.markdown.slice(0, 9000),
        출처: 'TEST DATA (시연용 · 실제 성과 아님)',
      };
    },
  };
}

function timelineTool(ctx: ToolContext): AgentTool {
  return {
    name: 'flow_timeline',
    description: '운영 프로세스(감지 → 배정 → 조치 → 보고) 기준으로 MILDO Alert 이슈별 현재 단계 · 단계별 시각 · 연결된 변경 요청과 최근 활동 피드(이슈 타임라인 + 요청 · 승인 이력)를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '최근 활동 최대 건수 (기본 15)' },
        includeDone: { type: 'boolean', description: '완료 이슈 포함 (기본 false)' },
      },
    },
    execute: (inp) => {
      const clk = clockOf(ctx);
      const d = ctx.state.data;
      const cases = opsCases(d, ctx.state.incidents, ctx.state.changes, clk.toMs);
      const sc = stageCounts(cases);
      const limit = Math.max(1, Math.min(40, Number(inp.limit) || 15));
      const events = opsEvents(ctx.state.incidents, ctx.state.changes, clk.toMs).slice(0, limit);
      return {
        단계별: { 감지: cases.length, 배정대기: sc.assign, 조치: sc.action, 보고: sc.report, 완료: sc.done },
        이슈: cases.filter((c) => inp.includeDone || c.current !== 'done').slice(0, 15).map((c) => ({
          id: c.incident.id, 등급: c.incident.severity, 이슈: c.incident.title, 현재단계: c.current === 'done' ? '완료' : STAGE_LABEL[c.current],
          단계: c.stages.map((s) => `${STAGE_LABEL[s.stage]} ${s.done ? fmtStamp(s.atMs ?? NaN) : '대기'} · ${s.note.slice(0, 100)}`),
          연결요청: c.linked.map((l) => `${l.change.target} (${STATUS_META[l.change.status].label}${l.inferred ? ' · 관련 추정' : ''})`),
          다음: c.next?.label ?? null,
        })),
        최근활동: events.map((e) => ({ 시각: fmtStamp(e.atMs), 단계: STAGE_LABEL[e.stage], 출처: e.source === 'incident' ? '이슈' : '요청', 내용: `${e.action} · ${e.by}`, 대상: e.title.slice(0, 120) })),
        기준: `SLA ${slaText()} (p.49) · TEST DATA`,
        비고: seedNote(ctx),
      };
    },
  };
}

function requestTool(ctx: ToolContext): AgentTool {
  return {
    name: 'flow_request_change',
    description: '예산 · 세팅 변경 요청을 만들고 승인 주체를 자동 결정합니다(위임 범위 p.15 · 결정 유형 p.53). 결과는 승인 대기(pending) ChangeRequest이며 반영은 승인 주체가 승인한 뒤 사람이 실행합니다. dryRun=true면 만들지 않고 승인 주체 · 검증 결과만 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: REQUEST_TYPES.map((t) => t.id), description: 'budget 일 예산 · bid 입찰가 · onoff ON/OFF · new_campaign 신규 캠페인 · creative 소재 · 랜딩 · keyword 키워드 추가/제외 · alert_rule 알림 기준 · strategy 전략 방향' },
        target: { type: 'string', description: '캠페인 이름 · 키워드 · 소재 등 대상' },
        pct: { type: 'number', description: '변경 폭(%) — budget · bid' },
        toStatus: { type: 'string', enum: ['on', 'off'], description: 'onoff 대상 상태' },
        media: { type: 'string', enum: [...MEDIA_IDS], description: '매체 (new_campaign 필수)' },
        before: { type: 'string', description: '변경 전 값 (자유 입력 유형)' },
        after: { type: 'string', description: '변경 후 값 · 문구 · 신규 캠페인 일 예산(원)' },
        keywordMode: { type: 'string', enum: ['add', 'exclude'], description: 'keyword 유형: 테스트 그룹 등록 / 제외' },
        promoId: { type: 'string', description: '연결 프로모션 id (선택)' },
        reason: { type: 'string', description: '사유 8자 이상 (누가 · 왜 기록)' },
        dryRun: { type: 'boolean', description: 'true면 요청을 만들지 않음' },
      },
      required: ['type', 'reason'],
    },
    execute: (inp) => {
      const type = REQUEST_TYPES.some((t) => t.id === inp.type) ? (inp.type as RequestType) : null;
      if (!type) return { error: '알 수 없는 요청 유형', 유형: REQUEST_TYPES.map((t) => `${t.id} ${t.label}`) };
      const target = String(inp.target ?? '');
      const d = ctx.state.data;
      const cmp = d.campaigns.find((c) => c.id === resolveTarget(ctx, type, target));
      const media = (MEDIA_IDS as string[]).includes(String(inp.media)) ? (inp.media as MediaId) : cmp?.media ?? '';
      const draft: RequestDraft = {
        ...EMPTY_DRAFT,
        type,
        media,
        targetId: resolveTarget(ctx, type, target),
        targetText: target,
        pct: Number.isFinite(Number(inp.pct)) ? Number(inp.pct) : EMPTY_DRAFT.pct,
        toStatus: inp.toStatus === 'on' ? 'on' : 'off',
        beforeText: String(inp.before ?? ''),
        afterText: String(inp.after ?? ''),
        keywordMode: inp.keywordMode === 'exclude' ? 'exclude' : 'add',
        reason: String(inp.reason ?? ''),
        promoId: inp.promoId ? String(inp.promoId) : undefined,
      };
      const plan = planRequest(d, ctx.state.changes, ctx.state.incidents, draft, 'MILDO Agent');
      const out = {
        승인주체: APPROVER_LABEL[plan.route.approver], 근거: plan.route.basis, 대상: plan.targetLabel,
        변경: `${fmtValue({ kind: REQUEST_TYPES.find((t) => t.id === type)!.kind }, plan.before)} → ${fmtValue({ kind: REQUEST_TYPES.find((t) => t.id === type)!.kind }, plan.after)}`,
        오류: plan.errors, 확인필요: plan.warnings,
      };
      if (!plan.ok || !plan.input) return { 생성: false, ...out };
      if (inp.dryRun) return { 생성: false, 미리보기: true, ...out };
      const c = ctx.actions.addChange({ ...plan.input, requestedBy: 'MILDO Agent' });
      return { 생성: true, changeId: c.id, 상태: '승인 대기', ...out, 다음: `${APPROVER_LABEL[c.approver]} 승인 후 MILDO Flow에서 반영` };
    },
  };
}

/* ---------------- 오프라인 브리프 ---------------- */

function promoReportBrief(ctx: ToolContext): Brief {
  const p = pickPromo(ctx);
  if (!p) {
    return { title: '프로모션 리포트', facts: ['등록된 프로모션이 없습니다 (data.promotions).'], patterns: [], interpretation: [], conditions: [], counter: [], actions: [] };
  }
  return promoReport(ctx.state.data, p, { changes: ctx.state.changes, incidents: ctx.state.incidents }).brief;
}
function withSeedNote(ctx: ToolContext, b: Brief): Brief {
  const note = seedNote(ctx);
  return note ? { ...b, conditions: [...b.conditions, `${note}.`] } : b;
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [pendingTool(ctx), promoCheckTool(ctx), promoReportTool(ctx), timelineTool(ctx), requestTool(ctx)],
  briefs: [
    {
      id: 'flow_pending',
      match: /승인\s?대기|승인할|결재|반영\s?대기|롤백|보류|요청\s?(현황|목록|이력)|변경\s?이력|내가\s?(승인|처리)|MILDO Flow|플로우/i,
      build: (ctx) => {
        const clk = clockOf(ctx);
        return withSeedNote(ctx, pendingBrief(ctx.state.data, ctx.state.changes, ctx.state.incidents, ctx.state.role, clk.nowMs, clk.toMs));
      },
    },
    {
      id: 'flow_promo_check',
      match: /오픈\s?전|체크리스트|기획전\s?(점검|준비|오픈)|프로모션\s?(점검|준비|오픈|체크)|가격\s?불일치|품절/i,
      build: (ctx) => promoCheckBrief(ctx.state.data, ctx.state.changes, ctx.state.incidents),
    },
    {
      id: 'flow_promo_report',
      match: /프로모션\s?(리포트|결과|성과|효과)|기획전\s?(리포트|결과|성과|효과)|다음\s?기획|잠식/i,
      build: (ctx) => promoReportBrief(ctx),
    },
    {
      id: 'flow_ops',
      match: /운영\s?프로세스|감지.{0,6}배정|배정.{0,6}조치|조치.{0,6}보고|운영\s?타임라인|활동\s?피드/i,
      build: (ctx) => {
        const clk = clockOf(ctx);
        return withSeedNote(ctx, opsBrief(ctx.state.data, ctx.state.incidents, ctx.state.changes, clk.toMs));
      },
    },
  ],
};
