/**
 * 웨어하우스 쓰기 — NormalizedBatch → wh_* 테이블 멱등 upsert (키에 출처 source 포함).
 * 같은 기간을 다시 수집하면 같은 키 행을 덮어쓴다(늦게 잡힌 전환 반영). unnest 배열로 묶어 보내 행 수와 무관하게 쿼리 수가 일정하다.
 * 배치 안 중복 키는 호출 전에 제거되어 있어야 한다(품질 검사 dedupe) — ON CONFLICT가 같은 행을 두 번 갱신할 수 없기 때문.
 * 단위: 금액(광고비 · 매출 · 광고 경유 매출)은 원 단위 정수로 반올림(원화에는 소수 단위가 없다), 전환 · 신규 고객은 소수 둘째 자리(기여 분할),
 * 숫자가 아니거나 무한대면 0.
 */
import type { Queryable } from '../db/pool';
import type { NormalizedBatch } from '../connectors/types';
import { nowMs } from '../lib/time';
import { MEDIA_IDS } from '@/data/constants';

type ColType = 'date' | 'text' | 'int' | 'bigint' | 'numeric' | 'smallint' | 'jsonb';
interface Col { name: string; type: ColType; get: (r: any) => unknown }

const CHUNK = 5000;

async function upsert(q: Queryable, table: string, wsId: string, source: string, at: string, keyCols: string[], cols: Col[], rows: unknown[]): Promise<number> {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const arrays = cols.map((c) => part.map((r) => {
      const v = c.get(r);
      return c.type === 'jsonb' ? JSON.stringify(v ?? null) : v ?? null;
    }));
    const alias = cols.map((_, j) => `c${j}`);
    const unnestArgs = cols.map((c, j) => `$${j + 4}::${c.type === 'jsonb' ? 'text' : c.type}[]`).join(', ');
    const select = cols.map((c, j) => (c.type === 'jsonb' ? `c${j}::jsonb` : `c${j}`)).join(', ');
    const updates = cols.filter((c) => !keyCols.includes(c.name)).map((c) => `${c.name} = EXCLUDED.${c.name}`).concat('updated_at = EXCLUDED.updated_at').join(', ');
    const sql = `INSERT INTO ${table} (workspace_id, source, ${cols.map((c) => c.name).join(', ')}, updated_at)
      SELECT $1, $2, ${select}, $3::timestamptz FROM unnest(${unnestArgs}) AS t(${alias.join(', ')})
      ON CONFLICT (workspace_id, ${keyCols.join(', ')}, source) DO UPDATE SET ${updates}`;
    const r = await q.query(sql, [wsId, source, at, ...arrays]);
    n += r.rowCount;
  }
  return n;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const int = (v: unknown) => Math.round(num(v));
/** 원 단위 금액 */
const krw = int;
/** 소수 둘째 자리 (전환 · 신규 고객) */
const dec2 = (v: unknown) => Math.round(num(v) * 100) / 100;
const MEDIA_CHANNELS = new Set<string>(MEDIA_IDS);

export interface WriteResult { total: number; byTable: Record<string, number> }

export interface WriteOptions {
  /**
   * 엔티티 목록이 '전체 스냅샷'이면 같은 출처 · 종류의 빠진 엔티티를 지운다 (daily · backfill).
   * 목록이 없으면(undefined = 이번에 받지 않음) 그대로 둔다. 빈 배열은 상품 · 프로모션만 '전부 사라짐'으로 보고 그 출처의 해당 종류를 지운다
   * (진행 중 프로모션이 끝났거나 판매 상품이 0개 — 커넥터는 받지 못했을 때 undefined를 둔다). 키워드 · 캠페인 · 계정의 빈 배열은 지우지 않는다
   * (매체 응답 일부 누락으로 계정 전체 엔티티를 날리지 않게).
   */
  replaceEntities?: boolean;
  /** 키워드 엔티티 채널 (기본 naver_sa) */
  keywordChannel?: string;
  /** updated_at에 쓸 시각 (기본: 앱 시계 lib/time nowMs — 테스트 고정 시각과 맞춘다) */
  at?: string;
}

export async function writeBatch(q: Queryable, wsId: string, source: string, b: NormalizedBatch, o: WriteOptions = {}): Promise<WriteResult> {
  const byTable: Record<string, number> = {};
  const at = o.at ?? new Date(nowMs()).toISOString();
  byTable.mediaDaily = await upsert(q, 'wh_media_daily', wsId, source, at, ['date', 'media'], [
    { name: 'date', type: 'date', get: (r) => r.date },
    { name: 'media', type: 'text', get: (r) => r.media },
    { name: 'impressions', type: 'bigint', get: (r) => int(r.impressions) },
    { name: 'clicks', type: 'bigint', get: (r) => int(r.clicks) },
    { name: 'cost', type: 'numeric', get: (r) => krw(r.cost) },
    { name: 'conversions', type: 'numeric', get: (r) => dec2(r.conversions) },
    { name: 'revenue', type: 'numeric', get: (r) => krw(r.revenue) },
    { name: 'new_customers', type: 'numeric', get: (r) => dec2(r.newCustomers) },
  ], b.mediaDaily ?? []);
  byTable.mediaHourly = await upsert(q, 'wh_media_hourly', wsId, source, at, ['date', 'hour', 'media'], [
    { name: 'date', type: 'date', get: (r) => r.date },
    { name: 'hour', type: 'smallint', get: (r) => int(r.hour) },
    { name: 'media', type: 'text', get: (r) => r.media },
    { name: 'impressions', type: 'bigint', get: (r) => int(r.impressions) },
    { name: 'clicks', type: 'bigint', get: (r) => int(r.clicks) },
    { name: 'cost', type: 'numeric', get: (r) => krw(r.cost) },
    { name: 'conversions', type: 'numeric', get: (r) => dec2(r.conversions) },
    { name: 'revenue', type: 'numeric', get: (r) => krw(r.revenue) },
  ], b.mediaHourly ?? []);
  byTable.salesDaily = await upsert(q, 'wh_sales_daily', wsId, source, at, ['date', 'channel'], [
    { name: 'date', type: 'date', get: (r) => r.date },
    { name: 'channel', type: 'text', get: (r) => r.channel },
    { name: 'visitors', type: 'bigint', get: (r) => int(r.visitors) },
    { name: 'detail_views', type: 'bigint', get: (r) => int(r.detailViews) },
    { name: 'carts', type: 'bigint', get: (r) => int(r.carts) },
    { name: 'orders', type: 'bigint', get: (r) => int(r.orders) },
    { name: 'revenue', type: 'numeric', get: (r) => krw(r.revenue) },
    { name: 'ad_attributed_revenue', type: 'numeric', get: (r) => krw(r.adAttributedRevenue) },
  ], b.salesDaily ?? []);
  byTable.keywordDaily = await upsert(q, 'wh_keyword_daily', wsId, source, at, ['date', 'keyword_id'], [
    { name: 'date', type: 'date', get: (r) => r.date },
    { name: 'keyword_id', type: 'text', get: (r) => r.keywordId },
    { name: 'impressions', type: 'bigint', get: (r) => int(r.impressions) },
    { name: 'clicks', type: 'bigint', get: (r) => int(r.clicks) },
    { name: 'cost', type: 'numeric', get: (r) => krw(r.cost) },
    { name: 'conversions', type: 'numeric', get: (r) => dec2(r.conversions) },
    { name: 'revenue', type: 'numeric', get: (r) => krw(r.revenue) },
    { name: 'avg_rank', type: 'numeric', get: (r) => (typeof r.avgRank === 'number' && Number.isFinite(r.avgRank) ? r.avgRank : null) },
  ], b.keywordDaily ?? []);
  byTable.searchTermDaily = await upsert(q, 'wh_search_term_daily', wsId, source, at, ['date', 'term'], [
    { name: 'date', type: 'date', get: (r) => r.date },
    { name: 'term', type: 'text', get: (r) => r.term },
    { name: 'impressions', type: 'bigint', get: (r) => int(r.impressions) },
    { name: 'clicks', type: 'bigint', get: (r) => int(r.clicks) },
    { name: 'cost', type: 'numeric', get: (r) => krw(r.cost) },
    { name: 'conversions', type: 'numeric', get: (r) => dec2(r.conversions) },
    { name: 'revenue', type: 'numeric', get: (r) => krw(r.revenue) },
  ], b.searchTermDaily ?? []);
  byTable.brandSearchDaily = await upsert(q, 'wh_brand_search_daily', wsId, source, at, ['date'], [
    { name: 'date', type: 'date', get: (r) => r.date },
    { name: 'volume', type: 'bigint', get: (r) => int(r.volume) },
  ], b.brandSearchDaily ?? []);

  const ent: { type: 'keyword' | 'campaign' | 'account' | 'product' | 'promotion'; list: any[] | undefined; channel: (x: any) => string | null }[] = [
    // 키워드 채널: 문서의 매체(Google Ads 키워드는 'google') → 커넥션 채널 → 네이버 SA
    { type: 'keyword', list: b.keywords, channel: (x) => (typeof x.media === 'string' && MEDIA_CHANNELS.has(x.media) ? x.media : o.keywordChannel ?? 'naver_sa') },
    { type: 'campaign', list: b.campaigns, channel: (x) => x.media ?? null },
    { type: 'account', list: b.accounts, channel: (x) => x.media ?? null },
    { type: 'product', list: b.products, channel: () => null },
    { type: 'promotion', list: b.promotions, channel: (x) => x.channel ?? null },
  ];
  for (const e of ent) {
    if (!e.list) continue;
    const list = e.list.map((x) => {
      if (e.type === 'keyword') {
        const { last14: _a, prev14: _b, daily: _c, ...rest } = x;
        return rest;
      }
      return x;
    });
    byTable[`${e.type}s`] = await upsert(q, 'wh_entities', wsId, source, at, ['entity_type', 'external_id'], [
      { name: 'entity_type', type: 'text', get: () => e.type },
      { name: 'external_id', type: 'text', get: (r) => String(r.id) },
      { name: 'channel', type: 'text', get: (r) => e.channel(r) },
      { name: 'doc', type: 'jsonb', get: (r) => r },
    ], list);
    const emptySnapshot = list.length === 0 && (e.type === 'product' || e.type === 'promotion');
    if (o.replaceEntities && (list.length || emptySnapshot)) {
      await q.query(
        `DELETE FROM wh_entities WHERE workspace_id = $1 AND entity_type = $2 AND source = $3 AND NOT (external_id = ANY($4::text[]))`,
        [wsId, e.type, source, list.map((x) => String(x.id))],
      );
    }
  }
  const total = Object.values(byTable).reduce((a, b2) => a + b2, 0);
  return { total, byTable };
}

export const WH_TABLES = ['wh_media_daily', 'wh_media_hourly', 'wh_sales_daily', 'wh_keyword_daily', 'wh_search_term_daily', 'wh_brand_search_daily', 'wh_entities'] as const;

/** 출처 하나의 웨어하우스 데이터를 모두 지운다 (커넥션 삭제 · 업로드 되돌리기) */
export async function purgeSource(q: Queryable, wsId: string, source: string): Promise<number> {
  let n = 0;
  for (const t of WH_TABLES) n += (await q.query(`DELETE FROM ${t} WHERE workspace_id = $1 AND source = $2`, [wsId, source])).rowCount;
  return n;
}
