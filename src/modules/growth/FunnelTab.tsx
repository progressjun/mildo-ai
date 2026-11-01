/* 브랜드스토어 · 자사몰 전환 개선 (p.41) — 퍼널 · 단계 진단 → 액션 · 랜딩 점검 · 채널 간 잠식 · 합산 매출 기준 */
import { useMemo } from 'react';
import type { Dataset } from '@/core/types';
import { SALES_CHANNELS, SA_CAMPAIGNS } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { Callout, Card, DataTable, Delta, Empty, Pill, Src, Stat, type Column } from '@/ui/primitives';
import { Funnel, LineChart } from '@/ui/charts';
import { AiInsight } from '@/ui/AiInsight';
import { FUNNEL_RULES } from './data';
import { deltaPct, growthPrompt, lastDays, type ChannelFunnel, type FunnelDiagnosis, type LandingFinding } from './engine';
import { funnelBrief } from './briefs';
import { Kv, Verdict } from './parts';

function ChannelCard({ c, days }: { c: ChannelFunnel; days: number }) {
  const raw = [
    { label: '유입', value: c.cur.visitors, prev: c.prev.visitors },
    { label: '상품 상세', value: c.cur.detailViews, prev: c.prev.detailViews },
    { label: '장바구니', value: c.cur.carts, prev: c.prev.carts },
    { label: '구매', value: c.cur.orders, prev: c.prev.orders },
  ];
  // 단계별 이탈 = 전 단계 대비 다음 단계로 넘어가지 않은 비율 (직전 기간 대비 %p 변화 병기)
  const steps = raw.map((s, i) => {
    if (i === 0) return { label: s.label, value: s.value, note: `직전 ${days}일 ${fmt.int(s.prev)} · ${fmt.delta(deltaPct(s.value, s.prev))}` };
    const drop = raw[i - 1].value > 0 ? (1 - s.value / raw[i - 1].value) * 100 : NaN;
    const prevDrop = raw[i - 1].prev > 0 ? (1 - s.prev / raw[i - 1].prev) * 100 : NaN;
    const dd = drop - prevDrop;
    const ddTxt = !Number.isFinite(dd) ? '' : Math.abs(dd) < 0.05 ? ' · 직전 대비 변화 없음' : ` · 직전 대비 ${dd > 0 ? '+' : ''}${fmt.dec1(dd)}%p`;
    return { label: s.label, value: s.value, note: `이탈 ${fmt.pct(drop)}${ddTxt}` };
  });
  return (
    <Card title={<>{c.name} 퍼널 <Src kind="DEMO" /></>} sub={`최근 ${days}일 · 직전 ${days}일 대비`}>
      {c.cur.visitors > 0 ? <Funnel steps={steps} format={(v) => fmt.int(v)} /> : <Empty title="퍼널 데이터 없음" />}
      <div className="grid g-3">
        <Stat label="방문 대비 구매" value={fmt.pct(c.rates.cvr, 2)} delta={deltaPct(c.rates.cvr, c.prevRates.cvr)} />
        <Stat label="매출" value={fmt.krw(c.cur.revenue)} delta={deltaPct(c.cur.revenue, c.prev.revenue)} />
        <Stat label="객단가" value={fmt.won(c.rates.aov)} delta={deltaPct(c.rates.aov, c.prevRates.aov)} />
      </div>
    </Card>
  );
}

export function FunnelTab({ d, f }: { d: Dataset; f: FunnelDiagnosis }) {
  const days = f.window.days || FUNNEL_RULES.windowDays;
  const trend = useMemo(() => {
    const dates = lastDays(d, 28);
    const val = (dt: string, ch: 'brandstore' | 'own_mall') => d.salesDaily.find((r) => r.date === dt && r.channel === ch)?.revenue ?? NaN;
    return [
      { id: 'bs', label: SALES_CHANNELS.brandstore.name, colorVar: SALES_CHANNELS.brandstore.colorVar, points: dates.map((x) => ({ x, y: val(x, 'brandstore') })) },
      { id: 'om', label: SALES_CHANNELS.own_mall.name, colorVar: SALES_CHANNELS.own_mall.colorVar, points: dates.map((x) => ({ x, y: val(x, 'own_mall') })) },
      { id: 'sum', label: '합산', colorVar: '--ink-2', dashed: true, points: dates.map((x) => ({ x, y: val(x, 'brandstore') + val(x, 'own_mall') })) },
    ];
  }, [d]);

  if (!f.valid) {
    return <Card title="브랜드스토어 · 자사몰 전환 개선"><Empty title="판매 채널 퍼널 데이터가 없습니다">유입 · 상세 · 장바구니 · 구매 데이터 연동 후 진단합니다.</Empty></Card>;
  }

  const misCols: Column<LandingFinding['mismatches'][number]>[] = [
    { key: 'kw', label: '키워드', render: (r) => <strong>{r.keyword}</strong> },
    { key: 'camp', label: '캠페인', render: (r) => SA_CAMPAIGNS[r.intent].name },
    { key: 'exp', label: 'p.35 랜딩', render: (r) => r.expected },
    { key: 'act', label: '현재 랜딩', render: (r) => <Pill tone="warning">{r.actual}</Pill> },
    { key: 'cost', label: '광고비 · 14일', align: 'right', sort: (r) => r.cost14, render: (r) => fmt.krw(r.cost14) },
    { key: 'rev', label: '매출 · 14일', align: 'right', sort: (r) => r.revenue14, render: (r) => fmt.krw(r.revenue14) },
  ];
  const c = f.cannibal;

  return (
    <div className="stack-lg">
      <div className="grid g-2">
        <ChannelCard c={f.brandstore} days={days} />
        <ChannelCard c={f.ownMall} days={days} />
      </div>

      <Card title={<>단계별 진단 → 액션 <Src kind="PROPOSAL" page="p.41" /><Src kind="DEMO" /></>}
        sub={`단계별 이탈 지점을 찾아 광고 운영으로 바꿀 수 있는 부분부터 개선 · 판정 기준(초기값): 채널 간 ${FUNNEL_RULES.gapPct}% 이하 또는 직전 ${days}일 대비 ${FUNNEL_RULES.trendPct}% 이하 → 개선 우선`}>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>단계</th><th>진단 (p.41)</th><th className="r">브랜드스토어</th><th className="r">자사몰</th><th className="r">자사몰 격차</th><th>판정 · 근거</th><th>브랜드스토어 액션</th><th>자사몰 액션</th>
              </tr>
            </thead>
            <tbody>
              {f.stages.map((s) => (
                <tr key={s.stage} className={f.priority?.stage === s.stage ? 'selected' : undefined}>
                  <td><strong>{s.label}</strong><div className="xs muted">{s.metricLabel}</div></td>
                  <td className="small">{s.diag}{s.stage === 'visit' ? <div className="xs muted">키워드별 유입 연동 전 채널 단위 도달률 · 키워드는 랜딩 점검으로 확인</div> : null}{s.stage === 'detail' ? <div className="xs muted">체류 · 리뷰 조회 연동 전 담기율로 대체</div> : null}{s.stage === 'order' ? <div className="xs muted">결제 시작 이벤트 연동 전 방문 대비 구매</div> : null}</td>
                  <td className="r">{fmt.pct(s.bs.cur)}<div className="xs"><Delta pct={s.bs.trendPct} /></div></td>
                  <td className="r">{fmt.pct(s.om.cur)}<div className="xs"><Delta pct={s.om.trendPct} /></div></td>
                  <td className="r"><strong className={Number.isFinite(s.gapPct) && s.gapPct <= FUNNEL_RULES.gapPct ? 'delta-down' : undefined}>{fmt.delta(s.gapPct)}</strong></td>
                  <td style={{ maxWidth: 320 }}>
                    <span className="stack-sm" style={{ gap: 2 }}>
                      <Verdict tone={s.focus ? (f.priority?.stage === s.stage ? 'serious' : 'warning') : 'neutral'}
                        label={s.focus ? `${f.priority?.stage === s.stage ? '우선 개선' : '개선 필요'} · ${s.focus === 'own_mall' ? '자사몰' : '브랜드스토어'}` : '기준 내'}
                        basis={s.focus ? undefined : `채널 격차 ${fmt.delta(s.gapPct)} (기준 ${FUNNEL_RULES.gapPct}%) · 추세 ${fmt.delta(s.bs.trendPct)} / ${fmt.delta(s.om.trendPct)} (기준 ${FUNNEL_RULES.trendPct}%)`} />
                      {s.reasons.map((r) => <span key={r} className="xs muted">{r}</span>)}
                    </span>
                  </td>
                  <td className={`small${s.focus === 'brandstore' ? ' bold' : ''}`}>{s.bsAction}</td>
                  <td className={`small${s.focus === 'own_mall' ? ' bold' : ''}`}>{s.omAction}<div className="xs muted">{s.omNote}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {f.priority && f.upside.stage ? (
          <Callout tone="accent" icon="target" title={`개선 시나리오 · ${f.priority.label}`}>
            {f.upside.basis} → 14일 추가 주문 {fmt.dec1(f.upside.addOrders)}건 · 매출 {fmt.krw(f.upside.addRevenue14)} · 월 환산 {fmt.krw(f.upside.addRevenueMonthly)}. 광고비 증액 없이 같은 유입에서 나오는 차이로, CAC를 낮추는 경로입니다. 시나리오이며 원인(결제 수단 · 배송 안내 · 혜택 차이)은 데이터로 구분되지 않습니다.
          </Callout>
        ) : null}
      </Card>

      <div className="grid g-2">
        <Card title={<>유입 키워드 → 랜딩 점검 <Src kind="DEMO" /></>} sub="p.35 캠페인별 랜딩 구조와 실제 랜딩 대조 · 품절 옵션 랜딩 · 의도별 랜딩 분리 대상"
          actions={<a className="btn sm" href="#adpilot">AD Pilot에서 보기</a>}>
          <div className="grid g-2">
            <Stat label="의도-랜딩 불일치" value={`${f.landing.mismatches.length}개`} foot={<span className="xs muted">SA 광고비의 {fmt.ratio(f.landing.mismatchCostShare)}</span>} />
            <Stat label="품절 옵션 랜딩" value={`${f.landing.soldout.length}건`} foot={<span className="xs muted">{f.landing.soldout.map((s) => `${s.keyword} · ${s.option}`).join(', ') || '없음'}</span>} />
          </div>
          <DataTable rows={f.landing.mismatches} columns={misCols} rowKey={(r) => r.keyword} empty="의도-랜딩 불일치 없음" maxHeight={260} />
          {f.landing.soldout.length ? (
            <Callout tone="critical" title="품절 옵션 랜딩">
              {f.landing.soldout.map((s) => `'${s.keyword}' → ${s.product} ${s.option} 옵션 품절 (광고비 14일 ${fmt.krw(s.cost14)})`).join(' · ')}. 구매할 수 없는 옵션 페이지로 광고비가 나갑니다 — MILDO Alert 품절 랜딩 이슈 · 그룹 일시 중지 제안 대상.
            </Callout>
          ) : null}
        </Card>

        <Card title={<>합산 매출 · 채널 간 잠식 모니터링 <Src kind="DEMO" /></>} sub={`브랜드스토어 + 자사몰 합산 매출 기준 판단 (p.41) · 최근 ${days}일 vs 직전 ${days}일`}>
          <div className="grid g-3">
            <Stat label="합산 매출" value={fmt.krw(c.combined.cur)} delta={c.combined.deltaPct} />
            <Stat label="자사몰 비중" value={fmt.ratio(c.omShare.cur)} foot={<span className="xs muted">직전 {fmt.ratio(c.omShare.prev)}</span>} />
            <Stat label="일 매출 변화 상관" value={Number.isFinite(c.dailyCorr) ? c.dailyCorr.toFixed(2) : '—'} foot={<span className="xs muted">+ 동반 · − 상쇄</span>} />
          </div>
          <Verdict tone={c.flag === 'suspect' ? 'serious' : c.flag === 'none' ? 'good' : 'neutral'} label={c.flag === 'suspect' ? '잠식 의심' : c.flag === 'none' ? '잠식 신호 없음' : '판단 불가'} basis={c.basis} />
          <LineChart series={trend} height={200} yFormat={(v) => fmt.krw(v)} xFormat={(x) => fmtDate(x, false)} ariaLabel="브랜드스토어 · 자사몰 일 매출과 합산" />
          <Kv k="브랜드스토어" v={<>{fmt.krw(c.bs.cur)} <Delta pct={c.bs.deltaPct} /></>} />
          <Kv k="자사몰" v={<>{fmt.krw(c.om.cur)} <Delta pct={c.om.deltaPct} /></>} />
          {c.benefitGap ? <Callout tone="info" title="채널 간 혜택 차이">{c.benefitGap} — 자사몰 전용 혜택 랜딩을 열 때는 브랜드스토어 구매 이동(잠식)을 합산 매출로 함께 봅니다.</Callout> : null}
        </Card>
      </div>

      <AiInsight title="전환 개선 해석" sub="광고 운영으로 바꿀 수 있는 부분부터 · 합산 매출 기준" buildPrompt={() => growthPrompt('funnel', d)} fallback={() => funnelBrief(d)} />
    </div>
  );
}
