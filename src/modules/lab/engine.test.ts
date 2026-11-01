/**
 * MILDO Lab 엔진 테스트 — 제안서 p.26–28 · p.36 판정 규칙 · 경계값 · 빈 데이터 · NaN 방어,
 * 그리고 시연 데이터(DEMO)에 심어둔 Lab 관련 시나리오를 엔진이 데이터로 잡아내는지 검증한다.
 * 기대값은 가능한 한 원본 데이터에서 독립적으로 다시 계산해 비교한다 (하드코딩 결과 대조 아님).
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Dataset } from '@/core/types';
import { DEMO, generateDemoData } from '@/data/demo';
import { AD_PILOT, KEYWORD_TEST_RULES, REVIEW_RULES, SA_CAMPAIGNS, SKU_EXPANSION, TEST_CARD_RULES } from '@/data/constants';
import { addDays, fmt, twoProportionZ, weekday } from '@/core/util';
import {
  CARD_RULES, demoTestCards, HYPOTHESES, LAB_BULK, LAB_DEFAULT_CRITERIA, SA_CHAR_LIMITS, SCORE_WEIGHTS, SKU_TOKENS, VISUALTUNE_DRAFTS,
} from './data';
import {
  applyFixes, bulkCheck, buildPipeline, canApprove, candidateStatus, charLen, classifyIntent, collectCopies, creativeBrief, cumulativeSeries,
  decisionPayload, discoverCandidates, discoveryBrief, estimatePhraseVolume, generateSaCopies, groupPools, incomingTests, incomingToDraft,
  inferTestStart, isRegistration, judgeKeywordTest, judgeTestCard, labBrief, labOverview, labPrompt, landingFor, loopCalendar, makeCopy,
  nextBusinessDay, nextUserCardId, normInv, nthBusinessDay, parseAiCandidates, parseAiCopies, parseAiRewrites, pipelineBrief, pipelineSummary, priceReferences,
  registrationPayload, relatedCandidatesFor, requiredSamplePerArm, resolveCriteria, ruleLabel, reviewAll, reviewBrief, reviewCopy, roasOf, scoreCandidate,
  searchTermCandidates, sg, skuEntries, skuFormula, testBidCap, tokenVolume, validateCardInput, weeklyDraft, wrapupDue,
  type Candidate, type CardDay, type TestCard,
} from './engine';

/* ---------------------------------------------------------------- */
/* 공통 픽스처                                                         */
/* ---------------------------------------------------------------- */

const D = DEMO;
const TODAY = D.today;
const clone = (d: Dataset): Dataset => JSON.parse(JSON.stringify(d)) as Dataset;
const EMPTY: Dataset = {
  generatedAt: '', today: '2026-10-31', currentHour: 15, dates: [], mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [],
  campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
};
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const noBad = (s: unknown) => expect(typeof s === 'string' ? s : JSON.stringify(s)).not.toMatch(BAD);
const NUMBERED = /(^|\n)\s*\d+\.\s/;

let seq = 0;
function change(p: Partial<ChangeRequest>): ChangeRequest {
  seq += 1;
  return {
    id: `chg_${seq}`, createdAt: `2026-10-31T06:${String(seq).padStart(2, '0')}:00.000Z`, module: 'lab', kind: 'keyword_add', target: '', before: '', after: '',
    reason: '', requestedBy: 'PM', approver: 'AE', status: 'pending', history: [], ...p,
  };
}
function stats(clicks: number, conversions: number, cost: number, revenue: number, impressions = clicks * 40) {
  return { impressions, clicks, conversions, cost, revenue };
}
function days(n: number, row: CardDay): CardDay[] {
  return Array.from({ length: n }, () => ({ ...row }));
}
function card(p: Partial<TestCard>): TestCard {
  return {
    id: 'TX', title: '테스트', hypothesis: '랜딩을 바꾸면 전환율이 오른다', variable: '랜딩', media: '네이버 SA', intent: 'life', control: 'A', variant: 'B',
    primary: 'cvr', metricsLabel: '전환율', start: addDays(TODAY, -14), plannedDays: 14, minClicksPerArm: null, stopDay: 7, stopDropPct: 30, expandLiftPct: 15,
    expandScope: '같은 의도 그룹 전체 적용', source: 'user', dailyC: [], dailyV: [], ...p,
  };
}

/* ---------------------------------------------------------------- */
/* 상수 · 출처 일치 (constants.ts 와 같은 값이어야 함)                     */
/* ---------------------------------------------------------------- */

describe('제안서 기준값 일치', () => {
  it('p.26 키워드 판정 기본값 = KEYWORD_TEST_RULES · AD_PILOT 목표 ROAS', () => {
    expect(LAB_DEFAULT_CRITERIA.targetRoas).toBe(AD_PILOT.targetRoas);
    expect(LAB_DEFAULT_CRITERIA.expandAtPct).toBe(KEYWORD_TEST_RULES.expandAtPct);
    expect(LAB_DEFAULT_CRITERIA.keepFromPct).toBe(KEYWORD_TEST_RULES.keepFromPct);
    expect(LAB_DEFAULT_CRITERIA.minDays).toBe(KEYWORD_TEST_RULES.minDays);
    expect(LAB_DEFAULT_CRITERIA.minClicks).toBe(KEYWORD_TEST_RULES.minClicks);
  });
  it('p.28 테스트 카드 기준 = TEST_CARD_RULES (14일 · 7일 차 −30% · +15%)', () => {
    expect(CARD_RULES.days).toBe(TEST_CARD_RULES.days);
    expect(CARD_RULES.stopDay).toBe(TEST_CARD_RULES.stopDay);
    expect(CARD_RULES.stopCvrDropPct).toBe(TEST_CARD_RULES.stopCvrDropPct);
    expect(CARD_RULES.expandCvrLiftPct).toBe(TEST_CARD_RULES.expandCvrLiftPct);
    expect(CARD_RULES.wrapupDays).toBe(14);
  });
  it('p.36 SKU 확장 라벨 = SKU_EXPANSION', () => {
    expect(SKU_TOKENS.problems.map((x) => x.label)).toEqual([...SKU_EXPANSION.problems]);
    expect(SKU_TOKENS.situations.map((x) => x.label)).toEqual([...SKU_EXPANSION.situations]);
    expect(SKU_TOKENS.criteria.map((x) => x.label)).toEqual([...SKU_EXPANSION.criteria]);
  });
  it('p.27 가설 A · B · C 예시 카피 원문', () => {
    expect(HYPOTHESES.A.copy).toBe('경도 · 소재 · 구조로 고르는 매트리스');
    expect(HYPOTHESES.B.copy).toBe('누적 리뷰 6만 개가 고른 매트리스');
    expect(HYPOTHESES.C.copy).toBe('전국 무료배송 · 전문 기사 설치');
    expect(HYPOTHESES.B.claimNote).toMatch(/확인/);
  });
  it('네이버 파워링크 글자수 기준 제목 15 · 설명 45', () => {
    expect(SA_CHAR_LIMITS).toEqual({ title: 15, description: 45 });
  });
});

/* ---------------------------------------------------------------- */
/* 의도 분류 · 랜딩 · 검색량                                            */
/* ---------------------------------------------------------------- */

describe('구매 의도 분류', () => {
  it.each([
    ['수면밀도 할인', 'brand'],
    ['신혼집 매트리스 사이즈', 'life'],
    ['매트리스 경도 고르는 법', 'problem'],
    ['독립스프링 vs 포켓스프링', 'compare'],
    ['퀸 매트리스', 'generic'],
  ] as const)('%s → %s', (term, intent) => {
    expect(classifyIntent(term).intent).toBe(intent);
  });
  it('폐기 · 렌탈은 구매 의도 낮음, 디스크 · 통증은 의료 맥락 플래그', () => {
    expect(classifyIntent('이사 매트리스 버리기').purchase).toBe(false);
    expect(classifyIntent('매트리스 렌탈 추천').purchase).toBe(false);
    expect(classifyIntent('허리 디스크 매트리스').medical).toBe(true);
    expect(classifyIntent('신혼 매트리스').medical).toBe(false);
  });
  it('빈 · 비정상 입력도 예외 없이 generic', () => {
    expect(classifyIntent('').intent).toBe('generic');
    expect(classifyIntent(undefined as unknown as string).intent).toBe('generic');
  });
});

describe('랜딩 매칭 · 검색량 추정', () => {
  it('품절 옵션(데이터 inStock=false)이 들어간 구문은 부분 매칭 + 품절 메모', () => {
    const sold = D.products.flatMap((p) => p.options.filter((o) => !o.inStock).map((o) => o.label));
    expect(sold.length).toBeGreaterThan(0);
    const l = landingFor(D, `${sold[0]} 사이즈 매트리스 추천`);
    expect(l.level).toBe('partial');
    expect(l.notes.join(' ')).toMatch(/품절/);
    // 재고를 되돌리면 같은 구문의 품절 메모가 사라진다 → 데이터로 판정
    const d2 = clone(D);
    d2.products.forEach((p) => p.options.forEach((o) => { o.inStock = true; }));
    expect(landingFor(d2, `${sold[0]} 사이즈 매트리스 추천`).notes.join(' ')).not.toMatch(/품절 — 랜딩/);
  });
  it('기획전 랜딩 구문 — 진행 중 기획전 종료 7일 이내면 부분 매칭 · 교체 메모, 종료일이 멀면 매칭', () => {
    const phrase = '신혼 혼수 매트리스 선물';
    const promo = D.promotions.find((p) => p.status === 'live' && p.channel === 'brandstore')!;
    const left = Math.round((new Date(promo.end).getTime() - new Date(TODAY).getTime()) / 86400000);
    expect(left).toBeLessThanOrEqual(7);
    const l = landingFor(D, phrase);
    expect(l.key).toBe('event');
    expect(l.level).toBe('partial');
    expect(l.notes.join(' ')).toContain(promo.name);
    const d2 = clone(D);
    d2.promotions.forEach((p) => { if (p.status === 'live') p.end = '2026-12-31'; });
    expect(landingFor(d2, phrase).level).toBe('good');
  });
  it('기획전이 하나도 없으면 기획전 랜딩은 비어 있음으로 부분 매칭', () => {
    const d2 = clone(D);
    d2.promotions = [];
    const l = landingFor(d2, '신혼 혼수 매트리스 선물');
    expect(l.level).toBe('partial');
    expect(l.notes.join(' ')).toMatch(/진행 중 기획전 없음/);
  });
  it('검색량 추정은 데이터 키워드 검색량 기반, 근거 없으면 기본값', () => {
    expect(tokenVolume(D, ['신혼'])).toBe(Math.max(...D.keywords.filter((k) => k.text.replace(/\s/g, '').includes('신혼')).map((k) => k.monthlySearch)));
    expect(tokenVolume(EMPTY, ['신혼'])).toBeNull();
    const e = estimatePhraseVolume(EMPTY, '없는 단어 조합');
    expect(e.volume).toBeGreaterThan(0);
    expect(e.note).toMatch(/기본/);
  });
  it('테스트 그룹 입찰 상한 = 같은 의도 본 그룹(on) 입찰가 중앙값, 데이터 없으면 기본 1,000원', () => {
    const bids = D.keywords.filter((k) => k.intent === 'life' && k.status === 'on').map((k) => k.bid).sort((a, b) => a - b);
    const mid = bids.length % 2 ? bids[(bids.length - 1) / 2] : (bids[bids.length / 2 - 1] + bids[bids.length / 2]) / 2;
    expect(testBidCap(D, 'life')).toBe(Math.round(mid / 10) * 10);
    expect(testBidCap(EMPTY, 'life')).toBe(1000);
  });
});

/* ---------------------------------------------------------------- */
/* 발굴 — 소스 3개 + SKU 48                                              */
/* ---------------------------------------------------------------- */

describe('롱테일 · 구문형 발굴', () => {
  it('SKU 확장 생성기: 제품 1 × 문제 4 × 상황 4 × 비교 3 = 48개, 구문 중복 없음', () => {
    const f = skuFormula();
    expect(f).toMatchObject({ product: 1, problems: 4, situations: 4, criteria: 3, total: 48 });
    const sku = skuEntries(D);
    expect(sku).toHaveLength(48);
    expect(new Set(sku.map((s) => s.phrase)).size).toBe(48);
    for (const s of sku) {
      expect(s.phrase).toContain('매트리스');
      expect(SKU_EXPANSION.problems).toContain(s.sku!.problem);
      expect(SKU_EXPANSION.situations).toContain(s.sku!.situation);
      expect(SKU_EXPANSION.criteria).toContain(s.sku!.criterion);
      expect(s.volume).toBeGreaterThan(0);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(['good', 'partial', 'none']).toContain(s.landing.level);
      expect(s.volumeNote).toMatch(/데모 추정/);
    }
    // 상위 구문 (예: '신혼집 매트리스 사이즈')
    expect(sku.map((s) => s.sku!.head)).toContain('신혼집 매트리스 사이즈');
  });
  it('시나리오: 검색어 보고서 미등록 구문형 후보를 데이터에서 찾는다 (등록 · 기존 키워드 제외)', () => {
    const kw = new Set(D.keywords.map((k) => k.text.replace(/\s/g, '')));
    const expected = D.searchTerms.filter((t) => !t.registered && !kw.has(t.term.replace(/\s/g, '')));
    expect(expected.length).toBeGreaterThanOrEqual(5);
    const got = searchTermCandidates(D);
    expect(got.map((c) => c.phrase).sort()).toEqual(expected.map((t) => t.term).sort());
    for (const c of got) {
      const t = D.searchTerms.find((x) => x.term === c.phrase)!;
      expect(c.evidence!.clicks).toBe(t.clicks);
      expect(c.evidence!.roas).toBeCloseTo((t.revenue / t.cost) * 100, 6);
      expect(c.volumeKind).toBe('impressions');
    }
    // 모두 등록되면 후보가 사라진다
    const d2 = clone(D);
    d2.searchTerms.forEach((t) => { t.registered = true; });
    expect(searchTermCandidates(d2)).toHaveLength(0);
  });
  it('의료 맥락 검색어는 전환이 있어도 검수 필수 플래그', () => {
    const c = searchTermCandidates(D).find((x) => x.phrase.includes('디스크'));
    expect(c).toBeTruthy();
    expect(c!.medical).toBe(true);
    expect(c!.flags.join(' ')).toMatch(/의료/);
  });
  it('전체 후보: 구문 중복 제거 · 이미 등록 키워드 제외 · 점수 내림차순 · 3개 소스 모두 포함', () => {
    const { all, excludedExisting } = discoverCandidates(D);
    const keys = all.map((c) => c.phrase.replace(/\s/g, ''));
    expect(new Set(keys).size).toBe(keys.length);
    const existing = new Set(D.keywords.map((k) => k.text.replace(/\s/g, '')));
    expect(all.some((c) => existing.has(c.phrase.replace(/\s/g, '')) && c.status === 'existing')).toBe(false);
    expect(excludedExisting).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].score).toBeGreaterThanOrEqual(all[i].score);
    const sources = new Set(all.map((c) => c.source));
    for (const s of ['search_term', 'related', 'ai_query', 'sku48'] as const) expect(sources.has(s)).toBe(true);
  });
  it('구매 의도 낮은 구문(폐기 · 렌탈)은 점수 30 이하 · 보류', () => {
    const { all } = discoverCandidates(D);
    const low = all.filter((c) => !c.purchase);
    expect(low.length).toBeGreaterThan(0);
    for (const c of low) {
      expect(c.score).toBeLessThanOrEqual(30);
      expect(c.tier).toBe('hold');
    }
  });
  it('우선순위 점수 경계: 우선 ≥ 70 · 검토 ≥ 50 · NaN 입력 방어', () => {
    const landing = landingFor(D, '신혼 매트리스');
    const s = scoreCandidate({ volume: NaN, landing, evidence: null, purchase: true, intent: 'life', groupRoasRatio: NaN });
    expect(Number.isFinite(s.score)).toBe(true);
    const hi = scoreCandidate({ volume: 1e6, landing: { ...landing, level: 'good' }, evidence: { clicks: 200, conversions: 5, cost: 1, revenue: 1, roas: 2000, ratioPct: 500 }, purchase: true, intent: 'life', groupRoasRatio: 200 });
    expect(hi.score).toBe(100);
    expect(hi.tier).toBe('priority');
    for (const c of discoverCandidates(D).all) {
      expect(c.tier).toBe(c.score >= SCORE_WEIGHTS.priority ? 'priority' : c.score >= SCORE_WEIGHTS.review ? 'review' : 'hold');
    }
  });
  it('등록 요청 → 상태 전이 (요청 · 테스트 중 · 반려), AD Pilot _TEST 등록도 인식', () => {
    const c = searchTermCandidates(D)[0];
    const p = registrationPayload(c, 'PM');
    expect(p.kind).toBe('keyword_add');
    expect(p.after).toMatch(/_TEST · 입찰 상한/);
    const pending = change({ ...p, status: 'pending' });
    expect(candidateStatus(D, [pending], c.phrase).status).toBe('requested');
    expect(candidateStatus(D, [{ ...pending, status: 'applied' }], c.phrase).status).toBe('testing');
    expect(candidateStatus(D, [{ ...pending, status: 'rejected' }], c.phrase).status).toBe('rejected');
    const ad = change({ module: 'adpilot', kind: 'keyword_add', target: c.phrase, after: 'LIFE_TEST · 입찰 900원' });
    expect(isRegistration(ad)).toBe(true);
    expect(candidateStatus(D, [ad], c.phrase).status).toBe('requested');
    // 등록 요청된 후보는 '미등록' 목록에서 빠진다
    const after = discoverCandidates(D, [pending]).all.find((x) => x.phrase === c.phrase)!;
    expect(after.status).toBe('requested');
  });
  it('일괄 요청 안전 기준: 5건 AE · 6건 이상 PM 경고 · 10건 초과 차단', () => {
    expect(bulkCheck(1)).toMatchObject({ level: 'ok', approver: 'AE' });
    expect(bulkCheck(LAB_BULK.pmFrom - 1).level).toBe('ok');
    expect(bulkCheck(LAB_BULK.pmFrom)).toMatchObject({ level: 'warn', approver: 'PM' });
    expect(bulkCheck(LAB_BULK.max).level).toBe('warn');
    expect(bulkCheck(LAB_BULK.max + 1).level).toBe('block');
    expect(registrationPayload(searchTermCandidates(D)[0], 'PM', LAB_BULK.pmFrom).approver).toBe('PM');
  });
  it('AI 확장 응답 파싱: 형식 오류 · 중복 · 영문 · 길이 위반을 걸러낸다', () => {
    const got = parseAiCandidates([
      { phrase: '신혼집 매트리스 고르는 법', monthly: 500, rationale: '신혼 준비 단계 질의' }, 'ab', { phrase: '신혼집  매트리스 고르는 법' },
      { keyword: 'english only phrase' }, null, 42, { term: '아이방 매트리스 경도 선택' },
    ], D);
    expect(got.map((c) => c.phrase)).toEqual(['신혼집 매트리스 고르는 법', '아이방 매트리스 경도 선택']);
    expect(got[0]).toMatchObject({ source: 'ai_expand', volume: 500 });
    expect(got[1].volume).toBeGreaterThan(0);
    expect(parseAiCandidates({ candidates: ['수면밀도 경도 비교'] }, D)).toHaveLength(1);
    expect(parseAiCandidates('garbage', D)).toEqual([]);
    expect(parseAiCandidates(undefined, D)).toEqual([]);
  });
  it('AI 응답의 마크업 · 목록 기호 · 기호는 키워드 구문에 남기지 않는다 (태그가 든 구문을 등록 요청하지 않게)', () => {
    const got = parseAiCandidates(['<b>신혼</b> 침대 매트리스 경도', '1. 자취방 매트리스 사이즈 추천', '**아이방** 매트리스 "추천"', '- 부모님 선물 매트리스 #경도'], D);
    expect(got.map((c) => c.phrase)).toEqual(['신혼 침대 매트리스 경도', '자취방 매트리스 사이즈 추천', '아이방 매트리스 추천', '부모님 선물 매트리스 경도']);
    for (const c of got) expect(c.phrase).not.toMatch(/[<>*#"`]/);
    // 문안 · 수정안은 문장부호는 두고 태그 · 강조 기호만 뺀다
    const copies = parseAiCopies([{ title: '<b>경도로 고르는</b> 매트리스', description: '**무료배송** · 전문 기사 설치!' }], 'life', 'A');
    expect(copies[0].title).toBe('경도로 고르는 매트리스');
    expect(copies[0].description).toBe('무료배송 · 전문 기사 설치!');
    expect(parseAiRewrites(['<i>체압 분산</i> 구조로 고르는 매트리스'])[0].text).toBe('체압 분산 구조로 고르는 매트리스');
  });
});

/* ---------------------------------------------------------------- */
/* 키워드 테스트 판정 (p.26)                                             */
/* ---------------------------------------------------------------- */

describe('키워드 테스트 판정 · 경계값', () => {
  const T = AD_PILOT.targetRoas;
  const rev = (ratioPct: number, cost = 1_000_000) => (cost * T * ratioPct) / 10000;
  it('확장 ≥ 목표 ROAS 100% (정확히 100%면 확장)', () => {
    const j = judgeKeywordTest(stats(120, 5, 1_000_000, rev(100)), 14);
    expect(j.verdict).toBe('expand');
    expect(j.badge).toContain(`목표 ROAS ${T}% 대비 100%`);
  });
  it('유지 70~100% (99.9% · 70%)', () => {
    expect(judgeKeywordTest(stats(120, 5, 1_000_000, rev(99.9)), 14).verdict).toBe('keep');
    const j = judgeKeywordTest(stats(120, 5, 1_000_000, rev(70)), 14);
    expect(j.verdict).toBe('keep');
    expect(j.badge).toMatch(/기준 70~100%/);
  });
  it('제외 < 70% (69.9%) · 전환 없음', () => {
    expect(judgeKeywordTest(stats(120, 5, 1_000_000, rev(69.9)), 14).verdict).toBe('exclude');
    const j = judgeKeywordTest(stats(120, 0, 1_000_000, 0), 14);
    expect(j.verdict).toBe('exclude');
    expect(j.badge).toMatch(/전환 없음/);
  });
  it('STEP 2 — 14일 또는 최소 클릭 도달 전은 집행 중', () => {
    const j = judgeKeywordTest(stats(99, 3, 100_000, 5_000_000), 13);
    expect(j.verdict).toBe('running');
    expect(j.badge).toContain('13/14일');
    expect(judgeKeywordTest(stats(100, 3, 100_000, 5_000_000), 3).verdict).toBe('expand'); // 클릭 기준 도달
    expect(judgeKeywordTest(stats(20, 1, 100_000, 5_000_000), 14).readyBy).toBe('days');
  });
  it('기간 도달 · 클릭 < 판정 최소 클릭 → 판정 보류 · 표본 부족 (ROAS가 높아도)', () => {
    const j = judgeKeywordTest(stats(29, 1, 30_000, 5_000_000), 14);
    expect(j.verdict).toBe('insufficient');
    expect(j.badge).toBe('판정 보류 · 표본 부족 (클릭 29 < 30)');
    expect(judgeKeywordTest(stats(30, 1, 30_000, 5_000_000), 14).verdict).toBe('expand');
  });
  it('볼륨 한계 — 일 클릭이 적어 28일 이상 걸리면 그룹 합산 · 상위 구문 통합 안내', () => {
    const j = judgeKeywordTest(stats(10, 0, 10_000, 0), 28, null, { monthlySearch: 390 });
    expect(j.action).toMatch(/볼륨 한계/);
    expect(j.action).toContain('390');
  });
  it('브랜드 키워드는 브랜드 목표 ROAS 800% 기준', () => {
    const j = judgeKeywordTest(stats(120, 5, 1_000_000, 6_000_000), 14, null, { isBrand: true });
    expect(j.target).toBe(AD_PILOT.brandTargetRoas);
    expect(j.verdict).toBe('keep'); // 600 / 800 = 75%
  });
  it('기준값 편집 반영 — 목표 ROAS를 낮추면 같은 성과가 확장으로 바뀐다', () => {
    const s = stats(120, 5, 1_000_000, 3_200_000); // ROAS 320%
    expect(judgeKeywordTest(s, 14).verdict).toBe('keep');
    expect(judgeKeywordTest(s, 14, { targetRoas: 300 }).verdict).toBe('expand');
    expect(judgeKeywordTest(s, 14, { keepFromPct: 85 }).verdict).toBe('exclude');
  });
  it('빈 · NaN 입력 방어', () => {
    const j = judgeKeywordTest(null, NaN);
    expect(j.verdict).toBe('running');
    noBad(j.badge);
    noBad(j.basis);
    const j2 = judgeKeywordTest({ clicks: NaN, conversions: NaN, cost: NaN, revenue: NaN, impressions: NaN }, 20);
    expect(j2.stats.clicks).toBe(0);
    noBad(j2.badge);
    expect(roasOf({ cost: 0, revenue: 100, conversions: 1 })).toBeNaN();
    expect(roasOf({ cost: 100, revenue: 100, conversions: 0 })).toBe(0);
  });
  it('기준값 정규화 — 음수 · NaN은 초기값, 유지 ≥ 확장이면 유지 = 확장 − 1', () => {
    const c = resolveCriteria({ targetRoas: -5, expandAtPct: 100, keepFromPct: 120, minDays: NaN, minClicks: 50, minJudgeClicks: 80 });
    expect(c.targetRoas).toBe(AD_PILOT.targetRoas);
    expect(c.keepFromPct).toBe(99);
    expect(c.minDays).toBe(14);
    expect(c.minJudgeClicks).toBe(50);
    expect(resolveCriteria(undefined)).toEqual(LAB_DEFAULT_CRITERIA);
  });
  it('기준값 정규화는 멱등 — 화면에 보이는 기준(1회 정규화)과 엔진 판정 기준(2회 정규화)이 같다', () => {
    const inputs = [
      { minDays: 0.4, minClicks: 0.3, minJudgeClicks: 0.2 },
      { targetRoas: 0.001, expandAtPct: 0.5, keepFromPct: 0.2 },
      { minDays: 7.6, minClicks: 20.4, minJudgeClicks: 25 },
      { expandAtPct: 1, keepFromPct: 1 },
    ];
    for (const i of inputs) {
      const once = resolveCriteria(i);
      expect(resolveCriteria(once), JSON.stringify(i)).toEqual(once);
    }
    // 1 미만은 초기값 (입력 칸 min=1과 같은 기준) · 정수 기준은 반올림
    expect(resolveCriteria({ minDays: 0.4, minClicks: 0.3, minJudgeClicks: 0.2 })).toMatchObject({ minDays: 14, minClicks: 100, minJudgeClicks: 30 });
    expect(resolveCriteria({ targetRoas: 0.001 }).targetRoas).toBe(AD_PILOT.targetRoas);
    expect(resolveCriteria({ minDays: 7.6, minClicks: 20.4 })).toMatchObject({ minDays: 8, minClicks: 20, minJudgeClicks: 20 });
    // 칸반 판정도 같은 기준 — 0.4일은 14일로 판정 (화면 표시와 같음)
    const a = buildPipeline(D, [], resolveCriteria({ minDays: 0.4 }));
    const b = buildPipeline(D, [], LAB_DEFAULT_CRITERIA);
    expect(a.map((x) => x.step)).toEqual(b.map((x) => x.step));
  });
});

describe('테스트 파이프라인 STEP 1~4 — 데모 데이터', () => {
  const items = buildPipeline(D, []);
  it('시나리오: test/new 프로필 키워드가 모두 칸반에 들어온다 (status=test 키워드 수와 일치)', () => {
    const testKw = D.keywords.filter((k) => k.status === 'test');
    expect(testKw.length).toBeGreaterThanOrEqual(3);
    const kwItems = items.filter((i) => i.source === 'keyword');
    expect(kwItems.map((i) => i.phrase).sort()).toEqual(testKw.map((k) => k.text).sort());
  });
  it('시나리오: 신규(최근 14일만 집행) 키워드는 첫 노출일부터 일수를 센다', () => {
    const fresh = D.keywords.filter((k) => k.status === 'test' && k.prev14.impressions === 0);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    for (const k of fresh) {
      const st = inferTestStart(D, k);
      const first = k.daily.findIndex((x) => x.impressions > 0);
      expect(st.isNew).toBe(true);
      expect(st.days).toBe(k.daily.length - first);
      expect(items.find((i) => i.keywordId === k.id)!.isNew).toBe(true);
    }
  });
  it('직전 14일부터 집행한 테스트 키워드는 28일 누적 · 판정 기한 경과 표시', () => {
    const old = items.filter((i) => i.source === 'keyword' && !i.isNew);
    expect(old.length).toBeGreaterThan(0);
    for (const i of old) {
      expect(i.days).toBe(28);
      expect(i.overdue).toBe(true);
      const k = D.keywords.find((x) => x.id === i.keywordId)!;
      expect(i.judgement.stats.clicks).toBe(k.last14.clicks + k.prev14.clicks);
    }
  });
  it('검색어 보고서 등록 구문도 판정 대상이고, 모든 판정은 기준값과 일치한다 (오라클 재계산)', () => {
    const reg = D.searchTerms.filter((t) => t.registered && !D.keywords.some((k) => k.text === t.term));
    expect(items.filter((i) => i.source === 'search_term').map((i) => i.phrase).sort()).toEqual(reg.map((t) => t.term).sort());
    const C = LAB_DEFAULT_CRITERIA;
    for (const i of items.filter((x) => x.source !== 'request')) {
      const s = i.judgement.stats;
      const ready = (i.days ?? -1) >= C.minDays || s.clicks >= C.minClicks;
      const ratio = s.cost > 0 && s.conversions > 0 ? ((s.revenue / s.cost) * 100 / C.targetRoas) * 100 : s.cost > 0 ? 0 : NaN;
      const want = !ready ? 'running' : s.clicks < C.minJudgeClicks ? 'insufficient' : s.conversions <= 0 ? 'exclude' : ratio >= C.expandAtPct ? 'expand' : ratio >= C.keepFromPct ? 'keep' : 'exclude';
      expect(i.judgement.verdict, i.phrase).toBe(want);
      expect(i.step).toBe(want === 'running' ? 2 : want === 'insufficient' ? 3 : 4);
    }
    expect(items.some((i) => i.step === 4)).toBe(true);
  });
  it('롱테일 판정 보류는 같은 TEST 그룹으로 합산 판정', () => {
    const insuff = items.filter((i) => i.judgement.verdict === 'insufficient');
    const pools = groupPools(items);
    for (const p of pools) {
      const members = insuff.filter((i) => i.adgroup === p.adgroup);
      expect(p.count).toBe(members.length);
      expect(p.stats.clicks).toBe(members.reduce((a, b) => a + b.judgement.stats.clicks, 0));
    }
    expect(pools.length).toBeGreaterThanOrEqual(1);
  });
  it('등록 요청 → STEP 1, 승인 → STEP 2 (Day 0), 반려 · 롤백은 제외', () => {
    const c = searchTermCandidates(D)[0];
    const req = change({ ...registrationPayload(c, 'PM') });
    expect(buildPipeline(D, [req]).find((i) => i.phrase === c.phrase)!.step).toBe(1);
    expect(buildPipeline(D, [{ ...req, status: 'approved' }]).find((i) => i.phrase === c.phrase)!.step).toBe(2);
    expect(buildPipeline(D, [{ ...req, status: 'rejected' }]).find((i) => i.phrase === c.phrase)).toBeUndefined();
    const s = pipelineSummary(buildPipeline(D, [req]));
    expect(s.byStep[1]).toBe(1);
  });
  it('판정 반영 요청: 확장 = 본 그룹 이관(PM) · 제외 = 제외 키워드(AE)', () => {
    const exp = items.find((i) => i.judgement.verdict === 'expand')!;
    const p = decisionPayload(exp, 'PM');
    expect(p).toMatchObject({ kind: 'keyword_add', approver: 'PM', targetId: `labdec:${exp.id}` });
    expect(String(p.after)).toMatch(/_MAIN 이관/);
    const ex = decisionPayload({ ...exp, judgement: judgeKeywordTest(stats(120, 0, 1_000_000, 0), 14) }, 'PM');
    expect(ex).toMatchObject({ kind: 'keyword_exclude', approver: 'AE' });
    // 판정 반영 요청은 등록 요청으로 세지 않는다
    expect(isRegistration(change({ ...p }))).toBe(false);
    const withDec = buildPipeline(D, [change({ ...p })]);
    expect(withDec.find((i) => i.id === exp.id)!.decision).toBeTruthy();
    expect(pipelineSummary(withDec).awaitingDecision).toBe(pipelineSummary(items).awaitingDecision - 1);
  });
  it('확장 판정 → 연관 키워드 추가 발굴 후보 (같은 토픽 · 미등록 · 점수순, 자기 자신 제외)', () => {
    const exp = items.find((i) => i.judgement.verdict === 'expand')!;
    const pool = discoverCandidates(D).all;
    const rel = relatedCandidatesFor(exp.phrase, pool, 3);
    expect(rel.length).toBeGreaterThan(0);
    expect(rel.length).toBeLessThanOrEqual(3);
    const words = exp.phrase.split(' ').filter((w) => w !== '매트리스');
    for (const c of rel) {
      expect(c.status).toBe('new');
      expect(c.phrase).not.toBe(exp.phrase);
      expect(words.some((w) => c.phrase.includes(w))).toBe(true);
    }
    for (let k = 1; k < rel.length; k++) expect(rel[k - 1].score).toBeGreaterThanOrEqual(rel[k].score);
    expect(relatedCandidatesFor('', pool)).toEqual([]);
    expect(relatedCandidatesFor('매트리스 추천', [])).toEqual([]);
  });
  it('빈 데이터 — 파이프라인 · 요약 · 합산 · 브리프 모두 예외 없음', () => {
    expect(buildPipeline(EMPTY, [])).toEqual([]);
    expect(pipelineSummary([]).total).toBe(0);
    expect(groupPools([])).toEqual([]);
    const b = pipelineBrief(EMPTY, []);
    expect(b.facts[0]).toMatch(/없습니다/);
    noBad(b);
  });
});

/* ---------------------------------------------------------------- */
/* 다른 모듈 테스트 요청 (Watch · Growth)                                */
/* ---------------------------------------------------------------- */

describe('다른 모듈 테스트 요청 수신', () => {
  const watch = change({
    module: 'lab', kind: 'test', target: '네이버 GFA · 잠재고객 확장(Beta) 소재 테스트', targetId: 'ev_3', before: '실행안 (주간 리포트)', after: '소액 테스트 14일 · 일 30만원',
    reason: 'MILDO Watch 감지(매체 공지) → 영향 진단: 영향 있음. 가설: 리뷰 신뢰 소재를 쓰면 신규 고객 CTR이 오른다. 비교: A vs B.', approver: 'PM',
  });
  const growth = change({ module: 'growth', kind: 'test', target: '신규 매체 파일럿 · 지역 커뮤니티 · 당근', before: '미집행', after: '4주 · 2,000만', approver: 'CLIENT' });
  const own = change({ module: 'lab', kind: 'test', target: 'TC-U01 카드', targetId: 'labcard:TC-U01' });
  it('Watch(kind test) · Growth 파일럿은 키워드 등록으로 세지 않고 수신 요청으로 분리', () => {
    expect(isRegistration(watch)).toBe(false);
    expect(isRegistration(growth)).toBe(false);
    const inc = incomingTests([watch, growth, own]);
    expect(inc.map((x) => x.origin).sort()).toEqual(['MILDO Watch', '매출 성장']);
    expect(inc.find((x) => x.origin === 'MILDO Watch')!.route).toBe('watch');
    // 키워드 칸반에 가짜 구문으로 들어가지 않는다
    expect(buildPipeline(D, [watch, growth]).filter((i) => i.source === 'request')).toHaveLength(0);
  });
  it('수신 요청 → 테스트 카드 초안 (가설 추출 · 변수 추정)', () => {
    const [w] = incomingTests([watch]);
    const dr = incomingToDraft(w);
    expect(dr.hypothesis).toBe('리뷰 신뢰 소재를 쓰면 신규 고객 CTR이 오른다');
    expect(dr.variable).toBe('메시지');
    expect(dr.media).toMatch(/GFA/);
    expect(dr.primary).toBe('ctr');
    const g = incomingToDraft(incomingTests([growth])[0]);
    expect(g.variable).toBe('타겟');
    expect(g.hypothesis.length).toBeGreaterThanOrEqual(10);
    expect(incomingTests(undefined)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* 테스트 카드 (p.28) · 두 비율 z-검정                                   */
/* ---------------------------------------------------------------- */

describe('통계 보조', () => {
  it('normInv · 필요 표본 (기준 CVR 1%, +15% 검출 ≈ 군당 74,000 클릭)', () => {
    expect(normInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normInv(0.5)).toBeCloseTo(0, 6);
    expect(normInv(0)).toBeNaN();
    const n = requiredSamplePerArm(0.01, 15);
    expect(n).toBeGreaterThan(70_000);
    expect(n).toBeLessThan(80_000);
    expect(requiredSamplePerArm(0.01, 30)).toBeLessThan(n);
    expect(requiredSamplePerArm(0, 15)).toBeNaN();
    expect(requiredSamplePerArm(0.01, 0)).toBeNaN();
    expect(requiredSamplePerArm(NaN, 15)).toBeNaN();
  });
  it('부호 표기 sg', () => {
    expect(sg(12.4)).toBe('+12%');
    expect(sg(-30)).toBe('−30%');
    expect(sg(0.2)).toBe('0%');
    expect(sg(NaN)).toBe('—');
  });
});

describe('테스트 카드 판정', () => {
  const cards = demoTestCards(TODAY);
  it('진행 중 데모 카드 2~3개 · 시작일은 데이터 기준일에서 역산', () => {
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.length).toBeLessThanOrEqual(3);
    for (const c of cards) expect(c.start < TODAY).toBe(true);
  });
  it('데모 카드 판정은 일자별 원자료에서 계산한 z-검정 · 규칙과 일치한다', () => {
    for (const c of cards) {
      const j = judgeTestCard(c, TODAY);
      const n = Math.min(c.dailyC.length, c.dailyV.length);
      const sumOf = (rows: CardDay[], k: keyof CardDay) => rows.slice(0, n).reduce((a, r) => a + r[k], 0);
      const cC = sumOf(c.dailyC, 'clicks'), vC = sumOf(c.dailyV, 'clicks');
      const cConv = sumOf(c.dailyC, 'conversions'), vConv = sumOf(c.dailyV, 'conversions');
      const z = twoProportionZ(cConv, cC, vConv, vC);
      expect(j.pCvr).toBeCloseTo(z.p, 10);
      const lift = ((vConv / vC - cConv / cC) / (cConv / cC)) * 100;
      expect(j.liftCvr).toBeCloseTo(lift, 6);
      if (j.verdict === 'stop') {
        expect(n).toBeGreaterThanOrEqual(c.stopDay);
        expect(cConv).toBeGreaterThanOrEqual(CARD_RULES.stopMinConversions);
        expect(lift).toBeLessThanOrEqual(-c.stopDropPct);
        expect(j.badge).toMatch(/중단 · \d+일 차 CVR −\d+% \(기준 −30%\)/);
      }
      if (j.verdict === 'expand') {
        expect(n).toBeGreaterThanOrEqual(c.plannedDays);
        expect(j.primaryP).toBeLessThan(CARD_RULES.alpha);
        expect(j.primaryLift).toBeGreaterThanOrEqual(c.expandLiftPct);
        expect(j.badge).toMatch(/p[=<]/);
      }
      if (j.verdict === 'running') expect(n).toBeLessThan(c.plannedDays);
      noBad(j.badge);
      noBad(j.basis);
    }
    const vs = cards.map((c) => judgeTestCard(c, TODAY).verdict);
    expect(vs).toContain('expand');
    expect(vs).toContain('stop');
    expect(vs).toContain('running');
  });
  it('표본 부족 시 "판정 보류 · 표본 부족" 명시', () => {
    const c = card({
      dailyC: [...days(3, { impressions: 1000, clicks: 20, conversions: 1, cost: 15_000, revenue: 1_000_000 }), ...days(11, { impressions: 1000, clicks: 20, conversions: 0, cost: 15_000, revenue: 0 })],
      dailyV: [...days(4, { impressions: 1000, clicks: 20, conversions: 1, cost: 15_000, revenue: 1_000_000 }), ...days(10, { impressions: 1000, clicks: 20, conversions: 0, cost: 15_000, revenue: 0 })],
    });
    const j = judgeTestCard(c, TODAY);
    expect(j.verdict).toBe('insufficient');
    expect(j.badge).toMatch(/^판정 보류 · 표본 부족/);
    expect(j.sampleOk).toBe(false);
    expect(j.stopCheck.evaluated).toBe(false); // 기존안 전환 3 < 10 → 중단 판정 보류
  });
  it('7일 차 중단 기준은 기존안 전환이 적으면 평가하지 않는다 (소표본 오탐 방지)', () => {
    const base = { start: addDays(TODAY, -8), plannedDays: 14 };
    const few = judgeTestCard(card({
      ...base,
      dailyC: days(8, { impressions: 1000, clicks: 100, conversions: 1, cost: 70_000, revenue: 1_000_000 }),
      dailyV: days(8, { impressions: 1000, clicks: 100, conversions: 0, cost: 70_000, revenue: 0 }),
    }), TODAY);
    expect(few.C.conversions).toBeLessThan(CARD_RULES.stopMinConversions);
    expect(few.stopCheck.evaluated).toBe(false);
    expect(few.verdict).not.toBe('stop');
    expect(few.stopCheck.note).toMatch(/중단 판정 보류/);
    const enough = judgeTestCard(card({
      ...base,
      dailyC: days(8, { impressions: 1000, clicks: 100, conversions: 2, cost: 70_000, revenue: 2_000_000 }),
      dailyV: days(8, { impressions: 1000, clicks: 100, conversions: 1, cost: 70_000, revenue: 1_000_000 }),
    }), TODAY);
    expect(enough.C.conversions).toBeGreaterThanOrEqual(CARD_RULES.stopMinConversions);
    expect(enough.stopCheck.evaluated).toBe(true);
    expect(enough.verdict).toBe('stop'); // CVR −50% ≤ −30%
    // 6일 차에는 중단 점검 전
    const early = judgeTestCard(card({ start: addDays(TODAY, -6), dailyC: days(6, { impressions: 1000, clicks: 100, conversions: 3, cost: 1, revenue: 1 }), dailyV: days(6, { impressions: 1000, clicks: 100, conversions: 1, cost: 1, revenue: 1 }) }), TODAY);
    expect(early.stopCheck.evaluated).toBe(false);
    expect(early.verdict).toBe('running');
  });
  it('집행 전 · 빈 데이터 · NaN 기간 → 집행 전, 수치 표기 없음', () => {
    const fut = judgeTestCard(card({ start: addDays(TODAY, 1) }), TODAY);
    expect(fut.verdict).toBe('planned');
    noBad(fut.badge);
    const empty = judgeTestCard(card({ dailyC: [], dailyV: [], plannedDays: NaN }), TODAY);
    expect(empty.verdict).toBe('planned');
    noBad(empty.basis);
    expect(cumulativeSeries(card({}), 'cvr')).toEqual({ c: [], v: [] });
  });
  it('판정 순서 CTR → CVR → CPA → ROAS — 주 지표가 이겨도 뒤 지표 열위면 확대하지 않음', () => {
    // CTR +50% 유의 우세 · CVR −20% 유의 열위 (중단 기준 −30%보다는 작음)
    const c = card({
      primary: 'ctr', variable: '메시지',
      dailyC: days(14, { impressions: 10000, clicks: 1000, conversions: 30, cost: 500_000, revenue: 30_000_000 }),
      dailyV: days(14, { impressions: 10000, clicks: 1500, conversions: 36, cost: 750_000, revenue: 36_000_000 }),
    });
    const j = judgeTestCard(c, TODAY);
    expect(j.checks.map((x) => x.metric)).toEqual(['ctr', 'cvr', 'cpa', 'roas']);
    expect(j.checks[0].status).toBe('win');
    expect(j.checks[1].status).toBe('lose');
    expect(j.stopCheck.triggered).toBe(false);
    expect(j.verdict).toBe('monitor');
    expect(j.badge).toMatch(/CVR 열위/);
  });
  it('랩업 예정일 = 결정일 + 14일', () => {
    expect(wrapupDue({ verdict: 'expand', at: TODAY, by: 'PM', note: '' })).toBe(addDays(TODAY, 14));
    expect(wrapupDue(undefined)).toBeNull();
  });
  it('카드 생성 검증: 한 변수 · 동일 타겟 · 유사 예산(±10%) · 시작일', () => {
    const ok = { title: 't', hypothesis: '랜딩을 바꾸면 전환율이 오른다', variable: '랜딩', control: 'A', variant: 'B', sameTarget: true, budgetGapPct: 0, start: addDays(TODAY, 1), today: TODAY };
    expect(validateCardInput(ok)).toEqual([]);
    expect(validateCardInput({ ...ok, variant: 'A' }).join()).toMatch(/같습니다/);
    expect(validateCardInput({ ...ok, budgetGapPct: 11 }).join()).toMatch(/±10%/);
    expect(validateCardInput({ ...ok, budgetGapPct: NaN }).join()).toMatch(/±10%/);
    expect(validateCardInput({ ...ok, sameTarget: false }).join()).toMatch(/동일 타겟/);
    expect(validateCardInput({ ...ok, variable: '메시지+랜딩' }).join()).toMatch(/하나만/);
    expect(validateCardInput({ ...ok, start: addDays(TODAY, -1) }).join()).toMatch(/시작일/);
    expect(validateCardInput({ ...ok, hypothesis: '짧음' }).join()).toMatch(/가설/);
  });
});

/* ---------------------------------------------------------------- */
/* SA 문안 생성 · 검수 에이전트                                          */
/* ---------------------------------------------------------------- */

describe('SA 광고 문안 생성기 (p.35 캠페인 5종 × 가설 A · B · C)', () => {
  it('규칙 기반 문안은 모두 제목 15자 · 설명 45자 이내이고 검수 차단이 없다', () => {
    for (const camp of Object.keys(SA_CAMPAIGNS) as (keyof typeof SA_CAMPAIGNS)[]) {
      for (const h of ['A', 'B', 'C'] as const) {
        const cs = generateSaCopies(D, camp, h);
        expect(cs.length).toBeGreaterThanOrEqual(2);
        for (const c of cs) {
          expect(c.titleOk, `${camp}/${h} ${c.title}`).toBe(true);
          expect(c.descOk, `${camp}/${h} ${c.description}`).toBe(true);
          expect(reviewCopy(c.title, D, { limit: SA_CHAR_LIMITS.title }).level).not.toBe('block');
          expect(reviewCopy(c.description, D, { limit: SA_CHAR_LIMITS.description }).level).not.toBe('block');
          noBad(c.title + c.description);
        }
      }
    }
  });
  it('가설 C 문안의 기획전 가격은 판매가 × (1 − 할인율)로 계산 (데이터)', () => {
    const promo = D.promotions.filter((p) => p.status === 'live' && p.channel === 'brandstore').sort((a, b) => b.discountRate - a.discountRate)[0];
    const queen = D.products[0].options.find((o) => o.label === '퀸')!;
    const price = Math.round(queen.price * (1 - promo.discountRate / 100));
    const text = generateSaCopies(D, 'life', 'C').map((c) => c.description).join(' ');
    expect(text).toContain(`${fmt.int(price)}원`);
    expect(reviewCopy(`${fmt.int(price)}원`, D).prices[0].status).toBe('match');
    const d2 = clone(D);
    d2.promotions = [];
    expect(generateSaCopies(d2, 'life', 'C').map((c) => c.description).join(' ')).not.toMatch(/\d원/);
  });
  it('글자수는 공백 포함 문자 수 · 초과 시 표시', () => {
    expect(charLen('신혼 매트리스')).toBe(7);
    const c = makeCopy('life', 'A', '가'.repeat(16), '나'.repeat(46), 'ai', 0);
    expect(c.titleOk).toBe(false);
    expect(c.descOk).toBe(false);
    expect(makeCopy('life', 'A', '', '', 'rule', 0).titleOk).toBe(false);
  });
  it('AI 문안 파싱 — 제목 · 설명 누락은 버리고 가설 표기를 따른다', () => {
    const got = parseAiCopies([{ title: '경도로 고르는 매트리스', description: '설명' }, { title: '', description: 'x' }, { headline: '리뷰로 고른 매트리스', desc: '설명2', hypothesis: 'B' }, 7], 'life', 'A');
    expect(got).toHaveLength(2);
    expect(got[1].hypothesis).toBe('B');
    expect(got[0].source).toBe('ai');
    expect(parseAiCopies({ copies: [] }, 'life', 'A')).toEqual([]);
    expect(parseAiCopies(null, 'life', 'A')).toEqual([]);
  });
});

describe('검수 에이전트 (REVIEW_RULES + 데이터 대조)', () => {
  it('의료 효능 암시 → 차단 + 수정안 재검수 통과', () => {
    const r = reviewCopy('허리 디스크 치료에 도움되는 매트리스', D);
    expect(r.level).toBe('block');
    expect(r.findings.some((f) => f.ruleId === 'medical_cure')).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.suggested).not.toMatch(/치료|디스크/);
    expect(r.suggestedLevel).toBe('pass');
    expect(reviewCopy('의사 추천 척추 교정 매트리스', D).findings.some((f) => f.ruleId === 'medical_device' && f.level === 'block')).toBe(true);
  });
  it('최상급 · 순위: 출처 없으면 경고, 기준 · 기간 병기 시 확인', () => {
    expect(reviewCopy('판매 1위 매트리스', D).level).toBe('warn');
    const r = reviewCopy('네이버 가구 부문 판매 1위 (2026년 상반기 기준) 수면밀도', D);
    expect(r.findings.find((f) => f.ruleId === 'superlative')!.level).toBe('check');
  });
  it('절대 표현 · 경쟁사명 → 경고 + 자동 치환', () => {
    const a = reviewCopy('무조건 편한 매트리스', D);
    expect(a.findings.some((f) => f.ruleId === 'absolute' && f.level === 'warn')).toBe(true);
    const c = reviewCopy('지누스보다 단단한 독립스프링 구조', D);
    expect(c.level).toBe('warn');
    expect(c.suggested).not.toContain('지누스');
    for (const name of ['베스트슬립', '웰퍼니처', '퀵슬립', '올라인매트리스', '휴도']) expect(reviewCopy(`${name} 비교`, D).findings.some((f) => f.ruleId === 'competitor')).toBe(true);
  });
  it('가격 표기 대조 — 진행 중 할인가 일치는 확인, 불일치 · 미존재 할인율은 차단 + 진행 중 가격으로 수정안', () => {
    const promo = D.promotions.find((p) => p.status === 'live' && p.channel === 'brandstore')!;
    const queen = D.products[0].options.find((o) => o.label === '퀸')!;
    const good = Math.round(queen.price * (1 - promo.discountRate / 100));
    expect(reviewCopy(`${promo.name} 퀸 ${fmt.int(good)}원`, D).level).toBe('check');
    const bad = reviewCopy(`가을 기획전 퀸 ${fmt.int(good - 49_500)}원`, D);
    expect(bad.level).toBe('block');
    expect(bad.prices[0].status).toBe('mismatch');
    const refs = priceReferences(D).filter((r) => r.status === 'live' && r.inStock).map((r) => `${fmt.int(r.amount)}원`);
    expect(refs.some((x) => bad.suggested.includes(x))).toBe(true);
    const rate = reviewCopy('가을 기획전 37% 할인', D);
    expect(rate.level).toBe('block');
    const maxLive = Math.max(...D.promotions.filter((p) => p.status === 'live' && p.end >= TODAY).map((p) => p.discountRate));
    expect(rate.suggested).toContain(`${maxLive}% 할인`);
  });
  it('예정 프로모션 할인율은 시작 전 노출 경고, 종료 프로모션 가격은 차단', () => {
    const planned = D.promotions.find((p) => p.status === 'planned')!;
    const r = reviewCopy(`${planned.discountRate}% 할인`, D);
    expect(r.prices[0].status).toBe('planned');
    expect(r.level).toBe('warn');
    const d2 = clone(D);
    d2.promotions.forEach((p) => { if (p.status === 'live') { p.status = 'ended'; p.end = addDays(TODAY, -1); } });
    const live = D.promotions.find((p) => p.status === 'live' && p.channel === 'brandstore')!;
    expect(reviewCopy(`${live.discountRate}% 할인`, d2).level).toBe('block');
  });
  it('시나리오: 품절 옵션(킹)을 언급한 문안은 경고 — 재고 데이터 대조', () => {
    const sold = D.products[0].options.find((o) => !o.inStock)!;
    const draft = VISUALTUNE_DRAFTS.find((x) => x.text.includes(sold.label))!;
    const r = reviewCopy(draft.text, D);
    expect(r.findings.some((f) => f.ruleId === 'soldout_option' && f.level === 'warn')).toBe(true);
    const d2 = clone(D);
    d2.products[0].options.forEach((o) => { o.inStock = true; });
    expect(reviewCopy(draft.text, d2).findings.some((f) => f.ruleId === 'soldout_option')).toBe(false);
  });
  it('글자수 기준 초과 → 경고', () => {
    const r = reviewCopy('경도로 고르는 신혼집 매트리스 추천', D, { limit: SA_CHAR_LIMITS.title });
    expect(r.findings.some((f) => f.ruleId === 'length')).toBe(true);
  });
  it('빈 문안 · 데이터 없음 · 상품 데이터 없음', () => {
    const e = reviewCopy('', D);
    expect(e.level).toBe('pass');
    expect(e.findings).toEqual([]);
    const n = reviewCopy('퀸 841,500원', null);
    expect(n.prices[0].status).toBe('unchecked');
    expect(n.level).toBe('check');
    const m = reviewCopy('퀸 841,500원', EMPTY);
    expect(m.level).toBe('check');
    expect(m.prices[0].status).toBe('unchecked');
    expect(applyFixes('', [])).toBe('');
  });
  it('검수 규칙은 화면에서 한글 이름으로 표기', () => {
    for (const rule of REVIEW_RULES) expect(ruleLabel(rule.id)).toMatch(/[가-힣]/);
    expect(ruleLabel('unknown_rule')).toBe('unknown_rule');
  });
  it('REVIEW_RULES 패턴은 그대로 사용 (6종 모두 매칭 가능)', () => {
    const samples: Record<string, string> = {
      medical_cure: '통증 완화', medical_device: '의료기기', superlative: '최고', absolute: '100%', price_claim: '10% 할인', competitor: '지누스',
    };
    for (const rule of REVIEW_RULES) expect(new RegExp(rule.pattern).test(samples[rule.id]), rule.id).toBe(true);
  });
  it('시나리오: 운영 문안 전체 검수 — VisualTune 초안의 의료 · 가격 불일치가 차단으로 잡힌다', () => {
    const r = reviewAll(D, collectCopies(D, demoTestCards(TODAY)));
    expect(r.total).toBe(r.rows.length);
    expect(r.count.block + r.count.warn + r.count.check + r.count.pass).toBe(r.total);
    const blocked = r.rows.filter((x) => x.result.level === 'block').map((x) => x.item.id);
    expect(blocked).toContain('vt:vt_1'); // 허리 통증 완화
    expect(blocked).toContain('vt:vt_3'); // 20% 할인 792,000원 — 진행 중 할인율 · 가격과 불일치
    expect(blocked).toContain('vt:vt_7'); // 의사 추천 · 척추 교정
    // 프로모션 소재 표기가(adCopyPrice)는 판매가 × (1 − 할인율)과 일치 → 차단 아님
    for (const p of D.promotions.filter((x) => Number.isFinite(x.adCopyPrice))) {
      const row = r.rows.find((x) => x.item.id === `promo:${p.id}`)!;
      expect(row.result.level).not.toBe('block');
      expect(Math.round(D.products[0].options.find((o) => o.label === '퀸')!.price * (1 - p.discountRate / 100))).toBe(p.adCopyPrice);
    }
    // 가설 A 예시 카피는 통과
    expect(r.rows.find((x) => x.item.id === 'hyp:A')!.result.level).toBe('pass');
  });
});

/* ---------------------------------------------------------------- */
/* 운영 루프 캘린더 (p.28)                                               */
/* ---------------------------------------------------------------- */

describe('운영 루프 캘린더', () => {
  it('영업일 계산 — 11월 3영업일 · 성탄절 다음 영업일', () => {
    expect(weekday('2026-11-01')).toBe(0);
    expect(nthBusinessDay(2026, 11, 3)).toBe('2026-11-04');
    expect(nextBusinessDay('2026-12-25')).toBe('2026-12-28');
    expect(nextBusinessDay('2026-11-02')).toBe('2026-11-02');
  });
  it('주간은 월요일(영업일), 월간은 3영업일, 테스트 종료 · 중단 점검은 카드 일정 그대로', () => {
    const cards = demoTestCards(TODAY);
    const cal = loopCalendar(TODAY, cards, {});
    expect(weekday(cal.from)).toBe(1);
    const weekly = cal.events.filter((e) => e.cadence === 'weekly');
    expect(weekly.length).toBe(8);
    for (const e of weekly) expect(e.shiftedFrom ? true : weekday(e.date) === 1).toBe(true);
    expect(cal.events.filter((e) => e.cadence === 'monthly').map((e) => e.date)).toContain('2026-11-04');
    for (const c of cards) {
      const end = addDays(c.start, c.plannedDays);
      if (end >= cal.from && end <= cal.to) expect(cal.events.some((e) => e.cadence === 'test_end' && e.ref === c.id && e.date === end)).toBe(true);
    }
    for (let i = 1; i < cal.events.length; i++) expect(cal.events[i - 1].date <= cal.events[i].date).toBe(true);
  });
  it('결정 후 2주 랩업 — 주말이면 다음 영업일로 이동 표기', () => {
    const cards = demoTestCards(TODAY);
    const cal = loopCalendar(TODAY, cards, { [cards[0].id]: { verdict: 'expand', at: TODAY, by: 'PM', note: '' } });
    const w = cal.events.find((e) => e.cadence === 'wrapup')!;
    const raw = addDays(TODAY, 14);
    expect(w.date).toBe(nextBusinessDay(raw));
    if (w.date !== raw) expect(w.shiftedFrom).toBe(raw);
  });
});

/* ---------------------------------------------------------------- */
/* 화면 요약 · 브리프 · 프롬프트                                         */
/* ---------------------------------------------------------------- */

describe('첫 화면 요약 · 오늘 처리할 항목', () => {
  const cards = demoTestCards(TODAY);
  it('시나리오: 검수 차단 · 카드 중단/확대 · 판정 대기 · 기한 경과 · 기획전 종료 · 미등록 구문이 데이터로 잡힌다', () => {
    const ov = labOverview(D, [], null, cards, {});
    const ids = ov.todos.map((t) => t.id);
    expect(ids).toContain('review-block');
    expect(ids.some((x) => x.startsWith('card-stop:'))).toBe(true);
    expect(ids.some((x) => x.startsWith('card-expand:'))).toBe(true);
    expect(ids).toContain('pipe-decide');
    expect(ids).toContain('pipe-overdue');
    expect(ids).toContain('disc-st');
    const ending = D.promotions.filter((p) => p.status === 'live' && p.end >= TODAY && (new Date(p.end).getTime() - new Date(TODAY).getTime()) / 86400000 <= 7);
    for (const p of ending) expect(ids).toContain(`promo-end:${p.id}`);
    for (let i = 1; i < ov.todos.length; i++) expect(ov.todos[i - 1].rank).toBeLessThanOrEqual(ov.todos[i].rank);
    for (const t of ov.todos) {
      expect(t.basis.length).toBeGreaterThan(0);
      noBad(t.title + t.basis);
    }
    expect(ov.tiles.discover.sku48).toBe(48);
    expect(ov.tiles.review.block).toBeGreaterThan(0);
    expect(ov.tiles.cards.total).toBe(cards.length);
  });
  it('결정한 카드는 할 일에서 빠지고, 역할 권한에 따라 내 승인 건이 달라진다', () => {
    const stop = cards.find((c) => judgeTestCard(c, TODAY).verdict === 'stop')!;
    const ov = labOverview(D, [], null, cards, { [stop.id]: { verdict: 'stop', at: TODAY, by: 'PM', note: '' } });
    expect(ov.todos.some((t) => t.id === `card-stop:${stop.id}`)).toBe(false);
    const pmReq = change({ ...registrationPayload(searchTermCandidates(D)[0], 'PM', LAB_BULK.pmFrom) });
    expect(labOverview(D, [pmReq], null, cards, {}, { role: '담당 AE' }).mine).toHaveLength(0);
    expect(labOverview(D, [pmReq], null, cards, {}, { role: 'PM' }).mine).toHaveLength(1);
  });
  it('권한: AE는 AE건, PM은 AE · PM건, 수면밀도는 전부', () => {
    expect(canApprove('담당 AE', 'AE').ok).toBe(true);
    expect(canApprove('담당 AE', 'PM').ok).toBe(false);
    expect(canApprove('담당 AE', 'PM').reason).toMatch(/PM 권한 필요/);
    expect(canApprove('PM', 'PM').ok).toBe(true);
    expect(canApprove('PM', 'CLIENT').ok).toBe(false);
    expect(canApprove('수면밀도', 'CLIENT').ok).toBe(true);
    expect(canApprove('', 'AE').ok).toBe(false);
  });
  it('빈 데이터에서도 요약 · 할 일 · 브리프 · 주간 초안이 예외 · NaN 없이 생성된다', () => {
    const ov = labOverview(EMPTY, [], null, [], {});
    expect(ov.pipeline).toEqual([]);
    expect(ov.tiles.discover.searchTerm).toBe(0);
    expect(ov.tiles.discover.sku48).toBe(48);
    noBad(ov.todos);
    noBad(weeklyDraft(EMPTY, [], null, [], []));
    noBad(labBrief(EMPTY, [], null, [], []));
    noBad(discoveryBrief(EMPTY, []));
    noBad(reviewBrief(EMPTY, [], []));
    noBad(creativeBrief(EMPTY, [], []));
  });
});

describe('브리프 · AI 프롬프트 문구 원칙', () => {
  const cards = demoTestCards(TODAY);
  const briefs = [pipelineBrief(D, []), discoveryBrief(D, []), reviewBrief(D, cards), creativeBrief(D, cards), labBrief(D, [], null, cards, [])];
  it('확정 팩트 · 반복 관측 패턴 · AI 해석 · 전제 조건 · 다음 액션이 채워지고 번호 매기기 · NaN 없음', () => {
    for (const b of briefs) {
      expect(b.facts.length).toBeGreaterThan(0);
      expect(b.conditions.length).toBeGreaterThan(0);
      expect(b.actions.length).toBeGreaterThan(0);
      const all = [...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions].join('\n');
      expect(all).not.toMatch(NUMBERED);
      noBad(all);
    }
  });
  it('판정 브리프는 데이터 수치를 인용하고 TEST DATA를 표기', () => {
    const b = pipelineBrief(D, []);
    expect(b.facts[0]).toMatch(/TEST DATA/);
    expect(b.conditions[0]).toMatch(/확장 ≥ 목표 ROAS 400%의 100%/);
  });
  it('AI 프롬프트는 데이터 스냅샷(JSON)과 의료 효능 금지를 포함', () => {
    const p = labPrompt(D, [], null, cards);
    expect(p).toMatch(/데이터\(JSON\)/);
    expect(p).toMatch(/의료 효능/);
    const json = p.slice(p.indexOf('{'));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.length).toBeLessThan(32_000);
    const wk = weeklyDraft(D, [], null, cards, []);
    expect(wk).toMatch(/### 확정 팩트/);
    expect(wk).not.toMatch(NUMBERED);
  });
});

describe('기준일 독립성', () => {
  it('다른 기준일 데이터에서도 같은 규칙으로 동작 (new Date() 의존 없음)', () => {
    const d2 = generateDemoData('2026-11-20', 10);
    const cards = demoTestCards(d2.today);
    const ov = labOverview(d2, [], null, cards, {});
    expect(ov.tiles.discover.sku48).toBe(48);
    for (const c of cards) expect(c.start < d2.today).toBe(true);
    noBad(ov.todos);
    const cand: Candidate[] = discoverCandidates(d2).all;
    expect(cand.length).toBeGreaterThan(48);
  });
});

/* ---------------------------------------------------------------- */
/* 리뷰 보강 — 저장 후보 갱신 · 기준값 연동 · 데이터 기반 문구 · 검수 보강     */
/* ---------------------------------------------------------------- */

describe('리뷰 보강: 저장된 AI 후보 · 기준값 연동', () => {
  const n = (v: number | null) => v ?? 0;
  it('AI 확장 후보는 저장 시점 상태가 아니라 현재 요청 이력으로 다시 계산 (등록 요청 후 중복 요청 방지)', () => {
    const ai = parseAiCandidates([{ phrase: '신혼부부 퀸 매트리스 경도 비교', monthly: 120 }], D, []);
    expect(ai).toHaveLength(1);
    expect(ai[0].status).toBe('new');
    const before = discoverCandidates(D, [], ai).all.find((c) => c.source === 'ai_expand')!;
    expect(before.status).toBe('new');
    const req = change({ ...registrationPayload(before, 'PM') });
    const after = discoverCandidates(D, [req], ai).all.find((c) => c.phrase === before.phrase)!;
    expect(after.status).toBe('requested');
    // 저장된 객체는 그대로지만 화면 계산은 최신 상태
    expect(ai[0].status).toBe('new');
    // 깨진 저장값(localStorage)도 예외 없이 걸러낸다
    const broken = [{ phrase: '' }, null, { phrase: 7 }] as unknown as Candidate[];
    expect(() => discoverCandidates(D, [], broken)).not.toThrow();
    expect(discoverCandidates(D, [], broken).all.some((c) => c.source === 'ai_expand')).toBe(false);
  });
  it('검색어 보고서 등록 구문은 발굴에서 빠지고 개수로 남는다', () => {
    const reg = D.searchTerms.filter((t) => t.registered).length;
    expect(reg).toBeGreaterThan(0);
    const r = discoverCandidates(D);
    expect(r.excludedRegistered).toBe(reg);
    for (const t of D.searchTerms.filter((x) => x.registered)) expect(r.all.some((c) => c.source === 'search_term' && c.phrase === t.term)).toBe(false);
  });
  it('판정 기한 경과는 편집한 기간 기준을 따르고, 조치를 요청하면 기한 경과에서 빠진다', () => {
    const base = buildPipeline(D, []);
    const od = base.filter((i) => i.overdue);
    expect(od.length).toBeGreaterThan(0);
    for (const i of od) expect(n(i.days)).toBeGreaterThan(LAB_DEFAULT_CRITERIA.minDays + 7);
    // 기간 기준을 30일로 늘리면 28일 집행 키워드는 기한 경과가 아니다
    expect(buildPipeline(D, [], { minDays: 30 }).filter((i) => i.overdue)).toHaveLength(0);
    // 보류 조치 요청(pending) → 기한 경과 해제, 반려되면 다시 기한 경과
    const first = od[0];
    const act = change({ ...decisionPayload(first, 'PM') });
    expect(buildPipeline(D, [act]).find((i) => i.id === first.id)!.overdue).toBe(false);
    expect(buildPipeline(D, [{ ...act, status: 'rejected' }]).find((i) => i.id === first.id)!.overdue).toBe(true);
    expect(pipelineSummary(buildPipeline(D, [act])).overdue).toBe(od.length - 1);
  });
  it('집행 중 판정의 다음 행동은 편집한 기준값을 그대로 표기', () => {
    const j = judgeKeywordTest(stats(10, 0, 10_000, 0), 3, { minDays: 21, minClicks: 150 });
    expect(j.verdict).toBe('running');
    expect(j.action).toContain('21일');
    expect(j.action).toContain('150회');
  });
  it('발굴 브리프는 편집한 목표 ROAS로 다시 계산한다', () => {
    const def = discoveryBrief(D, []);
    expect(def.facts[1]).toMatch(/일반 400%/);
    const hi = discoveryBrief(D, [], [], { targetRoas: 2000 });
    expect(hi.facts[1]).toMatch(/일반 2,000%/);
    const cnt = (b: ReturnType<typeof discoveryBrief>) => Number(b.facts[1].match(/100% 이상 (\d+)개/)![1]);
    const st = searchTermCandidates(D, [], 2000);
    expect(cnt(hi)).toBe(st.filter((c) => c.evidence!.ratioPct >= 100).length);
    expect(cnt(hi)).toBeLessThan(cnt(def));
  });
});

describe('리뷰 보강: 품절 옵션이 들어간 테스트 구문', () => {
  it('시나리오: 킹 옵션 품절(inStock=false) — 파이프라인 항목 메모와 판정 반영 요청 사유에 품절 표기', () => {
    const sold = D.products[0].options.find((o) => !o.inStock)!;
    const items = buildPipeline(D, []);
    const hit = items.filter((i) => i.phrase.includes(sold.label));
    expect(hit.length).toBeGreaterThan(0);
    for (const i of hit) expect(i.notes.some((x) => x.includes(`${sold.label} 옵션 품절`))).toBe(true);
    expect(decisionPayload(hit[0], 'PM').reason).toContain('품절');
    // 재고가 돌아오면 메모가 사라진다 (하드코딩 아님)
    const d2 = clone(D);
    d2.products.forEach((p) => p.options.forEach((o) => { o.inStock = true; }));
    for (const i of buildPipeline(d2, []).filter((x) => x.phrase.includes(sold.label))) expect(i.notes.some((x) => x.includes('품절'))).toBe(false);
  });
  it('발굴 브리프의 품절 문구는 데이터의 품절 옵션명을 쓴다', () => {
    const d2 = clone(D);
    d2.products[0].options.forEach((o) => { o.inStock = o.label !== '슈퍼싱글'; });
    const b = discoveryBrief(d2, []);
    const txt = [...b.patterns, ...b.actions].join(' ');
    expect(txt).toContain('슈퍼싱글');
    expect(txt).not.toMatch(/'킹' 옵션/);
    const none = clone(D);
    none.products.forEach((p) => p.options.forEach((o) => { o.inStock = true; }));
    expect(discoveryBrief(none, []).patterns.join(' ')).not.toMatch(/품절/);
  });
});

describe('리뷰 보강: 검수 에이전트', () => {
  it('단위 없는 수치 주장(6만)도 근거 확인 대상 · 가격(만 원)은 가격 대조로만', () => {
    const r = reviewCopy('누적 리뷰 6만 매트리스', D);
    expect(r.findings.some((f) => f.ruleId === 'numeric_claim' && f.match === '6만')).toBe(true);
    expect(r.level).toBe('check');
    const price = reviewCopy('퀸 99만 원', D);
    expect(price.findings.some((f) => f.ruleId === 'numeric_claim')).toBe(false);
    expect(price.findings.some((f) => f.ruleId === 'price_claim')).toBe(true);
    expect(reviewCopy('2026년 상반기 기준', D).findings.some((f) => f.ruleId === 'numeric_claim')).toBe(false);
    // 규칙 기반 가설 B 제목도 수치 주장으로 잡힌다
    const b = generateSaCopies(D, 'generic', 'B').find((c) => /6만/.test(c.title))!;
    expect(reviewCopy(b.title, D, { limit: SA_CHAR_LIMITS.title }).findings.some((f) => f.ruleId === 'numeric_claim')).toBe(true);
  });
  it('최상급 자동 수정안의 입력란은 출처로 인정하지 않는다 — 실제 근거를 채워야 확인 단계', () => {
    const r = reviewCopy('국내 판매 1위 매트리스', D);
    expect(r.level).toBe('warn');
    expect(r.changed).toBe(true);
    expect(r.suggested).toContain('[출처 · 집계 기간 입력]');
    expect(r.suggestedLevel).toBe('warn');
    const again = reviewCopy(r.suggested, D);
    expect(again.findings.find((f) => f.ruleId === 'superlative')!.suggestion).toMatch(/칸을 실제 출처/);
    expect(applyFixes(r.suggested, again.findings, D).match(/\[출처/g)).toHaveLength(1); // 입력란 중복 삽입 없음
    const filled = r.suggested.replace('[출처 · 집계 기간 입력]', ' (네이버 가구 부문 · 2026년 상반기 기준)');
    expect(reviewCopy(filled, D).findings.find((f) => f.ruleId === 'superlative')!.level).toBe('check');
  });
});

describe('리뷰 보강: 데이터 기반 브리프 문구', () => {
  const cards = demoTestCards(TODAY);
  it('판정 보류 반례 문구는 실제 클릭 · 전환 수치를 인용한다', () => {
    const b = pipelineBrief(D, []);
    const insuff = buildPipeline(D, []).filter((i) => i.judgement.verdict === 'insufficient' && i.judgement.ratioPct >= 100);
    expect(insuff.length).toBeGreaterThan(0);
    const clicks = insuff.map((i) => i.judgement.stats.clicks);
    expect(b.counter[0]).toContain(`클릭 ${fmt.int(Math.min(...clicks))}~${fmt.int(Math.max(...clicks))}회`);
    expect(b.counter[0]).toContain(`판정 최소 클릭 ${LAB_DEFAULT_CRITERIA.minJudgeClicks}회`);
    // 기한 경과 패턴은 일 평균 클릭을 데이터에서 계산
    expect(b.patterns[0]).toMatch(/일 평균 클릭 \d/);
  });
  it('중단 카드 해석은 카드 내용에 따라 달라진다 (기획전 랜딩이 아니면 기획전 문구 없음)', () => {
    const stop = cards.find((c) => judgeTestCard(c, TODAY).verdict === 'stop')!;
    const promo = creativeBrief(D, [stop]).interpretation.join(' ');
    expect(promo).toContain('기획전');
    const other = { ...stop, id: 'TX-1', variant: '사이즈 비교 상세', hypothesis: '사이즈 비교 상세로 보내면 전환율이 오른다' };
    const txt = creativeBrief(D, [other]).interpretation.join(' ');
    expect(judgeTestCard(other, TODAY).verdict).toBe('stop');
    expect(txt).not.toContain('기획전');
    expect(txt).toContain('랜딩 변경');
  });
  it('검수 브리프 패턴은 VisualTune 차단 사유를 집계해 쓴다', () => {
    const b = reviewBrief(D, cards);
    const r = reviewAll(D, collectCopies(D, cards));
    const vtBlocked = r.rows.filter((x) => x.item.id.startsWith('vt:') && x.result.level === 'block');
    expect(vtBlocked.length).toBeGreaterThan(0);
    expect(b.patterns[0]).toContain('VisualTune 초안의 차단 사유');
    expect(b.patterns[0]).toContain('의료 효능 암시');
    expect(b.patterns[0]).toContain('가격 · 할인 불일치');
    const noVt = reviewBrief(EMPTY, [], []);
    expect(noVt.patterns.join(' ')).not.toMatch(/가격 · 할인 불일치 \d/);
  });
  it('주간 브리프 초안은 글머리표 없이 단락으로 쓰고, 반례 섹션과 공휴일 이동 발송일을 포함', () => {
    const wk = weeklyDraft(D, [], null, cards, []);
    expect(wk).not.toMatch(/(^|\n)\s*[-*]\s/);
    expect(wk).toMatch(/### 반례 · 대체 시나리오/);
    // 11/2(월) 발송분 — 데이터 기준일 10/31(토) 다음 월요일
    expect(wk).toContain('11/2(월) 발송분');
    // 다음 월요일이 공휴일이면 다음 영업일 — 2027-02-08(월) 설날 연휴 · 02-09(화) 대체공휴일 → 2/10(수)
    const d2 = generateDemoData('2027-02-06', 15);
    expect(weeklyDraft(d2, [], null, [], [])).toContain('2/10(수) 발송분');
    expect(loopCalendar(d2.today, [], {}).events.find((e) => e.cadence === 'weekly' && e.date > d2.today)!.date).toBe('2027-02-10');
  });
});

describe('리뷰 보강: 수신 요청 · 카드 id · 기획전 영향 카드', () => {
  it('Growth 파일럿(예산 숫자) 요청도 금액으로 표기하고, 초안은 신규 매체 파일럿 지면', () => {
    const g = change({ module: 'growth', kind: 'test', target: '신규 매체 파일럿 · 지역 커뮤니티 · 당근 · 4주', targetId: 'growth-pilot:당근', before: '미집행', after: 250_000_000, approver: 'CLIENT', reason: '증분 매출 기준 확대 또는 중단' });
    const [x] = incomingTests([g]);
    expect(x.summary).toBe('미집행 → 2.5억원');
    expect(x.route).toBe('growth');
    const dr = incomingToDraft(x);
    expect(dr.media).toBe('신규 매체 파일럿');
    expect(dr.variant).toBe('2.5억원');
    expect(dr.intent).toBeNull();
    const w = change({ module: 'watch', kind: 'test', target: 'Meta · Advantage+ 타겟 정책 변화', targetId: 'ev_5', before: '실행안 (주간 리포트)', after: '소액 테스트 14일', reason: 'MILDO Watch 감지 → 영향 진단. 가설: 넓은 타겟 소재를 바꾸면 신규 CPA가 낮아진다.' });
    const wx = incomingTests([w])[0];
    expect(wx.origin).toBe('MILDO Watch');
    expect(incomingToDraft(wx).media).toBe('Meta · 넓은 타겟');
    expect(incomingToDraft(wx).hypothesis).toBe('넓은 타겟 소재를 바꾸면 신규 CPA가 낮아진다');
  });
  it('사용자 카드 id는 기존 카드 · 요청 이력과 겹치지 않는다 (Lab 기록 초기화 후 포함)', () => {
    expect(nextUserCardId([], [])).toBe('TC-U01');
    expect(nextUserCardId([{ id: 'TC-U01' }], [])).toBe('TC-U02');
    // 로컬 카드는 초기화됐지만 이력에 TC-U01 · TC-U02 요청이 남아 있으면 TC-U03
    expect(nextUserCardId([], [{ targetId: 'labcard:TC-U01' }, { targetId: 'labcard:TC-U02:decision' }, { targetId: 'labreg:x' }])).toBe('TC-U03');
  });
  it('종료 임박 기획전의 영향 카드는 기획전명 전체로 매칭한다', () => {
    const ov = labOverview(D, [], null, demoTestCards(TODAY), {});
    const promo = D.promotions.find((p) => p.status === 'live' && p.name.includes('기획전'))!;
    const todo = ov.todos.find((t) => t.id === `promo-end:${promo.id}`)!;
    const users = demoTestCards(TODAY).filter((c) => `${c.control} ${c.variant}`.includes(promo.name)).map((c) => c.id);
    expect(users.length).toBeGreaterThan(0);
    for (const id of users) expect(todo.basis).toContain(id);
    // 이름 첫 단어만 같은 카드(예: '가을 신상')는 영향 카드가 아니다
    const decoy = card({ id: 'TX-D', control: '가을 신상 소재', variant: '가을 신상 B' });
    const ov2 = labOverview(D, [], null, [decoy], {});
    expect(ov2.todos.find((t) => t.id === `promo-end:${promo.id}`)!.basis).not.toContain('TX-D');
  });
});

describe('리뷰 보강: 판정 경계 — 광고비 누락', () => {
  it('전환은 있는데 광고비가 0이면 제외가 아니라 판정 보류 (ROAS 계산 불가)', () => {
    const j = judgeKeywordTest(stats(120, 2, 0, 2_000_000), 14);
    expect(j.verdict).toBe('insufficient');
    expect(j.badge).toMatch(/광고비 데이터 없음/);
    noBad(j.badge + j.basis + j.action);
    // 전환 0 · 광고비 0은 그대로 '전환 없음' 제외
    expect(judgeKeywordTest(stats(120, 0, 0, 0), 14).verdict).toBe('exclude');
  });
});
