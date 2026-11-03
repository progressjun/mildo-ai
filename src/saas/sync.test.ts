/** 서버 모드 동기화 순수 규칙 — 저장 키 필터 · 값 인코딩 · 이벤트 매핑 · 출처 라벨 · 코멘트 매핑 · 병합 · 오류 문구 · 토큰 쿼리 */
import { describe, expect, it } from 'vitest';
import type { DatasetMeta } from '@/core/types';
import { DEMO } from '@/data/demo';
import { SEED_PREFIX } from '@/modules/flow/data';
import { passwordProblem as serverPasswordProblem } from '../../server/src/lib/crypto';
import { STATE_KEY_RE as SERVER_KEY_RE } from '../../server/src/state/service';
import { ApiError } from './api';
import {
  apiErrorMessage, AUTH_ENTRY_RE, backoffDelay, configFingerprint, dataSourceLabel, dataTimeLabel, decodeStorageValue, encodeStorageValue, EVENT_REFETCH, FIXTURE_TITLE_RE, FLOW_SEED_PREFIX,
  fromServerComment, isGlobalToastError, isSyncedStorageKey, mergeWithPending, normalizeInvite, normalizeResetCheck, offHoursFromConfig, passwordProblem, planStorageLoad, readAuthTokens, RECONNECT_TARGETS,
  refetchTargetForEvent, refetchTargetOf, resetLinkProblem, SERVER_EVENT_TYPES, serverKoreanMessage, srcDemoLabel, STATE_KEY_RE, stripAuthTokens, visibleModuleIds,
} from './sync';
import { readFileSync } from 'node:fs';

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
    // 알림 채널 이벤트: 화면 구독만 (스토어 다시 읽기 · 워크스페이스 설정 새로고침 안내 없음)
    expect(refetchTargetOf('notify')).toBeNull();
    expect(SERVER_EVENT_TYPES).toContain('notify');
    expect(refetchTargetOf('hello')).toBeNull();
    expect(refetchTargetOf('unknown')).toBeNull();
    // 스펙 §3 이벤트 type 목록을 모두 다룬다
    for (const t of ['change', 'incident', 'comment', 'dataset', 'connection', 'report', 'config', 'state', 'member', 'notify']) expect(t in EVENT_REFETCH, t).toBe(true);
    expect(RECONNECT_TARGETS).toEqual(expect.arrayContaining(['changes', 'incidents', 'comments', 'dataset', 'state']));
  });
  it("config 이벤트 중 id 'review'(온보딩 기본값 확인 기록)는 설정을 다시 읽지 않는다 · 다른 config는 다시 읽는다", () => {
    expect(refetchTargetForEvent({ type: 'config', id: 'review' })).toBeNull();
    expect(refetchTargetForEvent({ type: 'config', id: 'workspace' })).toBe('workspace');
    expect(refetchTargetForEvent({ type: 'config' })).toBe('workspace');
    expect(refetchTargetForEvent({ type: 'change', id: 'review' })).toBe('changes'); // 다른 종류의 id는 상관없다
    expect(refetchTargetForEvent({ type: 'notify', id: 'ch-1' })).toBeNull();
  });
  it('재연결하면 놓친 설정 · 멤버십 변경도 다시 확인한다', () => {
    expect(RECONNECT_TARGETS).toEqual(expect.arrayContaining(['workspace', 'me']));
  });
  it('설정 비교: 키 순서 · undefined 키와 무관, 값이 다르면 다르다 (자기 저장 직후 안내를 띄우지 않는 판정)', () => {
    expect(configFingerprint({ b: 1, a: { y: [1, { q: 2, p: 1 }], x: null } })).toBe(configFingerprint({ a: { x: null, y: [1, { p: 1, q: 2 }] }, b: 1, c: undefined }));
    expect(configFingerprint({ a: 1 })).not.toBe(configFingerprint({ a: 2 }));
    expect(configFingerprint({ a: [1, 2] })).not.toBe(configFingerprint({ a: [2, 1] }));
    expect(configFingerprint(null)).toBe(configFingerprint(undefined));
    expect(configFingerprint({})).not.toBe(configFingerprint(null));
  });
  it('당번 체계 강제: config.offHoursMode === true만 켠다 (서버 alerts 스캔과 같은 읽기)', () => {
    expect(offHoursFromConfig({ offHoursMode: true })).toBe(true);
    for (const v of [false, 'true', 1, null, undefined]) expect(offHoursFromConfig({ offHoursMode: v }), String(v)).toBe(false);
    expect(offHoursFromConfig(null)).toBe(false);
    expect(offHoursFromConfig(undefined)).toBe(false);
    // 서버 scan.ts가 같은 키를 같은 방식으로 읽는다
    const scan = readFileSync(new URL('../../server/src/alerts/scan.ts', import.meta.url), 'utf8');
    expect(scan).toMatch(/offHoursMode\?: unknown \}\)\.offHoursMode === true/);
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
  it('출처 태그(Src DEMO): 데모 모드는 기존 그대로, 실연동이면 데이터셋 값은 LIVE · 시연용 예시(가정 · 가상 · 실제 아님)는 TEST DATA', () => {
    // 데모 모드(메타 없음): 모듈이 준 툴팁 그대로 · 라벨 TEST DATA (기존 동작)
    expect(srcDemoLabel(undefined, { title: '판매가 · 프로모션은 TEST DATA' })).toMatchObject({ label: 'TEST DATA', tone: 'demo', title: '판매가 · 프로모션은 TEST DATA' });
    expect(srcDemoLabel(undefined).title).toBe(dataSourceLabel(undefined).title);
    expect(srcDemoLabel(meta('demo'), { title: '시연용 가정 계정 · 실제 계정 아님' }).title).toBe('시연용 가정 계정 · 실제 계정 아님');
    // 실연동: 데이터셋에서 계산한 값 → LIVE DATA (모듈의 'TEST DATA' 문구 툴팁은 쓰지 않는다)
    const live = srcDemoLabel(meta('live'), { title: '판매가 · 프로모션은 TEST DATA' });
    expect(live).toMatchObject({ label: 'LIVE DATA', tone: 'live' });
    expect(live.title).not.toContain('판매가');
    expect(srcDemoLabel(meta('mixed')).label).toBe('LIVE + TEST');
    // 실연동이어도 시연용 예시는 TEST DATA (실데이터로 오표시하지 않는다)
    for (const t of ['시연용 가정 계정 · 실제 계정 아님', '가상 이력 · 실제 테스트 결과 아님', '데모 진단 스냅샷 · 실제 엔진 응답 아님', '검색량은 데모 추정', '후보 점수는 데모 평가 · 매체 미팅 후 확정', '탄력성 가정 시뮬레이션', 'VisualTune 초안은 시연용', '시연용 이력 · 실제 운영 이력 아님']) {
      const f = srcDemoLabel(meta('live'), { title: t });
      expect(f.label, t).toBe('TEST DATA');
      expect(f.tone, t).toBe('demo');
      expect(f.title.startsWith(t), t).toBe(true);
    }
    expect(srcDemoLabel(meta('live'), { fixture: true }).label).toBe('TEST DATA');
    expect(srcDemoLabel(meta('live'), { title: '검색량은 데모 추정', fixture: false }).label).toBe('LIVE DATA'); // 명시가 문구 판정보다 우선
    // 데이터셋 기반 문구는 예시로 보지 않는다
    for (const t of ['판매가 · 프로모션은 TEST DATA', '계정 · 성과 기준선은 시연용 테스트 데이터', '사이즈 · 정가 · 재고는 시연용 테스트 데이터', '샘플은 시연용 테스트 데이터의 상품 · 옵션 · 프로모션으로 생성']) expect(FIXTURE_TITLE_RE.test(t), t).toBe(false);
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
  it('재설정 링크 사전 확인 정규화 (team POST /auth/password-reset/check) · 쓸 수 없는 링크 안내', () => {
    expect(normalizeResetCheck({ valid: true, email: 'r***@example.com', expiresAt: '2026-11-03T01:00:00.000Z' }))
      .toEqual({ valid: true, reason: null, email: 'r***@example.com', expiresAt: '2026-11-03T01:00:00.000Z' });
    expect(normalizeResetCheck({ valid: false, reason: 'used' })).toEqual({ valid: false, reason: 'used', email: null, expiresAt: null });
    expect(normalizeResetCheck({ valid: false, reason: 'expired' })?.reason).toBe('expired');
    expect(normalizeResetCheck({ valid: false })?.reason).toBe('invalid');
    expect(normalizeResetCheck({ valid: false, reason: 'weird' })?.reason).toBe('invalid');
    // 형식이 다르면 확인 불가(null) — 화면은 폼을 보여 주고 confirm이 판정
    expect(normalizeResetCheck(null)).toBeNull();
    expect(normalizeResetCheck({ ok: true })).toBeNull();
    for (const r of ['used', 'reset_used', 'expired', 'reset_expired', 'invalid', 'reset_invalid']) expect(resetLinkProblem(r), r).toMatch(/재설정/);
    expect(resetLinkProblem('weak_password')).toBeNull();
    expect(resetLinkProblem(null)).toBeNull();
    expect(serverKoreanMessage(new ApiError(429, 'login_locked', '잠시 막았습니다'))).toBe('잠시 막았습니다');
    expect(serverKoreanMessage(new ApiError(500, 'internal', 'Internal Server Error'))).toBeNull();
    expect(serverKoreanMessage(new Error('한국어지만 ApiError 아님'))).toBeNull();
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

describe('서버 모드 AI 거부 코드 (ai 도메인 ↔ SearchTuneOS 진단 버튼)', () => {
  it('서버가 AI를 쓸 수 없다고 답하는 코드(키 없음 · AI 꺼짐 · 권한 없음)는 진단 버튼을 끄는 거부 코드에 들어 있다', async () => {
    const { DENIED_CODES } = await import('@/modules/geo/engine');
    for (const code of ['not_granted', 'sampling_disabled', 'no_backend', 'ai_not_configured', 'ai_disabled', 'forbidden', 'workspace_locked']) expect(DENIED_CODES.has(code), code).toBe(true);
    // ai 도메인(src/ai/claude.ts)이 서버 백엔드를 끄는(markServerDenied) 코드는 모두 거부 코드다
    const src = readFileSync(new URL('../ai/claude.ts', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('markServerDenied()') && l.includes('code ==='));
    expect(line).toBeTruthy();
    const codes = [...line!.matchAll(/code === '([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(2);
    for (const code of codes) expect(DENIED_CODES.has(code), code).toBe(true);
    // 일시적 오류는 거부로 보지 않는다 (사용자가 다시 시도할 수 있게)
    for (const code of ['rate_limited', 'upstream_error', 'budget_exceeded']) expect(DENIED_CODES.has(code), code).toBe(false);
  });
});
