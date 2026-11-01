/**
 * MILDO Flow 엔진 테스트 — 권한(p.53) · 위임 범위(p.15) · 상태 전이 · 실행 점검 · 프로모션 자동 점검 · 리포트 · 운영 타임라인.
 * 데모 시나리오는 하드코딩 결과가 아니라 엔진이 데이터에서 잡아내는지 확인한다 (데이터를 바꾸면 결과도 바뀌어야 한다).
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Dataset, Incident } from '@/core/types';
import { DEMO } from '@/data/demo';
import { AD_PILOT, DECISION_MATRIX, FLOW_SEGMENTS, GFA_DELEGATION } from '@/data/constants';
import { detectBulkChange, detectIncidents } from '@/modules/alert/engine';
import { gfaOverview, officialConfig } from '@/modules/adpilot/engine';
import { SEED_PREFIX, STATUS_ORDER } from './data';
import {
  adpilotConfigOf, availableActions, bulkChangeAlerts, bulkGuard, canAct, decisionOf, effectiveKeywordStatus, isTopupFor, canRollback, channelMix, checkAllPromotions, checkPromotion, copyIssues, dataGuards, daysBetween,
  decisionIndexOf, delegationIndexByPct, effectiveBalance, effectiveBid, effectiveBudget, EMPTY_DRAFT, executionCheck, filterChanges, flowSummary,
  fmtDuration, fmtHour, incidentFix, incidentStagePatch, leadDeadlineMs, leadState, linkedChanges, myQueue, nextBusinessDay, nextStatus, opsBrief,
  opsCases, opsEvents, paceCampaign, parseCopyPrices, parseCopyRates, pendingBrief, planRequest, promoCheckBrief, promoNextInput, promoPhase, promoPrice, promoReport,
  refNowMs, reviewCopy, routeRequest, runwayOf, seedChanges, segmentRows, stageCounts, toNum, toRefMs, topupTargetId, type RequestDraft,
} from './engine';
import type { Brief } from '@/ai/prompts';

const clone = (d: Dataset): Dataset => structuredClone(d);
const toMs = (iso: string) => Date.parse(iso);
const NOW = Date.parse(DEMO.generatedAt); // 2026-10-31 15:30 KST
const cmpByName = (d: Dataset, name: string) => d.campaigns.find((c) => c.name === name)!;
const kwByText = (d: Dataset, t: string) => d.keywords.find((k) => k.text === t)!;
const acc = (d: Dataset, id: string) => d.accounts.find((a) => a.id === id)!;

let n = 0;
function chg(p: Partial<ChangeRequest>): ChangeRequest {
  n += 1;
  return {
    id: `t_${n}`, createdAt: '2026-10-31T14:00:00+09:00', module: 'flow', kind: 'budget', target: '테스트 대상', targetId: '',
    before: 1_000_000, after: 1_100_000, changePct: 10, reason: '테스트 요청 사유', requestedBy: 'PM', approver: 'PM', status: 'approved',
    history: [{ at: '2026-10-31T14:00:00+09:00', by: 'PM', action: '요청 생성' }], ...p,
  };
}
function draft(p: Partial<RequestDraft>): RequestDraft {
  return { ...EMPTY_DRAFT, reason: '피크 시간대 노출 확보 근거 확인', ...p };
}
function assertCleanBrief(b: Brief) {
  const all = [b.title, ...b.facts, ...b.patterns, ...b.interpretation, ...b.conditions, ...b.counter, ...b.actions].join('\n');
  expect(all).not.toMatch(/NaN|undefined|Infinity/);
  expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
  expect(b.facts.length + b.patterns.length + b.interpretation.length).toBeGreaterThan(0);
}

const INCIDENTS: Incident[] = detectIncidents(DEMO);
const SEEDS = seedChanges(DEMO);

/* ================================================================== */
describe('권한 · 위임 범위 · 결정 유형', () => {
  it('AE는 AE건, PM은 AE · PM건, 수면밀도는 전부 (p.53)', () => {
    expect(canAct('담당 AE', 'AE').ok).toBe(true);
    expect(canAct('담당 AE', 'PM').ok).toBe(false);
    expect(canAct('담당 AE', 'CLIENT').ok).toBe(false);
    expect(canAct('PM', 'AE').ok).toBe(true);
    expect(canAct('PM', 'PM').ok).toBe(true);
    expect(canAct('PM', 'CLIENT').ok).toBe(false);
    for (const a of ['AE', 'PM', 'CLIENT'] as const) expect(canAct('수면밀도', a).ok).toBe(true);
    const unknown = canAct('', 'AE');
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toContain('미지정');
  });

  it('변경 폭 → GFA_DELEGATION 행 (경계값은 이내 포함, NaN은 최상위)', () => {
    expect(delegationIndexByPct(0)).toBe(0);
    expect(delegationIndexByPct(10)).toBe(0);
    expect(delegationIndexByPct(-10)).toBe(0);
    expect(delegationIndexByPct(10.5)).toBe(1);
    expect(delegationIndexByPct(-25)).toBe(1);
    expect(delegationIndexByPct(30)).toBe(1);
    expect(delegationIndexByPct(30.1)).toBe(2);
    expect(delegationIndexByPct(NaN)).toBe(2);
    expect(GFA_DELEGATION[delegationIndexByPct(35)].approver).toBe('CLIENT');
  });

  it('요청 유형별 승인 주체 자동 결정 (p.15 · p.53)', () => {
    expect(routeRequest('budget', 5).approver).toBe('AE');
    expect(routeRequest('budget', 20).approver).toBe('PM');
    expect(routeRequest('budget', 35).approver).toBe('CLIENT');
    expect(routeRequest('budget', NaN).approver).toBe('CLIENT');
    expect(routeRequest('bid', -8).approver).toBe('AE');
    expect(routeRequest('onoff').approver).toBe('PM');
    expect(routeRequest('onoff').delegationIndex).toBe(1);
    expect(routeRequest('new_campaign').approver).toBe('CLIENT');
    expect(routeRequest('creative').approver).toBe('AE');
    expect(routeRequest('keyword').approver).toBe('AE');
    const rule = routeRequest('alert_rule');
    expect(rule.approver).toBe('PM');
    expect(DECISION_MATRIX[rule.decisionIndex].type).toBe('알림 · 시스템 기준');
    const strat = routeRequest('strategy');
    expect(strat.approver).toBe('CLIENT');
    expect(DECISION_MATRIX[strat.decisionIndex].decider).toBe('수면밀도');
    expect(routeRequest('budget', 20).basis.join(' ')).toMatch(/p\.15/);
    expect(routeRequest('budget', 20).basis.join(' ')).toMatch(/p\.53/);
  });

  it('결정 유형 매핑: AE건 = 운영 조정(즉시), PM · 수면밀도건 = 예산 · 구조(당일)', () => {
    expect(decisionIndexOf({ kind: 'bid', approver: 'AE', targetId: '', target: '' })).toBe(0);
    expect(decisionIndexOf({ kind: 'budget', approver: 'PM', targetId: '', target: '' })).toBe(1);
    expect(decisionIndexOf({ kind: 'alert_rule', approver: 'PM', targetId: '', target: '' })).toBe(2);
    expect(decisionIndexOf({ kind: 'setting', approver: 'CLIENT', targetId: 'flow:strategy:x', target: '' })).toBe(3);
  });
});

/* ================================================================== */
describe('리드타임 (p.53 소요 → 판정 시한)', () => {
  it('즉시 = 60분, 당일 = 17:00, 17시 이후 · 주말은 다음 영업일 17:00', () => {
    const ae = { kind: 'bid' as const, approver: 'AE' as const, targetId: '', target: '' };
    const pm = { kind: 'budget' as const, approver: 'PM' as const, targetId: '', target: '' };
    const thu = Date.parse('2026-10-29T16:10:00+09:00');
    expect(leadDeadlineMs(ae, thu) - thu).toBe(60 * 60_000);
    expect(leadDeadlineMs(pm, thu)).toBe(Date.parse('2026-10-29T17:00:00+09:00'));
    expect(leadDeadlineMs(pm, Date.parse('2026-10-29T17:30:00+09:00'))).toBe(Date.parse('2026-10-30T17:00:00+09:00'));
    // 2026-10-31(토) → 다음 영업일 11/2(월)
    expect(leadDeadlineMs(pm, Date.parse('2026-10-31T10:00:00+09:00'))).toBe(Date.parse('2026-11-02T17:00:00+09:00'));
    expect(nextBusinessDay('2026-10-30')).toBe('2026-11-02');
    expect(Number.isNaN(leadDeadlineMs(pm, NaN))).toBe(true);
  });

  it('대기 중 기준 초과 · 결정 건 충족 여부', () => {
    const waiting = chg({ approver: 'AE', kind: 'bid', status: 'pending', createdAt: '2026-10-31T13:00:00+09:00' });
    const l = leadState(waiting, NOW, toMs);
    expect(l.overdue).toBe(true); // 13:00 + 60분 < 15:30
    expect(Math.round(l.elapsedMin)).toBe(150);
    const fresh = chg({ approver: 'AE', kind: 'bid', status: 'pending', createdAt: '2026-10-31T15:00:00+09:00' });
    expect(leadState(fresh, NOW, toMs).overdue).toBe(false);
    const decided = chg({
      approver: 'PM', status: 'approved', createdAt: '2026-10-29T16:10:00+09:00',
      history: [{ at: '2026-10-29T16:10:00+09:00', by: 'PM', action: '요청 생성' }, { at: '2026-10-30T10:00:00+09:00', by: 'PM', action: '승인' }],
    });
    const d = leadState(decided, NOW, toMs);
    expect(d.met).toBe(false);
    expect(d.overdue).toBe(false);
    expect(d.text).toContain('초과');
  });

  it('잘못된 시각은 NaN으로 두고 화면 문자열은 대체 표기', () => {
    const broken = chg({ createdAt: 'not-a-date', status: 'pending' });
    const l = leadState(broken, NOW, toMs);
    expect(Number.isNaN(l.createdMs)).toBe(true);
    expect(l.overdue).toBe(false);
    expect(fmtDuration(NaN)).toBe('—');
    expect(fmtDuration(0.4)).toBe('1분 미만');
    expect(fmtDuration(1500)).toBe('1일 1시간');
    expect(fmtHour(null)).toBe('—');
    expect(fmtHour(20.37)).toBe('20:22');
    expect(fmtHour(24.2)).toBe('24:00');
  });
});

/* ================================================================== */
describe('상태 전이 · 액션 · 롤백', () => {
  it('승인 → 반영 → 롤백, 보류 해제는 승인 이력이 있으면 승인으로', () => {
    const c = chg({ status: 'pending' });
    expect(nextStatus(c, 'approve')).toBe('approved');
    expect(nextStatus(c, 'reject')).toBe('rejected');
    expect(nextStatus(c, 'hold')).toBe('held');
    expect(nextStatus(c, 'resume')).toBe('pending');
    const approvedThenHeld = chg({ status: 'held', history: [{ at: '2026-10-31T14:00:00+09:00', by: 'PM', action: '요청 생성' }, { at: '2026-10-31T14:05:00+09:00', by: 'PM', action: '일괄 승인' }] });
    expect(nextStatus(approvedThenHeld, 'resume')).toBe('approved');
    expect(nextStatus(c, 'apply')).toBe('applied');
    expect(nextStatus(c, 'rollback')).toBe('rolled_back');
    expect(nextStatus(c, 'cancel')).toBe('rejected');
  });

  it('상태별 가능한 액션 + 권한 밖이면 전부 비활성', () => {
    const p = chg({ status: 'pending', approver: 'CLIENT' });
    expect(availableActions(p, '수면밀도', [p]).map((a) => a.action)).toEqual(['approve', 'reject', 'hold']);
    expect(availableActions(p, 'PM', [p]).every((a) => !a.ok)).toBe(true);
    expect(availableActions(chg({ status: 'approved' }), 'PM', []).map((a) => a.action)).toEqual(['apply', 'hold', 'cancel']);
    expect(availableActions(chg({ status: 'rejected' }), 'PM', [])).toEqual([]);
    expect(availableActions(chg({ status: 'rolled_back' }), 'PM', [])).toEqual([]);
  });

  it('롤백은 같은 대상의 가장 최근 반영 건만 (직전 상태 복원)', () => {
    const a1 = chg({ status: 'applied', module: 'adpilot', kind: 'bid', targetId: 'kw_22', history: [{ at: '2026-10-30T10:00:00+09:00', by: 'PM', action: '반영' }] });
    const a2 = chg({ status: 'applied', module: 'adpilot', kind: 'bid', targetId: 'kw_22', history: [{ at: '2026-10-31T10:00:00+09:00', by: 'PM', action: '반영' }] });
    expect(canRollback([a1, a2], a1).ok).toBe(false);
    expect(canRollback([a1, a2], a2).ok).toBe(true);
    expect(canRollback([a1], chg({ status: 'approved' })).ok).toBe(false);
  });

  it('반영 상태 → 현재 값 (입찰 · 예산 · 잔액), 롤백 · 반려 건은 제외', () => {
    const d = DEMO;
    const k = kwByText(d, '신혼 매트리스');
    const applied = chg({ module: 'adpilot', kind: 'bid', targetId: k.id, after: k.bid + 100, status: 'applied', history: [{ at: '2026-10-31T10:00:00+09:00', by: 'PM', action: '반영' }] });
    expect(effectiveBid(k, [applied])).toBe(k.bid + 100);
    expect(effectiveBid(k, [{ ...applied, status: 'rolled_back' }])).toBe(k.bid);
    const cmp = cmpByName(d, 'GFA_Prospecting');
    expect(effectiveBudget(cmp, [chg({ kind: 'budget', targetId: `gfa:budget:${cmp.id}`, after: 1_500_000, status: 'applied' })])).toBe(1_500_000);
    const sa = cmpByName(d, 'SA_일반 제품');
    const donor = cmpByName(d, 'SA_생활 상황');
    const shift = chg({ module: 'adpilot', kind: 'budget', targetId: `budget:${sa.id}:${donor.id}`, before: sa.dailyBudget, after: sa.dailyBudget + 100_000, status: 'applied' });
    expect(effectiveBudget(sa, [shift])).toBe(sa.dailyBudget + 100_000);
    expect(effectiveBudget(donor, [shift])).toBe(donor.dailyBudget - 100_000);
    const gfa = acc(d, 'acc_gfa');
    const topup = chg({ module: 'alert', kind: 'setting', targetId: topupTargetId(gfa), before: gfa.balance, after: gfa.balance + 5_500_000, status: 'applied' });
    expect(effectiveBalance(gfa, [topup])).toBe(gfa.balance + 5_500_000);
    expect(runwayOf(gfa, [topup])).toBeGreaterThan(3);
    expect(runwayOf(acc(d, 'acc_google'))).toBe(Infinity); // 후불
  });
});

/* ================================================================== */
describe('실행 점검 (p.15 04 · p.45 · p.14 SAFETY)', () => {
  it('GFA 증액: AD Pilot 화면과 같은 validateGfaExecution — 메인 계정 잔액 0.91일치 · 자동충전 실패 → 보류', () => {
    const cmp = cmpByName(DEMO, 'GFA_Prospecting');
    const c = chg({ module: 'gfa', kind: 'budget', targetId: `gfa:budget:${cmp.id}`, before: cmp.dailyBudget, after: cmp.dailyBudget * 1.1 });
    const ex = executionCheck(DEMO, [], INCIDENTS, c);
    expect(ex.ok).toBe(false);
    expect(ex.blocks.join(' ')).toMatch(/GFA Control 실행 검증/);
    expect(ex.blocks.join(' ')).toMatch(/자동충전/);
    // 감액은 GFA Control에서도 실행 가능
    const down = executionCheck(DEMO, [], INCIDENTS, chg({ module: 'gfa', kind: 'budget', targetId: `gfa:budget:${cmp.id}`, before: cmp.dailyBudget, after: cmp.dailyBudget * 0.9, changePct: -10 }));
    expect(down.ok).toBe(true);
    // 지원 API 범위 밖 GFA 요청은 실행하지 않는다
    expect(executionCheck(DEMO, [], [], chg({ module: 'gfa', kind: 'setting', targetId: 'gfa:unknown:x' })).ok).toBe(false);
  });

  it('GFA 다계정: 잔액이 충분한 다른 GFA 계정 캠페인은 메인 계정 잔액 부족으로 막지 않는다', () => {
    const views = gfaOverview(DEMO, []);
    const healthy = views.find((v) => v.account.id !== 'acc_gfa' && Number.isFinite(v.runwayDays) && v.runwayDays >= 1 && v.account.autoCharge !== 'failed' && v.campaigns.length);
    expect(healthy).toBeTruthy();
    const cv = healthy!.campaigns[0].campaign;
    const c = chg({ module: 'gfa', kind: 'budget', targetId: `gfa:budget:${cv.id}`, before: cv.dailyBudget, after: Math.round(cv.dailyBudget * 1.1), changePct: 10, approver: 'AE' });
    const ex = executionCheck(DEMO, [], INCIDENTS, c);
    expect(ex.blocks.join(' ')).not.toMatch(/0\.91|1일치 미만/);
    expect(ex.ok).toBe(true);
  });

  it('비GFA 계정: 잔액 1일치 미만이면 증액 보류, 충전 반영(두 targetId 형식) 후 해제', () => {
    const d = clone(DEMO);
    const kakaoAcc = d.accounts.find((a) => a.id === 'acc_kakao')!;
    kakaoAcc.balance = 500_000; // 0.45일치
    const cmp = cmpByName(d, '카카오_장바구니 리마케팅');
    const up = chg({ targetId: `flow:budget:${cmp.id}`, before: cmp.dailyBudget, after: cmp.dailyBudget * 1.05, changePct: 5, approver: 'AE' });
    expect(executionCheck(d, [], [], up).blocks.join(' ')).toMatch(/1일치 미만/);
    const viaAccount = chg({ module: 'alert', kind: 'setting', target: `${kakaoAcc.name} 충전`, targetId: topupTargetId(kakaoAcc), after: 4_000_000, status: 'applied' });
    expect(executionCheck(d, [viaAccount], [], up).blocks.join(' ')).not.toMatch(/1일치 미만/);
    // MILDO Alert 이슈 드로어 형식 'alert:<이슈>:topup' + 대상 '<계정명> 비즈머니 충전'
    const viaIncident = chg({ module: 'alert', kind: 'setting', target: `${kakaoAcc.name} 비즈머니 충전`, targetId: 'alert:account_payment:카카오모먼트:2026-10-31:topup', after: 4_000_000, status: 'applied' });
    expect(isTopupFor(kakaoAcc, viaIncident)).toBe(true);
    expect(isTopupFor(acc(d, 'acc_sa'), viaIncident)).toBe(false);
    expect(effectiveBalance(kakaoAcc, [viaIncident])).toBe(4_000_000);
    expect(executionCheck(d, [viaIncident], [], up).blocks.join(' ')).not.toMatch(/1일치 미만/);
  });

  it('AD Pilot 입찰 · 예산: validateAdpilotExecution — 키워드 급변(매트리스 추천) · 매체 보류(카카오 추적 단절)는 반영 보류', () => {
    const k = kwByText(DEMO, '매트리스 추천');
    const bid = chg({ module: 'adpilot', kind: 'bid', targetId: k.id, before: k.bid, after: k.bid + 50, changePct: 4, approver: 'AE' });
    const ex = executionCheck(DEMO, [], INCIDENTS, bid);
    expect(ex.ok).toBe(false);
    expect(ex.blocks.join(' ')).toMatch(/AD Pilot 실행 검증 · 자동 조정 보류 중 — 매트리스 추천/);
    // 급변이 없는 키워드는 통과
    const ok = kwByText(DEMO, '신혼 매트리스');
    expect(executionCheck(DEMO, [], INCIDENTS, chg({ module: 'adpilot', kind: 'bid', targetId: ok.id, before: ok.bid, after: ok.bid + 50, changePct: 4, approver: 'AE' })).ok).toBe(true);
    // AD Pilot 예산 재배분 형식 'budget:<받는 캠페인>:<주는 캠페인>' — 카카오 매체 보류
    const kakao = cmpByName(DEMO, '카카오_프로모션');
    const shift = chg({ module: 'adpilot', kind: 'budget', targetId: `budget:${kakao.id}:`, before: kakao.dailyBudget, after: kakao.dailyBudget * 1.05, changePct: 5, approver: 'AE' });
    expect(executionCheck(DEMO, [], INCIDENTS, shift).blocks.join(' ')).toMatch(/AD Pilot 실행 검증 · 자동 조정 보류 중 — 카카오/);
    // 시연용 이력(seed: 대상)은 AD Pilot 실제 키워드와 분리 — AD Pilot 검증 생략
    expect(executionCheck(DEMO, [], INCIDENTS, { ...SEEDS.find((c) => c.id === `${SEED_PREFIX}1`)!, status: 'approved' }).blocks.join(' ')).not.toMatch(/AD Pilot 실행 검증/);
  });

  it('프로모션 단위 예산 요청: 진행 중이면 유입 매체 계정 · 데이터 이상으로 보류, 오픈 전이면 주의로만', () => {
    const live = executionCheck(DEMO, [], INCIDENTS, chg({ targetId: 'flow:promo:promo_1:budget', before: 10_000_000, after: 11_000_000, changePct: 10, approver: 'AE' }));
    expect(live.ok).toBe(false);
    expect(live.blocks.join(' ')).toMatch(/네이버 GFA \(수면밀도\) 잔액/);
    expect(live.blocks.join(' ')).toMatch(/카카오 전환 추적 단절/);
    const pre = executionCheck(DEMO, [], INCIDENTS, chg({ targetId: 'flow:promo:promo_3:budget', before: 10_000_000, after: 11_000_000, changePct: 10, approver: 'AE' }));
    expect(pre.ok).toBe(true);
    expect(pre.warnings.join(' ')).toMatch(/오픈 전 정상화 확인/);
  });

  it('신규 캠페인(비GFA) · 자동 조정 보류 해제 요청도 점검', () => {
    const meta = executionCheck(DEMO, [], INCIDENTS, chg({ kind: 'setting', targetId: 'flow:new:meta:Meta_11월', before: '—', after: 1_000_000, changePct: undefined, approver: 'CLIENT' }));
    expect(meta.blocks.join(' ')).toMatch(/Meta 데이터 급변/);
    const tb = INCIDENTS.find((i) => i.ruleId === 'tracking_break')!;
    const release = chg({ module: 'alert', kind: 'setting', targetId: `alert:${tb.id}:release`, before: '보류', after: '재개', changePct: undefined });
    expect(executionCheck(DEMO, [], INCIDENTS, release).warnings.join(' ')).toMatch(/카카오 전환 추적 단절 의심 패턴이 데이터에서 계속 관측/);
  });

  it('카카오 증액은 전환 추적 단절로 보류, 감액은 주의만', () => {
    const cmp = cmpByName(DEMO, '카카오_프로모션');
    const up = chg({ targetId: `flow:budget:${cmp.id}`, before: cmp.dailyBudget, after: cmp.dailyBudget * 1.15, changePct: 15 });
    const ex = executionCheck(DEMO, [], [], up);
    expect(ex.ok).toBe(false);
    expect(ex.blocks.join(' ')).toMatch(/전환 추적 단절/);
    const down = chg({ targetId: `flow:budget:${cmp.id}`, before: cmp.dailyBudget, after: cmp.dailyBudget * 0.9, changePct: -10 });
    const ex2 = executionCheck(DEMO, [], [], down);
    expect(ex2.ok).toBe(true);
    expect(ex2.warnings.join(' ')).toMatch(/감액 · 중지는 실행 가능/);
  });

  it('입찰: 일 조정 폭 상한 20% · 최대 입찰가 초과 차단', () => {
    const k = kwByText(DEMO, '신혼 매트리스');
    expect(executionCheck(DEMO, [], [], chg({ module: 'adpilot', kind: 'bid', targetId: k.id, before: k.bid, after: Math.round(k.bid * 1.25), changePct: 25 })).blocks.join(' ')).toMatch(new RegExp(`${AD_PILOT.dailyChangeCapPct}%`));
    expect(executionCheck(DEMO, [], [], chg({ module: 'adpilot', kind: 'bid', targetId: k.id, before: k.bid, after: k.maxBid + 10, changePct: 10 })).blocks.join(' ')).toMatch(/최대 입찰가/);
    const ok = executionCheck(DEMO, [], [], chg({ module: 'adpilot', kind: 'bid', targetId: k.id, before: k.bid, after: k.bid + 50, changePct: 6 }));
    expect(ok.ok).toBe(true);
  });

  it('예산 30% 초과인데 승인 주체가 수면밀도가 아니면 차단, 승인 전 건은 반영 불가', () => {
    const cmp = cmpByName(DEMO, 'Google_검색');
    expect(executionCheck(DEMO, [], [], chg({ targetId: `flow:budget:${cmp.id}`, changePct: 35, approver: 'PM' })).blocks.join(' ')).toMatch(/30% 초과/);
    expect(executionCheck(DEMO, [], [], chg({ targetId: `flow:budget:${cmp.id}`, changePct: 35, approver: 'CLIENT' })).ok).toBe(true);
    expect(executionCheck(DEMO, [], [], chg({ status: 'pending' })).ok).toBe(false);
  });
});

/* ================================================================== */
describe('목록 · 요약 · 일괄 처리', () => {
  it('flowSummary · myQueue (시드 이력 기준, PM)', () => {
    const s = flowSummary(SEEDS, 'PM', NOW, toMs, DEMO.today);
    expect(s.total).toBe(SEEDS.length);
    expect(STATUS_ORDER.reduce((a, k) => a + s.byStatus[k], 0)).toBe(SEEDS.length);
    const q = myQueue(SEEDS, 'PM');
    expect(q.blocked.every((c) => c.approver === 'CLIENT')).toBe(true);
    expect(q.approve.every((c) => c.status === 'pending' && c.approver !== 'CLIENT')).toBe(true);
    expect(q.total).toBe(q.approve.length + q.apply.length + q.held.length);
    expect(myQueue(SEEDS, '수면밀도').blocked).toHaveLength(0);
    expect(Number.isFinite(s.avgDecisionMin)).toBe(true);
    expect(s.metRate).toBeGreaterThanOrEqual(0);
    expect(s.metRate).toBeLessThanOrEqual(1);
  });

  it('빈 이력: 0 나누기 없이 NaN · 0', () => {
    const s = flowSummary([], 'PM', NOW, toMs, DEMO.today);
    expect(s.total).toBe(0);
    expect(Number.isNaN(s.avgDecisionMin)).toBe(true);
    expect(Number.isNaN(s.metRate)).toBe(true);
    expect(s.queue.total).toBe(0);
    expect(filterChanges([], { scope: 'mine' }, 'PM')).toEqual([]);
  });

  it('필터: 내 차례 · 시연 이력 · 검색 · 승인 주체', () => {
    const live = chg({ status: 'pending', approver: 'AE', target: '라이브 요청' });
    const all = [...SEEDS, live];
    expect(filterChanges(all, { scope: 'seed' }, 'PM').length).toBe(SEEDS.length);
    expect(filterChanges(all, { scope: 'live' }, 'PM')).toEqual([live]);
    expect(filterChanges(all, { scope: 'mine' }, '담당 AE').every((c) => c.approver === 'AE')).toBe(true);
    expect(filterChanges(all, { q: '라이브' }, 'PM')).toEqual([live]);
    expect(filterChanges(all, { approver: 'CLIENT' }, 'PM').every((c) => c.approver === 'CLIENT')).toBe(true);
  });

  it('일괄 처리 가드: AD Pilot 공식 기준과 같은 건수 (경고 5 · 차단 15) · 상한 초과 입찰 차단', () => {
    const cfg = adpilotConfigOf([]);
    expect(cfg.bulkWarnCount).toBe(officialConfig([]).bulkWarnCount);
    expect(bulkGuard([], 'approve').ok).toBe(false);
    const many = Array.from({ length: cfg.bulkBlockCount }, () => chg({ status: 'pending', kind: 'setting', changePct: undefined }));
    expect(bulkGuard(many, 'approve').level).toBe('block');
    expect(bulkGuard(many.slice(0, cfg.bulkBlockCount - 1), 'approve').level).toBe('warn');
    expect(bulkGuard([chg({ kind: 'bid', changePct: AD_PILOT.dailyChangeCapPct + 5 })], 'apply').level).toBe('block');
    expect(bulkGuard(many.slice(0, cfg.bulkWarnCount), 'approve').level).toBe('warn');
    expect(bulkGuard(many.slice(0, 2), 'approve').level).toBe('ok');
    expect(bulkGuard([chg({ kind: 'budget', changePct: 15 })], 'approve').level).toBe('warn');
    // 승인된 AD Pilot 설정 변경이 있으면 그 기준을 따른다
    expect(bulkGuard(many.slice(0, 3), 'approve', { ...cfg, bulkWarnCount: 2, bulkBlockCount: 3 }).level).toBe('block');
  });

  it('대량 변경 실수 감지: MILDO Alert detectBulkChange와 같은 결과 · 같은 이슈 id', () => {
    expect(bulkChangeAlerts([], DEMO.today)).toEqual([]);
    expect(bulkChangeAlerts(SEEDS, DEMO.today)).toEqual([]); // 시연 이력은 대량 변경이 아님
    const burst = Array.from({ length: 10 }, (_, k) => chg({ module: 'adpilot', kind: 'bid', requestedBy: 'AD Pilot', status: 'pending', changePct: 5, createdAt: `2026-10-31T14:${String(k).padStart(2, '0')}:00+09:00`, target: `키워드 ${k}` }));
    const found = bulkChangeAlerts(burst, DEMO.today);
    expect(found.length).toBe(1);
    expect(found[0].related).toHaveLength(10);
    expect(found[0].id).toBe(detectBulkChange(burst, { today: DEMO.today })[0].id);
    expect(found[0].basis).toMatch(/기준 ≥ 10건/);
    expect(found[0].logged).toBe(false);
    expect(bulkChangeAlerts(burst, DEMO.today, [{ ...INCIDENTS[0], id: found[0].id }])[0].logged).toBe(true);
    // 입찰 상한 초과 반영 · 30% 초과 예산의 수면밀도 승인 누락
    const over = chg({ module: 'adpilot', kind: 'bid', target: '과다 입찰', changePct: 35, status: 'applied', approver: 'PM' });
    const route = chg({ module: 'gfa', kind: 'budget', target: '라우팅 누락', changePct: 40, status: 'approved', approver: 'PM' });
    const titles = bulkChangeAlerts([over, route], DEMO.today).map((b) => b.title).join(' ');
    expect(titles).toMatch(/과다 입찰/);
    expect(titles).toMatch(/라우팅 누락/);
    assertCleanBrief(pendingBrief(DEMO, [...SEEDS, ...burst], INCIDENTS, 'PM', NOW, toMs));
    expect(pendingBrief(DEMO, [...SEEDS, ...burst], INCIDENTS, 'PM', NOW, toMs).facts.join(' ')).toMatch(/대량 변경 실수 감지 1건/);
  });
});

/* ================================================================== */
describe('신규 요청 폼 → 승인 주체 · 검증', () => {
  it('사유 8자 미만 · 대상 미선택 · 변경 폭 0은 제출 불가', () => {
    const p = planRequest(DEMO, [], [], draft({ reason: '짧음', targetId: '', pct: 0 }), 'PM');
    expect(p.ok).toBe(false);
    expect(p.errors.join(' ')).toMatch(/8자/);
    expect(p.errors.join(' ')).toMatch(/캠페인을 선택/);
    expect(p.errors.join(' ')).toMatch(/변경 폭/);
    expect(p.input).toBeNull();
  });

  it('SA 예산 +20% → PM · AD Pilot 예산 targetId · 증액 후 마감 시각 미리보기', () => {
    const cmp = cmpByName(DEMO, 'SA_일반 제품');
    const p = planRequest(DEMO, [], [], draft({ type: 'budget', media: 'naver_sa', targetId: cmp.id, pct: 20 }), 'PM');
    expect(p.ok).toBe(true);
    expect(p.route.approver).toBe('PM');
    expect(p.input?.module).toBe('adpilot');
    expect(p.input?.targetId).toBe(`budget:${cmp.id}:`);
    expect(p.after).toBe(Math.round((cmp.dailyBudget * 1.2) / 10_000) * 10_000);
    expect(p.warnings.join(' ')).toMatch(/증액 후 예상/);
  });

  it('GFA 증액 요청은 승인되어도 실행 보류 예상 경고', () => {
    const cmp = cmpByName(DEMO, 'GFA_Prospecting');
    const p = planRequest(DEMO, [], INCIDENTS, draft({ type: 'budget', media: 'naver_gfa', targetId: cmp.id, pct: 35 }), 'PM');
    expect(p.route.approver).toBe('CLIENT');
    expect(p.input?.module).toBe('gfa');
    expect(p.warnings.join(' ')).toMatch(/실행 보류 예상/);
  });

  it('입찰 상한 · 최대 입찰가 · 브랜드 키워드 별도 기준', () => {
    const k = kwByText(DEMO, '신혼 매트리스');
    expect(planRequest(DEMO, [], [], draft({ type: 'bid', targetId: k.id, pct: 25 }), 'PM').errors.join(' ')).toMatch(/상한/);
    const brand = kwByText(DEMO, '수면밀도');
    const p = planRequest(DEMO, [], [], draft({ type: 'bid', targetId: brand.id, pct: 10 }), 'PM');
    expect(p.ok).toBe(true);
    expect(p.warnings.join(' ')).toMatch(String(AD_PILOT.brandTargetRoas));
  });

  it('소재 문구 검수: 의료 효능 암시는 차단, 브랜드 키워드 제외는 불가', () => {
    const p = planRequest(DEMO, [], [], draft({ type: 'creative', targetText: 'GFA 가격형', afterText: '허리 통증 완화 매트리스' }), 'PM');
    expect(p.ok).toBe(false);
    expect(p.errors.join(' ')).toMatch(/의료 효능/);
    const ex = planRequest(DEMO, [], [], draft({ type: 'keyword', keywordMode: 'exclude', targetText: '수면밀도' }), 'PM');
    expect(ex.ok).toBe(false);
  });

  it('신규 GFA 캠페인 → kind gfa · 수면밀도 승인, 같은 대상 진행 중이면 경고', () => {
    const p = planRequest(DEMO, [], [], draft({ type: 'new_campaign', media: 'naver_gfa', targetText: 'GFA_11월 기획전', afterText: '1,000,000' }), 'PM');
    expect(p.ok).toBe(true);
    expect(p.input?.kind).toBe('gfa');
    expect(p.input?.approver).toBe('CLIENT');
    const dup = chg({ status: 'pending', targetId: p.input!.targetId });
    expect(planRequest(DEMO, [dup], [], draft({ type: 'new_campaign', media: 'naver_gfa', targetText: 'GFA_11월 기획전', afterText: '1000000' }), 'PM').warnings.join(' ')).toMatch(/진행 중/);
    expect(planRequest(DEMO, [], [], draft({ type: 'new_campaign', media: 'naver_gfa', targetText: 'X', afterText: 'abc' }), 'PM').ok).toBe(false);
  });
});

/* ================================================================== */
describe('문구 · 가격 대조', () => {
  it('숫자 변환 · 가격 · 할인율 파싱', () => {
    expect(toNum('1,234원')).toBe(1234);
    expect(toNum(' 990000 ')).toBe(990000);
    expect(Number.isNaN(toNum('abc'))).toBe(true);
    expect(Number.isNaN(toNum(NaN))).toBe(true);
    expect(parseCopyPrices('퀸 841,500원 · 79만원대')).toEqual([{ text: '841,500원', min: 841500, max: 841501 }, { text: '79만원대', min: 790000, max: 800000 }]);
    expect(parseCopyRates('최대 20% 할인').map((r) => r.rate)).toEqual([20]);
    expect(promoPrice(990_000, 15)).toBe(841_500);
  });

  it('검수 규칙: 의료 효능 차단 · 최상급 주의 · 가격 확인', () => {
    expect(reviewCopy('척추 교정 매트리스').some((r) => r.level === 'block')).toBe(true);
    expect(reviewCopy('국내 1위 매트리스').some((r) => r.id === 'superlative')).toBe(true);
    expect(reviewCopy('퀸 841,500원').some((r) => r.level === 'check')).toBe(true);
    expect(reviewCopy('')).toEqual([]);
  });

  it('소재 문구 ↔ 할인율 · 판매가 · 재고', () => {
    const p = DEMO.promotions.find((x) => x.id === 'promo_1')!;
    expect(copyIssues(DEMO, p, '퀸 841,500원 · 기획전 15%')).toEqual([]);
    expect(copyIssues(DEMO, p, '퀸 850,000원').some((i) => /가격 표기/.test(i.text))).toBe(true);
    expect(copyIssues(DEMO, p, '기획전 20% 할인').some((i) => /할인율/.test(i.text))).toBe(true);
    expect(copyIssues(DEMO, p, '킹 1,011,500원').some((i) => /품절/.test(i.text))).toBe(true);
  });
});

/* ================================================================== */
describe('데모 시나리오 탐지 (데이터 기반)', () => {
  it('오늘 14~15시 Meta 광고비 급변 (동요일 · 동시간 대비 +50% 이상)', () => {
    const g = dataGuards(DEMO).find((x) => x.media === 'meta' && x.kind === 'spend_spike');
    expect(g).toBeTruthy();
    const pct = (g!.observed / g!.baseline - 1) * 100;
    expect(pct).toBeGreaterThanOrEqual(50);
    expect(pct).toBeLessThan(100);
    // 주입을 되돌리면 탐지되지 않아야 한다
    const d = clone(DEMO);
    for (const r of d.mediaHourly) if (r.date === d.today && r.media === 'meta' && r.hour >= 14) r.cost = Math.round(r.cost / 1.68);
    expect(dataGuards(d).some((x) => x.media === 'meta' && x.kind === 'spend_spike')).toBe(false);
  });

  it('오늘 13시 이후 카카오 전환 0 (클릭 정상) → 전환 추적 단절', () => {
    const g = dataGuards(DEMO).find((x) => x.media === 'kakao' && x.kind === 'tracking_break');
    expect(g).toBeTruthy();
    expect(g!.basis).toMatch(/13~15시/);
    expect(g!.baseline).toBeGreaterThan(0);
    const d = clone(DEMO);
    for (const r of d.mediaHourly) if (r.date === d.today && r.media === 'kakao' && r.hour === d.currentHour) r.conversions = 1;
    expect(dataGuards(d).some((x) => x.media === 'kakao' && x.kind === 'tracking_break')).toBe(false);
  });

  it('SA_일반 제품 · Meta_넓은 타겟 → 매출 피크 전 조기 소진', () => {
    const early = DEMO.campaigns.map((c) => paceCampaign(DEMO, c)).filter((x) => x.level === 'before_peak').map((x) => x.campaign.name);
    expect(early).toContain('SA_일반 제품');
    expect(early).toContain('Meta_넓은 타겟');
    const sa = paceCampaign(DEMO, cmpByName(DEMO, 'SA_일반 제품'));
    expect(sa.exhaustHour!).toBeLessThan(sa.peakHour);
    // 예산을 넉넉히 늘리면 일 예산 내 소진
    expect(paceCampaign(DEMO, cmpByName(DEMO, 'SA_일반 제품'), [], sa.budget * 2).level).toBe('ok');
    // 예산 0 · OFF는 판정하지 않음
    expect(paceCampaign(DEMO, { ...cmpByName(DEMO, 'SA_일반 제품'), dailyBudget: 0 }).level).toBe('off');
  });

  it('진행 중 기획전 점검: 킹 품절 랜딩 · GFA 잔액 · 조기 소진 실패, 표기가는 판매가 × (1 − 할인율)과 일치', () => {
    const p = DEMO.promotions.find((x) => x.id === 'promo_1')!;
    const c = checkPromotion(DEMO, p, { changes: [], incidents: INCIDENTS });
    expect(c.phase).toBe('live');
    const fail = c.items.filter((i) => i.level === 'fail');
    const kw = kwByText(DEMO, '킹 매트리스');
    const sold = fail.find((i) => i.id === `landing_soldout_${kw.id}`);
    expect(sold?.fix?.input.approver).toBe('PM');
    expect(sold?.fix?.input.after).toBe('off');
    const gfa = fail.find((i) => i.id === 'balance_acc_gfa');
    expect(gfa?.detail).toMatch(/1일치 미만/);
    expect(gfa?.fix?.input.approver).toBe('CLIENT');
    expect(fail.some((i) => i.group === '예산' && i.label.startsWith('SA_일반 제품'))).toBe(true);
    expect(c.items.find((i) => i.id === 'price_copy')?.level).toBe('pass');
    expect(c.verdict.label).toBe('즉시 조치');
    expect(c.verdict.basis).toMatch(/실패 \d+/);
  });

  it('데이터가 바뀌면 점검 결과도 바뀐다 (표기가 · 재고 · 잔액)', () => {
    const d = clone(DEMO);
    const p = d.promotions.find((x) => x.id === 'promo_1')!;
    p.adCopyPrice = 850_000;
    d.products[0].options.find((o) => o.id === 'k')!.inStock = true;
    const g = d.accounts.find((a) => a.id === 'acc_gfa')!;
    g.balance = 20_000_000;
    g.autoCharge = 'ok';
    const c = checkPromotion(d, p, {});
    expect(c.items.find((i) => i.id === 'price_copy')?.level).toBe('fail');
    expect(c.items.find((i) => i.id === 'price_copy')?.fix?.input.after).toBe('841,500원');
    expect(c.items.some((i) => i.id.startsWith('landing_soldout_') && i.level === 'fail')).toBe(false);
    expect(c.items.find((i) => i.id === 'stock_ok')?.level).toBe('pass');
    expect(c.items.find((i) => i.id === 'balance_acc_gfa')?.level).toBe('pass');
  });

  it('오늘의집 계정 검수 상태 · 오픈 전 기획전 문구(할인율 · 품절 옵션) 실패', () => {
    const all = checkAllPromotions(DEMO, { changes: [], incidents: INCIDENTS });
    const oh = all.find((c) => c.promotion.id === 'promo_2')!;
    expect(oh.items.find((i) => i.id === 'balance_acc_ohouse')?.level).toBe('fail');
    const pre = all.find((c) => c.promotion.id === 'promo_3')!;
    expect(pre.phase).toBe('pre');
    expect(pre.dday).toBe(daysBetween(DEMO.today, pre.promotion.start));
    expect(pre.verdict.label).toBe('오픈 보류');
    const crFails = pre.items.filter((i) => i.group === '소재' && i.level === 'fail').map((i) => i.detail).join(' ');
    expect(crFails).toMatch(/최대 20%/);
    expect(crFails).toMatch(/킹 옵션 품절/);
    expect(pre.items.find((i) => i.id === 'budget_plan')?.fix?.input.kind).toBe('budget');
  });

  it('조치 요청을 만들면 해당 항목에 진행 상태가 붙는다', () => {
    const p = DEMO.promotions.find((x) => x.id === 'promo_1')!;
    const base = checkPromotion(DEMO, p, {});
    const item = base.items.find((i) => i.fix && !i.fixState)!;
    const req = chg({ ...item.fix!.input, status: 'pending' });
    const after = checkPromotion(DEMO, p, { changes: [req] });
    expect(after.items.find((i) => i.id === item.id)?.fixState?.status).toBe('pending');
  });

  it('프로모션 없음 · 판매 데이터 없음에도 깨지지 않음', () => {
    expect(checkAllPromotions({ ...DEMO, promotions: [] })).toEqual([]);
    const d = { ...clone(DEMO), salesDaily: [] };
    const r = promoReport(d, d.promotions[0]);
    expect(Number.isNaN(r.rows.find((x) => x.key === 'chCvr')!.cur)).toBe(true);
    expect(r.markdown).not.toMatch(/NaN|undefined|Infinity/);
    expect(channelMix(d, 'brandstore', { from: d.today, to: d.today }, null).every((m) => Number.isNaN(m.curShare))).toBe(true);
    const zeroSpend = clone(DEMO);
    zeroSpend.accounts.find((a) => a.id === 'acc_kakao')!.avgDailySpend = 0;
    const c = checkPromotion(zeroSpend, zeroSpend.promotions[0], {});
    expect(c.items.map((i) => i.detail).join(' ')).not.toMatch(/Infinity|NaN/);
  });
});

/* ================================================================== */
describe('프로모션 리포트 (기간 vs 직전 동일 기간)', () => {
  const p1 = DEMO.promotions.find((x) => x.id === 'promo_1')!;
  const r = promoReport(DEMO, p1, { changes: SEEDS, incidents: INCIDENTS });

  it('진행 중 프로모션은 어제까지 완료된 날짜만, 직전 동기간은 같은 일수', () => {
    expect(r.ready).toBe(true);
    expect(r.period).toEqual({ from: '2026-10-20', to: '2026-10-30', days: 11 });
    expect(r.prev).toEqual({ from: '2026-10-09', to: '2026-10-19', days: 11 });
    const manual = DEMO.salesDaily.filter((x) => x.channel === 'brandstore' && x.date >= '2026-10-20' && x.date <= '2026-10-30').reduce((a, x) => a + x.revenue, 0);
    expect(r.rows.find((x) => x.key === 'chRevenue')!.cur).toBe(manual);
    expect(r.daily).toHaveLength(11);
  });

  it('판매 채널 비중 합 = 1, 기획전 채널 표시', () => {
    const cur = r.mix.reduce((a, m) => a + m.curShare, 0);
    const prev = r.mix.reduce((a, m) => a + m.prevShare, 0);
    expect(cur).toBeCloseTo(1, 6);
    expect(prev).toBeCloseTo(1, 6);
    expect(r.mix.filter((m) => m.isPromo).map((m) => m.channel)).toEqual(['brandstore']);
  });

  it('마크다운: 세 영역 구분 · 다음 기획 반영 · 데이터 이상 매체 반례', () => {
    for (const h of ['### 확정 팩트', '### 반복 관측 패턴', '### AI 해석', '### 전제 조건 · 기준값', '### 반례 · 대체 시나리오', '### 다음 액션']) expect(r.markdown).toContain(h);
    expect(r.markdown).toContain('TEST DATA');
    expect(r.markdown).toContain('판매 채널 비중');
    expect(r.markdown).not.toMatch(/NaN|undefined|Infinity/);
    expect(r.next.length).toBeGreaterThan(0);
    expect(r.brief.counter.join(' ')).toMatch(/카카오/); // 브랜드스토어 유입 매체 카카오의 전환 추적 단절
    assertCleanBrief(r.brief);
  });

  it('다음 기획 반영 항목 → 수면밀도 승인 요청 (예산 · 구조 변경, 당일)', () => {
    const input = promoNextInput(r)!;
    expect(input.approver).toBe('CLIENT');
    expect(input.targetId).toBe(`flow:promo:${p1.id}:next`);
    expect(decisionIndexOf({ kind: input.kind, approver: input.approver, targetId: input.targetId, target: input.target })).toBe(1);
    expect(input.after).toBe(`반영 항목 ${r.next.length}건`);
    expect(promoNextInput({ ...r, next: [] })).toBeNull();
    expect(promoNextInput({ ...r, next: ['이번 기간 점검에서 다음 기획에 반영할 이상 항목이 없습니다. 같은 구성으로 재집행 시 직전 동기간 비교를 유지합니다.'] })).toBeNull();
  });

  it('오픈 전 프로모션은 성과 없이 기준선만', () => {
    const p3 = DEMO.promotions.find((x) => x.id === 'promo_3')!;
    expect(promoPhase(p3, DEMO.today)).toBe('pre');
    const r3 = promoReport(DEMO, p3);
    expect(r3.ready).toBe(false);
    expect(r3.period).toBeNull();
    expect(r3.prev?.days).toBe(10);
    expect(r3.markdown).toContain('오픈 예정');
    expect(r3.markdown).not.toMatch(/NaN|undefined|Infinity/);
  });
});

/* ================================================================== */
describe('운영 타임라인: 감지 → 배정 → 조치 → 보고', () => {
  it('Alert 이슈가 단계별로 놓이고, 같은 대상 · 매체의 변경 요청이 연결된다', () => {
    const cases = opsCases(DEMO, INCIDENTS, SEEDS, toMs);
    expect(cases.length).toBe(INCIDENTS.length);
    const gfa = cases.find((c) => c.incident.ruleId === 'account_payment' && c.incident.media === 'naver_gfa')!;
    expect(gfa.current).toBe('assign');
    expect(gfa.linked.some((l) => l.change.targetId === topupTargetId(acc(DEMO, 'acc_gfa')))).toBe(true);
    const kakao = cases.find((c) => c.incident.ruleId === 'tracking_break')!;
    expect(kakao.linked.some((l) => l.change.target.startsWith('카카오'))).toBe(true);
    const sc = stageCounts(cases);
    expect(sc.detect + sc.assign + sc.action + sc.report + sc.done).toBe(cases.length);
    expect(cases[0].incident.severity).toBe('P1');
  });

  it('인지 → 1차 조치 → 결과 보고 패치', () => {
    const i = INCIDENTS.find((x) => x.ruleId === 'tracking_break')!;
    const ack = incidentStagePatch(i, 'ack', '2026-10-31T15:35:00+09:00', 'PM');
    expect(ack.patch.status).toBe('ack');
    const i2 = { ...i, ...ack.patch, timeline: [...i.timeline, { at: '2026-10-31T15:35:00+09:00', by: 'PM', action: ack.log }] } as Incident;
    const c2 = opsCases(DEMO, [i2], [], toMs)[0];
    expect(c2.stages.find((s) => s.stage === 'assign')?.done).toBe(true);
    expect(c2.next?.id).toBe('action');
    const act = incidentStagePatch(i2, 'action', '2026-10-31T15:50:00+09:00', 'PM', '자동 조정 보류 유지 · 픽셀 점검 요청');
    const i3 = { ...i2, ...act.patch } as Incident;
    expect(opsCases(DEMO, [i3], [], toMs)[0].current).toBe('report');
    const rep = incidentStagePatch(i3, 'report', '2026-10-31T16:20:00+09:00', 'PM');
    expect(opsCases(DEMO, [{ ...i3, ...rep.patch } as Incident], [], toMs)[0].current).toBe('done');
  });

  it('이슈 → 조치 요청 (충전 수면밀도 · 품절 키워드 중지 PM · 조기 소진 예산)', () => {
    const gfaInc = INCIDENTS.find((x) => x.ruleId === 'account_payment' && x.media === 'naver_gfa')!;
    const f1 = incidentFix(DEMO, gfaInc)!;
    expect(f1.input.approver).toBe('CLIENT');
    expect(f1.input.targetId).toBe(topupTargetId(acc(DEMO, 'acc_gfa')));
    const sold = INCIDENTS.find((x) => x.ruleId === 'soldout_landing')!;
    const f2 = incidentFix(DEMO, sold)!;
    expect(f2.input.kind).toBe('status');
    expect(f2.input.approver).toBe('PM');
    const pace = INCIDENTS.find((x) => x.ruleId === 'budget_forecast' && x.target === 'SA_일반 제품')!;
    const f3 = incidentFix(DEMO, pace)!;
    expect(f3.input.kind).toBe('budget');
    // 요청이 이미 있으면 상태를 돌려준다
    expect(incidentFix(DEMO, gfaInc, [chg({ ...f1.input, status: 'pending' })])?.state?.status).toBe('pending');
  });

  it('활동 피드는 최신순 · 잘못된 시각은 제외', () => {
    const ev = opsEvents(INCIDENTS, [...SEEDS, chg({ createdAt: 'x', history: [{ at: 'bad', by: 'PM', action: '요청 생성' }] })], toMs);
    for (let k = 1; k < ev.length; k++) expect(ev[k - 1].atMs).toBeGreaterThanOrEqual(ev[k].atMs);
    expect(ev.every((e) => Number.isFinite(e.atMs))).toBe(true);
    expect(linkedChanges(DEMO, INCIDENTS[0], [], toMs)).toEqual([]);
  });
});

/* ================================================================== */
describe('시연용 시드 이력 (데이터에서 계산)', () => {
  it('결정적 · 접두사 · 6개 상태 모두 포함 · 첫 이력은 요청 생성', () => {
    expect(seedChanges(DEMO).map((c) => c.id)).toEqual(SEEDS.map((c) => c.id));
    expect(SEEDS.every((c) => c.id.startsWith(SEED_PREFIX))).toBe(true);
    expect(new Set(SEEDS.map((c) => c.status))).toEqual(new Set(STATUS_ORDER));
    for (const c of SEEDS) {
      expect(c.history[0].action).toBe('요청 생성');
      expect(c.createdAt <= DEMO.generatedAt).toBe(true);
    }
  });

  it('시나리오에서 고른 대상: 고효율 · 노출 손실 키워드, CPC 급등 키워드 롤백, GFA 충전, 조기 소진 예산', () => {
    const star = SEEDS.find((c) => c.id === `${SEED_PREFIX}1`)!;
    const k = DEMO.keywords.find((x) => star.target.startsWith(x.text))!;
    expect(k.isBrand).toBe(false);
    expect(k.impressionShareLost).toBeGreaterThanOrEqual(AD_PILOT.lostShareTrigger);
    const rb = SEEDS.find((c) => c.status === 'rolled_back')!;
    expect(rb.target).toContain('매트리스 추천');
    const top = SEEDS.find((c) => c.targetId === topupTargetId(acc(DEMO, 'acc_gfa')))!;
    expect(top.approver).toBe('CLIENT');
    expect(top.status).toBe('pending');
    const sa = SEEDS.find((c) => c.id === `${SEED_PREFIX}7`)!;
    const cmp = DEMO.campaigns.find((x) => sa.target.startsWith(x.name))!;
    expect(paceCampaign(DEMO, cmp).level).toBe('before_peak');
    const held = SEEDS.find((c) => c.status === 'held')!;
    expect(held.history.at(-1)?.note).toMatch(/전환 추적 단절/);
  });

  it('시드 이력도 같은 규칙: 승인 주체 = 위임 범위, 결정한 역할은 승인 범위 안', () => {
    for (const c of SEEDS) {
      if ((c.kind === 'bid' || c.kind === 'budget') && Number.isFinite(c.changePct ?? NaN)) {
        expect(c.approver, c.target).toBe(GFA_DELEGATION[delegationIndexByPct(c.changePct!)].approver);
      }
      for (const h of c.history) {
        if (!['담당 AE', 'PM', '수면밀도'].includes(h.by)) continue;
        if (!/승인|반려|반영|롤백/.test(h.action)) continue;
        expect(canAct(h.by, c.approver).ok, `${c.target} · ${h.by} ${h.action}`).toBe(true);
      }
    }
  });

  it('시드 이력은 다른 모듈의 실제 값을 바꾸지 않는다 (반영 건은 seed: 대상)', () => {
    for (const k of DEMO.keywords) expect(effectiveBid(k, SEEDS)).toBe(k.bid);
    expect(seedChanges({ ...DEMO, keywords: [], campaigns: [] })).toEqual([]);
  });
});

/* ================================================================== */
describe('시계 · 반복 구간 · 브리프', () => {
  it('스토어 실제 시각(…Z)은 데이터 기준 시각 + 세션 경과로 환산', () => {
    const anchor = Date.parse('2026-11-01T01:00:00.000Z');
    const g = DEMO.generatedAt;
    expect(toRefMs('2026-11-01T01:10:00.000Z', g, anchor)).toBe(Date.parse(g) + 10 * 60_000);
    expect(toRefMs('2026-10-31T14:00:00+09:00', g, anchor)).toBe(Date.parse('2026-10-31T14:00:00+09:00'));
    expect(Number.isNaN(toRefMs(undefined, g, anchor))).toBe(true);
    expect(refNowMs(g, anchor, anchor - 5000)).toBe(Date.parse(g));
  });

  it('반복 구간 5개 (p.31) + 이번 세션 실측', () => {
    const s = flowSummary(SEEDS, 'PM', NOW, toMs, DEMO.today);
    const rows = segmentRows({ summary: s, checks: checkAllPromotions(DEMO), reportsReady: 2, comments: 0 });
    expect(rows.map((r) => r.seg)).toEqual(FLOW_SEGMENTS.map((f) => f.seg));
    expect(rows.find((r) => r.seg === '프로모션 준비')?.live.value).toMatch(/실패 \d+건/);
  });

  it('규칙 기반 브리프: 번호 매기기 · NaN 없음 (빈 이력 포함)', () => {
    assertCleanBrief(pendingBrief(DEMO, SEEDS, INCIDENTS, 'PM', NOW, toMs));
    assertCleanBrief(pendingBrief(DEMO, [], [], '담당 AE', NOW, toMs));
    assertCleanBrief(promoCheckBrief(DEMO, SEEDS, INCIDENTS));
    assertCleanBrief(opsBrief(DEMO, INCIDENTS, SEEDS, toMs));
    const b = pendingBrief(DEMO, SEEDS, INCIDENTS, 'PM', NOW, toMs);
    expect(b.facts.join(' ')).toMatch(/TEST DATA/);
    // 승인된 GFA 증액이 반영 대기에 있으면 잔액 부족으로 보류된다고 해석해야 한다
    const gfaCmp = cmpByName(DEMO, 'GFA_Prospecting');
    const approved = chg({ module: 'gfa', kind: 'budget', targetId: `gfa:budget:${gfaCmp.id}`, before: gfaCmp.dailyBudget, after: gfaCmp.dailyBudget * 1.1, status: 'approved', approver: 'PM' });
    const b2 = pendingBrief(DEMO, [...SEEDS, approved], INCIDENTS, 'PM', NOW, toMs);
    expect(b2.interpretation.join(' ')).toMatch(/실행 점검에서 보류/);
    assertCleanBrief(b2);
  });
});

/* ================================================================== */
describe('교차 모듈 정합성 · 경계 사례', () => {
  it('보류는 결정이 아니다 — 대기 시간이 계속 흐르고 기준 초과로 잡힌다 (p.53)', () => {
    const held = chg({
      approver: 'AE', kind: 'bid', status: 'held', createdAt: '2026-10-31T13:00:00+09:00',
      history: [{ at: '2026-10-31T13:00:00+09:00', by: 'AE', action: '요청 생성' }, { at: '2026-10-31T13:05:00+09:00', by: '담당 AE', action: '보류', note: '근거 확인' }],
    });
    const l = leadState(held, NOW, toMs);
    expect(l.decidedMs).toBeNull();
    expect(l.overdue).toBe(true);
    expect(flowSummary([held], 'PM', NOW, toMs, DEMO.today).decided).toBe(0);
  });

  it('PM 승인 예산 건은 p.15 위임으로 PM이 결정한다는 근거를 함께 보여준다', () => {
    expect(decisionOf({ kind: 'budget', approver: 'PM', targetId: '', target: '' }).delegated).toMatch(/p\.15 위임 범위/);
    expect(decisionOf({ kind: 'budget', approver: 'CLIENT', targetId: '', target: '' }).delegated).toBeNull();
    expect(decisionOf({ kind: 'bid', approver: 'AE', targetId: '', target: '' }).delegated).toBeNull();
  });

  it('MILDO Alert 키워드 일시 중지 반영 → 품절 랜딩 점검 통과 · 중복 중지 요청 없음', () => {
    const kw = kwByText(DEMO, '킹 매트리스');
    const sold = INCIDENTS.find((x) => x.ruleId === 'soldout_landing')!;
    const pause = chg({ module: 'alert', kind: 'status', target: `${kw.text} 키워드`, targetId: `alert:${sold.id}:pause`, before: 'on', after: 'off', status: 'applied', approver: 'AE' });
    expect(effectiveKeywordStatus(kw, [pause])).toBe('off');
    expect(effectiveKeywordStatus(kw, [{ ...pause, status: 'rolled_back' }])).toBe('on');
    const p1 = DEMO.promotions.find((x) => x.id === 'promo_1')!;
    const c = checkPromotion(DEMO, p1, { changes: [pause] });
    expect(c.items.some((i) => i.id === `landing_soldout_${kw.id}`)).toBe(false);
    // 아직 승인 대기인 Alert 중지 요청이 있으면 Flow는 새 요청 대신 그 상태를 보여준다
    expect(incidentFix(DEMO, sold, [{ ...pause, status: 'pending' }])?.state?.status).toBe('pending');
  });

  it('이슈 명시 연결은 이슈 id 경계로만 (접두사가 같은 다른 이슈와 섞이지 않음)', () => {
    const i = INCIDENTS[0];
    const exact = chg({ targetId: `alert:${i.id}:topup`, createdAt: '2026-10-01T00:00:00+09:00' });
    const other = chg({ targetId: `alert:${i.id}-x:topup`, createdAt: '2026-10-01T00:00:00+09:00', target: '무관 요청' });
    const links = linkedChanges(DEMO, i, [exact, other], toMs);
    expect(links.map((l) => l.change.id)).toEqual([exact.id]);
    expect(links[0].inferred).toBe(false);
  });

  it('감지 전에 반영된 추정 연결 변경은 조치 완료로 보지 않는다', () => {
    const meta = INCIDENTS.find((x) => x.ruleId === 'data_spike')!;
    const cmp = cmpByName(DEMO, 'Meta_넓은 타겟');
    const det = Date.parse(meta.detectedAt);
    const before = chg({ targetId: `flow:budget:${cmp.id}`, target: `${cmp.name} 일 예산`, status: 'applied', createdAt: new Date(det - 60 * 60_000).toISOString(), history: [{ at: new Date(det - 50 * 60_000).toISOString(), by: 'PM', action: '반영' }] });
    const c1 = opsCases(DEMO, [meta], [before], toMs)[0];
    expect(c1.linked.some((l) => l.inferred)).toBe(true);
    expect(c1.stages.find((s) => s.stage === 'action')?.done).toBe(false);
    const after = { ...before, id: 'after', createdAt: new Date(det + 10 * 60_000).toISOString(), history: [{ at: new Date(det + 20 * 60_000).toISOString(), by: 'PM', action: '반영' }] };
    expect(opsCases(DEMO, [meta], [after], toMs)[0].stages.find((s) => s.stage === 'action')?.done).toBe(true);
  });

  it('광고비 급변은 증감 양방향 (±50%) — 급감도 데이터 이상으로 본다 (p.44)', () => {
    const d = clone(DEMO);
    for (const r of d.mediaHourly) if (r.date === d.today && r.media === 'google' && r.hour >= d.currentHour - 1) r.cost = Math.round(r.cost * 0.3);
    const g = dataGuards(d).find((x) => x.media === 'google' && x.kind === 'spend_spike');
    expect(g).toBeTruthy();
    expect(g!.basis).toMatch(/-\d+%/);
    // 원본 데이터에서는 Meta만 잡힌다 (다른 매체 오탐 없음)
    expect(dataGuards(DEMO).filter((x) => x.kind === 'spend_spike').map((x) => x.media)).toEqual(['meta']);
    // 시간별 데이터가 없으면 가드 없음
    expect(dataGuards({ ...DEMO, mediaHourly: [] })).toEqual([]);
  });

  it('예상 마감 시각은 AD Pilot 곡선과 같다 (같은 28일 소진 곡선)', () => {
    const sa = paceCampaign(DEMO, cmpByName(DEMO, 'SA_일반 제품'));
    const meta = paceCampaign(DEMO, cmpByName(DEMO, 'Meta_넓은 타겟'));
    expect(fmtHour(sa.exhaustHour)).toBe('20:22');
    expect(meta.exhaustHour!).toBeLessThan(sa.exhaustHour!);
  });
});
