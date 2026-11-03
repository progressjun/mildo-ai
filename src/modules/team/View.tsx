/**
 * 팀 · 권한 (07 관리 · 연동) — 구성원 · 역할 · 초대 · 내 세션 · 비밀번호 · 역할 표.
 * 서버 모드: /api/w/:ws/members · invites, /api/auth/sessions · password (server/src/team). SSE 'member' 이벤트로 다른 관리자 변경을 반영.
 * 데모 모드: 예시 상태(TEST DATA)를 읽기 전용으로 보여 주고, 서버 연결 시 실제로 동작한다고 안내한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Callout, Card, Empty, PageHeader, Pill, Src, Stat, Tabs, Button } from '@/ui/primitives';
import { useActions } from '@/core/store';
import { useSaas } from '@/saas/context';
import { onServerEvent } from '@/saas/events';
import { can, ROLE_LABEL, type Role } from '@/core/permissions';
import { summarizeTeam, type Invite, type InviteResult, type Member, type SessionRow } from './engine';
import { demoInvites, demoMembers, demoSessions } from './demo';
import * as teamApi from './api';
import { MembersCard, type MemberHandlers } from './MembersCard';
import { InvitesCard, type InviteHandlers } from './InvitesCard';
import { PasswordCard, SessionsCard, type AccountHandlers } from './AccountCard';
import { RoleMatrixCard } from './RoleMatrix';
import { DemoNote, errorText } from './parts';
import './styles.css';

export type TeamTab = 'members' | 'invites' | 'account' | 'roles';
export type TeamHandlers = MemberHandlers & InviteHandlers & AccountHandlers & { onReload: () => void };

export interface TeamScreenProps {
  mode: 'demo' | 'server';
  workspaceName: string;
  myRole: Role | null;
  members: Member[] | null;
  /** 팀 관리 권한이 없으면 null */
  invites: Invite[] | null;
  sessions: SessionRow[] | null;
  error: string | null;
  busy: string | null;
  lastInvite: InviteResult | null;
  nowMs: number;
  handlers: TeamHandlers;
  initialTab?: TeamTab;
}

function ownerVerdict(owners: number): { tone: 'critical' | 'warning' | 'good'; label: string } {
  if (owners <= 0) return { tone: 'critical', label: '활성 소유자 없음' };
  if (owners === 1) return { tone: 'warning', label: '단일 소유자' };
  return { tone: 'good', label: '백업 소유자 있음' };
}

/** 화면 본체 (데이터 · 핸들러를 받아 그린다 — 서버 · 데모 공용, SSR 테스트 대상) */
export function TeamScreen(p: TeamScreenProps) {
  const [tab, setTab] = useState<TeamTab>(p.initialTab ?? 'members');
  const readOnly = p.mode === 'demo';
  const canManage = !!p.myRole && can(p.myRole, 'manage_team');
  const members = p.members ?? [];
  const sum = summarizeTeam(members, p.invites ?? [], p.nowMs);
  const ov = ownerVerdict(sum.owners);
  const others = (p.sessions ?? []).filter((s) => !s.current).length;

  return (
    <div className="page team-page">
      <PageHeader eyebrow="07 · TEAM & ROLES" title="팀 · 권한"
        sub="구성원을 초대하고 역할을 정합니다. 역할마다 승인 가능 등급 · 설정 · 실반영 권한이 다르고, 서버가 모든 쓰기 요청을 같은 표로 판정합니다."
        sources={<>{readOnly ? <Src kind="DEMO" /> : <Src kind="LIVE" title="서버의 실제 구성원 · 세션" />}<span className="xs muted">{p.workspaceName}{p.myRole ? ` · 내 역할 ${ROLE_LABEL[p.myRole]}` : ''}</span></>}
        actions={!readOnly ? <Button size="sm" icon="refresh" onClick={p.handlers.onReload}>새로고침</Button> : undefined} />

      {readOnly ? <DemoNote what="구성원 · 초대 · 세션" /> : null}
      {p.error ? <Callout tone="critical" title="불러오지 못한 항목이 있습니다">{p.error}</Callout> : null}

      <div className="grid g-4">
        <Stat label="구성원" value={p.members ? sum.members : '—'} foot={<span className="team-kpi-basis">활성 {sum.active} · 비활성 {sum.disabled}{sum.byRole.length ? ` · ${sum.byRole.map((r) => `${r.label} ${r.count}`).join(' · ')}` : ''}</span>} />
        <Stat label="활성 소유자" value={p.members ? sum.owners : '—'}
          foot={p.members ? <span className="stack-sm" style={{ gap: 2 }}><Pill tone={ov.tone}>{ov.label}</Pill><span className="team-kpi-basis">기준: 활성 소유자 2명 이상이면 한 명이 비워도 소유자 업무(소유자 지정 · CLIENT 승인)가 멈추지 않음</span></span> : null} />
        <Stat label="수락 대기 초대" value={p.invites ? sum.pending : '—'}
          foot={<span className="team-kpi-basis">{p.invites ? `만료 ${sum.expired}건 · 메일 미발송 ${sum.mailFailed.length}건 · 링크 유효 7일` : '관리자 · 소유자만 볼 수 있습니다'}</span>} />
        <Stat label="30일 미접속" value={p.members ? sum.dormant.length : '—'}
          foot={<span className="team-kpi-basis">기준: 활성 계정 중 최근 로그인(없으면 합류) 30일 초과 · 퇴사 · 이동이면 제외하거나 비활성화</span>} />
      </div>

      <Tabs<TeamTab> value={tab} onChange={setTab} tabs={[
        { id: 'members', label: '구성원' },
        { id: 'invites', label: '초대', badge: sum.pending ? <Pill tone="accent">{sum.pending}</Pill> : undefined },
        { id: 'account', label: '내 계정 보안', badge: others ? <Pill tone="neutral">{others + 1}</Pill> : undefined },
        { id: 'roles', label: '역할 · 권한 표' },
      ]} />

      {tab === 'members' ? (
        p.members
          ? <MembersCard members={members} myRole={p.myRole} canManage={canManage} readOnly={readOnly} busy={p.busy} nowMs={p.nowMs} handlers={p.handlers} />
          : <Card><Empty icon="users" title="구성원을 불러오는 중입니다" /></Card>
      ) : null}

      {tab === 'invites' ? (
        canManage && p.invites
          ? <InvitesCard invites={p.invites} myRole={p.myRole} readOnly={readOnly} busy={p.busy} nowMs={p.nowMs} handlers={p.handlers} lastInvite={p.lastInvite} />
          : <Card><Empty icon="shield" title={canManage ? '초대 현황을 불러오는 중입니다' : '초대는 관리자 · 소유자만 할 수 있습니다'}>{canManage ? null : '초대가 필요하면 워크스페이스 관리자에게 요청해 주세요.'}</Empty></Card>
      ) : null}

      {tab === 'account' ? (
        <div className="stack-lg">
          {p.sessions ? <SessionsCard sessions={p.sessions} readOnly={readOnly} busy={p.busy} nowMs={p.nowMs} handlers={p.handlers} /> : <Card><Empty icon="shield" title="세션을 불러오는 중입니다" /></Card>}
          <PasswordCard readOnly={readOnly} busy={p.busy === 'password'} onChangePassword={p.handlers.onChangePassword} />
        </div>
      ) : null}

      {tab === 'roles' ? <RoleMatrixCard /> : null}
    </div>
  );
}

const NOOP_HANDLERS: TeamHandlers = {
  onRole: () => undefined, onTitle: () => undefined, onStatus: () => undefined, onRemove: () => undefined,
  onInvite: async () => false, onResend: () => undefined, onRevoke: () => undefined,
  onRevokeSession: () => undefined, onRevokeOthers: () => undefined, onChangePassword: async () => false, onReload: () => undefined,
};

function DemoTeam() {
  const nowMs = useMemo(() => Date.now(), []);
  const members = useMemo(() => demoMembers(nowMs), [nowMs]);
  const invites = useMemo(() => demoInvites(nowMs), [nowMs]);
  const sessions = useMemo(() => demoSessions(nowMs), [nowMs]);
  return (
    <TeamScreen mode="demo" workspaceName="수면밀도 퍼포먼스 (예시)" myRole="admin" members={members} invites={invites} sessions={sessions}
      error={null} busy={null} lastInvite={null} nowMs={nowMs} handlers={NOOP_HANDLERS} />
  );
}

function ServerTeam() {
  const saas = useSaas();
  const ws = saas.workspace!;
  const myRole = ws.role;
  const canManage = can(myRole, 'manage_team');
  const { toast } = useActions();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    const [m, i, s] = await Promise.allSettled([
      teamApi.fetchMembers(ws.id),
      canManage ? teamApi.fetchInvites(ws.id) : Promise.resolve(null),
      teamApi.fetchSessions(),
    ]);
    const errs: string[] = [];
    if (m.status === 'fulfilled') setMembers(m.value); else errs.push(`구성원: ${errorText(m.reason)}`);
    if (i.status === 'fulfilled') setInvites(i.value); else errs.push(`초대: ${errorText(i.reason)}`);
    if (s.status === 'fulfilled') setSessions(s.value); else errs.push(`세션: ${errorText(s.reason)}`);
    setError(errs.length ? errs.join(' · ') : null);
  }, [ws.id, canManage]);

  useEffect(() => { void load(); }, [load]);
  // 다른 관리자의 변경 (초대 · 역할 · 제외) — 몰리면 한 번만 다시 읽는다
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onServerEvent('member', (e) => {
      if (e.ws && e.ws !== ws.id) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void load();
        if (e.id && e.id === saas.me?.user.id) void saas.refreshMe().catch(() => null);
      }, 300);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [load, ws.id, saas]);

  /** 한 번에 하나의 작업만 (더블 클릭 · 연타 방지) */
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, ok: (r: T) => { title: string; body?: string } | null): Promise<T | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(key);
    try {
      const r = await fn();
      const msg = ok(r);
      if (msg) toast({ tone: 'good', ...msg });
      return r;
    } catch (e) {
      toast({ tone: 'critical', title: '처리하지 못했습니다', body: errorText(e) });
      return null;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [toast]);

  const handlers: TeamHandlers = {
    onReload: () => void load(),
    onRole: (m, role) => void run(`role:${m.user_id}`, () => teamApi.patchMember(ws.id, m.user_id, { role }), (r) => {
      setMembers(r.members);
      return { title: `${m.name} 역할을 ${ROLE_LABEL[role]}(으)로 바꿨습니다`, body: '감사 로그에 기록했습니다' };
    }),
    onTitle: (m, title) => void run(`title:${m.user_id}`, () => teamApi.patchMember(ws.id, m.user_id, { title }), (r) => {
      setMembers(r.members);
      return { title: '직함을 저장했습니다' };
    }),
    onStatus: (m, status) => void run(`status:${m.user_id}`, () => teamApi.patchMember(ws.id, m.user_id, { status }), (r) => {
      setMembers(r.members);
      return status === 'disabled'
        ? { title: `${m.name} 계정을 비활성화했습니다`, body: '로그인이 막히고 모든 세션이 종료되었습니다' }
        : { title: `${m.name} 계정을 다시 활성화했습니다` };
    }),
    onRemove: (m) => void run(`remove:${m.user_id}`, () => teamApi.removeMember(ws.id, m.user_id), (r) => {
      if (m.is_me) {
        void saas.refreshMe().catch(() => null);
        return { title: '워크스페이스에서 나갔습니다' };
      }
      setMembers(r.members);
      return { title: `${m.name}님을 이 워크스페이스에서 제외했습니다`, body: '계정과 다른 워크스페이스 접속은 그대로입니다' };
    }),
    onInvite: async (email, role) => {
      const r = await run('invite', () => teamApi.createInvite(ws.id, email, role), (res) => {
        setLastInvite(res);
        return res.mail?.sent ? { title: `${email}에게 초대를 보냈습니다` } : null;
      });
      if (r && !r.mail?.sent) toast({ tone: 'warning', title: '초대를 만들었지만 메일은 보내지 못했습니다', body: '초대 링크를 복사해 전달해 주세요' });
      if (r) void load();
      return !!r;
    },
    onResend: (inv) => void run(`resend:${inv.id}`, () => teamApi.resendInvite(ws.id, inv.id), (res) => {
      setLastInvite(res);
      void load();
      return { title: `${inv.email} 초대를 새 링크로 다시 보냈습니다`, body: res.mail?.sent ? '이전 링크는 더 이상 쓸 수 없습니다' : '메일은 보내지 못했습니다 — 링크를 복사해 전달해 주세요' };
    }),
    onRevoke: (inv) => void run(`revoke:${inv.id}`, () => teamApi.revokeInvite(ws.id, inv.id), () => {
      void load();
      return { title: `${inv.email} 초대를 취소했습니다` };
    }),
    onRevokeSession: (s) => void run(`session:${s.id}`, () => teamApi.revokeSession(s.id), () => {
      setSessions((list) => list?.filter((x) => x.id !== s.id) ?? null);
      return { title: '세션을 종료했습니다' };
    }),
    onRevokeOthers: () => void run('sessions:others', () => teamApi.revokeOtherSessions(), (r) => {
      setSessions((list) => list?.filter((x) => x.current) ?? null);
      return { title: `다른 기기 ${r.revoked}곳을 로그아웃했습니다` };
    }),
    onChangePassword: async (current, next) => {
      const r = await run('password', () => teamApi.changePassword(current, next), (res) => ({
        title: '비밀번호를 바꿨습니다', body: res.revokedSessions ? `다른 기기 세션 ${res.revokedSessions}개를 종료했습니다` : undefined,
      }));
      if (r) void teamApi.fetchSessions().then(setSessions).catch(() => null);
      return !!r;
    },
  };

  return (
    <TeamScreen mode="server" workspaceName={ws.name} myRole={myRole} members={members} invites={canManage ? invites : null} sessions={sessions}
      error={error} busy={busy} lastInvite={lastInvite} nowMs={Date.now()} handlers={handlers} />
  );
}

export default function View() {
  const saas = useSaas();
  if (saas.mode === 'checking') {
    return (
      <div className="page team-page">
        <PageHeader eyebrow="07 · TEAM & ROLES" title="팀 · 권한" sub="서버 연결을 확인하는 중입니다." />
      </div>
    );
  }
  if (saas.mode === 'server') {
    if (!saas.workspace) {
      return (
        <div className="page team-page">
          <PageHeader eyebrow="07 · TEAM & ROLES" title="팀 · 권한" />
          <Callout tone="info" title="워크스페이스가 없습니다">로그인한 뒤 초대받은 워크스페이스가 있어야 구성원을 볼 수 있습니다.</Callout>
        </div>
      );
    }
    return <ServerTeam key={saas.workspace.id} />;
  }
  return <DemoTeam />;
}
