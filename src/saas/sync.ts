/**
 * 서버 모드 동기화의 순수 규칙 (React · DOM 없음 — 단위 테스트 대상).
 *  - 모듈 로컬 저장 키 필터 · 값 인코딩 (localStorage ↔ workspace_state)
 *  - SSE 이벤트 → 다시 불러올 목록
 *  - 데이터 출처 라벨 (TEST DATA · LIVE DATA · LIVE + TEST)
 *  - 서버 코멘트 → 스토어 코멘트, 낙관적 갱신 중인 항목 병합, 재연결 대기 시간, 오류 문구
 */
import type { DatasetMeta } from '@/core/types';
import type { Comment } from '@/core/store';
import { demoRoleOf, ROLES, type Role } from '@/core/permissions';
import { MEDIA, SALES_CHANNELS } from '@/data/constants';
import { fmtDate } from '@/core/util';
import { ApiError } from './api';

/* ---------- 모듈 로컬 저장 (localStorage 'mildo-os/*' ↔ workspace_state) ---------- */

export const STORAGE_PREFIX = 'mildo-os/';
/** 동기화하지 않는 키: 전역 스토어 저장본(서버 모드에서는 서버가 원본) · 클라우드 세션 설정(워크스페이스 선택 등) */
export const STORE_STORAGE_KEY = 'mildo-os/v1';
export const CLOUD_PREFIX = 'mildo-os/cloud/';
/** 서버 state 키 형식 (server/src/state STATE_KEY_RE와 같다) */
export const STATE_KEY_RE = /^[a-z0-9:/._-]{1,120}$/;
/** 전역 스토어의 TF 입력(state.tf)을 보관하는 가상 키 — localStorage에는 쓰지 않는다 */
export const TF_STATE_KEY = 'store:tf';

export function isSyncedStorageKey(key: unknown): key is string {
  return typeof key === 'string'
    && key.startsWith(STORAGE_PREFIX)
    && key !== STORE_STORAGE_KEY
    && !key.startsWith(CLOUD_PREFIX)
    && STATE_KEY_RE.test(key);
}

/** localStorage 문자열 → 서버 값: JSON이면 구조 그대로, 아니면 { __raw } (되돌릴 때 원문 그대로) */
export function encodeStorageValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __raw: raw };
  }
}

/** 서버 값 → localStorage 문자열 */
export function decodeStorageValue(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '__raw' && typeof o.__raw === 'string') return o.__raw;
  }
  return JSON.stringify(value);
}

/**
 * 로그인 · 워크스페이스 진입 시 localStorage를 서버 값으로 맞추는 계획.
 * 서버에 없는 동기화 키는 지운다 (다른 워크스페이스 · 이전 사용자의 입력이 남지 않게). keep의 키(아직 보내지 않은 로컬 입력)는 건드리지 않는다.
 */
export function planStorageLoad(
  server: Record<string, unknown>,
  local: Record<string, string>,
  keep: ReadonlySet<string> = new Set(),
): { writes: [string, string][]; removes: string[] } {
  const writes: [string, string][] = [];
  const removes: string[] = [];
  for (const [k, v] of Object.entries(server)) {
    if (!isSyncedStorageKey(k) || keep.has(k) || v === null || v === undefined) continue;
    const raw = decodeStorageValue(v);
    if (local[k] !== raw) writes.push([k, raw]);
  }
  for (const k of Object.keys(local)) {
    if (!isSyncedStorageKey(k) || keep.has(k)) continue;
    if (!(k in server) || server[k] === null) removes.push(k);
  }
  return { writes, removes };
}

/* ---------- SSE 이벤트 → 다시 불러오기 ---------- */

export type RefetchTarget = 'changes' | 'incidents' | 'comments' | 'dataset' | 'state' | 'workspace' | 'me';

/** 이벤트 이름(type) → 다시 불러올 대상. connection · report · notify 등 스토어에 없는 것은 null (각 화면이 onServerEvent로 받는다) */
export const EVENT_REFETCH: Record<string, RefetchTarget | null> = {
  change: 'changes',
  incident: 'incidents',
  comment: 'comments',
  dataset: 'dataset',
  state: 'state',
  config: 'workspace',
  member: 'me',
  connection: null,
  report: null,
  // 알림 채널 생성 · 수정 · 삭제 · 테스트 (alerts) — 알림 설정 화면이 onServerEvent('notify')로 받는다. 스토어 목록 · 설정 다시 읽기 없음
  notify: null,
};
export const SERVER_EVENT_TYPES = Object.keys(EVENT_REFETCH);

export function refetchTargetOf(type: string): RefetchTarget | null {
  return EVENT_REFETCH[type] ?? null;
}

/**
 * 이벤트(종류 + id) → 다시 불러올 대상. config 이벤트 중 id 'review'는 온보딩 기본값 확인 기록(POST /config/review)이라
 * 설정 값이 바뀌지 않는다 — 워크스페이스 설정을 다시 읽지 않고 '설정이 바뀌었습니다' 안내도 띄우지 않는다
 * (워크스페이스 설정 화면이 onServerEvent('config')로 온보딩 상태만 다시 읽는다).
 */
export function refetchTargetForEvent(e: { type: string; id?: string | null }): RefetchTarget | null {
  if (e.type === 'config' && e.id === 'review') return null;
  return refetchTargetOf(e.type);
}

/** 재연결 시 놓친 이벤트를 메우려고 다시 불러오는 목록 (설정 · 멤버십 포함 — 바뀐 게 없으면 안내 없이 끝난다) */
export const RECONNECT_TARGETS: RefetchTarget[] = ['changes', 'incidents', 'comments', 'dataset', 'state', 'workspace', 'me'];

/** 설정 비교용 정규화 JSON (키 순서 무관) — 값이 실제로 바뀐 경우에만 안내하려고 쓴다 */
export function configFingerprint(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(configFingerprint).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${configFingerprint(o[k])}`).join(',')}}`;
}

/** 워크스페이스 설정의 주말 · 공휴일 당번 체계 강제 (settings offHoursMode — 서버 alerts 스캔 · SLA와 같은 읽기: === true) */
export function offHoursFromConfig(cfg: Record<string, unknown> | null | undefined): boolean {
  return (cfg as { offHoursMode?: unknown } | null | undefined)?.offHoursMode === true;
}

/** 재연결 대기: 1 · 2 · 4 · 8 · 16 · 30초(상한) + 0~20% 흔들기 */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 + 0.2 * rand()));
}

/* ---------- 조사 ---------- */

/** 끝 글자의 받침 유무 — 한글은 종성, 숫자 · 영문은 읽는 소리 기준(1 일 · 3 삼 · L 엘 · M 엠 · N 엔), 그 밖은 받침 없음 */
function hasFinalConsonant(word: string): boolean {
  const w = word.replace(/[\s)\]'"’”·.]+$/u, '');
  const ch = w.slice(-1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/\d/.test(ch)) return '013678'.includes(ch);
  if (/[a-z]/i.test(ch)) return 'lmn'.includes(ch.toLowerCase());
  return false;
}
/** 목적격 조사 — '반영을' · '승인을' · '보류를' (동적으로 들어가는 작업 이름 뒤, '을(를)' 대신) */
export function withObjectParticle(word: string): string {
  return `${word}${hasFinalConsonant(word) ? '을' : '를'}`;
}

/* ---------- 데이터 출처 라벨 ---------- */

export interface DataSourceLabel {
  label: 'TEST DATA' | 'LIVE DATA' | 'LIVE + TEST' | '데이터 없음';
  /** empty = 서버 모드인데 연결된 출처가 하나도 없음 (실데이터로 표시하지 않는다) */
  tone: 'demo' | 'live' | 'mixed' | 'empty';
  /** .src 클래스 */
  cls: 'demo' | 'live' | 'mixed' | 'empty';
  title: string;
}

const KIND_LABEL: Record<string, string> = { api: 'API 연동', csv: 'CSV 업로드', demo: '테스트 데이터' };

/** 매체 · 판매 채널이 아닌 웨어하우스 출처 채널 (server/src/warehouse 데이터셋 메타 sources[].channel) */
const NON_MEDIA_CHANNEL: Record<string, string> = { brand_search: '브랜드 검색량' };

/** 출처 채널 id → 한국어 이름 (매체 · 판매 채널 · 브랜드 검색량). connections/model.ts channelLabel과 같은 이름을 쓴다 */
export function channelName(id: string): string {
  return (MEDIA as Record<string, { name: string } | undefined>)[id]?.name
    ?? (SALES_CHANNELS as Record<string, { name: string } | undefined>)[id]?.name
    ?? NON_MEDIA_CHANNEL[id]
    ?? id;
}

/** 출처 목록 툴팁: 채널 · 출처 종류 · 최신 데이터 날짜(시각) */
export function describeSources(meta: DatasetMeta): string[] {
  return (meta.sources ?? []).map((s) => {
    const latest = s.latestDate ? `${fmtDate(s.latestDate)}${s.latestHour !== null && s.latestHour !== undefined ? ` ${String(s.latestHour).padStart(2, '0')}시` : ''}` : '데이터 없음';
    return `${channelName(s.channel)} · ${KIND_LABEL[s.kind] ?? s.kind} · 최신 ${latest}`;
  });
}

/**
 * 출처 태그 문구가 '데이터셋과 무관한 시연용 예시'를 가리키는지 — 예: '시연용 가정 계정 · 실제 계정 아님', '가상 이력 · 실제 테스트 결과 아님',
 * '데모 진단 스냅샷', '검색량은 데모 추정', '후보 점수는 데모 평가', '탄력성 가정 시뮬레이션'. 이런 태그는 워크스페이스 데이터가
 * 실연동(LIVE)이어도 TEST DATA로 남겨야 한다 (예시 · 가정을 실데이터로 오표시하지 않는다).
 */
export const FIXTURE_TITLE_RE = /(아님|가정|가상|데모 (평가|추정|스냅샷|진단)|시연용 (가정|이력|예시)|초안은 시연용)/;

/**
 * Src kind='DEMO' 태그 라벨. 데이터셋에서 계산한 값은 데이터 출처(TEST DATA · LIVE DATA · LIVE + TEST · 데이터 없음)를 따르고,
 * 시연용 예시(fixture — 명시 또는 문구로 판정)는 언제나 TEST DATA. 데모 모드(메타 없음 · demo)는 기존 표기 그대로.
 */
export function srcDemoLabel(meta: DatasetMeta | null | undefined, opts: { title?: string; fixture?: boolean } = {}): DataSourceLabel {
  const ds = dataSourceLabel(meta);
  if (ds.tone === 'demo') return { ...ds, title: opts.title ?? ds.title };
  const fixture = opts.fixture ?? (typeof opts.title === 'string' && FIXTURE_TITLE_RE.test(opts.title));
  if (fixture) return { label: 'TEST DATA', tone: 'demo', cls: 'demo', title: `${opts.title ?? '시연용 예시 · 실제 데이터 아님'}\n워크스페이스 데이터와 무관한 시연용 예시입니다 (실연동 데이터 아님)` };
  return ds;
}

export function dataSourceLabel(meta?: DatasetMeta | null): DataSourceLabel {
  const demoTitle = '시연용 테스트 데이터 · 실제 성과 데이터 아님';
  if (!meta || meta.mode === 'demo' || (meta.mode !== 'live' && meta.mode !== 'mixed')) {
    const lines = meta ? describeSources(meta) : [];
    return { label: 'TEST DATA', tone: 'demo', cls: 'demo', title: lines.length ? `${demoTitle}\n${lines.join('\n')}` : demoTitle };
  }
  const lines = describeSources(meta);
  if (!lines.length) {
    return { label: '데이터 없음', tone: 'empty', cls: 'empty', title: '연결된 데이터 출처가 없습니다. 07 관리 · 연동 → 데이터 연결에서 매체 · 판매 채널 API를 연결하거나 CSV를 올리세요.' };
  }
  if (meta.mode === 'live') {
    return { label: 'LIVE DATA', tone: 'live', cls: 'live', title: ['실연동 데이터 (매체 · 판매 채널 API 또는 업로드)', ...lines].join('\n') };
  }
  return { label: 'LIVE + TEST', tone: 'mixed', cls: 'mixed', title: ['일부 매체 · 채널만 실연동 — 나머지는 테스트 데이터', ...lines].join('\n') };
}

/** 데이터 기준 시각 (KST) — Dataset.generatedAt 기준. 형식이 맞지 않으면 today · currentHour로 */
export function dataTimeLabel(data: { generatedAt?: string; today: string; currentHour: number }): string {
  const ms = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  if (Number.isFinite(ms)) {
    const k = new Date(ms + 9 * 3600_000);
    const date = k.toISOString().slice(0, 10);
    return `${fmtDate(date)} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
  }
  return `${fmtDate(data.today)} ${String(data.currentHour).padStart(2, '0')}:30`;
}

/* ---------- 코멘트 ---------- */

export interface ServerComment {
  id: string;
  target: string;
  author: string;
  authorUser?: string | null;
  authorRole?: string | null;
  text: string;
  at: string;
  resolved?: boolean;
}

/**
 * 서버 코멘트 → 스토어 코멘트. author는 화면 규칙(수면밀도 피드백 판정 등)에 맞게 표시 역할('담당 AE' · 'PM' · '수면밀도'),
 * 실제 작성자 이름은 authorName에 둔다.
 */
export function fromServerComment(c: ServerComment): Comment {
  const role = (ROLES as readonly string[]).includes(c.authorRole ?? '') ? (c.authorRole as Role) : null;
  return {
    id: c.id,
    target: c.target,
    author: role ? demoRoleOf(role) : c.author,
    authorName: c.author,
    authorUser: c.authorUser ?? undefined,
    text: c.text,
    at: c.at,
    resolved: !!c.resolved,
  };
}

/* ---------- 낙관적 갱신 병합 ---------- */

/**
 * 서버 목록으로 교체하되, 아직 응답을 기다리는(낙관적으로 바꾼) 항목은 로컬 값을 유지한다 — 다른 사용자 이벤트로 목록을 다시 불러와도
 * 방금 누른 변경이 잠깐 사라졌다 나타나지 않게. 서버에 아직 없는 대기 항목은 앞(prepend) 또는 뒤(append)에 붙인다.
 */
export function mergeWithPending<T extends { id: string }>(server: T[], local: T[], pending: ReadonlySet<string>, where: 'prepend' | 'append' = 'prepend'): T[] {
  if (!pending.size) return server;
  const localById = new Map(local.map((x) => [x.id, x]));
  const merged = server.map((x) => (pending.has(x.id) && localById.has(x.id) ? localById.get(x.id)! : x));
  const serverIds = new Set(server.map((x) => x.id));
  const extra = local.filter((x) => pending.has(x.id) && !serverIds.has(x.id));
  return where === 'prepend' ? [...extra, ...merged] : [...merged, ...extra];
}

/* ---------- 오류 문구 ---------- */

/** 사용자에게 보여 줄 한국어 오류 문구 */
export function apiErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요';
    if (e.status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요';
    if (e.status >= 500 && !/[가-힣]/.test(e.message)) return '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요';
    return e.message || `요청 실패 (${e.status})`;
  }
  if (e && typeof e === 'object' && 'message' in e && typeof (e as Error).message === 'string' && /[가-힣]/.test((e as Error).message)) return (e as Error).message;
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요';
}

/** 전역 토스트를 띄울 오류인지 (화면별 입력 검증 · 권한 오류는 각 화면이 안내) */
export function isGlobalToastError(e: ApiError): boolean {
  return e.status === 0 || e.status === 429 || e.status >= 500 || (e.status === 403 && e.code === 'csrf') || e.status === 423;
}

/** 로그인 전 엔드포인트 — 401이어도 '세션 만료'로 처리하지 않는다 */
export const AUTH_ENTRY_RE = /^\/api\/(auth\/(login|me|logout|password-reset(\/.*)?)|invites\/[^/]+(\/accept)?|setup)$/;

/* ---------- 로그인 전 화면 (초대 · 비밀번호 재설정 링크) ---------- */

export interface AuthTokens { invite: string | null; reset: string | null }
const TOKEN_RE = /^[A-Za-z0-9_\-.~]{8,256}$/;

export function readAuthTokens(search: string): AuthTokens {
  try {
    const q = new URLSearchParams(search);
    const inv = q.get('invite');
    const rst = q.get('reset');
    return { invite: inv && TOKEN_RE.test(inv) ? inv : null, reset: rst && TOKEN_RE.test(rst) ? rst : null };
  } catch {
    return { invite: null, reset: null };
  }
}

/** URL에서 invite · reset 쿼리를 뺀 주소 (해시 라우트는 유지) */
export function stripAuthTokens(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete('invite');
    u.searchParams.delete('reset');
    const qs = u.searchParams.toString();
    return `${u.pathname}${qs ? `?${qs}` : ''}${u.hash}`;
  } catch {
    return href;
  }
}

/** 비밀번호 정책 (서버 lib/crypto passwordProblem과 같다 — 최종 판정은 서버) */
export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds < 2) return '영문 대소문자 · 숫자 · 기호 중 2가지 이상을 섞어 주세요';
  return null;
}

/** 초대 정보 — team 도메인 응답 형식이 조금 달라도 이메일 · 역할 · 워크스페이스 이름을 찾는다 */
export interface InviteInfo {
  email: string | null; role: Role | null; workspaceName: string | null; brandName: string | null; expiresAt: string | null; invitedBy: string | null;
  /** 만료 · 이미 수락 · 이미 가입된 이메일 · 지금 그 계정으로 로그인 중 */
  expired?: boolean; accepted?: boolean; existingUser?: boolean; signedInAsInvitee?: boolean;
}
export function normalizeInvite(json: unknown): InviteInfo {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const inv = (root.invite && typeof root.invite === 'object' ? root.invite : root) as Record<string, unknown>;
  const wsObj = (inv.workspace && typeof inv.workspace === 'object' ? inv.workspace : root.workspace && typeof root.workspace === 'object' ? root.workspace : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const role = s(inv.role);
  const b = (...vals: unknown[]) => vals.find((v) => typeof v === 'boolean') as boolean | undefined;
  const out: InviteInfo = {
    email: s(inv.email),
    role: role && (ROLES as readonly string[]).includes(role) ? (role as Role) : null,
    workspaceName: s(wsObj.name) ?? s(inv.workspaceName) ?? s(inv.workspace_name) ?? s(root.workspaceName),
    brandName: s(wsObj.brand_name) ?? s(wsObj.brandName) ?? s(inv.brandName) ?? s(inv.brand_name),
    expiresAt: s(inv.expiresAt) ?? s(inv.expires_at),
    invitedBy: s(inv.invitedBy) ?? s(inv.invited_by_name) ?? s(inv.inviter),
  };
  const flags = {
    expired: b(inv.expired),
    accepted: b(inv.accepted),
    existingUser: b(inv.existingUser, inv.existing_user),
    signedInAsInvitee: b(inv.signedInAsInvitee, inv.signed_in_as_invitee),
  };
  for (const [k, v] of Object.entries(flags)) if (v !== undefined) (out as unknown as Record<string, boolean>)[k] = v;
  return out;
}

/**
 * 비밀번호 재설정 링크 사전 확인 — POST /api/auth/password-reset/check { token } → { valid, reason?, email?(가린 형태), expiresAt? } (team 도메인).
 * 링크를 열자마자 쓸 수 없는 링크(사용됨 · 만료 · 잘못됨)를 폼보다 먼저 알린다. 형식이 다르면 확인 불가(null)로 보고 폼을 보여 준다 — 최종 판정은 confirm.
 */
export type ResetCheckReason = 'invalid' | 'used' | 'expired';
export interface ResetCheck { valid: boolean; reason: ResetCheckReason | null; email: string | null; expiresAt: string | null }
export function normalizeResetCheck(json: unknown): ResetCheck | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (typeof o.valid !== 'boolean') return null;
  const reason = o.reason === 'invalid' || o.reason === 'used' || o.reason === 'expired' ? o.reason : null;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { valid: o.valid, reason: o.valid ? null : reason ?? 'invalid', email: s(o.email), expiresAt: s(o.expiresAt) };
}

/** 쓸 수 없는 재설정 링크 안내 (사전 확인 reason · confirm 오류 코드 reset_invalid | reset_used | reset_expired 공용) */
export function resetLinkProblem(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'used': case 'reset_used': return '이미 사용했거나 새 링크로 바뀐 재설정 링크입니다. 가장 최근 메일의 링크를 쓰거나 재설정 메일을 다시 받아 주세요.';
    case 'expired': case 'reset_expired': return '재설정 링크가 만료되었습니다. 재설정 메일을 다시 받아 주세요.';
    case 'invalid': case 'reset_invalid': return '재설정 링크가 올바르지 않습니다. 메일의 링크 전체를 열었는지 확인하거나 재설정 메일을 다시 받아 주세요.';
    default: return null;
  }
}

/** 서버 오류 문구가 한국어 안내이면 그대로 쓴다 (속도 제한 · 잠금 · 권한 · 정책 위반 등은 서버가 사유와 대기 시간을 담아 보낸다) */
export function serverKoreanMessage(e: unknown): string | null {
  return e instanceof ApiError && typeof e.message === 'string' && /[가-힣]/.test(e.message) ? e.message : null;
}

/** 서버 모드에서 Flow 시연 이력(seed_flow_*)은 적재하지 않는다 — src/modules/flow/data.ts SEED_PREFIX와 같은 값 (테스트로 고정) */
export const FLOW_SEED_PREFIX = 'seed_flow_';

/* ---------- 사용 모듈 (워크스페이스 설정 config.modules) ---------- */

/**
 * config.modules가 배열이면 그 모듈만 메뉴에 보인다(null = 제한 없음). 커맨드 센터는 항상, 워크스페이스 설정은
 * 설정 권한이 있는 사람에게 항상 보인다 — 모듈을 모두 끈 뒤 다시 켤 화면이 없어지지 않게.
 */
export function visibleModuleIds(allIds: readonly string[], config: Record<string, unknown> | null | undefined, opts: { canConfigure: boolean }): Set<string> | null {
  const mods = config?.modules;
  if (!Array.isArray(mods)) return null;
  const allow = new Set(mods.filter((x): x is string => typeof x === 'string'));
  allow.add('home');
  if (opts.canConfigure) allow.add('workspace');
  return new Set(allIds.filter((id) => allow.has(id)));
}
