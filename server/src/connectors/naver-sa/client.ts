/**
 * 네이버 검색광고 API 클라이언트 — 서명 · 페이지 조회 · 통계(/stats) · 비즈머니.
 *
 * 공식 문서 (2026-11-02 확인):
 *   - API 레퍼런스(Swagger): https://naver.github.io/searchad-apidoc/ (assets/json/ncc-heroes-ncc.json · ncc-report.json · ncc-heroes-billing.json)
 *   - 서명 예제: https://github.com/naver/searchad-apidoc/blob/master/python-sample/examples/signaturehelper.py
 *       message = "{timestamp}.{METHOD}.{uri}" → HMAC-SHA256(secretKey) → Base64. uri는 쿼리 문자열 없는 경로(예: /ncc/keywords).
 *   - FAQ: https://github.com/naver/searchad-apidoc/wiki/FAQ (429 = 호출 속도 초과, 고정 한도 비공개 · X-Timestamp 오차 → 403 invalid-timestamp)
 *   - FAQ stat: https://github.com/naver/searchad-apidoc/wiki/FAQ-stat
 *       breakdown 없는 /stats는 조회 구간 92일 · 보관 2년, breakdown(hh24 등) 파워링크는 보관 7일 · 구간 7일
 *   - 릴리스 노트: https://naver.github.io/searchad-apidoc/feed.xml
 *       2025-10-27 STATS 지연 2시간 · 성과 최대 48시간 내 보정, 2026-03-30 purchaseCcnt · purchaseConvAmt, 2026-05-13 purchaseRor
 *
 * 헤더: X-Timestamp(ms) · X-API-KEY(액세스 라이선스) · X-Customer(고객 ID) · X-Signature. 기반 URL https://api.searchad.naver.com
 * 이 저장소의 scripts/naver-searchad.ts와 같은 서명 규칙이다(같은 테스트 벡터로 검증).
 */
import { createHmac } from 'node:crypto';
import type { ConnectorContext } from '../types';
import { callApi, chunk, type ApiResponse, type ErrorInfo, type HttpRequest } from './media-shared';

export const NAVER_SA_BASE = 'https://api.searchad.naver.com';
export const NAVER_SA_LABEL = '네이버 검색광고';
const PROVIDER = 'naver_sa';

export interface NaverSaCredentials { apiKey: string; secretKey: string; customerId: string }

/** 서명: Base64(HMAC-SHA256(secretKey, `${timestamp}.${METHOD}.${path}`)) */
export function signNaver(secretKey: string, timestamp: string, method: string, path: string): string {
  return createHmac('sha256', secretKey).update(`${timestamp}.${method.toUpperCase()}.${path}`).digest('base64');
}

export function naverAuthHeaders(c: NaverSaCredentials, method: string, path: string, nowMs: number): Record<string, string> {
  const ts = String(nowMs);
  return {
    'X-Timestamp': ts,
    'X-API-KEY': c.apiKey,
    'X-Customer': String(c.customerId),
    'X-Signature': signNaver(c.secretKey, ts, method, path),
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

/** 오류 본문: { type, title, detail } (FAQ 예시) 또는 { code, title, message } */
export function describeNaverError(status: number, data: unknown): ErrorInfo | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: string; title?: string; detail?: string; message?: string; code?: number | string };
  const text = [d.title, d.detail ?? d.message].filter(Boolean).join(': ');
  if (/invalid-timestamp/i.test(d.type ?? '') || /timestamp/i.test(d.title ?? '')) {
    return { kind: 'auth', code: 'invalid_timestamp', detail: `${text} — 서버 시계(NTP) 동기화를 확인해 주세요` };
  }
  if (/signature/i.test(`${d.type ?? ''} ${d.title ?? ''}`)) return { kind: 'auth', code: 'invalid_signature', detail: `${text} — 비밀키(secret key)를 확인해 주세요` };
  if (status === 429) return { kind: 'rate', code: String(d.code ?? '429'), detail: text || undefined };
  return text ? { code: d.code !== undefined ? String(d.code) : d.type, detail: text } : null;
}

/** /stats 응답 행 (요청한 fields만 들어 있다) */
export interface NaverStatRow {
  id?: string;
  dateStart?: string;
  dateEnd?: string;
  impCnt?: number;
  clkCnt?: number;
  salesAmt?: number;
  ccnt?: number;
  convAmt?: number;
  purchaseCcnt?: number | null;
  purchaseConvAmt?: number | null;
  avgRnk?: number;
  breakdowns?: (NaverStatRow & { name?: string })[];
}

export interface NaverCampaign {
  nccCampaignId: string; customerId?: number; name: string; campaignTp?: string; userLock?: boolean; status?: string; statusReason?: string;
  dailyBudget?: number; useDailyBudget?: boolean; sharedBudgetId?: string | null; sharedDailyBudget?: number | null; delFlag?: boolean;
}
export interface NaverAdgroup {
  nccAdgroupId: string; nccCampaignId: string; name: string; adgroupType?: string; bidAmt?: number; userLock?: boolean; status?: string; delFlag?: boolean;
}
export interface NaverKeyword {
  nccKeywordId: string; nccAdgroupId: string; nccCampaignId?: string; keyword: string; bidAmt?: number; useGroupBidAmt?: boolean;
  userLock?: boolean; status?: string; inspectStatus?: string; links?: unknown; delFlag?: boolean;
}
export interface NaverBizmoney { bizmoney?: number; budgetLock?: boolean; refundLock?: boolean; customerId?: number }

export const STAT_FIELDS = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt', 'purchaseCcnt', 'purchaseConvAmt'] as const;

/** /stats 응답에서 행 목록 (문서 정의 StatResponse의 dailyStatResponse · summaryStatResponse 래퍼와 data 직접 형태 모두) */
export function statRows(d: unknown): NaverStatRow[] {
  const o = (d ?? {}) as { data?: unknown; dailyStatResponse?: { data?: unknown }; summaryStatResponse?: { data?: unknown } };
  const rows = o.data ?? o.summaryStatResponse?.data ?? o.dailyStatResponse?.data;
  return Array.isArray(rows) ? (rows as NaverStatRow[]) : [];
}
/** cycleBaseTm(yyyyMMddHHmm, 최신 집계 시각) → 시 (없으면 null) */
export function cycleHour(d: unknown): number | null {
  const o = (d ?? {}) as { cycleBaseTm?: string; summaryStatResponse?: { cycleBaseTm?: string }; dailyStatResponse?: { cycleBaseTm?: string } };
  const s = o.cycleBaseTm ?? o.summaryStatResponse?.cycleBaseTm ?? o.dailyStatResponse?.cycleBaseTm;
  const m = typeof s === 'string' ? s.match(/^\d{8}(\d{2})/) : null;
  return m ? Number(m[1]) : null;
}

export class NaverSaClient {
  constructor(
    private ctx: Pick<ConnectorContext, 'http'>,
    private creds: NaverSaCredentials,
    private o: { baseUrl?: string; now?: () => number; statsChunk?: number; pageSize?: number } = {},
  ) {}

  get base(): string { return (this.o.baseUrl ?? NAVER_SA_BASE).replace(/\/$/, ''); }

  /** 서명이 붙은 요청 (path는 쿼리 없는 경로) */
  request(method: HttpRequest['method'], path: string, query?: HttpRequest['query'], body?: unknown): HttpRequest {
    return {
      method,
      url: `${this.base}${path}`,
      query,
      headers: naverAuthHeaders(this.creds, method, path, (this.o.now ?? Date.now)()),
      ...(body !== undefined ? { body, bodyType: 'json' as const } : {}),
    };
  }

  async call<T>(method: HttpRequest['method'], path: string, what: string, query?: HttpRequest['query'], body?: unknown): Promise<ApiResponse<T>> {
    return callApi<T>(this.ctx, this.request(method, path, query, body), { provider: PROVIDER, label: NAVER_SA_LABEL, what, describe: describeNaverError });
  }

  /** baseSearchId · recordSize 페이지 조회 (문서: recordSize 1~1000) */
  private async paged<T>(path: string, idKey: keyof T & string, what: string, query: Record<string, string> = {}, maxPages = 50): Promise<T[]> {
    const pageSize = this.o.pageSize ?? 1000;
    const out: T[] = [];
    const seen = new Set<string>();
    let base: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const res = await this.call<T[]>('GET', path, what, { ...query, recordSize: pageSize, ...(base ? { baseSearchId: base } : {}) });
      const rows = Array.isArray(res.data) ? res.data : [];
      let fresh = 0;
      for (const r of rows) {
        const id = String(r[idKey]);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(r);
        fresh++;
      }
      if (rows.length < pageSize || !fresh) break;
      base = String(rows[rows.length - 1][idKey]);
    }
    return out;
  }

  campaigns(): Promise<NaverCampaign[]> {
    return this.paged<NaverCampaign>('/ncc/campaigns', 'nccCampaignId', '캠페인 목록 조회');
  }
  adgroups(campaignId: string): Promise<NaverAdgroup[]> {
    return this.paged<NaverAdgroup>('/ncc/adgroups', 'nccAdgroupId', '광고그룹 목록 조회', { nccCampaignId: campaignId });
  }
  keywords(adgroupId: string): Promise<NaverKeyword[]> {
    return this.paged<NaverKeyword>('/ncc/keywords', 'nccKeywordId', '키워드 목록 조회', { nccAdgroupId: adgroupId });
  }
  async keyword(id: string): Promise<NaverKeyword> {
    return (await this.call<NaverKeyword>('GET', `/ncc/keywords/${encodeURIComponent(id)}`, '키워드 조회')).data;
  }
  async campaign(id: string): Promise<NaverCampaign> {
    return (await this.call<NaverCampaign>('GET', `/ncc/campaigns/${encodeURIComponent(id)}`, '캠페인 조회')).data;
  }
  async adgroup(id: string): Promise<NaverAdgroup> {
    return (await this.call<NaverAdgroup>('GET', `/ncc/adgroups/${encodeURIComponent(id)}`, '광고그룹 조회')).data;
  }
  async bizmoney(): Promise<NaverBizmoney> {
    return (await this.call<NaverBizmoney>('GET', '/billing/bizmoney', '비즈머니 조회')).data ?? {};
  }

  /**
   * 여러 엔티티의 기간 합계 (GET /stats?ids=…, timeIncrement 기본 allDays). breakdown='hh24'이면 행마다 breakdowns(시간대).
   * ids는 청크(기본 100개)로 나눠 부른다 — 문서에 ids 최대 개수가 없어 보수적으로 잡은 값.
   */
  async statsSummary(ids: string[], since: string, until: string, o: { breakdown?: 'hh24'; fields?: readonly string[] } = {}): Promise<{ rows: NaverStatRow[]; cycleHour: number | null }> {
    const rows: NaverStatRow[] = [];
    let hour: number | null = null;
    for (const part of chunk(ids, this.o.statsChunk ?? 100)) {
      const res = await this.call<unknown>('GET', '/stats', o.breakdown ? '시간대 통계 조회' : '통계 조회', {
        ids: part.join(','),
        fields: JSON.stringify(o.fields ?? STAT_FIELDS),
        timeRange: JSON.stringify({ since, until }),
        ...(o.breakdown ? { breakdown: o.breakdown } : {}),
      });
      rows.push(...statRows(res.data));
      hour ??= cycleHour(res.data);
    }
    return { rows, cycleHour: hour };
  }

  /** 한 엔티티의 일자별 (GET /stats?id=…&timeIncrement=1) */
  async statsDaily(id: string, since: string, until: string, fields: readonly string[] = STAT_FIELDS): Promise<NaverStatRow[]> {
    const res = await this.call<unknown>('GET', '/stats', '일자별 통계 조회', {
      id,
      fields: JSON.stringify(fields),
      timeRange: JSON.stringify({ since, until }),
      timeIncrement: '1',
    });
    return statRows(res.data);
  }

  /** 연관 키워드 도구 — 월간 검색량 (hintKeywords 최대 5개, 공백 불가) */
  async keywordTool(hints: string[]): Promise<{ relKeyword: string; monthlyPcQcCnt: number | string; monthlyMobileQcCnt: number | string }[]> {
    const res = await this.call<{ keywordList?: { relKeyword: string; monthlyPcQcCnt: number | string; monthlyMobileQcCnt: number | string }[] }>(
      'GET', '/keywordstool', '연관 키워드 조회', { hintKeywords: hints.slice(0, 5).map((h) => h.replace(/\s+/g, '')).join(','), showDetail: '1' },
    );
    return res.data?.keywordList ?? [];
  }
}

/** "< 10" 같은 검색량 표기 → 숫자 (scripts/naver-searchad.ts와 같은 규칙: 숫자만 남김, "< 10" → 10) */
export function parseVolume(v: number | string): number {
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
