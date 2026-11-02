/**
 * MILDO OS 모듈 레지스트리 — 사이드바 · 라우팅 · 에이전트 도구가 이 목록을 공유한다.
 * 구성은 제안서 p.22 MILDO OS(Board · Watch · Lab · Alert · Flow) + AI 엔진 5종(p.9) + RFP 요청 항목.
 */
import { lazy } from 'react';
import type { ModuleDef } from './types';
import { agentKit as homeKit } from './home/agent';
import { agentKit as agentKit } from './agent/agent';
import { agentKit as boardKit } from './board/agent';
import { agentKit as adpilotKit } from './adpilot/agent';
import { agentKit as reportsKit } from './reports/agent';
import { agentKit as watchKit } from './watch/agent';
import { agentKit as labKit } from './lab/agent';
import { agentKit as geoKit } from './geo/agent';
import { agentKit as growthKit } from './growth/agent';
import { agentKit as flowKit } from './flow/agent';
import { agentKit as alertKit } from './alert/agent';
import { agentKit as opsKit } from './ops/agent';
import { agentKit as connectionsKit } from './connections/agent';
import { agentKit as teamKit } from './team/agent';
import { agentKit as auditKit } from './audit/agent';
import { agentKit as notifyKit } from './notify/agent';
import { agentKit as impactKit } from './impact/agent';
import { agentKit as workspaceKit } from './workspace/agent';

export const GROUP_LABEL: Record<ModuleDef['group'], string> = {
  overview: '개요',
  automation: '02 리소스 절감 · 자동화',
  monitoring: '03 모니터링 · 테스트',
  growth: '04 매출 성장 고도화',
  stability: '05 운영 안정성',
  team: '06 TF · 온보딩 · 계약',
  admin: '07 관리 · 연동',
};

export const MODULES: ModuleDef[] = [
  { id: 'home', title: '커맨드 센터', eng: 'COMMAND CENTER', group: 'overview', summary: '오늘의 운영 현황 · 승인 대기 · 이슈 · 작동 시나리오', sources: '제안서 p.3–5, p.22–23', Component: lazy(() => import('./home/View')), agent: homeKit },
  { id: 'agent', title: 'MILDO Agent', eng: 'AI AGENT', group: 'overview', summary: '전 모듈 데이터를 읽고 판단 근거를 정리하는 AI 에이전트', sources: '신규 기능', Component: lazy(() => import('./agent/View')), agent: agentKit },
  { id: 'board', title: 'MILDO Board', eng: '02 · PRO-BOARD', group: 'automation', summary: '매체 통합 성과 · 판매 채널 실매출 · 키워드 필터 · 예산 소진', sources: '제안서 p.12–13', Component: lazy(() => import('./board/View')), agent: boardKit },
  { id: 'adpilot', title: 'AD Pilot · GFA Control', eng: '02 · BID & BUDGET', group: 'automation', summary: 'SA 입찰 · 예산 조정 후보 → 승인 · 기록 · 롤백, GFA 변경 승인 라우팅', sources: '제안서 p.14–16', Component: lazy(() => import('./adpilot/View')), agent: adpilotKit },
  { id: 'reports', title: '리포트 · 데이터 시간표', eng: '02 · REPORTING', group: 'automation', summary: '일 · 주 · 월 · 이슈 리포트 자동 생성, 업무시간 맞춤 데이터 시간표, 절감 실측', sources: '제안서 p.17–20', Component: lazy(() => import('./reports/View')), agent: reportsKit },
  { id: 'watch', title: 'MILDO Watch', eng: '03 · WATCH & ARCHIVE', group: 'monitoring', summary: '매체 변동 선제 트래킹 · 오가닉/페이드 통합 아카이빙 · 경쟁 6개사', sources: '제안서 p.24–25', Component: lazy(() => import('./watch/View')), agent: watchKit },
  { id: 'lab', title: 'MILDO Lab', eng: '03 · TEST LAB', group: 'monitoring', summary: '롱테일 · 구문형 키워드 발굴 → 테스트 → 판정, VisualTune 소재 테스트, 검수', sources: '제안서 p.26–28, p.36', Component: lazy(() => import('./lab/View')), agent: labKit },
  { id: 'geo', title: 'SearchTuneOS · GEO', eng: '03 · GEO & AI SEARCH', group: 'monitoring', summary: 'AI 검색 브랜드 언급 · 인용 진단, 제품페이지 SEO · 구조화 데이터, AEO', sources: '제안서 p.29', Component: lazy(() => import('./geo/View')), agent: geoKit },
  { id: 'growth', title: '매출 성장', eng: '04 · REVENUE GROWTH', group: 'growth', summary: '타겟 그룹 · SA 캠페인 구조 · 예산 재배분 · DA→SA 기여 · 전환 개선 · 신규 매체', sources: '제안서 p.30–42', Component: lazy(() => import('./growth/View')), agent: growthKit },
  { id: 'flow', title: 'MILDO Flow', eng: '04 · COLLABORATION', group: 'growth', summary: '요청 · 승인 · 반영 이력, 프로모션 체크리스트 · 자동 점검 · 리포트', sources: '제안서 p.31, p.53', Component: lazy(() => import('./flow/View')), agent: flowKit },
  { id: 'alert', title: 'MILDO Alert', eng: '05 · ALERT & SLA', group: 'stability', summary: '24시간 이상 감지 · 등급별 SLA · 주말 당번 · 계정 · 결제 점검 · 조치 보고', sources: '제안서 p.43–50', Component: lazy(() => import('./alert/View')), agent: alertKit },
  { id: 'ops', title: '전담 TF · 온보딩 · 계약', eng: '06 · TF & ONBOARDING', group: 'team', summary: '7인 TF · 1:1 백업 · 90일 온보딩 · 수수료 · RFP 커버리지', sources: '제안서 p.51–59', Component: lazy(() => import('./ops/View')), agent: opsKit },
  { id: 'impact', title: '성과 증명', eng: '07 · VALUE LEDGER', group: 'admin', summary: '반영한 변경 · 막은 사고 · 줄인 시간을 측정해 구독료 대비 회수를 보여 준다', sources: 'MILDO OS Cloud', Component: lazy(() => import('./impact/View')), agent: impactKit },
  { id: 'connections', title: '데이터 연결', eng: '07 · DATA SOURCES', group: 'admin', summary: '매체 · 판매 채널 API 연결, CSV 업로드, 수집 일정 · 품질 검사', sources: 'MILDO OS Cloud', Component: lazy(() => import('./connections/View')), agent: connectionsKit },
  { id: 'notify', title: '알림 설정', eng: '07 · NOTIFICATIONS', group: 'admin', summary: 'Slack · 이메일 · 웹훅 채널, 등급별 발송, 당번 · 에스컬레이션', sources: 'MILDO OS Cloud', Component: lazy(() => import('./notify/View')), agent: notifyKit },
  { id: 'team', title: '팀 · 권한', eng: '07 · TEAM & ROLES', group: 'admin', summary: '구성원 초대 · 역할 · 접속 세션 관리', sources: 'MILDO OS Cloud', Component: lazy(() => import('./team/View')), agent: teamKit },
  { id: 'audit', title: '감사 로그', eng: '07 · AUDIT LOG', group: 'admin', summary: '누가 · 언제 · 무엇을 바꿨는지 전체 기록', sources: 'MILDO OS Cloud', Component: lazy(() => import('./audit/View')), agent: auditKit },
  { id: 'workspace', title: '워크스페이스 설정', eng: '07 · WORKSPACE', group: 'admin', summary: '브랜드 · 예산 · 목표 · SAFETY · 위임 범위 · 사용 모듈', sources: 'MILDO OS Cloud', Component: lazy(() => import('./workspace/View')), agent: workspaceKit },
];

export const MODULE_BY_ID: Record<string, ModuleDef> = Object.fromEntries(MODULES.map((m) => [m.id, m]));

/** 엔진 · 도구 · 브리프가 아직 없는 모듈(구현 중) — 메뉴에 "준비 중"으로 표시 */
export function isStubModule(m: ModuleDef): boolean {
  if (!m.agent) return false;
  const noBriefs = !(m.agent.briefs?.length);
  try {
    return noBriefs && m.agent.tools(null as never).length === 0;
  } catch {
    return false;
  }
}
