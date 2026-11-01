/**
 * 매출 성장 고도화 — 제안서 p.30–42
 * 성장 공식 · 성장 과제 → 타겟 · SA 캠페인 → 예산 재배분(한계 효율) → DA→SA 기여 → 전환 개선 → 신규 매체 · 코프로모션 → 매체 협력 · 캘린더
 * 성과 수치는 모두 state.data(시연용 테스트 데이터)에서 엔진으로 계산한다. AI는 버튼 클릭 시에만 호출한다.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useStore } from '@/core/store';
import { mediaRows, rangeOf, totalsOf } from '@/core/selectors';
import { MEDIA } from '@/data/constants';
import { fmt } from '@/core/util';
import { Card, PageHeader, Pill, Src, Stat, Tabs } from '@/ui/primitives';
import { allocationModel, budgetConstraints, daSaAnalysis, deltaPct, f2, funnelDiagnosis, growthSignals, saCampaignPerformance } from './engine';
import { FUNNEL_RULES } from './data';
import { OverviewTab } from './OverviewTab';
import { TargetTab } from './TargetTab';
import { AllocationTab } from './AllocationTab';
import { DaSaTab } from './DaSaTab';
import { FunnelTab } from './FunnelTab';
import { DemandTab } from './DemandTab';
import { PartnerTab } from './PartnerTab';
import type { TabId } from './parts';
import './styles.css';

function Badge({ n, tone = 'warning' }: { n: number; tone?: 'warning' | 'serious' | 'good' }) {
  return n > 0 ? <Pill tone={tone}>{n}</Pill> : null;
}

export default function View({ initialTab = 'overview' }: { initialTab?: TabId } = {}) {
  const { state } = useStore();
  const d = state.data;
  const [tab, setTab] = useState<TabId>(initialTab);
  const [creditPref, setCreditPref] = useState(false);

  const model = useMemo(() => allocationModel(d), [d]);
  const ds = useMemo(() => daSaAnalysis(d), [d]);
  const funnel = useMemo(() => funnelDiagnosis(d), [d]);
  const signals = useMemo(() => growthSignals(d, model), [d, model]);
  const camps = useMemo(() => saCampaignPerformance(d), [d]);
  const constraints = useMemo(() => budgetConstraints(d, model), [d, model]);
  const r30 = rangeOf(d, 'last30');
  const t30 = useMemo(() => totalsOf(mediaRows(d, r30.from, r30.to)), [d, r30.from, r30.to]);

  const go = (t: TabId) => setTab(t);
  const sp = model.baseline.spread;
  const pri = funnel.priority ?? funnel.stages.find((s) => s.stage === 'cart') ?? null;
  const priOm = !pri || pri.focus !== 'brandstore';
  const priGap = pri ? (priOm ? pri.gapPct : deltaPct(pri.bs.cur, pri.om.cur)) : NaN;
  const tabs: { id: TabId; label: ReactNode; badge?: ReactNode }[] = [
    { id: 'overview', label: '성장 공식 · 과제', badge: <Badge n={signals.filter((s) => s.tone === 'serious').length} tone="serious" /> },
    { id: 'target', label: '타겟 · SA 캠페인', badge: <Badge n={camps.filter((c) => c.verdict === 'expand' || c.expandKeywords.length > 0).length} tone="good" /> },
    { id: 'alloc', label: '예산 재배분 · 한계 효율', badge: <Badge n={constraints.filter((c) => c.verdict === 'hold').length} tone="serious" /> },
    { id: 'dasa', label: 'DA → SA 기여' },
    { id: 'funnel', label: '전환 개선 · 자사몰', badge: <Badge n={funnel.stages.filter((s) => s.focus).length + funnel.landing.soldout.length} /> },
    { id: 'demand', label: '신규 매체 · 코프로모션' },
    { id: 'partner', label: '줄인 시간 · 매체 협력 · 캘린더' },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="04 REVENUE GROWTH"
        title="매출 성장 고도화"
        sub="줄인 시간과 매체 파워를 매출로 바꿉니다. 한계 효율 재배분 · DA→SA 기여 · 전환 개선 · 새 수요를 같은 데이터와 같은 판정 기준으로 봅니다."
        sources={<><Src kind="PROPOSAL" page="p.30–42" /><Src kind="RFP" /><Src kind="DEMO" /><span className="xs muted">기준일 {d.today} {d.currentHour}시 · 재배분 · 개선 효과는 예측이 아닌 시나리오</span></>}
      />

      <Card>
        <div className="grid g-5">
          <Stat label="광고비 · 최근 30일" src={<Src kind="DEMO" />} value={fmt.krw(t30.cost)} foot={<span className="xs muted">광고 매출 ROAS {fmt.roas(t30.roas)} · CPA {fmt.won(t30.cpa)}</span>} />
          <Stat label="한계 ROAS 격차 · 가안" src={<Src kind="DEMO" />} value={Number.isFinite(sp.gapPct) ? `${fmt.int(sp.gapPct)}%` : '—'}
            foot={<span className="xs muted">{sp.maxMedia ? MEDIA[sp.maxMedia].short : '—'} {fmt.roas(sp.max)} vs {sp.minMedia ? MEDIA[sp.minMedia].short : '—'} {fmt.roas(sp.min)} (p.37 가안 기준)</span>} />
          <Stat label="균등화 재배분 · 예상 매출" src={<Src kind="DEMO" />} value={fmt.delta(model.upliftOptimizedPct)}
            foot={<span className="xs muted">{fmt.krw(model.upliftOptimized)} · b ±0.1 {fmt.delta(model.sensitivity.lowPct)}~{fmt.delta(model.sensitivity.highPct)} · 시나리오</span>} />
          <Stat label="DA → 브랜드 검색 시차" src={<Src kind="DEMO" />} value={ds.bestLag !== null ? `${ds.bestLag}일` : '미확인'}
            foot={<span className="xs muted">보정 r {f2(ds.bestR)} · 기준 {f2(ds.threshold)} · DA 경유 {fmt.ratio(ds.daShareBrand, 0)}</span>} />
          <Stat label={`${funnel.priority ? '우선 개선 · ' : ''}${priOm ? '자사몰' : '브랜드스토어'} ${pri?.metricLabel ?? '장바구니 → 구매'}`} src={<Src kind="DEMO" />}
            value={fmt.pct(pri ? (priOm ? pri.om.cur : pri.bs.cur) : NaN)}
            foot={<span className="xs muted">{priOm ? '브랜드스토어' : '자사몰'} {fmt.pct(pri ? (priOm ? pri.bs.cur : pri.om.cur) : NaN)} 대비 {fmt.delta(priGap)} (기준 {FUNNEL_RULES.gapPct}%)</span>} />
        </div>
      </Card>

      <Tabs id="growth-tabs" tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' ? <OverviewTab d={d} model={model} signals={signals} onGo={go} /> : null}
      {tab === 'target' ? <TargetTab d={d} /> : null}
      {tab === 'alloc' ? <AllocationTab key={creditPref ? 'credit' : 'plain'} d={d} initialCredit={creditPref} /> : null}
      {tab === 'dasa' ? <DaSaTab d={d} ds={ds} onApplyCredit={() => { setCreditPref(true); setTab('alloc'); }} /> : null}
      {tab === 'funnel' ? <FunnelTab d={d} f={funnel} /> : null}
      {tab === 'demand' ? <DemandTab d={d} marginalRoas={model.equalize.marginalRoas} /> : null}
      {tab === 'partner' ? <PartnerTab d={d} /> : null}
    </div>
  );
}
