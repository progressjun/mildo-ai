/**
 * 알림 설정 (관리 · 07 NOTIFICATIONS) — MILDO Alert 서버 24시간 감지 결과를 Slack · 이메일 · 웹훅으로 보내는 채널,
 * 등급 · 이벤트 필터, 발송 이력, SLA 정책 · 에스컬레이션, 주말 · 공휴일 당번표, 감지 실행 기록.
 *
 * 서버 모드: 실제 API (권한은 서버가 최종 판정 — 화면은 configure · operate 권한에 맞춰 버튼만 막는다).
 * 데모 모드(claude.ai 아티팩트 · 서버 없음): 같은 화면을 예시 상태(TEST DATA)로 읽기 전용 표시 + '서버 연결 시 실제로 동작' 안내.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import './styles.css';
import type { Severity } from '@/core/types';
import { SEVERITY_LABEL } from '@/data/constants';
import { useActions, useStoreOptional } from '@/core/store';
import { useSaas } from '@/saas/context';
import { onServerEvent } from '@/saas/events';
import { Icon } from '@/ui/Icon';
import { Button, Callout, Card, DataTable, Empty, Field, Modal, PageHeader, Pill, Segmented, Sev, Src, Stat, Tabs, Toggle, type Column } from '@/ui/primitives';
import { fmtDateShort, type AlertIncident, type DutyRow } from '@/modules/alert/engine';
import { DEMO } from '@/data/demo';
import { buildMessage, type Message } from './message';
import {
  DEMO_CHANNELS, DEMO_INCIDENTS, demoLog, demoRuns, draftFromChannel, draftProblems, draftToBody, emptyDraft, EVENT_LABEL, EVENT_OPTIONS, fmtIso, localPolicy,
  severityScopeLabel, SEVERITY_SCOPE, slaRows, STATUS_TEXT, summarize, TRIGGER_LABEL, TYPE_ICON, TYPE_LABEL,
  type Channel, type ChannelDraft, type ChannelEvent, type ChannelType, type LogEntry, type Policy, type ScanRun, type SlaRow,
} from './model';
import * as remote from './api';

type TabId = 'channels' | 'log' | 'policy' | 'roster' | 'runs';

const errText = (e: unknown) => (e as { message?: string })?.message ?? '요청을 처리하지 못했습니다';
/** 더블클릭의 두 번째 클릭은 무시 (버튼이 같은 자리에서 바뀌는 화면 공통 규칙) */
const once = (fn: () => void) => (e: MouseEvent<HTMLButtonElement>) => { if (e.detail > 1) return; fn(); };

export interface NotifyData {
  demo: boolean;
  loading: boolean;
  error: string | null;
  channels: Channel[];
  log: LogEntry[];
  nextBefore: number | null;
  runs: ScanRun[];
  policy: Policy;
  reload: (part?: Part) => Promise<void>;
  loadMore: () => Promise<void>;
  filter: LogFilter;
  setFilter: (f: LogFilter) => void;
}
interface LogFilter { status: string; event: string; channelId: string }
/** init = 처음 열 때 (발송 이력은 필터 효과가 따로 불러온다) */
type Part = 'channels' | 'log' | 'runs' | 'all' | 'init';

export function useNotifyData(ws: string | null): NotifyData {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(!!ws);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LogFilter>({ status: '', event: '', channelId: '' });
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const loadLog = useCallback(async (before?: number | null) => {
    if (!ws) return;
    const f = filterRef.current;
    const r = await remote.fetchLog(ws, { status: f.status || undefined, event: f.event || undefined, channelId: f.channelId || undefined, before });
    setLog((prev) => (before ? [...prev, ...r.entries] : r.entries));
    setNextBefore(r.nextBefore);
  }, [ws]);

  const reload = useCallback(async (part: Part = 'all') => {
    if (!ws) return;
    const all = part === 'all' || part === 'init';
    const jobs: Promise<unknown>[] = [];
    if (all || part === 'channels') jobs.push(remote.fetchChannels(ws).then(setChannels));
    if (part === 'all' || part === 'log') jobs.push(loadLog());
    if (all || part === 'runs') jobs.push(remote.fetchRuns(ws).then(setRuns));
    if (all) jobs.push(remote.fetchPolicy(ws).then(setPolicy));
    const res = await Promise.allSettled(jobs);
    const bad = res.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(bad ? errText(bad.reason) : null);
    setLoading(false);
  }, [ws, loadLog]);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    void reload('init');
    let timer: ReturnType<typeof setTimeout> | null = null;
    let chTimer: ReturnType<typeof setTimeout> | null = null;
    const offInc = onServerEvent('incident', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void reload('runs'); void reload('log'); }, 1500);
    });
    // 'notify' = 다른 사용자의 채널 생성 · 수정 · 삭제 · 테스트 발송, 서버의 발송 결과 (id = 채널 id)
    const offNotify = onServerEvent('notify', () => {
      if (chTimer) clearTimeout(chTimer);
      chTimer = setTimeout(() => { void reload('channels'); void reload('log'); }, 800);
    });
    return () => { offInc(); offNotify(); if (timer) clearTimeout(timer); if (chTimer) clearTimeout(chTimer); };
  }, [ws, reload]);

  useEffect(() => { if (ws) void loadLog().catch((e) => setError(errText(e))); }, [ws, filter, loadLog]);

  const demoState = useMemo(() => ({ channels: DEMO_CHANNELS, log: demoLog(), runs: demoRuns(), policy: localPolicy(DEMO.today) }), []);
  if (!ws) {
    const f = filter;
    const shown = demoState.log.filter((l) => (!f.status || l.status === f.status) && (!f.event || l.event === f.event) && (!f.channelId || l.channelId === f.channelId));
    return {
      demo: true, loading: false, error: null, channels: demoState.channels, log: shown, nextBefore: null, runs: demoState.runs, policy: demoState.policy,
      reload: async () => undefined, loadMore: async () => undefined, filter, setFilter,
    };
  }
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return {
    demo: false, loading, error, channels, log, nextBefore, runs, policy: policy ?? localPolicy(today),
    reload, loadMore: async () => { if (nextBefore) await loadLog(nextBefore).catch((e) => setError(errText(e))); }, filter, setFilter,
  };
}

export default function View() {
  const saas = useSaas();
  const ws = saas.mode === 'server' ? saas.workspace?.id ?? null : null;
  const d = useNotifyData(ws);
  const canConfigure = !d.demo && saas.can('configure');
  const canOperate = !d.demo && saas.can('operate');
  const [tab, setTab] = useState<TabId>('channels');
  const sum = summarize(d.channels, d.log);
  const lastRun = d.runs[0];
  const runStale = !d.demo && (!lastRun || Date.now() - Date.parse(lastRun.startedAt) > 20 * 60_000);
  const regime = d.policy.regime;

  return (
    <div className="page notify-page">
      <PageHeader
        eyebrow="07 · NOTIFICATIONS · MILDO OS CLOUD"
        title="알림 설정"
        sub="서버가 24시간(수집 직후 + 10분마다) 감지한 이슈를 Slack · 이메일 · 웹훅으로 보냅니다. 채널마다 받을 등급과 이벤트를 고르고, SLA 기한이 지나면 백업 · PM에게 단계마다 한 번 에스컬레이션합니다. 주말 · 공휴일에는 당번표대로 배정합니다."
        sources={<>
          <Src kind="PROPOSAL" page="p.44–49" />
          {d.demo ? <span className="src demo" title="시연용 예시 채널 · 발송 이력 · 실제 발송 아님">TEST DATA</span> : <Src kind="LIVE" title="서버에 저장된 실제 채널 · 발송 이력" />}
          <span className="xs muted">{d.demo ? '예시 상태 · 읽기 전용' : `워크스페이스 ${saas.workspace?.brand_name ?? saas.workspace?.name ?? ''} · 권한 ${canConfigure ? '채널 관리 가능' : '읽기 전용 (채널 관리는 PM 이상)'}`}</span>
        </>}
        actions={<>
          <Pill tone={regime.off ? 'dark' : 'neutral'} icon="calendar">{regime.off ? `${regime.label}${regime.forced ? ' (설정: 당번 체계 강제)' : ''} · 당번 ${regime.duty?.role ?? '—'}` : '평일 운영 체계'}</Pill>
          {!d.demo ? <Button size="sm" icon="refresh" onClick={once(() => void d.reload('all'))}>새로고침</Button> : null}
        </>}
      />

      {d.demo ? (
        <Callout tone="accent" title="서버 연결 시 실제로 동작합니다">
          지금 화면은 예시 상태(TEST DATA)이며 읽기 전용입니다. MILDO OS Cloud 서버에 연결하면 채널 추가 · 테스트 발송 · 발송 이력 · 감지 실행 기록이 실제 데이터로 바뀌고,
          서버가 화면을 닫아도 24시간 감지와 SLA 에스컬레이션을 계속 보냅니다.
        </Callout>
      ) : null}
      {d.error ? <Callout tone="critical" title="서버에서 불러오지 못했습니다">{d.error}</Callout> : null}

      <div className="grid g-4">
        <Stat label="알림 채널 (켜짐 / 전체)" value={`${sum.enabled} / ${sum.channels}`} foot={<span className="xs muted">Slack {sum.byType.slack} · 메일 {sum.byType.email} · 웹훅 {sum.byType.webhook}</span>} />
        <Stat label="최근 발송 (표시 중인 이력 기준)" value={`${sum.log.sent}건`} foot={<span className="xs muted">실패 {sum.log.failed}건 (재시도 대기 {sum.log.retrying}) · 보내지 않음 {sum.log.skipped}건</span>} />
        <Stat label="마지막 감지 실행" value={lastRun ? fmtIso(lastRun.startedAt) : '기록 없음'} foot={<span className="xs muted">{lastRun ? `${TRIGGER_LABEL[lastRun.trigger] ?? lastRun.trigger} · 감지 ${lastRun.found}건 · 신규 ${lastRun.created}건` : '예약 감지는 10분마다'}</span>} />
        <Stat label="인지 목표 (P1 · 주말 · 공휴일)" value={`${d.policy.sla.P1.label.ack} · ${d.policy.weekendAckMin}분`} foot={<span className="xs muted">1차 조치 {d.policy.sla.P1.label.action} · 결과 보고 {d.policy.sla.P1.label.report} (P1 기준)</span>} />
      </div>

      {!d.loading ? <CoverageNotes sum={sum} runStale={runStale} lastRun={lastRun} demo={d.demo} /> : null}

      <Tabs<TabId> value={tab} onChange={setTab} tabs={[
        { id: 'channels', label: '채널', badge: sum.failing.length ? <Pill tone="critical">{sum.failing.length}</Pill> : undefined },
        { id: 'log', label: '발송 이력' },
        { id: 'policy', label: 'SLA · 에스컬레이션' },
        { id: 'roster', label: '주말 · 공휴일 당번' },
        { id: 'runs', label: '24시간 감지 기록', badge: runStale ? <Pill tone="warning">확인</Pill> : undefined },
      ]} />

      {tab === 'channels' ? <ChannelsTab d={d} ws={ws} canConfigure={canConfigure} /> : null}
      {tab === 'log' ? <LogTab d={d} /> : null}
      {tab === 'policy' ? <PolicyTab policy={d.policy} demo={d.demo} /> : null}
      {tab === 'roster' ? <RosterTab policy={d.policy} demo={d.demo} /> : null}
      {tab === 'runs' ? <RunsTab d={d} ws={ws} canOperate={canOperate} /> : null}
    </div>
  );
}

export function CoverageNotes({ sum, runStale, lastRun, demo }: { sum: ReturnType<typeof summarize>; runStale: boolean; lastRun?: ScanRun; demo: boolean }) {
  const notes: { tone: 'warning' | 'critical' | 'info'; title: string; body: string }[] = [];
  if (!demo && (lastRun?.dataMode === 'demo' || lastRun?.dataMode === 'mixed')) {
    const all = lastRun.dataMode === 'demo';
    notes.push({
      tone: sum.testCovered ? 'info' : 'warning',
      title: all ? '최근 감지가 TEST DATA로 돌았습니다' : '일부 매체가 TEST DATA입니다',
      body: `${all ? '감지한 이슈는 전부' : '출처가 데모뿐인 매체의 이슈는'} TEST DATA로 표시되어 '테스트 데이터 이슈' 이벤트를 켠 채널로만 갑니다 (기준: 마지막 감지의 데이터 출처 ${all ? 'demo' : 'demo + 실연동'}). ${sum.testCovered ? '그 이벤트를 켠 채널이 있어 시연 알림은 나갑니다.' : '지금은 그 이벤트를 켠 채널이 없어 TEST DATA 이슈 알림은 나가지 않습니다.'} 실데이터를 연결하면 '새 이슈' 채널로 갑니다.`,
    });
  }
  if (!sum.p1Covered) notes.push({ tone: 'critical', title: '새 이슈를 받을 채널이 없습니다', body: "서버가 이슈를 감지해도 아무에게도 알림이 가지 않습니다. '새 이슈' 이벤트를 켠 채널을 하나 이상 두세요 (기준: 켜진 채널 중 이벤트 '새 이슈' 0개)." });
  if (sum.p1Covered && !sum.slaCovered) notes.push({ tone: 'warning', title: 'SLA 기한 초과 에스컬레이션을 받을 채널이 없습니다', body: "기한이 지나면 타임라인에는 기록되지만 백업 · PM에게 알림이 가지 않습니다. 백업 · PM이 보는 채널에 'SLA 기한 초과'를 켜세요." });
  for (const c of sum.failing) notes.push({ tone: 'warning', title: `${c.name} · 마지막 발송 실패`, body: `${c.lastError ?? '사유 미상'} · 5xx · 시간 초과는 최대 4회 자동 재시도, 4xx(주소 삭제 · 권한)는 재시도하지 않으니 채널 설정을 확인하세요.` });
  if (runStale) notes.push({ tone: 'warning', title: '최근 20분 동안 감지 실행 기록이 없습니다', body: `${lastRun ? `마지막 실행 ${fmtIso(lastRun.startedAt)}. ` : ''}예약 감지는 10분마다 워커가 실행합니다. 워커 프로세스(start:worker) · 잡 큐 상태를 확인하세요.` });
  if (lastRun?.status === 'warning' && lastRun.warning) notes.push({ tone: 'warning', title: '마지막 감지가 경고로 끝났습니다', body: lastRun.warning });
  if (!notes.length) return null;
  return <div className="stack-sm">{notes.map((n) => <Callout key={n.title} tone={n.tone} title={n.title}>{n.body}</Callout>)}</div>;
}

/* ============================== 채널 ============================== */

export function ChannelsTab({ d, ws, canConfigure }: { d: NotifyData; ws: string | null; canConfigure: boolean }) {
  const actions = useActions();
  const [form, setForm] = useState<{ draft: ChannelDraft; channel: Channel | null } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const noPerm = d.demo ? '데모 모드 · 서버 연결 시 사용' : !canConfigure ? '채널 관리는 PM · 관리자 · 소유자 권한' : undefined;

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (e) { actions.toast({ tone: 'warning', title: '처리하지 못했습니다', body: errText(e) }); } finally { setBusy(null); }
  };
  const test = (c: Channel, sample: boolean) => run(`test:${c.id}`, async () => {
    const r = await remote.testChannel(ws!, c.id, sample);
    actions.toast({ tone: r.result.ok ? 'good' : 'warning', title: r.result.ok ? `${c.name} · 테스트 발송 성공` : `${c.name} · 테스트 발송 실패`, body: r.result.ok ? (sample ? '열린 이슈 하나를 실제 알림 형식(예시 표기)으로 보냈습니다.' : '연결 확인 메시지를 보냈습니다.') : r.result.reason ?? undefined });
    await d.reload('channels');
    await d.reload('log');
  });
  const toggle = (c: Channel) => run(`toggle:${c.id}`, async () => {
    await remote.updateChannel(ws!, c.id, { enabled: !c.enabled });
    actions.toast({ tone: 'info', title: `${c.name} · ${c.enabled ? '끔' : '켬'}` });
    await d.reload('channels');
  });
  const remove = (c: Channel) => run(`del:${c.id}`, async () => {
    await remote.deleteChannel(ws!, c.id);
    setArmed(null);
    actions.toast({ tone: 'info', title: `${c.name} 채널을 삭제했습니다`, body: '이전 발송 이력은 남아 있습니다.' });
    await d.reload('channels');
  });

  const columns: Column<Channel>[] = [
    { key: 'name', label: '채널', render: (c) => <div className="stack-sm" style={{ gap: 2 }}><strong className="row" style={{ gap: 6 }}><Icon name={TYPE_ICON[c.type]} size={14} />{c.name}</strong><span className="xs muted">{TYPE_LABEL[c.type]} · {c.config.target}{c.config.hasSecret ? ' · 서명 사용' : ''}</span></div>, sort: (c) => c.name },
    { key: 'sev', label: '받는 등급', render: (c) => <span className="small nowrap" title={`${SEVERITY_LABEL[c.minSeverity]} 이상`}>{severityScopeLabel(c.minSeverity)}</span>, sort: (c) => c.minSeverity },
    { key: 'events', label: '이벤트', render: (c) => <div className="row" style={{ gap: 4 }}>{c.events.map((e) => <Pill key={e} tone={e === 'sla' ? 'serious' : e === 'test' ? 'dark' : 'neutral'}>{EVENT_LABEL[e] ?? e}</Pill>)}</div> },
    { key: 'state', label: '상태', render: (c) => <Pill tone={c.enabled ? 'good' : 'outline'}>{c.enabled ? '켜짐' : '꺼짐'}</Pill>, sort: (c) => (c.enabled ? 1 : 0) },
    {
      key: 'last', label: '마지막 결과', render: (c) => (
        <div className="xs" style={{ maxWidth: 260 }}>
          {c.lastStatus ? <Pill tone={c.lastStatus === 'sent' ? 'good' : c.lastStatus === 'failed' ? 'critical' : 'neutral'}>{STATUS_TEXT[c.lastStatus as LogEntry['status']] ?? c.lastStatus}</Pill> : <span className="muted">발송 전</span>}
          <div className="muted">발송 {fmtIso(c.lastSentAt)} · 테스트 {fmtIso(c.lastTestAt)}</div>
          {c.lastError ? <div className="notify-err">{c.lastError}</div> : null}
        </div>
      ),
    },
    {
      key: 'act', label: '', render: (c) => (
        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
          <Button size="sm" icon="send" disabled={!!noPerm || !!busy} title={noPerm ?? '연결 확인 메시지 보내기'} onClick={once(() => void test(c, false))}>테스트</Button>
          <Button size="sm" variant="ghost" disabled={!!noPerm || !!busy} title={noPerm ?? '열린 이슈 하나를 실제 알림 형식으로 보내기 (예시 표기)'} onClick={once(() => void test(c, true))}>예시 이슈</Button>
          <Button size="sm" variant="ghost" icon="edit" disabled={!!noPerm} title={noPerm} onClick={once(() => setForm({ draft: draftFromChannel(c), channel: c }))}>편집</Button>
          <Button size="sm" variant="ghost" disabled={!!noPerm || !!busy} title={noPerm} onClick={once(() => void toggle(c))}>{c.enabled ? '끄기' : '켜기'}</Button>
          {armed === c.id ? (
            <span className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="danger" disabled={!!busy} onClick={once(() => void remove(c))}>삭제 확인</Button>
              <Button size="sm" variant="ghost" onClick={once(() => setArmed(null))}>취소</Button>
            </span>
          ) : <Button size="sm" variant="ghost" icon="x" disabled={!!noPerm} title={noPerm} onClick={once(() => setArmed(c.id))}>삭제</Button>}
        </div>
      ),
    },
  ];

  return (
    <div className="stack-lg">
      <Card title="알림 채널" sub="저장한 웹훅 주소 · 서명 비밀값 · 수신자는 서버에 암호화해 보관하고, 저장 후에는 가린 값만 보여 줍니다. 웹훅은 https 공인 주소만 허용합니다(사설 · 루프백 · 메타데이터 주소 차단)."
        actions={<Button variant="primary" icon="plus" disabled={!!noPerm} title={noPerm} onClick={once(() => setForm({ draft: emptyDraft('slack'), channel: null }))}>채널 추가</Button>}>
        {d.loading ? <Empty icon="clock" title="불러오는 중" /> : (
          <DataTable rows={d.channels} columns={columns} rowKey={(c) => c.id}
            empty={<Empty icon="bell" title="알림 채널이 없습니다">{noPerm ? '채널은 PM 이상 권한으로 추가합니다.' : "'채널 추가'로 Slack · 이메일 · 웹훅을 연결하세요."}</Empty>} />
        )}
      </Card>
      <PreviewCard />
      {form && ws ? <ChannelForm ws={ws} init={form.draft} channel={form.channel} onClose={() => setForm(null)} onSaved={async () => { setForm(null); await d.reload('channels'); }} /> : null}
    </div>
  );
}

export function ChannelForm({ ws, init, channel, onClose, onSaved }: { ws: string; init: ChannelDraft; channel: Channel | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const actions = useActions();
  const editing = !!channel;
  const [dr, setDr] = useState<ChannelDraft>(init);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problems = draftProblems(dr, editing);
  const has = Object.keys(problems).length > 0;
  const set = (p: Partial<ChannelDraft>) => setDr((x) => ({ ...x, ...p }));
  const show = (k: keyof typeof problems) => (touched && problems[k] ? <div className="notify-err">{problems[k]}</div> : null);
  const toggleEvent = (e: ChannelEvent, on: boolean) => set({ events: on ? [...new Set([...dr.events, e])] : dr.events.filter((x) => x !== e) });

  const save = async () => {
    setTouched(true);
    if (has || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const body = draftToBody(dr, editing);
      if (editing) await remote.updateChannel(ws, channel!.id, body);
      else await remote.createChannel(ws, body);
      actions.toast({ tone: 'good', title: editing ? `${dr.name} 채널을 저장했습니다` : `${dr.name} 채널을 추가했습니다`, body: "주소 · 비밀값은 가린 값으로만 표시됩니다. '테스트'로 연결을 확인하세요." });
      await onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? `채널 편집 · ${channel!.name}` : '알림 채널 추가'} onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={once(onClose)}>취소</Button>
        <Button variant="primary" icon="check" disabled={saving || (touched && has)} onClick={once(() => void save())}>{saving ? '저장 중' : '저장'}</Button>
      </>}>
      <div className="stack">
        {!editing ? (
          <Field label="종류">
            <Segmented<ChannelType> label="채널 종류" value={dr.type} onChange={(t) => set({ type: t })} options={(['slack', 'email', 'webhook'] as ChannelType[]).map((t) => ({ id: t, label: TYPE_LABEL[t] }))} />
          </Field>
        ) : <div className="small muted">종류: {TYPE_LABEL[dr.type]} (종류는 바꿀 수 없습니다 · 새 채널로 추가)</div>}
        <Field id="notify-name" label="채널 이름" hint="화면 · 발송 이력에 보이는 이름 (예: #수면밀도-운영)">
          <input id="notify-name" className="input" value={dr.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          {show('name')}
        </Field>
        {dr.type === 'slack' ? (
          <Field id="notify-slack" label="Slack Incoming Webhook URL" hint={editing ? `비워 두면 기존 주소 유지 (${channel!.config.webhookUrl ?? channel!.config.target})` : 'Slack 앱 설정 → Incoming Webhooks → Add New Webhook에서 채널을 고른 뒤 복사한 https://hooks.slack.com/services/… 주소. 주소 자체가 비밀값입니다.'}>
            <input id="notify-slack" className="input" type="password" autoComplete="off" spellCheck={false} placeholder="https://hooks.slack.com/services/…" value={dr.webhookUrl} onChange={(e) => set({ webhookUrl: e.target.value })} />
            {show('webhookUrl')}
          </Field>
        ) : null}
        {dr.type === 'webhook' ? (
          <>
            <Field id="notify-url" label="웹훅 주소 (https)" hint={editing ? `비워 두면 기존 주소 유지 (${channel!.config.url ?? channel!.config.target})` : 'POST JSON { event, workspace, incident } 를 받습니다. https 공인 주소만 허용합니다.'}>
              <input id="notify-url" className="input" type="password" autoComplete="off" spellCheck={false} placeholder="https://" value={dr.url} onChange={(e) => set({ url: e.target.value })} />
              {show('url')}
            </Field>
            <Field id="notify-secret" label="서명 비밀값 (선택 · 16자 이상)"
              hint="넣으면 X-Mildo-Timestamp와 X-Mildo-Signature: sha256=HMAC-SHA256(비밀값, '타임스탬프.본문') 헤더를 함께 보냅니다. 받는 쪽에서 같은 값을 계산하고 시간 차가 5분 이내인지 확인하세요.">
              <input id="notify-secret" className="input" type="password" autoComplete="new-password" value={dr.secret} onChange={(e) => set({ secret: e.target.value, removeSecret: false })} placeholder={editing && channel!.config.hasSecret ? '비워 두면 기존 비밀값 유지' : ''} />
              {show('secret')}
              {editing && channel!.config.hasSecret && !dr.secret ? <Toggle id="notify-secret-remove" checked={dr.removeSecret} onChange={(v) => set({ removeSecret: v })} label="서명 비밀값 지우기" /> : null}
            </Field>
          </>
        ) : null}
        {dr.type === 'email' ? (
          <Field id="notify-mail" label="수신자 이메일 (최대 20명)" hint={editing ? `비워 두면 기존 수신자 유지 (${(channel!.config.recipients ?? []).join(', ')})` : '쉼표 · 줄바꿈으로 구분. 메일은 서버 SMTP 설정(SMTP_HOST)이 있어야 나갑니다 — 없으면 발송 이력에 사유와 함께 남습니다.'}>
            <textarea id="notify-mail" className="textarea" rows={3} value={dr.recipients} onChange={(e) => set({ recipients: e.target.value })} placeholder="marketing@brand.kr, pm@agency.kr" />
            {show('recipients')}
          </Field>
        ) : null}
        <Field label="받을 등급" hint="P1 · 즉시, P2 · 1시간 내, P3 · 24시간 내 (제안서 p.44 등급 기준)">
          <Segmented<Severity> label="받을 등급" value={dr.minSeverity} onChange={(v) => set({ minSeverity: v })} options={SEVERITY_SCOPE} />
        </Field>
        <Field label="받을 이벤트">
          <div className="notify-events">
            {EVENT_OPTIONS.map((o) => (
              <div key={o.id} className="stack-sm" style={{ gap: 2 }}>
                <Toggle id={`notify-ev-${o.id}`} checked={dr.events.includes(o.id)} onChange={(v) => toggleEvent(o.id, v)} label={o.label} />
                <span className="xs muted">{o.hint}</span>
              </div>
            ))}
          </div>
          {show('events')}
        </Field>
        <Toggle id="notify-enabled" checked={dr.enabled} onChange={(v) => set({ enabled: v })} label="채널 켜기 (끄면 발송하지 않고 이력에 '보내지 않음'으로 남김)" />
        {err ? <Callout tone="critical" title="서버가 저장을 거절했습니다">{err}</Callout> : null}
      </div>
    </Modal>
  );
}

/* ============================== 미리보기 ============================== */

type PreviewKind = 'slack' | 'email' | 'webhook';
interface SlackBlock { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { text?: string | { text: string }; url?: string }[] }

/** mrkdwn 표시: *굵게* → 굵게, 이스케이프 해제 */
function Mrkdwn({ text }: { text: string }) {
  const lines = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n');
  return <>{lines.map((l, k) => {
    const m = l.match(/^\*(.+)\*$/);
    return <div key={k}>{m ? <strong>{m[1]}</strong> : l}</div>;
  })}</>;
}

export function PreviewCard() {
  const store = useStoreOptional();
  const saas = useSaas();
  const [kind, setKind] = useState<PreviewKind>('slack');
  const open = ((store?.state.incidents ?? []) as AlertIncident[]).filter((i) => i.status !== 'resolved');
  const inc = open.find((i) => i.severity === 'P1') ?? open[0] ?? DEMO_INCIDENTS.find((i) => i.severity === 'P1') ?? DEMO_INCIDENTS[0];
  const fromStore = !!open.length;
  const appUrl = typeof window !== 'undefined' && window.location?.origin?.startsWith('http') ? window.location.origin : 'https://<MILDO OS 주소>';
  const msg: Message | null = useMemo(() => (inc ? buildMessage({
    event: 'incident', appUrl, sentAtMs: Date.parse(inc.detectedAt) || 0,
    workspace: { id: saas.workspace?.id ?? 'demo', slug: saas.workspace?.slug ?? 'mildo', name: saas.workspace?.name ?? '수면밀도 퍼포먼스', brand_name: saas.workspace?.brand_name ?? '수면밀도' },
    incident: inc,
  }) : null), [inc, appUrl, saas.workspace]);
  if (!msg || !inc) return null;
  const blocks = msg.slack.blocks as SlackBlock[];
  return (
    <Card title="메시지 미리보기" sub="실제 발송과 같은 함수로 만든 형식입니다 — 등급 · 기준 · 관측 · 변화 · 원인 후보 상위 2 · 영향(추정) · SLA 기한 · 이슈 링크."
      actions={<>{fromStore && !inc.isTest ? <Src kind="DEMO" /> : <span className="src demo" title="데모 이슈로 만든 예시">TEST DATA</span>}<Segmented<PreviewKind> label="미리보기 형식" value={kind} onChange={setKind} options={[{ id: 'slack', label: 'Slack' }, { id: 'email', label: '이메일' }, { id: 'webhook', label: '웹훅 JSON' }]} /></>}>
      {kind === 'slack' ? (
        <div className="notify-slack">
          {blocks.map((b, k) => {
            if (b.type === 'header') return <div key={k} className="notify-slack-head">{b.text?.text}</div>;
            if (b.type === 'section') return (
              <div key={k} className="notify-slack-sec">
                {b.text ? <Mrkdwn text={b.text.text} /> : null}
                {b.fields ? <div className="notify-slack-fields">{b.fields.map((f, j) => <div key={j}><Mrkdwn text={f.text} /></div>)}</div> : null}
              </div>
            );
            if (b.type === 'context') return <div key={k} className="xs muted">{b.elements?.map((e) => (typeof e.text === 'string' ? e.text : e.text?.text)).join(' ')}</div>;
            if (b.type === 'actions') return <div key={k}>{b.elements?.map((e, j) => <span key={j} className="notify-slack-btn" title={e.url}>{typeof e.text === 'string' ? e.text : e.text?.text}</span>)}</div>;
            return null;
          })}
        </div>
      ) : kind === 'email' ? (
        <div className="stack-sm">
          <div className="small"><strong>제목</strong> {msg.subject}</div>
          <pre className="notify-pre">{msg.text}</pre>
        </div>
      ) : (
        <pre className="notify-pre">{JSON.stringify(msg.webhook, null, 2)}</pre>
      )}
    </Card>
  );
}

/* ============================== 발송 이력 ============================== */

export function LogTab({ d }: { d: NotifyData }) {
  const f = d.filter;
  const columns: Column<LogEntry>[] = [
    { key: 'at', label: '시각', render: (l) => <span className="num nowrap">{fmtIso(l.at)}</span>, sort: (l) => l.at, width: 96 },
    { key: 'ch', label: '채널', render: (l) => <div className="xs"><strong>{l.channelName}</strong><div className="muted">{l.channelType ? TYPE_LABEL[l.channelType as ChannelType] ?? l.channelType : '—'}</div></div> },
    { key: 'ev', label: '이벤트', render: (l) => <Pill tone={l.event === 'sla' ? 'serious' : l.event === 'channel_test' ? 'outline' : 'neutral'}>{EVENT_LABEL[l.event] ?? l.event}{l.detail.stage ? ` · ${({ ack: '인지', action: '1차 조치', report: '결과 보고' } as Record<string, string>)[l.detail.stage] ?? l.detail.stage}` : ''}</Pill> },
    { key: 'sev', label: '등급', render: (l) => (l.severity ? <Sev level={l.severity} /> : <span className="muted">—</span>), width: 56 },
    { key: 'st', label: '결과', render: (l) => <div className="xs"><Pill tone={l.status === 'sent' ? 'good' : l.status === 'failed' ? 'critical' : 'neutral'}>{STATUS_TEXT[l.status]}</Pill>{l.attempts > 1 ? <div className="muted">시도 {l.attempts}회</div> : null}{l.detail.retrying ? <div className="muted">재시도 대기</div> : null}</div>, sort: (l) => l.status },
    { key: 'body', label: '내용 · 사유', render: (l) => <div className="xs" style={{ maxWidth: 480 }}><div>{l.detail.subject ?? l.detail.title ?? l.refId ?? '—'}</div>{l.detail.reason ? <div className={l.status === 'failed' ? 'notify-err' : 'muted'}>{l.detail.reason}</div> : null}{l.detail.httpStatus ? <div className="muted">응답 {l.detail.httpStatus}</div> : null}</div> },
  ];
  return (
    <Card title="발송 이력" sub="잡 하나가 한 줄입니다. 5xx · 시간 초과는 같은 줄에서 재시도 횟수가 늘고, 등급 기준 밖 · 꺼진 채널 · 발송 전에 해결된 이슈는 '보내지 않음'과 사유로 남습니다."
      actions={d.demo ? <span className="src demo">TEST DATA</span> : undefined}>
      <div className="row" style={{ gap: 8 }}>
        <select className="select" aria-label="결과" style={{ width: 'auto' }} value={f.status} onChange={(e) => d.setFilter({ ...f, status: e.target.value })}>
          <option value="">결과 전체</option>
          {(['sent', 'failed', 'skipped'] as const).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
        </select>
        <select className="select" aria-label="이벤트" style={{ width: 'auto' }} value={f.event} onChange={(e) => d.setFilter({ ...f, event: e.target.value })}>
          <option value="">이벤트 전체</option>
          {[...EVENT_OPTIONS.map((o) => o.id as string), 'channel_test'].map((e) => <option key={e} value={e}>{EVENT_LABEL[e]}</option>)}
        </select>
        <select className="select" aria-label="채널" style={{ width: 'auto' }} value={f.channelId} onChange={(e) => d.setFilter({ ...f, channelId: e.target.value })}>
          <option value="">채널 전체</option>
          {d.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <DataTable rows={d.log} columns={columns} rowKey={(l) => String(l.id)} maxHeight={560} empty={<Empty icon="inbox" title="조건에 맞는 발송 이력이 없습니다" />} />
      {d.nextBefore ? <Button size="sm" onClick={once(() => void d.loadMore())}>이전 이력 더 보기</Button> : null}
    </Card>
  );
}

/* ============================== SLA · 에스컬레이션 ============================== */

export function PolicyTab({ policy, demo }: { policy: Policy; demo: boolean }) {
  const rows = slaRows(policy.sla, policy.weekendAckMin);
  const columns: Column<SlaRow>[] = [
    { key: 'sev', label: '등급', render: (r) => <div className="row" style={{ gap: 6 }}><Sev level={r.severity} /><span className="xs muted">{r.label}</span></div> },
    { key: 'ack', label: '인지', render: (r) => r.ack },
    { key: 'action', label: '1차 조치', render: (r) => r.action },
    { key: 'report', label: '결과 보고', render: (r) => r.report },
    { key: 'weekend', label: '주말 · 공휴일 인지', render: (r) => r.weekendAck },
    { key: 'esc', label: '기한 초과 시', render: (r) => <span className="xs">{r.escalation}</span> },
  ];
  return (
    <div className="stack-lg">
      <Card title="등급별 SLA" sub="감지 시각(서버가 이슈를 잡은 시각)부터 잽니다. 인지 · 1차 조치 · 결과 보고 기록 시각은 서버 시계로 남겨 화면에서 바꿀 수 없습니다."
        actions={<><Src kind="PROPOSAL" page="p.49" />{demo ? <span className="src demo">기본값</span> : <Src kind="LIVE" title="워크스페이스 설정 반영" />}</>}>
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.severity} />
      </Card>
      <div className="grid g-2">
        <Card title="에스컬레이션 규칙" sub="1분마다 열린 이슈를 확인합니다">
          <div className="stack-sm small">
            <div>단계 기한이 지났는데 해당 처리(인지 · 1차 조치 · 결과 보고)가 없으면 이슈 타임라인에 '에스컬레이션: 단계 기한 초과'를 남기고, 'SLA 기한 초과' 이벤트를 켠 채널로 알립니다.</div>
            <div>같은 단계는 한 번만 알립니다. 처리한 단계 · 해결한 이슈는 다시 알리지 않습니다.</div>
            <div>담당이 비어 있으면 그날의 운영 체계(평일 매체 담당 · 주말 · 공휴일 당번)로 채우고, 운영자가 정한 담당은 바꾸지 않습니다.</div>
            <div>서버는 이슈를 자동으로 해결하지 않습니다. 더 이상 감지되지 않는 이슈는 '더 이상 감지되지 않음'으로 표시만 하고 운영자 확인을 기다립니다.</div>
          </div>
        </Card>
        <Card title="주말 · 공휴일 대응 체계" actions={<Src kind="PROPOSAL" page="p.48" />}>
          <DataTable rows={[...policy.tiers]} rowKey={(r) => r.tier} columns={[
            { key: 'tier', label: '단계', render: (r) => <strong>{r.tier}</strong> },
            { key: 'who', label: '담당', render: (r) => r.who },
            { key: 'what', label: '역할', render: (r) => r.what },
            { key: 'when', label: '기준', render: (r) => r.when },
          ]} />
        </Card>
      </div>
    </div>
  );
}

/* ============================== 당번표 ============================== */

export function RosterTab({ policy, demo }: { policy: Policy; demo: boolean }) {
  const r = policy.regime;
  const columns: Column<DutyRow>[] = [
    { key: 'date', label: '날짜', render: (x) => <span className="num nowrap">{fmtDateShort(x.date)}</span>, sort: (x) => x.date, width: 90 },
    { key: 'label', label: '휴무', render: (x) => x.label },
    { key: 'role', label: '당번 (1차 확인 30분)', render: (x) => <strong>{x.role}</strong> },
    { key: 'backup', label: '백업', render: (x) => x.backup },
    { key: 'esc', label: '에스컬레이션', render: (x) => <span className="xs">{x.escalation}</span> },
  ];
  return (
    <Card title="주말 · 공휴일 당번표 (향후 60일)" sub="서버 감지 · SLA 에스컬레이션이 같은 순번을 씁니다. 주말은 토 · 일 같은 당번, 평일 공휴일은 날짜 순번입니다. TF 실명 · 순번 변경은 워크스페이스 설정에서 관리합니다."
      actions={<><Pill tone={r.off ? 'dark' : 'neutral'} icon="calendar">{r.off ? `오늘 ${r.label} · 당번 ${r.duty?.role ?? '—'} · 백업 ${r.duty?.backup ?? '—'}` : `오늘(${fmtDateShort(policy.today)}) 평일 체계 · 매체 담당 배정`}</Pill>{demo ? <span className="src demo">데모 기준일</span> : null}</>}>
      <DataTable rows={policy.roster} columns={columns} rowKey={(x) => x.date} maxHeight={520} empty={<Empty icon="calendar" title="60일 안에 주말 · 공휴일이 없습니다" />} />
    </Card>
  );
}

/* ============================== 감지 기록 ============================== */

export function RunsTab({ d, ws, canOperate }: { d: NotifyData; ws: string | null; canOperate: boolean }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const noPerm = d.demo ? '데모 모드 · 서버 연결 시 사용' : !canOperate ? '수동 감지는 담당 AE 이상 권한' : undefined;
  const scan = async () => {
    if (busy || !ws) return;
    setBusy(true);
    try {
      const r = await remote.runScan(ws);
      actions.toast({ tone: r.warning ? 'warning' : r.created ? 'critical' : 'good', title: r.warning ? '감지를 건너뛰었습니다' : `감지 완료 · 신규 ${r.created}건`, body: r.warning ?? `감지 ${r.found}건 중 기존 ${r.found - r.created}건은 처리 이력 유지 · 알림 잡 ${r.notified}건`, route: 'alert' });
      await d.reload('runs');
    } catch (e) {
      actions.toast({ tone: 'warning', title: '감지를 실행하지 못했습니다', body: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const columns: Column<ScanRun>[] = [
    { key: 'at', label: '실행', render: (x) => <span className="num nowrap">{fmtIso(x.startedAt)}</span>, sort: (x) => x.startedAt, width: 96 },
    { key: 'trigger', label: '계기', render: (x) => TRIGGER_LABEL[x.trigger] ?? x.trigger },
    { key: 'status', label: '결과', render: (x) => <Pill tone={x.status === 'ok' ? 'good' : x.status === 'warning' ? 'warning' : 'critical'}>{x.status === 'ok' ? '정상' : x.status === 'warning' ? '경고' : '실패'}</Pill> },
    { key: 'found', label: '감지', align: 'right', render: (x) => <span className="num">{x.found}</span> },
    { key: 'created', label: '신규', align: 'right', render: (x) => <span className="num">{x.created}</span> },
    { key: 'cleared', label: '더 이상 감지 안 됨', align: 'right', render: (x) => <span className="num">{x.cleared}</span> },
    { key: 'notified', label: '알림 잡', align: 'right', render: (x) => <span className="num">{x.notified}</span> },
    { key: 'data', label: '데이터 기준', render: (x) => <span className="xs">{x.dataToday ? `${fmtDateShort(x.dataToday)} ${x.dataHour !== null ? `${String(x.dataHour).padStart(2, '0')}시` : ''}` : '—'}{x.dataMode ? ` · ${x.dataMode === 'demo' ? 'TEST DATA' : x.dataMode === 'live' ? 'LIVE' : 'LIVE + TEST'}` : ''}</span> },
    { key: 'warn', label: '경고', render: (x) => (x.warning ? <span className="xs notify-err">{x.warning}</span> : <span className="muted">—</span>) },
  ];
  return (
    <Card title="24시간 감지 기록" sub="수집 직후와 10분마다 서버가 MILDO Alert 탐지 엔진을 실행합니다. 같은 이슈는 결정적 id로 한 번만 만들고, 운영자가 처리한 내용은 다시 감지해도 바뀌지 않습니다. 최근 30일 보관."
      actions={<>{d.demo ? <span className="src demo">TEST DATA</span> : null}<Button size="sm" variant="primary" icon="zap" disabled={!!noPerm || busy} title={noPerm} onClick={once(() => void scan())}>{busy ? '감지 중' : '지금 감지 실행'}</Button></>}>
      <DataTable rows={d.runs} columns={columns} rowKey={(x) => String(x.id)} maxHeight={520} empty={<Empty icon="clock" title="감지 실행 기록이 없습니다">워커가 켜지면 10분 안에 첫 기록이 생깁니다.</Empty>} />
    </Card>
  );
}
