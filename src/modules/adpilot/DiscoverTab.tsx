import { useMemo, useState } from 'react';
import { KEYWORD_TEST_RULES, SA_CAMPAIGNS } from '@/data/constants';
import { fmt } from '@/core/util';
import { Button, Callout, Card, type Column, DataTable, Pill, Src } from '@/ui/primitives';
import { type AdPilotProposal, type BulkCheck, testCandidates, type TestCandidate, pct0 } from './engine';
import type { AdPilotCtx } from './useAdPilot';
import { ApproverPill, StatusPill } from './parts';
import { ProposalActions } from './ProposalsTab';

export function DiscoverTab({ ap }: { ap: AdPilotCtx }) {
  const cands = useMemo(() => testCandidates(ap.data, ap.cfg), [ap.data, ap.cfg]);
  const byTerm = useMemo(() => new Map(ap.proposals.filter((p) => p.action === 'test_candidate').map((p) => [p.keyword, p])), [ap.proposals]);
  const registered = ap.data.searchTerms.filter((t) => t.registered);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ps: AdPilotProposal[]; check: BulkCheck } | null>(null);
  const [blocked, setBlocked] = useState<BulkCheck | null>(null);

  // 서버 모드 열람자는 요청 권한이 없다 — 선택 · 일괄 등록도 막는다 (버튼은 비활성 + 이유)
  const requestable = cands.map((c) => byTerm.get(c.term)).filter((p): p is AdPilotProposal => !!p && ap.requestPerm.ok && ap.requestable(p));
  const sel = requestable.filter((p) => selected.has(p.keyword));
  const run = (ps: AdPilotProposal[], force = false) => {
    const check = ap.bulkCheck(ps);
    setBlocked(null);
    if (check.level === 'block') { setBlocked(check); setConfirm(null); return; }
    if (check.level === 'warn' && !force) { setConfirm({ ps, check }); return; }
    if (!ap.requestPerm.ok) { ap.actions.toast({ tone: 'warning', title: '변경 요청 권한이 없습니다', body: ap.requestPerm.reason }); return; }
    ps.forEach((p) => ap.request(p, true));
    ap.actions.toast({ tone: 'good', title: `테스트 그룹 등록 요청 ${ps.length}건`, body: '승인 후 테스트 전용 그룹에 입찰 상한으로 등록됩니다', route: 'flow' });
    setSelected(new Set());
    setConfirm(null);
  };

  const columns: Column<TestCandidate>[] = [
    {
      key: 'sel', width: 32, label: '',
      render: (t) => {
        const p = byTerm.get(t.term);
        const ok = !!p && ap.requestPerm.ok && ap.requestable(p);
        return <input type="checkbox" className="adpilot-check" aria-label={`${t.term} 선택`} disabled={!ok} checked={selected.has(t.term)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(t.term) ? n.delete(t.term) : n.add(t.term); return n; })} />;
      },
    },
    { key: 'term', label: '검색어 (미등록)', sort: (t) => t.term, render: (t) => <strong className="small adpilot-term">{t.term}</strong> },
    { key: 'intent', label: '의도 분류', sort: (t) => t.intent, render: (t) => <Pill tone="outline">{SA_CAMPAIGNS[t.intent].name}</Pill> },
    { key: 'clicks', label: '클릭', align: 'right', sort: (t) => t.clicks, render: (t) => fmt.int(t.clicks) },
    { key: 'conv', label: '전환', align: 'right', sort: (t) => t.conversions, render: (t) => fmt.dec1(t.conversions) },
    { key: 'roas', label: 'ROAS', align: 'right', sort: (t) => t.roas, render: (t) => <span title={`목표 ${fmt.roas(ap.cfg.targetRoas)} 대비 ${pct0((t.roas / ap.cfg.targetRoas) * 100)}`}>{fmt.roas(t.roas)}</span> },
    { key: 'cpc', label: 'CPC', align: 'right', sort: (t) => t.cpc, render: (t) => <span className="nowrap">{fmt.won(t.cpc)}</span> },
    { key: 'bid', label: '테스트 입찰 (상한)', align: 'right', sort: (t) => t.suggestedBid, render: (t) => <span className="num small nowrap"><strong>{fmt.won(t.suggestedBid)}</strong><span className="muted"> / {fmt.won(t.bidCap)}</span></span> },
    { key: 'group', label: '테스트 그룹 · 랜딩', render: (t) => <div className="stack-sm" style={{ gap: 0 }}><span className="small">{t.adgroup}</span><span className="xs muted">{t.landing}</span></div> },
    { key: 'caution', label: '주의', render: (t) => t.cautions.length ? <div className="adpilot-basis adpilot-caution">{t.cautions.join(' · ')}</div> : <span className="xs muted">—</span> },
    { key: 'status', label: '승인 · 상태', render: (t) => {
      const p = byTerm.get(t.term);
      return p ? <div className="stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}><ApproverPill level={p.approver} title={p.approverReason} /><StatusPill status={ap.statusOf(p)} /></div> : null;
    } },
    { key: 'act', label: '', align: 'right', render: (t) => { const p = byTerm.get(t.term); return p ? <ProposalActions ap={ap} p={p} /> : null; } },
  ];

  return (
    <div className="stack-lg">
      <Callout tone="info" title="신규 구매 의도 키워드 발견 → 테스트 그룹 등록 후보 (p.14)">
        검색어 보고서에서 아직 등록하지 않았지만 전환이 발생한 검색어를 찾아 구매 의도(p.35 캠페인 5종)로 분류하고, 같은 의도 MAIN 그룹 입찰 중앙값을 상한으로 테스트 전용 그룹에 등록합니다.
        테스트는 {KEYWORD_TEST_RULES.minDays}일 또는 클릭 {KEYWORD_TEST_RULES.minClicks}회 도달 후 MILDO Lab이 판정합니다(확장 ≥ 목표 100% · 유지 70~100% · 제외 &lt; 70%).
      </Callout>
      <Card title={`등록 후보 ${cands.length}개`} sub="검색어 보고서 기준 · 전환 × 목표 대비 효율 순"
        actions={<><Src kind="PROPOSAL" page="p.14 · p.26" /><Src kind="DEMO" />
          <Button size="sm" onClick={() => setSelected(new Set(requestable.map((p) => p.keyword)))} disabled={!requestable.length}>요청 가능 전체 선택</Button>
          <Button size="sm" variant="primary" icon="send" disabled={!sel.length} title={ap.requestPerm.ok ? undefined : ap.requestPerm.reason} onClick={() => run(sel)}>선택 {sel.length}건 등록 요청</Button></>}>
        {blocked ? <Callout tone="critical" title="대량 변경 차단 (p.45)">{blocked.reasons.join(' · ')}</Callout> : null}
        {confirm ? (
          <Callout tone="warning" title={`${confirm.ps.length}건 일괄 등록 — 한 번 더 확인`}>
            <div className="stack-sm">
              <span>{confirm.check.reasons.join(' · ')}</span>
              <span className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="primary" icon="check" onClick={() => run(confirm.ps, true)}>{confirm.ps.length}건 확정</Button>
                <Button size="sm" onClick={() => setConfirm(null)}>취소</Button>
              </span>
            </div>
          </Callout>
        ) : null}
        <DataTable rows={cands} columns={columns} rowKey={(t) => t.term} empty="검색어 보고서에 미등록 · 전환 발생 검색어가 없습니다" />
        <div className="row-between xs muted">
          <span>이미 등록된 검색어 {registered.length}개 제외: {registered.map((t) => t.term).join(', ') || '없음'}</span>
          <a href="#lab">MILDO Lab 테스트 파이프라인에서 판정 보기 →</a>
        </div>
      </Card>
    </div>
  );
}
