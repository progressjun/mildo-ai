/**
 * 매출 성장 엔진 테스트 — 제안서 p.30–42 기준값 · 판정 규칙 · 경계값(빈 데이터 · 0 나누기 · NaN) ·
 * 데모 시나리오가 엔진 계산으로 실제 잡히는지(하드코딩 아님) 검증한다.
 */
import { describe, expect, it } from 'vitest';
import type { DailyMediaRow, Dataset, MediaId } from '@/core/types';
import { DEMO } from '@/data/demo';
import { AD_PILOT, MEDIA, MEDIA_IDS, NEW_MEDIA_PILOT, RFP } from '@/data/constants';
import { addDays, hashString, rng } from '@/core/util';
import { ALLOCATION_GUARDRAILS, CURVE_PRIORS, REBALANCE_RULES } from './data';
import {
  PROPOSAL_SHARES, allocationModel, applyDaSaCredit, belowTargetKeywords, calendarView, cannibalization, coPromoDemand, curveMarginal, curveRevenue, daSaAnalysis,
  defaultPilots, equalizeMarginal, evaluateAllocation, fitLogLog, fitResponseCurves, funnelDiagnosis, funnelRates, growthFormula, growthPrompt, growthSignals,
  holdoutChange, holdoutDesign, keywordCpcSpikes, landingFindings, landingType, marginalCurvePoints, normInv, normalizeShares, ols, pilotChange, pilotPlan,
  reallocationChange, rebalanceShares, requiredConversions, rfpSegmentSummary, saCampaignPerformance, sameWeekdayAdjust, scoreNewMedia, skuExpansionSummary,
  targetGroupView, type ResponseCurve, type Shares,
} from './engine';
import { allocationBrief, campaignBrief, daSaBrief, funnelBrief, newMediaBrief, overviewBrief } from './briefs';

function emptyData(): Dataset {
  return { ...DEMO, dates: [], mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [] };
}
const noBad = (s: string) => expect(s).not.toMatch(/NaN|undefined|Infinity/);
const sumShares = (s: Shares) => MEDIA_IDS.reduce((a, m) => a + s[m], 0);

/** 일 광고비 변동이 큰 합성 데이터: 매출 = a · 광고비^b (매체별 b 지정) */
function syntheticCurves(bByMedia: Partial<Record<MediaId, number>>, days = 100): Dataset {
  const R = rng(hashString('growth-synth'));
  const today = '2026-10-31';
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(addDays(today, -i));
  const mediaDaily: DailyMediaRow[] = [];
  for (const date of dates) {
    for (const m of MEDIA_IDS) {
      const b = bByMedia[m] ?? 0.6;
      const cost = (MEDIA[m].annualBudget / 365) * R.range(0.4, 1.8);
      const revenue = 4 * Math.pow(cost, b) * Math.pow(MEDIA[m].annualBudget / 365, 1 - b) * R.noise(0.02);
      mediaDaily.push({ date, media: m, impressions: 1000, clicks: 100, cost, conversions: revenue / 1e6, revenue, newCustomers: 1 });
    }
  }
  return { ...emptyData(), today, dates, mediaDaily };
}

/* ---------------- 수학 유틸 ---------------- */

describe('수학 유틸', () => {
  it('normInv: 표준정규 역함수 · 범위 밖 NaN', () => {
    expect(normInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normInv(0.5)).toBeCloseTo(0, 4);
    expect(normInv(0.8)).toBeCloseTo(0.8416, 2);
    expect(normInv(0)).toBeNaN();
    expect(normInv(1)).toBeNaN();
    expect(normInv(NaN)).toBeNaN();
  });
  it('ols: 계수 복원 · 특이 행렬 null · 표본 부족 null', () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 30; i++) {
      const x1 = i;
      const x2 = (i * 7) % 11;
      X.push([1, x1, x2]);
      y.push(2 + 3 * x1 - x2);
    }
    const f = ols(X, y)!;
    expect(f.coef[0]).toBeCloseTo(2, 6);
    expect(f.coef[1]).toBeCloseTo(3, 6);
    expect(f.coef[2]).toBeCloseTo(-1, 6);
    expect(f.r2).toBeCloseTo(1, 6);
    expect(ols(X.map((r) => [1, r[1], r[1] * 2]), y)).toBeNull();
    expect(ols([[1, 2]], [3])).toBeNull();
  });
  it('fitLogLog: 순수 거듭제곱 복원 · 0 · 음수 · NaN 제외 · 변동 없음 NaN', () => {
    const c = Array.from({ length: 40 }, (_, i) => 1e6 * (1 + i / 10));
    const r = c.map((x) => 5 * Math.pow(x, 0.6));
    const f = fitLogLog(c, r);
    expect(f.b).toBeCloseTo(0.6, 6);
    expect(f.a).toBeCloseTo(5, 3);
    const dirty = fitLogLog([...c, 0, -5, NaN], [...r, 10, 10, 10]);
    expect(dirty.n).toBe(40);
    expect(fitLogLog([1, 1, 1, 1, 1, 1], [2, 3, 4, 5, 6, 7]).b).toBeNaN();
    expect(fitLogLog([], []).b).toBeNaN();
  });
  it('sameWeekdayAdjust: ±1주 평균 대비 비율, 앞뒤 7일 · 0 기준 NaN', () => {
    const v = Array.from({ length: 21 }, () => 100);
    v[10] = 150;
    const a = sameWeekdayAdjust(v);
    expect(a[10]).toBeCloseTo(0.5, 6);
    expect(a[0]).toBeNaN();
    expect(a[20]).toBeNaN();
    expect(sameWeekdayAdjust(Array.from({ length: 21 }, () => 0))[10]).toBeNaN();
  });
});

/* ---------------- p.37 배분 · 반응 곡선 ---------------- */

describe('p.37 배분 가안 · 반응 곡선', () => {
  it('배분 가안 = SA 43% · GFA 18% · Google 12% · Meta 12% · 카카오 8% · 버티컬 7% (연 50억)', () => {
    expect(PROPOSAL_SHARES).toEqual({ naver_sa: 0.43, naver_gfa: 0.18, google: 0.12, meta: 0.12, kakao: 0.08, vertical: 0.07 });
    expect(sumShares(PROPOSAL_SHARES)).toBeCloseTo(1, 9);
    expect(RFP.annualBudget * PROPOSAL_SHARES.naver_sa).toBe(2_150_000_000);
    expect(MEDIA_IDS.map((m) => MEDIA[m].annualBudget).reduce((a, b) => a + b, 0)).toBe(5_000_000_000);
    for (const m of MEDIA_IDS) {
      expect(ALLOCATION_GUARDRAILS[m].min).toBeLessThanOrEqual(PROPOSAL_SHARES[m]);
      expect(ALLOCATION_GUARDRAILS[m].max).toBeGreaterThanOrEqual(PROPOSAL_SHARES[m]);
    }
  });

  it('데모: 6개 매체 모두 적합 b의 95% 상한이 1 이상 → 체감 미식별 → 사전 가정 b 사용 (데이터 판정)', () => {
    const curves = fitResponseCurves(DEMO);
    expect(curves).toHaveLength(6);
    for (const c of curves) {
      expect(c.valid).toBe(true);
      expect(c.days).toBe(90);
      expect(c.fit.n).toBe(90);
      expect(c.fit.ciHigh).toBeGreaterThanOrEqual(1);
      expect(c.identified).toBe(false);
      expect(c.bSource).toBe('prior');
      expect(c.b).toBe(CURVE_PRIORS[c.media].b);
      expect(c.identifyNote).toContain('체감 미식별');
      expect(c.costCv).toBeGreaterThan(0.05);
      // 운영점(평균 일 광고비)을 지나도록 보정
      expect(curveRevenue(c, c.avgDailyCost) / c.avgDailyRevenue).toBeCloseTo(1, 6);
    }
  });

  it('합성 데이터: 변동폭이 크면 b<1이 데이터로 식별되어 적합 b를 쓴다', () => {
    const d = syntheticCurves({ naver_sa: 0.5, kakao: 0.4 });
    const curves = fitResponseCurves(d);
    const sa = curves.find((c) => c.media === 'naver_sa')!;
    const ka = curves.find((c) => c.media === 'kakao')!;
    expect(sa.identified).toBe(true);
    expect(sa.bSource).toBe('data');
    expect(sa.b).toBeCloseTo(0.5, 1);
    expect(ka.b).toBeCloseTo(0.4, 1);
  });

  it('수동 b 입력은 0.05~0.98로 제한, 한계 ROAS = b × 평균 ROAS (운영점)', () => {
    const curves = fitResponseCurves(DEMO, { bOverride: { naver_sa: 1.5, kakao: -1 } });
    expect(curves.find((c) => c.media === 'naver_sa')!.b).toBe(0.98);
    expect(curves.find((c) => c.media === 'kakao')!.b).toBe(0.05);
    for (const c of fitResponseCurves(DEMO)) {
      expect(curveMarginal(c, c.avgDailyCost) * 100).toBeCloseTo(c.b * c.roas, 3);
    }
  });

  it('볼륨 한계: 상한 이후 매출 증가 0 · 한계 ROAS 0, SA 상한은 노출 손실률로 계산', () => {
    const curves = fitResponseCurves(DEMO);
    const sa = curves.find((c) => c.media === 'naver_sa')!;
    expect(sa.capMult).toBeGreaterThan(1.3);
    expect(sa.capBasis).toContain('노출 기회 손실');
    expect(curveRevenue(sa, sa.capDaily * 2)).toBeCloseTo(curveRevenue(sa, sa.capDaily), 3);
    expect(curveMarginal(sa, sa.capDaily * 1.01)).toBe(0);
    expect(curveRevenue(sa, 0)).toBe(0);
    expect(curveRevenue(sa, -100)).toBe(0);
  });

  it('normalizeShares · rebalanceShares: 합계 100% 유지 · 비례 조정 · 경계값', () => {
    expect(normalizeShares({})).toEqual(PROPOSAL_SHARES);
    expect(normalizeShares({ naver_sa: NaN, kakao: -3 })).toEqual(PROPOSAL_SHARES);
    const n = normalizeShares({ naver_sa: 2, kakao: 2 });
    expect(n.naver_sa).toBeCloseTo(0.5);
    expect(n.google).toBe(0);
    const r = rebalanceShares(PROPOSAL_SHARES, 'naver_sa', 0.5);
    expect(r.naver_sa).toBe(0.5);
    expect(sumShares(r)).toBeCloseTo(1, 9);
    expect(r.naver_gfa / r.google).toBeCloseTo(PROPOSAL_SHARES.naver_gfa / PROPOSAL_SHARES.google, 9);
    expect(rebalanceShares(PROPOSAL_SHARES, 'kakao', 2).kakao).toBe(1);
    const lone = rebalanceShares({ naver_sa: 1, naver_gfa: 0, google: 0, meta: 0, kakao: 0, vertical: 0 }, 'naver_sa', 0.5);
    expect(lone.naver_gfa).toBeCloseTo(0.1);
    expect(sumShares(rebalanceShares(PROPOSAL_SHARES, 'meta', NaN))).toBeCloseTo(1, 9);
  });

  it('evaluateAllocation: 데모 가안의 한계 ROAS 최고 SA · 최저 카카오, 가드레일 위반 · 볼륨 초과 표시', () => {
    const curves = fitResponseCurves(DEMO);
    const base = evaluateAllocation(curves, PROPOSAL_SHARES, RFP.annualBudget);
    expect(base.valid).toBe(true);
    expect(base.spread.maxMedia).toBe('naver_sa');
    expect(base.spread.minMedia).toBe('kakao');
    expect(base.spread.gapPct).toBeGreaterThan(50);
    expect(base.guardViolations).toEqual([]);
    expect(base.totalRoas).toBeGreaterThan(300);
    const skew = evaluateAllocation(curves, rebalanceShares(PROPOSAL_SHARES, 'kakao', 0.3), RFP.annualBudget);
    expect(skew.guardViolations).toContain('kakao');
    expect(skew.capped).toContain('kakao');
    expect(skew.rows.find((r) => r.media === 'kakao')!.overCapAnnual).toBeGreaterThan(0);
    expect(skew.totalRevenue).toBeLessThan(base.totalRevenue);
  });

  it('evaluateAllocation: 예산 0 · 빈 데이터에서 예외 없이 valid=false', () => {
    const curves = fitResponseCurves(DEMO);
    const z = evaluateAllocation(curves, PROPOSAL_SHARES, 0);
    expect(z.valid).toBe(false);
    const e = evaluateAllocation(fitResponseCurves(emptyData()), PROPOSAL_SHARES, RFP.annualBudget);
    expect(e.valid).toBe(false);
    expect(e.totalRevenue).toBeNaN();
    expect(e.spread.maxMedia).toBeNull();
  });
});

describe('p.37 한계 효율 균등화', () => {
  const curves = fitResponseCurves(DEMO);
  const B = RFP.annualBudget;

  it('균등화안: 합계 100% · 가드레일 · 재배분 폭(±20%) 안 · 내부해 매체의 한계 ROAS가 같다', () => {
    const eq = equalizeMarginal(curves, B);
    expect(eq.feasible).toBe(true);
    expect(eq.relaxed).toEqual([]);
    expect(sumShares(eq.shares)).toBeCloseTo(1, 6);
    const ev = evaluateAllocation(curves, eq.shares, B);
    for (const m of MEDIA_IDS) {
      const s = eq.shares[m];
      expect(s).toBeGreaterThanOrEqual(ALLOCATION_GUARDRAILS[m].min - 1e-9);
      expect(s).toBeLessThanOrEqual(ALLOCATION_GUARDRAILS[m].max + 1e-9);
      expect(s).toBeGreaterThanOrEqual(PROPOSAL_SHARES[m] * (1 - REBALANCE_RULES.stepCapPct / 100) - 1e-9);
      expect(s).toBeLessThanOrEqual(PROPOSAL_SHARES[m] * (1 + REBALANCE_RULES.stepCapPct / 100) + 1e-9);
      const row = ev.rows.find((r) => r.media === m)!;
      if (eq.binding[m] === null) expect(row.marginalRoas).toBeCloseTo(eq.marginalRoas, 0);
      if (eq.binding[m] === 'max' || eq.binding[m] === 'step' && s > PROPOSAL_SHARES[m]) expect(row.marginalRoas).toBeGreaterThanOrEqual(eq.marginalRoas - 1);
    }
    // 데이터 기반 방향: 한계 ROAS가 높은 SA는 증액, 낮은 카카오는 감액
    expect(eq.shares.naver_sa).toBeGreaterThan(PROPOSAL_SHARES.naver_sa);
    expect(eq.shares.kakao).toBeLessThan(PROPOSAL_SHARES.kakao);
    // 균등화안이 가안보다 나쁘지 않다 (가안은 제약 안의 실행 가능한 해)
    const base = evaluateAllocation(curves, PROPOSAL_SHARES, B);
    expect(ev.totalRevenue).toBeGreaterThanOrEqual(base.totalRevenue - 1);
  });

  it('재배분 폭 상한이 없으면 더 많이 이동하고 증분이 커진다', () => {
    const a = evaluateAllocation(curves, equalizeMarginal(curves, B).shares, B);
    const free = equalizeMarginal(curves, B, { stepCapPct: null });
    const b = evaluateAllocation(curves, free.shares, B);
    expect(b.totalRevenue).toBeGreaterThanOrEqual(a.totalRevenue - 1);
  });

  it('가드레일 합계가 예산과 맞지 않으면 가드레일을 해제하고 표시', () => {
    const tight = Object.fromEntries(MEDIA_IDS.map((m) => [m, { min: 0.3, max: 0.4 }])) as typeof ALLOCATION_GUARDRAILS;
    const eq = equalizeMarginal(curves, B, { guard: tight });
    expect(eq.relaxed).toContain('guard');
    expect(eq.note).toContain('가드레일');
    expect(sumShares(eq.shares)).toBeCloseTo(1, 6);
  });

  it('볼륨 한계 합계 < 예산이면 feasible=false', () => {
    const tiny: ResponseCurve[] = curves.map((c) => ({ ...c, capDaily: c.avgDailyCost * 0.1 }));
    const eq = equalizeMarginal(tiny, B);
    expect(eq.feasible).toBe(false);
    expect(eq.note).toContain('볼륨 한계');
  });

  it('빈 데이터 · 예산 0: 가안 유지 · 예외 없음', () => {
    const e = equalizeMarginal(fitResponseCurves(emptyData()), B);
    expect(e.feasible).toBe(false);
    expect(e.shares).toEqual(PROPOSAL_SHARES);
    expect(equalizeMarginal(curves, 0).feasible).toBe(false);
  });

  it('marginalCurvePoints: 배분 배수가 커질수록 한계 ROAS 감소 (b<1)', () => {
    for (const s of marginalCurvePoints(curves, B)) {
      const ys = s.points.map((p) => p.y).filter((v) => v > 0);
      for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
    }
  });
});

describe('DA→SA 기여 반영 · 시뮬레이터 묶음', () => {
  it('applyDaSaCredit: 운영점 합계 매출 유지 · GFA 한계 ROAS 상승 · SA 하락 · halo ≤ 0이면 변화 없음', () => {
    const curves = fitResponseCurves(DEMO);
    const halo = daSaAnalysis(DEMO).halo.haloRoas;
    const cr = applyDaSaCredit(curves, halo);
    const at = (cs: ResponseCurve[]) => evaluateAllocation(cs, PROPOSAL_SHARES, RFP.annualBudget);
    const b0 = at(curves);
    const b1 = at(cr);
    // 가안 ≈ 관측 운영점이므로 합계는 거의 같다
    expect(Math.abs(b1.totalRevenue / b0.totalRevenue - 1)).toBeLessThan(0.01);
    const g = (e: typeof b0, m: MediaId) => e.rows.find((r) => r.media === m)!.marginalRoas;
    expect(g(b1, 'naver_gfa')).toBeGreaterThan(g(b0, 'naver_gfa'));
    expect(g(b1, 'naver_sa')).toBeLessThan(g(b0, 'naver_sa'));
    expect(cr.find((c) => c.media === 'naver_gfa')!.creditNote).toContain('SA 경유');
    expect(applyDaSaCredit(curves, 0)).toEqual(curves);
    expect(applyDaSaCredit(curves, NaN)).toEqual(curves);
  });

  it('allocationModel(데모): 균등화 증분 > 0 · b ±0.1 범위 · DA→SA 기여 반영 시 GFA 결론이 바뀐다', () => {
    const m = allocationModel(DEMO);
    expect(m.upliftOptimized).toBeGreaterThan(0);
    expect(m.upliftOptimizedPct).toBeGreaterThan(0);
    expect(m.sensitivity.low).toBeGreaterThan(0);
    expect(m.sensitivity.low).toBeLessThanOrEqual(m.sensitivity.high);
    expect(m.upliftScenario).toBeCloseTo(0, 0);
    expect(m.identifiedCount).toBe(0);
    const c = allocationModel(DEMO, { daSaCredit: true });
    expect(c.credit.on).toBe(true);
    expect(c.credit.haloRoas).toBeGreaterThan(0);
    expect(m.equalize.shares.naver_gfa).toBeLessThan(PROPOSAL_SHARES.naver_gfa);
    expect(c.equalize.shares.naver_gfa).toBeGreaterThan(PROPOSAL_SHARES.naver_gfa);
    const s = allocationModel(DEMO, { shares: { naver_sa: 0.5 } });
    expect(sumShares(s.scenarioShares)).toBeCloseTo(1, 9);
    expect(allocationModel(DEMO, { budget: -5 }).budget).toBe(RFP.annualBudget);
  });

  it('allocationModel(빈 데이터): 예외 없이 무효 표시', () => {
    const m = allocationModel(emptyData());
    expect(m.baseline.valid).toBe(false);
    expect(m.upliftOptimized).toBeNaN();
    expect(m.equalize.feasible).toBe(false);
  });

  it('reallocationChange: 예산 · 구조 변경 → module growth · kind budget · 수면밀도 승인 (p.53)', () => {
    const m = allocationModel(DEMO);
    const c = reallocationChange(m, 'optimized', 'PM');
    expect(c).toMatchObject({ module: 'growth', kind: 'budget', approver: 'CLIENT', requestedBy: 'PM' });
    expect(c.before).toContain('SA 43.0%');
    expect(c.changePct).toBeGreaterThan(0);
    noBad(JSON.stringify(c));
  });
});

/* ---------------- p.40 DA → SA ---------------- */

describe('p.40 DA → SA 전환 기여', () => {
  it('데모: 보정 후 최적 시차 1~2일 (GFA → 브랜드 검색), 원계열은 시차 0이 최고(요일 공통 요인)', () => {
    const ds = daSaAnalysis(DEMO);
    expect(ds.valid).toBe(true);
    expect(ds.n).toBeGreaterThan(90);
    expect(ds.lags).toHaveLength(8);
    expect([1, 2]).toContain(ds.bestLag);
    expect(ds.bestR).toBeGreaterThan(ds.threshold);
    expect(ds.rawBestLag).toBe(0);
    expect(ds.lags[0].raw).toBeGreaterThan(ds.lags[0].adjusted);
    expect(ds.slope.perMillion).toBeGreaterThan(0);
    expect(ds.slope.t).toBeGreaterThan(2);
    expect(ds.dl.lagsUsed).toContain(1);
    expect(ds.dl.lagsUsed).not.toContain(0);
    expect(ds.daShareBrand).toBeGreaterThan(0.15);
    expect(ds.daShareBrand).toBeLessThan(0.6);
  });

  it('데모: SA 전환은 GFA와 유의한 시차 동행이 없다 (전환 연결은 홀드아웃으로 확인)', () => {
    const ds = daSaAnalysis(DEMO);
    expect(ds.saLink.significant).toBe(false);
    expect(ds.lags.every((l) => !l.saSignificant)).toBe(true);
  });

  it('METHOD 3: 브랜드 키워드는 METHOD 1 추정 비중, 비브랜드는 데모 가정 · halo ROAS > 0', () => {
    const ds = daSaAnalysis(DEMO);
    const brand = ds.method3.rows.filter((r) => r.isBrand);
    expect(brand.length).toBe(DEMO.keywords.filter((k) => k.isBrand).length);
    for (const r of brand) {
      expect(r.shareBasis).toBe('METHOD 1 추정');
      expect(r.share).toBeCloseTo(ds.daShareBrand, 9);
    }
    expect(ds.method3.rows.filter((r) => !r.isBrand).every((r) => r.shareBasis === '데모 가정')).toBe(true);
    expect(ds.method3.daShareOfSa).toBeGreaterThan(0);
    expect(ds.method3.daShareOfSa).toBeLessThan(1);
    expect(ds.halo.haloRoas).toBeGreaterThan(0);
  });

  it('합성: GFA 효과가 3일 시차면 최적 시차 3일을 찾는다', () => {
    const gfa = new Map(DEMO.mediaDaily.filter((r) => r.media === 'naver_gfa').map((r) => [r.date, r.cost]));
    const brandSearchDaily = DEMO.dates.map((date) => ({ date, volume: Math.round(2000 + (gfa.get(addDays(date, -3)) ?? 2_400_000) / 800) }));
    const d = { ...DEMO, brandSearchDaily };
    expect(daSaAnalysis(d).bestLag).toBe(3);
  });

  it('합성: 브랜드 검색이 GFA와 무관하면 유의 시차 없음 → 기여 0', () => {
    const R = rng(7);
    const brandSearchDaily = DEMO.dates.map((date) => ({ date, volume: Math.round(4000 * R.noise(0.08)) }));
    const ds = daSaAnalysis({ ...DEMO, brandSearchDaily });
    expect(ds.bestLag).toBeNull();
    expect(ds.daShareBrand).toBe(0);
  });

  it('빈 데이터 · 짧은 데이터: 예외 없음 · valid=false', () => {
    const e = daSaAnalysis(emptyData());
    expect(e.valid).toBe(false);
    expect(e.bestLag).toBeNull();
    expect(e.method3.rows).toEqual([]);
    const short = { ...DEMO, dates: DEMO.dates.slice(-10) };
    expect(daSaAnalysis(short).valid).toBe(false);
  });
});

describe('METHOD 2 홀드아웃 설계', () => {
  it('필요 기간: MDE가 클수록 짧고, 기간 단위 > 지역 단위, SA 전환 지표 ≫ 브랜드 검색 지표 (데모)', () => {
    const h5 = holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 5 });
    const h10 = holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 10 });
    const p10 = holdoutDesign(DEMO, { unit: 'period', metric: 'brand_search', mdePct: 10 });
    const c10 = holdoutDesign(DEMO, { unit: 'region', metric: 'sa_brand_conv', mdePct: 10 });
    expect(h10.valid).toBe(true);
    expect(h5.requiredDays).toBeGreaterThan(h10.requiredDays);
    expect(p10.recommendedDays).toBeGreaterThan(h10.recommendedDays);
    expect(c10.requiredDays).toBeGreaterThan(h10.requiredDays * 5);
    expect(h10.recommendedDays % 7).toBe(0);
    expect(h10.recommendedDays).toBeGreaterThanOrEqual(14);
    expect(h10.unspentSpend).toBeGreaterThan(0);
    expect(h10.revenueAtRisk).toBeGreaterThan(h10.unspentSpend);
    expect(h10.detectable).toBe(true);
  });

  it('검출 가능 효과(MDE) ↔ 필요 기간이 서로 역함수 관계', () => {
    const h = holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 8 });
    const back = holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 8, days: h.requiredDays });
    expect(back.mdeAtDays).toBeLessThanOrEqual(8 + 1e-9);
    const z = holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 1.96 });
    expect(z.zAlpha).toBeCloseTo(1.96, 2);
    expect(z.zBeta).toBeCloseTo(0.8416, 2);
  });

  it('MDE 0 · 빈 데이터: NaN 방어 · valid=false', () => {
    expect(holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 0 }).valid).toBe(false);
    const e = holdoutDesign(emptyData(), { unit: 'audience', metric: 'sa_brand_conv', mdePct: 10 });
    expect(e.valid).toBe(false);
    expect(e.note).toContain('부족');
    const c = holdoutChange(holdoutDesign(DEMO, { unit: 'region', metric: 'brand_search', mdePct: 10 }), 10, 'PM');
    expect(c).toMatchObject({ module: 'growth', kind: 'test', approver: 'CLIENT' });
  });
});

/* ---------------- p.41 전환 개선 ---------------- */

describe('p.41 브랜드스토어 · 자사몰 전환 개선', () => {
  it('데모: 자사몰 장바구니 → 구매 단계가 우선 개선 단계 (브랜드스토어 대비 −20% 이하)', () => {
    const f = funnelDiagnosis(DEMO);
    expect(f.valid).toBe(true);
    expect(f.window.days).toBe(14);
    expect(f.priority?.stage).toBe('cart');
    expect(f.priority?.focus).toBe('own_mall');
    expect(f.priority!.gapPct).toBeLessThanOrEqual(-20);
    expect(f.priority!.omAction).toBe('CRM 연계 검토');
    expect(f.upside.addOrders).toBeGreaterThan(0);
    expect(f.upside.addRevenueMonthly).toBeGreaterThan(0);
    const detail = f.stages.find((s) => s.stage === 'detail')!;
    expect(Math.abs(detail.gapPct)).toBeLessThan(10);
  });

  it('데모: 비교 · 검토 키워드가 리뷰 · 비교 대신 상품 상세로 랜딩 · 킹 옵션 품절 랜딩', () => {
    const l = landingFindings(DEMO);
    expect(l.mismatches.length).toBeGreaterThan(0);
    for (const m of l.mismatches) {
      expect(m.intent).toBe('compare');
      expect(m.expected).toBe('리뷰 · 비교');
      expect(m.actual).toBe('상품 상세');
    }
    expect(l.soldout.map((s) => s.keyword)).toContain('킹 매트리스');
    expect(l.soldout.find((s) => s.keyword === '킹 매트리스')!.option).toBe('킹');
    const visit = funnelDiagnosis(DEMO).stages.find((s) => s.stage === 'visit')!;
    expect(visit.reasons.join(' ')).toContain('품절');
    // 재고가 돌아오면 품절 랜딩이 사라진다 (데이터 판정)
    const restocked = { ...DEMO, products: DEMO.products.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o, inStock: true })) })) };
    expect(landingFindings(restocked).soldout).toEqual([]);
  });

  it('landingType: URL → p.35 랜딩 유형', () => {
    expect(landingType('https://brand.naver.com/mildo')).toBe('브랜드스토어 메인');
    expect(landingType('https://brand.naver.com/mildo/products')).toBe('상품 상세');
    expect(landingType('https://mildo.kr/guide')).toBe('선택 가이드');
    expect(landingType('https://mildo.kr/event')).toBe('기획전 · 자사몰');
    expect(landingType('https://example.com')).toBe('기타');
  });

  it('잠식: 데모는 두 채널 동반 증가 → 잠식 신호 없음, 합성 상쇄 패턴 → 잠식 의심', () => {
    const c = cannibalization(DEMO);
    expect(c.flag).toBe('none');
    expect(c.benefitGap).toContain('자사몰 전용 혜택 없음');
    const cut = addDays(DEMO.today, -14);
    const salesDaily = DEMO.salesDaily.map((r) => {
      if (r.date < cut || r.date >= DEMO.today) return r;
      if (r.channel === 'brandstore') return { ...r, revenue: r.revenue * 0.82 };
      if (r.channel === 'own_mall') return { ...r, revenue: r.revenue * 1.48 };
      return r;
    });
    const s = cannibalization({ ...DEMO, salesDaily });
    expect(s.flag).toBe('suspect');
    expect(Math.abs(s.combined.deltaPct)).toBeLessThan(3);
    expect(s.bs.deltaPct).toBeLessThan(-5);
    expect(s.om.deltaPct).toBeGreaterThan(5);
  });

  it('빈 데이터 · 0 방문: 비율 NaN · 예외 없음', () => {
    const f = funnelDiagnosis(emptyData());
    expect(f.valid).toBe(false);
    expect(f.priority).toBeNull();
    expect(f.cannibal.flag).toBe('nodata');
    const r = funnelRates({ visitors: 0, detailViews: 0, carts: 0, orders: 0, revenue: 0 });
    expect(r.cvr).toBeNaN();
    expect(r.aov).toBeNaN();
  });
});

/* ---------------- p.34–36 타겟 · SA 캠페인 · SKU ---------------- */

describe('p.34–36 타겟 그룹 · SA 캠페인 · SKU', () => {
  it('RFP 세그먼트: 상위 4개 51% · 여성 31~50세 36%', () => {
    const s = rfpSegmentSummary();
    expect(Math.round(s.top4Share * 100)).toBe(51);
    expect(Math.round(s.female3150Share * 100)).toBe(36);
  });

  it('타겟 그룹 A~E: 근거 구분(RFP 데이터 · 테스트 가설 · 동의 데이터) + 연결 지표', () => {
    const g = targetGroupView(DEMO);
    expect(g.map((x) => x.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(g.map((x) => x.basis)).toEqual(['RFP 데이터', 'RFP 데이터', '테스트 가설', '테스트 가설', '동의 데이터']);
    for (const x of g) expect(x.metrics.length).toBe(3);
    for (const x of targetGroupView(emptyData())) expect(x.metrics.length).toBe(3);
  });

  it('SA 5개 캠페인: 의도별 집계 · 매출 비중 합 100% · 브랜드는 목표 800% 기준 · 판정 근거 병기', () => {
    const c = saCampaignPerformance(DEMO);
    expect(c.map((x) => x.name)).toEqual(['브랜드 방어', '일반 제품', '문제 해결', '비교 · 검토', '생활 상황']);
    expect(c.reduce((a, x) => a + x.revenueShare, 0)).toBeCloseTo(1, 6);
    const brand = c[0];
    expect(brand.target).toBe(AD_PILOT.brandTargetRoas);
    expect(c[1].target).toBe(AD_PILOT.targetRoas);
    for (const x of c) {
      expect(x.basis).toContain('목표 ROAS');
      const expectExpand = x.ratioPct >= 130 && x.lostShare >= 0.25;
      expect(x.verdict === 'expand').toBe(expectExpand);
    }
    expect(c.find((x) => x.intent === 'compare')!.landingMismatch).toBeGreaterThan(0);
    const e = saCampaignPerformance(emptyData());
    expect(e.every((x) => x.verdict === 'nodata')).toBe(true);
    noBad(e.map((x) => x.basis).join(' '));
  });

  it('SKU 확장: 제품 1 × 문제 4 × 상황 4 × 비교 3 = 48', () => {
    const s = skuExpansionSummary();
    expect(s.total).toBe(48);
    expect(s.examples.length).toBeGreaterThan(0);
  });

  it('키워드 보조 신호: 데모 \'매트리스 추천\' 최근 3일 CPC 급등 · 목표 미달 키워드 계산', () => {
    expect(keywordCpcSpikes(DEMO).map((x) => x.keyword)).toContain('매트리스 추천');
    const below = belowTargetKeywords(DEMO);
    for (const k of below) expect(k.roas).toBeLessThan(k.target);
    expect(keywordCpcSpikes(emptyData())).toEqual([]);
  });
});

/* ---------------- p.38–39 신규 매체 · 코프로모션 ---------------- */

describe('p.38 신규 매체 · p.39 코프로모션', () => {
  it('점수: 가중치 합 기준 0~100, 가중치를 바꾸면 순위가 바뀐다 · 가중치 0이면 NaN', () => {
    const r = scoreNewMedia();
    expect(r).toHaveLength(NEW_MEDIA_PILOT.candidates.length);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
    for (const x of r) {
      expect(x.total).toBeGreaterThan(0);
      expect(x.total).toBeLessThanOrEqual(100);
    }
    const brandOnly = scoreNewMedia({ fit: 0, context: 0, measure: 0, cost: 0, brand: 100 });
    expect(brandOnly[0].name).toBe('영상 · YouTube');
    expect(brandOnly[0].total).toBe(100);
    const zero = scoreNewMedia({ fit: 0, context: 0, measure: 0, cost: 0, brand: 0 });
    expect(zero.every((x) => Number.isNaN(x.total))).toBe(true);
  });

  it('파일럿: 한도 = 연 예산 5% = 2.5억 · 4주 · 필요 전환 (±25%, 95%) = 62건 · 한도 초과 · 표본 부족 판정', () => {
    expect(requiredConversions(0.25, 0.95)).toBe(62);
    expect(requiredConversions(0)).toBeNaN();
    const ranked = scoreNewMedia();
    const plan = pilotPlan(DEMO, defaultPilots(ranked), { marginalRoas: 230 });
    expect(plan.cap).toBe(250_000_000);
    expect(plan.rows.every((x) => x.weeks === 4)).toBe(true);
    expect(plan.threshold).toBe(230);
    expect(plan.rows.filter((x) => x.budget > 0)).toHaveLength(3);
    expect(plan.overCap).toBe(false);
    expect(plan.baseCpa).toBeGreaterThan(0);
    const over = pilotPlan(DEMO, [{ name: '영상 · YouTube', budget: 300_000_000 }]);
    expect(over.overCap).toBe(true);
    expect(over.threshold).toBe(AD_PILOT.targetRoas);
    const small = pilotPlan(DEMO, [{ name: '영상 · YouTube', budget: 5_000_000 }]).rows[0];
    expect(small.status).toBe('short');
    expect(small.budgetForMin).toBeGreaterThan(small.budget);
    expect(pilotPlan(DEMO, [{ name: '금융 · 리워드 앱', budget: 0 }]).rows[0].status).toBe('off');
    const e = pilotPlan(emptyData(), [{ name: '영상 · YouTube', budget: 10_000_000 }]).rows[0];
    expect(e.feasible).toBe(false);
    expect(pilotChange(plan.rows[0], 'PM')).toMatchObject({ module: 'growth', kind: 'test', approver: 'CLIENT' });
  });

  it('코프로모션: 4개 구매 순간 · 관련 키워드 검색 수요 연결', () => {
    const c = coPromoDemand(DEMO);
    expect(c.map((x) => x.moment)).toEqual(['신혼', '이사 · 입주', '숙면 환경', '선물']);
    expect(c[0].keywords).toContain('신혼 매트리스');
    expect(c[0].monthlySearch).toBeGreaterThan(0);
    expect(coPromoDemand(emptyData()).every((x) => x.monthlySearch === 0)).toBe(true);
  });
});

/* ---------------- p.30 · p.42 · 첫 화면 신호 ---------------- */

describe('성장 공식 · 캘린더 · 신호 · 프롬프트 · 브리프', () => {
  it('캘린더: 기준일 2026-10-31 → 2027 Q1까지 62일', () => {
    const c = calendarView(DEMO);
    expect(c.map((x) => x.q)).toEqual(['2027 Q1', '2027 Q2', '2027 Q3', '2027 Q4']);
    expect(c[0].daysUntil).toBe(62);
  });

  it('성장 공식 4축: 줄인 시간 주 635분 (1,070 → 435) 등', () => {
    const f = growthFormula(DEMO);
    expect(f.map((x) => x.title)).toEqual(['줄인 시간', '매체 파워', '새 수요', '기본기']);
    expect(f[0].value).toBe('주 635분');
    expect(f[2].value).toBe('2.50억');
    for (const x of f) noBad(`${x.value} ${x.foot}`);
    for (const x of growthFormula(emptyData())) noBad(`${x.value} ${x.foot}`);
  });

  it('첫 화면 신호: 데모 시나리오(한계 격차 · DA→SA · 자사몰 퍼널 · 랜딩/품절 · SA 확대 · 신규 매체)를 데이터로 잡는다', () => {
    const s = growthSignals(DEMO);
    expect(s.map((x) => x.id)).toEqual(['marginal_gap', 'da_sa', 'funnel', 'landing', 'sa_expand', 'new_media']);
    expect(s.find((x) => x.id === 'landing')!.basis).toContain('킹 매트리스');
    expect(s.find((x) => x.id === 'funnel')!.title).toContain('자사몰');
    for (const x of s) noBad(`${x.title} ${x.basis}`);
    const e = growthSignals(emptyData());
    for (const x of e) noBad(`${x.title} ${x.basis}`);
  });

  it('프롬프트: TEST DATA 표기 + JSON 데이터 포함', () => {
    for (const k of ['overview', 'alloc', 'dasa', 'funnel', 'demand', 'target'] as const) {
      const p = growthPrompt(k, DEMO);
      expect(p).toContain('TEST DATA');
      expect(p).toContain('데이터(JSON)');
      expect(p).not.toContain('NaN');
    }
  });

  it('브리프: 6개 영역 구조 · 번호 매기기 금지 · NaN 없음 (데모 · 빈 데이터)', () => {
    for (const d of [DEMO, emptyData()]) {
      for (const b of [allocationBrief(d), allocationBrief(d, { daSaCredit: true }), daSaBrief(d), funnelBrief(d), campaignBrief(d), newMediaBrief(d), overviewBrief(d)]) {
        expect(b.title).toBeTruthy();
        expect(b.facts.length + b.patterns.length + b.interpretation.length).toBeGreaterThan(0);
        const all = [...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions].join('\n');
        expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
        noBad(all);
      }
    }
  });
});
