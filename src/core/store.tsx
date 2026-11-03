/**
 * 앱 전역 상태 — 모듈 간 연결 지점.
 *  - changes  : MILDO Flow의 '요청 · 승인 · 반영 이력' (AD Pilot · GFA Control · Lab · Alert 기준 변경 모두 여기에 쌓인다)
 *  - incidents: MILDO Alert 이슈 (감지 → 배정 → 조치 → 보고)
 *  - toasts   : 화면 알림 (메신저 알림 미러)
 *  - notes    : 리포트 AE 코멘트 · 코멘트 단위 피드백
 * localStorage 저장은 편의 기능일 뿐 (artifact 환경에서는 실패할 수 있음).
 *
 * 서버 모드(MILDO OS Cloud, src/saas): 서버가 원본이다. 로그인 후 Dataset · 변경 요청 · 이슈 · 코멘트를 API에서 읽고,
 * 액션은 API로 보낸 뒤 결과로 갱신(낙관적 갱신 → 실패 시 되돌림), SSE 이벤트로 다른 사용자 변경을 반영한다(useServerSync).
 * 데모 모드(아티팩트 · 정적 호스팅) 동작은 그대로다.
 */
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { AiSettings, ChangeRequest, Dataset, Incident, Toast } from './types';
import { DEMO } from '@/data/demo';
import { nowIso, uid } from './util';
import { useSaas } from '@/saas/context';
import { useServerSync, type ServerSyncHandle } from '@/saas/useServerSync';
import { BootScreen } from '@/saas/Splash';

export interface Comment {
  id: string;
  target: string;
  /** 표시 역할 ('담당 AE' · 'PM' · '수면밀도') — 데모 모드에서는 작성 시 역할, 서버 모드에서는 작성자 멤버십 역할의 표시 역할 */
  author: string;
  text: string;
  at: string;
  resolved?: boolean;
  /** 서버 모드: 실제 작성자 이름 · 사용자 id */
  authorName?: string;
  authorUser?: string;
}

export interface TfMember { id: string; name: string; years: string; allocation: string }

export interface AppState {
  data: Dataset;
  changes: ChangeRequest[];
  incidents: Incident[];
  toasts: Toast[];
  comments: Comment[];
  ai: AiSettings;
  /** 현재 사용자 역할 (승인 권한 시연용) */
  role: '담당 AE' | 'PM' | '수면밀도';
  /** 주말 · 공휴일 당번 모드 강제 표시 */
  offHoursMode: boolean;
  tf: Record<string, TfMember>;
  demo: { running: boolean; startedAt: number | null; pausedAt: number | null; elapsedBeforePause: number };
  /** '시연 상태 초기화' 횟수 — 셸이 열려 있는 화면을 다시 마운트해 화면 내부 상태(필터 · 입력 · AI 해석)도 초기화한다. 저장하지 않는다. */
  resetSeq?: number;
}

export type Action =
  | { type: 'change/add'; change: ChangeRequest }
  | { type: 'change/update'; id: string; patch: Partial<ChangeRequest>; log?: { by: string; action: string; note?: string } }
  | { type: 'incident/add'; incident: Incident }
  | { type: 'incident/update'; id: string; patch: Partial<Incident>; log?: { by: string; action: string } }
  | { type: 'toast/push'; toast: Toast }
  | { type: 'toast/dismiss'; id: string }
  | { type: 'comment/add'; comment: Comment }
  | { type: 'comment/resolve'; id: string }
  | { type: 'ai/set'; patch: Partial<AiSettings> }
  | { type: 'role/set'; role: AppState['role'] }
  | { type: 'offhours/set'; on: boolean }
  | { type: 'tf/set'; id: string; patch: Partial<TfMember> }
  | { type: 'demo/start' }
  | { type: 'demo/pause' }
  | { type: 'demo/resume' }
  | { type: 'demo/stop' }
  | { type: 'demo/seek'; seconds: number }
  | { type: 'reset' }
  // 서버 모드 동기화 (src/saas): 서버가 원본인 항목을 통째로 · 건별로 반영
  | { type: 'data/set'; data: Dataset }
  | { type: 'changes/set'; changes: ChangeRequest[] }
  | { type: 'change/upsert'; change: ChangeRequest }
  | { type: 'incidents/set'; incidents: Incident[] }
  | { type: 'incident/upsert'; incident: Incident }
  | { type: 'comments/set'; comments: Comment[] }
  | { type: 'comment/upsert'; comment: Comment }
  // 서버 모드 낙관적 갱신 되돌리기 · TF 입력 불러오기
  | { type: 'change/remove'; id: string }
  | { type: 'incident/remove'; id: string }
  | { type: 'comment/remove'; id: string }
  | { type: 'tf/replace'; tf: Record<string, TfMember> };

const STORAGE_KEY = 'mildo-os/v1';
/** 서버 모드 AI 설정 저장 키 (데모 저장본 'mildo-os/v1'과 섞지 않는다 — 서버 데이터는 브라우저에 남기지 않음) */
const CLOUD_AI_KEY = 'mildo-os/cloud/ai';

/**
 * 앱 전역 '시연 상태 초기화' 알림 — 스토어 밖에 따로 저장하는 모듈 기록(Lab · Watch · GEO · Ops 로컬 입력 등)은
 * window의 이 이벤트를 받아 처음 상태로 돌린다. 설정의 '정말 초기화'가 스토어 reset 직후 보낸다.
 */
export const RESET_EVENT = 'mildo-os:reset';
export function broadcastReset(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(RESET_EVENT));
  } catch {
    /* 이벤트를 보낼 수 없는 환경 — 스토어 초기화만 */
  }
}

const ROLES: readonly AppState['role'][] = ['담당 AE', 'PM', '수면밀도'];
const AI_MODES: readonly AiSettings['mode'][] = ['auto', 'artifact', 'anthropic', 'server', 'offline'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';

/**
 * 저장본 검증 — 이전 버전 · 손상된 저장본(형식이 다른 JSON)이 있어도 화면이 깨지지 않게
 * 형식이 맞는 항목만 되살린다. 맞지 않는 필드는 기본값으로 둔다.
 */
export function sanitizeSaved(saved: unknown): Partial<Pick<AppState, 'changes' | 'incidents' | 'comments' | 'ai' | 'role' | 'tf'>> {
  if (!isObj(saved)) return {};
  const out: Partial<Pick<AppState, 'changes' | 'incidents' | 'comments' | 'ai' | 'role' | 'tf'>> = {};
  if (Array.isArray(saved.changes)) {
    out.changes = saved.changes.filter((c): c is ChangeRequest => isObj(c) && str(c.id) && str(c.status) && str(c.target) && str(c.approver) && Array.isArray(c.history));
  }
  if (Array.isArray(saved.incidents)) {
    out.incidents = saved.incidents.filter((i): i is Incident => isObj(i) && str(i.id) && str(i.status) && str(i.severity) && str(i.title) && Array.isArray(i.timeline) && Array.isArray(i.causeCandidates) && isObj(i.impact));
  }
  if (Array.isArray(saved.comments)) {
    out.comments = saved.comments.filter((c): c is Comment => isObj(c) && str(c.id) && str(c.target) && str(c.text));
  }
  if (isObj(saved.ai)) {
    const a = saved.ai;
    const ai: Partial<AiSettings> = {};
    if (AI_MODES.includes(a.mode as AiSettings['mode'])) ai.mode = a.mode as AiSettings['mode'];
    if (str(a.apiKey)) ai.apiKey = a.apiKey as string;
    if (str(a.model) && a.model) ai.model = a.model as string;
    out.ai = ai as AiSettings;
  }
  if (ROLES.includes(saved.role as AppState['role'])) out.role = saved.role as AppState['role'];
  if (isObj(saved.tf)) {
    out.tf = Object.fromEntries(Object.entries(saved.tf).filter(([, m]) => isObj(m))) as Record<string, TfMember>;
  }
  return out;
}

function initialState(): AppState {
  const base: AppState = {
    data: DEMO,
    changes: [],
    incidents: [],
    toasts: [],
    comments: [],
    ai: { mode: 'auto', apiKey: '', model: 'claude-opus-5-5' },
    role: 'PM',
    offHoursMode: false,
    tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = sanitizeSaved(JSON.parse(raw));
      return {
        ...base,
        changes: saved.changes ?? [],
        incidents: saved.incidents ?? [],
        comments: saved.comments ?? [],
        ai: { ...base.ai, ...(saved.ai ?? {}) },
        role: saved.role ?? base.role,
        tf: saved.tf ?? {},
      };
    }
  } catch {
    /* localStorage 없음 — 기본값 사용 */
  }
  return base;
}

/** 서버 모드 시작 상태: 승인 이력 · 이슈 · 코멘트는 서버에서 불러온다 (브라우저 저장본을 쓰지 않는다) */
function serverInitialState(): AppState {
  const base: AppState = {
    data: DEMO,
    changes: [],
    incidents: [],
    toasts: [],
    comments: [],
    ai: { mode: 'auto', apiKey: '', model: 'claude-opus-5-5' },
    role: 'PM',
    offHoursMode: false,
    tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
  try {
    const raw = localStorage.getItem(CLOUD_AI_KEY);
    if (raw) {
      const saved = sanitizeSaved({ ai: JSON.parse(raw) });
      return { ...base, ai: { ...base.ai, ...(saved.ai ?? {}) } };
    }
  } catch {
    /* 저장소 없음 */
  }
  return base;
}

function initFor(mode: 'demo' | 'server'): AppState {
  return mode === 'server' ? serverInitialState() : initialState();
}

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'change/add':
      return { ...s, changes: [a.change, ...s.changes] };
    case 'change/update':
      return {
        ...s,
        changes: s.changes.map((c) =>
          c.id === a.id
            ? { ...c, ...a.patch, history: a.log ? [...c.history, { at: nowIso(), ...a.log }] : c.history }
            : c,
        ),
      };
    case 'incident/add':
      if (s.incidents.some((i) => i.id === a.incident.id)) return s;
      return { ...s, incidents: [a.incident, ...s.incidents] };
    case 'incident/update':
      return {
        ...s,
        incidents: s.incidents.map((i) =>
          i.id === a.id
            ? { ...i, ...a.patch, timeline: a.log ? [...i.timeline, { at: nowIso(), ...a.log }] : i.timeline }
            : i,
        ),
      };
    case 'toast/push':
      return { ...s, toasts: [...s.toasts.slice(-3), a.toast] };
    case 'toast/dismiss':
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case 'comment/add':
      return { ...s, comments: [...s.comments, a.comment] };
    case 'comment/resolve':
      return { ...s, comments: s.comments.map((c) => (c.id === a.id ? { ...c, resolved: true } : c)) };
    case 'ai/set':
      return { ...s, ai: { ...s.ai, ...a.patch } };
    case 'role/set':
      return { ...s, role: a.role };
    case 'offhours/set':
      return { ...s, offHoursMode: a.on };
    case 'tf/set':
      return { ...s, tf: { ...s.tf, [a.id]: { ...{ id: a.id, name: '', years: '', allocation: '' }, ...s.tf[a.id], ...a.patch } } };
    case 'demo/start':
      return { ...s, demo: { running: true, startedAt: Date.now(), pausedAt: null, elapsedBeforePause: 0 } };
    case 'demo/pause':
      if (!s.demo.running || s.demo.pausedAt) return s;
      return { ...s, demo: { ...s.demo, pausedAt: Date.now() } };
    case 'demo/resume': {
      if (!s.demo.pausedAt || !s.demo.startedAt) return s;
      const pausedFor = Date.now() - s.demo.pausedAt;
      return { ...s, demo: { ...s.demo, startedAt: s.demo.startedAt + pausedFor, pausedAt: null } };
    }
    case 'demo/seek':
      return { ...s, demo: { running: true, startedAt: Date.now() - a.seconds * 1000, pausedAt: s.demo.pausedAt ? Date.now() : null, elapsedBeforePause: 0 } };
    case 'demo/stop':
      return { ...s, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 } };
    case 'reset':
      return { ...initialState(), changes: [], incidents: [], comments: [], tf: {}, resetSeq: (s.resetSeq ?? 0) + 1 };
    case 'data/set':
      return { ...s, data: a.data };
    case 'changes/set':
      return { ...s, changes: a.changes };
    case 'change/upsert':
      return s.changes.some((c) => c.id === a.change.id)
        ? { ...s, changes: s.changes.map((c) => (c.id === a.change.id ? a.change : c)) }
        : { ...s, changes: [a.change, ...s.changes] };
    case 'incidents/set':
      return { ...s, incidents: a.incidents };
    case 'incident/upsert':
      return s.incidents.some((i) => i.id === a.incident.id)
        ? { ...s, incidents: s.incidents.map((i) => (i.id === a.incident.id ? a.incident : i)) }
        : { ...s, incidents: [a.incident, ...s.incidents] };
    case 'comments/set':
      return { ...s, comments: a.comments };
    case 'comment/upsert':
      return s.comments.some((c) => c.id === a.comment.id)
        ? { ...s, comments: s.comments.map((c) => (c.id === a.comment.id ? a.comment : c)) }
        : { ...s, comments: [...s.comments, a.comment] };
    case 'change/remove':
      return { ...s, changes: s.changes.filter((c) => c.id !== a.id) };
    case 'incident/remove':
      return { ...s, incidents: s.incidents.filter((i) => i.id !== a.id) };
    case 'comment/remove':
      return { ...s, comments: s.comments.filter((c) => c.id !== a.id) };
    case 'tf/replace':
      return { ...s, tf: a.tf };
    default:
      return s;
  }
}

interface StoreCtx {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** 서버 모드 동기화 (데모 모드 null) — 다시 불러오기 · 연결 상태 */
  sync: ServerSyncHandle | null;
}
const Ctx = createContext<StoreCtx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const saas = useSaas();
  const serverWs = saas.mode === 'server' && saas.me && saas.workspace ? saas.workspace : null;
  // 모드는 마운트 시점에 고정 (셸이 워크스페이스 id를 key로 다시 마운트한다)
  const [state, rawDispatch] = useReducer(reducer, serverWs ? 'server' : 'demo', initFor);
  const sync = useServerSync(
    serverWs
      ? {
          ws: serverWs.id,
          demoRole: saas.detail?.demoRole ?? serverWs.demoRole,
          canWrite: saas.can('comment'),
          reloadWorkspace: saas.reloadDetail,
          refreshMe: saas.refreshMe,
        }
      : null,
    state,
    rawDispatch,
    reducer,
  );
  useEffect(() => {
    try {
      if (serverWs) {
        localStorage.setItem(CLOUD_AI_KEY, JSON.stringify(state.ai));
        return;
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ changes: state.changes, incidents: state.incidents, comments: state.comments, ai: state.ai, role: state.role, tf: state.tf }),
      );
    } catch {
      /* 저장 불가 환경 — 무시 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.changes, state.incidents, state.comments, state.ai, state.role, state.tf]);
  const dispatch = sync?.dispatch ?? rawDispatch;
  const value = useMemo(() => ({ state, dispatch, sync }), [state, dispatch, sync]);
  if (serverWs && sync && !sync.ready) return <BootScreen step={sync.bootStep} />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider 밖에서 useStore 사용');
  return v;
}

/** StoreProvider 밖에서도 쓰는 공용 부품용 (없으면 null) */
export function useStoreOptional(): StoreCtx | null {
  return useContext(Ctx);
}

/** 자주 쓰는 액션 헬퍼 */
export function useActions() {
  const { state, dispatch } = useStore();
  return {
    toast(t: Omit<Toast, 'id'>) {
      dispatch({ type: 'toast/push', toast: { id: uid('t'), ...t } });
    },
    addChange(c: Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'> & { status?: ChangeRequest['status'] }) {
      const change: ChangeRequest = {
        id: uid('chg'),
        createdAt: nowIso(),
        status: c.status ?? 'pending',
        history: [{ at: nowIso(), by: c.requestedBy, action: '요청 생성', note: c.reason }],
        ...c,
      };
      dispatch({ type: 'change/add', change });
      return change;
    },
    updateChange(id: string, patch: Partial<ChangeRequest>, action: string, note?: string) {
      dispatch({ type: 'change/update', id, patch, log: { by: state.role, action, note } });
    },
    addIncident(i: Incident) {
      dispatch({ type: 'incident/add', incident: i });
    },
    updateIncident(id: string, patch: Partial<Incident>, action: string) {
      dispatch({ type: 'incident/update', id, patch, log: { by: state.role, action } });
    },
  };
}
