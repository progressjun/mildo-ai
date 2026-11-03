/**
 * 서버 API 클라이언트 (서버 모드 전용). 같은 오리진 /api, 쿠키 세션, 쓰기 요청에 CSRF 헤더 자동.
 * 오류 응답 { error: { code, message } } → ApiError.
 *
 * 전역 오류 알림: 모든 실패는 onApiError 구독자에게 전달된다 (플랫폼이 401 → 로그인 화면, 네트워크 · 서버 오류 → 토스트).
 * 호출한 화면이 오류를 직접 보여 줄 때는 { silent: true }로 전역 토스트를 끈다(401 처리는 그대로).
 */
export class ApiError extends Error {
  /** body: 오류 응답 본문 전체 (예: 변경 요청 409 → { error, change } 서버 현재 상태) */
  constructor(public status: number, public code: string, message: string, public detail?: unknown, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  try {
    const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** FormData · 텍스트 업로드 등 원시 본문 */
  raw?: BodyInit;
  headers?: Record<string, string>;
  /** 전역 오류 토스트를 띄우지 않는다 (호출한 화면이 직접 안내) */
  silent?: boolean;
  /** 페이지를 닫는 중에도 보낸다 (fetch keepalive — 본문 64KB 이하) */
  keepalive?: boolean;
}

export interface ApiErrorEvent {
  error: ApiError;
  path: string;
  method: string;
  silent: boolean;
}

const errorListeners = new Set<(e: ApiErrorEvent) => void>();
/** 모든 API 실패를 받는다 — 해제 함수를 돌려준다 */
export function onApiError(fn: (e: ApiErrorEvent) => void): () => void {
  errorListeners.add(fn);
  return () => {
    errorListeners.delete(fn);
  };
}
function emitError(e: ApiErrorEvent): void {
  errorListeners.forEach((fn) => {
    try { fn(e); } catch { /* 구독자 오류 무시 */ }
  });
}

/**
 * api()를 거치지 않는 서버 호출(예: AI 응답 스트림 — src/ai/claude.ts가 fetch로 직접 읽는다)의 실패를 같은 전역 처리에 넘긴다.
 * 401이면 플랫폼이 로그인 화면으로 보내고 세션 만료 안내를 띄운다(context.tsx). 데모 모드에서는 구독자가 없어 아무 일도 없다.
 */
export function reportApiFailure(e: ApiErrorEvent): void {
  emitError(e);
}

/** CSRF 토큰 — 쿠키(mildo_csrf)가 기본, 로그인 응답 · /auth/me의 값으로 보강 (쿠키를 못 읽는 환경 대비) */
let csrfOverride: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfOverride = token;
}

export async function api<T = unknown>(path: string, o: ApiOptions = {}): Promise<T> {
  const method = o.method ?? (o.body !== undefined || o.raw !== undefined ? 'POST' : 'GET');
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('mildo_csrf') ?? csrfOverride;
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const fail = (err: ApiError): never => {
    emitError({ error: err, path: url, method, silent: !!o.silent });
    throw err;
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
      credentials: 'same-origin',
      signal: o.signal,
      keepalive: o.keepalive,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return fail(new ApiError(0, 'network', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요'));
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
    return fail(new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? defaultMessage(res.status), err?.detail, json));
  }
  return json as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return '로그인이 필요합니다';
  if (status === 403) return '이 작업을 할 권한이 없습니다';
  if (status === 404) return '대상을 찾을 수 없습니다';
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요';
  if (status >= 500) return '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요';
  return `요청 실패 (${status})`;
}

/** 워크스페이스 범위 경로 */
export const wsPath = (wsId: string, p: string) => `/api/w/${wsId}${p.startsWith('/') ? p : `/${p}`}`;
