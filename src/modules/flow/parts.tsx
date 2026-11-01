/* MILDO Flow 공용 조각 — 상태 배지 · 판정 배지(기준값 병기) · 2단계 확인 버튼 */
import { useState, type ReactNode } from 'react';
import type { ApprovalLevel, ChangeRequest } from '@/core/types';
import { fmt } from '@/core/util';
import { Icon } from '@/ui/Icon';
import { Button, Pill } from '@/ui/primitives';
import { GFA_DELEGATION } from '@/data/constants';
import { MODULE_ROUTE, STATUS_META, type FlowStatus } from './data';
import { APPROVER_LABEL, delegationIndexByPct, fmtValue, isSeed, kindLabel, moduleLabel, type CheckLevel, type LeadState } from './engine';

export function StatusPill({ status }: { status: FlowStatus }) {
  const m = STATUS_META[status];
  return <Pill tone={m.tone} icon={m.icon} title={m.desc}>{m.label}</Pill>;
}

const LEVEL_META: Record<CheckLevel, { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; icon: string }> = {
  pass: { label: '통과', tone: 'good', icon: 'check' },
  warn: { label: '주의', tone: 'warning', icon: 'alert' },
  fail: { label: '실패', tone: 'critical', icon: 'x' },
  info: { label: '참고', tone: 'neutral', icon: 'sparkle' },
};
export function LevelPill({ level }: { level: CheckLevel }) {
  const m = LEVEL_META[level];
  return <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>;
}
export const levelLabel = (l: CheckLevel) => LEVEL_META[l].label;

/** 승인 주체 배지 — 근거(위임 범위)를 같이 보여준다 */
export function ApproverBadge({ c }: { c: Pick<ChangeRequest, 'approver' | 'changePct' | 'kind'> }) {
  const pct = c.changePct;
  const pctBased = (c.kind === 'budget' || c.kind === 'bid') && pct !== undefined && Number.isFinite(pct);
  const basis = pctBased ? GFA_DELEGATION[delegationIndexByPct(pct!)].range.split(' · ')[0] : undefined;
  return (
    <span className="flow-approver" title={basis ? `위임 범위 ${basis} (p.15)` : undefined}>
      <Icon name="shield" size={11} />승인 {APPROVER_LABEL[c.approver as ApprovalLevel]}{basis ? <span className="muted"> · {basis}</span> : null}
    </span>
  );
}

export function ModuleTag({ module }: { module: string }) {
  return <a className="flow-module" href={`#${MODULE_ROUTE[module] ?? module}`} onClick={(e) => e.stopPropagation()}>{moduleLabel(module)}</a>;
}

export function SeedTag({ c }: { c: Pick<ChangeRequest, 'id'> }) {
  return isSeed(c) ? <span className="flow-seed" title="시연용 이력 · TEST DATA (다른 모듈 계산에 영향 없음)">시연 이력</span> : null;
}

export function ChangeValue({ c }: { c: ChangeRequest }) {
  const pct = c.changePct;
  return (
    <span className="flow-change num">
      <span className="muted">{fmtValue(c, c.before)}</span>
      <Icon name="chevron" size={11} />
      <strong>{fmtValue(c, c.after)}</strong>
      {pct !== undefined && Number.isFinite(pct) ? <span className={pct > 0 ? 'delta-up' : pct < 0 ? 'delta-down' : 'delta-flat'}> {fmt.delta(pct)}</span> : null}
      <span className="muted"> · {kindLabel(c.kind)}</span>
    </span>
  );
}

export function LeadBadge({ l, compact }: { l: LeadState; compact?: boolean }) {
  if (l.decidedMs !== null) {
    return <Pill tone={l.met === false ? 'serious' : 'outline'} icon="clock" title={l.text}>{compact ? `결정 ${l.text.replace(/^결정 /, '').split(' · ')[0]}` : l.text}</Pill>;
  }
  if (l.overdue) return <Pill tone="critical" icon="clock" title={l.text}>기준 초과 · {l.label}</Pill>;
  return <Pill tone="outline" icon="clock" title={l.text}>{compact ? l.text.split(' · ')[0] : l.text}</Pill>;
}

/** 화면 안 2단계 확인 버튼 (window.confirm 대신) */
export function ConfirmButton({ label, confirmLabel, onConfirm, icon, variant = 'default', disabled, title, size = 'sm' }: {
  label: ReactNode; confirmLabel?: ReactNode; onConfirm: () => void; icon?: string; variant?: 'default' | 'primary' | 'accent' | 'danger' | 'ghost'; disabled?: boolean; title?: string; size?: 'sm' | 'lg';
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button size={size} icon={icon} variant={variant === 'danger' ? 'default' : variant} disabled={disabled} title={title} onClick={() => setArmed(true)}>{label}</Button>;
  return (
    <span className="row" style={{ gap: 4 }}>
      <Button size={size} variant={variant === 'default' ? 'primary' : variant} icon="check" onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel ?? <>확인 · {label}</>}</Button>
      <Button size={size} variant="ghost" onClick={() => setArmed(false)}>취소</Button>
    </span>
  );
}

export function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flow-kv">
      <span className="muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}
