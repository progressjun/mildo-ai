/* ops 화면 공용 하위 컴포넌트 */
import type { ReactNode } from 'react';
import { Pill } from '@/ui/primitives';
import type { BackupGraph, CheckLevel, LeaveResult, TfRow } from './engine';

export const LEVEL_UI: Record<CheckLevel, { tone: 'critical' | 'warning' | 'good' | 'neutral'; label: string; icon: string }> = {
  fail: { tone: 'critical', label: '실패', icon: 'x' },
  warn: { tone: 'warning', label: '주의', icon: 'alert' },
  pass: { tone: 'good', label: '통과', icon: 'check' },
  info: { tone: 'neutral', label: '참고', icon: 'sparkle' },
};
export function LevelPill({ level, children }: { level: CheckLevel; children?: ReactNode }) {
  const u = LEVEL_UI[level];
  return <Pill tone={u.tone} icon={u.icon}>{children ?? u.label}</Pill>;
}

/** 입력 상태 배지: 미입력 n / 완료 */
export function InputFlag({ missing, label = '미입력' }: { missing: number; label?: string }) {
  return missing > 0 ? <Pill tone="warning" icon="edit">{label} {missing}</Pill> : <Pill tone="good" icon="check">입력 완료</Pill>;
}

/* ---------- 1:1 백업 그래프 ---------- */

const POS: Record<string, { x: number; y: number }> = {
  pm: { x: 330, y: 44 },
  sa_lead: { x: 110, y: 160 }, sa_ae: { x: 110, y: 272 },
  da_ae: { x: 330, y: 160 }, global_ae: { x: 330, y: 272 },
  analyst: { x: 550, y: 160 }, dev: { x: 550, y: 272 },
};
const NW = 168;
const NH = 48;

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, bend: number) {
  // 노드 경계에서 시작 · 끝나도록 단순 보정 (세로 · 대각 위주)
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const off = (u: number, v: number) => {
    const tx = Math.abs(u) > 1e-6 ? (NW / 2) / Math.abs(u) : Infinity;
    const ty = Math.abs(v) > 1e-6 ? (NH / 2) / Math.abs(v) : Infinity;
    return Math.min(tx, ty) + 4;
  };
  const s = off(ux, uy);
  const sx = a.x + ux * s, sy = a.y + uy * s;
  const ex = b.x - ux * (s + 4), ey = b.y - uy * (s + 4);
  const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
  return { d: `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`, mx, my };
}

export function BackupGraphSvg({ rows, graph, sim }: { rows: TfRow[]; graph: BackupGraph; sim?: LeaveResult | null }) {
  const gapIds = new Set(graph.issues.filter((i) => i.level === 'gap').map((i) => i.memberId));
  const member = (id: string) => sim?.members.find((m) => m.id === id);
  const activeEdges = new Set<string>();
  for (const t of sim?.transfers ?? []) {
    for (let i = 0; i < t.path.length - 1; i++) activeEdges.add(`${t.path[i]}>${t.path[i + 1]}`);
  }
  const fallbackFrom = new Set((sim?.gaps ?? []).filter((g) => g.fallbackId).map((g) => g.fromId));
  const known = rows.filter((r) => POS[r.id]);
  return (
    <div className="ops-graph">
      <div className="ops-graph-scroll">
      <svg viewBox="0 0 660 310" role="img" aria-label={`1:1 백업 그래프: ${rows.map((r) => `${r.role} → ${r.backupRole}`).join(', ')}`}>
        <defs>
          <marker id="ops-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-2)" />
          </marker>
          <marker id="ops-arrow-on" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--ink)" />
          </marker>
        </defs>
        {graph.edges.filter((e) => e.valid && POS[e.from] && POS[e.to]).map((e) => {
          const on = activeEdges.has(`${e.from}>${e.to}`);
          const p = edgePath(POS[e.from], POS[e.to], e.mutual ? 22 : 0);
          return (
            <path key={`${e.from}-${e.to}`} d={p.d} fill="none" stroke={on ? 'var(--ink)' : 'var(--ink-2)'} strokeWidth={on ? 3 : 1.6}
              strokeDasharray={e.mutual ? undefined : '5 4'} markerEnd={`url(#${on ? 'ops-arrow-on' : 'ops-arrow'})`} opacity={sim && !on ? 0.45 : 1} />
          );
        })}
        {[...fallbackFrom].filter((id) => POS[id] && POS.pm && id !== 'pm').map((id) => {
          const p = edgePath(POS[id], POS.pm, -30);
          return <path key={`fb-${id}`} d={p.d} fill="none" stroke="var(--critical)" strokeWidth={2.4} strokeDasharray="2 4" markerEnd="url(#ops-arrow-on)" />;
        })}
        {known.map((r) => {
          const p = POS[r.id];
          const m = member(r.id);
          const absent = !!m?.absent;
          const over = !!m?.overload;
          const gap = gapIds.has(r.id) || (sim?.gaps ?? []).some((g) => g.fromId === r.id);
          const incoming = m?.incoming.reduce((s, x) => s + x.alloc, 0) ?? 0;
          const stroke = over || gap ? 'var(--critical)' : incoming > 0 ? 'var(--ink)' : 'var(--line-strong)';
          const tag = absent ? (gap ? '부재 · 공백' : '부재') : over ? `과부하 ${Math.round(m!.load)}%` : incoming > 0 ? `인수 +${Math.round(incoming)}%` : gap ? '백업 공백' : '';
          const tagColor = over || gap ? 'var(--critical-ink)' : 'var(--ink-2)';
          // 왼쪽 열은 총괄 PM에서 오는 화살표가 오른쪽 위로 들어오므로 태그를 왼쪽 위에 둔다 (화살촉과 겹침 방지)
          const tagLeft = p.x < 200;
          return (
            <g key={r.id} opacity={absent ? 0.55 : 1}>
              <rect x={p.x - NW / 2} y={p.y - NH / 2} width={NW} height={NH} rx={10} fill={r.id === 'pm' ? 'var(--surface-2)' : 'var(--surface)'}
                stroke={stroke} strokeWidth={over || gap || incoming > 0 ? 2.2 : 1.2} strokeDasharray={absent ? '4 3' : undefined} />
              <text x={p.x} y={p.y - 4} textAnchor="middle" className="ops-node-title">{r.role}</text>
              <text x={p.x} y={p.y + 13} textAnchor="middle" className="ops-node-sub">{r.name || '[성명]'}{r.allocation !== null && !r.invalid.allocation ? ` · ${r.allocation}%` : ''}</text>
              {tag ? <text x={tagLeft ? p.x - NW / 2 : p.x + NW / 2} y={p.y - NH / 2 - 6} textAnchor={tagLeft ? 'start' : 'end'} className="ops-node-tag" style={{ fill: tagColor }}>{tag}</text> : null}
            </g>
          );
        })}
      </svg>
      </div>
      <div className="ops-legend">
        <span><i />상호 백업 (실선)</span>
        <span><i className="dash" />단방향 백업 (점선)</span>
        <span><i className="bold" />부재 시 인수 경로</span>
        <span>화살표 방향: 본인 → 백업 (부재 시 업무가 넘어가는 방향)</span>
      </div>
    </div>
  );
}
