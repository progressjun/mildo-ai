/* AEO 콘텐츠 — 경도 · 소재 · 사이즈 · 선택 기준 FAQ 초안 (규칙 템플릿 + AI) → REVIEW_RULES 검수 → FAQPage JSON-LD */
import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Dataset } from '@/core/types';
import { useAi } from '@/ai/useAi';
import { AI_ERROR_COPY, type AiError } from '@/ai/claude';
import { uid } from '@/core/util';
import { Button, Callout, Card, CopyButton, DownloadButton, Empty, Pill, Segmented, Src, Toggle } from '@/ui/primitives';
import { AEO_TOPICS, GEO_RULES, type AeoTopicId } from './data';
import {
  buildFaqDraft, dateLabel, DENIED_CODES, faqAiPrompt, faqJsonLd, faqMarkdown, livePromotion, QUERY_BY_ID, sanitizeAiFaq, TOPIC_LABEL,
  type FaqItem, type FaqReviewed, type Visibility, type faqCoverage,
} from './engine';
import { ReviewHits, VerdictBadge } from './parts';

type TopicFilter = 'all' | AeoTopicId;

export function FaqTab({ d, onItems, reviewed, cov, vis }: {
  d: Dataset; items: FaqItem[]; onItems: Dispatch<SetStateAction<FaqItem[]>>; reviewed: FaqReviewed[]; cov: ReturnType<typeof faqCoverage>; vis: Visibility;
}) {
  const ai = useAi();
  const [topic, setTopic] = useState<TopicFilter>('all');
  const [onlyPub, setOnlyPub] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [blocked, setBlocked] = useState(false);
  const usable = ai.connected && !blocked;
  const ctl = useRef<AbortController | null>(null);
  const ld = useMemo(() => faqJsonLd(reviewed, onlyPub), [reviewed, onlyPub]);
  const rule = useMemo(() => buildFaqDraft(d), [d]);
  const shown = reviewed.filter((i) => topic === 'all' || i.topic === topic);
  const soldOut = (d.products[0]?.options ?? []).filter((o) => !o.inStock).map((o) => o.label);
  const promo = livePromotion(d, 'brandstore');

  // 함수형 업데이트 — AI 초안 생성 중에 편집한 내용이 응답 도착 시 덮어써지지 않도록
  const patch = (id: string, p: Partial<FaqItem>) => onItems((cur) => cur.map((i) => (i.id === id ? { ...i, ...p, source: i.source === 'rule' ? 'edited' : i.source } : i)));
  const remove = (id: string) => onItems((cur) => cur.filter((i) => i.id !== id));
  const restore = (id: string) => {
    const r = rule.find((x) => x.id === id);
    if (r) onItems((cur) => cur.map((i) => (i.id === id ? r : i)));
  };
  const add = () => onItems((cur) => [...cur, { id: uid('faq'), topic: topic === 'all' ? 'criteria' : topic, q: '', a: '', source: 'edited', queries: [] }]);

  const running = useRef(false);
  const generate = async () => {
    if (!usable || running.current) return;
    running.current = true;
    setBusy(true);
    setNote('');
    ctl.current = new AbortController();
    try {
      // 같은 질의 · 상품 정보면 프롬프트가 같다 — 기본 캐시(5분)면 '다시 시도'가 같은 (형식 오류) 응답을 돌려받으므로 끈다
      const raw = await ai.askJson<unknown>(faqAiPrompt(d, vis), { signal: ctl.current.signal, cache: false });
      const got = sanitizeAiFaq(raw);
      if (!got.length) setNote('AI 응답에서 FAQ 문항을 읽지 못했습니다. 다시 시도하세요.');
      else {
        onItems((cur) => [...cur.filter((i) => i.source !== 'ai'), ...got]);
        setNote(`AI 초안 ${got.length}개를 추가했습니다. 모든 문항은 같은 검수 규칙을 통과해야 게시 가능으로 표시됩니다.`);
      }
    } catch (e) {
      const err = e as AiError;
      if (DENIED_CODES.has(err.code)) { setBlocked(true); setNote(''); }
      else if (err.code !== 'cancelled') setNote(AI_ERROR_COPY[err.code] ?? err.message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <Card title="주제 커버리지 · 약한 질의 대응" sub={`핵심 4개 주제(p.29) 중 게시 가능 문항이 있는 주제 ${cov.coreCovered}/${cov.coreTotal} · 기준 4/4`} actions={<Src kind="PROPOSAL" page="p.29" />}>
        <div className="geo-topics">
          {cov.topics.map((t) => (
            <div key={t.id} className="geo-topic">
              <span className="small"><strong>{t.label}</strong>{t.core ? '' : <span className="muted"> · 보조</span>}</span>
              <span className="num" style={{ fontSize: 'var(--fs-xl)', fontWeight: 900 }}>{t.publishable}<span className="muted small"> / {t.total}</span></span>
              <span className="geo-basis">게시 가능 / 초안</span>
            </div>
          ))}
        </div>
        <div className="stack-sm">
          <span className="small">GEO 매트릭스에서 확보 기준(≥{Math.min(GEO_RULES.coveredEngines, vis.engines.length || GEO_RULES.coveredEngines)}/{vis.engines.length} 엔진) 미달 · 경쟁사 우위 질의 <strong>{cov.weak.length}개</strong> <span className="muted">· {dateLabel(vis.date ?? d.today)} 진단 (TEST DATA)</span></span>
          <div className="geo-chips">
            {cov.covered.map((q) => <Pill key={q.query.id} tone="good" icon="check" title="게시 가능 FAQ로 대응">{q.query.text}</Pill>)}
            {cov.drafted.map((q) => <Pill key={q.query.id} tone="warning" title="초안은 있으나 입력 · 검수 남음">{q.query.text}</Pill>)}
            {cov.uncovered.map((q) => <Pill key={q.query.id} tone="serious" icon="alert" title="대응 FAQ 없음">{q.query.text}</Pill>)}
          </div>
          <span className="geo-basis">초록 = 게시 가능 FAQ로 대응 {cov.covered.length} · 노랑 = 초안만 있음 {cov.drafted.length} · 주황 = 대응 FAQ 없음 {cov.uncovered.length}</span>
        </div>
      </Card>

      {soldOut.length || promo ? (
        <Callout tone="info" title="운영 데이터 대조 (TEST DATA)">
          {soldOut.length ? `${soldOut.join(' · ')} 옵션 품절 — FAQ 답변에 재고 표현을 쓰지 않고 상품 페이지 확인으로 안내합니다. ` : ''}
          {promo ? `${promo.name} ${promo.discountRate}% 진행 중(~${dateLabel(promo.end, false)}) — FAQ에는 정가만 쓰고 기획전 판매가는 상품 페이지로 안내합니다 (가격 불일치 방지).` : ''}
        </Callout>
      ) : null}

      <div className="grid g-3">
        <Card className="span-2" title="FAQ 초안 · 검수" sub="규칙 기반 템플릿 · 사이즈 · 정가는 운영 데이터에서 · 확인되지 않은 사양은 [입력] 자리표시 (게시 보류)"
          actions={<><Src kind="DEMO" title="사이즈 · 정가 · 재고는 시연용 테스트 데이터" /><Button size="sm" icon="plus" onClick={add}>문항 추가</Button></>}>
          <Segmented label="주제" value={topic} onChange={setTopic} options={[{ id: 'all', label: `전체 ${reviewed.length}` }, ...AEO_TOPICS.map((t) => ({ id: t.id, label: `${t.label} ${reviewed.filter((i) => i.topic === t.id).length}` }))]} />
          {shown.length ? shown.map((i) => (
            <div key={i.id} className={`geo-faq ${i.status.id}`}>
              <div className="row-between">
                <div className="row" style={{ gap: 6 }}>
                  <Pill tone="outline">{TOPIC_LABEL[i.topic]}</Pill>
                  {i.source === 'ai' ? <Src kind="AI" /> : <Pill tone="neutral">{i.source === 'rule' ? '규칙 초안' : '수정됨'}</Pill>}
                  <VerdictBadge v={i.status} inline />
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {i.source === 'edited' && rule.some((r) => r.id === i.id) ? <Button size="sm" variant="ghost" icon="rollback" onClick={() => restore(i.id)}>초안으로</Button> : null}
                  {i.source !== 'rule' && !rule.some((r) => r.id === i.id) ? <Button size="sm" variant="ghost" icon="x" onClick={() => remove(i.id)}>삭제</Button> : null}
                </div>
              </div>
              <input id={`geo-faq-q-${i.id}`} className="input" aria-label={`질문 · ${TOPIC_LABEL[i.topic]}`} value={i.q} placeholder="질문" onChange={(e) => patch(i.id, { q: e.target.value })} />
              <textarea id={`geo-faq-a-${i.id}`} className="textarea" aria-label={`답변 · ${i.q || TOPIC_LABEL[i.topic]}`} value={i.a} placeholder="답변 (소비자에게 보이는 문장)" onChange={(e) => patch(i.id, { a: e.target.value })} />
              {i.placeholders.length ? <div className="geo-chips">{i.placeholders.map((p, k) => <Pill key={`${p}${k}`} tone="warning">{p}</Pill>)}</div> : null}
              <ReviewHits hits={i.hits} />
              {i.queries.length ? <div className="geo-basis">대응 질의: {i.queries.map((q) => QUERY_BY_ID[q]?.text).filter(Boolean).join(' · ')}</div> : null}
            </div>
          )) : <Empty icon="inbox" title="이 주제의 문항이 없습니다" />}
        </Card>

        <div className="stack-lg">
          <Card title="FAQPage JSON-LD" sub={`포함 ${ld.included}개 · 제외 ${ld.excluded}개`} actions={<><CopyButton text={ld.json} label="JSON-LD 복사" /><DownloadButton filename={`mildo-faq-${d.today}.json`} data={ld.json} mime="application/ld+json;charset=utf-8" label=".json" /></>}>
            <Toggle id="geo-faq-pub" checked={onlyPub} onChange={setOnlyPub} label="게시 가능 문항만 (차단 · 경고 · 미입력 제외)" />
            <pre className="geo-code" aria-label="FAQPage JSON-LD">{`<script type="application/ld+json">\n${ld.json}\n</script>`}</pre>
            {!onlyPub && ld.included > cov.publishable ? <div className="xs" style={{ color: 'var(--warning-ink)' }}>검수 미통과 문항이 포함되어 있습니다. 게시용으로 쓰지 마세요.</div> : null}
            <div className="row" style={{ gap: 6 }}><CopyButton text={() => faqMarkdown(reviewed)} label="FAQ 문서 복사 (.md)" /></div>
          </Card>

          <Card title={<span className="row" style={{ gap: 6 }}>AI로 FAQ 초안 추가<Src kind="AI" /></span>} sub="규칙 초안과 같은 검수(REVIEW_RULES)를 거칩니다">
            <div className="small ink2">약한 질의 {cov.weak.length}개와 확인된 상품 정보(사이즈 · 정가 · 재고)만 전달합니다. 확인되지 않은 사양은 [입력]으로 남기도록 지시합니다.</div>
            {/* 생성 중에도 시작 버튼은 제자리에서 비활성 — 빠른 두 번 클릭의 두 번째가 '중지'에 떨어져 방금 시작한 생성을 취소하지 않도록 */}
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="accent" icon="sparkle" disabled={!usable || busy} onClick={generate}
                title={usable ? undefined : blocked ? 'Claude 사용이 허용되지 않음 — 규칙 초안으로 계속' : 'AI 미연결 — 설정에서 API 키를 입력하거나 claude.ai 아티팩트에서 실행'}>AI 초안 생성</Button>
              {busy ? <Button size="sm" icon="stop" onClick={() => ctl.current?.abort()}>중지</Button> : null}
            </div>
            {blocked ? <div className="xs muted">Claude 사용이 허용되지 않아 AI 초안을 만들 수 없습니다. 규칙 초안과 직접 편집으로 계속합니다.</div>
              : !ai.connected ? <div className="xs muted">{ai.backend === 'checking' ? 'AI 연결 상태 확인 중' : 'AI 미연결 — 규칙 초안만 사용합니다. 설정에서 API 키를 입력하거나 claude.ai 아티팩트에서 열면 사용할 수 있습니다.'}</div> : null}
            {busy ? <div className="xs muted">Claude가 FAQ 초안을 작성 중입니다.</div> : null}
            {note ? <div className="xs">{note}</div> : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
