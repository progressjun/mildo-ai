/**
 * 네이버 성과형 디스플레이(GFA) 커넥터 (docs/SAAS_SPEC.md §4 connectors-media).
 *
 * 공개 API 확인 결과 (2026-11-02 · 2026-11-03 재확인, 근거는 client.ts 머리말)
 *   공식 문서(https://naver-ad-api.github.io/developers/)와 OpenAPI 명세가 공개되어 있다. 단 **베타 · 공식 파트너사 한정**으로,
 *   GFA 대표 관리 계정에서 'API 사용 신청' 후 네이버 승인을 받아야 호출할 수 있다. 승인 전에는 이 커넥터 대신
 *   CSV 업로드(매체 일별 · 시간대 템플릿, 매체 naver_gfa)로 같은 웨어하우스에 넣는다 — test()가 이 안내를 돌려준다.
 *   광고 API 명세: https://naver-ad-api.github.io/developers/redocusaurus/plugin-redoc-1.yaml
 *
 * 수집 (fetch)
 *   - mediaDaily: 과거 성과 aggregationType=campaigns, timeUnit=daily (31일 구간 · next 페이지) — 전일까지
 *   - 오늘: 실시간 성과 realtime/creatives?targetDate=today&timeUnit=hourly → 오늘 일별 · 시간대
 *   - mediaHourly: 과거 성과 timeUnit=hourly (설정 hourlyDays, 기본 7일)
 *   - 전환: 설정 conversionTypes(기본 PURCHASE)가 있으면 전환 성과 API(convType별)의 해당 유형만 일별 전환 · 매출로 쓴다.
 *     전환 성과는 시간 단위를 지원하지 않아(문서) 시간대 행의 전환은 일반 성과 응답의 convCount · convSales(전체 유형)이다.
 *   - 비용: 성과 응답 필드 sales("매출")를 광고비로 쓴다. TODO(근거 부족): 문서에 정의가 '매출' 한 단어뿐이라 네이버 검색광고 salesAmt(총비용)와
 *     같은 관례(매체 입장 매출 = 광고비)로 해석했다 — 실계정 응답을 광고 시스템 화면 비용과 대조해 확인 필요. 전환 매출은 convSales.
 *   - campaigns: 캠페인 목록(activated · status) + 하루 예산
 *       ADVoost 쇼핑(objective PMAX) = performanceMax.budget(명세: '일 예산')
 *       CBO = budget(명세: '예산 최적화 캠페인의 총 예산' — 일 예산이라는 정의가 없어 그대로 표시하고 경고)
 *       그 밖 = 켜진 일 예산(budgetType DAILY) 광고 그룹 budgetAmount 합계
 *     Campaign.adGroups = 실제 광고 그룹(id = 광고 그룹 번호 · 이름 · ON/OFF · 일 예산) — GFA Control 화면이 데모 광고그룹 대신 쓴다
 *     오늘 소진 = 실시간 sales 합
 *   - accounts: 광고 계정 이름 · 비활성 여부. 잔액 · 결제 정보는 API에 없어 잔액 -1(미확인)로 두고 경고
 *
 * 반영 (apply) — dryRun이면 네트워크 호출 없이 보낼 요청 단계를 돌려준다
 *   - status: 캠페인 POST campaigns/activate?campaignNos&activated · 광고 그룹 POST adSets/activate?adSetNos&activated
 *     대상 id 'gfa-cmp-<no>' · 'gfa-adset-<no>' · 'gfa:adgroup:<캠페인 id>:<광고 그룹 번호>'(GFA Control 화면 형식)
 *   - budget: 사전 조회(GET campaigns/{no})로 예산 구조를 확인한 뒤
 *       ADVoost 쇼핑(PMAX) → POST campaigns/editSpendLimit?campaignNos&campaignSpendLimit (명세상 performanceMax.budget 일 예산으로 반영, 2시간에 1회)
 *       일 예산 광고 그룹이 정확히 1개 → POST adSets/edit { editType, adSetNos:[no], budgetType:'DAILY', budgetAmount }
 *       광고 그룹 대상(gfa-adset- · gfa:adgroup:) → 같은 adSets/edit
 *       멈춤: CBO(문서상 '총 예산' — 일 예산 변경으로 보내지 않음) · 부스트업(subType OFFSITE_CAMPAIGN, 명세: Open API로 예산 수정 불가) ·
 *             일 예산 광고 그룹이 여러 개(캠페인 하나의 값을 나눌 규칙이 없음 — 광고 그룹 단위로 요청) · 총예산(TOTAL) 광고 그룹
 *     editType 값: 명세의 discriminator(propertyName editType)에 mapping이 없어, OpenAPI 3.0 규칙(mapping이 없으면 값 = 스키마 이름,
 *       https://spec.openapis.org/oas/v3.0.1#discriminator-object)대로 'AdSetEditBudgetParam'을 보낸다. 실계정 확인 전(verifiedLive=false).
 *   - 신규 캠페인(kind 'gfa', 'gfa:new:<계정>:<이름>'): 생성 API(OpenCampaignCreationParam)는 목적 · 대표 URL(urlNo) · 브랜드 등이 필수인데
 *     변경 요청에는 이름 · 예산만 있어 보낼 수 없다 — writes에 넣지 않아 변경 실행기가 '기록만'으로 처리한다(광고 시스템에서 생성 후 이력 기록).
 */
import { z } from 'zod';
import type { ApplyResult, ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { AdAccount, Campaign, ChangeRequest } from '@/core/types';
import { addDaysStr, kstHour, kstToday, nowMs } from '../../lib/time';
import {
  ApplyAbort, DailyAcc, HourlyAcc, assertNoDrift, clampRange, commonSettingsShape, dec2, executePlan, inferIntent, isoDate, krw, num, parseHour,
  parseKrwAmount, parseOnOff, softPart, splitRange, step, tailRange, testOutcome, unsupported, warn, type Funnel,
} from '../naver-sa/media-shared';
import { GFA_LABEL, GfaClient, type GfaAdSet, type GfaCampaign, type GfaCredentials, type GfaPerfRow, type GfaSuccess } from './client';

const CONV_TYPES = ['INSTALL', 'IAP', 'WISHLIST', 'PURCHASE', 'MEMBERSHIP', 'CART', 'RESERVATION', 'SUBSCRIBE', 'SCHEDULE', 'CONTENT', 'LEVEL', 'TUTORIAL', 'ETC', 'ETC_02', 'ETC_03', 'ETC_04', 'ETC_05', 'ETC_06', 'ETC_07', 'ETC_08', 'ETC_09', 'ETC_10'] as const;
const digits = (label: string) => z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{1,20}$/, `${label}는 숫자입니다`));

export const credentialsSchema = z.object({
  clientId: z.string().trim().min(5, '네이버 개발자 센터 Client ID를 입력해 주세요'),
  clientSecret: z.string().trim().min(5, 'Client Secret을 입력해 주세요'),
  refreshToken: z.string().trim().min(10, '네이버 로그인 갱신 토큰을 입력해 주세요'),
  adAccountNo: digits('광고 계정 번호'),
  managerAccountNo: z.union([digits('관리 계정 번호'), z.literal('')]).optional().transform((v) => v || undefined),
});

export const settingsSchema = z.object({
  ...commonSettingsShape,
  apiVersion: z.string().regex(/^\d+\.\d+$/).default('1.0'),
  /** 전환으로 셀 유형 (빈 배열이면 일반 성과의 전체 전환) */
  conversionTypes: z.array(z.enum(CONV_TYPES)).default(['PURCHASE']),
  hourlyDays: z.number().int().min(0).max(31).default(7),
  /** 현재 값이 요청 시점 값과 달라도 반영 (기본 끔) */
  allowDrift: z.boolean().default(false),
});
export type GfaSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): GfaCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ApplyAbort(`${GFA_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): GfaSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}
const clientOf = (ctx: ConnectorContext, s: GfaSettings) => new GfaClient(ctx, parseCreds(ctx), { version: s.apiVersion, now: nowMs });

export const funnelOfGfa = (r: GfaPerfRow): Funnel => ({
  impressions: num(r.impCount), clicks: num(r.clickCount), cost: krw(r.sales), conversions: dec2(r.convCount), revenue: krw(r.convSales),
});

export const campaignEntityId = (no: number | string) => `gfa-cmp-${no}`;
export function gfaTarget(targetId: string | undefined): { type: 'campaign' | 'adset'; no: string } | null {
  const s = String(targetId ?? '');
  let m = s.match(/^gfa:adgroup:[^:]+:(.+)$/);
  if (m) return /^\d+$/.test(m[1]) ? { type: 'adset', no: m[1] } : null;
  m = s.match(/gfa-(cmp|adset)-(\d+)/);
  return m ? { type: m[1] === 'cmp' ? 'campaign' : 'adset', no: m[2] } : null;
}

export function campaignStatus(c: GfaCampaign): Campaign['status'] {
  if (c.activated === false) return 'off';
  if (c.budgetExhausted || c.status === 'BUDGET_EXHAUSTED' || c.status === 'OPTIMIZATION_BUDGET_EXHAUSTED' || c.status === 'RUNNABLE_LEARNING_LIMIT') return 'limited';
  return 'on';
}

/** 하루 예산 출처 — 문서 근거별로 구분 (화면 경고 · 반영 분기) */
export type GfaBudgetSource = 'pmax' | 'cbo' | 'adsets' | 'none';
export function budgetSourceOf(c: GfaCampaign): GfaBudgetSource {
  if (c.objective === 'PMAX') return 'pmax';
  if (c.cboActivated) return 'cbo';
  return 'adsets';
}

const liveAdSet = (a: GfaAdSet) => !a.deleted && a.status !== 'DELETED';

export function normCampaigns(campaigns: GfaCampaign[], adSets: GfaAdSet[], spent: Map<number, number>, hour: number, rules: GfaSettings['intentRules']): Campaign[] {
  const byCampaign = new Map<number, GfaAdSet[]>();
  for (const a of adSets) {
    if (!liveAdSet(a) || a.campaignNo === undefined) continue;
    byCampaign.set(a.campaignNo, [...(byCampaign.get(a.campaignNo) ?? []), a]);
  }
  return campaigns
    .filter((c) => !c.deleted && c.status !== 'DELETED')
    .map((c) => {
      const sets = byCampaign.get(c.no) ?? [];
      const dailySum = sets.filter((a) => a.budgetType === 'DAILY' && a.activated !== false).reduce((x, a) => x + krw(a.budgetAmount), 0);
      const src = budgetSourceOf(c);
      const dailyBudget = src === 'pmax' ? krw(c.performanceMax?.budget) : src === 'cbo' ? (num(c.budget) > 0 ? krw(c.budget) : dailySum) : dailySum;
      const row: Campaign = {
        id: campaignEntityId(c.no),
        media: 'naver_gfa' as const,
        name: c.name ?? String(c.no),
        intent: inferIntent([c.name], rules),
        dailyBudget,
        spentToday: spent.get(c.no) ?? 0,
        status: campaignStatus(c),
        hourOfData: hour,
      };
      if (sets.length) {
        // GFA Control 'gfa:adgroup:<캠페인 id>:<광고 그룹 번호>' — id는 반영 대상 번호(숫자 문자열)
        row.adGroups = sets.map((a) => ({
          id: String(a.no),
          name: a.name ?? String(a.no),
          status: a.activated === false ? ('off' as const) : ('on' as const),
          dailyBudget: a.budgetType === 'DAILY' ? krw(a.budgetAmount) : 0,
        }));
      }
      return row;
    });
}

/* ------------------------------ 수집 ------------------------------ */

export async function fetchGfa(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const g = clientOf(ctx, s);
  const today = kstToday();
  const hour = kstHour();
  const intraday = opts.intradayDate;
  const r = intraday ? clampRange({ from: intraday, to: intraday }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { mediaDaily: [], mediaHourly: [], campaigns: [], accounts: [], warnings: [] };
  const daily = new DailyAcc();
  const hourly = new HourlyAcc();
  const convOverride = s.conversionTypes.length > 0;
  const types = new Set<string>(s.conversionTypes);

  const spentToday = new Map<number, number>();
  // 오늘: 실시간 (항상 — 캠페인 오늘 소진에도 쓴다)
  const rt = await g.realtime('/performance/realtime/creatives', { targetDate: 'today', timeUnit: 'hourly' }, '오늘 실시간 성과 조회');
  const wantToday = !!r && r.to >= today;
  const todayDaily: Funnel = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  for (const row of rt) {
    const f = funnelOfGfa(row);
    if (row.campaignNo !== undefined) spentToday.set(row.campaignNo, (spentToday.get(row.campaignNo) ?? 0) + f.cost);
    if (!wantToday) continue;
    const h = parseHour(row.hour);
    if (h !== null && h <= hour) hourly.add(today, h, f);
    todayDaily.impressions += f.impressions; todayDaily.clicks += f.clicks; todayDaily.cost += f.cost; todayDaily.conversions += f.conversions; todayDaily.revenue += f.revenue;
  }
  if (wantToday) {
    if (convOverride) {
      const conv = (await g.realtime('/performance/conversion/realtime/creatives', { targetDate: 'today', timeUnit: 'daily' }, '오늘 실시간 전환 조회')).filter((x) => types.has(String(x.convType)));
      todayDaily.conversions = conv.reduce((a, x) => a + num(x.convCount), 0);
      todayDaily.revenue = conv.reduce((a, x) => a + num(x.convSales), 0);
    }
    daily.add(today, todayDaily);
  }

  // 과거 일자
  const pastTo = r ? (r.to < today ? r.to : addDaysStr(today, -1)) : '';
  if (r && r.from <= pastTo) {
    const past: DateRange = { from: r.from, to: pastTo };
    const convByDate = new Map<string, { c: number; v: number }>();
    for (const w of splitRange(past.from, past.to, 31)) {
      const q = { startDate: w.from, endDate: w.to, timeUnit: 'daily' };
      const rows = await g.pastRows('/performance/past/campaigns', q, '과거 성과 조회');
      if (convOverride) {
        for (const x of await g.pastRows('/performance/conversion/past/campaigns', q, '과거 전환 성과 조회')) {
          const d = isoDate(x.targetDate);
          if (!d || !types.has(String(x.convType))) continue;
          const cur = convByDate.get(d) ?? { c: 0, v: 0 };
          cur.c += num(x.convCount); cur.v += num(x.convSales);
          convByDate.set(d, cur);
        }
      }
      const perDate = new Map<string, Funnel>();
      for (const row of rows) {
        const d = isoDate(row.targetDate);
        if (!d) continue;
        const f = funnelOfGfa(row);
        const cur = perDate.get(d) ?? { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
        cur.impressions += f.impressions; cur.clicks += f.clicks; cur.cost += f.cost; cur.conversions += f.conversions; cur.revenue += f.revenue;
        perDate.set(d, cur);
      }
      for (const [d, f] of perDate) {
        if (convOverride) { const cv = convByDate.get(d); f.conversions = cv?.c ?? 0; f.revenue = cv?.v ?? 0; }
        daily.add(d, f);
      }
    }
    // 과거 시간대
    const hr = s.hourlyDays > 0 ? tailRange(past, addDaysStr(today, -s.hourlyDays)) : null;
    if (hr) {
      await softPart(batch, 'hourly_failed', '과거 시간대 성과', async () => {
        for (const w of splitRange(hr.from, hr.to, 31)) {
          for (const row of await g.pastRows('/performance/past/campaigns', { startDate: w.from, endDate: w.to, timeUnit: 'hourly' }, '과거 시간대 성과 조회')) {
            const d = isoDate(row.targetDate);
            const h = parseHour(row.hour);
            if (d && h !== null) hourly.add(d, h, funnelOfGfa(row));
          }
        }
      });
    }
  }
  batch.mediaDaily = daily.rows('naver_gfa');
  batch.mediaHourly = hourly.rows('naver_gfa');

  // 캠페인 · 광고 그룹
  const campaigns = await g.pages<GfaCampaign>('/campaigns', '캠페인 목록 조회');
  const adSets = await g.pages<GfaAdSet>('/adSets', '광고 그룹 목록 조회');
  batch.campaigns = normCampaigns(campaigns, adSets, spentToday, hour, s.intentRules);
  const cbo = campaigns.filter((c) => !c.deleted && budgetSourceOf(c) === 'cbo' && num(c.budget) > 0).length;
  if (cbo) warn(batch, 'cbo_budget_total', `CBO 캠페인 ${cbo}개는 예산을 CBO 예산(budget)으로 표시했습니다 — 명세 정의가 '예산 최적화 캠페인의 총 예산'이라 하루 예산과 같은지 실계정 확인 필요 (CBO 예산은 반영하지 않음)`);

  // 계정
  await softPart(batch, 'account_failed', '광고 계정', async () => {
    const a = await g.account();
    const week = (await g.pastRows('/performance/past/campaigns', { startDate: addDaysStr(today, -7), endDate: addDaysStr(today, -1), timeUnit: 'daily' }, '최근 7일 성과 조회')).reduce((x, row) => x + krw(row.sales), 0);
    const account: AdAccount = {
      id: `gfa-${g.accountNo}`, media: 'naver_gfa', name: a?.name ? `GFA ${a.name}` : `GFA ${g.accountNo}`, owner: s.owner ?? '',
      balance: -1, avgDailySpend: Math.round(week / 7), autoCharge: 'off', paymentMethod: '잔액 · 결제 정보 API 미제공 — 광고 시스템에서 확인', permissions: [], status: a?.disabled ? 'restricted' : 'active',
    };
    batch.accounts = [account];
  });
  warn(batch, 'balance_unavailable', 'GFA API에는 계정 잔액 · 결제 정보가 없어 잔액을 미확인(-1)으로 두었습니다 — 잔액 알림은 광고 시스템 기준으로 확인해 주세요');
  if (convOverride) warn(batch, 'hourly_conversions_all_types', `시간대 행의 전환은 전체 유형 기준입니다 (전환 성과 API는 일별만 제공 — 일별 전환은 ${s.conversionTypes.join('·')}만)`);
  return batch;
}

/* ------------------------------ 반영 ------------------------------ */

/** OpenAPI 3.0 discriminator 기본 규칙(mapping 없음 → 스키마 이름) — client.ts · 이 파일 머리말 근거 */
export const GFA_EDIT_BUDGET_TYPE = 'AdSetEditBudgetParam';

const successOrAbort = (res: unknown, what: string) => {
  if (res === false || (typeof res === 'object' && res && (res as GfaSuccess).success === false)) {
    const m = typeof res === 'object' && res ? (res as GfaSuccess).message : undefined;
    throw new ApplyAbort(`${GFA_LABEL}가 ${what} 실패를 돌려줬습니다${m ? `: ${m}` : ''}`);
  }
};

async function applyGfaBudget(ctx: ConnectorContext, g: GfaClient, change: ChangeRequest, t: { type: 'campaign' | 'adset'; no: string }, s: GfaSettings): Promise<ApplyResult> {
  const after = parseKrwAmount(change.after);
  if (after === null) return { ok: false, request: { targetId: change.targetId }, error: '일 예산 값이 올바르지 않습니다' };
  const editBody = (adSetNo: string | number) => ({ editType: GFA_EDIT_BUDGET_TYPE, adSetNos: [Number(adSetNo)], budgetType: 'DAILY', budgetAmount: after });
  const adSetStep = (no: string | number, note?: string) => step(g.request('POST', '/adSets/edit', undefined, undefined, editBody(no)), note, { editTypeBasis: 'OpenAPI 3.0 discriminator — mapping 없음 → 스키마 이름' });

  /** 광고 그룹 하나의 일 예산 변경 (사전 조회 → 변경 → 확인 읽기) */
  const editAdSet = async (no: string | number, before: unknown) => {
    const cur = await g.call<GfaAdSet>('GET', `/adSets/${no}`, '광고 그룹 조회');
    if (cur?.budgetType && cur.budgetType !== 'DAILY') throw new ApplyAbort(`광고 그룹 ${no}은(는) 총예산(${cur.budgetType}) 광고 그룹입니다 — 일 예산 변경 대상이 아니어서 반영하지 않았습니다`);
    assertNoDrift('광고 그룹 일 예산', before, cur?.budgetAmount === undefined ? null : num(cur.budgetAmount), after, s.allowDrift);
    const res = await g.call<GfaSuccess>('POST', '/adSets/edit', '광고 그룹 일 예산 변경', undefined, editBody(no));
    successOrAbort(res, '광고 그룹 예산 변경');
    let applied: number | undefined;
    try { applied = krw((await g.call<GfaAdSet>('GET', `/adSets/${no}`, '반영 값 확인')).budgetAmount) || undefined; } catch (e) { ctx.log(`${GFA_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`); }
    return { response: res, appliedValue: applied ?? after };
  };

  if (t.type === 'adset') {
    return executePlan(ctx, {
      label: GFA_LABEL, what: '광고 그룹 일 예산 변경', intended: after,
      steps: [step(g.request('GET', `/adSets/${t.no}`), '예산 타입(DAILY) · 현재 일 예산 확인'), adSetStep(t.no), step(g.request('GET', `/adSets/${t.no}`), '반영 값 확인')],
      live: () => editAdSet(t.no, change.before),
    });
  }

  const cmpPath = `/campaigns/${t.no}`;
  const spendLimitQuery = { campaignNos: t.no, campaignSpendLimit: after };
  return executePlan(ctx, {
    label: GFA_LABEL, what: '캠페인 일 예산 변경', intended: after,
    steps: [
      step(g.request('GET', cmpPath), '예산 구조 확인 (objective · CBO · subType)'),
      step(g.request('POST', '/campaigns/editSpendLimit', spendLimitQuery), 'ADVoost 쇼핑(objective PMAX)일 때 — performanceMax.budget(일 예산)으로 반영, 캠페인당 2시간에 1회'),
      step(g.request('GET', '/adSets', { campaignNo: t.no, page: 0, size: 100 }), 'PMAX · CBO가 아닐 때 — 일 예산 광고 그룹 확인 (정확히 1개일 때만 반영)'),
      adSetStep('(사전 조회한 광고 그룹 번호)', '일 예산 광고 그룹이 1개일 때'),
      step(g.request('GET', cmpPath), '반영 값 확인'),
    ],
    live: async () => {
      const c = await g.call<GfaCampaign>('GET', cmpPath, '캠페인 조회');
      if (!c || c.deleted) throw new ApplyAbort(`캠페인(${t.no})을 찾을 수 없습니다 — 삭제되었거나 다른 계정입니다`);
      if (c.subType === 'OFFSITE_CAMPAIGN') throw new ApplyAbort('부스트업(OFFSITE_CAMPAIGN) 캠페인은 명세상 Open API로 예산을 수정할 수 없습니다 — 광고 시스템에서 변경 후 이력에 기록해 주세요');
      const src = budgetSourceOf(c);
      if (src === 'cbo') throw new ApplyAbort("CBO 캠페인입니다 — CBO 예산은 명세상 '예산 최적화 캠페인의 총 예산'으로 정의되어 일 예산 변경으로 보내지 않았습니다. 광고 시스템에서 변경 후 이력에 기록해 주세요");
      if (src === 'pmax') {
        assertNoDrift('ADVoost 쇼핑 일 예산', change.before, c.performanceMax?.budget === undefined ? null : num(c.performanceMax.budget), after, s.allowDrift);
        const res = await g.call<boolean>('POST', '/campaigns/editSpendLimit', 'ADVoost 쇼핑 일 예산 변경', spendLimitQuery);
        successOrAbort(res, '캠페인 예산 변경');
        let applied: number | undefined;
        try { applied = krw((await g.call<GfaCampaign>('GET', cmpPath, '반영 값 확인')).performanceMax?.budget) || undefined; } catch (e) { ctx.log(`${GFA_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`); }
        return { response: res, appliedValue: applied ?? after, notes: ['ADVoost 쇼핑 캠페인 — 지출 한도 API 값이 performanceMax.budget(일 예산)으로 반영됨'] };
      }
      const sets = (await g.pages<GfaAdSet>('/adSets', '광고 그룹 목록 조회', { campaignNo: t.no }))
        .filter((a) => liveAdSet(a) && a.campaignNo === Number(t.no) && a.budgetType === 'DAILY' && a.activated !== false);
      if (!sets.length) throw new ApplyAbort('켜진 일 예산(DAILY) 광고 그룹이 없는 캠페인입니다 — 일 예산 변경 대상이 아니어서 반영하지 않았습니다');
      if (sets.length > 1) throw new ApplyAbort(`일 예산 광고 그룹 ${sets.length}개(${sets.map((a) => a.name ?? a.no).join(', ')})에 예산이 나뉘어 있습니다 — 캠페인 한 값을 나눌 규칙이 없어 반영하지 않았습니다. 광고 그룹 단위로 요청해 주세요`);
      const r = await editAdSet(sets[0].no, change.before);
      return { ...r, notes: [`일 예산 광고 그룹 ${sets[0].no}(${sets[0].name ?? ''})에 반영`] };
    },
  });
}

export async function applyGfa(ctx: ConnectorContext, change: ChangeRequest): Promise<ApplyResult> {
  const s = parseSettings(ctx);
  let g: GfaClient;
  try {
    g = clientOf(ctx, s);
  } catch (e) {
    return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: (e as Error).message };
  }
  if (change.kind !== 'status' && change.kind !== 'budget') return unsupported(change, GFA_LABEL);
  const t = gfaTarget(change.targetId);
  if (!t) return unsupported(change, GFA_LABEL, `대상 id(${change.targetId ?? '—'})에서 GFA 캠페인 · 광고 그룹 번호(숫자)를 찾을 수 없습니다`);
  if (change.kind === 'budget') return applyGfaBudget(ctx, g, change, t, s);

  const onoff = parseOnOff(change.after);
  if (!onoff) return { ok: false, request: { targetId: change.targetId }, error: `상태 값(${String(change.after)})을 on/off로 해석할 수 없습니다` };
  const activated = onoff === 'on';
  const isCmp = t.type === 'campaign';
  const path = isCmp ? '/campaigns/activate' : '/adSets/activate';
  const query = isCmp ? { campaignNos: t.no, activated } : { adSetNos: t.no, activated };
  const unit = isCmp ? '캠페인' : '광고 그룹';
  const readPath = isCmp ? `/campaigns/${t.no}` : `/adSets/${t.no}`;
  return executePlan(ctx, {
    label: GFA_LABEL, what: `${unit} ${activated ? 'ON' : 'OFF'}`, intended: onoff,
    steps: [step(g.request('POST', path, query)), step(g.request('GET', readPath), '반영 값 확인')],
    live: async () => {
      const res = await g.call<boolean | GfaSuccess>('POST', path, `${unit} ON/OFF`, query);
      successOrAbort(res, `${unit} ON/OFF`);
      let applied: string | undefined;
      try {
        const a = await g.call<{ activated?: boolean }>('GET', readPath, `${unit} 조회`);
        applied = a?.activated === undefined ? undefined : a.activated ? 'on' : 'off';
      } catch (e) {
        ctx.log(`${GFA_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`);
      }
      return { response: res, appliedValue: applied ?? onoff };
    },
  });
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'naver_gfa',
  kind: 'media',
  channel: 'naver_gfa',
  label: GFA_LABEL,
  docsUrl: 'https://naver-ad-api.github.io/developers/',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'clientId', label: '클라이언트 ID (Client ID)', secret: false, help: '네이버 개발자 센터 > Application에 등록한 애플리케이션(사용 API: 네이버 로그인)의 Client ID. GFA 대표 관리 계정 > 설정 > API 관리 > API 사용 신청에 이 값을 등록해 승인을 받아야 합니다 (베타 · 공식 파트너사 한정)' },
    { key: 'clientSecret', label: '클라이언트 시크릿 (Client Secret)', secret: true, help: '같은 애플리케이션의 Client Secret' },
    { key: 'refreshToken', label: '네이버 로그인 갱신 토큰', secret: true, help: 'GFA 계정 권한이 있는 네이버 아이디로 네이버 로그인을 거쳐 받은 refresh_token (접근 토큰은 1시간마다 자동 갱신)' },
    { key: 'adAccountNo', label: 'GFA 광고 계정 번호', secret: false, help: 'GFA 광고 시스템의 광고 계정 ID(숫자)' },
    { key: 'managerAccountNo', label: '관리 계정 번호', secret: false, optional: true, help: '광고 계정 멤버가 아니라 관리 계정 멤버로만 권한이 있을 때 입력 — AccessManagerAccountNo 헤더로 보냅니다' },
  ],
  capabilities: {
    reads: ['mediaDaily', 'mediaHourly', 'campaigns', 'accounts'],
    // 'gfa'(신규 캠페인)는 생성 필수 항목(목적 · 대표 URL · 브랜드)이 변경 요청에 없어 넣지 않는다 — 머리말 참고
    writes: ['budget', 'status'],
    intraday: true,
    // 과거 성과: 2년 전부터 전일까지
    maxBackfillDays: 730,
  },
  async test(ctx) {
    const r = await testOutcome(async () => {
      const g = clientOf(ctx, parseSettings(ctx));
      const a = await g.account();
      return {
        ok: !a?.disabled,
        account: `GFA ${a?.name ?? g.accountNo}`,
        message: `연결 확인 — ${a?.name ?? g.accountNo} (${g.accountNo}) · 권한 ${a?.role ?? '—'}${a?.disabled ? ' · 비활성 계정' : ''}. 비용은 성과 API의 sales 필드로 받습니다(실계정 화면 비용과 대조 필요)`,
      };
    });
    if (r.ok) return r;
    return { ...r, message: `${r.message}. GFA API는 베타 · 공식 파트너사 한정이라 승인 전에는 호출되지 않습니다 — 승인 전에는 CSV 업로드(매체 일별 · 시간대 템플릿, 매체 naver_gfa)로 데이터를 올려 주세요` };
  },
  fetch: (ctx, range, opts) => fetchGfa(ctx, range, opts),
  apply: (ctx, change) => applyGfa(ctx, change),
};
