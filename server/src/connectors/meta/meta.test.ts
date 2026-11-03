/** Meta 커넥터 — insights 정규화(구매 유형 · 시간대 · 커서 페이지) · 예산 단위 · 오류 코드 · 반영(dry_run · live). 실제 네트워크 없음. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connector } from './index';
import { appSecretProof, describeMetaError } from './client';
import { budgetUnits, funnelOfInsight, hourOfInsight, metaTarget } from './normalize';
import { fakeCtx, fakeHttp, type FakeRoute } from '../naver-sa/fake-http';
import { setNowForTest } from '../../lib/time';
import type { ChangeRequest } from '@/core/types';

const CREDS = { accessToken: 'EAAtestsystemusertoken0123456789', adAccountId: 'act_1234567' };
const NOW = Date.parse('2026-11-02T05:30:00Z'); // 14:30 KST
const TODAY = '2026-11-02';
beforeAll(() => setNowForTest(NOW));
afterAll(() => setNowForTest(null));

const BASE = 'https://graph.facebook.com/v26.0';
const qv = (req: { query?: Record<string, unknown> }, k: string) => String(req.query?.[k] ?? '');
const row = (date: string, extra: object = {}) => ({
  date_start: date, date_stop: date, impressions: '20000', clicks: '400', spend: '180000',
  actions: [{ action_type: 'link_click', value: '380' }, { action_type: 'omni_purchase', value: '6' }, { action_type: 'purchase', value: '6' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' }],
  action_values: [{ action_type: 'omni_purchase', value: '1500000' }, { action_type: 'purchase', value: '1500000' }],
  ...extra,
});

function metaRoutes(o: { currency?: string; tz?: string; spendCap?: string; prepay?: boolean } = {}): FakeRoute[] {
  return [
    {
      method: 'GET', match: `${BASE}/act_1234567/insights`,
      reply: (req) => {
        const tr = JSON.parse(qv(req, 'time_range')) as { since: string; until: string };
        if (qv(req, 'level') === 'adset') return { data: { data: [{ campaign_id: '11', adset_id: '21', spend: '30000' }, { campaign_id: '12', adset_id: '22', spend: '12000' }, { campaign_id: '12', adset_id: '23', spend: '500.4' }] } };
        if (qv(req, 'fields') === 'spend') return { data: { data: [{ spend: '1260000', date_start: tr.since, date_stop: tr.until }] } };
        const dates: string[] = [];
        for (let d = tr.since; d <= tr.until; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) dates.push(d);
        if (qv(req, 'breakdowns')) {
          return { data: { data: dates.flatMap((d) => ['00:00:00 - 00:59:59', '13:00:00 - 13:59:59', '20:00:00 - 20:59:59'].map((h) => row(d, { spend: '1000', hourly_stats_aggregated_by_advertiser_time_zone: h }))) } };
        }
        // 일별: 2건씩 커서 페이지
        const after = qv(req, 'after');
        const start = after ? Number(after) : 0;
        const page = dates.slice(start, start + 2);
        const more = start + 2 < dates.length;
        return { data: { data: page.map((d) => row(d)), paging: { cursors: { before: 'b', after: String(start + 2) }, ...(more ? { next: `${BASE}/act_1234567/insights?access_token=SECRET&after=${start + 2}` } : {}) } } };
      },
    },
    { method: 'GET', match: `${BASE}/act_1234567/campaigns`, reply: { data: { data: [
      { id: '11', name: '신규 고객 CBO', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '400000' },
      { id: '12', name: '리타겟팅', status: 'ACTIVE', effective_status: 'ACTIVE' },
      { id: '13', name: '보관', status: 'ARCHIVED', effective_status: 'ARCHIVED', daily_budget: '100000' },
    ] } } },
    { method: 'GET', match: `${BASE}/act_1234567/adsets`, reply: { data: { data: [
      { id: '21', campaign_id: '11', name: 'CBO 세트', status: 'ACTIVE', effective_status: 'ACTIVE' },
      { id: '22', campaign_id: '12', name: '장바구니', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '150000' },
      { id: '23', campaign_id: '12', name: '상세 조회', status: 'PAUSED', effective_status: 'PAUSED', lifetime_budget: '3000000' },
    ] } } },
    { method: 'GET', match: (req) => req.url === `${BASE}/act_1234567`, reply: { data: { id: 'act_1234567', name: '수면밀도', account_status: 1, currency: o.currency ?? 'KRW', timezone_name: o.tz ?? 'Asia/Seoul', amount_spent: '8000000', spend_cap: o.spendCap ?? '0', is_prepay_account: o.prepay ?? false } } },
  ];
}

const change = (p: Partial<ChangeRequest>): ChangeRequest => ({
  id: 'c1', createdAt: '2026-11-02T05:00:00Z', module: 'adpilot', kind: 'budget', target: '리타겟팅 · 장바구니 일 예산', targetId: 'budget:meta-adset-22:',
  before: 150000, after: 180000, reason: 't', requestedBy: 'AD Pilot', approver: 'PM', status: 'approved', history: [], ...p,
});

describe('정규화', () => {
  it('구매 전환은 우선순위 첫 유형 하나만(중복 합산 금지) · 매출도 같은 유형 · 원 정수', () => {
    expect(funnelOfInsight(row('2026-11-01'))).toEqual({ impressions: 20000, clicks: 400, cost: 180000, conversions: 6, revenue: 1500000 });
    expect(funnelOfInsight(row('2026-11-01'), ['offsite_conversion.fb_pixel_purchase'])).toEqual({ impressions: 20000, clicks: 400, cost: 180000, conversions: 5, revenue: 0 });
    expect(funnelOfInsight({ impressions: '10', spend: '99.6' })).toEqual({ impressions: 10, clicks: 0, cost: 100, conversions: 0, revenue: 0 });
    expect(hourOfInsight({ hourly_stats_aggregated_by_advertiser_time_zone: '13:00:00 - 13:59:59' })).toBe(13);
    expect(hourOfInsight({})).toBeNull();
  });

  it('예산 단위: CBO 캠페인 · 광고 세트 예산 · 평생 예산 · 보관 제외', () => {
    const u = budgetUnits(
      [{ id: '1', name: 'CBO', effective_status: 'ACTIVE', daily_budget: '5000' }, { id: '2', name: 'ABO', effective_status: 'PAUSED' }, { id: '3', name: 'x', effective_status: 'DELETED', daily_budget: '1' }],
      [{ id: '9', campaign_id: '2', name: 's', effective_status: 'ACTIVE', daily_budget: '2000' }],
      new Map([['1', 700]]), new Map(), { offset: 1, hour: 9 },
    );
    expect(u.rows.map((r) => [r.id, r.dailyBudget, r.status, r.spentToday])).toEqual([['meta-cmp-1', 5000, 'on', 700], ['meta-adset-9', 2000, 'off', 0]]);
    expect(metaTarget('budget:meta-adset-22:')).toEqual({ type: 'adset', id: '22' });
    expect(metaTarget('gads-cmp-1')).toBeNull();
  });

  it('오류 코드: 190 토큰 · 17/613 호출 한도 · 200 권한 · 3018 기간', () => {
    expect(describeMetaError(400, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } })).toMatchObject({ kind: 'auth', code: '190' });
    expect(describeMetaError(400, { error: { message: 'User request limit reached', code: 17 } })).toMatchObject({ kind: 'rate' });
    expect(describeMetaError(400, { error: { message: 'Calls to this api have exceeded the rate limit.', code: 613 } })).toMatchObject({ kind: 'rate' });
    expect(describeMetaError(403, { error: { message: 'Permissions error', code: 200 } })).toMatchObject({ kind: 'permission' });
    expect(describeMetaError(400, { error: { message: 'start date', code: 3018 } })!.detail).toMatch(/37개월/);
  });
});

describe('수집 (fetch)', () => {
  it('일별(커서 페이지 · 31일 구간) · 시간대 · 예산 단위 · 계정 — 토큰은 쿼리로만', async () => {
    const http = fakeHttp(metaRoutes());
    const b = await connector.fetch(fakeCtx({ ...CREDS, appSecret: 'app-secret-x' }, { hourlyDays: 2 }, http), { from: '2026-10-28', to: '2026-11-09' });
    expect(b.mediaDaily!.map((r) => r.date)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(b.mediaDaily![0]).toEqual({ date: '2026-10-28', media: 'meta', impressions: 20000, clicks: 400, cost: 180000, conversions: 6, revenue: 1500000 });
    const daily = http.callsTo('/insights').filter((c) => qv(c, 'level') === 'account' && qv(c, 'time_increment') === '1' && !qv(c, 'breakdowns'));
    expect(daily.map((c) => qv(c, 'after'))).toEqual(['', '2', '4']);
    expect(daily[0].query).toMatchObject({ use_account_attribution_setting: true, limit: 500, fields: 'impressions,clicks,spend,actions,action_values' });
    expect(daily[0].query!.access_token).toBe(CREDS.accessToken);
    expect(daily[0].query!.appsecret_proof).toBe(appSecretProof('app-secret-x', CREDS.accessToken));

    expect(b.mediaHourly!.map((r) => `${r.date} ${r.hour}`)).toEqual(['2026-11-01 0', '2026-11-01 13', '2026-11-01 20', '2026-11-02 0', '2026-11-02 13']);

    expect(b.campaigns).toEqual([
      { id: 'meta-cmp-11', media: 'meta', name: '신규 고객 CBO', intent: 'generic', dailyBudget: 400000, spentToday: 30000, status: 'on', hourOfData: 14 },
      { id: 'meta-adset-22', media: 'meta', name: '리타겟팅 · 장바구니', intent: 'generic', dailyBudget: 150000, spentToday: 12000, status: 'on', hourOfData: 14 },
      { id: 'meta-adset-23', media: 'meta', name: '리타겟팅 · 상세 조회', intent: 'generic', dailyBudget: 0, spentToday: 500, status: 'off', hourOfData: 14 },
    ]);
    expect(b.accounts![0]).toMatchObject({ id: 'meta-1234567', media: 'meta', balance: -1, autoCharge: 'postpaid', avgDailySpend: 180000, status: 'active' });
    expect(b.warnings!.map((w) => w.code)).toEqual(['lifetime_budget']);
    expect(b.keywords).toBeUndefined();
  });

  it('지출 한도가 있으면 한도 기준 잔여 · 선불 잔액 미확인 경고 · 통화 · 시간대 경고', async () => {
    const capped = await connector.fetch(fakeCtx(CREDS, { hourlyDays: 0 }, fakeHttp(metaRoutes({ spendCap: '10000000' }))), { from: TODAY, to: TODAY });
    expect(capped.accounts![0].balance).toBe(2_000_000);
    const pre = await connector.fetch(fakeCtx(CREDS, { hourlyDays: 0 }, fakeHttp(metaRoutes({ prepay: true, currency: 'USD', tz: 'America/Los_Angeles' }))), { from: TODAY, to: TODAY });
    expect(pre.warnings!.map((w) => w.code)).toEqual(expect.arrayContaining(['prepay_balance_unknown', 'currency_not_krw', 'timezone_not_kst']));
    expect(pre.accounts![0]).toMatchObject({ balance: -1, autoCharge: 'off' });
  });

  it('토큰 만료(400 · code 190) → 한국어 인증 실패', async () => {
    const http = fakeHttp([{ match: 'graph.facebook.com', reply: { status: 400, data: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } } }]);
    await expect(connector.fetch(fakeCtx(CREDS, {}, http), { from: TODAY, to: TODAY })).rejects.toThrow(/Meta 광고 인증 실패.*토큰을 다시 발급/);
    const r = await connector.test(fakeCtx(CREDS, {}, http));
    expect(r.ok).toBe(false);
  });
});

describe('반영 (apply)', () => {
  it('dry_run 예산: 네트워크 없이 통화 확인 → 현재 예산 → POST daily_budget(원 그대로) → 확인 읽기, 토큰 미포함', async () => {
    const http = fakeHttp([]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http, { dryRun: true }), change({}));
    expect(http.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, appliedValue: 180000 });
    const steps = (r.request as { steps: { method: string; url: string; body?: unknown; query?: unknown }[] }).steps;
    expect(steps.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${BASE}/act_1234567`, `GET ${BASE}/22`, `POST ${BASE}/22`, `GET ${BASE}/22`]);
    expect(steps[2].body).toEqual({ daily_budget: 180000 });
    expect(JSON.stringify(r.request)).not.toContain(CREDS.accessToken);
  });

  const writeRoutes = (cur: object, currency = 'KRW'): FakeRoute[] => {
    let budget = (cur as { daily_budget?: string }).daily_budget;
    return [
      { method: 'GET', match: (req) => req.url === `${BASE}/act_1234567`, reply: { data: { currency } } },
      { method: 'POST', match: `${BASE}/22`, reply: (req) => { budget = String((req.body as { daily_budget?: number }).daily_budget ?? budget); return { data: { success: true } }; } },
      { method: 'GET', match: `${BASE}/22`, reply: (req) => ({ data: qv(req, 'fields') === 'daily_budget' ? { id: '22', daily_budget: budget } : { id: '22', ...cur } }) },
    ];
  };

  it('live 예산: POST 본문(form)에 토큰, 확인 읽기 값을 반영 값으로 · 평생 예산 · KRW 아님 · 값 불일치는 멈춤', async () => {
    const http = fakeHttp(writeRoutes({ daily_budget: '150000', effective_status: 'ACTIVE' }));
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({}));
    expect(r).toMatchObject({ ok: true, appliedValue: 180000 });
    const post = http.calls.find((c) => c.method === 'POST')!;
    expect(post).toMatchObject({ bodyType: 'form', body: { daily_budget: 180000, access_token: CREDS.accessToken } });

    for (const [routes, re] of [
      [writeRoutes({ lifetime_budget: '3000000' }), /평생 예산/],
      [writeRoutes({ daily_budget: '150000' }, 'USD'), /통화가 USD/],
      [writeRoutes({ daily_budget: '170000' }), /요청 시점 값\(150,000원\)과 다릅니다/],
    ] as const) {
      const h = fakeHttp([...routes]);
      const x = await connector.apply!(fakeCtx(CREDS, {}, h), change({}));
      expect(x.ok).toBe(false);
      expect(x.error).toMatch(re);
      expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    }
  });

  it('상태: POST status=PAUSED → 확인 읽기 · 키워드 입찰은 미지원', async () => {
    const http = fakeHttp([
      { method: 'POST', match: `${BASE}/11`, reply: { data: { success: true } } },
      { method: 'GET', match: `${BASE}/11`, reply: { data: { id: '11', status: 'PAUSED', effective_status: 'PAUSED' } } },
    ]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({ kind: 'status', targetId: 'meta-cmp-11', before: 'on', after: 'off' }));
    expect(r).toMatchObject({ ok: true, appliedValue: 'off' });
    expect(http.calls[0].body).toMatchObject({ status: 'PAUSED' });
    const bid = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([])), change({ kind: 'bid', targetId: 'meta-adset-22' }));
    expect(bid.ok).toBe(false);
    expect(connector.capabilities.writes).toEqual(['budget', 'status']);
  });
});

describe('정의', () => {
  it('act_ 접두어 처리 · 필드 안내 · verifiedLive=false', () => {
    expect(connector.credentialsSchema.parse({ accessToken: CREDS.accessToken, adAccountId: 'act_1234567' }).adAccountId).toBe('1234567');
    expect(connector.credentialsSchema.safeParse({ accessToken: CREDS.accessToken, adAccountId: 'abc' }).success).toBe(false);
    expect(connector.verifiedLive).toBe(false);
    expect(connector.credentialFields.every((f) => /[가-힣]/.test(f.label) && f.help)).toBe(true);
    expect(connector.settingsSchema.parse({})).toMatchObject({ apiVersion: 'v26.0', purchaseActionTypes: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'] });
  });
});
