import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Dataset, HourlyMediaRow } from '@/core/types';
import { generateDemoData } from '@/data/demo';
import { SLA } from '@/data/constants';
import { addDays, weekday } from '@/core/util';
import {
  activeConfig, budgetForecasts, checkAccounts, checkPromoPrices, defaultConfig, detectBulkChange, detectIncidents, detectTestIncidents,
  encodeThreshold, evaluateMedia, falsePositiveByMetric, historyRecords, holidayPrecheck, incidentReport, injectScenario, notificationLog,
  offBlocks, onDutyFor, parseThreshold, rankCauses, regimeOf, sessionRecords, slaReport, slaState, slaTargets, type AlertIncident,
} from './engine';
import { DEMO_CREATIVES } from './data';

const demo = generateDemoData();
const found = detectIncidents(demo);
const byRule = (r: string) => found.filter((i) => i.ruleId === r);

/* ---------- 합성 데이터: 한 매체 · 상수 시간대 값 ---------- */
function synthetic(opts: { todayMult?: Partial<Record<'cost' | 'clicks' | 'conversions' | 'revenue' | 'impressions', number>>; hours?: number[] } = {}): Dataset {
  const today = '2026-10-31';
  const currentHour = 15;
  const dates = Array.from({ length: 35 }, (_, i) => addDays(today, i - 34));
  const mediaHourly: HourlyMediaRow[] = [];
  for (const date of dates) {
    const last = date === today ? currentHour : 23;
    for (let h = 0; h <= last; h++) {
      const m = date === today && (opts.hours ?? [14, 15]).includes(h) ? opts.todayMult ?? {} : {};
      mediaHourly.push({
        date, hour: h, weekday: weekday(date), media: 'meta',
        impressions: 10000 * (m.impressions ?? 1), clicks: 100 * (m.clicks ?? 1), cost: 50000 * (m.cost ?? 1), conversions: 2 * (m.conversions ?? 1), revenue: 2_000_000 * (m.revenue ?? 1),
      });
    }
  }
  return {
    generatedAt: `${today}T15:30:00+09:00`, today, currentHour, dates,
    mediaDaily: dates.map((date) => ({ date, media: 'meta' as const, impressions: 240000, clicks: 2400, cost: 1_200_000, conversions: 48, revenue: 48_000_000, newCustomers: 30 })),
    mediaHourly, salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
  };
}
const emptyData = (): Dataset => ({
  generatedAt: '2026-10-31T15:30:00+09:00', today: '2026-10-31', currentHour: 15, dates: [], mediaDaily: [], mediaHourly: [], salesDaily: [],
  keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
});

describe('데모 시나리오 탐지 (엔진이 데이터로 판정)', () => {
  it('Meta 14~15시 광고비 급등 → P2 데이터 급변 (동요일 · 동시간 대비 +50% 이상)', () => {
    const i = byRule('data_spike').find((x) => x.media === 'meta');
    expect(i).toBeDefined();
    expect(i!.severity).toBe('P2');
    const cost = i!.evidence.find((e) => e.label === '광고비')!;
    expect(cost.deltaPct!).toBeGreaterThanOrEqual(50);
    expect(cost.deltaPct!).toBeLessThan(90);
    expect(cost.level).toBe('danger');
    const conv = i!.evidence.find((e) => e.label === '전환')!;
    expect(conv.deltaPct!).toBeLessThan(-20);
    expect(i!.occurredAt).toContain('T14:00');
    expect(i!.holdMedia).toBe('meta');
    expect(i!.autoActions.join(' ')).toContain('자동 조정 보류');
    expect(i!.causes.length).toBeGreaterThan(2);
  });
  it('카카오 13시 이후 전환 0 · 클릭 정상 → P1 전환 추적 단절 · 자동 조정 보류', () => {
    const i = byRule('tracking_break')[0];
    expect(i).toBeDefined();
    expect(i.media).toBe('kakao');
    expect(i.severity).toBe('P1');
    expect(i.occurredAt).toContain('T13:00');
    expect(i.autoActions.some((a) => a.includes('자동 입찰 조정 즉시 보류'))).toBe(true);
    // 같은 매체의 전환 · ROAS 급변은 추적 단절로 통합 (중복 이슈 없음)
    expect(found.some((x) => x.ruleId === 'data_spike' && x.media === 'kakao')).toBe(false);
    expect(byRule('tracking_break')).toHaveLength(1);
  });
  it('GFA 잔액 235만 < 일 평균 소진 259만 + 자동충전 실패 → P1 계정 · 결제', () => {
    const i = byRule('account_payment')[0];
    expect(i?.media).toBe('naver_gfa');
    expect(i.severity).toBe('P1');
    expect(i.title).toContain('잔액 1일치 미만');
    expect(i.title).toContain('자동충전 실패');
    expect(i.impact.revenueLossEst!).toBeGreaterThan(0);
    expect(byRule('account_payment')).toHaveLength(1);
    expect(i.recurrence?.count).toBeGreaterThanOrEqual(1); // 10월 이력에 같은 유형 존재
  });
  it('Google 비실명 공유 관리자 계정 → 권한 이슈', () => {
    const i = byRule('account_permission')[0];
    expect(i?.media).toBe('google');
    expect(i.title).toContain('agency-shared@');
  });
  it('오늘의집 계정 status review → 검수 · 확인 필요 (P2)', () => {
    const i = byRule('account_status')[0];
    expect(i?.media).toBe('ohouse');
    expect(i.severity).toBe('P2');
  });
  it('킹 옵션 품절 + 킹 매트리스 키워드 상세 랜딩 → 품절 랜딩', () => {
    const list = byRule('soldout_landing');
    expect(list.map((i) => i.target)).toEqual(['킹 매트리스']);
  });
  it("'매트리스 추천' 최근 3일 CPC 급등 → 키워드 급변 · 원인 1순위 경쟁사 입찰 상승", () => {
    const i = byRule('keyword_spike').find((x) => x.target === '매트리스 추천');
    expect(i).toBeDefined();
    expect(i!.deltaPct!).toBeGreaterThan(50);
    expect(i!.causes[0].label).toBe('경쟁사 입찰 상승');
    expect(i!.autoActions[0]).toContain('자동 조정 보류');
  });
  it('SA_일반 제품 · Meta_넓은 타겟 → 일 예산 조기 소진 예상 (다른 캠페인은 미탐지)', () => {
    const names = byRule('budget_forecast').map((i) => i.target).sort();
    expect(names).toEqual(['Meta_넓은 타겟', 'SA_일반 제품']);
    const fc = budgetForecasts(demo).find((f) => f.campaign.name === 'SA_일반 제품')!;
    expect(fc.pace).toBeGreaterThan(1.25);
    expect(fc.exhaustHour!).toBeLessThan(23);
  });
  it('id는 결정적: `${ruleId}:${target}:${today}` · 재실행 시 동일', () => {
    for (const i of found) expect(i.id).toBe(`${i.ruleId}:${i.target}:${demo.today}`);
    expect(detectIncidents(generateDemoData()).map((i) => i.id)).toEqual(found.map((i) => i.id));
    expect(new Set(found.map((i) => i.id)).size).toBe(found.length);
  });
  it('기준일 토요일 → 주말 체계: 당번 배정 · P1 PM 에스컬레이션', () => {
    const p1 = found.filter((i) => i.severity === 'P1');
    expect(p1.length).toBeGreaterThanOrEqual(2);
    for (const i of found) expect(i.onDuty).toBe(true);
    expect(p1.every((i) => i.autoActions.some((a) => a.includes('PM 에스컬레이션')))).toBe(true);
    const duty = onDutyFor(demo.today)!;
    expect(found[0].assignee).toBe(duty.role);
  });
  it('등급 순 정렬 (P1 → P2 → P3)', () => {
    const rank = { P1: 0, P2: 1, P3: 2 };
    for (let k = 1; k < found.length; k++) expect(rank[found[k].severity]).toBeGreaterThanOrEqual(rank[found[k - 1].severity]);
  });
});

describe('하드코딩이 아닌 데이터 판정 (시나리오 제거 시 미탐지)', () => {
  it('데이터를 정상화하면 해당 이슈가 사라진다', () => {
    const d = generateDemoData();
    d.accounts = d.accounts.map((a) => (a.id === 'acc_gfa' ? { ...a, balance: 9_000_000, autoCharge: 'ok' as const } : a.id === 'acc_ohouse' ? { ...a, status: 'active' as const } : a));
    d.products = d.products.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o, inStock: true })) }));
    const day = new Map(d.mediaHourly.filter((r) => r.date === addDays(d.today, -7)).map((r) => [`${r.media}|${r.hour}`, r]));
    d.mediaHourly = d.mediaHourly.map((r) => (r.date === d.today && (r.media === 'kakao' || r.media === 'meta') ? { ...day.get(`${r.media}|${r.hour}`)!, date: r.date, weekday: r.weekday } : r));
    const ids = detectIncidents(d).map((i) => i.ruleId + ':' + i.media);
    expect(ids).not.toContain('account_payment:naver_gfa');
    expect(ids).not.toContain('account_status:ohouse');
    expect(ids).not.toContain('soldout_landing:naver_sa');
    expect(ids).not.toContain('tracking_break:kakao');
    expect(ids).not.toContain('data_spike:meta');
  });
});

describe('p.47 이상 징후 기준 (동요일 · 동시간 기준선)', () => {
  it('기준선은 최근 4주 같은 요일 같은 시간 평균', () => {
    const ev = evaluateMedia(synthetic(), 'meta')!;
    expect(ev.sameWeekdayDays).toBe(4);
    expect(ev.sameWeekday!.cost).toBe(100000); // 2시간 × 50,000
    expect(ev.level).toBe('ok');
  });
  it('광고비 +60% → 위험, +35% → 주의, +10% → 정상, −55% → 위험(양방향)', () => {
    const lv = (m: number) => evaluateMedia(synthetic({ todayMult: { cost: m } }), 'meta')!.evals.find((e) => e.metric === 'cost')!.level;
    expect(lv(1.6)).toBe('danger');
    expect(lv(1.35)).toBe('warn');
    expect(lv(1.1)).toBe('ok');
    expect(lv(0.45)).toBe('danger');
  });
  it('경계값: 정확히 +50%는 위험, +30%는 주의', () => {
    const lv = (m: number) => evaluateMedia(synthetic({ todayMult: { cost: m } }), 'meta')!.evals.find((e) => e.metric === 'cost')!.level;
    expect(lv(1.5)).toBe('danger');
    expect(lv(1.3)).toBe('warn');
    expect(lv(1.29)).toBe('ok');
  });
  it('전환은 하락만 판정 (−30 주의 · −50 위험), 상승은 정상', () => {
    const lv = (m: number) => evaluateMedia(synthetic({ todayMult: { conversions: m } }), 'meta')!.evals.find((e) => e.metric === 'conversions')!.level;
    expect(lv(0.65)).toBe('warn');
    expect(lv(0.45)).toBe('danger');
    expect(lv(1.8)).toBe('ok');
  });
  it('ROAS는 −20 주의 · −35 위험', () => {
    const lv = (m: number) => evaluateMedia(synthetic({ todayMult: { revenue: m } }), 'meta')!.evals.find((e) => e.metric === 'roas')!.level;
    expect(lv(0.78)).toBe('warn');
    expect(lv(0.6)).toBe('danger');
  });
  it('합성 데이터 광고비 급변 → data_spike P2, 주의만 → anomaly_warn P3', () => {
    expect(detectIncidents(synthetic({ todayMult: { cost: 1.7 } })).map((i) => i.ruleId)).toContain('data_spike');
    const warn = detectIncidents(synthetic({ todayMult: { cost: 1.35 } }));
    expect(warn.map((i) => `${i.ruleId}:${i.severity}`)).toContain('anomaly_warn:P3');
  });
  it('기준 변경(활성 설정)이 판정에 반영된다', () => {
    const d = synthetic({ todayMult: { cost: 1.35 } });
    const cfg = defaultConfig();
    cfg.thresholds.cost = { warn: 20, danger: 30 };
    expect(detectIncidents(d, { config: cfg }).map((i) => i.ruleId)).toContain('data_spike');
  });
  it('표본 부족이면 전환 · CPA · ROAS는 참고로만 표시', () => {
    const d = synthetic({ todayMult: { conversions: 0.2, revenue: 0.2 } });
    const cfg = defaultConfig();
    cfg.minConvForRatio = 100;
    const ev = evaluateMedia(d, 'meta', cfg)!;
    expect(ev.triggering.find((e) => e.metric === 'conversions')).toBeUndefined();
    expect(ev.evals.find((e) => e.metric === 'conversions')!.note).toContain('표본 부족');
  });
});

describe('빈 데이터 · 0 나누기 · NaN 방어', () => {
  it('빈 데이터셋 → 이슈 없음, 예외 없음', () => {
    const d = emptyData();
    expect(detectIncidents(d)).toEqual([]);
    expect(budgetForecasts(d)).toEqual([]);
    expect(checkAccounts(d)).toEqual([]);
    expect(evaluateMedia(d, 'meta')).toBeNull();
    expect(slaReport([]).total.ack.pct).toBeNaN();
  });
  it('기준선이 0이어도 NaN · Infinity로 오탐하지 않는다', () => {
    const d = synthetic({ todayMult: { cost: 1 } });
    d.mediaHourly = d.mediaHourly.map((r) => ({ ...r, cost: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 }));
    const res = detectIncidents(d);
    for (const i of res) for (const e of i.evidence) expect(Number.isNaN(e.observed) && e.level === 'danger').toBe(false);
    expect(res.filter((i) => i.ruleId === 'data_spike')).toHaveLength(0);
  });
  it('NaN이 섞인 계정 · 캠페인 값에도 안전', () => {
    const d = generateDemoData();
    d.accounts = [{ ...d.accounts[0], avgDailySpend: 0 }];
    d.campaigns = [{ ...d.campaigns[0], dailyBudget: 0, spentToday: NaN }];
    expect(() => detectIncidents(d)).not.toThrow();
    expect(checkAccounts(d)[0].runwayDays).toBe(Infinity);
  });
});

describe('계정 · 결제 · 권한 (p.50)', () => {
  const checks = checkAccounts(demo);
  it('잔액 소진 예상 일수 · 소진 시각', () => {
    const gfa = checks.find((c) => c.account.id === 'acc_gfa')!;
    expect(gfa.runwayDays).toBeCloseTo(2_350_000 / 2_590_000, 3);
    expect(gfa.worst).toBe('fail');
    expect(gfa.exhaustAtMs!).toBeGreaterThan(Date.parse(demo.generatedAt));
    expect(gfa.exhaustAtMs! - Date.parse(demo.generatedAt)).toBeLessThan(26 * 3_600_000);
  });
  it('후불 계정은 runway NaN · 잔액 판정 대신 한도 확인', () => {
    const meta = checks.find((c) => c.account.id === 'acc_meta')!;
    expect(meta.prepaid).toBe(false);
    expect(meta.findings.some((f) => f.label === '잔액' && f.level === 'info')).toBe(true);
  });
  it('SA 계정은 정상', () => {
    expect(checks.find((c) => c.account.id === 'acc_sa')!.worst).toBe('ok');
  });
});

describe('SLA (p.49) · 주말 · 공휴일 (p.48)', () => {
  const weekdayMs = Date.parse('2026-11-02T10:00:00+09:00');
  const saturdayMs = Date.parse('2026-10-31T15:30:00+09:00');
  it('평일 P1: 인지 15 · 조치 30 · 보고 120분', () => {
    const t = slaTargets('P1', weekdayMs);
    expect([t.ackMin, t.actionMin, t.reportMin]).toEqual([SLA.P1.ackMin, SLA.P1.actionMin, SLA.P1.reportMin]);
  });
  it('주말 P2: 당번 30분 내 확인 · 보고는 당일', () => {
    const t = slaTargets('P2', saturdayMs);
    expect(t.ackMin).toBe(30);
    expect(t.offDay).toBe(true);
    expect(t.reportMin).toBeCloseTo(8.5 * 60, 5);
  });
  it('단계 진행 · 초과 판정', () => {
    const inc = { ...found[0], status: 'open' as const, sla: {} } as AlertIncident;
    const det = Date.parse(inc.detectedAt);
    expect(slaState(inc, det + 5 * 60_000).stage).toBe('ack');
    expect(slaState(inc, det + 20 * 60_000).overdue).toBe(true); // P1 주말 인지 15분
    const acked = { ...inc, status: 'ack' as const, sla: { ackAt: new Date(det + 10 * 60_000).toISOString() } };
    const s2 = slaState(acked, det + 12 * 60_000);
    expect(s2.stage).toBe('action');
    expect(s2.achieved.ack).toBe(true);
    const resolved = { ...acked, status: 'resolved' as const };
    expect(slaState(resolved, det).stage).toBe('done');
  });
  it('당번: 평일 없음 · 토 · 일 같은 당번 · 공휴일 배정', () => {
    expect(onDutyFor('2026-11-02')).toBeNull();
    expect(onDutyFor('2026-10-31')!.roleId).toBe(onDutyFor('2026-11-01')!.roleId);
    expect(onDutyFor('2026-12-25')).not.toBeNull();
    expect(regimeOf('2026-11-02', true).off).toBe(true);
    expect(regimeOf('2026-11-02').off).toBe(false);
  });
  it('연휴 구간: 성탄절 3일 · 설 연휴 4일', () => {
    const b = offBlocks(demo.today, 120);
    expect(b[0].start).toBe('2026-10-31');
    const xmas = b.find((x) => x.start === '2026-12-25')!;
    expect(xmas.days).toBe(3);
    expect(xmas.prevBusinessDay).toBe('2026-12-24');
    expect(xmas.hasHoliday).toBe(true);
    expect(b.find((x) => x.start === '2027-02-06')!.days).toBe(4);
  });
  it('연휴 전날 사전 점검: 실제 데이터로 잔액 · 소재 · 권한 점검', () => {
    const blk = offBlocks(demo.today, 60)[0];
    const r = holidayPrecheck(demo, blk);
    expect(r.items.find((i) => i.item.includes('GFA') && i.group === '결제 잔액')!.level).toBe('fail');
    expect(r.items.find((i) => i.item.includes('검색광고') && i.group === '결제 잔액')!.level).toBe('pass');
    expect(r.items.some((i) => i.group === '소재' && i.item.includes('킹 매트리스'))).toBe(true);
    expect(r.items.some((i) => i.group === '권한 · 당번')).toBe(true);
    expect(r.coverHours).toBeGreaterThan(30);
  });
});

describe('탐지 기준 변경 (ChangeRequest alert_rule)', () => {
  const ch = (status: ChangeRequest['status'], after: string, key = 'cost', at = '2026-11-01T00:00:00Z'): ChangeRequest => ({
    id: `c_${status}_${after}`, createdAt: at, module: 'alert', kind: 'alert_rule', target: '탐지 기준', targetId: `alert_rule:${key}`,
    before: '주의 30% · 위험 50%', after, reason: '오탐률 조정', requestedBy: 'PM', approver: 'PM', status, history: [],
  });
  it('반영(applied)된 변경만 적용, 시간순 마지막 값', () => {
    expect(parseThreshold(encodeThreshold({ warn: 25, danger: 45 }))).toEqual({ warn: 25, danger: 45 });
    expect(parseThreshold('잘못된 값')).toBeNull();
    const cfg = activeConfig([ch('pending', '주의 10% · 위험 20%'), ch('applied', '주의 25% · 위험 45%', 'cost', '2026-11-01T00:00:00Z'), ch('applied', '주의 35% · 위험 60%', 'clicks')]);
    expect(cfg.thresholds.cost).toEqual({ warn: 25, danger: 45 });
    expect(cfg.thresholds.clicks).toEqual({ warn: 35, danger: 60 });
    expect(activeConfig([ch('applied', '3시간', 'windowHours')]).windowHours).toBe(3);
    expect(activeConfig([ch('applied', '99시간', 'windowHours')]).windowHours).toBe(defaultConfig().windowHours);
  });
});

describe('대량 변경 실수 (p.45, state.changes 기반)', () => {
  const mk = (n: number, i: number, pct = 10, status: ChangeRequest['status'] = 'applied', kind: ChangeRequest['kind'] = 'bid'): ChangeRequest => ({
    id: `x${n}_${i}`, createdAt: new Date(Date.parse('2026-10-31T06:00:00Z') + i * 20_000).toISOString(), module: 'adpilot', kind, target: `kw${i}`,
    before: 1000, after: 1000 * (1 + pct / 100), changePct: pct, reason: 't', requestedBy: 'AD Pilot', approver: 'AE', status, history: [],
  });
  it('10분 내 10건 이상 → P1', () => {
    const r = detectBulkChange(Array.from({ length: 12 }, (_, i) => mk(1, i)), { today: '2026-10-31' });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe('P1');
    expect(r[0].id).toBe('bulk_change:adpilot · AD Pilot:2026-10-31');
  });
  it('9건 · 반려 · 롤백은 제외', () => {
    expect(detectBulkChange(Array.from({ length: 9 }, (_, i) => mk(2, i)))).toHaveLength(0);
    expect(detectBulkChange(Array.from({ length: 12 }, (_, i) => mk(3, i, 10, 'rejected')))).toHaveLength(0);
  });
  it('입찰 변경 폭 상한(20%) 초과 반영 · 30% 초과 예산의 승인 라우팅 불일치', () => {
    expect(detectBulkChange([mk(4, 0, 35)])[0].title).toContain('상한 초과');
    expect(detectBulkChange([mk(5, 0, 35, 'applied', 'budget')])[0].title).toContain('수면밀도 승인 없이');
    expect(detectBulkChange([mk(6, 0, 15)])).toHaveLength(0);
    expect(detectBulkChange([])).toEqual([]);
  });
});

describe('테스트 이슈 주입 (라이브 데모)', () => {
  it.each([
    ['ad_off', 'campaign_off', 'P1'],
    ['payment', 'account_payment', 'P1'],
    ['spike', 'data_spike', 'P2'],
    ['creative', 'creative_rejected', 'P2'],
  ] as const)('%s → %s (%s), isTest = true', (kind, rule, sev) => {
    const r = detectTestIncidents(demo, kind, { atIso: '2026-10-31T15:40:00+09:00', seq: 3 });
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].ruleId).toBe(rule);
    expect(r[0].severity).toBe(sev);
    expect(r[0].isTest).toBe(true);
    expect(r[0].id.endsWith(':test-3')).toBe(true);
    expect(r[0].detectedAt).toBe('2026-10-31T15:40:00+09:00');
  });
  it('주입은 원본 데이터를 바꾸지 않는다', () => {
    const before = JSON.stringify(demo.campaigns) + JSON.stringify(demo.accounts);
    injectScenario(demo, DEMO_CREATIVES, 'ad_off');
    injectScenario(demo, DEMO_CREATIVES, 'payment');
    expect(JSON.stringify(demo.campaigns) + JSON.stringify(demo.accounts)).toBe(before);
    expect(DEMO_CREATIVES.every((c) => c.status !== 'rejected')).toBe(true);
  });
});

describe('원인 후보 순위 · 가격 대조 · 알림 · 보고서 · SLA 리포트', () => {
  it('CPC 급등 · 클릭 정상 → 경쟁사 입찰 상승 1순위', () => {
    const r = rankCauses({ search: true, baseLabel: '직전', costD: 70, clicksD: 0, impsD: 0, cpcD: 70, cpmD: NaN, ctrD: NaN, cvrD: -10, clicksNormal: true, soldOutKeywords: 0 }, { promosNear: [], liveCount: 0, priceMismatch: 0 });
    expect(r[0].label).toBe('경쟁사 입찰 상승');
  });
  it('전환 0 고정 → 매체 장애 · 집계 지연 가중', () => {
    const r = rankCauses({ search: false, baseLabel: '직전', costD: 0, clicksD: 0, impsD: 0, cpcD: 0, cpmD: 0, ctrD: 0, cvrD: -100, clicksNormal: true, zeroConv: true, soldOutKeywords: 0 }, { promosNear: [], liveCount: 0, priceMismatch: 0 });
    expect(r[0].label).toBe('매체 장애 · 집계 지연');
  });
  it('가격 대조: 데모 소재가는 일치, 표기가를 바꾸면 불일치 이슈', () => {
    expect(checkPromoPrices(demo).every((x) => x.ok)).toBe(true);
    const d = generateDemoData();
    d.promotions = d.promotions.map((p) => (p.id === 'promo_1' ? { ...p, adCopyPrice: 799_000 } : p));
    expect(detectIncidents(d).some((i) => i.ruleId === 'price_mismatch')).toBe(true);
  });
  it('알림 이력: 주말 P1은 당번 호출 + PM 에스컬레이션', () => {
    const log = notificationLog(found, Date.parse(demo.generatedAt));
    const p1 = found.find((i) => i.severity === 'P1')!;
    expect(log.some((n) => n.incidentId === p1.id && n.kind === '에스컬레이션')).toBe(true);
    expect(log.some((n) => n.incidentId === p1.id && n.to.startsWith('당번'))).toBe(true);
  });
  it('보고서는 p.49 양식 5개 영역을 포함하고 번호 매기기를 쓰지 않는다', () => {
    const md = incidentReport(found[0], { nowMs: Date.parse(demo.generatedAt) });
    for (const h of ['발생 · 감지', '원인', '영향', '조치', '재발 방지']) expect(md).toContain(`### ${h}`);
    expect(md).toContain('TEST DATA');
    expect(/^\s*\d+[.)]\s/m.test(md)).toBe(false);
  });
  it('SLA 리포트: 등급별 달성률 · 오탐 · 재발 · 매체 지연', () => {
    const rep = slaReport(historyRecords());
    const p1 = rep.rows.find((r) => r.severity === 'P1')!;
    expect(p1.total).toBe(5);
    expect(p1.ack.pct).toBe(100);
    expect(p1.action.pct).toBeGreaterThan(0);
    expect(p1.action.pct).toBeLessThan(100);
    expect(p1.recurrence).toBe(1);
    expect(rep.total.mediaDelay.n).toBeGreaterThan(0);
    const fp = falsePositiveByMetric(historyRecords());
    expect(fp.cost.fp).toBeGreaterThan(0);
  });
  it('세션 처리 이력이 SLA 리포트에 합산된다', () => {
    const det = Date.parse(found[0].detectedAt);
    const handled = { ...found[0], status: 'resolved' as const, sla: { ackAt: new Date(det + 5 * 60_000).toISOString(), actionAt: new Date(det + 20 * 60_000).toISOString(), reportAt: new Date(det + 60 * 60_000).toISOString() } };
    const rec = sessionRecords([handled, found[1]]);
    expect(rec).toHaveLength(1);
    expect(rec[0].ackMin).toBeCloseTo(5, 5);
    const rep = slaReport([...historyRecords(), ...rec]);
    expect(rep.rows.find((r) => r.severity === 'P1')!.total).toBe(6);
  });
});

describe('주말 모드 시뮬레이션 (state.offHoursMode)', () => {
  it('평일 기준일에도 offHours 옵션이면 당번 배정 · P1 PM 에스컬레이션', () => {
    const d = generateDemoData('2026-11-02', 15); // 월요일
    const weekdayRun = detectIncidents(d);
    expect(weekdayRun.length).toBeGreaterThan(0);
    expect(weekdayRun.every((i) => !i.onDuty)).toBe(true);
    const forced = detectIncidents(d, { offHours: true });
    expect(forced.every((i) => i.onDuty)).toBe(true);
    const p1 = forced.find((i) => i.severity === 'P1');
    if (p1) expect(p1.autoActions.some((a) => a.includes('PM 에스컬레이션'))).toBe(true);
  });
});
