/* MILDO Lab 화면 공용 조각 — 모델 훅 · 배지 · 승인 액션 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ApprovalLevel, ChangeRequest } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { actorLabel, approvalScopeText, isMemberActor, type Actor, type ChangeAction } from '@/core/permissions';
import { useSaas } from '@/saas/context';
import { Button, Pill } from '@/ui/primitives';
import { demoTestCards, PATTERN_SEEDS, SCORE_WEIGHTS } from './data';
import {
  APPROVER_LABEL, buildPipeline, canApprove, CARD_VERDICT_META, labCanRequest, labPermission, collectCopies, discoverCandidates, judgeTestCard, KW_VERDICT_META, LANDING_LEVEL_META,
  reconcileLab, resolveCriteria, REVIEW_LEVEL_META, reviewAll, skuEntries, TIER_META, type Candidate, type CardJudgement, type CardVerdict, type KwJudgement, type LandingMatch, type ReviewLevel,
} from './engine';
import { resetLab, useLab } from './store';

/**
 * 연속 클릭 방지 — 요청을 만든 직후 목록이 다시 그려지면 같은 자리에 다른 후보 · 이벤트의 버튼이 들어온다.
 * 더블클릭의 두 번째 클릭이 그 버튼을 누르지 않도록, 요청을 실제로 만든 호출 뒤 ms 안의 다음 호출은 무시한다.
 * fn이 false를 돌려주면(확인 단계 표시 · 차단 등 아무것도 만들지 않음) 잠그지 않는다.
 */
export function useClickGuard(ms = 500) {
  const last = useRef(0);
  return <A extends unknown[]>(fn: (...a: A) => unknown) => (...a: A) => {
    if (Date.now() - last.current < ms) return;
    if (fn(...a) !== false) last.current = Date.now();
  };
}

/**
 * 권한 판정 주체 · 요청 권한 — 데모: 데모 3역할(역할 선택, 기존 규칙), 서버: 멤버십 역할(서버와 같은 권한표 · 전이별 판정).
 * 서버 모드에서 역할을 모르면(워크스페이스 정보 전) 열람자로 본다 — 서버가 거절할 버튼을 켜지 않게.
 */
export function useLabPerms() {
  const { state } = useStore();
  const saas = useSaas();
  const server = saas.mode === 'server';
  const member = saas.role;
  const actor = useMemo<Actor>(() => (server ? { member: member ?? 'viewer' } : state.role), [server, member, state.role]);
  const request = useMemo(() => labCanRequest(actor), [actor]);
  return {
    actor, server, roleLabel: actorLabel(actor), request,
    /** 서버 모드 승인 범위 문구 ('담당 AE · PM' · '없음') — 데모는 빈 문자열 */
    scope: isMemberActor(actor) ? approvalScopeText(actor.member) : '',
    check: (approver: ApprovalLevel, action: ChangeAction) => labPermission(actor, approver, action),
  };
}
export type LabPerms = ReturnType<typeof useLabPerms>;

/** Lab 화면 전체가 공유하는 계산 결과 */
export function useLabModel() {
  const perms = useLabPerms();
  const { state } = useStore();
  const actions = useActions();
  const raw = useLab();
  // 승인 이력과 맞춘 로컬 기록 (반려 · 롤백된 결정은 무효, 시연 상태 초기화로 이력이 지워진 사용자 카드 · 결정은 숨김)
  const lab = useMemo(() => ({ ...raw, ...reconcileLab(raw, state.changes) }), [raw, state.changes]);
  // 설정 '시연 상태 초기화' 직후(승인 이력 · 이슈가 모두 비는 순간) Lab 로컬 기록도 처음 상태로
  const emptyGlobal = state.changes.length === 0 && state.incidents.length === 0;
  useEffect(() => { if (emptyGlobal) resetLab(); }, [emptyGlobal]);
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
  return { state, actions, lab, d, crit, cards, judgements, pipeline, disc, sku, copies, review, patterns, perms };
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
  const basis = c.tier === 'priority' ? `≥ ${SCORE_WEIGHTS.priority}` : c.tier === 'review' ? `≥ ${SCORE_WEIGHTS.review}` : `< ${SCORE_WEIGHTS.review}`;
  return <Pill tone={m.tone} title={`우선 ≥ ${SCORE_WEIGHTS.priority} · 검토 ≥ ${SCORE_WEIGHTS.review} · 보류 < ${SCORE_WEIGHTS.review} (모듈 가정)`}>{m.label} · {basis}</Pill>;
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
  const { updateChange, toast } = useActions();
  const perms = useLabPerms();
  // 데모: 승인 범위 하나로 승인 · 반려 · 반영. 서버: 반영은 운영 권한도 필요 (광고주 담당자는 승인 · 반려까지)
  const perm = c.status === 'approved' ? perms.check(c.approver, 'apply') : canApprove(perms.actor, c.approver);
  const reason = perm.ok ? undefined : perm.reason;
  // 승인 직후 같은 자리에 '반영' 버튼이 나타난다 — 더블클릭이 승인 + 반영으로 이어지지 않게
  const guard = useClickGuard();
  return (
    <div className="stack-sm" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 4 }}>
        <ChangeStatusPill c={c} />
        {!compact ? <ApproverPill level={c.approver} /> : null}
        {c.status === 'pending' ? (
          <>
            <Button size="sm" variant="primary" icon="check" disabled={!perm.ok} title={reason}
              onClick={guard(() => { updateChange(c.id, { status: 'approved' }, '승인'); toast({ tone: 'good', title: `승인: ${c.target}`, body: 'MILDO Flow 이력에 기록했습니다', route: 'flow' }); })}>승인</Button>
            <Button size="sm" icon="x" disabled={!perm.ok} title={reason} onClick={guard(() => updateChange(c.id, { status: 'rejected' }, '반려', 'Lab 화면에서 반려'))}>반려</Button>
          </>
        ) : null}
        {c.status === 'approved' ? (
          <Button size="sm" variant="accent" icon="check" disabled={!perm.ok} title={reason}
            onClick={guard(() => {
              updateChange(c.id, { status: 'applied' }, '반영');
              // 서버 모드: 서버가 실행 점검 후 반영(dry_run · live)하거나 보류한다 — 보냈다는 사실만 알린다
              if (perms.server) toast({ tone: 'info', title: `반영 요청을 보냈습니다: ${c.target}`, body: `${String(c.after)} · 서버 실행 점검 · 매체 반영 결과는 MILDO Flow에서 이어서 알립니다`, route: 'flow' });
              else toast({ tone: 'good', title: `반영: ${c.target}`, body: String(c.after) });
            })}>반영</Button>
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
