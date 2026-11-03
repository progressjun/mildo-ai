/**
 * MILDO Flow 시계 — 데모는 데이터 기준 시각으로 환산(기존 그대로), 서버 모드는 실제 시각 그대로 (QA G1a: AD Pilot 변경 이력과
 * Flow 상세의 같은 롤백 이력이 다른 시각으로 보였다 — Flow가 서버 시각을 데이터 기준 시각(generatedAt)으로 다시 환산).
 */
import { describe, expect, it } from 'vitest';
import { FLOW_ANCHOR_MS, makeClock } from './clock';
import { fmtStamp } from './engine';

describe('makeClock', () => {
  const at = '2026-11-03T08:36:00.000Z'; // KST 17:36 롤백 이력 (서버 시각)
  // 페이지를 연 뒤 데이터셋이 다시 만들어져 generatedAt이 45분 뒤로 바뀐 상황
  const gen = new Date(FLOW_ANCHOR_MS + 45 * 60_000).toISOString();

  it('서버 모드: 서버가 남긴 시각을 환산하지 않고 실제 KST로 표기', () => {
    const c = makeClock(gen, Date.parse('2026-11-03T08:40:00.000Z'), true);
    expect(c.toMs(at)).toBe(Date.parse(at));
    expect(fmtStamp(c.toMs(at))).toContain('17:36');
    expect(c.nowMs).toBe(Date.parse('2026-11-03T08:40:00.000Z'));
    expect(c.toMs('')).toBeNaN();
  });

  it('데모 모드: 세션 시각(…Z)은 데이터 기준 시각으로 환산 (기존 그대로)', () => {
    const c = makeClock(gen, FLOW_ANCHOR_MS);
    expect(c.toMs(new Date(FLOW_ANCHOR_MS).toISOString())).toBe(Date.parse(gen));
    // 시드 이력(+09:00)은 그대로
    expect(c.toMs('2026-10-31T15:30:00+09:00')).toBe(Date.parse('2026-10-31T15:30:00+09:00'));
  });
});
