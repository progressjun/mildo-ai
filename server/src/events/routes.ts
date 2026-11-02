/** SSE: GET /api/w/:ws/events — 같은 워크스페이스의 변경 알림을 실시간으로 받는다 */
import type { FastifyPluginAsync } from 'fastify';

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/w/:ws/events', async (req, reply) => {
    const c = await req.workspace('read');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ws: c.workspace.id, at: new Date().toISOString() })}\n\n`);
    const off = app.ctx.events.subscribe(c.workspace.id, (evt) => {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
};
