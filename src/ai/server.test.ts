/**
 * 서버 백엔드(MILDO OS Cloud) — SSE 파서 · 백엔드 결정 · 클라이언트 도구 루프 · 오류 매핑 · 중지.
 * 가짜 fetch로 /api/w/:ws/ai/messages(SSE)와 /ai/usage를 흉내 낸다 (실제 네트워크 없음).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseParser, readSse, type SseEvent } from './sse';

type G = { window?: unknown; document?: unknown; location?: unknown; fetch?: unknown };
const g = globalThis as unknown as G;
const realFetch = globalThis.fetch;

afterEach(() => {
  delete g.window;
  delete g.document;
  delete g.location;
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
});

const WS = '11111111-2222-3333-4444-555555555555';
const settings = { mode: 'auto' as const, apiKey: '', model: 'claude-opus-5-5' };

/* ---------------- SSE 파서 ---------------- */

describe('SseParser', () => {
  const STREAM = 'event: text\ndata: {"delta":"안녕"}\n\n: ping 123\n\nevent: text\r\ndata: {"delta":"하세요"}\r\n\r\nevent: done\rdata: {"a":1,\rdata: "b":2}\r\rdata: plain\n\n';
  const EXPECTED: SseEvent[] = [
    { event: 'text', data: '{"delta":"안녕"}' },
    { event: 'text', data: '{"delta":"하세요"}' },
    { event: 'done', data: '{"a":1,\n"b":2}' },
    { event: 'message', data: 'plain' },
  ];

  it('LF · CRLF · CR 줄 끝, 주석(ping), 여러 data 줄, 기본 이벤트 이름', () => {
    const p = new SseParser();
    expect([...p.push(STREAM), ...p.end()]).toEqual(EXPECTED);
  });

  it('조각 경계가 어디에 있어도 같은 결과 (한 글자씩 · \\r 다음 \\n이 다음 조각)', () => {
    const p = new SseParser();
    const out: SseEvent[] = [];
    for (const ch of STREAM) out.push(...p.push(ch));
    out.push(...p.end());
    expect(out).toEqual(EXPECTED);
  });

  it('빈 줄 없이 끝난 마지막 이벤트도 end()에서 내보내고, data 없는 이벤트는 버린다', () => {
    const p = new SseParser();
    expect(p.push('event: done\ndata: {"x":1}')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'done', data: '{"x":1}' }]);
    const q = new SseParser();
    expect([...q.push('event: hello\n\n'), ...q.end()]).toEqual([]);
  });

  it('readSse — 바이트 조각이 멀티바이트 글자 중간에서 끊겨도 복원', async () => {
    const bytes = new TextEncoder().encode('event: text\ndata: {"delta":"수면밀도"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5));
        c.close();
      },
    });
    const got: SseEvent[] = [];
    await readSse(stream, (e) => got.push(e));
    expect(got).toEqual([{ event: 'text', data: '{"delta":"수면밀도"}' }]);
  });
});

/* ---------------- 가짜 서버 ---------------- */

interface Sent { url: string; method: string; headers: Record<string, string>; body: any }

function sseBody(events: Array<[string, unknown]>, o: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      if (!o.hang) c.close();
    },
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: Array<[string, unknown]>, o: { hang?: boolean } = {}) => new Response(sseBody(events, o), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const done = (stopReason: string, content: unknown[] = []) => ['done', { stopReason, usage: { inputTokens: 10, outputTokens: 5 }, content, model: 'claude-opus-5-5' }] as [string, unknown];

/** rounds: messages 호출마다 돌려줄 응답, usage: GET /ai/usage 응답 */
function installFetch(rounds: Array<Response | ((sent: Sent, signal?: AbortSignal) => Response)>, usage: unknown = { available: true }) {
  const sent: Sent[] = [];
  const fake = vi.fn(async (url: string, init: RequestInit = {}) => {
    const s: Sent = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    if (url.includes('/ai/usage')) return typeof usage === 'number' ? json(usage, { error: { code: 'x', message: 'y' } }) : json(200, usage);
    sent.push(s);
    const next = rounds.shift();
    if (!next) throw new Error('예상하지 못한 호출');
    return typeof next === 'function' ? next(s, init.signal ?? undefined) : next;
  });
  (globalThis as { fetch: unknown }).fetch = fake;
  return { sent, fake };
}

async function load(o: { ws?: string | null; hash?: string; cookie?: string } = {}) {
  vi.resetModules();
  g.window = {};
  g.location = { hash: o.hash ?? '#agent' };
  g.document = { cookie: o.cookie ?? 'theme=dark; mildo_csrf=csrf%2Btok' };
  const m = await import('./claude');
  if (o.ws !== null) m.configureServerAi({ workspaceId: o.ws ?? WS });
  return m;
}

/* ---------------- 백엔드 결정 ---------------- */

describe('resolveBackend — server', () => {
  it('auto + 서버 워크스페이스 → server, 라벨', async () => {
    installFetch([]);
    const m = await load();
    expect(await m.resolveBackend(settings)).toBe('server');
    expect(m.BACKEND_LABEL.server).toBe('Claude 연결됨 (MILDO 서버)');
  });

  it('워크스페이스가 없으면 기존 순서(artifact → anthropic → none), 명시적 server는 none', async () => {
    installFetch([]);
    const m = await load({ ws: null });
    expect(await m.resolveBackend(settings)).toBe('none');
    expect(await m.resolveBackend({ ...settings, apiKey: 'sk-x' })).toBe('anthropic');
    expect(await m.resolveBackend({ ...settings, mode: 'server' })).toBe('none');
    expect(await m.resolveBackend({ ...settings, mode: 'offline' })).toBe('none');
  });

  it('서버가 쓸 수 없다고 답하면(키 없음 · 권한 없음) 다음 순서로, 확인 요청은 한 번만 — API 키는 서버 CSP가 허용할 때만', async () => {
    const { fake } = installFetch([], { available: false, configured: false, browserDirect: true });
    const m = await load();
    expect(await m.resolveBackend(settings)).toBe('none');
    expect(await m.resolveBackend({ ...settings, apiKey: 'sk-x' })).toBe('anthropic');
    expect(await m.resolveBackend({ ...settings, mode: 'server' })).toBe('none');
    expect(fake.mock.calls.filter(([u]) => String(u).includes('/ai/usage'))).toHaveLength(1);
  });

  it("서버 모드의 'API 키' 방식: 기본 CSP(browserDirect 없음 · false)면 브라우저가 막으므로 none + 이유, 허용하면 anthropic", async () => {
    installFetch([], { available: true, browserDirect: false });
    const m = await load();
    const key = { ...settings, mode: 'anthropic' as const, apiKey: 'sk-x' };
    expect(await m.resolveBackend(key)).toBe('none');
    expect(m.aiStatusNote(key, 'none')).toMatchObject({ code: 'browser_blocked' });
    expect(m.backendLabel('none', m.aiStatusNote(key, 'none'))).toBe('규칙 엔진 (API 키 방식 차단)');
    expect(m.browserDirectStatus()).toBe(false);
    // auto에서 서버를 못 쓸 때도 막힌 API 키로 넘어가지 않는다
    expect(await m.resolveBackend({ ...settings, apiKey: 'sk-x' })).toBe('server');
    installFetch([], { available: true, browserDirect: true });
    const m2 = await load();
    expect(await m2.resolveBackend(key)).toBe('anthropic');
    expect(m2.aiStatusNote(key, 'anthropic')).toBeNull();
    // 데모(서버 워크스페이스 없음)는 그대로 — 키가 있으면 anthropic, 상태 안내 없음
    const m3 = await load({ ws: null });
    expect(await m3.resolveBackend(key)).toBe('anthropic');
    expect(m3.browserDirectStatus()).toBe(true);
    expect(m3.aiStatusNote({ ...settings, mode: 'offline' }, 'none')).toBeNull();
  });

  it('규칙 엔진인 이유: 서버 키 미설정 · 열람자 · AI 꺼짐 · 월 한도(수치 포함)를 그대로 보인다', async () => {
    const cases: Array<[unknown, string, RegExp]> = [
      [{ available: false, configured: false, unavailableReason: 'ai_not_configured' }, '규칙 엔진 (서버 AI 미설정)', /ANTHROPIC_API_KEY/],
      [{ available: false, canUse: false, unavailableReason: 'forbidden' }, '규칙 엔진 (열람자 · AI 호출 불가)', /열람자 역할은 AI를 호출할 수 없습니다/],
      [{ available: false, enabled: false, unavailableReason: 'ai_disabled' }, '규칙 엔진 (AI 꺼짐)', /AI 사용이 꺼져/],
      [{ available: false, budgetExceeded: true, unavailableReason: 'budget_exceeded', totalTokens: 5489, limit: 1000 }, '규칙 엔진 (월 한도 도달)', /사용 5,489 \/ 한도 1,000 토큰/],
      // 이전 서버(unavailableReason 없음)도 필드로 사유를 고른다
      [{ available: false, configured: false }, '규칙 엔진 (서버 AI 미설정)', /ANTHROPIC_API_KEY/],
    ];
    for (const [usage, label, long] of cases) {
      installFetch([], usage);
      const m = await load();
      const b = await m.resolveBackend(settings);
      expect(b).toBe('none');
      const note = m.aiStatusNote(settings, b);
      expect(m.backendLabel(b, note)).toBe(label);
      expect(note?.long).toMatch(long);
      expect(note?.long).not.toMatch(/claude\.ai에서 열|API 키를 입력/);
    }
  });

  it('확인 요청이 실패하면 server로 두고 호출 오류로 알린다', async () => {
    installFetch([], 500);
    const m = await load();
    expect(await m.resolveBackend(settings)).toBe('server');
  });

  it('같은 워크스페이스로 다시 configureServerAi하면(설정 변경 이벤트) 서버에 다시 확인하고, 결과가 바뀔 때만 알린다 — 켬 · 끔 · 한도 모두', async () => {
    const usage: Record<string, unknown> = { available: false, enabled: false, unavailableReason: 'ai_disabled' };
    const { fake } = installFetch([]);
    fake.mockImplementation(async (url: string) => json(200, String(url).includes('/ai/usage') ? usage : {}));
    const m = await load();
    expect(await m.resolveBackend(settings)).toBe('none');
    const fn = vi.fn();
    m.onBackendChange(fn);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    // 관리자가 AI를 켬 → 새로고침 없이 서버 백엔드로
    Object.assign(usage, { available: true, enabled: true, unavailableReason: null });
    m.configureServerAi({ workspaceId: WS });
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await m.resolveBackend(settings)).toBe('server');
    // 바뀐 게 없으면 다시 확인은 하지만 알리지 않는다
    m.configureServerAi({ workspaceId: WS });
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    // 다른 세션에서 AI를 끔 → 다음 호출이 실패하기 전에 상단 바가 바뀐다
    Object.assign(usage, { available: false, enabled: false, unavailableReason: 'ai_disabled' });
    m.configureServerAi({ workspaceId: WS });
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await m.resolveBackend(settings)).toBe('none');
    expect(m.backendLabel('none', m.aiStatusNote(settings, 'none'))).toBe('규칙 엔진 (AI 꺼짐)');
    // 월 한도를 사용량보다 낮춤 → '월 한도 도달'
    Object.assign(usage, { available: false, enabled: true, unavailableReason: 'budget_exceeded', budgetExceeded: true, totalTokens: 5489, limit: 1000 });
    m.configureServerAi({ workspaceId: WS });
    await flush();
    expect(fn).toHaveBeenCalledTimes(3);
    expect(m.backendLabel('none', m.aiStatusNote(settings, 'none'))).toBe('규칙 엔진 (월 한도 도달)');
    expect(fake.mock.calls.filter(([u]) => String(u).includes('/ai/usage'))).toHaveLength(5);
  });

  it('configureServerAi는 구독자에게 알리고, 같은 값이면 알리지 않는다', async () => {
    installFetch([]);
    const m = await load({ ws: null });
    const fn = vi.fn();
    m.onBackendChange(fn);
    m.configureServerAi({ workspaceId: WS });
    m.configureServerAi({ workspaceId: WS });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(m.serverAiWorkspace()).toBe(WS);
    m.configureServerAi({ workspaceId: null });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await m.resolveBackend(settings)).toBe('none');
  });
});

/* ---------------- 도구 루프 ---------------- */

describe('ask — 서버 도구 루프', () => {
  it('tool_use → 브라우저에서 실행 → assistant content(thinking 서명) 그대로 + tool_result로 다시 호출 → 최종 텍스트', async () => {
    const assistantContent = [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: '데이터를 봅니다.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_kpi', input: { media: 'naver' } },
    ];
    const { sent } = installFetch([
      sse([['text', { delta: '데이터를 ' }], ['text', { delta: '봅니다.' }], ['tool_use', { id: 'toolu_1', name: 'get_kpi', input: { media: 'naver' } }], done('tool_use', assistantContent)]),
      sse([['text', { delta: 'ROAS 412%' }], done('end_turn', [{ type: 'text', text: 'ROAS 412%' }])]),
    ]);
    const m = await load();
    const texts: string[] = [];
    const calls: Array<[string, unknown]> = [];
    const r = await m.ask(settings, [{ role: 'user', content: '규칙' }, { role: 'user', content: 'KPI?' }], {
      tools: [{ name: 'get_kpi', description: 'KPI', inputSchema: { type: 'object', properties: { media: { type: 'string' } } }, execute: (inp) => ({ media: inp.media, roas: 4.12 }) }],
      onText: (t) => texts.push(t),
      onToolCall: (n, i) => calls.push([n, i]),
      tier: 'quick',
    });
    expect(r).toEqual({ text: '데이터를 봅니다.\n\nROAS 412%', backend: 'server' });
    expect(texts).toEqual(['데이터를 ', '데이터를 봅니다.', '데이터를 봅니다.\n\nROAS 412%']);
    expect(calls).toEqual([['get_kpi', { media: 'naver' }]]);

    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe(`/api/w/${WS}/ai/messages`);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].headers['x-csrf-token']).toBe('csrf+tok');
    expect(sent[0].body).toEqual({
      messages: [{ role: 'user', content: '규칙\n\nKPI?' }],
      tools: [{ name: 'get_kpi', description: 'KPI', input_schema: { type: 'object', properties: { media: { type: 'string' } } } }],
      purpose: 'agent',
      tier: 'quick',
    });
    expect(sent[1].body.messages).toEqual([
      { role: 'user', content: '규칙\n\nKPI?' },
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"media":"naver","roas":4.12}' }] },
    ]);
  });

  it('도구 오류 · 없는 도구는 is_error tool_result, 큰 결과는 바이트 상한 안으로 줄이고 요청 전체는 256KB 이하', async () => {
    const big = { rows: Array.from({ length: 4000 }, (_, i) => ({ 키워드: `신혼 "매트리스" 사이즈 ${i}`, 줄: '\n' })) };
    const { sent } = installFetch([
      sse([
        ['tool_use', { id: 't1', name: 'boom', input: {} }],
        ['tool_use', { id: 't2', name: 'nope', input: {} }],
        ['tool_use', { id: 't3', name: 'big', input: {} }],
        ['tool_use', { id: 't4', name: 'big', input: {} }],
        done('tool_use', [{ type: 'tool_use', id: 't1', name: 'boom', input: {} }, { type: 'tool_use', id: 't2', name: 'nope', input: {} }, { type: 'tool_use', id: 't3', name: 'big', input: {} }, { type: 'tool_use', id: 't4', name: 'big', input: {} }]),
      ]),
      sse([['text', { delta: '끝' }], done('end_turn')]),
    ]);
    const m = await load();
    await m.ask(settings, 'q', {
      tools: [
        { name: 'boom', description: 'd', execute: () => { throw new Error('도구 실패'); } },
        { name: 'big', description: 'd', execute: () => big },
      ],
    });
    const results = sent[1].body.messages[2].content as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
    expect(results.map((x) => [x.tool_use_id, Boolean(x.is_error)])).toEqual([['t1', true], ['t2', true], ['t3', false], ['t4', false]]);
    expect(results[0].content).toBe('Error: 도구 실패');
    expect(results[1].content).toBe('Unknown tool nope');
    for (const x of results.slice(2)) {
      expect(new TextEncoder().encode(JSON.stringify(x.content)).length).toBeLessThanOrEqual(m.TOOL_RESULT_MAX_BYTES);
      expect(x.content).toMatch(/…\(생략\)$/);
      expect(x.content).not.toMatch(/�/);
    }
    expect(new TextEncoder().encode(JSON.stringify({ messages: sent[1].body.messages, tools: sent[1].body.tools })).length).toBeLessThanOrEqual(256 * 1024);
  });

  it('fitToolResult — 남은 공간이 거의 없으면 생략 안내, 작은 결과는 그대로', async () => {
    installFetch([]);
    const m = await load();
    expect(m.fitToolResult({ a: 1 }, 10_000)).toBe('{"a":1}');
    expect(m.fitToolResult('x'.repeat(5000), 100)).toMatch(/생략했습니다/);
    expect(m.fitToolResult('', 10_000)).toBe('(빈 결과)');
  });

  it('도구 왕복은 최대 8라운드', async () => {
    const round = () => sse([['tool_use', { id: 'tx', name: 't', input: {} }], done('tool_use', [{ type: 'text', text: '단계' }, { type: 'tool_use', id: 'tx', name: 't', input: {} }])]);
    const { sent } = installFetch(Array.from({ length: 10 }, round));
    const m = await load();
    await expect(m.ask(settings, 'q', { tools: [{ name: 't', description: 'd', execute: () => 1 }] })).rejects.toMatchObject({ code: 'empty_completion' });
    expect(sent).toHaveLength(8);
  });

  it('max_tokens로 끝난 답은 잘림 안내를 붙이고, 도구 왕복 상한에서 멈추면 그렇다고 적는다 (마지막 라운드 도구는 실행하지 않음)', async () => {
    installFetch([sse([['text', { delta: '부분 답' }], done('max_tokens', [{ type: 'text', text: '부분 답' }])])]);
    let m = await load();
    expect((await m.ask(settings, 'q')).text).toBe('부분 답\n\n_(응답 길이 제한으로 일부가 잘렸습니다)_');

    installFetch([sse([done('max_tokens')])]);
    m = await load();
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'empty_completion', message: expect.stringMatching(/길이 제한/) });

    const round = (i: number) => sse([['text', { delta: `단계 ${i}` }], ['tool_use', { id: `t${i}`, name: 't', input: {} }], done('tool_use', [{ type: 'text', text: `단계 ${i}` }, { type: 'tool_use', id: `t${i}`, name: 't', input: {} }])]);
    const { sent } = installFetch(Array.from({ length: 8 }, (_, i) => round(i)));
    m = await load();
    const exec = vi.fn(() => 1);
    const r = await m.ask(settings, 'q', { tools: [{ name: 't', description: 'd', execute: exec }] });
    expect(sent).toHaveLength(8);
    expect(exec).toHaveBeenCalledTimes(7);
    expect(r.text).toMatch(/단계 7\n\n_\(도구 조회 8회 상한에 도달해 여기서 멈췄습니다/);
  });

  it('askJson은 서버 경로에서 JSON을 읽고 용도에 :json을 붙인다', async () => {
    const { sent } = installFetch([sse([['text', { delta: '```json\n{"ok":true}\n```' }], done('end_turn')])]);
    const m = await load({ hash: '#reports' });
    expect(await m.askJson<{ ok: boolean }>(settings, '판정')).toEqual({ ok: true });
    expect(sent[0].body.purpose).toBe('reports:json');
    expect(sent[0].body.messages[0].content).toContain('반드시 JSON');
  });
});

/* ---------------- 오류 · 중지 ---------------- */

describe('ask — 서버 오류 매핑 · 중지', () => {
  it('503 ai_not_configured → AiError, 백엔드는 규칙 엔진으로 바뀌고 구독자에게 알린다', async () => {
    installFetch([json(503, { error: { code: 'ai_not_configured', message: 'AI 서버 키가 설정되지 않았습니다.' } })]);
    const m = await load();
    const fn = vi.fn();
    m.onBackendChange(fn);
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'ai_not_configured', message: 'AI 서버 키가 설정되지 않았습니다.' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await m.resolveBackend(settings)).toBe('none');
    expect(m.AI_ERROR_COPY.ai_not_configured).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('429 budget_exceeded → AiError(서버 수치 문구), 이번 달에는 계속 429이므로 백엔드를 규칙 엔진(월 한도 도달)으로 · 한도를 올리면 복귀', async () => {
    const msg = '이번 달 AI 사용 한도에 도달했습니다 (사용 1,010 / 한도 1,000 토큰, KST 2026-11 기준). 관리자가 워크스페이스 설정에서 월 한도를 올리거나, 다음 달 1일 00:00(KST)부터 다시 쓸 수 있습니다. 그동안 각 화면은 규칙 엔진으로 동작합니다.';
    const { fake } = installFetch([json(429, { error: { code: 'budget_exceeded', message: msg } })]);
    const m = await load();
    const fn = vi.fn();
    m.onBackendChange(fn);
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'budget_exceeded', message: msg });
    expect(m.AI_ERROR_COPY.budget_exceeded).toMatch(/한도/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await m.resolveBackend(settings)).toBe('none');
    const note = m.aiStatusNote(settings, 'none');
    expect(m.backendLabel('none', note)).toBe('규칙 엔진 (월 한도 도달)');
    expect(note?.long).toContain('사용 1,010 / 한도 1,000 토큰');
    // 관리자가 한도를 올림 → 설정 이벤트 → 다시 확인
    fake.mockImplementation(async (url: string) => json(200, String(url).includes('/ai/usage') ? { available: true } : {}));
    m.configureServerAi({ workspaceId: WS });
    await new Promise((r) => setTimeout(r, 0));
    expect(await m.resolveBackend(settings)).toBe('server');
  });

  it('401(세션 만료) → 플랫폼 공통 처리(onApiError)에 알려 로그인 화면으로 — AI 호출 · 사용량 확인 모두', async () => {
    installFetch([json(401, { error: { code: 'unauthorized', message: '로그인이 필요합니다' } })], 401);
    const m = await load();
    const api = await import('@/saas/api');
    const seen: Array<{ status: number; path: string; method: string }> = [];
    const off = api.onApiError((e) => seen.push({ status: e.error.status, path: e.path, method: e.method }));
    await m.resolveBackend(settings); // GET /ai/usage 401
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'unauthorized' });
    off();
    expect(seen).toEqual([
      { status: 401, path: `/api/w/${WS}/ai/usage`, method: 'GET' },
      { status: 401, path: `/api/w/${WS}/ai/messages`, method: 'POST' },
    ]);
  });

  it('오류 안내 한 문장: 서버의 구체적 사유(수치)를 쓰고, 끝의 규칙 엔진 문장을 두 번 말하지 않는다', async () => {
    const m = await load({ ws: null });
    const budget = '이번 달 AI 사용 한도에 도달했습니다 (사용 5,489 / 한도 1,000 토큰, KST 2026-11 기준). 관리자가 워크스페이스 설정에서 월 한도를 올리거나, 다음 달 1일 00:00(KST)부터 다시 쓸 수 있습니다. 그동안 각 화면은 규칙 엔진으로 동작합니다.';
    const reason = m.aiErrorReason(new m.AiError('budget_exceeded', budget));
    expect(reason).toBe(budget);
    const line = m.ruleFallbackLine(reason);
    expect(line).toContain('사용 5,489 / 한도 1,000 토큰');
    expect(line.match(/규칙 엔진/g)).toHaveLength(1);
    expect(line.endsWith('규칙 엔진 결과를 표시했습니다.')).toBe(true);
    // 공통 문구(끝에 '그동안 규칙 엔진 결과를 표시합니다.')도 한 번만
    const copy = m.ruleFallbackLine(m.AI_ERROR_COPY.budget_exceeded);
    expect(copy.match(/규칙 엔진/g)).toHaveLength(1);
    // 영문 SDK 문구는 공통 한국어 문구로
    expect(m.aiErrorReason(new m.AiError('upstream_error', 'Connection error.'))).toBe(m.AI_ERROR_COPY.upstream_error);
    expect(m.ruleFallbackLine(m.AI_ERROR_COPY.upstream_error)).toBe('일시적인 연결 오류입니다. 다시 시도하세요. 규칙 엔진 결과를 표시했습니다.');
    // 문장 전체가 규칙 엔진 안내면 그대로
    expect(m.ruleFallbackLine(m.AI_ERROR_COPY.no_backend)).toBe(m.AI_ERROR_COPY.no_backend);
    // 데모(claude.ai) 거부 문구도 중복 없이
    expect(m.ruleFallbackLine(m.AI_ERROR_COPY.not_granted)).toBe('Claude 사용이 허용되지 않았습니다. 규칙 엔진 결과를 표시했습니다.');
  });

  it('400 bad_request → invalid_request, 403 forbidden(열람자) → 서버 백엔드 끔, JSON 아닌 502 → upstream_error', async () => {
    installFetch([
      json(400, { error: { code: 'bad_request', message: 'AI 요청 형식을 확인해 주세요' } }),
      new Response('<html>bad gateway</html>', { status: 502 }),
      json(403, { error: { code: 'forbidden', message: '이 작업을 할 권한이 없습니다' } }),
    ]);
    const m = await load();
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await m.resolveBackend(settings)).toBe('none');
  });

  it('SSE error 이벤트 → 받은 텍스트를 partial로 담은 AiError', async () => {
    installFetch([sse([['text', { delta: '부분 답' }], ['error', { code: 'overloaded', message: 'Claude 서버가 일시적으로 혼잡합니다.' }]])]);
    const m = await load();
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'overloaded', partial: '부분 답' });
    expect(m.AI_ERROR_COPY.overloaded).toBeTruthy();
  });

  it('done 없이 끊기면 upstream_error, refusal은 refused, 네트워크 실패는 network', async () => {
    installFetch([
      sse([['text', { delta: '반쯤' }]]),
      sse([done('refusal')]),
      (() => { throw new TypeError('Failed to fetch'); }) as never,
    ]);
    const m = await load();
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'upstream_error', partial: '반쯤' });
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'refused' });
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'network' });
  });

  it('AbortSignal로 중지하면 cancelled + 지금까지 받은 텍스트(partial)', async () => {
    const ctl = new AbortController();
    installFetch([
      (_s, signal) => {
        expect(signal).toBe(ctl.signal);
        return sse([['text', { delta: '첫 문장.' }]], { hang: true });
      },
    ]);
    const m = await load();
    const p = m.ask(settings, 'q', { signal: ctl.signal, onText: () => setTimeout(() => ctl.abort(), 5) });
    await expect(p).rejects.toMatchObject({ code: 'cancelled', partial: '첫 문장.' });
  });

  it('이미 중지된 신호로 fetch가 AbortError를 던져도 cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    installFetch([() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }]);
    const m = await load();
    await expect(m.ask(settings, 'q', { signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('fetchServerAiUsage', () => {
  it('서버 모드에서 사용량을 읽고, 아니면 null', async () => {
    installFetch([], { month: '2026-11', inputTokens: 1, outputTokens: 2, limit: 30_000_000, byPurpose: [], available: true });
    const m = await load();
    expect(await m.fetchServerAiUsage('2026-11')).toMatchObject({ month: '2026-11', limit: 30_000_000 });
    m.configureServerAi({ workspaceId: null });
    expect(await m.fetchServerAiUsage()).toBeNull();
  });

  it('JSON이 아닌 200 응답(프록시 오류 페이지)은 null', async () => {
    const { fake } = installFetch([]);
    fake.mockImplementation(async () => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const m = await load();
    expect(await m.fetchServerAiUsage()).toBeNull();
  });

  it('423 workspace_locked → 서버 백엔드를 끄고 한국어 안내', async () => {
    installFetch([json(423, { error: { code: 'workspace_locked', message: '이 워크스페이스는 현재 읽기 전용입니다' } })]);
    const m = await load();
    await expect(m.ask(settings, 'q')).rejects.toMatchObject({ code: 'workspace_locked' });
    expect(await m.resolveBackend(settings)).toBe('none');
    expect(m.AI_ERROR_COPY.workspace_locked).toMatch(/읽기 전용/);
  });
});
