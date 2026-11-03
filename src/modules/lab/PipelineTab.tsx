/* 테스트 파이프라인 STEP 1~4 (p.26) — 후보 등록 → 테스트 집행 → 성과 검증 → 판정 · 반영 (담당자 승인 후 일괄 반영) */
import { useMemo, useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { fmt, fmtDate } from '@/core/util';
import { Button, Callout, Card, type Column, DataTable, NumberInput, Pill, ProgressBar, Src } from '@/ui/primitives';
import { LAB_DEFAULT_CRITERIA } from './data';
import {
  bulkCheck, decisionPayload, groupPools, INTENT_NAME, isRegistration, KW_VERDICT_META, pipelineSummary, registrationPayload, relatedCandidatesFor, SOURCE_LABEL,
  type LabCriteria, type PipelineItem,
} from './engine';
import { setLab } from './store';
import { ApproverPill, ChangeActions, ChangeStatusPill, KwVerdictPill, ScoreBar, useClickGuard, type LabModel } from './parts';

const STEPS = [
  { n: 1, title: '후보 등록', desc: '테스트 전용 그룹 · 입찰 상한 적용' },
  { n: 2, title: '테스트 집행', desc: '14일 또는 최소 클릭 수 도달까지' },
  { n: 3, title: '성과 검증', desc: 'CTR · 전환율 · ROAS 자동 판정' },
  { n: 4, title: '판정 · 반영', desc: '담당자 승인 후 일괄 반영' },
] as const;

const CRIT_FIELDS: { key: keyof LabCriteria; label: string; suffix: string; step: number; source: string }[] = [
  { key: 'targetRoas', label: '목표 ROAS', suffix: '%', step: 10, source: 'p.14 초기값 · 온보딩 확정' },
  { key: 'expandAtPct', label: '확장 기준 (목표 대비 ≥)', suffix: '%', step: 5, source: 'p.26' },
  { key: 'keepFromPct', label: '유지 기준 (목표 대비 ≥)', suffix: '%', step: 5, source: 'p.26' },
  { key: 'minDays', label: '테스트 기간', suffix: '일', step: 1, source: 'p.26' },
  { key: 'minClicks', label: '최소 클릭 수', suffix: '회', step: 10, source: 'p.26 초기값' },
  { key: 'minJudgeClicks', label: '판정 최소 클릭', suffix: '회', step: 5, source: '모듈 가정' },
];

const active = (c?: ChangeRequest) => !!c && c.status !== 'rejected' && c.status !== 'rolled_back';
const MODULE_LABEL: Record<string, string> = { lab: 'MILDO Lab', adpilot: 'AD Pilot', watch: 'MILDO Watch', growth: '매출 성장', gfa: 'GFA Control', flow: 'MILDO Flow' };
const KIND_LABEL: Partial<Record<ChangeRequest['kind'], string>> = { keyword_add: '키워드 등록 · 이관', keyword_exclude: '제외 키워드', setting: '설정 · 재테스트', test: '테스트', bid: '입찰', budget: '예산', status: '상태', gfa: 'GFA', alert_rule: '알림 기준' };

const APPROVER_SHORT = (a: string) => (a === 'PM' ? 'PM' : a === 'CLIENT' ? '수면밀도' : '담당 AE');

function ItemCard({ i, m, guard }: { i: PipelineItem; m: LabModel; guard: ReturnType<typeof useClickGuard> }) {
  const j = i.judgement;
  const { actions, state, perms } = m;
  const req = perms.request;
  const canDecide = i.step >= 3 && !active(i.decision) && i.source !== 'request';
  const related = j.verdict === 'expand' && i.source !== 'request' ? relatedCandidatesFor(i.phrase, m.disc.all, 3) : [];
  return (
    <div className={`lab-item v-${j.verdict}`}>
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 6 }}>
        <span className="lab-item-title">{i.phrase}</span>
        {i.isNew && i.source === 'keyword' ? <Pill tone="accent">신규</Pill> : null}
      </div>
      <span className="lab-sub">{i.sourceLabel} · {i.adgroup} · {INTENT_NAME(i.intent)}</span>
      {i.source !== 'request' ? (
        <>
          <div className="lab-prog"><span>기간</span>{i.days === null ? <span className="lab-sub">일자별 데이터 미연동</span> : <ProgressBar value={Math.min(i.days, m.crit.minDays)} max={m.crit.minDays} tone={i.days >= m.crit.minDays ? 'good' : 'ink'} label="테스트 기간" />}<span className="num">{i.days === null ? '—' : `${i.days}/${m.crit.minDays}일`}</span></div>
          <div className="lab-prog"><span>클릭</span><ProgressBar value={Math.min(j.stats.clicks, m.crit.minClicks)} max={m.crit.minClicks} marker={m.crit.minJudgeClicks} tone={j.stats.clicks >= m.crit.minClicks ? 'good' : 'ink'} label="클릭 표본" /><span className="num">{fmt.int(j.stats.clicks)}/{m.crit.minClicks}</span></div>
          <div className="lab-metrics">
            <div className="lab-metric"><span>CTR</span><strong>{fmt.pct(j.ctr, 2)}</strong></div>
            <div className="lab-metric"><span>CVR</span><strong>{fmt.pct(j.cvr, 2)}</strong></div>
            <div className="lab-metric"><span>ROAS</span><strong>{fmt.roas(j.roas)}</strong></div>
            <div className="lab-metric"><span>전환</span><strong>{fmt.dec1(j.stats.conversions)}</strong></div>
          </div>
        </>
      ) : null}
      <KwVerdictPill j={j} />
      <span className="lab-basis">{j.basis}</span>
      {i.source !== 'request' ? <span className="lab-sub">다음: {j.action}</span> : null}
      {j.cautions.map((c) => <span key={c} className="lab-sub">주의 · {c}</span>)}
      {i.notes.filter((n) => !n.startsWith('직전 14일')).slice(0, 2).map((n) => <span key={n} className="lab-sub">{n}</span>)}
      {related.length ? (
        <div className="stack-sm" style={{ gap: 4 }}>
          <span className="lab-sub">연관 키워드 추가 발굴 · 같은 토픽 미등록 후보</span>
          <div className="row lab-related" style={{ gap: 4 }}>
            {related.map((c) => (
              <Button key={c.id} size="sm" icon="plus" disabled={!req.ok} title={req.ok ? `${SOURCE_LABEL[c.source]} · ${c.score}점 · 테스트 그룹 등록 요청` : req.reason}
                onClick={guard(() => { const p = registrationPayload(c, state.role); actions.addChange(p); actions.toast({ tone: 'good', title: `연관 후보 등록 요청 · ${c.phrase}`, body: `${APPROVER_SHORT(p.approver)} 승인 대기`, route: 'flow' }); })}>
                {c.phrase} · {c.score}점
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {i.registration ? <ChangeActions c={i.registration} compact /> : null}
      {i.decision && active(i.decision) ? (
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className="lab-sub">판정 반영 요청 · {String(i.decision.after)}</span>
          <ChangeActions c={i.decision} compact />
        </div>
      ) : null}
      {canDecide ? (
        <Button size="sm" variant={i.step === 4 ? 'primary' : 'default'} icon="send" disabled={!req.ok} title={req.ok ? undefined : req.reason}
          onClick={guard(() => {
            const p = decisionPayload(i, state.role);
            actions.addChange(p);
            actions.toast({ tone: 'good', title: `${i.step === 4 ? '판정 반영' : '보류 조치'} 요청 · ${i.phrase}`, body: `${p.after} · ${APPROVER_SHORT(p.approver)} 승인 대기`, route: 'flow' });
          })}>{i.step === 4 ? `${KW_VERDICT_META[j.verdict].label} 반영 승인 요청` : '보류 조치 요청'}</Button>
      ) : null}
    </div>
  );
}

export function PipelineTab({ m }: { m: LabModel }) {
  const { pipeline, crit, disc, state, actions, d, perms } = m;
  const req = perms.request;
  const [confirmBulk, setConfirmBulk] = useState(false);
  const guard = useClickGuard();
  const s = useMemo(() => pipelineSummary(pipeline), [pipeline]);
  const pools = useMemo(() => groupPools(pipeline, crit), [pipeline, crit]);
  const by = (n: 1 | 2 | 3 | 4) => pipeline.filter((i) => i.step === n);
  const recos = disc.all.filter((c) => c.status === 'new' && c.purchase && c.tier === 'priority').slice(0, 3);
  const decidable = by(4).filter((i) => !active(i.decision) && i.source !== 'request');
  const approvedDecisions = pipeline.map((i) => i.decision).filter((c): c is ChangeRequest => !!c && c.status === 'approved');
  const bc = bulkCheck(decidable.length);
  const history = state.changes.filter((c) => c.module === 'lab' || isRegistration(c) || c.kind === 'test');

  const bulkRequest = guard((force = false) => {
    if (bc.level === 'block') return false;
    if (!req.ok) { actions.toast({ tone: 'warning', title: '변경 요청 권한이 없습니다', body: req.reason }); return false; }
    if (bc.level === 'warn' && !force) { setConfirmBulk(true); return false; }
    for (const i of decidable) {
      const p = decisionPayload(i, state.role);
      actions.addChange(bc.approver === 'PM' && p.approver === 'AE' ? { ...p, approver: 'PM' } : p);
    }
    actions.toast({ tone: 'good', title: `판정 ${decidable.length}건 일괄 반영 요청`, body: '확장(본 그룹 이관)은 PM · 유지 · 제외는 담당 AE 승인 후 반영', route: 'flow' });
    setConfirmBulk(false);
  });
  const setCrit = (k: keyof LabCriteria, v: number) => setLab((st) => ({ criteria: { ...st.criteria, [k]: v } }));

  const histCols: Column<ChangeRequest>[] = [
    { key: 'at', label: '요청', sort: (c) => c.createdAt, render: (c) => <span className="small nowrap">{fmtDate(c.createdAt.slice(0, 10))} · {c.requestedBy}</span> },
    { key: 'target', label: '대상', render: (c) => <div><strong className="small">{c.target}</strong><div className="lab-sub">{MODULE_LABEL[c.module] ?? c.module} · {KIND_LABEL[c.kind] ?? c.kind}</div></div> },
    { key: 'change', label: '변경', render: (c) => <span className="small">{String(c.before)} → <strong>{String(c.after)}</strong></span> },
    { key: 'reason', label: '사유', render: (c) => <span className="lab-basis">{c.reason}</span> },
    { key: 'status', label: '상태 · 승인', render: (c) => <ChangeActions c={c} /> },
  ];

  return (
    <div className="stack-lg">
      <Card tone="dark" title="테스트 파이프라인 · 같은 기준으로 판정해 매주 넓힙니다" sub="판정 기준값은 온보딩 기간 중 수면밀도 목표 ROAS에 맞춰 확정합니다" actions={<Src kind="PROPOSAL" page="p.26" />}>
        <div className="lab-steps">
          {STEPS.map((st) => (
            <div key={st.n} className={`lab-step${st.n === 4 && s.awaitingDecision ? ' on' : ''}`}>
              <span className="lab-step-n">STEP {st.n}</span>
              <span className="lab-step-title">{st.title}<span className="lab-step-count">{s.byStep[st.n]}</span></span>
              <span className="lab-sub">{st.desc}</span>
            </div>
          ))}
        </div>
        <div className="row xs" style={{ gap: 14, color: 'var(--panel-muted)' }}>
          <span><strong style={{ color: 'var(--panel-ink)' }}>확장</strong> 목표 ROAS {crit.expandAtPct}% 이상 → 본 그룹 이관 · 연관 키워드 추가 발굴</span>
          <span><strong style={{ color: 'var(--panel-ink)' }}>유지</strong> {crit.keepFromPct}~{crit.expandAtPct}% → 입찰 · 랜딩 조정 후 재테스트</span>
          <span><strong style={{ color: 'var(--panel-ink)' }}>제외</strong> {crit.keepFromPct}% 미만 · 전환 없음 → 제외 키워드 등록 · 사유 기록</span>
        </div>
      </Card>

      <div className="lab-kanban">
        <div className="lab-col">
          <div className="lab-col-head"><span className="lab-col-title">STEP 1 · 후보 등록 <Pill>{by(1).length}</Pill></span><span className="lab-sub">승인 대기 등록 요청 · 추천 후보</span></div>
          {by(1).map((i) => <ItemCard key={i.id} i={i} m={m} guard={guard} />)}
          {recos.map((c) => (
            <div key={c.id} className="lab-item ghost">
              <span className="lab-item-title">{c.phrase}</span>
              <span className="lab-sub">추천 · {SOURCE_LABEL[c.source]} · {INTENT_NAME(c.intent)} · 입찰 상한 {fmt.won(c.bidCap)}</span>
              <ScoreBar score={c.score} />
              <Button size="sm" icon="plus" disabled={!req.ok} title={req.ok ? undefined : req.reason} onClick={guard(() => { const p = registrationPayload(c, state.role); actions.addChange(p); actions.toast({ tone: 'good', title: `등록 요청 · ${c.phrase}`, body: `${APPROVER_SHORT(p.approver)} 승인 대기`, route: 'flow' }); })}>등록 요청</Button>
            </div>
          ))}
          {!by(1).length && !recos.length ? <span className="lab-sub">등록 대기 항목이 없습니다</span> : null}
        </div>
        <div className="lab-col">
          <div className="lab-col-head"><span className="lab-col-title">STEP 2 · 테스트 집행 <Pill>{by(2).length}</Pill></span><span className="lab-sub">{crit.minDays}일 또는 클릭 {crit.minClicks}회 도달 전 · 입찰 변경 금지</span></div>
          {by(2).map((i) => <ItemCard key={i.id} i={i} m={m} guard={guard} />)}
          {!by(2).length ? <span className="lab-sub">집행 중인 테스트가 없습니다</span> : null}
        </div>
        <div className="lab-col">
          <div className="lab-col-head"><span className="lab-col-title">STEP 3 · 성과 검증 <Pill>{by(3).length}</Pill></span><span className="lab-sub">기간 도달 · 판정 보류 (클릭 {crit.minJudgeClicks}회 미만)</span></div>
          {pools.map((p) => (
            <Callout key={p.adgroup} tone="info" title={`${p.adgroup} 합산 · ${p.count}개`}>
              클릭 {fmt.int(p.stats.clicks)} · 전환 {fmt.dec1(p.stats.conversions)} · 합산 판정 {p.judgement.badge}{p.judgement.cautions[0] ? ` — ${p.judgement.cautions[0]}` : ''}
            </Callout>
          ))}
          {by(3).map((i) => <ItemCard key={i.id} i={i} m={m} guard={guard} />)}
          {!by(3).length ? <span className="lab-sub">보류 항목이 없습니다</span> : null}
        </div>
        <div className="lab-col">
          <div className="lab-col-head"><span className="lab-col-title">STEP 4 · 판정 · 반영 <Pill tone={decidable.length ? 'accent' : 'neutral'}>{by(4).length}</Pill></span><span className="lab-sub">자동 판정 → 담당자 승인 후 일괄 반영</span></div>
          {decidable.length ? (
            <Button size="sm" variant="primary" icon="send" disabled={bc.level === 'block' || !req.ok} title={req.ok ? bc.reason : req.reason} onClick={() => bulkRequest()}>판정 {decidable.length}건 일괄 승인 요청</Button>
          ) : null}
          {approvedDecisions.length ? (() => {
            // 데모: 승인 범위 안의 건, 서버: 반영 권한(승인 + 운영)이 있는 건만 — 없으면 비활성 + 이유
            const applicable = approvedDecisions.filter((c) => perms.check(c.approver, 'apply').ok);
            const why = applicable.length ? undefined : perms.check(approvedDecisions[0].approver, 'apply').reason || `현재 역할 ${perms.roleLabel}`;
            return (
              <Button size="sm" variant="accent" icon="check" disabled={perms.server && !applicable.length} title={perms.server ? why : undefined} onClick={guard(() => {
                let n = 0;
                for (const c of approvedDecisions) {
                  if (perms.check(c.approver, 'apply').ok) { actions.updateChange(c.id, { status: 'applied' }, '일괄 반영'); n += 1; }
                }
                if (perms.server && n) actions.toast({ tone: 'info', title: `승인된 판정 ${n}건 반영 요청을 보냈습니다`, body: '서버 실행 점검 · 매체 반영 결과는 MILDO Flow에서 이어서 알립니다', route: 'flow' });
                else actions.toast({ tone: n ? 'good' : 'warning', title: n ? `승인된 판정 ${n}건 반영` : '반영 권한이 없습니다', body: n ? undefined : `현재 역할 ${m.state.role}` });
              })}>승인된 {approvedDecisions.length}건 일괄 반영</Button>
            );
          })() : null}
          {confirmBulk ? (
            <Callout tone="warning" title="일괄 요청 — 한 번 더 확인">
              <div className="stack-sm"><span>{bc.reason}</span><span className="row" style={{ gap: 6 }}><Button size="sm" variant="primary" onClick={() => bulkRequest(true)}>확정</Button><Button size="sm" onClick={() => setConfirmBulk(false)}>취소</Button></span></div>
            </Callout>
          ) : null}
          {by(4).map((i) => <ItemCard key={i.id} i={i} m={m} guard={guard} />)}
          {!by(4).length ? <span className="lab-sub">판정 완료 항목이 없습니다</span> : null}
        </div>
      </div>
      <div className="row xs muted" style={{ gap: 10 }}>
        <Src kind="DEMO" /><span>키워드 성과는 TEST DATA · 기간은 데이터 기준일 {fmtDate(d.today)} 기준 (키워드 일자별 = 어제까지 14일). 막대의 세로선은 판정 최소 클릭 {crit.minJudgeClicks}회.</span>
      </div>

      <div className="grid g-3">
        <Card title="판정 기준값" sub="온보딩 중 확정 · 바꾸면 칸반 판정이 즉시 다시 계산됩니다" actions={<><Src kind="PROPOSAL" page="p.26" /><Button size="sm" icon="refresh" onClick={() => setLab({ criteria: { ...LAB_DEFAULT_CRITERIA } })}>초기값</Button></>}>
          <div className="grid g-2" style={{ gap: 10 }}>
            {CRIT_FIELDS.map((f) => (
              <div key={f.key} className="field">
                <label htmlFor={`lab-c-${f.key}`}>{f.label}</label>
                <NumberInput id={`lab-c-${f.key}`} value={crit[f.key]} step={f.step} min={1} suffix={f.suffix} onChange={(v) => setCrit(f.key, v)} />
                <span className="lab-sub">{f.source} · 초기 {LAB_DEFAULT_CRITERIA[f.key]}{f.suffix}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="span-2" title={`Lab 요청 · 승인 · 반영 이력 · ${history.length}건`} sub="등록 요청 · 판정 반영 · 테스트 카드 · 다른 모듈 테스트 요청 모두 MILDO Flow와 같은 이력(state.changes)에 남습니다" actions={<a className="btn sm" href="#flow">MILDO Flow 열기</a>}>
          <DataTable rows={history} columns={histCols} rowKey={(c) => c.id} maxHeight={360} empty="아직 Lab 요청이 없습니다. 발굴 탭이나 STEP 1 추천 후보에서 등록 요청을 만드세요." />
          {history.length ? <div className="row xs muted" style={{ gap: 6 }}><span>승인 대기 {history.filter((c) => c.status === 'pending').length}건</span>{history.slice(0, 1).map((c) => <span key={c.id} className="row" style={{ gap: 4 }}>최근 <ChangeStatusPill c={c} /><ApproverPill level={c.approver} /></span>)}</div> : null}
        </Card>
      </div>
    </div>
  );
}
