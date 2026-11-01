/**
 * MILDO Board 엔진 테스트 — 판정 규칙 · 경계값(빈 데이터 · 0 나누기 · NaN) · 데모 시나리오 탐지.
 * 시나리오 탐지는 엔진이 데이터에서 계산한 결과를 검증한다 (데이터를 바꾸면 결과도 바뀌는지 함께 확인).
 */
import { describe, expect, it } from 'vitest';
import type { Dataset } from '@/core/types';
import { DEMO, generateDemoData } from '@/data/demo';
import { MEDIA, MEDIA_IDS } from '@/data/constants';
import { campaignPacing, headline, mediaRows, monthlyPacing, salesByChannel, totalsOf } from '@/core/selectors';
import { addDays, monthKey, sum } from '@/core/util';
import { heatLevel } from './BoardHeatmap';
import {
  accountInfo, dataBrief, delegationText,
  BOARD_PERIOD_IDS, boardKpis, boardPromptPayload, budgetPacing, campaignPaceRows, changeFlag, channelBrief, channelRows, channelTrend, clock,
  collectionSummary, curveExhaustHour, filterKeywords, groupRollup, hourWeekHeatmap, hourlyCostCurve, intentRollup, keyMappingSamples, keywordAnomaly,
  keywordBrief, keywordCsv, keywordRows, keywordSummary, keywordVerdict, landingInfo, mediaComparison, mediaTrend, monthPaceRows, pacingBrief,
  periodBrief, periodWindow, productGroupOf, reconciliation, sortKeywords, sourceStatuses, standardKeyStats, todaySignals, validationChecks,
} from './engine';
import { BOARD_RULES } from './data';

const fresh = (): Dataset => generateDemoData();
const empty = (): Dataset => ({
  generatedAt: '2026-10-31T15:30:00+09:00', today: '2026-10-31', currentHour: 15, dates: [],
  mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
});
const NO_BAD_TEXT = /NaN|undefined|Infinity/;
const NUMBERED = /^\s*\d+[.)]\s/m;
const briefText = (b: { facts: string[]; patterns: string[]; interpretation: string[]; conditions: string[]; counter: string[]; actions: string[] }) =>
  [...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions].join('\n');

describe('기간 · 직전 기간', () => {
  it('최근 7일은 어제까지 7일, 직전 7일과 비교한다', () => {
    const w = periodWindow(DEMO, 'last7');
    expect(w.from).toBe('2026-10-24');
    expect(w.to).toBe('2026-10-30');
    expect(w.prevFrom).toBe('2026-10-17');
    expect(w.prevTo).toBe('2026-10-23');
    expect(w.days).toBe(7);
    expect(w.includesToday).toBe(false);
  });
  it('어제 = 1일, 이번 달 = 1일~기준일(오늘 부분일 포함)', () => {
    expect(periodWindow(DEMO, 'yesterday').days).toBe(1);
    const mtd = periodWindow(DEMO, 'mtd');
    expect(mtd.from).toBe('2026-10-01');
    expect(mtd.to).toBe(DEMO.today);
    expect(mtd.includesToday).toBe(true);
    expect(mtd.days).toBe(31);
    expect(mtd.prevTo).toBe('2026-09-30');
  });
  it('5개 프리셋 모두 계산된다', () => {
    expect(BOARD_PERIOD_IDS).toEqual(['yesterday', 'last7', 'last14', 'last30', 'mtd']);
    for (const p of BOARD_PERIOD_IDS) expect(boardKpis(DEMO, p).hasData).toBe(true);
  });
});

describe('KPI — 광고비 · ROAS · 실매출 · MER · CPA · CVR · CAC', () => {
  it('공용 셀렉터와 같은 숫자를 낸다 (어제 = headline)', () => {
    const k = boardKpis(DEMO, 'yesterday');
    const h = headline(DEMO);
    expect(k.cur.cost).toBe(h.yesterday.cost);
    expect(k.sales).toBe(h.salesYesterday);
    expect(k.prevSales).toBe(h.salesDayBefore);
    expect(k.mer).toBeCloseTo(h.salesYesterday / h.yesterday.cost, 10);
  });
  it('MER = 실매출 ÷ 광고비, 광고 경유 비중은 0~1', () => {
    const k = boardKpis(DEMO, 'last7');
    const t = totalsOf(mediaRows(DEMO, k.win.from, k.win.to));
    const s = sum(salesByChannel(DEMO, k.win.from, k.win.to), (c) => c.revenue);
    expect(k.mer).toBeCloseTo(s / t.cost, 10);
    expect(k.mer).toBeGreaterThan(1);
    expect(k.adShareOfSales).toBeGreaterThan(0);
    expect(k.adShareOfSales).toBeLessThanOrEqual(1);
    expect(k.cur.cac).toBeCloseTo(t.cost / t.newCustomers, 6);
    expect(Number.isFinite(k.deltas.cost)).toBe(true);
  });
  it('빈 데이터: 0 나누기 없이 NaN/0 으로 처리', () => {
    const k = boardKpis(empty(), 'last7');
    expect(k.hasData).toBe(false);
    expect(k.cur.cost).toBe(0);
    expect(Number.isNaN(k.mer)).toBe(true);
    expect(Number.isNaN(k.adShareOfSales)).toBe(true);
    expect(Number.isNaN(k.deltas.roas)).toBe(true);
    expect(k.deltas.cost).toBe(0);
  });
});

describe('01 매체 통합 성과', () => {
  it('6개 매체를 같은 기준으로 비교하고 비중 합 = 1', () => {
    const rows = mediaComparison(DEMO, periodWindow(DEMO, 'last14'));
    expect(rows.map((r) => r.media)).toEqual(MEDIA_IDS);
    expect(sum(rows, (r) => r.share)).toBeCloseTo(1, 6);
    expect(sum(rows, (r) => r.revenueShare)).toBeCloseTo(1, 6);
    for (const r of rows) {
      expect(r.judge.metric).toBe(MEDIA[r.media].judgeMetric);
      expect(r.role).toBe(MEDIA[r.media].role);
      expect(r.planShare).toBe(MEDIA[r.media].share);
      expect(r.newShare).toBeGreaterThan(0);
      expect(r.newShare).toBeLessThanOrEqual(1);
      expect(r.flag.basis.length).toBeGreaterThan(0);
      expect(r.judge.value).not.toMatch(NO_BAD_TEXT);
    }
  });
  it('변동 판정 경계값: ROAS −20% 주의 · −35% 점검 · CPA +30% · 광고비 ±30%', () => {
    const prev = { cost: 100, roas: 400, cpa: 1000 };
    expect(changeFlag({ cost: 100, roas: 330, cpa: 1000 }, prev).level).toBe('ok'); // −17.5%
    expect(changeFlag({ cost: 100, roas: 320, cpa: 1000 }, prev).level).toBe('warn'); // −20%
    expect(changeFlag({ cost: 100, roas: 260, cpa: 1000 }, prev).level).toBe('danger'); // −35%
    expect(changeFlag({ cost: 100, roas: 400, cpa: 1300 }, prev).level).toBe('warn');
    expect(changeFlag({ cost: 100, roas: 400, cpa: 1500 }, prev).level).toBe('danger');
    expect(changeFlag({ cost: 130, roas: 400, cpa: 1000 }, prev).level).toBe('warn');
    expect(changeFlag({ cost: 40, roas: 400, cpa: 1000 }, prev).level).toBe('danger');
    expect(changeFlag({ cost: 100, roas: 320, cpa: 1000 }, prev).basis).toContain('기준 −20%');
  });
  it('변동 판정: 직전 집행 0 · 선택 기간 0 · NaN 은 비교 불가', () => {
    expect(changeFlag({ cost: 100, roas: 400, cpa: 1000 }, { cost: 0, roas: NaN, cpa: NaN }).level).toBe('na');
    expect(changeFlag({ cost: 0, roas: NaN, cpa: NaN }, { cost: 100, roas: 400, cpa: 1000 }).level).toBe('na');
    expect(changeFlag({ cost: 100, roas: NaN, cpa: NaN }, { cost: 100, roas: NaN, cpa: NaN }).level).toBe('ok');
  });
  it('일자별 추이: 짧은 기간은 14일로 확장, 오늘(부분일) 제외', () => {
    const y = mediaTrend(DEMO, periodWindow(DEMO, 'yesterday'), ['naver_sa', 'meta'], 'cost');
    expect(y.extended).toBe(true);
    expect(y.series).toHaveLength(2);
    expect(y.series[0].points).toHaveLength(14);
    expect(y.to).toBe(addDays(DEMO.today, -1));
    const m = mediaTrend(DEMO, periodWindow(DEMO, 'mtd'), MEDIA_IDS, 'roas', true);
    expect(m.excludedToday).toBe(true);
    expect(m.series).toHaveLength(1);
    expect(m.series[0].points.at(-1)!.x).toBe(addDays(DEMO.today, -1));
    // 합계 시리즈 = 일자별 전 매체 합
    const c = mediaTrend(DEMO, periodWindow(DEMO, 'last7'), MEDIA_IDS, 'cost', true).series[0].points.at(-1)!;
    expect(c.y).toBe(totalsOf(mediaRows(DEMO, c.x, c.x)).cost);
  });
});

describe('02 키워드 성과 필터', () => {
  const rows = keywordRows(DEMO, 14);

  it('구매 의도 · 상태 · 검색어 · 제품군 필터', () => {
    expect(rows).toHaveLength(DEMO.keywords.length);
    const brand = filterKeywords(rows, { intents: ['brand'] });
    expect(brand.length).toBeGreaterThan(0);
    expect(brand.every((r) => r.intent === 'brand')).toBe(true);
    const test = filterKeywords(rows, { status: 'test' });
    expect(test.every((r) => r.status === 'test')).toBe(true);
    expect(test.length).toBe(DEMO.keywords.filter((k) => k.status === 'test').length);
    expect(filterKeywords(rows, { query: '매트리스추천' }).map((r) => r.text)).toContain('매트리스 추천');
    const king = filterKeywords(rows, { group: 'size:킹' });
    expect(king.map((r) => r.text)).toEqual(['킹 매트리스']);
    expect(filterKeywords(rows, { intents: ['brand'], status: 'test' })).toHaveLength(0);
  });

  it('데모: 킹 옵션 품절 + 상품 상세 랜딩 → 품절 랜딩 신호 (재고 복구 시 해제)', () => {
    const k = rows.find((r) => r.text === '킹 매트리스')!;
    expect(k.landingInfo.kind).toBe('product');
    expect(k.landingInfo.optionLabel).toBe('킹');
    expect(k.signals.map((s) => s.id)).toContain('soldout');
    expect(filterKeywords(rows, { signal: 'soldout' }).map((r) => r.text)).toEqual(['킹 매트리스']);
    const d = fresh();
    d.products[0].options.find((o) => o.id === 'k')!.inStock = true;
    expect(keywordRows(d).find((r) => r.text === '킹 매트리스')!.signals.map((s) => s.id)).not.toContain('soldout');
  });

  it('데모: 매트리스 추천 최근 3일 CPC 급등 탐지 (급등 제거 시 해제)', () => {
    const r = rows.find((x) => x.text === '매트리스 추천')!;
    const sig = r.signals.find((s) => s.id === 'cpc_spike');
    expect(sig).toBeDefined();
    expect(r.anomaly.cpcDelta).toBeGreaterThanOrEqual(BOARD_RULES.keywordAnomalyPct);
    expect(sig!.basis).toContain('±50%');
    // 다른 키워드는 CPC 급변이 없다
    expect(rows.filter((x) => x.signals.some((s) => s.id === 'cpc_spike')).map((x) => x.text)).toEqual(['매트리스 추천']);
    const d = fresh();
    const k = d.keywords.find((x) => x.text === '매트리스 추천')!;
    for (let i = 11; i < 14; i++) k.daily[i].cost = Math.round(k.daily[i].cost / 1.7);
    expect(keywordRows(d).find((x) => x.text === '매트리스 추천')!.signals.map((s) => s.id)).not.toContain('cpc_spike');
  });

  it('데모: 신규 키워드(최근 14일만 집행)는 직전 대비가 비교 불가로 표시된다', () => {
    const r = rows.find((x) => x.text === '첫 독립 매트리스')!;
    expect(r.isNew).toBe(true);
    expect(Number.isNaN(r.costDelta)).toBe(true);
    expect(r.signals.map((s) => s.id)).toContain('new');
  });

  it('데모: star 키워드는 고효율 · 노출 손실 신호 (기준 130% · 25%)', () => {
    const opp = rows.filter((r) => r.signals.some((s) => s.id === 'opportunity'));
    expect(opp.length).toBeGreaterThan(0);
    for (const r of opp) {
      expect(r.ratioPct).toBeGreaterThanOrEqual(130);
      expect(r.lost).toBeGreaterThanOrEqual(BOARD_RULES.lostShareTrigger);
    }
    // weak 키워드(노출 손실 2~8%)는 신호 없음
    expect(opp.map((r) => r.text)).not.toContain('킹 매트리스');
  });

  it('판정 배지: 목표 대비 % · 브랜드 별도 기준 · 표본 부족 표기', () => {
    const v = keywordVerdict({ impressions: 1000, clicks: 100, cost: 100_000, conversions: 5, revenue: 600_000 }, false);
    expect(v.key).toBe('high'); // 600% / 400% = 150%
    expect(v.basis).toBe('목표 400% 대비 150%');
    expect(v.sampleOk).toBe(true);
    const b = keywordVerdict({ impressions: 1000, clicks: 100, cost: 100_000, conversions: 5, revenue: 600_000 }, true);
    expect(b.target).toBe(800);
    expect(b.key).toBe('below'); // 600 / 800 = 75%
    const low = keywordVerdict({ impressions: 10, clicks: 5, cost: 10_000, conversions: 1, revenue: 50_000 }, false);
    expect(low.sampleOk).toBe(false);
    expect(low.basis).toContain('표본 부족');
    expect(keywordVerdict({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }, false).key).toBe('none');
    expect(keywordVerdict({ impressions: 100, clicks: 30, cost: 30_000, conversions: 0, revenue: 0 }, false).key).toBe('noconv');
  });

  it('7일 창은 일별 데이터의 마지막 7일 vs 그 전 7일', () => {
    const r7 = keywordRows(DEMO, 7);
    const k = DEMO.keywords[0];
    const row = r7.find((r) => r.id === k.id)!;
    expect(row.cur.cost).toBe(sum(k.daily.slice(-7), (x) => x.cost));
    expect(row.prev.cost).toBe(sum(k.daily.slice(-14, -7), (x) => x.cost));
  });

  it('묶음 조회: 구매 의도 · 제품군 합계 = 전체', () => {
    const s = keywordSummary(rows);
    const ir = intentRollup(rows);
    expect(sum(ir, (r) => r.cur.cost)).toBe(s.cur.cost);
    expect(sum(ir, (r) => r.costShare)).toBeCloseTo(1, 6);
    const gr = groupRollup(rows, DEMO.products);
    expect(sum(gr, (r) => r.count)).toBe(rows.length);
    expect(gr.find((g) => g.id === 'size:킹')!.inStock).toBe(false);
    expect(gr.find((g) => g.id === 'size:퀸')!.inStock).toBe(true);
  });

  it('정렬: NaN 은 뒤로', () => {
    const sorted = sortKeywords(rows, 'costDelta');
    expect(Number.isNaN(sorted.at(-1)!.costDelta)).toBe(true);
    const byCost = sortKeywords(rows, 'cost');
    expect(byCost[0].cur.cost).toBeGreaterThanOrEqual(byCost[1].cur.cost);
  });

  it('CSV 내보내기: BOM · 한글 헤더 · 행 수 · NaN 없음', () => {
    const csv = keywordCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('키워드');
    expect(lines[0]).toContain('목표 대비(%)');
    expect(lines).toHaveLength(rows.length + 1);
    expect(csv).not.toMatch(/NaN|undefined|Infinity/);
    expect(csv).toContain('TEST DATA');
    expect(keywordCsv([])).toBe('');
  });

  it('제품군 · 랜딩 매핑 경계값', () => {
    expect(productGroupOf('슈퍼싱글 매트리스', DEMO.products).label).toBe('슈퍼싱글');
    expect(productGroupOf('신혼집 매트리스 사이즈', DEMO.products).id).toBe('none');
    expect(productGroupOf('킹 매트리스', []).id).toBe('none');
    expect(landingInfo({ landing: 'https://mildo.kr/guide', text: '허리' }, DEMO.products).kind).toBe('guide');
    expect(landingInfo({ landing: 'https://brand.naver.com/mildo', text: '수면밀도' }, DEMO.products).kind).toBe('store');
    expect(landingInfo({ landing: '', text: 'x' }, DEMO.products).kind).toBe('other');
  });

  it('급변 계산 경계값: 짧은 배열 · 클릭 0', () => {
    const a = keywordAnomaly([{ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }]);
    expect(Number.isNaN(a.cpcDelta)).toBe(true);
    const z = keywordAnomaly(Array.from({ length: 14 }, () => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 })));
    expect(Number.isNaN(z.cpcDelta)).toBe(true);
    expect(Number.isNaN(z.convDelta)).toBe(true);
  });
});

describe('03 예산 소진 현황', () => {
  it('데모: SA_일반 제품 · Meta_넓은 타겟 조기 소진 + 피크 전 소진 (시간대 가중)', () => {
    const rows = campaignPaceRows(DEMO);
    const sa = rows.find((r) => r.name === 'SA_일반 제품')!;
    const meta = rows.find((r) => r.name === 'Meta_넓은 타겟')!;
    for (const r of [sa, meta]) {
      expect(r.earlyExhaust).toBe(true);
      expect(r.missesPeak).toBe(true);
      expect(r.level).toBe('critical');
      expect(r.curveExhaustHour!).toBeLessThan(BOARD_RULES.peakStartHour);
      expect(r.basis).toContain('기준 23시 전');
      expect(r.shortfall).toBeGreaterThan(0);
    }
    expect(sa.projectedRatio).toBeGreaterThan(1.25);
    expect(rows.find((r) => r.name === 'SA_생활 상황')!.earlyExhaust).toBe(false);
    expect(rows.find((r) => r.name === 'SA_브랜드 방어')!.level).toBe('ok');
    // 피크 전 소진은 이 두 캠페인뿐
    expect(rows.filter((r) => r.missesPeak).map((r) => r.name).sort()).toEqual(['Meta_넓은 타겟', 'SA_일반 제품']);
  });

  it('선형 추정은 selectors.campaignPacing 과 같다', () => {
    const lin = campaignPacing(DEMO);
    const rows = campaignPaceRows(DEMO);
    rows.forEach((r, i) => {
      expect(r.pacePct).toBeCloseTo(lin[i].pacePct, 8);
      expect(r.linearEarly).toBe(lin[i].earlyExhaust);
    });
  });

  it('소진 배수를 바꾸면 판정이 바뀐다 (하드코딩 아님)', () => {
    const d = fresh();
    const c = d.campaigns.find((x) => x.name === 'SA_일반 제품')!;
    c.spentToday = Math.round(c.spentToday / 1.32 * 0.9);
    expect(campaignPaceRows(d).find((x) => x.name === 'SA_일반 제품')!.earlyExhaust).toBe(false);
    const off = fresh();
    off.campaigns.find((x) => x.name === 'Meta_넓은 타겟')!.status = 'off';
    expect(campaignPaceRows(off).find((x) => x.name === 'Meta_넓은 타겟')!.level).toBe('off');
  });

  it('누적 곡선 · 마감 시각 경계값', () => {
    const cum = hourlyCostCurve(DEMO, 'naver_sa');
    expect(cum).toHaveLength(24);
    expect(cum[23]).toBeCloseTo(1, 6);
    for (let h = 1; h < 24; h++) expect(cum[h]).toBeGreaterThanOrEqual(cum[h - 1]);
    expect(curveExhaustHour(cum, 1)).toBeNull();
    expect(curveExhaustHour(cum, 0.5)).toBeNull();
    expect(curveExhaustHour(cum, NaN)).toBeNull();
    expect(curveExhaustHour(cum, 2)!).toBeLessThan(curveExhaustHour(cum, 1.2)!);
    // 데이터 없으면 균등 곡선
    expect(hourlyCostCurve(empty(), 'meta')[11]).toBeCloseTo(0.5, 6);
    const zero = fresh();
    zero.campaigns[0].dailyBudget = 0;
    const z = campaignPaceRows(zero)[0];
    expect(Number.isNaN(z.pacePct)).toBe(true);
    expect(z.label).toBe('예산 미설정');
    expect(z.earlyExhaust).toBe(false);
  });

  it('월 예산 = 연 배분 ÷ 12, 소진율은 selectors.monthlyPacing 과 같고 도달일은 실측 누적', () => {
    const rows = monthPaceRows(DEMO);
    const sel = monthlyPacing(DEMO);
    rows.forEach((r, i) => {
      expect(r.budget).toBeCloseTo(MEDIA[r.media].annualBudget / 12, 4);
      expect(r.pacePct).toBeCloseTo(sel[i].pacePct, 8);
      expect(r.status).toBe(sel[i].status);
      if (r.reachedDate) {
        const mk = monthKey(DEMO.today);
        const before = sum(DEMO.mediaDaily.filter((x) => x.media === r.media && monthKey(x.date) === mk && x.date < r.reachedDate!), (x) => x.cost);
        const upto = sum(DEMO.mediaDaily.filter((x) => x.media === r.media && monthKey(x.date) === mk && x.date <= r.reachedDate!), (x) => x.cost);
        expect(before).toBeLessThan(r.budget);
        expect(upto).toBeGreaterThanOrEqual(r.budget);
      }
      expect(r.next.month).toBe('2026-11');
      expect(r.next.days).toBe(30);
      expect(r.next.recommendedDaily).toBeCloseTo(r.next.budget / 30, 6);
    });
    const p = budgetPacing(DEMO);
    expect(p.month.budget).toBeCloseTo(sum(MEDIA_IDS, (m) => MEDIA[m].annualBudget) / 12, 2);
    expect(p.month.isLastDay).toBe(true);
    expect(p.early.length).toBeGreaterThanOrEqual(2);
    expect(p.warnings.join(' ')).toContain('SA_일반 제품');
  });

  it('빈 데이터: 캠페인 없음 · 월 소진 0', () => {
    const p = budgetPacing(empty());
    expect(p.campaigns).toEqual([]);
    expect(p.month.spent).toBe(0);
    expect(p.media.every((m) => m.reachedDate === null)).toBe(true);
  });
});

describe('판매 채널 실매출', () => {
  it('채널별 매출 · 주문 · CVR · 객단가 · 광고 경유 비중', () => {
    const w = periodWindow(DEMO, 'last7');
    const rows = channelRows(DEMO, w);
    const sel = salesByChannel(DEMO, w.from, w.to);
    expect(sum(rows, (r) => r.revenue)).toBe(sum(sel, (c) => c.revenue));
    expect(sum(rows, (r) => r.share)).toBeCloseTo(1, 6);
    for (const r of rows) {
      expect(r.adShare).toBeGreaterThan(0);
      expect(r.adShare).toBeLessThanOrEqual(1);
      expect(r.aov).toBeGreaterThan(0);
      expect(r.cvr).toBeGreaterThan(0);
    }
    const rec = reconciliation(DEMO, w);
    expect(rec.within).toBe(true);
    expect(rec.organicRevenue).toBeCloseTo(rec.sales - rec.channelAdRevenue, 0);
    expect(channelTrend(DEMO, w).series).toHaveLength(4);
  });
  it('빈 데이터: NaN 방어', () => {
    const w = periodWindow(empty(), 'last7');
    const rows = channelRows(empty(), w);
    expect(rows.every((r) => r.revenue === 0 && r.share === 0)).toBe(true);
    expect(rows.every((r) => Number.isNaN(r.adShare))).toBe(true);
    expect(reconciliation(empty(), w).within).toBe(false);
  });
});

describe('시간대 × 요일 히트맵 (최근 4주)', () => {
  it('7 × 24, 오늘 제외 28일, 같은 요일 평균', () => {
    const h = hourWeekHeatmap(DEMO, 'cost');
    expect(h.rows).toEqual(['월', '화', '수', '목', '금', '토', '일']);
    expect(h.values).toHaveLength(7);
    expect(h.values.every((r) => r.length === 24)).toBe(true);
    expect(h.days).toBe(28);
    expect(h.to).toBe(addDays(DEMO.today, -1));
    // 데모 시간대 가중치: 저녁 20~22시 피크
    expect(h.top[0].hour).toBeGreaterThanOrEqual(20);
    expect(h.top[0].hour).toBeLessThanOrEqual(22);
    // 전환 효율: 저녁 > 1 > 새벽
    const eff = h.hourEfficiency;
    expect(eff[21].index).toBeGreaterThan(1);
    expect(eff[3].index).toBeLessThan(1);
  });
  it('전환 · ROAS · 단일 매체 · 빈 데이터', () => {
    expect(hourWeekHeatmap(DEMO, 'conversions', 'kakao').hasData).toBe(true);
    const r = hourWeekHeatmap(DEMO, 'roas');
    expect(r.values.flat().filter(Number.isFinite).length).toBeGreaterThan(100);
    const e = hourWeekHeatmap(empty(), 'cost');
    expect(e.hasData).toBe(false);
    expect(e.top).toEqual([]);
    expect(e.values.flat().every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('데이터 수집 · 검증 · 표준화 (p.12)', () => {
  it('데모: Meta 14~15시 광고비 급등(동요일 · 동시간 +50% 이상)을 데이터에서 탐지', () => {
    const sig = todaySignals(DEMO);
    const meta = sig.find((s) => s.media === 'meta' && s.kind === 'spike');
    expect(meta).toBeDefined();
    expect(meta!.fromHour).toBe(14);
    expect(meta!.deltaPct).toBeGreaterThanOrEqual(50);
    expect(meta!.deltaPct).toBeLessThan(100);
    expect(sig.filter((s) => s.kind === 'spike').map((s) => s.media)).toEqual(['meta']);
  });
  it('데모: 카카오 13시 이후 전환 0 · 클릭 정상 → 추적 단절 의심 (전환 복구 시 해제)', () => {
    const z = todaySignals(DEMO).find((s) => s.kind === 'zero_conv');
    expect(z?.media).toBe('kakao');
    expect(z!.fromHour).toBe(13);
    expect(z!.clickRatio!).toBeGreaterThanOrEqual(BOARD_RULES.zeroConvClickFloor);
    const d = fresh();
    for (const r of d.mediaHourly) if (r.media === 'kakao' && r.date === d.today && r.hour === 14) r.conversions = 0.2;
    expect(todaySignals(d).some((s) => s.kind === 'zero_conv' && s.media === 'kakao')).toBe(false);
  });
  it('데모: 계정 상태 — GFA 자동충전 실패 · 잔액 1일치 미만, 오늘의집 검수', () => {
    const src = sourceStatuses(DEMO);
    const gfa = src.find((s) => s.id === 'naver_gfa')!;
    expect(gfa.account!.tone).toBe('critical');
    expect(gfa.account!.label).toContain('자동충전 실패');
    expect(src.find((s) => s.id === 'vertical')!.account!.label).toContain('검수');
    expect(src.find((s) => s.id === 'naver_sa')!.state).toBe('ok');
    const checks = validationChecks(DEMO);
    const acc = checks.find((c) => c.id === 'account_state')!;
    expect(acc.level).toBe('warn');
    expect(acc.detail).toContain('오늘의집');
    expect(acc.detail).toContain('GFA');
  });
  it('수집 상태: 07:00 배치 · 시간대 15시까지 · 외부 데이터 1/3 포함 · 주말 브리핑 이동', () => {
    const s = collectionSummary(DEMO);
    expect(s.batchTime).toBe('07:00');
    expect(s.batchDate).toBe('2026-10-30');
    expect(s.hourlyThrough).toBe(15);
    expect(s.asOf).toBe('15:30');
    expect(s.media).toEqual({ ok: 6, total: 6 });
    expect(s.sales).toEqual({ ok: 4, total: 4 });
    expect(s.external).toEqual({ inDataset: 1, total: 3 });
    expect(s.warnings).toBeGreaterThanOrEqual(3);
    expect(s.timetable[0].state).toBe('done');
    expect(s.timetable.find((t) => t.time === '09:30')!.state).toBe('moved'); // 토요일
    expect(s.timetable.find((t) => t.time === '16:30')!.state).toBe('pending');
  });
  it('검증 체크: 결측 0 · 일 ↔ 시간대 합계 ±5% 이내 · 판매 채널 4/4', () => {
    const c = validationChecks(DEMO);
    expect(c.find((x) => x.id === 'missing_days')!.level).toBe('ok');
    expect(c.find((x) => x.id === 'daily_vs_hourly')!.level).toBe('ok');
    expect(c.find((x) => x.id === 'sales_coverage')!.level).toBe('ok');
    expect(c.find((x) => x.id === 'hourly_spike')!.level).toBe('warn');
    expect(c.find((x) => x.id === 'zero_conv')!.level).toBe('warn');
    for (const x of c) expect(`${x.detail} ${x.basis}`).not.toMatch(NO_BAD_TEXT);
    // 결측 주입
    const d = fresh();
    d.mediaDaily = d.mediaDaily.filter((r) => !(r.media === 'google' && r.date === '2026-10-15'));
    expect(validationChecks(d).find((x) => x.id === 'missing_days')!.detail).toContain('Google');
  });
  it('표준화 키 · 매핑 예시는 실제 데이터에서 뽑는다 (품절 옵션 키워드 우선)', () => {
    const keys = standardKeyStats(DEMO);
    expect(keys.map((k) => k.label)).toEqual(['날짜', '채널', '키워드', '상품']);
    expect(keys[1].value).toBe('10개');
    const m = keyMappingSamples(DEMO);
    expect(m[0].raw).toContain('킹 매트리스');
    expect(m[0].product).toBe('p_main:k');
    expect(m[0].note).toContain('품절');
  });
  it('빈 데이터: 수집 상태 · 검증 · 신호 모두 예외 없이 계산', () => {
    const e = empty();
    expect(todaySignals(e)).toEqual([]);
    expect(sourceStatuses(e).filter((s) => s.group !== 'external').every((s) => s.state === 'warn')).toBe(true);
    expect(validationChecks(e).find((c) => c.id === 'missing_days')!.level).toBe('warn');
    expect(collectionSummary(e).hourlyThrough).toBeNull();
    expect(keyMappingSamples(e)).toEqual([]);
  });
});

describe('브리프 · 프롬프트 · 포맷', () => {
  it('데모 브리프: 번호 매기기 없음 · NaN 없음 · 데이터 근거 포함', () => {
    const briefs = [periodBrief(DEMO, 'last7'), periodBrief(DEMO, 'mtd'), pacingBrief(DEMO), keywordBrief(DEMO), channelBrief(DEMO, 'last30')];
    for (const b of briefs) {
      const t = briefText(b);
      expect(t).not.toMatch(NUMBERED);
      expect(t).not.toMatch(NO_BAD_TEXT);
      expect(b.facts.length).toBeGreaterThan(0);
      expect(b.actions.length).toBeGreaterThan(0);
      expect(t).toContain('테스트 데이터');
    }
    expect(briefText(pacingBrief(DEMO))).toContain('SA_일반 제품');
    expect(briefText(pacingBrief(DEMO))).toContain('Meta_넓은 타겟');
    const kb = briefText(keywordBrief(DEMO));
    expect(kb).toContain('킹 매트리스');
    expect(kb).toContain('매트리스 추천');
  });
  it('빈 데이터 브리프도 같은 구조', () => {
    for (const b of [periodBrief(empty()), pacingBrief(empty()), keywordBrief(empty()), channelBrief(empty())]) {
      expect(briefText(b)).not.toMatch(NO_BAD_TEXT);
      expect(b.facts.length + b.interpretation.length).toBeGreaterThan(0);
    }
  });
  it('AI 프롬프트 데이터: JSON · 32KB 이하 · TEST DATA 표기', () => {
    for (const p of BOARD_PERIOD_IDS) {
      const s = boardPromptPayload(DEMO, p);
      expect(s.length).toBeLessThan(32_000);
      const j = JSON.parse(s);
      expect(j.출처).toContain('TEST DATA');
      expect(j.매체).toHaveLength(6);
    }
    expect(() => JSON.parse(boardPromptPayload(empty(), 'last7'))).not.toThrow();
  });
  it('clock 포맷', () => {
    expect(clock(20.37)).toBe('20:22');
    expect(clock(null)).toBe('—');
    expect(clock(NaN)).toBe('—');
    expect(clock(24.5)).toBe('당일 마감 없음');
    expect(clock(0)).toBe('00:00');
  });
});

describe('키워드 집계 범위', () => {
  it('키워드 보고서 합계와 SA 매체 집계를 같은 기간으로 나란히 계산', async () => {
    const { keywordScope } = await import('./engine');
    const sc = keywordScope(DEMO, 14);
    expect(sc.to).toBe(addDays(DEMO.today, -1));
    expect(sc.from).toBe(addDays(DEMO.today, -14));
    expect(sc.keywordCost).toBe(sum(DEMO.keywords, (k) => k.last14.cost));
    expect(sc.saMediaCost).toBe(totalsOf(mediaRows(DEMO, sc.from, sc.to, 'naver_sa')).cost);
    expect(keywordScope(empty(), 7).keywordCost).toBe(0);
  });
});

describe('리뷰 보강 — 계정 권한 · 예상 마감 일관성 · 배치 상태 · 데이터 기반 문구', () => {
  it('데모: Google 비실명 공유 계정(agency-shared@ · 관리자)을 권한 이슈로 탐지 (실명 전환 시 해제)', () => {
    const g = sourceStatuses(DEMO).find((s) => s.id === 'google')!;
    expect(g.account!.tone).toBe('warning');
    expect(g.account!.issues.join(' ')).toContain('agency-shared@');
    expect(g.state).toBe('warn');
    expect(g.route).toBe('alert');
    const acc = validationChecks(DEMO).find((c) => c.id === 'account_state')!;
    expect(acc.detail).toContain('Google');
    expect(acc.basis).toContain('비실명');
    const d = fresh();
    for (const p of d.accounts.find((a) => a.id === 'acc_google')!.permissions) p.realName = true;
    expect(sourceStatuses(d).find((s) => s.id === 'google')!.account!.tone).toBe('good');
  });

  it('계정 점검: 여러 이슈를 모두 모으고 가장 높은 등급을 쓴다', () => {
    const a = { ...DEMO.accounts.find((x) => x.id === 'acc_gfa')!, status: 'review' as const, permissions: [{ user: 'x@', role: '관리자', realName: false, lastLogin: '2026-10-01' }] };
    const info = accountInfo(a)!;
    expect(info.tone).toBe('critical');
    expect(info.issues).toHaveLength(3);
    expect(accountInfo(undefined)).toBeUndefined();
    const ok = accountInfo({ ...a, status: 'active', autoCharge: 'ok', balance: 10_000_000, permissions: [] })!;
    expect(ok.tone).toBe('good');
    expect(ok.label).toBe('정상');
  });

  it('데모: 예상 마감 표시 시각 = 판정 시각 (SA_일반 제품 20:22 · Meta_넓은 타겟 18:06, 시간대 가중)', () => {
    const rows = campaignPaceRows(DEMO);
    const sa = rows.find((r) => r.name === 'SA_일반 제품')!;
    const meta = rows.find((r) => r.name === 'Meta_넓은 타겟')!;
    expect(clock(sa.exhaustHour)).toBe('20:22');
    expect(clock(meta.exhaustHour)).toBe('18:06');
    for (const r of rows) {
      if (r.earlyExhaust) {
        expect(r.exhaustHour!).toBeLessThan(BOARD_RULES.exhaustBeforeHour);
        expect(r.basis).toContain(clock(r.exhaustHour));
      }
    }
    expect(budgetPacing(DEMO).early.map((r) => r.exhaustHour!)).toEqual([...budgetPacing(DEMO).early.map((r) => r.exhaustHour!)].sort((a, b) => a - b));
  });

  it('선형만 조기 · 시간대 가중은 23시 이후인 경우: 선형 시각으로 판정 · 표시 (모순 없음)', () => {
    // 앞쪽이 무겁고 23시 비중이 큰 곡선: 15시까지 75%, 22시까지 90%
    const share = Array.from({ length: 24 }, (_, h) => (h <= 15 ? 0.75 / 16 : h <= 22 ? 0.15 / 7 : 0.1));
    const today = '2026-10-31';
    const mediaHourly = [] as Dataset['mediaHourly'];
    for (let k = 1; k <= 28; k++) {
      const date = addDays(today, -k);
      share.forEach((w, hour) => mediaHourly.push({ date, hour, weekday: 0, media: 'google', impressions: 0, clicks: 0, cost: Math.round(w * 1_000_000), conversions: 0, revenue: 0 }));
    }
    const d: Dataset = { ...empty(), mediaHourly, campaigns: [{ id: 'c1', media: 'google', name: 'G', dailyBudget: 100_000, spentToday: 78_750, status: 'on', hourOfData: 15 }] };
    const r = campaignPaceRows(d)[0];
    expect(r.linearEarly).toBe(true);
    expect(r.curveExhaustHour!).toBeGreaterThanOrEqual(23);
    expect(r.earlyExhaust).toBe(true);
    expect(r.exhaustMethod).toBe('선형');
    expect(r.exhaustHour).toBe(r.linearExhaustHour);
    expect(r.exhaustHour!).toBeLessThan(23);
    expect(r.basis).toContain(clock(r.linearExhaustHour));
    expect(r.basis).toContain('선형 추정');
    expect(r.shortfall).toBeGreaterThan(0);
  });

  it('수집 배치 상태: 07:00 이후 + 전일분 모두 있음 = 완료 · 07:00 전 = 예정 · 전일 행 누락 = 누락', () => {
    expect(collectionSummary(DEMO).batch).toEqual({ state: 'done', missing: [], text: '07:00 완료' });
    const early = generateDemoData('2026-10-31', 6);
    const e = collectionSummary(early);
    expect(e.asOf).toBe('06:30');
    expect(e.batch.state).toBe('pending');
    expect(e.batch.text).toBe('07:00 예정');
    expect(e.timetable[0].state).toBe('pending');
    const gap = fresh();
    gap.mediaDaily = gap.mediaDaily.filter((r) => !(r.media === 'google' && r.date === '2026-10-30'));
    const g = collectionSummary(gap);
    expect(g.batch.state).toBe('missing');
    expect(g.batch.missing).toEqual(['Google']);
    expect(g.timetable[0].state).toBe('pending');
    expect(g.timetable[0].note).toContain('Google');
    expect(collectionSummary(empty()).batch.state).toBe('missing');
    expect(dataBriefText(gap)).toContain('누락');
  });

  it('매체 판단 지표: Google은 증분 미측정을 명시 (자사몰 총액을 Google 성과로 표기하지 않음)', () => {
    const g = mediaComparison(DEMO, periodWindow(DEMO, 'last7')).find((r) => r.media === 'google')!;
    expect(g.judge.value).toContain('증분 미측정');
  });

  it('매출 대조 문구: 방향과 기준을 함께 표기', () => {
    const rec = reconciliation(DEMO, periodWindow(DEMO, 'last7'));
    expect(rec.basis).toMatch(/^채널 광고 경유 추정 대비 [+-]?\d/);
    expect(rec.basis).toContain('허용 ±10%');
  });

  it('위임 범위 문장은 GFA_DELEGATION에서 생성 (p.15 ±10% AE · ±10~30% PM · 30% 초과 수면밀도)', () => {
    expect(delegationText()).toBe('±10% 이내는 담당 AE, ±10~30%는 PM, 30% 초과는 수면밀도 승인');
    expect(briefText(pacingBrief(DEMO))).toContain(delegationText());
  });

  it('기간 브리프: SA 매출 귀속 문장은 데이터 방향을 따른다', () => {
    expect(briefText(periodBrief(DEMO, 'last7'))).toContain('매출 귀속이 광고비 비중보다 큽니다');
    const d = fresh();
    const w = periodWindow(d, 'last7');
    for (const r of d.mediaDaily) if (r.media === 'naver_sa' && r.date >= w.from && r.date <= w.to) r.revenue = Math.round(r.revenue * 0.2);
    const t = briefText(periodBrief(d, 'last7'));
    expect(t).toContain('매출 귀속이 광고비 비중보다 작습니다');
    expect(t).not.toContain('매출 귀속이 광고비 비중보다 큽니다');
  });

  it('판매 채널 브리프: 최대 채널 · 객단가 차이 문장은 데이터에서 계산', () => {
    const base = briefText(channelBrief(DEMO, 'last7'));
    expect(base).toContain('네이버 SA · GFA 효율 변화');
    expect(base).toMatch(/최고 · 최저 차이가 \d+%/);
    const d = fresh();
    for (const r of d.salesDaily) if (r.channel === 'own_mall') { r.revenue *= 12; r.adAttributedRevenue *= 12; }
    const t = briefText(channelBrief(d, 'last7'));
    expect(t).toContain('자사몰 비중이');
    expect(t).not.toContain('네이버 SA · GFA 효율 변화');
    expect(t).not.toContain('객단가 차이가 작으므로');
  });

  it('키워드 브리프: 브랜드 / 비브랜드 ROAS 분리 · 신호 없는 조건이면 품절 · 급변 액션 없음', () => {
    const t = briefText(keywordBrief(DEMO));
    expect(t).toContain('비브랜드');
    expect(t).toMatch(/표본 부족 표기된 키워드가 \d+개입니다\(/);
    const brand = keywordBrief(DEMO, { intents: ['brand'] });
    expect(brand.actions.join(' ')).not.toContain('품절 랜딩');
    expect(brand.interpretation.join(' ')).toContain('브랜드 키워드뿐');
    expect(briefText(keywordBrief(DEMO))).toContain(`일 조정 폭 ${20}% 상한`);
  });

  it('예산 브리프: 조기 소진이 없으면 재배분 액션 대신 재확인 액션', () => {
    const d = fresh();
    for (const c of d.campaigns) c.spentToday = Math.round(c.spentToday * 0.6);
    const b = pacingBrief(d);
    expect(budgetPacing(d).early).toHaveLength(0);
    expect(b.actions[0]).toContain('다시 확인');
    expect(briefText(b)).not.toMatch(NO_BAD_TEXT);
  });

  it('히트맵 색 단계: NaN = 데이터 없음 · 최소 = 0 · 최대 = 6 · 값이 모두 같으면 중간', () => {
    expect(heatLevel(NaN, 0, 10)).toBe(-1);
    expect(heatLevel(0, 0, 10)).toBe(0);
    expect(heatLevel(10, 0, 10)).toBe(6);
    expect(heatLevel(5, 5, 5)).toBe(3);
    expect(heatLevel(4, NaN, NaN)).toBe(3);
  });
});

function dataBriefText(d: Dataset): string {
  return briefText(dataBrief(d));
}

describe('조사 · 나열 (동적 이름 문장)', () => {
  it('받침에 맞는 조사', async () => {
    const { josa, listMore } = await import('./engine');
    expect(josa('네이버 브랜드스토어', '이/가')).toBe('네이버 브랜드스토어가');
    expect(josa('자사몰', '이/가')).toBe('자사몰이');
    expect(josa('SA_일반 제품', '은/는')).toBe('SA_일반 제품은');
    expect(josa('Meta_넓은 타겟', '은/는')).toBe('Meta_넓은 타겟은');
    expect(josa('104만', '으로/로')).toBe('104만으로');
    expect(josa('101만 · 자사몰', '으로/로')).toBe('101만 · 자사몰로');
    expect(josa('108% (기준 105% 초과)', '으로/로')).toBe('108% (기준 105% 초과)로');
    expect(josa('Google', '이/가')).toBe('Google이');
    expect(josa('SA', '이/가')).toBe('SA가');
    expect(listMore([1, 2, 3, 4], 3, String)).toBe('1, 2, 3 외 1개');
    expect(listMore([1, 2], 3, String)).toBe('1, 2');
  });
  it('데모 브리프 문장에 조사 오류가 없다', () => {
    const all = [periodBrief(DEMO), pacingBrief(DEMO), channelBrief(DEMO)].map(briefText).join('\n');
    expect(all).not.toMatch(/스토어이 |제품는 |만로 /);
    expect(all).toContain('네이버 브랜드스토어가 실매출의');
    expect(all).toMatch(/외 \d+개/);
  });
});
