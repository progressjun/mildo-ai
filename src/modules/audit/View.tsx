/**
 * 감사 로그 (07 관리 · 연동) — 누가 · 언제 · 무엇을 바꿨는지. 필터(작업 접두어 · 사용자 · KST 날짜 · 계정 기록), 커서 페이지, 상세(JSON), CSV.
 * 서버 모드: GET /api/w/:ws/audit · audit.csv · audit/facets (권한 configure — PM · 관리자 · 소유자).
 * 데모 모드: 예시 기록(TEST DATA)을 보여 주고 같은 필터를 화면 안에서 적용한다. CSV도 예시 기록으로 만든다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Callout, Card, CopyButton, DataTable, DownloadButton, Drawer, Empty, Field, PageHeader, Pill, Src, Stat, Toggle, type Column } from '@/ui/primitives';
import { useActions } from '@/core/store';
import { useSaas } from '@/saas/context';
import { saveFile } from '@/core/download';
import { can } from '@/core/permissions';
import {
  actionLabel, actionSuggestions, auditCsv, detailSummary, filterEntries, filterProblem, isSensitive, kstStamp, prettyDetail, summarizeAudit,
  type AuditEntry, type AuditFilters,
} from './engine';
import { demoAuditEntries } from './demo';
import { setAuditSnapshot } from './live';
import * as auditApi from './api';
import { DemoNote, errorText } from '../team/parts';
import './styles.css';

export interface AuditUserOption { id: string; name: string; email?: string | null }

export interface AuditScreenProps {
  mode: 'demo' | 'server';
  workspaceName: string;
  entries: AuditEntry[] | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  filters: AuditFilters;
  users: AuditUserOption[];
  seenActions: string[];
  onApply: (f: AuditFilters) => void;
  onMore: () => void;
  onCsv: () => void;
  csvBusy: boolean;
  /** 데모: 예시 CSV를 바로 만든다 */
  demoCsv?: () => string;
  /** 권한 없음 (configure 아님) */
  denied?: boolean;
}

const EMPTY: AuditFilters = {};

function FiltersForm({ filters, users, seenActions, onApply, disabled }: { filters: AuditFilters; users: AuditUserOption[]; seenActions: string[]; onApply: (f: AuditFilters) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<AuditFilters>(filters);
  useEffect(() => setDraft(filters), [filters]);
  const problem = filterProblem(draft);
  const suggestions = useMemo(() => actionSuggestions(seenActions), [seenActions]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || disabled) return;
    onApply({ ...draft, action: draft.action?.trim() || undefined });
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="audit-filters">
        <Field label="작업 (접두어)" id="audit-f-action">
          <input id="audit-f-action" className="input" list="audit-action-list" value={draft.action ?? ''} placeholder="전체" autoComplete="off"
            onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value.replace(/[^A-Za-z0-9_.]/g, '') }))} />
          <datalist id="audit-action-list">
            {suggestions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </datalist>
        </Field>
        <Field label="사용자" id="audit-f-user">
          <select id="audit-f-user" className="select" value={draft.userId ?? ''} onChange={(e) => setDraft((d) => ({ ...d, userId: e.target.value || undefined }))}>
            <option value="">전체</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ''}</option>)}
          </select>
        </Field>
        <Field label="시작일 (KST)" id="audit-f-from">
          <input id="audit-f-from" className="input" type="date" value={draft.from ?? ''} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))} />
        </Field>
        <Field label="종료일 (KST, 포함)" id="audit-f-to">
          <input id="audit-f-to" className="input" type="date" value={draft.to ?? ''} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))} />
        </Field>
        <div className="row" style={{ gap: 6 }}>
          <Button type="submit" variant="primary" icon="filter" disabled={!!problem || disabled}>적용</Button>
          <Button variant="ghost" onClick={() => { setDraft(EMPTY); onApply(EMPTY); }} disabled={disabled}>초기화</Button>
        </div>
      </div>
      <div className="row-between">
        <Toggle id="audit-f-auth" checked={!!draft.auth} onChange={(v) => setDraft((d) => ({ ...d, auth: v || undefined }))}
          label={<span className="small">구성원 로그인 · 로그인 실패 · 비밀번호 · 세션 종료 기록 포함 (계정 단위 기록)</span>} />
        {problem ? <span className="xs audit-sensitive" role="alert">{problem}</span> : <span className="xs muted">작업 예: invite. · member.role · change.apply · auth.login_failed</span>}
      </div>
    </form>
  );
}

export function AuditDrawer({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const json = prettyDetail(entry.detail);
  return (
    <Drawer title={actionLabel(entry.action)} onClose={onClose}>
      <dl className="audit-kv">
        <dt>기록 번호</dt><dd className="num">{entry.id}</dd>
        <dt>시각 (KST)</dt><dd className="num">{kstStamp(entry.at)}</dd>
        <dt>행위자</dt><dd>{entry.actor}{entry.user_email ? ` · ${entry.user_email}` : ''}</dd>
        <dt>작업 코드</dt><dd><code className="audit-code">{entry.action}</code> {isSensitive(entry.action) ? <Pill tone="serious" icon="shield">보안 확인 대상</Pill> : null}</dd>
        <dt>대상</dt><dd>{entry.target_type ? `${entry.target_type} · ${entry.target_id ?? '—'}` : '—'}</dd>
        <dt>IP</dt><dd className="num">{entry.ip ?? '—'}</dd>
        <dt>범위</dt><dd>{entry.account ? '계정 단위 기록 (워크스페이스 밖 · 로그인 · 비밀번호 등)' : '이 워크스페이스'}</dd>
      </dl>
      <div className="stack-sm">
        <div className="row-between">
          <strong className="small">상세 (JSON)</strong>
          <CopyButton text={json} label="JSON 복사" />
        </div>
        <pre className="audit-json" aria-label="상세 JSON">{json}</pre>
        <span className="xs muted">비밀값(토큰 · 비밀번호 · 자격증명 · 웹훅 등)은 서버가 저장하기 전에 ••••로 가렸고, 조회할 때 한 번 더 가립니다.</span>
      </div>
    </Drawer>
  );
}

/** 화면 본체 — 서버 · 데모 공용 (SSR 테스트 대상) */
export function AuditScreen(p: AuditScreenProps) {
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const readOnly = p.mode === 'demo';
  const entries = p.entries ?? [];
  const sum = summarizeAudit(entries);
  const filtered = Object.values(p.filters).some((v) => v !== undefined && v !== '' && v !== false);

  const columns: Column<AuditEntry>[] = [
    { key: 'at', label: '시각 (KST)', sort: (e) => e.id, render: (e) => <span className="num nowrap">{kstStamp(e.at)}</span> },
    {
      key: 'actor', label: '행위자', sort: (e) => e.actor,
      render: (e) => <span className="stack-sm" style={{ gap: 0 }}><span>{e.actor}</span>{e.user_email && e.user_email !== e.actor ? <span className="xs muted">{e.user_email}</span> : null}</span>,
    },
    {
      key: 'action', label: '작업', sort: (e) => e.action,
      render: (e) => (
        <span className="stack-sm audit-action" style={{ gap: 0 }}>
          <span className={isSensitive(e.action) ? 'audit-sensitive' : undefined}>{actionLabel(e.action)}{e.account ? <> <Pill tone="outline">계정</Pill></> : null}</span>
          <code>{e.action}</code>
        </span>
      ),
    },
    { key: 'target', label: '대상', render: (e) => (e.target_type ? <span className="xs">{e.target_type} · <span className="num">{e.target_id ?? '—'}</span></span> : <span className="muted">—</span>) },
    { key: 'detail', label: '요약', render: (e) => <span className="xs ink2">{detailSummary(e) || '—'}</span> },
    { key: 'ip', label: 'IP', render: (e) => <span className="xs num">{e.ip ?? '—'}</span> },
  ];

  return (
    <div className="page audit-page">
      <PageHeader eyebrow="07 · AUDIT LOG" title="감사 로그"
        sub="초대 · 역할 변경 · 변경 승인과 매체 반영 · 커넥션 · 설정 · 로그인까지 모든 상태 변경을 누가 · 언제 · 무엇을 · 이전 → 이후로 남깁니다. 기록은 화면에서 고치거나 지울 수 없습니다."
        sources={<>{readOnly ? <Src kind="DEMO" /> : <Src kind="LIVE" title="서버 감사 로그 (audit_log)" />}<span className="xs muted">{p.workspaceName}</span></>}
        actions={readOnly && p.demoCsv
          ? <DownloadButton filename="audit-example.csv" data={p.demoCsv} mime="text/csv;charset=utf-8" label="CSV 내려받기 (예시)" />
          : <Button size="sm" icon="download" onClick={p.onCsv} disabled={p.csvBusy || p.denied}>{p.csvBusy ? '내려받는 중…' : 'CSV 내려받기'}</Button>} />

      {readOnly ? <DemoNote what="감사 기록" controls="시연 모드의 필터 · CSV는 예시 기록 안에서만 동작합니다." /> : null}
      {p.denied ? <Callout tone="info" title="감사 로그는 PM · 관리자 · 소유자만 볼 수 있습니다">설정 권한(configure)이 있는 역할만 조회 · 내보내기할 수 있습니다. 필요하면 워크스페이스 관리자에게 요청해 주세요.</Callout> : null}
      {p.error ? <Callout tone="critical" title="감사 로그를 불러오지 못했습니다">{p.error}</Callout> : null}

      {!p.denied ? (
        <>
          <div className="grid g-4">
            <Stat label={filtered ? '표시 중 (필터 적용)' : '표시 중'} value={p.entries ? `${sum.total}${p.hasMore ? '+' : ''}` : '—'} foot={<span className="xs muted">{sum.first ? `${kstStamp(sum.first).slice(0, 16)} ~ ${kstStamp(sum.last).slice(0, 16)}` : '기록 없음'}</span>} />
            <Stat label="보안 확인 대상" value={sum.sensitive.length} foot={<span className="xs muted">기준: 로그인 실패 · 비밀번호 · 역할 · 비활성화 · 제외 · 초대 · 실반영 전환 · 반영 · 롤백 · 내보내기</span>} />
            <Stat label="로그인 실패" value={sum.failedLogins} foot={<span className="xs muted">{p.filters.auth ? '계정 기록 포함 · 같은 이메일 반복 실패는 비밀번호 추측 가능성' : '계정 기록 포함을 켜면 집계'}</span>} />
            <Stat label="가장 많은 작업 영역" value={sum.byDomain[0] ? sum.byDomain[0].label : '—'} foot={<span className="xs muted">{sum.byDomain.slice(0, 3).map((d) => `${d.label} ${d.count}`).join(' · ') || '—'}</span>} />
          </div>

          <Card title="필터" sub="작업 코드 앞부분으로 거릅니다 (예: 'change.'은 변경 요청 전체). 날짜는 KST 기준이며 종료일을 포함합니다.">
            <FiltersForm filters={p.filters} users={p.users} seenActions={p.seenActions} onApply={p.onApply} disabled={p.loading && !p.entries} />
          </Card>

          <Card title="기록" sub={`최신순 · ${p.mode === 'server' ? '한 번에 100건씩' : '예시 기록'} · 행을 누르면 상세(JSON)를 엽니다`}>
            {p.entries ? (
              <DataTable rows={entries} columns={columns} rowKey={(e) => String(e.id)} onRowClick={setOpen} selectedKey={open ? String(open.id) : null}
                empty={filtered ? '조건에 맞는 기록이 없습니다 · 필터를 넓혀 보세요' : '아직 기록이 없습니다'} />
            ) : <Empty icon="inbox" title={p.loading ? '불러오는 중입니다' : '기록이 없습니다'} />}
            {p.hasMore ? (
              <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                <Button icon="chevron" onClick={p.onMore} disabled={p.loading}>{p.loading ? '불러오는 중…' : '이전 기록 100건 더 보기'}</Button>
              </div>
            ) : p.entries && entries.length ? <div className="xs muted" style={{ textAlign: 'center', marginTop: 10 }}>마지막 기록까지 표시했습니다</div> : null}
          </Card>
        </>
      ) : null}

      {open ? <AuditDrawer entry={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function DemoAudit() {
  const nowMs = useMemo(() => Date.now(), []);
  const all = useMemo(() => demoAuditEntries(nowMs), [nowMs]);
  const [filters, setFilters] = useState<AuditFilters>({ auth: true });
  const entries = useMemo(() => filterEntries(all, filters), [all, filters]);
  const users = useMemo(() => {
    const m = new Map<string, AuditUserOption>();
    for (const e of all) if (e.user_id) m.set(e.user_id, { id: e.user_id, name: e.actor, email: e.user_email });
    return [...m.values()];
  }, [all]);
  return (
    <AuditScreen mode="demo" workspaceName="수면밀도 퍼포먼스 (예시)" entries={entries} hasMore={false} loading={false} error={null} filters={filters}
      users={users} seenActions={all.map((e) => e.action)} onApply={setFilters} onMore={() => undefined} onCsv={() => undefined} csvBusy={false}
      demoCsv={() => auditCsv(entries)} />
  );
}

function ServerAudit() {
  const saas = useSaas();
  const ws = saas.workspace!;
  const denied = !can(ws.role, 'configure');
  const { toast } = useActions();
  const [filters, setFilters] = useState<AuditFilters>({});
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<auditApi.AuditFacets | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (f: AuditFilters, before: number | null) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const page = await auditApi.fetchAudit(ws.id, f, before);
      if (my !== seq.current) return;
      setEntries((prev) => {
        const next = before && prev ? [...prev, ...page.entries] : page.entries;
        setAuditSnapshot(ws.id, next);
        return next;
      });
      setNextBefore(page.nextBefore);
      setError(null);
    } catch (e) {
      if (my === seq.current) setError(errorText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [ws.id]);

  useEffect(() => {
    if (denied) return;
    void load(filters, null);
  }, [load, filters, denied]);
  useEffect(() => {
    if (denied) return;
    auditApi.fetchFacets(ws.id).then(setFacets).catch(() => setFacets(null));
  }, [ws.id, denied]);

  const onCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    try {
      const r = await auditApi.fetchAuditCsv(ws.id, filters);
      const res = await saveFile(`audit-${ws.slug}-${kstStamp(new Date()).slice(0, 10)}.csv`, r.csv, 'text/csv;charset=utf-8');
      if (res === 'saved') toast({ tone: 'good', title: `감사 로그 ${Number.isFinite(r.rows) ? `${r.rows}건` : ''}을 내려받았습니다`, body: r.truncated ? '5만 건까지만 담았습니다 · 기간을 나눠 다시 받아 주세요' : '내려받기도 감사 로그에 기록됩니다' });
      else if (res !== 'declined') toast({ tone: 'warning', title: '파일을 저장하지 못했습니다', body: '브라우저 다운로드 설정을 확인해 주세요' });
    } catch (e) {
      toast({ tone: 'critical', title: 'CSV를 내려받지 못했습니다', body: errorText(e) });
    } finally {
      setCsvBusy(false);
    }
  };

  const users: AuditUserOption[] = (facets?.users ?? []).map((u) => ({ id: u.id, name: u.member ? u.name : `${u.name} (전 구성원)`, email: u.email }));
  // 같은 필터(예: '초기화'를 두 번)로 다시 적용해도 항상 새로 읽는다 — 같은 객체를 넣으면 effect가 돌지 않아 표가 빈 채로 남는다
  const onApply = (f: AuditFilters) => { setEntries(null); setNextBefore(null); setFilters({ ...f }); };
  return (
    <AuditScreen mode="server" workspaceName={ws.name} entries={denied ? null : entries} hasMore={!!nextBefore} loading={loading} error={error} filters={filters}
      users={users} seenActions={(facets?.actions ?? []).map((a) => a.action)} onApply={onApply}
      onMore={() => { if (nextBefore && !loading) void load(filters, nextBefore); }} onCsv={() => void onCsv()} csvBusy={csvBusy} denied={denied} />
  );
}

export default function View() {
  const saas = useSaas();
  if (saas.mode === 'checking') {
    return <div className="page audit-page"><PageHeader eyebrow="07 · AUDIT LOG" title="감사 로그" sub="서버 연결을 확인하는 중입니다." /></div>;
  }
  if (saas.mode === 'server') {
    if (!saas.workspace) {
      return (
        <div className="page audit-page">
          <PageHeader eyebrow="07 · AUDIT LOG" title="감사 로그" />
          <Callout tone="info" title="워크스페이스가 없습니다">로그인한 뒤 소속된 워크스페이스가 있어야 감사 로그를 볼 수 있습니다.</Callout>
        </div>
      );
    }
    return <ServerAudit key={saas.workspace.id} />;
  }
  return <DemoAudit />;
}

