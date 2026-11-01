/* p.54 · p.20 계정 인수 · 90일 온보딩 */
import { useMemo } from 'react';
import { useStore } from '@/core/store';
import { fmt } from '@/core/util';
import { Gantt } from '@/ui/charts';
import { Button, Callout, Card, CopyButton, DownloadButton, Field, Pill, Src, Stat } from '@/ui/primitives';
import { DEFAULT_KICKOFF, ONBOARDING_PRINCIPLES } from './data';
import { ddayLabel, onboardingMarkdown, onboardingPlan, performanceBaseline, shortDate } from './engine';
import type { OpsLocal } from './local';

export function OnboardingTab({ local, patch }: { local: OpsLocal; patch: (p: Partial<OpsLocal>) => void }) {
  const { state } = useStore();
  const d = state.data;
  const plan = useMemo(() => onboardingPlan(local.kickoff, d.today), [local.kickoff, d.today]);
  const base = useMemo(() => performanceBaseline(d), [d]);
  const ganttRows = plan.tasks.map((t) => ({ task: t.task, start: t.start, end: t.end, tone: t.task.startsWith('병행') ? ('accent' as const) : undefined }));

  return (
    <div className="stack-lg">
      <Card title="계정 인수 · 90일 온보딩" sub="기존 입찰 로직을 그대로 유지한 채 병행 운영하고, 검증이 끝난 영역부터 단계적으로 전환합니다"
        actions={<><Src kind="PROPOSAL" page="p.54" /><Src kind="PROPOSAL" page="p.20" /><CopyButton text={() => onboardingMarkdown(plan)} label="일정 복사" /><DownloadButton filename={`mildo-onboarding-${plan.kickoff}.md`} data={() => onboardingMarkdown(plan)} mime="text/markdown;charset=utf-8" label=".md" /></>}>
        <div className="row" style={{ alignItems: 'flex-end', gap: 14 }}>
          <Field label="Kick-off 날짜 (RFP: 협의)" id="ops-kickoff" hint={`최종 선정 및 계약 26.11.24 주차(${shortDate(plan.selection.weekStart)}~${shortDate(plan.selection.weekEnd)}) 이후 · 기본 ${DEFAULT_KICKOFF} 가정`}>
            <input id="ops-kickoff" type="date" className="input" style={{ width: 180 }} value={plan.kickoff} onChange={(e) => e.target.value && patch({ kickoff: e.target.value })} />
          </Field>
          {local.kickoff !== DEFAULT_KICKOFF ? <Button size="sm" icon="rollback" onClick={() => patch({ kickoff: DEFAULT_KICKOFF })}>기본 가정으로</Button> : null}
          <div className="row" style={{ gap: 6 }}>
            {plan.kickoffOff.off ? <Pill tone="warning" icon="alert">Kick-off가 휴무일({plan.kickoffOff.label})</Pill> : <Pill tone="neutral">{shortDate(plan.kickoff)} 영업일</Pill>}
            {plan.selection.beforeSelection ? <Pill tone="critical" icon="x">최종 선정 주 이전 날짜</Pill> : <Pill tone="neutral">선정 주 종료 후 {plan.selection.gapDays}일</Pill>}
            <Pill tone="outline">기준일 {shortDate(d.today)} → Kick-off {ddayLabel(plan.daysToKickoff)}</Pill>
          </div>
        </div>
        <div className="ops-mile">
          <div className="ops-mile-item kick"><span className="xs muted">Kick-off · W1 시작</span><span className="ops-mile-date">{shortDate(plan.kickoff)}</span><span className="xs muted">{plan.kickoff}</span></div>
          {plan.milestones.map((m) => (
            <div key={m.label} className="ops-mile-item">
              <span className="xs muted">W{m.week} · {m.label.split(' ')[0]}</span>
              <span className="ops-mile-date">{shortDate(m.date)}</span>
              <span className="xs">{m.label.split(' ').slice(1).join(' ')}</span>
              {m.off.off ? <span className="xs"><Pill tone="warning" icon="calendar">{m.off.label} · 보고 {shortDate(m.reportDay)}</Pill></span> : null}
            </div>
          ))}
        </div>
        <Gantt weeks={12} rows={ganttRows} milestones={[...plan.milestones.map((m) => ({ week: m.week, label: m.label }))]} current={plan.currentWeek ?? undefined} />
        <div className="xs muted">
          {plan.currentWeek ? `현재 W${plan.currentWeek} 진행 중 (분홍 세로선).` : `기준일 ${shortDate(d.today)}은 Kick-off 전입니다.`} 분홍 막대: 병행 운영 · 기존 로직 유지 구간 (성과 공백 최소화).
          {plan.holidays.length ? ` 기간 내 공휴일: ${plan.holidays.map((h) => `W${h.week} ${shortDate(h.date)} ${h.label}`).join(' · ')} — 주말 · 공휴일 당번 체계 적용.` : ''}
        </div>
      </Card>

      <div className="grid g-3">
        {plan.phases.map((ph) => (
          <Card key={ph.id} title={ph.label} sub={`${shortDate(ph.from)} ~ ${shortDate(ph.to)}`} actions={<Src kind="PROPOSAL" page="p.20" />}>
            <ul className="ops-issues">
              {ph.items.map((it) => <li key={it}><Pill tone="outline">작업</Pill><span>{it}</span></li>)}
            </ul>
            <div className="small"><strong>측정 기준</strong> · {ph.metric}</div>
          </Card>
        ))}
      </div>

      <div className="grid g-2">
        <Card title="성과 공백 최소화 원칙" actions={<Src kind="PROPOSAL" page="p.54" />}>
          <ul className="ops-issues">
            {ONBOARDING_PRINCIPLES.map((p) => <li key={p.title}><Pill tone="dark">{p.title}</Pill><span>{p.text}</span></li>)}
          </ul>
          <Callout tone="info" title="AD Pilot 자동 조정은 W8 이후 단계 적용">
            W1–W8은 기존 입찰 로직을 보존한 병행 운영 구간입니다. 자동 조정 전환 전에 D+60 일간 루틴 재현(리포트 · 알림 자동화 가동)을 확인합니다.
          </Callout>
        </Card>
        <Card title="D+30 측정 기준 · 성과 기준선 후보" sub={`'전월 대비 성과 유지' 판정용 · ${base.label} ${base.from} ~ ${base.to}`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.20" /></>}>
          <div className="grid g-3">
            <Stat label="ROAS (기준선)" value={fmt.roas(base.roas)} foot={<span className="xs">하한 {fmt.roas(base.roasFloor)} · −{base.tolerancePct}%</span>} />
            <Stat label="CPA (기준선)" value={fmt.won(base.cpa)} foot={<span className="xs">상한 {fmt.won(base.cpaCeiling)} · +{base.tolerancePct}%</span>} />
            <Stat label="광고비 (30일)" value={fmt.krw(base.cost)} foot={<span className="xs">전환 {fmt.int(base.conversions)}건 · CVR {fmt.pct(base.cvr, 2)}</span>} />
          </div>
          <div className="xs muted">허용 폭 ±{base.tolerancePct}%는 운영 가정이며 D+30 기준선 확정 시 수수료 · 계약과 별개로 수면밀도와 합의합니다. 실데이터 연동 전에는 시연용 테스트 데이터로 계산됩니다.</div>
        </Card>
      </div>

      <Card title="주차별 날짜 환산" sub="W1~W12 · 공휴일 · 휴무일 수">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>주차</th><th>기간</th><th>진행 작업</th><th className="r">휴무일</th><th>공휴일</th></tr></thead>
            <tbody>
              {plan.weeks.map((w) => (
                <tr key={w.week} className={plan.currentWeek === w.week ? 'selected' : undefined}>
                  <td className="small"><strong>W{w.week}</strong>{plan.milestones.find((m) => m.week === w.week) ? <span className="xs accent"> · {plan.milestones.find((m) => m.week === w.week)!.label.split(' ')[0]}</span> : null}</td>
                  <td className="small num">{shortDate(w.start)} ~ {shortDate(w.end)}</td>
                  <td className="xs">{plan.tasks.filter((t) => t.start <= w.week && t.end >= w.week).map((t) => t.task).join(' · ')}</td>
                  <td className="r">{w.offDays}일</td>
                  <td className="xs">{w.holidays.map((h) => `${shortDate(h.date)} ${h.label}`).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
