/* 롱테일 · 구문형 키워드 발굴 (p.26 · p.36) — 소스 3개 + SKU 확장 48 진입점 → 의도 · 검색량 · 랜딩 · 우선순위 → 테스트 그룹 등록 요청 */
import { useMemo, useState } from 'react';
import type { IntentId } from '@/core/types';
import { INTENT_IDS, SA_CAMPAIGNS, SKU_EXPANSION } from '@/data/constants';
import { fmt } from '@/core/util';
import { toCsv } from '@/core/download';
import { useAi } from '@/ai/useAi';
import { AI_ERROR_COPY, AiError } from '@/ai/claude';
import { Button, Callout, Card, type Column, DataTable, DownloadButton, Field, Pill, Src } from '@/ui/primitives';
import { SCORE_WEIGHTS, SKU_TOKENS } from './data';
import {
  bulkCheck, CANDIDATE_STATUS_LABEL, expandPrompt, INTENT_NAME, LANDING_LEVEL_META, parseAiCandidates, registrationPayload, skuFormula, SOURCE_LABEL,
  type Candidate, type CandidateSource,
} from './engine';
import { setLab } from './store';
import { Dl, LandingPill, ScoreBar, TierPill, useClickGuard, type LabModel } from './parts';

/** 연관 검색어 · AI 검색 질의 후보는 데모 스냅샷(RELATED_SEEDS · AI_QUERY_SEEDS)에서 나온다 — 실연동 데이터여도 TEST DATA */
const SNAPSHOT_SOURCES: readonly CandidateSource[] = ['related', 'ai_query'];
const SOURCE_BASIS: Record<CandidateSource, string> = {
  search_term: '미등록 · 전환 발생 (실측)',
  related: '연관 검색어 · 데모 스냅샷',
  ai_query: 'AI 검색 질의 · 데모 스냅샷',
  sku48: '제품 1 × 문제 4 × 상황 4 × 비교 3',
  ai_expand: 'AI 확장 (askJson)',
};

/** 후보 CSV 열 (엑셀에서 바로 읽히도록 한글 머리글 · 수치는 TEST DATA 기준) */
const CSV_COLUMNS = [
  { key: 'phrase', label: '구문형 키워드' }, { key: 'source', label: '출처' }, { key: 'intent', label: '의도 분류' }, { key: 'volume', label: '예상 검색량' },
  { key: 'volumeNote', label: '검색량 근거' }, { key: 'roas', label: '보고서 ROAS(%)' }, { key: 'landing', label: '랜딩 매칭' }, { key: 'score', label: '우선순위 점수' },
  { key: 'flags', label: '주의' }, { key: 'status', label: '상태' },
];

function heat(score: number) {
  // 점수 → 단일 색 농도 (텍스트 대비 유지 위해 최대 42%)
  const pct = Math.round(Math.max(0, Math.min(1, (score - 40) / 55)) * 42);
  return { background: `color-mix(in srgb, var(--series-1) ${pct}%, var(--surface))` };
}

export function DiscoverTab({ m }: { m: LabModel }) {
  const { d, disc, sku, state, actions, lab, crit } = m;
  const ai = useAi();
  const [source, setSource] = useState<CandidateSource | 'all'>('all');
  const [intent, setIntent] = useState<IntentId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pick, setPick] = useState<string | null>(() => sku.slice().sort((a, b) => b.score - a.score)[0]?.id ?? null);
  const [confirm, setConfirm] = useState<Candidate[] | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const f = skuFormula();

  const counts = useMemo(() => {
    const c: Record<CandidateSource, number> = { search_term: 0, related: 0, ai_query: 0, sku48: sku.length, ai_expand: 0 };
    for (const x of disc.all) if (x.source !== 'sku48') c[x.source] += 1;
    return c;
  }, [disc.all, sku.length]);

  const pool = source === 'sku48' ? sku : disc.all;
  const rows = pool.filter((c) => (source === 'all' || c.source === source) && (intent === 'all' || c.intent === intent) && (!query || c.phrase.includes(query.trim())) && (!onlyNew || c.status === 'new' || c.status === 'rejected'));
  const picked = [...sku, ...disc.all].find((c) => c.id === pick) ?? null;
  const selRows = rows.filter((c) => selected.has(c.id) && (c.status === 'new' || c.status === 'rejected') && c.purchase);
  const check = bulkCheck(selRows.length);

  const guard = useClickGuard();
  // 등록 직후 행이 목록에서 빠지면 다음 후보 버튼이 같은 자리로 올라온다 — 더블클릭이 다른 후보를 등록하지 않도록 연속 호출은 무시
  const register = guard((cs: Candidate[], force = false) => {
    if (!cs.length) return false;
    const b = bulkCheck(cs.length);
    if (b.level === 'block') { actions.toast({ tone: 'warning', title: '대량 등록 차단', body: b.reason }); return false; }
    if (b.level === 'warn' && !force) { setConfirm(cs); return false; }
    const ps = cs.map((c) => registrationPayload(c, state.role, cs.length));
    for (const p of ps) actions.addChange(p);
    const pm = ps.filter((p) => p.approver === 'PM').length;
    const who = pm === ps.length ? 'PM' : pm ? `담당 AE · PM(브랜드 ${pm}건)` : '담당 AE';
    actions.toast({ tone: 'good', title: `테스트 그룹 등록 요청 ${cs.length}건`, body: `${who} 승인 후 테스트 전용 그룹 · 입찰 상한으로 등록됩니다`, route: 'flow' });
    setSelected(new Set());
    setConfirm(null);
  });

  const runAi = async () => {
    setAiNote('');
    if (!ai.connected) return;
    setAiBusy(true);
    try {
      const raw = await ai.askJson<unknown>(expandPrompt(d));
      const got = parseAiCandidates(raw, d, state.changes);
      const known = new Set([...disc.all, ...sku].map((c) => c.phrase.replace(/\s+/g, '')));
      const fresh = got.filter((c) => !known.has(c.phrase.replace(/\s+/g, '')));
      setLab((s) => ({ aiCandidates: [...s.aiCandidates.filter((x) => !fresh.some((y) => y.id === x.id)), ...fresh].slice(-40) }));
      setAiNote(`AI 후보 ${got.length}개 중 신규 ${fresh.length}개를 추가했습니다. 모든 후보는 같은 기준(의도 · 랜딩 · 우선순위 · 검수)으로 다시 계산했습니다.`);
      setSource('ai_expand');
    } catch (e) {
      const err = e as AiError;
      setAiNote(AI_ERROR_COPY[err.code] ?? err.message ?? 'AI 호출 실패');
    } finally {
      setAiBusy(false);
    }
  };

  const columns: Column<Candidate>[] = [
    {
      key: 'sel', label: '', width: 28,
      render: (c) => <input type="checkbox" aria-label={`${c.phrase} 선택`} disabled={!(c.status === 'new' || c.status === 'rejected') || !c.purchase} checked={selected.has(c.id)}
        onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />,
    },
    {
      key: 'phrase', label: '구문형 키워드', sort: (c) => c.phrase,
      render: (c) => (
        <button type="button" className="icon-btn" style={{ padding: 0, textAlign: 'left', display: 'block' }} onClick={() => setPick(c.id)} title="상세 보기">
          <strong className="small">{c.phrase}</strong>
          <div className="lab-sub">{c.origin}</div>
        </button>
      ),
    },
    { key: 'src', label: '출처', sort: (c) => c.source, render: (c) => <span className="row" style={{ gap: 4 }}><Pill tone="outline">{SOURCE_LABEL[c.source]}</Pill>{c.source === 'ai_expand' ? <Src kind="AI" /> : null}</span> },
    { key: 'intent', label: '의도 분류', sort: (c) => c.intent, render: (c) => <span className="small">{INTENT_NAME(c.intent)}{c.secondary ? <span className="lab-sub"> · {INTENT_NAME(c.secondary)}</span> : null}</span> },
    {
      key: 'vol', label: '예상 검색량', align: 'right', sort: (c) => c.volume,
      render: (c) => <span title={c.volumeNote}><strong className="num">{fmt.int(c.volume)}</strong><div className="lab-sub nowrap">{c.volumeKind === 'impressions' ? '보고서 노출 · 실측' : c.volumeKind === 'monthly_demo' ? '월 · 데모 스냅샷' : '월 · 데모 추정'}</div></span>,
    },
    {
      key: 'ev', label: '근거 (보고서)', align: 'right', sort: (c) => c.evidence?.roas ?? -1,
      render: (c) => c.evidence ? <span className="num small nowrap" title={`목표 대비 ${fmt.int(c.evidence.ratioPct)}%`}>ROAS {fmt.roas(c.evidence.roas)}<div className="lab-sub">전환 {fmt.dec1(c.evidence.conversions)} · 클릭 {fmt.int(c.evidence.clicks)}</div></span> : <span className="lab-sub">간접 (의도 그룹)</span>,
    },
    { key: 'landing', label: '랜딩 매칭', sort: (c) => (c.landing.level === 'good' ? 2 : c.landing.level === 'partial' ? 1 : 0), render: (c) => <div className="stack-sm" style={{ gap: 2 }}><LandingPill l={c.landing} />{c.landing.notes[0] ? <span className="lab-sub">{c.landing.notes[0]}</span> : null}</div> },
    { key: 'score', label: '우선순위', align: 'right', sort: (c) => c.score, render: (c) => <div className="stack-sm" style={{ gap: 2, alignItems: 'flex-end' }}><ScoreBar score={c.score} /><TierPill c={c} /></div> },
    { key: 'flags', label: '주의', width: 180, render: (c) => c.flags.length ? <span className="lab-basis">{c.flags.join(' · ')}</span> : <span className="lab-sub">—</span> },
    {
      key: 'act', label: '상태', align: 'right',
      render: (c) => c.status === 'new' || c.status === 'rejected'
        ? <Button size="sm" icon="plus" disabled={!c.purchase} title={c.purchase ? '테스트 전용 그룹 등록 요청 (pending)' : '구매 의도 낮음 — 등록 대상 아님'} onClick={() => register([c])}>등록 요청</Button>
        : <Pill tone={c.status === 'testing' ? 'accent' : 'warning'}>{CANDIDATE_STATUS_LABEL[c.status]}</Pill>,
    },
  ];

  const sources: (CandidateSource | 'all')[] = ['all', 'search_term', 'related', 'ai_query', 'sku48', 'ai_expand'];

  return (
    <div className="stack-lg">
      <Callout tone="info" title="검색어 보고서 · 연관 검색어 · AI 검색 질의에서 구문형 후보를 찾고, MILDO Lab에서 같은 기준으로 판정해 매주 넓힙니다 (p.26)">
        제품 수가 아니라 고객이 매트리스를 검색하는 이유의 수만큼 키워드와 랜딩을 늘립니다 (p.36). 후보마다 의도 분류 · 예상 검색량 · 랜딩 매칭 · 우선순위 점수를 같은 식으로 계산하고, 등록은 테스트 전용 그룹 · 입찰 상한으로 승인 요청만 만듭니다.
      </Callout>

      <div className="lab-sources" role="group" aria-label="후보 소스">
        {sources.filter((s) => s !== 'ai_expand' || counts.ai_expand > 0 || ai.connected).map((s) => (
          <button key={s} type="button" className="lab-source" aria-pressed={source === s} onClick={() => setSource(s)}>
            <span className="small">{s === 'all' ? '전체 (중복 제거)' : SOURCE_LABEL[s]}</span>
            <span className="lab-source-n">{s === 'all' ? disc.all.length : counts[s]}</span>
            <span className="lab-sub">{s === 'all' ? `등록 구문 ${disc.excludedRegistered + disc.excludedExisting}개 제외 (파이프라인에서 판정)` : SOURCE_BASIS[s]}</span>
            <span className="row" style={{ gap: 4 }}>
              {s === 'search_term' ? <Src kind="DEMO" /> : s === 'sku48' ? <Src kind="PROPOSAL" page="p.36" /> : s === 'ai_expand' ? <Src kind="AI" /> : s === 'all' ? <Src kind="PROPOSAL" page="p.26" /> : <Src kind="DEMO" fixture title="데모 스냅샷 · 실제 검색량 아님" />}
            </span>
          </button>
        ))}
      </div>

      <div className="grid g-3">
        <Card className="span-2" title="SKU 확장 생성기 · 검색 진입점 48개" sub="행 = 고객의 문제 · 열 = 구매 상황 · 칸 안 3개 = 비교 기준. 숫자는 우선순위 점수, 색이 진할수록 높음."
          actions={<><Src kind="PROPOSAL" page="p.36" /><Src kind="DEMO" title="검색량은 데모 추정" /></>}>
          <div className="lab-formula">
            <span className="lab-formula-num">제품 {f.product} × 문제 {f.problems} × 상황 {f.situations} × 비교 {f.criteria} = <em>{f.total}</em></span>
            <span className="lab-sub">조합 → 구문형 키워드 (예: '{sku[0]?.phrase}' · 상위 구문 '{sku[1]?.sku?.head}')</span>
          </div>
          <div className="lab-g48" role="grid" aria-label="검색 진입점 48개">
            <div className="lab-g48-h">문제 \ 상황</div>
            {SKU_EXPANSION.situations.map((s) => <div key={s} className="lab-g48-h">{s}</div>)}
            {SKU_TOKENS.problems.map((p) => (
              <div key={p.label} style={{ display: 'contents' }}>
                <div className="lab-g48-r">{p.label}</div>
                {SKU_TOKENS.situations.map((s) => (
                  <div key={s.label} className="lab-g48-cell">
                    {sku.filter((e) => e.sku?.problem === p.label && e.sku?.situation === s.label).map((e) => (
                      <button key={e.id} type="button" className={`lab-chip ${e.landing.level}`} style={heat(e.score)} aria-pressed={pick === e.id} onClick={() => setPick(e.id)}
                        title={`${e.phrase} · ${e.score}점 · 월 ${fmt.int(e.volume)} (추정) · 랜딩 ${e.landing.label} ${LANDING_LEVEL_META[e.landing.level].label}`}>
                        <span className="lab-chip-label">{e.status !== 'new' ? <span className="lab-chip-dot" /> : null}{e.sku?.criterion}</span>
                        <span className="lab-chip-score">{e.score}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="row xs muted" style={{ gap: 14 }}>
            <span className="row" style={{ gap: 4 }}><span className="lab-legend-box" style={heat(90)} />점수 높음</span>
            <span className="row" style={{ gap: 4 }}><span className="lab-legend-box" style={heat(45)} />낮음</span>
            <span className="row" style={{ gap: 4 }}><span className="lab-legend-box" />랜딩 매칭</span>
            <span className="row" style={{ gap: 4 }}><span className="lab-legend-box dashed" />부분 매칭 (콘텐츠 공백 · 기획전 종료 · 품절)</span>
            <span className="row" style={{ gap: 4 }}><span className="lab-chip-dot" />등록 요청 · 테스트 중</span>
          </div>
        </Card>

        <Card title="후보 상세" sub={picked ? `${SOURCE_LABEL[picked.source]} · ${picked.origin}` : '그리드나 표에서 후보를 선택하세요'} actions={picked?.source === 'ai_expand' ? <Src kind="AI" /> : picked && SNAPSHOT_SOURCES.includes(picked.source) ? <Src kind="DEMO" fixture title="데모 스냅샷 · 실제 검색량 아님" /> : <Src kind="DEMO" />}>
          {picked ? (
            <div className="stack">
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <strong style={{ fontSize: 'var(--fs-lg)' }}>{picked.phrase}</strong>
                <TierPill c={picked} />
              </div>
              <Dl items={[
                ['의도 분류', `${INTENT_NAME(picked.intent)}${picked.secondary ? ` (보조: ${INTENT_NAME(picked.secondary)})` : ''} → ${SA_CAMPAIGNS[picked.intent].name} 캠페인 TEST 그룹`],
                ['예상 검색량', <span key="v"><strong className="num">{fmt.int(picked.volume)}</strong> <span className="lab-sub">{picked.volumeNote}</span></span>],
                ['근거', picked.evidence ? `검색어 보고서 클릭 ${fmt.int(picked.evidence.clicks)} · 전환 ${fmt.dec1(picked.evidence.conversions)} · ROAS ${fmt.roas(picked.evidence.roas)} (목표 대비 ${fmt.int(picked.evidence.ratioPct)}%)` : '직접 성과 없음 — 같은 의도 본 그룹 ROAS로 간접 근거'],
                ['랜딩', <div key="l" className="stack-sm" style={{ gap: 2 }}><LandingPill l={picked.landing} /><span className="lab-mono">{picked.landing.url}</span>{picked.landing.notes.map((n) => <span key={n} className="lab-sub">{n}</span>)}</div>],
                ['입찰 상한', `${fmt.won(picked.bidCap)} (같은 의도 본 그룹 입찰 중앙값)`],
                ...(picked.sku ? [['상위 구문', `'${picked.sku.head}' — ${m.disc.all.find((x) => x.phrase === picked.sku!.head)?.statusNote ?? (d.keywords.some((k) => k.text === picked.sku!.head) ? '등록 키워드 (테스트 그룹)' : '미등록')}`] as [string, string]] : []),
                ['상태', picked.statusNote],
              ]} />
              <div className="stack-sm">
                <span className="field-label">점수 구성 (총 {picked.score}점)</span>
                <div className="lab-parts">
                  {([['검색량', picked.parts.volume, SCORE_WEIGHTS.volume], ['랜딩 매칭', picked.parts.landing, SCORE_WEIGHTS.landing], ['근거', picked.parts.evidence, SCORE_WEIGHTS.evidence], ['구매 의도', picked.parts.intent, SCORE_WEIGHTS.intent]] as const).map(([k, v, max]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <span className="muted">{k}</span>
                      <span className="lab-score-bar"><span style={{ width: `${(v / max) * 100}%` }} /></span>
                      <span className="num" style={{ textAlign: 'right' }}>{fmt.dec1(v)}/{max}</span>
                    </div>
                  ))}
                </div>
              </div>
              {picked.flags.length ? <Callout tone="warning">{picked.flags.join(' · ')}</Callout> : null}
              {picked.status === 'new' || picked.status === 'rejected'
                ? <Button variant="primary" icon="plus" disabled={!picked.purchase} onClick={() => register([picked])}>테스트 그룹 등록 요청</Button>
                : <Pill tone="accent">{CANDIDATE_STATUS_LABEL[picked.status]} · {picked.statusNote}</Pill>}
            </div>
          ) : null}
        </Card>
      </div>

      <Card title={`후보 목록 · ${rows.length}개`} sub={`점수 = 검색량 ${SCORE_WEIGHTS.volume} + 랜딩 ${SCORE_WEIGHTS.landing} + 근거 ${SCORE_WEIGHTS.evidence} + 구매 의도 ${SCORE_WEIGHTS.intent} (모듈 가정) · 우선 ≥ ${SCORE_WEIGHTS.priority} · 검토 ≥ ${SCORE_WEIGHTS.review} · 목표 ROAS ${crit.targetRoas}% 기준`}
        actions={<>
          <Src kind="DEMO" />
          <DownloadButton filename={`mildo-lab-candidates-${d.today}.csv`} mime="text/csv;charset=utf-8" label="CSV"
            data={() => toCsv(rows.map((c) => ({ phrase: c.phrase, source: SOURCE_LABEL[c.source], intent: INTENT_NAME(c.intent), volume: c.volume, volumeNote: c.volumeNote, roas: c.evidence ? Math.round(c.evidence.roas) : '', landing: `${c.landing.label} ${LANDING_LEVEL_META[c.landing.level].label}`, score: c.score, flags: c.flags.join(' / '), status: CANDIDATE_STATUS_LABEL[c.status] })), CSV_COLUMNS)} />
          <Button size="sm" variant="primary" icon="send" disabled={!selRows.length || check.level === 'block'} title={check.reason} onClick={() => register(selRows)}>선택 {selRows.length}건 등록 요청</Button>
        </>}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <Field label="구매 의도" id="lab-intent">
            <select id="lab-intent" className="select" value={intent} onChange={(e) => setIntent(e.target.value as IntentId | 'all')}>
              <option value="all">전체</option>
              {INTENT_IDS.map((i) => <option key={i} value={i}>{SA_CAMPAIGNS[i].name}</option>)}
            </select>
          </Field>
          <Field label="구문 검색" id="lab-q"><input id="lab-q" className="input" value={query} placeholder="예: 신혼" onChange={(e) => setQuery(e.target.value)} /></Field>
          <label className="row small" style={{ gap: 6 }} htmlFor="lab-only-new"><input id="lab-only-new" type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />미등록만</label>
          <Button size="sm" onClick={() => setSelected(new Set(rows.filter((c) => c.tier === 'priority' && (c.status === 'new' || c.status === 'rejected') && c.purchase).slice(0, 5).map((c) => c.id)))}>우선 등급 상위 5개 선택</Button>
          {selRows.length ? <span className={`small ${check.level === 'ok' ? 'muted' : 'accent'}`}>{check.reason}</span> : null}
        </div>
        {confirm ? (
          <Callout tone="warning" title={`${confirm.length}건 일괄 등록 — 한 번 더 확인`}>
            <div className="row" style={{ gap: 6 }}>
              <span>{bulkCheck(confirm.length).reason}</span>
              <Button size="sm" variant="primary" icon="check" onClick={() => register(confirm, true)}>{confirm.length}건 요청 확정</Button>
              <Button size="sm" onClick={() => setConfirm(null)}>취소</Button>
            </div>
          </Callout>
        ) : null}
        <div className="lab-cand">
          <DataTable rows={rows} columns={columns} rowKey={(c) => c.id} initialSort={{ key: 'score', dir: 'desc' }} maxHeight={560} selectedKey={pick} empty="조건에 맞는 후보가 없습니다" />
        </div>
      </Card>

      <Card title="AI로 구문형 후보 확장" sub="Claude가 문제 × 상황 × 비교 조합에서 구문을 제안하면, 같은 규칙(의도 · 검색량 추정 · 랜딩 · 점수 · 검수 플래그)으로 다시 계산해 후보 목록에 넣습니다."
        actions={<>
          {lab.aiCandidates.length ? <><Src kind="AI" /><Button size="sm" icon="x" onClick={() => setLab({ aiCandidates: [] })}>AI 후보 {lab.aiCandidates.length}개 지우기</Button></> : null}
          <Button size="sm" variant="accent" icon="sparkle" disabled={!ai.connected || aiBusy} onClick={runAi}>{aiBusy ? '생성 중…' : 'AI로 구문형 후보 확장'}</Button>
        </>}>
        {!ai.connected ? <div className="small muted">AI 미연결 — 버튼이 비활성입니다. 규칙 기반 후보(검색어 보고서 · 연관 검색어 · AI 질의 스냅샷 · 48 진입점)는 그대로 동작합니다.</div> : null}
        {aiNote ? <div className="small">{aiNote}</div> : null}
      </Card>
    </div>
  );
}
