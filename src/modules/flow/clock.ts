/**
 * MILDO Flow 데이터 기준 시계.
 * '지금' = 데이터 기준 시각(state.data.generatedAt, 10/31 15:30) + 페이지를 연 뒤 실제 경과 시간.
 * 스토어가 남긴 실제 시각(nowIso, …Z)은 같은 기준으로 환산해 시드 이력(+09:00)과 한 타임라인에 놓는다.
 * 비즈니스 '오늘'은 항상 state.data.today를 쓴다.
 */
import { msToKstIso, refNowMs, toRefMs, type ToMs } from './engine';

export const FLOW_ANCHOR_MS: number =
  typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin) ? Math.round(performance.timeOrigin) : Date.now();

export interface FlowClock { nowMs: number; toMs: ToMs; nowIso: string }

export function makeClock(generatedAt: string, realNowMs: number = Date.now()): FlowClock {
  const toMs: ToMs = (iso) => toRefMs(iso, generatedAt, FLOW_ANCHOR_MS);
  const nowMs = refNowMs(generatedAt, FLOW_ANCHOR_MS, realNowMs);
  return { nowMs, toMs, nowIso: msToKstIso(nowMs) };
}
