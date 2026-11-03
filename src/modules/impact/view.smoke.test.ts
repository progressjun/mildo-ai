/**
 * 성과 증명 화면 렌더 (SSR) — 데모 모드(예시 · TEST DATA · 서버 연결 안내 · 읽기 전용), 서버 모드(LIVE · 즉시 측정 · 권한 없는 역할 ·
 * 장부의 '집계 제외 · 매체 미반영' · 서버 CSV · 리포트 보관함 · 예약 일정 · 데모 커넥션뿐인 워크스페이스의 TEST DATA 예시 전환).
 * 화면 규칙: 하드코딩 색상 없음 · window.alert/confirm/prompt/open 없음 · NaN/undefined 없음.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rng } from '@/core/util';
import {
  automationSavings, buildDemoImpact, buildSummary, datesBetween, estimateLossAvoided, estimateUplift, impactConfig, PAYBACK_FORMULA,
  type DayMetrics, type ImpactSummary, type LedgerEntry,
} from './engine';
import type { ImpactData, ImpactScreenProps } from './View';
import type { ReportItem, ScheduleRow } from './api';
import { DEMO } from '@/data/demo';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

const WS = '00000000-0000-4000-8000-0000000000aa';
const BEFORE = datesBetween('2026-10-06', '2026-10-12');
const AFTER = datesBetween('2026-10-14', '2026-10-20');

/** 서버 장부 형태의 합성 행 — 측정 1 · 매체 미반영 1 · 사고 1 · 자동화 */
function serverEntries(): LedgerEntry[] {
  const r = rng(5);
  const treated: Record<string, DayMetrics> = {}, control: Record<string, DayMetrics> = {};
  for (const d of [...BEFORE, ...AFTER]) {
    const f = r.noise(0.1), after = d > '2026-10-13';
    treated[d] = { date: d, clicks: 120, conversions: 6, cost: Math.round(400_000 * f), revenue: Math.round(1_800_000 * f + (after ? 250_000 : 0)) };
    control[d] = { date: d, clicks: 360, conversions: 18, cost: Math.round(1_200_000 * f), revenue: Math.round(5_400_000 * f) };
  }
  const est = estimateUplift({ beforeDates: BEFORE, afterDates: AFTER, treated, control, controlUnits: 4, margin: 0.4, seed: 'view' });
  const base = { windowDays: 7, month: '2026-10', baseline: null, observed: null, control: null, measuredAt: '2026-11-01T21:00:00.000Z' };
  const loss = estimateLossAvoided({ id: 'inc-1', title: '예산 조기 소진', severity: 'P1', revenueLossEst: 1_000_000, occurredAt: '2026-10-13T14:00:00+09:00', detectedAt: '2026-10-13T14:05:00+09:00', actionAt: '2026-10-13T14:30:00+09:00' });
  return [
    {
      ...base, id: 'l1', sourceType: 'change', sourceId: 'chg-1', label: '퀸 매트리스 입찰가 700 → 800', occurredAt: '2026-10-13T01:00:00.000Z', status: 'measured', estimate: est,
      baseline: { from: BEFORE[0], to: BEFORE[6], days: 7, daysWithData: 7, impressions: 0, clicks: 840, cost: 2_800_000, conversions: 42, revenue: 12_600_000 },
      observed: { from: AFTER[0], to: AFTER[6], days: 7, daysWithData: 7, impressions: 0, clicks: 840, cost: 2_800_000, conversions: 42, revenue: 14_350_000 },
      control: { basis: 'adgroup', label: "같은 광고그룹 '매트리스' 미변경 키워드", units: 4, ids: ['k2', 'k3', 'k4', 'k5'], before: null, after: null },
      detail: { kind: 'bid', target: '퀸 매트리스', targetId: 'k1', route: 'flow', mode: 'live', appliedAt: '2026-10-13T01:00:00.000Z' },
    },
    {
      ...base, id: 'l2', sourceType: 'change', sourceId: 'chg-2', label: '킹 매트리스 입찰가 900 → 990', occurredAt: '2026-10-15T01:00:00.000Z', status: 'excluded', estimate: null,
      detail: { kind: 'bid', route: 'flow', mode: 'dry_run', exclusion: 'not_applied', reason: '매체 미반영 — dry_run(호출 내용만 기록하고 매체에 보내지 않음) · 매체 값이 바뀌지 않아 증분 추정 대상이 아님' },
    },
    { ...base, id: 'l3', sourceType: 'incident', sourceId: 'inc-1', label: 'P1 예산 조기 소진', occurredAt: '2026-10-13T05:05:00.000Z', status: 'measured', windowDays: 0, estimate: loss.ok ? loss.estimate : null, detail: { severity: 'P1', route: 'alert' } },
    ...automationSavings({ ingest_days: 20, daily_reports: 20, weekly_reports: 4, bid_budget_changes: 6, keyword_changes: 0, detection_days: 20 }, 20).rows.map((row, i) => ({
      ...base, id: `a${i}`, sourceType: 'automation' as const, sourceId: `2026-10:${row.unit}`, label: row.task, occurredAt: '2026-09-30T15:00:00.000Z', status: 'measured' as const, windowDays: 0, estimate: row, detail: { reason: '자동 실행 기록' },
    })),
  ];
}

function serverData(o: { dataMode?: ImpactSummary['dataMode']; example?: ImpactData['example'] } = {}): ImpactData {
  const entries = serverEntries();
  const summary = buildSummary(entries, impactConfig({ billing: { monthlyFee: 5_000_000 } }), '2026-10', { generatedAt: '2026-11-02T00:00:00.000Z', dataMode: o.dataMode ?? 'live' });
  return { demo: false, loading: false, error: null, month: '2026-10', months: ['2026-11', '2026-10', '2026-09'], summary, entries, example: o.example ?? null, reload: async () => undefined };
}

const REPORTS: ReportItem[] = [
  {
    id: 'r-1', type: 'weekly', title: '주간 리포트 · 10/26 ~ 11/1', periodStart: '2026-10-26', periodEnd: '2026-11-01', generatedAt: '2026-11-02T01:00:00.000Z', status: 'delivered', trigger: 'schedule',
    scope: 'weekly', refId: null, dataMode: 'live', dataAsOf: '2026-11-02T00:10:00.000Z', messenger: '[MILDO 주간] 요약', aeComment: null, deliveredAt: '2026-11-02T01:00:05.000Z', excerpt: '[MILDO 주간] 요약',
    delivered: [{ channelId: 'ch1', channelType: 'slack', channelName: '운영 Slack', via: 'notify.send', status: 'sent', jobId: 3, target: 'hooks.slack.com/…', at: '2026-11-02T01:00:05.000Z', by: 'system' }],
  },
  {
    id: 'r-2', type: 'value', title: '월간 가치 리포트 · 2026년 10월', periodStart: '2026-10-01', periodEnd: '2026-10-31', generatedAt: '2026-11-01T00:00:00.000Z', status: 'generated', trigger: 'schedule',
    scope: 'value-2026-10', refId: null, dataMode: 'live', dataAsOf: null, messenger: '[MILDO 가치] 2026년 10월 회수 배수 1.2배', aeComment: null, deliveredAt: null, excerpt: '[MILDO 가치]', delivered: [],
  },
];
const SCHEDULE: ScheduleRow[] = [
  { type: 'daily', at: '2026-11-03T08:00:00+09:00', covers: '2026-11-02', rule: '매일 08:00 · 전일 성과' },
  { type: 'weekly', at: '2026-11-09T10:00:00+09:00', covers: '2026-11-02 ~ 2026-11-08', rule: '매주 월 10:00 · 월요일이 휴무면 다음 영업일 10:00' },
  { type: 'monthly', at: '2026-11-04T10:00:00+09:00', covers: '2026-10', rule: '매월 3영업일 10:00 · 지난달' },
  { type: 'value', at: '2026-12-01T09:00:00+09:00', covers: '2026-11', rule: '매월 1일 09:00 · 지난달 성과 증명' },
  { type: 'issue', at: '감지 즉시', covers: 'P1 이슈', rule: 'P1 이슈 감지 후 5분 안 (이슈당 1건)' },
];

async function screen(p: Partial<ImpactScreenProps> = {}): Promise<string> {
  const { ImpactScreen } = await import('./View');
  return wrap(h(ImpactScreen, { d: serverData(), ws: WS, canOperate: true, workspaceName: '수면밀도', ...p }));
}
const clean = (html: string) => expect(html).not.toMatch(/NaN|undefined|Infinity/);

describe('성과 증명 화면', () => {
  it('데모 모드: TEST DATA 예시 · 서버 연결 안내 · 회수 배수 산식 · 구성 요소 · 읽기 전용', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    for (const t of ['성과 증명', '서버 연결 시 실제로 동작합니다', 'TEST DATA', '구독료 대비 회수 배수', PAYBACK_FORMULA, '구성 요소', '측정된 증분', '추정 손실 회피', '절감 시간', '반례 · 대체 시나리오', '예시 상태 · 읽기 전용', '80% 구간']) {
      expect(html, t).toContain(t);
    }
    expect(html).toMatch(/<select[^>]*id="impact-month"[^>]*disabled=""/);
    expect(html).not.toContain('지금 측정');
    clean(html);
  });

  it('데모 모드 장부 · 보관함: 예시 행에 TEST DATA · 가치 리포트 예시 · 생성 · 발송 버튼 잠김', async () => {
    const { ImpactScreen } = await import('./View');
    const ex = buildDemoImpact(DEMO, []);
    const d: ImpactData = { demo: true, loading: false, error: null, month: ex.month, months: [ex.month], summary: ex.summary, entries: ex.entries, example: null, reload: async () => undefined };
    const ledger = await wrap(h(ImpactScreen, { d, ws: null, canOperate: false, initialTab: 'ledger' }));
    expect(ledger).toContain('TEST DATA');
    expect(ledger).toContain('CSV 내보내기');
    expect(ledger).not.toContain('서버 CSV');
    clean(ledger);
    const reps = await wrap(h(ImpactScreen, { d, ws: null, canOperate: false, initialTab: 'reports' }));
    expect(reps).toContain('리포트 보관함은 서버 연결 시 채워집니다');
    expect(reps).toContain('월간 가치 리포트');
    expect(reps).toMatch(/<button[^>]*disabled=""[^>]*title="데모 모드 · 서버 연결 시 사용"/);
    clean(reps);
  });

  it('서버 모드 · operate 권한: LIVE · 즉시 측정 가능 · 수치 · 판정 기준', async () => {
    const html = await screen();
    expect(html).toContain('LIVE');
    expect(html).toContain('즉시 측정 · 리포트 생성 · 발송 가능');
    expect(html).toMatch(/<button[^>]*title="매일 06:00 예약 측정과 같은 계산을 지금 실행"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*title="매일 06:00 예약 측정과 같은 계산을 지금 실행"/);
    expect(html).not.toContain('서버 연결 시 실제로 동작합니다');
    expect(html).toContain('기준:');
    expect(html).toContain('측정 1건');
    expect(html).toContain('제외 1');
    clean(html);
  });

  it('서버 모드 · 읽기 전용 역할: 즉시 측정 잠김 · 안내', async () => {
    const html = await screen({ canOperate: false });
    expect(html).toContain('읽기 전용 (측정 · 생성 · 발송은 담당 AE 이상)');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="즉시 측정은 담당 AE 이상 권한"/);
  });

  it("서버 장부: 반영 전 · 후 · 대조군 · 추정 · '집계 제외 · 매체 미반영' · 서버 CSV", async () => {
    const html = await screen({ initialTab: 'ledger' });
    for (const t of ['장부 · 2026년 10월', '반영 전 7일', '반영 후 7일', '대조군', '미변경 키워드 (4개)', '측정 완료', '집계 제외 · 매체 미반영', '매체 미반영 — dry_run', '손실 회피', 'CSV 내보내기', '서버 CSV (전체)']) {
      expect(html, t).toContain(t);
    }
    expect(html).toContain(`href="/api/w/${WS}/impact/ledger.csv?month=2026-10"`);
    clean(html);
  });

  it('리포트 보관함: 목록 · 발송 기록 · 다음 예약 · 대상 월 기준 생성', async () => {
    const html = await screen({ initialTab: 'reports', reportsSeed: { reports: REPORTS, schedule: SCHEDULE } });
    for (const t of ['리포트 보관함', '주간 리포트 · 10/26 ~ 11/1', '월간 가치 리포트 · 2026년 10월', '발송됨', '생성됨 · 미발송', '운영 Slack · 발송', '다음 예약 생성 · 발송', '매월 3영업일 10:00 · 지난달', '가치 · 2026년 10월', '월간 · 2026년 10월', '일간 · 전일', '지금 생성', 'LIVE DATA']) {
      expect(html, t).toContain(t);
    }
    expect(html).not.toContain('리포트 보관함은 서버 연결 시 채워집니다');
    clean(html);
  });

  it('데모 커넥션뿐인 서버 워크스페이스: 판정 보류 안내 · TEST DATA 예시 전환 버튼', async () => {
    const ex = buildDemoImpact(DEMO, []);
    const d = serverData({ dataMode: 'demo', example: { summary: ex.summary, entries: ex.entries } });
    const html = await screen({ d });
    expect(html).toContain('이 워크스페이스 장부는 TEST DATA(데모 커넥션)뿐입니다');
    expect(html).toContain('TEST DATA 예시로 보기');
    expect(html).toContain('TEST DATA');
    clean(html);
  });

  it('서버 모드 · 불러오기 실패: 예시 값을 서버 값처럼 보여 주지 않고 오류 · 다시 시도', async () => {
    const ex = buildDemoImpact(DEMO, []);
    const d: ImpactData = { ...serverData(), ready: false, error: '서버에 연결할 수 없습니다', summary: ex.summary, entries: [] };
    const html = await screen({ d });
    expect(html).toContain('서버에서 불러오지 못했습니다');
    expect(html).toContain('서버 장부를 불러오지 못했습니다');
    expect(html).toContain('다시 시도');
    expect(html).not.toContain('구독료 대비 회수 배수');
    expect(html).not.toContain('측정된 증분 이익');
    expect(html).not.toContain('TEST DATA 예시로 보기');
    clean(html);
  });

  it('판정 보류(이 달 측정 · 추정 없음)는 0.0배가 아니라 값 없음으로 그린다', async () => {
    const empty = buildSummary([], impactConfig(null), '2026-11', { generatedAt: '2026-11-03T00:00:00.000Z', dataMode: 'live' });
    const html = await screen({ d: { ...serverData(), month: '2026-11', summary: empty, entries: [] } });
    expect(html).toContain('판정 보류');
    expect(html).toContain('이 달에 측정 · 추정된 항목이 없어 회수 배수를 계산하지 않았습니다');
    expect(html).not.toMatch(/impact-big num">0\.0배/);
    expect(html).toMatch(/impact-big num">—/);
  });

  it('리포트 보관함: 발송 큐에만 들어간 리포트는 발송됨이 아니라 발송 대기', async () => {
    const queued: ReportItem = { ...REPORTS[0], id: 'r-q', title: '일간 리포트 · 11/1', delivered: [{ ...REPORTS[0].delivered[0], status: 'queued', channelName: '광고주 메일' }] };
    const html = await screen({ initialTab: 'reports', reportsSeed: { reports: [queued], schedule: SCHEDULE } });
    expect(html).toContain('발송 대기');
    expect(html).toContain('광고주 메일 · 발송 대기');
    expect(html).not.toContain('>발송됨<');
  });

  it('화면 규칙: 하드코딩 색상 없음 · window.alert/confirm/prompt/open 없음', () => {
    const dir = join(process.cwd(), 'src/modules/impact');
    for (const f of ['View.tsx', 'styles.css', 'agent.ts', 'api.ts']) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/);
      expect(src, f).not.toMatch(/window\.(alert|confirm|prompt|open)\s*\(/);
      expect(src, f).not.toMatch(/\balert\(|\bconfirm\(|\bprompt\(/);
    }
  });
});
