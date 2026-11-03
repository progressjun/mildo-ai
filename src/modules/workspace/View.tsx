/**
 * 워크스페이스 설정 (07 관리 · 연동) — 브랜드 · 예산 배분 · 목표 · SAFETY · 위임 범위 · 데이터 시간표 · SLA · 감지 기준 · 공휴일 · 당번 ·
 * 사용 모듈 · AI 사용량 · 한도 · 성과 증명 기준.
 * 항목마다 기본값(제안서 · RFP 기준)과 워크스페이스 값을 나란히 보여 주고 '기본값으로' 되돌릴 수 있다. 저장 전 변경 미리보기 · 변경 이력.
 *
 * 서버 모드: GET/PUT /api/w/:ws/config · /config/history · /config/onboarding · POST /config/review (server/src/settings),
 *   AI 사용량은 GET /api/w/:ws/ai/usage (ai 도메인 · fetchServerAiUsage).
 *   저장에 성공하면 applyWorkspaceConfig로 이 브라우저의 엔진 기준을 바로 바꾸고 워크스페이스 정보를 다시 읽는다(메뉴 · 다른 화면).
 *   다른 관리자가 저장하면(SSE 'config') 편집 중이 아닐 때 다시 읽고, 편집 중이면 안내만 한다(버전 충돌은 서버가 409로 막는다).
 * 데모 모드: 기본값을 읽기 전용으로 보여 주고, 서버 연결 시 실제로 저장된다고 안내한다(이력 · 온보딩은 TEST DATA 예시).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { Button, Callout, Card, Empty, Modal, PageHeader, Pill, Src, Stat, Tabs } from '@/ui/primitives';
import { useActions } from '@/core/store';
import { useSaas } from '@/saas/context';
import { onServerEvent } from '@/saas/events';
import { ApiError } from '@/saas/api';
import { fmt } from '@/core/util';
import {
  applyWorkspaceConfig, configFieldLabel, DEFAULT_CONFIG, getPath, leafPaths, mergeConfig, removeOverride, setOverride, type ConfigIssue, type WorkspaceConfig,
} from '@/data/config';
import {
  allocationRows, demoAiUsage, demoHistory, demoOnboarding, demoState, draftIssues, fmtKst, HISTORY_ACTION_LABEL, historyChangeText, overrideCount, previewChanges,
  type AiUsageState, type ConfigState, type HistoryEntry, type OnboardingState,
} from './model';
import * as remote from './api';
import type { FormCtx } from './Fields';
import { AiSection, BrandSection, BudgetSection, DelegationSection, DetectSection, ImpactSection, ModulesSection, SlaSection, TargetsSection, TimetableSection } from './Sections';

export type WsTab = 'brand' | 'budget' | 'targets' | 'approval' | 'timetable' | 'detect' | 'modules' | 'ai' | 'impact' | 'history';

const TAB_PREFIXES: Record<Exclude<WsTab, 'history'>, string[]> = {
  brand: ['brand', 'brandKeywords', 'sku'],
  budget: ['budget'],
  targets: ['targets', 'safety'],
  approval: ['delegation'],
  timetable: ['timetable', 'sla'],
  detect: ['anomalyThresholds', 'holidays', 'onDuty', 'tf', 'offHoursMode'],
  modules: ['modules'],
  ai: ['ai'],
  impact: ['billing', 'impact'],
};
const TAB_LABEL: Record<WsTab, string> = {
  brand: '브랜드 · SKU', budget: '예산 배분', targets: '목표 · SAFETY', approval: '위임 범위', timetable: '데이터 시간표 · SLA',
  detect: '감지 · 공휴일 · 당번', modules: '사용 모듈', ai: 'AI 사용량 · 한도', impact: '성과 증명 기준', history: '변경 이력',
};

export interface WorkspaceHandlers {
  onDraft: (next: WorkspaceConfig) => void;
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
  onReview: () => void;
  onReload: () => void;
  onMoreHistory: () => void;
  onReloadUsage?: () => void;
}

export interface WorkspaceScreenProps {
  mode: 'demo' | 'server';
  workspaceName: string;
  state: ConfigState | null;
  draft: WorkspaceConfig;
  canConfigure: boolean;
  /** 소유자 권한 — 월 구독료(billing.*)는 소유자만 바꾼다 */
  canOwner?: boolean;
  /** 서버 워크스페이스의 브랜드명(workspaces.brand_name) — 설정의 브랜드명과 다르면 안내 */
  workspaceBrand?: string;
  history: HistoryEntry[] | null;
  hasMoreHistory: boolean;
  onboarding: OnboardingState | null;
  busy: string | null;
  error: string | null;
  /** 서버가 돌려준 항목별 사유 (저장 실패) */
  serverIssues: ConfigIssue[];
  /** 편집 중 다른 사용자가 저장함 */
  remoteChanged: boolean;
  /** 이번 달 AI 사용량 (ai 도메인) */
  aiUsage: AiUsageState;
  handlers: WorkspaceHandlers;
  initialTab?: WsTab;
  initialPreview?: boolean;
}

/** 첫 실행 온보딩 카드 — 데이터 연결 → 팀 초대 → 목표 · 예산 확인 → 알림 채널 */
function OnboardingCard({ o, readOnly, canConfigure, busy, onReview }: { o: OnboardingState; readOnly: boolean; canConfigure: boolean; busy: boolean; onReview: () => void }) {
  return (
    <Card className="ws-onboarding" title={<span className="row" style={{ gap: 8 }}>시작하기 · {o.done}/{o.total} 완료{readOnly ? <Src kind="DEMO" /> : null}</span>}
      sub="처음 쓰는 워크스페이스입니다. 아래 순서대로 연결하면 수집 · 감지 · 리포트가 실데이터로 돌아갑니다. 완료 여부는 서버 상태로 판정합니다.">
      <ul className="ws-steps" aria-label="온보딩 단계">
        {o.steps.map((s) => (
          <li key={s.id} className={`ws-step${s.done ? ' done' : ''}`}>
            <span className="ws-step-mark"><Pill tone={s.done ? 'good' : 'outline'} icon={s.done ? 'check' : undefined}>{s.done ? '완료' : '할 일'}</Pill></span>
            <span className="ws-step-body">
              <strong>{s.label}</strong>
              <span className="xs muted">{s.detail}{s.at ? ` · ${fmtKst(s.at)}` : ''}</span>
            </span>
            <span className="ws-step-act">
              {s.id === 'goals' && !s.done && !readOnly && canConfigure
                ? <Button size="sm" icon="check" disabled={busy} onClick={(e) => { if (e.detail > 1) return; onReview(); }}>{busy ? '기록 중…' : '기본값 그대로 확인'}</Button>
                : null}
              {s.id !== 'goals' ? <a className="btn sm" href={s.href}>{s.done ? '보기' : '이동'}</a> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HistoryCard({ history, hasMore, demo, busy, onMore }: { history: HistoryEntry[] | null; hasMore: boolean; demo: boolean; busy: boolean; onMore: () => void }) {
  if (!history) return <Card><Empty icon="clock" title="변경 이력을 불러오는 중입니다" /></Card>;
  return (
    <Card title={<span className="row" style={{ gap: 8 }}>변경 이력{demo ? <Src kind="DEMO" /> : null}</span>} sub="누가 · 언제 · 무엇을 바꿨는지 — 감사 로그(설정 항목)와 같은 기록입니다.">
      {history.length ? (
        <ul className="ws-history">
          {history.map((h) => (
            <li key={h.id}>
              <div className="row" style={{ gap: 8 }}>
                <Pill tone={h.action === 'config.reset' ? 'warning' : h.action === 'config.review' ? 'good' : 'outline'}>{HISTORY_ACTION_LABEL[h.action] ?? h.action}</Pill>
                <strong className="small">{h.actor}</strong>
                <span className="xs muted">{fmtKst(h.at)}{h.version !== null ? ` · 버전 ${h.version}` : ''}</span>
              </div>
              {h.note ? <div className="small ink2">{h.note}</div> : null}
              {h.changes.length ? <ul className="ws-history-changes">{h.changes.map((c) => <li key={c.path}>{historyChangeText(c)}</li>)}</ul> : null}
            </li>
          ))}
        </ul>
      ) : <Empty icon="clock" title="아직 바꾼 설정이 없습니다">모든 항목이 기본값(제안서 기준)입니다.</Empty>}
      {hasMore ? <div className="row" style={{ justifyContent: 'center' }}><Button size="sm" disabled={busy} onClick={onMore}>{busy ? '불러오는 중…' : '더 보기'}</Button></div> : null}
    </Card>
  );
}

/** 화면 본체 (데이터 · 핸들러를 받아 그린다 — 서버 · 데모 공용, SSR 테스트 대상) */
export function WorkspaceScreen(p: WorkspaceScreenProps) {
  const [tab, setTab] = useState<WsTab>(p.initialTab ?? 'brand');
  const [preview, setPreview] = useState(!!p.initialPreview);
  const demo = p.mode === 'demo';
  const readOnly = demo || !p.canConfigure || !p.state;
  const defaults = p.state?.defaults ?? DEFAULT_CONFIG;
  const saved = p.state?.config ?? {};
  const issues = useMemo(() => draftIssues(p.draft), [p.draft]);
  const rows = useMemo(() => previewChanges(saved, p.draft, defaults), [saved, p.draft, defaults]);
  const dirty = rows.length > 0;
  const eff = mergeConfig(defaults, p.draft);
  const alloc = allocationRows(p.draft, defaults);
  const overridden = leafPaths(p.draft).length;

  const ctx: FormCtx = {
    draft: p.draft, defaults, readOnly, issues, canOwner: !!p.canOwner,
    // 기본값과 같은 값으로 되돌리면 덮어쓰기를 지운다 (기본값을 따르는 상태로)
    set: (path, v) => p.handlers.onDraft(JSON.stringify(getPath(defaults, path)) === JSON.stringify(v) ? removeOverride(p.draft, path) : setOverride(p.draft, path, v)),
    reset: (path) => p.handlers.onDraft(removeOverride(p.draft, path)),
  };
  const tabIssues = (t: WsTab) => t !== 'history' && issues.some((i) => TAB_PREFIXES[t].some((x) => i.path === x || i.path.startsWith(`${x}.`)));
  const o = p.onboarding;
  const pending = o ? o.steps.filter((s) => !s.done) : [];

  return (
    <div className="page ws-page">
      <PageHeader eyebrow="07 · WORKSPACE" title="워크스페이스 설정"
        sub="이 워크스페이스의 판단 기준을 정합니다. 바꾼 항목만 저장되고 나머지는 제안서 · RFP 기준 기본값을 따릅니다. 저장하면 화면 엔진과 서버(입찰 반영 · 24시간 감지 · SLA)가 같은 값을 씁니다."
        sources={<>
          {demo ? <Src kind="PROPOSAL" title="기본값 = 제안서 v3 · RFP (constants.ts)" /> : <Src kind="LIVE" title="서버에 저장된 워크스페이스 설정" />}
          <span className="xs muted">{p.workspaceName}{p.state ? ` · 버전 ${p.state.version}` : ''}{p.state?.updatedAt ? ` · 마지막 변경 ${fmtKst(p.state.updatedAt)} ${p.state.updatedBy?.name ?? ''}` : ' · 아직 바꾼 항목 없음'}</span>
        </>}
        actions={!demo ? <Button size="sm" icon="refresh" disabled={!!p.busy} onClick={p.handlers.onReload}>새로고침</Button> : undefined} />

      {demo ? (
        <Callout tone="warning" title={<span className="row" style={{ gap: 6 }}>기본값 보기 · 읽기 전용 <Src kind="DEMO" /></span>}>
          서버(MILDO OS Cloud)에 연결하지 않은 시연 모드라 현재 기본값(제안서 v3 · RFP 기준)을 읽기 전용으로 보여 줍니다.
          서버에 연결하면 PM · 관리자 · 소유자가 같은 화면에서 값을 바꾸고 저장할 수 있고, 저장한 값은 모든 화면 · 서버 엔진에 반영되며 변경 이력이 감사 로그에 남습니다.
          아래 시작하기 단계 · 변경 이력은 예시(TEST DATA)입니다.
        </Callout>
      ) : null}
      {!demo && !p.canConfigure ? <Callout tone="info" title="읽기 전용">설정 변경은 PM · 관리자 · 소유자만 할 수 있습니다. 바꿔야 할 기준이 있으면 담당 PM에게 요청해 주세요.</Callout> : null}
      {p.error ? <Callout tone="critical" title="처리하지 못했습니다">{p.error}</Callout> : null}
      {p.remoteChanged ? (
        <Callout tone="warning" title="다른 사용자가 설정을 저장했습니다">
          <span className="row" style={{ gap: 8 }}>지금 편집 중인 내용은 이전 버전 기준입니다. 최신 설정을 불러오면 편집 중인 내용은 사라집니다.
            <Button size="sm" icon="refresh" onClick={p.handlers.onReload}>최신 설정 불러오기</Button></span>
        </Callout>
      ) : null}
      {!demo && p.state && p.workspaceBrand && p.workspaceBrand.trim() && eff.brand.name !== p.workspaceBrand.trim() ? (
        <Callout tone="warning" title={`설정의 브랜드명(${eff.brand.name}${getPath(p.draft, 'brand.name') === undefined ? ' · 기본값' : ''})이 워크스페이스 브랜드(${p.workspaceBrand.trim()})와 다릅니다`}>
          <span className="row" style={{ gap: 8 }}>
            <span>기본값은 제안서(수면밀도) 기준입니다. 화면 · 리포트 · 에이전트 표기와 경쟁사 · SKU 진입점이 이 브랜드 기준인지 확인해 주세요. 수집 시 브랜드 키워드 판정은 워크스페이스 브랜드명을 씁니다.</span>
            {!readOnly ? <Button size="sm" icon="check" onClick={(e) => { if (e.detail > 1) return; ctx.set('brand.name', p.workspaceBrand!.trim()); setTab('brand'); }}>{`브랜드명을 '${p.workspaceBrand.trim()}'(으)로`}</Button> : null}
          </span>
        </Callout>
      ) : null}
      {p.state?.invalid.length ? (
        <Callout tone="warning" title={`저장된 값 중 ${p.state.invalid.length}개 항목을 무시하고 기본값을 쓰는 중입니다`}>
          {p.state.invalid.map((i) => `${configFieldLabel(i.path) || '(전체)'} — ${i.message}`).join(' · ')}. 한 번 저장하면 정리됩니다.
        </Callout>
      ) : null}

      {o?.firstRun ? <OnboardingCard o={o} readOnly={demo} canConfigure={p.canConfigure} busy={p.busy === 'review'} onReview={p.handlers.onReview} /> : null}
      {o && !o.firstRun && pending.length ? (
        <Callout tone="info" title={`남은 설정 ${pending.length}개`}>
          <span className="row" style={{ gap: 8 }}>
            {pending.map((s) => (s.id === 'goals'
              ? (!demo && p.canConfigure
                ? <Button key={s.id} size="sm" icon="check" disabled={!!p.busy} onClick={(e) => { if (e.detail > 1) return; p.handlers.onReview(); }}>{p.busy === 'review' ? '기록 중…' : '목표 · 예산 기본값 그대로 확인'}</Button>
                : <span key={s.id} className="pill outline">{s.label}</span>)
              : <a key={s.id} className="btn sm" href={s.href}>{s.label}</a>))}
            <span className="xs muted">{pending.map((s) => s.detail).join(' · ')}</span>
          </span>
        </Callout>
      ) : null}

      <div className="grid g-4">
        <Stat label="바꾼 항목" value={overridden} foot={<span className="ws-basis">나머지는 기본값(제안서 · RFP) · 저장된 버전 {p.state?.version ?? 0}</span>} />
        <Stat label="목표 ROAS" value={`${fmt.int(eff.targets.roas)}%`} foot={<span className="ws-basis">브랜드 {fmt.int(eff.targets.brandRoas)}% · 고효율 {fmt.int(eff.targets.roas * eff.targets.highEfficiencyRatio)}% 이상 · 기본값 {fmt.int(defaults.targets.roas)}%</span>} />
        <Stat label="일 조정 폭 상한" value={`${eff.safety.dailyChangeCapPct}%`} foot={<span className="ws-basis">위임 AE ±{eff.delegation.aeMaxPct}% · PM ±{eff.delegation.pmMaxPct}% · 초과는 광고주 승인</span>} />
        <Stat label="매체 배분 합계" value={`${fmt.dec1(alloc.sum * 100)}%`}
          foot={<span className="stack-sm" style={{ gap: 2 }}><Pill tone={alloc.ok ? 'good' : 'critical'}>{alloc.ok ? '정상' : '저장 불가'}</Pill><span className="ws-basis">기준 100% ± 0.1%p · 연 예산 {fmt.krw(eff.budget.annual)}원</span></span>} />
      </div>

      {!readOnly ? (
        <div className={`ws-savebar${dirty ? ' dirty' : ''}`} role="region" aria-label="저장">
          <span className="small">
            {dirty ? <><strong>저장하지 않은 변경 {rows.length}건</strong>{issues.length ? <span className="ws-warn"> · 확인할 항목 {issues.length}개</span> : null}</> : '변경 사항 없음'}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Button size="sm" variant="ghost" disabled={!dirty || !!p.busy} onClick={p.handlers.onDiscard}>편집 취소</Button>
            <Button size="sm" variant="primary" icon="check" disabled={!dirty || !!p.busy} onClick={(e) => { if (e.detail > 1) return; setPreview(true); }}>변경 미리보기 · 저장</Button>
          </span>
        </div>
      ) : null}

      <Tabs<WsTab> value={tab} onChange={setTab} tabs={(Object.keys(TAB_LABEL) as WsTab[]).map((t) => {
        const n = t === 'history' ? 0 : overrideCount(p.draft, TAB_PREFIXES[t]);
        return {
          id: t, label: TAB_LABEL[t],
          badge: tabIssues(t) ? <Pill tone="critical">확인</Pill> : n ? <Pill tone="accent">{n}</Pill> : undefined,
        };
      })} />

      {tab === 'brand' ? <BrandSection ctx={ctx} /> : null}
      {tab === 'budget' ? <BudgetSection ctx={ctx} /> : null}
      {tab === 'targets' ? <TargetsSection ctx={ctx} /> : null}
      {tab === 'approval' ? <DelegationSection ctx={ctx} /> : null}
      {tab === 'timetable' ? <div className="stack-lg"><TimetableSection ctx={ctx} /><SlaSection ctx={ctx} /></div> : null}
      {tab === 'detect' ? <DetectSection ctx={ctx} /> : null}
      {tab === 'modules' ? <ModulesSection ctx={ctx} /> : null}
      {tab === 'ai' ? <AiSection ctx={ctx} ai={p.aiUsage} onReloadUsage={p.handlers.onReloadUsage} /> : null}
      {tab === 'impact' ? <ImpactSection ctx={ctx} /> : null}
      {tab === 'history' ? <HistoryCard history={p.history} hasMore={p.hasMoreHistory} demo={demo} busy={p.busy === 'history'} onMore={p.handlers.onMoreHistory} /> : null}

      {preview ? (
        <Modal wide title="변경 미리보기" onClose={() => setPreview(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setPreview(false)}>계속 편집</Button>
            <Button variant="primary" icon="check" disabled={!rows.length || issues.length > 0 || !!p.busy || readOnly}
              onClick={async (e) => { if (e.detail > 1) return; const ok = await p.handlers.onSave(); if (ok) setPreview(false); }}>
              {p.busy === 'save' ? '저장 중…' : `${rows.length}건 저장`}
            </Button>
          </>}>
          <div className="stack">
            <span className="small ink2">저장하면 이 워크스페이스의 모든 화면 · 서버 엔진이 아래 값을 씁니다. 저장 기록은 감사 로그와 변경 이력에 남습니다.</span>
            {issues.length || p.serverIssues.length ? (
              <Callout tone="critical" title="저장하기 전에 확인할 항목">
                <ul className="ws-issues">{[...issues, ...p.serverIssues.filter((s) => !issues.some((i) => i.path === s.path))].map((i) => <li key={`${i.path}|${i.message}`}><strong>{configFieldLabel(i.path) || '(전체)'}</strong> — {i.message}</li>)}</ul>
              </Callout>
            ) : null}
            {rows.length ? (
              <div className="table-wrap">
                <table className="tbl ws-diff">
                  <thead><tr><th>항목</th><th>지금</th><th>저장 후</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.path}>
                        <td>{r.label}{r.sourceOnly ? <span className="xs muted"> · 값은 같고 {r.toDefault ? '기본값을 따르도록' : '워크스페이스 값으로 고정'}</span> : null}</td>
                        <td className="muted">{r.before}</td>
                        <td><strong>{r.after}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon="check" title="바뀐 항목이 없습니다" />}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

const NOOP: WorkspaceHandlers = {
  onDraft: () => undefined, onSave: async () => false, onDiscard: () => undefined, onReview: () => undefined, onReload: () => undefined, onMoreHistory: () => undefined,
};

function DemoWorkspace() {
  const state = useMemo(() => demoState(), []);
  const history = useMemo(() => demoHistory(), []);
  const onboarding = useMemo(() => demoOnboarding(), []);
  const aiUsage = useMemo<AiUsageState>(() => ({ status: 'demo', usage: demoAiUsage() }), []);
  return (
    <WorkspaceScreen mode="demo" workspaceName="수면밀도 퍼포먼스 (예시)" state={state} draft={{}} canConfigure={false} history={history} hasMoreHistory={false}
      onboarding={onboarding} busy={null} error={null} serverIssues={[]} remoteChanged={false} aiUsage={aiUsage} handlers={NOOP} />
  );
}

const errText = (e: unknown) => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요';
};

function ServerWorkspace() {
  const saas = useSaas();
  const ws = saas.workspace!;
  const canConfigure = saas.can('configure');
  const canOwner = saas.can('owner');
  const { toast } = useActions();
  const [state, setState] = useState<ConfigState | null>(null);
  const [draft, setDraft] = useState<WorkspaceConfig>({});
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([]);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [aiUsage, setAiUsage] = useState<AiUsageState>({ status: 'loading', usage: null });
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const savedRef = useRef<WorkspaceConfig>({});
  dirtyRef.current = JSON.stringify(draft) !== JSON.stringify(savedRef.current);

  const loadSide = useCallback(async () => {
    const [h, o] = await Promise.allSettled([remote.fetchHistory(ws.id), remote.fetchOnboarding(ws.id)]);
    if (h.status === 'fulfilled') { setHistory(h.value.entries); setNextBefore(h.value.nextBefore); }
    if (o.status === 'fulfilled') setOnboarding(o.value);
    return [h, o].filter((x) => x.status === 'rejected').map((x) => errText((x as PromiseRejectedResult).reason));
  }, [ws.id]);

  const load = useCallback(async () => {
    const errs: string[] = [];
    try {
      const s = await remote.fetchConfig(ws.id);
      setState(s);
      savedRef.current = s.config;
      setDraft(s.config);
      setRemoteChanged(false);
      setServerIssues([]);
    } catch (e) {
      errs.push(`설정: ${errText(e)}`);
    }
    errs.push(...(await loadSide()));
    setError(errs.length ? errs.join(' · ') : null);
  }, [ws.id, loadSide]);

  const loadUsage = useCallback(async () => {
    try {
      setAiUsage({ status: 'ok', usage: await remote.fetchAiUsage(ws.id) });
    } catch (e) {
      setAiUsage({ status: 'error', usage: null, error: errText(e) });
    }
  }, [ws.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadUsage(); }, [loadUsage]);

  // 다른 사용자의 저장 · 연결 · 구성원 변화 (몰리면 한 번만)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (fn: () => void) => { if (timer) clearTimeout(timer); timer = setTimeout(fn, 300); };
    const offs = [
      onServerEvent('config', (e) => {
        if (e.ws && e.ws !== ws.id) return;
        later(() => {
          if (busyRef.current) return;
          if (dirtyRef.current) { setRemoteChanged(true); void loadSide(); } else void load();
          void loadUsage();
        });
      }),
      ...['connection', 'member'].map((t) => onServerEvent(t, (e) => { if (!e.ws || e.ws === ws.id) later(() => void loadSide()); })),
    ];
    return () => { offs.forEach((f) => f()); if (timer) clearTimeout(timer); };
  }, [ws.id, load, loadSide, loadUsage]);

  const handlers: WorkspaceHandlers = {
    onDraft: (next) => { setDraft(next); setServerIssues([]); },
    onDiscard: () => { setDraft(savedRef.current); setServerIssues([]); },
    onReload: () => { void load(); void loadUsage(); },
    onReloadUsage: () => void loadUsage(),
    onSave: async () => {
      if (busyRef.current || !state) return false;
      busyRef.current = true;
      setBusy('save');
      try {
        const r = await remote.saveConfig(ws.id, draft, state.version);
        setState(r);
        savedRef.current = r.config;
        setDraft(r.config);
        setServerIssues([]);
        setError(null);
        setRemoteChanged(false);
        try { applyWorkspaceConfig(r.config); } catch { /* 적용 실패 — 다음 로드에서 다시 */ }
        void saas.reloadDetail();
        void loadSide();
        void loadUsage();
        toast({ tone: 'good', title: r.changed ? `설정을 저장했습니다 · ${r.changes.length}건 (버전 ${r.version})` : '바뀐 항목이 없습니다', body: r.changed ? '이 화면 · 서버 엔진이 새 기준을 씁니다. 이미 열려 있던 다른 화면은 다시 열면 새 기준으로 계산합니다' : undefined });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 400 && Array.isArray(e.detail)) setServerIssues(e.detail as ConfigIssue[]);
        if (e instanceof ApiError && e.status === 409) setRemoteChanged(true);
        setError(errText(e));
        toast({ tone: 'critical', title: '설정을 저장하지 못했습니다', body: errText(e) });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    onReview: () => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy('review');
      void remote.reviewConfig(ws.id)
        .then((o) => { setOnboarding(o); void loadSide(); toast({ tone: 'good', title: '목표 · 예산 기본값을 확인했다고 기록했습니다', body: '감사 로그 · 변경 이력에 남았습니다' }); })
        .catch((e) => toast({ tone: 'critical', title: '기록하지 못했습니다', body: errText(e) }))
        .finally(() => { busyRef.current = false; setBusy(null); });
    },
    onMoreHistory: () => {
      if (!nextBefore || busyRef.current) return;
      busyRef.current = true;
      setBusy('history');
      void remote.fetchHistory(ws.id, nextBefore)
        .then((r) => { setHistory((h) => [...(h ?? []), ...r.entries]); setNextBefore(r.nextBefore); })
        .catch((e) => setError(errText(e)))
        .finally(() => { busyRef.current = false; setBusy(null); });
    },
  };

  return (
    <WorkspaceScreen mode="server" workspaceName={ws.name} workspaceBrand={ws.brand_name} state={state} draft={draft} canConfigure={canConfigure} canOwner={canOwner} history={history} hasMoreHistory={!!nextBefore}
      onboarding={onboarding} busy={busy} error={error} serverIssues={serverIssues} remoteChanged={remoteChanged} aiUsage={aiUsage} handlers={handlers} />
  );
}

export default function View() {
  const saas = useSaas();
  if (saas.mode === 'checking') {
    return (
      <div className="page ws-page">
        <PageHeader eyebrow="07 · WORKSPACE" title="워크스페이스 설정" sub="서버 연결을 확인하는 중입니다." />
      </div>
    );
  }
  if (saas.mode === 'server') {
    if (!saas.workspace) {
      return (
        <div className="page ws-page">
          <PageHeader eyebrow="07 · WORKSPACE" title="워크스페이스 설정" />
          <Callout tone="info" title="워크스페이스가 없습니다">로그인한 뒤 초대받은 워크스페이스가 있어야 설정을 볼 수 있습니다.</Callout>
        </div>
      );
    }
    return <ServerWorkspace key={saas.workspace.id} />;
  }
  return <DemoWorkspace />;
}
