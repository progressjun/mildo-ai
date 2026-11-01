/**
 * MILDO Flow 화면 상태 · 액션 — 승인 흐름은 모두 state.changes(ChangeRequest)에 기록한다.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeRequest, Incident } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { makeClock } from './clock';
import {
  ACTION_META, bulkGuard, canAct, canRollback, checkAllPromotions, executionCheck, flowSummary, fmtValue, incidentStagePatch, nextStatus,
  opsCases, seedChanges, type ChangeInput, type FlowAction,
} from './engine';

/** 시연용 이력은 세션당 한 번만 적재 (초기화 후에는 버튼으로 다시 불러오기) */
let seededThisSession = false;

export function useFlow() {
  const { state, dispatch } = useStore();
  const actions = useActions();
  const data = state.data;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clock = useMemo(() => makeClock(data.generatedAt), [data.generatedAt, tick]);

  const seeds = useMemo(() => seedChanges(data), [data]);
  const missingSeeds = seeds.filter((s) => !state.changes.some((c) => c.id === s.id));
  const loadSeeds = useCallback(() => {
    const missing = seeds.filter((s) => !state.changes.some((c) => c.id === s.id));
    // change/add는 앞에 쌓이므로 오래된 것부터 넣는다
    [...missing].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((change) => dispatch({ type: 'change/add', change }));
    return missing.length;
  }, [dispatch, seeds, state.changes]);
  useEffect(() => {
    if (seededThisSession) return;
    seededThisSession = true;
    loadSeeds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changes = state.changes;
  const incidents = state.incidents;
  const summary = useMemo(() => flowSummary(changes, state.role, clock.nowMs, clock.toMs, data.today), [changes, state.role, clock, data.today]);
  const checks = useMemo(() => checkAllPromotions(data, { changes, incidents }), [data, changes, incidents]);
  const cases = useMemo(() => opsCases(data, incidents, changes, clock.toMs), [data, incidents, changes, clock]);

  /** 단건 액션 (권한 · 실행 점검 · 이력) */
  const act = useCallback((c: ChangeRequest, action: FlowAction, note = '', opts: { silent?: boolean; bulk?: boolean } = {}): boolean => {
    const perm = canAct(state.role, c.approver);
    const meta = ACTION_META[action];
    const say = (t: Parameters<typeof actions.toast>[0]) => { if (!opts.silent) actions.toast(t); };
    if (!perm.ok) { say({ tone: 'warning', title: `${meta.label} 권한이 없습니다`, body: perm.reason }); return false; }
    if (meta.needsNote && !note.trim()) { say({ tone: 'warning', title: `${meta.label} 사유를 입력하세요`, body: '누가 · 언제 · 왜를 이력에 남깁니다 (p.31)' }); return false; }
    if (action === 'apply') {
      const ex = executionCheck(data, changes, incidents, c);
      if (!ex.ok) {
        actions.updateChange(c.id, { status: 'held' }, '실행 보류', ex.blocks.join(' · '));
        say({ tone: 'warning', title: '실행 점검에서 보류했습니다', body: ex.blocks[0], route: 'flow' });
        return false;
      }
      actions.updateChange(c.id, { status: 'applied' }, opts.bulk ? '일괄 반영' : '반영', [...ex.passes, ...ex.warnings].join(' · '));
      say({ tone: 'good', title: '반영했습니다', body: `${c.target}: ${fmtValue(c, c.before)} → ${fmtValue(c, c.after)} · 롤백 가능` });
      return true;
    }
    if (action === 'rollback') {
      const r = canRollback(changes, c);
      if (!r.ok) { say({ tone: 'warning', title: '롤백할 수 없습니다', body: r.reason }); return false; }
      actions.updateChange(c.id, { status: 'rolled_back' }, '롤백', `직전 상태로 복원: ${fmtValue(c, c.after)} → ${fmtValue(c, c.before)}${note ? ` · ${note}` : ''}`);
      say({ tone: 'info', title: '롤백했습니다', body: `${c.target}: ${fmtValue(c, c.before)}로 복원` });
      return true;
    }
    const allowedFrom: Record<FlowAction, ChangeRequest['status'][]> = {
      approve: ['pending'], reject: ['pending', 'held'], hold: ['pending', 'approved'], resume: ['held'], cancel: ['approved'], apply: ['approved'], rollback: ['applied'],
    };
    if (!allowedFrom[action].includes(c.status)) { say({ tone: 'warning', title: `${meta.label}할 수 없는 상태입니다`, body: c.status }); return false; }
    const label = action === 'approve' && opts.bulk ? '일괄 승인' : meta.label;
    actions.updateChange(c.id, { status: nextStatus(c, action) }, label, note.trim() || perm.reason);
    say({ tone: action === 'approve' ? 'good' : 'info', title: `${label}: ${c.target}`, body: action === 'approve' ? '반영 대기로 이동했습니다' : undefined });
    return true;
  }, [actions, changes, data, incidents, state.role]);

  const bulk = useCallback((list: ChangeRequest[], action: 'approve' | 'apply') => {
    const g = bulkGuard(list, action);
    if (!g.ok) { actions.toast({ tone: 'warning', title: '일괄 처리 차단', body: g.reasons.join(' · ') }); return 0; }
    let ok = 0;
    for (const c of list) if (act(c, action, '', { silent: true, bulk: true })) ok++;
    actions.toast({ tone: ok === list.length ? 'good' : 'warning', title: `일괄 ${action === 'approve' ? '승인' : '반영'} ${ok}/${list.length}건`, body: ok < list.length ? '나머지는 권한 · 실행 점검으로 보류되었습니다' : g.reasons.join(' · ') });
    return ok;
  }, [act, actions]);

  const createRequest = useCallback((input: ChangeInput, silent = false) => {
    const c = actions.addChange({ ...input, requestedBy: state.role });
    if (!silent) actions.toast({ tone: 'info', title: '승인 요청을 만들었습니다', body: `${c.target} · 승인 주체 ${c.approver === 'CLIENT' ? '수면밀도' : c.approver === 'PM' ? 'PM' : '담당 AE'}`, route: 'flow' });
    return c;
  }, [actions, state.role]);

  const incidentStep = useCallback((inc: Incident, step: 'ack' | 'action' | 'report', note = '') => {
    if (step === 'action' && !note.trim()) { actions.toast({ tone: 'warning', title: '조치 내용을 입력하세요' }); return; }
    const { patch, log } = incidentStagePatch(inc, step, clock.nowIso, state.role, note.trim());
    actions.updateIncident(inc.id, patch, log);
    actions.toast({ tone: 'info', title: log, body: inc.title });
  }, [actions, clock.nowIso, state.role]);

  return { state, data, dispatch, actions, clock, seeds, missingSeeds, loadSeeds, changes, incidents, summary, checks, cases, act, bulk, createRequest, incidentStep };
}
export type FlowCtx = ReturnType<typeof useFlow>;
