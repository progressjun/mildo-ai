/**
 * MILDO Alert 시계 — 화면 표시 · SLA 타이머 전용.
 *
 * 데모 모드(서버 없음): 데이터 기준 시각(state.data.generatedAt, 10/31 15:30)에서 시작해 실제 경과 시간만큼 흐르는 '데이터 시계'.
 *   시작점은 MILDO Alert 화면을 처음 연 시점 (라이브 데모에서 타이머가 화면 진입부터 흐르도록). 비즈니스 '오늘'은 state.data.today.
 * 서버 모드(realTime): 실제 시각. 서버가 감지 시각(detectedAt) · 처리 시각(sla.*) · 타임라인을 서버 KST 실제 시각으로 기록하고
 *   SLA 잡(alerts.sla)도 실제 시각으로 판정하므로, 화면도 같은 시계를 써야 남은 시간이 서버와 맞는다.
 *   (generatedAt은 수집 · 새로고침 때마다 바뀌고 분 단위로 내림된 값이라 세션 경과를 더하면 새로고침마다 앞당겨지고 처음엔 최대 59초 늦다.)
 */
import { useEffect, useState } from 'react';
import { useSaas } from '@/saas/context';

const SESSION_START = Date.now();

export function dataNowMs(generatedAt: string, realTime = false, realNow: number = Date.now()): number {
  if (realTime) return realNow;
  return Date.parse(generatedAt) + (realNow - SESSION_START);
}

/** ISO → 시계 ms. 데모: 스토어가 남긴 실제 시각 기록(…Z)은 세션 경과로 환산한다. 서버 모드: 모든 기록이 실제 시각이라 그대로. */
export function toDataMs(iso: string, generatedAt: string, realTime = false): number {
  if (!iso) return NaN;
  if (realTime) return Date.parse(iso);
  if (iso.endsWith('Z')) return Date.parse(generatedAt) + (Date.parse(iso) - SESSION_START);
  return Date.parse(iso);
}

export function useDataClock(generatedAt: string, tickMs = 1000, realTime = false): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return dataNowMs(generatedAt, realTime);
}

/** 서버 모드면 실제 시각 시계를 쓴다 (화면 · SLA 타이머 공용 판정) */
export function useRealTimeClock(): boolean {
  return useSaas().mode === 'server';
}
