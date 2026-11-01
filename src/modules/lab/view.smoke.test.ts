/**
 * 화면 렌더 스모크 테스트 (SSR) — View와 모든 탭이 예외 · NaN 없이 렌더되고, 시연 상태(판정 · 검수 · 48 진입점)가 첫 화면에 보이는지 확인.
 * 다른 모듈에서 들어온 테스트 요청 · 등록 요청 · 판정 반영 요청이 있는 상태도 함께 렌더한다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';

const changes: Partial<ChangeRequest>[] = [
  {
    // watch/engine.ts testChangePayload 형태 (module 'watch' · kind 'test')
    id: 'chg_w1', createdAt: '2026-10-31T05:00:00.000Z', module: 'watch', kind: 'test', target: '네이버 GFA · 잠재고객 확장(Beta) 소재 테스트', targetId: 'ev_3',
    before: '실행안 (주간 리포트)', after: '소액 테스트 14일 · 일 30만원', reason: 'MILDO Watch 감지 → 영향 진단. 가설: 리뷰 신뢰 소재를 쓰면 신규 고객 CTR이 오른다.',
    requestedBy: 'PM', approver: 'PM', status: 'pending', history: [],
  },
  {
    // growth/engine.ts pilotChange 형태 — after가 숫자(원)
    id: 'chg_g1', createdAt: '2026-10-31T04:00:00.000Z', module: 'growth', kind: 'test', target: '신규 매체 파일럿 · 지역 커뮤니티 · 당근 · 4주', targetId: 'growth-pilot:당근',
    before: '미집행', after: 250_000_000, reason: '증분 매출 기준으로 확대 또는 중단', requestedBy: 'PM', approver: 'CLIENT', status: 'pending', history: [],
  },
  {
    id: 'chg_r1', createdAt: '2026-10-31T05:10:00.000Z', module: 'lab', kind: 'keyword_add', target: '매트리스 경도 고르는 법', targetId: 'labreg:매트리스경도고르는법',
    before: '미등록', after: 'PROBLEM_TEST · 입찰 상한 900원', reason: '검색어 보고서', requestedBy: 'PM', approver: 'AE', status: 'approved', history: [],
  },
  {
    id: 'chg_r2', createdAt: '2026-10-31T05:20:00.000Z', module: 'lab', kind: 'keyword_add', target: '독립스프링 vs 포켓스프링', targetId: 'labreg:독립스프링vs포켓스프링',
    before: '미등록', after: 'COMPARE_TEST · 입찰 상한 1,300원', reason: '검색어 보고서', requestedBy: 'PM', approver: 'PM', status: 'pending', history: [],
  },
];

beforeAll(() => {
  const mem: Record<string, string> = { 'mildo-os/v1': JSON.stringify({ changes, incidents: [], role: 'PM' }) };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const clean = (html: string) => {
  expect(html).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
};

async function renderTab(name: string, extra: Record<string, unknown> = {}) {
  const { StoreProvider } = await import('@/core/store');
  const { useLabModel } = await import('./parts');
  const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
    DiscoverTab: () => import('./DiscoverTab'), PipelineTab: () => import('./PipelineTab'), CardsTab: () => import('./CardsTab'),
    CreativeTab: () => import('./CreativeTab'), ReviewTab: () => import('./ReviewTab'), LoopTab: () => import('./LoopTab'),
  };
  const Comp = (await loaders[name]())[name] as ComponentType<Record<string, unknown>>;
  function Harness() {
    const m = useLabModel();
    return h(Comp, { m, draft: null, onMakeCard: () => undefined, onOpenCards: () => undefined, ...extra });
  }
  return renderToString(h(StoreProvider, null, h(Harness))).replace(/<!-- -->/g, '');
}

describe('MILDO Lab 화면 렌더', () => {
  it('기본 화면(View) — 요약 타일 · 오늘 처리할 항목 · 48 진입점 그리드 · TEST DATA', async () => {
    const { StoreProvider } = await import('@/core/store');
    const View = (await import('./View')).default;
    const html = renderToString(h(StoreProvider, null, h(View))).replace(/<!-- -->/g, '');
    expect(html).toContain('MILDO Lab');
    expect(html).toContain('오늘 처리할 항목');
    expect(html).toContain('검색 진입점 48개');
    expect(html).toContain('제품 1 × 문제 4 × 상황 4 × 비교 3');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('제안서 p.23');
    expect(html).toContain('검수 차단 문안');
    expect(html).toContain('중단 결정 필요');
    clean(html);
  });

  it('발굴 탭 — 소스 3개 + SKU 48 + AI 확장 버튼(미연결 시 비활성)', async () => {
    const html = await renderTab('DiscoverTab');
    for (const s of ['검색어 보고서', '연관 검색어', 'AI 검색 질의', 'SKU 확장 48', 'AI로 구문형 후보 확장']) expect(html).toContain(s);
    expect(html).toMatch(/우선 · ≥ 70/);
    clean(html);
  });

  it('파이프라인 탭 — STEP 1~4 칸반 · 판정 배지 기준 병기 · 등록 요청 반영', async () => {
    const html = await renderTab('PipelineTab');
    for (const s of ['STEP 1', 'STEP 2', 'STEP 3', 'STEP 4', '판정 보류 · 표본 부족', '목표 ROAS 400% 대비', '판정 기준값', '매트리스 경도 고르는 법', '연관 키워드 추가 발굴']) expect(html).toContain(s);
    clean(html);
  });

  it('테스트 카드 탭 — z-검정 p-value · 중단 · 확대 · 이긴 패턴 · 수신 요청', async () => {
    const html = await renderTab('CardsTab');
    for (const s of ['TC-01', 'TC-02', 'TC-03', '두 비율 z-검정', '이긴 패턴 라이브러리', '다른 모듈 테스트 요청', '잠재고객 확장(Beta)', 'MILDO Watch 열기', '매출 성장 열기', '미집행 → 2.5억원']) expect(html).toContain(s);
    expect(html).not.toContain('250000000');
    expect(html).toMatch(/p[=&lt;]+0?\.\d+|p&lt;0\.001/);
    clean(html);
  });

  it('테스트 카드 탭 — 초안이 있으면 생성 폼이 열린 상태', async () => {
    const html = await renderTab('CardsTab', { draft: { title: '초안 카드', hypothesis: '리뷰 신뢰 소재를 쓰면 CTR이 오른다', variable: '메시지', media: '네이버 SA', intent: 'life', control: '경도 · 소재 · 구조로 고르는 매트리스', variant: '허리 통증 완화 매트리스', primary: 'ctr' } });
    expect(html).toContain('초안 카드');
    expect(html).toContain('변형안 문안 (자동 검수)');
    expect(html).toContain('차단');
    clean(html);
  });

  it('VisualTune 탭 — 가설 A · B · C · 문안 생성기 글자수', async () => {
    const html = await renderTab('CreativeTab');
    for (const s of ['경도 · 소재 · 구조로 고르는 매트리스', '누적 리뷰 6만 개가 고른 매트리스', '전국 무료배송 · 전문 기사 설치', '/15자', '/45자', '한 번에 한 변수']) expect(html).toContain(s);
    clean(html);
  });

  it('검수 탭 — 자유 입력 · 차단/경고/확인 · 수정 제안 · 가격 대조 기준', async () => {
    const html = await renderTab('ReviewTab');
    for (const s of ['자유 입력 검수', '차단', '경고', '확인', '수정 제안', '가격 대조 기준', '품절']) expect(html).toContain(s);
    clean(html);
  });

  it('운영 루프 탭 — 주간 · 월간 · 분기 · 액션 후 2주 · 수시 + 주간 브리프 초안', async () => {
    const html = await renderTab('LoopTab');
    for (const s of ['주간', '월간', '분기', '액션 후 2주', '수시', '주간 인사이트 브리프 초안', '확정 팩트']) expect(html).toContain(s);
    clean(html);
  });
});
