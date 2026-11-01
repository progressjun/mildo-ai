/** ops 화면 공용 훅 — 로컬 입력값 + 전역 TF 상태를 엮어 요약을 한 번만 계산한다. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/core/store';
import { isStubModule, MODULES } from '../registry';
import { defaultOpsLocal, loadOpsLocal, OPS_RESET_EVENT, saveOpsLocal, type OpsLocal } from './local';
import { opsSummary, type OpsInputs } from './engine';

export function useOpsLocal() {
  const [local, setLocal] = useState<OpsLocal>(() => loadOpsLocal());
  useEffect(() => saveOpsLocal(local), [local]);
  // 전역 '시연 상태 초기화' — 열려 있는 화면의 입력값도 기본값으로 (저장본은 local.ts 리스너가 지운다)
  useEffect(() => {
    const onReset = () => setLocal(defaultOpsLocal());
    window.addEventListener(OPS_RESET_EVENT, onReset);
    return () => window.removeEventListener(OPS_RESET_EVENT, onReset);
  }, []);
  const patch = useCallback((p: Partial<OpsLocal> | ((s: OpsLocal) => Partial<OpsLocal>)) => {
    setLocal((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));
  }, []);
  const reset = useCallback((keys?: (keyof OpsLocal)[]) => {
    const d = defaultOpsLocal();
    setLocal((s) => (keys ? { ...s, ...Object.fromEntries(keys.map((k) => [k, d[k]])) } : d));
  }, []);
  return { local, patch, reset };
}

let liveIds: string[] | null = null;
/** 동작하는 모듈 id — 레지스트리 등록 모듈 중 '준비 중'(엔진 · 도구 · 브리프 없음)이 아닌 것. 레지스트리는 정적이라 1회 계산 */
export function moduleIds(): string[] {
  if (!liveIds) liveIds = MODULES.filter((m) => !isStubModule(m)).map((m) => m.id);
  return liveIds;
}
export function moduleTitle(id: string): string {
  return MODULES.find((m) => m.id === id)?.title ?? id;
}

export function useOpsModel(local: OpsLocal) {
  const { state } = useStore();
  const inputs: OpsInputs = useMemo(() => ({
    tf: state.tf, backupOverrides: local.backupOverrides, refs: local.refs, fees: local.fees, annualBudget: local.annualBudget, contract: local.contract, geoCaseDone: !!local.docs.geo_case,
  }), [state.tf, local]);
  const summary = useMemo(() => opsSummary(state.data, inputs, moduleIds(), state.changes), [state.data, inputs, state.changes]);
  return { inputs, summary };
}
export type OpsModel = ReturnType<typeof useOpsModel>;
