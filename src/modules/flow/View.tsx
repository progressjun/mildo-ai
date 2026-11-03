/**
 * MILDO Flow (제안서 p.31 · p.53 · p.15) — 요청 · 승인 · 반영 이력, 프로모션 체크리스트 · 자동 점검 · 리포트,
 * 감지 → 배정 → 조치 → 보고 운영 타임라인.
 */
import { useState } from 'react';
import type { AppState } from '@/core/store';
import { ROLE_LABEL } from '@/core/permissions';
import { useSaas } from '@/saas/context';
import { PageHeader, Segmented, Src, Tabs } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { BoardTab } from './BoardTab';
import { ChangeDrawer } from './ChangeDrawer';
import { PromoCheckTab } from './PromoCheckTab';
import { PromoReportTab } from './PromoReportTab';
import { RequestTab } from './RequestTab';
import { SystemTab } from './SystemTab';
import { TimelineTab } from './TimelineTab';
import { actorLabel, EMPTY_DRAFT, fmtDuration, fmtStamp, roleScopeText, stageCounts, type RequestDraft } from './engine';
import { useFlow } from './useFlow';
import './styles.css';

export type FlowTab = 'board' | 'timeline' | 'promo' | 'report' | 'request' | 'system';

export default function View() {
  const ctx = useFlow();
  const { summary, checks, cases, state, clock, data, dispatch, server } = ctx;
  const saas = useSaas();
  const [tab, setTab] = useState<FlowTab>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RequestDraft>(EMPTY_DRAFT);
  const promos = data.promotions ?? [];
  const live = promos.find((p) => p.start <= data.today && p.end >= data.today);
  const [reportId, setReportId] = useState<string>(live?.id ?? promos[0]?.id ?? '');
  const sc = stageCounts(cases);
  const openCases = cases.filter((c) => c.current !== 'done').length;
  const fails = checks.reduce((a, c) => a + c.counts.fail, 0);
  const q = summary.queue;

  return (
    <div className="page flow flow-page">
      <PageHeader eyebrow="04 REVENUE GROWTH · MILDO FLOW" title="MILDO Flow"
        sub="요청 · 승인 · 반영 이력을 한 화면에서 처리하고, 프로모션은 오픈 전 자동 점검과 종료 후 자동 리포트로 묶어 브랜드 ↔ 대행사 확인 왕복을 줄입니다."
        sources={<><Src kind="PROPOSAL" page="p.31" /><Src kind="PROPOSAL" page="p.53" /><Src kind="PROPOSAL" page="p.15" /><Src kind="DEMO" /></>}
        actions={
          <div className="flow-role" title={server
            ? '승인 · 반려 · 반영 · 롤백 권한은 로그인 계정의 멤버십 역할로 정해지고 서버가 최종 판정합니다 (p.53)'
            : '승인 · 반려 · 반영 · 롤백 권한은 요청의 승인 주체와 현재 역할을 대조합니다 (p.53)'}>
            <span className="xs muted">현재 역할</span>
            {server ? (
              // 서버 모드: 역할은 멤버십 기준(role/set은 서버 모드에서 버려진다) — 읽기 전용으로 표시하고 바꾸는 곳은 팀 · 권한
              <strong className="small flow-role-fixed" aria-label="현재 역할 (멤버십)">{saas.role ? ROLE_LABEL[saas.role] : actorLabel(ctx.actor)}</strong>
            ) : (
              <Segmented<AppState['role']> label="현재 역할" value={state.role} onChange={(role) => dispatch({ type: 'role/set', role })}
                options={[{ id: '담당 AE', label: '담당 AE' }, { id: 'PM', label: 'PM' }, { id: '수면밀도', label: '수면밀도' }]} />
            )}
            <span className="xs ink2">{roleScopeText(ctx.actor)}{server && saas.role === 'client' ? ' · 반영 · 롤백은 대행사 운영 역할' : ''}</span>
          </div>
        } />

      <section className="card dark flow-hero" aria-label="Flow 요약">
        <button type="button" className="flow-hero-item main" onClick={() => setTab('board')}>
          <span className="flow-hero-label">내가 처리할 것</span>
          <span className="flow-hero-value num accent-text">{q.total}</span>
          <span className="flow-hero-foot">승인 {q.approve.length} · 반영 {q.apply.length} · 보류 판단 {q.held.length}</span>
        </button>
        <button type="button" className="flow-hero-item" onClick={() => setTab('board')}>
          <span className="flow-hero-label">승인 대기</span>
          <span className="flow-hero-value num">{summary.byStatus.pending}</span>
          <span className="flow-hero-foot">{summary.overdue.length ? <><Icon name="clock" size={11} /> 기준 초과 {summary.overdue.length}건 (p.53)</> : '기준 초과 없음 (p.53 소요)'}</span>
        </button>
        <button type="button" className="flow-hero-item" onClick={() => setTab('board')}>
          <span className="flow-hero-label">평균 결정 소요</span>
          <span className="flow-hero-value num">{fmtDuration(summary.avgDecisionMin)}</span>
          <span className="flow-hero-foot">기준 충족 {Number.isFinite(summary.metRate) ? `${Math.round(summary.metRate * 100)}%` : '—'} · 결정 {summary.decided}건</span>
        </button>
        <button type="button" className="flow-hero-item" onClick={() => setTab('board')}>
          <span className="flow-hero-label">반영 · 롤백 · 보류</span>
          <span className="flow-hero-value num">{summary.byStatus.applied} · {summary.byStatus.rolled_back} · {summary.byStatus.held}</span>
          <span className="flow-hero-foot">오늘 반영 {summary.appliedToday}건 · 전체 {summary.total}건 이력</span>
        </button>
        <button type="button" className="flow-hero-item" onClick={() => setTab('promo')}>
          <span className="flow-hero-label">프로모션 점검 실패</span>
          <span className="flow-hero-value num">{fails}</span>
          <span className="flow-hero-foot">{checks.map((c) => `${c.promotion.name.split(' ')[0]} ${c.verdict.label}(실패 ${c.counts.fail})`).join(' · ') || '프로모션 없음'} · 기준 실패 0건 = 오픈 가능</span>
        </button>
        <button type="button" className="flow-hero-item" onClick={() => setTab('timeline')}>
          <span className="flow-hero-label">진행 중 이슈</span>
          <span className="flow-hero-value num">{openCases}</span>
          <span className="flow-hero-foot">배정 대기 {sc.assign} · 조치 {sc.action} · 보고 {sc.report}</span>
        </button>
        <div className="flow-hero-meta xs">
          <Src kind="DEMO" /> 데이터 기준 {fmtStamp(clock.nowMs)}{server ? '' : ` · 시연 이력 ${summary.seeds}건 포함`}
        </div>
      </section>

      <Tabs<FlowTab> value={tab} onChange={setTab} tabs={[
        { id: 'board', label: '요청 · 승인 · 반영', badge: q.total ? <span className="flow-tab-badge num">{q.total}</span> : undefined },
        { id: 'timeline', label: '운영 타임라인', badge: openCases ? <span className="flow-tab-badge num">{openCases}</span> : undefined },
        { id: 'promo', label: '프로모션 점검', badge: fails ? <span className="flow-tab-badge crit num">{fails}</span> : undefined },
        { id: 'report', label: '프로모션 리포트' },
        { id: 'request', label: '신규 요청' },
        { id: 'system', label: '반복 구간 · 의사결정 체계' },
      ]} />

      {tab === 'board' ? <BoardTab ctx={ctx} onOpen={setOpenId} onNew={() => { setDraft(EMPTY_DRAFT); setTab('request'); }} /> : null}
      {tab === 'timeline' ? <TimelineTab ctx={ctx} onOpen={setOpenId} onDraft={(d) => { setDraft(d); setTab('request'); }} /> : null}
      {tab === 'promo' ? <PromoCheckTab ctx={ctx} onOpen={setOpenId} onReport={(id) => { setReportId(id); setTab('report'); }} /> : null}
      {tab === 'report' ? <PromoReportTab ctx={ctx} promoId={reportId} onPromo={setReportId} /> : null}
      {tab === 'request' ? <RequestTab ctx={ctx} draft={draft} setDraft={setDraft} onCreated={(id) => { setTab('board'); setOpenId(id); }} /> : null}
      {tab === 'system' ? <SystemTab ctx={ctx} onTab={(t) => setTab(t as FlowTab)} /> : null}

      {openId ? <ChangeDrawer key={openId} ctx={ctx} id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
