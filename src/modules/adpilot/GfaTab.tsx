import { useMemo, useState } from 'react';
import { mediaRows, previousRange, rangeOf, totalsOf } from '@/core/selectors';
import type { ChangeRequest } from '@/core/types';
import { GFA_DELEGATION, MEDIA } from '@/data/constants';
import { fmt, fmtDate, hhmm } from '@/core/util';
import { Button, Callout, Card, type Column, DataTable, Field, NumberInput, Pill, ProgressBar, Segmented, Src, Stat } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { APPROVER_LABEL, canApprove, clock, gfaChangeInput, type GfaCampaignView, type GfaRequestDraft, planGfaRequest, pct0 } from './engine';
import { GFA_EFFECTS, GFA_FLOW_STEPS, GFA_OBJECTIVES } from './data';
import type { AdPilotCtx } from './useAdPilot';
import { ApproverPill, LevelPill, StatusPill } from './parts';
import { ChangeButtons } from './ProposalsTab';

const showVal = (v: string | number) => (typeof v === 'number' ? fmt.krw(v) : v === 'on' || v === 'off' ? v.toUpperCase() : v);

export function GfaTab({ ap }: { ap: AdPilotCtx }) {
  const views = ap.gfa;
  const firstCampaign = views[0]?.campaigns[0];
  const [draft, setDraft] = useState<GfaRequestDraft>({ type: 'budget', accountId: views[0]?.account.id ?? '', campaignId: firstCampaign?.campaign.id, pct: 10, objective: GFA_OBJECTIVES[0], reason: '' });
  const plan = useMemo(() => planGfaRequest(views, draft), [views, draft]);
  const acc = views.find((v) => v.account.id === draft.accountId);
  const cv = acc?.campaigns.find((c) => c.campaign.id === draft.campaignId);
  const gfaChanges = ap.changes.filter((c) => c.module === 'gfa');
  const allCampaigns = views.flatMap((v) => v.campaigns.map((c) => ({ ...c, accountName: v.account.name })));
  const issues = views.reduce((n, v) => n + v.issues.filter((i) => i.level === 'warn' || i.level === 'critical').length + v.campaigns.reduce((m, c) => m + c.issues.filter((i) => i.level === 'warn' || i.level === 'critical').length, 0), 0);
  const perm = canApprove(ap.state.role, plan.route.approver);
  const perf = useMemo(() => {
    const r = rangeOf(ap.data, 'last7');
    const pr = previousRange(r);
    const t = totalsOf(mediaRows(ap.data, r.from, r.to, 'naver_gfa'));
    const p = totalsOf(mediaRows(ap.data, pr.from, pr.to, 'naver_gfa'));
    const d = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : NaN);
    return { t, p, label: r.label, dCost: d(t.cost, p.cost), dRoas: d(t.roas, p.roas), dNew: d(t.newCustomers, p.newCustomers), dCac: d(t.cac, p.cac) };
  }, [ap.data]);
  const guard = ap.guards.naver_gfa;
  const set = (patch: Partial<GfaRequestDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const prefill = (c: GfaCampaignView) => {
    set({ type: 'budget', accountId: c.accountId, campaignId: c.campaign.id, pct: c.pace.earlyExhaust ? 10 : -10, reason: c.pace.earlyExhaust ? `조기 소진 예상 ${clock(c.pace.curveExhaustHour ?? c.pace.linearExhaustHour)}` : '' });
    document.getElementById('adpilot-gfa-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const submit = () => {
    if (!plan.ok) return;
    ap.requestInput(gfaChangeInput(plan, draft, ap.state.role));
    set({ reason: '' });
  };

  const campCols: Column<GfaCampaignView & { accountName: string }>[] = [
    { key: 'acc', label: '계정', render: (c) => <span className="xs">{c.accountName}</span> },
    { key: 'name', label: '캠페인', sort: (c) => c.campaign.name, render: (c) => <div className="stack-sm" style={{ gap: 0 }}><strong className="small">{c.campaign.name}</strong>{c.demo ? <span className="xs muted">DEMO 가정 캠페인</span> : null}</div> },
    { key: 'status', label: '상태', render: (c) => <Pill tone={c.campaign.status === 'off' ? 'neutral' : 'good'} icon={c.campaign.status === 'off' ? 'pause' : 'play'}>{c.campaign.status.toUpperCase()}</Pill> },
    { key: 'budget', label: '일 예산', align: 'right', sort: (c) => c.campaign.dailyBudget, render: (c) => fmt.krw(c.campaign.dailyBudget) },
    { key: 'spent', label: `오늘 소진 (${ap.data.currentHour}시)`, align: 'right', sort: (c) => c.pace.pacePct, render: (c) => (
      <div className="stack-sm" style={{ gap: 2, minWidth: 110 }}>
        <span className="num small">{fmt.krw(c.campaign.spentToday)} · {pct0(c.pace.pacePct)}</span>
        <ProgressBar value={Number.isFinite(c.pace.pacePct) ? c.pace.pacePct : 0} tone={c.pace.earlyExhaust ? 'warning' : 'ink'} label="일 예산 소진율" />
      </div>
    ) },
    { key: 'exh', label: '예상 마감 (가중 / 선형)', align: 'right', render: (c) => <span className="num small nowrap">{c.campaign.status === 'off' ? '—' : `${clock(c.pace.curveExhaustHour)} / ${clock(c.pace.linearExhaustHour)}`}</span> },
    { key: 'ag', label: '광고그룹 ON', align: 'right', render: (c) => <span className="num small">{c.adGroups.filter((g) => g.status === 'on').length} / {c.adGroups.length}</span> },
    { key: 'check', label: '점검 결과 (기준)', render: (c) => (
      <div className="stack-sm" style={{ gap: 2, maxWidth: 300 }}>
        <LevelPill level={c.level}>{c.level === 'critical' ? '즉시 조치' : c.level === 'warn' ? '주의' : c.level === 'info' ? '참고' : '정상'}</LevelPill>
        {c.issues.map((i, n) => <span key={n} className="adpilot-basis">{i.text} — {i.basis}</span>)}
      </div>
    ) },
    { key: 'act', label: '', align: 'right', render: (c) => <Button size="sm" icon="edit" onClick={() => prefill(c)}>변경 요청</Button> },
  ];

  const queueCols: Column<ChangeRequest>[] = [
    { key: 'at', label: '요청', sort: (c) => c.createdAt, render: (c) => <span className="num xs">{hhmm(c.createdAt)} · {c.requestedBy}</span> },
    { key: 'target', label: '대상', render: (c) => <strong className="small">{c.target}</strong> },
    { key: 'chg', label: '변경', align: 'right', render: (c) => <span className="num small nowrap">{showVal(c.before)}<span className="adpilot-arrow">→</span><strong>{showVal(c.after)}</strong>{c.changePct !== undefined ? <span className="muted"> ({fmt.delta(c.changePct)})</span> : null}</span> },
    { key: 'approver', label: '승인 주체', render: (c) => <ApproverPill level={c.approver} /> },
    { key: 'status', label: '상태', render: (c) => <StatusPill status={c.status} /> },
    { key: 'last', label: '최근 이력 (누가 · 왜)', render: (c) => { const h = c.history[c.history.length - 1]; return h ? <div className="adpilot-basis">{hhmm(h.at)} {h.by} · {h.action}{h.note ? ` — ${h.note}` : ''}</div> : null; } },
    { key: 'act', label: '', align: 'right', render: (c) => <span className="adpilot-row-actions"><ChangeButtons ap={ap} c={c} /></span> },
  ];

  return (
    <div className="stack-lg">
      <Card title="GFA Control v1 운영 통제" sub="GFA 예산 변경 · 다계정 관리 · 승인 · 인수인계를 하나의 프로세스로 묶고, 모든 조정의 책임자와 결과를 남깁니다." actions={<Src kind="PROPOSAL" page="p.15" />}>
        <div className="adpilot-steps">
          {GFA_FLOW_STEPS.map((s, i) => {
            const cnt = i === 0 ? `${issues}건` : i === 1 ? `${gfaChanges.length}건` : i === 2 ? `${gfaChanges.filter((c) => c.status === 'pending').length}건 대기` : `${gfaChanges.filter((c) => c.status === 'applied').length} 실행 · ${gfaChanges.filter((c) => c.status === 'held').length} 보류`;
            return (
              <div key={s.no} className="adpilot-step">
                <span className="adpilot-no">{s.no}{i < 3 ? ' →' : ''}</span>
                <strong className="small">{s.title}</strong>
                <span className="xs muted">{s.detail}</span>
                <span className="adpilot-cnt">{cnt}</span>
                <span className="xs muted">{i === 0 ? '점검 이슈 (주의 이상)' : i === 1 ? '이번 세션 요청' : i === 2 ? '위임 범위별 차등' : '오류 시 보류 · 보고'}</span>
              </div>
            );
          })}
        </div>
        <div className="row xs muted" style={{ gap: 12 }}>기대 효과: {GFA_EFFECTS.map((e) => <span key={e} className="row" style={{ gap: 4 }}><Icon name="check" size={12} />{e}</span>)}</div>
      </Card>

      <Card title={`01 성과 · 예산 모니터링 — ${MEDIA.naver_gfa.name} ${perf.label}`} sub={`역할 ${MEDIA.naver_gfa.role} · 판단 지표 ${MEDIA.naver_gfa.judgeMetric} (p.37) — ROAS 단독으로 확대 · 중단을 판단하지 않습니다`} actions={<><Src kind="PROPOSAL" page="p.37" /><Src kind="DEMO" /></>}>
        <div className="grid g-5">
          <Stat label="광고비" value={fmt.krw(perf.t.cost)} delta={perf.dCost} invert foot={<span className="xs muted">직전 7일 {fmt.krw(perf.p.cost)}</span>} />
          <Stat label="ROAS" value={fmt.roas(perf.t.roas)} delta={perf.dRoas} foot={<span className="xs muted">목표 {fmt.roas(ap.cfg.targetRoas)}는 SA 기준 · GFA는 참고</span>} />
          <Stat label="신규 고객" value={fmt.int(perf.t.newCustomers)} delta={perf.dNew} foot={<span className="xs muted">명</span>} />
          <Stat label="신규 CPA (판단 지표)" value={fmt.won(perf.t.cac)} delta={perf.dCac} invert foot={<span className="xs muted">직전 7일 {fmt.won(perf.p.cac)}</span>} />
          <div className="stat">
            <div className="stat-label">오늘 시간대 점검</div>
            <div><LevelPill level={guard.hold ? 'critical' : 'ok'}>{guard.hold ? '급변 · 자동 조정 보류' : '기준 이내'}</LevelPill></div>
            <div className="xs muted">{guard.basis}</div>
          </div>
        </div>
      </Card>

      <div className="grid g-3">
        {views.map((v) => (
          <Card key={v.account.id} title={v.account.name} sub={`소유 ${v.account.owner} · ${v.account.paymentMethod}`} actions={<>{v.demo ? <Src kind="DEMO" title="시연용 가정 계정 · 실제 계정 아님" /> : <Src kind="DEMO" />}</>}>
            <div className="row" style={{ gap: 6 }}>
              <LevelPill level={v.level}>{v.level === 'critical' ? '즉시 조치' : v.level === 'warn' ? '주의' : '정상'}</LevelPill>
              <span className="xs muted">기준: 잔액 1일치 · 자동충전 · 계정 상태 · 실명 권한 (p.44 · p.50)</span>
            </div>
            <div className="grid g-3">
              <div className="stat"><div className="stat-label">잔액</div><div className="num bold">{v.account.balance < 0 ? '후불' : fmt.krw(v.account.balance)}</div></div>
              <div className="stat"><div className="stat-label">일 평균 소진</div><div className="num bold">{fmt.krw(v.account.avgDailySpend)}</div></div>
              <div className="stat"><div className="stat-label">잔액 일수</div><div className={`num bold ${v.runwayDays < 1 ? 'delta-down' : ''}`}>{Number.isFinite(v.runwayDays) ? `${v.runwayDays.toFixed(2)}일` : '—'}</div></div>
            </div>
            <div className="small">
              {v.exhaustAt ? <>잔액 소진 예상 <strong>{fmtDate(v.exhaustAt.date)} {v.exhaustAt.hour}시경</strong> <span className="xs muted">(오늘 잔여 예상 소진 {fmt.krw(v.remainingToday)} + 일 평균 · 시간대 곡선 기준)</span></> : <span className="muted">소진 중인 캠페인 없음</span>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Pill tone={v.account.autoCharge === 'failed' ? 'critical' : v.account.autoCharge === 'ok' ? 'good' : 'neutral'} icon="wallet">자동충전 {v.account.autoCharge === 'failed' ? '실패' : v.account.autoCharge === 'ok' ? '정상' : v.account.autoCharge === 'off' ? '미사용' : '후불'}</Pill>
              <Pill tone="outline">캠페인 {v.campaigns.length}개</Pill>
              <Pill tone="outline" icon="users">권한 {v.account.permissions.length}명 · 실명 {v.account.permissions.filter((p) => p.realName).length}</Pill>
            </div>
            <div className="xs muted">인수인계 · 권한: {v.account.permissions.map((p) => `${p.user}(${p.role}${p.realName ? '' : ' · 비실명'} · 최근 ${p.lastLogin.slice(5).replace('-', '/')})`).join(' · ')}</div>
            {v.issues.length ? (
              <div className="stack-sm">
                {v.issues.map((i, n) => <div key={n} className="small"><LevelPill level={i.level}>{i.text}</LevelPill> <span className="xs muted">{i.basis}</span></div>)}
              </div>
            ) : null}
            {v.level === 'critical' ? <a className="xs" href="#alert">MILDO Alert 계정 · 결제 이슈 보기 →</a> : null}
          </Card>
        ))}
      </div>

      <Card title="예산 · 상태 점검 (캠페인)" sub={`${MEDIA.naver_gfa.name} 캠페인 ${allCampaigns.length}개 · 소진 속도는 시간대 가중(최근 28일 GFA 시간대 광고비 비중)과 선형 추정을 함께 표시`} actions={<><Src kind="PROPOSAL" page="p.15" /><Src kind="DEMO" /></>}>
        <DataTable rows={allCampaigns} columns={campCols} rowKey={(c) => c.campaign.id} />
      </Card>

      <div className="grid g-2">
        <Card id="adpilot-gfa-form" title="변경 요청" sub="요청 내용과 변경 폭으로 승인 주체가 자동 결정됩니다" actions={<Src kind="PROPOSAL" page="p.15" />}>
          <Segmented label="변경 유형" value={draft.type} onChange={(t) => set({ type: t })} options={[{ id: 'budget', label: '일 예산 변경 %' }, { id: 'adgroup', label: '광고그룹 ON/OFF' }, { id: 'new_campaign', label: '신규 캠페인' }]} />
          <div className="grid g-2">
            <Field label="계정" id="adpilot-gfa-acc">
              <select id="adpilot-gfa-acc" className="select" value={draft.accountId} onChange={(e) => { const a = views.find((v) => v.account.id === e.target.value); set({ accountId: e.target.value, campaignId: a?.campaigns[0]?.campaign.id, adGroupId: undefined }); }}>
                {views.map((v) => <option key={v.account.id} value={v.account.id}>{v.account.name}</option>)}
              </select>
            </Field>
            {draft.type !== 'new_campaign' ? (
              <Field label="캠페인" id="adpilot-gfa-cmp">
                <select id="adpilot-gfa-cmp" className="select" value={draft.campaignId ?? ''} onChange={(e) => set({ campaignId: e.target.value, adGroupId: undefined })}>
                  {(acc?.campaigns ?? []).map((c) => <option key={c.campaign.id} value={c.campaign.id}>{c.campaign.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="목적" id="adpilot-gfa-obj">
                <select id="adpilot-gfa-obj" className="select" value={draft.objective} onChange={(e) => set({ objective: e.target.value })}>
                  {GFA_OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
            )}
          </div>
          {draft.type === 'budget' ? (
            <div className="grid g-2">
              <Field label="일 예산 변경 폭" id="adpilot-gfa-pct" hint={cv ? `${fmt.krw(cv.campaign.dailyBudget)} → ${fmt.krw(Number(plan.after))}` : undefined}>
                <NumberInput id="adpilot-gfa-pct" value={draft.pct ?? 0} step={1} min={-99} max={200} suffix="%" onChange={(n) => set({ pct: n })} />
              </Field>
              <div className="row" style={{ gap: 4, alignSelf: 'end' }}>
                {[-10, 5, 10, 20, 35].map((p) => <Button key={p} size="sm" onClick={() => set({ pct: p })}>{p > 0 ? '+' : ''}{p}%</Button>)}
              </div>
            </div>
          ) : null}
          {draft.type === 'adgroup' ? (
            <div className="grid g-2">
              <Field label="광고그룹" id="adpilot-gfa-ag">
                <select id="adpilot-gfa-ag" className="select" value={draft.adGroupId ?? ''} onChange={(e) => { const g = cv?.adGroups.find((x) => x.id === e.target.value); set({ adGroupId: e.target.value, toStatus: g?.status === 'on' ? 'off' : 'on' }); }}>
                  <option value="">선택</option>
                  {(cv?.adGroups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.status.toUpperCase()}{g.note ? ` · ${g.note}` : ''})</option>)}
                </select>
              </Field>
              <Field label="변경 후 상태" id="adpilot-gfa-to">
                <Segmented label="변경 후 상태" value={draft.toStatus ?? 'off'} onChange={(t) => set({ toStatus: t })} options={[{ id: 'on', label: 'ON' }, { id: 'off', label: 'OFF' }]} />
              </Field>
            </div>
          ) : null}
          {draft.type === 'new_campaign' ? (
            <div className="grid g-2">
              <Field label="캠페인 이름" id="adpilot-gfa-name"><input id="adpilot-gfa-name" className="input" value={draft.newName ?? ''} onChange={(e) => set({ newName: e.target.value })} placeholder="예: GFA_신혼 시즌 쇼핑 고객 확장" /></Field>
              <Field label="일 예산 (원)" id="adpilot-gfa-nb"><NumberInput id="adpilot-gfa-nb" value={draft.newBudget ?? 0} step={10000} min={0} onChange={(n) => set({ newBudget: n })} suffix="원" /></Field>
            </div>
          ) : null}
          <Field label="사유 (왜)" id="adpilot-gfa-reason"><input id="adpilot-gfa-reason" className="input" value={draft.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} placeholder="예: 쇼핑 고객 확장 신규 CPA 안정 · 조기 소진 대응" /></Field>
          <div className="row" style={{ gap: 8 }}>
            <span className="small">승인 주체</span><ApproverPill level={plan.route.approver} /><span className="xs muted">{plan.route.reason}</span>
          </div>
          {plan.errors.length ? <Callout tone="critical" title="요청 불가">{plan.errors.join(' · ')}</Callout> : null}
          {plan.warnings.length ? <Callout tone="warning" title="주의">{plan.warnings.join(' · ')}</Callout> : null}
          <div className="row-between">
            <span className="xs muted">현재 역할 {ap.state.role}: {perm.ok ? '이 건을 직접 승인할 수 있습니다' : perm.reason}</span>
            <Button variant="primary" icon="send" disabled={!plan.ok} onClick={submit}>승인 요청 → {APPROVER_LABEL[plan.route.approver]}</Button>
          </div>
        </Card>

        <Card title="위임 범위 · 승인 주체" sub="위임 범위는 예시이며 계약 시 확정합니다" actions={<Src kind="PROPOSAL" page="p.15" />}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>변경 범위 · 예시</th><th>승인 주체</th><th>현재 역할 ({ap.state.role})</th></tr></thead>
              <tbody>
                {GFA_DELEGATION.map((r, i) => {
                  const p = canApprove(ap.state.role, r.approver);
                  return (
                    <tr key={r.range} className={i === plan.route.rowIndex ? 'adpilot-route-row' : undefined}>
                      <td>{i === plan.route.rowIndex ? <strong>{r.range}</strong> : r.range}</td>
                      <td><ApproverPill level={r.approver} /></td>
                      <td>{p.ok ? <Pill tone="good" icon="check">승인 가능</Pill> : <Pill tone="neutral" icon="x">승인 불가</Pill>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="xs muted">강조된 행이 지금 작성 중인 요청의 라우팅입니다. 담당 AE → PM → 광고주 순서로 범위가 넓어지며, 승인 후 실행 단계에서 잔액 · 계정 상태를 다시 검증하고 오류 시 보류 · 보고합니다.</div>
          <div className="xs muted">역할 전환은 상단 바의 역할 선택에서 합니다 (승인 권한 시연).</div>
        </Card>
      </div>

      <Card title="요청 · 승인 · 실행 이력 (GFA)" sub="모든 조정의 책임자와 결과를 남깁니다 — MILDO Flow에서도 같은 이력을 봅니다" actions={<a className="small" href="#flow">MILDO Flow →</a>}>
        <DataTable rows={gfaChanges} columns={queueCols} rowKey={(c) => c.id} empty="GFA 변경 요청이 없습니다. 위 폼이나 캠페인 점검 표의 [변경 요청]으로 시작하세요." />
      </Card>
    </div>
  );
}
