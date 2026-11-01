/**
 * MILDO Lab 에이전트 도구 · 오프라인 브리프 — 이름 규칙 · 결과 크기(32KB) · NaN 없음 · 상태 변경은 pending만.
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '@/core/store';
import type { ChangeRequest } from '@/core/types';
import { DEMO } from '@/data/demo';
import type { ToolContext } from '../types';
import { agentKit } from './agent';
import { searchTermCandidates } from './engine';

function makeCtx(changes: ChangeRequest[] = [], role: AppState['role'] = 'PM') {
  const created: ChangeRequest[] = [];
  const state: AppState = {
    data: DEMO, changes, incidents: [], toasts: [], comments: [], ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' },
    role, offHoursMode: false, tf: {}, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  const actions = {
    toast: () => undefined,
    addChange: (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'> & { status?: ChangeRequest['status'] }) => {
      const ch = { id: `chg_${created.length}`, createdAt: '2026-10-31T06:30:00.000Z', history: [], status: c.status ?? 'pending', ...c } as ChangeRequest;
      created.push(ch);
      changes.push(ch);
      return ch;
    },
    updateChange: () => undefined, addIncident: () => undefined, updateIncident: () => undefined,
  } as unknown as ToolContext['actions'];
  return { ctx: { state, actions, navigate: () => undefined } as ToolContext, created };
}
const tool = (ctx: ToolContext, name: string) => agentKit.tools(ctx).find((t) => t.name === name)!;
const json = (r: unknown) => JSON.stringify(r);

describe('MILDO Lab agentKit', () => {
  it('도구 ≥ 2개 · 이름 lab_ 접두사 · 스펙 도구 4종 포함', () => {
    const { ctx } = makeCtx();
    const names = agentKit.tools(ctx).map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const n of names) expect(n).toMatch(/^lab_[a-z_]+$/);
    for (const n of ['lab_expand_keywords', 'lab_judge', 'lab_review_copy', 'lab_generate_copy']) expect(names).toContain(n);
  });

  it('읽기 도구는 32KB 이하 JSON · NaN 없음 · 상태를 바꾸지 않는다', async () => {
    const { ctx, created } = makeCtx();
    const inputs: Record<string, Record<string, unknown>[]> = {
      lab_expand_keywords: [{}, { source: 'sku48', limit: 48 }, { source: 'search_term' }, { intent: 'life', minScore: 60 }, { source: 'nope', limit: -3 }],
      lab_judge: [{}, { keyword: '신혼' }, { cardId: 'TC-03' }, { cardId: 'none' }],
      lab_review_copy: [{}, { text: '허리 디스크 치료 매트리스 20% 할인' }, { text: '경도로 고르는 신혼집 매트리스 추천', limit: 15 }],
      lab_generate_copy: [{}, { campaign: 'life', hypothesis: 'C' }, { campaign: 'x' }],
      lab_overview: [{}],
    };
    for (const [name, list] of Object.entries(inputs)) {
      for (const inp of list) {
        const r = await tool(ctx, name).execute(inp);
        const s = json(r);
        expect(s.length, `${name} ${json(inp)}`).toBeLessThan(32_000);
        expect(s).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
    expect(created).toHaveLength(0);
  });

  it('lab_expand_keywords — SKU 48 소스는 점수순 상위부터, 점수 기준 문구는 상수에서', async () => {
    const { ctx } = makeCtx();
    const r = (await tool(ctx, 'lab_expand_keywords').execute({ source: 'sku48', limit: 48 })) as { 후보: { 점수: number }[]; 점수기준: string };
    expect(r.후보).toHaveLength(48);
    for (let k = 1; k < r.후보.length; k++) expect(r.후보[k - 1].점수).toBeGreaterThanOrEqual(r.후보[k].점수);
    expect(r.점수기준).toMatch(/검색량 40 \+ 랜딩 30 \+ 근거 20 \+ 구매 의도 10/);
  });
  it('lab_expand_keywords — 48 진입점 공식과 소스별 건수', async () => {
    const { ctx } = makeCtx();
    const r = (await tool(ctx, 'lab_expand_keywords').execute({ source: 'sku48', limit: 48 })) as { 공식: string; 후보: unknown[]; 소스별건수: Record<string, number> };
    expect(r.공식).toContain('= 검색 진입점 48개');
    expect(r.후보).toHaveLength(48);
    expect(r.소스별건수['검색어 보고서']).toBe(searchTermCandidates(DEMO).length);
  });

  it('lab_judge — 판정 기준 문구와 카드 p-value 병기', async () => {
    const { ctx } = makeCtx();
    const r = (await tool(ctx, 'lab_judge').execute({})) as { 판정기준: string; 테스트카드: { 판정: string; pCVR: number | null }[]; 키워드: unknown[] };
    expect(r.판정기준).toMatch(/확장 ≥ 목표 ROAS 400%의 100%/);
    expect(r.키워드.length).toBeGreaterThan(0);
    expect(r.테스트카드.some((c) => /중단/.test(c.판정))).toBe(true);
    expect(r.테스트카드.every((c) => c.pCVR === null || (c.pCVR >= 0 && c.pCVR <= 1))).toBe(true);
  });

  it('lab_review_copy — 차단 판정과 수정안', async () => {
    const { ctx } = makeCtx();
    const r = (await tool(ctx, 'lab_review_copy').execute({ text: '허리 디스크 치료에 도움되는 매트리스' })) as { 판정: string; 수정안: string | null };
    expect(r.판정).toBe('block');
    expect(r.수정안).toBeTruthy();
  });

  it('lab_register_candidate — pending ChangeRequest만 만들고, 중복 · 구매 의도 낮음은 만들지 않는다', async () => {
    const changes: ChangeRequest[] = [];
    const { ctx, created } = makeCtx(changes);
    const phrase = searchTermCandidates(DEMO).find((c) => c.purchase)!.phrase;
    const r1 = (await tool(ctx, 'lab_register_candidate').execute({ phrase })) as { 결과: string; 승인: string };
    expect(r1.결과).toMatch(/pending/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'pending', module: 'lab', kind: 'keyword_add', target: phrase, requestedBy: 'MILDO Agent' });
    const r2 = (await tool(ctx, 'lab_register_candidate').execute({ phrase })) as { 결과: string };
    expect(r2.결과).toBe('생성 안 함');
    const r3 = (await tool(ctx, 'lab_register_candidate').execute({ phrase: '이사 매트리스 버리기' })) as { 결과: string };
    expect(r3.결과).toBe('생성 안 함');
    const r4 = (await tool(ctx, 'lab_register_candidate').execute({ phrase: ' ' })) as { 결과: string };
    expect(r4.결과).toBe('실패');
    expect(created).toHaveLength(1);
  });

  it('오프라인 브리프 ≥ 2개 · 질문 매칭 · 구조 · 문구 원칙', () => {
    const { ctx } = makeCtx();
    const briefs = agentKit.briefs ?? [];
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    const q: Record<string, string> = {
      'lab-overview': 'MILDO Lab 오늘 할 일 요약해줘',
      'lab-pipeline': '키워드 테스트 판정 결과 알려줘',
      'lab-discover': '롱테일 구문형 키워드 후보 발굴',
      'lab-review': '이 광고 문안 검수해줘',
      'lab-creative': 'VisualTune 소재 테스트 결과',
    };
    for (const b of briefs) {
      if (q[b.id]) expect(b.match.test(q[b.id]), b.id).toBe(true);
      const brief = b.build(ctx);
      expect(brief.facts.length).toBeGreaterThan(0);
      const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
      expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(all).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect(briefs.find((b) => b.id === 'lab-overview')!.match.test('랩업 결과 요약')).toBe(false);
  });
});
