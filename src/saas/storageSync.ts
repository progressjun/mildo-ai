/**
 * 모듈 로컬 저장 동기화 (서버 모드 전용) — 각 모듈이 localStorage 'mildo-os/*' 키에 두는 입력(Lab 기준값 · Watch 진행 ·
 * TF · GEO 진단 등)을 워크스페이스 서버 저장소(workspace_state)에 미러링한다. 모듈 코드는 바꾸지 않는다:
 * localStorage.setItem/removeItem을 감싸서 해당 키 쓰기를 가로채고, 키마다 1초 디바운스로 PUT /api/w/:ws/state/:key를 보낸다.
 * 'mildo-os/v1'(전역 스토어 저장본)과 'mildo-os/cloud/*'(세션 설정)는 제외한다 (sync.ts isSyncedStorageKey).
 */
import { decodeStorageValue, encodeStorageValue, isSyncedStorageKey, planStorageLoad } from './sync';

export interface MirrorDeps {
  storage: Storage;
  /** 서버 저장 — value null이면 삭제 */
  put: (key: string, value: unknown | null) => Promise<void>;
  debounceMs?: number;
  /** 저장 실패 (재시도 후에도) */
  onError?: (key: string, e: unknown) => void;
  /** 쓰기 권한이 없으면 서버로 보내지 않는다 (열람자) */
  canWrite?: () => boolean;
  /** 권한이 없어 보내지 않은 쓰기 */
  onBlocked?: (key: string) => void;
  /** 재시도 간격 (기본 5초) · 최대 횟수 (기본 3) */
  retryMs?: number;
  maxRetries?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface StorageMirror {
  /** 원래 메서드로 되돌린다 (보내지 않은 쓰기는 버리지 않고 flush 후 해제하려면 flush 먼저) */
  uninstall(): void;
  /** 대기 중인 쓰기를 지금 보낸다 */
  flush(): Promise<void>;
  /** 아직 서버로 보내지 않은 키 */
  pendingKeys(): Set<string>;
  /** 미러를 거치지 않고 로컬에만 쓴다 (서버 값 반영용) — raw null이면 삭제 */
  writeLocal(key: string, raw: string | null): void;
  /** 서버 state 전체로 로컬을 맞춘다 (보내지 않은 로컬 입력은 유지) — 바뀐 키 목록 */
  applyServerState(state: Record<string, unknown>): string[];
}

let active: StorageMirror | null = null;

/** 동기화 대상 로컬 키 → 값 */
export function readSyncedLocal(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && isSyncedStorageKey(k)) {
        const v = storage.getItem(k);
        if (v !== null) out[k] = v;
      }
    }
  } catch {
    /* 저장소 접근 불가 */
  }
  return out;
}

export function installStorageMirror(d: MirrorDeps): StorageMirror {
  active?.uninstall();
  const storage = d.storage;
  const debounce = d.debounceMs ?? 1000;
  const retryMs = d.retryMs ?? 5000;
  const maxRetries = d.maxRetries ?? 3;
  const setT = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = d.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  // 실제 Storage 인스턴스면 프로토타입을 감싸고(브라우저에서 localStorage.setItem = fn 대입은 항목 저장으로 해석될 수 있다), 아니면 객체 자체를 감싼다
  const isRealStorage = typeof Storage !== 'undefined' && storage instanceof Storage;
  const target = (isRealStorage ? Storage.prototype : storage) as Storage;
  const origSet = target.setItem;
  const origRemove = target.removeItem;
  const timers = new Map<string, unknown>();
  const retries = new Map<string, number>();
  let installed = true;

  const send = async (key: string): Promise<void> => {
    timers.delete(key);
    if (d.canWrite && !d.canWrite()) {
      d.onBlocked?.(key);
      return;
    }
    let raw: string | null = null;
    try { raw = storage.getItem(key); } catch { raw = null; }
    try {
      await d.put(key, raw === null ? null : encodeStorageValue(raw));
      retries.delete(key);
    } catch (e) {
      const n = (retries.get(key) ?? 0) + 1;
      retries.set(key, n);
      if (n <= maxRetries && installed) {
        timers.set(key, setT(() => { void send(key); }, retryMs * n));
      } else {
        retries.delete(key);
        d.onError?.(key, e);
      }
    }
  };
  const schedule = (key: string) => {
    if (!installed) return;
    const prev = timers.get(key);
    if (prev !== undefined) clearT(prev);
    retries.delete(key);
    timers.set(key, setT(() => { void send(key); }, debounce));
  };

  target.setItem = function setItem(this: Storage, key: string, value: string) {
    origSet.call(this, key, value);
    if (this === storage && isSyncedStorageKey(key)) schedule(key);
  };
  target.removeItem = function removeItem(this: Storage, key: string) {
    origRemove.call(this, key);
    if (this === storage && isSyncedStorageKey(key)) schedule(key);
  };

  const mirror: StorageMirror = {
    uninstall() {
      if (!installed) return;
      installed = false;
      timers.forEach((h) => clearT(h));
      timers.clear();
      target.setItem = origSet;
      target.removeItem = origRemove;
      if (active === mirror) active = null;
    },
    async flush() {
      const keys = [...timers.keys()];
      keys.forEach((k) => clearT(timers.get(k)));
      await Promise.all(keys.map((k) => send(k)));
    },
    pendingKeys: () => new Set(timers.keys()),
    writeLocal(key, raw) {
      try {
        if (raw === null) origRemove.call(storage, key);
        else origSet.call(storage, key, raw);
      } catch {
        /* 저장 불가 (용량 초과 등) — 화면은 기본값으로 */
      }
    },
    applyServerState(state) {
      const plan = planStorageLoad(state, readSyncedLocal(storage), mirror.pendingKeys());
      plan.writes.forEach(([k, raw]) => mirror.writeLocal(k, raw));
      plan.removes.forEach((k) => mirror.writeLocal(k, null));
      return [...plan.writes.map(([k]) => k), ...plan.removes];
    },
  };
  active = mirror;
  return mirror;
}

/** 지금 설치된 미러 (로그아웃 · 워크스페이스 전환 전에 flush) */
export function activeMirror(): StorageMirror | null {
  return active;
}

/** 대기 중인 쓰기를 보낸다 — 미러가 없으면 아무것도 하지 않는다 */
export async function flushStorageSync(): Promise<void> {
  await active?.flush().catch(() => undefined);
}

/** 로그아웃 시: 이 브라우저에 남은 동기화 키를 지운다 (공용 PC · 다른 사용자에게 남지 않게 — 원본은 서버에 있다) */
export function clearSyncedStorage(storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  if (!storage) return;
  const keys = Object.keys(readSyncedLocal(storage));
  for (const k of keys) {
    try {
      if (active) active.writeLocal(k, null);
      else storage.removeItem(k);
    } catch {
      /* 무시 */
    }
  }
}

export { decodeStorageValue, encodeStorageValue };
