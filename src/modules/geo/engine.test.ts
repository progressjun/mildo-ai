/**
 * SearchTuneOS · GEO 엔진 테스트 — 판정 규칙 · 경계값(빈 입력 · 0 나누기 · NaN) · 데모 시나리오 탐지.
 * 시나리오 탐지는 엔진이 데이터에서 계산한 결과를 검증하고, 데이터를 바꾸면 결과도 바뀌는지 함께 확인한다.
 */
import { describe, expect, it } from 'vitest';
import type { Dataset } from '@/core/types';
import { DEMO, generateDemoData } from '@/data/demo';
import { RFP } from '@/data/constants';
import { AUDIT_RULES, GEO_ENGINES, GEO_QUERIES, GEO_RULES, type GeoEngineDef, type GeoQuery } from './data';
import {
  auditBrief, auditHtml, auditMarkdown, auditPage, BRAND, buildFaqDraft, buildGeoSnapshot, caseMetrics, decodeEntities, demoCaseFromSnapshot,
  EMPTY_CASE, expectedSalePrice, extractPageFacts, faqBrief, faqCoverage, faqFromLd, faqJsonLd, geoOverallBrief, geoPrompt, geoRoundDates,
  isOwnedDomain, keywordShift, livePromotion, liveSummary, liveVerdict, paidBrief, paidSummary, paidSurfaceRows, parseAiAnswer, parseAttrs,
  parsePrice, productFromLd, queryVerdict, reviewFaq, reviewFaqItem, reviewLevelOf, reviewText, sampleProductHtml, sanitizeAiFaq, scoreChecks,
  visibilityBrief, visibilitySummary, type GeoSnapshot, type LiveRecord,
} from './engine';
import { dateLabel, findRegistration, keywordInfo, maskUrls, parseNumInput, registrationRequest, shiftCauses, visibilityMarkdown, visibilityRows } from './engine';
import { keywordAnomaly } from '@/modules/adpilot/engine';
import type { ChangeRequest } from '@/core/types';
import { COMPETITOR_COLOR } from './data';
import { CAUSE_CANDIDATES } from '@/data/constants';
import { seedChanges } from '@/modules/flow/engine';
import { addDays } from '@/core/util';

const fresh = (): Dataset => generateDemoData();
const empty = (): Dataset => ({
  generatedAt: '2026-10-31T15:30:00+09:00', today: '2026-10-31', currentHour: 15, dates: [],
  mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
});
const NO_BAD_TEXT = /NaN|undefined|Infinity/;
const NUMBERED = /^\s*\d+[.)]\s/m;
const briefText = (b: { facts: string[]; patterns: string[]; interpretation: string[]; conditions: string[]; counter: string[]; actions: string[] }) =>
  [b.facts, b.patterns, b.interpretation, b.conditions, b.counter, b.actions].flat().join('\n');
const check = (a: ReturnType<typeof auditHtml>, id: string) => a.checks.find((c) => c.id === id)!;
const page = (head: string, body: string) => `<!doctype html><html lang="ko"><head>${head}</head><body>${body}</body></html>`;

/* ------------------------------------------------------------------ */
describe('HTML 추출 (정규식 · DOM 없는 환경)', () => {
  it('결함 샘플에서 title · meta · canonical · h1 · img · JSON-LD · 화면 가격을 추출한다', () => {
    const f = extractPageFacts(sampleProductHtml(DEMO, 'defect'));
    expect(f.parser).toBe('regex');
    expect(f.title).toContain('수면밀도 매트리스');
    expect(f.metas.find((m) => m.key === 'description')).toBeUndefined();
    expect(f.metas.find((m) => m.key === 'og:title')?.content).toBe(DEMO.products[0].name);
    expect(f.canonical).toMatch(/^https:\/\/brand\.naver\.com\/mildo\/products\//);
    expect(f.h1).toHaveLength(2);
    expect(f.images).toHaveLength(6);
    expect(f.images.filter((i) => i.alt === null)).toHaveLength(2);
    expect(f.images.filter((i) => i.alt === '')).toHaveLength(1);
    expect(f.jsonLd).toHaveLength(1);
    expect(f.jsonLd[0].error).toBeNull();
    // 안쪽 요소(가격 박스 안 strong.sale-price · del.list-price)도 찾는다
    const sale = f.prices.find((p) => p.kind === 'sale');
    const list = f.prices.find((p) => p.kind === 'list');
    expect(sale?.value).toBe(841_500);
    expect(sale?.option).toBe('q');
    expect(list?.value).toBe(990_000);
    expect(f.prices.some((p) => p.value === 15)).toBe(false); // 할인율 15%는 가격이 아니다
    expect(f.text).toContain('통증 완화');
    expect(f.text).not.toContain('application/ld+json');
  });

  it('속성: 따옴표 안의 > · 엔티티 · 값 없는 alt · 홑따옴표', () => {
    const f = extractPageFacts(page('<title>A &amp; B</title>', `<img src="a.jpg" alt="수면밀도 > 단면"><img alt src='b.jpg'><img src=c.jpg alt='퀸 &quot;정면&quot;'>`));
    expect(f.title).toBe('A & B');
    expect(f.images.map((i) => i.alt)).toEqual(['수면밀도 > 단면', '', '퀸 "정면"']);
    expect(parseAttrs(' a="1" B=\'2\' c=3 d')).toEqual({ a: '1', b: '2', c: '3', d: '' });
    expect(decodeEntities('&#x2F;&#47;&lt;&middot;&unknown;')).toBe('//<·&unknown;');
  });

  it('빈 문자열 · 비정상 입력은 예외 없이 빈 결과', () => {
    for (const s of ['', '   ', '<<<>>>', 'plain text only', null as unknown as string]) {
      const f = extractPageFacts(s);
      expect(f.title).toBeNull();
      expect(f.images).toEqual([]);
      expect(f.jsonLd).toEqual([]);
    }
  });

  it('JSON-LD: 구문 오류 기록 · @graph · 배열 · AggregateOffer · 문자열 가격', () => {
    const bad = extractPageFacts(page('<script type="application/ld+json">{ "@type": "Product", </script>', ''));
    expect(bad.jsonLd[0].error).toBeTruthy();
    const graph = extractPageFacts(page(`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': ['Product', 'Thing'], name: 'X', brand: 'Y', offers: { '@type': 'AggregateOffer', lowPrice: '790,000', priceCurrency: 'KRW' }, aggregateRating: { ratingValue: '4.8', reviewCount: '120' } }] })}</script>`, ''));
    const p = productFromLd(graph.jsonLd)!;
    expect(p.name).toBe('X');
    expect(p.brand).toBe('Y');
    expect(p.offers[0].price).toBe(790_000);
    expect(p.rating).toEqual({ value: 4.8, count: 120 });
    const arr = extractPageFacts(page(`<script type="application/ld+json">${JSON.stringify([{ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q1', acceptedAnswer: { '@type': 'Answer', text: '<p>A1</p>' } }] }])}</script>`, ''));
    expect(faqFromLd(arr.jsonLd)).toEqual({ count: 1, items: [{ q: 'Q1', a: 'A1' }] });
  });

  it('큰 페이지 · 닫히지 않은 태그가 많아도 선형 시간에 끝난다', () => {
    const body = Array.from({ length: 6000 }, (_, i) => `<div class="item"><p>문단 ${i}<li>항목<span class="price">${(i + 1) * 1000}원</span>`).join('');
    const t0 = performance.now();
    const f = extractPageFacts(page('<title>수면밀도</title>', body));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(f.prices.length).toBe(6000);
  });

  it('parsePrice: 콤마 · 원 · 숫자 · 음수/빈 값', () => {
    expect(parsePrice('841,500원')).toBe(841_500);
    expect(parsePrice('KRW 990000')).toBe(990_000);
    expect(parsePrice(1190000)).toBe(1_190_000);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('가격 문의')).toBeNull();
    expect(parsePrice(NaN)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
describe('제품페이지 진단 — 데모 시나리오 (운영 데이터 대조)', () => {
  it('결함 샘플: 메타 · ALT · 가격 불일치 · 킹 품절 InStock · FAQ 없음 · 의료 효능 문구를 잡는다', () => {
    const a = auditHtml(sampleProductHtml(DEMO, 'defect'), DEMO);
    expect(a.score).toBeLessThan(AUDIT_RULES.scoreWarn);
    expect(a.grade.id).toBe('fail');
    expect(check(a, 'title').status).toBe('warn'); // 40자 초과
    expect(check(a, 'description').status).toBe('fail');
    expect(check(a, 'og').status).toBe('warn');
    expect(check(a, 'og').measured).toContain('og:image');
    expect(check(a, 'h1').status).toBe('warn');
    expect(check(a, 'img_alt').status).toBe('fail');
    expect(check(a, 'img_alt').measured).toContain('50%');
    expect(check(a, 'product_schema').status).toBe('pass');
    expect(check(a, 'rating').status).toBe('warn');
    // 화면 판매가(정가 × (1-15%)) ↔ JSON-LD 정가
    expect(check(a, 'price_match').status).toBe('fail');
    expect(check(a, 'price_match').measured).toContain('841,500원');
    expect(check(a, 'price_match').measured).toContain('990,000원');
    expect(check(a, 'data_price').status).toBe('fail');
    expect(check(a, 'data_price').basis).toContain('가을 이사 · 혼수 기획전');
    // 킹 옵션 품절(products[0].options k inStock=false) ↔ JSON-LD InStock
    expect(check(a, 'availability').status).toBe('fail');
    expect(check(a, 'availability').measured).toContain('킹');
    expect(check(a, 'faq_schema').status).toBe('fail');
    expect(check(a, 'topics').status).toBe('warn');
    expect(check(a, 'copy_review').status).toBe('fail');
    expect(a.review.some((h) => h.ruleId === 'medical_cure' && h.match.includes('통증'))).toBe(true);
    expect(a.review.some((h) => h.ruleId === 'superlative')).toBe(true);
    expect(a.matched).toMatchObject({ product: DEMO.products[0].name, channel: 'brandstore', promo: '가을 이사 · 혼수 기획전', discountRate: 15 });
  });

  it('개선안 샘플: 판매가 · 재고 · FAQ · 주제 · 검수 통과, 리뷰 평점만 실제 값 연동 전으로 개선 표시', () => {
    const a = auditHtml(sampleProductHtml(DEMO, 'fixed'), DEMO);
    expect(a.score).toBeGreaterThanOrEqual(AUDIT_RULES.scorePass);
    expect(a.grade.id).toBe('pass');
    const notPass = a.checks.filter((c) => c.status !== 'pass').map((c) => c.id);
    expect(notPass).toEqual(['rating']);
    expect(a.faq.count).toBe(reviewFaq(buildFaqDraft(DEMO)).filter((i) => i.publishable).length);
  });

  it('데이터를 바꾸면 판정이 바뀐다 (하드코딩 아님): 킹 재고 입고 · 프로모션 종료 · 할인율 변경', () => {
    const restock = fresh();
    restock.products[0].options.find((o) => o.id === 'k')!.inStock = true;
    expect(check(auditHtml(sampleProductHtml(restock, 'defect'), restock), 'availability').status).toBe('pass');

    const noPromo = fresh();
    noPromo.promotions = [];
    const a = auditHtml(sampleProductHtml(noPromo, 'defect'), noPromo);
    expect(check(a, 'price_match').status).toBe('pass');
    expect(check(a, 'data_price').status).toBe('pass');
    expect(check(a, 'data_price').basis).toContain('정가 기준');

    const deeper = fresh();
    deeper.promotions[0].discountRate = 20;
    expect(expectedSalePrice(990_000, livePromotion(deeper, 'brandstore'))).toBe(792_000);
    const d = auditHtml(sampleProductHtml(deeper, 'defect'), deeper);
    expect(check(d, 'data_price').measured).toContain('792,000원');
    expect(check(auditHtml(sampleProductHtml(deeper, 'fixed'), deeper), 'data_price').status).toBe('pass');
  });

  it('프로모션은 기준일(data.today)에 진행 중인 것만 적용 — 예정 · 종료 · 다른 채널 제외', () => {
    const d = fresh();
    expect(livePromotion(d, 'brandstore')?.id).toBe('promo_1'); // promo_3(11/11~)은 예정
    expect(livePromotion(d, 'ohouse')?.id).toBe('promo_2');
    expect(livePromotion(d, 'coupang')).toBeNull();
    expect(livePromotion(d, null)).toBeNull();
    d.today = '2026-11-05';
    expect(livePromotion(d, 'brandstore')).toBeNull();
  });

  it('판매 데이터가 없거나 상품이 다르면 대조 항목은 해당 없음(점수 제외)', () => {
    const html = sampleProductHtml(DEMO, 'defect');
    for (const data of [null, empty()]) {
      const a = auditHtml(html, data);
      expect(check(a, 'data_price').status).toBe('na');
      expect(check(a, 'availability').status).toBe('na');
      expect(Number.isFinite(a.score)).toBe(true);
    }
    const other = auditHtml(page('<title>다른 브랜드 소파 | 스토어</title>', `<script type="application/ld+json">{"@type":"Product","name":"소파","brand":"X","offers":{"price":"100000"}}</script><h1>소파</h1>`), DEMO);
    expect(check(other, 'data_price').status).toBe('na');
  });

  it('빈 HTML: 입력 필요 · 점수 0 · NaN 없음', () => {
    const a = auditHtml('', DEMO);
    expect(a.empty).toBe(true);
    expect(a.score).toBe(0);
    expect(a.grade.label).toBe('입력 필요');
    expect(a.checks.map((c) => c.measured + c.basis + c.fix).join('\n')).not.toMatch(NO_BAD_TEXT);
    expect(briefText(auditBrief(a))).not.toMatch(NO_BAD_TEXT);
  });

  it('경계값: 제목 길이 · ALT 누락률 · h1 · FAQ 문항 수', () => {
    const t = (title: string) => check(auditHtml(page(`<title>${title}</title>`, ''), null), 'title').status;
    expect(t(`수면밀도${'가'.repeat(AUDIT_RULES.titleMax - 4)}`)).toBe('pass'); // 정확히 max
    expect(t(`수면밀도${'가'.repeat(AUDIT_RULES.titleMax - 3)}`)).toBe('warn'); // max + 1
    expect(t(`수면밀도${'가'.repeat(AUDIT_RULES.titleMin - 4)}`)).toBe('pass'); // 정확히 min
    expect(t('가'.repeat(20))).toBe('warn'); // 브랜드명 없음
    const alt = (missing: number) => check(auditHtml(page('<title>x</title>', Array.from({ length: 10 }, (_, i) => (i < missing ? '<img src="a">' : '<img src="a" alt="수면밀도 퀸">')).join('')), null), 'img_alt').status;
    expect(alt(1)).toBe('pass'); // 10%
    expect(alt(3)).toBe('warn'); // 30%
    expect(alt(4)).toBe('fail');
    expect(check(auditHtml(page('<title>x</title>', '<p>이미지 없음</p>'), null), 'img_alt').status).toBe('na');
    expect(check(auditHtml(page('<title>x</title>', '<p>no h1</p>'), null), 'h1').status).toBe('fail');
    const faqHtml = (n: number) => page(`<script type="application/ld+json">${JSON.stringify({ '@type': 'FAQPage', mainEntity: Array.from({ length: n }, (_, i) => ({ '@type': 'Question', name: `Q${i}`, acceptedAnswer: { '@type': 'Answer', text: `A${i}` } })) })}</script>`, '');
    expect(check(auditHtml(faqHtml(AUDIT_RULES.faqMin), null), 'faq_schema').status).toBe('pass');
    expect(check(auditHtml(faqHtml(AUDIT_RULES.faqMin - 1), null), 'faq_schema').status).toBe('warn');
  });

  it('점수: 해당 없음 제외 가중 평균 · 빈 목록 0', () => {
    const c = (status: 'pass' | 'warn' | 'fail' | 'na', weight: number) => ({ id: status, axis: 'SEO' as const, label: '', status, weight, measured: '', basis: '', fix: '' });
    expect(scoreChecks([c('pass', 2), c('fail', 2)])).toBe(50);
    expect(scoreChecks([c('pass', 1), c('warn', 1), c('na', 10)])).toBe(75);
    expect(scoreChecks([])).toBe(0);
    expect(scoreChecks([c('na', 3)])).toBe(0);
  });

  it('진단 마크다운: 표 · 원칙 문구 · 번호 매기기 없음', () => {
    const md = auditMarkdown(auditHtml(sampleProductHtml(DEMO, 'defect'), DEMO), '샘플');
    expect(md).toContain('| 축 | 항목 | 판정 |');
    expect(md).toContain('노출 순위 보장이 아닌 정기 진단 · 개선 방식으로 운영합니다.');
    expect(md).not.toMatch(NUMBERED);
    expect(md).not.toMatch(NO_BAD_TEXT);
  });
});

/* ------------------------------------------------------------------ */
describe('표현 검수 (REVIEW_RULES)', () => {
  it('의료 효능 차단 · 최상급 경고 · 가격 확인 · 경쟁사 경고 · 통과', () => {
    expect(reviewLevelOf(reviewText('허리 통증 완화에 도움'))).toBe('block');
    expect(reviewLevelOf(reviewText('척추 교정 매트리스'))).toBe('block');
    expect(reviewLevelOf(reviewText('네이버 가구 부문 판매 1위'))).toBe('warn');
    expect(reviewLevelOf(reviewText('퀸 990,000원'))).toBe('check');
    expect(reviewText('지누스보다 단단한').map((h) => h.ruleId)).toContain('competitor');
    expect(reviewLevelOf(reviewText('경도 · 사이즈 · 소재 구조로 비교하세요'))).toBe('ok');
    expect(reviewText('')).toEqual([]);
    // 같은 표현은 한 번만
    expect(reviewText('1위 1위 1위').filter((h) => h.ruleId === 'superlative')).toHaveLength(1);
    // 수정 제안 포함
    expect(reviewText('통증 완화')[0].fix).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
describe('GEO 진단 스냅샷 · 가시성 집계', () => {
  const snap = buildGeoSnapshot(DEMO.today);

  it('정기 진단 회차: 기준일 이전 가장 가까운 월요일부터 주 단위 4회', () => {
    expect(geoRoundDates('2026-10-31')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(geoRoundDates('2026-10-26')[3]).toBe('2026-10-26');
    expect(geoRoundDates('bad')).toEqual([]);
    expect(geoRoundDates('2026-10-31', 0)).toEqual([]);
  });

  it('질의 15~20개 × 엔진 5개 × 4회 · 같은 기준일이면 같은 결과', () => {
    expect(GEO_QUERIES.length).toBeGreaterThanOrEqual(15);
    expect(GEO_QUERIES.length).toBeLessThanOrEqual(20);
    expect(GEO_ENGINES.map((e) => e.name)).toEqual(['ChatGPT', 'Gemini', 'Perplexity', '네이버 AI 브리핑', 'Google AI 개요']);
    expect(snap.rounds).toHaveLength(4);
    for (const r of snap.rounds) expect(r.cells).toHaveLength(GEO_QUERIES.length * GEO_ENGINES.length);
    expect(JSON.stringify(buildGeoSnapshot(DEMO.today))).toBe(JSON.stringify(snap));
    expect(GEO_QUERIES.map((q) => q.text)).toEqual(expect.arrayContaining(['허리 편한 매트리스 추천', '신혼 매트리스 추천', '매트리스 경도 고르는 법']));
  });

  it('셀 불변식: 언급 ⇔ 순서 ⇔ 등장 목록, 경쟁사는 RFP 6개사, 자사 인용 판정', () => {
    for (const r of snap.rounds) for (const c of r.cells) {
      expect(c.mentioned).toBe(c.position !== null);
      expect(c.mentioned).toBe(c.order.includes(BRAND));
      if (c.position !== null) expect(c.order.indexOf(BRAND) + 1).toBe(c.position);
      expect(c.order.filter((n) => n !== BRAND)).toEqual(c.competitors);
      for (const n of c.competitors) expect(RFP.competitors).toContain(n);
      for (const x of c.citations) expect(x.owned).toBe(isOwnedDomain(x.domain));
    }
  });

  it('집계 = 셀 수동 계산 (언급률 · 점유 · 판정 · 경쟁사 우위 기준)', () => {
    const vis = visibilitySummary(snap);
    const cells = snap.rounds[3].cells;
    const m = cells.filter((c) => c.mentioned).length;
    const comp = cells.reduce((a, c) => a + c.competitors.length, 0);
    expect(vis.date).toBe('2026-10-26');
    expect(vis.overall.mentioned).toBe(m);
    expect(vis.overall.rate).toBeCloseTo(m / cells.length, 10);
    expect(vis.overall.sov).toBeCloseTo(m / (m + comp), 10);
    expect(vis.overall.covered + vis.overall.partial + vis.overall.none).toBe(GEO_QUERIES.length);
    for (const e of vis.engines) {
      const ec = cells.filter((c) => c.engine === e.id);
      expect(e.rate).toBeCloseTo(ec.filter((c) => c.mentioned).length / ec.length, 10);
    }
    for (const q of vis.queries) {
      const qc = cells.filter((c) => c.queryId === q.query.id);
      const me = qc.filter((c) => c.mentioned).length;
      const ce = qc.filter((c) => c.competitors.length > 0).length;
      expect(q.mentionedEngines).toBe(me);
      expect(q.gap).toBe(ce >= GEO_RULES.gapCompetitorEngines && me <= GEO_RULES.gapBrandMax);
      expect(q.status.id).toBe(me >= GEO_RULES.coveredEngines ? 'covered' : me > 0 ? 'partial' : 'none');
      expect(q.status.basis).toMatch(/기준 ≥3/);
    }
    expect(vis.gaps.every((g) => g.gap)).toBe(true);
    const prev = snap.rounds[2].cells.filter((c) => c.mentioned).length / cells.length;
    expect(vis.overall.deltaPp).toBeCloseTo((m / cells.length - prev) * 100, 10);
    expect(vis.stability.stable + vis.stability.volatile + vis.stability.never).toBe(GEO_QUERIES.length * GEO_ENGINES.length);
  });

  it('데모 가정: 브랜드 방어 질의 언급률이 가장 높고, 네이버 AI 브리핑이 엔진 중 가장 높다 (네이버 판매 1위 브랜드)', () => {
    const vis = visibilitySummary(snap);
    const brand = vis.byIntent.find((b) => b.intent === 'brand')!;
    for (const b of vis.byIntent) expect(brand.rate).toBeGreaterThanOrEqual(b.rate);
    const top = vis.engines.slice().sort((a, b) => b.rate - a.rate)[0];
    expect(top.id).toBe('naver_ai');
    expect(vis.gaps.length).toBeGreaterThan(0);
  });

  it('직접 만든 스냅샷: 순서 · 경쟁사보다 먼저 · 안정성을 정확히 계산', () => {
    const qs: GeoQuery[] = [{ id: 'a', text: 'A', intent: 'compare', qMult: 1, topics: [] }, { id: 'b', text: 'B', intent: 'life', qMult: 1, topics: [] }];
    const es: GeoEngineDef[] = GEO_ENGINES.slice(0, 2);
    const cell = (queryId: string, engine: 'chatgpt' | 'gemini', order: string[]) => ({
      queryId, engine, mentioned: order.includes(BRAND), position: order.includes(BRAND) ? order.indexOf(BRAND) + 1 : null, order,
      competitors: order.filter((n) => n !== BRAND), citations: [{ domain: 'mildo.kr', owned: true }, { domain: 'blog.naver.com', owned: false }],
    });
    const s: GeoSnapshot = {
      kind: 'DEMO', queries: qs, engines: es,
      rounds: [
        { index: 0, date: '2026-10-19', cells: [cell('a', 'chatgpt', [BRAND]), cell('a', 'gemini', []), cell('b', 'chatgpt', ['지누스']), cell('b', 'gemini', [])] },
        { index: 1, date: '2026-10-26', cells: [cell('a', 'chatgpt', ['지누스', BRAND]), cell('a', 'gemini', [BRAND, '휴도']), cell('b', 'chatgpt', ['지누스']), cell('b', 'gemini', ['퀵슬립'])] },
      ],
    };
    const v = visibilitySummary(s);
    expect(v.overall.mentioned).toBe(2);
    expect(v.overall.rate).toBe(0.5);
    expect(v.overall.avgPosition).toBe(1.5);
    expect(v.overall.firstRate).toBe(0.5);
    expect(v.overall.sov).toBeCloseTo(2 / (2 + 4), 10);
    expect(v.overall.ownedCitations).toBe(4);
    expect(v.overall.ownedShare).toBe(0.5);
    expect(v.competitors.find((c) => c.name === '지누스')).toMatchObject({ mentions: 2, aheadOfBrand: 1, engines: 1 });
    expect(v.queries[0].status.id).toBe('covered'); // 엔진 2개 → 기준 min(3, 2) = 2
    expect(v.queries[1].status.id).toBe('none');
    expect(v.queries[1].gap).toBe(false); // 경쟁사 2/2 < 3
    expect(v.stability).toMatchObject({ rounds: 2, stable: 1 }); // a·chatgpt 2/2회
    expect(v.overall.deltaPp).toBeCloseTo((0.5 - 0.25) * 100, 10);
  });

  it('빈 스냅샷: 데이터 없음 · 0 나누기 없음 · 브리프 NaN 없음', () => {
    const none: GeoSnapshot = { kind: 'DEMO', rounds: [], queries: GEO_QUERIES, engines: GEO_ENGINES };
    const v = visibilitySummary(none);
    expect(v.hasData).toBe(false);
    expect(v.overall.rate).toBe(0);
    expect(v.overall.sov).toBe(0);
    expect(v.engines.every((e) => e.rate === 0)).toBe(true);
    expect(briefText(visibilityBrief(v))).not.toMatch(NO_BAD_TEXT);
    expect(visibilitySummary(buildGeoSnapshot('bad-date')).hasData).toBe(false);
    expect(queryVerdict(0, 0).id).toBe('na');
  });
});

/* ------------------------------------------------------------------ */
describe('라이브 진단 (Claude 답변 파싱)', () => {
  it('브랜드 순서 · 경쟁사 표기 변형 · 기타 브랜드 · 인용 URL (자사 판정)', () => {
    const r = parseAiAnswer('허리 편한 매트리스로는 Zinus, 수면밀도, 시몬스를 많이 비교합니다. 참고: https://brand.naver.com/mildo/products/1 , https://www.youtube.com/watch?v=1 그리고 www.mildo.kr 안내.');
    expect(r.mentioned).toBe(true);
    expect(r.order).toEqual(['지누스', BRAND, '시몬스']);
    expect(r.position).toBe(2);
    expect(r.competitors).toEqual(['지누스']);
    expect(r.others).toEqual(['시몬스']);
    expect(r.citations).toEqual([
      { domain: 'brand.naver.com/mildo', owned: true },
      { domain: 'youtube.com', owned: false },
      { domain: 'mildo.kr', owned: true },
    ]);
    expect(r.excerpt).toContain(BRAND);
    expect(liveVerdict(r).label).toBe('언급 · 2번째');
  });

  it("'밀도 매트리스'는 언급, '고밀도 폼 · 밀도가 높은'은 소재, 단독 '밀도'는 확인 필요", () => {
    expect(parseAiAnswer('밀도 매트리스는 경도 선택지가 있습니다').mentioned).toBe(true);
    const mat = parseAiAnswer('고밀도 폼은 밀도가 높은 소재로 꺼짐이 적습니다');
    expect(mat.mentioned).toBe(false);
    expect(mat.ambiguous).toBe(0);
    const amb = parseAiAnswer('밀도 제품도 후보로 볼 수 있습니다');
    expect(amb.mentioned).toBe(false);
    expect(amb.ambiguous).toBe(1);
    expect(liveVerdict(amb).id).toBe('ambiguous');
  });

  it('빈 답변 · 미언급 · 미진단', () => {
    const e = parseAiAnswer('');
    expect(e).toMatchObject({ mentioned: false, position: null, order: [], citations: [], chars: 0 });
    const no = parseAiAnswer('베스트슬립과 퀵슬립이 자주 언급됩니다.');
    expect(no.competitors).toEqual(['베스트슬립', '퀵슬립']);
    expect(liveVerdict(no).id).toBe('absent');
    expect(liveVerdict(null).id).toBe('none');
    const s = liveSummary([]);
    expect(s).toMatchObject({ count: 0, mentioned: 0, rate: 0 });
    expect(Number.isNaN(s.avgPosition)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('페이드 AI 지면 → SA 키워드 — 데모 시나리오', () => {
  const snap = buildGeoSnapshot(DEMO.today);
  const rows = paidSurfaceRows(DEMO, snap);
  const row = (text: string) => rows.find((r) => r.query.text === text)!;

  it("'킹 매트리스 추천': 킹 옵션 품절 + 키워드 랜딩 = 상품 상세 → 랜딩 점검 우선 (데이터를 바꾸면 해제)", () => {
    const r = row('킹 매트리스 추천');
    expect(r.kw?.text).toBe('킹 매트리스');
    expect(r.kw?.soldOutOption).toBe('킹');
    expect(r.action.id).toBe('landing');
    expect(r.signals.map((s) => s.id)).toContain('soldout');
    const d = fresh();
    d.products[0].options.find((o) => o.id === 'k')!.inStock = true;
    expect(paidSurfaceRows(d, snap).find((x) => x.query.text === '킹 매트리스 추천')!.action.id).not.toBe('landing');
  });

  it("'매트리스 추천': 최근 3일 CPC 급등(±50% 이상) → 자동 조정 보류 유지", () => {
    const r = row('매트리스 추천');
    expect(r.kw?.cpcChangePct).toBeGreaterThan(50);
    expect(r.action.id).toBe('hold');
    expect(r.action.basis).toMatch(/기준 ±50%/);
    // 다른 키워드는 급변 아님
    const k = DEMO.keywords.find((x) => x.text === '퀸 매트리스')!;
    expect(Math.abs(keywordShift(k).cpcChangePct)).toBeLessThan(50);
  });

  it('검색어 보고서 미등록 · 전환 발생 구문형 → SA 테스트 그룹 등록 후보 (등록되면 해제)', () => {
    const reg = rows.filter((r) => r.action.id === 'register');
    expect(reg.length).toBeGreaterThanOrEqual(3);
    for (const r of reg) {
      expect(r.term?.registered).toBe(false);
      expect(r.term!.conversions).toBeGreaterThan(0);
      expect(r.requestable).toBe(true);
    }
    expect(reg.map((r) => r.term?.term)).toContain('매트리스 경도 고르는 법');
    // 이미 등록된 검색어('신혼 매트리스 사이즈')는 후보가 아니다
    expect(row('신혼집 매트리스 사이즈').action.id).not.toBe('register');
    const d = fresh();
    d.searchTerms.find((t) => t.term === '매트리스 경도 고르는 법')!.registered = true;
    expect(paidSurfaceRows(d, snap).find((x) => x.query.text === '매트리스 경도 고르는 법')!.action.id).not.toBe('register');
  });

  it('판정 근거에 기준값(목표 ROAS · 브랜드 800%)이 붙는다', () => {
    for (const r of rows) expect(r.action.basis.length).toBeGreaterThan(4);
    const brand = rows.find((r) => r.kw?.isBrand);
    expect(brand?.kw?.targetRoas).toBe(800);
    const defend = rows.filter((r) => r.action.id === 'defend');
    for (const r of defend) {
      expect(r.naverAi?.mentioned).toBe(false);
      expect(r.kw!.roasRatio).toBeGreaterThanOrEqual(1);
      expect(r.action.basis).toMatch(/목표 400% 대비/);
    }
    const s = paidSummary(rows);
    expect(s.total).toBe(GEO_QUERIES.length);
    expect(s.register + s.landing + s.hold + s.defend + s.review + s.content + s.lab + s.keep).toBe(s.total);
  });

  it('빈 데이터 · 짧은 일자 데이터: 예외 없음 · NaN 문구 없음', () => {
    const e = paidSurfaceRows(empty(), snap);
    expect(e).toHaveLength(GEO_QUERIES.length);
    expect(e.every((r) => r.kw === null && r.term === null)).toBe(true);
    expect(e.map((r) => r.action.basis + r.action.label + r.signals.map((s) => s.basis).join()).join('\n')).not.toMatch(NO_BAD_TEXT);
    const k = { ...DEMO.keywords[0], daily: DEMO.keywords[0].daily.slice(0, 3) };
    expect(Number.isNaN(keywordShift(k).cpcChangePct)).toBe(true);
    const zero = { ...DEMO.keywords[0], daily: DEMO.keywords[0].daily.map((x) => ({ ...x, clicks: 0, cost: 0, conversions: 0 })) };
    expect(() => keywordShift(zero)).not.toThrow();
    expect(briefText(paidBrief(e))).not.toMatch(NO_BAD_TEXT);
  });
});

/* ------------------------------------------------------------------ */
describe('AEO FAQ 생성 · 검수 · JSON-LD', () => {
  const items = reviewFaq(buildFaqDraft(DEMO));

  it('경도 · 소재 · 사이즈 · 선택 기준 4개 주제를 모두 포함하고, 사이즈 · 정가는 운영 데이터에서 온다', () => {
    for (const t of ['hardness', 'material', 'size', 'criteria']) expect(items.some((i) => i.topic === t)).toBe(true);
    const size = items.find((i) => i.id === 'f_size_1')!;
    expect(size.a).toContain('슈퍼싱글 790,000원');
    expect(size.a).toContain('킹 1,190,000원');
    const d = fresh();
    d.products[0].options[0].price = 777_000;
    expect(buildFaqDraft(d).find((i) => i.id === 'f_size_1')!.a).toContain('777,000원');
    expect(buildFaqDraft(empty()).find((i) => i.id === 'f_size_1')!.a).toContain('[사이즈 · 정가 입력]');
  });

  it('규칙 초안에는 의료 효능 차단 문구가 없고, 출처 없는 순위 · 미입력 사양은 게시 보류', () => {
    expect(items.filter((i) => i.level === 'block')).toEqual([]);
    const brand = items.find((i) => i.id === 'f_brand_1')!;
    expect(brand.level).toBe('warn');
    expect(brand.publishable).toBe(false);
    expect(items.find((i) => i.id === 'f_hard_1')!.status.id).toBe('input');
    expect(items.find((i) => i.id === 'f_size_1')!.status.id).toBe('check');
    expect(items.find((i) => i.id === 'f_size_1')!.publishable).toBe(true);
    expect(items.filter((i) => i.publishable).length).toBeGreaterThanOrEqual(AUDIT_RULES.faqMin);
  });

  it('편집으로 의료 효능 표현을 넣으면 차단 · JSON-LD에서 제외', () => {
    const edited = reviewFaqItem({ ...buildFaqDraft(DEMO)[1], a: '허리 통증 완화에 효과적인 경도입니다.', source: 'edited' });
    expect(edited.level).toBe('block');
    expect(edited.status.label).toBe('차단');
    expect(edited.publishable).toBe(false);
    const ld = faqJsonLd([edited, ...items.filter((i) => i.id !== edited.id)], true);
    expect(JSON.parse(ld.json).mainEntity.some((q: { acceptedAnswer: { text: string } }) => q.acceptedAnswer.text.includes('통증'))).toBe(false);
  });

  it('FAQPage JSON-LD: 유효 JSON · 게시 가능 문항 수 · 전체 포함 토글 · 빈 문항 제외', () => {
    const pub = faqJsonLd(items, true);
    const doc = JSON.parse(pub.json);
    expect(doc['@type']).toBe('FAQPage');
    expect(doc.mainEntity).toHaveLength(items.filter((i) => i.publishable).length);
    expect(pub.included + pub.excluded).toBe(items.length);
    expect(faqJsonLd(items, false).included).toBe(items.length);
    const blank = reviewFaqItem({ id: 'x', topic: 'size', q: '', a: '', source: 'edited', queries: [] });
    expect(blank.publishable).toBe(false);
    expect(faqJsonLd([blank], false).included).toBe(0);
    expect(JSON.parse(faqJsonLd([], true).json).mainEntity).toEqual([]);
  });

  it('약한 질의 대응: 대응 · 초안만 · 대응 없음 합 = 약한 질의 수', () => {
    const vis = visibilitySummary(buildGeoSnapshot(DEMO.today));
    const cov = faqCoverage(items, vis);
    expect(cov.covered.length + cov.drafted.length + cov.uncovered.length).toBe(cov.weak.length);
    expect(cov.weak.length).toBe(vis.queries.filter((q) => q.gap || q.status.id !== 'covered').length);
    expect(cov.coreCovered).toBe(4);
  });

  it('AI 응답 정리: {items} · 배열 · 주제 라벨 · 잘못된 항목 제거', () => {
    expect(sanitizeAiFaq({ items: [{ topic: '경도', q: '경도?', a: '답' }, { topic: 'size', question: '사이즈?', answer: '답' }, { q: '', a: 'x' }, 3, null] })
      .map((i) => [i.topic, i.source])).toEqual([['hardness', 'ai'], ['size', 'ai']]);
    expect(sanitizeAiFaq([{ topic: '알 수 없음', q: 'Q', a: 'A' }])[0].topic).toBe('criteria');
    expect(sanitizeAiFaq('garbage')).toEqual([]);
    expect(sanitizeAiFaq(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
describe('진단 전후 지표 (p.29 공란)', () => {
  it('언급률 pp · 인용 수 증감 · 미입력 표시', () => {
    const m = caseMetrics({ brand: '수면밀도', beforeLabel: '2026-03', afterLabel: '2026-06', engines: '5개 엔진', beforeRate: 32, afterRate: 41.5, beforeCites: 12, afterCites: 18 });
    expect(m.complete).toBe(true);
    expect(m.rateDeltaPp).toBeCloseTo(9.5, 10);
    expect(m.citeDelta).toBe(6);
    expect(m.citeDeltaPct).toBeCloseTo(50, 10);
    expect(m.text).toContain('32% → 41.5% (+9.5pp)');
    expect(m.text).toContain('12건 → 18건 (+6건, +50.0%)');
    const e = caseMetrics(EMPTY_CASE);
    expect(e.complete).toBe(false);
    expect(e.missing).toHaveLength(5);
    expect(e.text).toContain('[브랜드]');
    expect(e.text).toContain('[입력]');
    expect(e.text).not.toMatch(NO_BAD_TEXT);
    expect(caseMetrics({ ...EMPTY_CASE, brand: 'x', beforeCites: 0, afterCites: 5 }).citeDeltaPct).toBeNull();
    expect(caseMetrics({ ...EMPTY_CASE, beforeRate: NaN as unknown as number }).rateDeltaPp).toBeNull();
  });

  it('범위 점검: 언급률 0~100% · 인용 수 0 이상 정수가 아니면 완료로 보지 않는다', () => {
    const ok = { brand: 'A', beforeLabel: '', afterLabel: '', engines: '', beforeRate: 0, afterRate: 100, beforeCites: 0, afterCites: 3 };
    expect(caseMetrics(ok)).toMatchObject({ complete: true, invalid: [] });
    const bad = caseMetrics({ ...ok, afterRate: 140, beforeCites: -2, afterCites: 2.5 });
    expect(bad.complete).toBe(false);
    expect(bad.invalid).toEqual(['진단 후 언급률(0~100%)', '진단 전 인용 수(0 이상 정수)', '진단 후 인용 수(0 이상 정수)']);
  });

  it('범위를 벗어난 값은 변화량 · 삽입 문구에 쓰지 않고 [범위 확인]으로 표시 (회귀: 140% · -2건이 문구에 그대로 들어가던 문제)', () => {
    const bad = caseMetrics({ brand: 'A', beforeLabel: '', afterLabel: '', engines: '', beforeRate: 41.5, afterRate: 140, beforeCites: -2, afterCites: 5 });
    expect(bad.rateDeltaPp).toBeNull();
    expect(bad.citeDelta).toBeNull();
    expect(bad.citeDeltaPct).toBeNull();
    expect(bad.text).toContain('41.5% → [범위 확인]');
    expect(bad.text).toContain('[범위 확인] → 5건');
    expect(bad.text).not.toMatch(/140|-2건|pp\)/);
    // 경계값 0 · 100 은 정상
    const edge = caseMetrics({ brand: 'A', beforeLabel: '', afterLabel: '', engines: '', beforeRate: 0, afterRate: 100, beforeCites: 0, afterCites: 0 });
    expect(edge.text).toContain('0% → 100% (+100.0pp)');
    expect(edge.text).toContain('0건 → 0건 (0건)');
    // 큰 인용 수는 천 단위 구분 (제안서 삽입 문구)
    const big = caseMetrics({ brand: 'A', beforeLabel: '', afterLabel: '', engines: '', beforeRate: 10, afterRate: 20, beforeCites: 1000, afterCites: 12000 });
    expect(big.text).toContain('인용 수 1,000건 → 12,000건 (+11,000건, +1100.0%)');
  });

  it('숫자 입력 파싱: 소수점 입력 중 · 콤마 · 단위 · 빈 값 · 비수치', () => {
    expect(parseNumInput('41.')).toBe(41);
    expect(parseNumInput('41.5')).toBe(41.5);
    expect(parseNumInput('1,234건')).toBe(1234);
    expect(parseNumInput(' 37 % ')).toBe(37);
    expect(parseNumInput('')).toBeNull();
    expect(parseNumInput('-')).toBeNull();
    expect(parseNumInput('abc')).toBeNull();
  });

  it('데모 스냅샷 값 채우기 = 첫 회차 vs 최신 회차 (TEST DATA 표기)', () => {
    const snap = buildGeoSnapshot(DEMO.today);
    const c = demoCaseFromSnapshot(snap);
    expect(c.beforeLabel).toBe('2026-10-05');
    expect(c.afterLabel).toBe('2026-10-26');
    expect(c.demo).toBe(true);
    // 삽입 문구 자체에 TEST DATA 표기 — 측정 범위 칸을 고쳐도 사라지지 않는다
    expect(caseMetrics(c).text).toContain('TEST DATA');
    expect(caseMetrics({ ...c, engines: '직접 입력' }).text).toContain('TEST DATA');
    expect(caseMetrics({ ...c, demo: false }).text).not.toContain('TEST DATA');
    expect(c.beforeRate).toBeCloseTo(visibilitySummary(snap, 0).overall.rate * 100, 1);
    expect(c.afterCites).toBe(visibilitySummary(snap).overall.ownedCitations);
    expect(demoCaseFromSnapshot({ kind: 'DEMO', rounds: [], queries: [], engines: [] })).toEqual(EMPTY_CASE);
  });
});

/* ------------------------------------------------------------------ */
describe('브리프 · 프롬프트 (출력 규칙)', () => {
  it('데모 · 빈 데이터 모두: 내용 있음 · 번호 매기기 없음 · NaN/undefined 없음', () => {
    for (const data of [DEMO, empty()]) {
      const snap = buildGeoSnapshot(data.today);
      const vis = visibilitySummary(snap);
      const audit = auditHtml(sampleProductHtml(data, 'defect'), data);
      const rows = paidSurfaceRows(data, snap);
      const faq = reviewFaq(buildFaqDraft(data));
      const live: LiveRecord[] = [{ ...parseAiAnswer('수면밀도와 지누스'), queryId: 'q01', query: '수면밀도 매트리스 후기', at: '2026-10-31T06:30:00Z', backend: 'artifact' }];
      for (const b of [visibilityBrief(vis, live), auditBrief(audit), faqBrief(faq, vis), paidBrief(rows), geoOverallBrief(vis, audit, rows, faq, live)]) {
        const t = briefText(b);
        expect(b.title).toBeTruthy();
        expect(b.facts.length + b.patterns.length + b.interpretation.length).toBeGreaterThan(0);
        expect(t).not.toMatch(NUMBERED);
        expect(t).not.toMatch(NO_BAD_TEXT);
      }
      const p = geoPrompt(vis, audit, rows, live);
      expect(p).toContain('노출 순위를 보장하는 표현은 쓰지 않는다');
      expect(p.length).toBeLessThan(30_000);
    }
  });

  it('GEO 브리프는 TEST DATA 표기 · 기준값 · 반례를 포함한다', () => {
    const b = visibilityBrief(visibilitySummary(buildGeoSnapshot(DEMO.today)));
    expect(b.facts.join(' ')).toContain('TEST DATA');
    expect(b.conditions.join(' ')).toContain('온보딩 중 확정');
    expect(b.counter.length).toBeGreaterThan(0);
    expect(b.actions.join(' ')).toMatch(/담당 AE|PM/);
  });
});

/* ------------------------------------------------------------------ */
describe('성과 급변 원인 후보 (CAUSE_CANDIDATES) — 데이터 근거 순위', () => {
  const kwOf = (d: Dataset, text: string) => keywordInfo(d, d.keywords.find((k) => k.text === text)!);

  it("'매트리스 추천': CPC 급등 · 클릭 유지 → '경쟁사 입찰 상승'이 1순위, 보류 판정 상세에 근거와 함께 표시", () => {
    const kw = kwOf(DEMO, '매트리스 추천');
    expect(Math.abs(kw.clicksChangePct)).toBeLessThanOrEqual(20);
    const causes = shiftCauses(DEMO, kw);
    expect(causes.map((c) => c.label).sort()).toEqual([...CAUSE_CANDIDATES].sort());
    expect(causes[0].label).toBe('경쟁사 입찰 상승');
    expect(causes[0].score).toBeGreaterThanOrEqual(60);
    expect(causes[0].basis).toMatch(/CPC \+\d+%/);
    for (let i = 1; i < causes.length; i++) expect(causes[i - 1].score).toBeGreaterThanOrEqual(causes[i].score);
    const row = paidSurfaceRows(DEMO, buildGeoSnapshot(DEMO.today)).find((r) => r.query.text === '매트리스 추천')!;
    expect(row.causes[0].label).toBe('경쟁사 입찰 상승');
    expect(row.action.detail).toContain('경쟁사 입찰 상승');
    expect(row.action.basis).toMatch(/전환 [-−]\d+%/);
  });

  it('급변 신호가 없는 키워드는 원인 후보 없음 · NaN 입력도 빈 목록', () => {
    expect(shiftCauses(DEMO, kwOf(DEMO, '퀸 매트리스'))).toEqual([]);
    expect(shiftCauses(DEMO, { cpcChangePct: NaN, convChangePct: NaN, clicksChangePct: NaN, soldOutOption: null, landing: '' })).toEqual([]);
    expect(shiftCauses(empty(), { cpcChangePct: 80, convChangePct: NaN, clicksChangePct: NaN, soldOutOption: null, landing: '' })[0].label).toBe('경쟁사 입찰 상승');
  });

  it('데이터를 바꾸면 순위가 바뀐다: 클릭 급감 → 집계 지연 · 최근 3일 프로모션 시작 → 프로모션 변경 근거', () => {
    const d = fresh();
    const k = d.keywords.find((x) => x.text === '매트리스 추천')!;
    // 최근 3일 클릭 · 비용 · 전환을 80% 줄이면 CPC는 그대로, 클릭 급감 패턴
    k.daily = k.daily.map((r, i) => (i >= k.daily.length - 3 ? { ...r, clicks: Math.round(r.clicks * 0.2), cost: Math.round((r.cost / 1.7) * 0.2), conversions: r.conversions * 0.2, revenue: r.revenue * 0.2 } : r));
    const causes = shiftCauses(d, keywordInfo(d, k));
    expect(causes[0].label).toBe('매체 장애 · 집계 지연');
    const base = kwOf(DEMO, '매트리스 추천');
    const d2 = fresh();
    d2.promotions.push({ id: 'p_new', name: '테스트 기획전', channel: 'brandstore', start: addDays(d2.today, -1), end: addDays(d2.today, 5), discountRate: 10, status: 'live' });
    const promo = shiftCauses(d2, { ...base, landing: 'https://brand.naver.com/mildo/products' }).find((c) => c.label === '가격 · 프로모션 변경')!;
    expect(promo.score).toBe(45);
    expect(promo.basis).toContain('테스트 기획전 시작');
  });
});

/* ------------------------------------------------------------------ */
describe('표시 규칙 · 내보내기', () => {
  it('경쟁사 색은 RFP 6개사에 고정 (중복 없음 · accent/핑크 계열 미사용)', () => {
    expect(Object.keys(COMPETITOR_COLOR).sort()).toEqual([...RFP.competitors].sort());
    const colors = Object.values(COMPETITOR_COLOR);
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain('--accent');
    expect(colors).not.toContain('--series-5');
  });

  it('화면 가격 측정값은 옵션 id가 아니라 옵션명으로 표시', () => {
    const a = auditHtml(sampleProductHtml(DEMO, 'defect'), DEMO);
    const m = check(a, 'price_match').measured;
    expect(m).toContain('(퀸)');
    expect(m).not.toContain('(q)');
  });

  it('정기 진단 마크다운 · CSV 행: TEST DATA/LIVE 구분 · 질의 수 · 번호 매기기 · NaN 없음', () => {
    const vis = visibilitySummary(buildGeoSnapshot(DEMO.today));
    const live: LiveRecord = { ...parseAiAnswer('수면밀도와 지누스를 비교하면'), queryId: 'q14', query: '매트리스 추천', at: '2026-10-31T15:00:00Z', backend: 'artifact' };
    const md = visibilityMarkdown(vis, { q14: live });
    expect(md).toContain('TEST DATA');
    expect(md).toContain('Claude (LIVE)');
    expect(md).toContain('노출 순위 보장이 아닌 정기 진단 · 개선 방식으로 운영합니다.');
    expect(md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 질의') && !l.startsWith('| ---'))).toHaveLength(vis.queries.length);
    expect(md).not.toMatch(NUMBERED);
    expect(md).not.toMatch(NO_BAD_TEXT);
    const rows = visibilityRows(vis, { q14: live });
    expect(rows).toHaveLength(vis.queries.length);
    expect(rows.find((r) => r.질의 === '매트리스 추천')!['Claude(LIVE)']).toBe('1번째');
    expect(rows.find((r) => r.질의 !== '매트리스 추천')!['Claude(LIVE)']).toBe('미진단');
    expect(JSON.stringify(rows)).not.toMatch(NO_BAD_TEXT);
    const emptyVis = visibilitySummary({ kind: 'DEMO', rounds: [], queries: GEO_QUERIES, engines: GEO_ENGINES });
    expect(visibilityMarkdown(emptyVis)).toContain('진단 스냅샷이 없습니다');
    expect(visibilityRows(emptyVis).every((r) => r.판정 === '데이터 없음')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('성과 급변 판정 — 표본 기준 · AD Pilot과 같은 판정', () => {
  const snap = buildGeoSnapshot(DEMO.today);

  it('데모 키워드 전체: 급변 판정 · CPC 변화율이 AD Pilot keywordAnomaly와 같다 (같은 숫자 · 같은 기준)', () => {
    for (const k of DEMO.keywords) {
      const g = keywordShift(k);
      const a = keywordAnomaly(k, DEMO);
      expect(g.triggered, k.text).toBe(a.triggered);
      if (Number.isFinite(a.cpcDelta)) expect(g.cpcChangePct, k.text).toBeCloseTo(a.cpcDelta, 6);
      if (Number.isFinite(a.convDelta)) expect(g.convChangePct, k.text).toBeCloseTo(a.convDelta, 6);
    }
    expect(DEMO.keywords.filter((k) => keywordShift(k).triggered).map((k) => k.text)).toEqual(['매트리스 추천']);
  });

  it("표본 부족 전환 급등('통기성 좋은 매트리스' 전환 +80%대)은 급변이 아니며 원인 후보도 만들지 않는다", () => {
    const k = DEMO.keywords.find((x) => x.text === '통기성 좋은 매트리스')!;
    const sh = keywordShift(k);
    expect(Math.abs(sh.convChangePct)).toBeGreaterThanOrEqual(50);
    expect(sh.convEligible).toBe(false);
    expect(sh.triggered).toBe(false);
    expect(sh.basis).toContain('표본 부족');
    const row = paidSurfaceRows(DEMO, snap).find((r) => r.kw?.text === '통기성 좋은 매트리스')!;
    expect(row.causes).toEqual([]);
    expect(row.signals.map((s) => s.id)).not.toContain('shift');
    expect(row.action.id).not.toBe('hold');
  });

  it('전환만 급락(클릭 · CPC 유지)해도 보류 — 원인 후보 1순위는 랜딩 오류 · 품절 (기대 전환 1건 미만이면 판정 안 함)', () => {
    const d = fresh();
    const thin = d.keywords.find((x) => x.text === '퀸 매트리스')!;
    thin.daily = thin.daily.map((r, i) => (i >= thin.daily.length - 3 ? { ...r, conversions: 0, revenue: 0 } : r));
    expect(keywordShift(thin).expectedConv).toBeLessThan(1);
    expect(keywordShift(thin).triggered).toBe(false);
    const k = d.keywords.find((x) => x.text === '밀도매트리스 후기')!;
    k.daily = k.daily.map((r, i) => (i >= k.daily.length - 3 ? { ...r, conversions: r.conversions * 0.3, revenue: r.revenue * 0.3 } : r));
    const sh = keywordShift(k);
    expect(sh.cpcHit).toBe(false);
    expect(sh.convHit).toBe(true);
    expect(sh.triggered).toBe(true);
    const row = paidSurfaceRows(d, snap).find((r) => r.kw?.text === '밀도매트리스 후기')!;
    expect(row.action.id).toBe('hold');
    expect(row.action.basis).toMatch(/전환 -\d+%/);
    expect(row.signals.find((s) => s.id === 'shift')?.label).toContain('전환');
    expect(row.causes[0].label).toBe('랜딩 오류 · 품절');
    expect(keywordAnomaly(k, d).triggered).toBe(true);
  });

  it('최근 3일 노출 0 → 수집 데이터 이상으로 보류', () => {
    const d = fresh();
    const k = d.keywords.find((x) => x.text === '신혼 매트리스')!;
    k.daily = k.daily.map((r, i) => (i >= k.daily.length - 3 ? { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 } : r));
    const sh = keywordShift(k);
    expect(sh.collection).toBe(true);
    expect(sh.triggered).toBe(true);
    expect(sh.basis).toContain('노출 0');
    const row = paidSurfaceRows(d, snap).find((r) => r.kw?.text === '신혼 매트리스')!;
    expect(row.action.id).toBe('hold');
    expect(row.signals.find((s) => s.id === 'shift')?.label).toContain('수집 데이터 이상');
  });

  it('비정상 값(음수 · NaN)이 섞여도 예외 없이 수집 이상으로 판정', () => {
    const k = { ...DEMO.keywords[0], daily: DEMO.keywords[0].daily.map((r, i) => (i === 2 ? { ...r, cost: -5, clicks: NaN } : r)) };
    const sh = keywordShift(k);
    expect(sh.collection).toBe(true);
    expect(sh.basis).not.toMatch(NO_BAD_TEXT);
  });
});

/* ------------------------------------------------------------------ */
describe('SA 테스트 그룹 등록 요청 — 모듈 간 중복 방지 · 승인 주체', () => {
  const rows = paidSurfaceRows(DEMO, buildGeoSnapshot(DEMO.today));
  const ch = (p: Partial<ChangeRequest>): ChangeRequest => ({
    id: 'c', createdAt: '2026-10-31T06:00:00Z', module: 'adpilot', kind: 'keyword_add', target: '', before: '', after: '', reason: '', requestedBy: 'PM', approver: 'AE', status: 'pending', history: [], ...p,
  });

  it('AD Pilot · MILDO Lab에서 올린 같은 검색어를 찾는다 · 반려/롤백 · 다른 검색어는 제외', () => {
    const t = '매트리스 경도 고르는 법';
    expect(findRegistration([ch({ target: `${t} → PROBLEM_TEST 등록`, targetId: `term:${t}` })], t)?.module).toBe('adpilot');
    expect(findRegistration([ch({ module: 'lab', target: t, targetId: 'labreg:매트리스경도고르는법' })], t)?.module).toBe('lab');
    expect(findRegistration([ch({ module: 'geo', target: t })], t)?.module).toBe('geo');
    expect(findRegistration([ch({ target: t, status: 'rejected' }), ch({ target: t, status: 'rolled_back' })], t)).toBeUndefined();
    expect(findRegistration([ch({ target: '매트리스 경도 → PROBLEM_TEST 등록', targetId: 'term:매트리스 경도' })], t)).toBeUndefined();
    expect(findRegistration([ch({ kind: 'bid', target: t })], t)).toBeUndefined();
    expect(findRegistration(undefined, t)).toBeUndefined();
    expect(findRegistration([ch({ target: t })], '')).toBeUndefined();
  });

  it('MILDO Flow 시연 이력(seed:term:… · "… 테스트 그룹 등록")도 같은 검색어로 본다 — 중복 요청 방지 (회귀)', () => {
    const seeds = seedChanges(DEMO);
    const seedReg = seeds.find((c) => c.kind === 'keyword_add' && String(c.targetId).startsWith('seed:term:'))!;
    expect(seedReg).toBeTruthy();
    const term = String(seedReg.target).replace(/\s*테스트 그룹 등록$/, '');
    // 페이드 지면 표의 같은 검색어 행이 '등록 요청' 대신 기존 요청으로 표시되어야 한다
    expect(rows.some((r) => r.requestable && r.term?.term === term)).toBe(true);
    expect(findRegistration(seeds, term)?.id).toBe(seedReg.id);
    expect(findRegistration([ch({ module: 'lab', target: `${term} 테스트 그룹 등록`, targetId: 'seed:x' })], term)?.module).toBe('lab');
    expect(findRegistration([ch({ module: 'lab', target: 'x', targetId: `seed:term:${term.replace(/\s+/g, '_')}` })], term)?.module).toBe('lab');
    // 다른 검색어의 시연 이력은 제외
    expect(findRegistration(seeds, '매트리스 경도 고르는 법')).toBeUndefined();
  });

  it('페이로드: AD Pilot 형식(term:… · <의도>_TEST) · 일반 검색어는 담당 AE, 브랜드 검색어는 PM · 후보 아니면 null', () => {
    const problem = registrationRequest(rows.find((r) => r.term?.term === '매트리스 경도 고르는 법')!, 'PM')!;
    expect(problem).toMatchObject({ module: 'geo', kind: 'keyword_add', targetId: 'term:매트리스 경도 고르는 법', approver: 'AE', requestedBy: 'PM' });
    expect(String(problem.after)).toMatch(/^PROBLEM_TEST/);
    expect(problem.reason).toContain('TEST DATA');
    const brand = registrationRequest(rows.find((r) => r.term?.term === '밀도 매트리스 경도')!, 'AE')!;
    expect(brand.approver).toBe('PM');
    expect(String(brand.after)).toMatch(/^BRAND_TEST/);
    expect(registrationRequest(rows.find((r) => r.action.id === 'landing')!, 'PM')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
describe('라이브 파싱 — URL은 언급이 아니라 인용', () => {
  it('자사 URL만 있으면 미언급 · 자사 인용만 판정, 경쟁사 도메인도 언급으로 세지 않는다', () => {
    const r = parseAiAnswer('추천 제품 목록은 https://mildo.kr/guide 와 zinus.com 에서 볼 수 있습니다.');
    expect(r.mentioned).toBe(false);
    expect(r.competitors).toEqual([]);
    expect(r.citations.some((c) => c.domain === 'mildo.kr' && c.owned)).toBe(true);
    expect(liveVerdict(r)).toMatchObject({ id: 'cited', label: '자사 인용만' });
    expect(liveVerdict(r).basis).toContain('자사 URL 인용 1건');
  });

  it('본문 언급의 순서 · 발췌는 URL을 가려도 원문 위치 그대로', () => {
    const t = '참고 https://www.zinus.com/kr 지누스와 수면밀도를 비교하면 www.mildo.kr 에서';
    expect(maskUrls(t)).toHaveLength(t.length);
    const r = parseAiAnswer(t);
    expect(r.order).toEqual(['지누스', BRAND]);
    expect(r.position).toBe(2);
    expect(r.excerpt).toContain('수면밀도');
    expect(r.citations.map((c) => c.domain)).toEqual(['zinus.com', 'mildo.kr']);
  });
});

/* ------------------------------------------------------------------ */
describe('표시 보조', () => {
  it('dateLabel: 날짜 없음 · 형식 오류는 — (NaN 표기 방지)', () => {
    expect(dateLabel('2026-10-26')).toBe('10/26(월)');
    expect(dateLabel('2026-10-26', false)).toBe('10/26');
    for (const v of ['', null, undefined, 'bad', '2026-1-5']) expect(dateLabel(v as string)).toBe('—');
  });

  it('의도별 집계는 스냅샷의 질의 정의를 따른다 (기본 질의 id와 겹쳐도 이중 집계 없음)', () => {
    const qs: GeoQuery[] = [{ id: 'q01', text: '커스텀', intent: 'life', qMult: 1, topics: [] }];
    const s: GeoSnapshot = {
      kind: 'DEMO', queries: qs, engines: GEO_ENGINES.slice(0, 1),
      rounds: [{ index: 0, date: '2026-10-26', cells: [{ queryId: 'q01', engine: 'chatgpt', mentioned: true, position: 1, order: [BRAND], competitors: [], citations: [] }] }],
    };
    const v = visibilitySummary(s);
    expect(v.byIntent.find((b) => b.intent === 'life')).toMatchObject({ total: 1, mentioned: 1 });
    expect(v.byIntent.find((b) => b.intent === 'brand')).toMatchObject({ total: 0 }); // GEO_QUERIES의 q01은 brand
  });
});
