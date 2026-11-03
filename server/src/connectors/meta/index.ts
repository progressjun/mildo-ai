/**
 * Meta 광고 커넥터 (docs/SAAS_SPEC.md §4 connectors-media) — Marketing API v26.0.
 *
 * 공식 문서 (2026-11-02 확인 — 상세 근거는 client.ts · normalize.ts 머리말):
 *   https://developers.facebook.com/docs/graph-api/changelog                          v26.0 최신
 *   https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/  insights 파라미터 · 오류 코드
 *   https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/          광고 세트 daily_budget · status · POST /{id}
 *   https://developers.facebook.com/docs/marketing-api/currencies                      KRW 오프셋 1
 *   https://developers.facebook.com/docs/marketing-api/reference/ad-account/           account_status · spend_cap · is_prepay_account
 *
 * 수집 (fetch)
 *   - mediaDaily: level=account, time_increment=1 (31일 구간으로 나눠 호출, 커서 페이지)
 *   - mediaHourly: breakdowns=hourly_stats_aggregated_by_advertiser_time_zone (설정 hourlyDays, 기본 35일, 7일 구간)
 *   - campaigns: 예산 단위 — 캠페인 예산(CBO)이면 캠페인, 아니면 광고 세트(이름 '캠페인 · 광고 세트'). 오늘 소진 = level=adset 오늘 spend
 *   - accounts: 계정 상태 · 지출 한도 기준 잔여(있을 때) · 최근 7일 평균 spend
 *   - keywords · keywordDaily · searchTermDaily: 검색 매체가 아니라 해당 없음
 *   - 계정 시간대가 Asia/Seoul이 아니면 경고 (insights 날짜는 광고 계정 시간대)
 *
 * 반영 (apply) — dryRun이면 네트워크 호출 없이 단계만 돌려준다
 *   - budget : 통화 확인(KRW만) → 현재 예산 확인(평생 예산이면 멈춤, 값 불일치면 멈춤) → POST /{id} daily_budget(원 = 최소 단위) → 확인 읽기
 *   - status : POST /{id} status=ACTIVE|PAUSED → 확인 읽기
 */
import { z } from 'zod';
import type { ApplyResult, ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { ChangeRequest } from '@/core/types';
import { addDaysStr, kstHour, kstToday } from '../../lib/time';
import {
  ApplyAbort, DailyAcc, HourlyAcc, assertNoDrift, clampRange, commonSettingsShape, executePlan, isoDate, krw, num, parseKrwAmount,
  parseOnOff, softPart, splitRange, step, tailRange, testOutcome, unsupported, warn,
} from '../naver-sa/media-shared';
import { META_LABEL, MetaClient, type MetaCredentials } from './client';
import { DEFAULT_PURCHASE_TYPES, accountOf, budgetUnits, currencyOffset, funnelOfInsight, hourOfInsight, metaTarget } from './normalize';

export const credentialsSchema = z.object({
  accessToken: z.string().trim().min(20, '액세스 토큰을 입력해 주세요'),
  adAccountId: z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(/^act_/, '')).pipe(z.string().regex(/^\d{5,20}$/, '광고 계정 ID는 숫자입니다 (act_ 접두어는 자동 처리)')),
  appSecret: z.string().trim().optional().transform((v) => v || undefined),
});

export const settingsSchema = z.object({
  ...commonSettingsShape,
  apiVersion: z.string().regex(/^v\d{2}\.\d$/).default('v26.0'),
  hourlyDays: z.number().int().min(0).max(35).default(35),
  /** 구매로 셀 action_type (앞에서부터 처음 있는 하나만) */
  purchaseActionTypes: z.array(z.string().min(1)).min(1).default(DEFAULT_PURCHASE_TYPES),
  allowDrift: z.boolean().default(false),
});
export type MetaSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): MetaCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ApplyAbort(`${META_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): MetaSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}

const FUNNEL_FIELDS = 'impressions,clicks,spend,actions,action_values';
const tr = (since: string, until: string) => JSON.stringify({ since, until });

/* ------------------------------ 수집 ------------------------------ */

export async function fetchMeta(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const m = new MetaClient(ctx, parseCreds(ctx), { version: s.apiVersion });
  const today = kstToday();
  const hour = kstHour();
  const intraday = opts.intradayDate;
  const r = intraday ? clampRange({ from: intraday, to: intraday }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { mediaDaily: [], mediaHourly: [], campaigns: [], accounts: [], warnings: [] };

  const acct = await m.accountInfo();
  const offset = currencyOffset(acct.currency);
  if (acct.currency && acct.currency !== 'KRW') warn(batch, 'currency_not_krw', `광고 계정 통화가 ${acct.currency}입니다 — 금액을 원으로 환산하지 않았고 예산 최소 단위는 오프셋 100으로 가정했습니다`);
  if (acct.timezone_name && acct.timezone_name !== 'Asia/Seoul') warn(batch, 'timezone_not_kst', `광고 계정 시간대가 ${acct.timezone_name}입니다 — 일자 · 시간대가 KST와 어긋날 수 있습니다`);

  if (r) {
    const daily = new DailyAcc();
    for (const w of splitRange(r.from, r.to, 31)) {
      for (const row of await m.insights({ level: 'account', time_increment: 1, time_range: tr(w.from, w.to), fields: FUNNEL_FIELDS }, '일별 성과 조회')) {
        const d = isoDate(row.date_start);
        if (d) daily.add(d, funnelOfInsight(row, s.purchaseActionTypes));
      }
    }
    batch.mediaDaily = daily.rows('meta');

    const hr = s.hourlyDays > 0 ? tailRange(r, addDaysStr(today, -(s.hourlyDays - 1))) : null;
    if (hr) await softPart(batch, 'hourly_failed', '시간대 성과', async () => {
      const hourly = new HourlyAcc();
      for (const w of splitRange(hr.from, hr.to, 7)) {
        const rows = await m.insights({ level: 'account', time_increment: 1, time_range: tr(w.from, w.to), breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone', fields: FUNNEL_FIELDS }, '시간대 성과 조회');
        for (const row of rows) {
          const d = isoDate(row.date_start);
          const h = hourOfInsight(row);
          if (d && h !== null && !(d === today && h > hour)) hourly.add(d, h, funnelOfInsight(row, s.purchaseActionTypes));
        }
      }
      batch.mediaHourly = hourly.rows('meta');
    });
  }

  // 예산 단위 · 오늘 소진
  const spentByAdset = new Map<string, number>();
  const spentByCampaign = new Map<string, number>();
  for (const row of await m.insights({ level: 'adset', time_range: tr(today, today), fields: 'campaign_id,adset_id,spend' }, '오늘 광고 세트 소진 조회')) {
    const v = krw(row.spend);
    if (row.adset_id) spentByAdset.set(row.adset_id, (spentByAdset.get(row.adset_id) ?? 0) + v);
    if (row.campaign_id) spentByCampaign.set(row.campaign_id, (spentByCampaign.get(row.campaign_id) ?? 0) + v);
  }
  const units = budgetUnits(await m.campaigns(), await m.adsets(), spentByCampaign, spentByAdset, { offset, hour, intentRules: s.intentRules });
  batch.campaigns = units.rows;
  if (units.lifetimeOnly) warn(batch, 'lifetime_budget', `예산 단위 ${units.lifetimeOnly}개는 평생 예산만 있어 일 예산을 0으로 두었습니다 (일 예산 반영 대상 아님)`);

  const week = await softPart(batch, 'account_failed', '최근 7일 소진', async () => (await m.insights({ level: 'account', time_range: tr(addDaysStr(today, -7), addDaysStr(today, -1)), fields: 'spend' }, '최근 7일 소진 조회')).reduce((a, x) => a + num(x.spend), 0));
  const { account, balanceKnown } = accountOf(acct, m.account, Math.round((week ?? 0) / 7), offset, s.owner);
  if (!balanceKnown) warn(batch, 'prepay_balance_unknown', '선불 계정의 남은 잔액은 Marketing API 문서에 필드가 없어 조회하지 않았습니다 (계정 지출 한도를 설정하면 한도 기준 잔여로 표시)');
  batch.accounts = [account];

  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

/* ------------------------------ 반영 ------------------------------ */

export async function applyMeta(ctx: ConnectorContext, change: ChangeRequest): Promise<ApplyResult> {
  const s = parseSettings(ctx);
  let m: MetaClient;
  try {
    m = new MetaClient(ctx, parseCreds(ctx), { version: s.apiVersion });
  } catch (e) {
    return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: (e as Error).message };
  }
  const t = metaTarget(change.targetId);
  if (!t) return unsupported(change, META_LABEL, `대상 id(${change.targetId ?? '—'})가 Meta 캠페인(meta-cmp-) · 광고 세트(meta-adset-) 형식이 아닙니다`);
  const unit = t.type === 'campaign' ? '캠페인' : '광고 세트';

  if (change.kind === 'budget') {
    const after = parseKrwAmount(change.after);
    if (after === null) return { ok: false, request: { targetId: change.targetId }, error: '일 예산 값이 올바르지 않습니다' };
    const curFields = { fields: 'name,daily_budget,lifetime_budget,effective_status' };
    const params = { daily_budget: after }; // KRW 오프셋 1 → 원 그대로
    return executePlan(ctx, {
      label: META_LABEL, what: `${unit} 일 예산 변경`, intended: after,
      steps: [
        step(m.getRequest(m.account, { fields: 'currency' }), '광고 계정 통화 확인 (KRW만 반영)'),
        step(m.getRequest(t.id, curFields), '현재 일 예산 확인'),
        step(m.postRequest(t.id, params)),
        step(m.getRequest(t.id, { fields: 'daily_budget' }), '반영 값 확인'),
      ],
      live: async () => {
        const acct = await m.get<{ currency?: string }>(m.account, { fields: 'currency' }, '광고 계정 통화 확인');
        if (acct?.currency && acct.currency !== 'KRW') throw new ApplyAbort(`광고 계정 통화가 ${acct.currency}입니다 — 통화 최소 단위를 문서로 확인한 KRW 계정만 예산을 반영합니다`);
        const cur = await m.get<{ daily_budget?: string; lifetime_budget?: string }>(t.id, curFields, '현재 일 예산 조회');
        if (!(num(cur?.daily_budget) > 0)) throw new ApplyAbort(`${unit}에 일 예산이 없습니다${num(cur?.lifetime_budget) > 0 ? '(평생 예산 사용)' : ''} — 일 예산 변경 대상이 아니어서 반영하지 않았습니다`);
        assertNoDrift(`${unit} 일 예산`, change.before, num(cur.daily_budget), after, s.allowDrift);
        const res = await m.post<{ success?: boolean }>(t.id, params, `${unit} 일 예산 변경`);
        if (res && res.success === false) throw new ApplyAbort(`${META_LABEL}가 success=false를 돌려줬습니다`);
        let applied: number | undefined;
        try {
          applied = krw((await m.get<{ daily_budget?: string }>(t.id, { fields: 'daily_budget' }, '반영 값 확인')).daily_budget) || undefined;
        } catch (e) {
          ctx.log(`${META_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`);
        }
        return { response: res, appliedValue: applied ?? after };
      },
    });
  }

  if (change.kind === 'status') {
    const onoff = parseOnOff(change.after);
    if (!onoff) return { ok: false, request: { targetId: change.targetId }, error: `상태 값(${String(change.after)})을 on/off로 해석할 수 없습니다` };
    const params = { status: onoff === 'on' ? 'ACTIVE' : 'PAUSED' };
    return executePlan(ctx, {
      label: META_LABEL, what: `${unit} ${params.status}`, intended: onoff,
      steps: [step(m.postRequest(t.id, params)), step(m.getRequest(t.id, { fields: 'status,effective_status' }), '반영 값 확인')],
      live: async () => {
        const res = await m.post<{ success?: boolean }>(t.id, params, `${unit} 상태 변경`);
        if (res && res.success === false) throw new ApplyAbort(`${META_LABEL}가 success=false를 돌려줬습니다`);
        let applied: string | undefined;
        try {
          const st = (await m.get<{ status?: string }>(t.id, { fields: 'status,effective_status' }, '반영 값 확인')).status;
          applied = st ? (st === 'ACTIVE' ? 'on' : 'off') : undefined;
        } catch (e) {
          ctx.log(`${META_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`);
        }
        return { response: res, appliedValue: applied ?? onoff };
      },
    });
  }

  return unsupported(change, META_LABEL);
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'meta',
  kind: 'media',
  channel: 'meta',
  label: META_LABEL,
  docsUrl: 'https://developers.facebook.com/docs/marketing-api/insights',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'accessToken', label: '시스템 사용자 액세스 토큰', secret: true, help: '비즈니스 관리자 > 비즈니스 설정 > 사용자 > 시스템 사용자에서 광고 계정을 할당하고 ads_read · ads_management 권한으로 생성한 토큰 (만료 없음 권장)' },
    { key: 'adAccountId', label: '광고 계정 ID', secret: false, help: '광고 관리자 주소의 act= 뒤 숫자 또는 비즈니스 설정 > 광고 계정의 ID (act_ 접두어는 자동 처리)' },
    { key: 'appSecret', label: '앱 시크릿 (선택)', secret: true, optional: true, help: '앱 대시보드 > 앱 설정 > 기본 설정의 앱 시크릿. 넣으면 모든 호출에 appsecret_proof를 붙입니다 (앱 설정에서 필수로 켠 경우 필요)' },
  ],
  capabilities: {
    reads: ['mediaDaily', 'mediaHourly', 'campaigns', 'accounts'],
    writes: ['budget', 'status'],
    intraday: true,
    // Insights 문서: 37개월보다 오래된 시작일은 오류 3018
    maxBackfillDays: 1095,
  },
  async test(ctx) {
    return testOutcome(async () => {
      const s = parseSettings(ctx);
      const m = new MetaClient(ctx, parseCreds(ctx), { version: s.apiVersion });
      const a = await m.accountInfo();
      const notes: string[] = [];
      if (a.currency && a.currency !== 'KRW') notes.push(`통화 ${a.currency}(원 환산 안 함 · 예산 반영 불가)`);
      if (a.timezone_name && a.timezone_name !== 'Asia/Seoul') notes.push(`시간대 ${a.timezone_name}`);
      if (Number(a.account_status) !== 1) notes.push(`계정 상태 코드 ${a.account_status}${a.disable_reason ? ` · 비활성 사유 ${a.disable_reason}` : ''}`);
      return {
        ok: true,
        account: `Meta ${a.name ?? m.account}`,
        message: `연결 확인 — ${a.name ?? m.account} (${m.account}) · 통화 ${a.currency ?? '—'} · 시간대 ${a.timezone_name ?? '—'}${notes.length ? ` · 확인 필요: ${notes.join(', ')}` : ''}`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchMeta(ctx, range, opts),
  apply: (ctx, change) => applyMeta(ctx, change),
};
