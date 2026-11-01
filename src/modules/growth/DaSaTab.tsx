/* DA → SA 전환 기여 분석 (p.40) — METHOD 1 시계열 리프트 · METHOD 2 홀드아웃 설계 · METHOD 3 대표 키워드 기여 */
import { useMemo, useState } from 'react';
import type { Dataset } from '@/core/types';
import { SA_CAMPAIGNS } from '@/data/constants';
import { fmt, fmtDate, mean } from '@/core/util';
import { useActions, useStore } from '@/core/store';
import { Button, Callout, Card, DataTable, Empty, Field, Pill, Segmented, Src, Stat, type Column } from '@/ui/primitives';
import { LineChart } from '@/ui/charts';
import { AiInsight } from '@/ui/AiInsight';
import { DA_SA_METHODS, DA_SA_PATH, HOLDOUT_UNITS, type HoldoutUnitId } from './data';
import { activeDuplicate, f2, growthPrompt, holdoutChange, holdoutDesign, type DaSaResult, type LagRow, type Method3Row } from './engine';
import { daSaBrief } from './briefs';
import { Kv, NumField as NumberInput, Verdict } from './parts';

export function DaSaTab({ d, ds, onApplyCredit }: { d: Dataset; ds: DaSaResult; onApplyCredit: () => void }) {
  const { state } = useStore();
  const { addChange, toast } = useActions();
  const [unit, setUnit] = useState<HoldoutUnitId>('region');
  const [metric, setMetric] = useState<'brand_search' | 'sa_brand_conv'>('brand_search');
  const [mde, setMde] = useState(10);
  const [alphaPct, setAlphaPct] = useState(5);
  const [powerPct, setPowerPct] = useState(80);
  const unitDef = HOLDOUT_UNITS.find((u) => u.id === unit) ?? HOLDOUT_UNITS[0];
  const [shareByUnit, setShareByUnit] = useState<Record<string, number>>(() => Object.fromEntries(HOLDOUT_UNITS.map((u) => [u.id, Math.round(u.holdoutShare * 100)])));
  const h = useMemo(() => holdoutDesign(d, { unit, metric, mdePct: mde, alpha: alphaPct / 100, power: powerPct / 100, holdoutShare: (shareByUnit[unit] ?? 30) / 100 }), [d, unit, metric, mde, alphaPct, powerPct, shareByUnit]);

  const regionDefault = useMemo(() => holdoutDesign(d, { unit: 'region', metric: 'brand_search', mdePct: 10 }), [d]);
  const idxDays = 56;
  const idx = useMemo(() => {
    const n = ds.dates.length;
    const from = Math.max(0, n - idxDays);
    const g = ds.gfaCost.slice(from);
    const b = ds.brandSearch.slice(from);
    const mg = mean(g);
    const mb = mean(b);
    const xs = ds.dates.slice(from);
    return [
      { id: 'gfa', label: 'GFA 광고비 지수', colorVar: '--series-2', points: xs.map((x, i) => ({ x, y: mg > 0 ? (g[i] / mg) * 100 : NaN })) },
      { id: 'bs', label: '브랜드 검색량 지수', colorVar: '--series-7', points: xs.map((x, i) => ({ x, y: mb > 0 ? (b[i] / mb) * 100 : NaN })) },
    ];
  }, [ds]);
  const lagSeries = [
    { id: 'adj', label: '브랜드 검색 (보정)', colorVar: '--series-7', points: ds.lags.map((l) => ({ x: `${l.lag}일`, y: l.adjusted })) },
    { id: 'raw', label: '브랜드 검색 (원계열)', colorVar: '--series-7', dashed: true, points: ds.lags.map((l) => ({ x: `${l.lag}일`, y: l.raw })) },
    { id: 'sa', label: 'SA 전환 (보정)', colorVar: '--series-1', points: ds.lags.map((l) => ({ x: `${l.lag}일`, y: l.saAdjusted })) },
  ];

  const lagCols: Column<LagRow>[] = [
    { key: 'lag', label: '시차', render: (r) => <strong>{r.lag}일{r.lag === ds.bestLag ? ' · 최적' : ''}</strong> },
    { key: 'raw', label: '원계열 r', align: 'right', render: (r) => f2(r.raw) },
    { key: 'adj', label: '보정 r · 브랜드 검색', align: 'right', render: (r) => <strong>{f2(r.adjusted)}</strong> },
    { key: 'sig', label: '판정', render: (r) => <Verdict tone={r.significant ? 'good' : 'neutral'} label={r.significant ? '유의' : '미달'} basis={`기준 r > ${f2(ds.threshold)}`} /> },
    { key: 'sa', label: '보정 r · SA 전환', align: 'right', render: (r) => f2(r.saAdjusted) },
    { key: 'sasig', label: 'SA 판정', render: (r) => <Verdict tone={r.saSignificant ? 'good' : 'neutral'} label={r.saSignificant ? '유의' : '미달'} basis={`|r| > ${f2(ds.threshold)}`} /> },
    { key: 'n', label: '표본', align: 'right', render: (r) => fmt.int(r.n) },
  ];
  const m3Cols: Column<Method3Row>[] = [
    // 반쪽 카드 폭에서 마지막 열(DA 경유 매출)이 가로 스크롤 뒤로 숨지 않도록 캠페인은 키워드 아래 줄로
    { key: 'kw', label: '대표 키워드 · 캠페인', render: (r) => <span className="stack-sm" style={{ gap: 0 }}><strong className="nowrap">{r.keyword}</strong><span className="xs muted nowrap">{SA_CAMPAIGNS[r.intent].name}</span></span> },
    { key: 'rev', label: 'SA 매출 · 14일', align: 'right', sort: (r) => r.revenue14, render: (r) => fmt.krw(r.revenue14) },
    { key: 'share', label: 'DA 경유 비중', align: 'right', sort: (r) => r.share, render: (r) => fmt.ratio(r.share) },
    { key: 'basis', label: '근거', render: (r) => <Pill tone={r.shareBasis === 'METHOD 1 추정' ? 'accent' : 'warning'}>{r.shareBasis}</Pill> },
    { key: 'da', label: 'DA 경유 매출', align: 'right', sort: (r) => r.daRevenue, render: (r) => <strong>{fmt.krw(r.daRevenue)}</strong> },
  ];

  const holdoutPayload = holdoutChange(h, mde, state.role);
  const holdoutDup = activeDuplicate(state.changes, holdoutPayload.targetId);
  const requestHoldout = () => {
    if (holdoutDup || !h.valid) return;
    const c = addChange({ ...holdoutPayload });
    toast({ tone: 'info', title: '홀드아웃 테스트 승인 요청을 만들었습니다', body: `${c.target} · 수면밀도 승인 대기`, route: 'flow' });
  };

  if (!ds.valid) {
    return <Card title="DA → SA 전환 기여"><Empty title="시차 분석에 필요한 데이터가 부족합니다">GFA 광고비와 브랜드 검색량이 함께 있는 날이 20일 이상 필요합니다 (현재 {ds.n}일).</Empty></Card>;
  }

  return (
    <div className="stack-lg">
      <Card tone="dark" title={<>DA → SA 전환 기여 분석 <Src kind="PROPOSAL" page="p.40" /></>} sub="DA가 만든 검색 수요가 SA 매출로 이어지는 경로를 세 가지 방법으로 측정합니다">
        <div className="growth-path">
          {DA_SA_PATH.map((p, i) => (
            <span key={p} className="row" style={{ gap: 8 }}>
              {i ? <span className="growth-path-arrow">→</span> : null}
              <span className="growth-path-node">{p}</span>
            </span>
          ))}
        </div>
        <div className="growth-methods">
          {DA_SA_METHODS.map((m) => (
            <div key={m.id} className="growth-method">
              <span className="growth-method-name">{m.name} · {m.title}</span>
              <span className="xs muted">{m.detail}</span>
              <span className="growth-method-result">
                {m.id === 'm1' ? (ds.bestLag !== null ? `최적 시차 ${ds.bestLag}일 · r ${f2(ds.bestR)} · 브랜드 검색의 ${fmt.ratio(ds.daShareBrand, 0)} DA 경유 추정` : '유의한 시차 동행 없음')
                  : m.id === 'm2' ? `지역 홀드아웃 · 권장 ${fmt.int(regionDefault.recommendedDays)}일 (그룹당 필요 ${fmt.int(regionDefault.requiredDays)}일 · 최소 검출 효과 10%)`
                    : `SA 매출 중 DA 경유 ${fmt.ratio(ds.method3.daShareOfSa)} · SA 경유 ROAS ${fmt.roas(ds.halo.haloRoas)}`}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={<>METHOD 1 · 시계열 리프트 <Src kind="DEMO" /></>} sub={`GFA 광고비 vs 브랜드 검색량 · SA 전환, 시차 0~7일 · 보정 = 동요일 ±1주 평균 대비 비율 (요일 · 시즌 공통 요인 제거) · 유의 기준은 시차 8개 다중 비교 보정 · 표본 ${ds.n}일`}>
        <div className="grid g-4">
          <Stat label="최적 시차 (보정)" value={ds.bestLag !== null ? `${ds.bestLag}일` : '없음'} foot={<Verdict tone={ds.bestLag !== null ? 'good' : 'neutral'} label={ds.bestLag !== null ? '유의' : '미달'} basis={`r ${f2(ds.bestR)} · 기준 r > ${f2(ds.threshold)}`} />} />
          <Stat label="원계열 최고 시차" value={ds.rawBestLag !== null ? `${ds.rawBestLag}일` : '—'} foot={<span className="xs muted">r {f2(ds.lags.find((l) => l.lag === ds.rawBestLag)?.raw ?? NaN)} · 요일 동행 포함 (과대)</span>} />
          <Stat label="광고비 100만원당 브랜드 검색" value={`${fmt.int(ds.dl.cumulativePerMillion)}회`} foot={<span className="xs muted">분산 시차 회귀 · 시차 {ds.dl.lagsUsed.join(' · ') || '—'}일 계수 합 (t ≥ 2)</span>} />
          <Stat label="브랜드 검색 중 DA 경유 (추정)" value={fmt.ratio(ds.daShareBrand, 0)} foot={<span className="xs muted">누적 계수 × GFA 일 평균 {fmt.krw(ds.avgGfaDaily)} ÷ 검색 일 평균 {fmt.int(ds.avgBrandSearch)}</span>} />
        </div>
        <div className="grid g-2 growth-chart-pair">
          <div className="stack-sm">
            <strong className="small">최근 {Math.min(idxDays, ds.dates.length)}일 지수 (기간 평균 = 100)</strong>
            <LineChart series={idx} height={210} yFormat={(v) => `${Math.round(v)}`} xFormat={(x) => fmtDate(x, false)} zeroBased={false} ariaLabel="GFA 광고비와 브랜드 검색량 지수" />
          </div>
          <div className="stack-sm">
            <strong className="small">시차별 상관 r (점선 기준 = 유의 임계)</strong>
            <LineChart series={lagSeries} height={210} yFormat={(v) => v.toFixed(1)} refLine={Number.isFinite(ds.threshold) ? { y: ds.threshold, label: `기준 ${f2(ds.threshold)}` } : undefined} ariaLabel="시차별 상관" />
          </div>
        </div>
        <div className="grid g-3">
          <div className="span-2"><DataTable rows={ds.lags} columns={lagCols} rowKey={(r) => String(r.lag)} /></div>
          <div className="stack-sm">
            <strong className="small">분산 시차 회귀 (시차 0~3 동시 투입)</strong>
            {ds.dl.coefs.map((c) => <Kv key={c.lag} k={`시차 ${c.lag}일`} v={`${fmt.int(c.perMillion)}회 · t ${f2(c.t)}${c.lag === 0 ? ' · 누적 제외' : ''}`} />)}
            <Kv k="R²" v={f2(ds.dl.r2)} />
            <div className="xs muted">시차 0일 계수는 같은 날 기획전 · 수요 변화가 GFA 증액과 겹친 효과가 섞일 수 있어 누적 효과에서 뺍니다 (보수적 추정).</div>
          </div>
        </div>
        <Callout tone={ds.saLink.significant ? 'good' : 'warning'} title={ds.saLink.significant ? 'SA 전환도 시차 동행' : 'SA 전환 동행은 유의 기준 미달'}>
          {ds.saLink.significant
            ? `GFA 광고비와 SA 전환의 보정 상관이 시차 ${ds.saLink.lag}일에서 유의 기준을 넘습니다. 브랜드 검색 증가가 전환으로 이어지는 경로가 시계열로도 관측됩니다.`
            : `SA 전체 전환과의 보정 상관은 최대 |r| ${f2(ds.saLink.maxAbsR)}로 기준 ${f2(ds.threshold)}에 미달합니다. 브랜드 검색 증가가 SA 구매로 이어지는지는 시계열로 확인되지 않아 METHOD 2 홀드아웃으로 검증합니다. SA 브랜드 키워드 전환은 최근 14일 일별만 있어 시계열은 SA 전체 전환으로 보고, 브랜드 키워드 일별 이력은 데이터 연동 후 분리합니다.`}
        </Callout>
      </Card>

      <div className="grid g-2">
        <Card title={<>METHOD 2 · 홀드아웃 테스트 설계 <Src kind="DEMO" /></>} sub="기간 · 지역 · 타겟 단위로 DA를 끈 그룹과 비교해 순증 효과 측정 · 필요 기간 = (z₁₋α/₂ + z₁₋β)² × 분산 ÷ 최소 검출 효과²">
          <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
            <Field label="홀드아웃 단위"><Segmented label="단위" value={unit} onChange={setUnit} options={HOLDOUT_UNITS.map((u) => ({ id: u.id, label: u.label }))} /></Field>
            <Field label="측정 지표"><Segmented label="지표" value={metric} onChange={setMetric} options={[{ id: 'brand_search', label: '브랜드 검색량' }, { id: 'sa_brand_conv', label: 'SA 브랜드 전환' }]} /></Field>
          </div>
          <div className="grid g-4">
            <Field label="최소 검출 효과" id="growth-mde"><NumberInput id="growth-mde" value={mde} step={1} min={1} max={80} suffix="%" onChange={(v) => setMde(Math.max(1, Math.min(80, v)))} /></Field>
            <Field label="홀드아웃 비중" id="growth-hshare" hint={unit === 'period' ? '기간 단위는 ON/OFF 각 50%' : undefined}>
              <NumberInput id="growth-hshare" value={shareByUnit[unit]} step={5} min={5} max={95} suffix="%" onChange={(v) => setShareByUnit({ ...shareByUnit, [unit]: Math.max(5, Math.min(95, v)) })} />
            </Field>
            <Field label="유의수준 (양측)" id="growth-alpha"><NumberInput id="growth-alpha" value={alphaPct} step={1} min={1} max={20} suffix="%" onChange={(v) => setAlphaPct(Math.max(1, Math.min(20, v)))} /></Field>
            <Field label="검정력" id="growth-power"><NumberInput id="growth-power" value={powerPct} step={5} min={50} max={99} suffix="%" onChange={(v) => setPowerPct(Math.max(50, Math.min(99, v)))} /></Field>
          </div>
          <div className="xs muted">{unitDef.desc} · 측정: {unitDef.measure}</div>
          {h.valid ? (
            <>
              <div className="grid g-3">
                <Stat label={unit === 'period' ? 'ON · OFF 구간별 필요 일수' : '그룹당 필요 일수'} value={`${fmt.int(h.requiredDays)}일`} foot={<span className="xs muted">최근 28일 일 평균 {fmt.dec1(h.mu)} · 잔차 변동 ±{fmt.ratio(h.cv, 1)}</span>} />
                <Stat label="권장 테스트 기간" value={`${fmt.int(h.recommendedDays)}일`} foot={<span className="xs muted">최소 {unitDef.minDays}일 · 주 단위 올림</span>} />
                <Stat label="28일 테스트 시 검출 가능 효과" value={fmt.pct(h.mdeAtDays)} foot={<span className="xs muted">이보다 작은 효과는 구분 불가</span>} />
              </div>
              <Verdict tone={h.detectable ? 'good' : 'warning'} label={h.detectable ? '검출 가능' : '검출 어려움'}
                basis={`METHOD 1 추정 효과 ${fmt.pct(h.expectedEffectPct, 0)} vs 최소 검출 효과 ${fmt.int(mde)}% · ${metric === 'sa_brand_conv' ? '검색 감소분이 같은 비율로 전환에 이어진다는 가정' : '브랜드 검색 기준'}`} />
              <div className="grid g-2">
                <Kv k="홀드아웃 그룹 미집행 광고비" v={fmt.krw(h.unspentSpend)} />
                <Kv k="예상 매출 영향 (직접 + SA 경유 추정)" v={fmt.krw(h.revenueAtRisk)} />
              </div>
              <div className="row-between">
                <span className="xs muted">{h.note}</span>
                {holdoutDup
                  ? <span className="xs muted">같은 단위 · 지표의 홀드아웃 요청이 승인 흐름에 있습니다 · <a href="#flow">MILDO Flow</a></span>
                  : <Button size="sm" variant="primary" icon="send" onClick={requestHoldout}>홀드아웃 승인 요청 · 수면밀도</Button>}
              </div>
            </>
          ) : <Callout tone="warning">{h.note}</Callout>}
        </Card>

        <Card title={<>METHOD 3 · 대표 키워드 기여 <Src kind="DEMO" /></>} sub="대표 키워드별 SA 매출 중 DA 경유 비중 → 키워드 단위 기여 리포트 · 브랜드 키워드는 METHOD 1 추정, 비브랜드는 데모 가정">
          <div className="growth-half-table"><DataTable rows={ds.method3.rows} columns={m3Cols} rowKey={(r) => r.keyword} initialSort={{ key: 'da', dir: 'desc' }} maxHeight={320} /></div>
          <div className="grid g-2">
            <Stat label="SA 키워드 매출 중 DA 경유" value={fmt.ratio(ds.method3.daShareOfSa)} foot={<span className="xs muted">{fmt.krw(ds.method3.daRevenue)} / {fmt.krw(ds.method3.totalRevenue)} · 14일</span>} />
            <Stat label="GFA 광고비 대비 SA 경유 매출" value={fmt.roas(ds.halo.haloRoas)} foot={<span className="xs muted">GFA 일 {fmt.krw(ds.halo.gfaDaily)} · SA 경유 일 {fmt.krw(ds.halo.haloDaily)}</span>} />
          </div>
          <Callout tone="warning" title="상한 성격의 추정">
            증가한 브랜드 검색이 SA 광고가 아닌 오가닉 결과 · 다른 판매 채널 구매로 이어지는 비율은 반영하지 않았습니다. 비브랜드 키워드 비중은 데모 가정이며, 실측은 네이버 브랜드 검색 · 경로 데이터 연동 후 산정합니다.
          </Callout>
          <div className="row-between">
            <span className="xs muted">이 값을 재배분 시뮬레이터의 'DA→SA 기여 반영' 시나리오에 사용합니다</span>
            <Button size="sm" icon="trend" onClick={onApplyCredit}>기여 반영 재배분 보기</Button>
          </div>
        </Card>
      </div>

      <AiInsight title="DA → SA 기여 해석" sub="보정 전후 차이 · 재배분 전 필요한 검증" buildPrompt={() => growthPrompt('dasa', d)} fallback={() => daSaBrief(d)} />
    </div>
  );
}
