/**
 * QA 회귀 (SSR): 연결 요청 버튼 — 요청 후 라벨 폭 유지('…요청됨 …'), 해결된 이슈에서는 요청 버튼 숨김.
 * 라벨이 짧아지면 더블클릭의 두 번째 클릭이 옆 링크(MILDO Flow 이력) · 버튼(이슈 열기)에 떨어져 화면이 이동했다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';
import { DEMO } from '@/data/demo';
import { detectIncidents } from './engine';

const found = detectIncidents(DEMO);
const soldout = found.find((i) => i.ruleId === 'soldout_landing')!;
const perm = found.find((i) => i.ruleId === 'account_permission')!;
const pay = found.find((i) => i.ruleId === 'account_payment')!;
const google = DEMO.accounts.find((a) => a.name === perm.target)!;
const gfa = DEMO.accounts.find((a) => a.name === pay.target)!;
const incidents = found.map((i) => (i.id === soldout.id ? { ...i, status: 'resolved' as const, falsePositive: true, actionNote: '오탐 · 재고 있음', sla: { ackAt: '2026-10-31T15:31:00+09:00', resolvedAt: '2026-10-31T15:32:00+09:00' } } : i));
const chg = (targetId: string, before: unknown, after: unknown, approver: ChangeRequest['approver']): ChangeRequest => ({
  id: `qa-${targetId}`, createdAt: '2026-10-31T15:31:00+09:00', module: 'alert', kind: 'setting', target: targetId, targetId, before: before as never, after: after as never,
  reason: 'r', requestedBy: 'PM', approver, status: 'pending', history: [],
});
const changes = [chg(`alert:account:${google.id}:revoke`, 'x', 'y', 'PM'), chg(`alert:account:${gfa.id}:topup`, gfa.balance, gfa.balance + 5_500_000, 'CLIENT')];

beforeAll(() => {
  const mem: Record<string, string> = { 'mildo-os/v1': JSON.stringify({ incidents, changes, role: 'PM' }) };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

async function render(name: 'IncidentDrawer' | 'AccountsTab', extra: Record<string, unknown> = {}) {
  const { StoreProvider } = await import('@/core/store');
  const { useAlert } = await import('./hooks');
  const mod = name === 'IncidentDrawer' ? await import('./IncidentDrawer') : await import('./AccountsTab');
  const Tab = (mod as Record<string, unknown>)[name] as ComponentType<Record<string, unknown>>;
  function Harness() {
    const ctx = useAlert();
    return h(Tab, { ctx, onOpen: () => undefined, onClose: () => undefined, ...extra });
  }
  return renderToString(h(StoreProvider, null, h(Harness)));
}

describe('QA 회귀: 연결 요청 버튼', () => {
  it('요청 후 라벨은 원래 문구에 "됨"만 더한다 (폭 유지)', async () => {
    const d = await render('IncidentDrawer', { id: perm.id });
    expect(d).toContain('권한 회수 요청됨 (PM → 수면밀도 통보)');
    const p = await render('IncidentDrawer', { id: pay.id });
    expect(p).toContain('충전 요청됨 550만원 · 3일치 (수면밀도 승인)');
    const a = await render('AccountsTab');
    expect(a).toContain('충전 요청됨 550만원 (수면밀도 승인)');
  });
  it('해결(오탐 포함)된 이슈에는 일시 중지 · 회수 · 충전 요청 버튼을 띄우지 않는다', async () => {
    const html = await render('IncidentDrawer', { id: soldout.id });
    expect(html).toContain('오탐으로 종료');
    expect(html).not.toContain('키워드 일시 중지 요청');
    expect(html).toContain('MILDO Flow 이력');
  });
});
