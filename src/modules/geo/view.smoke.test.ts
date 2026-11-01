/**
 * 화면 렌더 스모크 테스트 (SSR) — 기본 화면과 모든 탭이 데모 데이터와 빈 데이터에서 예외 없이 렌더되고,
 * 핵심 상태(네 축 · 원칙 문구 · 출처 태그 · 데모 시나리오)가 첫 화면에 보이는지 확인한다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import {
  auditHtml, buildFaqDraft, buildGeoSnapshot, EMPTY_CASE, faqCoverage, paidSurfaceRows, reviewFaq, sampleProductHtml, visibilitySummary,
} from './engine';

beforeAll(() => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const empty: Dataset = {
  generatedAt: '2026-10-31T15:30:00+09:00', today: '2026-10-31', currentHour: 15, dates: [],
  mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
};

async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

describe('SearchTuneOS 화면 렌더', () => {
  it('View: 첫 화면에 네 축 · 원칙 문구 · 출처 태그 · 핵심 지표 · 매트릭스가 보인다', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    expect(html).toContain('SearchTuneOS · GEO');
    for (const s of ['SEO · 구조화 데이터', 'AEO 콘텐츠', 'GEO 모니터링', '페이드 AI 지면']) expect(html).toContain(s);
    expect(html).toContain('노출 순위 보장이 아닌 정기 진단 · 개선 방식으로 운영합니다.');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('제안서 p.29');
    expect(html).toContain('브랜드 언급률');
    expect(html).toContain('네이버 AI 브리핑');
    expect(html).toContain('허리 편한 매트리스 추천');
    expect(html).toContain('Claude 응답 기준 진단이며 다른 엔진은 수집 연동 필요');
    expect(html).toContain('LIVE');
    // AI 미연결(SSR) → 라이브 진단 버튼 비활성 + 이유
    expect(html).toMatch(/disabled=""[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?선택 질의 진단/);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('탭: 제품페이지 진단 · FAQ · 페이드 지면 · 진단 전후가 데모 데이터로 렌더', async () => {
    const { AuditTab } = await import('./AuditTab');
    const { FaqTab } = await import('./FaqTab');
    const { PaidTab } = await import('./PaidTab');
    const { CaseTab } = await import('./CaseTab');
    const { MonitorTab } = await import('./MonitorTab');
    const snap = buildGeoSnapshot(DEMO.today);
    const vis = visibilitySummary(snap);
    const audit = auditHtml(sampleProductHtml(DEMO, 'defect'), DEMO);
    const items = buildFaqDraft(DEMO);
    const reviewed = reviewFaq(items);
    const a = await wrap(h(AuditTab, { d: DEMO, html: sampleProductHtml(DEMO, 'defect'), onHtml: () => undefined, audit, sampleKind: 'defect', onSample: () => undefined }));
    expect(a).toContain('화면 가격 ↔ offers.price');
    expect(a).toContain('킹 판매 데이터 품절');
    expect(a).toContain('통증 완화');
    const f = await wrap(h(FaqTab, { d: DEMO, items, onItems: () => undefined, reviewed, cov: faqCoverage(reviewed, vis), vis }));
    expect(f).toContain('FAQPage');
    expect(f).toContain('킹 옵션 품절');
    expect(f).toContain('AI 초안 생성');
    const p = await wrap(h(PaidTab, { rows: paidSurfaceRows(DEMO, snap), vis }));
    expect(p).toContain('랜딩 점검 우선');
    expect(p).toContain('SA 테스트 그룹 등록 후보');
    expect(p).toContain('등록 요청');
    const c = await wrap(h(CaseTab, { value: EMPTY_CASE, onChange: () => undefined, snap }));
    expect(c).toContain('[브랜드 · 진단 전후 브랜드 언급률 · 인용 수 입력]');
    const m = await wrap(h(MonitorTab, { snap, vis, roundIndex: 3, onRound: () => undefined, live: [], latest: {}, onLive: () => undefined, onClearLive: () => undefined }));
    expect(m).toContain('질의 × 엔진 매트릭스');
    for (const s of [a, f, p, c, m]) expect(s).not.toMatch(/NaN|Infinity/);
  });

  it('빈 데이터 · 빈 스냅샷에서도 예외 없이 렌더', async () => {
    const { AuditTab } = await import('./AuditTab');
    const { PaidTab } = await import('./PaidTab');
    const { MonitorTab } = await import('./MonitorTab');
    const { FaqTab } = await import('./FaqTab');
    const snap = buildGeoSnapshot('bad');
    const vis = visibilitySummary(snap);
    const reviewed = reviewFaq(buildFaqDraft(empty));
    const out = [
      await wrap(h(AuditTab, { d: empty, html: '', onHtml: () => undefined, audit: auditHtml('', empty), sampleKind: 'empty', onSample: () => undefined })),
      await wrap(h(PaidTab, { rows: paidSurfaceRows(empty, buildGeoSnapshot(empty.today)), vis: visibilitySummary(buildGeoSnapshot(empty.today)) })),
      await wrap(h(MonitorTab, { snap, vis, roundIndex: 0, onRound: () => undefined, live: [], latest: {}, onLive: () => undefined, onClearLive: () => undefined })),
      await wrap(h(FaqTab, { d: empty, items: buildFaqDraft(empty), onItems: () => undefined, reviewed, cov: faqCoverage(reviewed, vis), vis })),
    ];
    expect(out[0]).toContain('입력 필요');
    expect(out[2]).toContain('진단 스냅샷이 없습니다');
    for (const s of out) expect(s).not.toMatch(/NaN|Infinity/);
  });
});
