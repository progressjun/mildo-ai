/**
 * SearchTuneOS · GEO & AI 검색 대응 — 제안서 p.29 · p.9
 * 네 축(SEO·구조화 데이터 / AEO 콘텐츠 / GEO 모니터링 / 페이드 AI 지면) 상태 → 핵심 지표 → 탭(모니터링 · 제품페이지 진단 · FAQ · 페이드 지면 · 진단 전후) → AI 해석.
 * GEO 진단 스냅샷은 데모(TEST DATA), Claude 라이브 진단만 실제 응답(LIVE). AI는 버튼을 누를 때만 호출한다.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '@/core/store';
import { fmt, fmtDate } from '@/core/util';
import { Card, PageHeader, Pill, Src, Stat, Tabs } from '@/ui/primitives';
import { AiInsight } from '@/ui/AiInsight';
import { Icon } from '@/ui/Icon';
import { GEO_AXES, GEO_INTRO, GEO_METRICS, GEO_PRINCIPLE, GEO_RULES, type GeoTabId } from './data';
import {
  auditPage, axisStates, buildFaqDraft, buildGeoSnapshot, extractPageFacts, faqCoverage, geoOverallBrief, geoPrompt, liveSummary, paidSummary,
  paidSurfaceRows, reviewFaq, sampleProductHtml, visibilitySummary, type CaseInput, type FaqItem, type LiveRecord,
} from './engine';
import { extractPageFactsDom } from './dom';
import { clearGeoLocal, EMPTY_CASE, latestByQuery, loadCase, loadLive, onGeoReset, saveCase, saveLive } from './persist';
import { VerdictBadge } from './parts';
import { MonitorTab } from './MonitorTab';
import { AuditTab } from './AuditTab';
import { FaqTab } from './FaqTab';
import { PaidTab } from './PaidTab';
import { CaseTab } from './CaseTab';
import './styles.css';

type SampleKind = 'defect' | 'fixed' | 'custom' | 'empty';

export default function View() {
  const { state } = useStore();
  const d = state.data;
  const [tab, setTab] = useState<GeoTabId>('monitor');
  const snap = useMemo(() => buildGeoSnapshot(d.today), [d.today]);
  const [roundIndex, setRoundIndex] = useState(() => Math.max(0, snap.rounds.length - 1));
  const vis = useMemo(() => visibilitySummary(snap, roundIndex), [snap, roundIndex]);

  /* 제품페이지 진단 — 데모 상품으로 만든 결함 샘플로 시작 */
  const [html, setHtml] = useState(() => sampleProductHtml(d, 'defect'));
  const [sampleKind, setSampleKind] = useState<SampleKind>('defect');
  const deferredHtml = useDeferredValue(html);
  const audit = useMemo(() => auditPage(extractPageFactsDom(deferredHtml) ?? extractPageFacts(deferredHtml), d), [deferredHtml, d]);
  const onSample = (k: 'defect' | 'fixed' | 'empty') => {
    setHtml(k === 'empty' ? '' : sampleProductHtml(d, k));
    setSampleKind(k);
  };

  /* AEO FAQ */
  const [faqItems, setFaqItems] = useState<FaqItem[]>(() => buildFaqDraft(d));
  const reviewed = useMemo(() => reviewFaq(faqItems), [faqItems]);
  const cov = useMemo(() => faqCoverage(reviewed, vis), [reviewed, vis]);

  /* 페이드 AI 지면 */
  const paidRows = useMemo(() => paidSurfaceRows(d, snap, roundIndex), [d, snap, roundIndex]);
  const paid = useMemo(() => paidSummary(paidRows), [paidRows]);

  /* Claude 라이브 기록 · 진단 전후 입력 (모듈 전용 로컬 저장) */
  const [live, setLive] = useState<LiveRecord[]>(() => loadLive());
  const latest = useMemo(() => latestByQuery(live), [live]);
  const onLive = useCallback((r: LiveRecord) => setLive((cur) => [r, ...cur.filter((x) => !(x.queryId === r.queryId && x.at === r.at))]), []);
  useEffect(() => saveLive(live), [live]);
  const [caseInput, setCaseInput] = useState<CaseInput>(() => loadCase());
  useEffect(() => saveCase(caseInput), [caseInput]);

  /* '시연 상태 초기화' — 라이브 기록 · 진단 전후 입력 · FAQ 편집 · 붙여넣은 HTML을 처음 상태로.
     전역 초기화 직후에는 승인 이력 · 이슈가 잠깐 모두 비므로(이후 시연 이력 재적재) 그 순간도 초기화 신호로 본다 */
  useEffect(() => onGeoReset(() => {
    setLive([]);
    setCaseInput({ ...EMPTY_CASE });
    setFaqItems(buildFaqDraft(d));
    setHtml(sampleProductHtml(d, 'defect'));
    setSampleKind('defect');
  }), [d]);
  const emptyGlobal = state.changes.length === 0 && state.incidents.length === 0;
  useEffect(() => { if (emptyGlobal) clearGeoLocal(); }, [emptyGlobal]);

  const axes = axisStates(vis, audit, cov, paid);
  const ls = liveSummary(Object.values(latest));
  const o = vis.overall;

  const tabs: { id: GeoTabId; label: ReactNode; badge?: ReactNode }[] = [
    { id: 'monitor', label: 'GEO 모니터링', badge: vis.gaps.length ? <Pill tone="serious">{vis.gaps.length}</Pill> : undefined },
    { id: 'audit', label: '제품페이지 진단', badge: audit.counts.fail && !audit.empty ? <Pill tone="critical">{audit.counts.fail}</Pill> : undefined },
    { id: 'faq', label: 'AEO FAQ 생성기', badge: cov.needsInput ? <Pill tone="warning">{cov.needsInput}</Pill> : undefined },
    { id: 'paid', label: '페이드 AI 지면 → SA', badge: paid.register + paid.landing ? <Pill tone="accent">{paid.register + paid.landing}</Pill> : undefined },
    { id: 'case', label: '진단 전후 기록' },
  ];

  return (
    <div className="page geo-page">
      <PageHeader
        eyebrow="03 MONITORING & TEST · SEARCHTUNE OS"
        title="SearchTuneOS · GEO"
        sub={GEO_INTRO}
        sources={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.29 · p.9" /><span className="xs muted">정기 진단 {vis.date ? fmtDate(vis.date) : '—'} 기준 · 질의 {snap.queries.length}개 × 엔진 {snap.engines.length}개 · 기준일 {fmtDate(d.today)} {d.currentHour}:30 · 측정 지표 {GEO_METRICS}</span></>}
      />

      <Card tone="dark" title="GEO · AI 검색 대응 네 축" sub="각 축의 현재 상태 · 판정 기준 (축을 누르면 해당 탭으로 이동)" actions={<><Src kind="PROPOSAL" page="p.29" /><Src kind="DEMO" /></>}>
        <div className="geo-axes">
          {GEO_AXES.map((ax) => {
            const st = axes[ax.id];
            return (
              <button key={ax.id} type="button" className="geo-axis" aria-current={tab === ax.tab ? 'true' : undefined} onClick={() => setTab(ax.tab)}>
                <span className="geo-axis-name">{ax.name}<Icon name="chevron" size={14} /></span>
                <span className="geo-axis-scope">{ax.scope}</span>
                <span className="geo-axis-metric">{st.metric}</span>
                <VerdictBadge v={st.verdict} />
                <span className="geo-axis-foot">{st.foot}</span>
              </button>
            );
          })}
        </div>
        <div className="geo-principle"><Icon name="shield" size={15} /><strong>{GEO_PRINCIPLE}</strong><span className="muted">정기 진단 매주 월 · 개선 반영 후 2회 연속 결과로 판정</span></div>
      </Card>

      <Card title={`핵심 지표 · ${vis.date ? fmtDate(vis.date) : ''} 정기 진단`} sub={`${vis.prevDate ? `직전 ${fmtDate(vis.prevDate)} 대비` : '직전 회차 없음'} · 질의 × 엔진 ${o.total}셀`} actions={<Src kind="DEMO" />}>
        <div className="geo-kpis">
          <div className="geo-kpi hl"><Stat label="브랜드 언급률" value={fmt.pct(o.rate * 100, 1)} foot={<span className="muted">{o.mentioned}/{o.total}셀{o.deltaPp !== null ? ` · 직전 ${o.deltaPp >= 0 ? '+' : ''}${o.deltaPp.toFixed(1)}pp` : ''}</span>} /></div>
          <div className="geo-kpi"><Stat label="평균 언급 순서" value={Number.isFinite(o.avgPosition) ? `${fmt.dec1(o.avgPosition)}번째` : '—'} foot={<span className="muted">첫 번째 언급 {fmt.pct(o.firstRate * 100, 0)}</span>} /></div>
          <div className="geo-kpi"><Stat label="자사 인용 수" value={`${o.ownedCitations}건`} foot={<span className="muted">전체 인용 {o.citations} · {fmt.pct(o.ownedShare * 100, 0)}{o.prevOwnedCitations !== null ? ` · 직전 ${o.prevOwnedCitations}` : ''}</span>} /></div>
          <div className="geo-kpi"><Stat label="경쟁 6개사 대비 점유" value={fmt.pct(o.sov * 100, 1)} foot={<span className="muted">최다 {vis.competitors[0]?.name ?? '—'} {vis.competitors[0]?.mentions ?? 0}셀</span>} /></div>
          <div className="geo-kpi"><Stat label="검색 커버리지 · 확보 질의" value={`${o.covered}/${vis.queries.length}`} foot={<span className="muted">{fmt.pct(vis.queries.length ? (o.covered / vis.queries.length) * 100 : 0, 0)} · 기준 질의별 ≥{Math.min(GEO_RULES.coveredEngines, snap.engines.length)}/{snap.engines.length} 엔진 언급 · 미노출 {o.none}</span>} /></div>
          <div className="geo-kpi"><Stat label="경쟁사 우위 질의" value={vis.gaps.length} foot={<span className="muted">기준 경쟁사 ≥{GEO_RULES.gapCompetitorEngines} · 자사 ≤{GEO_RULES.gapBrandMax} 엔진</span>} /></div>
          <div className="geo-kpi"><Stat label={<>Claude 라이브 <Src kind="LIVE" /></>} value={ls.count ? fmt.pct(ls.rate * 100, 0) : '—'} foot={<span className="muted">{ls.count ? `${ls.mentioned}/${ls.count} 질의 언급` : '진단 기록 없음'}</span>} /></div>
        </div>
      </Card>

      <Tabs tabs={tabs} value={tab} onChange={setTab} id="geo-tabs" />
      {tab === 'monitor' ? (
        <MonitorTab snap={snap} vis={vis} roundIndex={roundIndex} onRound={setRoundIndex} live={live} latest={latest} onLive={onLive} onClearLive={() => setLive([])} />
      ) : null}
      {tab === 'audit' ? (
        <AuditTab d={d} html={html} onHtml={(v) => { setHtml(v); setSampleKind(v.trim() ? 'custom' : 'empty'); }} audit={audit} sampleKind={sampleKind} onSample={onSample} />
      ) : null}
      {tab === 'faq' ? <FaqTab d={d} items={faqItems} onItems={setFaqItems} reviewed={reviewed} cov={cov} vis={vis} /> : null}
      {tab === 'paid' ? <PaidTab rows={paidRows} vis={vis} /> : null}
      {tab === 'case' ? <CaseTab value={caseInput} onChange={setCaseInput} snap={snap} /> : null}

      <AiInsight
        title="SearchTuneOS 진단 해석"
        sub="AI 검색 언급 · 제품페이지 · FAQ · 페이드 지면 결과를 확정 팩트 / 반복 관측 패턴 / AI 해석으로 나눠 정리합니다."
        buildPrompt={() => geoPrompt(vis, audit, paidRows, Object.values(latest))}
        fallback={() => geoOverallBrief(vis, audit, paidRows, reviewed, Object.values(latest))}
        cta="진단 해석"
      />
    </div>
  );
}
