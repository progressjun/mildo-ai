/**
 * 서버 모드 스냅샷 — 성과 증명 화면이 서버에서 읽은 마지막 값을 에이전트 도구(impact_summary)가 쓴다.
 * 화면을 연 적이 없거나 데모 모드면 비어 있고, 도구는 데모 예시(TEST DATA)로 답한다.
 */
import type { ImpactSummary, LedgerEntry } from './engine';
import type { ReportItem } from './api';

export interface ImpactSnapshot { ws: string; at: number; summary?: ImpactSummary; entries?: LedgerEntry[]; month?: string; reports?: ReportItem[] }

let snap: ImpactSnapshot | null = null;

export function setImpactSnapshot(ws: string, patch: Omit<Partial<ImpactSnapshot>, 'ws' | 'at'>): void {
  snap = { ...(snap && snap.ws === ws ? snap : { ws }), ...patch, ws, at: Date.now() };
}
export const getImpactSnapshot = (): ImpactSnapshot | null => snap;
export function _resetImpactSnapshotForTest(): void {
  snap = null;
}
