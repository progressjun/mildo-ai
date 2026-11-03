/** 매체 반영 실행 상태 표시 (서버 모드 change.executing · change.execution) — 라벨 · 근거 · 진행 중 판정 · 시도 요약 · 렌더 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';
import { attemptLine, executionState, isExecuting, kstStamp, providerLabel, requestPreview, type ServerChangeView } from './execution';
import { ExecBadge, ExecutionPanel } from './ExecutionPanel';

const base: ChangeRequest = {
  id: 'chg_1', createdAt: '2026-11-02T01:00:00Z', module: 'adpilot', kind: 'bid', target: '수면밀도 매트리스', before: 700, after: 770, changePct: 10,
  reason: '순위 방어', requestedBy: 'PM', approver: 'PM', status: 'applied', history: [],
};
const withEx = (execution: ServerChangeView['execution'], extra: Partial<ServerChangeView> = {}): ServerChangeView => ({ ...base, execution, ...extra });

describe('실행 상태 라벨', () => {
  it('데모 모드(실행 정보 없음) → 표시하지 않음', () => {
    expect(executionState(base)).toBeNull();
    expect(isExecuting(base)).toBe(false);
    expect(renderToString(h(ExecBadge, { c: base }))).toBe('');
    expect(renderToString(h(ExecutionPanel, { c: base }))).toBe('');
  });
  it("dry_run → '매체 미반영 (dry-run 기록)' · 근거에 쓰기 모드 · 매체 · KST 시각", () => {
    const s = executionState(withEx({ mode: 'dry_run', ok: true, at: '2026-11-02T05:07:00Z', provider: 'naver_sa' }))!;
    expect(s).toMatchObject({ kind: 'dry_run', label: '매체 미반영 (dry-run 기록)', tone: 'warning' });
    expect(s.basis).toContain('dry_run');
    expect(s.basis).toContain('네이버 검색광고');
    expect(s.basis).toContain('11/2 14:07 기록');
    expect(s.basis).toContain('live를 켭니다');
  });
  it("live 성공 → '매체 반영됨'(반영 값), 실패 → '매체 반영 실패'(오류)", () => {
    const ok = executionState(withEx({ mode: 'live', ok: true, at: '2026-11-02T05:00:00Z', provider: 'google_ads', appliedValue: 770 }))!;
    expect(ok).toMatchObject({ kind: 'live', label: '매체 반영됨', tone: 'good' });
    expect(ok.basis).toContain('반영 값 770');
    expect(ok.basis).toContain('Google Ads');
    const bad = executionState(withEx({ mode: 'live', ok: false, at: '2026-11-02T05:00:00Z', provider: 'meta', error: '권한이 없습니다 (#200)' }))!;
    expect(bad).toMatchObject({ kind: 'live_failed', label: '매체 반영 실패', tone: 'critical' });
    expect(bad.basis).toContain('#200');
  });
  it("none → '기록만' (서버 사유 우선)", () => {
    expect(executionState(withEx({ mode: 'none', ok: true, at: 'x', reason: '알림 기준 변경 — 매체 API 대상 아님' }))).toMatchObject({ kind: 'none', label: '기록만' });
    expect(executionState(withEx({ mode: 'none', ok: true, at: 'x', reason: '알림 기준 변경 — 매체 API 대상 아님' }))!.basis).toContain('매체 API 대상 아님');
    expect(executionState(withEx({ mode: 'none', ok: true, at: 'x' }))!.basis).toContain('상태만 기록');
  });
  it("executing → '반영 중' (실행 기록보다 우선) · 백그라운드 처리 안내 · 롤백 단계", () => {
    const c = withEx({ mode: 'dry_run', ok: true, at: 'x' }, { status: 'approved', executing: { phase: 'apply', since: '2026-11-02T05:00:00Z', background: true } });
    const s = executionState(c)!;
    expect(s).toMatchObject({ kind: 'executing', label: '반영 중', tone: 'accent' });
    expect(s.basis).toContain('11/2 14:00 시작');
    expect(s.basis).toContain('백그라운드');
    expect(isExecuting(c)).toBe(true);
    expect(executionState({ executing: { phase: 'rollback', since: '2026-11-02T05:00:00Z' } })!.basis).toMatch(/^롤백 진행 중/);
  });
  it('알 수 없는 mode는 표시하지 않음 · 매체 이름 · KST 시각 · 요청 미리보기 자르기', () => {
    expect(executionState(withEx({ mode: 'weird' as never, ok: true, at: 'x' }))).toBeNull();
    expect(providerLabel('kakao_moment')).toBe('카카오모먼트');
    expect(providerLabel('unknown_x')).toBe('unknown_x');
    expect(providerLabel(undefined)).toBe('');
    expect(kstStamp('2026-11-02T15:30:00Z')).toBe('11/3 00:30');
    expect(kstStamp('bad')).toBe('');
    expect(requestPreview(null)).toBeNull();
    expect(requestPreview({ method: 'PUT', path: '/ncc/keywords/nkw-1' })).toContain('"method": "PUT"');
    expect(requestPreview('x'.repeat(50), 10)).toContain('40자 생략');
  });
  it('시도 기록 한 줄: 시각 · 단계 · 방식(성공/실패) · 매체 · 대상 · 실행자 · 오류', () => {
    expect(attemptLine({ id: 1, phase: 'apply', mode: 'dry_run', ok: true, provider: 'naver_sa', targetExternalId: 'nkw-1', actor: '김PM', finishedAt: '2026-11-02T05:07:00Z' }))
      .toEqual({ text: '11/2 14:07 · 반영 · dry-run 기록 · 네이버 검색광고 · 대상 nkw-1 · 김PM', tone: 'warning' });
    expect(attemptLine({ id: 2, phase: 'rollback', mode: 'live', ok: false, provider: 'meta', error: '토큰 만료', startedAt: '2026-11-02T05:00:00Z' }))
      .toEqual({ text: '11/2 14:00 · 롤백 · 매체 호출 실패 · Meta · 토큰 만료', tone: 'critical' });
    expect(attemptLine({ id: 3, mode: 'live', ok: true }).tone).toBe('good');
  });
});

describe('렌더 (SSR)', () => {
  it('목록 배지: 라벨 + 근거 툴팁, 상세 패널: 실행 방식 · 매체 · 시각 · 보낼 요청', () => {
    const c = withEx({ mode: 'dry_run', ok: true, at: '2026-11-02T05:07:00Z', provider: 'naver_sa', request: { method: 'PUT', path: '/ncc/keywords/nkw-1', body: { bidAmt: 770 } } });
    const badge = renderToString(h(ExecBadge, { c })).replace(/<!-- -->/g, '');
    expect(badge).toContain('매체 미반영 (dry-run 기록)');
    expect(badge).toContain('data-exec="dry_run"');
    expect(badge).toMatch(/title="[^"]*dry_run/);
    const panel = renderToString(h(ExecutionPanel, { c })).replace(/<!-- -->/g, '');
    expect(panel).toContain('매체 반영 · 서버 실행 기록');
    expect(panel).toContain('dry_run (요청만 기록 · 매체 미호출)');
    expect(panel).toContain('네이버 검색광고');
    expect(panel).toContain('보낼 요청 내용 (dry-run · 비밀값 제외)');
    expect(panel).toContain('bidAmt');
    expect(panel).not.toMatch(/\b1\.\s/);
  });
  it('반영 중 패널: 진행 단계 · 시작 시각', () => {
    const panel = renderToString(h(ExecutionPanel, { c: withEx(undefined, { status: 'approved', executing: { phase: 'apply', since: '2026-11-02T05:00:00Z', background: false } }) })).replace(/<!-- -->/g, '');
    expect(panel).toContain('반영 중');
    expect(panel).toContain('반영 · 11/2 14:00 시작');
  });
});
