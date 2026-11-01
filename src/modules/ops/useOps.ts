/** ops 화면 공용 훅 — 로컬 입력값 + 전역 TF 상태를 엮어 요약을 한 번만 계산한다. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/core/store';
import { MODULES } from '../registry';
import { defaultOpsLocal, loadOpsLocal, saveOpsLocal, type OpsLocal } from './local';
import { opsSummary, type OpsInputs } from './engine';

export function useOpsLocal() {
  const [local, setLocal] = useState<OpsLocal>(() => loadOpsLocal());
  useEffect(() => saveOpsLocal(local), [local]);
  const patch = useCallback((p: Partial<OpsLocal> | ((s: OpsLocal) => Partial<OpsLocal>)) => {
    setLocal((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));
  }, []);
  const reset = useCallback((keys?: (keyof OpsLocal)[]) => {
    const d = defaultOpsLocal();
    setLocal((s) => (keys ? { ...s, ...Object.fromEntries(keys.map((k) => [k, d[k]])) } : d));
  }, []);
  return { local, patch, reset };
}

export function moduleIds(): string[] {
  return MODULES.map((m) => m.id);
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
