/** 초대 — 이메일 · 역할로 초대(복사 가능한 링크 · 메일 발송 결과), 대기 · 만료 · 수락 목록, 다시 보내기 · 취소(2단계) */
import { useState, type FormEvent } from 'react';
import { Button, Callout, Card, CopyButton, DataTable, Field, Pill, Toggle, type Column } from '@/ui/primitives';
import { ROLE_LABEL, type Role } from '@/core/permissions';
import { EMAIL_RE, INVITE_STATUS_META, fmtKst, relTime, type Invite, type InviteResult } from './engine';
import { invitableRoles, ROLE_DESC } from './rules';
import { ConfirmButton, RolePill } from './parts';

export interface InviteHandlers {
  onInvite: (email: string, role: Role) => Promise<boolean>;
  onResend: (inv: Invite) => void;
  onRevoke: (inv: Invite) => void;
}

export function InviteForm({ myRole, readOnly, busy, onInvite }: { myRole: Role | null; readOnly: boolean; busy: boolean; onInvite: InviteHandlers['onInvite'] }) {
  const roles = invitableRoles(myRole);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('ae') ? 'ae' : roles[0] ?? 'viewer');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || busy) return;
    const v = email.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) return setError('이메일 형식을 확인해 주세요');
    setError(null);
    if (await onInvite(v, role)) setEmail('');
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="team-form">
        <Field label="초대할 이메일" id="team-invite-email">
          <input id="team-invite-email" className="input" type="email" autoComplete="off" placeholder="name@company.com" value={email} disabled={readOnly}
            onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="역할" id="team-invite-role">
          <select id="team-invite-role" className="select" value={role} disabled={readOnly} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </Field>
        <Button type="submit" variant="primary" icon="send" disabled={readOnly || busy || !email.trim()}>{busy ? '보내는 중…' : '초대 보내기'}</Button>
      </div>
      {error ? <div className="xs team-warn" role="alert">{error}</div> : null}
      <div className="small ink2"><strong>{ROLE_LABEL[role]}</strong> 권한: {ROLE_DESC[role]}</div>
      <div className="xs muted">
        링크는 7일 동안 한 번만 쓸 수 있습니다. 소유자 권한은 초대로 줄 수 없고, 가입한 뒤 소유자가 구성원 표에서 바꿉니다.
        SMTP가 설정되지 않았거나 메일이 실패해도 링크를 복사해 메신저로 전달할 수 있습니다.
      </div>
    </form>
  );
}

export function InviteResultNote({ result }: { result: InviteResult }) {
  const mail = result.mail;
  return (
    <Callout tone={mail?.sent ? 'good' : 'warning'} title={mail?.sent ? `${result.invite.email}에게 초대 메일을 보냈습니다` : `${result.invite.email} 초대를 만들었습니다 · 메일은 보내지 못했습니다`}>
      <div className="stack-sm">
        {!mail?.sent ? <span>{mail?.reason ?? '메일 발송 결과를 확인하지 못했습니다'} — 아래 링크를 복사해 직접 전달해 주세요.</span> : <span>메일이 늦게 도착하면 아래 링크를 복사해 전달할 수 있습니다.</span>}
        <div className="team-link" aria-label="초대 링크">{result.link}</div>
        <div className="row"><CopyButton text={result.link} label="초대 링크 복사" /><span className="xs muted">링크를 가진 사람은 누구나 이 이메일로 가입할 수 있으니 본인에게만 전달하세요 · 만료 {fmtKst(result.invite.expires_at)}</span></div>
      </div>
    </Callout>
  );
}

export function InvitesCard({ invites, myRole, readOnly, busy, nowMs, handlers, lastInvite }: {
  invites: Invite[];
  myRole: Role | null;
  readOnly: boolean;
  busy: string | null;
  nowMs: number;
  handlers: InviteHandlers;
  lastInvite: InviteResult | null;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const rows = invites.filter((i) => showClosed || i.status === 'pending' || i.status === 'expired');
  const pending = invites.filter((i) => i.status === 'pending').length;
  const expired = invites.filter((i) => i.status === 'expired').length;

  const columns: Column<Invite>[] = [
    { key: 'email', label: '이메일', sort: (i) => i.email, render: (i) => <span className="num">{i.email}</span> },
    { key: 'role', label: '역할', render: (i) => <RolePill role={i.role} /> },
    {
      key: 'status', label: '상태', sort: (i) => i.status,
      render: (i) => <Pill tone={INVITE_STATUS_META[i.status].tone} title={i.revoke_reason === 'superseded' ? '같은 이메일로 새 초대를 보내 이전 링크가 무효가 됨' : undefined}>
        {INVITE_STATUS_META[i.status].label}{i.revoke_reason === 'superseded' ? ' (새 초대로 대체)' : ''}
      </Pill>,
    },
    {
      key: 'expires', label: '만료', sort: (i) => Date.parse(i.expires_at),
      render: (i) => (i.status === 'accepted'
        ? <span className="xs muted">수락 {fmtKst(i.accepted_at, nowMs)}{i.accepted_by_name ? ` · ${i.accepted_by_name}` : ''}</span>
        : <span title={`${fmtKst(i.expires_at, nowMs)} (KST)`}>{relTime(i.expires_at, nowMs)}</span>),
    },
    {
      key: 'mail', label: '메일',
      render: (i) => (i.mail_error
        ? <Pill tone="warning" icon="alert" title={i.mail_error}>미발송</Pill>
        : i.mail_sent_at ? <span className="xs muted">발송 {relTime(i.mail_sent_at, nowMs)}{i.send_count > 1 ? ` · ${i.send_count}회` : ''}</span> : <span className="muted">—</span>),
    },
    { key: 'by', label: '보낸 사람', render: (i) => <span className="xs">{i.invited_by_name ?? '—'}</span> },
    {
      key: 'actions', label: '', align: 'right',
      render: (i) => (i.status === 'pending' || i.status === 'expired' ? (
        <div className="team-actions">
          <Button size="sm" icon="refresh" disabled={readOnly || !!busy} title="새 링크로 다시 보냅니다 (이전 링크는 무효 · 만료 7일 연장)"
            onClick={(e) => { if (e.detail > 1) return; handlers.onResend(i); }}>{busy === `resend:${i.id}` ? '보내는 중…' : '다시 보내기'}</Button>
          <ConfirmButton label="취소" confirmLabel="초대 취소" danger disabled={readOnly} busy={busy === `revoke:${i.id}`} onConfirm={() => handlers.onRevoke(i)} />
        </div>
      ) : null),
    },
  ];

  return (
    <div className="stack-lg">
      <Card title="구성원 초대" sub="역할을 골라 이메일로 초대합니다 · 수락하면 바로 로그인됩니다">
        <InviteForm myRole={myRole} readOnly={readOnly} busy={busy === 'invite'} onInvite={handlers.onInvite} />
        {lastInvite ? <div style={{ marginTop: 12 }}><InviteResultNote result={lastInvite} /></div> : null}
      </Card>
      <Card title="초대 현황" sub={`수락 대기 ${pending}건 · 만료 ${expired}건 · 만료된 초대는 다시 보내면 새 링크로 7일 연장됩니다`}
        actions={<Toggle id="team-show-closed" checked={showClosed} onChange={setShowClosed} label="수락 · 취소된 초대도 보기" />}>
        <DataTable rows={rows} columns={columns} rowKey={(i) => i.id} empty={showClosed ? '초대 기록이 없습니다' : '대기 · 만료된 초대가 없습니다'} />
      </Card>
    </div>
  );
}
