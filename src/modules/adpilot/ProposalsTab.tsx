import { useMemo, useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { fmt } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { Button, Callout, Card, type Column, DataTable, Pill, Segmented, Src } from '@/ui/primitives';
import { type AdPilotProposal, type BulkCheck, adpilotBrief, proposalsSnapshot } from './engine';
import { ACTIVE, type AdPilotCtx } from './useAdPilot';
import { ActionPill, ApproverPill, BeforeAfter, ProposalDrawer, StatusPill, targetSub } from './parts';
import { SafetyPanel } from './SafetyPanel';

export type ActionFilter = 'all' | 'bid_up' | 'bid_down' | 'budget' | 'test_candidate' | 'hold';

export function matchesFilter(p: AdPilotProposal, f: ActionFilter) {
  if (f === 'all') return true;
  if (f === 'budget') return p.ruleId === 'early_exhaust';
  return p.action === f;
}

/** 변경 요청 상태별 버튼 (승인 · 반려 · 반영/실행 · 롤백 · 재실행) — 권한 없으면 비활성 + 이유 */
export function ChangeButtons({ ap, c }: { ap: AdPilotCtx; c: ChangeRequest }) {
  if (c.status === 'pending') {
    const perm = ap.canApprove(c);
    return (
      <>
        <Button size="sm" variant="accent" icon="check" disabled={!perm.ok} title={perm.reason} onClick={() => ap.approve(c)}>승인</Button>
        <Button size="sm" icon="x" disabled={!perm.ok} title={perm.reason} onClick={() => ap.reject(c)}>반려</Button>
        {!perm.ok ? <span className="xs muted" title={perm.reason}>권한 없음 · {c.approver === 'CLIENT' ? '수면밀도' : c.approver === 'PM' ? 'PM' : '담당 AE'} 승인 건</span> : null}
      </>
    );
  }
  if (c.status === 'approved') return <Button size="sm" variant="primary" icon="zap" onClick={() => ap.apply(c)}>{c.module === 'gfa' ? '실행' : '반영'}</Button>;
  if (c.status === 'applied') {
    const r = ap.canRollback(c);
    return <Button size="sm" icon="rollback" disabled={!r.ok} title={r.reason} onClick={() => ap.rollback(c)}>롤백</Button>;
  }
  if (c.status === 'held') {
    return (
      <>
        <Button size="sm" icon="refresh" title="충전 확인 후 재실행" onClick={() => ap.retry(c)}>재실행</Button>
        <Button size="sm" icon="x" onClick={() => ap.cancel(c)}>실행 취소</Button>
      </>
    );
  }
  return null;
}

export function ProposalActions({ ap, p }: { ap: AdPilotCtx; p: AdPilotProposal }) {
  const c = ap.changeOf(p);
  const active = c && ACTIVE.has(c.status);
  return (
    <span className="adpilot-row-actions" onClick={(e) => e.stopPropagation()}>
      {p.action === 'hold' ? <Button size="sm" icon="bell" onClick={() => ap.notify(p)}>알림 발송</Button> : null}
      {ap.requestable(p) ? (
        <Button size="sm" variant="primary" icon={p.holdKind === 'soldout' ? 'pause' : 'send'} onClick={() => ap.request(p)}>
          {p.holdKind === 'soldout' ? '일시 중지 요청' : c ? '재요청' : '승인 요청'}
        </Button>
      ) : null}
      {active ? <ChangeButtons ap={ap} c={c!} /> : null}
    </span>
  );
}

type BulkAction = 'request' | 'approve' | 'apply';
const BULK_LABEL: Record<BulkAction, string> = { request: '승인 요청', approve: '승인', apply: '반영' };

export function ProposalsTab({ ap, filter, setFilter, onHistory }: { ap: AdPilotCtx; filter: ActionFilter; setFilter: (f: ActionFilter) => void; onHistory: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<AdPilotProposal | null>(null);
  const [confirm, setConfirm] = useState<{ action: BulkAction; ids: string[]; check: BulkCheck } | null>(null);
  const [blocked, setBlocked] = useState<{ action: BulkAction; check: BulkCheck } | null>(null);

  const rows = useMemo(() => ap.proposals.filter((p) => matchesFilter(p, filter)), [ap.proposals, filter]);
  const sel = rows.filter((p) => selected.has(p.id));
  const forAction = (a: BulkAction, ps: AdPilotProposal[]) => ps.filter((p) => {
    const c = ap.changeOf(p);
    if (a === 'request') return ap.requestable(p);
    if (a === 'approve') return c?.status === 'pending' && ap.canApprove(c).ok;
    return c?.status === 'approved';
  });
  const counts = { request: forAction('request', sel).length, approve: forAction('approve', sel).length, apply: forAction('apply', sel).length };

  const execute = (a: BulkAction, ids: string[]) => {
    const ps = ap.proposals.filter((p) => ids.includes(p.id));
    let n = 0;
    for (const p of ps) {
      const c = ap.changeOf(p);
      if (a === 'request' && ap.request(p, true)) n++;
      if (a === 'approve' && c && ap.approve(c, true)) n++;
      if (a === 'apply' && c && ap.apply(c, true)) n++;
    }
    ap.actions.toast({ tone: 'good', title: `일괄 ${BULK_LABEL[a]} ${n}건`, body: a === 'request' ? '승인 대기로 MILDO Flow에 기록했습니다' : a === 'apply' ? '모든 건은 개별 롤백 가능합니다' : undefined, route: 'flow' });
    setSelected(new Set());
    setConfirm(null);
    setBlocked(null);
  };
  const runBulk = (a: BulkAction) => {
    const ps = forAction(a, sel);
    const check = ap.bulkCheck(ps);
    setBlocked(null);
    setConfirm(null);
    if (check.level === 'block') { setBlocked({ action: a, check }); return; }
    if (check.level === 'warn') { setConfirm({ action: a, ids: ps.map((p) => p.id), check }); return; }
    execute(a, ps.map((p) => p.id));
  };

  const selectable = (p: AdPilotProposal) => forAction('request', [p]).length > 0 || forAction('approve', [p]).length > 0 || forAction('apply', [p]).length > 0;
  const allSel = rows.filter(selectable);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const columns: Column<AdPilotProposal>[] = [
    {
      key: 'sel', width: 32,
      label: <input type="checkbox" className="adpilot-check" aria-label="선택 가능한 후보 전체 선택" checked={allSel.length > 0 && allSel.every((p) => selected.has(p.id))}
        onChange={(e) => setSelected(e.target.checked ? new Set(allSel.map((p) => p.id)) : new Set())} />,
      render: (p) => (
        <input type="checkbox" className="adpilot-check" aria-label={`${p.keyword} 선택`} disabled={!selectable(p)} checked={selected.has(p.id)}
          onClick={(e) => e.stopPropagation()} onChange={() => toggle(p.id)} />
      ),
    },
    { key: 'action', label: '조치 · 규칙', sort: (p) => p.action, render: (p) => <div className="stack-sm" style={{ gap: 2 }}><ActionPill p={p} /><span className="xs muted nowrap">{p.rule}</span></div> },
    { key: 'target', label: '대상', sort: (p) => p.keyword, render: (p) => <div className="stack-sm" style={{ gap: 0 }}><strong className="small">{p.keyword}</strong><span className="xs muted">{targetSub(p)}</span></div> },
    { key: 'basis', label: '판정 근거 (기준값)', render: (p) => <div className="adpilot-basis">{p.basis}</div> },
    { key: 'ba', label: '현재 → 제안', align: 'right', sort: (p) => p.changePct, render: (p) => <BeforeAfter p={p} /> },
    { key: 'expected', label: '예상 효과', render: (p) => <div className="adpilot-basis">{p.expected}</div> },
    { key: 'approver', label: '승인', sort: (p) => p.approver, render: (p) => <ApproverPill level={p.approver} title={p.approverReason} /> },
    { key: 'status', label: '상태', sort: (p) => ap.statusOf(p), render: (p) => (p.action === 'hold' && ap.statusOf(p) === 'none' ? <Pill tone="warning" icon="pause">보류 중</Pill> : <StatusPill status={ap.statusOf(p)} />) },
    { key: 'act', label: '', align: 'right', render: (p) => <ProposalActions ap={ap} p={p} /> },
  ];

  const filters: { id: ActionFilter; label: string }[] = [
    { id: 'all', label: `전체 ${ap.proposals.length}` },
    { id: 'bid_up', label: `상향 ${ap.proposals.filter((p) => p.action === 'bid_up').length}` },
    { id: 'bid_down', label: `하향 ${ap.proposals.filter((p) => p.action === 'bid_down').length}` },
    { id: 'budget', label: `예산 ${ap.proposals.filter((p) => p.ruleId === 'early_exhaust').length}` },
    { id: 'test_candidate', label: `테스트 후보 ${ap.proposals.filter((p) => p.action === 'test_candidate').length}` },
    { id: 'hold', label: `보류 ${ap.proposals.filter((p) => p.action === 'hold').length}` },
  ];

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card className="span-2" title="조정 후보 → 승인 요청 → 승인 → 반영 → 롤백"
          sub="행을 누르면 근거 · SAFETY 점검 · 원인 후보 · 예상 효과 · 변경 이력을 봅니다. 승인 주체는 변경 폭 기준으로 자동 결정됩니다."
          actions={<><Src kind="PROPOSAL" page="p.14" /><Src kind="DEMO" /></>}>
          <div className="row-between">
            <Segmented label="조치 필터" options={filters} value={filter} onChange={(v) => { setFilter(v); setSelected(new Set()); }} />
            <div className="row" style={{ gap: 6 }}>
              <span className="small muted">선택 {sel.length}건</span>
              <Button size="sm" icon="send" disabled={!counts.request} onClick={() => runBulk('request')}>일괄 승인 요청 {counts.request || ''}</Button>
              <Button size="sm" icon="check" variant="accent" disabled={!counts.approve} onClick={() => runBulk('approve')}>일괄 승인 {counts.approve || ''}</Button>
              <Button size="sm" icon="zap" variant="primary" disabled={!counts.apply} onClick={() => runBulk('apply')}>일괄 반영 {counts.apply || ''}</Button>
            </div>
          </div>
          {blocked ? (
            <Callout tone="critical" title={`일괄 ${BULK_LABEL[blocked.action]} 차단 — 대량 변경 실수 방지 (p.45)`}>
              {blocked.check.reasons.join(' · ')}
            </Callout>
          ) : null}
          {confirm ? (
            <Callout tone="warning" title={`일괄 ${BULK_LABEL[confirm.action]} ${confirm.ids.length}건 — 한 번 더 확인`}>
              <div className="stack-sm">
                <span>{confirm.check.reasons.join(' · ')}. 예상 일 비용 영향 {fmt.krw(confirm.check.costDelta)} (탄력성 가정).</span>
                <span className="row" style={{ gap: 6 }}>
                  <Button size="sm" variant="primary" icon="check" onClick={() => execute(confirm.action, confirm.ids)}>{confirm.ids.length}건 확정</Button>
                  <Button size="sm" onClick={() => setConfirm(null)}>취소</Button>
                </span>
              </div>
            </Callout>
          ) : null}
          <DataTable rows={rows} columns={columns} rowKey={(p) => p.id} maxHeight={620} onRowClick={setOpen} selectedKey={open?.id ?? null}
            empty="해당 조건의 조정 후보가 없습니다" />
          <div className="xs muted">
            대량 변경 기준: 한 번에 {ap.cfg.bulkWarnCount}건 이상 2단계 확인, {ap.cfg.bulkBlockCount}건 이상 차단, 입찰은 일 조정 폭 상한 {ap.cfg.dailyChangeCapPct}% 초과 차단.
            반영은 데모 환경에서 로컬 상태로 기록되며 실제 연동 시 매체 API로 실행합니다.
          </div>
        </Card>
        <SafetyPanel ap={ap} onHistory={onHistory} />
      </div>
      <AiInsight
        title="AD Pilot 조정안 해석"
        sub="승인 우선순위 · 증분 효율 · 반례 — AI 미연결 시 규칙 엔진 결과"
        cta="조정안 해석"
        buildPrompt={() => [
          '과제: 아래 AD Pilot 조정 후보(네이버 SA 입찰 · 캠페인 예산 · 테스트 후보 · 보류)를 검토해 승인 우선순위와 리스크를 판단하라.',
          '상향 후보는 증분 ROAS(탄력성 가정)와 순위 제한형 손실 여부로, 보류 건은 원인 후보 순위와 해제 조건으로, 예산 재배분은 한계 ROAS와 월 페이싱으로 판단한다.',
          '수치는 시연용 테스트 데이터(TEST DATA)다.',
          `데이터:\n${JSON.stringify(proposalsSnapshot(ap.proposals, ap.cfg))}`,
        ].join('\n')}
        fallback={() => adpilotBrief(ap.data, ap.changes, ap.cfg)}
      />
      {open ? (
        <ProposalDrawer p={open} change={ap.changeOf(open)} onClose={() => setOpen(null)} actions={<ProposalActions ap={ap} p={open} />} />
      ) : null}
    </div>
  );
}
