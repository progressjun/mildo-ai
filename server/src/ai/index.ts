/**
 * ai 도메인 진입점 (docs/SAAS_SPEC.md §4 ai · §6 ai) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 *   POST /api/w/:ws/ai/messages  (request)  본문 { messages, tools?, maxTokens?, purpose?, tier? } → SSE
 *        event: text      data: { delta }
 *        event: tool_use  data: { id, name, input }            (stop_reason이 tool_use일 때만, done 직전)
 *        event: done      data: { stopReason, usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }, content, model }
 *        event: error     data: { code, message }               (스트림 시작 뒤 오류 — 한국어 메시지)
 *      스트림 시작 전 오류는 일반 JSON 오류 응답: 401 · 403(권한 · ai_disabled · csrf) · 404(멤버 아님) · 423(잠긴 워크스페이스) ·
 *      400(형식 · too_many_tools) · 413(prompt_too_large) · 429(budget_exceeded · rate_limited) · 503(ai_not_configured)
 *   GET  /api/w/:ws/ai/usage?month=YYYY-MM  (read)  → { month, inputTokens, outputTokens, limit, byPurpose, ... }
 *
 * 한 요청은 모델 한 라운드다. 도구는 프런트(src/ai/claude.ts)가 실행하고 tool_result를 붙여 다시 호출한다.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { JobRegistry } from '../domains';
import { HttpError } from '../lib/errors';
import { parseBody, z } from '../lib/validate';
import { can } from '../auth/permissions';
import {
  AI_SERVER_ERRORS,
  aiEnabled,
  assertBudget,
  buildStreamParams,
  getAiClient,
  kstMonth,
  parseAiRequest,
  recordUsage,
  runRound,
  usageSummary,
  type AiEvent,
  type RoundResult,
} from './service';

/** SSE 연결 유지용 주석 줄 간격 — adaptive thinking 동안 텍스트가 한동안 오지 않을 수 있다 */
const PING_MS = 15_000;

const UsageQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM 형식').optional() });

export const routes: FastifyPluginAsync = async (app) => {
  app.post(
    '/w/:ws/ai/messages',
    {
      // 사용자별 분당 호출 상한 (도구 루프 한 번이 최대 8라운드)
      config: { rateLimit: { max: 40, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `ai:${req.session?.user.id ?? req.ip}` } },
    },
    async (req, reply) => {
      const c = await req.workspace('request');
      const cfg = app.ctx.config;
      if (!cfg.anthropicApiKey) throw new HttpError(503, 'ai_not_configured', AI_SERVER_ERRORS.ai_not_configured);
      if (!aiEnabled(c.workspace.config)) throw new HttpError(403, 'ai_disabled', AI_SERVER_ERRORS.ai_disabled);
      const body = parseAiRequest(req.body);
      await assertBudget(app.ctx.db, c);

      const model = cfg.anthropicModel;
      const params = buildStreamParams(body, model);
      const client = getAiClient(cfg.anthropicApiKey);
      const ctl = new AbortController();

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      let open = true;
      res.on('close', () => {
        open = false;
        // 응답을 다 쓰기 전에 연결이 끊기면(중지 버튼 · 화면 이탈) Anthropic 스트림도 끊어 토큰을 아낀다
        if (!res.writableFinished) ctl.abort();
      });
      const send = (e: AiEvent) => {
        if (!open || res.writableEnded) return;
        res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      };
      const ping = setInterval(() => {
        if (open && !res.writableEnded) res.write(`: ping\n\n`);
      }, PING_MS);

      let result: RoundResult;
      try {
        result = await runRound(client, params, ctl.signal, send);
      } finally {
        clearInterval(ping);
      }
      try {
        await recordUsage(app.ctx.db, { workspaceId: c.workspace.id, userId: c.user.id, model, purpose: body.purpose ?? 'general', result });
      } catch (err) {
        // 기록 실패는 응답을 막지 않는다 — 메시지 내용은 남기지 않는다
        req.log.error({ ws: c.workspace.id, err: (err as Error)?.message }, 'ai usage record failed');
      }
      if (result.status === 'error') {
        req.log.warn({ ws: c.workspace.id, code: result.errorCode, requestId: result.requestId }, 'ai upstream error');
      }
      if (!res.writableEnded) res.end();
    },
  );

  app.get('/w/:ws/ai/usage', async (req) => {
    const c = await req.workspace('read');
    const q = parseBody(UsageQuery, req.query);
    const cfg = app.ctx.config;
    const summary = await usageSummary(app.ctx.db, c, {
      month: q.month ?? kstMonth(),
      model: cfg.anthropicModel,
      configured: Boolean(cfg.anthropicApiKey),
      // 읽기 전용(잠긴) 워크스페이스는 POST가 423이므로 호출할 수 없다
      canUse: can(c.role, 'request') && c.workspace.status === 'active',
      includeUsers: can(c.role, 'configure'),
    });
    return { ...summary, available: summary.configured && summary.enabled && summary.canUse };
  });
};

/** ai 도메인은 예약 잡이 없다 (사용량은 호출 시점에 기록 · 한도는 호출 전에 판정) — §6 잡 계약에 ai 항목 없음 */
export function jobs(_reg: JobRegistry): void {
  /* 없음 */
}
