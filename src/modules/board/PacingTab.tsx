/* 03 예산 소진 현황 — 월 예산(연 배분 ÷ 12) 대비 소진율 · 기대 소진율 마커 · 예상 월말 · 도달일, 캠페인별 일 예산 소진 · 예상 마감 */
import { useMemo, useState } from 'react';
import type { Dataset } from '@/core/types';
import { GFA_DELEGATION, MEDIA } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { Callout, Card, DataTable, Pill, ProgressBar, Segmented, Src, Stat, Swatch, type Column } from '@/ui/primitives';
import { budgetPacing, clock, type CampaignPaceRow, type MonthPaceRow } from './engine';
import { NumCell } from './parts';
import { BOARD_RULES } from './data';

const LEVEL_TONE = { critical: 'serious', warning: 'warning', ok: 'good', off: 'outline' } as const;

export function PacingTab({ d }: { d: Dataset }) {
  const p = useMemo(() => budgetPacing(d), [d]);
  const [scope, setScope] = useState<'all' | 'early'>('all');
  const m = p.month;
  const campaigns = scope === 'early' ? p.early : p.campaigns;
  const peak = p.early.filter((c) => c.missesPeak);

  const monthCols: Column<MonthPaceRow>[] = [
    { key: 'name', label: '매체', sort: (r) => r.name, render: (r) => <Swatch colorVar={r.colorVar} label={<strong className="small">{r.name}</strong>} /> },
    { key: 'budget', label: '월 예산', align: 'right', sort: (r) => r.budget, render: (r) => <NumCell value={fmt.krw(r.budget)} sub={`연 ${fmt.krw(MEDIA[r.media].annualBudget)} ÷ 12`} /> },
    { key: 'spent', label: '소진', align: 'right', sort: (r) => r.spent, render: (r) => <NumCell value={fmt.krw(r.spent)} /> },
    {
      key: 'pace', label: '소진율 · 기대 마커', sort: (r) => r.pacePct, width: 200,
      render: (r) => (
        <div className="stack-sm" style={{ gap: 3, minWidth: 160 }}>
          <ProgressBar value={Math.min(r.pacePct, 100)} marker={Math.min(r.expectedPct, 100)} tone={r.status === 'over' ? 'warning' : r.status === 'under' ? 'ink' : 'good'} label={`${r.name} 월 예산 소진율`} />
          <span className="xs num">{fmt.pct(r.pacePct, 1)}{r.pacePct > 100 ? ' (예산 초과)' : ''} <span className="muted">· 기대 {fmt.pct(r.expectedPct, 1)}</span></span>
        </div>
      ),
    },
    { key: 'proj', label: '예상 월말', align: 'right', sort: (r) => r.projectedPct, render: (r) => <NumCell value={fmt.pct(r.projectedPct, 0)} sub={fmt.krw(r.projected)} /> },
    {
      key: 'status', label: '판정', sort: (r) => r.projectedPct,
      render: (r) => (
        <div className="board-badge">
          <Pill tone={r.status === 'over' ? 'warning' : r.status === 'under' ? 'neutral' : 'good'} icon={r.status === 'ok' ? 'check' : 'alert'}>{r.statusLabel}</Pill>
          <span className="board-basis">{r.basis}</span>
        </div>
      ),
    },
    {
      key: 'reach', label: '예산 도달일',
      render: (r) => (r.reachedDate
        ? <div className="board-cell l"><span className="small num">{fmtDate(r.reachedDate)}</span><span className="board-sub">실측 · 누적 소진 ≥ 월 예산</span></div>
        : r.projectedReachDate
          ? <div className="board-cell l"><span className="small num">{fmtDate(r.projectedReachDate)}</span><span className="board-sub">현재 속도 기준 예상</span></div>
          : <span className="small muted">월 내 도달 없음</span>),
    },
    {
      key: 'next', label: `${p.media[0]?.next.month.slice(5) ?? ''}월 가이드`, align: 'right', sort: (r) => r.next.projectedPct,
      render: (r) => <NumCell value={`권장 ${fmt.krw(r.next.recommendedDaily)}/일`} sub={`최근 7일 ${fmt.krw(r.next.runRate7)}/일 유지 시 ${fmt.pct(r.next.projectedPct, 0)} · 조정 ${fmt.delta(r.next.adjustPct, 0)}`} />,
    },
  ];

  const campCols: Column<CampaignPaceRow>[] = [
    {
      key: 'name', label: '캠페인', sort: (r) => r.name,
      render: (r) => <div className="board-cell l"><Swatch colorVar={MEDIA[r.media].colorVar} label={<strong className="small">{r.name}</strong>} /><span className="board-sub">{MEDIA[r.media].name}</span></div>,
    },
    { key: 'budget', label: '일 예산', align: 'right', sort: (r) => r.dailyBudget, render: (r) => <NumCell value={fmt.krw(r.dailyBudget)} /> },
    { key: 'spent', label: `오늘 소진 (${d.currentHour}시)`, align: 'right', sort: (r) => r.spentToday, render: (r) => <NumCell value={fmt.krw(r.spentToday)} /> },
    {
      key: 'pace', label: '소진율 · 시간대 기대', sort: (r) => r.pacePct, width: 190,
      render: (r) => (
        <div className="stack-sm" style={{ gap: 3, minWidth: 150 }}>
          <ProgressBar value={Number.isFinite(r.pacePct) ? r.pacePct : 0} marker={r.expectedPct} tone={r.level === 'critical' ? 'critical' : r.level === 'warning' ? 'warning' : 'ink'} label={`${r.name} 일 예산 소진율`} />
          <span className="xs num">{fmt.pct(r.pacePct, 0)} <span className="muted">· 기대 {fmt.pct(r.expectedPct, 0)}</span></span>
        </div>
      ),
    },
    { key: 'ratio', label: '예상 수요', align: 'right', sort: (r) => r.projectedRatio, render: (r) => <NumCell value={fmt.ratio(r.projectedRatio, 0)} sub="일 예산 대비" /> },
    {
      key: 'exhaust', label: '예상 마감', align: 'right', sort: (r) => -(r.exhaustHour ?? 99),
      render: (r) => (
        <NumCell
          value={<strong>{r.exhaustHour !== null ? clock(r.exhaustHour) : r.status === 'off' ? '—' : '당일 마감 없음'}</strong>}
          sub={`${r.exhaustMethod && r.earlyExhaust ? `${r.exhaustMethod} 기준 · ` : ''}시간대 ${r.status === 'off' ? '—' : r.curveExhaustHour === null ? '마감 없음' : clock(r.curveExhaustHour)} / 선형 ${r.status === 'off' ? '—' : r.linearExhaustHour === null ? '마감 없음' : clock(r.linearExhaustHour)}`}
        />
      ),
    },
    { key: 'short', label: '부족 예상', align: 'right', sort: (r) => r.shortfall, render: (r) => (r.shortfall >= r.dailyBudget * 0.01 ? <NumCell value={fmt.krw(r.shortfall)} /> : <span className="xs muted">—</span>) },
    {
      key: 'level', label: '판정', sort: (r) => ({ critical: 0, warning: 1, ok: 2, off: 3 }[r.level]),
      render: (r) => (
        <div className="board-badge">
          <Pill tone={LEVEL_TONE[r.level]} icon={r.level === 'ok' ? 'check' : r.level === 'off' ? undefined : 'clock'}>{r.label}</Pill>
          <span className="board-basis">{r.basis}</span>
        </div>
      ),
    },
  ];

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card title={`${m.key.replace('-', '.')} 월 예산 소진`} sub={`연 배분 ÷ 12 · ${fmtDate(d.today)} ${d.currentHour}시 기준${m.isLastDay ? ' · 월 마지막 날' : ` · 잔여 ${m.daysLeft}일`}`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.13 · p.37" /></>}>
          <Stat label="소진 / 월 예산" value={`${fmt.krw(m.spent)} / ${fmt.krw(m.budget)}`} foot={<span className="muted">예상 월말 {fmt.krw(m.projected)}</span>} />
          <ProgressBar value={Math.min(m.pacePct, 100)} marker={Math.min(m.expectedPct, 100)} tone={m.status === 'over' ? 'warning' : 'good'} label="월 예산 소진율" />
          <div className="row-between xs"><span className="num">소진율 {fmt.pct(m.pacePct, 1)}{m.pacePct > 100 ? ' · 월 예산 초과' : ''}</span><span className="muted num">기대 소진율 {fmt.pct(m.expectedPct, 1)} (세로 마커)</span></div>
          <div className="board-badge">
            <Pill tone={m.status === 'over' ? 'warning' : m.status === 'under' ? 'neutral' : 'good'} icon={m.status === 'ok' ? 'check' : 'alert'}>{m.statusLabel}</Pill>
            <span className="board-basis">{m.basis}</span>
          </div>
        </Card>
        <Card title="오늘 일 예산 조기 소진" sub={`${d.currentHour}시 기준 · ${BOARD_RULES.exhaustBeforeHour}시 전 마감 예상 · 시간대 가중`} actions={<Src kind="DEMO" />}>
          <div className="row" style={{ gap: 18 }}>
            <Stat label="조기 소진 예상" value={`${p.early.length}개`} foot={<span className="muted">전체 {p.campaigns.length}개 캠페인</span>} />
            <Stat label={`피크(${BOARD_RULES.peakStartHour}~23시) 전 소진`} value={`${peak.length}개`} foot={<span className="muted">부족 예상 {fmt.krw(peak.reduce((a, c) => a + c.shortfall, 0))}</span>} />
          </div>
          {p.early.length ? (
            <div className="board-list">
              {p.early.slice(0, 4).map((c) => (
                <div key={c.id} className="board-list-item">
                  <Pill tone={LEVEL_TONE[c.level]} icon="clock">{clock(c.exhaustHour)}</Pill>
                  <span className="small"><strong>{c.name}</strong> <span className="muted">· 소진 {fmt.pct(c.pacePct, 0)}</span></span>
                  <span className="xs muted nowrap">{c.label}</span>
                </div>
              ))}
            </div>
          ) : <span className="small muted">{BOARD_RULES.exhaustBeforeHour}시 전 마감 예상 캠페인이 없습니다.</span>}
        </Card>
        <Card title="조정 경로" sub="재배분 · 입찰 조정안은 AD Pilot, 승인은 위임 범위(p.15)" actions={<Src kind="PROPOSAL" page="p.14 · p.15 · p.18" />}>
          <div className="board-list">
            {GFA_DELEGATION.map((g) => (
              <div key={g.approver} className="board-list-item">
                <Pill tone="outline">{g.label}</Pill>
                <span className="small">{g.range}</span>
                <span />
              </div>
            ))}
          </div>
          <div className="xs muted">14:00 예산 소진율 점검 · 조정(p.18) 시점에 조기 소진 캠페인의 재배분안을 만들고, 16:30 익일 조정안으로 공유합니다.</div>
          <a className="btn sm" href="#adpilot" style={{ alignSelf: 'flex-start' }}>AD Pilot 예산 재배분 · 입찰 조정 열기</a>
        </Card>
      </div>

      {peak.length ? (
        <Callout tone="warning" title={`피크 시간 전 예산 마감 예상 ${peak.length}개 캠페인`}>
          {peak.map((c) => `${c.name} ${clock(c.exhaustHour)} 마감 예상(${c.exhaustMethod ?? '시간대 가중'} · 소진 ${fmt.pct(c.pacePct, 0)} · 시간대 기대 ${fmt.pct(c.expectedPct, 0)} · 부족 ${fmt.krw(c.shortfall)})`).join(' / ')}. 시간대 가중 예상은 최근 {BOARD_RULES.curveDays}일 같은 매체의 시간대별 소진 곡선 기준이며, 남은 시간대의 소진 비중이 클수록 선형 추정(현재까지 시간당 평균 유지)보다 이른 시각이 나옵니다.
        </Callout>
      ) : null}

      <Card title="캠페인별 일 예산 소진" sub={`예상 마감 = 오늘 ${d.currentHour}시까지 소진 ÷ 시간대 누적 기대치로 추정한 예산 도달 시각 · 선형 = 현재까지 시간당 평균 속도 유지 가정 · 둘 중 ${BOARD_RULES.exhaustBeforeHour}시 전 마감이 있으면 조기 소진`}
        actions={<><Segmented options={[{ id: 'all', label: `전체 ${p.campaigns.length}` }, { id: 'early', label: `조기 소진 ${p.early.length}` }]} value={scope} onChange={setScope} label="캠페인 범위" /><Src kind="DEMO" /></>}>
        <DataTable rows={campaigns} columns={campCols} rowKey={(r) => r.id} initialSort={{ key: 'level', dir: 'asc' }} empty="조기 소진 예상 캠페인이 없습니다" />
      </Card>

      <Card title="매체별 월 예산 소진" sub={`월 예산 = 연 배분(p.37) ÷ 12 · 세로 마커 = 기대 소진율(경과일 ÷ 월 일수) · 판정 기준 예상 월말 ${Math.round(BOARD_RULES.monthOverRatio * 100)}% 초과 / ${Math.round(BOARD_RULES.monthUnderRatio * 100)}% 미만`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.37" /></>}>
        <DataTable rows={p.media} columns={monthCols} rowKey={(r) => r.media} initialSort={{ key: 'budget', dir: 'desc' }} />
        <div className="xs muted">다음 달 가이드는 다음 달 예산 ÷ 일수를 권장 일 예산으로 두고, 최근 7일 일평균을 유지했을 때의 예상 소진율을 함께 보여줍니다. 월 단위 재배분은 수면밀도 승인 사항입니다(p.53).</div>
      </Card>
    </div>
  );
}
