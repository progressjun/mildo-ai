/* 예산 배분 · 한계 효율 재배분 시뮬레이터 (p.37) — 예측이 아닌 시나리오 */
import { useMemo, useState } from 'react';
import type { Dataset, MediaId } from '@/core/types';
import { AD_PILOT, MEDIA, MEDIA_IDS, RFP } from '@/data/constants';
import { clamp, fmt } from '@/core/util';
import { useActions, useStore } from '@/core/store';
import { Button, Callout, Card, DataTable, Pill, ProgressBar, Segmented, Src, Stat, Toggle, type Column, type Tone } from '@/ui/primitives';
import { LineChart } from '@/ui/charts';
import { AiInsight } from '@/ui/AiInsight';
import { ALLOCATION_GUARDRAILS, CURVE_PRIORS, PACE_RULES, REBALANCE_RULES } from './data';
import { resolveConfig } from '@/modules/adpilot/engine';
import {
  B_RANGE, CONSTRAINT_LABEL, PROPOSAL_SHARES, activeDuplicate, allocationModel, allocationSnapshot, budgetConstraints, exhaustText, f2, fitResponseCurves, growthPrompt, guardrailIssues,
  marginalCurvePoints, maxShareMove, pctInt, rebalanceShares, reallocationChange, type BudgetConstraint, type ConstraintVerdict, type Guardrails, type Shares,
} from './engine';
import { allocationBrief } from './briefs';
import { BIND_LABEL, MediaLabel, NumField as NumberInput, StackRows, Verdict } from './parts';

type BMode = 'prior' | 'data' | 'manual';
const CONSTRAINT_TONE: Record<ConstraintVerdict, Tone> = { raise: 'good', hold: 'serious', bid: 'warning' };
const HOLD_LABEL: Record<NonNullable<BudgetConstraint['holdKind']>, string> = { account: '계정 · 결제', spike: '광고비 급변', cpc: 'CPC 급등' };

export function AllocationTab({ d, initialCredit = false }: { d: Dataset; initialCredit?: boolean }) {
  const { state } = useStore();
  const { addChange, toast } = useActions();
  const [budget, setBudget] = useState<number>(RFP.annualBudget);
  const [shares, setShares] = useState<Shares>({ ...PROPOSAL_SHARES });
  const [credit, setCredit] = useState(initialCredit);
  const [bMode, setBMode] = useState<BMode>('prior');
  const [manualB, setManualB] = useState<Record<MediaId, number>>(() => Object.fromEntries(MEDIA_IDS.map((m) => [m, CURVE_PRIORS[m].b])) as Record<MediaId, number>);
  const [guard, setGuard] = useState<Guardrails>(ALLOCATION_GUARDRAILS);
  const [stepOn, setStepOn] = useState(true);
  const [stepCap, setStepCap] = useState<number>(REBALANCE_RULES.stepCapPct);

  const baseCurves = useMemo(() => fitResponseCurves(d), [d]);
  const bOverride = useMemo(() => {
    if (bMode === 'prior') return undefined;
    if (bMode === 'manual') return manualB;
    return Object.fromEntries(baseCurves.map((c) => [c.media, Number.isFinite(c.fit.b) ? clamp(c.fit.b, B_RANGE.min, B_RANGE.max) : c.priorB])) as Record<MediaId, number>;
  }, [bMode, manualB, baseCurves]);
  const input = useMemo(() => ({ budget, shares, bOverride, guard, stepCapPct: stepOn ? stepCap : null, daSaCredit: credit }), [budget, shares, bOverride, guard, stepOn, stepCap, credit]);
  const model = useMemo(() => allocationModel(d, input), [d, input]);
  const curvePts = useMemo(() => marginalCurvePoints(model.curves, model.budget), [model]);
  const constraints = useMemo(() => budgetConstraints(d, model), [d, model]);
  const guardWarn = guardrailIssues(guard);

  if (!model.baseline.valid) {
    return <Callout tone="warning" title="반응 곡선을 적합할 데이터가 없습니다">매체별 일별 광고비 · 매출 데이터(최근 90일)가 필요합니다. 배분 가안(p.37)을 유지합니다.</Callout>;
  }

  const scenarioChanged = maxShareMove(shares) > 0.05;
  const optimizedChanged = maxShareMove(model.equalize.shares) > 0.05;
  const payloads = { optimized: reallocationChange(model, 'optimized', state.role), scenario: reallocationChange(model, 'scenario', state.role) };
  const dup = { optimized: activeDuplicate(state.changes, payloads.optimized.targetId), scenario: activeDuplicate(state.changes, payloads.scenario.targetId) };
  const request = (which: 'optimized' | 'scenario') => {
    if (dup[which]) return;
    const c = addChange({ ...payloads[which] });
    toast({ tone: 'info', title: '재배분안 승인 요청을 만들었습니다', body: `${c.target} · 수면밀도 승인 대기 · MILDO Flow에서 확인`, route: 'flow' });
  };
  const exhaustBefore = resolveConfig().exhaustBeforeHour;
  const bLabel = (src: 'data' | 'prior' | 'manual', why: string) => (src === 'prior' ? `사전 가정 · ${why}` : bMode === 'data' ? `데이터 적합 (범위 ${B_RANGE.min}~${B_RANGE.max})` : src === 'data' ? '데이터 적합' : '직접 입력');
  const series = curvePts.map((s) => ({ id: s.media, label: MEDIA[s.media].short, colorVar: MEDIA[s.media].colorVar, points: s.points }));
  const constraintCols: Column<BudgetConstraint>[] = [
    { key: 'campaign', label: '캠페인', render: (r) => <span className="stack-sm" style={{ gap: 0 }}><strong>{r.campaign}</strong><span className="xs muted">{MEDIA[r.media].name} · {MEDIA[r.media].role}</span></span> },
    { key: 'budget', label: '일 예산', align: 'right', render: (r) => fmt.krw(r.dailyBudget) },
    {
      key: 'pace', label: '소진율 (시간대 기대)', sort: (r) => r.pacePct,
      render: (r) => (
        <span className="stack-sm" style={{ gap: 2, minWidth: 140 }}>
          <span className="num small">{fmt.pct(r.pacePct, 0)} <span className="muted">· 기대 {fmt.ratio(r.expectedShare, 0)}</span></span>
          <ProgressBar value={r.pacePct} max={100} marker={Number.isFinite(r.expectedShare) ? r.expectedShare * 100 : undefined} tone={r.paceIndex > 1 ? 'warning' : 'ink'} label={`${r.campaign} 소진율`} />
        </span>
      ),
    },
    { key: 'index', label: '소진 배수', align: 'right', sort: (r) => r.paceIndex, render: (r) => <span><strong className="num">{f2(r.paceIndex)}</strong><div className="xs muted">예상 부족 {fmt.krw(r.shortfall)}</div></span> },
    {
      key: 'exhaust', label: '예상 마감', align: 'right', sort: (r) => -(r.exhaustHour ?? 99),
      render: (r) => <span><strong className="num">{exhaustText(r.exhaustHour)}</strong><div className="xs muted">{r.exhaustMethod ?? '—'}{r.missesPeak ? ` · ${PACE_RULES.peakStartHour}~23시 피크 전` : ''}</div></span>,
    },
    {
      key: 'recent', label: `최근 ${PACE_RULES.recentHours}시간 광고비`, align: 'right', sort: (r) => r.recent.deltaPct,
      render: (r) => <span><strong className="num">{fmt.delta(r.recent.deltaPct, 0)}</strong><div className="xs muted">동요일 · 동시간 {r.recent.baselineDays}주 평균 대비</div></span>,
    },
    { key: 'eff', label: '캠페인 ROAS', align: 'right', sort: (r) => r.campaignRatioPct, render: (r) => <span><strong className="num">{fmt.roas(r.campaignRoas)}</strong><div className="xs muted">목표 {fmt.roas(r.campaignTarget)} 대비 {fmt.int(r.campaignRatioPct)}%</div></span> },
    { key: 'marg', label: '매체 한계 ROAS', align: 'right', render: (r) => <span><strong className="num">{fmt.roas(r.marginalRoas)}</strong><div className="xs muted">균등화 기준 {fmt.roas(r.threshold)}</div></span> },
    { key: 'verdict', label: '판정 · 기준', render: (r) => <span style={{ display: 'inline-block', maxWidth: 380 }}><Verdict tone={CONSTRAINT_TONE[r.verdict]} icon={r.verdict === 'hold' ? 'alert' : undefined} label={`${CONSTRAINT_LABEL[r.verdict]}${r.holdKind ? ` · ${HOLD_LABEL[r.holdKind]}` : ''}`} basis={r.basis} /></span> },
  ];

  return (
    <div className="stack-lg">
      <Card title={<>예산 배분 · 한계 효율 재배분 시뮬레이터 <Src kind="PROPOSAL" page="p.37" /><Src kind="DEMO" /></>}
        sub={`매체별 반응 곡선(매출 = a · 광고비^b)을 최근 90일 일별 데이터로 적합 → 한계 ROAS 계산 → 슬라이더로 배분 변경 · ${REBALANCE_RULES.principle}`}
        actions={
          <>
            <Button size="sm" icon="refresh" onClick={() => setShares({ ...PROPOSAL_SHARES })} disabled={!scenarioChanged}>가안으로</Button>
            <Button size="sm" icon="target" onClick={() => setShares({ ...model.equalize.shares })}>균등화안 적용</Button>
          </>
        }>
        <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 200 }}>
            <label htmlFor="growth-budget">연 예산 (원) <Src kind="RFP" /></label>
            <NumberInput id="growth-budget" value={budget} step={100_000_000} min={100_000_000} onChange={(v) => setBudget(Math.max(100_000_000, v))} suffix={fmt.krw(budget)} />
          </div>
          <div className="field">
            <span className="field-label">곡선 형태 b</span>
            <Segmented label="곡선 형태" value={bMode} onChange={setBMode} options={[{ id: 'prior', label: '사전 가정' }, { id: 'data', label: `데이터 적합 (상한 ${B_RANGE.max})` }, { id: 'manual', label: '직접 입력' }]} />
          </div>
          <div className="field">
            <span className="field-label">GFA 평가</span>
            <Toggle id="growth-credit" checked={credit} onChange={setCredit} label={<>DA→SA 기여 반영 <span className="xs muted">(METHOD 1 · 3 추정)</span></>} />
          </div>
          <div className="field">
            <span className="field-label">1회 재배분 폭 상한</span>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <Toggle id="growth-step" checked={stepOn} onChange={setStepOn} label={<span className="xs">적용</span>} />
              <NumberInput id="growth-stepcap" value={stepCap} step={5} min={5} max={100} suffix="± %" onChange={(v) => setStepCap(clamp(v, 5, 100))} style={{ width: 120 }} />
            </div>
          </div>
        </div>
        <div className="grid g-4">
          <Stat label={<>예상 연 매출 · 시나리오</>} src={<Src kind="DEMO" />} value={fmt.krw(model.scenario.totalRevenue)} delta={model.upliftScenarioPct}
            foot={<span className="xs muted">가안 {fmt.krw(model.baseline.totalRevenue)} 대비</span>} />
          <Stat label="전체 ROAS · 시나리오" value={fmt.roas(model.scenario.totalRoas)} foot={<span className="xs muted">가안 {fmt.roas(model.baseline.totalRoas)} · 균등화안 {fmt.roas(model.optimized.totalRoas)}</span>} />
          <Stat label="균등화안 예상 증분" value={fmt.krw(model.upliftOptimized)} delta={model.upliftOptimizedPct}
            foot={<span className="xs muted">b ±0.1: {fmt.delta(model.sensitivity.lowPct)} ~ {fmt.delta(model.sensitivity.highPct)} · 방향 {model.sensitivity.stable ? '유지' : `변동 (${model.sensitivity.flipped.map((m) => MEDIA[m].short).join(' · ')})`}</span>} />
          <Stat label="한계 ROAS 격차 · 시나리오" value={pctInt(model.scenario.spread.gapPct)}
            foot={<span className="xs muted">{model.scenario.spread.maxMedia ? MEDIA[model.scenario.spread.maxMedia].short : '—'} {fmt.roas(model.scenario.spread.max)} vs {model.scenario.spread.minMedia ? MEDIA[model.scenario.spread.minMedia].short : '—'} {fmt.roas(model.scenario.spread.min)} · 균등화 {fmt.roas(model.equalize.marginalRoas)}</span>} />
        </div>
        <Callout tone="info" title="예측이 아닌 시나리오">
          곡선 형태 b는 {bMode === 'data' ? `데이터 적합값(범위 ${B_RANGE.min}~${B_RANGE.max}로 제한 — 체감 미식별 매체는 상한 ${B_RANGE.max})` : bMode === 'manual' ? '직접 입력값' : model.curves.every((c) => c.bSource === 'prior') ? '6개 매체 모두 데이터로 식별되지 않아 사전 가정값' : '데이터 적합 · 사전 가정 혼합'}입니다. 최근 90일 효율 수준을 연간에 적용하며 시즌성 · 경쟁 입찰 변화는 반영하지 않습니다. 볼륨 한계(검색량 · 리마케팅 모수)를 넘는 배분은 매출이 늘지 않는 것으로 계산합니다.
          {model.credit.on ? ` DA→SA 기여 반영: GFA에 SA 경유 매출(ROAS ${fmt.roas(model.credit.haloRoas)})을 얹고 같은 금액을 SA에서 뺐습니다 — 홀드아웃 검증 전 추정치.` : ''}
        </Callout>
      </Card>

      <Card title={<>매체별 배분 · 예상 결과 <Src kind="DEMO" /></>} sub="슬라이더를 움직이면 나머지 매체가 기존 비율대로 조정되어 합계 100% 유지 · 가드레일 (초기값 · 협의 후 확정)">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>매체</th><th className="r">배분 가안</th><th style={{ minWidth: 220 }}>시나리오 비중</th><th className="r">시나리오 금액</th>
                <th className="r">예상 매출</th><th className="r">ROAS</th><th className="r">한계 ROAS</th><th>가드레일 · 볼륨</th><th className="r">균등화안</th>
              </tr>
            </thead>
            <tbody>
              {MEDIA_IDS.map((m) => {
                const s = model.scenario.rows.find((r) => r.media === m)!;
                const b = model.baseline.rows.find((r) => r.media === m)!;
                const g = guard[m];
                const why = model.equalize.binding[m];
                return (
                  <tr key={m}>
                    <td><MediaLabel m={m} sub /></td>
                    <td className="r"><span className="nowrap">{fmt.ratio(PROPOSAL_SHARES[m], 0)} · {fmt.krw(model.budget * PROPOSAL_SHARES[m])}</span></td>
                    <td>
                      <div className="growth-slider-cell">
                        <input className="growth-range" type="range" min={0} max={0.6} step={0.005} value={shares[m]} aria-label={`${MEDIA[m].name} 비중`}
                          onChange={(e) => setShares(rebalanceShares(shares, m, Number(e.target.value)))} />
                        <span className="num small r">{fmt.ratio(shares[m])}</span>
                      </div>
                    </td>
                    <td className="r">{fmt.krw(s.annualSpend)}</td>
                    <td className="r">{fmt.krw(s.annualRevenue)}</td>
                    <td className="r">{fmt.roas(s.roas)}</td>
                    <td className="r"><strong>{fmt.roas(s.marginalRoas)}</strong><div className="xs muted">가안 {fmt.roas(b.marginalRoas)}</div></td>
                    <td>
                      <span className="stack-sm" style={{ gap: 2 }}>
                        {s.guardFlag
                          ? <Verdict tone="warning" icon="alert" label={s.guardFlag === 'above' ? '상한 초과' : '하한 미달'} basis={`${fmt.ratio(g.min, 0)}~${fmt.ratio(g.max, 0)}`} />
                          : <span className="xs muted">범위 {fmt.ratio(g.min, 0)}~{fmt.ratio(g.max, 0)}</span>}
                        {s.capped ? <Verdict tone="serious" icon="alert" label="볼륨 한계 초과" basis={`초과 ${fmt.krw(s.overCapAnnual)} 매출 미증가`} /> : null}
                      </span>
                    </td>
                    <td className="r">
                      <span className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
                        <span className="num">{fmt.ratio(model.equalize.shares[m])}</span>
                        {why ? <Pill tone={BIND_LABEL[why].tone}>{BIND_LABEL[why].label}</Pill> : <span className="xs muted">한계 ROAS {fmt.roas(model.equalize.marginalRoas)}</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>합계</td><td className="r">100% · {fmt.krw(model.budget)}</td><td className="r">{fmt.ratio(MEDIA_IDS.reduce((a, m) => a + shares[m], 0))}</td>
                <td className="r">{fmt.krw(model.budget)}</td><td className="r">{fmt.krw(model.scenario.totalRevenue)}</td><td className="r">{fmt.roas(model.scenario.totalRoas)}</td>
                <td className="r">격차 {pctInt(model.scenario.spread.gapPct)}</td><td>{model.scenario.guardViolations.length ? `가드레일 위반 ${model.scenario.guardViolations.length}` : '위반 없음'}</td>
                <td className="r">{fmt.krw(model.optimized.totalRevenue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {guardWarn.length ? <Callout tone="warning" title="가드레일 입력 확인">{guardWarn.join(' · ')} — 최소가 최대보다 크면 최대를 적용하고, 합계로 100%를 맞출 수 없으면 균등화안은 가드레일을 해제해 계산합니다. 아래 '반응 곡선 가정 · 식별' 표에서 최소 · 최대를 고치세요.</Callout> : null}
        <div className="row-between">
          <span className="xs muted">균등화안: {model.equalize.note}</span>
          <div className="row">
            {dup.optimized || dup.scenario ? <span className="xs muted">같은 배분안 승인 흐름 진행 중 · <a href="#flow">MILDO Flow에서 보기</a></span> : null}
            <Button size="sm" onClick={() => request('scenario')} disabled={!scenarioChanged || !!dup.scenario} title={!scenarioChanged ? '가안과 같은 배분입니다' : dup.scenario ? '같은 배분안이 이미 승인 흐름에 있습니다' : undefined}>시나리오 승인 요청</Button>
            <Button size="sm" variant="primary" icon="send" onClick={() => request('optimized')} disabled={!model.equalize.feasible || !optimizedChanged || !!dup.optimized}
              title={!model.equalize.feasible ? '볼륨 한계 안에서 예산을 모두 배분할 수 없습니다' : !optimizedChanged ? '균등화안이 가안과 같습니다' : dup.optimized ? '같은 균등화안이 이미 승인 흐름에 있습니다' : undefined}>균등화안 승인 요청 · 수면밀도</Button>
          </div>
        </div>
      </Card>

      <Card title={<>예산 제약 신호 · 오늘 일 예산 조기 소진 예상 <Src kind="DEMO" /></>}
        sub={`기준일 ${d.today} ${d.currentHour}시 · 대상: 예상 마감 ${exhaustBefore}시 전 (최근 28일 매체 시간대 소진 곡선 + 선형 외삽 — MILDO Board · AD Pilot과 같은 계산) · 판정 순서: 계정 잔액 ${PACE_RULES.runwayMinDays}일치 미만 · 자동충전 실패(p.44), 최근 ${PACE_RULES.recentHours}시간 광고비 급변(동요일 · 동시간 ±30%, p.47), 캠페인 키워드 CPC +${AD_PILOT.anomalyHoldPct}% 이상 → 증액 보류 · 매체 한계 ROAS ≥ 균등화 기준이고 캠페인 ROAS ≥ 목표 → 증액 후보 · 그 외 입찰 조정 우선`}
        actions={<><a className="btn sm" href="#adpilot">AD Pilot 예산 조정</a><a className="btn sm" href="#alert">MILDO Alert</a></>}>
        <DataTable rows={constraints} columns={constraintCols} rowKey={(r) => r.id} empty={`조기 소진 예상 캠페인 없음 (예상 마감 ${exhaustBefore}시 이후)`} />
        <div className="xs muted">
          당일 증액은 이 화면에서 하지 않습니다 — 일 예산 변경은 AD Pilot · GFA Control 위임 범위(±10% AE · ±10~30% PM · 30% 초과 수면밀도)로 승인 라우팅되고, 여기서는 월 재배분의 입력(예산 제약 = 볼륨이 남아 있는 매체)으로만 씁니다. 광고비 급변 · 키워드 CPC 급등을 동반한 소진 가속은 수요가 아닌 집계 · 경쟁 입찰 변화일 수 있고, 계정 잔액이 1일치 미만이면 증액이 잔액 소진을 앞당기므로 모두 증액 근거에서 뺍니다.
        </div>
      </Card>

      <div className="grid g-2">
        <Card title={<>한계 ROAS 곡선 <Src kind="DEMO" /></>} sub="가안 배분 대비 배수(50~200%)별 한계 ROAS · 점선 = 균등화 한계 ROAS · 0은 볼륨 한계 초과">
          <LineChart series={series} height={240} yFormat={(v) => `${Math.round(v)}%`}
            refLine={Number.isFinite(model.equalize.marginalRoas) ? { y: model.equalize.marginalRoas, label: `균등화 ${fmt.roas(model.equalize.marginalRoas)}` } : undefined} ariaLabel="매체별 한계 ROAS 곡선" />
        </Card>
        <Card title={<>배분 비교 <Src kind="PROPOSAL" page="p.37" /><Src kind="DEMO" /></>} sub="가안(p.37) · 시나리오 · 균등화안 (매체 색 고정)">
          <StackRows rows={[{ label: '가안', shares: PROPOSAL_SHARES }, { label: '시나리오', shares: model.scenarioShares }, { label: '균등화안', shares: model.equalize.shares }]} />
          <div className="xs muted">균등화 원리: 한 매체의 한계 ROAS가 다른 매체보다 높으면 예산을 옮길수록 전체 매출이 늘어나므로, 제약(가드레일 · 재배분 폭 · 볼륨 한계)에 걸리지 않은 매체의 한계 ROAS가 같아질 때까지 옮깁니다.</div>
        </Card>
      </div>

      <Card title={<>반응 곡선 가정 · 식별 <Src kind="DEMO" /></>} sub="로그-로그 회귀 ln(매출) = ln(a) + b · ln(광고비), 최근 90일 · 체감(b<1)은 95% 상한이 1 미만일 때만 데이터로 확정 · a는 현재 운영점을 지나도록 보정">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>매체</th><th className="r">관측 ROAS</th><th className="r">일 광고비 변동</th><th className="r">적합 b (95% 구간)</th><th className="r">R²</th><th>식별</th>
                <th className="r">적용 b</th><th>볼륨 한계</th><th className="r">가드레일 최소</th><th className="r">최대</th>
              </tr>
            </thead>
            <tbody>
              {model.curves.map((c) => (
                <tr key={c.media}>
                  <td><MediaLabel m={c.media} /></td>
                  <td className="r">{fmt.roas(c.roas)}</td>
                  <td className="r">±{fmt.ratio(c.costCv, 0)}</td>
                  <td className="r">{Number.isFinite(c.fit.b) ? `${c.fit.b.toFixed(2)} (${c.fit.ciLow.toFixed(2)}~${c.fit.ciHigh.toFixed(2)})` : '—'}</td>
                  <td className="r">{Number.isFinite(c.fit.r2) ? c.fit.r2.toFixed(2) : '—'}</td>
                  <td><Verdict tone={c.identified ? 'good' : 'warning'} label={c.identified ? '체감 확인' : '미식별'} basis={c.identified ? '95% 상한 < 1' : '95% 상한 ≥ 1'} /></td>
                  <td className="r">
                    {bMode === 'manual'
                      ? <NumberInput id={`growth-b-${c.media}`} value={manualB[c.media]} step={0.05} min={0.05} max={0.98} onChange={(v) => setManualB({ ...manualB, [c.media]: clamp(v, 0.05, 0.98) })} style={{ justifyContent: 'flex-end' }} />
                      : <span className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}><strong className="num">{c.b.toFixed(2)}</strong><span className="xs muted">{bLabel(c.bSource, c.priorWhy)}</span></span>}
                  </td>
                  <td className="small">{fmt.dec1(c.capMult)}배<div className="xs muted">{c.capBasis}</div>{c.creditNote ? <div className="xs muted">{c.creditNote}</div> : null}</td>
                  <td className="r"><div className="growth-mini-input" style={{ marginLeft: 'auto' }}><NumberInput id={`growth-gmin-${c.media}`} value={Math.round(guard[c.media].min * 100)} step={1} min={0} max={100} suffix="%" onChange={(v) => setGuard({ ...guard, [c.media]: { ...guard[c.media], min: clamp(v, 0, 100) / 100 } })} /></div></td>
                  <td className="r"><div className="growth-mini-input" style={{ marginLeft: 'auto' }}><NumberInput id={`growth-gmax-${c.media}`} value={Math.round(guard[c.media].max * 100)} step={1} min={0} max={100} suffix="%" onChange={(v) => setGuard({ ...guard, [c.media]: { ...guard[c.media], max: clamp(v, 0, 100) / 100 } })} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {guardWarn.length ? <Callout tone="warning" title="가드레일 입력 확인">{guardWarn.join(' · ')}</Callout> : null}
        <div className="xs muted">
          일 광고비가 평균 대비 ±{fmt.ratio(Math.min(...model.curves.map((c) => c.costCv).filter(Number.isFinite)), 0)}~{fmt.ratio(Math.max(...model.curves.map((c) => c.costCv).filter(Number.isFinite)), 0)} 범위에서만 움직여, 그 밖의 배분은 외삽입니다. 사전 가정 b는 온보딩 중 증액 테스트(±20%) · 홀드아웃으로 교체합니다. 데이터 적합 b를 쓰면 체감이 거의 없는 직선이 되어 평균 ROAS가 높은 매체로 가드레일 상한까지 몰립니다 — 반례 시나리오로만 봅니다.
        </div>
      </Card>

      <AiInsight title="재배분 해석" sub="한계 ROAS · 곡선 가정 · DA→SA 기여 반영 여부별 대체 시나리오" buildPrompt={() => growthPrompt('alloc', d, allocationSnapshot(model))} fallback={() => allocationBrief(d, input)} />
    </div>
  );
}
