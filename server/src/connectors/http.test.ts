/** 커넥터 HTTP 래퍼: 타임아웃 · 재시도(429 · 5xx · 네트워크, Retry-After) · 쿼리 · 본문 · 헤더 소문자 · 로그 마스킹 · 테스트 중 실네트워크 차단 */
import { describe, expect, it } from 'vitest';
import { buildUrl, ConnectorHttpError, createConnectorHttp, expectOk, isPrivateIp, maskHeaders, maskUrl, parseRetryAfter, scrubSecrets, urlProblem, type FetchLike } from './http';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string }

function fakeFetch(responses: (Partial<{ status: number; body: string; headers: Record<string, string>; throws: string; hang: boolean }>)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.hang) {
      return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (r.throws) throw new Error(r.throws);
    const h = new Headers(r.headers ?? { 'Content-Type': 'application/json' });
    return { status: r.status ?? 200, headers: h, text: async () => r.body ?? '' };
  };
  return { fetch, calls };
}

const noSleep = { sleeps: [] as number[] };
function http(f: FetchLike, extra: Partial<Parameters<typeof createConnectorHttp>[0]> = {}) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const h = createConnectorHttp({ fetchImpl: f, log: (m) => logs.push(m), maxRetries: 3, timeoutMs: 1000, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...extra });
  return { h, logs, sleeps };
}
void noSleep;

describe('요청 조립', () => {
  it('쿼리(undefined 제외) · JSON 본문 · 응답 헤더 소문자 · JSON 파싱', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: '{"ok":true,"n":3}', headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Rate-Remaining': '9' } }]);
    const { h } = http(fetch);
    const r = await h.request<{ ok: boolean; n: number }>({ method: 'POST', url: 'https://api.example.com/v1/stats?fixed=1', query: { a: 1, b: 'x y', c: undefined, d: false }, body: { hello: '세계' } });
    expect(calls[0].url).toBe('https://api.example.com/v1/stats?fixed=1&a=1&b=x+y&d=false');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].body).toBe('{"hello":"세계"}');
    expect(r).toEqual({ status: 200, data: { ok: true, n: 3 }, headers: { 'content-type': 'application/json; charset=utf-8', 'x-rate-remaining': '9' } });
  });

  it('form · text 본문, GET은 본문을 보내지 않는다, 텍스트 응답은 문자열', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: 'access_token=abc', headers: { 'content-type': 'text/plain' } }]);
    const { h } = http(fetch);
    const r = await h.request({ method: 'POST', url: 'https://auth.example.com/token', bodyType: 'form', body: { grant_type: 'refresh_token', scope: ['a', 'b'], skip: undefined } });
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].body).toBe('grant_type=refresh_token&scope=a&scope=b');
    expect(r.data).toBe('access_token=abc');
    await h.request({ method: 'PUT', url: 'https://x.example.com/t', bodyType: 'text', body: 'raw' });
    expect(calls[1].headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(calls[1].body).toBe('raw');
    await h.request({ method: 'GET', url: 'https://x.example.com/g', body: { ignored: true } });
    expect(calls[2].body).toBeUndefined();
  });

  it('잘못된 JSON 응답은 텍스트로 돌려준다', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: '{not json', headers: { 'content-type': 'application/json' } }]);
    const { h } = http(fetch);
    expect((await h.request({ method: 'GET', url: 'https://x.example.com' })).data).toBe('{not json');
  });
});

describe('재시도 · 타임아웃', () => {
  it('429는 Retry-After(초)를 지켜 재시도하고 성공 응답을 돌려준다', async () => {
    const { fetch, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: '[]' }]);
    const { h, sleeps, logs } = http(fetch);
    const r = await h.request({ method: 'GET', url: 'https://x.example.com/r' });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(logs[0]).toMatch(/→ 429 .*2000ms 뒤 재시도/);
  });

  it('5xx는 지수 백오프로 재시도, 횟수를 넘기면 마지막 응답(5xx)을 돌려준다', async () => {
    const { fetch, calls } = fakeFetch([{ status: 503 }, { status: 502 }, { status: 500 }, { status: 500, body: 'down' }]);
    const { h, sleeps } = http(fetch);
    const r = await h.request({ method: 'GET', url: 'https://x.example.com/r' });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(r.status).toBe(500);
    expect(() => expectOk(r, '통계 조회')).toThrow(/통계 조회 실패 \(HTTP 500\): down/);
  });

  it('4xx는 재시도하지 않는다', async () => {
    const { fetch, calls } = fakeFetch([{ status: 401, body: '{"error":"invalid key"}' }]);
    const { h } = http(fetch);
    const r = await h.request({ method: 'GET', url: 'https://x.example.com/r' });
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('네트워크 오류는 재시도 후 ConnectorHttpError(network)', async () => {
    const { fetch, calls } = fakeFetch([{ throws: 'ECONNRESET' }]);
    const { h } = http(fetch, { maxRetries: 2 });
    await expect(h.request({ method: 'GET', url: 'https://x.example.com/r' })).rejects.toMatchObject({ name: 'ConnectorHttpError', code: 'network' });
    expect(calls).toHaveLength(3);
  });

  it('타임아웃(AbortController) → 요청별 retries=0이면 바로 timeout 오류', async () => {
    const { fetch, calls } = fakeFetch([{ hang: true }]);
    const { h } = http(fetch);
    const err = await h.request({ method: 'GET', url: 'https://x.example.com/slow', timeoutMs: 20, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorHttpError);
    expect(err.code).toBe('timeout');
    expect(err.message).toMatch(/시간 초과 \(20ms\)/);
    expect(calls).toHaveLength(1);
  });

  it('Retry-After: 초 · HTTP 날짜 · 해석 불가', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe('비밀값 마스킹', () => {
  it('로그에 Authorization · API 키 헤더 · 토큰 쿼리 · 서명이 평문으로 남지 않는다', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: '{}' }]);
    const entries: unknown[] = [];
    const { h, logs } = http(fetch, { onRequest: (e) => entries.push(e) });
    await h.request({
      method: 'GET', url: 'https://api.example.com/v1/x',
      query: { access_token: 'tok-SECRET-123', api_key: 'KEY-SECRET', customer: '123' },
      headers: { Authorization: 'Bearer SECRET-BEARER-TOKEN', 'X-API-KEY': 'apikey-SECRET', 'X-Signature': 'sig-SECRET', 'X-Customer': '1234567' },
    });
    const all = JSON.stringify({ logs, entries });
    expect(all).not.toMatch(/SECRET/);
    expect(all).toContain('customer=123');
    expect(logs[0]).toMatch(/access_token=••••/);
  });

  it('maskUrl · maskHeaders · scrubSecrets', () => {
    expect(maskUrl('https://u:p@x.example.com/a?client_secret=s&page=2&sig=abc')).toBe('https://••••:••••@x.example.com/a?client_secret=••••&page=2&sig=••••');
    expect(maskHeaders({ 'developer-token': 'd', accept: 'application/json', 'x-api-secret': 's' })).toEqual({ 'developer-token': '••••', accept: 'application/json', 'x-api-secret': '••••' });
    expect(scrubSecrets('failed: Bearer abcdefghijkl1234 and refresh_token=zzzzzzzzzz')).toBe('failed: Bearer •••• and refresh_token=••••');
    expect(buildUrl('https://x/y', {})).toBe('https://x/y');
  });

  it('테스트 환경에서 fetch 주입 없이 호출하면 실제 네트워크 대신 오류', async () => {
    const h = createConnectorHttp({ log: () => undefined, maxRetries: 3, timeoutMs: 1000 });
    await expect(h.request({ method: 'GET', url: 'https://api.example.com/?token=abc' })).rejects.toMatchObject({ code: 'network_disabled_in_test' });
  });
});

describe('주소 제한 (SSRF) · 리다이렉트 · 응답 크기', () => {
  it('http · IP 주소 · localhost · 내부 이름 · 비기본 포트 · 사용자 정보가 든 주소는 fetch 전에 거부한다', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: '{}' }]);
    const { h, logs } = http(fetch);
    const bad = [
      'http://api.example.com/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/admin',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x',
      'https://localhost/x',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://printer.local/x',
      'https://intranet/x',
      'https://api.example.com:8443/x',
      'https://user:pw@api.example.com/x',
      'file:///etc/passwd',
    ];
    for (const url of bad) {
      const err = await h.request({ method: 'GET', url }).catch((e) => e);
      expect(err, url).toBeInstanceOf(ConnectorHttpError);
      expect(err.code, url).toBe('blocked_url');
    }
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).not.toContain('pw@');
    // 공식 API 호스트 형태는 통과 (몰 ID 하위 도메인 포함)
    await h.request({ method: 'GET', url: 'https://mymall.cafe24api.com/api/v2/admin/orders' });
    await h.request({ method: 'GET', url: 'https://api.searchad.naver.com:443/stats' });
    expect(calls).toHaveLength(2);
  });

  it('DNS 결과가 사설 · 루프백 주소면 거부 (DNS 재바인딩 · 내부 망 하위 도메인)', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: '{}' }]);
    const table: Record<string, string[]> = { 'evil.example.com': ['93.184.216.34', '10.1.2.3'], 'ok.example.com': ['93.184.216.34'] };
    const { h } = http(fetch, { resolveHost: async (host) => table[host] ?? [] });
    await expect(h.request({ method: 'GET', url: 'https://evil.example.com/x' })).rejects.toMatchObject({ code: 'blocked_url' });
    await h.request({ method: 'GET', url: 'https://ok.example.com/x' });
    expect(calls.map((c) => c.url)).toEqual(['https://ok.example.com/x']);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('::ffff:192.168.0.1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('2404:6800:4004::200e')).toBe(false);
    expect(urlProblem('https://api.searchad.naver.com/ncc/campaigns')).toBeNull();
  });

  it('리다이렉트는 따라가지 않고(redirect: manual) 3xx 응답을 그대로 돌려준다', async () => {
    const { fetch, calls } = fakeFetch([{ status: 302, headers: { location: 'http://169.254.169.254/' } }]);
    const { h } = http(fetch);
    const r = await h.request({ method: 'GET', url: 'https://api.example.com/x' });
    expect(calls[0].redirect).toBe('manual');
    expect(r.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(() => expectOk(r, '조회')).toThrow(/HTTP 302/);
  });

  it('응답 크기 상한을 넘으면 재시도 없이 too_large', async () => {
    const big = 'x'.repeat(2048);
    const { fetch, calls } = fakeFetch([{ status: 200, body: big, headers: { 'content-type': 'text/plain' } }]);
    const { h } = http(fetch, { maxResponseBytes: 1024 });
    await expect(h.request({ method: 'GET', url: 'https://api.example.com/x' })).rejects.toMatchObject({ code: 'too_large' });
    expect(calls).toHaveLength(1);
    const { fetch: f2 } = fakeFetch([{ status: 200, body: '{}', headers: { 'content-type': 'application/json', 'content-length': '999999' } }]);
    await expect(http(f2, { maxResponseBytes: 1024 }).h.request({ method: 'GET', url: 'https://api.example.com/y' })).rejects.toMatchObject({ code: 'too_large' });
  });
});
