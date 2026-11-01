/**
 * Reports 엔진 테스트 — 제안서 p.17–20 기준값 · 판정 규칙 · 경계값 · 데모 시나리오 탐지(데이터로 계산) 검증.
 */
import { describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import type { ChangeRequest, Dataset, Incident, Keyword } from '@/core/types';
import { SA_AUTOMATION_SCOPE, ONBOARDING_PHASES, KEYWORD_TEST_RULES, AD_PILOT, ANOMALY_THRESHOLDS, DATA_TIMETABLE, REPORT_CADENCE } from '@/data/constants';
import { campaignPacing, rangeOf, mediaRows, totalsOf } from '@/core/selectors';
import { detectIncidents } from '@/modules/alert/engine';
import {
  aboutHours, accountChecks, availableMonths, buildDailyReport, buildIssueReport, buildMonthlyReport, buildTimetable, buildWeeklyReport,
  campaignForecasts, computeSavings, dataNowMinutes, dataValidation, DEFAULT_TARGET_PCT, generateReport, intradayCheck, judgeKeywordTest,
  keywordSpikes, monthPeriod, nextBusinessDay, nextSends, nthBusinessDay, onboardingSchedule, reinvestPlan, reportToMarkdown, soldoutLandings,
  sortIssues, termCandidates, bidCandidates, kst, clockOf, blockToMarkdown, upcomingOffBlocks, measuredVerdict, type Report,
  automationRollout, cadenceStatus, daysBetween, mediaDayShifts, merOf,
  adPilotSummary, aeTarget, commentTarget, offDayOf, scopeOf, spikeCause, weekdayPattern, won,
  isBusinessDay, keywordTests, reportRules, sendSchedule, DEFAULT_TEST_CRITERIA, fmtCut, isClientAuthor, parseBoundedInput, pendingModules,
} from './engine';
import { generateBidProposals } from '@/modules/adpilot/engine';
import { buildPipeline } from '@/modules/lab/engine';
import { LAB_DEFAULT_CRITERIA } from '@/modules/lab/data';
import { addDays, isOffDay, KR_HOLIDAYS } from '@/core/util';
import { REPORT_META, REPORT_TYPES as REPORT_TYPES_ALL, SAVINGS_INPUT_MAX_MIN, TIMETABLE_META } from './data';

const INCIDENTS = detectIncidents(DEMO);

function emptyData(): Dataset {
  return { ...DEMO, dates: [], mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [] };
}
const allText = (r: Report) => `${reportToMarkdown(r)}\n${r.messenger}\n${JSON.stringify(r.brief)}`;

/* ---------------- 절감 (p.19) ---------------- */

describe('SA 업무 자동화 절감 (p.19)', () => {
  it('기본값: 주간 합계 1,070 → 435분, −59%, 약 18시간 → 약 7시간', () => {
    const s = computeSavings();
    expect(s.before).toBe(1070);
    expect(s.after).toBe(435);
    expect(Math.round(s.reductionPct)).toBe(59);
    expect(aboutHours(s.before)).toBe(18);
    expect(aboutHours(s.after)).toBe(7);
    expect(Math.round(DEFAULT_TARGET_PCT)).toBe(59);
    expect(s.rows.map((r) => [r.before, r.after])).toEqual(SA_AUTOMATION_SCOPE.map((t) => [t.before, t.after]));
    expect(s.meetsFloor).toBe(true);
    expect(s.verdict.label).toBe('하한 충족');
    expect(s.verdict.basis).toContain('40%');
    expect(s.edited).toBe(false);
    expect(s.saved).toBe(635);
    expect(s.annualSavedHours).toBeCloseTo((635 * 52) / 60, 5);
  });

  it('기존 값을 수정하면 재계산 — 절감률 유지 모드는 업무별 비율을 유지한다', () => {
    const s = computeSavings({ before: { '주간 보고서 작성': 480 } });
    const row = s.rows.find((r) => r.task === '주간 보고서 작성')!;
    expect(row.after).toBe(200);
    expect(row.edited).toBe(true);
    expect(s.before).toBe(1070 + 240);
    expect(s.after).toBe(435 + 100);
    expect(s.edited).toBe(true);
  });

  it('목표 분 고정 모드: 자동화 후는 기존을 넘지 않는다 · 하한 미달 판정', () => {
    const s = computeSavings({ mode: 'fixed', before: { '일간 성과 조회·취합': 60, '주간 보고서 작성': 100, '입찰·예산 조정': 110, '신규 키워드 발굴·등록': 90, '소재·URL·상태 점검': 45 } });
    expect(s.rows.find((r) => r.task === '일간 성과 조회·취합')!.after).toBe(60);
    expect(s.reductionPct).toBeLessThan(40);
    expect(s.meetsFloor).toBe(false);
    expect(s.verdict.label).toBe('하한 미달');
  });

  it('0 · 음수 · NaN 입력 방어', () => {
    const s = computeSavings({ before: { '일간 성과 조회·취합': 0, '주간 보고서 작성': -5, '입찰·예산 조정': Number.NaN } });
    const zero = s.rows.find((r) => r.task === '일간 성과 조회·취합')!;
    expect(zero.before).toBe(0);
    expect(zero.after).toBe(0);
    expect(zero.reductionPct).toBe(0);
    expect(s.rows.find((r) => r.task === '주간 보고서 작성')!.before).toBe(240);
    expect(s.rows.find((r) => r.task === '입찰·예산 조정')!.before).toBe(200);
    const all0 = computeSavings({ before: Object.fromEntries(SA_AUTOMATION_SCOPE.map((t) => [t.task, 0])) });
    expect(all0.reductionPct).toBe(0);
    expect(Number.isFinite(all0.fte)).toBe(true);
  });

  it('입력 상한: 한 주 10,080분을 넘는 기존 · 실측 값은 반영하지 않는다 (회귀: 1e12 입력이 1,000,000,000,769분 합계로 표시)', () => {
    expect(SAVINGS_INPUT_MAX_MIN).toBe(10_080);
    expect(parseBoundedInput('600', SAVINGS_INPUT_MAX_MIN)).toBe(600);
    expect(parseBoundedInput('12.5', SAVINGS_INPUT_MAX_MIN)).toBe(12.5);
    expect(parseBoundedInput('10080', SAVINGS_INPUT_MAX_MIN)).toBe(10_080);
    expect(parseBoundedInput('0')).toBe(0);
    for (const bad of ['', '  ', '-1', 'abc', 'NaN', 'Infinity', '10081', '1e12']) expect(parseBoundedInput(bad, SAVINGS_INPUT_MAX_MIN), bad).toBeNull();
    expect(parseBoundedInput('101', 100)).toBeNull();
    const s = computeSavings({ before: { '일간 성과 조회·취합': 1e12 }, measured: { '주간 보고서 작성': 1e12 } });
    expect(s.before).toBe(1070);
    expect(s.measured).toBeNull();
    expect(computeSavings({ before: { '일간 성과 조회·취합': 10_080 } }).before).toBe(1070 - 300 + 10_080);
  });

  it('온보딩 30일 실측 입력 → 목표 달성 / 하한 충족 · 목표 미달 / 하한 미달', () => {
    const hit = computeSavings({ measured: { '일간 성과 조회·취합': 80 } });
    expect(hit.measured?.verdict.label).toBe('목표 달성');
    expect(hit.measured?.tasks).toBe(1);
    const mid = computeSavings({ measured: { '일간 성과 조회·취합': 150 } });
    expect(mid.measured?.verdict.label).toBe('하한 충족 · 목표 미달');
    const low = computeSavings({ measured: { '일간 성과 조회·취합': 250 } });
    expect(low.measured?.verdict.label).toBe('하한 미달');
    expect(computeSavings({ measured: { '일간 성과 조회·취합': null } }).measured).toBeNull();
  });

  it('업무 단위 실측 판정', () => {
    expect(measuredVerdict(null, 70)).toBeNull();
    expect(measuredVerdict(Number.NaN, 70)).toBeNull();
    expect(measuredVerdict(72, 70)!.label).toBe('목표 달성');
    expect(measuredVerdict(45, 70)!.label).toBe('하한 충족');
    expect(measuredVerdict(39, 70)!.label).toBe('하한 미달');
  });

  it('재투입 계획: 비율 정규화 · 합 0이면 균등 · 절감 0이면 0', () => {
    const plan = reinvestPlan(635, [{ id: 'a', label: 'a', share: 40 }, { id: 'b', label: 'b', share: 35 }, { id: 'c', label: 'c', share: 25 }]);
    expect(plan.map((p) => Math.round(p.minutesPerWeek))).toEqual([254, 222, 159]);
    const norm = reinvestPlan(100, [{ id: 'a', label: 'a', share: 1 }, { id: 'b', label: 'b', share: 3 }]);
    expect(norm[0].sharePct).toBeCloseTo(25);
    const eq = reinvestPlan(90, [{ id: 'a', label: 'a', share: 0 }, { id: 'b', label: 'b', share: 0 }]);
    expect(eq[0].minutesPerWeek).toBe(45);
    expect(reinvestPlan(Number.NaN, [{ id: 'a', label: 'a', share: 1 }])[0].minutesPerWeek).toBe(0);
  });
});

/* ---------------- 데이터 시간표 (p.18) ---------------- */

describe('데이터 제공 시간표 (p.18)', () => {
  it('16:30 승인 대기 모듈은 화면 이름으로 표기 (회귀: "lab · alert · adpilot" 내부 id 노출)', () => {
    expect(pendingModules([{ module: 'lab' }, { module: 'alert' }, { module: 'adpilot' }, { module: 'lab' }, { module: 'gfa' }])).toBe('MILDO Lab · MILDO Alert · AD Pilot · GFA Control');
    expect(pendingModules([{ module: 'unknown_x' }])).toBe('unknown_x');
    const pending = ['lab', 'adpilot'].map((module, i) => ({ id: `c${i}`, module, status: 'pending' }) as unknown as ChangeRequest);
    const row = buildTimetable(DEMO, { changes: pending }).items.find((i) => i.time === '16:30')!;
    expect(row.output).toContain('승인 대기 2건 (MILDO Lab · AD Pilot)');
    expect(row.output).not.toMatch(/\((lab|alert|adpilot)( · |\))/);
  });
  it('기준 시각 15:30 · 토요일 → 이슈 브리핑은 다음 영업일 09:30으로 이동', () => {
    expect(dataNowMinutes(DEMO)).toBe(15 * 60 + 30);
    const t = buildTimetable(DEMO, { incidents: INCIDENTS });
    expect(t.items.map((i) => i.time)).toEqual(['07:00', '08:00', '09:30', '11:00', '14:00', '16:30', '17:00']);
    expect(t.off).toBe(true);
    expect(t.offLabel).toBe('토요일');
    expect(t.nextBusinessDay).toBe('2026-11-02');
    const brief = t.items.find((i) => i.time === '09:30')!;
    expect(brief.offMode).toBe('moved');
    expect(brief.effectiveDate).toBe('2026-11-02');
    expect(brief.effectiveTime).toBe('09:30');
    expect(brief.status).toBe('upcoming');
    expect(brief.statusLabel).toContain('11/2(월) 09:30');
    const st = Object.fromEntries(t.items.map((i) => [i.time, i.status]));
    expect(st).toMatchObject({ '07:00': 'done', '08:00': 'done', '11:00': 'done', '14:00': 'done', '17:00': 'upcoming' });
    expect(t.items.find((i) => i.time === '16:30')!.offMode).toBe('merged');
    expect(t.inBusinessHours).toBe(false);
  });

  it('산출물 미리보기는 데이터에서 계산 — 14:00 점검에 조기 소진 2건, 09:30에 열린 이슈 수', () => {
    const t = buildTimetable(DEMO, { incidents: INCIDENTS });
    const pacing = t.items.find((i) => i.time === '14:00')!;
    expect(pacing.output).toContain('SA_일반 제품');
    expect(pacing.output).toContain('Meta_넓은 타겟');
    expect(pacing.outputLevel).toBe('warn');
    expect(t.items.find((i) => i.time === '09:30')!.output).toContain(`열린 이슈 ${INCIDENTS.filter((i) => i.status !== 'resolved').length}건`);
    // 11:00 점검 시점(00–10시)에는 Meta 급등 · 카카오 전환 0이 아직 발생 전 → 이상 없음
    expect(t.items.find((i) => i.time === '11:00')!.outputLevel).toBe('ok');
    expect(t.items.find((i) => i.time === '07:00')!.outputLevel).toBe('ok');
  });

  it('평일 · 공휴일 · 주말 모드 강제', () => {
    const mon = buildTimetable(DEMO, { date: '2026-11-02' });
    expect(mon.off).toBe(false);
    expect(mon.items.every((i) => i.offMode === null && i.status === 'upcoming')).toBe(true);
    const xmas = buildTimetable(DEMO, { date: '2026-12-25' });
    expect(xmas.offLabel).toBe('성탄절');
    expect(xmas.items.find((i) => i.time === '09:30')!.effectiveDate).toBe('2026-12-28');
    const forced = buildTimetable(DEMO, { date: '2026-11-02', offHours: true });
    expect(forced.off).toBe(true);
    expect(forced.forced).toBe(true);
    expect(forced.items.find((i) => i.time === '09:30')!.effectiveDate).toBe('2026-11-03');
    const past = buildTimetable(DEMO, { date: '2026-10-28' });
    expect(past.items.every((i) => i.status === 'done')).toBe(true);
  });

  it('리포트별 리드타임 · 다음 발송 (p.17 · p.18 하단)', () => {
    const ns = nextSends(DEMO);
    expect(ns.daily.date).toBe('2026-11-01');
    expect(ns.weekly.date).toBe('2026-11-02');
    expect(ns.monthly.date).toBe('2026-11-04');
    const t = buildTimetable(DEMO);
    expect(t.sends.map((s) => s.lead)).toEqual(['감지 즉시', 'D+1 08:00', '월 10:00', '익월 3영업일']);
  });

  it('영업일 계산 — 설 연휴 · 대체공휴일 건너뜀', () => {
    expect(nextBusinessDay('2027-02-05')).toBe('2027-02-10');
    expect(nextBusinessDay('2026-10-30')).toBe('2026-11-02');
    expect(nthBusinessDay('2026-11', 3)).toBe('2026-11-04');
    expect(nthBusinessDay('2027-02', 3)).toBe('2027-02-03');
  });

  it('다가오는 주말 · 공휴일 묶음 → 다음 영업일 브리핑 (성탄절 연휴 포함)', () => {
    const b = upcomingOffBlocks('2026-10-31', 70);
    expect(b[0]).toMatchObject({ start: '2026-10-31', end: '2026-11-01', days: 2, brief: '2026-11-02' });
    const xmas = b.find((x) => x.labels.includes('성탄절'))!;
    expect(xmas).toMatchObject({ start: '2026-12-25', end: '2026-12-27', days: 3, brief: '2026-12-28' });
  });

  it('빈 데이터에서도 예외 없이 생성 · NaN 문자열 없음', () => {
    const t = buildTimetable(emptyData());
    expect(t.items).toHaveLength(7);
    expect(JSON.stringify(t)).not.toMatch(/NaN|undefined|Infinity/);
    expect(t.items.find((i) => i.time === '07:00')!.outputLevel).toBe('warn');
  });
});

/* ---------------- 탐지 · 점검 ---------------- */

describe('리포트용 탐지 · 점검 (데모 시나리오)', () => {
  it('캠페인 조기 소진: 시간대 곡선 기준으로 SA_일반 제품 · Meta_넓은 타겟만 경고 (선형 페이싱은 SA_일반 제품을 놓침)', () => {
    const flagged = campaignForecasts(DEMO).filter((f) => f.flag).map((f) => f.name).sort();
    expect(flagged).toEqual(['Meta_넓은 타겟', 'SA_일반 제품']);
    const meta = campaignForecasts(DEMO).find((f) => f.name === 'Meta_넓은 타겟')!;
    expect(meta.pace).toBeGreaterThan(1.5);
    expect(meta.exhaustHour!).toBeLessThan(19);
    expect(campaignPacing(DEMO).filter((c) => c.earlyExhaust).map((c) => c.name)).not.toContain('SA_일반 제품');
  });

  it("'매트리스 추천' 최근 3일 CPC 급등 → 자동 조정 보류 대상", () => {
    const sp = keywordSpikes(DEMO).filter((s) => s.flagged);
    expect(sp.map((s) => s.keyword.text)).toEqual(['매트리스 추천']);
    expect(sp[0].cpcDelta).toBeGreaterThanOrEqual(AD_PILOT.anomalyHoldPct);
    const bc = bidCandidates(DEMO);
    expect([...bc.up, ...bc.down].some((u) => u.k.text === '매트리스 추천')).toBe(false);
    expect(bc.up.length).toBeGreaterThan(0);
    for (const u of bc.up) expect(u.newBid).toBeLessThanOrEqual(u.k.maxBid);
  });

  it('계정 · 결제 · 권한: GFA 잔액 1일치 미만 + 자동충전 실패 · Google 비실명 · 오늘의집 검수', () => {
    const items = accountChecks(DEMO);
    const gfa = items.find((i) => i.title.startsWith('네이버 GFA'))!;
    expect(gfa.level).toBe('danger');
    expect(gfa.text).toContain('자동충전 실패');
    expect(gfa.text).toContain('0.9일');
    expect(items.some((i) => i.title.includes('비실명') && i.text.includes('agency-shared@'))).toBe(true);
    expect(items.some((i) => i.title.startsWith('오늘의집') && i.text.includes('검수'))).toBe(true);
  });

  it("품절 랜딩: 킹 옵션 품절 + '킹 매트리스' 상품 상세 랜딩", () => {
    const s = soldoutLandings(DEMO);
    expect(s.map((x) => x.keyword.text)).toEqual(['킹 매트리스']);
    expect(s[0].option).toBe('킹');
  });

  it('검색어 보고서 미등록 · 전환 발생 후보', () => {
    const c = termCandidates(DEMO);
    expect(c.length).toBe(DEMO.searchTerms.filter((t) => !t.registered && t.conversions > 0).length);
    expect(c.length).toBeGreaterThanOrEqual(5);
    expect(c.every((t) => !t.registered)).toBe(true);
  });

  it('07:00 수집 · 검증과 11:00 오전 점검', () => {
    const v = dataValidation(DEMO, '2026-10-30');
    expect(v.mediaRows).toBe(6);
    expect(v.salesRows).toBe(4);
    expect(v.ok).toBe(true);
    const at10 = intradayCheck(DEMO, 10);
    expect(at10.every((r) => r.level !== 'danger')).toBe(true);
    const meta10 = at10.find((r) => r.media === 'meta')!;
    const meta15 = intradayCheck(DEMO, 15).find((r) => r.media === 'meta')!;
    expect(meta15.costDelta).toBeGreaterThan(meta10.costDelta);
  });
});

/* ---------------- 키워드 테스트 판정 (p.26) ---------------- */

function kw(p: Partial<Keyword> & { last14: Keyword['last14'] }, days = 14): Keyword {
  const base = DEMO.keywords[0];
  const daily = Array.from({ length: 14 }, (_, i) => ({ impressions: i >= 14 - days ? 10 : 0, clicks: 1, cost: 1, conversions: 0, revenue: 0 }));
  return { ...base, id: 'kw_t', text: '테스트', isBrand: false, status: 'test', daily, prev14: { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }, ...p };
}

describe('키워드 테스트 판정 (p.26)', () => {
  const target = AD_PILOT.targetRoas;
  it('확장 ≥ 100% · 유지 70~100% · 제외 < 70% · 전환 없음', () => {
    const mk = (roasPct: number) => kw({ last14: { impressions: 1000, clicks: 120, cost: 100_000, conversions: 2, revenue: (100_000 * roasPct) / 100 } });
    expect(judgeKeywordTest(mk(target)).verdict).toBe('expand');
    expect(judgeKeywordTest(mk(target * 0.99)).verdict).toBe('keep');
    expect(judgeKeywordTest(mk(target * 0.7)).verdict).toBe('keep');
    expect(judgeKeywordTest(mk(target * 0.69)).verdict).toBe('exclude');
    const noConv = judgeKeywordTest(kw({ last14: { impressions: 1000, clicks: 120, cost: 100_000, conversions: 0, revenue: 0 } }));
    expect(noConv.verdict).toBe('exclude');
    expect(noConv.basis).toContain('전환 없음');
    expect(judgeKeywordTest(mk(target)).basis).toContain(`목표 ROAS ${target}% 대비 100%`);
  });

  it('14일 미만 & 클릭 100 미만 → 집행 중, 클릭 100 도달 시 판정 (14일 또는 최소 클릭 수)', () => {
    const short = judgeKeywordTest(kw({ last14: { impressions: 100, clicks: 30, cost: 10_000, conversions: 1, revenue: 900_000 } }, 7));
    expect(short.verdict).toBe('running');
    expect(short.basis).toContain('판정 기준 14일 또는 클릭 100 도달 전');
    const enough = judgeKeywordTest(kw({ last14: { impressions: 100, clicks: KEYWORD_TEST_RULES.minClicks, cost: 10_000, conversions: 1, revenue: 900_000 } }, 7));
    expect(enough.verdict).toBe('expand');
  });

  it('광고비 0 → ROAS NaN이어도 예외 없이 판정 · 14일이 지나도 클릭 30 미만이면 판정 보류(표본 부족)', () => {
    const z = judgeKeywordTest(kw({ last14: { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 } }));
    expect(z.verdict).toBe('hold');
    expect(Number.isNaN(z.roas)).toBe(true);
    expect(z.action).toContain('볼륨 한계');
    const at30 = judgeKeywordTest(kw({ last14: { impressions: 1000, clicks: 30, cost: 30_000, conversions: 0, revenue: 0 } }));
    expect(at30.verdict).toBe('exclude');
    expect(at30.basis).toContain('전환 없음');
  });

  it('브랜드 키워드는 브랜드 목표 ROAS(800%) 기준 · 직전 14일 노출이 있으면 28일 누적으로 판정', () => {
    const brand = judgeKeywordTest(kw({ isBrand: true, last14: { impressions: 1000, clicks: 120, cost: 100_000, conversions: 2, revenue: 600_000 } }));
    expect(brand.target).toBe(AD_PILOT.brandTargetRoas);
    expect(brand.verdict).toBe('keep'); // 600% ÷ 800% = 75%
    const cum = judgeKeywordTest(kw({ prev14: { impressions: 50, clicks: 20, cost: 20_000, conversions: 0, revenue: 0 }, last14: { impressions: 50, clicks: 20, cost: 20_000, conversions: 1, revenue: 1_000_000 } }));
    expect(cum.days).toBe(28);
    expect(cum.stats.clicks).toBe(40);
  });

  it('데모 테스트 키워드 4개는 28일 집행에도 클릭 30 미만 → 모두 판정 보류 (볼륨 한계, 데이터로 판정)', () => {
    const tests = DEMO.keywords.filter((k) => k.status === 'test').map((k) => judgeKeywordTest(k));
    expect(tests.length).toBe(4);
    for (const t of tests) {
      expect(t.stats.clicks, t.keyword.text).toBeLessThan(DEFAULT_TEST_CRITERIA.minJudgeClicks);
      expect(t.verdict, t.keyword.text).toBe('hold');
      expect(t.lowVolume).toBe(t.stats.clicks < KEYWORD_TEST_RULES.minClicks);
    }
  });

  it('주간 리포트 판정은 MILDO Lab 파이프라인과 같다 (같은 기준 · 같은 집행 기간) — 대체 규칙도 같은 결과', () => {
    expect(DEFAULT_TEST_CRITERIA).toEqual(LAB_DEFAULT_CRITERIA);
    const lab = buildPipeline(DEMO, []);
    const ts = keywordTests(DEMO, []);
    expect(ts.source).toBe('lab');
    const map: Record<string, string> = { running: 'running', insufficient: 'hold', expand: 'expand', keep: 'keep', exclude: 'exclude' };
    expect(ts.rows.map((r) => [r.phrase, r.verdict])).toEqual(lab.map((i) => [i.phrase, map[i.judgement.verdict]]));
    // 규칙 엔진 대체 판정(테스트 그룹 키워드)도 Lab과 같은 판정
    for (const k of DEMO.keywords.filter((x) => x.status === 'test')) {
      const li = lab.find((i) => i.keywordId === k.id)!;
      expect(judgeKeywordTest(k).verdict, k.text).toBe(map[li.judgement.verdict]);
      expect(judgeKeywordTest(k).days, k.text).toBe(li.days);
    }
    // Lab 판정 기준을 바꾸면 리포트 판정도 바뀐다 (판정 최소 클릭 10 → 20클릭 이상 키워드는 판정)
    const loose = keywordTests(DEMO, [], { minJudgeClicks: 10 });
    expect(loose.rows.find((r) => r.phrase === '신혼집 매트리스 사이즈')!.verdict).not.toBe('hold');
    expect(loose.criteria.minJudgeClicks).toBe(10);
  });
});

/* ---------------- 리포트 4종 (p.17) ---------------- */

describe('일간 리포트', () => {
  const r = buildDailyReport(DEMO, { incidents: INCIDENTS });
  const md = reportToMarkdown(r);
  it('전일 성과 수치는 공용 셀렉터와 같다', () => {
    const y = rangeOf(DEMO, 'yesterday');
    const t = totalsOf(mediaRows(DEMO, y.from, y.to));
    expect(r.from).toBe('2026-10-30');
    const stats = r.sections.find((s) => s.id === 'kpi')!.blocks.find((b) => b.kind === 'stats');
    expect(stats && stats.kind === 'stats' ? stats.items[0].value : '').toBe(`${(Math.round(t.cost / 1e4)).toLocaleString('ko-KR')}만원`);
  });
  it('주요 변동에 데모 시나리오가 데이터로 잡힌다 (위험 항목이 먼저)', () => {
    const items = r.sections.find((s) => s.id === 'changes')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    expect(items[0].level).toBe('danger');
    const titles = items.map((i) => i.title).join('\n');
    expect(titles).toContain('네이버 GFA');
    expect(titles).toContain("'매트리스 추천'");
    expect(titles).toContain("'킹 매트리스'");
    expect(titles).toContain('비실명');
    expect(titles).toContain('오늘의집');
  });
  it('발송 이후 변동: 조기 소진 예상 + Alert 이슈(카카오 전환 단절 · Meta 급변) · 중복 제외', () => {
    const today = r.sections.find((s) => s.id === 'today')!;
    const titles = today.blocks.flatMap((b) => (b.kind === 'items' ? b.items.map((i) => i.title) : [])).join('\n');
    expect(titles).toContain('SA_일반 제품');
    expect(titles).toContain('카카오 전환 추적 단절');
    expect(titles).toContain('Meta 데이터 급변');
    expect(titles).not.toContain('잔액 1일치 미만');
    expect((titles.match(/SA_일반 제품/g) ?? []).length).toBe(1);
  });
  it('문서형 · 메신저형 두 포맷, 영역 구분, TEST DATA 표기', () => {
    expect(md).toContain('## 확정 팩트');
    expect(md).toContain('## 반복 관측 패턴');
    expect(md).toContain('TEST DATA');
    expect(md).toMatch(/\| 지표 \| 10\/30\(금\) \|/);
    const lines = r.messenger.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toContain('TEST DATA');
    expect(r.messenger.length).toBeLessThan(md.length / 3);
  });
});

describe('주간 리포트', () => {
  const r = buildWeeklyReport(DEMO);
  it('키워드 테스트 결과 · 개선 제안 포함, 기준값 병기', () => {
    const md = reportToMarkdown(r);
    expect(r.sections.map((s) => s.id)).toEqual(['summary', 'tests', 'candidates', 'intent', 'patterns', 'improve']);
    expect(md).toContain('첫 독립 매트리스');
    expect(md).toContain('판정 기준 (MILDO Lab과 같은 판정): 목표 ROAS 400% 대비 확장 100% 이상');
    expect(md).toContain('클릭 30 미만은 판정 보류');
    const ts = keywordTests(DEMO);
    expect(r.sections.find((s) => s.id === 'tests')!.title).toBe(`키워드 테스트 결과 · 확장 ${ts.counts.expand} · 유지 ${ts.counts.keep} · 제외 ${ts.counts.exclude} · 판정 보류 ${ts.counts.hold} · 집행 중 ${ts.counts.running}`);
    expect(ts.counts.hold).toBeGreaterThanOrEqual(4);
    const improve = r.sections.find((s) => s.id === 'improve')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    expect(improve.some((i) => i.title.includes("'매트리스 추천' 자동 조정 보류"))).toBe(true);
    expect(improve.some((i) => i.title.includes('일 예산 조기 소진 예상 2건'))).toBe(true);
    expect(improve.some((i) => i.title.includes('테스트 그룹 등록 후보'))).toBe(true);
    expect(improve.some((i) => i.title.startsWith(`판정 보류 ${ts.counts.hold}건`))).toBe(true);
    // 판정 보류 키워드를 '확장 → 본 그룹 이관'으로 제안하지 않는다
    const expandItem = improve.find((i) => i.title.startsWith('확장 판정'));
    for (const t of ts.rows.filter((x) => x.verdict === 'hold')) expect(expandItem?.text ?? '').not.toContain(`'${t.phrase}'`);
    for (const i of improve) expect(i.basis, i.title).toBeTruthy();
    // 미리보기(토요일 생성)는 최근 7일, 발송분은 전주 월~일로 재생성된다고 표기
    expect(r.sections.find((s) => s.id === 'summary')!.note).toContain('전주 월~일(10/26–11/1)');
    expect(r.nextSend).toContain('11/2(월) 10:00');
    expect(r.zoneLabels?.action).toBe('개선 제안 · 다음 액션');
  });
});

describe('월간 리포트', () => {
  it('10월 1–30일 잠정 · 9월 같은 30일 대비 · 다음 달 계획(11월 기획전 · 3영업일 미팅)', () => {
    const p = monthPeriod(DEMO)!;
    expect(p).toMatchObject({ month: '2026-10', from: '2026-10-01', to: '2026-10-30', provisional: true, prevFrom: '2026-09-01', prevTo: '2026-09-30' });
    const r = buildMonthlyReport(DEMO);
    const md = reportToMarkdown(r);
    expect(md).toContain('채널별 매출 기여');
    expect(md).toContain('11월 연말 수면 환경 기획전');
    expect(r.schedule).toContain('11/4(수)');
    expect(r.provisional).toBe(true);
    const chan = r.sections.find((s) => s.id === 'channels')!.blocks[0];
    expect(chan.kind).toBe('table');
    if (chan.kind === 'table') expect(chan.rows).toHaveLength(5);
  });
  it('대상 월 선택: 9월은 확정(잠정 아님), 데이터 이전 월은 목록에서 제외', () => {
    const months = availableMonths(DEMO);
    expect(months[0]).toBe('2026-10');
    expect(months).toContain('2026-09');
    expect(months).not.toContain('2026-07');
    const sep = buildMonthlyReport(DEMO, { month: '2026-09' });
    expect(sep.provisional).toBeFalsy();
    expect(sep.periodLabel).toContain('9/1–9/30');
  });
});

describe('이슈 알림 리포트', () => {
  it('Alert 이슈(데이터 탐지)로 생성: 기본 선택은 열린 P1 · 원인 · 영향 · 조치 상태 · SLA', () => {
    const r = buildIssueReport(DEMO, INCIDENTS);
    expect(r.title).toContain('P1');
    expect(r.sections.map((s) => s.id)).toEqual(['summary', 'detect', 'impact', 'cause', 'status']);
    expect(r.messenger).toMatch(/SLA 인지 10\/31\(토\) 15:45/);
    expect(r.messenger).toContain('원인 후보');
    const md = reportToMarkdown(r);
    expect(md).toContain('카카오 전환 추적 단절');
    expect(md).toContain('Meta 데이터 급변');
  });
  it('선택한 이슈로 전환 · 근거가 없는 수동 이슈도 NaN 없이', () => {
    const kakao = INCIDENTS.find((i) => i.ruleId === 'tracking_break')!;
    expect(buildIssueReport(DEMO, INCIDENTS, kakao.id).title).toContain('카카오');
    const manual: Incident = { id: 'x', ruleId: 'manual', severity: 'P3', title: '수동 등록 이슈', detectedAt: '2026-10-31T10:00:00+09:00', occurredAt: '2026-10-31T09:50:00+09:00', detectPath: '수동', causeCandidates: [], impact: {}, status: 'resolved', timeline: [], isTest: true, autoActions: [] };
    const r = buildIssueReport(DEMO, [manual]);
    expect(allText(r)).not.toMatch(/NaN|undefined|Infinity/);
    expect(r.messenger).toContain('[테스트]');
  });
  it('Alert 이슈 목록이 비어도 기준 이내라고 단정하지 않는다 — MILDO Alert 탐지를 다시 돌려 데모 시나리오를 잡는다', () => {
    const r = buildIssueReport(DEMO, []);
    expect(r.title).toContain('Alert 미등록 · P1');
    const md = reportToMarkdown(r);
    expect(md).toContain('카카오 전환 추적 단절');
    expect(md).toContain('Meta 데이터 급변');
    expect(md).toContain('MILDO Alert 미등록 · 리포트 생성 시 재탐지 결과');
    // 재탐지 이슈 id는 Alert 등록 후와 같다 (섹션 코멘트 범위가 유지됨)
    expect(scopeOf(r)).toBe(`issue-${sortIssues(INCIDENTS.filter((i) => i.status !== 'resolved'))[0].id}`);
    expect(md).toContain('네이버 GFA');
    expect(md).toContain("'킹 매트리스'");
    expect(md).toContain("'매트리스 추천'");
    expect(md).not.toContain('기준 모두 이내');
    expect(r.messenger).toContain('재스캔');
    expect(allText(r)).not.toMatch(/NaN|undefined|Infinity/);
  });
  it('이슈 없음 · 정렬(열린 P1 → P2 → 해결)', () => {
    const r = buildIssueReport(emptyData(), []);
    expect(r.title).toContain('열린 이슈 없음');
    const sorted = sortIssues([{ ...INCIDENTS[0], id: 'a', status: 'resolved' }, ...INCIDENTS.slice(2, 3), INCIDENTS[1]]);
    expect(sorted[0].severity).toBe('P1');
    expect(sorted[sorted.length - 1].status).toBe('resolved');
  });
});

describe('공통 출력 규칙', () => {
  it('4종 모두 NaN · undefined 문자열 없음, 번호 매기기 없음', () => {
    for (const type of REPORT_TYPES_ALL) {
      const r = generateReport(type, DEMO, { incidents: INCIDENTS });
      const t = allText(r);
      expect(t, type).not.toMatch(/NaN|undefined|Infinity/);
      expect(t, type).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(t, type).not.toMatch(/담당: 담당|담당 담당/);
      expect(t, type).not.toMatch(/[컬럼몰팡집]가 /);
      expect(r.brief.facts.length, type).toBeGreaterThan(0);
    }
  });
  it('빈 데이터 → 빈 리포트(예외 없음)', () => {
    const e = emptyData();
    for (const type of REPORT_TYPES_ALL) {
      const r = generateReport(type, e, { incidents: [] });
      expect(allText(r), type).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect(buildDailyReport(e).empty).toBe(true);
    expect(buildWeeklyReport(e).empty).toBe(true);
    expect(buildMonthlyReport(e).empty).toBe(true);
  });
  it('AE 코멘트 · 피드백 · AI 해석을 문서 하단에 병합', () => {
    const r = buildDailyReport(DEMO);
    const md = reportToMarkdown(r, {
      interpretation: { text: '### AI 해석\n해석 문단', by: 'ai' },
      aeNotes: [{ author: '담당 AE', text: 'GFA 충전 요청 완료, 17시 재확인', at: '10/31 15:40' }],
      feedback: [{ sectionTitle: '매체별 성과', author: '수면밀도', text: 'Meta는 신규 비중으로', resolved: false }],
    });
    const iAi = md.indexOf('## AI 해석');
    const iAe = md.indexOf('## 담당 AE 해석 · 다음 액션');
    const iFb = md.indexOf('## 수면밀도 피드백');
    expect(iAi).toBeGreaterThan(md.indexOf('## 반복 관측 패턴'));
    expect(iAe).toBeGreaterThan(iAi);
    expect(iFb).toBeGreaterThan(iAe);
    expect(md).toContain('#### AI 해석');
    expect(md).toContain('반영 대기');
  });
  it('마크다운 표 셀의 파이프 문자 이스케이프', () => {
    const t = blockToMarkdown({ kind: 'table', columns: [{ label: 'a' }], rows: [['x | y']] });
    expect(t).toContain('x / y');
  });
  it('시각 헬퍼', () => {
    expect(kst('2026-10-31T15:30:00+09:00')).toMatchObject({ date: '2026-10-31', time: '15:30' });
    expect(kst('잘못된 값').date).toBe('');
    expect(clockOf(20.5)).toBe('20:30');
    expect(clockOf(Number.NaN)).toBe('—');
  });
});

describe('자동화 적용 일정 90일 (p.20)', () => {
  it('Kick-off 기준 D+30 · D+60 · D+90 환산, 잘못된 날짜는 기본 가정', () => {
    const s = onboardingSchedule('2026-12-01');
    expect(s.map((x) => x.end)).toEqual(['2026-12-31', '2027-01-30', '2027-03-01']);
    expect(s.map((x) => x.label)).toEqual(ONBOARDING_PHASES.map((p) => p.label));
    expect(onboardingSchedule('abc')[0].start).toBe('2026-12-01');
  });
});

describe('자동화 적용 일정 × 절감 목표 (p.19 · p.20 · p.22)', () => {
  it('D+30 보존(절감 0) → D+60 Board · Watch · Alert 업무 적용 → D+90 AD Pilot 적용 = 435분', () => {
    const ro = automationRollout('2026-12-01', DEMO.today);
    expect(ro.daysToKickoff).toBe(31);
    expect(ro.confirmDate).toBe('2026-12-31');
    expect(ro.phases.map((p) => p.weeklyAfter)).toEqual([1070, 525, 435]);
    expect(Math.round(ro.phases[2].reductionPct)).toBe(59);
    expect(ro.phases[0].tasks).toEqual([]);
    expect(ro.phases[2].tasks.map((t) => t.task)).toEqual(['입찰·예산 조정']);
    expect(ro.phases.map((p) => p.modules.map((m) => m.label).join(' · '))).toEqual(['MILDO Board', 'MILDO Watch · MILDO Alert', 'MILDO Lab · MILDO Flow']);
    expect(ro.phases.every((p) => p.status === 'before')).toBe(true);
  });
  it('기준일이 단계 안이면 진행 중 · 지난 단계는 완료 · 기존 값 수정 반영', () => {
    const ro = automationRollout('2026-12-01', '2027-01-15', computeSavings({ before: { '입찰·예산 조정': 400 } }));
    expect(ro.phases.map((p) => p.status)).toEqual(['done', 'now', 'before']);
    expect(ro.phases[0].weeklyAfter).toBe(1270);
    expect(ro.phases[2].weeklyAfter).toBe(1270 - 545 - 180);
    const bad = automationRollout('잘못된 날짜', DEMO.today);
    expect(bad.kickoff).toBe('2026-12-01');
  });
  it('날짜 차이', () => {
    expect(daysBetween('2026-10-31', '2026-12-01')).toBe(31);
    expect(daysBetween('2026-12-01', '2026-10-31')).toBe(-31);
    expect(Number.isNaN(daysBetween('x', '2026-12-01'))).toBe(true);
  });
});

describe('리포트 발송 현황 (p.17)', () => {
  it('토 15:30 기준: 일간 오늘 08:00 발송 완료(전일 성과) · 주간 최근 10/26 · 월간 다음 11/4 · 이슈 열린 P1 수', () => {
    const c = cadenceStatus(DEMO, INCIDENTS);
    expect(c.map((x) => x.type)).toEqual(['daily', 'weekly', 'monthly', 'issue']);
    const daily = c[0];
    expect(daily.state).toBe('sent');
    expect(daily.stateLabel).toBe('10/31(토) 08:00 발송 완료');
    expect(daily.detail).toContain('10/30(금) 성과');
    expect(c[1].last).toBe('10/26(월) 10:00');
    expect(c[1].next).toContain('11/2(월) 10:00');
    expect(c[2].stateLabel).toContain('11/4(수)');
    const p1 = INCIDENTS.filter((i) => i.status !== 'resolved' && i.severity === 'P1').length;
    expect(p1).toBeGreaterThan(0);
    expect(c[3].alert).toBe(p1);
    expect(c[3].stateLabel).toContain(`P1 ${p1}`);
  });
  it('08:00 이전이면 전일 발송분 · 이슈 없음 · 빈 데이터', () => {
    const early = cadenceStatus({ ...DEMO, generatedAt: '2026-10-31T07:30:00+09:00', currentHour: 7 }, []);
    expect(early[0].stateLabel).toBe('10/30(금) 08:00 발송 완료');
    // 이슈 스토어가 비면 '0건'으로 단정하지 않고 Alert 재탐지 결과를 'Alert 미등록'으로 표기
    expect(early[3].stateLabel).toContain('(Alert 미등록)');
    expect(early[3].detail).toContain('재스캔');
    expect(cadenceStatus(DEMO, [{ ...INCIDENTS[0], status: 'resolved' }])[3].stateLabel).toBe('열린 이슈 0건');
    const e = cadenceStatus(emptyData(), []);
    expect(e[3].stateLabel).toBe('열린 이슈 0건');
    expect(e[0].state).toBe('scheduled');
    expect(JSON.stringify(e)).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe('일 단위 변동 기준선 (p.47)', () => {
  it('기준선은 최근 4주 같은 요일 (7 · 14 · 21 · 28일 전) 평균', () => {
    const date = '2026-10-30';
    const sh = mediaDayShifts(DEMO, date).find((s) => s.media === 'naver_gfa' && s.metric === 'cost')!;
    const bases = [7, 14, 21, 28].map((k) => totalsOf(mediaRows(DEMO, addDays(date, -k), addDays(date, -k), 'naver_gfa')).cost);
    expect(sh.base).toBeCloseTo(bases.reduce((a, b) => a + b, 0) / 4, 3);
  });
  it('같은 매체의 지표 변동은 일간 리포트에서 한 항목으로 묶인다 · MER은 배수', () => {
    const r = buildDailyReport(DEMO, { incidents: INCIDENTS });
    const items = r.sections.find((s) => s.id === 'changes')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    const gfaShift = items.filter((i) => i.title.startsWith('네이버 GFA ') && !i.title.includes('수면밀도'));
    expect(gfaShift.length).toBeLessThanOrEqual(1);
    expect(r.messenger).toMatch(/MER \d+\.\d배/);
    expect(merOf(100, 0)).toBeNaN();
    expect(merOf(580, 100)).toBeCloseTo(5.8);
  });
});

/* ---------------- 리뷰 보강: 화면 간 같은 숫자 · p.47 기준선 · 공휴일 · 코멘트 범위 · 데이터 기반 문구 ---------------- */

describe('화면 간 같은 숫자 (AD Pilot · MILDO Alert)', () => {
  it('주간 개선 제안의 입찰 후보 · 보류 · 재배분은 AD Pilot 엔진(generateBidProposals) 결과와 같다', () => {
    const ap = generateBidProposals(DEMO);
    const summary = adPilotSummary(DEMO);
    expect(summary.source).toBe('adpilot');
    expect(summary.up.length).toBe(ap.filter((p) => p.action === 'bid_up').length);
    expect(summary.hold.length).toBe(ap.filter((p) => p.action === 'hold').length);
    const r = buildWeeklyReport(DEMO);
    const improve = r.sections.find((s) => s.id === 'improve')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    const up = improve.find((i) => i.title.startsWith('입찰 상향 후보'))!;
    expect(up.title).toBe(`입찰 상향 후보 ${summary.up.length}건`);
    for (const p of summary.up.slice(0, 4)) expect(up.text).toContain(`'${p.keyword}' ${won(p.before)} → ${won(p.after)}`);
    // 일 조정 폭 상한 20% (p.14)
    for (const p of summary.up) expect(p.after).toBeLessThanOrEqual(p.before * (1 + AD_PILOT.dailyChangeCapPct / 100) + 1e-9);
    expect(r.brief.facts.join(' ')).toContain(`입찰 상향 ${summary.up.length}건`);
    // 다른 보류(카카오 추적 단절 · Meta 급변 등)는 별도 항목으로, 품절 · 급변 키워드는 중복 없이
    const other = improve.find((i) => i.title.startsWith('그 외 자동 조정 보류'));
    expect(other?.text ?? '').not.toContain('매트리스 추천');
    expect(other?.text ?? '').not.toContain('킹 매트리스');
  });

  it('규칙 엔진 보조 후보도 일 조정 폭 상한(±20%)을 넘지 않는다 (10원 단위 내림 · 올림)', () => {
    const base = DEMO.keywords.find((k) => k.status === 'on' && !k.isBrand)!;
    const hi: Keyword = { ...base, id: 'kw_cap', bid: 980, maxBid: 5000, impressionShareLost: 0.4, status: 'on', last14: { impressions: 1000, clicks: 100, cost: 100_000, conversions: 10, revenue: 2_000_000 } };
    const lo: Keyword = { ...base, id: 'kw_cap2', bid: 255, maxBid: 5000, impressionShareLost: 0, status: 'on', last14: { impressions: 1000, clicks: 100, cost: 100_000, conversions: 5, revenue: 100_000 }, prev14: { impressions: 1000, clicks: 100, cost: 100_000, conversions: 5, revenue: 100_000 } };
    const bc = bidCandidates({ ...DEMO, keywords: [hi, lo] });
    expect(bc.up[0].newBid).toBe(1170);
    expect(bc.down[0].newBid).toBe(210);
    expect(bc.up[0].newBid / hi.bid).toBeLessThanOrEqual(1.2);
    expect(bc.down[0].newBid / lo.bid).toBeGreaterThanOrEqual(0.8);
  });

  it('조기 소진 예상 마감 시각은 MILDO Alert 이슈와 같다 (최근 28일 시간대 소진 곡선)', () => {
    const flagged = campaignForecasts(DEMO).filter((f) => f.flag);
    expect(flagged.length).toBe(2);
    for (const f of flagged) {
      const inc = INCIDENTS.find((i) => i.target === f.name);
      expect(inc, f.name).toBeTruthy();
      expect(inc!.title).toContain(clockOf(f.exhaustHour!));
    }
    const r = buildDailyReport(DEMO, { incidents: INCIDENTS });
    const today = r.sections.find((s) => s.id === 'today')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    const sa = today.find((i) => i.title.startsWith('SA_일반 제품'))!;
    expect(sa.title).toContain(clockOf(flagged.find((f) => f.name === 'SA_일반 제품')!.exhaustHour!));
  });

  it('off 상태 캠페인은 예상 마감을 계산하지 않는다', () => {
    const d = { ...DEMO, campaigns: DEMO.campaigns.map((c) => (c.name === 'Meta_넓은 타겟' ? { ...c, status: 'off' as const } : c)) };
    expect(campaignForecasts(d).find((f) => f.name === 'Meta_넓은 타겟')!.exhaustHour).toBeNull();
  });
});

describe('p.47 지표별 기준선 (일 단위 · 11:00 점검)', () => {
  it('전환 · CPA · ROAS는 최근 7일 평균, 광고비 · 클릭은 동요일 4주 평균', () => {
    const date = '2026-10-30';
    const sh = mediaDayShifts(DEMO, date);
    const conv = sh.find((s) => s.media === 'naver_gfa' && s.metric === 'conversions')!;
    const d7 = [1, 2, 3, 4, 5, 6, 7].map((k) => totalsOf(mediaRows(DEMO, addDays(date, -k), addDays(date, -k), 'naver_gfa')));
    expect(conv.base).toBeCloseTo(d7.reduce((a, t) => a + t.conversions, 0) / 7, 6);
    expect(conv.baseLabel).toBe('최근 7일 평균');
    const roas = sh.find((s) => s.media === 'naver_gfa' && s.metric === 'roas')!;
    expect(roas.base).toBeCloseTo((d7.reduce((a, t) => a + t.revenue, 0) / d7.reduce((a, t) => a + t.cost, 0)) * 100, 6);
    expect(sh.find((s) => s.media === 'naver_gfa' && s.metric === 'cost')!.baseLabel).toBe('동요일 4주 평균');
    // 리포트 문구에도 지표별 기준선 이름이 붙는다
    const items = buildDailyReport(DEMO).sections.find((s) => s.id === 'changes')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    expect(items.find((i) => i.title.startsWith('네이버 GFA 전환'))!.text).toContain('최근 7일 평균');
  });

  it('데이터가 부족하면(기준일 7일 미만) 변동을 판정하지 않는다', () => {
    const d = { ...DEMO, dates: DEMO.dates.slice(-3), mediaDaily: DEMO.mediaDaily.filter((r) => r.date >= DEMO.dates[DEMO.dates.length - 3]) };
    expect(mediaDayShifts(d, DEMO.dates[DEMO.dates.length - 1])).toEqual([]);
  });

  it('11:00 점검 전환 기준선은 최근 7일 같은 시간대 누적 평균', () => {
    const row = intradayCheck(DEMO, 10).find((r) => r.media === 'kakao')!;
    const days = [1, 2, 3, 4, 5, 6, 7].map((k) => addDays(DEMO.today, -k));
    const conv = days.map((dt) => DEMO.mediaHourly.filter((r) => r.date === dt && r.media === 'kakao' && r.hour <= 10).reduce((a, r) => a + r.conversions, 0));
    expect(row.convBase).toBeCloseTo(conv.reduce((a, b) => a + b, 0) / 7, 6);
  });
});

describe('영업일 · 공휴일은 공용 KR_HOLIDAYS · isOffDay를 그대로 쓴다 (월간 발송일 · 다음 달 영업일)', () => {
  it('모듈 로컬 공휴일 표 없음 — 2026-07 ~ 2027-12 전 날짜에서 isOffDay와 같은 판정', () => {
    for (let x = '2026-07-01'; x <= '2027-12-31'; x = addDays(x, 1)) {
      expect(offDayOf(x), x).toEqual(isOffDay(x));
      expect(isBusinessDay(x), x).toBe(!isOffDay(x).off);
    }
    // 익월 3영업일은 공용 달력에서 직접 센 값과 같다
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11', '2027-02', '2027-10']) {
      const days: string[] = [];
      for (let x = `${m}-01`; days.length < 3; x = addDays(x, 1)) if (!isOffDay(x).off) days.push(x);
      expect(nthBusinessDay(m, 3), m).toBe(days[2]);
    }
  });
  it('10월 3영업일은 개천절 대체공휴일(10/5)을 건너뛴 10/6 (KR_HOLIDAYS 2026 반영)', () => {
    expect(KR_HOLIDAYS['2026-10-05']).toBeTruthy();
    expect(offDayOf('2026-10-05').off).toBe(true);
    expect(offDayOf('2026-10-09').label).toBe('한글날');
    expect(nthBusinessDay('2026-10', 3)).toBe('2026-10-06');
    expect(cadenceStatus(DEMO, INCIDENTS)[2].last).toBe('10/6(화)');
    const sep = buildMonthlyReport(DEMO, { month: '2026-09' });
    expect(sep.schedule).toContain('10/6(화)');
    const plan = sep.sections.find((s) => s.id === 'plan')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    const cal = plan.find((i) => i.title.startsWith('영업일'))!;
    expect(cal.text).toContain('개천절');
    expect(cal.text).toContain('한글날');
    expect(cal.title).toBe('영업일 20일 · 주말 · 공휴일 11일'); // 31일 − 주말 9일 − 평일 공휴일 2일(10/5 · 10/9)
  });
});

describe('코멘트 범위 (state.comments target)', () => {
  it('일간 · 주간은 종류 단위, 월간은 대상 월, 이슈 알림은 이슈별로 나뉜다', () => {
    expect(scopeOf(buildDailyReport(DEMO))).toBe('daily');
    expect(commentTarget(scopeOf(buildDailyReport(DEMO)), 'media')).toBe('reports:daily:media');
    const oct = buildMonthlyReport(DEMO, { month: '2026-10' });
    const sep = buildMonthlyReport(DEMO, { month: '2026-09' });
    expect(commentTarget(scopeOf(oct), 'channels')).not.toBe(commentTarget(scopeOf(sep), 'channels'));
    const kakao = INCIDENTS.find((i) => i.ruleId === 'tracking_break')!;
    const a = buildIssueReport(DEMO, INCIDENTS);
    const b = buildIssueReport(DEMO, INCIDENTS, kakao.id);
    expect(aeTarget(scopeOf(a))).not.toBe(aeTarget(scopeOf(b)));
    expect(scopeOf(b)).toBe(`issue-${kakao.id}`);
  });
});

describe('데이터 기반 문구 (하드코딩 없음)', () => {
  it('급변 원인 후보는 신호로 정한다 (CPC 상승 → 경쟁사 입찰, CPC 급락 → 집계 지연, 전환만 하락 → 품절 · 가격)', () => {
    const z = { cpcDelta: 0, convDelta: 0, clickDelta: 0, cpcHit: false, convHit: false };
    expect(spikeCause({ ...z, cpcDelta: 66, cpcHit: true }, false).label).toBe('경쟁사 입찰 상승');
    expect(spikeCause({ ...z, cpcDelta: -60, cpcHit: true }, false).label).toBe('매체 장애 · 집계 지연');
    expect(spikeCause({ ...z, convDelta: -70, convHit: true }, true).label).toBe('랜딩 오류 · 품절');
    expect(spikeCause({ ...z, convDelta: -70, convHit: true }, false).label).toBe('가격 · 프로모션 변경');
    const sp = keywordSpikes(DEMO).find((x) => x.flagged)!;
    expect(sp.cause.label).toBe('경쟁사 입찰 상승');
  });

  it("급변 키워드가 없으면 주간 반례에 '매트리스 추천'을 쓰지 않는다 · 기획전이 없으면 일간 해석에 기획전명을 쓰지 않는다", () => {
    const noSpike = { ...DEMO, keywords: DEMO.keywords.filter((k) => k.text !== '매트리스 추천') };
    const w = buildWeeklyReport(noSpike);
    expect(JSON.stringify(w.brief.counter)).not.toContain('매트리스 추천');
    expect(w.sections.find((s) => s.id === 'improve')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : [])).some((i) => i.title.includes('매트리스 추천'))).toBe(false);
    const daily = buildDailyReport({ ...DEMO, promotions: [] });
    expect(JSON.stringify(daily.brief)).not.toContain('가을 이사');
    const withPromo = buildDailyReport(DEMO);
    expect(withPromo.brief.interpretation.join(' ')).toContain('가을 이사 · 혼수 기획전');
  });

  it('요일 강세 · 약세는 최근 28일 요일 지수에서 계산한다', () => {
    const r = buildDailyReport(DEMO);
    const wp = weekdayPattern(DEMO, '2026-10-30', 28).filter((x) => Number.isFinite(x.index)).sort((a, b) => b.index - a.index);
    expect(r.brief.counter[0]).toContain(`${wp[0].label}요일 · ${wp[1].label}요일 강세`);
    expect(r.brief.counter[0]).toContain(`${wp[wp.length - 1].label}요일 약세`);
  });

  it('주말 · 공휴일에 감지된 이슈는 당번 확인 · 다음 영업일 09:30 브리핑을 조치 상태에 표시', () => {
    const r = buildIssueReport(DEMO, INCIDENTS);
    const st = r.sections.find((s) => s.id === 'status')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    const wk = st.find((i) => i.title.includes('주말 · 공휴일 체계'))!;
    expect(wk.text).toContain('11/2(월) 09:30');
    expect(r.brief.actions.join(' ')).toContain('11/2(월) 09:30');
    const weekday = INCIDENTS.map((i) => ({ ...i, detectedAt: '2026-10-30T10:00:00+09:00' }));
    const r2 = buildIssueReport(DEMO, weekday);
    expect(r2.sections.find((s) => s.id === 'status')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : [])).some((i) => i.title.includes('주말 · 공휴일 체계'))).toBe(false);
  });

  it('16:30 익일 조정안 산출물은 AD Pilot 후보 수에서 계산한다', () => {
    const t = buildTimetable(DEMO, { incidents: INCIDENTS });
    const s = adPilotSummary(DEMO);
    expect(t.items.find((i) => i.time === '16:30')!.output).toContain(`입찰 상향 ${s.up.length} · 하향 ${s.down.length} · 예산 재배분 ${s.shift.length} · 보류 ${s.hold.length}`);
    expect(t.items.find((i) => i.time === '08:00')!.outputLevel).toBe('info');
  });
});

/* ---------------- 독립 리뷰 보강: 제안서 기준값 · 휴무 발송 · Alert 기준 공유 · 문구 ---------------- */

describe('제안서 기준값과 constants 일치 (p.17 · p.18)', () => {
  it('리포트 4종 이름 · 주기 · 채널 · 내용은 REPORT_CADENCE 그대로 · 리드타임은 p.18 하단 표기', () => {
    for (const c of REPORT_CADENCE) {
      const m = REPORT_META[c.id as keyof typeof REPORT_META];
      expect(m, c.id).toMatchObject({ name: c.name, when: c.when, channel: c.channel, content: c.content });
    }
    expect(REPORT_META.daily.lead).toBe('D+1 08:00');
    expect(REPORT_META.monthly.lead).toBe('익월 3영업일');
  });
  it('데이터 제공 시간표 7개 항목 모두 메타(범위 · 리드타임 · 주말 규칙)를 갖고, 제안서 시각 · 채널을 그대로 쓴다', () => {
    expect(DATA_TIMETABLE.map((t) => t.time)).toEqual(['07:00', '08:00', '09:30', '11:00', '14:00', '16:30', '17:00']);
    for (const t of DATA_TIMETABLE) expect(TIMETABLE_META[t.time], t.time).toBeTruthy();
    const tt = buildTimetable(DEMO);
    expect(tt.items.map((i) => [i.time, i.title, i.channel])).toEqual(DATA_TIMETABLE.map((t) => [t.time, t.title, t.channel]));
    expect(tt.band).toEqual({ from: 8 * 60, to: 17 * 60 });
    // 제안서에 없는 리드타임은 운영 가정으로 표기
    expect(TIMETABLE_META['16:30'].lead).toContain('운영 가정');
  });
});

describe('휴무로 밀린 주간 · 월간 발송 (최근 발송 · 다음 발송이 같은 규칙)', () => {
  const at = (date: string, hhmm: string): Dataset => ({ ...DEMO, today: date, generatedAt: `${date}T${hhmm}:00+09:00`, currentHour: Number(hhmm.slice(0, 2)) });
  it('월요일이 대체공휴일(2027-10-04)이면 주간 발송은 화요일 10:00 — 휴무 월요일에는 아직 미발송', () => {
    const mon = sendSchedule(at('2027-10-04', '11:00'));
    expect(isBusinessDay('2027-10-04')).toBe(false);
    expect(mon.weeklyNext).toBe('2027-10-05');
    expect(mon.weeklyLast).toBe('2027-09-27');
    expect(nextSends(at('2027-10-04', '11:00')).weekly.date).toBe('2027-10-05');
    expect(cadenceStatus(at('2027-10-04', '11:00'), [])[1].last).toBe('9/27(월) 10:00');
    const tue = sendSchedule(at('2027-10-05', '10:30'));
    expect(tue.weeklyLast).toBe('2027-10-05');
    // 다음 주 월요일 10/11도 한글날 대체공휴일(KR_HOLIDAYS) → 10/12(화)
    expect(KR_HOLIDAYS['2027-10-11']).toBeTruthy();
    expect(tue.weeklyNext).toBe('2027-10-12');
    // 화요일 10:00 이전이면 그날이 다음 발송
    expect(sendSchedule(at('2027-10-05', '09:00')).weeklyNext).toBe('2027-10-05');
  });
  it('월간 미팅(익월 3영업일 10:00 가정): 당일 10시 전에는 다음 발송, 이후에는 최근 발송', () => {
    const before = sendSchedule(at('2026-11-04', '09:00'));
    expect(before.monthlyNext).toBe('2026-11-04');
    expect(before.monthlyLast).toBe('2026-10-06');
    const after = sendSchedule(at('2026-11-04', '11:00'));
    expect(after.monthlyLast).toBe('2026-11-04');
    expect(after.monthlyNext).toBe(nthBusinessDay('2026-12', 3));
  });
});

describe('탐지 기준은 MILDO Alert 현재 기준을 공유 (반영된 alert_rule 변경)', () => {
  const rule = (key: string, after: string, status: ChangeRequest['status'] = 'applied'): ChangeRequest => ({
    id: `chg_${key}`, createdAt: '2026-10-31T05:00:00.000Z', module: 'alert', kind: 'alert_rule', target: key, targetId: `alert_rule:${key}`,
    before: '', after, reason: '오탐 정리', requestedBy: 'PM', approver: 'PM', status, history: [],
  });
  it('기본값은 p.47 초기값 · 반영(applied)된 변경만 적용', () => {
    const base = reportRules([]);
    for (const t of ANOMALY_THRESHOLDS) expect(base.thresholds[t.metric as 'cost'], t.metric).toEqual({ warn: t.warnPct, danger: t.dangerPct });
    expect(base.budgetLostShare).toBe(0.2);
    expect(reportRules([rule('cost', '주의 40% · 위험 70%', 'pending')]).thresholds.cost).toEqual({ warn: 30, danger: 50 });
    expect(reportRules([rule('cost', '주의 40% · 위험 70%')]).thresholds.cost).toEqual({ warn: 40, danger: 70 });
  });
  it('일간 리포트 · 시간표 문구와 판정이 바뀐 기준을 따른다', () => {
    const changes = [rule('conversions', '주의 45% · 위험 60%'), rule('cost', '주의 40% · 위험 70%')];
    const date = '2026-10-30';
    const conv = (rs: ReturnType<typeof reportRules>) => mediaDayShifts(DEMO, date, rs).find((s) => s.media === 'naver_gfa' && s.metric === 'conversions')!;
    // GFA 전환 −41%: 기본(주의 −30%)에서는 주의, 변경(주의 −45%)에서는 정상
    expect(conv(reportRules([])).level).toBe('warn');
    expect(conv(reportRules(changes)).level).toBe('ok');
    expect(conv(reportRules(changes)).threshold).toBe('주의 −45% · 위험 −60%');
    const daily = buildDailyReport(DEMO, { incidents: INCIDENTS, changes });
    const media = daily.sections.find((s) => s.id === 'media')!.blocks[0];
    expect(media.kind === 'table' ? media.columns.map((c) => c.label).join('|') : '').toContain('광고비 동요일 대비 (주의 ±40%)');
    const items = daily.sections.find((s) => s.id === 'changes')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    expect(items.find((i) => i.title.startsWith('네이버 GFA 전환'))).toBeUndefined();
    const tt = buildTimetable(DEMO, { changes });
    expect(tt.items.find((i) => i.time === '11:00')!.output).toContain('광고비 동요일 · 동시간 ±40%, 전환 최근 7일 동시간 −45%');
  });
});

describe('리뷰 보강: 판정 색 · 프로모션 표기 · 문구', () => {
  it('광고비 증감은 좋고 나쁨 색을 붙이지 않는다 (MILDO Board와 같은 표기) · CPA는 하락이 개선', () => {
    const r = buildDailyReport(DEMO);
    const kpi = r.sections.find((s) => s.id === 'kpi')!;
    const stats = kpi.blocks.find((b) => b.kind === 'stats');
    expect(stats && stats.kind === 'stats' ? stats.items.find((x) => x.label === '광고비')!.neutral : false).toBe(true);
    const table = kpi.blocks.find((b) => b.kind === 'table');
    if (table?.kind !== 'table') throw new Error('kpi table');
    const costRow = table.rows.find((row) => row[0] === '광고비')!;
    for (const c of costRow.slice(2)) expect(typeof c === 'string' ? 'neutral' : c.tone).toBe('neutral');
    const cpaRow = table.rows.find((row) => row[0] === 'CPA')!;
    const cpaCell = cpaRow[2];
    const cpaDelta = Number(String(typeof cpaCell === 'string' ? cpaCell : cpaCell.text).replace('%', ''));
    if (typeof cpaCell !== 'string' && Number.isFinite(cpaDelta) && Math.abs(cpaDelta) >= 0.05) expect(cpaCell.tone).toBe(cpaDelta < 0 ? 'good' : 'critical');
  });
  it('월간 다음 달 계획의 프로모션 상태는 대상 월 기준으로 계산한다 (9월 리포트의 10월 계획에 "월 초 종료"를 쓰지 않음)', () => {
    const plan = (m: string) => buildMonthlyReport(DEMO, { month: m }).sections.find((s) => s.id === 'plan')!.blocks.flatMap((b) => (b.kind === 'items' ? b.items : []));
    const sepPlan = plan('2026-09');
    const fall = sepPlan.find((i) => i.title.startsWith('가을 이사'))!;
    expect(fall.text).toContain('10/20(화) 시작 · 익월까지');
    expect(fall.text).not.toContain('월 초 종료');
    const octPlan = plan('2026-10');
    expect(octPlan.find((i) => i.title.startsWith('가을 이사'))!.text).toContain('11/3(화) 종료 (전월부터 진행)');
    expect(octPlan.find((i) => i.title.startsWith('11월 연말'))!.text).toContain('11월 중 시작 · 종료');
    // 지난 달 리포트의 테스트 판정은 데이터 기준일 현재 판정임을 표기
    expect(sepPlan.find((i) => i.title.startsWith('키워드 테스트'))!.title).toContain('10/31(토) 현재 판정');
  });
  it('4주 연속 목표 미달 매체가 모두 ROAS 외 판단 지표 매체면 "이 중"을 쓰지 않는다', () => {
    const p = buildDailyReport(DEMO).sections.find((s) => s.id === 'patterns')!.blocks.map((b) => (b.kind === 'p' ? b.text : '')).join('\n');
    const line = p.split('\n').find((x) => x.includes('4주 연속'));
    if (line && !line.includes('네이버 SA') && !line.includes('버티컬')) {
      expect(line).not.toContain('이 중');
      expect(line).toContain('모두 판단 지표가 ROAS가 아니므로');
    }
  });
});

describe('QA 회귀 — 절감률 표기 · 0분 판정 · 코멘트 상태', () => {
  it('fmtCut: 감소 −n% · 0은 부호 없이 · 증가는 +n% 증가 (−-n% 금지)', () => {
    expect(fmtCut(59.3)).toBe('−59%');
    expect(fmtCut(0)).toBe('0%');
    expect(fmtCut(0.3)).toBe('0%');
    expect(fmtCut(-33233)).toBe('+33,233% 증가');
    expect(fmtCut(Number.NaN)).toBe('—');
  });
  it('실측이 기존보다 크면 판정 근거에 이중 부호가 없다', () => {
    const task = SA_AUTOMATION_SCOPE[0].task;
    const s = computeSavings({ measured: { [task]: SA_AUTOMATION_SCOPE[0].before * 3 } });
    const v = measuredVerdict(s.rows[0].measuredReductionPct, s.rows[0].reductionPct)!;
    expect(v.label).toBe('하한 미달');
    expect(v.basis).not.toMatch(/−-|--/);
    expect(v.basis).toContain('증가');
    expect(s.measured!.verdict.basis).not.toMatch(/−-|--/);
  });
  it('기존 소요 합계 0분이면 하한 미달이 아니라 판정 불가', () => {
    const before = Object.fromEntries(SA_AUTOMATION_SCOPE.map((t) => [t.task, 0]));
    const s = computeSavings({ before });
    expect(s.before).toBe(0);
    expect(s.meetsFloor).toBe(false);
    expect(s.verdict.label).toBe('판정 불가');
    expect(s.verdict.basis).not.toMatch(/NaN|−0%/);
  });
  it('마크다운: AE · PM 섹션 코멘트에는 반영 대기 상태를 붙이지 않는다', () => {
    const r = buildDailyReport(DEMO);
    const md = reportToMarkdown(r, {
      feedback: [
        { sectionTitle: '매체별 성과', author: '수면밀도 담당자', text: '피드백 A', resolved: true },
        { sectionTitle: '매체별 성과', author: '담당 AE', text: '답변 B', resolved: false },
        { sectionTitle: '매체별 성과', author: '수면밀도', text: '피드백 C' },
      ],
    });
    expect(md).toContain('피드백 A — 수면밀도 담당자 · 반영 완료');
    expect(md).toContain('답변 B — 담당 AE · 코멘트');
    expect(md).not.toMatch(/답변 B[^\n]*반영 대기/);
    expect(md).toContain('피드백 C — 수면밀도 · 반영 대기');
    expect(isClientAuthor('PM')).toBe(false);
  });
});
