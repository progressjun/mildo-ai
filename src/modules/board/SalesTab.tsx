/* 판매 채널 실매출 — 채널별 매출 · 주문 · CVR · 객단가 · 광고 경유 비중, 광고 매출 대조 (p.12 "광고비 대비 채널별 실매출") */
import { useMemo } from 'react';
import type { Dataset } from '@/core/types';
import { fmt, fmtDate, sum } from '@/core/util';
import { Card, DataTable, Pill, Src, Stat, Swatch, type Column } from '@/ui/primitives';
import { LineChart, ShareBar } from '@/ui/charts';
import { channelRows, channelTrend, reconciliation, type ChannelRow, type PeriodWindow } from './engine';
import { NumCell } from './parts';
import { BOARD_RULES, SALES_NOTE } from './data';

export function SalesTab({ d, win }: { d: Dataset; win: PeriodWindow }) {
  const rows = useMemo(() => channelRows(d, win), [d, win]);
  const rec = useMemo(() => reconciliation(d, win), [d, win]);
  const trend = useMemo(() => channelTrend(d, win), [d, win]);
  const tot = useMemo(() => {
    const revenue = sum(rows, (r) => r.revenue);
    const orders = sum(rows, (r) => r.orders);
    const visitors = sum(rows, (r) => r.visitors);
    const prev = sum(rows, (r) => r.prevRevenue);
    return { revenue, orders, visitors, cvr: visitors > 0 ? (orders / visitors) * 100 : NaN, aov: orders > 0 ? revenue / orders : NaN, ad: sum(rows, (r) => r.adAttributedRevenue), delta: prev !== 0 ? ((revenue - prev) / prev) * 100 : NaN };
  }, [rows]);

  const cols: Column<ChannelRow>[] = [
    { key: 'name', label: '판매 채널', sort: (r) => r.name, render: (r) => <Swatch colorVar={r.colorVar} label={<strong className="small">{r.name}</strong>} /> },
    { key: 'revenue', label: '실매출', align: 'right', sort: (r) => r.revenue, render: (r) => <NumCell value={<strong>{fmt.krw(r.revenue)}</strong>} delta={r.revenueDelta} sub={`비중 ${fmt.ratio(r.share, 0)}`} /> },
    { key: 'orders', label: '주문', align: 'right', sort: (r) => r.orders, render: (r) => <NumCell value={fmt.int(r.orders)} delta={r.ordersDelta} /> },
    { key: 'visitors', label: '방문', align: 'right', sort: (r) => r.visitors, render: (r) => <NumCell value={fmt.int(r.visitors)} sub={`상세 ${fmt.pct(r.detailRate, 0)} · 장바구니 ${fmt.pct(r.cartRate, 1)}`} /> },
    { key: 'cvr', label: 'CVR', align: 'right', sort: (r) => r.cvr, render: (r) => <NumCell value={fmt.pct(r.cvr, 2)} delta={r.cvrDelta} /> },
    { key: 'aov', label: '객단가', align: 'right', sort: (r) => r.aov, render: (r) => <NumCell value={fmt.won(r.aov)} /> },
    { key: 'ad', label: '광고 경유 (추정)', align: 'right', sort: (r) => r.adShare, render: (r) => <NumCell value={fmt.ratio(r.adShare, 0)} sub={fmt.krw(r.adAttributedRevenue)} /> },
  ];

  return (
    <div className="stack-lg">
      <Card title="광고비 대비 실매출" sub={`${win.label} ${win.rangeText} · 판매 채널 합산 기준 (광고 외 매출 포함)`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.12" /></>}>
        <div className="board-kpis">
          <div className="board-kpi"><Stat label="판매 채널 실매출" value={fmt.krw(rec.sales)} delta={tot.delta} foot={<span className="muted">주문 {fmt.int(tot.orders)}건</span>} /></div>
          <div className="board-kpi hl"><Stat label="MER (실매출 ÷ 광고비)" value={`${fmt.dec1(rec.mer)}배`} foot={<span className="muted">광고비 {fmt.krw(rec.adCost)}</span>} /></div>
          <div className="board-kpi"><Stat label="광고 경유 · 광고 외" value={fmt.ratio(1 - rec.organicShare, 0)} foot={<span className="muted">광고 외 {fmt.krw(rec.organicRevenue)} ({fmt.ratio(rec.organicShare, 0)})</span>} /></div>
          <div className="board-kpi">
            <Stat label="매체 집계 ↔ 채널 광고 경유" value={fmt.delta(rec.gapPct)} foot={<span className="muted">매체 {fmt.krw(rec.mediaRevenue)} · 채널 {fmt.krw(rec.channelAdRevenue)}</span>} />
            <div className="board-badge" style={{ marginTop: 4 }}>
              <Pill tone={rec.within ? 'good' : 'warning'} icon={rec.within ? 'check' : 'alert'}>{rec.within ? '대조 범위 내' : '기준 차이 확인'}</Pill>
              <span className="board-basis">허용 ±{BOARD_RULES.reconTolerancePct}% (모듈 가정)</span>
            </div>
          </div>
        </div>
        <div className="xs muted">매체 집계 광고 매출은 각 매체 귀속 기준, 광고 경유 매출은 판매 채널 유입 경로 기준 추정치입니다. 두 값의 차이는 중복 귀속 · 기여 기간 차이를 보여주며, 예산 판단은 합산 실매출(MER) 기준으로 합니다. {SALES_NOTE}</div>
      </Card>

      <Card title="채널별 실매출 · 주문 · CVR · 객단가" sub={`직전 ${win.prevText} 대비`} actions={<Src kind="DEMO" />}>
        <ShareBar parts={rows.map((r) => ({ label: r.name, value: r.revenue, colorVar: r.colorVar }))} />
        <DataTable rows={rows} columns={cols} rowKey={(r) => r.channel} initialSort={{ key: 'revenue', dir: 'desc' }}
          footer={
            <tr>
              <td>합계 · 4개 채널</td>
              <td className="r">{fmt.krw(tot.revenue)}</td>
              <td className="r">{fmt.int(tot.orders)}</td>
              <td className="r">{fmt.int(tot.visitors)}</td>
              <td className="r">{fmt.pct(tot.cvr, 2)}</td>
              <td className="r">{fmt.won(tot.aov)}</td>
              <td className="r">{fmt.ratio(tot.revenue > 0 ? tot.ad / tot.revenue : NaN, 0)}</td>
            </tr>
          } />
        <div className="xs muted">채널 간 잠식(같은 고객이 채널을 옮겨 구매)이 있을 수 있어 개별 채널 증감보다 합산 매출로 판단합니다(p.41). 퍼널 단계별 이탈 · 개선 액션은 매출 성장 모듈에서 봅니다.</div>
      </Card>

      <Card title="채널별 일자 추이" sub={`${fmtDate(trend.from, false)}–${fmtDate(trend.to, false)}${trend.extended ? ` · ${BOARD_RULES.trendMinDays}일로 확장` : ''}${trend.excludedToday ? ' · 오늘(부분일) 제외' : ''}`} actions={<><Src kind="DEMO" /><a className="btn sm" href="#growth">전환 개선 (매출 성장)</a></>}>
        <LineChart series={trend.series} height={230} yFormat={(v) => fmt.krw(v)} xFormat={(x) => fmtDate(x, false)} ariaLabel="판매 채널별 일 매출 추이" />
      </Card>
    </div>
  );
}
