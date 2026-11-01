/* p.28 테스트 · 인사이트 운영 루프 — 주간 인사이트 브리프 자동 초안 + 담당 AE 코멘트 병합 + AI 해석 (버튼 클릭 시에만) */
import { useEffect, useState } from 'react';
import { REPORT_CADENCE } from '@/data/constants';
import { fmt } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { Markdown } from '@/ui/Markdown';
import { Button, Card, CopyButton, DownloadButton, Pill, Src, Stat } from '@/ui/primitives';
import { mergeAeNote, noteStyleIssues } from './engine';
import { INSIGHT_LOOP } from './data';
import type { WatchCtx } from './hooks';

export function BriefTab({ w }: { w: WatchCtx }) {
  const b = w.brief;
  const weekly = REPORT_CADENCE.find((c) => c.id === 'weekly');
  const filename = `mildo-watch-weekly-brief_${b.period.from}_${b.period.to}.md`;
  const [draft, setDraft] = useState(w.aeNote?.text ?? '');
  useEffect(() => setDraft(w.aeNote?.text ?? ''), [w.aeNote?.text]);
  const merged = mergeAeNote(b.markdown, w.aeNote);
  const issues = noteStyleIssues(draft);
  const dirty = draft.trim() !== (w.aeNote?.text ?? '').trim();
  const buildPrompt = () => {
    const data = {
      period: b.period.label,
      events: w.events.filter((e) => !e.closed).slice(0, 12).map((e) => ({ media: e.media, title: e.title, origin: e.origin, stage: e.stage, verdict: e.diag.label, basis: e.diag.basis, plan: e.plan, test: e.judge.verdict === 'pending' ? null : e.judge.label })),
      competitorHigh: w.archive.filter((r) => r.impact.level === 'high' && r.date >= b.period.from).map((r) => ({ date: r.date, competitor: r.competitor, item: r.itemLabel, title: r.title, basis: r.impact.basis })),
      brandSerp: w.serp.map((s) => ({ keyword: s.keyword, avgRank: Math.round(s.avgRank * 10) / 10, verdict: s.label })),
      upcoming: w.calendar.filter((c) => c.dday >= 0 && c.dday <= 45).map((c) => ({ label: c.label, kind: c.kindLabel, dday: c.dday, basis: c.basis })),
    };
    return [
      '과제: MILDO Watch가 자동으로 만든 주간 인사이트 브리프 초안(아래)을 검토해, 이번 주 감지 사항이 수면밀도의 CAC · CPA · ROAS · CVR · 볼륨에 어떤 경로로 영향을 주는지 해석하고 다음 주 실행안의 우선순위를 판단 근거와 함께 정리하라.',
      '초안에 있는 수치만 사용하고 새 수치를 만들지 마라. 데이터는 시연용 테스트 데이터이며 매체 공지 · 경쟁사 스냅샷은 가상이다. 시즌 효과는 가설임을 유지하라.',
      `\n초안:\n${merged}`,
      `\n데이터(JSON):\n${JSON.stringify(data)}`,
    ].join('\n');
  };

  return (
    <div className="stack-lg">
      <div className="grid g-5 watch-kpis">
        <Card><Stat label="이번 주 감지" src={<Src kind="DEMO" />} value={`${b.counts.events}건`} foot={<span>공지 {b.counts.notices} · 데이터 {b.counts.signals}</span>} /></Card>
        <Card><Stat label="영향 확인 · 주의 이상" src={<Src kind="DEMO" />} value={`${b.counts.impact}건`} foot={<span>영향 큼 · 영향 있음 판정 (p.47 · p.44 기준)</span>} /></Card>
        <Card><Stat label="경쟁사 변경 · 높음" src={<Src kind="DEMO" />} value={`${b.counts.archive} · ${b.counts.archiveHigh}`} foot={<span>가상 스냅샷 · 7일</span>} /></Card>
        <Card><Stat label="브랜드 지면 상위 침투" src={<Src kind="DEMO" />} value={`${b.counts.serpAbove}개`} foot={<span>브랜드 키워드 {w.serp.length}개 중</span>} /></Card>
        <Card><Stat label="발송" src={<Src kind="PROPOSAL" page="p.17" />} value={weekly?.when ?? '월 10:00'} foot={<span>{b.delivery}</span>} /></Card>
      </div>

      <div className="grid g-3">
        <div className="span-2 stack-lg">
          <Card
            title={<>주간 인사이트 브리프 · 자동 초안 {w.aeNote?.text.trim() ? <Pill tone="good" icon="check">AE 코멘트 반영 · {w.aeNote.by}</Pill> : <Pill tone="outline">담당 AE 검토 전</Pill>}</>}
            sub={`${b.period.label} · 이번 주 감지 사항 → 영향 → 제안. 시스템이 만들고 담당 AE가 해석과 다음 액션을 덧붙여 ${weekly?.channel ?? '메일'}로 발송합니다.`}
            actions={<><Src kind="PROPOSAL" page="p.28 · p.17" /><Src kind="DEMO" /><CopyButton text={merged} /><DownloadButton filename={filename} data={merged} mime="text/markdown;charset=utf-8" label=".md" /></>}
          >
            <div className="watch-brief">
              <Markdown text={merged} />
            </div>
          </Card>
          <Card
            title="담당 AE 해석 · 다음 액션"
            sub="자동 초안 아래에 병합되어 복사 · .md 내보내기에 함께 들어갑니다. 수치 기준 · 전제 조건을 붙여 단락 문장으로 씁니다."
            actions={<Src kind="PROPOSAL" page="p.17" />}
          >
            <textarea
              id="watch-ae-note"
              className="textarea"
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="예: 쇼핑 고객 확장 그룹은 7일차 중간 점검(11/4) 전까지 증액하지 않는다. 전환율 차이 +15% 이상 · p<0.05 확인 후 같은 의도 그룹 확대를 수면밀도에 제안한다."
              aria-label="담당 AE 코멘트"
            />
            {issues.length && draft.trim() ? <div className="xs muted">작성 원칙 · {issues.join(' ')}</div> : null}
            <div className="row-between">
              <span className="xs muted">{w.aeNote?.text.trim() ? `마지막 반영 ${w.aeNote.at} · ${w.aeNote.by}` : '아직 반영된 코멘트가 없습니다.'}</span>
              <div className="row">
                {w.aeNote?.text.trim() ? <Button size="sm" variant="ghost" onClick={() => { setDraft(''); w.setAeNote(''); }}>코멘트 비우기</Button> : null}
                <Button size="sm" variant="primary" icon="check" disabled={!dirty || !draft.trim()} onClick={() => w.setAeNote(draft)}>브리프에 반영</Button>
              </div>
            </div>
          </Card>
        </div>
        <div className="stack-lg">
          <Card title="테스트 · 인사이트 운영 루프" sub="결과가 정해진 주기로 수면밀도에 돌아가는 경로" actions={<Src kind="PROPOSAL" page="p.28" />}>
            <div className="stack-sm">
              {INSIGHT_LOOP.map((l) => (
                <div key={l.cycle} className={`watch-loop ${l.cycle === '주간' || l.cycle === '액션 후 2주' ? 'on' : ''}`}>
                  <div className="row-between"><strong className="small">{l.cycle}</strong><span className="xs muted">산출물 {l.output}</span></div>
                  <div className="xs ink2">{l.content}</div>
                  <div className="xs muted">Watch 연결 · {l.watch}</div>
                </div>
              ))}
            </div>
          </Card>
          <Card title="이번 주 파이프라인" sub="브리프에 들어간 단계별 건수" actions={<Src kind="DEMO" />}>
            <div className="stack-sm small">
              <div className="row-between"><span>진단 대기 (24시간)</span><strong className="num">{w.counts.detect}</strong></div>
              <div className="row-between"><span>실행안 반영 대기</span><strong className="num">{w.counts.diagnose}</strong></div>
              <div className="row-between"><span>Lab 등록 대기</span><strong className="num">{w.counts.plan}</strong></div>
              <div className="row-between"><span>소액 테스트 진행</span><strong className="num">{w.counts.test}</strong></div>
              <div className="row-between"><span>랩업 완료 · 관찰 종료</span><strong className="num">{w.counts.wrapup} · {w.counts.closed}</strong></div>
              <div className="xs muted">영향 범위 합계(진행 중 · 일 평균 광고비) {fmt.krw(w.events.filter((e) => !e.closed && e.stage !== 'wrapup').reduce((a, e) => a + e.diag.affected.spendPerDay, 0))}원 — 이벤트 간 중복 포함</div>
            </div>
          </Card>
        </div>
      </div>

      <AiInsight
        title="AI 해석 추가"
        sub="버튼을 누를 때만 Claude를 호출합니다. 미연결 시 같은 데이터로 규칙 엔진 브리프를 표시합니다."
        cta="AI 해석 생성"
        buildPrompt={buildPrompt}
        fallback={() => b.brief}
      />
    </div>
  );
}
