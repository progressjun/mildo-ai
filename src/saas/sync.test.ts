/** 서버 모드 동기화 순수 규칙 — 저장 키 필터 · 값 인코딩 · 이벤트 매핑 · 출처 라벨 · 코멘트 매핑 · 병합 · 오류 문구 · 토큰 쿼리 */
import { describe, expect, it } from 'vitest';
import type { DatasetMeta } from '@/core/types';
import { DEMO } from '@/data/demo';
import { SEED_PREFIX } from '@/modules/flow/data';
import { passwordProblem as serverPasswordProblem } from '../../server/src/lib/crypto';
import { STATE_KEY_RE as SERVER_KEY_RE } from '../../server/src/state/service';
import { ApiError } from './api';
import {
  apiErrorMessage, AUTH_ENTRY_RE, backoffDelay, dataSourceLabel, dataTimeLabel, decodeStorageValue, encodeStorageValue, EVENT_REFETCH, FLOW_SEED_PREFIX,
  fromServerComment, isGlobalToastError, isSyncedStorageKey, mergeWithPending, normalizeInvite, passwordProblem, planStorageLoad, readAuthTokens, RECONNECT_TARGETS,
  refetchTargetOf, STATE_KEY_RE, stripAuthTokens, visibleModuleIds,
} from './sync';

describe('모듈 로컬 저장 키 필터', () => {
  it("'mildo-os/' 접두 키만, 'mildo-os/v1' · 'mildo-os/cloud/*' 제외", () => {
    for (const k of ['mildo-os/lab/v1', 'mildo-os/watch/v1', 'mildo-os/ops-v1', 'mildo-os/geo/live/v1', 'mildo-os/geo/case/v1']) expect(isSyncedStorageKey(k), k).toBe(true);
    for (const k of ['mildo-os/v1', 'mildo-os/cloud/workspace', 'mildo-os/cloud/ai', 'other/key', 'mildo-osx/lab', 'MILDO-OS/lab', 'mildo-os/Lab/V1', '', 'mildo-os/has space', `mildo-os/${'a'.repeat(120)}`]) {
      expect(isSyncedStorageKey(k), k).toBe(false);
    }
    expect(isSyncedStorageKey(42)).toBe(false);
  });
  it('서버 키 형식(server/src/state)과 같은 정규식', () => {
    expect(STATE_KEY_RE.source).toBe(SERVER_KEY_RE.source);
  });
  it('값 인코딩 왕복: JSON은 구조 그대로, JSON이 아닌 문자열은 { __raw }', () => {
    const cases = ['{"a":1,"b":[1,2]}', '"text"', '42', 'null', 'true', '[]', 'not json', '', '{broken'];
    for (const raw of cases) {
      const enc = encodeStorageValue(raw);
      const back = decodeStorageValue(enc);
      expect(JSON.stringify(JSON.parse(JSON.stringify(enc)))).toBe(JSON.stringify(enc)); // 직렬화 가능
      if (raw === '' || raw === 'not json' || raw === '{broken') expect(back).toBe(raw);
      else expect(JSON.parse(back)).toEqual(JSON.parse(raw));
    }
    expect(encodeStorageValue('{"a":1}')).toEqual({ a: 1 });
    expect(encodeStorageValue('plain')).toEqual({ __raw: 'plain' });
  });
  it('로그인 시 로컬 맞추기 계획: 서버 값 쓰기 · 서버에 없는 키 지우기 · 대기 중 키와 비동기화 키는 건드리지 않기', () => {
    const plan = planStorageLoad(
      { 'mildo-os/lab/v1': { x: 1 }, 'mildo-os/watch/v1': { same: true }, 'store:tf': { a: {} }, 'mildo-os/v1': { no: 1 }, 'mildo-os/ops-v1': null },
      { 'mildo-os/watch/v1': '{"same":true}', 'mildo-os/geo/live/v1': '[]', 'mildo-os/ops-v1': '{}', 'mildo-os/v1': '{"local":1}', 'mildo-os/cloud/ai': '{}', 'mildo-os/geo/case/v1': '{"draft":1}' },
      new Set(['mildo-os/geo/case/v1']),
    );
    expect(plan.writes).toEqual([['mildo-os/lab/v1', '{"x":1}']]);
    expect(plan.removes.sort()).toEqual(['mildo-os/geo/live/v1', 'mildo-os/ops-v1']);
  });
});

describe('SSE 이벤트 → 다시 불러오기', () => {
  it('이벤트 종류별 대상', () => {
    expect(refetchTargetOf('change')).toBe('changes');
    expect(refetchTargetOf('incident')).toBe('incidents');
    expect(refetchTargetOf('comment')).toBe('comments');
    expect(refetchTargetOf('dataset')).toBe('dataset');
    expect(refetchTargetOf('state')).toBe('state');
    expect(refetchTargetOf('config')).toBe('workspace');
    expect(refetchTargetOf('member')).toBe('me');
    expect(refetchTargetOf('connection')).toBeNull();
    expect(refetchTargetOf('report')).toBeNull();
    expect(refetchTargetOf('hello')).toBeNull();
    expect(refetchTargetOf('unknown')).toBeNull();
    // 스펙 §3 이벤트 type 목록을 모두 다룬다
    for (const t of ['change', 'incident', 'comment', 'dataset', 'connection', 'report', 'config', 'state']) expect(t in EVENT_REFETCH, t).toBe(true);
    expect(RECONNECT_TARGETS).toEqual(expect.arrayContaining(['changes', 'incidents', 'comments', 'dataset', 'state']));
  });
  it('재연결 대기: 1 · 2 · 4 · 8 · 16 · 30초 상한, 흔들기 0~20%', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, () => 0))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffDelay(1, () => 1)).toBe(1200);
    expect(backoffDelay(0, () => 0)).toBe(1000);
  });
});

describe('데이터 출처 라벨', () => {
  const meta = (mode: DatasetMeta['mode']): DatasetMeta => ({
    mode, builtAt: '2026-11-02T06:00:00Z',
    sources: [
      { channel: 'naver_sa', source: 'conn-1', kind: 'api', latestDate: '2026-11-02', latestHour: 14 },
      { channel: 'brandstore', source: 'csv:9', kind: 'csv', latestDate: '2026-11-01', latestHour: null },
      { channel: 'meta', source: 'demo', kind: 'demo', latestDate: null },
    ],
  });
  it('메타 없음 · demo → TEST DATA (데모 모드 기존 툴팁 그대로)', () => {
    expect(dataSourceLabel(undefined)).toEqual({ label: 'TEST DATA', tone: 'demo', cls: 'demo', title: '시연용 테스트 데이터 · 실제 성과 데이터 아님' });
    expect(dataSourceLabel(null).label).toBe('TEST DATA');
    const d = dataSourceLabel(meta('demo'));
    expect(d.label).toBe('TEST DATA');
    expect(d.title).toContain('네이버 SA');
  });
  it('live → LIVE DATA, mixed → LIVE + TEST, 툴팁에 매체별 출처 · 최신 시각', () => {
    const l = dataSourceLabel(meta('live'));
    expect(l).toMatchObject({ label: 'LIVE DATA', tone: 'live', cls: 'live' });
    expect(l.title).toContain('네이버 SA · API 연동 · 최신 11/2(월) 14시');
    expect(l.title).toContain('CSV 업로드 · 최신 11/1(일)');
    expect(l.title).toContain('테스트 데이터 · 최신 데이터 없음');
    const m = dataSourceLabel(meta('mixed'));
    expect(m).toMatchObject({ label: 'LIVE + TEST', tone: 'mixed', cls: 'mixed' });
    expect(m.title.split('\n')[0]).toMatch(/일부/);
  });
  it('live · mixed인데 출처가 하나도 없으면 "데이터 없음" (빈 데이터를 LIVE로 표시하지 않는다)', () => {
    expect(dataSourceLabel({ mode: 'live', builtAt: '', sources: [] })).toMatchObject({ label: '데이터 없음', tone: 'empty', cls: 'empty' });
    expect(dataSourceLabel({ mode: 'mixed', builtAt: '', sources: [] }).title).toMatch(/데이터 연결/);
  });
  it('알 수 없는 mode는 TEST DATA로 (실데이터로 오표시하지 않는다)', () => {
    expect(dataSourceLabel({ ...meta('live'), mode: 'weird' as never }).label).toBe('TEST DATA');
  });
  it('데이터 기준 시각은 generatedAt(KST) — 데모 데이터에서는 기존 표기와 같다', () => {
    const legacy = (d: typeof DEMO) => `${d.today.slice(5, 7).replace(/^0/, '')}/`;
    expect(dataTimeLabel(DEMO).startsWith(legacy(DEMO))).toBe(true);
    expect(dataTimeLabel(DEMO)).toMatch(new RegExp(`${String(DEMO.currentHour).padStart(2, '0')}:30$`));
    expect(dataTimeLabel({ generatedAt: '2026-11-02T05:07:00Z', today: '2026-11-02', currentHour: 1 })).toBe('11/2(월) 14:07');
    expect(dataTimeLabel({ generatedAt: '2026-11-01T16:30:00Z', today: '2026-11-01', currentHour: 1 })).toBe('11/2(월) 01:30'); // KST 자정 넘김
    expect(dataTimeLabel({ generatedAt: 'bad', today: '2026-11-02', currentHour: 9 })).toBe('11/2(월) 09:30');
  });
});

describe('서버 코멘트 → 스토어 코멘트', () => {
  it('작성자 역할을 표시 역할로, 이름은 authorName에', () => {
    const c = fromServerComment({ id: 'cm1', target: 'reports:daily:fact', author: '김담당', authorUser: 'u1', authorRole: 'client', text: '확인 부탁', at: '2026-11-02T01:00:00Z', resolved: false });
    expect(c).toEqual({ id: 'cm1', target: 'reports:daily:fact', author: '수면밀도', authorName: '김담당', authorUser: 'u1', text: '확인 부탁', at: '2026-11-02T01:00:00Z', resolved: false });
    expect(fromServerComment({ id: 'a', target: 't', author: '박', authorRole: 'owner', text: 'x', at: '' }).author).toBe('PM');
    expect(fromServerComment({ id: 'a', target: 't', author: '이', authorRole: 'viewer', text: 'x', at: '' }).author).toBe('담당 AE');
    expect(fromServerComment({ id: 'a', target: 't', author: '역할 모름', authorRole: null, text: 'x', at: '' }).author).toBe('역할 모름');
  });
});

describe('응답 대기 항목 병합', () => {
  const s = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  it('대기 중이 없으면 서버 목록 그대로', () => {
    expect(mergeWithPending(s, [{ id: 'x', v: 9 }], new Set())).toBe(s);
  });
  it('대기 중 항목은 로컬 값 유지 · 서버에 아직 없으면 붙인다', () => {
    const local = [{ id: 'new', v: 0 }, { id: 'b', v: 2 }, { id: 'a', v: 7 }];
    expect(mergeWithPending(s, local, new Set(['new', 'b']))).toEqual([{ id: 'new', v: 0 }, { id: 'a', v: 1 }, { id: 'b', v: 2 }]);
    expect(mergeWithPending(s, local, new Set(['new']), 'append')).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'new', v: 0 }]);
    expect(mergeWithPending(s, [], new Set(['gone']))).toEqual(s);
  });
});

describe('오류 문구 · 전역 처리 대상', () => {
  it('한국어 문구', () => {
    expect(apiErrorMessage(new ApiError(0, 'network', 'x'))).toMatch(/연결할 수 없습니다/);
    expect(apiErrorMessage(new ApiError(429, 'rate_limited', 'Too Many'))).toMatch(/요청이 너무 많습니다/);
    expect(apiErrorMessage(new ApiError(500, 'internal', 'Internal Server Error'))).toMatch(/서버 오류/);
    expect(apiErrorMessage(new ApiError(403, 'forbidden', '이 작업을 할 권한이 없습니다'))).toBe('이 작업을 할 권한이 없습니다');
    expect(apiErrorMessage(new Error('boom'))).toMatch(/처리하지 못했습니다/);
    expect(apiErrorMessage(new Error('데이터 형식이 올바르지 않습니다'))).toBe('데이터 형식이 올바르지 않습니다');
  });
  it('전역 토스트: 네트워크 · 5xx · 429 · CSRF · 잠금, 화면별 오류(400 · 403 · 404)는 제외', () => {
    expect(isGlobalToastError(new ApiError(0, 'network', ''))).toBe(true);
    expect(isGlobalToastError(new ApiError(502, 'http_502', ''))).toBe(true);
    expect(isGlobalToastError(new ApiError(429, 'rate_limited', ''))).toBe(true);
    expect(isGlobalToastError(new ApiError(403, 'csrf', ''))).toBe(true);
    expect(isGlobalToastError(new ApiError(423, 'workspace_locked', ''))).toBe(true);
    expect(isGlobalToastError(new ApiError(403, 'forbidden', ''))).toBe(false);
    expect(isGlobalToastError(new ApiError(400, 'bad_request', ''))).toBe(false);
    expect(isGlobalToastError(new ApiError(404, 'not_found', ''))).toBe(false);
  });
  it('401을 세션 만료로 보지 않는 로그인 전 경로', () => {
    for (const p of ['/api/auth/login', '/api/auth/me', '/api/auth/logout', '/api/auth/password-reset', '/api/auth/password-reset/confirm', '/api/invites/abc', '/api/invites/abc/accept']) expect(AUTH_ENTRY_RE.test(p), p).toBe(true);
    for (const p of ['/api/w/1/changes', '/api/auth/sessions', '/api/auth/password', '/api/w/1/state']) expect(AUTH_ENTRY_RE.test(p), p).toBe(false);
  });
});

describe('초대 · 재설정 링크 토큰', () => {
  it('쿼리에서 읽기 · 형식 검사 · 주소에서 지우기(해시 유지)', () => {
    expect(readAuthTokens('?invite=abcDEF123_-xyz')).toEqual({ invite: 'abcDEF123_-xyz', reset: null });
    expect(readAuthTokens('?reset=tok_0123456789')).toEqual({ invite: null, reset: 'tok_0123456789' });
    expect(readAuthTokens('?invite=<script>')).toEqual({ invite: null, reset: null });
    expect(readAuthTokens('?invite=short')).toEqual({ invite: null, reset: null });
    expect(readAuthTokens('')).toEqual({ invite: null, reset: null });
    expect(stripAuthTokens('https://app.example.com/?invite=abcDEF123&x=1#flow')).toBe('/?x=1#flow');
    expect(stripAuthTokens('https://app.example.com/?reset=abcdefgh12#home')).toBe('/#home');
    expect(stripAuthTokens('https://app.example.com/path')).toBe('/path');
  });
  it('비밀번호 정책은 서버(lib/crypto)와 같다', () => {
    for (const pw of ['short', 'alllowercaseletters', 'Abcdefgh12', 'abcdefghij1', '!!!!!!!!!!a', 'ABCDEFGHIJ', '한글비밀번호입니다아아']) {
      expect(passwordProblem(pw), pw).toBe(serverPasswordProblem(pw));
    }
  });
  it('초대 정보 정규화: { invite: { workspace } } · 평평한 형식 모두', () => {
    expect(normalizeInvite({ invite: { email: 'a@b.c', role: 'ae', expiresAt: '2026-11-09T00:00:00Z', workspace: { name: '수면밀도 퍼포먼스', brand_name: '수면밀도' } } }))
      .toEqual({ email: 'a@b.c', role: 'ae', workspaceName: '수면밀도 퍼포먼스', brandName: '수면밀도', expiresAt: '2026-11-09T00:00:00Z', invitedBy: null });
    expect(normalizeInvite({ email: 'x@y.z', role: 'client', workspaceName: 'W', invited_by_name: '김PM' })).toMatchObject({ email: 'x@y.z', role: 'client', workspaceName: 'W', invitedBy: '김PM' });
    expect(normalizeInvite({ invite: { role: 'superuser' } }).role).toBeNull();
    // team 도메인 실제 응답 (GET /api/invites/:token)
    expect(normalizeInvite({ workspace: { id: 'w', name: '수면밀도 퍼포먼스', brand_name: '수면밀도' }, email: 'n@x.io', role: 'pm', role_label: 'PM', invited_by_name: '운영 책임자', expires_at: '2026-11-09T00:00:00.000Z', expired: false, accepted: false, existing_user: true, signed_in_as_invitee: false }))
      .toEqual({ email: 'n@x.io', role: 'pm', workspaceName: '수면밀도 퍼포먼스', brandName: '수면밀도', expiresAt: '2026-11-09T00:00:00.000Z', invitedBy: '운영 책임자', expired: false, accepted: false, existingUser: true, signedInAsInvitee: false });
    expect(normalizeInvite(null)).toEqual({ email: null, role: null, workspaceName: null, brandName: null, expiresAt: null, invitedBy: null });
  });
});

describe('사용 모듈 (config.modules)', () => {
  const all = ['home', 'agent', 'board', 'flow', 'alert', 'workspace', 'team'];
  it('배열이 없으면 제한 없음(null)', () => {
    expect(visibleModuleIds(all, {}, { canConfigure: true })).toBeNull();
    expect(visibleModuleIds(all, null, { canConfigure: false })).toBeNull();
    expect(visibleModuleIds(all, { modules: 'board' }, { canConfigure: false })).toBeNull();
  });
  it('배열이면 그 모듈만 + 커맨드 센터, 설정 권한자는 워크스페이스 설정도', () => {
    expect([...visibleModuleIds(all, { modules: ['board', 'flow', 'nope', 3] }, { canConfigure: false })!]).toEqual(['home', 'board', 'flow']);
    expect([...visibleModuleIds(all, { modules: ['board'] }, { canConfigure: true })!]).toEqual(['home', 'board', 'workspace']);
    expect([...visibleModuleIds(all, { modules: [] }, { canConfigure: false })!]).toEqual(['home']);
  });
});

it('Flow 시연 이력 접두사는 flow 모듈과 같다', () => {
  expect(FLOW_SEED_PREFIX).toBe(SEED_PREFIX);
});
