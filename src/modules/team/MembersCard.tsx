/** 구성원 표 — 역할 선택(권한별) · 2단계 적용 · 계정 비활성화 · 비밀번호 재설정 링크 발급 · 제외(2단계 확인) */
import { useState } from 'react';
import { Button, Callout, Card, CopyButton, DataTable, Pill, type Column } from '@/ui/primitives';
import { ROLE_LABEL, type Role } from '@/core/permissions';
import { fmtKst, isDormant, memberActions, relTime, type Member, type ResetLinkResult } from './engine';
import { ConfirmButton, RolePill } from './parts';

export interface MemberHandlers {
  onRole: (m: Member, role: Role) => void;
  onTitle: (m: Member, title: string | null) => void;
  onStatus: (m: Member, status: 'active' | 'disabled') => void;
  onRemove: (m: Member) => void;
  /** 비밀번호 재설정 링크 발급 (POST /w/:ws/members/:userId/password-reset) */
  onResetLink: (m: Member) => void;
}

/** 마지막으로 발급한 재설정 링크 결과 (메일로 보냈으면 link 없음) */
export type LastResetLink = ResetLinkResult & { name: string };

/** 재설정 링크 발급 결과 — 메일로 보냈으면 그렇다고, 못 보냈으면(SMTP 미설정 · 실패) 직접 전달할 링크 */
export function ResetLinkNote({ result, nowMs }: { result: LastResetLink; nowMs?: number }) {
  if (result.mail.sent || !result.link) {
    return (
      <Callout tone="good" title={`${result.name}(${result.email})에게 재설정 링크 메일을 보냈습니다`}>
        링크는 본인 메일로만 보냈고 이 화면에는 보이지 않습니다 · 만료 {fmtKst(result.expiresAt, nowMs)} · 이전에 보낸 링크는 더 이상 쓸 수 없습니다.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title={`${result.name} 재설정 링크를 발급했습니다 · 메일은 보내지 않았습니다`}>
      <div className="stack-sm">
        <span>{result.mail.reason ?? '메일 발송 결과를 확인하지 못했습니다'} — 아래 링크를 복사해 본인({result.email})에게 직접 전달해 주세요.</span>
        <div className="team-link" aria-label="비밀번호 재설정 링크">{result.link}</div>
        <div className="row"><CopyButton text={result.link} label="재설정 링크 복사" /><span className="xs muted">링크를 가진 사람은 이 계정의 비밀번호를 정할 수 있으니 본인에게만 전달하세요 · 만료 {fmtKst(result.expiresAt, nowMs)} · 1회용</span></div>
      </div>
    </Callout>
  );
}

export function MembersCard({ members, myRole, canManage, readOnly, busy, nowMs, handlers, sub, lastReset }: {
  members: Member[];
  myRole: Role | null;
  canManage: boolean;
  readOnly: boolean;
  busy: string | null;
  nowMs: number;
  handlers: MemberHandlers;
  sub?: string;
  lastReset?: LastResetLink | null;
}) {
  const [draftRole, setDraftRole] = useState<Record<string, Role>>({});
  const [draftTitle, setDraftTitle] = useState<Record<string, string>>({});

  const columns: Column<Member>[] = [
    {
      key: 'name', label: '이름 · 이메일', sort: (m) => m.name,
      render: (m) => (
        <div className="team-name">
          <strong>{m.name}{m.is_me ? <> <Pill tone="accent">나</Pill></> : null}</strong>
          <span className="xs muted num">{m.email}</span>
        </div>
      ),
    },
    {
      key: 'role', label: '역할', sort: (m) => ['owner', 'admin', 'pm', 'ae', 'client', 'viewer'].indexOf(m.role),
      render: (m) => {
        const acts = memberActions(myRole, m, members);
        const draft = draftRole[m.user_id];
        if (!canManage || acts.roleOptions.length <= 1) {
          return <span title={canManage && acts.roleBlocked ? acts.roleBlocked.message : undefined}><RolePill role={m.role} /></span>;
        }
        const key = `role:${m.user_id}`;
        return (
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <select className="select team-select" aria-label={`${m.name} 역할`} value={draft ?? m.role} disabled={readOnly || busy === key}
              onChange={(e) => setDraftRole((d) => ({ ...d, [m.user_id]: e.target.value as Role }))}>
              {acts.roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            {draft && draft !== m.role ? (
              <>
                <Button size="sm" variant={draft === 'owner' || m.role === 'owner' ? 'accent' : 'primary'} disabled={readOnly || !!busy}
                  title={draft === 'owner' ? '소유자는 모든 권한 · 다른 소유자 지정 · 광고주(CLIENT) 승인 권한을 가집니다' : undefined}
                  onClick={(e) => {
                    if (e.detail > 1) return;
                    handlers.onRole(m, draft);
                    setDraftRole((d) => { const n = { ...d }; delete n[m.user_id]; return n; });
                  }}>
                  {draft === 'owner' ? '소유자로 지정' : '적용'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraftRole((d) => { const n = { ...d }; delete n[m.user_id]; return n; })}>취소</Button>
              </>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'title', label: '직함', sort: (m) => m.title ?? '',
      render: (m) => {
        if (!canManage) return m.title ?? <span className="muted">—</span>;
        const v = draftTitle[m.user_id];
        const dirty = v !== undefined && v.trim() !== (m.title ?? '');
        return (
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <input className="input team-title-input" aria-label={`${m.name} 직함`} maxLength={60} placeholder="직함 (선택)" disabled={readOnly}
              value={v ?? m.title ?? ''} onChange={(e) => setDraftTitle((d) => ({ ...d, [m.user_id]: e.target.value }))} />
            {dirty ? (
              <Button size="sm" disabled={readOnly || !!busy} onClick={(e) => {
                if (e.detail > 1) return;
                handlers.onTitle(m, v.trim() || null);
                setDraftTitle((d) => { const n = { ...d }; delete n[m.user_id]; return n; });
              }}>저장</Button>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'status', label: '계정', sort: (m) => m.status,
      render: (m) => (m.status === 'active' ? <Pill tone="good" icon="check">활성</Pill> : <Pill tone="critical" icon="x" title="로그인 차단 · 세션 종료됨">비활성</Pill>),
    },
    {
      key: 'login', label: '최근 로그인', sort: (m) => (m.last_login_at ? Date.parse(m.last_login_at) : 0),
      render: (m) => {
        const dormant = isDormant(m, nowMs);
        return (
          <span title={m.last_login_at ? `${fmtKst(m.last_login_at, nowMs)} (KST)` : '로그인 기록 없음'} className={dormant ? 'team-warn' : undefined}>
            {m.last_login_at ? relTime(m.last_login_at, nowMs) : '아직 없음'}{dormant ? ' · 30일 미접속' : ''}
          </span>
        );
      },
    },
    ...(canManage
      ? [{
        key: 'sessions', label: '유효 세션', align: 'right' as const, sort: (m: Member) => m.active_sessions ?? 0,
        render: (m: Member) => <span className="num" title={m.last_seen_at ? `마지막 사용 ${fmtKst(m.last_seen_at, nowMs)}` : undefined}>{m.active_sessions ?? '—'}</span>,
      }]
      : []),
    {
      key: 'joined', label: '합류', sort: (m) => Date.parse(m.joined_at),
      render: (m) => <span className="xs muted">{fmtKst(m.joined_at, nowMs)}</span>,
    },
    ...(canManage
      ? [{
        key: 'actions', label: '', align: 'right' as const,
        render: (m: Member) => {
          const acts = memberActions(myRole, m, members);
          return (
            <div className="team-actions">
              {!m.is_me ? (
                <ConfirmButton
                  label={m.status === 'active' ? '비활성화' : '재활성화'}
                  confirmLabel={m.status === 'active' ? '비활성화 · 모든 세션 종료' : '재활성화'}
                  danger={m.status === 'active'}
                  disabled={readOnly || !!acts.disable}
                  busy={busy === `status:${m.user_id}`}
                  title={acts.disable?.message ?? (m.status === 'active' ? '계정 로그인을 막고 모든 세션을 끊습니다 (다른 워크스페이스 소속이면 서버가 거부합니다)' : '다시 로그인할 수 있게 합니다')}
                  onConfirm={() => handlers.onStatus(m, m.status === 'active' ? 'disabled' : 'active')}
                />
              ) : null}
              {!m.is_me ? (
                <ConfirmButton
                  label="재설정 링크"
                  confirmLabel="링크 발급"
                  icon="link"
                  disabled={readOnly || !!acts.resetLink}
                  busy={busy === `reset:${m.user_id}`}
                  title={acts.resetLink?.message ?? '비밀번호 재설정 링크를 발급합니다 (60분 · 1회용, 이전 링크 무효). 메일(SMTP)이 설정되어 있으면 본인 메일로 보내고, 없으면 여기서 복사해 직접 전달합니다'}
                  onConfirm={() => handlers.onResetLink(m)}
                />
              ) : null}
              <ConfirmButton
                label={m.is_me ? '나가기' : '제외'}
                confirmLabel={m.is_me ? '정말 나가기' : '정말 제외'}
                danger
                icon="x"
                disabled={readOnly || !!acts.remove}
                busy={busy === `remove:${m.user_id}`}
                title={acts.remove?.message ?? (m.is_me ? '이 워크스페이스에서 나갑니다' : '이 워크스페이스 멤버십만 지웁니다 (계정 · 다른 워크스페이스 접속은 유지)')}
                onConfirm={() => handlers.onRemove(m)}
              />
            </div>
          );
        },
      }]
      : []),
  ];

  return (
    <Card title="구성원" sub={sub ?? `${members.length}명 · 역할은 서버가 최종 판정합니다 (같은 규칙으로 화면에서 미리 막음)`}>
      {lastReset ? <div style={{ marginBottom: 12 }}><ResetLinkNote result={lastReset} nowMs={nowMs} /></div> : null}
      <DataTable rows={members} columns={columns} rowKey={(m) => m.user_id} empty="구성원이 없습니다" />
    </Card>
  );
}
