/* MILDO Watch 공용 UI 조각 — 판정 배지는 항상 기준 · 근거와 함께 표시한다 */
import type { ReactNode } from 'react';
import { MEDIA } from '@/data/constants';
import type { MediaId } from '@/core/types';
import { Icon } from '@/ui/Icon';
import { Pill, Swatch } from '@/ui/primitives';
import { fmtDelta, IMPACT_META, PIPELINE, STAGE_INDEX, TEST_VERDICT_META, VERDICT_META, type Diagnosis, type ImpactLevel, type Level, type StageDue, type StageId, type TestJudgement, type WatchEvidence } from './engine';
import { MEDIA_TRACKING } from './data';

export const mediaLabel = (m: MediaId) => MEDIA_TRACKING.find((t) => t.media === m)?.name ?? MEDIA[m]?.name ?? m;

export function MediaTag({ media }: { media: MediaId }) {
  return <Swatch colorVar={MEDIA[media]?.colorVar ?? '--series-1'} label={<span className="small">{mediaLabel(media)}</span>} />;
}

/** 영향 진단 배지 + 기준 · 근거 */
export function VerdictBadge({ diag, compact }: { diag: Diagnosis; compact?: boolean }) {
  const m = VERDICT_META[diag.verdict];
  return (
    <span className="watch-verdict">
      <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>
      <span className={compact ? 'xs muted watch-clip' : 'xs ink2'} title={compact ? diag.basis : undefined}>{diag.basis}</span>
    </span>
  );
}

export function TestBadge({ judge, compact, prefix }: { judge: TestJudgement; compact?: boolean; prefix?: ReactNode }) {
  const m = TEST_VERDICT_META[judge.verdict];
  return (
    <span className="watch-verdict">
      {prefix ? <span className="xs muted">{prefix}</span> : null}
      <Pill tone={m.tone} icon={m.icon}>{judge.label}</Pill>
      <span className={compact ? 'xs muted watch-clip' : 'xs ink2'} title={compact ? judge.basis : undefined}>{judge.basis}</span>
    </span>
  );
}

export function ImpactBadge({ level, basis }: { level: ImpactLevel; basis?: string }) {
  const m = IMPACT_META[level];
  return (
    <span className="watch-verdict">
      <Pill tone={m.tone} icon={level === 'low' ? 'inbox' : 'alert'}>{m.label}</Pill>
      {basis ? <span className="xs muted">{basis}</span> : null}
    </span>
  );
}

const LEVEL_META: Record<Level, { label: string; tone: 'serious' | 'warning' | 'good' | 'neutral'; icon: string }> = {
  danger: { label: '위험', tone: 'serious', icon: 'alert' },
  warn: { label: '주의', tone: 'warning', icon: 'alert' },
  ok: { label: '정상', tone: 'good', icon: 'check' },
  info: { label: '참고', tone: 'neutral', icon: 'sparkle' },
};
export function LevelPill({ level }: { level: Level }) {
  const m = LEVEL_META[level];
  return <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>;
}

/** p.24 파이프라인 진행 스텝 (감지 → 영향 진단 → 실행안 → 소액 테스트 → 랩업) */
export function PipelineSteps({ stage, closed, size = 'sm' }: { stage: StageId; closed?: boolean; size?: 'sm' | 'lg' }) {
  const cur = STAGE_INDEX[stage];
  return (
    <ol className={`watch-steps ${size}`} aria-label={`파이프라인 단계: ${PIPELINE[cur].label}${closed ? ' (관찰 종료)' : ''}`}>
      {PIPELINE.map((p, i) => {
        const st = closed ? (i <= cur ? 'done' : 'skip') : i < cur ? 'done' : i === cur ? (stage === 'wrapup' ? 'done' : 'cur') : 'todo';
        return (
          <li key={p.id} className={`watch-step ${st}`} title={`${p.label} · ${p.due}`}>
            <span className="watch-step-dot">{st === 'done' ? <Icon name="check" size={10} stroke={3} /> : null}</span>
            <span className="watch-step-label">{size === 'lg' ? p.label : p.short}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function DueTag({ due }: { due: StageDue }) {
  const cls = due.overdue ? 'critical' : due.urgent ? 'warning' : '';
  return (
    <span className={`watch-due ${cls}`}>
      <Icon name={due.overdue || due.urgent ? 'alert' : 'clock'} size={12} />
      {due.label}
    </span>
  );
}

export function EvidenceTable({ evidence }: { evidence: WatchEvidence[] }) {
  if (!evidence.length) return <div className="small muted">근거 수치 없음</div>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr><th>지표</th><th className="r">관측</th><th>비교 기준</th><th className="r">증감</th><th>판정 기준</th><th>판정</th></tr>
        </thead>
        <tbody>
          {evidence.map((e, i) => (
            <tr key={`${e.label}-${i}`}>
              <td><span className="small">{e.label}</span>{e.note ? <div className="xs muted">{e.note}</div> : null}</td>
              <td className="r num">{e.value}</td>
              <td className="xs ink2">{e.base ?? '—'}</td>
              <td className="r num">{Number.isFinite(e.delta) ? fmtDelta(e.delta as number, 0) : '—'}</td>
              <td className="xs muted">{e.threshold ?? '—'}</td>
              <td><LevelPill level={e.level} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CauseBars({ causes }: { causes: { label: string; score: number; basis: string }[] }) {
  if (!causes.length) return <div className="small muted">원인 후보 없음</div>;
  return (
    <div className="stack-sm">
      {causes.map((c) => (
        <div key={c.label} className="watch-cause">
          <div className="row-between small"><strong>{c.label}</strong><span className="xs muted num">근거 강도 {c.score}</span></div>
          <div className="watch-cause-bar"><span style={{ width: `${Math.max(4, Math.min(100, c.score))}%` }} /></div>
          <div className="xs muted">{c.basis}</div>
        </div>
      ))}
    </div>
  );
}

export function KeyVal({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="watch-kv">
      <span className="xs muted">{k}</span>
      <span className="small">{v}</span>
    </div>
  );
}

export function Chips({ items, max = 4 }: { items: string[]; max?: number }) {
  if (!items.length) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      {items.slice(0, max).map((k) => <span key={k} className="watch-chip">{k}</span>)}
      {items.length > max ? <span className="xs muted">+{items.length - max}</span> : null}
    </span>
  );
}
