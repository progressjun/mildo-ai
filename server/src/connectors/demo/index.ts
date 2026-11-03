/**
 * 데모 데이터 커넥터 (TEST DATA — 실제 성과 데이터 아님). 체험 · 시연용 워크스페이스가 바로 120일치 데이터를 갖도록
 * 기존 생성기(src/data/demo.ts generateDemoData)를 **실제 현재 KST 날짜 기준**으로 돌려 요청 기간의 표준 레코드를 만든다.
 *
 *  - 최근 120일: generateDemoData(오늘, 23시)로 과거 일자를, generateDemoData(오늘, 현재 시각)로 오늘(진행 중) 값을 만든다.
 *    과거 일자 값이 수집 시각에 따라 흔들리지 않게 하기 위함 (같은 날 여러 번 수집해도 같은 값 — 멱등).
 *  - 120일보다 오래된 기간: 119일 단위 블록마다 기준일을 옮겨 생성한다 (블록 기준일 당일 값은 쓰지 않아 '오늘 이상 주입'이 섞이지 않는다).
 *  - 키워드 일별: 최근 14일은 생성기의 daily, 그 전 14일은 prev14 합계를 날짜별로 고르게 나눈다(합계 보존).
 *  - 검색어: 생성기의 28일 합계를 최근 28일(어제까지)에 고르게 나눈다(합계 보존).
 *  - 프로모션 기간 · 계정 최근 접속일은 생성기 기준일(2026-10-31)과 오늘의 차이만큼 옮긴다.
 *  - apply: 실제 매체 호출 없이 시뮬레이션 결과만 돌려준다 (데모 워크스페이스에서 승인 → 반영 흐름 시연용).
 */
import { z } from 'zod';
import type { ConnectorDef, ConnectorContext, DateRange, NormalizedBatch } from '../types';
import type { Dataset, KeywordStats } from '@/core/types';
import { generateDemoData, DEMO_TODAY } from '@/data/demo';
import { addDaysStr, kstParts } from '../../lib/time';

const BLOCK = 119;
const cache = new Map<string, Dataset>();
function gen(today: string, hour: number): Dataset {
  const key = `${today}@${hour}`;
  let d = cache.get(key);
  if (!d) {
    d = generateDemoData(today, hour);
    cache.set(key, d);
    while (cache.size > 8) cache.delete(cache.keys().next().value as string);
  }
  return d;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** 정수 합계를 n칸에 고르게 (앞 칸부터 나머지 1씩) */
function spreadInt(total: number, n: number): number[] {
  const t = Math.round(total);
  const base = Math.floor(t / n);
  const rem = t - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}
/** 정수 합계를 가중치 비율로 나눈다 (최대 나머지 방식 — 합계 보존). 가중치 합이 0이면 고르게 */
function spreadBy(total: number, weights: number[]): number[] {
  const t = Math.round(total);
  const w = weights.reduce((a, b) => a + b, 0);
  if (w <= 0) return spreadInt(t, weights.length);
  const raw = weights.map((x) => (t * x) / w);
  const out = raw.map(Math.floor);
  let rem = t - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rem > 0 && k < order.length; k++, rem--) out[order[k][1]]++;
  return out;
}
/**
 * 기간 합계를 n일로 나눈다: 노출 · 클릭은 고르게, 광고비 · 전환은 클릭 비율로, 매출은 전환 비율로 (합계 보존).
 * 클릭 없는 날에 전환 · 비용이 생기지 않게 해 품질 검사(전환 > 클릭 · 광고비 0인데 클릭)에 걸리지 않는다.
 */
function spreadStats(s: KeywordStats, n: number): KeywordStats[] {
  const imp = spreadInt(s.impressions, n), clk = spreadInt(s.clicks, n);
  const cost = spreadBy(s.cost, clk);
  const conv = spreadBy(Math.round(s.conversions * 100), clk);
  const rev = spreadBy(s.revenue, conv.some((x) => x > 0) ? conv : clk);
  return Array.from({ length: n }, (_, i) => ({ impressions: imp[i], clicks: clk[i], cost: cost[i], conversions: conv[i] / 100, revenue: rev[i] }));
}

interface Block { ds: Dataset; from: string; to: string }

/** 기간을 덮는 생성 블록 (오늘 블록은 과거 일자용 23시 버전) */
function blocksFor(anchor: string, from: string): Block[] {
  const out: Block[] = [{ ds: gen(anchor, 23), from: addDaysStr(anchor, -BLOCK), to: addDaysStr(anchor, -1) }];
  for (let k = 1; out[out.length - 1].from > from && k < 40; k++) {
    const a = addDaysStr(anchor, -BLOCK * k);
    out.push({ ds: gen(a, 23), from: addDaysStr(a, -BLOCK), to: addDaysStr(a, -1) });
  }
  return out;
}

export function demoBatch(range: DateRange, now: { date: string; hour: number }, opts: { intradayDate?: string } = {}): NormalizedBatch {
  const anchor = now.date;
  const to = range.to > anchor ? anchor : range.to;
  const from = range.from;
  const batch: Required<Pick<NormalizedBatch, 'mediaDaily' | 'mediaHourly' | 'salesDaily' | 'keywordDaily' | 'searchTermDaily' | 'brandSearchDaily'>> & NormalizedBatch = {
    mediaDaily: [], mediaHourly: [], salesDaily: [], keywordDaily: [], searchTermDaily: [], brandSearchDaily: [],
  };
  if (from > to) return batch;
  const inRange = (d: string) => d >= from && d <= to;
  const wantPast = from < anchor;
  const wantToday = to >= anchor;

  if (wantPast) {
    const pastTo = to < anchor ? to : addDaysStr(anchor, -1);
    blocksFor(anchor, from).forEach((b, bi) => {
      const ok = (d: string) => d >= b.from && d <= b.to && d >= from && d <= pastTo;
      for (const r of b.ds.mediaDaily) if (ok(r.date)) batch.mediaDaily.push({ date: r.date, media: r.media, impressions: r.impressions, clicks: r.clicks, cost: r.cost, conversions: r.conversions, revenue: r.revenue, newCustomers: r.newCustomers });
      for (const r of b.ds.salesDaily) if (ok(r.date)) batch.salesDaily.push({ ...r });
      for (const r of b.ds.brandSearchDaily) if (ok(r.date)) batch.brandSearchDaily.push({ ...r });
      // 시간대는 최근 35일만 (가장 최근 블록) — Dataset도 35일만 쓴다
      if (bi === 0) for (const r of b.ds.mediaHourly) if (ok(r.date)) batch.mediaHourly.push({ date: r.date, hour: r.hour, media: r.media, impressions: r.impressions, clicks: r.clicks, cost: r.cost, conversions: r.conversions, revenue: r.revenue });
    });
    const cur = gen(anchor, 23);
    // 키워드: daily = 어제까지 14일, 그 전 14일은 prev14 합계 분할
    for (const k of cur.keywords) {
      k.daily.forEach((s, i) => {
        const date = addDaysStr(anchor, -k.daily.length + i);
        if (date >= from && date <= pastTo) batch.keywordDaily.push({ date, keywordId: k.id, ...s });
      });
      spreadStats(k.prev14, 14).forEach((s, i) => {
        const date = addDaysStr(anchor, -28 + i);
        if (date >= from && date <= pastTo) batch.keywordDaily.push({ date, keywordId: k.id, ...s });
      });
    }
    for (const t of cur.searchTerms) {
      const parts = spreadStats(t, 28);
      parts.forEach((s, i) => {
        const date = addDaysStr(anchor, -28 + i);
        if (date >= from && date <= pastTo) batch.searchTermDaily.push({ date, term: t.term, ...s });
      });
    }
  }

  const nowDs = gen(anchor, now.hour);
  if (wantToday || opts.intradayDate === anchor) {
    for (const r of nowDs.mediaDaily) if (r.date === anchor) batch.mediaDaily.push({ date: r.date, media: r.media, impressions: r.impressions, clicks: r.clicks, cost: r.cost, conversions: r.conversions, revenue: r.revenue, newCustomers: r.newCustomers });
    for (const r of nowDs.mediaHourly) if (r.date === anchor) batch.mediaHourly.push({ date: r.date, hour: r.hour, media: r.media, impressions: r.impressions, clicks: r.clicks, cost: r.cost, conversions: r.conversions, revenue: r.revenue });
    for (const r of nowDs.salesDaily) if (r.date === anchor) batch.salesDaily.push({ ...r });
    for (const r of nowDs.brandSearchDaily) if (r.date === anchor) batch.brandSearchDaily.push({ ...r });
  }

  // 엔티티 스냅샷 (현재 상태). 날짜가 박힌 값은 생성기 기준일과의 차이만큼 옮긴다.
  const shift = daysBetween(DEMO_TODAY, anchor);
  const sh = (d: string) => (shift ? addDaysStr(d, shift) : d);
  batch.campaigns = nowDs.campaigns.map((c) => ({ ...c }));
  batch.accounts = nowDs.accounts.map((a) => ({ ...a, permissions: a.permissions.map((p) => ({ ...p, lastLogin: /^\d{4}-\d{2}-\d{2}$/.test(p.lastLogin) ? sh(p.lastLogin) : p.lastLogin })) }));
  if (opts.intradayDate !== anchor || wantPast) {
    batch.keywords = nowDs.keywords.map(({ last14: _l, prev14: _p, daily: _d, ...k }) => ({ ...k }));
    batch.products = nowDs.products.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o })) }));
    batch.promotions = nowDs.promotions.map((p) => {
      const start = sh(p.start), end = sh(p.end);
      const status = end < anchor ? 'ended' : start <= anchor ? 'live' : 'planned';
      return { ...p, start, end, status };
    });
  }
  // inRange 사용: 미래 날짜 방어 (기간이 오늘을 넘으면 오늘까지만)
  batch.mediaDaily = batch.mediaDaily.filter((r) => inRange(r.date));
  return batch;
}

export const connector: ConnectorDef = {
  provider: 'demo',
  kind: 'other',
  channel: null,
  label: '데모 데이터 (TEST DATA)',
  docsUrl: '',
  verifiedLive: false,
  credentialsSchema: z.object({}).passthrough(),
  settingsSchema: z.object({}).passthrough(),
  credentialFields: [],
  capabilities: {
    reads: ['mediaDaily', 'mediaHourly', 'salesDaily', 'keywordDaily', 'searchTermDaily', 'brandSearchDaily', 'keywords', 'campaigns', 'accounts', 'products', 'promotions'],
    writes: ['bid', 'budget', 'status'],
    intraday: true,
    maxBackfillDays: 400,
  },
  async test() {
    const p = kstParts();
    return { ok: true, message: `데모 데이터 생성기 — 실제 매체 호출 없음 (기준 ${p.date} ${p.hour}시, TEST DATA)`, account: '데모 계정 (TEST DATA)' };
  },
  async fetch(_ctx: ConnectorContext, range: DateRange, opts?: { intradayDate?: string }) {
    const p = kstParts();
    return demoBatch(range, { date: p.date, hour: p.hour }, opts);
  },
  async apply(ctx, change) {
    const request = { simulated: true, kind: change.kind, target: change.target, targetId: change.targetId ?? null, before: change.before, after: change.after };
    ctx.log(`[demo] ${ctx.dryRun ? 'dry_run' : 'live(시뮬레이션)'} ${change.kind} ${change.target}: ${change.before} → ${change.after}`);
    return {
      ok: true,
      request,
      response: { simulated: true, message: '데모 커넥터 — 실제 매체 호출 없이 반영 결과를 시뮬레이션했습니다 (TEST DATA)' },
      appliedValue: typeof change.after === 'number' || typeof change.after === 'string' ? change.after : undefined,
    };
  },
};
