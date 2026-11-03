/**
 * 서버 모드 상단 바 부품 — 사용자 메뉴(이름 · 역할 · 로그아웃) · 워크스페이스 전환 · 실시간 연결 표시.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ROLE_LABEL } from '@/core/permissions';
import { Icon } from '@/ui/Icon';
import { useSaas } from './context';
import { getConnInfo, requestReconnect, subscribeConn, type ConnInfo } from './events';

/** 연결 상태 → 표시 (순수 — 단위 테스트) */
export function connLabel(c: ConnInfo): { text: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; title: string } {
  const last = c.lastEventAt ? new Date(c.lastEventAt) : null;
  const lastText = last && Number.isFinite(last.getTime()) ? ` · 마지막 이벤트 ${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}` : '';
  switch (c.status) {
    case 'live': return { text: '실시간 연결', tone: 'good', title: `다른 사용자의 변경 · 서버 감지 이슈가 바로 반영됩니다${lastText}` };
    case 'connecting': return { text: '연결 중', tone: 'neutral', title: '실시간 이벤트 채널에 연결하고 있습니다' };
    case 'reconnecting': {
      const sec = c.retryInMs ? Math.max(1, Math.round(c.retryInMs / 1000)) : null;
      return { text: sec ? `재연결 대기 ${sec}초` : '재연결 중', tone: 'warning', title: `연결이 끊겨 다시 연결합니다 (${c.attempt}회째). 누르면 바로 다시 연결합니다${lastText}` };
    }
    case 'offline': return { text: '실시간 연결 끊김', tone: 'critical', title: `서버 이벤트를 받지 못하고 있습니다. 화면 데이터가 최신이 아닐 수 있습니다. 누르면 다시 연결합니다 (${c.attempt}회 실패)${lastText}` };
    default: return { text: '오프라인', tone: 'neutral', title: '실시간 연결을 쓰지 않습니다' };
  }
}

export function ConnectionPill() {
  const info = useSyncExternalStore(subscribeConn, getConnInfo, getConnInfo);
  if (info.status === 'off') return null;
  const l = connLabel(info);
  const clickable = info.status === 'reconnecting' || info.status === 'offline';
  return (
    <button type="button" className={`pill ${l.tone} conn-pill`} title={l.title} aria-label={`${l.text}. ${l.title}`} onClick={clickable ? () => requestReconnect() : undefined} disabled={!clickable} data-conn={info.status}>
      <span className={`conn-dot ${info.status}`} aria-hidden="true" />
      {l.text}
    </button>
  );
}

export function WorkspaceSwitcher() {
  const saas = useSaas();
  const list = saas.me?.workspaces ?? [];
  if (list.length < 2 || !saas.workspace) return null;
  return (
    <label className="row small" htmlFor="workspace-select" style={{ gap: 6 }}>
      <span className="muted">워크스페이스</span>
      <select id="workspace-select" className="select" style={{ width: 'auto', padding: '4px 8px' }} value={saas.workspace.id} onChange={(e) => saas.switchWorkspace(e.target.value)}>
        {list.map((w) => <option key={w.id} value={w.id}>{w.brand_name} · {ROLE_LABEL[w.role]}</option>)}
      </select>
    </label>
  );
}

export function UserMenu() {
  const saas = useSaas();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!saas.me || !saas.workspace) return null;
  const { user } = saas.me;
  const role = saas.detail?.role ?? saas.workspace.role;
  const roleLabel = ROLE_LABEL[role];
  const initial = (user.name || user.email).trim().slice(0, 1).toUpperCase();
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" id="user-menu-button" className="user-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={`${user.name} · ${roleLabel}`}>
        <span className="user-avatar" aria-hidden="true">{initial}</span>
        <span className="user-name">{user.name}</span>
        <span className="user-role">{roleLabel}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div className="user-pop" role="menu" aria-labelledby="user-menu-button">
          <div className="user-pop-head">
            <strong>{user.name}</strong>
            <span className="xs muted num">{user.email}</span>
            <span className="xs ink2">{saas.workspace.brand_name} · {roleLabel} (화면 역할: {saas.detail?.demoRole ?? saas.workspace.demoRole})</span>
            <span className="xs muted">쓰기 · 승인 권한은 서버가 멤버십 역할로 최종 판정합니다.</span>
          </div>
          <a role="menuitem" className="user-pop-item" href="#team" onClick={() => setOpen(false)}><Icon name="users" size={14} />팀 · 권한</a>
          <button type="button" role="menuitem" className="user-pop-item" disabled={busy} onClick={async () => { setBusy(true); try { await saas.logout(); } finally { setBusy(false); setOpen(false); } }}>
            <Icon name="external" size={14} />{busy ? '로그아웃 중…' : '로그아웃'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
