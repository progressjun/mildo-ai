/**
 * 네이버 검색광고 커넥터 (docs/SAAS_SPEC.md §4 connectors-media).
 *
 * 공식 문서 (2026-11-02 확인 — 상세 근거는 client.ts · normalize.ts 머리말):
 *   https://naver.github.io/searchad-apidoc/                    API 레퍼런스 (Campaign · Adgroup · Keyword · Stat · Bizmoney)
 *   https://github.com/naver/searchad-apidoc/wiki/FAQ           429 · 타임스탬프 · 상태값
 *   https://github.com/naver/searchad-apidoc/wiki/FAQ-stat      /stats 구간 · 보관 한도 (breakdown 7일)
 *   https://naver.github.io/searchad-apidoc/feed.xml            릴리스 노트 (구매완료 전환 지표 2026-03-30)
 *
 * 수집 (fetch)
 *   - 캠페인 → 광고그룹 → 키워드 (baseSearchId · recordSize 페이지), 삭제 엔티티 제외
 *   - mediaDaily: 캠페인 통계 합계. 호출 수가 적은 쪽을 고른다 — 날짜별 ids 묶음(/stats?ids, 하루 구간) 또는 캠페인별 일자 통계(/stats?id&timeIncrement=1, 92일 구간)
 *   - mediaHourly: breakdown=hh24 (문서상 파워링크 최근 7일만 제공)
 *   - keywordDaily: 키워드 ids 묶음 × 날짜 (설정 keywordDays, 기본 31일 — 범위가 더 길면 최근 구간만 + 경고)
 *   - keywords: 현재 입찰가 · ON/OFF · 최근 14일 평균 노출 순위. 노출 기회 손실률은 API 미제공이라 0 (경고)
 *   - campaigns: 하루 예산 · 오늘 소진(오늘 통계) · 상태, hourOfData = cycleBaseTm(최신 집계 시각)
 *   - accounts: 비즈머니 잔액 · 최근 7일 평균 소진. 자동충전 상태는 API 미제공 → 설정 autoCharge 값(기본 off)
 *   - 검색어(searchTermDaily): 확장 검색어 보고서(STAT-REPORT EXPKEYWORD)의 TSV 열 정의를 공식 문서에서 확인하지 못해 API 수집하지 않는다.
 *     TODO(근거 부족): 열 정의가 공개되면 /stat-reports 비동기 보고서로 구현. 그 전까지는 CSV 검색어 템플릿(search_term_daily)으로 올린다.
 *
 * 반영 (apply) — dryRun이면 네트워크 호출 없이 아래 단계를 그대로 돌려준다
 *   - bid    : GET /ncc/keywords/{id}(광고그룹 ID · 현재 입찰가 확인) → PUT /ncc/keywords/{id}?fields=bidAmt { nccKeywordId, nccAdgroupId, bidAmt, useGroupBidAmt:false }
 *   - budget : GET /ncc/campaigns/{id}(공유 예산 · 현재 값 확인) → PUT /ncc/campaigns/{id}?fields=budget { nccCampaignId, dailyBudget, useDailyBudget:true }
 *              (광고그룹 grp- 대상이면 /ncc/adgroups/{id}?fields=budget)
 *   - status : userLock (true = OFF) — 키워드 ?fields=userLock (광고그룹 ID 확인 후) · 캠페인 · 광고그룹
 *   - keyword_add : AD Pilot 테스트 후보 등록(대상 'term:<검색어>', after '<의도>_TEST · 입찰 <금액>원')
 *              GET /ncc/keywords?nccAdgroupId(중복 확인) → POST /ncc/keywords?nccAdgroupId [{ keyword, bidAmt, useGroupBidAmt:false, userLock:false }]
 *              등록할 광고그룹은 설정 testAdgroups(의도 → grp- ID)로 정한다 — 없으면 보내지 않고 오류. 같은 키워드가 이미 있으면 다시 만들지 않는다
 *   - keyword_exclude : 문서상 POST /ncc/adgroups/{id}/restricted-keywords가 있으나, 현재 변경 요청(Flow · Lab)의 대상 id는
 *              'lab:term:<slug>' · 'labdec:<id>'라 변경 실행기가 '기록만'으로 처리한다(커넥터까지 오지 않음) — writes에 넣지 않는다
 *   현재 값이 요청 시점 값(before)과 다르면 덮어쓰지 않고 멈춘다(설정 allowDrift로 끌 수 있음).
 */
import { z } from 'zod';
import type { ApplyChange, ApplyResult, ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { AdAccount, ChangeRequest, IntentId } from '@/core/types';
import { addDaysStr, dateRange, kstHour, kstToday, nowMs } from '../../lib/time';
import {
  ApplyAbort, DailyAcc, HourlyAcc, assertNoDrift, chunk, clampRange, commonSettingsShape, executePlan, finishFunnel, isoDate, krw,
  num, parseKrwAmount, parseOnOff, softPart, splitRange, step, tailRange, testOutcome, unsupported, warn, type Funnel,
} from './media-shared';
import { NAVER_SA_LABEL, NaverSaClient, STAT_FIELDS, parseVolume, type NaverAdgroup, type NaverCampaign, type NaverKeyword, type NaverSaCredentials, type NaverStatRow } from './client';
import { NAVER_BID_MAX, NAVER_BID_MIN, breakdownHour, funnelOf, isDeleted, normCampaign, normKeyword, type KeywordSnapshot } from './normalize';

export const credentialsSchema = z.object({
  apiKey: z.string().trim().min(8, '액세스 라이선스를 입력해 주세요'),
  secretKey: z.string().trim().min(8, '비밀키를 입력해 주세요'),
  customerId: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{3,15}$/, '고객 ID는 숫자입니다')),
});

const grpId = z.string().trim().regex(/^grp-[A-Za-z0-9]+-\d+-\d+$/, '광고그룹 ID(grp-…) 형식이 아닙니다');

export const settingsSchema = z.object({
  ...commonSettingsShape,
  /** 수집할 캠페인 유형 (미설정 = 전체). 키워드는 파워링크(WEB_SITE) 광고그룹에서만 수집 */
  campaignTypes: z.array(z.enum(['WEB_SITE', 'SHOPPING', 'POWER_CONTENTS', 'BRAND_SEARCH', 'PLACE'])).optional(),
  /** 전환 지표: purchase = 구매완료(purchaseCcnt · purchaseConvAmt), all = 전체 전환(ccnt · convAmt) */
  conversionMetric: z.enum(['purchase', 'all']).default('purchase'),
  /** 비용 기준: 매체 보고(VAT 포함) 그대로 또는 VAT 제외(÷1.1) */
  costBasis: z.enum(['vat_included', 'vat_excluded']).default('vat_included'),
  /** 키워드 일별 통계를 받을 최근 일수 (호출 수 관리) */
  keywordDays: z.number().int().min(0).max(92).default(31),
  /** 시간대 통계 일수 (문서상 최대 7일) */
  hourlyDays: z.number().int().min(0).max(7).default(7),
  /** 연관 키워드 도구로 월간 검색량 채우기 (키워드 5개당 1회 호출, IP 단위 호출 제한) */
  fetchSearchVolume: z.boolean().default(false),
  /** 자동충전 상태 (API 미제공 — 광고 관리 화면 기준으로 입력) */
  autoCharge: z.enum(['ok', 'off']).default('off'),
  accountName: z.string().optional(),
  /** 현재 값이 요청 시점 값과 달라도 반영 (기본 끔) */
  allowDrift: z.boolean().default(false),
  /** /stats ids 묶음 크기 */
  statsChunk: z.number().int().min(1).max(200).default(100),
  /** 테스트 후보(keyword_add)를 등록할 광고그룹 — 구매 의도별 grp- ID (예: { generic: 'grp-a001-01-000000012345678' }) */
  testAdgroups: z.object({ brand: grpId.optional(), generic: grpId.optional(), problem: grpId.optional(), compare: grpId.optional(), life: grpId.optional() }).default({}),
});
export type NaverSaSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): NaverSaCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ApplyAbort(`${NAVER_SA_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): NaverSaSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}
const clientOf = (ctx: ConnectorContext, s: NaverSaSettings) => new NaverSaClient(ctx, parseCreds(ctx), { now: nowMs, statsChunk: s.statsChunk });

/* ------------------------------ 수집 ------------------------------ */

export async function fetchNaverSa(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const creds = parseCreds(ctx);
  const client = new NaverSaClient(ctx, creds, { now: nowMs, statsChunk: s.statsChunk });
  const today = kstToday();
  const nowHour = kstHour();
  const intraday = opts.intradayDate;
  const r = intraday ? clampRange({ from: intraday, to: intraday }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { mediaDaily: [], mediaHourly: [], campaigns: [], accounts: [], warnings: [] };

  let fallbackSeen = false;
  const conv = (row: NaverStatRow): Funnel => {
    const x = funnelOf(row, s.conversionMetric, s.costBasis);
    if (x.fallback) fallbackSeen = true;
    return x.funnel;
  };

  let campaigns = (await client.campaigns()).filter((c) => !isDeleted(c));
  if (s.campaignTypes?.length) campaigns = campaigns.filter((c) => !c.campaignTp || s.campaignTypes!.includes(c.campaignTp as never));
  const cids = campaigns.map((c) => c.nccCampaignId);

  // 오늘 캠페인별 소진 (스냅샷 · 오늘 일별 행)
  const todayStats = cids.length ? await client.statsSummary(cids, today, today) : { rows: [], cycleHour: null };
  const todayById = new Map(todayStats.rows.map((x) => [String(x.id), x]));
  const hourOfData = todayStats.cycleHour ?? nowHour;
  batch.campaigns = campaigns.map((c) => normCampaign(c, conv(todayById.get(c.nccCampaignId) ?? {}).cost, hourOfData, s));

  if (r && cids.length) {
    const dates = dateRange(r.from, r.to);
    const daily = new DailyAcc();
    if (dates.includes(today)) for (const row of todayStats.rows) daily.add(today, conv(row));
    const past = dates.filter((d) => d !== today);
    if (past.length) {
      const perDayCalls = past.length * Math.ceil(cids.length / s.statsChunk);
      const perCampaignCalls = cids.length * Math.ceil(past.length / 92);
      if (perDayCalls <= perCampaignCalls) {
        for (const d of past) for (const row of (await client.statsSummary(cids, d, d)).rows) daily.add(d, conv(row));
      } else {
        const pastSet = new Set(past);
        for (const cid of cids) {
          for (const w of splitRange(past[0], past[past.length - 1], 92)) {
            for (const row of await client.statsDaily(cid, w.from, w.to)) {
              const d = isoDate(row.dateStart);
              if (d && pastSet.has(d)) daily.add(d, conv(row));
            }
          }
        }
      }
    }
    batch.mediaDaily = daily.rows('naver_sa');

    // 시간대 (최근 hourlyDays일)
    const hourlyFrom = addDaysStr(today, -(Math.max(1, s.hourlyDays) - 1));
    const hourlyDates = s.hourlyDays > 0 ? dates.filter((d) => d >= hourlyFrom) : [];
    await softPart(batch, 'hourly_failed', '시간대 통계', async () => {
      const hourly = new HourlyAcc();
      for (const d of hourlyDates) {
        for (const row of (await client.statsSummary(cids, d, d, { breakdown: 'hh24' })).rows) {
          for (const b of row.breakdowns ?? []) {
            const h = breakdownHour(b.name);
            if (h === null || (d === today && h > nowHour)) continue;
            hourly.add(d, h, conv(b));
          }
        }
      }
      batch.mediaHourly = hourly.rows('naver_sa');
    });
    if (!intraday && s.hourlyDays > 0 && r.from < hourlyFrom) {
      warn(batch, 'hourly_window', `시간대 통계는 최근 ${s.hourlyDays}일(${hourlyFrom} 이후)만 수집했습니다 — 네이버 문서상 시간대(breakdown) 통계 보관 7일`);
    }
  }

  if (!intraday) await softPart(batch, 'keywords_failed', '키워드', () => collectKeywords(client, s, campaigns, r, today, batch, conv));

  const account = await softPart(batch, 'account_failed', '계정 · 비즈머니', () => accountSnapshot(client, creds, s, cids, today, conv, batch));
  if (account) batch.accounts = [account];

  if (fallbackSeen) warn(batch, 'conversion_fallback', '구매완료 전환 지표(purchaseCcnt)가 없는 행은 전체 전환(ccnt · convAmt)으로 채웠습니다');
  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

async function collectKeywords(
  client: NaverSaClient,
  s: NaverSaSettings,
  campaigns: NaverCampaign[],
  r: DateRange | null,
  today: string,
  batch: NormalizedBatch,
  conv: (row: NaverStatRow) => Funnel,
): Promise<void> {
  const kwCampaigns = campaigns.filter((c) => !c.campaignTp || c.campaignTp === 'WEB_SITE');
  const adgroups: NaverAdgroup[] = [];
  for (const c of kwCampaigns) adgroups.push(...(await client.adgroups(c.nccCampaignId)).filter((g) => !isDeleted(g)));
  const keywords: NaverKeyword[] = [];
  for (const g of adgroups) keywords.push(...(await client.keywords(g.nccAdgroupId)).filter((k) => !isDeleted(k)));
  const ag = new Map(adgroups.map((g) => [g.nccAdgroupId, g]));
  const cmp = new Map(campaigns.map((c) => [c.nccCampaignId, c]));
  const ids = keywords.map((k) => k.nccKeywordId);
  const fields = [...STAT_FIELDS, 'avgRnk'] as const;

  // 최근 14일 평균 노출 순위
  const rank = new Map<string, number>();
  if (ids.length) {
    for (const row of (await client.statsSummary(ids, addDaysStr(today, -14), addDaysStr(today, -1), { fields })).rows) {
      if (row.id && num(row.avgRnk) > 0) rank.set(String(row.id), num(row.avgRnk));
    }
  }

  // 키워드 일별
  const keywordDaily: NonNullable<NormalizedBatch['keywordDaily']> = [];
  if (r && ids.length && s.keywordDays > 0) {
    const kr = tailRange(r, addDaysStr(r.to, -(s.keywordDays - 1)));
    if (kr) {
      for (const d of dateRange(kr.from, kr.to)) {
        for (const row of (await client.statsSummary(ids, d, d, { fields })).rows) {
          const f = finishFunnel(conv(row));
          if (!row.id || (!f.impressions && !f.clicks && !f.cost && !f.conversions)) continue;
          keywordDaily.push({ date: d, keywordId: String(row.id), ...f, avgRank: num(row.avgRnk) > 0 ? Math.round(num(row.avgRnk) * 10) / 10 : null });
        }
      }
      if (kr.from > r.from) warn(batch, 'keyword_window', `키워드 일별 통계는 최근 ${s.keywordDays}일(${kr.from} 이후)만 수집했습니다 — 설정 keywordDays로 늘릴 수 있습니다(최대 92일, 호출 수 증가)`);
    }
  }

  // 월간 검색량 (선택)
  const volume = new Map<string, number>();
  if (s.fetchSearchVolume && keywords.length) {
    const texts = [...new Set(keywords.map((k) => k.keyword.replace(/\s+/g, '')))];
    for (const part of chunk(texts, 5)) {
      for (const x of await client.keywordTool(part)) volume.set(x.relKeyword.replace(/\s+/g, ''), parseVolume(x.monthlyPcQcCnt) + parseVolume(x.monthlyMobileQcCnt));
    }
  }

  let derived = 0;
  const snaps: KeywordSnapshot[] = keywords.map((k) => {
    const g = ag.get(k.nccAdgroupId);
    const n = normKeyword(k, g, cmp.get(g?.nccCampaignId ?? k.nccCampaignId ?? ''), rank.get(k.nccKeywordId) ?? 0, volume.get(k.keyword.replace(/\s+/g, '')) ?? 0, s);
    if (n.maxBidDerived) derived++;
    return n.keyword;
  });
  batch.keywords = snaps;
  batch.keywordDaily = keywordDaily;
  if (snaps.length) {
    warn(batch, 'impression_share_unavailable', '노출 기회 손실률(impressionShareLost)은 네이버 검색광고 API에서 제공하지 않아 0으로 둡니다');
    if (derived) warn(batch, 'max_bid_default', `키워드 ${derived}개는 최대 입찰가 설정이 없어 현재 입찰가 × ${s.maxBidMultiplier}로 안전 상한을 잡았습니다 — 커넥션 설정 maxBid 지정 권장`);
  }
}

async function accountSnapshot(
  client: NaverSaClient,
  creds: NaverSaCredentials,
  s: NaverSaSettings,
  cids: string[],
  today: string,
  conv: (row: NaverStatRow) => Funnel,
  batch: NormalizedBatch,
): Promise<AdAccount> {
  const biz = await client.bizmoney();
  let week = 0;
  if (cids.length) for (const row of (await client.statsSummary(cids, addDaysStr(today, -7), addDaysStr(today, -1), { fields: ['salesAmt'] })).rows) week += conv(row).cost;
  if (biz.budgetLock) warn(batch, 'budget_lock', '비즈머니 budgetLock=true — 잔액 부족 등으로 노출이 잠겼을 수 있습니다. 광고 관리 화면에서 확인해 주세요');
  return {
    id: `nsa-${creds.customerId}`,
    media: 'naver_sa',
    name: s.accountName ?? `${NAVER_SA_LABEL} ${creds.customerId}`,
    owner: s.owner ?? '',
    balance: krw(biz.bizmoney),
    avgDailySpend: Math.round(week / 7),
    autoCharge: s.autoCharge,
    paymentMethod: '비즈머니(선결제)',
    permissions: [],
    status: 'active',
  };
}

/* ------------------------------ 반영 ------------------------------ */

/** targetId에서 네이버 엔티티 id (nkw- · cmp- · grp-) */
export function naverTarget(targetId: string | undefined): { type: 'keyword' | 'campaign' | 'adgroup'; id: string } | null {
  const m = String(targetId ?? '').match(/\b(nkw|cmp|grp)-[A-Za-z0-9]+-\d+-\d+\b/);
  if (!m) return null;
  return { type: m[1] === 'nkw' ? 'keyword' : m[1] === 'cmp' ? 'campaign' : 'adgroup', id: m[0] };
}

const INTENTS: IntentId[] = ['brand', 'generic', 'problem', 'compare', 'life'];
const normKw = (x: string) => x.replace(/\s+/g, '').toLowerCase();

/** AD Pilot 테스트 후보 after('GENERIC_TEST · 입찰 1,200원') → 의도 · 입찰가 (해석 불가면 null) */
export function parseTestRegistration(after: unknown): { intent: IntentId | null; bid: number | null } {
  const s = String(after ?? '');
  const m = s.match(/\b(BRAND|GENERIC|PROBLEM|COMPARE|LIFE)_TEST\b/i);
  const intent = m ? (m[1].toLowerCase() as IntentId) : null;
  const b = s.match(/입찰\s*([\d,]+)\s*원?/);
  const bid = b ? parseKrwAmount(b[1]) : typeof after === 'number' ? parseKrwAmount(after) : null;
  return { intent: intent && INTENTS.includes(intent) ? intent : null, bid };
}

async function applyKeywordAdd(ctx: ConnectorContext, client: NaverSaClient, s: NaverSaSettings, change: ChangeRequest): Promise<ApplyResult> {
  const tid = String(change.targetId ?? '');
  const term = tid.startsWith('term:') ? tid.slice('term:'.length).trim() : '';
  if (!term) return unsupported(change, NAVER_SA_LABEL, `키워드 등록 대상(${tid || '—'})이 'term:<검색어>' 형식이 아닙니다`);
  const { intent, bid } = parseTestRegistration(change.after);
  if (!intent) return { ok: false, request: { targetId: tid }, error: `등록 값(${String(change.after)})에서 구매 의도(<의도>_TEST)를 찾지 못했습니다` };
  if (bid === null) return { ok: false, request: { targetId: tid }, error: `등록 값(${String(change.after)})에서 입찰가(입찰 <금액>원)를 찾지 못했습니다` };
  if (bid < NAVER_BID_MIN || bid > NAVER_BID_MAX) return { ok: false, request: { targetId: tid, bidAmt: bid }, error: `네이버 키워드 입찰가는 ${NAVER_BID_MIN}~${NAVER_BID_MAX.toLocaleString('ko-KR')}원입니다 (요청 ${bid.toLocaleString('ko-KR')}원)` };
  const grp = s.testAdgroups[intent];
  if (!grp) return { ok: false, request: { targetId: tid, intent }, error: `등록할 테스트 광고그룹이 없습니다 — 커넥션 설정 testAdgroups.${intent}에 광고그룹 ID(grp-…)를 지정해 주세요 (보내지 않았습니다)` };
  const body = [{ keyword: term, bidAmt: bid, useGroupBidAmt: false, userLock: false }];
  const query = { nccAdgroupId: grp };
  return executePlan(ctx, {
    label: NAVER_SA_LABEL, what: `테스트 키워드 등록 (${intent.toUpperCase()}_TEST)`, intended: bid,
    steps: [
      step(client.request('GET', '/ncc/keywords', { nccAdgroupId: grp }), '같은 키워드가 이미 있는지 확인 (있으면 등록하지 않음)'),
      step(client.request('POST', '/ncc/keywords', query, body)),
    ],
    live: async () => {
      const existing = (await client.keywords(grp)).find((k) => !isDeleted(k) && normKw(k.keyword) === normKw(term));
      // 응답 표식: existing = 원래 있던 키워드(롤백 시 건드리면 안 됨) · created = 이번에 만든 키워드(롤백 시 OFF 대상)
      if (existing) return { response: { existing }, appliedValue: existing.nccKeywordId, notes: [`이미 등록된 키워드(${existing.nccKeywordId}) — 다시 만들지 않았습니다`] };
      const res = await client.call<NaverKeyword[]>('POST', '/ncc/keywords', '키워드 등록', query, body);
      const createdList = Array.isArray(res.data) ? res.data : [];
      const created = createdList[0];
      return { response: { created: createdList }, appliedValue: created?.nccKeywordId ?? bid, notes: created?.nccKeywordId ? [`등록 키워드 ${created.nccKeywordId} · 입찰 ${num(created.bidAmt) || bid}원`] : [] };
    },
  });
}

/** 변경 실행기가 웨어하우스에서 붙인 광고그룹 id (있으면 dry_run 요청에 그대로 싣고, live는 매체 값과 다르면 중단) */
function knownAdgroup(change: ApplyChange): string | null {
  const g = change.entity?.adgroupId;
  return typeof g === 'string' && /^grp-[A-Za-z0-9-]{1,80}$/.test(g) ? g : null;
}

function assertSameAdgroup(known: string | null, actual: string | undefined): void {
  if (known && actual && known !== actual) {
    throw new Error(`웨어하우스의 광고그룹(${known})과 매체의 광고그룹(${actual})이 다릅니다 — 데이터를 다시 수집한 뒤 반영하세요 (보내지 않았습니다)`);
  }
}

export async function applyNaverSa(ctx: ConnectorContext, change: ApplyChange): Promise<ApplyResult> {
  const s = parseSettings(ctx);
  let client: NaverSaClient;
  try {
    client = clientOf(ctx, s);
  } catch (e) {
    return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: (e as Error).message };
  }
  if (change.kind === 'keyword_add') return applyKeywordAdd(ctx, client, s, change);
  const t = naverTarget(change.targetId);
  if (!t) return unsupported(change, NAVER_SA_LABEL, `대상 id(${change.targetId ?? '—'})가 네이버 검색광고 키워드 · 캠페인 · 광고그룹 id 형식(nkw- · cmp- · grp-)이 아닙니다`);

  if (change.kind === 'bid') {
    if (t.type !== 'keyword') return unsupported(change, NAVER_SA_LABEL, '입찰가 변경은 키워드(nkw-) 대상만 지원합니다');
    const after = parseKrwAmount(change.after);
    if (after === null) return { ok: false, request: { targetId: t.id }, error: '입찰가 값이 올바르지 않습니다' };
    if (after < NAVER_BID_MIN || after > NAVER_BID_MAX) return { ok: false, request: { targetId: t.id, bidAmt: after }, error: `네이버 키워드 입찰가는 ${NAVER_BID_MIN}~${NAVER_BID_MAX.toLocaleString('ko-KR')}원입니다 (요청 ${after.toLocaleString('ko-KR')}원)` };
    const path = `/ncc/keywords/${t.id}`;
    const known = knownAdgroup(change);
    const planned = { nccKeywordId: t.id, nccAdgroupId: known ?? '(사전 확인 결과)', bidAmt: after, useGroupBidAmt: false };
    return executePlan(ctx, {
      label: NAVER_SA_LABEL, what: '키워드 입찰가 변경', intended: after,
      steps: [
        step(client.request('GET', path), '광고그룹 ID · 현재 입찰가 확인'),
        step(client.request('PUT', path, { fields: 'bidAmt' }, planned)),
      ],
      live: async () => {
        const kw = await client.keyword(t.id);
        assertSameAdgroup(known, kw.nccAdgroupId);
        const notes: string[] = [];
        if (kw.useGroupBidAmt) notes.push('광고그룹 기본 입찰가를 쓰던 키워드 — 키워드 입찰가로 전환');
        else assertNoDrift('키워드 입찰가', change.before, num(kw.bidAmt), after, s.allowDrift);
        const body = { nccKeywordId: t.id, nccAdgroupId: kw.nccAdgroupId, bidAmt: after, useGroupBidAmt: false };
        const res = await client.call<NaverKeyword>('PUT', path, '키워드 입찰가 변경', { fields: 'bidAmt' }, body);
        return { response: res.data, appliedValue: num(res.data?.bidAmt) || after, notes };
      },
    });
  }

  if (change.kind === 'budget') {
    if (t.type === 'keyword') return unsupported(change, NAVER_SA_LABEL, '일 예산은 캠페인(cmp-) · 광고그룹(grp-) 대상만 지원합니다');
    const after = parseKrwAmount(change.after);
    if (after === null) return { ok: false, request: { targetId: t.id }, error: '일 예산 값이 올바르지 않습니다' };
    const isCmp = t.type === 'campaign';
    const path = isCmp ? `/ncc/campaigns/${t.id}` : `/ncc/adgroups/${t.id}`;
    const idKey = isCmp ? 'nccCampaignId' : 'nccAdgroupId';
    const body = { [idKey]: t.id, dailyBudget: after, useDailyBudget: true };
    return executePlan(ctx, {
      label: NAVER_SA_LABEL, what: isCmp ? '캠페인 하루 예산 변경' : '광고그룹 하루 예산 변경', intended: after,
      steps: [
        step(client.request('GET', path), '공유 예산 사용 여부 · 현재 하루 예산 확인'),
        step(client.request('PUT', path, { fields: 'budget' }, body)),
      ],
      live: async () => {
        const cur = isCmp ? await client.campaign(t.id) : await client.adgroup(t.id);
        if ((cur as NaverCampaign).sharedBudgetId) throw new ApplyAbort(`공유 예산(${(cur as NaverCampaign).sharedBudgetId})을 쓰는 ${isCmp ? '캠페인' : '광고그룹'}입니다 — 공유 예산을 바꾸면 묶인 다른 캠페인도 바뀌므로 반영하지 않았습니다`);
        const curBudget = (cur as NaverCampaign).useDailyBudget ? num((cur as NaverCampaign).dailyBudget) : null;
        assertNoDrift('하루 예산', change.before, curBudget, after, s.allowDrift);
        const res = await client.call<NaverCampaign>('PUT', path, '하루 예산 변경', { fields: 'budget' }, body);
        return { response: res.data, appliedValue: num(res.data?.dailyBudget) || after };
      },
    });
  }

  if (change.kind === 'status') {
    const onoff = parseOnOff(change.after);
    if (!onoff) return { ok: false, request: { targetId: t.id }, error: `상태 값(${String(change.after)})을 on/off로 해석할 수 없습니다` };
    const userLock = onoff === 'off';
    if (t.type === 'keyword') {
      const path = `/ncc/keywords/${t.id}`;
      const known = knownAdgroup(change);
      return executePlan(ctx, {
        label: NAVER_SA_LABEL, what: `키워드 ${onoff === 'on' ? 'ON' : 'OFF'}`, intended: onoff,
        steps: [
          step(client.request('GET', path), '광고그룹 ID 확인'),
          step(client.request('PUT', path, { fields: 'userLock' }, { nccKeywordId: t.id, nccAdgroupId: known ?? '(사전 확인 결과)', userLock })),
        ],
        live: async () => {
          const kw = await client.keyword(t.id);
          assertSameAdgroup(known, kw.nccAdgroupId);
          const res = await client.call<NaverKeyword>('PUT', path, '키워드 ON/OFF', { fields: 'userLock' }, { nccKeywordId: t.id, nccAdgroupId: kw.nccAdgroupId, userLock });
          return { response: res.data, appliedValue: res.data?.userLock === undefined ? onoff : res.data.userLock ? 'off' : 'on' };
        },
      });
    }
    const isCmp = t.type === 'campaign';
    const path = isCmp ? `/ncc/campaigns/${t.id}` : `/ncc/adgroups/${t.id}`;
    const body = { [isCmp ? 'nccCampaignId' : 'nccAdgroupId']: t.id, userLock };
    return executePlan(ctx, {
      label: NAVER_SA_LABEL, what: `${isCmp ? '캠페인' : '광고그룹'} ${onoff === 'on' ? 'ON' : 'OFF'}`, intended: onoff,
      steps: [step(client.request('PUT', path, { fields: 'userLock' }, body))],
      live: async () => {
        const res = await client.call<{ userLock?: boolean }>('PUT', path, 'ON/OFF 변경', { fields: 'userLock' }, body);
        return { response: res.data, appliedValue: res.data?.userLock === undefined ? onoff : res.data.userLock ? 'off' : 'on' };
      },
    });
  }

  return unsupported(change, NAVER_SA_LABEL);
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'naver_sa',
  kind: 'media',
  channel: 'naver_sa',
  label: NAVER_SA_LABEL,
  docsUrl: 'https://naver.github.io/searchad-apidoc/',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'apiKey', label: '액세스 라이선스 (API Key)', secret: true, help: '네이버 검색광고 관리 화면 [도구] > [API 사용 관리]에서 발급한 액세스 라이선스' },
    { key: 'secretKey', label: '비밀키 (Secret Key)', secret: true, help: '같은 화면의 비밀키. 2026-07 공지대로 비밀키가 바뀐 계정이 있으니 인증 실패 시 이 화면에서 다시 확인해 주세요' },
    { key: 'customerId', label: '고객 ID (CUSTOMER_ID)', secret: false, help: '[도구] > [API 사용 관리] 화면에 표시된 숫자 고객 ID. 통합광고 ID(adAccountNo)와 다른 값입니다' },
  ],
  capabilities: {
    reads: ['mediaDaily', 'mediaHourly', 'keywordDaily', 'keywords', 'campaigns', 'accounts'],
    writes: ['bid', 'budget', 'status', 'keyword_add'],
    intraday: true,
    // FAQ-stat: breakdown 없는 통계 보관 2년 (시간대 통계는 7일)
    maxBackfillDays: 730,
  },
  async test(ctx) {
    return testOutcome(async () => {
      const s = parseSettings(ctx);
      const creds = parseCreds(ctx);
      const client = new NaverSaClient(ctx, creds, { now: nowMs, statsChunk: s.statsChunk });
      const biz = await client.bizmoney();
      const campaigns = (await client.campaigns()).filter((c) => !isDeleted(c));
      const on = campaigns.filter((c) => !c.userLock).length;
      return {
        ok: true,
        account: `${NAVER_SA_LABEL} ${creds.customerId}`,
        message: `연결 확인 — 고객 ID ${creds.customerId} · 캠페인 ${campaigns.length}개(ON ${on}) · 비즈머니 ${krw(biz.bizmoney).toLocaleString('ko-KR')}원. 검색어는 API 근거가 확인되지 않아 CSV 검색어 템플릿으로 올려 주세요`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchNaverSa(ctx, range, opts),
  apply: (ctx, change) => applyNaverSa(ctx, change),
};
