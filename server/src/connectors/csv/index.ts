/**
 * CSV · TSV 업로드 커넥터 — 파일 업로드(POST /api/w/:ws/uploads)로만 수집한다. 외부 API 호출 없음.
 * 파서 · 템플릿 · 별칭 · 정규화는 순수 엔진 src/modules/connections/csv.ts(화면 미리보기와 공용)를 쓰고,
 * 여기서는 정규화 레코드 → NormalizedBatch 변환(키워드 id 맞춤 · 신규 키워드 엔티티)을 맡는다.
 * 매체 · 판매 채널 API 공개 근거가 없는 경우(네이버 GFA · 오늘의집 등)의 대체 수집 경로다.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorDef, NormalizedBatch } from '../types';
import type { IntentId, Keyword } from '@/core/types';
import {
  normalizeCsv, TEMPLATES, UPLOAD_TEMPLATES, templateCsv, blockingIssues,
  type KeywordDailyRecord, type MediaDailyRecord, type MediaHourlyRecord, type NormalizeOptions, type NormalizeResult,
  type SalesDailyRecord, type SearchTermDailyRecord, type UploadTemplate,
} from '@/modules/connections/csv';

export { normalizeCsv, TEMPLATES, UPLOAD_TEMPLATES, templateCsv, blockingIssues };
export type { UploadTemplate, NormalizeResult, NormalizeOptions };

export const connector: ConnectorDef = {
  provider: 'csv',
  kind: 'other',
  channel: null,
  label: 'CSV · TSV 업로드',
  docsUrl: 'https://www.rfc-editor.org/rfc/rfc4180',
  // 외부 API가 없으므로 '실계정 검증' 대상이 아니다 — 업로드 파일 형식만 확인한다.
  verifiedLive: false,
  credentialsSchema: z.object({}).passthrough(),
  settingsSchema: z.object({ defaultChannel: z.string().max(40).optional() }).passthrough(),
  credentialFields: [],
  capabilities: { reads: ['mediaDaily', 'mediaHourly', 'salesDaily', 'keywordDaily', 'searchTermDaily', 'keywords'], writes: [], intraday: false, maxBackfillDays: 0 },
  async test() {
    return { ok: true, message: 'CSV 연결은 파일 업로드로 수집합니다 (외부 호출 없음)' };
  },
  async fetch() {
    // 업로드 경로(ingest.upload)가 수집한다 — 예약 수집 대상 아님
    return { warnings: [{ code: 'csv_upload_only', message: 'CSV 커넥션은 업로드로만 수집합니다' }] };
  },
};

/* ---------- 키워드 의도 추정 (문구 기준 — 화면에 '추정'으로 표시) ---------- */

const COMPARE = /(추천|비교|순위|가성비|후기|리뷰|vs|브랜드\s?순위|top|베스트)/i;
const PROBLEM = /(허리|통증|디스크|경도|단단|푹신|꺼짐|통기|땀|소음|알레르기|진드기|불면|숙면|교체\s?시기|고르는\s?법)/;
const LIFE = /(신혼|혼수|이사|자취|독립|선물|부모님|아이방|아기|어린이|원룸|입주|집들이)/;

export function guessIntent(text: string, brandTerms: string[]): IntentId {
  const t = text.replace(/\s+/g, '');
  if (brandTerms.some((b) => b && t.includes(b.replace(/\s+/g, '')))) return 'brand';
  if (COMPARE.test(text)) return 'compare';
  if (PROBLEM.test(text)) return 'problem';
  if (LIFE.test(text)) return 'life';
  return 'generic';
}

export const csvKeywordId = (text: string) => `csv:${createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)}`;

export interface CsvBatchOptions {
  /** 기존 키워드 문구 → id (다른 출처의 키워드와 일별 성과를 맞추기 위함) */
  keywordIdByText?: Map<string, string>;
  /** 브랜드 키워드 판정용 (워크스페이스 브랜드명 등) */
  brandTerms?: string[];
}

/** 정규화 결과 → NormalizedBatch */
export function csvToBatch(r: NormalizeResult, o: CsvBatchOptions = {}): NormalizedBatch {
  const batch: NormalizedBatch = {};
  switch (r.template) {
    case 'media_daily':
      batch.mediaDaily = (r.records as MediaDailyRecord[]).map((x) => ({ date: x.date, media: x.media, impressions: x.impressions, clicks: x.clicks, cost: x.cost, conversions: x.conversions, revenue: x.revenue, newCustomers: x.newCustomers ?? 0 }));
      break;
    case 'media_hourly':
      batch.mediaHourly = (r.records as MediaHourlyRecord[]).map((x) => ({ date: x.date, hour: x.hour, media: x.media, impressions: x.impressions, clicks: x.clicks, cost: x.cost, conversions: x.conversions, revenue: x.revenue }));
      break;
    case 'sales_daily':
      batch.salesDaily = (r.records as SalesDailyRecord[]).map((x) => ({ date: x.date, channel: x.channel, visitors: x.visitors, detailViews: x.detailViews, carts: x.carts, orders: x.orders, revenue: x.revenue, adAttributedRevenue: x.adAttributedRevenue ?? 0 }));
      break;
    case 'search_term_daily':
      batch.searchTermDaily = (r.records as SearchTermDailyRecord[]).map((x) => ({ date: x.date, term: x.term, impressions: x.impressions, clicks: x.clicks, cost: x.cost, conversions: x.conversions, revenue: x.revenue }));
      break;
    case 'keyword_daily': {
      const recs = r.records as KeywordDailyRecord[];
      const byText = o.keywordIdByText ?? new Map<string, string>();
      const entities = new Map<string, Omit<Keyword, 'last14' | 'prev14' | 'daily'> & { _clicks: number; _cost: number; _rankSum: number; _rankW: number }>();
      batch.keywordDaily = recs.map((x) => {
        const text = x.keyword?.replace(/\s+/g, ' ').trim() ?? null;
        const id = x.keywordId ?? (text ? byText.get(text) ?? csvKeywordId(text) : csvKeywordId(x.keywordKey));
        if (text && !x.keywordId && !byText.has(text)) {
          const e = entities.get(id) ?? {
            id, text, intent: guessIntent(text, o.brandTerms ?? []), adgroup: x.adgroup ?? 'CSV_업로드', isBrand: false,
            bid: 0, maxBid: 0, avgRank: 0, monthlySearch: 0, impressionShareLost: 0, status: 'on' as const, landing: '',
            _clicks: 0, _cost: 0, _rankSum: 0, _rankW: 0,
          };
          e.isBrand = e.intent === 'brand';
          if (x.adgroup) e.adgroup = x.adgroup;
          if (x.bid) e.bid = x.bid;
          e._clicks += x.clicks;
          e._cost += x.cost;
          if (x.avgRank !== null && x.impressions > 0) { e._rankSum += x.avgRank * x.impressions; e._rankW += x.impressions; }
          entities.set(id, e);
        }
        return { date: x.date, keywordId: id, impressions: x.impressions, clicks: x.clicks, cost: x.cost, conversions: x.conversions, revenue: x.revenue, avgRank: x.avgRank };
      });
      if (entities.size) {
        const estimatedBid: string[] = [];
        batch.keywords = [...entities.values()].map(({ _clicks, _cost, _rankSum, _rankW, ...k }) => {
          // 입찰가 열이 없으면 평균 CPC를 현재 입찰가 추정치로, 최대 입찰가는 그 1.6배(데모 기본 SAFETY와 같은 비율)로 둔다
          if (!k.bid) estimatedBid.push(k.text);
          const bid = k.bid || (_clicks > 0 ? Math.round(_cost / _clicks / 10) * 10 : 0);
          return { ...k, bid, maxBid: Math.round((bid * 1.6) / 10) * 10, avgRank: _rankW > 0 ? Math.round((_rankSum / _rankW) * 10) / 10 : 0 };
        });
        // 추정값은 추정이라고 남긴다 — 수집 현황 · 데이터 품질 탭에 표시
        batch.warnings = [
          { code: 'estimated_intent', message: `새 키워드 ${entities.size}개의 의도(브랜드 · 비교 · 문제 · 라이프 · 일반)는 문구 기준 추정입니다 — 매체에 등록된 분류가 아닙니다`, detail: { keywords: [...entities.values()].slice(0, 20).map((k) => ({ text: k.text, intent: k.intent })) } },
          ...(estimatedBid.length ? [{ code: 'estimated_bid', message: `입찰가 열이 없는 키워드 ${estimatedBid.length}개는 평균 CPC를 현재 입찰가 추정치로, 그 1.6배를 최대 입찰가로 두었습니다 (추정 — AD Pilot 제안 전에 매체 화면 입찰가를 확인하세요)`, detail: { keywords: estimatedBid.slice(0, 20) } }] : []),
        ];
      }
      break;
    }
  }
  return batch;
}
