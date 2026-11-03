/**
 * 네이버 검색광고 응답 픽스처 — 공식 Swagger 정의(https://naver.github.io/searchad-apidoc/)의 필드 이름 · 형태로 만든 테스트 데이터.
 * 값은 TEST DATA (실계정 응답 아님). id 형식은 릴리스 노트 예시(cmp-a001-01-000000001234567 등)를 따른다.
 */
import type { NaverAdgroup, NaverCampaign, NaverKeyword, NaverStatRow } from './client';
import type { FakeRoute } from './fake-http';

export const CID_BRAND = 'cmp-a001-01-000000000000001';
export const CID_GENERIC = 'cmp-a001-01-000000000000002';
export const CID_SHOP = 'cmp-a001-02-000000000000003';
export const CID_DELETED = 'cmp-a001-01-000000000000009';
export const GRP_BRAND = 'grp-a001-01-000000000000011';
export const GRP_GENERIC = 'grp-a001-01-000000000000021';
export const KW_BRAND = 'nkw-a001-01-000000000000101';
export const KW_GENERIC = 'nkw-a001-01-000000000000201';
export const KW_GENERIC2 = 'nkw-a001-01-000000000000202';

export const campaigns: NaverCampaign[] = [
  { nccCampaignId: CID_BRAND, customerId: 1234567, name: '브랜드 방어', campaignTp: 'WEB_SITE', userLock: false, status: 'ELIGIBLE', dailyBudget: 300000, useDailyBudget: true },
  { nccCampaignId: CID_GENERIC, customerId: 1234567, name: '일반 제품', campaignTp: 'WEB_SITE', userLock: false, status: 'ELIGIBLE', statusReason: 'CAMPAIGN_LIMITED_BY_BUDGET', dailyBudget: 500000, useDailyBudget: true },
  { nccCampaignId: CID_SHOP, customerId: 1234567, name: '쇼핑검색', campaignTp: 'SHOPPING', userLock: true, status: 'PAUSED', dailyBudget: 0, useDailyBudget: false },
  { nccCampaignId: CID_DELETED, customerId: 1234567, name: '삭제된 캠페인', campaignTp: 'WEB_SITE', userLock: false, status: 'DELETED', delFlag: true },
];
export const adgroups: Record<string, NaverAdgroup[]> = {
  [CID_BRAND]: [{ nccAdgroupId: GRP_BRAND, nccCampaignId: CID_BRAND, name: '브랜드 키워드', adgroupType: 'WEB_SITE', bidAmt: 500, userLock: false, status: 'ELIGIBLE' }],
  [CID_GENERIC]: [{ nccAdgroupId: GRP_GENERIC, nccCampaignId: CID_GENERIC, name: '매트리스 일반', adgroupType: 'WEB_SITE', bidAmt: 700, userLock: false, status: 'ELIGIBLE' }],
};
export const keywords: Record<string, NaverKeyword[]> = {
  [GRP_BRAND]: [{ nccKeywordId: KW_BRAND, nccAdgroupId: GRP_BRAND, nccCampaignId: CID_BRAND, keyword: '수면밀도', bidAmt: 1200, useGroupBidAmt: false, userLock: false, status: 'ELIGIBLE', links: '{"pc":{"final":"https://brand.naver.com/mildo"},"mobile":{"final":"https://m.brand.naver.com/mildo"}}' }],
  [GRP_GENERIC]: [
    { nccKeywordId: KW_GENERIC, nccAdgroupId: GRP_GENERIC, nccCampaignId: CID_GENERIC, keyword: '퀸 매트리스', bidAmt: 900, useGroupBidAmt: false, userLock: false, status: 'ELIGIBLE' },
    { nccKeywordId: KW_GENERIC2, nccAdgroupId: GRP_GENERIC, nccCampaignId: CID_GENERIC, keyword: '매트리스 가격', bidAmt: 70, useGroupBidAmt: true, userLock: true, status: 'PAUSED' },
  ],
};

/** 캠페인 · 키워드 · 날짜별 결정적 통계 */
export function statFor(id: string, date: string): NaverStatRow {
  const seed = [...`${id}|${date}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100_003, 7);
  const imp = 1000 + (seed % 900);
  const clk = 20 + (seed % 40);
  return { id, impCnt: imp, clkCnt: clk, salesAmt: clk * 550, ccnt: 3, convAmt: 990000, purchaseCcnt: 2, purchaseConvAmt: 780000, avgRnk: 2.4 };
}

const q = (req: { query?: Record<string, unknown> }, k: string) => String(req.query?.[k] ?? '');

/** /stats 라우트 — 요청 쿼리(ids · id · timeRange · breakdown)대로 응답 */
export function statsRoute(o: { today: string; cycleBaseTm?: string; omitPurchase?: boolean } ): FakeRoute {
  return {
    method: 'GET',
    match: '/stats',
    reply: (req) => {
      const tr = JSON.parse(q(req, 'timeRange') || '{}') as { since: string; until: string };
      const strip = (r: NaverStatRow): NaverStatRow => (o.omitPurchase ? { ...r, purchaseCcnt: undefined, purchaseConvAmt: undefined } : r);
      if (q(req, 'id')) {
        // 단건 일자별 (timeIncrement=1)
        const rows: NaverStatRow[] = [];
        for (let d = tr.since; d <= tr.until; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
          const s = strip(statFor(q(req, 'id'), d));
          delete s.id;
          rows.push({ ...s, dateStart: d, dateEnd: d });
        }
        return { data: { data: rows } };
      }
      const ids = q(req, 'ids').split(',');
      const single = tr.since === tr.until;
      if (q(req, 'breakdown') === 'hh24') {
        return {
          data: {
            data: ids.map((id) => ({
              id,
              breakdowns: [9, 10, 23].map((h) => ({ ...strip(statFor(`${id}#${h}`, tr.since)), id: undefined, name: `${String(h).padStart(2, '0')}시~${String(h + 1).padStart(2, '0')}시` })),
            })),
          },
        };
      }
      return {
        data: {
          data: ids.map((id) => (single ? strip(statFor(id, tr.since)) : { ...strip(statFor(id, tr.since)), salesAmt: 70_000 })),
          ...(o.cycleBaseTm && tr.since === o.today ? { cycleBaseTm: o.cycleBaseTm } : {}),
        },
      };
    },
  };
}

export function naverRoutes(o: { today: string; bizmoney?: number; omitPurchase?: boolean }): FakeRoute[] {
  return [
    { method: 'GET', match: '/ncc/campaigns', reply: { data: campaigns } },
    { method: 'GET', match: '/ncc/adgroups', reply: (req) => ({ data: adgroups[q(req, 'nccCampaignId')] ?? [] }) },
    { method: 'GET', match: '/ncc/keywords', reply: (req) => ({ data: keywords[q(req, 'nccAdgroupId')] ?? [] }) },
    { method: 'GET', match: '/billing/bizmoney', reply: { data: { bizmoney: o.bizmoney ?? 1_500_000, budgetLock: false, refundLock: false, customerId: 1234567 } } },
    { method: 'GET', match: '/keywordstool', reply: { data: { keywordList: [{ relKeyword: '퀸매트리스', monthlyPcQcCnt: 1200, monthlyMobileQcCnt: 8800, compIdx: '높음' }, { relKeyword: '수면밀도', monthlyPcQcCnt: '< 10', monthlyMobileQcCnt: 300 }] } } },
    statsRoute({ today: o.today, cycleBaseTm: `${o.today.replace(/-/g, '')}1300`, omitPurchase: o.omitPurchase }),
  ];
}
