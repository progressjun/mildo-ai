/**
 * 워크스페이스 설정 변경 → 열린 AD Pilot이 새 공식 기준으로 다시 계산 (QA G1a: 다른 사용자가 목표 ROAS를 480%로 저장한 뒤에도
 * 열린 화면은 '공식 기준 목표 ROAS 400%'를 유지하면서 '새 설정으로 계산합니다' 안내만 떴다).
 *
 * 원인: 공식 기준 메모(useMemo)가 changes만 의존 — applyWorkspaceConfig가 기본값을 제자리 갱신해도 다시 계산하지 않았다.
 * 서버 렌더(SSR)는 렌더마다 훅 상태가 새로 시작하므로, 여기서는 useMemo를 '렌더 사이에 값을 유지하는' 구현으로 바꿔
 * 실제 화면처럼 같은 컴포넌트가 다시 그려지는 상황을 재현한다 (호출 순서별 캐시 · 의존성 Object.is 비교 = React 규칙).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { ChangeRequest } from '@/core/types';

const memo = vi.hoisted(() => ({ cache: [] as { deps: unknown[]; value: unknown }[], i: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useMemo = <T,>(fn: () => T, deps?: readonly unknown[]): T => {
    const k = memo.i++;
    const c = memo.cache[k];
    if (c && deps && c.deps.length === deps.length && c.deps.every((d, j) => Object.is(d, deps[j]))) return c.value as T;
    const value = fn();
    memo.cache[k] = { deps: [...(deps ?? [])], value };
    return value;
  };
  return { ...actual, default: { ...actual, useMemo }, useMemo };
});

import { applyWorkspaceConfig } from '@/data/config';
import { SaasTestProvider } from '@/saas/context';
import { useOfficialConfig } from './useAdPilot';
import type { AdPilotConfig } from './engine';

afterAll(() => applyWorkspaceConfig(null));
beforeEach(() => { memo.cache.length = 0; memo.i = 0; applyWorkspaceConfig(null); });

const CHANGES: ChangeRequest[] = []; // 같은 참조 (설정만 바뀌는 상황)
let got: AdPilotConfig | null = null;
function Probe() { got = useOfficialConfig(CHANGES); return null; }
const draw = (config: Record<string, unknown> | null) => {
  memo.i = 0;
  renderToString(h(SaasTestProvider, { value: { mode: 'server', role: 'pm', config }, children: h(Probe) }));
  return got!;
};

describe('AD Pilot 공식 기준 · 워크스페이스 설정 변경 반영', () => {
  it('설정이 바뀌면(config 이벤트 → 다시 적용) 같은 changes여도 새 목표 ROAS로 다시 계산한다', () => {
    const cfgA = { targets: { roas: 400 } };
    applyWorkspaceConfig(cfgA);
    const first = draw(cfgA);
    expect(first.targetRoas).toBe(400);
    // 설정이 그대로면 다시 계산하지 않는다 (같은 객체)
    expect(draw(cfgA)).toBe(first);

    const cfgB = { targets: { roas: 480 } };
    applyWorkspaceConfig(cfgB); // 플랫폼이 config 이벤트 뒤 하는 일 (GET /api/w/:ws → applyWorkspaceConfig → detail 갱신)
    expect(draw(cfgB).targetRoas).toBe(480);
  });
});
