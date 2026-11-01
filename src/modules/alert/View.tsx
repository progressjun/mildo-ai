/**
 * MILDO Alert — 운영 안정성 (제안서 p.43–50, p.10 긴급 검수 알림)
 * 감지 → 배정 → 조치 → 보고 → 재발 방지. 모든 수치는 시연용 TEST DATA.
 */
import { useMemo, useState } from 'react';
import './styles.css';
import { SAFETY_NET } from '@/data/constants';
import { Button, Card, PageHeader, Pill, Src, Tabs } from '@/ui/primitives';
import { fmtDateShort, holidayPrecheck, offBlocks, sevCounts, slaState, fmtRemain, dayDiff, type AlertIncident } from './engine';
import { RULES } from './data';
import { useAlert, type AlertCtx } from './hooks';
import { QueueTab } from './QueueTab';
import { IncidentDrawer } from './IncidentDrawer';
import { NotifyTab } from './NotifyTab';
import { AnomalyTab } from './AnomalyTab';
import { RulesTab } from './RulesTab';
import { HolidayTab } from './HolidayTab';
import { AccountsTab } from './AccountsTab';
import { SlaTab } from './SlaTab';

type TabId = 'queue' | 'notify' | 'anomaly' | 'rules' | 'holiday' | 'accounts' | 'sla';

export default function View() {
  const ctx = useAlert();
  const { state, actions, data, incidents, regime, nameOf } = ctx;
  const [tab, setTab] = useState<TabId>('queue');
  const [openId, setOpenId] = useState<string | null>(null);
  const counts = sevCounts(incidents);

  // 대량 변경 실수 (p.45) 감지는 앱 셸(Shell)에서 상시 실행 — 이 화면이 닫혀 있어도 이슈로 적재된다.

  return (
    <div className="page">
      <PageHeader
        eyebrow="05 OPERATIONAL STABILITY · MILDO ALERT"
        title="MILDO Alert"
        sub="API · 광고 상태 데이터로 이상을 먼저 찾아 원인 요약과 다음 조치를 함께 보냅니다. 등급별 SLA, 주말 · 공휴일 당번, 계정 · 결제 점검, 같은 양식의 조치 보고까지 한 화면에서 처리합니다."
        sources={<><Src kind="PROPOSAL" page="p.43–50" /><Src kind="DEMO" /><span className="xs muted">데이터 기준 {fmtDateShort(data.today)} {String(data.currentHour).padStart(2, '0')}:30 · 수치 기준은 초기값 (온보딩 중 오탐률 보며 조정, p.44)</span></>}
        actions={
          <>
            <Pill tone={regime.off ? 'dark' : 'neutral'} icon="calendar">
              {regime.off ? `주말 · 공휴일 체계 (${regime.label}) · 당번 ${nameOf(regime.duty?.role)}` : '평일 운영 체계'}
            </Pill>
            <Button size="sm" icon="refresh" onClick={() => ctx.rescan()}>재스캔</Button>
          </>
        }
      />
      <SafetyStrip ctx={ctx} onTab={setTab} />
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'queue', label: '이슈 큐', badge: counts.open ? <Pill tone={counts.P1 ? 'critical' : 'warning'}>{counts.open}</Pill> : undefined },
          { id: 'notify', label: '알림 · 테스트 주입' },
          { id: 'anomaly', label: '이상 징후' },
          { id: 'rules', label: '탐지 기준' },
          { id: 'holiday', label: '주말 · 공휴일' },
          { id: 'accounts', label: '계정 · 결제 · 권한' },
          { id: 'sla', label: 'SLA 리포트' },
        ]}
      />
      {tab === 'queue' ? <QueueTab ctx={ctx} onOpen={setOpenId} /> : null}
      {tab === 'notify' ? <NotifyTab ctx={ctx} onOpen={setOpenId} /> : null}
      {tab === 'anomaly' ? <AnomalyTab ctx={ctx} onOpen={setOpenId} /> : null}
      {tab === 'rules' ? <RulesTab ctx={ctx} /> : null}
      {tab === 'holiday' ? <HolidayTab ctx={ctx} onOpen={setOpenId} /> : null}
      {tab === 'accounts' ? <AccountsTab ctx={ctx} onOpen={setOpenId} /> : null}
      {tab === 'sla' ? <SlaTab ctx={ctx} /> : null}
      {openId ? <IncidentDrawer key={openId} ctx={ctx} id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

/** p.43 5단계 안전망 — 각 단계의 현재 상태를 함께 표시 */
function SafetyStrip({ ctx, onTab }: { ctx: AlertCtx; onTab: (t: TabId) => void }) {
  const { data, incidents, nowMs, toMs, state, cfg, tfNames } = ctx;
  const blocks = useMemo(() => offBlocks(data.today, 120), [data.today]);
  const cur = blocks[0];
  const long = blocks.find((b) => b.days >= 3 && b.start > data.today);
  const pre = useMemo(() => (cur ? holidayPrecheck(data, cur, { config: cfg, tfNames }) : null), [data, cur, cfg, tfNames]);
  const fails = pre?.items.filter((i) => i.level === 'fail').length ?? 0;
  const open = incidents.filter((i) => i.status !== 'resolved');
  const p1 = open.filter((i) => i.severity === 'P1');
  const urgent = [...p1].map((i) => ({ i, st: slaState(i, nowMs, toMs, state.offHoursMode) })).sort((a, b) => (a.st.remainingMin ?? 1e9) - (b.st.remainingMin ?? 1e9))[0];
  const reportable = incidents.filter((i) => i.severity !== 'P3');
  const reported = reportable.filter((i) => (i as AlertIncident).sla?.reportAt).length;
  const ruleChanges = state.changes.filter((c) => c.kind === 'alert_rule');
  const recurring = open.filter((i) => i.recurrence?.count).length;
  const cells = [
    { tab: 'holiday' as TabId, live: <><strong>{fails}</strong>건 점검 실패 · {cur ? `${fmtDateShort(cur.start)}~${fmtDateShort(cur.end)}` : '—'}</>, foot: long ? `다음 연휴 ${fmtDateShort(long.start)} ${long.labels.find((l) => l !== '토요일' && l !== '일요일') ?? ''} · D-${dayDiff(long.start, data.today)}` : '', hot: fails > 0 },
    { tab: 'anomaly' as TabId, live: <><strong>{incidents.filter((i) => i.detectedAt.startsWith(data.today)).length}</strong>건 감지 · 규칙 {Object.keys(RULES).length}개</>, foot: `최근 ${cfg.windowHours}시간 동요일 · 동시간 비교`, hot: false },
    { tab: 'queue' as TabId, live: <><strong>{p1.length}</strong>건 P1 열림</>, foot: urgent ? `${urgent.st.stageLabel} · ${fmtRemain(urgent.st.remainingMin)}` : 'P1 없음', hot: p1.length > 0 },
    { tab: 'sla' as TabId, live: <><strong>{reported}</strong>/ {reportable.length} 보고 완료</>, foot: 'p.49 이슈 보고서 양식 · 월간 SLA 공개', hot: false },
    { tab: 'rules' as TabId, live: <><strong>{ruleChanges.length}</strong>건 기준 변경 요청</>, foot: `재발 이슈 ${recurring}건 · 대기 ${ruleChanges.filter((c) => c.status === 'pending').length}건`, hot: recurring > 0 },
  ];
  return (
    <Card tone="dark" className="no-print">
      <div className="row-between">
        <span className="xs" style={{ color: 'var(--panel-muted)', letterSpacing: '0.12em' }}>5단계 안전망 · SAFETY NET</span>
        <Src kind="PROPOSAL" page="p.43" />
      </div>
      <div className="alert-strip">
        {SAFETY_NET.map((s, k) => (
          <button key={s.step} type="button" onClick={() => onTab(cells[k].tab)} className={`alert-strip-cell${cells[k].hot ? ' hot' : ''}`} title="해당 탭으로 이동">
            <span className="alert-strip-step">{s.step}{k < SAFETY_NET.length - 1 ? <span className="alert-strip-arrow" aria-hidden>→</span> : null}</span>
            <span className="alert-strip-detail">{s.detail}</span>
            <span className="alert-strip-live">{cells[k].live}</span>
            <span className="alert-strip-detail">{cells[k].foot}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
