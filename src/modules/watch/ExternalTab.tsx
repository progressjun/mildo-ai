/* 외부 변수 — 시즌 캘린더(가설) · 공휴일 · 대형 쇼핑 행사 · 검색 트렌드(TEST DATA · 가설 지수) */
import { useMemo } from 'react';
import { fmt, fmtDate } from '@/core/util';
import { Card, DataTable, Delta, Pill, Src, Stat, type Column } from '@/ui/primitives';
import { LineChart } from '@/ui/charts';
import { monthGrid, type CalendarItem } from './engine';
import { DEMAND_HYPOTHESIS } from './data';
import type { WatchCtx } from './hooks';
import { LevelPill } from './parts';

const KIND_TONE: Record<CalendarItem['kind'], 'neutral' | 'accent' | 'dark' | 'outline'> = { move: 'neutral', wedding: 'neutral', shopping: 'outline', holiday: 'dark', promo: 'accent' };

export function ExternalTab({ w }: { w: WatchCtx }) {
  const d = w.state.data;
  const grid = useMemo(() => monthGrid(d, 12), [d]);
  const y = w.trend.yesterday;
  const life = w.exposure.find((e) => e.intent === 'life');
  const nextEv = w.calendar.find((c) => c.dday > 0);
  const columns: Column<CalendarItem>[] = [
    { key: 'kind', label: '구분', render: (c) => <Pill tone={KIND_TONE[c.kind]}>{c.kindLabel}</Pill> },
    { key: 'label', label: '일정', render: (c) => <strong className="small">{c.label}</strong> },
    { key: 'period', label: '기간', render: (c) => <span className="xs num">{fmtDate(c.start)}{c.end !== c.start ? ` ~ ${fmtDate(c.end)}` : ''}</span> },
    { key: 'dday', label: 'D-day', align: 'right', sort: (c) => c.dday, render: (c) => (c.active ? <Pill tone="good" icon="check">진행 중</Pill> : <strong className="num">D-{c.dday}</strong>) },
    { key: 'prep', label: '사전 준비', render: (c) => <span className="small">{c.prep}</span> },
    { key: 'basis', label: '근거', render: (c) => <span className="xs muted">{c.basis}</span> },
  ];
  const brandSeries = [
    { id: 'v', label: '브랜드 검색량', colorVar: '--series-1', points: w.trend.points.map((p) => ({ x: p.date, y: p.volume })) },
    { id: 'ma', label: '7일 이동평균', colorVar: '--series-7', dashed: true, points: w.trend.points.map((p) => ({ x: p.date, y: p.ma7 })) },
  ];
  const months = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
  const demandSeries = DEMAND_HYPOTHESIS.map((h) => ({ id: h.id, label: h.label, colorVar: h.colorVar, points: h.index.map((v, i) => ({ x: months[i], y: v })) }));

  return (
    <div className="stack-lg">
      <div className="grid g-4">
        <Card>
          <Stat label="브랜드 검색량 · 전일" src={<Src kind="DEMO" />} value={y ? fmt.int(y.volume) : '—'} delta={y?.deltaPct}
            foot={y ? <span className="row" style={{ gap: 6 }}><span>최근 4주 동요일 {fmt.int(y.base)} 대비 · 기준 ±{w.cfg.searchShiftPct}%</span><LevelPill level={y.level} /></span> : <span>데이터 없음</span>} />
        </Card>
        <Card><Stat label="최근 7일 평균 vs 직전 28일" src={<Src kind="DEMO" />} value={fmt.int(w.trend.last7)} delta={w.trend.last7Delta} foot={<span>GFA 집행과 1~2일 시차 동행 (DA→SA, 매출 성장 화면)</span>} /></Card>
        <Card><Stat label="생활 상황 키워드 노출 · 14일" src={<Src kind="DEMO" />} value={life ? fmt.int(life.last) : '—'} delta={life?.delta} foot={<span>{life?.newKeywords.length ? `신규 노출 ${life.newKeywords.join(' · ')}` : '신규 노출 없음'}</span>} /></Card>
        <Card><Stat label="다음 일정" src={<Pill tone="outline">가설 포함</Pill>} value={nextEv ? `D-${nextEv.dday}` : '—'} foot={<span>{nextEv ? `${nextEv.label} (${nextEv.kindLabel})` : '120일 내 일정 없음'}</span>} /></Card>
      </div>

      <Card
        title="시즌 캘린더 · 다가오는 120일"
        sub="이사 성수기 · 혼인 시즌은 일반 관측을 옮긴 가설이며 수면밀도 데이터로 검증 전입니다. 대형 쇼핑 행사 일정은 주최 측 발표로 확인이 필요합니다. 공휴일은 KR_HOLIDAYS(대체공휴일 고시 확인), 자사 프로모션은 데이터셋 기준."
        actions={<><Pill tone="outline">가설</Pill><Src kind="PROPOSAL" page="p.25" /></>}
      >
        <DataTable rows={w.calendar} columns={columns} rowKey={(c) => c.id} />
      </Card>

      <Card title="12개월 시즌 띠" sub="행 = 외부 변수 종류, 열 = 월. 겹치는 구간이 많을수록 경쟁사 프로모션 · CPC 변동을 같이 본다." actions={<Pill tone="outline">가설 포함</Pill>}>
        <div className="table-wrap">
          <table className="tbl watch-cal">
            <thead>
              <tr><th>구분</th>{grid.cols.map((c) => <th key={c.ym} className="c">{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {grid.rows.map((r) => (
                <tr key={r.kind}>
                  <td className="small nowrap"><strong>{r.label}</strong></td>
                  {r.cells.map((cell, i) => (
                    <td key={grid.cols[i].ym} className={`c watch-cal-cell k-${r.kind} ${cell.length ? 'on' : ''}`} title={cell.join(' · ')}>
                      {cell.length ? <span className="xs">{cell.length > 1 ? `${cell[0].split(' ')[0]} 외 ${cell.length - 1}` : cell[0].length > 8 ? `${cell[0].slice(0, 8)}…` : cell[0]}</span> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="브랜드 검색량 추이 · 최근 56일" sub="수면밀도 · 밀도 매트리스 합산 일별 검색량 (전일까지)" actions={<Src kind="DEMO" />}>
          <LineChart series={brandSeries} height={220} yFormat={(v) => fmt.int(v)} xFormat={(x) => fmtDate(x, false)} zeroBased={false} ariaLabel="브랜드 검색량 추이" />
          {y ? <div className="xs muted">전일 {fmtDate(y.date)} {fmt.int(y.volume)} · 최근 4주 동요일 평균 {fmt.int(y.base)} · <Delta pct={y.deltaPct} /> · 급변 기준 ±{w.cfg.searchShiftPct}% (MILDO Alert 외부 환경과 동일)</div> : null}
        </Card>
        <Card title="월별 수요 가설 지수" sub="100 = 연평균. 검색 트렌드 연동 전 가설값이며 실측이 아닙니다. 연동 후 전년 동기 실측으로 교체합니다." actions={<><Pill tone="outline">가설</Pill><Src kind="DEMO" /></>}>
          <LineChart series={demandSeries} height={220} yFormat={(v) => String(Math.round(v))} zeroBased={false} refLine={{ y: 100, label: '연평균 100' }} ariaLabel="월별 수요 가설 지수" />
        </Card>
      </div>

      <Card title="구매 의도별 노출 추이" sub="네이버 SA 키워드 노출 합계 최근 14일 vs 직전 14일 — 검색 수요 변화의 대리 지표 (순위 · 입찰 영향 포함)" actions={<><Src kind="PROPOSAL" page="p.35" /><Src kind="DEMO" /></>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>캠페인 (구매 의도)</th><th className="r">키워드</th><th className="r">노출 · 최근 14일</th><th className="r">직전 14일</th><th className="r">노출 증감</th><th className="r">클릭 증감</th><th>신규 노출 키워드</th></tr></thead>
            <tbody>
              {w.exposure.map((e) => (
                <tr key={e.intent}>
                  <td className="small">{e.name}</td>
                  <td className="r num">{e.keywords}</td>
                  <td className="r num">{fmt.int(e.last)}</td>
                  <td className="r num">{fmt.int(e.prev)}</td>
                  <td className="r"><Delta pct={e.delta} /></td>
                  <td className="r"><Delta pct={e.clicksDelta} /></td>
                  <td className="xs">{e.newKeywords.join(' · ') || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
