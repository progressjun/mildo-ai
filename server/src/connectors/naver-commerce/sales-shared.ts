/**
 * 판매 채널 커넥터 공용 도우미 — connectors-sales 도메인(naver-commerce · coupang · cafe24 · ohouse)이 함께 쓴다.
 * 파일 소유 규칙(docs/SAAS_SPEC.md §4)상 이 도메인 폴더 안에만 둘 수 있어 naver-commerce 폴더에 둔다.
 *
 *  - callSales: ConnectorHttp 호출 + 오류 정규화. data 도메인 래퍼(connectors/http.ts)는 4xx/5xx를 그대로 돌려주므로
 *    여기서 SalesApiError(한국어 메시지)로 바꾼다. 429 · 5xx 재시도는 래퍼 몫이다(여기서 다시 재시도하지 않는다).
 *  - 금액은 원 단위 정수, 날짜는 KST(YYYY-MM-DD). 주문 시각(ISO 8601, 오프셋 포함)은 KST 날짜로 바꿔 묶는다.
 *  - 판매 채널 일별(salesDaily)은 요청 기간의 모든 날짜를 채운다 — 주문이 없는 날은 0행(수집 누락과 구분).
 */
import { z } from 'zod';
import type { ConnectorContext, ConnectorHttp, DateRange, NormalizedBatch } from '../types';
import type { Promotion, SalesChannelId } from '@/core/types';
import { addDaysStr, dateRange, kstParts, kstToday } from '../../lib/time';

export type HttpRequest = Parameters<ConnectorHttp['request']>[0];
export interface ApiResponse<T> { status: number; data: T; headers: Record<string, string> }
export type ErrorKind = 'auth' | 'permission' | 'rate' | 'not_found' | 'invalid' | 'server' | 'network' | 'unknown';

export class SalesApiError extends Error {
  constructor(
    public provider: string,
    public kind: ErrorKind,
    message: string,
    public status: number | null = null,
    public code?: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'SalesApiError';
  }
}

/** 공급자별 오류 본문 해석 — kind를 정하면 HTTP 상태보다 우선한다 */
export interface ErrorInfo { kind?: ErrorKind; code?: string; detail?: string }

export interface CallOptions {
  provider: string;
  label: string;
  /** 무엇을 하던 중이었는지 (예: '주문 조회') */
  what: string;
  describe?: (status: number, data: unknown) => ErrorInfo | null;
}

const KIND_BY_STATUS = (s: number): ErrorKind =>
  s === 401 ? 'auth' : s === 403 ? 'permission' : s === 404 ? 'not_found' : s === 429 ? 'rate' : s >= 500 ? 'server' : s >= 400 ? 'invalid' : 'unknown';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 토큰 · 서명처럼 보이는 문자열을 가린다 (오류 메시지에 섞여 들어오는 경우 대비) */
export function scrub(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••')
    .replace(/(basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1••••')
    .replace(/((?:access|refresh|client)[_-]?(?:token|secret)["'=:\s]+)[A-Za-z0-9._~+/=$-]{6,}/gi, '$1••••')
    .replace(/(signature=)[0-9a-f]{16,}/gi, '$1••••')
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{22,53}/g, '••••');
}

export function errorMessage(kind: ErrorKind, label: string, what: string, status: number | null, detail?: string): string {
  const tail = detail ? ` (${clip(detail, 240)})` : '';
  switch (kind) {
    case 'auth':
      return `${label} 인증 실패 — 자격증명이 만료되었거나 올바르지 않습니다. 데이터 연결 화면에서 자격증명을 다시 확인해 주세요${tail}`;
    case 'permission':
      return `${label} 권한 없음 — API 사용 권한(그룹 · 범위) · 호출 허용 IP를 확인해 주세요 (${what})${tail}`;
    case 'rate':
      return `${label} 호출 한도 초과 — 자동 재시도 후에도 한도에 걸렸습니다. 잠시 후 다시 수집합니다 (${what})${tail}`;
    case 'not_found':
      return `${label} 대상을 찾을 수 없습니다 (${what})${tail}`;
    case 'invalid':
      return `${label} 요청 오류 (${what}, HTTP ${status ?? '—'})${tail}`;
    case 'server':
      return `${label} 서버 오류 (${what}, HTTP ${status ?? '—'}) — 잠시 후 다시 시도합니다${tail}`;
    case 'network':
      return `${label} 응답 없음 (${what})${tail}`;
    default:
      return `${label} 호출 실패 (${what}, HTTP ${status ?? '—'})${tail}`;
  }
}

/** 호출 + 오류 정규화. 2xx 밖의 응답은 SalesApiError. 래퍼가 던지는 예외 중 status를 가진 것도 응답으로 해석한다. */
export async function callSales<T>(ctx: Pick<ConnectorContext, 'http'>, req: HttpRequest, o: CallOptions): Promise<ApiResponse<T>> {
  let res: ApiResponse<unknown>;
  try {
    res = await ctx.http.request<unknown>(req);
  } catch (e) {
    const err = e as { status?: unknown; data?: unknown; message?: string; code?: string };
    if (typeof err?.status === 'number' && err.status >= 400) {
      res = { status: err.status, data: err.data ?? null, headers: {} };
    } else {
      throw new SalesApiError(o.provider, 'network', errorMessage('network', o.label, o.what, null, scrub(String(err?.message ?? e))), null, err?.code);
    }
  }
  if (res.status >= 200 && res.status < 300) {
    const info = o.describe?.(res.status, res.data);
    if (info?.kind) throw new SalesApiError(o.provider, info.kind, errorMessage(info.kind, o.label, o.what, res.status, info.detail), res.status, info.code, res.data);
    return res as ApiResponse<T>;
  }
  const info = o.describe?.(res.status, res.data) ?? null;
  const kind = info?.kind ?? KIND_BY_STATUS(res.status);
  const detail = info?.detail ?? (typeof res.data === 'string' ? res.data : undefined);
  throw new SalesApiError(o.provider, kind, errorMessage(kind, o.label, o.what, res.status, detail ? scrub(detail) : undefined), res.status, info?.code, res.data);
}

/** test() 공통 — 예외를 { ok:false, message }로 */
export async function testOutcome(fn: () => Promise<{ ok: boolean; message: string; account?: string }>): Promise<{ ok: boolean; message: string; account?: string }> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, message: e instanceof SalesApiError ? e.message : `연결 확인 실패: ${scrub(String((e as Error)?.message ?? e))}` };
  }
}

/** 자격증명 · 설정 형식 오류 (수집 전 단계) */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/* ---------------- 숫자 · 날짜 ---------------- */

/** 문자열 · 숫자 → 유한 숫자 (실패 시 0). '10000.00' · '1,000' 허용 */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
/** 원 단위 정수 */
export const krw = (v: unknown) => Math.round(num(v));

/** 'YYYYMMDD' · 'YYYY-MM-DD…' → 'YYYY-MM-DD' (해석 불가면 null) */
export function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const NO_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** ISO 8601 일시 → epoch ms. 오프셋이 없으면 KST로 본다(국내 커머스 API 관례 — 각 공급자 문서의 KST 표기). 실패 시 null */
export function parseInstant(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const withZone = NO_ZONE.test(s) ? `${s.replace(' ', 'T')}+09:00` : s;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : null;
}

/** 주문 · 결제 일시 → KST 날짜 (자정 넘김 처리: 오프셋을 반영해 KST 벽시계 날짜로) */
export function kstDateOf(v: unknown): string | null {
  const t = parseInstant(v);
  return t === null ? null : kstParts(t).date;
}

/** KST 날짜 하루의 시작 · 끝 (ISO, 밀리초 · +09:00) */
export const kstDayStart = (d: string) => `${d}T00:00:00.000+09:00`;
export const kstDayEnd = (d: string) => `${d}T23:59:59.999+09:00`;

/** 기간을 오늘(KST) 이하로 자르고 비면 null */
export function clampRange(range: DateRange, today = kstToday()): DateRange | null {
  const to = range.to > today ? today : range.to;
  return range.from > to ? null : { from: range.from, to };
}
/** 최대 maxDays일 단위로 나눈 구간들 (오래된 쪽부터) */
export function splitRange(from: string, to: string, maxDays: number): DateRange[] {
  const out: DateRange[] = [];
  for (let s = from; s <= to; s = addDaysStr(s, maxDays)) {
    const e = addDaysStr(s, maxDays - 1);
    out.push({ from: s, to: e > to ? to : e });
  }
  return out;
}

/** 엔티티 스냅샷(상품 · 프로모션)을 이번 수집에서 받을지: 당일 수집은 빼고, 어제 이후를 포함하는 구간만 (백필 앞 구간마다 반복하지 않도록) */
export function wantsSnapshot(range: DateRange, opts: { intradayDate?: string } | undefined, today = kstToday()): boolean {
  if (opts?.intradayDate) return false;
  return range.to >= addDaysStr(today, -1);
}

/* ---------------- 판매 채널 일별 합산 ---------------- */

/** 날짜별 방문 · 상세 조회 · 장바구니 · 광고 경유 매출(추정 — 채널 통계 API가 따로 줄 때만) */
export interface FunnelValues { visitors?: number; detailViews?: number; carts?: number; adRevenue?: number }

/** 날짜별 주문 수(주문번호 중복 제거) · 매출 · 광고 경유 매출 */
export class SalesAcc {
  private m = new Map<string, { orders: Set<string>; revenue: number; ad: number }>();
  add(date: string, orderId: string, revenue: number, adAttributed = 0): void {
    let e = this.m.get(date);
    if (!e) this.m.set(date, (e = { orders: new Set(), revenue: 0, ad: 0 }));
    e.orders.add(orderId);
    e.revenue += revenue;
    e.ad += adAttributed;
  }
  /** 요청 기간 전체 날짜 행 (주문 없는 날 0). funnel은 날짜별 방문 · 상세 · 장바구니 */
  rows(channel: SalesChannelId, r: DateRange, funnel?: Map<string, FunnelValues>): NonNullable<NormalizedBatch['salesDaily']> {
    return dateRange(r.from, r.to).map((date) => {
      const e = this.m.get(date);
      const f = funnel?.get(date) ?? {};
      const revenue = e ? Math.max(0, Math.round(e.revenue)) : 0;
      // 광고 경유 매출은 매출을 넘을 수 없다 (채널 통계와 주문 API의 집계 기준 차이 — Board 품질 검사 기준과 같게 매출로 자른다)
      const ad = f.adRevenue !== undefined ? Math.round(num(f.adRevenue)) : e ? Math.round(e.ad) : 0;
      return {
        date, channel,
        visitors: Math.max(0, Math.round(num(f.visitors))), detailViews: Math.max(0, Math.round(num(f.detailViews))), carts: Math.max(0, Math.round(num(f.carts))),
        orders: e ? e.orders.size : 0,
        revenue,
        adAttributedRevenue: Math.min(revenue, Math.max(0, ad)),
      };
    });
  }
  /** 기간 밖으로 떨어진 주문 (수집 창 경계 · 결제일 기준 재배치) — 행으로 쓰지 않는다 */
  outside(r: DateRange): number {
    let n = 0;
    for (const [d, e] of this.m) if (d < r.from || d > r.to) n += e.orders.size;
    return n;
  }
  get size(): number { return this.m.size; }
}

/* ---------------- 프로모션 ---------------- */

export function promotionStatus(start: string, end: string, today = kstToday()): Promotion['status'] {
  if (end < today) return 'ended';
  if (start > today) return 'planned';
  return 'live';
}

/** 상품 URL 템플릿 치환 ({id} · {productNo} 등 키를 그대로 바꾼다). 템플릿이 없으면 기본값 */
export function fillTemplate(tpl: string | undefined, vars: Record<string, string | number>, fallback = ''): string {
  if (!tpl) return fallback;
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? encodeURIComponent(String(vars[k])) : m));
}

/**
 * 상품 랜딩 URL 템플릿 설정 — https 주소만 받는다. 랜딩은 화면에서 링크(href)로 열리므로 javascript: · data: · http: 주소를 막는다
 * (zod url()은 javascript: 도 통과시킨다).
 */
export const httpsUrlTemplate = z.string().trim().max(500).refine((v) => {
  try {
    const u = new URL(v.replace(/\{(\w+)\}/g, 'x'));
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}, { message: '상품 URL 템플릿은 https:// 로 시작하는 전체 주소입니다 (예: https://brand.naver.com/mildo/products/{channelProductNo})' });

/** API 응답 · 템플릿에서 온 랜딩 주소 — https가 아니면 빈 값(링크로 쓰지 않는다) */
export function safeLanding(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password ? s : '';
  } catch {
    return '';
  }
}

/* ---------------- 경고 · 부가 수집 ---------------- */

export function warn(batch: NormalizedBatch, code: string, message: string, detail?: unknown): void {
  (batch.warnings ??= []).push(detail === undefined ? { code, message } : { code, message, detail });
}

/**
 * 부가 수집(상품 · 프로모션 · 방문 지표)을 실패해도 핵심 수집(주문 → 판매 채널 일별)은 살린다 — 실패는 경고로 남긴다.
 * 인증 실패 · 호출 한도 초과는 커넥션 전체 문제라 그대로 던진다(수집 잡이 백오프 후 재시도). allowAuth면 인증 · 권한 오류도 경고로.
 */
export async function softPart<T>(batch: NormalizedBatch, code: string, label: string, fn: () => Promise<T>, o: { allowAuth?: boolean } = {}): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SalesApiError && e.kind === 'rate') throw e;
    if (e instanceof SalesApiError && e.kind === 'auth' && !o.allowAuth) throw e;
    warn(batch, code, `${label} 수집 실패 — 주문 · 매출은 저장했습니다: ${e instanceof SalesApiError ? e.message : scrub(String((e as Error)?.message ?? e)).slice(0, 300)}`);
    return undefined;
  }
}

/** API가 방문 · 상세 조회 · 장바구니 지표를 주지 않는 채널의 경고 문구 */
export function funnelUnavailable(batch: NormalizedBatch, label: string, metrics: string[]): void {
  warn(
    batch,
    'funnel_unavailable',
    `${label} API는 ${metrics.join(' · ')} 지표를 제공하지 않아 0으로 저장했습니다 — 이 지표가 필요하면 판매 채널 일별 CSV 템플릿(sales_daily)에 같은 날짜 · 채널의 전체 지표(주문 · 매출 포함)를 담아, 우선순위를 이 커넥션보다 높게 둔 CSV 커넥션으로 올려 주세요. Dataset은 날짜 × 채널마다 우선순위가 가장 높은 출처의 행 하나를 씁니다`,
    { metrics },
  );
}

/**
 * 할인율(%)로 나타낼 수 없는 혜택(정액 쿠폰 · 사은품 · 배송비 할인 등)은 프로모션 일정에 넣지 않는다 —
 * Promotion.discountRate는 판매가 대비 %이고, Flow 점검은 0%를 '할인율 확인' 실패로 판정하므로 0으로 넣으면 거짓 경보가 된다.
 */
export function promotionsSkipped(batch: NormalizedBatch, label: string, skipped: string[]): void {
  if (!skipped.length) return;
  const shown = skipped.slice(0, 5).join(', ');
  warn(
    batch,
    'promotions_skipped',
    `${label}: 할인율(%)로 나타낼 수 없는 혜택 ${skipped.length}건(${shown}${skipped.length > 5 ? ' 외' : ''})은 프로모션 일정에 넣지 않았습니다 — 정액 · 사은품 · 배송비 혜택은 판매가 대비 할인율이 없어 Flow 할인율 대조에서 0%로 잘못 판정되기 때문입니다`,
    { count: skipped.length },
  );
}

/** 0행인 응답이 반복될 때 페이지 루프 안전장치 */
export const MAX_PAGES = 500;
