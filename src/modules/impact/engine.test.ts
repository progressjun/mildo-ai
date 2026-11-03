/**
 * 성과 증명 엔진 단위 테스트 — 합성 데이터에서 알려진 증분을 구간 안에서 되찾는지, 표본 부족 판정, 손실 회피 시간 비율,
 * 자연 발견 시각(주말 · 공휴일), 자동화 절감 상한, 월간 요약 · 회수 배수 산식, 가치 리포트 영역 구분, CSV.
 */
import { describe, expect, it } from 'vitest';
import { rng } from '@/core/util';
import { DEMO } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import {
  AUTOMATION_UNITS, automationSavings, buildDemoImpact, buildSummary, buildValueReport, businessDaysIn, datesBetween, estimateLossAvoided, estimateUplift,
  csvCell, impactConfig, kstMsOf, ledgerCsv, naturalDiscoveryMs, paybackVerdict, profitAt, statusText, sufficiency, DEFAULT_HOURLY_COST, DEFAULT_MARGIN, DEFAULT_MONTHLY_FEE,
  type DayMetrics, type LedgerEntry, type UpliftEstimate,
} from './engine';

const BEFORE = datesBetween('2026-10-01', '2026-10-07');
const AFTER = datesBetween('2026-10-09', '2026-10-15');

/** 공통 일별 변동(f) · 기간 충격(shock)을 처리군과 대조군이 같이 겪고, 처리군에만 반영 후 하루 upliftPerDay를 더한다 */
function synth(o: { seed: number; base: number; controlBase: number; shock: number; upliftPerDay: number; clicksPerDay?: number; convPerDay?: number }) {
  const r = rng(o.seed);
  const treated: Record<string, DayMetrics> = {};
  const control: Record<string, DayMetrics> = {};
  const day = (date: string, after: boolean) => {
    const f = r.noise(0.12);
    const s = after ? o.shock : 1;
    const t = o.base * f * s * r.noise(0.02) + (after ? o.upliftPerDay : 0);
    const c = o.controlBase * f * s * r.noise(0.02);
    const clicks = o.clicksPerDay ?? 80;
    const conv = o.convPerDay ?? 4;
    treated[date] = { date, clicks, cost: Math.round(t / 4), conversions: conv, revenue: Math.round(t) };
    control[date] = { date, clicks: clicks * 3, cost: Math.round(c / 4), conversions: conv * 3, revenue: Math.round(c) };
  };
  BEFORE.forEach((d) => day(d, false));
  AFTER.forEach((d) => day(d, true));
  return { treated, control };
}

describe('증분 추정 (스케일 차분 · 부트스트랩 80% 구간)', () => {
  it('공통 충격(+10%)이 있어도 알려진 증분(하루 30만 × 7일 = 210만)을 구간 안에서 되찾는다', () => {
    const truth = 300_000 * 7;
    const { treated, control } = synth({ seed: 7, base: 2_000_000, controlBase: 5_000_000, shock: 1.1, upliftPerDay: 300_000 });
    const e = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 4, margin: 0.4, seed: 'kw1' });
    expect(e.method).toBe('did_scaled');
    expect(e.ci[0]).toBeLessThanOrEqual(truth);
    expect(e.ci[1]).toBeGreaterThanOrEqual(truth);
    expect(Math.abs(e.revenue - truth) / truth).toBeLessThan(0.35);
    expect(e.controlRatio.revenue).not.toBeNull();
    // 대조 보정 반사실 = 처리 전 × 대조 변화율
    const tb = BEFORE.reduce((a, d) => a + treated[d].revenue, 0);
    const ta = AFTER.reduce((a, d) => a + treated[d].revenue, 0);
    const ratio = AFTER.reduce((a, d) => a + control[d].revenue, 0) / BEFORE.reduce((a, d) => a + control[d].revenue, 0);
    expect(Math.abs(e.counterfactual.revenue - tb * ratio)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.revenue - (ta - tb * ratio))).toBeLessThanOrEqual(1);
    expect(e.profit).toBe(Math.round(e.revenue * 0.4 - e.cost));
    expect(e.sufficiency.ok).toBe(true);
    expect(e.assumptions.join(' ')).toContain('평행 추세');
    // 같은 입력이면 같은 구간 (시드 고정)
    const again = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 4, margin: 0.4, seed: 'kw1' });
    expect(again.ci).toEqual(e.ci);
  });

  it('여러 시드에서도 대부분 진짜 증분이 80% 구간 안에 든다 (구간 포함률 점검)', () => {
    const truth = 300_000 * 7;
    let inside = 0;
    const N = 30;
    for (let s = 1; s <= N; s++) {
      const { treated, control } = synth({ seed: 100 + s, base: 2_000_000, controlBase: 5_000_000, shock: 1.1, upliftPerDay: 300_000 });
      const e = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 4, margin: 0.4, seed: `s${s}`, iterations: 500 });
      if (e.ci[0] <= truth && truth <= e.ci[1]) inside++;
    }
    expect(inside / N).toBeGreaterThanOrEqual(0.7);
  });

  it('대조군이 없으면 단순 비교 — 공통 충격까지 증분으로 잡혀 과대 추정되고 신뢰도는 낮음', () => {
    // 시장 전체가 +30% 오른 기간: 처리 전 합 약 1,400만 × 0.3 = 약 420만이 증분으로 섞인다
    const { treated, control } = synth({ seed: 7, base: 2_000_000, controlBase: 5_000_000, shock: 1.3, upliftPerDay: 300_000 });
    const naive = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control: null, margin: 0.4, seed: 'kw1' });
    const did = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 4, margin: 0.4, seed: 'kw1' });
    expect(naive.method).toBe('pre_post');
    expect(naive.confidence).toBe('low');
    expect(naive.confidenceBasis).toContain('대조군 없음');
    expect(naive.revenue).toBeGreaterThan(300_000 * 7 * 2);
    expect(Math.abs(did.revenue - 300_000 * 7)).toBeLessThan(Math.abs(naive.revenue - 300_000 * 7));
  });

  it('표본 부족: 창별 클릭 30 · 전환 3 미만이면 사유를 붙여 insufficient', () => {
    const { treated, control } = synth({ seed: 3, base: 50_000, controlBase: 200_000, shock: 1, upliftPerDay: 0, clicksPerDay: 2, convPerDay: 0.2 });
    const e = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 3, margin: 0.4, seed: 'low' });
    expect(e.sufficiency.ok).toBe(false);
    expect(e.sufficiency.reasons).toEqual(expect.arrayContaining(['반영 전 7일 클릭 14 (기준 30 이상)', '반영 후 7일 전환 1.4 (기준 3 이상)']));
    expect(e.confidence).toBe('low');
    expect(e.confidenceBasis).toContain('표본 부족');
    const s = sufficiency({ clicks: 30, conversions: 3, days: 7 }, { clicks: 30, conversions: 3, days: 7 });
    expect(s.ok).toBe(true);
  });

  it('데이터 없는 날은 0으로 보고 날짜 수를 기록한다', () => {
    const treated: Record<string, DayMetrics> = { [BEFORE[0]]: { date: BEFORE[0], clicks: 50, cost: 1000, conversions: 5, revenue: 5000 } };
    const e = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, margin: 0.4, seed: 'x', iterations: 200 });
    expect(e.revenue).toBe(-5000);
    expect(e.sufficiency.after.clicks).toBe(0);
  });
});

describe('손실 회피 (시간 비율)', () => {
  it('평일 14:00 발생 · 14:30 조치 → 자연 발견 다음 날 09:30, 손실 × (1 − 30/1170)', () => {
    const r = estimateLossAvoided({ id: 'i1', title: '예산 조기 소진', severity: 'P1', revenueLossEst: 1_000_000, occurredAt: '2026-10-13T14:00:00+09:00', detectedAt: '2026-10-13T14:05:00+09:00', actionAt: '2026-10-13T14:30:00+09:00' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.estimate.minutesToNatural).toBe(19 * 60 + 30);
    expect(r.estimate.minutesToAction).toBe(30);
    expect(r.estimate.lossAvoided).toBe(Math.round(1_000_000 * (1 - 30 / 1170)));
    expect(r.estimate.confidence).toBe('low');
    expect(r.estimate.assumptions.join(' ')).toContain('09:30');
  });

  it('금요일 밤 발생은 월요일 09:30, 월요일 공휴일이면 화요일 09:30이 자연 발견', () => {
    // 2026-10-02(금) 22:00 → 10/03(토, 개천절) · 10/04(일) · 10/05(월, 대체공휴일) → 10/06(화) 09:30
    expect(naturalDiscoveryMs(kstMsOf('2026-10-02', 22))).toBe(kstMsOf('2026-10-06', 9, 30));
    // 평일 08:00 발생 → 같은 날 09:30
    expect(naturalDiscoveryMs(kstMsOf('2026-10-13', 8))).toBe(kstMsOf('2026-10-13', 9, 30));
  });

  it('자연 발견보다 늦은 조치 · 테스트 · 오탐 · 추정 없음은 0 또는 제외', () => {
    const late = estimateLossAvoided({ id: 'i2', title: 't', severity: 'P2', revenueLossEst: 500_000, occurredAt: '2026-10-13T08:00:00+09:00', detectedAt: '2026-10-13T08:00:00+09:00', resolvedAt: '2026-10-13T12:00:00+09:00' });
    expect(late.ok && late.estimate.lossAvoided).toBe(0);
    expect(late.ok && late.estimate.actionBasis).toBe('resolvedAt');
    expect(estimateLossAvoided({ id: 'i3', title: 't', severity: 'P1', revenueLossEst: 1, detectedAt: '2026-10-13T08:00:00+09:00', actionAt: '2026-10-13T08:10:00+09:00', isTest: true })).toMatchObject({ ok: false, status: 'excluded' });
    expect(estimateLossAvoided({ id: 'i4', title: 't', severity: 'P1', revenueLossEst: 1, detectedAt: '2026-10-13T08:00:00+09:00', actionAt: '2026-10-13T08:10:00+09:00', falsePositive: true })).toMatchObject({ ok: false });
    expect(estimateLossAvoided({ id: 'i5', title: 't', severity: 'P1', detectedAt: '2026-10-13T08:00:00+09:00', actionAt: '2026-10-13T08:10:00+09:00' })).toMatchObject({ ok: false });
  });

  it('사람이 화면에서 등록한 이슈(autoDetected false)는 발생 시각 · 손실이 입력값이라 제외 · 서버 감지 이슈는 추정', () => {
    const base = { id: 'i6', title: 't', severity: 'P1', revenueLossEst: 9_000_000, occurredAt: '2026-10-01T00:00:00+09:00', detectedAt: '2026-10-13T08:00:00+09:00', actionAt: '2026-10-13T08:10:00+09:00' };
    const manual = estimateLossAvoided({ ...base, autoDetected: false });
    expect(manual).toMatchObject({ ok: false, status: 'excluded', code: 'manual' });
    expect(!manual.ok && manual.reason).toContain('사람이 화면에서 등록한 이슈');
    expect(statusText({ status: 'excluded', detail: { exclusion: 'manual' } })).toBe('집계 제외 · 수동 등록 이슈');
    expect(estimateLossAvoided({ ...base, autoDetected: true }).ok).toBe(true);
  });
});

describe('업무 절감 (자동화)', () => {
  it('건당 분은 제안서 p.19 표에서 계산 · 업무별 월 상한을 넘지 않는다', () => {
    const daily = AUTOMATION_UNITS.find((u) => u.id === 'ingest_days')!;
    expect(daily.minutesPerUnit).toBe(21); // (300 − 90) ÷ 5 ÷ 2
    expect(AUTOMATION_UNITS.find((u) => u.id === 'weekly_reports')!.minutesPerUnit).toBe(140);
    const bd = businessDaysIn('2026-10');
    expect(bd).toBe(20); // 10월 평일 22일 − 10/5 대체공휴일 · 10/9 한글날 (10/3 개천절은 토요일)
    const r = automationSavings({ ingest_days: bd, daily_reports: bd, weekly_reports: 4, bid_budget_changes: 500, keyword_changes: 3, detection_days: bd }, bd);
    const bid = r.rows.find((x) => x.unit === 'bid_budget_changes')!;
    expect(bid.minutes).toBeCloseTo((90 * bd) / 5, 5); // 상한
    expect(bid.cappedMinutes).toBeGreaterThan(0);
    const expected = 21 * bd * 2 + 140 * 4 + (90 * bd) / 5 + 18 * 3 + 21 * bd;
    expect(r.minutes).toBeCloseTo(expected, 1);
    expect(r.hours).toBeCloseTo(expected / 60, 1);
  });
});

function entry(p: Partial<LedgerEntry> & Pick<LedgerEntry, 'sourceType' | 'status' | 'estimate'>): LedgerEntry {
  return { id: Math.random().toString(36).slice(2), sourceId: 'x', label: 'x', occurredAt: '2026-10-10T10:00:00+09:00', month: '2026-10', windowDays: 7, baseline: null, observed: null, control: null, detail: {}, measuredAt: null, ...p };
}

describe('월간 요약 · 회수 배수', () => {
  it('회수 배수 = (증분 이익 + 손실 회피 × 공헌이익률 + 시간 × 인건비) ÷ 구독료, 표본 부족 · 다른 달은 제외', () => {
    const { treated, control } = synth({ seed: 9, base: 2_000_000, controlBase: 5_000_000, shock: 1.05, upliftPerDay: 400_000 });
    const up = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 5, margin: 0.4, seed: 'a' });
    const loss = estimateLossAvoided({ id: 'i', title: 't', severity: 'P1', revenueLossEst: 2_000_000, occurredAt: '2026-10-13T14:00:00+09:00', detectedAt: '2026-10-13T14:00:00+09:00', actionAt: '2026-10-13T14:30:00+09:00' });
    const hrs = automationSavings({ ingest_days: 10, daily_reports: 10, weekly_reports: 2, bid_budget_changes: 0, keyword_changes: 0, detection_days: 10 }, 19).rows;
    const entries: LedgerEntry[] = [
      entry({ sourceType: 'change', status: 'measured', estimate: up }),
      entry({ sourceType: 'change', status: 'insufficient', estimate: { ...up, revenue: 9e9 } as UpliftEstimate }),
      entry({ sourceType: 'change', status: 'measured', estimate: up, month: '2026-09' }),
      entry({ sourceType: 'incident', status: 'measured', estimate: loss.ok ? loss.estimate : null }),
      ...hrs.map((h) => entry({ sourceType: 'automation', status: 'measured', estimate: h })),
    ];
    const cfg = impactConfig(null);
    expect(cfg).toMatchObject({ monthlyFee: DEFAULT_MONTHLY_FEE, margin: DEFAULT_MARGIN, hourlyCost: DEFAULT_HOURLY_COST });
    const s = buildSummary(entries, cfg, '2026-10');
    const lossAvoided = loss.ok ? loss.estimate.lossAvoided : 0;
    const hours = Math.round(hrs.reduce((a, h) => a + h.hours, 0) * 100) / 100;
    const value = up.profit + lossAvoided * 0.4 + hours * 40_000;
    expect(s.totals.measuredUpliftRevenue.point).toBe(up.revenue);
    expect(s.totals.lossAvoidedEst).toBe(lossAvoided);
    expect(s.totals.hoursSaved).toBeCloseTo(hours, 2);
    expect(s.totals.valueKrw.point).toBe(Math.round(value));
    expect(s.totals.paybackMultiple.point).toBeCloseTo(value / 5_000_000, 2);
    expect(s.totals.paybackMultiple.lo).toBeLessThanOrEqual(s.totals.paybackMultiple.point);
    expect(s.counts.change).toEqual({ pending: 0, measured: 1, insufficient: 1, excluded: 0 });
    expect(s.components.map((c) => c.id)).toEqual(['uplift', 'loss', 'hours']);
    expect(s.components[1].confidence).toBe('low');
    expect(s.formulaFilled).toContain('÷ 5,000,000원');
    for (const c of s.components) {
      expect(c.method.length).toBeGreaterThan(10);
      expect(c.assumptions.length).toBeGreaterThan(0);
      expect(c.sample.note.length).toBeGreaterThan(0);
    }
  });

  it('반올림은 마지막에 한 번: 같은 공헌이익률이면 저장된 건별 이익, 바뀌면 매출 · 광고비에서 다시 계산', () => {
    const ups = [11, 12, 13].map((seed) => {
      const { treated, control } = synth({ seed, base: 1_300_000, controlBase: 4_100_000, shock: 1.07, upliftPerDay: 170_000 });
      return estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 4, margin: 0.4, seed: `r${seed}` });
    });
    // 측정 당시와 같은 공헌이익률 → 저장된 값 그대로
    expect(profitAt(ups[0], 0.4)).toEqual({ profit: ups[0].profit, se: ups[0].se.profit });
    // 다른 공헌이익률 → 반올림하지 않은 재계산 값
    expect(profitAt(ups[0], 0.33).profit).toBeCloseTo(ups[0].revenue * 0.33 - ups[0].cost, 9);
    const entries = ups.map((u) => entry({ sourceType: 'change', status: 'measured', estimate: u }));
    const s40 = buildSummary(entries, impactConfig(null), '2026-10');
    const sum40 = ups.reduce((a, u) => a + u.profit, 0);
    expect(s40.totals.measuredUpliftProfit.point).toBe(sum40);
    expect(s40.totals.valueKrw.point).toBe(Math.round(sum40));
    const s33 = buildSummary(entries, impactConfig({ impact: { contributionMargin: 0.33, hourlyCost: 41_234 }, billing: { monthlyFee: 3_333_333 } }), '2026-10');
    const sum33 = ups.reduce((a, u) => a + (u.revenue * 0.33 - u.cost), 0);
    expect(s33.totals.measuredUpliftProfit.point).toBe(Math.round(sum33));
    expect(s33.totals.valueKrw.point).toBe(Math.round(sum33));
    expect(s33.totals.paybackMultiple.point).toBe(Math.round((sum33 / 3_333_333) * 100) / 100);
    expect(s33.totals.valueKrw.lo).toBeLessThan(s33.totals.valueKrw.point);
  });

  it('워크스페이스 설정 값 · 판정 기준', () => {
    const cfg = impactConfig({ billing: { monthlyFee: 2_500_000 }, impact: { contributionMargin: 0.3, hourlyCost: 50_000 } });
    expect(cfg).toMatchObject({ monthlyFee: 2_500_000, margin: 0.3, hourlyCost: 50_000, sources: { monthlyFee: 'workspace', margin: 'workspace', hourlyCost: 'workspace' } });
    expect(impactConfig({ billing: { monthlyFee: -1 }, impact: { contributionMargin: 3 } }).sources).toEqual({ monthlyFee: 'default', margin: 'default', hourlyCost: 'default' });
    expect(paybackVerdict({ point: 2, lo: 1.2, hi: 3, level: 0.8 }, true).label).toBe('구독료 회수');
    expect(paybackVerdict({ point: 1.4, lo: 0.6, hi: 2, level: 0.8 }, true).tone).toBe('warning');
    expect(paybackVerdict({ point: 0.4, lo: 0.1, hi: 0.8, level: 0.8 }, true).label).toBe('미회수');
    expect(paybackVerdict({ point: 0, lo: 0, hi: 0, level: 0.8 }, false).label).toBe('판정 보류');
  });
});

describe('가치 리포트 · 데모 예시 · CSV', () => {
  const incidents = detectIncidents(DEMO);
  const demo = buildDemoImpact(DEMO, incidents);

  it('데모 예시는 TEST DATA 키워드 14일에서 같은 추정기로 계산 · 예시 표기', () => {
    expect(demo.summary.dataMode).toBe('example');
    expect(demo.entries.some((e) => e.sourceType === 'change')).toBe(true);
    expect(demo.entries.some((e) => e.sourceType === 'automation')).toBe(true);
    expect(demo.entries.every((e) => e.detail.test)).toBe(true);
    expect(Number.isFinite(demo.summary.totals.paybackMultiple.point)).toBe(true);
  });

  it('가치 리포트는 확정 팩트 · 반복 관측 패턴 · AI 해석 · 전제 조건 · 반례를 나눠 쓴다 (번호 매기기 없음)', () => {
    const v = buildValueReport({ ...demo.summary, dataMode: 'demo' }, demo.entries, { brand: '수면밀도', appUrl: 'https://os.example' });
    for (const h of ['### 확정 팩트', '### 반복 관측 패턴', '### AI 해석', '### 전제 조건 · 기준값', '### 반례 · 대체 시나리오', '### 다음 액션']) expect(v.markdown).toContain(h);
    expect(v.markdown).toContain('TEST DATA');
    expect(v.markdown).not.toMatch(/^\s*\d+\.\s/m);
    expect(v.messenger).toContain('회수 배수');
    expect(v.periodStart).toBe(`${demo.month}-01`);
  });

  it('CSV: 헤더 · 행 수 · BOM', () => {
    const csv = ledgerCsv(demo.entries);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\n');
    expect(lines[0]).toContain('증분 매출');
    expect(lines).toHaveLength(demo.entries.length + 1);
  });

  it('CSV 수식 주입 방지: = + - @ 로 시작하는 문자열은 앞에 작은따옴표 · 숫자(음수)는 그대로', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-키워드')).toBe("'-키워드");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-125_000)).toBe('-125000');
    expect(csvCell('침대 매트리스')).toBe('침대 매트리스');
    expect(csvCell('a\rb')).toBe('"a\rb"');
    const evil: LedgerEntry = { ...demo.entries[0], label: '=cmd|\' /C calc\'!A0', sourceId: '@evil' };
    const line = ledgerCsv([evil]).slice(1).split('\n')[1];
    expect(line.startsWith(`${'변경 반영'},'=cmd|`)).toBe(true);
    expect(line.endsWith(",'@evil")).toBe(true);
  });
});
