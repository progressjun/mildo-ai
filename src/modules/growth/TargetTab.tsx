/* 구매 의도별 타겟 그룹(p.34) · RFP 세그먼트 · 네이버 SA 5개 캠페인 구조와 성과(p.35) · 제한된 SKU 확장(p.36) */
import type { Dataset } from '@/core/types';
import { AD_PILOT, SA_CAMPAIGNS, SKU_EXPANSION } from '@/data/constants';
import { fmt } from '@/core/util';
import { Callout, Card, DataTable, Pill, Src, Stat, type Column, type Tone } from '@/ui/primitives';
import { HBarChart, ShareBar } from '@/ui/charts';
import { AiInsight } from '@/ui/AiInsight';
import { CAMPAIGN_VERDICT_LABEL, growthPrompt, rfpSegmentSummary, saCampaignPerformance, skuExpansionSummary, targetGroupView, type CampaignPerf, type CampaignVerdict } from './engine';
import { campaignBrief } from './briefs';
import { TARGET_PRINCIPLE } from './data';
import { INTENT_COLOR, Kv, Verdict, metricText } from './parts';

const VERDICT_TONE: Record<CampaignVerdict, Tone> = { expand: 'good', keep: 'neutral', check: 'warning', nodata: 'outline' };
const BASIS_TONE: Record<string, Tone> = { 'RFP 데이터': 'dark', '테스트 가설': 'warning', '동의 데이터': 'accent' };

export function TargetTab({ d }: { d: Dataset }) {
  const groups = targetGroupView(d);
  const seg = rfpSegmentSummary();
  const camps = saCampaignPerformance(d);
  const sku = skuExpansionSummary();

  const cols: Column<CampaignPerf>[] = [
    {
      key: 'name', label: '캠페인', sort: (r) => r.name,
      render: (r) => (
        <span className="stack-sm" style={{ gap: 0 }}>
          <strong>{r.name}</strong>
          <span className="xs muted">예시 {SA_CAMPAIGNS[r.intent].keywords.join(' · ')}</span>
          <span className="xs muted">운영 키워드 {r.keywords}개{r.testKeywords ? ` · 테스트 ${r.testKeywords}개` : ''}</span>
        </span>
      ),
    },
    { key: 'message', label: '메시지 예시', render: (r) => <span className="small">“{r.message}”</span> },
    {
      key: 'landing', label: '랜딩 (p.35)',
      render: (r) => (
        <span className="stack-sm" style={{ gap: 2 }}>
          <span className="small">{r.landing}</span>
          {r.landingMismatch ? <Pill tone="warning" icon="alert">불일치 {r.landingMismatch}개 · 실제 {r.actualLandings.join(' · ')}</Pill> : r.keywords ? <Pill tone="good" icon="check">일치</Pill> : null}
        </span>
      ),
    },
    { key: 'metric', label: '지표', render: (r) => <span className="small">{r.metric}</span> },
    { key: 'roas', label: 'ROAS', align: 'right', sort: (r) => r.roas, render: (r) => <strong>{fmt.roas(r.roas)}</strong> },
    {
      key: 'verdict', label: '판정 · 기준', sort: (r) => r.ratioPct,
      render: (r) => <Verdict tone={VERDICT_TONE[r.verdict]} label={CAMPAIGN_VERDICT_LABEL[r.verdict]} basis={r.basis} />,
    },
    { key: 'cvr', label: 'CVR', align: 'right', sort: (r) => r.cvr, render: (r) => fmt.pct(r.cvr, 2) },
    { key: 'cpa', label: 'CPA', align: 'right', sort: (r) => r.cpa, render: (r) => fmt.won(r.cpa) },
    { key: 'share', label: '매출 비중', align: 'right', sort: (r) => r.revenueShare, render: (r) => fmt.ratio(r.revenueShare) },
    { key: 'lost', label: '노출 손실', align: 'right', sort: (r) => r.lostShare, render: (r) => fmt.ratio(r.lostShare, 0) },
    {
      key: 'star', label: '확대 여지 키워드', sort: (r) => r.expandKeywords.length,
      render: (r) => r.expandKeywords.length
        ? <span className="stack-sm" style={{ gap: 2 }}>{r.expandKeywords.slice(0, 3).map((k) => <span key={k.keyword} className="xs"><strong>{k.keyword}</strong> <span className="muted">목표 대비 {fmt.int(k.ratioPct)}% · 손실 {fmt.ratio(k.lostShare, 0)}</span></span>)}{r.expandKeywords.length > 3 ? <span className="xs muted">외 {r.expandKeywords.length - 3}개</span> : null}</span>
        : <span className="xs muted">없음</span>,
    },
    { key: 'search', label: '월 검색량', align: 'right', sort: (r) => r.monthlySearch, render: (r) => fmt.int(r.monthlySearch) },
  ];

  return (
    <div className="stack-lg">
      <Card title={<>구매 의도별 타겟 그룹 <Src kind="PROPOSAL" page="p.34" /><Src kind="DEMO" /></>} sub="실제 구매층(RFP)에서 출발해 매트리스를 찾는 이유로 타겟을 나누고, 각 그룹을 운영 단위(SA 의도 캠페인 · DA 캠페인)에 연결">
        <Callout tone="accent" icon="shield" title="타겟 원칙">{TARGET_PRINCIPLE}.</Callout>
        <div className="grid g-5">
          {groups.map((g) => (
            <div key={g.id} className="growth-group">
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <span className="growth-group-id">{g.id}</span>
                <strong>{g.name}</strong>
              </div>
              <div className="xs muted">{g.desc}</div>
              <div className="row" style={{ gap: 4 }}>
                <Pill tone={BASIS_TONE[g.basis] ?? 'neutral'}>{g.basis}</Pill>
                <span className="xs muted">판단 {g.metric}</span>
              </div>
              <div className="row" style={{ gap: 4 }}>{g.campaigns.map((c) => <span key={c} className="growth-chip">{c}</span>)}</div>
              <div className="stack-sm" style={{ gap: 2 }}>
                {g.metrics.map((m) => <Kv key={m.label} k={m.label} v={metricText(m)} />)}
              </div>
              <div className="xs muted">{g.dataNote}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid g-3">
        <Card className="span-2" title={<>네이버 결제 상위 세그먼트 <Src kind="RFP" /></>} sub="RFP 제공 · 네이버 결제수 기준">
          <div className="grid g-2">
            <Stat label="상위 4개 세그먼트 합계" value={fmt.ratio(seg.top4Share, 0)} foot={<span className="xs muted">{fmt.ratio(seg.top4Share)} · A 핵심 구매층 기준</span>} />
            <Stat label="그중 여성 31~50세" value={fmt.ratio(seg.female3150Share, 0)} foot={<span className="xs muted">여성 41~50세 + 31~40세</span>} />
          </div>
          <HBarChart
            data={seg.segments.map((s) => ({ label: s.label, value: s.share * 100, colorVar: s.id.startsWith('f') ? '--series-5' : '--series-1' }))}
            format={(v) => `${v.toFixed(1)}%`} max={25}
          />
        </Card>
        <Card title={<>SA 캠페인 매출 구성 <Src kind="DEMO" /></>} sub="최근 14일 · 의도별 키워드 매출 합계">
          <ShareBar parts={camps.map((c) => ({ label: c.name, value: Math.max(0, c.revenue), colorVar: INTENT_COLOR[c.intent] }))} />
          <div className="stack-sm" style={{ gap: 2 }}>
            {camps.map((c) => <Kv key={c.intent} k={c.name} v={`${fmt.krw(c.revenue)} · 광고비 ${fmt.krw(c.cost)}`} />)}
          </div>
        </Card>
      </div>

      <Card
        title={<>네이버 SA 캠페인 · 메시지 구조 <Src kind="PROPOSAL" page="p.35" /><Src kind="DEMO" /></>}
        sub={`구매 의도별 5개 캠페인마다 키워드 · 메시지 · 랜딩 · 지표를 따로 설계 · 성과는 최근 14일 키워드 의도 집계 · 확대 여지 키워드 기준: 목표 ROAS(브랜드 ${AD_PILOT.brandTargetRoas}%, 그 외 ${AD_PILOT.targetRoas}%) 대비 ${AD_PILOT.highEfficiencyRoasRatio * 100}% 이상 + 노출 손실 ${AD_PILOT.lostShareTrigger * 100}% 이상(p.14, AD Pilot 입찰 상향 후보와 같은 기준) · AD Pilot이 캠페인별 입찰을, MILDO Board가 캠페인별 실매출을 추적 · 의료 효능 암시 표현 제외`}>
        <DataTable rows={camps} columns={cols} rowKey={(r) => r.intent} />
      </Card>

      <Card title={<>제한된 SKU 확장 전략 <Src kind="PROPOSAL" page="p.36" /></>} sub="제품 수가 아니라, 고객이 매트리스를 검색하는 이유의 수만큼 키워드와 랜딩을 늘립니다"
        actions={<a className="btn sm" href="#lab">MILDO Lab에서 진입점 생성 · 테스트</a>}>
        <div className="growth-sku">
          <div className="stack-sm"><strong className="small">고객의 문제 {sku.problems}</strong><ul>{SKU_EXPANSION.problems.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div className="stack-sm"><strong className="small">구매 상황 {sku.situations}</strong><ul>{SKU_EXPANSION.situations.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div className="stack-sm"><strong className="small">비교 기준 {sku.criteria}</strong><ul>{SKU_EXPANSION.criteria.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
            <span className="xs muted">제품 {sku.products} × 문제 {sku.problems} × 상황 {sku.situations} × 비교 {sku.criteria}</span>
            <span className="growth-big">{sku.total}</span>
            <span className="small">검색 진입점</span>
          </div>
        </div>
        <div className="xs muted">조합 예: {sku.examples.join(' / ')}</div>
      </Card>

      <AiInsight title="타겟 · 캠페인 구조 해석" sub="볼륨 한계 · 노출 손실 · 랜딩 구조 기준" buildPrompt={() => growthPrompt('target', d)} fallback={() => campaignBrief(d)} />
    </div>
  );
}
