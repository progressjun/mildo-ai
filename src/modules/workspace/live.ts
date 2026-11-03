/**
 * 서버 모드에서 화면이 마지막으로 불러온 설정 상태 — MILDO Agent 도구 · 브리프가 읽는다(화면을 열지 않았으면 비어 있다).
 * 비어 있으면 도구는 지금 적용된 설정(activeWorkspaceConfig — 서버 모드에서는 플랫폼이 워크스페이스 설정을 적용해 둔다)을 쓴다.
 */
import type { ConfigState, HistoryEntry, OnboardingState } from './model';

export interface WorkspaceSnapshot {
  workspaceId: string;
  state: ConfigState | null;
  history: HistoryEntry[] | null;
  onboarding: OnboardingState | null;
  at: string;
}

let snap: WorkspaceSnapshot | null = null;

export function setWorkspaceSnapshot(workspaceId: string, part: Partial<Pick<WorkspaceSnapshot, 'state' | 'history' | 'onboarding'>>): void {
  const base = snap && snap.workspaceId === workspaceId ? snap : { workspaceId, state: null, history: null, onboarding: null, at: '' };
  snap = { ...base, ...part, at: new Date().toISOString() };
}

export const getWorkspaceSnapshot = (): WorkspaceSnapshot | null => snap;
export function _resetWorkspaceSnapshot(): void {
  snap = null;
}
