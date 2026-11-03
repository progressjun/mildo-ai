/**
 * MILDO Flow 역할별 버튼 · 큐 (QA G1a) — 서버 모드는 멤버십 역할로 서버와 같은 판정을 한다.
 *  - 열람자(viewer): 데모 매핑은 '담당 AE'지만 승인 · 반영 · 요청 모두 불가, '내 차례' 없음, 헤더 '승인 권한 없음'
 *  - 소유자(owner): 데모 매핑은 'PM'이지만 CLIENT 건 승인 · 반려 · 보류 · 반영 · 실행 취소 가능 (§2)
 *  - 광고주 담당자(client): 승인까지만 — 반영 · 롤백 · 보류는 비활성 + 이유 (운영 권한 없음)
 * 데모 모드(데모 3역할 문자열)는 기존 규칙 그대로인지 함께 본다.
 * 서버 모드 반영 · 롤백 · 승인은 화면 점검 문구를 이력 메모로 보내지 않는다(서버가 이력을 직접 쓴다 — 중복 · 데모 꼬리표 방지).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest, Incident, Toast } from '@/core/types';
import type { Role } from '@/core/permissions';
import { DEMO } from '@/data/demo';
import {
  actionAllowed, availableActions, canAct, executionCheck, filterChanges, isMyTurn, myQueue, roleScopeText, seedChanges, serverPreApplyCheck, stripDemoTag,
} from './engine';
import type { FlowCtx } from './useFlow';

const toasts: Omit<Toast, 'id'>[] = [];
const updates: { id: string; patch: Partial<ChangeRequest>; action: string; note?: string }[] = [];
const added: ChangeRequest[] = [];
let realActions = false;
vi.mock('@/core/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/store')>();
  return {
    ...actual,
    useActions: () => (realActions ? actual.useActions() : {
      toast: (t: Omit<Toast, 'id'>) => { toasts.push(t); },
      updateChange: (id: string, patch: Partial<ChangeRequest>, action: string, note?: string) => { updates.push({ id, patch, action, note }); },
      addChange: (c: ChangeRequest) => { added.push(c); return { ...c, id: 'new_1' }; },
      addIncident: () => undefined,
      updateIncident: () => undefined,
    }),
  };
});

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});
beforeEach(() => { toasts.length = 0; updates.length = 0; added.length = 0; realActions = false; });

const SEEDS = seedChanges(DEMO);
const base = SEEDS[0];
const mk = (o: Partial<ChangeRequest>): ChangeRequest => ({ ...base, id: 'qa_x', history: [{ at: base.createdAt, by: 'QA', action: '요청 생성' }], ...o });
const AE_PENDING = mk({ id: 'qa_ae_lvl_1', approver: 'AE', status: 'pending', target: 'QA 테스트 키워드 입찰가' });
const CLIENT_PENDING = mk({ id: 'qa_client_lvl_1', approver: 'CLIENT', status: 'pending', target: '예산 재배분' });
const CLIENT_APPROVED = mk({ id: 'qa_client_lvl_2', approver: 'CLIENT', status: 'approved', history: [...AE_PENDING.history, { at: base.createdAt, by: '수면밀도', action: '승인' }] });
/** PM이 처리할 수 있고 실행 점검을 통과하는 승인 완료 건 */
const PM_APPROVED: ChangeRequest = (() => {
  const c = SEEDS.map((s) => ({ ...s, id: `srv_${s.id}`, approver: 'PM' as const, status: 'approved' as const })).find((s) => executionCheck(DEMO, [s], [], s).ok);
  if (!c) throw new Error('실행 점검을 통과하는 시연 이력이 없습니다');
  return c;
})();

const member = (r: Role) => ({ member: r });

describe('Flow 엔진 · 멤버십 역할 판정', () => {
  it('열람자: 데모 매핑(담당 AE)과 달리 승인 · 반영 불가, 내 차례 없음', () => {
    const v = member('viewer');
    expect(canAct(v, 'AE').ok).toBe(false);
    expect(availableActions(AE_PENDING, v, [AE_PENDING]).every((a) => !a.ok)).toBe(true);
    expect(isMyTurn(AE_PENDING, v)).toBe(false);
    expect(myQueue([AE_PENDING], v).total).toBe(0);
    expect(filterChanges([AE_PENDING], { scope: 'mine' }, v)).toEqual([]);
    expect(roleScopeText(v)).toBe('승인 권한 없음 (읽기 전용)');
    // 데모 '담당 AE'는 그대로 AE 건 처리 가능
    expect(canAct('담당 AE', 'AE').ok).toBe(true);
    expect(myQueue([AE_PENDING], '담당 AE').total).toBe(1);
  });

  it('소유자: 데모 매핑(PM)과 달리 CLIENT 건 승인 · 반려 · 보류 · 반영 · 실행 취소', () => {
    const o = member('owner');
    expect(availableActions(CLIENT_PENDING, o, [CLIENT_PENDING]).map((a) => [a.action, a.ok])).toEqual([['approve', true], ['reject', true], ['hold', true]]);
    expect(availableActions(CLIENT_APPROVED, o, [CLIENT_APPROVED]).map((a) => [a.action, a.ok])).toEqual([['apply', true], ['hold', true], ['cancel', true]]);
    expect(myQueue([CLIENT_PENDING, CLIENT_APPROVED], o)).toMatchObject({ total: 2 });
    expect(roleScopeText(o)).toBe('승인 범위 담당 AE · PM · 수면밀도 건');
    // 데모 'PM'은 그대로 CLIENT 건 권한 밖, 관리자(admin)도 서버처럼 CLIENT 건 불가
    expect(canAct('PM', 'CLIENT').ok).toBe(false);
    expect(availableActions(CLIENT_APPROVED, member('admin'), [CLIENT_APPROVED]).find((a) => a.action === 'apply')!.ok).toBe(false);
  });

  it('광고주 담당자: 승인 · 반려 · 실행 취소만 — 반영 · 롤백 · 보류는 운영 권한이 없어 비활성 + 이유, 반영 대기는 내 차례가 아니다', () => {
    const c = member('client');
    const av = availableActions(PM_APPROVED, c, [PM_APPROVED]);
    expect(av.map((a) => [a.action, a.ok])).toEqual([['apply', false], ['hold', false], ['cancel', true]]);
    expect(av[0].reason).toContain('운영 권한');
    const applied: ChangeRequest = { ...PM_APPROVED, id: 'qa_applied', status: 'applied' };
    expect(availableActions(applied, c, [applied])[0]).toMatchObject({ action: 'rollback', ok: false });
    expect(isMyTurn(PM_APPROVED, c)).toBe(false);
    expect(isMyTurn(CLIENT_PENDING, c)).toBe(true);
    // 데모 '수면밀도'는 그대로 반영 가능 (기존 규칙)
    expect(actionAllowed('수면밀도', 'PM', 'apply').ok).toBe(true);
  });
});

describe('Flow 엔진 · 서버 모드 반영 전 점검 미리보기', () => {
  const bulkInc = (related: string[], status: Incident['status']): Incident => ({
    id: 'bulk_change:adpilot · 이AE:2026-11-03', ruleId: 'bulk_change', severity: 'P1', title: 'AD Pilot 이AE 10분 내 11건 일괄 변경', detectedAt: base.createdAt, occurredAt: base.createdAt,
    detectPath: 'MILDO Alert', causeCandidates: [], impact: {}, status, timeline: [], isTest: false, autoActions: [], related,
  } as Incident);

  it('이 건이 걸린 대량 변경 이슈(P1)가 열려 있으면 "통과"가 아니라 서버 보류를 예상한다', () => {
    const c = PM_APPROVED;
    expect(executionCheck(DEMO, [c], [bulkInc([c.id], 'open')], c).ok).toBe(true); // 화면 엔진 점검만으로는 통과 (QA 재현)
    const pre = serverPreApplyCheck(DEMO, [c], [bulkInc([c.id], 'open')], c);
    expect(pre.ok).toBe(false);
    expect(pre.blocks.join(' ')).toContain('대량 변경 실수 감지');
    expect(pre.blocks.join(' ')).toContain('신규 반영 일시 차단');
    // 확인 · 종료된 이슈면 통과
    expect(serverPreApplyCheck(DEMO, [c], [bulkInc([c.id], 'resolved')], c).ok).toBe(true);
    // 다른 건만 걸린 이슈는 영향 없음
    expect(serverPreApplyCheck(DEMO, [c], [bulkInc(['other'], 'open')], c).ok).toBe(true);
  });

  it('적재 전이라도 같은 기준으로 감지되는 묶음(같은 요청자 10건 이상)은 서버 보류를 예상한다', () => {
    const t0 = Date.parse(base.createdAt);
    const many: ChangeRequest[] = Array.from({ length: 11 }, (_, i) => ({
      ...PM_APPROVED, id: `qa_bulk_${i}`, module: 'adpilot', kind: 'bid', requestedBy: '이AE', createdAt: new Date(t0 + i * 30_000).toISOString(),
    }));
    const pre = serverPreApplyCheck(DEMO, many, [], many[0]);
    expect(pre.ok).toBe(false);
    expect(pre.blocks.join(' ')).toMatch(/대량 변경 실수 감지 .*서버가 실행을 보류/);
  });

  it('서버 모드 미리보기에는 데모 꼬리표가 없다', () => {
    const pre = serverPreApplyCheck(DEMO, [PM_APPROVED], [], PM_APPROVED);
    expect([...pre.blocks, ...pre.warnings, ...pre.passes].join(' ')).not.toContain('데모: 로컬 상태');
    expect(stripDemoTag('AD Pilot 실행 검증 · AD Pilot 반영 (데모: 로컬 상태 · 실제 연동 시 네이버 SA API)')).toBe('AD Pilot 실행 검증 · AD Pilot 반영');
  });
});

/* ---------- 화면 (SSR) ---------- */

function setStore(changes: ChangeRequest[], role: '담당 AE' | 'PM' | '수면밀도' = '담당 AE') {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents: [], comments: [], ai: { mode: 'offline' }, role, tf: {} });
}
async function render(node: ReactNode, mode: 'server' | 'demo', role: Role = 'viewer'): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const inner = h(StoreProvider, null, node);
  return renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role }, children: inner }) : inner).replace(/<!-- -->/g, '');
}
async function drawer(id: string): Promise<ComponentType> {
  const { useFlow } = await import('./useFlow');
  const { ChangeDrawer } = await import('./ChangeDrawer');
  return function Harness() { return h(ChangeDrawer, { ctx: useFlow(), id, onClose: () => undefined }); };
}
async function board(): Promise<ComponentType> {
  const { useFlow } = await import('./useFlow');
  const { BoardTab } = await import('./BoardTab');
  return function Harness() { return h(BoardTab, { ctx: useFlow(), onOpen: () => undefined, onNew: () => undefined }); };
}
const btn = (html: string, label: string) => {
  const m = [...html.matchAll(/<button([^>]*)>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g)].find((x) => x[2].trim() === label);
  if (!m) return null;
  return { disabled: /\sdisabled=""/.test(m[1]), title: m[1].match(/title="([^"]*)"/)?.[1] ?? '' };
};

describe('Flow 화면 · 서버 모드 역할', () => {
  it('열람자: 헤더 "승인 권한 없음", 보드에 내 차례 없음 · 신규 요청 비활성 + 이유, 상세 승인 비활성 + 이유', async () => {
    setStore([AE_PENDING], '담당 AE'); // 서버 모드 store.role = demoRole('viewer') = '담당 AE'
    const View = (await import('./View')).default as ComponentType;
    const head = await render(h(View), 'server', 'viewer');
    expect(head).toContain('승인 권한 없음 (읽기 전용)');
    expect(head).not.toContain('승인 범위 담당 AE 건');
    const b = await render(h(await board()), 'server', 'viewer');
    expect(b).not.toContain('내 차례</span>');
    expect(btn(b, '신규 요청')).toMatchObject({ disabled: true, title: expect.stringContaining('읽기 전용') });
    const d = await render(h(await drawer(AE_PENDING.id)), 'server', 'viewer');
    expect(d).toContain('열람자 · 승인 권한 없음');
    expect(d).toContain('권한 밖');
    expect(btn(d, '승인')).toMatchObject({ disabled: true, title: expect.stringContaining('읽기 전용') });
    // 데모 모드 '담당 AE'는 그대로 처리 가능
    const demo = await render(h(await drawer(AE_PENDING.id)), 'demo');
    expect(btn(demo, '승인')).toMatchObject({ disabled: false });
  });

  it('소유자: CLIENT 건 상세에서 승인 · 반영 · 실행 취소 활성, 보드에 내 차례', async () => {
    setStore([CLIENT_PENDING, CLIENT_APPROVED], 'PM');
    const d1 = await render(h(await drawer(CLIENT_PENDING.id)), 'server', 'owner');
    expect(d1).toContain('소유자 · 승인 범위 담당 AE · PM · 수면밀도');
    expect(btn(d1, '승인')).toMatchObject({ disabled: false });
    const d2 = await render(h(await drawer(CLIENT_APPROVED.id)), 'server', 'owner');
    expect(btn(d2, '반영')).toMatchObject({ disabled: false });
    const b = await render(h(await board()), 'server', 'owner');
    expect(b).toContain('내 차례</span>');
    expect(b).toContain('>내 차례 2</button>');
    // 데모 'PM'은 그대로 CLIENT 건 권한 밖
    const demo = await render(h(await drawer(CLIENT_PENDING.id)), 'demo');
    expect(btn(demo, '승인')).toMatchObject({ disabled: true });
  });

  it('광고주 담당자: 승인 완료 건의 반영은 비활성 + 운영 권한 이유, 실행 취소는 활성', async () => {
    setStore([PM_APPROVED], '수면밀도');
    const d = await render(h(await drawer(PM_APPROVED.id)), 'server', 'client');
    expect(btn(d, '반영')).toMatchObject({ disabled: true, title: expect.stringContaining('운영 권한') });
    expect(d).toContain('일부 단계만 가능');
    const demo = await render(h(await drawer(PM_APPROVED.id)), 'demo');
    expect(btn(demo, '반영')).toMatchObject({ disabled: false });
  });
});

/* ---------- 액션 (useFlow) ---------- */

async function flowCtx(mode: 'server' | 'demo', role: Role = 'pm'): Promise<FlowCtx> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const { useFlow } = await import('./useFlow');
  let ctx: FlowCtx | null = null;
  function Probe() { ctx = useFlow(); return null; }
  const inner: ReactNode = h(StoreProvider, null, h(Probe));
  renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role }, children: inner }) : inner);
  if (!ctx) throw new Error('useFlow 컨텍스트 없음');
  return ctx;
}

describe('Flow 액션 · 서버 모드', () => {
  it('열람자의 승인 · 요청은 보내지 않는다 (낙관적 성공 알림 → 403 되돌림 없음)', async () => {
    setStore([AE_PENDING], '담당 AE');
    const v = await flowCtx('server', 'viewer');
    expect(v.act(AE_PENDING, 'approve')).toBe(false);
    expect(updates).toEqual([]);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'warning', title: '승인 권한이 없습니다' })]);
    toasts.length = 0;
    expect(v.createRequest({ ...AE_PENDING, module: 'flow' })).toBeNull();
    expect(added).toEqual([]);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'warning', title: '변경 요청 권한이 없습니다' })]);
  });

  it('광고주 담당자의 반영은 보내지 않는다, 소유자의 CLIENT 건 반영은 보낸다', async () => {
    setStore([PM_APPROVED], '수면밀도');
    const c = await flowCtx('server', 'client');
    expect(c.act(PM_APPROVED, 'apply')).toBe(false);
    expect(updates).toEqual([]);
    expect(toasts[0]).toMatchObject({ tone: 'warning', title: '반영 권한이 없습니다' });
    const ownerItem = { ...PM_APPROVED, id: 'qa_owner_client', approver: 'CLIENT' as const };
    setStore([ownerItem], 'PM');
    const o = await flowCtx('server', 'owner');
    expect(o.act(ownerItem, 'apply')).toBe(true);
    expect(updates).toEqual([expect.objectContaining({ id: ownerItem.id, patch: { status: 'applied' } })]);
  });

  it('반영 · 롤백 · 승인: 서버 모드는 화면 점검 · 복원 문구를 메모로 보내지 않는다 (서버가 이력을 쓴다) — 데모는 그대로', async () => {
    setStore([PM_APPROVED], 'PM');
    const s = await flowCtx('server', 'pm');
    expect(s.act(PM_APPROVED, 'apply')).toBe(true);
    const applied: ChangeRequest = { ...PM_APPROVED, status: 'applied' };
    expect(s.act(applied, 'rollback')).toBe(true);
    const pending: ChangeRequest = { ...PM_APPROVED, id: 'qa_pm_pending', status: 'pending' };
    expect(s.act(pending, 'approve')).toBe(true);
    expect(updates.map((u) => u.note)).toEqual([undefined, undefined, undefined]);
    // 사용자가 쓴 메모는 그대로
    expect(s.act(applied, 'rollback', 'QA 메모')).toBe(true);
    expect(updates[3].note).toBe('QA 메모');
    // 롤백 알림 조사: '860원으로 복원' (원 + 으로)
    expect(toasts.find((t) => t.title === '롤백 요청을 보냈습니다')!.body).toMatch(/원으로 복원/);

    updates.length = 0;
    const d = await flowCtx('demo');
    expect(d.act(PM_APPROVED, 'apply')).toBe(true);
    expect(d.act(applied, 'rollback')).toBe(true);
    expect(updates[0].note).toBeTruthy();
    expect(updates[1].note).toMatch(/^직전 상태로 복원: /);
  });
});
