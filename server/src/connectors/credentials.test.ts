/** 자격증명 암호화 · 마스킹 · 병합 */
import { describe, expect, it } from 'vitest';
import { cleanCredentials, decryptCredentials, encryptCredentials, maskedCredentials, mergeCredentials } from './credentials';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER = Buffer.alloc(32, 4).toString('base64');
const DEF = { credentialFields: [
  { key: 'customerId', label: '고객 ID', secret: false },
  { key: 'apiKey', label: 'API 키', secret: true },
  { key: 'secretKey', label: '비밀 키', secret: true, optional: true },
] };

describe('자격증명', () => {
  it('암호화 왕복, 암호문에 평문 없음, 다른 키로는 사유 있는 오류', () => {
    const enc = encryptCredentials({ customerId: '123', apiKey: 'AKIA-SECRET-VALUE' }, KEY);
    expect(enc).not.toContain('SECRET');
    expect(decryptCredentials(enc, KEY)).toEqual({ customerId: '123', apiKey: 'AKIA-SECRET-VALUE' });
    expect(() => decryptCredentials(enc, OTHER)).toThrow(/복호화하지 못했습니다/);
    expect(decryptCredentials(null, KEY)).toEqual({});
  });

  it('마스킹: 비밀 필드는 글자를 하나도 보여 주지 않고, 일반 필드는 그대로, 정의에 없는 키도 가린다', () => {
    const m = maskedCredentials(DEF, { customerId: '123', apiKey: 'AKIA-SECRET-VALUE', extra: 'zzz-hidden' });
    expect(m).toEqual({ customerId: '123', apiKey: '••••••••(17자)', secretKey: null, extra: '••••••••(10자)' });
    expect(JSON.stringify(m)).not.toMatch(/AKIA|SECRET|hidden/);
  });

  it('수정 병합: 빈 값은 기존 유지, 새 값만 교체, clear만 삭제', () => {
    const prev = { customerId: '123', apiKey: 'old', secretKey: 's' };
    expect(mergeCredentials(prev, { apiKey: '', secretKey: null, customerId: ' 456 ' })).toEqual({ customerId: '456', apiKey: 'old', secretKey: 's' });
    expect(mergeCredentials(prev, { apiKey: 'new' }, ['secretKey'])).toEqual({ customerId: '123', apiKey: 'new' });
    expect(cleanCredentials({ a: '', b: 'x', c: undefined })).toEqual({ b: 'x' });
  });
});
