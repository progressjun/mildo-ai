/**
 * 테스트용 가짜 ConnectorHttp (connectors-media 도메인 테스트 공용) — 실제 네트워크를 호출하지 않는다.
 *  - routes: 위에서부터 첫 일치 경로가 응답한다. 일치하는 경로가 없으면 오류(예상치 못한 호출 방지).
 *  - mode 'throw': changes 도메인 쓰기 래퍼처럼 4xx/5xx에서 { status, data }를 가진 예외를 던진다.
 */
import type { ConnectorContext, ConnectorHttp } from '../types';
import type { HttpRequest } from './media-shared';

export interface FakeReply { status?: number; data?: unknown; headers?: Record<string, string> }
export interface FakeRoute {
  method?: HttpRequest['method'];
  /** URL 부분 문자열 · 정규식 · 판정 함수 */
  match: string | RegExp | ((req: HttpRequest) => boolean);
  reply: FakeReply | ((req: HttpRequest, n: number) => FakeReply | Promise<FakeReply>);
}

export type FakeHttp = ConnectorHttp & { calls: HttpRequest[]; callsTo(part: string | RegExp): HttpRequest[] };

export function fakeHttp(routes: FakeRoute[], opts: { mode?: 'return' | 'throw' } = {}): FakeHttp {
  const calls: HttpRequest[] = [];
  const hits = new Map<FakeRoute, number>();
  const matches = (r: FakeRoute, req: HttpRequest) =>
    (!r.method || r.method === req.method) &&
    (typeof r.match === 'string' ? req.url.includes(r.match) : r.match instanceof RegExp ? r.match.test(req.url) : r.match(req));
  return {
    calls,
    callsTo: (part) => calls.filter((c) => (typeof part === 'string' ? c.url.includes(part) : part.test(c.url))),
    async request<T = unknown>(req: HttpRequest) {
      calls.push(JSON.parse(JSON.stringify(req)) as HttpRequest);
      const route = routes.find((r) => matches(r, req));
      if (!route) throw new Error(`가짜 HTTP: 예상하지 못한 요청 ${req.method} ${req.url}`);
      const n = (hits.get(route) ?? 0) + 1;
      hits.set(route, n);
      const rep = typeof route.reply === 'function' ? await route.reply(req, n) : route.reply;
      const status = rep.status ?? 200;
      if (opts.mode === 'throw' && status >= 400) {
        throw Object.assign(new Error(`매체 API 오류 HTTP ${status}`), { status, data: rep.data });
      }
      return { status, data: (rep.data ?? null) as T, headers: rep.headers ?? { 'content-type': 'application/json' } };
    },
  };
}

export function fakeCtx<C, S>(credentials: C, settings: S, http: ConnectorHttp, o: { dryRun?: boolean; logs?: string[] } = {}): ConnectorContext<C, S> {
  return {
    workspaceId: 'ws-test',
    connectionId: `conn-${Math.random().toString(36).slice(2, 10)}`,
    credentials,
    settings,
    http,
    log: (m) => { o.logs?.push(m); },
    dryRun: o.dryRun ?? false,
  };
}
