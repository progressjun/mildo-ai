/**
 * MILDO Board (Pro-board) — 제안서 p.12–13 · p.9
 * 통합 데이터 아키텍처 스트립 → 기간 KPI → 01 매체 통합 성과 · 02 키워드 성과 필터 · 03 예산 소진 현황 · 판매 채널 실매출 · 시간대 × 요일 · 데이터 수집
 * 성과 수치는 모두 state.data(시연용 테스트 데이터)에서 계산한다.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useStore } from '@/core/store';
import { fmt, fmtDate } from '@/core/util';
import { MEDIA_IDS } from '@/data/constants';
import { Card, Empty, PageHeader, Pill, Segmented, Src, Stat, Tabs } from '@/ui/primitives';
import { Sparkline } from '@/ui/charts';
import { Icon } from '@/ui/Icon';
import { AiInsight } from '@/ui/AiInsight';
import { BOARD_PERIODS } from './data';
import {
  boardKpis, boardPrompt, budgetPacing, clock, collectionSummary, keywordRows, kpiDaily, mediaComparison, periodBrief, validationChecks, type BoardPeriod,
} from './engine';
import { NeutralDelta } from './parts';
import { BOARD_RULES } from './data';
import { DataTab, PipelineStrip } from './DataTab';
import { MediaTab } from './MediaTab';
import { KeywordTab } from './KeywordTab';
import { PacingTab } from './PacingTab';
import { SalesTab } from './SalesTab';
import { HourlyTab } from './HourlyTab';
import './styles.css';

type TabId = 'media' | 'keywords' | 'pacing' | 'sales' | 'hourly' | 'data';

function Badge({ n, tone = 'warning' }: { n: number; tone?: 'warning' | 'serious' }) {
  return n > 0 ? <Pill tone={tone}>{n}</Pill> : null;
}

export default function View() {
  const { state } = useStore();
  const d = state.data;
  const [period, setPeriod] = useState<BoardPeriod>('last7');
  const [tab, setTab] = useState<TabId>('media');

  const k = useMemo(() => boardKpis(d, period), [d, period]);
  const daily = useMemo(() => kpiDaily(d, k.win), [d, k.win]);
  const pacing = useMemo(() => budgetPacing(d), [d]);
  const coll = useMemo(() => collectionSummary(d), [d]);
  const kw = useMemo(() => keywordRows(d, 14), [d]);
  const checks = useMemo(() => validationChecks(d), [d]);
  const media = useMemo(() => mediaComparison(d, k.win), [d, k.win]);

  const kwAlerts = kw.filter((r) => r.signals.some((s) => s.id === 'soldout' || s.id === 'cpc_spike' || s.id === 'conv_drop' || s.id === 'no_conv'));
  const peak = pacing.early.filter((c) => c.missesPeak);
  const mediaFlags = media.filter((m) => m.flag.level === 'warn' || m.flag.level === 'danger');
  const spark = (f: keyof (typeof daily)[number], colorVar = '--series-1') => <Sparkline values={daily.map((x) => x[f] as number)} colorVar={colorVar} width={110} height={26} ariaLabel={`${f} 일별 추이`} />;

  const tabs: { id: TabId; label: ReactNode; badge?: ReactNode }[] = [
    { id: 'media', label: '01 매체 통합 성과', badge: <Badge n={mediaFlags.length} /> },
    { id: 'keywords', label: '02 키워드 성과 필터', badge: <Badge n={kwAlerts.length} /> },
    { id: 'pacing', label: '03 예산 소진 현황', badge: <Badge n={pacing.early.length} tone="serious" /> },
    { id: 'sales', label: '판매 채널 실매출' },
    { id: 'hourly', label: '시간대 × 요일' },
    { id: 'data', label: '데이터 수집 · 표준화', badge: <Badge n={coll.warnings} /> },
  ];

  const todo: { key: string; tab: TabId; tone: 'serious' | 'warning' | 'neutral'; title: string; basis: string }[] = [];
  if (pacing.early.length) {
    todo.push({
      key: 'pace', tab: 'pacing', tone: peak.length ? 'serious' : 'warning',
      title: `일 예산 조기 소진 예상 ${pacing.early.length}개${peak.length ? ` · 피크 전 ${peak.length}개` : ''}`,
      basis: `${pacing.early.slice(0, 2).map((c) => `${c.name} ${clock(c.exhaustHour)}`).join(' · ')} 마감 예상 (기준 ${BOARD_RULES.exhaustBeforeHour}시 전)`,
    });
  }
  for (const r of kwAlerts.slice(0, 2)) {
    const s = r.signals.find((x) => x.id === 'soldout' || x.id === 'cpc_spike' || x.id === 'conv_drop' || x.id === 'no_conv')!;
    todo.push({ key: `kw-${r.id}`, tab: 'keywords', tone: s.id === 'soldout' ? 'serious' : 'warning', title: `'${r.text}' ${s.label}`, basis: s.basis });
  }
  if (coll.warnings) {
    const warn = checks.filter((c) => c.level === 'warn');
    todo.push({ key: 'data', tab: 'data', tone: 'warning', title: `수집 · 검증 확인 필요 ${coll.warnings}건`, basis: warn.map((c) => c.label).join(' · ') });
  }
  for (const m of mediaFlags.slice(0, 2)) todo.push({ key: `m-${m.media}`, tab: 'media', tone: m.flag.level === 'danger' ? 'serious' : 'warning', title: `${m.name} ${m.flag.label}`, basis: m.flag.basis });

  return (
    <div className="page board-page">
      <PageHeader
        eyebrow="02 RESOURCE SAVING & DATA AUTOMATION · PRO-BOARD"
        title="MILDO Board"
        sub="광고 매체 · 판매 채널 · 외부 데이터를 같은 키로 표준화해, 매체별 광고비 · 매출 · 전환과 핵심 키워드 성과, 예산 소진을 한 화면에서 봅니다. 광고비 대비 판매 채널 실매출까지 연결합니다."
        sources={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.9 · p.12–13" /><span className="xs muted">기준 {fmtDate(d.today)} {coll.asOf} · {k.win.label} {k.win.rangeText} · 직전 {k.win.prevText} 대비</span></>}
        actions={<Segmented options={BOARD_PERIODS} value={period} onChange={setPeriod} label="기간 선택" />}
      />

      <PipelineStrip d={d} mer={k.mer} merLabel={`${k.win.label} 광고비 대비 실매출`} onOpen={() => setTab('data')} />

      {!k.hasData ? (
        <Card><Empty icon="inbox" title={`${k.win.label} 데이터가 없습니다`}>수집 상태를 데이터 수집 탭에서 확인하세요.</Empty></Card>
      ) : (
        <div className="grid g-3">
          <Card
            className="span-2"
            title={`핵심 지표 · ${k.win.label}`}
            sub={`${k.win.rangeText} · 직전 ${k.win.prevText} 대비${k.win.includesToday ? ` · 오늘 ${d.currentHour}시까지 부분일 포함` : ''} · 스파크라인 ${daily.length}일 일별`}
            actions={<Src kind="DEMO" />}
          >
            <div className="board-kpis">
              <div className="board-kpi"><Stat label="광고비" value={fmt.krw(k.cur.cost)} foot={<><NeutralDelta pct={k.deltas.cost} /><span className="muted">{k.scope.excludedMedia.length ? `증감 ${k.scope.media.length}개 매체 기준` : `${MEDIA_IDS.length}개 매체`}</span></>} spark={spark('cost')} /></div>
              <div className="board-kpi"><Stat label="광고 매출" value={fmt.krw(k.cur.revenue)} delta={k.deltas.revenue} foot={<span className="muted">매체 귀속</span>} spark={spark('revenue', '--series-3')} /></div>
              <div className="board-kpi"><Stat label="ROAS" value={fmt.roas(k.cur.roas)} delta={k.deltas.roas} foot={<span className="muted">광고 매출 ÷ 광고비</span>} spark={spark('roas', '--series-3')} /></div>
              <div className="board-kpi"><Stat label="판매 채널 실매출" value={fmt.krw(k.sales)} delta={k.deltas.sales} foot={<span className="muted">광고 외 포함 · 광고 경유 {fmt.ratio(k.adShareOfSales, 0)}</span>} spark={spark('sales', '--series-7')} /></div>
              <div className="board-kpi hl"><Stat label="MER · 광고비 대비 실매출" value={`${fmt.dec1(k.mer)}배`} delta={k.deltas.mer} foot={<span className="muted">{k.scope.note ? `같은 기준 ${fmt.dec1(k.cmp.mer)}배 · 직전 ${fmt.dec1(k.cmp.prevMer)}배` : `직전 ${fmt.dec1(k.prevMer)}배`}</span>} spark={spark('mer', '--series-7')} /></div>
              <div className="board-kpi"><Stat label="CPA" value={fmt.won(k.cur.cpa)} delta={k.deltas.cpa} invert foot={<span className="muted">전환 {fmt.dec1(k.cur.conversions)}</span>} spark={spark('cpa', '--series-2')} /></div>
              <div className="board-kpi"><Stat label="CVR" value={fmt.pct(k.cur.cvr, 2)} delta={k.deltas.cvr} foot={<span className="muted">전환 ÷ 클릭</span>} spark={spark('cvr', '--series-2')} /></div>
              <div className="board-kpi"><Stat label="신규 고객 CAC" value={fmt.won(k.cur.cac)} delta={k.deltas.cac} invert foot={<span className="muted">신규 {fmt.int(k.cur.newCustomers)}명</span>} spark={spark('cac', '--series-4')} /></div>
            </div>
            {k.scope.note ? <div className="row xs ink2 board-kpi-note" style={{ gap: 6, marginTop: 8 }}><Pill tone="outline">같은 기준 비교</Pill><span>{k.scope.note}</span></div> : null}
          </Card>
          <Card title="지금 확인할 것" sub={`${fmtDate(d.today)} ${coll.asOf} 기준 · 데이터에서 탐지`} actions={<Src kind="DEMO" />}>
            {todo.length ? (
              <div className="board-list">
                {todo.slice(0, 6).map((t) => (
                  <div key={t.key} className="board-list-item">
                    <Pill tone={t.tone} icon="alert">{t.tab === 'pacing' ? '예산' : t.tab === 'keywords' ? '키워드' : t.tab === 'data' ? '수집' : '매체'}</Pill>
                    <div className="stack-sm" style={{ gap: 1 }}>
                      <span className="small"><strong>{t.title}</strong></span>
                      <span className="board-sub">{t.basis}</span>
                    </div>
                    <button type="button" className="icon-btn" aria-label={`${t.title} 보기`} title="해당 탭 열기" onClick={() => setTab(t.tab)}><Icon name="chevron" size={14} /></button>
                  </div>
                ))}
              </div>
            ) : <div className="small muted">현재 기준을 넘은 항목이 없습니다.</div>}
          </Card>
        </div>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} id="board-tabs" />
      {tab === 'media' ? <MediaTab d={d} win={k.win} /> : null}
      {tab === 'keywords' ? <KeywordTab d={d} /> : null}
      {tab === 'pacing' ? <PacingTab d={d} /> : null}
      {tab === 'sales' ? <SalesTab d={d} win={k.win} /> : null}
      {tab === 'hourly' ? <HourlyTab d={d} /> : null}
      {tab === 'data' ? <DataTab d={d} incidents={state.incidents} /> : null}

      <AiInsight
        key={period}
        title={`기간 성과 해석 · ${k.win.label}`}
        sub="매체 통합 성과 · 판매 채널 실매출(MER) · 예산 소진 · 키워드 신호를 확정 팩트 / 반복 관측 패턴 / AI 해석으로 나눠 정리합니다."
        buildPrompt={() => boardPrompt(d, period)}
        fallback={() => periodBrief(d, period)}
        cta="기간 성과 해석"
      />
    </div>
  );
}
