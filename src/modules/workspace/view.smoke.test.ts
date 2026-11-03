/**
 * 워크스페이스 설정 화면 렌더 (SSR) — 데모 모드(기본값 읽기 전용 · 안내 · 온보딩 예시), 서버 모드(편집 · 기본값/워크스페이스 값 · 기본값으로 ·
 * 배분 합계 실시간 확인 · 미리보기 · 이력 · 권한 없는 역할), 모든 탭. 화면 규칙: 하드코딩 색상 없음 · window.alert/confirm/prompt/open 없음.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mergeConfig, DEFAULT_CONFIG, type WorkspaceConfig } from '@/data/config';
import { demoHistory, demoOnboarding, demoState, type ConfigState, type OnboardingState } from './model';
import type { WorkspaceHandlers, WorkspaceScreenProps, WsTab } from './View';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

const noop = () => undefined;
const HANDLERS: WorkspaceHandlers = { onDraft: noop, onSave: async () => false, onDiscard: noop, onReview: noop, onReload: noop, onMoreHistory: noop };

function serverState(config: WorkspaceConfig, version = 3): ConfigState {
  return { ...demoState(), config, effective: mergeConfig(DEFAULT_CONFIG, config), version, updatedAt: '2026-11-02T01:00:00.000Z', updatedBy: { id: 'u1', name: '김PM' } };
}

async function screen(extra: Partial<WorkspaceScreenProps> & { tab?: WsTab } = {}): Promise<string> {
  const { WorkspaceScreen } = await import('./View');
  const saved = extra.state?.config ?? { targets: { roas: 500 } };
  return wrap(h(WorkspaceScreen, {
    mode: 'server', workspaceName: '수면밀도 퍼포먼스', state: serverState(saved), draft: saved, canConfigure: true,
    history: demoHistory(), hasMoreHistory: false, onboarding: { ...demoOnboarding(), firstRun: false }, busy: null, error: null, serverIssues: [], remoteChanged: false,
    handlers: HANDLERS, initialTab: extra.tab, ...extra,
  }));
}

describe('워크스페이스 설정 화면', () => {
  it('데모 모드: 기본값 읽기 전용 · 안내 · TEST DATA 온보딩 예시 · 입력 없음', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    for (const s of ['워크스페이스 설정', '기본값 보기 · 읽기 전용', '서버(MILDO OS Cloud)에 연결하지 않은 시연 모드', 'TEST DATA', '시작하기 · 1/4 완료', '데이터 연결', '팀 초대', '목표 · 예산 확인', '알림 채널', '브랜드명', '수면밀도', '베스트슬립', '기본값']) {
      expect(html, s).toContain(s);
    }
    expect(html).toContain('href="#connections"');
    expect(html).toContain('href="#notify"');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('변경 미리보기 · 저장');
    expect(html).not.toContain('기본값으로');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('서버 모드 · 설정 권한: 워크스페이스 값 표시 · 기본값으로 · 저장 바 · LIVE', async () => {
    const html = await screen({ tab: 'targets', draft: { targets: { roas: 500 }, safety: { dailyChangeCapPct: 15 } } });
    expect(html).toContain('LIVE');
    expect(html).toContain('버전 3');
    expect(html).toContain('김PM');
    expect(html).toContain('워크스페이스 값');
    expect(html).toContain('기본값으로');
    expect(html).toContain('기본값 <strong>400%</strong>');
    expect(html).toContain('저장하지 않은 변경 1건');
    expect(html).toContain('변경 미리보기 · 저장');
    expect(html).toMatch(/<input[^>]*id="ws-targets-roas"/);
    expect(html).toContain('고효율 = 목표 ROAS × 1.3 = 650% 이상');
    expect(html).not.toContain('기본값 보기 · 읽기 전용');
  });

  it('예산 배분: 합계 실시간 확인 · 저장 불가 안내 · 비례 맞추기', async () => {
    const draft: WorkspaceConfig = { budget: { allocation: { naver_sa: 0.5 } } };
    const html = await screen({ tab: 'budget', state: serverState({}), draft });
    expect(html).toContain('합계 107.0%');
    expect(html).toContain('매체 배분 합계가 100%가 아닙니다');
    expect(html).toContain('나머지를 기존 비율대로 맞추기');
    expect(html).toContain('저장 불가');
    expect(html).toContain('기준 100% ± 0.1%p');
    const ok = await screen({ tab: 'budget', state: serverState({}), draft: {} });
    expect(ok).toContain('합계 100%');
    expect(ok).not.toContain('매체 배분 합계가 100%가 아닙니다');
  });

  it('모든 탭이 그려진다 (위임 범위 표 · 시간표 · SLA · 감지 · 사용 모듈 · 이력)', async () => {
    const expectByTab: Record<WsTab, string[]> = {
      brand: ['경쟁사', 'SKU 진입점', '추가 브랜드 키워드'],
      budget: ['연 광고 예산', '네이버 SA'],
      targets: ['목표 ROAS', 'SAFETY', '대량 변경 차단'],
      approval: ['위임 범위', '일 예산 ±10% 이내 · 상태 점검', '광고주 승인'],
      timetable: ['데이터 시간표', '전일 데이터 수집·검증 완료', 'SLA (분)', 'P1 인지'],
      detect: ['이상 징후 기준', '공휴일', '당번 순번 대상', 'TF 역할'],
      modules: ['사용 모듈', 'MILDO Board', '항상 표시', 'AI 월 사용 한도', '월 구독료'],
      history: ['변경 이력', '목표 · 예산 확인', '일 조정 폭 상한: 15% → 20% (기본값으로)'],
    };
    for (const [tab, list] of Object.entries(expectByTab) as [WsTab, string[]][]) {
      const html = await screen({ tab });
      for (const s of list) expect(html, `${tab}: ${s}`).toContain(s);
      expect(html, tab).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it('위임 범위를 바꾸면 표가 새 폭으로 · 검증 오류는 항목 옆에', async () => {
    const html = await screen({ tab: 'approval', draft: { delegation: { aeMaxPct: 15, pmMaxPct: 40 } } });
    expect(html).toContain('일 예산 ±15% 이내 · 상태 점검');
    expect(html).toContain('40% 초과 · 신규 캠페인');
    const bad = await screen({ tab: 'approval', draft: { delegation: { aeMaxPct: 40 } } });
    expect(bad).toContain('PM 승인 상한(±30%)은 담당 AE 위임(±40%)보다 커야 합니다');
    expect(bad).toContain('확인할 항목 1개');
  });

  it('미리보기: 지금 → 저장 후 · 기본값으로 · 오류가 있으면 저장 막힘', async () => {
    const html = await screen({ initialPreview: true, draft: { targets: { roas: 550 }, safety: { dailyChangeCapPct: 15 } } });
    expect(html).toContain('변경 미리보기');
    expect(html).toContain('500%');
    expect(html).toContain('550%');
    expect(html).toContain('20% (기본값)');
    expect(html).toContain('2건 저장');
    const bad = await screen({ initialPreview: true, draft: { targets: { roas: 550 }, budget: { allocation: { naver_sa: 0.9 } } } });
    expect(bad).toContain('저장하기 전에 확인할 항목');
    expect(bad).toMatch(/<button[^>]*disabled[^>]*>(<svg[^]*?<\/svg>)?\d+건 저장/);
  });

  it('설정 권한 없는 역할: 읽기 전용 안내 · 입력 · 저장 바 없음', async () => {
    const html = await screen({ canConfigure: false, tab: 'targets' });
    expect(html).toContain('읽기 전용');
    expect(html).toContain('PM · 관리자 · 소유자만');
    expect(html).not.toContain('변경 미리보기 · 저장');
    expect(html).not.toMatch(/<input[^>]*id="ws-targets-roas"/);
  });

  it('첫 실행이면 온보딩 카드(기본값 그대로 확인 버튼), 아니면 남은 설정 요약 · 다른 사용자 저장 · 무시된 저장값 안내', async () => {
    const first: OnboardingState = { ...demoOnboarding(), firstRun: true };
    const html = await screen({ onboarding: first, state: serverState({}), draft: {} });
    expect(html).toContain('시작하기 · 1/4 완료');
    expect(html).toContain('기본값 그대로 확인');
    const later = await screen({ remoteChanged: true, state: { ...serverState({}), invalid: [{ path: 'targets.roas', message: '50 이상이어야 합니다' }] }, draft: {} });
    expect(later).toContain('남은 설정 3개');
    expect(later).toContain('다른 사용자가 설정을 저장했습니다');
    expect(later).toContain('저장된 값 중 1개 항목을 무시하고 기본값을 쓰는 중입니다');
    expect(later).not.toContain('시작하기 · ');
  });
});

describe('화면 규칙', () => {
  const dir = join(process.cwd(), 'src/modules/workspace');
  const files = readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts'));
  it('하드코딩 색상 없음 · window.alert/confirm/prompt/open 없음 · 번호 목록 태그 없음', () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^\n]*href)/);
      expect(src, f).not.toMatch(/\b(window\.)?(alert|confirm|prompt)\(/);
      expect(src, f).not.toMatch(/window\.open\(/);
      expect(src, f).not.toMatch(/<ol[\s>]/);
    }
  });
});
