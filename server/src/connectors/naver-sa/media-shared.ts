/**
 * 매체 커넥터 공용 도우미 — connectors-media 도메인(naver-sa · google-ads · meta · kakao-moment · naver-gfa)이 함께 쓴다.
 * 파일 소유 규칙(docs/SAAS_SPEC.md §4)상 이 도메인 폴더 안에만 둘 수 있어 naver-sa 폴더에 둔다.
 *
 *  - callApi: ConnectorHttp 호출 + 오류 정규화. data 도메인 래퍼(connectors/http.ts)는 4xx/5xx를 그대로 돌려주고,
 *    changes 도메인의 쓰기 래퍼는 4xx/5xx에서 { status, data }를 담은 예외를 던진다 — 두 경우 모두 MediaApiError(한국어 메시지)로 바꾼다.
 *    429 · 5xx 재시도는 래퍼 몫이다(여기서는 다시 재시도하지 않는다).
 *  - 금액은 원 단위 정수, 비율은 0~1, 날짜는 KST(YYYY-MM-DD).
 *  - 반영(apply): dryRun이면 네트워크를 호출하지 않고 보낼 요청을 그대로 돌려준다. 요청 요약에는 비밀값(헤더 값 · 토큰)을 넣지 않는다.
 */
import { z } from 'zod';
import type { ApplyResult, ConnectorContext, ConnectorHttp, DateRange, NormalizedBatch } from '../types';
import type { AdAccount, ChangeRequest, IntentId } from '@/core/types';
import { addDaysStr, kstToday } from '../../lib/time';

export type HttpRequest = Parameters<ConnectorHttp['request']>[0];
export interface ApiResponse<T> { status: number; data: T; headers: Record<string, string> }

export type ErrorKind = 'auth' | 'permission' | 'rate' | 'not_found' | 'invalid' | 'server' | 'network' | 'unknown';

export class MediaApiError extends Error {
  constructor(
    public provider: string,
    public kind: ErrorKind,
    message: string,
    public status: number | null = null,
    public code?: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'MediaApiError';
  }
}

/** 공급자별 오류 본문 해석 결과 — kind를 정하면 HTTP 상태보다 우선한다 (예: Meta는 토큰 만료도 400 + code 190) */
export interface ErrorInfo { kind?: ErrorKind; code?: string; detail?: string }

export interface CallOptions {
  provider: string;
  /** 화면 표시 이름 (예: '네이버 검색광고') */
  label: string;
  /** 무엇을 하던 중이었는지 (예: '캠페인 목록 조회') */
  what: string;
  describe?: (status: number, data: unknown) => ErrorInfo | null;
}

const KIND_BY_STATUS = (s: number): ErrorKind =>
  s === 401 ? 'auth' : s === 403 ? 'permission' : s === 404 ? 'not_found' : s === 429 ? 'rate' : s >= 500 ? 'server' : s >= 400 ? 'invalid' : 'unknown';

/** 사용자에게 보여 줄 한국어 메시지 */
export function errorMessage(kind: ErrorKind, label: string, what: string, status: number | null, detail?: string): string {
  const tail = detail ? ` (${clip(detail, 240)})` : '';
  switch (kind) {
    case 'auth':
      return `${label} 인증 실패 — 자격증명이 만료되었거나 올바르지 않습니다. 데이터 연결 화면에서 자격증명을 다시 입력해 주세요${tail}`;
    case 'permission':
      return `${label} 권한 없음 — 이 계정에 대한 API 사용 권한 · 접근 권한을 확인해 주세요 (${what})${tail}`;
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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 토큰처럼 보이는 문자열을 가린다 (오류 메시지에 섞여 들어오는 경우 대비) */
export function scrub(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••')
    .replace(/((?:access|refresh|client)[_-]?(?:token|secret)["'=:\s]+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1••••')
    .replace(/(access_token=)[^&\s"]+/gi, '$1••••');
}

/**
 * 호출 + 오류 정규화. okStatuses 밖의 응답은 MediaApiError.
 * 래퍼가 던지는 예외 중 status를 가진 것(쓰기 래퍼)도 응답으로 간주해 같은 해석을 거친다.
 */
export async function callApi<T>(ctx: Pick<ConnectorContext, 'http'>, req: HttpRequest, o: CallOptions): Promise<ApiResponse<T>> {
  let res: ApiResponse<unknown>;
  try {
    res = await ctx.http.request<unknown>(req);
  } catch (e) {
    const err = e as { status?: unknown; data?: unknown; message?: string; code?: string };
    if (typeof err?.status === 'number' && err.status >= 400) {
      res = { status: err.status, data: err.data ?? null, headers: {} };
    } else {
      throw new MediaApiError(o.provider, 'network', errorMessage('network', o.label, o.what, null, scrub(String(err?.message ?? e))), null, err?.code);
    }
  }
  if (res.status >= 200 && res.status < 300) {
    const info = o.describe?.(res.status, res.data);
    // 일부 매체(Meta · 카카오)는 200 본문에 오류를 담을 수 있다
    if (info?.kind) throw new MediaApiError(o.provider, info.kind, errorMessage(info.kind, o.label, o.what, res.status, info.detail), res.status, info.code, res.data);
    return res as ApiResponse<T>;
  }
  const info = o.describe?.(res.status, res.data) ?? null;
  const kind = info?.kind ?? KIND_BY_STATUS(res.status);
  const detail = info?.detail ?? (typeof res.data === 'string' ? res.data : undefined);
  throw new MediaApiError(o.provider, kind, errorMessage(kind, o.label, o.what, res.status, detail ? scrub(detail) : undefined), res.status, info?.code, res.data);
}

/** test() 공통 — 예외를 { ok:false, message }로 */
export async function testOutcome(fn: () => Promise<{ ok: boolean; message: string; account?: string }>): Promise<{ ok: boolean; message: string; account?: string }> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, message: e instanceof MediaApiError ? e.message : `연결 확인 실패: ${scrub(String((e as Error)?.message ?? e))}` };
  }
}

/* ---------------- 숫자 · 날짜 ---------------- */

/** 문자열 · 숫자 → 유한 숫자 (실패 시 0) */
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
/** 전환수 등 소수 둘째 자리 */
export const dec2 = (v: unknown) => Math.round(num(v) * 100) / 100;
/** 0~1 비율 (범위 밖은 자른다) */
export const ratio01 = (v: unknown) => Math.min(1, Math.max(0, num(v)));

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
export const compactDate = (d: string) => d.replace(/-/g, '');
/** 'YYYYMMDD' 또는 'YYYY-MM-DD' → 'YYYY-MM-DD' (해석 불가면 null) */
export function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** '13' · '13시~14시' · '13:00:00 - 13:59:59' · 13 → 13 (0~23 아니면 null) */
export function parseHour(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 23 ? v : null;
  const m = String(v ?? '').trim().match(/^(\d{1,2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

/** 기간을 오늘(KST) 이하로 자르고 비면 null */
export function clampRange(range: DateRange, today = kstToday()): DateRange | null {
  const to = range.to > today ? today : range.to;
  return range.from > to ? null : { from: range.from, to };
}
/** 최대 maxDays일 단위로 나눈 구간들 */
export function splitRange(from: string, to: string, maxDays: number): DateRange[] {
  const out: DateRange[] = [];
  for (let s = from; s <= to; s = addDaysStr(s, maxDays)) {
    const e = addDaysStr(s, maxDays - 1);
    out.push({ from: s, to: e > to ? to : e });
  }
  return out;
}
/** from이 earliest보다 앞이면 earliest로 (남는 기간이 없으면 null) */
export function tailRange(r: DateRange, earliest: string): DateRange | null {
  const from = r.from < earliest ? earliest : r.from;
  return from > r.to ? null : { from, to: r.to };
}

export function chunk<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ---------------- 일별 · 시간대 합산 ---------------- */

export interface Funnel { impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
export const zeroFunnel = (): Funnel => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 });
export function addFunnel(a: Funnel, b: Partial<Funnel>): Funnel {
  a.impressions += num(b.impressions);
  a.clicks += num(b.clicks);
  a.cost += num(b.cost);
  a.conversions += num(b.conversions);
  a.revenue += num(b.revenue);
  return a;
}
/** 합산 결과를 표준 단위로 (원 정수 · 전환 소수 둘째 자리) */
export const finishFunnel = (f: Funnel): Funnel => ({
  impressions: Math.round(f.impressions), clicks: Math.round(f.clicks), cost: Math.round(f.cost), conversions: dec2(f.conversions), revenue: Math.round(f.revenue),
});

export class DailyAcc {
  private m = new Map<string, Funnel>();
  add(date: string, f: Partial<Funnel>): void {
    addFunnel(this.m.get(date) ?? this.m.set(date, zeroFunnel()).get(date)!, f);
  }
  rows<M extends string>(media: M): { date: string; media: M; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }[] {
    return [...this.m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, f]) => ({ date, media, ...finishFunnel(f) }));
  }
  get size(): number { return this.m.size; }
}
export class HourlyAcc {
  private m = new Map<string, Funnel>();
  add(date: string, hour: number, f: Partial<Funnel>): void {
    const k = `${date}|${String(hour).padStart(2, '0')}`;
    addFunnel(this.m.get(k) ?? this.m.set(k, zeroFunnel()).get(k)!, f);
  }
  rows<M extends string>(media: M): { date: string; hour: number; media: M; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }[] {
    return [...this.m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, f]) => {
      const [date, h] = k.split('|');
      return { date, hour: Number(h), media, ...finishFunnel(f) };
    });
  }
}

/* ---------------- 키워드 · 캠페인 판정 ---------------- */

export const intentRuleSchema = z.object({ match: z.string().min(1), intent: z.enum(['brand', 'generic', 'problem', 'compare', 'life']) });
/** 공통 설정 — 의도 분류 · 브랜드 키워드 · 최대 입찰가(안전 상한) */
export const commonSettingsShape = {
  /** 브랜드 키워드 판정어 (키워드에 포함되면 브랜드) */
  brandTerms: z.array(z.string().min(1)).default([]),
  /** 캠페인 · 광고그룹 이름 → 구매 의도 (위에서부터 첫 일치). 없으면 이름 휴리스틱 */
  intentRules: z.array(intentRuleSchema).default([]),
  /** 키워드 최대 입찰가(원) — 반영 실행기의 안전 상한. 미설정이면 현재 입찰가 × maxBidMultiplier (경고 표시) */
  maxBid: z.number().int().positive().optional(),
  maxBidMultiplier: z.number().min(1).max(10).default(2),
  /** 계정 소유 주체 표시 (예: 광고주명) */
  owner: z.string().optional(),
};

const HEURISTIC: [RegExp, IntentId][] = [
  [/브랜드|brand/i, 'brand'],
  [/비교|추천|리뷰|후기|순위|compare|review/i, 'compare'],
  [/문제|고민|해결|허리|통증|problem/i, 'problem'],
  [/생활|신혼|이사|자취|혼수|라이프|life/i, 'life'],
];

/** 캠페인 · 광고그룹 이름으로 구매 의도 분류 (설정 규칙 우선, 없으면 이름 휴리스틱, 기본 generic) */
export function inferIntent(names: (string | undefined | null)[], rules: { match: string; intent: IntentId }[] = []): IntentId {
  const texts = names.filter((s): s is string => !!s);
  for (const r of rules) if (texts.some((t) => t.toLowerCase().includes(r.match.toLowerCase()))) return r.intent;
  for (const [re, intent] of HEURISTIC) if (texts.some((t) => re.test(t))) return intent;
  return 'generic';
}
export function isBrandKeyword(text: string, intent: IntentId, brandTerms: string[]): boolean {
  if (intent === 'brand') return true;
  const t = text.replace(/\s+/g, '').toLowerCase();
  return brandTerms.some((b) => t.includes(b.replace(/\s+/g, '').toLowerCase()));
}
/** 최대 입찰가: 설정값 우선, 없으면 현재 입찰가 × 배수(10원 단위 올림, 매체 상한 이하) */
export function maxBidOf(bid: number, s: { maxBid?: number; maxBidMultiplier?: number }, platformMax: number): { value: number; derived: boolean } {
  if (s.maxBid) return { value: Math.min(s.maxBid, platformMax), derived: false };
  const v = Math.ceil((bid * (s.maxBidMultiplier ?? 2)) / 10) * 10;
  return { value: Math.min(Math.max(v, bid), platformMax), derived: true };
}

/* ---------------- 반영(apply) ---------------- */

/** ChangeRequest.after → 'on' | 'off' */
export function parseOnOff(v: unknown): 'on' | 'off' | null {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  const s = String(v ?? '').trim().toLowerCase();
  if (['on', 'enabled', 'enable', 'active', 'activated', 'true', '1', '활성', '켜기', '재개', 'resume'].includes(s)) return 'on';
  if (['off', 'paused', 'pause', 'disabled', 'disable', 'false', '0', '중지', '일시 중지', '일시중지', '끄기', 'stop'].includes(s)) return 'off';
  return null;
}
/** ChangeRequest.after → 원 단위 양의 정수 */
export function parseKrwAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,\s원]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 요약에서 뺄 비밀값 쿼리 이름 (access_token · appsecret_proof · client_secret · api_key · signature 등) — 'nccKeywordId'처럼 key가 들어간 일반 이름은 남긴다 */
export const SECRET_QUERY_KEY = /token|secret|proof|signature|password|passwd|(^|[_-])key$|^api_?key$|^apikey$/i;

/** 보낸(보낼) 요청 요약 — 비밀 헤더는 이름만 남긴다 */
export function requestSummary(req: HttpRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { method: req.method, url: req.url };
  if (req.query && Object.keys(req.query).length) out.query = Object.fromEntries(Object.entries(req.query).filter(([k]) => !SECRET_QUERY_KEY.test(k)));
  if (req.body !== undefined) out.body = req.body;
  if (req.headers) out.headers = Object.keys(req.headers);
  return { ...out, ...extra };
}

export function applyError(request: unknown, error: string): ApplyResult {
  return { ok: false, request, error };
}

/** 반영 계획의 한 단계 (dry_run 화면 · 감사에 그대로 보인다) */
export type PlannedStep = Record<string, unknown> & { method: string; url: string; note?: string };
export const step = (req: HttpRequest, note?: string, extra: Record<string, unknown> = {}): PlannedStep =>
  ({ ...requestSummary(req, extra), ...(note ? { note } : {}) }) as PlannedStep;

/**
 * 공통 반영 실행.
 *  - dryRun: 네트워크를 호출하지 않고 보낼 요청 단계(사전 확인 읽기 포함)를 그대로 돌려준다.
 *  - live: live()가 단계를 실제로 실행한다. 예외는 { ok:false, error }로 (한국어 메시지).
 */
export async function executePlan(
  ctx: ConnectorContext,
  o: {
    label: string;
    what: string;
    intended: string | number;
    steps: PlannedStep[];
    live: () => Promise<{ response?: unknown; appliedValue?: string | number; notes?: string[] }>;
  },
): Promise<ApplyResult> {
  if (ctx.dryRun) {
    ctx.log(`[dry_run] ${o.label} ${o.what}: ${o.steps.map((s) => `${s.method} ${s.url}`).join(' → ')}`);
    return { ok: true, request: { dryRun: true, what: o.what, steps: o.steps }, appliedValue: o.intended };
  }
  try {
    const r = await o.live();
    return {
      ok: true,
      request: { what: o.what, steps: o.steps, ...(r.notes?.length ? { notes: r.notes } : {}) },
      response: r.response ?? null,
      appliedValue: r.appliedValue ?? o.intended,
    };
  } catch (e) {
    return {
      ok: false,
      request: { what: o.what, steps: o.steps },
      error: e instanceof MediaApiError || e instanceof ApplyAbort ? e.message : scrub(String((e as Error)?.message ?? e)),
      response: e instanceof MediaApiError ? e.detail : undefined,
    };
  }
}

/** 반영 전 확인에서 멈춤 (현재 값이 요청 시점과 다름 · 공유 예산 등) */
export class ApplyAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyAbort';
  }
}

/**
 * 요청 시점 값(before)과 매체 현재 값이 다르면 멈춘다 — 그 사이 사람이 매체 화면에서 바꾼 값을 덮어쓰지 않기 위해.
 * before가 숫자가 아니면 검사하지 않는다.
 */
export function assertNoDrift(label: string, before: unknown, current: number | null | undefined, after: number, allowDrift = false): void {
  const b = typeof before === 'number' ? before : Number(String(before ?? '').replace(/[,\s원]/g, ''));
  if (allowDrift || !Number.isFinite(b) || b <= 0 || current === null || current === undefined) return;
  if (Math.round(current) === Math.round(after)) return; // 이미 목표 값 (재실행 · 보상 등)
  if (Math.round(current) !== Math.round(b)) {
    throw new ApplyAbort(`${label} 현재 값(${Math.round(current).toLocaleString('ko-KR')}원)이 요청 시점 값(${Math.round(b).toLocaleString('ko-KR')}원)과 다릅니다 — 매체에서 그 사이 바뀐 값이라 덮어쓰지 않았습니다. 최신 값으로 다시 검토해 주세요`);
  }
}

/** 지원하지 않는 반영 종류 */
export function unsupported(change: ChangeRequest, label: string, reason?: string): ApplyResult {
  return { ok: false, request: { kind: change.kind, targetId: change.targetId }, error: reason ?? `${label}은(는) '${change.kind}' 반영을 지원하지 않습니다` };
}

/* ---------------- 계정 ---------------- */

/** 최근 7일 평균 소진 (일별 비용 목록 → 원 정수, 데이터 없으면 0) */
export function avgDaily(costs: number[]): number {
  if (!costs.length) return 0;
  return Math.round(costs.reduce((s, x) => s + x, 0) / costs.length);
}

export function emptyAccount(partial: Partial<AdAccount> & Pick<AdAccount, 'id' | 'media' | 'name'>): AdAccount {
  return { owner: '', balance: -1, avgDailySpend: 0, autoCharge: 'postpaid', paymentMethod: '', permissions: [], status: 'active', ...partial };
}

/** 배치에 경고 추가 */
export function warn(batch: NormalizedBatch, code: string, message: string, detail?: unknown): void {
  (batch.warnings ??= []).push(detail === undefined ? { code, message } : { code, message, detail });
}

/**
 * 부가 수집 단계(키워드 · 시간대 · 검색어 · 계정 등)를 실패해도 핵심 수집(일별 · 캠페인)은 살린다 — 실패는 경고로 남긴다.
 * 인증 실패 · 호출 한도 초과는 커넥션 전체 문제라 그대로 던진다(수집 잡이 백오프 후 재시도).
 */
export async function softPart<T>(batch: NormalizedBatch, code: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MediaApiError && (e.kind === 'auth' || e.kind === 'rate')) throw e;
    warn(batch, code, `${label} 수집 실패 — 나머지 데이터는 저장했습니다: ${e instanceof MediaApiError ? e.message : scrub(String((e as Error)?.message ?? e)).slice(0, 300)}`);
    return undefined;
  }
}

/* ---------------- 테스트 지원 ---------------- */

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
/** 매체 문서의 호출 간격(예: 카카오 보고서 5초에 1회)을 지키기 위한 대기 — 테스트에서 바꾼다 */
export const pause = (ms: number) => (ms > 0 ? sleepImpl(ms) : Promise.resolve());
export function setPauseForTest(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}
