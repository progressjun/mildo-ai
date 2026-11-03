/**
 * 성과 증명 (관리 · 07 VALUE LEDGER) — 반영한 변경 · 막은 사고 · 줄인 시간을 장부로 측정해 월 구독료 대비 회수 배수를 보여 준다.
 * 리포트 보관함(서버 예약 생성 · 발송 기록)도 이 화면에서 본다.
 *
 * 서버 모드: GET /impact/summary · /impact/ledger · /reports (권한은 서버가 최종 판정 — 화면은 operate 권한에 맞춰 버튼만 막는다).
 * 데모 모드(claude.ai 아티팩트 · 서버 없음): 데모 데이터(TEST DATA)로 같은 추정기를 돌린 예시를 읽기 전용으로 보여 주고,
 *   실제 값은 서버의 반영 이력 · 사고 조치 기록 · 자동 실행 기록이 쌓여야 계산된다는 안내를 붙인다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import './styles.css';
import { useActions, useStoreOptional } from '@/core/store';
import { navigate } from '@/core/router';
import { DEMO } from '@/data/demo';
import { fmt } from '@/core/util';
import { useSaas } from '@/saas/context';
import { onServerEvent } from '@/saas/events';
import { Markdown } from '@/ui/Markdown';
import { Button, Callout, Card, DataTable, DownloadButton, Drawer, Empty, PageHeader, Pill, Segmented, Src, Stat, Tabs, type Column, type Tone } from '@/ui/primitives';
import {
  buildDemoImpact, buildValueReport, CONFIDENCE_LABEL, estimateText, hoursText, krw, krwFull, ledgerCsv, monthLabel, prevMonth, profitAt, SOURCE_LABEL, statusText, times,
  type Confidence, type ImpactComponent, type ImpactSummary, type LedgerEntry, type LedgerStatus, type SourceType,
} from './engine';
import * as remote from './api';
import { REPORT_KIND_LABEL, TRIGGER_LABEL, type ReportItem, type ReportKind, type ScheduleRow } from './api';

type TabId = 'proof' | 'ledger' | 'reports';
const errText = (e: unknown) => (e as { message?: string })?.message ?? '요청을 처리하지 못했습니다';
/** 더블클릭의 두 번째 클릭은 무시 (버튼이 같은 자리에서 바뀌는 화면 공통 규칙) */
const once = (fn: () => void) => (e: MouseEvent<HTMLButtonElement>) => { if (e.detail > 1) return; fn(); };
const kstNowMonth = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
const fmtIso = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const s = new Date(ms + 9 * 3600_000).toISOString();
  return `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))} ${s.slice(11, 16)}`;
};
const CONF_TONE: Record<Confidence | 'none', Tone> = { high: 'good', medium: 'warning', low: 'serious', none: 'outline' };
const STATUS_TONE: Record<LedgerStatus, Tone> = { measured: 'good', insufficient: 'warning', pending: 'neutral', excluded: 'outline' };
const MODE_LABEL: Record<string, string> = { live: '매체 반영됨 (live)', dry_run: '매체 미반영 (dry-run 기록)', none: '기록만', failed: '반영 실패', unknown: '실행 기록 없음', example: '예시' };
const ROUTE_LABEL: Record<string, string> = { flow: 'MILDO Flow에서 보기', alert: 'MILDO Alert에서 보기', adpilot: 'AD Pilot에서 보기', connections: '데이터 연결 보기', notify: '알림 설정 보기', impact: '보관함 보기' };

export interface ImpactData {
  demo: boolean;
  loading: boolean;
  error: string | null;
  /** 서버 모드: 지금 대상 월의 요약을 서버에서 읽었는지 (false면 수치 대신 오류 · 다시 시도 — 예시 값을 서버 값처럼 보여 주지 않는다). 생략 = 읽음 */
  ready?: boolean;
  month: string;
  months: string[];
  summary: ImpactSummary;
  entries: LedgerEntry[];
  /** 서버 모드: 같은 추정기로 지금 Dataset(데모 커넥션이면 TEST DATA)에서 만든 예시 — 장부가 TEST DATA뿐일 때 시연용으로 보여 준다 */
  example: { summary: ImpactSummary; entries: LedgerEntry[] } | null;
  reload: () => Promise<void>;
}

/** 서버 모드: API, 데모 모드: 데모 Dataset으로 만든 예시 (같은 추정기) */
export function useImpactData(ws: string | null, month: string): ImpactData {
  const store = useStoreOptional();
  const data = store?.state.data ?? DEMO;
  const incidents = store?.state.incidents ?? [];
  const demoState = useMemo(() => buildDemoImpact(data, incidents), [data, incidents]);
  const [summary, setSummary] = useState<ImpactSummary | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(!!ws);
  const [error, setError] = useState<string | null>(null);
  // 요청 순번 — 대상 월을 빠르게 바꿀 때 늦게 온 이전 월 응답이 화면을 덮지 않게
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!ws) return;
    const my = ++seq.current;
    const [s, l] = await Promise.allSettled([remote.fetchSummary(ws, month), remote.fetchLedger(ws, month)]);
    if (my !== seq.current) return;
    setSummary(s.status === 'fulfilled' ? s.value : null);
    setEntries(l.status === 'fulfilled' ? l.value : []);
    const bad = [s, l].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(bad ? errText(bad.reason) : null);
    setLoading(false);
  }, [ws, month]);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    void reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onServerEvent('report', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 1200);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [ws, reload]);

  if (!ws) {
    return { demo: true, loading: false, error: null, month: demoState.month, months: [demoState.month], summary: demoState.summary, entries: demoState.entries, example: null, reload: async () => undefined };
  }
  const ready = !!summary && summary.month === month;
  // summary 자리 값은 타입을 맞추는 자리표시일 뿐 — ready가 false면 화면은 수치를 그리지 않는다
  return { demo: false, loading, error, ready, month, months: monthOptions(kstNowMonth()), summary: ready ? summary : demoState.summary, entries: ready ? entries : [], example: demoState, reload };
}

/** 최근 12개월 (이번 달부터) */
export function monthOptions(cur: string): string[] {
  const months: string[] = [];
  for (let m = cur, i = 0; i < 12; i++, m = prevMonth(m)) months.push(m);
  return months;
}

export default function View() {
  const saas = useSaas();
  const ws = saas.mode === 'server' ? saas.workspace?.id ?? null : null;
  const [month, setMonth] = useState(kstNowMonth);
  const d = useImpactData(ws, month);
  return (
    <ImpactScreen d={d} ws={ws} canOperate={!d.demo && saas.can('operate')} onMonth={setMonth}
      workspaceName={saas.workspace?.brand_name || saas.workspace?.name || ''} />
  );
}

export interface ImpactScreenProps {
  d: ImpactData;
  ws: string | null;
  canOperate: boolean;
  workspaceName?: string;
  onMonth?: (month: string) => void;
  initialTab?: TabId;
  /** 테스트 · 미리보기: 리포트 보관함 초기 목록 · 일정 (서버에서 읽기 전 값) */
  reportsSeed?: { reports: ReportItem[]; schedule: ScheduleRow[] };
}

/** 성과 증명 화면 (상태 · 서버 호출은 바깥에서 — 데모 · 서버 모드 모두 이 화면을 그린다) */
export function ImpactScreen({ d, ws, canOperate, workspaceName = '', onMonth, initialTab = 'proof', reportsSeed }: ImpactScreenProps) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [showExample, setShowExample] = useState(false);
  // 서버 장부가 TEST DATA(데모 커넥션)뿐이면 측정 · 추정 대상이 없다 — 같은 추정기로 만든 예시를 따로 볼 수 있게 한다
  const ready = d.demo || d.ready !== false;
  const demoOnly = !d.demo && !d.loading && ready && d.summary.dataMode === 'demo';
  const example = demoOnly && showExample ? d.example : null;
  const s = example?.summary ?? d.summary;
  const entries = example?.entries ?? d.entries;
  const isExample = d.demo || !!example;
  const showData = d.demo || (!d.loading && ready);
  const dataLabel = isExample ? 'TEST DATA 예시' : s.dataMode === 'live' ? 'LIVE DATA' : s.dataMode === 'mixed' ? '일부 TEST DATA' : 'TEST DATA';
  const counts = s.counts.change;

  return (
    <div className="page impact-page">
      <PageHeader
        eyebrow="07 · VALUE LEDGER · MILDO OS CLOUD"
        title="성과 증명"
        sub="반영한 변경은 대조군과 비교해 측정하고, 막은 사고는 조치 시간으로 손실 회피를 추정하고, 자동화로 줄인 시간은 실행 기록으로 셉니다. 셋을 월 구독료와 나눠 회수 배수로 보여 주며, 측정 · 추정 · 가정을 섞지 않습니다."
        sources={<>
          <Src kind="PROPOSAL" page="p.11 · p.19" />
          {isExample || s.dataMode !== 'live' ? <span className="src demo" title={isExample ? '데모 데이터로 만든 예시 · 실제 반영 이력 아님' : '데모 커넥션 데이터 포함'}>TEST DATA</span> : <Src kind="LIVE" title="서버 장부 (실연동 데이터)" />}
          <span className="xs muted">{d.demo ? '예시 상태 · 읽기 전용' : `워크스페이스 ${workspaceName} · ${canOperate ? '즉시 측정 · 리포트 생성 · 발송 가능' : '읽기 전용 (측정 · 생성 · 발송은 담당 AE 이상)'}`}</span>
        </>}
        actions={<>
          <label className="row xs muted" style={{ gap: 6 }}>
            <span>대상 월</span>
            <select id="impact-month" className="input" value={d.month} disabled={d.demo || !!example} onChange={(e) => onMonth?.(e.target.value)} title={d.demo ? '데모 모드는 예시 월 하나만 보여 줍니다' : undefined}>
              {d.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
          {!d.demo ? <MeasureButton ws={ws!} canOperate={canOperate} onDone={d.reload} /> : null}
        </>}
      />

      {d.demo ? (
        <Callout tone="accent" title="서버 연결 시 실제로 동작합니다">
          지금 화면은 데모 데이터(TEST DATA) 키워드 14일 값에서 '7일째에 입찰을 바꿨다'고 가정해 같은 추정기로 계산한 예시입니다. 실제 회수 배수는 MILDO OS Cloud 서버에
          매체 반영(live) 이력 · 사고 조치 기록 · 자동 수집 · 리포트 · 감지 실행 기록이 쌓여야 계산되며, 서버는 매일 06:00에 장부를 갱신합니다.
        </Callout>
      ) : null}
      {demoOnly ? (
        <Callout tone="info" title={example ? 'TEST DATA 예시를 보는 중입니다 (서버 장부 아님)' : '이 워크스페이스 장부는 TEST DATA(데모 커넥션)뿐입니다'}>
          {example
            ? '지금 Dataset(데모 커넥션 · TEST DATA) 키워드 14일 값에서 7일째 반영을 가정해 같은 추정기로 계산한 예시입니다. 서버 장부 값이 아니며 회수 배수 판단에 쓰지 않습니다.'
            : '데모 커넥션 반영 · TEST DATA 이슈 · 데모 수집 실행은 성과 집계에서 제외되어 회수 배수가 판정 보류로 나옵니다. 실연동 커넥션을 연결하고 변경을 live로 반영하면 매일 06:00 측정에서 채워집니다.'}
          <div style={{ marginTop: 6 }}>
            <Button size="sm" variant={example ? 'ghost' : 'primary'} onClick={once(() => setShowExample((v) => !v))}>{example ? '서버 장부로 돌아가기' : 'TEST DATA 예시로 보기'}</Button>
          </div>
        </Callout>
      ) : null}
      {d.error ? <Callout tone="critical" title="서버에서 불러오지 못했습니다">{d.error}</Callout> : null}

      {showData ? <PaybackHero s={s} dataLabel={dataLabel} demo={isExample} /> : d.loading ? <Empty icon="clock" title="불러오는 중" /> : (
        <Empty icon="alert" title="서버 장부를 불러오지 못했습니다">
          회수 배수 · 장부 수치는 서버에서 읽은 값만 보여 줍니다 (예시 값으로 대신하지 않음).
          <div style={{ marginTop: 8 }}><Button size="sm" icon="refresh" onClick={once(() => void d.reload())}>다시 시도</Button></div>
        </Empty>
      )}

      {showData ? (
        <div className="grid g-4">
          <Stat label="측정된 증분 이익" value={krw(s.totals.measuredUpliftProfit.point)} foot={<span className="xs muted">증분 매출 {krw(s.totals.measuredUpliftRevenue.point)} · 측정 {counts.measured}건 · 표본 부족 {counts.insufficient} · 관측 중 {counts.pending} · 제외 {counts.excluded}</span>} />
          <Stat label="추정 손실 회피 (추정)" value={krw(s.totals.lossAvoidedEst)} foot={<span className="xs muted">원 환산 {krw(s.components[1].valueKrw)} (× 공헌이익률) · 사고 {s.counts.incident.measured}건</span>} />
          <Stat label="절감 시간 (가정 기반)" value={hoursText(s.totals.hoursSaved)} foot={<span className="xs muted">원 환산 {krw(s.components[2].valueKrw)} · 시간당 {krw(s.config.hourlyCost)}</span>} />
          <Stat label="월 구독료" value={krw(s.totals.costOfSubscription)} foot={<span className="xs muted">{s.config.sources.monthlyFee === 'workspace' ? '워크스페이스 설정' : '기본값 · 계약 시 확정'}</span>} />
        </div>
      ) : null}

      <Tabs<TabId> value={tab} onChange={setTab} tabs={[
        { id: 'proof', label: '구성 요소 · 전제' },
        { id: 'ledger', label: '장부', badge: <Pill tone="outline">{entries.length}</Pill> },
        { id: 'reports', label: '리포트 보관함' },
      ]} />

      {tab === 'proof' && showData ? <ProofTab s={s} /> : null}
      {tab === 'ledger' && showData ? <LedgerTab entries={entries} month={s.month} demo={isExample} margin={s.config.margin} ws={example ? null : ws} /> : null}
      {tab === 'reports' ? <ReportsTab ws={ws} month={d.month} canOperate={canOperate} demoSummary={d.demo ? s : null} demoEntries={d.demo ? entries : null} seed={reportsSeed} /> : null}
    </div>
  );
}

function MeasureButton({ ws, canOperate, onDone }: { ws: string; canOperate: boolean; onDone: () => Promise<void> }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" icon="refresh" disabled={!canOperate || busy} title={canOperate ? '매일 06:00 예약 측정과 같은 계산을 지금 실행' : '즉시 측정은 담당 AE 이상 권한'}
      onClick={once(async () => {
        setBusy(true);
        try {
          const r = await remote.measureNow(ws);
          actions.toast({ tone: 'good', title: '장부를 다시 측정했습니다', body: `변경 측정 ${r.result.changes.measured ?? 0} · 표본 부족 ${r.result.changes.insufficient ?? 0} · 관측 중 ${r.result.changes.pending ?? 0} · 사고 ${r.result.incidents.measured ?? 0}건` });
          await onDone();
        } catch (e) {
          actions.toast({ tone: 'warning', title: '측정하지 못했습니다', body: errText(e) });
        } finally {
          setBusy(false);
        }
      })}>{busy ? '측정 중' : '지금 측정'}</Button>
  );
}

/* ============================== 회수 배수 ============================== */

function PaybackHero({ s, dataLabel, demo }: { s: ImpactSummary; dataLabel: string; demo: boolean }) {
  const pb = s.totals.paybackMultiple;
  const c = s.config;
  const src = (k: keyof typeof c.sources) => (c.sources[k] === 'workspace' ? '워크스페이스 설정' : '기본값');
  return (
    <Card className="impact-hero">
      <div className="impact-hero-row">
        <div className="stack-sm" style={{ gap: 4 }}>
          <div className="xs muted">{monthLabel(s.month)} 구독료 대비 회수 배수 · {dataLabel}{demo && !dataLabel.includes('예시') ? ' · 예시' : ''}</div>
          {/* 판정 보류(측정 · 추정 항목 없음)는 0배가 아니라 값 없음 — 0.0배로 그리면 '회수 0'으로 읽힌다 */}
          <div className="impact-big num">{s.verdict.tone === 'neutral' ? '—' : times(pb.point)}</div>
          {s.verdict.tone === 'neutral'
            ? <div className="small ink2">이 달에 측정 · 추정된 항목이 없어 회수 배수를 계산하지 않았습니다</div>
            : <div className="small ink2">80% 구간 {times(pb.lo)} ~ {times(pb.hi)} <span className="muted">(측정 증분의 불확실성만 반영 · 손실 회피 · 절감 시간은 점추정)</span></div>}
        </div>
        <div className="stack-sm impact-verdict" style={{ gap: 4 }}>
          <Pill tone={s.verdict.tone === 'neutral' ? 'outline' : s.verdict.tone} icon={s.verdict.tone === 'good' ? 'check' : 'alert'}>{s.verdict.label}</Pill>
          <span className="xs muted">기준: {s.verdict.basis}</span>
        </div>
      </div>
      <div className="impact-formula">
        <div className="small"><strong>{s.formula}</strong></div>
        <div className="xs impact-filled">{s.formulaFilled}</div>
      </div>
      <ul className="impact-assume xs">
        <li>월 구독료 {krwFull(c.monthlyFee)} · {src('monthlyFee')}</li>
        <li>공헌이익률 {fmt.pct(c.margin * 100, 0)} · {src('margin')} (광고비 차감 전 매출 대비 이익률)</li>
        <li>시간당 인건비 {krwFull(c.hourlyCost)} · {src('hourlyCost')}</li>
        <li>손실 회피는 추정, 절감 시간은 제안서 p.19 기준 가정 — 측정된 증분과 근거 수준이 다릅니다</li>
      </ul>
    </Card>
  );
}

/* ============================== 구성 요소 ============================== */

function ProofTab({ s }: { s: ImpactSummary }) {
  const columns: Column<ImpactComponent>[] = [
    { key: 'label', label: '구성 요소', render: (c) => <strong>{c.label}</strong> },
    {
      key: 'krw', label: '원 환산', align: 'right', render: (c) => (
        <div className="stack-sm" style={{ gap: 2, alignItems: 'flex-end' }}>
          <span className="num bold">{krwFull(c.valueKrw)}</span>
          {c.valueKrwInterval ? <span className="xs muted nowrap">80% {krw(c.valueKrwInterval.lo)} ~ {krw(c.valueKrwInterval.hi)}</span> : <span className="xs muted">{c.id === 'loss' ? '추정 · 구간 없음' : '가정 기반 · 구간 없음'}</span>}
        </div>
      ),
      sort: (c) => c.valueKrw,
    },
    { key: 'raw', label: '원값', render: (c) => <div className="xs stack-sm" style={{ gap: 2 }}>{c.raw.map((r) => <span key={r.label} className="nowrap">{r.label} {r.unit === '시간' ? hoursText(r.value) : krw(r.value)}</span>)}</div> },
    { key: 'method', label: '방법 · 환산', render: (c) => <div className="xs" style={{ maxWidth: 320 }}><div>{c.method}</div><div className="muted">{c.conversion}</div></div> },
    { key: 'conf', label: '신뢰도', render: (c) => <div className="stack-sm" style={{ gap: 2, maxWidth: 220, alignItems: 'flex-start' }}><Pill tone={CONF_TONE[c.confidence]}>{c.confidence === 'none' ? '측정 없음' : CONFIDENCE_LABEL[c.confidence]}</Pill><span className="xs muted">기준: {c.confidenceBasis}</span></div> },
    {
      key: 'sample', label: '표본 충분성', render: (c) => (
        <div className="xs" style={{ maxWidth: 220 }}>
          <div>측정 {c.sample.measured} · 표본 부족 {c.sample.insufficient} · 관측 중 {c.sample.pending} · 제외 {c.sample.excluded}</div>
          <div className="muted">{c.sample.note}</div>
        </div>
      ),
    },
  ];
  return (
    <div className="stack-lg">
      <Card title="구성 요소" sub="회수 배수 분자에 들어가는 세 항목입니다. 측정된 증분만 대조군 비교 · 구간이 있고, 손실 회피는 추정, 절감 시간은 제안서 기준 가정으로 환산합니다.">
        <DataTable rows={s.components} columns={columns} rowKey={(c) => c.id} />
      </Card>
      <div className="grid g-2">
        <Card title="전제 조건 · 기준값">
          <ul className="impact-list small">{s.conditions.map((x) => <li key={x}>{x}</li>)}</ul>
          {s.components.map((c) => (
            <div key={c.id} className="stack-sm" style={{ marginTop: 10, gap: 4 }}>
              <strong className="small">{c.label}</strong>
              <ul className="impact-list xs muted">{c.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
          ))}
        </Card>
        <Card title="반례 · 대체 시나리오" sub="이런 경우 회수 배수가 과대 또는 과소 추정됩니다.">
          <ul className="impact-list small">{s.counterExamples.map((x) => <li key={x}>{x}</li>)}</ul>
        </Card>
      </div>
    </div>
  );
}

/* ============================== 장부 ============================== */

function windowText(w: LedgerEntry['baseline']): string {
  if (!w) return '—';
  return `매출 ${krw(w.revenue)} · 광고비 ${krw(w.cost)} · 클릭 ${fmt.int(w.clicks)} · 전환 ${fmt.dec1(w.conversions)}`;
}

function LedgerTab({ entries, month, demo, margin, ws }: { entries: LedgerEntry[]; month: string; demo: boolean; margin: number; ws: string | null }) {
  const [type, setType] = useState<SourceType | 'all'>('all');
  const [status, setStatus] = useState<LedgerStatus | 'all'>('all');
  const [open, setOpen] = useState<LedgerEntry | null>(null);
  const rows = entries.filter((e) => (type === 'all' || e.sourceType === type) && (status === 'all' || e.status === status));
  const columns: Column<LedgerEntry>[] = [
    { key: 'type', label: '구분', render: (e) => <Pill tone={e.sourceType === 'change' ? 'accent' : e.sourceType === 'incident' ? 'serious' : 'neutral'}>{SOURCE_LABEL[e.sourceType]}</Pill>, sort: (e) => e.sourceType },
    {
      key: 'label', label: '대상', render: (e) => (
        <div className="stack-sm" style={{ gap: 2, maxWidth: 260 }}>
          <strong className="small">{e.label}</strong>
          <span className="xs muted">{fmtIso(e.occurredAt)}{e.detail.test ? ' · TEST DATA' : ''}</span>
        </div>
      ),
      sort: (e) => e.occurredAt,
    },
    { key: 'before', label: '반영 전 7일', render: (e) => <span className="xs">{e.sourceType === 'change' ? windowText(e.baseline) : '—'}</span> },
    { key: 'after', label: '반영 후 7일', render: (e) => <span className="xs">{e.sourceType === 'change' ? windowText(e.observed) : '—'}</span> },
    {
      key: 'control', label: '대조군', render: (e) => e.control ? (
        <div className="xs" style={{ maxWidth: 200 }}>
          <div>{e.control.label} {e.control.units ? `(${e.control.units}개)` : ''}</div>
          {e.control.before && e.control.after ? <div className="muted">매출 {krw(e.control.before.revenue)} → {krw(e.control.after.revenue)}</div> : null}
        </div>
      ) : <span className="xs muted">—</span>,
    },
    {
      key: 'est', label: '추정', render: (e) => (
        <div className="stack-sm" style={{ gap: 2, maxWidth: 260 }}>
          <span className="xs">{estimateText(e)}</span>
          {e.estimate ? <span className="xs muted">{e.estimate.methodLabel} · 신뢰도 {CONFIDENCE_LABEL[e.estimate.confidence]}</span> : null}
        </div>
      ),
      sort: (e) => (e.estimate?.kind === 'uplift' ? e.estimate.revenue : e.estimate?.kind === 'loss' ? e.estimate.lossAvoided : e.estimate?.kind === 'hours' ? e.estimate.hours : -Infinity),
    },
    {
      key: 'status', label: '상태', render: (e) => (
        <div className="stack-sm" style={{ gap: 2, maxWidth: 220, alignItems: 'flex-start' }}>
          <Pill tone={STATUS_TONE[e.status]}>{statusText(e)}</Pill>
          {e.detail.reasons?.length ? <span className="xs muted">{e.detail.reasons.join(' · ')}</span> : e.detail.reason ? <span className="xs muted">{e.detail.reason}</span> : null}
        </div>
      ),
      sort: (e) => e.status,
    },
  ];
  return (
    <Card title={`장부 · ${monthLabel(month)}`} sub="근거 한 줄마다 원천(변경 · 사고 · 자동 실행 기록)과 반영 전 · 후 · 대조군 값, 추정 방법, 상태를 남깁니다. 행을 누르면 전제와 원천 화면 이동이 열립니다."
      actions={<>
        <DownloadButton filename={`impact-ledger-${month}.csv`} data={() => ledgerCsv(rows)} mime="text/csv;charset=utf-8" label="CSV 내보내기" />
        {ws ? <a className="btn ghost sm" href={`/api/w/${encodeURIComponent(ws)}/impact/ledger.csv?month=${encodeURIComponent(month)}`} download={`impact-ledger-${month}.csv`} title="필터와 관계없이 이 달 장부 전체 (서버에서 내려받기)">서버 CSV (전체)</a> : null}
      </>}>
      <div className="row" style={{ gap: 10, marginBottom: 10 }}>
        <Segmented<SourceType | 'all'> label="구분" value={type} onChange={setType} options={[{ id: 'all', label: '전체' }, { id: 'change', label: '변경' }, { id: 'incident', label: '사고' }, { id: 'automation', label: '자동화' }]} />
        <Segmented<LedgerStatus | 'all'> label="상태" value={status} onChange={setStatus} options={[{ id: 'all', label: '전체' }, { id: 'measured', label: '측정 완료' }, { id: 'insufficient', label: '표본 부족' }, { id: 'pending', label: '관측 중' }, { id: 'excluded', label: '제외' }]} />
      </div>
      <DataTable rows={rows} columns={columns} rowKey={(e) => e.id} onRowClick={setOpen} selectedKey={open?.id ?? null}
        empty={<Empty icon="inbox" title="이 달 장부가 비어 있습니다">{demo ? '데모 예시에는 이 조건의 항목이 없습니다.' : '매체에 live로 반영된 변경 · 해결된 사고 · 자동 실행 기록이 생기면 매일 06:00 측정에서 채워집니다.'}</Empty>} />
      {open ? <EntryDrawer e={open} onClose={() => setOpen(null)} margin={margin} /> : null}
    </Card>
  );
}

function EntryDrawer({ e, onClose, margin }: { e: LedgerEntry; onClose: () => void; margin: number }) {
  const x = e.estimate;
  const route = e.detail.route;
  return (
    <Drawer title={e.label} onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ gap: 6 }}>
          <Pill tone={STATUS_TONE[e.status]}>{statusText(e)}</Pill>
          <Pill tone="outline">{SOURCE_LABEL[e.sourceType]}</Pill>
          {e.detail.test ? <span className="src demo">TEST DATA</span> : null}
          <span className="xs muted">발생 · 반영 {fmtIso(e.occurredAt)} · 측정 {fmtIso(e.measuredAt)}</span>
        </div>
        <div className="xs muted">원천 {SOURCE_LABEL[e.sourceType]} id {e.sourceId}{e.detail.mode ? ` · 반영 방식 ${MODE_LABEL[e.detail.mode] ?? e.detail.mode}` : ''}{e.detail.rolledBackAt ? ` · 롤백 ${fmtIso(e.detail.rolledBackAt)}` : ''}</div>
        {e.detail.reason || e.detail.reasons?.length ? <Callout tone={e.status === 'insufficient' ? 'warning' : 'info'} title="상태 사유">{[e.detail.reason, ...(e.detail.reasons ?? [])].filter(Boolean).join(' · ')}</Callout> : null}
        {e.sourceType === 'change' ? (
          <div className="stack-sm">
            <div className="small"><strong>반영 전</strong> {windowText(e.baseline)}{e.baseline ? ` (${e.baseline.from}~${e.baseline.to})` : ''}</div>
            <div className="small"><strong>반영 후</strong> {windowText(e.observed)}{e.observed ? ` (${e.observed.from}~${e.observed.to})` : ''}</div>
            <div className="small"><strong>대조군</strong> {e.control?.label ?? '—'}{e.control?.ids?.length ? ` · ${e.control.ids.slice(0, 8).join(', ')}` : ''}</div>
            {e.control?.before && e.control.after ? <div className="small muted">대조 전 {windowText(e.control.before)} → 대조 후 {windowText(e.control.after)}</div> : null}
          </div>
        ) : null}
        {x?.kind === 'uplift' ? (
          <div className="stack-sm">
            <div className="small"><strong>증분 매출</strong> {krwFull(x.revenue)} (80% {krwFull(x.ci[0])} ~ {krwFull(x.ci[1])})</div>
            <div className="small"><strong>증분 광고비</strong> {krwFull(x.cost)} (80% {krwFull(x.ciCost[0])} ~ {krwFull(x.ciCost[1])})</div>
            <div className="small"><strong>증분 이익</strong> {krwFull(profitAt(x, margin).profit)} (현재 설정 공헌이익률 {fmt.pct(margin * 100, 0)} 기준{Math.abs(margin - x.margin) > 1e-9 ? ` · 측정 당시 ${fmt.pct(x.margin * 100, 0)}` : ''})</div>
            <div className="small"><strong>반사실(반영하지 않았다면)</strong> 매출 {krwFull(x.counterfactual.revenue)} · 광고비 {krwFull(x.counterfactual.cost)}</div>
            <div className="xs muted">방법 {x.methodLabel} · 신뢰도 {CONFIDENCE_LABEL[x.confidence]} — 기준: {x.confidenceBasis}</div>
          </div>
        ) : null}
        {x?.kind === 'loss' ? (
          <div className="stack-sm">
            <div className="small"><strong>손실 회피 (추정)</strong> {krwFull(x.lossAvoided)} = 추정 손실 {krwFull(x.revenueLossEst)} × (1 − {fmt.minutes(x.minutesToAction)} ÷ {fmt.minutes(x.minutesToNatural)})</div>
            <div className="small muted">발생 {fmtIso(x.occurredAt)} · 조치 {fmtIso(x.actionAt)} ({x.actionBasis === 'actionAt' ? '1차 조치 기록' : '해결 처리'}) · 자연 발견 가정 {fmtIso(x.naturalAt)}</div>
          </div>
        ) : null}
        {x?.kind === 'hours' ? <div className="small"><strong>절감</strong> {estimateText(e)}{x.cappedMinutes > 0 ? ` · 업무별 월 상한으로 ${fmt.dec1(x.cappedMinutes)}분 제외` : ''}</div> : null}
        {x ? (
          <div className="stack-sm">
            <strong className="small">전제</strong>
            <ul className="impact-list xs">{x.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </div>
        ) : null}
        {route && ROUTE_LABEL[route] ? <div><Button size="sm" icon="external" onClick={once(() => { onClose(); navigate(route); })}>{ROUTE_LABEL[route]}</Button></div> : null}
      </div>
    </Drawer>
  );
}

/* ============================== 리포트 보관함 ============================== */

const STATUS_TEXT: Record<ReportItem['status'], string> = { generated: '생성됨 · 미발송', delivered: '발송됨', failed: '발송 실패' };
/** 보관함 상태 — 발송 큐에 들어갔지만 아직 결과가 없으면 '발송 대기'로 (서버 status는 대기도 delivered로 센다) */
function reportStatus(r: ReportItem): { text: string; tone: Tone } {
  if (r.status === 'delivered' && r.delivered.some((x) => x.status === 'queued') && !r.delivered.some((x) => x.status === 'sent')) return { text: '발송 대기', tone: 'neutral' };
  return { text: STATUS_TEXT[r.status], tone: r.status === 'delivered' ? 'good' : r.status === 'failed' ? 'critical' : 'outline' };
}
const DEL_TONE: Record<string, Tone> = { sent: 'good', queued: 'neutral', failed: 'critical', skipped: 'outline' };
const DEL_TEXT: Record<string, string> = { sent: '발송', queued: '발송 대기', failed: '실패', skipped: '보내지 않음' };

function ReportsTab({ ws, month, canOperate, demoSummary, demoEntries, seed }: { ws: string | null; month: string; canOperate: boolean; demoSummary: ImpactSummary | null; demoEntries: LedgerEntry[] | null; seed?: { reports: ReportItem[]; schedule: ScheduleRow[] } }) {
  const actions = useActions();
  const [kind, setKind] = useState<ReportKind | ''>('');
  const [list, setList] = useState<ReportItem[]>(seed?.reports ?? []);
  const [next, setNext] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleRow[]>(seed?.schedule ?? []);
  const [open, setOpen] = useState<ReportItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [genType, setGenType] = useState<ReportKind>('daily');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [r, sch] = await Promise.all([remote.fetchReports(ws, { type: kind }), remote.fetchSchedule(ws)]);
      setList(r.reports); setNext(r.nextBefore); setSchedule(sch.schedule); setError(null);
    } catch (e) { setError(errText(e)); }
  }, [ws, kind]);
  useEffect(() => {
    void load();
    if (!ws) return;
    return onServerEvent('report', () => void load());
  }, [ws, load]);

  const demoReport = useMemo(() => {
    if (!demoSummary || !demoEntries) return null;
    const v = buildValueReport({ ...demoSummary, dataMode: 'demo' }, demoEntries, { brand: 'TEST DATA 예시' });
    const item: ReportItem = {
      id: 'demo-value', type: 'value', title: v.title, periodStart: v.periodStart, periodEnd: v.periodEnd, generatedAt: new Date().toISOString(), status: 'generated', trigger: 'schedule',
      scope: null, refId: null, dataMode: 'demo', dataAsOf: null, messenger: v.messenger, aeComment: null, delivered: [], deliveredAt: null, excerpt: v.messenger.split('\n')[0], markdown: v.markdown,
    };
    return item;
  }, [demoSummary, demoEntries]);
  const rows = ws ? list : demoReport ? [demoReport] : [];
  const noPerm = !ws ? '데모 모드 · 서버 연결 시 사용' : !canOperate ? '생성 · 발송은 담당 AE 이상 권한' : undefined;

  const view = async (r: ReportItem) => {
    if (!ws) { setOpen(r); return; }
    try { setOpen(await remote.fetchReport(ws, r.id)); } catch (e) { actions.toast({ tone: 'warning', title: '리포트를 열지 못했습니다', body: errText(e) }); }
  };
  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (e) { actions.toast({ tone: 'warning', title: '처리하지 못했습니다', body: errText(e) }); } finally { setBusy(null); }
  };
  // 월간 · 가치 리포트는 화면 위 '대상 월'을 쓴다 (진행 중인 달은 어제까지 잠정)
  const monthly = genType === 'monthly' || genType === 'value';
  const generate = () => run('gen', async () => {
    const r = await remote.generateReport(ws!, monthly ? { type: genType, month } : { type: genType });
    actions.toast({ tone: 'good', title: `${REPORT_KIND_LABEL[genType]} 리포트를 만들었습니다`, body: '발송은 목록의 발송 버튼으로 따로 합니다.' });
    await load();
    setOpen(r);
  });
  const deliver = (r: ReportItem) => run(`del:${r.id}`, async () => {
    const out = await remote.deliverReport(ws!, r.id);
    setArmed(null);
    const sent = out.results.filter((x) => x.status === 'sent' || x.status === 'queued').length;
    actions.toast({ tone: sent ? 'good' : 'warning', title: sent ? `${sent}개 채널로 보냈습니다` : '보낸 채널이 없습니다', body: out.results.map((x) => `${x.channelName} ${DEL_TEXT[x.status]}${x.reason ? ` (${x.reason})` : ''}`).join(' · ') });
    await load();
  });

  const columns: Column<ReportItem>[] = [
    { key: 'type', label: '종류', render: (r) => <Pill tone={r.type === 'issue' ? 'serious' : r.type === 'value' ? 'accent' : 'neutral'}>{REPORT_KIND_LABEL[r.type]}</Pill>, sort: (r) => r.type },
    {
      key: 'title', label: '리포트', render: (r) => (
        <div className="stack-sm" style={{ gap: 2, maxWidth: 360 }}>
          <strong className="small">{r.title}</strong>
          <span className="xs muted">{r.periodStart ? `${r.periodStart}${r.periodEnd && r.periodEnd !== r.periodStart ? ` ~ ${r.periodEnd}` : ''}` : '—'} · {TRIGGER_LABEL[r.trigger] ?? r.trigger} · {r.dataMode === 'live' ? 'LIVE DATA' : r.dataMode === 'mixed' ? '일부 TEST DATA' : 'TEST DATA'}</span>
        </div>
      ),
    },
    { key: 'at', label: '생성', render: (r) => <span className="xs nowrap">{ws ? fmtIso(r.generatedAt) : '예시'}</span>, sort: (r) => r.generatedAt },
    {
      key: 'del', label: '발송', render: (r) => (
        <div className="stack-sm" style={{ gap: 2, maxWidth: 240, alignItems: 'flex-start' }}>
          <Pill tone={reportStatus(r).tone}>{reportStatus(r).text}</Pill>
          {r.delivered.slice(-3).map((x, i) => <span key={`${x.channelId}-${i}`} className="xs muted">{x.channelName} · {DEL_TEXT[x.status]}{x.reason ? ` · ${x.reason}` : ''}</span>)}
        </div>
      ),
    },
    {
      key: 'act', label: '', render: (r) => (
        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" icon="report" onClick={once(() => void view(r))}>열기</Button>
          {armed === r.id ? (
            <span className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="primary" disabled={!!busy} onClick={once(() => void deliver(r))}>발송 확인</Button>
              <Button size="sm" variant="ghost" onClick={once(() => setArmed(null))}>취소</Button>
            </span>
          ) : <Button size="sm" icon="send" disabled={!!noPerm || !!busy} title={noPerm ?? "'리포트 발송' 이벤트를 켠 알림 채널로 보냅니다"} onClick={once(() => setArmed(r.id))}>발송</Button>}
        </div>
      ),
    },
  ];

  return (
    <div className="stack-lg">
      {!ws ? (
        <Callout tone="info" title="리포트 보관함은 서버 연결 시 채워집니다">
          서버는 일간(매일 08:00) · 주간(월 10:00, 휴무면 다음 영업일) · 월간(3영업일 10:00) · 가치(1일 09:00) · 이슈(P1 감지 즉시) 리포트를 예약 생성해 보관하고,
          알림 설정에서 '리포트 발송'을 켠 채널로 보냅니다. 지금은 가치 리포트 예시(TEST DATA)만 보여 줍니다. 일간 · 주간 · 월간 리포트 미리보기는 리포트 화면에서 볼 수 있습니다.
          <div style={{ marginTop: 6 }}><Button size="sm" icon="external" onClick={once(() => navigate('reports'))}>리포트 · 데이터 시간표 열기</Button></div>
        </Callout>
      ) : null}
      {error ? <Callout tone="critical" title="보관함을 불러오지 못했습니다">{error}</Callout> : null}
      {ws && schedule.length ? (
        <Card title="다음 예약 생성 · 발송" sub="KST 기준 · 워크스페이스 공휴일 설정 반영">
          <div className="grid g-5">
            {schedule.map((x) => <Stat key={x.type} label={`${REPORT_KIND_LABEL[x.type]} 리포트`} value={<span className="small">{x.at.includes('T') ? fmtIso(x.at) : x.at}</span>} foot={<span className="xs muted">{x.rule} · 대상 {x.covers}</span>} />)}
          </div>
        </Card>
      ) : null}
      <Card title="리포트 보관함" sub="예약 생성 · P1 이슈 · 화면에서 만든 리포트와 발송 기록. 알림 설정에서 '리포트 발송'을 켠 채널(Slack · 메일 · 웹훅)로 메신저형 요약 + 보관함 링크를 보내고, 전문은 이 보관함에서 봅니다."
        actions={<>
          <Segmented<ReportKind | ''> label="종류" value={kind} onChange={setKind} options={[{ id: '', label: '전체' }, ...(['daily', 'weekly', 'monthly', 'issue', 'value'] as ReportKind[]).map((k) => ({ id: k, label: REPORT_KIND_LABEL[k] }))]} />
          <select id="impact-gen-type" className="input" style={{ width: 'auto' }} value={genType} disabled={!!noPerm} onChange={(e) => setGenType(e.target.value as ReportKind)} aria-label="생성할 리포트 종류">
            {(['daily', 'weekly', 'monthly', 'value'] as ReportKind[]).map((k) => <option key={k} value={k}>{REPORT_KIND_LABEL[k]}{k === 'monthly' || k === 'value' ? ` · ${monthLabel(month)}` : k === 'daily' ? ' · 전일' : ' · 최근 7일'}</option>)}
          </select>
          <Button variant="primary" icon="plus" disabled={!!noPerm || !!busy} title={noPerm} onClick={once(() => void generate())}>{busy === 'gen' ? '생성 중' : '지금 생성'}</Button>
        </>}>
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.id}
          empty={<Empty icon="report" title="보관된 리포트가 없습니다">예약 생성은 워커가 실행합니다. '지금 생성'으로 바로 만들 수 있습니다.</Empty>} />
        {ws && next ? <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}><Button size="sm" variant="ghost" onClick={once(async () => {
          try { const r = await remote.fetchReports(ws, { type: kind, before: next }); setList((p) => [...p, ...r.reports]); setNext(r.nextBefore); } catch (e) { setError(errText(e)); }
        })}>더 보기</Button></div> : null}
      </Card>
      {open ? (
        <Drawer title={open.title} onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="row" style={{ gap: 6 }}>
              <Pill tone="outline">{REPORT_KIND_LABEL[open.type]}</Pill>
              {open.dataMode !== 'live' ? <span className="src demo">{open.dataMode === 'mixed' ? '일부 TEST DATA' : 'TEST DATA'}</span> : <span className="src live">LIVE</span>}
              <span className="xs muted">{TRIGGER_LABEL[open.trigger] ?? open.trigger}{ws ? ` · 생성 ${fmtIso(open.generatedAt)}` : ' · 예시'}</span>
            </div>
            {open.messenger ? <pre className="impact-pre">{open.messenger}</pre> : null}
            {open.markdown ? <Markdown text={open.markdown} /> : <Empty title="본문을 불러오는 중" />}
            {open.delivered.length ? (
              <div className="stack-sm">
                <strong className="small">발송 기록</strong>
                {open.delivered.map((x, i) => (
                  <div key={`${x.channelId}-${i}`} className="row xs" style={{ gap: 6 }}>
                    <Pill tone={DEL_TONE[x.status]}>{DEL_TEXT[x.status]}</Pill>
                    <span>{x.channelName}{x.target ? ` · ${x.target}` : ''} · {x.via === 'notify.send' ? '발송 큐' : x.via === 'direct' ? '직접 발송' : '—'} · {fmtIso(x.at)} · {x.by}</span>
                    {x.reason ? <span className="muted">{x.reason}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
