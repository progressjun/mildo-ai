/**
 * 수집 배치 정제 · 데이터 품질 검사 (docs/SAAS_SPEC.md §4 data) — 결과는 ingest_runs.issues [{ code, severity, message, detail }].
 *
 * 제외(error, 해당 행을 쓰지 않음): 형식 오류(날짜 · 매체 · 숫자) · 미래 날짜 · 음수 지표
 * 정리(warning): 배치 안 중복 키 → 마지막 행만 사용
 * 경고(warning, 그대로 씀): 누락 날짜 · 클릭 > 노출 · 전환(1건 이상) > 클릭 · 광고비 0인데 클릭 > 0 ·
 *   같은 요일 평균 대비 ±80% 급변 · 네이버 SA 키워드 합계 vs 매체 합계 10% 초과 차이
 * 참고(info): 요청 기간 밖 행 제외 · 데모 키워드 표본 합계 차이
 */
import type { DateRange, NormalizedBatch } from '../connectors/types';
import { MEDIA_IDS, SALES_CHANNEL_IDS } from '@/data/constants';
import { addDaysStr, dateRange } from '../lib/time';

export type Severity = 'error' | 'warning' | 'info';
export interface QualityIssue { code: string; severity: Severity; message: string; detail?: unknown }

export const QUALITY_RULES = {
  jumpPct: 80,
  jumpMinBaselineCost: 10_000,
  jumpMinBaselineRevenue: 10_000,
  jumpMinSamples: 2,
  keywordMediaMismatchPct: 10,
  maxIssues: 60,
  maxExamples: 8,
} as const;

export interface HistoryRow { date: string; media: string; cost: number; revenue: number; conversions: number }

export interface CheckContext {
  range: DateRange;
  job: 'daily' | 'intraday' | 'backfill' | 'upload';
  today: string;
  hour: number;
  provider: string;
  /** 커넥션 기본 채널 (누락 날짜 검사 기대 채널) */
  channel: string | null;
  /** 커넥터가 수집한다고 선언한 레코드 (비어 있으면 검사 생략) */
  reads?: (keyof NormalizedBatch)[];
  /** 같은 출처의 직전 4주 매체 일별 (같은 요일 평균 비교용) */
  history?: HistoryRow[];
}

export interface CheckResult { batch: NormalizedBatch; issues: QualityIssue[]; rowsIn: number }

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const MEDIA = new Set<string>(MEDIA_IDS);
const SALES = new Set<string>(SALES_CHANNEL_IDS);

const METRICS: Record<string, string[]> = {
  mediaDaily: ['impressions', 'clicks', 'cost', 'conversions', 'revenue'],
  mediaHourly: ['impressions', 'clicks', 'cost', 'conversions', 'revenue'],
  salesDaily: ['visitors', 'detailViews', 'carts', 'orders', 'revenue'],
  keywordDaily: ['impressions', 'clicks', 'cost', 'conversions', 'revenue'],
  searchTermDaily: ['impressions', 'clicks', 'cost', 'conversions', 'revenue'],
  brandSearchDaily: ['volume'],
};
const OPTIONAL_METRICS: Record<string, string[]> = { mediaDaily: ['newCustomers'], salesDaily: ['adAttributedRevenue'] };
const KEY: Record<string, (r: any) => string> = {
  mediaDaily: (r) => `${r.date}|${r.media}`,
  mediaHourly: (r) => `${r.date}|${r.hour}|${r.media}`,
  salesDaily: (r) => `${r.date}|${r.channel}`,
  keywordDaily: (r) => `${r.date}|${r.keywordId}`,
  searchTermDaily: (r) => `${r.date}|${r.term}`,
  brandSearchDaily: (r) => `${r.date}`,
};
const LABEL: Record<string, string> = {
  mediaDaily: '매체 일별', mediaHourly: '매체 시간대', salesDaily: '판매 채널 일별', keywordDaily: '키워드 일별', searchTermDaily: '검색어 일별', brandSearchDaily: '브랜드 검색량',
};
const METRIC_LABEL: Record<string, string> = {
  impressions: '노출', clicks: '클릭', cost: '광고비', conversions: '전환', revenue: '매출', visitors: '방문자', detailViews: '상세 조회', carts: '장바구니', orders: '주문', volume: '검색량', newCustomers: '신규 고객', adAttributedRevenue: '광고 경유 매출',
};
const ROW_TABLES = Object.keys(METRICS) as (keyof typeof METRICS)[];

function weekday(d: string): number {
  return new Date(`${d}T00:00:00Z`).getUTCDay();
}

/** 배치를 정제하고 품질 이슈를 모은다. 반환 batch는 쓰기 가능한 행만 담는다(엔티티는 그대로). */
export function checkBatch(input: NormalizedBatch, c: CheckContext): CheckResult {
  const issues: QualityIssue[] = [];
  const push = (i: QualityIssue) => { if (issues.length < QUALITY_RULES.maxIssues) issues.push(i); };
  const out: NormalizedBatch = { ...input };
  let rowsIn = 0;
  const lastAllowed = c.today;
  const isUpload = c.job === 'upload';
  const isDemo = c.provider === 'demo';

  for (const t of ROW_TABLES) {
    const rows = (input as Record<string, any[] | undefined>)[t];
    if (!Array.isArray(rows)) continue;
    rowsIn += rows.length;
    const invalid: string[] = [];
    const future: string[] = [];
    const outOfRange: string[] = [];
    const negative: { key: string; field: string; value: number }[] = [];
    const kept = new Map<string, any>();
    let dups = 0;
    const dupExamples: string[] = [];
    for (const raw of rows) {
      const r = { ...raw };
      const key = KEY[t](r);
      if (!isDate(r.date)) { invalid.push(`${key} (날짜)`); continue; }
      if ((t === 'mediaDaily' || t === 'mediaHourly') && !MEDIA.has(r.media)) { invalid.push(`${key} (매체 '${r.media}')`); continue; }
      if (t === 'salesDaily' && !SALES.has(r.channel)) { invalid.push(`${key} (채널 '${r.channel}')`); continue; }
      if (t === 'mediaHourly' && !(Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23)) { invalid.push(`${key} (시간대)`); continue; }
      if (t === 'keywordDaily' && !(typeof r.keywordId === 'string' && r.keywordId)) { invalid.push(`${key} (키워드 id)`); continue; }
      if (t === 'searchTermDaily' && !(typeof r.term === 'string' && r.term.trim())) { invalid.push(`${key} (검색어)`); continue; }
      if (t === 'searchTermDaily') r.term = String(r.term).trim().slice(0, 300);
      let bad = false;
      for (const m of METRICS[t]) {
        if (r[m] === undefined || r[m] === null) r[m] = 0;
        if (typeof r[m] === 'string') r[m] = Number(r[m]);
        if (!fin(r[m])) { invalid.push(`${key} (${METRIC_LABEL[m]} 숫자 아님)`); bad = true; break; }
        if (r[m] < 0) { negative.push({ key, field: m, value: r[m] }); bad = true; break; }
      }
      if (bad) continue;
      for (const m of OPTIONAL_METRICS[t] ?? []) {
        if (r[m] === undefined || r[m] === null || !fin(Number(r[m]))) r[m] = 0;
        else if (Number(r[m]) < 0) { negative.push({ key, field: m, value: Number(r[m]) }); bad = true; break; }
      }
      if (bad) continue;
      if (r.date > lastAllowed) { future.push(key); continue; }
      if (!isUpload && (r.date < c.range.from || r.date > c.range.to)) { outOfRange.push(key); continue; }
      if (kept.has(key)) { dups++; if (dupExamples.length < QUALITY_RULES.maxExamples) dupExamples.push(key); }
      kept.set(key, r);
    }
    const label = LABEL[t];
    if (invalid.length) push({ code: 'invalid_rows', severity: 'error', message: `${label}: 형식 오류로 ${invalid.length}행을 제외했습니다`, detail: { table: t, count: invalid.length, examples: invalid.slice(0, QUALITY_RULES.maxExamples) } });
    if (future.length) push({ code: 'future_dates', severity: 'error', message: `${label}: 오늘(${c.today}) 이후 날짜 ${future.length}행을 제외했습니다`, detail: { table: t, count: future.length, examples: future.slice(0, QUALITY_RULES.maxExamples) } });
    if (negative.length) push({ code: 'negative_values', severity: 'error', message: `${label}: 음수 지표 ${negative.length}행을 제외했습니다 (예: ${negative.slice(0, 3).map((n) => `${n.key} ${METRIC_LABEL[n.field] ?? n.field} ${n.value}`).join(', ')})`, detail: { table: t, count: negative.length, examples: negative.slice(0, QUALITY_RULES.maxExamples) } });
    if (outOfRange.length) push({ code: 'out_of_range', severity: 'info', message: `${label}: 요청 기간(${c.range.from} ~ ${c.range.to}) 밖 ${outOfRange.length}행은 쓰지 않았습니다`, detail: { table: t, count: outOfRange.length, examples: outOfRange.slice(0, QUALITY_RULES.maxExamples) } });
    if (dups) push({ code: 'duplicate_keys', severity: 'warning', message: `${label}: 같은 키 행 ${dups}개가 중복돼 마지막 값만 썼습니다`, detail: { table: t, count: dups, examples: dupExamples } });
    (out as Record<string, unknown>)[t] = [...kept.values()];
  }
  for (const e of ['keywords', 'campaigns', 'accounts', 'products', 'promotions'] as const) {
    const list = input[e];
    if (!Array.isArray(list)) continue;
    rowsIn += list.length;
    const ok = list.filter((x) => x && typeof x === 'object' && (typeof (x as { id?: unknown }).id === 'string' || typeof (x as { id?: unknown }).id === 'number'));
    if (ok.length !== list.length) push({ code: 'invalid_entities', severity: 'error', message: `${e}: id가 없는 항목 ${list.length - ok.length}개를 제외했습니다` });
    // 전부 형식 오류면 '받지 못함'(undefined)으로 둔다 — 빈 배열은 웨어하우스가 '전부 사라짐'(상품 · 프로모션 삭제)으로 읽는다(warehouse/write.ts)
    if (list.length && !ok.length) { delete (out as Record<string, unknown>)[e]; continue; }
    const seen = new Map<string, unknown>();
    for (const x of ok) seen.set(String((x as { id: string }).id), x);
    (out as Record<string, unknown>)[e] = [...seen.values()];
  }

  /* ---------- 논리 검사 (경고) ---------- */
  const funnelTables = ['mediaDaily', 'mediaHourly', 'keywordDaily', 'searchTermDaily'] as const;
  for (const t of funnelTables) {
    const rows = ((out as Record<string, any[] | undefined>)[t] ?? []);
    const cgi = rows.filter((r) => r.clicks > r.impressions);
    // 1건 미만 소수 전환(기여 모델 분할 · 조회 후 전환)은 정상 범위로 본다
    const cvc = rows.filter((r) => r.conversions > r.clicks && r.conversions >= 1);
    const zc = rows.filter((r) => r.cost === 0 && r.clicks > 0);
    const ex = (list: any[]) => list.slice(0, QUALITY_RULES.maxExamples).map((r) => KEY[t](r));
    if (cgi.length) push({ code: 'clicks_gt_impressions', severity: 'warning', message: `${LABEL[t]}: 클릭이 노출보다 많은 행 ${cgi.length}개 — 집계 기준(전체 클릭 · 링크 클릭) 차이 또는 수집 오류 확인`, detail: { table: t, count: cgi.length, examples: ex(cgi) } });
    if (cvc.length) push({ code: 'conversions_gt_clicks', severity: 'warning', message: `${LABEL[t]}: 전환(1건 이상)이 클릭보다 많은 행 ${cvc.length}개 — 조회 후 전환 포함 여부 확인`, detail: { table: t, count: cvc.length, examples: ex(cvc) } });
    if (zc.length) push({ code: 'zero_cost_with_clicks', severity: 'warning', message: `${LABEL[t]}: 클릭이 있는데 광고비가 0인 행 ${zc.length}개 — 비용 열 누락 · 무료 클릭 확인`, detail: { table: t, count: zc.length, examples: ex(zc) } });
  }

  /* ---------- 누락 날짜 ---------- */
  const fullTo = c.range.to < c.today ? c.range.to : addDaysStr(c.today, -1);
  const missingFor = (t: 'mediaDaily' | 'salesDaily', field: 'media' | 'channel', expected: Set<string>) => {
    const rows = ((out as Record<string, any[] | undefined>)[t] ?? []);
    for (const ch of expected) {
      const own = rows.filter((r) => r[field] === ch).map((r) => r.date as string).sort();
      const from = isUpload ? own[0] : c.range.from;
      const to = isUpload ? own[own.length - 1] : fullTo;
      if (!from || !to || from > to) continue;
      const have = new Set(own);
      const missing = dateRange(from, to).filter((d) => !have.has(d));
      if (missing.length) push({ code: 'missing_dates', severity: 'warning', message: `${LABEL[t]} ${ch}: ${from} ~ ${to} 중 ${missing.length}일 데이터 없음 (집행 중지일이 아니면 수집 누락)`, detail: { table: t, channel: ch, count: missing.length, dates: missing.slice(0, 31) } });
    }
  };
  if (c.job !== 'intraday') {
    const mediaExpected = new Set<string>(((out.mediaDaily ?? []) as { media: string }[]).map((r) => r.media));
    if (c.channel && MEDIA.has(c.channel) && (!c.reads || c.reads.includes('mediaDaily'))) mediaExpected.add(c.channel);
    missingFor('mediaDaily', 'media', mediaExpected);
    const salesExpected = new Set<string>(((out.salesDaily ?? []) as { channel: string }[]).map((r) => r.channel));
    if (c.channel && SALES.has(c.channel) && (!c.reads || c.reads.includes('salesDaily'))) salesExpected.add(c.channel);
    missingFor('salesDaily', 'channel', salesExpected);
    if (!isUpload && c.reads?.length) {
      const any = c.reads.some((k) => Array.isArray((out as Record<string, unknown[]>)[k]) && ((out as Record<string, unknown[]>)[k]).length > 0);
      if (!any && fullTo >= c.range.from) push({ code: 'no_rows', severity: 'warning', message: `요청 기간(${c.range.from} ~ ${c.range.to})에 받은 데이터가 없습니다 — 계정 집행 여부 · 권한 확인` });
    }
  } else {
    // 당일: 지난 시간대 중 빠진 시간
    const rows = (out.mediaHourly ?? []) as { date: string; hour: number; media: string }[];
    const media = new Set(rows.filter((r) => r.date === c.today).map((r) => r.media));
    for (const m of media) {
      const hours = new Set(rows.filter((r) => r.date === c.today && r.media === m).map((r) => r.hour));
      const missing = Array.from({ length: Math.max(0, c.hour) }, (_, h) => h).filter((h) => !hours.has(h));
      if (missing.length) push({ code: 'missing_hours', severity: 'warning', message: `매체 시간대 ${m}: 오늘 ${missing.length}개 시간대 데이터 없음 (${missing.slice(0, 6).join(', ')}시${missing.length > 6 ? ' …' : ''})`, detail: { channel: m, hours: missing } });
    }
  }

  /* ---------- 같은 요일 평균 대비 급변 ---------- */
  const daily = (out.mediaDaily ?? []) as { date: string; media: string; cost: number; revenue: number; conversions: number }[];
  const all = new Map<string, { cost: number; revenue: number }>();
  for (const h of c.history ?? []) all.set(`${h.date}|${h.media}`, { cost: Number(h.cost), revenue: Number(h.revenue) });
  for (const r of daily) all.set(`${r.date}|${r.media}`, { cost: r.cost, revenue: r.revenue });
  const jumps: { date: string; media: string; metric: string; observed: number; baseline: number; deltaPct: number }[] = [];
  for (const r of daily) {
    if (r.date >= c.today) continue; // 진행 중인 오늘은 제외
    for (const metric of ['cost', 'revenue'] as const) {
      const base: number[] = [];
      for (let w = 1; w <= 4; w++) {
        const v = all.get(`${addDaysStr(r.date, -7 * w)}|${r.media}`);
        if (v) base.push(v[metric]);
      }
      if (base.length < QUALITY_RULES.jumpMinSamples) continue;
      const avg = base.reduce((a, b) => a + b, 0) / base.length;
      const min = metric === 'cost' ? QUALITY_RULES.jumpMinBaselineCost : QUALITY_RULES.jumpMinBaselineRevenue;
      if (avg < min) continue;
      const delta = ((r[metric] - avg) / avg) * 100;
      if (Math.abs(delta) > QUALITY_RULES.jumpPct) jumps.push({ date: r.date, media: r.media, metric, observed: r[metric], baseline: Math.round(avg), deltaPct: Math.round(delta) });
    }
  }
  if (jumps.length) {
    const ex = jumps.slice(0, 4).map((j) => `${j.date} ${j.media} ${METRIC_LABEL[j.metric]} ${j.deltaPct > 0 ? '+' : ''}${j.deltaPct}%`).join(', ');
    push({ code: 'day_jump', severity: 'warning', message: `같은 요일 평균(직전 4주) 대비 ±${QUALITY_RULES.jumpPct}% 넘는 급변 ${jumps.length}건 — 예: ${ex} (실제 변화인지 집계 오류인지 확인)`, detail: { threshold: QUALITY_RULES.jumpPct, items: jumps.slice(0, 20) } });
  }

  /* ---------- 네이버 SA 키워드 합계 vs 매체 합계 ---------- */
  const kw = (out.keywordDaily ?? []) as { date: string; cost: number }[];
  const sa = daily.filter((r) => r.media === 'naver_sa');
  if (kw.length && sa.length) {
    const kwByDate = new Map<string, number>();
    for (const r of kw) kwByDate.set(r.date, (kwByDate.get(r.date) ?? 0) + r.cost);
    const mismatch: { date: string; keywordCost: number; mediaCost: number; diffPct: number }[] = [];
    for (const r of sa) {
      const k = kwByDate.get(r.date);
      if (k === undefined || r.cost <= 0) continue;
      const diff = ((k - r.cost) / r.cost) * 100;
      if (Math.abs(diff) > QUALITY_RULES.keywordMediaMismatchPct) mismatch.push({ date: r.date, keywordCost: Math.round(k), mediaCost: Math.round(r.cost), diffPct: Math.round(diff * 10) / 10 });
    }
    if (mismatch.length) {
      push(isDemo
        ? { code: 'keyword_media_mismatch', severity: 'info', message: `데모 키워드는 대표 ${new Set(((out.keywords ?? []) as { id: string }[]).map((k) => k.id)).size || '일부'}개 표본이라 네이버 SA 매체 합계와 다릅니다 (${mismatch.length}일, TEST DATA)`, detail: { threshold: QUALITY_RULES.keywordMediaMismatchPct, items: mismatch.slice(0, 10) } }
        : { code: 'keyword_media_mismatch', severity: 'warning', message: `네이버 SA 키워드 광고비 합계가 매체 합계와 ${QUALITY_RULES.keywordMediaMismatchPct}% 넘게 다른 날 ${mismatch.length}일 — 쇼핑검색 · 브랜드검색 포함 여부, 키워드 수집 누락 확인`, detail: { threshold: QUALITY_RULES.keywordMediaMismatchPct, items: mismatch.slice(0, 10) } });
    }
  }

  for (const w of input.warnings ?? []) push({ code: w.code || 'connector_warning', severity: 'warning', message: String(w.message).slice(0, 500), detail: w.detail });
  return { batch: out, issues, rowsIn };
}

export function hasErrors(issues: QualityIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** 같은 요일 비교에 쓸 이력 기간 */
export function historyRange(range: DateRange): DateRange {
  return { from: addDaysStr(range.from, -28), to: addDaysStr(range.from, -1) };
}

export { weekday as _weekday };
