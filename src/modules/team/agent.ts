/**
 * 팀 · 권한 — MILDO Agent 도구 + 오프라인 브리프.
 * 서버 모드에서 화면이 구성원을 불러온 적이 있으면(live.ts) 도구가 서버에서 다시 읽어 실데이터를 돌려주고,
 * 그렇지 않으면(데모 · 화면 미방문) 예시 데이터(TEST DATA)임을 밝혀 돌려준다. 도구는 읽기 전용이다(역할 변경 · 초대는 사람이 화면에서).
 */
import type { AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import { can, permissionsOf, ROLE_LABEL, ROLES } from '@/core/permissions';
import type { ModuleAgentKit, ToolContext } from '../types';
import { fmtKst, summarizeTeam, type Invite, type Member } from './engine';
import { demoInvites, demoMembers } from './demo';
import { getTeamSnapshot } from './live';
import { PERMISSION_LABEL, ROLE_DESC } from './rules';

interface TeamData { source: 'LIVE' | 'TEST DATA'; members: Member[]; invites: Invite[] | null; at: string; note?: string }

/** 동기: 화면이 마지막으로 불러온 값 또는 예시 */
function teamDataSync(nowMs = Date.now()): TeamData {
  const s = getTeamSnapshot();
  if (s?.members) return { source: 'LIVE', members: s.members, invites: s.invites, at: s.at };
  return {
    source: 'TEST DATA', members: demoMembers(nowMs), invites: demoInvites(nowMs), at: new Date(nowMs).toISOString(),
    note: '서버에 연결하지 않았거나 팀 · 권한 화면을 아직 열지 않아 예시 구성원을 보여 줍니다 (실제 계정 아님)',
  };
}

/** 비동기: 서버 모드면 새로 읽는다 (실패하면 마지막 값) */
async function teamData(): Promise<TeamData> {
  const s = getTeamSnapshot();
  if (s?.workspaceId) {
    try {
      const api = await import('./api');
      const members = await api.fetchMembers(s.workspaceId);
      const invites = s.invites ? await api.fetchInvites(s.workspaceId).catch(() => s.invites) : null;
      return { source: 'LIVE', members, invites, at: new Date().toISOString() };
    } catch {
      /* 네트워크 오류 — 마지막 값 */
    }
  }
  return teamDataSync();
}

function membersTool(): AgentTool {
  return {
    name: 'team_members',
    description: '워크스페이스 구성원 목록과 역할 · 계정 상태 · 최근 로그인, 활성 소유자 수, 수락 대기 · 만료 초대, 30일 미접속 계정을 돌려준다. 읽기 전용.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const nowMs = Date.now();
      const d = await teamData();
      const sum = summarizeTeam(d.members, d.invites ?? [], nowMs);
      return {
        출처: d.source,
        기준시각: fmtKst(d.at, nowMs),
        안내: d.note,
        구성원수: sum.members,
        역할별: Object.fromEntries(sum.byRole.map((r) => [r.label, r.count])),
        활성소유자: sum.owners,
        소유자판정: sum.owners >= 2 ? '백업 소유자 있음 (기준 2명 이상)' : sum.owners === 1 ? '단일 소유자 (기준 2명 이상 권장)' : '활성 소유자 없음',
        비활성계정: sum.disabled,
        미접속30일: sum.dormant.map((m) => ({ 이름: m.name, 역할: ROLE_LABEL[m.role], 최근로그인: m.last_login_at ? fmtKst(m.last_login_at, nowMs) : '없음' })),
        초대: d.invites ? { 수락대기: sum.pending, 만료: sum.expired, 메일미발송: sum.mailFailed.map((i) => i.email) } : '팀 관리 권한이 있어야 볼 수 있음',
        구성원: d.members.slice(0, 60).map((m) => ({
          이름: m.name, 이메일: m.email, 역할: ROLE_LABEL[m.role], 직함: m.title ?? undefined, 계정: m.status === 'active' ? '활성' : '비활성',
          최근로그인: m.last_login_at ? fmtKst(m.last_login_at, nowMs) : '없음', 나: m.is_me || undefined,
        })),
      };
    },
  };
}

function matrixTool(): AgentTool {
  return {
    name: 'team_role_matrix',
    description: '역할(owner · admin · pm · ae · client · viewer)별 권한 표와 팀 관리 규칙(소유자 권한 · 마지막 소유자 보호 · 자기 역할 변경 금지)을 돌려준다. 서버 판정과 같은 표.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', enum: [...ROLES], description: '한 역할만 볼 때' } } },
    execute(input) {
      const pick = typeof input.role === 'string' && (ROLES as readonly string[]).includes(input.role) ? [input.role as (typeof ROLES)[number]] : [...ROLES];
      return {
        역할: Object.fromEntries(pick.map((r) => [ROLE_LABEL[r], { 설명: ROLE_DESC[r], 권한: permissionsOf(r).map((p) => PERMISSION_LABEL[p] ?? p), 팀관리: can(r, 'manage_team') }])),
        규칙: [
          '소유자 권한 부여 · 회수(강등 · 제외 · 소유자 계정 비활성화)는 소유자만',
          '자기 역할 · 자기 계정 상태는 직접 바꾸지 않음',
          '활성 소유자가 0명이 되는 변경은 서버가 거부',
          '초대로는 소유자 권한을 줄 수 없음 (가입 후 소유자가 변경)',
          '제외는 이 워크스페이스 멤버십만 삭제, 비활성화는 계정 전체 로그인 차단',
        ],
      };
    },
  };
}

function accessBrief(_ctx: ToolContext): Brief {
  const nowMs = Date.now();
  const d = teamDataSync(nowMs);
  const sum = summarizeTeam(d.members, d.invites ?? [], nowMs);
  const tag = d.source === 'LIVE' ? '서버 실데이터' : 'TEST DATA 예시';
  const facts = [
    `구성원 ${sum.members}명 (활성 ${sum.active} · 비활성 ${sum.disabled}) · ${sum.byRole.map((r) => `${r.label} ${r.count}`).join(' · ')} — ${tag}, 기준 ${fmtKst(d.at, nowMs)}`,
    `활성 소유자 ${sum.owners}명 · 팀 관리 가능(관리자 · 소유자) ${d.members.filter((m) => m.status === 'active' && can(m.role, 'manage_team')).length}명`,
  ];
  if (d.invites) facts.push(`초대 수락 대기 ${sum.pending}건 · 만료 ${sum.expired}건 · 메일 미발송 ${sum.mailFailed.length}건`);
  const patterns: string[] = [];
  if (sum.dormant.length) patterns.push(`30일 넘게 로그인하지 않은 활성 계정 ${sum.dormant.length}개: ${sum.dormant.map((m) => `${m.name}(${ROLE_LABEL[m.role]})`).join(', ')}`);
  if (sum.expired) patterns.push(`만료된 초대 ${sum.expired}건 — 7일 안에 수락되지 않은 초대`);
  const interpretation: string[] = [];
  if (sum.owners === 1) interpretation.push('소유자가 한 명이라 그 사람이 자리를 비우면 소유자 지정 · 광고주(CLIENT) 등급 승인 · 소유자 권한 회수가 멈출 수 있습니다.');
  if (sum.dormant.length) interpretation.push('장기 미접속 계정은 퇴사 · 담당 변경일 가능성이 있어 승인 권한이 남아 있는지 확인할 대상입니다.');
  if (!interpretation.length) interpretation.push('소유자 이중화와 계정 활동 기준에서 즉시 조치가 필요한 항목은 보이지 않습니다.');
  return {
    title: '팀 · 권한 점검',
    facts,
    patterns,
    interpretation,
    conditions: ['활성 소유자 기준 2명 이상', '미접속 기준 최근 로그인 30일 초과', '초대 링크 유효기간 7일 · 1회용'],
    counter: ['미접속이어도 리포트 메일만 받는 열람자 · 광고주 담당자는 정상일 수 있습니다', '소유자가 한 명이어도 관리자가 있으면 일상 운영(초대 · 역할 변경 · 설정)은 멈추지 않습니다'],
    actions: [
      ...(sum.owners < 2 ? ['팀 · 권한 화면에서 신뢰할 수 있는 관리자 한 명을 소유자로 지정'] : []),
      ...(sum.dormant.length ? ['미접속 계정 담당자에게 확인 후 제외하거나 비활성화'] : []),
      ...(sum.expired ? ['만료된 초대는 다시 보내기(새 링크 · 7일 연장) 또는 취소'] : []),
      '변경 내역은 감사 로그에서 member.* · invite.* 작업으로 확인',
    ],
  };
}

export const agentKit: ModuleAgentKit = {
  tools: () => [membersTool(), matrixTool()],
  // '키워드 비활성화' · '멤버십 매출' · '친구 초대 이벤트' 같은 광고 · 판매 질문을 가로채지 않게 팀 맥락이 있는 표현만 잡는다
  briefs: [{
    id: 'team-access',
    match: /팀 ?· ?권한|팀 ?권한|구성원|팀원|팀 ?멤버|멤버 ?(권한|역할|목록)|(구성원|팀원|멤버|담당자|사용자|계정) ?초대|초대 ?(링크|메일|현황|수락|대기|보내|발송|취소|만료)|소유자|역할 변경|권한 표|접속 세션|로그인 세션|미접속|계정 ?비활성화/,
    build: accessBrief,
  }],
};
