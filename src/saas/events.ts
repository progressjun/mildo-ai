/**
 * 실시간 이벤트 (서버 모드) — GET /api/w/:ws/events (SSE, EventSource).
 * 이벤트 이름 = type(change · incident · comment · dataset · state · config · member · connection · report), data = { ws, type, id?, at }.
 * 연결이 끊기면 지수 백오프로 다시 붙고(1 · 2 · 4 … 30초), 다시 붙으면 놓친 변경을 메우려고 목록을 다시 불러온다.
 * 같은 대상의 이벤트가 몰리면 300ms 디바운스로 한 번만 다시 불러온다.
 *
 * 다른 화면(관리 모듈 등)은 onServerEvent(type, fn)로 같은 이벤트를 받는다 (연결은 스토어 동기화가 하나만 연다).
 */
import { backoffDelay, SERVER_EVENT_TYPES } from './sync';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
export interface ServerEventData { ws?: string; type: string; id?: string; at?: string }

interface EventSourceLike {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  close(): void;
  onerror: ((e: Event) => void) | null;
  onopen?: ((e: Event) => void) | null;
}
export type EventSourceCtor = new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;

export interface ServerEventsOptions {
  url: string;
  onEvent: (e: ServerEventData) => void;
  onStatus?: (s: ConnStatus, info: { attempt: number; retryInMs?: number }) => void;
  /** 끊겼다가 다시 연결됨 (첫 연결 제외) */
  onReconnected?: () => void;
  /** 연결 오류 — 세션 만료 확인 등 */
  onError?: (attempt: number) => void;
  EventSourceImpl?: EventSourceCtor;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  rand?: () => number;
  /** 이 횟수 연속 실패 후 'offline'으로 표시 (재시도는 계속) */
  offlineAfter?: number;
}

export class ServerEvents {
  private es: EventSourceLike | null = null;
  private attempt = 0;
  private everConnected = false;
  private timer: unknown = null;
  private stopped = false;
  status: ConnStatus = 'connecting';
  lastEventAt: string | null = null;

  constructor(private o: ServerEventsOptions) {}

  private setStatus(s: ConnStatus, retryInMs?: number) {
    this.status = s;
    this.o.onStatus?.(s, { attempt: this.attempt, retryInMs });
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const Impl = this.o.EventSourceImpl ?? (typeof EventSource !== 'undefined' ? (EventSource as unknown as EventSourceCtor) : null);
    if (!Impl) {
      this.setStatus('offline');
      return;
    }
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    let es: EventSourceLike;
    try {
      es = new Impl(this.o.url, { withCredentials: true });
    } catch {
      this.scheduleRetry();
      return;
    }
    this.es = es;
    const connected = () => {
      if (this.es !== es) return;
      const wasConnected = this.everConnected;
      const recovering = this.attempt > 0 || this.status !== 'live';
      this.attempt = 0;
      this.everConnected = true;
      if (this.status !== 'live') this.setStatus('live');
      if (wasConnected && recovering) this.o.onReconnected?.();
    };
    es.addEventListener('hello', () => connected());
    for (const type of SERVER_EVENT_TYPES) {
      es.addEventListener(type, (m: MessageEvent) => {
        if (this.es !== es) return;
        if (this.status !== 'live') connected();
        let data: ServerEventData = { type };
        try {
          const parsed = JSON.parse(String(m.data ?? '{}')) as Partial<ServerEventData>;
          data = { ...parsed, type };
        } catch {
          /* 본문 없는 이벤트 — 종류만으로 처리 */
        }
        this.lastEventAt = data.at ?? new Date().toISOString();
        this.o.onEvent(data);
      });
    }
    es.onerror = () => {
      if (this.es !== es) return;
      // 브라우저 기본 재연결에 맡기지 않고 닫은 뒤 백오프로 다시 연다 (서버가 401/404를 주면 기본 재연결은 영영 멈춘다)
      es.close();
      this.es = null;
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = backoffDelay(this.attempt, this.o.rand);
    this.setStatus(this.attempt >= (this.o.offlineAfter ?? 4) ? 'offline' : 'reconnecting', delay);
    this.o.onError?.(this.attempt);
    const setT = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = setT(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  /** 지금 바로 다시 연결 (사용자가 연결 표시를 눌렀을 때) */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.timer !== null) (this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.es?.close();
    this.es = null;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.es?.close();
    this.es = null;
  }
}

/** 대상별 디바운스 실행기 — 같은 대상 요청이 delay 안에 여러 번 오면 마지막 뒤 한 번만 run */
export function createRefetchScheduler<T extends string>(
  run: (target: T) => void | Promise<unknown>,
  delayMs = 300,
  timers: { set?: (fn: () => void, ms: number) => unknown; clear?: (h: unknown) => void } = {},
) {
  const setT = timers.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = timers.clear ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<T, unknown>();
  return {
    schedule(target: T) {
      const prev = pending.get(target);
      if (prev !== undefined) clearT(prev);
      pending.set(target, setT(() => {
        pending.delete(target);
        void run(target);
      }, delayMs));
    },
    pending: () => [...pending.keys()],
    cancelAll() {
      pending.forEach((h) => clearT(h));
      pending.clear();
    },
  };
}

/* ---------- 다른 화면용 이벤트 구독 ---------- */

type Listener = (e: ServerEventData) => void;
const listeners = new Map<string, Set<Listener>>();

/** 서버 이벤트 구독 ('*'는 전부) — 해제 함수를 돌려준다. 데모 모드에서는 아무 이벤트도 오지 않는다 */
export function onServerEvent(type: string, fn: Listener): () => void {
  let set = listeners.get(type);
  if (!set) listeners.set(type, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

export function emitServerEvent(e: ServerEventData): void {
  for (const key of [e.type, '*']) {
    listeners.get(key)?.forEach((fn) => {
      try { fn(e); } catch { /* 구독자 오류 무시 */ }
    });
  }
}

/* ---------- 연결 상태 (상단 바 표시용 전역 값) ---------- */

export interface ConnInfo { status: ConnStatus | 'off'; lastEventAt: string | null; retryInMs?: number; attempt: number }
let conn: ConnInfo = { status: 'off', lastEventAt: null, attempt: 0 };
const connSubs = new Set<() => void>();
export function getConnInfo(): ConnInfo {
  return conn;
}
export function setConnInfo(patch: Partial<ConnInfo>): void {
  conn = { ...conn, ...patch };
  connSubs.forEach((f) => f());
}
export function subscribeConn(fn: () => void): () => void {
  connSubs.add(fn);
  return () => {
    connSubs.delete(fn);
  };
}
let reconnectHandler: (() => void) | null = null;
export function setReconnectHandler(fn: (() => void) | null): void {
  reconnectHandler = fn;
}
export function requestReconnect(): void {
  reconnectHandler?.();
}
