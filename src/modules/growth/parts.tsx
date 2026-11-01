/* 매출 성장 모듈 공용 하위 컴포넌트 · 포맷 */
import type { ReactNode } from 'react';
import type { IntentId, MediaId } from '@/core/types';
import { MEDIA, MEDIA_IDS } from '@/data/constants';
import { fmt } from '@/core/util';
import { Pill, Swatch, type Tone } from '@/ui/primitives';
import { Legend } from '@/ui/charts';
import type { BindReason, GroupMetric, Shares } from './engine';

export type TabId = 'overview' | 'target' | 'alloc' | 'dasa' | 'funnel' | 'demand' | 'partner';

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
    </div>
  );
}

export function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <div className="growth-kv"><span className="muted">{k}</span><span>{v}</span></div>;
}
