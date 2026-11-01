/**
 * 네이버 검색광고 API 커넥터 (Pro-board 수집기용, Node 전용).
 *
 * 인증: 요청마다 X-Timestamp(ms), X-API-KEY(액세스 라이선스), X-Customer(고객 ID),
 *       X-Signature = Base64(HMAC-SHA256(secretKey, `${timestamp}.${METHOD}.${path}`))
 *
 * 환경변수: NAVER_SA_API_KEY, NAVER_SA_SECRET, NAVER_SA_CUSTOMER_ID
 * 주의: 실계정 연결 전 엔드포인트 · 필드명은 네이버 검색광고 API 문서(https://naver.github.io/searchad-apidoc/)로 확인한다.
 *       이 저장소의 앱 화면은 시연용 테스트 데이터를 쓰며, 이 커넥터로 수집한 값을 Dataset 형태로 바꿔 넣는 것이 실연동 경로다.
 */
import { createHmac } from 'node:crypto';

const BASE = 'https://api.searchad.naver.com';

export interface NaverSaCredentials {
  apiKey: string;
  secret: string;
  customerId: string;
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): NaverSaCredentials | null {
  const apiKey = env.NAVER_SA_API_KEY;
  const secret = env.NAVER_SA_SECRET;
  const customerId = env.NAVER_SA_CUSTOMER_ID;
  if (!apiKey || !secret || !customerId) return null;
  return { apiKey, secret, customerId };
}

/** 서명 생성 — 테스트 가능하도록 분리 */
export function sign(secret: string, timestamp: string, method: string, path: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${method.toUpperCase()}.${path}`).digest('base64');
}

export function authHeaders(c: NaverSaCredentials, method: string, path: string, now = Date.now()): Record<string, string> {
  const ts = String(now);
  return {
    'X-Timestamp': ts,
    'X-API-KEY': c.apiKey,
    'X-Customer': c.customerId,
    'X-Signature': sign(c.secret, ts, method, path),
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

async function call<T>(c: NaverSaCredentials, method: 'GET' | 'PUT' | 'POST', path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const res = await fetch(`${BASE}${path}${qs}`, { method, headers: authHeaders(c, method, path), body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Naver SA ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface SaCampaign { nccCampaignId: string; name: string; status?: string; dailyBudget?: number; userLock?: boolean }
export interface SaAdgroup { nccAdgroupId: string; nccCampaignId: string; name: string; status?: string; userLock?: boolean }
export interface SaKeyword { nccKeywordId: string; nccAdgroupId: string; keyword: string; bidAmt?: number; useGroupBidAmt?: boolean; userLock?: boolean; status?: string }

export const naverSa = {
  campaigns: (c: NaverSaCredentials) => call<SaCampaign[]>(c, 'GET', '/ncc/campaigns'),
  adgroups: (c: NaverSaCredentials, campaignId: string) => call<SaAdgroup[]>(c, 'GET', '/ncc/adgroups', { nccCampaignId: campaignId }),
  keywords: (c: NaverSaCredentials, adgroupId: string) => call<SaKeyword[]>(c, 'GET', '/ncc/keywords', { nccAdgroupId: adgroupId }),
  /** 비즈머니 잔액 — 계정 · 결제 P1 탐지(잔액 1일치 미만)에 사용 */
  bizmoney: (c: NaverSaCredentials) => call<{ bizmoney: number; budgetLock?: boolean; refundLock?: boolean }>(c, 'GET', '/billing/bizmoney'),
  /** 연관 키워드 · 월간 검색량 — Lab 키워드 발굴에 사용 */
  keywordTool: (c: NaverSaCredentials, hints: string[]) =>
    call<{ keywordList: { relKeyword: string; monthlyPcQcCnt: number | string; monthlyMobileQcCnt: number | string; compIdx?: string }[] }>(
      c, 'GET', '/keywordstool', { hintKeywords: hints.slice(0, 5).join(','), showDetail: '1' },
    ),
  /** 성과 통계 (ids: 캠페인/광고그룹/키워드 id 목록) */
  stats: (c: NaverSaCredentials, ids: string[], since: string, until: string) =>
    call<{ data: Record<string, unknown>[] }>(c, 'GET', '/stats', {
      ids: ids.join(','),
      fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt']),
      timeRange: JSON.stringify({ since, until }),
    }),
};

/** "120" / "< 10" 같은 검색량 표기를 숫자로 */
export function parseVolume(v: number | string): number {
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
