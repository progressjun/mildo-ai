/* 신규 요청 폼 — 예산 · 세팅 변경 요청 → 승인 주체 자동 결정 (GFA_DELEGATION p.15 · DECISION_MATRIX p.53) */
import { useMemo } from 'react';
import type { MediaId } from '@/core/types';
import { DECISION_MATRIX, GFA_DELEGATION, MEDIA, MEDIA_IDS } from '@/data/constants';
import { fmt } from '@/core/util';
import { Button, Callout, Card, Field, NumberInput, Pill, Segmented, Src } from '@/ui/primitives';
import { REQUEST_TYPES, type RequestType } from './data';
import { APPROVER_LABEL, canAct, effectiveBid, effectiveBudget, fmtValue, paceCampaign, planRequest, type RequestDraft, fmtHour } from './engine';
import type { FlowCtx } from './useFlow';

export function RequestTab({ ctx, draft, setDraft, onCreated }: { ctx: FlowCtx; draft: RequestDraft; setDraft: (d: RequestDraft) => void; onCreated: (id: string) => void }) {
  const { data, changes, incidents, state, createRequest, apCfg } = ctx;
  const plan = useMemo(() => planRequest(data, changes, incidents, draft, state.role), [data, changes, incidents, draft, state.role]);
  const def = REQUEST_TYPES.find((t) => t.id === draft.type) ?? REQUEST_TYPES[0];
  const set = (patch: Partial<RequestDraft>) => setDraft({ ...draft, ...patch });
  const campaigns = (data.campaigns ?? []).filter((c) => !draft.media || c.media === draft.media);
  const keywords = data.keywords ?? [];
  const promo = draft.promoId ? data.promotions.find((p) => p.id === draft.promoId) : undefined;
  const inc = draft.incidentId ? incidents.find((i) => i.id === draft.incidentId) : undefined;
  const perm = canAct(state.role, plan.route.approver);
  const submit = () => {
    if (!plan.input) return;
    const c = createRequest(plan.input);
    onCreated(c.id);
  };

  const targetPicker = () => {
    if (draft.type === 'bid') {
      return (
        <Field label="키워드 (네이버 SA)" id="flow-kw">
          <select id="flow-kw" className="select" value={draft.targetId} onChange={(e) => set({ targetId: e.target.value })}>
            <option value="">선택</option>
            {keywords.map((k) => <option key={k.id} value={k.id}>{k.text} · 현재 {fmt.won(effectiveBid(k, changes))} · 상한 {fmt.won(k.maxBid)}{k.isBrand ? ' · 브랜드' : ''}</option>)}
          </select>
        </Field>
      );
    }
    if (draft.type === 'budget' || draft.type === 'onoff') {
      return (
        <>
          <Field label="매체" id="flow-media">
            <select id="flow-media" className="select" value={draft.media} onChange={(e) => set({ media: e.target.value as MediaId, targetId: '', promoId: undefined })}>
              <option value="">전체</option>
              {MEDIA_IDS.map((m) => <option key={m} value={m}>{MEDIA[m].name}</option>)}
            </select>
          </Field>
          <Field label={draft.type === 'onoff' ? '대상 캠페인 · 키워드' : '대상 캠페인'} id="flow-target">
            <select id="flow-target" className="select" value={draft.targetId} onChange={(e) => set({ targetId: e.target.value, promoId: draft.type === 'budget' && e.target.value ? undefined : draft.promoId })}>
              <option value="">{promo && draft.type === 'budget' ? `${promo.name} 관련 캠페인 전체` : '선택'}</option>
              {campaigns.map((c) => {
                const pace = paceCampaign(data, c, changes);
                return <option key={c.id} value={c.id}>{c.name} · 일 예산 {fmt.krw(effectiveBudget(c, changes))}{pace.exhaustHour !== null ? ` · 예상 마감 ${fmtHour(pace.exhaustHour)}` : ''}</option>;
              })}
              {draft.type === 'onoff' ? keywords.filter((k) => !draft.media || draft.media === 'naver_sa').map((k) => <option key={k.id} value={k.id}>키워드 · {k.text}</option>) : null}
            </select>
          </Field>
        </>
      );
    }
    if (draft.type === 'new_campaign') {
      return (
        <>
          <Field label="매체" id="flow-media2">
            <select id="flow-media2" className="select" value={draft.media} onChange={(e) => set({ media: e.target.value as MediaId })}>
              <option value="">선택</option>
              {MEDIA_IDS.map((m) => <option key={m} value={m}>{MEDIA[m].name}</option>)}
            </select>
          </Field>
          <Field label="캠페인 이름" id="flow-name"><input id="flow-name" className="input" value={draft.targetText} placeholder="예: GFA_11월 기획전 쇼핑 고객 확장" onChange={(e) => set({ targetText: e.target.value })} /></Field>
          <Field label="일 예산 (원)" id="flow-nb"><input id="flow-nb" className="input num" inputMode="numeric" value={draft.afterText} placeholder="1000000" onChange={(e) => set({ afterText: e.target.value })} /></Field>
        </>
      );
    }
    if (draft.type === 'keyword') {
      return (
        <>
          <Segmented label="키워드 요청" value={draft.keywordMode} onChange={(v) => set({ keywordMode: v })} options={[{ id: 'add', label: '테스트 그룹 등록' }, { id: 'exclude', label: '제외 키워드 등록' }]} />
          <Field label="키워드" id="flow-kwt"><input id="flow-kwt" className="input" value={draft.targetText} placeholder="예: 신혼집 매트리스 퀸 킹 고민" onChange={(e) => set({ targetText: e.target.value })} /></Field>
        </>
      );
    }
    const ph: Record<string, [string, string, string]> = {
      creative: ['교체할 소재 · 랜딩', '변경 후 문구 또는 URL', '예: GFA 쇼핑 고객 확장 · 가격형'],
      alert_rule: ['기준 이름', '변경 후 기준값', '예: Meta 광고비 급변 주의 임계'],
      strategy: ['전략 방향 · 재배분 내용', '변경 후 계획', '예: 12월 GFA → SA 브랜드 방어 5%p 재배분'],
    };
    const [l1, l2, p1] = ph[draft.type] ?? ['대상', '변경 후', ''];
    return (
      <>
        <Field label={l1} id="flow-tt"><input id="flow-tt" className="input" value={draft.targetText} placeholder={p1} onChange={(e) => set({ targetText: e.target.value })} /></Field>
        <div className="grid g-2" style={{ gap: 8 }}>
          <Field label="변경 전" id="flow-bt"><input id="flow-bt" className="input" value={draft.beforeText} placeholder="현재 값" onChange={(e) => set({ beforeText: e.target.value })} /></Field>
          <Field label={l2} id="flow-at"><input id="flow-at" className="input" value={draft.afterText} placeholder={draft.type === 'creative' ? '예: 혼수 매트리스 퀸 841,500원 · 기획전 15%' : ''} onChange={(e) => set({ afterText: e.target.value })} /></Field>
        </div>
      </>
    );
  };

  return (
    <div className="grid g-2">
      <Card title="예산 · 세팅 변경 요청" sub="매체 · 대상 · 변경 내용 · 변경 폭 · 사유를 넣으면 승인 주체가 자동으로 정해집니다 (메신저 요청 → 확인 → 반영 → 재확인 구간 축소, p.31)"
        actions={<><Src kind="PROPOSAL" page="p.15" /><Src kind="PROPOSAL" page="p.53" /></>}>
        {promo || inc ? (
          <Callout tone="accent" title="연결된 조치 요청">
            {promo ? <div>프로모션 {promo.name} 체크리스트에서 연결</div> : null}
            {inc ? <div>{inc.severity} {inc.title} (MILDO Alert)</div> : null}
          </Callout>
        ) : null}
        <Field label="요청 유형" id="flow-type">
          <select id="flow-type" className="select" value={draft.type} onChange={(e) => set({ type: e.target.value as RequestType, targetId: '', targetText: '', beforeText: '', afterText: '' })}>
            {REQUEST_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
        <div className="xs muted">{def.basis} ({def.page})</div>
        {targetPicker()}
        {def.needsPct ? (
          <Field label="변경 폭" id="flow-pct" hint={draft.type === 'bid' ? `일 조정 폭 상한 ±${apCfg.dailyChangeCapPct}% (p.14 SAFETY · AD Pilot 공식 기준)` : '±10% 이내 담당 AE · ±10~30% PM · 30% 초과 수면밀도 (p.15 예시)'}>
            <NumberInput id="flow-pct" value={draft.pct} onChange={(v) => set({ pct: v })} step={5} min={-99} max={100} suffix="%" />
          </Field>
        ) : null}
        {draft.type === 'onoff' ? <Segmented label="상태" value={draft.toStatus} onChange={(v) => set({ toStatus: v })} options={[{ id: 'off', label: 'OFF (일시 중지)' }, { id: 'on', label: 'ON (재개)' }]} /> : null}
        <Field label="사유 (누가 · 왜 기록)" id="flow-reason">
          <textarea id="flow-reason" className="textarea" value={draft.reason} placeholder="예: 기획전 기간 피크 시간대(21시) 전 소진 — 저녁 노출 확보" onChange={(e) => set({ reason: e.target.value })} />
        </Field>
        <div className="row">
          <Button variant="primary" icon="send" disabled={!plan.ok} onClick={submit}>승인 요청 생성 (pending)</Button>
          <Button variant="ghost" onClick={() => setDraft({ ...draft, targetId: '', targetText: '', beforeText: '', afterText: '', reason: '', promoId: undefined, incidentId: undefined })}>초기화</Button>
        </div>
        <div className="xs muted">요청은 승인 대기(pending)로만 만들어지고, 반영은 승인 주체가 승인한 뒤 실행 점검을 통과해야 합니다. 요청자: {state.role}.</div>
      </Card>

      <div className="stack-lg">
        <Card tone="dark" title="승인 주체 자동 결정" sub="제출 전 미리보기 · 현재 값은 반영 이력 기준" actions={<Src kind="DEMO" />}>
          <div className="row" style={{ gap: 8 }}>
            <span className="flow-big-approver">{APPROVER_LABEL[plan.route.approver]}</span>
            <Pill tone={perm.ok ? 'good' : 'neutral'} icon={perm.ok ? 'check' : 'x'}>{perm.ok ? `현재 역할(${state.role})이 직접 승인 가능` : `현재 역할(${state.role}) 승인 범위 밖`}</Pill>
          </div>
          <ul className="flow-basis">
            {plan.route.basis.map((b, k) => <li key={k} className="small">{b}</li>)}
          </ul>
          <div className="flow-preview num">
            <span className="muted">{plan.targetLabel || '대상 미선택'}</span>
            <strong>{fmtValue({ kind: def.kind }, plan.before)} → {fmtValue({ kind: def.kind }, plan.after)}</strong>
          </div>
        </Card>
        {plan.errors.length ? <Callout tone="critical" title={`제출 불가 ${plan.errors.length}건`}>{plan.errors.map((e, k) => <div key={k}>{e}</div>)}</Callout> : null}
        {plan.warnings.length ? <Callout tone="warning" title={`확인 필요 ${plan.warnings.length}건`}>{plan.warnings.map((e, k) => <div key={k}>{e}</div>)}</Callout> : null}
        {!plan.errors.length && !plan.warnings.length ? <Callout tone="good" title="검증 통과">사유 · 대상 · 변경 폭 확인 완료. 실행 점검(계정 잔액 · 데이터 이상)에서도 보류 예상 없음.</Callout> : null}
        <Card title="위임 범위 · 결정 유형" sub="해당 행 강조 · 위임 범위는 예시이며 계약 시 확정" actions={<><Src kind="PROPOSAL" page="p.15" /><Src kind="PROPOSAL" page="p.53" /></>}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>변경 범위 (p.15)</th><th>승인 주체</th></tr></thead>
              <tbody>{GFA_DELEGATION.map((g, k) => <tr key={g.range} className={plan.route.delegationIndex === k ? 'selected' : undefined}><td className="small">{g.range}</td><td className="small">{g.label}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>결정 유형 (p.53)</th><th>결정자</th><th>소요</th></tr></thead>
              <tbody>{DECISION_MATRIX.map((d, k) => <tr key={d.type} className={plan.route.decisionIndex === k ? 'selected' : undefined}><td className="small">{d.type}</td><td className="small">{d.decider}</td><td className="small">{d.lead}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
