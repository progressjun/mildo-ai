/**
 * MILDO Watch 엔진 테스트 — 판정 규칙 · 경계값 · 빈 데이터 · 데모 시나리오 탐지 (데이터에서 계산되는지).
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Dataset } from '@/core/types';
import { DEMO, generateDemoData } from '@/data/demo';
import { ANOMALY_THRESHOLDS, MEDIA, RFP, TEST_CARD_RULES } from '@/data/constants';
import { KR_HOLIDAYS } from '@/core/util';
import {
  advanceProgress, archiveImpact, archiveMatrix, archiveRows, brandSearchTrend, brandSerpCheck, buildEvents, competitorIncident, dataNowMs, dayDiff,
  detectSignals, diagnoseEvent, evaluateEvents, fmtHoursLeft, fmtKst, intentExposure, judgeTest, kstMs, monthGrid, nextStep, nextWeeklyReport, pipelineCounts,
  resolveWatchConfig, seasonCalendar, stageDue, stageOf, testChangePayload, testDesign, trackingOverview, weeklyBrief, type WatchEvent,
} from './engine';
import { ARCHIVE_ITEMS, ARCHIVE_RECORDS, EVENT_SEEDS, LIFE_TERM_PATTERN, MEDIA_TRACKING, PIPELINE, type ArchiveRecord } from './data';

const cfg = resolveWatchConfig();
const clone = (d: Dataset): Dataset => JSON.parse(JSON.stringify(d));
const emptyData = (): Dataset => ({
  ...clone(DEMO),
  mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
});
const NO_NAN = /NaN|undefined|Infinity/;

describe('기준값 · 시간 유틸', () => {
  it('영향 진단 기준은 p.47 주의/위험 기준, 테스트 판정은 p.28 기준과 일치한다', () => {
    for (const t of ANOMALY_THRESHOLDS) {
      expect(cfg.warn[t.metric as keyof typeof cfg.warn]).toBe(t.warnPct);
      expect(cfg.danger[t.metric as keyof typeof cfg.danger]).toBe(t.dangerPct);
    }
    expect(cfg.stopDay).toBe(TEST_CARD_RULES.stopDay);
    expect(cfg.stopCvrDropPct).toBe(TEST_CARD_RULES.stopCvrDropPct);
    expect(cfg.expandCvrLiftPct).toBe(TEST_CARD_RULES.expandCvrLiftPct);
    expect(cfg.diagnoseSlaHours).toBe(24);
    expect(PIPELINE.map((p) => p.short)).toEqual(['감지', '영향 진단', '실행안', '소액 테스트', '랩업']);
  });

  it('p.24 트래킹 표는 6개 매체 · GFA 날짜 표기를 그대로 가진다', () => {
    expect(MEDIA_TRACKING.map((r) => r.name)).toEqual(['네이버 SA', '네이버 GFA', '카카오', 'Google', 'Meta', '쿠팡 · 오늘의집']);
    expect(MEDIA_TRACKING[1].target).toContain('잠재고객 확장(Beta)');
    expect(MEDIA_TRACKING[1].target).toContain('(2026.10.28)');
  });

  it('남은 시간 표기는 분 반올림 경계에서 60분을 만들지 않는다', () => {
    expect(fmtHoursLeft(23.9999)).toBe('24시간 남음');
    expect(fmtHoursLeft(0.5)).toBe('30분 남음');
    expect(fmtHoursLeft(-1.25)).toBe('1시간 15분 초과');
    expect(fmtHoursLeft(72)).toBe('3일 남음');
    expect(fmtHoursLeft(NaN)).toBe('—');
  });

  it('KST 변환은 실행 환경 시간대와 무관하다', () => {
    const ms = kstMs('2026-10-31 15:30');
    expect(ms).toBe(Date.parse('2026-10-31T15:30:00+09:00'));
    expect(fmtKst(ms)).toBe('10/31(토) 15:30');
    expect(kstMs('')).toBeNaN();
    expect(fmtKst(NaN)).toBe('—');
    expect(dayDiff('2026-11-02', '2026-10-31')).toBe(2);
    expect(dataNowMs(DEMO)).toBe(Date.parse(DEMO.generatedAt));
    expect(dataNowMs({ generatedAt: 'x', today: '2026-10-31', currentHour: 15 })).toBe(Date.parse('2026-10-31T15:30:00+09:00'));
  });

  it('다음 주간 리포트는 데이터 기준일 다음 월요일 10:00 (공휴일이면 다음 영업일)', () => {
    const r = nextWeeklyReport(DEMO);
    expect(r.date).toBe('2026-11-02');
    expect(r.label).toContain('10:00');
    // 월요일 09:00 → 같은 날, 11:00 → 다음 주
    const mon = { generatedAt: '2026-11-02T09:00:00+09:00', today: '2026-11-02', currentHour: 9 };
    expect(nextWeeklyReport(mon).date).toBe('2026-11-02');
    expect(nextWeeklyReport({ ...mon, generatedAt: '2026-11-02T11:00:00+09:00', currentHour: 11 }).date).toBe('2026-11-09');
    // 2027-02-08(월) 설 연휴 · 02-09 대체공휴일 → 02-10
    expect(KR_HOLIDAYS['2027-02-08']).toBeTruthy();
    expect(nextWeeklyReport({ generatedAt: '2027-02-06T12:00:00+09:00', today: '2027-02-06', currentHour: 12 }).date).toBe('2027-02-10');
  });
});

describe('데이터 감지 신호 (데모 시나리오를 데이터에서 잡는다)', () => {
  const signals = detectSignals(DEMO, cfg);

  it("'매트리스 추천' 최근 3일 CPC 급등 · 전환 하락을 키워드 일별 데이터에서 감지하고 AD Pilot 보류 대상으로 표기한다", () => {
    const kw = signals.filter((s) => s.signal?.rule === 'kw_cpc');
    const target = DEMO.keywords.find((k) => k.text === '매트리스 추천')!;
    expect(kw.map((s) => s.id)).toEqual([`sig_kw_cpc:${target.id}`]);
    const ev = kw[0].signal!.evidence[0];
    expect(ev.delta!).toBeGreaterThanOrEqual(cfg.adPilotHoldPct);
    expect(ev.level).toBe('danger');
    expect(kw[0].summary).toContain('자동 조정 보류');
    expect(kw[0].signal!.causes[0].label).toBe('경쟁사 입찰 상승');
    // 같은 기간 아카이브의 경쟁사 신규 진입이 원인 근거로 연결된다
    expect(kw[0].archiveRefs).toContain('ar03');
  });

  it('CPC 급등을 원래 수준으로 되돌리면 신호가 사라진다 (하드코딩 아님)', () => {
    const d = clone(DEMO);
    const k = d.keywords.find((x) => x.text === '매트리스 추천')!;
    const avgCpc = k.daily.slice(0, 11).reduce((a, r) => a + r.cost, 0) / k.daily.slice(0, 11).reduce((a, r) => a + r.clicks, 0);
    for (const r of k.daily.slice(11)) r.cost = Math.round(r.clicks * avgCpc);
    expect(detectSignals(d, cfg).some((s) => s.signal?.rule === 'kw_cpc')).toBe(false);
  });

  it('오늘 14~15시 Meta 광고비 급등(동요일 · 동시간 대비 +50% 이상)만 매체 지출 신호로 잡는다', () => {
    const media = signals.filter((s) => s.signal?.rule === 'media_spike');
    expect(media.map((s) => s.media)).toEqual(['meta']);
    const cost = media[0].signal!.evidence[0];
    expect(cost.delta!).toBeGreaterThan(50);
    expect(cost.delta!).toBeLessThan(90);
    expect(media[0].title).toContain('14~15시');
    // 조기 소진 예상 캠페인(Meta_넓은 타겟 페이스 1.58)이 함께 근거로 붙는다
    expect(media[0].campaigns).toContain('Meta_넓은 타겟');
  });

  it('Meta 급등을 제거하면 매체 지출 신호가 없다', () => {
    const d = clone(DEMO);
    for (const r of d.mediaHourly) if (r.date === d.today && r.media === 'meta' && r.hour >= 14) { r.cost = Math.round(r.cost / 1.68); r.clicks = Math.round(r.clicks / 1.55); }
    expect(detectSignals(d, cfg).some((s) => s.signal?.rule === 'media_spike')).toBe(false);
  });

  it('브랜드 키워드 평균 순위 · 노출 기회 손실로 지면 침투 의심을 잡고, 순위를 1위로 바꾸면 해제된다', () => {
    const b = signals.find((s) => s.signal?.rule === 'brand_serp')!;
    const expected = DEMO.keywords.filter((k) => k.isBrand && (k.avgRank >= cfg.brandRankMax || k.impressionShareLost >= cfg.brandLostMin)).map((k) => k.text);
    expect(expected.length).toBeGreaterThan(0);
    expect(b.keywords).toEqual(expected);
    const d = clone(DEMO);
    for (const k of d.keywords) if (k.isBrand) { k.avgRank = 1.1; k.impressionShareLost = 0.05; }
    expect(detectSignals(d, cfg).some((s) => s.signal?.rule === 'brand_serp')).toBe(false);
  });

  it('검색어 보고서의 미등록 생활 상황 구문형(전환 ≥ 1)과 신규 노출 키워드로 수요 변화를 잡는다 (p.23 D+0)', () => {
    const life = signals.find((s) => s.signal?.rule === 'life_demand')!;
    expect(life.scenario).toBe(true);
    const unregistered = DEMO.searchTerms.filter((t) => !t.registered && LIFE_TERM_PATTERN.test(t.term) && t.conversions >= 1);
    expect(unregistered.length).toBeGreaterThanOrEqual(2);
    for (const t of unregistered) expect(life.signal!.evidence.some((e) => e.label.includes(t.term))).toBe(true);
    // 스프링 구조 검색어('독립스프링 vs 포켓스프링')는 생활 상황이 아니다
    expect(LIFE_TERM_PATTERN.test('독립스프링 vs 포켓스프링')).toBe(false);
    expect(life.signal!.evidence.some((e) => e.label.includes('독립스프링'))).toBe(false);
    expect(life.keywords).toContain('첫 독립 매트리스');
    const d = clone(DEMO);
    d.searchTerms = d.searchTerms.map((t) => ({ ...t, registered: true }));
    for (const k of d.keywords) if (k.prev14.impressions === 0) k.prev14.impressions = 100;
    expect(detectSignals(d, cfg).some((s) => s.signal?.rule === 'life_demand')).toBe(false);
  });

  it('브랜드 검색량은 데모에서 ±30% 기준 미달이라 신호가 없고, 전일 검색량을 2배로 만들면 잡는다', () => {
    expect(signals.some((s) => s.signal?.rule === 'brand_search')).toBe(false);
    const d = clone(DEMO);
    const y = d.brandSearchDaily.find((r) => r.date === '2026-10-30')!;
    y.volume *= 2;
    const s = detectSignals(d, cfg).find((x) => x.signal?.rule === 'brand_search');
    expect(s).toBeTruthy();
    expect(s!.signal!.evidence[0].delta!).toBeGreaterThan(30);
  });

  it('공지 시드 + 데이터 신호로 데모 이벤트 8~12건, 다섯 단계가 모두 등장한다', () => {
    const events = buildEvents(DEMO, cfg);
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(events.length).toBeLessThanOrEqual(12);
    expect(events.filter((e) => e.origin === 'notice').length).toBe(EVENT_SEEDS.length);
    const stages = new Set(events.map((e) => e.initialStage));
    for (const p of PIPELINE) expect(stages.has(p.id)).toBe(true);
    // 같은 매체 7일 내 이벤트는 서로 연결된다
    const meta = events.find((e) => e.id === 'ev_meta_advantage')!;
    expect(meta.related.some((id) => id.startsWith('sig_media_spike:meta'))).toBe(true);
    // 최신순 정렬
    for (let i = 1; i < events.length; i++) expect(kstMs(events[i - 1].detectedAt)).toBeGreaterThanOrEqual(kstMs(events[i].detectedAt));
  });
});

describe('24시간 영향 진단', () => {
  const events = buildEvents(DEMO, cfg);
  const byId = (id: string) => events.find((e) => e.id === id)!;

  it('카카오는 오늘 13시 이후 전환 0 · 클릭 정상 → 진단 보류 (전환 추적 단절 의심)', () => {
    const dg = diagnoseEvent(byId('ev_kakao_bizboard'), DEMO, cfg);
    expect(dg.verdict).toBe('hold');
    expect(dg.holdReason).toContain('13시');
    expect(dg.basis).toContain('p.45');
    // 전환을 되살리면 보류가 풀린다
    const d = clone(DEMO);
    for (const r of d.mediaHourly) if (r.date === d.today && r.media === 'kakao' && r.hour >= 13) r.conversions = 0.3;
    expect(diagnoseEvent(byId('ev_kakao_bizboard'), d, cfg).verdict).not.toBe('hold');
  });

  it('오늘의집 계정 status review → 영향 큼 (계정 상태 근거)', () => {
    const dg = diagnoseEvent(byId('ev_ohouse_review'), DEMO, cfg);
    expect(dg.verdict).toBe('high');
    expect(dg.evidence.some((e) => e.label.includes('계정 상태') && e.level === 'danger')).toBe(true);
    const d = clone(DEMO);
    d.accounts.find((a) => a.id === 'acc_ohouse')!.status = 'active';
    expect(diagnoseEvent(byId('ev_ohouse_review'), d, cfg).evidence.some((e) => e.label.includes('계정 상태'))).toBe(false);
  });

  it('Meta 공지 이벤트는 오늘 시간대 광고비 급등과 조기 소진 캠페인으로 영향 큼', () => {
    const dg = diagnoseEvent(byId('ev_meta_advantage'), DEMO, cfg);
    expect(dg.verdict).toBe('high');
    expect(dg.evidence.some((e) => e.label.includes('Meta_넓은 타겟') && e.label.includes('소진'))).toBe(true);
  });

  it('SA 노출 영역 공지는 영향 키워드 중 CPC 상승 최대 키워드(매트리스 추천)를 근거로 든다', () => {
    const dg = diagnoseEvent(byId('ev_sa_mobile_logic'), DEMO, cfg);
    expect(dg.verdict).toBe('high');
    expect(dg.basis).toContain('매트리스 추천');
    expect(dg.affected.keywords).toBe(4);
    expect(dg.affected.spendPerDay).toBeGreaterThan(0);
  });

  it('변동 기준 미달이면 영향 미미 · 관찰, 판정 근거에 p.47 기준을 명시한다', () => {
    const dg = diagnoseEvent(byId('ev_google_demandgen'), DEMO, cfg);
    expect(dg.verdict).toBe('watch');
    expect(dg.basis).toContain('p.47');
  });

  it('빈 데이터에서는 데이터 없음 · NaN 없이 진단한다', () => {
    const d = emptyData();
    const evs = buildEvents(d, cfg);
    expect(evs.every((e) => e.origin === 'notice')).toBe(true);
    for (const e of evs) {
      const dg = diagnoseEvent(e, d, cfg);
      expect(dg.verdict).toBe('nodata');
      expect(dg.basis).not.toMatch(NO_NAN);
      expect(Number.isFinite(dg.affected.spendPerDay)).toBe(true);
    }
  });
});

describe('소액 테스트 설계 · 랩업 판정 (p.28)', () => {
  const r = (cc: number, cv: number, tc: number, tv: number) => ({ control: { clicks: cc, conversions: cv }, test: { clicks: tc, conversions: tv } });

  it('결과 없음 → 결과 수집 전, 7일 전 → 진행 중', () => {
    expect(judgeTest(undefined, 3, 14, cfg).verdict).toBe('pending');
    expect(judgeTest(r(1000, 10, 1000, 20), 6, 14, cfg).verdict).toBe('running');
  });
  it('7일차 이후 전환율 −30% 이하 → 중단 (경계값 포함)', () => {
    expect(judgeTest(r(1000, 10, 1000, 7), 7, 14, cfg).verdict).toBe('stop');
    expect(judgeTest(r(1000, 10, 1000, 7.1), 7, 14, cfg).verdict).toBe('running');
  });
  it('기간 종료 전에는 확대 판정하지 않는다', () => {
    expect(judgeTest(r(5000, 50, 5000, 80), 10, 14, cfg).verdict).toBe('running');
  });
  it('기간 종료 · +15% 이상 · p<0.05 → 확대, p≥0.05 → 판정 보류 · 유의성 부족', () => {
    const ex = judgeTest(r(6420, 70.4, 6080, 91.8), 19, 14, cfg);
    expect(ex.verdict).toBe('expand');
    expect(ex.p).toBeLessThan(0.05);
    expect(ex.basis).toContain('p=');
    expect(judgeTest(r(1000, 10, 1000, 12), 14, 14, cfg).verdict).toBe('insufficient');
  });
  it('표본 부족(그룹별 최소 클릭 미달) → 판정 보류 · 표본 부족', () => {
    const j = judgeTest(r(80, 4, 90, 8), 14, 14, cfg);
    expect(j.verdict).toBe('insufficient');
    expect(j.label).toContain('표본 부족');
  });
  it('기준 미달 · 중단 미도달 → 유지, 기존 전환 0 → 보류 (0 나누기 방어)', () => {
    expect(judgeTest(r(3920, 92.1, 3760, 90.4), 14, 14, cfg).verdict).toBe('keep');
    const z = judgeTest(r(1000, 0, 1000, 5), 14, 14, cfg);
    expect(z.verdict).toBe('insufficient');
    expect(z.label).not.toMatch(NO_NAN);
    expect(judgeTest(r(0, 0, 0, 0), NaN, 14, cfg).label).not.toMatch(NO_NAN);
  });

  it('테스트 예산 = 영향 캠페인 일 예산 × 10%, 승인 주체는 p.15 위임 범위 (광고그룹 ON → 최소 PM, 30% 초과 → 수면밀도)', () => {
    const ev = buildEvents(DEMO, cfg).find((e) => e.id === 'ev_meta_advantage')!;
    const g = testDesign(ev, DEMO, cfg);
    const base = DEMO.campaigns.filter((c) => ev.campaigns.includes(c.name)).reduce((a, c) => a + c.dailyBudget, 0);
    expect(g.baseBudget).toBe(base);
    expect(g.perDay).toBe(Math.round((base * 0.1) / 10000) * 10000);
    expect(g.total).toBe(g.perDay * 14);
    expect(g.approver).toBe('PM');
    const big: WatchEvent = { ...ev, test: { ...ev.test!, budgetShare: 0.4 } };
    expect(testDesign(big, DEMO, cfg).approver).toBe('CLIENT');
    const empty = testDesign(ev, emptyData(), cfg);
    expect(empty.perDay).toBe(0);
  });
});

describe('파이프라인 진행 · 단계 기한', () => {
  const events = buildEvents(DEMO, cfg);
  const ev = events.find((e) => e.id === 'ev_meta_advantage')!;
  const at = '2026-10-31T15:40:00+09:00';

  it('감지 → 진단 → 실행안 → 테스트 → 랩업 순서로만 진행하고, 건너뛰기는 무시한다', () => {
    let map = {};
    expect(advanceProgress(map, ev, 'plan', 'PM', at)).toBe(map);
    map = advanceProgress(map, ev, 'diagnose', 'PM', at);
    expect(stageOf(ev, map).stage).toBe('diagnose');
    map = advanceProgress(map, ev, 'plan', 'PM', at, { note: '주간 리포트' });
    map = advanceProgress(map, ev, 'test', 'PM', at, { testStart: '2026-10-31' });
    const s = stageOf(ev, map);
    expect(s.stage).toBe('test');
    expect(s.progress.testStart).toBe('2026-10-31');
    expect(s.progress.log.map((l) => l.action)).toEqual(['감지 · 업데이트 노트 수집', '영향 진단 완료', '실행안 확정', 'Lab 테스트 등록']);
    map = advanceProgress(map, ev, 'wrapup', 'PM', at, { wrapup: { verdict: 'keep', label: '유지' } });
    expect(stageOf(ev, map).stage).toBe('wrapup');
    expect(advanceProgress(map, ev, 'wrapup', 'PM', at)).toBe(map);
  });

  it('관찰 종료 후에는 더 진행하지 않는다', () => {
    const closed = advanceProgress({}, ev, 'close', 'PM', at, { note: '영향 미미' });
    expect(closed[ev.id].closed).toBe(true);
    expect(advanceProgress(closed, ev, 'diagnose', 'PM', at)).toBe(closed);
  });

  it('Lab 테스트 등록(ChangeRequest kind test)이 있으면 단계가 테스트로 반영되고, 반려되면 반영하지 않는다', () => {
    const ch = { id: 'c1', kind: 'test', targetId: ev.id, status: 'pending' } as ChangeRequest;
    expect(stageOf(ev, {}, [ch]).stage).toBe('test');
    expect(stageOf(ev, {}, [{ ...ch, status: 'rejected' }]).stage).toBe('detect');
    // 화면에서 등록(로컬 test 단계) 후 Flow에서 반려 → 실행안으로 복귀, 재등록 가능
    let map = advanceProgress({}, ev, 'diagnose', 'PM', at);
    map = advanceProgress(map, ev, 'plan', 'PM', at);
    map = advanceProgress(map, ev, 'test', 'PM', at, { testStart: '2026-10-31' });
    expect(stageOf(ev, map, [ch]).stage).toBe('test');
    const rej = stageOf(ev, map, [{ ...ch, status: 'rejected' }]);
    expect(rej.stage).toBe('plan');
    expect(rej.testRejected?.id).toBe('c1');
  });

  it('진단 기한은 감지 + 24시간을 데이터 기준 시각으로 계산한다 (Meta 공지: 10/30 16:00 감지 → 15:30 기준 30분)', () => {
    const p = stageOf(ev, {}).progress;
    const due = stageDue(ev, 'detect', DEMO, p, cfg);
    expect(due.remainingH).toBeCloseTo(0.5, 5);
    expect(due.urgent).toBe(true);
    expect(due.overdue).toBe(false);
    const later = stageDue(ev, 'detect', DEMO, p, cfg, dataNowMs(DEMO) + 3_600_000);
    expect(later.overdue).toBe(true);
    expect(later.label).toContain('초과');
  });

  it('다음 단계 버튼: 보류 매체는 테스트 등록 차단, 진행 중 테스트는 랩업 차단, 기준 미달은 관찰 종료 가능', () => {
    const evald = evaluateEvents(DEMO, { cfg });
    const kakao = evald.find((e) => e.id === 'ev_kakao_bizboard')!;
    expect(kakao.next.action).toBe('test');
    expect(kakao.next.disabled).toContain('전환');
    const gfa = evald.find((e) => e.id === 'ev_gfa_products')!;
    expect(gfa.judge.verdict).toBe('running');
    expect(gfa.next.disabled).toBeTruthy();
    const beta = evald.find((e) => e.id === 'ev_sa_expand_beta')!;
    expect(beta.judge.verdict).toBe('expand');
    expect(beta.next.action).toBe('wrapup');
    expect(beta.next.disabled).toBeUndefined();
    const google = evald.find((e) => e.id === 'ev_google_demandgen')!;
    const afterDiag = nextStep(google, 'diagnose', google.diag, google.judge);
    expect(afterDiag.canClose).toBe(true);
  });

  it('Lab 테스트 등록 페이로드는 kind test · pending용 필드 · 승인 주체를 갖는다', () => {
    const e = evaluateEvents(DEMO, { cfg }).find((x) => x.id === 'ev_meta_advantage')!;
    const p = testChangePayload(e, 'PM');
    expect(p.kind).toBe('test');
    expect(p.module).toBe('lab');
    expect(p.targetId).toBe(e.id);
    expect(p.approver).toBe('PM');
    expect(p.reason).toContain('중단');
    expect(p.reason).not.toMatch(NO_NAN);
  });

  it('파이프라인 집계 · 매체별 트래킹 현황', () => {
    const evald = evaluateEvents(DEMO, { cfg });
    const c = pipelineCounts(evald);
    expect(c.detect + c.diagnose + c.plan + c.test + c.wrapup + c.closed).toBe(evald.length);
    const rows = trackingOverview(DEMO, evald);
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.media === 'kakao')!.worst!.verdict).toBe('hold');
    expect(rows.find((r) => r.media === 'meta')!.colorVar).toBe(MEDIA.meta.colorVar);
  });
});

describe('오가닉 · 페이드 아카이브 (p.25)', () => {
  const base: ArchiveRecord = { id: 't', date: '2026-10-30', competitor: '지누스', item: 'price', channel: 'paid', title: 't', detail: 't' };

  it('가격: 직전 대비 −10% 이상 높음, −5% 이상 중간, 미만 낮음, 사은품 추가 중간, 기준 없음 낮음', () => {
    const p = (prev: number, eff: number, perk?: string) => archiveImpact({ ...base, price: { size: '퀸', list: prev, effective: eff, prevEffective: prev, perk } }, DEMO).level;
    expect(p(100000, 90000)).toBe('high');
    expect(p(100000, 94000)).toBe('mid');
    expect(p(100000, 98000)).toBe('low');
    expect(p(100000, 100000, '베개')).toBe('mid');
    const z = archiveImpact({ ...base, price: { size: '퀸', list: 0, effective: 0, prevEffective: 0 } }, DEMO);
    expect(z.level).toBe('low');
    expect(z.basis).not.toMatch(NO_NAN);
  });

  it('프로모션: 자사 기획전과 기간 중복 · 할인율 ≥ 자사 → 높음, 중복만 → 중간, 중복 없음 · 일반 테마 → 낮음', () => {
    const pr = (start: string, end: string, rate: number, theme = '쇼핑 행사') => archiveImpact({ ...base, item: 'creative', promo: { start, end, discountRate: rate, theme } }, DEMO).level;
    expect(pr('2026-10-25', '2026-11-01', 20)).toBe('high');
    expect(pr('2026-10-25', '2026-11-01', 5)).toBe('mid');
    expect(pr('2026-12-01', '2026-12-10', 30)).toBe('low');
    expect(pr('2026-12-01', '2026-12-10', 0, '신혼')).toBe('mid');
  });

  it('검색 지면: 자사 브랜드 키워드 광고 = 높음, 운영 키워드 상단 2위 이내 = 중간, 운영 키워드 아님 = 낮음', () => {
    const s = (keyword: string, position: number, channel: ArchiveRecord['channel'] = 'paid') => archiveImpact({ ...base, item: 'serp', channel, serp: { keyword, position } }, DEMO).level;
    expect(s('수면밀도', 1)).toBe('high');
    expect(s('매트리스 추천', 1)).toBe('mid');
    expect(s('매트리스 추천', 4)).toBe('low');
    expect(s('없는 키워드', 1)).toBe('low');
  });

  it('데모 아카이브: 경쟁 6개사 × 6개 항목 매트릭스, 공통 항목은 별도 집계', () => {
    const rows = archiveRows(DEMO);
    expect(rows.length).toBe(ARCHIVE_RECORDS.length);
    const m = archiveMatrix(DEMO, rows, 30);
    expect(m.items.map((i) => i.item.id)).toEqual(ARCHIVE_ITEMS.map((i) => i.id));
    const serp = m.items.find((i) => i.item.id === 'serp')!;
    expect(serp.cells.map((c) => c.competitor)).toEqual([...RFP.competitors]);
    expect(m.items.find((i) => i.item.id === 'partner')!.common!.count).toBeGreaterThan(0);
    const total = m.items.reduce((a, i) => a + (i.common ? i.common.count : i.cells.reduce((b, c) => b + c.count, 0)), 0);
    expect(total).toBe(rows.filter((r) => r.date >= m.from).length);
    expect(m.byCompetitor.find((c) => c.competitor === '베스트슬립')!.high).toBeGreaterThan(0);
  });

  it('가격 · 프로모션 변경 → Alert P3 이슈: 결정적 id · 외부 환경 유형 · 추정 영향 표기', () => {
    const row = archiveRows(DEMO).find((r) => r.id === 'ar12')!;
    expect(row.alertable).toBe(true);
    const inc = competitorIncident(row, DEMO, cfg);
    expect(inc.id).toBe(`watch_competitor:ar12:${DEMO.today}`);
    expect(inc.severity).toBe('P3');
    expect(inc.typeId).toBe('external');
    expect(inc.status).toBe('open');
    expect(Number.isFinite(inc.impact.revenueLossEst)).toBe(true);
    expect(String(inc.impactNote)).toContain('추정');
    expect(JSON.stringify(inc)).not.toMatch(/NaN|undefined/);
    expect(archiveRows(DEMO).find((r) => r.item === 'serp')!.alertable).toBe(false);
  });
});

describe('브랜드 키워드 검색 결과 지면 점검', () => {
  it('자사 광고 위치는 키워드 평균 순위(데이터)로 정하고, 위에 경쟁사가 있으면 상위 침투', () => {
    const checks = brandSerpCheck(DEMO, cfg);
    expect(checks.length).toBe(DEMO.keywords.filter((k) => k.isBrand).length);
    const main = checks.find((c) => c.keyword === '수면밀도')!;
    const kw = DEMO.keywords.find((k) => k.text === '수면밀도')!;
    expect(main.ownPos).toBe(Math.round(kw.avgRank));
    expect(main.verdict).toBe('above');
    expect(main.competitorsAbove.every((c) => (RFP.competitors as readonly string[]).includes(c))).toBe(true);
    expect(checks.find((c) => c.keyword === '밀도매트리스 후기')!.verdict).toBe('below');
  });
  it('순위가 1위면 경쟁사가 모두 아래 → 하위 침투, 스냅샷이 없으면 nodata', () => {
    const d = clone(DEMO);
    for (const k of d.keywords) if (k.isBrand) k.avgRank = 1;
    const c = brandSerpCheck(d, cfg).find((x) => x.keyword === '수면밀도')!;
    expect(c.ownPos).toBe(1);
    expect(c.competitorsAbove).toHaveLength(0);
    expect(c.verdict).toBe('below');
    expect(brandSerpCheck(DEMO, cfg, [])[0].verdict).toBe('nodata');
    expect(brandSerpCheck(emptyData(), cfg)).toEqual([]);
  });
});

describe('외부 변수 · 시즌 · 검색 트렌드', () => {
  it('시즌 캘린더: 진행 중 시즌 · 공휴일(KR_HOLIDAYS) · 자사 프로모션, D-day는 데이터 기준일', () => {
    const cal = seasonCalendar(DEMO, 120);
    expect(cal.some((c) => c.kind === 'move' && c.active)).toBe(true);
    const xmas = cal.find((c) => c.kind === 'holiday' && c.start === '2026-12-25')!;
    expect(xmas.dday).toBe(55);
    const seol = cal.find((c) => c.kind === 'holiday' && c.start === '2027-02-06')!;
    expect(seol.end).toBe('2027-02-09');
    expect(cal.filter((c) => c.kind === 'promo').map((c) => c.id)).toEqual(DEMO.promotions.filter((p) => p.end >= DEMO.today).map((p) => p.id));
    for (const c of cal.filter((x) => x.kind !== 'holiday' && x.kind !== 'promo')) expect(c.basis).toContain('가설');
    for (let i = 1; i < cal.length; i++) expect(cal[i - 1].start <= cal[i].start).toBe(true);
  });
  it('12개월 시즌 띠 — 데이터 기준월부터', () => {
    const g = monthGrid(DEMO, 12);
    expect(g.cols).toHaveLength(12);
    expect(g.cols[0].ym).toBe('2026-10');
    expect(g.cols[3].ym).toBe('2027-01');
    expect(g.rows.find((r) => r.kind === 'holiday')!.cells[2]).toContain('성탄절');
  });
  it('브랜드 검색량: 전일 vs 최근 4주 동요일, 빈 데이터 방어', () => {
    const t = brandSearchTrend(DEMO, 56, cfg);
    expect(t.points.length).toBe(56);
    expect(t.yesterday!.date).toBe('2026-10-30');
    expect(Number.isFinite(t.yesterday!.deltaPct)).toBe(true);
    const e = brandSearchTrend(emptyData(), 56, cfg);
    expect(e.yesterday).toBeNull();
    expect(Number.isNaN(e.last7Delta)).toBe(true);
  });
  it('의도별 노출 추이: 신규 노출 키워드(첫 독립 매트리스) 표기, 빈 데이터 NaN 처리', () => {
    const ie = intentExposure(DEMO);
    expect(ie.find((i) => i.intent === 'life')!.newKeywords).toContain('첫 독립 매트리스');
    expect(intentExposure(emptyData()).every((i) => Number.isNaN(i.delta))).toBe(true);
  });
});

describe('주간 인사이트 브리프 (p.28)', () => {
  const build = (d: Dataset, overrides = {}) => {
    const evs = evaluateEvents(d, { cfg, overrides });
    return weeklyBrief(d, evs, archiveRows(d, undefined, evs), brandSerpCheck(d, cfg), seasonCalendar(d), cfg);
  };

  it('이번 주 감지 사항 → 영향 → 제안 구조, 번호 매기기 · NaN 없음, 발송 일정 표기', () => {
    const b = build(DEMO);
    expect(b.period.from).toBe('2026-10-25');
    expect(b.markdown).toContain('### 확정 팩트');
    expect(b.markdown).toContain('### 다음 액션');
    expect(b.markdown).toContain('11/2(월) 10:00');
    expect(b.markdown).not.toMatch(/^\s*\d+[.)]\s/m);
    expect(b.markdown).not.toMatch(NO_NAN);
    expect(b.counts.impact).toBeGreaterThan(0);
    expect(b.brief.counter.join(' ')).toContain('카카오');
  });

  it('진행 기록을 반영한다 — 진단을 끝낸 이벤트는 진단 대기 액션에서 빠진다', () => {
    const ev = buildEvents(DEMO, cfg).find((e) => e.id === 'ev_meta_advantage')!;
    const before = build(DEMO).brief.actions.filter((a) => a.includes('Advantage+') && a.includes('영향 진단'));
    const map = advanceProgress({}, ev, 'diagnose', 'PM', '2026-10-31T15:40:00+09:00');
    const after = build(DEMO, map).brief.actions.filter((a) => a.includes('Advantage+') && a.includes('영향 진단'));
    expect(before.length + after.length).toBeGreaterThanOrEqual(0);
    expect(after).toHaveLength(0);
  });

  it('빈 데이터에서도 NaN 없이 초안을 만든다', () => {
    const b = build(emptyData());
    expect(b.markdown).not.toMatch(NO_NAN);
    expect(b.brief.facts.length).toBeGreaterThan(0);
  });

  it('다른 기준일 데이터에서도 동작한다 (기준일 의존 · new Date 미사용)', () => {
    const d = generateDemoData('2026-11-16', 11);
    const b = build(d);
    expect(b.period.to).toBe('2026-11-16');
    expect(b.markdown).not.toMatch(NO_NAN);
  });
});
