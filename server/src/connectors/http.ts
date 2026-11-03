/**
 * 커넥터 외부 호출 래퍼 (docs/SAAS_SPEC.md §3 · §5) — 모든 매체 · 판매 채널 API 호출은 이 래퍼를 쓴다.
 *  - 타임아웃: AbortController (요청별 timeoutMs 우선)
 *  - 재시도: 429 · 5xx · 네트워크 오류 · 타임아웃 → 지수 백오프(+지터), Retry-After(초 · HTTP 날짜) 우선
 *  - 쿼리 조립(undefined 제외), 본문 json · form(x-www-form-urlencoded) · text
 *  - 응답 헤더는 소문자 키로, 본문은 content-type이 JSON이면 파싱(실패 시 텍스트)
 *  - 요청 로그: 메서드 · 마스킹한 URL · 상태 · 소요 시간 · 시도 횟수. 비밀값 헤더 · 쿼리는 가린다. 본문은 기록하지 않는다(크기만).
 *  - 주소 제한(SSRF 방지): https만, 기본 포트(443)만, URL 안 사용자 정보 금지, IP 주소 · localhost · 내부 이름(.local · .internal ·
 *    점 없는 이름) 금지, 실제 네트워크에서는 DNS 결과가 사설 · 루프백 · 링크 로컬 주소면 거부. 리다이렉트는 따라가지 않는다(3xx 그대로 반환).
 *    매체 API는 모두 공개 https 호스트이고, 사용자 입력이 주소에 들어가는 커넥터(예: 몰 ID 하위 도메인)도 이 검사를 거친다.
 *  - 응답 크기 상한(기본 64MB) — 넘으면 읽지 않고 오류
 * HTTP 응답(4xx · 5xx 포함)은 그대로 돌려주고, 네트워크 오류 · 타임아웃 · 주소 거부 · 크기 초과만 ConnectorHttpError로 던진다.
 * 상태 검사가 필요하면 expectOk(res, '설명')를 쓴다.
 *
 * 테스트: createConnectorHttp({ fetchImpl })로 가짜 fetch를 주입한다. NODE_ENV=test에서 주입 없이 호출하면
 * 실제 네트워크 대신 오류를 던진다(테스트 중 실네트워크 금지 — §5). setDefaultConnectorFetch로 전역 가짜 fetch를 둘 수 있다.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConnectorHttp } from './types';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect?: 'manual' }) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void } | Headers;
  text(): Promise<string>;
}>;

export interface RequestLogEntry {
  method: string;
  /** 비밀값 쿼리를 가린 URL */
  url: string;
  status: number | null;
  ms: number;
  attempt: number;
  /** 가린 요청 헤더 */
  headers: Record<string, string>;
  bodyBytes: number;
  error?: string;
  retryInMs?: number;
}

export interface ConnectorHttpOptions {
  fetchImpl?: FetchLike;
  log: (msg: string, extra?: unknown) => void;
  /** 기본 재시도 횟수 (요청별 retries 우선) */
  maxRetries: number;
  /** 기본 타임아웃 (요청별 timeoutMs 우선) */
  timeoutMs: number;
  /** 백오프 기본 간격 (기본 500ms) */
  baseDelayMs?: number;
  /** Retry-After · 백오프 상한 (기본 60초) */
  maxDelayMs?: number;
  /** 테스트용 대기 함수 */
  sleep?: (ms: number) => Promise<void>;
  /** 요청마다 호출 (요청 로그 수집 · 감사용) */
  onRequest?: (e: RequestLogEntry) => void;
  /** 테스트용 난수 (지터) */
  random?: () => number;
  /** 응답 본문 상한 (기본 64MB) */
  maxResponseBytes?: number;
  /** 호스트 이름 → IP 목록 (기본: 실제 네트워크일 때만 node:dns lookup, 주입한 fetch면 생략). 사설 주소면 거부 */
  resolveHost?: ((host: string) => Promise<string[]>) | null;
}

export class ConnectorHttpError extends Error {
  constructor(public code: 'timeout' | 'network' | 'network_disabled_in_test' | 'http' | 'blocked_url' | 'too_large', message: string, public status?: number, public data?: unknown) {
    super(message);
    this.name = 'ConnectorHttpError';
  }
}

let defaultFetch: FetchLike | null = null;
/** 테스트 · 개발용: 주입이 없을 때 쓸 전역 fetch (null이면 해제) */
export function setDefaultConnectorFetch(f: FetchLike | null): void {
  defaultFetch = f;
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-api-secret|x-customer|x-signature|x-timestamp-signature|signature|x-naver-client-secret|x-access-token|access-token|x-auth-token|developer-token|x-goog-api-key|api-key|apikey)$|token|secret|signature|password|passwd/i;
const SECRET_QUERY = /(key|secret|token|signature|sig|password|passwd|auth|credential|code_verifier|client_assertion)/i;

/** 비밀값으로 보이는 헤더 값을 가린다 */
export function maskHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k] = SECRET_HEADER.test(k) ? (v ? '••••' : '') : v;
  return out;
}

/** URL의 비밀값 쿼리 파라미터 · 사용자 정보(user:pass@)를 가린다 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '••••' : '';
      u.password = u.password ? '••••' : '';
    }
    for (const k of [...u.searchParams.keys()]) if (SECRET_QUERY.test(k)) u.searchParams.set(k, '••••');
    return u.toString().replace(/%E2%80%A2/g, '•');
  } catch {
    return url.replace(/([?&][^=&]*(?:key|secret|token|signature|sig|password|auth)[^=&]*=)[^&]*/gi, '$1••••');
  }
}

/** 오류 메시지 · 응답 본문 일부에 섞인 토큰처럼 보이는 긴 문자열을 가린다 */
export function scrubSecrets(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••')
    .replace(/((?:access|refresh|api|secret|client)[_-]?(?:token|key|secret)["'=:\s]+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1••••');
}

export function buildUrl(url: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return url;
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null) as [string, string | number | boolean][];
  if (!entries.length) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of entries) qs.append(k, String(v));
  return `${url}${url.includes('?') ? '&' : '?'}${qs.toString()}`;
}

/* ---------- 주소 제한 (SSRF 방지) ---------- */

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

/** 사설 · 루프백 · 링크 로컬 · 예약 IP인지 (IPv4 · IPv6, IPv4 매핑 IPv6 포함) */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
  }
  return true; // IP가 아니면 판단 불가 → 막는다
}

/** 외부 API 주소 검사 — 통과하면 null, 아니면 거부 사유 */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return '주소 형식이 올바르지 않습니다'; }
  if (u.protocol !== 'https:') return 'https 주소만 호출할 수 있습니다';
  if (u.username || u.password) return '주소에 사용자 정보를 넣을 수 없습니다';
  if (u.port && u.port !== '443') return `기본 포트(443) 외 포트(${u.port})는 호출할 수 없습니다`;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return '호스트가 없습니다';
  if (isIP(host)) return 'IP 주소로는 호출할 수 없습니다 (공식 API 호스트 이름만 허용)';
  if (!host.includes('.') || INTERNAL_NAME.test(host)) return `내부 호스트(${host})는 호출할 수 없습니다`;
  return null;
}

const defaultResolve = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Retry-After: 초 또는 HTTP 날짜 → ms (해석 불가면 null) */
export function parseRetryAfter(v: string | undefined | null, now = Date.now()): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s) * 1000));
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const RETRYABLE = (status: number) => status === 429 || (status >= 500 && status <= 599);

function encodeBody(body: unknown, bodyType: 'json' | 'form' | 'text', headers: Record<string, string>): string | undefined {
  if (body === undefined || body === null) return undefined;
  const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (bodyType === 'form') {
    if (!has('content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (typeof body === 'string') return body;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
      else p.append(k, String(v));
    }
    return p.toString();
  }
  if (bodyType === 'text') {
    if (!has('content-type')) headers['content-type'] = 'text/plain; charset=utf-8';
    return String(body);
  }
  if (!has('content-type')) headers['content-type'] = 'application/json';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function lowerHeaders(h: { forEach(cb: (value: string, key: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

/** 실제 네트워크(주입 없는 전역 fetch)를 쓰는지 */
const usesRealNetwork = (o: ConnectorHttpOptions) => !o.fetchImpl && !defaultFetch && !(process.env.NODE_ENV === 'test' && process.env.ALLOW_NETWORK_IN_TESTS !== 'true');

function resolveFetch(o: ConnectorHttpOptions): FetchLike {
  if (o.fetchImpl) return o.fetchImpl;
  if (defaultFetch) return defaultFetch;
  if (process.env.NODE_ENV === 'test' && process.env.ALLOW_NETWORK_IN_TESTS !== 'true') {
    return async (url) => {
      throw new ConnectorHttpError('network_disabled_in_test', `테스트 중 실제 네트워크 호출 금지: ${maskUrl(url)} (가짜 fetch를 주입하세요)`);
    };
  }
  return globalThis.fetch as unknown as FetchLike;
}

export function createConnectorHttp(o: ConnectorHttpOptions): ConnectorHttp & { log: RequestLogEntry[] } {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = o.baseDelayMs ?? 500;
  const cap = o.maxDelayMs ?? 60_000;
  const random = o.random ?? Math.random;
  const maxBytes = Math.max(1, o.maxResponseBytes ?? 64 * 1024 * 1024);
  const resolveHost = o.resolveHost === undefined ? (usesRealNetwork(o) ? defaultResolve : null) : o.resolveHost;
  const checkedHosts = new Map<string, number>();
  const entries: RequestLogEntry[] = [];
  const record = (e: RequestLogEntry) => {
    entries.push(e);
    if (entries.length > 200) entries.shift();
    o.onRequest?.(e);
    const tail = e.error ? ` 오류: ${e.error}` : '';
    const retry = e.retryInMs !== undefined ? ` · ${e.retryInMs}ms 뒤 재시도` : '';
    o.log(`${e.method} ${e.url} → ${e.status ?? '—'} (${e.ms}ms, 시도 ${e.attempt})${retry}${tail}`, { headers: e.headers, bodyBytes: e.bodyBytes });
  };

  const http: ConnectorHttp & { log: RequestLogEntry[] } = {
    log: entries,
    async request<T = unknown>(r: Parameters<ConnectorHttp['request']>[0]): Promise<{ status: number; data: T; headers: Record<string, string> }> {
      const fetchImpl = resolveFetch(o);
      const url = buildUrl(r.url, r.query);
      const masked = maskUrl(url);
      const headers: Record<string, string> = { accept: 'application/json', ...(r.headers ?? {}) };
      const body = r.method === 'GET' ? undefined : encodeBody(r.body, r.bodyType ?? 'json', headers);
      const bodyBytes = body ? Buffer.byteLength(body) : 0;
      const blocked = urlProblem(url);
      const refuse = (why: string): never => {
        record({ method: r.method, url: masked, status: null, ms: 0, attempt: 0, headers: maskHeaders(headers), bodyBytes, error: why });
        throw new ConnectorHttpError('blocked_url', `${r.method} ${masked} 호출 거부: ${why}`);
      };
      if (blocked) refuse(blocked);
      if (resolveHost) {
        const host = new URL(url).hostname;
        const okUntil = checkedHosts.get(host) ?? 0;
        if (okUntil < Date.now()) {
          let ips: string[] = [];
          try { ips = await resolveHost(host); } catch { ips = []; /* 해석 실패는 fetch가 네트워크 오류로 처리 */ }
          const bad = ips.find((ip) => isPrivateIp(ip));
          if (bad) refuse(`호스트 ${host}이(가) 내부 주소(${bad})로 연결됩니다`);
          if (ips.length) checkedHosts.set(host, Date.now() + 60_000);
        }
      }
      const retries = Math.max(0, r.retries ?? o.maxRetries);
      const timeoutMs = Math.max(1, r.timeoutMs ?? o.timeoutMs);
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let status: number | null = null;
        try {
          const res = await fetchImpl(url, { method: r.method, headers, body, signal: ctl.signal, redirect: 'manual' });
          status = res.status;
          const resHeaders = lowerHeaders(res.headers as { forEach(cb: (value: string, key: string) => void): void });
          const declared = Number(resHeaders['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) throw new ConnectorHttpError('too_large', `응답이 너무 큽니다 (${declared}바이트 > 상한 ${maxBytes})`, res.status);
          const text = await res.text();
          if (text.length > maxBytes) throw new ConnectorHttpError('too_large', `응답이 너무 큽니다 (상한 ${maxBytes}바이트)`, res.status);
          clearTimeout(timer);
          const ms = Date.now() - started;
          if (RETRYABLE(res.status) && attempt <= retries) {
            const ra = parseRetryAfter(resHeaders['retry-after']);
            const wait = Math.min(cap, ra ?? Math.round(base * 2 ** (attempt - 1) * (0.75 + random() * 0.5)));
            record({ method: r.method, url: masked, status, ms, attempt, headers: maskHeaders(headers), bodyBytes, retryInMs: wait });
            await sleep(wait);
            continue;
          }
          record({ method: r.method, url: masked, status, ms, attempt, headers: maskHeaders(headers), bodyBytes });
          const ctype = resHeaders['content-type'] ?? '';
          let data: unknown = text;
          if (/json/i.test(ctype) || (!ctype && /^\s*[[{]/.test(text))) {
            try { data = text ? JSON.parse(text) : null; } catch { data = text; }
          }
          return { status: res.status, data: data as T, headers: resHeaders };
        } catch (e) {
          clearTimeout(timer);
          const ms = Date.now() - started;
          if (e instanceof ConnectorHttpError && (e.code === 'network_disabled_in_test' || e.code === 'too_large')) {
            record({ method: r.method, url: masked, status: null, ms, attempt, headers: maskHeaders(headers), bodyBytes, error: e.message });
            throw e;
          }
          const timedOut = ctl.signal.aborted;
          const msg = timedOut ? `시간 초과 (${timeoutMs}ms)` : scrubSecrets((e as Error)?.message ?? String(e));
          if (attempt <= retries) {
            const wait = Math.min(cap, Math.round(base * 2 ** (attempt - 1) * (0.75 + random() * 0.5)));
            record({ method: r.method, url: masked, status, ms, attempt, headers: maskHeaders(headers), bodyBytes, error: msg, retryInMs: wait });
            await sleep(wait);
            continue;
          }
          record({ method: r.method, url: masked, status, ms, attempt, headers: maskHeaders(headers), bodyBytes, error: msg });
          throw new ConnectorHttpError(timedOut ? 'timeout' : 'network', `${r.method} ${masked} 호출 실패: ${msg}`);
        }
      }
    },
  };
  return http;
}

/** 2xx가 아니면 ConnectorHttpError('http')를 던진다 (응답 본문 일부를 가려서 메시지에 붙인다) */
export function expectOk<T>(res: { status: number; data: T }, what: string): T {
  if (res.status >= 200 && res.status < 300) return res.data;
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
  throw new ConnectorHttpError('http', `${what} 실패 (HTTP ${res.status}): ${scrubSecrets(raw).slice(0, 300)}`, res.status, res.data);
}
