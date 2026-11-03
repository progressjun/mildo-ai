/**
 * QA 회귀 — 일부 기간만 CSV로 올린 매체가 있으면 Board 합계 증감이 부풀던 문제.
 * 서버 Dataset은 실데이터가 들어온 매체에서 데모 행을 통째로 빼므로, 최근 7일만 올린 Google은 직전 7일에 행이 없다(집행 0이 아니라 수집 전).
 * 합계 증감은 직전 기간에 데이터가 있던 매체 · 채널끼리(같은 기준) 비교하고, 뺀 매체 · 채널을 문구로 밝힌다.
 */
import { describe, expect, it } from 'vitest';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import { mediaRows, salesByChannel, totalsOf } from '@/core/selectors';
import { metrics, sum } from '@/core/util';
import { boardKpis, boardPromptPayload, comparableScope, periodBrief, periodWindow } from './engine';

/** 최근 7일(10/24~10/30)과 오늘만 Google 행이 있는 Dataset — CSV로 7일만 올리고 데모 Google이 빠진 상태 */
function googleCsvOnly(from = '2026-10-24'): Dataset {
  return { ...DEMO, mediaDaily: DEMO.mediaDaily.filter((r) => r.media !== 'google' || r.date >= from) };
}

describe('같은 기준 비교 (합계 증감)', () => {
  it('데모(모든 매체 120일)는 제외가 없고 증감이 예전 계산과 같다', () => {
    for (const p of ['yesterday', 'last7', 'last14', 'last30', 'mtd'] as const) {
      const k = boardKpis(DEMO, p);
      expect(k.scope.note, p).toBeNull();
      expect(k.scope.excludedMedia, p).toEqual([]);
      expect(k.deltas.cost, p).toBe(metrics.pctChange(k.cur.cost, k.prev.cost));
      expect(k.deltas.sales, p).toBe(metrics.pctChange(k.sales, k.prevSales));
      expect(k.deltas.mer, p).toBe(metrics.pctChange(k.mer, k.prevMer));
    }
  });

  it('직전 기간에 데이터가 없던 Google은 증감에서 빼고(금액은 전체), 나머지 매체끼리 비교한다', () => {
    const d = googleCsvOnly();
    const k = boardKpis(d, 'last7');
    expect(k.scope.excludedMedia.map((x) => x.id)).toEqual(['google']);
    expect(k.scope.excludedMedia[0].firstDate).toBe('2026-10-24');
    expect(k.scope.note).toContain('Google(10/24부터)은 증감 계산에서 뺐습니다');
    expect(k.scope.note).toContain('10/17–10/23');
    // 금액은 Google 포함 전체
    expect(k.cur.cost).toBe(totalsOf(mediaRows(d, k.win.from, k.win.to)).cost);
    // 증감은 Google을 뺀 매체끼리 — 직전 기간 Google 0원이 깔린 부풀린 증감(prev 전체 기준)과 다르다
    const others = ['naver_sa', 'naver_gfa', 'meta', 'kakao', 'vertical'] as const;
    const c = totalsOf(mediaRows(d, k.win.from, k.win.to, [...others]));
    const p = totalsOf(mediaRows(d, k.win.prevFrom, k.win.prevTo, [...others]));
    expect(k.deltas.cost).toBeCloseTo(metrics.pctChange(c.cost, p.cost), 10);
    const inflated = metrics.pctChange(k.cur.cost, k.prev.cost);
    expect(inflated - k.deltas.cost).toBeGreaterThan(10); // 예전 계산은 10%p 넘게 부풀었다
    // MER도 같은 기준 (판매 채널은 그대로, 광고비만 Google 제외)
    const sales = sum(salesByChannel(d, k.win.from, k.win.to), (x) => x.revenue);
    const prevSales = sum(salesByChannel(d, k.win.prevFrom, k.win.prevTo), (x) => x.revenue);
    expect(k.cmp.mer).toBeCloseTo(sales / c.cost, 10);
    expect(k.deltas.mer).toBeCloseTo(metrics.pctChange(sales / c.cost, prevSales / p.cost), 10);
    // 브리프 · AI 프롬프트에도 기준이 남는다
    expect(periodBrief(d, 'last7').conditions.join(' ')).toContain('같은 기준 비교');
    expect(JSON.parse(boardPromptPayload(d, 'last7')).기간.증감기준).toContain('Google');
  });

  it('직전 기간 시작 전부터 데이터가 있으면(중간 0원 · 행 없음 포함) 제외하지 않는다 — 집행 0은 집행 0으로 비교', () => {
    const w = periodWindow(DEMO, 'last7');
    // 직전 기간 동안 Google 행이 없지만 그 전부터 데이터가 있던 경우 (집행 중지 후 재개)
    const paused: Dataset = { ...DEMO, mediaDaily: DEMO.mediaDaily.filter((r) => r.media !== 'google' || r.date < w.prevFrom || r.date > w.prevTo) };
    expect(comparableScope(paused, w, { from: w.prevFrom, to: w.prevTo }).excludedMedia).toEqual([]);
    // 선택 기간 끝 뒤(오늘)에만 시작한 매체는 이 비교에 영향이 없어 제외 목록에 넣지 않는다
    const todayOnly: Dataset = { ...DEMO, mediaDaily: DEMO.mediaDaily.filter((r) => r.media !== 'kakao' || r.date === DEMO.today) };
    expect(boardKpis(todayOnly, 'last7').scope.excludedMedia).toEqual([]);
  });

  it('판매 채널도 같은 기준 — 직전 기간에 데이터가 없던 채널은 실매출 증감에서 뺀다', () => {
    const d: Dataset = { ...DEMO, salesDaily: DEMO.salesDaily.filter((r) => r.channel !== 'coupang' || r.date >= '2026-10-24') };
    const k = boardKpis(d, 'last7');
    expect(k.scope.excludedChannels.map((x) => x.id)).toEqual(['coupang']);
    const keep = (x: { channel: string }) => x.channel !== 'coupang';
    const cur = sum(salesByChannel(d, k.win.from, k.win.to).filter(keep), (x) => x.revenue);
    const prev = sum(salesByChannel(d, k.win.prevFrom, k.win.prevTo).filter(keep), (x) => x.revenue);
    expect(k.deltas.sales).toBeCloseTo(metrics.pctChange(cur, prev), 10);
    expect(k.sales).toBe(sum(salesByChannel(d, k.win.from, k.win.to), (x) => x.revenue));
  });

  it('비교할 매체가 하나도 남지 않으면 증감을 내지 않는다 (0 대 0을 0.0%라고 하지 않음)', () => {
    const d: Dataset = { ...DEMO, mediaDaily: DEMO.mediaDaily.filter((r) => r.date >= '2026-10-24') };
    const k = boardKpis(d, 'last7');
    expect(k.scope.excludedMedia).toHaveLength(6);
    expect(Number.isNaN(k.deltas.cost)).toBe(true);
    expect(Number.isNaN(k.deltas.roas)).toBe(true);
    expect(Number.isNaN(k.deltas.mer)).toBe(true);
    expect(k.hasData).toBe(true);
  });
});
