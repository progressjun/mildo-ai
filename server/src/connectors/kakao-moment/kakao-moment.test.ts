/** 카카오모먼트 커넥터 — 보고서 정규화(일자 형식 · 시간대 · 구매 전환 창) · 호출 간격 · 예산 단위 · 오류 · 반영. 실제 네트워크 없음. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connector, KAKAO_BUDGET } from './index';
import { _resetKakaoThrottleForTest, describeKakaoError } from './client';
import { funnelOfReport, hourOfReport, kakaoTarget } from './normalize';
import { fakeCtx, fakeHttp, type FakeRoute } from '../naver-sa/fake-http';
import { setPauseForTest } from '../naver-sa/media-shared';
import { setNowForTest } from '../../lib/time';
import type { ChangeRequest } from '@/core/types';

const CREDS = { accessToken: 'kakao-business-token-0123', adAccountId: '1111' };
const NOW = Date.parse('2026-11-02T05:30:00Z'); // 14:30 KST
const TODAY = '2026-11-02';
const BASE = 'https://apis.moment.kakao.com/openapi/v4';
let waits: number[] = [];

beforeAll(() => setNowForTest(NOW));
afterAll(() => setNowForTest(null));
beforeEach(() => {
  waits = [];
  _resetKakaoThrottleForTest();
  setPauseForTest(async (ms) => { waits.push(ms); });
});
afterEach(() => setPauseForTest(null));

const q = (req: { query?: Record<string, unknown> }, k: string) => String(req.query?.[k] ?? '');
const metrics = (cost: number) => ({ imp: 1000, click: 30, ctr: 0.03, cost, conv_purchase_1d: 1, conv_purchase_7d: 3, conv_purchase_p_1d: 100000, conv_purchase_p_7d: 270000 });

function kakaoRoutes(): FakeRoute[] {
  return [
    {
      method: 'GET', match: `${BASE}/adAccounts/report`,
      reply: (req) => {
        if (q(req, 'dimension') === 'HOUR') {
          const date = q(req, 'datePreset') === 'TODAY' ? TODAY : `${q(req, 'start').slice(0, 4)}-${q(req, 'start').slice(4, 6)}-${q(req, 'start').slice(6, 8)}`;
          return { data: { code: 200, message: 'Success', data: [
            { start: date, end: date, dimensions: { hour: 'total', ad_account_id: '1111' }, metrics: metrics(9999) },
            { start: date, end: date, dimensions: { hour: '09', ad_account_id: '1111' }, metrics: metrics(10000) },
            { start: date, end: date, dimensions: { hour: '18', ad_account_id: '1111' }, metrics: metrics(20000) },
          ] } };
        }
        if (q(req, 'datePreset') === 'LAST_7DAY') return { data: { code: 200, message: 'Success', data: [{ start: '2026-10-26', end: '2026-11-01', dimensions: { ad_account_id: '1111' }, metrics: { imp: 1, click: 1, ctr: 1, cost: 700000 } }] } };
        // 일별: 문서 표기(yyyyMMdd)와 예시(yyyy-MM-dd)를 섞어 응답
        const s = q(req, 'start'), e = q(req, 'end');
        const out = [];
        for (let d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`; d.replace(/-/g, '') <= e; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
          out.push({ start: out.length % 2 ? d.replace(/-/g, '') : d, end: d, dimensions: { ad_account_id: '1111' }, metrics: metrics(50000) });
        }
        out.push({ start: s, end: s, dimensions: {}, metrics: {} }); // 데이터 없는 행
        return { data: { code: 200, message: 'Success', data: out } };
      },
    },
    { method: 'GET', match: `${BASE}/campaigns/report`, reply: (req) => ({ data: { code: 200, data: q(req, 'campaignId').split(',').map((id) => ({ start: TODAY, end: TODAY, dimensions: { campaign_id: id }, metrics: { imp: 1, click: 1, ctr: 1, cost: Number(id) * 10 } })) } }) },
    { method: 'GET', match: `${BASE}/adGroups/report`, reply: (req) => ({ data: { code: 200, data: q(req, 'adGroupId').split(',').map((id) => ({ start: TODAY, end: TODAY, dimensions: { ad_group_id: id }, metrics: { imp: 1, click: 1, ctr: 1, cost: 777 } })) } }) },
    { method: 'GET', match: (req) => req.url === `${BASE}/campaigns`, reply: { data: { content: [
      { id: 1001, name: '방문 리마케팅', config: 'ON', systemConfig: 'ON' },
      { id: 1002, name: '장바구니 전환', config: 'ON', systemConfig: 'ON' },
      { id: 1003, name: '삭제', config: 'DEL', systemConfig: 'ON' },
    ] } } },
    { method: 'GET', match: `${BASE}/campaigns/1001`, reply: { data: { id: 1001, name: '방문 리마케팅', config: 'ON', systemConfig: 'ON', dailyBudgetAmount: 300000, isDailyBudgetAmountOver: true, statusDescription: '일예산초과' } } },
    { method: 'GET', match: `${BASE}/campaigns/1002`, reply: { data: { id: 1002, name: '장바구니 전환', config: 'ON', systemConfig: 'ON', dailyBudgetAmount: null } } },
    { method: 'GET', match: (req) => req.url === `${BASE}/adGroups`, reply: { data: { content: [{ id: 2001, name: '장바구니 7일', config: 'ON' }, { id: 2002, name: '상세 조회', config: 'OFF' }] } } },
    { method: 'GET', match: `${BASE}/adGroups/2001`, reply: { data: { id: 2001, name: '장바구니 7일', config: 'ON', systemConfig: 'ON', dailyBudgetAmount: 100000 } } },
    { method: 'GET', match: `${BASE}/adGroups/2002`, reply: { data: { id: 2002, name: '상세 조회', config: 'OFF', systemConfig: 'ON', dailyBudgetAmount: 50000 } } },
    { method: 'GET', match: `${BASE}/adAccounts/balance`, reply: { data: { id: 1111, bizWalletId: 1, cash: 5000000, freeCash: 100000 } } },
    { method: 'GET', match: `${BASE}/adAccounts/1111`, reply: { data: { id: 1111, name: '수면밀도', type: 'BUSINESS', config: 'ON', isAdminStop: false, isOutOfBalance: false, statusDescription: '운영중' } } },
  ];
}

const change = (p: Partial<ChangeRequest>): ChangeRequest => ({
  id: 'c1', createdAt: '2026-11-02T05:00:00Z', module: 'adpilot', kind: 'budget', target: '방문 리마케팅 일 예산', targetId: 'budget:kakao-cmp-1001:',
  before: 300000, after: 345000, reason: 't', requestedBy: 'AD Pilot', approver: 'PM', status: 'approved', history: [], ...p,
});

describe('정규화', () => {
  it('지표 키 · 전환 창(7d 기본, 1d 선택) · 시간대 값', () => {
    expect(funnelOfReport({ metrics: metrics(12345.4) }, '7d')).toEqual({ impressions: 1000, clicks: 30, cost: 12345, conversions: 3, revenue: 270000 });
    expect(funnelOfReport({ metrics: metrics(1) }, '1d')).toMatchObject({ conversions: 1, revenue: 100000 });
    expect(hourOfReport({ dimensions: { hour: '09' } })).toBe(9);
    expect(hourOfReport({ dimensions: { ad_account_id: '1111', time: '23' } })).toBe(23);
    expect(hourOfReport({ dimensions: { hour: 'total' } })).toBe('total');
    expect(hourOfReport({ dimensions: { ad_account_id: '12' } })).toBeNull();
    expect(kakaoTarget('budget:kakao-grp-2001:')).toEqual({ type: 'adgroup', id: '2001' });
  });

  it('오류: -401 토큰 · -10 횟수 초과 · -813 상세 메시지(한국어)', () => {
    expect(describeKakaoError(401, { code: -401, msg: 'this access token does not exist' })).toMatchObject({ kind: 'auth' });
    expect(describeKakaoError(400, { code: -10, msg: 'exceed limit' })).toMatchObject({ kind: 'rate' });
    expect(describeKakaoError(400, { code: -813, msg: 'KakaoMomentException', extras: { detailCode: 31011, detailMsg: '캠페인 일예산은 최소 50,000보다 크거나 같아야 합니다.' } })!.detail).toBe('캠페인 일예산은 최소 50,000보다 크거나 같아야 합니다. (31011)');
    expect(describeKakaoError(200, { code: 200, message: 'Success', data: [] })).toBeNull();
  });
});

describe('수집 (fetch)', () => {
  it('일별(31일 구간 · 두 가지 일자 형식) · 오늘 시간대 합계 · 예산 단위 · 계정 · 보고서 5초 간격', async () => {
    const http = fakeHttp(kakaoRoutes());
    const b = await connector.fetch(fakeCtx(CREDS, { hourlyDays: 1 }, http), { from: '2026-09-25', to: '2026-11-02' });
    expect(b.mediaDaily).toHaveLength(39);
    expect(b.mediaDaily![0]).toEqual({ date: '2026-09-25', media: 'kakao', impressions: 1000, clicks: 30, cost: 50000, conversions: 3, revenue: 270000 });
    // 오늘 = 시간대 합계 (total 행 · 14시 이후 제외 → 09시만)
    expect(b.mediaDaily!.at(-1)).toEqual({ date: TODAY, media: 'kakao', impressions: 1000, clicks: 30, cost: 10000, conversions: 3, revenue: 270000 });
    const dayCalls = http.callsTo('/adAccounts/report').filter((c) => q(c, 'timeUnit') === 'DAY');
    expect(dayCalls.map((c) => [q(c, 'start'), q(c, 'end')])).toEqual([['20260925', '20261025'], ['20261026', '20261101']]);
    expect(dayCalls[0].query).toMatchObject({ adAccountId: '1111', level: 'AD_ACCOUNT', metricsGroup: 'BASIC,PIXEL_SDK_CONVERSION' });
    expect(dayCalls[0].headers).toMatchObject({ Authorization: `Bearer ${CREDS.accessToken}`, adAccountId: '1111' });

    expect(b.mediaHourly!.map((r) => `${r.date} ${r.hour}`)).toEqual(['2026-11-01 9', '2026-11-01 18', '2026-11-02 9']);

    expect(b.campaigns).toEqual([
      { id: 'kakao-cmp-1001', media: 'kakao', name: '방문 리마케팅', intent: 'generic', dailyBudget: 300000, spentToday: 10010, status: 'limited', hourOfData: 14 },
      { id: 'kakao-grp-2001', media: 'kakao', name: '장바구니 전환 · 장바구니 7일', intent: 'generic', dailyBudget: 100000, spentToday: 777, status: 'on', hourOfData: 14 },
      { id: 'kakao-grp-2002', media: 'kakao', name: '장바구니 전환 · 상세 조회', intent: 'generic', dailyBudget: 50000, spentToday: 777, status: 'off', hourOfData: 14 },
    ]);
    expect(b.accounts![0]).toMatchObject({ id: 'kakao-1111', media: 'kakao', balance: 5_100_000, avgDailySpend: 100000, autoCharge: 'off', status: 'active' });

    // 보고서(광고계정 · 캠페인) 호출 사이 5초, 광고그룹 보고서는 별도 버킷
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms > 4000 && ms <= 5000)).toBe(true);
    expect(http.calls.some((c) => c.url.includes('/campaigns/1003'))).toBe(false);
  });

  it('intraday: 오늘 시간대 보고서 1회로 일별 · 시간대, 과거 일자 호출 없음', async () => {
    const http = fakeHttp(kakaoRoutes());
    const b = await connector.fetch(fakeCtx(CREDS, {}, http), { from: TODAY, to: TODAY }, { intradayDate: TODAY });
    expect(http.callsTo('/adAccounts/report').filter((c) => q(c, 'timeUnit') === 'DAY' || q(c, 'start'))).toHaveLength(0);
    expect(b.mediaDaily).toHaveLength(1);
    expect(b.mediaHourly!.map((r) => r.hour)).toEqual([9]);
  });

  it('토큰 오류(-401) → 한국어 인증 실패, test()는 ok:false', async () => {
    const http = fakeHttp([{ match: 'apis.moment.kakao.com', reply: { status: 401, data: { code: -401, msg: 'this access token does not exist' } } }]);
    const r = await connector.test(fakeCtx(CREDS, {}, http));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/카카오모먼트 인증 실패.*비즈니스 토큰/);
  });
});

describe('반영 (apply)', () => {
  it('dry_run 예산: 네트워크 없이 현재 값 확인 → PUT /campaigns/dailyBudgetAmount → 확인 읽기', async () => {
    const http = fakeHttp([]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http, { dryRun: true }), change({}));
    expect(http.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, appliedValue: 345000 });
    const steps = (r.request as { steps: { method: string; url: string; body?: unknown }[] }).steps;
    expect(steps.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${BASE}/campaigns/1001`, `PUT ${BASE}/campaigns/dailyBudgetAmount`, `GET ${BASE}/campaigns/1001`]);
    expect(steps[1].body).toEqual({ id: 1001, dailyBudgetAmount: 345000 });
    expect(JSON.stringify(r.request)).not.toContain(CREDS.accessToken);
  });

  it('예산 범위 · 10원 단위 검사 (호출 전 거절)', async () => {
    const http = fakeHttp([]);
    for (const [targetId, after] of [['kakao-cmp-1001', 40000], ['kakao-cmp-1001', 345005], ['kakao-grp-2001', 600_000_000]] as const) {
      const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({ targetId, after }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/10원 단위/);
    }
    expect(http.calls).toHaveLength(0);
    expect(KAKAO_BUDGET.campaign.min).toBe(50_000);
  });

  it('live 광고그룹 예산: 현재 값 확인 → PUT → 확인 읽기 값 · 값 불일치는 멈춤', async () => {
    let budget = 100000;
    const http = fakeHttp([
      { method: 'GET', match: `${BASE}/adGroups/2001`, reply: () => ({ data: { id: 2001, config: 'ON', dailyBudgetAmount: budget } }) },
      { method: 'PUT', match: `${BASE}/adGroups/dailyBudgetAmount`, reply: (req) => { budget = (req.body as { dailyBudgetAmount: number }).dailyBudgetAmount; return { status: 200, data: '' }; } },
    ]);
    const r = await connector.apply!(fakeCtx(CREDS, {}, http), change({ targetId: 'kakao-grp-2001', before: 100000, after: 120000 }));
    expect(r).toMatchObject({ ok: true, appliedValue: 120000 });
    expect(http.calls.find((c) => c.method === 'PUT')!.body).toEqual({ id: 2001, dailyBudgetAmount: 120000 });

    const drift = fakeHttp([{ method: 'GET', match: `${BASE}/adGroups/2001`, reply: { data: { id: 2001, dailyBudgetAmount: 90000 } } }]);
    const x = await connector.apply!(fakeCtx(CREDS, {}, drift), change({ targetId: 'kakao-grp-2001', before: 100000, after: 120000 }));
    expect(x.ok).toBe(false);
    expect(x.error).toMatch(/다릅니다/);
  });

  it('live ON/OFF · 연속 캠페인 쓰기는 5초 간격 · 실패 응답(-813) 한국어', async () => {
    const http = fakeHttp([
      { method: 'PUT', match: `${BASE}/campaigns/onOff`, reply: { status: 200, data: '' } },
      { method: 'GET', match: `${BASE}/campaigns/1001`, reply: { data: { id: 1001, config: 'OFF' } } },
    ]);
    const ctx = fakeCtx(CREDS, {}, http);
    const r1 = await connector.apply!(ctx, change({ kind: 'status', targetId: 'kakao-cmp-1001', before: 'on', after: 'off' }));
    const r2 = await connector.apply!(ctx, change({ kind: 'status', targetId: 'kakao-cmp-1001', before: 'on', after: 'off' }));
    expect(r1).toMatchObject({ ok: true, appliedValue: 'off' });
    expect(r2.ok).toBe(true);
    expect(http.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ id: 1001, config: 'OFF' }, { id: 1001, config: 'OFF' }]);
    expect(waits.some((ms) => ms > 4000)).toBe(true);

    const fail = fakeHttp([{ method: 'PUT', match: `${BASE}/campaigns/onOff`, reply: { status: 400, data: { code: -813, msg: 'KakaoMomentException', extras: { detailCode: 31001, detailMsg: '캠페인이 존재하지 않습니다.' } } } }]);
    const x = await connector.apply!(fakeCtx(CREDS, {}, fail), change({ kind: 'status', targetId: 'kakao-cmp-9', after: 'on' }));
    expect(x.ok).toBe(false);
    expect(x.error).toMatch(/캠페인이 존재하지 않습니다/);
    expect((await connector.apply!(fakeCtx(CREDS, {}, fail), change({ kind: 'bid' }))).ok).toBe(false);
  });
});

describe('정의', () => {
  it('필드 안내 · 능력 · verifiedLive=false', () => {
    expect(connector.verifiedLive).toBe(false);
    expect(connector.capabilities).toMatchObject({ reads: ['mediaDaily', 'mediaHourly', 'campaigns', 'accounts'], writes: ['budget', 'status'], intraday: true });
    expect(connector.credentialFields.map((f) => f.key)).toEqual(['accessToken', 'adAccountId']);
    expect(connector.credentialsSchema.parse({ accessToken: CREDS.accessToken, adAccountId: 1111 }).adAccountId).toBe('1111');
  });
});
