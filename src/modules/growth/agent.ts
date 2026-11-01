/**
 * 매출 성장 고도화 — MILDO Agent 도구 + 오프라인 브리프 (제안서 p.30–42).
 * 결과는 작은 plain JSON (숫자 반올림). 상태를 바꾸는 도구는 ChangeRequest를 pending으로만 만든다.
 */
import type { AgentTool } from '@/ai/claude';
import type { MediaId } from '@/core/types';
import { MEDIA, MEDIA_IDS, NEW_MEDIA_PILOT } from '@/data/constants';
import type { ModuleAgentKit, ToolContext } from '../types';
import { HOLDOUT_UNITS, type HoldoutUnitId } from './data';
import {
  CAMPAIGN_VERDICT_LABEL, DEFAULT_WEIGHTS, PROPOSAL_SHARES, allocationModel, daSaAnalysis, defaultPilots, funnelDiagnosis, holdoutDesign, pilotChange, pilotPlan,
  reallocationChange, rfpSegmentSummary, saCampaignPerformance, scoreNewMedia, targetGroupView, type AllocationInput, type CriterionId,
} from './engine';
import { allocationBrief, campaignBrief, daSaBrief, funnelBrief, newMediaBrief, overviewBrief } from './briefs';

const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : null);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct1 = (ratio: number) => r1(ratio * 100);

/** 입력 비중: % 또는 0~1 둘 다 허용, 매체 id 또는 short/name */
function parseShares(raw: unknown): Partial<Record<MediaId, number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<MediaId, number>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const m = MEDIA_IDS.find((id) => id === k || MEDIA[id].short === k || MEDIA[id].name === k);
    const n = Number(v);
    if (m && Number.isFinite(n) && n >= 0) out[m] = n > 1 ? n / 100 : n;
  }
  return Object.keys(out).length ? out : undefined;
}

function allocInput(inp: Record<string, unknown>): AllocationInput {
  const budget = Number(inp.budget);
  return {
    budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    shares: parseShares(inp.shares),
    daSaCredit: inp.daSaCredit === true || inp.daSaCredit === 'true',
  };
}

const BIND_KO: Record<string, string> = { min: '가드레일 하한', max: '가드레일 상한', step: '재배분 폭 상한', cap: '볼륨 한계', fixed: '데이터 없음 · 고정' };

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'growth_reallocate',
      description: '연 예산 배분(기본 p.37 가안)을 넣으면 매체별 반응 곡선(로그-로그 적합 · b 식별 여부) 기준 예상 매출 · ROAS · 한계 ROAS와 한계 효율 균등화 재배분안(가드레일 · 재배분 폭 · 볼륨 한계 적용), b ±0.1 민감도를 반환합니다. 예측이 아닌 시나리오입니다.',
      inputSchema: {
        type: 'object',
        properties: {
          shares: { type: 'object', description: '매체별 비중 (예: {"naver_sa": 45, "naver_gfa": 16}) — %, 생략 시 가안. 키는 naver_sa · naver_gfa · google · meta · kakao · vertical' },
          budget: { type: 'number', description: '연 예산 (원, 기본 50억)' },
          daSaCredit: { type: 'boolean', description: 'GFA에 DA→SA 기여(METHOD 1 · 3 추정)를 반영할지 (기본 false)' },
        },
      },
      execute: (inp) => {
        const m = allocationModel(ctx.state.data, allocInput(inp));
        return {
          출처: '제안서 p.37 · TEST DATA · 시나리오',
          예산: r0(m.budget),
          DA_SA기여반영: m.credit.on,
          매체: m.curves.map((c) => {
            const b = m.baseline.rows.find((r) => r.media === c.media)!;
            const s = m.scenario.rows.find((r) => r.media === c.media)!;
            const o = m.optimized.rows.find((r) => r.media === c.media)!;
            return {
              매체: MEDIA[c.media].name, 관측ROAS: r0(c.roas), 적합b: r2(c.fit.b), 적합b95: [r2(c.fit.ciLow), r2(c.fit.ciHigh)], 체감식별: c.identified, 적용b: r2(c.b), b출처: c.bSource,
              볼륨한계배수: r2(c.capMult),
              가안비중pct: pct1(PROPOSAL_SHARES[c.media]), 가안한계ROAS: r0(b.marginalRoas),
              시나리오비중pct: pct1(s.share), 시나리오매출: r0(s.annualRevenue), 시나리오ROAS: r0(s.roas), 시나리오한계ROAS: r0(s.marginalRoas), 볼륨초과: s.capped, 가드레일: s.guardFlag,
              균등화비중pct: pct1(o.share), 균등화제약: m.equalize.binding[c.media] ? BIND_KO[m.equalize.binding[c.media] as string] : null,
            };
          }),
          합계: {
            가안매출: r0(m.baseline.totalRevenue), 가안ROAS: r0(m.baseline.totalRoas),
            시나리오매출: r0(m.scenario.totalRevenue), 시나리오ROAS: r0(m.scenario.totalRoas), 시나리오증분pct: r2(m.upliftScenarioPct),
            균등화매출: r0(m.optimized.totalRevenue), 균등화ROAS: r0(m.optimized.totalRoas), 균등화증분pct: r2(m.upliftOptimizedPct), 균등화한계ROAS: r0(m.equalize.marginalRoas),
            민감도b01_증분pct: [r2(m.sensitivity.lowPct), r2(m.sensitivity.highPct)], 방향유지: m.sensitivity.stable,
          },
          메모: m.equalize.note,
        };
      },
    },
    {
      name: 'growth_da_sa',
      description: 'DA→SA 전환 기여(p.40) 결과를 반환합니다: GFA 광고비와 브랜드 검색량 · SA 전환의 시차(0~7일) 상관(원계열 · 요일·시즌 보정), 최적 시차, 분산 시차 회귀 계수, 브랜드 검색 중 DA 경유 비중, 대표 키워드 기여(METHOD 3), 지역 단위 홀드아웃 필요 기간.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const ds = daSaAnalysis(ctx.state.data);
        const h = holdoutDesign(ctx.state.data, { unit: 'region', metric: 'brand_search', mdePct: 10 });
        return {
          출처: '제안서 p.40 · TEST DATA', 표본일수: ds.n, 유의임계r: r2(ds.threshold), 최적시차일: ds.bestLag, 최적r: r2(ds.bestR), 원계열최고시차일: ds.rawBestLag,
          시차별: ds.lags.map((l) => ({ 시차: l.lag, 원계열r: r2(l.raw), 보정r: r2(l.adjusted), SA전환보정r: r2(l.saAdjusted), 유의: l.significant })),
          분산시차회귀: ds.dl.coefs.map((c) => ({ 시차: c.lag, 검색per100만원: r0(c.perMillion), t: r2(c.t) })), 누적계수: r0(ds.dl.cumulativePerMillion),
          브랜드검색중DA경유pct: pct1(ds.daShareBrand), SA전환동행유의: ds.saLink.significant,
          METHOD3: { SA매출중DA경유pct: pct1(ds.method3.daShareOfSa), 대표키워드: ds.method3.rows.map((r) => ({ 키워드: r.keyword, 매출14일: r0(r.revenue14), 경유pct: pct1(r.share), 근거: r.shareBasis })) },
          GFA_SA경유ROAS: r0(ds.halo.haloRoas),
          홀드아웃_지역30pct_MDE10: { 그룹당필요일: r0(h.requiredDays), 권장일: r0(h.recommendedDays), 미집행광고비: r0(h.unspentSpend) },
        };
      },
    },
    {
      name: 'growth_holdout',
      description: 'METHOD 2 홀드아웃 테스트 설계 계산 — 단위(region · audience · period) · 지표(brand_search · sa_brand_conv) · 최소 검출 효과(%)를 넣으면 필요 기간, 권장 기간, 28일 기준 검출 가능 효과, 미집행 광고비 · 예상 매출 영향을 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          unit: { type: 'string', enum: ['region', 'audience', 'period'], description: '홀드아웃 단위 (기본 region)' },
          metric: { type: 'string', enum: ['brand_search', 'sa_brand_conv'], description: '측정 지표 (기본 brand_search)' },
          mdePct: { type: 'number', description: '최소 검출 효과 % (기본 10)' },
        },
      },
      execute: (inp) => {
        const unit = (HOLDOUT_UNITS.some((u) => u.id === inp.unit) ? inp.unit : 'region') as HoldoutUnitId;
        const metric = inp.metric === 'sa_brand_conv' ? 'sa_brand_conv' : 'brand_search';
        const mde = Number(inp.mdePct);
        const h = holdoutDesign(ctx.state.data, { unit, metric, mdePct: Number.isFinite(mde) && mde > 0 ? mde : 10 });
        return {
          단위: h.unitLabel, 지표: h.metricLabel, 일평균: r1(h.mu), 잔차변동계수: r2(h.cv), 홀드아웃비중: r2(h.holdoutShare),
          그룹당필요일: r0(h.requiredDays), 권장일: r0(h.recommendedDays), 검출가능효과28일pct: r1(h.mdeAtDays), METHOD1추정효과pct: r1(h.expectedEffectPct), 검출가능: h.detectable,
          미집행광고비: r0(h.unspentSpend), 예상매출영향: r0(h.revenueAtRisk), 메모: h.note,
        };
      },
    },
    {
      name: 'growth_funnel',
      description: '브랜드스토어 · 자사몰 퍼널(유입 → 상세 → 장바구니 → 구매) 최근 14일 · 직전 14일, 단계별 채널 격차와 판정 근거, 우선 개선 단계 · 개선 시나리오, 의도-랜딩 불일치 · 품절 랜딩 키워드, 채널 간 잠식 · 합산 매출 판정(p.41)을 반환합니다.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const f = funnelDiagnosis(ctx.state.data);
        const ch = (c: typeof f.brandstore) => ({ 유입: c.cur.visitors, 상세: c.cur.detailViews, 장바구니: c.cur.carts, 구매: c.cur.orders, 매출: r0(c.cur.revenue), 방문대비구매pct: r2(c.rates.cvr), 객단가: r0(c.rates.aov) });
        return {
          출처: '제안서 p.41 · TEST DATA', 기간: f.window, 브랜드스토어: ch(f.brandstore), 자사몰: ch(f.ownMall),
          단계: f.stages.map((s) => ({ 단계: s.label, 지표: s.metricLabel, 브랜드스토어pct: r1(s.bs.cur), 자사몰pct: r1(s.om.cur), 자사몰격차pct: r1(s.gapPct), 우선채널: s.focus, 근거: s.reasons, 브랜드스토어액션: s.bsAction, 자사몰액션: `${s.omAction} (${s.omNote})` })),
          우선단계: f.priority?.label ?? null, 개선시나리오: { 근거: f.upside.basis, 월매출: r0(f.upside.addRevenueMonthly) },
          랜딩불일치: f.landing.mismatches.map((m) => ({ 키워드: m.keyword, 기대: m.expected, 실제: m.actual })), 품절랜딩: f.landing.soldout.map((s) => `${s.keyword} · ${s.option}`),
          잠식: { 판정: f.cannibal.flag, 근거: f.cannibal.basis, 합산증감pct: r1(f.cannibal.combined.deltaPct), 자사몰비중pct: pct1(f.cannibal.omShare.cur), 혜택차이: f.cannibal.benefitGap },
        };
      },
    },
    {
      name: 'growth_campaigns',
      description: '구매 의도별 타겟 그룹 A~E(p.34) 연결 지표와 네이버 SA 5개 캠페인(p.35) 최근 14일 성과(ROAS · CVR · CPA · 매출 비중 · 노출 손실 · 목표 대비 판정 · 랜딩 일치 여부), RFP 상위 세그먼트 비중을 반환합니다.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const seg = rfpSegmentSummary();
        return {
          출처: '제안서 p.34–35 · RFP · TEST DATA',
          RFP세그먼트: { 상위4개pct: pct1(seg.top4Share), 여성31_50pct: pct1(seg.female3150Share) },
          타겟그룹: targetGroupView(ctx.state.data).map((g) => ({ 그룹: `${g.id} ${g.name}`, 근거: g.basis, 연결캠페인: g.campaigns, 지표: g.metrics.map((x) => `${x.label} ${r1(x.kind === 'ratio' ? x.value * 100 : x.value)}`) })),
          캠페인: saCampaignPerformance(ctx.state.data).map((c) => ({
            캠페인: c.name, ROAS: r0(c.roas), 목표ROAS: c.target, 목표대비pct: r0(c.ratioPct), 판정: CAMPAIGN_VERDICT_LABEL[c.verdict], 근거: c.basis,
            CVRpct: r2(c.cvr), CPA: r0(c.cpa), 매출비중pct: pct1(c.revenueShare), 노출손실pct: pct1(c.lostShare), 월검색량: c.monthlySearch, 랜딩: c.landing, 랜딩불일치키워드: c.landingMismatch,
          })),
        };
      },
    },
    {
      name: 'growth_new_media',
      description: '신규 매체 후보 5개(p.38)를 선정 기준 5개 가중치로 점수화한 순위와, 파일럿 계획(연 예산 5% 한도 · 4주 · 후보별 예상 전환 · 필요 전환 · 증분 ROAS 판정 기준 = 기존 매체 한계 ROAS)을 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: { weights: { type: 'object', description: '기준별 가중치 (fit · context · measure · cost · brand, 기본 각 20)' } },
      },
      execute: (inp) => {
        const w: Record<CriterionId, number> = { ...DEFAULT_WEIGHTS };
        if (inp.weights && typeof inp.weights === 'object') {
          for (const c of NEW_MEDIA_PILOT.criteria) {
            const v = Number((inp.weights as Record<string, unknown>)[c.id]);
            if (Number.isFinite(v) && v >= 0) w[c.id] = v;
          }
        }
        const ranked = scoreNewMedia(w);
        const m = allocationModel(ctx.state.data);
        const plan = pilotPlan(ctx.state.data, defaultPilots(ranked), { marginalRoas: m.equalize.marginalRoas });
        return {
          출처: '제안서 p.38 · 데모 평가 · TEST DATA', 가중치: w,
          순위: ranked.map((r) => ({ 순위: r.rank, 후보: r.name, 점수: r0(r.total), 접점: r.touch, 가설: r.hypothesis })),
          파일럿: { 한도: r0(plan.cap), 합계: r0(plan.total), 한도초과: plan.overCap, 판정기준ROAS: r0(plan.threshold), 기준근거: plan.thresholdBasis, 필요전환: plan.minConv, 규칙: plan.rule,
            후보: plan.rows.map((r) => ({ 후보: r.name, 예산: r0(r.budget), CPA가정: r0(r.cpa), 예상전환: r1(r.expectedConv), 상태: r.status })) },
        };
      },
    },
    {
      name: 'growth_request_reallocation',
      description: '한계 ROAS 균등화 재배분안(또는 지정한 시나리오 배분)을 수면밀도 승인 대기(pending) 변경 요청으로 만듭니다. 실제 반영은 사람이 MILDO Flow에서 승인합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          which: { type: 'string', enum: ['optimized', 'scenario'], description: 'optimized = 균등화안, scenario = shares로 지정한 배분' },
          shares: { type: 'object', description: 'which=scenario일 때 매체별 비중 (%)' },
          daSaCredit: { type: 'boolean', description: 'DA→SA 기여 반영 여부' },
        },
        required: ['which'],
      },
      execute: (inp) => {
        const which = inp.which === 'scenario' ? 'scenario' : 'optimized';
        const m = allocationModel(ctx.state.data, allocInput(inp));
        const c = ctx.actions.addChange({ ...reallocationChange(m, which, `MILDO Agent (${ctx.state.role})`), status: 'pending' });
        return { 생성: true, changeId: c.id, 상태: 'pending', 승인주체: '수면밀도', 대상: c.target, 변경후: c.after };
      },
    },
    {
      name: 'growth_request_pilot',
      description: '신규 매체 파일럿(4주)을 수면밀도 승인 대기(pending) 테스트 요청으로 만듭니다. 후보명과 예산이 필요하며 연 예산 5% 한도를 넘으면 만들지 않습니다.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '후보명 (p.38 후보 5개 중 하나)' }, budget: { type: 'number', description: '파일럿 예산 (원)' } },
        required: ['name', 'budget'],
      },
      execute: (inp) => {
        const cand = NEW_MEDIA_PILOT.candidates.find((c) => c.name === inp.name || c.name.includes(String(inp.name ?? '')));
        if (!cand) return { 생성: false, 사유: '알 수 없는 후보' };
        const m = allocationModel(ctx.state.data);
        const plan = pilotPlan(ctx.state.data, [{ name: cand.name, budget: Number(inp.budget) }], { marginalRoas: m.equalize.marginalRoas });
        const row = plan.rows[0];
        if (!row || row.budget <= 0) return { 생성: false, 사유: '예산이 0 이하' };
        if (plan.overCap) return { 생성: false, 사유: `연 예산 5% 한도(${r0(plan.cap)}원) 초과` };
        const c = ctx.actions.addChange({ ...pilotChange(row, `MILDO Agent (${ctx.state.role})`), status: 'pending' });
        return { 생성: true, changeId: c.id, 상태: 'pending', 예상전환: r1(row.expectedConv), 필요전환: row.minConv, 표본충족: row.feasible };
      },
    },
  ],
  briefs: [
    { id: 'growth_alloc', match: /재배분|예산\s?배분|배분\s?(가안|시뮬)|한계\s?(효율|ROAS)|반응\s?곡선/i, build: (ctx) => allocationBrief(ctx.state.data) },
    { id: 'growth_dasa', match: /DA\s?(→|->|에서)?\s?SA|브랜드\s?검색|시차\s?상관|홀드아웃|DA\s?기여|기여\s?분석/i, build: (ctx) => daSaBrief(ctx.state.data) },
    { id: 'growth_funnel', match: /퍼널|전환\s?개선|자사몰|브랜드스토어\s?전환|장바구니|이탈|잠식/, build: (ctx) => funnelBrief(ctx.state.data) },
    { id: 'growth_new_media', match: /신규\s?매체|파일럿|코프로모션|당근|유튜브|YouTube/i, build: (ctx) => newMediaBrief(ctx.state.data) },
    { id: 'growth_campaign', match: /타겟\s?그룹|SA\s?캠페인|캠페인\s?구조|구매\s?의도|SKU\s?확장/i, build: (ctx) => campaignBrief(ctx.state.data) },
    { id: 'growth_overview', match: /매출\s?성장|성장\s?(공식|과제|캘린더)/, build: (ctx) => overviewBrief(ctx.state.data) },
  ],
};
