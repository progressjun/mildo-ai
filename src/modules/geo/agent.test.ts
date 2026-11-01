/**
 * SearchTuneOS 에이전트 도구 · 오프라인 브리프 테스트.
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '@/core/store';
import type { ChangeRequest } from '@/core/types';
import type { ToolContext } from '../types';
import { DEMO } from '@/data/demo';
import { briefToMarkdown } from '@/ai/prompts';
import { agentKit } from './agent';

function ctx(changes: ChangeRequest[] = []): { ctx: ToolContext; created: ChangeRequest[] } {
  const created: ChangeRequest[] = [];
  const state: AppState = {
    data: DEMO, changes, incidents: [], toasts: [], comments: [],
    ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' }, role: 'PM', offHoursMode: false, tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  const actions = {
    addChange: (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'>) => {
      const ch = { ...c, id: `chg_${created.length}`, createdAt: '2026-10-31T15:30:00+09:00', history: [], status: 'pending' } as ChangeRequest;
      created.push(ch);
      return ch;
    },
  } as unknown as ToolContext['actions'];
  return { ctx: { state, actions, navigate: () => undefined }, created };
}
const run = async (c: ToolContext, name: string, inp: Record<string, unknown> = {}) => {
  const t = agentKit.tools(c).find((x) => x.name === name)!;
  return JSON.parse(JSON.stringify(await t.execute(inp))) as Record<string, any>;
};

describe('geo agent kit', () => {
  it('도구 6개 · 이름 규칙 geo_* · 브리프 4개', () => {
    const tools = agentKit.tools(ctx().ctx);
    expect(tools.map((t) => t.name)).toEqual(['geo_visibility', 'geo_audit_page', 'geo_faq', 'geo_paid_surface', 'geo_parse_answer', 'geo_request_keyword']);
    for (const t of tools) {
      expect(t.name).toMatch(/^geo_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(agentKit.briefs!.length).toBeGreaterThanOrEqual(2);
  });

  it('필수 입력 없는 도구: 입력 없이 실행 · 32KB 이하 · NaN 없음 · TEST DATA 표기', async () => {
    for (const t of agentKit.tools(ctx().ctx)) {
      if (t.inputSchema?.required?.length) continue;
      const s = JSON.stringify(await t.execute({}));
      expect(s.length, t.name).toBeLessThan(32_000);
      expect(s, t.name).not.toMatch(/NaN|Infinity/);
      expect(s, t.name).toContain('TEST DATA');
    }
  });

  it('geo_visibility: 엔진 · 의도 필터, 질의별 판정 · 경쟁사 우위', async () => {
    const all = await run(ctx().ctx, 'geo_visibility');
    expect(all.엔진).toHaveLength(5);
    expect(all.질의).toHaveLength(20);
    expect(all.진단일).toBe('2026-10-26');
    expect(all.경쟁사우위질의.length).toBeGreaterThan(0);
    const life = await run(ctx().ctx, 'geo_visibility', { intent: 'life', engine: 'naver_ai', round: 0 });
    expect(life.진단일).toBe('2026-10-05');
    expect(life.질의.every((q: { 의도: string }) => q.의도 === 'life')).toBe(true);
    expect(life.질의[0]).toHaveProperty('naver_ai');
    const bad = await run(ctx().ctx, 'geo_visibility', { round: 99, intent: 'x' });
    expect(bad.진단일).toBe('2026-10-26');
    expect(bad.질의).toHaveLength(20);
  });

  it('geo_audit_page: 샘플(결함/개선) · 입력 HTML', async () => {
    const defect = await run(ctx().ctx, 'geo_audit_page');
    expect(defect.점수).toBeLessThan(60);
    expect(defect.항목.find((c: { id: string }) => c.id === 'availability').판정).toBe('실패');
    const fixed = await run(ctx().ctx, 'geo_audit_page', { variant: 'fixed' });
    expect(fixed.점수).toBeGreaterThanOrEqual(85);
    const custom = await run(ctx().ctx, 'geo_audit_page', { html: '<html><head><title>수면밀도 매트리스 퀸 사이즈 안내</title></head><body><h1>x</h1></body></html>' });
    expect(custom.출처).toContain('입력 HTML');
    expect(custom.항목.find((c: { id: string }) => c.id === 'title').판정).toBe('통과');
  });

  it('geo_faq: 주제 필터 · JSON-LD 포함/제외', async () => {
    const all = await run(ctx().ctx, 'geo_faq');
    expect(JSON.parse(all.FAQPage_JSON_LD)['@type']).toBe('FAQPage');
    expect(all.집계.핵심주제충족).toBe('4/4');
    const size = await run(ctx().ctx, 'geo_faq', { topics: ['size'], includeJsonLd: false });
    expect(size.문항.every((i: { 주제: string }) => i.주제 === '사이즈')).toBe(true);
    expect(size).not.toHaveProperty('FAQPage_JSON_LD');
  });

  it('geo_paid_surface: 판정 · 요청 가능 표시', async () => {
    const r = await run(ctx().ctx, 'geo_paid_surface', { onlyActions: true });
    expect(r.질의.every((q: { 판정: string }) => q.판정 !== '유지 · 정기 진단')).toBe(true);
    expect(r.질의.find((q: { 질의: string }) => q.질의 === '킹 매트리스 추천').판정).toBe('랜딩 점검 우선');
    expect(r.질의.some((q: { SA반영요청가능: boolean }) => q.SA반영요청가능)).toBe(true);
  });

  it('geo_parse_answer: 언급 · 순서 · 경쟁사', async () => {
    const r = await run(ctx().ctx, 'geo_parse_answer', { text: '퀵슬립, 수면밀도 순으로 언급됩니다', query: 'q' });
    expect(r).toMatchObject({ 언급: true, 순서: 2, 경쟁사: ['퀵슬립'] });
  });

  it('geo_request_keyword: 후보만 pending 생성 (담당 AE) · 비후보 · 중복 거절', async () => {
    const { ctx: c, created } = ctx();
    const ok = await run(c, 'geo_request_keyword', { query: '매트리스 경도 고르는 법' });
    expect(ok.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ module: 'geo', kind: 'keyword_add', target: '매트리스 경도 고르는 법', approver: 'AE', status: 'pending' });
    const no = await run(c, 'geo_request_keyword', { query: '킹 매트리스 추천' });
    expect(no.ok).toBe(false);
    expect(no.후보.length).toBeGreaterThan(0);
    const miss = await run(c, 'geo_request_keyword', { query: '존재하지 않는 질의 xyz' });
    expect(miss.ok).toBe(false);
    const dupCtx = ctx(created).ctx;
    const dup = await run(dupCtx, 'geo_request_keyword', { query: 'q07' });
    expect(dup.ok).toBe(false);
    expect(dup.사유).toContain('이미 요청');
  });

  it('geo_request_keyword: AD Pilot · MILDO Lab에서 이미 올린 검색어는 거절 · 브랜드 검색어는 PM 승인', async () => {
    const t = '매트리스 경도 고르는 법';
    const adpilot = { id: 'chg_ad', createdAt: '2026-10-31T06:00:00Z', module: 'adpilot', kind: 'keyword_add', target: `${t} → PROBLEM_TEST 등록`, targetId: `term:${t}`, before: '미등록', after: 'PROBLEM_TEST · 입찰 900원', reason: '', requestedBy: 'AD Pilot', approver: 'AE', status: 'pending', history: [] } as ChangeRequest;
    const { ctx: c1, created: c1made } = ctx([adpilot]);
    const dup = await run(c1, 'geo_request_keyword', { query: t });
    expect(dup.ok).toBe(false);
    expect(dup.사유).toContain('AD Pilot');
    expect(c1made).toHaveLength(0);
    const lab = { ...adpilot, id: 'chg_lab', module: 'lab', target: t, targetId: 'labreg:매트리스경도고르는법' } as ChangeRequest;
    expect((await run(ctx([lab]).ctx, 'geo_request_keyword', { query: 'q07' })).사유).toContain('MILDO Lab');
    // 반려된 요청은 다시 올릴 수 있다
    expect((await run(ctx([{ ...adpilot, status: 'rejected' }]).ctx, 'geo_request_keyword', { query: t })).ok).toBe(true);
    const { ctx: c2, created } = ctx();
    const brand = await run(c2, 'geo_request_keyword', { query: '밀도 매트리스 경도' });
    expect(brand.ok).toBe(true);
    expect(created[0]).toMatchObject({ approver: 'PM', targetId: 'term:밀도 매트리스 경도', status: 'pending' });
    expect(brand.승인).toContain('PM');
  });

  it('geo_paid_surface: 급변 키워드만 원인 후보 · 급변 기준 표기', async () => {
    const r = await run(ctx().ctx, 'geo_paid_surface');
    const hold = r.질의.filter((q: { 판정: string }) => q.판정 === '자동 조정 보류 유지');
    expect(hold.map((q: { 질의: string }) => q.질의)).toEqual(['매트리스 추천']);
    expect(hold[0].원인후보[0].후보).toBe('경쟁사 입찰 상승');
    expect(hold[0].SA키워드.성과급변).toBe(true);
    expect(r.질의.filter((q: { 원인후보?: unknown }) => q.원인후보)).toHaveLength(1);
    expect(r.급변기준).toContain('±50%');
  });

  it('geo_parse_answer: URL만 있는 답변은 자사 인용만 판정', async () => {
    const r = await run(ctx().ctx, 'geo_parse_answer', { text: '자세한 내용은 https://mildo.kr 참고' });
    expect(r.언급).toBe(false);
    expect(r.판정).toContain('자사 인용만');
  });

  it('브리프: 질문 매칭 · 구조 · 출력 규칙', () => {
    const c = ctx().ctx;
    const pick = (q: string) => agentKit.briefs!.filter((b) => b.match.test(q)).map((b) => b.id);
    expect(pick('AI 검색에서 브랜드 언급률 어때?')).toContain('geo_visibility');
    expect(pick('제품페이지 JSON-LD 점검')).toContain('geo_audit');
    expect(pick('AEO FAQ 상태')).toContain('geo_faq');
    expect(pick('네이버 AI 요약 · 쇼핑 지면')).toContain('geo_paid');
    for (const b of agentKit.briefs!) {
      const brief = b.build(c);
      const md = briefToMarkdown(brief);
      expect(md).toContain('### 확정 팩트');
      expect(md).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(md).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
