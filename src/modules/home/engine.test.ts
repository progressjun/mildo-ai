import { describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import { buildTimetable } from '@/modules/reports/engine';
import { homeTimetable, scenarioBudget, scenarioPending, scenarioRequests, untilLabel } from './engine';
import type { ChangeRequest } from '@/core/types';

describe('커맨드 센터 시간표 — 리포트 · 데이터 시간표 화면과 같은 계산', () => {
  it('토요일(10/31) 이슈 브리핑은 완료가 아니라 다음 영업일 09:30으로 이동', () => {
    const t = homeTimetable(DEMO);
    expect(t.off).toBe(true);
    const brief = t.items.find((i) => i.time === '09:30')!;
    expect(brief.state).not.toBe('done');
    expect(brief.label).toContain('09:30');
    expect(brief.offNote).toBeTruthy();
    const rt = buildTimetable(DEMO, {});
    for (const i of t.items) {
      const r = rt.items.find((x) => x.time === i.time)!;
      expect(i.state === 'done').toBe(r.status === 'done');
    }
  });
  it('남은 시간 문구', () => {
    expect(untilLabel(60)).toBe('1시간 후');
    expect(untilLabel(45)).toBe('45분 후');
    expect(untilLabel(65)).toBe('1시간 5분 후');
    expect(untilLabel(0)).toBe('곧');
    expect(untilLabel(NaN)).toBe('곧');
  });
});

describe('p.23 작동 시나리오 승인 요청', () => {
  it('GFA 예산 +12%: 표시 변경 폭과 금액이 일치 · 위임 범위 PM', () => {
    const b = scenarioBudget(800000);
    expect(b.after).toBe(896000);
    expect(b.changePct).toBe(12);
    expect(b.approver).toBe('PM');
    expect(scenarioBudget(0).changePct).toBe(0);
  });
  it('요청 2건: Lab keyword_add(담당 AE) · GFA budget(PM)', () => {
    const r = scenarioRequests(DEMO);
    expect(r.map((x) => `${x.module}:${x.kind}:${x.approver}`)).toEqual(['lab:keyword_add:AE', 'gfa:budget:PM']);
    const gfa = r[1];
    expect(Math.round(((Number(gfa.after) - Number(gfa.before)) / Number(gfa.before)) * 1000) / 10).toBe(gfa.changePct);
  });
  it('승인 대기 중이면 다시 만들지 않는다', () => {
    const mk = (status: ChangeRequest['status']) => ({ ...scenarioRequests(DEMO)[0], id: 'x', createdAt: '', history: [], status }) as ChangeRequest;
    expect(scenarioPending([])).toBe(false);
    expect(scenarioPending([mk('pending')])).toBe(true);
    expect(scenarioPending([mk('approved')])).toBe(false);
  });
});

describe('KPI 증감 근거 (QA 회귀 — 출처 없음에서 0.0%를 내지 않는다)', () => {
  it('데이터 출처가 하나도 없으면 증감은 NaN(화면 —), 브리프는 데이터 없음 안내', async () => {
    const { operatingSummary, morningBrief } = await import('./engine');
    const empty = { ...DEMO, mediaDaily: [], salesDaily: [], mediaHourly: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [] };
    const s = operatingSummary(empty, [], []);
    expect(s.cov.none).toBe(true);
    for (const v of [s.costDelta, s.roasDelta, s.salesDelta, s.cpa7Delta, s.cac7Delta]) expect(Number.isNaN(v)).toBe(true);
    const b = morningBrief(empty, [], [], 0);
    expect(b.facts[0]).toContain('연결된 데이터 출처가 없어');
    expect(b.facts.join(' ')).not.toMatch(/0\.0%|NaN|Infinity/);
  });

  it('데모(모든 매체 · 채널 데이터)는 예전 계산과 같은 증감', async () => {
    const { operatingSummary } = await import('./engine');
    const { headline } = await import('@/core/selectors');
    const { metrics } = await import('@/core/util');
    const s = operatingSummary(DEMO, [], []);
    const h = headline(DEMO);
    expect(s.cov.none).toBe(false);
    expect(s.cov.notes).toEqual([]);
    expect(s.costDelta).toBe(metrics.pctChange(h.yesterday.cost, h.dayBefore.cost));
    expect(s.roasDelta).toBe(metrics.pctChange(h.yesterday.roas, h.dayBefore.roas));
    expect(s.salesDelta).toBe(metrics.pctChange(h.salesYesterday, h.salesDayBefore));
    expect(s.cpa7Delta).toBe(metrics.pctChange(h.last7.cpa, h.prev7.cpa));
    expect(s.cac7Delta).toBe(metrics.pctChange(h.last7.cac, h.prev7.cac));
  });

  it('최근 7일만 올린 매체는 7일 CPA 증감에서 빼고 기준 문구를 남긴다 (Board와 같은 기준)', async () => {
    const { operatingSummary } = await import('./engine');
    const d = { ...DEMO, mediaDaily: DEMO.mediaDaily.filter((r) => r.media !== 'google' || r.date >= '2026-10-24') };
    const s = operatingSummary(d, [], []);
    expect(s.cov.notes.join(' ')).toContain('Google(10/24부터)');
    expect(Number.isFinite(s.cpa7Delta)).toBe(true);
  });
});
