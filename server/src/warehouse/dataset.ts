/**
 * Dataset 빌더 — 웨어하우스(wh_*) → 프런트 Dataset(src/core/types.ts). changes · alerts · reports · impact 도메인이 엔진 입력을 이 함수로 만든다.
 *
 * 출처 선택 (docs/SAAS_SPEC.md §2):
 *  - 출처 키: 커넥션 id(실연동 api) · 'csv:<업로드 id>' · 'demo'. 우선순위 = 커넥션 priority(기본 api 100 > csv 50 > demo 10),
 *    커넥션 없는 업로드는 csv 기본값, 같은 우선순위면 최근에 만든 출처.
 *  - 매체 · 채널(그룹)마다: 실데이터 출처(api · csv)가 하나라도 있으면 그 그룹에서 데모 출처는 빼고(테스트 데이터와 실데이터를 섞지 않는다),
 *    (날짜 × 매체/채널)마다 남은 출처 중 우선순위가 가장 높은 하나를 고른다 (예: 오래된 기간은 CSV, 최근은 API).
 *  - 시간대 데이터는 (날짜 × 매체) 단위로 출처 하나를 통째로 쓴다(시간대끼리 출처를 섞지 않는다).
 *
 * 형태:
 *  - dates: 어제까지 days일 + 오늘(진행 중) — 오름차순
 *  - mediaHourly: 최근 35일(오늘 포함)
 *  - keywords: 엔티티(wh_entities) + wh_keyword_daily로 last14(어제까지 14일) · prev14(그 전 14일) · daily(14일) 다시 계산
 *  - searchTerms: 최근 28일(어제까지) 합계, registered = 등록 키워드와 같은 단어 조합(순서 무관)
 *  - campaigns: 오늘 갱신되지 않은 스냅샷은 spentToday 0 · hourOfData 0 (어제 소진액을 오늘 값으로 쓰지 않는다)
 *  - meta: { mode demo|live|mixed, builtAt, sources[{ channel, source, kind, latestDate, latestHour }] }
 */
import type { Queryable } from '../db/pool';
import type {
  AdAccount, Campaign, Dataset, DatasetMeta, DailyMediaRow, DailySalesRow, HourlyMediaRow, Keyword, KeywordStats, MediaId, Product, Promotion, SalesChannelId, SearchTermRow,
} from '@/core/types';
import { MEDIA_IDS, SALES_CHANNEL_IDS } from '@/data/constants';
import { addDaysStr, dateRange, kstIso, kstParts, nowMs } from '../lib/time';

export interface BuildDatasetOptions {
  /** 기준일 (KST, 기본 오늘) */
  today?: string;
  /** 기준 시각 (KST 0~23, 기본 현재) */
  hour?: number;
  /** 일별 데이터 기간 (기본 120일) */
  days?: number;
}

type SourceKind = 'api' | 'csv' | 'demo';
interface SourceInfo { key: string; kind: SourceKind; priority: number; createdMs: number }

const DEFAULT_PRIORITY: Record<SourceKind, number> = { api: 100, csv: 50, demo: 10 };
const HOURLY_DAYS = 35;
const SEARCH_TERM_DAYS = 28;
const SEARCH_TERM_LIMIT = 500;
const MEDIA_ORDER = new Map<string, number>(MEDIA_IDS.map((m, i) => [m, i]));
const SALES_ORDER = new Map<string, number>(SALES_CHANNEL_IDS.map((c, i) => [c, i]));
const CHANNEL_ORDER = new Map<string, number>([...MEDIA_IDS, ...SALES_CHANNEL_IDS].map((c, i) => [c, i]));

const r2 = (n: number) => Math.round(n * 100) / 100;
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** 출처 비교: 우선순위 → 최근 생성 */
function better(a: SourceInfo, b: SourceInfo): boolean {
  return a.priority !== b.priority ? a.priority > b.priority : a.createdMs > b.createdMs;
}

async function loadSources(q: Queryable, wsId: string): Promise<Map<string, SourceInfo>> {
  const m = new Map<string, SourceInfo>();
  const conns = (await q.query<{ id: string; provider: string; priority: number; created_at: Date }>(
    'SELECT id, provider, priority, created_at FROM connections WHERE workspace_id = $1', [wsId],
  )).rows;
  const priorityOfConn = new Map<string, number>();
  for (const c of conns) {
    priorityOfConn.set(c.id, c.priority);
    if (c.provider === 'demo') m.set('demo', { key: 'demo', kind: 'demo', priority: c.priority, createdMs: new Date(c.created_at).getTime() });
    else m.set(c.id, { key: c.id, kind: c.provider === 'csv' ? 'csv' : 'api', priority: c.priority, createdMs: new Date(c.created_at).getTime() });
  }
  if (!m.has('demo')) m.set('demo', { key: 'demo', kind: 'demo', priority: DEFAULT_PRIORITY.demo, createdMs: 0 });
  const ups = (await q.query<{ id: string; connection_id: string | null; created_at: Date }>(
    `SELECT id, connection_id, created_at FROM uploads WHERE workspace_id = $1 AND status = 'imported'`, [wsId],
  )).rows;
  for (const u of ups) {
    const p = u.connection_id ? priorityOfConn.get(u.connection_id) ?? DEFAULT_PRIORITY.csv : DEFAULT_PRIORITY.csv;
    m.set(`csv:${u.id}`, { key: `csv:${u.id}`, kind: 'csv', priority: p, createdMs: new Date(u.created_at).getTime() });
  }
  return m;
}

/**
 * 그룹(매체 · 채널) 단위 데모 제외 + 키 단위 최우선 출처 선택.
 * realGroups: 실데이터(api · csv) 출처가 한 행이라도 있는 그룹 — 모든 테이블에서 미리 모은다(일별은 실데이터인데 시간대는 데모인 식으로 섞이지 않게).
 */
function selectRows<R extends { source: string }>(rows: R[], sources: Map<string, SourceInfo>, realGroups: Set<string>, group: (r: R) => string, key: (r: R) => string): R[] {
  const best = new Map<string, { r: R; s: SourceInfo }>();
  for (const r of rows) {
    const s = sources.get(r.source);
    if (!s) continue; // 지워진 커넥션 · 업로드의 잔여 행
    const g = group(r);
    if (s.kind === 'demo' && realGroups.has(g)) continue;
    const k = `${g}\u0000${key(r)}`;
    const cur = best.get(k);
    if (!cur || better(s, cur.s)) best.set(k, { r, s });
  }
  return [...best.values()].map((x) => x.r);
}

function collectReal<R extends { source: string }>(into: Set<string>, rows: R[], sources: Map<string, SourceInfo>, group: (r: R) => string): void {
  for (const r of rows) {
    const s = sources.get(r.source);
    if (s && s.kind !== 'demo') into.add(group(r));
  }
}

/** 엔티티 그룹: 키워드는 검색광고 채널, 상품은 하나의 그룹, 나머지는 매체 · 채널 */
const entityGroup = (e: { entity_type: string; channel: string | null }) =>
  e.entity_type === 'keyword' ? e.channel ?? 'naver_sa' : e.entity_type === 'product' ? 'products' : e.channel ?? '-';
const KW_GROUP = 'naver_sa';
const BRAND_GROUP = 'brand_search';

interface Used { channel: string; source: string; latestDate: string | null; latestHour: number | null }

function emptyStats(): KeywordStats {
  return { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
}
function addStats(a: KeywordStats, r: KeywordStats): KeywordStats {
  return { impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, cost: a.cost + r.cost, conversions: r2(a.conversions + r.conversions), revenue: a.revenue + r.revenue };
}
const statsOf = (r: { impressions: number; clicks: number; cost: number; conversions: number; revenue: number }): KeywordStats => ({
  impressions: Number(r.impressions), clicks: Number(r.clicks), cost: Number(r.cost), conversions: Number(r.conversions), revenue: Number(r.revenue),
});

/** 검색어 · 키워드 비교용 단어 집합 키 */
const tokenKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

export async function buildDataset(q: Queryable, workspaceId: string, opts: BuildDatasetOptions = {}): Promise<Dataset> {
  const now = kstParts();
  const today = opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : now.date;
  const hour = Number.isInteger(opts.hour) && (opts.hour as number) >= 0 && (opts.hour as number) <= 23 ? (opts.hour as number) : today === now.date ? now.hour : 23;
  const days = Math.max(1, Math.min(400, Math.round(opts.days ?? 120)));
  const yesterday = addDaysStr(today, -1);
  const from = addDaysStr(today, -days);
  const dates = dateRange(from, today);
  const hourlyFrom = addDaysStr(today, -(HOURLY_DAYS - 1));
  const kwFrom = addDaysStr(today, -28);
  const stFrom = addDaysStr(today, -SEARCH_TERM_DAYS);
  const sources = await loadSources(q, workspaceId);
  const used = new Map<string, Used>();
  const markUsed = (channel: string, source: string, date: string | null, hr: number | null = null) => {
    const k = `${channel}\u0000${source}`;
    const u = used.get(k) ?? { channel, source, latestDate: null, latestHour: null };
    if (date && (!u.latestDate || date > u.latestDate)) { u.latestDate = date; u.latestHour = hr; }
    else if (date && date === u.latestDate && hr !== null && (u.latestHour === null || hr > u.latestHour)) u.latestHour = hr;
    used.set(k, u);
  };

  /* ---------- 읽기 (모든 테이블) → 실데이터 그룹 ---------- */
  const mdRows = (await q.query<{ date: string; media: string; source: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number; new_customers: number }>(
    `SELECT date, media, source, impressions, clicks, cost, conversions, revenue, new_customers FROM wh_media_daily WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
    [workspaceId, from, today],
  )).rows.filter((r) => MEDIA_ORDER.has(r.media));
  const hrRows = (await q.query<{ date: string; hour: number; media: string; source: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }>(
    `SELECT date, hour, media, source, impressions, clicks, cost, conversions, revenue FROM wh_media_hourly WHERE workspace_id = $1 AND date BETWEEN $2 AND $3 AND (date < $3 OR hour <= $4)`,
    [workspaceId, hourlyFrom, today, hour],
  )).rows.filter((r) => MEDIA_ORDER.has(r.media));
  const sdRows = (await q.query<{ date: string; channel: string; source: string; visitors: number; detail_views: number; carts: number; orders: number; revenue: number; ad_attributed_revenue: number }>(
    `SELECT date, channel, source, visitors, detail_views, carts, orders, revenue, ad_attributed_revenue FROM wh_sales_daily WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
    [workspaceId, from, today],
  )).rows.filter((r) => SALES_ORDER.has(r.channel));
  const entRows = (await q.query<{ entity_type: string; external_id: string; source: string; channel: string | null; doc: Record<string, unknown>; updated_at: Date }>(
    `SELECT entity_type, external_id, source, channel, doc, updated_at FROM wh_entities WHERE workspace_id = $1`, [workspaceId],
  )).rows;
  const kdRows = (await q.query<{ date: string; keyword_id: string; source: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number; avg_rank: number | null }>(
    `SELECT date, keyword_id, source, impressions, clicks, cost, conversions, revenue, avg_rank FROM wh_keyword_daily WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
    [workspaceId, kwFrom, yesterday],
  )).rows;
  const stRows = (await q.query<{ date: string; term: string; source: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }>(
    `SELECT date, term, source, impressions, clicks, cost, conversions, revenue FROM wh_search_term_daily WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
    [workspaceId, stFrom, yesterday],
  )).rows;
  const bsRows = (await q.query<{ date: string; source: string; volume: number }>(
    `SELECT date, source, volume FROM wh_brand_search_daily WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`, [workspaceId, from, today],
  )).rows;
  const real = new Set<string>();
  collectReal(real, mdRows, sources, (r) => r.media);
  collectReal(real, hrRows, sources, (r) => r.media);
  collectReal(real, sdRows, sources, (r) => r.channel);
  collectReal(real, entRows, sources, entityGroup);
  collectReal(real, kdRows, sources, () => KW_GROUP);
  collectReal(real, stRows, sources, () => KW_GROUP);
  collectReal(real, bsRows, sources, () => BRAND_GROUP);
  const pick = <R extends { source: string }>(rows: R[], group: (r: R) => string, key: (r: R) => string) => selectRows(rows, sources, real, group, key);

  /* ---------- 매체 일별 · 시간대 ---------- */
  const md = pick(mdRows, (r) => r.media, (r) => r.date);

  // (날짜 × 매체) 단위로 출처 하나 — 시간대 행을 출처별로 묶어 고른다
  const hrGroups = new Map<string, { date: string; media: string; source: string }>();
  for (const r of hrRows) hrGroups.set(`${r.date}|${r.media}|${r.source}`, { date: r.date, media: r.media, source: r.source });
  const hrChosen = new Set(pick([...hrGroups.values()], (r) => r.media, (r) => r.date).map((g) => `${g.date}|${g.media}|${g.source}`));
  const mediaHourly: HourlyMediaRow[] = hrRows
    .filter((r) => hrChosen.has(`${r.date}|${r.media}|${r.source}`))
    .map((r) => ({ date: r.date, hour: Number(r.hour), weekday: weekdayOf(r.date), media: r.media as MediaId, impressions: Number(r.impressions), clicks: Number(r.clicks), cost: Number(r.cost), conversions: Number(r.conversions), revenue: Number(r.revenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (MEDIA_ORDER.get(a.media)! - MEDIA_ORDER.get(b.media)!) || a.hour - b.hour));
  for (const r of hrRows) if (hrChosen.has(`${r.date}|${r.media}|${r.source}`)) markUsed(r.media, r.source, r.date, r.date === today ? Number(r.hour) : null);

  const mediaDaily: DailyMediaRow[] = md.map((r) => ({
    date: r.date, media: r.media as MediaId, impressions: Number(r.impressions), clicks: Number(r.clicks), cost: Number(r.cost), conversions: Number(r.conversions), revenue: Number(r.revenue), newCustomers: Number(r.new_customers),
  }));
  for (const r of md) markUsed(r.media, r.source, r.date);
  // 오늘 일별 행이 없고 시간대만 있으면 시간대 합으로 채운다 (진행 중 합계)
  const haveToday = new Set(mediaDaily.filter((r) => r.date === today).map((r) => r.media));
  const hourlyToday = new Map<string, DailyMediaRow>();
  for (const r of mediaHourly) {
    if (r.date !== today || haveToday.has(r.media)) continue;
    const d = hourlyToday.get(r.media) ?? { date: today, media: r.media, impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0, newCustomers: 0 };
    d.impressions += r.impressions; d.clicks += r.clicks; d.cost += r.cost; d.conversions = r2(d.conversions + r.conversions); d.revenue += r.revenue;
    hourlyToday.set(r.media, d);
  }
  mediaDaily.push(...hourlyToday.values());
  mediaDaily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : MEDIA_ORDER.get(a.media)! - MEDIA_ORDER.get(b.media)!));

  /* ---------- 판매 채널 ---------- */
  const sd = pick(sdRows, (r) => r.channel, (r) => r.date);
  const salesDaily: DailySalesRow[] = sd
    .map((r) => ({ date: r.date, channel: r.channel as SalesChannelId, visitors: Number(r.visitors), detailViews: Number(r.detail_views), carts: Number(r.carts), orders: Number(r.orders), revenue: Number(r.revenue), adAttributedRevenue: Number(r.ad_attributed_revenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : SALES_ORDER.get(a.channel)! - SALES_ORDER.get(b.channel)!));
  for (const r of sd) markUsed(r.channel, r.source, r.date);

  /* ---------- 엔티티 ---------- */
  const entOf = (type: string) => pick(entRows.filter((e) => e.entity_type === type), entityGroup, (e) => e.external_id);
  const kwEnt = entOf('keyword');
  const kwSources = new Set(kwEnt.map((e) => e.source));

  /* ---------- 키워드 일별 → last14 · prev14 · daily ---------- */
  const kd = pick(kdRows, () => KW_GROUP, (r) => `${r.keyword_id}|${r.date}`);
  const kdBy = new Map<string, Map<string, (typeof kd)[number]>>();
  const coverage = new Set<string>();
  for (const r of kd) {
    let m = kdBy.get(r.keyword_id);
    if (!m) kdBy.set(r.keyword_id, (m = new Map()));
    m.set(r.date, r);
    coverage.add(r.date);
    markUsed('naver_sa', r.source, r.date);
  }
  const last14Dates = dateRange(addDaysStr(today, -14), yesterday);
  const prev14Dates = dateRange(addDaysStr(today, -28), addDaysStr(today, -15));
  const recent7 = new Set(dateRange(addDaysStr(today, -7), yesterday));
  const keywords: Keyword[] = kwEnt
    .map((e) => {
      const doc = e.doc as unknown as Omit<Keyword, 'last14' | 'prev14' | 'daily'>;
      const m = kdBy.get(e.external_id) ?? new Map();
      const daily = last14Dates.filter((d) => coverage.has(d)).map((d) => (m.get(d) ? statsOf(m.get(d)!) : emptyStats()));
      const last14 = daily.reduce(addStats, emptyStats());
      const prev14 = prev14Dates.reduce((a, d) => (m.get(d) ? addStats(a, statsOf(m.get(d)!)) : a), emptyStats());
      let rankSum = 0, rankW = 0;
      for (const [d, r] of m) if (recent7.has(d) && r.avg_rank !== null && r.avg_rank !== undefined && Number(r.impressions) > 0) { rankSum += Number(r.avg_rank) * Number(r.impressions); rankW += Number(r.impressions); }
      const avgRank = rankW > 0 ? Math.round((rankSum / rankW) * 10) / 10 : Number(doc.avgRank ?? 0);
      return {
        id: String(doc.id ?? e.external_id), text: String(doc.text ?? e.external_id), intent: (doc.intent ?? 'generic') as Keyword['intent'], adgroup: String(doc.adgroup ?? ''),
        isBrand: !!doc.isBrand, bid: Number(doc.bid ?? 0), maxBid: Number(doc.maxBid ?? 0), avgRank, monthlySearch: Number(doc.monthlySearch ?? 0),
        impressionShareLost: Number(doc.impressionShareLost ?? 0), status: (doc.status ?? 'on') as Keyword['status'], landing: String(doc.landing ?? ''),
        last14, prev14, daily,
      };
    })
    .sort((a, b) => natural(a.id, b.id));
  for (const s of kwSources) markUsed('naver_sa', s, null);

  /* ---------- 검색어 (최근 28일 합계) ---------- */
  const st = pick(stRows, () => KW_GROUP, (r) => `${r.term}|${r.date}`);
  const kwTokens = new Set(keywords.map((k) => tokenKey(k.text)));
  const termAgg = new Map<string, SearchTermRow>();
  for (const r of st) {
    const t = termAgg.get(r.term) ?? { term: r.term, impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0, registered: kwTokens.has(tokenKey(r.term)) };
    t.impressions += Number(r.impressions); t.clicks += Number(r.clicks); t.cost += Number(r.cost); t.conversions = r2(t.conversions + Number(r.conversions)); t.revenue += Number(r.revenue);
    termAgg.set(r.term, t);
    markUsed('naver_sa', r.source, r.date);
  }
  const searchTerms = [...termAgg.values()].sort((a, b) => b.clicks - a.clicks || b.cost - a.cost || a.term.localeCompare(b.term)).slice(0, SEARCH_TERM_LIMIT);

  /* ---------- 브랜드 검색량 ---------- */
  const bs = pick(bsRows, () => BRAND_GROUP, (r) => r.date);
  const brandSearchDaily = bs.map((r) => ({ date: r.date, volume: Number(r.volume) })).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const r of bs) markUsed(BRAND_GROUP, r.source, r.date);

  /* ---------- 캠페인 · 계정 · 상품 · 프로모션 ---------- */
  const campaigns: Campaign[] = entOf('campaign')
    .map((e) => {
      const c = e.doc as unknown as Campaign;
      const fresh = kstParts(new Date(e.updated_at).getTime()).date === today || today !== now.date;
      markUsed(String(c.media ?? e.channel ?? '-'), e.source, null);
      return { ...c, spentToday: fresh ? Number(c.spentToday ?? 0) : 0, hourOfData: fresh ? Math.max(0, Math.min(23, Number(c.hourOfData ?? hour))) : 0, dailyBudget: Number(c.dailyBudget ?? 0) };
    })
    .sort((a, b) => (CHANNEL_ORDER.get(a.media) ?? 99) - (CHANNEL_ORDER.get(b.media) ?? 99) || natural(a.id, b.id));
  const accounts: AdAccount[] = entOf('account')
    .map((e) => ({ ...(e.doc as unknown as AdAccount), permissions: Array.isArray((e.doc as { permissions?: unknown }).permissions) ? (e.doc as unknown as AdAccount).permissions : [] }))
    .sort((a, b) => (CHANNEL_ORDER.get(a.media) ?? 99) - (CHANNEL_ORDER.get(b.media) ?? 99) || natural(a.id, b.id));
  const products: Product[] = entOf('product')
    .map((e) => ({ ...(e.doc as unknown as Product), options: Array.isArray((e.doc as { options?: unknown }).options) ? (e.doc as unknown as Product).options : [] }))
    .sort((a, b) => natural(a.id, b.id));
  const promotions: Promotion[] = entOf('promotion').map((e) => e.doc as unknown as Promotion).sort((a, b) => natural(a.id, b.id));

  /* ---------- 메타 ---------- */
  const metaSources: DatasetMeta['sources'] = [...used.values()]
    .map((u) => ({ channel: u.channel, source: u.source, kind: sources.get(u.source)?.kind ?? 'api', latestDate: u.latestDate, latestHour: u.latestDate === today ? u.latestHour : null }))
    .sort((a, b) => (CHANNEL_ORDER.get(a.channel) ?? 99) - (CHANNEL_ORDER.get(b.channel) ?? 99) || a.channel.localeCompare(b.channel) || a.source.localeCompare(b.source));
  const kinds = new Set(metaSources.map((s) => s.kind));
  const mode: DatasetMeta['mode'] = kinds.size === 0 ? 'live' : kinds.has('demo') ? (kinds.size === 1 ? 'demo' : 'mixed') : 'live';
  const builtAt = new Date(nowMs()).toISOString();
  const isNow = today === now.date && hour === now.hour;
  return {
    generatedAt: kstIso(today, hour, isNow ? now.minute : 30),
    today,
    currentHour: hour,
    dates,
    mediaDaily,
    mediaHourly,
    salesDaily,
    keywords,
    campaigns,
    accounts,
    searchTerms,
    products,
    promotions,
    brandSearchDaily,
    meta: { mode, builtAt, sources: metaSources },
  };
}
