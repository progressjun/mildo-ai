/** 데모 커넥터: 현재 KST 날짜 기준 생성 · 기간 필터 · 오래된 기간 블록 · 오늘 진행 중 값 · 날짜 박힌 엔티티 이동 · 시뮬레이션 반영 */
import { afterAll, describe, expect, it } from 'vitest';
import { connector, demoBatch } from './index';
import { generateDemoData } from '@/data/demo';
import { addDaysStr, dateRange, setNowForTest } from '../../lib/time';
import { checkBatch } from '../../ingest/quality';

afterAll(() => setNowForTest(null));

describe('데모 커넥터', () => {
  it('요청 기간만 돌려준다: 과거 3일은 일별 · 시간대 · 판매 · 키워드 · 검색어, 오늘 값 없음', () => {
    const b = demoBatch({ from: '2026-11-11', to: '2026-11-13' }, { date: '2026-11-14', hour: 7 });
    expect(new Set(b.mediaDaily!.map((r) => r.date))).toEqual(new Set(['2026-11-11', '2026-11-12', '2026-11-13']));
    expect(b.mediaDaily).toHaveLength(18);
    expect(b.mediaHourly).toHaveLength(3 * 6 * 24);
    expect(b.salesDaily).toHaveLength(12);
    expect(b.keywordDaily).toHaveLength(3 * 28);
    expect(b.searchTermDaily).toHaveLength(3 * 15);
    expect(b.brandSearchDaily).toHaveLength(3);
    expect(b.keywords).toHaveLength(28);
    expect(b.campaigns!.every((c) => c.hourOfData === 7)).toBe(true);
  });

  it('과거 값은 수집 시각과 무관하게 같다 (멱등), 오늘 값은 현재 시각까지', () => {
    const at7 = demoBatch({ from: '2026-11-10', to: '2026-11-14' }, { date: '2026-11-14', hour: 7 });
    const at21 = demoBatch({ from: '2026-11-10', to: '2026-11-14' }, { date: '2026-11-14', hour: 21 });
    const past = (b: typeof at7) => [b.mediaDaily!.filter((r) => r.date < '2026-11-14'), b.salesDaily!.filter((r) => r.date < '2026-11-14'), b.keywordDaily];
    expect(past(at21)).toEqual(past(at7));
    expect(at7.mediaHourly!.filter((r) => r.date === '2026-11-14' && r.media === 'meta').map((r) => r.hour)).toEqual(dateRange('2026-11-14', '2026-11-14').flatMap(() => [0, 1, 2, 3, 4, 5, 6, 7]));
    const metaToday = (b: typeof at7) => b.mediaDaily!.find((r) => r.date === '2026-11-14' && r.media === 'meta')!.cost;
    expect(metaToday(at21)).toBeGreaterThan(metaToday(at7));
  });

  it('데모 데이터는 품질 검사에서 경고 · 오류가 없다 (키워드 표본 합계 차이만 참고)', () => {
    const today = '2026-11-02';
    const range = { from: addDaysStr(today, -60), to: addDaysStr(today, -1) };
    const b = demoBatch(range, { date: today, hour: 9 });
    const r = checkBatch(b, { range, job: 'backfill', today, hour: 9, provider: 'demo', channel: null, reads: connector.capabilities.reads });
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(r.issues.map((i) => i.code)).toEqual(['keyword_media_mismatch']);
    // 시간대는 최근 35일만
    expect(Math.min(...b.mediaHourly!.map((x) => Date.parse(x.date)))).toBe(Date.parse(addDaysStr(today, -34))); // 오늘 포함 35일
  });

  it('120일보다 오래된 기간도 끊김 없이 채운다 (블록 기준일 당일 값은 쓰지 않음)', () => {
    const today = '2026-11-02';
    const from = addDaysStr(today, -400);
    const b = demoBatch({ from, to: addDaysStr(today, -1) }, { date: today, hour: 10 });
    const dates = [...new Set(b.mediaDaily!.map((r) => r.date))].sort();
    expect(dates).toEqual(dateRange(from, addDaysStr(today, -1)));
    expect(b.mediaDaily).toHaveLength(400 * 6);
    expect(b.mediaDaily!.every((r) => r.cost > 0 && Number.isFinite(r.revenue))).toBe(true);
    // 블록 경계(today-120 ~ today-119) 전후 값 규모가 비슷하다 (같은 프로파일)
    const sa = (d: string) => b.mediaDaily!.find((r) => r.date === d && r.media === 'naver_sa')!.cost;
    expect(sa(addDaysStr(today, -120)) / sa(addDaysStr(today, -119))).toBeGreaterThan(0.6);
    expect(sa(addDaysStr(today, -120)) / sa(addDaysStr(today, -119))).toBeLessThan(1.6);
  });

  it('생성기 기준일과 같은 날이면 생성기 값 그대로, 다른 날이면 프로모션 · 최근 접속일을 그만큼 옮긴다', () => {
    const same = demoBatch({ from: '2026-10-30', to: '2026-10-31' }, { date: '2026-10-31', hour: 15 });
    const g = generateDemoData('2026-10-31', 15);
    expect(same.mediaDaily!.filter((r) => r.date === '2026-10-31')).toEqual(g.mediaDaily.filter((r) => r.date === '2026-10-31'));
    expect(same.promotions).toEqual(g.promotions);
    const later = demoBatch({ from: '2026-12-01', to: '2026-12-01' }, { date: '2026-12-02', hour: 9 });
    expect(later.promotions!.map((p) => [p.start, p.end, p.status])).toEqual([['2026-11-21', '2026-12-05', 'live'], ['2026-11-28', '2026-12-04', 'live'], ['2026-12-13', '2026-12-22', 'planned']]);
    expect(later.accounts![0].permissions[0].lastLogin).toBe('2026-12-02');
  });

  it('당일 수집은 오늘 시간대 · 캠페인 · 계정만 (키워드 · 상품 스냅샷 생략), 미래 기간은 비어 있다', () => {
    const b = demoBatch({ from: '2026-11-02', to: '2026-11-02' }, { date: '2026-11-02', hour: 3 }, { intradayDate: '2026-11-02' });
    expect(b.mediaHourly!.every((r) => r.date === '2026-11-02' && r.hour <= 3)).toBe(true);
    expect(b.keywords).toBeUndefined();
    expect(b.campaigns).toHaveLength(16);
    expect(demoBatch({ from: '2026-12-01', to: '2026-12-05' }, { date: '2026-11-02', hour: 3 }).mediaDaily).toEqual([]);
  });

  it('fetch는 실제 현재 KST 날짜를 쓰고, apply는 실제 호출 없이 시뮬레이션', async () => {
    setNowForTest(Date.parse('2026-11-02T01:00:00Z')); // KST 10시
    const b = await connector.fetch({} as never, { from: '2026-11-01', to: '2026-11-02' });
    expect(Math.max(...b.mediaHourly!.filter((r) => r.date === '2026-11-02').map((r) => r.hour))).toBe(10);
    const logs: string[] = [];
    const r = await connector.apply!({ dryRun: false, log: (m: string) => logs.push(m) } as never, { id: 'c1', kind: 'bid', target: '퀸 매트리스', before: 1000, after: 1100 } as never);
    expect(r).toMatchObject({ ok: true, appliedValue: 1100, request: { simulated: true, kind: 'bid' } });
    expect(logs[0]).toMatch(/시뮬레이션/);
    expect(await connector.test({} as never)).toMatchObject({ ok: true });
  });
});
