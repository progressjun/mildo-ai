import { useMemo, useState } from 'react';
import type { MediaId } from '@/core/types';
import { ANOMALY_THRESHOLDS, CAUSE_CANDIDATES, INTENT_IDS, MEDIA, MEDIA_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { fmt } from '@/core/util';
import { LineChart } from '@/ui/charts';
import { Card, DataTable, Pill, Src, type Column } from '@/ui/primitives';
import {
  budgetForecasts, buildHourIndex, evaluateMedia, fmtHour, hourlySeries, keywordShifts, mediaCauses, type BudgetForecast, type KeywordShift, type MetricEval,
} from './engine';
import { CauseList, LevelPill, MediaTag } from './parts';
import { PACE_CURVE_DAYS } from './data';
import type { AlertCtx } from './hooks';

const METRICS = ['cost', 'clicks', 'conversions', 'cpa', 'roas'] as const;

export function AnomalyTab({ ctx, onOpen }: { ctx: AlertCtx; onOpen: (id: string) => void }) {
  const { data, cfg, incidents } = ctx;
  const idx = useMemo(() => buildHourIndex(data), [data]);
  const evals = useMemo(() => MEDIA_IDS.map((m) => ({ m, ev: evaluateMedia(data, m, cfg, idx) })), [data, cfg, idx]);
  const firstHot = evals.find((x) => x.ev?.level === 'danger')?.m ?? 'meta';
  const [sel, setSel] = useState<MediaId>(firstHot);
  const selEv = evals.find((x) => x.m === sel)?.ev ?? null;
  const costSeries = useMemo(() => hourlySeries(data, sel, 'cost', idx), [data, sel, idx]);
  const convSeries = useMemo(() => hourlySeries(data, sel, 'conversions', idx), [data, sel, idx]);
  const selInc = incidents.find((i) => i.media === sel && (i.ruleId === 'data_spike' || i.ruleId === 'anomaly_warn' || i.ruleId === 'tracking_break') && i.status !== 'resolved');
  const causes = useMemo(() => (selInc?.causes?.length ? selInc.causes : mediaCauses(data, sel, cfg)), [selInc, data, sel, cfg]);
  const shifts = useMemo(() => keywordShifts(data, cfg).sort((a, b) => Math.abs(b.cpcD || 0) - Math.abs(a.cpcD || 0)), [data, cfg]);
  const forecasts = useMemo(() => budgetForecasts(data, cfg, idx), [data, cfg, idx]);
  const hrs = selEv?.hours ?? [];
  const hrLabel = hrs.length > 1 ? `${hrs[0]}~${hrs[hrs.length - 1]}시` : hrs.length ? `${hrs[0]}시` : '—';

  const cell = (e: MetricEval | undefined) => {
    if (!e) return <span className="muted">—</span>;
    if (!Number.isFinite(e.deltaPct)) return <div className="alert-cell"><span className="num muted">—</span><LevelPill level="info" label="산출 불가" title={e.note} /></div>;
    const lvl = e.note?.startsWith('전환 추적') ? 'info' : e.sampleOk ? e.level : e.level === 'ok' ? 'ok' : 'info';
    return (
      <div className="alert-cell">
        <span className="num">{Number.isFinite(e.deltaPct) ? fmt.delta(e.deltaPct, 0) : '—'}</span>
        <LevelPill level={lvl} label={lvl === 'info' && e.level !== 'ok' ? `${e.level === 'danger' ? '위험' : '주의'} · 참고` : undefined} title={e.note} />
      </div>
    );
  };

  const kwCols: Column<KeywordShift>[] = [
    { key: 'kw', label: '키워드', render: (k) => <div><strong className="small">{k.keyword.text}</strong><div className="xs muted">{SA_CAMPAIGNS[k.keyword.intent].name} · {k.keyword.status === 'test' ? '테스트 그룹' : '본 그룹'}</div></div> },
    { key: 'cpc', label: 'CPC 최근 3일 · 직전', align: 'right', render: (k) => <span className="num">{fmt.won(k.cpcRecent)} · {fmt.won(k.cpcBase)}</span> },
    { key: 'cpcD', label: 'CPC 변화', align: 'right', render: (k) => <span className="num">{fmt.delta(k.cpcD, 0)}</span>, sort: (k) => Math.abs(k.cpcD) },
    { key: 'conv', label: '일 전환 변화', align: 'right', render: (k) => (Number.isFinite(k.convD) ? <span className="num">{fmt.delta(k.convD, 0)}{k.convSampleOk ? null : <span className="xs muted" title={`직전 ${k.baseDays}일 전환 ${cfg.keywordMinConv}건 미만 — 판정 제외`}> · 표본 부족 참고</span>}</span> : <span className="muted">—</span>), sort: (k) => (Number.isFinite(k.convD) ? Math.abs(k.convD) : -1) },
    { key: 'roas', label: 'ROAS 최근 · 직전', align: 'right', render: (k) => <span className="num">{fmt.roas(k.roasRecent)} · {fmt.roas(k.roasBase)}</span> },
    { key: 'judge', label: `판정 (±${cfg.keywordSpikePct}%, p.14)`, render: (k) => (k.hit ? <span className="row" style={{ gap: 4 }}><LevelPill level="danger" label="급변 · 자동 조정 보류" /></span> : <LevelPill level="ok" />) },
  ];
  const fcCols: Column<BudgetForecast>[] = [
    { key: 'c', label: '캠페인', render: (f) => <div><strong className="small">{f.campaign.name}</strong><div><MediaTag media={f.campaign.media} /></div></div> },
    { key: 'b', label: '일 예산 · 오늘 소진', align: 'right', render: (f) => <span className="num">{fmt.krw(f.campaign.dailyBudget)} · {fmt.krw(f.campaign.spentToday)}</span> },
    { key: 'e', label: '같은 시각 평소 비중', align: 'right', render: (f) => <span className="num">{fmt.ratio(f.expectedShare, 0)}</span> },
    { key: 'p', label: '소진 페이스', align: 'right', render: (f) => <span className="num">{Number.isFinite(f.pace) ? `${f.pace.toFixed(2)}배` : '—'}</span>, sort: (f) => f.pace },
    { key: 'x', label: '예상 마감', align: 'right', render: (f) => <span className="num">{f.exhaustHour !== null ? fmtHour(f.exhaustHour) : '소진 없음'}</span> },
    { key: 'l', label: '미노출 구간 매출 비중', align: 'right', render: (f) => <span className="num">{f.exhaustHour !== null ? fmt.ratio(f.lostRevShare, 0) : '—'}</span>, sort: (f) => f.lostRevShare },
    { key: 'j', label: `판정 (≥ ${Math.round(cfg.budgetLostShare * 100)}%)`, render: (f) => (f.flag ? <LevelPill level="danger" label="조기 소진 예상" /> : f.exhaustHour !== null && f.exhaustHour < 23 ? <LevelPill level="warn" label="관찰" /> : <LevelPill level="ok" />) },
  ];

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card className="span-2" title="성과 이상 징후 모니터링 기준" sub="요일 · 시간대 패턴을 기준선으로 삼아 평소와 다른 움직임만 골라 알립니다 · 초기 기준값 (온보딩 중 오탐률 보며 조정)" actions={<Src kind="PROPOSAL" page="p.47" />}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>지표</th><th>비교 기준</th><th className="r">주의 (제안서)</th><th className="r">위험 (제안서)</th><th className="r">현재 적용</th></tr></thead>
              <tbody>
                {ANOMALY_THRESHOLDS.map((t) => {
                  const cur = cfg.thresholds[t.metric as keyof typeof cfg.thresholds];
                  const s = t.direction === 'both' ? '±' : t.direction === 'up' ? '+' : '−';
                  const changed = cur.warn !== t.warnPct || cur.danger !== t.dangerPct;
                  return (
                    <tr key={t.metric}>
                      <td><strong>{t.label}</strong></td><td>{t.baseline}</td>
                      <td className="r num">{s}{t.warnPct}%</td><td className="r num">{s}{t.dangerPct}%</td>
                      <td className="r num">{s}{cur.warn}% · {s}{cur.danger}% {changed ? <Pill tone="dark">변경 반영</Pill> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="xs muted">위험(±50%) 도달 → P2 데이터 급변 (p.44) · 주의만 도달 → P3 관찰. 전환 · CPA · ROAS는 구간 기대 전환 {cfg.minConvForRatio}건 미만이면 표본 부족으로 참고만 표시 (매트리스 객단가 약 100만 원 · 시간당 전환이 적어 단독 판정 시 오탐이 큼).</div>
        </Card>
        <Card title="원인 후보 체계" sub="MILDO Alert는 이상 감지와 함께 원인 후보를 제시" actions={<Src kind="PROPOSAL" page="p.47" />}>
          <div className="stack-sm">
            {CAUSE_CANDIDATES.map((c) => <div key={c} className="row small" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--ink-2)' }} />{c}</div>)}
          </div>
          <div className="xs muted">각 후보는 CPC · CPM · CTR · CVR 변화, 품절 랜딩, 프로모션 시작 · 종료, 집계 공백 신호로 근거 강도를 계산해 순위화합니다.</div>
        </Card>
      </div>

      <Card title={`매체 × 지표 이상 징후 · 최근 ${cfg.windowHours}시간 (${hrLabel})`} sub="광고비 · 클릭은 동요일 · 동시간 평균(최근 4주), 전환은 최근 7일 동시간, CPA · ROAS는 최근 7일 평균 대비. 행을 누르면 시간대 추이와 원인 후보가 바뀝니다." actions={<Src kind="DEMO" />}>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>매체</th>{METRICS.map((m) => { const t = ANOMALY_THRESHOLDS.find((x) => x.metric === m)!; const c = cfg.thresholds[m]; const s = t.direction === 'both' ? '±' : t.direction === 'up' ? '+' : '−'; return <th key={m} className="r">{t.label}<div className="xs" style={{ fontWeight: 400 }}>{s}{c.warn} · {s}{c.danger}%</div></th>; })}<th className="r">구간 기대 전환</th><th>종합</th><th>이슈</th></tr>
            </thead>
            <tbody>
              {evals.map(({ m, ev }) => {
                const inc = incidents.find((i) => i.media === m && ['data_spike', 'anomaly_warn', 'tracking_break', 'invalid_traffic', 'media_no_impression'].includes(i.ruleId) && i.status !== 'resolved');
                return (
                  <tr key={m} className={sel === m ? 'selected' : undefined} onClick={() => setSel(m)} style={{ cursor: 'pointer' }}>
                    <td><MediaTag media={m} /><div className="xs muted">{MEDIA[m].role}</div></td>
                    {METRICS.map((k) => <td key={k} className="r">{cell(ev?.evals.find((e) => e.metric === k))}</td>)}
                    <td className="r num">{ev ? fmt.dec1(ev.expectedConv) : '—'}</td>
                    <td>{inc?.ruleId === 'tracking_break' ? <LevelPill level="danger" label="추적 단절" title="전환 · CPA · ROAS는 추적 단절 이슈로 통합" /> : ev ? <LevelPill level={ev.level} /> : '—'}</td>
                    <td>{inc ? <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); onOpen(inc.id); }}>{inc.severity} 열기</button> : <span className="xs muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g-3">
        <Card className="span-2" title={`${MEDIA[sel].name} 오늘 시간대 추이`} sub="실선 오늘 · 점선 기준선. 기준선과 벌어지는 구간이 감지 구간입니다." actions={<Src kind="DEMO" />}>
          <div className="grid g-2">
            <div className="stack-sm">
              <span className="small"><strong>광고비</strong> <span className="muted">vs 동요일 4주 평균</span></span>
              <LineChart height={190} yFormat={(v) => fmt.krw(v)} xFormat={(x) => `${x}시`}
                series={[
                  { id: 'today', label: '오늘', colorVar: MEDIA[sel].colorVar, points: costSeries.map((p) => ({ x: String(p.hour), y: p.today })) },
                  { id: 'base', label: '동요일 평균', colorVar: '--ink-2', dashed: true, points: costSeries.map((p) => ({ x: String(p.hour), y: p.sameWeekday })) },
                ]} />
            </div>
            <div className="stack-sm">
              <span className="small"><strong>전환</strong> <span className="muted">vs 최근 7일 평균</span></span>
              <LineChart height={190} yFormat={(v) => fmt.dec1(v)} xFormat={(x) => `${x}시`}
                series={[
                  { id: 'today', label: '오늘', colorVar: MEDIA[sel].colorVar, points: convSeries.map((p) => ({ x: String(p.hour), y: p.today })) },
                  { id: 'base', label: '최근 7일 평균', colorVar: '--ink-2', dashed: true, points: convSeries.map((p) => ({ x: String(p.hour), y: p.last7 })) },
                ]} />
            </div>
          </div>
          {selEv ? (
            <div className="xs muted">
              감지 구간 {hrLabel}: 광고비 {fmt.krw(selEv.today.cost)}원 (기준 {fmt.krw(selEv.sameWeekday?.cost ?? NaN)}원) · CPC {fmt.delta(selEv.derived.cpcD, 0)} · CPM {fmt.delta(selEv.derived.cpmD, 0)} · CTR {fmt.delta(selEv.derived.ctrD, 0)} · CVR {fmt.delta(selEv.derived.cvrD, 0)}
            </div>
          ) : null}
        </Card>
        <Card title={`${MEDIA[sel].name} 원인 후보 순위`} sub={selInc ? `이슈 근거 기준 · ${selInc.title}` : '이슈 미생성 · 현재 데이터 기준 계산'} actions={<Src kind="DEMO" />}>
          {causes.length ? <CauseList causes={causes} /> : <div className="small muted">기준선 데이터 없음</div>}
        </Card>
      </div>

      <Card title="키워드 성과 급변 · 최근 3일 vs 직전 11일" sub={`AD Pilot 규칙(p.14): 최근 3일 CPC · 전환 ±${cfg.keywordSpikePct}% → 자동 조정 보류 · 알림. 전환 변화는 직전 전환 ${cfg.keywordMinConv}건 이상일 때만 판정.`} actions={<><Src kind="PROPOSAL" page="p.14" /><Src kind="DEMO" /></>}>
        <DataTable rows={shifts} columns={kwCols} rowKey={(k) => k.keyword.id} maxHeight={340}
          onRowClick={(k) => { const inc = incidents.find((i) => i.ruleId === 'keyword_spike' && i.target === k.keyword.text); if (inc) onOpen(inc.id); }} />
        <div className="xs muted">의도별 캠페인: {INTENT_IDS.map((i) => SA_CAMPAIGNS[i].name).join(' · ')} (p.35)</div>
      </Card>

      <Card title="일 예산 소진 예측 · 예산 소진 중지 선제 감지" sub={`최근 ${PACE_CURVE_DAYS}일(오늘 제외) 매체 시간대 소진 곡선 기준 · 예상 마감 이후 구간의 평소 매출 비중이 ${Math.round(cfg.budgetLostShare * 100)}% 이상이면 P2 (p.44 광고 OFF · 미노출의 '예산 소진 중지' 선행 신호)`} actions={<><Src kind="PROPOSAL" page="p.14 · p.44" /><Src kind="DEMO" /></>}>
        <DataTable rows={forecasts} columns={fcCols} rowKey={(f) => f.campaign.id} initialSort={{ key: 'p', dir: 'desc' }} maxHeight={380}
          onRowClick={(f) => { const inc = incidents.find((i) => i.ruleId === 'budget_forecast' && i.target === f.campaign.name); if (inc) onOpen(inc.id); }} />
        <div className="xs muted">페이스 = (오늘 소진 ÷ 일 예산) ÷ 같은 시각 평소 소진 비중. 시간대 곡선은 최근 {PACE_CURVE_DAYS}일 같은 매체의 시간대별 광고비 비중으로 MILDO Board 예산 소진 현황 · AD Pilot 조기 소진 판정과 같은 기준이라 예상 마감 시각이 세 화면에서 같습니다. 선형 추정(campaignPacing)과 달리 저녁 피크 시간대 비중을 반영하며, 현재 페이스 유지 가정이라 확정 예측이 아닙니다. 판정 기준(미노출 구간 매출 비중 {Math.round(cfg.budgetLostShare * 100)}%)은 운영 가정입니다.</div>
      </Card>
    </div>
  );
}
