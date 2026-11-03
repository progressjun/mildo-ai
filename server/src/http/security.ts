/**
 * 보안 · 운영 HTTP 계층 (devops 도메인 소유). buildApp()이 쿠키 · rate-limit 플러그인 다음, 인증 플러그인 앞에 등록한다.
 *
 *  - 보안 헤더: CSP(앱 화면 · API 따로) · nosniff · X-Frame-Options · Referrer-Policy · Permissions-Policy ·
 *    Cross-Origin-Opener-Policy · Cross-Origin-Resource-Policy · HSTS(config.secureCookies일 때) · API 응답 no-store.
 *    reply.hijack()으로 직접 쓰는 스트림(SSE /api/w/:ws/events · AI /api/w/:ws/ai/messages)은 onSend를 거치지 않으므로
 *    API 요청은 onRequest에서 원시 응답(res.setHeader)에도 같은 헤더를 미리 넣는다 (writeHead가 합친다)
 *  - 정적 파일 캐시: index.html은 no-cache(배포 직후 옛 화면 방지), 해시가 붙은 /assets/*는 1년 immutable
 *  - 요청 id: 프록시가 준 x-request-id를 이어 쓰거나 Fastify 요청 id(app.ts genReqId — 같은 규칙)를 쓴다
 *    → 응답 헤더 · 요청 로그(requestId · reqId)가 같은 값
 *  - 전역 속도 제한: /api 아래 클라이언트 IP당 분당 600회(SSE 제외), 로그인 · 비밀번호 재설정 · 초대 수락은 IP당 분당 20회
 *  - 로그인 실패 잠금: 같은 이메일로 15분 안에 10회 실패하면 잠시 막는다(감사 로그 기반이라 서버 여러 대여도 같은 기준).
 *    성공 로그인 · 비밀번호 재설정 뒤에는 새로 센다. 최근 30일 안에 이 계정으로 로그인에 성공한 IP는
 *    그 IP에서 난 실패만 센다(다른 곳에서 일부러 실패를 쌓아 본인을 잠그는 공격 완화)
 *  - 경로 판정은 라우터가 고른 경로(routeOptions.url)로 한다 — /%61pi/… · /api/auth/login#… 같은 인코딩 우회 차단
 *  - GET /api/ready: DB 연결 · 마이그레이션 적용 · 워커(워커가 60초마다 쓰는 하트비트 + 잡 처리 기록) · 스케줄러(예약 감지 잡 생성)
 *    → ready / degraded / not_ready. 세부 항목(워커 이름 · 워크스페이스 수 · 오류 문구)은 내부망 IP 또는 READY_TOKEN 헤더에만 보여 준다
 *  - 우아한 종료: 서버를 닫을 때(preClose) 열린 SSE 연결은 바로 정리하고, 진행 중인 AI 응답 스트림은
 *    SHUTDOWN_STREAM_GRACE_MS 동안 끝나기를 기다린 뒤 남은 것에 error 이벤트를 보내고 끊는다 → app.close()가 멈추지 않는다
 *
 * 선택 환경변수 (config.ts를 바꾸지 않고 이 파일에서만 읽는다. 값은 앱을 만들 때 한 번 읽는다):
 *   API_RATE_LIMIT_MAX(600) · API_RATE_LIMIT_WINDOW_SEC(60) · AUTH_RATE_LIMIT_MAX(20)
 *   LOGIN_FAIL_MAX(10) · LOGIN_FAIL_WINDOW_MIN(15) · TRUST_PROXY_HOPS(1 — app.ts의 Fastify trustProxy도 같은 값을 쓴다)
 *   CSP_CONNECT_SRC_EXTRA(빈 값, 공백 구분 출처) · READY_WORKER_STALE_MIN(15) · READY_SCHEDULER_STALE_MIN(25) · SLOW_REQUEST_MS(3000)
 *   SHUTDOWN_STREAM_GRACE_MS(20000)
 *   READY_TOKEN(빈 값 — 주면 x-ready-token 헤더가 같을 때 외부에서도 /api/ready 세부 항목을 보여 준다)
 *   0을 주면 해당 제한을 끈다. NODE_ENV=test에서는 속도 제한 · 로그인 잠금이 기본으로 꺼져 있고 값을 주면 켜진다.
 * 속도 제한 카운터는 프로세스 메모리에 있다(서버 여러 대면 대마다 따로 센다 — docs/OPERATIONS.md).
 */
import fp from '../auth/fp';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { migrationsDir } from '../db/migrate';
import { one, type Queryable } from '../db/pool';
import { HttpError } from '../lib/errors';
import { audit } from '../audit/audit';

declare module 'fastify' {
  interface FastifyRequest {
    /** 요청 추적 id (응답 헤더 x-request-id와 같다) */
    requestId: string;
  }
}

/* ---------------- 설정 ---------------- */

export interface SecurityOptions {
  /** /api 전역: 창마다 허용 요청 수 (0 = 끔) */
  apiRateMax: number;
  apiRateWindowMs: number;
  /** 로그인 전 쓰기 엔드포인트(로그인 · 재설정 · 초대 수락 · 초기 설정): 분당 허용 수 (0 = 끔) */
  authRateMax: number;
  /** 같은 이메일 로그인 실패 허용 횟수 (0 = 끔) */
  loginFailMax: number;
  loginFailWindowMin: number;
  /** 앞단 리버스 프록시 수 — X-Forwarded-For에서 클라이언트 IP를 고르는 위치 (0 = 소켓 주소만) */
  proxyHops: number;
  /** CSP connect-src에 더할 출처 (예: https://api.anthropic.com) */
  cspConnectExtra: string[];
  /** 워커 활동이 이 시간(분)보다 오래되면 degraded */
  workerStaleMin: number;
  /** 활성 워크스페이스가 있는데 예약 감지 잡(alerts.scan, 10분 간격)이 이 시간(분) 동안 생기지 않으면 스케줄러 멈춤 */
  schedulerStaleMin: number;
  slowRequestMs: number;
  /** 종료 시 진행 중인 AI 응답 스트림이 끝나기를 기다리는 최대 시간(ms) */
  shutdownStreamGraceMs: number;
  /** 외부에서 /api/ready 세부 항목을 볼 때 쓰는 토큰 (null = 내부망만) */
  readyToken: string | null;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[security] ${name}=${raw} 값이 올바르지 않아 기본값 ${fallback}을 씁니다`);
    return fallback;
  }
  return Math.floor(n);
}

/** CSP에 넣을 수 있는 출처만 통과 (따옴표 · 세미콜론 · 와일드카드 남용 차단) */
export function parseCspSources(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^(https|wss):\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(s));
}

export function securityOptionsFromEnv(env: NodeJS.ProcessEnv, appEnv: 'development' | 'test' | 'production'): SecurityOptions {
  const test = appEnv === 'test';
  return {
    apiRateMax: intEnv(env, 'API_RATE_LIMIT_MAX', test ? 0 : 600),
    apiRateWindowMs: Math.max(1, intEnv(env, 'API_RATE_LIMIT_WINDOW_SEC', 60)) * 1000,
    authRateMax: intEnv(env, 'AUTH_RATE_LIMIT_MAX', test ? 0 : 20),
    loginFailMax: intEnv(env, 'LOGIN_FAIL_MAX', test ? 0 : 10),
    loginFailWindowMin: Math.max(1, intEnv(env, 'LOGIN_FAIL_WINDOW_MIN', 15)),
    proxyHops: intEnv(env, 'TRUST_PROXY_HOPS', 1),
    cspConnectExtra: parseCspSources(env.CSP_CONNECT_SRC_EXTRA),
    workerStaleMin: Math.max(1, intEnv(env, 'READY_WORKER_STALE_MIN', 15)),
    schedulerStaleMin: Math.max(11, intEnv(env, 'READY_SCHEDULER_STALE_MIN', 25)),
    slowRequestMs: intEnv(env, 'SLOW_REQUEST_MS', 3000),
    shutdownStreamGraceMs: intEnv(env, 'SHUTDOWN_STREAM_GRACE_MS', 20_000),
    readyToken: readyTokenFromEnv(env.READY_TOKEN),
  };
}

function readyTokenFromEnv(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (v.length < 16) {
    console.warn('[security] READY_TOKEN은 16자 이상이어야 합니다 — 무시하고 내부망에만 세부 항목을 보여 줍니다');
    return null;
  }
  return v;
}

/* ---------------- 헤더 ---------------- */

/** 서빙하는 프런트(dist)용 CSP — Vite 정상 빌드는 인라인 스크립트가 없고, 폰트는 Google Fonts(index.html) */
export function appCsp(connectExtra: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", ...connectExtra].join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** JSON API 응답용 CSP — 문서로 열려도 아무것도 불러오지 못하게 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** 브라우저 기능 차단 (Chrome이 인식하는 기능 이름만 — 모르는 이름은 콘솔 경고를 낸다) */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), magnetometer=(), gyroscope=(), accelerometer=()';

export const HSTS = 'max-age=31536000; includeSubDomains';

const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/');
/** Vite 빌드 자산 (파일명에 내용 해시) */
const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** 원시 URL의 경로 부분을 라우터와 같은 방식으로 정리한다 ('?' · '#' 앞까지, 퍼센트 인코딩 해제) */
export function decodedPath(url: string): string {
  const raw = url.split(/[?#]/)[0] || '/';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 판정에 쓰는 경로 — 라우터가 실제로 고른 라우트 패턴(예: '/api/w/:ws/events')을 우선한다.
 * req.url 문자열로 판정하면 /%61pi/auth/login(→ /api/auth/login으로 라우팅됨)이나 /api/auth/login#x 처럼
 * 같은 라우트를 다른 글자로 불러 속도 제한 · 로그인 잠금 · API 헤더를 피할 수 있다.
 * 와일드카드(정적 파일 '/*')나 404는 해제한 원시 경로로 판정한다.
 */
export function routePath(req: Pick<FastifyRequest, 'url'> & { routeOptions?: { url?: string } }): string {
  const route = req.routeOptions?.url;
  if (route && !route.includes('*')) return route;
  return decodedPath(req.url);
}

const SSE_ROUTE = '/api/w/:ws/events';
/** AI 응답 스트림(POST, reply.hijack 후 SSE) — 종료 시 끝나기를 잠시 기다린다 */
const AI_STREAM_ROUTE = '/api/w/:ws/ai/messages';
const LOGIN_ROUTE = '/api/auth/login';
/** 로그인 전 쓰기 엔드포인트 (라우트 패턴) */
const AUTH_WRITE_ROUTES = new Set([
  LOGIN_ROUTE, '/api/auth/password-reset', '/api/auth/password-reset/check', '/api/auth/password-reset/confirm', '/api/invites/:token/accept', '/api/setup',
]);

/** 루프백 · 사설망 · 링크 로컬 주소 (/api/ready 세부 항목 공개 범위) */
export function isInternalIp(ip: string): boolean {
  let s = (ip || '').trim().toLowerCase();
  const bracket = s.match(/^\[([^\]]+)\](:\d+)?$/);
  if (bracket) s = bracket[1];
  s = s.replace(/%.*$/, '');
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s)) {
    const [a, b] = s.replace(/:\d+$/, '').split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (!s.includes(':')) return false;
  if (s === '::1') return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(s) || /^fe[89ab][0-9a-f]?:/.test(s);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
function tokenMatches(given: unknown, expected: string | null): boolean {
  if (!expected || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

/* ---------------- 클라이언트 IP · 속도 제한 ---------------- */

/** 속도 제한 키: IPv4는 그대로, IPv6는 /64 단위(주소를 바꿔 가며 우회하는 것 방지) */
export function rateKeyOf(ip: string): string {
  let s = (ip || 'unknown').trim().toLowerCase();
  const bracket = s.match(/^\[([^\]]+)\](:\d+)?$/);
  if (bracket) s = bracket[1];
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.replace(/:\d+$/, '');
  s = s.replace(/%.*$/, '');
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (!s.includes(':')) return s;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  let groups: string[];
  if (tail !== undefined) {
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = h;
  }
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

/**
 * 클라이언트 IP — 앞단 프록시 hops개를 믿는다(Express 'trust proxy = n'과 같은 방식).
 * 체인 = X-Forwarded-For 목록 + 소켓 주소, 오른쪽에서 hops번째 바로 앞이 클라이언트.
 * 프록시 없이 직접 노출하면 TRUST_PROXY_HOPS=0으로 둔다(아니면 클라이언트가 XFF를 꾸며 제한을 피할 수 있다).
 */
export function clientIp(req: Pick<FastifyRequest, 'headers' | 'raw' | 'ip'>, hops: number): string {
  const socketIp = req.raw?.socket?.remoteAddress ?? req.ip ?? 'unknown';
  if (hops <= 0) return socketIp;
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = [...list, socketIp];
  return chain[Math.max(0, chain.length - 1 - hops)];
}

/**
 * 고정 창 카운터 (프로세스 메모리). 만료된 키는 창마다 한 번 정리한다(타이머 없음).
 * 키 수 상한(maxKeys): 한 창 안에 주소를 바꿔 가며(예: IPv6 /48 안의 /64 6만여 개) 키를 쌓아 메모리를 키우는 것을 막는다.
 * 상한에 닿으면 만료 키를 먼저 지우고, 그래도 넘으면 가장 먼저 들어온 키부터 버린다(버려진 키는 새 창으로 다시 센다).
 */
export class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private nextSweep = 0;
  constructor(
    public readonly max: number,
    public readonly windowMs: number,
    private readonly now: () => number = Date.now,
    public readonly maxKeys = 200_000,
  ) {}

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    this.nextSweep = t + this.windowMs;
  }

  hit(key: string): { ok: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now();
    if (t >= this.nextSweep) this.sweep(t);
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      if (!e && this.hits.size >= this.maxKeys) {
        this.sweep(t);
        for (const k of this.hits.keys()) {
          if (this.hits.size < this.maxKeys) break;
          this.hits.delete(k);
        }
      }
      e = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.n++;
    return { ok: e.n <= this.max, remaining: Math.max(0, this.max - e.n), retryAfterSec: Math.max(1, Math.ceil((e.reset - t) / 1000)) };
  }

  get size(): number {
    return this.hits.size;
  }
}

/** app.ts genReqId와 같은 규칙 — 그래야 Fastify 로그의 reqId와 응답 헤더 x-request-id가 같은 값이 된다 */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** 이어 쓸 요청 id: 형식이 맞는 x-request-id → Fastify 요청 id(genReqId가 만든 값) → 새 UUID */
export function requestIdFor(req: { headers: Record<string, string | string[] | undefined>; id?: unknown }): string {
  const h = req.headers['x-request-id'];
  const incoming = Array.isArray(h) ? h[0] : h;
  if (typeof incoming === 'string' && REQUEST_ID.test(incoming)) return incoming;
  if (typeof req.id === 'string' && REQUEST_ID.test(req.id)) return req.id;
  return randomUUID();
}

/* ---------------- 레디니스 ---------------- */

export type ReadyStatus = 'ready' | 'degraded' | 'not_ready';
export type WorkerStatus = 'ok' | 'busy' | 'idle' | 'stale' | 'stalled' | 'no_activity' | 'no_scheduler' | 'unknown';

export interface WorkerCheck {
  ok: boolean;
  status: WorkerStatus;
  staleAfterMin: number;
  /** 예약 감지 잡이 이 시간(분) 동안 생기지 않으면 no_scheduler */
  schedulerStaleAfterMin: number;
  /** 워커 생존 신호 중 가장 최근 — 워커 하트비트 · 워커가 집거나 끝낸 잡 (DB CLI 'drain' 처리는 빼고 센다) */
  lastActivityAt: string | null;
  /** 끝난 잡 중 가장 최근 (누가 처리했든) */
  lastFinishedAt: string | null;
  /** 워커 프로세스 하트비트 중 가장 최근 (worker.ts가 60초마다 · 잡 상태 변화 트리거도 갱신) */
  lastHeartbeatAt: string | null;
  activityAgeSec: number | null;
  /** 예약 감지 잡(alerts.scan, trigger=schedule)이 마지막으로 생긴 시각 — 스케줄러 생존 신호 */
  lastScheduledAt: string | null;
  runningJobs: number;
  /** 실행 시각이 된 대기 잡 */
  queuedDue: number;
  /** 실행 시각이 5분 넘게 지난 대기 잡 */
  overdueJobs: number;
  /** 15분 넘게 잠긴 실행 중 잡 (워커 비정상 종료 · 멈춘 잡 — 살아 있는 워커가 1분 안에 회수한다) */
  stuckJobs: number;
  failedJobs24h: number;
  activeWorkspaces: number;
  /** cli = DB CLI(run-jobs · seed --run-jobs)가 남긴 기록 — 워커 생존 판정에 쓰지 않는다 */
  workers: { id: string; lastSeenAt: string; jobsSeen: number; lastJobType: string | null; cli: boolean }[];
  /** 판정 기준 (한국어) */
  basis: string;
  error?: string;
}

export interface ReadyReport {
  ok: boolean;
  status: ReadyStatus;
  version: string;
  time: string;
  /** full = 세부 항목 전부(내부망 · 토큰), summary = 판정만(외부) */
  detail?: 'full' | 'summary';
  checks: {
    db: { ok: boolean; latencyMs: number | null; error?: string };
    migrations: { ok: boolean; expected: number; applied: number; pending: string[]; unknownApplied: string[]; error?: string };
    worker: WorkerCheck;
  };
  /** 사람이 읽는 판정 근거 */
  notes: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${what} 시간 초과(${ms}ms)`)), ms);
    }),
  ]);
}

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === 'string' ? new Date(d).toISOString() : null);
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

const BUSY_GRACE_SEC = 300;
/** DB CLI(drain)의 잠금 이름 — jobs/queue.ts drain() 기본값 */
const CLI_WORKER_ID = 'drain';
/** 예약 감지 잡 — alerts 도메인이 10분마다 활성 워크스페이스마다 만든다 (§6 잡 계약 alerts.scan) */
const SCHEDULE_PROBE_TYPE = 'alerts.scan';

function emptyWorker(staleMin: number, schedulerStaleMin: number, basis: string, error?: string): WorkerCheck {
  return {
    ok: false, status: 'unknown', staleAfterMin: staleMin, schedulerStaleAfterMin: schedulerStaleMin,
    lastActivityAt: null, lastFinishedAt: null, lastHeartbeatAt: null, activityAgeSec: null, lastScheduledAt: null,
    runningJobs: 0, queuedDue: 0, overdueJobs: 0, stuckJobs: 0, failedJobs24h: 0, activeWorkspaces: 0, workers: [], basis,
    ...(error ? { error } : {}),
  };
}

const ms = (d: unknown): number | null => (d instanceof Date ? d.getTime() : typeof d === 'string' && d ? Date.parse(d) : null);
const maxMs = (...xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

async function checkWorker(db: Queryable, staleMin: number, schedulerStaleMin: number): Promise<WorkerCheck> {
  const basis =
    `워커 생존: 워커 프로세스가 60초마다 쓰는 하트비트(worker_heartbeats)나 워커가 잡을 집거나 끝낸 기록이 최근 ${staleMin}분 안에 있으면 정상. ` +
    `DB CLI(run-jobs)로 처리한 기록은 워커로 세지 않는다. 실행 시각이 5분 넘게 지난 대기 잡이 있는데 큐가 5분 넘게 움직이지 않으면 stalled ` +
    `(실행 중인 잡이 있고 하트비트가 살아 있으면 긴 잡 처리 중으로 보고 busy). ` +
    `스케줄러: 활성 워크스페이스가 있으면 예약 감지 잡(${SCHEDULE_PROBE_TYPE})이 10분마다 생기므로 ${schedulerStaleMin}분 동안 없으면 no_scheduler`;
  const base = emptyWorker(staleMin, schedulerStaleMin, basis);
  try {
    const s = await one<{
      last_finished: Date | null; last_worker_finished: Date | null; last_locked: Date | null; last_worker_locked: Date | null;
      running: number; stuck: number; queued_due: number; overdue: number; failed24h: number;
      last_scheduled: Date | null; active_ws: number; oldest_ws: Date | null; db_now: Date;
    }>(
      db,
      `SELECT
         (SELECT max(finished_at) FROM jobs WHERE finished_at IS NOT NULL) AS last_finished,
         (SELECT max(finished_at) FROM jobs WHERE finished_at IS NOT NULL AND locked_by IS NOT NULL AND split_part(locked_by, '#', 1) <> $1) AS last_worker_finished,
         (SELECT max(locked_at) FROM jobs WHERE status = 'running') AS last_locked,
         (SELECT max(locked_at) FROM jobs WHERE status = 'running' AND split_part(locked_by, '#', 1) <> $1) AS last_worker_locked,
         (SELECT count(*) FROM jobs WHERE status = 'running')::int AS running,
         (SELECT count(*) FROM jobs WHERE status = 'running' AND locked_at < now() - interval '15 minutes')::int AS stuck,
         (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at <= now())::int AS queued_due,
         (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at < now() - interval '5 minutes')::int AS overdue,
         -- 최종 실패만 센다: 워커가 실행하다 실패한 잡은 locked_by가 남는다. 대기 중 취소(커넥션 · 업로드 삭제)는 locked_by가 없다
         (SELECT count(*) FROM jobs WHERE status = 'failed' AND locked_by IS NOT NULL AND finished_at > now() - interval '24 hours')::int AS failed24h,
         (SELECT max(created_at) FROM jobs WHERE type = $2 AND payload->>'trigger' = 'schedule') AS last_scheduled,
         (SELECT count(*) FROM workspaces WHERE status = 'active')::int AS active_ws,
         (SELECT min(created_at) FROM workspaces WHERE status = 'active') AS oldest_ws,
         now() AS db_now`,
      [CLI_WORKER_ID, SCHEDULE_PROBE_TYPE],
    );
    let rows: { worker_id: string; first_seen_at: Date; last_seen_at: Date; jobs_seen: number; last_job_type: string | null }[] = [];
    try {
      rows = (await db.query<{ worker_id: string; first_seen_at: Date; last_seen_at: Date; jobs_seen: number; last_job_type: string | null }>(
        'SELECT worker_id, first_seen_at, last_seen_at, jobs_seen, last_job_type FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 20',
      )).rows;
    } catch {
      /* 520 마이그레이션 전: 하트비트 없이 jobs만으로 판정 */
    }
    const workers: WorkerCheck['workers'] = rows.map((w) => ({
      id: w.worker_id, lastSeenAt: iso(w.last_seen_at)!, jobsSeen: Number(w.jobs_seen), lastJobType: w.last_job_type, cli: w.worker_id === CLI_WORKER_ID,
    }));
    const nowMs = ms(s?.db_now) ?? Date.now();
    const age = (t: number | null) => (t === null ? null : Math.max(0, Math.round((nowMs - t) / 1000)));
    const staleSec = staleMin * 60;
    const real = rows.filter((w) => w.worker_id !== CLI_WORKER_ID);
    const lastBeat = maxMs(...real.map((w) => ms(w.last_seen_at)));
    const workerAct = maxMs(lastBeat, ms(s?.last_worker_finished), ms(s?.last_worker_locked));
    const progress = maxMs(ms(s?.last_finished), ms(s?.last_locked));
    const workerAge = age(workerAct);
    const beatAge = age(lastBeat);
    const progressAge = age(progress);
    const lastScheduled = ms(s?.last_scheduled);
    const out: WorkerCheck = {
      ...base,
      lastActivityAt: workerAct === null ? null : new Date(workerAct).toISOString(),
      lastFinishedAt: iso(s?.last_finished),
      lastHeartbeatAt: lastBeat === null ? null : new Date(lastBeat).toISOString(),
      activityAgeSec: workerAge,
      lastScheduledAt: lastScheduled === null ? null : new Date(lastScheduled).toISOString(),
      runningJobs: s?.running ?? 0,
      queuedDue: s?.queued_due ?? 0,
      overdueJobs: s?.overdue ?? 0,
      stuckJobs: s?.stuck ?? 0,
      failedJobs24h: s?.failed24h ?? 0,
      activeWorkspaces: s?.active_ws ?? 0,
      workers,
    };
    const workerFresh = workerAge !== null && workerAge <= staleSec;
    const beatFresh = beatAge !== null && beatAge <= staleSec;
    if (out.overdueJobs > 0) {
      const moving = progressAge !== null && progressAge <= BUSY_GRACE_SEC;
      const longJobs = out.runningJobs > 0 && out.runningJobs > out.stuckJobs && beatFresh;
      out.status = moving || longJobs ? 'busy' : 'stalled';
    } else if (workerFresh) {
      // 스케줄러: 가장 오래 산 워커(하트비트 첫 기록)와 가장 오래된 활성 워크스페이스가 판정 기간보다 오래됐을 때만 본다
      // (첫 배포 · 새 워크스페이스 직후 첫 예약 시각 전의 오탐 방지)
      const schedSec = schedulerStaleMin * 60;
      const upSince = Math.min(...real.filter((w) => (age(ms(w.last_seen_at)) ?? Infinity) <= staleSec).map((w) => ms(w.first_seen_at) ?? nowMs), nowMs);
      const wsSince = ms(s?.oldest_ws);
      const graceOver = (age(upSince) ?? 0) > schedSec && wsSince !== null && (age(wsSince) ?? 0) > schedSec;
      const scheduledAge = age(lastScheduled);
      out.status = out.activeWorkspaces > 0 && graceOver && (scheduledAge === null || scheduledAge > schedSec) ? 'no_scheduler' : 'ok';
    } else if (out.activeWorkspaces === 0) out.status = 'idle';
    else if (workerAct === null) out.status = 'no_activity';
    else out.status = 'stale';
    out.ok = out.status === 'ok' || out.status === 'busy' || out.status === 'idle';
    return out;
  } catch (e) {
    return { ...base, error: errMsg(e) };
  }
}

function workerNote(w: WorkerCheck): string | null {
  const min = w.activityAgeSec === null ? null : Math.round(w.activityAgeSec / 60);
  const cliOnly = w.workers.length > 0 && w.workers.every((x) => x.cli);
  switch (w.status) {
    case 'ok': return null;
    case 'busy': return `워커: 실행 시각이 5분 넘게 지난 대기 잡 ${w.overdueJobs}건 — 처리는 진행 중(실행 중 ${w.runningJobs}건)이라 밀린 상태로만 표시`;
    case 'idle': return '워커: 활성 워크스페이스가 없어 처리할 스케줄 잡이 없습니다 (생존 여부 판정 보류)';
    case 'stalled': return `워커: 실행 시각이 5분 넘게 지난 대기 잡 ${w.overdueJobs}건이 있고 최근 5분 동안 큐가 움직이지 않았습니다 — 워커 프로세스를 확인하세요`;
    case 'no_activity':
      return cliOnly
        ? '워커: 워커 프로세스 기록이 없습니다 (DB CLI run-jobs 처리 기록만 있음) — 워커(node server/dist/worker.mjs)를 실행하세요'
        : '워커: 워커 하트비트 · 잡 처리 기록이 한 번도 없습니다 — 워커가 실행 중인지 확인하세요';
    case 'stale': return `워커: 최근 ${w.staleAfterMin}분 동안 워커 하트비트 · 잡 처리 기록이 없습니다 (마지막 ${min}분 전)`;
    case 'no_scheduler':
      return `스케줄러: 워커는 살아 있지만 최근 ${w.schedulerStaleAfterMin}분 동안 예약 감지 잡(${SCHEDULE_PROBE_TYPE})이 생기지 않았습니다 — SCHEDULER=on인 워커가 하나는 있어야 예약 수집 · 감지 · SLA · 리포트가 돈다`;
    default: return `워커: 상태를 확인하지 못했습니다${w.error ? ` (${w.error})` : ''}`;
  }
}

/** 레디니스 판정 — DB · 마이그레이션 실패는 not_ready(503), 워커 이상은 degraded(200: API는 계속 서비스) */
export async function readiness(
  db: Queryable,
  opts: { workerStaleMin?: number; schedulerStaleMin?: number; version?: string; migrationsDir?: string; timeoutMs?: number } = {},
): Promise<ReadyReport> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const notes: string[] = [];
  const started = Date.now();
  const dbCheck: ReadyReport['checks']['db'] = { ok: false, latencyMs: null };
  try {
    await withTimeout(db.query('SELECT 1'), timeoutMs, 'DB 확인');
    dbCheck.ok = true;
    dbCheck.latencyMs = Date.now() - started;
  } catch (e) {
    dbCheck.error = errMsg(e);
    notes.push(`DB: 연결할 수 없습니다 (${dbCheck.error})`);
  }

  const mig: ReadyReport['checks']['migrations'] = { ok: false, expected: 0, applied: 0, pending: [], unknownApplied: [] };
  try {
    const dir = opts.migrationsDir ?? migrationsDir();
    const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    mig.expected = files.length;
    if (dbCheck.ok) {
      const applied = new Set(
        (await withTimeout(db.query<{ name: string }>('SELECT name FROM schema_migrations'), timeoutMs, '마이그레이션 확인')).rows.map((r) => r.name),
      );
      mig.applied = files.filter((f) => applied.has(f)).length;
      mig.pending = files.filter((f) => !applied.has(f));
      mig.unknownApplied = [...applied].filter((n) => !files.includes(n)).sort();
      mig.ok = mig.pending.length === 0;
      if (!mig.ok) notes.push(`마이그레이션: 적용되지 않은 파일 ${mig.pending.length}개 (${mig.pending.slice(0, 5).join(', ')}) — npm run db:migrate 또는 compose의 migrate 서비스`);
      if (mig.unknownApplied.length) notes.push(`마이그레이션: 코드에 없는 적용 기록 ${mig.unknownApplied.length}개 — 더 새 버전 DB에 옛 버전 앱이 붙었을 수 있습니다`);
    } else {
      mig.error = 'DB 연결 실패로 확인하지 못함';
    }
  } catch (e) {
    mig.error = errMsg(e);
    notes.push(`마이그레이션: 확인 실패 (${mig.error})`);
  }

  const staleMin = opts.workerStaleMin ?? 15;
  const schedulerStaleMin = opts.schedulerStaleMin ?? 25;
  const worker: WorkerCheck = dbCheck.ok
    ? await withTimeout(checkWorker(db, staleMin, schedulerStaleMin), timeoutMs, '워커 확인').catch((e) => emptyWorker(staleMin, schedulerStaleMin, '', errMsg(e)))
    : emptyWorker(staleMin, schedulerStaleMin, '', 'DB 연결 실패로 확인하지 못함');
  const wn = dbCheck.ok ? workerNote(worker) : null;
  if (wn) notes.push(wn);
  if (worker.stuckJobs > 0) notes.push(`잡: 15분 넘게 잠긴 실행 중 잡 ${worker.stuckJobs}건 — 살아 있는 워커가 회수해 다시 실행합니다 (계속 남으면 워커 확인)`);
  if (worker.failedJobs24h > 0) notes.push(`잡: 최근 24시간 최종 실패 ${worker.failedJobs24h}건 (docs/OPERATIONS.md '잡 실패 조회')`);

  const status: ReadyStatus = !dbCheck.ok || !mig.ok ? 'not_ready' : worker.ok ? 'ready' : 'degraded';
  return {
    ok: status !== 'not_ready',
    status,
    version: opts.version ?? process.env.APP_VERSION ?? '1.0.0',
    time: new Date().toISOString(),
    checks: { db: dbCheck, migrations: mig, worker },
    notes,
  };
}

/** 외부(공개) 응답: 판정만 남기고 워커 이름 · 워크스페이스 수 · 마이그레이션 파일명 · 오류 문구는 뺀다 */
export function summarizeReadiness(r: ReadyReport): ReadyReport {
  const w = r.checks.worker;
  return {
    ok: r.ok,
    status: r.status,
    version: r.version,
    time: r.time,
    detail: 'summary',
    checks: {
      db: { ok: r.checks.db.ok, latencyMs: null },
      // 파일 수 · 적용 수는 민감하지 않아 남긴다(0/0으로 오해하지 않게). 파일 이름 · 오류 문구는 뺀다
      migrations: { ok: r.checks.migrations.ok, expected: r.checks.migrations.expected, applied: r.checks.migrations.applied, pending: [], unknownApplied: [] },
      worker: { ...emptyWorker(w.staleAfterMin, w.schedulerStaleAfterMin, ''), ok: w.ok, status: w.status },
    },
    notes: r.status === 'ready' ? [] : ['세부 판정 근거는 내부망에서 조회하거나 x-ready-token 헤더(READY_TOKEN)를 붙여 조회하세요 (docs/OPERATIONS.md 모니터링)'],
  };
}

/* ---------------- 로그인 실패 잠금 ---------------- */

export interface LoginLockState {
  locked: boolean;
  /** account = 이 계정 전체 실패 기준, ip = 최근 성공한 IP라 그 IP의 실패만 센 경우 */
  scope: 'account' | 'ip';
  /** 판정에 쓴 실패 횟수 */
  failures: number;
  /** 이 계정 전체의 실패 횟수 (참고) */
  accountFailures: number;
  knownIp: boolean;
  retryAfterSec: number;
  /** 이 이메일의 가입 계정 id (없으면 null) — 잠금 감사 기록에 남긴다 */
  userId: string | null;
}

/** 로그인에 성공한 IP를 '익숙한 IP'로 보는 기간 */
const KNOWN_IP_DAYS = 30;

/**
 * 같은 이메일의 로그인 실패 잠금 판정 — 감사 로그(auth.login_failed · auth.login · auth.password_reset) 기준.
 *  - 실패는 창(windowMin) 안, 그리고 마지막 성공 로그인 · 비밀번호 재설정 뒤의 것만 센다(재설정 안내가 실제로 잠금을 푼다)
 *  - 이 IP가 최근 30일 안에 이 계정으로 로그인에 성공한 적이 있으면 그 IP에서 난 실패만 센다.
 *    다른 곳에서 실패를 쌓아도 본인이 평소 쓰는 곳에서는 로그인할 수 있다(잠금을 이용한 서비스 거부 완화).
 *    같은 IP에서의 대입 시도는 그대로 막힌다.
 *  - retryAfterSec: 실패 수가 max 아래로 내려가는 시각까지 (창에서 (n - max + 1)번째로 오래된 실패가 빠질 때)
 * ip는 이번 요청의 클라이언트 IP(clientIp, TRUST_PROXY_HOPS 기준). 감사 로그에 남은 ip(req.ip)와 같은 문자열일 때만 이어진다.
 */
export async function loginLockState(db: Queryable, email: string, ip: string | null, opts: { windowMin: number; max: number }): Promise<LoginLockState> {
  const r = await one<{ n: number; n_ip: number; known_ip: boolean; left_sec: number | null; left_ip_sec: number | null; user_id: string | null }>(
    db,
    `WITH u AS (SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1),
     since AS (
       SELECT greatest(
         now() - make_interval(mins => $2::int),
         coalesce((SELECT max(at) FROM audit_log WHERE action = 'auth.login' AND user_id = (SELECT id FROM u)), '-infinity'::timestamptz),
         coalesce((SELECT max(at) FROM audit_log WHERE action = 'auth.password_reset' AND user_id = (SELECT id FROM u)), '-infinity'::timestamptz)
       ) AS t
     ),
     f AS (
       SELECT at, ip FROM audit_log
        WHERE action = 'auth.login_failed' AND lower(actor) = lower($1) AND at > (SELECT t FROM since)
     ),
     fi AS (SELECT at FROM f WHERE ip IS NOT DISTINCT FROM $3::text)
     SELECT (SELECT id FROM u) AS user_id,
            (SELECT count(*) FROM f)::int AS n,
            (SELECT count(*) FROM fi)::int AS n_ip,
            ($3::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM audit_log WHERE action = 'auth.login' AND user_id = (SELECT id FROM u) AND ip = $3::text
                AND at > now() - make_interval(days => $5::int)
            )) AS known_ip,
            (SELECT ceil(extract(epoch FROM (at + make_interval(mins => $2::int) - now())))::int FROM f
              ORDER BY at OFFSET greatest(0, (SELECT count(*) FROM f) - $4::int) LIMIT 1) AS left_sec,
            (SELECT ceil(extract(epoch FROM (at + make_interval(mins => $2::int) - now())))::int FROM fi
              ORDER BY at OFFSET greatest(0, (SELECT count(*) FROM fi) - $4::int) LIMIT 1) AS left_ip_sec`,
    [email, opts.windowMin, ip, opts.max, KNOWN_IP_DAYS],
  );
  const accountFailures = r?.n ?? 0;
  const knownIp = !!r?.known_ip;
  const failures = knownIp ? r?.n_ip ?? 0 : accountFailures;
  const left = knownIp ? r?.left_ip_sec : r?.left_sec;
  return {
    locked: opts.max > 0 && failures >= opts.max,
    scope: knownIp ? 'ip' : 'account',
    failures,
    accountFailures,
    knownIp,
    retryAfterSec: Math.max(1, left ?? opts.windowMin * 60),
    userId: r?.user_id ?? null,
  };
}

/* ---------------- 플러그인 ---------------- */

/** 경로와 무관하게 모든 응답에 붙는 헤더 */
export function commonHeaders(hsts: boolean): [string, string][] {
  const h: [string, string][] = [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    ['permissions-policy', PERMISSIONS_POLICY],
    ['cross-origin-opener-policy', 'same-origin'],
    ['cross-origin-resource-policy', 'same-origin'],
    ['x-permitted-cross-domain-policies', 'none'],
  ];
  if (hsts) h.push(['strict-transport-security', HSTS]);
  return h;
}

/** 종료 중 끊는 AI 스트림에 보내는 마지막 이벤트 (src/ai/claude.ts가 error 이벤트의 message를 화면에 보여 준다) */
export const SHUTDOWN_AI_EVENT = `event: error\ndata: ${JSON.stringify({ code: 'server_restarting', message: '서버를 다시 시작하는 중이라 응답이 중단되었습니다. 잠시 후 다시 시도해 주세요' })}\n\n`;

export const securityPlugin = fp(async (app: FastifyInstance) => {
  const { config, db } = app.ctx;
  const opts = securityOptionsFromEnv(process.env, config.env);
  const csp = appCsp(opts.cspConnectExtra);
  const hsts = config.secureCookies;
  const apiLimiter = opts.apiRateMax > 0 ? new WindowLimiter(opts.apiRateMax, opts.apiRateWindowMs) : null;
  const authLimiter = opts.authRateMax > 0 ? new WindowLimiter(opts.authRateMax, 60_000) : null;
  const common = commonHeaders(hsts);
  /** 열린 SSE(/api/w/:ws/events) — 종료 시 바로 닫는다 */
  const streams = new Set<ServerResponse>();
  /** 진행 중인 AI 응답 스트림 — 종료 시 끝나기를 기다린 뒤 남은 것만 끊는다 */
  const aiStreams = new Set<ServerResponse>();
  const track = (set: Set<ServerResponse>, res: ServerResponse) => {
    set.add(res);
    res.once('close', () => set.delete(res));
  };

  app.decorateRequest('requestId', '');

  app.addHook('onRequest', async (req, reply) => {
    const rid = requestIdFor(req);
    req.requestId = rid;
    reply.header('x-request-id', rid);
    if (typeof req.log?.child === 'function') {
      // 이후 로그(라우트 · 오류 · Fastify의 'request completed')에 requestId가 붙는다
      const child = req.log.child({ requestId: rid });
      req.log = child;
      reply.log = child;
    }

    const path = routePath(req);
    if (!isApiPath(path)) return;
    // reply.hijack() 후 res.writeHead로 직접 쓰는 스트림 응답에도 보안 헤더 · 요청 id가 실리도록 원시 응답에 미리 넣는다.
    // 일반 응답은 Fastify가 writeHead할 때 같은 이름의 값으로 덮어쓰므로 중복되지 않는다.
    const raw = reply.raw;
    if (typeof raw?.setHeader === 'function' && !raw.headersSent) {
      raw.setHeader('x-request-id', rid);
      for (const [k, v] of common) raw.setHeader(k, v);
      raw.setHeader('content-security-policy', API_CSP);
    }
    if (req.method === 'GET' && path === SSE_ROUTE) {
      // SSE는 연결이 길어 속도 제한에서 뺀다 · 종료 시 정리할 수 있게 추적
      track(streams, raw);
      return;
    }
    if (req.method === 'POST' && path === AI_STREAM_ROUTE) track(aiStreams, raw);
    const key = rateKeyOf(clientIp(req, opts.proxyHops));
    if (apiLimiter) {
      const r = apiLimiter.hit(key);
      reply.header('x-ratelimit-limit', String(apiLimiter.max));
      reply.header('x-ratelimit-remaining', String(r.remaining));
      raw?.setHeader?.('x-ratelimit-limit', String(apiLimiter.max));
      raw?.setHeader?.('x-ratelimit-remaining', String(r.remaining));
      if (!r.ok) {
        reply.header('retry-after', String(r.retryAfterSec));
        throw new HttpError(429, 'rate_limited', `요청이 너무 많습니다. ${r.retryAfterSec}초 후 다시 시도해 주세요`);
      }
    }
    if (authLimiter && req.method === 'POST' && AUTH_WRITE_ROUTES.has(path)) {
      const r = authLimiter.hit(key);
      if (!r.ok) {
        reply.header('retry-after', String(r.retryAfterSec));
        throw new HttpError(429, 'rate_limited', `로그인 · 인증 요청이 너무 많습니다. ${r.retryAfterSec}초 후 다시 시도해 주세요`);
      }
    }
  });

  if (opts.loginFailMax > 0) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method !== 'POST' || routePath(req) !== LOGIN_ROUTE) return;
      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== 'string' || !email.trim() || email.length > 200) return; // 형식 오류는 라우트가 400으로 판정
      // 이번 요청의 IP는 TRUST_PROXY_HOPS 기준(꾸민 X-Forwarded-For 앞부분을 믿지 않음)으로 고른다.
      // app.ts의 Fastify trustProxy도 같은 홉 수를 쓰므로 감사 로그에 남는 req.ip와 같은 값이다(익숙한 IP 판정이 이어진다).
      const lock = await loginLockState(db, email.trim(), clientIp(req, opts.proxyHops) || null, { windowMin: opts.loginFailWindowMin, max: opts.loginFailMax });
      if (!lock.locked) return;
      const { failures, retryAfterSec } = lock;
      await audit(db, {
        // 가입된 계정이면 user_id를 남긴다 — 워크스페이스 감사 로그(auth=1: 구성원의 계정 기록)에 로그인 실패와 함께 보인다
        workspaceId: null, userId: lock.userId, actor: email.trim().slice(0, 200), action: 'auth.login_locked', ip: req.ip,
        detail: { failures, accountFailures: lock.accountFailures, scope: lock.scope, windowMin: opts.loginFailWindowMin, retryAfterSec },
      });
      reply.header('retry-after', String(retryAfterSec));
      const mins = Math.max(1, Math.ceil(retryAfterSec / 60));
      throw new HttpError(
        429,
        'login_locked',
        `로그인 실패가 ${opts.loginFailWindowMin}분 안에 ${opts.loginFailMax}회에 이르러 이 계정의 로그인을 잠시 막았습니다. 약 ${mins}분 뒤 다시 시도하거나 비밀번호 재설정을 이용해 주세요`,
        { retryAfterSec },
      );
    });
  }

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of common) reply.header(k, v);
    const path = routePath(req);
    if (isApiPath(path)) {
      reply.header('content-security-policy', API_CSP);
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    } else {
      reply.header('content-security-policy', csp);
      const ct = String(reply.getHeader('content-type') ?? '');
      const status = reply.statusCode;
      if ((status === 200 || status === 304) && HASHED_ASSET.test(path)) reply.header('cache-control', 'public, max-age=31536000, immutable');
      // 304(재검증 응답)에는 content-type이 없지만 브라우저는 304의 cache-control로 저장본의 유효 기간을 갱신한다.
      // 여기서 정적 플러그인 기본값(max-age=1h)이 나가면 배포 뒤 1시간 동안 옛 index.html(없어진 옛 자산을 가리킴)을 쓴다.
      else if (ct.startsWith('text/html') || status === 304) reply.header('cache-control', 'no-cache');
    }
    return payload;
  });

  if (opts.slowRequestMs > 0) {
    app.addHook('onResponse', async (req, reply) => {
      if (reply.elapsedTime >= opts.slowRequestMs) {
        // 경로는 라우트 패턴으로 남긴다(/api/invites/:token처럼 경로에 든 토큰이 로그에 남지 않게)
        req.log.warn({ requestId: req.requestId, method: req.method, route: routePath(req), statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) }, '느린 요청');
      }
    });
  }

  // 우아한 종료: 열린 스트림을 닫아야 server.close()가 끝난다 (Fastify는 종료 중 새 요청에 503을 준다).
  //  - SSE: 바로 닫는다. 브라우저 EventSource는 retry 뒤 다른(새) 인스턴스에 다시 붙는다.
  //  - AI 응답: 생성 중인 답을 버리지 않게 SHUTDOWN_STREAM_GRACE_MS까지 끝나기를 기다린다(끝나면 라우트가 사용량을 기록한다).
  //    그래도 남은 스트림은 error 이벤트(server_restarting)를 보내고 끊는다 → 라우트가 Anthropic 스트림을 중단하고 부분 사용량을 기록한다.
  //    compose의 app stop_grace_period(30s)가 이 값(기본 20s)보다 길어야 한다.
  app.addHook('preClose', async () => {
    for (const res of streams) {
      try {
        if (!res.writableEnded) {
          if (res.headersSent) res.write('retry: 3000\n\n');
          res.end();
        }
      } catch {
        /* 이미 끊긴 연결 */
      }
    }
    streams.clear();
    const open = () => [...aiStreams].filter((r) => !r.writableEnded && !r.destroyed);
    if (open().length === 0) return aiStreams.clear();
    const deadline = Date.now() + opts.shutdownStreamGraceMs;
    while (open().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const cut = open();
    for (const res of cut) {
      try {
        // 안내 이벤트가 소켓에 실린 뒤 끊는다(destroy는 버퍼에 남은 데이터를 버린다). end() 대신 destroy()라야
        // 라우트의 close 처리(writableFinished=false)가 Anthropic 스트림을 중단한다.
        if (res.headersSent) {
          await new Promise<void>((ok) => {
            const t = setTimeout(ok, 1000);
            res.write(SHUTDOWN_AI_EVENT, () => {
              clearTimeout(t);
              ok();
            });
          });
        }
      } catch {
        /* 이미 끊긴 연결 */
      }
      res.destroy();
    }
    aiStreams.clear();
    // 끊긴 라우트가 부분 사용량을 기록할 짧은 여유 (그 뒤 index.ts가 DB 풀을 닫는다)
    if (cut.length) await new Promise((r) => setTimeout(r, 500));
  });

  // 세부 항목(워커 이름 · 활성 워크스페이스 수 · 마이그레이션 파일명 · DB 오류 문구)은 내부망 · 토큰에만.
  // 외부 감시는 status만 보면 된다(HTTP 503 = not_ready).
  app.get('/api/ready', async (req, reply) => {
    const r = await readiness(db, { workerStaleMin: opts.workerStaleMin, schedulerStaleMin: opts.schedulerStaleMin });
    reply.status(r.status === 'not_ready' ? 503 : 200);
    const full = isInternalIp(clientIp(req, opts.proxyHops)) || tokenMatches(req.headers['x-ready-token'], opts.readyToken);
    return full ? { ...r, detail: 'full' } : summarizeReadiness(r);
  });
});
