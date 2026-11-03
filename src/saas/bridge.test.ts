/**
 * 서버 모드 스토어 브리지 · 리듀서 서버 액션 — 낙관적 갱신 → 서버 결과 반영 / 실패 시 되돌림, 서버 판정(held · dry_run) 안내,
 * 목록 다시 불러오기 시 대기 항목 유지, 화면 직접 dispatch 가로채기 규칙.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Incident, Toast } from '@/core/types';
import { reducer, type Action, type AppState, type Comment } from '@/core/store';
import { DEMO } from '@/data/demo';
import { ApiError, type ApiOptions } from './api';
import { createServerBridge, createServerDispatch, routeServerAction } from './bridge';

const WS = '11111111-1111-1111-1111-111111111111';

function baseState(): AppState {
  return {
    data: DEMO, changes: [], incidents: [], toasts: [], comments: [], ai: { mode: 'auto', apiKey: '', model: 'claude-opus-5-5' },
    role: 'PM', offHoursMode: false, tf: {}, demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
  };
}

const chg = (id: string, over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id, createdAt: '2026-11-02T01:00:00.000Z', module: 'adpilot', kind: 'bid', target: '매트리스 입찰가', before: 500, after: 600, changePct: 20,
  reason: '테스트', requestedBy: 'PM', approver: 'PM', status: 'pending', history: [{ at: '2026-11-02T01:00:00.000Z', by: 'PM', action: '요청 생성' }], ...over,
});
const inc = (id: string, over: Partial<Incident> = {}): Incident => ({
  id, ruleId: 'r', severity: 'P2', title: `이슈 ${id}`, detectedAt: '', occurredAt: '', detectPath: '', causeCandidates: [], impact: {}, status: 'open', timeline: [], isTest: false, autoActions: [], ...over,
});

type Call = { path: string; o: ApiOptions };
/** 가짜 API: 경로별 응답 함수 · 응답 보류(deferred) */
function harness(handlers: Record<string, (o: ApiOptions, path: string) => unknown> = {}) {
  let state = baseState();
  const calls: Call[] = [];
  const toasts: Omit<Toast, 'id'>[] = [];
  const holds: { resolve: () => void }[] = [];
  let holdAll = false;
  const api = async <T,>(path: string, o: ApiOptions = {}): Promise<T> => {
    calls.push({ path, o });
    if (holdAll) await new Promise<void>((r) => holds.push({ resolve: r }));
    const key = `${o.method ?? 'GET'} ${path.replace(`/api/w/${WS}`, '')}`;
    const h = handlers[key] ?? Object.entries(handlers).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (!h) throw new ApiError(404, 'not_found', '대상을 찾을 수 없습니다');
    const r = h(o, path);
    if (r instanceof Error) throw r;
    return r as T;
  };
  const dispatch = (a: Action) => { state = reducer(state, a); };
  const bridge = createServerBridge({ ws: WS, api: api as never, dispatch, getState: () => state, toast: (t) => toasts.push(t) });
  return {
    bridge, calls, toasts, dispatch,
    get state() { return state; },
    set state(s: AppState) { state = s; },
    hold(on: boolean) { holdAll = on; },
    releaseAll() { holds.splice(0).forEach((h) => h.resolve()); },
  };
}

describe('리듀서 서버 액션', () => {
  it('*/set · */upsert · */remove · tf/replace', () => {
    let s = baseState();
    s = reducer(s, { type: 'changes/set', changes: [chg('a'), chg('b')] });
    s = reducer(s, { type: 'change/upsert', change: chg('a', { status: 'held' }) });
    s = reducer(s, { type: 'change/upsert', change: chg('c') });
    expect(s.changes.map((c) => `${c.id}:${c.status}`)).toEqual(['c:pending', 'a:held', 'b:pending']);
    s = reducer(s, { type: 'change/remove', id: 'b' });
    expect(s.changes.map((c) => c.id)).toEqual(['c', 'a']);
    s = reducer(s, { type: 'incidents/set', incidents: [inc('i1')] });
    s = reducer(s, { type: 'incident/upsert', incident: inc('i1', { status: 'ack' }) });
    s = reducer(s, { type: 'incident/upsert', incident: inc('i2') });
    expect(s.incidents.map((i) => `${i.id}:${i.status}`)).toEqual(['i2:open', 'i1:ack']);
    s = reducer(s, { type: 'incident/remove', id: 'i2' });
    expect(s.incidents.map((i) => i.id)).toEqual(['i1']);
    const cm = (id: string, resolved = false): Comment => ({ id, target: 't', author: 'PM', text: id, at: '', resolved });
    s = reducer(s, { type: 'comments/set', comments: [cm('m1')] });
    s = reducer(s, { type: 'comment/upsert', comment: cm('m2') });
    s = reducer(s, { type: 'comment/upsert', comment: cm('m1', true) });
    expect(s.comments.map((c) => `${c.id}:${c.resolved}`)).toEqual(['m1:true', 'm2:false']);
    s = reducer(s, { type: 'comment/remove', id: 'm1' });
    expect(s.comments.map((c) => c.id)).toEqual(['m2']);
    s = reducer(s, { type: 'tf/replace', tf: { pm: { id: 'pm', name: '김', years: '10', allocation: '100%' } } });
    expect(s.tf.pm.name).toBe('김');
    s = reducer(s, { type: 'data/set', data: { ...DEMO, meta: { mode: 'live', builtAt: '', sources: [] } } });
    expect(s.data.meta?.mode).toBe('live');
  });
  it('기존 데모 액션 동작은 그대로 (change/add 앞에 · comment/add 뒤에 · incident/add 중복 무시)', () => {
    let s = baseState();
    s = reducer(s, { type: 'change/add', change: chg('a') });
    s = reducer(s, { type: 'change/add', change: chg('b') });
    expect(s.changes.map((c) => c.id)).toEqual(['b', 'a']);
    s = reducer(s, { type: 'incident/add', incident: inc('i') });
    s = reducer(s, { type: 'incident/add', incident: inc('i', { title: '다른 제목' }) });
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents[0].title).toBe('이슈 i');
  });
});

describe('변경 요청', () => {
  it('addChange: 바로 화면에 보이고(낙관적) POST { change } → 서버 결과로 교체', async () => {
    const h = harness({ 'POST /changes': (o) => ({ change: { ...(o.body as { change: ChangeRequest }).change, history: [{ at: 'srv', by: '김PM', action: '요청 생성' }] } }) });
    h.bridge.addChange(chg('chg_1'));
    expect(h.state.changes.map((c) => c.id)).toEqual(['chg_1']);
    expect(h.bridge.pending().changes).toEqual(['chg_1']);
    await h.bridge.settle();
    expect(h.calls[0]).toMatchObject({ path: `/api/w/${WS}/changes`, o: { method: 'POST', body: { change: { id: 'chg_1' } }, silent: true } });
    expect(h.state.changes[0].history[0].by).toBe('김PM');
    expect(h.bridge.pending().changes).toEqual([]);
    expect(h.toasts).toEqual([]);
  });
  it('addChange 실패 → 되돌리고 서버 사유로 오류 토스트', async () => {
    const h = harness({ 'POST /changes': () => new ApiError(403, 'forbidden', '이 작업을 할 권한이 없습니다') });
    h.bridge.addChange(chg('chg_x'));
    await h.bridge.settle();
    expect(h.state.changes).toEqual([]);
    expect(h.toasts[0]).toMatchObject({ tone: 'critical', title: '변경 요청을 서버에 저장하지 못했습니다', body: '이 작업을 할 권한이 없습니다' });
  });
  it('Flow 시연 이력(seed_flow_*)은 서버로 보내지 않고 적재하지 않는다', async () => {
    const h = harness();
    h.bridge.addChange(chg('seed_flow_1'));
    await h.bridge.settle();
    expect(h.calls).toEqual([]);
    expect(h.state.changes).toEqual([]);
  });
  it('updateChange: 낙관적 반영 → PATCH { patch, action, note } → 서버가 held로 판정하면 그 결과 + 이유 안내', async () => {
    const h = harness({
      'PATCH /changes/chg_1': () => ({ change: chg('chg_1', { status: 'held', execution: { mode: 'none', ok: false, at: 'x', error: '일일 변경 상한 20% 초과' } }) }),
    });
    h.state = { ...h.state, changes: [chg('chg_1', { status: 'approved' })] };
    h.bridge.updateChange('chg_1', { status: 'applied' }, { by: 'PM', action: '반영', note: '점검 통과' });
    expect(h.state.changes[0].status).toBe('applied');
    expect(h.state.changes[0].history.at(-1)).toMatchObject({ by: 'PM', action: '반영', note: '점검 통과' });
    await h.bridge.settle();
    expect(h.calls[0].o).toMatchObject({ method: 'PATCH', body: { patch: { status: 'applied' }, action: '반영', note: '점검 통과' } });
    expect(h.state.changes[0].status).toBe('held');
    expect(h.toasts[0]).toMatchObject({ tone: 'warning', title: '서버 판정: 보류' });
    expect(h.toasts[0].body).toContain('일일 변경 상한 20% 초과');
  });
  it('updateChange: dry_run 반영은 "매체에는 보내지 않음" 안내, live 성공은 반영 안내', async () => {
    const h = harness({
      'PATCH /changes/d': () => ({ change: chg('d', { status: 'applied', execution: { mode: 'dry_run', ok: true, at: 'x' } }) }),
      'PATCH /changes/l': () => ({ change: chg('l', { status: 'applied', execution: { mode: 'live', ok: true, at: 'x', provider: 'naver_sa' } }) }),
    });
    h.state = { ...h.state, changes: [chg('d', { status: 'approved' }), chg('l', { status: 'approved' })] };
    h.bridge.updateChange('d', { status: 'applied' }, { by: 'PM', action: '반영' });
    h.bridge.updateChange('l', { status: 'applied' }, { by: 'PM', action: '반영' });
    await h.bridge.settle();
    expect(h.toasts.map((t) => t.title)).toEqual(['dry-run으로 기록했습니다', '매체에 반영했습니다']);
  });
  it('updateChange: 서버가 반영을 백그라운드로 이어가면(approved + executing) 응답 그대로 두고 "반영 중" 안내 (보류로 오판하지 않음)', async () => {
    const running = chg('r', { status: 'approved' }) as ChangeRequest & { executing?: unknown };
    running.executing = { phase: 'apply', since: '2026-11-03T00:00:00Z', background: true };
    const h = harness({ 'PATCH /changes/r': () => ({ change: running }) });
    h.state = { ...h.state, changes: [chg('r', { status: 'approved' })] };
    h.bridge.updateChange('r', { status: 'applied' }, { by: 'PM', action: '반영' });
    expect(h.state.changes[0].status).toBe('applied');
    await h.bridge.settle();
    // 서버 응답(response.change)으로 항상 교체 — 상태는 approved, 실행 중 표시 유지
    expect(h.state.changes[0].status).toBe('approved');
    expect((h.state.changes[0] as typeof running).executing).toMatchObject({ background: true });
    expect(h.toasts.map((t) => t.title)).toEqual(['매체 반영 중']);
  });
  it('updateChange 409 + 서버 현재 상태 → 되돌리지 않고 서버 값으로', async () => {
    const h = harness({ 'PATCH /changes/chg_1': () => new ApiError(409, 'invalid_transition', '이미 반영된 요청입니다', undefined, { error: {}, change: chg('chg_1', { status: 'applied' }) }) });
    h.state = { ...h.state, changes: [chg('chg_1', { status: 'approved' })] };
    h.bridge.updateChange('chg_1', { status: 'rejected' }, { by: 'PM', action: '반려' });
    await h.bridge.settle();
    expect(h.state.changes[0].status).toBe('applied');
    expect(h.toasts[0]).toMatchObject({ tone: 'warning' });
    expect(h.toasts[0].body).toContain('이미 반영된 요청입니다');
  });
  it('updateChange 실패 → 이전 값으로 되돌림', async () => {
    const h = harness({ 'PATCH /changes/chg_1': () => new ApiError(409, 'conflict', '이미 다른 사람이 처리했습니다') });
    const before = chg('chg_1', { status: 'pending' });
    h.state = { ...h.state, changes: [before] };
    h.bridge.updateChange('chg_1', { status: 'approved' }, { by: 'PM', action: '승인' });
    expect(h.state.changes[0].status).toBe('approved');
    await h.bridge.settle();
    expect(h.state.changes[0]).toEqual(before);
    expect(h.toasts[0]).toMatchObject({ tone: 'critical', body: '이미 다른 사람이 처리했습니다' });
    expect(h.toasts[0].title).toContain('승인');
  });
});

describe('이슈', () => {
  it('addIncident: POST { incident } → upsert, 409(서버에 이미 있음)이면 목록을 다시 불러와 맞춘다', async () => {
    const h = harness({
      'POST /incidents': (o) => {
        const i = (o.body as { incident: Incident }).incident;
        return i.id === 'dup' ? new ApiError(409, 'conflict', '이미 있음') : { incident: { ...i, assignee: '이AE' } };
      },
      'GET /incidents': () => ({ incidents: [inc('dup', { status: 'ack' })] }),
    });
    h.bridge.addIncident(inc('i1'));
    await h.bridge.settle();
    expect(h.state.incidents[0].assignee).toBe('이AE');
    h.bridge.addIncident(inc('dup'));
    await h.bridge.settle();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.incidents.find((i) => i.id === 'dup')?.status).toBe('ack');
    expect(h.toasts.filter((t) => t.tone === 'critical')).toEqual([]);
  });
  it('같은 id 이슈는 다시 보내지 않는다 · 실패하면 제거', async () => {
    const h = harness({ 'POST /incidents': () => new ApiError(500, 'internal', 'x') });
    h.state = { ...h.state, incidents: [inc('have')] };
    h.bridge.addIncident(inc('have'));
    expect(h.calls).toEqual([]);
    h.bridge.addIncident(inc('new'));
    await h.bridge.settle();
    expect(h.state.incidents.map((i) => i.id)).toEqual(['have']);
    expect(h.toasts[0].body).toMatch(/서버 오류/);
  });
  it('updateIncident: PATCH { patch, action } → upsert / 실패 시 되돌림', async () => {
    const h = harness({
      'PATCH /incidents/ok': () => ({ incident: inc('ok', { status: 'ack', assignee: '서버 배정' }) }),
      'PATCH /incidents/bad': () => new ApiError(403, 'forbidden', '이 작업을 할 권한이 없습니다'),
    });
    h.state = { ...h.state, incidents: [inc('ok'), inc('bad')] };
    h.bridge.updateIncident('ok', { status: 'ack' }, { by: 'PM', action: '인지' });
    h.bridge.updateIncident('bad', { status: 'resolved' }, { by: 'PM', action: '종료' });
    expect(h.state.incidents.map((i) => i.status)).toEqual(['ack', 'resolved']);
    await h.bridge.settle();
    expect(h.calls.find((c) => c.path.endsWith('/incidents/ok'))?.o.body).toEqual({ patch: { status: 'ack' }, action: '인지' });
    expect(h.state.incidents.map((i) => `${i.id}:${i.status}:${i.assignee ?? ''}`)).toEqual(['ok:ack:서버 배정', 'bad:open:']);
  });
});

describe('코멘트', () => {
  it('등록: id · target · text만 보내고 서버 작성자 정보로 교체 / 실패 시 제거', async () => {
    const h = harness({
      'POST /comments': (o) => {
        const c = (o.body as { comment: { id: string; target: string; text: string } }).comment;
        if (c.text === 'fail') return new ApiError(400, 'bad_request', '입력값을 확인해 주세요: comment.text');
        return { comment: { ...c, author: '수면밀도 김담당', authorUser: 'u9', authorRole: 'client', at: '2026-11-02T02:00:00.000Z', resolved: false } };
      },
    });
    h.bridge.addComment({ id: 'cm_1', target: 'reports:daily:fact', author: '수면밀도', text: '확인 부탁', at: 'local' });
    await h.bridge.settle();
    expect(h.calls[0].o.body).toEqual({ comment: { id: 'cm_1', target: 'reports:daily:fact', text: '확인 부탁' } });
    expect(h.state.comments[0]).toMatchObject({ id: 'cm_1', author: '수면밀도', authorName: '수면밀도 김담당', at: '2026-11-02T02:00:00.000Z' });
    h.bridge.addComment({ id: 'cm_2', target: 't', author: 'PM', text: 'fail', at: '' });
    await h.bridge.settle();
    expect(h.state.comments.map((c) => c.id)).toEqual(['cm_1']);
    expect(h.toasts[0].body).toMatch(/입력값/);
  });
  it('반영 완료: PATCH { resolved: true } / 실패 시 되돌림', async () => {
    const h = harness({ 'PATCH /comments/cm_1': () => new ApiError(0, 'network', 'x') });
    h.state = { ...h.state, comments: [{ id: 'cm_1', target: 't', author: '수면밀도', text: 'x', at: '' }] };
    h.bridge.resolveComment('cm_1');
    expect(h.state.comments[0].resolved).toBe(true);
    await h.bridge.settle();
    expect(h.calls[0].o).toMatchObject({ method: 'PATCH', body: { resolved: true } });
    expect(h.state.comments[0].resolved).toBeFalsy();
    expect(h.toasts[0].body).toMatch(/연결할 수 없습니다/);
  });
});

describe('목록 다시 불러오기', () => {
  it('응답을 기다리는 낙관적 항목은 유지하고 나머지는 서버 값으로', async () => {
    const h = harness({ 'POST /changes': () => ({ change: chg('mine', { status: 'pending' }) }), 'GET /changes': () => ({ changes: [chg('other', { requestedBy: '다른 사용자' })] }) });
    h.hold(true);
    h.bridge.addChange(chg('mine'));
    h.hold(false);
    await h.bridge.load('changes');
    expect(h.state.changes.map((c) => c.id)).toEqual(['mine', 'other']);
    h.releaseAll();
    await h.bridge.settle();
    await h.bridge.load('changes');
    expect(h.state.changes.map((c) => c.id)).toEqual(['other']);
  });
  it('Dataset: 형식이 맞을 때만 교체, 실패하면 테스트 데이터 유지 + 안내', async () => {
    const live = { ...DEMO, meta: { mode: 'live' as const, builtAt: 'x', sources: [] } };
    const ok = harness({ 'GET /dataset': () => live });
    expect(await ok.bridge.load('dataset')).toBe(true);
    expect(ok.state.data.meta?.mode).toBe('live');
    const bad = harness({ 'GET /dataset': () => ({ nope: true }) });
    expect(await bad.bridge.load('dataset')).toBe(false);
    expect(bad.state.data).toBe(DEMO);
    expect(bad.toasts[0].body).toContain('TEST DATA');
    const missing = harness();
    expect(await missing.bridge.load('dataset')).toBe(false);
  });
  it('이슈 목록에 새 P1이 오면 알림, 401은 조용히(로그인 화면은 플랫폼이)', async () => {
    const h = harness({ 'GET /incidents': () => ({ incidents: [inc('p1', { severity: 'P1', title: '네이버 SA 노출 급감' }), inc('p2')] }) });
    await h.bridge.load('incidents');
    expect(h.toasts[0]).toMatchObject({ tone: 'critical', title: 'P1 이슈 1건 감지', route: 'alert' });
    await h.bridge.load('incidents');
    expect(h.toasts).toHaveLength(1);
    const u = harness({ 'GET /comments': () => new ApiError(401, 'unauthorized', '로그인이 필요합니다') });
    expect(await u.bridge.load('comments')).toBe(false);
    expect(u.toasts).toEqual([]);
  });
  it('코멘트 목록: 서버 형식 → 스토어 형식', async () => {
    const h = harness({ 'GET /comments': () => ({ comments: [{ id: 'a', target: 't', author: '이AE', authorRole: 'ae', text: 'x', at: '2026-11-02T00:00:00Z', resolved: true }] }) });
    await h.bridge.load('comments');
    expect(h.state.comments).toEqual([{ id: 'a', target: 't', author: '담당 AE', authorName: '이AE', authorUser: undefined, text: 'x', at: '2026-11-02T00:00:00Z', resolved: true }]);
  });
});

describe('화면 직접 dispatch 가로채기 (서버 모드)', () => {
  it('판정 규칙', () => {
    expect(routeServerAction({ type: 'change/add', change: chg('seed_flow_3') }, 'PM')).toBe('drop');
    expect(routeServerAction({ type: 'change/add', change: chg('chg_1') }, 'PM')).toBe('bridge');
    expect(routeServerAction({ type: 'comment/add', comment: { id: 'c', target: 't', author: 'PM', text: 'x', at: '' } }, 'PM')).toBe('bridge');
    expect(routeServerAction({ type: 'comment/resolve', id: 'c' }, 'PM')).toBe('bridge');
    expect(routeServerAction({ type: 'incident/update', id: 'i', patch: {} }, 'PM')).toBe('bridge');
    expect(routeServerAction({ type: 'role/set', role: '수면밀도' }, 'PM')).toBe('drop');
    expect(routeServerAction({ type: 'role/set', role: 'PM' }, 'PM')).toBe('local');
    expect(routeServerAction({ type: 'reset' }, 'PM')).toBe('drop');
    expect(routeServerAction({ type: 'toast/push', toast: { id: 't', tone: 'info', title: 'x' } }, 'PM')).toBe('local');
    expect(routeServerAction({ type: 'offhours/set', on: true }, 'PM')).toBe('local');
    expect(routeServerAction({ type: 'tf/set', id: 'a', patch: {} }, 'PM')).toBe('local');
    expect(routeServerAction({ type: 'demo/start' }, 'PM')).toBe('local');
  });
  it('Reports 섹션 코멘트(dispatch comment/add) → POST, 역할 바꾸기 → 무시 + 안내, 나머지는 리듀서로', async () => {
    const h = harness({ 'POST /comments': (o) => ({ comment: { ...(o.body as { comment: object }).comment, author: '김PM', authorRole: 'pm', at: 'srv' } }) });
    const dropped: string[] = [];
    const d = createServerDispatch(h.dispatch, h.bridge, { serverRole: () => 'PM', onDrop: (a) => dropped.push(a.type) });
    d({ type: 'comment/add', comment: { id: 'cm_r', target: 'reports:weekly:fact', author: 'PM', text: '이번 주 요약', at: 'local' } });
    d({ type: 'role/set', role: '수면밀도' });
    d({ type: 'offhours/set', on: true });
    d({ type: 'change/add', change: chg('seed_flow_1') });
    await h.bridge.settle();
    expect(h.calls.map((c) => `${c.o.method} ${c.path}`)).toEqual([`POST /api/w/${WS}/comments`]);
    expect(h.state.comments[0]).toMatchObject({ id: 'cm_r', author: 'PM', authorName: '김PM', at: 'srv' });
    expect(h.state.role).toBe('PM');
    expect(h.state.offHoursMode).toBe(true);
    expect(h.state.changes).toEqual([]);
    expect(dropped).toEqual(['role/set', 'change/add']);
  });
});
