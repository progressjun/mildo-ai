/**
 * 데모(아티팩트 · 서버 없음) 모드 예시 — TEST DATA. 실제 구성원 · 계정이 아니다.
 * 서버에 연결하면 같은 화면이 GET /api/w/:ws/members · invites · /api/auth/sessions 실데이터로 바뀐다.
 */
import type { Invite, Member, SessionRow } from './engine';

const H = 3600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

export function demoMembers(nowMs = Date.now()): Member[] {
  const m = (user_id: string, name: string, email: string, role: Member['role'], title: string | null, loginAgoH: number | null, joinedAgoD: number, extra: Partial<Member> = {}): Member => ({
    user_id, name, email, role, title, real_name: true, status: 'active', is_me: false,
    joined_at: iso(nowMs - joinedAgoD * D),
    last_login_at: loginAgoH === null ? null : iso(nowMs - loginAgoH * H),
    last_seen_at: loginAgoH === null ? null : iso(nowMs - Math.max(0.1, loginAgoH - 1) * H),
    active_sessions: loginAgoH === null ? 0 : 1,
    ...extra,
  });
  return [
    m('demo-owner', '운영 책임자 (예시)', 'owner@example.com', 'owner', '대행사 본부장', 26, 120),
    m('demo-admin', '운영 관리자 (예시)', 'admin@example.com', 'admin', '운영 리드', 2, 118, { is_me: true, active_sessions: 2 }),
    m('demo-pm', '김PM (예시)', 'pm@example.com', 'pm', '퍼포먼스 PM', 1, 110),
    m('demo-ae', '이AE (예시)', 'ae@example.com', 'ae', '검색광고 담당', 0.5, 95),
    m('demo-ae2', '박AE (예시)', 'ae2@example.com', 'ae', '주말 당번 백업', 40 * 24, 90),
    m('demo-client', '수면밀도 담당자 (예시)', 'client@example.com', 'client', '브랜드 마케팅', 20, 60),
    m('demo-viewer', '재무 열람 (예시)', 'finance@example.com', 'viewer', null, null, 14, { status: 'disabled', active_sessions: 0 }),
  ];
}

export function demoInvites(nowMs = Date.now()): Invite[] {
  const base = { invited_by_name: '운영 관리자 (예시)', accepted_by_name: null, accepted_at: null, revoked_at: null, revoke_reason: null, mail_error: null, send_count: 1 };
  return [
    { ...base, id: 'demo-inv-1', email: 'new.ae@example.com', role: 'ae', status: 'pending', created_at: iso(nowMs - 5 * H), expires_at: iso(nowMs + 7 * D - 5 * H), mail_sent_at: iso(nowMs - 5 * H) },
    { ...base, id: 'demo-inv-2', email: 'brand.lead@example.com', role: 'client', status: 'pending', created_at: iso(nowMs - 2 * D), expires_at: iso(nowMs + 5 * D), mail_sent_at: null, mail_error: 'SMTP가 설정되지 않았습니다 (SMTP_HOST)' },
    { ...base, id: 'demo-inv-3', email: 'agency.partner@example.com', role: 'viewer', status: 'expired', created_at: iso(nowMs - 9 * D), expires_at: iso(nowMs - 2 * D), mail_sent_at: iso(nowMs - 9 * D) },
    { ...base, id: 'demo-inv-4', email: 'ae@example.com', role: 'ae', status: 'accepted', created_at: iso(nowMs - 96 * D), expires_at: iso(nowMs - 89 * D), mail_sent_at: iso(nowMs - 96 * D), accepted_at: iso(nowMs - 95 * D), accepted_by_name: '이AE (예시)' },
  ];
}

export function demoSessions(nowMs = Date.now()): SessionRow[] {
  return [
    { id: 'demo0000000000000000000a', current: true, created_at: iso(nowMs - 2 * H), last_seen_at: iso(nowMs - 60_000), expires_at: iso(nowMs + 14 * D), ip: '203.0.113.10',
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
    { id: 'demo0000000000000000000b', current: false, created_at: iso(nowMs - 3 * D), last_seen_at: iso(nowMs - 20 * H), expires_at: iso(nowMs + 11 * D), ip: '198.51.100.24',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  ];
}
