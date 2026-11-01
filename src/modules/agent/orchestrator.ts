/**
 * MILDO Agent 오케스트레이션 — 전 모듈의 도구와 오프라인 브리프를 모은다.
 * (registry를 import하므로 View에서만 사용한다: registry → agent/agent.ts 순환 방지)
 */
import { MODULES } from '@/modules/registry';
import type { ToolContext } from '@/modules/types';
import type { AgentTool } from '@/ai/claude';
import { briefToMarkdown, type Brief } from '@/ai/prompts';
import { headline } from '@/core/selectors';
import { fmt } from '@/core/util';

/**
 * 전 모듈 도구 목록 — 모듈별 첫 번째 도구부터 돌아가며 배치(라운드 로빈)한다.
 * claude.ai 런타임은 호출당 도구 수 상한(limits().tools.maxCount)을 두므로, 앞에서부터 잘려도
 * 모든 모듈의 대표(조회) 도구가 먼저 남게 한다. 각 모듈 kit은 첫 도구를 대표 조회 도구로 둔다.
 */
export function collectTools(ctx: ToolContext): { module: string; tool: AgentTool }[] {
  const perModule: { module: string; tools: AgentTool[] }[] = [];
  const seen = new Set<string>();
  for (const m of MODULES) {
    if (!m.agent) continue;
    let tools: AgentTool[] = [];
    try {
      tools = m.agent.tools(ctx);
    } catch {
      tools = [];
    }
    const valid = tools.filter((t) => {
      if (seen.has(t.name) || !/^[A-Za-z0-9_-]{1,128}$/.test(t.name)) return false;
      seen.add(t.name);
      return true;
    });
    if (valid.length) perModule.push({ module: m.id, tools: valid });
  }
  type Entry = { module: string; tool: AgentTool };
  const rounds: Entry[][] = [];
  for (let round = 0; perModule.some((p) => p.tools.length > round); round++) {
    rounds.push(perModule.filter((p) => p.tools[round]).map((p) => ({ module: p.module, tool: p.tools[round] })));
  }
  // 화면 이동 버튼 도구(navigate)는 데이터 조회가 아니라 답변 UI 도구다 — 상한에 잘려 '화면 열기' 버튼이
  // 사라지지 않도록 대표 도구 라운드 바로 뒤에 둔다
  const head = rounds[0] ?? [];
  const rest = rounds.slice(1).flat();
  const pinned = rest.filter((e) => PINNED_TOOLS.has(e.tool.name));
  return [...head, ...pinned, ...rest.filter((e) => !PINNED_TOOLS.has(e.tool.name))];
}

/** 도구 수 상한이 있어도 대표 도구 바로 뒤에 남기는 UI 도구 */
export const PINNED_TOOLS: ReadonlySet<string> = new Set(['navigate']);

/** AI 미연결 시: 질문과 매칭되는 브리프를 최대 2개 골라 같은 형식으로 답한다 */
export function offlineAnswer(question: string, ctx: ToolContext): { markdown: string; used: string[] } {
  const scored: { module: string; id: string; brief: () => Brief; score: number }[] = [];
  for (const m of MODULES) {
    for (const b of m.agent?.briefs ?? []) {
      const re = new RegExp(b.match.source, b.match.flags.includes('g') ? b.match.flags : `${b.match.flags}g`);
      const hits = question.match(re);
      if (hits?.length) {
        const score = hits.reduce((a, h) => a + h.length, 0) + (m.id === 'home' ? -1 : 0);
        scored.push({ module: m.id, id: b.id, brief: () => b.build(ctx), score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, 2);
  if (!picked.length) {
    const home = MODULES.find((m) => m.id === 'home')?.agent?.briefs?.[0];
    if (home) picked.push({ module: 'home', id: home.id, brief: () => home.build(ctx), score: 0 });
  }
  const parts: string[] = [];
  const used: string[] = [];
  for (const p of picked) {
    try {
      const b = p.brief();
      parts.push(`#### ${b.title}\n\n${briefToMarkdown(b)}`);
      used.push(`${p.module}:${p.id}`);
    } catch (e) {
      parts.push(`#### ${p.module}\n\n규칙 엔진 계산 중 오류: ${(e as Error).message}`);
    }
  }
  return { markdown: parts.join('\n\n'), used };
}

/** 에이전트 첫 턴에 넣는 작은 데이터 스냅샷 */
export function snapshot(ctx: ToolContext): string {
  const d = ctx.state.data;
  const h = headline(d);
  const open = ctx.state.incidents.filter((i) => i.status !== 'resolved');
  return [
    `기준 시각: ${d.today} ${d.currentHour}:30 (데이터는 시연용 테스트 데이터, 실제 성과 아님)`,
    `어제: 광고비 ${fmt.krw(h.yesterday.cost)}원 · 광고 매출 ${fmt.krw(h.yesterday.revenue)}원 · ROAS ${fmt.roas(h.yesterday.roas)} · CPA ${fmt.won(h.yesterday.cpa)} · 실매출 ${fmt.krw(h.salesYesterday)}원`,
    `최근 7일: ROAS ${fmt.roas(h.last7.roas)} (직전 7일 ${fmt.roas(h.prev7.roas)}) · CAC ${fmt.won(h.last7.cac)}`,
    `열린 이슈 ${open.length}건: ${open.slice(0, 6).map((i) => `${i.severity} ${i.title}`).join(' / ') || '없음'}`,
    `승인 대기 ${ctx.state.changes.filter((c) => c.status === 'pending').length}건 · 현재 사용자 역할 ${ctx.state.role}`,
  ].join('\n');
}

export const TOOL_GUIDE = `도구 사용 원칙
- 숫자가 필요한 판단은 추측하지 말고 도구로 조회한다. 여러 모듈 데이터가 필요하면 필요한 도구를 함께 호출한다.
- 도구 결과의 성과 수치는 시연용 테스트 데이터다. 인용할 때 그 사실을 밝힌다.
- 상태를 바꾸는 도구는 승인 요청(pending)만 만든다. 실제 반영은 사람이 MILDO Flow에서 승인한다. 사용자가 요청하지 않은 변경 요청은 만들지 않는다.
- 제안서 기준값(목표 ROAS 초기값, 급변 ±50%, SLA, 위임 범위)은 온보딩 중 확정되는 초기값임을 감안한다.`;
