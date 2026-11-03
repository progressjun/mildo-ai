import { afterEach, describe, expect, it } from 'vitest';
import { applyWorkspaceConfig } from '@/data/config';
import { dailyBatchTime } from './data';
import { collectionSummary } from './engine';
import { DEMO } from '@/data/demo';

afterEach(() => applyWorkspaceConfig(null));

describe('Board 시간표 — 워크스페이스 설정을 호출 시점에 읽는다', () => {
  it('timetable.collect를 바꾸면 일 배치 기준 시각이 따라가고, null이면 기본값으로', () => {
    expect(dailyBatchTime()).toBe('07:00');
    applyWorkspaceConfig({ timetable: { collect: '06:30' } } as never);
    expect(dailyBatchTime()).toBe('06:30');
    applyWorkspaceConfig(null);
    expect(dailyBatchTime()).toBe('07:00');
  });

  it('수집 현황 요약의 배치 시각도 설정값을 쓴다', () => {
    applyWorkspaceConfig({ timetable: { collect: '06:30' } } as never);
    const s = collectionSummary(DEMO);
    expect(s.batchTime).toBe('06:30');
  });
});
