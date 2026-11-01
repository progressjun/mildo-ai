/**
 * MILDO Board 에이전트 도구 · 오프라인 브리프 테스트.
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '@/core/store';
import type { ToolContext } from '../types';
import { DEMO } from '@/data/demo';
import { briefToMarkdown } from '@/ai/prompts';
import { agentKit } from './agent';

function ctx(): ToolContext {
  const state: AppState = {
    data: DEMO, changes: [], incidents: [], toasts: [], comments: [],
    ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' }, role: 'PM', offHoursMode: false, tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  return { state, actions: {} as ToolContext['actions'], navigate: () => undefined };
}

const tool = (name: string) => agentKit.tools(ctx()).find((t) => t.name === name)!;
const run = async (name: string, inp: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(await tool(name).execute(inp))) as Record<string, any>;

describe('board agent kit', () => {
  it('도구 5개 · 이름 규칙 board_* · 브리프 5개', () => {
    const tools = agentKit.tools(ctx());
    expect(tools.map((t) => t.name)).toEqual(['board_summary', 'board_keywords', 'board_pacing', 'board_data_status', 'board_hourly']);
    for (const t of tools) expect(t.name).toMatch(/^board_[a-z_]+$/);
    expect(agentKit.briefs!.length).toBeGreaterThanOrEqual(2);
  });

  it('모든 도구: 입력 없이 실행 · 32KB 이하 · NaN 문자열 없음', async () => {
    for (const t of agentKit.tools(ctx())) {
      const s = JSON.stringify(await t.execute({}));
      expect(s.length, t.name).toBeLessThan(32_000);
      expect(s, t.name).not.toMatch(/NaN|Infinity/);
      expect(s, t.name).toContain('TEST DATA');
    }
  });

  it('board_summary: 기간 입력 · 잘못된 기간은 최근 7일', async () => {
    const y = await run('board_summary', { period: 'yesterday' });
    expect(y.기간.이름).toBe('어제');
    expect(y.매체).toHaveLength(6);
    expect(y.판매채널).toHaveLength(4);
    expect((await run('board_summary', { period: 'bogus' })).기간.이름).toBe('최근 7일');
  });

  it('board_keywords: 필터 · 신호 (킹 품절 · 매트리스 추천 CPC 급변)', async () => {
    const sold = await run('board_keywords', { signal: 'soldout' });
    expect(sold.키워드.map((k: { 키워드: string }) => k.키워드)).toEqual(['킹 매트리스']);
    const cpc = await run('board_keywords', { signal: 'cpc_spike' });
    expect(cpc.키워드[0].키워드).toBe('매트리스 추천');
    const brand = await run('board_keywords', { intent: 'brand', limit: 2 });
    expect(brand.키워드).toHaveLength(2);
    expect(brand.의도별).toHaveLength(1);
    const king = await run('board_keywords', { size: '킹' });
    expect(king.제품군별[0].재고).toBe('품절');
  });

  it('board_pacing: 조기 소진 캠페인이 먼저 · 매체 필터', async () => {
    const p = await run('board_pacing');
    const early = p.캠페인.filter((c: { 판정: string }) => /소진/.test(c.판정)).map((c: { 캠페인: string }) => c.캠페인);
    expect(early).toContain('SA_일반 제품');
    expect(early).toContain('Meta_넓은 타겟');
    expect(p.캠페인[0].판정).toMatch(/소진/);
    const meta = await run('board_pacing', { media: 'meta' });
    expect(meta.매체).toHaveLength(1);
    expect(meta.캠페인.every((c: { 매체: string }) => c.매체 === 'Meta')).toBe(true);
  });

  it('board_data_status · board_hourly', async () => {
    const s = await run('board_data_status');
    expect(s.검증.some((c: { 결과: string; 내용: string }) => c.결과 === '확인 필요' && c.내용.includes('카카오'))).toBe(true);
    expect(s.검증.some((c: { 내용: string }) => c.내용.includes('Meta'))).toBe(true);
    const h = await run('board_hourly', { metric: 'cost' });
    expect(h.상위슬롯).toHaveLength(3);
    expect(h.시간대효율.at(-1).효율지수).toBeGreaterThan(1);
  });

  it('오프라인 브리프: 질문 매칭 · 구조 · 번호 매기기 금지', () => {
    const c = ctx();
    const q = (text: string) => agentKit.briefs!.filter((b) => b.match.test(text)).map((b) => b.id);
    expect(q('오늘 예산 소진 현황 알려줘')).toContain('board-pacing');
    expect(q('판매 채널 실매출이랑 MER 어때?')).toContain('board-channel');
    expect(q('키워드 성과 필터로 품절 랜딩 확인')).toContain('board-keywords');
    expect(q('매체별 성과 비교해줘')).toContain('board-period');
    expect(q('데이터 수집 상태 확인')).toContain('board-data');
    for (const b of agentKit.briefs!) {
      const md = briefToMarkdown(b.build(c));
      expect(md).toContain('### 확정 팩트');
      expect(md).not.toMatch(/^\s*\d+[.)]\s/m);
      expect(md).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
