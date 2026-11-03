/**
 * ai 도메인 서비스 — 서버 키로 Anthropic Messages API를 스트리밍 호출하고, 워크스페이스별 월 토큰 한도 · 사용량을 관리한다.
 *
 * 호출 형식은 프런트 src/ai/claude.ts의 askAnthropic과 같다:
 *   client.beta.messages.stream({ model, max_tokens, thinking: { type: 'adaptive' }, output_config: { effort },
 *     betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', messages, tools? })
 * 여기에 자동 프롬프트 캐시(top-level cache_control)를 더한다 — 도구 왕복마다 같은 대화 앞부분을 다시 보내므로 캐시 읽기로 비용이 준다.
 *
 * 한 요청 = 모델 한 라운드. 도구는 프런트가 실행하고 tool_result 블록을 붙여 다시 호출한다(클라이언트 도구 루프).
 * 도구 왕복 중인 assistant 턴은 thinking 블록(서명 포함)을 그대로 되돌려 보내야 하므로 done 이벤트에 되돌려 보낼 content를 싣는다.
 *
 * 비밀값 · 개인정보: API 키는 config.anthropicApiKey(환경변수)만 쓰고 응답 · 로그 · 감사에 넣지 않는다.
 * 메시지 본문은 로그 · DB 어디에도 남기지 않는다(사용량 행에는 토큰 수 · 용도 · 결과 코드만).
 *
 * 테스트: setAiClientFactory(fake)로 Anthropic 클라이언트를 바꿔 끼운다(실제 네트워크 호출 없음).
 *
 * 근거 문서 (공식):
 *   스트리밍 이벤트 형식  https://platform.claude.com/docs/en/build-with-claude/streaming
 *   adaptive thinking · effort  https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 *   프롬프트 캐시(top-level cache_control)  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   거절 · 서버 측 대체 모델(fallbacks)  https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 *     (지원 모델 목록 · "default" 형식 + server-side-fallback-2026-07-01 헤더 · §Continuing the conversation 되돌려 보내기 표)
 *   preserved thinking(기록 편집 금지)  https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 *   오류 코드  https://platform.claude.com/docs/en/api/errors
 *   SDK 타입 · 동작: @anthropic-ai/sdk 1.3.0 (node_modules, BetaMessageStream · BetaFallbackBlockParam 주석)
 * 실제 Anthropic 계정으로의 호출은 이 개발 환경에서 검증하지 않았다(키 없음 · verifiedLive false). 요청 직렬화 · 스트림 해석은 SDK에 가짜 fetch를 넣어 검사한다.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import { HttpError, badRequest } from '../lib/errors';
import { kstToday, nowMs } from '../lib/time';
import { audit } from '../audit/audit';
import type { WorkspaceCtx } from '../http/context';

/* ---------------- 상수 ---------------- */

export const DEFAULT_MONTHLY_TOKEN_LIMIT = 30_000_000;
/** 요청 본문(messages + tools) 상한 — UTF-8 바이트 */
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_TOOLS = 64;
export const MAX_MESSAGES = 400;
export const DEFAULT_MAX_TOKENS = 16_000;
export const MAX_MAX_TOKENS = 64_000;
/** 서버 측 대체 모델(거절 시 같은 호출 안에서 재시도) — "default" 형식 전용 베타 헤더 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * fallbacks 파라미터를 문서가 지원한다고 적은 모델 (refusals-and-fallback 페이지 featureMetadata.supportedModels).
 * 이 밖의 모델(ANTHROPIC_MODEL을 4.x 등으로 바꾼 경우)에는 fallbacks · 베타 헤더를 보내지 않는다 —
 * 문서에 정의되지 않은 조합을 보내 모든 호출이 400으로 실패하는 것을 막는다. 새 모델이 지원 목록에 오르면 여기에 더한다.
 */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
export const supportsServerFallback = (model: string) => FALLBACK_MODELS.has(model.trim());

/* ---------------- Anthropic 클라이언트 (주입 가능) ---------------- */

/** SDK BetaMessageStream 중 이 도메인이 쓰는 부분 — 테스트의 가짜 스트림도 이 모양만 맞추면 된다 */
export interface AiStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
  readonly request_id?: string | null;
}

export interface AiClient {
  stream(params: BetaMessageStreamParams, options: { signal: AbortSignal }): AiStream;
}

export type AiClientFactory = (apiKey: string) => AiClient;

/**
 * 공식 SDK 클라이언트를 AiClient로 감싼다. 키를 명시해 환경변수 · 로그인 프로필 자격증명으로 새지 않게 한다.
 * SDK가 429 · 5xx · 연결 오류를 지수 백오프로 2회 재시도한다(maxRetries). fetch는 테스트에서 가짜 HTTP를 주입할 때만 쓴다.
 */
export function createSdkClient(apiKey: string, o: { fetch?: typeof fetch; baseURL?: string } = {}): AiClient {
  const client = new Anthropic({ apiKey, maxRetries: 2, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
  return { stream: (params, options) => client.beta.messages.stream(params, { signal: options.signal }) };
}

const sdkClients = new Map<string, AiClient>();

/** 기본: 공식 SDK. 키마다 클라이언트 하나를 재사용한다(연결 재사용) */
export const defaultAiClientFactory: AiClientFactory = (apiKey) => {
  let c = sdkClients.get(apiKey);
  if (!c) {
    c = createSdkClient(apiKey);
    sdkClients.set(apiKey, c);
  }
  return c;
};

let clientFactory: AiClientFactory = defaultAiClientFactory;

/** 테스트 · 운영 도구에서 클라이언트를 바꿔 끼운다. null이면 기본(SDK)으로 되돌린다 */
export function setAiClientFactory(f: AiClientFactory | null): void {
  clientFactory = f ?? defaultAiClientFactory;
}
export function getAiClient(apiKey: string): AiClient {
  return clientFactory(apiKey);
}

/* ---------------- 요청 검증 ---------------- */

const ToolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, '도구 이름 형식');
const BlockId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, '블록 id 형식');
const NonEmptyText = z.string().min(1).refine((s) => s.trim().length > 0, '빈 텍스트');

const TextBlock = z.object({ type: z.literal('text'), text: NonEmptyText });
const ThinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().max(65_536) });
const RedactedThinkingBlock = z.object({ type: z.literal('redacted_thinking'), data: z.string() });
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: BlockId, name: ToolName, input: z.record(z.string(), z.unknown()) });
const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: BlockId,
  content: z.union([z.string(), z.array(TextBlock)]),
  is_error: z.boolean().optional(),
});
const FallbackBlock = z.object({
  type: z.literal('fallback'),
  from: z.object({ model: z.string().min(1).max(100) }),
  to: z.object({ model: z.string().min(1).max(100) }),
  trigger: z.unknown().optional(),
});
const ContentBlock = z.discriminatedUnion('type', [TextBlock, ThinkingBlock, RedactedThinkingBlock, ToolUseBlock, ToolResultBlock, FallbackBlock]);
type ContentBlockIn = z.infer<typeof ContentBlock>;

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([NonEmptyText, z.array(ContentBlock).min(1).max(200)]),
});

const ToolSchema = z.object({
  name: ToolName,
  description: z.string().max(10_000),
  input_schema: z.object({ type: z.literal('object') }).loose(),
});

export const AiRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
  tools: z.array(ToolSchema).max(MAX_TOOLS).optional(),
  maxTokens: z.number().int().min(1).max(MAX_MAX_TOKENS).optional(),
  purpose: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, '용도 형식').optional(),
  /** quick → effort low, default → medium, complex → high */
  tier: z.enum(['quick', 'default', 'complex']).optional(),
});
export type AiRequest = z.infer<typeof AiRequestSchema>;

const USER_ONLY = new Set(['tool_result']);
const ASSISTANT_ONLY = new Set(['tool_use', 'thinking', 'redacted_thinking', 'fallback']);

/** 본문 검증: 크기(256KB) · 도구 수(64) · 블록 종류 · 역할별 허용 블록. 실패 시 HttpError */
export function parseAiRequest(raw: unknown): AiRequest {
  const body = (raw ?? {}) as { tools?: unknown; messages?: unknown };
  if (Array.isArray(body.tools) && body.tools.length > MAX_TOOLS) {
    throw new HttpError(400, 'too_many_tools', `도구는 한 번에 최대 ${MAX_TOOLS}개까지 보낼 수 있습니다 (보낸 개수 ${body.tools.length}개)`);
  }
  const bytes = Buffer.byteLength(JSON.stringify({ messages: body.messages ?? null, tools: body.tools ?? null }), 'utf8');
  if (bytes > MAX_REQUEST_BYTES) {
    throw new HttpError(413, 'prompt_too_large', `보낼 데이터가 너무 큽니다 (${Math.ceil(bytes / 1024)}KB, 상한 ${MAX_REQUEST_BYTES / 1024}KB). 범위를 줄여 다시 시도해 주세요`);
  }
  const r = AiRequestSchema.safeParse(raw ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(`AI 요청 형식을 확인해 주세요: ${[...new Set(issues.map((i) => i.path || '(본문)'))].slice(0, 5).join(', ')}`, issues);
  }
  const req = r.data;
  if (req.messages[0].role !== 'user') throw badRequest('대화의 첫 메시지는 user 역할이어야 합니다');
  // assistant 미리 채우기(prefill)는 4.6 이후 모델이 모두 400으로 거절한다 — 토큰 · 왕복을 쓰기 전에 막는다
  if (req.messages[req.messages.length - 1].role !== 'user') throw badRequest('대화의 마지막 메시지는 user 역할이어야 합니다 (assistant 미리 채우기는 지원하지 않습니다)');
  req.messages.forEach((m, i) => {
    if (typeof m.content === 'string') return;
    for (const b of m.content) {
      if (m.role === 'assistant' && USER_ONLY.has(b.type)) throw badRequest(`messages.${i}: assistant 메시지에는 ${b.type} 블록을 넣을 수 없습니다`);
      if (m.role === 'user' && ASSISTANT_ONLY.has(b.type)) throw badRequest(`messages.${i}: user 메시지에는 ${b.type} 블록을 넣을 수 없습니다`);
    }
  });
  if (req.tools) {
    const names = new Set<string>();
    for (const t of req.tools) {
      if (names.has(t.name)) throw badRequest(`도구 이름이 중복됩니다: ${t.name}`);
      names.add(t.name);
    }
  }
  return req;
}

/** 검증된 요청 → SDK 스트림 파라미터 */
export function buildStreamParams(req: AiRequest, model: string): BetaMessageStreamParams {
  const effort = req.tier === 'quick' ? 'low' : req.tier === 'complex' ? 'high' : 'medium';
  const messages: BetaMessageParam[] = req.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : (m.content.map(toBlockParam) as BetaContentBlockParam[]),
  }));
  const tools = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as BetaToolUnion[];
  return {
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    ...(supportsServerFallback(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    cache_control: { type: 'ephemeral' },
    messages,
    ...(tools.length ? { tools } : {}),
  };
}

function toBlockParam(b: ContentBlockIn): BetaContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'thinking':
      return { type: 'thinking', thinking: b.thinking, signature: b.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: b.data };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) };
    case 'fallback':
      return { type: 'fallback', from: { model: b.from.model }, to: { model: b.to.model }, trigger: b.trigger ?? null } as BetaContentBlockParam;
  }
}

/* ---------------- 응답 → 되돌려 보낼 content · 도구 호출 ---------------- */

export type EchoBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'fallback'; from: { model: string }; to: { model: string }; trigger: unknown };

/**
 * 최종 메시지의 content를 다음 요청에 그대로 되돌려 보낼 형태로 바꾼다.
 * 공식 문서(refusals-and-fallback §Continuing the conversation) 표를 따른다:
 *   fallback 블록 → 나온 자리 그대로 둔다(경계 위치로 주변 thinking을 검증한다)
 *   text → 둔다 · 마지막 fallback 블록 뒤의 모든 블록 → 둔다
 *   마지막 fallback 블록 앞의 thinking · redacted_thinking · 클라이언트 tool_use → 뺀다(거절된 시도의 것 — tool_use는 실행하지 않는다)
 * 공백뿐인 텍스트 블록은 요청에서 거부되므로 뺀다(preserved thinking 기록 비교도 공백 블록을 무시한다).
 * 그 밖의 블록 종류(서버 도구 · connector_text 등)는 이 경로(사용자 정의 도구만 허용)에서 생기지 않으므로 뺀다.
 */
export function toEchoContent(content: BetaContentBlock[]): { content: EchoBlock[]; toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> } {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') lastFallback = i;
  });
  const out: EchoBlock[] = [];
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  content.forEach((b, i) => {
    const beforeBoundary = i < lastFallback;
    switch (b.type) {
      case 'text':
        if (b.text.trim()) out.push({ type: 'text', text: b.text });
        break;
      case 'thinking':
        if (!beforeBoundary) out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        break;
      case 'redacted_thinking':
        if (!beforeBoundary) out.push({ type: 'redacted_thinking', data: b.data });
        break;
      case 'tool_use': {
        if (beforeBoundary) break;
        const input = (b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {}) as Record<string, unknown>;
        out.push({ type: 'tool_use', id: b.id, name: b.name, input });
        toolUses.push({ id: b.id, name: b.name, input });
        break;
      }
      case 'fallback':
        out.push({ type: 'fallback', from: { model: b.from.model }, to: { model: b.to.model }, trigger: b.trigger ?? null });
        break;
      default:
        break;
    }
  });
  return { content: out, toolUses };
}

/* ---------------- 사용량 ---------------- */

export interface TokenUsage {
  /** 전체 입력 = 캐시 미적용 + 캐시 쓰기 + 캐시 읽기 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** 최종 usage → 집계. 서버 측 대체 모델이 돌았으면 usage.iterations(시도별)가 기준이다 */
export function usageFromMessage(u: BetaUsage | null | undefined): TokenUsage {
  if (!u) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const its = Array.isArray(u.iterations) ? u.iterations : [];
  const rows = its.length
    ? its.map((it) => it as unknown as Record<string, unknown>)
    : [u as unknown as Record<string, unknown>];
  const t: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const r of rows) {
    const cr = n(r.cache_read_input_tokens);
    const cc = n(r.cache_creation_input_tokens);
    t.inputTokens += n(r.input_tokens) + cr + cc;
    t.cacheReadTokens += cr;
    t.cacheCreationTokens += cc;
    t.outputTokens += n(r.output_tokens);
  }
  return t;
}

/**
 * 받은 출력 길이(UTF-8 바이트) → 출력 토큰 추정. 한글은 글자당 3바이트 · 영문은 토큰당 약 4바이트라 3바이트 ≈ 1토큰으로 잡는다
 * (한도 판정에 쓰므로 적게 세지 않는 쪽). 실제 청구 토큰이 아니라 추정이다 — usageSummary basis에 적는다.
 */
export const estimateOutputTokens = (bytes: number) => (bytes > 0 ? Math.ceil(bytes / 3) : 0);
const utf8Bytes = (s: unknown) => (typeof s === 'string' && s ? Buffer.byteLength(s, 'utf8') : 0);

/**
 * 스트림 도중 끊겼을 때 이벤트로 본 사용량(최선 추정).
 * 출력 토큰은 message_delta(끝날 때 한 번)에만 실제 값이 온다 — 중지 · 스트림 오류로 그 전에 끊기면 message_start의 값(보통 1)만 남아
 * 이미 생성 · 청구된 토큰이 사용량 · 한도에서 빠진다. 그때는 받은 텍스트 · thinking · 도구 입력 델타 길이로 추정한 값과 큰 쪽을 쓴다.
 */
export class UsageTracker {
  input = 0;
  cacheRead = 0;
  cacheCreation = 0;
  output = 0;
  model: string | null = null;
  /** 받은 출력 델타 바이트 (text · thinking · tool input json) */
  streamedBytes = 0;
  /** message_delta로 최종 출력 토큰을 받았는지 */
  finalOutput = false;
  observe(e: BetaRawMessageStreamEvent): void {
    if (e.type === 'content_block_delta') {
      const d = e.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
      if (d.type === 'text_delta') this.streamedBytes += utf8Bytes(d.text);
      else if (d.type === 'thinking_delta') this.streamedBytes += utf8Bytes(d.thinking);
      else if (d.type === 'input_json_delta') this.streamedBytes += utf8Bytes(d.partial_json);
    } else if (e.type === 'message_start') {
      const u = e.message.usage as Partial<BetaUsage> | undefined;
      this.model = e.message.model ?? this.model;
      if (u) {
        this.input = n(u.input_tokens);
        this.cacheRead = n(u.cache_read_input_tokens);
        this.cacheCreation = n(u.cache_creation_input_tokens);
        this.output = n(u.output_tokens);
      }
    } else if (e.type === 'message_delta') {
      const u = e.usage;
      if (u) {
        if (u.input_tokens != null) this.input = n(u.input_tokens);
        if (u.cache_read_input_tokens != null) this.cacheRead = n(u.cache_read_input_tokens);
        if (u.cache_creation_input_tokens != null) this.cacheCreation = n(u.cache_creation_input_tokens);
        if (u.output_tokens != null) {
          this.output = n(u.output_tokens);
          this.finalOutput = true;
        }
      }
    }
  }
  /** 출력 토큰을 추정했는지 (최종 값을 받지 못하고 받은 델타 길이로 잡은 경우) */
  get estimated(): boolean {
    return !this.finalOutput && estimateOutputTokens(this.streamedBytes) > this.output;
  }
  snapshot(): TokenUsage {
    const output = this.finalOutput ? this.output : Math.max(this.output, estimateOutputTokens(this.streamedBytes));
    return { inputTokens: this.input + this.cacheRead + this.cacheCreation, outputTokens: output, cacheReadTokens: this.cacheRead, cacheCreationTokens: this.cacheCreation };
  }
}

/* ---------------- 오류 매핑 (Anthropic → 한국어) ---------------- */

export interface MappedError { code: string; message: string; status: number }

export const AI_SERVER_ERRORS = {
  ai_not_configured: 'AI 서버 키가 설정되지 않았습니다. 관리자에게 서버 환경변수 ANTHROPIC_API_KEY 설정을 요청해 주세요. 그 전까지 각 화면은 규칙 엔진으로 동작합니다.',
  ai_disabled: '이 워크스페이스는 AI 사용이 꺼져 있습니다. 워크스페이스 설정에서 켤 수 있습니다.',
  rate_limited: 'Claude API 요청 한도에 도달했습니다. 1분 정도 뒤에 다시 시도해 주세요.',
  overloaded: 'Claude 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.',
  invalid_request: 'AI 요청 형식이 올바르지 않아 Claude가 거절했습니다. 대화를 새로 시작해 다시 시도해 주세요.',
  prompt_too_large: '보낼 데이터가 너무 큽니다. 범위를 줄여 다시 시도해 주세요.',
  ai_auth: '서버에 설정된 Anthropic API 키가 유효하지 않거나 권한이 없습니다. 관리자에게 키 확인을 요청해 주세요.',
  ai_billing: 'Anthropic 계정의 결제 · 크레딧 문제로 호출이 거절되었습니다. 관리자에게 확인을 요청해 주세요.',
  model_unavailable: '서버에 설정된 Claude 모델을 이 Anthropic 계정에서 쓸 수 없습니다. 관리자에게 ANTHROPIC_MODEL 확인을 요청해 주세요.',
  upstream_error: 'Claude API 연결 중 일시적인 오류가 발생했습니다. 다시 시도해 주세요.',
  cancelled: '요청을 중지했습니다.',
} as const;

const TYPE_TO_CODE: Record<string, keyof typeof AI_SERVER_ERRORS> = {
  rate_limit_error: 'rate_limited',
  overloaded_error: 'overloaded',
  invalid_request_error: 'invalid_request',
  request_too_large: 'prompt_too_large',
  authentication_error: 'ai_auth',
  permission_error: 'ai_auth',
  billing_error: 'ai_billing',
  not_found_error: 'model_unavailable',
  api_error: 'upstream_error',
  timeout_error: 'upstream_error',
};

const STATUS_TO_CODE: Record<number, keyof typeof AI_SERVER_ERRORS> = {
  400: 'invalid_request',
  401: 'ai_auth',
  402: 'ai_billing',
  403: 'ai_auth',
  404: 'model_unavailable',
  413: 'prompt_too_large',
  429: 'rate_limited',
  529: 'overloaded',
};

/** SDK 오류 → 코드 · 한국어 메시지 · HTTP 상태. 원문 메시지(요청 내용이 섞일 수 있음)는 쓰지 않는다 */
export function mapAnthropicError(e: unknown, signal?: AbortSignal): MappedError {
  const mk = (code: keyof typeof AI_SERVER_ERRORS, status: number): MappedError => ({ code, message: AI_SERVER_ERRORS[code], status });
  if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) return mk('cancelled', 499);
  if (e instanceof Anthropic.APIConnectionError) return mk('upstream_error', 502);
  if (e instanceof Anthropic.APIError) {
    const type = (e.type ?? (e.error as { error?: { type?: string } } | undefined)?.error?.type ?? '') as string;
    const byType = TYPE_TO_CODE[type];
    if (byType) return mk(byType, e.status ?? 502);
    const byStatus = e.status ? STATUS_TO_CODE[e.status] : undefined;
    if (byStatus) return mk(byStatus, e.status ?? 502);
    return mk('upstream_error', e.status ?? 502);
  }
  return mk('upstream_error', 502);
}

/* ---------------- 한 라운드 실행 (스트리밍) ---------------- */

export type AiEvent =
  | { event: 'text'; data: { delta: string } }
  | { event: 'tool_use'; data: { id: string; name: string; input: Record<string, unknown> } }
  | {
      event: 'done';
      data: {
        stopReason: string | null;
        usage: TokenUsage;
        /** 다음 요청에 assistant 턴으로 그대로 되돌려 보낼 content (thinking 서명 포함) */
        content: EchoBlock[];
        model: string;
      };
    }
  | { event: 'error'; data: { code: string; message: string } };

export interface RoundResult {
  status: 'ok' | 'error' | 'cancelled';
  stopReason: string | null;
  usage: TokenUsage;
  servedModel: string | null;
  errorCode: string | null;
  requestId: string | null;
  durationMs: number;
}

/**
 * 모델 한 라운드를 스트리밍으로 실행하고 이벤트를 emit으로 내보낸다. 예외를 던지지 않는다(오류는 error 이벤트).
 * text: 텍스트 델타가 올 때마다, tool_use: 끝난 뒤 stop_reason이 tool_use일 때만(잘린 입력은 실행하지 않는다), done: 마지막.
 */
export async function runRound(client: AiClient, params: BetaMessageStreamParams, signal: AbortSignal, emit: (e: AiEvent) => void): Promise<RoundResult> {
  const started = nowMs();
  const tracker = new UsageTracker();
  let stream: AiStream | null = null;
  try {
    stream = client.stream(params, { signal });
    for await (const e of stream) {
      tracker.observe(e);
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text) {
        emit({ event: 'text', data: { delta: e.delta.text } });
      }
    }
    const msg = await stream.finalMessage();
    const usage = usageFromMessage(msg.usage);
    const stopReason = msg.stop_reason ?? null;
    const { content, toolUses } = toEchoContent(msg.content ?? []);
    if (stopReason === 'tool_use') {
      for (const u of toolUses) emit({ event: 'tool_use', data: u });
    }
    emit({
      event: 'done',
      data: { stopReason, usage, content: stopReason === 'refusal' ? [] : content, model: msg.model ?? String(params.model) },
    });
    return { status: 'ok', stopReason, usage, servedModel: msg.model ?? null, errorCode: null, requestId: stream.request_id ?? null, durationMs: nowMs() - started };
  } catch (e) {
    const m = mapAnthropicError(e, signal);
    if (m.code !== 'cancelled') emit({ event: 'error', data: { code: m.code, message: m.message } });
    const reqId = e instanceof Anthropic.APIError ? e.requestID ?? null : stream?.request_id ?? null;
    return {
      status: m.code === 'cancelled' ? 'cancelled' : 'error',
      stopReason: null,
      usage: tracker.snapshot(),
      servedModel: tracker.model,
      errorCode: m.code,
      requestId: reqId,
      durationMs: nowMs() - started,
    };
  }
}

/* ---------------- 월 한도 · 사용량 기록 ---------------- */

/** KST 기준 'YYYY-MM' */
export const kstMonth = (ms = nowMs()) => kstToday(ms).slice(0, 7);

/** 월 'YYYY-MM' → [시작, 다음 달 시작) (KST 자정, ISO +09:00) */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { from: `${month}-01T00:00:00+09:00`, to: `${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+09:00` };
}

interface AiWorkspaceConfig { monthlyTokenLimit?: unknown; enabled?: unknown }
const aiConfigOf = (cfg: Record<string, unknown> | null | undefined): AiWorkspaceConfig => {
  const ai = cfg?.ai;
  return ai && typeof ai === 'object' && !Array.isArray(ai) ? (ai as AiWorkspaceConfig) : {};
};

/** 워크스페이스 설정 ai.monthlyTokenLimit (없거나 잘못된 값이면 기본 3,000만) */
export function monthlyTokenLimit(cfg: Record<string, unknown> | null | undefined): number {
  const v = aiConfigOf(cfg).monthlyTokenLimit;
  const num = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof num === 'number' && Number.isFinite(num) && num >= 0 ? Math.floor(num) : DEFAULT_MONTHLY_TOKEN_LIMIT;
}

/** 워크스페이스 설정 ai.enabled === false면 AI 사용 끔 */
export const aiEnabled = (cfg: Record<string, unknown> | null | undefined) => aiConfigOf(cfg).enabled !== false;

export interface MonthTotals { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; calls: number; errors: number }

export async function monthTotals(q: Queryable, workspaceId: string, month: string): Promise<MonthTotals> {
  const { from, to } = monthBounds(month);
  const r = await one<{ i: number; o: number; cr: number; cc: number; calls: number; errors: number }>(
    q,
    `SELECT COALESCE(SUM(input_tokens), 0)::bigint AS i, COALESCE(SUM(output_tokens), 0)::bigint AS o,
            COALESCE(SUM(cache_read_tokens), 0)::bigint AS cr, COALESCE(SUM(cache_creation_tokens), 0)::bigint AS cc,
            COUNT(*)::bigint AS calls, COUNT(*) FILTER (WHERE status = 'error')::bigint AS errors
       FROM ai_usage WHERE workspace_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz`,
    [workspaceId, from, to],
  );
  return { inputTokens: r?.i ?? 0, outputTokens: r?.o ?? 0, cacheReadTokens: r?.cr ?? 0, cacheCreationTokens: r?.cc ?? 0, calls: r?.calls ?? 0, errors: r?.errors ?? 0 };
}

/**
 * 호출 전 한도 확인 — 이번 달(KST) 입력 + 출력 토큰 합이 한도 이상이면 429 budget_exceeded.
 * 한도 초과는 워크스페이스 · 월마다 한 번 감사 로그에 남긴다. 동시 요청은 각자 통과할 수 있어 한도를 한 요청분 넘을 수 있다.
 */
export async function assertBudget(q: Queryable, c: WorkspaceCtx): Promise<{ limit: number; used: number; month: string }> {
  const month = kstMonth();
  const limit = monthlyTokenLimit(c.workspace.config);
  const t = await monthTotals(q, c.workspace.id, month);
  const used = t.inputTokens + t.outputTokens;
  if (used >= limit) {
    const seen = await one(
      q,
      `SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'ai.budget_exceeded' AND target_id = $2 LIMIT 1`,
      [c.workspace.id, month],
    );
    if (!seen) {
      await audit(q, {
        workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, action: 'ai.budget_exceeded',
        targetType: 'ai_usage', targetId: month, detail: { month, limit, used }, ip: c.ip,
      });
    }
    throw new HttpError(
      429,
      'budget_exceeded',
      `이번 달 AI 사용 한도에 도달했습니다 (사용 ${used.toLocaleString('ko-KR')} / 한도 ${limit.toLocaleString('ko-KR')} 토큰, KST ${month} 기준). 관리자가 워크스페이스 설정에서 월 한도를 올리거나, 다음 달 1일 00:00(KST)부터 다시 쓸 수 있습니다. 그동안 각 화면은 규칙 엔진으로 동작합니다.`,
      { month, limit, used },
    );
  }
  return { limit, used, month };
}

export async function recordUsage(
  q: Queryable,
  row: { workspaceId: string; userId: string | null; model: string; purpose: string; result: RoundResult },
): Promise<void> {
  const r = row.result;
  await q.query(
    `INSERT INTO ai_usage (workspace_id, user_id, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                           status, stop_reason, error_code, duration_ms, request_id, served_model, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)`,
    [
      row.workspaceId, row.userId, row.model, row.purpose,
      r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheCreationTokens,
      r.status, r.stopReason, r.errorCode, Math.max(0, Math.round(r.durationMs)), r.requestId, r.servedModel,
      // 한도 판정(kstMonth)과 같은 시계 — lib/time nowMs (운영에서는 Date.now())
      new Date(nowMs()).toISOString(),
    ],
  );
}

/* ---------------- 사용량 요약 (GET /ai/usage) ---------------- */

export interface UsageSummary {
  month: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  calls: number;
  errors: number;
  limit: number;
  remaining: number;
  /** 사용 비율 0~1 (입력 + 출력 / 한도, 1에서 자른다 — 넘은 양은 totalTokens · limit · budgetExceeded로 본다) */
  usedRatio: number;
  budgetExceeded: boolean;
  byPurpose: Array<{ purpose: string; calls: number; inputTokens: number; outputTokens: number }>;
  daily: Array<{ date: string; calls: number; inputTokens: number; outputTokens: number }>;
  /** configure 권한이 있을 때만 */
  byUser?: Array<{ userId: string | null; name: string; calls: number; inputTokens: number; outputTokens: number }>;
  model: string;
  /** 서버에 ANTHROPIC_API_KEY가 있는지 (키 값은 내보내지 않는다) */
  configured: boolean;
  enabled: boolean;
  /** 이 사용자가 AI를 호출할 수 있는지 (request 권한) */
  canUse: boolean;
  basis: string;
}

export async function usageSummary(
  q: Queryable,
  c: WorkspaceCtx,
  o: { month: string; model: string; configured: boolean; canUse: boolean; includeUsers: boolean },
): Promise<UsageSummary> {
  const { from, to } = monthBounds(o.month);
  const limit = monthlyTokenLimit(c.workspace.config);
  const t = await monthTotals(q, c.workspace.id, o.month);
  const params = [c.workspace.id, from, to];
  const purposes = await q.query<{ purpose: string; calls: number; i: number; o: number }>(
    `SELECT COALESCE(purpose, 'general') AS purpose, COUNT(*)::bigint AS calls, SUM(input_tokens)::bigint AS i, SUM(output_tokens)::bigint AS o
       FROM ai_usage WHERE workspace_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz
      GROUP BY 1 ORDER BY SUM(input_tokens + output_tokens) DESC, 1`,
    params,
  );
  const days = await q.query<{ date: string; calls: number; i: number; o: number }>(
    `SELECT to_char(((at AT TIME ZONE 'UTC') + interval '9 hours')::date, 'YYYY-MM-DD') AS date,
            COUNT(*)::bigint AS calls, SUM(input_tokens)::bigint AS i, SUM(output_tokens)::bigint AS o
       FROM ai_usage WHERE workspace_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  let byUser: UsageSummary['byUser'];
  if (o.includeUsers) {
    const users = await q.query<{ user_id: string | null; name: string | null; calls: number; i: number; o: number }>(
      `SELECT a.user_id, u.name, COUNT(*)::bigint AS calls, SUM(a.input_tokens)::bigint AS i, SUM(a.output_tokens)::bigint AS o
         FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.workspace_id = $1 AND a.at >= $2::timestamptz AND a.at < $3::timestamptz
        GROUP BY a.user_id, u.name ORDER BY SUM(a.input_tokens + a.output_tokens) DESC`,
      params,
    );
    byUser = users.rows.map((r) => ({ userId: r.user_id, name: r.name ?? '(삭제된 사용자)', calls: r.calls, inputTokens: r.i, outputTokens: r.o }));
  }
  const total = t.inputTokens + t.outputTokens;
  return {
    month: o.month,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    totalTokens: total,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    calls: t.calls,
    errors: t.errors,
    limit,
    remaining: Math.max(0, limit - total),
    usedRatio: limit > 0 ? Math.min(1, total / limit) : total > 0 ? 1 : 0,
    budgetExceeded: total >= limit,
    byPurpose: purposes.rows.map((r) => ({ purpose: r.purpose, calls: r.calls, inputTokens: r.i, outputTokens: r.o })),
    daily: days.rows.map((r) => ({ date: r.date, calls: r.calls, inputTokens: r.i, outputTokens: r.o })),
    ...(byUser ? { byUser } : {}),
    model: o.model,
    configured: o.configured,
    enabled: aiEnabled(c.workspace.config),
    canUse: o.canUse,
    basis: `집계 기준: KST ${o.month}-01 00:00부터 다음 달 1일 00:00 전까지. 입력 토큰은 캐시 읽기 · 쓰기를 포함한 전체 입력이며, 한도 판정은 입력 + 출력 합계로 한다. 중지 · 오류로 중간에 끊긴 호출의 출력 토큰은 받은 출력 길이(3바이트 ≈ 1토큰)로 추정한 값이다.`,
  };
}
