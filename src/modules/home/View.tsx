import { useEffect, useMemo, useRef, useState } from 'react';
import { useActions, useStore } from '@/core/store';
import { navigate } from '@/core/router';
import { AI_ENGINES, AD_PILOT, LIVE_DEMO, OS_SCENARIO, RFP, SA_CAMPAIGNS, SKU_EXPANSION } from '@/data/constants';
import { dailySeries, rangeOf } from '@/core/selectors';
import { fmt, fmtDate, metrics, sum } from '@/core/util';
import { generateBidProposals } from '@/modules/adpilot/engine';
import { Button, Card, Pill, PageHeader, ProgressBar, Sev, Src, Stat } from '@/ui/primitives';
import { Sparkline } from '@/ui/charts';
import { Icon } from '@/ui/Icon';
import { AiInsight } from '@/ui/AiInsight';
import { ddayLabel, rfpSchedule } from '@/modules/ops/engine';
import { hhmmOf, homeTimetable, morningBrief, operatingSummary, scenarioBudget, scenarioPending, scenarioRequests, SCENARIO_BUDGET_PCT } from './engine';
import './styles.css';

const OS_MODULES = [
  { id: 'board', label: 'Board', kind: '대시보드 · 리포팅', group: '02 자동화', items: ['매체 통합 성과 · 실매출', '자동 리포트 · 데이터 시간표'], route: 'board' },
  { id: 'watch', label: 'Watch', kind: '감지 · 아카이빙', group: '03 모니터링', items: ['매체 변동 · 신규 상품 감지', '지면 · 경쟁사 · 외부 변수 수집'], route: 'watch', hot: true },
  { id: 'lab', label: 'Lab', kind: '테스트 관리', group: '03 테스트', items: ['키워드 · 소재 · 랜딩 테스트', '판정 기준 · 랩업 이력'], route: 'lab', hot: true },
  { id: 'alert', label: 'Alert', kind: '이슈 알림', group: '05 안정성', items: ['24시간 이상 감지', '긴급 검수 · 원인 요약'], route: 'alert' },
  { id: 'flow', label: 'Flow', kind: '협업 · 승인', group: '04 매출 성장', items: ['요청 · 승인 · 변경 이력', '프로모션별 리포트'], route: 'flow' },
];

export default function View() {
  const { state } = useStore();
  const d = state.data;
  const proposals = useMemo(() => generateBidProposals(d), [d]);
  const s = useMemo(() => operatingSummary(d, state.incidents, state.changes), [d, state.incidents, state.changes]);
  const tt = useMemo(() => homeTimetable(d, { offHours: state.offHoursMode, incidents: state.incidents, changes: state.changes }), [d, state.offHoursMode, state.incidents, state.changes]);
  const slots = tt.items;
  const r30 = rangeOf(d, 'last30');
  const spark = (field: 'cost' | 'revenue' | 'roas' | 'cpa') => dailySeries(d, r30.from, r30.to, field).map((p) => p.value);
  const salesSpark = d.dates.filter((x) => x >= r30.from && x <= r30.to).map((date) => sum(d.salesDaily.filter((r) => r.date === date), (r) => r.revenue));
  const y = s.h.yesterday;
  const c = s.cov;
  // 광고비가 0이거나 데이터가 없으면 배수를 내지 않는다 ('0.0배'라고 하지 않게)
  const merY = c.salesYesterday && y.cost > 0 ? s.h.salesYesterday / y.cost : NaN;
  const merP = c.salesDayBefore && s.h.dayBefore.cost > 0 ? s.h.salesDayBefore / s.h.dayBefore.cost : NaN;
  const vsDay = (has: boolean, prev: boolean) => <span className="muted">{!has ? '데이터 없음' : !prev ? '전날 데이터 없음' : '전날 대비'}</span>;
  // 제출 마감 D-day는 전담 TF · RFP 커버리지 화면과 같은 계산(달력일 기준)을 써서 화면 간 숫자를 맞춘다
  const deadline = rfpSchedule(d.today, d.currentHour).deadline;

  return (
    <div className="page">
      <PageHeader
        eyebrow="COMMAND CENTER · 수면밀도 전용 운영 프로그램"
        title="오늘의 운영"
        sub="MILDO OS가 밤사이 수집 · 검증한 데이터와 감지된 이슈, 승인 대기 중인 조정안을 한 화면에 모았습니다. 반복 업무는 시스템이, 판단과 승인은 사람이 맡습니다."
        sources={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.3–5 · p.22" /><span className="xs muted">기준 {fmtDate(d.today)} {String(d.currentHour).padStart(2, '0')}:30 · {s.off.off ? `${s.off.label} — 주말 · 공휴일 체계` : '평일 체계'}</span></>}
        actions={<Button variant="accent" icon="play" onClick={() => { navigate('board'); }}>MILDO Board 열기</Button>}
      />

      <section className="grid g-5 home-kpis" aria-label="어제 핵심 지표">
        <Card><Stat label="어제 광고비" value={c.mediaYesterday ? fmt.krw(y.cost) : '—'} delta={s.costDelta} invert foot={vsDay(c.mediaYesterday, c.mediaDayBefore)} spark={<Sparkline values={spark('cost')} ariaLabel="최근 30일 광고비" />} /></Card>
        <Card><Stat label="광고 ROAS" value={c.mediaYesterday ? fmt.roas(y.roas) : '—'} delta={s.roasDelta} foot={<span className="muted">{c.mediaYesterday ? `매출 ${fmt.krw(y.revenue)}` : '데이터 없음'}</span>} spark={<Sparkline values={spark('roas')} colorVar="--series-3" ariaLabel="최근 30일 ROAS" />} /></Card>
        <Card><Stat label="판매 채널 실매출" value={c.salesYesterday ? fmt.krw(s.h.salesYesterday) : '—'} delta={s.salesDelta}
          foot={<span className="muted">{c.salesYesterday ? `광고비 대비 ${Number.isFinite(merY) ? `${merY.toFixed(1)}배` : '—'} (전날 ${Number.isFinite(merP) ? `${merP.toFixed(1)}배` : '—'})` : '데이터 없음'}</span>} spark={<Sparkline values={salesSpark} colorVar="--series-7" ariaLabel="최근 30일 실매출" />} /></Card>
        <Card><Stat label="CPA (최근 7일)" value={c.media7 ? fmt.won(s.h.last7.cpa) : '—'} delta={s.cpa7Delta} invert foot={<span className="muted">{!c.media7 ? '데이터 없음' : !c.mediaPrev7 ? '직전 7일 데이터 없음' : '직전 7일 대비'}</span>} spark={<Sparkline values={spark('cpa')} colorVar="--series-2" ariaLabel="최근 30일 CPA" />} /></Card>
        <Card><Stat label="신규 고객 CAC (7일)" value={c.media7 ? fmt.won(s.h.last7.cac) : '—'} delta={s.cac7Delta} invert foot={<><span className="muted">{c.media7 ? `신규 ${fmt.int(s.h.last7.newCustomers)}명` : '데이터 없음'}</span><Src kind="DEMO" /></>} /></Card>
      </section>
      {c.none ? <div className="xs muted home-kpi-note">연결된 데이터 출처가 없습니다 — 07 관리 · 연동 → 데이터 연결에서 매체 · 판매 채널 API를 연결하거나 CSV를 올리세요.</div> : null}
      {c.notes.map((n) => <div key={n} className="xs ink2 home-kpi-note">{n}</div>)}

      <section className="grid g-3">
        <Card title="지금 처리할 것" sub="등급 · SLA 순으로 정렬" className="span-2" actions={<Src kind="PROPOSAL" page="p.44 · p.49" />}>
          <div className="stack">
            {s.open.length === 0 && proposals.length === 0 && s.pending.length === 0 ? <div className="small muted">처리할 항목이 없습니다.</div> : null}
            {[...s.p1, ...s.p2, ...s.p3].slice(0, 5).map((i) => (
              <a key={i.id} href="#alert" className="row-between" style={{ textDecoration: 'none', color: 'inherit', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 10 }}>
                <span className="row" style={{ gap: 8 }}>
                  <Sev level={i.severity} />
                  <strong className="small">{i.title}</strong>
                  {i.deltaPct !== undefined && Number.isFinite(i.deltaPct) ? <span className="xs muted num">기준 대비 {fmt.delta(i.deltaPct, 0)}</span> : null}
                </span>
                <span className="row xs muted" style={{ gap: 6 }}>
                  {i.isTest ? <Src kind="DEMO" /> : null}
                  <span>{i.status === 'open' ? '미인지' : i.status === 'ack' ? '인지' : i.status === 'action' ? '조치 중' : '해결'}</span>
                  <Icon name="chevron" size={14} />
                </span>
              </a>
            ))}
            <div className="grid g-3" style={{ gap: 10 }}>
              <a href="#adpilot" className="card flat" style={{ textDecoration: 'none', color: 'inherit', padding: 12 }}>
                <span className="xs muted">AD Pilot 조정 후보</span>
                <strong style={{ fontSize: 'var(--fs-xl)' }} className="num">{proposals.length}건</strong>
                <span className="xs muted">입찰 상향 {proposals.filter((p) => p.action === 'bid_up').length} · 하향 {proposals.filter((p) => p.action === 'bid_down').length} · 보류 {proposals.filter((p) => p.action === 'hold').length}</span>
              </a>
              <a href="#flow" className="card flat" style={{ textDecoration: 'none', color: 'inherit', padding: 12 }}>
                <span className="xs muted">승인 대기 (MILDO Flow)</span>
                <strong style={{ fontSize: 'var(--fs-xl)' }} className="num">{s.pending.length}건</strong>
                <span className="xs muted">현재 역할: {state.role}</span>
              </a>
              <a href="#board" className="card flat" style={{ textDecoration: 'none', color: 'inherit', padding: 12 }}>
                <span className="xs muted">일 예산 조기 소진 예상</span>
                <strong style={{ fontSize: 'var(--fs-xl)' }} className="num">{s.early.length}개 캠페인</strong>
                <span className="xs muted">{s.early.slice(0, 2).map((c) => `${c.name} ${hhmmOf(c.exhaustHour)}`).join(' · ') || '없음'}</span>
              </a>
            </div>
          </div>
        </Card>

        <Card title="데이터 제공 시간표" sub={tt.off ? `수면밀도 업무시간 08–17시 맞춤 · ${tt.offLabel} — 주말 · 공휴일 규칙` : '수면밀도 업무시간 08–17시 맞춤'} actions={<Src kind="PROPOSAL" page="p.18" />}>
          <ol className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {slots.map((t) => (
              <li key={t.time} className="row" style={{ gap: 10, flexWrap: 'nowrap', opacity: t.state === 'next' ? 0.7 : 1 }} title={t.offNote}>
                <span className="num small bold" style={{ width: 44 }}>{t.time}</span>
                <span style={{ width: 18, display: 'inline-flex', color: t.state === 'done' ? 'var(--good-ink)' : t.state === 'now' ? 'var(--accent-ink)' : 'var(--muted)' }}>
                  <Icon name={t.state === 'done' ? 'check' : 'clock'} size={15} stroke={2.2} />
                </span>
                <span className="small" style={{ flex: 1 }}>{t.title}</span>
                <span className="xs muted nowrap">{t.label}</span>
              </li>
            ))}
          </ol>
          <a href="#reports" className="small">리포트 · 시간표 열기 →</a>
        </Card>
      </section>

      <MildoOsMap />

      <ScenarioPlayer />

      <AiInsight
        title="오늘의 운영 브리프"
        sub="확정 팩트 · 반복 관측 패턴 · AI 해석을 나눠 정리"
        cta="브리프 생성"
        buildPrompt={() => {
          const b = morningBrief(d, state.incidents, state.changes, proposals.length);
          return `과제: 수면밀도 퍼포먼스 운영의 '오늘의 운영 브리프'를 작성하라. 우선순위(무엇을 먼저 처리할지)와 판단 기준을 포함하라.\n\n데이터(시연용 테스트 데이터):\n${[...b.facts, ...b.patterns].join('\n')}\n\n열린 이슈:\n${s.open.map((i) => `${i.severity} ${i.title} (${i.metric ?? ''} 관측 ${i.observed ?? ''} 기준 ${i.baseline ?? ''})`).join('\n') || '없음'}\n\nAD Pilot 후보 상위:\n${proposals.slice(0, 6).map((p) => `${p.keyword}: ${p.rule} → ${p.action} ${p.before}→${p.after} (${p.reason})`).join('\n') || '없음'}`;
        }}
        fallback={() => morningBrief(d, state.incidents, state.changes, proposals.length)}
      />
      <section className="grid g-2">
        <Card title="라이브 데모 15분" sub="제안서 부록 p.60 시나리오 · 화면마다 TEST DATA 표기" tone="dark" actions={<Pill tone="accent">PT 11/19–20</Pill>}>
          <div className="stack-sm">
            {LIVE_DEMO.map((seg) => (
              <a key={seg.title} href={`#${seg.route}`} className="home-demo-seg">
                <span className="num xs t">{seg.from}–{seg.to}</span>
                <span className="small bold">{seg.title}</span>
                <span className="xs d">{seg.detail}</span>
              </a>
            ))}
          </div>
          <div className="row">
            <StartDemoButton />
            <span className="xs" style={{ color: 'var(--panel-muted)' }}>상단 바에서 구간 이동 · 일시정지</span>
          </div>
        </Card>
        <Card title="RFP 대응 현황" sub={`제안서 제출 마감 11/16(월) 17시 · ${deadline.passed ? '마감' : ddayLabel(deadline.days)}`} actions={<Src kind="RFP" />}>
          <div className="stack-sm">
            {RFP.evaluation.map((e) => (
              <div key={e.id} className="home-rfp-row">
                <span className="small">{e.label}</span>
                <div><ProgressBar value={e.weight} max={25} tone={e.weight >= 20 ? 'accent' : 'ink'} label={`${e.label} 비중`} /></div>
                <span className="num small bold" style={{ textAlign: 'right' }}>{e.weight}%</span>
              </div>
            ))}
          </div>
          <div className="xs muted">우선 협상 대상자는 리소스 절감 자동화 · 운영 안정성 점수가 우선, 동점 시 수수료 조건 종합 고려 (RFP).</div>
          <a href="#ops" className="small">RFP 커버리지 맵 →</a>
        </Card>
      </section>

      <Card title="AI 엔진 · 보유" sub="MILDO OS는 이미 운영 중인 자체 AI 엔진 5종 위에 구축됩니다" actions={<Src kind="PROPOSAL" page="p.9" />}>
        <div className="grid g-5">
          {AI_ENGINES.map((e) => (
            <div key={e.id} className="stack-sm" style={{ borderTop: '2px solid var(--ink)', paddingTop: 10 }}>
              <strong>{e.name}</strong>
              <span className="xs accent">{e.kind}</span>
              <span className="small ink2">{e.apply}</span>
              <span className="xs muted">검증 지표 · {e.metric}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function StartDemoButton() {
  const { dispatch } = useStore();
  return <Button variant="accent" icon="play" onClick={() => { dispatch({ type: 'demo/start' }); navigate('board'); }}>15분 데모 시작</Button>;
}

function MildoOsMap() {
  return (
    <Card title="MILDO OS · 수면밀도 전용 운영 프로그램" sub="대시보드부터 모니터링 · 테스트 · 알림 · 협업까지 한 곳에서 운영합니다" actions={<Src kind="PROPOSAL" page="p.22" />}>
      <div className="grid g-5">
        {OS_MODULES.map((m) => (
          <a key={m.id} href={`#${m.route}`} className={`card${m.hot ? ' accent' : ''}`} style={{ textDecoration: 'none', color: m.hot ? '#fff' : 'inherit', gap: 6 }}>
            <span className="xs bold" style={{ color: m.hot ? '#fff' : 'var(--accent-ink)' }}>{m.group}</span>
            <strong style={{ fontSize: 'var(--fs-2xl)', fontWeight: 900 }}>{m.label}</strong>
            <span className="small bold">{m.kind}</span>
            <hr className="divider" style={{ background: m.hot ? 'rgba(255,255,255,.5)' : undefined }} />
            {m.items.map((it) => <span key={it} className="small">{it}</span>)}
          </a>
        ))}
      </div>
      <div className="card dark" style={{ padding: '10px 16px', flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span className="small bold accent" style={{ color: 'var(--accent)' }}>AI 엔진 · 보유</span>
        <span className="small bold">Pro-board · AD Pilot · GFA Control v1 · VisualTune OS · SearchTuneOS</span>
      </div>
      <div className="grid g-3">
        <div className="small"><strong>전담 개발자 상주</strong><div className="muted xs">TF 안에서 직접 개발 · 수정</div></div>
        <div className="small"><strong>2주 단위 개선</strong><div className="muted xs">수면밀도 피드백 즉시 반영</div></div>
        <div className="small"><strong>단계별 가동</strong><div className="muted xs">D+30 Board → D+60 Watch · Alert → D+90 Lab · Flow</div></div>
      </div>
    </Card>
  );
}

/** 제안서 p.23 작동 시나리오 — '신혼 매트리스' 수요 증가 시 데이터 → 분석 → 실행 → 승인 → 측정 */
function ScenarioPlayer() {
  const { state } = useStore();
  const actions = useActions();
  const d = state.data;
  const [step, setStep] = useState(-1);
  // 시나리오 요청이 승인 대기 중이면 다시 만들지 않는다 (화면을 떠났다 돌아와도 같은 판단)
  const created = scenarioPending(state.changes);
  const creating = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const outputs = useMemo(() => {
    const life = d.keywords.filter((k) => k.intent === 'life');
    const sinhon = life.filter((k) => k.text.includes('신혼'));
    const cur = sum(sinhon, (k) => k.last14.clicks);
    const prev = sum(sinhon, (k) => k.prev14.clicks);
    const terms = d.searchTerms.filter((t) => t.term.includes('신혼'));
    const lifeCpc = metrics.cpc(sum(life, (k) => k.last14.cost), sum(life, (k) => k.last14.clicks));
    const candidates = SKU_EXPANSION.criteria.map((c) => `신혼 매트리스 ${c.split(' · ')[0]}`).concat(['신혼집 매트리스 사이즈']);
    const gfa = d.campaigns.find((c) => c.name.includes('쇼핑 고객 확장'));
    const pct = SCENARIO_BUDGET_PCT;
    const budget = scenarioBudget(gfa?.dailyBudget ?? 0, pct);
    const up = cur > prev;
    return [
      `'신혼' 포함 키워드 클릭 최근 14일 ${fmt.int(cur)} (직전 14일 ${fmt.int(prev)}, ${fmt.delta(metrics.pctChange(cur, prev))}) · 검색어 보고서 신혼 관련 ${terms.length}건.${up ? '' : ' 현재 테스트 데이터는 증가 신호가 아니므로 이후 단계는 수요 증가를 가정한 진행입니다.'}`,
      `확장 후보 ${candidates.length}개: ${candidates.join(' · ')}. 테스트 그룹 입찰 시작가 ${fmt.won(Math.round(lifeCpc / 10) * 10)} (생활 상황 캠페인 평균 CPC), 상한 ${fmt.won(Math.round((lifeCpc * 1.3) / 10) * 10)}.`,
      `생활 상황 캠페인 랜딩(기획전 · 자사몰) 진단: 제목에 '신혼' 의도 포함 여부, 사이즈 FAQ · Product 구조화 데이터 점검 항목 3개.`,
      `메시지 후보: "${SA_CAMPAIGNS.life.message}" · "신혼집 사이즈별 매트리스 비교" · "신혼 매트리스, 경도부터 고르세요" (검수 통과 문안만 사용).`,
      `${gfa?.name ?? 'GFA_쇼핑 고객 확장'} 일 예산 +${budget.changePct}% (${fmt.won(budget.before)} → ${fmt.won(budget.after)}) 변경안 → 위임 범위상 ${budget.approverLabel} 승인.`,
      `테스트 카드: 14일 또는 최소 클릭 100 도달 시 판정. 목표 ROAS ${AD_PILOT.targetRoas}% 대비 100% 이상 확장 · 70~100% 유지 · 70% 미만 제외. 2주 후 랩업.`,
    ];
  }, [d]);

  const play = () => {
    if (timer.current) clearInterval(timer.current);
    setStep(0);
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      if (i >= OS_SCENARIO.length) { if (timer.current) clearInterval(timer.current); return; }
      setStep(i);
    }, 1100);
  };

  const createRequests = () => {
    if (created || creating.current) return;
    creating.current = true;
    const reqs = scenarioRequests(d);
    reqs.forEach((r) => actions.addChange(r));
    actions.toast({ tone: 'good', title: `승인 요청 ${reqs.length}건을 만들었습니다`, body: 'MILDO Flow에서 승인 · 반영 이력을 확인하세요.', route: 'flow' });
  };
  useEffect(() => {
    if (!created) creating.current = false;
  }, [created]);

  return (
    <Card title="MILDO OS 작동 시나리오" sub="'신혼 매트리스' 검색 수요가 늘어날 때 데이터 → 분석 → 실행 → 승인 → 측정" tone="dark"
      actions={<><Pill tone="accent">가상 시나리오 · 실제 성과 데이터 아님</Pill><Button size="sm" variant="accent" icon="play" onClick={play}>{step < 0 ? '시나리오 실행' : '다시 실행'}</Button></>}>
      <div className="grid g-6" style={{ gap: 10 }}>
        {OS_SCENARIO.map((sc, i) => {
          const active = i <= step;
          const last = i === OS_SCENARIO.length - 1;
          return (
            <div key={sc.engine + i} className="stack-sm home-scn-step" style={{ background: last && active ? 'var(--accent)' : 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 12, opacity: step < 0 || active ? 1 : 0.4, transition: 'opacity .3s' }}>
              <span style={{ color: last && active ? '#fff' : 'var(--accent)', fontSize: 22, fontWeight: 300 }}>{String(i + 1).padStart(2, '0')}</span>
              <strong className="small">{sc.engine}</strong>
              <span className="xs" style={{ color: last && active ? '#fff' : 'var(--panel-muted)' }}>{sc.action}</span>
              {active ? <span className="xs" style={{ color: '#fff', borderTop: '1px solid rgba(255,255,255,.18)', paddingTop: 6 }}>{outputs[i]}</span> : null}
              <span className="xs bold" style={{ marginTop: 'auto' }}>{sc.day}</span>
            </div>
          );
        })}
      </div>
      {step >= OS_SCENARIO.length - 1 ? (
        <div className="row">
          <Button size="sm" variant="accent" icon="check" disabled={created} onClick={createRequests}>{created ? '승인 요청 생성됨' : '이 시나리오로 승인 요청 만들기'}</Button>
          <span className="xs" style={{ color: 'var(--panel-muted)' }}>키워드 테스트 등록(담당 AE) · GFA 예산 변경(PM)이 MILDO Flow 승인 대기로 들어갑니다.</span>
        </div>
      ) : null}
    </Card>
  );
}
