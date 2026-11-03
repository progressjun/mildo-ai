import { useMemo, useState, type MouseEvent } from 'react';
import type { ChangeRequest } from '@/core/types';
import { CRITICAL_ISSUE_TYPES, DECISION_MATRIX, EXTRA_DETECTORS } from '@/data/constants';
import { Button, Callout, Card, DataTable, Field, NumberInput, Pill, Sev, Src, type Column } from '@/ui/primitives';
import {
  activeConfig, CONFIG_FIELDS, detectIncidents, encodeThreshold, falsePositiveByMetric, fmtStamp, historyRecords, typeOf, type AlertConfig, type MetricKey, type Threshold,
} from './engine';
import { DEMO_CREATIVES, RULES, TYPE_LABEL } from './data';
import { ChangeStatusPill, LevelPill } from './parts';
import { canApprove, type AlertCtx } from './hooks';

const ANOMALY_RULES = ['data_spike', 'anomaly_warn', 'tracking_break', 'keyword_spike', 'invalid_traffic'];
/** p.44 행 ↔ p.45 추가 탐지 유형 묶음 (품절 페이지 · 가격 불일치는 소재 · 랜딩, 추적 단절 · 무효 트래픽은 데이터 급변 행에 함께 집계) */
/** 소재 검수 · 랜딩 규칙 — 화면의 점검 대상은 시연용 예시 소재 목록(DEMO_CREATIVES)이다 */
const CREATIVE_RULES = new Set(['creative_rejected', 'creative_pending', 'landing_error']);
const TYPE_GROUP: Record<string, string[]> = { creative_landing: ['creative_landing', 'soldout_landing', 'price_mismatch'], data_spike: ['data_spike', 'tracking_break', 'invalid_traffic'], ad_off: ['ad_off', 'bulk_change'] };
type Draft = Record<string, Threshold | number>;
const draftOf = (cfg: AlertConfig): Draft => Object.fromEntries(CONFIG_FIELDS.map((f) => [f.key, f.kind === 'threshold' ? { ...cfg.thresholds[f.key as MetricKey] } : (cfg as unknown as Record<string, number>)[f.key]]));
const enc = (v: Threshold | number, unit: string) => (typeof v === 'number' ? `${v}${unit}` : encodeThreshold(v));

export function RulesTab({ ctx }: { ctx: AlertCtx }) {
  const { incidents, data, cfg, state, actions, toMs } = ctx;
  const [draft, setDraft] = useState<Draft>(() => draftOf(cfg));
  const [reason, setReason] = useState('');
  const open = incidents.filter((i) => i.status !== 'resolved');
  const countType = (t: string) => open.filter((i) => typeOf(i) === t).length;
  const fp = useMemo(() => falsePositiveByMetric(historyRecords()), []);

  const draftCfg: AlertConfig = useMemo(() => {
    const c = { ...cfg, thresholds: { ...cfg.thresholds } };
    for (const f of CONFIG_FIELDS) {
      const v = draft[f.key];
      if (f.kind === 'threshold') c.thresholds[f.key as MetricKey] = v as Threshold;
      else (c as unknown as Record<string, number>)[f.key] = v as number;
    }
    return c;
  }, [draft, cfg]);
  const invalid = CONFIG_FIELDS.filter((f) => {
    const v = draft[f.key];
    if (typeof v === 'number') return !(v >= f.min && v <= f.max);
    return !(v.warn >= f.min && v.danger <= f.max && v.danger >= v.warn);
  });
  const changed = CONFIG_FIELDS.filter((f) => enc(draft[f.key], f.unit) !== enc(draftOf(cfg)[f.key], f.unit));
  const ruleChanges = state.changes.filter((c) => c.kind === 'alert_rule');
  /** 같은 기준 · 같은 변경안이 이미 승인 대기 · 반영 대기면 다시 요청하지 않는다 (중복 요청 방지) */
  const openSame = (f: (typeof CONFIG_FIELDS)[number]) => ruleChanges.find((c) => c.targetId === `alert_rule:${f.key}` && (c.status === 'pending' || c.status === 'approved') && String(c.after) === enc(draft[f.key], f.unit));
  const dupes = changed.filter((f) => openSame(f));
  const toSubmit = changed.filter((f) => !openSame(f));
  const canSubmit = toSubmit.length > 0 && invalid.length === 0 && reason.trim().length > 0;
  const nowCount = useMemo(() => detectIncidents(data, { config: cfg, creatives: DEMO_CREATIVES }).filter((i) => ANOMALY_RULES.includes(i.ruleId)).length, [data, cfg]);
  const draftCount = useMemo(() => (invalid.length ? NaN : detectIncidents(data, { config: draftCfg, creatives: DEMO_CREATIVES }).filter((i) => ANOMALY_RULES.includes(i.ruleId)).length), [data, draftCfg, invalid.length]);

  const canPm = canApprove(state.role, 'PM');

  const submit = () => {
    const cur = draftOf(cfg);
    if (!canSubmit) return;
    for (const f of toSubmit) {
      const before = enc(cur[f.key], f.unit);
      const after = enc(draft[f.key], f.unit);
      const bv = typeof cur[f.key] === 'number' ? (cur[f.key] as number) : (cur[f.key] as Threshold).danger;
      const av = typeof draft[f.key] === 'number' ? (draft[f.key] as number) : (draft[f.key] as Threshold).danger;
      actions.addChange({
        module: 'alert', kind: 'alert_rule', target: `탐지 기준 · ${f.label}`, targetId: `alert_rule:${f.key}`,
        before, after, changePct: bv ? ((av - bv) / bv) * 100 : undefined,
        reason: `${reason.trim()} · 미리보기: 이상 징후 이슈 ${nowCount}건 → ${draftCount}건 (${f.page})`,
        requestedBy: state.role, approver: 'PM',
      });
    }
    actions.toast({ tone: 'info', title: `탐지 기준 변경 요청 ${toSubmit.length}건`, body: '승인 주체 PM (p.53 알림 · 시스템 기준: 개발자 + PM) · MILDO Flow에서도 처리 가능', route: 'flow' });
    setReason('');
  };

  const applyAndScan = (c: ChangeRequest) => {
    actions.updateChange(c.id, { status: 'applied' }, '반영', '탐지 기준 적용 · 재스캔');
    const next = activeConfig(state.changes.map((x) => (x.id === c.id ? { ...x, status: 'applied' as const } : x)));
    const found = detectIncidents(data, { config: next, creatives: DEMO_CREATIVES });
    const fresh = found.filter((f) => !state.incidents.some((i) => i.id === f.id));
    fresh.forEach((i) => actions.addIncident(i));
    actions.toast({ tone: 'good', title: '탐지 기준 반영 · 재스캔', body: `${c.target}: ${c.before} → ${c.after} · 신규 이슈 ${fresh.length}건`, route: 'alert' });
  };

  /**
   * 더블클릭의 두 번째 클릭(e.detail > 1)은 무시한다 — 승인 → 반영 → 롤백 버튼이 같은 자리에 차례로 나타나
   * 더블클릭 한 번에 '승인 + 반영'(또는 '반영 + 롤백')이 함께 실행되던 문제. 키보드 실행(detail 0)은 그대로.
   */
  const once = (fn: () => void) => (e: MouseEvent) => { if (e.detail > 1) return; fn(); };

  const changeCols: Column<ChangeRequest>[] = [
    { key: 'at', label: '요청', render: (c) => <span className="num xs">{fmtStamp(toMs(c.createdAt))}<div className="muted">{c.requestedBy}</div></span>, width: 100 },
    { key: 't', label: '대상', render: (c) => <span className="small">{c.target}</span> },
    { key: 'ba', label: '변경', render: (c) => <span className="xs num">{String(c.before)} → <strong>{String(c.after)}</strong></span> },
    { key: 'r', label: '사유', render: (c) => <span className="xs muted">{c.reason}</span> },
    { key: 's', label: '상태', render: (c) => <ChangeStatusPill status={c.status} /> },
    {
      key: 'a', label: '처리 (승인 PM)', render: (c) => (
        <div className="row" style={{ gap: 4 }}>
          {c.status === 'pending' ? (
            <>
              <Button size="sm" variant="primary" disabled={!canPm} title={!canPm ? `현재 역할(${state.role})은 PM 승인 건을 처리할 수 없음` : undefined} onClick={once(() => actions.updateChange(c.id, { status: 'approved' }, '승인'))}>승인</Button>
              <Button size="sm" variant="ghost" disabled={!canPm} onClick={once(() => actions.updateChange(c.id, { status: 'rejected' }, '반려'))}>반려</Button>
            </>
          ) : null}
          {c.status === 'approved' ? <Button size="sm" variant="primary" disabled={!canPm} onClick={once(() => applyAndScan(c))}>반영</Button> : null}
          {c.status === 'applied' ? <Button size="sm" icon="rollback" disabled={!canPm} onClick={once(() => actions.updateChange(c.id, { status: 'rolled_back' }, '롤백', '이전 기준으로 복원'))}>롤백</Button> : null}
          {!canPm && (c.status === 'pending' || c.status === 'approved') ? <span className="xs muted">PM · 수면밀도만 처리</span> : null}
        </div>
      ),
    },
  ];

  const scopeOf: Record<string, string> = {
    campaign_off: `캠페인 ${data.campaigns.length}개`, budget_exhausted: `캠페인 ${data.campaigns.length}개`, budget_forecast: `캠페인 ${data.campaigns.length}개`,
    keyword_no_impression: `키워드 ${data.keywords.length}개`, keyword_spike: `키워드 ${data.keywords.length}개`, brand_intrusion: `브랜드 키워드 ${data.keywords.filter((k) => k.isBrand).length}개`,
    soldout_landing: `상품 옵션 ${data.products.reduce((a, p) => a + p.options.length, 0)}개 × 키워드`, price_mismatch: `진행 중 프로모션 ${data.promotions.filter((p) => p.status === 'live').length}건`,
    account_payment: `계정 ${data.accounts.length}개`, account_permission: `권한 ${data.accounts.reduce((a, x) => a + x.permissions.length, 0)}건`, account_status: `계정 ${data.accounts.length}개`,
    creative_rejected: `소재 ${DEMO_CREATIVES.length}개`, creative_pending: `소재 ${DEMO_CREATIVES.length}개`, landing_error: `랜딩 ${DEMO_CREATIVES.length}개`,
    media_no_impression: '매체 6개 × 시간', data_spike: '매체 6개 × 5지표', anomaly_warn: '매체 6개 × 5지표', tracking_break: '매체 6개 × 시간', invalid_traffic: '매체 6개',
    search_volume: '브랜드 검색량 일별', media_delay: '매체 6개 × 현재 시각 수신', bulk_change: `변경 이력 ${state.changes.length}건`,
  };
  const registry = Object.entries(RULES).map(([id, r]) => ({ id, ...r, count: open.filter((i) => i.ruleId === id).length }));

  return (
    <div className="stack-lg">
      <Card title="크리티컬 이슈 탐지 기준" sub="이슈 유형마다 탐지 기준 · 알림 방식 · 조치 보고를 정하고, 계정 · 결제는 별도 행으로 분리" actions={<><Src kind="PROPOSAL" page="p.44" /><Src kind="DEMO" /></>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>이슈 유형</th><th>탐지 기준</th><th>알림 방식</th><th>조치 · 보고</th><th className="c">등급</th><th className="r">현재 열림</th></tr></thead>
            <tbody>
              {CRITICAL_ISSUE_TYPES.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.type}</strong></td><td className="small">{t.criteria}</td><td className="small">{t.notify}</td><td className="small">{t.action}</td>
                  <td className="c">{t.severity === '전 등급' ? <Pill tone="outline">전 등급</Pill> : <Sev level={t.severity} />}</td>
                  <td className="r num">{t.id === 'weekend' ? `${open.filter((i) => i.onDuty).length}건 당번` : `${(TYPE_GROUP[t.id] ?? [t.id]).reduce((a, x) => a + countType(x), 0)}건`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="xs muted">수치 기준은 초기값이며, 온보딩 중 수면밀도 데이터로 오탐률을 보며 조정합니다 (p.44). 현재 열림은 p.45 추가 탐지(품절 · 가격 → 소재 · 랜딩, 추적 단절 · 무효 트래픽 → 데이터 급변, 대량 변경 → 광고 OFF)를 포함하고, 브랜드 키워드 침투는 아래 추가 탐지 카드에서 집계합니다.</div>
      </Card>

      <Card title="추가 탐지 이슈" sub="실제로 손실을 만드는데 사람이 놓치기 쉬운 이슈 · 자동화가 만드는 위험까지 시스템이 먼저 봅니다" actions={<Src kind="PROPOSAL" page="p.45" />}>
        <div className="grid g-3">
          {EXTRA_DETECTORS.map((d) => {
            const n = countType(d.id);
            const r = Object.entries(RULES).find(([, x]) => x.typeId === d.id)?.[1];
            return (
              <div key={d.id} className="card flat" style={{ padding: 12, gap: 6 }}>
                <div className="row-between"><strong>{d.title}</strong><Sev level={d.severity} /></div>
                <div className="small ink2">{d.why}</div>
                <div className="xs"><span className="muted">자동 조치</span> {d.auto}</div>
                <div className="xs muted">판정: {r?.basis ?? '—'}</div>
                <div className="row" style={{ gap: 6 }}>
                  {n ? <LevelPill level="danger" label={`현재 ${n}건 열림`} /> : <LevelPill level="ok" label="가동 · 이상 없음" />}
                  {d.id === 'brand_intrusion' ? <Pill tone="outline">SERP 연동 전 순위 기반 추정</Pill> : null}
                  {d.id === 'bulk_change' ? <Pill tone="outline">MILDO Flow 변경 이력 감시</Pill> : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="규칙 엔진 가동 현황" sub={`탐지 규칙 ${registry.length}개 · 기준 시각 데이터로 실제 판정 (하드코딩 결과 아님)`} actions={<Src kind="DEMO" />}>
        <DataTable rows={registry} rowKey={(r) => r.id} maxHeight={360}
          columns={[
            { key: 'l', label: '규칙', render: (r) => <div><strong className="small">{r.label}</strong><div className="xs muted">{TYPE_LABEL[r.typeId]}</div></div> },
            { key: 's', label: '기본 등급', render: (r) => <Sev level={r.severity} /> },
            { key: 'b', label: '판정 기준', render: (r) => <span className="xs">{r.basis}</span> },
            { key: 'p', label: '출처', render: (r) => (r.page.startsWith('p.') ? <Src kind="PROPOSAL" page={r.page} /> : <span className="xs muted">{r.page}</span>) },
            { key: 'sc', label: '점검 대상', render: (r) => <span className="xs">{scopeOf[r.id] ?? '—'}{CREATIVE_RULES.has(r.id) ? <> <Src kind="DEMO" fixture title="시연용 예시 소재 목록 · 매체 소재 검수 연동 전 (실제 소재 아님)" /></> : null}</span> },
            { key: 'n', label: '열림', align: 'right', render: (r) => <span className="num">{r.count}</span>, sort: (r) => r.count },
          ]} />
      </Card>

      <Card title="탐지 기준 편집" sub="초기값 · 오탐률을 보며 조정. 변경은 승인 요청(ChangeRequest · 승인 PM)으로만 반영되고 이력이 남습니다." actions={<><Src kind="PROPOSAL" page="p.47 · p.53" /><Src kind="DEMO" /></>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>기준</th><th>출처</th><th className="r">현재 적용</th><th>변경안</th><th className="r">지난 30일 오탐률</th></tr></thead>
            <tbody>
              {CONFIG_FIELDS.map((f) => {
                const v = draft[f.key];
                const cur = draftOf(cfg)[f.key];
                const fr = fp[f.key];
                return (
                  <tr key={f.key}>
                    <td><strong className="small">{f.label}</strong></td>
                    <td className="xs muted">{f.page}</td>
                    <td className="r num small">{enc(cur, f.unit)}</td>
                    <td>
                      {typeof v === 'number' ? (
                        <NumberInput id={`cfg-${f.key}`} value={v} min={f.min} max={f.max} suffix={f.unit} onChange={(n) => setDraft((d) => ({ ...d, [f.key]: n }))} style={{ maxWidth: 140 }} />
                      ) : (
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <span className="xs muted">주의</span>
                          <NumberInput id={`cfg-${f.key}-w`} value={v.warn} min={f.min} max={f.max} suffix="%" onChange={(n) => setDraft((d) => ({ ...d, [f.key]: { ...(d[f.key] as Threshold), warn: n } }))} style={{ maxWidth: 110 }} />
                          <span className="xs muted">위험</span>
                          <NumberInput id={`cfg-${f.key}-d`} value={v.danger} min={f.min} max={f.max} suffix="%" onChange={(n) => setDraft((d) => ({ ...d, [f.key]: { ...(d[f.key] as Threshold), danger: n } }))} style={{ maxWidth: 110 }} />
                        </div>
                      )}
                    </td>
                    <td className="r num small">{fr ? `${Math.round((fr.fp / fr.n) * 100)}% (${fr.fp}/${fr.n})` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {invalid.length ? <Callout tone="warning">입력 범위 확인: {invalid.map((f) => f.label).join(', ')} (위험 ≥ 주의, 허용 범위 내)</Callout> : null}
        {dupes.length ? <div className="xs muted">같은 변경안이 이미 승인 · 반영 대기 중이라 다시 요청하지 않습니다: {dupes.map((f) => f.label).join(', ')} (아래 이력 · MILDO Flow에서 처리)</div> : null}
        <div className="grid g-3">
          <div className="stack-sm">
            <span className="xs muted">미리보기 · 같은 데이터로 엔진 재실행</span>
            <span className="small">이상 징후 계열 이슈 <strong className="num">{nowCount}건</strong> → <strong className="num">{Number.isFinite(draftCount) ? `${draftCount}건` : '—'}</strong></span>
            <span className="xs muted">오탐률은 10월 이력(DEMO) 기준 · 기준을 낮추면 감지는 늘고 오탐도 늘어남</span>
          </div>
          <Field id="cfg-reason" label="변경 사유 (필수)">
            <input id="cfg-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && canSubmit) submit(); }} placeholder="예: 광고비 주의 기준 오탐 40% · 집계 지연 반복" />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Button variant="primary" icon="send" disabled={!canSubmit} onClick={submit}>기준 변경 요청 {toSubmit.length}건 (승인 PM)</Button>
            <Button variant="ghost" onClick={() => setDraft(draftOf(cfg))}>현재값으로</Button>
          </div>
        </div>
        <div className="xs muted">의사결정 체계 (p.53): {DECISION_MATRIX.find((d) => d.type.includes('알림'))?.type} → {DECISION_MATRIX.find((d) => d.type.includes('알림'))?.decider} · {DECISION_MATRIX.find((d) => d.type.includes('알림'))?.lead}</div>
        <DataTable rows={ruleChanges} columns={changeCols} rowKey={(c) => c.id} empty="기준 변경 요청 없음" />
      </Card>
    </div>
  );
}
