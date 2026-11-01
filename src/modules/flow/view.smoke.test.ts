/**
 * MILDO Flow 화면 렌더 스모크 테스트 (SSR) — 기본 화면과 모든 탭 · 상세 드로어가 시연 이력 · 빈 이력 · 대량 변경 상황에서
 * 예외 없이 렌더되고, 첫 화면에 의미 있는 상태(내가 처리할 것 · 상태별 보드 · 출처 태그 · 대량 변경 감시)가 보이는지 확인한다.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest, Incident } from '@/core/types';
import { DEMO } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import { EMPTY_DRAFT, seedChanges, type RequestDraft } from './engine';
import { REQUEST_TYPES } from './data';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const INCIDENTS: Incident[] = detectIncidents(DEMO);
const SEEDS = seedChanges(DEMO);
function setStore(changes: ChangeRequest[], incidents: Incident[] = INCIDENTS, role: '담당 AE' | 'PM' | '수면밀도' = 'PM') {
  mem['mildo-os/v1'] = JSON.stringify({ changes, incidents, comments: [], ai: { mode: 'offline' }, role, tf: {} });
}
async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

type Which = 'board' | 'timeline' | 'promo' | 'report' | 'request' | 'system' | 'drawer';
async function harness(which: Which, arg?: string, draft?: RequestDraft): Promise<ComponentType> {
  const { useFlow } = await import('./useFlow');
  const { BoardTab } = await import('./BoardTab');
  const { TimelineTab } = await import('./TimelineTab');
  const { PromoCheckTab } = await import('./PromoCheckTab');
  const { PromoReportTab } = await import('./PromoReportTab');
  const { RequestTab } = await import('./RequestTab');
  const { SystemTab } = await import('./SystemTab');
  const { ChangeDrawer } = await import('./ChangeDrawer');
  const noop = () => undefined;
  return function Harness() {
    const ctx = useFlow();
    switch (which) {
      case 'board': return h(BoardTab, { ctx, onOpen: noop, onNew: noop });
      case 'timeline': return h(TimelineTab, { ctx, onOpen: noop, onDraft: noop });
      case 'promo': return h(PromoCheckTab, { ctx, onOpen: noop, onReport: noop });
      case 'report': return h(PromoReportTab, { ctx, promoId: arg ?? '', onPromo: noop });
      case 'request': return h(RequestTab, { ctx, draft: draft ?? EMPTY_DRAFT, setDraft: noop, onCreated: noop });
      case 'system': return h(SystemTab, { ctx, onTab: noop });
      case 'drawer': return h(ChangeDrawer, { ctx, id: arg ?? '', onClose: noop });
    }
  };
}

describe('MILDO Flow 화면 렌더', () => {
  it('View: 역할 선택 · 내가 처리할 것 · 상태별 보드 · 출처 태그 · 대량 변경 감시가 첫 화면에 보인다', async () => {
    setStore(SEEDS);
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    expect(html).toContain('MILDO Flow');
    for (const s of ['현재 역할', '내가 처리할 것', '요청 · 승인 · 반영 이력', '승인 대기', '반영', '반려', '롤백', '보류', 'TEST DATA', '제안서 p.53', '대량 변경 감시']) expect(html).toContain(s);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('모든 탭이 시연 이력 · 빈 이력에서 렌더된다', async () => {
    for (const changes of [SEEDS, [] as ChangeRequest[]]) {
      setStore(changes, changes.length ? INCIDENTS : []);
      for (const w of ['board', 'timeline', 'promo', 'system'] as const) {
        const html = await wrap(h(await harness(w)));
        expect(html.length, w).toBeGreaterThan(200);
        expect(html, w).not.toMatch(/NaN|Infinity/);
      }
      for (const p of DEMO.promotions) {
        const html = await wrap(h(await harness('report', p.id)));
        expect(html).toContain(p.name);
        expect(html).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('프로모션 점검 · 운영 타임라인: 데모 시나리오가 화면에 보인다', async () => {
    setStore(SEEDS);
    const promo = await wrap(h(await harness('promo')));
    expect(promo).toContain('킹 매트리스');
    expect(promo).toContain('1일치 미만');
    expect(promo).toContain('실패 0건 = 오픈 가능');
    const tl = await wrap(h(await harness('timeline')));
    for (const s of ['감지', '배정', '조치', '보고', '전환 추적 단절']) expect(tl).toContain(s);
  });

  it('신규 요청 폼: 요청 유형마다 승인 주체 미리보기가 렌더된다', async () => {
    setStore(SEEDS);
    const sa = DEMO.campaigns.find((c) => c.name === 'SA_일반 제품')!;
    for (const t of REQUEST_TYPES) {
      const d: RequestDraft = { ...EMPTY_DRAFT, type: t.id, targetId: t.id === 'budget' ? sa.id : '', reason: '시연용 요청 사유 확인' };
      const html = await wrap(h(await harness('request', undefined, d)));
      expect(html, t.id).toContain('승인 주체 자동 결정');
      expect(html, t.id).not.toMatch(/NaN|Infinity/);
    }
  });

  it('상세 드로어: 시연 이력 전부 렌더 · 위임 근거 · 실행 점검', async () => {
    setStore(SEEDS);
    for (const c of SEEDS) {
      const html = await wrap(h(await harness('drawer', c.id)));
      expect(html, c.id).toContain('이력 · 누가 · 언제 · 왜');
      expect(html, c.id).not.toMatch(/NaN|Infinity/);
    }
    const sa = SEEDS.find((c) => c.target.startsWith('SA_일반 제품'))!;
    expect(await wrap(h(await harness('drawer', sa.id)))).toContain('p.15 위임 범위');
    expect(await wrap(h(await harness('drawer', 'missing')))).toContain('요청을 찾지 못했습니다');
  });

  it('대량 변경 상황: 이력 화면 경고 · 관련 카드 표시 (MILDO Alert detectBulkChange)', async () => {
    const burst: ChangeRequest[] = Array.from({ length: 10 }, (_, k) => ({
      id: `burst_${k}`, createdAt: `2026-10-31T14:${String(k).padStart(2, '0')}:00+09:00`, module: 'adpilot', kind: 'bid', target: `일괄 키워드 ${k}`, targetId: `kw_${k + 1}`,
      before: 1000, after: 1050, changePct: 5, reason: '일괄 변경 테스트', requestedBy: 'AD Pilot', approver: 'AE', status: 'pending',
      history: [{ at: `2026-10-31T14:${String(k).padStart(2, '0')}:00+09:00`, by: 'AD Pilot', action: '요청 생성' }],
    }));
    setStore([...SEEDS, ...burst]);
    const html = await wrap(h(await harness('board')));
    expect(html).toContain('대량 변경 실수 감지 1건');
    expect(html).toContain('기준 ≥ 10건');
    expect(html).toContain('대량 변경');
    const d = await wrap(h(await harness('drawer', 'burst_0')));
    expect(d).toContain('대량 변경 실수 감지 대상');
  });
});

describe('기능 점검 회귀 — 더블 클릭 방지 잠금', () => {
  it('settled: 첫 클릭 직후 SETTLE_MS 동안 다른 처리 클릭(다른 행으로 밀려 온 버튼 포함)은 무시', async () => {
    const { settled, SETTLE_MS } = await import('./parts');
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const hits: string[] = [];
    const a = settled(() => hits.push('a'));
    const b = settled(() => hits.push('b'));
    a(); now += 80; b(); now += 80; a();
    expect(hits).toEqual(['a']);
    now += SETTLE_MS; b();
    expect(hits).toEqual(['a', 'b']);
    spy.mockRestore();
  });
});
