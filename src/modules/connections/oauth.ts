/**
 * 카페24 OAuth 인증 코드 흐름 — 화면 쪽 (순수 · DOM 의존은 주입).
 *   시작: POST /api/w/:ws/connections/:id/oauth/cafe24/start → { url } → 같은 탭에서 window.location.assign(url) (팝업 · 새 창 아님)
 *   복귀: 서버 콜백(GET /api/oauth/cafe24/callback)이 성공하면 `${APP_URL}/#connections`, 실패하면 `${APP_URL}/?oauth_error=<코드>#connections`
 *         → 데이터 연결 화면이 코드별 한국어 안내를 보여 주고 주소에서 oauth_error를 지운다(새로고침 · 공유 시 남지 않게).
 * 코드 목록은 서버 server/src/connectors/oauth.ts OAUTH_ERROR_CODES와 같다(oauth.test.ts가 확인). URL의 임의 문구는 화면에 그대로 쓰지 않는다.
 */
import type { CatalogProvider, ConnectionView } from './model';

export const OAUTH_ERROR_TEXT: Record<string, string> = {
  state_invalid: '인증 요청 정보가 올바르지 않습니다. 커넥션 카드에서 인증을 다시 시작해 주세요',
  state_expired: '인증 요청이 만료되었습니다(10분). 커넥션 카드에서 인증을 다시 시작해 주세요',
  state_used: '이미 처리된 인증 요청입니다. 커넥션 상태를 확인하고, 필요하면 인증을 다시 시작해 주세요',
  session_mismatch: '인증을 시작한 계정과 지금 로그인한 계정이 다릅니다. 시작한 계정으로 다시 시도해 주세요',
  forbidden: '이 워크스페이스의 커넥션을 설정할 권한이 없습니다 (PM · 관리자 · 소유자)',
  connection_missing: '인증할 커넥션을 찾을 수 없습니다 (삭제되었거나 다른 워크스페이스의 커넥션)',
  credentials_missing: '쇼핑몰 ID · Client ID · Client Secret이 저장되어 있지 않습니다. 커넥션 설정에서 먼저 저장해 주세요',
  code_missing: '카페24가 인증 코드를 돌려주지 않았습니다. 인증을 다시 시작해 주세요',
  denied: '카페24 승인 화면에서 앱 권한을 승인하지 않았습니다. 다시 시작해 승인해 주세요',
  exchange_failed: '인증 코드를 토큰으로 바꾸지 못했습니다. 커넥션 카드의 마지막 오류를 확인하고 인증을 다시 시작해 주세요 (코드는 1분 안에 한 번만 쓸 수 있습니다)',
};
const UNKNOWN = '카페24 인증을 마치지 못했습니다. 인증을 다시 시작해 주세요';

/** 주소 쿼리의 oauth_error → { code, message } (없으면 null). 알 수 없는 코드는 일반 안내 */
export function readOAuthError(search: string): { code: string; message: string } | null {
  let raw: string | null = null;
  try { raw = new URLSearchParams(search).get('oauth_error'); } catch { return null; }
  if (!raw) return null;
  const code = /^[a-z_]{1,40}$/.test(raw) ? raw : 'unknown';
  return { code, message: OAUTH_ERROR_TEXT[code] ?? UNKNOWN };
}

/** oauth_error만 뺀 주소 (경로 + 나머지 쿼리 + 해시) */
export function stripOAuthError(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete('oauth_error');
    const qs = u.searchParams.toString();
    return `${u.pathname}${qs ? `?${qs}` : ''}${u.hash}`;
  } catch {
    return href;
  }
}

/** 이 커넥션 카드에 인증 시작 버튼을 둘지 — 카탈로그가 OAuth 흐름을 알려 준 공급자(서버 모드)만 */
export function oauthOf(c: Pick<ConnectionView, 'provider'>, catalog: CatalogProvider[]): CatalogProvider['oauth'] | null {
  return catalog.find((p) => p.provider === c.provider)?.oauth ?? null;
}

/** 승인(토큰) 전인지 — 마스킹된 자격증명에 갱신 · 액세스 토큰이 없으면 승인 대기 */
export function awaitingApproval(c: Pick<ConnectionView, 'credentials'>): boolean {
  return !c.credentials.refreshToken && !c.credentials.accessToken;
}

/** 인증 시작: 서버에서 승인 URL을 받아 같은 탭에서 이동 */
export async function startOAuth(start: () => Promise<{ url: string }>, assign: (url: string) => void): Promise<string> {
  const { url } = await start();
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('인증 주소를 받지 못했습니다');
  assign(url);
  return url;
}
