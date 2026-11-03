/**
 * SaaS 세션 컨텍스트 — 서버 모드에서 로그인 사용자 · 현재 워크스페이스 · 역할 · 권한 · 워크스페이스 설정을 제공한다.
 * 데모 모드에서는 mode='demo'만 채우고 나머지는 비어 있다(관리 화면은 이때 예시 · 안내를 보여 준다).
 *
 * 다른 화면은 useSaas()만 쓴다:  const { mode, workspace, can } = useSaas();  api(wsPath(workspace.id, '/...'))
 *
 * platform 도메인이 하는 일:
 *  - 로그인 · 로그아웃(대기 중인 저장을 보낸 뒤 이 브라우저의 동기화 키를 지운다) · 세션 만료(어느 API든 401 → 로그인 화면)
 *  - 워크스페이스 정보(GET /api/w/:ws) → applyWorkspaceConfig(config) · configureServerAi({ workspaceId }), 로그아웃 · 세션 만료 → configureServerAi({ workspaceId: null })
 *  - 워크스페이스 전환 (사용자가 둘 이상에 속할 때)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { detectMode, quickMode, type AppMode } from './mode';
import { api, ApiError, onApiError, setCsrfToken } from './api';
import { can as canRole, type Permission, type Role } from '@/core/permissions';
import { applyWorkspaceConfig } from '@/data/config';
import { apiErrorMessage, AUTH_ENTRY_RE } from './sync';
import { clearSyncedStorage, flushStorageSync } from './storageSync';
import { hardReload, isShellLoaded } from './runtime';

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  brand_name: string;
  status: string;
  role: Role;
  permissions: Permission[];
  demoRole: '담당 AE' | 'PM' | '수면밀도';
}

export interface Me {
  user: { id: string; email: string; name: string };
  workspaces: WorkspaceSummary[];
  csrfToken?: string;
}

/** GET /api/w/:ws */
export interface WorkspaceDetail {
  workspace: { id: string; slug: string; name: string; brand_name: string; status: string; timezone?: string; plan?: string; config: Record<string, unknown> };
  role: Role;
  permissions: Permission[];
  demoRole: '담당 AE' | 'PM' | '수면밀도';
}

export interface SaasValue {
  mode: AppMode | 'checking';
  /** 서버 모드인데 로그인 전이면 null */
  me: Me | null;
  workspace: WorkspaceSummary | null;
  role: Role | null;
  can: (perm: Permission) => boolean;
  switchWorkspace: (id: string) => void;
  /** /auth/me 다시 — sessionCheck: 로그인 중이었는데 401이면 '세션 만료' 안내와 함께 로그인 화면으로 (실시간 연결이 끊겼을 때 확인용) */
  refreshMe: (opts?: { sessionCheck?: boolean }) => Promise<Me | null>;
  logout: () => Promise<void>;
  /** 현재 워크스페이스 상세 (config 포함) — 불러오기 전 null */
  detail: WorkspaceDetail | null;
  /** 워크스페이스 설정 (settings 도메인 스키마) */
  config: Record<string, unknown> | null;
  /** 워크스페이스 정보를 불러오지 못한 사유 */
  detailError: string | null;
  reloadDetail: () => Promise<WorkspaceDetail | null>;
  /** 이메일 · 비밀번호 로그인 — 실패하면 ApiError를 던진다 */
  login: (email: string, password: string) => Promise<Me | null>;
  /** 로그인 화면 안내 (세션 만료 · 비밀번호 변경 완료 등) */
  notice: string | null;
  setNotice: (n: string | null) => void;
}

const WS_KEY = 'mildo-os/cloud/workspace';
/** 선택한 워크스페이스 (이 브라우저) — 초대 수락 직후 그 워크스페이스로 들어갈 때도 쓴다 */
export const WORKSPACE_STORAGE_KEY = WS_KEY;
/** 서버 모드 AI 설정 저장본 (src/core/store CLOUD_AI_KEY) — 개인 Anthropic API 키가 들어 있을 수 있다 */
const CLOUD_AI_KEY = 'mildo-os/cloud/ai';
/** 이 브라우저에 마지막으로 로그인한 사용자 id — 다른 사용자가 로그인하면 이전 사용자의 개인 AI 키를 지운다 */
const CLOUD_USER_KEY = 'mildo-os/cloud/user';
const Ctx = createContext<SaasValue | null>(null);

/**
 * 이 브라우저의 개인 설정을 로그인한 사용자 기준으로 맞춘다. 로그아웃(userId null)이나 다른 사용자의 로그인이면
 * 서버 모드 AI 설정 저장본(개인 Anthropic API 키 포함)을 지운다 — 공용 PC에서 다음 사용자가 이전 사용자의 키로 호출하지 않게.
 */
export function claimBrowserFor(userId: string | null, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  if (!storage) return;
  try {
    const prev = storage.getItem(CLOUD_USER_KEY);
    if (userId === null || (prev !== null && prev !== userId)) storage.removeItem(CLOUD_AI_KEY);
    if (userId === null) storage.removeItem(CLOUD_USER_KEY);
    else if (prev !== userId) storage.setItem(CLOUD_USER_KEY, userId);
  } catch {
    /* 저장소 접근 불가 */
  }
}

/**
 * AI 서버 백엔드 연결 (ai 도메인 src/ai/claude.ts configureServerAi) — 워크스페이스가 정해지거나 바뀌면 그 id, 로그아웃 · 세션 만료면 null.
 * ai 도메인 구현 시점에 의존하지 않게 typeof로 확인한다.
 */
let aiConfigured = false;
export async function configureAi(workspaceId: string | null): Promise<void> {
  // 연결한 적이 없으면 해제할 것도 없다 (로그인 전 화면에서 AI 계층을 불러오지 않는다)
  if (workspaceId === null && !aiConfigured) return;
  aiConfigured = workspaceId !== null;
  try {
    const mod = (await import('@/ai/claude')) as unknown as { configureServerAi?: (o: { workspaceId: string | null }) => void };
    if (typeof mod.configureServerAi === 'function') mod.configureServerAi({ workspaceId });
  } catch {
    /* AI 계층이 없거나 아직 서버 백엔드를 지원하지 않음 — 규칙 엔진으로 동작 */
  }
}

export function SaasProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode | 'checking'>(() => quickMode() ?? 'checking');
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [wsId, setWsId] = useState<string | null>(() => {
    try { return localStorage.getItem(WS_KEY); } catch { return null; }
  });
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  const refreshMe = useCallback(async (opts: { sessionCheck?: boolean } = {}) => {
    try {
      const m = await api<Me>('/api/auth/me', { silent: true });
      if (m?.csrfToken) setCsrfToken(m.csrfToken);
      if (m?.user?.id) claimBrowserFor(m.user.id);
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // /auth/me는 로그인 전 경로라 전역 401 처리(세션 만료 안내)를 타지 않는다 — 확인 요청이면 여기서 안내한다
        if (opts.sessionCheck && meRef.current) {
          setDetail(null);
          setNotice('세션이 만료되었거나 다른 곳에서 로그아웃되었습니다. 다시 로그인해 주세요.');
        }
        setMe(null);
        void configureAi(null);
        return null;
      }
      throw e;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    detectMode().then(async (m) => {
      if (!alive) return;
      if (m === 'server') await refreshMe().catch(() => null);
      if (alive) setMode(m);
    });
    return () => { alive = false; };
  }, [refreshMe]);

  // 어느 API든 401(세션 만료 · 강제 종료) → 로그인 화면
  useEffect(() => onApiError(({ error, path }) => {
    if (error.status !== 401 || AUTH_ENTRY_RE.test(path.split('?')[0]) || !meRef.current) return;
    setMe(null);
    setDetail(null);
    void configureAi(null);
    setNotice('세션이 만료되었거나 다른 곳에서 로그아웃되었습니다. 다시 로그인해 주세요.');
  }), []);

  const workspace = useMemo(() => {
    if (!me?.workspaces?.length) return null;
    return me.workspaces.find((w) => w.id === wsId) ?? me.workspaces[0];
  }, [me, wsId]);
  const workspaceRef = useRef<WorkspaceSummary | null>(null);
  workspaceRef.current = workspace;

  const reloadDetail = useCallback(async (): Promise<WorkspaceDetail | null> => {
    const ws = workspaceRef.current;
    if (!ws) return null;
    try {
      const d = await api<WorkspaceDetail>(`/api/w/${ws.id}`, { silent: true });
      if (workspaceRef.current?.id !== ws.id) return null;
      try {
        applyWorkspaceConfig((d?.workspace?.config ?? null) as Record<string, unknown> | null);
      } catch (e) {
        console.warn('[MILDO OS] 워크스페이스 설정 적용 실패 — 기본값으로 계산합니다', e);
      }
      await configureAi(ws.id);
      setDetail(d);
      setDetailError(null);
      return d;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // 멤버십이 없어졌다 — 목록을 다시 받아 다른 워크스페이스로
        try { localStorage.removeItem(WS_KEY); } catch { /* 무시 */ }
        void configureAi(null);
        setWsId(null);
        await refreshMe().catch(() => null);
        return null;
      }
      if (!(e instanceof ApiError && e.status === 401)) setDetailError(apiErrorMessage(e));
      return null;
    }
  }, [refreshMe]);

  useEffect(() => {
    if (mode !== 'server' || !workspace) {
      setDetail(null);
      return;
    }
    if (detail?.workspace?.id === workspace.id) return;
    setDetail(null);
    setDetailError(null);
    void reloadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, workspace?.id, reloadDetail]);

  // 멤버십 역할이 바뀌면(member 이벤트 → refreshMe) 상세의 역할도 맞춘다
  useEffect(() => {
    if (!detail || !workspace || detail.workspace.id !== workspace.id) return;
    if (detail.role !== workspace.role) setDetail({ ...detail, role: workspace.role, permissions: workspace.permissions, demoRole: workspace.demoRole });
  }, [workspace, detail]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ ok: boolean; csrfToken?: string }>('/api/auth/login', { method: 'POST', body: { email, password }, silent: true });
    if (r?.csrfToken) setCsrfToken(r.csrfToken);
    setNotice(null);
    // 이전 사용자의 화면 상태가 메모리에 남아 있으면 새로 읽는다
    if (isShellLoaded()) {
      hardReload();
      return null;
    }
    return refreshMe();
  }, [refreshMe]);

  const value = useMemo<SaasValue>(() => ({
    mode,
    me,
    workspace,
    role: workspace?.role ?? null,
    can: (perm) => {
      if (!workspace) return false;
      if (detail?.workspace?.id === workspace.id && Array.isArray(detail.permissions)) return detail.permissions.includes(perm);
      return canRole(workspace.role, perm);
    },
    switchWorkspace: (id) => {
      if (id === workspace?.id) return;
      try { localStorage.setItem(WS_KEY, id); } catch { /* 저장 불가 */ }
      if (isShellLoaded()) {
        // 지금 워크스페이스의 입력을 보낸 뒤 새로 읽는다 (모듈 메모리 상태가 섞이지 않게)
        void flushStorageSync().finally(() => {
          clearSyncedStorage();
          hardReload();
        });
        return;
      }
      setWsId(id);
    },
    refreshMe,
    logout: async () => {
      await flushStorageSync();
      await api('/api/auth/logout', { method: 'POST', body: {}, silent: true }).catch(() => null);
      clearSyncedStorage();
      claimBrowserFor(null);
      await configureAi(null);
      setCsrfToken(null);
      setMe(null);
      setDetail(null);
      if (isShellLoaded()) hardReload();
    },
    detail,
    config: detail?.workspace?.config ?? null,
    detailError,
    reloadDetail,
    login,
    notice,
    setNotice,
  }), [mode, me, workspace, refreshMe, detail, detailError, reloadDetail, login, notice]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Provider 밖(단위 테스트 · 데모 단독 렌더)에서는 데모 모드 값을 돌려준다 */
const DEMO_VALUE: SaasValue = {
  mode: 'demo', me: null, workspace: null, role: null, can: () => false,
  switchWorkspace: () => undefined, refreshMe: async () => null, logout: async () => undefined,
  detail: null, config: null, detailError: null, reloadDetail: async () => null, login: async () => null,
  notice: null, setNotice: () => undefined,
};
export function useSaas(): SaasValue {
  return useContext(Ctx) ?? DEMO_VALUE;
}

/** 테스트 · 미리보기용: 값을 직접 주입하는 Provider */
export function SaasTestProvider({ value, children }: { value: Partial<SaasValue>; children: ReactNode }) {
  return <Ctx.Provider value={{ ...DEMO_VALUE, ...value }}>{children}</Ctx.Provider>;
}
