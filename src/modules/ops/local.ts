/**
 * ops 모듈 로컬 입력값 (레퍼런스 빈칸 · 수수료 · 계약 · Kick-off · 백업 재지정 · 제출 체크) 보관.
 * 전역 스토어에는 TF 성명 · 연차 · 투입률(state.tf)만 있으므로, 나머지 제출 전 입력값은 이 모듈이 localStorage에 둔다.
 * localStorage가 없는 환경(테스트 · 일부 아티팩트)에서는 기본값으로 동작한다. React 없음 — 에이전트 도구도 같은 값을 읽는다.
 */
import { RFP } from '@/data/constants';
import type { ContractInput, FeeInput, RefInputs } from './engine';
import { DEFAULT_KICKOFF } from './data';

export interface OpsLocal {
  kickoff: string;
  refs: RefInputs;
  fees: Record<string, FeeInput>;
  annualBudget: number;
  contract: ContractInput;
  /** 역할 id → 백업 역할 id ('' = 미지정) — 제안서 지정값과 다를 때만 저장 */
  backupOverrides: Record<string, string>;
  /** 제출 서류 체크 · GEO 사례 수치 입력 확인 */
  docs: Record<string, boolean>;
}

export const OPS_STORAGE_KEY = 'mildo-os/ops-v1';

export function defaultOpsLocal(): OpsLocal {
  return { kickoff: DEFAULT_KICKOFF, refs: {}, fees: {}, annualBudget: RFP.annualBudget, contract: {}, backupOverrides: {}, docs: {} };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function mergeOpsLocal(raw: unknown): OpsLocal {
  const base = defaultOpsLocal();
  if (!isObj(raw)) return base;
  return {
    kickoff: typeof raw.kickoff === 'string' && raw.kickoff ? raw.kickoff : base.kickoff,
    refs: isObj(raw.refs) ? (raw.refs as RefInputs) : base.refs,
    fees: isObj(raw.fees) ? (raw.fees as Record<string, FeeInput>) : base.fees,
    annualBudget: typeof raw.annualBudget === 'number' && Number.isFinite(raw.annualBudget) && raw.annualBudget > 0 ? raw.annualBudget : base.annualBudget,
    contract: isObj(raw.contract) ? (raw.contract as ContractInput) : base.contract,
    backupOverrides: isObj(raw.backupOverrides) ? (raw.backupOverrides as Record<string, string>) : base.backupOverrides,
    docs: isObj(raw.docs) ? (raw.docs as Record<string, boolean>) : base.docs,
  };
}

export function loadOpsLocal(): OpsLocal {
  try {
    if (typeof localStorage === 'undefined') return defaultOpsLocal();
    const raw = localStorage.getItem(OPS_STORAGE_KEY);
    return raw ? mergeOpsLocal(JSON.parse(raw)) : defaultOpsLocal();
  } catch {
    return defaultOpsLocal();
  }
}

export function saveOpsLocal(v: OpsLocal): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(OPS_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* 저장 불가 환경 — 화면 상태만 유지 */
  }
}
