import { useMemo, useState } from 'react';
import type { IntentId } from '@/core/types';
import { INTENT_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { fmt } from '@/core/util';
import { toCsv } from '@/core/download';
import { Sparkline } from '@/ui/charts';
import { Button, Card, type Column, DataTable, Delta, DownloadButton, Field, Pill, Segmented, Src } from '@/ui/primitives';
import { type KeywordDiagnosis, type Verdict, VERDICT_META, intentSummary, pct0 } from './engine';
import type { AdPilotCtx } from './useAdPilot';
import { VerdictPill } from './parts';

export function DiagnosisTab({ ap, onVerify }: { ap: AdPilotCtx; onVerify: (keywordId: string) => void }) {
  const [intent, setIntent] = useState<IntentId | 'all'>('all');
  const [verdict, setVerdict] = useState<Verdict | 'all'>('all');
  const [q, setQ] = useState('');
  const kwById = useMemo(() => new Map(ap.data.keywords.map((k) => [k.id, k])), [ap.data.keywords]);
  const rows = ap.diag.filter((d) => (intent === 'all' || d.intent === intent) && (verdict === 'all' || d.verdict === verdict) && (!q.trim() || d.text.includes(q.trim())));
  const counts = useMemo(() => {
    const c: Partial<Record<Verdict, number>> = {};
    for (const d of ap.diag) c[d.verdict] = (c[d.verdict] ?? 0) + 1;
    return c;
  }, [ap.diag]);
  const intents = useMemo(() => intentSummary(ap.data, ap.cfg), [ap.data, ap.cfg]);
  /** MILDO Alert 이슈 연계 보류 (키워드 단위 · 네이버 SA 매체 단위) — 데이터 판정 배지와 별도로 표시 */
  const alertHold = useMemo(() => {
    const byKw = new Map(ap.proposals.filter((p) => p.action === 'hold' && p.targetType === 'keyword' && p.linkedIncidents?.length).map((p) => [p.keywordId, p]));
    const sa = ap.proposals.find((p) => p.action === 'hold' && p.targetType === 'media' && p.media === 'naver_sa' && p.linkedIncidents?.length);
    return (id: string) => byKw.get(id) ?? sa;
  }, [ap.proposals]);

  const columns: Column<KeywordDiagnosis>[] = [
    { key: 'text', label: '키워드', sort: (d) => d.text, render: (d) => <div className="stack-sm" style={{ gap: 0 }}><strong className="small">{d.text}</strong><span className="xs muted">{d.adgroup}{d.isBrand ? ' · 브랜드' : ''}</span></div> },
    { key: 'verdict', label: '판정 · 근거 (기준값)', sort: (d) => d.verdict, render: (d) => (
      <div className="stack-sm adpilot-verdict-cell" style={{ gap: 2 }}>
        <span className="row" style={{ gap: 6 }}><VerdictPill d={d} />{d.proposedBid !== null ? <span className="small num">{fmt.won(d.bid)} → <strong>{fmt.won(d.proposedBid)}</strong> <Delta pct={d.proposedPct ?? NaN} /></span> : null}</span>
        <span className="adpilot-basis">{d.basis}</span>
        {d.note ? <span className="xs muted">{d.note}</span> : null}
        {(() => {
          const h = alertHold(d.id);
          return h ? <span className="row" style={{ gap: 6 }}><Pill tone="warning" icon="bell">MILDO Alert 연계 보류</Pill><span className="xs muted">{h.linkedIncidents!.map((l) => `${l.severity} ${l.title}`).join(' · ')}</span></span> : null;
        })()}
      </div>
    ) },
    { key: 'roas', label: 'ROAS 14일', align: 'right', sort: (d) => d.roas, render: (d) => fmt.roas(d.roas) },
    { key: 'ratio', label: '목표 대비', align: 'right', sort: (d) => d.ratioPct, render: (d) => <span className={Number.isFinite(d.ratioPct) && d.ratioPct < 100 ? 'delta-down' : undefined}>{pct0(d.ratioPct)}</span> },
    { key: 'prev', label: '직전 14일', align: 'right', sort: (d) => d.prevRatioPct, render: (d) => pct0(d.prevRatioPct) },
    { key: 'lost', label: '노출 손실', align: 'right', sort: (d) => d.lost, render: (d) => <span className={d.lost >= ap.cfg.lostShareTrigger ? 'bold' : undefined}>{fmt.ratio(d.lost, 0)}</span> },
    { key: 'rank', label: '순위', align: 'right', sort: (d) => d.rank, render: (d) => d.rank.toFixed(1) },
    { key: 'conv', label: '전환', align: 'right', sort: (d) => d.conversions, render: (d) => fmt.dec1(d.conversions) },
    { key: 'cpc3', label: 'CPC 3일', align: 'right', sort: (d) => d.anomaly.cpcDelta, render: (d) => <span title={d.anomaly.basis}><Delta pct={d.anomaly.cpcDelta} invert digits={0} />{!d.anomaly.cpcEligible ? <span className="xs muted"> 표본↓</span> : null}</span> },
    { key: 'bid', label: '입찰가 (현재 / 최대)', align: 'right', sort: (d) => d.bid, render: (d) => (
      <span className="num small nowrap">
        {d.bid !== d.startBid ? <span className="muted">{fmt.won(d.startBid)} → </span> : null}<strong>{fmt.won(d.bid)}</strong><span className="muted"> / {fmt.won(d.maxBid)}</span>
      </span>
    ) },
    { key: 'spark', label: '14일 광고비', render: (d) => <Sparkline values={(kwById.get(d.id)?.daily ?? []).map((x) => x.cost)} width={96} height={26} colorVar="--series-1" ariaLabel={`${d.text} 일별 광고비`} /> },
    { key: 'act', label: '', align: 'right', render: (d) => <Button size="sm" icon="target" onClick={() => onVerify(d.id)}>검증</Button> },
  ];

  const csv = () => toCsv(ap.diag.map((d) => ({
    keyword: d.text, intent: SA_CAMPAIGNS[d.intent].name, verdict: VERDICT_META[d.verdict].label, basis: d.basis, note: d.note,
    roas: Math.round(d.roas), ratioPct: Math.round(d.ratioPct), prevRatioPct: Math.round(d.prevRatioPct), lost: Math.round(d.lost * 100), rank: d.rank,
    conversions: Math.round(d.conversions * 100) / 100, bid: d.bid, maxBid: d.maxBid, proposedBid: d.proposedBid ?? '',
  })), [
    { key: 'keyword', label: '키워드' }, { key: 'intent', label: '구매 의도' }, { key: 'verdict', label: '판정' }, { key: 'basis', label: '근거' }, { key: 'note', label: '메모' },
    { key: 'roas', label: 'ROAS(%)' }, { key: 'ratioPct', label: '목표 대비(%)' }, { key: 'prevRatioPct', label: '직전 목표 대비(%)' }, { key: 'lost', label: '노출 손실(%)' },
    { key: 'rank', label: '평균 순위' }, { key: 'conversions', label: '전환' }, { key: 'bid', label: '현재 입찰가' }, { key: 'maxBid', label: '최대 입찰가' }, { key: 'proposedBid', label: '제안 입찰가' },
  ]);

  return (
    <div className="stack-lg">
      <Card title="구매 의도별 효율 (최근 14일)" sub={`브랜드는 별도 기준 ${fmt.roas(ap.cfg.brandTargetRoas)}, 그 외 목표 ${fmt.roas(ap.cfg.targetRoas)} 대비`} actions={<><Src kind="PROPOSAL" page="p.35" /><Src kind="DEMO" /></>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>캠페인 (p.35)</th><th className="r">키워드</th><th className="r">광고비</th><th className="r">매출</th><th className="r">전환</th><th className="r">ROAS</th><th>목표 대비</th></tr></thead>
            <tbody>
              {intents.map((i) => (
                <tr key={i.intent}>
                  <td><strong>{i.name}</strong> <span className="xs muted">· {SA_CAMPAIGNS[i.intent].metric}</span></td>
                  <td className="r">{i.keywords}</td>
                  <td className="r">{fmt.krw(i.cost)}</td>
                  <td className="r">{fmt.krw(i.revenue)}</td>
                  <td className="r">{fmt.dec1(i.conversions)}</td>
                  <td className="r">{fmt.roas(i.roas)}</td>
                  <td><Pill tone={Number.isFinite(i.ratioPct) && i.ratioPct >= 100 ? 'good' : 'serious'} icon={Number.isFinite(i.ratioPct) && i.ratioPct >= 100 ? 'check' : 'alert'}>{Number.isFinite(i.ratioPct) && i.ratioPct >= 100 ? '충족' : '미달'} · 목표 {fmt.roas(i.target)} 대비 {pct0(i.ratioPct)}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="키워드 진단" sub="키워드별 판정 배지 + 근거(목표 대비 %) · 노출 기회 손실 · 순위 · 최근 3일 CPC 변화. 행의 [검증]으로 자동 입찰 검증을 엽니다."
        actions={<><Src kind="PROPOSAL" page="p.14" /><Src kind="DEMO" /><DownloadButton filename={`adpilot-keyword-diagnosis-${ap.data.today}.csv`} data={csv} mime="text/csv;charset=utf-8" label="CSV" /></>}>
        <div className="row" style={{ gap: 6 }}>
          {(Object.keys(VERDICT_META) as Verdict[]).filter((v) => counts[v]).map((v) => (
            <button key={v} type="button" className="btn sm" aria-pressed={verdict === v} style={verdict === v ? { borderColor: 'var(--ink)' } : undefined} onClick={() => setVerdict(verdict === v ? 'all' : v)}>
              {VERDICT_META[v].label} <strong className="num">{counts[v]}</strong>
            </button>
          ))}
          {verdict !== 'all' ? <Button size="sm" variant="ghost" icon="x" onClick={() => setVerdict('all')}>판정 필터 해제</Button> : null}
        </div>
        <div className="row-between">
          <Segmented label="구매 의도" value={intent} onChange={setIntent} options={[{ id: 'all', label: '전체' }, ...INTENT_IDS.map((i) => ({ id: i, label: SA_CAMPAIGNS[i].name }))]} />
          <div style={{ width: 220 }}>
            <Field label="키워드 검색" id="adpilot-kw-q"><input id="adpilot-kw-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="예: 매트리스 추천" /></Field>
          </div>
        </div>
        <DataTable rows={rows} columns={columns} rowKey={(d) => d.id} maxHeight={640} empty="조건에 맞는 키워드가 없습니다" />
        <div className="xs muted">
          판정 순서: 테스트 그룹(Lab 판정) → 급변 · 데이터 이상 보류 → 품절 랜딩 보류 → 브랜드 별도 기준 → 고효율 · 노출 손실 상향 → 목표 미달 지속 하향(전환 {ap.cfg.minConversionsForDown}건 이상) → 유지.
          CPC 3일 변화는 최근 3일 클릭 {ap.cfg.anomalyMinClicks}회 미만이면 표본 부족으로 판정하지 않습니다.
        </div>
      </Card>
    </div>
  );
}
