/**
 * 시각 표기(KST 고정)와 한국어 조사 — QA: AD Pilot 변경 이력 · GFA 요청 목록이 브라우저 시간대(UTC · LA)로 보였고,
 * 롤백 알림이 '1,310원로 복원'처럼 조사가 틀렸다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hhmm, josa, withJosa } from './util';

const TZ0 = process.env.TZ;
afterEach(() => { process.env.TZ = TZ0; });

describe('hhmm — KST 고정', () => {
  it('UTC ISO 시각을 KST로 (같은 시각은 어느 시간대에서도 같은 표기)', () => {
    expect(hhmm('2026-11-03T08:36:00.000Z')).toBe('17:36');
    expect(hhmm('2026-11-03T17:36:00+09:00')).toBe('17:36');
    expect(hhmm('2026-11-02T15:05:00.000Z')).toBe('00:05');
  });
  it('브라우저 시간대가 달라도 같은 값', () => {
    for (const tz of ['UTC', 'Asia/Seoul', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      expect(hhmm('2026-11-03T08:36:00.000Z')).toBe('17:36');
    }
  });
  it('읽을 수 없는 값은 자리표시', () => {
    expect(hhmm('')).toBe('--:--');
    expect(hhmm('not-a-date')).toBe('--:--');
  });
});

describe('josa — 받침에 맞는 조사', () => {
  it('으로/로: 받침 없음 · ㄹ 받침은 로, 그 밖은 으로', () => {
    expect(withJosa('1,310원', '으로/로')).toBe('1,310원으로');
    expect(withJosa('860원', '으로/로')).toBe('860원으로');
    expect(withJosa('수면밀도', '으로/로')).toBe('수면밀도로');
    expect(withJosa('PM', '으로/로')).toBe('PM으로');
    expect(withJosa('담당 AE', '으로/로')).toBe('담당 AE로');
    expect(withJosa('OFF', '으로/로')).toBe('OFF로');
    expect(withJosa('ON', '으로/로')).toBe('ON으로');
    expect(withJosa('1,370만', '으로/로')).toBe('1,370만으로');
    expect(withJosa('20%', '으로/로')).toBe('20%로');
    expect(withJosa('7', '으로/로')).toBe('7로');
    expect(withJosa('3', '으로/로')).toBe('3으로');
    expect(withJosa('서울', '으로/로')).toBe('서울로');
  });
  it('을/를 · 이/가 · 은/는 · 과/와', () => {
    expect(withJosa('반영', '을/를')).toBe('반영을');
    expect(withJosa('승인', '을/를')).toBe('승인을');
    expect(withJosa('롤백', '을/를')).toBe('롤백을');
    expect(withJosa('보류 해제', '을/를')).toBe('보류 해제를');
    expect(josa('키워드', '이/가')).toBe('가');
    expect(josa('입찰가', '은/는')).toBe('는');
    expect(josa('예산', '과/와')).toBe('과');
  });
  it('끝의 괄호 · 공백은 건너뛰고 본다', () => {
    expect(withJosa('직전 상태(860원)', '으로/로')).toBe('직전 상태(860원)으로');
    expect(josa('', '으로/로')).toBe('로');
  });
});
