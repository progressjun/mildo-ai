/**
 * 리포트 · 데이터 시간표 · 절감 실측 — 제안서 p.17–20 (Pro-board 분석 · 리포팅)
 * 리포트 4종 발송 현황 → 리포트(문서형 · 메신저형 · AE 코멘트 · 코멘트 단위 피드백 · AI 해석) / 데이터 제공 시간표 / SA 업무 절감 · 90일 일정
 * 성과 수치는 모두 state.data(시연용 테스트 데이터)에서 계산한다. AI는 버튼을 누를 때만 호출한다.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '@/core/store';
import { useLab } from '@/modules/lab/store';
import { fmtDate, monthKey } from '@/core/util';
import { PageHeader, Pill, Src, Tabs } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { availableMonths, buildTimetable, cadenceStatus, computeSavings, dataNowMinutes, generateReport, type IssueLike, type ReportType } from './engine';
import { ReportsTab, type Interp } from './ReportsTab';
import { TimetableTab } from './TimetableTab';
import { DEFAULT_SAVINGS_INPUTS, SavingsTab, type SavingsInputs } from './SavingsTab';
import './styles.css';

type TabId = 'reports' | 'timetable' | 'savings';

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export default function View() {
  const { state } = useStore();
  const d = state.data;
  const incidents = state.incidents as IssueLike[];
  const changes = state.changes;
  // 키워드 테스트 판정 기준은 MILDO Lab 화면의 현재 기준을 그대로 쓴다 (Lab과 같은 판정)
  const labCriteria = useLab().criteria;
  const [tab, setTab] = useState<TabId>('reports');
  const [type, setType] = useState<ReportType>('daily');
  const months = useMemo(() => availableMonths(d), [d]);
  const [month, setMonth] = useState<string>(() => months[0] ?? monthKey(d.today));
  const [issueId, setIssueId] = useState<string | null>(null);
  const [interps, setInterps] = useState<Record<string, Interp>>({});
  const [savings, setSavings] = useState<SavingsInputs>(DEFAULT_SAVINGS_INPUTS);

  const { report, genMs } = useMemo(() => {
    const t0 = now();
    const r = generateReport(type, d, { incidents, month, selectedIssueId: issueId, changes, labCriteria });
    return { report: r, genMs: now() - t0 };
  }, [type, d, incidents, month, issueId, changes, labCriteria]);
  const cadence = useMemo(() => cadenceStatus(d, incidents, changes), [d, incidents, changes]);
  const tt = useMemo(() => buildTimetable(d, { offHours: state.offHoursMode, incidents, changes }), [d, state.offHoursMode, incidents, changes]);
  const sv = useMemo(() => computeSavings({ before: savings.before, measured: savings.measured, mode: savings.mode }), [savings.before, savings.measured, savings.mode]);

  const interpKey = `${type}|${report.title}`;
  const setInterp = useCallback((key: string, v: Interp | null) => setInterps((p) => {
    const next = { ...p };
    if (v) next[key] = v; else delete next[key];
    return next;
  }), []);
  const setSavingsInputs = useCallback((f: (p: SavingsInputs) => SavingsInputs) => setSavings(f), []);

  const sendLabel = type === 'daily' ? `${fmtDate(d.today)} 08:00 발송분` : type === 'weekly' ? `${report.nextSend} 발송 예정` : type === 'monthly' ? report.schedule : `감지 즉시 · ${report.periodLabel}`;
  const nowMin = dataNowMinutes(d);
  const openP1 = cadence.find((c) => c.type === 'issue')?.alert ?? 0;
  const pickReport = (t: ReportType) => { setType(t); setTab('reports'); };

  const tabs: { id: TabId; label: ReactNode; badge?: ReactNode }[] = [
    { id: 'reports', label: '리포트 4종', badge: openP1 ? <Pill tone="critical">P1 {openP1}</Pill> : undefined },
    { id: 'timetable', label: '데이터 제공 시간표', badge: <Pill tone="neutral">{tt.done}/{tt.items.length}</Pill> },
    { id: 'savings', label: '절감 실측 · 90일 일정', badge: <Pill tone="neutral" title={`${sv.verdict.label} · ${sv.verdict.basis}`}>목표 −{Math.round(sv.reductionPct)}%</Pill> },
  ];

  return (
    <div className="page reports-page">
      <PageHeader
        eyebrow="02 RESOURCE SAVING & DATA AUTOMATION · REPORTING"
        title="리포트 · 데이터 시간표"
        sub="보고서는 시스템이 만들고, 담당 AE는 해석과 다음 액션을 덧붙입니다. 수면밀도 업무시간 08~17시에 맞춰 출근 전에 데이터가 준비되고 퇴근 전에 다음 날 계획이 공유됩니다."
        sources={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.17–20" /><span className="xs muted">데이터 기준 {fmtDate(d.today)} {hhmm(nowMin)} · {tt.off ? `${tt.offLabel} (주말 · 공휴일 규칙 적용)` : '평일'}</span></>}
      />

      <div className="row-between reports-noprint">
        <span className="small ink2">리포트 4종 발송 현황 · 주기 · 채널은 제안서 기준, 발송 상태는 데이터 기준 시각 기준</span>
        <span className="row" style={{ gap: 6 }}><Src kind="PROPOSAL" page="p.17" /><Src kind="DEMO" /></span>
      </div>
      <div className="reports-cadence reports-noprint" role="group" aria-label="리포트 4종 발송 현황">
        {cadence.map((c) => (
          <button key={c.type} type="button" className="reports-cad" aria-pressed={tab === 'reports' && type === c.type} onClick={() => pickReport(c.type)}>
            <span className="reports-cad-name">{c.name}<span className="reports-cad-when">{c.when} · {c.channel}</span></span>
            <span className="reports-cad-content">{c.content}</span>
            <span className="row" style={{ gap: 6 }}>
              {c.state === 'sent' ? <Pill tone="good" icon="check">{c.stateLabel}</Pill>
                : c.state === 'live' ? <Pill tone={c.alert ? 'critical' : 'neutral'} icon={c.alert ? 'alert' : 'bell'}>{c.stateLabel}</Pill>
                  : <Pill tone="outline" icon="clock">{c.stateLabel}</Pill>}
            </span>
            <span className="reports-cad-foot"><Icon name="report" size={12} />{c.detail}</span>
          </button>
        ))}
      </div>

      <Tabs<TabId> tabs={tabs} value={tab} onChange={setTab} id="reports-tabs" />

      {tab === 'reports' ? (
        <ReportsTab
          type={type} report={report} genMs={genMs}
          month={month} setMonth={setMonth} issueId={issueId} setIssueId={setIssueId}
          interpKey={interpKey} interp={interps[interpKey] ?? null} setInterp={setInterp} sendLabel={sendLabel}
        />
      ) : null}
      {tab === 'timetable' ? <TimetableTab /> : null}
      {tab === 'savings' ? <SavingsTab today={d.today} inputs={savings} setInputs={setSavingsInputs} /> : null}
    </div>
  );
}
