/**
 * 서버 모드 스냅샷 — 알림 설정 화면이 서버에서 읽은 마지막 값을 에이전트 도구(notify_channels_status)가 쓴다.
 * 화면을 연 적이 없거나 데모 모드면 비어 있고, 도구는 데모 예시(TEST DATA)로 답한다.
 */
import type { Channel, LogEntry, ScanRun } from './model';

export interface NotifySnapshot { ws: string; at: number; channels?: Channel[]; log?: LogEntry[]; runs?: ScanRun[] }

let snap: NotifySnapshot | null = null;

export function setNotifySnapshot(ws: string, patch: Omit<Partial<NotifySnapshot>, 'ws' | 'at'>): void {
  snap = { ...(snap && snap.ws === ws ? snap : { ws }), ...patch, ws, at: Date.now() };
}
export const getNotifySnapshot = (): NotifySnapshot | null => snap;
export function _resetNotifySnapshotForTest(): void {
  snap = null;
}
