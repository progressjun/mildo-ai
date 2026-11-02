/** API 오류 — 응답 형식 { error: { code, message } } (message는 사용자에게 보여 줄 한국어) */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, detail?: unknown) => new HttpError(400, 'bad_request', message, detail);
export const unauthorized = (message = '로그인이 필요합니다') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = '이 작업을 할 권한이 없습니다') => new HttpError(403, 'forbidden', message);
export const notFound = (message = '대상을 찾을 수 없습니다') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, detail?: unknown) => new HttpError(409, 'conflict', message, detail);
