/* 운영 프로세스: 감지 → 배정 → 조치 → 보고 (라이브 데모 13:00–15:00) — 이슈와 변경 요청을 하나의 타임라인으로 */
import { useMemo, useState } from 'react';
import { LIVE_DEMO, SLA } from '@/data/constants';
import { AiInsight } from '@/ui/AiInsight';
import { Icon } from '@/ui/Icon';
import { Button, Card, CopyButton, Empty, Pill, Segmented, Src } from '@/ui/primitives';
import {
  canAct, caseReport, fmtStamp, incidentDraft, incidentFix, opsBrief, opsEvents, OPS_STAGES, STAGE_LABEL, stageCounts, type OpsCase, type OpsStage, type RequestDraft,
} from './engine';
import { STATUS_META } from './data';
import { ChangeValue, StatusPill, settled } from './parts';
import { ExecBadge } from './ExecutionPanel';
import { isExecuting } from './execution';
import type { FlowCtx } from './useFlow';

export function TimelineTab({ ctx, onOpen, onDraft }: { ctx: FlowCtx; onOpen: (id: string) => void; onDraft: (d: RequestDraft) => void }) {
  const { cases, incidents, changes, clock, data, state } = ctx;
  const [stage, setStage] = useState<OpsStage | 'all'>('all');
  const [source, setSource] = useState<'all' | 'incident' | 'change'>('all');
  const [showDone, setShowDone] = useState(false);
  const events = useMemo(() => opsEvents(incidents, changes, clock.toMs), [incidents, changes, clock]);
  const feed = events.filter((e) => (stage === 'all' || e.stage === stage) && (source === 'all' || e.source === source)).slice(0, 80);
  const sc = stageCounts(cases);
  const visible = cases.filter((c) => showDone || c.current !== 'done');
  const demoSeg = LIVE_DEMO.find((x) => x.route === 'flow');

  return (
    <div className="stack-lg">
      <Card tone="dark" title="운영 프로세스 · 감지 → 배정 → 조치 → 보고" sub={`MILDO Alert가 감지한 이슈가 담당 배정 · 변경 승인 · 결과 보고까지 어디에 있는지 한 줄로 봅니다${demoSeg ? ` · 라이브 데모 ${demoSeg.from}–${demoSeg.to} '${demoSeg.title}'` : ''}`}
        actions={<><Src kind="PROPOSAL" page="p.49" /><Src kind="PROPOSAL" page="p.60" /><Src kind="DEMO" /></>}>
        <div className="flow-pipe">
          {OPS_STAGES.map((s, k) => (
            <div key={s.id} className="flow-pipe-step">
              <div className="row-between">
                <strong>{s.label}</strong>
                <span className="flow-pipe-n num">{s.id === 'detect' ? cases.length : sc[s.id]}</span>
              </div>
              <div className="xs muted">{s.desc}</div>
              <div className="xs muted">{s.id === 'detect' ? '감지된 이슈 전체' : `현재 ${s.label} 단계 이슈`}</div>
              {k < OPS_STAGES.length - 1 ? <span className="flow-pipe-arrow" aria-hidden><Icon name="chevron" size={16} /></span> : null}
            </div>
          ))}
          <div className="flow-pipe-step done">
            <div className="row-between"><strong>완료</strong><span className="flow-pipe-n num">{sc.done}</span></div>
            <div className="xs muted">결과 보고 · 해결</div>
          </div>
        </div>
        <div className="xs muted">SLA 기준: P1 인지 {SLA.P1.label.ack} · 1차 조치 {SLA.P1.label.action} · 결과 보고 {SLA.P1.label.report} / P2 인지 {SLA.P2.label.ack} · 조치 {SLA.P2.label.action} · 보고 {SLA.P2.label.report} (p.49). SLA 타이머 · 재발 방지 기록은 <a href="#alert" style={{ color: 'inherit' }}>MILDO Alert</a>에서 관리합니다.</div>
      </Card>

      <div className="grid g-3">
        <div className="span-2 stack">
          <div className="row-between">
            <h2 className="card-title">이슈별 처리 단계 <span className="muted small">{visible.length}건</span></h2>
            <Button size="sm" variant="ghost" onClick={() => setShowDone((v) => !v)}>{showDone ? '완료 숨기기' : `완료 포함 (${sc.done})`}</Button>
          </div>
          {visible.length === 0 ? <Card><Empty icon="check" title="진행 중인 이슈가 없습니다">MILDO Alert 감지 결과가 여기에 단계별로 쌓입니다.</Empty></Card> : null}
          {visible.map((c) => <CaseCard key={c.incident.id} ctx={ctx} c={c} onOpen={onOpen} onDraft={onDraft} />)}
        </div>
        <Card title="최근 활동 피드" sub="이슈 타임라인 + 요청 · 승인 이력 (최신순)" actions={<Src kind="DEMO" />}>
          <Segmented label="단계" value={stage} onChange={setStage} options={[{ id: 'all', label: '전체' }, ...OPS_STAGES.map((s) => ({ id: s.id, label: s.label }))]} />
          <Segmented label="출처" value={source} onChange={setSource} options={[{ id: 'all', label: '전체' }, { id: 'incident', label: '이슈' }, { id: 'change', label: '요청' }]} />
          {feed.length === 0 ? <Empty title="기록이 없습니다" /> : (
            <ol className="flow-feed">
              {feed.map((e) => (
                <li key={e.id} className="flow-ev">
                  <span className="num xs muted">{fmtStamp(e.atMs)}</span>
                  <span className={`flow-stage-tag s-${e.stage}`}>{STAGE_LABEL[e.stage]}</span>
                  <button type="button" className="flow-ev-body" onClick={() => (e.source === 'change' ? onOpen(e.refId) : undefined)} disabled={e.source !== 'change'}>
                    <span className="small"><strong>{e.action}</strong> <span className="muted">· {e.by}{e.auto ? ' · 자동' : ''}</span></span>
                    <span className="xs ink2">{e.severity ? <span className={`sev ${e.severity}`} style={{ marginRight: 4 }}>{e.severity}</span> : null}{e.title}{e.seed ? ' · 시연 이력' : ''}</span>
                    {e.note ? <span className="xs muted">{e.note}</span> : null}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <AiInsight title="운영 프로세스 해석" sub="병목 단계 · SLA 리스크 · 승인 대기 연결" cta="해석 생성"
        buildPrompt={() => `과제: 감지 → 배정 → 조치 → 보고 흐름에서 병목과 SLA 리스크를 판단하라. 현재 역할 ${state.role}.\n데이터(JSON):\n${JSON.stringify(cases.slice(0, 12).map((c) => ({ 등급: c.incident.severity, 이슈: c.incident.title, 단계: c.current, 단계기록: c.stages.map((s) => `${STAGE_LABEL[s.stage]}:${s.done ? fmtStamp(s.atMs ?? NaN) : '대기'} ${s.note}`), 연결요청: c.linked.map((l) => `${l.change.target} ${l.change.status}`) })))}`}
        fallback={() => opsBrief(data, incidents, changes, clock.toMs)} />
    </div>
  );
}

function CaseCard({ ctx, c, onOpen, onDraft }: { ctx: FlowCtx; c: OpsCase; onOpen: (id: string) => void; onDraft: (d: RequestDraft) => void }) {
  const { data, changes, state, act, incidentStep, createRequest } = ctx;
  const [note, setNote] = useState('');
  const i = c.incident;
  const fix = incidentFix(data, i, changes, ctx.incidents);
  return (
    <section className={`card flow-case sev-${i.severity}`}>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className={`sev ${i.severity}`}><Icon name="alert" size={11} stroke={2.4} />{i.severity}</span>
            {i.isTest ? <Pill tone="outline">테스트 이슈</Pill> : null}
            <Pill tone={c.current === 'done' ? 'good' : 'accent'}>{c.current === 'done' ? '완료' : `${STAGE_LABEL[c.current]} 단계`}</Pill>
          </div>
          <strong>{i.title}</strong>
          <span className="xs muted">{i.detectPath}</span>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <CopyButton text={() => caseReport(c)} label="운영 보고" />
          <a className="btn sm ghost" href="#alert">Alert</a>
        </div>
      </div>
      <div className="flow-stages">
        {c.stages.map((s) => (
          <div key={s.stage} className={`flow-stage${s.done ? ' done' : c.current === s.stage ? ' current' : ''}`}>
            <span className="row-between"><strong>{STAGE_LABEL[s.stage]}</strong><span className="num">{s.done ? fmtStamp(s.atMs ?? NaN, false) : c.current === s.stage ? '진행' : '대기'}</span></span>
            <span className="flow-stage-note">{s.note}</span>
          </div>
        ))}
      </div>
      {c.linked.length ? (
        <div className="stack-sm" style={{ gap: 4 }}>
          <div className="xs muted">조치 · 변경 요청</div>
          {c.linked.map(({ change: x, inferred }) => {
            const ok = canAct(state.role, x.approver).ok;
            return (
              <div key={x.id} className="flow-link-row">
                <button type="button" className="flow-link-main" onClick={() => onOpen(x.id)}>
                  <StatusPill status={x.status} /><ExecBadge c={x} /><strong className="small">{x.target}</strong><ChangeValue c={x} />{inferred ? <span className="xs muted">관련 추정</span> : null}
                </button>
                {x.status === 'pending' ? <Button size="sm" variant="primary" disabled={!ok} title={ok ? '승인' : '현재 역할 승인 범위 밖'} onClick={settled(() => act(x, 'approve'))}>승인</Button> : null}
                {x.status === 'approved' ? <Button size="sm" variant="accent" disabled={!ok || isExecuting(x)} title={isExecuting(x) ? '매체 반영이 진행 중입니다' : ok ? '반영' : '현재 역할 승인 범위 밖'} onClick={settled(() => act(x, 'apply'))}>{isExecuting(x) ? '반영 중' : '반영'}</Button> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="row" style={{ gap: 6 }}>
        {c.next ? (
          c.next.needsNote ? (
            <>
              <input className="input" style={{ maxWidth: 320 }} aria-label="1차 조치 내용" placeholder="1차 조치 내용 (예: 자동 조정 보류 유지 · 픽셀 점검 요청)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" variant="primary" disabled={!note.trim()} onClick={() => { incidentStep(i, 'action', note); setNote(''); }}>{c.next.label}</Button>
            </>
          ) : <Button size="sm" variant="primary" icon={c.next.id === 'ack' ? 'users' : 'report'} onClick={() => incidentStep(i, c.next!.id)}>{c.next.label}</Button>
        ) : c.current !== 'done' ? <span className="xs muted">해결 · 재발 방지 기록은 MILDO Alert에서</span> : null}
        {fix ? (
          fix.state
            ? <Pill tone="outline" icon="check">요청됨 · {STATUS_META[fix.state.status].label}</Pill>
            : <Button size="sm" icon="send" onClick={() => createRequest({ ...fix.input, reason: `${fix.input.reason} · 이슈 ${i.id}` })}>{fix.label}</Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="edit" onClick={() => onDraft(incidentDraft(data, i))}>조치 요청 작성</Button>
      </div>
    </section>
  );
}
