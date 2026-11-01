import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Dataset, Incident, Keyword, KeywordStats, MediaId } from '@/core/types';
import { detectIncidents, heldMedia } from '@/modules/alert/engine';
import { generateDemoData } from '@/data/demo';
import { AD_PILOT, CAUSE_CANDIDATES, GFA_DELEGATION } from '@/data/constants';
import { campaignPacing } from '@/core/selectors';
import {
  type BidProposal, adpilotBrief, budgetBrief, canApprove, canRollback, checkBulk, classifyIntent, clock, diagnoseKeyword,
  diagnoseKeywords, effectiveBids, effectiveCampaigns, effectiveKeywordStatus, generateBidProposals, gfaBrief, gfaOverview,
  holdsBrief, keywordAnomaly, mediaGuards, officialConfig, paceCampaigns, planGfaRequest, resolveConfig, routeByPct,
  routeGfaChange, simulateBidChange, testCandidates, validateGfaExecution, verifyBidChange, DEFAULT_CONFIG,
  adpilotProposals, explainBidDown, incidentHoldMap, matchingIncident, openHoldIncidents, validateAdpilotExecution, canNotify, holdIncident,
} from './engine';

const demo = generateDemoData();
const clone = (d: Dataset): Dataset => JSON.parse(JSON.stringify(d));

const day = (clicks: number, cpc: number, conv: number, imps = clicks * 40): KeywordStats => ({
  impressions: imps, clicks, cost: Math.round(clicks * cpc), conversions: conv, revenue: Math.round(conv * 1_000_000),
});
function kw(p: Partial<Keyword> & { dailyFn?: (i: number) => KeywordStats; prevRoasMult?: number } = {}): Keyword {
  const daily = Array.from({ length: 14 }, (_, i) => (p.dailyFn ? p.dailyFn(i) : day(20, 1000, 0.5)));
  const agg = (rows: KeywordStats[]) => rows.reduce((a, r) => ({
    impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, cost: a.cost + r.cost, conversions: a.conversions + r.conversions, revenue: a.revenue + r.revenue,
  }), { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 });
  const last14 = agg(daily);
  const m = p.prevRoasMult ?? 1;
  return {
    id: 'kw_t', text: '테스트 키워드', intent: 'generic', adgroup: 'GENERIC_MAIN', isBrand: false, bid: 1000, maxBid: 1600, avgRank: 3,
    monthlySearch: 1000, impressionShareLost: 0.1, status: 'on', landing: 'https://example.com/x',
    last14, prev14: { ...last14, revenue: Math.round(last14.revenue * m) }, daily, ...p,
  } as Keyword;
}

function change(p: Partial<ChangeRequest>): ChangeRequest {
  return {
    id: p.id ?? `c_${Math.random()}`, createdAt: p.createdAt ?? '2026-10-31T06:00:00.000Z', module: 'adpilot', kind: 'bid', target: 't', targetId: 'kw_6',
    before: 1420, after: 1630, reason: 'r', requestedBy: 'PM', approver: 'PM', status: 'applied', history: [], ...p,
  };
}

/* ------------------------------------------------------------------ */
describe('계약 시그니처', () => {
  it('generateBidProposals(data) 와 (data, config) 모두 BidProposal[] 로 사용 가능', () => {
    const a: BidProposal[] = generateBidProposals(demo);
    const b: BidProposal[] = generateBidProposals(demo, { targetRoas: 500 });
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    for (const p of a) {
      expect(typeof p.id).toBe('string');
      expect(['bid_up', 'bid_down', 'hold', 'budget_shift', 'test_candidate']).toContain(p.action);
      expect(Number.isFinite(p.before)).toBe(true);
      expect(Number.isFinite(p.after)).toBe(true);
      expect(Number.isFinite(p.changePct)).toBe(true);
      expect(Array.isArray(p.guard)).toBe(true);
    }
  });
  it('id 는 결정적이고 중복이 없다', () => {
    const a = generateBidProposals(demo).map((p) => p.id);
    const b = generateBidProposals(generateDemoData()).map((p) => p.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
  it('기본 설정은 제안서 p.14 상수와 일치', () => {
    expect(DEFAULT_CONFIG.targetRoas).toBe(AD_PILOT.targetRoas);
    expect(DEFAULT_CONFIG.brandTargetRoas).toBe(800);
    expect(DEFAULT_CONFIG.dailyChangeCapPct).toBe(20);
    expect(DEFAULT_CONFIG.lostShareTrigger).toBe(0.25);
    expect(DEFAULT_CONFIG.highEfficiencyRoasRatio).toBe(1.3);
    expect(DEFAULT_CONFIG.minConversionsForDown).toBe(3);
    expect(DEFAULT_CONFIG.anomalyHoldPct).toBe(50);
  });
});

/* ------------------------------------------------------------------ */
describe('데모 시나리오 탐지 (데이터 기반)', () => {
  const ps = generateBidProposals(demo);
  const diag = diagnoseKeywords(demo);

  it("'매트리스 추천' 최근 3일 CPC 급등 → 자동 조정 보류 + 1순위 원인 '경쟁사 입찰 상승'", () => {
    const p = ps.find((x) => x.keyword === '매트리스 추천')!;
    expect(p.action).toBe('hold');
    expect(p.ruleId).toBe('anomaly');
    expect(p.holdKind).toBe('keyword_anomaly');
    expect(p.causes?.[0].cause).toBe(CAUSE_CANDIDATES[0]);
    const k = demo.keywords.find((x) => x.text === '매트리스 추천')!;
    const an = keywordAnomaly(k, demo);
    expect(an.cpcDelta).toBeGreaterThanOrEqual(50);
    expect(an.convDelta).toBeLessThan(-30);
  });

  it('급변을 제거하면 같은 키워드는 보류되지 않는다 (하드코딩 아님)', () => {
    const d = clone(demo);
    const k = d.keywords.find((x) => x.text === '매트리스 추천')!;
    const base = k.daily[5];
    for (let i = 11; i < 14; i++) k.daily[i] = { ...base };
    const p = generateBidProposals(d).find((x) => x.keyword === '매트리스 추천');
    expect(p?.action).not.toBe('hold');
  });

  it('고효율 · 노출 손실 ≥ 25% 키워드(star)는 모두 입찰 상향 — 상한 20% · 최대 입찰가 이내', () => {
    const ups = ps.filter((p) => p.action === 'bid_up');
    const expected = diag.filter((d) => !d.isBrand && d.status === 'on' && !d.anomaly.triggered && !d.soldout && d.roas >= 400 * 1.3 && d.lost >= 0.25);
    expect(expected.length).toBeGreaterThanOrEqual(3);
    for (const d of expected) expect(ups.some((u) => u.keywordId === d.id)).toBe(true);
    for (const u of ups) {
      const k = demo.keywords.find((x) => x.id === u.keywordId)!;
      expect(u.changePct).toBeGreaterThan(0);
      expect(u.changePct).toBeLessThanOrEqual(AD_PILOT.dailyChangeCapPct);
      expect(u.after).toBeLessThanOrEqual(k.maxBid);
      expect(u.after % 10).toBe(0);
      expect(u.basis).toMatch(/목표 .* 대비/);
    }
    // 노출 손실 25% 미만 고효율 키워드는 상향하지 않는다
    const low = diag.find((d) => d.text === '매트리스')!;
    expect(low.lost).toBeLessThan(0.25);
    expect(ups.some((u) => u.keywordId === low.id)).toBe(false);
  });

  it('브랜드 키워드는 별도 기준(800% · 순위 방어) — 방어 상향 + PM 이상 승인', () => {
    const brand = ps.filter((p) => p.isBrand && p.action === 'bid_up');
    expect(brand.length).toBeGreaterThan(0);
    for (const b of brand) {
      expect(b.ruleId).toBe('brand');
      expect(b.basis).toContain('브랜드 목표 800%');
      expect(['PM', 'CLIENT']).toContain(b.approver);
    }
  });

  it("킹 옵션 품절 + '킹 매트리스' 상품 상세 랜딩 → 품절 랜딩 보류 (재입고 시 해제)", () => {
    const p = ps.find((x) => x.keyword === '킹 매트리스')!;
    expect(p.action).toBe('hold');
    expect(p.holdKind).toBe('soldout');
    expect(p.kind).toBe('status');
    const d = clone(demo);
    d.products[0].options.find((o) => o.id === 'k')!.inStock = true;
    expect(generateBidProposals(d).find((x) => x.keyword === '킹 매트리스')?.holdKind).not.toBe('soldout');
  });

  it('일 예산 조기 소진: SA_일반 제품 · Meta_넓은 타겟 탐지 (시간대 가중 곡선), selector 선형 추정도 함께 보존', () => {
    const paces = paceCampaigns(demo);
    const sa = paces.find((p) => p.name === 'SA_일반 제품')!;
    const meta = paces.find((p) => p.name === 'Meta_넓은 타겟')!;
    expect(sa.earlyExhaust).toBe(true);
    expect(meta.earlyExhaust).toBe(true);
    expect(sa.curveExhaustHour!).toBeLessThan(22);
    expect(sa.projectedRatio).toBeGreaterThan(1.25);
    const linear = campaignPacing(demo).find((c) => c.name === 'Meta_넓은 타겟')!;
    expect(meta.linearEarly).toBe(linear.earlyExhaust);
    // 비조기 캠페인은 탐지되지 않는다
    expect(paces.find((p) => p.name === 'SA_생활 상황')!.earlyExhaust).toBe(false);
  });

  it('SA_일반 제품 → 같은 매체 미소진 캠페인에서 재배분 (총액 불변, 브랜드 방어는 재원 제외)', () => {
    const p = ps.find((x) => x.keyword === 'SA_일반 제품')!;
    expect(p.action).toBe('budget_shift');
    expect(p.donor).toBeDefined();
    expect(p.donor!.name).not.toContain('브랜드');
    expect(p.after - p.before).toBe(p.donor!.before - p.donor!.after);
    expect(p.changeTargetId).toBe(`budget:${p.keywordId}:${p.donor!.id}`);
  });

  it('조기 소진 예산 제안에 입찰 조정 대안(같은 의도 저효율 키워드)을 데이터로 붙인다 — 보류 · 품절 키워드 제외', () => {
    const budget = ps.filter((p) => p.ruleId === 'early_exhaust' && p.media === 'naver_sa');
    expect(budget.length).toBeGreaterThan(0);
    const withAlt = budget.filter((p) => p.guard.some((g) => g.startsWith('입찰 조정 대안')));
    expect(withAlt.length).toBeGreaterThan(0);
    for (const p of withAlt) {
      const alt = p.guard.find((g) => g.startsWith('입찰 조정 대안'))!;
      expect(alt).not.toContain('킹 매트리스');
      expect(alt).not.toContain('매트리스 추천');
    }
  });

  it('Meta 오늘 14~15시 광고비 급등 → 매체 자동 조정 보류 (P2 데이터 급변)', () => {
    const g = mediaGuards(demo).meta;
    expect(g.hold).toBe(true);
    expect(g.kind).toBe('data_spike');
    expect(g.costDelta).toBeGreaterThan(50);
    expect(g.costDelta).toBeLessThan(95);
    const p = ps.find((x) => x.changeTargetId === 'media:meta')!;
    expect(p.action).toBe('hold');
    expect(p.reason).toContain('Meta_넓은 타겟');
  });

  it('카카오 13시 이후 전환 0 (클릭 정상) → 전환 추적 단절 보류', () => {
    const g = mediaGuards(demo).kakao;
    expect(g.kind).toBe('tracking_break');
    expect(g.zeroRunFrom).toBe(13);
    expect(ps.find((x) => x.changeTargetId === 'media:kakao')?.holdKind).toBe('tracking_break');
    for (const m of ['naver_sa', 'naver_gfa', 'google', 'vertical'] as const) expect(mediaGuards(demo)[m].hold).toBe(false);
  });

  it('GFA 계정 잔액 235만 < 일 평균 259만 + 자동충전 실패 → 계정 critical, GFA 조기 소진 캠페인 증액 보류', () => {
    const views = gfaOverview(demo, []);
    const main = views.find((v) => v.account.id === 'acc_gfa')!;
    expect(main.runwayDays).toBeLessThan(1);
    expect(main.level).toBe('critical');
    expect(main.issues.map((i) => i.text).join(' ')).toContain('자동충전 실패');
    expect(main.exhaustAt).not.toBeNull();
    expect(views.length).toBeGreaterThanOrEqual(2);
    const gfaEarly = paceCampaigns(demo).filter((p) => p.media === 'naver_gfa' && p.earlyExhaust);
    for (const c of gfaEarly) expect(ps.find((x) => x.keywordId === c.id)?.holdKind).toBe('account');
  });

  it('검색어 보고서 미등록 + 전환 → 테스트 그룹 후보 (등록된 검색어 제외)', () => {
    const tc = testCandidates(demo);
    const expected = demo.searchTerms.filter((t) => !t.registered && t.conversions > 0).map((t) => t.term).sort();
    expect(tc.map((t) => t.term).sort()).toEqual(expected);
    expect(tc.every((t) => t.adgroup.endsWith('_TEST'))).toBe(true);
    expect(tc.find((t) => t.term.includes('디스크'))!.cautions.join(' ')).toContain('의료');
    expect(ps.filter((p) => p.action === 'test_candidate').length).toBe(expected.length);
  });

  it('테스트 그룹 키워드는 AD Pilot 이 조정하지 않는다 (Lab 판정 대상)', () => {
    for (const d of diag.filter((x) => demo.keywords.find((k) => k.id === x.id)!.status === 'test')) {
      expect(d.verdict).toBe('test');
      expect(ps.some((p) => p.keywordId === d.id)).toBe(false);
    }
  });

  it('목표 ROAS를 올리면 미달 지속 + 전환 ≥ 3 키워드가 하향 후보로 바뀐다', () => {
    const ps2 = generateBidProposals(demo, { targetRoas: 1100 });
    const down = ps2.filter((p) => p.action === 'bid_down');
    expect(down.length).toBeGreaterThan(0);
    for (const p of down) {
      const k = demo.keywords.find((x) => x.id === p.keywordId)!;
      expect(k.last14.conversions).toBeGreaterThanOrEqual(3);
      expect(p.changePct).toBeLessThan(0);
      expect(p.changePct).toBeGreaterThanOrEqual(-20);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('키워드 규칙 · 경계값', () => {
  const cfg = resolveConfig();
  const highEff = (lost: number, extra: Partial<Keyword> = {}) => kw({ impressionShareLost: lost, dailyFn: () => day(30, 1000, 0.3), ...extra }); // ROAS 1,000%

  it('고효율 + 손실 25% 경계: 0.25 상향, 0.24 유지', () => {
    expect(diagnoseKeyword(demo, highEff(0.25), cfg).verdict).toBe('up');
    expect(diagnoseKeyword(demo, highEff(0.24), cfg).verdict).toBe('keep');
  });
  it('고효율 배수 경계: ROAS = 목표 × 1.3 이면 상향, 미만이면 유지', () => {
    const at = kw({ impressionShareLost: 0.3, dailyFn: () => day(10, 1000, 0.052) }); // 520%
    const below = kw({ impressionShareLost: 0.3, dailyFn: () => day(10, 1000, 0.0519) });
    expect(diagnoseKeyword(demo, at, cfg).verdict).toBe('up');
    expect(diagnoseKeyword(demo, below, cfg).verdict).toBe('keep');
  });
  it('상향은 일 상한 20% · 최대 입찰가로 제한, 최대 입찰가 도달 시 상한 도달', () => {
    const d = diagnoseKeyword(demo, highEff(0.9), cfg);
    expect(d.proposedPct).toBeLessThanOrEqual(20);
    const nearMax = diagnoseKeyword(demo, highEff(0.4, { maxBid: 1050 }), cfg);
    expect(nearMax.proposedBid).toBe(1050);
    expect(nearMax.limitedBy.join(' ')).toContain('최대 입찰가');
    expect(diagnoseKeyword(demo, highEff(0.4, { maxBid: 1000 }), cfg).verdict).toBe('capped');
  });
  it('이미 상한만큼 반영된 키워드는 오늘 추가 조정하지 않는다', () => {
    const k = highEff(0.4);
    const d = diagnoseKeyword(demo, k, resolveConfig({ currentBids: { kw_t: 1200 } }));
    expect(d.verdict).toBe('capped');
    expect(d.note).toContain('한도');
  });
  it('하향: 두 기간 모두 미달 + 전환 ≥ 3 → 하향, 전환 부족 · 직전 충족 · 직전 데이터 없음은 관찰', () => {
    const weak = kw({ dailyFn: () => day(100, 1000, 0.25) }); // ROAS 250%, 전환 3.5
    expect(diagnoseKeyword(demo, weak, cfg).verdict).toBe('down');
    const d = diagnoseKeyword(demo, weak, cfg);
    expect(d.proposedPct!).toBeGreaterThanOrEqual(-20);
    expect(d.proposedPct!).toBeLessThan(0);
    const fewConv = kw({ dailyFn: () => day(100, 1000, 0.2) }); // ROAS 200%, 전환 2.8
    expect(diagnoseKeyword(demo, fewConv, cfg).verdict).toBe('watch');
    const prevOk = kw({ dailyFn: () => day(100, 1000, 0.25), prevRoasMult: 3 });
    expect(diagnoseKeyword(demo, prevOk, cfg).verdict).toBe('watch');
    const noPrev = { ...weak, prev14: { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 } };
    expect(diagnoseKeyword(demo, noPrev, cfg).note).toContain('직전 14일 데이터 없음');
  });
  it('하향은 최소 입찰가 아래로 내려가지 않는다', () => {
    const weak = kw({ bid: 80, maxBid: 200, dailyFn: () => day(30, 80, 0.005) });
    const d = diagnoseKeyword(demo, weak, resolveConfig({ minConversionsForDown: 0 }));
    expect(d.proposedBid === null || d.proposedBid >= 70).toBe(true);
  });
  it('브랜드 키워드는 목표 미달이어도 자동 하향하지 않는다 (순위 방어 우선)', () => {
    const b = kw({ isBrand: true, intent: 'brand', dailyFn: () => day(100, 1000, 0.25) }); // ROAS 250% < 800%
    const d = diagnoseKeyword(demo, b, cfg);
    expect(d.verdict).toBe('watch');
    expect(d.proposedBid).toBeNull();
  });
  it('급변: 최근 3일 CPC +100% (클릭 충분) → 보류, 클릭이 적으면 표본 부족으로 판정하지 않음', () => {
    const spike = kw({ dailyFn: (i) => day(30, i >= 11 ? 2000 : 1000, 0.3) });
    expect(diagnoseKeyword(demo, spike, cfg).verdict).toBe('hold');
    const thin = kw({ dailyFn: (i) => day(3, i >= 11 ? 2000 : 1000, 0.3) });
    expect(keywordAnomaly(thin, demo).cpcEligible).toBe(false);
    expect(keywordAnomaly(thin, demo).triggered).toBe(false);
  });
  it('수집 이상: 최근 3일 노출 0 → 수집 이상 보류, 원인 후보 1순위 매체 장애 · 집계 지연', () => {
    const missing = kw({ dailyFn: (i) => (i >= 11 ? day(0, 0, 0, 0) : day(30, 1000, 0.3)) });
    const an = keywordAnomaly(missing, demo);
    expect(an.kind).toBe('collection');
    expect(an.causes[0].cause).toBe(CAUSE_CANDIDATES[3]);
    const neg = kw({ dailyFn: (i) => (i === 3 ? { ...day(30, 1000, 0.3), cost: -5 } : day(30, 1000, 0.3)) });
    expect(keywordAnomaly(neg, demo).kind).toBe('collection');
  });
  it('0 나누기 · NaN 방어: 클릭 0 키워드는 관찰, 제안가 없음', () => {
    const zero = kw({ dailyFn: () => day(0, 0, 0, 0) });
    const d = diagnoseKeyword(demo, zero, cfg);
    expect(d.verdict).toBe('watch');
    expect(d.proposedBid).toBeNull();
    const nanKw = { ...kw(), last14: { impressions: NaN, clicks: NaN, cost: NaN, conversions: NaN, revenue: NaN } } as Keyword;
    expect(() => diagnoseKeyword(demo, nanKw, cfg)).not.toThrow();
    expect(diagnoseKeyword(demo, nanKw, cfg).verdict).not.toBe('up');
  });
  it('일 상한 설정을 10%로 낮추면 모든 입찰 후보가 ±10% 이내', () => {
    for (const p of generateBidProposals(demo, { dailyChangeCapPct: 10 }).filter((x) => x.action === 'bid_up' || x.action === 'bid_down')) {
      expect(Math.abs(p.changePct)).toBeLessThanOrEqual(10);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('설정 · 빈 데이터 방어', () => {
  it('resolveConfig: NaN · Infinity → 기본값, 범위 밖 → 경계값, 차단 ≤ 경고 보정', () => {
    const c = resolveConfig({ targetRoas: NaN, dailyChangeCapPct: Infinity, lostShareTrigger: 5, bulkWarnCount: 10, bulkBlockCount: 3 });
    expect(c.targetRoas).toBe(400);
    expect(c.dailyChangeCapPct).toBe(20);
    expect(c.lostShareTrigger).toBe(0.95);
    expect(c.bulkBlockCount).toBeGreaterThan(c.bulkWarnCount);
  });
  it('빈 데이터셋 → 후보 없음 · 예외 없음', () => {
    const empty: Dataset = { ...demo, keywords: [], campaigns: [], mediaHourly: [], mediaDaily: [], searchTerms: [], products: [], promotions: [], accounts: [] };
    expect(generateBidProposals(empty)).toEqual([]);
    expect(paceCampaigns(empty)).toEqual([]);
    expect(Object.values(mediaGuards(empty)).every((g) => !g.hold)).toBe(true);
    expect(() => gfaOverview(empty, [])).not.toThrow();
    expect(() => adpilotBrief(empty, [])).not.toThrow();
    expect(() => budgetBrief(empty)).not.toThrow();
    expect(() => holdsBrief(empty)).not.toThrow();
  });
  it('null 성격 입력 방어', () => {
    expect(generateBidProposals(null as unknown as Dataset)).toEqual([]);
    expect(effectiveBids(demo, undefined as unknown as ChangeRequest[])).toBeDefined();
  });
  it('공식 기준: 반영된 기준 변경만 적용 (대기 건 무시)', () => {
    const cfg = officialConfig([
      change({ kind: 'setting', targetId: 'adpilot.cfg.targetRoas', before: 400, after: 450, status: 'applied' }),
      change({ kind: 'setting', targetId: 'adpilot.cfg.dailyChangeCapPct', before: 20, after: 15, status: 'pending' }),
    ]);
    expect(cfg.targetRoas).toBe(450);
    expect(cfg.dailyChangeCapPct).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
describe('승인 라우팅 · 권한 (p.15 위임 범위)', () => {
  it('변경 폭 경계: ±10% 이내 AE, ±10~30% PM, 30% 초과 수면밀도', () => {
    expect(routeByPct(10).approver).toBe('AE');
    expect(routeByPct(-10).approver).toBe('AE');
    expect(routeByPct(10.01).approver).toBe('PM');
    expect(routeByPct(30).approver).toBe('PM');
    expect(routeByPct(-30.5).approver).toBe('CLIENT');
    expect(routeByPct(NaN).approver).toBe('CLIENT');
    expect(GFA_DELEGATION.map((r) => r.approver)).toEqual(['AE', 'PM', 'CLIENT']);
  });
  it('GFA 유형: 상태 점검 AE · 광고그룹 ON/OFF PM · 신규 캠페인 수면밀도', () => {
    expect(routeGfaChange('status_check').approver).toBe('AE');
    expect(routeGfaChange('adgroup').approver).toBe('PM');
    expect(routeGfaChange('new_campaign').approver).toBe('CLIENT');
    expect(routeGfaChange('budget', 25).approver).toBe('PM');
  });
  it('역할 권한: AE는 AE건, PM은 AE·PM건, 수면밀도는 전부', () => {
    expect(canApprove('담당 AE', 'AE').ok).toBe(true);
    expect(canApprove('담당 AE', 'PM').ok).toBe(false);
    expect(canApprove('담당 AE', 'PM').reason).toContain('PM');
    expect(canApprove('PM', 'PM').ok).toBe(true);
    expect(canApprove('PM', 'CLIENT').ok).toBe(false);
    expect(canApprove('수면밀도', 'CLIENT').ok).toBe(true);
    expect(canApprove('외부인', 'AE').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
describe('반영 · 롤백 상태', () => {
  it('반영된 입찰가가 현재 입찰가, 롤백된 건은 직전 상태', () => {
    const a = change({ id: 'a', after: 1630, history: [{ at: '2026-10-31T06:00:00Z', by: 'PM', action: '반영' }] });
    expect(effectiveBids(demo, [a]).kw_6).toBe(1630);
    expect(effectiveBids(demo, [{ ...a, status: 'rolled_back' }]).kw_6).toBe(demo.keywords.find((k) => k.id === 'kw_6')!.bid);
    const b = change({ id: 'b', before: 1630, after: 1700, history: [{ at: '2026-10-31T07:00:00Z', by: 'PM', action: '반영' }] });
    expect(effectiveBids(demo, [b, a]).kw_6).toBe(1700);
    expect(canRollback([a, b], a).ok).toBe(false);
    expect(canRollback([a, b], b).ok).toBe(true);
    expect(canRollback([a], { ...a, status: 'pending' }).ok).toBe(false);
  });
  it('재배분 반영 시 받는 캠페인 +, 재원 캠페인 −', () => {
    const p = generateBidProposals(demo).find((x) => x.action === 'budget_shift' && x.donor)!;
    const c = change({ module: 'adpilot', kind: 'budget', targetId: p.changeTargetId, before: p.before, after: p.after });
    const eff = effectiveCampaigns(demo, [c]);
    expect(eff.find((x) => x.id === p.keywordId)!.dailyBudget).toBe(p.after);
    expect(eff.find((x) => x.id === p.donor!.id)!.dailyBudget).toBe(p.donor!.after);
  });
  it('품절 일시 중지 반영 → 키워드 OFF 판정', () => {
    const k = demo.keywords.find((x) => x.text === '킹 매트리스')!;
    const st = effectiveKeywordStatus([change({ kind: 'status', targetId: k.id, before: 'on', after: 'off' })]);
    expect(st[k.id]).toBe('off');
    expect(diagnoseKeywords(demo, undefined, st).find((d) => d.id === k.id)!.verdict).toBe('off');
  });
});

/* ------------------------------------------------------------------ */
describe('자동 입찰 검증 · 시뮬레이션 · 대량 변경', () => {
  const queen = demo.keywords.find((k) => k.text === '퀸 매트리스')!;
  it('시뮬레이션: 상향 시 클릭 · 비용 증가, CPC 상승, 노출 손실분이 클릭 증가 상한', () => {
    const s = simulateBidChange(queen, 1000, 1200);
    expect(s.delta.clicksPct).toBeGreaterThan(0);
    expect(s.delta.costPct).toBeGreaterThan(s.delta.clicksPct);
    expect(s.projected.cpc).toBeGreaterThan(s.base.cpc);
    const capped = simulateBidChange({ ...queen, impressionShareLost: 0.01 }, 1000, 2000);
    expect(capped.clickCapped).toBe(true);
    expect(capped.delta.clicksPct).toBeLessThanOrEqual(1.02);
  });
  it('시뮬레이션 0 나누기 방어: 현재가 0 · 클릭 0', () => {
    const s = simulateBidChange({ last14: { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }, impressionShareLost: 0 }, 0, 500);
    expect(Number.isFinite(s.projected.cost)).toBe(true);
    expect(s.bidChangePct).toBe(0);
  });
  it('검증: 상한 초과 · 최대가 초과 · 변경 없음 차단, 품절 상향 차단', () => {
    expect(verifyBidChange(demo, queen, Math.round(queen.bid * 1.3)).blocked).toBe(true);
    expect(verifyBidChange(demo, queen, queen.bid).blocked).toBe(true);
    const ok = verifyBidChange(demo, queen, Math.round((queen.bid * 1.1) / 10) * 10);
    expect(ok.blocked).toBe(false);
    expect(ok.route.approver).toBe('AE');
    const king = demo.keywords.find((k) => k.text === '킹 매트리스')!;
    expect(verifyBidChange(demo, king, king.bid + 100).items.find((i) => i.id === 'soldout')?.level).toBe('block');
  });
  it('대량 변경: 5건 경고 · 15건 차단 · 상한 초과 차단 · 빈 선택 차단', () => {
    const item = { kind: 'bid' as const, changePct: 10 };
    expect(checkBulk(Array(4).fill(item)).level).toBe('ok');
    expect(checkBulk(Array(5).fill(item)).level).toBe('warn');
    expect(checkBulk(Array(15).fill(item)).level).toBe('block');
    expect(checkBulk([{ kind: 'bid', changePct: 25 }]).level).toBe('block');
    expect(checkBulk([{ kind: 'budget', changePct: 25 }]).level).toBe('ok');
    expect(checkBulk([]).level).toBe('block');
    expect(checkBulk([{ kind: 'bid', changePct: 5, costDelta: 500_000 }], undefined, 1_000_000).level).toBe('warn');
  });
});

/* ------------------------------------------------------------------ */
describe('GFA Control v1 요청 · 실행', () => {
  const views = gfaOverview(demo, []);
  const main = views.find((v) => v.account.id === 'acc_gfa')!;
  const pros = main.campaigns.find((c) => c.campaign.name === 'GFA_Prospecting')!;
  it('일 예산 변경 폭별 승인 주체 자동 라우팅', () => {
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: 5 }).route.approver).toBe('AE');
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: -20 }).route.approver).toBe('PM');
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: 40 }).route.approver).toBe('CLIENT');
    expect(planGfaRequest(views, { type: 'adgroup', accountId: 'acc_gfa', campaignId: pros.campaign.id, adGroupId: pros.adGroups[0].id }).route.approver).toBe('PM');
    expect(planGfaRequest(views, { type: 'new_campaign', accountId: 'gfa_pilot', newName: '신규', newBudget: 100000 }).route.approver).toBe('CLIENT');
  });
  it('잔액 부족 계정 증액은 경고, 2배 초과 · 0 이하 · 미입력은 오류', () => {
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: 5 }).warnings.join(' ')).toContain('잔액');
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: 150 }).ok).toBe(false);
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: -100 }).ok).toBe(false);
    expect(planGfaRequest(views, { type: 'budget', accountId: 'acc_gfa', campaignId: pros.campaign.id, pct: NaN }).ok).toBe(false);
    expect(planGfaRequest(views, { type: 'new_campaign', accountId: 'gfa_pilot', newName: '', newBudget: 0 }).ok).toBe(false);
  });
  it('실행: 잔액 부족 계정 증액은 보류, 감액은 실행, 미승인은 실행 불가', () => {
    const base = { module: 'gfa', kind: 'budget' as const, targetId: `gfa:budget:${pros.campaign.id}`, status: 'approved' as const };
    expect(validateGfaExecution(views, change({ ...base, before: 1_200_000, after: 1_260_000 })).ok).toBe(false);
    expect(validateGfaExecution(views, change({ ...base, before: 1_200_000, after: 1_080_000 })).ok).toBe(true);
    expect(validateGfaExecution(views, change({ ...base, status: 'pending', before: 1, after: 0 })).ok).toBe(false);
    const mall = views.find((v) => v.account.id === 'gfa_mall')!.campaigns[0];
    expect(validateGfaExecution(views, change({ ...base, targetId: `gfa:budget:${mall.campaign.id}`, before: 420_000, after: 460_000 })).ok).toBe(true);
  });
  it('반영된 GFA 일 예산 · 광고그룹 · 신규 캠페인이 점검 화면에 반영', () => {
    const ag = pros.adGroups[0];
    const v2 = gfaOverview(demo, [
      change({ module: 'gfa', kind: 'budget', targetId: `gfa:budget:${pros.campaign.id}`, before: pros.campaign.dailyBudget, after: 1_080_000 }),
      change({ module: 'gfa', kind: 'status', targetId: `gfa:adgroup:${pros.campaign.id}:${ag.id}`, before: 'on', after: 'off' }),
      change({ id: 'newc', module: 'gfa', kind: 'gfa', target: 'GFA_테스트 신규', targetId: 'gfa:new:gfa_pilot:GFA_테스트 신규', before: '—', after: 150000 }),
    ]);
    const p2 = v2.find((v) => v.account.id === 'acc_gfa')!.campaigns.find((c) => c.campaign.id === pros.campaign.id)!;
    expect(p2.campaign.dailyBudget).toBe(1_080_000);
    expect(p2.adGroups.find((g) => g.id === ag.id)!.status).toBe('off');
    expect(v2.find((v) => v.account.id === 'gfa_pilot')!.campaigns.some((c) => c.campaign.name === 'GFA_테스트 신규')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('문구 · 분류', () => {
  it('구매 의도 분류', () => {
    expect(classifyIntent('밀도 매트리스 경도')).toBe('brand');
    expect(classifyIntent('독립스프링 vs 포켓스프링')).toBe('compare');
    expect(classifyIntent('첫 자취 매트리스 추천')).toBe('life');
    expect(classifyIntent('허리 디스크 매트리스 단단한')).toBe('problem');
    expect(classifyIntent('매트리스 무료배송 설치')).toBe('generic');
  });
  it('시각 표기', () => {
    expect(clock(20.4)).toBe('20:24');
    expect(clock(27.3)).toBe('24시 이후');
    expect(clock(null)).toBe('—');
    expect(clock(NaN)).toBe('—');
  });
  it('브리프: 번호 매기기 없음 · 6영역 구조 · TEST DATA 표기', () => {
    const briefs = [adpilotBrief(demo, []), holdsBrief(demo), budgetBrief(demo), gfaBrief(demo, [])];
    for (const b of briefs) {
      expect(b.facts.length).toBeGreaterThan(0);
      const all = [...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions];
      for (const s of all) {
        expect(s).not.toMatch(/^\s*\d+[.)]\s/);
        expect(s).not.toMatch(/NaN|undefined/);
      }
    }
    expect(adpilotBrief(demo, []).facts.join(' ')).toContain('TEST DATA');
  });
  it('모든 후보 문구에 NaN · undefined 가 없다', () => {
    for (const p of generateBidProposals(demo)) {
      for (const s of [p.reason, p.expected, p.basis, ...p.guard]) expect(s).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});

/* ------------------------------------------------------------------ */
const inc = (p: Partial<Incident> & { holdMedia?: MediaId }): Incident => ({
  id: 'x', ruleId: 'data_spike', severity: 'P2', title: 't', detectedAt: '2026-10-31T06:00:00.000Z', occurredAt: '2026-10-31T05:00:00.000Z',
  detectPath: 'test', causeCandidates: [], impact: {}, status: 'open', timeline: [], isTest: true, autoActions: [], ...p,
}) as Incident;
const AUTO = ['bid_up', 'bid_down', 'budget_shift'];

describe('MILDO Alert 이슈 연계 보류 (state.incidents · heldMedia)', () => {
  const base = generateBidProposals(demo);
  const alertIncidents = detectIncidents(demo);
  const googleSpike = inc({ id: 'data_spike:Google:2026-10-31:test-1', ruleId: 'data_spike', media: 'google', holdMedia: 'google', title: '[테스트] Google 데이터 급변 · 광고비 +85%' });
  const saBreak = inc({ id: 'tracking_break:네이버 SA:2026-10-31', ruleId: 'tracking_break', severity: 'P1', media: 'naver_sa', holdMedia: 'naver_sa', title: '네이버 SA 전환 추적 단절 의심' });

  it('데모 Alert 이슈는 AD Pilot 자체 보류와 같은 대상이면 한 건으로 합친다 (중복 표기 없음)', () => {
    const find = (rule: string, pred: (i: Incident) => boolean) => alertIncidents.find((i) => i.ruleId === rule && pred(i));
    const kakao = find('tracking_break', (i) => i.media === 'kakao');
    const meta = find('data_spike', (i) => i.media === 'meta');
    const kw = find('keyword_spike', (i) => i.target === '매트리스 추천');
    expect(kakao && meta && kw).toBeTruthy();
    const ps = adpilotProposals(demo, undefined, alertIncidents, []);
    expect(ps.length).toBe(base.length);
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
    const linked = (id: string) => ps.find((p) => p.id === id)!;
    expect(linked(`hold:media_kakao:${demo.today}`).linkedIncidents?.map((l) => l.id)).toContain(kakao!.id);
    expect(linked(`hold:media_kakao:${demo.today}`).holdSource).toBe('both');
    expect(linked(`hold:media_meta:${demo.today}`).linkedIncidents?.map((l) => l.id)).toContain(meta!.id);
    const mr = ps.find((p) => p.keyword === '매트리스 추천')!;
    expect(mr.linkedIncidents?.map((l) => l.id)).toContain(kw!.id);
    expect(mr.basis).toContain(kw!.id);
  });

  it('keyword_spike 의 holdMedia(naver_sa)는 매체 전체 보류로 쓰지 않는다 — SA 상향 · 재배분은 유지', () => {
    expect(heldMedia(alertIncidents)).toContain('naver_sa');
    expect(incidentHoldMap(alertIncidents).media.has('naver_sa')).toBe(false);
    const ps = adpilotProposals(demo, undefined, alertIncidents, []);
    for (const a of AUTO) expect(ps.filter((p) => p.action === a).length).toBe(base.filter((p) => p.action === a).length);
  });

  it('AD Pilot 이 잡지 않은 매체 이슈(Google 테스트 급변) → Google 매체 보류 행 추가, 이슈 id · 제목이 근거', () => {
    const ps = adpilotProposals(demo, undefined, [googleSpike], []);
    expect(ps.length).toBe(base.length + 1);
    const h = ps.find((p) => p.id === `hold:media_google:${demo.today}`)!;
    expect(h.action).toBe('hold');
    expect(h.holdSource).toBe('alert');
    expect(h.basis).toContain(googleSpike.id);
    expect(h.basis).toContain(googleSpike.title);
    expect(h.guard.join(' ')).toContain('AD Pilot 시간대 점검');
  });

  it('네이버 SA 전환 추적 단절 이슈 → SA 입찰 · 예산 자동 조정은 전부 보류(원래 제안 보존), 테스트 후보 · 다른 매체는 그대로', () => {
    const ps = adpilotProposals(demo, undefined, [saBreak], []);
    expect(ps.some((p) => p.media === 'naver_sa' && AUTO.includes(p.action))).toBe(false);
    const q = ps.find((p) => p.keyword === '퀸 매트리스')!;
    const q0 = base.find((p) => p.keyword === '퀸 매트리스')!;
    expect(q.action).toBe('hold');
    expect(q.holdKind).toBe('incident');
    expect(q.id).toBe(`hold:${q0.keywordId}:${demo.today}`);
    expect(q.suppressed).toEqual({ action: q0.action, before: q0.before, after: q0.after, changePct: q0.changePct });
    expect(q.basis).toContain(saBreak.id);
    expect(ps.find((p) => p.id === `hold:media_naver_sa:${demo.today}`)?.holdKind).toBe('tracking_break');
    expect(ps.filter((p) => p.action === 'test_candidate').length).toBe(base.filter((p) => p.action === 'test_candidate').length);
    expect(ps.find((p) => p.id === `hold:media_meta:${demo.today}`)?.linkedIncidents).toBeUndefined();
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
    expect(proposalTexts(ps)).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('키워드 급변 이슈는 해당 키워드만 보류 — 후보가 없던 키워드도 보류 행으로 보인다', () => {
    const queen = inc({ id: 'keyword_spike:퀸 매트리스:2026-10-31', ruleId: 'keyword_spike', media: 'naver_sa', holdMedia: 'naver_sa', target: '퀸 매트리스', title: "'퀸 매트리스' 최근 3일 CPC +60%" });
    const plain = inc({ id: 'keyword_spike:매트리스:2026-10-31', ruleId: 'keyword_spike', media: 'naver_sa', holdMedia: 'naver_sa', target: '매트리스', title: "'매트리스' 최근 3일 전환 -60%" });
    const ps = adpilotProposals(demo, undefined, [queen, plain], []);
    expect(ps.find((p) => p.keyword === '퀸 매트리스')!.action).toBe('hold');
    expect(ps.find((p) => p.keyword === '허리 편안한 매트리스')!.action).toBe('bid_up');
    const k = demo.keywords.find((x) => x.text === '매트리스')!;
    const row = ps.find((p) => p.id === `hold:${k.id}:${demo.today}`)!;
    expect(row.before).toBe(k.bid);
    expect(row.basis).toContain(plain.id);
  });

  it('해결된 이슈 · 보류 해제 요청이 반영된 이슈는 보류하지 않는다 (대기 중 해제 요청은 보류 유지)', () => {
    expect(adpilotProposals(demo, undefined, [{ ...googleSpike, status: 'resolved' }], []).length).toBe(base.length);
    const release = (status: ChangeRequest['status']) => change({ module: 'alert', kind: 'setting', targetId: `alert:${googleSpike.id}:release`, status });
    expect(openHoldIncidents([googleSpike], [release('applied')])).toHaveLength(0);
    expect(openHoldIncidents([googleSpike], [release('pending')])).toHaveLength(1);
    expect(adpilotProposals(demo, undefined, [googleSpike], [release('applied')]).length).toBe(base.length);
    expect(adpilotProposals(demo, undefined, undefined, undefined).length).toBe(base.length);
  });

  it('알림 발송 중복 방지: 보류와 같은 대상의 열린 Alert 이슈를 찾고, 없으면 undefined', () => {
    const kakaoHold = base.find((p) => p.id === `hold:media_kakao:${demo.today}`)!;
    expect(matchingIncident(kakaoHold, alertIncidents, demo)?.ruleId).toBe('tracking_break');
    const gfaHold = base.find((p) => p.holdKind === 'account')!;
    expect(matchingIncident(gfaHold, alertIncidents, demo)?.ruleId).toBe('account_payment');
    expect(matchingIncident(kakaoHold, [], demo)).toBeUndefined();
    expect(matchingIncident(kakaoHold, alertIncidents.map((i) => ({ ...i, status: 'resolved' as const })), demo)).toBeUndefined();
  });

  it('반영 단계 검증: 승인 뒤 매체 · 이슈 보류가 생긴 대상은 반영하지 않는다', () => {
    const q = base.find((p) => p.keyword === '퀸 매트리스' && p.action === 'bid_up')!;
    const c = change({ status: 'approved', targetId: q.keywordId, before: q.before, after: q.after });
    expect(validateAdpilotExecution(demo, c, base).ok).toBe(true);
    const held = adpilotProposals(demo, undefined, [saBreak], []);
    const v = validateAdpilotExecution(demo, c, held);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('보류');
    expect(validateAdpilotExecution(demo, { ...c, status: 'pending' }, base).ok).toBe(false);
    const k = demo.keywords.find((x) => x.id === q.keywordId)!;
    expect(validateAdpilotExecution(demo, { ...c, after: k.maxBid + 10 }, base).ok).toBe(false);
    // Meta 데이터 급변(AD Pilot 자체 매체 보류) → Meta 캠페인 예산 반영 보류
    const meta = demo.campaigns.find((x) => x.name === 'Meta_넓은 타겟')!;
    expect(validateAdpilotExecution(demo, change({ kind: 'budget', status: 'approved', targetId: `budget:${meta.id}:`, before: meta.dailyBudget, after: meta.dailyBudget + 100000 }), base).ok).toBe(false);
    // 상태 변경(품절 일시 중지)은 보류와 무관하게 반영
    expect(validateAdpilotExecution(demo, change({ kind: 'status', status: 'approved', targetId: 'kw_9', before: 'on', after: 'off' }), held).ok).toBe(true);
  });

  it('자동 입찰 검증: 매체 보류 중인 키워드의 수동 입찰 변경은 차단, 보류가 없으면 통과 항목', () => {
    const queen = demo.keywords.find((k) => k.text === '퀸 매트리스')!;
    const bid = Math.round((queen.bid * 1.1) / 10) * 10;
    const held = verifyBidChange(demo, queen, bid, undefined, adpilotProposals(demo, undefined, [saBreak], []));
    expect(held.blocked).toBe(true);
    expect(held.items.find((i) => i.id === 'incident')?.level).toBe('block');
    const free = verifyBidChange(demo, queen, bid, undefined, base);
    expect(free.items.find((i) => i.id === 'incident')?.level).toBe('pass');
    expect(free.blocked).toBe(false);
  });
});

function proposalTexts(ps: readonly { reason: string; expected: string; basis: string; guard: string[] }[]) {
  return ps.map((p) => [p.reason, p.expected, p.basis, ...p.guard].join(' ')).join(' ');
}

/* ------------------------------------------------------------------ */
describe('입찰 하향 0건 설명 · 민감도 보기', () => {
  const diag = diagnoseKeywords(demo);

  it('목표 400%: 하향 0건이며 이유(두 기간 미달 키워드 · 그 사유 · 목표 이상 개수)를 데이터에서 만든다', () => {
    const e = explainBidDown(demo);
    expect(e.count).toBe(generateBidProposals(demo).filter((p) => p.action === 'bid_down').length);
    expect(e.count).toBe(0);
    const pool = diag.filter((d) => !d.isBrand && d.status === 'on');
    expect(e.pool).toBe(pool.length);
    expect(e.belowBoth.map((b) => b.text)).toEqual(pool.filter((d) => d.roas < 400 && d.prevRoas < 400).map((d) => d.text));
    expect(e.belowBoth.find((b) => b.text === '킹 매트리스')?.why).toContain('품절');
    expect(e.aboveCount).toBe(pool.filter((d) => d.roas >= 400).length);
    expect(e.note).toContain('하향 0건');
    expect(e.note).toContain('전환 3건 이상');
    expect(e.note).not.toMatch(/NaN|undefined/);
  });

  it('민감도: 하향 후보가 처음 생기는 목표 ROAS(50%p 단위)와 그 기준의 하향안 — 엔진 판정과 동일', () => {
    const s = explainBidDown(demo).sensitivity!;
    expect(s).toBeTruthy();
    expect(s.target % 50).toBe(0);
    expect(s.target).toBeGreaterThan(400);
    const at = generateBidProposals(demo, { targetRoas: s.target }).filter((p) => p.action === 'bid_down');
    expect(s.proposals.map((p) => p.id)).toEqual(at.map((p) => p.id));
    expect(generateBidProposals(demo, { targetRoas: s.target - 50 }).filter((p) => p.action === 'bid_down')).toHaveLength(0);
    for (const p of s.proposals) {
      const k = demo.keywords.find((x) => x.id === p.keywordId)!;
      expect(k.isBrand).toBe(false);
      expect(k.last14.conversions).toBeGreaterThanOrEqual(3);
      expect(p.changePct).toBeLessThan(0);
      expect(p.changePct).toBeGreaterThanOrEqual(-20);
    }
    expect(s.note).toContain('공식 기준');
  });

  it('하드코딩 아님: 해당 키워드의 직전 14일 효율을 바꾸면 민감도 목표가 따라 움직인다', () => {
    const s0 = explainBidDown(demo).sensitivity!;
    const kid = s0.proposals[0].keywordId;
    const d = clone(demo);
    const k = d.keywords.find((x) => x.id === kid)!;
    k.prev14 = { ...k.prev14, revenue: Math.round(k.prev14.revenue * 1.5) };
    expect(explainBidDown(d).sensitivity?.target ?? Infinity).toBeGreaterThan(s0.target);
  });

  it('하향 후보가 이미 있으면 민감도를 계산하지 않고, 전환 기준을 못 넘으면 표본 부족으로 설명', () => {
    const hi = explainBidDown(demo, { targetRoas: 1100 });
    expect(hi.count).toBeGreaterThan(0);
    expect(hi.sensitivity).toBeNull();
    const strict = explainBidDown(demo, { minConversionsForDown: 100 });
    expect(strict.sensitivity).toBeNull();
    expect(strict.sensitivityNote).toContain('표본');
    expect(explainBidDown({ ...demo, keywords: [] }).count).toBe(0);
  });

  it('브리프: 하향 0건 사유와 민감도를 확정 팩트 · 대체 시나리오로 나눠 담는다', () => {
    const b = adpilotBrief(demo, []);
    expect(b.facts.join(' ')).toContain('하향 0건');
    expect(b.counter.join(' ')).toContain('민감도 보기');
  });
});

/* ------------------------------------------------------------------ */
describe('상향 후보와 캠페인 예산 제한 · 재원 상호작용', () => {
  const ps = generateBidProposals(demo);
  it('조기 소진 캠페인 안의 상향 후보는 예산 제한 가능성을 근거 · SAFETY에 남긴다 (SA_일반 제품 → 퀸 매트리스)', () => {
    const q = ps.find((p) => p.keyword === '퀸 매트리스' && p.action === 'bid_up')!;
    expect(q.guard.join(' ')).toContain('SA_일반 제품');
    expect(q.reason).toContain('예산 제한형');
    const other = ps.find((p) => p.keyword === '허리 편안한 매트리스' && p.action === 'bid_up')!;
    expect(other.guard.join(' ')).not.toContain('조기 소진');
    expect(other.reason).toContain('순위 제한형');
    const d = clone(demo);
    const c = d.campaigns.find((x) => x.name === 'SA_일반 제품')!;
    c.spentToday = Math.round(c.dailyBudget * 0.3);
    expect(generateBidProposals(d).find((p) => p.keyword === '퀸 매트리스')!.guard.join(' ')).not.toContain('SA_일반 제품');
  });
  it('재원 캠페인에 입찰 상향 후보가 있으면 재배분 SAFETY에 함께 반영 시 재원 여유 감소를 경고', () => {
    const shift = ps.find((p) => p.action === 'budget_shift' && p.donor)!;
    const donorIntent = demo.campaigns.find((x) => x.id === shift.donor!.id)!.intent;
    const ups = ps.filter((p) => p.action === 'bid_up' && p.intent === donorIntent && !p.isBrand);
    expect(shift.guard.some((g) => g.startsWith(`재원 ${shift.donor!.name}의 입찰 상향 후보`))).toBe(ups.length > 0);
  });
});

describe('보류 알림 범위', () => {
  const ps = generateBidProposals(demo);
  it('급변 · 추적 단절 · 품절 · 잔액 보류는 Alert 알림 대상, 월 예산 초과 · 효율 미달 보류는 승인 안건이라 제외', () => {
    for (const p of ps.filter((x) => x.action === 'hold')) {
      const expected = !['monthly_over', 'efficiency'].includes(p.holdKind!);
      expect(canNotify(p)).toBe(expected);
    }
    expect(ps.some((p) => p.holdKind === 'monthly_over' || p.holdKind === 'efficiency')).toBe(true);
    expect(ps.filter((p) => p.action !== 'hold').every((p) => !canNotify(p))).toBe(true);
  });
  it('보류 알림 이슈: id 결정적 · 추적 단절과 잔액은 P1 · 급변과 품절은 P2', () => {
    const at = '2026-10-31T06:00:00.000Z';
    const sev = (k: string) => holdIncident(demo, ps.find((p) => p.holdKind === k)!, at).severity;
    expect(sev('tracking_break')).toBe('P1');
    expect(sev('account')).toBe('P1');
    expect(sev('data_spike')).toBe('P2');
    expect(sev('soldout')).toBe('P2');
    const p = ps.find((x) => x.holdKind === 'keyword_anomaly')!;
    expect(holdIncident(demo, p, at).id).toBe(holdIncident(demo, p, '2026-10-31T07:00:00.000Z').id);
  });
});
