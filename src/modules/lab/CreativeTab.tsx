/* VisualTune OS 소재 테스트 (p.27) — 가설 A · B · C, 테스트 규칙, SA 광고 문안 생성기(p.35 캠페인 5종 × 가설, 15/45자 검사) + AI 생성 */
import { useMemo, useState } from 'react';
import type { IntentId } from '@/core/types';
import { INTENT_IDS, SA_CAMPAIGNS } from '@/data/constants';
import { useAi } from '@/ai/useAi';
import { AI_ERROR_COPY, AiError } from '@/ai/claude';
import { Button, Card, CopyButton, Pill, Segmented, Src } from '@/ui/primitives';
import { CREATIVE_RULES, HYP_IDS, HYPOTHESES, SA_CHAR_LIMITS, type HypId } from './data';
import { copyPrompt, generateSaCopies, parseAiCopies, REVIEW_LEVEL_META, reviewCopy, type ReviewLevel } from './engine';
import { setLab } from './store';
import { CardVerdictPill, ReviewPill, type LabModel } from './parts';
import type { CardDraft } from './CardsTab';

function Len({ n, max }: { n: number; max: number }) {
  return <Pill tone={n <= max ? 'outline' : 'critical'}><span className="lab-len">{n}/{max}자</span></Pill>;
}

export function CreativeTab({ m, onMakeCard, onOpenCards }: { m: LabModel; onMakeCard: (d: CardDraft) => void; onOpenCards: () => void }) {
  const { d, lab, cards, judgements } = m;
  const ai = useAi();
  const [campaign, setCampaign] = useState<IntentId>('life');
  const [hyp, setHyp] = useState<HypId>('A');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const rule = useMemo(() => generateSaCopies(d, campaign, hyp), [d, campaign, hyp]);
  const rows = useMemo(() => [...rule, ...lab.aiCopies.filter((c) => c.campaign === campaign && c.hypothesis === hyp)], [rule, lab.aiCopies, campaign, hyp]);
  const baseA = useMemo(() => generateSaCopies(d, campaign, 'A')[0], [d, campaign]);
  const creativeCards = cards.filter((c) => c.variable === '메시지');

  // 제목 · 설명을 각각 글자수 기준으로 검수하고, 더 엄한 판정을 행 판정으로 쓴다
  const reviewed = useMemo(() => rows.map((c) => {
    const rt = reviewCopy(c.title, d, { limit: SA_CHAR_LIMITS.title });
    const rd = reviewCopy(c.description, d, { limit: SA_CHAR_LIMITS.description });
    const lv: ReviewLevel = REVIEW_LEVEL_META[rt.level].rank >= REVIEW_LEVEL_META[rd.level].rank ? rt.level : rd.level;
    // 제목 · 설명에 같은 표현이 있으면 지적이 두 번 나오므로 같은 문구는 한 번만
    return { c, lv, notes: [...new Set([...rt.findings, ...rd.findings].filter((f) => f.level !== 'pass').map((f) => `${f.match} · ${REVIEW_LEVEL_META[f.level].label} · ${f.suggestion}`))] };
  }), [rows, d]);

  const runAi = async () => {
    setNote('');
    if (!ai.connected) return;
    setBusy(true);
    try {
      const raw = await ai.askJson<unknown>(copyPrompt(campaign, hyp));
      const got = parseAiCopies(raw, campaign, hyp);
      setLab((s) => ({ aiCopies: [...s.aiCopies.filter((x) => !got.some((g) => g.id === x.id)), ...got].slice(-40) }));
      setNote(`AI 문안 ${got.length}개 — 글자수 · 검수 규칙으로 자동 점검했습니다.`);
    } catch (e) {
      const err = e as AiError;
      setNote(AI_ERROR_COPY[err.code] ?? err.message ?? 'AI 호출 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        {HYP_IDS.map((id) => {
          const h = HYPOTHESES[id];
          const r = reviewCopy(h.copy, d);
          return (
            <Card key={id} title={<span className="row" style={{ gap: 10 }}><span className="lab-hyp-id">{id}</span><span>가설 {id} · {h.name}</span></span>} sub={h.focus} actions={<Src kind="PROPOSAL" page="p.27" />}>
              <div className="lab-hyp-copy">“{h.copy}”</div>
              <span className="lab-sub">{h.role}</span>
              <div className="row" style={{ gap: 6 }}><ReviewPill level={r.level} />{r.findings.map((f) => <span key={f.ruleId + f.match} className="lab-sub">{f.match}: {f.suggestion}</span>)}</div>
              {h.claimNote ? <span className="lab-basis">근거 확인 필요 · {h.claimNote}</span> : <span className="lab-sub">수치 주장 없음</span>}
            </Card>
          );
        })}
      </div>
      <div className="xs muted">예시 카피 — 소재 제작이나 DA 기획안이 아닌 테스트 설계 예시입니다. 수치 주장은 근거 확인 후 사용하고, 의료 효능 암시 표현은 검수 단계에서 제외합니다 (p.27).</div>

      <Card tone="dark" title="테스트 규칙" sub="VisualTune OS로 승인된 제품 자산의 베리에이션을 만들고, 기능 · 신뢰 · 혜택 가설을 한 번에 한 변수씩 비교합니다" actions={<><Src kind="PROPOSAL" page="p.27" />{creativeCards.length ? <Src kind="DEMO" title="진행 카드 판정은 TEST DATA" /> : null}</>}>
        <div className="lab-rules">
          {CREATIVE_RULES.map((r) => <div key={r.id} className="lab-rule"><strong>{r.label}</strong><span className="lab-sub">{r.detail}</span></div>)}
        </div>
        {creativeCards.length ? (
          <div className="stack-sm">
            {creativeCards.map((c) => {
              const j = judgements[c.id];
              return (
                <div key={c.id} className="row" style={{ gap: 8 }}>
                  <span className="lab-mono">{c.id}</span><span className="small">{c.title}</span><CardVerdictPill v={j.verdict} label={j.badge} />
                  <span className="lab-sub">{j.checks.map((x) => `${x.label} ${x.status === 'win' ? '우세' : x.status === 'lose' ? '열위' : x.status === 'tie' ? '차이 없음' : '—'}`).join(' → ')}</span>
                  <Button size="sm" onClick={onOpenCards}>카드 보기</Button>
                </div>
              );
            })}
          </div>
        ) : null}
      </Card>

      <Card title="SA 광고 문안 생성기" sub={`네이버 SA 캠페인 5종(p.35) × 가설 → 파워링크 제목 ${SA_CHAR_LIMITS.title}자 · 설명 ${SA_CHAR_LIMITS.description}자 (공백 포함 · 매체 최신 정책 확인) · 모든 문안 자동 검수`}
        actions={<><Src kind="PROPOSAL" page="p.27 · p.35" /><Src kind="DEMO" title="기획전 가격 · 재고는 TEST DATA에서 계산" /><Button size="sm" variant="accent" icon="sparkle" disabled={!ai.connected || busy} title={ai.connected ? undefined : 'AI 미연결 — 규칙 기반 문안만 생성'} onClick={runAi}>{busy ? '생성 중…' : 'AI로 문안 생성'}</Button></>}>
        <div className="row" style={{ gap: 12 }}>
          <Segmented options={INTENT_IDS.map((i) => ({ id: i, label: SA_CAMPAIGNS[i].name }))} value={campaign} onChange={setCampaign} label="캠페인" />
          <Segmented options={HYP_IDS.map((h) => ({ id: h, label: `${h} · ${HYPOTHESES[h].name}` }))} value={hyp} onChange={setHyp} label="가설" />
        </div>
        <div className="lab-sub">캠페인 메시지 예시: “{SA_CAMPAIGNS[campaign].message}” · 랜딩 {SA_CAMPAIGNS[campaign].landing} · 지표 {SA_CAMPAIGNS[campaign].metric}</div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>제목</th><th className="r">제목 자수</th><th>설명</th><th className="r">설명 자수</th><th>검수</th><th>출처</th><th /></tr></thead>
            <tbody>
              {reviewed.map(({ c, lv, notes }) => {
                return (
                  <tr key={c.id}>
                    <td><strong className="small">{c.title}</strong></td>
                    <td className="r"><Len n={c.titleLen} max={SA_CHAR_LIMITS.title} /></td>
                    <td className="small">{c.description}</td>
                    <td className="r"><Len n={c.descLen} max={SA_CHAR_LIMITS.description} /></td>
                    <td><div className="stack-sm" style={{ gap: 2 }}><ReviewPill level={lv} />{notes.slice(0, 2).map((n) => <span key={n} className="lab-sub">{n}</span>)}</div></td>
                    <td>{c.source === 'ai' ? <Src kind="AI" /> : <Pill tone="outline">규칙</Pill>}</td>
                    <td className="r">
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <CopyButton text={`${c.title}\n${c.description}`} />
                        <Button size="sm" icon="lab" disabled={lv === 'block'} title={lv === 'block' ? '검수 차단 문안은 테스트 카드로 만들 수 없습니다' : undefined}
                          onClick={() => onMakeCard({
                            title: `${SA_CAMPAIGNS[campaign].name} 문안 · 가설 A vs ${c.hypothesis}`,
                            hypothesis: `${SA_CAMPAIGNS[campaign].name} 키워드에서 ${HYPOTHESES[c.hypothesis].name} 문안이 기능 중심 문안보다 클릭률을 높이고 전환율은 유지한다`,
                            variable: '메시지', media: '네이버 SA', intent: campaign,
                            control: `${baseA.title} · ${baseA.description}`, variant: `${c.title} · ${c.description}`, primary: 'ctr',
                          })}>A/B 카드로</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {note ? <div className="small">{note}</div> : null}
        {!ai.connected ? <div className="small muted">AI 미연결 — 규칙 기반 문안(캠페인 핵심어 · p.35 메시지 · 진행 중 기획전 가격)만 생성합니다. 가격은 판매가 데이터로 계산해 넣습니다.</div> : null}
        {lab.aiCopies.length ? <div className="row"><span className="lab-sub">AI 문안 {lab.aiCopies.length}개 저장됨 (검수 탭 대기 문안에 포함)</span><Button size="sm" icon="x" onClick={() => setLab({ aiCopies: [] })}>AI 문안 지우기</Button></div> : null}
      </Card>
    </div>
  );
}
