/* 검수 에이전트 — 모든 문안을 REVIEW_RULES + 데이터 대조(판매가 · 프로모션 · 재고)로 자동 검수 → 차단 / 경고 / 확인 + 사유 + 수정 제안 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { REVIEW_RULES } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { useAi } from '@/ai/useAi';
import { AI_ERROR_COPY, AiError } from '@/ai/claude';
import type { Dataset } from '@/core/types';
import { Button, Callout, Card, type Column, CopyButton, DataTable, Pill, Segmented, Src } from '@/ui/primitives';
import { EXTRA_REVIEW_RULES, REVIEW_SAMPLES, SA_CHAR_LIMITS } from './data';
import { charLen, parseAiRewrites, priceReferences, REVIEW_LEVEL_META, reviewCopy, rewritePrompt, ruleLabel, type CopyItem, type PriceRef, type ReviewLevel, type ReviewResult } from './engine';
import { Highlighted, ReviewPill, type LabModel } from './parts';

/**
 * AI 수정안 — 버튼을 누를 때만 Claude 호출(askJson). 돌아온 안은 같은 검수 규칙으로 다시 판정해 보여주고,
 * 실패 · 미연결이면 규칙 기반 수정 제안(위)을 그대로 쓴다. 자동 재시도 없음 · 중지 가능.
 */
function AiRewriteBox({ r, d, limit, onUse }: { r: ReviewResult; d: Dataset; limit?: number; onUse: (t: string) => void }) {
  const ai = useAi();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [out, setOut] = useState<{ for: string; items: { text: string; why: string; r: ReviewResult }[] } | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const runId = useRef(0);
  useEffect(() => () => { runId.current += 1; ctl.current?.abort(); }, []);
  const src = r.text;
  const run = async () => {
    if (!ai.connected || !src.trim()) return;
    const my = ++runId.current;
    ctl.current = new AbortController();
    setBusy(true);
    setNote('');
    try {
      const raw = await ai.askJson<unknown>(rewritePrompt(r, limit), { signal: ctl.current.signal });
      if (runId.current !== my) return;
      const items = parseAiRewrites(raw, src).map((x) => ({ ...x, r: reviewCopy(x.text, d, { limit }) }));
      setOut({ for: src, items });
      setNote(items.length ? `AI 수정안 ${items.length}개 — 같은 검수 규칙으로 다시 판정했습니다. 차단 안은 쓰지 않습니다.` : 'AI가 쓸 수 있는 수정안을 돌려주지 않았습니다. 위 규칙 기반 수정 제안을 사용하세요.');
    } catch (e) {
      if (runId.current !== my) return;
      const err = e as AiError;
      if (err.code !== 'cancelled') setNote(`${AI_ERROR_COPY[err.code] ?? err.message ?? 'AI 호출 실패'} 위 규칙 기반 수정 제안은 그대로 사용할 수 있습니다.`);
    } finally {
      if (runId.current === my) setBusy(false);
    }
  };
  const stop = () => { runId.current += 1; ctl.current?.abort(); setBusy(false); };
  const items = out && out.for === src ? out.items : [];
  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 6 }}>
        {busy
          ? <Button size="sm" icon="stop" onClick={stop}>중지</Button>
          : <Button size="sm" variant="accent" icon="sparkle" disabled={!ai.connected || !src.trim()} title={ai.connected ? '검수 지적을 함께 보내 같은 규칙 안에서 고쳐 쓴 안을 받습니다' : 'AI 미연결 — 규칙 기반 수정 제안을 사용하세요'} onClick={run}>{items.length ? 'AI 수정안 다시 받기' : 'AI 수정안 받기'}</Button>}
        {items.length ? <Src kind="AI" /> : null}
        {busy ? <span className="small muted">생성 중… 검수 지적과 규칙을 대조하고 있습니다.</span> : !ai.connected ? <span className="lab-sub">AI 미연결 — 규칙 기반 수정 제안(자동 치환 초안)으로 동작합니다.</span> : null}
      </div>
      {items.map((x) => (
        <div key={x.text} className="lab-todo-item">
          <ReviewPill level={x.r.level} />
          <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <strong className="small"><Highlighted text={x.text} marks={x.r.findings.map((f) => ({ match: f.match, level: f.level }))} /></strong>
            <span className="lab-sub">{x.why || 'AI 수정안'} · {charLen(x.text)}자{x.r.findings.filter((f) => f.level !== 'pass').length ? ` · 재검수 지적: ${x.r.findings.filter((f) => f.level !== 'pass').map((f) => `${f.match}(${REVIEW_LEVEL_META[f.level].label})`).join(' · ')}` : ''}</span>
          </div>
          <span className="row" style={{ gap: 4 }}>
            <CopyButton text={x.text} />
            <Button size="sm" disabled={x.r.level === 'block'} title={x.r.level === 'block' ? '재검수 차단 — 사용할 수 없습니다' : '검수 상자에 넣어 다시 검수'} onClick={() => onUse(x.text)}>검수 상자로</Button>
          </span>
        </div>
      ))}
      {note ? <div className="xs muted">{note}</div> : null}
    </div>
  );
}

type LimitMode = 'none' | 'title' | 'desc';

function ResultView({ r }: { r: ReviewResult }) {
  return (
    <div className="stack">
      <div className="lab-review-text"><Highlighted text={r.text} marks={r.findings.map((f) => ({ match: f.match, level: f.level }))} /></div>
      <div className="row" style={{ gap: 6 }}>
        <ReviewPill level={r.level} />
        <span className="small muted">{r.findings.length ? `지적 ${r.findings.length}건 · 차단 ${r.findings.filter((f) => f.level === 'block').length} · 경고 ${r.findings.filter((f) => f.level === 'warn').length} · 확인 ${r.findings.filter((f) => f.level === 'check').length}` : '지적 사항 없음 — 규칙 기준 통과 (최종 문안은 담당 AE 확인)'}</span>
      </div>
      {r.findings.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>수준</th><th>표현</th><th>사유</th><th>수정 제안</th><th>근거</th></tr></thead>
            <tbody>
              {r.findings.map((f, i) => (
                <tr key={i}>
                  <td><div className="stack-sm" style={{ gap: 2 }}><ReviewPill level={f.level} /><span className="lab-sub nowrap">{ruleLabel(f.ruleId)}</span></div></td>
                  <td><strong className="small">{f.match}</strong></td>
                  <td className="lab-basis">{f.reason}</td>
                  <td className="lab-basis">{f.suggestion || '—'}</td>
                  <td className="lab-sub">{f.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {r.changed ? (
        <Callout tone={r.suggestedLevel === 'block' ? 'critical' : r.suggestedLevel === 'warn' ? 'warning' : 'good'} title={`수정 제안 (자동 치환 초안 · 재검수 ${REVIEW_LEVEL_META[r.suggestedLevel].label})`}>
          <div className="row-between" style={{ gap: 8 }}><span>{r.suggested}</span><CopyButton text={r.suggested} /></div>
        </Callout>
      ) : r.level === 'block' || r.level === 'warn' ? <Callout tone="warning">자동 치환 대상이 아닌 지적입니다 (품절 옵션 · 글자수 등) — 문구를 직접 수정하세요.</Callout> : null}
    </div>
  );
}

export function ReviewTab({ m }: { m: LabModel }) {
  const { d, review } = m;
  const [text, setText] = useState(REVIEW_SAMPLES[0]);
  const [mode, setMode] = useState<LimitMode>('none');
  const [filter, setFilter] = useState<ReviewLevel | 'all'>('all');
  const limit = mode === 'title' ? SA_CHAR_LIMITS.title : mode === 'desc' ? SA_CHAR_LIMITS.description : undefined;
  const r = useMemo(() => reviewCopy(text, d, { limit }), [text, d, limit]);
  const refs = useMemo(() => priceReferences(d), [d]);
  const rows = review.rows.filter((x) => filter === 'all' || x.result.level === filter);

  const cols: Column<{ item: CopyItem; result: ReviewResult }>[] = [
    { key: 'level', label: '판정', sort: (x) => REVIEW_LEVEL_META[x.result.level].rank, render: (x) => <ReviewPill level={x.result.level} /> },
    { key: 'text', label: '문안', render: (x) => <div><span className="small"><Highlighted text={x.item.text} marks={x.result.findings.map((f) => ({ match: f.match, level: f.level }))} /></span><div className="lab-sub">{x.item.source}{x.item.limit ? ` · ${charLen(x.item.text)}/${x.item.limit}자` : ''}</div></div> },
    { key: 'why', label: '사유', render: (x) => x.result.findings.length ? <span className="lab-basis">{x.result.findings.filter((f) => f.level !== 'pass').map((f) => `${REVIEW_LEVEL_META[f.level].label} · ${f.match}: ${f.suggestion}`).slice(0, 3).join(' / ')}</span> : <span className="lab-sub">—</span> },
    { key: 'fix', label: '수정 제안', render: (x) => x.result.changed ? <div className="stack-sm" style={{ gap: 2 }}><span className="small">{x.result.suggested}</span><span className="lab-sub">재검수 {REVIEW_LEVEL_META[x.result.suggestedLevel].label}</span></div> : <span className="lab-sub">—</span> },
    { key: 'act', label: '', align: 'right', render: (x) => <Button size="sm" onClick={() => { setText(x.item.text); setMode(x.item.limit === SA_CHAR_LIMITS.title ? 'title' : x.item.limit === SA_CHAR_LIMITS.description ? 'desc' : 'none'); }}>상세</Button> },
  ];
  const refCols: Column<PriceRef>[] = [
    { key: 'label', label: '대조 기준', render: (p) => <span className="small">{p.label}</span> },
    { key: 'amount', label: '가격', align: 'right', sort: (p) => p.amount, render: (p) => <strong className="num small">{fmt.won(p.amount)}</strong> },
    { key: 'status', label: '상태', render: (p) => <Pill tone={p.status === 'live' ? 'good' : p.status === 'planned' ? 'warning' : p.status === 'ended' ? 'outline' : 'neutral'}>{p.status === 'live' ? `진행 중 ~${fmtDate(p.end!)}` : p.status === 'planned' ? '예정' : p.status === 'ended' ? '종료' : '정가'}</Pill> },
    { key: 'stock', label: '재고', render: (p) => (p.inStock ? <span className="lab-sub">재고 있음</span> : <Pill tone="serious">품절</Pill>) },
  ];

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card className="span-2" title="자유 입력 검수" sub="문안을 입력하면 즉시 검수합니다 · 가격 · 할인율은 상품 옵션가와 프로모션 데이터로 대조" actions={<><Src kind="PROPOSAL" page="p.27 · p.35" /><Src kind="DEMO" title="판매가 · 프로모션은 TEST DATA" /></>}>
          <textarea id="lab-review-input" className="textarea" aria-label="검수할 문안" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row-between" style={{ gap: 8 }}>
            <div className="lab-samples">
              {REVIEW_SAMPLES.map((s) => <Button key={s} size="sm" onClick={() => setText(s)}>{s.length > 18 ? `${s.slice(0, 18)}…` : s}</Button>)}
            </div>
            <Segmented options={[{ id: 'none', label: '글자수 기준 없음' }, { id: 'title', label: `제목 ${SA_CHAR_LIMITS.title}자` }, { id: 'desc', label: `설명 ${SA_CHAR_LIMITS.description}자` }]} value={mode} onChange={setMode} label="글자수 기준" />
          </div>
          <span className="lab-sub">현재 {charLen(text)}자</span>
          {text.trim() ? <ResultView r={r} /> : <span className="small muted">검수할 문안을 입력하거나 위 예시를 누르세요. 입력하는 즉시 차단 · 경고 · 확인 사유와 수정 제안을 보여줍니다.</span>}
          {text.trim() ? <AiRewriteBox r={r} d={d} limit={limit} onUse={setText} /> : null}
        </Card>
        <Card title="검수 규칙" sub="차단 → 경고 → 확인 순. 차단 문안은 테스트 카드 · 집행 등록 불가" actions={<Src kind="PROPOSAL" page="p.27 · p.35 · p.45" />}>
          <div className="stack-sm">
            {REVIEW_RULES.map((rule) => (
              <div key={rule.id} className="stack-sm" style={{ gap: 2 }}>
                <span className="row" style={{ gap: 6 }}><ReviewPill level={rule.id === 'price_claim' ? 'check' : (rule.level as ReviewLevel)} suffix={rule.id === 'price_claim' ? ' → 불일치 시 차단' : rule.id === 'superlative' ? ' → 출처 병기 시 확인' : undefined} /><strong className="small">{ruleLabel(rule.id)}</strong><span className="lab-mono">{rule.id}</span></span>
                <span className="lab-sub">{rule.reason}</span>
              </div>
            ))}
            <hr className="divider" />
            {EXTRA_REVIEW_RULES.map((rule) => (
              <div key={rule.id} className="stack-sm" style={{ gap: 2 }}>
                <span className="row" style={{ gap: 6 }}><ReviewPill level={rule.level} /><strong className="small">{ruleLabel(rule.id)}</strong><Pill tone="outline">Lab 추가</Pill></span>
                <span className="lab-sub">{rule.reason}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title={`검수 대기 · 운영 문안 ${review.total}건`} sub="가설 A · B · C · SA 캠페인 메시지(p.35) · 프로모션 소재 표기가 · VisualTune 베리에이션 초안(DEMO) · 테스트 카드 문안 · AI 문안"
        actions={<>
          <Src kind="DEMO" title="VisualTune 초안은 시연용" />
          <Segmented options={[{ id: 'all', label: `전체 ${review.total}` }, { id: 'block', label: `차단 ${review.count.block}` }, { id: 'warn', label: `경고 ${review.count.warn}` }, { id: 'check', label: `확인 ${review.count.check}` }, { id: 'pass', label: `통과 ${review.count.pass}` }]} value={filter} onChange={setFilter} label="판정 필터" />
        </>}>
        <DataTable rows={rows} columns={cols} rowKey={(x) => x.item.id} initialSort={{ key: 'level', dir: 'desc' }} maxHeight={520} />
      </Card>

      <Card title="가격 대조 기준" sub="상품 옵션 정가 + 프로모션 할인가 = 옵션가 × (1 − 할인율). 소재 표기가와 매일 대조 (p.45 가격 · 프로모션 불일치)" actions={<Src kind="DEMO" />}>
        <DataTable rows={refs} columns={refCols} rowKey={(p) => `${p.label}:${p.amount}`} maxHeight={320} />
      </Card>
    </div>
  );
}
