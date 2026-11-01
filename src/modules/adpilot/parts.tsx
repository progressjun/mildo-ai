/* AD Pilot 화면 공용 조각 — 배지 · 값 표기 · 후보 상세 */
import type { ReactNode } from 'react';
import type { ApprovalLevel, ChangeRequest } from '@/core/types';
import { MEDIA, SA_CAMPAIGNS } from '@/data/constants';
import { fmt, hhmm } from '@/core/util';
import { Delta, Drawer, Pill, Src } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { APPROVER_LABEL, VERDICT_META, type AdPilotProposal, type KeywordDiagnosis } from './engine';
import { STATUS_LABEL, STATUS_TONE } from './useAdPilot';

export const ACTION_META: Record<AdPilotProposal['action'], { label: string; tone: 'good' | 'serious' | 'neutral' | 'outline' | 'warning'; icon: string }> = {
  bid_up: { label: '입찰 상향', tone: 'good', icon: 'up' },
  bid_down: { label: '입찰 하향', tone: 'serious', icon: 'down' },
  budget_shift: { label: '예산 조정', tone: 'neutral', icon: 'wallet' },
  test_candidate: { label: '테스트 후보', tone: 'outline', icon: 'lab' },
  hold: { label: '자동 조정 보류', tone: 'warning', icon: 'alert' },
};

export function ActionPill({ p }: { p: AdPilotProposal }) {
  const m = p.ruleId === 'brand' && p.action === 'bid_up' ? { label: '방어 상향', tone: 'good' as const, icon: 'shield' } : ACTION_META[p.action];
  return <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>;
}

export function ApproverPill({ level, title }: { level: ApprovalLevel; title?: string }) {
  return <Pill tone={level === 'CLIENT' ? 'dark' : 'outline'} icon={level === 'CLIENT' ? 'shield' : 'users'} title={title}>{APPROVER_LABEL[level]}</Pill>;
}

export function StatusPill({ status }: { status: ChangeRequest['status'] | 'none' }) {
  const icon = status === 'applied' ? 'check' : status === 'rolled_back' ? 'rollback' : status === 'pending' ? 'clock' : status === 'held' ? 'pause' : status === 'rejected' ? 'x' : status === 'approved' ? 'check' : undefined;
  return <Pill tone={STATUS_TONE[status]} icon={icon}>{STATUS_LABEL[status]}</Pill>;
}

export function VerdictPill({ d }: { d: Pick<KeywordDiagnosis, 'verdict'> }) {
  const m = VERDICT_META[d.verdict];
  return <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>;
}

/** 현재 → 제안 표기 */
export function BeforeAfter({ p }: { p: AdPilotProposal }) {
  if (p.action === 'hold') return <span className="muted small">{p.unit === 'won' && p.before > 0 ? `${fmt.won(p.before)} 유지` : '조정 없음'}</span>;
  if (p.action === 'test_candidate') return <span className="small nowrap">신규 <span className="adpilot-arrow">→</span><strong className="num">{fmt.won(p.after)}</strong></span>;
  const f = p.unit === 'budget' ? fmt.krw : fmt.won;
  return (
    <span className="small nowrap num">
      {f(p.before)}<span className="adpilot-arrow">→</span><strong>{f(p.after)}</strong>{' '}
      <Delta pct={p.changePct} />
    </span>
  );
}

export function targetSub(p: AdPilotProposal): string {
  if (p.targetType === 'campaign' || p.targetType === 'media') return MEDIA[p.media].name + (p.donor ? ` · 재원 ${p.donor.name}` : '');
  if (p.intent) return `${MEDIA.naver_sa.short} · ${SA_CAMPAIGNS[p.intent].name}`;
  return MEDIA[p.media].name;
}

export function Dl({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="adpilot-dl">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 후보 상세 드로어 — 근거 · SAFETY · 원인 후보 · 시뮬레이션 · 변경 이력 */
export function ProposalDrawer({ p, change, onClose, actions }: { p: AdPilotProposal; change?: ChangeRequest; onClose: () => void; actions?: ReactNode }) {
  return (
    <Drawer title={<span className="row" style={{ gap: 8 }}><ActionPill p={p} />{p.keyword}</span>} onClose={onClose}>
      <div className="row" style={{ gap: 6 }}>
        <Src kind="PROPOSAL" page="p.14" /><Src kind="DEMO" />
        <span className="xs muted">{p.rule} · {targetSub(p)}</span>
      </div>
      <Dl items={[
        ['현재 → 제안', <BeforeAfter key="ba" p={p} />],
        ['판정 근거', <span key="b" className="small">{p.basis}</span>],
        ['승인 주체', <span key="a" className="row" style={{ gap: 6 }}><ApproverPill level={p.approver} /><span className="xs muted">{p.approverReason}</span></span>],
        ['상태', <StatusPill key="s" status={change?.status ?? 'none'} />],
      ]} />
      <div className="stack-sm">
        <strong className="small">왜</strong>
        <p className="small">{p.reason}</p>
      </div>
      <div className="stack-sm">
        <strong className="small">예상 효과</strong>
        <p className="small">{p.expected}</p>
        {p.sim ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>일 기준</th><th className="r">현재</th><th className="r">변경 후 (가정)</th><th className="r">증감</th></tr></thead>
              <tbody>
                <tr><td>클릭</td><td className="r">{fmt.dec1(p.sim.base.clicks)}</td><td className="r">{fmt.dec1(p.sim.projected.clicks)}</td><td className="r"><Delta pct={p.sim.delta.clicksPct} /></td></tr>
                <tr><td>비용</td><td className="r">{fmt.won(p.sim.base.cost)}</td><td className="r">{fmt.won(p.sim.projected.cost)}</td><td className="r"><Delta pct={p.sim.delta.costPct} invert /></td></tr>
                <tr><td>전환</td><td className="r">{p.sim.base.conversions.toFixed(2)}</td><td className="r">{p.sim.projected.conversions.toFixed(2)}</td><td className="r"><Delta pct={p.sim.delta.convPct} /></td></tr>
                <tr><td>ROAS</td><td className="r">{fmt.roas(p.sim.base.roas)}</td><td className="r">{fmt.roas(p.sim.projected.roas)}</td><td className="r">증분 {fmt.roas(p.sim.incrementalRoas)}</td></tr>
              </tbody>
            </table>
          </div>
        ) : null}
        {p.sim ? <div className="xs muted">가정: 클릭 탄력성 {p.sim.assumptions.clickElasticity} · CPC 탄력성 {p.sim.assumptions.cpcElasticity} · CVR 불변{p.sim.clickCapped ? ' · 노출 손실분 회수 상한 적용' : ''}. 실측 아님 — 반영 후 7일 실측으로 검증.</div> : null}
      </div>
      <div className="stack-sm">
        <strong className="small">SAFETY 점검</strong>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {p.guard.map((g) => <li key={g}>{g}</li>)}
        </ul>
      </div>
      {p.suppressed ? (
        <div className="stack-sm">
          <strong className="small">보류 전 원래 제안</strong>
          <p className="small">{ACTION_META[p.suppressed.action].label} {(p.unit === 'budget' ? fmt.krw : fmt.won)(p.suppressed.before)} → {(p.unit === 'budget' ? fmt.krw : fmt.won)(p.suppressed.after)} ({fmt.delta(p.suppressed.changePct)}) — 이슈 해결 · 보류 해제 승인 후 다시 판정합니다.</p>
        </div>
      ) : null}
      {p.linkedIncidents?.length ? (
        <div className="stack-sm">
          <strong className="small">MILDO Alert 연계 이슈</strong>
          {p.linkedIncidents.map((l) => (
            <div key={l.id} className="row small" style={{ gap: 6 }}>
              <Pill tone={l.severity === 'P1' ? 'critical' : l.severity === 'P2' ? 'warning' : 'neutral'} icon="alert">{l.severity}</Pill>
              <span>{l.title}{l.isTest ? ' · 테스트 이슈' : ''}</span>
              <span className="xs muted">{l.id}</span>
            </div>
          ))}
          <a className="xs" href="#alert">MILDO Alert 이슈 큐에서 조치 상태 보기 →</a>
        </div>
      ) : null}
      {p.causes?.length ? (
        <div className="stack-sm">
          <strong className="small">원인 후보 (데이터 근거 순위 · p.47)</strong>
          {p.causes.map((c, i) => (
            <div key={c.cause} className="row-between small" style={{ flexWrap: 'nowrap' }}>
              <span><Pill tone={i === 0 ? 'warning' : 'neutral'}>{i === 0 ? '1순위' : `${i + 1}순위`}</Pill> {c.cause}</span>
              <span className="xs muted" style={{ textAlign: 'right' }}>{c.evidence} · 점수 {c.score}</span>
            </div>
          ))}
        </div>
      ) : null}
      {change ? (
        <div className="stack-sm">
          <strong className="small">변경 이력 (누가 · 언제 · 왜)</strong>
          {change.history.map((h, i) => (
            <div key={i} className="xs" style={{ display: 'grid', gridTemplateColumns: '44px 72px 1fr', gap: 8 }}>
              <span className="num muted">{hhmm(h.at)}</span><strong>{h.by}</strong><span>{h.action}{h.note ? ` — ${h.note}` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
      {actions ? <div className="row" style={{ justifyContent: 'flex-end' }}>{actions}</div> : null}
    </Drawer>
  );
}

export function LevelPill({ level, children }: { level: 'ok' | 'info' | 'warn' | 'critical'; children: ReactNode }) {
  const tone = level === 'critical' ? 'critical' : level === 'warn' ? 'warning' : level === 'info' ? 'neutral' : 'good';
  const icon = level === 'critical' || level === 'warn' ? 'alert' : 'check';
  return <Pill tone={tone} icon={icon}>{children}</Pill>;
}

export function InlineIcon({ name }: { name: string }) {
  return <Icon name={name} size={13} />;
}
