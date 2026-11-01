/**
 * 화면 렌더 스모크 테스트 (SSR) — 기본 화면과 모든 탭이 예외 · NaN · React 경고 없이 렌더되는지 확인.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});
afterEach(() => vi.restoreAllMocks());

async function renderTab(name: string, seed?: Record<string, unknown>) {
  if (seed) mem['mildo-os/ops-v1'] = JSON.stringify(seed);
  const { StoreProvider } = await import('@/core/store');
  const { useOpsLocal, useOpsModel } = await import('./useOps');
  const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
    TfTab: () => import('./TfTab'), StructureTab: () => import('./StructureTab'), OnboardingTab: () => import('./OnboardingTab'),
    CompanyTab: () => import('./CompanyTab'), ContractTab: () => import('./ContractTab'), CoverageTab: () => import('./CoverageTab'),
  };
  const Tab = (await loaders[name]())[name] as ComponentType<Record<string, unknown>>;
  function Harness() {
    const { local, patch } = useOpsLocal();
    const model = useOpsModel(local);
    const s = model.summary;
    return h(Tab, { model, local, patch, goTab: () => undefined, rows: s.refRows, check: s.refs, fee: s.fee, contract: s.contract });
  }
  return renderToString(h(StoreProvider, null, h(Harness)));
}

describe('전담 TF · 온보딩 · 계약 화면 렌더', () => {
  it('기본 화면(View) — 제출 준비 스트립 · TF 탭', async () => {
    const err = vi.spyOn(console, 'error');
    const { StoreProvider } = await import('@/core/store');
    const View = (await import('./View')).default;
    const html = renderToString(h(StoreProvider, null, h(View)));
    expect(html).toContain('전담 TF · 온보딩 · 계약');
    expect(html).toContain('D-16');
    expect(html).toContain('미입력 21칸');
    expect(html).toContain('1:1 백업 그래프');
    expect(html).toContain('과부하');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(err).not.toHaveBeenCalled();
  });
  it.each(['TfTab', 'StructureTab', 'OnboardingTab', 'CompanyTab', 'ContractTab', 'CoverageTab'])('%s', async (name) => {
    const err = vi.spyOn(console, 'error');
    const html = await renderTab(name);
    expect(html.length).toBeGreaterThan(1500);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('Infinity');
    expect(err).not.toHaveBeenCalled();
  });
  it('입력 칸은 id를 가진 제어 컴포넌트 · 온보딩 마일스톤 실제 주차 표시', async () => {
    const tf = await renderTab('TfTab');
    for (const id of ['ops-tf-pm-name', 'ops-tf-dev-years', 'ops-tf-sa_ae-alloc', 'ops-tf-pm-backup', 'ops-leave-sa_ae', 'ops-leave-start']) expect(tf, id).toContain(`id="${id}"`);
    const ids = [...tf.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const ob = (await renderTab('OnboardingTab')).replace(/<!-- -->/g, '');
    expect(ob).toContain('장표 W4 · 실제 W5');
    expect(ob).toContain('W12 종료 후');
    const ct = await renderTab('ContractTab');
    expect(ct).toContain('id="ops-fee-0-rate"');
    expect(ct).toContain('SA 43% · GFA 18%');
  });
  it('계정 구조 탭: 데모 시나리오(GFA 결제 · Google 비실명 · 오늘의집 검수) 표시', async () => {
    const html = await renderTab('StructureTab');
    expect(html).toContain('agency-shared@');
    expect(html).toContain('자동충전 실패');
    expect(html).toContain('검수 · 확인 필요');
  });
  it('입력값이 있는 상태 (수수료 · 계약 · 레퍼런스 · Kick-off)', async () => {
    const seed = {
      kickoff: '2026-10-20',
      fees: { '네이버 SA · DA': { fee: '10', payback: 'yes', paybackPct: '2' }, 카카오: { fee: '12', payback: 'no' }, 구글: { fee: 'x' } },
      contract: { terminationDays: '30', solutionFee: 'separate', solutionMonthly: '5000000' },
      refs: { cozyma: { monthly: '월 약 2억 원' } },
      backupOverrides: { dev: '' },
      docs: { deck: true },
    };
    for (const name of ['ContractTab', 'CompanyTab', 'OnboardingTab', 'TfTab', 'CoverageTab']) {
      const err = vi.spyOn(console, 'error');
      const html = await renderTab(name, seed);
      expect(html, name).not.toContain('NaN');
      expect(html, name).not.toContain('undefined');
      expect(err, name).not.toHaveBeenCalled();
      err.mockRestore();
    }
    const tf = await renderTab('TfTab', seed);
    expect(tf).toMatch(/백업 공백 (<!-- -->)?1/);
    const ob = await renderTab('OnboardingTab', seed);
    expect(ob).toContain('현재 W2');
    const ct = (await renderTab('ContractTab', seed)).replace(/<!-- -->/g, '');
    expect(ct).toContain('미입력 2 · 오입력 1');
  });
});
