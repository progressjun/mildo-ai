/**
 * SaaS 세션 컨텍스트 — 서버 모드에서 로그인 사용자 · 현재 워크스페이스 · 역할 · 권한을 제공한다.
 * 데모 모드에서는 mode='demo'만 채우고 나머지는 비어 있다(관리 화면은 이때 예시 · 안내를 보여 준다).
 *
 * platform 도메인이 로그인 화면 · 워크스페이스 전환 · store 서버 동기화를 이 위에 완성한다.
 * 다른 화면은 useSaas()만 쓴다:  const { mode, workspace, can } = useSaas();  api(wsPath(workspace.id, '/...'))
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { detectMode, type AppMode } from './mode';
import { api, ApiError } from './api';
import { can as canRole, type Permission, type Role } from '@/core/permissions';

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
}

export interface SaasValue {
  mode: AppMode | 'checking';
  /** 서버 모드인데 로그인 전이면 null */
  me: Me | null;
  workspace: WorkspaceSummary | null;
  role: Role | null;
  can: (perm: Permission) => boolean;
  switchWorkspace: (id: string) => void;
  refreshMe: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const WS_KEY = 'mildo-os/cloud/workspace';
const Ctx = createContext<SaasValue | null>(null);

export function SaasProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode | 'checking'>('checking');
  const [me, setMe] = useState<Me | null>(null);
  const [wsId, setWsId] = useState<string | null>(() => {
    try { return localStorage.getItem(WS_KEY); } catch { return null; }
  });

  const refreshMe = useCallback(async () => {
    try {
      const m = await api<Me>('/api/auth/me');
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
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

  const workspace = useMemo(() => {
    if (!me?.workspaces.length) return null;
    return me.workspaces.find((w) => w.id === wsId) ?? me.workspaces[0];
  }, [me, wsId]);

  const value = useMemo<SaasValue>(() => ({
    mode,
    me,
    workspace,
    role: workspace?.role ?? null,
    can: (perm) => (workspace ? canRole(workspace.role, perm) : false),
    switchWorkspace: (id) => {
      setWsId(id);
      try { localStorage.setItem(WS_KEY, id); } catch { /* 저장 불가 */ }
    },
    refreshMe,
    logout: async () => {
      await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => null);
      setMe(null);
    },
  }), [mode, me, workspace, refreshMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Provider 밖(단위 테스트 · 데모 단독 렌더)에서는 데모 모드 값을 돌려준다 */
const DEMO_VALUE: SaasValue = {
  mode: 'demo', me: null, workspace: null, role: null, can: () => false,
  switchWorkspace: () => undefined, refreshMe: async () => null, logout: async () => undefined,
};
export function useSaas(): SaasValue {
  return useContext(Ctx) ?? DEMO_VALUE;
}
