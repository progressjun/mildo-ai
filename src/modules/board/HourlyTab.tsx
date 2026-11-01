/* 시간대 × 요일 히트맵 (최근 4주, 광고비 · 전환 · ROAS) + 시간대별 전환 효율 지수 */
import { useMemo, useState } from 'react';
import type { Dataset, MediaId } from '@/core/types';
import { MEDIA, MEDIA_IDS } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { Card, Field, Pill, Segmented, Src } from '@/ui/primitives';
import { BarChart, Heatmap } from '@/ui/charts';
import { hourWeekHeatmap, type HeatMetric } from './engine';

const METRICS: { id: HeatMetric; label: string }[] = [
  { id: 'cost', label: '광고비' },
  { id: 'conversions', label: '전환' },
  { id: 'roas', label: 'ROAS' },
];

export function HourlyTab({ d }: { d: Dataset }) {
  const [metric, setMetric] = useState<HeatMetric>('conversions');
  const [media, setMedia] = useState<MediaId | 'all'>('all');
  const h = useMemo(() => hourWeekHeatmap(d, metric, media), [d, metric, media]);
  const format = metric === 'cost' ? (v: number) => fmt.krw(v) : metric === 'roas' ? (v: number) => fmt.roas(v) : (v: number) => fmt.dec1(v);
  const eff = h.hourEfficiency;
  const block = (from: number, to: number) => {
    const xs = eff.filter((x) => x.hour >= from && x.hour <= to);
    const cs = xs.reduce((a, x) => a + (Number.isFinite(x.costShare) ? x.costShare : 0), 0);
    const vs = xs.reduce((a, x) => a + (Number.isFinite(x.convShare) ? x.convShare : 0), 0);
    return { cs, vs, idx: cs > 0 ? vs / cs : NaN };
  };
  const evening = block(20, 23);
  const night = block(0, 5);
  const day = block(6, 19);
  const unit = metric === 'roas' ? 'ROAS (매출 ÷ 광고비)' : `일 평균 ${metric === 'cost' ? '광고비' : '전환'} (같은 요일 ${Math.round(h.days / 7)}회 평균)`;

  return (
    <div className="stack-lg">
      <Card
        title="시간대 × 요일"
        sub={`최근 4주 ${fmtDate(h.from, false)}–${fmtDate(h.to, false)} · 오늘(부분일) 제외 · ${unit}`}
        actions={<><Src kind="DEMO" /></>}
      >
        <div className="board-filters">
          <Field label="지표" id="board-heat-metric"><Segmented options={METRICS} value={metric} onChange={setMetric} label="히트맵 지표" /></Field>
          <Field label="매체" id="board-heat-media">
            <select id="board-heat-media" className="select" value={media} onChange={(e) => setMedia(e.target.value as MediaId | 'all')}>
              <option value="all">전체 매체</option>
              {MEDIA_IDS.map((m) => <option key={m} value={m}>{MEDIA[m].name}</option>)}
            </select>
          </Field>
        </div>
        {h.hasData ? (
          <>
            <Heatmap rows={h.rows} cols={h.cols} values={h.values} format={format} highlight={h.top.map((t) => ({ r: t.r, c: t.c }))} />
            <div className="row xs" style={{ gap: 8 }}>
              <span className="muted">색이 진할수록 값이 큼 · 테두리 = 상위 3개 슬롯</span>
              {h.top.map((t, i) => <Pill key={i} tone="outline">{t.label} {format(t.value)}</Pill>)}
            </div>
          </>
        ) : <div className="small muted">최근 4주 시간대 데이터가 없습니다.</div>}
      </Card>

      <div className="grid g-3">
        <Card title="시간대별 전환 효율 지수" sub="전환 비중 ÷ 광고비 비중 · 1 초과 = 광고비 대비 전환이 많음 · 최근 4주" className="span-2" actions={<Src kind="DEMO" />}>
          <BarChart
            data={eff.map((x) => ({ label: String(x.hour), value: Number.isFinite(x.index) ? x.index : 0, colorVar: '--series-1', note: `${x.hour}시 · 광고비 ${fmt.ratio(x.costShare, 1)} · 전환 ${fmt.ratio(x.convShare, 1)}` }))}
            height={200} format={(v) => v.toFixed(2)} refValue={1}
          />
        </Card>
        <Card title="시간대 블록 비교" sub={media === 'all' ? '전체 매체' : MEDIA[media].name} actions={<Src kind="DEMO" />}>
          <div className="board-list">
            {[{ label: '20~23시', b: evening }, { label: '6~19시', b: day }, { label: '0~5시', b: night }].map(({ label, b }) => (
              <div key={label} className="board-list-item">
                <strong className="small">{label}</strong>
                <span className="xs muted">광고비 {fmt.ratio(b.cs, 0)} · 전환 {fmt.ratio(b.vs, 0)}</span>
                <span className="small num"><strong>{Number.isFinite(b.idx) ? b.idx.toFixed(2) : '—'}</strong></span>
              </div>
            ))}
          </div>
          <div className="xs muted">
            효율 지수는 시간대별 평균 CVR 차이를 보여줄 뿐, 해당 시간 입찰을 올렸을 때의 한계 효율을 뜻하지 않습니다. 시간대 입찰 가중은 AD Pilot 테스트(동일 기간 대조)로 검증한 뒤 적용합니다.
          </div>
        </Card>
      </div>
    </div>
  );
}
