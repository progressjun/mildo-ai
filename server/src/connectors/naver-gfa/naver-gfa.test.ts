/** 네이버 GFA 커넥터 — 네이버 로그인 토큰 갱신 · 성과 API 정규화(next 페이지 · 전환 유형 · 실시간) · 오류 · ON/OFF 반영. 실제 네트워크 없음. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connector, gfaTarget, normCampaigns } from './index';
import { _resetGfaTokenCacheForTest, describeGfaError } from './client';
import { fakeCtx, fakeHttp, type FakeRoute } from '../naver-sa/fake-http';
import { setNowForTest } from '../../lib/time';
import type { ChangeRequest } from '@/core/types';

const CREDS = { clientId: 'gfa-client-id', clientSecret: 'gfa-client-secret', refreshToken: 'gfa-refresh-token-0123', adAccountNo: '1017' };
const NOW = Date.parse('2026-11-02T05:30:00Z'); // 14:30 KST
const TODAY = '2026-11-02';
const BASE = 'https://openapi.naver.com/v1/ad-api/1.0/adAccounts/1017';
beforeAll(() => setNowForTest(NOW));
afterAll(() => setNowForTest(null));
beforeEach(() => _resetGfaTokenCacheForTest());

const q = (req: { query?: Record<string, unknown> }, k: string) => String(req.query?.[k] ?? '');
const days = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

function gfaRoutes(): FakeRoute[] {
  return [
    { method: 'POST', match: 'nid.naver.com/oauth2.0/token', reply: { data: { access_token: 'AAAAgfa-access', token_type: 'bearer', expires_in: '3600' } } },
    {
      method: 'GET', match: `${BASE}/performance/past/campaigns`,
      reply: (req) => {
        const ds = days(q(req, 'startDate'), q(req, 'endDate'));
        if (q(req, 'timeUnit') === 'hourly') return { data: { rows: ds.flatMap((d) => ['08', '21'].map((h) => ({ campaignNo: 1, targetDate: d, hour: h, impCount: 100, clickCount: 3, sales: 1500.4, convCount: 1, convSales: 50000 }))) } };
        // 캠페인 2개 × 날짜, next로 두 페이지
        const all = ds.flatMap((d) => [1, 2].map((c) => ({ campaignNo: c, targetDate: d, impCount: 5000, clickCount: 80, sales: 40000, convCount: 4, convSales: 900000 })));
        const half = Math.ceil(all.length / 2);
        return q(req, 'next') ? { data: { rows: all.slice(half) } } : { data: { rows: all.slice(0, half), next: 'tok-2' } };
      },
    },
    { method: 'GET', match: `${BASE}/performance/conversion/past/campaigns`, reply: (req) => ({ data: { rows: days(q(req, 'startDate'), q(req, 'endDate')).flatMap((d) => [{ campaignNo: 1, targetDate: d, convType: 'PURCHASE', convCount: 2, convSales: 600000 }, { campaignNo: 1, targetDate: d, convType: 'CART', convCount: 9, convSales: 0 }]) } }) },
    { method: 'GET', match: `${BASE}/performance/realtime/creatives`, reply: { data: { rows: [
      { campaignNo: 1, adSetNo: 11, creativeNo: 111, hour: '09', impCount: 300, clickCount: 9, sales: 4000, convCount: 1, convSales: 70000 },
      { campaignNo: 2, adSetNo: 21, creativeNo: 211, hour: '10', impCount: 200, clickCount: 4, sales: 2000, convCount: 0, convSales: 0 },
      { campaignNo: 2, adSetNo: 21, creativeNo: 211, hour: '16', impCount: 1, clickCount: 0, sales: 10, convCount: 0, convSales: 0 },
    ], until: 1762061400000 } } },
    { method: 'GET', match: `${BASE}/performance/conversion/realtime/creatives`, reply: { data: { rows: [{ campaignNo: 1, creativeNo: 111, convType: 'PURCHASE', convCount: 1, convSales: 65000 }, { campaignNo: 1, creativeNo: 111, convType: 'CART', convCount: 5, convSales: 0 }] } } },
    { method: 'GET', match: (req) => req.url === `${BASE}/campaigns`, reply: (req) => ({ data: q(req, 'page') === '0'
      ? { content: [{ no: 1, name: '쇼핑 고객 확장', activated: true, status: 'RUNNABLE', cboActivated: false }], last: false, totalPages: 2 }
      : { content: [{ no: 2, name: 'Prospecting', activated: true, status: 'BUDGET_EXHAUSTED', budgetExhausted: true, cboActivated: true, budget: 700000 }, { no: 3, name: '삭제', deleted: true }], last: true, totalPages: 2 } }) },
    { method: 'GET', match: (req) => req.url === `${BASE}/adSets`, reply: { data: { content: [
      { no: 11, campaignNo: 1, name: '리타겟팅', activated: true, budgetType: 'DAILY', budgetAmount: 200000 },
      { no: 12, campaignNo: 1, name: '확장', activated: true, budgetType: 'DAILY', budgetAmount: 150000 },
      { no: 13, campaignNo: 1, name: '기간', activated: true, budgetType: 'TOTAL', budgetAmount: 9000000 },
    ], last: true } } },
    { method: 'GET', match: (req) => req.url === BASE, reply: { data: { no: 1017, name: '수면밀도', disabled: false, role: 'MASTER' } } },
  ];
}

const change = (p: Partial<ChangeRequest>): ChangeRequest => ({
  id: 'c1', createdAt: '2026-11-02T05:00:00Z', module: 'gfa', kind: 'status', target: '쇼핑 고객 확장 · 리타겟팅', targetId: 'gfa:adgroup:gfa-cmp-1:11',
  before: 'on', after: 'off', reason: 't', requestedBy: 'GFA Control', approver: 'PM', status: 'approved', history: [], ...p,
});

describe('토큰 · 오류', () => {
  it('네이버 로그인 갱신 토큰 → 접근 토큰(캐시), Bearer · AccessManagerAccountNo 헤더', async () => {
    const http = fakeHttp(gfaRoutes());
    await connector.test(fakeCtx({ ...CREDS, managerAccountNo: '123' }, {}, http));
    await connector.test(fakeCtx({ ...CREDS, managerAccountNo: '123' }, {}, http));
    const tok = http.callsTo('nid.naver.com');
    expect(tok).toHaveLength(1);
    expect(tok[0].query).toEqual({ grant_type: 'refresh_token', client_id: CREDS.clientId, client_secret: CREDS.clientSecret, refresh_token: CREDS.refreshToken });
    const acc = http.calls.find((c) => c.url === BASE)!;
    expect(acc.headers).toEqual({ Authorization: 'Bearer AAAAgfa-access', AccessManagerAccountNo: '123' });
  });

  it('FAQ 인증 실패(errorCode 024 · GatewayException) · 토큰 오류 · 422 상세 코드 해석, test()는 CSV 안내 포함', async () => {
    expect(describeGfaError(401, { errorMessage: 'result is false : Authentication failed. (인증에 실패했습니다.)', errorCode: '024' })).toMatchObject({ kind: 'auth' });
    expect(describeGfaError(401, { errorMessage: 'GatewayException : Authentication failed.', errorCode: '024' })!.detail).toMatch(/서비스 동의/);
    expect(describeGfaError(200, { error: 'invalid_request', error_description: 'invalid refresh token' })).toMatchObject({ kind: 'auth' });
    expect(describeGfaError(422, { error: { code: 'CONDITION_DOES_NOT_MEET', detailCode: 'AD__BID_PRICE_OUT_OF_RANGE', message: '입찰가 설정 범위를 벗어났습니다.' } })).toMatchObject({ code: 'AD__BID_PRICE_OUT_OF_RANGE' });

    const http = fakeHttp([
      { match: 'nid.naver.com', reply: { data: { access_token: 'x', expires_in: 3600 } } },
      { match: 'openapi.naver.com', reply: { status: 401, data: { errorMessage: 'result is false : Authentication failed. (인증에 실패했습니다.)', errorCode: '024' } } },
    ]);
    const r = await connector.test(fakeCtx(CREDS, {}, http));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/인증 실패/);
    expect(r.message).toMatch(/공식 파트너사 한정.*CSV 업로드/);

    // 네이버 로그인은 HTTP 200에 오류를 담아 돌려줄 수 있다 (캐시된 토큰을 비우고)
    _resetGfaTokenCacheForTest();
    const tokErr = fakeHttp([{ match: 'nid.naver.com', reply: { status: 200, data: { error: 'invalid_request', error_description: 'invalid refresh token' } } }]);
    await expect(connector.fetch(fakeCtx(CREDS, {}, tokErr), { from: TODAY, to: TODAY })).rejects.toThrow(/인증 실패.*갱신 토큰/);
  });
});

describe('수집 (fetch)', () => {
  it('과거(next 페이지 · 구매 전환만) + 오늘 실시간(시간대 · 현재 시각 이후 제외) · 캠페인 예산 합계 · 계정', async () => {
    const http = fakeHttp(gfaRoutes());
    const b = await connector.fetch(fakeCtx(CREDS, { hourlyDays: 1 }, http), { from: '2026-10-31', to: TODAY });
    expect(b.mediaDaily).toEqual([
      { date: '2026-10-31', media: 'naver_gfa', impressions: 10000, clicks: 160, cost: 80000, conversions: 2, revenue: 600000 },
      { date: '2026-11-01', media: 'naver_gfa', impressions: 10000, clicks: 160, cost: 80000, conversions: 2, revenue: 600000 },
      { date: TODAY, media: 'naver_gfa', impressions: 501, clicks: 13, cost: 6010, conversions: 1, revenue: 65000 },
    ]);
    expect(http.callsTo('/performance/past/campaigns').filter((c) => q(c, 'timeUnit') === 'daily' && q(c, 'startDate') === '2026-10-31').map((c) => q(c, 'next'))).toEqual(['', 'tok-2']);
    expect(http.callsTo('/performance/past/campaigns')[0].query).toMatchObject({ limit: 1000 });
    expect(b.mediaHourly!.map((r) => `${r.date} ${r.hour}`)).toEqual(['2026-11-01 8', '2026-11-01 21', `${TODAY} 9`, `${TODAY} 10`]);
    expect(b.mediaHourly![0]).toMatchObject({ cost: 1500, conversions: 1 });

    expect(b.campaigns).toEqual([
      { id: 'gfa-cmp-1', media: 'naver_gfa', name: '쇼핑 고객 확장', intent: 'generic', dailyBudget: 350000, spentToday: 4000, status: 'on', hourOfData: 14 },
      { id: 'gfa-cmp-2', media: 'naver_gfa', name: 'Prospecting', intent: 'generic', dailyBudget: 700000, spentToday: 2010, status: 'limited', hourOfData: 14 },
    ]);
    expect(b.accounts![0]).toMatchObject({ id: 'gfa-1017', media: 'naver_gfa', balance: -1, avgDailySpend: 80000, status: 'active' });
    expect(b.warnings!.map((w) => w.code)).toEqual(['balance_unavailable', 'hourly_conversions_all_types']);
  });

  it('전환 유형을 비우면 일반 성과의 전체 전환 · 과거만이면 오늘 행 없음', async () => {
    const http = fakeHttp(gfaRoutes());
    const b = await connector.fetch(fakeCtx(CREDS, { conversionTypes: [], hourlyDays: 0 }, http), { from: '2026-10-31', to: '2026-10-31' });
    expect(b.mediaDaily).toEqual([{ date: '2026-10-31', media: 'naver_gfa', impressions: 10000, clicks: 160, cost: 80000, conversions: 8, revenue: 1800000 }]);
    expect(http.callsTo('/performance/conversion')).toHaveLength(0);
    expect(b.campaigns!.find((c) => c.id === 'gfa-cmp-1')!.spentToday).toBe(4000);
  });

  it('캠페인 예산: CBO면 캠페인 예산, 아니면 켜진 일 예산 광고 그룹 합계 (기간 예산 제외)', () => {
    const rows = normCampaigns([{ no: 5, name: '브랜드', activated: false }], [{ no: 1, campaignNo: 5, budgetType: 'DAILY', budgetAmount: 1000, activated: false }], new Map(), 9, []);
    expect(rows[0]).toMatchObject({ dailyBudget: 0, status: 'off', intent: 'brand' });
  });
});

describe('반영 (apply)', () => {
  it('대상 id: GFA Control 형식(gfa:adgroup:<캠페인>:<번호>) · gfa-cmp · 숫자가 아닌 시연 id는 거절', () => {
    expect(gfaTarget('gfa:adgroup:gfa-cmp-1:11')).toEqual({ type: 'adset', no: '11' });
    expect(gfaTarget('gfa-cmp-9')).toEqual({ type: 'campaign', no: '9' });
    expect(gfaTarget('gfa:adgroup:c1:g1')).toBeNull();
  });

  it('dry_run 광고 그룹 OFF: 네트워크 없이 POST adSets/activate?adSetNos&activated=false → 확인 읽기', async () => {
    const http = fakeHttp([]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http, { dryRun: true }), change({}));
    expect(http.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, appliedValue: 'off' });
    const steps = (r.request as { steps: { method: string; url: string; query?: unknown }[] }).steps;
    expect(steps[0]).toMatchObject({ method: 'POST', url: `${BASE}/adSets/activate`, query: { adSetNos: '11', activated: false } });
    expect(steps[1]).toMatchObject({ method: 'GET', url: `${BASE}/adSets/11` });
    expect(JSON.stringify(r.request)).not.toContain(CREDS.clientSecret);
  });

  it('live 캠페인 ON · 광고 그룹 OFF 확인 읽기 · 실패 응답 · 예산은 미지원(근거 표시)', async () => {
    const http = fakeHttp([
      { match: 'nid.naver.com', reply: { data: { access_token: 'tok', expires_in: 3600 } } },
      { method: 'POST', match: `${BASE}/campaigns/activate`, reply: { data: true } },
      { method: 'POST', match: `${BASE}/adSets/activate`, reply: { data: { success: true, message: '변경 완료했습니다.' } } },
      { method: 'GET', match: `${BASE}/adSets/11`, reply: { data: { no: 11, activated: false } } },
    ]);
    const c = await connector.apply!(fakeCtx(CREDS, {}, http), change({ targetId: 'gfa-cmp-1', after: 'on' }));
    expect(c).toMatchObject({ ok: true, appliedValue: 'on' });
    expect(http.callsTo('campaigns/activate')[0].query).toEqual({ campaignNos: '1', activated: true });
    const a = await connector.apply!(fakeCtx(CREDS, {}, http), change({}));
    expect(a).toMatchObject({ ok: true, appliedValue: 'off' });

    const fail = fakeHttp([
      { match: 'nid.naver.com', reply: { data: { access_token: 'tok', expires_in: 3600 } } },
      { method: 'POST', match: 'activate', reply: { status: 400, data: { error: { code: 'BAD_REQUEST', message: 'Bad Request', description: '광고계정(1017) 하위에 속하지 않은 광고 그룹([11])이 존재합니다.' } } } },
    ]);
    const x = await connector.apply!(fakeCtx(CREDS, {}, fail), change({}));
    expect(x.ok).toBe(false);
    expect(x.error).toMatch(/하위에 속하지 않은 광고 그룹/);

    const budget = await connector.apply!(fakeCtx(CREDS, {}, fakeHttp([])), change({ kind: 'budget', targetId: 'gfa:budget:gfa-cmp-1', before: 300000, after: 330000 }));
    expect(budget.ok).toBe(false);
    expect(budget.error).toMatch(/editType/);
    expect(connector.capabilities.writes).toEqual(['status']);
  });
});

describe('정의', () => {
  it('공식 문서 URL · 베타/파트너 안내 · verifiedLive=false', () => {
    expect(connector.docsUrl).toBe('https://naver-ad-api.github.io/developers/');
    expect(connector.verifiedLive).toBe(false);
    expect(connector.credentialFields.find((f) => f.key === 'clientId')!.help).toMatch(/공식 파트너사 한정/);
    expect(connector.credentialsSchema.parse({ ...CREDS, managerAccountNo: '' }).managerAccountNo).toBeUndefined();
    expect(connector.settingsSchema.parse({})).toMatchObject({ conversionTypes: ['PURCHASE'], hourlyDays: 7 });
  });
});
