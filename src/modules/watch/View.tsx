/**
 * MILDO Watch — 매체 변동 선제 트래킹 · 오가닉/페이드 통합 아카이빙 · 외부 변수 · 주간 인사이트 브리프
 * (제안서 p.21 · p.24 · p.25 · p.28). 성과 수치는 시연용 TEST DATA, 매체 공지 · 경쟁사 스냅샷은 가상.
 */
import { useState } from 'react';
import './styles.css';
import { fmtDate } from '@/core/util';
import { Button, Card, PageHeader, Pill, Src, Tabs } from '@/ui/primitives';
import { PIPELINE, fmtHoursLeft, type StageId } from './engine';
import { OS_ROLES } from './data';
import { useWatch, type WatchCtx } from './hooks';
import { TrackingTab } from './TrackingTab';
import { EventDrawer } from './EventDrawer';
import { ArchiveTab } from './ArchiveTab';
import { SerpTab } from './SerpTab';
import { ExternalTab } from './ExternalTab';
import { BriefTab } from './BriefTab';

type TabId = 'tracking' | 'archive' | 'serp' | 'external' | 'brief';

export default function View() {
  const w = useWatch();
  const [tab, setTab] = useState<TabId>('tracking');
  const [openId, setOpenId] = useState<string | null>(null);
  const d = w.state.data;
  const weekArc = w.archive.filter((r) => r.date >= w.brief.period.from);
  return (
    <div className="page watch-page">
      <PageHeader
        eyebrow="03 MONITORING & TEST · MILDO WATCH"
        title="MILDO Watch"
        sub="신규 상품 · 광고 지면 · 노출 로직 변화를 먼저 잡아 24시간 안에 영향을 진단하고, 주간 리포트 실행안과 소액 테스트로 연결합니다. 경쟁 6개사와 외부 변수는 오가닉 · 페이드 구분 없이 아카이빙합니다."
        sources={<><Src kind="PROPOSAL" page="p.21 · p.24–25 · p.28" /><Src kind="DEMO" /><span className="xs muted">데이터 기준 {fmtDate(d.today)} {String(d.currentHour).padStart(2, '0')}:30 · 매체 공지 이벤트 · 경쟁사 스냅샷은 시연용 가상 데이터 · 판정 기준은 초기값 (온보딩 중 확정)</span></>}
        actions={<Button size="sm" icon="rollback" variant="ghost" onClick={w.reset}>시연 초기화</Button>}
      />
      <WatchStrip w={w} onTab={setTab} onOpen={setOpenId} />
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'tracking', label: '매체 변동 트래킹', badge: w.counts.open ? <Pill tone={w.events.some((e) => !e.closed && (e.due.overdue || e.due.urgent)) ? 'warning' : 'neutral'}>{w.counts.open}</Pill> : undefined },
          { id: 'archive', label: '경쟁사 아카이브', badge: weekArc.length ? <Pill tone="neutral">{weekArc.length}</Pill> : undefined },
          { id: 'serp', label: '브랜드 지면 점검', badge: w.brief.counts.serpAbove ? <Pill tone="serious">{w.brief.counts.serpAbove}</Pill> : undefined },
          { id: 'external', label: '외부 변수 · 시즌' },
          { id: 'brief', label: '주간 인사이트 브리프' },
        ]}
      />
      {tab === 'tracking' ? <TrackingTab w={w} onOpen={setOpenId} /> : null}
      {tab === 'archive' ? <ArchiveTab w={w} /> : null}
      {tab === 'serp' ? <SerpTab w={w} /> : null}
      {tab === 'external' ? <ExternalTab w={w} /> : null}
      {tab === 'brief' ? <BriefTab w={w} /> : null}
      {openId ? <EventDrawer w={w} id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} /> : null}
    </div>
  );
}

/** 상단 블랙 패널 — p.21 역할 + p.24 파이프라인 단계별 현황 + 아카이브 · 지면 · 시즌 요약 */
function WatchStrip({ w, onTab, onOpen }: { w: WatchCtx; onTab: (t: TabId) => void; onOpen: (id: string) => void }) {
  const open = w.events.filter((e) => !e.closed);
  const at = (s: StageId) => open.filter((e) => e.stage === s);
  const urgent = at('detect').sort((a, b) => (a.due.remainingH ?? 1e9) - (b.due.remainingH ?? 1e9))[0];
  const overdue = at('detect').filter((e) => e.due.overdue).length;
  const holds = at('plan').filter((e) => e.next.disabled).length;
  const wrapReady = at('test').filter((e) => !e.next.disabled).length;
  const weekArc = w.archive.filter((r) => r.date >= w.brief.period.from);
  const nextEv = w.calendar.find((c) => c.dday > 0);
  const foot: Record<StageId, string> = {
    detect: urgent ? `가장 가까운 기한 ${fmtHoursLeft(urgent.due.remainingH ?? NaN)}${overdue ? ` · 초과 ${overdue}건` : ''}` : '진단 대기 없음',
    diagnose: `실행안 → ${w.report.label}`,
    plan: `Lab 등록 대기${holds ? ` · 보류 ${holds}건 (데이터 이상)` : ''}`,
    test: `진행 ${at('test').length - wrapReady} · 랩업 가능 ${wrapReady}`,
    wrapup: `완료 ${at('wrapup').length} · 관찰 종료 ${w.counts.closed}`,
  };
  return (
    <Card tone="dark" className="no-print">
      <div className="row-between">
        <div className="row" style={{ gap: 6 }}>
          <span className="xs watch-strip-eyebrow">MILDO OS가 맡는 일</span>
          {OS_ROLES.map((r) => (
            <a key={r.id} href={`#${r.route}`} className={`watch-role ${r.here ? 'here' : ''}`} title={r.detail}>
              <strong>{r.label}</strong><span>{r.detail}</span>
            </a>
          ))}
        </div>
        <Src kind="PROPOSAL" page="p.21 · p.24" />
      </div>
      <div className="watch-strip">
        {PIPELINE.map((p, i) => {
          const list = at(p.id);
          const hot = (p.id === 'detect' && (overdue > 0 || !!urgent?.due.urgent)) || (p.id === 'test' && wrapReady > 0);
          return (
            <button key={p.id} type="button" className={`watch-strip-cell${hot ? ' hot' : ''}`} onClick={() => { onTab('tracking'); if (p.id === 'detect' && urgent) onOpen(urgent.id); }} title={p.due}>
              <span className="watch-strip-step">{p.label}{i < PIPELINE.length - 1 ? <span className="watch-strip-arrow" aria-hidden>→</span> : null}</span>
              <span className="watch-strip-live"><strong>{list.length}</strong>건</span>
              <span className="watch-strip-foot">{foot[p.id]}</span>
            </button>
          );
        })}
      </div>
      <div className="watch-strip-sub">
        <button type="button" onClick={() => onTab('archive')}>경쟁사 변경 7일 <strong>{weekArc.length}</strong>건 · 영향도 높음 <strong>{weekArc.filter((r) => r.impact.level === 'high').length}</strong>건</button>
        <button type="button" onClick={() => onTab('serp')}>브랜드 지면 경쟁사 상위 노출 <strong>{w.brief.counts.serpAbove}</strong> / {w.serp.length} 키워드</button>
        <button type="button" onClick={() => onTab('external')}>{nextEv ? <>다음 일정 <strong>D-{nextEv.dday}</strong> {nextEv.label}</> : '120일 내 일정 없음'}</button>
        <button type="button" onClick={() => onTab('brief')}>주간 브리프 {w.brief.delivery}</button>
      </div>
    </Card>
  );
}
