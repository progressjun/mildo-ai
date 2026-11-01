/**
 * MILDO Lab 로컬 상태 — 판정 기준값 · 사용자 테스트 카드 · 판정 결정 · 랩업 기록 · 이긴 패턴 · AI 결과.
 * 전역 스토어(src/core/store.tsx)를 바꾸지 않기 위해 모듈 안에서만 쓰는 작은 외부 스토어다.
 * 승인 흐름이 필요한 변경은 모두 전역 ChangeRequest(state.changes)로 남기고, 여기에는 화면 보조 상태만 둔다.
 * localStorage 저장은 편의 기능 (아티팩트 · 테스트 환경에서는 실패해도 무시).
 */
import { useSyncExternalStore } from 'react';
import type { AdCopy, Candidate, CardDecision, LabCriteria, Pattern, TestCard, Wrapup } from './engine';
import { resolveCriteria } from './engine';
import { LAB_DEFAULT_CRITERIA } from './data';

export interface LabLocal {
  criteria: LabCriteria;
  userCards: TestCard[];
  decisions: Record<string, CardDecision>;
  wrapups: Record<string, Wrapup>;
  library: Pattern[];
  aiCandidates: Candidate[];
  aiCopies: AdCopy[];
}

const KEY = 'mildo-os/lab/v1';

export function initialLab(): LabLocal {
  return { criteria: { ...LAB_DEFAULT_CRITERIA }, userCards: [], decisions: {}, wrapups: {}, library: [], aiCandidates: [], aiCopies: [] };
}

function load(): LabLocal {
  const base = initialLab();
  try {
    if (typeof localStorage === 'undefined') return base;
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<LabLocal>;
    return {
      criteria: resolveCriteria(s.criteria),
      userCards: Array.isArray(s.userCards) ? s.userCards : [],
      decisions: s.decisions && typeof s.decisions === 'object' ? s.decisions : {},
      wrapups: s.wrapups && typeof s.wrapups === 'object' ? s.wrapups : {},
      library: Array.isArray(s.library) ? s.library : [],
      aiCandidates: Array.isArray(s.aiCandidates) ? s.aiCandidates : [],
      aiCopies: Array.isArray(s.aiCopies) ? s.aiCopies : [],
    };
  } catch {
    return base;
  }
}

let current: LabLocal = load();
const subs = new Set<() => void>();

export function getLab(): LabLocal {
  return current;
}

export function setLab(patch: Partial<LabLocal> | ((s: LabLocal) => Partial<LabLocal>)) {
  const p = typeof patch === 'function' ? patch(current) : patch;
  current = { ...current, ...p };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* 저장 불가 환경 — 무시 */
  }
  subs.forEach((f) => f());
}

export function resetLab() {
  setLab(initialLab());
}

/** 앱 전역 '시연 상태 초기화'가 'mildo-os:reset' 이벤트를 보내면 Lab 로컬 기록도 처음 상태로 (화면이 열려 있지 않아도) */
export const LAB_RESET_EVENT = 'mildo-os:reset';
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener(LAB_RESET_EVENT, () => resetLab());

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function useLab(): LabLocal {
  return useSyncExternalStore(subscribe, getLab, getLab);
}
