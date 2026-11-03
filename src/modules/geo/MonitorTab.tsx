/* GEO 모니터링 — 질의 × 엔진 매트릭스(데모 스냅샷) + Claude 라이브 진단 + 엔진 · 경쟁사 · 인용 집계 */
import { useMemo, useRef, useState } from 'react';
import type { IntentId } from '@/core/types';
import { useAi } from '@/ai/useAi';
import { AI_ERROR_COPY, type AiError } from '@/ai/claude';
import { fmt, fmtDate, hhmm, nowIso } from '@/core/util';
import { toCsv } from '@/core/download';
import { Button, Callout, Card, CopyButton, DataTable, DownloadButton, Empty, Pill, Segmented, Src, Swatch, type Column } from '@/ui/primitives';
import { HBarChart, LineChart, ShareBar } from '@/ui/charts';
import { CITE_LABEL, COMPETITOR_COLOR, COMPETITOR_COLOR_FALLBACK, GEO_ROUNDS, GEO_RULES, LIVE_ENGINE } from './data';
import {
  BRAND, dateLabel, DENIED_CODES, INTENT_LABEL, liveSummary, liveVerdict, parseAiAnswer, visibilityMarkdown, visibilityRows, type GeoSnapshot, type LiveRecord, type QueryStat, type Visibility,
} from './engine';
import { EngineCell, IntentPill, LiveCell, VerdictBadge } from './parts';

type IntentFilter = 'all' | IntentId;

const LIVE_DENIED_COPY = 'Claude 사용이 허용되지 않아 라이브 진단을 실행할 수 없습니다. 매트릭스(데모 스냅샷)와 지난 라이브 기록은 그대로 볼 수 있습니다.';

/** 이 탭의 수치는 모두 데모 진단 스냅샷(buildGeoSnapshot)에서 나온다 — 워크스페이스 데이터가 실연동이어도 TEST DATA (fixture) */
function SnapSrc() {
  return <Src kind="DEMO" fixture title="데모 진단 스냅샷 · 실제 엔진 응답 아님" />;
}

export function MonitorTab({ snap, vis, roundIndex, onRound, live, latest, onLive, onClearLive }: {
  snap: GeoSnapshot; vis: Visibility; roundIndex: number; onRound: (i: number) => void;
  live: LiveRecord[]; latest: Record<string, LiveRecord>; onLive: (r: LiveRecord) => void; onClearLive: () => void;
}) {
  const ai = useAi();
  const [intent, setIntent] = useState<IntentFilter>('all');
  const [sel, setSel] = useState<string>(() => vis.gaps[0]?.query.id ?? vis.queries[0]?.query.id ?? '');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // Claude 사용 거부(not_granted 등) 뒤에는 버튼을 끄고 이유를 보여 준다 — 재요청하지 않는다 (아티팩트 계약)
  const [blocked, setBlocked] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const rows = useMemo(() => vis.queries.filter((q) => intent === 'all' || q.query.intent === intent), [vis, intent]);
  const selected = vis.queries.find((q) => q.query.id === sel) ?? null;
  const ls = liveSummary(Object.values(latest));
  const nE = snap.engines.length;
  const need = Math.min(GEO_RULES.coveredEngines, Math.max(1, nE));

  const usable = ai.connected && !blocked;
  const reason = ai.backend === 'checking' ? 'AI 연결 상태를 확인하는 중입니다.'
    : blocked ?? (ai.connected ? '' : 'AI 미연결 — 설정에서 Anthropic API 키를 입력하거나 claude.ai 아티팩트에서 열면 사용할 수 있습니다.');

  const running = useRef(false);
  const runLive = async (ids: string[]) => {
    if (!usable || !ids.length || running.current) return;
    running.current = true;
    setNote('');
    ctl.current = new AbortController();
    for (const id of ids) {
      const q = snap.queries.find((x) => x.id === id);
      if (!q) continue;
      setBusy(id);
      try {
        // 질의 문장을 그대로 보낸다 (지시문 · 브랜드 맥락을 붙이지 않음)
        const { text, backend } = await ai.ask(q.text, { signal: ctl.current.signal, cache: false });
        onLive({ ...parseAiAnswer(text), queryId: q.id, query: q.text, at: nowIso(), backend });
      } catch (e) {
        const err = e as AiError;
        if (DENIED_CODES.has(err.code)) setBlocked(LIVE_DENIED_COPY);
        else if (err.code !== 'cancelled') setNote(AI_ERROR_COPY[err.code] ?? err.message);
        break;
      }
    }
    running.current = false;
    setBusy(null);
    setChecked(new Set());
  };

  const toggle = (id: string) => setChecked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const columns: Column<QueryStat>[] = [
    {
      key: 'chk', label: <span className="sr-only">라이브 진단 대상</span>, width: 28,
      render: (r) => (
        <input id={`geo-live-${r.query.id}`} type="checkbox" className="geo-row-check" aria-label={`${r.query.text} 라이브 진단 대상`} checked={checked.has(r.query.id)}
          onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.query.id)} />
      ),
    },
    {
      key: 'q', label: '질의 · 구매 의도', sort: (r) => r.query.id,
      render: (r) => (
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className="geo-qtext">{r.query.text}</span>
          <span className="row" style={{ gap: 4 }}><IntentPill intent={r.query.intent} />{r.gap ? <Pill tone="serious" icon="alert" title={r.gapBasis}>경쟁사 우위 · 경쟁 {r.competitorEngines}/{nE} · 자사 {r.mentionedEngines}/{nE} (기준 ≥{GEO_RULES.gapCompetitorEngines} · ≤{GEO_RULES.gapBrandMax})</Pill> : null}</span>
        </div>
      ),
    },
    { key: 'status', label: `판정 (확보 ≥${need}/${nE})`, sort: (r) => r.mentionedEngines, render: (r) => <VerdictBadge v={r.status} /> },
    ...snap.engines.map((e): Column<QueryStat> => ({
      key: e.id, label: e.short, align: 'center', sort: (r) => (r.cells[e.id]?.mentioned ? 10 - (r.cells[e.id]?.position ?? 9) : 0),
      render: (r) => <EngineCell cell={r.cells[e.id]} rounds={r.roundsMentioned[e.id]} />,
    })),
    { key: 'live', label: <span className="row" style={{ gap: 4 }}>{LIVE_ENGINE.name}<Src kind="LIVE" /></span>, align: 'center', render: (r) => <LiveCell rec={latest[r.query.id]} /> },
    { key: 'comp', label: '최다 경쟁사', sort: (r) => r.competitorEngines, render: (r) => r.topCompetitor ? <span className="small">{r.topCompetitor} <span className="muted">· {r.competitorEngines}/{nE} 엔진</span></span> : <span className="muted xs">없음</span> },
  ];

  const trendSeries = useMemo(() => [
    ...snap.engines.map((e) => ({ id: e.id, label: e.short, colorVar: e.colorVar, points: vis.trend.map((t) => ({ x: t.date, y: (t.byEngine[e.id] ?? 0) * 100 })) })),
    { id: 'all', label: '전체', colorVar: '--ink-2', dashed: true, points: vis.trend.map((t) => ({ x: t.date, y: t.overall * 100 })) },
  ], [snap, vis]);

  if (!vis.hasData) return <Card><Empty icon="search" title="진단 스냅샷이 없습니다">정기 진단 수집 연동 후 표시됩니다.</Empty></Card>;

  return (
    <div className="stack-lg">
      <div className="row-between">
        <div className="row">
          <span className="small muted">진단 회차</span>
          <Segmented label="진단 회차" value={String(roundIndex)} onChange={(v) => onRound(Number(v))}
            options={vis.rounds.map((d, i) => ({ id: String(i), label: `${fmtDate(d)}${i === vis.rounds.length - 1 ? ' 최신' : ''}` }))} />
        </div>
        <Segmented label="구매 의도" value={intent} onChange={setIntent}
          options={[{ id: 'all', label: '전체' }, ...(['brand', 'generic', 'problem', 'compare', 'life'] as IntentId[]).map((i) => ({ id: i, label: INTENT_LABEL[i] }))]} />
      </div>

      {/* 매트릭스는 엔진 5개 + Claude 열이 모두 보이도록 전체 폭, 상세 · 라이브 진단은 아래 두 열 */}
      <div className="grid g-3 geo-split">
        <Card className="span-2" title="질의 × 엔진 매트릭스"
          sub={`${dateLabel(vis.date)} 정기 진단 · 질의 ${vis.queries.length}개 × 엔진 ${snap.engines.length}개 · 셀: 수면밀도 언급 순서 · 경쟁사 수 · 최근 ${GEO_ROUNDS}회 중 언급 횟수`}
          actions={
            <>
              <SnapSrc />
              <CopyButton text={() => visibilityMarkdown(vis, latest)} label="진단 결과 복사" />
              <DownloadButton filename={`searchtune-geo-${vis.date ?? 'snapshot'}.md`} data={() => visibilityMarkdown(vis, latest)} label=".md" />
              <DownloadButton filename={`searchtune-geo-${vis.date ?? 'snapshot'}.csv`} data={() => toCsv(visibilityRows(vis, latest))} mime="text/csv;charset=utf-8" label="CSV" />
            </>
          }>
          <div className="geo-legend">
            <span className="geo-cell first">1번째</span><span>가장 먼저 언급</span>
            <span className="geo-cell on">2번째</span><span>언급</span>
            <span className="geo-cell">—</span><span>미언급</span>
            <span>경N = 함께 언급된 경쟁사 수</span>
            <span className="geo-cell live">미진단</span><span>Claude 라이브 (실제 응답)</span>
          </div>
          <div className="geo-matrix">
            <DataTable rows={rows} columns={columns} rowKey={(r) => r.query.id} onRowClick={(r) => setSel(r.query.id)} selectedKey={sel} maxHeight={560}
              empty="해당 의도의 질의가 없습니다" />
          </div>
          <div className="xs muted">데모 진단 스냅샷입니다(TEST DATA). 실제 엔진별 응답은 수집 연동 후 같은 형식으로 채웁니다. 행을 누르면 아래에 상세가 열립니다.</div>
        </Card>

        <div className="stack-lg">
          <Card title={selected ? `'${selected.query.text}'` : '질의 선택'} sub={selected ? `${INTENT_LABEL[selected.query.intent]} · ${dateLabel(vis.date)} 진단` : '매트릭스에서 질의를 고르세요'} actions={<SnapSrc />}>
            {selected ? (
              <div className="stack-sm">
                <VerdictBadge v={selected.status} inline />
                {selected.gap ? <Callout tone="warning" title="경쟁사 우위 질의">{selected.gapBasis}</Callout> : null}
                {snap.engines.map((e) => {
                  const c = selected.cells[e.id];
                  return (
                    <div key={e.id} className="geo-detail-row">
                      <Swatch colorVar={e.colorVar} label={<strong>{e.short}</strong>} />
                      <div className="stack-sm" style={{ gap: 3 }}>
                        <span className="small">{c?.mentioned ? `${BRAND} ${c.position}번째` : `${BRAND} 미언급`} <span className="muted">· 최근 {GEO_ROUNDS}회 중 {selected.roundsMentioned[e.id] ?? 0}회</span></span>
                        {c?.order.length ? <span className="xs muted">등장 순서 {c.order.join(' → ')}</span> : null}
                        {c?.citations.length ? (
                          <span className="geo-chips">{c.citations.map((x, i) => <Pill key={`${x.domain}${i}`} tone={x.owned ? 'accent' : 'outline'}>{CITE_LABEL[x.domain] ?? x.domain}{x.owned ? ' · 자사' : ''}</Pill>)}</span>
                        ) : <span className="xs muted">인용 없음</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <Empty icon="search" title="질의를 선택하세요" />}
          </Card>

          <Card tone="dark" title={<span className="row" style={{ gap: 6 }}>라이브 진단 · Claude <Src kind="LIVE" /></span>}
            sub="Claude 응답 기준 진단이며 다른 엔진은 수집 연동 필요">
            <div className="row" style={{ gap: 6 }}>
              <Pill tone={usable ? 'good' : 'neutral'} icon={usable ? 'check' : 'zap'}>{ai.backend === 'checking' ? '확인 중' : blocked ? 'Claude 사용 불가' : ai.connected ? 'Claude 연결됨' : 'AI 미연결'}</Pill>
              <span className="xs muted">질의 문장을 지시문 없이 그대로 보내고, 답변에서 '수면밀도 · 밀도 매트리스' 언급 · 순서 · 경쟁사 · 인용 URL을 파싱합니다.</span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {/* 진단 중에도 시작 버튼은 제자리에서 비활성으로 둔다 — 빠른 두 번 클릭의 두 번째가 '중지'에 떨어져 방금 시작한 진단을 취소하지 않도록 */}
              <Button size="sm" variant="accent" icon="sparkle" disabled={!usable || !selected || !!busy} title={reason || undefined} onClick={() => selected && runLive([selected.query.id])}>선택 질의 진단</Button>
              <Button size="sm" icon="play" disabled={!usable || checked.size === 0 || !!busy} title={reason || (checked.size ? undefined : '매트릭스에서 체크한 질의가 없습니다')} onClick={() => runLive([...checked])}>체크한 {checked.size}개 일괄 진단</Button>
              {busy ? <Button size="sm" icon="stop" onClick={() => ctl.current?.abort()}>중지</Button> : null}
            </div>
            {busy ? <div className="xs">'{snap.queries.find((q) => q.id === busy)?.text}' 진단 중…</div> : null}
            {reason ? <div className="xs muted">{reason}</div> : null}
            {note ? <div className="xs">{note}</div> : null}
            {selected && latest[selected.query.id] ? (() => {
              const r = latest[selected.query.id];
              return (
                <div className="stack-sm">
                  <VerdictBadge v={liveVerdict(r)} inline />
                  <div className="xs muted">{hhmm(r.at)} 기록 · 응답 {fmt.int(r.chars)}자 · 등장 순서 {r.order.join(' → ') || '브랜드 언급 없음'}</div>
                  {r.citations.length ? <span className="geo-chips">{r.citations.map((c) => <Pill key={c.domain} tone={c.owned ? 'accent' : 'outline'}>{c.domain}</Pill>)}</span> : <span className="xs muted">인용 URL 없음</span>}
                  <div className="geo-quote">{r.excerpt || '—'}</div>
                </div>
              );
            })() : selected ? <div className="xs muted">'{selected.query.text}' 라이브 기록 없음</div> : null}
            <div className="row-between">
              <span className="xs muted">라이브 기록 {ls.count}개 질의 · 언급 {ls.mentioned}개{ls.count ? ` (${fmt.pct(ls.rate * 100, 0)})` : ''}</span>
              {live.length ? <Button size="sm" variant="ghost" icon="x" onClick={onClearLive}>기록 지우기</Button> : null}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid g-3">
        <Card className="span-2" title="엔진별 브랜드 언급률 추이" sub={`최근 ${vis.trend.length}회 정기 진단(매주 월) · 질의 ${vis.queries.length}개 기준`} actions={<SnapSrc />}>
          <LineChart series={trendSeries} height={210} yFormat={(v) => `${Math.round(v)}%`} xFormat={(x) => fmtDate(x, false)} zeroBased ariaLabel="엔진별 브랜드 언급률 추이" />
          <DataTable rows={vis.engines} rowKey={(e) => e.id}
            columns={[
              { key: 'n', label: '엔진', render: (e) => <Swatch colorVar={e.colorVar} label={<strong>{e.name}</strong>} /> },
              { key: 'rate', label: '언급률', align: 'right', sort: (e) => e.rate, render: (e) => <span className="num nowrap"><strong>{fmt.pct(e.rate * 100, 0)}</strong> <span className="muted xs">{e.mentioned}/{e.total}</span></span> },
              { key: 'd', label: '직전 대비', align: 'right', sort: (e) => e.deltaPp ?? 0, render: (e) => <span className="num small">{e.deltaPp === null ? '—' : `${e.deltaPp >= 0 ? '+' : ''}${e.deltaPp.toFixed(0)}pp`}</span> },
              { key: 'pos', label: '평균 순서', align: 'right', sort: (e) => e.avgPosition, render: (e) => <span className="num small">{Number.isFinite(e.avgPosition) ? `${fmt.dec1(e.avgPosition)}번째` : '—'}</span> },
              { key: 'cite', label: '자사 인용 / 전체', align: 'right', sort: (e) => e.ownedCitations, render: (e) => <span className="num small">{e.ownedCitations} / {e.citations}</span> },
              { key: 'sov', label: '경쟁사 대비 점유', align: 'right', sort: (e) => e.sov, render: (e) => <span className="num small">{fmt.pct(e.sov * 100, 0)}</span> },
              { key: 'v', label: '판정', render: (e) => <VerdictBadge v={e.verdict} /> },
            ]} />
        </Card>
        <div className="stack-lg">
          <Card title="경쟁 6개사 대비 언급 점유" sub={`${dateLabel(vis.date)} · 셀 단위 언급 수 기준 (RFP 경쟁사)`} actions={<SnapSrc />}>
            <ShareBar parts={[
              { label: BRAND, value: vis.overall.brandMentions, colorVar: '--accent' },
              ...vis.competitors.map((c) => ({ label: c.name, value: c.mentions, colorVar: COMPETITOR_COLOR[c.name] ?? COMPETITOR_COLOR_FALLBACK })),
            ]} />
            <div className="xs muted">점유 = {BRAND} 언급 ÷ ({BRAND} + 경쟁 6개사 언급) = {fmt.pct(vis.overall.sov * 100, 1)}{vis.overall.prevSov !== null ? ` · 직전 ${fmt.pct(vis.overall.prevSov * 100, 1)}` : ''}</div>
            <DataTable rows={vis.competitors} rowKey={(c) => c.name}
              columns={[
                { key: 'n', label: '경쟁사', render: (c) => <strong className="small">{c.name}</strong> },
                { key: 'm', label: '언급 셀', align: 'right', sort: (c) => c.mentions, render: (c) => <span className="num small">{c.mentions}</span> },
                { key: 'e', label: '엔진', align: 'right', render: (c) => <span className="num small">{c.engines}/{nE}</span> },
                { key: 'a', label: '자사보다 먼저', align: 'right', sort: (c) => c.aheadOfBrand, render: (c) => <span className="num small">{c.aheadOfBrand}</span> },
              ]} />
          </Card>
          <Card title="인용 출처" sub={`인용 ${vis.overall.citations}건 · 자사 채널 ${vis.overall.ownedCitations}건 (${fmt.pct(vis.overall.ownedShare * 100, 0)})`} actions={<SnapSrc />}>
            <HBarChart data={vis.citeSources.slice(0, 8).map((c) => ({ label: `${c.label}${c.owned ? ' · 자사' : ''}`, value: c.count, colorVar: c.owned ? '--accent' : '--series-1' }))} format={(v) => `${Math.round(v)}건`} />
          </Card>
        </div>
      </div>

      <div className="grid g-2">
        <Card title="구매 의도별 언급률" sub="SA 캠페인 5종(p.35) 기준 질의 묶음" actions={<SnapSrc />}>
          <HBarChart data={vis.byIntent.map((b) => ({ label: b.label, value: b.rate * 100, colorVar: '--series-1', note: `${b.mentioned}/${b.total}셀` }))} format={(v) => `${Math.round(v)}%`} max={100}
            refValue={GEO_RULES.engineRateGood * 100} refLabel={`확보 기준 ${GEO_RULES.engineRateGood * 100}%`} />
        </Card>
        <Card title="반복 관측 패턴" sub={`최근 ${vis.stability.rounds}회 진단에서 같은 질의 · 엔진 셀의 언급 횟수`} actions={<SnapSrc />}>
          <ShareBar format={(s) => `${Math.round(s * 100)}%`} parts={[
            { label: `안정 (≥${GEO_RULES.stableRounds}회) ${vis.stability.stable}셀`, value: vis.stability.stable, colorVar: '--series-3' },
            { label: `변동 (1~${GEO_RULES.stableRounds - 1}회) ${vis.stability.volatile}셀`, value: vis.stability.volatile, colorVar: '--series-4' },
            { label: `미언급 (0회) ${vis.stability.never}셀`, value: vis.stability.never, colorVar: '--line-strong' },
          ]} />
          <div className="small ink2">AI 답변은 질의 시점 · 로그인 상태 · 지역 · 대화 맥락에 따라 달라집니다. 변동 구간은 한 번의 진단으로 개선 · 악화를 판정하지 않고, 2회 연속 같은 방향일 때만 변화로 기록합니다.</div>
          {vis.gaps.length ? (
            <div className="stack-sm">
              <span className="small"><strong>경쟁사 우위 질의 {vis.gaps.length}개</strong> <span className="muted">· 경쟁사 ≥{GEO_RULES.gapCompetitorEngines}개 엔진 & {BRAND} ≤{GEO_RULES.gapBrandMax}개</span></span>
              <div className="geo-chips">{vis.gaps.map((g) => <button key={g.query.id} type="button" className="btn sm" onClick={() => setSel(g.query.id)} title={g.gapBasis}>{g.query.text}</button>)}</div>
            </div>
          ) : <span className="small muted">경쟁사 우위 질의 없음</span>}
        </Card>
      </div>
    </div>
  );
}
