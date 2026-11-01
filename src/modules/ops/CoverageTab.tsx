/* RFP 커버리지 맵 · 선정 기준 비중 · 선정 일정 D-day · 제출 서류 체크 */
import { useMemo, useState } from 'react';
import { RFP } from '@/data/constants';
import { useStore } from '@/core/store';
import { fmt } from '@/core/util';
import { toCsv } from '@/core/download';
import { Callout, Card, CopyButton, DownloadButton, Pill, Segmented, Src } from '@/ui/primitives';
import { ShareBar } from '@/ui/charts';
import { GEO_CASE_BLANK, PROPOSAL_PAGES, RFP_GROUP_LABEL, RFP_NOTES, RFP_PAGE_LIMIT, SUBMISSION_DOCS, type RfpGroup } from './data';
import { coverageMarkdown, ddayLabel, shortDate, type CoverageRow } from './engine';
import type { OpsLocal } from './local';
import type { OpsModel } from './useOps';
import { moduleTitle } from './useOps';

const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-7'];
const GROUP_TAB: Partial<Record<string, string>> = { s4: 'tf', b_people: 'tf', s6: 'contract', s7: 'company', b_onboard: 'onboarding', b_account: 'structure' };

export function CoverageTab({ model, local, patch, goTab }: { model: OpsModel; local: OpsLocal; patch: (p: (s: OpsLocal) => Partial<OpsLocal>) => void; goTab: (t: string) => void }) {
  const { state } = useStore();
  const s = model.summary;
  const [filter, setFilter] = useState<'all' | 'input' | RfpGroup>('all');
  const rows = useMemo(() => s.coverage.filter((r) => filter === 'all' || (filter === 'input' ? r.status === 'input' : r.group === filter)), [s.coverage, filter]);
  const dl = s.schedule.deadline;
  const inputN = s.coverage.length - s.coverageDone;
  const toggleDoc = (id: string) => patch((st) => ({ docs: { ...st.docs, [id]: !st.docs[id] } }));
  const csv = () => toCsv(s.coverage.map((r) => ({ 구분: r.groupLabel, 항목: r.text, 모듈: r.modules.map(moduleTitle).join(' / '), 장표: r.pages, 상태: r.status === 'done' ? '구현됨' : '입력 필요', 비고: r.note })));
  const groups = (Object.keys(RFP_GROUP_LABEL) as RfpGroup[]);

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card tone="dark" className="span-2" title="RFP 선정 일정" sub={`기준일 ${shortDate(state.data.today)} ${state.data.currentHour}시 · 진행 중 단계 · 다음 단계(분홍) · D-day`}
          actions={<Src kind="RFP" />}>
          <div className="ops-sched">
            {s.schedule.rows.map((r) => (
              <div key={r.step} className={`ops-sched-step ${r.status}`}>
                <span className="s">{r.ddayLabel}</span>
                <span className="t">{r.step}</span>
                <span className="d">{r.date}</span>
              </div>
            ))}
          </div>
          <div className="xs muted">{RFP_NOTES.pt}. 최종 선정 · Kick-off 일정은 RFP상 가안이며, Kick-off는 온보딩 탭의 가정 날짜({local.kickoff})를 씁니다.</div>
        </Card>
        <Card title="제안서 제출 마감" actions={<Src kind="RFP" />}>
          <div className="stat">
            <div className="stat-label">{shortDate(dl.date)} {dl.hour}시 · 기준 {dl.passed ? '마감 지남' : '남은 시간'}</div>
            <div className="stat-value num accent">{dl.passed ? '마감' : ddayLabel(dl.days)}</div>
            <div className="stat-foot">{dl.passed ? '—' : `${fmt.int(dl.hoursLeft)}시간 · 내부 확정 목표 ${shortDate(dl.freeze)} (마감 3영업일 전 · 운영 가정)`}</div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Pill tone={inputN ? 'warning' : 'good'} icon={inputN ? 'edit' : 'check'}>입력 필요 {inputN}개 항목</Pill>
            <Pill tone="neutral">미입력 칸 {s.inputsMissing}</Pill>
          </div>
        </Card>
      </div>

      <div className="grid g-2">
        <Card title="대행사 선정 기준 · 비중" sub="항목별 준비도 = 해당 기준에 연결된 RFP 항목 중 구현됨 비율 (자체 점검 · RFP 배점 아님)" actions={<Src kind="RFP" />}>
          <ShareBar parts={RFP.evaluation.map((e, i) => ({ label: e.label, value: e.weight, colorVar: SERIES[i % SERIES.length] }))} format={(v) => `${Math.round(v * 100)}%`} />
          <div className="ops-weights">
            {s.eval.rows.map((e) => (
              <div key={e.id} className={`ops-weight-row${e.priority ? ' priority' : ''}`}>
                <div><strong className="small">{e.label}</strong><div className="xs muted">{e.detail}</div></div>
                <div className="ops-weight-track" title={`비중 ${e.weight} · 준비 ${e.done}/${e.items}`}>
                  <div className="ops-weight-full" style={{ width: `${e.weight * 4}%` }} />
                  <div className="ops-weight-done" style={{ width: `${e.weighted * 4}%` }} />
                  <span className="ops-weight-label">{e.done}/{e.items}</span>
                </div>
                <div className="r small num" style={{ textAlign: 'right' }}><strong>{fmt.dec1(e.weighted)}</strong> / {e.weight}</div>
              </div>
            ))}
          </div>
          <div className="row-between">
            <span className="small">가중 준비도 합계 <strong className="num">{fmt.dec1(s.eval.total)} / 100</strong></span>
            <span className="xs muted">막대 폭 = 비중(25가 최대) · 진한 부분 = 준비된 비중 · 분홍 = 우선 협상 기준</span>
          </div>
          <Callout tone="accent" title={`우선 협상 기준 · 리소스 절감 자동화 + 운영 안정성 ${s.eval.priorityWeight}% (준비 ${fmt.dec1(s.eval.priorityReady)} / ${s.eval.priorityWeight})`}>
            {RFP_NOTES.priority}. {RFP_NOTES.undisclosed}
          </Callout>
        </Card>

        <Card title="제출 서류 · 범위 확인" sub="RFP 필수 제출물 1) · 8) 및 기타 · 체크는 이 브라우저에만 저장" actions={<Src kind="RFP" />}>
          <ul className="ops-issues">
            <li>
              <Pill tone={PROPOSAL_PAGES <= RFP_PAGE_LIMIT ? 'good' : 'critical'} icon={PROPOSAL_PAGES <= RFP_PAGE_LIMIT ? 'check' : 'x'}>{PROPOSAL_PAGES}장 · 상한 {RFP_PAGE_LIMIT}장</Pill>
              <span className="small">제안서 v3 장표 수 (표지 ~ 부록 p.60)</span>
            </li>
            {SUBMISSION_DOCS.map((d) => (
              <li key={d.id}>
                <label className="ops-check"><input type="checkbox" checked={!!local.docs[d.id]} onChange={() => toggleDoc(d.id)} /><strong>{d.label}</strong></label>
                <span className="xs muted">{d.rule}</span>
              </li>
            ))}
            <li>
              <label className="ops-check"><input type="checkbox" checked={!!local.docs.geo_case} onChange={() => toggleDoc('geo_case')} /><strong>GEO 사례 수치 입력 완료</strong></label>
              <span className="xs muted">p.29 {GEO_CASE_BLANK} · RFP "실제 집행 사례와 수치" — <a href="#geo">SearchTuneOS 진단 전후 지표</a></span>
            </li>
          </ul>
          <div className="stack-sm">
            <strong className="small">RFP 범위 문구</strong>
            {RFP_NOTES.scope.map((t) => <div key={t} className="xs ink2">{t}</div>)}
            <div className="xs ink2">{RFP_NOTES.qualification}</div>
          </div>
        </Card>
      </div>

      <Card title="RFP 커버리지 맵" sub={`RFP 요청 항목 ${s.coverage.filter((r) => r.group !== 'submit').length}개 + 필수 제출물 2)~7) ↔ MILDO OS 모듈 ↔ 제안서 장표 ↔ 상태 · 구현됨 ${s.coverageDone} / ${s.coverage.length}`}
        actions={<><Src kind="RFP" /><Src kind="PROPOSAL" /><CopyButton text={() => coverageMarkdown(s.coverage, moduleTitle)} label="표 복사" /><DownloadButton filename="mildo-rfp-coverage.csv" data={csv} mime="text/csv;charset=utf-8" label="CSV" /></>}>
        <Segmented<'all' | 'input' | RfpGroup> label="필터" value={filter} onChange={setFilter}
          options={[{ id: 'all', label: `전체 ${s.coverage.length}` }, { id: 'input', label: `입력 필요 ${inputN}` }, ...groups.map((g) => ({ id: g, label: RFP_GROUP_LABEL[g].replace(/ &.*$/, '') }))]} />
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th style={{ width: 150 }}>구분</th><th>RFP 요청 항목</th><th>MILDO OS</th><th>제안서</th><th>평가 기준</th><th>상태</th></tr></thead>
            <tbody>
              {rows.map((r: CoverageRow) => (
                <tr key={r.id}>
                  <td className="xs"><strong>{r.groupLabel}</strong></td>
                  <td className="small">{r.text}</td>
                  <td className="small">
                    <div className="stack-sm" style={{ gap: 2 }}>
                      {r.modules.map((m) => <a key={m} href={`#${m}`} className="nowrap">{moduleTitle(m)}</a>)}
                    </div>
                  </td>
                  <td className="xs nowrap"><Src kind="PROPOSAL" page={r.pages} /></td>
                  <td className="xs">{RFP.evaluation.find((e) => e.id === r.criterion)?.label} <span className="muted">{RFP.evaluation.find((e) => e.id === r.criterion)?.weight}%</span></td>
                  <td>
                    <div className="stack-sm" style={{ gap: 3 }}>
                      {r.status === 'done' ? <Pill tone="good" icon="check">구현됨</Pill> : <Pill tone="warning" icon="edit">입력 필요</Pill>}
                      <span className="xs muted">{r.note}</span>
                      {r.status === 'input' && GROUP_TAB[r.id] ? <button type="button" className="btn sm ghost" onClick={() => goTab(GROUP_TAB[r.id]!)}>입력하러 가기</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={6} className="c muted" style={{ padding: 20 }}>해당 항목이 없습니다</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="xs muted">구현됨 = 해당 모듈 화면이 데모 데이터로 동작하고 제출 전 입력 칸이 없음. 입력 필요 = 실명 · 수수료 · 레퍼런스 성과처럼 사실 확인 후 채울 칸이 남음. 시연 화면의 성과 수치는 모두 TEST DATA입니다.</div>
      </Card>
    </div>
  );
}
