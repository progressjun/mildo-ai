/**
 * 카페24 OAuth 화면 쪽: 콜백 실패 코드 안내(서버 코드 목록과 같음) · 주소 정리 · 인증 시작(같은 탭 이동) · 버튼 대상 판정.
 */
import { describe, expect, it } from 'vitest';
import { awaitingApproval, OAUTH_ERROR_TEXT, oauthOf, readOAuthError, startOAuth, stripOAuthError } from './oauth';
import { OAUTH_ERROR_CODES } from '../../../server/src/connectors/oauth';
import { DEMO_CATALOG } from './demoState';

describe('콜백 실패 안내', () => {
  it('서버 콜백이 보내는 모든 코드에 한국어 안내가 있고, 남는 코드가 없다', () => {
    expect(Object.keys(OAUTH_ERROR_TEXT).sort()).toEqual([...OAUTH_ERROR_CODES].sort());
    for (const code of OAUTH_ERROR_CODES) expect(OAUTH_ERROR_TEXT[code], code).toMatch(/[가-힣]/);
  });

  it('readOAuthError: 코드별 문구, 알 수 없는 · 이상한 값은 일반 안내(주소의 문구를 그대로 쓰지 않는다), 없으면 null', () => {
    expect(readOAuthError('?oauth_error=state_expired')).toEqual({ code: 'state_expired', message: OAUTH_ERROR_TEXT.state_expired });
    expect(readOAuthError('?oauth_error=denied&x=1')!.message).toContain('승인하지 않았습니다');
    const odd = readOAuthError('?oauth_error=%3Cscript%3E')!;
    expect(odd.code).toBe('unknown');
    expect(odd.message).not.toContain('script');
    expect(readOAuthError('?oauth_error=something_new')!.message).toMatch(/다시 시작/);
    expect(readOAuthError('')).toBeNull();
    expect(readOAuthError('?invite=abc')).toBeNull();
  });

  it('stripOAuthError: oauth_error만 빼고 경로 · 다른 쿼리 · 해시(#connections)는 유지', () => {
    expect(stripOAuthError('https://app.mildo.kr/?oauth_error=state_used#connections')).toBe('/#connections');
    expect(stripOAuthError('https://app.mildo.kr/app/?a=1&oauth_error=denied#connections')).toBe('/app/?a=1#connections');
  });
});

describe('인증 시작', () => {
  it('서버가 준 https 승인 URL로 같은 탭 이동(assign) — 팝업을 열지 않는다, 이상한 응답이면 이동하지 않는다', async () => {
    const went: string[] = [];
    const url = 'https://mildomall.cafe24api.com/api/v2/oauth/authorize?response_type=code&state=s';
    await expect(startOAuth(async () => ({ url }), (u) => went.push(u))).resolves.toBe(url);
    expect(went).toEqual([url]);
    await expect(startOAuth(async () => ({ url: 'javascript:alert(1)' }), (u) => went.push(u))).rejects.toThrow(/인증 주소/);
    await expect(startOAuth(async () => { throw new Error('권한 없음'); }, (u) => went.push(u))).rejects.toThrow('권한 없음');
    expect(went).toHaveLength(1);
  });

  it('버튼 대상: 카탈로그가 oauth를 알려 준 공급자만 (데모 카탈로그에는 없음), 승인 전 = 갱신 · 액세스 토큰 없음', () => {
    const cat = [...DEMO_CATALOG.filter((p) => p.provider !== 'cafe24'), { ...DEMO_CATALOG.find((p) => p.provider === 'cafe24')!, oauth: { startLabel: '카페24 인증 시작', redirectUri: 'https://app.mildo.kr/api/oauth/cafe24/callback' } }];
    expect(oauthOf({ provider: 'cafe24' }, cat)).toEqual({ startLabel: '카페24 인증 시작', redirectUri: 'https://app.mildo.kr/api/oauth/cafe24/callback' });
    expect(oauthOf({ provider: 'coupang' }, cat)).toBeNull();
    expect(oauthOf({ provider: 'cafe24' }, DEMO_CATALOG)).toBeNull();
    expect(awaitingApproval({ credentials: { mallId: 'mildomall', clientSecret: '••••', refreshToken: null } })).toBe(true);
    expect(awaitingApproval({ credentials: { mallId: 'mildomall', refreshToken: '••••••••(16자)' } })).toBe(false);
  });
});
