/**
 * MILDO Lab — 롱테일 · 구문형 키워드 발굴 → 테스트 → 판정, VisualTune OS 소재 테스트, 검수 에이전트
 * 제안서 p.26–28 · p.36 (+ p.23 작동 시나리오). 성과 수치는 모두 시연용 TEST DATA.
 * 판정 · 탐지는 engine.ts가 데이터로 계산하고, 상태를 바꾸는 동작은 모두 ChangeRequest(pending)로 남긴다.
 */
import { useMemo, useState, type ReactNode } from 'react';
import './styles.css';
import { OS_SCENARIO } from '@/data/constants';
import { fmtDate } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { Icon } from '@/ui/Icon';
import { Button, Card, PageHeader, Pill, Src, Tabs } from '@/ui/primitives';
import { CARD_VERDICT_META, labBrief, labOverview, labPrompt, type LabTabId, type LabTodo } from './engine';
import { resetLab } from './store';
import { useLabModel } from './parts';
import { DiscoverTab } from './DiscoverTab';
import { PipelineTab } from './PipelineTab';
import { CardsTab, type CardDraft } from './CardsTab';
import { CreativeTab } from './CreativeTab';
import { ReviewTab } from './ReviewTab';
import { LoopTab } from './LoopTab';

const ROLE_SCOPE: Record<string, string> = { '담당 AE': '담당 AE 승인 건', PM: '담당 AE · PM 승인 건', 수면밀도: '전체 승인 건' };
const TODO_ICON: Record<LabTodo['tone'], string> = { critical: 'alert', warning: 'clock', accent: 'send', neutral: 'inbox' };

export default function View() {
  const m = useLabModel();
  const { d, state, crit, cards, lab, patterns } = m;
  const [tab, setTab] = useState<LabTabId>('discover');
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const ov = useMemo(
    () => labOverview(d, state.changes, crit, cards, lab.decisions, { aiCandidates: lab.aiCandidates, aiCopies: lab.aiCopies, role: state.role }),
    [d, state.changes, crit, cards, lab.decisions, lab.aiCandidates, lab.aiCopies, state.role],
  );
  const t = ov.tiles;
  const makeCard = (dr: CardDraft) => {
    setDraft({ ...dr });
    setTab('cards');
  };

  return (
    <div className="page lab-page">
      <PageHeader
        eyebrow="03 MONITORING & TEST · MILDO LAB · VISUALTUNE OS"
        title="MILDO Lab"
        sub="검색어 보고서 · 연관 검색어 · AI 검색 질의와 SKU 확장 48 진입점에서 구문형 후보를 찾고, 테스트 전용 그룹에서 같은 기준으로 판정해 매주 넓힙니다. 소재는 VisualTune OS 가설 A · B · C를 한 번에 한 변수씩 비교하고, 모든 문안은 검수 에이전트를 통과해야 집행됩니다."
        sources={
          <>
            <Src kind="PROPOSAL" page="p.26–28 · p.36" />
            <Src kind="DEMO" />
            <span className="xs muted">데이터 기준 {fmtDate(d.today)} {String(d.currentHour).padStart(2, '0')}:30 · 판정 기준 목표 ROAS {crit.targetRoas}% (초기값 · 온보딩 중 확정)</span>
          </>
        }
        actions={
          <>
            <Pill tone="outline" icon="users" title="승인 버튼은 요청의 승인 주체와 현재 역할로 활성화됩니다">{state.role} · {ROLE_SCOPE[state.role] ?? '승인 권한 확인'}</Pill>
            {confirmReset ? (
              <>
                <Button size="sm" variant="danger" icon="refresh" onClick={() => { resetLab(); setConfirmReset(false); setDraft(null); }}>Lab 기록 초기화 확정</Button>
                <Button size="sm" onClick={() => setConfirmReset(false)}>취소</Button>
              </>
            ) : (
              <Button size="sm" icon="refresh" title="판정 기준값 · 사용자 카드 · 결정 · 랩업 · AI 결과를 초기화 (승인 이력은 MILDO Flow에 유지)" onClick={() => setConfirmReset(true)}>Lab 기록 초기화</Button>
            )}
          </>
        }
      />
      {confirmReset ? <div className="xs muted no-print">초기화 대상: 판정 기준값 · 사용자 테스트 카드 · 카드 결정 · 랩업 · 라이브러리 추가분 · AI 후보 · AI 문안. 요청 · 승인 이력(ChangeRequest)은 MILDO Flow에 그대로 남습니다.</div> : null}

      <div className="lab-summary">
        <Tile active={tab === 'discover'} onClick={() => setTab('discover')} label="발굴 후보 · 미등록" src={<Src kind="DEMO" />}
          value={t.discover.fresh} unit="개"
          foot={<>우선 {t.discover.priority} · 검색어 보고서 {t.discover.searchTerm}개 중 목표 ROAS {crit.targetRoas}% 대비 {crit.expandAtPct}% 이상 {t.discover.searchTermHigh}</>}
          sub={<>SKU 확장 {t.discover.sku48}개 진입점 · 랜딩 매칭 {t.discover.skuGood}</>} />
        <Tile active={tab === 'pipeline'} onClick={() => setTab('pipeline')} label="테스트 파이프라인" src={<Src kind="DEMO" />}
          value={t.pipeline.total} unit="건"
          foot={<>STEP 1 {t.pipeline.byStep[1]} · 2 {t.pipeline.byStep[2]} · 3 {t.pipeline.byStep[3]} · 4 {t.pipeline.byStep[4]}</>}
          sub={<>판정 대기 {t.pipeline.awaiting} · 기한 경과 {t.pipeline.overdue} (기준 {crit.minDays}일)</>} hot={t.pipeline.awaiting > 0} />
        <Tile active={tab === 'cards'} onClick={() => setTab('cards')} label="테스트 카드" src={<Src kind="DEMO" />}
          value={t.cards.total} unit="개"
          foot={<>{(['expand', 'stop', 'running', 'monitor', 'insufficient', 'planned'] as const).filter((v) => t.cards.byVerdict[v]).map((v) => `${CARD_VERDICT_META[v].label} ${t.cards.byVerdict[v]}`).join(' · ') || '진행 카드 없음'}</>}
          sub={<>결정 {t.cards.decided} · 수신 요청 {ov.incoming.length} · z-검정 α 0.05</>} hot={!!t.cards.byVerdict.stop && t.cards.decided < t.cards.total} />
        <Tile active={tab === 'review'} onClick={() => setTab('review')} label="검수 · 차단 문안" src={<Src kind="PROPOSAL" page="p.27" />}
          value={t.review.block} unit={`/ ${t.review.total}건`}
          foot={<>경고 {t.review.warn} · 확인 {t.review.check} · 통과 {t.review.pass}</>}
          sub={<>의료 효능 · 가격 불일치는 차단 기준</>} hot={t.review.block > 0} />
        <Tile active={tab === 'loop'} onClick={() => setTab('loop')} label="다음 주간 브리프" src={<Src kind="PROPOSAL" page="p.28" />}
          value={t.loop.weekly ? fmtDate(t.loop.weekly.date) : '—'}
          foot={<>{t.loop.testEnd ? `테스트 종료 ${fmtDate(t.loop.testEnd.date)}${t.loop.testEnd.ref ? ` · ${t.loop.testEnd.ref}` : ''}` : '예정 테스트 종료 없음'}</>}
          sub={<>{t.loop.monthly ? `월간 리뷰 ${fmtDate(t.loop.monthly.date)} (익월 3영업일)` : '월간 리뷰 범위 밖'}</>} />
      </div>

      <div className="grid g-3">
        <Card className="span-2" title={`오늘 처리할 항목 · ${ov.todos.length}건`} sub="엔진이 데이터 기준일의 판정 · 검수 · 일정에서 뽑은 항목입니다. 각 항목 옆에 판정 기준과 근거 수치를 표기합니다."
          actions={<><Src kind="DEMO" /><Pill tone="outline">승인 대기 {ov.labPending.length} · 내 승인 {ov.mine.length}</Pill></>}>
          {ov.todos.length ? (
            <div className="lab-todo">
              {ov.todos.map((x) => (
                <div key={x.id} className={`lab-todo-item t-${x.tone}`}>
                  <Pill tone={x.tone === 'neutral' ? 'neutral' : x.tone} icon={TODO_ICON[x.tone]}>{x.label}</Pill>
                  <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
                    <strong className="small">{x.title}</strong>
                    <span className="lab-basis">{x.basis}</span>
                  </div>
                  <Button size="sm" onClick={() => setTab(x.tab)}>열기</Button>
                </div>
              ))}
            </div>
          ) : (
            <span className="small muted">처리할 항목이 없습니다. 판정 · 검수 · 일정 모두 기준 안에 있습니다.</span>
          )}
        </Card>
        <Card tone="dark" title="작동 흐름에서 Lab의 위치" sub="MILDO OS 작동 시나리오 · 가상 시나리오이며 실제 성과 데이터 아님" actions={<Src kind="PROPOSAL" page="p.23" />}>
          <div className="lab-flow">
            {OS_SCENARIO.map((s, i) => (
              <a key={i} href={`#${s.route}`} className={`lab-flow-row${s.route === 'lab' ? ' on' : ''}`}>
                <span className="lab-flow-day">{s.day}</span>
                <span className="stack-sm" style={{ gap: 0, minWidth: 0 }}>
                  <strong className="small">{s.engine}</strong>
                  <span className="lab-sub">{s.action}</span>
                </span>
                {s.route !== 'lab' ? <Icon name="chevron" size={14} /> : <span className="lab-sub">이 화면</span>}
              </a>
            ))}
          </div>
          <span className="lab-sub">Watch가 감지한 변화 · AD Pilot이 찾은 미등록 전환 구문이 Lab 테스트 그룹으로 들어오고, 판정 결과는 승인 후 AD Pilot 본 그룹 · GFA Control로 반영됩니다.</span>
        </Card>
      </div>

      <Tabs<LabTabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'discover', label: '발굴 · 48 진입점', badge: <Pill tone="neutral">{t.discover.fresh}</Pill> },
          { id: 'pipeline', label: '테스트 파이프라인', badge: t.pipeline.awaiting ? <Pill tone="accent">{t.pipeline.awaiting}</Pill> : undefined },
          { id: 'cards', label: '테스트 카드', badge: <Pill tone={t.cards.byVerdict.stop ? 'critical' : 'neutral'}>{t.cards.total}</Pill> },
          { id: 'creative', label: 'VisualTune 소재' },
          { id: 'review', label: '검수 에이전트', badge: t.review.block ? <Pill tone="critical">{t.review.block}</Pill> : undefined },
          { id: 'loop', label: '운영 루프' },
        ]}
      />
      {tab === 'discover' ? <DiscoverTab m={m} /> : null}
      {tab === 'pipeline' ? <PipelineTab m={m} /> : null}
      {tab === 'cards' ? <CardsTab m={m} draft={draft} onMakeCard={makeCard} onDraftUsed={() => setDraft(null)} /> : null}
      {tab === 'creative' ? <CreativeTab m={m} onMakeCard={makeCard} onOpenCards={() => setTab('cards')} /> : null}
      {tab === 'review' ? <ReviewTab m={m} /> : null}
      {tab === 'loop' ? <LoopTab m={m} /> : null}

      <AiInsight
        title="Lab 운영 해석"
        sub="파이프라인 판정 · 발굴 후보 · 테스트 카드를 읽고 이번 주 판정과 다음 테스트 우선순위를 확정 팩트 / 반복 관측 패턴 / AI 해석으로 나눠 정리합니다"
        buildPrompt={() => labPrompt(d, state.changes, crit, cards)}
        fallback={() => labBrief(d, state.changes, crit, cards, patterns)}
      />
    </div>
  );
}

function Tile({ label, value, unit, foot, sub, src, active, hot, onClick }: {
  label: ReactNode; value: ReactNode; unit?: ReactNode; foot?: ReactNode; sub?: ReactNode; src?: ReactNode; active: boolean; hot?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`card lab-tile${hot ? ' hot' : ''}`} aria-pressed={active} onClick={onClick}>
      <span className="stat-label">{label}{src}</span>
      <span className="lab-tile-value num">{value}{unit ? <span className="lab-tile-unit">{unit}</span> : null}</span>
      {foot ? <span className="small ink2">{foot}</span> : null}
      {sub ? <span className="lab-sub">{sub}</span> : null}
    </button>
  );
}
