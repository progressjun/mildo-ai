/* 감지 이벤트 상세 — 영향 진단 근거 · 원인 후보 · 실행안 · 소액 테스트 설계 · 랩업 판정 · 처리 이력 */
import { fmt, fmtDate } from '@/core/util';
import { Button, Callout, Card, Drawer, Pill, Sev, Src } from '@/ui/primitives';
import { APPROVER_LABEL, CHANGE_STATUS_LABEL, evidenceLine, executionRisks, fmtDelta, fmtKst, INCIDENT_STATUS_LABEL, KIND_LABEL, kstMs, linkedIncidents, OS_SCENARIO, STAGE_LABEL } from './engine';
import { fmtLogAt, type WatchCtx } from './hooks';
import { CauseBars, Chips, DueTag, EvidenceTable, ImpactBadge, KeyVal, MediaTag, PipelineSteps, TestBadge, VerdictBadge, mediaLabel } from './parts';

export function EventDrawer({ w, id, onClose, onOpen }: { w: WatchCtx; id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const e = w.byId(id);
  if (!e) return null;
  const g = e.design;
  const j = e.judge;
  const result = e.test?.result;
  const showResult = !!result && j.verdict !== 'pending';
  const refs = w.archive.filter((r) => e.archiveRefs.includes(r.id));
  const related = w.events.filter((x) => e.related.includes(x.id));
  const alerts = linkedIncidents(e, w.state.incidents, w.state.data);
  const risks = e.closed || e.stage === 'wrapup' ? [] : executionRisks(e, w.state.data);
  return (
    <Drawer title="감지 이벤트 상세" onClose={onClose}>
      <div className="stack-sm">
        <div className="row" style={{ gap: 8 }}>
          <MediaTag media={e.media} />
          <Pill tone="outline">{KIND_LABEL[e.kind]}</Pill>
          <Pill tone={e.origin === 'signal' ? 'dark' : 'neutral'}>{e.origin === 'signal' ? '데이터 감지' : '매체 공지 (시연용 가상)'}</Pill>
          <Src kind="DEMO" />
        </div>
        <h3 style={{ fontSize: 'var(--fs-lg)' }}>{e.title}</h3>
        <p className="small ink2">{e.summary}</p>
        <div className="xs muted">감지 {fmtKst(kstMs(e.detectedAt))} · 감지 경로 {e.source}{e.signal ? ` · 감지 규칙 ${e.signal.basis} (${e.signal.page})` : ''}</div>
      </div>

      <Card tone="flat" title="파이프라인" actions={<Src kind="PROPOSAL" page="p.24" />}>
        <PipelineSteps stage={e.stage} closed={e.closed} size="lg" />
        <div className="row-between">
          <span className="small">현재 단계 <strong>{e.closed ? '관찰 종료' : STAGE_LABEL[e.stage]}</strong></span>
          <DueTag due={e.due} />
        </div>
        <ol className="watch-log">
          {e.progress.log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              <span className="xs muted num">{fmtLogAt(l.at, w.state.data.generatedAt)}</span>
              <span className="small"><strong>{l.action}</strong> · {l.by}{l.note ? <span className="muted"> — {l.note}</span> : null}</span>
            </li>
          ))}
        </ol>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {e.next.canClose ? <Button size="sm" variant="ghost" onClick={() => w.close(e)}>관찰 종료</Button> : null}
          {e.next.action ? <Button size="sm" variant="primary" disabled={!!e.next.disabled} onClick={() => w.advance(e, e.next.action!)}>{e.next.label}</Button> : null}
        </div>
        {e.next.disabled ? <div className="xs muted">{e.next.disabled}</div> : null}
      </Card>

      <Card tone="flat" title="24시간 내 영향 진단" sub="p.47 주의 · 위험 기준으로 매체 · 키워드 · 캠페인 · 계정 지표를 대조" actions={<><Src kind="PROPOSAL" page="p.47" /><Src kind="DEMO" /></>}>
        <VerdictBadge diag={e.diag} />
        <EvidenceTable evidence={e.diag.evidence} />
        <div className="grid g-2">
          <KeyVal k="영향 범위" v={e.diag.affected.scope} />
          <KeyVal k="일 평균 광고비 · 매출" v={<span className="num">{fmt.krw(e.diag.affected.spendPerDay)}원 · {fmt.krw(e.diag.affected.revenuePerDay)}원</span>} />
          <KeyVal k={`${mediaLabel(e.media)} 최근 7일 (${e.diag.week.rangeLabel})`} v={<span className="num">ROAS {fmt.roas(e.diag.week.roas)} ({fmtDelta(e.diag.week.roasDelta)}) · CPA {fmt.won(e.diag.week.cpa)}</span>} />
          <KeyVal k="영향 키워드 · 캠페인" v={<Chips items={[...e.keywords, ...e.campaigns]} max={6} />} />
        </div>
        <div className="stack-sm">
          <span className="xs muted">원인 후보 (근거 강도 순 · 확정 아님)</span>
          <CauseBars causes={e.diag.causes} />
        </div>
      </Card>

      {alerts.length ? (
        <Card tone="flat" title="MILDO Alert 연결 이슈" sub="같은 매체 · 대상의 열린 이슈. 진단 · 테스트 판단 전에 이슈 처리 상태를 확인합니다." actions={<Src kind="DEMO" />}>
          <div className="stack-sm">
            {alerts.map((i) => (
              <a key={i.id} href="#alert" className="watch-link-row watch-alert-row">
                <Sev level={i.severity} />
                <span className="small">{i.title}</span>
                <span className="xs muted">{INCIDENT_STATUS_LABEL[i.status] ?? i.status}{i.assignee ? ` · ${i.assignee}` : ''}</span>
              </a>
            ))}
          </div>
          {alerts.some((i) => i.ruleId === 'tracking_break' || i.ruleId === 'data_spike') ? <div className="xs muted">전환 추적 단절 · 데이터 급변 이슈가 열려 있는 동안 이 매체의 자동 조정과 테스트 등록은 보류 기준을 따릅니다 (p.45 · p.14).</div> : null}
        </Card>
      ) : null}

      <Card tone="flat" title="주간 리포트 실행안" actions={<Src kind="PROPOSAL" page="p.24 · p.17" />}>
        <p className="small">{e.plan}</p>
        <div className="xs muted">반영 시점 {w.report.label} · 매체 기준 실행안: {w.tracking.find((t) => t.media === e.media)?.plan}</div>
      </Card>

      {e.test ? (
        <Card tone="flat" title="소액 테스트 설계" sub="예산은 운영 가정(영향 캠페인 일 예산 × 비율) · 판정 기준은 p.28 테스트 카드 · 승인 주체는 p.15 위임 범위" actions={<><Src kind="PROPOSAL" page="p.28 · p.15" /><Src kind="DEMO" /></>}>
          <div className="grid g-2">
            <KeyVal k="가설" v={g.hypothesis} />
            <KeyVal k="비교" v={g.arms} />
            <KeyVal k="지표" v={g.metric} />
            <KeyVal k="기간 · 표본" v={`${g.days}일 또는 그룹별 최소 클릭 ${g.minClicks}`} />
            <KeyVal k="예산 (가정)" v={<span className="num">일 {fmt.krw(g.perDay)}원 × {g.days}일 = {fmt.krw(g.total)}원 · 기준 일 예산 {fmt.krw(g.baseBudget)}원의 {fmt.pct(g.sharePct, 0)}</span>} />
            <KeyVal k="승인 주체" v={<span>{g.approverLabel} <span className="xs muted">— {g.approverBasis}</span></span>} />
            <KeyVal k="중단 기준" v={g.stopRule} />
            <KeyVal k="확대 기준" v={g.expandRule} />
          </div>
          {risks.length ? (
            <Callout tone={risks.some((r) => r.level === 'danger') ? 'critical' : 'warning'} title={`집행 리스크 ${risks.length}건 · 테스트 예산이 집행되지 않거나 중간에 멈출 수 있습니다`}>
              <div className="stack-sm" style={{ gap: 2 }}>
                {risks.map((r, i) => <span key={`${r.label}-${i}`} className="xs">{evidenceLine(r)}</span>)}
                <span className="xs">계정 · 결제 이슈는 MILDO Alert에서 처리한 뒤 테스트를 집행합니다. 테스트 기간 중 중단되면 그 기간은 판정 표본에서 제외합니다.</span>
              </div>
            </Callout>
          ) : <div className="xs muted">집행 리스크 없음 — 연결 계정 잔액 1일치 이상 · 자동충전 정상 · 계정 active · 실명 권한 (p.44 · p.50 기준)</div>}
          {e.testChange ? (
            <div className="row small">
              <Pill tone="dark" icon="lab">Lab 등록 요청 {e.testChange.id}</Pill>
              <span>상태 {CHANGE_STATUS_LABEL[e.testChange.status] ?? e.testChange.status} · 승인 주체 {APPROVER_LABEL[e.testChange.approver] ?? e.testChange.approver}</span>
              <a href="#flow" className="xs">MILDO Flow에서 승인</a>
              <a href="#lab" className="xs">MILDO Lab</a>
            </div>
          ) : e.testRejected ? <div className="xs muted">Lab 등록 요청 {e.testRejected.id}이 MILDO Flow에서 {CHANGE_STATUS_LABEL[e.testRejected.status] ?? e.testRejected.status} 처리되어 실행안 단계로 돌아왔습니다. 실행안을 보완해 다시 등록할 수 있습니다.</div> : null}
        </Card>
      ) : null}

      {showResult && result ? (
        <Card tone="flat" title="랩업 판정" sub="두 비율 z-검정 · 7일차 중단 · 기간 종료 후 확대 판정" actions={<><Src kind="PROPOSAL" page="p.28" /><Src kind="DEMO" /></>}>
          <TestBadge judge={j} />
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>그룹</th><th className="r">클릭</th><th className="r">전환</th><th className="r">전환율</th></tr></thead>
              <tbody>
                <tr><td className="small">기존</td><td className="r num">{fmt.int(result.control.clicks)}</td><td className="r num">{fmt.dec1(result.control.conversions)}</td><td className="r num">{fmt.pct(j.cvrControl, 2)}</td></tr>
                <tr><td className="small">신규 (테스트)</td><td className="r num">{fmt.int(result.test.clicks)}</td><td className="r num">{fmt.dec1(result.test.conversions)}</td><td className="r num">{fmt.pct(j.cvrTest, 2)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="xs muted num">전환율 차이 {fmtDelta(j.lift)} · p-value {Number.isFinite(j.p) ? j.p.toFixed(3) : '—'} · 경과 {Math.min(j.daysElapsed, j.days)}/{j.days}일</div>
        </Card>
      ) : null}

      {e.scenario ? (
        <Card tone="flat" title="MILDO OS 작동 시나리오 연결" sub="가상 시나리오 · 실제 성과 데이터 아님" actions={<Src kind="PROPOSAL" page="p.23" />}>
          <ol className="watch-chain">
            {OS_SCENARIO.map((s, i) => (
              <li key={`${s.day}-${s.engine}`} className={i === 0 ? 'here' : ''}>
                <span className="xs muted">{s.day}</span>
                <a href={`#${s.route}`} className="small"><strong>{s.engine}</strong></a>
                <span className="xs ink2">{s.action}</span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {refs.length || related.length ? (
        <Card tone="flat" title="연결된 기록">
          {related.map((r) => (
            <button key={r.id} type="button" className="watch-link-row" onClick={() => onOpen(r.id)}>
              <span className="xs muted">같은 매체 7일 내</span>
              <span className="small">{r.title}</span>
              <span className="xs muted">{STAGE_LABEL[r.stage]}</span>
            </button>
          ))}
          {refs.map((r) => (
            <div key={r.id} className="watch-link-row">
              <span className="xs muted">아카이브 {fmtDate(r.date, false)}</span>
              <span className="stack-sm" style={{ gap: 1 }}>
                <span className="small">{r.competitor ?? '공통'} · {r.title}</span>
                <span className="xs muted">영향도 기준 · {r.impact.basis}</span>
              </span>
              <ImpactBadge level={r.impact.level} />
            </div>
          ))}
        </Card>
      ) : null}
    </Drawer>
  );
}
