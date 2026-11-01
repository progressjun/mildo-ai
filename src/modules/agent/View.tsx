/**
 * MILDO Agent — 전 모듈 데이터를 도구로 읽고 판단 근거를 정리하는 AI 에이전트 (신규 기능).
 * Claude 연결 시 tool use로 각 모듈 엔진을 호출하고, 미연결 시 규칙 엔진 브리프로 같은 형식의 답을 낸다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useActions, useStore } from '@/core/store';
import { navigate } from '@/core/router';
import { useAi } from '@/ai/useAi';
import { ANALYST_RULES } from '@/ai/prompts';
import { AI_ERROR_COPY, AiError, BACKEND_LABEL, type Turn } from '@/ai/claude';
import { MODULE_BY_ID } from '@/modules/registry';
import { Markdown } from '@/ui/Markdown';
import { Button, Card, CopyButton, PageHeader, Pill, Src } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { collectTools, offlineAnswer, snapshot, TOOL_GUIDE } from './orchestrator';
import './styles.css';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
  via?: 'ai' | 'rule';
  error?: string;
  /** 에이전트가 navigate 도구로 제안한 화면 — 답변을 다 읽은 뒤 버튼으로 이동 */
  nav?: string[];
}

/**
 * 대화 보관 — 다른 화면에 다녀와도 대화가 남는다 (새로고침 · '새 대화'에서만 지움).
 * 저장소(localStorage)에는 남기지 않는다: 질문 · 답변은 이 탭에서만 보인다.
 */
let chatCache: Msg[] = [];
/** 실행 번호 (화면 인스턴스와 무관하게 하나) — 중지 · 새 대화 · 새 질문 뒤 늦게 도착한 이전 호출의 결과를 무시한다 */
let activeRun = 0;

const QUICK = [
  '오늘 무엇부터 처리해야 하는지, 근거와 판정 기준까지',
  'Meta 광고비 급등과 카카오 전환 0의 원인 후보를 데이터로 비교해줘',
  'AD Pilot 입찰 조정 후보를 승인 기준과 함께 정리해줘',
  '이번 달 예산 소진 전망과 재배분 시 한계 ROAS 변화',
  "'신혼 매트리스' 구문형 키워드 확장 시나리오를 CAC 회수 구조로 판단해줘",
  'GEO · AI 검색에서 수면밀도 언급 현황과 대응 우선순위',
  '주간 리포트 초안을 확정 팩트 / 패턴 / 해석으로 나눠 작성해줘',
  'RFP 평가 비중 기준으로 라이브 데모 15분을 어떻게 배분할지',
];

export default function View() {
  const { state } = useStore();
  const actions = useActions();
  const ai = useAi();
  const [msgs, setMsgsState] = useState<Msg[]>(() => chatCache);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const ctl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);

  const setMsgs = useCallback((m: Msg[]) => {
    chatCache = m;
    if (mounted.current) setMsgsState(m);
  }, []);

  // 화면을 떠나면 진행 중 호출을 중지한다 — 받은 부분 답변은 대화에 남는다
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ctl.current?.abort();
    };
  }, []);

  // navigate 도구는 화면을 바로 바꾸지 않고(답변이 사라지지 않게) 답변 아래 이동 버튼으로 남긴다
  const navReq = useRef<string[]>([]);
  const deferNavigate = useCallback((route: string) => {
    if (!navReq.current.includes(route)) navReq.current.push(route);
  }, []);
  const ctx = useMemo(() => ({ state, actions, navigate: deferNavigate }), [state, actions, deferNavigate]);
  const tools = useMemo(() => collectTools(ctx), [ctx]);

  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 30);

  const stop = () => {
    activeRun += 1;
    ctl.current?.abort();
    busyRef.current = false;
    setBusy(false); // 중지는 즉시 반영 — 지금까지 받은 답변은 남기고 오류로 표시하지 않는다
    const last = chatCache[chatCache.length - 1];
    if (last && last.role === 'assistant' && !last.content) setMsgs([...chatCache.slice(0, -1), { ...last, content: '_(중지했습니다)_' }]);
  };

  const newChat = () => {
    if (busyRef.current) stop();
    activeRun += 1;
    setMsgs([]);
    setLiveTools([]);
  };

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busyRef.current) return;
    setInput('');
    const history = chatCache;
    setMsgs([...history, { role: 'user', content: question }, { role: 'assistant', content: '' }]);
    scroll();
    if (!ai.connected) {
      const { markdown, used } = offlineAnswer(question, ctx);
      setMsgs([...history, { role: 'user', content: question }, { role: 'assistant', content: markdown, tools: used, via: 'rule' }]);
      scroll();
      return;
    }
    const my = ++activeRun;
    const live = () => activeRun === my;
    busyRef.current = true;
    setBusy(true);
    setLiveTools([]);
    navReq.current = [];
    const used: string[] = [];
    ctl.current = new AbortController();
    const turns: Turn[] = [
      { role: 'user', content: `${ANALYST_RULES}\n\n${TOOL_GUIDE}\n\n현재 상태 스냅샷:\n${snapshot(ctx)}` },
      ...history.filter((m) => m.content && !m.error).slice(-8).map((m) => ({ role: m.role, content: m.content }) as Turn),
      { role: 'user', content: question },
    ];
    // 늦게 온 onText · 결과는 버린다(중지 · 새 대화 · 새 질문 뒤). 화면을 떠난 경우에는 대화 보관만 갱신한다
    let lastText = '';
    const update = (content: string, nav?: string[]) => {
      if (!live()) return;
      lastText = content;
      setMsgs([...history, { role: 'user', content: question }, { role: 'assistant', content, tools: [...used], via: 'ai', ...(nav?.length ? { nav } : {}) }]);
    };
    try {
      const { text } = await ai.ask(turns, {
        signal: ctl.current.signal,
        cache: false,
        tools: tools.map((t) => t.tool),
        onText: (t) => { update(t); },
        onToolCall: (name) => { used.push(name); if (live()) setLiveTools([...used]); },
      });
      update(text, [...navReq.current]);
    } catch (e) {
      const err = e as AiError;
      if (err.code === 'cancelled') {
        // 중지 버튼은 이미 화면에 반영했다. 화면 이탈로 끊긴 경우에만 부분 답변을 보관한다
        if (!mounted.current) update(err.partial || lastText || '_(중지했습니다)_');
      } else if (live()) {
        const fb = offlineAnswer(question, ctx);
        setMsgs([...history, { role: 'user', content: question }, { role: 'assistant', content: err.partial ? `${err.partial}\n\n---\n\n${fb.markdown}` : fb.markdown, tools: fb.used, via: 'rule', error: AI_ERROR_COPY[err.code] ?? err.message }]);
      }
    } finally {
      if (live()) {
        busyRef.current = false;
        setBusy(false);
        scroll();
      }
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 IME 조합 중 Enter는 글자 확정용 — 전송하지 않는다 (Safari는 isComposing 대신 keyCode 229)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      send(input);
    }
  };

  const byModule = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const t of tools) (g[t.module] ??= []).push(t.tool.name);
    return g;
  }, [tools]);

  return (
    <div className="page">
      <PageHeader
        eyebrow="AI AGENT · 신규 기능"
        title="MILDO Agent"
        sub="질문하면 Board · AD Pilot · Alert · Lab · GEO · 매출 성장 엔진을 직접 조회해, 확정 팩트와 반복 관측 패턴과 AI 해석을 나눠 답합니다. 판단에는 항상 전제 조건 · 수치 기준 · 반례가 붙습니다."
        sources={<><Pill tone={ai.connected ? 'good' : 'neutral'} icon={ai.connected ? 'check' : 'zap'}>{ai.backend === 'checking' ? '확인 중' : BACKEND_LABEL[ai.backend]}</Pill><Src kind="DEMO" /></>}
        actions={msgs.length ? <Button size="sm" icon="refresh" onClick={newChat}>새 대화</Button> : null}
      />
      <div className="agent-layout">
        <div className="stack-lg">
          {msgs.length === 0 ? (
            <Card title="무엇을 판단해야 하나요?" sub="자주 쓰는 질문 · 클릭하면 바로 실행">
              <div className="grid g-2" style={{ gap: 8 }}>
                {QUICK.map((q) => (
                  <button key={q} type="button" className="btn" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', borderRadius: 12, padding: '10px 12px' }} onClick={() => send(q)}>
                    <Icon name="sparkle" size={14} /> {q}
                  </button>
                ))}
              </div>
              {!ai.connected ? <div className="xs muted">AI 미연결: 규칙 엔진이 질문 키워드와 맞는 모듈 브리프로 답합니다. claude.ai에서 열거나 설정에서 API 키를 넣으면 도구를 쓰는 Claude 에이전트로 동작합니다.</div> : null}
            </Card>
          ) : null}
          <div className="chat" aria-live="polite">
            {msgs.map((m, i) => (
              m.role === 'user' ? (
                <div key={i} className="msg user">{m.content}</div>
              ) : (
                <div key={i} className="msg assistant">
                  <div className="row-between">
                    <div className="row" style={{ gap: 6 }}>
                      {m.via === 'rule' ? <Pill tone="neutral" icon="zap" title="규칙 엔진 결과">규칙 엔진</Pill> : <Src kind="AI" title="Claude 생성" />}
                      {(m.tools ?? []).map((t, k) => <span key={k} className="tool-chip"><Icon name="zap" size={10} />{t}</span>)}
                    </div>
                    {m.content ? <CopyButton text={m.content} /> : null}
                  </div>
                  {m.content ? <Markdown text={m.content} /> : (
                    <div className="small muted">
                      {busy ? `분석 중…${liveTools.length ? ` 조회한 도구: ${liveTools.join(', ')}` : ' 필요한 데이터를 고르고 있습니다.'}` : ''}
                    </div>
                  )}
                  {m.error ? <div className="xs muted">{m.error} — 규칙 엔진 결과를 표시했습니다.</div> : null}
                  {m.nav?.length ? (
                    <div className="row" style={{ gap: 6 }}>
                      {m.nav.map((r) => <Button key={r} size="sm" icon="chevron" onClick={() => navigate(r)}>{MODULE_BY_ID[r]?.title ?? r} 화면 열기</Button>)}
                    </div>
                  ) : null}
                </div>
              )
            ))}
            <div ref={endRef} />
          </div>
          <Card>
            <div className="field">
              <label htmlFor="agent-input">질문</label>
              <textarea id="agent-input" className="textarea" rows={3} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey}
                placeholder="예: GFA 예산을 20% 늘리면 SA 브랜드 검색과 전체 ROAS는 어떻게 움직일 것으로 보나? (Enter 전송 · Shift+Enter 줄바꿈)" />
            </div>
            <div className="row-between">
              <span className="xs muted">미팅용 멘트가 필요하면 "미팅용" 또는 "광고주 앞에서 할 말"을 명시하세요.</span>
              <div className="row">
                {busy ? <Button icon="stop" onClick={stop}>중지</Button> : null}
                <Button variant="primary" icon="send" disabled={busy || !input.trim()} onClick={() => send(input)}>보내기</Button>
              </div>
            </div>
          </Card>
        </div>
        <aside className="stack-lg">
          <Card title="판단 원칙" sub="모든 답변에 적용">
            <div className="stack-sm small">
              <div className="zone fact"><span className="zone-label">확정 팩트</span><span className="xs">데이터 · RFP · 제안서에 명시된 값</span></div>
              <div className="zone pattern"><span className="zone-label">반복 관측 패턴</span><span className="xs">여러 기간 · 매체에서 반복된 패턴</span></div>
              <div className="zone ai"><span className="zone-label">AI 해석</span><span className="xs">가정과 불확실성을 밝힌 해석</span></div>
              <div className="zone cond"><span className="zone-label">전제 조건 · 기준값</span><span className="xs">판정에 쓴 수치 기준</span></div>
              <div className="zone counter"><span className="zone-label">반례 · 대체 시나리오</span><span className="xs">판단이 틀릴 조건</span></div>
            </div>
            <div className="xs muted">기준: CAC · CPA · ROAS · CVR · 볼륨 · 확장성</div>
          </Card>
          <Card title="에이전트 도구" sub={`${tools.length}개 · 모듈 엔진 직접 호출`}>
            <div className="stack-sm agent-tools" tabIndex={0} aria-label="에이전트 도구 목록">
              {Object.entries(byModule).map(([mod, names]) => (
                <div key={mod} className="stack-sm" style={{ gap: 3 }}>
                  <a href={`#${mod}`} className="xs bold" style={{ color: 'var(--ink)' }}>{MODULE_BY_ID[mod]?.title ?? mod}</a>
                  <div className="row" style={{ gap: 4 }}>{names.map((n) => <span key={n} className="tool-chip">{n}</span>)}</div>
                </div>
              ))}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
