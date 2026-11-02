/**
 * 비밀번호 해시(scrypt) · 비밀값 암호화(AES-256-GCM). 외부 의존성 없음(node:crypto).
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** 비밀번호 정책: 10자 이상, 문자 종류 2가지 이상 */
export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds < 2) return '영문 대소문자 · 숫자 · 기호 중 2가지 이상을 섞어 주세요';
  return null;
}

/** 비밀값 암호화: 'v1:<iv>:<tag>:<ciphertext>' (base64) */
export function encryptSecret(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string, keyB64: string): string {
  const [v, ivB64, tagB64, dataB64] = blob.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) throw new Error('알 수 없는 암호문 형식');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
}

export const encryptJson = (obj: unknown, keyB64: string) => encryptSecret(JSON.stringify(obj), keyB64);
export const decryptJson = <T>(blob: string, keyB64: string): T => JSON.parse(decryptSecret(blob, keyB64)) as T;

/** 화면 · 로그용 마스킹: 앞 4자 + 길이 */
export function mask(s: string | null | undefined): string {
  if (!s) return '';
  if (s.length <= 6) return '••••';
  return `${s.slice(0, 4)}••••(${s.length}자)`;
}
