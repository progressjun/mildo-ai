/* MILDO Board 하위 공용 컴포넌트 — 판정 배지는 항상 기준값을 옆에 보여준다 (SPEC §0) */
import { useId, type ReactNode } from 'react';
import type { MediaId } from '@/core/types';
import { MEDIA, MEDIA_IDS } from '@/data/constants';
import { fmt } from '@/core/util';
import { Delta, Pill, type Tone } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import type { Flag, Signal, TrendMetric, Verdict } from './engine';

export function FlagBadge({ flag, compact }: { flag: Flag; compact?: boolean }) {
  const tone: Tone = flag.level === 'ok' ? 'good' : flag.level === 'warn' ? 'warning' : flag.level === 'danger' ? 'critical' : 'outline';
  const icon = flag.level === 'ok' ? 'check' : flag.level === 'na' ? undefined : 'alert';
  return (
    <div className="board-badge">
      <Pill tone={tone} icon={icon}>{flag.label}</Pill>
      {compact ? null : <span className="board-basis">{flag.basis}</span>}
    </div>
  );
}

export function VerdictBadge({ v }: { v: Verdict }) {
  const icon = v.key === 'high' || v.key === 'met' ? 'check' : v.key === 'below' || v.key === 'noconv' ? 'alert' : undefined;
  return (
    <div className="board-badge">
      <Pill tone={v.tone} icon={v.sampleOk ? icon : undefined}>{v.label}</Pill>
      <span className="board-basis">{v.basis}</span>
    </div>
  );
}

export function SignalPills({ signals, showBasis = false, max = 3 }: { signals: Signal[]; showBasis?: boolean; max?: number }) {
  if (!signals.length) return <span className="xs muted">—</span>;
  const shown = signals.slice(0, max);
  return (
    <div className="board-signals">
      {shown.map((s) => (
        <span key={s.id} className="stack-sm" style={{ gap: 2 }}>
          <Pill tone={s.tone} icon={s.tone === 'critical' || s.tone === 'serious' || s.tone === 'warning' ? 'alert' : s.tone === 'good' ? 'trend' : undefined} title={s.basis}>{s.label}</Pill>
          {showBasis ? <span className="board-basis">{s.basis}</span> : null}
        </span>
      ))}
      {signals.length > max ? <span className="xs muted">+{signals.length - max}</span> : null}
    </div>
  );
}

/**
 * 방향만 보여주는 증감 (색으로 좋고 나쁨을 판정하지 않음).
 * 광고비 증감은 효율 · 볼륨 조건 없이 좋다/나쁘다로 읽을 수 없으므로 중립색으로 표시한다 (SPEC §0).
 */
export function NeutralDelta({ pct, digits = 1 }: { pct: number; digits?: number }) {
  if (!Number.isFinite(pct)) return <span className="delta-flat">—</span>;
  const flat = Math.abs(pct) < 0.5 * 10 ** -digits;
  return (
    <span className="board-delta-neutral">
      {!flat ? <Icon name={pct > 0 ? 'up' : 'down'} size={12} stroke={2.4} /> : null}
      {fmt.delta(pct, digits)}
    </span>
  );
}

/** 숫자 + 직전 대비 (오른쪽 정렬 셀). neutral = 방향만 표시 */
export function NumCell({ value, delta, invert, neutral, sub }: { value: ReactNode; delta?: number; invert?: boolean; neutral?: boolean; sub?: ReactNode }) {
  return (
    <div className="board-cell">
      <span className="num nowrap">{value}</span>
      {delta !== undefined ? <span className="xs">{neutral ? <NeutralDelta pct={delta} digits={0} /> : <Delta pct={delta} invert={invert} digits={0} />}</span> : null}
      {sub ? <span className="board-sub">{sub}</span> : null}
    </div>
  );
}

/** 라벨 + 버튼 그룹 (Segmented 등 htmlFor 대상이 없는 컨트롤용 — 라벨을 aria-labelledby로 연결) */
export function GroupField({ label, children }: { label: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span id={id} className="field-label">{label}</span>
      {children}
    </div>
  );
}

export function metricFormat(metric: TrendMetric): (v: number) => string {
  switch (metric) {
    case 'roas': return (v) => fmt.roas(v);
    case 'conversions': return (v) => fmt.dec1(v);
    case 'cpa': return (v) => fmt.krw(v);
    default: return (v) => fmt.krw(v);
  }
}

export function MediaChips({ selected, onChange, ids = MEDIA_IDS }: { selected: MediaId[]; onChange: (v: MediaId[]) => void; ids?: MediaId[] }) {
  const toggle = (m: MediaId) => {
    const next = selected.includes(m) ? selected.filter((x) => x !== m) : [...selected, m];
    onChange(next.length ? ids.filter((x) => next.includes(x)) : [m]);
  };
  return (
    <div className="board-chips" role="group" aria-label="매체 선택">
      {ids.map((m) => (
        <button key={m} type="button" className="board-chip" aria-pressed={selected.includes(m)} onClick={() => toggle(m)}>
          <span className="legend-swatch" style={{ background: `var(${MEDIA[m].colorVar})` }} />
          {MEDIA[m].short}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({ state }: { state: 'ok' | 'warn' | 'crit' | 'snapshot' | 'pending' }) {
  const label = { ok: '정상', warn: '확인 필요', crit: '조치 필요', snapshot: '스냅샷', pending: '예정' }[state];
  return <span className={`board-dot ${state}`} role="img" aria-label={label} title={label} />;
}
