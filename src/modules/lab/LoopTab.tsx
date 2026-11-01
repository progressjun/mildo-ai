/* 테스트 · 인사이트 운영 루프 (p.28) — 주간 · 월간 · 분기 · 액션 후 2주 · 수시 캘린더 + 주간 인사이트 브리프 초안 */
import { useMemo } from 'react';
import { addDays, fmtDate, isOffDay, WEEKDAY_KO } from '@/core/util';
import { Markdown } from '@/ui/Markdown';
import { Card, CopyButton, DownloadButton, Pill, Src } from '@/ui/primitives';
import { LOOP_CADENCE } from './data';
import { loopCalendar, weeklyDraft, type LoopEvent } from './engine';
import type { LabModel } from './parts';

const CAD_COLOR: Record<LoopEvent['cadence'], string> = {
  weekly: '--series-1', monthly: '--series-3', quarterly: '--series-7', wrapup: '--series-2', adhoc: '--series-4', test_end: '--series-5', stop_check: '--series-8',
};
const CAD_LABEL: Record<LoopEvent['cadence'], string> = { weekly: '주간', monthly: '월간', quarterly: '분기', wrapup: '랩업', adhoc: '수시', test_end: '테스트 종료', stop_check: '중단 점검' };

export function LoopTab({ m }: { m: LabModel }) {
  const { d, cards, lab, state, crit, patterns } = m;
  const cal = useMemo(() => loopCalendar(d.today, cards, lab.decisions, 8), [d.today, cards, lab.decisions]);
  const draft = useMemo(() => weeklyDraft(d, state.changes, crit, cards, patterns), [d, state.changes, crit, cards, patterns]);
  const days: string[] = [];
  for (let x = cal.from; x <= cal.to; x = addDays(x, 1)) days.push(x);
  const next = (id: LoopEvent['cadence']) => cal.events.find((e) => e.cadence === id && e.date >= d.today);

  return (
    <div className="stack-lg">
      <Card title="테스트 · 인사이트 운영 루프" sub="모든 테스트는 같은 카드로 시작해 같은 기준으로 끝나고, 결과는 정해진 주기로 수면밀도에 돌아갑니다" actions={<Src kind="PROPOSAL" page="p.28" />}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>주기</th><th>내용</th><th>산출물</th><th>일정 규칙</th><th>다음 일정</th></tr></thead>
            <tbody>
              {LOOP_CADENCE.map((c) => {
                const n = next(c.id);
                return (
                  <tr key={c.id}>
                    <td><span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: `var(${CAD_COLOR[c.id]})` }} /><strong className="small">{c.cycle}</strong></span></td>
                    <td className="small">{c.content}</td>
                    <td><Pill tone="outline">{c.output}</Pill></td>
                    <td className="lab-sub">{c.rule}</td>
                    <td className="small nowrap">{n ? `${fmtDate(n.date)}${n.ref ? ` · ${n.ref}` : ''}` : c.id === 'adhoc' ? '발생 시' : c.id === 'wrapup' ? '테스트 결정 후 생성' : '범위 밖'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`운영 캘린더 · ${fmtDate(cal.from, false)} ~ ${fmtDate(cal.to, false)}`} sub={`기준일 ${fmtDate(d.today)} · 주말 · 공휴일 일정은 다음 영업일로 이동 (테스트 점검 · 종료일은 집행 기준이라 그대로)`}
        actions={<div className="row xs" style={{ gap: 10 }}>{(Object.keys(CAD_LABEL) as LoopEvent['cadence'][]).filter((k) => k !== 'adhoc').map((k) => <span key={k} className="legend-item"><span className="legend-swatch" style={{ background: `var(${CAD_COLOR[k]})` }} />{CAD_LABEL[k]}</span>)}</div>}>
        <div className="lab-cal" role="grid" aria-label="운영 캘린더">
          {[1, 2, 3, 4, 5, 6, 0].map((w) => <div key={w} className="lab-cal-h">{WEEKDAY_KO[w]}</div>)}
          {days.map((x) => {
            const off = isOffDay(x);
            const evs = cal.events.filter((e) => e.date === x);
            return (
              <div key={x} className={`lab-cal-d${off.off ? ' off' : ''}${x < d.today ? ' past' : ''}${x === d.today ? ' today' : ''}`}>
                <span className="lab-cal-date"><span>{fmtDate(x, false)}</span>{off.off && off.label !== '토요일' && off.label !== '일요일' ? <span>{off.label}</span> : x === d.today ? <span>기준일</span> : null}</span>
                {evs.map((e, i) => (
                  <span key={i} className="lab-ev" style={{ borderLeftColor: `var(${CAD_COLOR[e.cadence]})` }} title={`${e.title} → ${e.output}${e.shiftedFrom ? ` (원래 ${fmtDate(e.shiftedFrom)})` : ''}`}>{e.title}</span>
                ))}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="주간 인사이트 브리프 초안" sub="이번 주 테스트 판정 · 신규 후보 · 카드 결과를 확정 팩트 / 반복 관측 패턴 / AI 해석으로 나눠 자동 작성 (규칙 엔진) · 담당 AE가 해석과 다음 액션을 덧붙여 발송"
        actions={<><Src kind="DEMO" /><CopyButton text={draft} /><DownloadButton filename={`mildo-lab-weekly-${d.today}.md`} data={draft} mime="text/markdown;charset=utf-8" label=".md" /></>}>
        <Markdown text={draft} />
      </Card>
    </div>
  );
}
