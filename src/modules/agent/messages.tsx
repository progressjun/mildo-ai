/**
 * MILDO Agent 대화 메시지 — 형태 · AI 실패 시 규칙 엔진 답 만들기 · 답변 말풍선.
 * AI 해석과 규칙 엔진 결과를 한 배지 아래 섞지 않는다(docs/SAAS_SPEC.md 머리말): Claude가 쓰다가 끊긴 부분은 AI 출처 배지로,
 * 그 아래 규칙 엔진 결과는 규칙 엔진 배지로 나눠 보인다.
 */
import { navigate } from '@/core/router';
import { aiErrorReason, ruleFallbackLine } from '@/ai/claude';
import { MODULE_BY_ID } from '@/modules/registry';
import { Markdown } from '@/ui/Markdown';
import { Button, CopyButton, Pill, Src } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
  via?: 'ai' | 'rule';
  /** 규칙 엔진으로 바꾼 이유 — 한 문장으로 끝까지 (ruleFallbackLine) */
  error?: string;
  /**
   * Claude가 쓰다가 끊긴 부분 (via 'rule' 답 위에 AI 출처 배지로 따로 보인다).
   * 대화 기록에는 넣지 않는다(error가 있는 답은 다음 질문의 맥락에서 빠진다).
   */
  partialAi?: string;
  /** partialAi를 쓰는 동안 Claude가 조회한 도구 */
  partialTools?: string[];
  /** 에이전트가 navigate 도구로 제안한 화면 — 답변을 다 읽은 뒤 버튼으로 이동 */
  nav?: string[];
}

/** AI 호출 실패 → 규칙 엔진 답 (끊긴 Claude 부분은 partialAi로 따로) */
export function aiFailureAnswer(err: { code: string; message?: string; partial?: string }, fb: { markdown: string; used: string[] }, aiTools: string[]): Msg {
  return {
    role: 'assistant',
    content: fb.markdown,
    tools: fb.used,
    via: 'rule',
    error: ruleFallbackLine(aiErrorReason(err)),
    ...(err.partial ? { partialAi: err.partial, partialTools: [...aiTools] } : {}),
  };
}

const ToolChips = ({ tools }: { tools?: string[] }) => <>{(tools ?? []).map((t, k) => <span key={k} className="tool-chip"><Icon name="zap" size={10} />{t}</span>)}</>;

/** 답변 말풍선 (waiting: 아직 내용이 없을 때 보일 진행 문구) */
export function AssistantMessage({ m, waiting }: { m: Msg; waiting?: string }) {
  return (
    <div className="msg assistant">
      {m.partialAi ? (
        <>
          <div className="row-between">
            <div className="row" style={{ gap: 6 }}>
              <Src kind="AI" title="Claude 생성 · 응답이 중간에 끊김" />
              <ToolChips tools={m.partialTools} />
            </div>
            <CopyButton text={m.partialAi} />
          </div>
          <Markdown text={m.partialAi} />
          <div className="xs muted">응답이 중간에 끊겼습니다 — 위는 Claude가 끊기기 전까지 생성한 부분이고, 아래는 규칙 엔진 결과입니다.</div>
          <hr className="agent-split" />
        </>
      ) : null}
      <div className="row-between">
        <div className="row" style={{ gap: 6 }}>
          {m.via === 'rule' ? <Pill tone="neutral" icon="zap" title="규칙 엔진 결과">규칙 엔진</Pill> : <Src kind="AI" title="Claude 생성" />}
          <ToolChips tools={m.tools} />
        </div>
        {m.content ? <CopyButton text={m.content} /> : null}
      </div>
      {m.content ? <Markdown text={m.content} /> : <div className="small muted">{waiting ?? ''}</div>}
      {m.error ? <div className="xs muted">{m.error}</div> : null}
      {m.nav?.length ? (
        <div className="row" style={{ gap: 6 }}>
          {m.nav.map((r) => <Button key={r} size="sm" icon="chevron" onClick={() => navigate(r)}>{MODULE_BY_ID[r]?.title ?? r} 화면 열기</Button>)}
        </div>
      ) : null}
    </div>
  );
}
