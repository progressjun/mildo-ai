/**
 * 데이터 기준 시계 — 화면 표시 · SLA 타이머 전용.
 * 데이터 기준 시각(state.data.generatedAt, 10/31 15:30)에서 시작해 실제 경과 시간만큼 흐른다.
 * 비즈니스 '오늘'은 항상 state.data.today를 쓰고, 이 시계는 SLA 경과 · 처리 시각 기록에만 쓴다.
 * 시작점: MILDO Alert 화면을 처음 연 시점 (라이브 데모에서 타이머가 화면 진입부터 흐르도록).
 */
import { useEffect, useState } from 'react';

const SESSION_START = Date.now();

export function dataNowMs(generatedAt: string): number {
  return Date.parse(generatedAt) + (Date.now() - SESSION_START);
}

/** ISO → 데이터 시계 ms. 스토어가 남긴 실제 시각 기록(…Z)은 세션 경과로 환산한다. */
export function toDataMs(iso: string, generatedAt: string): number {
  if (!iso) return NaN;
  if (iso.endsWith('Z')) return Date.parse(generatedAt) + (Date.parse(iso) - SESSION_START);
  return Date.parse(iso);
}

export function useDataClock(generatedAt: string, tickMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return dataNowMs(generatedAt);
}
