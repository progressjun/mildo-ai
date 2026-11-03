/**
 * QA 회귀 (G3b · 성과 증명) — 판정 보류 문구 · −0.0배 · TEST DATA 예시의 워크스페이스 설정 · 리포트 발송 안내 문구.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import {
  automationSavings, buildDemoImpact, buildSummary, buildValueReport, impactConfig, krw, paybackSourceReading, paybackText, times, type LedgerEntry,
} from './engine';
import type { ToolContext } from '../types';
import { impactBrief } from './agent';
import { _resetImpactSnapshotForTest, setImpactSnapshot } from './live';

beforeAll(() => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const empty = () => buildSummary([], impactConfig(null), '2026-10', { generatedAt: '2026-11-03T00:00:00.000Z', dataMode: 'demo' });

describe('판정 보류 — 회수 배수를 계산하지 않음', () => {
  it('가치 리포트: 메신저 · 머리글 · 산식 대입이 0.0배가 아니라 계산하지 않음, AI 해석은 측정 증분이 대부분이라고 하지 않는다', () => {
    const s = empty();
    expect(s.verdict.label).toBe('판정 보류');
    expect(s.formulaFilled).toMatch(/= 계산하지 않음 \(판정 보류\)$/);
    expect(s.formulaFilled).not.toMatch(/0\.0배/);
    const v = buildValueReport(s, [], { brand: '수면밀도' });
    expect(v.messenger.split('\n')[0]).toBe('[MILDO 가치] 2026년 10월 회수 배수 — (계산하지 않음) · 판정 보류 · TEST DATA');
    expect(v.markdown).toContain('**회수 배수 —** (계산하지 않음)');
    expect(v.markdown).not.toContain('회수의 대부분이 측정된 증분');
    expect(v.markdown).toContain('이 달에 측정 · 추정된 항목이 없어 회수 근거를 해석하지 않는다');
    expect(v.markdown).not.toMatch(/0\.0배/);
    expect(paybackText(s)).toEqual({ point: '—', range: '계산하지 않음' });
  });

  it('판정이 있으면 기존 표기 · 측정 증분이 0원 이하인데 대부분이라고 하지 않는다', () => {
    // 자동화만 있는 달: 측정 증분 0원 · 절감 시간만 양수 → '추정 · 가정에서 나온다'
    const auto: LedgerEntry[] = automationSavings({ ingest_days: 20, daily_reports: 20, weekly_reports: 4, bid_budget_changes: 6, keyword_changes: 0, detection_days: 20 }, 20).rows.map((row, i) => ({
      id: `a${i}`, sourceType: 'automation', sourceId: `2026-10:${row.unit}`, label: row.task, occurredAt: '2026-09-30T15:00:00.000Z', month: '2026-10', windowDays: 0,
      status: 'measured', baseline: null, observed: null, control: null, estimate: row, detail: {}, measuredAt: null,
    }));
    const s = buildSummary(auto, impactConfig(null), '2026-10', { dataMode: 'live' });
    expect(s.verdict.tone).not.toBe('neutral');
    expect(paybackSourceReading(s)).toMatch(/추정\(손실 회피\) · 가정/);
    expect(s.formulaFilled).toMatch(/= \d+\.\d배$/);
    const v = buildValueReport(s, auto, { brand: '수면밀도' });
    expect(v.messenger).toMatch(/회수 배수 \d+\.\d배 \(80% /);
    // 구성 합 0원(측정 0건이지만 자동화 행 0건 측정) → 출처를 나눠 해석하지 않음
    const zero = buildSummary(auto.map((e) => ({ ...e, estimate: { ...(e.estimate as object), count: 0, minutes: 0, hours: 0 } as never })), impactConfig(null), '2026-10', { dataMode: 'live' });
    if (zero.verdict.tone !== 'neutral') expect(paybackSourceReading(zero)).toMatch(/구성 요소 합이 0원이라/);
  });

  it('에이전트 브리프도 같은 규칙 (판정 보류 → 계산하지 않음 · 대부분이라고 하지 않음)', () => {
    setImpactSnapshot('ws-1', { summary: empty(), entries: [] });
    try {
      const b = impactBrief({ state: { data: DEMO, incidents: [] } } as unknown as ToolContext);
      const text = b.interpretation.join('\n');
      expect(text).toContain('회수 배수는 계산하지 않음');
      expect(text).not.toMatch(/0\.0배/);
      expect(text).not.toContain('대조군으로 측정한 증분에서 나와');
      expect(text).not.toContain('회수의 대부분');
    } finally {
      _resetImpactSnapshotForTest();
    }
  });
});

describe('음수 0 표기', () => {
  it("반올림하면 0인 음수는 '−'를 붙이지 않는다", () => {
    expect(times(-0.001)).toBe('0.0배');
    expect(times(-0.04)).toBe('0.0배');
    expect(times(-0.06)).toBe('−0.1배');
    expect(times(5.3)).toBe('5.3배');
    expect(krw(-0.3)).toBe('0원');
    expect(krw(-12_000)).toBe('−1만원');
  });
});

describe('TEST DATA 예시 — 워크스페이스 설정(월 구독료 · 공헌이익률 · 시간당 인건비)', () => {
  it('exampleConfigOf: 서버 요약의 설정을 쓰고, 요약 전에는 워크스페이스 config에서 읽는다', async () => {
    const { exampleConfigOf } = await import('./View');
    const server = buildSummary([], impactConfig({ billing: { monthlyFee: 6_000_000 }, impact: { contributionMargin: 0.35, hourlyCost: 50_000 } }), '2026-11');
    expect(exampleConfigOf(server, null)).toMatchObject({ monthlyFee: 6_000_000, margin: 0.35, hourlyCost: 50_000, sources: { monthlyFee: 'workspace' } });
    expect(exampleConfigOf(null, { billing: { monthlyFee: 6_000_000 } })).toMatchObject({ monthlyFee: 6_000_000, sources: { monthlyFee: 'workspace', margin: 'default' } });
    expect(exampleConfigOf(null, null)).toMatchObject({ monthlyFee: 5_000_000, sources: { monthlyFee: 'default' } });
    const ex = buildDemoImpact(DEMO, [], exampleConfigOf(server, null));
    expect(ex.summary.totals.costOfSubscription).toBe(6_000_000);
    expect(ex.summary.conditions[0]).toBe('월 구독료 6,000,000원 (워크스페이스 설정)');
  });

  it('useImpactData(서버 모드): 예시를 워크스페이스 구독료로 계산 (요약을 읽기 전 첫 렌더)', async () => {
    const { useImpactData } = await import('./View');
    const { StoreProvider } = await import('@/core/store');
    let fee = 0, src = '';
    function Probe() {
      const d = useImpactData('00000000-0000-4000-8000-0000000000aa', '2026-11', { billing: { monthlyFee: 6_000_000 } });
      fee = d.example?.summary.totals.costOfSubscription ?? 0;
      src = d.example?.summary.config.sources.monthlyFee ?? '';
      return null;
    }
    renderToString(h(StoreProvider, null, h(Probe)));
    expect(fee).toBe(6_000_000);
    expect(src).toBe('workspace');
  });

  it('데모 모드(서버 없음)는 그대로 기본값 예시', async () => {
    const { useImpactData } = await import('./View');
    const { StoreProvider } = await import('@/core/store');
    let fee = 0, demo = false;
    function Probe() {
      const d = useImpactData(null, '2026-11', { billing: { monthlyFee: 6_000_000 } });
      fee = d.summary.totals.costOfSubscription;
      demo = d.demo;
      return null;
    }
    renderToString(h(StoreProvider, null, h(Probe)));
    expect(demo).toBe(true);
    expect(fee).toBe(5_000_000);
  });
});

describe('리포트 발송 안내 (deliveryToastOf)', () => {
  it("대기열에 넣기만 했으면 '보냈습니다'가 아니라 발송 대기열 · 보내지 않음이 섞이면 주의", async () => {
    const { deliveryToastOf } = await import('./View');
    const q = deliveryToastOf([{ status: 'queued', channelName: 'QA 메일', reason: null }]);
    expect(q.title).toBe('1개 채널 발송 대기열에 넣었습니다 — 결과는 보관함에 표시됩니다');
    expect(q.title).not.toContain('보냈습니다');
    expect(q.tone).toBe('info');
    expect(q.body).toBe('QA 메일 발송 대기');
    const sk = deliveryToastOf([{ status: 'skipped', channelName: 'QA 메일', reason: '서버 SMTP가 설정되지 않아 메일을 보내지 않았습니다 (SMTP_HOST)' }]);
    expect(sk).toMatchObject({ tone: 'warning', title: '보낸 채널이 없습니다' });
    expect(sk.body).toContain('SMTP_HOST');
    const mix = deliveryToastOf([{ status: 'sent', channelName: 'Slack', reason: null }, { status: 'queued', channelName: '웹훅', reason: null }, { status: 'skipped', channelName: '메일', reason: 'SMTP' }]);
    expect(mix.title).toBe('1개 채널로 보냈습니다 · 1개 채널 발송 대기');
    expect(mix.tone).toBe('warning');
    expect(deliveryToastOf([{ status: 'sent', channelName: 'Slack', reason: null }]).tone).toBe('good');
  });
});
