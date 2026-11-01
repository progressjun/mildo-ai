/* 통합 데이터 아키텍처(p.12) — 수집 상태 스트립 · 원천별 상태 · 검증 · 표준화 키 · 데이터 시간표(p.18) */
import { useMemo } from 'react';
import type { Dataset, Incident } from '@/core/types';
import { fmt, fmtDate } from '@/core/util';
import { Card, DataTable, Pill, Src, type Column } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { collectionSummary, keyMappingSamples, sourceStatuses, standardKeyStats, validationChecks, type CollectionSummary, type SourceStatus } from './engine';
import { StatusDot } from './parts';
import { LAYER_OUTPUT, LAYER_STEPS, SALES_NOTE, SOURCE_GROUPS, STANDARD_KEYS } from './data';

function groupState(src: SourceStatus[], g: SourceStatus['group']): 'ok' | 'warn' | 'snapshot' {
  const xs = src.filter((s) => s.group === g);
  if (xs.some((s) => s.state === 'warn')) return 'warn';
  if (xs.every((s) => s.state === 'snapshot')) return 'snapshot';
  return 'ok';
}

/** 페이지 상단 스트립 — 원천 3그룹 → 통합 데이터 레이어 → Pro-board */
export function PipelineStrip({ d, mer, merLabel, onOpen }: { d: Dataset; mer: number; merLabel: string; onOpen: () => void }) {
  const s = useMemo(() => collectionSummary(d), [d]);
  const src = useMemo(() => sourceStatuses(d), [d]);
  const counts: Record<string, string> = {
    media: `${s.media.ok}/${s.media.total}`,
    sales: `${s.sales.ok}/${s.sales.total}`,
    external: `${s.external.inDataset}/${s.external.total}`,
  };
  return (
    <Card tone="dark" className="board-pipe-card">
      <div className="row-between">
        <span className="eyebrow" style={{ color: 'var(--panel-muted)' }}>INTEGRATED DATA LAYER · p.12</span>
        <span className="row xs" style={{ gap: 6 }}><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.12 · p.18" /></span>
      </div>
      <div className="board-pipe">
        <div className="board-pipe-col">
          {SOURCE_GROUPS.map((g) => {
            const st = groupState(src, g.id);
            return (
              <div key={g.id} className="board-node">
                <div className="board-node-title"><span className="row" style={{ gap: 6 }}><StatusDot state={st} />{g.label}</span><span className="num xs">{counts[g.id]}</span></div>
                <div className="board-node-sub">{g.detail}</div>
              </div>
            );
          })}
        </div>
        <span className="board-arrow"><Icon name="chevron" size={22} /></span>
        <div className="board-node">
          <div className="board-node-title">통합 데이터 레이어</div>
          <div className="board-steps">
            {LAYER_STEPS.map((t, i) => (
              <div key={t} className="board-step"><span className="board-step-n"><Icon name={i === LAYER_STEPS.length - 1 ? 'check' : 'chevronDown'} size={11} stroke={2.4} /></span>{t}</div>
            ))}
          </div>
        </div>
        <span className="board-arrow"><Icon name="chevron" size={22} /></span>
        <div className="board-node out">
          <div className="board-node-title">Pro-board</div>
          <div className="board-node-sub">{LAYER_OUTPUT}</div>
          <div className="board-node-big" style={{ color: 'var(--accent)' }}>{fmt.dec1(mer)}배</div>
          <div className="board-node-sub">MER · {merLabel}</div>
        </div>
      </div>
      <PipeFoot s={s} onOpen={onOpen} />
    </Card>
  );
}

function PipeFoot({ s, onOpen }: { s: CollectionSummary; onOpen: () => void }) {
  return (
    <div className="board-pipe-foot">
      <span className="row" style={{ gap: 6 }}><StatusDot state="ok" /><span>최근 수집 <strong>{s.batchTime} 완료</strong> · {fmtDate(s.batchDate)} 전일분 검증</span></span>
      <span>시간대 데이터 <strong>{s.hourlyThrough === null ? '없음' : `${String(s.hourlyThrough).padStart(2, '0')}:00까지`}</strong></span>
      <span>기준 시각 <strong>{s.asOf}</strong>{s.offDay.off ? ` · ${s.offDay.label}` : ''}</span>
      <span className="row" style={{ gap: 6 }}>
        <StatusDot state={s.warnings ? 'warn' : 'ok'} />
        <span>검증 확인 필요 <strong>{s.warnings}건</strong></span>
        <button type="button" className="board-linkbtn" onClick={onOpen}>수집 · 검증 상세</button>
      </span>
    </div>
  );
}

export function DataTab({ d, incidents }: { d: Dataset; incidents: Incident[] }) {
  const s = useMemo(() => collectionSummary(d), [d]);
  const src = useMemo(() => sourceStatuses(d), [d]);
  const checks = useMemo(() => validationChecks(d), [d]);
  const keys = useMemo(() => standardKeyStats(d), [d]);
  const maps = useMemo(() => keyMappingSamples(d), [d]);
  const open = incidents.filter((i) => i.status !== 'resolved');

  const cols: Column<SourceStatus>[] = [
    {
      key: 'name', label: '원천', sort: (r) => r.name,
      render: (r) => <div className="board-cell l"><span className="row" style={{ gap: 6 }}><StatusDot state={r.state === 'warn' ? 'warn' : r.state === 'snapshot' ? 'snapshot' : 'ok'} /><strong className="small">{r.name}</strong></span><span className="board-sub">{SOURCE_GROUPS.find((g) => g.id === r.group)?.label}</span></div>,
    },
    { key: 'method', label: '연동 방식 (가정)', render: (r) => <span className="small">{r.method}</span> },
    {
      key: 'last', label: '최근 수집', sort: (r) => r.lastDate ?? '',
      render: (r) => (r.lastDate ? <div className="board-cell l"><span className="small num">{fmtDate(r.lastDate)}{r.lastHour !== null ? ` ${String(r.lastHour).padStart(2, '0')}시` : ''}</span><span className="board-sub">{r.days}일{r.missingDays ? ` · 결측 ${r.missingDays}일` : ''}</span></div> : <span className="small muted">{r.inDataset ? '없음' : '데이터셋 미포함'}</span>),
    },
    { key: 'rows', label: '행', align: 'right', sort: (r) => r.rows, render: (r) => <span className="num small">{r.rows ? fmt.int(r.rows) : '—'}</span> },
    {
      key: 'account', label: '계정 · 결제',
      render: (r) => (r.account ? <div className="board-badge"><Pill tone={r.account.tone} icon={r.account.tone === 'good' ? 'check' : 'alert'}>{r.account.label}</Pill>{r.account.balance >= 0 ? <span className="board-basis">잔액 {fmt.krw(r.account.balance)} · 일 평균 {fmt.krw(r.account.avgDailySpend)}</span> : <span className="board-basis">후불</span>}</div> : <span className="xs muted">—</span>),
    },
    {
      key: 'note', label: '상태',
      render: (r) => <div className="board-cell l"><span className="small">{r.note}</span>{r.route ? <a className="xs" href={`#${r.route}`}>{r.route === 'alert' ? 'MILDO Alert에서 확인' : r.route === 'watch' ? 'MILDO Watch 열기' : r.route === 'geo' ? 'SearchTuneOS 열기' : '매출 성장 · DA→SA'}</a> : null}</div>,
    },
  ];

  return (
    <div className="stack-lg">
      <Card title="통합 데이터 아키텍처" sub="광고 매체 · 판매 채널 · 외부 데이터를 같은 키로 표준화해 광고비와 실제 매출을 한 화면에서 연결합니다." actions={<Src kind="PROPOSAL" page="p.12" />}>
        <div className="board-arch">
          <div className="board-pipe-col">
            {SOURCE_GROUPS.map((g) => (
              <div key={g.id} className="board-node">
                <div className="board-node-title"><span className="row" style={{ gap: 6 }}><StatusDot state={groupState(src, g.id)} />{g.label}</span></div>
                <div className="board-node-sub">{g.detail}</div>
              </div>
            ))}
          </div>
          <span className="board-arrow"><Icon name="chevron" size={22} /></span>
          <div className="board-node">
            <div className="board-node-title">통합 데이터 레이어</div>
            <div className="board-steps">
              {LAYER_STEPS.map((t, i) => <div key={t} className="board-step"><span className="board-step-n"><Icon name={i === LAYER_STEPS.length - 1 ? 'check' : 'chevronDown'} size={11} stroke={2.4} /></span>{t}</div>)}
            </div>
          </div>
          <span className="board-arrow"><Icon name="chevron" size={22} /></span>
          <div className="board-node out">
            <div className="board-node-title">Pro-board</div>
            <div className="board-node-sub">{LAYER_OUTPUT} · 매체 통합 성과 · 키워드 성과 필터 · 예산 소진 현황(p.13)</div>
          </div>
        </div>
        <div className="xs muted">{SALES_NOTE} 연동 방식은 가정이며 온보딩 D+60 데이터 연동 단계(p.20 · p.54)에서 확정합니다.</div>
      </Card>

      <div className="grid g-3">
        <Card title="수집 · 검증" sub={`${fmtDate(d.today)} ${s.asOf} 기준 · 확인 필요 ${s.warnings}건`} className="span-2" actions={<><Src kind="DEMO" />{open.length ? <a className="btn sm" href="#alert">MILDO Alert 열린 이슈 {open.length}건</a> : null}</>}>
          <div className="board-list">
            {checks.map((c) => (
              <div key={c.id} className="board-list-item">
                <Pill tone={c.level === 'ok' ? 'good' : 'warning'} icon={c.level === 'ok' ? 'check' : 'alert'}>{c.level === 'ok' ? '통과' : '확인 필요'}</Pill>
                <div className="stack-sm" style={{ gap: 2 }}>
                  <span className="small"><strong>{c.label}</strong> <span className="muted">· {c.source}</span></span>
                  <span className="small">{c.detail}</span>
                  <span className="board-sub">기준 {c.basis}</span>
                </div>
                {c.route ? <a className="xs nowrap" href={`#${c.route}`}>Alert에서 보기</a> : <span />}
              </div>
            ))}
          </div>
        </Card>
        <Card title="데이터 제공 시간표" sub="수면밀도 업무시간 08–17 기준 (p.18)" actions={<Src kind="PROPOSAL" page="p.18" />}>
          <div className="board-list">
            {s.timetable.map((t) => (
              <div key={t.time} className="board-list-item">
                <span className="num small"><strong>{t.time}</strong></span>
                <div className="stack-sm" style={{ gap: 1 }}>
                  <span className="small">{t.title}</span>
                  <span className="board-sub">{t.channel}{t.note ? ` · ${t.note}` : ''}</span>
                </div>
                <Pill tone={t.state === 'done' ? 'good' : t.state === 'moved' ? 'outline' : 'neutral'} icon={t.state === 'done' ? 'check' : 'clock'}>{t.state === 'done' ? '완료' : t.state === 'moved' ? '이동' : '예정'}</Pill>
              </div>
            ))}
          </div>
          <a className="xs" href="#reports">리포트 · 데이터 시간표 열기</a>
        </Card>
      </div>

      <Card title="원천별 수집 상태" sub="광고 매체 6 · 판매 채널 4 · 외부 데이터 3" actions={<Src kind="DEMO" />}>
        <DataTable rows={src} columns={cols} rowKey={(r) => r.id} />
      </Card>

      <div className="grid g-2">
        <Card title="표준화 키" sub="날짜 · 채널 · 키워드 · 상품 (p.12)" actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.12" /></>}>
          <div className="board-list">
            {keys.map((k) => (
              <div key={k.id} className="board-list-item">
                <strong className="small">{k.label}</strong>
                <div className="stack-sm" style={{ gap: 1 }}>
                  <span className="small">{STANDARD_KEYS.find((x) => x.id === k.id)?.rule}</span>
                  <span className="board-sub">{k.detail}</span>
                </div>
                <span className="num small"><strong>{k.value}</strong></span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="원천 레코드 → 표준 키 매핑 예시" sub="이 데이터셋의 실제 레코드에서 추출" actions={<Src kind="DEMO" />}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>원천</th><th>날짜</th><th>채널</th><th>키워드</th><th>상품</th></tr></thead>
              <tbody>
                {maps.map((m, i) => (
                  <tr key={i}>
                    <td><div className="board-cell l"><strong className="small">{m.source}</strong><span className="board-sub">{m.raw}</span>{m.note ? <Pill tone="critical" icon="alert">{m.note}</Pill> : null}</div></td>
                    <td className="small num nowrap">{/^\d{4}-\d{2}-\d{2}$/.test(m.date) ? fmtDate(m.date) : m.date}</td>
                    <td className="nowrap"><code className="xs">{m.channel}</code></td>
                    <td className="small" style={{ minWidth: 120 }}>{m.keyword}</td>
                    <td className="nowrap"><code className="xs">{m.product}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
