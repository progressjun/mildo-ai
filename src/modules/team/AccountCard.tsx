/** 내 계정 보안 — 접속 세션 목록 · 종료, 다른 기기 모두 로그아웃, 비밀번호 변경 */
import { useState, type FormEvent } from 'react';
import { Button, Card, DataTable, Field, Pill, type Column } from '@/ui/primitives';
import { fmtKst, passwordHint, relTime, uaSummary, type SessionRow } from './engine';
import { ConfirmButton } from './parts';

export interface AccountHandlers {
  onRevokeSession: (s: SessionRow) => void;
  onRevokeOthers: () => void;
  onChangePassword: (current: string, next: string) => Promise<boolean>;
}

export function SessionsCard({ sessions, readOnly, busy, nowMs, handlers }: { sessions: SessionRow[]; readOnly: boolean; busy: string | null; nowMs: number; handlers: AccountHandlers }) {
  const others = sessions.filter((s) => !s.current).length;
  const columns: Column<SessionRow>[] = [
    {
      key: 'device', label: '기기 · 브라우저',
      render: (s) => <span title={s.user_agent ?? undefined}>{uaSummary(s.user_agent)} {s.current ? <Pill tone="accent">현재 세션</Pill> : null}</span>,
    },
    { key: 'ip', label: 'IP', render: (s) => <span className="num xs">{s.ip ?? '—'}</span> },
    { key: 'created', label: '로그인', sort: (s) => Date.parse(s.created_at), render: (s) => <span className="xs">{fmtKst(s.created_at, nowMs)}</span> },
    { key: 'seen', label: '마지막 사용', sort: (s) => Date.parse(s.last_seen_at), render: (s) => <span title={`${fmtKst(s.last_seen_at, nowMs)} (KST) · 5분 단위 갱신`}>{relTime(s.last_seen_at, nowMs)}</span> },
    { key: 'exp', label: '만료', render: (s) => <span className="xs muted">{fmtKst(s.expires_at, nowMs)}</span> },
    {
      key: 'actions', label: '', align: 'right',
      render: (s) => (s.current
        ? <span className="xs muted">로그아웃은 상단 메뉴</span>
        : <ConfirmButton label="종료" confirmLabel="이 세션 종료" danger disabled={readOnly} busy={busy === `session:${s.id}`} onConfirm={() => handlers.onRevokeSession(s)} />),
    },
  ];
  return (
    <Card title="내 접속 세션" sub={`유효한 세션 ${sessions.length}개 · 모르는 기기 · IP가 보이면 종료하고 비밀번호를 바꿔 주세요`}
      actions={others > 0 ? <ConfirmButton label={`다른 기기 ${others}곳 로그아웃`} confirmLabel="현재 세션만 남기기" danger disabled={readOnly} busy={busy === 'sessions:others'} onConfirm={handlers.onRevokeOthers} /> : undefined}>
      <DataTable rows={sessions} columns={columns} rowKey={(s) => s.id} empty="유효한 세션이 없습니다" />
    </Card>
  );
}

export function PasswordCard({ readOnly, busy, onChangePassword }: { readOnly: boolean; busy: boolean; onChangePassword: AccountHandlers['onChangePassword'] }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hint = next ? passwordHint(next) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || busy) return;
    if (!current) return setError('현재 비밀번호를 입력해 주세요');
    const p = passwordHint(next);
    if (p) return setError(p);
    if (next !== confirm) return setError('새 비밀번호 확인이 일치하지 않습니다');
    if (next === current) return setError('현재 비밀번호와 다른 비밀번호를 입력해 주세요');
    setError(null);
    if (await onChangePassword(current, next)) {
      setCurrent('');
      setNext('');
      setConfirm('');
    }
  };
  return (
    <Card title="비밀번호 변경" sub="바꾸면 이 기기를 뺀 다른 모든 세션이 종료되고, 계정 이메일로 알림이 갑니다">
      <form className="stack" onSubmit={submit} noValidate>
        <div className="team-pw-form">
          <Field label="현재 비밀번호" id="team-pw-current">
            <input id="team-pw-current" className="input" type="password" autoComplete="current-password" value={current} disabled={readOnly} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="새 비밀번호" id="team-pw-next" hint={hint ?? '10자 이상 · 영문 대소문자 · 숫자 · 기호 중 2가지 이상'}>
            <input id="team-pw-next" className="input" type="password" autoComplete="new-password" value={next} disabled={readOnly} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="새 비밀번호 확인" id="team-pw-confirm">
            <input id="team-pw-confirm" className="input" type="password" autoComplete="new-password" value={confirm} disabled={readOnly} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        {error ? <div className="xs team-warn" role="alert">{error}</div> : null}
        <div className="row">
          <Button type="submit" variant="primary" icon="shield" disabled={readOnly || busy}>{busy ? '바꾸는 중…' : '비밀번호 바꾸기'}</Button>
          <span className="xs muted">비밀번호를 잊었다면 로그아웃 후 로그인 화면의 재설정 메일(1시간 유효 · 1회용)을 쓰세요.</span>
        </div>
      </form>
    </Card>
  );
}
