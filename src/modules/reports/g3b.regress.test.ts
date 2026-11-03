/**
 * QA 회귀 (G3b · 리포트) — 서버 모드 발송 현황 카드는 데이터 시계 추정이 아니라 서버 리포트 보관함의 실제 발송 기록 기준.
 * 보관함을 읽기 전 · 생성만 · 보내지 않음 · 발송 대기는 '발송 완료'로 보이지 않는다. 데모 모드는 그대로.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import type { Role } from '@/core/permissions';
import { cadenceStatus, serverCadence, type ArchiveReportLite } from './engine';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const base = () => cadenceStatus(DEMO, []);
const rep = (o: Partial<ArchiveReportLite>): ArchiveReportLite => ({ type: 'daily', periodStart: '2026-11-02', periodEnd: '2026-11-02', generatedAt: '2026-11-03T08:24:00.000Z', delivered: [], deliveredAt: null, ...o });
const card = (list: ReturnType<typeof serverCadence>, t: string) => list.find((c) => c.type === t)!;

describe('serverCadence — 보관함 기준 발송 현황', () => {
  it("데모 기준(데이터 시계)은 일간을 '발송 완료'로 보지만, 서버 보관함에 발송 기록이 없으면 발송 완료가 아니다", () => {
    expect(card(base(), 'daily').state).toBe('sent');
    const s = serverCadence(base(), []);
    for (const t of ['daily', 'weekly', 'monthly']) {
      expect(card(s, t).state).not.toBe('sent');
      expect(card(s, t).stateLabel).toBe('서버 발송 기록 없음');
      expect(card(s, t).last).toBeNull();
      expect(card(s, t).detail).not.toMatch(/최근 발송|최근 \d/);
    }
    // 이슈 카드는 이슈 목록 기준 그대로
    expect(card(s, 'issue')).toEqual(card(base(), 'issue'));
  });

  it("보관함을 읽기 전 · 실패: '확인 중' · '불러오지 못함' (발송 완료로 추정하지 않음)", () => {
    expect(card(serverCadence(base(), null), 'daily')).toMatchObject({ state: 'scheduled', stateLabel: '서버 발송 기록 확인 중', last: null });
    expect(card(serverCadence(base(), null, true), 'weekly').stateLabel).toBe('서버 발송 기록을 불러오지 못함');
  });

  it("수동 생성 · 보내지 않음(SMTP 없음) · 발송 대기 · 실패는 각각 그 상태로, 실제 sent 기록만 '발송 완료'", () => {
    const gen = card(serverCadence(base(), [rep({})]), 'daily');
    expect(gen).toMatchObject({ state: 'scheduled', stateLabel: '11/3(화) 17:24 생성됨 · 미발송', last: null });
    expect(gen.detail).toContain('실제 발송 기록 없음');
    const skipped = card(serverCadence(base(), [rep({ delivered: [{ status: 'skipped', at: '2026-11-03T08:24:54.000Z' }], deliveredAt: '2026-11-03T08:24:54.369Z' })]), 'daily');
    // delivered_at이 (예전 서버가) 채워 있어도 sent 기록이 없으면 발송 완료가 아니다
    expect(skipped).toMatchObject({ state: 'scheduled', stateLabel: '11/3(화) 17:24 생성됨 · 보내지 않음' });
    expect(card(serverCadence(base(), [rep({ delivered: [{ status: 'queued', at: '2026-11-03T08:24:54.000Z' }] })]), 'daily').stateLabel).toMatch(/발송 대기$/);
    expect(card(serverCadence(base(), [rep({ delivered: [{ status: 'failed', at: '2026-11-03T08:24:54.000Z' }] })]), 'daily').stateLabel).toMatch(/발송 실패$/);
    const sent = card(serverCadence(base(), [rep({ type: 'weekly', periodStart: '2026-10-26', periodEnd: '2026-11-01', generatedAt: '2026-11-02T01:00:00.000Z', delivered: [{ status: 'sent', at: '2026-11-02T01:00:05.000Z' }] })]), 'weekly');
    expect(sent).toMatchObject({ state: 'sent', stateLabel: '11/2(월) 10:00 발송 완료', last: '11/2(월) 10:00' });
    expect(sent.detail).toContain('10/26–11/1');
    // 최신이 미발송이면 이전 발송 시각만 '마지막 발송'으로 안내
    const mixed = card(serverCadence(base(), [
      rep({ generatedAt: '2026-11-03T08:24:00.000Z' }),
      rep({ periodStart: '2026-11-01', periodEnd: '2026-11-01', generatedAt: '2026-11-01T23:00:00.000Z', delivered: [{ status: 'sent', at: '2026-11-01T23:00:03.000Z' }] }),
    ]), 'daily');
    expect(mixed.state).toBe('scheduled');
    expect(mixed.detail).toContain('마지막 발송 11/2(월) 08:00');
  });
});

async function render(mode: 'server' | 'demo', role: Role = 'pm'): Promise<string> {
  mem['mildo-os/v1'] = JSON.stringify({ changes: [], incidents: [], comments: [], ai: { mode: 'offline' }, role: 'PM', tf: {} });
  const { StoreProvider } = await import('@/core/store');
  const { SaasTestProvider } = await import('@/saas/context');
  const View = (await import('./View')).default as ComponentType;
  const inner = h(StoreProvider, null, h(View));
  const tree = mode === 'server' ? h(SaasTestProvider, { value: { mode: 'server', role }, children: inner }) : inner;
  return renderToString(tree).replace(/<!-- -->/g, '');
}

describe('리포트 화면 발송 현황 (SSR)', () => {
  it("서버 모드: 보관함을 읽기 전에는 일간 '발송 완료' · 주간 '최근 발송'을 그리지 않는다 · 기준 문구는 서버 보관함", async () => {
    const html = await render('server');
    const cad = html.slice(html.indexOf('reports-cadence'), html.indexOf('reports-tabs'));
    expect(cad).not.toContain('발송 완료');
    expect(cad).not.toContain('최근 발송');
    expect(cad).toContain('서버 발송 기록 확인 중');
    expect(html).toContain('서버 리포트 보관함(실제 발송 기록) 기준');
  });

  it('데모 모드는 그대로 (데이터 기준 시각 기준 · 발송 완료 표시)', async () => {
    const html = await render('demo');
    const cad = html.slice(html.indexOf('reports-cadence'), html.indexOf('reports-tabs'));
    expect(cad).toContain('발송 완료');
    expect(html).toContain('발송 상태는 데이터 기준 시각 기준');
    expect(html).not.toContain('서버 발송 기록 확인 중');
  });
});
