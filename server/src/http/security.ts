/**
 * 보안 · 운영 HTTP 계층 (devops 도메인 소유). buildApp()이 쿠키 · rate-limit 플러그인 다음, 인증 플러그인 앞에 등록한다.
 *
 *  - 보안 헤더: CSP(앱 화면 · API 따로) · nosniff · X-Frame-Options · Referrer-Policy · Permissions-Policy ·
 *    Cross-Origin-Opener-Policy · Cross-Origin-Resource-Policy · HSTS(config.secureCookies일 때) · API 응답 no-store
 *  - 정적 파일 캐시: index.html은 no-cache(배포 직후 옛 화면 방지), 해시가 붙은 /assets/*는 1년 immutable
 *  - 요청 id: 프록시가 준 x-request-id를 이어 쓰거나 새로 만든다 → 응답 헤더 · 요청 로그(requestId)에 남긴다
 *  - 전역 속도 제한: /api 아래 클라이언트 IP당 분당 600회(SSE 제외), 로그인 · 비밀번호 재설정 · 초대 수락은 IP당 분당 20회
 *  - 로그인 실패 잠금: 같은 이메일로 15분 안에 10회 실패하면 잠시 막는다(감사 로그 기반이라 서버 여러 대여도 같은 기준).
 *    성공 로그인 · 비밀번호 재설정 뒤에는 새로 센다. 최근 30일 안에 이 계정으로 로그인에 성공한 IP는
 *    그 IP에서 난 실패만 센다(다른 곳에서 일부러 실패를 쌓아 본인을 잠그는 공격 완화)
 *  - 경로 판정은 라우터가 고른 경로(routeOptions.url)로 한다 — /%61pi/… · /api/auth/login#… 같은 인코딩 우회 차단
 *  - GET /api/ready: DB 연결 · 마이그레이션 적용 · 워커 하트비트(520_ops_heartbeat.sql) → ready / degraded / not_ready.
 *    세부 항목(워커 이름 · 워크스페이스 수 · 오류 문구)은 내부망 IP 또는 READY_TOKEN 헤더에만 보여 준다
 *  - 우아한 종료: 서버를 닫을 때(preClose) 열린 SSE 연결을 정리해 app.close()가 멈추지 않게 한다
 *
 * 선택 환경변수 (config.ts를 바꾸지 않고 이 파일에서만 읽는다. 값은 앱을 만들 때 한 번 읽는다):
 *   API_RATE_LIMIT_MAX(600) · API_RATE_LIMIT_WINDOW_SEC(60) · AUTH_RATE_LIMIT_MAX(20)
 *   LOGIN_FAIL_MAX(10) · LOGIN_FAIL_WINDOW_MIN(15) · TRUST_PROXY_HOPS(1)
 *   CSP_CONNECT_SRC_EXTRA(빈 값, 공백 구분 출처) · READY_WORKER_STALE_MIN(15) · SLOW_REQUEST_MS(3000)
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
  slowRequestMs: number;
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
    slowRequestMs: intEnv(env, 'SLOW_REQUEST_MS', 3000),
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

/** 고정 창 카운터 (프로세스 메모리). 만료된 키는 창마다 한 번 정리한다(타이머 없음). */
export class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private nextSweep = 0;
  constructor(public readonly max: number, public readonly windowMs: number, private readonly now: () => number = Date.now) {}

  hit(key: string): { ok: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now();
    if (t >= this.nextSweep) {
      for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
      this.nextSweep = t + this.windowMs;
    }
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
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

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/* ---------------- 레디니스 ---------------- */

export type ReadyStatus = 'ready' | 'degraded' | 'not_ready';
export type WorkerStatus = 'ok' | 'busy' | 'idle' | 'stale' | 'stalled' | 'no_activity' | 'unknown';

export interface WorkerCheck {
  ok: boolean;
  status: WorkerStatus;
  staleAfterMin: number;
  lastActivityAt: string | null;
  lastFinishedAt: string | null;
  lastHeartbeatAt: string | null;
  activityAgeSec: number | null;
  runningJobs: number;
  /** 실행 시각이 된 대기 잡 */
  queuedDue: number;
  /** 실행 시각이 5분 넘게 지난 대기 잡 */
  overdueJobs: number;
  failedJobs24h: number;
  activeWorkspaces: number;
  workers: { id: string; lastSeenAt: string; jobsSeen: number; lastJobType: string | null }[];
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

async function checkWorker(db: Queryable, staleMin: number): Promise<WorkerCheck> {
  const basis = `활성 워크스페이스가 있으면 스케줄 잡이 10분 간격으로 생긴다. 최근 ${staleMin}분 안에 잡을 집거나 끝낸 기록(jobs · worker_heartbeats)이 없으면 워커가 멈춘 것으로 본다`;
  const base: WorkerCheck = {
    ok: false, status: 'unknown', staleAfterMin: staleMin, lastActivityAt: null, lastFinishedAt: null, lastHeartbeatAt: null, activityAgeSec: null,
    runningJobs: 0, queuedDue: 0, overdueJobs: 0, failedJobs24h: 0, activeWorkspaces: 0, workers: [], basis,
  };
  try {
    const s = await one<{
      last_finished: Date | null; last_locked: Date | null; running: number; queued_due: number; overdue: number; failed24h: number; active_ws: number; db_now: Date;
    }>(
      db,
      `SELECT
         (SELECT max(finished_at) FROM jobs WHERE finished_at IS NOT NULL) AS last_finished,
         (SELECT max(locked_at) FROM jobs WHERE status = 'running') AS last_locked,
         (SELECT count(*) FROM jobs WHERE status = 'running')::int AS running,
         (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at <= now())::int AS queued_due,
         (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at < now() - interval '5 minutes')::int AS overdue,
         -- 최종 실패만 센다: 워커가 실행하다 실패한 잡은 locked_by가 남는다. 대기 중 취소(커넥션 · 업로드 삭제)는 locked_by가 없다
         (SELECT count(*) FROM jobs WHERE status = 'failed' AND locked_by IS NOT NULL AND finished_at > now() - interval '24 hours')::int AS failed24h,
         (SELECT count(*) FROM workspaces WHERE status = 'active')::int AS active_ws,
         now() AS db_now`,
    );
    let workers: WorkerCheck['workers'] = [];
    try {
      workers = (await db.query<{ worker_id: string; last_seen_at: Date; jobs_seen: number; last_job_type: string | null }>(
        'SELECT worker_id, last_seen_at, jobs_seen, last_job_type FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 10',
      )).rows.map((w) => ({ id: w.worker_id, lastSeenAt: iso(w.last_seen_at)!, jobsSeen: Number(w.jobs_seen), lastJobType: w.last_job_type }));
    } catch {
      /* 520 마이그레이션 전: 하트비트 없이 jobs만으로 판정 */
    }
    const nowMs = (s?.db_now instanceof Date ? s.db_now : new Date()).getTime();
    const lastHeartbeat = workers[0] ? Date.parse(workers[0].lastSeenAt) : null;
    const candidates = [s?.last_finished, s?.last_locked].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
    if (lastHeartbeat !== null) candidates.push(lastHeartbeat);
    const last = candidates.length ? Math.max(...candidates) : null;
    const age = last === null ? null : Math.max(0, Math.round((nowMs - last) / 1000));
    const out: WorkerCheck = {
      ...base,
      lastActivityAt: last === null ? null : new Date(last).toISOString(),
      lastFinishedAt: iso(s?.last_finished),
      lastHeartbeatAt: lastHeartbeat === null ? null : new Date(lastHeartbeat).toISOString(),
      activityAgeSec: age,
      runningJobs: s?.running ?? 0,
      queuedDue: s?.queued_due ?? 0,
      overdueJobs: s?.overdue ?? 0,
      failedJobs24h: s?.failed24h ?? 0,
      activeWorkspaces: s?.active_ws ?? 0,
      workers,
    };
    const fresh = age !== null && age <= staleMin * 60;
    if (out.overdueJobs > 0 && !(age !== null && age <= BUSY_GRACE_SEC)) out.status = 'stalled';
    else if (out.overdueJobs > 0) out.status = 'busy';
    else if (fresh) out.status = 'ok';
    else if (out.activeWorkspaces === 0) out.status = 'idle';
    else if (last === null) out.status = 'no_activity';
    else out.status = 'stale';
    out.ok = out.status === 'ok' || out.status === 'busy' || out.status === 'idle';
    return out;
  } catch (e) {
    return { ...base, error: errMsg(e) };
  }
}

function workerNote(w: WorkerCheck): string | null {
  const min = w.activityAgeSec === null ? null : Math.round(w.activityAgeSec / 60);
  switch (w.status) {
    case 'ok': return null;
    case 'busy': return `워커: 실행 시각이 5분 넘게 지난 대기 잡 ${w.overdueJobs}건 — 처리는 진행 중(최근 활동 ${min}분 전)이라 밀린 상태로만 표시`;
    case 'idle': return '워커: 활성 워크스페이스가 없어 처리할 스케줄 잡이 없습니다 (생존 여부 판정 보류)';
    case 'stalled': return `워커: 실행 시각이 5분 넘게 지난 대기 잡 ${w.overdueJobs}건이 있고 최근 5분 처리 기록이 없습니다 — 워커 프로세스를 확인하세요`;
    case 'no_activity': return '워커: 잡을 처리한 기록이 한 번도 없습니다 — 워커가 실행 중인지 확인하세요';
    case 'stale': return `워커: 최근 ${w.staleAfterMin}분 동안 잡 처리 기록이 없습니다 (마지막 활동 ${min}분 전)`;
    default: return `워커: 상태를 확인하지 못했습니다${w.error ? ` (${w.error})` : ''}`;
  }
}

/** 레디니스 판정 — DB · 마이그레이션 실패는 not_ready(503), 워커 이상은 degraded(200: API는 계속 서비스) */
export async function readiness(db: Queryable, opts: { workerStaleMin?: number; version?: string; migrationsDir?: string; timeoutMs?: number } = {}): Promise<ReadyReport> {
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
  const worker: WorkerCheck = dbCheck.ok
    ? await withTimeout(checkWorker(db, staleMin), timeoutMs, '워커 확인').catch((e) => ({
        ok: false, status: 'unknown' as const, staleAfterMin: staleMin, lastActivityAt: null, lastFinishedAt: null, lastHeartbeatAt: null, activityAgeSec: null,
        runningJobs: 0, queuedDue: 0, overdueJobs: 0, failedJobs24h: 0, activeWorkspaces: 0, workers: [], basis: '', error: errMsg(e),
      }))
    : {
        ok: false, status: 'unknown', staleAfterMin: staleMin, lastActivityAt: null, lastFinishedAt: null, lastHeartbeatAt: null, activityAgeSec: null,
        runningJobs: 0, queuedDue: 0, overdueJobs: 0, failedJobs24h: 0, activeWorkspaces: 0, workers: [], basis: '', error: 'DB 연결 실패로 확인하지 못함',
      };
  const wn = dbCheck.ok ? workerNote(worker) : null;
  if (wn) notes.push(wn);
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
      worker: {
        ok: w.ok, status: w.status, staleAfterMin: w.staleAfterMin, lastActivityAt: null, lastFinishedAt: null, lastHeartbeatAt: null, activityAgeSec: null,
        runningJobs: 0, queuedDue: 0, overdueJobs: 0, failedJobs24h: 0, activeWorkspaces: 0, workers: [], basis: '',
      },
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
  const r = await one<{ n: number; n_ip: number; known_ip: boolean; left_sec: number | null; left_ip_sec: number | null }>(
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
     SELECT (SELECT count(*) FROM f)::int AS n,
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
  };
}

/* ---------------- 플러그인 ---------------- */

export const securityPlugin = fp(async (app: FastifyInstance) => {
  const { config, db } = app.ctx;
  const opts = securityOptionsFromEnv(process.env, config.env);
  const csp = appCsp(opts.cspConnectExtra);
  const hsts = config.secureCookies;
  const apiLimiter = opts.apiRateMax > 0 ? new WindowLimiter(opts.apiRateMax, opts.apiRateWindowMs) : null;
  const authLimiter = opts.authRateMax > 0 ? new WindowLimiter(opts.authRateMax, 60_000) : null;
  const streams = new Set<ServerResponse>();

  app.decorateRequest('requestId', '');

  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const rid = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
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
    if (req.method === 'GET' && path === SSE_ROUTE) {
      // SSE는 연결이 길어 속도 제한에서 뺀다 · 종료 시 정리할 수 있게 추적
      const res = reply.raw;
      streams.add(res);
      res.once('close', () => streams.delete(res));
      return;
    }
    const key = rateKeyOf(clientIp(req, opts.proxyHops));
    if (apiLimiter) {
      const r = apiLimiter.hit(key);
      reply.header('x-ratelimit-limit', String(apiLimiter.max));
      reply.header('x-ratelimit-remaining', String(r.remaining));
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
      // 감사 로그의 ip(req.ip, trustProxy=true라 XFF 맨 앞 값)와 다르면 '익숙한 IP'로 인정되지 않을 뿐(계정 기준으로 셈) 우회는 안 된다.
      const lock = await loginLockState(db, email.trim(), clientIp(req, opts.proxyHops) || null, { windowMin: opts.loginFailWindowMin, max: opts.loginFailMax });
      if (!lock.locked) return;
      const { failures, retryAfterSec } = lock;
      await audit(db, {
        workspaceId: null, userId: null, actor: email.trim().slice(0, 200), action: 'auth.login_locked', ip: req.ip,
        detail: { failures, accountFailures: lock.accountFailures, scope: lock.scope, windowMin: opts.loginFailWindowMin, retryAfterSec },
      });
      reply.header('retry-after', String(retryAfterSec));
      const mins = Math.max(1, Math.ceil(retryAfterSec / 60));
      throw new HttpError(
        429,
        'login_locked',
        `로그인 실패가 ${opts.loginFailWindowMin}분 안에 ${opts.loginFailMax}회를 넘어 이 계정의 로그인을 잠시 막았습니다. 약 ${mins}분 뒤 다시 시도하거나 비밀번호 재설정을 이용해 주세요`,
        { retryAfterSec },
      );
    });
  }

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', PERMISSIONS_POLICY);
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('x-permitted-cross-domain-policies', 'none');
    if (hsts) reply.header('strict-transport-security', HSTS);
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

  // 우아한 종료: 열린 SSE를 닫아야 server.close()가 끝난다. 브라우저 EventSource는 retry 뒤 다시 붙는다.
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
  });

  // 세부 항목(워커 이름 · 활성 워크스페이스 수 · 마이그레이션 파일명 · DB 오류 문구)은 내부망 · 토큰에만.
  // 외부 감시는 status만 보면 된다(HTTP 503 = not_ready).
  app.get('/api/ready', async (req, reply) => {
    const r = await readiness(db, { workerStaleMin: opts.workerStaleMin });
    reply.status(r.status === 'not_ready' ? 503 : 200);
    const full = isInternalIp(clientIp(req, opts.proxyHops)) || tokenMatches(req.headers['x-ready-token'], opts.readyToken);
    return full ? { ...r, detail: 'full' } : summarizeReadiness(r);
  });
});
