/** 감사 로그 순수 함수 — 작업 설명 · 쿼리 문자열 · 날짜 검사 · KST 표기 · CSV(BOM · 수식 주입 방지) · 로컬 필터 · 요약 */
import { describe, expect, it } from 'vitest';
import {
  actionLabel, actionSuggestions, auditCsv, buildAuditQuery, csvCell, detailSummary, filterEntries, filterProblem, isSensitive, kstStamp, prettyDetail, summarizeAudit,
  type AuditEntry,
} from './engine';
import { demoAuditEntries } from './demo';

const E = (o: Partial<AuditEntry>): AuditEntry => ({
  id: 1, at: '2026-11-01T00:00:00Z', actor: 'a', user_id: null, user_email: null, action: 'x.y', target_type: null, target_id: null, detail: {}, ip: null, ...o,
});

describe('표기', () => {
  it('actionLabel: 아는 코드 · 도메인만 아는 코드 · 모르는 코드', () => {
    expect(actionLabel('invite.create')).toBe('초대 발송');
    expect(actionLabel('change.something_new')).toBe('변경 요청 · change.something_new');
    expect(actionLabel('zzz.q')).toBe('zzz.q');
    // 다른 도메인 서버가 실제로 남기는 코드 형식(점 구분)과 맞는다
    expect(actionLabel('notify.channel.create')).toBe('알림 채널 추가');
    expect(actionLabel('change.apply_held')).toBe('반영 보류 (검증 · 가드)');
    expect(actionLabel('auth.login_locked')).toBe('로그인 잠금 (실패 반복)');
    expect(isSensitive('auth.login_locked')).toBe(true);
    expect(isSensitive('auth.login_failed')).toBe(true);
    expect(isSensitive('report.generate')).toBe(false);
  });
  it('kstStamp · prettyDetail · detailSummary', () => {
    expect(kstStamp('2026-10-31T15:00:00Z')).toBe('2026-11-01 00:00:00');
    expect(kstStamp(null)).toBe('');
    expect(prettyDetail({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyDetail({ s: 'x'.repeat(50) }, 20)).toContain('생략');
    expect(detailSummary(E({ action: 'member.role_change', detail: { email: 'a@b.c', from: 'ae', to: 'pm' } }))).toBe('a@b.c ae → pm');
    expect(detailSummary(E({ detail: { role: 'ae', other: 1 } }))).toBe('role=ae');
  });
  it('actionSuggestions: 도메인 접두어 + 코드', () => {
    const s = actionSuggestions(['custom.thing']);
    expect(s.find((x) => x.value === 'invite.')?.label).toBe('초대 전체');
    expect(s.some((x) => x.value === 'custom.thing')).toBe(true);
  });
});

describe('쿼리 · 검사', () => {
  it('buildAuditQuery: 빈 값 제외 · 커서 · 계정 기록', () => {
    expect(buildAuditQuery({})).toBe('');
    expect(buildAuditQuery({ action: ' invite. ', userId: 'u1', from: '2026-11-01', to: 'bad', auth: true }, { before: 55, limit: 100 }))
      .toBe('?action=invite.&userId=u1&from=2026-11-01&auth=1&before=55&limit=100');
  });
  it('filterProblem', () => {
    expect(filterProblem({ from: '2026-11-02', to: '2026-11-01' })).toContain('늦습니다');
    expect(filterProblem({ from: '2026/11/01' })).toContain('형식');
    expect(filterProblem({ from: '2026-11-01', to: '2026-11-01' })).toBeNull();
  });
});

describe('CSV', () => {
  it('BOM · 머리글 · 수식 주입 방지 · 따옴표', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell({ k: 1 })).toBe('"{""k"":1}"');
    const csv = auditCsv([E({ id: 7, actor: '@evil', action: 'invite.create', detail: { email: 'x@y.z' } })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0].split(',')[0]).toBe('ID');
    expect(lines[1]).toContain("'@evil");
    expect(lines[1]).toContain('초대 발송');
    expect(lines[1]).toContain('2026-11-01 09:00:00');
  });
});

describe('로컬 필터 (데모 · 에이전트)', () => {
  const entries = [
    E({ id: 3, action: 'invite.create', user_id: 'u1', at: '2026-10-31T14:59:00Z' }), // KST 10-31 23:59
    E({ id: 2, action: 'invite.revoke', user_id: 'u2', at: '2026-10-31T15:00:00Z' }), // KST 11-01 00:00
    E({ id: 1, action: 'auth.login', user_id: 'u1', at: '2026-11-01T03:00:00Z', account: true }),
  ];
  it('접두어 · 사용자 · KST 날짜 경계 · 계정 기록', () => {
    expect(filterEntries(entries, { action: 'invite.' }).map((e) => e.id)).toEqual([3, 2]);
    expect(filterEntries(entries, { userId: 'u1' }).map((e) => e.id)).toEqual([3]);
    expect(filterEntries(entries, { userId: 'u1', auth: true }).map((e) => e.id)).toEqual([3, 1]);
    expect(filterEntries(entries, { from: '2026-11-01', to: '2026-11-01' }).map((e) => e.id)).toEqual([2]);
    expect(filterEntries(entries, { to: '2026-10-31' }).map((e) => e.id)).toEqual([3]);
  });
  it('summarizeAudit (예시 기록)', () => {
    const s = summarizeAudit(demoAuditEntries(Date.parse('2026-11-02T03:00:00Z')));
    expect(s.total).toBe(18);
    expect(s.failedLogins).toBe(1);
    expect(s.byDomain[0].domain).toBe('change');
    expect(s.sensitive.some((e) => e.action === 'connection.write_mode')).toBe(true);
    expect(s.first! < s.last!).toBe(true);
  });
});
