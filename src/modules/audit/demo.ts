/**
 * 데모(아티팩트 · 서버 없음) 모드 예시 감사 기록 — TEST DATA. 실제 작업 기록이 아니다.
 * 서버에 연결하면 같은 화면이 GET /api/w/:ws/audit 실데이터로 바뀐다.
 */
import type { AuditEntry } from './engine';

const H = 3600_000;
const USERS = {
  owner: { id: 'demo-owner', name: '운영 책임자 (예시)', email: 'owner@example.com' },
  admin: { id: 'demo-admin', name: '운영 관리자 (예시)', email: 'admin@example.com' },
  pm: { id: 'demo-pm', name: '김PM (예시)', email: 'pm@example.com' },
  ae: { id: 'demo-ae', name: '이AE (예시)', email: 'ae@example.com' },
  client: { id: 'demo-client', name: '수면밀도 담당자 (예시)', email: 'client@example.com' },
} as const;
type Who = keyof typeof USERS | 'system';

export function demoAuditEntries(nowMs = Date.now()): AuditEntry[] {
  let id = 5000;
  const e = (hoursAgo: number, who: Who, action: string, extra: Partial<AuditEntry> = {}): AuditEntry => {
    const u = who === 'system' ? null : USERS[who];
    return {
      id: id--, at: new Date(nowMs - hoursAgo * H).toISOString(), actor: u?.name ?? 'system', user_id: u?.id ?? null, user_email: u?.email ?? null,
      action, target_type: null, target_id: null, detail: {}, ip: u ? '203.0.113.10' : null, ...extra,
    };
  };
  return [
    e(0.2, 'ae', 'change.create', { target_type: 'change', target_id: 'chg_demo_101', detail: { kind: 'bid', target: '퀸 매트리스', before: 820, after: 900, changePct: 9.8 } }),
    e(0.5, 'pm', 'change.approve', { target_type: 'change', target_id: 'chg_demo_100', detail: { approver: 'PM', note: '전환 3건 이상 확인' } }),
    e(0.6, 'system', 'change.apply', { target_type: 'change', target_id: 'chg_demo_100', detail: { mode: 'dry_run', provider: 'naver_sa', ok: true } }),
    e(1.1, 'admin', 'connection.write_mode', { target_type: 'connection', target_id: 'conn_demo_sa', detail: { from: 'dry_run', to: 'live', label: '네이버 검색광고', credentials: '••••' } }),
    e(2, 'admin', 'invite.create', { target_type: 'invite', target_id: 'demo-inv-1', detail: { email: 'new.ae@example.com', role: 'ae', superseded: 0 } }),
    e(3, 'owner', 'member.role_change', { target_type: 'user', target_id: 'demo-ae2', detail: { email: 'ae2@example.com', from: 'viewer', to: 'ae' } }),
    e(4, 'pm', 'auth.login', { account: true }),
    e(5.5, 'system', 'auth.login_failed', { actor: 'pm@example.com', user_id: 'demo-pm', user_email: 'pm@example.com', ip: '198.51.100.77', account: true }),
    e(6, 'pm', 'config.update', { target_type: 'config', detail: { changed: ['safety.dailyChangeCap'], from: 20, to: 15 } }),
    e(8, 'system', 'report.deliver', { target_type: 'report', target_id: 'rep_demo_daily', detail: { type: 'daily', channel: 'slack', status: 'sent' } }),
    e(9, 'ae', 'incident.update', { target_type: 'incident', target_id: 'inc_demo_7', detail: { status: 'ack', severity: 'P1' } }),
    e(20, 'client', 'change.approve', { target_type: 'change', target_id: 'chg_demo_95', detail: { approver: 'CLIENT', note: '프로모션 예산 증액 승인' } }),
    e(22, 'admin', 'member.disable', { target_type: 'user', target_id: 'demo-viewer', detail: { email: 'finance@example.com', role: 'viewer', revokedSessions: 1 } }),
    e(26, 'owner', 'audit.export', { detail: { filters: { action: 'change.' }, rows: 214, truncated: false } }),
    e(30, 'pm', 'change.rollback', { target_type: 'change', target_id: 'chg_demo_90', detail: { reason: 'CPA 기준 초과 2시간 지속' } }),
    e(31, 'ae', 'auth.password_change', { account: true, detail: { revokedSessions: 1 } }),
    e(48, 'admin', 'invite.accept', { actor: '이AE (예시)', user_id: 'demo-ae', user_email: 'ae@example.com', target_type: 'invite', target_id: 'demo-inv-4', detail: { email: 'ae@example.com', role: 'ae', newUser: true } }),
    e(72, 'pm', 'connection.create', { target_type: 'connection', target_id: 'conn_demo_cafe24', detail: { provider: 'cafe24', label: '자사몰 (카페24)', credentials: '••••' } }),
  ];
}
