/**
 * 서버 모드 스토어 동기화 훅 (StoreProvider 전용). 데모 모드(cfg null)에서는 아무것도 하지 않고 null을 돌려준다.
 *
 * 시작 순서 (모듈 화면이 마운트되기 전에 끝낸다 — StoreProvider가 ready 전까지 셸 대신 시작 화면을 보여 준다)
 *   모듈 로컬 입력(GET /state) → localStorage에 쓰기 · 미러 설치 → 역할 고정(workspace.demoRole)
 *   → Dataset · 변경 요청 · 이슈 · 코멘트 동시 로드 → SSE 연결 → ready
 * 이후: SSE 이벤트마다 해당 목록을 300ms 디바운스로 다시 불러오고, 재연결 시 전부 다시 불러온다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action, AppState, TfMember } from '@/core/store';
import type { Toast } from '@/core/types';
import { uid } from '@/core/util';
import { api, ApiError, onApiError, wsPath } from './api';
import { createServerBridge, createServerDispatch, type ServerBridge } from './bridge';
import { createRefetchScheduler, emitServerEvent, ServerEvents, setConnInfo, setReconnectHandler } from './events';
import { installStorageMirror, type StorageMirror } from './storageSync';
import { apiErrorMessage, configFingerprint, isGlobalToastError, RECONNECT_TARGETS, refetchTargetForEvent, TF_STATE_KEY, type RefetchTarget } from './sync';

export interface ServerSyncConfig {
  ws: string;
  demoRole: AppState['role'];
  /** 쓰기(comment 권한) 가능 여부 — 열람자는 모듈 로컬 입력을 서버로 보내지 않는다 */
  canWrite: boolean;
  /** 워크스페이스 설정 변경(config 이벤트) → GET /api/w/:ws 다시 (결과: { workspace: { config } }) */
  reloadWorkspace?: () => Promise<unknown>;
  /** 멤버십 변경(member 이벤트) → /auth/me 다시 */
  refreshMe?: () => Promise<unknown>;
  /** 세션 확인 (/auth/me — 401이면 세션 만료 안내와 함께 로그인 화면으로). 실시간 연결이 계속 끊길 때 · 재연결 때 쓴다 */
  checkSession?: () => Promise<unknown>;
  /** 지금 적용 중인 워크스페이스 설정 — 다시 읽은 설정과 같으면(자기 저장 · 재연결) 안내하지 않는다 */
  config?: Record<string, unknown> | null;
  /** 워크스페이스 설정의 주말 · 공휴일 당번 체계 강제 (config.offHoursMode === true) — MILDO Alert 화면의 당번 체계를 서버 스캔과 맞춘다 */
  offHoursMode?: boolean;
  /** 워크스페이스 상세를 (다시) 불러올 때마다 바뀌는 값 (상세 객체) — 그때마다 offHoursMode를 다시 맞춘다 */
  detailStamp?: unknown;
}

export interface ServerSyncHandle {
  ready: boolean;
  /** 시작 화면에 보여 줄 단계 */
  bootStep: string;
  dispatch: (a: Action) => void;
  bridge: ServerBridge;
  /** 화면 새로고침: 서버 데이터 전부 다시 불러오기 */
  reloadAll: () => Promise<void>;
}

type Reducer = (s: AppState, a: Action) => AppState;

function isTfMap(v: unknown): v is Record<string, TfMember> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((m) => !!m && typeof m === 'object');
}

export function useServerSync(cfg: ServerSyncConfig | null, state: AppState, rawDispatch: (a: Action) => void, reducer: Reducer): ServerSyncHandle | null {
  const ws = cfg?.ws ?? null;
  const stateRef = useRef(state);
  stateRef.current = state;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const roleRef = useRef<AppState['role']>(cfg?.demoRole ?? 'PM');
  const [ready, setReady] = useState(!ws);
  const [bootStep, setBootStep] = useState('워크스페이스 데이터를 불러오는 중');
  const mirrorRef = useRef<StorageMirror | null>(null);
  const tfHydrated = useRef<string | null>(null);
  const loadStateRef = useRef<() => Promise<void>>(async () => undefined);
  const reloadAllRef = useRef<() => Promise<void>>(async () => undefined);

  // 리듀서를 바로 적용한 그림자 상태 — 같은 틱 안의 연속 액션(낙관적 갱신 → 되돌림)이 최신 상태를 읽게
  const tracked = useMemo(() => (a: Action) => {
    stateRef.current = reducer(stateRef.current, a);
    rawDispatch(a);
  }, [rawDispatch, reducer]);
  const toast = useMemo(() => (t: Omit<Toast, 'id'>) => tracked({ type: 'toast/push', toast: { id: uid('t'), ...t } }), [tracked]);

  const bridge = useMemo(() => (ws ? createServerBridge({ ws, api, dispatch: tracked, getState: () => stateRef.current, toast }) : null), [ws, tracked, toast]);

  const dispatch = useMemo(() => {
    if (!bridge) return null;
    let roleNoticeShown = false;
    return createServerDispatch(tracked, bridge, {
      serverRole: () => roleRef.current,
      onDrop: (a) => {
        if (a.type === 'role/set' && !roleNoticeShown) {
          roleNoticeShown = true;
          toast({ tone: 'info', title: `역할은 멤버십 기준(${roleRef.current})으로 고정됩니다`, body: '서버 모드에서는 로그인한 계정의 역할로 권한을 판정합니다. 역할 변경은 팀 · 권한 화면에서 관리자가 합니다.' });
        }
        if (a.type === 'reset') void reloadAllRef.current();
      },
    });
  }, [bridge, tracked, toast]);

  // 워크스페이스 설정의 당번 체계 강제(offHoursMode) → 스토어 (상세를 불러오거나 다시 불러올 때마다 — config 이벤트 포함)
  useEffect(() => {
    if (!cfg) return;
    const on = cfg.offHoursMode === true;
    if (stateRef.current.offHoursMode !== on) tracked({ type: 'offhours/set', on });
  }, [cfg?.offHoursMode, cfg?.detailStamp, tracked]); // eslint-disable-line react-hooks/exhaustive-deps

  // 역할 변경(멤버십 갱신) 반영
  useEffect(() => {
    if (!cfg) return;
    roleRef.current = cfg.demoRole;
    if (stateRef.current.role !== cfg.demoRole) tracked({ type: 'role/set', role: cfg.demoRole });
  }, [cfg?.demoRole, tracked]); // eslint-disable-line react-hooks/exhaustive-deps

  // 시작 · SSE · 미러
  useEffect(() => {
    if (!ws || !bridge) return;
    let alive = true;
    const statePath = wsPath(ws, '/state');

    const putState = async (key: string, value: unknown | null) => {
      await api(`${statePath}/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: { value }, silent: true });
    };

    const applyTf = (st: Record<string, unknown>) => {
      const tf = st[TF_STATE_KEY];
      if (isTfMap(tf)) {
        const j = JSON.stringify(tf);
        if (JSON.stringify(stateRef.current.tf) !== j) {
          tfHydrated.current = j;
          tracked({ type: 'tf/replace', tf });
        }
      }
    };

    const loadState = async () => {
      const r = await api<{ state: Record<string, unknown> }>(statePath, { silent: true });
      const st = r?.state && typeof r.state === 'object' ? r.state : {};
      mirrorRef.current?.applyServerState(st);
      applyTf(st);
    };
    loadStateRef.current = () => loadState().catch(() => undefined);

    let storageErrShown = false;
    let blockedShown = false;
    const runTarget = async (target: RefetchTarget) => {
      if (!alive) return;
      if (target === 'state') return loadStateRef.current();
      if (target === 'workspace') {
        const d = await cfgRef.current?.reloadWorkspace?.().catch(() => undefined);
        const next = (d as { workspace?: { config?: unknown } } | null | undefined)?.workspace;
        if (!alive || !next) return;
        // 응답이 왔을 때 화면이 이미 같은 설정이면(이 사용자의 저장 직후 · 재연결 확인) 안내하지 않는다
        if (configFingerprint(next.config ?? null) === configFingerprint(cfgRef.current?.config ?? null)) return;
        toast({ tone: 'info', title: '워크스페이스 설정이 바뀌었습니다', body: '목표 · 예산 · SAFETY 기준을 새 설정으로 계산합니다. 일부 화면은 새로고침 후 반영됩니다.' });
        return;
      }
      if (target === 'me') {
        const c = cfgRef.current;
        await (c?.checkSession ?? c?.refreshMe)?.().catch(() => undefined);
        return;
      }
      await bridge.load(target);
    };
    const scheduler = createRefetchScheduler<RefetchTarget>(runTarget, 300);

    const events = new ServerEvents({
      url: wsPath(ws, '/events'),
      onEvent: (e) => {
        emitServerEvent(e);
        const t = refetchTargetForEvent(e);
        if (t) scheduler.schedule(t);
      },
      onStatus: (status, info) => setConnInfo({ status, attempt: info.attempt, retryInMs: info.retryInMs, lastEventAt: events.lastEventAt }),
      onReconnected: () => RECONNECT_TARGETS.forEach((t) => scheduler.schedule(t)),
      onError: (attempt) => {
        // 연결이 계속 끊기면 세션이 끝났는지 확인 — /auth/me는 전역 401 처리를 타지 않으므로 세션 확인 함수로 (401이면 로그인 화면 + 안내)
        if (attempt === 2 || attempt % 5 === 0) {
          const check = cfgRef.current?.checkSession;
          void (check ? check() : api('/api/auth/me', { silent: true })).catch(() => undefined);
        }
      },
    });

    reloadAllRef.current = async () => {
      await Promise.all([bridge.load('dataset'), bridge.load('changes'), bridge.load('incidents'), bridge.load('comments'), loadStateRef.current()]);
    };

    (async () => {
      // 모듈 로컬 입력: 미러를 먼저 설치하고(진행 중 쓰기도 잡게) 서버 값으로 맞춘다
      setBootStep('화면 입력값(모듈 로컬 저장)을 불러오는 중');
      if (typeof localStorage !== 'undefined') {
        try {
          mirrorRef.current = installStorageMirror({
            storage: localStorage,
            put: putState,
            canWrite: () => !!cfgRef.current?.canWrite,
            onBlocked: () => {
              if (blockedShown) return;
              blockedShown = true;
              toast({ tone: 'info', title: '열람자 권한 — 화면 입력은 서버에 저장되지 않습니다', body: '이 브라우저에서만 잠시 보이고, 다시 불러오면 워크스페이스 값으로 돌아갑니다.' });
            },
            onError: (_key, e) => {
              if (storageErrShown) return;
              storageErrShown = true;
              toast({ tone: 'warning', title: '화면 입력값을 서버에 저장하지 못했습니다', body: `${apiErrorMessage(e)} · 이 브라우저에는 남아 있습니다.` });
            },
          });
        } catch {
          mirrorRef.current = null;
        }
      }
      try {
        await loadState();
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) toast({ tone: 'warning', title: '화면 입력값(모듈 로컬 저장)을 불러오지 못했습니다', body: apiErrorMessage(e) });
      }
      if (!alive) return;
      tracked({ type: 'role/set', role: roleRef.current });
      setBootStep('성과 데이터 · 변경 요청 · 이슈 · 코멘트를 불러오는 중');
      await Promise.all([bridge.load('dataset'), bridge.load('changes'), bridge.load('incidents'), bridge.load('comments')]);
      if (!alive) return;
      setConnInfo({ status: 'connecting', attempt: 0, lastEventAt: null });
      events.start();
      setReconnectHandler(() => events.reconnectNow());
      setReady(true);
    })();

    const onUnload = () => { void mirrorRef.current?.flush(); };
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onUnload);

    return () => {
      alive = false;
      scheduler.cancelAll();
      events.stop();
      setReconnectHandler(null);
      setConnInfo({ status: 'off', attempt: 0, lastEventAt: null });
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onUnload);
      const m = mirrorRef.current;
      mirrorRef.current = null;
      if (m) void m.flush().finally(() => m.uninstall());
    };
  }, [ws, bridge, tracked, toast]);

  // 화면이 직접 처리하지 않는 API 오류(네트워크 · 서버 오류 · 요청 과다 · 보안 토큰) → 전역 토스트 (같은 문구는 5초에 한 번)
  useEffect(() => {
    if (!ws) return;
    const last = new Map<string, number>();
    return onApiError(({ error, silent }) => {
      if (silent || !isGlobalToastError(error)) return;
      const msg = apiErrorMessage(error);
      const now = Date.now();
      if ((last.get(msg) ?? 0) > now - 5000) return;
      last.set(msg, now);
      toast({ tone: error.status === 0 || error.status >= 500 ? 'critical' : 'warning', title: error.status === 0 ? '서버 연결 끊김' : '요청을 처리하지 못했습니다', body: msg });
    });
  }, [ws, toast]);

  // TF 입력(state.tf) → 서버 가상 키 'store:tf' (1초 디바운스)
  useEffect(() => {
    if (!ws || !ready) return;
    const j = JSON.stringify(state.tf);
    if (tfHydrated.current === j) return;
    if (tfHydrated.current === null && j === '{}') { tfHydrated.current = j; return; }
    if (!cfgRef.current?.canWrite) return;
    const h = setTimeout(() => {
      tfHydrated.current = j;
      void api(`${wsPath(ws, '/state')}/${encodeURIComponent(TF_STATE_KEY)}`, { method: 'PUT', body: { value: state.tf }, silent: true })
        .catch((e) => toast({ tone: 'warning', title: 'TF 입력을 서버에 저장하지 못했습니다', body: apiErrorMessage(e) }));
    }, 1000);
    return () => clearTimeout(h);
  }, [ws, ready, state.tf, toast]);

  return useMemo(() => (ws && bridge && dispatch
    ? { ready, bootStep, dispatch, bridge, reloadAll: () => reloadAllRef.current() }
    : null), [ws, bridge, dispatch, ready, bootStep]);
}
