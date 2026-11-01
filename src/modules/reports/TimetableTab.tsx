/* 데이터 제공 시간표 (p.18) — 07:00 → 17:00, 수면밀도 업무시간 08–17, 주말 · 공휴일 규칙 */
import { useMemo, useState } from 'react';
import { useStore } from '@/core/store';
import { fmtDate, KR_HOLIDAYS } from '@/core/util';
import { Button, Card, Pill, Src, Stat, Toggle } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { buildTimetable, nextBusinessDay, upcomingOffBlocks, type TimetableItem } from './engine';
import { TIMELINE_RANGE, TIMETABLE_META } from './data';
import { LevelPill } from './parts';

const pos = (min: number) => `${Math.max(0, Math.min(100, ((min - TIMELINE_RANGE.from) / (TIMELINE_RANGE.to - TIMELINE_RANGE.from)) * 100))}%`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function StatusPill({ it }: { it: TimetableItem }) {
  if (it.offMode === 'moved') return <Pill tone="warning" icon="calendar">{it.statusLabel}</Pill>;
  if (it.offMode === 'merged') return <Pill tone="neutral" icon="calendar">{it.statusLabel}</Pill>;
  if (it.status === 'done') return <Pill tone="good" icon="check">완료</Pill>;
  if (it.status === 'now') return <Pill tone="accent" icon="clock">진행 중</Pill>;
  return <Pill tone="outline" icon="clock">예정</Pill>;
}

export function TimetableTab() {
  const { state, dispatch } = useStore();
  const d = state.data;
  const [date, setDate] = useState(d.today);
  const t = useMemo(() => buildTimetable(d, { date, offHours: state.offHoursMode, incidents: state.incidents, changes: state.changes }), [d, date, state.offHoursMode, state.incidents, state.changes]);
  const nbd = nextBusinessDay(d.today);
  const nextHoliday = Object.keys(KR_HOLIDAYS).sort().find((x) => x > d.today);
  const blocks = useMemo(() => upcomingOffBlocks(d.today, 70).slice(0, 5), [d.today]);
  const next = t.items.find((i) => i.status !== 'done');
  const ticks = Array.from({ length: 11 }, (_, i) => (7 + i) * 60);

  return (
    <div className="stack-lg">
      <div className="row-between reports-noprint">
        <div className="row" style={{ gap: 6 }}>
          <span className="small muted">기준일</span>
          <Button size="sm" variant={date === d.today ? 'primary' : 'default'} onClick={() => setDate(d.today)}>오늘 {fmtDate(d.today)}</Button>
          <Button size="sm" variant={date === nbd ? 'primary' : 'default'} onClick={() => setDate(nbd)}>다음 영업일 {fmtDate(nbd)}</Button>
          {nextHoliday ? <Button size="sm" variant={date === nextHoliday ? 'primary' : 'default'} onClick={() => setDate(nextHoliday)}>공휴일 {fmtDate(nextHoliday)} {KR_HOLIDAYS[nextHoliday]}</Button> : null}
          <input id="reports-tt-date" type="date" className="input" aria-label="기준일 선택" style={{ width: 150, padding: '4px 8px' }} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <Toggle id="reports-offhours" checked={state.offHoursMode} onChange={(v) => dispatch({ type: 'offhours/set', on: v })} label="주말 · 공휴일 모드 시뮬레이션 (MILDO Alert와 공유)" />
      </div>

      <div className="grid g-4">
        <Card>
          <Stat label="기준 시각" value={t.nowMinutes !== null ? hhmm(t.nowMinutes) : fmtDate(t.date)} foot={<span>{fmtDate(t.date)} · {t.off ? t.offLabel : '평일'}</span>} src={<Src kind="DEMO" />} />
        </Card>
        <Card>
          <Stat label="시간표 진행" value={`${t.done} / ${t.items.length}`} foot={<span>완료 {t.done} · 남음 {t.upcoming}</span>} />
        </Card>
        <Card>
          <Stat label="다음 항목" value={next ? next.effectiveTime : '—'} foot={next ? <span>{next.title}{next.effectiveDate !== t.date ? ` · ${fmtDate(next.effectiveDate)}` : ''}</span> : <span>오늘 항목 모두 완료</span>} />
        </Card>
        <Card>
          <Stat label="수면밀도 업무시간" value="08–17" foot={<span>{t.inBusinessHours === null ? '기준일 외 날짜' : t.inBusinessHours ? '업무시간 중' : t.off ? `업무시간 외 · ${t.offLabel}` : '업무시간 외'}</span>} src={<Src kind="PROPOSAL" page="p.18" />} />
        </Card>
      </div>

      <Card title="데이터 제공 시간표" sub="출근 전에 데이터가 준비되고 퇴근 전에 다음 날 계획이 공유됩니다." actions={<><Src kind="PROPOSAL" page="p.18" />{t.off ? <Pill tone="warning" icon="calendar">{t.offLabel} · 이슈 브리핑 {fmtDate(t.nextBusinessDay)} 09:30</Pill> : null}</>}>
        <div className="reports-tt" role="img" aria-label={`데이터 제공 시간표 ${t.items.map((i) => `${i.time} ${i.title} ${i.statusLabel}`).join(', ')}`}>
          <div className={`reports-tt-band${t.off ? ' off' : ''}`} style={{ left: pos(t.band.from), width: `calc(${pos(t.band.to)} - ${pos(t.band.from)})` }}>
            <span className="reports-tt-band-label">{t.off ? `업무시간 외 · ${t.offLabel} (자동 수집 · 발송 · Alert 감지는 계속)` : '수면밀도 업무시간 08–17'}</span>
          </div>
          <div className="reports-tt-axis" />
          <div className="reports-tt-ticks">{ticks.map((m) => <span key={m} className="reports-tt-tick" style={{ left: pos(m) }}>{m / 60}시</span>)}</div>
          {t.nowMinutes !== null ? <div className="reports-tt-now" style={{ left: pos(t.nowMinutes) }}><span>현재 {hhmm(t.nowMinutes)}</span></div> : null}
          {t.items.map((it, i) => (
            <div key={it.time}>
              <span className={`reports-tt-dot ${it.offMode === 'moved' ? 'moved' : it.status}`} style={{ left: pos(it.minutes) }} title={`${it.time} ${it.title} · ${it.statusLabel}`} />
              <div className={`reports-tt-label ${i % 2 === 0 ? 'top' : 'bottom'}${it.offMode === 'moved' ? ' moved' : ''}${it.minutes - TIMELINE_RANGE.from < 60 ? ' edge-l' : TIMELINE_RANGE.to - it.minutes < 60 ? ' edge-r' : ''}`} style={{ left: pos(it.minutes) }}>
                {i % 2 === 0 ? null : <strong>{it.time}</strong>}
                <span className="t">{it.title}</span>
                <span className="s">{it.offMode === 'moved' ? it.statusLabel : `${it.channel} · ${it.statusLabel}`}</span>
                {i % 2 === 0 ? <strong>{it.time}</strong> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="legend">
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--good)' }} />완료</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--accent)' }} />진행 중 · 현재 시각</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--surface)', boxShadow: '0 0 0 2px var(--ink-2)' }} />예정</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--warning)' }} />다음 영업일 이동</span>
        </div>
      </Card>

      <Card title="항목별 리드타임 · 채널 · 산출물" sub={t.isToday ? `산출물은 ${fmtDate(d.today)} 데이터로 계산한 결과입니다.` : '기준일이 데이터 기준일과 달라 산출물은 일정만 표시합니다.'} actions={<Src kind="DEMO" />}>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>시각</th><th>항목</th><th>채널</th><th>데이터 범위</th><th>리드타임</th><th>상태</th><th>산출물 (데이터 계산)</th></tr>
            </thead>
            <tbody>
              {t.items.map((it) => (
                <tr key={it.time}>
                  <td className="num"><strong>{it.time}</strong>{it.effectiveTime !== it.time || it.effectiveDate !== t.date ? <div className="xs muted">→ {fmtDate(it.effectiveDate)} {it.effectiveTime}</div> : null}</td>
                  <td>
                    <div><strong>{it.title}</strong></div>
                    <div className="xs muted">{it.detail}</div>
                    {it.offNote ? <div className="xs" style={{ color: 'var(--warning-ink)' }}>{it.offNote}</div> : null}
                  </td>
                  <td><Pill tone="outline">{it.channel}</Pill><div className="xs muted">{it.owner === 'system' ? '자동' : '담당 AE'}</div></td>
                  <td className="small">{it.scope}</td>
                  <td className="small">{it.lead}</td>
                  <td><StatusPill it={it} /></td>
                  <td style={{ minWidth: 240 }}>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      {t.isToday ? <LevelPill level={it.outputLevel} /> : null}
                      <span className="small">{it.output}</span>
                    </div>
                    <a className="xs reports-noprint" href={`#${it.route}`}>{TIMETABLE_META[it.time]?.page ?? 'p.18'} · 화면 열기 →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card tone="dark" title="리포트별 리드타임" sub="제안서 p.18 하단 · 감지 즉시부터 익월 3영업일까지" actions={<Src kind="PROPOSAL" page="p.17 · p.18" />}>
        <div className="reports-lead">
          {t.sends.map((s) => (
            <div key={s.type} className="reports-lead-cell">
              <div className="reports-lead-name">{s.name} <em>{s.lead}</em></div>
              <div className="small">{s.when} · {s.channel}</div>
              <div className="reports-lead-next">다음 {s.next}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="주말 · 공휴일 규칙" actions={<><Src kind="PROPOSAL" page="p.44" /><Src kind="PROPOSAL" page="p.48" /></>}>
          <div className="stack-sm small">
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="calendar" size={15} /><span><strong>이슈 브리핑 09:30</strong> — 주말 · 공휴일이면 다음 영업일 09:30 브리핑으로 이동합니다. 야간 · 주말 이슈를 한 번에 정리합니다.</span></div>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="bell" size={15} /><span><strong>11:00 · 14:00 점검</strong> — 1차 MILDO Alert 상시 감지 → 2차 당번 AE 30분 내 확인 → 3차 PM 에스컬레이션(P1 한정).</span></div>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="refresh" size={15} /><span><strong>07:00 · 08:00 · 17:00</strong> — 자동 수집 · 검증과 리포트 발송은 매일 실행합니다.</span></div>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="flow" size={15} /><span><strong>16:30 익일 조정안</strong> — 주말 · 공휴일 조정안은 다음 영업일 16:30 조정안에 병합하고, 그 사이 자동 조정은 사전 승인 범위 안에서만 실행합니다 (운영 가정 · 온보딩 중 확정).</span></div>
          </div>
        </Card>
        <Card title="다가오는 주말 · 공휴일" sub="브리핑 이동일 · 연휴 전날은 사전 점검 대상 (MILDO Alert)">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>휴무</th><th className="r">일수</th><th>구분</th><th>이슈 브리핑</th></tr></thead>
              <tbody>
                {blocks.map((b) => {
                  return (
                    <tr key={b.start}>
                      <td>{b.start === b.end ? fmtDate(b.start) : `${fmtDate(b.start)}–${fmtDate(b.end)}`}</td>
                      <td className="r num">{b.days}일</td>
                      <td>{b.labels.length ? <Pill tone="warning">{[...new Set(b.labels)].join(' · ')}</Pill> : <span className="small muted">주말</span>}</td>
                      <td className="num">{fmtDate(b.brief)} 09:30</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <a className="xs" href="#alert">연휴 전날 사전 점검 · 당번 순번 → MILDO Alert</a>
        </Card>
      </div>
    </div>
  );
}
