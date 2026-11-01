import { describe, expect, it } from 'vitest';
import { generateDemoData, DEMO_TODAY } from './demo';
import { MEDIA, MEDIA_IDS } from './constants';
import { byMedia, campaignPacing, headline, monthlyPacing, rangeOf, totalsOf, mediaRows } from '@/core/selectors';
import { sum } from '@/core/util';

describe('demo dataset', () => {
  const d = generateDemoData();
  it('is deterministic', () => {
    const d2 = generateDemoData();
    expect(d2.mediaDaily[100]).toEqual(d.mediaDaily[100]);
    expect(d2.keywords[3].last14).toEqual(d.keywords[3].last14);
  });
  it('covers 120 days ending today', () => {
    expect(d.dates.length).toBe(120);
    expect(d.dates[d.dates.length - 1]).toBe(DEMO_TODAY);
  });
  it('annual spend scale matches RFP ~50억 and p.37 allocation', () => {
    const r = rangeOf(d, 'last30');
    const t = totalsOf(mediaRows(d, r.from, r.to));
    const annualized = (t.cost / 30) * 365;
    expect(annualized).toBeGreaterThan(4.3e9);
    expect(annualized).toBeLessThan(5.8e9);
    const shares = byMedia(d, r.from, r.to);
    const sa = shares.find((s) => s.media === 'naver_sa')!;
    expect(sa.share).toBeGreaterThan(0.36);
    expect(sa.share).toBeLessThan(0.5);
  });
  it('allocation sums to 100% and 50억', () => {
    expect(sum(MEDIA_IDS, (m) => MEDIA[m].share)).toBeCloseTo(1, 5);
    expect(sum(MEDIA_IDS, (m) => MEDIA[m].annualBudget)).toBe(5_000_000_000);
  });
  it('hourly today sums to daily today', () => {
    for (const m of MEDIA_IDS) {
      const hourly = d.mediaHourly.filter((r) => r.date === d.today && r.media === m);
      const daily = d.mediaDaily.find((r) => r.date === d.today && r.media === m)!;
      expect(sum(hourly, (r) => r.cost)).toBe(daily.cost);
      expect(hourly.length).toBe(d.currentHour + 1);
    }
  });
  it('selectors produce finite headline and pacing', () => {
    const h = headline(d);
    expect(Number.isFinite(h.yesterday.roas)).toBe(true);
    expect(monthlyPacing(d)).toHaveLength(6);
    const cp = campaignPacing(d);
    expect(cp.some((c) => c.earlyExhaust)).toBe(true);
  });
});
