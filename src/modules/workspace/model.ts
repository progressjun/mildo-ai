/**
 * 워크스페이스 설정 화면 모델 (순수 함수 · 타입 · 예시 상태) — 화면 · 에이전트 · 테스트 공용.
 * 스키마 · 기본값 · 병합 · 검증은 src/data/config.ts 하나를 쓴다(서버와 같은 규칙).
 */
import {
  DEFAULT_CONFIG, configFieldLabel, formatConfigValue, getPath, leafPaths, MEDIA_ID_LIST, mergeConfig, overrideChanges, parseWorkspaceConfig,
  type ConfigChangeRow, type ConfigIssue, type EffectiveConfig, type WorkspaceConfig,
} from '@/data/config';
import type { MediaId } from '@/core/types';
import type { ServerAiUsage } from '@/ai/claude';

/* ============================== API 형식 (server/src/settings) ============================== */

export interface ConfigState {
  config: WorkspaceConfig;
  effective: EffectiveConfig;
  defaults: EffectiveConfig;
  overridden: string[];
  invalid: ConfigIssue[];
  preserved: string[];
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}
export interface SaveResult extends ConfigState { changed: boolean; dryRun: boolean; changes: ConfigChangeRow[] }
export interface HistoryEntry {
  id: number;
  at: string;
  actor: string;
  userId: string | null;
  action: string;
  version: number | null;
  changes: { path: string; label: string; before: unknown; after: unknown; beforeSource?: string; afterSource?: string }[];
  note?: string;
}
export type OnboardingStepId = 'data' | 'team' | 'goals' | 'notify';
export interface OnboardingStep { id: OnboardingStepId; label: string; href: string; done: boolean; detail: string; at?: string }
export interface OnboardingState { firstRun: boolean; steps: OnboardingStep[]; done: number; total: number }

/* ============================== 덮어쓰기 · 필드 상태 ============================== */

export interface FieldState {
  value: unknown;
  defaultValue: unknown;
  overridden: boolean;
  defaultText: string;
}

/** 경로의 현재 값(초안 기준) · 기본값 · 덮어쓰기 여부 */
export function fieldState(draft: WorkspaceConfig, path: string, defaults: EffectiveConfig = DEFAULT_CONFIG): FieldState {
  const eff = mergeConfig(defaults, draft);
  const overridden = getPath(draft, path) !== undefined;
  const defaultValue = getPath(defaults, path);
  return { value: getPath(eff, path), defaultValue, overridden, defaultText: formatConfigValue(path, defaultValue) };
}

/** 섹션(접두 경로)에 덮어쓴 항목 수 */
export const overrideCount = (draft: WorkspaceConfig, prefixes: readonly string[]) =>
  leafPaths(draft).filter((p) => prefixes.some((x) => p === x || p.startsWith(`${x}.`))).length;

/** 초안 검증 — 경로별 첫 사유 */
export function draftIssues(draft: WorkspaceConfig): ConfigIssue[] {
  return parseWorkspaceConfig(draft).errors;
}
export function issueFor(issues: readonly ConfigIssue[], path: string): string | null {
  const hit = issues.find((i) => i.path === path || i.path.startsWith(`${path}.`) || (path.startsWith(`${i.path}.`) && i.path !== ''));
  return hit ? hit.message : null;
}

/** 저장 전 미리보기: 저장된 덮어쓰기 → 초안 */
export interface PreviewRow { path: string; label: string; before: string; after: string; toDefault: boolean; sourceOnly: boolean }
export function previewChanges(saved: WorkspaceConfig, draft: WorkspaceConfig, defaults: EffectiveConfig = DEFAULT_CONFIG): PreviewRow[] {
  return overrideChanges(saved, draft, defaults).map((r) => ({
    path: r.path, label: r.label,
    before: `${formatConfigValue(r.path, r.before)}${r.beforeSource === 'default' ? ' (기본값)' : ''}`,
    after: `${formatConfigValue(r.path, r.after)}${r.afterSource === 'default' ? ' (기본값)' : ''}`,
    toDefault: r.afterSource === 'default',
    sourceOnly: JSON.stringify(r.before) === JSON.stringify(r.after),
  }));
}

/** 이력 한 줄 표시 */
export function historyChangeText(c: HistoryEntry['changes'][number]): string {
  return `${c.label || configFieldLabel(c.path)}: ${formatConfigValue(c.path, c.before)} → ${formatConfigValue(c.path, c.after)}${c.afterSource === 'default' ? ' (기본값으로)' : ''}`;
}
export const HISTORY_ACTION_LABEL: Record<string, string> = {
  'config.update': '설정 변경', 'config.reset': '전체 기본값으로', 'config.review': '목표 · 예산 확인',
};

/* ============================== 예산 배분 ============================== */

export interface AllocationRow { id: MediaId; label: string; share: number; defaultShare: number; overridden: boolean; annual: number; monthly: number }
export function allocationRows(draft: WorkspaceConfig, defaults: EffectiveConfig = DEFAULT_CONFIG): { rows: AllocationRow[]; sum: number; ok: boolean; gapPp: number } {
  const eff = mergeConfig(defaults, draft);
  const rows = MEDIA_ID_LIST.map((id) => {
    const share = eff.budget.allocation[id];
    const annual = Math.round(eff.budget.annual * share);
    return { id, label: configFieldLabel(`budget.allocation.${id}`).replace(/ 배분 비중$/, ''), share, defaultShare: defaults.budget.allocation[id], overridden: getPath(draft, `budget.allocation.${id}`) !== undefined, annual, monthly: Math.round(annual / 12) };
  });
  const sum = rows.reduce((s, r) => s + r.share, 0);
  return { rows, sum, ok: Math.abs(sum - 1) <= 0.001, gapPp: Math.round((sum - 1) * 1000) / 10 };
}

/** 한 매체를 고정하고 나머지를 원래 비율대로 맞춰 합계 100% (0.1%p 단위 반올림, 오차는 가장 큰 매체가 흡수) */
export function normalizeAllocation(alloc: Record<MediaId, number>, locked: MediaId): Record<MediaId, number> {
  const fixed = Math.min(1, Math.max(0, alloc[locked]));
  const others = MEDIA_ID_LIST.filter((id) => id !== locked);
  const rest = others.reduce((s, id) => s + Math.max(0, alloc[id]), 0);
  const out = { ...alloc, [locked]: fixed } as Record<MediaId, number>;
  for (const id of others) out[id] = rest > 0 ? Math.round(((Math.max(0, alloc[id]) / rest) * (1 - fixed)) * 1000) / 1000 : Math.round(((1 - fixed) / others.length) * 1000) / 1000;
  const diff = Math.round((1 - MEDIA_ID_LIST.reduce((s, id) => s + out[id], 0)) * 1000) / 1000;
  if (diff !== 0) {
    const big = others.reduce((a, b) => (out[a] >= out[b] ? a : b));
    out[big] = Math.round((out[big] + diff) * 1000) / 1000;
  }
  return out;
}

/* ============================== AI 사용량 · 한도 ============================== */

export type { ServerAiUsage };
/** 화면에 넘기는 사용량 상태 — demo = TEST DATA 예시 */
export interface AiUsageState { status: 'loading' | 'ok' | 'error' | 'demo'; usage: ServerAiUsage | null; error?: string }

export interface AiUsageView {
  used: number;
  limit: number;
  /** 저장된 한도 기준 사용률 (0~) */
  usedRatio: number;
  /** 편집 중인 한도 (저장 전) — 저장된 한도와 같으면 null */
  draftLimit: number | null;
  draftRatio: number | null;
  /** 편집 중인 한도가 이번 달 사용량 이하 → 저장하면 즉시 AI 호출이 막힌다 */
  draftBlocksNow: boolean;
  tone: 'accent' | 'warning' | 'critical';
  /** 판정 문구 + 기준 */
  verdict: string;
  /** 용도별 · 비중 내림차순 */
  purposes: { purpose: string; label: string; calls: number; tokens: number; share: number }[];
  /** 최근 7일 */
  recentDaily: { date: string; calls: number; tokens: number }[];
  users: { name: string; calls: number; tokens: number }[];
}

const PURPOSE_LABEL: Record<string, string> = {
  agent: 'MILDO Agent 대화', 'agent:chat': 'MILDO Agent 대화', chat: 'MILDO Agent 대화', brief: '브리프 · 요약', report: '리포트 문안', json: '구조화 분석',
};
export function purposeLabel(p: string): string {
  if (PURPOSE_LABEL[p]) return PURPOSE_LABEL[p];
  const [screen, kind] = p.split(':');
  const kindLabel = kind ? PURPOSE_LABEL[kind] ?? kind : '';
  return kindLabel ? `${screen} · ${kindLabel}` : p || '기타';
}

const ratio = (used: number, limit: number) => (limit > 0 ? used / limit : used > 0 ? Infinity : 0);

export function aiUsageView(u: ServerAiUsage, draftLimit?: number | null): AiUsageView {
  const used = Math.max(0, u.totalTokens ?? u.inputTokens + u.outputTokens);
  const limit = Math.max(0, u.limit);
  const usedRatio = ratio(used, limit);
  const dl = typeof draftLimit === 'number' && Number.isFinite(draftLimit) && draftLimit !== limit ? Math.max(0, draftLimit) : null;
  const draftRatio = dl === null ? null : ratio(used, dl);
  const worst = Math.max(usedRatio, draftRatio ?? 0);
  const tone = worst >= 1 ? 'critical' : worst >= 0.8 ? 'warning' : 'accent';
  const verdict = !u.enabled
    ? 'AI 사용 꺼짐 — 화면은 규칙 엔진 · 오프라인 브리프로 동작합니다 (기준: 워크스페이스 설정 ai.enabled)'
    : u.budgetExceeded || usedRatio >= 1
      ? '한도 도달 — 이번 달 남은 기간 서버 AI 호출이 막힙니다 (기준: 입력 + 출력 토큰 ≥ 월 한도)'
      : usedRatio >= 0.8
        ? '한도 80% 이상 — 남은 기간 사용량을 확인해 주세요 (기준: 사용률 ≥ 80%)'
        : '여유 — 사용률 80% 미만 (기준: 입력 + 출력 토큰 ÷ 월 한도)';
  const totalOf = (x: { inputTokens: number; outputTokens: number }) => x.inputTokens + x.outputTokens;
  const purposeTotal = (u.byPurpose ?? []).reduce((s, x) => s + totalOf(x), 0);
  const purposes = (u.byPurpose ?? [])
    .map((x) => ({ purpose: x.purpose, label: purposeLabel(x.purpose), calls: x.calls, tokens: totalOf(x), share: purposeTotal > 0 ? totalOf(x) / purposeTotal : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  const recentDaily = [...(u.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date)).slice(-7).map((d) => ({ date: d.date, calls: d.calls, tokens: totalOf(d) }));
  const users = (u.byUser ?? []).map((x) => ({ name: x.name, calls: x.calls, tokens: totalOf(x) })).sort((a, b) => b.tokens - a.tokens);
  return { used, limit, usedRatio, draftLimit: dl, draftRatio, draftBlocksNow: dl !== null && used >= dl, tone, verdict, purposes, recentDaily, users };
}

/** 비율 → '12.3%' (무한대 = 한도 0) */
export const pctText = (r: number) => (Number.isFinite(r) ? `${(Math.round(r * 1000) / 10).toLocaleString('ko-KR')}%` : '한도 0');

/* ============================== 성과 증명 기준 ============================== */

export interface ImpactBasis {
  monthlyFee: number;
  margin: number;
  hourlyCost: number;
  /** 1배 회수에 필요한 월 가치 = 구독료 */
  breakEvenValue: number;
  /** 증분 이익만으로 1배를 채우려면 필요한 증분 매출 = 구독료 ÷ 공헌이익률 (계산값) */
  breakEvenRevenue: number;
  /** 절감 시간만으로 1배를 채우려면 필요한 시간 = 구독료 ÷ 시간당 인건비 (계산값) */
  breakEvenHours: number | null;
}
export function impactBasis(e: EffectiveConfig): ImpactBasis {
  const fee = e.billing.monthlyFee;
  const margin = e.impact.contributionMargin;
  const hourly = e.impact.hourlyCost;
  return {
    monthlyFee: fee, margin, hourlyCost: hourly, breakEvenValue: fee,
    breakEvenRevenue: margin > 0 ? Math.round(fee / margin) : Infinity,
    breakEvenHours: hourly > 0 ? Math.round((fee / hourly) * 10) / 10 : null,
  };
}

/* ============================== 예시 상태 (데모 모드 · TEST DATA) ============================== */

const DEMO_AT = '2026-11-02T00:10:00.000Z';

export function demoState(): ConfigState {
  return {
    config: {}, effective: mergeConfig(DEFAULT_CONFIG, {}), defaults: DEFAULT_CONFIG, overridden: [], invalid: [], preserved: [],
    version: 0, updatedAt: null, updatedBy: null,
  };
}

/** 예시 변경 이력 (TEST DATA — 실제 기록 아님) */
export function demoHistory(): HistoryEntry[] {
  return [
    { id: 3, at: DEMO_AT, actor: '총괄 PM (예시)', userId: null, action: 'config.review', version: 2, changes: [], note: '제안서 기준 그대로 운영 시작' },
    {
      id: 2, at: '2026-11-01T08:40:00.000Z', actor: '총괄 PM (예시)', userId: null, action: 'config.update', version: 2,
      changes: [{ path: 'safety.dailyChangeCapPct', label: configFieldLabel('safety.dailyChangeCapPct'), before: 15, after: 20, beforeSource: 'override', afterSource: 'default' }],
    },
    {
      id: 1, at: '2026-10-30T05:20:00.000Z', actor: '운영 책임자 (예시)', userId: null, action: 'config.update', version: 1,
      changes: [
        { path: 'safety.dailyChangeCapPct', label: configFieldLabel('safety.dailyChangeCapPct'), before: 20, after: 15, beforeSource: 'default', afterSource: 'override' },
        { path: 'timetable.issue_brief', label: configFieldLabel('timetable.issue_brief'), before: '09:30', after: '09:30', beforeSource: 'default', afterSource: 'override' },
      ],
    },
  ];
}

/** 예시 AI 사용량 (TEST DATA — 실제 사용 기록 아님) */
export function demoAiUsage(): ServerAiUsage {
  const daily = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map((date, i) => ({
    date, calls: [42, 55, 38, 61, 12, 9, 47][i], inputTokens: [410_000, 520_000, 360_000, 610_000, 90_000, 70_000, 450_000][i], outputTokens: [38_000, 51_000, 33_000, 58_000, 9_000, 6_000, 41_000][i],
  }));
  const inputTokens = 6_840_000;
  const outputTokens = 612_000;
  return {
    month: '2026-10', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 2_150_000, cacheCreationTokens: 340_000,
    calls: 734, errors: 3, limit: DEFAULT_CONFIG.ai.monthlyTokenLimit, remaining: DEFAULT_CONFIG.ai.monthlyTokenLimit - inputTokens - outputTokens,
    usedRatio: (inputTokens + outputTokens) / DEFAULT_CONFIG.ai.monthlyTokenLimit, budgetExceeded: false,
    byPurpose: [
      { purpose: 'agent', calls: 412, inputTokens: 4_120_000, outputTokens: 388_000 },
      { purpose: 'adpilot:json', calls: 166, inputTokens: 1_480_000, outputTokens: 121_000 },
      { purpose: 'reports:brief', calls: 98, inputTokens: 840_000, outputTokens: 72_000 },
      { purpose: 'geo:json', calls: 58, inputTokens: 400_000, outputTokens: 31_000 },
    ],
    daily,
    byUser: [
      { userId: null, name: '총괄 PM (예시)', calls: 301, inputTokens: 3_020_000, outputTokens: 268_000 },
      { userId: null, name: '담당 AE (예시)', calls: 433, inputTokens: 3_820_000, outputTokens: 344_000 },
    ],
    model: 'claude-opus-5-5', configured: true, enabled: true, canUse: true, available: true,
    basis: '예시(TEST DATA) — 서버에 연결하면 KST 월 기준 실제 입력 + 출력 토큰 합계를 보여 줍니다.',
  };
}

export function demoOnboarding(): OnboardingState {
  const steps: OnboardingStep[] = [
    { id: 'data', label: '데이터 연결', href: '#connections', done: false, detail: '데모 데이터만 연결됨 — 매체 · 판매 채널 API를 연결하거나 CSV를 올려 주세요' },
    { id: 'team', label: '팀 초대', href: '#team', done: true, detail: '구성원 6명 · 수락 대기 초대 1건 (예시)' },
    { id: 'goals', label: '목표 · 예산 확인', href: '#workspace', done: false, detail: '목표 ROAS · 연 예산 · 매체 배분이 제안서 기본값입니다 — 확인하거나 바꿔 주세요' },
    { id: 'notify', label: '알림 채널', href: '#notify', done: false, detail: 'P1 이슈 · SLA 초과를 받을 Slack · 이메일 · 웹훅 채널이 없습니다' },
  ];
  return { firstRun: true, steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

/** KST 표시 'MM/DD HH:mm' */
export function fmtKst(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
