import { useCallback, useMemo } from 'react';
import type { Incident } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { activeConfig, detectIncidents, msToKstIso, regimeOf, roleIdByLabel, type AlertIncident } from './engine';
import { dataNowMs, toDataMs, useDataClock } from './clock';
import { DEMO_CREATIVES } from './data';

/** MILDO Alert 화면 공용 컨텍스트 */
export function useAlert(tickMs = 15000) {
  const { state, dispatch } = useStore();
  const actions = useActions();
  const data = state.data;
  const nowMs = useDataClock(data.generatedAt, tickMs);
  const toMs = useCallback((iso: string) => toDataMs(iso, data.generatedAt), [data.generatedAt]);
  const cfg = useMemo(() => activeConfig(state.changes), [state.changes]);
  const incidents = state.incidents as AlertIncident[];
  const regime = regimeOf(data.today, state.offHoursMode);
  const nameOf = useCallback((label?: string) => {
    if (!label) return '—';
    const id = roleIdByLabel(label);
    const name = id ? state.tf[id]?.name?.trim() : '';
    return name ? `${name} · ${label}` : label;
  }, [state.tf]);
  const tfNames = useMemo(() => Object.fromEntries(Object.entries(state.tf).filter(([, v]) => v.name?.trim()).map(([k, v]) => [k, v.name.trim()])), [state.tf]);
  const clockIso = useCallback(() => msToKstIso(dataNowMs(data.generatedAt)), [data.generatedAt]);

  /** 이슈 단계 처리 — 스토어 타임라인 + 데이터 시계 기준 SLA 기록 */
  const act = useCallback((inc: AlertIncident, patch: Partial<AlertIncident>, action: string) => {
    actions.updateIncident(inc.id, patch as Partial<Incident>, action);
  }, [actions]);

  /** 현재 기준으로 재스캔 → 새 이슈만 적재 */
  const rescan = useCallback(() => {
    const found = detectIncidents(data, { config: cfg, creatives: DEMO_CREATIVES, offHours: state.offHoursMode });
    const fresh = found.filter((f) => !state.incidents.some((i) => i.id === f.id));
    fresh.forEach((i) => actions.addIncident(i));
    actions.toast({ tone: fresh.length ? 'warning' : 'good', title: `재스캔 완료 · 신규 ${fresh.length}건`, body: `탐지 ${found.length}건 중 기존 ${found.length - fresh.length}건은 처리 이력 유지`, route: 'alert' });
    return fresh.length;
  }, [actions, cfg, data, state.incidents, state.offHoursMode]);

  return { state, dispatch, actions, data, nowMs, toMs, cfg, incidents, regime, nameOf, tfNames, clockIso, act, rescan };
}
export type AlertCtx = ReturnType<typeof useAlert>;

/** 역할별 승인 권한 (Flow 규칙과 동일: AE는 AE건, PM은 AE · PM건, 수면밀도는 전부) */
export function canApprove(role: string, approver: 'AE' | 'PM' | 'CLIENT'): boolean {
  if (role === '수면밀도') return true;
  if (role === 'PM') return approver === 'AE' || approver === 'PM';
  return approver === 'AE';
}
