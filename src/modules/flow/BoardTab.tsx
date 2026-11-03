/* 요청 · 승인 · 반영 이력 한 화면 (p.31 예산 · 세팅 변경) — 상태별 보드 + 필터 + 내가 처리할 것 */
import { useMemo, useState } from 'react';
import type { ApprovalLevel, ChangeRequest } from '@/core/types';
import { toCsv } from '@/core/download';
import { AiInsight } from '@/ui/AiInsight';
import { Button, Callout, Card, DataTable, DownloadButton, Empty, Pill, Segmented, Src, type Column } from '@/ui/primitives';
import { KIND_LABEL, MODULE_LABEL, STATUS_META, STATUS_ORDER } from './data';
import {
  APPROVER_LABEL, bulkGuard, canAct, executionCheck, filterChanges, fmtDuration, fmtStamp, fmtValue, groupByStatus, kindLabel, leadState, moduleLabel,
  pendingBrief, roleScopeLabel, sortByCreatedDesc, type ChangeFilter,
} from './engine';
import { ApproverBadge, ChangeValue, ConfirmButton, LeadBadge, ModuleTag, SeedTag, StatusPill, settled } from './parts';
import type { FlowCtx } from './useFlow';
import { ExecBadge } from './ExecutionPanel';
import { execCsvLabel, executionState, isExecuting } from './execution';

export function BoardTab({ ctx, onOpen, onNew }: { ctx: FlowCtx; onOpen: (id: string) => void; onNew: () => void }) {
  const { changes, state, clock, summary, act, bulk, data, incidents, missingSeeds, loadSeeds, bulkAlerts, apCfg } = ctx;
  const [filter, setFilter] = useState<ChangeFilter>({ scope: 'all', module: 'all', approver: 'all', kind: 'all', q: '' });
  const [view, setView] = useState<'board' | 'table'>('board');
  const list = useMemo(() => sortByCreatedDesc(filterChanges(changes, filter, state.role, clock), clock.toMs), [changes, filter, state.role, clock]);
  const cols = useMemo(() => groupByStatus(list), [list]);
  const q = summary.queue;
  const modules = useMemo(() => [...new Set(changes.map((c) => c.module))], [changes]);
  const kinds = useMemo(() => [...new Set(changes.map((c) => c.kind))], [changes]);
  const approveGuard = bulkGuard(q.approve, 'approve', apCfg);
  /** 대량 변경 감지에 걸린 요청 id → 감지 제목 */
  const bulkOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of bulkAlerts) for (const id of b.related) if (!m.has(id)) m.set(id, b.title);
    return m;
  }, [bulkAlerts]);

  const hasExec = useMemo(() => changes.some((c) => executionState(c) !== null), [changes]);
  const columns: Column<ChangeRequest>[] = [
    { key: 'createdAt', label: '요청 시각', render: (c) => <span className="num nowrap">{fmtStamp(clock.toMs(c.createdAt))}</span>, sort: (c) => clock.toMs(c.createdAt) || 0 },
    { key: 'status', label: '상태', render: (c) => <StatusPill status={c.status} />, sort: (c) => STATUS_ORDER.indexOf(c.status) },
    { key: 'module', label: '모듈', render: (c) => <span className="row" style={{ gap: 4 }}><ModuleTag module={c.module} /><SeedTag c={c} /></span>, sort: (c) => c.module },
    { key: 'target', label: '대상', render: (c) => <strong className="small">{c.target}</strong>, sort: (c) => c.target },
    { key: 'change', label: '변경', render: (c) => <ChangeValue c={c} /> },
    { key: 'pct', label: '폭', align: 'right', render: (c) => (c.changePct !== undefined && Number.isFinite(c.changePct) ? `${c.changePct > 0 ? '+' : ''}${c.changePct.toFixed(1)}%` : '—'), sort: (c) => Math.abs(c.changePct ?? 0) },
    { key: 'approver', label: '승인 주체', render: (c) => <ApproverBadge c={c} />, sort: (c) => c.approver },
    // 서버 모드: 매체 반영 실행 상태 (dry_run 기록 · live 반영 · 반영 중) — 실행 정보가 있는 건이 하나라도 있을 때만 (데모 모드 표는 그대로)
    ...(hasExec ? [{ key: 'exec', label: '매체 반영', render: (c: ChangeRequest) => (executionState(c) ? <ExecBadge c={c} /> : <span className="muted">—</span>), sort: (c: ChangeRequest) => executionState(c)?.kind ?? '' } satisfies Column<ChangeRequest>] : []),
    { key: 'lead', label: '소요 · 기준 (p.53)', render: (c) => <LeadBadge l={leadState(c, clock.nowMs, clock.toMs)} compact />, sort: (c) => leadState(c, clock.nowMs, clock.toMs).elapsedMin },
    { key: 'by', label: '요청자', render: (c) => <span className="small">{c.requestedBy}</span>, sort: (c) => c.requestedBy },
  ];
  const csv = () => toCsv(list.map((c) => ({
    id: c.id, 요청시각: fmtStamp(clock.toMs(c.createdAt)), 상태: STATUS_META[c.status].label, 모듈: moduleLabel(c.module), 유형: kindLabel(c.kind), 대상: c.target,
    변경전: fmtValue(c, c.before), 변경후: fmtValue(c, c.after), 변경폭: c.changePct ?? '', 승인주체: APPROVER_LABEL[c.approver], 요청자: c.requestedBy, 사유: c.reason,
    이력: c.history.map((h) => `${fmtStamp(clock.toMs(h.at))} ${h.by} ${h.action}${h.note ? `(${h.note})` : ''}`).join(' / '), 시연이력: c.id.startsWith('seed_') ? 'Y' : '',
    ...(hasExec ? { 매체반영: execCsvLabel(c) } : {}),
  })));

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card className="span-2" title={<>내가 처리할 것 <Pill tone="accent">{state.role}</Pill></>} sub={`승인 범위 ${roleScopeLabel(state.role)} 건 · AE는 AE건, PM은 AE · PM건, 수면밀도는 전부 (p.53)`}
          actions={<>
            <Src kind="DEMO" />
            {q.approve.length ? (
              <ConfirmButton label={`일괄 승인 ${q.approve.length}건`} icon="check" variant="primary" disabled={!approveGuard.ok} title={approveGuard.reasons.join(' · ')} onConfirm={() => bulk(q.approve, 'approve')} />
            ) : null}
            <Button size="sm" icon="plus" onClick={onNew}>신규 요청</Button>
          </>}>
          {q.total === 0 ? (
            <Empty icon="check" title="현재 역할로 처리할 요청이 없습니다">{q.blocked.length ? `권한 밖 승인 대기 ${q.blocked.length}건 — 승인 주체: ${[...new Set(q.blocked.map((c) => APPROVER_LABEL[c.approver]))].join(' · ')}` : '승인 대기 · 반영 대기 · 보류 모두 없음'}</Empty>
          ) : (
            <div className="flow-queue">
              {[...q.approve.map((c) => ({ c, a: 'approve' as const })), ...q.apply.map((c) => ({ c, a: 'apply' as const })), ...q.held.map((c) => ({ c, a: 'resume' as const }))].map(({ c, a }) => {
                const l = leadState(c, clock.nowMs, clock.toMs);
                const ex = a === 'apply' ? executionCheck(data, changes, incidents, c) : null;
                return (
                  <div key={c.id} className={`flow-queue-row${l.overdue ? ' overdue' : ''}`}>
                    <button type="button" className="flow-queue-main" onClick={() => onOpen(c.id)}>
                      <span className="row" style={{ gap: 6 }}><StatusPill status={c.status} /><ExecBadge c={c} /><ModuleTag module={c.module} /><SeedTag c={c} /><strong className="small">{c.target}</strong></span>
                      <span className="row" style={{ gap: 8 }}><ChangeValue c={c} /><ApproverBadge c={c} /><LeadBadge l={l} compact /></span>
                      {ex && !ex.ok ? <span className="xs" style={{ color: 'var(--critical-ink)' }}>반영 시 보류 예상 · {ex.blocks[0]}</span> : null}
                    </button>
                    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      {a === 'approve' ? <Button size="sm" variant="primary" icon="check" onClick={settled(() => act(c, 'approve'))}>승인</Button> : null}
                      {a === 'apply' ? <Button size="sm" variant="accent" icon="zap" disabled={isExecuting(c)} title={isExecuting(c) ? '매체 반영이 진행 중입니다 — 끝나면 자동으로 갱신됩니다' : undefined} onClick={settled(() => act(c, 'apply'))}>{isExecuting(c) ? '반영 중' : '반영'}</Button> : null}
                      {a === 'resume' ? <Button size="sm" icon="play" onClick={settled(() => act(c, 'resume'))}>보류 해제</Button> : null}
                      <Button size="sm" variant="ghost" onClick={() => onOpen(c.id)}>상세</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {q.approve.length && approveGuard.level !== 'ok' ? <div className="xs muted">일괄 처리 점검: {approveGuard.reasons.join(' · ')}</div> : null}
          {q.blocked.length && q.total ? <div className="xs muted">권한 밖 승인 대기 {q.blocked.length}건: {q.blocked.map((c) => `${c.target} → ${APPROVER_LABEL[c.approver]}`).join(' · ')}</div> : null}
        </Card>
        <Card className="flow-status-card" title="처리 현황" sub="요청 → 승인 → 반영 · 롤백 (이번 세션 + 시연 이력)" actions={<Src kind="DEMO" />}>
          <div className="flow-mini-stats">
            {STATUS_ORDER.map((s) => (
              <div key={s} className={`flow-mini-stat st-${s}`}>
                <span className="xs muted">{STATUS_META[s].label}</span>
                <strong className="num">{summary.byStatus[s]}</strong>
              </div>
            ))}
          </div>
          <div className="small ink2">
            결정까지 평균 <strong className="num">{fmtDuration(summary.avgDecisionMin)}</strong> · p.53 소요 기준 충족 <strong className="num">{Number.isFinite(summary.metRate) ? `${Math.round(summary.metRate * 100)}%` : '—'}</strong> ({summary.decided}건) · 기준 초과 대기 <strong className="num">{summary.overdue.length}</strong>건
          </div>
          {missingSeeds.length ? (
            <Callout tone="info" title="시연용 이력이 비어 있습니다">
              <div className="stack-sm" style={{ gap: 6 }}>
                <span>최근 3일 요청 · 승인 · 반영 · 롤백 사례 {missingSeeds.length}건을 테스트 데이터로 불러옵니다 (다른 모듈 계산에 영향 없음).</span>
                <Button size="sm" icon="refresh" onClick={loadSeeds}>시연 이력 불러오기</Button>
              </div>
            </Callout>
          ) : null}
        </Card>
      </div>

      <Card title="요청 · 승인 · 반영 이력" sub="AD Pilot · GFA Control · MILDO Lab · MILDO Alert · Flow 요청을 상태별로 한 화면에서 — 카드를 누르면 누가 · 언제 · 왜 이력이 열립니다"
        actions={<>
          <Segmented label="보기" value={view} onChange={setView} options={[{ id: 'board', label: '보드' }, { id: 'table', label: '표' }]} />
          <DownloadButton filename={`mildo-flow-history-${data.today}.csv`} data={csv} mime="text/csv;charset=utf-8" label="CSV" />
        </>}>
        {bulkAlerts.length ? (
          <Callout tone="critical" title={`대량 변경 실수 감지 ${bulkAlerts.length}건 · MILDO Alert 기준 (p.45)`}>
            <div className="stack-sm" style={{ gap: 6 }}>
              {bulkAlerts.map((b) => (
                <div key={b.id} className="flow-bulk-row">
                  <span className="row" style={{ gap: 6 }}>
                    <span className={`sev ${b.severity}`}>{b.severity}</span>
                    <strong className="small">{b.title}</strong>
                    <span className="xs">{b.logged ? 'MILDO Alert 이슈 적재됨' : 'MILDO Alert 이슈 적재 대기'}</span>
                  </span>
                  <span className="xs">근거 · {b.basis}</span>
                  <span className="row" style={{ gap: 4 }}>
                    {b.related.slice(0, 8).map((id) => {
                      const x = changes.find((c) => c.id === id);
                      return x ? <Button key={id} size="sm" variant="ghost" onClick={() => onOpen(id)}>{x.target} · {STATUS_META[x.status].short}</Button> : null;
                    })}
                    {b.related.length > 8 ? <span className="xs">외 {b.related.length - 8}건</span> : null}
                    <a className="btn sm ghost" href="#alert">Alert</a>
                  </span>
                </div>
              ))}
              <span className="xs">기준: 같은 요청자 짧은 시간 내 다건 변경 · 입찰 일 조정 폭 상한 초과 · 30% 초과 예산의 수면밀도 승인 누락. 잘못 반영된 건은 상세에서 최신 건부터 롤백합니다.</span>
            </div>
          </Callout>
        ) : (
          <div className="xs muted">대량 변경 감시 (MILDO Alert 기준 · p.45): 감지 없음 — 같은 요청자 다건 변경 · 입찰 상한 초과 · 승인 라우팅 불일치를 상시 점검합니다.</div>
        )}
        <div className="flow-filters">
          <input className="input" aria-label="검색" placeholder="대상 · 사유 · 요청자 검색" value={filter.q ?? ''} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />
          <Segmented label="범위" value={filter.scope ?? 'all'} onChange={(v) => setFilter((f) => ({ ...f, scope: v }))}
            options={[{ id: 'all', label: `전체 ${changes.length}` }, { id: 'mine', label: `내 차례 ${q.total}` }, { id: 'overdue', label: `기준 초과 ${summary.overdue.length}` }, { id: 'live', label: '이번 세션' }, { id: 'seed', label: '시연 이력' }]} />
          <select className="select" aria-label="모듈" value={filter.module} onChange={(e) => setFilter((f) => ({ ...f, module: e.target.value }))}>
            <option value="all">모듈 전체</option>
            {modules.map((m) => <option key={m} value={m}>{MODULE_LABEL[m] ?? m}</option>)}
          </select>
          <select className="select" aria-label="승인 주체" value={filter.approver} onChange={(e) => setFilter((f) => ({ ...f, approver: e.target.value as ApprovalLevel | 'all' }))}>
            <option value="all">승인 주체 전체</option>
            <option value="AE">담당 AE</option>
            <option value="PM">PM</option>
            <option value="CLIENT">수면밀도</option>
          </select>
          <select className="select" aria-label="유형" value={filter.kind} onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value }))}>
            <option value="all">유형 전체</option>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
          {list.length !== changes.length ? <span className="xs muted num">{list.length}/{changes.length}건 표시</span> : null}
        </div>
        {view === 'board' ? (
          <div className="flow-board">
            {STATUS_ORDER.map((s) => (
              <section key={s} className={`flow-col st-${s}`} aria-label={STATUS_META[s].label}>
                <header className="flow-col-head">
                  <span className="row" style={{ gap: 6 }}><StatusPill status={s} /><span className="num">{cols[s]?.length ?? 0}</span></span>
                  <span className="xs muted">{STATUS_META[s].desc}</span>
                </header>
                {(cols[s] ?? []).length === 0 ? <div className="xs muted flow-col-empty">없음</div> : null}
                {(cols[s] ?? []).map((c) => {
                  const l = leadState(c, clock.nowMs, clock.toMs);
                  const mine = (c.status === 'pending' || c.status === 'approved' || c.status === 'held') && canAct(state.role, c.approver).ok;
                  return (
                    <button key={c.id} type="button" className={`flow-card${l.overdue ? ' overdue' : mine ? ' mine' : ''}`} onClick={() => onOpen(c.id)}>
                      <span className="row" style={{ gap: 4 }}><ModuleTag module={c.module} /><SeedTag c={c} />{mine ? <Pill tone="accent">내 차례</Pill> : null}{bulkOf.has(c.id) ? <Pill tone="critical" icon="alert" title={bulkOf.get(c.id)}>대량 변경</Pill> : null}</span>
                      <span className="flow-card-target">{c.target}</span>
                      <ChangeValue c={c} />
                      <ApproverBadge c={c} />
                      <ExecBadge c={c} />
                      <span className="flow-card-meta"><span>{c.requestedBy}</span><span className="num">{fmtStamp(clock.toMs(c.createdAt))}</span></span>
                      <LeadBadge l={l} compact />
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        ) : (
          <DataTable rows={list} columns={columns} rowKey={(c) => c.id} onRowClick={(c) => onOpen(c.id)} initialSort={{ key: 'createdAt', dir: 'desc' }} maxHeight={560}
            empty="조건에 맞는 요청이 없습니다" />
        )}
        <div className="xs muted">권한 체크: 승인 · 반려 · 반영 · 롤백은 요청의 승인 주체(approver)와 현재 역할을 대조합니다. 반영 시 계정 잔액 · 전환 추적 · 데이터 급변을 다시 점검하고, 통과하지 못하면 보류로 기록합니다 (p.15 04).</div>
      </Card>

      <AiInsight title="승인 대기 우선순위 해석" sub="AI 연결 시 Claude가, 미연결 시 규칙 엔진이 같은 형식으로 정리" cta="해석 생성"
        buildPrompt={() => `과제: MILDO Flow 승인 대기 목록의 처리 순서와 리스크를 현재 역할(${state.role}) 기준으로 판단하라.\n데이터(JSON):\n${JSON.stringify(changes.filter((c) => c.status === 'pending' || c.status === 'approved' || c.status === 'held').map((c) => ({ 대상: c.target, 상태: c.status, 모듈: c.module, 변경: `${c.before} → ${c.after}`, 폭: c.changePct, 승인주체: c.approver, 사유: c.reason, 대기: leadState(c, clock.nowMs, clock.toMs).text, 실행점검: c.status === 'approved' ? executionCheck(data, changes, incidents, c).blocks : undefined })))}`}
        fallback={() => pendingBrief(data, changes, incidents, state.role, clock.nowMs, clock.toMs)} />
    </div>
  );
}
