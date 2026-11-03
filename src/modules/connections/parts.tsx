/**
 * 데이터 연결 화면 부품 — 커넥션 카드 · 카탈로그 카드 · 연결 추가/설정 폼 · 쓰기 모드(live 2단계 확인) · 기간 수집 · 삭제 확인 · 이슈 목록 · 실행 상세.
 * 모든 부품은 데이터 · 권한 · 콜백을 props로 받는다(서버 · 데모 모드 공통, 테스트에서 그대로 렌더).
 */
import { useState, type ReactNode } from 'react';
import { Button, Callout, Drawer, Field, Modal, NumberInput, Pill, Segmented, Src } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { fmt } from '@/core/util';
import {
  ago, addDays, channelLabel, connectionVerdict, csvOnlyLabel, dailyRecollectDays, fmtDuration, fmtStamp, JOB_LABEL, KIND_LABEL, LIVE_CONFIRM_TEXT, READ_LABEL, RUN_STATUS_META, SEVERITY_META,
  SOURCE_KIND_LABEL, STATUS_META, syncBounds, validateSyncRange, WRITE_LABEL, WRITE_MODE_META,
  type CatalogProvider, type ConnectionView, type QualityIssue, type QualityItem, type RunView, type WriteMode,
} from './model';
import { TEMPLATES, type UploadTemplate } from './csv';
import { awaitingApproval } from './oauth';

const UNVERIFIED = '실계정 연결 전 확인 필요';
const UNVERIFIED_HINT = '공식 API 문서대로 구현했지만 실제 계정으로 호출해 검증하기 전입니다. 첫 연결 확인 · 수집 결과를 매체 관리 화면 값과 대조해 주세요.';

export function UnverifiedPill() {
  return <Pill tone="warning" icon="alert" title={UNVERIFIED_HINT}>{UNVERIFIED}</Pill>;
}

export function SourceTag({ kind }: { kind: ConnectionView['sourceKind'] }) {
  if (kind === 'demo') return <Src kind="DEMO" />;
  return <Pill tone="outline">{SOURCE_KIND_LABEL[kind]}</Pill>;
}

function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="conn-kv">
      <span className="xs muted">{k}</span>
      <span className="small">{v}</span>
    </div>
  );
}

/* ---------- 커넥션 카드 ---------- */

export interface CardPerms { configure: boolean; operate: boolean; liveWrite: boolean }

/** 권한이 없어 잠긴 버튼의 사유 (title로 보인다) — 서버 권한표(src/core/permissions.ts)와 같은 기준 */
export const CONFIGURE_ONLY = 'PM · 관리자 · 소유자만';
export const LIVE_WRITE_ONLY = '관리자 · 소유자만 live를 켤 수 있습니다 (live_write 권한)';
const LOCK_REASON = '서버 연결 시 사용할 수 있습니다';

/**
 * 쓰기 모드 선택지마다 잠금 사유 (없으면 null = 누를 수 있음).
 * 서버 PATCH 판정과 같다: 쓰기 모드 변경은 configure(pm · admin · owner), live로 켜기는 live_write(admin · owner) — live 끄기는 configure로 충분.
 */
export function writeModeLock(m: WriteMode, current: WriteMode, perms: CardPerms, readOnly: boolean): string | null {
  if (readOnly) return LOCK_REASON;
  if (!perms.configure) return `쓰기 모드는 ${CONFIGURE_ONLY} 바꿀 수 있습니다`;
  if (m === 'live' && current !== 'live' && !perms.liveWrite) return LIVE_WRITE_ONLY;
  return null;
}

/** 쓰기 모드 옆 안내 (화면에 보이는 문구) */
export function writeModeHint(perms: CardPerms, readOnly: boolean): string | null {
  if (readOnly) return null;
  if (!perms.configure) return `쓰기 모드 변경은 ${CONFIGURE_ONLY}`;
  if (!perms.liveWrite) return 'live는 관리자 · 소유자만';
  return null;
}

/** 쓰기 모드 세그먼트 — 공용 Segmented와 같은 모양(.seg)에 선택지별 잠금(disabled + 사유 title)을 더한다 */
export function WriteModeControl({ value, perms, readOnly, onChange }: { value: WriteMode; perms: CardPerms; readOnly: boolean; onChange: (m: WriteMode) => void }) {
  return (
    <div className="seg conn-seg" role="group" aria-label="쓰기 모드">
      {(['off', 'dry_run', 'live'] as WriteMode[]).map((m) => {
        const why = writeModeLock(m, value, perms, readOnly);
        return (
          <button key={m} type="button" aria-pressed={value === m} disabled={!!why} title={why ?? WRITE_MODE_META[m].desc} onClick={() => { if (!why) onChange(m); }}>
            {WRITE_MODE_META[m].label}
          </button>
        );
      })}
    </div>
  );
}

export function ConnectionCard({ c, nowMs, perms, readOnly, busy, onTest, onSync, onEdit, onDelete, onWriteMode, onToggle, oauth, onOAuth }: {
  c: ConnectionView; nowMs: number; perms: CardPerms; readOnly: boolean; busy?: string | null;
  onTest: () => void; onSync: () => void; onEdit: () => void; onDelete: () => void; onWriteMode: (m: WriteMode) => void; onToggle: () => void;
  /** 브라우저 승인(OAuth) 흐름이 있는 공급자(카페24) — 서버 모드 카탈로그에서만 온다 */
  oauth?: CatalogProvider['oauth'] | null; onOAuth?: () => void;
}) {
  const st = STATUS_META[c.status];
  const v = connectionVerdict(c, nowMs);
  const writes = c.capabilities?.writes ?? [];
  const lock = readOnly ? LOCK_REASON : undefined;
  const isCsv = c.sourceKind === 'csv';
  const recollect = `어제 포함 ${dailyRecollectDays(c.kind)}일`;
  const schedule = isCsv ? '업로드할 때' : c.capabilities?.intraday ? `매일 07:00 전일 확정(${recollect}) · 매시 10분 당일 시간대` : `매일 07:00 전일 확정(${recollect})`;
  const showOAuth = !!oauth && !readOnly && !!onOAuth;
  const awaiting = showOAuth && awaitingApproval(c);
  return (
    <section className="card conn-card" aria-label={`${c.label} 커넥션`}>
      <div className="row-between">
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong className="conn-title">{c.label}</strong>
            <Pill tone={st.tone} title={st.hint}>{st.label}</Pill>
            <SourceTag kind={c.sourceKind} />
            {c.sourceKind === 'api' && !c.verifiedLive ? <UnverifiedPill /> : null}
          </div>
          <span className="xs muted">{c.providerLabel}{c.channel ? ` · ${channelLabel(c.channel)}` : ''}</span>
        </div>
        <div className="conn-verdict" title={v.basis}>
          <Pill tone={v.tone}>{v.label}</Pill>
          <span className="xs muted">{v.basis}</span>
        </div>
      </div>

      <div className="conn-grid">
        <KV k="마지막 수집" v={c.lastSyncAt ? `${fmtStamp(c.lastSyncAt)} (${ago(c.lastSyncAt, nowMs)})` : '없음'} />
        <KV k="마지막 연결 확인" v={c.lastTestAt ? fmtStamp(c.lastTestAt) : isCsv || c.sourceKind === 'demo' ? '필요 없음' : '확인 전'} />
        <KV k="수집 일정" v={schedule} />
        <KV k="우선순위" v={<span title="같은 매체 · 채널에 출처가 여럿이면 높은 쪽을 씁니다 (기본 API 100 · CSV 50 · 데모 10)">{c.priority}</span>} />
        <KV k="최근 실행" v={c.lastRun ? <span><Pill tone={RUN_STATUS_META[c.lastRun.status].tone}>{RUN_STATUS_META[c.lastRun.status].label}</Pill> {JOB_LABEL[c.lastRun.job] ?? c.lastRun.job} · {fmt.int(c.lastRun.rowsWritten)}행</span> : '—'} />
        <KV k="대기 중 수집" v={c.pendingJobs ? <span className="row" style={{ gap: 4 }}><Icon name="clock" size={12} /> {c.pendingJobs}건</span> : '없음'} />
      </div>

      {c.lastError && c.status !== 'disabled' ? <Callout tone="critical" title="마지막 오류">{c.lastError}</Callout> : null}
      {awaiting && oauth ? (
        <Callout tone="warning" title="쇼핑몰 운영자 승인 전">
          '{oauth.startLabel}'을 누르면 카페24 승인 화면으로 이동하고, 승인하면 이 화면으로 돌아와 토큰이 암호화 저장됩니다. 그 뒤 연결 확인을 눌러 주세요.
          카페24 개발자센터 앱의 Redirect URI에 <code>{oauth.redirectUri}</code>를 등록해 두어야 합니다.
        </Callout>
      ) : null}

      {Object.keys(c.credentials).length ? (
        <div className="conn-creds" aria-label="저장된 자격증명 (마스킹)">
          {Object.entries(c.credentials).map(([k, val]) => (
            <span key={k} className="xs"><span className="muted">{k}</span> <code>{val ?? '미입력'}</code></span>
          ))}
        </div>
      ) : null}

      <div className="conn-write">
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className="xs muted">매체 반영 쓰기 모드</span>
          {writes.length ? <span className="xs ink2">반영 가능: {writes.map((w) => WRITE_LABEL[w] ?? w).join(' · ')}</span> : <span className="xs muted">수집 전용 (반영 기능 없음)</span>}
        </div>
        {writes.length ? (
          <div className="row" style={{ gap: 6 }}>
            <WriteModeControl value={c.writeMode} perms={perms} readOnly={readOnly} onChange={(m) => { if (!readOnly && m !== c.writeMode) onWriteMode(m); }} />
            {writeModeHint(perms, readOnly) ? <span className="xs muted">{writeModeHint(perms, readOnly)}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="row conn-actions">
        {showOAuth && oauth ? (
          <Button size="sm" icon="external" variant={awaiting ? 'primary' : undefined} onClick={onOAuth} disabled={!perms.configure || c.status === 'disabled' || busy === 'oauth'}
            title={!perms.configure ? 'PM · 관리자 · 소유자만' : c.status === 'disabled' ? '사용 중지된 커넥션입니다' : `카페24 승인 화면으로 이동 (승인 후 ${oauth.redirectUri}로 돌아옵니다)`}>
            {busy === 'oauth' ? '이동 중…' : oauth.startLabel}
          </Button>
        ) : null}
        {c.sourceKind === 'api' ? <Button size="sm" icon="check" onClick={onTest} disabled={readOnly || !perms.configure || busy === 'test'} title={lock ?? (!perms.configure ? 'PM · 관리자 · 소유자만' : undefined)}>{busy === 'test' ? '확인 중…' : '연결 확인'}</Button> : null}
        {!isCsv ? <Button size="sm" icon="refresh" variant="primary" onClick={onSync} disabled={readOnly || !perms.operate || c.status === 'disabled' || busy === 'sync'} title={lock ?? (!perms.operate ? '담당 AE 이상' : undefined)}>지금 수집</Button> : null}
        <Button size="sm" icon="edit" onClick={onEdit} disabled={readOnly || !perms.configure} title={lock ?? (!perms.configure ? CONFIGURE_ONLY : undefined)}>설정</Button>
        <Button size="sm" icon={c.status === 'disabled' ? 'play' : 'pause'} onClick={onToggle} disabled={readOnly || !perms.configure} title={lock ?? (!perms.configure ? CONFIGURE_ONLY : undefined)}>{c.status === 'disabled' ? '다시 켜기' : '사용 중지'}</Button>
        <Button size="sm" icon="x" variant="ghost" onClick={onDelete} disabled={readOnly || !perms.configure} title={lock ?? (!perms.configure ? CONFIGURE_ONLY : undefined)}>삭제</Button>
      </div>
    </section>
  );
}

/* ---------- 카탈로그 카드 ---------- */

export function CatalogCard({ p, readOnly, canAdd, exists, onAdd, onUpload }: { p: CatalogProvider; readOnly: boolean; canAdd: boolean; exists: boolean; onAdd: () => void; onUpload?: () => void }) {
  const cap = p.capabilities;
  const known = cap.reads.length > 0;
  const csvOnly = p.csvOnly ?? null;
  const disabledWhy = readOnly ? '서버 연결 시 사용할 수 있습니다' : !canAdd ? 'PM · 관리자 · 소유자만 추가할 수 있습니다' : !p.available ? '구현 중 — 아직 수집을 지원하지 않습니다' : p.provider === 'demo' && exists ? '데모 데이터는 워크스페이스에 하나만 둘 수 있습니다' : undefined;
  return (
    <section className="card conn-cat" aria-label={`${p.label} 커넥터`}>
      <div className="row-between">
        <strong>{p.label}</strong>
        <span className="row" style={{ gap: 4 }}>
          <Pill tone="neutral">{KIND_LABEL[p.kind]}{p.channel ? ` · ${channelLabel(p.channel)}` : ''}</Pill>
          {p.sourceKind === 'demo' ? <Src kind="DEMO" /> : null}
        </span>
      </div>
      {/* CSV 전용 공급자는 API로 연결하지 않으므로 '실계정 연결 전 확인' 대상이 아니다 */}
      {p.sourceKind === 'api' && !p.verifiedLive && !csvOnly ? <UnverifiedPill /> : null}
      {csvOnly ? (
        <div className="stack-sm">
          <strong className="xs">{csvOnlyLabel(csvOnly, TEMPLATES[csvOnly.template as UploadTemplate]?.label ?? csvOnly.template)}</strong>
          <span className="xs muted">{csvOnly.message}</span>
        </div>
      ) : known ? (
        <div className="stack-sm xs">
          <span><span className="muted">수집</span> {cap.reads.map((r) => READ_LABEL[r] ?? r).join(' · ')}</span>
          <span><span className="muted">반영</span> {cap.writes.length ? cap.writes.map((w) => WRITE_LABEL[w] ?? w).join(' · ') : '없음 (수집 전용)'}</span>
          <span><span className="muted">당일 시간대</span> {cap.intraday ? '매시 10분' : '미지원'} · <span className="muted">기간 수집</span> {cap.maxBackfillDays ? `최근 ${Math.min(400, cap.maxBackfillDays)}일` : '업로드로만'}</span>
        </div>
      ) : (
        <span className="xs muted">{readOnly ? '수집 · 반영 범위와 입력 항목은 서버 카탈로그(공식 문서 기준)에서 표시합니다' : '구현 중 — 공식 문서 확인 후 수집 범위가 표시됩니다. 그 전까지는 CSV 업로드를 쓰세요'}</span>
      )}
      <div className="row-between">
        {p.docsUrl ? <a className="xs" href={p.docsUrl} target="_blank" rel="noreferrer noopener">공식 문서 <Icon name="external" size={11} /></a> : <span className="xs muted">{p.sourceKind === 'demo' ? '시연용 생성기 (실제 성과 아님)' : p.sourceKind === 'csv' ? '파일 업로드' : '공식 문서 확인 중'}</span>}
        {csvOnly
          ? <Button size="sm" icon="download" onClick={onUpload} disabled={!onUpload} title={`${csvOnly.template} 템플릿${csvOnly.channel ? ` · 채널 ${csvOnly.channel}` : ''}으로 업로드 탭을 엽니다`}>CSV 업로드로 이동</Button>
          : <Button size="sm" icon="plus" variant="primary" onClick={onAdd} disabled={!!disabledWhy} title={disabledWhy}>연결 추가</Button>}
      </div>
    </section>
  );
}

/* ---------- 연결 추가 · 설정 폼 ---------- */

export interface ConnectionFormValue { label: string; credentials: Record<string, string>; priority: number; writeMode: WriteMode; channel: string | null }

export function ConnectionFormModal({ provider, initial, editing, saving, error, onClose, onSubmit }: {
  provider: CatalogProvider; initial?: ConnectionView | null; editing: boolean; saving: boolean; error: string | null;
  onClose: () => void; onSubmit: (v: ConnectionFormValue) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? provider.label);
  const [creds, setCreds] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const f of provider.credentialFields) o[f.key] = f.secret ? '' : String(initial?.credentials?.[f.key] ?? '');
    return o;
  });
  const [priority, setPriority] = useState(initial?.priority ?? provider.defaultPriority);
  const [writeMode, setWriteMode] = useState<WriteMode>(initial?.writeMode === 'off' ? 'off' : 'dry_run');
  const missing = provider.credentialFields.filter((f) => !f.optional && !creds[f.key]?.trim() && !(editing && f.secret && initial?.credentials?.[f.key]));
  const canSave = label.trim().length > 0 && (editing || missing.length === 0) && !saving;
  return (
    <Modal title={editing ? `${provider.label} 설정` : `${provider.label} 연결 추가`} onClose={onClose} wide
      footer={<>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" icon="check" disabled={!canSave} onClick={() => onSubmit({
          label: label.trim(),
          credentials: Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim() !== '')),
          priority, writeMode, channel: provider.channel,
        })}>{saving ? '저장 중…' : editing ? '저장' : '추가'}</Button>
      </>}>
      <div className="stack">
        {provider.sourceKind === 'api' && !provider.verifiedLive ? <Callout tone="warning" title={UNVERIFIED}>{UNVERIFIED_HINT}</Callout> : null}
        {provider.oauth && !editing ? (
          <Callout tone="info" title={`토큰 없이 시작할 수 있습니다 — ${provider.oauth.startLabel}`}>
            쇼핑몰 ID · Client ID · Client Secret만 저장한 뒤 커넥션 카드의 '{provider.oauth.startLabel}'으로 쇼핑몰 운영자 승인을 받으면 토큰을 서버가 받아 암호화 저장합니다.
            앱의 Redirect URI에는 <code>{provider.oauth.redirectUri}</code>를 등록해 주세요.
          </Callout>
        ) : null}
        <Field label="이름" id="conn-label"><input id="conn-label" className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></Field>
        {provider.credentialFields.length ? (
          <div className="stack-sm">
            <span className="field-label">자격증명 — 서버에 암호화해 저장하고, 비밀값은 다시 보여 주지 않습니다</span>
            {provider.credentialFields.map((f) => {
              const id = `conn-cred-${f.key}`;
              const saved = editing && f.secret && initial?.credentials?.[f.key];
              return (
                <Field key={f.key} id={id} label={<>{f.label}{f.optional ? ' (선택)' : ''}{f.secret ? <span className="muted"> · 비밀값</span> : null}</>}
                  hint={saved ? `저장됨 ${initial?.credentials?.[f.key]} — 바꿀 때만 입력하세요` : f.help}>
                  <input id={id} className="input" type={f.secret ? 'password' : 'text'} autoComplete={f.secret ? 'new-password' : 'off'} spellCheck={false}
                    value={creds[f.key] ?? ''} onChange={(e) => setCreds((p) => ({ ...p, [f.key]: e.target.value }))} placeholder={saved ? '변경하지 않음' : ''} />
                </Field>
              );
            })}
          </div>
        ) : <span className="small muted">{provider.sourceKind === 'csv' ? 'CSV 커넥션은 자격증명이 없습니다. 추가한 뒤 CSV 업로드 탭에서 파일을 올리세요.' : provider.sourceKind === 'demo' ? '데모 데이터는 자격증명 없이 현재 날짜 기준 120일치 TEST DATA를 채웁니다.' : '입력 항목이 없습니다.'}</span>}
        <div className="grid g-2">
          <Field label="우선순위" id="conn-priority" hint="같은 매체 · 채널에 출처가 여럿이면 높은 쪽 (API 100 · CSV 50 · 데모 10)">
            <NumberInput id="conn-priority" value={priority} min={0} max={1000} onChange={(v) => setPriority(Math.max(0, Math.min(1000, Math.round(v))))} />
          </Field>
          {provider.capabilities.writes.length && !editing ? (
            <Field label="쓰기 모드 (처음)" id="conn-write" hint="live는 추가한 뒤 카드에서 2단계 확인으로 켭니다">
              <Segmented<WriteMode> label="처음 쓰기 모드" value={writeMode} onChange={setWriteMode} options={[{ id: 'dry_run', label: 'dry_run (기본)' }, { id: 'off', label: '반영 끔' }]} />
            </Field>
          ) : null}
        </div>
        {!editing && missing.length ? <span className="xs muted">필수 입력: {missing.map((f) => f.label).join(', ')}</span> : null}
        {error ? <Callout tone="critical">{error}</Callout> : null}
      </div>
    </Modal>
  );
}

/* ---------- live 2단계 확인 ---------- */

export function LiveConfirmModal({ c, saving, error, onClose, onConfirm }: { c: ConnectionView; saving: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [text, setText] = useState('');
  const ok = text.trim() === LIVE_CONFIRM_TEXT;
  return (
    <Modal title={`${c.label} — 실제 반영(live) 켜기`} onClose={onClose}
      footer={step === 1
        ? <><Button onClick={onClose}>취소</Button><Button variant="primary" onClick={() => setStep(2)}>내용 확인 · 다음</Button></>
        : <><Button onClick={() => setStep(1)}>이전</Button><Button variant="danger" icon="zap" disabled={!ok || saving} onClick={onConfirm}>{saving ? '켜는 중…' : 'live 켜기'}</Button></>}>
      {step === 1 ? (
        <div className="stack">
          <Callout tone="critical" title="승인된 변경이 매체에 실제로 반영됩니다">
            지금은 dry_run이라 보낼 요청을 기록만 합니다. live를 켜면 승인 · 반영된 {(c.capabilities?.writes ?? []).map((w) => WRITE_LABEL[w] ?? w).join(' · ')} 변경을 {c.providerLabel} API로 바로 호출합니다.
          </Callout>
          <div className="stack-sm small">
            <span>반영 전 검사: 일 변경 상한 · 최대 입찰가 · 대량 변경 감지 · 이 커넥션 쓰기 모드 (서버가 최종 판정)</span>
            <span>되돌리기: 반영 이력에서 롤백하면 이전 값으로 다시 호출합니다</span>
            <span>기록: 켜고 끈 사람 · 시각이 감사 로그에 남습니다</span>
          </div>
          {!c.verifiedLive && c.sourceKind === 'api' ? <Callout tone="warning" title={UNVERIFIED}>{UNVERIFIED_HINT} 첫 반영은 작은 변경 하나로 결과를 매체 화면에서 확인한 뒤 넓히세요.</Callout> : null}
          {c.sourceKind === 'demo' ? <Callout tone="info">데모 커넥터는 live여도 실제 매체를 호출하지 않고 결과를 시뮬레이션합니다 (TEST DATA).</Callout> : null}
        </div>
      ) : (
        <div className="stack">
          <Field label={<>확인 문구를 그대로 입력하세요: <strong>{LIVE_CONFIRM_TEXT}</strong></>} id="live-confirm">
            <input id="live-confirm" className="input" value={text} autoComplete="off" onChange={(e) => setText(e.target.value)} />
          </Field>
          {error ? <Callout tone="critical">{error}</Callout> : null}
        </div>
      )}
    </Modal>
  );
}

/* ---------- 기간 수집 ---------- */

export function SyncModal({ c, today, saving, error, onClose, onSubmit }: { c: ConnectionView; today: string; saving: boolean; error: string | null; onClose: () => void; onSubmit: (range: { from: string; to: string } | null) => void }) {
  const y = addDays(today, -1);
  const b = syncBounds(today, c.capabilities);
  const [mode, setMode] = useState<'recent' | 'range'>('recent');
  const [from, setFrom] = useState(addDays(y, -30));
  const [to, setTo] = useState(y);
  const problem = mode === 'range' ? validateSyncRange(from, to, today, c.capabilities) : null;
  const recent = dailyRecollectDays(c.kind);
  const preset = (days: number) => { setFrom(addDays(y, -(days - 1)) < b.min ? b.min : addDays(y, -(days - 1))); setTo(y); };
  return (
    <Modal title={`${c.label} 지금 수집`} onClose={onClose}
      footer={<><Button onClick={onClose}>취소</Button><Button variant="primary" icon="refresh" disabled={!!problem || saving} onClick={() => onSubmit(mode === 'range' ? { from, to } : null)}>{saving ? '등록 중…' : '수집 대기열에 등록'}</Button></>}>
      <div className="stack">
        <Segmented<'recent' | 'range'> label="수집 범위" value={mode} onChange={setMode} options={[{ id: 'recent', label: `최근 ${recent}일 + 오늘` }, { id: 'range', label: '기간 지정' }]} />
        {mode === 'recent' ? (
          <span className="small ink2">어제 포함 {recent}일({addDays(today, -recent)} ~ {y})을 다시 받아 {c.kind === 'sales' ? '늦게 들어온 취소 · 반품까지 결제일 매출에 반영하고' : '늦게 잡힌 전환까지 반영하고'}{c.capabilities?.intraday ? ', 오늘 시간대 데이터를 함께 받습니다' : ''}. 매일 07:00 예약 수집과 같은 범위입니다.</span>
        ) : (
          <>
            <div className="grid g-2">
              <Field label="시작일" id="sync-from"><input id="sync-from" className="input" type="date" value={from} min={b.min} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="종료일" id="sync-to"><input id="sync-to" className="input" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {[7, 31, 90, 120].filter((n) => n <= b.maxDays).map((n) => <Button key={n} size="sm" onClick={() => preset(n)}>최근 {n}일</Button>)}
            </div>
            <span className="xs muted">{b.maxDays ? `${c.providerLabel} 보관 한도 기준 최근 ${b.maxDays}일(${b.min} 이후)까지 · 31일 단위로 나눠 받습니다` : '이 커넥터는 기간 지정 수집을 지원하지 않습니다'}</span>
            {problem ? <span className="xs" style={{ color: 'var(--critical-ink)' }}>{problem}</span> : null}
          </>
        )}
        {error ? <Callout tone="critical">{error}</Callout> : null}
      </div>
    </Modal>
  );
}

/* ---------- 삭제 확인 ---------- */

export function ConfirmModal({ title, children, confirmLabel, saving, error, onClose, onConfirm }: { title: string; children: ReactNode; confirmLabel: string; saving: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>취소</Button><Button variant="danger" disabled={saving} onClick={onConfirm}>{saving ? '처리 중…' : confirmLabel}</Button></>}>
      <div className="stack">
        {children}
        {error ? <Callout tone="critical">{error}</Callout> : null}
      </div>
    </Modal>
  );
}

/* ---------- 이슈 · 실행 ---------- */

export function IssueRow({ i, extra }: { i: QualityIssue; extra?: ReactNode }) {
  const s = SEVERITY_META[i.severity];
  return (
    <li className="conn-issue">
      <Pill tone={s.tone}>{s.label}</Pill>
      <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
        <span className="small">{i.message}</span>
        <span className="xs muted"><code>{i.code}</code>{extra ? <> · {extra}</> : null}</span>
      </div>
    </li>
  );
}

export function QualityItemRow({ i }: { i: QualityItem }) {
  return <IssueRow i={i} extra={<>{i.label}{i.job ? ` · ${JOB_LABEL[i.job] ?? i.job}` : ''}{i.at ? ` · ${fmtStamp(i.at)}` : ''}</>} />;
}

export function RunDrawer({ r, onClose }: { r: RunView; onClose: () => void }) {
  const st = RUN_STATUS_META[r.status];
  return (
    <Drawer title={`수집 실행 · ${r.label}`} onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ gap: 6 }}>
          <Pill tone={st.tone}>{st.label}</Pill>
          <Pill tone="outline">{JOB_LABEL[r.job] ?? r.job}</Pill>
          {r.provider === 'demo' ? <Src kind="DEMO" /> : null}
        </div>
        <div className="conn-grid">
          <KV k="기간" v={r.rangeFrom ? `${r.rangeFrom} ~ ${r.rangeTo}` : '—'} />
          <KV k="시작 · 소요" v={`${fmtStamp(r.startedAt)} · ${fmtDuration(r.durationMs)}`} />
          <KV k="받은 행 → 쓴 행" v={`${fmt.int(r.rowsIn)} → ${fmt.int(r.rowsWritten)}`} />
          <KV k="계기" v={r.trigger === 'schedule' ? '예약' : r.trigger === 'manual' ? '수동' : r.trigger === 'initial' ? '첫 연결' : r.trigger === 'upload' ? '업로드' : r.trigger ?? '—'} />
        </div>
        {Object.keys(r.stats ?? {}).length ? (
          <div className="xs ink2">{Object.entries(r.stats).filter(([, n]) => n).map(([k, n]) => `${READ_LABEL[k] ?? k} ${fmt.int(n)}`).join(' · ')}</div>
        ) : null}
        {r.error ? <Callout tone="critical" title="실패 사유">{r.error}</Callout> : null}
        <strong className="small">품질 검사 {r.issues.length ? `${r.issues.length}건` : '이상 없음'}</strong>
        {r.issues.length ? <ul className="conn-issues">{r.issues.map((i, k) => <IssueRow key={`${i.code}-${k}`} i={i} />)}</ul> : <span className="xs muted">누락 날짜 · 중복 · 음수 · 클릭 &gt; 노출 · 전환 &gt; 클릭 · 광고비 0 · 같은 요일 대비 ±80% · 키워드 합계 차이 10% 기준 모두 통과</span>}
      </div>
    </Drawer>
  );
}
