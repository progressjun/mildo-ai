import type { ModuleAgentKit } from '../types';
import { generateBidProposals } from '@/modules/adpilot/engine';
import { MEDIA } from '@/data/constants';
import { hhmmOf, homeTimetable, morningBrief, operatingSummary } from './engine';

export const agentKit: ModuleAgentKit = {
  tools: (ctx) => [
    {
      name: 'home_status',
      description: '오늘의 운영 요약을 반환한다: 어제 · 최근 7일 KPI(광고비, ROAS, CPA, CAC, 실매출), 열린 이슈 수(등급별), 승인 대기 수, 조기 소진 캠페인, 월 예산 페이스. 무엇부터 처리할지 판단할 때 먼저 호출.',
      execute: () => {
        const d = ctx.state.data;
        const s = operatingSummary(d, ctx.state.incidents, ctx.state.changes);
        const r = (n: number) => (Number.isFinite(n) ? Math.round(n) : null);
        return {
          dataNote: '시연용 테스트 데이터 (실제 성과 아님)',
          asOf: `${d.today} ${d.currentHour}:30`,
          yesterday: { cost: r(s.h.yesterday.cost), revenue: r(s.h.yesterday.revenue), roasPct: r(s.h.yesterday.roas), cpa: r(s.h.yesterday.cpa), sales: r(s.h.salesYesterday) },
          last7: { cost: r(s.h.last7.cost), roasPct: r(s.h.last7.roas), cpa: r(s.h.last7.cpa), cac: r(s.h.last7.cac), newCustomers: r(s.h.last7.newCustomers) },
          prev7: { roasPct: r(s.h.prev7.roas), cpa: r(s.h.prev7.cpa), cac: r(s.h.prev7.cac) },
          openIncidents: s.open.map((i) => ({ id: i.id, severity: i.severity, title: i.title, status: i.status, deltaPct: i.deltaPct !== undefined ? r(i.deltaPct) : null })),
          pendingApprovals: s.pending.length,
          earlyExhaustCampaigns: s.early.map((c) => ({ name: c.name, pacePct: r(c.pacePct), expectedEnd: hhmmOf(c.exhaustHour), beforePeak: c.missesPeak, basis: '최근 28일 시간대 소진 곡선 · 23시 전 마감' })),
          monthlyPaceOver: s.over.map((p) => MEDIA[p.media].name),
          monthlyPaceUnder: s.under.map((p) => MEDIA[p.media].name),
          offDay: s.off,
        };
      },
    },
    {
      name: 'home_timetable',
      description: '데이터 제공 시간표(07:00 수집 ~ 17:00 일 마감) 항목별 완료/다음 상태를 반환한다. 주말 · 공휴일에는 다음 영업일로 이동하는 항목과 처리 규칙을 함께 반환한다.',
      execute: () => {
        const t = homeTimetable(ctx.state.data, { offHours: ctx.state.offHoursMode, incidents: ctx.state.incidents, changes: ctx.state.changes });
        return { offDay: t.off ? t.offLabel : null, nextBusinessDay: t.nextBusinessDay, items: t.items.map((i) => ({ time: i.time, title: i.title, state: i.state, status: i.label, channel: i.channel, offRule: i.offNote ?? null })) };
      },
    },
    {
      name: 'navigate',
      description: '답변 아래에 특정 모듈 화면으로 이동하는 버튼을 붙인다(답변을 다 읽은 뒤 사용자가 눌러 이동). route: home, board, adpilot, reports, watch, lab, geo, growth, flow, alert, ops, agent 중 하나.',
      inputSchema: { type: 'object', properties: { route: { type: 'string' } }, required: ['route'] },
      execute: (input) => {
        const route = String(input.route ?? '');
        if (!/^(home|board|adpilot|reports|watch|lab|geo|growth|flow|alert|ops|agent)$/.test(route)) throw new Error('알 수 없는 화면');
        ctx.navigate(route);
        return { ok: true, route };
      },
    },
  ],
  briefs: [
    {
      id: 'home_brief',
      match: /(오늘|현황|브리프|요약|우선|먼저|상황|status)/i,
      build: (ctx) => morningBrief(ctx.state.data, ctx.state.incidents, ctx.state.changes, generateBidProposals(ctx.state.data).length),
    },
  ],
};
