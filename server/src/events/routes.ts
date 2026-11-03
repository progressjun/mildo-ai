/**
 * SSE: GET /api/w/:ws/events — 같은 워크스페이스의 변경 알림을 실시간으로 받는다.
 *
 * 연결할 때 한 번만 확인하면 그 뒤에 세션이 끝나거나(로그아웃 · 강제 종료 · 비밀번호 변경/재설정 · 만료) 계정이 비활성화되거나
 * 멤버십에서 제외돼도 스트림이 계속 열려 이벤트를 받는다. 그래서 스트림은 접근을 계속 다시 확인한다:
 *  - 접근 변경 신호(events/hub publishAccessChange — 세션 삭제 · 비활성화 · 제외 · 역할 변경)를 받으면 바로
 *  - 이벤트를 보내기 전에(직전 확인이 RECHECK_MS보다 오래됐으면) — 신호 없이 DB에서 직접 지운 세션도 이벤트를 받지 못한다
 *  - 연결 유지 ping마다(PING_MS) — 이벤트가 없어도 끊긴 세션의 스트림을 정리한다
 * 확인은 줄 세워(앞선 확인이 끝난 뒤 이벤트를 보냄) 접근이 끊긴 뒤의 이벤트는 전달되지 않는다. 유효하지 않으면(또는 확인 중
 * DB 오류) 스트림을 닫는다 — 브라우저가 다시 붙으면 401/404를 받고 화면이 세션 확인 · 로그인 화면으로 넘어간다(src/saas/events.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { one } from '../db/pool';
import { can, type Role } from '../auth/permissions';

/** 연결 유지 주석 줄 · 주기 확인 간격 */
export const PING_MS = 25_000;
/** 이벤트 직전 확인을 생략하는 최근 확인 유효 시간 (접근 변경 신호를 받으면 이 값과 무관하게 다시 확인) */
export const RECHECK_MS = 1_000;

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const { db, events } = app.ctx;

  /** 이 세션이 아직 유효하고 이 워크스페이스를 읽을 수 있는지 */
  const stillAllowed = async (sessionId: string, userId: string, wsId: string): Promise<boolean> => {
    const r = await one<{ role: Role }>(
      db,
      `SELECT m.role FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = $3
        WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > now() AND u.status = 'active'`,
      [sessionId, userId, wsId],
    );
    return !!r && can(r.role, 'read');
  };

  app.get('/w/:ws/events', async (req, reply) => {
    const c = await req.workspace('read');
    const wsId = c.workspace.id;
    const sessionId = c.session.id;
    const userId = c.user.id;
    const expiresAt = new Date(c.session.expiresAt).getTime();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ws: wsId, at: new Date().toISOString() })}\n\n`);

    let closed = false;
    let lastCheckAt = Date.now();
    let forceCheck = false;
    /** 확인 · 전송 줄 — 앞선 작업이 끝난 뒤에 다음 작업을 한다 */
    let chain: Promise<void> = Promise.resolve();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      off();
      offAccess();
    };
    const end = () => {
      cleanup();
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* 이미 끊긴 연결 */
      }
    };
    /** 접근 확인 — 유효하지 않으면 스트림을 닫고 false */
    const verify = async (): Promise<boolean> => {
      if (closed) return false;
      let ok = false;
      if (Date.now() < expiresAt) {
        try {
          ok = await stillAllowed(sessionId, userId, wsId);
        } catch {
          ok = false; // 확인할 수 없으면 닫는다 (다시 붙을 때 정상 경로로 판정)
        }
      }
      lastCheckAt = Date.now();
      forceCheck = false;
      if (!ok) end();
      return ok && !closed;
    };
    const enqueue = (task: () => Promise<void>) => {
      chain = chain.then(task).catch(() => end());
    };

    const off = events.subscribe(wsId, (evt) => {
      enqueue(async () => {
        if (closed) return;
        const stale = forceCheck || Date.now() - lastCheckAt >= RECHECK_MS || Date.now() >= expiresAt;
        if (stale && !(await verify())) return;
        if (!closed) res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      });
    });
    const offAccess = events.onAccessChange(userId, () => {
      forceCheck = true;
      enqueue(async () => {
        await verify();
      });
    });
    const ping = setInterval(() => {
      enqueue(async () => {
        if (!(await verify())) return;
        res.write(`: ping ${Date.now()}\n\n`);
      });
    }, PING_MS);
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
  });
};
