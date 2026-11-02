/**
 * 서버 API 클라이언트 (서버 모드 전용). 같은 오리진 /api, 쿠키 세션, 쓰기 요청에 CSRF 헤더 자동.
 * 오류 응답 { error: { code, message } } → ApiError.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
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
}

export async function api<T = unknown>(path: string, o: ApiOptions = {}): Promise<T> {
  const method = o.method ?? (o.body !== undefined || o.raw !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('mildo_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
      method,
      headers,
      body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
      credentials: 'same-origin',
      signal: o.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요');
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `요청 실패 (${res.status})`, err?.detail);
  }
  return json as T;
}

/** 워크스페이스 범위 경로 */
export const wsPath = (wsId: string, p: string) => `/api/w/${wsId}${p.startsWith('/') ? p : `/${p}`}`;
