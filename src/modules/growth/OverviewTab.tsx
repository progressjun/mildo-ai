/* 성장 공식(p.30) · 성장 과제(데이터 판정) · 매체 역할 · 배분 가안(p.37) */
import { Fragment, useMemo, type ReactNode } from 'react';
import type { Dataset } from '@/core/types';
import { MEDIA, MEDIA_IDS } from '@/data/constants';
import { fmt } from '@/core/util';
import { Button, Card, Empty, Src } from '@/ui/primitives';
import { AiInsight } from '@/ui/AiInsight';
import { PROPOSAL_SHARES, growthFormula, growthPrompt, type AllocationModel, type GrowthSignal } from './engine';
import { overviewBrief } from './briefs';
import { REBALANCE_RULES } from './data';
import { BIND_LABEL, MediaLabel, SIGNAL_TONE, Verdict, type TabId } from './parts';

export function OverviewTab({ d, model, signals, onGo }: { d: Dataset; model: AllocationModel; signals: GrowthSignal[]; onGo: (t: TabId) => void }) {
  const formula = useMemo(() => growthFormula(d, model), [d, model]);
  // 관측 ROAS 합계 = 최근 90일 매체 합계 (곡선 모델 값이 아님)
  const valid = model.curves.filter((c) => c.valid);
  const observedRoas = valid.length ? (valid.reduce((a, c) => a + c.avgDailyRevenue, 0) / valid.reduce((a, c) => a + c.avgDailyCost, 0)) * 100 : NaN;
  const srcFor: Record<string, ReactNode> = {
    time: <Src kind="PROPOSAL" page="p.19 · p.31" />,
    power: <Src kind="PROPOSAL" page="p.32–33" />,
    demand: <Src kind="PROPOSAL" page="p.38–39" />,
    basics: <Src kind="DEMO" />,
  };
  return (
    <div className="stack-lg">
      <Card tone="dark" title={<>성장 공식 <Src kind="PROPOSAL" page="p.30" /></>} sub="줄인 시간과 매체 파워를 매출로 바꿉니다 · 각 축을 누르면 해당 화면으로 이동">
        <div className="growth-formula">
          {formula.map((p) => (
            <button key={p.id} type="button" className="growth-pillar" onClick={() => onGo(p.tab as TabId)}>
              <span className="growth-pillar-title">{p.title}{srcFor[p.id]}</span>
              <span className="growth-pillar-detail">{p.detail}</span>
              <span className="growth-pillar-value">{p.value}</span>
              <span className="growth-pillar-foot">{p.foot}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card title={<>성장 과제 — 데이터 판정 <Src kind="DEMO" /></>} sub="엔진이 현재 데이터로 계산한 항목 · 각 항목 옆에 판정 기준과 근거 수치">
        {signals.length ? (
          <div className="growth-signals">
            {signals.map((s) => (
              <div key={s.id} className="growth-signal">
                <span className={`growth-stripe ${s.tone}`} />
                <Verdict tone={SIGNAL_TONE[s.tone].tone} label={SIGNAL_TONE[s.tone].label} />
                <div className="stack-sm" style={{ gap: 2 }}>
                  <span className="growth-signal-title">{s.title}</span>
                  <span className="growth-signal-basis">{s.basis}</span>
                </div>
                <Button size="sm" icon="chevron" onClick={() => onGo(s.tab as TabId)}>열기</Button>
              </div>
            ))}
          </div>
        ) : <Empty title="판정할 데이터가 없습니다">매체 · 판매 채널 데이터 연동 후 계산합니다.</Empty>}
      </Card>

      <Card
        title={<>매체별 역할 · 판단 지표 · 배분 가안 <Src kind="PROPOSAL" page="p.37" /><Src kind="DEMO" /></>}
        sub={`${REBALANCE_RULES.principle} · ${REBALANCE_RULES.note} · 관측 ROAS는 최근 90일, 한계 ROAS는 반응 곡선 가정(시나리오)`}
        actions={<Button size="sm" icon="trend" onClick={() => onGo('alloc')}>재배분 시뮬레이터</Button>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>매체</th><th>역할</th><th>핵심 세팅</th><th>판단 지표</th><th className="r">배분 가안</th>
                <th className="r">관측 ROAS</th><th className="r">한계 ROAS (가안)</th><th className="r">균등화안</th>
              </tr>
            </thead>
            <tbody>
              {MEDIA_IDS.map((m) => {
                const c = model.curves.find((x) => x.media === m);
                const b = model.baseline.rows.find((x) => x.media === m);
                const eq = model.equalize.shares[m];
                const why = model.equalize.binding[m];
                const diff = (eq - PROPOSAL_SHARES[m]) * 100;
                return (
                  <tr key={m}>
                    <td><MediaLabel m={m} /></td>
                    <td>{MEDIA[m].role}</td>
                    <td className="small">{MEDIA[m].setting}</td>
                    <td className="small">{MEDIA[m].judgeMetric}</td>
                    <td className="r">{fmt.ratio(MEDIA[m].share, 0)} · {fmt.krw(MEDIA[m].annualBudget)}</td>
                    <td className="r">{fmt.roas(c?.roas ?? NaN)}</td>
                    <td className="r"><strong>{fmt.roas(b?.marginalRoas ?? NaN)}</strong></td>
                    <td className="r">
                      <span className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
                        <span className="num">{fmt.ratio(eq)} <span className={diff > 0.05 ? 'delta-up' : diff < -0.05 ? 'delta-down' : 'delta-flat'}>({diff > 0 ? '+' : ''}{fmt.dec1(diff)}%p)</span></span>
                        {why ? <span className="xs muted">{BIND_LABEL[why].label}</span> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>합계 (연 {fmt.krw(model.budget)})</td>
                <td className="r">100%</td>
                <td className="r">{fmt.roas(observedRoas)}</td>
                <td className="r">격차 {fmt.int(model.baseline.spread.gapPct)}%</td>
                <td className="r">예상 매출 {fmt.delta(model.upliftOptimizedPct)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="xs muted">
          {model.curves.every((c) => c.bSource === 'prior')
            ? <>한계 ROAS는 매체별 사전 가정 b({model.curves.map((c, i) => <Fragment key={c.media}>{i ? ' · ' : ''}{MEDIA[c.media].short} {c.b}</Fragment>)})로 계산 — 최근 90일 데이터로는 체감 형태가 식별되지 않음. 균등화안 증분은 예측이 아닌 시나리오.</>
            : '일부 매체는 데이터 적합 b, 나머지는 사전 가정 b로 계산 — 균등화안 증분은 예측이 아닌 시나리오.'}
        </div>
      </Card>

      <AiInsight title="성장 과제 해석" sub="성장 공식 4축 기준 우선순위 · CAC 회수 구조" buildPrompt={() => growthPrompt('overview', d)} fallback={() => overviewBrief(d)} />
    </div>
  );
}
