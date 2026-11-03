/**
 * Server-Sent Events 파서 — fetch 응답 본문(ReadableStream)을 이벤트 단위로 읽는다.
 * EventSource는 POST 본문 · CSRF 헤더 · AbortSignal을 쓸 수 없어 직접 파싱한다 (HTML Living Standard §9.2 이벤트 스트림 형식).
 *
 * 규칙: 줄 끝은 \r\n · \n · \r. 빈 줄에서 이벤트를 내보낸다. ':'로 시작하는 줄은 주석(연결 유지 ping).
 * 'field: value'의 콜론 뒤 공백 하나는 버린다. data 줄이 여러 개면 \n으로 잇는다. event 기본값은 'message'.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private hasData = false;

  /** 텍스트 조각을 넣고, 완성된 이벤트를 돌려준다 (조각 경계는 어디든 된다) */
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // 조각 끝의 \r 뒤에 \n이 이어질 수 있으므로 더 받을 때까지 기다린다
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** 스트림 끝: 남은 줄을 처리하고, 빈 줄 없이 끝난 마지막 이벤트도 내보낸다 */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf.replace(/\r$/, ''));
      this.buf = '';
      if (ev) out.push(ev);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.data.push(value);
      this.hasData = true;
    }
    // id · retry는 쓰지 않는다
    return null;
  }

  private dispatch(): SseEvent | null {
    const ev = this.hasData ? { event: this.event || 'message', data: this.data.join('\n') } : null;
    this.event = '';
    this.data = [];
    this.hasData = false;
    return ev;
  }
}

/** 응답 본문을 끝까지 읽으며 이벤트마다 onEvent를 부른다. signal이 끊기면 AbortError를 던진다 */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e);
    }
    for (const e of parser.push(decoder.decode())) onEvent(e);
    for (const e of parser.end()) onEvent(e);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* 이미 해제 */ }
  }
}

function abortError(): Error {
  const e = new Error('중지했습니다');
  e.name = 'AbortError';
  return e;
}
