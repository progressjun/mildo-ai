/**
 * MILDO Watch 파이프라인 진행 기록 저장소 (React 없음).
 * 모듈 단위 상태라 화면을 오가도 유지되고, MILDO Agent 도구도 같은 기록을 읽는다.
 * localStorage 저장은 편의 기능일 뿐이다 (아티팩트 환경에서는 실패할 수 있음 — 실패해도 동작).
 * Lab 테스트 등록 여부는 이 저장소가 아니라 state.changes(ChangeRequest kind 'test')에서 판정한다.
 */
import type { ProgressMap } from './engine';

const KEY = 'mildo-os/watch/v1';

export interface WatchStore {
  progress: ProgressMap;
  /** 이 화면에서 MILDO Alert로 보낸 이슈 id */
  alerts: string[];
  /** 주간 인사이트 브리프 담당 AE 코멘트 (키 = 브리프 기간 시작일) */
  aeNotes: Record<string, { text: string; by: string; at: string }>;
}

let current: WatchStore | null = null;
const listeners = new Set<() => void>();

function load(): WatchStore {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const s = JSON.parse(raw) as Partial<WatchStore>;
      return {
        progress: s.progress && typeof s.progress === 'object' ? s.progress : {},
        alerts: Array.isArray(s.alerts) ? s.alerts : [],
        aeNotes: s.aeNotes && typeof s.aeNotes === 'object' ? s.aeNotes : {},
      };
    }
  } catch {
    /* 저장소 없음 — 기본값 */
  }
  return { progress: {}, alerts: [], aeNotes: {} };
}

function save(s: WatchStore) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 저장 불가 환경 — 무시 */
  }
}

export function getWatchStore(): WatchStore {
  if (!current) current = load();
  return current;
}

export function setWatchStore(updater: (s: WatchStore) => WatchStore) {
  const next = updater(getWatchStore());
  if (next === current) return;
  current = next;
  save(next);
  listeners.forEach((l) => l());
}

export function subscribeWatchStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 시연 초기화 — 시드 단계로 되돌린다 */
export function resetWatchStore() {
  setWatchStore(() => ({ progress: {}, alerts: [], aeNotes: {} }));
}

/** 앱 전역 '시연 상태 초기화'가 'mildo-os:reset' 이벤트를 보내면 Watch 진행 기록도 처음 상태로 (화면이 열려 있지 않아도) */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('mildo-os:reset', () => resetWatchStore());
