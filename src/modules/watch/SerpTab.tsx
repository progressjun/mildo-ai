/* 브랜드 키워드 검색 결과 지면 점검 — 경쟁사 침투 여부 (스냅샷 DEMO + 자사 순위 TEST DATA) */
import { fmt } from '@/core/util';
import { Callout, Card, Pill, Src, Stat } from '@/ui/primitives';
import { SERP_VERDICT_META, type SerpCheck } from './engine';
import type { WatchCtx } from './hooks';

export function SerpTab({ w }: { w: WatchCtx }) {
  const above = w.serp.filter((s) => s.verdict === 'above');
  const intr = w.serp.filter((s) => s.verdict === 'above' || s.verdict === 'below');
  const avgRank = w.serp.length ? w.serp.reduce((a, s) => a + s.avgRank, 0) / w.serp.length : NaN;
  const avgLost = w.serp.length ? w.serp.reduce((a, s) => a + s.lost, 0) / w.serp.length : NaN;
  const sig = w.events.find((e) => e.signal?.rule === 'brand_serp');
  return (
    <div className="stack-lg">
      <div className="grid g-4">
        <Card><Stat label="경쟁사 광고가 자사보다 위" src={<Src kind="DEMO" />} value={`${above.length} / ${w.serp.length}`} foot={<span>침투(상위 · 하위 포함) {intr.length}개 · 기준 경쟁사 광고 1개 이상 (p.45)</span>} /></Card>
        <Card><Stat label="브랜드 키워드 평균 순위" src={<Src kind="DEMO" />} value={`${fmt.dec1(avgRank)}위`} foot={<span>방어 기준 1위 · 신호 기준 {w.cfg.brandRankMax.toFixed(1)}위 이상</span>} /></Card>
        <Card><Stat label="노출 기회 손실 평균" src={<Src kind="DEMO" />} value={fmt.ratio(avgLost, 0)} foot={<span>신호 기준 {Math.round(w.cfg.brandLostMin * 100)}% 이상</span>} /></Card>
        <Card><Stat label="방어 판단 기준" src={<Src kind="PROPOSAL" page="p.14" />} value={`ROAS ${w.cfg.brandTargetRoas}%`} foot={<span>브랜드 키워드 별도 기준 · 순위 방어 우선 (AD Pilot)</span>} /></Card>
      </div>

      <Callout tone="info" icon="search" title="점검 방식">
        매일 07:00 브랜드 키워드 검색 결과를 스냅샷으로 남기고(시연용 가상 스냅샷), 자사 광고 위치는 키워드 평균 순위 데이터로 배치합니다. 경쟁사 광고가 1개 이상 보이면 침투로 판정하고, 자사보다 위면 방어 입찰 검토를 AD Pilot 조정 후보로 넘깁니다.
        {sig ? <> 데이터 감지 신호: <strong>{sig.title}</strong> (파이프라인 {sig.closed ? '관찰 종료' : sig.stage === 'detect' ? '감지' : '진행 중'}).</> : null}
      </Callout>

      <div className="grid g-2">
        {w.serp.map((s) => <SerpCard key={s.keyword} s={s} w={w} />)}
      </div>
    </div>
  );
}

function SerpCard({ s, w }: { s: SerpCheck; w: WatchCtx }) {
  const m = SERP_VERDICT_META[s.verdict];
  const refs = w.archive.filter((r) => s.archiveRefs.includes(r.id));
  const shopOther = s.shopping ? Math.max(0, 10 - s.shopping.own - s.shopping.competitor) : 0;
  return (
    <Card
      title={<><span className="watch-q">'{s.keyword}'</span> 검색 결과</>}
      sub={`스냅샷 ${w.state.data.today} 07:00 · 모바일 통합검색 기준 (가상)`}
      actions={<><Src kind="DEMO" /></>}
    >
      <span className="watch-verdict">
        <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>
        <span className="xs ink2">{s.basis}</span>
      </span>
      <div className="watch-serp">
        <div className="watch-serp-head xs muted">파워링크 (광고)</div>
        {s.slots.map((slot) => (
          <div key={slot.pos} className={`watch-serp-slot ${slot.own ? 'own' : slot.competitor ? 'comp' : ''}`}>
            <span className="watch-serp-pos num">{slot.pos}</span>
            <span className="small">{slot.advertiser}</span>
            {slot.own ? <Pill tone="dark">자사</Pill> : slot.competitor ? <Pill tone="serious" icon="alert">경쟁사</Pill> : <Pill tone="outline">비경쟁</Pill>}
            {slot.competitor && slot.pos < s.ownPos ? <span className="xs muted">자사보다 위</span> : null}
          </div>
        ))}
        <div className="watch-serp-head xs muted">브랜드 · 쇼핑 · 콘텐츠 영역</div>
        <div className="watch-serp-row small">
          <span>브랜드검색 광고</span>
          {s.brandSearchAd === null ? <span className="muted">—</span> : s.brandSearchAd ? <Pill tone="good" icon="check">자사 노출</Pill> : <Pill tone="warning" icon="alert">미노출 · 확인 필요</Pill>}
        </div>
        {s.shopping ? (
          <div className="watch-serp-row small">
            <span>쇼핑 상위 10</span>
            <span className="watch-mini-share" role="img" aria-label={`자사 ${s.shopping.own} · 경쟁사 ${s.shopping.competitor} · 기타 ${shopOther}`}>
              <span style={{ flex: s.shopping.own, background: 'var(--ink)' }} />
              <span style={{ flex: s.shopping.competitor, background: 'var(--serious)' }} />
              <span style={{ flex: shopOther, background: 'var(--surface-3)' }} />
            </span>
            <span className="xs num">자사 {s.shopping.own} · 경쟁 {s.shopping.competitor} · 기타 {shopOther}</span>
          </div>
        ) : null}
        {s.content ? (
          <div className="watch-serp-row small">
            <span>블로그 · 카페 상위 10</span>
            <span className="xs num">경쟁사 언급 {s.content.competitorMentions}건</span>
          </div>
        ) : null}
      </div>
      <div className="row xs ink2" style={{ gap: 12 }}>
        <span className="num">평균 순위 {fmt.dec1(s.avgRank)}위 · 노출 기회 손실 {fmt.ratio(s.lost, 0)}</span>
        <span className="num">ROAS {fmt.roas(s.roas)} · 브랜드 목표 {w.cfg.brandTargetRoas}% 대비 {fmt.pct(s.roasVsTarget, 0)}</span>
        <Src kind="DEMO" />
      </div>
      {refs.length ? <div className="xs muted">아카이브: {refs.map((r) => `${r.date.slice(5)} ${r.competitor} ${r.serp?.position}위`).join(' · ')}</div> : null}
      {s.verdict === 'above' ? <a href="#adpilot" className="small">AD Pilot에서 방어 입찰 검토 (브랜드 목표 ROAS {w.cfg.brandTargetRoas}% · 순위 방어 우선) →</a> : null}
    </Card>
  );
}
