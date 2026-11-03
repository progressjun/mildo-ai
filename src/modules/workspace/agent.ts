/**
 * 워크스페이스 설정 — MILDO Agent 도구 + 오프라인 브리프.
 * 값의 출처: 서버 모드(플랫폼이 연결한 워크스페이스 = serverAiWorkspace())면 그 워크스페이스 설정을 서버에서 읽고, 화면이 불러온 스냅샷(live.ts)은
 * 같은 워크스페이스일 때만 쓴다(워크스페이스를 바꾼 뒤 이전 워크스페이스 값을 보고하지 않도록). 서버가 없으면 지금 적용된 설정
 * (activeWorkspaceConfig — 데모 모드에서는 기본값)을 쓴다. 도구는 읽기 전용이다(저장은 사람이 화면에서).
 */
import { fetchServerAiUsage, serverAiWorkspace, type AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import {
  activeWorkspaceConfig, ANOMALY_LABEL, ANOMALY_METRICS, DEFAULT_CONFIG, delegationRanges, diffConfig, formatConfigValue, configFieldLabel, MEDIA_ID_LIST,
  MEDIA_LABEL, minutesLabel, SEVERITY_LIST, TF_LABEL, TIMETABLE_KEYS, TIMETABLE_LABEL, type EffectiveConfig,
} from '@/data/config';
import type { ModuleAgentKit, ToolContext } from '../types';
import { getWorkspaceSnapshot } from './live';
import { aiUsageView, demoOnboarding, fmtKst, historyChangeText, HISTORY_ACTION_LABEL, impactBasis, pctText, type HistoryEntry, type OnboardingState } from './model';

interface ConfigData {
  source: 'LIVE' | '적용된 설정' | '기본값';
  effective: EffectiveConfig;
  version: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  note?: string;
}

/** 지금 워크스페이스의 스냅샷만 (플랫폼이 다른 워크스페이스로 바꿨으면 null) */
function currentSnapshot() {
  const s = getWorkspaceSnapshot();
  const cur = serverAiWorkspace();
  return s && (!cur || s.workspaceId === cur) ? s : null;
}
/** 서버에서 다시 읽을 워크스페이스 id — 플랫폼이 연결한 워크스페이스가 우선 */
const liveWorkspaceId = (): string | null => serverAiWorkspace() || getWorkspaceSnapshot()?.workspaceId || null;

function configDataSync(): ConfigData {
  const s = currentSnapshot();
  if (s?.state) return { source: 'LIVE', effective: s.state.effective, version: s.state.version, updatedAt: s.state.updatedAt, updatedBy: s.state.updatedBy?.name ?? null };
  const active = activeWorkspaceConfig();
  if (active !== DEFAULT_CONFIG) return { source: '적용된 설정', effective: active, version: null, updatedAt: null, updatedBy: null, note: '워크스페이스 설정 화면을 열면 버전 · 변경자까지 확인합니다' };
  return {
    source: '기본값', effective: DEFAULT_CONFIG, version: null, updatedAt: null, updatedBy: null,
    note: '서버에 연결하지 않았거나 바꾼 설정이 없어 기본값(제안서 v3 · RFP 기준)을 보여 줍니다',
  };
}

async function configData(): Promise<ConfigData> {
  const id = liveWorkspaceId();
  if (id) {
    try {
      const api = await import('./api');
      const st = await api.fetchConfig(id);
      return { source: 'LIVE', effective: st.effective, version: st.version, updatedAt: st.updatedAt, updatedBy: st.updatedBy?.name ?? null };
    } catch {
      /* 네트워크 오류 — 마지막 값 */
    }
  }
  return configDataSync();
}

const SECTIONS = ['all', 'brand', 'budget', 'targets', 'safety', 'delegation', 'timetable', 'sla', 'detect', 'modules', 'ai', 'impact'] as const;
type Section = (typeof SECTIONS)[number];

/** 전체 설정 → 도구 응답 (한국어 키, 기준 · 근거 포함) */
export function summarize(e: EffectiveConfig, section: Section = 'all'): Record<string, unknown> {
  const pick = (s: Section) => section === 'all' || section === s;
  const out: Record<string, unknown> = {};
  if (pick('brand')) out.브랜드 = { 이름: e.brand.name, 제품군: e.brand.productLine, 경쟁사: e.brand.competitors, 추가브랜드키워드: e.brandKeywords, SKU진입점: e.sku };
  if (pick('budget')) {
    out.예산 = {
      연예산원: e.budget.annual,
      매체배분: Object.fromEntries(MEDIA_ID_LIST.map((id) => [MEDIA_LABEL[id], { 비중pct: Math.round(e.budget.allocation[id] * 1000) / 10, 연예산원: Math.round(e.budget.annual * e.budget.allocation[id]) }])),
      기준: '매체 연 예산 = 연 예산 × 비중 (계산값 · 실제 집행은 매체 계정 일 예산 기준)',
    };
  }
  if (pick('targets')) out.목표 = { 목표ROASpct: e.targets.roas, 브랜드목표ROASpct: e.targets.brandRoas, 고효율기준: `목표 × ${e.targets.highEfficiencyRatio} = ${Math.round(e.targets.roas * e.targets.highEfficiencyRatio)}% 이상`, 목표CPA원: e.targets.cpa ?? '없음 (ROAS로 판정)' };
  if (pick('safety')) out.SAFETY = { 일조정폭상한pct: e.safety.dailyChangeCapPct, 하향전최소전환: e.safety.minConversionsForDown, 노출손실기준pct: Math.round(e.safety.lostShareTrigger * 100), 급변보류pct: e.safety.anomalyHoldPct, 대량변경경고건: e.safety.bulkWarnCount, 대량변경차단건: e.safety.bulkBlockCount };
  if (pick('delegation')) {
    const r = delegationRanges(e.delegation.aeMaxPct, e.delegation.pmMaxPct);
    out.위임범위 = [`${r[0]} → 담당 AE`, `${r[1]} → PM`, `${r[2]} → 광고주 승인`];
  }
  if (pick('timetable')) out.데이터시간표 = Object.fromEntries(TIMETABLE_KEYS.map((k) => [TIMETABLE_LABEL[k], e.timetable[k]]));
  if (pick('sla')) out.SLA = Object.fromEntries(SEVERITY_LIST.map((s) => [s, { 인지: minutesLabel(e.sla[s].ackMin), 일차조치: e.sla[s].actionMin === null ? '협의' : minutesLabel(e.sla[s].actionMin!), 결과보고: e.sla[s].reportMin === null ? '기본 문구(당일 · 주간)' : minutesLabel(e.sla[s].reportMin!) }]));
  if (pick('detect')) {
    out.이상징후기준 = Object.fromEntries(ANOMALY_METRICS.map((m) => [ANOMALY_LABEL[m], `주의 ${e.anomalyThresholds[m].warnPct}% · 위험 ${e.anomalyThresholds[m].dangerPct}%`]));
    out.공휴일 = { 추가: e.holidays.extra, 제외: e.holidays.exclude };
    out.당번순번 = e.onDuty.pool.map((r) => TF_LABEL[r] ?? r);
    out.당번체계강제 = e.offHoursMode ? '켜짐 — 평일에도 당번 순번 배정 · 전 등급 인지 30분' : '꺼짐 — 주말 · 공휴일에만 당번 체계';
  }
  if (pick('modules')) out.사용모듈 = e.modules ?? '모든 모듈';
  if (pick('ai')) out.AI = { 사용: e.ai.enabled, 월한도토큰: e.ai.monthlyTokenLimit };
  if (pick('impact')) {
    const b = impactBasis(e);
    out.성과증명입력 = {
      월구독료원: e.billing.monthlyFee, 공헌이익률pct: Math.round(e.impact.contributionMargin * 100), 시간당인건비원: e.impact.hourlyCost,
      일배회수필요증분매출원: Number.isFinite(b.breakEvenRevenue) ? b.breakEvenRevenue : null, 일배회수필요절감시간: b.breakEvenHours,
      기준: '회수 배수 추정용 가정값 (광고주 확인 필요) · 1배 조건은 계산값',
    };
  }
  return out;
}

function configTool(): AgentTool {
  return {
    name: 'workspace_config',
    description: '워크스페이스 설정(전체 값 = 기본값 + 워크스페이스에서 바꾼 항목)을 돌려준다: 브랜드 · 경쟁사 · 예산 배분 · 목표 ROAS/CPA · SAFETY · 위임 범위 · 데이터 시간표 · SLA · 이상 징후 기준 · 공휴일 · 당번 · 사용 모듈 · AI 한도. 바꾼 항목은 기본값과 함께 표시. 읽기 전용.',
    inputSchema: { type: 'object', properties: { section: { type: 'string', enum: [...SECTIONS], description: '한 섹션만 볼 때 (기본 all)' } } },
    async execute(input) {
      const section = (typeof input.section === 'string' && (SECTIONS as readonly string[]).includes(input.section) ? input.section : 'all') as Section;
      const d = await configData();
      const changed = diffConfig(DEFAULT_CONFIG, d.effective);
      return {
        출처: d.source === 'LIVE' ? 'LIVE 서버 설정' : d.source === '적용된 설정' ? '서버 워크스페이스 설정 (적용됨)' : '기본값 (제안서 v3 · RFP · constants.ts)',
        버전: d.version ?? undefined,
        마지막변경: d.updatedAt ? `${fmtKst(d.updatedAt)} ${d.updatedBy ?? ''}`.trim() : undefined,
        안내: d.note,
        바꾼항목수: changed.length,
        바꾼항목: changed.slice(0, 40).map((c) => ({ 항목: configFieldLabel(c.path), 기본값: formatConfigValue(c.path, c.before), 현재: formatConfigValue(c.path, c.after) })),
        설정: summarize(d.effective, section),
      };
    },
  };
}

function historyTool(): AgentTool {
  return {
    name: 'workspace_config_history',
    description: '워크스페이스 설정 변경 이력(누가 · 언제 · 어떤 항목을 이전 값 → 새 값으로)을 최근 순으로 돌려준다. 서버 모드에서만 실제 기록이 있다. 읽기 전용.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '최대 건수 (기본 10, 최대 30)' } } },
    async execute(input) {
      const limit = Math.min(30, Math.max(1, Number(input.limit) || 10));
      let entries: HistoryEntry[] | null = currentSnapshot()?.history ?? null;
      const id = liveWorkspaceId();
      if (id) {
        try {
          const api = await import('./api');
          entries = (await api.fetchHistory(id)).entries;
        } catch { /* 마지막 값 */ }
      }
      if (!entries) return { 출처: '없음', 안내: '서버에 연결해 워크스페이스 설정 화면을 열면 변경 이력을 읽을 수 있습니다 (시연 모드에는 실제 기록이 없습니다)', 이력: [] };
      return {
        출처: 'LIVE 서버 감사 기록',
        이력: entries.slice(0, limit).map((h) => ({ 시각: fmtKst(h.at), 누가: h.actor, 종류: HISTORY_ACTION_LABEL[h.action] ?? h.action, 메모: h.note, 변경: h.changes.slice(0, 12).map(historyChangeText) })),
      };
    },
  };
}

function aiUsageTool(): AgentTool {
  return {
    name: 'workspace_ai_usage',
    description: '이번 달(또는 month=YYYY-MM) 워크스페이스 서버 AI 사용량을 돌려준다: 입력 · 출력 토큰, 월 한도 대비 사용률, 남은 토큰, 호출 · 오류 수, 용도별 · 최근 7일. 서버 모드에서만 실제 기록이 있다. 읽기 전용.',
    inputSchema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM (기본 이번 달, KST)' } } },
    async execute(input) {
      const month = typeof input.month === 'string' && /^\d{4}-\d{2}$/.test(input.month) ? input.month : undefined;
      let u = null;
      try {
        u = await fetchServerAiUsage(month);
      } catch { /* 네트워크 오류 */ }
      if (!u) {
        const e = configDataSync().effective;
        return { 출처: '없음', 안내: '서버 모드에서만 실제 사용량을 읽을 수 있습니다 (시연 모드에는 기록이 없습니다)', 설정: { 사용: e.ai.enabled, 월한도토큰: e.ai.monthlyTokenLimit } };
      }
      const v = aiUsageView(u);
      return {
        출처: 'LIVE 서버 ai_usage 기록', 월: u.month, 판정: v.verdict,
        사용토큰: v.used, 월한도토큰: v.limit, 사용률: pctText(v.usedRatio), 남은토큰: Math.max(0, u.remaining),
        호출: u.calls, 오류: u.errors, 서버키연결: u.configured, AI사용: u.enabled, 모델: u.model,
        용도별: v.purposes.slice(0, 8).map((p) => ({ 용도: p.label, 호출: p.calls, 토큰: p.tokens, 비중: pctText(p.share) })),
        최근7일: v.recentDaily,
        기준: u.basis,
      };
    },
  };
}

function onboardingOf(): { o: OnboardingState; live: boolean } {
  const s = currentSnapshot();
  if (s?.onboarding) return { o: s.onboarding, live: true };
  return { o: demoOnboarding(), live: false };
}

function configBrief(_ctx: ToolContext): Brief {
  const d = configDataSync();
  const e = d.effective;
  const changed = diffConfig(DEFAULT_CONFIG, e);
  const tag = d.source === 'LIVE' ? `서버 설정 버전 ${d.version ?? 0}` : d.source === '적용된 설정' ? '서버 워크스페이스 설정' : '기본값(제안서 v3)';
  const r = delegationRanges(e.delegation.aeMaxPct, e.delegation.pmMaxPct);
  const facts = [
    `목표 ROAS ${e.targets.roas}% · 브랜드 ${e.targets.brandRoas}% · 고효율 기준 목표 × ${e.targets.highEfficiencyRatio}(${Math.round(e.targets.roas * e.targets.highEfficiencyRatio)}% 이상) — ${tag}`,
    `SAFETY 일 조정 폭 상한 ${e.safety.dailyChangeCapPct}% · 하향 전 최소 전환 ${e.safety.minConversionsForDown}건 · 급변 보류 ±${e.safety.anomalyHoldPct}% · 대량 변경 경고 ${e.safety.bulkWarnCount}건 / 차단 ${e.safety.bulkBlockCount}건`,
    `위임 범위: ${r[0]} 담당 AE, ${r[1]} PM, ${r[2]} 광고주 승인`,
    `연 예산 ${Math.round(e.budget.annual / 1e8).toLocaleString('ko-KR')}억 원 · 매체 배분 ${MEDIA_ID_LIST.map((id) => `${MEDIA_LABEL[id]} ${Math.round(e.budget.allocation[id] * 1000) / 10}%`).join(' · ')}`,
    `P1 SLA 인지 ${minutesLabel(e.sla.P1.ackMin)} · 1차 조치 ${e.sla.P1.actionMin === null ? '협의' : minutesLabel(e.sla.P1.actionMin)} · 결과 보고 ${e.sla.P1.reportMin === null ? '협의' : minutesLabel(e.sla.P1.reportMin)}`,
  ];
  const patterns = changed.length
    ? [`기본값에서 바꾼 항목 ${changed.length}개: ${changed.slice(0, 8).map((c) => `${configFieldLabel(c.path)} ${formatConfigValue(c.path, c.before)} → ${formatConfigValue(c.path, c.after)}`).join(', ')}${changed.length > 8 ? ' 외' : ''}`]
    : ['모든 항목이 기본값(제안서 · RFP 기준)입니다. 온보딩 중 확정하기로 한 목표 ROAS · 위임 범위가 아직 그대로입니다.'];
  const interpretation: string[] = [];
  if (e.targets.roas !== DEFAULT_CONFIG.targets.roas) interpretation.push(`목표 ROAS가 ${DEFAULT_CONFIG.targets.roas}% → ${e.targets.roas}%로 바뀌어 AD Pilot 입찰 상향 후보 기준(고효율 ${Math.round(e.targets.roas * e.targets.highEfficiencyRatio)}%)과 Lab · Board 판정이 함께 움직입니다.`);
  if (e.safety.dailyChangeCapPct > DEFAULT_CONFIG.safety.dailyChangeCapPct) interpretation.push(`일 조정 폭 상한을 ${e.safety.dailyChangeCapPct}%로 넓혀 한 번에 반영되는 입찰 변화가 커집니다. 반영 전 점검과 롤백 기록은 그대로 적용됩니다.`);
  if (e.delegation.aeMaxPct !== DEFAULT_CONFIG.delegation.aeMaxPct || e.delegation.pmMaxPct !== DEFAULT_CONFIG.delegation.pmMaxPct) interpretation.push('위임 범위가 바뀌어 같은 변경 폭이라도 승인 주체가 달라집니다. 진행 중인 승인 대기 건은 요청 시점의 승인 주체를 유지합니다.');
  if (!interpretation.length) interpretation.push(changed.length ? '바꾼 항목은 판정 기준을 직접 움직이지 않는 표기 · 운영 항목입니다.' : '기본값 그대로라 판정 결과는 제안서 기준과 같습니다. 계약 · 온보딩에서 확정한 값이 있으면 워크스페이스 설정에 반영해야 서버 판정과 일치합니다.');
  return {
    title: '워크스페이스 설정 점검',
    facts,
    patterns,
    interpretation,
    conditions: ['설정 값은 워크스페이스 설정 화면에서 저장한 값이 기준이며, 저장 즉시 화면 엔진과 서버(입찰 반영 · 감지 · SLA)가 같은 값을 씁니다', '매체 배분 합계는 100% ± 0.1%p여야 저장됩니다'],
    counter: ['이미 열려 있던 화면은 다시 열어야 새 기준으로 계산됩니다', '서버의 예약 수집 · 리포트 발송 시각은 아직 고정 일정이며 데이터 시간표 변경은 화면 · 안내 기준에 먼저 반영됩니다'],
    actions: [
      ...(changed.length ? [] : ['온보딩 중 확정한 목표 ROAS · 위임 범위 · 일 조정 폭 상한을 워크스페이스 설정에 입력하거나, 기본값 그대로 확인 기록을 남기기']),
      '설정을 바꾼 뒤 변경 이력에서 이전 값 → 새 값과 변경자를 확인',
    ],
  };
}

function onboardingBrief(_ctx: ToolContext): Brief {
  const { o, live } = onboardingOf();
  const done = o.steps.filter((s) => s.done);
  const todo = o.steps.filter((s) => !s.done);
  return {
    title: '워크스페이스 시작하기 점검',
    facts: [
      `시작하기 단계 ${o.done}/${o.total} 완료 — ${live ? '서버 상태 기준' : 'TEST DATA 예시'}`,
      ...o.steps.map((s) => `${s.label}: ${s.done ? '완료' : '할 일'} · ${s.detail}`),
    ],
    patterns: todo.length ? [`남은 단계: ${todo.map((s) => s.label).join(' → ')}`] : ['네 단계가 모두 끝났습니다.'],
    interpretation: [
      todo.some((s) => s.id === 'data')
        ? '실데이터가 연결되기 전에는 감지 · 리포트 · 성과 증명이 데모 데이터 기준이라 운영 판단에 쓸 수 없습니다.'
        : todo.some((s) => s.id === 'notify')
          ? '알림 채널이 없으면 P1 이슈를 서버가 감지해도 담당자에게 바로 전달되지 않습니다.'
          : done.length === o.total ? '수집 · 감지 · 알림 · 기준이 모두 준비되어 운영 루틴을 시작할 수 있습니다.' : '남은 단계를 끝내면 운영 루틴을 시작할 수 있습니다.',
    ],
    conditions: ['데이터 연결 완료 = 데모를 제외한 커넥션 또는 가져온 CSV가 있음', '팀 초대 완료 = 구성원 2명 이상 또는 수락 대기 초대가 있음', '목표 · 예산 확인 = 목표 · 예산 항목을 바꿨거나 기본값 확인 기록이 있음', '알림 채널 = 켜진 채널 1개 이상'],
    counter: ['CSV만 올린 워크스페이스는 연결 완료로 보지만 예약 수집은 되지 않습니다'],
    actions: todo.map((s) => `${s.label} 화면(${s.href})에서 진행`),
  };
}

export const agentKit: ModuleAgentKit = {
  tools: () => [configTool(), historyTool(), aiUsageTool()],
  briefs: [
    { id: 'workspace_config', match: /(워크스페이스|설정|기준값|목표\s?ROAS|목표\s?CPA|위임|SLA|시간표|배분|SAFETY|세이프티)/i, build: configBrief },
    { id: 'workspace_onboarding', match: /(온보딩|시작하기|처음|셋업|초기\s?설정|연결 순서)/, build: onboardingBrief },
  ],
};
