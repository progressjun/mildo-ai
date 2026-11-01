/* MILDO Lab 화면 공용 조각 — 모델 훅 · 배지 · 승인 액션 */
import { useMemo, type ReactNode } from 'react';
import type { ApprovalLevel, ChangeRequest } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { Button, Pill } from '@/ui/primitives';
import { demoTestCards, PATTERN_SEEDS } from './data';
import {
  APPROVER_LABEL, buildPipeline, canApprove, CARD_VERDICT_META, collectCopies, discoverCandidates, judgeTestCard, KW_VERDICT_META, LANDING_LEVEL_META,
  resolveCriteria, REVIEW_LEVEL_META, reviewAll, skuEntries, TIER_META, type Candidate, type CardJudgement, type CardVerdict, type KwJudgement, type LandingMatch, type ReviewLevel,
} from './engine';
import { useLab } from './store';

/** Lab 화면 전체가 공유하는 계산 결과 */
export function useLabModel() {
  const { state } = useStore();
  const actions = useActions();
  const lab = useLab();
  const d = state.data;
  const crit = useMemo(() => resolveCriteria(lab.criteria), [lab.criteria]);
  const cards = useMemo(() => [...demoTestCards(d.today), ...lab.userCards], [d.today, lab.userCards]);
  const judgements = useMemo(() => Object.fromEntries(cards.map((c) => [c.id, judgeTestCard(c, d.today)])) as Record<string, CardJudgement>, [cards, d.today]);
  const pipeline = useMemo(() => buildPipeline(d, state.changes, crit), [d, state.changes, crit]);
  const disc = useMemo(() => discoverCandidates(d, state.changes, lab.aiCandidates, crit.targetRoas), [d, state.changes, lab.aiCandidates, crit.targetRoas]);
  const sku = useMemo(() => skuEntries(d, state.changes, crit.targetRoas), [d, state.changes, crit.targetRoas]);
  const copies = useMemo(() => collectCopies(d, cards, lab.aiCopies), [d, cards, lab.aiCopies]);
  const review = useMemo(() => reviewAll(d, copies), [d, copies]);
  const patterns = useMemo(() => [...lab.library, ...PATTERN_SEEDS], [lab.library]);
  return { state, actions, lab, d, crit, cards, judgements, pipeline, disc, sku, copies, review, patterns };
}
export type LabModel = ReturnType<typeof useLabModel>;

export function KwVerdictPill({ j, short }: { j: KwJudgement; short?: boolean }) {
  const m = KW_VERDICT_META[j.verdict];
  return <Pill tone={m.tone} icon={m.icon} title={j.basis}>{short ? m.label : j.badge}</Pill>;
}
export function CardVerdictPill({ v, label }: { v: CardVerdict; label?: string }) {
  const m = CARD_VERDICT_META[v];
  return <Pill tone={m.tone} icon={m.icon}>{label ?? m.label}</Pill>;
}
export function ReviewPill({ level, suffix }: { level: ReviewLevel; suffix?: ReactNode }) {
  const m = REVIEW_LEVEL_META[level];
  return <Pill tone={m.tone} icon={m.icon}>{m.label}{suffix}</Pill>;
}
export function LandingPill({ l }: { l: LandingMatch }) {
  const m = LANDING_LEVEL_META[l.level];
  return <Pill tone={m.tone} title={l.notes.join(' · ')}>{l.label} · {m.label}</Pill>;
}
export function TierPill({ c }: { c: Pick<Candidate, 'tier' | 'score'> }) {
  const m = TIER_META[c.tier];
  return <Pill tone={m.tone} title="우선 ≥ 70 · 검토 ≥ 50 · 보류 < 50 (모듈 가정)">{m.label}</Pill>;
}
export function ScoreBar({ score }: { score: number }) {
  return (
    <span className="lab-score" title="우선순위 점수 (100점 만점)">
      <span className="lab-score-bar"><span style={{ width: `${Math.max(2, Math.min(100, score))}%` }} /></span>
      <strong>{Math.round(score)}</strong>
    </span>
  );
}

const STATUS_LABEL: Record<ChangeRequest['status'], string> = { pending: '승인 대기', approved: '승인', applied: '반영', rejected: '반려', rolled_back: '롤백', held: '보류' };
const STATUS_TONE: Record<ChangeRequest['status'], 'warning' | 'good' | 'neutral' | 'serious' | 'outline'> = { pending: 'warning', approved: 'neutral', applied: 'good', rejected: 'serious', rolled_back: 'outline', held: 'outline' };
export function ChangeStatusPill({ c }: { c: ChangeRequest }) {
  return <Pill tone={STATUS_TONE[c.status]} icon={c.status === 'applied' ? 'check' : c.status === 'pending' ? 'clock' : c.status === 'rejected' ? 'x' : undefined}>{STATUS_LABEL[c.status]}</Pill>;
}
export function ApproverPill({ level }: { level: ApprovalLevel }) {
  return <Pill tone={level === 'CLIENT' ? 'dark' : 'outline'} icon="users">{APPROVER_LABEL[level]}</Pill>;
}

/** 승인 · 반려 · 반영 — 역할 권한(approver vs state.role) 확인, 권한 없으면 비활성 + 이유 */
export function ChangeActions({ c, compact }: { c: ChangeRequest; compact?: boolean }) {
  const { state } = useStore();
  const { updateChange, toast } = useActions();
  const perm = canApprove(state.role, c.approver);
  const reason = perm.ok ? undefined : perm.reason;
  return (
    <div className="stack-sm" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 4 }}>
        <ChangeStatusPill c={c} />
        {!compact ? <ApproverPill level={c.approver} /> : null}
        {c.status === 'pending' ? (
          <>
            <Button size="sm" variant="primary" icon="check" disabled={!perm.ok} title={reason}
              onClick={() => { updateChange(c.id, { status: 'approved' }, '승인'); toast({ tone: 'good', title: `승인: ${c.target}`, body: 'MILDO Flow 이력에 기록했습니다', route: 'flow' }); }}>승인</Button>
            <Button size="sm" icon="x" disabled={!perm.ok} title={reason} onClick={() => updateChange(c.id, { status: 'rejected' }, '반려', 'Lab 화면에서 반려')}>반려</Button>
          </>
        ) : null}
        {c.status === 'approved' ? (
          <Button size="sm" variant="accent" icon="check" disabled={!perm.ok} title={reason}
            onClick={() => { updateChange(c.id, { status: 'applied' }, '반영'); toast({ tone: 'good', title: `반영: ${c.target}`, body: String(c.after) }); }}>반영</Button>
        ) : null}
      </div>
      {!perm.ok && (c.status === 'pending' || c.status === 'approved') ? <span className="lab-sub">{perm.reason}</span> : null}
    </div>
  );
}

export function Dl({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="lab-kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 검수 지적 표현을 원문 위에 하이라이트 */
export function Highlighted({ text, marks }: { text: string; marks: { match: string; level: ReviewLevel }[] }) {
  const spans: { start: number; end: number; level: ReviewLevel }[] = [];
  for (const m of marks) {
    if (!m.match || m.level === 'pass') continue;
    let from = 0;
    for (;;) {
      const i = text.indexOf(m.match, from);
      if (i < 0) break;
      if (!spans.some((s) => i < s.end && i + m.match.length > s.start)) spans.push({ start: i, end: i + m.match.length, level: m.level });
      from = i + m.match.length;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let pos = 0;
  spans.forEach((s, k) => {
    if (s.start > pos) out.push(text.slice(pos, s.start));
    out.push(<mark key={k} className={`lab-hl ${s.level}`}>{text.slice(s.start, s.end)}</mark>);
    pos = s.end;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}
