/**
 * SearchTuneOS · GEO 엔진 — 순수 함수 (React 없음). 제안서 p.29 · p.9
 *
 *  - 제품페이지 진단: HTML 문자열 → PageFacts(정규식 추출, DOM 없는 환경에서도 동작) → 항목별 판정 · 점수.
 *    브라우저에서는 dom.ts가 DOMParser로 같은 PageFacts를 만든다. 판정(auditPage)은 하나다.
 *    운영 데이터(state.data.products · promotions)와 JSON-LD 가격 · 재고를 대조한다 (킹 옵션 품절 등).
 *  - GEO 모니터링: 질의 20개 × 엔진 5개 × 최근 4회 데모 진단 스냅샷 → 브랜드 언급률 · 인용 수 · 경쟁사 대비 점유.
 *  - 라이브 진단: Claude 답변 텍스트 → 브랜드 언급 여부 · 순서 · 경쟁사 · 인용 출처 파싱.
 *  - 페이드 AI 지면: 질의 ↔ SA 키워드(data.keywords) ↔ 검색어 보고서(data.searchTerms) 연결 → SA 반영 판정.
 *  - AEO FAQ: 규칙 기반 초안(사이즈 · 가격은 데이터에서) → REVIEW_RULES 검수 → FAQPage JSON-LD.
 */
import type { Brief } from '@/ai/prompts';
import type { ApprovalLevel, ChangeRequest, Dataset, IntentId, Keyword, Product, Promotion, SalesChannelId } from '@/core/types';
import { AD_PILOT, CAUSE_CANDIDATES, KEYWORD_TEST_RULES, RFP, REVIEW_RULES, SA_CAMPAIGNS } from '@/data/constants';
import { addDays, clamp, fmt, fmtDate, hashString, metrics, rng, sum, weekday } from '@/core/util';
import {
  AEO_TOPICS, AUDIT_RULES, BRAND_STRONG_PATTERN, CITE_LABEL, COMPETITOR_ALIASES, DENSITY_CONTEXT_PATTERN, GEO_ENGINES, GEO_QUERIES, GEO_ROUNDS,
  GEO_ROUND_WEEKDAY, GEO_RULES, INTENT_COMPETITOR_MULT, INTENT_MENTION_MULT, OTHER_BRANDS, OWNED_DOMAINS, REVIEW_FIX, SHIFT_RULES, SHOPPING_EXPOSE,
  type AeoTopicId, type GeoEngineDef, type GeoEngineId, type GeoQuery,
} from './data';

export const BRAND = '수면밀도';

/* ============================== 공통 ============================== */

export type GeoTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'outline' | 'accent' | 'dark';
export interface Verdict { id: string; label: string; tone: GeoTone; basis: string }

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
export const clip = (s: string, n: number) => {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : s;
};
const charLen = (s: string) => [...s].length;
const safeDiv = (n: number, d: number) => (d > 0 && Number.isFinite(n) ? n / d : 0);
const r0 = (n: number) => (Number.isFinite(n) ? Math.round(n) : null);
const r1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
export const round = { r0, r1, pct: (ratio: number) => r1(ratio * 100) };
const pctTxt = (ratio: number, d = 0) => (Number.isFinite(ratio) ? `${(ratio * 100).toFixed(d)}%` : '—');
const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[\s·_\-|/,.()[\]:]+/g, '');

/** 'YYYY-MM-DD' → '10/26(월)' · 날짜가 없거나 형식이 다르면 '—' (fmtDate의 NaN 표기 방지) */
export function dateLabel(s: string | null | undefined, withWeekday = true): string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? fmtDate(s, withWeekday) : '—';
}

export const INTENT_LABEL: Record<IntentId, string> = {
  brand: SA_CAMPAIGNS.brand.name, generic: SA_CAMPAIGNS.generic.name, problem: SA_CAMPAIGNS.problem.name, compare: SA_CAMPAIGNS.compare.name, life: SA_CAMPAIGNS.life.name,
};
export const ENGINE_BY_ID: Record<GeoEngineId, GeoEngineDef> = Object.fromEntries(GEO_ENGINES.map((e) => [e.id, e])) as Record<GeoEngineId, GeoEngineDef>;
export const QUERY_BY_ID: Record<string, GeoQuery> = Object.fromEntries(GEO_QUERIES.map((q) => [q.id, q]));

/* ============================== HTML 추출 (정규식) ============================== */

export interface ImgFact { src: string; alt: string | null }
export interface JsonLdBlock { raw: string; data: unknown; error: string | null }
export interface PriceFact { value: number; text: string; option: string | null; kind: 'sale' | 'list' | 'price'; source: 'itemprop' | 'data-attr' | 'class' }
export interface PageFacts {
  parser: 'regex' | 'dom';
  title: string | null;
  metas: { key: string; content: string }[];
  canonical: string | null;
  lang: string | null;
  h1: string[];
  images: ImgFact[];
  jsonLd: JsonLdBlock[];
  prices: PriceFact[];
  /** 화면에 보이는 본문 텍스트 (script · style · head 제외) */
  text: string;
  bytes: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', won: '₩' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s ?? ''))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const ATTRS = '((?:\\s+[^\\s=/>"\']+(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>"\']+))?)*)';
const VOID_TAG_RE = (name: string) => new RegExp(`<${name}\\b${ATTRS}\\s*\\/?>`, 'gi');

export function htmlToText(fragment: string): string {
  return collapse(decodeEntities(
    fragment
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ));
}

/**
 * 여는 태그를 한 번만 훑어(선형) 조건에 맞는 요소의 안쪽 HTML을 찾는다.
 * 닫는 태그는 가까운 범위(maxInner)에서만 찾으므로 닫히지 않은 태그가 많은 큰 페이지에서도 느려지지 않는다.
 */
function elementsWhere(html: string, want: (tag: string, rawAttrs: string) => boolean, maxInner = 4000): { tag: string; attrs: Record<string, string>; inner: string }[] {
  const re = new RegExp(`<([a-zA-Z][\\w-]*)${ATTRS}\\s*>`, 'g');
  const out: { tag: string; attrs: Record<string, string>; inner: string }[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 50000) {
    const tag = m[1].toLowerCase();
    const raw = m[2] ?? '';
    if (!want(tag, raw)) continue;
    const start = m.index + m[0].length;
    const window = html.slice(start, start + maxInner);
    const close = window.search(new RegExp(`<\\/${tag}\\s*>`, 'i'));
    if (close < 0) continue;
    out.push({ tag, attrs: parseAttrs(raw), inner: window.slice(0, close) });
  }
  return out;
}

export function parsePrice(s: string | number | null | undefined): number | null {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : null;
  if (s == null) return null;
  const m = String(s).match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** 가격 요소 분류 — DOM 추출기(dom.ts)와 같은 규칙을 쓴다 */
export function priceFactFrom(tag: string, attrs: Record<string, string>, innerText: string): PriceFact | null {
  const t = tag.toLowerCase();
  const cls = `${attrs.class ?? ''} ${attrs.id ?? ''}`.toLowerCase();
  const isItemprop = (attrs.itemprop ?? '').toLowerCase() === 'price';
  const hasData = attrs['data-price'] !== undefined && attrs['data-price'] !== '';
  if (!isItemprop && !hasData && !/price/.test(cls)) return null;
  if (!isItemprop && !hasData && /(box|wrap|area|group|container|info|label|unit|currency|rate|percent)/.test(cls)) return null;
  const text = collapse(innerText);
  const raw = isItemprop && attrs.content ? attrs.content : hasData ? attrs['data-price'] : text;
  if (!isItemprop && !hasData && !/(원|₩|,\d{3})/.test(text)) return null;
  const value = parsePrice(raw);
  if (value === null || value < 100) return null;
  const isList = t === 'del' || t === 's' || t === 'strike' || /(list|origin|regular|before|strike|normal|consumer|retail)/.test(cls);
  const isSale = /(sale|final|discount|selling|current|now)/.test(cls);
  return {
    value, text: text || String(raw), option: attrs['data-option'] ?? null,
    kind: isList ? 'list' : isSale ? 'sale' : 'price',
    source: isItemprop ? 'itemprop' : hasData ? 'data-attr' : 'class',
  };
}

export function parseJsonLd(raw: string): JsonLdBlock {
  const txt = String(raw ?? '').trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
  if (!txt) return { raw: txt, data: null, error: '빈 JSON-LD 블록' };
  try {
    return { raw: txt, data: JSON.parse(txt), error: null };
  } catch (e) {
    return { raw: txt, data: null, error: String((e as Error)?.message ?? 'JSON 구문 오류').slice(0, 120) };
  }
}

/** 정규식 기반 추출 — vitest(node)와 DOMParser 없는 환경용. 판정은 auditPage가 한다. */
export function extractPageFacts(html: string): PageFacts {
  const src = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
  const jsonLd: JsonLdBlock[] = [];
  for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const a = parseAttrs(m[1]);
    if ((a.type ?? '').toLowerCase().includes('ld+json')) jsonLd.push(parseJsonLd(m[2]));
  }
  const clean = src.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const titleM = clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const metas: PageFacts['metas'] = [];
  let canonical: string | null = null;
  for (const m of clean.matchAll(VOID_TAG_RE('meta'))) {
    const a = parseAttrs(m[1] ?? '');
    const key = (a.name ?? a.property ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined) metas.push({ key, content: a.content });
  }
  for (const m of clean.matchAll(VOID_TAG_RE('link'))) {
    const a = parseAttrs(m[1] ?? '');
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') && a.href) { canonical = a.href; break; }
  }
  const htmlTag = clean.match(new RegExp(`<html\\b${ATTRS}\\s*>`, 'i'));
  const lang = htmlTag ? parseAttrs(htmlTag[1] ?? '').lang ?? null : null;
  const images: ImgFact[] = [];
  for (const m of clean.matchAll(VOID_TAG_RE('img'))) {
    const a = parseAttrs(m[1] ?? '');
    images.push({ src: a.src ?? a['data-src'] ?? '', alt: 'alt' in a ? a.alt : null });
  }
  const bodyM = clean.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  const bodyHtml = bodyM ? bodyM[1] : clean.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ').replace(/<title\b[\s\S]*?<\/title\s*>/i, ' ');
  const h1 = elementsWhere(bodyHtml, (t) => t === 'h1', 20000).map((e) => htmlToText(e.inner));
  const prices: PriceFact[] = [];
  for (const e of elementsWhere(bodyHtml, (_t, raw) => /price/i.test(raw))) {
    const p = priceFactFrom(e.tag, e.attrs, htmlToText(e.inner));
    if (p) prices.push(p);
  }
  // itemprop="price" content 메타 (요소가 아니라 meta로 들어온 경우)
  for (const m of metas) if (m.key === 'price' || m.key === 'product:price:amount') {
    const v = parsePrice(m.content);
    if (v !== null && v >= 100) prices.push({ value: v, text: m.content, option: null, kind: 'price', source: 'itemprop' });
  }
  return {
    parser: 'regex',
    title: titleM ? collapse(decodeEntities(titleM[1].replace(/<[^>]+>/g, ' '))) || null : null,
    metas, canonical, lang, h1, images, jsonLd, prices,
    text: htmlToText(bodyHtml),
    bytes: src.length,
  };
}

/* ============================== JSON-LD 해석 ============================== */

export interface OfferLd { name: string | null; sku: string | null; price: number | null; currency: string | null; availability: 'InStock' | 'OutOfStock' | 'PreOrder' | 'other' | null; validUntil: string | null }
export interface ProductLd { name: string | null; brand: string | null; image: boolean; offers: OfferLd[]; rating: { value: number; count: number } | null; ratingRaw: boolean }
export interface FaqLd { count: number; items: { q: string; a: string }[] }

function ldNodes(blocks: JsonLdBlock[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('@type' in o) out.push(o);
      if (Array.isArray(o['@graph'])) visit(o['@graph'], depth + 1);
    }
  };
  for (const b of blocks) visit(b.data, 0);
  return out;
}
function hasType(o: Record<string, unknown>, t: string): boolean {
  const ty = o['@type'];
  const list = Array.isArray(ty) ? ty : [ty];
  return list.some((x) => String(x ?? '').toLowerCase() === t.toLowerCase());
}
function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') return ((v as { name: string }).name).trim() || null;
  return null;
}
function availabilityOf(v: unknown): OfferLd['availability'] {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s.includes('outofstock') || s.includes('soldout') || s.includes('discontinued')) return 'OutOfStock';
  if (s.includes('instock') || s.includes('in_stock') || s.includes('limitedavailability') || s.includes('onlineonly')) return 'InStock';
  if (s.includes('preorder') || s.includes('backorder') || s.includes('presale')) return 'PreOrder';
  return 'other';
}
function offersOf(v: unknown, depth = 0): OfferLd[] {
  if (v == null || depth > 4) return [];
  if (Array.isArray(v)) return v.flatMap((x) => offersOf(x, depth + 1));
  if (typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  if (hasType(o, 'AggregateOffer')) {
    const nested = offersOf(o.offers, depth + 1);
    if (nested.length) return nested;
    return [{ name: str(o.name), sku: str(o.sku), price: parsePrice(o.lowPrice as string ?? o.price as string), currency: str(o.priceCurrency), availability: availabilityOf(o.availability), validUntil: str(o.priceValidUntil) }];
  }
  return [{ name: str(o.name), sku: str(o.sku), price: parsePrice((o.price ?? null) as string | number | null), currency: str(o.priceCurrency), availability: availabilityOf(o.availability), validUntil: str(o.priceValidUntil) }];
}

export function productFromLd(blocks: JsonLdBlock[]): ProductLd | null {
  const node = ldNodes(blocks).find((o) => hasType(o, 'Product'));
  if (!node) return null;
  const ar = node.aggregateRating as Record<string, unknown> | undefined;
  const value = ar ? Number(ar.ratingValue) : NaN;
  const count = ar ? Number(ar.reviewCount ?? ar.ratingCount) : NaN;
  return {
    name: str(node.name),
    brand: str(node.brand),
    image: node.image != null && node.image !== '' && !(Array.isArray(node.image) && node.image.length === 0),
    offers: offersOf(node.offers),
    rating: Number.isFinite(value) && Number.isFinite(count) && count > 0 && value > 0 ? { value, count } : null,
    ratingRaw: ar != null,
  };
}

export function faqFromLd(blocks: JsonLdBlock[]): FaqLd {
  const items: { q: string; a: string }[] = [];
  for (const node of ldNodes(blocks).filter((o) => hasType(o, 'FAQPage'))) {
    const me = node.mainEntity;
    for (const q of (Array.isArray(me) ? me : me ? [me] : []) as Record<string, unknown>[]) {
      if (!q || typeof q !== 'object') continue;
      const ans = q.acceptedAnswer as Record<string, unknown> | Record<string, unknown>[] | undefined;
      const a = Array.isArray(ans) ? ans[0] : ans;
      const qt = str(q.name);
      const at = a ? str(a.text) : null;
      if (qt && at) items.push({ q: qt, a: htmlToText(at) });
    }
  }
  return { count: items.length, items };
}

/* ============================== 운영 데이터 대조 ============================== */

export function matchProduct(data: Dataset | null | undefined, names: (string | null | undefined)[]): Product | null {
  if (!data?.products?.length) return null;
  for (const n of names) {
    if (!n) continue;
    const nn = norm(n);
    if (nn.length < 2) continue;
    for (const p of data.products) {
      const pn = norm(p.name);
      if (pn.length >= 2 && (nn.includes(pn) || pn.includes(nn))) return p;
    }
  }
  return null;
}

/** 오퍼 ↔ 상품 옵션 (가장 긴 라벨 우선: '싱글' < '슈퍼싱글') */
export function optionOfOffer(p: Product, o: { name: string | null; sku: string | null }): Product['options'][number] | null {
  const key = norm(`${o.name ?? ''} ${o.sku ?? ''}`);
  const sku = o.sku ? norm(o.sku) : '';
  const cands = p.options.filter((op) => (norm(op.label) && key.includes(norm(op.label))) || (sku && sku === norm(op.id)));
  return cands.sort((a, b) => b.label.length - a.label.length)[0] ?? null;
}
function optionByKey(p: Product, key: string | null): Product['options'][number] | null {
  if (!key) return null;
  const k = norm(key);
  return p.options.find((o) => norm(o.id) === k || norm(o.label) === k) ?? null;
}

export function channelFromUrl(url: string | null | undefined): SalesChannelId | null {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('brand.naver.com') || u.includes('smartstore.naver.com')) return 'brandstore';
  if (u.includes('ohou.se')) return 'ohouse';
  if (u.includes('coupang.com')) return 'coupang';
  if (u.includes('mildo.kr')) return 'own_mall';
  return null;
}

/** 기준일(data.today)에 진행 중인 채널 프로모션 (할인율이 큰 것 우선) */
export function livePromotion(data: Dataset, channel: SalesChannelId | null): Promotion | null {
  if (!channel) return null;
  return data.promotions
    .filter((p) => p.channel === channel && p.status !== 'ended' && p.start <= data.today && data.today <= p.end)
    .sort((a, b) => b.discountRate - a.discountRate)[0] ?? null;
}
export function expectedSalePrice(listPrice: number, promo: Promotion | null): number {
  if (!Number.isFinite(listPrice)) return NaN;
  return promo ? Math.round(listPrice * (1 - promo.discountRate / 100)) : listPrice;
}

/* ============================== 표현 검수 (REVIEW_RULES) ============================== */

export type ReviewLevel = 'block' | 'warn' | 'check';
export interface ReviewHit { ruleId: string; level: ReviewLevel; match: string; reason: string; fix: string }

export function reviewText(text: string): ReviewHit[] {
  const out: ReviewHit[] = [];
  if (!text) return out;
  for (const r of REVIEW_RULES) {
    const seen = new Set<string>();
    for (const m of text.matchAll(new RegExp(r.pattern, 'gi'))) {
      const k = m[0];
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ruleId: r.id, level: r.level as ReviewLevel, match: k, reason: r.reason, fix: REVIEW_FIX[r.id] ?? '' });
    }
  }
  return out;
}
export function reviewLevelOf(hits: ReviewHit[]): ReviewLevel | 'ok' {
  if (hits.some((h) => h.level === 'block')) return 'block';
  if (hits.some((h) => h.level === 'warn')) return 'warn';
  if (hits.some((h) => h.level === 'check')) return 'check';
  return 'ok';
}
export const REVIEW_LEVEL_LABEL: Record<ReviewLevel | 'ok', string> = { block: '차단', warn: '경고', check: '확인', ok: '통과' };

/* ============================== 제품페이지 진단 ============================== */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na';
export type AuditAxis = 'SEO' | '구조화 데이터' | '운영 데이터 대조' | 'AEO' | '표현 검수';
export const AUDIT_AXES: AuditAxis[] = ['SEO', '구조화 데이터', '운영 데이터 대조', 'AEO', '표현 검수'];
export const STATUS_LABEL: Record<CheckStatus, string> = { pass: '통과', warn: '개선', fail: '실패', na: '해당 없음' };

export interface AuditCheck { id: string; axis: AuditAxis; label: string; status: CheckStatus; weight: number; measured: string; basis: string; fix: string }
export interface PageAudit {
  facts: PageFacts;
  product: ProductLd | null;
  faq: FaqLd;
  matched: { product: string | null; channel: SalesChannelId | null; promo: string | null; discountRate: number | null };
  displayedPrice: PriceFact | null;
  checks: AuditCheck[];
  review: ReviewHit[];
  score: number;
  grade: Verdict;
  counts: Record<CheckStatus, number>;
  axes: { axis: AuditAxis; score: number; checks: number; fails: number }[];
  topics: { id: AeoTopicId; label: string; found: boolean }[];
  empty: boolean;
}

const STATUS_SCORE: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0, na: 0 };
export function scoreChecks(checks: AuditCheck[]): number {
  const counted = checks.filter((c) => c.status !== 'na');
  const w = sum(counted, (c) => c.weight);
  return w > 0 ? Math.round((100 * sum(counted, (c) => c.weight * STATUS_SCORE[c.status])) / w) : 0;
}
export function gradeOf(score: number, empty = false): Verdict {
  const basis = `기준 ≥${AUDIT_RULES.scorePass} 충족 · ${AUDIT_RULES.scoreWarn}~${AUDIT_RULES.scorePass - 1} 개선 · <${AUDIT_RULES.scoreWarn} 우선 개선`;
  if (empty) return { id: 'empty', label: '입력 필요', tone: 'outline', basis: 'HTML을 붙여넣거나 샘플을 불러오세요' };
  if (score >= AUDIT_RULES.scorePass) return { id: 'pass', label: `기준 충족 · ${score}점`, tone: 'good', basis };
  if (score >= AUDIT_RULES.scoreWarn) return { id: 'warn', label: `개선 필요 · ${score}점`, tone: 'warning', basis };
  return { id: 'fail', label: `우선 개선 · ${score}점`, tone: 'critical', basis };
}

export function auditPage(facts: PageFacts, data?: Dataset | null): PageAudit {
  const checks: AuditCheck[] = [];
  const meta = (k: string) => facts.metas.find((m) => m.key === k)?.content?.trim() || null;
  const empty = !facts.title && !facts.text && !facts.metas.length && !facts.jsonLd.length && !facts.images.length && !facts.h1.length;
  const R = AUDIT_RULES;

  /* SEO — 제목 */
  const title = (facts.title ?? '').trim();
  const tl = charLen(title);
  const titleHasBrand = title.includes(BRAND);
  checks.push({
    id: 'title', axis: 'SEO', label: '제목(title)', weight: 2,
    status: !title ? 'fail' : tl < R.titleMin || tl > R.titleMax || !titleHasBrand ? 'warn' : 'pass',
    measured: title ? `${tl}자${titleHasBrand ? '' : ' · 브랜드명 없음'} · "${clip(title, 44)}"` : 'title 없음',
    basis: `${R.titleMin}~${R.titleMax}자 · 브랜드명 포함 (한글 기준 · 검색 결과 잘림 방지)`,
    fix: !title ? '제품명 · 핵심 속성 · 브랜드 순으로 title을 작성합니다.'
      : tl > R.titleMax ? `프로모션 · 옵션 나열을 메타 설명으로 옮기고 ${R.titleMax}자 이내로 줄입니다.`
        : tl < R.titleMin ? '제품명 뒤에 핵심 속성(사이즈 · 경도)을 붙입니다.'
          : !titleHasBrand ? `제목에 브랜드명(${BRAND})을 넣습니다.` : '현재 기준 충족.',
  });

  /* SEO — 메타 설명 */
  const desc = meta('description');
  const dl = desc ? charLen(desc) : 0;
  checks.push({
    id: 'description', axis: 'SEO', label: '메타 설명(meta description)', weight: 2,
    status: !desc ? 'fail' : dl < R.descMin || dl > R.descMax ? 'warn' : 'pass',
    measured: desc ? `${dl}자 · "${clip(desc, 40)}"` : '없음',
    basis: `${R.descMin}~${R.descMax}자 (한글 기준)`,
    fix: !desc ? '제품 특징(경도 · 소재 · 사이즈)과 구매 조건(배송 · 설치)을 한두 문장으로 씁니다.' : dl > R.descMax ? `${R.descMax}자 이내로 줄입니다.` : dl < R.descMin ? '선택 기준 정보를 한 문장 더합니다.' : '현재 기준 충족.',
  });

  /* SEO — OG */
  const ogKeys = ['og:title', 'og:description', 'og:image'];
  const ogMissing = ogKeys.filter((k) => !meta(k));
  checks.push({
    id: 'og', axis: 'SEO', label: 'OG 태그(og:title · og:description · og:image)', weight: 1,
    status: ogMissing.length === 0 ? 'pass' : ogMissing.length === ogKeys.length ? 'fail' : 'warn',
    measured: ogMissing.length ? `누락 ${ogMissing.join(', ')}` : '3종 모두 있음',
    basis: '3종 모두 (공유 · 메신저 미리보기 · AI 수집 메타)',
    fix: ogMissing.length ? `${ogMissing.join(', ')}을(를) 추가합니다${ogMissing.includes('og:image') ? ' (대표 이미지 1200×630 이상)' : ''}.` : '현재 기준 충족.',
  });

  /* SEO — canonical */
  const canon = facts.canonical;
  checks.push({
    id: 'canonical', axis: 'SEO', label: '대표 URL(canonical)', weight: 1,
    status: canon && /^https?:\/\//i.test(canon) ? 'pass' : canon ? 'warn' : 'fail',
    measured: canon ? clip(canon, 56) : '없음',
    basis: '절대 URL 1개 (옵션 · 파라미터 URL 중복 색인 방지)',
    fix: canon ? (/^https?:\/\//i.test(canon) ? '현재 기준 충족.' : '절대 URL(https://…)로 바꿉니다.') : '<link rel="canonical">을 추가합니다.',
  });

  /* SEO — h1 */
  const h1n = facts.h1.filter((h) => h.trim()).length;
  checks.push({
    id: 'h1', axis: 'SEO', label: '본문 제목(h1)', weight: 1,
    status: h1n === 1 ? 'pass' : h1n === 0 ? 'fail' : 'warn',
    measured: `${h1n}개${h1n ? ` · "${clip(facts.h1[0] ?? '', 24)}"${h1n > 1 ? ` 외 ${h1n - 1}개` : ''}` : ''}`,
    basis: '페이지당 1개',
    fix: h1n === 1 ? '현재 기준 충족.' : h1n === 0 ? '제품명을 h1으로 표시합니다.' : '제품명 1개만 h1로 두고 나머지는 h2로 내립니다.',
  });

  /* SEO — 이미지 ALT */
  const imgN = facts.images.length;
  const noAlt = facts.images.filter((i) => i.alt === null).length;
  const emptyAlt = facts.images.filter((i) => i.alt !== null && !i.alt.trim()).length;
  const altRate = safeDiv(noAlt + emptyAlt, imgN);
  checks.push({
    id: 'img_alt', axis: 'SEO', label: '이미지 ALT', weight: 2,
    status: imgN === 0 ? 'na' : altRate <= R.altPass ? 'pass' : altRate <= R.altWarn ? 'warn' : 'fail',
    measured: imgN ? `누락률 ${pctTxt(altRate)} · ${imgN}개 중 alt 없음 ${noAlt} · 빈 값 ${emptyAlt}` : '이미지 없음',
    basis: `누락률 ≤${pctTxt(R.altPass)} 통과 · ≤${pctTxt(R.altWarn)} 개선`,
    fix: noAlt + emptyAlt ? `ALT ${noAlt + emptyAlt}개에 제품 · 옵션 · 장면을 설명하는 문구를 넣습니다 (예: '수면밀도 매트리스 퀸 사이즈 단면').` : '현재 기준 충족.',
  });

  /* 구조화 데이터 — JSON-LD 구문 */
  const ldErr = facts.jsonLd.filter((b) => b.error);
  checks.push({
    id: 'jsonld_syntax', axis: '구조화 데이터', label: 'JSON-LD 구문', weight: 1,
    status: facts.jsonLd.length === 0 ? 'na' : ldErr.length ? 'fail' : 'pass',
    measured: facts.jsonLd.length ? `${facts.jsonLd.length}개 블록 · 오류 ${ldErr.length}${ldErr[0] ? ` (${clip(ldErr[0].error ?? '', 40)})` : ''}` : 'JSON-LD 없음',
    basis: '모든 블록 JSON 파싱 성공',
    fix: ldErr.length ? '따옴표 · 쉼표 오류를 수정합니다 (검색엔진은 구문 오류 블록 전체를 무시).' : facts.jsonLd.length ? '현재 기준 충족.' : 'Product · FAQPage 스키마를 추가합니다 (아래 항목).',
  });

  /* 구조화 데이터 — Product */
  const product = productFromLd(facts.jsonLd);
  const hasOfferPrice = !!product?.offers.some((o) => o.price !== null);
  const missing = product ? [!product.name && 'name', !product.brand && 'brand', !hasOfferPrice && 'offers.price'].filter(Boolean) as string[] : [];
  checks.push({
    id: 'product_schema', axis: '구조화 데이터', label: 'Product 스키마 (name · brand · offers.price)', weight: 3,
    status: !product ? 'fail' : missing.length === 0 ? 'pass' : missing.length === 1 ? 'warn' : 'fail',
    measured: !product ? 'Product 없음' : missing.length ? `누락 ${missing.join(', ')}` : `name · brand · offers ${product.offers.length}개`,
    basis: 'name · brand · offers.price 모두 존재',
    fix: !product ? '상품명 · 브랜드 · 옵션별 offers(price · priceCurrency · availability)를 담은 Product JSON-LD를 넣습니다.' : missing.length ? `${missing.join(', ')}을(를) 채웁니다.` : '현재 기준 충족.',
  });
  checks.push({
    id: 'rating', axis: '구조화 데이터', label: '리뷰 평점(aggregateRating)', weight: 1,
    status: !product ? 'na' : product.rating ? 'pass' : 'warn',
    measured: !product ? 'Product 없음' : product.rating ? `평점 ${product.rating.value} · 리뷰 ${fmt.int(product.rating.count)}건` : product.ratingRaw ? '값 불완전 (ratingValue · reviewCount 확인)' : '없음',
    basis: 'ratingValue · reviewCount 모두 존재 (리뷰 시스템 실제 값)',
    fix: product?.rating ? '현재 기준 충족 · 값은 리뷰 시스템과 매일 동기화.' : '리뷰 시스템 실제 값을 연동해 출력합니다. 임의 값 입력은 금지합니다.',
  });

  /* 구조화 데이터 — 화면 가격 ↔ offers.price */
  const dataProduct = matchProduct(data, [product?.name, facts.h1[0], facts.title, meta('og:title')]);
  const displayed = facts.prices.find((p) => p.kind === 'sale') ?? facts.prices.find((p) => p.kind === 'price') ?? null;
  const offers = product?.offers ?? [];
  const offerForDisplayed = (() => {
    if (!displayed || !offers.length) return null;
    if (displayed.option) {
      const key = displayed.option;
      const opt = dataProduct ? optionByKey(dataProduct, key) : null;
      const label = opt?.label ?? key;
      const hit = offers.find((o) => norm(`${o.name ?? ''} ${o.sku ?? ''}`).includes(norm(label)) || (o.sku && norm(o.sku) === norm(key)));
      if (hit) return hit;
    }
    return offers.find((o) => o.price !== null && Math.abs(o.price - displayed.value) <= R.priceTolerance) ?? offers.find((o) => o.price !== null) ?? null;
  })();
  const priceDiff = displayed && offerForDisplayed?.price != null ? metrics.pctChange(offerForDisplayed.price, displayed.value) : NaN;
  const displayedOption = displayed?.option ? ((dataProduct ? optionByKey(dataProduct, displayed.option)?.label : null) ?? displayed.option) : null;
  checks.push({
    id: 'price_match', axis: '구조화 데이터', label: '화면 가격 ↔ offers.price', weight: 3,
    status: !product || !hasOfferPrice ? 'fail' : !displayed ? 'warn' : offerForDisplayed?.price != null && Math.abs(offerForDisplayed.price - displayed.value) <= R.priceTolerance ? 'pass' : 'fail',
    measured: !displayed ? `화면 가격 요소 미검출${hasOfferPrice ? '' : ' · offers.price 없음'}`
      : `화면 ${fmt.won(displayed.value)}${displayedOption ? ` (${displayedOption})` : ''} · JSON-LD ${offerForDisplayed?.price != null ? fmt.won(offerForDisplayed.price) : '없음'}${Number.isFinite(priceDiff) && Math.abs(priceDiff) > 0.05 ? ` (화면 대비 ${fmt.delta(priceDiff)})` : ''}`,
    basis: `일치 (허용 오차 ${R.priceTolerance}원) · 불일치 시 검색 · AI 답변에 다른 가격 노출`,
    fix: !displayed ? '화면 판매가 요소에 class="sale-price" 또는 itemprop="price"를 지정합니다.'
      : offerForDisplayed?.price != null && Math.abs(offerForDisplayed.price - displayed.value) <= R.priceTolerance ? '현재 기준 충족.'
        : '프로모션 기간에는 offers.price를 화면 판매가로 바꾸고 priceValidUntil(프로모션 종료일)을 넣습니다.',
  });

  /* 운영 데이터 대조 — 판매가 · 재고 (state.data.products · promotions) */
  const channel = channelFromUrl(facts.canonical ?? meta('og:url'));
  const promo = data && dataProduct ? livePromotion(data, channel) : null;
  const matchedOffers = dataProduct ? offers.map((o) => ({ o, opt: optionOfOffer(dataProduct, o) })).filter((x) => x.opt) as { o: OfferLd; opt: Product['options'][number] }[] : [];
  const priceMis = matchedOffers.filter(({ o, opt }) => o.price === null || Math.abs(o.price - expectedSalePrice(opt.price, promo)) > R.priceTolerance);
  checks.push({
    id: 'data_price', axis: '운영 데이터 대조', label: '옵션별 offers.price ↔ 판매 데이터', weight: 2,
    status: !matchedOffers.length ? 'na' : priceMis.length ? 'fail' : 'pass',
    measured: !dataProduct ? '판매 데이터에 일치 상품 없음' : !matchedOffers.length ? '옵션과 연결된 offer 없음'
      : priceMis.length ? priceMis.map(({ o, opt }) => `${opt.label} ${o.price != null ? fmt.won(o.price) : '가격 없음'} → ${fmt.won(expectedSalePrice(opt.price, promo))}`).join(' · ')
        : `${matchedOffers.length}개 옵션 일치`,
    basis: promo ? `정가 × (1 − ${promo.discountRate}%) · ${promo.name} ${dateLabel(promo.start, false)}~${dateLabel(promo.end, false)} 진행 중` : '정가 기준 (진행 중 프로모션 없음)',
    fix: priceMis.length ? `옵션별 offers.price를 판매가로 갱신합니다${promo ? ` (프로모션 종료일 ${promo.end}을 priceValidUntil로)` : ''}.` : matchedOffers.length ? '현재 기준 충족.' : 'offers.name에 옵션명(슈퍼싱글 · 퀸 · 킹)을 넣으면 옵션별 대조가 가능합니다.',
  });
  const stockMis = matchedOffers.filter(({ o, opt }) => (o.availability === 'InStock' && !opt.inStock) || (o.availability === 'OutOfStock' && opt.inStock));
  const stockUnknown = matchedOffers.filter(({ o }) => o.availability === null);
  const soldInStock = stockMis.filter(({ opt }) => !opt.inStock);
  checks.push({
    id: 'availability', axis: '운영 데이터 대조', label: '옵션 재고 ↔ availability', weight: 2,
    status: !matchedOffers.length ? 'na' : soldInStock.length ? 'fail' : stockMis.length || stockUnknown.length ? 'warn' : 'pass',
    measured: !matchedOffers.length ? '옵션과 연결된 offer 없음'
      : stockMis.length ? stockMis.map(({ o, opt }) => `${opt.label} 판매 데이터 ${opt.inStock ? '재고 있음' : '품절'} · JSON-LD ${o.availability}`).join(' · ')
        : stockUnknown.length ? `availability 누락 ${stockUnknown.length}개` : `${matchedOffers.length}개 옵션 일치`,
    basis: '판매 데이터 재고 상태와 일치 (품절 옵션은 OutOfStock)',
    fix: soldInStock.length ? `${soldInStock.map((x) => x.opt.label).join(' · ')} 옵션을 OutOfStock으로 바꾸고, 해당 옵션 키워드의 랜딩을 점검합니다 (AI 답변 · 쇼핑 지면에 구매 가능으로 노출 방지).`
      : stockMis.length ? '재고가 있는 옵션을 InStock으로 바꿉니다.' : stockUnknown.length ? '옵션별 availability를 넣습니다.' : '현재 기준 충족.',
  });

  /* AEO — FAQPage */
  const faq = faqFromLd(facts.jsonLd);
  checks.push({
    id: 'faq_schema', axis: 'AEO', label: 'FAQPage 스키마', weight: 2,
    status: faq.count >= R.faqMin ? 'pass' : faq.count > 0 ? 'warn' : 'fail',
    measured: faq.count ? `질문 ${faq.count}개` : '없음',
    basis: `질문 ${R.faqMin}개 이상 (경도 · 소재 · 사이즈 · 선택 기준)`,
    fix: faq.count >= R.faqMin ? '현재 기준 충족.' : 'AEO FAQ 생성기에서 검수 통과 문항으로 FAQPage JSON-LD를 만들어 넣습니다.',
  });

  /* AEO — 주제 커버리지 */
  const topicText = `${facts.text} ${faq.items.map((i) => `${i.q} ${i.a}`).join(' ')}`;
  const topics = AEO_TOPICS.filter((t) => t.core).map((t) => ({ id: t.id, label: t.label, found: new RegExp(t.pattern).test(topicText) }));
  const foundN = topics.filter((t) => t.found).length;
  checks.push({
    id: 'topics', axis: 'AEO', label: 'AEO 주제 커버리지', weight: 2,
    status: foundN === topics.length ? 'pass' : foundN >= 2 ? 'warn' : 'fail',
    measured: `${foundN}/${topics.length}${foundN < topics.length ? ` · 누락 ${topics.filter((t) => !t.found).map((t) => t.label).join(', ')}` : ''}`,
    basis: '경도 · 소재 · 사이즈 · 선택 기준 4개 주제 (p.29)',
    fix: foundN === topics.length ? '현재 기준 충족.' : `${topics.filter((t) => !t.found).map((t) => t.label).join(' · ')} 설명 섹션 또는 FAQ를 추가합니다.`,
  });

  /* 표현 검수 — REVIEW_RULES */
  const reviewSrc = [facts.text, desc ?? '', meta('og:description') ?? '', faq.items.map((i) => i.a).join(' ')].join(' ');
  const review = reviewText(reviewSrc);
  const lvl = reviewLevelOf(review);
  checks.push({
    id: 'copy_review', axis: '표현 검수', label: '문구 검수 (의료 효능 · 최상급 · 절대 표현 · 경쟁사)', weight: 3,
    status: !reviewSrc.trim() ? 'na' : lvl === 'block' ? 'fail' : lvl === 'warn' ? 'warn' : 'pass',
    measured: review.length ? review.filter((h) => h.level !== 'check').map((h) => `${REVIEW_LEVEL_LABEL[h.level]} '${h.match}'`).join(' · ') || `가격 표기 ${review.length}건 (대조 대상)` : '검출 없음',
    basis: 'REVIEW_RULES 6종 (p.27 · p.35 의료 효능 암시 표현 제외)',
    fix: lvl === 'block' || lvl === 'warn' ? review.filter((h) => h.level !== 'check').map((h) => h.fix).filter((v, i, a) => a.indexOf(v) === i).join(' ') : '현재 기준 충족.',
  });

  const score = empty ? 0 : scoreChecks(checks);
  const counts = { pass: 0, warn: 0, fail: 0, na: 0 } as Record<CheckStatus, number>;
  for (const c of checks) counts[c.status]++;
  return {
    facts, product, faq,
    matched: { product: dataProduct?.name ?? null, channel, promo: promo?.name ?? null, discountRate: promo?.discountRate ?? null },
    displayedPrice: displayed,
    checks, review, score,
    grade: gradeOf(score, empty),
    counts,
    axes: AUDIT_AXES.map((axis) => {
      const cs = checks.filter((c) => c.axis === axis);
      return { axis, score: scoreChecks(cs), checks: cs.filter((c) => c.status !== 'na').length, fails: cs.filter((c) => c.status === 'fail').length };
    }),
    topics,
    empty,
  };
}

export function auditHtml(html: string, data?: Dataset | null): PageAudit {
  return auditPage(extractPageFacts(html), data);
}

export function auditMarkdown(a: PageAudit, label = '제품페이지'): string {
  const lines = [
    `# SearchTuneOS 제품페이지 진단 · ${label}`,
    '',
    `점수 ${a.score}점 · ${a.grade.label.split(' · ')[0]} (${a.grade.basis})`,
    `통과 ${a.counts.pass} · 개선 ${a.counts.warn} · 실패 ${a.counts.fail} · 해당 없음 ${a.counts.na} · 파서 ${a.facts.parser === 'dom' ? 'DOMParser' : '정규식'}`,
    a.matched.product ? `운영 데이터 대조: ${a.matched.product}${a.matched.promo ? ` · ${a.matched.promo} ${a.matched.discountRate}% 진행 중` : ''} (TEST DATA)` : '운영 데이터 대조: 일치 상품 없음',
    '',
    '| 축 | 항목 | 판정 | 측정값 | 기준 | 개선안 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...a.checks.map((c) => `| ${c.axis} | ${c.label} | ${STATUS_LABEL[c.status]} | ${c.measured.replace(/\|/g, '/')} | ${c.basis.replace(/\|/g, '/')} | ${c.fix.replace(/\|/g, '/')} |`),
    '',
    '노출 순위 보장이 아닌 정기 진단 · 개선 방식으로 운영합니다. (제안서 p.29)',
  ];
  return lines.join('\n');
}

/* ============================== 샘플 HTML (운영 데이터로 생성) ============================== */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 제품페이지 샘플 — state.data.products[0] · 브랜드스토어 진행 프로모션으로 만든다.
 *  defect: 메타 설명 · og:image 누락, h1 2개, ALT 누락, JSON-LD 정가 기재(판매가 불일치), 품절 옵션 InStock, FAQPage 없음, 의료 효능 문구
 *  fixed : 위 결함을 고친 개선안 (aggregateRating은 리뷰 시스템 실제 값 연동 전이라 비워 둠)
 */
export function sampleProductHtml(data: Dataset, variant: 'defect' | 'fixed' = 'defect'): string {
  const p: Product = data.products[0] ?? { id: 'p_main', name: '수면밀도 매트리스', landing: 'https://brand.naver.com/mildo/products', options: [{ id: 'q', label: '퀸', price: 990_000, inStock: true }] };
  const promo = livePromotion(data, 'brandstore');
  const main = p.options.find((o) => o.id === 'q') ?? p.options[0];
  const sale = (price: number) => (variant === 'fixed' ? expectedSalePrice(price, promo) : price);
  const url = `https://brand.naver.com/mildo/products/${p.id}`;
  const offers = p.options.map((o) => ({
    '@type': 'Offer', name: o.label, sku: `${p.id}-${o.id}`, price: String(sale(o.price)), priceCurrency: 'KRW',
    availability: variant === 'fixed' ? (o.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock') : 'https://schema.org/InStock',
    ...(variant === 'fixed' && promo ? { priceValidUntil: promo.end } : {}),
    url: `${url}?option=${o.id}`,
  }));
  const productLd = { '@context': 'https://schema.org', '@type': 'Product', name: p.name, brand: { '@type': 'Brand', name: BRAND }, image: [`https://brand.naver.com/mildo/img/${p.id}-main.jpg`], offers };
  const optionsText = p.options.map((o) => o.label).join(' · ');
  const saleMain = main ? expectedSalePrice(main.price, promo) : NaN;
  const priceBox = main ? `<div class="price-box"><span class="option-name">${esc(main.label)}</span>${promo ? `<del class="list-price">${fmt.won(main.price)}</del>` : ''}<strong class="sale-price" data-option="${esc(main.id)}">${fmt.won(saleMain)}</strong>${promo ? `<span class="discount-rate">${promo.discountRate}%</span>` : ''}</div>` : '';
  const soldOut = p.options.filter((o) => !o.inStock).map((o) => o.label);

  if (variant === 'defect') {
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${esc(p.name)} ${esc(optionsText)} | ${promo ? `${esc(promo.name)} ${promo.discountRate}% 할인 | ` : ''}수면밀도 공식 브랜드스토어</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${esc(p.name)}">
<meta property="og:description" content="수면밀도 공식 브랜드스토어">
<link rel="canonical" href="${url}">
<script type="application/ld+json">
${JSON.stringify(productLd, null, 2)}
</script>
</head>
<body>
<h1>${esc(p.name)}</h1>
<h1>${promo ? esc(promo.name) : '기획전'}</h1>
${priceBox}
<img src="/img/main.jpg" alt="${esc(p.name)} ${main ? esc(main.label) : ''} 정면">
<img src="/img/detail-1.jpg" alt="">
<img src="/img/detail-2.jpg">
<img src="/img/layer.jpg" alt="매트리스 단면">
<img src="/img/size.jpg">
<img src="/img/review.jpg" alt="고객 리뷰">
<p>허리 통증 완화에 도움을 주는 매트리스. 네이버 가구 부문 판매 1위.</p>
<h2>경도 안내</h2>
<p>단단한 경도로 몸이 덜 가라앉습니다.</p>
<h2>사이즈</h2>
<p>${esc(optionsText)} 3가지 사이즈로 판매합니다.</p>
</body>
</html>`;
  }

  const faqLd = faqJsonLd(reviewFaq(buildFaqDraft(data)), true).json;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${esc(p.name)} | 수면밀도 공식 브랜드스토어</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="경도 · 소재 구조 · 사이즈(${esc(optionsText)})를 비교해 고르는 수면밀도 매트리스. 사이즈별 판매가와 배송 · 설치 안내를 확인하세요.">
<meta property="og:title" content="${esc(p.name)} | 수면밀도">
<meta property="og:description" content="경도 · 소재 구조 · 사이즈를 비교해 고르는 수면밀도 매트리스">
<meta property="og:image" content="https://brand.naver.com/mildo/img/${p.id}-og.jpg">
<meta property="og:url" content="${url}">
<link rel="canonical" href="${url}">
<!-- aggregateRating: 리뷰 시스템 실제 값 연동 후 출력 (임의 값 입력 금지) -->
<script type="application/ld+json">
${JSON.stringify(productLd, null, 2)}
</script>
<script type="application/ld+json">
${faqLd}
</script>
</head>
<body>
<h1>${esc(p.name)}</h1>
${priceBox}
${soldOut.length ? `<p class="stock-note">${esc(soldOut.join(' · '))} 옵션 일시 품절</p>` : ''}
<img src="/img/main.jpg" alt="${esc(p.name)} ${main ? esc(main.label) : ''} 정면">
<img src="/img/detail-1.jpg" alt="매트리스 상단 커버 원단 확대">
<img src="/img/detail-2.jpg" alt="매트리스 측면 마감">
<img src="/img/layer.jpg" alt="매트리스 내부 레이어 구조 단면">
<img src="/img/size.jpg" alt="${esc(optionsText)} 사이즈 비교">
<img src="/img/review.jpg" alt="고객 리뷰 사진 모음">
<h2>경도 안내</h2>
<p>체중과 수면 자세에 따라 체감 경도가 다릅니다.</p>
<h2>소재 · 구조</h2>
<p>상단 폼과 스프링 레이어로 구성됩니다.</p>
<h2>사이즈</h2>
<p>${esc(optionsText)} 3가지 사이즈로 판매합니다.</p>
<h2>고르는 기준</h2>
<p>경도 · 사이즈 · 소재 구조 순서로 비교하세요.</p>
</body>
</html>`;
}

/* ============================== GEO 진단 스냅샷 (DEMO) ============================== */

export interface Citation { domain: string; owned: boolean }
export interface GeoCell {
  queryId: string;
  engine: GeoEngineId;
  mentioned: boolean;
  /** 답변 속 브랜드 언급 순서 (1 = 가장 먼저) */
  position: number | null;
  /** 답변에 등장한 브랜드 순서 (수면밀도 포함) */
  order: string[];
  competitors: string[];
  citations: Citation[];
}
export interface GeoRound { index: number; date: string; cells: GeoCell[] }
export interface GeoSnapshot { kind: 'DEMO'; rounds: GeoRound[]; queries: GeoQuery[]; engines: GeoEngineDef[] }

export function isOwnedDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return OWNED_DOMAINS.some((o) => d === o || d.startsWith(`${o}/`) || (o.indexOf('/') < 0 && d.endsWith(`.${o}`)));
}

/** 정기 진단 회차 (기준일 이전 가장 가까운 월요일부터 주 단위로 n회) */
export function geoRoundDates(today: string, n = GEO_ROUNDS): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '') || n <= 0) return [];
  let d = today;
  for (let i = 0; i < 7 && weekday(d) !== GEO_ROUND_WEEKDAY; i++) d = addDays(d, -1);
  return Array.from({ length: n }, (_, i) => addDays(d, -7 * (n - 1 - i)));
}

function weightedPick<T extends { weight: number }>(items: T[], n: number, R: ReturnType<typeof rng>): T[] {
  const pool = items.filter((x) => x.weight > 0).slice();
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const total = sum(pool, (x) => x.weight);
    let t = R.next() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) { t -= pool[idx].weight; if (t <= 0) break; }
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

/** 데모 셀 — 셀 고유 성향(회차 무관) + 회차 노이즈. 실제 엔진 응답이 아니다. */
function demoCell(q: GeoQuery, e: GeoEngineDef, date: string): GeoCell {
  const base = rng(hashString(`geo-base|${q.id}|${e.id}`));
  const R = rng(hashString(`geo|${date}|${q.id}|${e.id}`));
  const affinity = 0.3 + base.next() * 1.4;
  const p = clamp(e.mentionBase * INTENT_MENTION_MULT[q.intent] * q.qMult * affinity, 0.02, 0.97);
  const mentioned = R.next() < p;
  const cm = INTENT_COMPETITOR_MULT[q.intent];
  const comps = Object.entries(e.competitorWeights)
    .map(([name, w]) => ({ name, w: clamp(w * cm * (0.7 + base.next() * 0.6), 0, 0.95), roll: R.next() }))
    .filter((c) => c.roll < c.w)
    .sort((a, b) => b.w - a.w)
    .map((c) => c.name);
  let order = comps.slice();
  let position: number | null = null;
  if (mentioned) {
    const aheadP = q.intent === 'brand' ? 0.08 : e.aheadProb;
    const ahead = comps.filter(() => R.next() < aheadP).length;
    position = ahead + 1;
    order = [...comps.slice(0, ahead), BRAND, ...comps.slice(ahead)];
  }
  const nCite = R.int(e.citeMin, e.citeMax);
  const pool = e.citePool.map((c) => ({
    ...c,
    weight: isOwnedDomain(c.domain) ? c.weight * (mentioned ? 1.6 : 0.25) * (q.intent === 'brand' ? 1.8 : 1) : c.weight,
  }));
  const citations = weightedPick(pool, nCite, R).map((c) => ({ domain: c.domain, owned: isOwnedDomain(c.domain) }));
  return { queryId: q.id, engine: e.id, mentioned, position, order, competitors: comps, citations };
}

export function buildGeoSnapshot(today: string, queries: GeoQuery[] = GEO_QUERIES, engines: GeoEngineDef[] = GEO_ENGINES): GeoSnapshot {
  const dates = geoRoundDates(today);
  return {
    kind: 'DEMO',
    queries, engines,
    rounds: dates.map((date, index) => ({ index, date, cells: queries.flatMap((q) => engines.map((e) => demoCell(q, e, date))) })),
  };
}

/* ============================== 가시성 집계 ============================== */

export interface EngineStat {
  id: GeoEngineId; name: string; short: string; colorVar: string;
  total: number; mentioned: number; rate: number; prevRate: number | null; deltaPp: number | null;
  avgPosition: number; firstCount: number; citations: number; ownedCitations: number; competitorMentions: number; sov: number;
  verdict: Verdict;
}
export interface QueryStat {
  query: GeoQuery;
  cells: Partial<Record<GeoEngineId, GeoCell>>;
  mentionedEngines: number;
  prevMentionedEngines: number | null;
  competitorEngines: number;
  topCompetitor: string | null;
  bestPosition: number | null;
  citations: number;
  ownedCitations: number;
  /** 최근 회차들에서 엔진별 언급 횟수 */
  roundsMentioned: Partial<Record<GeoEngineId, number>>;
  status: Verdict;
  gap: boolean;
  gapBasis: string;
}
export interface Visibility {
  hasData: boolean;
  date: string | null;
  prevDate: string | null;
  roundIndex: number;
  rounds: string[];
  engines: EngineStat[];
  queries: QueryStat[];
  overall: {
    total: number; mentioned: number; rate: number; prevRate: number | null; deltaPp: number | null;
    avgPosition: number; firstRate: number; citations: number; ownedCitations: number; ownedShare: number; prevOwnedCitations: number | null;
    sov: number; prevSov: number | null; brandMentions: number; competitorMentions: number;
    covered: number; partial: number; none: number;
  };
  competitors: { name: string; mentions: number; rate: number; engines: number; aheadOfBrand: number }[];
  byIntent: { intent: IntentId; label: string; total: number; mentioned: number; rate: number }[];
  gaps: QueryStat[];
  trend: { date: string; overall: number; byEngine: Record<string, number> }[];
  stability: { stable: number; volatile: number; never: number; cells: number; rounds: number };
  citeSources: { domain: string; label: string; count: number; owned: boolean }[];
}

function roundStats(cells: GeoCell[]) {
  const brandMentions = cells.filter((c) => c.mentioned).length;
  const competitorMentions = sum(cells, (c) => c.competitors.length);
  return {
    total: cells.length,
    mentioned: brandMentions,
    rate: safeDiv(brandMentions, cells.length),
    owned: sum(cells, (c) => c.citations.filter((x) => x.owned).length),
    sov: safeDiv(brandMentions, brandMentions + competitorMentions),
    competitorMentions,
  };
}

export function queryVerdict(mentionedEngines: number, engines: number): Verdict {
  const need = Math.min(GEO_RULES.coveredEngines, Math.max(1, engines));
  if (engines === 0) return { id: 'na', label: '데이터 없음', tone: 'outline', basis: '진단 스냅샷 없음' };
  if (mentionedEngines >= need) return { id: 'covered', label: '확보', tone: 'good', basis: `${mentionedEngines}/${engines} 엔진 언급 (기준 ≥${need})` };
  if (mentionedEngines > 0) return { id: 'partial', label: '부분', tone: 'warning', basis: `${mentionedEngines}/${engines} 엔진 (확보 기준 ≥${need})` };
  return { id: 'none', label: '미노출', tone: 'serious', basis: `0/${engines} 엔진 (확보 기준 ≥${need})` };
}
export function engineVerdict(rate: number, total: number): Verdict {
  if (total === 0) return { id: 'na', label: '데이터 없음', tone: 'outline', basis: '—' };
  const basis = `언급률 ${pctTxt(rate)} (≥${pctTxt(GEO_RULES.engineRateGood)} 확보 · <${pctTxt(GEO_RULES.engineRateLow)} 취약)`;
  if (rate >= GEO_RULES.engineRateGood) return { id: 'good', label: '확보', tone: 'good', basis };
  if (rate < GEO_RULES.engineRateLow) return { id: 'low', label: '취약', tone: 'serious', basis };
  return { id: 'mid', label: '부분', tone: 'warning', basis };
}

export function visibilitySummary(snap: GeoSnapshot, roundIndex?: number): Visibility {
  const rounds = snap.rounds;
  const ri = rounds.length ? clamp(roundIndex ?? rounds.length - 1, 0, rounds.length - 1) : -1;
  const cur = ri >= 0 ? rounds[ri] : null;
  const prev = ri > 0 ? rounds[ri - 1] : null;
  const cells = cur?.cells ?? [];
  const engines = snap.engines;
  const nE = engines.length;
  const window = ri >= 0 ? rounds.slice(Math.max(0, ri - GEO_ROUNDS + 1), ri + 1) : [];

  const engineStats: EngineStat[] = engines.map((e) => {
    const ec = cells.filter((c) => c.engine === e.id);
    const pc = prev?.cells.filter((c) => c.engine === e.id) ?? [];
    const s = roundStats(ec);
    const ps = prev ? roundStats(pc) : null;
    const pos = ec.filter((c) => c.position !== null).map((c) => c.position as number);
    return {
      id: e.id, name: e.name, short: e.short, colorVar: e.colorVar,
      total: s.total, mentioned: s.mentioned, rate: s.rate,
      prevRate: ps ? ps.rate : null, deltaPp: ps ? (s.rate - ps.rate) * 100 : null,
      avgPosition: pos.length ? sum(pos, (x) => x) / pos.length : NaN,
      firstCount: pos.filter((x) => x === 1).length,
      citations: sum(ec, (c) => c.citations.length),
      ownedCitations: s.owned,
      competitorMentions: s.competitorMentions,
      sov: s.sov,
      verdict: engineVerdict(s.rate, s.total),
    };
  });

  const queries: QueryStat[] = snap.queries.map((q) => {
    const qc = cells.filter((c) => c.queryId === q.id);
    const byE: Partial<Record<GeoEngineId, GeoCell>> = {};
    for (const c of qc) byE[c.engine] = c;
    const mentionedEngines = qc.filter((c) => c.mentioned).length;
    const competitorEngines = qc.filter((c) => c.competitors.length > 0).length;
    const counts: Record<string, number> = {};
    for (const c of qc) for (const n of c.competitors) counts[n] = (counts[n] ?? 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const roundsMentioned: Partial<Record<GeoEngineId, number>> = {};
    for (const e of engines) roundsMentioned[e.id] = window.filter((r) => r.cells.some((c) => c.queryId === q.id && c.engine === e.id && c.mentioned)).length;
    const gap = qc.length > 0 && competitorEngines >= GEO_RULES.gapCompetitorEngines && mentionedEngines <= GEO_RULES.gapBrandMax;
    const pos = qc.filter((c) => c.position !== null).map((c) => c.position as number);
    return {
      query: q, cells: byE, mentionedEngines,
      prevMentionedEngines: prev ? prev.cells.filter((c) => c.queryId === q.id && c.mentioned).length : null,
      competitorEngines,
      topCompetitor: top ? top[0] : null,
      bestPosition: pos.length ? Math.min(...pos) : null,
      citations: sum(qc, (c) => c.citations.length),
      ownedCitations: sum(qc, (c) => c.citations.filter((x) => x.owned).length),
      roundsMentioned,
      status: queryVerdict(mentionedEngines, qc.length),
      gap,
      gapBasis: `경쟁사 ${competitorEngines}/${qc.length} · ${BRAND} ${mentionedEngines}/${qc.length} 엔진 (기준 경쟁사 ≥${GEO_RULES.gapCompetitorEngines} · 자사 ≤${GEO_RULES.gapBrandMax})`,
    };
  });

  const s = roundStats(cells);
  const ps = prev ? roundStats(prev.cells) : null;
  const allPos = cells.filter((c) => c.position !== null).map((c) => c.position as number);
  const citeTotal = sum(cells, (c) => c.citations.length);

  const compNames = Object.keys(COMPETITOR_ALIASES);
  const competitors = compNames.map((name) => {
    const withC = cells.filter((c) => c.competitors.includes(name));
    return {
      name,
      mentions: withC.length,
      rate: safeDiv(withC.length, cells.length),
      engines: new Set(withC.map((c) => c.engine)).size,
      aheadOfBrand: cells.filter((c) => c.mentioned && c.order.indexOf(name) >= 0 && c.order.indexOf(name) < c.order.indexOf(BRAND)).length,
    };
  }).sort((a, b) => b.mentions - a.mentions);

  const intents: IntentId[] = ['brand', 'generic', 'problem', 'compare', 'life'];
  const intentOf: Record<string, IntentId> = {};
  for (const q of snap.queries) intentOf[q.id] = q.intent;
  const byIntent = intents.map((intent) => {
    const ic = cells.filter((c) => (intentOf[c.queryId] ?? QUERY_BY_ID[c.queryId]?.intent) === intent);
    return { intent, label: INTENT_LABEL[intent], total: ic.length, mentioned: ic.filter((c) => c.mentioned).length, rate: safeDiv(ic.filter((c) => c.mentioned).length, ic.length) };
  });

  // 반복 관측: 최근 회차 창에서 같은 셀이 몇 번 언급됐는지
  let stable = 0, volatile = 0, never = 0;
  for (const q of snap.queries) for (const e of engines) {
    const n = window.filter((r) => r.cells.some((c) => c.queryId === q.id && c.engine === e.id && c.mentioned)).length;
    if (!window.length) continue;
    if (n >= Math.min(GEO_RULES.stableRounds, window.length)) stable++;
    else if (n === 0) never++;
    else volatile++;
  }

  const srcCount: Record<string, number> = {};
  for (const c of cells) for (const x of c.citations) srcCount[x.domain] = (srcCount[x.domain] ?? 0) + 1;

  const covered = queries.filter((q) => q.status.id === 'covered').length;
  const partial = queries.filter((q) => q.status.id === 'partial').length;
  const none = queries.filter((q) => q.status.id === 'none').length;

  return {
    hasData: cells.length > 0,
    date: cur?.date ?? null,
    prevDate: prev?.date ?? null,
    roundIndex: ri,
    rounds: rounds.map((r) => r.date),
    engines: engineStats,
    queries,
    overall: {
      total: s.total, mentioned: s.mentioned, rate: s.rate,
      prevRate: ps ? ps.rate : null, deltaPp: ps ? (s.rate - ps.rate) * 100 : null,
      avgPosition: allPos.length ? sum(allPos, (x) => x) / allPos.length : NaN,
      firstRate: safeDiv(allPos.filter((x) => x === 1).length, allPos.length),
      citations: citeTotal, ownedCitations: s.owned, ownedShare: safeDiv(s.owned, citeTotal), prevOwnedCitations: ps ? ps.owned : null,
      sov: s.sov, prevSov: ps ? ps.sov : null, brandMentions: s.mentioned, competitorMentions: s.competitorMentions,
      covered, partial, none,
    },
    competitors,
    byIntent,
    gaps: queries.filter((q) => q.gap),
    trend: rounds.slice(0, ri + 1).map((r) => {
      const byEngine: Record<string, number> = {};
      for (const e of engines) byEngine[e.id] = roundStats(r.cells.filter((c) => c.engine === e.id)).rate;
      return { date: r.date, overall: roundStats(r.cells).rate, byEngine };
    }),
    stability: { stable, volatile, never, cells: stable + volatile + never, rounds: window.length },
    citeSources: Object.entries(srcCount).map(([domain, count]) => ({ domain, label: CITE_LABEL[domain] ?? domain, count, owned: isOwnedDomain(domain) })).sort((a, b) => b.count - a.count),
  };
}

/* ============================== 라이브 진단 (Claude 답변 파싱) ============================== */

export interface LiveParse {
  mentioned: boolean;
  brandHits: number;
  /** 단독 '밀도' — 소재 밀도와 구분되지 않아 언급으로 세지 않는 표현 수 */
  ambiguous: number;
  position: number | null;
  order: string[];
  competitors: string[];
  others: string[];
  citations: Citation[];
  excerpt: string;
  chars: number;
}
export interface LiveRecord extends LiveParse { queryId: string; query: string; at: string; backend: string }

function domainOf(url: string): string {
  const u = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[).,;:!?'"\]]+$/, '');
  const low = u.toLowerCase();
  for (const o of OWNED_DOMAINS) if (low === o || low.startsWith(`${o}/`) || low.startsWith(`${o}?`)) return o;
  return low.split(/[/?#]/)[0];
}

/** URL · 도메인 표기 (본문 언급이 아니라 인용) — 같은 길이의 공백으로 가려 위치(순서 · 발췌)는 그대로 둔다 */
const URL_TOKEN = /(?:https?:\/\/|www\.)[^\s)\]>"'<]+|[a-z0-9][a-z0-9.-]*\.(?:co\.kr|kr|com|net|se|io|wiki)(?:\/[^\s)\]>"'<]*)?/gi;
export function maskUrls(text: string): string {
  return String(text ?? '').replace(URL_TOKEN, (m) => ' '.repeat(m.length));
}

export function parseAiAnswer(text: string): LiveParse {
  const t = String(text ?? '');
  // 브랜드 · 경쟁사 언급은 본문에서만 센다 (mildo.kr · zinus.com 같은 URL은 인용으로만 집계)
  const body = maskUrls(t);
  const strong = [...body.matchAll(new RegExp(BRAND_STRONG_PATTERN, 'gi'))].map((m) => ({ i: m.index ?? 0, len: m[0].length }));
  const ctx = [...body.matchAll(new RegExp(DENSITY_CONTEXT_PATTERN, 'gi'))].map((m) => ({ i: m.index ?? 0, len: m[0].length }));
  const inside = (spans: { i: number; len: number }[], i: number) => spans.some((s) => i >= s.i && i < s.i + s.len);
  let ambiguous = 0;
  for (const m of body.matchAll(/밀도/g)) {
    const i = m.index ?? 0;
    if (!inside(strong, i) && !inside(ctx, i)) ambiguous++;
  }
  const firsts: { name: string; i: number; kind: 'brand' | 'competitor' | 'other' }[] = [];
  if (strong.length) firsts.push({ name: BRAND, i: strong[0].i, kind: 'brand' });
  for (const [name, aliases] of Object.entries(COMPETITOR_ALIASES)) {
    const m = body.match(new RegExp(aliases.join('|'), 'i'));
    if (m && m.index !== undefined) firsts.push({ name, i: m.index, kind: 'competitor' });
  }
  for (const name of OTHER_BRANDS) {
    const i = body.indexOf(name);
    if (i >= 0) firsts.push({ name, i, kind: 'other' });
  }
  firsts.sort((a, b) => a.i - b.i);
  const order = firsts.map((f) => f.name);
  const citeSet = new Map<string, Citation>();
  for (const m of t.matchAll(/https?:\/\/[^\s)\]>"'<]+/gi)) {
    const d = domainOf(m[0]);
    if (d && !citeSet.has(d)) citeSet.set(d, { domain: d, owned: isOwnedDomain(d) });
  }
  for (const m of t.matchAll(/(?:^|[\s(])((?:www\.)?(?:mildo\.kr|brand\.naver\.com\/mildo))/gi)) {
    const d = domainOf(m[1]);
    if (!citeSet.has(d)) citeSet.set(d, { domain: d, owned: true });
  }
  const at = strong[0]?.i ?? -1;
  const excerpt = collapse(at >= 0 ? `${at > 60 ? '…' : ''}${t.slice(Math.max(0, at - 60), at + 120)}${at + 120 < t.length ? '…' : ''}` : clip(t, 160));
  return {
    mentioned: strong.length > 0,
    brandHits: strong.length,
    ambiguous,
    position: strong.length ? order.indexOf(BRAND) + 1 : null,
    order,
    competitors: firsts.filter((f) => f.kind === 'competitor').map((f) => f.name),
    others: firsts.filter((f) => f.kind === 'other').map((f) => f.name),
    citations: [...citeSet.values()],
    excerpt,
    chars: t.length,
  };
}

/** Claude를 쓸 수 없게 된 응답 코드 — 버튼을 끄고 다시 요청하지 않는다 (no_backend: 거부 직후 백엔드가 규칙 엔진으로 바뀐 경우 · 서버 모드: ai_not_configured 키 없음 · ai_disabled AI 꺼짐 · forbidden 권한 없음 · workspace_locked 워크스페이스 잠김 — src/ai/claude.ts가 서버 백엔드를 끄는 코드와 같다) */
export const DENIED_CODES: ReadonlySet<string> = new Set(['not_granted', 'sampling_disabled', 'no_backend', 'ai_not_configured', 'ai_disabled', 'forbidden', 'workspace_locked']);

export function liveVerdict(r: LiveParse | null | undefined): Verdict {
  if (!r) return { id: 'none', label: '미진단', tone: 'outline', basis: 'Claude 연결 시 버튼으로 진단' };
  if (r.mentioned) return { id: 'mentioned', label: `언급 · ${r.position}번째`, tone: r.position === 1 ? 'good' : 'neutral', basis: `브랜드 ${r.order.length}개 중 ${r.position}번째 · 경쟁사 ${r.competitors.length}개` };
  if (r.ambiguous > 0) return { id: 'ambiguous', label: '확인 필요', tone: 'warning', basis: `단독 '밀도' ${r.ambiguous}회 — 소재 밀도와 구분 불가` };
  const owned = r.citations.filter((c) => c.owned).length;
  if (owned > 0) return { id: 'cited', label: '자사 인용만', tone: 'warning', basis: `본문 브랜드 미언급 · 자사 URL 인용 ${owned}건 · 경쟁사 ${r.competitors.length}개 언급` };
  return { id: 'absent', label: '미언급', tone: 'serious', basis: `경쟁사 ${r.competitors.length}개 언급` };
}

/** 라이브 결과 요약 (Claude 열) */
export function liveSummary(records: LiveRecord[]) {
  const n = records.length;
  const m = records.filter((r) => r.mentioned).length;
  const pos = records.filter((r) => r.position !== null).map((r) => r.position as number);
  return { count: n, mentioned: m, rate: safeDiv(m, n), avgPosition: pos.length ? sum(pos, (x) => x) / pos.length : NaN, competitorMentions: sum(records, (r) => r.competitors.length) };
}

/* ============================== 정기 진단 내보내기 ============================== */

const cellText = (c?: GeoCell) => (!c ? '—' : c.mentioned ? `${c.position}번째` : '미언급');
const liveText = (r?: LiveRecord) => (!r ? '미진단' : r.mentioned ? `${r.position}번째` : r.ambiguous ? '확인 필요' : r.citations.some((c) => c.owned) ? '자사 인용만' : '미언급');

/** 매트릭스 행 (CSV 등 표 내보내기용 plain record) */
export function visibilityRows(vis: Visibility, latest: Record<string, LiveRecord> = {}): Record<string, string | number>[] {
  return vis.queries.map((q) => {
    const row: Record<string, string | number> = { 진단일: vis.date ?? '', 질의: q.query.text, 구매의도: INTENT_LABEL[q.query.intent], 판정: q.status.label, 언급엔진: q.mentionedEngines, 엔진수: Object.keys(q.cells).length };
    for (const e of vis.engines) row[e.short] = cellText(q.cells[e.id]);
    row['Claude(LIVE)'] = liveText(latest[q.query.id]);
    row.최다경쟁사 = q.topCompetitor ?? '';
    row.경쟁사언급엔진 = q.competitorEngines;
    row.자사인용 = q.ownedCitations;
    row.경쟁사우위 = q.gap ? 'Y' : '';
    row.출처 = 'TEST DATA 스냅샷 (Claude 열만 LIVE)';
    return row;
  });
}

/** 정기 진단 결과 마크다운 (주간 리포트 첨부용) — 데모 스냅샷 + Claude 라이브 기록 */
export function visibilityMarkdown(vis: Visibility, latest: Record<string, LiveRecord> = {}): string {
  if (!vis.hasData) return '# SearchTuneOS GEO 정기 진단\n\n진단 스냅샷이 없습니다. 정기 진단 수집 연동 후 생성됩니다.';
  const o = vis.overall;
  const md = (s: string) => s.replace(/\|/g, '/');
  const sign = (n: number) => (n >= 0 ? '+' : '');
  const lines = [
    `# SearchTuneOS GEO 정기 진단 · ${dateLabel(vis.date)}`,
    '',
    `출처: 데모 진단 스냅샷(TEST DATA · 실제 엔진 응답 아님), Claude 열만 실제 응답(LIVE) · 제안서 p.29 · 질의 ${vis.queries.length}개 × 엔진 ${vis.engines.length}개`,
    '',
    `브랜드 언급률 ${pctTxt(o.rate, 1)} (${o.mentioned}/${o.total}셀${o.deltaPp !== null ? `, 직전 회차 대비 ${sign(o.deltaPp)}${o.deltaPp.toFixed(1)}pp` : ''}) · 평균 언급 순서 ${Number.isFinite(o.avgPosition) ? `${fmt.dec1(o.avgPosition)}번째` : '—'} · 자사 인용 ${o.ownedCitations}/${o.citations}건 · 경쟁 6개사 대비 점유 ${pctTxt(o.sov, 1)} · 검색 커버리지(확보 질의) ${o.covered}/${vis.queries.length} (기준 ≥${Math.min(GEO_RULES.coveredEngines, vis.engines.length)}/${vis.engines.length} 엔진)`,
    '',
    `| 질의 | 구매 의도 | 판정 | ${vis.engines.map((e) => e.short).join(' | ')} | Claude (LIVE) | 최다 경쟁사 |`,
    `| --- | --- | --- | ${vis.engines.map(() => '---').join(' | ')} | --- | --- |`,
    ...vis.queries.map((q) => `| ${md(q.query.text)} | ${INTENT_LABEL[q.query.intent]} | ${q.status.label} (${q.mentionedEngines}/${Object.keys(q.cells).length})${q.gap ? ' · 경쟁사 우위' : ''} | ${vis.engines.map((e) => cellText(q.cells[e.id])).join(' | ')} | ${liveText(latest[q.query.id])} | ${q.topCompetitor ? `${q.topCompetitor} ${q.competitorEngines}/${Object.keys(q.cells).length}` : '—'} |`),
    '',
    `엔진별 언급률: ${vis.engines.map((e) => `${e.name} ${pctTxt(e.rate)} (${e.verdict.label})`).join(' · ')} · 기준 ≥${pctTxt(GEO_RULES.engineRateGood)} 확보, <${pctTxt(GEO_RULES.engineRateLow)} 취약`,
    '',
    vis.gaps.length ? `경쟁사 우위 질의 ${vis.gaps.length}개(경쟁사 ≥${GEO_RULES.gapCompetitorEngines}개 엔진 & 자사 ≤${GEO_RULES.gapBrandMax}개): ${vis.gaps.map((g) => g.query.text).join(', ')}` : '경쟁사 우위 질의 없음',
    '',
    `반복 관측: 최근 ${vis.stability.rounds}회 중 ${GEO_RULES.stableRounds}회 이상 언급 ${vis.stability.stable}셀 · 변동 ${vis.stability.volatile}셀 · 미언급 ${vis.stability.never}셀. 변동 구간은 2회 연속 같은 방향일 때만 변화로 기록합니다.`,
    '',
    '노출 순위 보장이 아닌 정기 진단 · 개선 방식으로 운영합니다. (제안서 p.29)',
  ];
  return lines.join('\n');
}

/* ============================== 페이드 AI 지면 → SA 키워드 ============================== */

export interface KwInfo {
  id: string; text: string; status: Keyword['status']; isBrand: boolean; avgRank: number; lost: number;
  cost: number; conversions: number; roas: number; targetRoas: number; roasRatio: number;
  landing: string; soldOutOption: string | null; cpcChangePct: number; convChangePct: number; clicksChangePct: number;
  /** 성과 급변 판정 (표본 기준 · 수집 이상 포함) */
  shift: KeywordShift;
}
export interface TermInfo { term: string; registered: boolean; clicks: number; conversions: number; cost: number; revenue: number; roas: number }
export interface ShoppingCell { exposed: boolean; rank: number | null; competitorsAbove: string[] }
export interface PaidSignal { id: string; label: string; tone: GeoTone; basis: string }
export interface PaidRow {
  query: GeoQuery;
  naverAi: GeoCell | null;
  shopping: ShoppingCell;
  kw: KwInfo | null;
  term: TermInfo | null;
  signals: PaidSignal[];
  /** 성과 급변 원인 후보 (급변 신호가 없으면 빈 목록) */
  causes: CauseCandidate[];
  action: Verdict & { detail: string };
  requestable: boolean;
}

export interface KeywordShift {
  cpcChangePct: number; convChangePct: number; clicksChangePct: number;
  recentClicks: number; expectedConv: number; cpcEligible: boolean; convEligible: boolean;
  /** 수집 데이터 이상 (음수 · 비수치 값, 또는 최근 노출 0) */
  collection: boolean;
  cpcHit: boolean; convHit: boolean;
  /** 자동 조정 보류 대상 (p.14) */
  triggered: boolean;
  basis: string;
}

/**
 * 최근 3일 vs 이전 11일 (keyword.daily 14일) — p.14 성과 급변 판단.
 * CPC = 기간 합계 비용 ÷ 클릭, 전환 · 클릭 = 일평균 비교. 표본이 부족하면 급변으로 판정하지 않는다 (SHIFT_RULES).
 */
export function keywordShift(k: Keyword): KeywordShift {
  const d = Array.isArray(k.daily) ? k.daily : [];
  const n = SHIFT_RULES.windowDays;
  const hold = AD_PILOT.anomalyHoldPct;
  if (d.length < n + 3) {
    return {
      cpcChangePct: NaN, convChangePct: NaN, clicksChangePct: NaN, recentClicks: 0, expectedConv: 0, cpcEligible: false, convEligible: false,
      collection: false, cpcHit: false, convHit: false, triggered: false, basis: '일자별 데이터 부족 — 급변 판정 불가',
    };
  }
  const val = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const invalid = d.some((r) => [r.impressions, r.clicks, r.cost, r.conversions, r.revenue].some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0));
  const last = d.slice(-n), prior = d.slice(0, -n);
  const tot = (rows: typeof d, f: (r: (typeof d)[number]) => number) => sum(rows, (r) => val(f(r)));
  const rClicks = tot(last, (r) => r.clicks), bClicks = tot(prior, (r) => r.clicks);
  const cpcR = metrics.cpc(tot(last, (r) => r.cost), rClicks);
  const cpcB = metrics.cpc(tot(prior, (r) => r.cost), bClicks);
  const cpcChangePct = Number.isFinite(cpcR) && Number.isFinite(cpcB) ? metrics.pctChange(cpcR, cpcB) : NaN;
  const convPerDayB = tot(prior, (r) => r.conversions) / prior.length;
  const convChangePct = convPerDayB > 0 ? metrics.pctChange(tot(last, (r) => r.conversions) / n, convPerDayB) : NaN;
  const clicksChangePct = bClicks > 0 ? metrics.pctChange(rClicks / n, bClicks / prior.length) : NaN;
  const expectedConv = convPerDayB * n;
  const cpcEligible = rClicks >= SHIFT_RULES.minRecentClicks && bClicks > 0;
  const convEligible = expectedConv >= SHIFT_RULES.minExpectedConv;
  const collection = invalid || (tot(last, (r) => r.impressions) === 0 && tot(prior, (r) => r.impressions) > 0);
  const cpcHit = cpcEligible && Number.isFinite(cpcChangePct) && Math.abs(cpcChangePct) >= hold;
  const convHit = convEligible && Number.isFinite(convChangePct) && Math.abs(convChangePct) >= hold;
  const dl = (x: number) => (Number.isFinite(x) ? fmt.delta(x, 0) : '—');
  const parts = [
    collection ? (invalid ? '수집값 이상(음수 · 비수치)' : `최근 ${n}일 노출 0`) : '',
    `CPC ${dl(cpcChangePct)}${cpcEligible ? '' : ' (표본 부족)'}`,
    `전환 ${dl(convChangePct)}${convEligible ? '' : ' (표본 부족)'}`,
    `클릭 ${dl(clicksChangePct)}`,
  ].filter(Boolean);
  return {
    cpcChangePct, convChangePct, clicksChangePct, recentClicks: rClicks, expectedConv, cpcEligible, convEligible,
    collection, cpcHit, convHit, triggered: collection || cpcHit || convHit,
    basis: `${parts.join(' · ')} (최근 ${n}일 vs 이전 ${prior.length}일 · 기준 ±${hold}%)`,
  };
}

export interface CauseCandidate { label: string; score: number; basis: string }

/**
 * 성과 급변 원인 후보 순위 (CAUSE_CANDIDATES · p.47) — 키워드 일자 데이터 · 재고 · 프로모션 일정에서 근거를 계산한다.
 * 점수는 근거 강도 순서를 매기기 위한 상대값이며 확률이 아니다. 급변 신호가 없으면 빈 목록.
 */
export function shiftCauses(
  data: Dataset,
  kw: Pick<KwInfo, 'cpcChangePct' | 'convChangePct' | 'clicksChangePct' | 'soldOutOption' | 'landing'> & { triggered?: boolean },
): CauseCandidate[] {
  const hold = AD_PILOT.anomalyHoldPct;
  const cpc = kw.cpcChangePct, conv = kw.convChangePct, clk = kw.clicksChangePct;
  const fin = (n: number) => Number.isFinite(n);
  // 표본 기준을 거친 판정(keywordShift.triggered)이 있으면 그것을 따르고, 없으면 변화율만으로 판단한다
  const shifted = kw.triggered ?? ((fin(cpc) && Math.abs(cpc) >= hold) || (fin(conv) && Math.abs(conv) >= hold) || (fin(clk) && clk <= -hold));
  if (!shifted) return [];
  const clicksHeld = fin(clk) && Math.abs(clk) <= 20;
  const d = (n: number) => (fin(n) ? fmt.delta(n, 0) : '—');
  const [competitor, landing, promoCause, media] = CAUSE_CANDIDATES;
  const channel = channelFromUrl(kw.landing);
  const from = addDays(data.today, -2);
  const promoChanged = channel
    ? data.promotions.filter((p) => p.channel === channel && ((p.start >= from && p.start <= data.today) || (p.end >= from && p.end <= data.today)))
    : [];
  const out: CauseCandidate[] = [
    {
      label: competitor,
      score: fin(cpc) && cpc >= hold ? (clicksHeld ? 80 : 60) : fin(cpc) && cpc >= 20 ? 35 : 5,
      basis: `CPC ${d(cpc)} · 클릭 ${d(clk)}${fin(cpc) && cpc >= hold && clicksHeld ? ' — 클릭은 유지되고 클릭당 비용만 오름 (입찰 경쟁 상승 시 전형 패턴)' : ''}`,
    },
    {
      label: landing,
      score: kw.soldOutOption ? 70 : fin(conv) && conv <= -30 && clicksHeld && !(fin(cpc) && cpc >= hold) ? 50 : fin(conv) && conv <= -30 ? 25 : 5,
      basis: kw.soldOutOption ? `${kw.soldOutOption} 옵션 품절 · 랜딩 = 상품 상세 · 전환 ${d(conv)}` : `전환 ${d(conv)} · 품절 옵션 연결 없음`,
    },
    {
      label: promoCause,
      score: promoChanged.length ? 45 : 5,
      basis: promoChanged.length ? `최근 3일 ${promoChanged.map((p) => `${p.name} ${p.start >= from ? '시작' : '종료'}`).join(' · ')}` : `최근 3일 ${channel ? '해당 채널' : '랜딩 채널'} 프로모션 시작 · 종료 없음`,
    },
    {
      label: media,
      score: fin(clk) && clk <= -hold ? 60 : 5,
      basis: fin(clk) && clk <= -hold ? `클릭 ${d(clk)} — 다음 수집(07:00)에서 해소되는지 확인` : `클릭 ${d(clk)} · 집계 공백 패턴 없음`,
    },
  ];
  return out.sort((a, b) => b.score - a.score);
}

export function keywordInfo(data: Dataset, k: Keyword): KwInfo {
  const roas = metrics.roas(k.last14.revenue, k.last14.cost);
  const targetRoas = k.isBrand ? AD_PILOT.brandTargetRoas : AD_PILOT.targetRoas;
  let soldOutOption: string | null = null;
  for (const p of data.products) {
    if (p.landing !== k.landing) continue;
    const opt = p.options.filter((o) => !o.inStock).find((o) => norm(k.text).includes(norm(o.label)));
    if (opt) { soldOutOption = opt.label; break; }
  }
  const sh = keywordShift(k);
  return {
    id: k.id, text: k.text, status: k.status, isBrand: k.isBrand, avgRank: k.avgRank, lost: k.impressionShareLost,
    cost: k.last14.cost, conversions: k.last14.conversions, roas, targetRoas, roasRatio: Number.isFinite(roas) ? roas / targetRoas : NaN,
    landing: k.landing, soldOutOption, cpcChangePct: sh.cpcChangePct, convChangePct: sh.convChangePct, clicksChangePct: sh.clicksChangePct,
    shift: sh,
  };
}

export function findKeyword(data: Dataset, q: GeoQuery): Keyword | null {
  if (q.kw) { const k = data.keywords.find((x) => x.text === q.kw); if (k) return k; }
  const nq = norm(q.text);
  return data.keywords.find((x) => norm(x.text) === nq) ?? null;
}
export function findTerm(data: Dataset, q: GeoQuery): TermInfo | null {
  const t = (q.term ? data.searchTerms.find((x) => x.term === q.term) : undefined) ?? data.searchTerms.find((x) => norm(x.term) === norm(q.text));
  if (!t) return null;
  return { term: t.term, registered: t.registered, clicks: t.clicks, conversions: t.conversions, cost: t.cost, revenue: t.revenue, roas: metrics.roas(t.revenue, t.cost) };
}

export function shoppingCell(q: GeoQuery, date: string): ShoppingCell {
  const R = rng(hashString(`geo-shop|${date}|${q.id}`));
  const exposed = R.next() < SHOPPING_EXPOSE[q.intent];
  if (!exposed) return { exposed: false, rank: null, competitorsAbove: [] };
  const rank = R.int(1, 8);
  const pool = Object.keys(COMPETITOR_ALIASES);
  const above: string[] = [];
  for (let i = 0; i < Math.min(rank - 1, 3); i++) {
    const c = pool.splice(Math.floor(R.next() * pool.length), 1)[0];
    if (c) above.push(c);
  }
  return { exposed, rank, competitorsAbove: above };
}

export function paidSurfaceRows(data: Dataset, snap: GeoSnapshot, roundIndex?: number): PaidRow[] {
  const vis = visibilitySummary(snap, roundIndex);
  const date = vis.date ?? data.today;
  const dlabel = dateLabel(date, false);
  return snap.queries.map((q) => {
    const naverAi = vis.queries.find((x) => x.query.id === q.id)?.cells.naver_ai ?? null;
    const shopping = shoppingCell(q, date);
    const k = findKeyword(data, q);
    const kw = k ? keywordInfo(data, k) : null;
    const term = findTerm(data, q);
    const shifted = !!kw?.shift.triggered;
    const causes = kw && shifted ? shiftCauses(data, { ...kw, triggered: true }) : [];
    const top = causes[0];
    const signals: PaidSignal[] = [];
    if (kw?.soldOutOption) signals.push({ id: 'soldout', label: '품절 옵션 랜딩', tone: 'serious', basis: `${kw.soldOutOption} 옵션 품절 · '${kw.text}' 랜딩 = 상품 상세` });
    if (kw && shifted) {
      const lbl = kw.shift.collection ? '수집 데이터 이상' : [kw.shift.cpcHit ? `CPC ${fmt.delta(kw.cpcChangePct, 0)}` : '', kw.shift.convHit ? `전환 ${fmt.delta(kw.convChangePct, 0)}` : ''].filter(Boolean).join(' · ');
      signals.push({ id: 'shift', label: `성과 급변 · ${lbl}`, tone: 'warning', basis: `${kw.shift.basis} · p.14 자동 조정 보류` });
    }
    if (naverAi && !naverAi.mentioned) signals.push({ id: 'ai_miss', label: 'AI 브리핑 미언급', tone: 'warning', basis: `${dlabel} 진단 · 경쟁사 ${naverAi.competitors.length}개 언급` });
    if (!shopping.exposed) signals.push({ id: 'shop_miss', label: '쇼핑 지면 미노출', tone: 'warning', basis: `${dlabel} 점검` });
    if (term && !term.registered && term.conversions > 0) signals.push({ id: 'term', label: '미등록 검색어 전환', tone: 'accent', basis: `클릭 ${fmt.int(term.clicks)} · 전환 ${fmt.dec1(term.conversions)} · ROAS ${fmt.roas(term.roas)}` });

    let action: Verdict & { detail: string };
    let requestable = false;
    const roasBasis = kw ? `ROAS ${fmt.roas(kw.roas)} · 목표 ${fmt.roas(kw.targetRoas)} 대비 ${pctTxt(kw.roasRatio)}` : '';
    if (kw?.soldOutOption) {
      action = { id: 'landing', label: '랜딩 점검 우선', tone: 'serious', basis: `${kw.soldOutOption} 품절 · ${roasBasis}`, detail: `품절 옵션 키워드가 상품 상세로 연결됩니다. 재고 있는 옵션 · 대체 사이즈 안내 랜딩으로 바꾸거나 해당 키워드를 보류하고, JSON-LD availability를 OutOfStock으로 맞춥니다.` };
    } else if (term && !term.registered && term.conversions > 0) {
      requestable = true;
      action = { id: 'register', label: 'SA 테스트 그룹 등록 후보', tone: 'accent', basis: `검색어 보고서 미등록 · 전환 ${fmt.dec1(term.conversions)} · ROAS ${fmt.roas(term.roas)}`, detail: `'${term.term}'를 테스트 전용 그룹(입찰 상한)에 등록하고 MILDO Lab 기준(14일 또는 최소 클릭)으로 판정합니다. AI 답변에 같은 질의가 나오므로 AEO FAQ와 랜딩 문구를 함께 맞춥니다.` };
    } else if (kw && shifted) {
      action = {
        id: 'hold', label: '자동 조정 보류 유지', tone: 'warning',
        basis: `${kw.shift.basis} · ${roasBasis}`,
        detail: `AD Pilot 자동 조정 보류 구간입니다. 근거가 가장 강한 원인 후보는 ${top ? `${top.label}(${top.basis})` : '확인 중'}이며, 확인되는 동안 입찰을 올리지 않습니다. ${naverAi?.mentioned ? 'AI 브리핑 노출이 유지되는지' : 'AI 브리핑 미노출 구간을 AEO 콘텐츠로 보완할 수 있는지'} 함께 봅니다 (가설).`,
      };
    } else if (kw && naverAi && !naverAi.mentioned && Number.isFinite(kw.roasRatio) && kw.roasRatio >= 1) {
      action = { id: 'defend', label: 'SA 노출 유지 · 방어', tone: 'good', basis: `AI 브리핑 미언급 · ${roasBasis} · 노출 기회 손실 ${pctTxt(kw.lost)}`, detail: `AI 요약에 브랜드가 없는 질의입니다. 목표 ROAS를 넘는 SA 노출을 유지해 유료 지면으로 보완하고, 노출 기회 손실이 ${pctTxt(AD_PILOT.lostShareTrigger)} 이상이면 AD Pilot 상향 후보(p.14)와 함께 검토합니다.` };
    } else if (kw && naverAi?.mentioned && Number.isFinite(kw.roasRatio) && kw.roasRatio < KEYWORD_TEST_RULES.keepFromPct / 100) {
      action = { id: 'review', label: 'SA 효율 점검', tone: 'warning', basis: `AI 브리핑 언급 · ${roasBasis} (기준 목표 대비 ${KEYWORD_TEST_RULES.keepFromPct}% · p.26)`, detail: `AI 요약에 브랜드가 노출되는 질의에서 SA 효율이 목표의 ${KEYWORD_TEST_RULES.keepFromPct}%에 못 미칩니다. 오가닉과 유료 노출이 겹치는지 홀드아웃 없이 단정할 수 없으므로, 입찰 하향 전 2주 비교로 판정합니다 (가설).` };
    } else if (naverAi && !naverAi.mentioned && !shopping.exposed) {
      action = { id: 'content', label: 'AEO 콘텐츠 · 쇼핑 지면 보완', tone: 'warning', basis: `AI 브리핑 미언급 · 쇼핑 지면 미노출${kw ? ` · ${roasBasis}` : ''}`, detail: '오가닉 AI 지면과 쇼핑 지면 모두 브랜드가 없습니다. FAQ · 상품 정보 보강을 먼저 하고 다음 정기 진단에서 변화를 확인합니다.' };
    } else if (!kw && !term) {
      action = { id: 'lab', label: 'Lab 검색량 확인', tone: 'neutral', basis: 'SA 키워드 · 검색어 보고서 연결 없음', detail: '검색량 확인 후 MILDO Lab 구문형 후보로 등록할지 판단합니다.' };
    } else {
      action = { id: 'keep', label: '유지 · 정기 진단', tone: 'neutral', basis: kw ? roasBasis : `검색어 보고서 ${term?.registered ? '등록' : '미등록'}`, detail: '현재 기준 내 · 다음 정기 진단에서 재확인합니다.' };
    }
    return { query: q, naverAi, shopping, kw, term, signals, causes, action, requestable };
  });
}

export function paidSummary(rows: PaidRow[]) {
  const by = (id: string) => rows.filter((r) => r.action.id === id).length;
  return {
    total: rows.length,
    register: by('register'), landing: by('landing'), hold: by('hold'), defend: by('defend'), review: by('review'), content: by('content'), lab: by('lab'), keep: by('keep'),
    aiMiss: rows.filter((r) => r.naverAi && !r.naverAi.mentioned).length,
    shopMiss: rows.filter((r) => !r.shopping.exposed).length,
    linkedKw: rows.filter((r) => r.kw).length,
  };
}

/* ---------- SA 테스트 그룹 등록 요청 (ChangeRequest pending) ---------- */

const termKey = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
export const REGISTRATION_ORIGIN: Record<string, string> = { geo: 'SearchTuneOS', adpilot: 'AD Pilot', lab: 'MILDO Lab' };

/** targetId에서 검색어 부분 — 'term:…' · 'labreg:…' · MILDO Flow 시연 이력 'seed:term:<공백→_>' */
const idTermKey = (id: unknown): string | null => {
  const m = String(id ?? '').match(/^(?:seed:)?(?:term|labreg):(.+)$/);
  return m ? termKey(m[1].replace(/_/g, '')) : null;
};
/** target에서 검색어 부분 — '… → X_TEST 등록'(AD Pilot) · '… 테스트 그룹 등록'(MILDO Flow 시연 이력) */
const targetTermKey = (target: unknown): string => termKey(String(target ?? '').split('→')[0].replace(/\s*테스트\s*그룹\s*등록\s*$/, ''));

/**
 * 같은 검색어의 등록 요청이 이미 있는가 — SearchTuneOS · AD Pilot(targetId 'term:…', target '… → X_TEST 등록') ·
 * MILDO Lab(targetId 'labreg:…') · MILDO Flow 시연 이력(targetId 'seed:term:…', target '… 테스트 그룹 등록')
 * 어느 화면에서 올렸든 같은 검색어면 중복으로 본다. 반려 · 롤백 건은 제외.
 */
export function findRegistration(changes: readonly ChangeRequest[] | null | undefined, term: string): ChangeRequest | undefined {
  const t = termKey(term);
  if (!t) return undefined;
  return (changes ?? []).find((c) => !!c && c.kind === 'keyword_add' && c.status !== 'rejected' && c.status !== 'rolled_back' && (
    idTermKey(c.targetId) === t || targetTermKey(c.target) === t
  ));
}

/** 등록 요청 페이로드 — 형식은 AD Pilot 테스트 그룹 등록과 같게 맞춘다 (targetId 'term:…', after '<의도>_TEST'). 브랜드 검색어 편입은 PM 승인 */
export function registrationRequest(r: PaidRow, requestedBy: string): Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'> | null {
  if (!r.requestable || !r.term) return null;
  const intent = r.query.intent;
  const brand = intent === 'brand';
  const approver: ApprovalLevel = brand ? 'PM' : 'AE';
  return {
    module: 'geo', kind: 'keyword_add', target: r.term.term, targetId: `term:${r.term.term}`,
    before: '미등록 (검색어 보고서)', after: `${intent.toUpperCase()}_TEST · 테스트 그룹 등록 · 입찰 상한 적용`,
    reason: `GEO 질의 '${r.query.text}' · ${r.action.basis} · 네이버 AI 브리핑 ${r.naverAi ? (r.naverAi.mentioned ? '언급' : '미언급') : '진단 없음'} (TEST DATA)${brand ? ' · 브랜드 검색어 편입은 PM 승인' : ' · 승인 범위 내 운영 조정(p.53)'}`,
    requestedBy, approver,
  };
}

/* ============================== AEO FAQ ============================== */

export interface FaqItem { id: string; topic: AeoTopicId; q: string; a: string; source: 'rule' | 'ai' | 'edited'; queries: string[] }
export interface FaqReviewed extends FaqItem { hits: ReviewHit[]; level: ReviewLevel | 'ok'; placeholders: string[]; publishable: boolean; status: Verdict }

export const TOPIC_LABEL: Record<AeoTopicId, string> = Object.fromEntries(AEO_TOPICS.map((t) => [t.id, t.label])) as Record<AeoTopicId, string>;

/** 규칙 기반 FAQ 초안 — 사이즈 · 가격은 운영 데이터, 확인되지 않은 사양은 [입력] 자리표시 */
export function buildFaqDraft(data: Dataset): FaqItem[] {
  const p = data.products[0];
  const opts = (p?.options ?? []).slice().sort((a, b) => a.price - b.price);
  const label = (id: string, fb: string) => opts.find((o) => o.id === id)?.label ?? fb;
  const sizeList = opts.length ? opts.map((o) => `${o.label} ${fmt.won(o.price)}`).join(', ') : '';
  const single = opts[0]?.label ?? '슈퍼싱글';
  const items: FaqItem[] = [
    { id: 'f_hard_1', topic: 'hardness', q: '매트리스 경도는 어떻게 고르나요?', a: '경도는 체중 · 수면 자세 · 선호하는 감촉을 함께 보고 고릅니다. 옆으로 자는 편이라면 어깨와 골반이 눌리는 정도를, 바로 누워 자는 편이라면 허리 부분이 뜨거나 가라앉는 정도를 확인합니다. 수면밀도 매트리스의 경도 단계와 측정 기준은 [경도 단계 · 측정 기준 입력]입니다.', source: 'rule', queries: ['q07', 'q02', 'q06'] },
    { id: 'f_hard_2', topic: 'hardness', q: '단단한 매트리스와 푹신한 매트리스는 무엇이 다른가요?', a: '단단한 매트리스는 몸이 덜 가라앉아 자세를 바꾸기 쉽고, 푹신한 매트리스는 몸이 닿는 면적이 넓어 감촉이 부드럽습니다. 어느 쪽이 맞는지는 체형과 수면 자세에 따라 다르므로 같은 조건에서 직접 누워 비교하는 것을 권장합니다. 허리 질환이 있다면 매트리스를 고르기 전에 전문의와 상담하세요.', source: 'rule', queries: ['q08', 'q06'] },
    { id: 'f_mat_1', topic: 'material', q: '수면밀도 매트리스는 어떤 소재와 구조로 되어 있나요?', a: '수면밀도 매트리스의 레이어 구성은 [레이어 구성 · 폼 종류 · 스프링 방식 입력]입니다. 커버 원단과 관리 방법은 [커버 원단 · 세탁 방법 입력]을 참고하세요.', source: 'rule', queries: ['q09', 'q10', 'q20'] },
    { id: 'f_mat_2', topic: 'material', q: '독립스프링과 포켓스프링은 어떻게 다른가요?', a: '두 명칭 모두 스프링을 하나씩 감싸 개별로 움직이게 만든 구조를 가리키는 경우가 많고, 판매처마다 부르는 이름이 다릅니다. 비교할 때는 명칭보다 스프링 개수 · 배열 방식 · 상단 폼 두께를 확인하는 편이 정확합니다.', source: 'rule', queries: ['q13'] },
    { id: 'f_mat_3', topic: 'material', q: '여름에 덥지 않은 매트리스는 무엇을 보고 고르나요?', a: '표면 원단의 통기성, 상단 폼의 두께와 종류, 스프링 층의 공기 흐름이 체감 온도에 영향을 줍니다. 계절에 따라 토퍼나 패드를 바꿔 쓰는 방법도 함께 검토할 수 있습니다.', source: 'rule', queries: ['q10'] },
    {
      id: 'f_size_1', topic: 'size', q: '수면밀도 매트리스는 어떤 사이즈가 있고 가격은 얼마인가요?',
      a: sizeList ? `수면밀도 매트리스는 ${sizeList}(정가 기준)으로 판매합니다. 기획전 기간 판매가와 옵션별 재고는 브랜드스토어 상품 페이지에서 확인하세요.` : '수면밀도 매트리스의 사이즈와 정가는 [사이즈 · 정가 입력]입니다.',
      source: 'rule', queries: ['q03', 'q04', 'q05'],
    },
    { id: 'f_size_2', topic: 'size', q: `신혼집에는 ${label('q', '퀸')}과 ${label('k', '킹')} 중 어떤 사이즈가 맞나요?`, a: `침실 크기, 함께 쓰는 인원, 아이 · 반려동물과 같이 자는지 여부로 고릅니다. 침대 프레임 바깥 치수를 기준으로 벽과 통로 사이에 여유 공간이 남는지 먼저 확인하세요. ${label('q', '퀸')}과 ${label('k', '킹')}의 매트리스 치수는 [${label('q', '퀸')} · ${label('k', '킹')} 치수 입력]입니다.`, source: 'rule', queries: ['q15', 'q16'] },
    { id: 'f_size_3', topic: 'size', q: '아이방이나 자취방에는 어떤 사이즈가 맞나요?', a: `1인 사용이 기준이라면 ${single}를 먼저 검토하고, 방 크기와 침대 프레임 바깥 치수를 함께 확인합니다.`, source: 'rule', queries: ['q18', 'q20', 'q04'] },
    { id: 'f_crit_1', topic: 'criteria', q: '매트리스를 고를 때 무엇부터 확인해야 하나요?', a: '경도 · 사이즈 · 소재 구조 순서로 확인하는 것을 권장합니다. 경도는 수면 자세와 체중, 사이즈는 침실 크기와 사용 인원, 소재 구조는 꺼짐 · 통기 · 소음과 관련된 사양으로 비교합니다.', source: 'rule', queries: ['q14', 'q12', 'q06', 'q09'] },
    { id: 'f_crit_2', topic: 'criteria', q: '매트리스는 언제 교체하나요?', a: '표면이 눈에 띄게 꺼지거나, 스프링 소음이 커졌거나, 이사로 침대 크기가 바뀌는 시점이 교체를 검토하는 기준이 됩니다. 사용 기간만으로 판단하기보다 꺼짐 정도와 사용 환경 변화를 함께 확인하세요.', source: 'rule', queries: ['q17'] },
    { id: 'f_crit_3', topic: 'criteria', q: '부모님 선물용 매트리스는 무엇을 확인해야 하나요?', a: '평소 수면 자세와 선호하는 경도, 침대 프레임 크기, 배송 · 설치 일정과 기존 매트리스 수거 여부를 미리 확인합니다. 배송 · 설치 방식은 [배송 지역 · 설치 · 수거 조건 입력]입니다.', source: 'rule', queries: ['q19'] },
    { id: 'f_brand_1', topic: 'brand', q: '수면밀도는 어떤 브랜드인가요?', a: `수면밀도는 ${RFP.company}가 운영하는 매트리스 브랜드로, 네이버 · 오늘의집 가구 부문 판매 1위를 기록했습니다 [집계 기간 · 출처 입력].`, source: 'rule', queries: ['q01', 'q11'] },
  ];
  return items;
}

export function placeholdersOf(text: string): string[] {
  return [...String(text ?? '').matchAll(/\[[^\]\n]{1,60}\]/g)].map((m) => m[0]);
}

export function reviewFaqItem(it: FaqItem): FaqReviewed {
  const hits = reviewText(`${it.q} ${it.a}`);
  const level = reviewLevelOf(hits);
  const placeholders = placeholdersOf(`${it.q} ${it.a}`);
  const empty = !it.q.trim() || !it.a.trim();
  const publishable = !empty && level !== 'block' && level !== 'warn' && placeholders.length === 0;
  let status: Verdict;
  if (empty) status = { id: 'empty', label: '내용 없음', tone: 'outline', basis: '질문 · 답변 모두 필요' };
  else if (level === 'block') status = { id: 'block', label: '차단', tone: 'critical', basis: hits.filter((h) => h.level === 'block').map((h) => `'${h.match}'`).join(' · ') + ' · REVIEW_RULES 의료 효능' };
  else if (placeholders.length) status = { id: 'input', label: '입력 필요', tone: 'warning', basis: `미입력 ${placeholders.length}개 · 실제 사양 확인 전 게시 보류` };
  else if (level === 'warn') status = { id: 'warn', label: '확인 필요', tone: 'warning', basis: hits.filter((h) => h.level === 'warn').map((h) => `'${h.match}'`).join(' · ') + ' · 출처 · 기준 병기' };
  else if (level === 'check') status = { id: 'check', label: '게시 가능 · 가격 대조', tone: 'good', basis: `가격 표기 ${hits.length}건 · 판매가와 매일 대조` };
  else status = { id: 'ok', label: '게시 가능', tone: 'good', basis: 'REVIEW_RULES 6종 통과 · 미입력 없음' };
  return { ...it, hits, level, placeholders, publishable, status };
}
export function reviewFaq(items: FaqItem[]): FaqReviewed[] {
  return items.map(reviewFaqItem);
}

export function faqJsonLd(items: FaqReviewed[], onlyPublishable = true): { json: string; included: number; excluded: number } {
  const inc = items.filter((i) => i.q.trim() && i.a.trim() && (!onlyPublishable || i.publishable));
  const doc = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: inc.map((i) => ({ '@type': 'Question', name: i.q.trim(), acceptedAnswer: { '@type': 'Answer', text: i.a.trim() } })),
  };
  return { json: JSON.stringify(doc, null, 2), included: inc.length, excluded: items.length - inc.length };
}

export function faqMarkdown(items: FaqReviewed[]): string {
  const lines = ['# AEO FAQ 초안 · 수면밀도', ''];
  for (const t of AEO_TOPICS) {
    const ti = items.filter((i) => i.topic === t.id);
    if (!ti.length) continue;
    lines.push(`## ${t.label}`, '');
    for (const i of ti) lines.push(`**Q. ${i.q}**`, '', `A. ${i.a}`, '', `검수: ${i.status.label} · ${i.status.basis}`, '');
  }
  return lines.join('\n');
}

export function faqCoverage(items: FaqReviewed[], vis: Visibility) {
  const pub = items.filter((i) => i.publishable);
  const topics = AEO_TOPICS.map((t) => ({ id: t.id, label: t.label, core: t.core, total: items.filter((i) => i.topic === t.id).length, publishable: pub.filter((i) => i.topic === t.id).length }));
  const weak = vis.queries.filter((q) => q.gap || q.status.id !== 'covered');
  const covered = weak.filter((q) => pub.some((i) => i.queries.includes(q.query.id)));
  const drafted = weak.filter((q) => !covered.includes(q) && items.some((i) => i.queries.includes(q.query.id)));
  const uncovered = weak.filter((q) => !items.some((i) => i.queries.includes(q.query.id)));
  return {
    topics,
    coreCovered: topics.filter((t) => t.core && t.publishable > 0).length,
    coreTotal: topics.filter((t) => t.core).length,
    weak, covered, drafted, uncovered,
    publishable: pub.length, total: items.length,
    blocked: items.filter((i) => i.level === 'block').length,
    needsInput: items.filter((i) => i.placeholders.length > 0).length,
  };
}

/** AI 응답(askJson) → FaqItem[] (형식 검증 · 길이 제한) */
export function sanitizeAiFaq(raw: unknown): FaqItem[] {
  const arr: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const byLabel: Record<string, AeoTopicId> = {};
  for (const t of AEO_TOPICS) { byLabel[t.id] = t.id; byLabel[t.label] = t.id; }
  const out: FaqItem[] = [];
  arr.slice(0, 12).forEach((x, i) => {
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    const q = typeof o.q === 'string' ? o.q : typeof o.question === 'string' ? o.question : '';
    const a = typeof o.a === 'string' ? o.a : typeof o.answer === 'string' ? o.answer : '';
    const topicRaw = typeof o.topic === 'string' ? o.topic.trim() : '';
    const topic = byLabel[topicRaw] ?? AEO_TOPICS.find((t) => topicRaw.includes(t.label))?.id ?? 'criteria';
    if (!q.trim() || !a.trim()) return;
    out.push({
      id: `ai_${i}_${hashString(q).toString(36).slice(0, 5)}`, topic, q: clip(collapse(q), 120), a: clip(collapse(a), 400), source: 'ai',
      queries: GEO_QUERIES.filter((g) => g.topics.includes(topic)).slice(0, 3).map((g) => g.id),
    });
  });
  return out;
}

export function faqAiPrompt(data: Dataset, vis: Visibility): string {
  const p = data.products[0];
  const weak = vis.queries.filter((q) => q.gap || q.status.id !== 'covered').slice(0, 10).map((q) => q.query.text);
  return [
    '수면밀도(매트리스 브랜드) 제품페이지에 넣을 AEO FAQ 초안을 작성한다.',
    '주제는 경도 · 소재 · 사이즈 · 선택 기준 네 가지이며 주제마다 1~2개 문항을 쓴다.',
    '규칙: 질병 · 통증의 치료 · 완화 · 교정 · 예방 등 의료 효능을 암시하는 표현 금지, 최상급 · 순위 표현은 출처가 없으면 쓰지 않는다, 확인되지 않은 사양(경도 단계 · 치수 · 소재 구성)은 지어내지 말고 [항목명 입력] 자리표시로 남긴다, 경쟁사명 금지, 소비자에게 보이는 존댓말 문장, 답변은 2~3문장.',
    `확인된 상품 정보(시연용 테스트 데이터): ${p ? `${p.name} · ${p.options.map((o) => `${o.label} 정가 ${o.price}원${o.inStock ? '' : ' (품절)'}`).join(', ')}` : '없음'}`,
    `AI 검색에서 브랜드 언급이 약한 질의: ${weak.join(', ') || '없음'}`,
    '출력: {"items":[{"topic":"경도|소재|사이즈|선택 기준","q":"질문","a":"답변"}]} JSON 하나.',
  ].join('\n');
}

/* ============================== 진단 전후 기록 (p.29 공란) ============================== */

export interface CaseInput {
  brand: string; beforeLabel: string; afterLabel: string; engines: string;
  beforeRate: number | null; afterRate: number | null; beforeCites: number | null; afterCites: number | null;
  /** 데모 스냅샷으로 채운 값 (TEST DATA) — '지우기' 전까지 유지 */
  demo?: boolean;
}
export const EMPTY_CASE: CaseInput = { brand: '', beforeLabel: '', afterLabel: '', engines: '', beforeRate: null, afterRate: null, beforeCites: null, afterCites: null, demo: false };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 숫자 입력 칸 문자열 → 숫자 (콤마 · % · 건 허용, 빈 값 · 비수치는 null) */
export function parseNumInput(v: string): number | null {
  const s = String(v ?? '').replace(/[,%건\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function caseMetrics(c: CaseInput) {
  const missing: string[] = [];
  if (!c.brand.trim()) missing.push('브랜드');
  if (!isNum(c.beforeRate)) missing.push('진단 전 언급률');
  if (!isNum(c.afterRate)) missing.push('진단 후 언급률');
  if (!isNum(c.beforeCites)) missing.push('진단 전 인용 수');
  if (!isNum(c.afterCites)) missing.push('진단 후 인용 수');
  // 범위 점검: 언급률 0~100%, 인용 수 0 이상 정수
  const invalid: string[] = [];
  const rateOk = (v: number | null) => !isNum(v) || (v >= 0 && v <= 100);
  const citeOk = (v: number | null) => !isNum(v) || (v >= 0 && Number.isInteger(v));
  if (!rateOk(c.beforeRate)) invalid.push('진단 전 언급률(0~100%)');
  if (!rateOk(c.afterRate)) invalid.push('진단 후 언급률(0~100%)');
  if (!citeOk(c.beforeCites)) invalid.push('진단 전 인용 수(0 이상 정수)');
  if (!citeOk(c.afterCites)) invalid.push('진단 후 인용 수(0 이상 정수)');
  // 범위를 벗어난 값은 변화량 · 삽입 문구에 쓰지 않는다 (예: 언급률 140% → [범위 확인]) — 잘못 입력한 수치가 제안서로 복사되지 않도록
  const okRate = (v: number | null): v is number => isNum(v) && rateOk(v);
  const okCite = (v: number | null): v is number => isNum(v) && citeOk(v);
  const rateDeltaPp = okRate(c.beforeRate) && okRate(c.afterRate) ? c.afterRate - c.beforeRate : null;
  const citeDelta = okCite(c.beforeCites) && okCite(c.afterCites) ? c.afterCites - c.beforeCites : null;
  const citeDeltaPct = citeDelta !== null && isNum(c.beforeCites) && c.beforeCites > 0 ? (citeDelta / c.beforeCites) * 100 : null;
  // 정수는 천 단위 구분(1,200건) — 제안서에 그대로 붙여 넣는 문구
  const v = (n: number | null, suf: string, ok: boolean) => (!isNum(n) ? '[입력]' : !ok ? '[범위 확인]' : `${Number.isInteger(n) ? fmt.int(n) : n.toFixed(1)}${suf}`);
  const sign = (n: number) => (n > 0 ? '+' : '');
  const text = [
    `${c.brand.trim() || '[브랜드]'}${c.beforeLabel || c.afterLabel ? ` · ${c.beforeLabel || '[진단 전]'} → ${c.afterLabel || '[진단 후]'}` : ''}${c.engines.trim() ? ` · ${c.engines.trim()}` : ''}`,
    `브랜드 언급률 ${v(c.beforeRate, '%', okRate(c.beforeRate))} → ${v(c.afterRate, '%', okRate(c.afterRate))}${rateDeltaPp !== null ? ` (${sign(rateDeltaPp)}${rateDeltaPp.toFixed(1)}pp)` : ''}`,
    `인용 수 ${v(c.beforeCites, '건', okCite(c.beforeCites))} → ${v(c.afterCites, '건', okCite(c.afterCites))}${citeDelta !== null ? ` (${sign(citeDelta)}${fmt.int(citeDelta)}건${citeDeltaPct !== null ? `, ${sign(citeDeltaPct)}${citeDeltaPct.toFixed(1)}%` : ''})` : ''}`,
    c.demo ? 'TEST DATA · 실제 사례 아님' : '',
  ].filter(Boolean).join(' · ');
  return { rateDeltaPp, citeDelta, citeDeltaPct, complete: missing.length === 0 && invalid.length === 0, missing, invalid, demo: !!c.demo, text };
}

/** 데모 스냅샷 첫 회차 vs 최신 회차 (TEST DATA — 실제 사례 아님) */
export function demoCaseFromSnapshot(snap: GeoSnapshot): CaseInput {
  if (!snap.rounds.length) return { ...EMPTY_CASE };
  const first = visibilitySummary(snap, 0);
  const last = visibilitySummary(snap, snap.rounds.length - 1);
  return {
    brand: BRAND,
    beforeLabel: first.date ?? '',
    afterLabel: last.date ?? '',
    engines: `${snap.engines.map((e) => e.short).join(' · ')} · 질의 ${snap.queries.length}개`,
    beforeRate: r1(first.overall.rate * 100),
    afterRate: r1(last.overall.rate * 100),
    beforeCites: first.overall.ownedCitations,
    afterCites: last.overall.ownedCitations,
    demo: true,
  };
}

/* ============================== 네 축 상태 ============================== */

export interface AxisState { id: string; metric: string; verdict: Verdict; foot: string }
export function axisStates(vis: Visibility, audit: PageAudit | null, faq: ReturnType<typeof faqCoverage>, paid: ReturnType<typeof paidSummary>): Record<string, AxisState> {
  return {
    seo: {
      id: 'seo',
      metric: audit && !audit.empty ? `${audit.score}점` : '—',
      verdict: audit ? { ...audit.grade, label: audit.grade.label.split(' · ')[0] } : gradeOf(0, true),
      foot: audit && !audit.empty ? `실패 ${audit.counts.fail} · 개선 ${audit.counts.warn} · 통과 ${audit.counts.pass}` : '제품페이지 HTML 진단 전',
    },
    aeo: {
      id: 'aeo',
      metric: `${faq.coreCovered}/${faq.coreTotal} 주제`,
      verdict: faq.coreCovered === faq.coreTotal
        ? { id: 'ok', label: '주제 충족', tone: 'good', basis: `게시 가능 FAQ로 4개 주제 모두 (기준 4/4)` }
        : { id: 'gap', label: '주제 보완', tone: 'warning', basis: `게시 가능 주제 ${faq.coreCovered}/4 (기준 4/4)` },
      foot: `게시 가능 ${faq.publishable}/${faq.total} · 입력 필요 ${faq.needsInput} · 차단 ${faq.blocked}`,
    },
    geo: {
      id: 'geo',
      metric: vis.hasData ? pctTxt(vis.overall.rate) : '—',
      verdict: engineVerdict(vis.overall.rate, vis.overall.total),
      foot: vis.hasData ? `확보 질의 ${vis.overall.covered}/${vis.queries.length} · 경쟁사 우위 ${vis.gaps.length}개` : '진단 스냅샷 없음',
    },
    paid: {
      id: 'paid',
      metric: `${paid.register}개 후보`,
      verdict: paid.landing > 0
        ? { id: 'landing', label: '랜딩 점검', tone: 'serious', basis: `품절 옵션 랜딩 ${paid.landing}개` }
        : paid.register > 0 ? { id: 'register', label: 'SA 반영 대기', tone: 'accent', basis: `미등록 검색어 전환 ${paid.register}개` } : { id: 'ok', label: '반영 대기 없음', tone: 'good', basis: '미등록 전환 검색어 0' },
      foot: `AI 브리핑 미언급 ${paid.aiMiss}/${paid.total} · 쇼핑 지면 미노출 ${paid.shopMiss}/${paid.total}`,
    },
  };
}

/* ============================== 브리프 (AI 미연결 규칙 엔진) ============================== */

export function visibilityBrief(vis: Visibility, live: LiveRecord[] = []): Brief {
  if (!vis.hasData) {
    return {
      title: 'GEO 모니터링 · 진단 스냅샷 없음',
      facts: ['진단 스냅샷이 없어 브랜드 언급률을 계산할 수 없습니다.'],
      patterns: [], interpretation: [],
      conditions: [`판정 기준: 질의별 ${GEO_RULES.coveredEngines}/${vis.engines.length} 엔진 이상 언급 시 확보 (운영 초기 기준 · 온보딩 중 확정)`],
      counter: [], actions: ['담당 AE: 정기 진단(매주 월) 수집 연동 상태를 확인합니다.'],
    };
  }
  const o = vis.overall;
  const sorted = vis.engines.slice().sort((a, b) => b.rate - a.rate);
  const top = sorted[0], low = sorted[sorted.length - 1];
  const topComp = vis.competitors[0];
  const lowIntent = vis.byIntent.filter((b) => b.total > 0).sort((a, b) => a.rate - b.rate)[0];
  const ls = liveSummary(live);
  const facts = [
    `${vis.date ? fmtDate(vis.date) : ''} 정기 진단 기준(TEST DATA 스냅샷) 질의 ${vis.queries.length}개 × 엔진 ${vis.engines.length}개에서 수면밀도 언급은 ${o.mentioned}/${o.total}셀, 언급률 ${pctTxt(o.rate, 1)}입니다${o.deltaPp !== null ? ` (직전 회차 대비 ${o.deltaPp >= 0 ? '+' : ''}${o.deltaPp.toFixed(1)}pp)` : ''}.`,
    `엔진별 언급률은 ${top.name} ${pctTxt(top.rate)}가 가장 높고 ${low.name} ${pctTxt(low.rate)}가 가장 낮습니다. 언급 시 평균 순서는 ${fmt.dec1(o.avgPosition)}번째, 첫 번째로 언급된 비중은 ${pctTxt(o.firstRate)}입니다.`,
    `인용 출처 ${o.citations}건 중 자사 채널(자사몰 · 브랜드스토어) 인용은 ${o.ownedCitations}건(${pctTxt(o.ownedShare)})입니다. 브랜드 언급 점유(수면밀도 ÷ 수면밀도 + 경쟁 6개사 언급)는 ${pctTxt(o.sov)}이며 가장 많이 언급된 경쟁사는 ${topComp ? `${topComp.name} ${topComp.mentions}셀` : '없음'}입니다.`,
  ];
  if (ls.count) facts.push(`Claude 라이브 진단 ${ls.count}개 질의 중 언급 ${ls.mentioned}개(${pctTxt(ls.rate)})입니다. Claude 응답 기준이며 다른 엔진은 수집 연동이 필요합니다.`);
  const patterns = [
    `최근 ${vis.stability.rounds}회 진단에서 같은 질의 · 엔진 셀이 ${GEO_RULES.stableRounds}회 이상 언급된 안정 구간은 ${vis.stability.stable}셀, 1~2회만 언급된 변동 구간은 ${vis.stability.volatile}셀, 한 번도 언급되지 않은 구간은 ${vis.stability.never}셀입니다.`,
    lowIntent ? `구매 의도별로는 ${lowIntent.label} 질의의 언급률이 ${pctTxt(lowIntent.rate)}로 가장 낮고, 브랜드 방어 질의는 ${pctTxt(vis.byIntent.find((b) => b.intent === 'brand')?.rate ?? 0)}입니다.` : '',
  ].filter(Boolean);
  const gaps = vis.gaps.slice(0, 4);
  const interpretation = [
    'AI 검색 답변은 구매 퍼널에서 비교 · 검토 직전의 정보 탐색 단계를 차지합니다. 이 단계의 브랜드 언급은 클릭 비용 없이 후보군에 들어가는 경로이므로, 유료 SA가 회수하는 수요의 앞단을 넓히는 역할로 봅니다. 다만 AI 답변 노출과 전환 사이의 기여는 현재 데이터로 측정되지 않으며, CAC 효과를 수치로 말할 근거는 없습니다.',
    gaps.length ? `경쟁사 우위 질의 ${vis.gaps.length}개(${gaps.map((g) => `'${g.query.text}'`).join(', ')})는 경쟁사가 3개 엔진 이상에서 언급되고 수면밀도는 1개 이하입니다. 정보형 질의가 많아 FAQ · 선택 가이드 같은 AEO 콘텐츠가 우선 대응 수단입니다.` : '경쟁사 우위 질의는 현재 기준으로 없습니다.',
  ];
  return {
    title: `GEO 모니터링 · 브랜드 언급률 ${pctTxt(o.rate, 1)}`,
    facts,
    patterns,
    interpretation,
    conditions: [
      `질의 확보 기준 ${GEO_RULES.coveredEngines}/${vis.engines.length} 엔진 이상, 경쟁사 우위 기준 경쟁사 ${GEO_RULES.gapCompetitorEngines}개 엔진 이상 & 자사 ${GEO_RULES.gapBrandMax}개 이하, 안정 구간 최근 4회 중 ${GEO_RULES.stableRounds}회 이상 (운영 초기 기준 · 온보딩 중 확정).`,
      '진단 스냅샷은 시연용 테스트 데이터입니다. 실데이터는 엔진별 수집 연동 후 같은 구조로 채웁니다.',
    ],
    counter: [
      `AI 답변은 질의 시점 · 로그인 상태 · 지역 · 대화 맥락에 따라 달라집니다. 변동 구간 ${vis.stability.volatile}셀은 한 번의 진단으로 개선 · 악화를 판정하지 않습니다.`,
      '언급률이 올라도 답변 속 순서가 뒤이거나 인용 출처가 제3자 블로그뿐이면 클릭 유입으로 이어지지 않을 수 있습니다. 언급률과 자사 인용 수를 함께 봅니다.',
    ],
    actions: [
      `담당 AE: 경쟁사 우위 · 미노출 질의 기준으로 AEO FAQ 초안을 검수 통과 상태로 만들고, PM 확인 후 수면밀도 승인으로 게시합니다.`,
      'PM: 게시 2주 후 정기 진단 2회 연속 결과로 언급률 · 자사 인용 수 변화를 판정하고, 진단 전후 지표를 p.29 적용 사례 칸에 기록합니다.',
    ],
  };
}

export function auditBrief(a: PageAudit): Brief {
  if (a.empty) {
    return { title: '제품페이지 진단 · 입력 필요', facts: ['진단할 HTML이 없습니다.'], patterns: [], interpretation: [], conditions: [`점수 기준: ${a.grade.basis}`], counter: [], actions: ['담당 AE: 제품페이지 HTML을 붙여넣거나 샘플 HTML로 진단합니다.'] };
  }
  const fails = a.checks.filter((c) => c.status === 'fail');
  const warns = a.checks.filter((c) => c.status === 'warn');
  const dataChecks = a.checks.filter((c) => c.axis === '운영 데이터 대조' && c.status !== 'na');
  return {
    title: `제품페이지 진단 · ${a.score}점`,
    facts: [
      `진단 점수 ${a.score}점(${a.grade.label.split(' · ')[0]}, ${a.grade.basis})입니다. 통과 ${a.counts.pass} · 개선 ${a.counts.warn} · 실패 ${a.counts.fail}개 항목입니다.`,
      fails.length ? `실패 항목은 ${fails.map((c) => `${c.label}(${c.measured})`).join(', ')}입니다.` : '실패 항목은 없습니다.',
      ...dataChecks.map((c) => `${c.label}: ${c.measured} · 기준 ${c.basis}.`),
    ],
    patterns: warns.length ? [`개선 항목 ${warns.length}개: ${warns.map((c) => c.label).join(', ')}.`] : [],
    interpretation: [
      'JSON-LD 가격 · 재고가 실제 판매 상태와 다르면 검색 결과 리치 스니펫과 AI 답변이 잘못된 가격이나 구매 가능 상태를 인용할 수 있습니다. 이 경우 클릭 후 이탈로 CVR이 떨어지고 같은 광고비에서 CPA가 오르는 구조이므로, 표기 오류는 노출 문제가 아니라 전환 비용 문제로 다룹니다.',
      a.review.some((h) => h.level === 'block') ? '의료 효능 암시 문구는 표시광고 리스크가 있고 AI 답변이 해당 문구를 그대로 인용할 수 있으므로 게시 전에 수정합니다.' : '',
    ].filter(Boolean),
    conditions: ['제목 · 메타 설명 길이와 점수 구간은 운영 초기 기준(한글 기준 · 온보딩 중 확정)입니다. 판매가 · 재고 대조는 운영 데이터(TEST DATA) 기준입니다.'],
    counter: ['점수가 높아도 검색 · AI 노출 순위를 보장하지 않습니다. 정기 진단 · 개선 방식으로 운영합니다 (p.29).'],
    actions: [
      fails.length ? `담당 AE: ${fails.slice(0, 3).map((c) => c.fix).join(' ')}` : '담당 AE: 개선 항목을 다음 정기 진단 전까지 정리합니다.',
      '수면밀도: 가격 · 재고 · 문구 수정은 상세페이지 담당 승인 후 반영하고, 반영 다음 날 재진단으로 통과 여부를 확인합니다.',
    ],
  };
}

export function faqBrief(items: FaqReviewed[], vis: Visibility): Brief {
  const cov = faqCoverage(items, vis);
  const blocked = items.filter((i) => i.level === 'block');
  const warn = items.filter((i) => i.level === 'warn');
  return {
    title: `AEO FAQ · 게시 가능 ${cov.publishable}/${cov.total}`,
    facts: [
      `FAQ 초안 ${cov.total}개 중 게시 가능 ${cov.publishable}개, 입력 필요 ${cov.needsInput}개, 검수 차단 ${cov.blocked}개입니다. 게시 가능 문항이 있는 핵심 주제는 ${cov.coreCovered}/${cov.coreTotal}개입니다.`,
      `브랜드 언급이 약한 질의 ${cov.weak.length}개 중 게시 가능 FAQ로 대응되는 질의는 ${cov.covered.length}개, 초안은 있으나 입력 · 검수가 남은 질의는 ${cov.drafted.length}개, 대응 FAQ가 없는 질의는 ${cov.uncovered.length}개입니다.`,
      warn.length ? `경고 문항: ${warn.map((i) => `'${i.q}'(${i.status.basis})`).join(', ')}.` : '',
      blocked.length ? `차단 문항: ${blocked.map((i) => `'${i.q}'`).join(', ')}.` : '',
    ].filter(Boolean),
    patterns: cov.uncovered.length ? [`대응 FAQ가 없는 질의: ${cov.uncovered.slice(0, 5).map((q) => `'${q.query.text}'`).join(', ')}.`] : [],
    interpretation: ['AI 검색 엔진은 질문형 문단과 구조화된 FAQ를 답변 근거로 인용하는 경향이 관측됩니다. 다만 FAQ 게시와 언급률 변화의 인과는 게시 전후 정기 진단으로만 확인할 수 있으며, 현재는 가설입니다.'],
    conditions: ['검수 기준은 REVIEW_RULES 6종(의료 효능 · 의료기기 오인 · 최상급 · 절대 표현 · 가격 표기 · 경쟁사명)입니다. 자리표시([입력])가 남은 문항은 게시하지 않습니다.'],
    counter: ['FAQ가 실제 사양과 다르면 AI 답변이 틀린 정보를 인용하게 됩니다. 사양 확인 없이 문항 수를 늘리는 것은 대응이 아닙니다.'],
    actions: [
      `담당 AE: 입력 필요 ${cov.needsInput}개 문항의 사양을 수면밀도 상품 담당에게 확인받아 채웁니다.`,
      'PM: 게시 가능 문항으로 FAQPage JSON-LD를 만들어 제품페이지에 반영하고, 2주 후 정기 진단에서 대응 질의의 언급 변화를 확인합니다.',
    ],
  };
}

export function paidBrief(rows: PaidRow[]): Brief {
  const s = paidSummary(rows);
  const reg = rows.filter((r) => r.action.id === 'register');
  const landing = rows.filter((r) => r.action.id === 'landing');
  const hold = rows.filter((r) => r.action.id === 'hold');
  return {
    title: `페이드 AI 지면 · SA 반영 후보 ${s.register}개`,
    facts: [
      `질의 ${s.total}개 중 네이버 AI 브리핑에서 수면밀도가 언급되지 않은 질의 ${s.aiMiss}개, 쇼핑 지면 미노출 ${s.shopMiss}개입니다(TEST DATA 스냅샷). SA 키워드와 연결된 질의는 ${s.linkedKw}개입니다.`,
      reg.length ? `검색어 보고서 미등록 · 전환 발생 검색어 ${reg.length}개: ${reg.map((r) => `'${r.term?.term}'(${r.action.basis.replace('검색어 보고서 미등록 · ', '')})`).join(', ')}.` : '미등록 · 전환 발생 검색어는 없습니다.',
      ...landing.map((r) => `'${r.kw?.text}': ${r.action.basis}.`),
      ...hold.map((r) => `'${r.kw?.text}': ${r.action.basis}.`),
    ],
    patterns: s.defend ? [`AI 브리핑 미언급이면서 SA ROAS가 목표 이상인 질의 ${s.defend}개는 유료 지면이 오가닉 공백을 메우고 있는 구간입니다.`] : [],
    interpretation: [
      '네이버 AI 브리핑에서 브랜드가 빠진 질의는 SA 노출이 없으면 해당 검색에서 브랜드 접점이 사라집니다. 반대로 AI 브리핑에 이미 노출된 질의의 SA 비용은 일부 겹칠 수 있으나, 홀드아웃 없이 중복 정도를 단정할 수 없습니다.',
      ...hold.filter((r) => r.causes[0]).map((r) => `'${r.kw?.text}' 급변은 원인 후보 중 ${r.causes[0].label} 근거가 가장 강합니다(${r.causes[0].basis}). 확정하려면 같은 기간 경쟁사 검색 지면 변화(MILDO Watch 아카이브)와 입찰 변경 이력을 대조해야 하며, 그 전까지 자동 조정 보류를 유지합니다.`),
    ],
    conditions: [`목표 ROAS ${AD_PILOT.targetRoas}% · 브랜드 ${AD_PILOT.brandTargetRoas}%(p.14), 성과 급변 ±${AD_PILOT.anomalyHoldPct}% 자동 조정 보류, 테스트 그룹 등록은 승인 범위 내 운영 조정(담당 AE, p.53) · 브랜드 검색어 편입은 PM 승인.`],
    counter: ['미등록 검색어의 전환 수가 적으면 우연일 수 있으므로 등록 후 MILDO Lab 판정 기준(14일 또는 최소 클릭)으로 확장 · 유지 · 제외를 정합니다.'],
    actions: [
      reg.length ? `담당 AE: SA 반영 요청으로 ${reg.length}개 검색어를 테스트 그룹 등록 승인 대기(MILDO Flow)에 올립니다.` : '담당 AE: 다음 정기 진단에서 미등록 검색어를 다시 확인합니다.',
      landing.length ? `PM: 품절 옵션 랜딩 ${landing.length}건은 랜딩 변경 또는 키워드 보류를 당일 결정합니다.` : 'PM: 주간 리포트에 AI 지면 · SA 연결 결과를 붙입니다.',
    ],
  };
}

/** AiInsight 프롬프트 (ANALYST_RULES는 AiInsight가 앞에 붙인다) */
export function geoPrompt(vis: Visibility, audit: PageAudit | null, rows: PaidRow[], live: LiveRecord[]): string {
  const payload = {
    출처: 'GEO 진단 스냅샷 · 운영 데이터 모두 시연용 테스트 데이터 (실제 성과 아님), Claude 라이브 진단만 실제 응답',
    진단일: vis.date, 직전진단일: vis.prevDate,
    전체: { 언급률pct: round.pct(vis.overall.rate), 직전대비pp: vis.overall.deltaPp !== null ? r1(vis.overall.deltaPp) : null, 평균순서: r1(vis.overall.avgPosition), 인용: vis.overall.citations, 자사인용: vis.overall.ownedCitations, 점유pct: round.pct(vis.overall.sov) },
    엔진: vis.engines.map((e) => ({ 엔진: e.name, 언급률pct: round.pct(e.rate), 평균순서: r1(e.avgPosition), 자사인용: e.ownedCitations })),
    경쟁사: vis.competitors.map((c) => ({ 이름: c.name, 언급셀: c.mentions, 자사보다앞: c.aheadOfBrand })),
    의도별: vis.byIntent.map((b) => ({ 의도: b.label, 언급률pct: round.pct(b.rate) })),
    경쟁사우위질의: vis.gaps.map((g) => g.query.text),
    안정성: vis.stability,
    제품페이지: audit && !audit.empty ? { 점수: audit.score, 실패: audit.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.measured}`) } : null,
    페이드: rows.filter((r) => r.action.id !== 'keep').map((r) => ({ 질의: r.query.text, 판정: r.action.label, 근거: r.action.basis })),
    Claude라이브: live.map((l) => ({ 질의: l.query, 언급: l.mentioned, 순서: l.position, 경쟁사: l.competitors })),
  };
  return `과제: SearchTuneOS(GEO · AI 검색 대응, 제안서 p.29) 진단 결과를 해석한다. AI 검색 노출이 CAC 회수 구조와 퍼널(유입/전환)에서 어떤 역할인지, SA 키워드 운영과 어떻게 연결할지, 어떤 질의부터 개선할지를 판단 기준과 함께 쓴다. 노출 순위를 보장하는 표현은 쓰지 않는다.\n\n데이터(JSON):\n${JSON.stringify(payload)}`;
}

/** 화면 하단 AiInsight 규칙 엔진 결과 — GEO 가시성 + 제품페이지 + 페이드 지면을 한 브리프로 */
export function geoOverallBrief(vis: Visibility, audit: PageAudit | null, rows: PaidRow[], faq: FaqReviewed[], live: LiveRecord[] = []): Brief {
  const v = visibilityBrief(vis, live);
  const p = paidBrief(rows);
  const cov = faqCoverage(faq, vis);
  const auditFact = audit && !audit.empty
    ? `제품페이지 진단 ${audit.score}점(${audit.grade.basis})이며 실패 항목은 ${audit.checks.filter((c) => c.status === 'fail').map((c) => c.label).join(', ') || '없음'}입니다.`
    : '제품페이지 HTML 진단 전입니다.';
  return {
    title: `SearchTuneOS 진단 해석 · ${vis.date ? fmtDate(vis.date) : '스냅샷 없음'}`,
    facts: [...v.facts.slice(0, 3), auditFact, p.facts[0], `AEO FAQ 게시 가능 ${cov.publishable}/${cov.total}개, 핵심 주제 ${cov.coreCovered}/${cov.coreTotal}개입니다.`].filter(Boolean),
    patterns: [...v.patterns, ...p.patterns],
    interpretation: [...v.interpretation, ...p.interpretation.slice(0, 1)],
    conditions: [...v.conditions, ...p.conditions],
    counter: [...v.counter],
    actions: [...v.actions.slice(0, 1), ...p.actions.slice(0, 1), audit && audit.counts.fail ? `담당 AE: 제품페이지 실패 ${audit.counts.fail}개 항목을 수정 요청하고 반영 다음 날 재진단합니다.` : ''].filter(Boolean),
  };
}
