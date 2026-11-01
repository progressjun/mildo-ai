/* 프로모션별 리포트 자동 생성 (p.31 프로모션 결과 → 다음 기획에 즉시 반영) */
import { useMemo } from 'react';
import { SALES_CHANNELS } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { LineChart, ShareBar } from '@/ui/charts';
import { Markdown } from '@/ui/Markdown';
import { Button, Card, CopyButton, DataTable, Delta, DownloadButton, Pill, Segmented, Src, Stat, type Column } from '@/ui/primitives';
import { STATUS_META } from './data';
import { fixStateOf, fmtMetric, fmtPp, promoNextInput, promoReport, type ChannelMixRow, type PromoMetricRow } from './engine';
import type { FlowCtx } from './useFlow';

export function PromoReportTab({ ctx, promoId, onPromo }: { ctx: FlowCtx; promoId: string; onPromo: (id: string) => void }) {
  const { data, changes, incidents, createRequest } = ctx;
  const promos = data.promotions ?? [];
  const p = promos.find((x) => x.id === promoId) ?? promos[0];
  const r = useMemo(() => (p ? promoReport(data, p, { changes, incidents }) : null), [data, p, changes, incidents]);
  if (!p || !r) return <Card title="프로모션 리포트"><div className="small muted">등록된 프로모션이 없습니다.</div></Card>;
  const get = (k: string) => r.rows.find((x) => x.key === k)!;
  const nextInput = promoNextInput(r);
  const nextState = nextInput ? fixStateOf(changes, nextInput.targetId ?? '') : null;
  const colorVar = SALES_CHANNELS[p.channel]?.colorVar ?? '--series-1';
  const cols: Column<PromoMetricRow>[] = [
    { key: 'label', label: '지표', render: (x) => <span className="small">{x.label}</span> },
    { key: 'cur', label: r.period ? '프로모션 기간' : '오픈 전', align: 'right', render: (x) => fmtMetric(x.unit, x.cur) },
    { key: 'prev', label: '직전 동기간', align: 'right', render: (x) => fmtMetric(x.unit, x.prev) },
    { key: 'delta', label: '증감', align: 'right', render: (x) => (x.unit === 'ratio' ? <span className="num">{fmtPp(x.pp)}</span> : <Delta pct={x.delta} invert={x.invert} />) },
  ];
  const mixCols: Column<ChannelMixRow>[] = [
    { key: 'name', label: '판매 채널', render: (m) => <span className="small">{m.name}{m.isPromo ? <strong> · 기획전</strong> : null}</span> },
    { key: 'cur', label: '기간 매출', align: 'right', render: (m) => fmtMetric('krw', m.cur) },
    { key: 'curShare', label: '비중', align: 'right', render: (m) => fmtMetric('ratio', m.curShare) },
    { key: 'prev', label: '직전 매출', align: 'right', render: (m) => fmtMetric('krw', m.prev) },
    { key: 'prevShare', label: '직전 비중', align: 'right', render: (m) => fmtMetric('ratio', m.prevShare) },
    { key: 'pp', label: '비중 변화', align: 'right', render: (m) => fmtPp(m.shareDeltaPp) },
    { key: 'delta', label: '매출 증감', align: 'right', render: (m) => <Delta pct={m.delta} /> },
  ];
  const tile = (k: string, label: string) => {
    const x = get(k);
    const ratio = x.unit === 'ratio';
    return <Stat label={label} value={fmtMetric(x.unit, r.period ? x.cur : x.prev)} delta={r.period && !ratio ? x.delta : undefined} invert={x.invert}
      foot={r.period ? <span className="muted">{ratio ? <strong className="num">{fmtPp(x.pp)} </strong> : null}직전 {fmtMetric(x.unit, x.prev)}</span> : <span className="muted">기준선 (직전 {r.prev?.days ?? 0}일)</span>} />;
  };

  return (
    <div className="stack-lg">
      <div className="row-between">
        <Segmented label="프로모션" value={p.id} onChange={onPromo} options={promos.map((x) => ({ id: x.id, label: x.name }))} />
        <div className="row">
          <Src kind="DEMO" /><Src kind="PROPOSAL" page="p.31" />
          <CopyButton text={r.markdown} label="리포트 복사" />
          <DownloadButton filename={`mildo-promo-report-${p.id}-${data.today}.md`} data={r.markdown} mime="text/markdown;charset=utf-8" label=".md 다운로드" />
        </div>
      </div>

      <Card title={<>{p.name} <span className="muted small">· {r.channelName} · 할인 {p.discountRate}%</span></>}
        sub={r.period && r.prev ? `프로모션 ${fmtDate(r.period.from)}~${fmtDate(r.period.to)} (${r.period.days}일${r.phase === 'live' ? ' · 진행 중, 어제까지' : ''}) vs 직전 동기간 ${fmtDate(r.prev.from)}~${fmtDate(r.prev.to)}` : `오픈 전 · ${fmtDate(p.start)} 오픈 예정 — 기준선만 표시`}
        actions={<Src kind="DEMO" />}>
        <div className="grid g-6">
          {tile('chRevenue', `${r.channelName} 매출`)}
          {tile('adCost', '관련 매체 광고비')}
          {tile('roas', '광고 ROAS')}
          {tile('mer', '광고비 대비 실매출')}
          {tile('share', '채널 비중')}
          {tile('totalSales', '전 채널 합산')}
        </div>
      </Card>

      <div className="grid g-2 flow-report-pair">
        <Card title="일자별 채널 매출" sub={r.period ? '프로모션 기간 D+n vs 직전 동기간 같은 순서의 날' : '기준선 (직전 기간)'} actions={<Src kind="DEMO" />}>
          {r.daily.length ? (
            <LineChart height={420} yFormat={(v) => fmt.krw(v)} xFormat={(x) => x}
              series={[
                ...(r.period ? [{ id: 'cur', label: '프로모션 기간', colorVar, points: r.daily.map((d) => ({ x: `D${d.idx}`, y: d.cur })) }] : []),
                { id: 'prev', label: '직전 동기간', colorVar: '--ink-2', dashed: true, points: r.daily.map((d) => ({ x: `D${d.idx}`, y: d.prev })) },
              ]} />
          ) : <div className="small muted">비교 데이터가 없습니다.</div>}
        </Card>
        <Card title="지표 비교" sub="같은 채널 · 같은 일수 · 오늘(부분일) 제외" actions={<Src kind="DEMO" />}>
          <DataTable rows={r.rows} columns={cols} rowKey={(x) => x.key} />
        </Card>
      </div>

      <Card title="판매 채널 비중" sub={`전 채널 합산 매출 기준 구성비 · 기획전 채널 비중 변화와 다른 채널 매출 증감을 함께 봐야 채널 간 이동(잠식)을 구분합니다 (합산 매출 기준 판단 p.41)`}
        actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.41" /></>}>
        <div className="grid g-2">
          <div className="stack-sm">
            <div className="xs muted">{r.period ? `프로모션 기간 ${fmtDate(r.period.from)}~${fmtDate(r.period.to)}` : '프로모션 기간 · 집계 전'}</div>
            {r.period ? <ShareBar parts={r.mix.map((m) => ({ label: m.name, value: Number.isFinite(m.cur) ? m.cur : 0, colorVar: m.colorVar }))} /> : <div className="small muted">오픈 전 — 기간 매출 없음</div>}
          </div>
          <div className="stack-sm">
            <div className="xs muted">{r.prev ? `직전 동기간 ${fmtDate(r.prev.from)}~${fmtDate(r.prev.to)}` : '직전 동기간 없음'}</div>
            {r.prev ? <ShareBar parts={r.mix.map((m) => ({ label: m.name, value: Number.isFinite(m.prev) ? m.prev : 0, colorVar: m.colorVar }))} /> : null}
          </div>
        </div>
        <DataTable rows={r.mix} columns={mixCols} rowKey={(m) => m.channel} />
      </Card>

      <div className="grid g-3">
        <Card className="span-2" title="자동 생성 리포트" sub="확정 팩트 / 반복 관측 패턴 / 해석 / 전제 · 반례 / 다음 액션 구분 · 복사 · .md 다운로드" actions={<Src kind="DEMO" />}>
          <Markdown text={r.markdown} />
        </Card>
        <Card tone="dark" className="flow-next-card" title="다음 기획에 즉시 반영" sub="이번 프로모션 점검 · 성과에서 나온 항목">
          <ul className="flow-next">
            {r.next.map((n, k) => <li key={k} className="small">{n}</li>)}
          </ul>
          <div className="xs muted">PM 제안 → 수면밀도 승인 (예산 · 구조 변경, 당일 · p.53)</div>
          {nextInput ? (
            nextState
              ? <Pill tone="outline" icon="check">반영 요청됨 · {STATUS_META[nextState.status].label}</Pill>
              : <Button size="sm" variant="accent" icon="send" onClick={() => createRequest(nextInput)}>다음 기획 반영 요청 · 수면밀도 승인</Button>
          ) : null}
        </Card>
      </div>

      <AiInsight title="AI 해석 추가" sub="리포트 수치를 그대로 넘겨 해석 섹션을 보강합니다" cta="AI 해석 추가"
        buildPrompt={() => `과제: 아래 프로모션 리포트(시연용 테스트 데이터)를 읽고 프로모션 증분 효과 판단, 채널 잠식 여부, 다음 기획 반영 사항을 정리하라. 수치는 리포트 값만 인용한다.\n\n${r.markdown}`}
        fallback={() => r.brief} />
    </div>
  );
}
