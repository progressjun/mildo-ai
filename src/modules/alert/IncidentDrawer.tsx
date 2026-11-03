import { useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { TF_ROLES } from '@/data/constants';
import { fmt } from '@/core/util';
import { Markdown } from '@/ui/Markdown';
import { Icon } from '@/ui/Icon';
import { Button, Callout, CopyButton, DownloadButton, Drawer, Field, Pill, Src, Stat } from '@/ui/primitives';
import { backupOf, dayDiff, fmtRemain, fmtStamp, incidentReport, nextAction, preventSuggestion, roleLabel, slaState, typeOf, type AlertIncident } from './engine';
import { TYPE_LABEL } from './data';
import { CauseList, ChangeStatusPill, EvidenceTable, krwOrDash, MediaTag, mediaName, SevLabel, SlaTimer, StatusPill } from './parts';
import { canApprove, type AlertCtx } from './hooks';

/** 서버 모드 결과 보고 기록 — 서버는 이슈 보고서를 발송하지 않는다(보고서는 화면에서 복사 · 내려받기). 보내지 않은 발송을 기록하지 않는다. */
export const REPORT_ACTION_SERVER = '결과 보고 · 이슈 보고서 작성 (p.49 양식 · 공유는 복사 · .md 내려받기)';

export function IncidentDrawer({ ctx, id, onClose }: { ctx: AlertCtx; id: string; onClose: () => void }) {
  const { incidents, state, actions, nowMs, toMs, nameOf, clockIso, act, data, cfg, slaOff, perm, server } = ctx;
  const inc = incidents.find((i) => i.id === id);
  const [assignRole, setAssignRole] = useState<string>('');
  const [actionNote, setActionNote] = useState('');
  const [preventNote, setPreventNote] = useState('');
  const [fpArmed, setFpArmed] = useState(false);
  const [fpReason, setFpReason] = useState('');
  const [showReport, setShowReport] = useState(false);
  if (!inc) {
    return <Drawer title="이슈 없음" onClose={onClose}><div className="small muted">이슈를 찾지 못했습니다 (초기화되었을 수 있음).</div></Drawer>;
  }
  const st = slaState(inc, nowMs, toMs, slaOff);
  // 서버 모드 권한 (§2): 이슈 처리 = operate, 연결 요청 = request — 막힌 버튼은 사유를 title · 문구로 보여 준다
  const op = perm.operate;
  const opWhy = perm.operateReason;
  const reqWhy = perm.requestReason;
  const sla = inc.sla ?? {};
  const resolved = inc.status === 'resolved';
  const report = () => incidentReport(inc, { nowMs, toMs, nameOf });
  const acc = data.accounts.find((a) => a.name === inc.target);
  // 이슈 단위 요청(alert:<이슈>:…) + 계정 단위 요청(alert:account:<계정>:… — 계정 · 결제 탭과 같은 형식)
  const linked = state.changes.filter((c) => c.targetId?.startsWith(`alert:${inc.id}:`) || (acc && c.targetId?.startsWith(`alert:account:${acc.id}:`)));
  /** 같은 대상 요청이 이미 있으면 다시 만들지 않는다 (반려된 건은 재요청 가능 — 계정 · 결제 탭과 같은 규칙) */
  const requested = (tid: string) => state.changes.some((c) => c.targetId === tid && c.status !== 'rejected');
  // 요청 후 라벨은 '요청됨'만 덧붙여 버튼 폭을 유지한다 — 폭이 줄면 더블클릭의 두 번째 클릭이 옆 링크(MILDO Flow 이력 등)에 떨어져 화면이 이동한다

  const steps: { key: string; label: string; at?: string; target?: string }[] = [
    { key: 'ack', label: '인지', at: sla.ackAt, target: st.targets.ack },
    { key: 'assign', label: '배정', at: sla.assignedAt },
    { key: 'action', label: '1차 조치', at: sla.actionAt, target: st.targets.action },
    { key: 'report', label: '결과 보고', at: sla.reportAt, target: st.targets.report },
    { key: 'prevent', label: '재발 방지', at: sla.preventAt },
    { key: 'resolve', label: '해결', at: sla.resolvedAt },
  ];
  const firstOpen = steps.findIndex((s) => !s.at);

  const closeFalsePositive = () => {
    const why = fpReason.trim();
    if (!why || resolved) return;
    act(inc, { status: 'resolved', falsePositive: true, actionNote: `오탐 · ${why}`, sla: { ...sla, ackAt: sla.ackAt ?? clockIso(), resolvedAt: clockIso() } }, `오탐으로 종료 · ${why}`);
    setFpArmed(false);
  };
  const requestChange = (c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status' | 'module' | 'requestedBy'>, msg: string) => {
    if (!perm.request) return;
    actions.addChange({ ...c, module: 'alert', requestedBy: state.role });
    actions.toast({ tone: 'info', title: msg, body: `승인 주체: ${c.approver === 'CLIENT' ? '수면밀도' : c.approver} · MILDO Flow에서 처리`, route: 'flow' });
  };

  return (
    <Drawer title={<span className="row" style={{ gap: 8 }}><SevLabel sev={inc.severity} /><StatusPill inc={inc} /></span>} onClose={onClose}>
      <div className="stack-sm">
        <h3 style={{ fontSize: 'var(--fs-xl)', lineHeight: 1.3 }}>{inc.title}</h3>
        <div className="alert-sub">
          <span>{TYPE_LABEL[typeOf(inc)] ?? inc.ruleId}{inc.ruleLabel && inc.ruleLabel !== TYPE_LABEL[typeOf(inc)] ? ` · ${inc.ruleLabel}` : ''}</span>
          {inc.page ? <Src kind="PROPOSAL" page={inc.page} /> : null}
          <Src kind="DEMO" />
          {inc.isTest ? <Pill tone="dark">테스트 주입</Pill> : null}
          {inc.falsePositive ? <Pill tone="neutral">오탐</Pill> : null}
        </div>
        <div className="alert-kv">
          <span>대상</span><span className="row" style={{ gap: 8 }}><MediaTag media={inc.media} /><span>{inc.target}</span></span>
          <span>발생 · 감지</span><span className="num">{fmtStamp(toMs(inc.occurredAt))} 발생 · {fmtStamp(toMs(inc.detectedAt))} 감지</span>
          <span>감지 경로</span><span className="small">{inc.detectPath}</span>
          <span>담당 · 백업</span><span>{nameOf(inc.assignee)}{inc.onDuty ? ' (주말 · 공휴일 당번)' : ''} · 백업 {nameOf(inc.backup)}</span>
        </div>
      </div>

      {inc.recurrence?.count ? (
        <Callout tone="warning" title={`최근 30일 같은 유형 · 매체 ${inc.recurrence.count}회 재발`}>
          {inc.recurrence.dates.join(', ')} 이력(DEMO). 결과 보고와 함께 재발 방지 항목(탐지 기준 · 체크리스트)을 기록해야 월간 SLA 리포트 재발 건수가 줄어듭니다.
        </Callout>
      ) : null}

      <div className="card flat" style={{ padding: 12 }}>
        <div className="row-between">
          <span className="alert-section-label">SLA · p.49{st.targets.offDay ? ' · 주말 당번 p.48' : ''}</span>
          <SlaTimer inc={inc} />
        </div>
        <div className="grid g-3" style={{ gap: 8 }}>
          {([['인지', st.targets.ack, st.elapsed.ack, st.achieved.ack], ['1차 조치', st.targets.action, st.elapsed.action, st.achieved.action], ['결과 보고', st.targets.report, st.elapsed.report, st.achieved.report]] as const).map(([k, t, e, a]) => (
            <div key={k} className="stack-sm" style={{ gap: 2 }}>
              <span className="xs muted">{k} 목표 {t}</span>
              <span className="num small"><strong>{e !== undefined ? `${Math.round(e)}분` : '—'}</strong> {a === undefined ? <span className="muted">진행 전</span> : a ? <Pill tone="good" icon="check">달성</Pill> : <Pill tone="critical" icon="alert">미달</Pill>}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="stack-sm">
        <span className="alert-section-label">처리 단계 · 감지 → 배정 → 조치 → 보고 → 재발 방지</span>
        <div className="alert-steps">
          {steps.map((s, k) => (
            <div key={s.key} className={`alert-step${s.at ? ' done' : k === firstOpen && !resolved ? ' now' : ''}`}>
              <strong>{s.label}</strong>
              <span className="num">{s.at ? fmtStamp(toMs(s.at)) : s.target ? `목표 ${s.target}` : '—'}</span>
            </div>
          ))}
        </div>
        {!resolved ? (
          <div className="stack">
            {!op ? <div className="xs muted" role="note"><Icon name="shield" size={12} /> {opWhy} — 처리 단계는 볼 수만 있습니다</div> : null}
            <div className="row">
              <Button size="sm" variant={!sla.ackAt ? 'primary' : 'default'} icon="check" disabled={!!sla.ackAt || !op} title={opWhy}
                onClick={() => act(inc, { status: inc.status === 'open' ? 'ack' : inc.status, sla: { ...sla, ackAt: clockIso() } }, '인지')}>인지</Button>
              <select id={`assign-${inc.id}`} className="select" aria-label="배정할 TF 역할" style={{ width: 'auto' }} disabled={!op} title={opWhy} value={assignRole} onChange={(e) => setAssignRole(e.target.value)}>
                <option value="">TF 역할 선택</option>
                {TF_ROLES.map((r) => <option key={r.id} value={r.id}>{nameOf(r.role)}</option>)}
              </select>
              <Button size="sm" icon="users" disabled={!assignRole || !op} title={opWhy}
                onClick={() => {
                  const b = backupOf(assignRole);
                  act(inc, { assignee: roleLabel(assignRole), backup: roleLabel(b), assigneeRoleId: assignRole, backupRoleId: b, status: inc.status === 'open' ? 'ack' : inc.status, sla: { ...sla, ackAt: sla.ackAt ?? clockIso(), assignedAt: clockIso() } }, `배정 · ${roleLabel(assignRole)} (백업 ${roleLabel(b)})`);
                  setAssignRole('');
                }}>배정</Button>
            </div>
            <Field id={`act-${inc.id}`} label={`1차 조치 메모 · 권고: ${nextAction(inc.ruleId)}`}>
              <textarea id={`act-${inc.id}`} className="textarea" rows={2} disabled={!op} title={opWhy} value={actionNote} onChange={(e) => setActionNote(e.target.value)} placeholder="조치 내용 · 완료 시각 · 확인 수치" />
            </Field>
            <div className="row">
              <Button size="sm" variant={sla.ackAt && !sla.actionAt ? 'primary' : 'default'} icon="zap" disabled={!actionNote.trim() || !op} title={opWhy}
                onClick={() => { act(inc, { status: 'action', actionNote: actionNote.trim(), sla: { ...sla, ackAt: sla.ackAt ?? clockIso(), actionAt: sla.actionAt ?? clockIso() } }, `1차 조치 · ${actionNote.trim().slice(0, 60)}`); setActionNote(''); }}>1차 조치 기록</Button>
              <Button size="sm" icon="report" disabled={(!sla.actionAt && inc.severity !== 'P3') || !op} title={opWhy ?? (!sla.actionAt && inc.severity !== 'P3' ? '1차 조치 기록 후 보고' : undefined)}
                onClick={() => { act(inc, { sla: { ...sla, reportAt: sla.reportAt ?? clockIso() } }, server ? REPORT_ACTION_SERVER : '결과 보고 · 이슈 보고서 발송 (p.49 양식)'); setShowReport(true); }}>결과 보고</Button>
              <span className="xs muted">{inc.actionNote ? `기록된 조치: ${inc.actionNote}` : ''}</span>
            </div>
            <Field id={`prev-${inc.id}`} label="재발 방지 (탐지 기준 · 체크리스트 업데이트)">
              <textarea id={`prev-${inc.id}`} className="textarea" rows={2} disabled={!op} title={opWhy} value={preventNote} onChange={(e) => setPreventNote(e.target.value)} placeholder={preventSuggestion(inc)} />
            </Field>
            <div className="row">
              <Button size="sm" icon="shield" disabled={!op} title={opWhy} onClick={() => { const n = preventNote.trim() || preventSuggestion(inc); act(inc, { preventNote: n, sla: { ...sla, preventAt: clockIso() } }, '재발 방지 기록'); setPreventNote(''); }}>{preventNote.trim() ? '재발 방지 기록' : '권고안으로 기록'}</Button>
              <Button size="sm" variant="primary" icon="check" disabled={(!sla.actionAt && inc.severity !== 'P3') || !op} title={opWhy ?? (!sla.actionAt && inc.severity !== 'P3' ? '1차 조치 기록 후 해결 가능' : undefined)}
                onClick={() => { act(inc, { status: 'resolved', sla: { ...sla, resolvedAt: clockIso() } }, '해결'); actions.toast({ tone: 'good', title: '이슈 해결', body: inc.title }); }}>해결</Button>
              {!fpArmed ? (
                <Button size="sm" variant="ghost" icon="x" disabled={!op} title={opWhy} onClick={() => setFpArmed(true)}>오탐으로 종료</Button>
              ) : (
                <span className="row" style={{ gap: 6 }}>
                  <input id={`fp-${inc.id}`} className="input" style={{ width: 200 }} value={fpReason} onChange={(e) => setFpReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) closeFalsePositive(); }} placeholder="오탐 사유 (예: 집계 지연 정상화)" aria-label="오탐 사유" autoFocus />
                  <Button size="sm" variant="danger" disabled={!fpReason.trim()} onClick={closeFalsePositive}>확인</Button>
                  <Button size="sm" variant="ghost" onClick={() => setFpArmed(false)}>취소</Button>
                </span>
              )}
            </div>
          </div>
        ) : (
          <Callout tone="good" title={inc.falsePositive ? '오탐으로 종료' : '해결됨'}>{inc.actionNote ?? ''}{inc.preventNote ? ` · 재발 방지: ${inc.preventNote}` : ''}</Callout>
        )}
      </div>

      <div className="stack-sm">
        <div className="row-between"><span className="alert-section-label">감지 근거 수치</span><Src kind="DEMO" /></div>
        <EvidenceTable evidence={inc.evidence ?? []} />
        <div className="xs muted">판정 기준: {inc.basis ?? '—'} {inc.page ? <Src kind="PROPOSAL" page={inc.page} /> : null}</div>
      </div>

      <div className="stack-sm">
        <span className="alert-section-label">원인 후보 · 데이터 근거 순위</span>
        <CauseList causes={inc.causes} fallback={inc.causeCandidates} />
      </div>

      <div className="stack-sm">
        <div className="row-between"><span className="alert-section-label">영향 (p.49 양식: 노출 · 광고비 · 추정 매출 손실)</span><Src kind="DEMO" /></div>
        <div className="grid g-3" style={{ gap: 8 }}>
          <Stat label="노출 손실" value={inc.impact?.impressionsLost ? fmt.int(inc.impact.impressionsLost) : '—'} />
          <Stat label="광고비 영향" value={krwOrDash(inc.impact?.spendAtRisk)} />
          <Stat label="추정 매출 손실" value={krwOrDash(inc.impact?.revenueLossEst)} />
        </div>
        {inc.impactNote ? <div className="xs muted">{inc.impactNote}</div> : null}
      </div>

      <div className="stack-sm">
        <span className="alert-section-label">시스템 자동 조치</span>
        <div className="stack-sm" style={{ gap: 4 }}>
          {(inc.autoActions ?? []).map((a) => <div key={a} className="row small" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="check" size={14} /><span>{a}</span></div>)}
        </div>
      </div>

      <div className="stack-sm">
        <span className="alert-section-label">연결 요청 · 화면 (승인은 MILDO Flow)</span>
        <div className="row">
          {inc.holdMedia && !resolved ? (
            <Button size="sm" icon="play" disabled={!sla.actionAt || requested(`alert:${inc.id}:release`) || !perm.request} title={reqWhy ?? (!sla.actionAt ? '1차 조치 기록 후 요청 가능' : undefined)}
              onClick={() => requestChange({ kind: 'setting', target: `${mediaName(inc.holdMedia)} AD Pilot 자동 조정`, targetId: `alert:${inc.id}:release`, before: '보류', after: '재개', reason: `${inc.title} — 조치 완료 확인 후 자동 조정 재개`, approver: 'PM' }, '자동 조정 보류 해제 요청을 만들었습니다')}>
              {`자동 조정 보류 해제 요청${requested(`alert:${inc.id}:release`) ? '됨' : ''} (PM)`}
            </Button>
          ) : null}
          {inc.ruleId === 'account_payment' && acc && !resolved ? (() => {
            // 감지 시점 잔액(테스트 주입 이슈는 주입 데이터 기준)을 쓴다
            const balance = inc.metric === '잔액' && Number.isFinite(inc.observed) ? (inc.observed as number) : acc.balance;
            const daily = Number.isFinite(inc.baseline) && (inc.baseline as number) > 0 ? (inc.baseline as number) : acc.avgDailySpend;
            const days = cfg.runwayWarnDays;
            const topup = Math.max(0, Math.ceil((daily * days - balance) / 100000) * 100000);
            // 계정 단위 targetId — 계정 · 결제 탭 충전 요청과 같은 형식이라 중복 요청이 막히고 AD Pilot · Flow 잔액 계산에 반영된다
            const tid = `alert:account:${acc.id}:topup`;
            const prev = state.changes.find((c) => c.targetId === tid && c.status !== 'rejected');
            const prevAmt = prev ? Number(prev.after) - Number(prev.before) : NaN;
            const amt = prev && Number.isFinite(prevAmt) && prevAmt > 0 ? prevAmt : topup;
            return (
              <Button size="sm" icon="wallet" disabled={topup <= 0 || requested(tid) || !perm.request} title={reqWhy ?? (topup <= 0 ? `잔액이 이미 ${days}일치 이상` : requested(tid) ? '이 계정의 충전 요청이 이미 있습니다 (MILDO Flow)' : undefined)}
                onClick={() => requestChange({ kind: 'setting', target: `${acc.name} 비즈머니 충전`, targetId: tid, before: balance, after: balance + topup, changePct: balance > 0 ? (topup / balance) * 100 : undefined, reason: `잔액 ${fmt.krw(balance)}원 < 일 평균 소진 ${fmt.krw(daily)}원 · 자동충전 ${acc.autoCharge === 'failed' || inc.title.includes('자동충전 실패') ? '실패' : acc.autoCharge} → 주말 · 연휴 대비 ${days}일치까지 ${fmt.krw(topup)}원 충전 요청 (p.50 결제 수단 수면밀도 · ${days}일치는 운영 가정)`, approver: 'CLIENT' }, '충전 요청을 만들었습니다')}>
                {`충전 요청${prev ? '됨' : ''} ${fmt.krw(amt)}원 · ${days}일치 (수면밀도 승인)`}
              </Button>
            );
          })() : null}
          {inc.ruleId === 'account_permission' && !resolved ? (() => {
            // 계정 단위 targetId — 계정 · 결제 탭 권한 회수 요청과 같은 형식이라 두 화면에서 중복 요청이 생기지 않는다
            const tid = acc ? `alert:account:${acc.id}:revoke` : `alert:${inc.id}:revoke`;
            const users = acc ? acc.permissions.filter((x) => !x.realName || dayDiff(data.today, x.lastLogin) > cfg.staleLoginDays).map((x) => `${x.user}(${x.role})`).join(', ') : '';
            return (
              <Button size="sm" icon="shield" disabled={requested(tid) || !perm.request} title={reqWhy}
                onClick={() => requestChange({ kind: 'setting', target: `${inc.target} 권한 회수`, targetId: tid, before: users || '관리자 권한 유지', after: '회수 · 실명 계정 대체', reason: '담당자 실명 계정 · 최소 권한 · 교체 시 즉시 회수 (p.50)', approver: 'PM' }, '권한 회수 요청을 만들었습니다')}>
                {`권한 회수 요청${requested(tid) ? '됨' : ''} (PM → 수면밀도 통보)`}
              </Button>
            );
          })() : null}
          {inc.ruleId === 'soldout_landing' && !resolved ? (
            <Button size="sm" icon="pause" disabled={requested(`alert:${inc.id}:pause`) || !perm.request} title={reqWhy}
              onClick={() => requestChange({ kind: 'status', target: `${inc.target} 키워드`, targetId: `alert:${inc.id}:pause`, before: 'on', after: 'off', reason: `${inc.title} — 재입고 시 재개`, approver: 'AE' }, '키워드 일시 중지 요청을 만들었습니다')}>
              {`키워드 일시 중지 요청${requested(`alert:${inc.id}:pause`) ? '됨' : ''} (담당 AE)`}
            </Button>
          ) : null}
          {['budget_forecast', 'keyword_spike', 'brand_intrusion', 'budget_exhausted'].includes(inc.ruleId) ? <a className="btn sm" href="#adpilot">AD Pilot 조정 후보</a> : null}
          {['creative_rejected', 'creative_pending'].includes(inc.ruleId) ? <a className="btn sm" href="#lab">MILDO Lab 검수</a> : null}
          {inc.ruleId === 'brand_intrusion' ? <a className="btn sm" href="#watch">MILDO Watch 지면 점검</a> : null}
          <a className="btn sm" href="#flow">MILDO Flow 이력</a>
        </div>
        {reqWhy && !resolved ? <div className="xs muted">{reqWhy}</div> : null}
        {linked.length ? (
          <div className="stack-sm" style={{ gap: 4 }}>
            {linked.map((c) => (
              <div key={c.id} className="row xs" style={{ gap: 6 }}>
                <ChangeStatusPill status={c.status} />
                <span>{c.target}</span>
                <span className="muted">승인 {c.approver === 'CLIENT' ? '수면밀도' : c.approver}{canApprove(state.role, c.approver) ? ' · 현재 역할 승인 가능' : ''}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="stack-sm">
        <div className="row-between">
          <span className="alert-section-label">이슈 보고서 (p.49 양식 자동 생성)</span>
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant="ghost" icon={showReport ? 'chevronDown' : 'chevron'} onClick={() => setShowReport((v) => !v)}>{showReport ? '접기' : '미리보기'}</Button>
            <CopyButton text={report} />
            <DownloadButton filename={`MILDO-Alert-보고서-${inc.id.replace(/[^\w가-힣-]+/g, '_')}.md`} data={report} mime="text/markdown;charset=utf-8" label=".md" />
          </div>
        </div>
        {showReport ? <div className="card flat" style={{ padding: 12 }}><Markdown text={report()} /></div> : null}
      </div>

      <div className="stack-sm">
        <span className="alert-section-label">타임라인</span>
        <div className="alert-timeline">
          {inc.timeline.map((t, k) => (
            <div key={k} className={t.by === 'MILDO Alert' ? 'sys' : undefined}>
              <span className="num xs muted">{fmtStamp(toMs(t.at))}</span> <strong className="small">{t.by}</strong> <span className="small">{t.action}</span>
            </div>
          ))}
        </div>
        <div className="xs muted">현재 단계 {st.stageLabel} · {fmtRemain(st.remainingMin)}</div>
      </div>
    </Drawer>
  );
}
