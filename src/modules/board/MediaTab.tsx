/* 01 매체 통합 성과 — 6개 매체 동일 기준 비교 + 역할 · 판단 지표(p.37) + 일자별 추이 */
import { useMemo, useState } from 'react';
import type { Dataset, MediaId } from '@/core/types';
import { MEDIA } from '@/data/constants';
import { fmt, fmtDate, metrics, sum } from '@/core/util';
import { Card, DataTable, Delta, Pill, Segmented, Src, Swatch, Toggle, type Column } from '@/ui/primitives';
import { LineChart, ShareBar } from '@/ui/charts';
import { FLAG_SEVERITY, mediaComparison, mediaTrend, TREND_METRICS, type MediaRow, type PeriodWindow, type TrendMetric } from './engine';
import { FlagBadge, MediaChips, metricFormat, NeutralDelta, NumCell } from './parts';
import { BOARD_RULES } from './data';

export function MediaTab({ d, win }: { d: Dataset; win: PeriodWindow }) {
  const rows = useMemo(() => mediaComparison(d, win), [d, win]);
  const [metric, setMetric] = useState<TrendMetric>('cost');
  const [sel, setSel] = useState<MediaId[]>(['naver_sa', 'naver_gfa', 'google', 'meta']);
  const [total, setTotal] = useState(false);
  const trend = useMemo(() => mediaTrend(d, win, sel, metric, total), [d, win, sel, metric, total]);

  const tot = useMemo(() => {
    const cost = sum(rows, (r) => r.cost);
    const revenue = sum(rows, (r) => r.revenue);
    const conversions = sum(rows, (r) => r.conversions);
    const clicks = sum(rows, (r) => r.clicks);
    const newCustomers = sum(rows, (r) => r.newCustomers);
    const pcost = sum(rows, (r) => r.prev.cost);
    const prev = { roas: metrics.roas(sum(rows, (r) => r.prev.revenue), pcost) };
    return {
      cost, revenue, conversions, roas: metrics.roas(revenue, cost), cpa: metrics.cpa(cost, conversions), cvr: metrics.cvr(conversions, clicks),
      newShare: conversions > 0 ? newCustomers / conversions : NaN, costDelta: metrics.pctChange(cost, pcost), roasDelta: metrics.pctChange(metrics.roas(revenue, cost), prev.roas),
    };
  }, [rows]);

  const flagged = rows.filter((r) => r.flag.level === 'warn' || r.flag.level === 'danger');

  const columns: Column<MediaRow>[] = [
    {
      key: 'media', label: '매체 · 역할(p.37)', sort: (r) => r.name,
      render: (r) => (
        <div className="board-cell l">
          <Swatch colorVar={r.colorVar} label={<strong>{r.name}</strong>} />
          <span className="row" style={{ gap: 4 }}><Pill tone="outline">{r.role}</Pill></span>
        </div>
      ),
    },
    { key: 'cost', label: '광고비', align: 'right', sort: (r) => r.cost, render: (r) => <NumCell value={fmt.krw(r.cost)} delta={r.deltas.cost} neutral /> },
    {
      key: 'share', label: '비중 · 가안', align: 'right', sort: (r) => r.share,
      render: (r) => <NumCell value={fmt.ratio(r.share, 1)} sub={<>가안 {fmt.ratio(r.planShare, 0)} · {r.planGapPp >= 0 ? '+' : ''}{r.planGapPp.toFixed(1)}pp</>} />,
    },
    { key: 'revenue', label: '광고 매출', align: 'right', sort: (r) => r.revenue, render: (r) => <NumCell value={fmt.krw(r.revenue)} delta={r.deltas.revenue} /> },
    { key: 'roas', label: 'ROAS', align: 'right', sort: (r) => r.roas, render: (r) => <NumCell value={<strong>{fmt.roas(r.roas)}</strong>} delta={r.deltas.roas} /> },
    { key: 'cpa', label: 'CPA', align: 'right', sort: (r) => r.cpa, render: (r) => <NumCell value={fmt.won(r.cpa)} delta={r.deltas.cpa} invert /> },
    { key: 'cvr', label: 'CVR', align: 'right', sort: (r) => r.cvr, render: (r) => <NumCell value={fmt.pct(r.cvr, 2)} /> },
    { key: 'newShare', label: '신규 비중', align: 'right', sort: (r) => r.newShare, render: (r) => <NumCell value={fmt.ratio(r.newShare, 0)} sub={<span className="nowrap">CAC {fmt.krw(r.cac)}</span>} /> },
    {
      key: 'judge', label: '판단 지표(p.37)',
      render: (r) => (
        <div className="board-cell l" title={r.judge.note}>
          <span className="xs muted">{r.judge.metric}</span>
          <span className="small num"><strong>{r.judge.value}</strong></span>
        </div>
      ),
    },
    { key: 'flag', label: `직전 대비 변동`, sort: (r) => FLAG_SEVERITY[r.flag.level], render: (r) => <FlagBadge flag={r.flag} /> },
  ];

  const footer = (
    <tr>
      <td>합계 · 6개 매체</td>
      <td className="r"><NumCell value={fmt.krw(tot.cost)} delta={tot.costDelta} neutral /></td>
      <td className="r">100%</td>
      <td className="r">{fmt.krw(tot.revenue)}</td>
      <td className="r"><NumCell value={fmt.roas(tot.roas)} delta={tot.roasDelta} /></td>
      <td className="r">{fmt.won(tot.cpa)}</td>
      <td className="r">{fmt.pct(tot.cvr, 2)}</td>
      <td className="r">{fmt.ratio(tot.newShare, 0)}</td>
      <td colSpan={2} className="xs">{flagged.length ? `변동 기준 초과 ${flagged.length}개 매체` : '전 매체 변동 기준 이내'}</td>
    </tr>
  );

  const fmtY = metricFormat(metric);

  return (
    <div className="stack-lg">
      <Card
        title="매체 통합 성과 · 동일 기준 비교"
        sub={`${win.label} ${win.rangeText} · 직전 ${win.prevText} 대비 · 변동 판정은 p.47 이상 징후 기준(ROAS −${BOARD_RULES.roasDropWarnPct}/−${BOARD_RULES.roasDropDangerPct}% · CPA +${BOARD_RULES.cpaRiseWarnPct}/+${BOARD_RULES.cpaRiseDangerPct}% · 광고비 ±${BOARD_RULES.costSwingWarnPct}/±${BOARD_RULES.costSwingDangerPct}%)을 기간 비교에 준용`}
        actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.13 · p.37 · p.47" /></>}
      >
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.media} initialSort={{ key: 'cost', dir: 'desc' }} footer={footer} />
        <div className="xs muted">
          광고 매출은 각 매체가 보고한 귀속 매출이라 매체 간 중복이 포함될 수 있습니다. 판매 채널 실매출 기준 판단은 MER과 판매 채널 탭에서 봅니다. 비중 가안은 연 50억 배분안(p.37)입니다.
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="집행 비중 · 매출 비중 · 배분 가안" sub="같은 매체는 같은 색 (순위와 무관)" actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.37" /></>}>
          <div className="stack">
            <div className="stack-sm"><span className="xs muted">광고비 비중 · {win.label}</span><ShareBar parts={rows.map((r) => ({ label: r.short, value: r.cost, colorVar: r.colorVar }))} /></div>
            <div className="stack-sm"><span className="xs muted">광고 매출 비중 · {win.label}</span><ShareBar parts={rows.map((r) => ({ label: r.short, value: r.revenue, colorVar: r.colorVar }))} /></div>
            <div className="stack-sm"><span className="xs muted">연 배분 가안 (p.37)</span><ShareBar parts={rows.map((r) => ({ label: r.short, value: r.planShare, colorVar: r.colorVar }))} format={(v) => `${Math.round(v * 100)}%`} /></div>
          </div>
        </Card>
        <Card title="매체별 판단 지표 해석 기준" sub={`제안서 p.37 매체별 역할 · 판단 지표 · 값은 ${win.label}`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.37" /></>}>
          <div className="board-list">
            {rows.map((r) => (
              <div key={r.media} className="board-list-item board-judge">
                <Swatch colorVar={r.colorVar} label={<strong className="small">{r.short}</strong>} />
                <div className="stack-sm" style={{ gap: 1 }}>
                  <span className="small">{r.role} · {MEDIA[r.media].setting}</span>
                  <span className="board-sub">{r.judge.metric} — {r.judge.note}</span>
                </div>
                <span className="small num nowrap"><strong>{r.judge.value}</strong></span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="일자별 추이"
        sub={`${fmtDate(trend.from, false)}–${fmtDate(trend.to, false)}${trend.extended ? ` · 선택 기간이 짧아 ${BOARD_RULES.trendMinDays}일로 확장` : ''}${trend.excludedToday ? ' · 오늘(부분일) 제외' : ''}`}
        actions={<Src kind="DEMO" />}
      >
        <div className="row-between">
          <Segmented options={TREND_METRICS} value={metric} onChange={setMetric} label="지표" />
          <div className="row">
            <MediaChips selected={sel} onChange={setSel} />
            <Toggle id="board-trend-total" checked={total} onChange={setTotal} label="선택 매체 합계" />
          </div>
        </div>
        <LineChart series={trend.series} height={240} yFormat={fmtY} xFormat={(x) => fmtDate(x, false)} ariaLabel={`매체별 ${TREND_METRICS.find((m) => m.id === metric)?.label} 일자별 추이`} />
        {trend.series.length ? (
          <div className="row xs muted" style={{ gap: 14 }}>
            {trend.series.map((s) => {
              const pts = s.points.filter((p) => Number.isFinite(p.y));
              const first = pts[0]?.y ?? NaN;
              const last = pts.at(-1)?.y ?? NaN;
              const ch = metrics.pctChange(last, first);
              return <span key={s.id} className="num">{s.label} 시작 {fmtY(first)} → 마지막 {fmtY(last)} ({metric === 'cost' || metric === 'conversions' ? <NeutralDelta pct={ch} digits={0} /> : <Delta pct={ch} invert={metric === 'cpa'} digits={0} />})</span>;
            })}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
