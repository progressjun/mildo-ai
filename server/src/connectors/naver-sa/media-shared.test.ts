/** 매체 커넥터 공용 도우미 — 단위 · 날짜 · 의도 분류 · 오류 정규화 · 반영 실행(dry_run / live / 멈춤) · 값 불일치 검사 */
import { describe, expect, it } from 'vitest';
import {
  ApplyAbort, DailyAcc, HourlyAcc, MediaApiError, assertNoDrift, callApi, softPart, clampRange, compactDate, dec2, executePlan, inferIntent, isBrandKeyword,
  isoDate, krw, maxBidOf, num, parseHour, parseKrwAmount, parseOnOff, requestSummary, scrub, splitRange, step, tailRange,
} from './media-shared';
import { fakeCtx, fakeHttp } from './fake-http';

describe('단위 · 날짜', () => {
  it('숫자 · 원 정수 · 전환 소수 둘째 자리 · 일자 · 시', () => {
    expect([num('1,234.5'), num(''), num(null), num(NaN), num('x')]).toEqual([1234.5, 0, 0, 0, 0]);
    expect([krw('99.5'), krw('12.4'), dec2(2.456)]).toEqual([100, 12, 2.46]);
    expect([isoDate('20261102'), isoDate('2026-11-02T00:00:00Z'), isoDate('11/02'), compactDate('2026-11-02')]).toEqual(['2026-11-02', '2026-11-02', null, '20261102']);
    expect([parseHour('09'), parseHour('13:00:00 - 13:59:59'), parseHour('23시~24시'), parseHour(24), parseHour('total')]).toEqual([9, 13, 23, null, null]);
  });

  it('기간: 오늘(KST) 이하로 자르기 · N일 구간 · 최근 구간', () => {
    expect(clampRange({ from: '2026-11-01', to: '2026-11-30' }, '2026-11-02')).toEqual({ from: '2026-11-01', to: '2026-11-02' });
    expect(clampRange({ from: '2026-11-05', to: '2026-11-30' }, '2026-11-02')).toBeNull();
    expect(splitRange('2026-01-01', '2026-03-05', 31)).toEqual([{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: '2026-03-03' }, { from: '2026-03-04', to: '2026-03-05' }]);
    expect(tailRange({ from: '2026-10-01', to: '2026-10-31' }, '2026-10-25')).toEqual({ from: '2026-10-25', to: '2026-10-31' });
    expect(tailRange({ from: '2026-10-01', to: '2026-10-31' }, '2026-11-01')).toBeNull();
  });

  it('일별 · 시간대 합산은 날짜 · 시 순서, 원 정수', () => {
    const d = new DailyAcc();
    d.add('2026-11-02', { cost: 10.4, conversions: 0.333 });
    d.add('2026-11-01', { impressions: 5 });
    d.add('2026-11-02', { cost: 0.4, conversions: 0.333 });
    expect(d.rows('meta')).toEqual([
      { date: '2026-11-01', media: 'meta', impressions: 5, clicks: 0, cost: 0, conversions: 0, revenue: 0 },
      { date: '2026-11-02', media: 'meta', impressions: 0, clicks: 0, cost: 11, conversions: 0.67, revenue: 0 },
    ]);
    const h = new HourlyAcc();
    h.add('2026-11-02', 10, { clicks: 1 });
    h.add('2026-11-02', 9, { clicks: 2 });
    expect(h.rows('kakao').map((r) => r.hour)).toEqual([9, 10]);
  });
});

describe('키워드 판정', () => {
  it('의도: 설정 규칙 우선 → 이름 휴리스틱 → generic · 브랜드 키워드 · 최대 입찰가', () => {
    expect(inferIntent(['브랜드 방어'])).toBe('brand');
    expect(inferIntent(['매트리스 추천 비교'])).toBe('compare');
    expect(inferIntent(['허리 편안한'])).toBe('problem');
    expect(inferIntent(['신혼 혼수'])).toBe('life');
    expect(inferIntent(['일반 제품'])).toBe('generic');
    expect(inferIntent(['S2_핵심'], [{ match: 's2_', intent: 'brand' }])).toBe('brand');
    expect(isBrandKeyword('수면 밀도 매트리스', 'generic', ['수면밀도'])).toBe(true);
    expect(isBrandKeyword('퀸 매트리스', 'generic', ['수면밀도'])).toBe(false);
    expect(maxBidOf(1234, {}, 100_000)).toEqual({ value: 2470, derived: true });
    expect(maxBidOf(90_000, {}, 100_000)).toEqual({ value: 100_000, derived: true });
    expect(maxBidOf(500, { maxBid: 3000 }, 100_000)).toEqual({ value: 3000, derived: false });
  });

  it('반영 값 해석: on/off · 원 금액', () => {
    expect(['on', 'OFF', '일시 중지', true, 'enabled', 'paused', '?'].map(parseOnOff)).toEqual(['on', 'off', 'off', 'on', 'on', 'off', null]);
    expect([parseKrwAmount('50,000원'), parseKrwAmount(1200.6), parseKrwAmount(0), parseKrwAmount('abc')]).toEqual([50000, 1201, null, null]);
  });
});

describe('오류 정규화 (callApi)', () => {
  const o = { provider: 'p', label: '테스트 매체', what: '목록 조회' };
  it('4xx 응답 · 쓰기 래퍼 예외(status · data) · 네트워크 오류를 같은 한국어 메시지로', async () => {
    const r401 = fakeHttp([{ match: '/x', reply: { status: 401, data: 'expired' } }]);
    await expect(callApi({ http: r401 }, { method: 'GET', url: 'https://a.example/x' }, o)).rejects.toMatchObject({ kind: 'auth', status: 401, message: expect.stringMatching(/^테스트 매체 인증 실패 .*expired/) });
    const thrown = fakeHttp([{ match: '/x', reply: { status: 429, data: { m: 1 } } }], { mode: 'throw' });
    await expect(callApi({ http: thrown }, { method: 'GET', url: 'https://a.example/x' }, o)).rejects.toMatchObject({ kind: 'rate', message: expect.stringMatching(/호출 한도 초과/) });
    const net = { request: async () => { throw Object.assign(new Error('connect ECONNREFUSED bearer abcdefghijkl'), { code: 'network' }); } };
    const e = await callApi({ http: net }, { method: 'GET', url: 'https://a.example/x' }, o).catch((x) => x);
    expect(e).toBeInstanceOf(MediaApiError);
    expect(e.kind).toBe('network');
    expect(e.message).toMatch(/응답 없음/);
    expect(e.message).not.toContain('abcdefghijkl');
    const body200 = fakeHttp([{ match: '/x', reply: { status: 200, data: { code: -1 } } }]);
    await expect(callApi({ http: body200 }, { method: 'GET', url: 'https://a.example/x' }, { ...o, describe: () => ({ kind: 'server', detail: '본문 오류' }) })).rejects.toMatchObject({ kind: 'server' });
    const ok = fakeHttp([{ match: '/x', reply: { data: [1] } }]);
    expect((await callApi({ http: ok }, { method: 'GET', url: 'https://a.example/x' }, o)).data).toEqual([1]);
  });

  it('비밀값 가림: 오류 문자열의 토큰 · 요청 요약의 토큰 쿼리 · 헤더 값', () => {
    expect(scrub('Authorization: Bearer ya29.abcdefghijklmnop access_token=EAAxyz123&x=1')).toBe('Authorization: Bearer •••• access_token=••••&x=1');
    const s = requestSummary({ method: 'GET', url: 'https://a.example/x', query: { access_token: 'secret', appsecret_proof: 'p', fields: 'id' }, headers: { Authorization: 'Bearer t' } });
    expect(s).toEqual({ method: 'GET', url: 'https://a.example/x', query: { fields: 'id' }, headers: ['Authorization'] });
    // 비밀값 이름만 뺀다 — key가 들어간 일반 파라미터(nccKeywordId · hintKeywords)는 dry_run 요약에 남아야 한다
    const t = requestSummary({ method: 'GET', url: 'https://a.example/x', query: { client_secret: 's', refresh_token: 'r', api_key: 'k', key: 'k2', signature: 'g', nccKeywordId: 'nkw-1', hintKeywords: 'a,b', campaignSpendLimit: 1 } });
    expect(t.query).toEqual({ nccKeywordId: 'nkw-1', hintKeywords: 'a,b', campaignSpendLimit: 1 });
  });
});

describe('반영 실행 (executePlan) · 값 불일치', () => {
  const steps = [step({ method: 'PUT', url: 'https://a.example/k', body: { bid: 1 } }, '변경')];
  it('dry_run은 live를 부르지 않고 단계를 돌려준다, live 성공 · 멈춤 · 매체 오류', async () => {
    let called = 0;
    const live = async () => { called++; return { response: { ok: 1 }, appliedValue: 7 }; };
    const dry = await executePlan(fakeCtx({}, {}, fakeHttp([]), { dryRun: true }), { label: 'L', what: 'W', intended: 5, steps, live });
    expect(dry).toEqual({ ok: true, request: { dryRun: true, what: 'W', steps }, appliedValue: 5 });
    expect(called).toBe(0);
    const ok = await executePlan(fakeCtx({}, {}, fakeHttp([])), { label: 'L', what: 'W', intended: 5, steps, live });
    expect(ok).toEqual({ ok: true, request: { what: 'W', steps }, response: { ok: 1 }, appliedValue: 7 });
    const abort = await executePlan(fakeCtx({}, {}, fakeHttp([])), { label: 'L', what: 'W', intended: 5, steps, live: async () => { throw new ApplyAbort('멈춤 사유'); } });
    expect(abort).toMatchObject({ ok: false, error: '멈춤 사유' });
    const media = await executePlan(fakeCtx({}, {}, fakeHttp([])), { label: 'L', what: 'W', intended: 5, steps, live: async () => { throw new MediaApiError('p', 'invalid', '요청 오류', 400, 'x', { raw: 1 }); } });
    expect(media).toMatchObject({ ok: false, error: '요청 오류', response: { raw: 1 } });
  });

  it('요청 시점 값과 현재 값이 다르면 멈춤 — 이미 목표 값 · 숫자 아님 · allowDrift는 통과', () => {
    expect(() => assertNoDrift('입찰가', 900, 900, 1000)).not.toThrow();
    expect(() => assertNoDrift('입찰가', 900, 1000, 1000)).not.toThrow();
    expect(() => assertNoDrift('입찰가', 'on', 1, 2)).not.toThrow();
    expect(() => assertNoDrift('입찰가', 900, null, 1000)).not.toThrow();
    expect(() => assertNoDrift('입찰가', 900, 1500, 1000, true)).not.toThrow();
    expect(() => assertNoDrift('입찰가', '900', 1500, 1000)).toThrow(/현재 값\(1,500원\)이 요청 시점 값\(900원\)과 다릅니다/);
  });
});

describe('부가 단계 (softPart)', () => {
  it('일반 오류는 경고 + undefined, 인증 · 호출 한도 오류는 그대로 던진다', async () => {
    const batch: { warnings?: { code: string; message: string }[] } = {};
    expect(await softPart(batch, 'x_failed', '시간대', async () => { throw new MediaApiError('p', 'server', '서버 오류 (HTTP 500)'); })).toBeUndefined();
    expect(batch.warnings).toEqual([{ code: 'x_failed', message: '시간대 수집 실패 — 나머지 데이터는 저장했습니다: 서버 오류 (HTTP 500)' }]);
    expect(await softPart(batch, 'y', '키워드', async () => 42)).toBe(42);
    await expect(softPart(batch, 'z', '계정', async () => { throw new MediaApiError('p', 'auth', '인증 실패'); })).rejects.toThrow('인증 실패');
    await expect(softPart(batch, 'z', '계정', async () => { throw new MediaApiError('p', 'rate', '호출 한도 초과'); })).rejects.toThrow('호출 한도 초과');
  });
});
