/**
 * ai 도메인 테스트 — 가짜 Anthropic 클라이언트(setAiClientFactory)로 실제 네트워크 없이 검사한다.
 * 스트리밍 이벤트 매핑 · tool_use 전달 · thinking 되돌려 보내기 · 월 한도 · 사용량 기록 · 권한 · 격리 · 키 없음 503 · 오류 매핑.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageStreamParams, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { createTestApp, type TestApp, type TestClient } from '../../test/app';
import { hashPassword } from '../lib/crypto';
import { setNowForTest } from '../lib/time';
import {
  DEFAULT_MONTHLY_TOKEN_LIMIT,
  MAX_REQUEST_BYTES,
  buildStreamParams,
  createSdkClient,
  parseAiRequest,
  mapAnthropicError,
  monthBounds,
  monthlyTokenLimit,
  runRound,
  setAiClientFactory,
  toEchoContent,
  usageFromMessage,
  type AiClient,
  type AiEvent,
  type AiStream,
} from './service';

/* ---------------- 가짜 Anthropic 클라이언트 ---------------- */

interface Script {
  events?: BetaRawMessageStreamEvent[];
  final?: BetaMessage;
  /** 스트림을 열 때(첫 이벤트 전) 던질 오류 */
  openError?: unknown;
  /** events를 모두 낸 뒤 던질 오류 (스트림 도중 끊김) */
  midError?: unknown;
}

const calls: BetaMessageStreamParams[] = [];
const keysSeen: string[] = [];
let queue: Script[] = [];

class FakeStream implements AiStream {
  readonly request_id = 'req_test_0001';
  constructor(private s: Script, private signal: AbortSignal) {}
  async *[Symbol.asyncIterator](): AsyncGenerator<BetaRawMessageStreamEvent> {
    if (this.s.openError) throw this.s.openError;
    for (const e of this.s.events ?? []) {
      if (this.signal.aborted) throw new Anthropic.APIUserAbortError();
      yield e;
    }
    if (this.s.midError) throw this.s.midError;
  }
  async finalMessage(): Promise<BetaMessage> {
    if (!this.s.final) throw new Error('final 없음');
    return this.s.final;
  }
  abort(): void { /* 가짜 */ }
}

const fakeFactory = (apiKey: string): AiClient => {
  keysSeen.push(apiKey);
  return {
    stream: (params, options) => {
      calls.push(JSON.parse(JSON.stringify(params)));
      const s = queue.shift();
      if (!s) throw new Error('예상하지 못한 Anthropic 호출');
      return new FakeStream(s, options.signal);
    },
  };
};

const usage = (o: Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number>> = {}, iterations: unknown[] | null = null) => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null,
  inference_geo: null, server_tool_use: null, service_tier: 'standard', fallback_credit: null, iterations, ...o,
});

const message = (content: unknown[], stop_reason: string, u = usage({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 })): BetaMessage =>
  ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, stop_details: null, usage: u, container: null, context_management: null } as unknown as BetaMessage);

/** 텍스트 델타 이벤트 열 (message_start → 델타들 → message_delta → message_stop) */
function textEvents(deltas: string[], stop = 'end_turn'): BetaRawMessageStreamEvent[] {
  return [
    { type: 'message_start', message: message([], stop, usage({ input_tokens: 120, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 })) },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
    ...deltas.map((d) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null } },
    { type: 'message_stop' },
  ] as unknown as BetaRawMessageStreamEvent[];
}

/** SSE 본문 → [{ event, data }] */
function sse(body: string): Array<{ event: string; data: any }> {
  return body
    .split(/\n\n/)
    .map((chunk) => chunk.split('\n').filter((l) => l && !l.startsWith(':')))
    .filter((lines) => lines.length)
    .map((lines) => ({
      event: lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'message',
      data: JSON.parse(lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')),
    }));
}

const SECRET_PROMPT = '비밀 프롬프트 — 매출 3억 원 기획전 문구';
const API_KEY = 'sk-ant-test-0123456789abcdef';

let t: TestApp;
let pm: TestClient;
let otherWs: string;
const url = () => `/api/w/${t.ws}/ai/messages`;
/** 역할별 로그인 클라이언트 재사용 — 로그인 경로의 분당 10회 제한(IP 기준)에 걸리지 않게 */
const clients = new Map<string, TestClient>();
async function as(role: 'owner' | 'admin' | 'pm' | 'ae' | 'client' | 'viewer'): Promise<TestClient> {
  let c = clients.get(role);
  if (!c) {
    c = await t.login(role);
    clients.set(role, c);
  }
  return c;
}

beforeAll(async () => {
  t = await createTestApp({ config: { anthropicApiKey: API_KEY, anthropicModel: 'claude-opus-5-5' } });
  setAiClientFactory(fakeFactory);
  pm = await as('pm');
  otherWs = (await t.db.query<{ id: string }>(`INSERT INTO workspaces (org_id, slug, name, brand_name) VALUES ($1, 'other-ai', '다른 브랜드', '다른') RETURNING id`, [t.orgId])).rows[0].id;
});
afterAll(async () => {
  setAiClientFactory(null);
  await t?.close();
});
beforeEach(async () => {
  calls.length = 0;
  queue = [];
  await t.db.query('DELETE FROM ai_usage');
  await t.db.query(`UPDATE workspaces SET config = '{}'::jsonb WHERE id = $1`, [t.ws]);
});

/* ---------------- 스트리밍 ---------------- */

describe('POST /ai/messages — 스트리밍 이벤트', () => {
  it('텍스트 델타 → text 이벤트, 끝에 done(stopReason · usage · content), 요청 형식은 askAnthropic과 같다', async () => {
    queue.push({ events: textEvents(['안녕', '하세요']), final: message([{ type: 'text', text: '안녕하세요', citations: null }], 'end_turn') });
    const r = await pm.post(url(), { messages: [{ role: 'user', content: SECRET_PROMPT }], purpose: 'agent' });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/event-stream');
    const ev = sse(r.body);
    expect(ev.filter((e) => e.event === 'text').map((e) => e.data.delta)).toEqual(['안녕', '하세요']);
    const done = ev.find((e) => e.event === 'done')!;
    expect(done.data).toMatchObject({
      stopReason: 'end_turn',
      usage: { inputTokens: 180, outputTokens: 30, cacheReadTokens: 50, cacheCreationTokens: 10 },
      content: [{ type: 'text', text: '안녕하세요' }],
      model: 'claude-opus-5-5',
    });
    expect(ev[ev.length - 1].event).toBe('done');

    expect(keysSeen.at(-1)).toBe(API_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: SECRET_PROMPT }],
    });
    expect(calls[0].tools).toBeUndefined();
  });

  it('tier · maxTokens를 반영한다 (quick → low, complex → high)', async () => {
    queue.push({ events: textEvents(['a']), final: message([{ type: 'text', text: 'a' }], 'end_turn') });
    queue.push({ events: textEvents(['b']), final: message([{ type: 'text', text: 'b' }], 'end_turn') });
    await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], tier: 'quick', maxTokens: 2000 });
    await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], tier: 'complex' });
    expect(calls[0]).toMatchObject({ max_tokens: 2000, output_config: { effort: 'low' } });
    expect(calls[1]).toMatchObject({ max_tokens: 16000, output_config: { effort: 'high' } });
  });

  it('tool_use 전달: stop_reason tool_use면 tool_use 이벤트, done.content에 thinking(서명) · tool_use를 그대로 담는다', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'text', text: '데이터를 확인하겠습니다.', citations: null },
      { type: 'text', text: '  ', citations: null },
      { type: 'tool_use', id: 'toolu_01', name: 'get_kpi', input: { media: 'naver', days: 7 } },
    ];
    queue.push({ events: textEvents(['데이터를 확인하겠습니다.'], 'tool_use'), final: message(content, 'tool_use') });
    const tools = [{ name: 'get_kpi', description: 'KPI 조회', input_schema: { type: 'object', properties: { media: { type: 'string' } }, required: ['media'] } }];
    const r = await pm.post(url(), { messages: [{ role: 'user', content: 'KPI 알려줘' }], tools });
    const ev = sse(r.body);
    const tu = ev.filter((e) => e.event === 'tool_use');
    expect(tu).toEqual([{ event: 'tool_use', data: { id: 'toolu_01', name: 'get_kpi', input: { media: 'naver', days: 7 } } }]);
    const done = ev.find((e) => e.event === 'done')!;
    expect(done.data.stopReason).toBe('tool_use');
    expect(done.data.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'text', text: '데이터를 확인하겠습니다.' },
      { type: 'tool_use', id: 'toolu_01', name: 'get_kpi', input: { media: 'naver', days: 7 } },
    ]);
    expect(calls[0].tools).toEqual(tools);

    // 두 번째 라운드: assistant content를 그대로 + tool_result → SDK에 그대로 전달
    queue.push({ events: textEvents(['네이버 7일 ROAS는 412%입니다.']), final: message([{ type: 'text', text: '네이버 7일 ROAS는 412%입니다.' }], 'end_turn') });
    const r2 = await pm.post(url(), {
      messages: [
        { role: 'user', content: 'KPI 알려줘' },
        { role: 'assistant', content: done.data.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"roas":4.12}' }] },
      ],
      tools,
    });
    expect(r2.status).toBe(200);
    expect(calls[1].messages).toEqual([
      { role: 'user', content: 'KPI 알려줘' },
      { role: 'assistant', content: done.data.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"roas":4.12}' }] },
    ]);
    expect(sse(r2.body).find((e) => e.event === 'done')!.data.stopReason).toBe('end_turn');
  });

  it('max_tokens로 끝나면 잘린 tool_use를 내보내지 않는다', async () => {
    queue.push({ events: textEvents(['…'], 'max_tokens'), final: message([{ type: 'tool_use', id: 'toolu_02', name: 'get_kpi', input: { media: 'na' } }], 'max_tokens') });
    const ev = sse((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'get_kpi', description: 'd', input_schema: { type: 'object' } }] })).body);
    expect(ev.some((e) => e.event === 'tool_use')).toBe(false);
    expect(ev.find((e) => e.event === 'done')!.data.stopReason).toBe('max_tokens');
  });

  it('서버 측 대체 모델 경계 (공식 표): 마지막 fallback 앞의 thinking · redacted_thinking · tool_use는 빼고 text · fallback · 경계 뒤 블록은 둔다, 사용량은 시도별 합계', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's1' },
      { type: 'redacted_thinking', data: 'enc-pre' },
      { type: 'text', text: '부분 답변', citations: null },
      { type: 'tool_use', id: 'toolu_pre', name: 'get_kpi', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: null } },
      { type: 'thinking', thinking: '', signature: 's2' },
      { type: 'text', text: '이어서 확인합니다.' },
      { type: 'tool_use', id: 'toolu_post', name: 'get_kpi', input: { media: 'meta' } },
    ];
    const u = usage({ input_tokens: 10, output_tokens: 5 }, [
      { type: 'message', input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null, model: 'claude-opus-5-5' },
      { type: 'fallback_message', input_tokens: 110, output_tokens: 60, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, cache_creation: null, model: 'claude-opus-4-8' },
    ]);
    queue.push({ events: textEvents(['이어서 확인합니다.'], 'tool_use'), final: { ...message(content, 'tool_use', u), model: 'claude-opus-4-8' } as BetaMessage });
    const ev = sse((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'get_kpi', description: 'd', input_schema: { type: 'object' } }] })).body);
    expect(ev.filter((e) => e.event === 'tool_use').map((e) => e.data.id)).toEqual(['toolu_post']);
    const done = ev.find((e) => e.event === 'done')!.data;
    expect(done.content).toEqual([
      { type: 'text', text: '부분 답변' },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: null } },
      { type: 'thinking', thinking: '', signature: 's2' },
      { type: 'text', text: '이어서 확인합니다.' },
      { type: 'tool_use', id: 'toolu_post', name: 'get_kpi', input: { media: 'meta' } },
    ]);
    expect(done.usage).toEqual({ inputTokens: 230, outputTokens: 100, cacheReadTokens: 20, cacheCreationTokens: 0 });
    expect(done.model).toBe('claude-opus-4-8');
    const row = (await t.db.query<{ served_model: string; input_tokens: number }>('SELECT served_model, input_tokens FROM ai_usage')).rows[0];
    expect(row).toEqual({ served_model: 'claude-opus-4-8', input_tokens: 230 });

    // 다음 라운드: done.content를 그대로 되돌려 보내면 검증을 통과하고 fallback 블록이 같은 자리로 SDK에 간다
    queue.push({ events: textEvents(['끝']), final: message([{ type: 'text', text: '끝' }], 'end_turn') });
    const r2 = await pm.post(url(), {
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: done.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_post', content: '{"roas":3.1}' }] },
      ],
      tools: [{ name: 'get_kpi', description: 'd', input_schema: { type: 'object' } }],
    });
    expect(r2.status).toBe(200);
    expect((calls[1].messages[1].content as Array<{ type: string }>).map((b) => b.type)).toEqual(['text', 'fallback', 'thinking', 'text', 'tool_use']);
  });

  it('refusal은 done(stopReason refusal, content 비움)으로 알린다', async () => {
    queue.push({ events: textEvents([], 'refusal'), final: message([], 'refusal') });
    const ev = sse((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] })).body);
    expect(ev.find((e) => e.event === 'done')!.data).toMatchObject({ stopReason: 'refusal', content: [] });
  });
});

/* ---------------- 오류 매핑 ---------------- */

describe('Anthropic 오류 → 한국어 error 이벤트', () => {
  const headers = new Headers();
  const cases: Array<[string, unknown, string]> = [
    ['429', new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 'rate', headers), 'rate_limited'],
    ['529', Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 'over', headers), 'overloaded'],
    ['400', new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, 'bad', headers), 'invalid_request'],
    ['401', new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'auth', headers), 'ai_auth'],
    ['연결', new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'upstream_error'],
  ];
  for (const [label, err, code] of cases) {
    it(`${label} → ${code}`, async () => {
      queue.push({ openError: err });
      const r = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] });
      expect(r.status).toBe(200);
      const ev = sse(r.body);
      expect(ev).toHaveLength(1);
      expect(ev[0].event).toBe('error');
      expect(ev[0].data.code).toBe(code);
      expect(ev[0].data.message).toMatch(/[가-힣]/);
      expect(ev[0].data.message).not.toContain('x');
      const row = (await t.db.query<{ status: string; error_code: string }>('SELECT status, error_code FROM ai_usage')).rows[0];
      expect(row).toEqual({ status: 'error', error_code: code });
    });
  }

  it('스트림 도중 끊기면 받은 텍스트 뒤에 error 이벤트, 관측한 사용량을 기록', async () => {
    // SDK는 스트림 중 'event: error'를 상태 없는 APIError(type 포함)로 던진다 (core/streaming.js)
    const mid = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error');
    queue.push({ events: textEvents(['부분 ', '답변']).slice(0, 4), midError: mid });
    const ev = sse((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] })).body);
    expect(ev.map((e) => e.event)).toEqual(['text', 'text', 'error']);
    expect(ev[2].data.code).toBe('overloaded');
    const row = (await t.db.query<{ status: string; input_tokens: number }>('SELECT status, input_tokens FROM ai_usage')).rows[0];
    expect(row).toEqual({ status: 'error', input_tokens: 180 });
  });

  it('mapAnthropicError: 중지 · 알 수 없는 오류', () => {
    expect(mapAnthropicError(new Anthropic.APIUserAbortError()).code).toBe('cancelled');
    expect(mapAnthropicError(new Error('boom')).code).toBe('upstream_error');
    expect(mapAnthropicError(Anthropic.APIError.generate(404, { type: 'error', error: { type: 'not_found_error', message: 'model' } }, 'nf', new Headers())).code).toBe('model_unavailable');
    expect(mapAnthropicError(Anthropic.APIError.generate(413, { type: 'error', error: { type: 'request_too_large', message: 'big' } }, 'big', new Headers())).code).toBe('prompt_too_large');
  });
});

/* ---------------- 중지 (runRound 직접) ---------------- */

describe('runRound — 중지', () => {
  it('신호가 끊기면 cancelled, error 이벤트를 내보내지 않고 관측 사용량을 돌려준다', async () => {
    const ctl = new AbortController();
    const events = textEvents(['하나', '둘', '셋']);
    const client: AiClient = {
      stream: (_p, o) => ({
        request_id: null,
        async *[Symbol.asyncIterator]() {
          for (const e of events) {
            if (o.signal.aborted) throw new Anthropic.APIUserAbortError();
            yield e;
            if (e.type === 'content_block_delta') ctl.abort();
          }
        },
        finalMessage: async () => message([], 'end_turn'),
        abort: () => undefined,
      }),
    };
    const got: AiEvent[] = [];
    const r = await runRound(client, { model: 'm', max_tokens: 1, messages: [] }, ctl.signal, (e) => got.push(e));
    expect(r.status).toBe('cancelled');
    expect(r.errorCode).toBe('cancelled');
    expect(got.map((e) => e.event)).toEqual(['text']);
    expect(r.usage.inputTokens).toBe(180);
  });
});

/* ---------------- 공식 SDK 직렬화 · 스트림 해석 (가짜 HTTP) ---------------- */

describe('공식 SDK 경로 (가짜 fetch — 네트워크 없음)', () => {
  /** Messages API 스트리밍 응답 형식 (https://platform.claude.com/docs/en/build-with-claude/streaming) */
  const wire = (events: unknown[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const WIRE = wire([
    { type: 'message_start', message: { id: 'msg_w1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-wire' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '네이버 ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '확인' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_w1', name: 'get_kpi', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"media":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"naver"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ]);

  it('요청 헤더 · 본문이 문서 형식이고, SDK가 누적한 최종 메시지로 tool_use · done을 만든다', async () => {
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(WIRE, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_wire_1' } });
    }) as typeof fetch;
    const client = createSdkClient('sk-ant-wire-test', { fetch: fakeFetch });
    const req = parseAiRequest({ messages: [{ role: 'user', content: '네이버 KPI' }], tools: [{ name: 'get_kpi', description: 'KPI', input_schema: { type: 'object' } }], purpose: 'agent' });
    const got: AiEvent[] = [];
    const r = await runRound(client, buildStreamParams(req, 'claude-opus-5-5'), new AbortController().signal, (e) => got.push(e));

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/v1\/messages(\?beta=true)?$/);
    // SDK 1.x는 API 키를 Authorization: Bearer로 보낸다 (이전 버전은 x-api-key)
    expect(seen[0].headers.get('x-api-key') ?? seen[0].headers.get('authorization')).toMatch(/^(Bearer )?sk-ant-wire-test$/);
    expect(seen[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(seen[0].body).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 16000, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
      fallbacks: 'default', cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: '네이버 KPI' }],
      tools: [{ name: 'get_kpi', description: 'KPI', input_schema: { type: 'object' } }],
    });
    expect(seen[0].body.betas).toBeUndefined();
    expect(seen[0].body.purpose).toBeUndefined();

    expect(got.map((e) => e.event)).toEqual(['text', 'text', 'tool_use', 'done']);
    expect(got[2].data).toEqual({ id: 'toolu_w1', name: 'get_kpi', input: { media: 'naver' } });
    expect(got[3].data).toMatchObject({
      stopReason: 'tool_use',
      usage: { inputTokens: 312, outputTokens: 42, cacheReadTokens: 300, cacheCreationTokens: 0 },
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-wire' },
        { type: 'text', text: '네이버 확인' },
        { type: 'tool_use', id: 'toolu_w1', name: 'get_kpi', input: { media: 'naver' } },
      ],
    });
    expect(r).toMatchObject({ status: 'ok', stopReason: 'tool_use', requestId: 'req_wire_1' });
  });

  it('HTTP 429 응답은 SDK 재시도 뒤 rate_limited로 바뀐다 (retry-after 0)', async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0', 'x-should-retry': 'true' },
      });
    }) as typeof fetch;
    const client = createSdkClient('sk-ant-wire-test', { fetch: fakeFetch });
    const got: AiEvent[] = [];
    const r = await runRound(client, buildStreamParams(parseAiRequest({ messages: [{ role: 'user', content: 'q' }] }), 'claude-opus-5-5'), new AbortController().signal, (e) => got.push(e));
    expect(n).toBe(3);
    expect(got).toEqual([{ event: 'error', data: { code: 'rate_limited', message: expect.stringMatching(/요청 한도/) } }]);
    expect(r.status).toBe('error');
  });
});

/* ---------------- 실제 HTTP: 연결 끊김 → 상류 중지 ---------------- */

describe('실제 HTTP 소켓', () => {
  it('SSE가 조각 단위로 흘러오고, 클라이언트가 끊으면 Anthropic 스트림 신호가 끊기고 cancelled로 기록된다', async () => {
    let upstreamSignal: AbortSignal | null = null;
    let release: () => void = () => undefined;
    const slow: AiClient = {
      stream: (_p, o) => {
        upstreamSignal = o.signal;
        return {
          request_id: 'req_slow',
          async *[Symbol.asyncIterator]() {
            for (const e of textEvents(['첫 조각']).slice(0, 3)) yield e;
            // 클라이언트가 끊을 때까지 대기 (adaptive thinking으로 긴 공백이 생기는 상황)
            await new Promise<void>((r) => { release = r; o.signal.addEventListener('abort', () => r(), { once: true }); });
            if (o.signal.aborted) throw new Anthropic.APIUserAbortError();
          },
          finalMessage: async () => message([{ type: 'text', text: '첫 조각' }], 'end_turn'),
          abort: () => undefined,
        };
      },
    };
    setAiClientFactory(() => slow);
    try {
      const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
      const login = await fetch(`${address}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ae@test.local', password: 'TestPass#2027' }) });
      const jar = Object.fromEntries(login.headers.getSetCookie().map((c) => c.split(';')[0].split('=') as [string, string]));
      const ctl = new AbortController();
      const res = await fetch(`${address}${url()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `mildo_sid=${jar.mildo_sid}; mildo_csrf=${jar.mildo_csrf}`, 'x-csrf-token': decodeURIComponent(jar.mildo_csrf) },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }], purpose: 'agent' }),
        signal: ctl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const reader = res.body!.getReader();
      let got = '';
      while (!got.includes('첫 조각')) got += new TextDecoder().decode((await reader.read()).value);
      expect(got).toContain('event: text');
      ctl.abort();
      await reader.cancel().catch(() => undefined);
      let row: { status: string; error_code: string; user_id: string } | undefined;
      for (let i = 0; i < 50 && !row; i++) {
        await new Promise((r) => setTimeout(r, 20));
        row = (await t.db.query<{ status: string; error_code: string; user_id: string }>('SELECT status, error_code, user_id FROM ai_usage')).rows[0];
      }
      expect(upstreamSignal!.aborted).toBe(true);
      expect(row).toEqual({ status: 'cancelled', error_code: 'cancelled', user_id: t.userIds.ae });
    } finally {
      release();
      setAiClientFactory(fakeFactory);
    }
  });
});

/* ---------------- 검증 ---------------- */

describe('입력 검증', () => {
  const tool = (i: number) => ({ name: `tool_${i}`, description: 'd', input_schema: { type: 'object' } });
  it('도구 65개 → 400 too_many_tools, 64개는 통과', async () => {
    const bad = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], tools: Array.from({ length: 65 }, (_, i) => tool(i)) });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('too_many_tools');
    queue.push({ events: textEvents(['ok']), final: message([{ type: 'text', text: 'ok' }], 'end_turn') });
    const ok = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], tools: Array.from({ length: 64 }, (_, i) => tool(i)) });
    expect(ok.status).toBe(200);
  });

  it('256KB 초과 → 413 prompt_too_large (한글 바이트 기준)', async () => {
    const big = '가'.repeat(Math.ceil(MAX_REQUEST_BYTES / 3) + 10);
    const r = await pm.post(url(), { messages: [{ role: 'user', content: big }] });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('prompt_too_large');
    expect(calls).toHaveLength(0);
  });

  it('형식 오류 → 400 (첫 메시지 assistant · 역할에 맞지 않는 블록 · 허용하지 않는 블록 · 서버 도구 · 중복 도구 · 빈 메시지)', async () => {
    const bodies: unknown[] = [
      { messages: [] },
      { messages: [{ role: 'assistant', content: 'hi' }] },
      { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] }] },
      { messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'a', name: 'b', input: {} }] }] },
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] }] },
      { messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
      { messages: [{ role: 'user', content: 'q' }], tools: [tool(1), tool(1)] },
      { messages: [{ role: 'user', content: '   ' }] },
      { messages: [{ role: 'system', content: 'q' }] },
      { messages: [{ role: 'user', content: 'q' }], maxTokens: 999999 },
      { messages: [{ role: 'user', content: 'q' }], purpose: '용도 공백' },
      // assistant 미리 채우기(prefill) — 4.6 이후 모델은 모두 거절하므로 호출 전에 막는다
      { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '{"' }] },
    ];
    // 분당 호출 상한(사용자별 40회)이 pm의 다른 테스트 호출과 겹치지 않게 admin으로 보낸다
    const admin = await as('admin');
    for (const b of bodies) {
      const r = await admin.post(url(), b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.message).toMatch(/[가-힣]/);
    }
    expect(calls).toHaveLength(0);
  });
});

/* ---------------- 권한 · 격리 · 설정 ---------------- */

describe('권한 · 격리 · 서버 키', () => {
  it('viewer 403(사용량 기록 없음), 비로그인 401, owner · admin · pm · ae · client는 사용 가능 (request 권한)', async () => {
    const viewer = await as('viewer');
    const r = await viewer.post(url(), { messages: [{ role: 'user', content: 'q' }] });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
    expect((await t.anon().post(url(), { messages: [{ role: 'user', content: 'q' }] })).status).toBe(401);
    expect((await t.db.query('SELECT 1 FROM ai_usage')).rowCount).toBe(0);
    for (const role of ['owner', 'admin', 'pm', 'ae', 'client'] as const) {
      queue.push({ events: textEvents(['ok']), final: message([{ type: 'text', text: 'ok' }], 'end_turn') });
      const c = await as(role);
      expect((await c.post(url(), { messages: [{ role: 'user', content: 'q' }] })).status, role).toBe(200);
    }
    expect(calls).toHaveLength(5);
    const users = (await t.db.query<{ user_id: string }>('SELECT user_id FROM ai_usage ORDER BY id')).rows.map((x) => x.user_id);
    expect(users).toEqual([t.userIds.owner, t.userIds.admin, t.userIds.pm, t.userIds.ae, t.userIds.client]);
  });

  it('잠긴(읽기 전용) 워크스페이스 → POST 423, 사용량 API는 canUse · available false', async () => {
    await t.db.query(`UPDATE workspaces SET status = 'suspended' WHERE id = $1`, [t.ws]);
    try {
      const r = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] });
      expect(r.status).toBe(423);
      expect(r.json.error.code).toBe('workspace_locked');
      const u = await pm.get(`/api/w/${t.ws}/ai/usage`);
      expect(u.status).toBe(200);
      expect(u.json).toMatchObject({ canUse: false, available: false });
    } finally {
      await t.db.query(`UPDATE workspaces SET status = 'active' WHERE id = $1`, [t.ws]);
    }
    expect(calls).toHaveLength(0);
  });

  it('사용자별 분당 40회 상한 → 429 rate_limited (다른 사용자는 영향 없음)', async () => {
    // 이 파일의 다른 테스트가 쓴 호출 수와 섞이지 않게 새 사용자로 잰다
    const { rows } = await t.db.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ('ratelimit-ai@test.local', '속도 제한 확인', $1) RETURNING id`,
      [await hashPassword('TestPass#2027')],
    );
    await t.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'ae')`, [t.ws, rows[0].id]);
    const fresh = await t.login('ratelimit-ai@test.local', 'TestPass#2027');
    const codes: number[] = [];
    for (let i = 0; i < 41; i++) codes.push((await fresh.post(url(), { messages: [] })).status);
    expect(codes.slice(0, 40).every((c) => c === 400)).toBe(true);
    expect(codes[40]).toBe(429);
    const last = await fresh.post(url(), { messages: [] });
    expect(last.json.error.code).toBe('rate_limited');
    const other = await as('viewer');
    expect((await other.post(url(), { messages: [] })).status).toBe(403);
  });

  it('CSRF 토큰 없이 보내면 403', async () => {
    const r = await pm.raw({ method: 'POST', url: url(), payload: { messages: [{ role: 'user', content: 'q' }] }, headers: { 'x-csrf-token': 'forged' } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('csrf');
  });

  it('멤버가 아닌 워크스페이스 → 404 (호출 · 사용량 모두), 다른 워크스페이스 사용량은 섞이지 않는다', async () => {
    expect((await pm.post(`/api/w/${otherWs}/ai/messages`, { messages: [{ role: 'user', content: 'q' }] })).status).toBe(404);
    expect((await pm.get(`/api/w/${otherWs}/ai/usage`)).status).toBe(404);
    await t.db.query(`INSERT INTO ai_usage (workspace_id, model, purpose, input_tokens, output_tokens) VALUES ($1, 'claude-opus-5-5', 'agent', 5000, 500)`, [otherWs]);
    const mine = await pm.get(`/api/w/${t.ws}/ai/usage`);
    expect(mine.json).toMatchObject({ inputTokens: 0, outputTokens: 0, calls: 0 });
    expect(calls).toHaveLength(0);
  });

  it('ANTHROPIC_API_KEY가 없으면 503 ai_not_configured (한국어), 사용량 API는 configured:false', async () => {
    const saved = t.config.anthropicApiKey;
    t.config.anthropicApiKey = null;
    try {
      const r = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] });
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('ai_not_configured');
      expect(r.json.error.message).toContain('ANTHROPIC_API_KEY');
      const u = await pm.get(`/api/w/${t.ws}/ai/usage`);
      expect(u.json).toMatchObject({ configured: false, available: false });
    } finally {
      t.config.anthropicApiKey = saved;
    }
    expect(calls).toHaveLength(0);
  });

  it('워크스페이스 설정 ai.enabled=false → 403 ai_disabled', async () => {
    await t.db.query(`UPDATE workspaces SET config = '{"ai":{"enabled":false}}'::jsonb WHERE id = $1`, [t.ws]);
    const r = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('ai_disabled');
  });
});

/* ---------------- 한도 · 사용량 ---------------- */

describe('월 한도 · 사용량 기록', () => {
  it('호출마다 ai_usage에 토큰 · 용도 · 사용자 · 결과를 남기고, 메시지 본문은 어디에도 남기지 않는다', async () => {
    queue.push({ events: textEvents(['답']), final: message([{ type: 'text', text: '답' }], 'end_turn') });
    await pm.post(url(), { messages: [{ role: 'user', content: SECRET_PROMPT }], purpose: 'reports:interp' });
    const rows = (await t.db.query<Record<string, unknown>>('SELECT * FROM ai_usage')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: t.ws, user_id: t.userIds.pm, model: 'claude-opus-5-5', purpose: 'reports:interp',
      input_tokens: 180, output_tokens: 30, cache_read_tokens: 50, cache_creation_tokens: 10, status: 'ok', stop_reason: 'end_turn', request_id: 'req_test_0001',
    });
    const dump = JSON.stringify(rows) + JSON.stringify((await t.db.query('SELECT * FROM audit_log')).rows);
    expect(dump).not.toContain(SECRET_PROMPT);
    expect(dump).not.toContain(API_KEY);
  });

  it('이번 달 사용량이 한도 이상이면 429 budget_exceeded (호출하지 않음), 감사는 월 1회, 지난달 사용량은 세지 않는다', async () => {
    await t.db.query(`UPDATE workspaces SET config = '{"ai":{"monthlyTokenLimit":1000}}'::jsonb WHERE id = $1`, [t.ws]);
    await t.db.query(`INSERT INTO ai_usage (workspace_id, user_id, model, purpose, input_tokens, output_tokens, at) VALUES ($1, $2, 'm', 'agent', 50000, 5000, now() - interval '40 days')`, [t.ws, t.userIds.pm]);
    queue.push({ events: textEvents(['ok']), final: message([{ type: 'text', text: 'ok' }], 'end_turn') });
    expect((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] })).status).toBe(200);
    await t.db.query(`INSERT INTO ai_usage (workspace_id, user_id, model, purpose, input_tokens, output_tokens) VALUES ($1, $2, 'm', 'agent', 700, 100)`, [t.ws, t.userIds.ae]);
    // 이번 달: 180 + 30 (방금 호출) + 800 = 1010 ≥ 1000
    const before = (await t.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ai.budget_exceeded'`)).rows[0] as { n: number };
    const r = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('budget_exceeded');
    expect(r.json.error.message).toContain('1,000');
    expect(r.json.error.detail).toMatchObject({ limit: 1000, used: 1010 });
    expect((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] })).status).toBe(429);
    const after = (await t.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ai.budget_exceeded'`)).rows[0] as { n: number };
    expect(after.n - before.n).toBeLessThanOrEqual(1);
    expect(after.n).toBe(1);
    expect(calls).toHaveLength(1);

    const u = await pm.get(`/api/w/${t.ws}/ai/usage`);
    expect(u.json).toMatchObject({ limit: 1000, inputTokens: 880, outputTokens: 130, totalTokens: 1010, remaining: 0, budgetExceeded: true });
    // 비율은 0~1 (넘은 양은 totalTokens · limit로)
    expect(u.json.usedRatio).toBe(1);
  });

  it('KST 월 경계: 10/31 23:59 KST 사용량은 10월, 11/01 00:00 KST부터 11월 — 한도 판정 · 기록 · 일별 집계가 같은 기준', async () => {
    await t.db.query(`UPDATE workspaces SET config = '{"ai":{"monthlyTokenLimit":500}}'::jsonb WHERE id = $1`, [t.ws]);
    // 2026-10-31T14:59:59Z = 10/31 23:59:59 KST (10월) · 2026-10-31T15:00:00Z = 11/01 00:00 KST (11월)
    await t.db.query(
      `INSERT INTO ai_usage (workspace_id, user_id, model, purpose, input_tokens, output_tokens, at)
       VALUES ($1, $2, 'm', 'agent', 900, 100, '2026-10-31T14:59:59Z'), ($1, $2, 'm', 'agent', 40, 10, '2026-10-31T15:00:00Z')`,
      [t.ws, t.userIds.pm],
    );
    try {
      // UTC로는 아직 10/31이지만 KST로는 11/01 — 10월의 1,000 토큰은 11월 한도에 세지 않는다
      setNowForTest(Date.parse('2026-10-31T15:30:00Z'));
      queue.push({ events: textEvents(['ok']), final: message([{ type: 'text', text: 'ok' }], 'end_turn') });
      expect((await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] })).status).toBe(200);
      const rec = (await t.db.query<{ at: Date }>(`SELECT at FROM ai_usage WHERE request_id = 'req_test_0001'`)).rows[0];
      expect(rec.at.toISOString()).toBe('2026-10-31T15:30:00.000Z');
      const nov = await pm.get(`/api/w/${t.ws}/ai/usage`);
      expect(nov.json).toMatchObject({ month: '2026-11', inputTokens: 40 + 180, outputTokens: 10 + 30, calls: 2 });
      expect(nov.json.daily).toEqual([{ date: '2026-11-01', calls: 2, inputTokens: 220, outputTokens: 40 }]);
      const oct = await pm.get(`/api/w/${t.ws}/ai/usage?month=2026-10`);
      expect(oct.json).toMatchObject({ month: '2026-10', inputTokens: 900, outputTokens: 100, calls: 1, budgetExceeded: true });
      expect(oct.json.daily).toEqual([{ date: '2026-10-31', calls: 1, inputTokens: 900, outputTokens: 100 }]);

      // 10/31 23:59 KST에 보면 10월 사용량(1,000 ≥ 500)으로 막힌다
      setNowForTest(Date.parse('2026-10-31T14:59:00Z'));
      const blocked = await pm.post(url(), { messages: [{ role: 'user', content: 'q' }] });
      expect(blocked.status).toBe(429);
      expect(blocked.json.error.detail).toMatchObject({ month: '2026-10', limit: 500, used: 1000 });
    } finally {
      setNowForTest(null);
    }
    expect(calls).toHaveLength(1);
  });

  it('GET /ai/usage — 월 · 합계 · 한도(기본 3,000만) · 용도별 · 일별, 사용자별은 configure 권한만', async () => {
    queue.push({ events: textEvents(['a']), final: message([{ type: 'text', text: 'a' }], 'end_turn') });
    queue.push({ events: textEvents(['b']), final: message([{ type: 'text', text: 'b' }], 'end_turn') });
    await pm.post(url(), { messages: [{ role: 'user', content: 'q' }], purpose: 'agent' });
    const ae = await as('ae');
    await ae.post(url(), { messages: [{ role: 'user', content: 'q' }] });
    const r = await pm.get(`/api/w/${t.ws}/ai/usage`);
    expect(r.status).toBe(200);
    expect(r.json.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.json).toMatchObject({
      inputTokens: 360, outputTokens: 60, limit: DEFAULT_MONTHLY_TOKEN_LIMIT, calls: 2, configured: true, enabled: true, canUse: true, available: true, model: 'claude-opus-5-5',
    });
    expect(r.json.byPurpose).toEqual(expect.arrayContaining([
      { purpose: 'agent', calls: 1, inputTokens: 180, outputTokens: 30 },
      { purpose: 'general', calls: 1, inputTokens: 180, outputTokens: 30 },
    ]));
    expect(r.json.daily).toHaveLength(1);
    expect(r.json.byUser.map((x: { name: string }) => x.name).sort()).toEqual(['테스트 ae', '테스트 pm']);
    expect(r.body).not.toContain(API_KEY);

    const aeView = await ae.get(`/api/w/${t.ws}/ai/usage`);
    expect(aeView.json.byUser).toBeUndefined();
    const viewer = await as('viewer');
    const vView = await viewer.get(`/api/w/${t.ws}/ai/usage`);
    expect(vView.status).toBe(200);
    expect(vView.json).toMatchObject({ canUse: false, available: false });

    const past = await pm.get(`/api/w/${t.ws}/ai/usage?month=2020-01`);
    expect(past.json).toMatchObject({ month: '2020-01', calls: 0, inputTokens: 0 });
    expect((await pm.get(`/api/w/${t.ws}/ai/usage?month=2020-13`)).status).toBe(400);
  });
});

/* ---------------- 순수 함수 ---------------- */

describe('순수 함수', () => {
  it('monthBounds — 12월은 다음 해 1월로', () => {
    expect(monthBounds('2026-12')).toEqual({ from: '2026-12-01T00:00:00+09:00', to: '2027-01-01T00:00:00+09:00' });
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01T00:00:00+09:00', to: '2026-03-01T00:00:00+09:00' });
  });
  it('monthlyTokenLimit — 기본값 · 숫자 문자열 · 잘못된 값', () => {
    expect(monthlyTokenLimit({})).toBe(30_000_000);
    expect(monthlyTokenLimit({ ai: { monthlyTokenLimit: '5000000' } })).toBe(5_000_000);
    expect(monthlyTokenLimit({ ai: { monthlyTokenLimit: -1 } })).toBe(30_000_000);
    expect(monthlyTokenLimit({ ai: { monthlyTokenLimit: 0 } })).toBe(0);
    expect(monthlyTokenLimit({ ai: 'x' })).toBe(30_000_000);
  });
  it('usageFromMessage — iterations가 없으면 최상위, 있으면 시도별 합계', () => {
    expect(usageFromMessage(usage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }) as never)).toEqual({ inputTokens: 4, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0 });
    expect(usageFromMessage(null)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });
  it('buildStreamParams — fallbacks · 베타 헤더는 문서의 지원 모델에만 (그 밖의 모델에 보내 모든 호출이 400이 되지 않게)', () => {
    const req = parseAiRequest({ messages: [{ role: 'user', content: 'q' }] });
    for (const m of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(buildStreamParams(req, m), m).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    }
    const old = buildStreamParams(req, 'claude-opus-4-8') as unknown as Record<string, unknown>;
    expect(old.fallbacks).toBeUndefined();
    expect(old.betas).toBeUndefined();
    expect(old).toMatchObject({ model: 'claude-opus-4-8', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral' } });
  });

  it('toEchoContent — 경계 앞 thinking · tool_use 제외는 마지막 fallback 기준, fallback이 없으면 모두 그대로', () => {
    const noFallback = toEchoContent([
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'tool_use', id: 't1', name: 'x', input: { k: 1 } },
    ] as never);
    expect(noFallback.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(noFallback.toolUses).toEqual([{ id: 't1', name: 'x', input: { k: 1 } }]);
    const two = toEchoContent([
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' }, trigger: null },
      { type: 'thinking', thinking: '', signature: 'b' },
      { type: 'fallback', from: { model: 'b' }, to: { model: 'c' }, trigger: null },
      { type: 'thinking', thinking: '', signature: 'c' },
    ] as never);
    expect(two.content.map((b) => (b.type === 'thinking' ? `thinking:${b.signature}` : b.type))).toEqual(['fallback', 'fallback', 'thinking:c']);
  });

  it('toEchoContent — 빈 텍스트 · 알 수 없는 블록은 뺀다', () => {
    const r = toEchoContent([
      { type: 'text', text: '', citations: null },
      { type: 'redacted_thinking', data: 'enc' },
      { type: 'server_tool_use', id: 's', name: 'web_search', input: {} },
    ] as never);
    expect(r.content).toEqual([{ type: 'redacted_thinking', data: 'enc' }]);
    expect(r.toolUses).toEqual([]);
  });
});
