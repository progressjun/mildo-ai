/**
 * 화면 스모크 테스트 — 서버 렌더로 View 와 모든 탭이 데모 데이터에서 예외 없이 그려지는지,
 * 핵심 시나리오 문구와 출처 태그가 화면에 나오는지 확인한다. (DOM 없는 node 환경)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest, Incident } from '@/core/types';
import { StoreProvider } from '@/core/store';
import View from './View';
import { useAdPilot } from './useAdPilot';
import { ProposalsTab } from './ProposalsTab';
import { DiagnosisTab } from './DiagnosisTab';
import { DiscoverTab } from './DiscoverTab';
import { VerifyTab } from './VerifyTab';
import { GfaTab } from './GfaTab';
import { HistoryTab } from './HistoryTab';

const at = '2026-10-31T06:00:00.000Z';
const mk = (p: Partial<ChangeRequest>): ChangeRequest => ({
  id: p.id ?? 'x', createdAt: at, module: 'adpilot', kind: 'bid', target: '퀸 매트리스 입찰가', targetId: 'kw_6', before: 1420, after: 1630,
  reason: '테스트', requestedBy: 'PM', approver: 'PM', status: 'pending', history: [{ at, by: 'PM', action: '요청 생성' }], ...p,
});
const seeded: ChangeRequest[] = [
  mk({ id: 'c1' }),
  mk({ id: 'c2', targetId: 'kw_11', target: '허리 편안한 매트리스 입찰가', before: 800, after: 920, status: 'applied', history: [{ at, by: 'PM', action: '요청 생성' }, { at, by: 'PM', action: '승인' }, { at, by: 'PM', action: '반영' }] }),
  mk({ id: 'c3', module: 'gfa', kind: 'budget', targetId: 'gfa:budget:cmp_6', target: 'GFA_Prospecting 일 예산', before: 1_200_000, after: 1_320_000, changePct: 10, approver: 'AE', status: 'held', history: [{ at, by: 'PM', action: '실행 보류', note: '잔액 부족' }] }),
  mk({ id: 'c4', module: 'gfa', kind: 'status', targetId: 'gfa:adgroup:cmp_8:ag_rt_cart', target: 'GFA_리타겟팅 · 장바구니 14일', before: 'on', after: 'off', approver: 'PM', status: 'approved' }),
  mk({ id: 'c5', kind: 'setting', targetId: 'adpilot.cfg.targetRoas', target: 'AD Pilot 기준 · 목표 ROAS', before: 400, after: 450, approver: 'CLIENT', status: 'pending' }),
];

const g = globalThis as unknown as { localStorage?: unknown };
let prev: unknown;
let stored: Record<string, unknown> = { changes: seeded, role: 'PM' };
beforeAll(() => {
  prev = g.localStorage;
  g.localStorage = { getItem: () => JSON.stringify(stored), setItem: () => undefined, removeItem: () => undefined };
});
afterAll(() => { g.localStorage = prev; });

function Harness({ tab }: { tab: string }) {
  const ap = useAdPilot();
  if (tab === 'proposals') return h(ProposalsTab, { ap, filter: 'all', setFilter: () => undefined, onHistory: () => undefined });
  if (tab === 'diagnosis') return h(DiagnosisTab, { ap, onVerify: () => undefined });
  if (tab === 'discover') return h(DiscoverTab, { ap });
  if (tab === 'verify') return h(VerifyTab, { ap, keywordId: 'kw_6', setKeywordId: () => undefined });
  if (tab === 'gfa') return h(GfaTab, { ap });
  return h(HistoryTab, { ap });
}
const render = (node: ReturnType<typeof h>) => renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');

describe('AD Pilot 화면 렌더', () => {
  it('첫 화면: 규칙 카드 · 보류 배너 · 조정 후보 · SAFETY · 출처 태그', () => {
    const html = render(h(View));
    expect(html).toContain('AD Pilot · GFA Control v1');
    expect(html).toContain('SAFETY');
    expect(html).toContain('매트리스 추천');
    expect(html).toContain('자동 조정 보류');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('제안서 p.14');
    expect(html).toContain('SA_일반 제품');
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  });
  for (const tab of ['proposals', 'diagnosis', 'discover', 'verify', 'gfa', 'history']) {
    it(`탭 ${tab} 렌더 (변경 이력 포함 상태)`, () => {
      const html = render(h(Harness, { tab }));
      expect(html.length).toBeGreaterThan(500);
      expect(html).not.toMatch(/>NaN<|>undefined<|\[object Object\]/);
    });
  }
  it('GFA 탭: 다계정 · 위임 범위 · 잔액 부족 · 실행 보류 건', () => {
    const html = render(h(Harness, { tab: 'gfa' }));
    expect(html).toContain('네이버 GFA (수면밀도)');
    expect(html).toContain('DEMO 가정');
    expect(html).toContain('위임 범위는 예시이며 계약 시 확정합니다');
    expect(html).toContain('자동충전 실패');
    expect(html).toContain('실행 보류');
  });
  it('미승인 기준 · 반영 건 롤백 버튼 · 권한 표시', () => {
    const html = render(h(Harness, { tab: 'proposals' }));
    expect(html).toContain('롤백');
    expect(html).toContain('승인 대기');
  });
  it('입찰 하향 0건 사유 + 민감도 보기 카드 (기본 목표 400%)', () => {
    const html = render(h(Harness, { tab: 'proposals' }));
    expect(html).toContain('입찰 하향 규칙 · 현재 기준 0건');
    expect(html).toContain('민감도 보기 · 목표 ROAS 1,050% 가정');
    expect(html).toContain('킹 매트리스 334% · 품절 랜딩 보류');
  });
  it('MILDO Alert 열린 이슈(테스트 Google 급변 · 카카오 추적 단절)가 조정 후보 보류로 연결된다', () => {
    const at2 = '2026-10-31T06:10:00.000Z';
    const mkInc = (p: Partial<Incident> & { holdMedia?: string }): Incident => ({
      id: 'x', ruleId: 'data_spike', severity: 'P2', title: 't', detectedAt: at2, occurredAt: at2, detectPath: 'test', causeCandidates: [], impact: {},
      status: 'open', timeline: [], isTest: true, autoActions: [], ...p,
    }) as Incident;
    const incidents = [
      mkInc({ id: 'data_spike:Google:2026-10-31:test-1', media: 'google', holdMedia: 'google', title: '[테스트] Google 데이터 급변 · 광고비 +85%' }),
      mkInc({ id: 'tracking_break:카카오:2026-10-31', ruleId: 'tracking_break', severity: 'P1', media: 'kakao', holdMedia: 'kakao', title: '카카오 전환 추적 단절 의심 · 13시 이후 전환 0', isTest: false }),
    ];
    const before = stored;
    stored = { ...stored, incidents };
    try {
      const html = render(h(Harness, { tab: 'proposals' }));
      expect(html).toContain('Google · 캠페인');
      expect(html).toContain('data_spike:Google:2026-10-31:test-1');
      expect(html).toContain('Alert 이슈 연계');
      expect(html).toContain('AD Pilot + Alert');
      expect(html).toContain('Alert 이슈 P1');
      expect(html).not.toMatch(/>NaN<|>undefined<|\[object Object\]/);
      const page = render(h(View));
      expect(page).toContain('(MILDO Alert 이슈 기준)');
    } finally {
      stored = before;
    }
  });
});

describe('기능 점검 회귀 — 더블 클릭 방지 잠금', () => {
  it('settledClick: 더블 클릭의 두 번째 클릭(detail 2)은 무시하고, 따로 누른 클릭은 바로 처리 (승인 요청 → 반려 오작동 방지)', async () => {
    const { settledClick } = await import('./parts');
    const hits: string[] = [];
    const request = settledClick(() => hits.push('request'));
    const reject = settledClick(() => hits.push('reject'));
    // 더블 클릭: 첫 클릭(detail 1)은 요청, 같은 자리에 나타난 [반려]에 떨어진 두 번째 클릭(detail 2)은 무시
    request({ detail: 1 }); reject({ detail: 2 });
    expect(hits).toEqual(['request']);
    // 따로 누른 클릭(detail 1) · 키보드 실행(detail 0) · 이벤트 없는 호출은 바로 처리 — 시간 잠금 없음
    reject({ detail: 1 }); reject({ detail: 0 }); reject();
    expect(hits).toEqual(['request', 'reject', 'reject', 'reject']);
  });
});
