/* 매체 협력 구좌(p.32) · 네이버 3자 협업(p.33) · 2027 분기별 성장 캘린더(p.42) · 줄인 시간 재투입(p.31) */
import type { Dataset } from '@/core/types';
import { fmt } from '@/core/util';
import { Callout, Card, Pill, Src } from '@/ui/primitives';
import { CALENDAR_NOTE, MEDIA_PARTNERSHIPS, NAVER_TRIPARTITE, PARTNERSHIP_NOTE, TIME_REINVEST } from './data';
import { automationSavings, calendarView } from './engine';

export function PartnerTab({ d }: { d: Dataset }) {
  const cal = calendarView(d);
  const next = cal.find((q) => q.daysUntil >= 0);
  const sv = automationSavings();
  return (
    <div className="stack-lg">
      <Card title={<>매체 협력으로 최선의 구좌 확보 <Src kind="PROPOSAL" page="p.32" /></>} sub="광고대행사의 가장 큰 가치는 매체와의 관계 — 프로그레스미디어의 매체 파트너십을 수면밀도의 구좌로 바꿉니다">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>매체</th><th>프로그레스미디어 관계</th><th>확보 추진 구좌 · 지원</th><th>수면밀도 활용</th><th>상태</th></tr></thead>
            <tbody>
              {MEDIA_PARTNERSHIPS.map((p) => (
                <tr key={p.media}>
                  <td><strong>{p.media}</strong></td>
                  <td className="small">{p.relation}</td>
                  <td className="small">{p.slots}</td>
                  <td className="small">{p.use}</td>
                  <td>{p.placeholder ? <Pill tone="warning" icon="edit">입력 필요</Pill> : <Pill tone="neutral">제안서 명시</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="xs muted">{PARTNERSHIP_NOTE}</div>
      </Card>

      <Card tone="dark" title={<>네이버 3자 협업 체계 <Src kind="PROPOSAL" page="p.33" /></>} sub="네이버는 프로그레스미디어를 핵심 프리미어 파트너로, 프로그레스미디어는 네이버를 최우선 매체로 둡니다 · 이 관계를 수면밀도의 성장에 연결합니다">
        <div className="growth-parties">
          {NAVER_TRIPARTITE.parties.map((p, i) => (
            <div key={p.name} style={{ display: 'contents' }}>
              {i ? <span className="growth-path-arrow">⇄</span> : null}
              <div className="growth-party"><strong>{p.name}</strong><span className="xs muted">{p.role}</span></div>
            </div>
          ))}
        </div>
        <div className="row-between">
          <strong className="small">{NAVER_TRIPARTITE.meeting}</strong>
          <span className="growth-chip">{NAVER_TRIPARTITE.cadence}</span>
        </div>
        <div className="growth-steps">
          {NAVER_TRIPARTITE.steps.map((s) => (
            <div key={s.title} className="growth-step">
              <strong className="small">{s.title}</strong>
              <span className="xs muted">{s.detail}</span>
              <span className="growth-step-gain">{s.gain}</span>
            </div>
          ))}
        </div>
        <div className="xs muted">{NAVER_TRIPARTITE.note}</div>
      </Card>

      <Card title={<>2027 분기별 성장 캘린더 <Src kind="PROPOSAL" page="p.42" /></>} sub={`분기마다 하나의 성장 테마를 정하고, 분기 리뷰 결과를 다음 분기 계획에 그대로 반영 · 기준일 ${d.today}`}>
        <Callout tone="warning" icon="calendar">{CALENDAR_NOTE}</Callout>
        <div className="growth-cal">
          {cal.map((q) => (
            <div key={q.q} className={`growth-cal-col${next?.q === q.q ? ' next' : ''}`}>
              <div className="growth-cal-q"><span>{q.q}</span><span>{Number.isFinite(q.daysUntil) ? (q.daysUntil > 0 ? `D-${q.daysUntil}` : '진행') : ''}</span></div>
              <div className="growth-cal-theme">{q.theme}</div>
              <div className="growth-cal-row"><span>핵심 실행</span><span>{q.core}</span></div>
              <div className="growth-cal-row"><span>네이버 연계</span><span>{q.naver}</span></div>
              <div className="growth-cal-row"><span>신규 매체 · 코프로모션</span><span>{q.newMedia}</span></div>
              <div className="row" style={{ gap: 4, marginTop: 'auto' }}>
                {q.links.map((l) => <a key={l.label} className="growth-chip" href={`#${l.route}`}>{l.label}</a>)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title={<>줄인 시간 → 성장 실험 재투입 <Src kind="PROPOSAL" page="p.19 · p.31" /></>} sub="반복 구간을 MILDO Flow로 줄여 브랜드팀 · 운영팀의 시간을 성장 업무로 돌립니다"
        actions={<><a className="btn sm" href="#flow">MILDO Flow</a><a className="btn sm" href="#reports">절감 실측</a></>}>
        <div className="row" style={{ gap: 24 }}>
          <div className="stack-sm" style={{ gap: 0 }}><span className="xs muted">SA 업무 (주)</span><span className="growth-big">{fmt.int(sv.before)} → {fmt.int(sv.after)}분</span></div>
          <div className="stack-sm" style={{ gap: 0 }}><span className="xs muted">확보 시간 (주)</span><span className="growth-big">{fmt.int(sv.saved)}분</span></div>
          <div className="stack-sm" style={{ maxWidth: 420 }}>
            <span className="small">확보된 시간 → {TIME_REINVEST.to}</span>
            <span className="xs muted">목표치 · 온보딩 30일 내 실측 확정 · 참고: {TIME_REINVEST.reference}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
