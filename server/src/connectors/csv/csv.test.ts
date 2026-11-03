/** CSV 커넥터: 정규화 레코드 → NormalizedBatch (기존 키워드 id 맞춤 · 새 키워드 엔티티 · 의도 추정) */
import { describe, expect, it } from 'vitest';
import { connector, csvKeywordId, csvToBatch, guessIntent, normalizeCsv } from './index';

describe('CSV 커넥터', () => {
  it('정의: 업로드 전용(예약 수집 · 반영 없음)', async () => {
    expect(connector.provider).toBe('csv');
    expect(connector.capabilities).toMatchObject({ writes: [], intraday: false, maxBackfillDays: 0 });
    expect(await connector.test({} as never)).toMatchObject({ ok: true });
  });

  it('키워드 문구가 실연동 키워드와 같으면 그 id에 붙이고, 아니면 csv: id로 새 엔티티를 만든다', () => {
    const csv = '일자,키워드,광고그룹,노출,클릭,광고비,전환,전환매출,평균순위,입찰가\n2026-10-30,퀸 매트리스,G,100,10,"12,000",1,1000000,2.5,\n2026-10-30,수면밀도 매트리스 후기,B,50,5,1000,1,900000,1.2,500\n2026-10-31,허리 아플때 매트리스,P,10,1,800,0,0,,';
    const b = csvToBatch(normalizeCsv('keyword_daily', csv), { keywordIdByText: new Map([['퀸 매트리스', 'nkw-123']]), brandTerms: ['수면밀도'] });
    expect(b.keywordDaily!.map((r) => r.keywordId)).toEqual(['nkw-123', csvKeywordId('수면밀도 매트리스 후기'), csvKeywordId('허리 아플때 매트리스')]);
    expect(b.keywords!.map((k) => [k.text, k.intent, k.isBrand, k.bid, k.maxBid, k.avgRank])).toEqual([
      ['수면밀도 매트리스 후기', 'brand', true, 500, 800, 1.2],
      ['허리 아플때 매트리스', 'problem', false, 800, 1280, 0],
    ]);
  });

  it('의도 추정 (문구 기준)', () => {
    expect(guessIntent('매트리스 추천', [])).toBe('compare');
    expect(guessIntent('신혼 매트리스', [])).toBe('life');
    expect(guessIntent('단단한 매트리스', [])).toBe('problem');
    expect(guessIntent('퀸 매트리스', [])).toBe('generic');
    expect(guessIntent('밀도 매트리스', ['밀도'])).toBe('brand');
  });

  it('템플릿별 표준 레코드', () => {
    expect(csvToBatch(normalizeCsv('sales_daily', '일자,채널,주문,매출\n2026-10-30,자사몰,3,"2,900,000"')).salesDaily).toEqual([
      { date: '2026-10-30', channel: 'own_mall', visitors: 0, detailViews: 0, carts: 0, orders: 3, revenue: 2900000, adAttributedRevenue: 0 },
    ]);
    expect(csvToBatch(normalizeCsv('search_term_daily', '일자,검색어,클릭,비용\n2026-10-30,첫 자취 매트리스,4,"3,200"')).searchTermDaily).toEqual([
      { date: '2026-10-30', term: '첫 자취 매트리스', impressions: 0, clicks: 4, cost: 3200, conversions: 0, revenue: 0 },
    ]);
    expect(csvToBatch(normalizeCsv('media_hourly', '일자,시간,매체,광고비\n2026-10-30,21시,GFA,1000')).mediaHourly).toEqual([
      { date: '2026-10-30', hour: 21, media: 'naver_gfa', impressions: 0, clicks: 0, cost: 1000, conversions: 0, revenue: 0 },
    ]);
  });
});
