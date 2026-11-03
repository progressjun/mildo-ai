/** 워크스페이스 설정 화면 모델 — 필드 상태 · 예산 배분 합계 · 비례 맞춤 · 미리보기 · 사용 모듈 id 동기화 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, KNOWN_MODULE_IDS, parseWorkspaceConfig, setOverride, type WorkspaceConfig } from '@/data/config';
import { MODULES } from '@/modules/registry';
import { DEFAULT_HOURLY_COST, DEFAULT_MARGIN, DEFAULT_MONTHLY_FEE } from '@/modules/impact/engine';
import {
  aiUsageView, allocationRows, demoAiUsage, demoHistory, demoOnboarding, demoState, draftIssues, fieldState, fmtKst, historyChangeText, impactBasis, issueFor, normalizeAllocation,
  overrideCount, pctText, previewChanges, purposeLabel,
} from './model';
import { mergeConfig } from '@/data/config';

describe('필드 상태', () => {
  it('덮어쓰지 않은 항목은 기본값, 덮어쓴 항목은 값 · 기본값 표기를 함께', () => {
    const d: WorkspaceConfig = { targets: { roas: 520 } };
    expect(fieldState(d, 'targets.roas')).toEqual({ value: 520, defaultValue: 400, overridden: true, defaultText: '400%' });
    expect(fieldState(d, 'targets.brandRoas')).toMatchObject({ value: 800, overridden: false });
    expect(fieldState({}, 'sla.P3.actionMin')).toMatchObject({ value: null, defaultText: '협의 · 기본 문구' });
    expect(overrideCount({ targets: { roas: 1 }, safety: { dailyChangeCapPct: 2 }, brand: { name: 'x' } }, ['targets', 'safety'])).toBe(2);
  });

  it('검증 사유를 경로로 찾는다 (상위 · 하위 경로 포함)', () => {
    const issues = draftIssues({ budget: { allocation: { naver_sa: 0.6 } }, targets: { roas: 10 } });
    expect(issueFor(issues, 'targets.roas')).toBe('50 이상이어야 합니다');
    expect(issueFor(issues, 'budget.allocation')).toContain('100%');
    expect(issueFor(issues, 'budget.allocation.naver_sa')).toContain('100%');
    expect(issueFor(issues, 'budget')).toContain('100%');
    expect(issueFor(issues, 'safety.dailyChangeCapPct')).toBeNull();
  });
});

describe('예산 배분', () => {
  it('합계 · 차이(%p) · 매체 연 · 월 예산', () => {
    const base = allocationRows({});
    expect(base.ok).toBe(true);
    expect(base.rows.find((r) => r.id === 'naver_sa')).toMatchObject({ share: 0.43, annual: 2_150_000_000, monthly: Math.round(2_150_000_000 / 12), overridden: false, label: '네이버 SA' });
    const over = allocationRows({ budget: { annual: 6_000_000_000, allocation: { naver_sa: 0.5 } } });
    expect(over.ok).toBe(false);
    expect(over.gapPp).toBe(7);
    expect(over.rows.find((r) => r.id === 'naver_sa')!.annual).toBe(3_000_000_000);
  });

  it('한 매체를 고정하고 나머지를 비례로 맞추면 합계 100%이고 검증을 통과한다', () => {
    const alloc = { ...DEFAULT_CONFIG.budget.allocation, naver_sa: 0.6 };
    const n = normalizeAllocation(alloc, 'naver_sa');
    expect(n.naver_sa).toBe(0.6);
    expect(Object.values(n).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(n.naver_gfa).toBeGreaterThan(n.kakao);
    expect(parseWorkspaceConfig({ budget: { allocation: n } }).errors).toEqual([]);
    const zero = normalizeAllocation({ naver_sa: 1, naver_gfa: 0, google: 0, meta: 0, kakao: 0, vertical: 0 }, 'naver_gfa');
    expect(Object.values(zero).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  });
});

describe('저장 전 미리보기', () => {
  it('값 차이 · 기본값으로 · 출처만 바뀐 항목', () => {
    const saved: WorkspaceConfig = { targets: { roas: 500 }, safety: { dailyChangeCapPct: 15 } };
    let draft = setOverride(saved, 'targets.roas', 550);
    draft = { ...draft, safety: undefined } as WorkspaceConfig;
    draft = setOverride(draft, 'delegation.aeMaxPct', 10);
    const rows = previewChanges(saved, draft);
    expect(rows).toEqual([
      { path: 'targets.roas', label: '목표 ROAS', before: '500%', after: '550%', toDefault: false, sourceOnly: false },
      { path: 'safety.dailyChangeCapPct', label: '일 조정 폭 상한', before: '15%', after: '20% (기본값)', toDefault: true, sourceOnly: false },
      { path: 'delegation.aeMaxPct', label: '담당 AE 위임 (일 예산 변경 폭)', before: '10% (기본값)', after: '10%', toDefault: false, sourceOnly: true },
    ]);
    expect(previewChanges(saved, saved)).toEqual([]);
  });
});

describe('예시 상태 · 표시', () => {
  it('데모 상태 = 기본값 · 이력 · 온보딩 예시', () => {
    const s = demoState();
    expect(s.effective).toEqual(DEFAULT_CONFIG);
    expect(s.config).toEqual({});
    expect(demoHistory()[0].action).toBe('config.review');
    expect(historyChangeText(demoHistory()[1].changes[0])).toBe('일 조정 폭 상한: 15% → 20% (기본값으로)');
    const o = demoOnboarding();
    expect(o.firstRun).toBe(true);
    expect(o.steps.map((x) => x.href)).toEqual(['#connections', '#team', '#workspace', '#notify']);
    expect(fmtKst('2026-11-02T00:10:00.000Z')).toBe('2026.11.02 09:10');
    expect(fmtKst(null)).toBe('—');
  });

  it('성과 증명 입력 기본값이 impact 엔진과 같다', () => {
    expect(DEFAULT_CONFIG.billing.monthlyFee).toBe(DEFAULT_MONTHLY_FEE);
    expect(DEFAULT_CONFIG.impact).toEqual({ contributionMargin: DEFAULT_MARGIN, hourlyCost: DEFAULT_HOURLY_COST });
    expect(parseWorkspaceConfig({ impact: { contributionMargin: 0.3, hourlyCost: 50_000 } }).errors).toEqual([]);
    expect(parseWorkspaceConfig({ impact: { contributionMargin: 3 } }).errors[0].path).toBe('impact.contributionMargin');
  });

  it('사용 모듈 id 목록이 레지스트리와 같다 (모듈이 늘면 config.ts도 갱신)', () => {
    expect([...KNOWN_MODULE_IDS].sort()).toEqual(MODULES.map((m) => m.id).sort());
  });
});

describe('AI 사용량 · 성과 증명 기준', () => {
  it('사용률 판정(기준 포함) · 편집 중 한도 · 용도별 비중 · 최근 7일', () => {
    const u = demoAiUsage();
    const v = aiUsageView(u);
    expect(v.used).toBe(7_452_000);
    expect(pctText(v.usedRatio)).toBe('24.8%');
    expect(v.tone).toBe('accent');
    expect(v.verdict).toContain('기준');
    expect(v.draftLimit).toBeNull();
    expect(v.purposes[0]).toMatchObject({ purpose: 'agent', label: 'MILDO Agent 대화' });
    expect(v.purposes.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1, 6);
    expect(v.recentDaily).toHaveLength(7);
    expect(v.users[0].name).toBe('담당 AE (예시)');
    const low = aiUsageView(u, 7_000_000);
    expect(low).toMatchObject({ draftLimit: 7_000_000, draftBlocksNow: true, tone: 'critical' });
    expect(aiUsageView(u, 9_000_000)).toMatchObject({ draftBlocksNow: false, tone: 'warning' });
    expect(aiUsageView({ ...u, limit: 0 }).usedRatio).toBe(Infinity);
    expect(pctText(Infinity)).toBe('한도 0');
    expect(aiUsageView({ ...u, enabled: false }).verdict).toContain('AI 사용 꺼짐');
    expect(aiUsageView({ ...u, budgetExceeded: true }).verdict).toContain('한도 도달');
    expect(purposeLabel('adpilot:json')).toBe('adpilot · 구조화 분석');
    expect(purposeLabel('')).toBe('기타');
  });

  it('1배 회수 조건 = 구독료 · 구독료 ÷ 공헌이익률 · 구독료 ÷ 시간당 인건비', () => {
    expect(impactBasis(DEFAULT_CONFIG)).toEqual({ monthlyFee: 5_000_000, margin: 0.4, hourlyCost: 40_000, breakEvenValue: 5_000_000, breakEvenRevenue: 12_500_000, breakEvenHours: 125 });
    expect(impactBasis(mergeConfig(DEFAULT_CONFIG, { impact: { hourlyCost: 0 } })).breakEvenHours).toBeNull();
  });
});
