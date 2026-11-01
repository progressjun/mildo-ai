import { describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import { MEDIA, RFP, TF_ROLES } from '@/data/constants';
import type { Dataset } from '@/core/types';
import { addDays, isOffDay, KR_HOLIDAYS } from '@/core/util';
import * as alertEngine from '../alert/engine';
import {
  accountChecks, annualCost, backupGraph, contractCheck, dayDiff, decisionLoad, decisionTypeOf, dutyAccess, dutyBlocks, dutyLoad, dutyRoster, evaluationReadiness, feeBrief,
  feeCalc, isBlank, onboardingBrief, onboardingPlan, onDutyFor, opsSummary, ownershipStatus, parseKrwText, parseNum, parseRfpDate, performanceBaseline,
  referenceCheck, referenceRows, rfpBrief, rfpCoverage, rfpSchedule, simulateLeave, tfBrief, tfMarkdown, tfMissing, tfRoster, type OpsInputs,
} from './engine';
import { RFP_ITEMS } from './data';
import { defaultOpsLocal, mergeOpsLocal } from './local';

const FULL_TF = {
  pm: { name: '김총괄', years: '12', allocation: '60' },
  sa_lead: { name: '이리드', years: '9년', allocation: '70%' },
  sa_ae: { name: '박에이', years: '4', allocation: '80' },
  da_ae: { name: '최디에', years: '6', allocation: '70' },
  global_ae: { name: '정글로', years: '5', allocation: '60' },
  analyst: { name: '한분석', years: '7', allocation: '50' },
  dev: { name: '윤개발', years: '8', allocation: '50' },
};

describe('입력 파서', () => {
  it('장표 placeholder와 공백은 빈칸으로 판정', () => {
    for (const s of ['', '  ', '[성명]', '[n]년', '[n]%', '[입력]', '[ROAS · 매출 성장률]', '[적용 여부]', '월 [입력]', undefined, null]) expect(isBlank(s as string)).toBe(true);
    for (const s of ['홍길동', '7', '80%', '약 3년', '월 약 4억 원']) expect(isBlank(s)).toBe(false);
  });
  it('숫자 · 금액 텍스트 해석', () => {
    expect(parseNum('9년')).toBe(9);
    expect(parseNum('70%')).toBe(70);
    expect(parseNum('abc')).toBeNull();
    expect(parseNum(NaN)).toBeNull();
    expect(parseKrwText('월 약 4억 원')).toBe(4e8);
    expect(parseKrwText('월 약 11억 원')).toBe(11e8);
    expect(parseKrwText('1.5억')).toBe(1.5e8);
    expect(parseKrwText('4억 5천만')).toBe(4.5e8);
    expect(parseKrwText('3,000만')).toBe(3e7);
    expect(parseKrwText('[입력]')).toBeNull();
    expect(parseKrwText('약 3년')).toBeNull();
  });
});

describe('TF 명단 (p.52)', () => {
  it('기본 상태: 7개 역할 · 21칸 미입력 · RFP 전담자(SA · DA · 총괄) 지정', () => {
    const rows = tfRoster({});
    expect(rows.map((r) => r.id)).toEqual(TF_ROLES.map((r) => r.id));
    const m = tfMissing(rows);
    expect(m.cells).toBe(21);
    expect(m.total).toBe(21);
    expect(m.name).toBe(7);
    expect(m.complete).toBe(false);
    expect(m.fte).toBe(0);
    expect(m.dedicated.every((d) => d.ok)).toBe(true);
  });
  it('입력 · 오입력 검증 (투입률 1~100%, 연차 0~45년)', () => {
    const rows = tfRoster({ pm: { name: '김총괄', years: '12', allocation: '150' }, sa_ae: { name: '[성명]', years: 'abc', allocation: '0' } });
    const pm = rows.find((r) => r.id === 'pm')!;
    expect(pm.missing.name).toBe(false);
    expect(pm.invalid.allocation).toBe(true);
    const sa = rows.find((r) => r.id === 'sa_ae')!;
    expect(sa.missing.name).toBe(true);
    expect(sa.invalid.years).toBe(true);
    expect(sa.invalid.allocation).toBe(true);
    expect(tfMissing(rows).invalid).toBe(2);
  });
  it('마스킹 성명(김OO · 이**)은 실명 아님으로 오입력', () => {
    const rows = tfRoster({ pm: { name: '김OO', years: '10', allocation: '50' }, dev: { name: '이**' }, analyst: { name: '한분석' } });
    expect(rows.find((r) => r.id === 'pm')!.invalid.name).toBe(true);
    expect(rows.find((r) => r.id === 'dev')!.invalid.name).toBe(true);
    expect(rows.find((r) => r.id === 'analyst')!.invalid.name).toBe(false);
    expect(tfMissing(rows).complete).toBe(false);
  });
  it('전원 입력 시 완료 · FTE 합계', () => {
    const m = tfMissing(tfRoster(FULL_TF));
    expect(m.total).toBe(0);
    expect(m.complete).toBe(true);
    expect(m.fte).toBeCloseTo(4.4, 5);
    expect(tfMarkdown(tfRoster(FULL_TF))).toContain('| 총괄 PM | 김총괄 | 12년 |');
    expect(tfMarkdown(tfRoster({}))).toContain('[성명]');
    // 오입력(마스킹 성명 · 범위 밖 투입률)은 제출 표에 값 대신 장표 빈칸으로 남긴다
    const md = tfMarkdown(tfRoster({ ...FULL_TF, pm: { name: '김OO', years: '12', allocation: '150' } }));
    expect(md).toContain('| 총괄 PM | [성명] | 12년 | 총괄 · 단일 창구 | [n]% |');
  });
});

describe('1:1 백업 그래프', () => {
  it('제안서 구조: 상호 백업 3쌍 · PM 단방향 · SA Lead 백업 집중 · 공백 없음', () => {
    const g = backupGraph(tfRoster({}));
    expect(g.mutualPairs).toHaveLength(3);
    expect(g.gaps).toBe(0);
    expect(g.oneWay).toBe(1);
    expect(g.issues.find((i) => i.code === 'one_way')?.memberId).toBe('pm');
    expect(g.dependents.sa_lead.sort()).toEqual(['pm', 'sa_ae']);
    expect(g.issues.some((i) => i.code === 'concentration' && i.memberId === 'sa_lead')).toBe(true);
    expect(g.covered).toBe(7);
  });
  it('백업 공백 탐지: 미지정 · 본인 · 명단 외', () => {
    const g = backupGraph(tfRoster({}, { dev: '', analyst: 'analyst', da_ae: 'intern' }));
    expect(g.gaps).toBe(3);
    expect(g.issues.filter((i) => i.level === 'gap').map((i) => i.code).sort()).toEqual(['no_backup', 'self', 'unknown']);
  });
  it('업무 영역이 다른 백업은 경고', () => {
    const g = backupGraph(tfRoster({}, { analyst: 'sa_ae' }));
    expect(g.issues.some((i) => i.code === 'domain' && i.memberId === 'analyst')).toBe(true);
  });
});

describe('휴가 시뮬레이터', () => {
  it('SA AE 부재 → SA Lead가 인수, 미입력 100% 가정 + 50% 인수 = 150% 과부하', () => {
    const r = simulateLeave(tfRoster({}), ['sa_ae']);
    const lead = r.members.find((m) => m.id === 'sa_lead')!;
    expect(lead.load).toBe(150);
    expect(lead.overload).toBe(true);
    expect(r.overloaded).toEqual(['sa_lead']);
    expect(r.gaps).toHaveLength(0);
    expect(r.assumptions.assumedRoles).toHaveLength(7);
  });
  it('입력된 투입률 기준으로 재계산 — 과부하 해소', () => {
    const r = simulateLeave(tfRoster(FULL_TF), ['sa_ae']);
    const lead = r.members.find((m) => m.id === 'sa_lead')!;
    expect(lead.load).toBe(70 + 40);
    expect(lead.overload).toBe(true);
    const r2 = simulateLeave(tfRoster(FULL_TF), ['analyst']);
    expect(r2.members.find((m) => m.id === 'dev')!.load).toBe(75);
    expect(r2.overloaded).toHaveLength(0);
  });
  it('상호 백업 쌍 동시 부재 → 응답 공백, PM 대행', () => {
    const r = simulateLeave(tfRoster({}), ['sa_lead', 'sa_ae']);
    expect(r.gaps.map((g) => g.fromId).sort()).toEqual(['sa_ae', 'sa_lead']);
    expect(r.gaps.every((g) => g.fallbackId === 'pm')).toBe(true);
    expect(r.members.find((m) => m.id === 'pm')!.incoming).toHaveLength(2);
  });
  it('백업도 부재면 2차 백업으로 넘어간다 (PM → SA Lead 부재 → SA AE)', () => {
    const r = simulateLeave(tfRoster({}), ['pm', 'sa_lead']);
    const t = r.transfers.find((x) => x.fromId === 'pm')!;
    expect(t.toId).toBe('sa_ae');
    expect(t.hops).toBe(2);
    expect(r.gaps).toHaveLength(0);
  });
  it('빈 부재 · 비정상 옵션 · 명단 외 id', () => {
    const r = simulateLeave(tfRoster({}), [], { transferPct: NaN, overloadPct: Infinity, assumedAllocation: NaN });
    expect(r.transfers).toHaveLength(0);
    expect(r.maxLoad).toBe(100);
    expect(r.overloaded).toHaveLength(0);
    expect(r.assumptions.transferPct).toBe(50);
    expect(simulateLeave(tfRoster({}), ['ghost']).absent).toEqual([]);
    const all = simulateLeave(tfRoster({}), TF_ROLES.map((x) => x.id));
    expect(all.maxLoad).toBe(0);
    expect(all.gaps.length).toBe(7);
  });
  it('부재 기간과 당번 일정이 겹치면 당번 충돌 · 대체자 표시', () => {
    // 데이터 기준일 이후 첫 당번 주말의 당번을 부재로 둔다
    const first = dutyRoster(DEMO.today, 14)[0];
    const r = simulateLeave(tfRoster({}), [first.roleId], { start: first.date, days: 2 });
    expect(r.dutyConflicts.length).toBeGreaterThan(0);
    expect(r.dutyConflicts[0].roleId).toBe(first.roleId);
    expect(r.dutyConflicts[0].replacementId).toBe(TF_ROLES.find((x) => x.id === first.roleId)!.backup);
  });
});

describe('주말 · 공휴일 당번 (Alert와 같은 규칙)', () => {
  it('평일은 당번 없음, 주말은 토 · 일 같은 당번', () => {
    expect(onDutyFor('2026-11-02')).toBeNull();
    const sat = onDutyFor('2026-10-31')!;
    const sun = onDutyFor('2026-11-01')!;
    expect(sat.roleId).toBe(sun.roleId);
    expect(sat.escalation).toContain('PM');
    expect(onDutyFor('bad-date')).toBeNull();
  });
  it('평일 공휴일도 당번 배정 (2026-12-25 성탄절)', () => {
    const d = onDutyFor('2026-12-25');
    expect(d).not.toBeNull();
    expect(d!.label).toBe('성탄절');
  });
  it('MILDO Alert 엔진과 같은 순번 · 백업 · 사유 (120일 + 2026–2027 전 공휴일)', () => {
    expect(typeof alertEngine.onDutyFor).toBe('function');
    const dates = new Set<string>(Object.keys(KR_HOLIDAYS));
    for (let i = 0; i < 120; i++) dates.add(addDays(DEMO.today, i));
    for (const d of dates) {
      const a = alertEngine.onDutyFor(d);
      const o = onDutyFor(d);
      expect(o === null, d).toBe(a === null);
      if (a && o) expect({ roleId: o.roleId, backupId: o.backupId, label: o.label }, d).toEqual({ roleId: a.roleId, backupId: a.backupId, label: a.label });
    }
  });
  it('기준일부터 다음 4번의 주말 · 그 사이 공휴일 당번이 Alert 당번표와 같다', () => {
    // 데이터 기준일(10/31 토)부터 주말 4회가 들어가는 구간
    const ops = dutyBlocks(DEMO.today, 28);
    const alert = alertEngine.offBlocks(DEMO.today, 28);
    const weekends = ops.filter((b) => b.labels.some((l) => l === '토요일' || l === '일요일'));
    expect(weekends.length).toBeGreaterThanOrEqual(4);
    expect(ops.map((b) => [b.start, b.end, b.days, b.briefing])).toEqual(alert.map((b) => [b.start, b.end, b.days, b.nextBusinessDay]));
    expect(dutyRoster(DEMO.today, 28).map((r) => `${r.date}:${r.roleId}:${r.backupId}`)).toEqual(alertEngine.rotationTable(DEMO.today, 28).map((r) => `${r.date}:${r.roleId}:${r.backupId}`));
    // 연말연시 · 설 연휴(공휴일 포함 구간)도 같은 규칙
    for (const from of ['2026-12-20', '2027-02-01', '2027-09-10']) {
      const o = dutyBlocks(from, 21);
      const a = alertEngine.offBlocks(from, 21);
      expect(o.some((b) => b.hasHoliday), from).toBe(true);
      expect(o.map((b) => `${b.start}~${b.end}>${b.briefing}`), from).toEqual(a.map((b) => `${b.start}~${b.end}>${b.nextBusinessDay}`));
      expect(dutyRoster(from, 21).map((r) => r.roleId), from).toEqual(alertEngine.rotationTable(from, 21).map((r) => r.roleId));
    }
  });
  it('4주 순환: 연속 4번의 주말 당번이 매체 AE 4인으로 모두 다르다', () => {
    const sats = dutyRoster(DEMO.today, 28).filter((r) => r.label === '토요일').slice(0, 4);
    expect(sats).toHaveLength(4);
    expect(new Set(sats.map((r) => r.roleId)).size).toBe(4);
  });
  it('휴무 구간 · 다음 영업일 브리핑 · 순번 분산', () => {
    const blocks = dutyBlocks(DEMO.today, 70);
    expect(blocks[0].start).toBe('2026-10-31');
    expect(blocks[0].end).toBe('2026-11-01');
    expect(blocks[0].briefing).toBe('2026-11-02');
    expect(blocks.some((b) => b.hasHoliday)).toBe(true);
    const load = dutyLoad(dutyRoster(DEMO.today, 70));
    expect(load).toHaveLength(4);
    expect(load.every((l) => l.days > 0)).toBe(true);
    expect(dutyBlocks('nope', 10)).toEqual([]);
    expect(dutyBlocks(DEMO.today, 0)).toEqual([]);
  });
  it('당번 권한 계정: 데이터 권한 목록 기준', () => {
    const da = dutyAccess(DEMO, 'da_ae');
    expect(da.total).toBe(DEMO.accounts.length);
    expect(da.has).toBeGreaterThan(0);
    expect(dutyAccess({ ...DEMO, accounts: [] }, 'sa_lead')).toEqual({ has: 0, total: 0, missing: [] });
  });
});

describe('계정 · 결제 · 권한 (p.50) — 데모 시나리오 탐지', () => {
  it('GFA 잔액 1일치 미만 + 자동충전 실패를 데이터에서 탐지', () => {
    const gfa = accountChecks(DEMO).find((c) => c.channel === MEDIA.naver_gfa.name)!;
    const acc = DEMO.accounts.find((a) => a.media === 'naver_gfa')!;
    expect(gfa.runwayDays).toBeCloseTo(acc.balance / acc.avgDailySpend, 5);
    expect(gfa.runwayDays!).toBeLessThan(1);
    expect(gfa.level).toBe('fail');
    expect(gfa.findings.filter((f) => f.item === '결제 수단' && f.level === 'fail').length).toBe(2);
  });
  it('Google 비실명 공유 계정(관리자) 탐지', () => {
    const g = accountChecks(DEMO).find((c) => c.channel === MEDIA.google.name)!;
    expect(g.nonRealName.map((p) => p.user)).toContain('agency-shared@');
    expect(g.findings.some((f) => f.item === '접근 권한' && f.level === 'fail')).toBe(true);
  });
  it('오늘의집 계정 검수 상태 탐지', () => {
    const o = accountChecks(DEMO).find((c) => c.id === DEMO.accounts.find((a) => a.media === 'ohouse')!.id)!;
    expect(o.status).toBe('review');
    expect(o.level).toBe('warn');
  });
  it('OWNERSHIP 표 실시간 상태 · 요약', () => {
    const o = ownershipStatus(DEMO, [{ status: 'pending', approver: 'CLIENT' } as never]);
    expect(o.summary.nonRealName).toBe(1);
    expect(o.summary.paymentRisk).toBe(1);
    expect(o.summary.review).toBe(1);
    expect(o.rows.find((r) => r.item === '접근 권한')!.level).toBe('fail');
    expect(o.rows.find((r) => r.item === '예산 · 구조 변경')!.live).toContain('1건');
    const empty = ownershipStatus({ ...DEMO, accounts: [] });
    expect(empty.summary.accounts).toBe(0);
    expect(empty.rows.every((r) => !/NaN/.test(r.live))).toBe(true);
    // 계정 데이터가 없으면 '통과'가 아니라 점검 불가로 표시
    for (const item of ['광고 계정', '결제 수단', '접근 권한']) expect(empty.rows.find((r) => r.item === item)!.level, item).toBe('info');
    // 데모 데이터: 비실명 · 결제 위험은 실패, 계정 상태 검수는 주의
    const live = Object.fromEntries(o.rows.map((r) => [r.item, r.level]));
    expect(live).toMatchObject({ '광고 계정': 'warn', '결제 수단': 'fail', '접근 권한': 'fail' });
  });
  it('의사결정 체계별 승인 대기 집계', () => {
    const d = decisionLoad([{ status: 'pending', approver: 'AE', kind: 'bid' } as never, { status: 'applied', approver: 'AE', kind: 'bid' } as never]);
    expect(d.find((x) => x.type === '승인 범위 내 운영 조정')!.pending).toBe(1);
    expect(d.find((x) => x.type === '전략 방향')!.pending).toBeNull();
  });
  it('결정 유형 분류: PM 승인 입찰 · GFA 변경은 운영 조정, 탐지 기준 변경만 알림 · 시스템 기준', () => {
    const ch = (kind: string, approver: string, status = 'pending') => ({ kind, approver, status }) as never;
    const d = decisionLoad([ch('bid', 'PM'), ch('gfa', 'PM'), ch('budget', 'AE'), ch('gfa', 'CLIENT'), ch('alert_rule', 'PM'), ch('bid', 'PM', 'rejected')]);
    const by = Object.fromEntries(d.map((x) => [x.type, x.pending]));
    expect(by['승인 범위 내 운영 조정']).toBe(3);
    expect(by['예산 · 구조 변경']).toBe(1);
    expect(by['알림 · 시스템 기준']).toBe(1);
    expect(decisionTypeOf({ kind: 'alert_rule', approver: 'CLIENT' })).toBe('알림 · 시스템 기준');
    expect(decisionLoad([]).every((x) => x.pending === 0 || x.pending === null)).toBe(true);
    // OWNERSHIP '예산 · 구조 변경' 행도 같은 분류를 쓴다
    expect(ownershipStatus(DEMO, [ch('gfa', 'CLIENT'), ch('alert_rule', 'PM')]).rows.find((r) => r.item === '예산 · 구조 변경')!.live).toContain('1건');
  });
});

describe('90일 온보딩 (p.54 · p.20)', () => {
  it('Kick-off 2026-12-01 가정 → W1~W12 · 마일스톤 날짜 · 공휴일', () => {
    const p = onboardingPlan('2026-12-01', DEMO.today);
    expect(p.valid).toBe(true);
    expect(p.weeks).toHaveLength(12);
    expect(p.weeks[0]).toMatchObject({ start: '2026-12-01', end: '2026-12-07' });
    expect(p.milestones.map((m) => m.date)).toEqual(['2026-12-31', '2027-01-30', '2027-03-01']);
    expect(p.milestones[2].off.off).toBe(true); // 삼일절
    expect(p.milestones[2].reportDay).toBe('2027-02-26');
    expect(p.holidays.map((h) => h.date)).toContain('2026-12-25');
    expect(p.holidays.map((h) => h.date)).toContain('2027-02-08');
    expect(p.tasks.find((t) => t.task.startsWith('AD Pilot'))!.from).toBe(p.weeks[7].start);
    expect(p.daysToKickoff).toBe(31);
    expect(p.currentWeek).toBeNull();
    expect(p.selection.weekStart).toBe('2026-11-23');
    expect(p.selection.gapDays).toBe(2);
    expect(p.phases[1].from).toBe('2026-12-31' > p.phases[0].to ? '2026-12-31' : addDays(p.phases[0].to, 1));
  });
  it('마일스톤 실제 날짜가 속한 주차 (장표 간트 W4 · W8 · W12와 구분)', () => {
    const p = onboardingPlan('2026-12-01', DEMO.today);
    expect(p.milestones.map((m) => m.week)).toEqual([4, 8, 12]);
    expect(p.milestones.map((m) => m.calendarWeek)).toEqual([5, 9, 13]);
    for (const m of p.milestones.filter((x) => x.calendarWeek <= p.weeks.length)) {
      const w = p.weeks[m.calendarWeek - 1];
      expect(m.date >= w.start && m.date <= w.end, m.label).toBe(true);
    }
    expect(p.milestones[2].date > p.weeks[11].end).toBe(true);
  });
  it('온보딩 브리프 문구는 상수 · Kick-off에서 계산 (하드코딩 주차 없음)', () => {
    const b = onboardingBrief(DEMO, '2026-12-01');
    const all = [...b.interpretation, ...b.counter].join(' ');
    const p = onboardingPlan('2026-12-01', DEMO.today);
    const hw = [...new Set(p.holidays.map((h) => h.week))].sort((x, y) => x - y);
    expect(all).toContain(`W${hw[0]}–W${hw[hw.length - 1]}`);
    expect(all).toContain('W2–W8');
    expect(all).toContain('W8부터');
    // 공휴일이 다른 Kick-off는 다른 주차 범위
    const b2 = onboardingBrief(DEMO, '2027-03-02');
    const p2 = onboardingPlan('2027-03-02', DEMO.today);
    const hw2 = [...new Set(p2.holidays.map((h) => h.week))].sort((x, y) => x - y);
    expect(b2.counter.join(' ')).toContain(hw2.length ? `W${hw2[0]}` : '공휴일은 없지만');
    expect(b2.counter.join(' ')).not.toContain(`W${hw[0]}–W${hw[hw.length - 1]}`);
  });
  it('진행 중이면 현재 주차 · 잘못된 날짜는 기본값으로', () => {
    expect(onboardingPlan('2026-10-20', '2026-10-31').currentWeek).toBe(2);
    const bad = onboardingPlan('2026-13-40', DEMO.today);
    expect(bad.valid).toBe(false);
    expect(bad.weeks).toHaveLength(12);
    expect(onboardingPlan('2026-11-20', DEMO.today).selection.beforeSelection).toBe(true);
  });
  it('D+30 성과 기준선 (최근 30일 TEST DATA)', () => {
    const b = performanceBaseline(DEMO);
    expect(Number.isFinite(b.roas)).toBe(true);
    expect(b.roasFloor).toBeCloseTo(b.roas * 0.9, 6);
    expect(b.cpaCeiling).toBeCloseTo(b.cpa * 1.1, 6);
    const empty = performanceBaseline({ ...DEMO, mediaDaily: [] } as Dataset);
    expect(Number.isNaN(empty.roas)).toBe(true);
    expect(Number.isNaN(empty.roasFloor)).toBe(true);
  });
});

describe('레퍼런스 (p.57)', () => {
  it('기본 빈칸 6칸 · 침구 월 합산 4억 + 11억 = 15억 대조 일치', () => {
    const c = referenceCheck(referenceRows());
    expect(c.total).toBe(6);
    expect(c.sameFormat).toBe(false);
    expect(c.bedding.sum).toBe(15e8);
    expect(c.bedding.matches).toBe(true);
  });
  it('빈칸만 편집 가능 · 모두 채우면 같은 양식 충족', () => {
    const rows = referenceRows({
      homuro: { metric: 'ROAS 610% · 매출 +38%', period: '무시됨' },
      bedding_blind: { period: '약 2년', metric: 'ROAS 540%' },
      cozyma: { period: '약 1년', monthly: '월 약 2억 원', metric: 'ROAS 480%' },
    });
    expect(rows[0].cells.period.value).toBe('약 3년');
    const c = referenceCheck(rows);
    expect(c.total).toBe(0);
    expect(c.sameFormat).toBe(true);
    expect(rows[2].monthlyKrw).toBe(2e8);
  });
});

describe('수수료 · 계약 (p.58 · p.37 배분)', () => {
  it('기본: 5개 매체 배분 · 수수료 미입력', () => {
    const f = feeCalc();
    expect(f.rows.map((r) => r.budget)).toEqual([3_050_000_000, 400_000_000, 600_000_000, 600_000_000, 350_000_000]);
    expect(f.rows.reduce((s, r) => s + r.budget, 0)).toBe(RFP.annualBudget);
    expect(f.missing.fee).toBe(5);
    expect(f.missing.payback).toBe(5);
    expect(f.complete).toBe(false);
    expect(Number.isNaN(f.totals.effectivePct)).toBe(true);
    expect(f.perPointKrw).toBe(50_000_000);
  });
  it('요율 · 페이백 입력 → 연간 수수료 · 실효 수수료율', () => {
    const all = Object.fromEntries(['네이버 SA · DA', '카카오', '구글', '메타', '버티컬 매체'].map((m) => [m, { fee: '10', payback: 'no' as const }]));
    const f = feeCalc(all);
    expect(f.totals.fee).toBeCloseTo(5e8, 0);
    expect(f.totals.effectivePct).toBeCloseTo(10, 6);
    expect(f.complete).toBe(true);
    const pb = feeCalc({ ...all, '네이버 SA · DA': { fee: '10', payback: 'yes', paybackPct: '2' } });
    expect(pb.totals.payback).toBeCloseTo(61_000_000, 0);
    expect(pb.totals.net).toBeCloseTo(5e8 - 61_000_000, 0);
    expect(pb.rows[0].effectivePct).toBeCloseTo(8, 6);
  });
  it('오입력 · 0원 예산 · 페이백 초과 방어', () => {
    const f = feeCalc({ 카카오: { fee: '50', payback: 'yes' }, 구글: { fee: 'abc' }, 메타: { fee: '5', payback: 'yes', paybackPct: '8' } });
    expect(f.rows[1].feeInvalid).toBe(true);
    expect(f.rows[2].feeInvalid).toBe(true);
    expect(f.missing.paybackPct).toBe(1);
    expect(f.warnings.some((w) => w.includes('메타'))).toBe(true);
    const z = feeCalc({ 카카오: { fee: '10' } }, 0);
    expect(z.annualBudget).toBe(0);
    expect(Number.isNaN(z.totals.effectivePct)).toBe(true);
    expect(z.warnings.length).toBeGreaterThan(0);
    const n = feeCalc({}, NaN);
    expect(n.annualBudget).toBe(0);
  });
  it('오입력 칸은 미입력과 중복 집계하지 않는다', () => {
    const base = feeCalc();
    const bad = feeCalc({ 구글: { fee: 'abc' } });
    expect(bad.missing.fee).toBe(4);
    expect(bad.missing.invalid).toBe(1);
    expect(bad.missing.total + bad.missing.invalid).toBe(base.missing.total + base.missing.invalid);
    const pb = feeCalc({ 카카오: { fee: '10', payback: 'yes', paybackPct: '99' } });
    expect(pb.rows[1].paybackInvalid).toBe(true);
    expect(pb.missing.paybackPct).toBe(0);
    expect(pb.missing.invalid).toBe(1);
    expect(pb.complete).toBe(false);
  });
  it('계약 조건: 12개월 RFP 일치 · 해지 조건 · 솔루션 이용료 · 총 비용', () => {
    const c0 = contractCheck();
    expect(c0.items.find((i) => i.id === 'months')!.status).toBe('ok');
    expect(c0.missing).toBe(2);
    const c1 = contractCheck({ terminationDays: '30', solutionFee: 'separate', solutionMonthly: '5000000' });
    expect(c1.complete).toBe(true);
    expect(c1.solutionAnnual).toBe(60_000_000);
    expect(contractCheck({ terminationDays: '-3' }).items[1].status).toBe('invalid');
    expect(contractCheck({ solutionFee: 'separate' }).items[2].status).toBe('missing');
    const all = Object.fromEntries(['네이버 SA · DA', '카카오', '구글', '메타', '버티컬 매체'].map((m) => [m, { fee: '10', payback: 'no' as const }]));
    const cost = annualCost(feeCalc(all), c1);
    expect(cost.total).toBeCloseTo(5e9 + 5e8 + 6e7, 0);
    expect(cost.overheadPct).toBeCloseTo(11.2, 6);
  });
});

describe('RFP 일정 · D-day', () => {
  it('날짜 문자열 해석', () => {
    expect(parseRfpDate('26.10.27~28')).toMatchObject({ start: '2026-10-27', end: '2026-10-28' });
    expect(parseRfpDate('26.10.28~11.06')).toMatchObject({ start: '2026-10-28', end: '2026-11-06' });
    expect(parseRfpDate('26.11.16 (월) 17시')).toMatchObject({ start: '2026-11-16', hour: 17 });
    expect(parseRfpDate('26.11.24 주차')).toMatchObject({ start: '2026-11-23', end: '2026-11-29', week: true });
    expect(parseRfpDate('협의')).toBeNull();
  });
  it('기준일 10/31 15시: 제출 마감 D-16 · 386시간 · 단계 상태', () => {
    const s = rfpSchedule(DEMO.today, DEMO.currentHour);
    expect(s.deadline).toMatchObject({ date: '2026-11-16', hour: 17, days: 16, hoursLeft: 386, passed: false });
    expect(isOffDay(s.deadline.freeze).off).toBe(false);
    expect(dayDiff(s.deadline.date, s.deadline.freeze)).toBeGreaterThanOrEqual(3);
    const st = Object.fromEntries(s.rows.map((r) => [r.step, r.status]));
    expect(st['RFP 전달']).toBe('done');
    expect(st['제안서 질의응답']).toBe('now');
    expect(st['제안서 제출 마감']).toBe('next');
    expect(st['Kick-off OT']).toBe('tbd');
  });
  it('마감 당일 17시 이후는 지남', () => {
    const s = rfpSchedule('2026-11-16', 18);
    expect(s.deadline.passed).toBe(true);
    expect(s.rows.find((r) => r.step === '제안서 제출 마감')!.status).toBe('done');
  });
});

describe('RFP 커버리지 맵', () => {
  const base = { tfBlank: 21, tfInvalid: 0, feeMissing: 10, contractMissing: 2, refBlank: 6 };
  it('RFP 요청 항목 15개 + 필수 제출물 2)~7) 6개, 평가 기준 6개 모두 연결', () => {
    expect(RFP_ITEMS.filter((i) => i.group !== 'submit')).toHaveLength(15);
    expect(RFP_ITEMS.filter((i) => i.group === 'submit')).toHaveLength(6);
    for (const e of RFP.evaluation) expect(RFP_ITEMS.some((i) => i.criterion === e.id), e.id).toBe(true);
  });
  it('기본 상태: TF · 수수료 · 레퍼런스 · GEO 사례 항목은 입력 필요', () => {
    const rows = rfpCoverage(base);
    const input = rows.filter((r) => r.status === 'input').map((r) => r.id).sort();
    expect(input).toEqual(['b_people', 'p2_geo', 's4', 's6', 's7']);
    expect(rows.find((r) => r.id === 's4')!.note).toContain('21칸');
  });
  it('입력 완료 시 구현됨, 레지스트리에 없는 모듈은 입력 필요', () => {
    const rows = rfpCoverage({ tfBlank: 0, tfInvalid: 0, feeMissing: 0, contractMissing: 0, refBlank: 0, geoCaseDone: true }, ['board', 'adpilot', 'reports', 'agent', 'home', 'watch', 'lab', 'geo', 'growth', 'flow', 'alert', 'ops']);
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    const missing = rfpCoverage({ tfBlank: 0, tfInvalid: 0, feeMissing: 0, contractMissing: 0, refBlank: 0, geoCaseDone: true }, ['ops']);
    expect(missing.find((r) => r.id === 'p1_timetable')!.status).toBe('input');
    expect(missing.find((r) => r.id === 'p1_timetable')!.missingModules).toEqual(['reports']);
  });
  it('평가 비중 25/20/20/15/10/10 가중 준비도 · 우선 협상 기준 45%', () => {
    const ev = evaluationReadiness(rfpCoverage(base));
    expect(ev.rows.map((r) => r.weight)).toEqual([25, 20, 20, 15, 10, 10]);
    expect(ev.priorityWeight).toBe(45);
    expect(ev.priorityReady).toBe(45);
    expect(ev.total).toBeLessThan(100);
    expect(ev.total).toBeGreaterThan(0);
    expect(evaluationReadiness([]).total).toBe(0);
  });
});

describe('모듈 요약 · 오프라인 브리프', () => {
  const inp: OpsInputs = { tf: {} };
  it('요약: 미입력 합계 · 커버리지', () => {
    const s = opsSummary(DEMO, inp);
    expect(s.tf.total).toBe(21);
    expect(s.refs.total).toBe(6);
    expect(s.inputsMissing).toBe(21 + 6 + 10 + 2);
    expect(s.coverageDone).toBe(RFP_ITEMS.length - 5);
  });
  it('브리프: 영역 구조 · 번호 매기기 · NaN 없음', () => {
    const briefs = [tfBrief(DEMO, inp), feeBrief(inp), rfpBrief(DEMO, inp), onboardingBrief(DEMO, '2026-12-01'), tfBrief(DEMO, { tf: FULL_TF }, []), feeBrief({ tf: {}, annualBudget: 0 })];
    for (const b of briefs) {
      const all = [...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions].join('\n');
      expect(b.facts.length).toBeGreaterThan(0);
      expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(all).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect(tfBrief(DEMO, inp).facts.join(' ')).toContain('21칸');
    expect(tfBrief(DEMO, inp).facts[0]).toContain('SA 전담 지정');
    expect(feeBrief(inp).facts[0]).toContain('SA 43% · GFA 18% · Google 12% · Meta 12% · 카카오 8% · 버티컬 7%');
    expect(rfpBrief(DEMO, inp).facts[0]).toContain('D-16');
  });
  it('빈 데이터셋에서도 동작', () => {
    const empty: Dataset = { ...DEMO, accounts: [], mediaDaily: [], campaigns: [] };
    const s = opsSummary(empty, inp);
    expect(s.ownership.summary.accounts).toBe(0);
    const b = onboardingBrief(empty, '2026-12-01');
    expect([...b.facts, ...b.conditions].join('\n')).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe('모듈 로컬 입력값 (local.ts)', () => {
  it('저장값 병합: 잘못된 Kick-off · 예산 · 타입은 기본값', () => {
    expect(mergeOpsLocal(null)).toEqual(defaultOpsLocal());
    const m = mergeOpsLocal({ kickoff: '2026-02-30', annualBudget: -5, fees: [], docs: { deck: true } });
    expect(m.kickoff).toBe(defaultOpsLocal().kickoff);
    expect(m.annualBudget).toBe(RFP.annualBudget);
    expect(m.fees).toEqual({});
    expect(m.docs.deck).toBe(true);
    expect(mergeOpsLocal({ kickoff: '2027-01-04' }).kickoff).toBe('2027-01-04');
  });
});
