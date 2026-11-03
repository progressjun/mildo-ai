/**
 * 네이버 성과형 디스플레이(GFA) 커넥터 (docs/SAAS_SPEC.md §4 connectors-media).
 *
 * 공개 API 확인 결과 (2026-11-02, 근거는 client.ts 머리말)
 *   공식 문서(https://naver-ad-api.github.io/developers/)와 OpenAPI 명세가 공개되어 있다. 단 **베타 · 공식 파트너사 한정**으로,
 *   GFA 대표 관리 계정에서 'API 사용 신청' 후 네이버 승인을 받아야 호출할 수 있다. 승인 전에는 이 커넥터 대신
 *   CSV 업로드(매체 일별 · 시간대 템플릿, 매체 naver_gfa)로 같은 웨어하우스에 넣는다 — test()가 이 안내를 돌려준다.
 *
 * 수집 (fetch)
 *   - mediaDaily: 과거 성과 aggregationType=campaigns, timeUnit=daily (31일 구간 · next 페이지) — 전일까지
 *   - 오늘: 실시간 성과 realtime/creatives?targetDate=today&timeUnit=hourly → 오늘 일별 · 시간대
 *   - mediaHourly: 과거 성과 timeUnit=hourly (설정 hourlyDays, 기본 7일)
 *   - 전환: 설정 conversionTypes(기본 PURCHASE)가 있으면 전환 성과 API(convType별)의 해당 유형만 일별 전환 · 매출로 쓴다.
 *     전환 성과는 시간 단위를 지원하지 않아(문서) 시간대 행의 전환은 일반 성과 응답의 convCount · convSales(전체 유형)이다.
 *   - 비용: 성과 응답 필드 sales("매출")를 광고비로 쓴다. TODO(근거 부족): 문서에 정의가 '매출' 한 단어뿐이라 네이버 검색광고 salesAmt(총비용)와
 *     같은 관례(매체 입장 매출 = 광고비)로 해석했다 — 실계정 응답을 광고 시스템 화면 비용과 대조해 확인 필요. 전환 매출은 convSales.
 *   - campaigns: 캠페인 목록(activated · status · CBO 예산) + 광고 그룹 일 예산(budgetType DAILY) 합계, 오늘 소진 = 실시간 sales 합
 *   - accounts: 광고 계정 이름 · 비활성 여부. 잔액 · 결제 정보는 API에 없어 잔액 -1(미확인)로 두고 경고
 *
 * 반영 (apply)
 *   - status: 캠페인 POST campaigns/activate?campaignNos&activated · 광고 그룹 POST adSets/activate?adSetNos&activated (문서 확인)
 *     대상 id 'gfa-cmp-<no>' · 'gfa-adset-<no>' · 'gfa:adgroup:<캠페인 id>:<광고 그룹 번호>'(GFA Control 화면 형식)
 *   - budget: TODO(근거 부족) — 광고 그룹 예산 변경(POST adSets/edit)은 본문이 editType 판별자(oneOf)인데 OpenAPI 명세에 판별 값 매핑이 없어
 *     보낼 값을 확정할 수 없다. 캠페인 지출 한도(editSpendLimit)는 '지출 한도'로 일 예산과 의미가 달라 연결하지 않는다. 확인 전까지 미지원.
 */
import { z } from 'zod';
import type { ApplyResult, ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { AdAccount, Campaign, ChangeRequest } from '@/core/types';
import { addDaysStr, kstHour, kstToday, nowMs } from '../../lib/time';
import {
  ApplyAbort, DailyAcc, HourlyAcc, clampRange, commonSettingsShape, dec2, executePlan, inferIntent, isoDate, krw, num, parseHour, parseOnOff,
  softPart, splitRange, step, tailRange, testOutcome, unsupported, warn, type Funnel,
} from '../naver-sa/media-shared';
import { GFA_LABEL, GfaClient, type GfaAdSet, type GfaCampaign, type GfaCredentials, type GfaPerfRow } from './client';

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

export function normCampaigns(campaigns: GfaCampaign[], adSets: GfaAdSet[], spent: Map<number, number>, hour: number, rules: GfaSettings['intentRules']): Campaign[] {
  const dailyByCampaign = new Map<number, number>();
  for (const a of adSets) {
    if (a.deleted || a.budgetType !== 'DAILY' || a.activated === false || a.campaignNo === undefined) continue;
    dailyByCampaign.set(a.campaignNo, (dailyByCampaign.get(a.campaignNo) ?? 0) + krw(a.budgetAmount));
  }
  return campaigns
    .filter((c) => !c.deleted && c.status !== 'DELETED')
    .map((c) => ({
      id: campaignEntityId(c.no),
      media: 'naver_gfa' as const,
      name: c.name ?? String(c.no),
      intent: inferIntent([c.name], rules),
      dailyBudget: c.cboActivated && num(c.budget) > 0 ? krw(c.budget) : dailyByCampaign.get(c.no) ?? 0,
      spentToday: spent.get(c.no) ?? 0,
      status: campaignStatus(c),
      hourOfData: hour,
    }));
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

export async function applyGfa(ctx: ConnectorContext, change: ChangeRequest): Promise<ApplyResult> {
  const s = parseSettings(ctx);
  let g: GfaClient;
  try {
    g = clientOf(ctx, s);
  } catch (e) {
    return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: (e as Error).message };
  }
  if (change.kind === 'budget') {
    return unsupported(change, GFA_LABEL, 'GFA 예산 변경은 아직 지원하지 않습니다 — 광고 그룹 예산 변경 API(adSets/edit)의 요청 본문 판별 값(editType)이 공식 명세에 없어 확정할 수 없습니다. 광고 시스템 화면에서 변경 후 이력에 기록해 주세요');
  }
  if (change.kind !== 'status') return unsupported(change, GFA_LABEL);
  const t = gfaTarget(change.targetId);
  if (!t) return unsupported(change, GFA_LABEL, `대상 id(${change.targetId ?? '—'})에서 GFA 캠페인 · 광고 그룹 번호(숫자)를 찾을 수 없습니다`);
  const onoff = parseOnOff(change.after);
  if (!onoff) return { ok: false, request: { targetId: change.targetId }, error: `상태 값(${String(change.after)})을 on/off로 해석할 수 없습니다` };
  const activated = onoff === 'on';
  const isCmp = t.type === 'campaign';
  const path = isCmp ? '/campaigns/activate' : '/adSets/activate';
  const query = isCmp ? { campaignNos: t.no, activated } : { adSetNos: t.no, activated };
  const unit = isCmp ? '캠페인' : '광고 그룹';
  const steps = [step(g.request('POST', path, query))];
  if (!isCmp) steps.push(step(g.request('GET', `/adSets/${t.no}`), '반영 값 확인'));
  return executePlan(ctx, {
    label: GFA_LABEL, what: `${unit} ${activated ? 'ON' : 'OFF'}`, intended: onoff, steps,
    live: async () => {
      const res = await g.call<boolean | { success?: boolean; message?: string }>('POST', path, `${unit} ON/OFF`, query);
      if (res === false || (typeof res === 'object' && res && res.success === false)) throw new ApplyAbort(`${GFA_LABEL}가 실패를 돌려줬습니다${typeof res === 'object' && res?.message ? `: ${res.message}` : ''}`);
      let applied: string | undefined;
      if (!isCmp) {
        try {
          const a = await g.call<GfaAdSet>('GET', `/adSets/${t.no}`, '광고 그룹 조회');
          applied = a?.activated === undefined ? undefined : a.activated ? 'on' : 'off';
        } catch (e) {
          ctx.log(`${GFA_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`);
        }
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
    writes: ['status'],
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
