import { useEffect, useMemo, useState } from 'react';
import { INTENT_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { fmt } from '@/core/util';
import { LineChart } from '@/ui/charts';
import { Button, Callout, Card, Delta, Field, NumberInput, Pill, Src } from '@/ui/primitives';
import { APPROVER_LABEL, bidChangeInput, latestChangeFor, simulateCurve, verifyBidChange } from './engine';
import { ACTIVE, type AdPilotCtx } from './useAdPilot';
import { ApproverPill, Dl, StatusPill, VerdictPill } from './parts';
import { ChangeButtons } from './ProposalsTab';

const STEPS = [-30, -20, -15, -10, -5, 0, 5, 10, 15, 20, 30];

export function VerifyTab({ ap, keywordId, setKeywordId }: { ap: AdPilotCtx; keywordId: string | null; setKeywordId: (id: string) => void }) {
  const defaultId = useMemo(() => ap.proposals.find((p) => p.action === 'bid_up' && !p.isBrand)?.keywordId ?? ap.data.keywords[0]?.id ?? '', [ap.proposals, ap.data.keywords]);
  const id = keywordId ?? defaultId;
  const k = ap.data.keywords.find((x) => x.id === id);
  const d = ap.diag.find((x) => x.id === id);
  const current = k ? ap.bids[k.id] ?? k.bid : 0;
  const [bid, setBid] = useState<number>(d?.proposedBid ?? current);
  const [clickE, setClickE] = useState(ap.cfg.clickElasticity);
  const [cpcE, setCpcE] = useState(ap.cfg.cpcElasticity);
  const [note, setNote] = useState('');
  useEffect(() => { setBid(d?.proposedBid ?? current); setNote(''); }, [id, current]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!k || !d) return <Card title="자동 입찰 검증"><div className="muted small">키워드 데이터가 없습니다.</div></Card>;
  const cfg = { ...ap.cfg, clickElasticity: clickE, cpcElasticity: cpcE, currentBids: ap.bids };
  const v = verifyBidChange(ap.data, k, bid, cfg);
  const curve = simulateCurve(k, current, cfg, STEPS);
  const active = latestChangeFor(ap.state.changes, 'adpilot', k.id, 'bid');
  const hasActive = !!active && ACTIVE.has(active.status);
  const s = v.sim;
  const round10 = (x: number) => Math.round(x / 10) * 10;

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card title="자동 입찰 검증" sub="입찰 변경 전 SAFETY 규칙 대조 + 예상 효과(탄력성 가정)" actions={<><Src kind="PROPOSAL" page="p.14" /><Src kind="DEMO" /></>}>
          <Field label="키워드" id="adpilot-verify-kw">
            <select id="adpilot-verify-kw" className="select" value={id} onChange={(e) => setKeywordId(e.target.value)}>
              {INTENT_IDS.map((i) => (
                <optgroup key={i} label={SA_CAMPAIGNS[i].name}>
                  {ap.data.keywords.filter((x) => x.intent === i).map((x) => <option key={x.id} value={x.id}>{x.text}{x.status === 'test' ? ' (테스트)' : ''}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <div className="row" style={{ gap: 6 }}><VerdictPill d={d} /><span className="xs muted">{d.note}</span></div>
          <div className="adpilot-basis">{d.basis}</div>
          <Dl items={[
            ['시작 입찰가', <span key="s" className="num">{fmt.won(k.bid)}</span>],
            ['현재 입찰가', <span key="c" className="num">{fmt.won(current)}{current !== k.bid ? <span className="muted"> (오늘 반영 {fmt.delta((current / k.bid - 1) * 100)})</span> : null}</span>],
            ['최대 입찰가', <span key="m" className="num">{fmt.won(k.maxBid)}</span>],
            ['일 상한 범위', <span key="r" className="num">{fmt.won(Math.ceil((k.bid * (1 - ap.cfg.dailyChangeCapPct / 100)) / 10) * 10)} ~ {fmt.won(Math.floor((k.bid * (1 + ap.cfg.dailyChangeCapPct / 100)) / 10) * 10)}</span>],
          ]} />
          <Field label="새 입찰가 (원)" id="adpilot-verify-bid">
            <NumberInput id="adpilot-verify-bid" value={bid} step={10} min={10} onChange={setBid} suffix="원" />
          </Field>
          <div className="row" style={{ gap: 4 }}>
            {[-20, -10, -5, 5, 10, 20].map((p) => <Button key={p} size="sm" onClick={() => setBid(round10(current * (1 + p / 100)))}>{p > 0 ? '+' : ''}{p}%</Button>)}
            {d.proposedBid !== null ? <Button size="sm" variant="accent" onClick={() => setBid(d.proposedBid!)}>AD Pilot 제안값</Button> : null}
          </div>
        </Card>

        <Card title="SAFETY 검증 결과" sub={`변경 ${fmt.delta(v.changePct)} · 시작가 대비 ${fmt.delta(v.startPct)}`} actions={<ApproverPill level={v.route.approver} title={v.route.reason} />}>
          <div className="stack-sm">
            {v.items.map((i) => (
              <div key={i.id} className="row-between small" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <Pill tone={i.level === 'pass' ? 'good' : i.level === 'warn' ? 'warning' : 'critical'} icon={i.level === 'pass' ? 'check' : i.level === 'warn' ? 'alert' : 'x'}>{i.level === 'pass' ? '통과' : i.level === 'warn' ? '주의' : '차단'}</Pill>
                  <strong>{i.label}</strong>
                </span>
                <span className="xs muted" style={{ textAlign: 'right', maxWidth: '55%' }}>{i.detail}</span>
              </div>
            ))}
          </div>
          <div className="xs muted">승인 주체: {APPROVER_LABEL[v.route.approver]} — {v.route.reason}</div>
          {v.blocked ? <Callout tone="critical" title="승인 요청 불가">차단 항목을 해소해야 요청할 수 있습니다.</Callout> : v.warned ? <Callout tone="warning">주의 항목이 있어 승인 주체가 근거를 확인해야 합니다.</Callout> : null}
          <Field label="요청 메모 (왜)" id="adpilot-verify-note">
            <input id="adpilot-verify-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 경쟁사 브랜드 지면 침투 대응" />
          </Field>
          {hasActive ? (
            <div className="row" style={{ gap: 6 }}>
              <StatusPill status={active!.status} /><span className="xs muted">{active!.before} → {active!.after}</span>
              <ChangeButtons ap={ap} c={active!} />
            </div>
          ) : (
            <Button variant="primary" icon="send" disabled={v.blocked} onClick={() => ap.requestInput(bidChangeInput(k, current, bid, v, ap.state.role, note))}>
              승인 요청 ({APPROVER_LABEL[v.route.approver]})
            </Button>
          )}
        </Card>

        <Card title="예상 효과 (일 기준)" sub="가정 · 실측 아님 — 반영 후 7일 실측으로 검증" actions={<Src kind="DEMO" title="최근 14일 테스트 데이터 기준 + 탄력성 가정" />}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th /><th className="r">현재</th><th className="r">변경 후</th><th className="r">증감</th></tr></thead>
              <tbody>
                <tr><td>클릭</td><td className="r">{fmt.dec1(s.base.clicks)}</td><td className="r">{fmt.dec1(s.projected.clicks)}</td><td className="r"><Delta pct={s.delta.clicksPct} /></td></tr>
                <tr><td>CPC</td><td className="r">{fmt.won(s.base.cpc)}</td><td className="r">{fmt.won(s.projected.cpc)}</td><td className="r"><Delta pct={((s.projected.cpc / s.base.cpc) - 1) * 100} invert /></td></tr>
                <tr><td>비용</td><td className="r">{fmt.won(s.base.cost)}</td><td className="r">{fmt.won(s.projected.cost)}</td><td className="r"><Delta pct={s.delta.costPct} invert /></td></tr>
                <tr><td>전환</td><td className="r">{s.base.conversions.toFixed(2)}</td><td className="r">{s.projected.conversions.toFixed(2)}</td><td className="r"><Delta pct={s.delta.convPct} /></td></tr>
                <tr><td>매출</td><td className="r">{fmt.krw(s.base.revenue)}</td><td className="r">{fmt.krw(s.projected.revenue)}</td><td className="r"><Delta pct={s.delta.revenuePct} /></td></tr>
                <tr><td>ROAS</td><td className="r">{fmt.roas(s.base.roas)}</td><td className="r">{fmt.roas(s.projected.roas)}</td><td className="r">—</td></tr>
                <tr><td><strong>증분 ROAS</strong></td><td /><td className="r"><strong>{fmt.roas(s.incrementalRoas)}</strong></td>
                  <td className="r">{Number.isFinite(s.incrementalRoas) ? <Pill tone={s.incrementalRoas >= d.target ? 'good' : 'serious'}>{s.incrementalRoas >= d.target ? '목표 이상' : '목표 미만'} · {fmt.roas(d.target)}</Pill> : '—'}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="grid g-2">
            <Field label="클릭 탄력성 (가정)" id="adpilot-e-click" hint="입찰 1% → 클릭 %"><NumberInput id="adpilot-e-click" value={clickE} step={0.05} min={0} max={3} onChange={setClickE} /></Field>
            <Field label="CPC 탄력성 (가정)" id="adpilot-e-cpc" hint="입찰 1% → CPC %"><NumberInput id="adpilot-e-cpc" value={cpcE} step={0.05} min={0} max={3} onChange={setCpcE} /></Field>
          </div>
          <div className="xs muted">클릭 증가는 노출 손실분({fmt.ratio(d.lost, 0)}) 회수가 상한입니다{s.clickCapped ? ' — 이번 변경에 상한 적용' : ''}. CVR은 불변으로 둡니다.</div>
        </Card>
      </div>

      <Card title={`입찰 수준별 예상 일 비용 · 매출 — ${k.text}`} sub={`현재 ${fmt.won(current)} 기준 −30% ~ +30%. 일 조정 폭 상한 ±${ap.cfg.dailyChangeCapPct}% 밖은 실행 불가 구간입니다.`} actions={<Src kind="DEMO" title="탄력성 가정 시뮬레이션" />}>
        <LineChart
          height={220}
          series={[
            { id: 'rev', label: '예상 일 매출', colorVar: '--series-1', points: curve.map((c) => ({ x: `${c.pct > 0 ? '+' : ''}${c.pct}%`, y: c.revenue })) },
            { id: 'cost', label: '예상 일 비용', colorVar: '--series-2', points: curve.map((c) => ({ x: `${c.pct > 0 ? '+' : ''}${c.pct}%`, y: c.cost })) },
          ]}
          yFormat={(y) => fmt.krw(y)}
          ariaLabel="입찰 수준별 예상 일 매출과 비용"
        />
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>입찰 변경</th>{curve.map((c) => <th key={c.pct} className="r">{c.pct > 0 ? '+' : ''}{c.pct}%</th>)}</tr></thead>
            <tbody>
              <tr><td>입찰가</td>{curve.map((c) => <td key={c.pct} className="r">{fmt.int(c.bid)}</td>)}</tr>
              <tr><td>ROAS</td>{curve.map((c) => <td key={c.pct} className="r">{fmt.roas(c.roas)}</td>)}</tr>
              <tr><td>증분 ROAS</td>{curve.map((c) => <td key={c.pct} className="r">{c.pct === 0 ? '—' : fmt.roas(c.incrementalRoas)}</td>)}</tr>
              <tr><td>실행 가능</td>{curve.map((c) => {
                const startPct = (c.bid / k.bid - 1) * 100;
                const ok = Math.abs(startPct) <= ap.cfg.dailyChangeCapPct + 1e-9 && c.bid <= k.maxBid && c.bid >= ap.cfg.minBid;
                return <td key={c.pct} className="r">{c.pct === 0 ? '현재' : ok ? <span className="delta-up">가능</span> : <span className="delta-down">차단</span>}</td>;
              })}</tr>
            </tbody>
          </table>
        </div>
        <div className="xs muted">증분 ROAS = 추가 매출 ÷ 추가 비용. 평균 ROAS가 높아도 증분 ROAS가 목표 미만인 구간부터는 추가 비용의 회수 효율이 목표에 못 미칩니다.</div>
      </Card>
    </div>
  );
}
