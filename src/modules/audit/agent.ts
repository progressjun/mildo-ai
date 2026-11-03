/**
 * 감사 로그 — MILDO Agent 도구 + 오프라인 브리프.
 * 서버 모드에서 감사 로그 화면을 연 적이 있으면(live.ts) 도구가 서버에서 조건에 맞게 다시 읽고(권한 configure 필요),
 * 그렇지 않으면 예시 기록(TEST DATA)임을 밝혀 돌려준다. 읽기 전용.
 */
import type { AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import type { ModuleAgentKit, ToolContext } from '../types';
import { actionLabel, detailSummary, filterEntries, isSensitive, kstStamp, summarizeAudit, type AuditEntry, type AuditFilters } from './engine';
import { demoAuditEntries } from './demo';
import { getAuditSnapshot } from './live';

interface AuditData { source: 'LIVE' | 'TEST DATA'; entries: AuditEntry[]; at: string; note?: string }

function auditDataSync(f: AuditFilters = {}, nowMs = Date.now()): AuditData {
  const s = getAuditSnapshot();
  if (s) return { source: 'LIVE', entries: filterEntries(s.entries, { ...f, auth: true }), at: s.at, note: '감사 로그 화면이 마지막으로 불러온 범위 안에서 집계' };
  return {
    source: 'TEST DATA', entries: filterEntries(demoAuditEntries(nowMs), { ...f, auth: true }), at: new Date(nowMs).toISOString(),
    note: '서버에 연결하지 않았거나 감사 로그 화면을 아직 열지 않아 예시 기록을 보여 줍니다 (실제 작업 기록 아님)',
  };
}

async function auditData(f: AuditFilters, limit: number): Promise<AuditData> {
  const s = getAuditSnapshot();
  if (s?.workspaceId) {
    try {
      const api = await import('./api');
      const page = await api.fetchAudit(s.workspaceId, { ...f, auth: true }, null, Math.min(200, limit));
      return { source: 'LIVE', entries: page.entries, at: new Date().toISOString() };
    } catch {
      /* 권한 · 네트워크 오류 — 마지막 값 */
    }
  }
  return auditDataSync(f);
}

function recentTool(): AgentTool {
  return {
    name: 'audit_recent',
    description: '최근 감사 로그(누가 · 언제 · 무엇을 바꿨는지)를 최신순으로 돌려준다. action은 작업 코드 접두어(예: change. · member.role · invite.), limit은 최대 200. 보안 확인 대상 · 로그인 실패 집계 포함. 읽기 전용.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: "작업 코드 접두어 (예: 'change.', 'member.', 'auth.login_failed')" },
        limit: { type: 'number', description: '돌려줄 기록 수 (기본 30, 최대 200)' },
      },
    },
    async execute(input) {
      const action = typeof input.action === 'string' ? input.action.replace(/[^A-Za-z0-9_.]/g, '').slice(0, 80) : undefined;
      const limit = Math.max(1, Math.min(200, Math.floor(Number(input.limit) || 30)));
      const d = await auditData({ action: action || undefined }, limit);
      const entries = d.entries.slice(0, limit);
      const sum = summarizeAudit(entries);
      return {
        출처: d.source,
        기준시각: kstStamp(d.at),
        안내: d.note,
        건수: entries.length,
        영역별: Object.fromEntries(sum.byDomain.map((x) => [x.label, x.count])),
        행위자별: Object.fromEntries(sum.actors.slice(0, 10).map((x) => [x.actor, x.count])),
        보안확인대상: sum.sensitive.length,
        로그인실패: sum.failedLogins,
        기록: entries.map((e) => ({
          id: e.id, 시각: kstStamp(e.at), 행위자: e.actor, 작업: actionLabel(e.action), 코드: e.action,
          대상: e.target_type ? `${e.target_type}:${e.target_id ?? ''}` : undefined, 요약: detailSummary(e) || undefined, 보안: isSensitive(e.action) || undefined,
        })),
      };
    },
  };
}

function reviewBrief(_ctx: ToolContext): Brief {
  const d = auditDataSync();
  const sum = summarizeAudit(d.entries);
  const tag = d.source === 'LIVE' ? '서버 실데이터' : 'TEST DATA 예시';
  const facts = [
    `기록 ${sum.total}건 (${sum.first ? `${kstStamp(sum.first).slice(0, 16)} ~ ${kstStamp(sum.last).slice(0, 16)} KST` : '기간 없음'}) — ${tag}`,
    `영역별: ${sum.byDomain.map((x) => `${x.label} ${x.count}`).join(' · ') || '없음'}`,
  ];
  const patterns: string[] = [];
  if (sum.failedLogins) patterns.push(`로그인 실패 ${sum.failedLogins}건 — 같은 이메일 · IP에서 반복되면 비밀번호 추측 시도일 수 있음`);
  const live = sum.sensitive.filter((e) => /^connection\.write_mode/.test(e.action));
  if (live.length) patterns.push(`실반영(live) 전환 · 쓰기 모드 변경 ${live.length}건: ${live.map((e) => `${e.actor} ${kstStamp(e.at).slice(5, 16)}`).join(', ')}`);
  const roles = sum.sensitive.filter((e) => /^member\./.test(e.action));
  if (roles.length) patterns.push(`역할 · 계정 변경 ${roles.length}건: ${roles.map((e) => `${actionLabel(e.action)}(${e.actor})`).join(', ')}`);
  const interpretation = sum.sensitive.length
    ? [`보안 확인 대상 ${sum.sensitive.length}건은 권한 · 매체 반영 · 계정에 영향을 주는 작업이라 주간 점검에서 요청자와 승인자가 맞는지 대조할 대상입니다.`]
    : ['권한 · 매체 반영 · 계정에 영향을 주는 작업은 이 범위에 없습니다.'];
  return {
    title: '감사 로그 점검',
    facts,
    patterns,
    interpretation,
    conditions: ['보안 확인 대상 기준: 로그인 실패 · 비밀번호 · 역할 변경 · 비활성화 · 제외 · 초대 · 실반영 전환 · 커넥션 삭제 · 반영 · 롤백 · 감사 로그 내보내기', '시각은 KST'],
    counter: ['예약 작업(system) 기록은 사람이 한 일이 아니라 수집 · 리포트 · 감지 자동화입니다', '로그인 실패는 비밀번호 오타일 수 있어 한 번만으로는 이상으로 보지 않습니다'],
    actions: ['감사 로그 화면에서 작업 접두어 member. · connection. · change.apply로 걸러 요청자와 승인자를 확인', '월말에는 CSV로 내려받아 보관 (내려받기도 기록됨)'],
  };
}

export const agentKit: ModuleAgentKit = {
  tools: () => [recentTool()],
  briefs: [{ id: 'audit-review', match: /감사 ?로그|감사 ?기록|audit|누가 .{0,12}(바꿨|변경했)|변경 내역|로그인 실패|보안 기록/i, build: reviewBrief }],
};
