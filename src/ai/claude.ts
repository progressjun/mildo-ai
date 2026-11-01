/**
 * Claude 연결 계층 — 세 가지 백엔드를 같은 인터페이스로 감싼다.
 *  1) artifact  : claude.ai 아티팩트 안에서 실행될 때 `claude.use("sample")` (보는 사람의 Claude 계정 사용, API 키 불필요)
 *  2) anthropic : 로컬/사내 배포 시 Anthropic SDK (사용자가 설정에 API 키 입력, 브라우저 직접 호출)
 *  3) none      : 연결 없음 → 각 모듈의 규칙 기반(오프라인) 엔진으로 동작
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AiSettings } from '@/core/types';

export type Backend = 'artifact' | 'anthropic' | 'none';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  execute(input: Record<string, unknown>): unknown | Promise<unknown>;
}

export type Turn = { role: 'user' | 'assistant'; content: string };

export interface AskOptions {
  onText?: (text: string) => void;
  signal?: AbortSignal;
  tools?: AgentTool[];
  tier?: 'quick' | 'default' | 'complex';
  /** 아티팩트 캐시 사용 여부 (채팅은 false) */
  cache?: boolean;
  /** 도구 실행 시 진행 표시 */
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
}

export class AiError extends Error {
  constructor(public code: string, message: string, public partial?: string) {
    super(message);
  }
}

/* ---------------- artifact sample ---------------- */

type SampleFn = ((input: string | Turn[], opts?: Record<string, unknown>) => Promise<{ text: string; truncated: boolean }>) & {
  json: <T>(input: string | Turn[], opts?: Record<string, unknown>) => Promise<T>;
  limits: () => Promise<{ tools?: { maxCount: number }; maxPromptBytes: number }>;
};

let samplePromise: Promise<SampleFn | null> | null = null;
export function getSample(): Promise<SampleFn | null> {
  if (samplePromise) return samplePromise;
  const w = window as unknown as { claude?: { use: (n: string) => Promise<unknown> } };
  if (!w.claude || typeof w.claude.use !== 'function') {
    samplePromise = Promise.resolve(null);
  } else {
    samplePromise = w.claude.use('sample').then((s) => (s ? (s as SampleFn) : null)).catch(() => null);
  }
  return samplePromise;
}

let sampleDenied = false;

/** 백엔드가 바뀌는 사건(예: 보는 사람이 Claude 사용을 거부) 구독 — 상단 바 · 화면의 연결 상태 표시를 즉시 갱신 */
const backendListeners = new Set<() => void>();
export function onBackendChange(fn: () => void): () => void {
  backendListeners.add(fn);
  return () => {
    backendListeners.delete(fn);
  };
}
function markSampleDenied() {
  if (sampleDenied) return;
  sampleDenied = true;
  backendListeners.forEach((fn) => {
    try { fn(); } catch { /* 구독자 오류 무시 */ }
  });
}

/* ---------------- 백엔드 결정 ---------------- */

export async function resolveBackend(settings: AiSettings): Promise<Backend> {
  if (settings.mode === 'offline') return 'none';
  if (settings.mode === 'anthropic') return settings.apiKey ? 'anthropic' : 'none';
  const sample = sampleDenied ? null : await getSample();
  if (settings.mode === 'artifact') return sample ? 'artifact' : 'none';
  if (sample) return 'artifact';
  if (settings.apiKey) return 'anthropic';
  return 'none';
}

export const BACKEND_LABEL: Record<Backend, string> = {
  artifact: 'Claude 연결됨 (claude.ai)',
  anthropic: 'Claude API 연결됨',
  none: '규칙 엔진 (AI 미연결)',
};

/* ---------------- 공통 호출 ---------------- */

export async function ask(settings: AiSettings, input: string | Turn[], opts: AskOptions = {}): Promise<{ text: string; backend: Backend }> {
  const backend = await resolveBackend(settings);
  if (backend === 'artifact') return { text: await askArtifact(input, opts), backend };
  if (backend === 'anthropic') return { text: await askAnthropic(settings, input, opts), backend };
  throw new AiError('no_backend', 'AI 백엔드가 연결되지 않았습니다. 설정에서 API 키를 입력하거나 claude.ai 아티팩트에서 실행하세요.');
}

/** JSON 응답 — 실패 시 AiError('invalid_json') */
export async function askJson<T>(settings: AiSettings, prompt: string, opts: Omit<AskOptions, 'tools'> = {}): Promise<T> {
  const backend = await resolveBackend(settings);
  if (backend === 'artifact') {
    const sample = await getSample();
    if (!sample) throw new AiError('no_backend', 'Claude 사용 불가');
    try {
      return await sample.json<T>(prompt, { modelTier: opts.tier ?? 'default', signal: opts.signal, onText: opts.onText ? ({ text }: { text: string }) => opts.onText!(text) : undefined, ...(opts.cache === false ? { cache: false } : {}) });
    } catch (e) {
      throw toAiError(e);
    }
  }
  const { text } = await ask(settings, `${prompt}\n\n반드시 JSON 값 하나만 출력하세요. 코드펜스나 설명 문장 없이.`, opts);
  return parseJsonLoose<T>(text);
}

export function parseJsonLoose<T>(text: string): T {
  const tryParse = (s: string) => {
    try { return JSON.parse(s) as T; } catch { return undefined; }
  };
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = tryParse(fence[1].trim());
    if (f !== undefined) return f;
  }
  const first = Math.min(...['{', '['].map((c) => { const i = text.indexOf(c); return i < 0 ? Infinity : i; }));
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (Number.isFinite(first) && last > first) {
    const s = tryParse(text.slice(first, last + 1));
    if (s !== undefined) return s;
  }
  throw new AiError('invalid_json', 'AI 응답에서 JSON을 읽지 못했습니다.', text);
}

function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const o = e as { code?: string; message?: string; text?: string };
  if (o && typeof o === 'object' && o.code) {
    if (o.code === 'not_granted' || o.code === 'sampling_disabled') markSampleDenied();
    return new AiError(o.code, AI_ERROR_COPY[o.code] ?? o.message ?? 'AI 호출 실패', o.text);
  }
  return new AiError('upstream_error', (e as Error)?.message ?? 'AI 호출 실패');
}

export const AI_ERROR_COPY: Record<string, string> = {
  not_granted: 'Claude 사용이 허용되지 않았습니다. 규칙 엔진으로 계속합니다.',
  sampling_disabled: '이 계정에서는 Claude를 쓸 수 없습니다. 규칙 엔진으로 계속합니다.',
  rate_limited: '요청이 많습니다. 잠시 후 다시 시도하세요.',
  session_expired: 'claude.ai에 다시 로그인한 뒤 시도하세요.',
  refused: 'Claude가 이 요청에 답하지 않았습니다. 질문을 바꿔 보세요.',
  cancelled: '중지했습니다.',
  prompt_too_large: '보낼 데이터가 너무 큽니다. 범위를 줄여 다시 시도하세요.',
  invalid_json: 'AI 응답 형식을 읽지 못했습니다. 다시 시도하세요.',
  upstream_error: '일시적인 연결 오류입니다. 다시 시도하세요.',
  no_backend: 'AI가 연결되지 않아 규칙 엔진 결과를 표시합니다.',
};

/* ---------------- artifact ---------------- */

async function askArtifact(input: string | Turn[], opts: AskOptions): Promise<string> {
  const sample = await getSample();
  if (!sample) throw new AiError('no_backend', 'Claude 사용 불가');
  const options: Record<string, unknown> = {
    signal: opts.signal,
    modelTier: opts.tier ?? 'default',
    onText: opts.onText ? ({ text }: { text: string }) => opts.onText!(text) : undefined,
  };
  if (opts.tools?.length) {
    const limits = await sample.limits().catch(() => null);
    // 런타임이 도구를 지원하지 않으면 도구 없이 보내되, 채팅 캐시 설정(cache:false)은 유지한다
    if (!limits?.tools && opts.cache === false) options.cache = false;
    if (limits?.tools) {
      options.tools = opts.tools.slice(0, limits.tools.maxCount).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        execute: async (inp: Record<string, unknown>) => {
          opts.onToolCall?.(t.name, inp);
          const r = await t.execute(inp ?? {});
          return compact(r);
        },
      }));
    }
  } else if (opts.cache === false) {
    options.cache = false;
  }
  try {
    const { text, truncated } = await sample(input, options);
    return truncated ? `${text}\n\n_(응답 길이 제한으로 일부가 잘렸습니다)_` : text;
  } catch (e) {
    throw toAiError(e);
  }
}

/** 도구 결과 상한 (런타임 계약 32KB — UTF-8 바이트 기준, 여유분 포함) */
export const TOOL_RESULT_MAX_BYTES = 30000;

/** 도구 결과를 32KB 안으로 (한글은 글자당 3바이트이므로 글자 수가 아니라 UTF-8 바이트로 잰다) */
export function compact(r: unknown): unknown {
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  if (s === undefined) return r;
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= TOOL_RESULT_MAX_BYTES) return r;
  const suffix = '…(생략)';
  const room = TOOL_RESULT_MAX_BYTES - enc.encode(suffix).length;
  // 잘린 멀티바이트 문자는 TextDecoder가 U+FFFD로 바꾸므로 끝의 대체 문자를 지운다
  const cut = new TextDecoder().decode(bytes.slice(0, room)).replace(/\uFFFD+$/, '');
  return cut + suffix;
}

/* ---------------- Anthropic SDK (브라우저 직접 호출) ---------------- */

async function askAnthropic(settings: AiSettings, input: string | Turn[], opts: AskOptions): Promise<string> {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const turns: Turn[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  // 아티팩트 형식(선두 user 턴에 지시문)과 맞추기: 첫 턴을 system으로 승격하지 않고 그대로 보낸다.
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = mergeSameRole(turns).map((t) => ({ role: t.role, content: t.content }));
  const tools = (opts.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Anthropic.Beta.Messages.BetaTool.InputSchema,
  }));
  let out = '';
  for (let round = 0; round < 8; round++) {
    const stream = client.beta.messages.stream(
      {
        model: settings.model || 'claude-opus-5-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: opts.tier === 'quick' ? 'low' : 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages,
        ...(tools.length ? { tools } : {}),
      },
      { signal: opts.signal },
    );
    const prefix = out ? `${out}\n\n` : '';
    let roundText = '';
    stream.on('text', (delta: string) => {
      roundText += delta;
      opts.onText?.(prefix + roundText);
    });
    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      if (opts.signal?.aborted) throw new AiError('cancelled', AI_ERROR_COPY.cancelled, out);
      const status = (e as { status?: number }).status;
      if (status === 401) throw new AiError('auth', 'API 키가 올바르지 않습니다. 설정에서 확인하세요.');
      if (status === 429) throw new AiError('rate_limited', AI_ERROR_COPY.rate_limited, out);
      throw new AiError('upstream_error', (e as Error).message ?? AI_ERROR_COPY.upstream_error, out);
    }
    if (msg.stop_reason === 'refusal') throw new AiError('refused', AI_ERROR_COPY.refused);
    const text = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    if (text) out = prefix + text;
    if (msg.stop_reason !== 'tool_use') break;
    const uses = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
    const results = await Promise.all(
      uses.map(async (u) => {
        const tool = opts.tools?.find((t) => t.name === u.name);
        const inp = (u.input ?? {}) as Record<string, unknown>;
        opts.onToolCall?.(u.name, inp);
        try {
          const r = tool ? await tool.execute(inp) : `Unknown tool ${u.name}`;
          const content = typeof r === 'string' ? r : JSON.stringify(compact(r));
          return { type: 'tool_result' as const, tool_use_id: u.id, content };
        } catch (err) {
          return { type: 'tool_result' as const, tool_use_id: u.id, content: `Error: ${(err as Error).message}`, is_error: true };
        }
      }),
    );
    messages.push({ role: 'user', content: results });
  }
  if (!out.trim()) throw new AiError('empty_completion', 'AI 응답이 비어 있습니다.');
  return out;
}

function mergeSameRole(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.content}`;
    else out.push({ ...t });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: '(대화 시작)' });
  return out;
}
