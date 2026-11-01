/* 02 키워드 성과 필터 — 구매 의도 · 상태 · 제품군 · 검색어 · 신호, 14일 성과 + 스파크라인 + 직전 대비, CSV */
import { useMemo, useState } from 'react';
import type { Dataset, IntentId } from '@/core/types';
import { INTENT_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { fmt, fmtDate, metrics } from '@/core/util';
import { Button, Card, DataTable, Drawer, DownloadButton, Field, Pill, Segmented, Src, Stat, type Column } from '@/ui/primitives';
import { HBarChart, LineChart, Sparkline } from '@/ui/charts';
import {
  filterKeywords, groupRollup, intentRollup, keywordCsv, keywordRows, keywordScope, keywordSummary, productGroups, SIGNAL_LABEL,
  type KeywordFilter, type KeywordRow, type KeywordWindow, type SignalId,
} from './engine';
import { NumCell, SignalPills, VerdictBadge } from './parts';
import { BOARD_RULES, KEYWORD_WINDOWS } from './data';

type SparkMetric = 'cost' | 'conversions' | 'revenue';
const SIGNAL_OPTIONS: { id: 'all' | 'any' | SignalId; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'any', label: '신호 있음' },
  ...(Object.keys(SIGNAL_LABEL) as SignalId[]).map((id) => ({ id, label: SIGNAL_LABEL[id] })),
];
const INTENT_COLOR: Record<IntentId, string> = { brand: '--series-1', generic: '--series-2', problem: '--series-3', compare: '--series-4', life: '--series-7' };

export function KeywordTab({ d }: { d: Dataset }) {
  const [win, setWin] = useState<KeywordWindow>(14);
  const [intents, setIntents] = useState<IntentId[]>([]);
  const [status, setStatus] = useState<'all' | 'on' | 'test'>('all');
  const [group, setGroup] = useState('all');
  const [signal, setSignal] = useState<'all' | 'any' | SignalId>('all');
  const [query, setQuery] = useState('');
  const [spark, setSpark] = useState<SparkMetric>('cost');
  const [open, setOpen] = useState<KeywordRow | null>(null);

  const all = useMemo(() => keywordRows(d, win), [d, win]);
  const rows = useMemo(() => {
    const f: KeywordFilter = { intents, status, group, signal, query };
    return filterKeywords(all, f);
  }, [all, intents, status, group, signal, query]);
  const s = useMemo(() => keywordSummary(rows), [rows]);
  const scope = useMemo(() => keywordScope(d, win), [d, win]);
  const byIntent = useMemo(() => intentRollup(rows), [rows]);
  const byGroup = useMemo(() => groupRollup(rows, d.products), [rows, d.products]);
  const groups = useMemo(() => productGroups(d.products), [d.products]);
  const dirty = intents.length > 0 || status !== 'all' || group !== 'all' || signal !== 'all' || query !== '';
  const reset = () => { setIntents([]); setStatus('all'); setGroup('all'); setSignal('all'); setQuery(''); };
  const toggleIntent = (i: IntentId) => setIntents((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));
  const sigCount = rows.filter((r) => r.signals.some((x) => x.id !== 'new')).length;

  const columns: Column<KeywordRow>[] = [
    {
      key: 'text', label: '키워드', sort: (r) => r.text,
      render: (r) => (
        <div className="board-cell l">
          <strong className="small">{r.text}</strong>
          <span className="board-sub">{r.adgroup} · {r.groupLabel}{r.status === 'test' ? ' · ' : ''}{r.status === 'test' ? <Pill tone="outline">테스트</Pill> : null}</span>
        </div>
      ),
    },
    { key: 'intent', label: '구매 의도', sort: (r) => r.intent, render: (r) => <span className="small nowrap">{r.intentName}</span> },
    { key: 'cost', label: '광고비', align: 'right', sort: (r) => r.cur.cost, render: (r) => <NumCell value={fmt.krw(r.cur.cost)} delta={r.costDelta} invert sub={r.isNew ? '신규' : undefined} /> },
    { key: 'conv', label: '전환', align: 'right', sort: (r) => r.cur.conversions, render: (r) => <NumCell value={fmt.dec1(r.cur.conversions)} delta={r.convDelta} /> },
    { key: 'revenue', label: '매출', align: 'right', sort: (r) => r.cur.revenue, render: (r) => <NumCell value={fmt.krw(r.cur.revenue)} /> },
    { key: 'roas', label: 'ROAS', align: 'right', sort: (r) => r.roas, render: (r) => <NumCell value={<strong>{fmt.roas(r.roas)}</strong>} delta={r.roasDelta} /> },
    { key: 'verdict', label: '목표 대비 판정', sort: (r) => r.ratioPct, render: (r) => <VerdictBadge v={r.verdict} /> },
    { key: 'cpa', label: 'CPA · CVR', align: 'right', sort: (r) => r.cpa, render: (r) => <NumCell value={fmt.krw(r.cpa)} sub={<span className="nowrap">CVR {fmt.pct(r.cvr, 2)}</span>} /> },
    {
      key: 'spark', label: `일별 14일`,
      render: (r) => <Sparkline values={r.daily.map((x) => x[spark])} width={96} height={28} colorVar={INTENT_COLOR[r.intent]} ariaLabel={`${r.text} 일별 ${spark === 'cost' ? '광고비' : spark === 'revenue' ? '매출' : '전환'}`} />,
    },
    { key: 'lost', label: '노출 손실 · 순위', align: 'right', sort: (r) => r.lost, render: (r) => <NumCell value={fmt.ratio(r.lost, 0)} sub={`${fmt.dec1(r.rank)}위`} /> },
    { key: 'signals', label: '신호', sort: (r) => -r.signals.filter((x) => x.id !== 'new').length, render: (r) => <SignalPills signals={r.signals} showBasis max={2} /> },
  ];

  return (
    <div className="stack-lg">
      <Card
        title="키워드 성과 필터"
        sub={`네이버 SA ${all.length}개 키워드 · 최근 ${win}일 vs 직전 ${win}일 · 구매 의도(p.35) · 제품군 묶음 조회(p.13)`}
        actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.13 · p.14 · p.35" /><DownloadButton filename={`mildo-board-keywords-${d.today}.csv`} data={() => keywordCsv(rows, win)} mime="text/csv;charset=utf-8" label={`CSV 내보내기 (${rows.length})`} /></>}
      >
        <div className="stack">
          <div className="stack-sm">
            <span className="field-label">구매 의도</span>
            <div className="board-chips" role="group" aria-label="구매 의도">
              <button type="button" className="board-chip" aria-pressed={intents.length === 0} onClick={() => setIntents([])}>전체</button>
              {INTENT_IDS.map((i) => (
                <button key={i} type="button" className="board-chip" aria-pressed={intents.includes(i)} onClick={() => toggleIntent(i)}>
                  <span className="legend-swatch" style={{ background: `var(${INTENT_COLOR[i]})` }} />{SA_CAMPAIGNS[i].name}
                </button>
              ))}
            </div>
          </div>
          <div className="board-filters">
            <Field label="상태" id="board-kw-status">
              <Segmented options={[{ id: 'all', label: '전체' }, { id: 'on', label: 'ON' }, { id: 'test', label: '테스트' }]} value={status} onChange={setStatus} label="키워드 상태" />
            </Field>
            <Field label="제품군 (사이즈)" id="board-kw-group">
              <select id="board-kw-group" className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="all">전체</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.label}{g.inStock === false ? ' (품절)' : ''}</option>)}
              </select>
            </Field>
            <Field label="신호" id="board-kw-signal">
              <select id="board-kw-signal" className="select" value={signal} onChange={(e) => setSignal(e.target.value as typeof signal)}>
                {SIGNAL_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="검색어" id="board-kw-q">
              <input id="board-kw-q" className="input" placeholder="키워드 · 광고그룹" value={query} onChange={(e) => setQuery(e.target.value)} />
            </Field>
            <Field label="집계 창" id="board-kw-win">
              <Segmented options={KEYWORD_WINDOWS.map((w) => ({ id: w.id, label: w.label }))} value={String(win) as '7' | '14'} onChange={(v) => setWin(v === '7' ? 7 : 14)} label="집계 창" />
            </Field>
            <Field label="스파크라인" id="board-kw-spark">
              <Segmented options={[{ id: 'cost', label: '광고비' }, { id: 'conversions', label: '전환' }, { id: 'revenue', label: '매출' }]} value={spark} onChange={setSpark} label="스파크라인 지표" />
            </Field>
            {dirty ? <Button size="sm" icon="x" onClick={reset}>필터 초기화</Button> : null}
          </div>
        </div>

        <div className="board-mini-stats">
          <Stat label="키워드" value={`${s.count}개`} foot={<span className="muted">신호 {sigCount}개</span>} />
          <Stat label={`광고비 (${win}일)`} value={fmt.krw(s.cur.cost)} delta={s.costDelta} invert />
          <Stat label="매출 · ROAS" value={fmt.roas(s.roas)} delta={s.roasDelta} foot={<span className="muted">매출 {fmt.krw(s.cur.revenue)}</span>} />
          <Stat label="전환 · CPA" value={fmt.dec1(s.cur.conversions)} delta={s.convDelta} foot={<span className="muted">CPA {fmt.won(s.cpa)}</span>} />
        </div>

        <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} initialSort={{ key: 'cost', dir: 'desc' }} maxHeight={620} onRowClick={setOpen} selectedKey={open?.id}
          empty={<span>조건에 맞는 키워드가 없습니다. <button type="button" className="board-linkbtn" onClick={reset}>필터 초기화</button></span>} />
        <div className="xs muted">
          판정은 목표 ROAS {BOARD_RULES.targetRoas}%(브랜드 {BOARD_RULES.brandTargetRoas}%) 대비 비율이며 {Math.round(BOARD_RULES.highEfficiencyRatio * 100)}% 이상 고효율(p.14). 전환 {BOARD_RULES.minConversionsForVerdict}건 미만은 표본 부족으로 표기합니다. CPC 급변은 최근 {BOARD_RULES.keywordAnomalyDays}일 ±{BOARD_RULES.keywordAnomalyPct}%(클릭 {BOARD_RULES.keywordAnomalyMinClicks}회 이상), 고효율 · 노출 손실은 노출 기회 손실 {Math.round(BOARD_RULES.lostShareTrigger * 100)}% 이상. 행을 누르면 일별 상세가 열립니다.
          {' '}키워드 합계는 이 표의 키워드 보고서 {scope.keywords}개 기준이며, 같은 기간({fmtDate(scope.from, false)}–{fmtDate(scope.to, false)}) 네이버 SA 매체 집계 광고비 {fmt.krw(scope.saMediaCost)}와 집계 범위가 다릅니다. 범위 차이는 데이터 연동 시 대조합니다.
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="구매 의도별 묶음" sub="필터 결과 기준 · 광고비 비중 · ROAS" actions={<Src kind="DEMO" />}>
          <DataTable rows={byIntent} rowKey={(r) => r.id} columns={[
            { key: 'label', label: '구매 의도', render: (r) => <span className="small"><strong>{r.label}</strong> <span className="muted">· {r.count}개</span></span> },
            { key: 'cost', label: '광고비', align: 'right', sort: (r) => r.cur.cost, render: (r) => <NumCell value={fmt.krw(r.cur.cost)} sub={fmt.ratio(r.costShare, 0)} /> },
            { key: 'roas', label: 'ROAS', align: 'right', sort: (r) => r.roas, render: (r) => <NumCell value={fmt.roas(r.roas)} delta={r.roasDelta} /> },
            { key: 'conv', label: '전환', align: 'right', sort: (r) => r.cur.conversions, render: (r) => <NumCell value={fmt.dec1(r.cur.conversions)} sub={`CPA ${fmt.krw(r.cpa)}`} /> },
            { key: 'sig', label: '신호', align: 'right', render: (r) => (r.signals ? <Pill tone="warning" icon="alert">{r.signals}건</Pill> : <span className="xs muted">—</span>) },
          ]} />
          <HBarChart data={byIntent.map((r) => ({ label: r.label, value: r.cur.cost, colorVar: INTENT_COLOR[r.id as IntentId], note: `ROAS ${fmt.roas(r.roas)}` }))} format={fmt.krw} />
        </Card>
        <Card title="제품군(사이즈)별 묶음" sub="키워드 텍스트의 사이즈 옵션 ↔ 상품 옵션 재고" actions={<Src kind="DEMO" />}>
          <DataTable rows={byGroup} rowKey={(r) => r.id} columns={[
            { key: 'label', label: '제품군', render: (r) => <span className="small"><strong>{r.label}</strong> <span className="muted">· {r.count}개</span></span> },
            { key: 'stock', label: '옵션 재고', render: (r) => (r.inStock === null || r.inStock === undefined ? <span className="xs muted">해당 없음</span> : r.inStock ? <Pill tone="good" icon="check">재고 정상</Pill> : <Pill tone="critical" icon="alert">품절</Pill>) },
            { key: 'cost', label: '광고비', align: 'right', sort: (r) => r.cur.cost, render: (r) => <NumCell value={fmt.krw(r.cur.cost)} sub={fmt.ratio(r.costShare, 0)} /> },
            { key: 'roas', label: 'ROAS', align: 'right', sort: (r) => r.roas, render: (r) => <NumCell value={fmt.roas(r.roas)} /> },
          ]} />
          {byGroup.some((g) => g.inStock === false && g.cur.cost > 0) ? (
            <div className="xs muted">품절 옵션 제품군에 광고비가 집행 중입니다. 상품 상세로 랜딩하는 키워드는 랜딩 교체 또는 일시 중지 대상입니다(p.45 품절 · 옵션 품절 랜딩).</div>
          ) : null}
        </Card>
      </div>

      {open ? <KeywordDrawer row={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

export function KeywordDrawer({ row: r, onClose }: { row: KeywordRow; onClose: () => void }) {
  const cpc = r.daily.map((x, i) => ({ x: r.dailyDates[i] ?? String(i), y: metrics.cpc(x.cost, x.clicks) }));
  const li = r.landingInfo;
  return (
    <Drawer title={r.text} onClose={onClose}>
      <div className="row" style={{ gap: 6 }}>
        <Src kind="DEMO" />
        <Pill tone="outline">{r.intentName}</Pill>
        <Pill tone="outline">{r.adgroup}</Pill>
        <Pill tone={r.status === 'test' ? 'accent' : 'neutral'}>{r.status === 'test' ? '테스트 그룹' : 'ON'}</Pill>
      </div>
      <div className="board-mini-stats">
        <Stat label="광고비" value={fmt.krw(r.cur.cost)} delta={r.costDelta} invert />
        <Stat label="매출" value={fmt.krw(r.cur.revenue)} delta={r.revenueDelta} />
        <Stat label="ROAS" value={fmt.roas(r.roas)} delta={r.roasDelta} />
        <Stat label="전환" value={fmt.dec1(r.cur.conversions)} delta={r.convDelta} />
      </div>
      <VerdictBadge v={r.verdict} />
      <div className="stack-sm">
        <strong className="small">신호</strong>
        {r.signals.length ? <SignalPills signals={r.signals} showBasis max={6} /> : <span className="small muted">신호 없음</span>}
      </div>
      <div className="stack-sm">
        <strong className="small">일별 CPC (최근 {r.daily.length}일)</strong>
        <LineChart series={[{ id: 'cpc', label: 'CPC', colorVar: '--series-2', points: cpc }]} height={160} yFormat={(v) => fmt.int(v)} xFormat={(x) => (x.includes('-') ? fmtDate(x, false) : x)} zeroBased={false} />
        <span className="xs muted">최근 {BOARD_RULES.keywordAnomalyDays}일 CPC {fmt.delta(r.anomaly.cpcDelta, 0)} · 일평균 전환 {fmt.delta(r.anomaly.convDelta, 0)} (같은 14일 창의 나머지 {Math.max(0, r.daily.length - BOARD_RULES.keywordAnomalyDays)}일 대비)</span>
      </div>
      <div className="stack-sm">
        <strong className="small">입찰 · 노출 · 랜딩</strong>
        <div className="small">입찰가 {fmt.won(r.bid)} · 최대 {fmt.won(r.maxBid)} · 평균 순위 {fmt.dec1(r.rank)}위 · 노출 기회 손실 {fmt.ratio(r.lost, 0)} · 월간 검색량 {fmt.int(r.monthlySearch)}</div>
        <div className="small">랜딩 {li.label}{li.productName ? ` · ${li.productName}` : ''}{li.optionLabel ? ` · ${li.optionLabel} 옵션 ${li.inStock === false ? '품절' : '재고 정상'}` : ''}</div>
        <a className="xs" href={r.landing} target="_blank" rel="noreferrer">{r.landing}</a>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>날짜</th><th className="r">노출</th><th className="r">클릭</th><th className="r">광고비</th><th className="r">CPC</th><th className="r">전환</th><th className="r">매출</th></tr></thead>
          <tbody>
            {r.daily.map((x, i) => (
              <tr key={i}>
                <td>{r.dailyDates[i] ? fmtDate(r.dailyDates[i]) : i + 1}</td>
                <td className="r">{fmt.int(x.impressions)}</td>
                <td className="r">{fmt.int(x.clicks)}</td>
                <td className="r">{fmt.int(x.cost)}</td>
                <td className="r">{fmt.int(metrics.cpc(x.cost, x.clicks))}</td>
                <td className="r">{fmt.dec1(x.conversions)}</td>
                <td className="r">{fmt.krw(x.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <a className="btn sm" href="#adpilot">AD Pilot 키워드 진단 열기</a>
        {r.status === 'test' ? <a className="btn sm" href="#lab">MILDO Lab 테스트 보기</a> : null}
      </div>
    </Drawer>
  );
}
