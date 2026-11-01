/**
 * MILDO Lab — MILDO Agent 도구 + 오프라인 브리프.
 * 읽기 도구는 상태를 바꾸지 않는다. lab_register_candidate만 ChangeRequest를 pending으로 만들고, 실제 등록은 사람이 승인한다.
 * 결과는 작은 plain JSON (숫자 반올림).
 */
import type { AgentTool } from '@/ai/claude';
import type { IntentId } from '@/core/types';
import { INTENT_IDS, SA_CAMPAIGNS } from '@/data/constants';
import type { ModuleAgentKit, ToolContext } from '../types';
import { demoTestCards, HYP_IDS, PATTERN_SEEDS, SA_CHAR_LIMITS, type HypId } from './data';
import {
  buildPipeline, candidateStatus, classifyIntent, collectCopies, creativeBrief, discoverCandidates, discoveryBrief, groupPools, INTENT_NAME,
  judgeTestCard, LANDING_LEVEL_META, parseAiCandidates, pipelineBrief, pipelineSummary, registrationPayload, resolveCriteria, reviewAll, reviewBrief, reviewCopy, rn,
  skuEntries, skuFormula, SOURCE_LABEL, generateSaCopies, type CandidateSource, type TestCard,
} from './engine';
import { getLab } from './store';

const SRC = 'TEST DATA (시연용 테스트 데이터) · 제안서 p.26–28 · p.36 기준';

function allCards(today: string): TestCard[] {
  return [...demoTestCards(today), ...getLab().userCards];
}
const isIntent = (v: unknown): v is IntentId => typeof v === 'string' && (INTENT_IDS as string[]).includes(v);
const isHyp = (v: unknown): v is HypId => typeof v === 'string' && (HYP_IDS as string[]).includes(v);
const SOURCES: CandidateSource[] = ['search_term', 'related', 'ai_query', 'sku48', 'ai_expand'];

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'lab_expand_keywords',
      description: 'MILDO Lab 롱테일 · 구문형 키워드 후보(검색어 보고서 미등록 · 연관 검색어 · AI 검색 질의 · SKU 확장 48 진입점)를 의도 분류 · 예상 검색량 · 랜딩 매칭 · 우선순위 점수와 함께 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['all', ...SOURCES], description: '후보 소스 (기본 all)' },
          intent: { type: 'string', enum: INTENT_IDS, description: '구매 의도 필터' },
          minScore: { type: 'number', description: '최소 우선순위 점수 (0~100)' },
          limit: { type: 'number', description: '최대 건수 (기본 15, 최대 48)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const crit = resolveCriteria(getLab().criteria);
        const { all, excludedExisting } = discoverCandidates(d, ctx.state.changes, getLab().aiCandidates, crit.targetRoas);
        const src = SOURCES.includes(inp.source as CandidateSource) ? (inp.source as CandidateSource) : null;
        const pool = src === 'sku48' ? skuEntries(d, ctx.state.changes, crit.targetRoas) : all;
        const limit = Math.min(48, Math.max(1, Number(inp.limit) || 15));
        const minScore = Number(inp.minScore) || 0;
        const rows = pool.filter((c) => (!src || c.source === src) && (!isIntent(inp.intent) || c.intent === inp.intent) && c.score >= minScore).slice(0, limit);
        const sku = skuEntries(d, ctx.state.changes, crit.targetRoas);
        const f = skuFormula();
        return {
          출처: SRC,
          공식: `제품 ${f.product} × 문제 ${f.problems} × 상황 ${f.situations} × 비교 ${f.criteria} = 검색 진입점 ${f.total}개 (p.36)`,
          소스별건수: Object.fromEntries(SOURCES.map((s) => [SOURCE_LABEL[s], all.filter((c) => c.source === s).length])),
          이미등록제외: excludedExisting,
          진입점48: { 우선: sku.filter((c) => c.tier === 'priority').length, 검토: sku.filter((c) => c.tier === 'review').length, 보류: sku.filter((c) => c.tier === 'hold').length, 랜딩매칭: sku.filter((c) => c.landing.level === 'good').length },
          점수기준: '검색량 40 + 랜딩 30 + 근거 20 + 구매 의도 10 (모듈 가정) · 70 이상 우선 · 50 이상 검토',
          후보: rows.map((c) => ({
            구문: c.phrase, 출처: SOURCE_LABEL[c.source], 근원: c.origin.slice(0, 60), 의도: INTENT_NAME(c.intent), 점수: c.score, 등급: c.tier,
            검색량: c.volume, 검색량근거: c.volumeNote, 랜딩: `${c.landing.label} · ${LANDING_LEVEL_META[c.landing.level].label}`, 랜딩메모: c.landing.notes.slice(0, 2),
            ROAS: c.evidence ? rn(c.evidence.roas) : null, 전환: c.evidence ? rn(c.evidence.conversions, 2) : null, 주의: c.flags, 상태: c.statusNote,
          })),
        };
      },
    },
    {
      name: 'lab_judge',
      description: 'MILDO Lab 테스트 판정을 반환합니다. 키워드 테스트 STEP 1~4(확장 ≥ 목표 ROAS 100% · 유지 70~100% · 제외 < 70% · 판정 보류)와 테스트 카드(두 비율 z-검정 p-value · 7일차 중단 · +15% 확대)를 근거 수치와 함께 돌려줍니다.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '특정 키워드 · 구문만 (부분 일치)' },
          cardId: { type: 'string', description: '특정 테스트 카드 id (예: TC-01)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const crit = resolveCriteria(getLab().criteria);
        const items = buildPipeline(d, ctx.state.changes, crit).filter((i) => !inp.keyword || i.phrase.includes(String(inp.keyword)));
        const cards = allCards(d.today).filter((c) => !inp.cardId || c.id === inp.cardId);
        const s = pipelineSummary(items);
        return {
          출처: SRC,
          판정기준: `확장 ≥ 목표 ROAS ${crit.targetRoas}%의 ${crit.expandAtPct}% · 유지 ${crit.keepFromPct}~${crit.expandAtPct}% · 제외 < ${crit.keepFromPct}% 또는 전환 없음 · ${crit.minDays}일 또는 클릭 ${crit.minClicks}회 · 판정 최소 클릭 ${crit.minJudgeClicks}(모듈 가정)`,
          단계별: s.byStep, 판정별: s.byVerdict,
          키워드: items.map((i) => ({
            키워드: i.phrase, 출처: i.sourceLabel, 그룹: i.adgroup, 단계: i.step, 판정: i.judgement.badge, 근거: i.judgement.basis, 다음: i.judgement.action,
            클릭: i.judgement.stats.clicks, 전환: rn(i.judgement.stats.conversions, 2), ROAS: rn(i.judgement.roas), 목표대비pct: rn(i.judgement.ratioPct), 일수: i.days, 주의: i.judgement.cautions,
            승인요청: i.decision ? i.decision.status : null,
          })),
          그룹합산: groupPools(items, crit).map((p) => ({ 그룹: p.adgroup, 건수: p.count, 클릭: p.stats.clicks, 전환: rn(p.stats.conversions, 2), 판정: p.judgement.badge })),
          테스트카드: cards.map((c) => {
            const j = judgeTestCard(c, d.today);
            const dec = getLab().decisions[c.id];
            return {
              id: c.id, 제목: c.title, 가설: c.hypothesis, 변수: c.variable, 매체: c.media, 판정: j.badge, 근거: j.basis, 다음: j.action,
              일수: `${j.dataDays}/${c.plannedDays}`, CVR: [rn(j.C.cvr, 2), rn(j.V.cvr, 2)], CTR: [rn(j.C.ctr, 2), rn(j.V.ctr, 2)], CVR상승pct: rn(j.liftCvr, 1), pCVR: rn(j.pCvr, 3), pCTR: rn(j.pCtr, 3),
              필요표본군당: rn(j.required), 현재표본군당: rn(j.have), 결정: dec ? `${dec.verdict} · ${dec.at}` : null,
            };
          }),
        };
      },
    },
    {
      name: 'lab_review_copy',
      description: '광고 문안을 검수 규칙(의료 효능 암시 · 최상급 · 절대 표현 · 가격 표기 판매가 대조 · 경쟁사명 · 품절 옵션 · 글자수)으로 검수해 차단/경고/확인 판정, 사유, 수정 제안을 반환합니다. text가 없으면 Lab 검수 대기 문안 전체 요약을 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '검수할 문안' },
          limit: { type: 'number', description: '글자수 기준 (제목 15 · 설명 45, 선택)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        if (typeof inp.text === 'string' && inp.text.trim()) {
          const r = reviewCopy(inp.text.slice(0, 400), d, { limit: Number(inp.limit) || undefined });
          return {
            출처: 'REVIEW_RULES (p.27 · p.35) + 상품 · 프로모션 데이터 대조 (TEST DATA)',
            문안: r.text, 판정: r.level, 지적: r.findings.map((f) => ({ 규칙: f.ruleId, 수준: f.level, 표현: f.match, 사유: f.reason, 수정: f.suggestion, 근거: f.basis })),
            가격대조: r.prices.map((p) => ({ 표기: p.raw, 결과: p.status, 기준: p.ref, 메모: p.note })),
            수정안: r.changed ? r.suggested : null, 수정안판정: r.changed ? r.suggestedLevel : null,
          };
        }
        const lab = getLab();
        const all = reviewAll(d, collectCopies(d, allCards(d.today), lab.aiCopies));
        return {
          출처: 'REVIEW_RULES + 데이터 대조 · VisualTune 초안은 DEMO',
          건수: all.count, 전체: all.total, 규칙별: all.byRule,
          차단경고: all.rows.filter((r) => r.result.level === 'block' || r.result.level === 'warn').map((r) => ({ 출처: r.item.source, 문안: r.item.text, 판정: r.result.level, 표현: r.result.findings.filter((f) => f.level === 'block' || f.level === 'warn').map((f) => f.match), 수정안: r.result.changed ? r.result.suggested : null })),
        };
      },
    },
    {
      name: 'lab_generate_copy',
      description: '네이버 SA 캠페인(브랜드 방어 · 일반 제품 · 문제 해결 · 비교 · 검토 · 생활 상황) × VisualTune 가설(A 기능 · B 리뷰 · 신뢰 · C 구매 혜택) 규칙 기반 파워링크 문안(제목 15자 · 설명 45자 검사)과 자동 검수 결과를 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign: { type: 'string', enum: INTENT_IDS, description: '캠페인 (기본 전체)' },
          hypothesis: { type: 'string', enum: HYP_IDS, description: '가설 A/B/C (기본 전체)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const camps = isIntent(inp.campaign) ? [inp.campaign] : INTENT_IDS;
        const hyps = isHyp(inp.hypothesis) ? [inp.hypothesis] : HYP_IDS;
        const out = [];
        for (const c of camps) for (const h of hyps) {
          for (const x of generateSaCopies(d, c, h)) {
            const rt = reviewCopy(x.title, d, { limit: SA_CHAR_LIMITS.title });
            const rd = reviewCopy(x.description, d, { limit: SA_CHAR_LIMITS.description });
            out.push({ 캠페인: SA_CAMPAIGNS[c].name, 가설: h, 제목: x.title, 제목자수: x.titleLen, 설명: x.description, 설명자수: x.descLen, 검수: [rt.level, rd.level] });
          }
        }
        return { 출처: '규칙 기반 생성 · 프로모션 가격은 데이터에서 계산 (TEST DATA)', 기준: `제목 ${SA_CHAR_LIMITS.title}자 · 설명 ${SA_CHAR_LIMITS.description}자 (공백 포함)`, 문안: out.slice(0, 45) };
      },
    },
    {
      name: 'lab_register_candidate',
      description: '구문형 키워드 후보를 테스트 전용 그룹 등록 요청(ChangeRequest, pending)으로 만듭니다. 실제 등록은 담당 AE 승인 후 반영됩니다. 이미 등록 · 요청된 구문은 만들지 않고 상태를 알려줍니다.',
      inputSchema: {
        type: 'object',
        properties: { phrase: { type: 'string', description: '등록 요청할 구문형 키워드' } },
        required: ['phrase'],
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const phrase = String(inp.phrase ?? '').replace(/\s+/g, ' ').trim();
        if (phrase.length < 2) return { 결과: '실패', 사유: '구문이 비어 있습니다' };
        const st = candidateStatus(d, ctx.state.changes, phrase);
        if (st.status !== 'new' && st.status !== 'rejected') return { 결과: '생성 안 함', 상태: st.note };
        if (!classifyIntent(phrase).purchase) return { 결과: '생성 안 함', 사유: '구매 의도 낮음 (폐기 · 렌탈 등) — 제외 키워드 후보' };
        const { all } = discoverCandidates(d, ctx.state.changes, getLab().aiCandidates);
        const cand = all.find((c) => c.phrase.replace(/\s+/g, '') === phrase.replace(/\s+/g, '')) ?? parseAiCandidates([phrase], d, ctx.state.changes)[0];
        if (!cand) return { 결과: '실패', 사유: '구문 형식을 확인하세요 (한글 포함 3~40자)' };
        const payload = registrationPayload(cand, 'MILDO Agent');
        const ch = ctx.actions.addChange(payload);
        return { 결과: '승인 요청 생성 (pending)', id: ch.id, 승인: payload.approver, 대상: payload.target, 내용: payload.after, 사유: payload.reason };
      },
    },
  ],
  briefs: [
    {
      id: 'lab-pipeline',
      match: /(테스트.*(판정|결과|파이프라인)|판정.*(키워드|테스트)|랩업|확장.*유지.*제외|mildo\s?lab|lab\s?판정|테스트 그룹)/i,
      build: (ctx) => pipelineBrief(ctx.state.data, ctx.state.changes, getLab().criteria),
    },
    {
      id: 'lab-discover',
      match: /(롱테일|구문형|키워드.*(발굴|후보|확장)|48|진입점|검색어 보고서|sku)/i,
      build: (ctx) => discoveryBrief(ctx.state.data, ctx.state.changes, getLab().aiCandidates),
    },
    {
      id: 'lab-review',
      match: /(검수|문안|카피|광고 문구|의료\s?효능|표시광고|최상급)/,
      build: (ctx) => reviewBrief(ctx.state.data, allCards(ctx.state.data.today), getLab().aiCopies),
    },
    {
      id: 'lab-creative',
      match: /(visualtune|소재\s?테스트|크리에이티브|테스트 카드|가설\s?[abc]|a\/b)/i,
      build: (ctx) => creativeBrief(ctx.state.data, allCards(ctx.state.data.today), [...PATTERN_SEEDS, ...getLab().library]),
    },
  ],
};
