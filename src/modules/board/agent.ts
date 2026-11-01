/**
 * MILDO Board — MILDO Agent 도구 + 오프라인 브리프.
 * 도구는 모두 읽기 전용이다 (상태를 바꾸지 않음). 결과는 작은 plain JSON, 숫자는 반올림.
 */
import type { AgentTool } from '@/ai/claude';
import type { IntentId, MediaId } from '@/core/types';
import { INTENT_IDS, MEDIA, MEDIA_IDS } from '@/data/constants';
import type { ModuleAgentKit, ToolContext } from '../types';
import {
  BOARD_PERIOD_IDS, boardKpis, budgetPacing, channelBrief, channelRows, clock, collectionSummary, dataBrief, filterKeywords, groupRollup,
  hourWeekHeatmap, intentRollup, isBoardPeriod, keywordBrief, keywordRows, keywordSummary, mediaComparison, pacingBrief, periodBrief,
  reconciliation, round, sortKeywords, sourceStatuses, validationChecks, type BoardPeriod, type HeatMetric, type KeywordFilter, type KeywordSort,
} from './engine';
import { BOARD_RULES } from './data';

const { r0, r1, r2 } = round;
const pct = (v: number) => r1(v * 100);
const SRC = 'TEST DATA (시연용 테스트 데이터) · 제안서 p.12–13 기준';

function periodOf(v: unknown): BoardPeriod {
  return isBoardPeriod(v) ? v : 'last7';
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx: ToolContext): AgentTool[] => [
    {
      name: 'board_summary',
      description: 'MILDO Board 기간 KPI(광고비 · 광고 매출 · ROAS · 판매 채널 실매출 · MER · CPA · CVR · 신규 CAC, 직전 기간 대비)와 6개 매체 동일 기준 비교(역할 · 판단 지표 · 변동 판정), 판매 채널별 실매출을 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: BOARD_PERIOD_IDS, description: '기간 (어제 yesterday · 최근 7/14/30일 last7/last14/last30 · 이번 달 mtd, 기본 last7)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const k = boardKpis(d, periodOf(inp.period));
        const rec = reconciliation(d, k.win);
        return {
          출처: SRC,
          기간: { 이름: k.win.label, 범위: `${k.win.from}~${k.win.to}`, 직전: `${k.win.prevFrom}~${k.win.prevTo}`, 오늘부분일포함: k.win.includesToday },
          KPI: {
            광고비: r0(k.cur.cost), 광고비증감pct: r1(k.deltas.cost), 광고매출: r0(k.cur.revenue), ROAS: r0(k.cur.roas), ROAS증감pct: r1(k.deltas.roas),
            실매출: r0(k.sales), 실매출증감pct: r1(k.deltas.sales), MER배: r2(k.mer), 직전MER배: r2(k.prevMer), 광고경유비중pct: pct(k.adShareOfSales),
            CPA: r0(k.cur.cpa), CPA증감pct: r1(k.deltas.cpa), CVRpct: r2(k.cur.cvr), CVR증감pct: r1(k.deltas.cvr), 신규CAC: r0(k.cur.cac), 신규고객: r0(k.cur.newCustomers),
          },
          매출대조: { 매체집계광고매출: r0(rec.mediaRevenue), 채널광고경유추정: r0(rec.channelAdRevenue), 차이pct: r1(rec.gapPct), 허용pct: BOARD_RULES.reconTolerancePct },
          매체: mediaComparison(d, k.win).map((m) => ({
            매체: m.name, 역할: m.role, 판단지표: `${m.judgeMetric} → ${m.judge.value}`, 광고비: r0(m.cost), 비중pct: pct(m.share), 가안비중pct: pct(m.planShare),
            매출: r0(m.revenue), ROAS: r0(m.roas), CPA: r0(m.cpa), CVRpct: r2(m.cvr), 신규비중pct: pct(m.newShare),
            ROAS증감pct: r1(m.deltas.roas), CPA증감pct: r1(m.deltas.cpa), 변동판정: `${m.flag.label} · ${m.flag.basis}`,
          })),
          판매채널: channelRows(d, k.win).map((c) => ({ 채널: c.name, 매출: r0(c.revenue), 비중pct: pct(c.share), 주문: r0(c.orders), CVRpct: r2(c.cvr), 객단가: r0(c.aov), 광고경유pct: pct(c.adShare), 매출증감pct: r1(c.revenueDelta) })),
        };
      },
    },
    {
      name: 'board_keywords',
      description: '네이버 SA 키워드를 구매 의도 · 상태 · 제품군 · 검색어 · 신호로 필터해 상위 키워드(최근 7/14일 성과, 직전 대비, 목표 ROAS 대비 판정, 품절 랜딩 · CPC 급변 등 신호)와 의도별 묶음 합계를 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: INTENT_IDS, description: '구매 의도 (brand 브랜드 방어 · generic 일반 제품 · problem 문제 해결 · compare 비교 · 검토 · life 생활 상황)' },
          status: { type: 'string', enum: ['all', 'on', 'test'], description: '키워드 상태 (기본 all)' },
          query: { type: 'string', description: '키워드 텍스트 일부' },
          size: { type: 'string', description: '제품군(사이즈) 라벨: 슈퍼싱글 · 퀸 · 킹 · 사이즈 미지정' },
          signal: { type: 'string', enum: ['all', 'any', 'soldout', 'cpc_spike', 'conv_drop', 'opportunity', 'new', 'no_conv'], description: '신호 필터 (any = 신호 있는 키워드)' },
          sort: { type: 'string', enum: ['cost', 'revenue', 'roas', 'conversions', 'costDelta', 'ratio', 'lost'], description: '정렬 기준 (기본 cost)' },
          window: { type: 'number', enum: [7, 14], description: '집계 창 일수 (기본 14)' },
          limit: { type: 'number', description: '최대 건수 (기본 15, 최대 40)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const window = Number(inp.window) === 7 ? 7 : 14;
        const size = typeof inp.size === 'string' && inp.size ? String(inp.size) : '';
        const f: KeywordFilter = {
          intents: typeof inp.intent === 'string' && (INTENT_IDS as string[]).includes(inp.intent) ? [inp.intent as IntentId] : undefined,
          status: inp.status === 'on' || inp.status === 'test' ? inp.status : 'all',
          query: typeof inp.query === 'string' ? inp.query : undefined,
          group: size ? (size === '사이즈 미지정' ? 'none' : `size:${size}`) : 'all',
          signal: typeof inp.signal === 'string' ? (inp.signal as KeywordFilter['signal']) : 'all',
        };
        const sort = (['cost', 'revenue', 'roas', 'conversions', 'costDelta', 'ratio', 'lost'] as const).includes(inp.sort as KeywordSort) ? (inp.sort as KeywordSort) : 'cost';
        const limit = Math.max(1, Math.min(40, Number(inp.limit) || 15));
        const rows = filterKeywords(keywordRows(d, window), f);
        const s = keywordSummary(rows);
        return {
          출처: SRC,
          조건: { 창: `최근 ${window}일 vs 직전 ${window}일`, 의도: f.intents?.[0] ?? '전체', 상태: f.status, 제품군: size || '전체', 검색어: f.query ?? '', 신호: f.signal, 정렬: sort },
          기준: { 목표ROAS: BOARD_RULES.targetRoas, 브랜드목표ROAS: BOARD_RULES.brandTargetRoas, 고효율pct: Math.round(BOARD_RULES.highEfficiencyRatio * 100), 노출손실기준pct: Math.round(BOARD_RULES.lostShareTrigger * 100), 급변pct: BOARD_RULES.keywordAnomalyPct, 판정최소전환: BOARD_RULES.minConversionsForVerdict },
          요약: { 키워드수: s.count, 광고비: r0(s.cur.cost), 매출: r0(s.cur.revenue), ROAS: r0(s.roas), 전환: r1(s.cur.conversions), CPA: r0(s.cpa), 광고비증감pct: r1(s.costDelta), ROAS증감pct: r1(s.roasDelta) },
          의도별: intentRollup(rows).map((r) => ({ 의도: r.label, 키워드수: r.count, 광고비: r0(r.cur.cost), 비중pct: pct(r.costShare), ROAS: r0(r.roas), 전환: r1(r.cur.conversions) })),
          제품군별: groupRollup(rows, d.products).map((r) => ({ 제품군: r.label, 재고: r.inStock === null ? '해당 없음' : r.inStock ? '정상' : '품절', 키워드수: r.count, 광고비: r0(r.cur.cost), ROAS: r0(r.roas) })),
          키워드: sortKeywords(rows, sort).slice(0, limit).map((r) => ({
            키워드: r.text, 의도: r.intentName, 상태: r.status, 제품군: r.groupLabel, 광고비: r0(r.cur.cost), 매출: r0(r.cur.revenue), 전환: r2(r.cur.conversions),
            ROAS: r0(r.roas), 판정: `${r.verdict.label} · ${r.verdict.basis}`, CPA: r0(r.cpa), CVRpct: r2(r.cvr), 광고비증감pct: r1(r.costDelta), 전환증감pct: r1(r.convDelta),
            노출손실pct: pct(r.lost), 평균순위: r.rank, 랜딩: r.landingInfo.label, 신호: r.signals.map((x) => `${x.label}: ${x.basis}`),
          })),
        };
      },
    },
    {
      name: 'board_pacing',
      description: '예산 소진 현황을 반환합니다: 월 예산(연 배분 ÷ 12) 대비 매체별 소진율 · 기대 소진율 · 예상 월말 · 도달일 · 다음 달 권장 일 예산, 캠페인별 일 예산 소진율과 예상 마감 시각(시간대 가중 · 선형) · 조기 소진 판정.',
      inputSchema: { type: 'object', properties: { media: { type: 'string', enum: MEDIA_IDS, description: '매체 필터 (선택)' } } },
      execute: (inp) => {
        const d = ctx.state.data;
        const p = budgetPacing(d);
        const media = typeof inp.media === 'string' && (MEDIA_IDS as string[]).includes(inp.media) ? (inp.media as MediaId) : null;
        return {
          출처: SRC,
          기준: { 기준시각: `${d.today} ${d.currentHour}시`, 조기소진: `${BOARD_RULES.exhaustBeforeHour}시 전 마감 예상`, 피크: `${BOARD_RULES.peakStartHour}~23시 (모듈 가정)`, 월상태: `예상 월말 ${Math.round(BOARD_RULES.monthOverRatio * 100)}% 초과 / ${Math.round(BOARD_RULES.monthUnderRatio * 100)}% 미만` },
          월: { 월: p.month.key, 예산: r0(p.month.budget), 소진: r0(p.month.spent), 소진pct: r1(p.month.pacePct), 기대pct: r1(p.month.expectedPct), 예상월말pct: r1(p.month.projectedPct), 판정: `${p.month.statusLabel} · ${p.month.basis}`, 월말여부: p.month.isLastDay },
          매체: p.media.filter((m) => !media || m.media === media).map((m) => ({
            매체: m.name, 월예산: r0(m.budget), 소진: r0(m.spent), 소진pct: r1(m.pacePct), 예상월말pct: r1(m.projectedPct), 판정: `${m.statusLabel} · ${m.basis}`,
            예산도달일: m.reachedDate ?? m.projectedReachDate ?? '월 내 도달 없음', 다음달: { 월: m.next.month, 예산: r0(m.next.budget), 최근7일일평균: r0(m.next.runRate7), 현속도예상pct: r1(m.next.projectedPct), 권장일예산: r0(m.next.recommendedDaily), 조정pct: r1(m.next.adjustPct) },
          })),
          캠페인: p.campaigns.filter((c) => !media || c.media === media).sort((a, b) => Number(b.earlyExhaust) - Number(a.earlyExhaust)).map((c) => ({
            캠페인: c.name, 매체: MEDIA[c.media].short, 일예산: r0(c.dailyBudget), 오늘소진: r0(c.spentToday), 소진pct: r1(c.pacePct), 시간대기대pct: r1(c.expectedPct),
            예상수요pct: r1(c.projectedRatio * 100), 예상마감_시간대가중: clock(c.curveExhaustHour), 예상마감_선형: clock(c.linearExhaustHour), 부족예상액: r0(c.shortfall), 판정: `${c.label} · ${c.basis}`,
          })),
        };
      },
    },
    {
      name: 'board_data_status',
      description: '통합 데이터 아키텍처(p.12)의 수집 · 검증 상태를 반환합니다: 원천별(광고 매체 · 판매 채널 · 외부 데이터) 최근 수집일 · 결측 · 계정 상태, 검증 항목(결측 · 일↔시간대 합계 · 오늘 광고비 급변 · 전환 0 연속 · 계정 상태) 결과.',
      execute: () => {
        const d = ctx.state.data;
        const s = collectionSummary(d);
        return {
          출처: SRC,
          수집: { 전일배치: `${s.batchDate} 데이터 · ${s.batchTime} 수집·검증`, 시간대반영: s.hourlyThrough === null ? '없음' : `${s.hourlyThrough}시까지`, 기준시각: s.asOf, 광고매체: `${s.media.ok}/${s.media.total}`, 판매채널: `${s.sales.ok}/${s.sales.total}`, 외부데이터: `${s.external.inDataset}/${s.external.total} (나머지는 Watch · GEO 스냅샷)`, 확인필요: s.warnings },
          원천: sourceStatuses(d).map((x) => ({ 원천: x.name, 구분: x.group, 방식: x.method, 최근일: x.lastDate, 일수: x.days, 결측일: x.missingDays, 상태: x.state, 메모: x.note, 계정: x.account?.label })),
          검증: validationChecks(d).map((c) => ({ 항목: c.label, 결과: c.level === 'ok' ? '통과' : '확인 필요', 내용: c.detail, 기준: c.basis })),
          시간표: s.timetable.map((t) => `${t.time} ${t.title} · ${t.state === 'done' ? '완료' : t.state === 'moved' ? `이동(${t.note})` : '예정'}`),
        };
      },
    },
    {
      name: 'board_hourly',
      description: '최근 4주(오늘 제외) 시간대 × 요일 광고비 · 전환 · ROAS 집계에서 상위 슬롯 3개와 시간대별 전환 효율 지수(전환 비중 ÷ 광고비 비중)를 반환합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['cost', 'conversions', 'roas'], description: '집계 지표 (기본 conversions)' },
          media: { type: 'string', enum: ['all', ...MEDIA_IDS], description: '매체 (기본 all)' },
        },
      },
      execute: (inp) => {
        const d = ctx.state.data;
        const metric: HeatMetric = inp.metric === 'cost' || inp.metric === 'roas' ? inp.metric : 'conversions';
        const media = typeof inp.media === 'string' && (MEDIA_IDS as string[]).includes(inp.media) ? (inp.media as MediaId) : 'all';
        const h = hourWeekHeatmap(d, metric, media);
        const block = (from: number, to: number) => {
          const xs = h.hourEfficiency.filter((x) => x.hour >= from && x.hour <= to);
          const cs = xs.reduce((a, x) => a + (Number.isFinite(x.costShare) ? x.costShare : 0), 0);
          const vs = xs.reduce((a, x) => a + (Number.isFinite(x.convShare) ? x.convShare : 0), 0);
          return { 시간대: `${from}~${to}시`, 광고비비중pct: r1(cs * 100), 전환비중pct: r1(vs * 100), 효율지수: cs > 0 ? r2(vs / cs) : null };
        };
        return {
          출처: SRC,
          범위: `${h.from}~${h.to} (${h.days}일)`, 지표: metric, 매체: media === 'all' ? '전체' : MEDIA[media].name,
          상위슬롯: h.top.map((t) => ({ 슬롯: t.label, 값: metric === 'roas' ? r0(t.value) : metric === 'cost' ? r0(t.value) : r2(t.value) })),
          시간대효율: [block(0, 5), block(6, 11), block(12, 17), block(18, 19), block(20, 23)],
        };
      },
    },
  ],
  briefs: [
    {
      id: 'board-period',
      match: /기간\s?성과|매체별\s?(성과|광고비|매출|비교)|매체\s?통합|광고비\s?대비|ROAS|CPA|CAC|CVR|어제\s?성과|이번\s?달\s?성과|최근\s?\d+\s?일\s?성과|대시보드|Pro-?board|MILDO\s?Board/i,
      build: (ctx) => periodBrief(ctx.state.data, 'last7'),
    },
    {
      id: 'board-pacing',
      match: /예산\s?소진|소진율|소진\s?현황|조기\s?소진|예상\s?마감|페이싱|월\s?예산|일\s?예산|예산\s?마감/,
      build: (ctx) => pacingBrief(ctx.state.data),
    },
    {
      id: 'board-keywords',
      match: /키워드\s?(성과|필터|묶음|조회)|구매\s?의도별|제품군|품절\s?랜딩|CPC\s?급/,
      build: (ctx) => keywordBrief(ctx.state.data, {}, 14),
    },
    {
      id: 'board-channel',
      match: /판매\s?채널|실매출|MER|브랜드스토어\s?매출|오늘의집\s?매출|쿠팡\s?매출|자사몰\s?매출|광고\s?경유|오가닉/,
      build: (ctx) => channelBrief(ctx.state.data, 'last7'),
    },
    {
      id: 'board-data',
      match: /데이터\s?(수집|검증|연동|상태|아키텍처)|수집\s?상태|표준화|통합\s?데이터/,
      build: (ctx) => dataBrief(ctx.state.data),
    },
  ],
};
