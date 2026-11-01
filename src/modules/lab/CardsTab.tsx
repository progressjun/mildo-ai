/* 테스트 카드 (p.28) — 가설 · 기간 · 지표 · 중단 · 확대 기준, 두 비율 z-검정 판정, 2주 후 랩업, 이긴 패턴 라이브러리 */
import { useEffect, useState } from 'react';
import type { IntentId } from '@/core/types';
import { INTENT_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { addDays, fmt, fmtDate } from '@/core/util';
import { LineChart } from '@/ui/charts';
import { Button, Callout, Card, type Column, DataTable, Field, NumberInput, Pill, ProgressBar, Segmented, Src } from '@/ui/primitives';
import { CARD_RULES } from './data';
import {
  CARD_VERDICT_META, cumulativeSeries, INCOMING_MEDIA, incomingTests, incomingToDraft, isOpenChange, nextBusinessDay, nextUserCardId, pText, REVIEW_LEVEL_META, reviewCopy, sg, validateCardInput, wrapupDue,
  type CardDecision, type CardJudgement, type CardVariable, type Pattern, type TestCard, type Wrapup,
} from './engine';
import { setLab } from './store';
import { CardVerdictPill, ChangeActions, ReviewPill, type LabModel } from './parts';

export interface CardDraft { title: string; hypothesis: string; variable: CardVariable; media: string; intent: IntentId | null; control: string; variant: string; primary: 'cvr' | 'ctr' }

const MEDIA_OPTS: string[] = ['네이버 SA', '네이버 GFA · Prospecting', '네이버 GFA · 리타겟팅', 'Meta · 넓은 타겟', 'Google · Demand Gen', '카카오 · 리마케팅', INCOMING_MEDIA.pilot];
const EMPTY_DRAFT: CardDraft = { title: '', hypothesis: '', variable: '랜딩', media: '네이버 SA', intent: 'problem', control: '', variant: '', primary: 'cvr' };

function NewCardForm({ m, draft, onDone }: { m: LabModel; draft: CardDraft | null; onDone: () => void }) {
  const { d, state, actions } = m;
  const [f, setF] = useState<CardDraft>(draft ?? EMPTY_DRAFT);
  const [start, setStart] = useState(addDays(d.today, 1));
  const [days, setDays] = useState<number>(CARD_RULES.days);
  const [sameTarget, setSameTarget] = useState(true);
  const [gap, setGap] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => { if (draft) setF(draft); }, [draft]);
  const isMsg = f.variable === '메시지';
  // 메시지 테스트는 두 안 모두 검수 (기존안도 집행 중 문안이라 같은 규칙 적용)
  const rv = isMsg && f.variant.trim() ? reviewCopy(f.variant, d) : null;
  const rc = isMsg && f.control.trim() ? reviewCopy(f.control, d) : null;
  const mediaOpts = MEDIA_OPTS.includes(f.media) ? MEDIA_OPTS : [...MEDIA_OPTS, f.media];
  const set = <K extends keyof CardDraft>(k: K, v: CardDraft[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = () => {
    const e = validateCardInput({ title: f.title, hypothesis: f.hypothesis, variable: f.variable, control: f.control, variant: f.variant, sameTarget, budgetGapPct: gap, start, today: d.today });
    if (rv && rv.level === 'block') e.push(`변형안 문안 검수 차단 — ${rv.findings.filter((x) => x.level === 'block').map((x) => x.match).join(' · ')} (수정안: ${rv.suggested})`);
    if (rc && rc.level === 'block') e.push(`기존안 문안 검수 차단 — ${rc.findings.filter((x) => x.level === 'block').map((x) => x.match).join(' · ')} (수정안: ${rc.suggested})`);
    if (!(days >= 7 && days <= 42)) e.push('기간은 7~42일 사이로 입력하세요 (기준 14일)');
    setErrors(e);
    if (e.length) return;
    const id = nextUserCardId(m.cards, state.changes);
    const card: TestCard = {
      id, title: f.title.trim(), hypothesis: f.hypothesis.trim(), variable: f.variable, media: f.media, intent: f.intent, control: f.control.trim(), variant: f.variant.trim(),
      copyControl: isMsg ? f.control.trim() : undefined, copyVariant: isMsg ? f.variant.trim() : undefined,
      primary: f.primary, metricsLabel: f.primary === 'ctr' ? 'CTR → CVR → CPA → ROAS' : '전환율 · ROAS', start, plannedDays: days, minClicksPerArm: null,
      stopDay: CARD_RULES.stopDay, stopDropPct: CARD_RULES.stopCvrDropPct, expandLiftPct: CARD_RULES.expandCvrLiftPct,
      expandScope: f.intent ? `${SA_CAMPAIGNS[f.intent].name} 의도 그룹 전체 적용` : '같은 타겟 그룹 전체 적용', source: 'user', dailyC: [], dailyV: [], createdBy: state.role,
    };
    const ch = actions.addChange({
      module: 'lab', kind: 'test', target: `${id} ${card.title}`, targetId: `labcard:${id}`, before: card.control, after: card.variant,
      reason: `가설: ${card.hypothesis} · 변수 ${card.variable} · ${days}일 또는 최소 표본 · 중단 ${card.stopDay}일 차 CVR −${card.stopDropPct}% · 확대 +${card.expandLiftPct}%`,
      requestedBy: state.role, approver: 'AE',
    });
    setLab((s) => ({ userCards: [...s.userCards, card] }));
    actions.toast({ tone: 'good', title: `테스트 카드 ${id} 등록 요청`, body: `담당 AE 승인 후 ${fmtDate(start)} 집행 시작 · 요청 ${ch.id}`, route: 'flow' });
    setF(EMPTY_DRAFT);
    setErrors([]);
    onDone();
  };

  return (
    <div className="stack">
      <div className="grid g-3" style={{ gap: 12 }}>
        <Field label="카드 제목" id="lab-f-title"><input id="lab-f-title" className="input" value={f.title} placeholder="예: 생활 상황 × 사이즈 비교 랜딩" onChange={(e) => set('title', e.target.value)} /></Field>
        <Field label="매체 · 지면" id="lab-f-media">
          <select id="lab-f-media" className="select" value={f.media} onChange={(e) => set('media', e.target.value)}>{mediaOpts.map((o) => <option key={o}>{o}</option>)}</select>
        </Field>
        <Field label="구매 의도 그룹" id="lab-f-intent">
          <select id="lab-f-intent" className="select" value={f.intent ?? ''} onChange={(e) => set('intent', (e.target.value || null) as IntentId | null)}>
            <option value="">해당 없음 (DA · 소재)</option>
            {INTENT_IDS.map((i) => <option key={i} value={i}>{SA_CAMPAIGNS[i].name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="가설 (~하면 ~가 오른다)" id="lab-f-hyp"><input id="lab-f-hyp" className="input" value={f.hypothesis} placeholder="예: 생활 상황 키워드에 사이즈 비교 랜딩을 연결하면 전환율이 오른다" onChange={(e) => set('hypothesis', e.target.value)} /></Field>
      <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
        <div className="field"><span className="field-label">변수 (한 번에 하나)</span><Segmented options={[{ id: '메시지', label: '메시지' }, { id: '랜딩', label: '랜딩' }, { id: '타겟', label: '타겟' }]} value={f.variable} onChange={(v) => set('variable', v as CardVariable)} label="변수" /></div>
        <div className="field"><span className="field-label">주 지표</span><Segmented options={[{ id: 'cvr', label: '전환율 (CVR)' }, { id: 'ctr', label: 'CTR (소재)' }]} value={f.primary} onChange={(v) => set('primary', v as 'cvr' | 'ctr')} label="주 지표" /></div>
        <Field label="시작일" id="lab-f-start"><input id="lab-f-start" type="date" className="input" value={start} min={d.today} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="기간" id="lab-f-days"><NumberInput id="lab-f-days" value={days} min={7} max={42} suffix="일" onChange={setDays} /></Field>
        <Field label="두 안 예산 차이" id="lab-f-gap"><NumberInput id="lab-f-gap" value={gap} step={1} suffix="%" onChange={setGap} /></Field>
        <label className="row small" style={{ gap: 6 }} htmlFor="lab-f-same"><input id="lab-f-same" type="checkbox" checked={sameTarget} onChange={(e) => setSameTarget(e.target.checked)} />동일 타겟</label>
      </div>
      <div className="grid g-2" style={{ gap: 12 }}>
        <Field label={isMsg ? '기존안 문안 (자동 검수)' : '기존안'} id="lab-f-c" hint={rc ? <span className="row" style={{ gap: 4 }}><ReviewPill level={rc.level} />{rc.findings.slice(0, 2).map((x) => `${x.match} · ${REVIEW_LEVEL_META[x.level].label}`).join(' · ')}</span> : undefined}>
          <input id="lab-f-c" className="input" value={f.control} onChange={(e) => set('control', e.target.value)} />
        </Field>
        <Field label={isMsg ? '변형안 문안 (자동 검수)' : '변형안'} id="lab-f-v" hint={rv ? <span className="row" style={{ gap: 4 }}><ReviewPill level={rv.level} />{rv.findings.slice(0, 2).map((x) => `${x.match} · ${REVIEW_LEVEL_META[x.level].label}`).join(' · ')}</span> : undefined}>
          <input id="lab-f-v" className="input" value={f.variant} onChange={(e) => set('variant', e.target.value)} />
        </Field>
      </div>
      <div className="row xs muted" style={{ gap: 10 }}>
        <span>중단 {CARD_RULES.stopDay}일 차 CVR −{CARD_RULES.stopCvrDropPct}% · 확대 +{CARD_RULES.expandCvrLiftPct}% → 같은 의도 그룹 전체 적용 · 유의수준 {CARD_RULES.alpha} (모듈 가정)</span>
        <Src kind="PROPOSAL" page="p.27 · p.28" />
      </div>
      {errors.length ? <Callout tone="critical" title="등록할 수 없습니다">{errors.join(' · ')}</Callout> : null}
      <div className="row"><Button variant="primary" icon="send" onClick={submit}>테스트 카드 등록 요청</Button><span className="lab-sub">승인 요청(ChangeRequest · 담당 AE)으로 남고, 승인 후 집행 데이터가 쌓이면 같은 기준으로 판정합니다.</span></div>
    </div>
  );
}

function WrapupBox({ card, j, dec, wrap, today }: { card: TestCard; j: CardJudgement; dec: CardDecision; wrap?: Wrapup; today: string }) {
  const due = wrapupDue(dec)!;
  const early = today < due;
  const [result, setResult] = useState('');
  const [learn, setLearn] = useState('');
  const [toLib, setToLib] = useState(dec.verdict === 'expand');
  if (wrap) {
    return (
      <div className="lab-wrap">
        <span className="small"><strong>랩업 완료</strong> · {fmtDate(wrap.at)} · {CARD_VERDICT_META[wrap.outcome].label}</span>
        <span className="lab-basis">{wrap.result}</span>
        {wrap.learnings ? <span className="lab-sub">학습: {wrap.learnings}</span> : null}
        {wrap.addedToLibrary ? <Pill tone="good" icon="check">이긴 패턴 라이브러리에 추가됨</Pill> : null}
      </div>
    );
  }
  return (
    <div className="lab-wrap">
      <span className="small"><strong>2주 후 랩업</strong> · 예정 {fmtDate(nextBusinessDay(due))} (결정 {fmtDate(dec.at)} + {CARD_RULES.wrapupDays}일){early ? <span className="lab-sub"> · 예정일 전에 기록하면 중간 랩업으로 남습니다</span> : null}</span>
      <textarea id={`lab-wrap-${card.id}-result`} className="textarea" style={{ minHeight: 56 }} aria-label="랩업 결과" placeholder={`결과 판정 · 예: 적용 후 2주 CVR ${fmt.pct(j.V.cvr, 2)} 유지 여부, 그룹 ROAS`} value={result} onChange={(e) => setResult(e.target.value)} />
      <input id={`lab-wrap-${card.id}-learn`} className="input" aria-label="학습" placeholder="다음 테스트 기준이 될 학습 (조건 · 반례)" value={learn} onChange={(e) => setLearn(e.target.value)} />
      <label className="row small" style={{ gap: 6 }} htmlFor={`lab-wrap-${card.id}-lib`}><input id={`lab-wrap-${card.id}-lib`} type="checkbox" checked={toLib} onChange={(e) => setToLib(e.target.checked)} />이긴 패턴 라이브러리에 추가</label>
      <Button size="sm" icon="check" disabled={!result.trim()} onClick={() => {
        const w: Wrapup = { at: today, outcome: dec.verdict, result: `${early ? `중간 랩업 (예정 ${fmtDate(nextBusinessDay(due))}) · ` : ''}${result.trim()}`, learnings: learn.trim(), addedToLibrary: toLib };
        const pat: Pattern = {
          id: `pt_${card.id}`, title: `${card.title} — ${card.variant}`, scope: `${card.media}${card.intent ? ` · ${SA_CAMPAIGNS[card.intent].name}` : ''}`, metric: card.primary === 'ctr' ? 'CTR' : 'CVR',
          lift: Math.round(j.primaryLift), p: Number.isFinite(j.primaryP) ? Math.round(j.primaryP * 1000) / 1000 : null, period: `${card.start} ~ ${addDays(card.start, j.dataDays - 1)}`,
          applied: card.expandScope, condition: learn.trim() || '랩업 기록 참조', counter: result.trim(), source: 'user',
        };
        setLab((s) => ({ wrapups: { ...s.wrapups, [card.id]: w }, library: toLib ? [pat, ...s.library.filter((x) => x.id !== pat.id)] : s.library }));
      }}>랩업 기록</Button>
    </div>
  );
}

function TestCardView({ card, m }: { card: TestCard; m: LabModel }) {
  const { judgements, lab, state, actions, d } = m;
  const j = judgements[card.id];
  const dec = lab.decisions[card.id];
  const decChange = dec?.changeId ? state.changes.find((c) => c.id === dec.changeId) : undefined;
  const reg = state.changes.find((c) => c.targetId === `labcard:${card.id}`);
  const series = cumulativeSeries(card, card.primary, j.dataDays);
  const xs = series.c.map((_, i) => `D${i + 1}`);
  const decide = (verdict: CardDecision['verdict']) => {
    const after = verdict === 'expand' ? `확대 — ${card.expandScope}` : verdict === 'stop' ? '중단 — 기존안 복귀' : '모니터링 지속 — 기존안 유지';
    const ch = actions.addChange({
      module: 'lab', kind: 'test', target: `${card.id} ${card.title}`, targetId: `labcard:${card.id}:decision`, before: '테스트 진행', after,
      reason: `${j.badge} — ${j.basis}`, requestedBy: state.role, approver: verdict === 'expand' ? 'PM' : 'AE',
    });
    setLab((s) => ({ decisions: { ...s.decisions, [card.id]: { verdict, at: d.today, by: state.role, note: j.badge, changeId: ch.id } } }));
    actions.toast({ tone: verdict === 'stop' ? 'warning' : 'good', title: `${card.id} ${CARD_VERDICT_META[verdict].label} 결정 요청`, body: `2주 후 랩업 ${fmtDate(nextBusinessDay(addDays(d.today, CARD_RULES.wrapupDays)))}`, route: 'flow' });
  };
  const decidable = j.verdict === 'expand' || j.verdict === 'stop' || j.verdict === 'monitor';
  const row = (label: string, c: string, v: string, diff?: string, p?: string) => <tr><td>{label}</td><td>{c}</td><td>{v}</td><td>{diff ?? ''}</td><td>{p ?? ''}</td></tr>;
  return (
    <Card title={<span className="row" style={{ gap: 6 }}><span className="lab-mono">{card.id}</span>{card.title}</span>} sub={`${card.variable} 테스트 · ${card.media}${card.intent ? ` · ${SA_CAMPAIGNS[card.intent].name}` : ''} · 지표 ${card.metricsLabel}`}
      actions={card.source === 'demo' ? <Src kind="DEMO" /> : <Pill tone="outline">사용자 카드</Pill>}>
      <div className="lab-quote">{card.hypothesis}</div>
      <div className="lab-kv">
        <dt>기존안</dt><dd className="small">{card.control}</dd>
        <dt>변형안</dt><dd className="small"><strong>{card.variant}</strong></dd>
        <dt>기간</dt><dd className="small">{fmtDate(card.start)} ~ {fmtDate(addDays(card.start, card.plannedDays - 1))} · {card.plannedDays}일 또는 최소 표본</dd>
        <dt>중단 · 확대</dt><dd className="small">{card.stopDay}일 차 CVR −{card.stopDropPct}% 중단 · {card.primary === 'ctr' ? 'CTR' : 'CVR'} +{card.expandLiftPct}% → {card.expandScope}</dd>
      </div>
      <div className="stack-sm" style={{ gap: 4 }}>
        <div className="row-between xs muted"><span>진행 {j.dataDays}/{card.plannedDays}일 · 세로선 = {card.stopDay}일 차 중단 점검</span><span>{j.stopCheck.note}</span></div>
        <ProgressBar value={j.dataDays} max={card.plannedDays} marker={card.stopDay} tone={j.verdict === 'stop' ? 'critical' : j.verdict === 'expand' ? 'good' : 'ink'} label="테스트 진행" />
      </div>
      <div className="row" style={{ gap: 6 }}><CardVerdictPill v={j.verdict} label={j.badge} /></div>
      <span className="lab-basis">{j.basis}</span>
      <span className="lab-sub">다음: {j.action}</span>
      {j.dataDays > 0 ? (
        <>
          <table className="lab-ab">
            <thead><tr><th>지표</th><th>기존안</th><th>변형안</th><th>차이</th><th>검정</th></tr></thead>
            <tbody>
              {row('노출', fmt.int(j.C.impressions), fmt.int(j.V.impressions))}
              {row('클릭', fmt.int(j.C.clicks), fmt.int(j.V.clicks))}
              {row('CTR', fmt.pct(j.C.ctr, 2), fmt.pct(j.V.ctr, 2), sg(j.liftCtr), pText(j.pCtr))}
              {row('전환', fmt.int(j.C.conversions), fmt.int(j.V.conversions))}
              {row('CVR', fmt.pct(j.C.cvr, 2), fmt.pct(j.V.cvr, 2), sg(j.liftCvr), pText(j.pCvr))}
              {row('CPA', fmt.won(j.C.cpa), fmt.won(j.V.cpa), sg(j.checks[2].lift), '방향')}
              {row('ROAS', fmt.roas(j.C.roas), fmt.roas(j.V.roas), sg(j.checks[3].lift), '방향')}
            </tbody>
          </table>
          <div className="lab-order" aria-label="판정 순서">
            <span className="lab-sub">판정 순서</span>
            {j.checks.map((x, i) => (
              <span key={x.metric} className="row" style={{ gap: 4 }}>
                <span className={`lab-order-step ${x.status}`} title={x.note}>{x.label} {x.status === 'win' ? '우세' : x.status === 'lose' ? '열위' : x.status === 'tie' ? '차이 없음' : '—'}</span>
                {i < j.checks.length - 1 ? <span className="lab-sub">→</span> : null}
              </span>
            ))}
          </div>
          <span className="lab-sub">두 비율 z-검정 (양측 α {CARD_RULES.alpha}) · +{card.expandLiftPct}% 검출 필요 표본 군당 {card.primary === 'ctr' ? '노출' : '클릭'} {fmt.int(j.required)} · 현재 {fmt.int(j.have)}{j.sampleOk ? ' (충분)' : ' (부족 — 관측 효과가 크면 유의할 수 있음)'}</span>
          {xs.length >= 2 ? <LineChart height={130} series={[{ id: 'c', label: '기존안', colorVar: '--series-1', points: xs.map((x, i) => ({ x, y: series.c[i] })) }, { id: 'v', label: '변형안', colorVar: '--series-2', points: xs.map((x, i) => ({ x, y: series.v[i] })) }]} yFormat={(v) => `${v.toFixed(card.primary === 'ctr' ? 2 : 1)}%`} zeroBased={false} ariaLabel={`누적 ${card.primary === 'ctr' ? 'CTR' : 'CVR'} 추이`} /> : null}
        </>
      ) : <span className="lab-sub">집행 전 — 승인 후 데이터가 쌓이면 같은 기준으로 판정합니다.</span>}
      {reg ? <div className="row" style={{ gap: 6 }}><span className="lab-sub">카드 등록</span><ChangeActions c={reg} compact /></div> : null}
      {dec ? (
        <div className="stack-sm">
          <span className="small"><strong>결정 · {CARD_VERDICT_META[dec.verdict].label}</strong> · {fmtDate(dec.at)} · {dec.by}</span>
          {decChange ? <ChangeActions c={decChange} compact /> : null}
          <WrapupBox card={card} j={j} dec={dec} wrap={lab.wrapups[card.id]} today={d.today} />
        </div>
      ) : decidable ? (
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant={j.verdict === 'stop' ? 'danger' : 'primary'} icon="send" onClick={() => decide(j.verdict as CardDecision['verdict'])}>{CARD_VERDICT_META[j.verdict].label} 결정 · 승인 요청</Button>
          {j.verdict !== 'monitor' ? <Button size="sm" onClick={() => decide('monitor')}>모니터링 지속</Button> : null}
        </div>
      ) : null}
    </Card>
  );
}

/** 다른 모듈(Watch 감지 → 소액 테스트 · Growth 파일럿 · 홀드아웃)이 보낸 테스트 요청 — 같은 테스트 카드 양식으로 설계 */
function IncomingCard({ m, onMakeCard }: { m: LabModel; onMakeCard?: (d: CardDraft) => void }) {
  const list = incomingTests(m.state.changes);
  const open = list.filter((x) => isOpenChange(x.change));
  return (
    <Card title={`다른 모듈 테스트 요청 · ${list.length}건`} sub="MILDO Watch '테스트 등록' · 매출 성장 파일럿 · 홀드아웃 요청이 여기로 들어옵니다. 승인 권한은 요청의 승인 주체 기준이며, 설계는 같은 테스트 카드 양식(p.28)으로 합니다."
      actions={<><Pill tone={open.length ? 'accent' : 'neutral'}>진행 대기 {open.length}</Pill><a className="btn sm" href="#watch">MILDO Watch</a></>}>
      {list.length ? (
        <div className="stack-sm">
          {list.slice(0, 8).map((x) => (
            <div key={x.change.id} className="lab-todo-item">
              <Pill tone="outline">{x.origin}</Pill>
              <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
                <strong className="small">{x.title}</strong>
                <span className="lab-basis">{x.summary}</span>
                <span className="lab-sub">{String(x.change.reason ?? '').slice(0, 160)}{String(x.change.reason ?? '').length > 160 ? '…' : ''}</span>
              </div>
              <div className="stack-sm" style={{ gap: 4, alignItems: 'flex-end' }}>
                <ChangeActions c={x.change} compact />
                <span className="row" style={{ gap: 4 }}>
                  <a className="btn sm" href={`#${x.route}`}>{x.origin} 열기</a>
                  {onMakeCard ? <Button size="sm" icon="lab" onClick={() => onMakeCard(incomingToDraft(x))}>테스트 카드로 설계</Button> : null}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <span className="small muted">수신한 테스트 요청이 없습니다. MILDO Watch 이벤트 피드에서 '테스트 등록'을 누르면 요청이 승인 대기 상태로 들어옵니다.</span>
      )}
    </Card>
  );
}

export function CardsTab({ m, draft, onMakeCard, onDraftUsed }: { m: LabModel; draft: CardDraft | null; onMakeCard?: (d: CardDraft) => void; onDraftUsed?: () => void }) {
  const { cards, patterns, judgements } = m;
  const [open, setOpen] = useState(!!draft);
  useEffect(() => {
    if (!draft) return;
    setOpen(true);
    if (typeof document !== 'undefined') document.getElementById('lab-new-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [draft]);
  const libCols: Column<Pattern>[] = [
    { key: 'title', label: '이긴 패턴', render: (p) => <div><strong className="small">{p.title}</strong><div className="lab-sub">{p.scope} · {p.period}</div></div> },
    { key: 'metric', label: '효과', align: 'right', sort: (p) => p.lift, render: (p) => <span className="num small nowrap">{p.metric} {sg(p.lift)}<div className="lab-sub">{p.p !== null ? pText(p.p) : '—'}</div></span> },
    { key: 'applied', label: '적용 범위', render: (p) => <span className="lab-basis">{p.applied}</span> },
    { key: 'cond', label: '전제 조건', render: (p) => <span className="lab-basis">{p.condition}</span> },
    { key: 'counter', label: '반례 · 한계', render: (p) => <span className="lab-basis">{p.counter}</span> },
    { key: 'src', label: '', render: (p) => (p.source === 'demo' ? <Src kind="DEMO" title="가상 이력 · 실제 테스트 결과 아님" /> : <Pill tone="good">랩업 기록</Pill>) },
  ];
  const counts = Object.values(judgements).reduce<Record<string, number>>((a, j) => ({ ...a, [j.verdict]: (a[j.verdict] ?? 0) + 1 }), {});
  return (
    <div className="stack-lg">
      <Card tone="dark" title="MILDO LAB · TEST CARD" sub="모든 테스트는 같은 카드로 시작해 같은 기준으로 끝나고, 결과는 정해진 주기로 수면밀도에 돌아갑니다" actions={<Src kind="PROPOSAL" page="p.28" />}>
        <div className="lab-rules">
          <div className="lab-rule"><strong>가설</strong><span className="lab-sub">한 문장 · 변수 하나 (메시지 / 랜딩 / 타겟)</span></div>
          <div className="lab-rule"><strong>기간 · 지표</strong><span className="lab-sub">{CARD_RULES.days}일 또는 최소 표본 도달 · 전환율 · ROAS (소재는 CTR → CVR → CPA → ROAS)</span></div>
          <div className="lab-rule"><strong>중단</strong><span className="lab-sub">{CARD_RULES.stopDay}일 차 전환율 기존 대비 −{CARD_RULES.stopCvrDropPct}% (기존안 전환 {CARD_RULES.stopMinConversions}건 이상일 때 · 모듈 가정)</span></div>
          <div className="lab-rule"><strong>확대</strong><span className="lab-sub">전환율 +{CARD_RULES.expandCvrLiftPct}% · p &lt; {CARD_RULES.alpha} → 같은 의도 그룹 전체 적용 · 표본 부족 시 판정 보류</span></div>
        </div>
        <div className="row xs" style={{ gap: 10, color: 'var(--panel-muted)' }}>
          {(['running', 'expand', 'stop', 'monitor', 'insufficient', 'planned'] as const).filter((v) => counts[v]).map((v) => <span key={v}>{CARD_VERDICT_META[v].label} {counts[v]}</span>)}
          <span>· 결정 후 {CARD_RULES.wrapupDays}일 랩업</span>
        </div>
      </Card>

      <Card id="lab-new-card" title="새 테스트 카드" sub="한 번에 한 변수 · 동일 타겟 · 유사 예산(±10%) 조건을 통과해야 등록됩니다" actions={<Button size="sm" icon={open ? 'x' : 'plus'} onClick={() => setOpen((o) => !o)}>{open ? '닫기' : '카드 만들기'}</Button>}>
        {open ? <NewCardForm m={m} draft={draft} onDone={() => { setOpen(false); onDraftUsed?.(); }} /> : <span className="small muted">VisualTune 탭 문안 생성기의 'A/B 카드로', 아래 다른 모듈 테스트 요청의 '테스트 카드로 설계'를 누르면 내용이 채워진 상태로 열립니다.</span>}
      </Card>

      <div className="lab-cards">
        {cards.map((c) => <TestCardView key={c.id} card={c} m={m} />)}
      </div>

      <IncomingCard m={m} onMakeCard={onMakeCard} />

      <Card title={`이긴 패턴 라이브러리 · ${patterns.length}개`} sub="모든 테스트 이력을 저장해, 이긴 패턴이 다음 테스트의 기준이 됩니다 (p.28)" actions={<Src kind="PROPOSAL" page="p.28" />}>
        <DataTable rows={patterns} columns={libCols} rowKey={(p) => p.id} empty="아직 기록된 패턴이 없습니다" />
      </Card>
    </div>
  );
}
