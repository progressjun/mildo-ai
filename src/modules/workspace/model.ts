/**
 * 워크스페이스 설정 화면 모델 (순수 함수 · 타입 · 예시 상태) — 화면 · 에이전트 · 테스트 공용.
 * 스키마 · 기본값 · 병합 · 검증은 src/data/config.ts 하나를 쓴다(서버와 같은 규칙).
 */
import {
  DEFAULT_CONFIG, configFieldLabel, formatConfigValue, getPath, leafPaths, MEDIA_ID_LIST, mergeConfig, overrideChanges, parseWorkspaceConfig,
  type ConfigChangeRow, type ConfigIssue, type EffectiveConfig, type WorkspaceConfig,
} from '@/data/config';
import type { MediaId } from '@/core/types';

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
