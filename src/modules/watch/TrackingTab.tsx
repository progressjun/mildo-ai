/* p.24 매체 변동 선제 트래킹 · 매체별 실행안 + 감지 이벤트 피드 */
import { useMemo, useState } from 'react';
import type { MediaId } from '@/core/types';
import { fmt } from '@/core/util';
import { Button, Card, DataTable, Delta, Empty, Pill, Segmented, Sev, Src, type Column } from '@/ui/primitives';
import { CHANGE_STATUS_LABEL, fmtKst, KIND_LABEL, kstMs, linkedIncidents, VERDICT_META, type EvaluatedEvent, type StageId } from './engine';
import { MEDIA_TRACKING, PACE_RULES } from './data';
import type { WatchCtx } from './hooks';
import { Chips, DueTag, MediaTag, PipelineSteps, TestBadge, VerdictBadge, mediaLabel } from './parts';

type Row = WatchCtx['tracking'][number];
type StageFilter = 'open' | 'all' | StageId;

export function TrackingTab({ w, onOpen }: { w: WatchCtx; onOpen: (id: string) => void }) {
  const [media, setMedia] = useState<'all' | MediaId>('all');
  const [stage, setStage] = useState<StageFilter>('open');
  const [origin, setOrigin] = useState<'all' | 'notice' | 'signal'>('all');

  const list = useMemo(() => {
    // 정렬: 24시간 진단 기한 초과 · 임박(SLA) → 랩업 가능 등 처리 가능 → 진행 중 → 완료. 진단 대기는 기한 순, 나머지는 영향 판정 순
    const order = (e: EvaluatedEvent) => (e.closed || e.stage === 'wrapup' ? 3 : e.stage === 'detect' && (e.due.overdue || e.due.urgent) ? 0 : e.due.overdue || e.due.urgent ? 1 : 2);
    const byDue = (a: EvaluatedEvent, b: EvaluatedEvent) => (a.stage === 'detect' && b.stage === 'detect' ? (a.due.remainingH ?? 1e9) - (b.due.remainingH ?? 1e9) : 0);
    return w.events
      .filter((e) => (media === 'all' || e.media === media) && (origin === 'all' || e.origin === origin))
      .filter((e) => (stage === 'all' ? true : stage === 'open' ? !e.closed && e.stage !== 'wrapup' : e.stage === stage && !e.closed))
      .sort((a, b) => order(a) - order(b) || byDue(a, b) || VERDICT_META[b.diag.verdict].rank - VERDICT_META[a.diag.verdict].rank || (a.due.remainingH ?? 1e9) - (b.due.remainingH ?? 1e9));
  }, [w.events, media, stage, origin]);

  const columns: Column<Row>[] = [
    { key: 'media', label: '매체', width: 120, render: (r) => <div className="stack-sm" style={{ gap: 2 }}><MediaTag media={r.media} /><span className="xs muted">{r.role}</span></div> },
    { key: 'target', label: '트래킹 대상', render: (r) => <span className="small">{r.target}</span> },
    { key: 'method', label: '감지 방식', render: (r) => <span className="small ink2">{r.method}</span> },
    { key: 'plan', label: '수면밀도 실행안', render: (r) => <span className="small">{r.plan}</span> },
    { key: 'open', label: '진행 이벤트', align: 'right', sort: (r) => r.open, render: (r) => <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}><strong className="num">{r.open}<span className="muted xs"> / {r.total}</span></strong><span className="xs muted nowrap">공지 {r.notices} · 데이터 {r.signals}</span></div> },
    {
      key: 'kpi', label: '판단 지표 · 최근 7일', align: 'right', sort: (r) => r.roas,
      // p.37 판단 지표가 CPA 계열인 매체(GFA · Meta · 카카오)는 CPA를 먼저, 나머지는 ROAS를 먼저 보여준다
      render: (r) => {
        const cpaFirst = /CPA/.test(r.judgeMetric);
        const cpa = <span className="num small">CPA {fmt.won(r.cpa)} <Delta pct={r.cpaDelta} invert /></span>;
        const roas = <span className="num small">ROAS {fmt.roas(r.roas)} <Delta pct={r.roasDelta} /></span>;
        return <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}><span className="xs muted">{r.judgeMetric}</span>{cpaFirst ? cpa : roas}<span className="xs muted">{cpaFirst ? <>ROAS {fmt.roas(r.roas)}</> : <>CPA {fmt.won(r.cpa)}</>}</span></div>;
      },
    },
    { key: 'worst', label: '현재 판정 · 근거', width: 280, render: (r) => (r.worst ? <div className="stack-sm" style={{ gap: 2 }}><Pill tone={VERDICT_META[r.worst.verdict].tone} icon={VERDICT_META[r.worst.verdict].icon}>{r.worst.label}</Pill><span className="xs muted watch-clip2">{r.worst.basis}</span></div> : <span className="xs muted">진행 이벤트 없음</span>) },
  ];

  return (
    <div className="stack-lg">
      <Card
        title="매체 변동 선제 트래킹 · 매체별 실행안"
        sub="신규 상품 · 광고 지면 · 노출 로직 변화를 MILDO Watch가 먼저 잡고, 매체별 실행안으로 바로 연결합니다. 행을 누르면 해당 매체 이벤트만 봅니다."
        actions={<><Src kind="PROPOSAL" page="p.24" /><Src kind="DEMO" /></>}
      >
        <DataTable rows={w.tracking} columns={columns} rowKey={(r) => r.media} onRowClick={(r) => setMedia(media === r.media ? 'all' : r.media)} selectedKey={media === 'all' ? null : media} />
        <div className="xs muted">판단 지표는 제안서 p.37 매체별 역할 기준. 진행 이벤트 = 랩업 · 관찰 종료 전 이벤트. 판정은 p.47 주의 기준(광고비 · 클릭 ±{w.cfg.warn.cost}%, CPA +{w.cfg.warn.cpa}%, ROAS −{w.cfg.warn.roas}%)에 계정 상태 · 잔액(p.44), 일 예산 {PACE_RULES.exhaustBeforeHour}시 전 마감(최근 {PACE_RULES.curveDays}일 시간대 소진 곡선), 전환 추적 단절(p.45)을 함께 대조합니다.</div>
      </Card>

      <Card
        title={<>감지 이벤트 피드 <span className="xs muted" style={{ fontWeight: 400 }}>변동 감지 → 24시간 내 영향 진단 → 주간 리포트 실행안 → 소액 테스트 → 랩업 · 확대</span></>}
        sub="매체 공지 이벤트는 시연용 가상 공지(GFA 신규 상품 3종은 제안서 p.24 표기)이고, 데이터 감지 신호와 영향 진단 수치는 TEST DATA에서 계산합니다."
        actions={<><Src kind="PROPOSAL" page="p.24" /><Src kind="DEMO" /></>}
      >
        <div className="row-between">
          <Segmented<'all' | MediaId>
            label="매체"
            value={media}
            onChange={setMedia}
            options={[{ id: 'all', label: '전체 매체' }, ...MEDIA_TRACKING.map((m) => ({ id: m.media, label: m.name }))]}
          />
          <div className="row">
            <Segmented<'all' | 'notice' | 'signal'> label="출처" value={origin} onChange={setOrigin} options={[{ id: 'all', label: '전체' }, { id: 'notice', label: '매체 공지' }, { id: 'signal', label: '데이터 감지' }]} />
            <Segmented<StageFilter>
              label="단계"
              value={stage}
              onChange={setStage}
              options={[{ id: 'open', label: '진행 중' }, { id: 'detect', label: '감지' }, { id: 'diagnose', label: '진단' }, { id: 'plan', label: '실행안' }, { id: 'test', label: '테스트' }, { id: 'wrapup', label: '랩업' }, { id: 'all', label: '전체' }]}
            />
          </div>
        </div>
        {list.length === 0 ? <Empty title="조건에 맞는 이벤트가 없습니다">필터를 바꾸거나 전체를 선택하세요.</Empty> : (
          <div className="stack">
            {list.map((e) => <EventRow key={e.id} e={e} w={w} onOpen={onOpen} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

export function EventRow({ e, w, onOpen }: { e: EvaluatedEvent; w: WatchCtx; onOpen: (id: string) => void }) {
  const done = e.closed || e.stage === 'wrapup';
  const alerts = done ? [] : linkedIncidents(e, w.state.incidents, w.state.data);
  return (
    <article className={`watch-ev ${done ? 'done' : ''} v-${e.diag.verdict}`}>
      <span className="watch-ev-stripe" aria-hidden />
      <div className="watch-ev-main">
        <div className="row" style={{ gap: 8 }}>
          <MediaTag media={e.media} />
          <Pill tone="outline">{KIND_LABEL[e.kind]}</Pill>
          <Pill tone={e.origin === 'signal' ? 'dark' : 'neutral'} icon={e.origin === 'signal' ? 'zap' : 'bell'}>{e.origin === 'signal' ? '데이터 감지' : '매체 공지'}</Pill>
          {e.scenario ? <Pill tone="accent" icon="flow">p.23 시나리오 D+0</Pill> : null}
          <span className="xs muted">감지 {fmtKst(kstMs(e.detectedAt))} · {e.source}</span>
        </div>
        <button type="button" className="watch-ev-title" onClick={() => onOpen(e.id)}>{e.title}</button>
        <PipelineSteps stage={e.stage} closed={e.closed} />
        <VerdictBadge diag={e.diag} compact />
        {(e.stage === 'test' || e.stage === 'wrapup') && e.judge.verdict !== 'pending' ? (
          <TestBadge judge={e.judge} compact prefix={e.stage === 'wrapup' ? '랩업 판정' : '소액 테스트'} />
        ) : null}
        <div className="row xs ink2" style={{ gap: 10 }}>
          <span>영향 범위 · {e.diag.affected.scope}: 광고비 일 {fmt.krw(e.diag.affected.spendPerDay)}원 · 매출 일 {fmt.krw(e.diag.affected.revenuePerDay)}원</span>
          <Chips items={e.keywords.length ? e.keywords : e.campaigns} />
        </div>
        <div className="small"><span className="muted xs">실행안 </span>{e.plan}</div>
      </div>
      <div className="watch-ev-side">
        <DueTag due={e.due} />
        {e.next.action ? (
          <Button size="sm" variant={e.next.action === 'test' ? 'primary' : 'default'} icon={e.next.action === 'test' ? 'lab' : e.next.action === 'wrapup' ? 'check' : 'chevron'} disabled={!!e.next.disabled} title={e.next.disabled} onClick={() => w.advance(e, e.next.action!)}>
            {e.next.label}
          </Button>
        ) : <Pill tone={e.closed ? 'outline' : 'good'} icon="check">{e.next.label}</Pill>}
        {e.next.disabled ? <span className="xs muted watch-clip2" style={{ textAlign: 'right' }}>{e.next.disabled}</span> : null}
        {alerts.length ? (
          <a className="xs watch-alert-link" href="#alert" title={alerts.map((i) => `${i.severity} ${i.title}`).join('\n')}>
            <Sev level={alerts[0].severity} /> MILDO Alert 연결 {alerts.length}건
          </a>
        ) : null}
        {e.testChange ? <a className="xs" href="#flow">Lab 요청 {CHANGE_STATUS_LABEL[e.testChange.status] ?? e.testChange.status} · MILDO Flow</a> : e.testRejected ? <span className="xs muted">Lab 요청 {CHANGE_STATUS_LABEL[e.testRejected.status] ?? e.testRejected.status} · 재등록 가능</span> : null}
        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
          {e.next.canClose ? <Button size="sm" variant="ghost" onClick={() => w.close(e)}>관찰 종료</Button> : null}
          <Button size="sm" variant="ghost" icon="external" onClick={() => onOpen(e.id)}>상세</Button>
        </div>
      </div>
    </article>
  );
}

export { mediaLabel };
