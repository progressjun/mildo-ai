import { useCallback, useMemo } from 'react';
import type { Incident, Toast } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { useSaas } from '@/saas/context';
import { api, wsPath } from '@/saas/api';
import { apiErrorMessage } from '@/saas/sync';
import { activeConfig, detectIncidents, msToKstIso, regimeOf, roleIdByLabel, withAppliedTopups, type AlertIncident } from './engine';
import { dataNowMs, toDataMs, useDataClock } from './clock';
import { DEMO_CREATIVES } from './data';

/** 서버 재스캔 응답 (POST /api/w/:ws/alerts/scan) */
export interface ServerScanResult { found: number; created: number; cleared?: number; notified?: number; warning?: string | null }

/**
 * 서버 모드 재스캔 — 서버 24시간 감지(alerts.scan)를 즉시 한 번 돌린다. 새 이슈는 incident 이벤트로 화면에 들어온다.
 * 화면에서 직접 탐지하지 않는다: 화면의 소재 목록은 시연용 예시(DEMO_CREATIVES)라, 실연동 워크스페이스에 예시 소재 이슈를 올리게 된다.
 */
export async function serverRescan(ws: string, toast: (t: Omit<Toast, 'id'>) => void, call: typeof api = api): Promise<number> {
  try {
    const r = await call<ServerScanResult>(wsPath(ws, '/alerts/scan'), { method: 'POST', body: {}, silent: true });
    const found = Number(r?.found) || 0;
    const created = Number(r?.created) || 0;
    toast({
      tone: created ? 'warning' : 'good', title: `서버 재스캔 완료 · 신규 ${created}건`,
      body: `서버 탐지 ${found}건 중 기존 ${Math.max(0, found - created)}건은 처리 이력 유지${r?.warning ? ` · ${r.warning}` : ''}`, route: 'alert',
    });
    return created;
  } catch (e) {
    toast({ tone: 'critical', title: '서버 재스캔을 실행하지 못했습니다', body: apiErrorMessage(e) });
    return 0;
  }
}

/** MILDO Alert 화면 공용 컨텍스트 */
export function useAlert(tickMs = 15000) {
  const { state, dispatch } = useStore();
  const actions = useActions();
  const saas = useSaas();
  const serverWs = saas.mode === 'server' ? saas.workspace?.id ?? null : null;
  // 계정 잔액은 MILDO Flow에서 반영된 충전 요청을 더한 값 (AD Pilot · Flow 잔액 계산과 같은 기준)
  const data = useMemo(() => withAppliedTopups(state.data, state.changes), [state.data, state.changes]);
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

  /** 현재 기준으로 재스캔 → 새 이슈만 적재 (서버 모드: 서버 감지를 실행 — 결과 이슈는 서버가 저장하고 이벤트로 들어온다) */
  const rescan = useCallback(() => {
    if (serverWs) {
      void serverRescan(serverWs, actions.toast);
      return 0;
    }
    const found = detectIncidents(data, { config: cfg, creatives: DEMO_CREATIVES, offHours: state.offHoursMode });
    const fresh = found.filter((f) => !state.incidents.some((i) => i.id === f.id));
    fresh.forEach((i) => actions.addIncident(i));
    actions.toast({ tone: fresh.length ? 'warning' : 'good', title: `재스캔 완료 · 신규 ${fresh.length}건`, body: `탐지 ${found.length}건 중 기존 ${found.length - fresh.length}건은 처리 이력 유지`, route: 'alert' });
    return fresh.length;
  }, [actions, cfg, data, serverWs, state.incidents, state.offHoursMode]);

  return { state, dispatch, actions, data, nowMs, toMs, cfg, incidents, regime, nameOf, tfNames, clockIso, act, rescan };
}
export type AlertCtx = ReturnType<typeof useAlert>;

/** 역할별 승인 권한 (Flow 규칙과 동일: AE는 AE건, PM은 AE · PM건, 수면밀도는 전부) */
export function canApprove(role: string, approver: 'AE' | 'PM' | 'CLIENT'): boolean {
  if (role === '수면밀도') return true;
  if (role === 'PM') return approver === 'AE' || approver === 'PM';
  return approver === 'AE';
}
