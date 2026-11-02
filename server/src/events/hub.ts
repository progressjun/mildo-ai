/**
 * 워크스페이스 이벤트 — PostgreSQL NOTIFY('mildo_events')로 서버 · 워커 프로세스 간 전달,
 * API 서버가 SSE로 같은 워크스페이스 접속자에게 내보낸다. 트랜잭션 안에서 publish하면 커밋 시점에 전달된다.
 */
import type { Db, Queryable } from '../db/pool';

export type EventType = 'change' | 'incident' | 'comment' | 'dataset' | 'connection' | 'report' | 'config' | 'state' | 'member';
export interface WsEvent { type: EventType; id?: string; at?: string }

export const CHANNEL = 'mildo_events';

export async function publish(q: Queryable, workspaceId: string, evt: WsEvent): Promise<void> {
  const payload = JSON.stringify({ ws: workspaceId, ...evt, at: evt.at ?? new Date().toISOString() });
  await q.query('SELECT pg_notify($1, $2)', [CHANNEL, payload.slice(0, 7900)]);
}

type Listener = (evt: WsEvent & { ws: string }) => void;

export class EventHub {
  private listeners = new Map<string, Set<Listener>>();
  private client: Awaited<ReturnType<Db['connect']>> | null = null;
  constructor(private db: Db) {}

  async start(): Promise<void> {
    if (this.client) return;
    this.client = await this.db.connect();
    this.client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const evt = JSON.parse(msg.payload) as WsEvent & { ws: string };
        this.listeners.get(evt.ws)?.forEach((fn) => {
          try { fn(evt); } catch { /* 구독자 오류 무시 */ }
        });
      } catch { /* 잘못된 페이로드 무시 */ }
    });
    await this.client.query(`LISTEN ${CHANNEL}`);
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

  listenerCount(workspaceId: string): number {
    return this.listeners.get(workspaceId)?.size ?? 0;
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    try { await this.client.query(`UNLISTEN ${CHANNEL}`); } catch { /* 연결 종료 중 */ }
    this.client.release();
    this.client = null;
  }
}
