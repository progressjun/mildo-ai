/**
 * AD Pilot · GFA Control 서버 모드 (QA G1a)
 *  - 역할: 서버와 같은 판정 — 열람자는 요청 · 승인 불가, 광고주 담당자는 승인까지(반영 · 실행 · 롤백 비활성 + 이유), 소유자는 CLIENT 건 실행
 *  - 알림: 반영 · GFA 실행 · 롤백은 서버가 판정(보류 · dry_run)하므로 '보냈습니다'만 — '반영했습니다 · 롤백 가능' 없음
 *  - 이력 메모: 화면 검증 문구 '(데모: 로컬 상태 …)' · 복원 문구를 서버로 보내지 않는다 (서버가 이력을 직접 쓴다)
 *  - 문구: 서버 모드에 '반영은 데모 환경에서 로컬 상태' · '반영은 데모 로컬 상태'가 없다, 롤백 알림 조사 '…원으로 복원'
 * 데모 모드 동작은 그대로인지 함께 본다. 알림 · 변경은 useActions만 가짜로 모은다.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest, Toast } from '@/core/types';
import type { Role } from '@/core/permissions';
import { DEMO } from '@/data/demo';
import { proposalChangeInput, validateAdpilotExecution, validateGfaExecution } from './engine';
import type { AdPilotCtx } from './useAdPilot';

const toasts: Omit<Toast, 'id'>[] = [];
const updates: { id: string; patch: Partial<ChangeRequest>; action: string; note?: string }[] = [];
const added: ChangeRequest[] = [];
vi.mock('@/core/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/store')>();
  return {
    ...actual,
    useActions: () => ({
      toast: (t: Omit<Toast, 'id'>) => { toasts.push(t); },
      updateChange: (id: string, patch: Partial<ChangeRequest>, action: string, note?: string) => { updates.push({ id, patch, action, note }); },
      addChange: (c: ChangeRequest) => { added.push(c); return { ...c, id: `new_${added.length}`, approver: c.approver ?? 'AE' }; },
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
beforeEach(() => { toasts.length = 0; updates.length = 0; added.length = 0; });

function setStore(changes: ChangeRequest[], role: '담당 AE' | 'PM' | '수면밀도' = 'PM') {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents: [], comments: [], ai: { mode: 'offline' }, role, tf: {} });
}
async function wrap(node: ReactNode, mode: 'server' | 'demo', role: Role): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const inner = h(StoreProvider, null, node);
  return renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role }, children: inner }) : inner).replace(/<!-- -->/g, '');
}
async function apCtx(mode: 'server' | 'demo', role: Role = 'pm'): Promise<AdPilotCtx> {
  const { useAdPilot } = await import('./useAdPilot');
  let ctx: AdPilotCtx | null = null;
  function Probe() { ctx = useAdPilot(); return null; }
  await wrap(h(Probe), mode, role);
  if (!ctx) throw new Error('useAdPilot 컨텍스트 없음');
  return ctx;
}
const btns = (html: string, label: string) =>
  [...html.matchAll(/<button([^>]*)>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g)].filter((x) => x[2].trim() === label)
    .map((m) => ({ disabled: /\sdisabled=""/.test(m[1]), title: m[1].match(/title="([^"]*)"/)?.[1] ?? '' }));

const AT = '2026-11-03T01:00:00.000Z';
const approvedHist = [{ at: AT, by: 'QA', action: '요청 생성' }, { at: AT, by: '김PM', action: '승인' }];
let BID: ChangeRequest;
let GFA_OFF: ChangeRequest;
beforeAll(async () => {
  setStore([]);
  const ap = await apCtx('demo');
  const p = ap.proposals.find((x) => (x.action === 'bid_up' || x.action === 'bid_down') && x.approver === 'PM' && (() => {
    const i = proposalChangeInput(x, 'PM');
    return !!i && validateAdpilotExecution(DEMO, { ...i, id: 'probe', createdAt: AT, history: approvedHist, status: 'approved' } as ChangeRequest, ap.proposals).ok;
  })());
  if (!p) throw new Error('반영 가능한 PM 입찰 후보가 없습니다');
  BID = { ...proposalChangeInput(p, 'PM')!, id: 'qa_bid_1', createdAt: AT, history: approvedHist, status: 'approved' } as ChangeRequest;
  const cv = ap.gfa.flatMap((v) => v.campaigns).find((c) => c.adGroups.some((g) => g.status === 'on'))!;
  const ag = cv.adGroups.find((g) => g.status === 'on')!;
  GFA_OFF = {
    id: 'qa_gfa_off', createdAt: AT, module: 'gfa', kind: 'status', target: `${cv.campaign.name} · ${ag.name} OFF`, targetId: `gfa:adgroup:${cv.campaign.id}:${ag.id}`,
    before: 'on', after: 'off', reason: 'QA', requestedBy: 'QA', approver: 'PM', status: 'approved', history: approvedHist,
  };
  expect(validateGfaExecution(ap.gfa, GFA_OFF).ok).toBe(true);
});

describe('AD Pilot · 서버 모드 반영 알림 · 이력 메모', () => {
  it('반영: "반영 요청을 보냈습니다"(dry_run · 보류 가능성 안내), 메모 없음 — 데모는 "반영했습니다 · 롤백 가능" + 검증 문구', async () => {
    setStore([BID]);
    const s = await apCtx('server', 'pm');
    expect(s.apply(BID)).toBe(true);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'info', title: '반영 요청을 보냈습니다' })]);
    expect(toasts[0].body).toContain('dry_run');
    expect(toasts[0].body).not.toContain('롤백 가능');
    expect(updates).toEqual([expect.objectContaining({ id: BID.id, patch: { status: 'applied' }, action: '반영', note: undefined })]);

    toasts.length = 0; updates.length = 0;
    const d = await apCtx('demo');
    expect(d.apply(BID)).toBe(true);
    expect(toasts).toEqual([expect.objectContaining({ tone: 'good', title: '반영했습니다' })]);
    expect(updates[0].note).toContain('데모: 로컬 상태');
  });

  it('GFA 실행: "GFA 실행 요청을 보냈습니다", 메모 없음 — 데모는 "GFA 변경을 실행했습니다"', async () => {
    setStore([GFA_OFF]);
    const s = await apCtx('server', 'pm');
    expect(s.apply(GFA_OFF)).toBe(true);
    expect(toasts.map((t) => t.title)).toEqual(['GFA 실행 요청을 보냈습니다']);
    expect(updates[0]).toMatchObject({ action: '실행 · 반영', note: undefined });
    toasts.length = 0;
    const d = await apCtx('demo');
    expect(d.apply(GFA_OFF)).toBe(true);
    expect(toasts.map((t) => t.title)).toEqual(['GFA 변경을 실행했습니다']);
  });

  it('롤백: "롤백 요청을 보냈습니다 … 원으로 복원", 복원 문구는 서버가 쓴다 — 데모는 "롤백했습니다"', async () => {
    const applied: ChangeRequest = { ...BID, status: 'applied', history: [...approvedHist, { at: AT, by: '김PM', action: '반영' }] };
    setStore([applied]);
    const s = await apCtx('server', 'pm');
    expect(s.rollback(applied)).toBe(true);
    expect(toasts[0]).toMatchObject({ tone: 'info', title: '롤백 요청을 보냈습니다' });
    expect(toasts[0].body).toMatch(/원으로 복원/);
    expect(toasts[0].body).not.toMatch(/원로 복원/);
    expect(updates[0]).toMatchObject({ action: '롤백', note: undefined });
    toasts.length = 0; updates.length = 0;
    const d = await apCtx('demo');
    expect(d.rollback(applied)).toBe(true);
    expect(toasts[0].title).toBe('롤백했습니다');
    expect(updates[0].note).toMatch(/^직전 상태로 복원: /);
  });

  it('승인 · 반려: 서버 모드는 화면 권한 문구를 메모로 보내지 않는다', async () => {
    const pending: ChangeRequest = { ...BID, id: 'qa_bid_p', status: 'pending', history: approvedHist.slice(0, 1) };
    setStore([pending]);
    const s = await apCtx('server', 'pm');
    expect(s.approve(pending)).toBe(true);
    expect(s.reject(pending)).toBe(true);
    expect(updates.map((u) => u.note)).toEqual([undefined, undefined]);
  });
});

describe('AD Pilot · 서버 모드 역할', () => {
  it('열람자: 승인 요청 버튼 비활성 + 이유, 요청 · 승인은 보내지 않는다', async () => {
    setStore([], '담당 AE');
    const v = await apCtx('server', 'viewer');
    expect(v.requestPerm.ok).toBe(false);
    const p = v.proposals.find((x) => v.requestable(x))!;
    expect(v.request(p)).toBeNull();
    expect(added).toEqual([]);
    expect(toasts[0]).toMatchObject({ tone: 'warning', title: '변경 요청 권한이 없습니다' });
    const pending: ChangeRequest = { ...BID, id: 'qa_ae_p', approver: 'AE', status: 'pending' };
    expect(v.approve(pending)).toBe(false);
    expect(updates).toEqual([]);

    const { ProposalsTab } = await import('./ProposalsTab');
    const { useAdPilot } = await import('./useAdPilot');
    function Tab() { return h(ProposalsTab, { ap: useAdPilot(), filter: 'all', setFilter: () => undefined, onHistory: () => undefined }); }
    const html = await wrap(h(Tab), 'server', 'viewer');
    const req = btns(html, '승인 요청');
    expect(req.length).toBeGreaterThan(0);
    expect(req.every((b) => b.disabled && b.title.includes('읽기 전용'))).toBe(true);
    // 데모 '담당 AE'는 그대로 요청 가능
    const demo = await wrap(h(Tab), 'demo', 'viewer');
    expect(btns(demo, '승인 요청').every((b) => !b.disabled)).toBe(true);
  });

  it('광고주 담당자: 승인된 건의 반영 · GFA 실행은 비활성 + 운영 권한 이유, 반영 시도는 보내지 않는다', async () => {
    setStore([BID, GFA_OFF], '수면밀도');
    const c = await apCtx('server', 'client');
    expect(c.canApprove(BID).ok).toBe(true);
    expect(c.perm(BID, 'apply')).toMatchObject({ ok: false, reason: expect.stringContaining('운영 권한') });
    expect(c.apply(BID)).toBe(false);
    expect(updates).toEqual([]);
    const { HistoryTab } = await import('./HistoryTab');
    const { useAdPilot } = await import('./useAdPilot');
    function Hist() { return h(HistoryTab, { ap: useAdPilot() }); }
    const html = await wrap(h(Hist), 'server', 'client');
    expect(btns(html, '반영')).toEqual([expect.objectContaining({ disabled: true, title: expect.stringContaining('운영 권한') })]);
    expect(btns(html, '실행')).toEqual([expect.objectContaining({ disabled: true })]);
    // 데모 '수면밀도'는 그대로 반영 가능
    const demo = await wrap(h(Hist), 'demo', 'client');
    expect(btns(demo, '반영')).toEqual([expect.objectContaining({ disabled: false })]);
  });

  it('소유자: CLIENT 건(GFA 신규 · 30% 초과) 실행 가능 — 관리자는 불가 (서버와 같은 표)', async () => {
    const cl: ChangeRequest = { ...GFA_OFF, id: 'qa_gfa_client', approver: 'CLIENT' };
    setStore([cl], 'PM');
    const o = await apCtx('server', 'owner');
    expect(o.perm(cl, 'apply').ok).toBe(true);
    expect(o.apply(cl)).toBe(true);
    const a = await apCtx('server', 'admin');
    expect(a.perm(cl, 'apply').ok).toBe(false);
  });
});

describe('AD Pilot · 서버 모드 문구', () => {
  it('조정 후보 하단 · 마크다운 꼬리말에 데모 로컬 상태 문구가 없다 (데모 모드는 그대로)', async () => {
    setStore([BID]);
    const { ProposalsTab } = await import('./ProposalsTab');
    const { historyMarkdown } = await import('./HistoryTab');
    const { useAdPilot } = await import('./useAdPilot');
    function Tab() { return h(ProposalsTab, { ap: useAdPilot(), filter: 'all', setFilter: () => undefined, onHistory: () => undefined }); }
    const server = await wrap(h(Tab), 'server', 'pm');
    expect(server).not.toContain('반영은 데모 환경');
    expect(server).toContain('dry_run이면 보낼 요청만 기록');
    const demo = await wrap(h(Tab), 'demo', 'pm');
    expect(demo).toContain('반영은 데모 환경에서 로컬 상태로 기록되며');
    const rows = [{ key: 'k', at: '2026-11-03T08:36:00.000Z', by: '김PM', action: '롤백', change: BID }];
    expect(historyMarkdown(rows, '2026-11-03', true)).not.toContain('데모 로컬 상태');
    expect(historyMarkdown(rows, '2026-11-03', true)).toContain('dry_run');
    expect(historyMarkdown(rows, '2026-11-03', false)).toContain('_시연용 테스트 데이터 기준 · 반영은 데모 로컬 상태_');
    // 시각은 KST (UTC 08:36 → 17:36)
    expect(historyMarkdown(rows, '2026-11-03', true)).toContain('| 17:36 | 김PM |');
  });
});
