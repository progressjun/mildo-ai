/**
 * 카카오모먼트 커넥터 (docs/SAAS_SPEC.md §4 connectors-media) — openapi/v4, 비즈니스 토큰.
 *
 * 공식 문서 (2026-11-02 확인 — 상세 근거는 client.ts 머리말):
 *   https://developers.kakao.com/docs/latest/ko/kakaomoment/common      API 목록 · 사용 조건(비즈 앱 · 비즈니스 인증)
 *   https://developers.kakao.com/docs/latest/ko/kakaomoment/report      보고서 (31일 · 5초에 1회 · 오늘은 datePreset=TODAY)
 *   https://developers.kakao.com/docs/latest/ko/kakaomoment/campaign    캠페인 일 예산 · ON/OFF
 *   https://developers.kakao.com/docs/latest/ko/kakaomoment/ad-group    광고그룹 일 예산 · ON/OFF
 *   https://developers.kakao.com/docs/latest/ko/kakaomoment/type-info   지표 · 차원 값
 *
 * 수집 (fetch) — 문서의 호출 간격(보고서 5초, 광고그룹 보고서 1초)을 지키며 부른다
 *   - mediaDaily: 광고계정 보고서 timeUnit=DAY (31일 구간), 오늘은 datePreset=TODAY · dimension=HOUR 합계
 *   - mediaHourly: dimension=HOUR — 오늘(TODAY) + 최근 hourlyDays일(일자별 1회씩, 기본 7일)
 *   - campaigns: 예산 단위(캠페인 일 예산 우선, 없으면 광고그룹 일 예산), 오늘 소진은 캠페인 · 광고그룹 보고서 TODAY
 *   - accounts: 실시간 잔액(유상 + 무상 캐시) · 최근 7일 평균 비용(LAST_7DAY). 자동충전 상태는 API 미제공 → 설정 autoCharge
 *   - 전환: 픽셀 & SDK 구매(conv_purchase_7d · conv_purchase_p_7d, 설정 conversionWindow로 1d 선택)
 *   - 키워드 · 검색어: 카카오모먼트(디스플레이)에는 해당 없음 (카카오 키워드광고는 별도 API — 이 커넥터 범위 밖)
 *
 * 반영 (apply) — dryRun이면 네트워크 호출 없이 단계만 돌려준다
 *   - budget : 캠페인 PUT /campaigns/dailyBudgetAmount (5만~10억, 10원 단위) · 광고그룹 PUT /adGroups/dailyBudgetAmount (1만~5억, 10원 단위)
 *              사전 조회로 현재 값 확인(불일치 시 멈춤) → 반영 → 확인 읽기
 *   - status : PUT /campaigns/onOff · /adGroups/onOff { id, config: ON|OFF } → 확인 읽기
 *   - bid    : 광고그룹 최대 입찰금액(PUT /adGroups/bidAmount)은 문서에 있으나, MILDO OS 입찰 변경(bid)은 키워드 대상이라 연결하지 않는다
 */
import { z } from 'zod';
import type { ApplyResult, ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { ChangeRequest } from '@/core/types';
import { addDaysStr, dateRange, kstHour, kstToday } from '../../lib/time';
import {
  ApplyAbort, DailyAcc, HourlyAcc, assertNoDrift, chunk, clampRange, commonSettingsShape, compactDate, executePlan, isoDate, krw, num,
  parseKrwAmount, parseOnOff, softPart, splitRange, step, testOutcome, unsupported, warn,
} from '../naver-sa/media-shared';
import { KAKAO_LABEL, KakaoClient, type KakaoAdGroup, type KakaoCredentials } from './client';
import { accountOf, budgetUnits, funnelOfReport, hourOfReport, isLive, kakaoTarget, type ConversionWindow } from './normalize';

export const credentialsSchema = z.object({
  accessToken: z.string().trim().min(10, '비즈니스 토큰을 입력해 주세요'),
  adAccountId: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{1,20}$/, '광고계정 ID는 숫자입니다')),
});

export const settingsSchema = z.object({
  ...commonSettingsShape,
  conversionWindow: z.enum(['1d', '7d']).default('7d'),
  /** 지난 일자 시간대 보고서 일수 (일자마다 1회, 5초 간격) */
  hourlyDays: z.number().int().min(0).max(31).default(7),
  autoCharge: z.enum(['ok', 'off']).default('off'),
  allowDrift: z.boolean().default(false),
});
export type KakaoSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): KakaoCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ApplyAbort(`${KAKAO_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): KakaoSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}

const metrics = 'BASIC,PIXEL_SDK_CONVERSION';
/** 문서: 캠페인 일 예산 5만~10억 원, 광고그룹 1만~5억 원, 둘 다 10원 단위 */
export const KAKAO_BUDGET = { campaign: { min: 50_000, max: 1_000_000_000 }, adgroup: { min: 10_000, max: 500_000_000 } } as const;

/* ------------------------------ 수집 ------------------------------ */

export async function fetchKakao(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const k = new KakaoClient(ctx, parseCreds(ctx));
  const w: ConversionWindow = s.conversionWindow;
  const today = kstToday();
  const hour = kstHour();
  const intraday = opts.intradayDate;
  const r = intraday ? clampRange({ from: intraday, to: intraday }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { mediaDaily: [], mediaHourly: [], campaigns: [], accounts: [], warnings: [] };
  const acct = { adAccountId: k.accountId };
  let hourKeyMissing = false;

  if (r) {
    const daily = new DailyAcc();
    const hourly = new HourlyAcc();
    const addHourly = (date: string, rows: Awaited<ReturnType<KakaoClient['report']>>, alsoDaily: boolean) => {
      for (const row of rows) {
        const h = hourOfReport(row);
        if (h === 'total') continue;
        if (h === null) { hourKeyMissing = true; continue; }
        if (date === today && h > hour) continue;
        const f = funnelOfReport(row, w);
        hourly.add(date, h, f);
        if (alsoDaily) daily.add(date, f);
      }
    };
    const pastTo = r.to < today ? r.to : addDaysStr(today, -1);
    if (r.from <= pastTo) {
      for (const win of splitRange(r.from, pastTo, 31)) {
        const rows = await k.report('adAccounts', { ...acct, start: compactDate(win.from), end: compactDate(win.to), timeUnit: 'DAY', level: 'AD_ACCOUNT', metricsGroup: metrics }, '일별 보고서 조회');
        for (const row of rows) {
          const d = isoDate(row.start);
          if (d && d >= win.from && d <= win.to) daily.add(d, funnelOfReport(row, w));
        }
      }
    }
    if (r.to >= today) {
      addHourly(today, await k.report('adAccounts', { ...acct, datePreset: 'TODAY', level: 'AD_ACCOUNT', dimension: 'HOUR', metricsGroup: metrics }, '오늘 시간대 보고서 조회'), true);
    }
    if (s.hourlyDays > 0 && r.from <= pastTo) {
      const from = addDaysStr(today, -s.hourlyDays);
      await softPart(batch, 'hourly_failed', '지난 일자 시간대 보고서', async () => {
        for (const d of dateRange(r.from > from ? r.from : from, pastTo)) {
          addHourly(d, await k.report('adAccounts', { ...acct, start: compactDate(d), end: compactDate(d), level: 'AD_ACCOUNT', dimension: 'HOUR', metricsGroup: metrics }, '시간대 보고서 조회'), false);
        }
      });
    }
    batch.mediaDaily = daily.rows('kakao');
    batch.mediaHourly = hourly.rows('kakao');
    if (hourKeyMissing) warn(batch, 'hour_dimension_unparsed', '시간대 보고서 행에서 시간 값을 찾지 못해 일부 행을 건너뛰었습니다 (dimensions 키 이름 확인 필요)');
  }

  // 예산 단위 · 오늘 소진
  const campaigns = (await k.campaigns()).filter(isLive);
  const details = [];
  for (const c of campaigns) details.push({ ...c, ...(await k.campaign(c.id)) });
  const groups = new Map<number, KakaoAdGroup[]>();
  for (const c of details.filter((x) => !(num(x.dailyBudgetAmount) > 0))) {
    const list: KakaoAdGroup[] = [];
    for (const g of (await k.adGroups(c.id)).filter(isLive)) list.push({ ...g, ...(await k.adGroup(g.id)) });
    groups.set(c.id, list);
  }
  const spentCampaign = new Map<string, number>();
  for (const part of chunk(details.map((c) => String(c.id)), 5)) {
    for (const row of await k.report('campaigns', { campaignId: part.join(','), datePreset: 'TODAY', level: 'CAMPAIGN', metricsGroup: 'BASIC' }, '오늘 캠페인 비용 조회')) {
      const id = String(row.dimensions?.campaign_id ?? '');
      if (id) spentCampaign.set(id, (spentCampaign.get(id) ?? 0) + krw(row.metrics?.cost));
    }
  }
  const spentAdGroup = new Map<string, number>();
  const groupIds = [...groups.values()].flat().filter((g) => num(g.dailyBudgetAmount) > 0).map((g) => String(g.id));
  for (const part of chunk(groupIds, 40)) {
    for (const row of await k.report('adGroups', { adGroupId: part.join(','), datePreset: 'TODAY', level: 'AD_GROUP', metricsGroup: 'BASIC' }, '오늘 광고그룹 비용 조회')) {
      const id = String(row.dimensions?.ad_group_id ?? '');
      if (id) spentAdGroup.set(id, (spentAdGroup.get(id) ?? 0) + krw(row.metrics?.cost));
    }
  }
  batch.campaigns = budgetUnits(details, groups, spentCampaign, spentAdGroup, { hour, intentRules: s.intentRules });

  // 계정
  await softPart(batch, 'account_failed', '계정 · 잔액', async () => {
    const week = (await k.report('adAccounts', { ...acct, datePreset: 'LAST_7DAY', timeUnit: 'ALL', level: 'AD_ACCOUNT', metricsGroup: 'BASIC' }, '최근 7일 비용 조회')).reduce((a, x) => a + krw(x.metrics?.cost), 0);
    const info = await k.account();
    const bal = await k.balance();
    if (info.isOutOfBalance) warn(batch, 'out_of_balance', '광고계정이 잔액 부족 상태입니다 (isOutOfBalance=true)');
    batch.accounts = [accountOf(info, k.accountId, bal, Math.round(week / 7), s)];
  });

  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

/* ------------------------------ 반영 ------------------------------ */

export async function applyKakao(ctx: ConnectorContext, change: ChangeRequest): Promise<ApplyResult> {
  const s = parseSettings(ctx);
  let k: KakaoClient;
  try {
    k = new KakaoClient(ctx, parseCreds(ctx));
  } catch (e) {
    return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: (e as Error).message };
  }
  const t = kakaoTarget(change.targetId);
  if (!t) return unsupported(change, KAKAO_LABEL, `대상 id(${change.targetId ?? '—'})가 카카오모먼트 캠페인(kakao-cmp-) · 광고그룹(kakao-grp-) 형식이 아닙니다`);
  const isCmp = t.type === 'campaign';
  const unit = isCmp ? '캠페인' : '광고그룹';
  const id = Number(t.id);
  const read = () => (isCmp ? k.campaign(id) : k.adGroup(id));
  const readReq = k.request('GET', isCmp ? `/campaigns/${id}` : `/adGroups/${id}`);

  if (change.kind === 'budget') {
    const after = parseKrwAmount(change.after);
    if (after === null) return { ok: false, request: { targetId: change.targetId }, error: '일 예산 값이 올바르지 않습니다' };
    const lim = isCmp ? KAKAO_BUDGET.campaign : KAKAO_BUDGET.adgroup;
    if (after < lim.min || after > lim.max || after % 10 !== 0) {
      return { ok: false, request: { targetId: change.targetId, dailyBudgetAmount: after }, error: `카카오모먼트 ${unit} 일 예산은 ${lim.min.toLocaleString('ko-KR')}~${lim.max.toLocaleString('ko-KR')}원, 10원 단위입니다 (요청 ${after.toLocaleString('ko-KR')}원)` };
    }
    const path = isCmp ? '/campaigns/dailyBudgetAmount' : '/adGroups/dailyBudgetAmount';
    const body = { id, dailyBudgetAmount: after };
    return executePlan(ctx, {
      label: KAKAO_LABEL, what: `${unit} 일 예산 변경`, intended: after,
      steps: [step(readReq, '현재 일 예산 확인'), step(k.request('PUT', path, undefined, body)), step(readReq, '반영 값 확인')],
      live: async () => {
        const cur = await read();
        const curBudget = num(cur?.dailyBudgetAmount);
        assertNoDrift(`${unit} 일 예산`, change.before, curBudget > 0 ? curBudget : null, after, s.allowDrift);
        const notes = isCmp && curBudget > 0 && after < curBudget ? ['캠페인 일 예산을 줄이면 조건을 넘는 하위 광고그룹 일 예산 · 입찰금액이 카카오 규칙대로 함께 낮아질 수 있습니다'] : [];
        const res = await k.write(path, body, `${unit} 일 예산 변경`);
        let applied: number | undefined;
        try { applied = krw((await read())?.dailyBudgetAmount) || undefined; } catch (e) { ctx.log(`${KAKAO_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`); }
        return { response: res ?? { status: 'ok' }, appliedValue: applied ?? after, notes };
      },
    });
  }

  if (change.kind === 'status') {
    const onoff = parseOnOff(change.after);
    if (!onoff) return { ok: false, request: { targetId: change.targetId }, error: `상태 값(${String(change.after)})을 on/off로 해석할 수 없습니다` };
    const path = isCmp ? '/campaigns/onOff' : '/adGroups/onOff';
    const body = { id, config: onoff === 'on' ? 'ON' : 'OFF' };
    return executePlan(ctx, {
      label: KAKAO_LABEL, what: `${unit} ${body.config}`, intended: onoff,
      steps: [step(k.request('PUT', path, undefined, body)), step(readReq, '반영 값 확인')],
      live: async () => {
        const res = await k.write(path, body, `${unit} ON/OFF`);
        let applied: string | undefined;
        try { const c = (await read())?.config; applied = c ? (c === 'ON' ? 'on' : 'off') : undefined; } catch (e) { ctx.log(`${KAKAO_LABEL} 반영 후 확인 읽기 실패: ${(e as Error).message}`); }
        return { response: res ?? { status: 'ok' }, appliedValue: applied ?? onoff };
      },
    });
  }

  return unsupported(change, KAKAO_LABEL);
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'kakao_moment',
  kind: 'media',
  channel: 'kakao',
  label: KAKAO_LABEL,
  docsUrl: 'https://developers.kakao.com/docs/latest/ko/kakaomoment/common',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'accessToken', label: '비즈니스 토큰', secret: true, help: '카카오디벨로퍼스 비즈 앱에서 카카오모먼트 사용 권한 승인 후, 비즈니스 인증(moment_management 동의 · resource_ids=moment:<광고계정 ID>)으로 발급한 토큰. 갱신 토큰이 없고 장기간 쓰지 않으면 만료됩니다' },
    { key: 'adAccountId', label: '광고계정 ID', secret: false, help: '카카오모먼트 광고계정 번호 (카카오모먼트 화면 광고계정 정보 또는 광고계정 목록 조회 API의 id)' },
  ],
  capabilities: {
    reads: ['mediaDaily', 'mediaHourly', 'campaigns', 'accounts'],
    writes: ['budget', 'status'],
    intraday: true,
    // 보고서 보관 기간이 문서에 명시되어 있지 않아 스펙 §4 백필 상한(400일)을 쓴다 (31일 구간으로 나눠 호출)
    maxBackfillDays: 400,
  },
  async test(ctx) {
    return testOutcome(async () => {
      const k = new KakaoClient(ctx, parseCreds(ctx));
      const a = await k.account();
      const bal = await k.balance();
      const total = krw(bal.cash) + krw(bal.freeCash);
      return {
        ok: a.config !== 'DEL',
        account: `카카오모먼트 ${a.name ?? k.accountId}`,
        message: `연결 확인 — ${a.name ?? k.accountId} (${k.accountId}) · 상태 ${a.statusDescription ?? a.config ?? '—'} · 잔액 ${total.toLocaleString('ko-KR')}원. 보고서 API는 5초에 1회로 제한되어 수집에 시간이 걸릴 수 있습니다`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchKakao(ctx, range, opts),
  apply: (ctx, change) => applyKakao(ctx, change),
};
