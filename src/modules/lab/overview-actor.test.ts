/**
 * MILDO Lab 개요 — 서버 모드 열람자를 데모 역할('담당 AE')로 세지 않는다 (재검증 QA 잔여 항목).
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/core/types';
import { DEMO } from '@/data/demo';
import { labOverview } from './engine';

const pending = (id: string, approver: ChangeRequest['approver']): ChangeRequest => ({
  id, createdAt: '2026-11-03T01:00:00.000Z', module: 'lab', kind: 'keyword_add', target: `등록 ${id}`, targetId: `labreg:${id}`,
  before: '미등록', after: 'PROBLEM_TEST · 입찰 상한 900원', reason: 'QA', requestedBy: '김AE', approver, status: 'pending', history: [],
});
const changes = [pending('a', 'AE'), pending('b', 'AE'), pending('c', 'PM')];
const mineTodo = (ov: ReturnType<typeof labOverview>) => JSON.stringify(ov).match(/현재 역할\(([^)]*)\)이 승인할 Lab 요청 (\d+)건/);

describe('labOverview · 승인 대기 판정 주체', () => {
  it('서버 열람자: 내 승인 0건 · 할 일 문구 없음 / 담당 AE 멤버: AE 건 2건 · 멤버십 역할 이름', () => {
    const viewer = labOverview(DEMO, changes, null, [], {}, { role: { member: 'viewer' } });
    expect(mineTodo(viewer)).toBeNull();
    const ae = labOverview(DEMO, changes, null, [], {}, { role: { member: 'ae' } });
    const m = mineTodo(ae);
    expect(m?.[2]).toBe('2');
    expect(m?.[1]).toBe('담당 AE');
    const pm = labOverview(DEMO, changes, null, [], {}, { role: { member: 'pm' } });
    expect(mineTodo(pm)?.[2]).toBe('3');
  });
  it('데모 역할 문자열은 그대로 (담당 AE → AE 건 2건)', () => {
    const demo = labOverview(DEMO, changes, null, [], {}, { role: '담당 AE' });
    expect(mineTodo(demo)?.[2]).toBe('2');
    expect(mineTodo(demo)?.[1]).toBe('담당 AE');
  });
});
