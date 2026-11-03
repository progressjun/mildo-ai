import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { MODULES, MODULE_BY_ID, GROUP_LABEL, isStubModule } from '@/modules/registry';
import type { ModuleDef } from '@/modules/types';
import { navigate, useRoute } from '@/core/router';
import { useActions, useStore } from '@/core/store';
import { Icon } from '@/ui/Icon';
import { Button, Pill, Src } from '@/ui/primitives';
import { useAi } from '@/ai/useAi';
import { BACKEND_LABEL } from '@/ai/claude';
import { activeConfig, detectBulkChange, detectIncidents } from '@/modules/alert/engine';
import { seedChanges } from '@/modules/flow/engine';
import { SettingsDialog } from './SettingsDialog';
import { DemoBar } from './DemoBar';
import { Toasts } from './Toasts';
import { ModuleErrorBoundary } from './ErrorBoundary';
import { useSaas } from '@/saas/context';
import { dataTimeLabel, visibleModuleIds } from '@/saas/sync';
import { ConnectionPill, UserMenu, WorkspaceSwitcher } from '@/saas/TopbarParts';

const ICON: Record<string, string> = {
  home: 'home', agent: 'bot', board: 'board', adpilot: 'pilot', reports: 'report', watch: 'watch', lab: 'lab', geo: 'search', growth: 'trend', flow: 'flow', alert: 'bell', ops: 'users',
  impact: 'target', connections: 'link', notify: 'bell', team: 'users', audit: 'shield', workspace: 'gear',
};

export function Shell() {
  const route = useRoute();
  const { state, dispatch } = useStore();
  const actions = useActions();
  const ai = useAi();
  const saas = useSaas();
  // 서버 모드: 서버가 원본 — 클라이언트 쪽 이상 감지 · 시연 이력 적재 · 대량 변경 감지는 서버(alerts · changes 도메인)가 한다
  const serverMode = saas.mode === 'server' && !!saas.me;
  const [settings, setSettings] = useState(false);
  // 워크스페이스 설정의 사용 모듈 (config.modules) — 없으면 전부
  const visible = useMemo(() => (serverMode ? visibleModuleIds(MODULES.map((m) => m.id), saas.config, { canConfigure: saas.can('configure') }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverMode, saas.config, saas.role]);
  const routed = MODULE_BY_ID[route];
  const mod: ModuleDef = routed && (!visible || visible.has(routed.id)) ? routed : MODULE_BY_ID.home;
  const contentRef = useRef<HTMLDivElement>(null);

  // 앱 시작 시(그리고 '시연 상태 초기화' 직후) MILDO Alert 스캔 → 이슈 적재 + MILDO Flow 시연 이력 적재 (테스트 데이터 기반)
  const scanned = useRef(false);
  const emptyState = state.incidents.length === 0 && state.changes.length === 0;
  useEffect(() => {
    if (serverMode) return;
    if (scanned.current && !emptyState) return;
    scanned.current = true;
    const found = detectIncidents(state.data);
    const fresh = found.filter((f) => !state.incidents.some((i) => i.id === f.id));
    fresh.forEach((i) => actions.addIncident(i));
    const p1 = fresh.filter((i) => i.severity === 'P1' && i.status !== 'resolved');
    if (p1.length) actions.toast({ tone: 'critical', title: `P1 이슈 ${p1.length}건 감지`, body: p1.map((i) => i.title).slice(0, 2).join(' · '), route: 'alert' });
    // MILDO Flow 시연 이력(TEST DATA, 10/28~10/31) — 커맨드 센터 · Agent · Alert의 승인 대기 수가 Flow와 같아진다
    const seeds = seedChanges(state.data).filter((c) => !state.changes.some((x) => x.id === c.id));
    [...seeds].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((change) => dispatch({ type: 'change/add', change }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyState]);

  // 대량 변경 실수 감지 (p.45) — 어느 화면에서 변경을 요청 · 반영해도 MILDO Alert 이슈로 적재
  const seenBulk = useRef(new Set<string>());
  useEffect(() => {
    if (serverMode) return;
    const bulk = detectBulkChange(state.changes, { today: state.data.today, config: activeConfig(state.changes) });
    const fresh = bulk.filter((b) => !state.incidents.some((i) => i.id === b.id) && !seenBulk.current.has(b.id));
    fresh.forEach((b) => { seenBulk.current.add(b.id); actions.addIncident(b); });
    if (fresh.length) actions.toast({ tone: 'critical', title: `P1 대량 변경 실수 ${fresh.length}건 감지`, body: fresh[0].title, route: 'alert' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.changes]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    document.title = `${mod.title} · MILDO OS`;
  }, [route, mod.title]);

  const openIncidents = state.incidents.filter((i) => i.status !== 'resolved').length;
  const pendingChanges = state.changes.filter((c) => c.status === 'pending').length;
  const badges: Record<string, number> = { alert: openIncidents, flow: pendingChanges };

  const stubIds = useMemo(() => new Set(MODULES.filter(isStubModule).map((m) => m.id)), []);
  const groups = useMemo(() => {
    const g: Record<string, ModuleDef[]> = {};
    for (const m of MODULES) if (!visible || visible.has(m.id)) (g[m.group] ??= []).push(m);
    return g;
  }, [visible]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="MILDO OS 메뉴">
        <div className="brand">
          <div className="brand-mark">MILDO <span className="os">OS</span></div>
          <div className="brand-sub">{serverMode && saas.workspace ? `${saas.workspace.brand_name} · MILDO OS Cloud` : '수면밀도 전용 운영 프로그램 · Progress Media'}</div>
        </div>
        {Object.entries(groups).map(([g, list]) => (
          <div className="nav-group" key={g}>
            <div className="nav-group-label">{GROUP_LABEL[g as ModuleDef['group']]}</div>
            {list.map((m) => (
              <a key={m.id} href={`#${m.id}`} className="nav-item" aria-current={m.id === mod.id ? 'page' : undefined}>
                <Icon name={ICON[m.id] ?? 'sparkle'} size={16} />
                <span>{m.title}</span>
                {badges[m.id] ? <span className="nav-badge num">{badges[m.id]}</span> : stubIds.has(m.id) ? <span className="nav-soon">준비 중</span> : null}
              </a>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          AI 엔진 · Pro-board · AD Pilot · GFA Control v1 · VisualTune OS · SearchTuneOS
        </div>
      </nav>
      <div className="app-main">
        {state.demo.running ? <DemoBar /> : null}
        <header className="topbar">
          <div className="row" style={{ gap: 8 }}>
            <Src kind="DEMO" />
            <span className="small ink2 num">데이터 기준 {dataTimeLabel(state.data)}</span>
            {serverMode ? <ConnectionPill /> : null}
          </div>
          <div className="topbar-spacer" />
          <Pill tone={ai.connected ? 'good' : 'neutral'} icon={ai.connected ? 'check' : 'zap'}>
            {ai.backend === 'checking' ? 'AI 연결 확인 중' : (BACKEND_LABEL as Record<string, string>)[ai.backend] ?? ai.backend}
          </Pill>
          {serverMode ? (
            <>
              <WorkspaceSwitcher />
              <UserMenu />
            </>
          ) : (
            <label className="row small" htmlFor="role-select" style={{ gap: 6 }}>
              <span className="muted">역할</span>
              <select id="role-select" className="select" style={{ width: 'auto', padding: '4px 8px' }} value={state.role} onChange={(e) => dispatch({ type: 'role/set', role: e.target.value as typeof state.role })}>
                <option value="담당 AE">담당 AE</option>
                <option value="PM">PM</option>
                <option value="수면밀도">수면밀도 담당자</option>
              </select>
            </label>
          )}
          {!state.demo.running ? (
            <Button size="sm" variant="accent" icon="play" onClick={() => { dispatch({ type: 'demo/start' }); navigate('board'); }}>라이브 데모 15분</Button>
          ) : null}
          <Button size="sm" icon="gear" onClick={() => setSettings(true)}>설정</Button>
        </header>
        <main className="content" ref={contentRef} id="main">
          <ModuleErrorBoundary key={`${mod.id}:${state.resetSeq ?? 0}`} title={mod.title}>
            <Suspense fallback={<div className="page muted">불러오는 중…</div>}>
              <mod.Component />
            </Suspense>
          </ModuleErrorBoundary>
        </main>
      </div>
      {settings ? <SettingsDialog onClose={() => setSettings(false)} /> : null}
      <Toasts />
    </div>
  );
}
