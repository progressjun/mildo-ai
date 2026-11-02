import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const newId = () => randomUUID();
/** URL에 넣어도 되는 랜덤 토큰 (기본 32바이트) */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** 클라이언트가 보낸 id 형식 검사 (변경 요청 · 코멘트 등 낙관적 생성용) */
export const isSafeId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_:.\-]{1,128}$/.test(s);
