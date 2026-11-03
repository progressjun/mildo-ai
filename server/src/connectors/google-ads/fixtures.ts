/**
 * Google Ads REST 응답 픽스처 — v26 디스커버리 문서의 SearchGoogleAdsStreamResponse(배치 배열 · results · fieldMask · requestId)와
 * GoogleAdsRow 필드(lowerCamelCase, int64는 문자열) 형태로 만든 TEST DATA.
 */
import type { FakeRoute } from '../naver-sa/fake-http';
import type { GadsRow } from './client';

export const CUSTOMER = '1234567890';
const batch = (results: GadsRow[], fieldMask = '') => [{ results, fieldMask, requestId: 'req-test' }];
const q = (req: { body?: unknown }) => String((req.body as { query?: string } | undefined)?.query ?? '');

export const customerRow: GadsRow = { customer: { id: CUSTOMER, descriptiveName: '수면밀도 자사몰', currencyCode: 'KRW', timeZone: 'Asia/Seoul' } };

export function dailyRows(from: string, to: string): GadsRow[] {
  const out: GadsRow[] = [];
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    const n = Number(d.slice(8, 10));
    out.push({ segments: { date: d }, metrics: { impressions: String(10000 + n), clicks: String(300 + n), costMicros: String((150000 + n) * 1_000_000 + 400_000), conversions: 4.5, conversionsValue: 1234567.8 } });
  }
  return out;
}

export function googleRoutes(o: { today: string; currency?: string; timeZone?: string } ): FakeRoute[] {
  return [
    { method: 'POST', match: 'oauth2/v3/token', reply: { data: { access_token: 'ya29.test-access-token', expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/adwords' } } },
    {
      method: 'POST',
      match: (req) => req.url.endsWith('/googleAds:searchStream'),
      reply: (req) => {
        const query = q(req);
        if (query.includes('FROM customer LIMIT 1')) return { data: batch([{ customer: { ...customerRow.customer, currencyCode: o.currency ?? 'KRW', timeZone: o.timeZone ?? 'Asia/Seoul' } }]) };
        const m = query.match(/BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/);
        if (query.includes('segments.hour')) {
          const rows: GadsRow[] = [];
          for (const r of dailyRows(m![1], m![2])) for (const h of [0, 13, 22]) rows.push({ segments: { date: r.segments!.date, hour: h }, metrics: { impressions: '100', clicks: '5', costMicros: '2500000000', conversions: 0.5, conversionsValue: 99999.6 } });
          // 두 배치로 나뉘어 와도 이어 붙인다
          return { data: [{ results: rows.slice(0, 3) }, { results: rows.slice(3), fieldMask: 'segments.date,segments.hour' }] };
        }
        if (query.startsWith('SELECT segments.date, metrics.') && query.includes('FROM customer')) return { data: batch(dailyRows(m![1], m![2])) };
        if (query.includes('metrics.cost_micros FROM customer')) return { data: batch([{ metrics: { costMicros: '700000000000' } }]) };
        if (query.includes('FROM campaign WHERE segments.date')) return { data: batch([{ campaign: { id: '111' }, metrics: { costMicros: '45678900000' } }]) };
        if (query.includes('FROM campaign WHERE campaign.status')) {
          return {
            data: batch([
              { campaign: { id: '111', name: '브랜드 검색', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', advertisingChannelType: 'SEARCH' }, campaignBudget: { amountMicros: '300000000000', explicitlyShared: false, period: 'DAILY' } },
              { campaign: { id: '222', name: 'Demand Gen 신규', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'LIMITED', advertisingChannelType: 'DEMAND_GEN' }, campaignBudget: { amountMicros: '200000000000', period: 'DAILY' } },
              { campaign: { id: '333', name: '시즌 종료', status: 'PAUSED', servingStatus: 'SERVING' }, campaignBudget: { amountMicros: '100000000000', period: 'CUSTOM_PERIOD' } },
            ]),
          };
        }
        if (query.includes('FROM ad_group_criterion')) {
          return {
            data: batch([
              { campaign: { id: '111', name: '브랜드 검색', status: 'ENABLED', biddingStrategyType: 'MANUAL_CPC' }, adGroup: { id: '5001', name: '브랜드', status: 'ENABLED' }, adGroupCriterion: { criterionId: '9001', status: 'ENABLED', cpcBidMicros: '1500000000', keyword: { text: '수면밀도', matchType: 'EXACT' }, finalUrls: ['https://mildo.kr'] } },
              { campaign: { id: '111', name: '브랜드 검색', status: 'ENABLED', biddingStrategyType: 'TARGET_ROAS' }, adGroup: { id: '5002', name: '매트리스 비교', status: 'PAUSED' }, adGroupCriterion: { criterionId: '9002', status: 'ENABLED', effectiveCpcBidMicros: '800000000', keyword: { text: '매트리스 추천', matchType: 'PHRASE' } } },
            ]),
          };
        }
        if (query.includes('search_rank_lost_impression_share')) return { data: batch([{ adGroup: { id: '5001' }, adGroupCriterion: { criterionId: '9001' }, metrics: { searchRankLostImpressionShare: 0.37 } }]) };
        if (query.includes('FROM keyword_view')) {
          return {
            data: batch([
              { segments: { date: m![2] }, adGroup: { id: '5001' }, adGroupCriterion: { criterionId: '9001' }, metrics: { impressions: '500', clicks: '40', costMicros: '61000000000', conversions: 2, conversionsValue: 900000 } },
              { segments: { date: m![2] }, adGroup: { id: '5002' }, adGroupCriterion: { criterionId: '9002' }, metrics: { impressions: '0', clicks: '0', costMicros: '0', conversions: 0, conversionsValue: 0 } },
            ]),
          };
        }
        if (query.includes('FROM search_term_view')) {
          return {
            data: batch([
              { segments: { date: m![2] }, searchTermView: { searchTerm: '수면밀도 매트리스' }, metrics: { impressions: '50', clicks: '5', costMicros: '7500000000', conversions: 1, conversionsValue: 500000 } },
              { segments: { date: m![2] }, searchTermView: { searchTerm: '수면밀도 매트리스' }, metrics: { impressions: '30', clicks: '2', costMicros: '2500000000', conversions: 0, conversionsValue: 0 } },
            ]),
          };
        }
        return { data: batch([]) };
      },
    },
  ];
}
