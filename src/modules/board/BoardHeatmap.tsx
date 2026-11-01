/**
 * 시간대 × 요일 히트맵 (Board 전용).
 * 공용 ui/charts Heatmap은 22px 고정 셀이라 1280px 화면에서 카드 폭의 60% 정도만 차지하고 색 범례가 없다.
 * 여기서는 셀 폭을 카드 폭에 맞춰 늘리고(최소 폭 아래에서는 가로 스크롤), 단일 색 순차 스케일 + 범례 + 호버 값 표시를 둔다.
 * 색은 CSS 변수(--series-1 ↔ --surface 혼합)만 쓴다. 다크 모드에서는 같은 혼합이 어두운 지면 기준으로 계산된다.
 */
import { useState } from 'react';

const STEPS = 7;

export function heatLevel(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return -1;
  const span = max - min;
  if (!(span > 0)) return Math.floor(STEPS / 2);
  return Math.max(0, Math.min(STEPS - 1, Math.round(((v - min) / span) * (STEPS - 1))));
}

function levelColor(level: number, colorVar: string): string {
  if (level < 0) return 'var(--surface-2)';
  const pct = Math.round(10 + (level / (STEPS - 1)) * 90);
  return `color-mix(in srgb, var(${colorVar}) ${pct}%, var(--surface))`;
}

export function BoardHeatmap({
  rows, cols, values, format, highlight = [], colorVar = '--series-1', colSuffix = '시', label,
}: {
  rows: string[];
  cols: string[];
  values: number[][];
  format: (v: number) => string;
  highlight?: { r: number; c: number }[];
  colorVar?: string;
  colSuffix?: string;
  label: string;
}) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const flat = values.flat().filter(Number.isFinite);
  const min = flat.length ? Math.min(...flat) : NaN;
  const max = flat.length ? Math.max(...flat) : NaN;
  const hl = new Set(highlight.map((h) => `${h.r}:${h.c}`));
  const hv = hover ? values[hover.r]?.[hover.c] : NaN;
  return (
    <div className="board-heat">
      <div className="board-heat-scroll">
        <table className="board-heat-grid" aria-label={label} onMouseLeave={() => setHover(null)}>
          <thead>
            <tr>
              <th scope="col" className="board-heat-corner"><span className="board-sr">요일</span></th>
              {cols.map((c) => <th key={c} scope="col">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r}>
                <th scope="row">{r}</th>
                {cols.map((c, ci) => {
                  const v = values[ri]?.[ci] ?? NaN;
                  const lv = heatLevel(v, min, max);
                  const text = `${r} ${c}${colSuffix} ${Number.isFinite(v) ? format(v) : '데이터 없음'}`;
                  const isHover = hover?.r === ri && hover?.c === ci;
                  return (
                    <td
                      key={c}
                      title={text}
                      aria-label={text}
                      className={[hl.has(`${ri}:${ci}`) ? 'top' : '', isHover ? 'hover' : ''].filter(Boolean).join(' ') || undefined}
                      style={{ background: levelColor(lv, colorVar) }}
                      onMouseEnter={() => setHover({ r: ri, c: ci })}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="board-heat-foot">
        <div className="board-heat-legend" aria-hidden="true">
          <span className="xs muted num">{Number.isFinite(min) ? format(min) : '—'}</span>
          {Array.from({ length: STEPS }, (_, i) => <i key={i} style={{ background: levelColor(i, colorVar) }} />)}
          <span className="xs muted num">{Number.isFinite(max) ? format(max) : '—'}</span>
          <span className="board-heat-top-key" /> <span className="xs muted">상위 3개 슬롯</span>
        </div>
        <span className="xs num board-heat-readout" aria-live="polite">
          {hover ? <><strong>{rows[hover.r]} {cols[hover.c]}{colSuffix}</strong> · {Number.isFinite(hv) ? format(hv) : '데이터 없음'}</> : <span className="muted">셀에 마우스를 올리면 값이 표시됩니다</span>}
        </span>
      </div>
    </div>
  );
}
