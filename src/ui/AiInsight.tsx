/**
 * AI 해석 패널 — 모든 모듈 공용.
 * 버튼을 누르면 (1) Claude 연결 시: 데이터 스냅샷 + 지시문으로 해석을 스트리밍, (2) 미연결 시: 규칙 엔진 브리프를 같은 형식으로 표시.
 * 결과는 항상 확정 팩트 / 반복 관측 패턴 / AI 해석 영역을 구분한다.
 */
import { useEffect, useRef, useState } from 'react';
import { useAi } from '@/ai/useAi';
import { ANALYST_RULES, briefToMarkdown, type Brief } from '@/ai/prompts';
import { AI_ERROR_COPY, AiError } from '@/ai/claude';
import { Markdown } from './Markdown';
import { Button, Card, CopyButton, Pill, Src } from './primitives';

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
  /** 실행 번호 — 중지 · 재실행 뒤 늦게 도착한 이전 호출의 onText · 결과를 무시한다 */
  const runId = useRef(0);
  // 화면을 떠나면 진행 중 호출을 중지한다 (보이지 않는 생성에 사용량을 쓰지 않음)
  useEffect(() => () => {
    runId.current += 1;
    ctl.current?.abort();
  }, []);

  const stop = () => {
    runId.current += 1;
    ctl.current?.abort();
    setBusy(false); // 중지는 즉시 반영 — 지금까지 받은 부분 텍스트는 그대로 둔다 (오류로 표시하지 않음)
  };

  const run = async () => {
    setNote('');
    if (!ai.connected) {
      setText(briefToMarkdown(fallback()));
      setMode('rule');
      return;
    }
    const my = ++runId.current;
    const live = () => runId.current === my;
    ctl.current = new AbortController();
    setBusy(true);
    setMode('ai');
    setText('');
    try {
      const { text: t } = await ai.ask(`${ANALYST_RULES}\n\n${buildPrompt()}`, { signal: ctl.current.signal, onText: (x) => { if (live()) setText(x); }, cache: false });
      if (live()) setText(t);
    } catch (e) {
      const err = e as AiError;
      if (live() && err.code !== 'cancelled') {
        setNote(AI_ERROR_COPY[err.code] ?? err.message);
        setText(err.partial || briefToMarkdown(fallback()));
        if (!err.partial) setMode('rule');
      }
    } finally {
      if (live()) setBusy(false);
    }
  };

  // 실행 버튼 자리에 중지 버튼이 바로 나타나므로, 더블클릭의 두 번째 클릭이 방금 시작한 생성을 중지(또는 중지 직후 재시작)하지
  // 않게 한다. 키보드 실행(detail 0)과 한 번 클릭(detail 1)만 처리
  const single = (fn: () => void) => (e: { detail: number }) => { if (e.detail > 1) return; fn(); };

  return (
    <Card title={title} sub={sub} tone={tone}
      actions={
        <>
          {mode === 'ai' ? <Src kind="AI" title="Claude 생성" /> : mode === 'rule' ? <Pill tone="neutral" icon="zap" title="규칙 엔진 결과 (TEST DATA · 제안서 기준값으로 계산)">규칙 엔진</Pill> : null}
          {busy ? <Button size="sm" icon="stop" onClick={single(stop)}>중지</Button> : <Button size="sm" variant="accent" icon="sparkle" onClick={single(run)}>{text ? '다시 생성' : cta}</Button>}
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
