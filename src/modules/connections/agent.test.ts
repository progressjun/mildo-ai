/** 데이터 연결 에이전트 키트: 상태 도구(예시 · 서버 스냅샷) · 템플릿 도구 · 오프라인 브리프 규칙 */
import { afterEach, describe, expect, it } from 'vitest';
import { agentKit } from './agent';
import { setSnapshot } from './client';
import { exampleState } from './demoState';
import { DEMO } from '@/data/demo';
import type { ToolContext } from '../types';

function ctx(data = DEMO): ToolContext {
  return {
    state: { data, changes: [], incidents: [], toasts: [], comments: [], ai: { mode: 'offline', apiKey: '', model: 'claude-opus-5-5' }, role: 'PM', offHoursMode: false, tf: {}, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 } },
    actions: {} as ToolContext['actions'],
    navigate: () => undefined,
  };
}
afterEach(() => setSnapshot(null));

describe('데이터 연결 에이전트 키트', () => {
  it('도구 2개 · 브리프 1개, 이름 규칙', () => {
    const tools = agentKit.tools(ctx());
    expect(tools.map((t) => t.name)).toEqual(['data_sources_status', 'data_upload_templates']);
    expect(agentKit.briefs).toHaveLength(1);
  });

  it('data_sources_status: 서버 미연결이면 예시 상태(TEST DATA) · Dataset 출처 TEST DATA', async () => {
    const t = agentKit.tools(ctx()).find((x) => x.name === 'data_sources_status')!;
    const r = (await t.execute({})) as Record<string, any>;
    expect(r.상태출처).toMatch(/예시 상태/);
    expect(r.dataset.출처).toBe('TEST DATA');
    expect(r.커넥션).toHaveLength(3);
    expect(r.커넥션[1]).toMatchObject({ 상태: '연결 확인 필요', 실계정검증: '실계정 연결 전 확인 필요', 쓰기모드: 'dry_run' });
    expect(r.품질.오류).toBeGreaterThan(0);
    expect(JSON.stringify(r).length).toBeLessThan(32_000);
  });

  it('data_sources_status: 화면이 읽은 서버 스냅샷이 있으면 그 값을 쓴다', async () => {
    const ex = exampleState(DEMO);
    setSnapshot({ workspaceId: 'w', at: ex.nowMs, connections: [{ ...ex.connections[1], status: 'error', lastError: '인증 실패' }], runs: [], quality: { issues: [], summary: { error: 0, warning: 0, info: 0, connections: 1, checkedAt: '' } } });
    const r = (await agentKit.tools(ctx())[0].execute({})) as Record<string, any>;
    expect(r.상태출처).toMatch(/서버/);
    expect(r.커넥션).toEqual([expect.objectContaining({ 상태: '오류', 오류: '인증 실패' })]);
  });

  it('data_upload_templates: 전체 5종 또는 하나', async () => {
    const t = agentKit.tools(ctx()).find((x) => x.name === 'data_upload_templates')!;
    const all = (await t.execute({})) as { 템플릿: { id: string; 열: { 필드: string; 필수: boolean }[] }[] };
    expect(all.템플릿.map((x) => x.id)).toEqual(['media_daily', 'media_hourly', 'sales_daily', 'keyword_daily', 'search_term_daily']);
    const one = (await t.execute({ template: 'sales_daily' })) as typeof all;
    expect(one.템플릿).toHaveLength(1);
    expect(one.템플릿[0].열.filter((c) => c.필수).map((c) => c.필드)).toEqual(['일자', '판매 채널', '주문', '매출']);
  });

  it('브리프: 질문 매칭 · 팩트/패턴/해석 구조 · 번호 매기기 없음 · 출처 기준 명시', () => {
    const b = agentKit.briefs![0];
    for (const q of ['데이터 연결 상태 알려줘', '수집 실패한 거 있어?', 'CSV 업로드 형식', '지금 TEST DATA야?', 'live 반영 켜도 돼?']) expect(b.match.test(q), q).toBe(true);
    const brief = b.build(ctx());
    expect(brief.facts[0]).toMatch(/TEST DATA/);
    expect(brief.interpretation.join(' ')).toMatch(/dry_run/);
    const all = [...brief.facts, ...brief.patterns, ...brief.interpretation, ...brief.conditions, ...brief.counter, ...brief.actions].join('\n');
    expect(all).not.toMatch(/^\s*\d+[.)]\s/m);
    expect(all).not.toMatch(/NaN|undefined|Infinity/);
    // 예약 수집 기간: 매체 3일 · 판매 채널 14일 (서버 daily 재수집과 같은 근거)
    expect(brief.conditions.join(' ')).toMatch(/매체 3일.*판매 채널 14일.*취소 · 반품/);
    const live = b.build(ctx({ ...DEMO, meta: { mode: 'live', builtAt: '', sources: [{ channel: 'naver_sa', source: 'x', kind: 'api', latestDate: '2026-10-28' }] } }));
    expect(live.facts[0]).toMatch(/LIVE DATA/);
    expect(live.patterns.join(' ')).toMatch(/어제.*네이버 SA/);
  });
});
