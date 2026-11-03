/**
 * 서버 모드 스토어 브리지 — 스토어 액션(변경 요청 · 이슈 · 코멘트)을 API로 보내고 결과로 스토어를 맞춘다.
 *  - 낙관적 갱신: 먼저 화면에 반영 → 서버 응답으로 교체(upsert) → 실패하면 되돌리고 오류 토스트
 *  - 서버가 다른 결과를 돌려주면(예: 반영 요청 → 'held' 보류, dry_run 기록) 그 결과를 그대로 쓰고 이유를 알린다
 *  - 목록 다시 불러오기(SSE 이벤트 · 재연결 · 수동 새로고침)는 응답 대기 중인 항목을 덮어쓰지 않는다(mergeWithPending)
 * React 없음 — 의존성(api · dispatch · getState · toast)을 주입해 단위 테스트한다.
 */
import type { ChangeRequest, Dataset, Incident, Toast } from '@/core/types';
import type { Action, AppState, Comment } from '@/core/store';
import { ApiError, wsPath, type ApiOptions } from './api';
import { apiErrorMessage, FLOW_SEED_PREFIX, fromServerComment, mergeWithPending, withObjectParticle, type RefetchTarget, type ServerComment } from './sync';

export type ApiFn = <T = unknown>(path: string, o?: ApiOptions) => Promise<T>;

export interface BridgeDeps {
  ws: string;
  api: ApiFn;
  /** 원래 리듀서 dispatch (가로채지 않은 것) */
  dispatch: (a: Action) => void;
  getState: () => AppState;
  toast: (t: Omit<Toast, 'id'>) => void;
}

const STATUS_KO: Record<ChangeRequest['status'], string> = {
  pending: '승인 대기', approved: '승인', applied: '반영', rejected: '반려', rolled_back: '롤백', held: '보류',
};

function isDataset(v: unknown): v is Dataset {
  const d = v as Dataset;
  return !!d && typeof d === 'object' && typeof d.today === 'string' && Array.isArray(d.dates) && Array.isArray(d.mediaDaily) && Array.isArray(d.keywords);
}

export interface ServerBridge {
  addChange(change: ChangeRequest): void;
  updateChange(id: string, patch: Partial<ChangeRequest>, log?: { by: string; action: string; note?: string }): void;
  addIncident(incident: Incident): void;
  updateIncident(id: string, patch: Partial<Incident>, log?: { by: string; action: string }): void;
  addComment(comment: Comment): void;
  resolveComment(id: string): void;
  /** 목록 · 데이터 다시 불러오기 — 성공 여부 */
  load(target: Exclude<RefetchTarget, 'state' | 'workspace' | 'me'>): Promise<boolean>;
  /** 응답을 기다리는 항목 (테스트 · 디버그용) */
  pending(): { changes: string[]; incidents: string[]; comments: string[] };
  /** 진행 중인 요청이 모두 끝날 때까지 (테스트 · 로그아웃 전) */
  settle(): Promise<void>;
}

export function createServerBridge(d: BridgeDeps): ServerBridge {
  const pend = { changes: new Map<string, number>(), incidents: new Map<string, number>(), comments: new Map<string, number>() };
  const inflight = new Set<Promise<unknown>>();
  const track = <T,>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => undefined);
    return p;
  };
  const hold = (kind: keyof typeof pend, id: string) => pend[kind].set(id, (pend[kind].get(id) ?? 0) + 1);
  const release = (kind: keyof typeof pend, id: string) => {
    const n = (pend[kind].get(id) ?? 1) - 1;
    if (n <= 0) pend[kind].delete(id);
    else pend[kind].set(id, n);
  };
  const ids = (kind: keyof typeof pend) => new Set(pend[kind].keys());
  const fail = (title: string, e: unknown) => d.toast({ tone: 'critical', title, body: apiErrorMessage(e) });
  const p = (path: string) => wsPath(d.ws, path);

  /** 서버가 요청과 다른 상태 · 실행 결과를 돌려줬을 때 알림 */
  function explainChange(expected: ChangeRequest['status'] | undefined, got: ChangeRequest) {
    const ex = got.execution;
    const executing = (got as ChangeRequest & { executing?: { phase?: string; background?: boolean } }).executing;
    if (executing) {
      // 반영 · 롤백이 응답 시간 안에 끝나지 않아 서버가 이어서 처리 (상태는 아직 승인 · 반영) — 끝나면 change 이벤트로 갱신된다
      d.toast({ tone: 'info', title: executing.phase === 'rollback' ? '롤백 반영 중' : '매체 반영 중', body: `${got.target} — 서버가 이어서 처리합니다. 끝나면 결과가 자동으로 갱신됩니다`, route: 'flow' });
      return;
    }
    if (expected && got.status !== expected) {
      const why = ex?.error ?? got.history?.[got.history.length - 1]?.note;
      d.toast({ tone: got.status === 'held' ? 'warning' : 'info', title: `서버 판정: ${STATUS_KO[got.status] ?? got.status}`, body: `${got.target} — 요청한 상태(${STATUS_KO[expected] ?? expected})와 다르게 처리했습니다${why ? ` · ${why}` : ''}`, route: 'flow' });
      return;
    }
    if (ex && got.status === 'applied') {
      if (ex.mode === 'dry_run') d.toast({ tone: 'info', title: 'dry-run으로 기록했습니다', body: `${got.target} — 매체에는 보내지 않았습니다 (커넥션 쓰기 모드가 dry_run)`, route: 'flow' });
      else if (ex.mode === 'live' && ex.ok) d.toast({ tone: 'good', title: '매체에 반영했습니다', body: `${got.target}${ex.provider ? ` · ${ex.provider}` : ''}` });
      else if (ex.mode === 'live' && !ex.ok) d.toast({ tone: 'critical', title: '매체 반영에 실패했습니다', body: `${got.target}${ex.error ? ` · ${ex.error}` : ''}`, route: 'flow' });
    }
  }

  const bridge: ServerBridge = {
    addChange(change) {
      if (change.id.startsWith(FLOW_SEED_PREFIX)) return; // 서버 모드에서는 시연 이력을 적재하지 않는다
      d.dispatch({ type: 'change/add', change });
      hold('changes', change.id);
      track(d.api<{ change: ChangeRequest }>(p('/changes'), { method: 'POST', body: { change }, silent: true }))
        .then((r) => {
          release('changes', change.id);
          if (r?.change) {
            d.dispatch({ type: 'change/upsert', change: r.change });
            explainChange(change.status, r.change);
          }
        })
        .catch((e) => {
          release('changes', change.id);
          d.dispatch({ type: 'change/remove', id: change.id });
          fail('변경 요청을 서버에 저장하지 못했습니다', e);
        });
    },

    updateChange(id, patch, log) {
      const before = d.getState().changes.find((c) => c.id === id);
      d.dispatch({ type: 'change/update', id, patch, log });
      hold('changes', id);
      track(d.api<{ change: ChangeRequest }>(p(`/changes/${encodeURIComponent(id)}`), { method: 'PATCH', body: { patch, action: log?.action ?? '수정', note: log?.note }, silent: true }))
        .then((r) => {
          release('changes', id);
          if (r?.change) {
            d.dispatch({ type: 'change/upsert', change: r.change });
            explainChange(patch.status ?? before?.status, r.change);
          }
        })
        .catch((e) => {
          release('changes', id);
          // 409: 서버가 현재 상태를 함께 돌려준다 (다른 사람이 먼저 처리 · 불가능한 전이 · 실행 중) — 되돌리지 않고 서버 값으로 맞춘다
          const current = e instanceof ApiError && e.status === 409 ? (e.body as { change?: ChangeRequest } | undefined)?.change : undefined;
          if (current && typeof current === 'object' && current.id === id) {
            d.dispatch({ type: 'change/upsert', change: current });
            if ((e as ApiError).code === 'approver_changed') {
              // 승인 시점 재판정(대량 · 위임 범위)으로 승인 주체가 올라갔다 — 서버가 올린 승인 주체를 저장했고 이 승인은 받지 않았다
              d.toast({ tone: 'warning', title: `승인 주체가 바뀌었습니다 · ${current.target}`, body: `${apiErrorMessage(e)} · 현재 ${STATUS_KO[current.status] ?? current.status} · 승인 주체 ${current.approver}`, route: 'flow' });
              return;
            }
            d.toast({ tone: 'warning', title: `${log?.action ?? '변경'}: 서버의 현재 상태로 맞췄습니다`, body: `${apiErrorMessage(e)} · 현재 ${STATUS_KO[current.status] ?? current.status}`, route: 'flow' });
            return;
          }
          if (before) d.dispatch({ type: 'change/upsert', change: before });
          fail(`${withObjectParticle(log?.action ?? '변경')} 서버에 반영하지 못해 되돌렸습니다`, e);
        });
    },

    addIncident(incident) {
      const existed = d.getState().incidents.some((i) => i.id === incident.id);
      d.dispatch({ type: 'incident/add', incident });
      if (existed) return; // 같은 id 이슈는 다시 보내지 않는다 (리듀서도 무시)
      hold('incidents', incident.id);
      track(d.api<{ incident: Incident }>(p('/incidents'), { method: 'POST', body: { incident }, silent: true }))
        .then((r) => {
          release('incidents', incident.id);
          if (r?.incident) d.dispatch({ type: 'incident/upsert', incident: r.incident });
        })
        .catch((e) => {
          release('incidents', incident.id);
          if (e instanceof ApiError && e.status === 409) {
            void bridge.load('incidents'); // 서버에 이미 있음 — 서버 값으로 맞춘다
            return;
          }
          d.dispatch({ type: 'incident/remove', id: incident.id });
          fail('이슈를 서버에 저장하지 못했습니다', e);
        });
    },

    updateIncident(id, patch, log) {
      const before = d.getState().incidents.find((i) => i.id === id);
      d.dispatch({ type: 'incident/update', id, patch, log });
      hold('incidents', id);
      track(d.api<{ incident: Incident }>(p(`/incidents/${encodeURIComponent(id)}`), { method: 'PATCH', body: { patch, action: log?.action ?? '수정' }, silent: true }))
        .then((r) => {
          release('incidents', id);
          if (r?.incident) d.dispatch({ type: 'incident/upsert', incident: r.incident });
        })
        .catch((e) => {
          release('incidents', id);
          if (before) d.dispatch({ type: 'incident/upsert', incident: before });
          fail(`이슈 ${withObjectParticle(log?.action ?? '처리')} 서버에 반영하지 못해 되돌렸습니다`, e);
        });
    },

    addComment(comment) {
      d.dispatch({ type: 'comment/add', comment });
      hold('comments', comment.id);
      track(d.api<{ comment: ServerComment }>(p('/comments'), { method: 'POST', body: { comment: { id: comment.id, target: comment.target, text: comment.text } }, silent: true }))
        .then((r) => {
          release('comments', comment.id);
          if (r?.comment) d.dispatch({ type: 'comment/upsert', comment: fromServerComment(r.comment) });
        })
        .catch((e) => {
          release('comments', comment.id);
          d.dispatch({ type: 'comment/remove', id: comment.id });
          fail('코멘트를 서버에 저장하지 못했습니다', e);
        });
    },

    resolveComment(id) {
      const before = d.getState().comments.find((c) => c.id === id);
      d.dispatch({ type: 'comment/resolve', id });
      hold('comments', id);
      track(d.api<{ comment: ServerComment }>(p(`/comments/${encodeURIComponent(id)}`), { method: 'PATCH', body: { resolved: true }, silent: true }))
        .then((r) => {
          release('comments', id);
          if (r?.comment) d.dispatch({ type: 'comment/upsert', comment: fromServerComment(r.comment) });
        })
        .catch((e) => {
          release('comments', id);
          if (before) d.dispatch({ type: 'comment/upsert', comment: before });
          fail('반영 완료 처리를 서버에 저장하지 못해 되돌렸습니다', e);
        });
    },

    async load(target) {
      try {
        if (target === 'dataset') {
          const ds = await d.api<Dataset>(p('/dataset'), { silent: true });
          if (!isDataset(ds)) throw new Error('데이터 형식이 올바르지 않습니다');
          d.dispatch({ type: 'data/set', data: ds });
          return true;
        }
        if (target === 'changes') {
          const r = await d.api<{ changes: ChangeRequest[] }>(p('/changes'), { silent: true });
          const list = Array.isArray(r?.changes) ? r.changes : [];
          d.dispatch({ type: 'changes/set', changes: mergeWithPending(list, d.getState().changes, ids('changes')) });
          return true;
        }
        if (target === 'incidents') {
          const r = await d.api<{ incidents: Incident[] }>(p('/incidents'), { silent: true });
          const list = Array.isArray(r?.incidents) ? r.incidents : [];
          const prev = new Set(d.getState().incidents.map((i) => i.id));
          d.dispatch({ type: 'incidents/set', incidents: mergeWithPending(list, d.getState().incidents, ids('incidents')) });
          // 서버(24시간 감지)가 새로 올린 P1 — 처음 불러올 때(prev 비어 있음)도 알린다
          const freshP1 = list.filter((i) => !prev.has(i.id) && i.severity === 'P1' && i.status !== 'resolved');
          if (freshP1.length) d.toast({ tone: 'critical', title: `P1 이슈 ${freshP1.length}건 감지`, body: freshP1.map((i) => i.title).slice(0, 2).join(' · '), route: 'alert' });
          return true;
        }
        if (target === 'comments') {
          const r = await d.api<{ comments: ServerComment[] }>(p('/comments'), { silent: true });
          const list = Array.isArray(r?.comments) ? r.comments.map(fromServerComment) : [];
          d.dispatch({ type: 'comments/set', comments: mergeWithPending(list, d.getState().comments, ids('comments'), 'append') });
          return true;
        }
        return false;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return false; // 로그인 화면으로 (플랫폼 전역 처리)
        const what = { dataset: '성과 데이터', changes: '변경 요청 목록', incidents: '이슈 목록', comments: '코멘트' }[target];
        d.toast({ tone: 'warning', title: `${what}를 서버에서 불러오지 못했습니다`, body: target === 'dataset' ? `${apiErrorMessage(e)} · 화면은 테스트 데이터(TEST DATA)로 표시합니다` : apiErrorMessage(e) });
        return false;
      }
    },

    pending: () => ({ changes: [...pend.changes.keys()], incidents: [...pend.incidents.keys()], comments: [...pend.comments.keys()] }),

    async settle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
  return bridge;
}

/**
 * 서버 모드 dispatch — 화면이 직접 보내는 액션(코멘트 등록 · Flow 시연 이력 적재 · 역할 바꾸기)을 가로챈다.
 * 반환값: 'bridge'(API로 보냄) · 'drop'(무시) · 'local'(그대로 리듀서) — 판정 규칙은 단위 테스트한다.
 */
export function routeServerAction(a: Action, serverRole: AppState['role']): 'bridge' | 'drop' | 'local' {
  switch (a.type) {
    case 'change/add':
      return a.change.id.startsWith(FLOW_SEED_PREFIX) ? 'drop' : 'bridge';
    case 'change/update':
    case 'incident/add':
    case 'incident/update':
    case 'comment/add':
    case 'comment/resolve':
      return 'bridge';
    case 'role/set':
      return a.role === serverRole ? 'local' : 'drop';
    case 'reset':
      return 'drop';
    default:
      return 'local';
  }
}

export function createServerDispatch(
  raw: (a: Action) => void,
  bridge: ServerBridge,
  opts: { serverRole: () => AppState['role']; onDrop?: (a: Action) => void },
): (a: Action) => void {
  return (a) => {
    const route = routeServerAction(a, opts.serverRole());
    if (route === 'local') return raw(a);
    if (route === 'drop') return opts.onDrop?.(a);
    switch (a.type) {
      case 'change/add': return bridge.addChange(a.change);
      case 'change/update': return bridge.updateChange(a.id, a.patch, a.log);
      case 'incident/add': return bridge.addIncident(a.incident);
      case 'incident/update': return bridge.updateIncident(a.id, a.patch, a.log);
      case 'comment/add': return bridge.addComment(a.comment);
      case 'comment/resolve': return bridge.resolveComment(a.id);
      default: return raw(a);
    }
  };
}
