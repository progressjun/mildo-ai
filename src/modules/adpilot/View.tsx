/**
 * AD Pilot 입찰 · 예산 최적화 + GFA Control v1 (제안서 p.14–16)
 * 라이브 데모 03:00–07:00 "SA 키워드 자동화: 키워드 진단 · 신규 후보 발굴 · 자동 입찰 검증"
 */
import './styles.css';
import { useMemo, useState } from 'react';
import { MEDIA } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { Callout, Card, PageHeader, Pill, Src, Stat, Tabs } from '@/ui/primitives';
import { clock, proposalCounts, RULE_LABEL, saKeywordTotals, type AdPilotProposal, pct0 } from './engine';
import { RULE_TABLE } from './data';
import { useAdPilot, type AdPilotCtx } from './useAdPilot';
import { type ActionFilter, ProposalsTab } from './ProposalsTab';
import { DiagnosisTab } from './DiagnosisTab';
import { DiscoverTab } from './DiscoverTab';
import { VerifyTab } from './VerifyTab';
import { GfaTab } from './GfaTab';
import { HistoryTab } from './HistoryTab';

type TabId = 'proposals' | 'diagnosis' | 'discover' | 'verify' | 'gfa' | 'history';

const RULE_FILTER: Record<(typeof RULE_TABLE)[number]['id'], ActionFilter> = {
  high_efficiency: 'bid_up', below_target: 'bid_down', early_exhaust: 'budget', new_intent: 'test_candidate', anomaly: 'hold',
};

function ruleStats(ap: AdPilotCtx) {
  const ps = ap.proposals;
  const c = ap.cfg;
  const watchBelow = ap.diag.filter((d) => d.ruleId === 'below_target' && d.verdict === 'watch').length;
  const early = ap.paces.filter((p) => p.earlyExhaust).length;
  return {
    high_efficiency: { n: ps.filter((p) => p.action === 'bid_up').length, unit: '건 상향', th: `ROAS ≥ 목표×${c.highEfficiencyRoasRatio} · 손실 ≥ ${Math.round(c.lostShareTrigger * 100)}% · 상한 ${c.dailyChangeCapPct}% · 브랜드 ${fmt.roas(c.brandTargetRoas)}` },
    below_target: { n: ps.filter((p) => p.action === 'bid_down').length, unit: `건 하향 · 표본 부족 ${watchBelow}`, th: `14일 · 직전 14일 모두 < ${fmt.roas(c.targetRoas)} · 전환 ≥ ${c.minConversionsForDown}` },
    early_exhaust: { n: early, unit: `개 캠페인 · 제안 ${ps.filter((p) => p.action === 'budget_shift').length}`, th: `예상 마감 ${c.exhaustBeforeHour}시 전 (시간대 가중 · 선형)` },
    new_intent: { n: ps.filter((p) => p.action === 'test_candidate').length, unit: '개 후보', th: '검색어 보고서 미등록 + 전환 발생' },
    anomaly: { n: ps.filter((p) => p.action === 'hold').length, unit: '건 보류', th: `최근 3일 CPC · 전환 ±${c.anomalyHoldPct}% · 오늘 동시간 ±${c.anomalyHoldPct}% · 추적 단절` },
  };
}

function HoldBanner({ holds }: { holds: AdPilotProposal[] }) {
  if (!holds.length) return null;
  const p1 = holds.some((h) => h.holdKind === 'tracking_break' || h.holdKind === 'account');
  return (
    <Callout tone={p1 ? 'critical' : 'warning'} title={`자동 조정 보류 ${holds.length}건 — 원인 확인 전까지 해당 대상의 입찰 · 예산을 자동으로 움직이지 않습니다`}>
      <div className="stack-sm" style={{ gap: 3 }}>
        {holds.map((h) => (
          <span key={h.id}>
            <strong>{h.keyword}</strong> · {RULE_LABEL[h.ruleId]} — {h.basis}
          </span>
        ))}
        <span className="row" style={{ gap: 8 }}><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.14 · p.44" /><a href="#alert">MILDO Alert 이슈 큐에서 조치 상태 보기 →</a></span>
      </div>
    </Callout>
  );
}

export default function View() {
  const ap = useAdPilot();
  const [tab, setTab] = useState<TabId>('proposals');
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [verifyKw, setVerifyKw] = useState<string | null>(null);
  const counts = proposalCounts(ap.proposals);
  const holds = ap.proposals.filter((p) => p.action === 'hold');
  const totals = useMemo(() => saKeywordTotals(ap.data), [ap.data]);
  const stats = ruleStats(ap);
  const pending = ap.changes.filter((c) => c.status === 'pending');
  const mine = pending.filter((c) => ap.canApprove(c).ok);
  const applied = ap.changes.filter((c) => c.status === 'applied' && c.kind !== 'setting');
  const rolled = ap.changes.filter((c) => c.status === 'rolled_back');
  const nbRatio = (totals.nonBrand.roas / ap.cfg.targetRoas) * 100;
  const gfaCritical = ap.gfa.filter((v) => v.level === 'critical').length;
  const early = ap.paces.filter((p) => p.earlyExhaust);

  return (
    <div className="page">
      <PageHeader
        eyebrow="02 RESOURCE SAVING & DATA AUTOMATION · AD PILOT"
        title="AD Pilot · GFA Control v1"
        sub="목표 KPI에 맞춘 규칙으로 입찰과 예산을 조정하고, 모든 변경은 승인 · 기록 · 롤백이 가능합니다. 입찰 조정안 생성부터 GFA 변경 승인까지 한 화면에서 처리합니다."
        sources={<>
          <Src kind="PROPOSAL" page="p.14–16" /><Src kind="DEMO" />
          <span className="xs muted">데이터 기준 {fmtDate(ap.data.today)} {String(ap.data.currentHour).padStart(2, '0')}:30 · 현재 역할 {ap.state.role} · 공식 기준 목표 ROAS {fmt.roas(ap.official.targetRoas)}{ap.dirty.length ? ` (화면은 미승인 기준 ${ap.dirty.length}건 시뮬레이션 중)` : ''}</span>
        </>}
      />

      <div className="grid g-5">
        <Card>
          <Stat label="조정 후보" src={<Src kind="DEMO" />} value={`${counts.total}건`}
            foot={<span className="xs">상향 {counts.up} · 하향 {counts.down} · 예산 {counts.budget} · 테스트 {counts.test}</span>} />
        </Card>
        <Card>
          <Stat label="자동 조정 보류" src={<Src kind="DEMO" />} value={`${counts.hold}건`}
            foot={<span className="xs">{holds.slice(0, 3).map((h) => h.keyword.split(' · ')[0]).join(' · ') || '없음'}</span>} />
        </Card>
        <Card>
          <Stat label="승인 대기 (AD Pilot · GFA)" value={`${pending.length}건`}
            foot={<span className="xs">{ap.state.role} 승인 가능 {mine.length}건 · 나머지는 상위 승인</span>} />
        </Card>
        <Card>
          <Stat label="반영 중 변경" value={`${applied.length}건`} foot={<span className="xs">롤백 {rolled.length}건 · 모든 반영은 즉시 롤백 가능</span>} />
        </Card>
        <Card>
          <Stat label="SA 비브랜드 ROAS 14일" src={<Src kind="DEMO" />} value={fmt.roas(totals.nonBrand.roas)}
            foot={<Pill tone={nbRatio >= 100 ? 'good' : 'serious'} icon={nbRatio >= 100 ? 'check' : 'alert'}>{nbRatio >= 100 ? '충족' : '미달'} · 목표 {fmt.roas(ap.cfg.targetRoas)} 대비 {pct0(nbRatio)}</Pill>} />
        </Card>
      </div>

      <div className="stack-sm">
        <div className="row-between">
          <strong className="small">AD Pilot 규칙 (조건 → 자동 조정) · 오늘 탐지</strong>
          <span className="row xs muted" style={{ gap: 6 }}><Src kind="PROPOSAL" page="p.14" />카드를 누르면 조정 후보가 해당 규칙으로 필터됩니다</span>
        </div>
        <div className="adpilot-rules">
          {RULE_TABLE.map((r) => {
            const s = stats[r.id];
            const f = RULE_FILTER[r.id];
            return (
              <button key={r.id} type="button" className="adpilot-rule" aria-pressed={tab === 'proposals' && filter === f} onClick={() => { setFilter(filter === f && tab === 'proposals' ? 'all' : f); setTab('proposals'); }}>
                <span className="adpilot-cond">{r.cond}</span>
                <span className="adpilot-auto">→ {r.auto}</span>
                <span className="row" style={{ gap: 6, alignItems: 'baseline' }}><span className="adpilot-cnt">{s.n}</span><span className="xs muted">{s.unit}</span></span>
                <span className="adpilot-th">기준: {s.th}</span>
              </button>
            );
          })}
        </div>
      </div>

      <HoldBanner holds={holds} />

      {early.length ? (
        <div className="row xs muted" style={{ gap: 8 }}>
          <Src kind="DEMO" /><span>일 예산 조기 소진 예상 (시간대 가중 · 기준 {ap.cfg.exhaustBeforeHour}시 전):</span>
          {early.map((p) => <Pill key={p.id} tone="warning" icon="clock">{p.name} {clock(p.curveExhaustHour ?? p.linearExhaustHour)} · {MEDIA[p.media].short}</Pill>)}
          {gfaCritical ? <Pill tone="critical" icon="wallet">GFA 계정 잔액 1일치 미만</Pill> : null}
        </div>
      ) : null}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'proposals', label: '조정 후보 · 승인', badge: <Pill tone="outline">{counts.total}</Pill> },
          { id: 'diagnosis', label: '키워드 진단', badge: <Pill tone="outline">{ap.diag.length}</Pill> },
          { id: 'discover', label: '신규 후보 발굴', badge: <Pill tone="outline">{counts.test}</Pill> },
          { id: 'verify', label: '자동 입찰 검증' },
          { id: 'gfa', label: 'GFA Control v1', badge: gfaCritical ? <Pill tone="critical">{gfaCritical}</Pill> : undefined },
          { id: 'history', label: '변경 이력', badge: ap.changes.length ? <Pill tone="outline">{ap.changes.length}</Pill> : undefined },
        ]}
      />

      {tab === 'proposals' ? <ProposalsTab ap={ap} filter={filter} setFilter={setFilter} onHistory={() => setTab('history')} /> : null}
      {tab === 'diagnosis' ? <DiagnosisTab ap={ap} onVerify={(id) => { setVerifyKw(id); setTab('verify'); }} /> : null}
      {tab === 'discover' ? <DiscoverTab ap={ap} /> : null}
      {tab === 'verify' ? <VerifyTab ap={ap} keywordId={verifyKw} setKeywordId={setVerifyKw} /> : null}
      {tab === 'gfa' ? <GfaTab ap={ap} /> : null}
      {tab === 'history' ? <HistoryTab ap={ap} /> : null}
    </div>
  );
}
