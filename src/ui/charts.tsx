/**
 * SVG 차트 — dataviz 원칙: 단일 축, 고정 색 슬롯, 2px 선, 4px 라운드 막대, 옅은 그리드, 호버 툴팁, 2개 이상 시 범례.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setW(el.clientWidth || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w] as const;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export interface Series {
  id: string;
  label: string;
  colorVar: string;
  points: { x: string; y: number }[];
  dashed?: boolean;
}

export function Legend({ items }: { items: { label: ReactNode; colorVar: string; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((it, i) => (
        <span key={i} className="legend-item">
          <span className="legend-swatch" style={{ background: it.dashed ? 'transparent' : `var(${it.colorVar})`, border: it.dashed ? `2px dashed var(${it.colorVar})` : undefined, height: it.dashed ? 0 : 10, width: it.dashed ? 14 : 10 }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function LineChart({
  series, height = 220, yFormat = (v) => String(Math.round(v)), xFormat = (x) => x, area = false, refLine, zeroBased = true, legend = true, ariaLabel,
}: {
  series: Series[]; height?: number; yFormat?: (v: number) => string; xFormat?: (x: string) => string; area?: boolean;
  refLine?: { y: number; label: string }; zeroBased?: boolean; legend?: boolean; ariaLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const xs = series[0]?.points.map((p) => p.x) ?? [];
  // 2~4개 계열은 선 끝에 이름을 직접 표기 — 오른쪽 여백은 가장 긴 이름 폭에 맞춘다 (한글 11px · 영숫자 6.5px 추정, 최대 150px)
  const endLabelled = series.length > 1 && series.length <= 4;
  const labelWidth = (t: string) => [...t].reduce((w, ch) => w + (/[\u0000-\u00ff]/.test(ch) ? 6.5 : 11), 0);
  const pad = { l: 56, r: endLabelled ? Math.min(150, Math.max(70, 14 + Math.max(...series.map((s) => labelWidth(s.label))))) : 16, t: 12, b: 26 };
  const W = Math.max(200, width);
  const H = height;
  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite);
  if (refLine) all.push(refLine.y);
  let min = zeroBased ? Math.min(0, ...all) : Math.min(...all);
  let max = Math.max(...all);
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 1;
  if (!zeroBased) { const s = (max - min) * 0.1 || 1; min -= s; max += s; }
  const ticks = niceTicks(min, max);
  const yMin = Math.min(min, ticks[0]);
  const yMax = Math.max(max, ticks[ticks.length - 1]);
  const x = (i: number) => pad.l + (xs.length <= 1 ? 0 : (i / (xs.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const labelEvery = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor((W - pad.l - pad.r) / 70))));
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * (W - pad.l - pad.r);
    const i = Math.round((px / (W - pad.l - pad.r)) * (xs.length - 1));
    setHover(Math.max(0, Math.min(xs.length - 1, i)));
  };
  const path = (pts: { y: number }[]) => pts.map((p, i) => (Number.isFinite(p.y) ? `${i === 0 || !Number.isFinite(pts[i - 1].y) ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}` : '')).join('');
  return (
    <div className="stack-sm">
      {legend && series.length > 1 ? <Legend items={series.map((s) => ({ label: s.label, colorVar: s.colorVar, dashed: s.dashed }))} /> : null}
      <div className="chart" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={ariaLabel ?? series.map((s) => s.label).join(', ')}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          <line className="axisline" x1={pad.l} x2={W - pad.r} y1={y(yMin)} y2={y(yMin)} />
          {xs.map((xv, i) => (i % labelEvery === 0 || i === xs.length - 1) && (i === xs.length - 1 || xs.length - 1 - i >= labelEvery * 0.6) ? (
            <text key={xv + i} x={x(i)} y={H - 6} textAnchor="middle">{xFormat(xv)}</text>
          ) : null)}
          {refLine ? (
            <g>
              <line x1={pad.l} x2={W - pad.r} y1={y(refLine.y)} y2={y(refLine.y)} stroke="var(--ink-2)" strokeDasharray="4 4" strokeWidth={1} />
              <text x={W - pad.r} y={y(refLine.y) - 4} textAnchor="end" style={{ fill: 'var(--ink-2)', stroke: 'var(--surface)', strokeWidth: 3, paintOrder: 'stroke' }}>{refLine.label}</text>
            </g>
          ) : null}
          {series.map((s) => (
            <g key={s.id}>
              {area && series.length === 1 ? (
                <path d={`${path(s.points)}L${x(s.points.length - 1)},${y(yMin)}L${x(0)},${y(yMin)}Z`} fill={`var(${s.colorVar})`} opacity={0.12} />
              ) : null}
              <path d={path(s.points)} fill="none" stroke={`var(${s.colorVar})`} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
              {s.points.length ? (() => {
                const li = s.points.length - 1;
                const lv = s.points[li].y;
                return Number.isFinite(lv) ? (
                  <g>
                    <circle cx={x(li)} cy={y(lv)} r={4} fill={`var(${s.colorVar})`} stroke="var(--surface)" strokeWidth={2} />
                  </g>
                ) : null;
              })() : null}
            </g>
          ))}
          {endLabelled ? (() => {
            // 끝 라벨 겹침 방지: 위에서부터 최소 13px 간격으로 밀고, 아래 경계를 넘으면 위로 되민다. 3px 이상 움직이면 짧은 지시선을 긋는다.
            const items = series.flatMap((s) => {
              const li = s.points.length - 1;
              const lv = li >= 0 ? s.points[li].y : NaN;
              return Number.isFinite(lv) ? [{ id: s.id, label: s.label, cx: x(li), cy: y(lv), ty: y(lv) + 4 }] : [];
            }).sort((a, b) => a.ty - b.ty);
            const GAP = 13;
            for (let i = 1; i < items.length; i++) if (items[i].ty - items[i - 1].ty < GAP) items[i].ty = items[i - 1].ty + GAP;
            const bottom = H - pad.b + 4;
            for (let i = items.length - 1; i >= 0; i--) {
              const limit = i === items.length - 1 ? bottom : items[i + 1].ty - GAP;
              if (items[i].ty > limit) items[i].ty = limit;
            }
            return (
              <g>
                {items.map((it) => (
                  <g key={`lbl-${it.id}`}>
                    {Math.abs(it.ty - (it.cy + 4)) > 3 ? <line x1={it.cx + 5} y1={it.cy} x2={it.cx + 9} y2={it.ty - 4} stroke="var(--ink-2)" strokeWidth={1} opacity={0.6} /> : null}
                    <text x={it.cx + 10} y={it.ty} style={{ fill: 'var(--ink-2)', fontSize: 11 }}>{it.label}</text>
                  </g>
                ))}
              </g>
            );
          })() : null}
          {hover !== null ? (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-2)" strokeWidth={1} opacity={0.5} />
              {series.map((s) => Number.isFinite(s.points[hover]?.y) ? <circle key={s.id} cx={x(hover)} cy={y(s.points[hover].y)} r={4} fill={`var(${s.colorVar})`} stroke="var(--surface)" strokeWidth={2} /> : null)}
            </g>
          ) : null}
          <rect x={pad.l} y={pad.t} width={Math.max(1, W - pad.l - pad.r)} height={Math.max(1, H - pad.t - pad.b)} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {hover !== null ? (
          <div className="chart-tip" style={{ left: Math.min(x(hover) + 12, W - 180), top: 8 }}>
            <div className="tip-title">{xFormat(xs[hover])}</div>
            {series.map((s) => (
              <div key={s.id} className="tip-row">
                <span className="legend-item"><span className="legend-swatch" style={{ background: `var(${s.colorVar})` }} />{s.label}</span>
                <strong className="num">{yFormat(s.points[hover]?.y)}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface BarDatum { label: string; value: number; colorVar?: string; note?: string }

/** 가로 막대 — 라벨이 긴 카테고리 비교용 */
export function HBarChart({ data, format = (v) => String(Math.round(v)), refValue, refLabel, max: maxIn }: { data: BarDatum[]; format?: (v: number) => string; refValue?: number; refLabel?: string; max?: number }) {
  const max = maxIn ?? Math.max(...data.map((d) => d.value), refValue ?? 0, 1e-9);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="stack-sm" role="img" aria-label={data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}>
      {data.map((d, i) => (
        <div key={d.label + i} className="row" style={{ flexWrap: 'nowrap', gap: 10 }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} title={d.note}>
          <div className="small" style={{ width: 'clamp(72px, 34%, 132px)', flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.label}>{d.label}</div>
          <div style={{ flex: 1, position: 'relative', height: 18 }}>
            <div style={{ position: 'absolute', inset: '3px auto 3px 0', width: `${Math.max(0.5, (Math.max(0, d.value) / max) * 100)}%`, background: `var(${d.colorVar ?? '--series-1'})`, borderRadius: '0 4px 4px 0', opacity: hover === null || hover === i ? 1 : 0.55 }} />
            {refValue !== undefined ? <div title={refLabel} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(refValue / max) * 100}%`, width: 2, background: 'var(--ink-2)' }} /> : null}
          </div>
          <div className="small num" style={{ width: 'clamp(48px, 20%, 84px)', textAlign: 'right', flex: 'none', whiteSpace: 'nowrap' }}>{format(d.value)}</div>
        </div>
      ))}
      {refValue !== undefined && refLabel ? <div className="xs muted">세로선: {refLabel}</div> : null}
    </div>
  );
}

/** 세로 막대 (시계열/카테고리) */
export function BarChart({ data, height = 200, format = (v) => String(Math.round(v)), refValue, refLabel }: { data: BarDatum[]; height?: number; format?: (v: number) => string; refValue?: number; refLabel?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 10, t: 12, b: 26 };
  const W = Math.max(200, width);
  const vals = data.map((d) => d.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals, refValue ?? 0, 1e-9));
  const yMin = ticks[0], yMax = ticks[ticks.length - 1];
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (height - pad.t - pad.b);
  const band = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(42, band - 2));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor((W - pad.l - pad.r) / 60))));
  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${height}`} height={height} role="img" aria-label={data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + band * i + band / 2;
          const top = y(Math.max(0, d.value));
          const bottom = y(Math.min(0, d.value));
          const h = Math.max(1, bottom - top);
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={d.label + i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={cx - band / 2} y={pad.t} width={band} height={height - pad.t - pad.b} fill="transparent" />
              <path d={`M${cx - bw / 2},${bottom}V${top + r}Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top}H${cx + bw / 2 - r}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r}V${bottom}Z`}
                fill={`var(${d.colorVar ?? '--series-1'})`} opacity={hover === null || hover === i ? 1 : 0.55} />
              {i % labelEvery === 0 ? <text x={cx} y={height - 6} textAnchor="middle">{d.label}</text> : null}
            </g>
          );
        })}
        <line className="axisline" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
        {refValue !== undefined ? (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(refValue)} y2={y(refValue)} stroke="var(--ink-2)" strokeDasharray="4 4" />
            {refLabel ? <text x={W - pad.r} y={y(refValue) - 4} textAnchor="end" style={{ fill: 'var(--ink-2)', stroke: 'var(--surface)', strokeWidth: 3, paintOrder: 'stroke' }}>{refLabel}</text> : null}
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <div className="chart-tip" style={{ left: Math.min(pad.l + band * hover + band / 2 + 10, W - 170), top: 6 }}>
          <div className="tip-title">{data[hover].label}</div>
          <div className="tip-row"><strong className="num">{format(data[hover].value)}</strong></div>
          {data[hover].note ? <div className="tip-title" style={{ marginTop: 4, marginBottom: 0 }}>{data[hover].note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 100% 누적 막대 (구성비) */
export function ShareBar({ parts, format = (v) => `${(v * 100).toFixed(1)}%` }: { parts: { label: string; value: number; colorVar: string }[]; format?: (share: number) => string }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  return (
    <div className="stack-sm">
      <div style={{ display: 'flex', height: 18, borderRadius: 6, overflow: 'hidden', gap: 2 }} role="img" aria-label={parts.map((p) => `${p.label} ${format(p.value / total)}`).join(', ')}>
        {parts.map((p) => (
          <div key={p.label} title={`${p.label} ${format(p.value / total)}`} style={{ width: `${(Math.max(0, p.value) / total) * 100}%`, background: `var(${p.colorVar})` }} />
        ))}
      </div>
      <Legend items={parts.map((p) => ({ label: `${p.label} ${format(p.value / total)}`, colorVar: p.colorVar }))} />
    </div>
  );
}

export function Sparkline({ values, colorVar = '--series-1', width = 120, height = 32, ariaLabel }: { values: number[]; colorVar?: string; width?: number; height?: number; ariaLabel?: string }) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...v), max = Math.max(...v);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 6);
  const y = (val: number) => 3 + (1 - (val - min) / (max - min || 1)) * (height - 6);
  const d = values.map((val, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join('');
  const li = values.length - 1;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel ?? '추세'}>
      <path d={`${d}L${x(li)},${height}L${x(0)},${height}Z`} fill={`var(${colorVar})`} opacity={0.12} />
      <path d={d} fill="none" stroke={`var(${colorVar})`} strokeWidth={1.8} strokeLinejoin="round" />
      <circle cx={x(li)} cy={y(values[li])} r={3} fill={`var(${colorVar})`} />
    </svg>
  );
}

/** 히트맵 (요일 × 시간 등) — 단일 색상 순차 스케일 */
export function Heatmap({ rows, cols, values, format = (v) => String(Math.round(v)), highlight }: { rows: string[]; cols: string[]; values: number[][]; format?: (v: number) => string; highlight?: { r: number; c: number }[] }) {
  const flat = values.flat().filter(Number.isFinite);
  const min = Math.min(...flat), max = Math.max(...flat);
  const ramp = ['#e8f1fc', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
  const color = (v: number) => (Number.isFinite(v) ? ramp[Math.min(ramp.length - 1, Math.floor(((v - min) / (max - min || 1)) * (ramp.length - 1) + 0.5))] : 'var(--surface-2)');
  const hl = new Set((highlight ?? []).map((h) => `${h.r}:${h.c}`));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 2, fontSize: 10.5 }} aria-label="히트맵">
        <thead>
          <tr><th />{cols.map((c) => <th key={c} className="muted" style={{ fontWeight: 400, padding: '0 1px' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r}>
              <th className="muted" style={{ fontWeight: 400, paddingRight: 6, textAlign: 'right', whiteSpace: 'nowrap' }}>{r}</th>
              {cols.map((c, ci) => (
                <td key={c} title={`${r} ${c}: ${format(values[ri][ci])}`} style={{ width: 22, height: 18, background: color(values[ri][ci]), borderRadius: 3, outline: hl.has(`${ri}:${ci}`) ? '2px solid var(--accent)' : undefined }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 퍼널 — 단계별 수치와 단계 전환율 */
export function Funnel({ steps, format = (v) => String(Math.round(v)) }: { steps: { label: string; value: number; note?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="stack-sm">
      {steps.map((s, i) => {
        const conv = i > 0 && steps[i - 1].value > 0 ? (s.value / steps[i - 1].value) * 100 : null;
        return (
          <div key={s.label} className="stack-sm" style={{ gap: 2 }}>
            <div className="row-between small"><span>{s.label}</span><span className="num"><strong>{format(s.value)}</strong>{conv !== null ? <span className="muted"> · 전 단계 대비 {conv.toFixed(1)}%</span> : null}</span></div>
            <div style={{ height: 14, background: 'var(--surface-2)', borderRadius: 4 }}>
              <div style={{ width: `${Math.max(1, (s.value / max) * 100)}%`, height: '100%', background: 'var(--series-1)', borderRadius: 4, opacity: 1 - i * 0.12 }} />
            </div>
            {s.note ? <div className="xs muted">{s.note}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** 간트 (주 단위) */
export function Gantt({ weeks, rows, milestones, current }: { weeks: number; rows: { task: string; start: number; end: number; tone?: 'accent' | 'ink' }[]; milestones?: { week: number; label: string }[]; current?: number }) {
  const pct = (w: number) => ((w - 1) / weeks) * 100;
  return (
    <div className="gantt">
      <div className="gantt-row">
        <div />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks}, 1fr)` }} className="xs muted">
          {Array.from({ length: weeks }, (_, i) => <div key={i} style={{ textAlign: 'center' }}>W{i + 1}</div>)}
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.task} className="gantt-row">
          <div className="small">{r.task}</div>
          <div className="gantt-track">
            <div className={`gantt-bar${r.tone === 'accent' ? ' accent' : ''}`} style={{ left: `${pct(r.start)}%`, width: `${((r.end - r.start + 1) / weeks) * 100}%` }} title={`W${r.start}–W${r.end}`} />
            {current ? <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${pct(current)}%`, width: 2, background: 'var(--accent)' }} /> : null}
          </div>
        </div>
      ))}
      {milestones?.length ? (
        <div className="gantt-row">
          <div />
          <div style={{ position: 'relative', height: 34 }}>
            {milestones.map((m) => (
              <div key={m.label} className="xs" style={{ position: 'absolute', left: `calc(${((m.week) / weeks) * 100}% - 1px)`, transform: 'translateX(-100%)', textAlign: 'right', borderRight: '2px solid var(--accent)', paddingRight: 6, whiteSpace: 'nowrap' }}>
                <strong>{m.label}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function useSeriesMemo<T>(f: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(f, deps);
}
