/* 매출 성장 모듈 공용 하위 컴포넌트 · 포맷 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { IntentId, MediaId } from '@/core/types';
import { MEDIA, MEDIA_IDS } from '@/data/constants';
import { fmt } from '@/core/util';
import { Pill, Swatch, type Tone } from '@/ui/primitives';
import { Legend } from '@/ui/charts';
import type { BindReason, GroupMetric, Shares } from './engine';

export type TabId = 'overview' | 'target' | 'alloc' | 'dasa' | 'funnel' | 'demand' | 'partner';

/**
 * 범위가 있는 숫자 입력 — 공용 NumberInput과 같은 마크업 · props.
 * 키 입력마다 onChange에서 범위로 맞추면 '20'을 치는 중간값 '2'가 최소 5로 바뀌어 '50'이 되는 문제(연 예산 · 재배분 폭 · 검정력 · 곡선 b 등)가 있어,
 * 입력 중에는 친 글자를 그대로 두고 범위 안 값만 즉시 반영한다. 포커스를 벗어나거나 Enter를 누르면 범위로 맞춰 반영한다.
 */
export function NumField({ id, value, onChange, step = 1, min, max, suffix, style }: {
  id: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; style?: CSSProperties;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inRange = (v: number) => (min === undefined || v >= min) && (max === undefined || v <= max);
  const fit = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v) && fit(v) !== value) onChange(fit(v));
    setDraft(null);
  };
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap', ...style }}>
      <input id={id} className="input num" type="number" value={draft ?? (Number.isFinite(value) ? value : '')} step={step} min={min} max={max}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const v = Number(raw);
          if (raw.trim() !== '' && Number.isFinite(v) && inRange(v)) onChange(v);
        }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      {suffix ? <span className="small muted nowrap">{suffix}</span> : null}
    </div>
  );
}

/** 판정 배지 + 기준값 (SPEC §0: 배지 옆에 기준을 보여준다) */
export function Verdict({ tone, label, basis, icon }: { tone: Tone; label: string; basis?: ReactNode; icon?: string }) {
  return (
    <span className="growth-verdict">
      <Pill tone={tone} icon={icon}>{label}</Pill>
      {basis ? <span className="xs muted">{basis}</span> : null}
    </span>
  );
}

export function MediaLabel({ m, sub }: { m: MediaId; sub?: boolean }) {
  return (
    <span className="stack-sm" style={{ gap: 0 }}>
      <Swatch colorVar={MEDIA[m].colorVar} label={<strong>{MEDIA[m].name}</strong>} />
      {sub ? <span className="xs muted">{MEDIA[m].role} · {MEDIA[m].judgeMetric}</span> : null}
    </span>
  );
}

/** SA 의도 캠페인 색 (엔티티 고정 슬롯) */
export const INTENT_COLOR: Record<IntentId, string> = { brand: '--series-1', generic: '--series-2', problem: '--series-3', compare: '--series-4', life: '--series-7' };

export function metricText(m: GroupMetric): string {
  switch (m.kind) {
    case 'roas': return fmt.roas(m.value);
    case 'pct': return fmt.pct(m.value, 2);
    case 'won': return fmt.won(m.value);
    case 'krw': return fmt.krw(m.value);
    case 'ratio': return fmt.ratio(m.value);
    default: return fmt.int(m.value);
  }
}

export const BIND_LABEL: Record<BindReason, { label: string; tone: Tone }> = {
  min: { label: '가드레일 하한', tone: 'warning' },
  max: { label: '가드레일 상한', tone: 'warning' },
  step: { label: '재배분 폭 상한', tone: 'neutral' },
  cap: { label: '볼륨 한계', tone: 'serious' },
  fixed: { label: '데이터 없음', tone: 'outline' },
};

export const SIGNAL_TONE: Record<'serious' | 'warning' | 'neutral' | 'good', { label: string; tone: Tone }> = {
  serious: { label: '우선 확인', tone: 'serious' },
  warning: { label: '검증 필요', tone: 'warning' },
  good: { label: '확대 기회', tone: 'good' },
  neutral: { label: '참고', tone: 'neutral' },
};

/** 100% 누적 막대 (매체 색 고정) — 여러 배분안을 같은 범례로 비교 */
export function StackRows({ rows }: { rows: { label: string; shares: Shares }[] }) {
  return (
    <div className="stack-sm">
      {rows.map((r) => (
        <div key={r.label} className="growth-stack">
          <span className="small">{r.label}</span>
          <div className="growth-stack-bar" role="img" aria-label={`${r.label}: ${MEDIA_IDS.map((m) => `${MEDIA[m].short} ${fmt.ratio(r.shares[m])}`).join(', ')}`}>
            {MEDIA_IDS.map((m) => (
              <span key={m} title={`${MEDIA[m].name} ${fmt.ratio(r.shares[m])}`} style={{ width: `${Math.max(0, r.shares[m]) * 100}%`, background: `var(${MEDIA[m].colorVar})` }} />
            ))}
          </div>
        </div>
      ))}
      <Legend items={MEDIA_IDS.map((m) => ({ label: MEDIA[m].short, colorVar: MEDIA[m].colorVar }))} />
      {/* 막대만으로는 비중을 읽기 어려워 같은 값을 숫자로 함께 표시 */}
      <table className="growth-share-tbl">
        <thead><tr><th />{MEDIA_IDS.map((m) => <th key={m}>{MEDIA[m].short}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}><th scope="row">{r.label}</th>{MEDIA_IDS.map((m) => <td key={m}>{fmt.ratio(r.shares[m])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <div className="growth-kv"><span className="muted">{k}</span><span>{v}</span></div>;
}
