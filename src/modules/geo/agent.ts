/**
 * SearchTuneOS · GEO — MILDO Agent 도구 + 오프라인 브리프.
 * 읽기 도구는 상태를 바꾸지 않는다. geo_request_keyword만 ChangeRequest를 pending으로 만든다 (반영은 사람이 승인).
 * 결과는 작은 plain JSON (32KB 이하, 숫자 반올림, NaN 대신 null).
 */
import type { AgentTool } from '@/ai/claude';
import type { IntentId } from '@/core/types';
import type { ModuleAgentKit, ToolContext } from '../types';
import { AEO_TOPICS, GEO_PRINCIPLE, GEO_RULES, type AeoTopicId, type GeoEngineId } from './data';
import {
  auditBrief, auditHtml, buildFaqDraft, buildGeoSnapshot, faqBrief, faqCoverage, faqJsonLd, liveSummary, paidBrief, paidSummary,
  paidSurfaceRows, parseAiAnswer, QUERY_BY_ID, reviewFaq, round, sampleProductHtml, STATUS_LABEL, visibilityBrief, visibilitySummary,
  type PaidRow,
} from './engine';
import { latestByQuery, loadLive } from './persist';

const SRC = 'TEST DATA (GEO 진단 스냅샷 · 운영 데이터 모두 시연용) · 제안서 p.29';
const { r0, r1, pct } = round;
const INTENTS: IntentId[] = ['brand', 'generic', 'problem', 'compare', 'life'];
const ENGINE_IDS: GeoEngineId[] = ['chatgpt', 'gemini', 'perplexity', 'naver_ai', 'google_aio'];

function snapOf(ctx: ToolContext) {
  return buildGeoSnapshot(ctx.state.data.today);
}
function roundIndexOf(v: unknown, n: number): number | undefined {
  const i = Number(v);
  return Number.isInteger(i) && i >= 0 && i < n ? i : undefined;
}

/** 질의 텍스트 또는 id → 페이드 지면 행 */
function findPaidRow(rows: PaidRow[], q: unknown): PaidRow | null {
  const s = String(q ?? '').trim();
  if (!s) return null;
  return rows.find((r) => r.query.id === s) ?? rows.find((r) => r.query.text === s) ?? rows.find((r) => r.term?.term === s)
    ?? rows.find((r) => r.query.text.includes(s) || s.includes(r.query.text)) ?? null;
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'geo_visibility',
      description: 'AI 검색(ChatGPT · Gemini · Perplexity · 네이버 AI 브리핑 · Google AI 개요) 질의 20개 정기 진단 결과를 반환합니다: 브랜드 언급률 · 평균 언급 순서 · 자사 인용 수 · 경쟁 6개사 대비 점유, 엔진별 · 의도별 언급률, 질의별 판정(확보/부분/미노출), 경쟁사 우위 질의, 4회 반복 관측 안정성, Claude 라이브 진단 기록.',
      inputSchema: {
        type: 'object',
        properties: {
          round: { type: 'integer', description: '진단 회차 0~3 (기본 최신 3)' },
          engine: { type: 'string', enum: ENGINE_IDS, description: '특정 엔진만 질의별 결과 표시' },
          intent: { type: 'string', enum: INTENTS, description: '구매 의도 필터 (brand · generic · problem · compare · life)' },
        },
      },
      execute: (inp) => {
        const snap = snapOf(ctx);
        const vis = visibilitySummary(snap, roundIndexOf(inp.round, snap.rounds.length));
        const intent = INTENTS.includes(inp.intent as IntentId) ? (inp.intent as IntentId) : null;
        const engine = ENGINE_IDS.includes(inp.engine as GeoEngineId) ? (inp.engine as GeoEngineId) : null;
        const live = loadLive();
        const latest = latestByQuery(live);
        return {
          출처: SRC,
          원칙: GEO_PRINCIPLE,
          진단일: vis.date, 직전진단일: vis.prevDate, 회차: vis.rounds,
          전체: {
            언급셀: vis.overall.mentioned, 전체셀: vis.overall.total, 언급률pct: pct(vis.overall.rate), 직전대비pp: vis.overall.deltaPp !== null ? r1(vis.overall.deltaPp) : null,
            평균언급순서: r1(vis.overall.avgPosition), 첫번째언급비중pct: pct(vis.overall.firstRate), 인용: vis.overall.citations, 자사인용: vis.overall.ownedCitations,
            경쟁사대비점유pct: pct(vis.overall.sov), 확보질의: vis.overall.covered, 부분질의: vis.overall.partial, 미노출질의: vis.overall.none,
          },
          엔진: vis.engines.map((e) => ({ 엔진: e.name, 언급률pct: pct(e.rate), 직전대비pp: e.deltaPp !== null ? r1(e.deltaPp) : null, 평균순서: r1(e.avgPosition), 인용: e.citations, 자사인용: e.ownedCitations, 판정: `${e.verdict.label} · ${e.verdict.basis}` })),
          의도별: vis.byIntent.map((b) => ({ 의도: b.label, 언급률pct: pct(b.rate), 셀: b.total })),
          경쟁사: vis.competitors.map((c) => ({ 이름: c.name, 언급셀: c.mentions, 언급엔진: c.engines, 자사보다먼저: c.aheadOfBrand })),
          질의: vis.queries.filter((q) => !intent || q.query.intent === intent).map((q) => ({
            id: q.query.id, 질의: q.query.text, 의도: q.query.intent,
            판정: `${q.status.label} · ${q.status.basis}`, 경쟁사우위: q.gap,
            ...(engine ? { [engine]: q.cells[engine] ? { 언급: q.cells[engine]!.mentioned, 순서: q.cells[engine]!.position, 경쟁사: q.cells[engine]!.competitors, 인용: q.cells[engine]!.citations.map((c) => c.domain) } : null } : { 최다경쟁사: q.topCompetitor, 자사인용: q.ownedCitations }),
            Claude: latest[q.query.id] ? { 언급: latest[q.query.id].mentioned, 순서: latest[q.query.id].position, 경쟁사: latest[q.query.id].competitors, at: latest[q.query.id].at } : null,
          })),
          경쟁사우위질의: vis.gaps.map((g) => `${g.query.text} (${g.gapBasis})`),
          반복관측: { 안정: vis.stability.stable, 변동: vis.stability.volatile, 미언급: vis.stability.never, 회차: vis.stability.rounds, 기준: `최근 4회 중 ${GEO_RULES.stableRounds}회 이상 = 안정` },
          Claude라이브: (() => {
            const ls = liveSummary(live);
            return { 질의수: ls.count, 언급: ls.mentioned, 언급률pct: ls.count ? pct(ls.rate) : null, 평균순서: r1(ls.avgPosition), 비고: 'Claude 응답 기준 진단 · 다른 엔진은 수집 연동 필요' };
          })(),
        };
      },
    },
    {
      name: 'geo_audit_page',
      description: '제품페이지 HTML을 진단합니다 (title 길이 · meta description · og 태그 · h1 · 이미지 ALT 누락률 · JSON-LD Product(name/brand/offers.price/aggregateRating) · 화면 가격과 offers.price 일치 · 판매 데이터 판매가/재고 대조 · FAQPage · AEO 주제 · 의료 효능 문구 검수). html을 주지 않으면 운영 데이터로 만든 샘플 페이지(variant: defect 결함 포함 / fixed 개선안)를 진단합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          html: { type: 'string', description: '진단할 제품페이지 HTML (생략 시 샘플)' },
          variant: { type: 'string', enum: ['defect', 'fixed'], description: '샘플 종류 (기본 defect)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const html = typeof inp.html === 'string' && inp.html.trim() ? inp.html.slice(0, 400_000) : sampleProductHtml(d, inp.variant === 'fixed' ? 'fixed' : 'defect');
        const a = auditHtml(html, d);
        return {
          출처: typeof inp.html === 'string' && inp.html.trim() ? '입력 HTML · 판매가/재고 대조는 TEST DATA' : `${SRC} · 샘플 ${inp.variant === 'fixed' ? '개선안' : '결함 포함'}`,
          점수: a.score, 판정: `${a.grade.label} · ${a.grade.basis}`,
          집계: { 통과: a.counts.pass, 개선: a.counts.warn, 실패: a.counts.fail, 해당없음: a.counts.na },
          운영데이터대조: { 상품: a.matched.product, 채널: a.matched.channel, 진행프로모션: a.matched.promo, 할인율pct: a.matched.discountRate },
          항목: a.checks.map((c) => ({ id: c.id, 축: c.axis, 항목: c.label, 판정: STATUS_LABEL[c.status], 측정: c.measured, 기준: c.basis, 개선안: c.fix })),
          검수: a.review.map((h) => ({ 수준: h.level, 표현: h.match, 사유: h.reason })),
          원칙: GEO_PRINCIPLE,
        };
      },
    },
    {
      name: 'geo_faq',
      description: 'AEO FAQ 초안(경도 · 소재 · 사이즈 · 선택 기준 · 브랜드)을 규칙 기반으로 만들고 REVIEW_RULES로 검수한 결과와 FAQPage JSON-LD를 반환합니다. 사이즈 · 가격은 운영 데이터에서, 확인되지 않은 사양은 [입력] 자리표시로 남깁니다. 브랜드 언급이 약한 질의 대응 여부를 함께 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          topics: { type: 'array', items: { type: 'string', enum: AEO_TOPICS.map((t) => t.id) }, description: '주제 필터 (hardness · material · size · criteria · brand)' },
          includeJsonLd: { type: 'boolean', description: 'FAQPage JSON-LD 포함 (기본 true · 게시 가능 문항만)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const topics = Array.isArray(inp.topics) ? (inp.topics.filter((t) => AEO_TOPICS.some((x) => x.id === t)) as AeoTopicId[]) : [];
        const all = reviewFaq(buildFaqDraft(d));
        const items = topics.length ? all.filter((i) => topics.includes(i.topic)) : all;
        const vis = visibilitySummary(snapOf(ctx));
        const cov = faqCoverage(all, vis);
        const ld = faqJsonLd(items, true);
        return {
          출처: `${SRC} · 사이즈 · 가격은 운영 데이터`,
          집계: { 문항: items.length, 게시가능: items.filter((i) => i.publishable).length, 입력필요: items.filter((i) => i.placeholders.length).length, 차단: items.filter((i) => i.level === 'block').length, 핵심주제충족: `${cov.coreCovered}/${cov.coreTotal}` },
          문항: items.map((i) => ({ id: i.id, 주제: AEO_TOPICS.find((t) => t.id === i.topic)?.label, 질문: i.q, 답변: i.a, 검수: `${i.status.label} · ${i.status.basis}`, 미입력: i.placeholders, 대응질의: i.queries.map((q) => QUERY_BY_ID[q]?.text).filter(Boolean) })),
          약한질의대응: { 게시가능FAQ로대응: cov.covered.map((q) => q.query.text), 초안만있음: cov.drafted.map((q) => q.query.text), 대응없음: cov.uncovered.map((q) => q.query.text) },
          ...(inp.includeJsonLd === false ? {} : { FAQPage_JSON_LD: ld.json, JSON_LD_포함: ld.included, JSON_LD_제외: ld.excluded }),
        };
      },
    },
    {
      name: 'geo_paid_surface',
      description: '페이드 AI 지면 점검: 질의별 네이버 AI 브리핑 언급 · 쇼핑 지면 노출(데모 스냅샷)과 연결된 SA 키워드(ROAS · 목표 대비 · 노출 기회 손실 · 순위 · 품절 랜딩 · CPC 급변), 검색어 보고서(등록 여부 · 전환)를 묶어 SA 반영 판정(테스트 그룹 등록 후보 · 랜딩 점검 · 자동 조정 보류 · 노출 유지 등)을 반환합니다.',
      inputSchema: { type: 'object', properties: { onlyActions: { type: 'boolean', description: 'true면 유지 외 판정만 (기본 false)' } } },
      execute: (inp) => {
        const rows = paidSurfaceRows(ctx.state.data, snapOf(ctx));
        const s = paidSummary(rows);
        return {
          출처: `${SRC} · SA 키워드 · 검색어 보고서는 운영 데이터`,
          집계: s,
          질의: rows.filter((r) => !inp.onlyActions || r.action.id !== 'keep').map((r) => ({
            id: r.query.id, 질의: r.query.text,
            AI브리핑: r.naverAi ? (r.naverAi.mentioned ? `언급 ${r.naverAi.position}번째` : `미언급 · 경쟁사 ${r.naverAi.competitors.length}`) : null,
            쇼핑지면: r.shopping.exposed ? `${r.shopping.rank}위` : '미노출',
            SA키워드: r.kw ? { 키워드: r.kw.text, 상태: r.kw.status, ROAS: r0(r.kw.roas), 목표: r.kw.targetRoas, 목표대비pct: pct(r.kw.roasRatio), 노출손실pct: pct(r.kw.lost), 순위: r.kw.avgRank, CPC변화pct: r0(r.kw.cpcChangePct), 품절옵션: r.kw.soldOutOption } : null,
            검색어: r.term ? { 검색어: r.term.term, 등록: r.term.registered, 클릭: r.term.clicks, 전환: r1(r.term.conversions), ROAS: r0(r.term.roas) } : null,
            판정: r.action.label, 근거: r.action.basis, SA반영요청가능: r.requestable,
          })),
        };
      },
    },
    {
      name: 'geo_parse_answer',
      description: 'AI 답변 텍스트에서 수면밀도 언급 여부 · 언급 순서 · 경쟁 6개사 및 기타 브랜드 언급 · 인용 URL(자사 여부)을 파싱합니다. 단독 "밀도"는 소재 밀도와 구분되지 않아 확인 필요로 따로 셉니다.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'AI 답변 원문' }, query: { type: 'string', description: '질의 (선택)' } }, required: ['text'] },
      execute: (inp) => {
        const p = parseAiAnswer(String(inp.text ?? '').slice(0, 60_000));
        return { 질의: typeof inp.query === 'string' ? inp.query : null, 언급: p.mentioned, 브랜드표현수: p.brandHits, 확인필요밀도: p.ambiguous, 순서: p.position, 등장순서: p.order, 경쟁사: p.competitors, 기타브랜드: p.others, 인용: p.citations, 발췌: p.excerpt };
      },
    },
    {
      name: 'geo_request_keyword',
      description: '페이드 AI 지면 판정이 "SA 테스트 그룹 등록 후보"인 질의의 검색어를 SA 테스트 그룹 등록 요청(ChangeRequest, pending · 담당 AE 승인)으로 올립니다. 실제 반영은 사람이 MILDO Flow에서 승인합니다.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: '질의 텍스트 · 질의 id(q01~q20) · 검색어' } }, required: ['query'] },
      execute: (inp) => {
        const rows = paidSurfaceRows(ctx.state.data, snapOf(ctx));
        const r = findPaidRow(rows, inp.query);
        if (!r) return { ok: false, 사유: '질의를 찾지 못했습니다', 후보: rows.filter((x) => x.requestable).map((x) => x.query.text) };
        if (!r.requestable || !r.term) return { ok: false, 사유: `판정이 '${r.action.label}'입니다 (${r.action.basis}) · 등록 요청 대상 아님`, 후보: rows.filter((x) => x.requestable).map((x) => x.query.text) };
        const dup = ctx.state.changes.find((c) => c.module === 'geo' && c.kind === 'keyword_add' && c.target === r.term!.term && (c.status === 'pending' || c.status === 'approved' || c.status === 'applied'));
        if (dup) return { ok: false, 사유: '이미 요청된 검색어입니다', 요청id: dup.id, 상태: dup.status };
        const c = ctx.actions.addChange({
          module: 'geo', kind: 'keyword_add', target: r.term.term, before: '미등록 (검색어 보고서)', after: '테스트 그룹 등록 · 입찰 상한 적용',
          reason: `GEO 질의 '${r.query.text}' · ${r.action.basis} · AI 브리핑 ${r.naverAi?.mentioned ? '언급' : '미언급'} (TEST DATA)`,
          requestedBy: 'SearchTuneOS', approver: 'AE',
        });
        return { ok: true, 요청id: c.id, 상태: c.status, 승인: '담당 AE (승인 범위 내 운영 조정 · p.53)', 대상: r.term.term };
      },
    },
  ],
  briefs: [
    {
      id: 'geo_visibility',
      match: /(GEO|AI\s?검색|언급률|브랜드\s?언급|인용\s?출처|ChatGPT|챗GPT|Gemini|제미나이|Perplexity|퍼플렉시티|AI\s?브리핑|AI\s?개요|SearchTune|서치튠|생성형\s?검색)/i,
      build: (ctx) => visibilityBrief(visibilitySummary(buildGeoSnapshot(ctx.state.data.today)), loadLive()),
    },
    {
      id: 'geo_audit',
      match: /(제품\s?페이지|상세\s?페이지|SEO|구조화\s?데이터|JSON-?LD|스키마|메타\s?태그|메타\s?설명|ALT|og\s?태그)/i,
      build: (ctx) => auditBrief(auditHtml(sampleProductHtml(ctx.state.data, 'defect'), ctx.state.data)),
    },
    {
      id: 'geo_faq',
      match: /(FAQ|AEO|자주\s?묻는|FAQPage)/i,
      build: (ctx) => faqBrief(reviewFaq(buildFaqDraft(ctx.state.data)), visibilitySummary(buildGeoSnapshot(ctx.state.data.today))),
    },
    {
      id: 'geo_paid',
      match: /(AI\s?요약|쇼핑\s?지면|페이드\s?AI|AI\s?지면|SA\s?반영)/i,
      build: (ctx) => paidBrief(paidSurfaceRows(ctx.state.data, buildGeoSnapshot(ctx.state.data.today))),
    },
  ],
};
