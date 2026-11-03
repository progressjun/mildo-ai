/**
 * 커넥션 자격증명 — DB에는 AES-256-GCM 암호문(connections.credentials_enc)만 저장하고,
 * API 응답 · 로그 · 감사에는 마스킹 값만 내보낸다 (docs/SAAS_SPEC.md §5).
 */
import { decryptJson, encryptJson } from '../lib/crypto';
import type { ConnectorDef } from './types';

export type Credentials = Record<string, unknown>;

export function encryptCredentials(creds: Credentials, keyB64: string): string {
  return encryptJson(creds ?? {}, keyB64);
}

/** 암호문 → 자격증명 (없으면 빈 객체). 복호화 실패(키 교체 · 변조)는 사유를 담아 던진다 */
export function decryptCredentials<T = Credentials>(blob: string | null | undefined, keyB64: string): T {
  if (!blob) return {} as T;
  try {
    return decryptJson<T>(blob, keyB64);
  } catch {
    throw new Error('저장된 자격증명을 복호화하지 못했습니다 (암호화 키가 바뀌었거나 값이 손상됨) — 자격증명을 다시 입력해 주세요');
  }
}

/** 비밀 필드는 값의 어떤 글자도 보여 주지 않는다 — 저장 여부와 길이만 */
export function maskSecret(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `••••••••(${s.length}자)`;
}

/**
 * 화면용 자격증명: credentialFields의 secret=false 필드(계정 id 등)는 그대로, secret 필드와 정의에 없는 키는 마스킹.
 * 값이 없으면 null.
 */
export function maskedCredentials(def: Pick<ConnectorDef, 'credentialFields'> | null, creds: Credentials | null | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const c = creds ?? {};
  const fields = def?.credentialFields ?? [];
  for (const f of fields) {
    const v = c[f.key];
    out[f.key] = f.secret ? maskSecret(v) : v === undefined || v === null || v === '' ? null : String(v).slice(0, 120);
  }
  for (const [k, v] of Object.entries(c)) {
    if (k in out) continue;
    out[k] = maskSecret(v);
  }
  return out;
}

/**
 * 수정 요청의 자격증명 병합 — 화면은 비밀값을 다시 보내지 않으므로 빈 값('' · null · 누락)은 기존 값을 유지한다.
 * clear에 적힌 키만 지운다.
 */
export function mergeCredentials(prev: Credentials, patch: Credentials | undefined, clear: string[] = []): Credentials {
  const next: Credentials = { ...prev };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    next[k] = typeof v === 'string' ? v.trim() : v;
  }
  for (const k of clear) delete next[k];
  return next;
}

/** 빈 문자열 제거 (생성 시) */
export function cleanCredentials(c: Credentials | undefined): Credentials {
  return mergeCredentials({}, c);
}
