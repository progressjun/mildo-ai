/**
 * AI 해석 패널 — 모든 모듈 공용.
 * 버튼을 누르면 (1) Claude 연결 시: 데이터 스냅샷 + 지시문으로 해석을 스트리밍, (2) 미연결 시: 규칙 엔진 브리프를 같은 형식으로 표시.
 * 결과는 항상 확정 팩트 / 반복 관측 패턴 / AI 해석 영역을 구분한다.
 */
import { useRef, useState } from 'react';
import { useAi } from '@/ai/useAi';
import { ANALYST_RULES, briefToMarkdown, type Brief } from '@/ai/prompts';
import { AI_ERROR_COPY, AiError } from '@/ai/claude';
import { Markdown } from './Markdown';
import { Button, Card, CopyButton, Src } from './primitives';

export function AiInsight({
  title = 'AI 해석', sub, buildPrompt, fallback, cta = 'AI 해석 생성', tone,
}: {
  title?: string;
  sub?: string;
  /** 지시문 뒤에 붙일 과제 + 데이터 (ANALYST_RULES는 자동으로 앞에 붙는다) */
  buildPrompt: () => string;
  /** AI 미연결 · 실패 시 규칙 엔진 결과 */
  fallback: () => Brief;
  cta?: string;
  tone?: 'dark';
}) {
  const ai = useAi();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'ai' | 'rule' | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const run = async () => {
    setNote('');
    if (!ai.connected) {
      setText(briefToMarkdown(fallback()));
      setMode('rule');
      return;
    }
    ctl.current = new AbortController();
    setBusy(true);
    setMode('ai');
    setText('');
    try {
      const { text: t } = await ai.ask(`${ANALYST_RULES}\n\n${buildPrompt()}`, { signal: ctl.current.signal, onText: setText, cache: false });
      setText(t);
    } catch (e) {
      const err = e as AiError;
      if (err.code !== 'cancelled') {
        setNote(AI_ERROR_COPY[err.code] ?? err.message);
        setText(err.partial || briefToMarkdown(fallback()));
        if (!err.partial) setMode('rule');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={title} sub={sub} tone={tone}
      actions={
        <>
          {mode ? <Src kind={mode === 'ai' ? 'AI' : 'PROPOSAL'} title={mode === 'ai' ? 'Claude 생성' : '규칙 엔진 결과'} /> : null}
          {busy ? <Button size="sm" icon="stop" onClick={() => ctl.current?.abort()}>중지</Button> : <Button size="sm" variant="accent" icon="sparkle" onClick={run}>{text ? '다시 생성' : cta}</Button>}
          {text && !busy ? <CopyButton text={text} /> : null}
        </>
      }>
      {busy && !text ? <div className="small muted">분석 중… 데이터를 읽고 판단 기준을 대조하고 있습니다.</div> : null}
      {text ? <Markdown text={text} /> : !busy ? <div className="small muted">{ai.connected ? 'Claude가 현재 화면 데이터를 읽고 확정 팩트 · 반복 관측 패턴 · AI 해석을 나눠 정리합니다.' : 'AI 미연결 상태입니다. 규칙 엔진이 같은 형식으로 판단 근거를 정리합니다.'}</div> : null}
      {note ? <div className="xs muted">{note}</div> : null}
      {mode === 'rule' && text ? <div className="xs muted">규칙 엔진 결과 · Claude 연결 시 더 깊은 해석을 생성합니다.</div> : null}
    </Card>
  );
}
