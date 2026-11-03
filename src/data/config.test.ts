/**
 * 워크스페이스 설정 — 스키마 · 기본값 · 병합 · 런타임 적용(constants 제자리 갱신) · 원래 값 복원 · withWorkspaceConfig 동기 보장.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, DATA_TIMETABLE, GFA_DELEGATION, MEDIA, MEDIA_IDS, REVIEW_RULES, RFP, SKU_EXPANSION, SLA, TF_ROLES,
} from './constants';
import {
  activeWorkspaceConfig, applyWorkspaceConfig, configFieldLabel, DEFAULT_CONFIG, delegationRanges, diffConfig, effectiveConfig, formatConfigValue,
  isEmptyConfig, isOwnerOnlyPath, KNOWN_MODULE_IDS, leafPaths, MEDIA_ID_LIST, mergeConfig, minutesLabel, NUMBER_FIELDS, parseWorkspaceConfig, removeOverride,
  setOverride, TIMETABLE_KEYS, TIMETABLE_LABEL, withWorkspaceConfig, type WorkspaceConfig,
} from './config';
import { KR_HOLIDAYS, isOffDay } from '@/core/util';
import { checkBulk, DEFAULT_CONFIG as ADPILOT_DEFAULTS, diagnoseKeywords, officialConfig, resolveConfig, routeByPct } from '@/modules/adpilot/engine';
import { DEMO } from './demo';
import { BOARD_RULES } from '@/modules/board/data';
import { LAB_DEFAULT_CRITERIA } from '@/modules/lab/data';
import { ON_DUTY_POOL } from '@/modules/alert/data';
import { ON_DUTY_POOL as OPS_POOL } from '@/modules/ops/data';
import { backupOf, defaultConfig as alertDefaultConfig, onDutyFor, slaTargets } from '@/modules/alert/engine';
import { impactConfig } from '@/modules/impact/engine';
import { resolveWatchConfig } from '@/modules/watch/engine';
import { normalizeShares, PROPOSAL_SHARES } from '@/modules/growth/engine';

/** 설정이 건드리는 모든 내보낸 값의 사진 */
function snapshot(): string {
  return JSON.stringify({
    RFP, AD_PILOT, ADPILOT_DEFAULTS, BOARD_RULES, LAB_DEFAULT_CRITERIA, MEDIA, GFA_DELEGATION: GFA_DELEGATION.map((g) => ({ ...g, maxPct: String(g.maxPct) })),
    DATA_TIMETABLE, SLA, ANOMALY_THRESHOLDS, KR_HOLIDAYS: Object.entries(KR_HOLIDAYS).sort(), SKU_EXPANSION, ON_DUTY_POOL, OPS_POOL, TF_ROLES, REVIEW_RULES,
    PROPOSAL_SHARES,
  });
}
const PRISTINE = snapshot();
const ORIGINAL_DEV_BACKUP = TF_ROLES.find((r) => r.id === 'dev')!.backup;

afterEach(() => applyWorkspaceConfig(null));

describe('기본값 = constants.ts', () => {
  it('브랜드 · 예산 · 목표 · SAFETY · 위임 · 시간표 · SLA · 이상 징후 기준이 constants와 같다', () => {
    expect(DEFAULT_CONFIG.brand.name).toBe(RFP.brand);
    expect(DEFAULT_CONFIG.brand.competitors).toEqual([...RFP.competitors]);
    expect(DEFAULT_CONFIG.brand.competitors).toHaveLength(6);
    expect(DEFAULT_CONFIG.budget.annual).toBe(5_000_000_000);
    expect(MEDIA_ID_LIST).toEqual(MEDIA_IDS);
    for (const id of MEDIA_IDS) expect(DEFAULT_CONFIG.budget.allocation[id]).toBe(MEDIA[id].share);
    expect(Object.values(DEFAULT_CONFIG.budget.allocation).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(DEFAULT_CONFIG.targets).toEqual({ roas: 400, brandRoas: 800, cpa: null, highEfficiencyRatio: 1.3 });
    expect(DEFAULT_CONFIG.safety).toEqual({ dailyChangeCapPct: 20, minConversionsForDown: 3, lostShareTrigger: 0.25, anomalyHoldPct: 50, bulkWarnCount: 5, bulkBlockCount: 15 });
    expect(DEFAULT_CONFIG.delegation).toEqual({ aeMaxPct: 10, pmMaxPct: 30 });
    expect(TIMETABLE_KEYS.map((k) => DEFAULT_CONFIG.timetable[k])).toEqual(DATA_TIMETABLE.map((t) => t.time));
    expect(TIMETABLE_LABEL.collect).toContain('수집');
    expect(TIMETABLE_LABEL.daily_report).toContain('일간 리포트');
    expect(TIMETABLE_LABEL.budget_check).toContain('예산 소진');
    expect(DEFAULT_CONFIG.sla.P1).toEqual({ ackMin: 15, actionMin: 30, reportMin: 120 });
    expect(DEFAULT_CONFIG.sla.P3).toEqual({ ackMin: 1440, actionMin: null, reportMin: null });
    for (const t of ANOMALY_THRESHOLDS) expect(DEFAULT_CONFIG.anomalyThresholds[t.metric as 'cost']).toEqual({ warnPct: t.warnPct, dangerPct: t.dangerPct });
    expect(DEFAULT_CONFIG.onDuty.pool).toEqual([...ON_DUTY_POOL]);
    expect(DEFAULT_CONFIG.tf.backups.pm).toBe('sa_lead');
    expect(DEFAULT_CONFIG.modules).toBeNull();
    expect(Object.isFrozen(DEFAULT_CONFIG.targets)).toBe(true);
  });

  it('기본값으로 만든 위임 범위 문장 · SLA 표기는 원문과 같다', () => {
    expect(delegationRanges(10, 30)).toEqual(GFA_DELEGATION.map((g) => g.range));
    expect(minutesLabel(15)).toBe(SLA.P1.label.ack);
    expect(minutesLabel(120)).toBe(SLA.P1.label.report);
    expect(minutesLabel(60)).toBe(SLA.P2.label.ack);
    expect(minutesLabel(240)).toBe(SLA.P2.label.action);
    expect(minutesLabel(1440)).toBe(SLA.P3.label.ack);
    expect(minutesLabel(90)).toBe('1시간 30분');
  });
});

describe('parseWorkspaceConfig', () => {
  it('바른 덮어쓰기는 그대로 통과한다 (문자열 공백 정리)', () => {
    const r = parseWorkspaceConfig({ brand: { name: '  밀도  ' }, targets: { roas: 500 }, sla: { P1: { actionMin: null } }, modules: ['board', 'alert'] });
    expect(r.errors).toEqual([]);
    expect(r.config).toEqual({ brand: { name: '밀도' }, targets: { roas: 500 }, sla: { P1: { actionMin: null } }, modules: ['board', 'alert'] });
  });

  it('범위 밖 · 형식 오류 · 알 수 없는 항목은 항목별 한국어 사유와 함께 빠진다', () => {
    const r = parseWorkspaceConfig({
      targets: { roas: 20, brandRoas: 900 }, safety: { dailyChangeCapPct: 'x' }, timetable: { collect: '7시' }, nope: 1, brand: { nickname: 'a' },
      holidays: { extra: { '2026-02-30': '없는 날', '2026-12-31': '종무식' }, exclude: ['2026-12-01'] }, modules: ['board', 'payroll'],
    });
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['targets.roas', 'safety.dailyChangeCapPct', 'timetable.collect', 'nope', 'brand.nickname', 'holidays.extra.2026-02-30', 'holidays.exclude', 'modules']));
    expect(r.errors.find((e) => e.path === 'targets.roas')!.message).toBe('50 이상이어야 합니다');
    expect(r.errors.find((e) => e.path === 'safety.dailyChangeCapPct')!.message).toBe('숫자를 입력해 주세요');
    expect(r.errors.find((e) => e.path === 'nope')!.message).toBe('알 수 없는 항목입니다');
    expect(r.errors.find((e) => e.path === 'holidays.exclude')!.message).toContain('기본 공휴일');
    // 통과한 값만 남는다
    expect(r.config).toEqual({ targets: { brandRoas: 900 }, holidays: { extra: { '2026-12-31': '종무식' } } });
  });

  it('매체 배분 합계는 100% ± 0.1%p (병합 결과 기준)', () => {
    const bad = parseWorkspaceConfig({ budget: { allocation: { naver_sa: 0.5 } } });
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].path).toBe('budget.allocation');
    expect(bad.errors[0].message).toContain('107%');
    expect(bad.config).toEqual({});
    const ok = parseWorkspaceConfig({ budget: { allocation: { naver_sa: 0.5, naver_gfa: 0.11 } } });
    expect(ok.errors).toEqual([]);
    const near = parseWorkspaceConfig({ budget: { allocation: { naver_sa: 0.4305, naver_gfa: 0.18 } } });
    expect(near.errors).toEqual([]);
    expect(parseWorkspaceConfig({ budget: { allocation: { naver_sa: 0.432, naver_gfa: 0.18 } } }).errors).toHaveLength(1);
    expect(parseWorkspaceConfig({ budget: { allocation: { tiktok: 0.1 } } }).errors[0]).toEqual({ path: 'budget.allocation.tiktok', message: '알 수 없는 항목입니다' });
  });

  it('교차 검증: 대량 변경 차단 > 경고 · PM 상한 > AE 위임 · 시간표 순서 · SLA 순서 · 위험 > 주의 · 백업 ≠ 본인', () => {
    const r = parseWorkspaceConfig({
      safety: { bulkBlockCount: 4 }, delegation: { aeMaxPct: 40 }, timetable: { daily_report: '06:00' }, sla: { P2: { ackMin: 300 } },
      anomalyThresholds: { cost: { warnPct: 60 } }, tf: { backups: { analyst: 'analyst' } }, targets: { roas: 450 },
    });
    expect(r.errors.map((e) => e.path).sort()).toEqual(['anomalyThresholds.cost', 'delegation.aeMaxPct', 'safety.bulkBlockCount', 'sla.P2', 'tf.backups.analyst', 'timetable.daily_report']);
    expect(r.config).toEqual({ targets: { roas: 450 } });
    expect(parseWorkspaceConfig({ sla: { P1: { ackMin: 90 } } }).errors.map((e) => e.path)).toContain('sla.P1');
    expect(parseWorkspaceConfig({ sla: { P2: { ackMin: 10, actionMin: 30, reportMin: 60 } } }).errors[0].message).toContain('P1 ≤ P2 ≤ P3');
  });

  it('객체가 아니면 빈 설정 + 사유, null은 빈 설정', () => {
    expect(parseWorkspaceConfig('x')).toEqual({ config: {}, errors: [{ path: '', message: expect.stringContaining('객체') }] });
    expect(parseWorkspaceConfig(null)).toEqual({ config: {}, errors: [] });
    expect(parseWorkspaceConfig([1, 2]).errors).toHaveLength(1);
  });

  it('숫자 항목 메타는 화면 · 스키마가 같은 범위를 쓴다', () => {
    expect(NUMBER_FIELDS['targets.roas']).toMatchObject({ min: 50, max: 5000 });
    expect(parseWorkspaceConfig({ targets: { roas: 5000 } }).errors).toEqual([]);
    expect(parseWorkspaceConfig({ targets: { roas: 5001 } }).errors[0].message).toBe('5,000 이하여야 합니다');
    expect(parseWorkspaceConfig({ safety: { minConversionsForDown: 2.5 } }).errors[0].message).toBe('정수를 입력해 주세요');
  });
});

describe('병합 · 경로 · 차이', () => {
  it('객체는 깊게 합치고 배열 · null은 통째로 바꾼다, 기본값은 바뀌지 않는다', () => {
    const e = mergeConfig(DEFAULT_CONFIG, { budget: { allocation: { naver_sa: 0.5, naver_gfa: 0.11 } }, brand: { competitors: ['A', 'B'] }, sla: { P1: { actionMin: null } } });
    expect(e.budget.annual).toBe(5_000_000_000);
    expect(e.budget.allocation.naver_sa).toBe(0.5);
    expect(e.budget.allocation.google).toBe(0.12);
    expect(e.brand.competitors).toEqual(['A', 'B']);
    expect(e.brand.name).toBe('수면밀도');
    expect(e.sla.P1).toEqual({ ackMin: 15, actionMin: null, reportMin: 120 });
    expect(DEFAULT_CONFIG.brand.competitors).toHaveLength(6);
    e.brand.competitors.push('C');
    expect(DEFAULT_CONFIG.brand.competitors).toHaveLength(6);
    expect(mergeConfig(DEFAULT_CONFIG, null)).toEqual(DEFAULT_CONFIG);
  });

  it('잎 경로 · 덮어쓰기 넣기/지우기 · 차이', () => {
    const o: WorkspaceConfig = { targets: { roas: 500 }, brand: { competitors: ['A'] } };
    expect(leafPaths(o).sort()).toEqual(['brand.competitors', 'targets.roas']);
    const o2 = setOverride(o, 'safety.dailyChangeCapPct', 15);
    expect(o2.safety).toEqual({ dailyChangeCapPct: 15 });
    expect(o.safety).toBeUndefined();
    const o3 = removeOverride(o2, 'targets.roas');
    expect(o3.targets).toBeUndefined();
    expect(isEmptyConfig(removeOverride(removeOverride(o3, 'brand.competitors'), 'safety.dailyChangeCapPct'))).toBe(true);
    const d = diffConfig(effectiveConfig({}), effectiveConfig({ targets: { roas: 500 }, delegation: { aeMaxPct: 15 } }));
    expect(d).toEqual([{ path: 'targets.roas', before: 400, after: 500 }, { path: 'delegation.aeMaxPct', before: 10, after: 15 }]);
  });

  it('표시 문구', () => {
    expect(configFieldLabel('targets.roas')).toBe('목표 ROAS');
    expect(configFieldLabel('budget.allocation.naver_sa')).toBe('네이버 SA 배분 비중');
    expect(configFieldLabel('timetable.collect')).toContain('시간표');
    expect(configFieldLabel('anomalyThresholds.roas.warnPct')).toBe('이상 징후 ROAS 주의');
    expect(formatConfigValue('budget.allocation.naver_sa', 0.43)).toBe('43%');
    expect(formatConfigValue('budget.annual', 5_000_000_000)).toBe('5,000,000,000원');
    expect(formatConfigValue('sla.P1.reportMin', 120)).toBe('2시간');
    expect(formatConfigValue('modules', null)).toBe('모든 모듈');
    expect(formatConfigValue('onDuty.pool', ['sa_lead', 'dev'])).toBe('SA Lead AE, 솔루션 개발자');
    expect(formatConfigValue('targets.roas', 500)).toBe('500%');
  });
});

describe('applyWorkspaceConfig — constants 제자리 갱신', () => {
  it('목표 ROAS 500 → AD_PILOT · AD Pilot 엔진 기본값 · 공식 기준 · Board · Lab · Watch가 500을 쓰고, null이면 400으로 돌아온다', () => {
    applyWorkspaceConfig({ targets: { roas: 500 } });
    expect(AD_PILOT.targetRoas).toBe(500);
    expect(ADPILOT_DEFAULTS.targetRoas).toBe(500);
    expect(resolveConfig().targetRoas).toBe(500);
    expect(officialConfig([]).targetRoas).toBe(500);
    expect(BOARD_RULES.targetRoas).toBe(500);
    expect(LAB_DEFAULT_CRITERIA.targetRoas).toBe(500);
    expect(resolveWatchConfig().targetRoas).toBe(500);
    expect(activeWorkspaceConfig().targets.roas).toBe(500);
    applyWorkspaceConfig(null);
    expect(AD_PILOT.targetRoas).toBe(400);
    expect(resolveConfig().targetRoas).toBe(400);
    expect(BOARD_RULES.targetRoas).toBe(400);
    expect(activeWorkspaceConfig()).toBe(DEFAULT_CONFIG);
    expect(snapshot()).toBe(PRISTINE);
  });

  it('AD Pilot 엔진이 실제 판정에 새 목표를 쓴다 (diagnoseKeywords · DEMO 데이터)', () => {
    const base = diagnoseKeywords(DEMO);
    expect(new Set(base.filter((d) => !d.isBrand).map((d) => d.target))).toEqual(new Set([400]));
    const raised = withWorkspaceConfig({ targets: { roas: 500 } }, () => diagnoseKeywords(DEMO));
    expect(new Set(raised.filter((d) => !d.isBrand).map((d) => d.target))).toEqual(new Set([500]));
    expect(diagnoseKeywords(DEMO).filter((d) => !d.isBrand)[0].target).toBe(400);
  });

  it('SAFETY: 대량 변경 경고 · 차단 · 일 조정 폭 상한이 반영 전 점검(checkBulk)에 그대로 쓰인다 · 급변 보류 기준은 Alert 감지에도', () => {
    const six = Array.from({ length: 6 }, () => ({ kind: 'bid' as const, changePct: 18 }));
    expect(checkBulk(six).level).toBe('warn');
    applyWorkspaceConfig({ safety: { bulkWarnCount: 8, bulkBlockCount: 12 } });
    expect(checkBulk(six).level).toBe('ok');
    applyWorkspaceConfig({ safety: { dailyChangeCapPct: 15 } });
    expect(checkBulk([{ kind: 'bid', changePct: 18 }]).level).toBe('block');
    expect(resolveConfig().dailyChangeCapPct).toBe(15);
    expect(alertDefaultConfig().keywordSpikePct).toBe(50);
    applyWorkspaceConfig({ safety: { anomalyHoldPct: 70 } });
    expect(alertDefaultConfig().keywordSpikePct).toBe(70);
  });

  it('예산 배분 → MEDIA 비중 · 연 예산, 위임 범위 → 승인 라우팅 · 문장', () => {
    applyWorkspaceConfig({ budget: { annual: 6_000_000_000, allocation: { naver_sa: 0.5, naver_gfa: 0.11 } }, delegation: { aeMaxPct: 15, pmMaxPct: 40 } });
    expect(RFP.annualBudget).toBe(6_000_000_000);
    expect(MEDIA.naver_sa.share).toBe(0.5);
    expect(MEDIA.naver_sa.annualBudget).toBe(3_000_000_000);
    expect(MEDIA.google.annualBudget).toBe(720_000_000);
    expect(routeByPct(12).approver).toBe('AE');
    expect(routeByPct(35).approver).toBe('PM');
    expect(routeByPct(45).approver).toBe('CLIENT');
    expect(GFA_DELEGATION[0].range).toBe('일 예산 ±15% 이내 · 상태 점검');
    expect(GFA_DELEGATION[2].maxPct).toBe(Infinity);
    applyWorkspaceConfig(null);
    expect(routeByPct(12).approver).toBe('PM');
    expect(MEDIA.naver_sa.annualBudget).toBe(2_150_000_000);
  });

  it('예산 배분 → 매출 성장 엔진의 배분 가안(모듈 로드 시 복사본 PROPOSAL_SHARES)도 제자리에서 바뀌고 null이면 p.37로', () => {
    const ref = PROPOSAL_SHARES;
    expect(PROPOSAL_SHARES.naver_sa).toBe(0.43);
    applyWorkspaceConfig({ budget: { allocation: { naver_sa: 0.5, naver_gfa: 0.11 } } });
    expect(PROPOSAL_SHARES).toBe(ref);
    expect(PROPOSAL_SHARES).toMatchObject({ naver_sa: 0.5, naver_gfa: 0.11, google: 0.12 });
    // 입력이 비면 가안으로 되돌리는 엔진 함수도 워크스페이스 배분을 쓴다
    expect(normalizeShares({}).naver_sa).toBe(0.5);
    applyWorkspaceConfig(null);
    expect(PROPOSAL_SHARES).toMatchObject({ naver_sa: 0.43, naver_gfa: 0.18 });
    expect(withWorkspaceConfig({ budget: { allocation: { naver_sa: 0.38, naver_gfa: 0.23 } } }, () => PROPOSAL_SHARES.naver_gfa)).toBe(0.23);
    expect(PROPOSAL_SHARES.naver_gfa).toBe(0.18);
  });

  it('소유자 전용 항목: billing.* 만 (월 구독료 = 회수 배수의 분모)', () => {
    expect(isOwnerOnlyPath('billing')).toBe(true);
    expect(isOwnerOnlyPath('billing.monthlyFee')).toBe(true);
    expect(isOwnerOnlyPath('impact.contributionMargin')).toBe(false);
    expect(isOwnerOnlyPath('billingX')).toBe(false);
    expect(isOwnerOnlyPath('ai.monthlyTokenLimit')).toBe(false);
  });

  it('브랜드 · 경쟁사(검수 규칙 포함) · 시간표 · SLA · 이상 징후 · 공휴일 · SKU · 당번 · TF 백업', () => {
    applyWorkspaceConfig({
      brand: { name: '밀도 테스트', competitors: ['시몬스', '에이스(침대)'] },
      timetable: { collect: '06:30', daily_report: '07:30' },
      sla: { P1: { ackMin: 10, reportMin: 90 }, P3: { actionMin: 2880 } },
      anomalyThresholds: { roas: { warnPct: 15, dangerPct: 30 } },
      holidays: { extra: { '2026-11-03': '창립기념일' }, exclude: ['2026-12-25'] },
      sku: { problems: ['허리 통증'] },
      onDuty: { pool: ['sa_ae', 'da_ae'] },
      tf: { backups: { analyst: 'pm' } },
    });
    expect(RFP.brand).toBe('밀도 테스트');
    expect([...RFP.competitors]).toEqual(['시몬스', '에이스(침대)']);
    const rule = REVIEW_RULES.find((r) => r.id === 'competitor')!;
    expect(new RegExp(rule.pattern).test('에이스(침대) 대비')).toBe(true);
    expect(new RegExp(rule.pattern).test('지누스')).toBe(false);
    expect(DATA_TIMETABLE[0].time).toBe('06:30');
    expect(DATA_TIMETABLE[1].time).toBe('07:30');
    expect(SLA.P1).toMatchObject({ ackMin: 10, actionMin: 30, reportMin: 90, label: { ack: '10분', action: '30분', report: '1시간 30분' } });
    expect(SLA.P3.label).toEqual({ ack: '1일', action: '2일', report: '주간' });
    expect(ANOMALY_THRESHOLDS.find((t) => t.metric === 'roas')).toMatchObject({ warnPct: 15, dangerPct: 30 });
    expect(BOARD_RULES.roasDropWarnPct).toBe(15);
    expect(alertDefaultConfig().thresholds.roas).toEqual({ warn: 15, danger: 30 });
    expect(isOffDay('2026-11-03')).toEqual({ off: true, label: '창립기념일' });
    expect(isOffDay('2026-12-25').off).toBe(false);
    expect([...SKU_EXPANSION.problems]).toEqual(['허리 통증']);
    expect([...ON_DUTY_POOL]).toEqual(['sa_ae', 'da_ae']);
    expect([...OPS_POOL]).toEqual(['sa_ae', 'da_ae']);
    expect(['sa_ae', 'da_ae']).toContain(onDutyFor('2026-11-07')!.roleId);
    expect(TF_ROLES.find((r) => r.id === 'analyst')!.backup).toBe('pm');
    applyWorkspaceConfig(null);
    expect(snapshot()).toBe(PRISTINE);
    expect(isOffDay('2026-11-03').off).toBe(false);
    expect(KR_HOLIDAYS['2026-12-25']).toBe('성탄절');
  });

  it('여러 번 적용해도 이전 적용이 섞이지 않는다 · 잘못된 항목은 무시(경고)하고 나머지만 적용', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyWorkspaceConfig({ targets: { roas: 500 }, delegation: { aeMaxPct: 20 } });
    applyWorkspaceConfig({ targets: { brandRoas: 900 } });
    expect(AD_PILOT.targetRoas).toBe(400);
    expect(AD_PILOT.brandTargetRoas).toBe(900);
    expect(GFA_DELEGATION[0].maxPct).toBe(10);
    applyWorkspaceConfig({ targets: { roas: 'abc', brandRoas: 700 }, unknown: true } as Record<string, unknown>);
    expect(AD_PILOT.targetRoas).toBe(400);
    expect(AD_PILOT.brandTargetRoas).toBe(700);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('targets.roas');
    applyWorkspaceConfig({});
    expect(snapshot()).toBe(PRISTINE);
    warn.mockRestore();
  });
});

describe('교차 요청 — 다른 도메인이 읽는 값', () => {
  it('changes: 일 조정 폭 상한 → AD Pilot 엔진 DEFAULT_CONFIG · officialConfig(executionCheck · bulkGuard 기준)에 반영, null이면 20으로', () => {
    expect(ADPILOT_DEFAULTS.dailyChangeCapPct).toBe(20);
    applyWorkspaceConfig({ safety: { dailyChangeCapPct: 12, bulkWarnCount: 7, bulkBlockCount: 20 } });
    expect(ADPILOT_DEFAULTS.dailyChangeCapPct).toBe(12);
    expect(officialConfig([]).dailyChangeCapPct).toBe(12);
    expect(officialConfig(undefined).dailyChangeCapPct).toBe(12);
    expect(ADPILOT_DEFAULTS).toMatchObject({ bulkWarnCount: 7, bulkBlockCount: 20 });
    expect(checkBulk([{ kind: 'bid', changePct: 13 }]).level).toBe('block');
    expect(checkBulk([{ kind: 'bid', changePct: 11 }]).level).toBe('ok');
    applyWorkspaceConfig(null);
    expect(ADPILOT_DEFAULTS.dailyChangeCapPct).toBe(20);
    expect(officialConfig([]).dailyChangeCapPct).toBe(20);
    expect(ADPILOT_DEFAULTS).toMatchObject({ bulkWarnCount: 5, bulkBlockCount: 15 });
    expect(snapshot()).toBe(PRISTINE);
  });

  it('changes: GFA_DELEGATION 배열 · 원소가 제자리에서 바뀐다 (같은 객체 참조 — 서버 routeApprover가 import한 값)', () => {
    const arr = GFA_DELEGATION;
    const first = GFA_DELEGATION[0];
    withWorkspaceConfig({ delegation: { aeMaxPct: 5, pmMaxPct: 25 } }, () => {
      expect(GFA_DELEGATION).toBe(arr);
      expect(GFA_DELEGATION[0]).toBe(first);
      expect(GFA_DELEGATION.map((g) => g.maxPct)).toEqual([5, 25, Infinity]);
      expect(routeByPct(6).approver).toBe('PM');
      expect(routeByPct(26).approver).toBe('CLIENT');
    });
    expect(GFA_DELEGATION.map((g) => g.maxPct)).toEqual([10, 30, Infinity]);
  });

  it('alerts: SLA 목표 · 당번 순번 · TF 백업이 Alert 엔진 계산(slaTargets · onDutyFor · backupOf)에 그대로 쓰인다', () => {
    const weekday = Date.parse('2026-11-04T10:00:00+09:00'); // 수요일
    expect(slaTargets('P1', weekday).ackMin).toBe(15);
    const inside = withWorkspaceConfig({ sla: { P1: { ackMin: 10, actionMin: 20 }, P2: { reportMin: 600 } }, onDuty: { pool: ['dev'] }, tf: { backups: { dev: 'analyst' } } }, () => ({
      p1: slaTargets('P1', weekday), p2: slaTargets('P2', weekday), duty: onDutyFor('2026-11-07'), backup: backupOf('dev'),
    }));
    expect(inside.p1).toMatchObject({ ackMin: 10, actionMin: 20, ack: '10분', action: '20분' });
    expect(inside.p2).toMatchObject({ reportMin: 600, report: '10시간' });
    expect(inside.duty).toMatchObject({ roleId: 'dev', backupId: 'analyst' });
    expect(inside.backup).toBe('analyst');
    expect(slaTargets('P1', weekday)).toMatchObject({ ackMin: 15, actionMin: 30 });
    expect(backupOf('dev')).toBe(ORIGINAL_DEV_BACKUP);
  });

  it('alerts: offHoursMode(최상위 boolean) — 스키마가 보존하고 기본값은 꺼짐', () => {
    expect(DEFAULT_CONFIG.offHoursMode).toBe(false);
    expect(parseWorkspaceConfig({ offHoursMode: true })).toEqual({ config: { offHoursMode: true }, errors: [] });
    expect(parseWorkspaceConfig({ offHoursMode: 'yes' }).errors).toEqual([{ path: 'offHoursMode', message: '켜기 · 끄기 값이어야 합니다' }]);
    expect(effectiveConfig({ offHoursMode: true }).offHoursMode).toBe(true);
    expect(configFieldLabel('offHoursMode')).toContain('당번 체계');
    expect(formatConfigValue('offHoursMode', true)).toBe('켜짐');
  });

  it('ai · reports-impact: ai.enabled · ai.monthlyTokenLimit · billing.monthlyFee · impact.* 를 스키마가 지우지 않고 impact 엔진이 같은 키로 읽는다', () => {
    const input = { ai: { enabled: false, monthlyTokenLimit: 1_000_000 }, billing: { monthlyFee: 7_000_000 }, impact: { contributionMargin: 0.35, hourlyCost: 55_000 } };
    const r = parseWorkspaceConfig(input);
    expect(r.errors).toEqual([]);
    expect(r.config).toEqual(input);
    const ic = impactConfig(r.config);
    expect(ic).toMatchObject({ monthlyFee: 7_000_000, margin: 0.35, hourlyCost: 55_000, sources: { monthlyFee: 'workspace', margin: 'workspace', hourlyCost: 'workspace' } });
    const d = impactConfig(DEFAULT_CONFIG);
    expect(d).toMatchObject({ monthlyFee: DEFAULT_CONFIG.billing.monthlyFee, margin: DEFAULT_CONFIG.impact.contributionMargin, hourlyCost: DEFAULT_CONFIG.impact.hourlyCost });
    expect(parseWorkspaceConfig({ impact: { contributionMargin: 1.5 } }).errors[0].path).toBe('impact.contributionMargin');
    expect(parseWorkspaceConfig({ ai: { monthlyTokenLimit: -1 } }).errors[0].path).toBe('ai.monthlyTokenLimit');
  });
});

describe('withWorkspaceConfig', () => {
  it('동기 실행 · 결과 반환 · 끝나면 기본값', () => {
    const v = withWorkspaceConfig({ targets: { roas: 650 } }, () => resolveConfig().targetRoas);
    expect(v).toBe(650);
    expect(AD_PILOT.targetRoas).toBe(400);
    expect(snapshot()).toBe(PRISTINE);
  });

  it('예외가 나도 되돌린다', () => {
    expect(() => withWorkspaceConfig({ safety: { dailyChangeCapPct: 5 } }, () => {
      expect(AD_PILOT.dailyChangeCapPct).toBe(5);
      throw new Error('엔진 오류');
    })).toThrow('엔진 오류');
    expect(AD_PILOT.dailyChangeCapPct).toBe(20);
    expect(snapshot()).toBe(PRISTINE);
  });

  it('프런트에서 적용 중인 설정이 있으면 그 상태로 되돌린다 (중첩)', () => {
    applyWorkspaceConfig({ targets: { roas: 520 } });
    const inner = withWorkspaceConfig({ targets: { roas: 610 } }, () => withWorkspaceConfig(null, () => AD_PILOT.targetRoas));
    expect(inner).toBe(400);
    expect(AD_PILOT.targetRoas).toBe(520);
  });

  it('fn이 Promise를 돌려주면 경고 — 비동기 구간에서는 이미 되돌려져 있다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = withWorkspaceConfig({ targets: { roas: 700 } }, async () => {
      await Promise.resolve();
      return AD_PILOT.targetRoas;
    });
    expect(warn).toHaveBeenCalled();
    expect(await p).toBe(400);
    warn.mockRestore();
  });

  it('사용 모듈 id 목록은 비어 있지 않고 중복이 없다', () => {
    expect(new Set(KNOWN_MODULE_IDS).size).toBe(KNOWN_MODULE_IDS.length);
  });
});
