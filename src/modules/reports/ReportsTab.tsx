/* 리포트 4종 (p.17) — 문서형 · 메신저형 · AE 코멘트 · 코멘트 단위 피드백 · AI 해석 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActions, useStore, type AppState } from '@/core/store';
import { ROLE_LABEL } from '@/core/permissions';
import { useSaas } from '@/saas/context';
import { useAi } from '@/ai/useAi';
import { ANALYST_RULES, briefToMarkdown } from '@/ai/prompts';
import { AI_ERROR_COPY, type AiError } from '@/ai/claude';
import { fmtDate, nowIso, uid } from '@/core/util';
import { Button, Callout, Card, CopyButton, DownloadButton, Field, Pill, Segmented, Src } from '@/ui/primitives';
import { aeTarget, aiPrompt, availableMonths, monthPeriod, reportToMarkdown, scopeOf, sortIssues, type IssueLike, type Report, type ReportType } from './engine';
import { FEEDBACK_HISTORY, REPORT_META } from './data';
import { MailPreview, MessengerPreview, ReportDocument, fmtAt } from './parts';
import { Icon } from '@/ui/Icon';

export interface Interp { text: string; by: 'ai' | 'rule'; at: string }

export function ReportsTab({ type, report, genMs, month, setMonth, issueId, setIssueId, interpKey, interp, setInterp, sendLabel }: {
  type: ReportType;
  report: Report;
  genMs: number;
  month: string;
  setMonth: (m: string) => void;
  issueId: string | null;
  setIssueId: (id: string | null) => void;
  interpKey: string;
  interp: Interp | null;
  setInterp: (key: string, v: Interp | null) => void;
  sendLabel: string;
}) {
  const { state } = useStore();
  const ai = useAi();
  // 진행 중 표시는 생성을 시작한 리포트에만 — 다른 리포트로 바꾸면 그 리포트에는 중지 버튼 · 작성 중 안내가 보이지 않는다
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busy = busyKey === interpKey;
  const [note, setNote] = useState('');
  const ctl = useRef<AbortController | null>(null);
  /** 실행 번호 — 새 실행이 시작되면 이전 실행의 늦은 onText · 결과 · 오류는 무시한다 */
  const runId = useRef(0);
  const keyRef = useRef(interpKey);
  keyRef.current = interpKey;
  // 오류 안내는 해당 리포트의 해석 시도에만 붙인다 — 다른 리포트 · 월 · 이슈로 바꾸면 지우고, 진행 중인 생성은 중지한다
  // (보이지 않는 리포트에 사용량을 쓰지 않고, 다른 리포트 화면의 중지 버튼이 엉뚱한 생성을 멈추지 않게)
  useEffect(() => { setNote(''); ctl.current?.abort(); }, [interpKey]);
  // 화면을 떠나면 진행 중 생성을 중지한다
  useEffect(() => () => ctl.current?.abort(), []);
  // 코멘트 범위: 일간 · 주간은 종류, 월간은 대상 월, 이슈 알림은 이슈별 (다른 월 · 다른 이슈 피드백이 섞이지 않음)
  const scope = scopeOf(report);
  const prefix = `reports:${scope}:`;
  const aeNotes = state.comments.filter((c) => c.target === aeTarget(scope));
  const feedback = state.comments.filter((c) => c.target.startsWith(prefix) && c.target !== aeTarget(scope));
  const sectionTitle = (target: string) => report.sections.find((s) => `${prefix}${s.id}` === target)?.title ?? target.slice(prefix.length);
  const months = useMemo(() => availableMonths(state.data).map((m) => ({ m, provisional: !!monthPeriod(state.data, m)?.provisional })), [state.data]);
  const issues = useMemo(() => sortIssues(state.incidents as IssueLike[]), [state.incidents]);

  const markdown = () => reportToMarkdown(report, {
    interpretation: interp?.text ? { text: interp.text, by: interp.by } : null,
    aeNotes: aeNotes.map((n) => ({ author: n.author, text: n.text, at: fmtAt(n.at) })),
    feedback: feedback.map((f) => ({ sectionTitle: sectionTitle(f.target), author: f.author === '수면밀도' ? '수면밀도 담당자' : f.author, text: f.text, resolved: f.resolved, client: f.author === '수면밀도' })),
  });
  const ruleText = () => briefToMarkdown({ ...report.brief, facts: [], patterns: [] });

  const run = async () => {
    setNote('');
    if (!ai.connected) {
      setInterp(interpKey, { text: ruleText(), by: 'rule', at: nowIso() });
      return;
    }
    const myKey = interpKey;
    const my = ++runId.current;
    const live = () => runId.current === my;
    const ac = new AbortController();
    ctl.current = ac;
    // 다시 생성이 중지 · 실패로 끝나고 받은 글자가 없으면 직전 해석을 되살린다 (빈 'AI 해석' 영역이 남지 않게)
    const prev = interp?.text ? interp : null;
    let streamed = '';
    setBusyKey(myKey);
    setInterp(myKey, { text: '', by: 'ai', at: nowIso() });
    try {
      const body = reportToMarkdown(report, { aeNotes: aeNotes.map((n) => ({ author: n.author, text: n.text, at: fmtAt(n.at) })) });
      const { text } = await ai.ask(`${ANALYST_RULES}\n\n${aiPrompt(report, body)}`, {
        signal: ac.signal, cache: false,
        onText: (t) => { if (!live()) return; streamed = t; setInterp(myKey, { text: t, by: 'ai', at: nowIso() }); },
      });
      if (live()) setInterp(myKey, { text, by: 'ai', at: nowIso() });
    } catch (e) {
      const err = e as AiError;
      const partial = err.partial || streamed;
      if (!live()) return;
      if (err.code === 'cancelled') {
        // 중지는 오류로 알리지 않는다 — 받은 부분은 유지, 없으면 직전 상태로
        setInterp(myKey, partial ? { text: partial, by: 'ai', at: nowIso() } : prev);
      } else {
        if (keyRef.current === myKey) setNote(AI_ERROR_COPY[err.code] ?? err.message);
        setInterp(myKey, partial ? { text: partial, by: 'ai', at: nowIso() } : prev ?? { text: ruleText(), by: 'rule', at: nowIso() });
      }
    } finally {
      if (live()) setBusyKey(null);
      if (ctl.current === ac) ctl.current = null;
    }
  };

  const aiSlot = (
    <div className="row reports-noprint" style={{ gap: 8 }}>
      {busy ? (
        // 중지 버튼은 실행 버튼 자리에 바로 나타난다 — 실행 버튼 더블클릭의 두 번째 클릭(detail 2)은 중지로 받지 않는다
        <button type="button" className="btn sm" onClick={(e) => { if (e.detail > 1) return; ctl.current?.abort(); }}><Icon name="stop" size={13} />중지</button>
      ) : (
        <Button size="sm" variant="accent" icon="sparkle" onClick={run} disabled={ai.backend === 'checking'}>
          {interp?.text ? '해석 다시 생성' : ai.connected ? 'AI 해석 추가' : '규칙 엔진 해석 추가'}
        </Button>
      )}
      {interp?.text && !busy ? <Button size="sm" variant="ghost" icon="x" onClick={() => { setInterp(interpKey, null); setNote(''); }}>해석 영역 비우기</Button> : null}
      <span className="xs muted">
        {busy ? 'Claude가 본문을 읽고 해석 · 전제 조건 · 반례 · 다음 액션을 작성 중입니다.' : ai.connected ? '버튼을 누를 때만 Claude를 호출합니다. 확정 팩트와 분리된 영역에 붙습니다.' : 'AI 미연결 — 규칙 엔진이 같은 형식(해석 · 전제 조건 · 반례 · 다음 액션)으로 채웁니다.'}
      </span>
      {note ? <span className="xs muted">{note}</span> : null}
    </div>
  );

  const fileDate = report.to ?? state.data.today;
  return (
    <div className="reports-layout">
      <div className="stack-lg" style={{ minWidth: 0 }}>
        <Card className="reports-noprint">
          <div className="reports-toolbar">
            <div className="row" style={{ gap: 8 }}>
              <Pill tone="dark" icon="report">{REPORT_META[type].name} · {REPORT_META[type].when} · {REPORT_META[type].channel}</Pill>
              <span className="small ink2">{report.periodLabel}</span>
              <span className="xs muted num" title="리포트 본문 생성에 걸린 시간 (브라우저 계산)">생성 {genMs < 1 ? '1ms 미만' : `${Math.round(genMs)}ms`}</span>
              {type === 'monthly' ? (
                <Field label="대상 월" id="reports-month">
                  <select id="reports-month" className="select" style={{ width: 'auto', padding: '4px 8px' }} value={month} onChange={(e) => setMonth(e.target.value)}>
                    {months.map(({ m, provisional }) => <option key={m} value={m}>{Number(m.slice(5, 7))}월{provisional ? ' (잠정 · 월 마감 전)' : ''}</option>)}
                  </select>
                </Field>
              ) : null}
              {type === 'issue' && issues.length ? (
                <Field label="대상 이슈" id="reports-issue">
                  <select id="reports-issue" className="select" style={{ width: 'auto', maxWidth: 360, padding: '4px 8px' }} value={issueId ?? ''} onChange={(e) => setIssueId(e.target.value || null)}>
                    <option value="">열린 이슈 중 최우선 (자동)</option>
                    {issues.map((i) => <option key={i.id} value={i.id}>{i.severity} · {i.title}{i.status === 'resolved' ? ' (해결)' : ''}</option>)}
                  </select>
                </Field>
              ) : null}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <CopyButton text={markdown} label="문서 복사" />
              <DownloadButton filename={`MILDO_${type}_report_${fileDate}.md`} data={markdown} mime="text/markdown;charset=utf-8" label=".md 다운로드" />
              <CopyButton text={report.messenger} label="메신저 문구 복사" />
            </div>
          </div>
        </Card>
        {type === 'issue' && !issues.length ? (
          <Callout tone="warning" title="MILDO Alert에 등록된 이슈가 없습니다">
            아래 이슈 알림은 같은 탐지 기준으로 다시 확인한 미리보기입니다. <a href="#alert">MILDO Alert</a>에서 재스캔해 등록하면 담당 · 백업 · SLA 시각이 확정되고, 이 화면에서 이슈를 골라 리포트를 만들 수 있습니다.
          </Callout>
        ) : null}
        <ReportDocument report={report} interp={interp} aeNotes={aeNotes} aiSlot={aiSlot} />
      </div>

      <aside className="reports-side" aria-label="발송 미리보기 · 코멘트">
        <Card title={type === 'weekly' ? '메일 · 메신저 미리보기' : type === 'monthly' ? '미팅 안건 · 메신저 미리보기' : '메신저 미리보기'} sub={`${REPORT_META[type].channel} · ${sendLabel}`} actions={<Src kind="DEMO" />}>
          {type === 'weekly' ? <MailPreview report={report} to="수면밀도 마케팅팀 · PM · 담당 AE" /> : null}
          {type === 'monthly' ? (
            <div className="stack-sm">
              <div className="xs muted">월간 미팅 안건 (문서형 섹션 순서)</div>
              {report.sections.map((s) => <div key={s.id} className="small">· {s.title}</div>)}
            </div>
          ) : null}
          <MessengerPreview report={report} sendLabel={sendLabel} />
        </Card>
        <AePanel type={type} scope={scope} report={report} count={aeNotes.length} />
        <FeedbackPanel type={type} prefix={prefix} feedback={feedback} sectionTitle={sectionTitle} />
        <div className="xs muted reports-noprint">인쇄용 레이아웃: 브라우저 인쇄(Ctrl/⌘ + P) 시 문서형 본문만 출력됩니다 (메뉴 · 버튼 · 미리보기 제외).</div>
      </aside>
    </div>
  );
}

function AePanel({ type, scope, report, count }: { type: ReportType; scope: string; report: Report; count: number }) {
  const { state, dispatch } = useStore();
  const { toast } = useActions();
  const server = useSaas().mode === 'server';
  // 초안은 리포트 범위(종류 · 월 · 이슈)별로 따로 둔다 — 일간에서 만든 초안이 주간 리포트에 그대로 병합되지 않게
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = drafts[scope] ?? '';
  const setText = (v: string) => setDrafts((p) => ({ ...p, [scope]: v }));
  const canWrite = state.role !== '수면밀도';
  const merge = () => {
    const t = text.trim();
    if (!t || !canWrite) return;
    dispatch({ type: 'comment/add', comment: { id: uid('cm'), target: aeTarget(scope), author: state.role, text: t, at: nowIso() } });
    setText('');
    toast({ tone: 'good', title: 'AE 코멘트를 리포트 하단에 병합했습니다', body: `${REPORT_META[type].name} 리포트 · ${state.role}`, route: 'reports' });
  };
  return (
    <Card title="담당 AE 해석 · 다음 액션" sub={`리포트 하단 병합 · ${count}건`} className="reports-noprint">
      <label className="xs muted" htmlFor="reports-ae-note">AE 코멘트 · {report.title}</label>
      <textarea id="reports-ae-note" className="textarea" placeholder={canWrite ? '수치 해석과 다음 액션(누가 · 언제 · 판정 기준)을 적습니다.' : '수면밀도 담당자 역할에서는 섹션 단위 피드백을 남깁니다.'} value={text} disabled={!canWrite} onChange={(e) => setText(e.target.value)} rows={5} />
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" variant="primary" icon="plus" onClick={merge} disabled={!canWrite || !text.trim()}>리포트에 병합</Button>
        <Button size="sm" icon="sparkle" disabled={!canWrite} onClick={() => setText(`해석: ${report.brief.interpretation[0] ?? '—'}\n다음 액션: ${report.brief.actions[0] ?? '—'}`)}>규칙 엔진 초안</Button>
      </div>
      <div className="xs muted">
        {canWrite ? `작성자: ${state.role} · 초안은 규칙 엔진 문장이며 AE가 수정한 뒤 병합합니다.`
          : server ? '현재 멤버십 역할(광고주 담당자)은 AE 코멘트 작성 권한이 없습니다. 역할은 팀 · 권한에서 관리자가 바꿉니다.'
          : '현재 역할(수면밀도 담당자)은 AE 코멘트 작성 권한이 없습니다. 상단 역할을 담당 AE 또는 PM으로 바꾸면 작성할 수 있습니다.'}
      </div>
    </Card>
  );
}

function FeedbackPanel({ type, prefix, feedback, sectionTitle }: { type: ReportType; prefix: string; feedback: { id: string; target: string; author: string; text: string; at: string; resolved?: boolean }[]; sectionTitle: (t: string) => string }) {
  const { state, dispatch } = useStore();
  const saas = useSaas();
  const server = saas.mode === 'server';
  const client = feedback.filter((f) => f.author === '수면밀도');
  const open = client.filter((f) => !f.resolved);
  const go = (target: string) => {
    const id = target.slice(prefix.length);
    document.getElementById(`rs-${type}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  return (
    <Card title="코멘트 단위 피드백" sub={`수면밀도 담당자 피드백 · 반영 대기 ${open.length} · 반영 완료 ${client.length - open.length}`} className="reports-noprint">
      {server ? (
        // 서버 모드: 작성 역할 = 로그인 계정의 멤버십 역할 (role/set은 서버 모드에서 버려진다) — 읽기 전용
        <div className="row" style={{ gap: 6 }}>
          <span className="xs muted">작성 역할 (멤버십)</span>
          <strong className="small" aria-label="작성 역할 (멤버십)">{saas.role ? ROLE_LABEL[saas.role] : state.role}</strong>
          <span className="xs muted">역할은 팀 · 권한에서 관리자가 바꿉니다</span>
        </div>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          <span className="xs muted">작성 역할 (상단 역할과 공유)</span>
          <Segmented<AppState['role']> label="작성 역할" value={state.role} onChange={(role) => dispatch({ type: 'role/set', role })}
            options={[{ id: '담당 AE', label: '담당 AE' }, { id: 'PM', label: 'PM' }, { id: '수면밀도', label: '수면밀도 담당자' }]} />
        </div>
      )}
      {feedback.length ? (
        <div className="stack-sm">
          {feedback.slice(-6).map((f) => (
            <button key={f.id} type="button" className="reports-comment" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => go(f.target)}>
              <div className="reports-comment-body">
                <div className="reports-comment-meta"><strong>{sectionTitle(f.target)}</strong><span>{f.author === '수면밀도' ? '수면밀도 담당자' : f.author}</span>{f.author === '수면밀도' ? <Pill tone={f.resolved ? 'good' : 'warning'}>{f.resolved ? '반영 완료' : '반영 대기'}</Pill> : null}</div>
                <div>{f.text}</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="small muted">
          {state.role === '수면밀도' ? '각 섹션 아래 "이 섹션에 피드백"으로 남기면 담당 AE에게 섹션 단위로 전달됩니다.'
            : server ? '광고주 담당자 계정이 각 섹션 아래 "이 섹션에 피드백"으로 남긴 의견이 여기에 모입니다.'
            : '상단 역할을 "수면밀도 담당자"로 바꾸면 섹션 단위 피드백을 시연할 수 있습니다.'}
        </div>
      )}
      <div className="divider" />
      <div className="row-between"><span className="xs muted">최근 피드백 반영 이력</span><Src kind="DEMO" fixture title="시연용 예시 이력 · 실제 피드백 이력 아님" /></div>
      <div className="stack-sm">
        {FEEDBACK_HISTORY.map((h) => (
          <div key={h.date + h.section} className="xs">
            <div className="row-between" style={{ gap: 4 }}><strong>{fmtDate(h.date)} · {h.report} · {h.section}</strong><span className="muted num">{days(h.date, h.doneDate) <= 0 ? '당일 반영' : `${days(h.date, h.doneDate)}일 후 반영`}</span></div>
            <div className="ink2">“{h.text}” → {h.reply}</div>
          </div>
        ))}
      </div>
      <div className="xs muted">피드백은 리포트 섹션 단위로 저장되어 리포트를 다시 생성해도 같은 섹션 아래에 남습니다.</div>
    </Card>
  );
}
