/**
 * AD Pilot 화면 상태 — 스토어(state.changes)에서 현재 입찰가 · 예산 · 상태를 파생하고
 * 승인 흐름(요청 → 승인 → 반영 → 롤백)을 ChangeRequest 로 기록한다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { nowIso } from '@/core/util';
import {
  type AdPilotConfig, type AdPilotProposal, type BulkCheck, type ChangeInput, CONFIG_FIELDS, applyIncidentHolds, canApprove, canNotify, canRollback, checkBulk, configDiff,
  diagnoseKeywords, effectiveBids, effectiveCampaigns, effectiveKeywordStatus, explainBidDown, generateBidProposals, gfaOverview, holdIncident,
  latestChangeFor, matchingIncident, mediaGuards, officialConfig, paceCampaigns, proposalChangeInput, settingChangeInputs, validateAdpilotExecution,
  validateGfaExecution, type BulkItem,
} from './engine';

export const ACTIVE = new Set<ChangeRequest['status']>(['pending', 'approved', 'applied', 'held']);
export const STATUS_LABEL: Record<ChangeRequest['status'] | 'none', string> = {
  none: '후보', pending: '승인 대기', approved: '승인', applied: '반영', rejected: '반려', rolled_back: '롤백', held: '실행 보류',
};
export const STATUS_TONE: Record<ChangeRequest['status'] | 'none', 'neutral' | 'warning' | 'good' | 'critical' | 'outline' | 'accent' | 'serious'> = {
  none: 'outline', pending: 'warning', approved: 'accent', applied: 'good', rejected: 'neutral', rolled_back: 'neutral', held: 'serious',
};

export function useAdPilot() {
  const { state } = useStore();
  const actions = useActions();
  const data = state.data;
  const official = useMemo(() => officialConfig(state.changes), [state.changes]);
  const [draft, setDraft] = useState<AdPilotConfig>(official);
  // 공식 기준이 바뀌면(기준 변경 반영) 편집 중이 아닐 때만 동기화
  const prevOfficial = useRef(official);
  useEffect(() => {
    if (configDiff(prevOfficial.current, draft).length === 0) setDraft(official);
    prevOfficial.current = official;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [official]);
  const cfg = draft;
  const dirty = configDiff(official, draft);

  /** 데이터 판정 후보 (규칙 엔진) */
  const baseProposals = useMemo(() => generateBidProposals(data, cfg), [data, cfg]);
  /** + MILDO Alert 열린 이슈(전환 추적 단절 · 데이터 급변 · 키워드 급변) 연계 보류 — 같은 대상은 한 건으로 합침 */
  const proposals = useMemo(() => applyIncidentHolds(baseProposals, state.incidents, data, state.changes, cfg), [baseProposals, state.incidents, data, state.changes, cfg]);
  const downInfo = useMemo(() => explainBidDown(data, cfg, baseProposals), [data, cfg, baseProposals]);
  const bids = useMemo(() => effectiveBids(data, state.changes), [data, state.changes]);
  const kwStatus = useMemo(() => effectiveKeywordStatus(state.changes), [state.changes]);
  const diag = useMemo(() => diagnoseKeywords(data, { ...cfg, currentBids: bids }, kwStatus), [data, cfg, bids, kwStatus]);
  const guards = useMemo(() => mediaGuards(data, cfg), [data, cfg]);
  const paces = useMemo(() => paceCampaigns(data, effectiveCampaigns(data, state.changes), cfg), [data, state.changes, cfg]);
  const gfa = useMemo(() => gfaOverview(data, state.changes, cfg), [data, state.changes, cfg]);
  const changes = useMemo(() => state.changes.filter((c) => c.module === 'adpilot' || c.module === 'gfa'), [state.changes]);
  const saDailyBudget = useMemo(() => data.campaigns.filter((c) => c.media === 'naver_sa').reduce((a, c) => a + c.dailyBudget, 0), [data]);

  const changeOf = (p: AdPilotProposal) => latestChangeFor(state.changes, 'adpilot', p.changeTargetId);
  const statusOf = (p: AdPilotProposal): ChangeRequest['status'] | 'none' => changeOf(p)?.status ?? 'none';
  const requestable = (p: AdPilotProposal) => {
    const c = changeOf(p);
    return (!c || !ACTIVE.has(c.status)) && (p.action !== 'hold' || p.holdKind === 'soldout');
  };

  /** 미승인 기준으로 시뮬레이션 중에 만든 요청은 사유에 그 기준을 남긴다 (누가 · 언제 · 왜) */
  const simNote = () => (dirty.length
    ? ` [미승인 기준 시뮬레이션 중 생성: ${dirty.map((d) => `${CONFIG_FIELDS.find((f) => f.key === d.key)?.label ?? d.key} ${d.before} → ${d.after}`).join(', ')}]`
    : '');
  const request = (p: AdPilotProposal, silent = false) => {
    const input = proposalChangeInput(p, state.role);
    if (!input || !requestable(p)) return null;
    const c = actions.addChange({ ...input, reason: `${input.reason}${simNote()}` });
    if (!silent) actions.toast({ tone: 'info', title: '승인 요청을 만들었습니다', body: `${c.target} · 승인 주체 ${c.approver === 'CLIENT' ? '수면밀도' : c.approver === 'PM' ? 'PM' : '담당 AE'}`, route: 'flow' });
    return c;
  };
  const requestInput = (input: ChangeInput, silent = false) => {
    const c = actions.addChange(input.kind === 'bid' && input.module === 'adpilot' ? { ...input, reason: `${input.reason}${simNote()}` } : input);
    if (!silent) actions.toast({ tone: 'info', title: '승인 요청을 만들었습니다', body: `${c.target} · ${c.before} → ${c.after}`, route: 'flow' });
    return c;
  };
  const approve = (c: ChangeRequest, silent = false) => {
    const perm = canApprove(state.role, c.approver);
    if (!perm.ok) { if (!silent) actions.toast({ tone: 'warning', title: '승인 권한이 없습니다', body: perm.reason }); return false; }
    if (c.status !== 'pending') return false;
    actions.updateChange(c.id, { status: 'approved' }, '승인', perm.reason);
    return true;
  };
  const reject = (c: ChangeRequest) => {
    const perm = canApprove(state.role, c.approver);
    if (!perm.ok || c.status !== 'pending') return false;
    actions.updateChange(c.id, { status: 'rejected' }, '반려', `${state.role} 반려`);
    return true;
  };
  const apply = (c: ChangeRequest, silent = false) => {
    if (c.status !== 'approved') return false;
    if (c.module === 'gfa') {
      const v = validateGfaExecution(gfa, c);
      if (!v.ok) {
        actions.updateChange(c.id, { status: 'held' }, '실행 보류', v.reason);
        if (!silent) actions.toast({ tone: 'warning', title: 'GFA 실행 보류', body: v.reason, route: 'alert' });
        return false;
      }
      actions.updateChange(c.id, { status: 'applied' }, '실행 · 반영', v.reason);
      if (!silent) actions.toast({ tone: 'good', title: 'GFA 변경을 실행했습니다', body: `${c.target}: ${c.before} → ${c.after}` });
      return true;
    }
    // 승인 뒤 보류(매체 급변 · 전환 추적 단절 · MILDO Alert 이슈)가 생긴 대상은 반영하지 않는다
    const ex = validateAdpilotExecution(data, c, proposals);
    if (!ex.ok) {
      actions.updateChange(c.id, { status: 'held' }, '반영 보류', ex.reason);
      if (!silent) actions.toast({ tone: 'warning', title: 'AD Pilot 반영 보류', body: ex.reason, route: 'alert' });
      return false;
    }
    actions.updateChange(c.id, { status: 'applied' }, '반영', ex.reason);
    if (!silent) actions.toast({ tone: 'good', title: '반영했습니다', body: `${c.target}: ${c.before} → ${c.after} · 롤백 가능` });
    return true;
  };
  const retry = (c: ChangeRequest) => {
    if (c.status !== 'held') return;
    const v = c.module === 'gfa' ? validateGfaExecution(gfa, { ...c, status: 'approved' }) : validateAdpilotExecution(data, { ...c, status: 'approved' }, proposals);
    if (!v.ok) {
      actions.updateChange(c.id, {}, '재실행 보류', v.reason);
      actions.toast({ tone: 'warning', title: '여전히 실행할 수 없습니다', body: v.reason });
      return;
    }
    actions.updateChange(c.id, { status: 'applied' }, '재실행 · 반영', v.reason);
  };
  const cancel = (c: ChangeRequest) => {
    if (c.status !== 'held' && c.status !== 'approved') return;
    actions.updateChange(c.id, { status: 'rejected' }, '실행 취소', `${state.role} 취소 — 실행하지 않고 종료`);
  };
  const rollback = (c: ChangeRequest, silent = false) => {
    const r = canRollback(state.changes, c);
    if (!r.ok) { if (!silent) actions.toast({ tone: 'warning', title: '롤백할 수 없습니다', body: r.reason }); return false; }
    actions.updateChange(c.id, { status: 'rolled_back' }, '롤백', `직전 상태로 복원: ${c.after} → ${c.before}`);
    if (!silent) actions.toast({ tone: 'info', title: '롤백했습니다', body: `${c.target}: ${c.before}로 복원` });
    return true;
  };
  const rollbackAll = () => {
    const applied = changes.filter((c) => c.status === 'applied' && c.kind !== 'setting');
    applied.forEach((c) => actions.updateChange(c.id, { status: 'rolled_back' }, '일괄 롤백', `직전 상태로 복원: ${c.after} → ${c.before}`));
    actions.toast({ tone: 'info', title: `반영 ${applied.length}건을 롤백했습니다`, body: '모든 대상이 직전 입찰 · 예산 상태로 돌아갔습니다' });
    return applied.length;
  };
  const notify = (p: AdPilotProposal) => {
    if (!canNotify(p)) return null;
    const existing = matchingIncident(p, state.incidents, data);
    if (existing) {
      actions.toast({ tone: 'info', title: `MILDO Alert에 이미 열린 이슈가 있습니다 · ${existing.severity}`, body: `${existing.title} (${existing.id}) — 새 이슈를 만들지 않고 연결합니다`, route: 'alert' });
      return existing;
    }
    const inc = holdIncident(data, p, nowIso());
    actions.addIncident(inc);
    actions.toast({ tone: inc.severity === 'P1' ? 'critical' : 'warning', title: `${inc.severity} · ${inc.title}`, body: p.basis, route: 'alert' });
    return inc;
  };

  const bulkItems = (ps: AdPilotProposal[]): BulkItem[] => ps.map((p) => ({ kind: p.kind, changePct: p.action === 'test_candidate' || p.action === 'hold' ? 0 : p.changePct, costDelta: p.costDelta }));
  const bulkCheck = (ps: AdPilotProposal[]): BulkCheck => checkBulk(bulkItems(ps), cfg, saDailyBudget);

  const submitSettings = () => {
    const inputs = settingChangeInputs(official, draft, state.role);
    inputs.forEach((i) => actions.addChange(i));
    actions.toast({ tone: 'info', title: `기준 변경 승인 요청 ${inputs.length}건`, body: '반영되면 공식 기준이 바뀝니다 (MILDO Flow)', route: 'flow' });
  };

  return {
    state, data, actions, cfg, official, draft, setDraft, dirty, baseProposals, proposals, downInfo, bids, kwStatus, diag, guards, paces, gfa, changes, saDailyBudget,
    changeOf, statusOf, requestable, request, requestInput, approve, reject, apply, retry, cancel, rollback, rollbackAll, notify, bulkCheck, submitSettings,
    canApprove: (c: ChangeRequest) => canApprove(state.role, c.approver),
    canRollback: (c: ChangeRequest) => canRollback(state.changes, c),
    linkedIncident: (p: AdPilotProposal) => matchingIncident(p, state.incidents, data),
  };
}

export type AdPilotCtx = ReturnType<typeof useAdPilot>;
