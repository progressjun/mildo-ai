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
import { demoAiUsage, demoHistory, demoOnboarding, demoState, type AiUsageState, type ConfigState, type OnboardingState } from './model';
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
    aiUsage: { status: 'ok', usage: { ...demoAiUsage(), month: '2026-11', basis: '집계 기준: KST 2026-11-01 00:00부터' } },
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
      detect: ['이상 징후 기준', '공휴일', '당번 순번 대상', 'TF 역할', '주말 · 공휴일 당번 체계 강제 (평일 포함)', '꺼짐 · 평일은 담당 AE + 백업'],
      modules: ['사용 모듈', 'MILDO Board', '항상 표시'],
      ai: ['2026-11 AI 사용량', 'LIVE', '서버 키 연결됨', '745만 토큰 / 3,000만 토큰', '24.8% 사용', '용도별', 'MILDO Agent 대화', '최근 7일', '사용자별', 'AI 월 사용 한도', 'AI 사용', '집계 기준: KST'],
      impact: ['성과 증명 기준', '월 구독료 (회수 배수 분모)', '공헌이익률', '시간당 인건비', '회수 배수 = (측정 증분 이익', '12,500,000원', '125.0시간', '가정값'],
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

describe('AI 사용량 · 한도 · 성과 증명 기준', () => {
  it('데모 모드: 예시 사용량(TEST DATA) · 읽기 전용', async () => {
    const { WorkspaceScreen } = await import('./View');
    const html = await wrap(h(WorkspaceScreen, {
      mode: 'demo', workspaceName: '예시', state: demoState(), draft: {}, canConfigure: false, history: demoHistory(), hasMoreHistory: false,
      onboarding: demoOnboarding(), busy: null, error: null, serverIssues: [], remoteChanged: false, aiUsage: { status: 'demo', usage: demoAiUsage() }, handlers: HANDLERS, initialTab: 'ai',
    }));
    expect(html).toContain('TEST DATA');
    expect(html).toContain('예시(TEST DATA)입니다');
    expect(html).toContain('2026-10 AI 사용량');
    expect(html).not.toContain('<input');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('편집 중인 한도가 이번 달 사용량 이하이면 저장 전에 경고 · 한도 도달 · 불러오기 실패 · 불러오는 중', async () => {
    const low = await screen({ tab: 'ai', state: serverState({}), draft: { ai: { monthlyTokenLimit: 5_000_000 } } });
    expect(low).toContain('저장 전 한도 500만 토큰 기준 사용률 149%');
    expect(low).toContain('새 한도가 이번 달 사용량 이하입니다');
    const high = await screen({ tab: 'ai', state: serverState({}), draft: { ai: { monthlyTokenLimit: 50_000_000 } } });
    expect(high).toContain('저장하면 남은 토큰이');
    const over: AiUsageState = { status: 'ok', usage: { ...demoAiUsage(), limit: 7_000_000, remaining: 0, usedRatio: 1.06, budgetExceeded: true, enabled: true } };
    const ex = await screen({ tab: 'ai', aiUsage: over });
    expect(ex).toContain('한도 도달');
    expect(ex).toContain('기준: 입력 + 출력 토큰 ≥ 월 한도');
    const off = await screen({ tab: 'ai', aiUsage: { status: 'ok', usage: { ...demoAiUsage(), enabled: false, configured: false } } });
    expect(off).toContain('AI 사용 꺼짐');
    expect(off).toContain('서버 키 미설정');
    const err = await screen({ tab: 'ai', aiUsage: { status: 'error', usage: null, error: '권한이 없습니다' } });
    expect(err).toContain('사용량을 불러오지 못했습니다');
    expect(err).toContain('권한이 없습니다');
    expect(await screen({ tab: 'ai', aiUsage: { status: 'loading', usage: null } })).toContain('사용량을 불러오는 중입니다');
  });

  it('성과 증명 기준: 바꾼 값으로 1배 회수 조건을 다시 계산 · 탭 배지', async () => {
    const html = await screen({ tab: 'impact', state: serverState({}), draft: { billing: { monthlyFee: 6_000_000 }, impact: { contributionMargin: 0.3 } } });
    expect(html).toContain('20,000,000원');
    expect(html).toContain('150.0시간');
    expect(html).toContain('워크스페이스 값');
    expect(html).toMatch(/성과 증명 기준<span class="pill[^"]*"[^>]*>2</);
  });
});

describe('소유자 전용 · 브랜드 불일치 · 공휴일 입력', () => {
  it('월 구독료는 소유자만 입력 — PM(설정 권한)은 읽기 전용 표시, 다른 성과 증명 입력은 편집 가능', async () => {
    const pm = await screen({ tab: 'impact', state: serverState({}), draft: {}, canOwner: false });
    expect(pm).not.toMatch(/<input[^>]*id="ws-billing-monthlyFee"/);
    expect(pm).toContain('소유자만 바꿀 수 있어 읽기 전용입니다');
    expect(pm).toMatch(/<input[^>]*id="ws-impact-hourlyCost"/);
    const owner = await screen({ tab: 'impact', state: serverState({}), draft: {}, canOwner: true });
    expect(owner).toMatch(/<input[^>]*id="ws-billing-monthlyFee"/);
    expect(owner).not.toContain('소유자만 바꿀 수 있어 읽기 전용입니다');
  });

  it('워크스페이스 브랜드와 설정 브랜드명이 다르면 안내 + 한 번에 맞추기(설정 권한), 같으면 안내 없음 · 데모는 안내 없음', async () => {
    const diff = await screen({ tab: 'brand', state: serverState({}), draft: {}, workspaceBrand: '바른잠' });
    expect(diff).toContain('설정의 브랜드명(수면밀도 · 기본값)이 워크스페이스 브랜드(바른잠)와 다릅니다');
    expect(diff).toMatch(/브랜드명을 (&#x27;|')바른잠(&#x27;|')\(으\)로/);
    const ro = await screen({ tab: 'brand', state: serverState({}), draft: {}, workspaceBrand: '바른잠', canConfigure: false });
    expect(ro).toContain('워크스페이스 브랜드(바른잠)와 다릅니다');
    expect(ro).not.toMatch(/브랜드명을 (&#x27;|')바른잠/);
    expect(await screen({ tab: 'brand', state: serverState({}), draft: { brand: { name: '바른잠' } }, workspaceBrand: '바른잠' })).not.toContain('워크스페이스 브랜드(');
    expect(await screen({ tab: 'brand', state: serverState({}), draft: {}, workspaceBrand: '수면밀도' })).not.toContain('워크스페이스 브랜드(');
  });

  it('브랜드명 · 제품군 · 목표 CPA · 시간표 안내는 실제로 쓰는 곳만 말한다', async () => {
    const brand = await screen({ tab: 'brand', state: serverState({}), draft: {} });
    expect(brand).toContain('판정에는 쓰지 않습니다');
    const targets = await screen({ tab: 'targets', state: serverState({}), draft: {} });
    expect(targets).toContain('리포트 판정은 ROAS 기준이라 이 값을 쓰지 않습니다');
    const tt = await screen({ tab: 'timetable', state: serverState({}), draft: {} });
    expect(tt).toContain('기본 시각(07:00 · 14:00) 기준');
    expect(tt).not.toContain('MILDO Board 수집 기준 시각 표기');
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
