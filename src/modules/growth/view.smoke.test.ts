/**
 * 화면 렌더 스모크 테스트 (SSR) — 모든 탭이 데모 데이터와 빈 데이터에서 예외 없이 렌더되고,
 * 데모 시나리오 · 출처 태그 · 판정 기준이 화면에 실제로 나타나는지 확인한다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import { fmt } from '@/core/util';
import { allocationModel, daSaAnalysis, funnelDiagnosis, growthSignals } from './engine';

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
const clean = (html: string) => {
  expect(html).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
  // HTML id에는 공백이 들어갈 수 없다 (label htmlFor 연결)
  expect(html).not.toMatch(/\sid="[^"]*\s[^"]*"/);
};

describe('매출 성장 화면 렌더', () => {
  it('View: 첫 화면(성장 공식 · 과제)에 핵심 상태가 보인다', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    expect(html).toContain('04 REVENUE GROWTH');
    expect(html).toContain('매출 성장 고도화');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('제안서 p.30–42');
    expect(html).toContain('성장 공식');
    expect(html).toContain('한계 ROAS 격차');
    expect(html).toContain('우선 개선 · 자사몰 장바구니 → 구매');
    expect(html).toContain('오늘 일 예산 조기 소진 예상 4개 캠페인');
    expect(html).toContain('20:22'); // SA_일반 제품 예상 마감 — Board · AD Pilot과 같은 값
    expect(html).toContain('킹 매트리스');
    expect(html).toContain('43% · 21.5억');
    clean(html);
  });

  it('각 탭: 데모 데이터', async () => {
    const View = (await import('./View')).default as ComponentType<{ initialTab?: string }>;
    const expectations: Record<string, string[]> = {
      target: ['구매 의도별 타겟 그룹', '건강 상태를 추정해 개인을 타겟팅하지 않고', '51%', '36%', '브랜드 방어', '확대 여지', '목표 ROAS', '48', '리뷰 · 비교', '확대 여지 키워드', '퀸 매트리스'],
      alloc: ['한계 효율 재배분 시뮬레이터', '예측이 아닌 시나리오', '미식별', '사전 가정', '균등화안 승인 요청', '가드레일', '볼륨 한계', '43% · 21.5억', '예산 제약 신호', 'Meta_넓은 타겟', '증액 보류 · 광고비 급변', 'SA_일반 제품', '증액 후보', '증액 보류 · 계정 · 결제', '증액 보류 · CPC 급등', '18:06', '20:22', '피크 전'],
      dasa: ['METHOD 1', 'METHOD 2', 'METHOD 3', '최적 시차', '홀드아웃', '데모 가정', 'METHOD 1 추정', '상한 성격의 추정'],
      funnel: ['네이버 브랜드스토어 퍼널', '자사몰 퍼널', '우선 개선', 'CRM 연계 검토', '품절 옵션 랜딩', '잠식 신호 없음', '합산 매출', '이탈 ', '기준 내'],
      demand: ['채널 선정 기준', '파일럿 계산기', fmt.krw(250_000_000), '62건', '코프로모션', '고객 데이터 공유 없음', '기준 ROAS 달성 전환', '남은 한도'],
      partner: ['줄인 시간 → 성장 실험 재투입', '데이터 요청', '프로모션별 리포트 자동 생성', '1,070 → 435분', '매체 협력으로 최선의 구좌 확보', '입력 필요', '네이버 3자 협업 체계', '2027 Q1', 'D-62', '협업 제안 가안이며 확정 일정이 아닙니다'],
    };
    for (const [tab, words] of Object.entries(expectations)) {
      const html = await wrap(h(View, { initialTab: tab }));
      for (const w of words) expect(html, `${tab}: ${w}`).toContain(w);
      clean(html);
    }
  });

  it('각 탭: 빈 데이터에서도 예외 없음', async () => {
    const { OverviewTab } = await import('./OverviewTab');
    const { TargetTab } = await import('./TargetTab');
    const { AllocationTab } = await import('./AllocationTab');
    const { DaSaTab } = await import('./DaSaTab');
    const { FunnelTab } = await import('./FunnelTab');
    const { DemandTab } = await import('./DemandTab');
    const { PartnerTab } = await import('./PartnerTab');
    const model = allocationModel(empty);
    const nodes = [
      h(OverviewTab, { d: empty, model, signals: growthSignals(empty, model), onGo: () => undefined }), h(TargetTab, { d: empty }), h(AllocationTab, { d: empty }),
      h(DaSaTab, { d: empty, ds: daSaAnalysis(empty), onApplyCredit: () => undefined }), h(FunnelTab, { d: empty, f: funnelDiagnosis(empty) }),
      h(DemandTab, { d: empty, marginalRoas: NaN }), h(PartnerTab, { d: empty }),
    ];
    for (const n of nodes) {
      const html = await wrap(n);
      expect(html.length).toBeGreaterThan(80);
      clean(html);
    }
  });

  it('DA→SA 기여 반영 시뮬레이터 · 직접 입력 b 경로도 렌더', async () => {
    const { AllocationTab } = await import('./AllocationTab');
    const html = await wrap(h(AllocationTab, { d: DEMO, initialCredit: true }));
    expect(html).toContain('DA→SA 기여 반영');
    expect(html).toContain('SA 경유 매출');
    clean(html);
  });
});
