/**
 * MILDO Agent 답변 — AI 호출이 중간에 끊기면 끊긴 Claude 부분은 AI 출처 배지로, 규칙 엔진 결과는 규칙 엔진 배지로 나눠 보인다.
 * 오류 안내는 한 문장(규칙 엔진 안내를 두 번 말하지 않음)이고 서버의 구체적 사유(수치)를 쓴다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { AiError, AI_ERROR_COPY } from '@/ai/claude';
import { StoreProvider } from '@/core/store';
import { AssistantMessage, aiFailureAnswer, type Msg } from './messages';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const fb = { markdown: '## 오늘의 운영 브리프\n\n확정 팩트 RULE_BODY', used: ['home:home_brief'] };
const wrap = (node: ReactNode) => renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
const render = (m: Msg) => wrap(h(AssistantMessage, { m }));

describe('aiFailureAnswer', () => {
  it('부분 응답은 규칙 엔진 본문에 섞지 않고 partialAi로 따로 둔다', () => {
    const m = aiFailureAnswer(new AiError('overloaded', 'Claude 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.', '부분 답변 PARTIAL_OK'), fb, ['board_kpis']);
    expect(m.via).toBe('rule');
    expect(m.content).toBe(fb.markdown);
    expect(m.content).not.toContain('PARTIAL_OK');
    expect(m.partialAi).toBe('부분 답변 PARTIAL_OK');
    expect(m.partialTools).toEqual(['board_kpis']);
    expect(m.tools).toEqual(['home:home_brief']);
  });

  it('부분 응답이 없으면 partialAi 없음', () => {
    const m = aiFailureAnswer(new AiError('upstream_error', 'Connection error.'), fb, []);
    expect(m.partialAi).toBeUndefined();
    expect(m.error).toBe(`${AI_ERROR_COPY.upstream_error} 규칙 엔진 결과를 표시했습니다.`);
  });

  it('한도 도달: 서버 수치 문구를 쓰고 규칙 엔진 안내는 한 번만', () => {
    const msg = '이번 달 AI 사용 한도에 도달했습니다 (사용 5,489 / 한도 1,000 토큰, KST 2026-11 기준). 관리자가 워크스페이스 설정에서 월 한도를 올리거나, 다음 달 1일 00:00(KST)부터 다시 쓸 수 있습니다. 그동안 각 화면은 규칙 엔진으로 동작합니다.';
    const m = aiFailureAnswer(new AiError('budget_exceeded', msg), fb, []);
    expect(m.error).toContain('사용 5,489 / 한도 1,000 토큰');
    expect(m.error!.match(/규칙 엔진/g)).toHaveLength(1);
    expect(m.error).not.toContain('규칙 엔진 결과를 표시합니다. — 규칙 엔진 결과를 표시했습니다');
  });
});

describe('AssistantMessage', () => {
  it('끊긴 Claude 부분이 먼저 AI 출처 배지와 함께, 그 아래 규칙 엔진 배지와 규칙 결과', () => {
    const html = render(aiFailureAnswer(new AiError('overloaded', '혼잡합니다.', '부분 답변 PARTIAL_OK'), fb, []));
    const iAiTag = html.indexOf('class="src ai"');
    const iPartial = html.indexOf('PARTIAL_OK');
    const iRuleTag = html.indexOf('>규칙 엔진<');
    const iRule = html.indexOf('RULE_BODY');
    expect(iAiTag).toBeGreaterThan(-1);
    expect(iAiTag).toBeLessThan(iPartial);
    expect(iPartial).toBeLessThan(iRuleTag);
    expect(iRuleTag).toBeLessThan(iRule);
    // 규칙 엔진 배지 바로 뒤에 AI 텍스트가 오지 않는다
    expect(html.slice(iRuleTag)).not.toContain('PARTIAL_OK');
    expect(html).toContain('응답이 중간에 끊겼습니다');
  });

  it('부분 응답이 없는 규칙 엔진 답은 규칙 엔진 배지만 (AI 배지 없음)', () => {
    const html = render(aiFailureAnswer(new AiError('upstream_error', 'x'), fb, []));
    expect(html).toContain('>규칙 엔진<');
    expect(html).not.toContain('class="src ai"');
  });

  it('완결된 AI 답은 AI 배지', () => {
    const html = render({ role: 'assistant', content: 'AI_ANSWER', via: 'ai', tools: [] });
    expect(html).toContain('class="src ai"');
    expect(html).not.toContain('>규칙 엔진<');
  });
});
