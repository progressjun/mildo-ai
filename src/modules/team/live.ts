/**
 * 서버 모드에서 화면이 마지막으로 불러온 팀 데이터 — MILDO Agent 도구 · 브리프가 읽는다(화면을 열지 않았으면 비어 있다).
 * 도구는 이 값이 있으면 서버에서 한 번 더 새로 읽고, 없으면 예시(TEST DATA)를 안내와 함께 돌려준다.
 */
import type { Invite, Member } from './engine';

export interface TeamSnapshot {
  workspaceId: string;
  members: Member[] | null;
  invites: Invite[] | null;
  at: string;
}

let snap: TeamSnapshot | null = null;

export function setTeamSnapshot(workspaceId: string, part: Partial<Pick<TeamSnapshot, 'members' | 'invites'>>): void {
  const base = snap && snap.workspaceId === workspaceId ? snap : { workspaceId, members: null, invites: null, at: '' };
  snap = { ...base, ...part, at: new Date().toISOString() };
}

export const getTeamSnapshot = (): TeamSnapshot | null => snap;
export function _resetTeamSnapshot(): void {
  snap = null;
}
