import { describe, expect, it } from 'vitest';
import { sanitizeSaved } from './store';

const change = { id: 'c1', status: 'pending', target: 'SA_일반', approver: 'PM', history: [], module: 'adpilot', kind: 'bid', before: 1, after: 2, reason: 'r', requestedBy: 'PM', createdAt: '2026-10-31T06:00:00.000Z' };
const incident = { id: 'i1', status: 'open', severity: 'P1', title: 't', timeline: [], causeCandidates: [], impact: {}, ruleId: 'x', detectedAt: '', occurredAt: '', detectPath: '', isTest: false, autoActions: [] };

describe('저장본 검증 (mildo-os/v1)', () => {
  it('형식이 다른 JSON(이전 버전 · 손상)은 기본값으로 — 화면이 깨지지 않는다', () => {
    const s = sanitizeSaved({ changes: 'x', incidents: { a: 1 }, comments: null, ai: 5, role: 'hacker', tf: [] });
    expect(s.changes).toBeUndefined();
    expect(s.incidents).toBeUndefined();
    expect(s.comments).toBeUndefined();
    expect(s.role).toBeUndefined();
    expect(s.tf).toBeUndefined();
    expect(sanitizeSaved(null)).toEqual({});
    expect(sanitizeSaved('text')).toEqual({});
    expect(sanitizeSaved([1, 2])).toEqual({});
  });
  it('배열 안의 형식이 다른 항목만 걸러내고 정상 항목은 유지', () => {
    const s = sanitizeSaved({ changes: [change, null, 3, { id: 'bad' }], incidents: [incident, { id: 'i2', status: 'open' }], comments: [{ id: 'm', target: 'daily', text: 'ok', author: 'AE', at: '' }, {}] });
    expect(s.changes?.map((c) => c.id)).toEqual(['c1']);
    expect(s.incidents?.map((i) => i.id)).toEqual(['i1']);
    expect(s.comments?.length).toBe(1);
  });
  it('역할 · AI 설정은 허용 값만', () => {
    expect(sanitizeSaved({ role: '담당 AE' }).role).toBe('담당 AE');
    expect(sanitizeSaved({ role: '수면밀도' }).role).toBe('수면밀도');
    expect(sanitizeSaved({ ai: { mode: 'weird', apiKey: 3, model: '' } }).ai).toEqual({});
    expect(sanitizeSaved({ ai: { mode: 'offline', apiKey: 'k', model: 'claude-sonnet-5-5' } }).ai).toEqual({ mode: 'offline', apiKey: 'k', model: 'claude-sonnet-5-5' });
  });
});
