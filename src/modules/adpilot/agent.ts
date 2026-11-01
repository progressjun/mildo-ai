/**
 * AD Pilot · GFA Control v1 — MILDO Agent 도구 + 오프라인 브리프.
 * 상태를 바꾸는 도구는 ChangeRequest 를 pending 으로만 만든다 (반영은 사람이 승인 후).
 */
import type { AgentTool } from '@/ai/claude';
import type { ModuleAgentKit, ToolContext } from '../types';
import { APPROVER_LABEL, AUTO_CHARGE_LABEL, adpilotBrief, budgetBrief, canApprove, clock, diagnoseKeywords, effectiveBids, effectiveKeywordStatus,
  generateBidProposals, gfaBrief, gfaOverview, holdsBrief, latestChangeFor, officialConfig, paceCampaigns, proposalChangeInput,
  routeGfaChange, simulateBidChange, verifyBidChange, bidChangeInput, VERDICT_META, type GfaChangeType } from './engine';

const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : null);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function context(ctx: ToolContext) {
  const cfg = officialConfig(ctx.state.changes);
  const proposals = generateBidProposals(ctx.state.data, cfg);
  return { cfg, proposals };
}

function statusOf(ctx: ToolContext, module: string, targetId: string, kind?: string) {
  const c = latestChangeFor(ctx.state.changes, module, targetId, kind as never);
  return c ? { changeId: c.id, status: c.status } : null;
}

const STATUS_KO: Record<string, string> = { pending: '승인 대기', approved: '승인', applied: '반영', rejected: '반려', rolled_back: '롤백', held: '보류' };

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'adpilot_proposals',
      description: 'AD Pilot 입찰 · 예산 조정 후보 목록을 반환합니다. 후보마다 규칙(p.14), 현재 → 제안 값, 판정 근거(목표 대비 %), 승인 주체, 진행 상태, 보류 사유 · 원인 후보를 포함합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['all', 'bid_up', 'bid_down', 'budget_shift', 'test_candidate', 'hold'], description: '조치 유형 필터 (기본 all)' },
          limit: { type: 'number', description: '최대 건수 (기본 30)' },
        },
      },
      execute: (inp) => {
        const { cfg, proposals } = context(ctx);
        const action = String(inp.action ?? 'all');
        const limit = Math.max(1, Math.min(60, Number(inp.limit) || 30));
        const list = proposals.filter((p) => action === 'all' || p.action === action).slice(0, limit);
        return {
          기준: { 목표ROAS: cfg.targetRoas, 브랜드목표ROAS: cfg.brandTargetRoas, 일조정폭상한pct: cfg.dailyChangeCapPct, 급변보류pct: cfg.anomalyHoldPct, 출처: '제안서 p.14 · TEST DATA' },
          건수: { 전체: proposals.length, 상향: proposals.filter((p) => p.action === 'bid_up').length, 하향: proposals.filter((p) => p.action === 'bid_down').length, 예산: proposals.filter((p) => p.action === 'budget_shift').length, 테스트후보: proposals.filter((p) => p.action === 'test_candidate').length, 보류: proposals.filter((p) => p.action === 'hold').length },
          후보: list.map((p) => {
            const st = statusOf(ctx, 'adpilot', p.changeTargetId);
            return {
              proposalId: p.id, 대상: p.keyword, 규칙: p.rule, 조치: p.action, 현재: r0(p.before), 제안: r0(p.after), 변경pct: r1(p.changePct),
              근거: p.basis, 예상: p.expected, 승인주체: APPROVER_LABEL[p.approver], 상태: st ? STATUS_KO[st.status] : '후보',
              원인후보: p.causes?.slice(0, 3).map((c) => `${c.cause}: ${c.evidence}`),
            };
          }),
        };
      },
    },
    {
      name: 'adpilot_diagnose',
      description: '네이버 SA 키워드별 판정(상향 · 하향 · 보류 · 유지 · 관찰 · 테스트)과 근거 수치(ROAS · 목표 대비 % · 노출 손실 · 순위 · 전환 · 최근 3일 CPC 변화)를 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '키워드 일부 문자열 (선택)' },
          intent: { type: 'string', enum: ['brand', 'generic', 'problem', 'compare', 'life'], description: '구매 의도 (선택)' },
        },
      },
      execute: (inp) => {
        const cfg = officialConfig(ctx.state.changes);
        const bids = effectiveBids(ctx.state.data, ctx.state.changes);
        const rows = diagnoseKeywords(ctx.state.data, { ...cfg, currentBids: bids }, effectiveKeywordStatus(ctx.state.changes))
          .filter((d) => (!inp.keyword || d.text.includes(String(inp.keyword))) && (!inp.intent || d.intent === inp.intent));
        return rows.slice(0, 40).map((d) => ({
          키워드: d.text, 의도: d.intent, 판정: VERDICT_META[d.verdict].label, 근거: d.basis, 메모: d.note,
          ROAS: r0(d.roas), 목표대비pct: r0(d.ratioPct), 직전목표대비pct: r0(d.prevRatioPct), 노출손실: r1(d.lost * 100), 순위: d.rank, 전환14일: r1(d.conversions),
          CPC3일변화pct: r0(d.anomaly.cpcDelta), 현재입찰: d.bid, 최대입찰: d.maxBid, 제안입찰: d.proposedBid,
        }));
      },
    },
    {
      name: 'adpilot_simulate',
      description: '키워드 입찰 변경의 예상 효과(일 기준 클릭 · 비용 · 전환 · 매출 · 증분 ROAS)를 탄력성 가정으로 계산하고 SAFETY 검증 결과(상한 · 최대가 · 급변 · 품절)를 반환합니다. 가정이며 실측이 아닙니다.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '키워드 (정확히 또는 일부)' },
          bid: { type: 'number', description: '새 입찰가(원). 없으면 changePct 사용' },
          changePct: { type: 'number', description: '현재 대비 변경 폭(%)' },
        },
        required: ['keyword'],
      },
      execute: (inp) => {
        const k = ctx.state.data.keywords.find((x) => x.text === inp.keyword) ?? ctx.state.data.keywords.find((x) => x.text.includes(String(inp.keyword ?? '')));
        if (!k) return { error: '키워드를 찾지 못했습니다' };
        const cfg = officialConfig(ctx.state.changes);
        const bids = effectiveBids(ctx.state.data, ctx.state.changes);
        const current = bids[k.id] ?? k.bid;
        const after = Number.isFinite(Number(inp.bid)) && Number(inp.bid) > 0 ? Number(inp.bid) : Math.round((current * (1 + (Number(inp.changePct) || 10) / 100)) / 10) * 10;
        const v = verifyBidChange(ctx.state.data, k, after, { ...cfg, currentBids: bids });
        const s = simulateBidChange(k, current, after, cfg);
        return {
          키워드: k.text, 현재입찰: current, 새입찰: after, 변경pct: v.changePct, 시작가대비pct: v.startPct,
          가정: s.assumptions, 기준일: { 클릭: r1(s.base.clicks), 비용: r0(s.base.cost), 전환: r2(s.base.conversions), ROAS: r0(s.base.roas) },
          예상일: { 클릭: r1(s.projected.clicks), 비용: r0(s.projected.cost), 전환: r2(s.projected.conversions), ROAS: r0(s.projected.roas) },
          증분ROAS: r0(s.incrementalRoas), 검증: v.items.map((i) => `${i.label}: ${i.level === 'pass' ? '통과' : i.level === 'warn' ? '주의' : '차단'} (${i.detail})`),
          차단: v.blocked, 승인주체: APPROVER_LABEL[v.route.approver], 출처: 'TEST DATA · 탄력성 가정',
        };
      },
    },
    {
      name: 'adpilot_request_change',
      description: 'AD Pilot 조정 후보(proposalId) 또는 키워드 · 새 입찰가로 승인 요청을 만듭니다(ChangeRequest pending). 실제 반영은 승인 주체가 승인한 뒤 사람이 실행합니다. 보류 후보와 SAFETY 차단 건은 만들지 않습니다.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'adpilot_proposals 의 proposalId' },
          keyword: { type: 'string', description: '수동 입찰 변경 시 키워드' },
          bid: { type: 'number', description: '수동 입찰 변경 시 새 입찰가(원)' },
          note: { type: 'string', description: '요청 사유 메모' },
        },
      },
      execute: (inp) => {
        const { cfg, proposals } = context(ctx);
        if (inp.proposalId) {
          const p = proposals.find((x) => x.id === inp.proposalId);
          if (!p) return { error: '해당 proposalId 후보가 없습니다. adpilot_proposals 로 다시 조회하세요.' };
          const existing = latestChangeFor(ctx.state.changes, 'adpilot', p.changeTargetId);
          if (existing && ['pending', 'approved', 'applied'].includes(existing.status)) return { 결과: '이미 요청됨', changeId: existing.id, 상태: STATUS_KO[existing.status] };
          const input = proposalChangeInput(p, 'MILDO Agent');
          if (!input) return { error: `보류 후보는 승인 요청 대상이 아닙니다 — ${p.basis}` };
          const c = ctx.actions.addChange(input);
          return { 결과: '승인 요청 생성 (pending)', changeId: c.id, 대상: c.target, 변경: `${c.before} → ${c.after}`, 승인주체: APPROVER_LABEL[c.approver], 현재역할승인가능: canApprove(ctx.state.role, c.approver).ok };
        }
        const k = ctx.state.data.keywords.find((x) => x.text === inp.keyword);
        const bid = Number(inp.bid);
        if (!k || !Number.isFinite(bid)) return { error: 'proposalId 또는 keyword + bid 가 필요합니다' };
        const bids = effectiveBids(ctx.state.data, ctx.state.changes);
        const current = bids[k.id] ?? k.bid;
        const v = verifyBidChange(ctx.state.data, k, bid, { ...cfg, currentBids: bids });
        if (v.blocked) return { error: 'SAFETY 검증 차단', 사유: v.items.filter((i) => i.level === 'block').map((i) => `${i.label}: ${i.detail}`) };
        const c = ctx.actions.addChange(bidChangeInput(k, current, bid, v, 'MILDO Agent', String(inp.note ?? '')));
        return { 결과: '승인 요청 생성 (pending)', changeId: c.id, 대상: c.target, 변경: `${current} → ${bid}`, 승인주체: APPROVER_LABEL[c.approver] };
      },
    },
    {
      name: 'gfa_route_change',
      description: 'GFA 변경 유형(budget · adgroup · new_campaign · status_check)과 일 예산 변경 폭(%)으로 위임 범위(p.15, 예시 · 계약 시 확정)상 승인 주체를 계산하고, 현재 역할이 승인할 수 있는지 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['budget', 'adgroup', 'new_campaign', 'status_check'] },
          pct: { type: 'number', description: '일 예산 변경 폭(%) — budget 일 때' },
        },
        required: ['type'],
      },
      execute: (inp) => {
        const r = routeGfaChange(String(inp.type ?? 'budget') as GfaChangeType, Number(inp.pct));
        const p = canApprove(ctx.state.role, r.approver);
        return { 승인주체: r.label, 위임범위: r.range, 근거: r.reason, 현재역할: ctx.state.role, 현재역할승인가능: p.ok, 설명: p.reason, 출처: '제안서 p.15 (예시 · 계약 시 확정)' };
      },
    },
    {
      name: 'gfa_check',
      description: 'GFA 다계정 예산 · 상태 점검 결과를 반환합니다: 계정별 잔액 · 일 평균 소진 · 잔액 소진 예상 시점 · 자동충전, 캠페인별 소진 속도 · 예상 마감 · 광고그룹 상태 · 이슈.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const cfg = officialConfig(ctx.state.changes);
        return gfaOverview(ctx.state.data, ctx.state.changes, cfg).map((v) => ({
          계정: v.account.name, DEMO가정: v.demo, 잔액: v.account.balance, 일평균소진: v.account.avgDailySpend, 잔액일수: Number.isFinite(v.runwayDays) ? r1(v.runwayDays) : null,
          잔액소진예상: v.exhaustAt ? `${v.exhaustAt.date} ${v.exhaustAt.hour}시경` : null, 자동충전: AUTO_CHARGE_LABEL[v.account.autoCharge], 점검: v.level,
          이슈: v.issues.map((i) => `${i.text} (${i.basis})`),
          캠페인: v.campaigns.map((c) => ({ 이름: c.campaign.name, 상태: c.campaign.status, 일예산: c.campaign.dailyBudget, 오늘소진: c.campaign.spentToday, 예상마감: clock(c.pace.curveExhaustHour ?? c.pace.linearExhaustHour), 광고그룹OFF: c.adGroups.filter((g) => g.status === 'off').length, 이슈: c.issues.map((i) => i.text) })),
        }));
      },
    },
    {
      name: 'adpilot_pacing',
      description: '캠페인별 일 예산 소진 속도와 예상 마감 시각을 선형 추정(campaignPacing)과 시간대 가중 추정(최근 28일 시간대 광고비 비중) 두 가지로 반환합니다.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => paceCampaigns(ctx.state.data, ctx.state.data.campaigns, officialConfig(ctx.state.changes)).map((p) => ({
        캠페인: p.name, 매체: p.media, 일예산: p.dailyBudget, 오늘소진: p.spentToday, 소진pct: r0(p.pacePct), 선형마감: clock(p.linearExhaustHour), 가중마감: clock(p.curveExhaustHour), 예상수요배수: r1(p.projectedRatio * 100), 조기소진: p.earlyExhaust,
      })),
    },
  ],
  briefs: [
    { id: 'adpilot-holds', match: /(보류|급변|데이터 이상|수집 이상|이상 징후|매트리스 추천|CPC 급|전환 추적|추적 단절|전환 0)/, build: (ctx) => holdsBrief(ctx.state.data, officialConfig(ctx.state.changes)) },
    { id: 'adpilot-budget', match: /(조기 소진|소진|재배분|일 예산|페이싱)/, build: (ctx) => budgetBrief(ctx.state.data, officialConfig(ctx.state.changes)) },
    { id: 'gfa-control', match: /(GFA|위임|승인 주체|라우팅|잔액|자동충전)/i, build: (ctx) => gfaBrief(ctx.state.data, ctx.state.changes, officialConfig(ctx.state.changes)) },
    { id: 'adpilot-proposals', match: /(입찰|AD ?Pilot|애드파일럿|조정 후보|키워드 (진단|효율|판정)|bid)/i, build: (ctx) => adpilotBrief(ctx.state.data, ctx.state.changes, officialConfig(ctx.state.changes)) },
  ],
};
