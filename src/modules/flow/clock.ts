/**
 * MILDO Flow 데이터 기준 시계.
 * '지금' = 데이터 기준 시각(state.data.generatedAt, 10/31 15:30) + 페이지를 연 뒤 실제 경과 시간.
 * 스토어가 남긴 실제 시각(nowIso, …Z)은 같은 기준으로 환산해 시드 이력(+09:00)과 한 타임라인에 놓는다.
 * 비즈니스 '오늘'은 항상 state.data.today를 쓴다.
 *
 * 서버 모드(real=true): 이력 시각은 서버가 남긴 실제 시각이고 데이터도 실시간이라 환산하지 않는다 — 실제 시각(KST 표기) 그대로.
 * 환산하면 페이지를 연 뒤 데이터셋이 다시 만들어질 때(generatedAt이 바뀜) 같은 이력이 그만큼 밀려 보이고,
 * AD Pilot 변경 이력(실제 시각 KST)과 Flow 상세의 같은 이력 시각이 달라진다.
 */
import { msToKstIso, refNowMs, toRefMs, type ToMs } from './engine';

export const FLOW_ANCHOR_MS: number =
  typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin) ? Math.round(performance.timeOrigin) : Date.now();

export interface FlowClock { nowMs: number; toMs: ToMs; nowIso: string }

export function makeClock(generatedAt: string, realNowMs: number = Date.now(), real = false): FlowClock {
  if (real) {
    const toMs: ToMs = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : NaN; };
    return { nowMs: realNowMs, toMs, nowIso: msToKstIso(realNowMs) };
  }
  const toMs: ToMs = (iso) => toRefMs(iso, generatedAt, FLOW_ANCHOR_MS);
  const nowMs = refNowMs(generatedAt, FLOW_ANCHOR_MS, realNowMs);
  return { nowMs, toMs, nowIso: msToKstIso(nowMs) };
}
