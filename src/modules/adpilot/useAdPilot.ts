/**
 * AD Pilot 화면 상태 — 스토어(state.changes)에서 현재 입찰가 · 예산 · 상태를 파생하고
 * 승인 흐름(요청 → 승인 → 반영 → 롤백)을 ChangeRequest 로 기록한다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { nowIso, withJosa } from '@/core/util';
import { actorLabel, type Actor, type ChangeAction } from '@/core/permissions';
import { useSaas } from '@/saas/context';
import {
  type AdPilotConfig, type AdPilotProposal, type BulkCheck, type ChangeInput, CONFIG_FIELDS, applyIncidentHolds, canApprove, canNotify, canOperate, canRaiseIncident, canRequest, canRollback,
  changePermission, checkBulk, configDiff,
  diagnoseKeywords, effectiveBids, effectiveCampaigns, effectiveKeywordStatus, explainBidDown, generateBidProposals, gfaOverview, holdIncident,
  latestChangeFor, matchingIncident, mediaGuards, officialConfig, paceCampaigns, proposalChangeInput, settingChangeInputs, validateAdpilotExecution,
  validateGfaExecution, type BulkItem, fmtChangeValue, rollbackAllPlan, splitSettingInputs,
} from './engine';

/** 화면 엔진 문구의 데모 꼬리표 '(데모: 로컬 상태 …)' — 서버 모드 이력 · 알림에는 남기지 않는다 (서버 executor serverText와 같은 규칙) */
const stripDemoTag = (t: string): string => t.replace(/\s*\(데모: 로컬 상태[^)]*\)/g, '').trim();

export const ACTIVE = new Set<ChangeRequest['status']>(['pending', 'approved', 'applied', 'held']);
export const STATUS_LABEL: Record<ChangeRequest['status'] | 'none', string> = {
  none: '후보', pending: '승인 대기', approved: '승인', applied: '반영', rejected: '반려', rolled_back: '롤백', held: '실행 보류',
};
export const STATUS_TONE: Record<ChangeRequest['status'] | 'none', 'neutral' | 'warning' | 'good' | 'critical' | 'outline' | 'accent' | 'serious'> = {
  none: 'outline', pending: 'warning', approved: 'accent', applied: 'good', rejected: 'neutral', rolled_back: 'neutral', held: 'serious',
};

/**
 * 공식 기준(목표 ROAS · SAFETY) = 워크스페이스 설정 기본값 + 승인 · 반영된 기준 변경.
 * 워크스페이스 설정이 바뀌면(다른 사용자가 저장 → config 이벤트 → 설정 다시 적용) 같은 changes여도 다시 계산한다 —
 * 그렇지 않으면 열린 화면이 예전 목표로 판정하면서 '새 설정으로 계산합니다' 안내만 뜬다.
 */
export function useOfficialConfig(changes: readonly ChangeRequest[]): AdPilotConfig {
  const wsConfig = useSaas().config;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => officialConfig(changes), [changes, wsConfig]);
}

/**
 * 권한 판정 주체 — 데모: 데모 3역할(역할 선택), 서버: 멤버십 역할(서버와 같은 권한표 · 전이별 판정).
 * 서버 모드에서 역할을 모르면(워크스페이스 정보 전) 열람자로 본다 — 서버가 거절할 버튼을 켜지 않게.
 */
export function useActor(): { actor: Actor; server: boolean } {
  const { state } = useStore();
  const saas = useSaas();
  const server = saas.mode === 'server';
  const member = saas.role;
  const actor = useMemo<Actor>(() => (server ? { member: member ?? 'viewer' } : state.role), [server, member, state.role]);
  return { actor, server };
}

export function useAdPilot() {
  const { state } = useStore();
  const actions = useActions();
  const data = state.data;
  const { actor, server } = useActor();
  const official = useOfficialConfig(state.changes);
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
  /** 변경 요청 만들기 권한 (서버: 열람자 불가 — 버튼은 비활성 + 이유, 여기서도 다시 막는다) */
  const requestPerm = canRequest(actor);
  /** MILDO Alert 이슈 등록(알림 발송) 권한 (서버: 운영 권한) */
  const incidentPerm = canRaiseIncident(actor);
  const denyRequest = (silent: boolean) => {
    if (!silent) actions.toast({ tone: 'warning', title: '변경 요청 권한이 없습니다', body: requestPerm.reason });
    return null;
  };
  const request = (p: AdPilotProposal, silent = false) => {
    if (!requestPerm.ok) return denyRequest(silent);
    const input = proposalChangeInput(p, state.role);
    if (!input || !requestable(p)) return null;
    const c = actions.addChange({ ...input, reason: `${input.reason}${simNote()}` });
    if (!silent) actions.toast({ tone: 'info', title: '승인 요청을 만들었습니다', body: `${c.target} · 승인 주체 ${c.approver === 'CLIENT' ? '수면밀도' : c.approver === 'PM' ? 'PM' : '담당 AE'}`, route: 'flow' });
    return c;
  };
  const requestInput = (input: ChangeInput, silent = false) => {
    if (!requestPerm.ok) return denyRequest(silent);
    const c = actions.addChange(input.kind === 'bid' && input.module === 'adpilot' ? { ...input, reason: `${input.reason}${simNote()}` } : input);
    if (!silent) actions.toast({ tone: 'info', title: '승인 요청을 만들었습니다', body: `${c.target} · ${fmtChangeValue(c.kind, c.before)} → ${fmtChangeValue(c.kind, c.after)} · 승인 주체 ${c.approver === 'CLIENT' ? '수면밀도' : c.approver === 'PM' ? 'PM' : '담당 AE'}`, route: 'flow' });
    return c;
  };
  /*
   * 이력 메모: 서버 모드는 서버가 권한 근거 · 실행 점검 · 매체 반영 기록(dry_run · live) · 복원 내용을 이력에 직접 남긴다 —
   * 화면 판정 문구(데모 꼬리표 '(데모: 로컬 상태 …)' 포함)를 메모로 보내면 서버 이력에 중복으로 붙는다. 데모 모드는 그대로.
   */
  const memo = (demoNote: string, serverNote?: string) => (server ? serverNote : demoNote);
  const approve = (c: ChangeRequest, silent = false) => {
    const perm = canApprove(actor, c.approver);
    if (!perm.ok) { if (!silent) actions.toast({ tone: 'warning', title: '승인 권한이 없습니다', body: perm.reason }); return false; }
    if (c.status !== 'pending') return false;
    actions.updateChange(c.id, { status: 'approved' }, '승인', memo(perm.reason));
    return true;
  };
  const reject = (c: ChangeRequest) => {
    const perm = canApprove(actor, c.approver);
    if (!perm.ok || c.status !== 'pending') return false;
    actions.updateChange(c.id, { status: 'rejected' }, '반려', memo(`${state.role} 반려`));
    return true;
  };
  /** 승인 이후 단계 권한 — 데모: 승인 주체 범위 (MILDO Flow 와 같은 규칙), 서버: 단계별 서버 판정(반영 · 롤백은 운영 권한도) */
  const operable = (c: ChangeRequest, silent: boolean, action: ChangeAction = 'apply') => {
    const perm = changePermission(actor, c, action);
    if (!perm.ok && !silent) actions.toast({ tone: 'warning', title: '처리 권한이 없습니다', body: perm.reason });
    return perm.ok;
  };
  const sent = (what: string) => `${what} · 서버 실행 점검 · 매체 반영 결과(dry_run · live)는 이어서 알립니다`;
  const val = (c: ChangeRequest, v: ChangeRequest['before']) => fmtChangeValue(c.kind, v);
  const apply = (c: ChangeRequest, silent = false) => {
    if (c.status !== 'approved') return false;
    if (!operable(c, silent, 'apply')) return false;
    if (c.module === 'gfa') {
      const v = validateGfaExecution(gfa, c);
      if (!v.ok) {
        actions.updateChange(c.id, { status: 'held' }, '실행 보류', v.reason);
        if (!silent) actions.toast({ tone: 'warning', title: 'GFA 실행 보류', body: v.reason, route: 'alert' });
        return false;
      }
      actions.updateChange(c.id, { status: 'applied' }, '실행 · 반영', memo(v.reason));
      // 서버 모드: 서버가 보류(잔액 · 대량 변경 · 상한)할 수 있고 dry_run이면 매체에 가지 않는다 — 보냈다는 사실만 알린다
      if (!silent) {
        if (server) actions.toast({ tone: 'info', title: 'GFA 실행 요청을 보냈습니다', body: sent(`${c.target}: ${val(c, c.before)} → ${val(c, c.after)}`), route: 'flow' });
        else actions.toast({ tone: 'good', title: 'GFA 변경을 실행했습니다', body: `${c.target}: ${val(c, c.before)} → ${val(c, c.after)}` });
      }
      return true;
    }
    // 승인 뒤 보류(매체 급변 · 전환 추적 단절 · MILDO Alert 이슈)가 생긴 대상은 반영하지 않는다
    const ex = validateAdpilotExecution(data, c, proposals);
    if (!ex.ok) {
      actions.updateChange(c.id, { status: 'held' }, '반영 보류', ex.reason);
      if (!silent) actions.toast({ tone: 'warning', title: 'AD Pilot 반영 보류', body: ex.reason, route: 'alert' });
      return false;
    }
    actions.updateChange(c.id, { status: 'applied' }, '반영', memo(ex.reason));
    if (!silent) {
      if (server) actions.toast({ tone: 'info', title: '반영 요청을 보냈습니다', body: sent(`${c.target}: ${val(c, c.before)} → ${val(c, c.after)}`), route: 'flow' });
      else actions.toast({ tone: 'good', title: '반영했습니다', body: `${c.target}: ${val(c, c.before)} → ${val(c, c.after)} · 롤백 가능` });
    }
    return true;
  };
  const retry = (c: ChangeRequest) => {
    if (c.status !== 'held') return;
    if (!operable(c, false, 'retry')) return;
    const v = c.module === 'gfa' ? validateGfaExecution(gfa, { ...c, status: 'approved' }) : validateAdpilotExecution(data, { ...c, status: 'approved' }, proposals);
    if (!v.ok) {
      actions.updateChange(c.id, {}, '재실행 보류', server ? stripDemoTag(v.reason) : v.reason);
      actions.toast({ tone: 'warning', title: '여전히 실행할 수 없습니다', body: v.reason });
      return;
    }
    actions.updateChange(c.id, { status: 'applied' }, '재실행 · 반영', memo(v.reason));
    if (server) actions.toast({ tone: 'info', title: c.module === 'gfa' ? 'GFA 재실행 요청을 보냈습니다' : '재실행 요청을 보냈습니다', body: sent(`${c.target}: ${val(c, c.before)} → ${val(c, c.after)}`), route: 'flow' });
    else actions.toast({ tone: 'good', title: c.module === 'gfa' ? 'GFA 변경을 재실행했습니다' : '재실행 · 반영했습니다', body: `${c.target}: ${val(c, c.before)} → ${val(c, c.after)} · 롤백 가능` });
  };
  const cancel = (c: ChangeRequest) => {
    if (c.status !== 'held' && c.status !== 'approved') return;
    if (!operable(c, false, 'cancel')) return;
    actions.updateChange(c.id, { status: 'rejected' }, '실행 취소', memo(`${state.role} 취소 — 실행하지 않고 종료`, '실행하지 않고 종료'));
    actions.toast({ tone: 'info', title: '실행을 취소했습니다', body: `${c.target} — 실행하지 않고 종료 (반려 상태)` });
  };
  const rollback = (c: ChangeRequest, silent = false) => {
    const r = canRollback(state.changes, c);
    if (!r.ok) { if (!silent) actions.toast({ tone: 'warning', title: '롤백할 수 없습니다', body: r.reason }); return false; }
    if (!operable(c, silent, 'rollback')) return false;
    actions.updateChange(c.id, { status: 'rolled_back' }, '롤백', memo(`직전 상태로 복원: ${val(c, c.after)} → ${val(c, c.before)}`));
    if (!silent) {
      if (server) actions.toast({ tone: 'info', title: '롤백 요청을 보냈습니다', body: sent(`${c.target}: ${withJosa(val(c, c.before), '으로/로')} 복원 요청`), route: 'flow' });
      else actions.toast({ tone: 'info', title: '롤백했습니다', body: `${c.target}: ${val(c, c.before)}로 복원` });
    }
    return true;
  };
  const rollbackPlan = useMemo(() => rollbackAllPlan(state.changes, actor), [state.changes, actor]);
  const rollbackAll = () => {
    const { list, skipped } = rollbackPlan;
    list.forEach((c) => actions.updateChange(c.id, { status: 'rolled_back' }, '일괄 롤백', memo(`직전 상태로 복원: ${val(c, c.after)} → ${val(c, c.before)}`)));
    const who = actorLabel(actor);
    actions.toast({
      tone: skipped.length ? 'warning' : 'info',
      title: server ? `반영 ${list.length}건의 롤백 요청을 보냈습니다` : `반영 ${list.length}건을 롤백했습니다`,
      body: skipped.length
        ? `현재 역할(${who}) ${server ? '권한' : '승인 범위'} 밖 ${skipped.length}건은 그대로 둡니다 — 승인 주체가 롤백하세요`
        : server ? '서버 매체 반영 결과(dry_run · live)는 건별로 이어서 알립니다' : '모든 대상이 직전 입찰 · 예산 상태로 돌아갔습니다',
    });
    return list.length;
  };
  const notify = (p: AdPilotProposal) => {
    if (!canNotify(p)) return null;
    if (!incidentPerm.ok) { actions.toast({ tone: 'warning', title: '이슈 등록 권한이 없습니다', body: incidentPerm.reason }); return null; }
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

  const settingSplit = splitSettingInputs(settingChangeInputs(official, draft, state.role), state.changes);
  const submitSettings = () => {
    if (!requestPerm.ok) { denyRequest(false); return 0; }
    const { fresh, duplicate } = settingSplit;
    if (!fresh.length) {
      actions.toast({ tone: 'warning', title: '이미 승인 요청한 기준입니다', body: `${duplicate.map((d) => d.target.replace('AD Pilot 기준 · ', '')).join(' · ')} — MILDO Flow에서 승인 · 반려 후 다시 요청하세요`, route: 'flow' });
      return 0;
    }
    fresh.forEach((i) => actions.addChange(i));
    actions.toast({
      tone: 'info', title: `기준 변경 승인 요청 ${fresh.length}건`,
      body: `반영되면 공식 기준이 바뀝니다 (MILDO Flow)${duplicate.length ? ` · 이미 열린 요청 ${duplicate.length}건은 제외` : ''}`, route: 'flow',
    });
    return fresh.length;
  };

  return {
    state, data, actions, cfg, official, draft, setDraft, dirty, baseProposals, proposals, downInfo, bids, kwStatus, diag, guards, paces, gfa, changes, saDailyBudget,
    changeOf, statusOf, requestable, request, requestInput, approve, reject, apply, retry, cancel, rollback, rollbackAll, rollbackPlan, notify, bulkCheck, submitSettings, settingSplit,
    actor, server, roleLabel: actorLabel(actor), requestPerm, incidentPerm,
    canApprove: (c: ChangeRequest) => canApprove(actor, c.approver),
    canOperate: (c: ChangeRequest) => canOperate(actor, c),
    /** 단계별 권한 (반영 · 재실행 · 실행 취소 · 롤백) */
    perm: (c: Pick<ChangeRequest, 'approver'>, action: ChangeAction) => changePermission(actor, c, action),
    canRollback: (c: ChangeRequest) => canRollback(state.changes, c),
    linkedIncident: (p: AdPilotProposal) => matchingIncident(p, state.incidents, data),
  };
}

export type AdPilotCtx = ReturnType<typeof useAdPilot>;
