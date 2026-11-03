/**
 * 워크스페이스 설정 서버 API (서버 모드 전용) — 계약: docs/SAAS_SPEC.md §6 settings, 구현: server/src/settings.
 * 오류는 ApiError(code · message 한국어 · detail = 항목별 사유)로 던진다. 화면이 직접 안내하므로 전역 오류 토스트는 끈다(silent).
 */
import { api, wsPath } from '@/saas/api';
import type { WorkspaceConfig } from '@/data/config';
import { fetchServerAiUsage, serverAiWorkspace } from '@/ai/claude';
import type { ConfigState, HistoryEntry, OnboardingState, SaveResult, ServerAiUsage } from './model';
import { setWorkspaceSnapshot } from './live';

const silent = { silent: true } as const;

export async function fetchConfig(ws: string): Promise<ConfigState> {
  const r = await api<ConfigState>(wsPath(ws, '/config'), silent);
  setWorkspaceSnapshot(ws, { state: r });
  return r;
}

export async function saveConfig(ws: string, config: WorkspaceConfig, baseVersion?: number, dryRun = false): Promise<SaveResult> {
  const r = await api<SaveResult>(wsPath(ws, '/config'), { method: 'PUT', body: { config, baseVersion, dryRun }, ...silent });
  if (!dryRun) setWorkspaceSnapshot(ws, { state: r });
  return r;
}

export async function fetchHistory(ws: string, before?: number | null): Promise<{ entries: HistoryEntry[]; nextBefore: number | null }> {
  const q = before ? `?before=${before}` : '';
  const r = await api<{ entries: HistoryEntry[]; nextBefore: number | null }>(wsPath(ws, `/config/history${q}`), silent);
  if (!before) setWorkspaceSnapshot(ws, { history: r.entries });
  return r;
}

export async function fetchOnboarding(ws: string): Promise<OnboardingState> {
  const r = await api<{ onboarding: OnboardingState }>(wsPath(ws, '/config/onboarding'), silent);
  setWorkspaceSnapshot(ws, { onboarding: r.onboarding });
  return r.onboarding;
}

export async function reviewConfig(ws: string, note?: string): Promise<OnboardingState> {
  const r = await api<{ onboarding: OnboardingState }>(wsPath(ws, '/config/review'), { method: 'POST', body: { note }, ...silent });
  setWorkspaceSnapshot(ws, { onboarding: r.onboarding });
  return r.onboarding;
}

/**
 * 이번 달 AI 사용량 (ai 도메인 GET /api/w/:ws/ai/usage). fetchServerAiUsage(@/ai/claude)를 먼저 쓰고,
 * 플랫폼이 연결한 AI 워크스페이스가 이 화면의 워크스페이스와 다르거나 아직 없으면(null) 같은 경로를 직접 읽는다.
 */
export async function fetchAiUsage(ws: string): Promise<ServerAiUsage> {
  if (serverAiWorkspace() === ws) {
    const viaAi = await fetchServerAiUsage().catch(() => null);
    if (viaAi && typeof viaAi.month === 'string') return viaAi;
  }
  return api<ServerAiUsage>(wsPath(ws, '/ai/usage'), silent);
}
