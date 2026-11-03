/**
 * Claude 연결 계층 — 네 가지 백엔드를 같은 인터페이스로 감싼다.
 *  - artifact  : claude.ai 아티팩트 안에서 실행될 때 `claude.use("sample")` (보는 사람의 Claude 계정 사용, API 키 불필요)
 *  - server    : MILDO OS Cloud 서버 모드. 서버 키로 POST /api/w/:ws/ai/messages(SSE)를 호출하고, 도구는 브라우저에서 실행해
 *                tool_result를 붙여 다시 부르는 왕복 루프(최대 8라운드). 워크스페이스 월 한도 · 사용량은 서버가 관리한다.
 *  - anthropic : 로컬/사내 배포 시 Anthropic SDK (사용자가 설정에 API 키 입력, 브라우저 직접 호출)
 *  - none      : 연결 없음 → 각 모듈의 규칙 기반(오프라인) 엔진으로 동작
 * 서버 모드에서 platform이 워크스페이스가 정해지면 configureServerAi({ workspaceId })를 부른다(docs/SAAS_SPEC.md §6 프런트 연결 계약).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AiSettings } from '@/core/types';
import { readSse } from './sse';

export type Backend = 'artifact' | 'anthropic' | 'server' | 'none';

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
  /** 서버 백엔드 사용량 집계용 용도 (생략 시 현재 화면 id) */
  purpose?: string;
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

/**
 * 백엔드 결정.
 *  - offline → none
 *  - server → 서버 워크스페이스가 정해졌고 서버 AI를 쓸 수 있으면 server, 아니면 none
 *  - anthropic → API 키가 있으면 anthropic
 *  - artifact → claude.ai 런타임이 있으면 artifact
 *  - auto → 서버 모드(configureServerAi로 워크스페이스가 정해짐)면 server, 아니면 artifact → anthropic → none 순서.
 *    서버 키 미설정 · AI 꺼짐 · 호출 권한 없음(viewer)이면 서버 대신 그다음 순서로 넘어간다.
 */
export async function resolveBackend(settings: AiSettings): Promise<Backend> {
  if (settings.mode === 'offline') return 'none';
  if (settings.mode === 'server') return (await serverAvailable()) ? 'server' : 'none';
  if (settings.mode === 'anthropic') return settings.apiKey ? 'anthropic' : 'none';
  if (settings.mode === 'auto' && serverWsId && (await serverAvailable())) return 'server';
  const sample = sampleDenied ? null : await getSample();
  if (settings.mode === 'artifact') return sample ? 'artifact' : 'none';
  if (sample) return 'artifact';
  if (settings.apiKey) return 'anthropic';
  return 'none';
}

export const BACKEND_LABEL: Record<Backend, string> = {
  artifact: 'Claude 연결됨 (claude.ai)',
  anthropic: 'Claude API 연결됨',
  server: 'Claude 연결됨 (MILDO 서버)',
  none: '규칙 엔진 (AI 미연결)',
};

/* ---------------- 서버 모드 설정 ---------------- */

let serverWsId: string | null = null;
/** 서버가 이 워크스페이스에서 AI를 쓸 수 없다고 답한 뒤(키 없음 · AI 꺼짐 · 권한 없음) — 다시 configureServerAi할 때까지 */
let serverDenied = false;
let serverProbe: Promise<boolean> | null = null;
/** 마지막 확인 결과 (확인 전 null) — 같은 워크스페이스로 다시 configureServerAi할 때 '쓸 수 없음'이었으면 다시 확인한다 */
let serverProbeResult: boolean | null = null;

function notifyBackendChange() {
  backendListeners.forEach((fn) => {
    try { fn(); } catch { /* 구독자 오류 무시 */ }
  });
}

/**
 * 서버 모드 연결 (platform이 워크스페이스가 정해질 때 · 바뀔 때 · 설정이 바뀌어 다시 읽을 때 호출, 로그아웃 시 null).
 * 'auto' 모드는 이 값이 있으면 서버 백엔드를 고른다. 바뀌면 화면의 연결 상태를 다시 계산하게 알린다.
 * 같은 워크스페이스로 다시 불려도, 직전 확인이 '쓸 수 없음'(관리자가 AI를 꺼 둠 등)이었으면 다시 확인한다 —
 * 관리자가 설정에서 AI를 켠 뒤 새로고침 없이 서버 백엔드로 돌아오게 하기 위해서다.
 */
export function configureServerAi(o: { workspaceId: string | null }): void {
  const next = o.workspaceId || null;
  if (next === serverWsId && !serverDenied && serverProbeResult !== false) return;
  serverWsId = next;
  serverDenied = false;
  serverProbe = null;
  serverProbeResult = null;
  notifyBackendChange();
}

/** 현재 서버 모드 워크스페이스 id (없으면 null) */
export const serverAiWorkspace = (): string | null => serverWsId;

function markServerDenied() {
  if (serverDenied) return;
  serverDenied = true;
  serverProbe = Promise.resolve(false);
  serverProbeResult = false;
  notifyBackendChange();
}

/** 서버 AI 사용 가능 여부 — GET /ai/usage의 available(키 설정 · AI 켜짐 · request 권한 · 잠기지 않은 워크스페이스). 확인 실패 시 사용 가능으로 보고 호출 오류로 알린다 */
function serverAvailable(): Promise<boolean> {
  if (!serverWsId) return Promise.resolve(false);
  if (serverDenied) return Promise.resolve(false);
  if (serverProbe) return serverProbe;
  const ws = serverWsId;
  const holder: { p: Promise<boolean> | null } = { p: null };
  holder.p = (async () => {
    let ok = true;
    try {
      const u = await fetchServerAiUsage();
      ok = u ? u.available !== false : true;
    } catch {
      ok = true;
    }
    // 확인하는 사이 워크스페이스가 바뀌었거나 다시 configure되었으면 이 결과를 기록하지 않는다
    if (serverWsId === ws && serverProbe === holder.p) serverProbeResult = ok;
    return ok;
  })();
  serverProbe = holder.p;
  return holder.p;
}

/** GET /api/w/:ws/ai/usage 응답 (server/src/ai/service.ts UsageSummary + available) */
export interface ServerAiUsage {
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
  usedRatio: number;
  budgetExceeded: boolean;
  byPurpose: Array<{ purpose: string; calls: number; inputTokens: number; outputTokens: number }>;
  daily: Array<{ date: string; calls: number; inputTokens: number; outputTokens: number }>;
  byUser?: Array<{ userId: string | null; name: string; calls: number; inputTokens: number; outputTokens: number }>;
  model: string;
  configured: boolean;
  enabled: boolean;
  canUse: boolean;
  available: boolean;
  basis: string;
}

/** 이번 달(또는 month='YYYY-MM') 워크스페이스 AI 사용량 — 서버 모드가 아니거나 실패하면 null. 관리 화면 · 한도 표시용 */
export async function fetchServerAiUsage(month?: string, signal?: AbortSignal): Promise<ServerAiUsage | null> {
  if (!serverWsId || typeof fetch !== 'function') return null;
  const q = month ? `?month=${encodeURIComponent(month)}` : '';
  const res = await fetch(`/api/w/${serverWsId}/ai/usage${q}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal });
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as ServerAiUsage | null;
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    // JSON이 아닌 응답 (프록시 오류 페이지 등)
    return null;
  }
}

/* ---------------- 공통 호출 ---------------- */

export async function ask(settings: AiSettings, input: string | Turn[], opts: AskOptions = {}): Promise<{ text: string; backend: Backend }> {
  const backend = await resolveBackend(settings);
  if (backend === 'artifact') return { text: await askArtifact(input, opts), backend };
  if (backend === 'server') return { text: await askServer(input, opts), backend };
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
  const purpose = backend === 'server' ? opts.purpose ?? `${currentScreen()}:json` : opts.purpose;
  const { text } = await ask(settings, `${prompt}\n\n반드시 JSON 값 하나만 출력하세요. 코드펜스나 설명 문장 없이.`, { ...opts, ...(purpose ? { purpose } : {}) });
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
  // 서버 모드 (MILDO OS Cloud)
  ai_not_configured: '서버에 AI 키가 설정되지 않았습니다. 관리자에게 ANTHROPIC_API_KEY 설정을 요청하세요. 그동안 규칙 엔진 결과를 표시합니다.',
  budget_exceeded: '이번 달 워크스페이스 AI 사용 한도에 도달했습니다. 관리자가 워크스페이스 설정에서 한도를 올리거나 다음 달 1일(KST)부터 다시 쓸 수 있습니다. 그동안 규칙 엔진 결과를 표시합니다.',
  ai_disabled: '이 워크스페이스는 AI 사용이 꺼져 있습니다. 워크스페이스 설정에서 켤 수 있습니다.',
  forbidden: '이 역할(열람자)은 AI를 호출할 수 없습니다. 관리자에게 권한을 요청하세요.',
  unauthorized: '로그인이 만료되었습니다. 다시 로그인한 뒤 시도하세요.',
  csrf: '보안 토큰이 맞지 않습니다. 새로고침 후 다시 시도하세요.',
  overloaded: 'Claude 서버가 혼잡합니다. 잠시 후 다시 시도하세요.',
  invalid_request: 'AI 요청 형식이 거절되었습니다. 대화를 새로 시작해 다시 시도하세요.',
  too_many_tools: '한 번에 보낼 수 있는 도구 수(64개)를 넘었습니다.',
  ai_auth: '서버의 Anthropic API 키가 유효하지 않습니다. 관리자에게 확인을 요청하세요.',
  ai_billing: 'Anthropic 계정 결제 문제로 호출이 거절되었습니다. 관리자에게 확인을 요청하세요.',
  model_unavailable: '서버에 설정된 Claude 모델을 쓸 수 없습니다. 관리자에게 확인을 요청하세요.',
  network: '서버에 연결할 수 없습니다. 네트워크를 확인하세요.',
  workspace_locked: '이 워크스페이스는 읽기 전용 상태라 AI를 호출할 수 없습니다. 규칙 엔진 결과를 표시합니다.',
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
  return compactTo(r, TOOL_RESULT_MAX_BYTES);
}

/** compact와 같되 상한(UTF-8 바이트)을 지정한다 */
export function compactTo(r: unknown, maxBytes: number): unknown {
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  if (s === undefined) return r;
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return r;
  const suffix = '…(생략)';
  const room = Math.max(0, maxBytes - enc.encode(suffix).length);
  // 잘린 멀티바이트 문자는 TextDecoder가 U+FFFD로 바꾸므로 끝의 대체 문자를 지운다
  const cut = new TextDecoder().decode(bytes.slice(0, room)).replace(/\uFFFD+$/, '');
  return cut + suffix;
}

/* ---------------- MILDO OS Cloud 서버 (SSE · 클라이언트 도구 루프) ---------------- */

/** 서버 요청 본문 상한(256KB)보다 조금 작게 — 도구 결과를 이 안에 맞춘다 */
export const SERVER_REQUEST_MAX_BYTES = 250_000;
const SERVER_MAX_ROUNDS = 8;
const SERVER_MAX_TOOLS = 64;
const RESULT_OMITTED = '(결과가 요청 크기 상한을 넘어 생략했습니다. 지금까지 받은 결과로 판단하고, 근거가 부족하면 부족하다고 쓰세요.)';

type ServerBlock = { type: string } & Record<string, unknown>;
interface ServerMessage { role: 'user' | 'assistant'; content: string | ServerBlock[] }
interface ServerToolUse { id: string; name: string; input: Record<string, unknown> }
interface ServerRound { text: string; stopReason: string | null; content: ServerBlock[]; toolUses: ServerToolUse[] }

/** 현재 화면 id (해시 라우트) — 사용량 용도 집계 기본값 */
function currentScreen(): string {
  try {
    const h = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
    return /^[a-z0-9-]{1,40}$/.test(h) ? h : 'home';
  } catch {
    return 'home';
  }
}

function readCookie(name: string): string | null {
  try {
    if (typeof document === 'undefined') return null;
    const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/**
 * 도구 결과 → tool_result 문자열. 요청 JSON 안에서 차지하는 크기(따옴표 · 줄바꿈 이스케이프 포함)가 maxBytes 이하가 되게 자른다.
 * 앞선 대화(thinking 서명이 걸린 기록)는 고치지 않고 새 결과만 줄인다 — 기록을 고치면 이후 thinking 블록이 무효가 된다.
 */
export function fitToolResult(r: unknown, maxBytes: number): string {
  const raw = typeof r === 'string' ? r : (JSON.stringify(r) ?? String(r));
  const limit = Math.min(TOOL_RESULT_MAX_BYTES, Math.floor(maxBytes));
  if (limit < 400) return RESULT_OMITTED;
  let cap = limit;
  for (let i = 0; i < 8; i++) {
    const c = String(compactTo(raw, cap));
    if (utf8Len(JSON.stringify(c)) <= limit) return c.trim() ? c : '(빈 결과)';
    cap = Math.floor(cap * 0.7);
  }
  return RESULT_OMITTED;
}

/** 서버 오류 응답(JSON) → AiError. 키 없음 · AI 꺼짐 · 권한 없음이면 서버 백엔드를 끈다(규칙 엔진으로) */
async function serverHttpError(res: Response): Promise<AiError> {
  let code = '';
  let message = '';
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } } | null;
    code = j?.error?.code ?? '';
    message = j?.error?.message ?? '';
  } catch {
    /* JSON이 아닌 응답 (프록시 오류 등) */
  }
  if (!code) code = res.status >= 500 ? 'upstream_error' : res.status === 401 ? 'unauthorized' : `http_${res.status}`;
  if (code === 'bad_request') code = 'invalid_request';
  if (code === 'ai_not_configured' || code === 'ai_disabled' || code === 'workspace_locked' || (res.status === 403 && code === 'forbidden')) markServerDenied();
  return new AiError(code, message || AI_ERROR_COPY[code] || `AI 호출 실패 (${res.status})`);
}

/** 모델 한 라운드: POST /api/w/:ws/ai/messages → SSE(text · tool_use · done · error) */
async function serverRound(ws: string, body: Record<string, unknown>, signal: AbortSignal | undefined, onRoundText: (t: string) => void): Promise<ServerRound> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  const csrf = readCookie('mildo_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api/w/${ws}/ai/messages`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', signal });
  } catch (e) {
    if (signal?.aborted || isAbort(e)) throw e;
    throw new AiError('network', AI_ERROR_COPY.network);
  }
  if (!res.ok) throw await serverHttpError(res);
  if (!res.body) throw new AiError('upstream_error', AI_ERROR_COPY.upstream_error);
  let text = '';
  let done: { stopReason: string | null; content: ServerBlock[] } | null = null;
  let failed: AiError | null = null;
  const toolUses: ServerToolUse[] = [];
  await readSse(res.body, (e) => {
    if (done || failed) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (e.event === 'text') {
      if (typeof data.delta === 'string' && data.delta) {
        text += data.delta;
        onRoundText(text);
      }
    } else if (e.event === 'tool_use') {
      if (typeof data.id === 'string' && typeof data.name === 'string') {
        const input = data.input && typeof data.input === 'object' && !Array.isArray(data.input) ? (data.input as Record<string, unknown>) : {};
        toolUses.push({ id: data.id, name: data.name, input });
      }
    } else if (e.event === 'done') {
      done = { stopReason: typeof data.stopReason === 'string' ? data.stopReason : null, content: Array.isArray(data.content) ? (data.content as ServerBlock[]) : [] };
    } else if (e.event === 'error') {
      const code = typeof data.code === 'string' ? data.code : 'upstream_error';
      failed = new AiError(code, typeof data.message === 'string' && data.message ? data.message : AI_ERROR_COPY[code] ?? AI_ERROR_COPY.upstream_error);
    }
  }, signal);
  if (failed) throw failed;
  if (!done) throw new AiError('upstream_error', 'AI 응답이 중간에 끊겼습니다. 다시 시도하세요.');
  const d = done as { stopReason: string | null; content: ServerBlock[] };
  return { text, stopReason: d.stopReason, content: d.content, toolUses };
}

async function askServer(input: string | Turn[], opts: AskOptions): Promise<string> {
  const ws = serverWsId;
  if (!ws) throw new AiError('no_backend', AI_ERROR_COPY.no_backend);
  const turns: Turn[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  const messages: ServerMessage[] = mergeSameRole(turns.filter((t) => t.content && t.content.trim())).map((t) => ({ role: t.role, content: t.content }));
  const tools = (opts.tools ?? []).slice(0, SERVER_MAX_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: 'object' as const, properties: {} },
  }));
  const rawPurpose = opts.purpose ?? currentScreen();
  const purpose = /^[A-Za-z0-9_.:-]{1,64}$/.test(rawPurpose) ? rawPurpose : 'general';
  let out = '';
  /** 마지막 라운드의 stop_reason · 도구 왕복 상한에 걸렸는지 — 잘린 답을 완결된 답처럼 보이지 않게 표시한다 */
  let lastStop: string | null = null;
  let roundCapHit = false;
  for (let round = 0; round < SERVER_MAX_ROUNDS; round++) {
    if (opts.signal?.aborted) throw new AiError('cancelled', AI_ERROR_COPY.cancelled, out || undefined);
    const prefix = out ? `${out}\n\n` : '';
    let roundText = '';
    let r: ServerRound;
    try {
      r = await serverRound(
        ws,
        { messages, ...(tools.length ? { tools } : {}), purpose, ...(opts.tier ? { tier: opts.tier } : {}) },
        opts.signal,
        (t) => {
          roundText = t;
          opts.onText?.(prefix + t);
        },
      );
    } catch (e) {
      const partial = roundText ? prefix + roundText : out;
      if (opts.signal?.aborted || isAbort(e)) throw new AiError('cancelled', AI_ERROR_COPY.cancelled, partial || undefined);
      const err = e instanceof AiError ? e : new AiError('upstream_error', AI_ERROR_COPY.upstream_error);
      throw new AiError(err.code, err.message, partial || undefined);
    }
    if (r.stopReason === 'refusal') throw new AiError('refused', AI_ERROR_COPY.refused, out || undefined);
    if (r.text) out = prefix + r.text;
    lastStop = r.stopReason;
    if (r.stopReason !== 'tool_use' || !r.toolUses.length) break;
    if (round === SERVER_MAX_ROUNDS - 1) {
      roundCapHit = true;
      break;
    }
    // 도구 왕복 중인 assistant 턴은 서버가 준 content(thinking 서명 포함)를 그대로 되돌려 보낸다
    const content = r.content.some((b) => b.type === 'tool_use')
      ? r.content
      : [...(r.text.trim() ? [{ type: 'text', text: r.text }] : []), ...r.toolUses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input }))];
    messages.push({ role: 'assistant', content });
    const results = await Promise.all(
      r.toolUses.map(async (u) => {
        const tool = opts.tools?.find((t) => t.name === u.name);
        opts.onToolCall?.(u.name, u.input);
        try {
          if (!tool) return { id: u.id, value: `Unknown tool ${u.name}` as unknown, isError: true };
          return { id: u.id, value: await tool.execute(u.input), isError: false };
        } catch (err) {
          return { id: u.id, value: `Error: ${(err as Error)?.message ?? String(err)}` as unknown, isError: true };
        }
      }),
    );
    if (opts.signal?.aborted) throw new AiError('cancelled', AI_ERROR_COPY.cancelled, out || undefined);
    const used = utf8Len(JSON.stringify({ messages, tools }));
    const room = SERVER_REQUEST_MAX_BYTES - used - 160 * results.length;
    const per = Math.floor(room / Math.max(1, results.length));
    messages.push({
      role: 'user',
      content: results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: fitToolResult(x.value, per), ...(x.isError ? { is_error: true } : {}) })),
    });
  }
  const truncated = lastStop === 'max_tokens' || lastStop === 'model_context_window_exceeded';
  if (!out.trim()) {
    throw new AiError('empty_completion', truncated ? 'AI 응답이 길이 제한에 걸려 비어 있습니다. 범위를 줄여 다시 시도하세요.' : 'AI 응답이 비어 있습니다.');
  }
  // 아티팩트 경로(truncated)와 같은 안내 — 잘린 답 · 도구 왕복 상한에서 멈춘 답을 완결된 답처럼 보이지 않게 한다
  if (truncated) return `${out}\n\n_(응답 길이 제한으로 일부가 잘렸습니다)_`;
  if (roundCapHit) return `${out}\n\n_(도구 조회 ${SERVER_MAX_ROUNDS}회 상한에 도달해 여기서 멈췄습니다. 범위를 좁혀 다시 질문하세요)_`;
  return out;
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
