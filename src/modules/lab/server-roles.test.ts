/**
 * MILDO Lab 서버 모드 역할 (QA G1a) — 열람자는 '테스트 그룹 등록 요청'이 비활성 + 이유(서버가 403으로 거절할 요청을 보내지 않는다),
 * 광고주 담당자는 승인된 건의 '반영'이 비활성 + 운영 권한 이유, 소유자는 CLIENT 건 승인 가능. 데모 모드(데모 3역할)는 그대로.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';
import type { Role } from '@/core/permissions';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});
function setStore(changes: ChangeRequest[], role: '담당 AE' | 'PM' | '수면밀도') {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents: [], comments: [], ai: { mode: 'offline' }, role, tf: {} });
}
async function wrap(node: ReactNode, mode: 'server' | 'demo', role: Role): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const inner = h(StoreProvider, null, node);
  return renderToString(mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role }, children: inner }) : inner).replace(/<!-- -->/g, '');
}
const btns = (html: string, label: string) =>
  [...html.matchAll(/<button([^>]*)>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g)].filter((x) => x[2].trim() === label)
    .map((m) => ({ disabled: /\sdisabled=""/.test(m[1]), title: m[1].match(/title="([^"]*)"/)?.[1] ?? '' }));

const reg = (o: Partial<ChangeRequest>): ChangeRequest => ({
  id: 'qa_lab_1', createdAt: '2026-11-03T01:00:00.000Z', module: 'lab', kind: 'keyword_add', target: '매트리스 경도 고르는 법', targetId: 'labreg:매트리스경도고르는법',
  before: '미등록', after: 'PROBLEM_TEST · 입찰 상한 900원', reason: '검색어 보고서', requestedBy: '김AE', approver: 'AE', status: 'approved', history: [], ...o,
});

describe('MILDO Lab · 서버 모드 역할', () => {
  it('열람자: 테스트 그룹 등록 요청 비활성 + 읽기 전용 이유 (데모 담당 AE는 그대로 활성)', async () => {
    setStore([], '담당 AE');
    const { useLabModel } = await import('./parts');
    const { DiscoverTab } = await import('./DiscoverTab');
    const Tab: ComponentType = () => h(DiscoverTab, { m: useLabModel() });
    const server = await wrap(h(Tab), 'server', 'viewer');
    const s = [...btns(server, '테스트 그룹 등록 요청'), ...btns(server, '등록 요청')];
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((b) => b.disabled && b.title.includes('읽기 전용'))).toBe(true);
    const demo = await wrap(h(Tab), 'demo', 'viewer');
    expect(btns(demo, '테스트 그룹 등록 요청').concat(btns(demo, '등록 요청')).some((b) => !b.disabled)).toBe(true);
  });

  it('광고주 담당자: 승인된 등록 요청의 반영은 비활성 + 운영 권한 이유, 소유자는 CLIENT 건 승인 가능', async () => {
    const { ChangeActions } = await import('./parts');
    setStore([], '수면밀도');
    const client = await wrap(h(ChangeActions, { c: reg({}) }), 'server', 'client');
    expect(btns(client, '반영')).toEqual([expect.objectContaining({ disabled: true, title: expect.stringContaining('운영 권한') })]);
    const demo = await wrap(h(ChangeActions, { c: reg({}) }), 'demo', 'client');
    expect(btns(demo, '반영')).toEqual([expect.objectContaining({ disabled: false })]);

    setStore([], 'PM');
    const pending = reg({ id: 'qa_lab_2', approver: 'CLIENT', status: 'pending' });
    const owner = await wrap(h(ChangeActions, { c: pending }), 'server', 'owner');
    expect(btns(owner, '승인')).toEqual([expect.objectContaining({ disabled: false })]);
    const viewer = await wrap(h(ChangeActions, { c: reg({ id: 'qa_lab_3', status: 'pending' }) }), 'server', 'viewer');
    expect(btns(viewer, '승인')).toEqual([expect.objectContaining({ disabled: true, title: expect.stringContaining('읽기 전용') })]);
    // 데모 'PM'은 그대로 CLIENT 건 승인 불가
    const demoPm = await wrap(h(ChangeActions, { c: pending }), 'demo', 'owner');
    expect(btns(demoPm, '승인')).toEqual([expect.objectContaining({ disabled: true })]);
  });

  it('헤더 역할 표시: 서버 모드는 멤버십 역할 이름 · 승인 범위 (데모 3역할 매핑 아님)', async () => {
    setStore([], '담당 AE');
    const View = (await import('./View')).default as ComponentType;
    const v = await wrap(h(View), 'server', 'viewer');
    expect(v).toContain('열람자 · 읽기 전용');
    const o = await wrap(h(View), 'server', 'owner');
    expect(o).toContain('소유자 · 승인 범위 담당 AE · PM · 수면밀도');
  });
});
