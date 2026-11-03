/**
 * 커넥션 자격증명 — DB에는 AES-256-GCM 암호문(connections.credentials_enc)만 저장하고,
 * API 응답 · 로그 · 감사에는 마스킹 값만 내보낸다 (docs/SAAS_SPEC.md §5).
 */
import { z } from 'zod';
import { decryptJson, encryptJson } from '../lib/crypto';
import type { ConnectorDef } from './types';
import { MALL_ID as CAFE24_MALL_ID } from './cafe24';

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

/* ---------- OAuth 인증 코드 흐름 공급자 (토큰 없이 앱 정보만 저장 → 화면의 인증 시작 버튼으로 승인) ---------- */

export interface OAuthAppSpec {
  /** 화면 버튼 · 안내 문구 */
  startLabel: string;
  /** 토큰 없이도 저장할 수 있는 앱 정보 (공급자 자격증명 스키마의 같은 필드와 같은 규칙) */
  appSchema: z.ZodType<Credentials>;
  /** 이 중 하나라도 있으면 '토큰 있음' — 그때는 공급자 스키마 전체를 그대로 적용한다 */
  tokenKeys: string[];
}

export const OAUTH_APPS: Record<string, OAuthAppSpec> = {
  cafe24: {
    startLabel: '카페24 인증 시작',
    // server/src/connectors/cafe24/index.ts credentialsSchema의 mallId · clientId · clientSecret · redirectUri와 같은 규칙
    appSchema: z.object({
      mallId: z.string().trim().transform((v) => v.toLowerCase()).pipe(z.string().regex(CAFE24_MALL_ID, '쇼핑몰 ID(mall_id)는 영문 소문자 · 숫자(가운데 하이픈 허용) 2~49자입니다')),
      clientId: z.string().trim().min(5, 'Client ID를 입력해 주세요'),
      clientSecret: z.string().trim().min(5, 'Client Secret을 입력해 주세요'),
      redirectUri: z.string().trim().url('Redirect URI는 앱에 등록한 URL 전체입니다').optional(),
    }) as unknown as z.ZodType<Credentials>,
    tokenKeys: ['refreshToken', 'authCode', 'accessToken'],
  },
};

/**
 * 공급자 자격증명 스키마가 '토큰 없음'만으로 거절한 입력을 OAuth 승인 대기 상태로 받아 줄지.
 * 조건: OAuth 공급자 · 입력에 토큰 키가 하나도 없음 · 앱 정보 스키마 통과 · 거절 사유가 전부 사용자 정의 검사(refine)
 * → 앱 정보만(정규화된 값) 돌려준다. 아니면 null (원래 오류를 그대로 보여 준다).
 */
export function oauthPendingCredentials(provider: string, input: Credentials, issues: readonly { code: string }[]): Credentials | null {
  const spec = OAUTH_APPS[provider];
  if (!spec) return null;
  if (spec.tokenKeys.some((k) => input[k] !== undefined && input[k] !== null && input[k] !== '')) return null;
  if (!issues.length || !issues.every((i) => i.code === 'custom')) return null;
  const app = spec.appSchema.safeParse(input);
  return app.success ? app.data : null;
}

/** 승인 대기 커넥션의 연결 확인 · 수집 안내 (연결 확인 결과 · 수집 실패 사유에 같은 문구) */
export function oauthApprovalMessage(def: Pick<ConnectorDef, 'provider' | 'label'>): string {
  const label = OAUTH_APPS[def.provider]?.startLabel ?? '인증 시작';
  return `${def.label} 인증이 필요합니다 — 커넥션 카드의 '${label}'으로 쇼핑몰 운영자 승인을 받은 뒤 연결 확인을 눌러 주세요`;
}

/** 저장된 자격증명에 토큰이 없고 앱 정보만 있는 OAuth 커넥션인지 (연결 확인 · 수집 전에 승인이 필요) */
export function needsOAuthApproval(provider: string, creds: Credentials): boolean {
  const spec = OAUTH_APPS[provider];
  if (!spec) return false;
  return !spec.tokenKeys.some((k) => creds[k] !== undefined && creds[k] !== null && creds[k] !== '') && spec.appSchema.safeParse(creds).success;
}
