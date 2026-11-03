/* 변경 요청 상세 — 누가 · 언제 · 왜, 승인 근거, 실행 점검, 액션 (권한 체크 · 2단계 확인) */
import { useState } from 'react';
import { DECISION_MATRIX, GFA_DELEGATION } from '@/data/constants';
import { Callout, Drawer, Field, Pill, Src } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { MODULE_ROUTE } from './data';
import {
  ACTION_META, actionAllowed, actorLabel, APPROVER_LABEL, availableActions, canAct, decisionOf, delegationIndexByPct, executionCheck, fmtStamp, isSeed, leadState,
  linkedChanges, mediaName, mediaOfChange, moduleLabel, roleScopeShort, serverPreApplyCheck, type FlowAction,
} from './engine';
import { ApproverBadge, ChangeValue, ConfirmButton, KV, LeadBadge, ModuleTag, SeedTag, StatusPill, settled } from './parts';
import type { FlowCtx } from './useFlow';
import { Button } from '@/ui/primitives';
import { ExecBadge, ExecutionPanel } from './ExecutionPanel';
import { isExecuting } from './execution';

export function ChangeDrawer({ ctx, id, onClose: close }: { ctx: FlowCtx; id: string; onClose: () => void }) {
  const { changes, data, incidents, clock, act, bulkAlerts, server, actor } = ctx;
  const c = changes.find((x) => x.id === id);
  const [note, setNote] = useState('');
  // 더블 클릭의 두 번째 클릭으로 막 열린 창이 닫히는 것은 공용 Drawer 오버레이가 막는다(event.detail < 2)
  const onClose = close;
  if (!c) return <Drawer title="요청 없음" onClose={onClose}><div className="small muted">요청을 찾지 못했습니다 (초기화되었을 수 있음).</div></Drawer>;
  const lead = leadState(c, clock.nowMs, clock.toMs);
  const dec = decisionOf(c);
  const perm = canAct(actor, c.approver);
  const avail = availableActions(c, actor, changes);
  /**
   * 권한으로 처리할 수 있는 다음 단계가 하나라도 있는가 (롤백 순서 같은 상태 조건은 제외 — 권한만).
   * 데모: 승인 범위(canAct)와 같다. 서버: 승인 범위 안이어도 반영 · 보류는 운영 권한이 따로 필요하다(광고주 담당자는 승인 · 반려까지).
   */
  const permFor = avail.map((a) => actionAllowed(actor, c.approver, a.action));
  const canSome = permFor.length ? permFor.some((p) => p.ok) : perm.ok;
  /** 서버 모드: 일부 단계만 가능한 경우(담당 AE의 PM 건 보류 · 광고주 담당자의 반영) — 막힌 단계와 그 이유를 함께 보인다 */
  const blockedPerm = server ? permFor.find((p) => !p.ok) : undefined;
  const pill = canSome
    ? (blockedPerm ? <Pill tone="warning" icon="alert" title={blockedPerm.reason}>일부 단계만 가능</Pill> : <Pill tone="good" icon="check">처리 가능</Pill>)
    : <Pill tone="neutral" icon="x">권한 밖</Pill>;
  // 서버 모드: 서버 가드(대량 변경 차단 포함) 기준 예상 · 데모 꼬리표 없이 — 판정은 서버가 한다
  const ex = c.status === 'approved' ? (server ? serverPreApplyCheck(data, changes, incidents, c) : executionCheck(data, changes, incidents, c)) : null;
  const pct = c.changePct;
  const delIdx = (c.kind === 'budget' || c.kind === 'bid') && pct !== undefined && Number.isFinite(pct) ? delegationIndexByPct(pct) : c.kind === 'status' ? 1 : c.kind === 'gfa' ? 2 : null;
  const media = mediaOfChange(data, c);
  const related = incidents.filter((i) => linkedChanges(data, i, [c], clock.toMs).length > 0);
  const bulkHits = bulkAlerts.filter((b) => b.related.includes(c.id));
  const run = settled((a: FlowAction) => { if (act(c, a, note)) setNote(''); });

  return (
    <Drawer title={<span className="row" style={{ gap: 8 }}><StatusPill status={c.status} /><ModuleTag module={c.module} /><SeedTag c={c} /></span>} onClose={onClose}>
      <div className="stack-sm">
        <h3 style={{ fontSize: 'var(--fs-xl)', lineHeight: 1.3 }}>{c.target}</h3>
        <ChangeValue c={c} />
        <div className="row" style={{ gap: 6 }}>
          <ApproverBadge c={c} />
          <LeadBadge l={lead} />
          <ExecBadge c={c} />
          {isSeed(c) ? <Src kind="DEMO" fixture title="시연용 이력 · 실제 운영 이력 아님" /> : null}
        </div>
      </div>

      <div className="flow-reason">
        <div className="xs muted">요청 사유 · {c.requestedBy} · {fmtStamp(lead.createdMs)}</div>
        <div className="small">{c.reason}</div>
      </div>

      <div className="stack-sm">
        <div className="zone-label">승인 근거</div>
        <KV k="결정 유형 (p.53)" v={<>{dec.row.type} · 결정자 {dec.row.decider} · 소요 {dec.row.lead} <Src kind="PROPOSAL" page="p.53" />{dec.delegated ? <span className="xs muted" style={{ display: 'block' }}>{dec.delegated}</span> : null}</>} />
        {delIdx !== null ? <KV k="위임 범위 (p.15)" v={<>{GFA_DELEGATION[delIdx].range} → {GFA_DELEGATION[delIdx].label} <span className="muted">· {c.kind === 'bid' ? `입찰은 변경 폭 기준 준용 · 일 조정 폭 상한 ${ctx.apCfg.dailyChangeCapPct}% 별도 (p.14) · ` : ''}예시 · 계약 시 확정</span></>} /> : null}
        <KV k="판정 시한" v={<>{dec.rule.label} <span className="muted">· {dec.rule.note}</span></>} />
        <KV k="대상 매체" v={mediaName(media)} />
        <KV k="현재 역할" v={<>{actorLabel(actor)} · {roleScopeShort(actor)} {pill}</>} />
        {server ? (
          !canSome || blockedPerm ? (
            <div className="xs muted">
              {(blockedPerm ?? perm).reason}. {perm.ok ? '반영 · 보류' : '승인'} 권한은 멤버십 역할로 정해집니다 — 팀 · 권한에서 관리자가 바꿉니다 (서버가 최종 판정).
            </div>
          ) : null
        ) : !canSome ? (
          <div className="xs muted">
            {perm.reason}. 상단 역할 선택에서 {APPROVER_LABEL[c.approver]}(으)로 바꾸면 처리할 수 있습니다.
          </div>
        ) : null}
      </div>

      {bulkHits.length ? (
        <Callout tone="critical" title="대량 변경 실수 감지 대상 (MILDO Alert · p.45)">
          {bulkHits.map((b) => <div key={b.id}>{b.title} · {b.basis}</div>)}
          <div className="xs">반영 전 건별 근거를 확인하고, 잘못 반영된 건은 최신 건부터 롤백합니다.</div>
        </Callout>
      ) : null}

      {ex ? (
        <Callout tone={ex.ok ? (ex.warnings.length ? 'warning' : 'good') : 'critical'} title={ex.ok ? (server ? '반영 전 실행 점검 통과 예상 (서버가 반영 시 다시 판정)' : '반영 전 실행 점검 통과') : (server ? '반영 시 서버 실행 보류 예상' : '반영 시 실행 보류 예상')}>
          <div className="stack-sm" style={{ gap: 2 }}>
            {ex.blocks.map((b, k) => <div key={`b${k}`}>{b}</div>)}
            {ex.warnings.map((w, k) => <div key={`w${k}`}>{w}</div>)}
            {ex.ok ? ex.passes.map((p, k) => <div key={`p${k}`}>{p}</div>) : null}
            <div className="xs">기준: 지원 API 범위 내 실행, 오류 시 보류 · 보고 (p.15 04) · 전환 추적 단절 시 자동 조정 보류 (p.45) · GFA · AD Pilot 요청은 해당 화면과 같은 실행 검증</div>
          </div>
        </Callout>
      ) : null}

      <ExecutionPanel c={c} />

      {avail.length ? (
        <div className="stack-sm">
          <div className="zone-label">액션</div>
          {isExecuting(c) ? <div className="xs muted">매체 반영 · 롤백이 서버에서 진행 중입니다. 끝나면 결과가 자동으로 갱신되고, 그때까지 다른 처리는 서버가 받지 않습니다.</div> : null}
          <Field label="메모 · 사유 (반려 · 보류 · 실행 취소는 필수)" id="flow-note">
            <input id="flow-note" className="input" value={note} placeholder="예: 근거 보완 후 재요청 · 결제 확인 후 반영" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row">
            {avail.map((a) => {
              const m = ACTION_META[a.action];
              const disabled = !a.ok || (m.needsNote && !note.trim()) || isExecuting(c);
              const title = !a.ok ? a.reason : m.needsNote && !note.trim() ? '사유를 입력하세요' : a.reason;
              return m.confirm
                ? <ConfirmButton key={a.action} label={m.label} icon={m.icon} variant={m.variant} disabled={disabled} title={title} onConfirm={() => run(a.action)} />
                : <Button key={a.action} size="sm" icon={m.icon} variant={m.variant === 'danger' ? 'danger' : m.variant} disabled={disabled} title={title} onClick={(e) => { if (e.detail > 1) return; run(a.action); }}>{m.label}</Button>;
            })}
          </div>
          {avail.some((a) => !a.ok) ? <div className="xs muted">{avail.find((a) => !a.ok)?.reason}</div> : null}
        </div>
      ) : <div className="small muted">종료된 요청입니다 ({c.status === 'rejected' ? '반려 · 실행 취소' : '롤백'}). 같은 대상은 신규 요청으로 다시 올립니다.</div>}

      <div className="stack-sm">
        <div className="zone-label">이력 · 누가 · 언제 · 왜</div>
        <ol className="flow-history">
          {c.history.map((h, k) => (
            <li key={k}>
              <span className="flow-history-dot" aria-hidden />
              <div>
                <div className="small"><strong>{h.action}</strong> <span className="muted">· {h.by} · {fmtStamp(clock.toMs(h.at))}</span></div>
                {h.note ? <div className="xs ink2">{h.note}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {related.length ? (
        <div className="stack-sm">
          <div className="zone-label">관련 이슈 (MILDO Alert)</div>
          {related.map((i) => (
            <a key={i.id} href="#alert" className="flow-related"><span className={`sev ${i.severity}`}><Icon name="alert" size={11} stroke={2.4} />{i.severity}</span> {i.title}</a>
          ))}
        </div>
      ) : null}
      <div className="xs muted">원본 화면: <a href={`#${MODULE_ROUTE[c.module] ?? c.module}`}>{moduleLabel(c.module)}</a> · 결정 유형 {DECISION_MATRIX.length}종 기준</div>
    </Drawer>
  );
}
