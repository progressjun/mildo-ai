/**
 * 테스트용 가짜 HTTP (connectors-sales 도메인 테스트 공용, 테스트 파일에서만 import) — 실제 네트워크를 호출하지 않는다.
 *  - fakeHttp: ConnectorHttp를 바로 흉내 (단위 테스트). 위에서부터 첫 일치 경로가 응답, 일치하는 경로가 없으면 오류.
 *  - fakeFetch: FetchLike (connectors/http.ts 래퍼 아래에 꽂아 URL 조립 · 본문 인코딩 · 재시도까지 실제 경로를 탄다 — 통합 테스트).
 */
import type { ConnectorContext, ConnectorHttp } from '../types';
import type { FetchLike } from '../http';
import type { HttpRequest } from './sales-shared';

export interface FakeReply { status?: number; data?: unknown; headers?: Record<string, string> }
export interface FakeRoute {
  method?: HttpRequest['method'];
  match: string | RegExp | ((req: HttpRequest) => boolean);
  reply: FakeReply | ((req: HttpRequest, n: number) => FakeReply | Promise<FakeReply>);
}
export type FakeHttp = ConnectorHttp & { calls: HttpRequest[]; callsTo(part: string | RegExp): HttpRequest[] };

const fullUrl = (req: HttpRequest) => {
  if (!req.query) return req.url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (v !== undefined && v !== null) qs.append(k, String(v));
  const s = qs.toString();
  return s ? `${req.url}${req.url.includes('?') ? '&' : '?'}${s}` : req.url;
};

/** 요청의 쿼리 값 (query 객체 또는 URL 쿼리 문자열) */
export function q(req: HttpRequest, key: string): string | undefined {
  const v = req.query?.[key];
  if (v !== undefined && v !== null) return String(v);
  try { return new URL(req.url).searchParams.get(key) ?? undefined; } catch { return undefined; }
}

export function fakeHttp(routes: FakeRoute[]): FakeHttp {
  const calls: HttpRequest[] = [];
  const hits = new Map<FakeRoute, number>();
  const matches = (r: FakeRoute, req: HttpRequest) => {
    const url = fullUrl(req);
    return (!r.method || r.method === req.method) && (typeof r.match === 'string' ? url.includes(r.match) : r.match instanceof RegExp ? r.match.test(url) : r.match(req));
  };
  return {
    calls,
    callsTo: (part) => calls.filter((c) => (typeof part === 'string' ? fullUrl(c).includes(part) : part.test(fullUrl(c)))),
    async request<T = unknown>(req: HttpRequest) {
      calls.push(JSON.parse(JSON.stringify(req)) as HttpRequest);
      const route = routes.find((r) => matches(r, req));
      if (!route) throw new Error(`가짜 HTTP: 예상하지 못한 요청 ${req.method} ${fullUrl(req)}`);
      const n = (hits.get(route) ?? 0) + 1;
      hits.set(route, n);
      const rep = typeof route.reply === 'function' ? await route.reply(req, n) : route.reply;
      return { status: rep.status ?? 200, data: (rep.data ?? null) as T, headers: rep.headers ?? { 'content-type': 'application/json' } };
    },
  };
}

export function fakeCtx<C, S>(credentials: C, settings: S, http: ConnectorHttp, o: { dryRun?: boolean; logs?: string[]; saved?: unknown[]; connectionId?: string } = {}): ConnectorContext<C, S> {
  return {
    workspaceId: 'ws-test',
    connectionId: o.connectionId ?? `conn-${Math.random().toString(36).slice(2, 10)}`,
    credentials,
    settings,
    http,
    log: (m) => { o.logs?.push(m); },
    dryRun: o.dryRun ?? true,
    saveCredentials: async (next) => { o.saved?.push(JSON.parse(JSON.stringify(next))); },
  };
}

/* ---------------- 공급자 가짜 서버 (같은 처리기를 단위 · 통합 테스트에서 함께 쓴다) ---------------- */

export interface FakeRequest { method: string; url: URL; headers: Record<string, string>; body: unknown }
export type Handler = (r: FakeRequest) => FakeReply | null | undefined;
export interface Recorded extends FakeRequest { raw: string }

const lower = (h: Record<string, string> | undefined) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/** 처리기들을 차례로 시도 */
export const combine = (...hs: Handler[]): Handler => (r) => { for (const h of hs) { const x = h(r); if (x) return x; } return null; };

/** 처리기 → ConnectorHttp (단위 테스트) */
export function handlerHttp(h: Handler): ConnectorHttp & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    async request<T = unknown>(req: HttpRequest) {
      const url = new URL(fullUrl(req));
      const r: Recorded = { method: req.method, url, headers: lower(req.headers), body: req.body === undefined ? undefined : JSON.parse(JSON.stringify(req.body)), raw: url.toString() };
      calls.push(r);
      const rep = h(r);
      if (!rep) throw new Error(`가짜 서버: 예상하지 못한 요청 ${req.method} ${url.toString()}`);
      return { status: rep.status ?? 200, data: (rep.data ?? null) as T, headers: rep.headers ?? { 'content-type': 'application/json' } };
    },
  };
}

/** 처리기 → FetchLike (connectors/http.ts 래퍼 아래 — 통합 테스트) */
export function handlerFetch(h: Handler): FetchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const f = (async (rawUrl: string, init: Parameters<FetchLike>[1]) => {
    const headers = lower(init.headers);
    const ctype = headers['content-type'] ?? '';
    let body: unknown;
    if (init.body !== undefined) body = /x-www-form-urlencoded/.test(ctype) ? Object.fromEntries(new URLSearchParams(init.body)) : /json/.test(ctype) ? JSON.parse(init.body) : init.body;
    const r: Recorded = { method: init.method, url: new URL(rawUrl), headers, body, raw: rawUrl };
    calls.push(r);
    const rep = h(r);
    if (!rep) throw new Error(`가짜 서버: 예상하지 못한 요청 ${init.method} ${rawUrl}`);
    const text = rep.data === undefined || rep.data === null ? '' : typeof rep.data === 'string' ? rep.data : JSON.stringify(rep.data);
    return { status: rep.status ?? 200, headers: new Headers({ 'content-type': 'application/json', ...(rep.headers ?? {}) }), text: async () => text };
  }) as unknown as FetchLike & { calls: Recorded[] };
  f.calls = calls;
  return f;
}

/** FetchLike 요청 기록 */
export interface FetchCall { method: string; url: string; headers: Record<string, string>; body?: string }
export type FetchRoute = (c: FetchCall) => FakeReply | null | undefined | Promise<FakeReply | null | undefined>;

/** 경로 함수들을 차례로 시도하는 FetchLike — 응답이 없으면 오류(예상하지 못한 호출) */
export function fakeFetch(routes: FetchRoute[]): FetchLike & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (url: string, init: Parameters<FetchLike>[1]) => {
    const c: FetchCall = { method: init.method, url, headers: { ...init.headers }, body: init.body };
    calls.push(c);
    for (const r of routes) {
      const rep = await r(c);
      if (rep) {
        const headers = new Headers({ 'content-type': 'application/json', ...(rep.headers ?? {}) });
        const text = rep.data === undefined || rep.data === null ? '' : typeof rep.data === 'string' ? rep.data : JSON.stringify(rep.data);
        return { status: rep.status ?? 200, headers, text: async () => text };
      }
    }
    throw new Error(`가짜 fetch: 예상하지 못한 요청 ${init.method} ${url}`);
  }) as unknown as FetchLike & { calls: FetchCall[] };
  f.calls = calls;
  return f;
}
