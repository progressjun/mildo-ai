/**
 * Google Ads 커넥터 (docs/SAAS_SPEC.md §4 connectors-media) — REST v26, GAQL searchStream, OAuth 갱신 토큰.
 *
 * 공식 문서 (2026-11-02 확인 — 상세 근거는 client.ts 머리말):
 *   https://developers.google.com/google-ads/api/docs/sunset-dates                 v26 최신
 *   https://developers.google.com/google-ads/api/rest/auth                         토큰 · login-customer-id
 *   https://developers.google.com/google-ads/api/docs/api-policy/developer-token   2026-09-09 개발자 토큰 폐지(헤더 선택 · 무시)
 *   https://googleads.googleapis.com/$discovery/rest?version=v26                  REST 스키마 (mutate · searchStream 형식)
 *   https://developers.google.com/google-ads/api/fields/v26/customer · keyword_view · search_term_view   필드 호환
 *
 * 수집 (fetch)
 *   - mediaDaily: FROM customer, segments.date (계정 합계)
 *   - mediaHourly: FROM customer, segments.date + segments.hour (설정 hourlyDays, 기본 35일 — Dataset 시간대 보관과 같음)
 *   - campaigns: 상태 · 일 예산(campaign_budget.amount_micros, 기간 DAILY만) · 오늘 비용
 *   - keywords · keywordDaily: ad_group_criterion(KEYWORD, 제외 키워드 아님) · keyword_view (최근 keywordDays일)
 *     노출 기회 손실률 = 최근 14일 search_rank_lost_impression_share. 평균 게재순위는 Google이 제공하지 않아 0
 *   - searchTermDaily: search_term_view (같은 날 같은 검색어는 광고그룹 합산)
 *   - accounts: 계정 이름 · 최근 7일 평균 비용. 결제는 후불 구조라 잔액 -1 · postpaid
 *   - 계정 통화가 KRW가 아니거나 시간대가 Asia/Seoul이 아니면 경고 (환산하지 않는다)
 *
 * 반영 (apply) — dryRun이면 네트워크 호출 없이 단계만 돌려준다
 *   - bid    : 사전 조회(현재 cpc_bid · 입찰 전략) → adGroupCriteria:mutate { updateMask:'cpcBidMicros', update:{ resourceName, cpcBidMicros } }
 *              자동 입찰 전략 캠페인은 키워드 CPC가 쓰이지 않으므로 멈춘다
 *   - budget : 사전 조회(campaign_budget 리소스 · 공유 여부 · 기간) → campaignBudgets:mutate { updateMask:'amountMicros', update:{ resourceName, amountMicros } }
 *              여러 캠페인이 쓰는 공유 예산 · 기간 예산(CUSTOM_PERIOD)은 멈춘다
 *   - status : campaigns:mutate · adGroupCriteria:mutate { updateMask:'status', update:{ resourceName, status: ENABLED|PAUSED } }
 */
import { z } from 'zod';
import type { ApplyResult, ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { ChangeRequest } from '@/core/types';
import { addDaysStr, kstHour, kstToday, nowMs } from '../../lib/time';
import {
  ApplyAbort, DailyAcc, HourlyAcc, assertNoDrift, clampRange, commonSettingsShape, executePlan, finishFunnel, isoDate, parseHour,
  parseKrwAmount, parseOnOff, softPart, step, tailRange, testOutcome, unsupported, warn, type Funnel,
} from '../naver-sa/media-shared';
import { GOOGLE_LABEL, GoogleAdsClient, cleanCustomerId, gaqlString, type GadsRow, type GoogleAdsCredentials } from './client';
import { MANUAL_BIDDING, accountOf, funnelOfRow, googleTarget, micros, normCampaign, normKeyword, toMicros, type GoogleKeywordSnapshot } from './normalize';

const customerIdField = (label: string) =>
  z.string().trim().transform(cleanCustomerId).pipe(z.string().regex(/^\d{10}$/, `${label}는 10자리 숫자입니다 (하이픈 없이)`));

export const credentialsSchema = z.object({
  clientId: z.string().trim().min(10, 'OAuth 클라이언트 ID를 입력해 주세요'),
  clientSecret: z.string().trim().min(6, 'OAuth 클라이언트 보안 비밀번호를 입력해 주세요'),
  refreshToken: z.string().trim().min(10, '갱신 토큰을 입력해 주세요'),
  customerId: customerIdField('고객 ID'),
  loginCustomerId: z.union([customerIdField('관리자 고객 ID'), z.literal('')]).optional().transform((v) => v || undefined),
  developerToken: z.string().trim().optional().transform((v) => v || undefined),
});

export const settingsSchema = z.object({
  ...commonSettingsShape,
  /** API 버전 (기본 v26 — 2027-11 종료 예정) */
  apiVersion: z.string().regex(/^v\d{2}$/).default('v26'),
  hourlyDays: z.number().int().min(0).max(35).default(35),
  keywordDays: z.number().int().min(0).max(92).default(31),
  /** 키워드를 Dataset 키워드 목록에 넣는다 (media='google' · campaignId · adgroupId로 구분) */
  emitKeywords: z.boolean().default(true),
  /** 검색어(search_term_view) 수집 */
  searchTerms: z.boolean().default(true),
  allowDrift: z.boolean().default(false),
});
export type GoogleAdsSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): GoogleAdsCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ApplyAbort(`${GOOGLE_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): GoogleAdsSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}

const between = (a: string, b: string) => `segments.date BETWEEN ${gaqlString(a)} AND ${gaqlString(b)}`;
const METRICS = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';

export const QUERIES = {
  customer: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1',
  daily: (a: string, b: string) => `SELECT segments.date, ${METRICS} FROM customer WHERE ${between(a, b)}`,
  hourly: (a: string, b: string) => `SELECT segments.date, segments.hour, ${METRICS} FROM customer WHERE ${between(a, b)}`,
  campaigns:
    "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period FROM campaign WHERE campaign.status != 'REMOVED'",
  campaignCostToday: (d: string) => `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE ${between(d, d)} AND campaign.status != 'REMOVED'`,
  keywords:
    "SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, ad_group.id, ad_group.name, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.final_urls FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
  keywordLostShare: (a: string, b: string) => `SELECT ad_group.id, ad_group_criterion.criterion_id, metrics.search_rank_lost_impression_share FROM keyword_view WHERE ${between(a, b)}`,
  keywordDaily: (a: string, b: string) => `SELECT segments.date, ad_group.id, ad_group_criterion.criterion_id, ${METRICS} FROM keyword_view WHERE ${between(a, b)}`,
  searchTerms: (a: string, b: string) => `SELECT segments.date, search_term_view.search_term, ${METRICS} FROM search_term_view WHERE ${between(a, b)}`,
  weekCost: (a: string, b: string) => `SELECT metrics.cost_micros FROM customer WHERE ${between(a, b)}`,
  criterionNow: (cid: string, ag: string, crit: string) =>
    `SELECT ad_group_criterion.resource_name, ad_group_criterion.cpc_bid_micros, ad_group_criterion.status, campaign.bidding_strategy_type FROM ad_group_criterion WHERE ad_group_criterion.resource_name = ${gaqlString(`customers/${cid}/adGroupCriteria/${ag}~${crit}`)}`,
  budgetNow: (campaignId: string) =>
    `SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.period FROM campaign WHERE campaign.id = ${String(campaignId).replace(/\D/g, '')}`,
};

/* ------------------------------ 수집 ------------------------------ */

export async function fetchGoogleAds(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const creds = parseCreds(ctx);
  const g = new GoogleAdsClient(ctx, creds, { version: s.apiVersion, now: nowMs });
  const today = kstToday();
  const hour = kstHour();
  const intraday = opts.intradayDate;
  const r = intraday ? clampRange({ from: intraday, to: intraday }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { mediaDaily: [], mediaHourly: [], campaigns: [], accounts: [], warnings: [] };

  const customer = (await g.search(QUERIES.customer, '계정 정보 조회'))[0]?.customer;
  if (customer?.currencyCode && customer.currencyCode !== 'KRW') warn(batch, 'currency_not_krw', `계정 통화가 ${customer.currencyCode}입니다 — 금액을 원으로 환산하지 않고 계정 통화 그대로 저장했습니다`);
  if (customer?.timeZone && customer.timeZone !== 'Asia/Seoul') warn(batch, 'timezone_not_kst', `계정 시간대가 ${customer.timeZone}입니다 — 일자 · 시간대가 KST와 어긋날 수 있습니다`);

  if (r) {
    const daily = new DailyAcc();
    for (const row of await g.search(QUERIES.daily(r.from, r.to), '일별 성과 조회')) {
      const d = isoDate(row.segments?.date);
      if (d) daily.add(d, funnelOfRow(row));
    }
    batch.mediaDaily = daily.rows('google');

    const hr = s.hourlyDays > 0 ? tailRange(r, addDaysStr(today, -(s.hourlyDays - 1))) : null;
    if (hr) {
      await softPart(batch, 'hourly_failed', '시간대 성과', async () => {
        const hourly = new HourlyAcc();
        for (const row of await g.search(QUERIES.hourly(hr.from, hr.to), '시간대 성과 조회')) {
          const d = isoDate(row.segments?.date);
          const h = parseHour(row.segments?.hour);
          if (d && h !== null && !(d === today && h > hour)) hourly.add(d, h, funnelOfRow(row));
        }
        batch.mediaHourly = hourly.rows('google');
      });
    }
  }

  // 캠페인 · 오늘 비용
  const spent = new Map<string, number>();
  for (const row of await g.search(QUERIES.campaignCostToday(today), '오늘 캠페인 비용 조회')) {
    const id = String(row.campaign?.id ?? '');
    spent.set(id, (spent.get(id) ?? 0) + micros(row.metrics?.costMicros));
  }
  batch.campaigns = (await g.search(QUERIES.campaigns, '캠페인 조회')).map((row) => normCampaign(row, spent.get(String(row.campaign?.id ?? '')) ?? 0, hour, s.intentRules));
  const periodBudgets = batch.campaigns.filter((c) => c.dailyBudget === 0 && c.status !== 'off').length;
  if (periodBudgets) warn(batch, 'budget_not_daily', `캠페인 ${periodBudgets}개는 일 예산이 아니거나(기간 예산) 0이라 일 예산을 0으로 두었습니다`);

  if (!intraday && r) {
    if (s.emitKeywords) await softPart(batch, 'keywords_failed', '키워드', () => collectKeywords(g, s, r, today, batch));
    const tr = s.searchTerms && s.keywordDays > 0 ? tailRange(r, addDaysStr(r.to, -(s.keywordDays - 1))) : null;
    if (tr) {
      await softPart(batch, 'search_terms_failed', '검색어', async () => {
        const acc = new Map<string, Funnel & { date: string; term: string }>();
        for (const row of await g.search(QUERIES.searchTerms(tr.from, tr.to), '검색어 성과 조회')) {
          const d = isoDate(row.segments?.date);
          const term = row.searchTermView?.searchTerm;
          if (!d || !term) continue;
          const k = `${d}|${term}`;
          const cur = acc.get(k) ?? { date: d, term, impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
          const f = funnelOfRow(row);
          cur.impressions += f.impressions; cur.clicks += f.clicks; cur.cost += f.cost; cur.conversions += f.conversions; cur.revenue += f.revenue;
          acc.set(k, cur);
        }
        batch.searchTermDaily = [...acc.values()].map(({ date, term, ...f }) => ({ date, term, ...finishFunnel(f) }));
      });
    }
  }

  const week = await softPart(batch, 'account_failed', '최근 7일 비용', async () => (await g.search(QUERIES.weekCost(addDaysStr(today, -7), addDaysStr(today, -1)), '최근 7일 비용 조회')).reduce((a, row) => a + micros(row.metrics?.costMicros), 0));
  batch.accounts = [accountOf(customer, g.customerId, Math.round((week ?? 0) / 7), s.owner)];

  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

async function collectKeywords(g: GoogleAdsClient, s: GoogleAdsSettings, r: DateRange, today: string, batch: NormalizedBatch): Promise<void> {
  const rows = await g.search(QUERIES.keywords, '키워드 조회');
  const lost = new Map<string, number>();
  for (const row of await g.search(QUERIES.keywordLostShare(addDaysStr(today, -14), addDaysStr(today, -1)), '노출 손실률 조회')) {
    const v = row.metrics?.searchRankLostImpressionShare;
    if (typeof v === 'number') lost.set(`${row.adGroup?.id}-${row.adGroupCriterion?.criterionId}`, v);
  }
  let derived = 0;
  let automated = 0;
  const snaps: GoogleKeywordSnapshot[] = rows.map((row) => {
    const n = normKeyword(row, lost.get(`${row.adGroup?.id}-${row.adGroupCriterion?.criterionId}`) ?? 0, s);
    if (n.maxBidDerived) derived++;
    if (row.campaign?.biddingStrategyType && !MANUAL_BIDDING.has(row.campaign.biddingStrategyType)) automated++;
    return n.keyword;
  });
  const keywordDaily: NonNullable<NormalizedBatch['keywordDaily']> = [];
  if (s.keywordDays > 0) {
    const kr = tailRange(r, addDaysStr(r.to, -(s.keywordDays - 1)));
    if (kr) {
      for (const row of await g.search(QUERIES.keywordDaily(kr.from, kr.to), '키워드 일별 성과 조회')) {
        const d = isoDate(row.segments?.date);
        if (!d || !row.adGroup?.id || !row.adGroupCriterion?.criterionId) continue;
        const f = finishFunnel(funnelOfRow(row));
        if (!f.impressions && !f.clicks && !f.cost && !f.conversions) continue;
        keywordDaily.push({ date: d, keywordId: `gads-kw-${row.adGroup.id}-${row.adGroupCriterion.criterionId}`, ...f, avgRank: null });
      }
      if (kr.from > r.from) warn(batch, 'keyword_window', `키워드 일별 · 검색어는 최근 ${s.keywordDays}일(${kr.from} 이후)만 수집했습니다`);
    }
  }
  batch.keywords = snaps;
  batch.keywordDaily = keywordDaily;
  if (derived) warn(batch, 'max_bid_default', `키워드 ${derived}개는 최대 입찰가 설정이 없어 현재 입찰가 × ${s.maxBidMultiplier}로 안전 상한을 잡았습니다 — 커넥션 설정 maxBid 지정 권장`);
  if (automated) warn(batch, 'automated_bidding', `키워드 ${automated}개는 자동 입찰 전략 캠페인에 있어 키워드 CPC 입찰가 변경이 적용되지 않습니다 (반영 시 멈춤)`);
}

/* ------------------------------ 반영 ------------------------------ */

export async function applyGoogleAds(ctx: ConnectorContext, change: ChangeRequest): Promise<ApplyResult> {
  const s = parseSettings(ctx);
  let g: GoogleAdsClient;
  try {
    g = new GoogleAdsClient(ctx, parseCreds(ctx), { version: s.apiVersion, now: nowMs });
  } catch (e) {
    return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: (e as Error).message };
  }
  const t = googleTarget(change.targetId);
  if (!t) return unsupported(change, GOOGLE_LABEL, `대상 id(${change.targetId ?? '—'})가 Google Ads 캠페인(gads-cmp-) · 키워드(gads-kw-) 형식이 아닙니다`);
  const cid = g.customerId;

  if (change.kind === 'bid') {
    if (t.type !== 'keyword') return unsupported(change, GOOGLE_LABEL, '입찰가 변경은 키워드(gads-kw-) 대상만 지원합니다');
    const after = parseKrwAmount(change.after);
    if (after === null) return { ok: false, request: { targetId: change.targetId }, error: '입찰가 값이 올바르지 않습니다' };
    const resourceName = `customers/${cid}/adGroupCriteria/${t.adGroupId}~${t.criterionId}`;
    const ops = [{ updateMask: 'cpcBidMicros', update: { resourceName, cpcBidMicros: toMicros(after) } }];
    const pre = QUERIES.criterionNow(cid, t.adGroupId, t.criterionId);
    return executePlan(ctx, {
      label: GOOGLE_LABEL, what: '키워드 CPC 입찰가 변경', intended: after,
      steps: [step(g.searchRequest(pre), '현재 입찰가 · 입찰 전략 확인'), step(g.mutateRequest('adGroupCriteria', ops))],
      live: async () => {
        const cur = (await g.search(pre, '현재 입찰가 조회'))[0];
        if (!cur) throw new ApplyAbort(`키워드(${resourceName})를 찾을 수 없습니다 — 삭제되었거나 다른 계정입니다`);
        const strat = cur.campaign?.biddingStrategyType;
        if (strat && !MANUAL_BIDDING.has(strat)) throw new ApplyAbort(`자동 입찰 전략(${strat}) 캠페인입니다 — 키워드 CPC 입찰가가 쓰이지 않아 반영하지 않았습니다`);
        assertNoDrift('키워드 입찰가', change.before, cur.adGroupCriterion?.cpcBidMicros ? micros(cur.adGroupCriterion.cpcBidMicros) : null, after, s.allowDrift);
        const res = await g.mutate<{ adGroupCriterion?: { cpcBidMicros?: string } }>('adGroupCriteria', ops, '키워드 입찰가 변경');
        const v = res.results?.[0]?.adGroupCriterion?.cpcBidMicros;
        return { response: res, appliedValue: v ? micros(v) : after };
      },
    });
  }

  if (change.kind === 'budget') {
    if (t.type !== 'campaign') return unsupported(change, GOOGLE_LABEL, '일 예산은 캠페인(gads-cmp-) 대상만 지원합니다');
    const after = parseKrwAmount(change.after);
    if (after === null) return { ok: false, request: { targetId: change.targetId }, error: '일 예산 값이 올바르지 않습니다' };
    const pre = QUERIES.budgetNow(t.campaignId);
    const planned = [{ updateMask: 'amountMicros', update: { resourceName: '(사전 조회한 campaign_budget.resource_name)', amountMicros: toMicros(after) } }];
    return executePlan(ctx, {
      label: GOOGLE_LABEL, what: '캠페인 일 예산 변경', intended: after,
      steps: [step(g.searchRequest(pre), '캠페인 예산 리소스 · 공유 여부 · 현재 금액 확인'), step(g.mutateRequest('campaignBudgets', planned))],
      live: async () => {
        const cur = (await g.search(pre, '캠페인 예산 조회'))[0];
        const b = cur?.campaignBudget;
        if (!b?.resourceName) throw new ApplyAbort(`캠페인(${t.campaignId})의 예산을 찾을 수 없습니다`);
        if (b.period && b.period !== 'DAILY') throw new ApplyAbort(`기간 예산(${b.period}) 캠페인입니다 — 일 예산 변경 대상이 아니어서 반영하지 않았습니다`);
        if (b.explicitlyShared && Number(b.referenceCount ?? 0) > 1) throw new ApplyAbort(`공유 예산(캠페인 ${b.referenceCount}개 사용)입니다 — 다른 캠페인 예산도 바뀌므로 반영하지 않았습니다`);
        assertNoDrift('일 예산', change.before, micros(b.amountMicros), after, s.allowDrift);
        const ops = [{ updateMask: 'amountMicros', update: { resourceName: b.resourceName, amountMicros: toMicros(after) } }];
        const res = await g.mutate<{ campaignBudget?: { amountMicros?: string } }>('campaignBudgets', ops, '캠페인 일 예산 변경');
        const v = res.results?.[0]?.campaignBudget?.amountMicros;
        return { response: res, appliedValue: v ? micros(v) : after, notes: [`예산 리소스 ${b.resourceName}`] };
      },
    });
  }

  if (change.kind === 'status') {
    const onoff = parseOnOff(change.after);
    if (!onoff) return { ok: false, request: { targetId: change.targetId }, error: `상태 값(${String(change.after)})을 on/off로 해석할 수 없습니다` };
    const status = onoff === 'on' ? 'ENABLED' : 'PAUSED';
    const [service, resourceName] = t.type === 'campaign'
      ? (['campaigns', `customers/${cid}/campaigns/${t.campaignId}`] as const)
      : (['adGroupCriteria', `customers/${cid}/adGroupCriteria/${t.adGroupId}~${t.criterionId}`] as const);
    const ops = [{ updateMask: 'status', update: { resourceName, status } }];
    return executePlan(ctx, {
      label: GOOGLE_LABEL, what: `${t.type === 'campaign' ? '캠페인' : '키워드'} ${status}`, intended: onoff,
      steps: [step(g.mutateRequest(service, ops))],
      live: async () => {
        const res = await g.mutate<{ campaign?: { status?: string }; adGroupCriterion?: { status?: string } }>(service, ops, '상태 변경');
        const v = res.results?.[0]?.campaign?.status ?? res.results?.[0]?.adGroupCriterion?.status;
        return { response: res, appliedValue: v ? (v === 'ENABLED' ? 'on' : 'off') : onoff };
      },
    });
  }

  return unsupported(change, GOOGLE_LABEL);
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'google_ads',
  kind: 'media',
  channel: 'google',
  label: GOOGLE_LABEL,
  docsUrl: 'https://developers.google.com/google-ads/api/rest/overview',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'clientId', label: 'OAuth 클라이언트 ID', secret: false, help: 'Google Cloud Console > API 및 서비스 > 사용자 인증 정보에서 만든 OAuth 2.0 클라이언트 ID (Google Ads API를 사용 설정한 프로젝트)' },
    { key: 'clientSecret', label: 'OAuth 클라이언트 보안 비밀번호', secret: true, help: '같은 OAuth 클라이언트의 보안 비밀번호' },
    { key: 'refreshToken', label: '갱신 토큰 (refresh token)', secret: true, help: 'Google Ads 계정 권한이 있는 사용자로 https://www.googleapis.com/auth/adwords 범위에 동의해 받은 갱신 토큰' },
    { key: 'customerId', label: '고객 ID', secret: false, help: 'Google Ads 화면 오른쪽 위 10자리 고객 ID (하이픈은 자동 제거)' },
    { key: 'loginCustomerId', label: '관리자 계정 고객 ID', secret: false, optional: true, help: 'MCC(관리자 계정)를 거쳐 접근할 때만 입력 — login-customer-id 헤더로 보냅니다' },
    { key: 'developerToken', label: '개발자 토큰 (선택)', secret: true, optional: true, help: '2026-09-09 이후 개발자 토큰은 필요 없고 서버가 무시합니다. 비워 두세요 — 접근 등급은 Cloud 프로젝트(Explorer 이상)로 관리됩니다' },
  ],
  capabilities: {
    reads: ['mediaDaily', 'mediaHourly', 'keywordDaily', 'searchTermDaily', 'keywords', 'campaigns', 'accounts'],
    writes: ['bid', 'budget', 'status'],
    intraday: true,
    // 문서에 보고 기간 상한이 명시되어 있지 않아 스펙 §4 백필 상한(400일)을 쓴다
    maxBackfillDays: 400,
  },
  async test(ctx) {
    return testOutcome(async () => {
      const s = parseSettings(ctx);
      const g = new GoogleAdsClient(ctx, parseCreds(ctx), { version: s.apiVersion, now: nowMs });
      const c = (await g.search(QUERIES.customer, '계정 정보 조회'))[0]?.customer;
      const notes: string[] = [];
      if (c?.currencyCode && c.currencyCode !== 'KRW') notes.push(`통화 ${c.currencyCode}(원 환산 안 함)`);
      if (c?.timeZone && c.timeZone !== 'Asia/Seoul') notes.push(`시간대 ${c.timeZone}(KST 아님)`);
      if (c?.manager) notes.push('관리자 계정입니다 — 성과는 하위 광고 계정 고객 ID로 연결해 주세요');
      if (c?.testAccount) notes.push('테스트 계정입니다 (실제 집행 데이터 아님)');
      const name = c?.descriptiveName ?? g.customerId;
      return {
        ok: !c?.manager,
        account: `Google Ads ${name} (${g.customerId})`,
        message: `연결 확인 — ${name} (${g.customerId}) · 통화 ${c?.currencyCode ?? '—'} · 시간대 ${c?.timeZone ?? '—'}${notes.length ? ` · 확인 필요: ${notes.join(', ')}` : ''}`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchGoogleAds(ctx, range, opts),
  apply: (ctx, change) => applyGoogleAds(ctx, change),
};
