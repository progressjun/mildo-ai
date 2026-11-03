/** changes 순수 규칙: 상태 전이 · 권한 · 승인 주체 재판정 · 대상 해석 · 점검 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/core/types';
import { generateDemoData } from '@/data/demo';
import {
  actionOfLabel, approverFloor, canLowerApprover, checkActionPermission, checkEditPermission, effectivePct, historyLabel, noteEntryOf, resolveTransition,
  routeApprover, targetStatusOf,
} from './policy';
import { parseTarget } from './targets';
import { entityOf, evaluateGuards, opChange } from './executor';
import { decideBulk, windowOf, bulkIncidentsFor } from './bulk';

const mk = (o: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: 'c1', createdAt: '2026-11-02T00:00:00.000Z', module: 'adpilot', kind: 'bid', target: '수면밀도 입찰가', targetId: 'kw_1',
  before: 270, after: 280, changePct: 3.7, reason: '', requestedBy: 'a', approver: 'AE', status: 'pending', history: [], ...o,
});

describe('상태 전이 (Flow ACTIONS_BY_STATUS와 같은 표)', () => {
  it('허용 전이', () => {
    expect(resolveTransition(mk(), 'approved')).toMatchObject({ ok: true, action: 'approve' });
    expect(resolveTransition(mk(), 'rejected')).toMatchObject({ ok: true, action: 'reject' });
    expect(resolveTransition(mk(), 'held')).toMatchObject({ ok: true, action: 'hold' });
    expect(resolveTransition(mk({ status: 'approved' }), 'applied')).toMatchObject({ ok: true, action: 'apply' });
    expect(resolveTransition(mk({ status: 'approved' }), 'rejected')).toMatchObject({ ok: true, action: 'cancel' });
    expect(resolveTransition(mk({ status: 'held' }), 'pending')).toMatchObject({ ok: true, action: 'resume' });
    expect(resolveTransition(mk({ status: 'held' }), 'rejected')).toMatchObject({ ok: true, action: 'reject' });
    expect(resolveTransition(mk({ status: 'applied' }), 'rolled_back')).toMatchObject({ ok: true, action: 'rollback' });
  });
  it('불가능 전이 · 같은 상태 · 종료 상태', () => {
    expect(resolveTransition(mk(), 'applied')).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(resolveTransition(mk(), 'pending')).toMatchObject({ ok: false, code: 'same_status' });
    expect(resolveTransition(mk({ status: 'rejected' }), 'approved').reason).toMatch(/종료 상태/);
    expect(resolveTransition(mk({ status: 'rolled_back' }), 'applied').ok).toBe(false);
    expect(resolveTransition(mk({ status: 'applied' }), 'approved').ok).toBe(false);
  });
  it('보류 → 승인 · 재실행은 이전에 승인된 건만', () => {
    const heldBefore = mk({ status: 'held', history: [{ at: 'x', by: 'a', action: '요청 생성' }] });
    expect(resolveTransition(heldBefore, 'approved')).toMatchObject({ ok: false, code: 'not_approved_before' });
    expect(resolveTransition(heldBefore, 'applied')).toMatchObject({ ok: false, code: 'not_approved_before' });
    const heldAfter = mk({ status: 'held', history: [{ at: 'x', by: 'a', action: '일괄 승인' }, { at: 'y', by: 's', action: '실행 보류' }] });
    expect(resolveTransition(heldAfter, 'approved')).toMatchObject({ ok: true, action: 'resume' });
    expect(resolveTransition(heldAfter, 'applied')).toMatchObject({ ok: true, action: 'retry' });
  });
  it('액션 키 · 화면 문구 → 대상 상태 · 이력 문구', () => {
    expect(targetStatusOf(mk(), undefined, 'approve')).toBe('approved');
    expect(targetStatusOf(mk({ status: 'held' }), undefined, 'resume')).toBe('pending');
    expect(targetStatusOf(mk({ status: 'held', history: [{ at: 'x', by: 'a', action: '승인' }] }), undefined, '보류 해제')).toBe('approved');
    expect(targetStatusOf(mk(), 'rejected', '승인')).toBe('rejected');
    expect(targetStatusOf(mk(), undefined, '재실행 보류')).toBeNull();
    expect(actionOfLabel('실행 · 반영')).toBe('apply');
    expect(historyLabel('approve', '일괄 승인')).toBe('일괄 승인');
    expect(historyLabel('reject', '승인')).toBe('반려');
    expect(historyLabel('apply', '아무 문구')).toBe('반영');
    expect(historyLabel('reject', '실행 취소')).toBe('실행 취소');
    expect(historyLabel('hold', '반영 보류')).toBe('반영 보류');
  });
});

describe('권한 (멤버십 권한표 — 서버 최종 판정)', () => {
  it('승인 · 반려는 승인 등급 권한', () => {
    expect(checkActionPermission('ae', 'AE', 'approve').ok).toBe(true);
    expect(checkActionPermission('ae', 'PM', 'approve').ok).toBe(false);
    expect(checkActionPermission('pm', 'PM', 'reject').ok).toBe(true);
    expect(checkActionPermission('admin', 'CLIENT', 'approve').ok).toBe(false);
    expect(checkActionPermission('client', 'CLIENT', 'approve').ok).toBe(true);
    expect(checkActionPermission('owner', 'CLIENT', 'approve').ok).toBe(true);
    expect(checkActionPermission('viewer', 'AE', 'approve').ok).toBe(false);
  });
  it('반영 · 롤백은 승인 등급 + 운영 권한 (광고주 담당자는 반영 불가)', () => {
    expect(checkActionPermission('client', 'AE', 'apply')).toMatchObject({ ok: false });
    expect(checkActionPermission('client', 'CLIENT', 'rollback').reason).toMatch(/운영 권한/);
    expect(checkActionPermission('ae', 'AE', 'apply').ok).toBe(true);
    expect(checkActionPermission('ae', 'PM', 'apply').ok).toBe(false);
    expect(checkActionPermission('pm', 'CLIENT', 'apply').ok).toBe(false);
    expect(checkActionPermission('owner', 'CLIENT', 'apply').ok).toBe(true);
    expect(checkActionPermission('pm', 'PM', 'retry').ok).toBe(true);
  });
  it('보류 · 해제는 운영 권한만', () => {
    expect(checkActionPermission('ae', 'CLIENT', 'hold').ok).toBe(true);
    expect(checkActionPermission('client', 'AE', 'hold').ok).toBe(false);
    expect(checkActionPermission('pm', 'CLIENT', 'resume').ok).toBe(true);
  });
  it('내용 수정: 승인 대기 + 요청자 또는 PM 이상', () => {
    expect(checkEditPermission('ae', 'u1', { status: 'pending', requested_by_user: 'u1' }).ok).toBe(true);
    expect(checkEditPermission('ae', 'u2', { status: 'pending', requested_by_user: 'u1' }).ok).toBe(false);
    expect(checkEditPermission('pm', 'u2', { status: 'pending', requested_by_user: 'u1' }).ok).toBe(true);
    expect(checkEditPermission('client', 'u2', { status: 'pending', requested_by_user: 'u1' }).ok).toBe(false);
    expect(checkEditPermission('owner', 'u2', { status: 'approved', requested_by_user: 'u1' }).ok).toBe(false);
  });
});

describe('승인 주체 재판정 (p.15 위임 범위)', () => {
  it('예산 변경 폭: ±10% AE · ±30% PM · 초과 CLIENT, 낮추지 않음', () => {
    expect(routeApprover(mk({ kind: 'budget', before: 1000000, after: 1100000, changePct: 10, approver: 'AE' })).approver).toBe('AE');
    expect(routeApprover(mk({ kind: 'budget', before: 1000000, after: 1250000, changePct: 25, approver: 'AE' })).approver).toBe('PM');
    const r = routeApprover(mk({ kind: 'budget', before: 1000000, after: 1350000, changePct: 35, approver: 'PM' }));
    expect(r.approver).toBe('CLIENT');
    expect(r.notes.join(' ')).toMatch(/35%/);
    expect(routeApprover(mk({ kind: 'budget', before: 1000000, after: 1050000, changePct: 5, approver: 'PM' })).approver).toBe('PM');
  });
  it('클라이언트 변경 폭이 값과 다르면 큰 쪽 · 계산 불가는 CLIENT · 값만 있으면 계산값 저장', () => {
    const r = routeApprover(mk({ kind: 'budget', before: 100, after: 150, changePct: 5, approver: 'AE' }));
    expect(r.approver).toBe('CLIENT');
    expect(r.changePct).toBe(50);
    expect(routeApprover(mk({ kind: 'budget', before: '—', after: '—', changePct: undefined, approver: 'AE' })).approver).toBe('CLIENT');
    const v = routeApprover(mk({ kind: 'budget', before: 1000, after: 1080, changePct: undefined, approver: 'AE' }));
    expect(v).toMatchObject({ approver: 'AE', changePct: 8 });
    // GFA 만 원 단위 반올림 차이(1%p 이내)는 요청 폭 기준
    expect(routeApprover(mk({ kind: 'budget', before: 670000, after: 740000, changePct: 10, approver: 'AE' })).approver).toBe('AE');
  });
  it('신규 캠페인은 CLIENT', () => {
    expect(routeApprover(mk({ kind: 'gfa', targetId: 'gfa:new:acc_gfa:신규', before: '—', after: 500000, approver: 'PM' })).approver).toBe('CLIENT');
    expect(routeApprover(mk({ kind: 'setting', targetId: 'flow:new:meta:x', approver: 'AE' })).approver).toBe('CLIENT');
  });
  it('입찰도 변경 폭으로 재판정 (화면 Flow 신규 요청 · AD Pilot routeByPct와 같은 표) — AE가 보낸 승인 주체를 올린다', () => {
    // QA 재현: +19% · +15% 입찰을 승인 주체 AE로 보내 담당 AE가 스스로 승인 · 반영
    const r19 = routeApprover(mk({ kind: 'bid', targetId: 'kw_6', before: 1420, after: 1690, changePct: 19, approver: 'AE' }));
    expect(r19.approver).toBe('PM');
    expect(r19.notes.join(' ')).toMatch(/입찰가 변경 폭 19%/);
    expect(routeApprover(mk({ kind: 'bid', targetId: 'kw_15', before: 870, after: 1000, changePct: 15, approver: 'AE' })).approver).toBe('PM');
    // ±10% 이내는 AE 그대로 · 30% 초과는 CLIENT · 값과 다른 변경 폭은 큰 쪽
    expect(routeApprover(mk({ kind: 'bid', before: 270, after: 280, changePct: 3.7, approver: 'AE' }))).toMatchObject({ approver: 'AE', notes: [] });
    expect(routeApprover(mk({ kind: 'bid', before: 100, after: 150, changePct: 50, approver: 'AE' })).approver).toBe('CLIENT');
    expect(routeApprover(mk({ kind: 'bid', before: 100, after: 120, changePct: 5, approver: 'AE' })).approver).toBe('PM');
    // 화면이 더 높게 보낸 승인 주체는 낮추지 않는다
    expect(routeApprover(mk({ kind: 'bid', before: 270, after: 280, changePct: 3.7, approver: 'PM' })).approver).toBe('PM');
  });
  it('브랜드 키워드 입찰은 PM 이상 (AD Pilot 브랜드 별도 기준) · 브랜드가 아니면 폭 기준 그대로', () => {
    const b = routeApprover(mk({ kind: 'bid', before: 270, after: 280, changePct: 3.7, approver: 'AE' }), { brandKeyword: true });
    expect(b.approver).toBe('PM');
    expect(b.notes.join(' ')).toMatch(/브랜드 키워드/);
    expect(routeApprover(mk({ kind: 'bid', before: 270, after: 280, changePct: 3.7, approver: 'AE' }), { brandKeyword: false }).approver).toBe('AE');
    expect(routeApprover(mk({ kind: 'bid', before: 100, after: 150, changePct: 50, approver: 'AE' }), { brandKeyword: true }).approver).toBe('CLIENT');
    // 예산에는 브랜드 기준을 쓰지 않는다
    expect(routeApprover(mk({ kind: 'budget', before: 1000, after: 1050, changePct: 5, approver: 'AE' }), { brandKeyword: true }).approver).toBe('AE');
  });
  it('ON/OFF(status)는 PM 하한 (p.15) — AE로 보내도 PM, CLIENT는 유지', () => {
    const s = routeApprover(mk({ kind: 'status', targetId: 'gfa:adgroup:cmp_1:ag_1', before: 'on', after: 'off', changePct: undefined, approver: 'AE' }));
    expect(s.approver).toBe('PM');
    expect(s.notes.join(' ')).toMatch(/ON\/OFF/);
    expect(approverFloor(mk({ kind: 'status', targetId: 'kw_3' }))?.level).toBe('PM');
    expect(routeApprover(mk({ kind: 'status', targetId: 'kw_3', before: 'on', after: 'off', changePct: undefined, approver: 'CLIENT' })).approver).toBe('CLIENT');
    expect(routeApprover(mk({ kind: 'status', targetId: 'alert:inc_1:pause', before: 'on', after: 'off', changePct: undefined, approver: 'AE' })).approver).toBe('PM');
  });
  it('effectivePct', () => {
    expect(effectivePct({ before: 100, after: 110, changePct: 10 })).toMatchObject({ pct: 10, mismatch: false });
    expect(effectivePct({ before: '1,000', after: '1,200', changePct: undefined }).pct).toBeCloseTo(20);
  });
});

describe('승인 주체 하한 · 낮추기 · 메모 문구', () => {
  it('점검 기준을 바꾸는 요청은 화면 값과 무관하게 하한 이상', () => {
    expect(approverFloor(mk({ kind: 'setting', targetId: 'adpilot.cfg.dailyChangeCapPct' }))?.level).toBe('CLIENT');
    expect(approverFloor(mk({ kind: 'setting', targetId: 'adpilot.cfg.targetRoas' }))?.level).toBe('CLIENT');
    expect(approverFloor(mk({ kind: 'setting', targetId: 'adpilot.cfg.bulkBlockCount' }))?.level).toBe('PM');
    expect(approverFloor(mk({ kind: 'setting', targetId: 'adpilot.cfg.unknownKey' }))?.level).toBe('PM');
    expect(approverFloor(mk({ kind: 'alert_rule', targetId: 'alert_rule:cost' }))?.level).toBe('PM');
    expect(approverFloor(mk({ module: 'alert', kind: 'setting', targetId: 'alert:account:acc_gfa:topup' }))?.level).toBe('CLIENT');
    expect(approverFloor(mk({ module: 'alert', kind: 'setting', targetId: 'alert:inc_1:release' }))?.level).toBe('PM');
    expect(approverFloor(mk({ kind: 'setting', targetId: 'flow:strategy' }))?.level).toBe('CLIENT');
    expect(approverFloor(mk())).toBeNull();
    expect(routeApprover(mk({ kind: 'setting', targetId: 'adpilot.cfg.dailyChangeCapPct', before: 20, after: 1000, approver: 'AE' })).approver).toBe('CLIENT');
    expect(routeApprover(mk({ kind: 'setting', targetId: 'adpilot.cfg.dailyChangeCapPct', approver: 'CLIENT' })).notes).toEqual([]);
  });
  it('승인 주체 낮추기는 PM 이상 + 현재 등급 승인 권한', () => {
    expect(canLowerApprover('pm', 'PM')).toBe(true);
    expect(canLowerApprover('pm', 'CLIENT')).toBe(false);
    expect(canLowerApprover('admin', 'CLIENT')).toBe(false);
    expect(canLowerApprover('owner', 'CLIENT')).toBe(true);
    expect(canLowerApprover('client', 'CLIENT')).toBe(false);
    expect(canLowerApprover('ae', 'AE')).toBe(false);
  });
  it("메모가 '반영' 이력처럼 읽히면 '메모'로 (Flow appliedIso 보호)", () => {
    expect(noteEntryOf('반영 확인', '매체 화면')).toEqual({ action: '메모', note: '반영 확인 — 매체 화면' });
    expect(noteEntryOf('일괄 반영')).toEqual({ action: '메모', note: '일괄 반영' });
    expect(noteEntryOf('재실행 보류', '사유')).toEqual({ action: '재실행 보류', note: '사유' });
    expect(noteEntryOf('반영 보류')).toEqual({ action: '반영 보류', note: undefined });
    expect(noteEntryOf('  확인 요청  ', '  ')).toEqual({ action: '확인 요청', note: undefined });
  });
});

describe('대상 해석 (targetId 규칙)', () => {
  it('AD Pilot · GFA · Flow · Alert 규칙', () => {
    expect(parseTarget(mk())).toMatchObject({ type: 'entity', entityTypes: ['keyword'], id: 'kw_1' });
    expect(parseTarget(mk({ kind: 'budget', targetId: 'budget:cmp_2:cmp_5' }))).toMatchObject({ type: 'entity', id: 'cmp_2', donorId: 'cmp_5' });
    expect(parseTarget(mk({ kind: 'budget', targetId: 'budget:cmp_2:' }))).toMatchObject({ id: 'cmp_2', donorId: undefined });
    expect(parseTarget(mk({ kind: 'budget', targetId: 'gfa:budget:cmp_6' }))).toMatchObject({ id: 'cmp_6' });
    expect(parseTarget(mk({ kind: 'budget', targetId: 'flow:budget:cmp_9' }))).toMatchObject({ id: 'cmp_9' });
    expect(parseTarget(mk({ kind: 'status', targetId: 'gfa:adgroup:cmp_7:ag_1' }))).toMatchObject({ id: 'cmp_7', adGroupId: 'ag_1' });
    expect(parseTarget(mk({ kind: 'gfa', targetId: 'gfa:new:acc_gfa:가을 신규' }))).toMatchObject({ entityTypes: ['account'], id: 'acc_gfa', newName: '가을 신규' });
    expect(parseTarget(mk({ module: 'alert', kind: 'status', targetId: 'alert:inc1:pause', target: '매트리스 키워드' }))).toMatchObject({ entityTypes: ['keyword'], text: '매트리스' });
    expect(parseTarget(mk({ module: 'lab', kind: 'keyword_add', targetId: 'term:허리 매트리스' }))).toMatchObject({ type: 'media', media: 'naver_sa' });
  });
  it('내부 기준 · 충전 · 시연 · 프로모션은 기록만', () => {
    for (const c of [
      mk({ kind: 'setting', targetId: 'adpilot.cfg.dailyChangeCapPct' }),
      mk({ kind: 'alert_rule', targetId: 'alert_rule:cost' }),
      mk({ module: 'alert', kind: 'setting', targetId: 'alert:account:acc_gfa:topup' }),
      mk({ targetId: 'seed:bid:kw_1' }),
      mk({ kind: 'budget', targetId: 'flow:promo:promo_1:budget' }),
      mk({ kind: 'test', targetId: 'x' }),
      mk({ targetId: '' }),
    ]) expect(parseTarget(c).type).toBe('record');
  });
});

describe('반영 전 점검 (Flow executionCheck + 서버 점검)', () => {
  const data = generateDemoData('2026-11-02', 10);
  const base = { data, changes: [], incidents: [], today: '2026-11-02', todayAppliedBids: [], bulkIncidentStatus: new Map<string, string>() };
  it('일 조정 폭 상한 · 최대 입찰가 · 정상 통과', () => {
    const pass = evaluateGuards({ ...base, change: mk({ before: 270, after: 280, changePct: 3.7 }) });
    expect(pass.ok).toBe(true);
    expect(pass.passes.join(' ')).toMatch(/AD Pilot 실행 검증/);
    expect([...pass.passes, ...pass.warnings].join(' ')).not.toMatch(/데모: 로컬 상태/);
    const cap = evaluateGuards({ ...base, change: mk({ before: 270, after: 340, changePct: 25.9 }) });
    expect(cap.ok).toBe(false);
    expect(cap.blocks.join(' ')).toMatch(/일 조정 폭 상한 20%/);
    const lie = evaluateGuards({ ...base, change: mk({ before: 270, after: 340, changePct: 5 }) });
    expect(lie.ok).toBe(false);
    expect(lie.warnings.join(' ')).toMatch(/변경 폭 대조/);
    const max = evaluateGuards({ ...base, change: mk({ before: 520, after: 600, changePct: 15.4 }) });
    expect(max.blocks.join(' ')).toMatch(/최대 입찰가/);
  });
  it('GFA Control 실행 검증 (계정 잔액 · 자동충전 실패) → 차단', () => {
    const g = evaluateGuards({ ...base, change: mk({ module: 'gfa', kind: 'budget', targetId: 'gfa:budget:cmp_6', before: 1200000, after: 1260000, changePct: 5 }) });
    expect(g.ok).toBe(false);
    expect(g.blocks.join(' ')).toMatch(/GFA Control 실행 검증/);
  });
  it('데이터셋 없음: 데이터 점검은 건너뛰고 상한만', () => {
    const r = evaluateGuards({ ...base, data: null, dataError: 'no data', change: mk({ before: 270, after: 280, changePct: 3.7 }) });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/데이터셋을 만들 수 없어/);
    expect(evaluateGuards({ ...base, data: null, change: mk({ changePct: 30, after: 351 }) }).ok).toBe(false);
  });
  it('키워드 일 누적 조정 폭', () => {
    const earlier = mk({ id: 'c0', status: 'applied', before: 270, after: 310, changePct: 14.8 });
    const r = evaluateGuards({ ...base, changes: [earlier], todayAppliedBids: [earlier], change: mk({ before: 310, after: 350, changePct: 12.9 }) });
    expect(r.ok).toBe(false);
    expect(r.blocks.join(' ')).toMatch(/오늘 누적 조정 폭 29.6%/);
  });
  it('대량 변경: 미해결 이슈가 걸린 건은 차단, 새 이슈는 적재 대상으로', () => {
    const list = Array.from({ length: 10 }, (_, i) => mk({ id: `b${i}`, createdAt: `2026-11-02T01:0${i}:00.000Z`, requestedBy: '김AE', targetId: `kw_${i + 1}` }));
    const r = evaluateGuards({ ...base, changes: list, change: list[3] });
    expect(r.ok).toBe(false);
    expect(r.bulkIncidents).toHaveLength(1);
    expect(r.bulkIncidents[0].id).toMatch(/^bulk_change:/);
    const resolved = evaluateGuards({ ...base, changes: list, change: list[3], bulkIncidentStatus: new Map([[r.bulkIncidents[0].id, 'resolved']]) });
    expect(resolved.bulkIncidents).toHaveLength(0);
    expect(resolved.blocks.join(' ')).not.toMatch(/대량 변경/);
  });
});

describe('대량 변경 window · 판정 (bulk.ts)', () => {
  const at = (hhmm: string) => `2026-11-02T${hhmm}:00.000+09:00`;
  const mkAt = (id: string, hhmm: string, o: Partial<ChangeRequest> = {}) => mk({ id, createdAt: new Date(at(hhmm)).toISOString(), requestedBy: '김AE', status: 'pending', ...o });
  const burst = (prefix: string, start: number) => Array.from({ length: 10 }, (_, i) => mkAt(`${prefix}${i}`, `${String(start).padStart(2, '0')}:0${i}`));
  it('windowOf: 이 건을 포함한 window만 — 같은 크기의 이전 묶음에 가려지지 않는다', () => {
    const a = burst('a', 10), b = burst('b', 15);
    const all = [...a, ...b];
    expect(windowOf(all, b[4], 10).map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(windowOf(all, a[0], 10).map((x) => x.id)).toEqual(a.map((x) => x.id));
    // 반려 · 롤백 · 대상 밖 종류 · 다른 요청자는 세지 않는다
    expect(windowOf([...a.slice(0, 9), mkAt('x', '10:09', { requestedBy: '다른 AE' })], a[0], 10)).toHaveLength(9);
    expect(windowOf(a.map((x, i) => (i ? { ...x, status: 'rejected' as const } : x)), a[0], 10)).toHaveLength(1);
    expect(windowOf(a, { ...a[0], kind: 'setting' }, 10)).toEqual([]);
    const found = bulkIncidentsFor(all, b[4]);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('bulk_change:adpilot · 김AE:2026-11-02');
    expect(found[0].related).toEqual(b.map((x) => x.id));
  });
  it('decideBulk: 미해결 차단 · 종료 통과 · 종료 뒤 재발은 새 id로 적재', () => {
    const a = burst('a', 10), b = burst('b', 15);
    const all = [...a, ...b];
    const [ib] = bulkIncidentsFor(all, b[0]);
    const id = 'bulk_change:adpilot · 김AE:2026-11-02';
    const fresh = decideBulk([ib], b[0], [], all);
    expect(fresh.toStore.map((x) => x.id)).toEqual([id]);
    expect(fresh.blocks[0]).toMatch(/대량 변경 실수 감지/);
    const open = decideBulk([ib], b[0], [{ id, status: 'open', related: b.map((x) => x.id), resolvedAt: null }], all);
    expect(open).toMatchObject({ toStore: [], passes: [] });
    expect(open.blocks).toHaveLength(1);
    const done = decideBulk([ib], b[0], [{ id, status: 'resolved', related: b.map((x) => x.id), resolvedAt: Date.parse(at('16:00')) }], all);
    expect(done).toMatchObject({ blocks: [], toStore: [] });
    // 첫 묶음(a)이 11:00에 종료된 뒤 b가 생김 → 재발
    const again = decideBulk([ib], b[0], [{ id, status: 'resolved', related: a.map((x) => x.id), resolvedAt: Date.parse(at('11:00')) }], all);
    expect(again.toStore.map((x) => x.id)).toEqual([`${id}:b0`]);
    expect(again.toStore[0].related).toEqual(b.map((x) => x.id));
    // 재발 이슈가 열려 있으면 다시 적재하지 않고 차단
    const followOpen = decideBulk([ib], b[5], [
      { id, status: 'resolved', related: a.map((x) => x.id), resolvedAt: Date.parse(at('11:00')) },
      { id: `${id}:b0`, status: 'open', related: b.map((x) => x.id), resolvedAt: null },
    ], all);
    expect(followOpen.toStore).toEqual([]);
    expect(followOpen.blocks[0]).toContain(`${id}:b0`);
  });
});

describe('커넥터에 넘기는 변경 (opChange · entityOf)', () => {
  it('대상 엔티티는 화이트리스트 필드만, 이전 실행 기록은 넘기지 않는다', () => {
    const e = entityOf({ entityType: 'keyword', externalId: 'nkw-1', source: 'c', doc: { text: '수면밀도', adgroupId: 'grp-1', campaignId: 'cmp-1', bid: 270, token: 'secret', name: 'x'.repeat(300) }, updatedAt: null, connection: null });
    expect(e).toEqual({ type: 'keyword', externalId: 'nkw-1', text: '수면밀도', adgroupId: 'grp-1', campaignId: 'cmp-1' });
    const ch = opChange(mk({ execution: { mode: 'live', ok: true, at: 'x' } }), {
      externalId: 'nkw-1', entityType: 'keyword', kind: 'bid', target: 't', before: 270, after: 297, role: 'primary', connectionId: 'c', provider: 'naver_sa', idempotent: true, entity: e,
    });
    expect(ch).toMatchObject({ targetId: 'nkw-1', before: 270, after: 297, changePct: 10, entity: { adgroupId: 'grp-1' } });
    expect(ch.execution).toBeUndefined();
  });
});
