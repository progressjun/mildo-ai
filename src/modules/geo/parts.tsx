/* SearchTuneOS 하위 공용 컴포넌트 — 판정 배지는 항상 기준값을 옆에 보여준다 (SPEC §0) */
import type { IntentId } from '@/core/types';
import { Pill, type Tone } from '@/ui/primitives';
import { CITE_LABEL, GEO_ROUNDS } from './data';
import { INTENT_LABEL, STATUS_LABEL, type CheckStatus, type GeoCell, type LiveRecord, type ReviewHit, type Verdict } from './engine';

const ICON_BY_TONE: Partial<Record<Tone, string>> = { good: 'check', warning: 'alert', serious: 'alert', critical: 'alert' };

export function VerdictBadge({ v, inline = false, hideBasis = false }: { v: Verdict; inline?: boolean; hideBasis?: boolean }) {
  return (
    <span className={`geo-badge${inline ? ' row' : ''}`}>
      <Pill tone={v.tone as Tone} icon={ICON_BY_TONE[v.tone as Tone]}>{v.label}</Pill>
      {hideBasis ? null : <span className="geo-basis">{v.basis}</span>}
    </span>
  );
}

const STATUS_TONE: Record<CheckStatus, Tone> = { pass: 'good', warn: 'warning', fail: 'critical', na: 'outline' };
export function StatusPill({ status }: { status: CheckStatus }) {
  return <Pill tone={STATUS_TONE[status]} icon={status === 'pass' ? 'check' : status === 'na' ? undefined : 'alert'}>{STATUS_LABEL[status]}</Pill>;
}

export function IntentPill({ intent }: { intent: IntentId }) {
  return <Pill tone="outline">{INTENT_LABEL[intent]}</Pill>;
}

/** 매트릭스 셀 — 언급 순서 · 경쟁사 수 · 최근 4회 언급 횟수 */
export function EngineCell({ cell, rounds }: { cell?: GeoCell; rounds?: number }) {
  if (!cell) return <span className="geo-cell">—</span>;
  const title = [
    cell.mentioned ? `수면밀도 ${cell.position}번째 언급` : '수면밀도 미언급',
    cell.order.length ? `등장 순서: ${cell.order.join(' → ')}` : '브랜드 언급 없음',
    cell.citations.length ? `인용: ${cell.citations.map((c) => `${CITE_LABEL[c.domain] ?? c.domain}${c.owned ? '(자사)' : ''}`).join(', ')}` : '인용 없음',
    rounds !== undefined ? `최근 ${GEO_ROUNDS}회 중 ${rounds}회 언급` : '',
  ].filter(Boolean).join('\n');
  const cls = cell.mentioned ? (cell.position === 1 ? 'geo-cell first' : 'geo-cell on') : 'geo-cell';
  return (
    <span className={cls} title={title} aria-label={title.replace(/\n/g, ' · ')}>
      {cell.mentioned ? `${cell.position}번째` : '—'}
      {cell.competitors.length ? <span className="c">· 경{cell.competitors.length}</span> : null}
      {rounds !== undefined ? <span className="c">· {rounds}/{GEO_ROUNDS}</span> : null}
    </span>
  );
}

export function LiveCell({ rec }: { rec?: LiveRecord }) {
  if (!rec) return <span className="geo-cell live" title="Claude 라이브 진단 전">미진단</span>;
  const title = `${rec.mentioned ? `수면밀도 ${rec.position}번째 언급` : rec.ambiguous ? `단독 '밀도' ${rec.ambiguous}회 · 확인 필요` : '수면밀도 미언급'} · 등장 순서 ${rec.order.join(' → ') || '없음'}`;
  const cls = rec.mentioned ? (rec.position === 1 ? 'geo-cell live first' : 'geo-cell live on') : rec.ambiguous ? 'geo-cell live amb' : 'geo-cell live';
  return (
    <span className={cls} title={title}>
      {rec.mentioned ? `${rec.position}번째` : rec.ambiguous ? '확인' : '—'}
      {rec.competitors.length ? <span className="c">· 경{rec.competitors.length}</span> : null}
    </span>
  );
}

export function ReviewHits({ hits, showCheck = false }: { hits: ReviewHit[]; showCheck?: boolean }) {
  const shown = hits.filter((h) => showCheck || h.level !== 'check');
  if (!shown.length) return null;
  return (
    <div className="stack-sm" style={{ gap: 3 }}>
      {shown.map((h, i) => (
        <div key={`${h.ruleId}-${h.match}-${i}`} className="geo-hit">
          <Pill tone={h.level === 'block' ? 'critical' : h.level === 'warn' ? 'warning' : 'neutral'} icon={h.level === 'check' ? undefined : 'alert'}>{h.level === 'block' ? '차단' : h.level === 'warn' ? '경고' : '확인'} · '{h.match}'</Pill>
          <span className="muted">{h.reason}</span>
          {h.fix ? <span>→ {h.fix}</span> : null}
        </div>
      ))}
    </div>
  );
}
