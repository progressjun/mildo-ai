/* MILDO Alert 공용 표시 컴포넌트 */
import type { MediaId, SalesChannelId, Severity } from '@/core/types';
import { MEDIA, SALES_CHANNELS, SEVERITY_LABEL } from '@/data/constants';
import { useStore } from '@/core/store';
import { fmt } from '@/core/util';
import { Icon } from '@/ui/Icon';
import { Pill, Sev, Swatch, type Tone } from '@/ui/primitives';
import { fmtRemain, fmtValue, slaState, STATUS_LABEL, type AlertIncident, type CauseScore, type Evidence } from './engine';
import { toDataMs, useDataClock } from './clock';

export function mediaName(m?: string): string {
  if (!m) return '—';
  return MEDIA[m as MediaId]?.name ?? SALES_CHANNELS[m as SalesChannelId]?.name ?? m;
}
export function MediaTag({ media }: { media?: string }) {
  if (!media) return <span className="muted">—</span>;
  const colorVar = MEDIA[media as MediaId]?.colorVar ?? SALES_CHANNELS[media as SalesChannelId]?.colorVar ?? '--muted';
  return <Swatch colorVar={colorVar} label={mediaName(media)} />;
}

type LevelLike = 'danger' | 'warn' | 'ok' | 'info' | 'fail' | 'pass';
const LEVEL: Record<LevelLike, { tone: Tone; label: string; icon: string }> = {
  danger: { tone: 'critical', label: '위험', icon: 'alert' },
  fail: { tone: 'critical', label: '실패', icon: 'x' },
  warn: { tone: 'warning', label: '주의', icon: 'alert' },
  ok: { tone: 'good', label: '정상', icon: 'check' },
  pass: { tone: 'good', label: '통과', icon: 'check' },
  info: { tone: 'neutral', label: '참고', icon: 'sparkle' },
};
export function LevelPill({ level, label, title }: { level: LevelLike; label?: string; title?: string }) {
  const l = LEVEL[level];
  return <Pill tone={l.tone} icon={l.icon} title={title}>{label ?? l.label}</Pill>;
}

export function SevLabel({ sev }: { sev: Severity }) {
  return (
    <span className="row nowrap" style={{ gap: 6 }}>
      <Sev level={sev} />
      <span className="xs muted">{SEVERITY_LABEL[sev].split(' · ')[1]}</span>
    </span>
  );
}

const STATUS_TONE: Record<AlertIncident['status'], Tone> = { open: 'critical', ack: 'warning', action: 'outline', resolved: 'good' };
export function StatusPill({ inc }: { inc: AlertIncident }) {
  return (
    <span className="row nowrap" style={{ gap: 4 }}>
      <Pill tone={STATUS_TONE[inc.status]}>{inc.falsePositive ? '오탐 종료' : STATUS_LABEL[inc.status]}</Pill>
    </span>
  );
}

/** SLA 타이머 — 1초 단위로 흐른다 (데이터 시계 기준) */
export function SlaTimer({ inc }: { inc: AlertIncident; compact?: boolean }) {
  const { state } = useStore();
  const now = useDataClock(state.data.generatedAt, 1000);
  const st = slaState(inc, now, (iso) => toDataMs(iso, state.data.generatedAt), state.offHoursMode);
  if (st.stage === 'done') {
    const miss = [st.achieved.ack, st.achieved.action, st.achieved.report].some((v) => v === false);
    return <span className={`alert-sla ${miss ? 'warning' : 'good'}`}><Icon name="check" size={12} />{miss ? '해결 · SLA 일부 미달' : '해결 · SLA 달성'}</span>;
  }
  const target = st.stage === 'ack' ? st.targets.ackMin : st.stage === 'action' ? st.targets.actionMin : st.stage === 'report' ? st.targets.reportMin : null;
  const tone = st.overdue ? 'critical' : st.remainingMin !== null && target ? (st.remainingMin / target < 0.34 ? 'warning' : 'neutral') : 'neutral';
  return (
    <span className={`alert-sla ${tone}`} title={`SLA 목표 (p.49${st.targets.offDay ? ' · 주말 · 공휴일 당번 30분 확인 p.48' : ''})`}>
      <Icon name={st.overdue ? 'alert' : 'clock'} size={12} />
      <span>{st.stageLabel}</span>
      {st.remainingMin !== null ? <strong className="num">{fmtRemain(st.remainingMin)}</strong> : null}
    </span>
  );
}

export function EvidenceTable({ evidence }: { evidence: Evidence[] }) {
  if (!evidence?.length) return <div className="small muted">근거 수치 없음 (외부 모듈 생성 이슈)</div>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr><th>지표</th><th className="r">관측</th><th className="r">기준</th><th className="r">변화</th><th>판정 기준</th><th className="c">판정</th></tr>
        </thead>
        <tbody>
          {evidence.map((e, i) => (
            <tr key={i}>
              <td>
                <div>{e.label}</div>
                {e.baseLabel ? <div className="xs muted">기준: {e.baseLabel}</div> : null}
                {e.note ? <div className="xs muted">{e.note}</div> : null}
              </td>
              <td className="r num">{e.unit === 'text' ? '—' : fmtValue(e.unit, e.observed)}</td>
              <td className="r num">{e.baseline !== undefined && e.unit !== 'text' ? fmtValue(e.unit, e.baseline) : '—'}</td>
              <td className="r num">{e.deltaPct !== undefined && Number.isFinite(e.deltaPct) ? fmt.delta(e.deltaPct) : '—'}</td>
              <td className="xs">{e.threshold ?? '—'}</td>
              <td className="c">{e.level ? <LevelPill level={e.level} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CauseList({ causes, fallback }: { causes?: CauseScore[]; fallback?: string[] }) {
  const list = causes?.length ? causes : (fallback ?? []).map((c) => ({ label: c.split(' — ')[0], score: NaN, basis: c.split(' — ')[1] ?? '' }));
  if (!list.length) return <div className="small muted">원인 후보 없음</div>;
  return (
    <div className="stack-sm">
      {list.map((c, i) => (
        <div key={c.label + i} className="alert-cause">
          <div className="row-between small" style={{ flexWrap: 'nowrap' }}>
            <strong>{c.label}</strong>
            <span className="num xs muted nowrap">{Number.isFinite(c.score) ? `근거 강도 ${c.score}` : ''}</span>
          </div>
          {Number.isFinite(c.score) ? <div className="alert-cause-bar"><span style={{ width: `${Math.max(2, c.score)}%`, opacity: i === 0 ? 1 : 0.55 }} /></div> : null}
          <div className="xs muted">{c.basis}</div>
        </div>
      ))}
      <div className="xs muted">근거 강도 0~100은 규칙 엔진의 데이터 근거 점수이며 확률이 아님 · 원인 후보 체계 p.47</div>
    </div>
  );
}

export function krwOrDash(v?: number): string {
  return v !== undefined && Number.isFinite(v) && v > 0 ? `${fmt.krw(v)}원` : '—';
}

export const CHANGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '승인 대기', tone: 'warning' },
  approved: { label: '승인', tone: 'dark' },
  applied: { label: '반영', tone: 'good' },
  rejected: { label: '반려', tone: 'neutral' },
  rolled_back: { label: '롤백', tone: 'neutral' },
  held: { label: '보류', tone: 'outline' },
};
export function ChangeStatusPill({ status }: { status: string }) {
  const s = CHANGE_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}
