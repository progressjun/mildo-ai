/**
 * 워크스페이스 이벤트 — PostgreSQL NOTIFY('mildo_events')로 서버 · 워커 프로세스 간 전달,
 * API 서버가 SSE로 같은 워크스페이스 접속자에게 내보낸다. 트랜잭션 안에서 publish하면 커밋 시점에 전달된다.
 *
 * 접근 변경 신호 — NOTIFY('mildo_auth'), 본문 { userId }. 세션 종료(로그아웃 · 강제 종료 · 비밀번호 변경/재설정) ·
 * 계정 비활성화 · 멤버십 제외 · 역할 변경 때 보낸다. 열린 SSE(events/routes.ts)는 이 신호를 받으면 바로 세션 · 멤버십을
 * 다시 확인하고, 더는 유효하지 않으면 스트림을 닫는다. 워크스페이스 이벤트와 같은 연결로 커밋 순서대로 오므로
 * 접근이 끊긴 뒤의 이벤트는 그 확인이 끝나기 전에 전달되지 않는다(스트림이 이벤트를 확인 뒤에 줄 세운다).
 */
import type { Db, Queryable } from '../db/pool';

export type EventType = 'change' | 'incident' | 'comment' | 'dataset' | 'connection' | 'report' | 'config' | 'state' | 'member' | 'notify';
export interface WsEvent { type: EventType; id?: string; at?: string }

export const CHANNEL = 'mildo_events';
export const AUTH_CHANNEL = 'mildo_auth';

export async function publish(q: Queryable, workspaceId: string, evt: WsEvent): Promise<void> {
  const payload = JSON.stringify({ ws: workspaceId, ...evt, at: evt.at ?? new Date().toISOString() });
  await q.query('SELECT pg_notify($1, $2)', [CHANNEL, payload.slice(0, 7900)]);
}

/** 이 사용자의 세션 · 멤버십 · 계정 상태가 바뀌었다 (열린 SSE가 다시 확인하게) — 트랜잭션 안이면 커밋 시점에 전달된다 */
export async function publishAccessChange(q: Queryable, userId: string): Promise<void> {
  await q.query('SELECT pg_notify($1, $2)', [AUTH_CHANNEL, JSON.stringify({ userId })]);
}

type Listener = (evt: WsEvent & { ws: string }) => void;
type AccessListener = () => void;

export class EventHub {
  private listeners = new Map<string, Set<Listener>>();
  private accessListeners = new Map<string, Set<AccessListener>>();
  private client: Awaited<ReturnType<Db['connect']>> | null = null;
  constructor(private db: Db) {}

  async start(): Promise<void> {
    if (this.client) return;
    this.client = await this.db.connect();
    this.client.on('notification', (msg) => {
      if (msg.channel === AUTH_CHANNEL && msg.payload) {
        try {
          const { userId } = JSON.parse(msg.payload) as { userId?: string };
          if (typeof userId === 'string') {
            this.accessListeners.get(userId)?.forEach((fn) => {
              try { fn(); } catch { /* 구독자 오류 무시 */ }
            });
          }
        } catch { /* 잘못된 페이로드 무시 */ }
        return;
      }
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const evt = JSON.parse(msg.payload) as WsEvent & { ws: string };
        this.listeners.get(evt.ws)?.forEach((fn) => {
          try { fn(evt); } catch { /* 구독자 오류 무시 */ }
        });
      } catch { /* 잘못된 페이로드 무시 */ }
    });
    await this.client.query(`LISTEN ${CHANNEL}`);
    await this.client.query(`LISTEN ${AUTH_CHANNEL}`);
  }

  subscribe(workspaceId: string, fn: Listener): () => void {
    let set = this.listeners.get(workspaceId);
    if (!set) this.listeners.set(workspaceId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(workspaceId);
    };
  }

  /** 이 사용자의 접근 변경 신호 구독 (publishAccessChange) — 해제 함수를 돌려준다 */
  onAccessChange(userId: string, fn: AccessListener): () => void {
    let set = this.accessListeners.get(userId);
    if (!set) this.accessListeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.accessListeners.delete(userId);
    };
  }

  listenerCount(workspaceId: string): number {
    return this.listeners.get(workspaceId)?.size ?? 0;
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    try { await this.client.query(`UNLISTEN ${CHANNEL}`); await this.client.query(`UNLISTEN ${AUTH_CHANNEL}`); } catch { /* 연결 종료 중 */ }
    this.client.release();
    this.client = null;
  }
}
