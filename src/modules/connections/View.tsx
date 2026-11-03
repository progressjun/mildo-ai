/**
 * 데이터 연결 (07 관리 · 연동) — 매체 · 판매 채널 API 커넥션, CSV 업로드, 수집 일정 · 현황, 데이터 품질.
 * 서버 모드: 실제 API (권한은 서버가 최종 판정 — 화면은 버튼만 맞춘다). 데모 모드: 예시 상태 읽기 전용 + 브라우저 안 CSV 미리보기.
 */
import { useMemo, useState } from 'react';
import { Button, Callout, Card, DataTable, PageHeader, Pill, Segmented, Src, Stat, Tabs } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { useActions, useStore } from '@/core/store';
import { fmt } from '@/core/util';
import {
  ago, channelLabel, fmtDuration, fmtStamp, JOB_LABEL, KIND_LABEL, RUN_STATUS_META, sourceModeOf, staleSources,
  type CatalogProvider, type ConnectionView, type RunView, type WriteMode,
} from './model';
import { connectionsApi } from './client';
import { errorText, useConnections } from './useConnections';
import { CatalogCard, ConfirmModal, ConnectionCard, ConnectionFormModal, LiveConfirmModal, QualityItemRow, RunDrawer, SyncModal, type ConnectionFormValue } from './parts';
import { UploadPanel } from './UploadPanel';
import './styles.css';

type Tab = 'connections' | 'catalog' | 'runs' | 'quality' | 'upload';
type Dialog =
  | { kind: 'add'; provider: CatalogProvider }
  | { kind: 'edit'; c: ConnectionView; provider: CatalogProvider }
  | { kind: 'live'; c: ConnectionView }
  | { kind: 'sync'; c: ConnectionView }
  | { kind: 'delete'; c: ConnectionView }
  | null;

const QUALITY_RULES_TEXT = [
  '누락 날짜 (기간 안 데이터 없는 날)',
  '중복 키 (마지막 값만 사용)',
  '음수 지표 · 형식 오류 · 미래 날짜 (해당 행 제외)',
  '클릭 > 노출 · 전환 > 클릭 · 광고비 0인데 클릭',
  '같은 요일 직전 4주 평균 대비 ±80% 급변',
  '네이버 SA 키워드 합계 vs 매체 합계 10% 초과 차이',
  '수집 지연 26시간 · 어제 데이터 없음',
];

export default function View() {
  const s = useConnections();
  const { data } = useStore().state;
  const { toast } = useActions();
  const [tab, setTab] = useState<Tab>('connections');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; what: string } | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [runFilter, setRunFilter] = useState<'all' | 'failed' | 'partial'>('all');
  const server = s.mode === 'server';
  const perms = { configure: s.can('configure'), operate: s.can('operate'), liveWrite: s.can('live_write') };
  const src = sourceModeOf(data.meta);
  const stale = staleSources(data.meta, data.today);
  const active = s.connections.filter((c) => c.status === 'active').length;
  const errors = s.connections.filter((c) => c.status === 'error').length;
  const lastSync = s.connections.map((c) => c.lastSyncAt).filter(Boolean).sort().pop() ?? null;
  const providerOf = (p: string) => s.catalog.find((x) => x.provider === p) ?? null;
  const ws = s.workspaceId;
  const close = () => { setDialog(null); setDialogError(null); setSaving(false); };

  const act = async <T,>(fn: () => Promise<T>, ok: (r: T) => void) => {
    setSaving(true);
    setDialogError(null);
    try {
      const r = await fn();
      ok(r);
      close();
    } catch (e) {
      setDialogError(errorText(e));
      setSaving(false);
    }
  };

  const submitForm = (v: ConnectionFormValue) => {
    if (!ws || !dialog) return;
    if (dialog.kind === 'add') {
      void act(() => connectionsApi.create(ws, { provider: dialog.provider.provider, label: v.label, credentials: v.credentials, priority: v.priority, writeMode: v.writeMode, channel: v.channel }), (r) => {
        s.setConnections(r.connections);
        toast({ tone: 'good', title: `${r.connection.label} 연결을 추가했습니다`, body: r.connection.status === 'pending' ? '연결 확인을 누르면 계정을 확인하고 최근 120일(보관 한도 이내)을 채웁니다' : '수집 대기열에 등록했습니다' });
        setTab('connections');
        void s.refresh();
      });
    } else if (dialog.kind === 'edit') {
      void act(() => connectionsApi.patch(ws, dialog.c.id, { label: v.label, credentials: v.credentials, priority: v.priority }), (r) => {
        s.setConnections(r.connections);
        toast({ tone: 'good', title: '설정을 저장했습니다', body: r.connection.status === 'pending' ? '자격증명이 바뀌어 다시 연결 확인이 필요합니다' : undefined });
      });
    }
  };

  const quick = async (c: ConnectionView, what: string, fn: () => Promise<void>) => {
    setBusy({ id: c.id, what });
    try { await fn(); } catch (e) { toast({ tone: 'critical', title: '처리하지 못했습니다', body: errorText(e) }); } finally { setBusy(null); }
  };

  const onTest = (c: ConnectionView) => ws && quick(c, 'test', async () => {
    const r = await connectionsApi.test(ws, c.id);
    s.setConnections(r.connections);
    toast({ tone: r.result.ok ? 'good' : 'critical', title: r.result.ok ? `연결 확인 성공${r.result.account ? ` · ${r.result.account}` : ''}` : '연결 확인 실패', body: r.result.ok ? (r.backfillQueued ? '첫 수집(최근 기간)을 대기열에 올렸습니다' : r.result.message) : r.result.message });
    void s.refresh();
  });

  const onWriteMode = (c: ConnectionView, m: WriteMode) => {
    if (!ws) return;
    if (m === 'live') {
      if (!perms.liveWrite) { toast({ tone: 'warning', title: 'live는 관리자 · 소유자만 켤 수 있습니다', body: '쓰기 모드 live 권한(live_write)이 필요합니다' }); return; }
      setDialog({ kind: 'live', c });
      return;
    }
    void quick(c, 'write', async () => {
      const r = await connectionsApi.patch(ws, c.id, { writeMode: m });
      s.setConnections(r.connections);
      toast({ tone: 'good', title: `쓰기 모드 ${m === 'off' ? '반영 끔' : 'dry_run'}`, body: '감사 로그에 기록했습니다' });
    });
  };

  const onToggle = (c: ConnectionView) => ws && quick(c, 'toggle', async () => {
    const r = await connectionsApi.patch(ws, c.id, { status: c.status === 'disabled' ? 'active' : 'disabled' });
    s.setConnections(r.connections);
  });

  const runs = useMemo(() => s.runs.filter((r) => runFilter === 'all' || r.status === runFilter), [s.runs, runFilter]);
  const byKind = (k: CatalogProvider['kind']) => s.catalog.filter((p) => p.kind === k);
  const hasDemo = s.connections.some((c) => c.provider === 'demo');
  const csvConnections = s.connections.filter((c) => c.provider === 'csv');

  if (server && !s.ready) {
    return (
      <div className="page conn-page">
        <PageHeader eyebrow="07 DATA SOURCES · 데이터 연결" title="데이터 연결" />
        <Callout tone="warning" title="워크스페이스를 고르세요">로그인한 계정에 연결된 워크스페이스가 없습니다. 초대 링크로 합류하거나 관리자에게 요청하세요.</Callout>
      </div>
    );
  }

  return (
    <div className="page conn-page">
      <PageHeader eyebrow="07 DATA SOURCES · 데이터 연결" title="데이터 연결"
        sub="매체 · 판매 채널 API를 연결하거나 CSV를 올리면 매일 07:00 전일 확정(어제 포함 3일 재수집) · 매시 10분 당일 시간대를 자동으로 받습니다. 수집마다 품질 검사를 돌리고, 매체 반영은 커넥션별 쓰기 모드(기본 dry_run)를 따릅니다."
        sources={<>{/* 출처 배지: 스토어 Dataset 메타에 따라 TEST DATA · LIVE + TEST · LIVE DATA · 데이터 없음 (플랫폼 공용 규칙) */}<Src kind="DEMO" /><Pill tone="outline" title={src.basis}>Dataset 출처: {src.label}</Pill></>}
        actions={server ? <Button size="sm" icon="refresh" onClick={() => void s.refresh()} disabled={s.loading}>{s.loading ? '불러오는 중…' : '새로 고침'}</Button> : undefined} />

      {!server ? (
        <Callout tone="info" title="서버 연결 시 실제로 동작합니다">
          지금 화면은 예시 상태(TEST DATA)입니다. MILDO OS Cloud 서버에 연결하면 커넥션을 추가 · 연결 확인 · 수집하고, CSV를 가져오고, 수집 현황 · 품질 검사 결과를 실제로 봅니다. CSV 업로드 탭의 미리보기는 지금도 이 브라우저 안에서 동작합니다.
        </Callout>
      ) : null}
      {s.error ? <Callout tone="critical" title="불러오지 못했습니다">{s.error}</Callout> : null}

      <Card>
        <div className="grid g-4">
          <Stat label="커넥션" value={`${active} / ${s.connections.length}`} foot={<span className="xs">활성 / 전체{errors ? ` · 오류 ${errors}` : ''}</span>} />
          <Stat label="마지막 수집" value={lastSync ? ago(lastSync, s.nowMs) : '없음'} foot={<span className="xs">{lastSync ? fmtStamp(lastSync) : '연결 후 07:00 예약 또는 지금 수집'} · 기준 26시간</span>} />
          <Stat label="데이터 품질" value={<span>{s.qualitySummary.error}<span className="small muted"> 오류 · </span>{s.qualitySummary.warning}<span className="small muted"> 경고</span></span>} foot={<span className="xs">최근 실행 · 연결 상태 기준</span>} />
          <Stat label="Dataset 출처" value={src.label} src={src.mode !== 'live' ? <Src kind="DEMO" /> : undefined}
            foot={<span className="xs" title={src.basis}>{stale.length ? `지연 ${stale.map((x) => channelLabel(x.channel)).slice(0, 3).join(' · ')}${stale.length > 3 ? ' …' : ''} (어제 데이터 없음)` : src.basis.slice(0, 60)}</span>} />
        </div>
      </Card>

      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'connections', label: '연결', badge: <span className="xs muted"> {s.connections.length}</span> },
        { id: 'catalog', label: '연결 추가' },
        { id: 'runs', label: '수집 현황' },
        { id: 'quality', label: '데이터 품질', badge: s.qualitySummary.error ? <Pill tone="critical">{s.qualitySummary.error}</Pill> : s.qualitySummary.warning ? <Pill tone="warning">{s.qualitySummary.warning}</Pill> : undefined },
        { id: 'upload', label: 'CSV 업로드' },
      ]} />

      {tab === 'connections' ? (
        <div className="stack">
          {s.connections.length ? s.connections.map((c) => (
            <ConnectionCard key={c.id} c={c} nowMs={s.nowMs} perms={perms} readOnly={s.readOnly} busy={busy?.id === c.id ? busy.what : null}
              onTest={() => void onTest(c)} onSync={() => setDialog({ kind: 'sync', c })}
              onEdit={() => { const p = providerOf(c.provider); if (p) setDialog({ kind: 'edit', c, provider: p }); }}
              onDelete={() => setDialog({ kind: 'delete', c })} onWriteMode={(m) => onWriteMode(c, m)} onToggle={() => void onToggle(c)} />
          )) : (
            <Card>
              <div className="stack" style={{ alignItems: 'flex-start' }}>
                <strong>아직 연결된 데이터가 없습니다</strong>
                <span className="small ink2">매체 API를 연결하거나, 바로 체험하려면 데모 데이터(TEST DATA)를 추가하세요. 데모는 실데이터가 들어온 매체 · 채널부터 자동으로 빠집니다.</span>
                <Button variant="primary" icon="plus" onClick={() => setTab('catalog')}>연결 추가</Button>
              </div>
            </Card>
          )}
          <Card tone="flat" title="출처 우선순위" sub="Dataset은 매체 · 채널마다 실데이터(API · CSV)가 있으면 데모를 빼고, 날짜마다 우선순위가 높은 출처 하나를 씁니다">
            <div className="row xs ink2" style={{ gap: 14 }}>
              <span><Icon name="check" size={12} /> API 100 &gt; CSV 50 &gt; 데모 10 (커넥션 설정에서 조정)</span>
              <span><Icon name="check" size={12} /> 같은 우선순위면 나중에 만든 출처</span>
              <span><Icon name="check" size={12} /> 시간대 데이터는 하루 단위로 한 출처만</span>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'catalog' ? (
        <div className="stack-lg">
          {(['media', 'sales', 'other'] as const).map((k) => byKind(k).length ? (
            <div key={k} className="stack">
              <h2 className="card-title">{KIND_LABEL[k]}</h2>
              <div className="grid g-auto">
                {byKind(k).map((p) => (
                  <CatalogCard key={p.provider} p={p} readOnly={s.readOnly} canAdd={perms.configure} exists={p.provider === 'demo' && hasDemo}
                    onAdd={() => setDialog({ kind: 'add', provider: p })} />
                ))}
              </div>
            </div>
          ) : null)}
          {!s.catalog.length ? <Callout tone="info">카탈로그를 불러오는 중입니다</Callout> : null}
          <span className="xs muted">'실계정 연결 전 확인 필요'는 공식 문서대로 구현했지만 실제 계정 호출로 검증하기 전이라는 뜻입니다. 공개 API 근거가 없는 채널(예: 일부 판매 채널)은 CSV 업로드로 받습니다.</span>
        </div>
      ) : null}

      {tab === 'runs' ? (
        <Card title="수집 현황" sub="수집 실행마다 받은 행 · 쓴 행 · 품질 검사 결과. 행을 누르면 상세" actions={
          <Segmented<'all' | 'failed' | 'partial'> label="상태" value={runFilter} onChange={setRunFilter} options={[{ id: 'all', label: '전체' }, { id: 'failed', label: '실패' }, { id: 'partial', label: '일부 제외' }]} />
        }>
          <DataTable<RunView> rows={runs} rowKey={(r) => r.id} onRowClick={setRun} maxHeight={560} empty={server ? '아직 수집 실행이 없습니다' : '예시 실행이 없습니다'}
            columns={[
              { key: 'startedAt', label: '시작', render: (r) => fmtStamp(r.startedAt), sort: (r) => r.startedAt ?? '' },
              { key: 'label', label: '출처', render: (r) => <span>{r.label} {r.provider === 'demo' ? <Src kind="DEMO" /> : null}</span> },
              { key: 'job', label: '종류', render: (r) => JOB_LABEL[r.job] ?? r.job },
              { key: 'range', label: '기간', render: (r) => (r.rangeFrom ? (r.rangeFrom === r.rangeTo ? r.rangeFrom : `${r.rangeFrom} ~ ${r.rangeTo}`) : '—') },
              { key: 'status', label: '상태', render: (r) => <Pill tone={RUN_STATUS_META[r.status].tone}>{RUN_STATUS_META[r.status].label}</Pill> },
              { key: 'rows', label: '받음 → 씀', align: 'right', render: (r) => `${fmt.int(r.rowsIn)} → ${fmt.int(r.rowsWritten)}`, sort: (r) => r.rowsWritten },
              { key: 'issues', label: '오류 · 경고 · 참고', align: 'right', render: (r) => `${r.issueCounts.error} · ${r.issueCounts.warning} · ${r.issueCounts.info}` },
              { key: 'dur', label: '소요', align: 'right', render: (r) => fmtDuration(r.durationMs) },
            ]} />
          {s.nextBefore ? <Button size="sm" onClick={() => void s.loadMoreRuns()}>더 보기</Button> : null}
        </Card>
      ) : null}

      {tab === 'quality' ? (
        <div className="grid g-3">
          <Card className="span-2" title="데이터 품질 이슈" sub={`오류 ${s.qualitySummary.error} · 경고 ${s.qualitySummary.warning} · 참고 ${s.qualitySummary.info} — 커넥션 · 수집 종류별 마지막 실행 · 최근 14일 업로드 · 연결 상태 기준 (${fmtStamp(s.qualitySummary.checkedAt)} 점검)`}>
            {s.quality.length ? <ul className="conn-issues">{s.quality.map((i, k) => <QualityItemRow key={`${i.runId ?? i.connectionId}-${i.code}-${k}`} i={i} />)}</ul> : <Callout tone="good">최근 실행에서 발견한 문제가 없습니다.</Callout>}
          </Card>
          <Card title="검사 기준" sub="수집 · 업로드마다 자동 실행">
            <ul className="conn-rules">{QUALITY_RULES_TEXT.map((r) => <li key={r} className="small">{r}</li>)}</ul>
            <span className="xs muted">오류 등급 행은 웨어하우스에 쓰지 않고(일부 제외), 경고는 그대로 쓰되 화면 · 알림 판단 시 참고합니다. 급변 경고는 실제 변화일 수도 있어 MILDO Alert 탐지와 대조하세요.</span>
          </Card>
        </div>
      ) : null}

      {tab === 'upload' ? (
        <UploadPanel server={server} workspaceId={ws} canOperate={server ? perms.operate : true} canConfigure={perms.configure} csvConnections={csvConnections} uploads={s.uploads} onImported={() => void s.refresh()} />
      ) : null}

      {dialog?.kind === 'add' || dialog?.kind === 'edit' ? (
        <ConnectionFormModal provider={dialog.provider} initial={dialog.kind === 'edit' ? dialog.c : null} editing={dialog.kind === 'edit'} saving={saving} error={dialogError} onClose={close} onSubmit={submitForm} />
      ) : null}
      {dialog?.kind === 'live' ? (
        <LiveConfirmModal c={dialog.c} saving={saving} error={dialogError} onClose={close}
          onConfirm={() => ws && void act(() => connectionsApi.patch(ws, dialog.c.id, { writeMode: 'live' }), (r) => {
            s.setConnections(r.connections);
            toast({ tone: 'warning', title: `${r.connection.label} 실제 반영(live) 켜짐`, body: '승인된 변경이 매체 API로 호출됩니다 · 감사 로그에 기록했습니다' });
          })} />
      ) : null}
      {dialog?.kind === 'sync' ? (
        <SyncModal c={dialog.c} today={s.today} saving={saving} error={dialogError} onClose={close}
          onSubmit={(range) => ws && void act(() => connectionsApi.sync(ws, dialog.c.id, range ?? undefined), (r) => {
            s.setConnections(r.connections);
            toast({ tone: r.queued ? 'good' : 'info', title: r.queued ? '수집 대기열에 등록했습니다' : '이미 대기 중인 수집이 있습니다', body: r.queued ? '워커가 처리하면 수집 현황에 결과가 표시됩니다' : '끝나면 다시 요청할 수 있습니다' });
            setTab('runs');
          })} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmModal title={`${dialog.c.label} 삭제`} confirmLabel="커넥션 삭제" saving={saving} error={dialogError} onClose={close}
          onConfirm={() => ws && void act(() => connectionsApi.remove(ws, dialog.c.id), (r) => {
            s.setConnections(r.connections);
            toast({ tone: 'good', title: '커넥션을 삭제했습니다', body: `이 출처로 들어온 웨어하우스 ${fmt.int(r.purgedRows)}행을 정리했습니다` });
          })}>
          <span className="small">이 커넥션으로 수집한 웨어하우스 데이터와 수집 이력, 대기 중인 수집을 모두 지웁니다. 같은 매체에 다른 출처가 있으면 그 값이 다시 쓰입니다{dialog.c.provider === 'demo' ? ' (데모 TEST DATA를 지우면 실데이터만 남습니다)' : ''}. 되돌릴 수 없고 감사 로그에 남습니다.</span>
        </ConfirmModal>
      ) : null}
      {run ? <RunDrawer r={run} onClose={() => setRun(null)} /> : null}
    </div>
  );
}
