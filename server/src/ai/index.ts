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
 *   GET  /api/w/:ws/ai/usage?month=YYYY-MM  (read)  → { month, inputTokens, outputTokens, limit, byPurpose, ..., available, unavailableReason, browserDirect }
 *        available = 지금 이 사용자가 서버 AI를 호출할 수 있는지(키 설정 · AI 켜짐 · request 권한 · 잠기지 않음 · 이번 달 한도 안).
 *        unavailableReason = 못 쓰는 첫 사유 코드(ai_not_configured · ai_disabled · workspace_locked · forbidden · budget_exceeded) 또는 null —
 *        화면이 '규칙 엔진 (AI 미연결)' 대신 실제 사유를 보여 준다.
 *        browserDirect = 이 서버의 CSP connect-src가 https://api.anthropic.com을 허용하는지(CSP_CONNECT_SRC_EXTRA) — 아니면 설정의
 *        'API 키'(브라우저 직접 호출) 방식은 브라우저가 막으므로 화면이 그 선택지를 끈다.
 *
 * 한 요청은 모델 한 라운드다. 도구는 프런트(src/ai/claude.ts)가 실행하고 tool_result를 붙여 다시 호출한다.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { JobRegistry } from '../domains';
import { HttpError } from '../lib/errors';
import { parseBody, z } from '../lib/validate';
import { can } from '../auth/permissions';
import { securityOptionsFromEnv } from '../http/security';
import {
  AI_SERVER_ERRORS,
  aiEnabled,
  assertBudget,
  buildStreamParams,
  getAiClient,
  kstMonth,
  monthTotals,
  monthlyTokenLimit,
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

/** 브라우저가 api.anthropic.com에 직접 연결할 수 있는 CSP인지 (http/security.ts appCsp connect-src와 같은 값으로 판정) */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';

export type AiUnavailableReason = 'ai_not_configured' | 'ai_disabled' | 'workspace_locked' | 'forbidden' | 'budget_exceeded';

/** 서버 AI를 못 쓰는 첫 사유 — 관리자가 고칠 수 있는 순서(키 → 켜기 → 잠금 → 권한 → 한도) */
export function aiUnavailableReason(s: { configured: boolean; enabled: boolean; locked: boolean; canRequest: boolean; budgetExceeded: boolean }): AiUnavailableReason | null {
  if (!s.configured) return 'ai_not_configured';
  if (!s.enabled) return 'ai_disabled';
  if (s.locked) return 'workspace_locked';
  if (!s.canRequest) return 'forbidden';
  if (s.budgetExceeded) return 'budget_exceeded';
  return null;
}

/**
 * 'ai upstream error' 로그 필드. 요청 로거에는 이미 requestId(이 HTTP 요청 — http/security.ts가 묶는다)가 붙어 있으므로
 * Anthropic 요청 id는 upstreamRequestId로 남긴다(같은 키를 쓰면 JSON 파서가 뒤의 값만 남겨 서버 요청 id가 사라진다).
 */
export function upstreamErrorLogFields(wsId: string, result: Pick<RoundResult, 'errorCode' | 'requestId'>): { ws: string; code: string | null; upstreamRequestId: string | null } {
  return { ws: wsId, code: result.errorCode, upstreamRequestId: result.requestId };
}

export const routes: FastifyPluginAsync = async (app) => {
  // 보안 계층(http/security.ts)과 같은 시점(앱을 만들 때)에 한 번 읽는다
  const browserDirect = securityOptionsFromEnv(process.env, app.ctx.config.env).cspConnectExtra.includes(ANTHROPIC_ORIGIN);
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
      if (result.status === 'error') req.log.warn(upstreamErrorLogFields(c.workspace.id, result), 'ai upstream error');
      if (!res.writableEnded) res.end();
    },
  );

  app.get('/w/:ws/ai/usage', async (req) => {
    const c = await req.workspace('read');
    const q = parseBody(UsageQuery, req.query);
    const cfg = app.ctx.config;
    const month = q.month ?? kstMonth();
    const locked = c.workspace.status !== 'active';
    const canRequest = can(c.role, 'request');
    const summary = await usageSummary(app.ctx.db, c, {
      month,
      model: cfg.anthropicModel,
      configured: Boolean(cfg.anthropicApiKey),
      // 읽기 전용(잠긴) 워크스페이스는 POST가 423이므로 호출할 수 없다
      canUse: canRequest && !locked,
      includeUsers: can(c.role, 'configure'),
    });
    // 한도는 이번 달 기준으로만 막는다 (지난달을 조회해도 지금 호출 가능 여부는 이번 달 합계로)
    let budgetExceeded = summary.budgetExceeded;
    if (month !== kstMonth()) {
      const now = await monthTotals(app.ctx.db, c.workspace.id, kstMonth());
      budgetExceeded = now.inputTokens + now.outputTokens >= monthlyTokenLimit(c.workspace.config);
    }
    const unavailableReason = aiUnavailableReason({ configured: summary.configured, enabled: summary.enabled, locked, canRequest, budgetExceeded });
    return { ...summary, available: unavailableReason === null, unavailableReason, browserDirect };
  });
};

/** ai 도메인은 예약 잡이 없다 (사용량은 호출 시점에 기록 · 한도는 호출 전에 판정) — §6 잡 계약에 ai 항목 없음 */
export function jobs(_reg: JobRegistry): void {
  /* 없음 */
}
