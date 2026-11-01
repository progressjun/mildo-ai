/**
 * 앱 전역 상태 — 모듈 간 연결 지점.
 *  - changes  : MILDO Flow의 '요청 · 승인 · 반영 이력' (AD Pilot · GFA Control · Lab · Alert 기준 변경 모두 여기에 쌓인다)
 *  - incidents: MILDO Alert 이슈 (감지 → 배정 → 조치 → 보고)
 *  - toasts   : 화면 알림 (메신저 알림 미러)
 *  - notes    : 리포트 AE 코멘트 · 코멘트 단위 피드백
 * localStorage 저장은 편의 기능일 뿐 (artifact 환경에서는 실패할 수 있음).
 */
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { AiSettings, ChangeRequest, Dataset, Incident, Toast } from './types';
import { DEMO } from '@/data/demo';
import { nowIso, uid } from './util';

export interface Comment { id: string; target: string; author: string; text: string; at: string; resolved?: boolean }

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
  | { type: 'reset' };

const STORAGE_KEY = 'mildo-os/v1';

const ROLES: readonly AppState['role'][] = ['담당 AE', 'PM', '수면밀도'];
const AI_MODES: readonly AiSettings['mode'][] = ['auto', 'artifact', 'anthropic', 'offline'];
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

function reducer(s: AppState, a: Action): AppState {
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
      return { ...initialState(), changes: [], incidents: [], comments: [], tf: {} };
    default:
      return s;
  }
}

const Ctx = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ changes: state.changes, incidents: state.incidents, comments: state.comments, ai: state.ai, role: state.role, tf: state.tf }),
      );
    } catch {
      /* 저장 불가 환경 — 무시 */
    }
  }, [state.changes, state.incidents, state.comments, state.ai, state.role, state.tf]);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider 밖에서 useStore 사용');
  return v;
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
