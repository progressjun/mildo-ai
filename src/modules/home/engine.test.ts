import { describe, expect, it } from 'vitest';
import { DEMO } from '@/data/demo';
import { buildTimetable } from '@/modules/reports/engine';
import { homeTimetable, scenarioBudget, scenarioPending, scenarioRequests, untilLabel } from './engine';
import type { ChangeRequest } from '@/core/types';

describe('커맨드 센터 시간표 — 리포트 · 데이터 시간표 화면과 같은 계산', () => {
  it('토요일(10/31) 이슈 브리핑은 완료가 아니라 다음 영업일 09:30으로 이동', () => {
    const t = homeTimetable(DEMO);
    expect(t.off).toBe(true);
    const brief = t.items.find((i) => i.time === '09:30')!;
    expect(brief.state).not.toBe('done');
    expect(brief.label).toContain('09:30');
    expect(brief.offNote).toBeTruthy();
    const rt = buildTimetable(DEMO, {});
    for (const i of t.items) {
      const r = rt.items.find((x) => x.time === i.time)!;
      expect(i.state === 'done').toBe(r.status === 'done');
    }
  });
  it('남은 시간 문구', () => {
    expect(untilLabel(60)).toBe('1시간 후');
    expect(untilLabel(45)).toBe('45분 후');
    expect(untilLabel(65)).toBe('1시간 5분 후');
    expect(untilLabel(0)).toBe('곧');
    expect(untilLabel(NaN)).toBe('곧');
  });
});

describe('p.23 작동 시나리오 승인 요청', () => {
  it('GFA 예산 +12%: 표시 변경 폭과 금액이 일치 · 위임 범위 PM', () => {
    const b = scenarioBudget(800000);
    expect(b.after).toBe(896000);
    expect(b.changePct).toBe(12);
    expect(b.approver).toBe('PM');
    expect(scenarioBudget(0).changePct).toBe(0);
  });
  it('요청 2건: Lab keyword_add(담당 AE) · GFA budget(PM)', () => {
    const r = scenarioRequests(DEMO);
    expect(r.map((x) => `${x.module}:${x.kind}:${x.approver}`)).toEqual(['lab:keyword_add:AE', 'gfa:budget:PM']);
    const gfa = r[1];
    expect(Math.round(((Number(gfa.after) - Number(gfa.before)) / Number(gfa.before)) * 1000) / 10).toBe(gfa.changePct);
  });
  it('승인 대기 중이면 다시 만들지 않는다', () => {
    const mk = (status: ChangeRequest['status']) => ({ ...scenarioRequests(DEMO)[0], id: 'x', createdAt: '', history: [], status }) as ChangeRequest;
    expect(scenarioPending([])).toBe(false);
    expect(scenarioPending([mk('pending')])).toBe(true);
    expect(scenarioPending([mk('approved')])).toBe(false);
  });
});
