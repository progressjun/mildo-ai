/**
 * MILDO Flow 엔진 — 순수 함수 (React 없음).
 *  - 요청 · 승인 · 반영 이력(state.changes) 판정: 권한(p.53) · 상태 전이 · 실행 점검(p.15 04) · 롤백
 *  - 신규 요청 → 승인 주체 자동 결정 (GFA_DELEGATION p.15 · DECISION_MATRIX p.53 · AD Pilot SAFETY p.14)
 *  - 프로모션 체크리스트 · 오픈 전 자동 점검 (일정 · 가격 · 소재 · 랜딩 · 예산 · 재고 · 결제 잔액)
 *  - 프로모션별 리포트 (기간 vs 직전 동일 기간) → 마크다운
 *  - 감지 → 배정 → 조치 → 보고 운영 타임라인 (incidents + changes)
 * 시각: 데이터 기준 시각(generatedAt)을 '지금'으로 쓰고, 스토어가 남긴 실제 시각(…Z)은 세션 경과로 환산한다.
 */
import type {
  AdAccount, ApprovalLevel, Campaign, ChangeRequest, Dataset, Incident, Keyword, MediaId, Promotion, SalesChannelId,
} from '@/core/types';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, DECISION_MATRIX, FLOW_SEGMENTS, GFA_DELEGATION, MEDIA, MEDIA_IDS, REVIEW_RULES, SALES_CHANNEL_IDS, SALES_CHANNELS, SLA,
} from '@/data/constants';
import { monthlyPacing } from '@/core/selectors';
import { addDays, fmt, fmtDate, isOffDay, mean, parseDate, sum, weekday, WEEKDAY_KO } from '@/core/util';
import type { Brief } from '@/ai/prompts';
// 반영 단계 검증은 AD Pilot · GFA Control과 같은 함수로 (같은 요청은 어느 화면에서 반영해도 같은 결과)
import {
  adpilotProposals, gfaOverview, hourlyCostCurve, officialConfig, validateAdpilotExecution, validateGfaExecution,
  type AdPilotConfig, type AdPilotProposal, type GfaAccountView,
} from '@/modules/adpilot/engine';
// 대량 변경 실수 감지 (p.45) — MILDO Alert와 같은 기준 · 같은 이슈 id
import { activeConfig, detectBulkChange } from '@/modules/alert/engine';
import {
  CHECK_GROUPS, DEFAULT_PROMO_UPLIFT_PCT, KIND_LABEL, LEAD_RULES, MATERIAL_PCT, MODULE_LABEL, PRICE_TOLERANCE_PCT, PROMO_CHANNEL_SCOPE, PROMO_CREATIVES, REQUEST_TYPES,
  RUNWAY_TARGET_DAYS, SEED_PREFIX, STATUS_META, STATUS_ORDER, type CheckGroup, type FlowStatus, type PromoCreative, type RequestType,
} from './data';

export type ChangeInput = Omit<ChangeRequest, 'id' | 'createdAt' | 'history' | 'status'>;
export type ToMs = (iso: string) => number;

/* ================================================================== */
/* 공통: 숫자 · 시각                                                    */
/* ================================================================== */

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pad = (n: number) => String(n).padStart(2, '0');
const round = (n: number, unit: number) => Math.round(n / unit) * unit;

/** 엄격한 숫자 변환: '1,234' · '1234원' · 1234 → 1234, 그 외 문자열은 NaN */
export function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v ?? '').trim().replace(/원$/, '').replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const KST_OFFSET = 9 * 3_600_000;
function kst(ms: number) {
  const d = new Date(ms + KST_OFFSET);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
export function kstDateOf(ms: number): string {
  if (!finite(ms)) return '';
  const k = kst(ms);
  return `${k.y}-${pad(k.mo)}-${pad(k.d)}`;
}
export function kstHourOf(ms: number): number {
  if (!finite(ms)) return NaN;
  const k = kst(ms);
  return k.h + k.mi / 60;
}
export function kstIso(date: string, h: number, m = 0): string {
  return `${date}T${pad(h)}:${pad(m)}:00+09:00`;
}
export function msToKstIso(ms: number): string {
  if (!finite(ms)) return '';
  const k = kst(ms);
  return `${k.y}-${pad(k.mo)}-${pad(k.d)}T${pad(k.h)}:${pad(k.mi)}:${pad(k.s)}+09:00`;
}
/** 'M/D(요일) HH:MM' (KST) */
export function fmtStamp(ms: number, withDate = true): string {
  if (!finite(ms)) return '—';
  const k = kst(ms);
  const date = `${k.y}-${pad(k.mo)}-${pad(k.d)}`;
  return `${withDate ? `${k.mo}/${k.d}(${WEEKDAY_KO[weekday(date)]}) ` : ''}${pad(k.h)}:${pad(k.mi)}`;
}
export function fmtDuration(min: number): string {
  if (!finite(min)) return '—';
  const m = Math.max(0, Math.round(min));
  if (m < 1) return '1분 미만';
  if (m < 60) return `${m}분`;
  if (m < 1440) return `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return `${d}일${h ? ` ${h}시간` : ''}`;
}
/** 시 (소수) → 'HH:MM' */
export function fmtHour(h: number | null | undefined): string {
  if (h === null || h === undefined || !finite(h)) return '—';
  const total = Math.round(h * 60);
  if (total >= 24 * 60) return '24:00';
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** ISO → 데이터 시계 ms. '…Z'(스토어 nowIso 실제 시각)는 데이터 기준 시각 + 세션 경과로 환산 */
export function toRefMs(iso: string | undefined, generatedAt: string, anchorMs: number): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  if (!finite(t)) return NaN;
  if (iso.endsWith('Z')) {
    const g = Date.parse(generatedAt);
    return finite(g) && finite(anchorMs) ? g + (t - anchorMs) : t;
  }
  return t;
}
export function refNowMs(generatedAt: string, anchorMs: number, realNowMs: number): number {
  const g = Date.parse(generatedAt);
  return finite(g) ? g + Math.max(0, realNowMs - anchorMs) : realNowMs;
}
export function daysBetween(a: string, b: string): number {
  if (!a || !b) return NaN;
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}
export function nextBusinessDay(date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 14 && isOffDay(d).off; i++) d = addDays(d, 1);
  return d;
}

/* ================================================================== */
/* 권한 (p.53 · 스펙: AE는 AE건, PM은 AE · PM건, 수면밀도는 전부)           */
/* ================================================================== */

export type Role = '담당 AE' | 'PM' | '수면밀도';
export const ROLE_SCOPE: Record<string, ApprovalLevel[]> = { '담당 AE': ['AE'], PM: ['AE', 'PM'], '수면밀도': ['AE', 'PM', 'CLIENT'] };
export const APPROVER_LABEL: Record<ApprovalLevel, string> = { AE: '담당 AE', PM: 'PM', CLIENT: '수면밀도' };

export function canAct(role: string, approver: ApprovalLevel): { ok: boolean; reason: string } {
  const scope = ROLE_SCOPE[role] ?? [];
  if (scope.includes(approver)) return { ok: true, reason: `${role} 승인 범위 (${scope.map((a) => APPROVER_LABEL[a]).join(' · ')} 건)` };
  return { ok: false, reason: `${APPROVER_LABEL[approver]} 승인 건 · 현재 역할 ${role || '미지정'}의 범위는 ${scope.length ? scope.map((a) => APPROVER_LABEL[a]).join(' · ') : '없음'}` };
}
export function roleScopeLabel(role: string): string {
  const s = ROLE_SCOPE[role] ?? [];
  return s.length ? s.map((a) => APPROVER_LABEL[a]).join(' · ') : '없음';
}

/* ================================================================== */
/* 변경 요청 공통                                                       */
/* ================================================================== */

export const isSeed = (c: Pick<ChangeRequest, 'id'>) => c.id.startsWith(SEED_PREFIX);
export const isOpenStatus = (s: FlowStatus) => s === 'pending' || s === 'approved' || s === 'held';
export const moduleLabel = (m: string) => MODULE_LABEL[m] ?? m;
export const kindLabel = (k: ChangeRequest['kind']) => KIND_LABEL[k] ?? k;

function lastHistory(c: ChangeRequest, re: RegExp) {
  return [...(c.history ?? [])].reverse().find((h) => re.test(h.action));
}
function firstHistory(c: ChangeRequest, re: RegExp) {
  return (c.history ?? []).find((h) => re.test(h.action));
}
/** p.53 소요 판정의 '결정' = 승인 · 반려 (보류는 결정 유예라 대기 시간이 계속 흐른다) */
const DECISION_RE = /^(일괄 )?(승인|반려)$/;
/** 반영 시각: '반영' · '일괄 반영' · '실행 · 반영' · '재실행 · 반영' (AD Pilot의 '반영 보류'는 제외) */
const APPLY_RE = /반영(?!\s*보류)/;

export function appliedIso(c: ChangeRequest): string {
  return lastHistory(c, APPLY_RE)?.at ?? c.createdAt ?? '';
}

/** 변경 값 표기 */
export function fmtValue(c: Pick<ChangeRequest, 'kind'>, v: string | number): string {
  const n = toNum(v);
  if ((c.kind === 'bid' || c.kind === 'budget' || c.kind === 'gfa') && finite(n)) return fmt.won(n);
  if (typeof v === 'number') return fmt.won(v);
  if (v === 'on') return 'ON';
  if (v === 'off') return 'OFF';
  return String(v ?? '—');
}

/* ---------- 대상 · 매체 해석 ---------- */

export function keywordOfChange(data: Dataset, c: Pick<ChangeRequest, 'targetId'>): Keyword | undefined {
  const m = (c.targetId ?? '').match(/kw_\d+/);
  return m ? data?.keywords?.find((k) => k.id === m[0]) : undefined;
}
export function campaignOfChange(data: Dataset, c: Pick<ChangeRequest, 'targetId'>): Campaign | undefined {
  const m = (c.targetId ?? '').match(/cmp_\d+/);
  return m ? data?.campaigns?.find((x) => x.id === m[0]) : undefined;
}
export function accountOfChange(data: Dataset, c: Pick<ChangeRequest, 'targetId'>): AdAccount | undefined {
  const m = (c.targetId ?? '').match(/acc_[a-z]+/);
  return m ? data?.accounts?.find((a) => a.id === m[0]) : undefined;
}
export function mediaOfChange(data: Dataset, c: Pick<ChangeRequest, 'targetId' | 'module'>): MediaId | SalesChannelId | null {
  if (keywordOfChange(data, c)) return 'naver_sa';
  const cmp = campaignOfChange(data, c);
  if (cmp) return cmp.media;
  const acc = accountOfChange(data, c);
  if (acc) return acc.media;
  const nm = (c.targetId ?? '').match(/^flow:new:([a-z_]+):/);
  if (nm && (MEDIA_IDS as string[]).includes(nm[1])) return nm[1] as MediaId;
  if (c.module === 'gfa') return 'naver_gfa';
  return null;
}
export function mediaName(m: MediaId | SalesChannelId | null | undefined): string {
  if (!m) return '—';
  if (m in MEDIA) return MEDIA[m as MediaId].name;
  if (m in SALES_CHANNELS) return SALES_CHANNELS[m as SalesChannelId].name;
  return m;
}

/** 지출을 늘리는 변경인지 (증액 · 입찰 상향 · ON · 신규 캠페인) */
export function isSpendIncrease(c: Pick<ChangeRequest, 'kind' | 'before' | 'after' | 'targetId'>): boolean {
  if (c.kind === 'bid' || c.kind === 'budget') {
    const b = toNum(c.before), a = toNum(c.after);
    return finite(a) && finite(b) ? a > b : false;
  }
  if (c.kind === 'status') return String(c.after) === 'on';
  if (c.kind === 'gfa') return true;
  return (c.targetId ?? '').startsWith('flow:new:');
}

/* ---------- 반영 상태 (state.changes → 현재 값) ---------- */

function appliedSorted(changes: readonly ChangeRequest[]) {
  return (changes ?? []).filter((c) => c.status === 'applied').sort((a, b) => appliedIso(a).localeCompare(appliedIso(b)));
}
/** 반영된 입찰 변경 반영 후 입찰가 (AD Pilot effectiveBids와 같은 규칙: module adpilot · kind bid · targetId = keyword id) */
export function effectiveBid(k: Keyword, changes: readonly ChangeRequest[]): number {
  let bid = k.bid;
  for (const c of appliedSorted(changes)) {
    if (c.module === 'adpilot' && c.kind === 'bid' && c.targetId === k.id) {
      const v = toNum(c.after);
      if (finite(v) && v > 0) bid = v;
    }
  }
  return bid;
}
/** MILDO Alert 이슈 드로어의 키워드 일시 중지 요청 (targetId 'alert:<이슈>:pause', 대상 '<키워드> 키워드') */
const isAlertKeywordPause = (c: ChangeRequest, k: Keyword) =>
  c.module === 'alert' && /^alert:.+:pause$/.test(c.targetId ?? '') && c.target === `${k.text} 키워드`;
export function effectiveKeywordStatus(k: Keyword, changes: readonly ChangeRequest[]): 'on' | 'off' | 'test' {
  let st: 'on' | 'off' | 'test' = k.status;
  for (const c of appliedSorted(changes)) {
    if (c.kind !== 'status') continue;
    if ((c.module === 'adpilot' && c.targetId === k.id) || isAlertKeywordPause(c, k)) st = String(c.after) === 'off' ? 'off' : k.status === 'test' ? 'test' : 'on';
  }
  return st;
}
/** 반영된 일 예산 (AD Pilot 재배분 budget:recv:donor · GFA gfa:budget:id · Flow flow:budget:id) */
export function effectiveBudget(cmp: Campaign, changes: readonly ChangeRequest[]): number {
  let budget = cmp.dailyBudget;
  for (const c of appliedSorted(changes)) {
    if (c.kind !== 'budget') continue;
    const tid = c.targetId ?? '';
    const a = toNum(c.after), b = toNum(c.before);
    if (tid === `gfa:budget:${cmp.id}` || tid === `flow:budget:${cmp.id}`) {
      if (finite(a) && a >= 0) budget = a;
    } else if (tid.startsWith('budget:')) {
      const [, recv, donor] = tid.split(':');
      if (recv === cmp.id && finite(a) && a >= 0) budget = a;
      else if (donor && donor === cmp.id && finite(a) && finite(b)) budget = Math.max(0, budget - (a - b));
    }
  }
  return budget;
}
export function topupTargetId(acc: Pick<AdAccount, 'id'>) {
  return `alert:account:${acc.id}:topup`;
}
/** 이 계정의 충전 요청인지 — MILDO Alert 계정 점검('alert:account:<계정>:topup')과 이슈 드로어('alert:<이슈>:topup', 대상 '<계정명> …') 두 형식 */
export function isTopupFor(acc: Pick<AdAccount, 'id' | 'name'>, c: Pick<ChangeRequest, 'targetId' | 'target'>): boolean {
  const tid = c.targetId ?? '';
  if (tid === topupTargetId(acc)) return true;
  return /^alert:.+:topup$/.test(tid) && !tid.startsWith('alert:account:') && (c.target ?? '').startsWith(`${acc.name} `);
}
/** 반영된 충전 요청 반영 후 잔액 (MILDO Alert 충전 요청과 같은 targetId) */
export function effectiveBalance(acc: AdAccount, changes: readonly ChangeRequest[]): number {
  let bal = acc.balance;
  for (const c of appliedSorted(changes)) {
    if (isTopupFor(acc, c)) {
      const v = toNum(c.after);
      if (finite(v)) bal = v;
    }
  }
  return bal;
}
export function runwayOf(acc: AdAccount, changes: readonly ChangeRequest[] = []): number {
  if (acc.balance < 0) return Infinity; // 후불
  const bal = effectiveBalance(acc, changes);
  return acc.avgDailySpend > 0 ? bal / acc.avgDailySpend : Infinity;
}
export const AUTO_CHARGE_LABEL: Record<AdAccount['autoCharge'], string> = { ok: '정상', failed: '실패', off: '미사용', postpaid: '후불' };
export const ACCOUNT_STATUS_LABEL: Record<AdAccount['status'], string> = { active: '정상', review: '검수 · 확인 필요', restricted: '제재' };

/* ================================================================== */
/* 데이터 이상 가드 (전환 추적 단절 p.45 · 데이터 급변 p.44)                  */
/* ================================================================== */

export interface DataGuard {
  media: MediaId;
  kind: 'tracking_break' | 'spend_spike';
  label: string;
  basis: string;
  observed: number;
  baseline: number;
}

const guardCache = new WeakMap<Dataset, DataGuard[]>();
export function dataGuards(data: Dataset): DataGuard[] {
  if (!data?.mediaHourly?.length) return [];
  const hit = guardCache.get(data);
  if (hit) return hit;
  const idx = new Map<string, Dataset['mediaHourly'][number]>();
  for (const r of data.mediaHourly) idx.set(`${r.date}|${r.media}|${r.hour}`, r);
  const H = Math.max(0, Math.min(23, Math.round(data.currentHour)));
  const out: DataGuard[] = [];
  const costDanger = ANOMALY_THRESHOLDS.find((t) => t.metric === 'cost')?.dangerPct ?? 50;
  for (const m of MEDIA_IDS) {
    // 전환 추적 단절: 현재 시각까지 연속으로 클릭 > 0 · 전환 0
    let streak = 0;
    let clicks = 0;
    for (let h = H; h >= 0; h--) {
      const r = idx.get(`${data.today}|${m}|${h}`);
      if (r && r.clicks > 0 && r.conversions === 0) { streak++; clicks += r.clicks; } else break;
    }
    if (streak >= 2) {
      const hours = Array.from({ length: streak }, (_, i) => H - i);
      const base = [];
      for (let d = 1; d <= 7; d++) {
        const date = addDays(data.today, -d);
        const rows = hours.map((h) => idx.get(`${date}|${m}|${h}`)).filter(Boolean) as Dataset['mediaHourly'];
        if (rows.length) base.push(sum(rows, (r) => r.conversions));
      }
      const expected = base.length ? mean(base) : 0;
      if (streak >= 3 || expected >= 0.5) {
        out.push({
          media: m, kind: 'tracking_break', label: '전환 추적 단절 의심',
          basis: `오늘 ${H - streak + 1}~${H}시 전환 0 · 클릭 ${fmt.int(clicks)} (최근 7일 같은 시간 평균 전환 ${expected.toFixed(1)}건)`,
          observed: 0, baseline: expected,
        });
      }
    }
    // 데이터 급변: 최근 2시간 광고비 vs 최근 4주 같은 요일 · 같은 시간 평균 (p.44 · p.47 기준 ±50%, 증감 양방향)
    const hrs = [H - 1, H].filter((h) => h >= 0);
    const now = sum(hrs, (h) => idx.get(`${data.today}|${m}|${h}`)?.cost ?? 0);
    const prev: number[] = [];
    for (let w = 1; w <= 4; w++) {
      const date = addDays(data.today, -7 * w);
      const rows = hrs.map((h) => idx.get(`${date}|${m}|${h}`)).filter(Boolean) as Dataset['mediaHourly'];
      if (rows.length === hrs.length) prev.push(sum(rows, (r) => r.cost));
    }
    const base = prev.length ? mean(prev) : NaN;
    if (finite(base) && base >= 10_000) {
      const pct = (now / base - 1) * 100;
      if (Math.abs(pct) >= costDanger) {
        out.push({
          media: m, kind: 'spend_spike', label: '광고비 급변',
          basis: `오늘 ${hrs[0]}~${H}시 광고비 ${fmt.krw(now)} · 동요일 · 동시간 평균 ${fmt.krw(base)} 대비 ${fmt.delta(pct, 0)} (기준 ±${costDanger}%)`,
          observed: now, baseline: base,
        });
      }
    }
  }
  guardCache.set(data, out);
  return out;
}

/** 데이터 가드 + 열린 MILDO Alert 이슈 (전환 추적 단절 · 데이터 급변) */
export function guardsFor(data: Dataset, incidents: readonly Incident[], media: MediaId | SalesChannelId | null): { kind: DataGuard['kind']; basis: string; source: string }[] {
  if (!media) return [];
  const out: { kind: DataGuard['kind']; basis: string; source: string }[] = [];
  for (const g of dataGuards(data)) if (g.media === media) out.push({ kind: g.kind, basis: g.basis, source: 'MILDO Flow 실행 점검' });
  for (const i of incidents ?? []) {
    if (i.status === 'resolved' || i.media !== media) continue;
    if (/tracking/.test(i.ruleId) && !out.some((o) => o.kind === 'tracking_break')) out.push({ kind: 'tracking_break', basis: i.title, source: `MILDO Alert ${i.severity}` });
    if (/data_spike/.test(i.ruleId) && !out.some((o) => o.kind === 'spend_spike')) out.push({ kind: 'spend_spike', basis: i.title, source: `MILDO Alert ${i.severity}` });
  }
  return out;
}

/* ================================================================== */
/* 일 예산 페이스 (시간대 가중 · 최근 28일 소진 곡선)                         */
/* ================================================================== */

const curveCache = new WeakMap<Dataset, Map<string, { cum: number[]; peak: number }>>();
/**
 * 매체별 시간대 누적 광고비 비중(0~23시 종료 시점) + 매출 비중 최대 시간.
 * 누적 곡선은 AD Pilot · Board · Alert · 커맨드 센터와 같은 함수(최근 28일 hourlyCostCurve)를 쓴다 — 예상 마감 시각이 화면마다 같아야 한다.
 */
export function hourProfile(data: Dataset, media: MediaId): { cum: number[]; peak: number } {
  let byData = curveCache.get(data);
  if (!byData) { byData = new Map(); curveCache.set(data, byData); }
  const hit = byData.get(media);
  if (hit) return hit;
  const rev = new Array(24).fill(0);
  const from = addDays(data.today, -28);
  for (const r of data.mediaHourly ?? []) {
    if (r.media !== media || r.date >= data.today || r.date < from || !(r.hour >= 0 && r.hour <= 23)) continue;
    rev[r.hour] += finite(r.revenue) ? r.revenue : 0;
  }
  const cum = data.mediaHourly?.length ? hourlyCostCurve(data, media, 28) : Array.from({ length: 24 }, (_, h) => (h + 1) / 24);
  const maxRev = Math.max(...rev);
  const peak = maxRev > 0 ? rev.indexOf(maxRev) : 21;
  const out = { cum, peak };
  byData.set(media, out);
  return out;
}

export interface Pace {
  campaign: Campaign;
  budget: number;
  spent: number;
  projected: number;
  ratio: number;
  exhaustHour: number | null;
  peakHour: number;
  level: 'before_peak' | 'before_midnight' | 'ok' | 'off';
  basis: string;
}
export function paceCampaign(data: Dataset, c: Campaign, changes: readonly ChangeRequest[] = [], budgetOverride?: number): Pace {
  const budget = finite(budgetOverride) ? budgetOverride : effectiveBudget(c, changes);
  const { cum, peak } = hourProfile(data, c.media);
  const H = Math.max(0, Math.min(23, Math.round(c.hourOfData ?? data.currentHour)));
  const share = cum[H] ?? (H + 1) / 24;
  const projected = share > 0 ? c.spentToday / share : c.spentToday;
  const ratio = budget > 0 ? projected / budget : NaN;
  if (c.status === 'off' || !(budget > 0)) {
    return { campaign: c, budget, spent: c.spentToday, projected, ratio, exhaustHour: null, peakHour: peak, level: 'off', basis: c.status === 'off' ? '캠페인 OFF' : '일 예산 없음' };
  }
  let exhaustHour: number | null = null;
  if (ratio > 1) {
    if (c.spentToday >= budget) exhaustHour = H + 1;
    else {
      const f = budget / projected;
      const h = cum.findIndex((v) => v >= f);
      if (h >= 0) {
        const prev = h > 0 ? cum[h - 1] : 0;
        exhaustHour = h + (cum[h] - prev > 0 ? (f - prev) / (cum[h] - prev) : 0);
      }
    }
  }
  const level: Pace['level'] = exhaustHour === null ? 'ok' : exhaustHour < peak ? 'before_peak' : 'before_midnight';
  const basis = exhaustHour === null
    ? `예상 소진 ${fmt.ratio(ratio, 0)} · 일 예산 내`
    : `소진 ${fmt.ratio(c.spentToday / budget, 0)} (${H}시 기준) · 시간대 가중 예상 마감 ${fmtHour(exhaustHour)} · 매출 피크 ${peak}시${level === 'before_peak' ? ' 전' : ' 이후'}`;
  return { campaign: c, budget, spent: c.spentToday, projected, ratio, exhaustHour, peakHour: peak, level, basis };
}

/* ================================================================== */
/* 결정 유형 · 리드타임 (p.53)                                           */
/* ================================================================== */

export function decisionIndexOf(c: Pick<ChangeRequest, 'kind' | 'approver' | 'targetId' | 'target'>): number {
  if (c.kind === 'alert_rule') return 2;
  if ((c.targetId ?? '').startsWith('flow:strategy') || /전략 방향/.test(c.target ?? '')) return 3;
  if (c.approver === 'AE') return 0;
  return 1;
}
export function decisionOf(c: Pick<ChangeRequest, 'kind' | 'approver' | 'targetId' | 'target'>) {
  const index = decisionIndexOf(c);
  const row = DECISION_MATRIX[index];
  // p.53 '예산 · 구조 변경'은 PM 제안 → 수면밀도 승인이지만, p.15 위임 범위(±10~30% · ON/OFF) 안의 건은 PM이 결정한다
  const delegated = index === 1 && c.approver === 'PM'
    ? 'p.15 위임 범위(일 예산 ±10~30% · 광고그룹 ON/OFF) 안이라 PM이 결정 — 범위 밖은 수면밀도 승인'
    : null;
  return { index, row, rule: LEAD_RULES[row.lead] ?? LEAD_RULES['당일'], delegated };
}
export function leadDeadlineMs(c: Pick<ChangeRequest, 'kind' | 'approver' | 'targetId' | 'target'>, createdMs: number): number {
  if (!finite(createdMs)) return NaN;
  const { rule } = decisionOf(c);
  if (rule.minutes) return createdMs + rule.minutes * 60_000;
  const date = kstDateOf(createdMs);
  const hour = kstHourOf(createdMs);
  const endHour = rule.endHour ?? 17;
  const day = isOffDay(date).off || hour >= endHour ? nextBusinessDay(date) : date;
  return Date.parse(kstIso(day, endHour));
}

export interface LeadState {
  createdMs: number;
  decidedMs: number | null;
  elapsedMin: number;
  deadlineMs: number;
  overdue: boolean;
  met: boolean | null;
  label: string;
  text: string;
}
export function leadState(c: ChangeRequest, nowMs: number, toMs: ToMs): LeadState {
  const createdMs = toMs(c.createdAt);
  const dec = firstHistory(c, DECISION_RE);
  const decidedMs = dec ? toMs(dec.at) : null;
  const deadlineMs = leadDeadlineMs(c, createdMs);
  const { rule } = decisionOf(c);
  if (decidedMs !== null && finite(decidedMs)) {
    const elapsedMin = (decidedMs - createdMs) / 60_000;
    const met = finite(deadlineMs) ? decidedMs <= deadlineMs : null;
    return { createdMs, decidedMs, elapsedMin, deadlineMs, overdue: false, met, label: rule.label, text: `결정 ${fmtDuration(elapsedMin)} · 기준 ${rule.label}${met === null ? '' : met ? ' 충족' : ' 초과'}` };
  }
  const open = c.status === 'pending' || c.status === 'held';
  const elapsedMin = finite(nowMs) && finite(createdMs) ? (nowMs - createdMs) / 60_000 : NaN;
  const overdue = open && finite(deadlineMs) && finite(nowMs) && nowMs > deadlineMs;
  return {
    createdMs, decidedMs: null, elapsedMin, deadlineMs, overdue, met: null, label: rule.label,
    text: open ? `대기 ${fmtDuration(elapsedMin)} · 기준 ${rule.label}${overdue ? ' 초과' : ` (마감 ${fmtStamp(deadlineMs)})`}` : `기준 ${rule.label}`,
  };
}

/* ================================================================== */
/* 상태 전이 · 액션                                                      */
/* ================================================================== */

export type FlowAction = 'approve' | 'reject' | 'hold' | 'resume' | 'apply' | 'rollback' | 'cancel';
export const ACTION_META: Record<FlowAction, { label: string; icon: string; needsNote: boolean; confirm: boolean; variant: 'primary' | 'default' | 'danger' | 'accent' }> = {
  approve: { label: '승인', icon: 'check', needsNote: false, confirm: false, variant: 'primary' },
  apply: { label: '반영', icon: 'zap', needsNote: false, confirm: false, variant: 'accent' },
  reject: { label: '반려', icon: 'x', needsNote: true, confirm: true, variant: 'default' },
  hold: { label: '보류', icon: 'pause', needsNote: true, confirm: false, variant: 'default' },
  resume: { label: '보류 해제', icon: 'play', needsNote: false, confirm: false, variant: 'default' },
  rollback: { label: '롤백', icon: 'rollback', needsNote: false, confirm: true, variant: 'danger' },
  cancel: { label: '실행 취소', icon: 'stop', needsNote: true, confirm: true, variant: 'default' },
};

export function wasApproved(c: ChangeRequest): boolean {
  return (c.history ?? []).some((h) => /^(일괄 )?승인$/.test(h.action));
}
export function nextStatus(c: ChangeRequest, a: FlowAction): FlowStatus {
  switch (a) {
    case 'approve': return 'approved';
    case 'reject': case 'cancel': return 'rejected';
    case 'hold': return 'held';
    case 'resume': return wasApproved(c) ? 'approved' : 'pending';
    case 'apply': return 'applied';
    case 'rollback': return 'rolled_back';
  }
}

/** 롤백 가능: 반영 상태이며 같은 대상 · 같은 유형의 가장 최근 반영 건일 때 (직전 상태로만 복원) */
export function canRollback(changes: readonly ChangeRequest[], c: ChangeRequest): { ok: boolean; reason: string } {
  if (c.status !== 'applied') return { ok: false, reason: '반영된 건만 롤백할 수 있습니다' };
  const later = (changes ?? []).filter((x) => x.id !== c.id && x.module === c.module && x.targetId === c.targetId && x.kind === c.kind && x.status === 'applied' && appliedIso(x) > appliedIso(c));
  if (later.length) return { ok: false, reason: `이후 반영된 변경 ${later.length}건이 있어 최신 건부터 롤백해야 합니다` };
  return { ok: true, reason: `직전 상태(${fmtValue(c, c.before)})로 복원` };
}

export interface ActionAvail { action: FlowAction; ok: boolean; reason: string }
const ACTIONS_BY_STATUS: Record<FlowStatus, FlowAction[]> = {
  pending: ['approve', 'reject', 'hold'],
  approved: ['apply', 'hold', 'cancel'],
  held: ['resume', 'reject'],
  applied: ['rollback'],
  rejected: [],
  rolled_back: [],
};
export function availableActions(c: ChangeRequest, role: string, changes: readonly ChangeRequest[]): ActionAvail[] {
  const perm = canAct(role, c.approver);
  return (ACTIONS_BY_STATUS[c.status] ?? []).map((action) => {
    if (!perm.ok) return { action, ok: false, reason: perm.reason };
    if (action === 'rollback') {
      const r = canRollback(changes, c);
      return { action, ok: r.ok, reason: r.reason };
    }
    return { action, ok: true, reason: perm.reason };
  });
}

/* ---------- 실행 점검 (p.15 04: 지원 API 범위 내 실행, 오류 시 보류 · 보고) ---------- */

/*
 * 다른 모듈의 반영 검증 입력 — 같은 (data, changes, incidents) 참조면 다시 계산하지 않는다 (승인 대기 목록 · 미리보기가 렌더마다 부름).
 * 계산 실패 시 null → 실행 점검은 '검증 불가' 주의로 남긴다 (화면이 깨지지 않게).
 */
let apMemo: { data: Dataset; changes: readonly ChangeRequest[]; incidents: readonly Incident[]; value: AdPilotProposal[] | null } | null = null;
/** AD Pilot 조정 후보 + MILDO Alert 연계 보류 (공식 기준 = 반영된 AD Pilot 설정) */
export function adpilotHolds(data: Dataset, changes: readonly ChangeRequest[], incidents: readonly Incident[]): AdPilotProposal[] | null {
  if (apMemo && apMemo.data === data && apMemo.changes === changes && apMemo.incidents === incidents) return apMemo.value;
  let value: AdPilotProposal[] | null;
  try {
    value = adpilotProposals(data, officialConfig(changes), incidents, changes);
  } catch {
    value = null;
  }
  apMemo = { data, changes, incidents, value };
  return value;
}
let gfaMemo: { data: Dataset; changes: readonly ChangeRequest[]; value: GfaAccountView[] | null } | null = null;
/** GFA Control 다계정 점검 (AD Pilot 화면과 같은 gfaOverview) */
export function gfaViews(data: Dataset, changes: readonly ChangeRequest[]): GfaAccountView[] | null {
  if (gfaMemo && gfaMemo.data === data && gfaMemo.changes === changes) return gfaMemo.value;
  let value: GfaAccountView[] | null;
  try {
    value = gfaOverview(data, changes);
  } catch {
    value = null;
  }
  gfaMemo = { data, changes, value };
  return value;
}
/** AD Pilot 공식 기준 (SAFETY 상한 · 대량 변경 기준 — 승인 · 반영된 설정 변경 포함) */
export function adpilotConfigOf(changes: readonly ChangeRequest[]): AdPilotConfig {
  return officialConfig(changes ?? []);
}
/** 'flow:promo:<id>:budget' 같은 프로모션 단위 요청 → 프로모션 */
export function promoOfChange(data: Dataset, c: Pick<ChangeRequest, 'targetId'>): Promotion | undefined {
  const m = (c.targetId ?? '').match(/^flow:promo:([^:]+):budget$/);
  return m ? (data?.promotions ?? []).find((p) => p.id === m[1]) : undefined;
}

export interface ExecCheck { ok: boolean; blocks: string[]; warnings: string[]; passes: string[] }
/**
 * 반영 전 실행 점검. 통과하지 못하면 반영하지 않고 보류로 기록한다 (p.15 04).
 *  - GFA Control 요청(module gfa): AD Pilot 화면과 같은 validateGfaExecution (계정별 잔액 · 자동충전 · 제재 · 지원 API 범위)
 *  - AD Pilot 입찰 · 예산(module adpilot): validateAdpilotExecution (매체 급변 · 전환 추적 단절 · MILDO Alert 연계 보류 · 최대 입찰가)
 *  - 그 밖의 증액 · ON · 신규 캠페인: 해당 매체 계정 잔액 1일치 · 자동충전 · 제재 (p.44)
 *  - 공통: 데이터 가드(전환 추적 단절 p.45 · 광고비 급변 p.44), 입찰 일 조정 폭 상한 (p.14), 30% 초과 예산의 수면밀도 승인 (p.15)
 */
export function executionCheck(data: Dataset, changes: readonly ChangeRequest[], incidents: readonly Incident[], c: ChangeRequest): ExecCheck {
  const blocks: string[] = [];
  const warnings: string[] = [];
  const passes: string[] = [];
  const approved = c.status === 'approved';
  if (!approved) blocks.push('승인된 건만 반영할 수 있습니다');
  const tid = c.targetId ?? '';
  const media = mediaOfChange(data, c);
  const inc = isSpendIncrease(c);
  const promo = promoOfChange(data, c);
  // 오픈 전 기획전의 기간 예산은 지금 집행되지 않으므로 계정 · 데이터 이상은 '오픈 전 해소' 주의로 둔다
  const deferred = !!promo && promoPhase(promo, data.today) === 'pre';
  const spendKind = c.kind === 'bid' || c.kind === 'budget' || c.kind === 'status' || c.kind === 'gfa' || tid.startsWith('flow:new:');
  const cfg = adpilotConfigOf(changes);
  const pushRisk = (text: string) => (inc && !deferred ? blocks : warnings).push(deferred ? `${text} — 오픈 전 정상화 확인` : text);

  /* ---- GFA Control: AD Pilot 화면과 같은 실행 검증 ---- */
  if (c.module === 'gfa') {
    if (approved) {
      const views = gfaViews(data, changes);
      const v = views ? validateGfaExecution(views, c) : null;
      if (!v) warnings.push('GFA Control 실행 검증을 계산하지 못했습니다 — 계정 상태를 직접 확인하세요');
      else (v.ok ? passes : blocks).push(`GFA Control 실행 검증 · ${v.reason} (p.15 04)`);
    }
  } else if (spendKind) {
    /* ---- 계정 잔액 · 결제 (p.44) ---- */
    const one = accountOfChange(data, c) ?? (media ? data?.accounts?.find((a) => a.media === media) : undefined);
    const accs = promo ? promoAccounts(data, promo) : one ? [one] : [];
    for (const acc of accs) {
      const runway = runwayOf(acc, changes);
      if (acc.status === 'restricted') { blocks.push(`${acc.name} 계정 제재 상태 — 실행 보류 · 보고`); continue; }
      if (inc && runway < 1) pushRisk(`${acc.name} 잔액 ${runway.toFixed(2)}일치 (1일치 미만) · 자동충전 ${AUTO_CHARGE_LABEL[acc.autoCharge]} — 증액 · ON 실행 보류 (충전 확인 후 재실행)`);
      else if (inc && acc.autoCharge === 'failed') warnings.push(`${acc.name} 자동충전 ${AUTO_CHARGE_LABEL[acc.autoCharge]} — 결제 수단 확인 필요 (잔액 ${finite(runway) ? `${runway.toFixed(1)}일치` : '소진 기준 없음'})`);
      else if (finite(runway)) passes.push(`${acc.name} 잔액 ${runway.toFixed(1)}일치`);
      else passes.push(acc.balance < 0 ? `${acc.name} 후불 결제` : `${acc.name} 일 평균 소진 없음 — 잔액 일수 판단 불가`);
      if (acc.status === 'review' && inc) warnings.push(`${acc.name} 계정 상태 '${ACCOUNT_STATUS_LABEL[acc.status]}' — 증액분이 노출되지 않을 수 있음`);
    }
  }

  /* ---- AD Pilot: 매체 · 키워드 보류 (같은 검증 함수) ---- */
  let apChecked = false;
  if (c.module === 'adpilot' && (c.kind === 'bid' || c.kind === 'budget') && approved && !tid.startsWith('seed:')) {
    const holds = adpilotHolds(data, changes, incidents);
    if (!holds) warnings.push('AD Pilot 보류 판정을 계산하지 못했습니다 — AD Pilot 화면에서 확인하세요');
    else {
      const v = validateAdpilotExecution(data, c, holds);
      apChecked = true;
      (v.ok ? passes : blocks).push(`AD Pilot 실행 검증 · ${v.reason}`);
    }
  }

  /* ---- 데이터 가드 (전환 추적 단절 · 광고비 급변) ---- */
  if (spendKind) {
    const medias = promo ? (PROMO_CHANNEL_SCOPE[promo.channel]?.media ?? []) : media ? [media] : [];
    for (const m of medias) {
      for (const g of guardsFor(data, incidents, m)) {
        const what = g.kind === 'tracking_break' ? '전환 추적 단절 의심 — 자동 조정 보류 (p.45)' : '데이터 급변 — 원인 확인 전 조정 보류 (p.44)';
        if (inc) pushRisk(`${mediaName(m)} ${what} · ${g.basis}`);
        else warnings.push(`${mediaName(m)} ${what} · 감액 · 중지는 실행 가능 · ${g.basis}`);
      }
    }
  }

  /* ---- 자동 조정 보류 해제 요청 (MILDO Alert 'alert:<이슈>:release') ---- */
  const rel = tid.match(/^alert:(.+):release$/);
  if (rel) {
    const i = (incidents ?? []).find((x) => x.id === rel[1]) as (Incident & { holdMedia?: MediaId }) | undefined;
    const m = i?.holdMedia ?? (i?.media && (MEDIA_IDS as string[]).includes(i.media) ? (i.media as MediaId) : undefined);
    const still = m ? dataGuards(data).filter((g) => g.media === m) : [];
    if (still.length) warnings.push(`${mediaName(m ?? null)} ${still[0].label} 패턴이 데이터에서 계속 관측됩니다 (${still[0].basis}) — 해제하면 자동 입찰이 이상 데이터로 움직일 수 있어 정상화 확인 후 반영 (p.45)`);
  }

  /* ---- SAFETY · 승인 라우팅 ---- */
  if (c.kind === 'bid') {
    const pct = c.changePct ?? NaN;
    if (finite(pct) && Math.abs(pct) > cfg.dailyChangeCapPct) blocks.push(`입찰 변경 폭 ${fmt.delta(pct, 0)} > 일 조정 폭 상한 ${cfg.dailyChangeCapPct}% (p.14 SAFETY)`);
    const k = keywordOfChange(data, c);
    const after = toNum(c.after);
    if (!apChecked && k && finite(after) && after > k.maxBid) blocks.push(`입찰가 ${fmt.won(after)} > 최대 입찰가 ${fmt.won(k.maxBid)}`);
  }
  const pct = c.changePct ?? NaN;
  const pmMax = GFA_DELEGATION[1].maxPct;
  if ((c.kind === 'budget' || c.kind === 'gfa') && finite(pct) && Math.abs(pct) > pmMax && c.approver !== 'CLIENT') blocks.push(`예산 변경 폭 ${fmt.delta(pct, 0)} — ${pmMax}% 초과는 수면밀도 승인 필요 (p.15)`);
  if (!blocks.length && !passes.some((p) => /실행 검증/.test(p))) passes.push('지원 API 범위 내 실행 (데모: 로컬 상태 반영)');
  return { ok: blocks.length === 0, blocks, warnings, passes };
}

/* ================================================================== */
/* 목록 · 보드 · 요약                                                    */
/* ================================================================== */

export interface ChangeFilter {
  q?: string;
  module?: string;
  approver?: ApprovalLevel | 'all';
  kind?: string;
  scope?: 'all' | 'mine' | 'overdue' | 'live' | 'seed';
}
export function filterChanges(changes: readonly ChangeRequest[], f: ChangeFilter, role: string, ctx?: { nowMs: number; toMs: ToMs }): ChangeRequest[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return (changes ?? []).filter((c) => {
    if (f.module && f.module !== 'all' && c.module !== f.module) return false;
    if (f.approver && f.approver !== 'all' && c.approver !== f.approver) return false;
    if (f.kind && f.kind !== 'all' && c.kind !== f.kind) return false;
    if (f.scope === 'mine' && !(isOpenStatus(c.status) && canAct(role, c.approver).ok)) return false;
    if (f.scope === 'seed' && !isSeed(c)) return false;
    if (f.scope === 'live' && isSeed(c)) return false;
    if (f.scope === 'overdue' && !(ctx && leadState(c, ctx.nowMs, ctx.toMs).overdue)) return false;
    if (q) {
      const hay = `${c.target} ${c.reason} ${c.requestedBy} ${moduleLabel(c.module)} ${c.before} ${c.after} ${(c.history ?? []).map((h) => `${h.by} ${h.action} ${h.note ?? ''}`).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
export function sortByCreatedDesc(changes: readonly ChangeRequest[], toMs: ToMs): ChangeRequest[] {
  return [...changes].sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
}
export function groupByStatus(changes: readonly ChangeRequest[]): Record<FlowStatus, ChangeRequest[]> {
  const out = Object.fromEntries(STATUS_ORDER.map((s) => [s, [] as ChangeRequest[]])) as Record<FlowStatus, ChangeRequest[]>;
  for (const c of changes ?? []) (out[c.status] ?? (out[c.status] = [])).push(c);
  return out;
}

/** 현재 역할 기준 '내가 처리할 것' */
export function myQueue(changes: readonly ChangeRequest[], role: string) {
  const mine = (changes ?? []).filter((c) => canAct(role, c.approver).ok);
  const approve = mine.filter((c) => c.status === 'pending');
  const apply = mine.filter((c) => c.status === 'approved');
  const held = mine.filter((c) => c.status === 'held');
  const blocked = (changes ?? []).filter((c) => c.status === 'pending' && !canAct(role, c.approver).ok);
  return { approve, apply, held, blocked, total: approve.length + apply.length + held.length };
}

export interface FlowSummary {
  total: number;
  byStatus: Record<FlowStatus, number>;
  queue: ReturnType<typeof myQueue>;
  overdue: ChangeRequest[];
  decided: number;
  avgDecisionMin: number;
  metRate: number;
  appliedToday: number;
  seeds: number;
  byModule: { module: string; count: number }[];
}
export function flowSummary(changes: readonly ChangeRequest[], role: string, nowMs: number, toMs: ToMs, today: string): FlowSummary {
  const list = changes ?? [];
  const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, list.filter((c) => c.status === s).length])) as Record<FlowStatus, number>;
  const leads = list.map((c) => ({ c, l: leadState(c, nowMs, toMs) }));
  const decided = leads.filter((x) => x.l.decidedMs !== null && finite(x.l.elapsedMin));
  const met = decided.filter((x) => x.l.met === true).length;
  const modules = new Map<string, number>();
  for (const c of list) modules.set(c.module, (modules.get(c.module) ?? 0) + 1);
  return {
    total: list.length,
    byStatus,
    queue: myQueue(list, role),
    overdue: leads.filter((x) => x.l.overdue).map((x) => x.c),
    decided: decided.length,
    avgDecisionMin: decided.length ? mean(decided.map((x) => x.l.elapsedMin)) : NaN,
    metRate: decided.length ? met / decided.length : NaN,
    appliedToday: list.filter((c) => c.status === 'applied' && kstDateOf(toMs(appliedIso(c))) === today).length,
    seeds: list.filter(isSeed).length,
    byModule: [...modules.entries()].map(([module, count]) => ({ module, count })).sort((a, b) => b.count - a.count),
  };
}

export type BulkThresholds = Pick<AdPilotConfig, 'bulkWarnCount' | 'bulkBlockCount' | 'dailyChangeCapPct'>;
/**
 * 일괄 처리 점검 (대량 변경 실수 방지 p.45) — AD Pilot 공식 기준과 같은 건수 기준을 쓴다
 * (기본 경고 5건 이상 · 차단 15건 이상 · 입찰 일 조정 폭 상한 20%, 승인된 AD Pilot 설정 변경이 있으면 그 값).
 */
export function bulkGuard(list: readonly ChangeRequest[], action: 'approve' | 'apply', th: BulkThresholds = adpilotConfigOf([])): { ok: boolean; level: 'ok' | 'warn' | 'block'; reasons: string[] } {
  const reasons: string[] = [];
  let level: 'ok' | 'warn' | 'block' = 'ok';
  const verb = action === 'approve' ? '승인' : '반영';
  if (!list.length) return { ok: false, level: 'block', reasons: ['처리할 건이 없습니다'] };
  if (list.length >= th.bulkBlockCount) { level = 'block'; reasons.push(`한 번에 ${list.length}건 — 기준 ${th.bulkBlockCount}건 이상 차단 (AD Pilot 대량 변경 기준 · p.45), 나눠서 ${verb}`); }
  const capped = list.filter((c) => c.kind === 'bid' && Math.abs(c.changePct ?? 0) > th.dailyChangeCapPct);
  if (capped.length) { level = 'block'; reasons.push(`일 조정 폭 상한 ${th.dailyChangeCapPct}% 초과 입찰 ${capped.length}건 포함 (p.14)`); }
  const big = list.filter((c) => (c.kind === 'budget' || c.kind === 'gfa') && Math.abs(c.changePct ?? 0) > GFA_DELEGATION[0].maxPct);
  if (level !== 'block' && big.length) { level = 'warn'; reasons.push(`±${GFA_DELEGATION[0].maxPct}% 초과 예산 변경 ${big.length}건 포함 — 건별 근거 확인`); }
  if (level !== 'block' && list.length >= th.bulkWarnCount) { level = 'warn'; reasons.push(`${list.length}건 동시 ${verb} — 기준 ${th.bulkWarnCount}건 이상, 2단계 확인 (p.45)`); }
  if (!reasons.length) reasons.push(`${list.length}건 · 기준 ${th.bulkWarnCount}건 미만`);
  return { ok: level !== 'block', level, reasons };
}

/* ---------- 대량 변경 실수 감지 (MILDO Alert detectBulkChange · p.45) ---------- */

export interface BulkAlert {
  id: string;
  severity: Incident['severity'];
  title: string;
  /** 판정 기준 · 관측값 (배지 옆 근거) */
  basis: string;
  related: string[];
  /** MILDO Alert 이슈로 이미 적재됐는지 */
  logged: boolean;
}
/** state.changes 기준 대량 변경 감지 — Alert와 같은 함수 · 같은 기준(승인된 Alert 기준 변경 포함) · 같은 이슈 id */
export function bulkChangeAlerts(changes: readonly ChangeRequest[], today: string, incidents: readonly Incident[] = []): BulkAlert[] {
  let found: ReturnType<typeof detectBulkChange> = [];
  try {
    found = detectBulkChange(changes ?? [], { today, config: activeConfig([...(changes ?? [])]) });
  } catch {
    found = [];
  }
  return found.map((b) => ({
    id: b.id,
    severity: b.severity,
    title: b.title,
    basis: (b.evidence ?? []).filter((e) => e.threshold).map((e) => `${e.label} ${e.unit === 'int' ? `${fmt.int(e.observed)}건` : e.unit === 'pct' ? fmt.pct(e.observed, 0) : fmt.dec1(e.observed)} · 기준 ${e.threshold}`).join(' · ') || b.basis,
    related: b.related ?? [],
    logged: (incidents ?? []).some((i) => i.id === b.id),
  }));
}

/* ================================================================== */
/* 신규 요청 → 승인 주체 자동 결정                                         */
/* ================================================================== */

export interface RouteResult {
  approver: ApprovalLevel;
  label: string;
  delegationIndex: number | null;
  decisionIndex: number;
  basis: string[];
}
/** 변경 폭(%) → 위임 범위 행 (경계값은 '이내'에 포함) */
export function delegationIndexByPct(pct: number): number {
  if (!finite(pct)) return 2;
  const a = Math.abs(pct);
  const i = GFA_DELEGATION.findIndex((r) => a <= r.maxPct + 1e-9);
  return i < 0 ? 2 : i;
}
export function routeRequest(type: RequestType, pct?: number): RouteResult {
  const def = REQUEST_TYPES.find((t) => t.id === type) ?? REQUEST_TYPES[0];
  const basis: string[] = [];
  let approver: ApprovalLevel;
  let delegationIndex: number | null = null;
  if (def.needsPct) {
    delegationIndex = delegationIndexByPct(pct ?? NaN);
    approver = GFA_DELEGATION[delegationIndex].approver;
    basis.push(finite(pct) ? `변경 폭 ${fmt.delta(pct, 1)} → ${GFA_DELEGATION[delegationIndex].range} (${def.page}, 예시 · 계약 시 확정)` : '변경 폭을 계산할 수 없어 최상위 승인(수면밀도)으로 보냅니다');
  } else {
    approver = def.fixed ?? 'PM';
    if (type === 'onoff') delegationIndex = 1;
    if (type === 'new_campaign') delegationIndex = 2;
    basis.push(`${def.basis} (${def.page})`);
  }
  const dec = decisionOf({ kind: def.kind, approver, targetId: type === 'strategy' ? 'flow:strategy' : '', target: '' });
  const decisionIndex = dec.index;
  const row = dec.row;
  basis.push(`결정 유형 '${row.type}' · 결정자 ${row.decider} · 소요 ${row.lead} (p.53)`);
  if (dec.delegated) basis.push(dec.delegated);
  return { approver, label: APPROVER_LABEL[approver], delegationIndex, decisionIndex, basis };
}

export interface RequestDraft {
  type: RequestType;
  media: MediaId | '';
  targetId: string; // 캠페인 · 키워드 id (선택형)
  targetText: string; // 자유 입력 대상
  pct: number;
  toStatus: 'on' | 'off';
  beforeText: string;
  afterText: string;
  keywordMode: 'add' | 'exclude';
  reason: string;
  promoId?: string;
  incidentId?: string;
}
export const EMPTY_DRAFT: RequestDraft = { type: 'budget', media: 'naver_sa', targetId: '', targetText: '', pct: 10, toStatus: 'off', beforeText: '', afterText: '', keywordMode: 'add', reason: '' };

export interface RequestPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  route: RouteResult;
  input: ChangeInput | null;
  targetLabel: string;
  before: string | number;
  after: string | number;
}
const slug = (s: string) => s.trim().replace(/\s+/g, '_').slice(0, 40);

/** 요청 폼 → 승인 주체 · 검증 · ChangeRequest 입력 (제출 전 미리보기) */
export function planRequest(data: Dataset, changes: readonly ChangeRequest[], incidents: readonly Incident[], d: RequestDraft, requestedBy: string): RequestPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const def = REQUEST_TYPES.find((t) => t.id === d.type) ?? REQUEST_TYPES[0];
  const pct = Number(d.pct);
  const route = routeRequest(d.type, def.needsPct ? pct : undefined);
  const reason = (d.reason ?? '').trim();
  if (reason.length < 8) errors.push('사유를 8자 이상 입력하세요 (누가 · 왜 기록, p.31)');
  let module = 'flow';
  let kind = def.kind;
  let targetId = '';
  let target = '';
  let before: string | number = '—';
  let after: string | number = '—';
  let changePct: number | undefined;
  const promo = d.promoId ? data?.promotions?.find((p) => p.id === d.promoId) : undefined;

  if (d.type === 'budget') {
    if (!finite(pct) || pct === 0) errors.push('변경 폭(%)을 입력하세요');
    if (finite(pct) && pct <= -100) errors.push('일 예산을 0 이하로 줄일 수 없습니다 — ON/OFF 요청으로 바꾸세요');
    if (finite(pct) && pct > 100) errors.push('일 예산 2배 초과 변경은 차단됩니다 — 신규 캠페인 · 구조 변경으로 요청하세요');
    const cmp = data?.campaigns?.find((c) => c.id === d.targetId);
    if (promo && !cmp) {
      const camps = promoCampaigns(data, promo);
      const base = sum(camps, (c) => effectiveBudget(c, changes));
      target = `${promo.name} · 관련 캠페인 ${camps.length}개 일 예산`;
      targetId = `flow:promo:${promo.id}:budget`;
      before = base;
      after = round(base * (1 + (finite(pct) ? pct : 0) / 100), 10_000);
      if (!camps.length) errors.push('프로모션 관련 캠페인이 없습니다');
    } else if (!cmp) {
      errors.push('캠페인을 선택하세요');
    } else {
      const cur = effectiveBudget(cmp, changes);
      target = `${cmp.name} 일 예산`;
      before = cur;
      after = round(cur * (1 + (finite(pct) ? pct : 0) / 100), 10_000);
      if (cmp.media === 'naver_sa') { module = 'adpilot'; targetId = `budget:${cmp.id}:`; }
      else if (cmp.media === 'naver_gfa') { module = 'gfa'; targetId = `gfa:budget:${cmp.id}`; }
      else targetId = `flow:budget:${cmp.id}`;
      const pace = paceCampaign(data, cmp, changes);
      if (finite(pct) && pct < 0 && pace.level === 'before_peak') warnings.push(`조기 소진 예상 캠페인 감액 — ${pace.basis}`);
      if (finite(pct) && pct > 0 && pace.level === 'ok') warnings.push(`현재 페이스로는 일 예산 내 소진 (${pace.basis}) — 증액 근거 확인`);
      if (finite(pct) && pct > 0) {
        const np = paceCampaign(data, cmp, changes, Number(after));
        warnings.push(np.exhaustHour === null ? `증액 후 예상: 일 예산 내 소진 (${fmt.ratio(np.ratio, 0)})` : `증액 후 예상 마감 ${fmtHour(np.exhaustHour)} (현재 ${fmtHour(pace.exhaustHour)})`);
      }
    }
    changePct = finite(pct) ? pct : undefined;
  } else if (d.type === 'bid') {
    module = 'adpilot';
    const k = data?.keywords?.find((x) => x.id === d.targetId);
    if (!k) errors.push('키워드를 선택하세요');
    if (!finite(pct) || pct === 0) errors.push('변경 폭(%)을 입력하세요');
    const cap = adpilotConfigOf(changes).dailyChangeCapPct;
    if (finite(pct) && Math.abs(pct) > cap) errors.push(`일 조정 폭 상한 ${cap}% 초과 (p.14 SAFETY) — 여러 날로 나눠 요청하세요`);
    if (k) {
      const cur = effectiveBid(k, changes);
      target = `${k.text} 입찰가`;
      targetId = k.id;
      before = cur;
      after = Math.max(70, round(cur * (1 + (finite(pct) ? pct : 0) / 100), 10));
      if (Number(after) > k.maxBid) errors.push(`변경 후 ${fmt.won(Number(after))} > 최대 입찰가 ${fmt.won(k.maxBid)}`);
      if (k.isBrand) warnings.push(`브랜드 키워드 별도 기준 — 목표 ROAS ${AD_PILOT.brandTargetRoas}% · 순위 방어 우선 (p.14)`);
    }
    changePct = finite(pct) ? pct : undefined;
  } else if (d.type === 'onoff') {
    const k = data?.keywords?.find((x) => x.id === d.targetId);
    const cmp = data?.campaigns?.find((c) => c.id === d.targetId);
    if (k) {
      module = 'adpilot';
      const cur = effectiveKeywordStatus(k, changes);
      target = `${k.text} 광고 ${d.toStatus === 'off' ? '일시 중지' : '재개'}`;
      targetId = k.id;
      before = cur === 'off' ? 'off' : 'on';
      after = d.toStatus;
      if (before === after) errors.push(`이미 ${String(after).toUpperCase()} 상태입니다`);
    } else if (cmp) {
      target = `${cmp.name} ${d.toStatus === 'off' ? 'OFF' : 'ON'}`;
      targetId = `flow:status:${cmp.id}`;
      before = cmp.status === 'off' ? 'off' : 'on';
      after = d.toStatus;
      if (before === after) errors.push(`이미 ${String(after).toUpperCase()} 상태입니다`);
    } else errors.push('캠페인 또는 키워드를 선택하세요');
  } else if (d.type === 'new_campaign') {
    const name = d.targetText.trim();
    const budget = toNum(d.afterText);
    if (!name) errors.push('캠페인 이름을 입력하세요');
    if (!d.media) errors.push('매체를 선택하세요');
    if (!finite(budget) || budget <= 0) errors.push('일 예산(원)을 숫자로 입력하세요');
    if (name && data?.campaigns?.some((c) => c.name === name)) errors.push('같은 이름의 캠페인이 있습니다');
    target = name || '—';
    before = '—';
    after = finite(budget) ? budget : '—';
    if (d.media === 'naver_gfa') { module = 'gfa'; kind = 'gfa'; targetId = `gfa:new:acc_gfa:${name}`; }
    else targetId = `flow:new:${d.media || 'none'}:${slug(name)}`;
  } else if (d.type === 'creative') {
    const what = d.targetText.trim();
    const copy = d.afterText.trim();
    if (!what) errors.push('교체할 소재 · 랜딩을 입력하세요');
    if (!copy) errors.push('변경 후 문구 또는 URL을 입력하세요');
    const review = reviewCopy(copy);
    for (const r of review) (r.level === 'block' ? errors : warnings).push(`검수 ${r.level === 'block' ? '차단' : r.level === 'warn' ? '주의' : '확인'} · ${r.reason}`);
    if (copy && /^https?:/.test(copy) === false && /\d/.test(copy)) {
      const priceIssues = promo ? copyIssues(data, promo, copy) : [];
      for (const i of priceIssues) warnings.push(i.text);
    }
    target = what || '—';
    targetId = promo ? `flow:promo:${promo.id}:creative:${slug(what)}` : `flow:creative:${slug(what)}`;
    before = d.beforeText.trim() || '현재 소재';
    after = copy || '—';
  } else if (d.type === 'keyword') {
    const text = d.targetText.trim();
    module = 'lab';
    kind = d.keywordMode === 'exclude' ? 'keyword_exclude' : 'keyword_add';
    if (!text) errors.push('키워드를 입력하세요');
    const exist = data?.keywords?.find((k) => k.text === text);
    if (d.keywordMode === 'add' && exist) warnings.push(`이미 등록된 키워드 (${exist.adgroup} · ${exist.status})`);
    if (d.keywordMode === 'exclude' && exist?.isBrand) errors.push('브랜드 키워드는 제외할 수 없습니다 (점유 방어, p.14)');
    target = text ? `${text} ${d.keywordMode === 'exclude' ? '제외 키워드 등록' : '테스트 그룹 등록'}` : '—';
    targetId = `lab:term:${slug(text)}`;
    before = d.keywordMode === 'exclude' ? '노출' : '미등록';
    after = d.keywordMode === 'exclude' ? '제외' : `TEST 그룹 · 입찰 상한 내`;
  } else if (d.type === 'alert_rule') {
    module = 'alert';
    const what = d.targetText.trim();
    if (!what) errors.push('기준 이름을 입력하세요');
    if (!d.afterText.trim()) errors.push('변경 후 기준값을 입력하세요');
    target = what ? `탐지 기준 · ${what}` : '—';
    targetId = `flow:alert_rule:${slug(what)}`;
    before = d.beforeText.trim() || '현재 기준';
    after = d.afterText.trim() || '—';
    warnings.push('MILDO Alert 공식 기준은 Alert 화면의 탐지 기준 편집에서 바뀝니다 — 여기서는 승인 이력만 남깁니다');
  } else if (d.type === 'strategy') {
    const what = d.targetText.trim();
    if (!what) errors.push('전략 방향 · 재배분 내용을 입력하세요');
    target = what ? `전략 방향 · ${what}` : '—';
    targetId = `flow:strategy:${slug(what)}`;
    before = d.beforeText.trim() || '현재 계획';
    after = d.afterText.trim() || '—';
  }

  // 같은 대상 진행 중 요청
  const dup = targetId ? (changes ?? []).find((c) => c.targetId === targetId && isOpenStatus(c.status)) : undefined;
  if (dup) warnings.push(`같은 대상 요청 진행 중 (${STATUS_META[dup.status].label} · ${dup.requestedBy})`);
  // 실행 점검 미리보기 (계정 잔액 · 데이터 가드)
  if (!errors.length && targetId) {
    const pseudo: ChangeRequest = { id: 'preview', createdAt: '', module, kind, target, targetId, before, after, changePct, reason, requestedBy, approver: route.approver, status: 'approved', history: [] };
    const ex = executionCheck(data, changes, incidents, pseudo);
    for (const b of ex.blocks) warnings.push(`승인되어도 실행 보류 예상: ${b}`);
  }
  const input: ChangeInput | null = errors.length ? null : {
    module, kind, target, targetId, before, after, changePct,
    reason: `${reason}${promo ? ` · 프로모션 ${promo.name}` : ''}${d.incidentId ? ` · 이슈 ${d.incidentId}` : ''}`,
    requestedBy, approver: route.approver,
  };
  return { ok: !errors.length, errors, warnings, route, input, targetLabel: target, before, after };
}

/* ================================================================== */
/* 검수 · 소재 문구 대조                                                  */
/* ================================================================== */

export function reviewCopy(copy: string): { id: string; level: 'block' | 'warn' | 'check'; reason: string; match: string }[] {
  if (!copy) return [];
  const out: { id: string; level: 'block' | 'warn' | 'check'; reason: string; match: string }[] = [];
  for (const r of REVIEW_RULES) {
    const m = copy.match(new RegExp(r.pattern));
    if (m) out.push({ id: r.id, level: r.level, reason: r.reason, match: m[0] });
  }
  return out;
}
/** 문구 속 가격 표기 → [하한, 상한) 원 */
export function parseCopyPrices(copy: string): { text: string; min: number; max: number }[] {
  const out: { text: string; min: number; max: number }[] = [];
  for (const m of copy.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s?원/g)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (finite(v)) out.push({ text: m[0], min: v, max: v + 1 });
  }
  for (const m of copy.matchAll(/(\d+)\s?만\s?원(대)?/g)) {
    const v = Number(m[1]) * 10_000;
    if (finite(v)) out.push({ text: m[0], min: v, max: m[2] ? v + 10_000 : v + 1 });
  }
  return out;
}
export function parseCopyRates(copy: string): { text: string; rate: number }[] {
  return [...copy.matchAll(/(최대\s?)?(\d{1,2})\s?%/g)].map((m) => ({ text: m[0], rate: Number(m[2]) })).filter((r) => finite(r.rate));
}
export const promoPrice = (price: number, rate: number) => Math.round(price * (1 - rate / 100));

interface CopyIssue { level: 'fail' | 'warn'; text: string }
/** 소재 문구 ↔ 프로모션 할인율 · 판매가 · 재고 대조 */
export function copyIssues(data: Dataset, p: Promotion, copy: string): CopyIssue[] {
  const out: CopyIssue[] = [];
  const options = (data?.products ?? []).flatMap((pr) => pr.options.map((o) => ({ ...o, product: pr.name })));
  const mentioned = options.filter((o) => copy.includes(o.label));
  for (const r of parseCopyRates(copy)) if (r.rate !== p.discountRate) out.push({ level: 'fail', text: `할인율 표기 '${r.text}' ≠ 기획전 할인율 ${p.discountRate}%` });
  for (const pr of parseCopyPrices(copy)) {
    const cands = mentioned.length ? mentioned : options;
    const ok = cands.some((o) => {
      const exp = promoPrice(o.price, p.discountRate);
      const tol = Math.max(1, (exp * PRICE_TOLERANCE_PCT) / 100);
      return pr.max - pr.min > 1 ? exp >= pr.min && exp < pr.max : Math.abs(pr.min - exp) <= tol;
    });
    if (!ok) {
      const ref = cands[0];
      out.push({ level: 'fail', text: `가격 표기 '${pr.text}' ≠ ${ref ? `${ref.label} 판매가 ${fmt.won(ref.price)} × (1 − ${p.discountRate}%) = ${fmt.won(promoPrice(ref.price, p.discountRate))}` : '판매가 기준 없음'}` });
    }
  }
  for (const o of mentioned) if (!o.inStock) out.push({ level: 'fail', text: `${o.label} 옵션 품절 — 구매할 수 없는 옵션을 소재에 노출` });
  return out;
}

/* ================================================================== */
/* 프로모션 체크리스트 · 오픈 전 자동 점검                                   */
/* ================================================================== */

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info';
const LEVEL_RANK: Record<CheckLevel, number> = { pass: 0, info: 1, warn: 2, fail: 3 };
const worst = (ls: CheckLevel[]): CheckLevel => ls.reduce<CheckLevel>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'pass');

export interface CheckItem {
  id: string;
  group: CheckGroup;
  label: string;
  level: CheckLevel;
  detail: string;
  basis: string;
  action: string;
  fix?: { label: string; input: ChangeInput };
  fixState?: { id: string; status: FlowStatus } | null;
}
export type PromoPhase = 'pre' | 'live' | 'ended';
export interface PromoCheck {
  promotion: Promotion;
  channelName: string;
  phase: PromoPhase;
  phaseLabel: string;
  dday: number;
  needDays: number;
  items: CheckItem[];
  counts: Record<CheckLevel, number>;
  byGroup: Record<CheckGroup, CheckLevel>;
  verdict: { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; basis: string };
}
export function promoPhase(p: Pick<Promotion, 'start' | 'end'>, today: string): PromoPhase {
  if (today < p.start) return 'pre';
  if (today > p.end) return 'ended';
  return 'live';
}
export const PHASE_LABEL: Record<PromoPhase, string> = { pre: '오픈 전', live: '진행 중', ended: '종료' };

export function promoCampaigns(data: Dataset, p: Promotion): Campaign[] {
  const scope = PROMO_CHANNEL_SCOPE[p.channel];
  if (!scope) return [];
  return (data?.campaigns ?? []).filter((c) => scope.media.includes(c.media) && (!scope.campaignMatch || c.name.includes(scope.campaignMatch)));
}
export function promoAccounts(data: Dataset, p: Promotion): AdAccount[] {
  const scope = PROMO_CHANNEL_SCOPE[p.channel];
  return scope ? (data?.accounts ?? []).filter((a) => scope.accounts.includes(a.media)) : [];
}
function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)/);
  return m ? m[1] : '';
}
/** 같은 대상 · 유형의 진행 중(반려 · 롤백 제외) 최신 요청 상태 */
export function fixStateOf(changes: readonly ChangeRequest[], targetId: string, kind?: ChangeRequest['kind']) {
  const list = (changes ?? []).filter((c) => c.targetId === targetId && (!kind || c.kind === kind) && c.status !== 'rejected' && c.status !== 'rolled_back');
  const latest = list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  return latest ? { id: latest.id, status: latest.status } : null;
}
function budgetFix(cmp: Campaign, pct: number, cur: number, reason: string): ChangeInput {
  const after = round(cur * (1 + pct / 100), 10_000);
  const idx = delegationIndexByPct(pct);
  const module = cmp.media === 'naver_sa' ? 'adpilot' : cmp.media === 'naver_gfa' ? 'gfa' : 'flow';
  const targetId = cmp.media === 'naver_sa' ? `budget:${cmp.id}:` : cmp.media === 'naver_gfa' ? `gfa:budget:${cmp.id}` : `flow:budget:${cmp.id}`;
  return { module, kind: 'budget', target: `${cmp.name} 일 예산`, targetId, before: cur, after, changePct: pct, reason, requestedBy: 'MILDO Flow 점검', approver: GFA_DELEGATION[idx].approver };
}

export function checkPromotion(
  data: Dataset, p: Promotion,
  ctx: { changes?: readonly ChangeRequest[]; incidents?: readonly Incident[]; creatives?: readonly PromoCreative[]; reference?: PromoReport | null } = {},
): PromoCheck {
  const changes = ctx.changes ?? [];
  const today = data.today;
  const phase = promoPhase(p, today);
  const scope = PROMO_CHANNEL_SCOPE[p.channel];
  const channelName = SALES_CHANNELS[p.channel]?.name ?? p.channel;
  const dday = phase === 'pre' ? daysBetween(today, p.start) : phase === 'live' ? daysBetween(today, p.end) : daysBetween(p.end, today);
  const needDays = phase === 'ended' ? 0 : Math.max(1, daysBetween(today, p.end) + 1);
  const items: CheckItem[] = [];
  const add = (it: Omit<CheckItem, 'fixState'>) => {
    items.push({ ...it, fixState: it.fix ? fixStateOf(changes, it.fix.input.targetId ?? '', it.fix.input.kind) : null });
  };

  /* ---- 일정 ---- */
  const len = daysBetween(p.start, p.end) + 1;
  add({ id: 'schedule_period', group: '일정', label: '기간', level: finite(len) && len >= 1 ? 'pass' : 'fail',
    detail: finite(len) && len >= 1 ? `${fmtDate(p.start)} ~ ${fmtDate(p.end)} · ${len}일` : `시작 ${p.start} > 종료 ${p.end}`,
    basis: '시작일 ≤ 종료일', action: finite(len) && len >= 1 ? '—' : '기간 수정' });
  const expected = phase === 'pre' ? 'planned' : phase === 'live' ? 'live' : 'ended';
  add({ id: 'schedule_status', group: '일정', label: '상태 표기', level: p.status === expected ? 'pass' : 'fail',
    detail: p.status === expected ? `'${PHASE_LABEL[phase]}' · 기준일 ${fmtDate(today)}` : `등록 상태 '${p.status}' ≠ 기준일 기준 '${expected}'`,
    basis: `기준일 ${today} 대비 기간`, action: p.status === expected ? '—' : '프로모션 상태 갱신 · 소재 노출 여부 확인' });
  const overlap = (data.promotions ?? []).filter((o) => o.id !== p.id && o.channel === p.channel && o.start <= p.end && o.end >= p.start);
  add({ id: 'schedule_overlap', group: '일정', label: '같은 채널 기간 겹침', level: overlap.length ? 'warn' : 'pass',
    detail: overlap.length ? overlap.map((o) => `${o.name}(${fmtDate(o.start, false)}~${fmtDate(o.end, false)} · ${o.discountRate}%)`).join(', ') : '겹치는 기획전 없음',
    basis: '할인 중복 · 소재 혼선 방지', action: overlap.length ? '할인 중복 적용 여부 확인 (수면밀도)' : '—' });
  if (phase === 'pre') {
    const off = isOffDay(p.start);
    add({ id: 'schedule_open', group: '일정', label: '오픈일', level: off.off ? 'info' : 'pass',
      detail: `${fmtDate(p.start)} 오픈 · D-${dday}${off.off ? ` · ${off.label}` : ' · 평일'}`,
      basis: off.off ? '주말 · 공휴일 오픈 → 당번 AE 30분 내 확인 체계 (p.48)' : '평일 오픈 · 업무시간 대응', action: off.off ? '당번 AE · 오픈 시각 모니터링 지정' : '—' });
  } else if (phase === 'live') {
    const tid = `flow:promo:${p.id}:endswap`;
    const st = fixStateOf(changes, tid);
    add({ id: 'schedule_end', group: '일정', label: '종료 소재 교체', level: dday <= 3 ? (st && (st.status === 'approved' || st.status === 'applied') ? 'pass' : 'warn') : 'pass',
      detail: dday <= 3 ? `종료 D-${dday} (${fmtDate(p.end)} 23:59)${st ? ` · 교체 예약 요청 ${STATUS_META[st.status].label}` : ' · 교체 예약 요청 없음'}` : `종료까지 D-${dday}`,
      basis: '종료 후 할인 문구 노출 = 가격 · 프로모션 불일치 (p.45)', action: dday <= 3 ? '종료 시각 기본 소재 복귀 예약 (담당 AE)' : '—',
      fix: dday <= 3 ? { label: '교체 예약 요청', input: { module: 'flow', kind: 'setting', target: `${p.name} 종료 시각 소재 교체 예약`, targetId: tid, before: `기획전 소재 (${p.discountRate}%)`, after: `${fmtDate(p.end)} 23:59 기본 소재 복귀`, reason: `종료 D-${dday} · 종료 후 할인 문구 노출 방지 (p.45 가격 · 프로모션 불일치)`, requestedBy: 'MILDO Flow 점검', approver: 'AE' } } : undefined });
  } else {
    add({ id: 'schedule_ended', group: '일정', label: '종료', level: 'info', detail: `${fmtDate(p.end)} 종료 · ${dday}일 경과`, basis: '종료 후 리포트 · 다음 기획 반영', action: '프로모션 리포트 확인' });
  }

  /* ---- 가격 ---- */
  const options = (data.products ?? []).flatMap((pr) => pr.options.map((o) => ({ ...o, product: pr.name })));
  if (!(p.discountRate > 0 && p.discountRate < 100)) {
    add({ id: 'price_rate', group: '가격', label: '할인율', level: 'fail', detail: `할인율 ${p.discountRate}%`, basis: '0% 초과 100% 미만', action: '할인율 확인' });
  }
  if (p.adCopyPrice === undefined || !finite(p.adCopyPrice)) {
    add({ id: 'price_copy', group: '가격', label: '소재 표기가 대조', level: phase === 'pre' ? 'warn' : 'info',
      detail: '소재 가격 표기 미등록 — 대조 대상 없음', basis: `판매가 × (1 − ${p.discountRate}%) 대조 (p.45 가격 불일치)`, action: phase === 'pre' ? '가격형 소재 확정 시 표기가 등록 · 자동 대조' : '—' });
  } else {
    const ranked = options.map((o) => {
      const exp = promoPrice(o.price, p.discountRate);
      return { o, exp, diff: exp > 0 ? ((p.adCopyPrice! - exp) / exp) * 100 : NaN };
    }).filter((x) => finite(x.diff)).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
    const best = ranked[0];
    if (!best) {
      add({ id: 'price_copy', group: '가격', label: '소재 표기가 대조', level: 'warn', detail: `표기가 ${fmt.won(p.adCopyPrice)} · 판매가 정보 없음`, basis: '상품 판매가 필요', action: '상품 판매가 연동 확인' });
    } else if (Math.abs(best.diff) <= PRICE_TOLERANCE_PCT) {
      add({ id: 'price_copy', group: '가격', label: '소재 표기가 대조', level: best.o.inStock ? 'pass' : 'warn',
        detail: `표기 ${fmt.won(p.adCopyPrice)} = ${best.o.label} ${fmt.won(best.o.price)} × (1 − ${p.discountRate}%)${best.o.inStock ? '' : ` · ${best.o.label} 품절`}`,
        basis: `허용 오차 ±${PRICE_TOLERANCE_PCT}%`, action: best.o.inStock ? '—' : '품절 옵션 가격 표기 교체' });
    } else {
      add({ id: 'price_copy', group: '가격', label: '소재 표기가 대조', level: 'fail',
        detail: `표기 ${fmt.won(p.adCopyPrice)} ≠ ${best.o.label} 기준 ${fmt.won(best.exp)} (${fmt.delta(best.diff)})`,
        basis: `판매가 × (1 − ${p.discountRate}%) · 허용 오차 ±${PRICE_TOLERANCE_PCT}% (p.45)`, action: '소재 가격 문구 교체 (담당 AE)',
        fix: { label: '문구 교체 요청', input: { module: 'flow', kind: 'setting', target: `${p.name} 가격 문구 교체`, targetId: `flow:promo:${p.id}:price`, before: fmt.won(p.adCopyPrice), after: fmt.won(best.exp), reason: `소재 표기가 ${fmt.won(p.adCopyPrice)} ≠ 판매가 기준 ${fmt.won(best.exp)} (p.45 가격 불일치)`, requestedBy: 'MILDO Flow 점검', approver: 'AE' } } });
    }
  }

  /* ---- 소재 ---- */
  const creatives = (ctx.creatives ?? PROMO_CREATIVES).filter((c) => c.promoId === p.id);
  if (!creatives.length) {
    add({ id: 'creative_none', group: '소재', label: '등록 소재', level: phase === 'ended' ? 'info' : 'warn', detail: '프로모션 소재 미등록', basis: '오픈 전 소재 검수 · 가격 대조', action: '소재 등록 · 검수 요청' });
  }
  for (const cr of creatives) {
    const issues: { level: CheckLevel; text: string }[] = [];
    for (const r of reviewCopy(cr.copy)) if (r.level !== 'check') issues.push({ level: r.level === 'block' ? 'fail' : 'warn', text: `검수 ${r.level === 'block' ? '차단' : '주의'} '${r.match}' — ${r.reason}` });
    for (const i of copyIssues(data, p, cr.copy)) issues.push(i);
    if (cr.status === 'pending') issues.push({ level: 'warn', text: '매체 검수 대기' });
    if (cr.status === 'rejected') issues.push({ level: 'fail', text: '매체 검수 반려' });
    if (cr.status === 'draft' && !issues.length) issues.push({ level: 'info', text: '초안 · 매체 검수 전' });
    const level = worst(issues.map((i) => i.level));
    let suggestion = cr.copy;
    for (const r of parseCopyRates(cr.copy)) if (r.rate !== p.discountRate) suggestion = suggestion.replace(r.text, `${p.discountRate}%`);
    for (const o of options.filter((x) => cr.copy.includes(x.label))) {
      if (!o.inStock) {
        const alt = options.find((x) => x.inStock && x.product === o.product && x.price > 0 && x.label !== o.label);
        if (alt) suggestion = suggestion.replace(`${o.label} 사이즈`, `${alt.label}`).replace(o.label, alt.label);
      }
    }
    for (const pr of parseCopyPrices(suggestion)) {
      const o = options.find((x) => suggestion.includes(x.label));
      if (o) suggestion = suggestion.replace(pr.text, fmt.won(promoPrice(o.price, p.discountRate)));
    }
    add({ id: `creative_${cr.id}`, group: '소재', label: cr.name, level,
      detail: `"${cr.copy}"${issues.length ? ` — ${issues.map((i) => i.text).join(' · ')}` : ' — 문구 · 가격 · 할인율 · 검수 통과'}`,
      basis: `REVIEW_RULES 검수 · 할인율 ${p.discountRate}% · 판매가 대조 (p.27 · p.45)`, action: level === 'fail' ? `문구 수정 → "${suggestion}"` : level === 'warn' ? '검수 상태 확인' : '—',
      fix: level === 'fail' ? { label: '문구 수정 요청', input: { module: 'flow', kind: 'setting', target: `${cr.name} 문구 수정`, targetId: `flow:promo:${p.id}:creative:${cr.id}`, before: cr.copy, after: suggestion, reason: issues.filter((i) => i.level === 'fail').map((i) => i.text).join(' · '), requestedBy: 'MILDO Flow 점검', approver: 'AE' } } : undefined });
  }

  /* ---- 랜딩 ---- */
  const mismatch = creatives.filter((c) => scope && !hostOf(c.landing).includes(scope.domain));
  for (const c of mismatch) {
    add({ id: `landing_domain_${c.id}`, group: '랜딩', label: `${c.name} 랜딩`, level: 'warn', detail: `${hostOf(c.landing) || c.landing} · 기획전 채널(${channelName}) 도메인 아님`, basis: `기획전 혜택 적용 페이지 = ${scope?.domain ?? '—'}`, action: '혜택 적용 페이지로 랜딩 교체 또는 의도 확인' });
  }
  if (creatives.length && !mismatch.length) add({ id: 'landing_domain', group: '랜딩', label: '소재 랜딩 도메인', level: 'pass', detail: `소재 ${creatives.length}개 → ${scope?.domain}`, basis: '기획전 채널 도메인 일치', action: '—' });
  if (scope?.media.includes('naver_sa') && phase !== 'ended') {
    const soldKw: { k: Keyword; label: string; product: string }[] = [];
    for (const k of data.keywords ?? []) {
      if (effectiveKeywordStatus(k, changes) === 'off') continue;
      for (const pr of data.products ?? []) {
        if (pr.landing !== k.landing) continue;
        for (const o of pr.options) if (!o.inStock && k.text.includes(o.label)) soldKw.push({ k, label: o.label, product: pr.name });
      }
    }
    for (const s of soldKw) {
      add({ id: `landing_soldout_${s.k.id}`, group: '랜딩', label: `'${s.k.text}' 랜딩`, level: 'fail',
        detail: `${s.product} 상세로 랜딩 · ${s.label} 옵션 품절 · 최근 14일 광고비 ${fmt.krw(s.k.last14.cost)}`,
        basis: '옵션 inStock=false · 키워드 랜딩 = 상품 상세 (p.45 품절 · 옵션 품절 랜딩)', action: '키워드 일시 중지 또는 대체 랜딩 (PM 승인 · ON/OFF p.15)',
        fix: { label: '일시 중지 요청', input: { module: 'adpilot', kind: 'status', target: `${s.k.text} 광고 일시 중지`, targetId: s.k.id, before: 'on', after: 'off', reason: `${s.label} 옵션 품절 상세로 랜딩 — ${p.name} 기간 광고비 누수 방지 (p.45)`, requestedBy: 'MILDO Flow 점검', approver: 'PM' } } });
    }
    if (!soldKw.length) add({ id: 'landing_soldout', group: '랜딩', label: '품절 옵션 랜딩', level: 'pass', detail: '품절 옵션 상세로 랜딩하는 키워드 없음', basis: 'p.45 품절 랜딩', action: '—' });
  }

  /* ---- 예산 ---- */
  const camps = promoCampaigns(data, p).filter((c) => c.status !== 'off');
  if (phase === 'live') {
    const paces = camps.map((c) => paceCampaign(data, c, changes));
    const early = paces.filter((x) => x.level === 'before_peak');
    for (const x of early) {
      const need = Math.ceil(((x.ratio - 1) * 100) / 5) * 5;
      add({ id: `budget_pace_${x.campaign.id}`, group: '예산', label: `${x.campaign.name} 일 예산`, level: 'fail',
        detail: x.basis, basis: `시간대 가중 소진 곡선 (최근 28일) · 매출 피크 ${x.peakHour}시 전 마감 = 조기 소진`, action: `일 예산 +${need}% 또는 시간대 입찰 조정 (승인 ${APPROVER_LABEL[GFA_DELEGATION[delegationIndexByPct(need)].approver]})`,
        fix: { label: `일 예산 +${need}% 요청`, input: budgetFix(x.campaign, need, x.budget, `${p.name} 진행 중 · ${x.basis} — 피크 시간대 미노출 방지`) } });
    }
    const late = paces.filter((x) => x.level === 'before_midnight');
    if (late.length) add({ id: 'budget_pace_late', group: '예산', label: '자정 전 소진 예상', level: 'info', detail: late.map((x) => `${x.campaign.name} ${fmtHour(x.exhaustHour)}`).join(', '), basis: `매출 피크(${late[0].peakHour}시) 이후 마감 — 영향 제한적`, action: '익일 시간대 입찰 상한 점검' });
    if (!early.length) add({ id: 'budget_pace', group: '예산', label: '캠페인 일 예산', level: 'pass', detail: `관련 캠페인 ${camps.length}개 · 피크 전 소진 없음`, basis: '시간대 가중 소진 곡선', action: '—' });
  }
  if (phase !== 'ended') {
    const mp = monthlyPacing(data).filter((m) => scope?.media.includes(m.media));
    const over = mp.filter((m) => m.status === 'over');
    add({ id: 'budget_month', group: '예산', label: '월 예산 페이스', level: over.length ? 'warn' : 'pass',
      detail: over.length ? over.map((m) => `${MEDIA[m.media].name} 예상 월 소진 ${fmt.krw(m.projected)} / 예산 ${fmt.krw(m.budget)}`).join(', ') : `${mp.map((m) => `${MEDIA[m.media].short} ${fmt.pct(m.pacePct, 0)}`).join(' · ')} (기대 ${fmt.pct(mp[0]?.expectedPct ?? NaN, 0)})`,
      basis: '월 예산 = 연 배분 / 12 (p.37) · 예상 소진 105% 초과 = 초과 페이스', action: over.length ? '월 예산 초과분 승인 또는 일 예산 하향 (수면밀도)' : '—' });
  }
  if (phase === 'pre') {
    const tid = `flow:promo:${p.id}:budget`;
    const st = fixStateOf(changes, tid);
    const ref = ctx.reference;
    const refDelta = ref?.rows.find((r) => r.key === 'adCost')?.delta;
    const pct = finite(refDelta) && refDelta >= 5 ? Math.round(refDelta / 5) * 5 : NaN;
    const base = sum(camps, (c) => effectiveBudget(c, changes));
    const fixPct = finite(pct) ? pct : DEFAULT_PROMO_UPLIFT_PCT;
    const idx = delegationIndexByPct(fixPct);
    add({ id: 'budget_plan', group: '예산', label: '기획전 기간 예산', level: st ? (st.status === 'applied' || st.status === 'approved' ? 'pass' : 'warn') : 'warn',
      detail: st ? `증액 요청 ${STATUS_META[st.status].label}` : `기획전 기간 예산 증액 요청 없음 · 관련 캠페인 일 예산 합 ${fmt.krw(base)}`,
      basis: ref && finite(refDelta) ? `참고: ${ref.promotion.name} 기간 관련 매체 광고비 직전 동기간 대비 ${fmt.delta(refDelta)} (TEST DATA)${finite(pct) ? '' : ` — 5% 미만이라 기본 +${DEFAULT_PROMO_UPLIFT_PCT}% (운영 기본값)`}` : `참고 기획전 없음 · 기본 +${DEFAULT_PROMO_UPLIFT_PCT}% (운영 기본값)`,
      action: st ? '승인 진행 확인' : `기간 일 예산 +${fixPct}% 사전 승인 (${APPROVER_LABEL[GFA_DELEGATION[idx].approver]})`,
      fix: st ? undefined : { label: `기간 예산 +${fixPct}% 요청`, input: { module: 'flow', kind: 'budget', target: `${p.name} · 관련 캠페인 ${camps.length}개 일 예산`, targetId: tid, before: base, after: round(base * (1 + fixPct / 100), 10_000), changePct: fixPct, reason: `${p.name} ${fmtDate(p.start)} 오픈 · ${finite(pct) && ref ? `${ref.promotion.name} 광고비 증감 ${fmt.delta(refDelta!)} 기준` : `기본 +${DEFAULT_PROMO_UPLIFT_PCT}% (운영 기본값)`} · 오픈 첫날 조기 소진 방지`, requestedBy: 'MILDO Flow 점검', approver: GFA_DELEGATION[idx].approver } } });
  }
  if (phase === 'ended') add({ id: 'budget_ended', group: '예산', label: '예산', level: 'info', detail: '종료 — 예산 점검 대상 아님', basis: '—', action: '—' });

  /* ---- 재고 ---- */
  const sold = options.filter((o) => !o.inStock);
  for (const o of sold) {
    const kws = (data.keywords ?? []).filter((k) => k.text.includes(o.label));
    add({ id: `stock_${o.product}_${o.id}`, group: '재고', label: `${o.product} · ${o.label}`, level: phase === 'ended' ? 'info' : 'fail',
      detail: `품절 · 판매가 ${fmt.won(o.price)} → 기획가 ${fmt.won(promoPrice(o.price, p.discountRate))}${kws.length ? ` · 관련 키워드 ${kws.map((k) => `'${k.text}'`).join(', ')}` : ''}`,
      basis: 'products[].options inStock=false', action: phase === 'pre' ? '오픈 전 입고 확정 또는 품절 옵션 제외 기획 (수면밀도 재고 담당)' : '입고 일정 확인 · 품절 옵션 소재 · 키워드 노출 중지' });
  }
  if (!sold.length) add({ id: 'stock_ok', group: '재고', label: '옵션 재고', level: 'pass', detail: `${options.length}개 옵션 재고 정상`, basis: 'products[].options', action: '—' });

  /* ---- 결제 잔액 ---- */
  if (phase !== 'ended') {
    const accs = promoAccounts(data, p);
    if (!accs.length) add({ id: 'balance_none', group: '결제 잔액', label: '연결 계정', level: 'warn', detail: '프로모션 유입 매체 계정 없음', basis: '—', action: '계정 매핑 확인' });
    for (const a of accs) {
      const conds: { level: CheckLevel; text: string }[] = [];
      if (a.status !== 'active') conds.push({ level: 'fail', text: `계정 상태 '${ACCOUNT_STATUS_LABEL[a.status]}' — 광고 노출 중단 가능` });
      let fix: CheckItem['fix'];
      let runway = Infinity;
      if (a.balance < 0) conds.push({ level: 'pass', text: `후불 · ${a.paymentMethod}` });
      else {
        const bal = effectiveBalance(a, changes);
        runway = a.avgDailySpend > 0 ? bal / a.avgDailySpend : Infinity;
        // 진행 중: 기획전 잔여 일수 커버 · 오픈 전: 3일치 유지 (오픈 전까지 충전 주기가 남아 있음)
        const cover = phase === 'pre' ? RUNWAY_TARGET_DAYS : needDays;
        const need = Math.max(RUNWAY_TARGET_DAYS, cover);
        const topup = Math.max(0, Math.ceil((a.avgDailySpend * need - bal) / 100_000) * 100_000);
        const mkFix = (): CheckItem['fix'] => topup > 0 ? { label: `충전 요청 ${fmt.krw(topup)}원`, input: { module: 'alert', kind: 'setting', target: `${a.name} 충전`, targetId: topupTargetId(a), before: bal, after: bal + topup, changePct: bal > 0 ? Math.round((topup / bal) * 1000) / 10 : undefined, reason: `잔액 ${runway.toFixed(2)}일치 → ${need}일치 확보 (${fmt.krw(topup)}원) · ${p.name} ${phase === 'pre' ? `오픈 D-${dday}` : `잔여 ${needDays}일`} · 결제 수단 수면밀도 (p.50)`, requestedBy: 'MILDO Flow 점검', approver: 'CLIENT' } } : undefined;
        if (runway < 1) { conds.push({ level: 'fail', text: `잔액 ${fmt.krw(bal)} · ${runway.toFixed(2)}일치 (1일치 미만)` }); fix = mkFix(); }
        if (a.autoCharge === 'failed') { conds.push({ level: runway < 1 ? 'fail' : 'warn', text: '자동충전 실패' }); fix = fix ?? mkFix(); }
        const coverLabel = phase === 'pre' ? `유지 기준 ${cover}일치` : `잔여 ${cover}일`;
        if (runway >= 1 && runway < cover) {
          if (a.autoCharge === 'ok') conds.push({ level: 'info', text: `잔액 ${runway.toFixed(1)}일치 < ${coverLabel} · 자동충전 정상` });
          else if (a.autoCharge !== 'failed') { conds.push({ level: 'warn', text: `잔액 ${runway.toFixed(1)}일치 < ${coverLabel} · 자동충전 ${AUTO_CHARGE_LABEL[a.autoCharge]}` }); fix = fix ?? mkFix(); }
        }
        if (!conds.length) conds.push({ level: 'pass', text: finite(runway) ? `잔액 ${fmt.krw(bal)} · ${runway.toFixed(1)}일치 ≥ ${coverLabel}` : `잔액 ${fmt.krw(bal)} · 일 평균 소진 없음 (소진 기준 없음)` });
      }
      const level = worst(conds.map((c) => c.level));
      add({ id: `balance_${a.id}`, group: '결제 잔액', label: a.name, level, detail: conds.map((c) => c.text).join(' · '),
        basis: `잔액 1일치 미만 · 자동충전 실패 · 계정 제재 = P1 (p.44) · ${phase === 'pre' ? `오픈 전 ${RUNWAY_TARGET_DAYS}일치 유지` : `기획전 잔여 ${needDays}일 커버`}`,
        action: level === 'fail' ? (a.status !== 'active' ? '매체 검수 문의 · 계정 상태 확인 (DA AE → PM)' : '충전 요청 (수면밀도 승인 · p.50)') : level === 'warn' ? '결제 수단 · 충전 일정 확인' : '—', fix });
    }
  }

  const counts: Record<CheckLevel, number> = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const i of items) counts[i.level]++;
  const byGroup = Object.fromEntries(CHECK_GROUPS.map((g) => [g, worst(items.filter((i) => i.group === g).map((i) => i.level))])) as Record<CheckGroup, CheckLevel>;
  const verdict = counts.fail
    ? { label: phase === 'pre' ? '오픈 보류' : phase === 'live' ? '즉시 조치' : '사후 점검', tone: 'critical' as const }
    : counts.warn ? { label: phase === 'pre' ? '조치 후 오픈' : '주의', tone: 'warning' as const }
      : { label: phase === 'pre' ? '오픈 가능' : phase === 'live' ? '정상 진행' : '종료', tone: phase === 'ended' ? 'neutral' as const : 'good' as const };
  return {
    promotion: p, channelName, phase, phaseLabel: PHASE_LABEL[phase], dday, needDays, items, counts, byGroup,
    verdict: { ...verdict, basis: `실패 ${counts.fail} · 주의 ${counts.warn} · 통과 ${counts.pass} — 기준: 실패 0건 = 오픈 가능, 주의는 담당자 확인` },
  };
}

/** 전 프로모션 점검 (오픈 전 기획전은 같은 채널 직전 기획전 리포트를 예산 참고값으로 사용) */
export function checkAllPromotions(data: Dataset, ctx: { changes?: readonly ChangeRequest[]; incidents?: readonly Incident[] } = {}): PromoCheck[] {
  const promos = data?.promotions ?? [];
  return promos.map((p) => {
    let reference: PromoReport | null = null;
    if (promoPhase(p, data.today) === 'pre') {
      const ref = promos.filter((o) => o.id !== p.id && o.channel === p.channel && o.start < p.start && promoPhase(o, data.today) !== 'pre').sort((a, b) => b.start.localeCompare(a.start))[0];
      reference = ref ? promoReport(data, ref, ctx) : null;
    }
    return checkPromotion(data, p, { ...ctx, reference });
  });
}

/* ================================================================== */
/* 프로모션별 리포트 (기간 vs 직전 동일 기간)                                */
/* ================================================================== */

export interface PromoMetricRow {
  key: string;
  label: string;
  cur: number;
  prev: number;
  delta: number;
  unit: 'krw' | 'won' | 'roas' | 'pct' | 'ratio' | 'int' | 'x';
  invert?: boolean;
  /** 비율(ratio) 지표의 변화 (%p) — 비중은 상대 증감이 아니라 %p로 비교 */
  pp?: number;
}
/** %p 표기 ('+0.8%p') */
export function fmtPp(pp: number | undefined): string {
  return pp !== undefined && finite(pp) ? `${pp > 0 ? '+' : ''}${pp.toFixed(1)}%p` : '—';
}
/** 지표 행 변화 표기: 비율은 %p, 나머지는 상대 증감 % */
export function fmtRowDelta(r: Pick<PromoMetricRow, 'unit' | 'delta' | 'pp'>): string {
  return r.unit === 'ratio' ? fmtPp(r.pp) : fmt.delta(r.delta);
}
/** 판매 채널 비중 (프로모션 기간 vs 직전 동기간) */
export interface ChannelMixRow {
  channel: SalesChannelId;
  name: string;
  colorVar: string;
  isPromo: boolean;
  cur: number;
  prev: number;
  curShare: number;
  prevShare: number;
  /** 비중 변화 (%p) */
  shareDeltaPp: number;
  delta: number;
}
export function channelMix(data: Dataset, promoChannel: SalesChannelId, cur: { from: string; to: string } | null, prev: { from: string; to: string } | null): ChannelMixRow[] {
  const revOf = (r: { from: string; to: string } | null, ch: SalesChannelId) =>
    r ? sum((data?.salesDaily ?? []).filter((x) => x.channel === ch && x.date >= r.from && x.date <= r.to), (x) => x.revenue) : NaN;
  const curRev = SALES_CHANNEL_IDS.map((ch) => revOf(cur, ch));
  const prevRev = SALES_CHANNEL_IDS.map((ch) => revOf(prev, ch));
  const curTotal = sum(curRev, (v) => (finite(v) ? v : 0));
  const prevTotal = sum(prevRev, (v) => (finite(v) ? v : 0));
  return SALES_CHANNEL_IDS.map((ch, k) => {
    const curShare = finite(curRev[k]) && curTotal > 0 ? curRev[k] / curTotal : NaN;
    const prevShare = finite(prevRev[k]) && prevTotal > 0 ? prevRev[k] / prevTotal : NaN;
    return {
      channel: ch, name: SALES_CHANNELS[ch]?.name ?? ch, colorVar: SALES_CHANNELS[ch]?.colorVar ?? '--series-1', isPromo: ch === promoChannel,
      cur: curRev[k], prev: prevRev[k], curShare, prevShare,
      shareDeltaPp: finite(curShare) && finite(prevShare) ? (curShare - prevShare) * 100 : NaN,
      delta: pctDelta(curRev[k], prevRev[k]),
    };
  });
}

export interface PromoReport {
  promotion: Promotion;
  channelName: string;
  phase: PromoPhase;
  ready: boolean;
  period: { from: string; to: string; days: number } | null;
  prev: { from: string; to: string; days: number } | null;
  rows: PromoMetricRow[];
  mix: ChannelMixRow[];
  daily: { idx: number; curDate: string | null; prevDate: string; cur: number; prev: number }[];
  brief: Brief;
  next: string[];
  markdown: string;
}

interface PeriodAgg {
  chRevenue: number; chOrders: number; chVisitors: number; chCvr: number; chAov: number; chAdRev: number;
  totalSales: number; share: number; others: number; adCost: number; adRevenue: number; roas: number; mer: number; brandSearch: number; allAdCost: number;
}
function aggregate(data: Dataset, p: Promotion, from: string, to: string): PeriodAgg {
  const scope = PROMO_CHANNEL_SCOPE[p.channel];
  const sales = (data.salesDaily ?? []).filter((r) => r.date >= from && r.date <= to);
  const ch = sales.filter((r) => r.channel === p.channel);
  const chRevenue = sum(ch, (r) => r.revenue);
  const chOrders = sum(ch, (r) => r.orders);
  const chVisitors = sum(ch, (r) => r.visitors);
  const totalSales = sum(sales, (r) => r.revenue);
  const media = (data.mediaDaily ?? []).filter((r) => r.date >= from && r.date <= to);
  const rel = media.filter((r) => scope?.media.includes(r.media));
  const adCost = sum(rel, (r) => r.cost);
  const adRevenue = sum(rel, (r) => r.revenue);
  const bs = (data.brandSearchDaily ?? []).filter((r) => r.date >= from && r.date <= to);
  return {
    chRevenue, chOrders, chVisitors,
    chCvr: chVisitors > 0 ? (chOrders / chVisitors) * 100 : NaN,
    chAov: chOrders > 0 ? chRevenue / chOrders : NaN,
    chAdRev: sum(ch, (r) => r.adAttributedRevenue),
    totalSales, share: totalSales > 0 ? chRevenue / totalSales : NaN, others: totalSales - chRevenue,
    adCost, adRevenue, roas: adCost > 0 ? (adRevenue / adCost) * 100 : NaN, mer: adCost > 0 ? chRevenue / adCost : NaN,
    brandSearch: bs.length ? mean(bs.map((r) => r.volume)) : NaN,
    allAdCost: sum(media, (r) => r.cost),
  };
}
const pctDelta = (cur: number, prev: number) => (finite(cur) && finite(prev) && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : NaN);

export function fmtMetric(unit: PromoMetricRow['unit'], v: number): string {
  if (!finite(v)) return '—';
  switch (unit) {
    case 'krw': return `${fmt.krw(v)}원`;
    case 'won': return fmt.won(v);
    case 'roas': return fmt.roas(v);
    case 'pct': return fmt.pct(v, 2);
    case 'ratio': return fmt.ratio(v);
    case 'x': return `${v.toFixed(2)}배`;
    default: return fmt.int(v);
  }
}

export function promoReport(data: Dataset, p: Promotion, ctx: { changes?: readonly ChangeRequest[]; incidents?: readonly Incident[] } = {}): PromoReport {
  const phase = promoPhase(p, data.today);
  const scope = PROMO_CHANNEL_SCOPE[p.channel];
  const channelName = SALES_CHANNELS[p.channel]?.name ?? p.channel;
  const yesterday = addDays(data.today, -1);
  const first = data.dates?.[0] ?? data.today;
  const mediaNames = (scope?.media ?? []).map((m) => MEDIA[m].name).join(' · ');
  let period: PromoReport['period'] = null;
  let prev: PromoReport['prev'] = null;
  if (phase !== 'pre') {
    const from = p.start < first ? first : p.start;
    const to = p.end < yesterday ? p.end : yesterday;
    const days = daysBetween(from, to) + 1;
    if (finite(days) && days >= 1) {
      period = { from, to, days };
      const pf = addDays(from, -days);
      const pfrom = pf < first ? first : pf;
      const pdays = daysBetween(pfrom, addDays(from, -1)) + 1;
      prev = pdays >= 1 ? { from: pfrom, to: addDays(from, -1), days: pdays } : null;
    }
  } else {
    const days = Math.max(1, daysBetween(p.start, p.end) + 1);
    const pfrom = addDays(yesterday, -(days - 1));
    prev = { from: pfrom < first ? first : pfrom, to: yesterday, days: daysBetween(pfrom < first ? first : pfrom, yesterday) + 1 };
  }
  const empty: PeriodAgg = { chRevenue: NaN, chOrders: NaN, chVisitors: NaN, chCvr: NaN, chAov: NaN, chAdRev: NaN, totalSales: NaN, share: NaN, others: NaN, adCost: NaN, adRevenue: NaN, roas: NaN, mer: NaN, brandSearch: NaN, allAdCost: NaN };
  const cur = period ? aggregate(data, p, period.from, period.to) : empty;
  const base = prev ? aggregate(data, p, prev.from, prev.to) : empty;
  const per = (v: number, days: number | undefined) => (days && days > 0 ? v / days : NaN);
  const row = (key: string, label: string, c: number, pv: number, unit: PromoMetricRow['unit'], invert = false): PromoMetricRow => ({
    key, label, cur: c, prev: pv, delta: pctDelta(c, pv), unit, invert, pp: unit === 'ratio' && finite(c) && finite(pv) ? (c - pv) * 100 : undefined,
  });
  const rows: PromoMetricRow[] = [
    row('chRevenue', `${channelName} 매출`, cur.chRevenue, base.chRevenue, 'krw'),
    row('chDaily', `${channelName} 일 평균 매출`, per(cur.chRevenue, period?.days), per(base.chRevenue, prev?.days), 'krw'),
    row('chOrders', '주문 수', cur.chOrders, base.chOrders, 'int'),
    row('chCvr', '구매 전환율 (주문/방문)', cur.chCvr, base.chCvr, 'pct'),
    row('chAov', '객단가', cur.chAov, base.chAov, 'won'),
    row('adCost', `관련 매체 광고비 (${scope?.media.map((m) => MEDIA[m].short).join('·') ?? '—'})`, cur.adCost, base.adCost, 'krw', true),
    row('roas', '관련 매체 광고 ROAS', cur.roas, base.roas, 'roas'),
    row('mer', '광고비 대비 채널 실매출', cur.mer, base.mer, 'x'),
    row('share', '전 채널 매출 중 비중', cur.share, base.share, 'ratio'),
    row('totalSales', '전 채널 합산 매출', cur.totalSales, base.totalSales, 'krw'),
    row('others', '다른 채널 매출 (잠식 점검)', cur.others, base.others, 'krw'),
    row('brandSearch', '브랜드 검색량 (일 평균)', cur.brandSearch, base.brandSearch, 'int'),
  ];
  const mix = channelMix(data, p.channel, period, prev);
  const daily: PromoReport['daily'] = [];
  if (prev) {
    const n = period ? period.days : prev.days;
    for (let i = 0; i < n; i++) {
      const curDate = period ? addDays(period.from, i) : null;
      const prevDate = addDays(prev.from, i);
      const rev = (date: string | null) => (date ? sum((data.salesDaily ?? []).filter((r) => r.date === date && r.channel === p.channel), (r) => r.revenue) : NaN);
      daily.push({ idx: i + 1, curDate, prevDate, cur: rev(curDate), prev: rev(prevDate) });
    }
  }

  /* ---- 해석 (규칙 엔진) ---- */
  const d = (k: string) => rows.find((r) => r.key === k)!;
  const facts: string[] = [];
  const patterns: string[] = [];
  const interpretation: string[] = [];
  const conditions: string[] = [];
  const counter: string[] = [];
  const next: string[] = [];
  const guards = dataGuards(data).filter((g) => scope?.media.includes(g.media));
  const checks = checkPromotion(data, p, { changes: ctx.changes, incidents: ctx.incidents });
  if (period && prev) {
    facts.push(`${p.name}(${channelName}, 할인 ${p.discountRate}%) ${fmtDate(period.from)}~${fmtDate(period.to)} ${period.days}일${phase === 'live' ? ' (진행 중 · 어제까지 완료된 일자)' : ''} ${channelName} 매출은 ${fmtMetric('krw', cur.chRevenue)}으로 직전 동기간 ${fmtDate(prev.from)}~${fmtDate(prev.to)} ${fmtMetric('krw', base.chRevenue)} 대비 ${fmt.delta(d('chRevenue').delta)}입니다. 주문 ${fmt.int(cur.chOrders)}건 (${fmt.delta(d('chOrders').delta)}), 객단가 ${fmt.won(cur.chAov)} (${fmt.delta(d('chAov').delta)}). (TEST DATA)`);
    facts.push(`관련 매체(${mediaNames}) 광고비 ${fmtMetric('krw', cur.adCost)} (${fmt.delta(d('adCost').delta)}), 광고 ROAS ${fmt.roas(cur.roas)} (직전 ${fmt.roas(base.roas)}), 광고비 대비 ${channelName} 실매출 ${fmtMetric('x', cur.mer)} (직전 ${fmtMetric('x', base.mer)}).`);
    facts.push(`전 채널 합산 매출 ${fmtMetric('krw', cur.totalSales)} (${fmt.delta(d('totalSales').delta)}) 중 ${channelName} 비중 ${fmt.ratio(cur.share)} (직전 ${fmt.ratio(base.share)}), 다른 채널 매출 ${fmt.delta(d('others').delta)}.`);
    // 요일 패턴
    const byWd = new Map<number, number[]>();
    for (const x of daily) if (x.curDate && finite(x.cur)) { const w = weekday(x.curDate); byWd.set(w, [...(byWd.get(w) ?? []), x.cur]); }
    const wdRank = [...byWd.entries()].map(([w, v]) => ({ w, avg: mean(v) })).sort((a, b) => b.avg - a.avg);
    if (wdRank.length >= 3) {
      const avgAll = mean(daily.filter((x) => finite(x.cur)).map((x) => x.cur));
      patterns.push(`기간 중 일 평균 매출 상위 요일은 ${wdRank.slice(0, 2).map((x) => `${WEEKDAY_KO[x.w]}요일(${fmtMetric('krw', x.avg)}, 평균 대비 ${fmt.delta(pctDelta(x.avg, avgAll))})`).join(', ')}입니다. 관측 범위 ${period.days}일이라 요일별 표본은 1~3일입니다.`);
    }
    const half = Math.floor(daily.length / 2);
    if (half >= 2) {
      const lift = (xs: typeof daily) => pctDelta(sum(xs, (x) => (finite(x.cur) ? x.cur : 0)), sum(xs, (x) => x.prev));
      patterns.push(`직전 동기간 대비 증감은 기간 전반 ${fmt.delta(lift(daily.slice(0, half)))}, 후반 ${fmt.delta(lift(daily.slice(half)))}입니다.`);
    }
    if (finite(d('brandSearch').delta)) patterns.push(`브랜드 검색량 일 평균 ${fmt.int(cur.brandSearch)} (직전 ${fmt.int(base.brandSearch)}, ${fmt.delta(d('brandSearch').delta)}). GFA 집행과 1~2일 시차로 움직이는 데모 구조라 프로모션 단독 효과로 보기 어렵습니다.`);
    // 시즌 자연 증감 분리 (직전 기간 vs 그 이전 기간)
    const p2from = addDays(prev.from, -prev.days);
    const drift = p2from >= (data.dates?.[0] ?? '') ? pctDelta(base.chRevenue, aggregate(data, p, p2from, addDays(prev.from, -1)).chRevenue) : NaN;
    const lift = d('chRevenue').delta;
    if (finite(lift) && finite(drift)) {
      interpretation.push(`직전 동기간 대비 ${fmt.delta(lift)} 중 프로모션 이전 두 기간 사이 자연 증감 ${fmt.delta(drift)}를 빼면 순증은 약 ${(lift - drift).toFixed(1)}%p로 추정됩니다. 10월 이사 · 혼수 시즌 상승분이 섞여 있어 증분 확정에는 홀드아웃 비교가 필요합니다.`);
    }
    const shareUp = cur.share - base.share;
    const othersD = d('others').delta;
    if (finite(shareUp) && finite(othersD)) {
      if (Math.abs(othersD) < MATERIAL_PCT) interpretation.push(`다른 채널 매출 변화 ${fmt.delta(othersD)} (±${MATERIAL_PCT}% 이내)로 채널 간 잠식을 판단할 근거가 부족합니다. 합산 매출 기준(p.41) 증감은 ${fmt.delta(d('totalSales').delta)}입니다.`);
      else interpretation.push(othersD < 0 && lift > 0
        ? `${channelName} 비중이 ${(shareUp * 100).toFixed(1)}%p 늘고 다른 채널 매출이 ${fmt.delta(othersD)} 줄었습니다. 채널 간 이동이 섞였을 수 있으므로 합산 매출 기준(p.41)으로 순증을 판단합니다 (합산 ${fmt.delta(d('totalSales').delta)}).`
        : `다른 채널 매출도 ${fmt.delta(othersD)}로 함께 움직여 채널 간 잠식 신호는 약합니다. 합산 매출 기준 증감은 ${fmt.delta(d('totalSales').delta)}입니다.`);
    }
    const costD = d('adCost').delta, roasD = d('roas').delta;
    if (finite(costD) && finite(roasD)) {
      if (Math.abs(costD) < MATERIAL_PCT && Math.abs(roasD) < MATERIAL_PCT) interpretation.push(`관련 매체 광고비 ${fmt.delta(costD)} · ROAS ${fmt.delta(roasD)}로 둘 다 ±${MATERIAL_PCT}% 이내입니다. 기획전 기간에 광고 집행 강도를 바꾸지 않았다는 뜻이며, 매출 변화는 할인 · 시즌 요인으로 봐야 합니다.`);
      else interpretation.push(roasD < 0 && costD > 0
        ? `광고비가 ${fmt.delta(costD)} 늘어나는 동안 ROAS는 ${fmt.delta(roasD)}로 내려 증액분 효율이 체감되고 있습니다. 다음 증액은 한계 ROAS가 목표 ${AD_PILOT.targetRoas}% 이상인 매체부터가 안전합니다.`
        : `광고비 ${fmt.delta(costD)}에 ROAS ${fmt.delta(roasD)}입니다. 볼륨 확대 여지는 노출 기회 손실이 큰 키워드에 한정됩니다.`);
    }
    conditions.push(`비교 기준: 같은 채널 · 같은 일수의 직전 기간 (${fmtDate(prev.from)}~${fmtDate(prev.to)}). 진행 중 프로모션은 오늘(${data.currentHour}시 기준 부분일)을 제외합니다.`);
    conditions.push(`광고 매출은 매체 귀속 기준, 채널 매출은 판매 채널 집계 기준이며 둘 다 시연용 테스트 데이터입니다. 버티컬 매체는 쿠팡 · 오늘의집 일자별 분리가 없어 합산값입니다.`);
    counter.push(`시즌 수요가 프로모션과 같은 시기에 오르면 직전 동기간 비교는 효과를 과대 추정합니다. 반대로 직전 기간에 다른 할인이 있었다면 과소 추정합니다. 지역 또는 기간 홀드아웃이 있어야 증분 매출을 확정할 수 있습니다.`);
  } else {
    facts.push(`${p.name}은 ${fmtDate(p.start)} 오픈 예정(D-${daysBetween(data.today, p.start)})이라 성과 집계 전입니다. 기준선: 직전 ${prev?.days ?? 0}일(${prev ? `${fmtDate(prev.from)}~${fmtDate(prev.to)}` : '—'}) ${channelName} 매출 ${fmtMetric('krw', base.chRevenue)}, 일 평균 ${fmtMetric('krw', per(base.chRevenue, prev?.days))}, 관련 매체 광고비 ${fmtMetric('krw', base.adCost)} · ROAS ${fmt.roas(base.roas)}. (TEST DATA)`);
    conditions.push('오픈 후 같은 일수의 직전 기간과 비교합니다. 기준선은 오픈 전 최근 기간이며 시즌 변화가 반영되지 않습니다.');
    counter.push('11월 대형 쇼핑 행사 기간과 겹치면 기준선 대비 증감이 프로모션 단독 효과가 아닐 수 있습니다.');
  }
  for (const g of guards) counter.push(`${MEDIA[g.media].name} ${g.label}: ${g.basis}. 오늘 데이터를 포함하면 해당 매체 기여가 과소 집계됩니다.`);

  // 다음 기획에 즉시 반영
  const early = checks.items.filter((i) => i.id.startsWith('budget_pace_') && i.level === 'fail');
  if (early.length) next.push(`오픈 전 ${early.map((i) => i.label.replace(' 일 예산', '')).join(', ')} 일 예산을 사전 승인받습니다 — ${early[0].detail}.`);
  const soldItems = checks.items.filter((i) => i.group === '재고' && (i.level === 'fail' || i.level === 'info') && i.id.startsWith('stock_'));
  if (soldItems.length) next.push(`품절 옵션(${soldItems.map((i) => i.label.split(' · ').pop()).join(', ')}) 입고 확정 전에는 해당 옵션 소재 · 키워드를 기획에서 제외합니다.`);
  const share = d('share');
  if (finite(share.cur) && finite(d('others').delta) && d('others').delta <= -MATERIAL_PCT) next.push(`할인 채널 집중 시 다른 채널 이동분을 차감한 합산 매출 기준으로 할인율을 정합니다 (이번 기간 다른 채널 ${fmt.delta(d('others').delta)}).`);
  if (patterns.length && period) {
    const m = patterns[0].match(/상위 요일은 (.)요일/);
    if (m) next.push(`오픈 · 소재 교체는 매출 상위 요일(${m[1]}요일) 전날까지 반영합니다 (요일별 표본 1~3일 — 다음 기획전에서 재확인).`);
  }
  if (finite(d('roas').delta) && d('roas').delta <= -MATERIAL_PCT) next.push(`기간 증액은 매체별 한계 ROAS 확인 후 목표 ${AD_PILOT.targetRoas}% 이상 매체에만 배정합니다.`);
  if (guards.length) next.push(`${guards.map((g) => MEDIA[g.media].name).join(' · ')} 데이터 이상 구간은 리포트 집계에서 분리 표기하고 정상화 후 재집계합니다.`);
  if (checks.items.some((i) => i.group === '결제 잔액' && i.level === 'fail')) next.push('기획전 오픈 3일 전까지 유입 매체 계정 잔액을 기간 소진분 이상으로 확보합니다 (자동충전 실패 계정 우선).');
  if (!next.length) next.push('이번 기간 점검에서 다음 기획에 반영할 이상 항목이 없습니다. 같은 구성으로 재집행 시 직전 동기간 비교를 유지합니다.');

  const brief: Brief = {
    title: `${p.name} 프로모션 리포트`,
    facts, patterns, interpretation: interpretation.length ? interpretation : ['집계 기간 전이라 해석할 성과가 없습니다. 오픈 전 점검 결과(체크리스트)를 먼저 확인합니다.'],
    conditions, counter,
    actions: next.map((n) => `${n} 담당: PM 제안 → 수면밀도 승인, 다음 기획 회의 전.`),
  };

  const md: string[] = [];
  md.push(`# 프로모션 리포트 · ${p.name}`);
  md.push(`${channelName} · 할인 ${p.discountRate}% · ${period ? `${period.from} ~ ${period.to} (${period.days}일)` : `${p.start} 오픈 예정`} vs 직전 동기간 ${prev ? `${prev.from} ~ ${prev.to}` : '—'} · TEST DATA · 데이터 기준 ${fmtDate(data.today)} ${pad(data.currentHour)}:30`);
  md.push('');
  md.push('### 확정 팩트');
  md.push(`| 지표 | ${period ? '프로모션 기간' : '오픈 전'} | 직전 동기간 | 증감 |`);
  md.push('|---|---|---|---|');
  for (const r of rows) md.push(`| ${r.label} | ${fmtMetric(r.unit, r.cur)} | ${fmtMetric(r.unit, r.prev)} | ${fmtRowDelta(r)} |`);
  md.push('');
  md.push(`| 판매 채널 비중 | ${period ? '프로모션 기간' : '오픈 전'} | 직전 동기간 | 비중 변화 | 매출 증감 |`);
  md.push('|---|---|---|---|---|');
  for (const m of mix) md.push(`| ${m.name}${m.isPromo ? ' (기획전)' : ''} | ${fmt.ratio(m.curShare)} | ${fmt.ratio(m.prevShare)} | ${fmtPp(m.shareDeltaPp)} | ${fmt.delta(m.delta)} |`);
  md.push('');
  md.push(...facts.map((f) => `${f}\n`));
  if (patterns.length) { md.push('### 반복 관측 패턴'); md.push(...patterns.map((x) => `${x}\n`)); }
  md.push('### AI 해석');
  md.push('규칙 엔진 해석입니다. AI 연결 시 화면의 AI 해석 추가로 보강합니다.\n');
  md.push(...brief.interpretation.map((x) => `${x}\n`));
  md.push('### 전제 조건 · 기준값');
  md.push(...conditions.map((x) => `${x}\n`));
  md.push('### 반례 · 대체 시나리오');
  md.push(...counter.map((x) => `${x}\n`));
  md.push('### 다음 액션');
  md.push('다음 기획에 즉시 반영할 항목입니다.\n');
  md.push(...next.map((x) => `- ${x}`));
  return { promotion: p, channelName, phase, ready: !!period, period, prev, rows, mix, daily, brief, next, markdown: md.join('\n') };
}

/** 리포트의 '다음 기획에 즉시 반영' 항목 → 승인 요청 입력 (예산 · 구조 변경: PM 제안 → 수면밀도 승인, 당일 p.53) */
export function promoNextInput(r: Pick<PromoReport, 'promotion' | 'next' | 'channelName'>): ChangeInput | null {
  const items = (r?.next ?? []).filter((x) => x && !/반영할 이상 항목이 없습니다/.test(x));
  if (!items.length) return null;
  return {
    module: 'flow', kind: 'setting',
    target: `${r.promotion.name} 결과 → 다음 기획 반영`,
    targetId: `flow:promo:${r.promotion.id}:next`,
    before: '현재 기획안',
    after: `반영 항목 ${items.length}건`,
    reason: `프로모션 리포트(${r.channelName}) 다음 기획 반영: ${items.join(' / ')}`.slice(0, 600),
    requestedBy: 'MILDO Flow 리포트',
    approver: 'CLIENT',
  };
}

/* ================================================================== */
/* 운영 타임라인: 감지 → 배정 → 조치 → 보고                                 */
/* ================================================================== */

export type OpsStage = 'detect' | 'assign' | 'action' | 'report';
export const OPS_STAGES: { id: OpsStage; label: string; desc: string }[] = [
  { id: 'detect', label: '감지', desc: 'MILDO Alert · AD Pilot 자동 감지' },
  { id: 'assign', label: '배정', desc: '담당 AE + 백업 인지 · 승인 주체 라우팅' },
  { id: 'action', label: '조치', desc: '1차 조치 · 변경 승인 · 반영 · 롤백' },
  { id: 'report', label: '보고', desc: '결과 보고 · 이력 · 재발 방지' },
];
export const STAGE_LABEL: Record<OpsStage, string> = { detect: '감지', assign: '배정', action: '조치', report: '보고' };

export function stageOfIncidentAction(text: string): OpsStage {
  if (/보고|해결|재발|오탐/.test(text)) return 'report';
  if (/감지|탐지|스캔/.test(text)) return 'detect';
  if (/인지|배정|에스컬|당번/.test(text)) return 'assign';
  return 'action';
}
export function stageOfChangeAction(text: string): OpsStage {
  return /요청 생성/.test(text) ? 'assign' : 'action';
}

export interface OpsEvent {
  id: string;
  atMs: number;
  stage: OpsStage;
  source: 'incident' | 'change';
  refId: string;
  title: string;
  action: string;
  by: string;
  note?: string;
  severity?: Incident['severity'];
  status: string;
  auto: boolean;
  seed: boolean;
}
type IncSla = { ackAt?: string; assignedAt?: string; actionAt?: string; reportAt?: string; preventAt?: string; resolvedAt?: string };
export const slaOf = (i: Incident): IncSla => ((i as Incident & { sla?: IncSla }).sla ?? {});
const SYSTEM_RE = /MILDO|AD Pilot|GFA Control|시스템|점검/;

export function opsEvents(incidents: readonly Incident[], changes: readonly ChangeRequest[], toMs: ToMs): OpsEvent[] {
  const out: OpsEvent[] = [];
  for (const i of incidents ?? []) {
    const tl = i.timeline ?? [];
    if (!tl.some((t) => stageOfIncidentAction(t.action) === 'detect')) {
      out.push({ id: `${i.id}#detect`, atMs: toMs(i.detectedAt), stage: 'detect', source: 'incident', refId: i.id, title: i.title, action: '감지', by: 'MILDO Alert', note: i.detectPath, severity: i.severity, status: i.status, auto: true, seed: false });
    }
    tl.forEach((t, k) => {
      out.push({ id: `${i.id}#${k}`, atMs: toMs(t.at), stage: stageOfIncidentAction(t.action), source: 'incident', refId: i.id, title: i.title, action: t.action, by: t.by, severity: i.severity, status: i.status, auto: SYSTEM_RE.test(t.by), seed: false });
    });
  }
  for (const c of changes ?? []) {
    (c.history ?? []).forEach((h, k) => {
      out.push({ id: `${c.id}#${k}`, atMs: toMs(h.at), stage: stageOfChangeAction(h.action), source: 'change', refId: c.id, title: `${c.target} · ${fmtValue(c, c.before)} → ${fmtValue(c, c.after)}`, action: h.action, by: h.by, note: h.note, status: c.status, auto: SYSTEM_RE.test(h.by), seed: isSeed(c) });
    });
  }
  return out.filter((e) => finite(e.atMs)).sort((a, b) => b.atMs - a.atMs);
}

export interface OpsCase {
  incident: Incident;
  stages: { stage: OpsStage; done: boolean; atMs: number | null; note: string }[];
  current: OpsStage | 'done';
  linked: { change: ChangeRequest; inferred: boolean }[];
  next: { id: 'ack' | 'action' | 'report'; label: string; needsNote: boolean } | null;
}
export function linkedChanges(data: Dataset, i: Incident, changes: readonly ChangeRequest[], toMs: ToMs): { change: ChangeRequest; inferred: boolean }[] {
  const det = toMs(i.detectedAt);
  const out: { change: ChangeRequest; inferred: boolean }[] = [];
  for (const c of changes ?? []) {
    const tid = c.targetId ?? '';
    // 명시 연결: MILDO Alert 이슈 드로어 요청('alert:<이슈 id>:…') · 사유에 이슈 id 기록 (Flow 조치 요청)
    if (tid === `alert:${i.id}` || tid.startsWith(`alert:${i.id}:`) || tid.includes(`inc:${i.id}`) || (c.reason ?? '').includes(i.id)) { out.push({ change: c, inferred: false }); continue; }
    const created = toMs(c.createdAt);
    if (!finite(created) || (finite(det) && created < det - 6 * 3_600_000)) continue;
    // 같은 대상(캠페인 · 키워드 · 계정 이름) 또는 매체 단위 이슈(대상 = 매체명)의 같은 매체 변경
    const names = [campaignOfChange(data, c)?.name, keywordOfChange(data, c)?.text, accountOfChange(data, c)?.name].filter(Boolean) as string[];
    const t = i.target ?? '';
    const sameEntity = t.length >= 2 && (names.some((n) => n === t) || (c.target ?? '').startsWith(`${t} `));
    const mediaLevel = !!i.media && i.media in MEDIA && (t === MEDIA[i.media as MediaId].name || t === MEDIA[i.media as MediaId].short);
    const sameMedia = mediaLevel && mediaOfChange(data, c) === i.media;
    if (sameEntity || sameMedia) out.push({ change: c, inferred: true });
  }
  return out;
}
export function incidentNextStep(i: Incident): OpsCase['next'] {
  const sla = slaOf(i);
  if (i.status === 'open') return { id: 'ack', label: '인지 · 배정', needsNote: false };
  if (i.status === 'ack') return { id: 'action', label: '1차 조치 기록', needsNote: true };
  if (i.status === 'action' && !sla.reportAt) return { id: 'report', label: '결과 보고', needsNote: false };
  return null;
}
/** 단계 진행 패치 (MILDO Alert의 sla 기록 필드와 같은 이름 · 데이터 기준 시각) */
export function incidentStagePatch(i: Incident, step: 'ack' | 'action' | 'report', refIso: string, role: string, note = ''): { patch: Partial<Incident>; log: string } {
  const sla = { ...slaOf(i) };
  if (step === 'ack') {
    sla.ackAt = sla.ackAt ?? refIso;
    sla.assignedAt = sla.assignedAt ?? refIso;
    return { patch: { status: 'ack', assignee: i.assignee ?? role, sla } as Partial<Incident>, log: `인지 · 배정 (담당 ${i.assignee ?? role}${i.backup ? ` · 백업 ${i.backup}` : ''}) · MILDO Flow` };
  }
  if (step === 'action') {
    sla.actionAt = sla.actionAt ?? refIso;
    return { patch: { status: 'action', actionNote: note || i.actionNote, sla } as Partial<Incident>, log: `1차 조치 · ${note || '조치 기록'}` };
  }
  sla.reportAt = sla.reportAt ?? refIso;
  return { patch: { sla } as Partial<Incident>, log: '결과 보고 · MILDO Flow 운영 보고 생성' };
}
/** 이슈 → 바로 만들 수 있는 조치 요청 (계정 충전 · 품절 키워드 중지 · 조기 소진 예산) */
export function incidentFix(data: Dataset, i: Incident, changes: readonly ChangeRequest[] = []): { label: string; input: ChangeInput; state: { id: string; status: FlowStatus } | null } | null {
  const t = i.target ?? '';
  // MILDO Alert 이슈 드로어에서 같은 조치를 이미 요청했으면 그 진행 상태를 보여 준다 (중복 요청 방지)
  const viaAlert = (suffix: string) => fixStateOf(changes, `alert:${i.id}:${suffix}`);
  const acc = data?.accounts?.find((a) => a.name === t);
  if (acc && acc.balance >= 0) {
    const bal = effectiveBalance(acc, changes);
    const runway = acc.avgDailySpend > 0 ? bal / acc.avgDailySpend : Infinity;
    const topup = Math.max(0, Math.ceil((acc.avgDailySpend * RUNWAY_TARGET_DAYS - bal) / 100_000) * 100_000);
    if (runway < RUNWAY_TARGET_DAYS && topup > 0) {
      const input: ChangeInput = { module: 'alert', kind: 'setting', target: `${acc.name} 충전`, targetId: topupTargetId(acc), before: bal, after: bal + topup, changePct: bal > 0 ? Math.round((topup / bal) * 1000) / 10 : undefined, reason: `${i.severity} ${i.title} · 잔액 ${runway.toFixed(2)}일치 → ${RUNWAY_TARGET_DAYS}일치 확보 (${fmt.krw(topup)}원) · 결제 수단 수면밀도 (p.50)`, requestedBy: 'MILDO Flow', approver: 'CLIENT' };
      return { label: `충전 요청 ${fmt.krw(topup)}원 (수면밀도)`, input, state: fixStateOf(changes, input.targetId!) ?? viaAlert('topup') };
    }
  }
  const k = data?.keywords?.find((x) => x.text === t);
  if (k && /soldout/.test(i.ruleId) && effectiveKeywordStatus(k, changes) !== 'off') {
    const input: ChangeInput = { module: 'adpilot', kind: 'status', target: `${k.text} 광고 일시 중지`, targetId: k.id, before: 'on', after: 'off', reason: `${i.severity} ${i.title} — 품절 옵션 랜딩 광고비 누수 방지 (p.45)`, requestedBy: 'MILDO Flow', approver: 'PM' };
    return { label: '키워드 일시 중지 요청 (PM)', input, state: fixStateOf(changes, k.id, 'status') ?? viaAlert('pause') };
  }
  const cmp = data?.campaigns?.find((c) => c.name === t);
  if (cmp) {
    const pace = paceCampaign(data, cmp, changes);
    if (pace.level === 'before_peak') {
      const need = Math.ceil(((pace.ratio - 1) * 100) / 5) * 5;
      const input = budgetFix(cmp, need, pace.budget, `${i.severity} ${i.title} · ${pace.basis}`);
      return { label: `일 예산 +${need}% 요청 (${APPROVER_LABEL[input.approver]})`, input, state: fixStateOf(changes, input.targetId!, 'budget') };
    }
  }
  return null;
}
/** 이슈 → 신규 요청 폼 초안 */
export function incidentDraft(data: Dataset, i: Incident): RequestDraft {
  const t = i.target ?? '';
  const k = data?.keywords?.find((x) => x.text === t);
  const cmp = data?.campaigns?.find((c) => c.name === t);
  const media = (i.media && (MEDIA_IDS as string[]).includes(i.media) ? i.media : '') as MediaId | '';
  const base = { ...EMPTY_DRAFT, media, incidentId: i.id, reason: `${i.severity} ${i.title} 조치 — ` };
  if (k) return { ...base, type: 'onoff', media: 'naver_sa', targetId: k.id, toStatus: 'off' };
  if (cmp) return { ...base, type: 'budget', media: cmp.media, targetId: cmp.id, pct: 10 };
  return { ...base, type: 'strategy', targetText: `${t} 대응` };
}

export function opsCases(data: Dataset, incidents: readonly Incident[], changes: readonly ChangeRequest[], toMs: ToMs): OpsCase[] {
  const sevRank = { P1: 0, P2: 1, P3: 2 } as const;
  return (incidents ?? []).map((i) => {
    const sla = slaOf(i);
    const tl = i.timeline ?? [];
    const at = (stage: OpsStage, slaIso?: string) => {
      if (slaIso) return toMs(slaIso);
      const t = tl.find((x) => stageOfIncidentAction(x.action) === stage);
      return t ? toMs(t.at) : null;
    };
    const linked = linkedChanges(data, i, changes, toMs);
    // 조치 완료로 보는 연결 요청: 명시 연결이거나, 같은 대상 · 매체 추정 연결 중 감지 이후 만든 요청만 (감지 전 변경은 원인 후보일 수는 있어도 조치가 아님)
    const det = toMs(i.detectedAt);
    const appliedLink = linked.find((l) => (l.change.status === 'applied' || l.change.status === 'rolled_back')
      && (!l.inferred || (finite(det) && toMs(l.change.createdAt) >= det)));
    const resolved = i.status === 'resolved';
    const assignDone = i.status !== 'open' || !!sla.ackAt;
    const actionDone = i.status === 'action' || resolved || !!sla.actionAt || !!appliedLink;
    const reportDone = !!sla.reportAt || resolved;
    const stages: OpsCase['stages'] = [
      { stage: 'detect', done: true, atMs: toMs(i.detectedAt), note: i.detectPath },
      { stage: 'assign', done: assignDone, atMs: assignDone ? at('assign', sla.ackAt) : null, note: `담당 ${i.assignee ?? '미지정'}${i.backup ? ` · 백업 ${i.backup}` : ''}${assignDone ? '' : ' · 자동 배정 · 인지 대기'}` },
      { stage: 'action', done: actionDone, atMs: actionDone ? (at('action', sla.actionAt) ?? (appliedLink ? toMs(appliedIso(appliedLink.change)) : null)) : null, note: i.actionNote ?? (appliedLink ? `${appliedLink.change.target} ${STATUS_META[appliedLink.change.status].label}` : linked.length ? `연결 요청 ${linked.length}건 (${linked.map((l) => STATUS_META[l.change.status].short).join(' · ')})` : (i.autoActions ?? []).join(' · ') || '조치 대기') },
      { stage: 'report', done: reportDone, atMs: reportDone ? at('report', sla.reportAt ?? sla.resolvedAt) : null, note: resolved ? '해결' : reportDone ? '결과 보고 완료' : '결과 보고 대기' },
    ];
    const cur = stages.find((s) => !s.done);
    return { incident: i, stages, current: cur ? cur.stage : 'done', linked, next: incidentNextStep(i) } as OpsCase;
  }).sort((a, b) => {
    const ra = a.current === 'done' ? 1 : 0, rb = b.current === 'done' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return sevRank[a.incident.severity] - sevRank[b.incident.severity];
  });
}
export function stageCounts(cases: readonly OpsCase[]): Record<OpsStage | 'done', number> {
  const out: Record<OpsStage | 'done', number> = { detect: 0, assign: 0, action: 0, report: 0, done: 0 };
  for (const c of cases) out[c.current]++;
  return out;
}

/** 운영 보고 (감지 → 배정 → 조치 → 보고 한 건) 마크다운 */
export function caseReport(c: OpsCase): string {
  const i = c.incident;
  const lines = [
    `# 운영 보고 · ${i.severity} ${i.title}`,
    `${i.isTest ? '테스트 이슈 · ' : ''}TEST DATA · 대상 ${i.target ?? '—'} · 매체 ${mediaName(i.media ?? null)}`,
    '',
    '| 단계 | 시각 | 내용 |',
    '|---|---|---|',
    ...c.stages.map((s) => `| ${STAGE_LABEL[s.stage]} | ${s.done ? fmtStamp(s.atMs ?? NaN) : '대기'} | ${s.note.replace(/\|/g, '/')} |`),
    '',
    '### 확정 팩트',
    `감지 경로: ${i.detectPath}. ${i.metric ? `지표 ${i.metric} 관측 ${finite(i.observed) ? fmt.int(i.observed!) : '—'} · 기준 ${finite(i.baseline) ? fmt.int(i.baseline!) : '—'}${finite(i.deltaPct) ? ` (${fmt.delta(i.deltaPct!)})` : ''}.` : ''}`,
    (i.autoActions ?? []).length ? `자동 조치: ${(i.autoActions ?? []).join(' · ')}.` : '',
    '',
    '### 조치 · 변경 요청',
    ...(c.linked.length ? c.linked.map((l) => `- ${l.change.target}: ${fmtValue(l.change, l.change.before)} → ${fmtValue(l.change, l.change.after)} · ${STATUS_META[l.change.status].label} · 승인 주체 ${APPROVER_LABEL[l.change.approver]}${l.inferred ? ' · 관련 추정(같은 매체 · 대상)' : ''}`) : ['- 연결된 변경 요청 없음']),
    '',
    '### 원인 후보',
    (i.causeCandidates ?? []).length ? (i.causeCandidates ?? []).join(' · ') : '확인 중',
  ];
  return lines.filter((l, k, arr) => !(l === '' && arr[k - 1] === '')).join('\n');
}

/* ================================================================== */
/* 반복 구간 축소 (p.31) — 이번 세션 실측                                   */
/* ================================================================== */

export function segmentRows(input: { summary: FlowSummary; checks: readonly PromoCheck[]; reportsReady: number; comments: number }) {
  const { summary, checks, reportsReady, comments } = input;
  const fails = sum(checks, (c) => c.counts.fail);
  const itemCount = sum(checks, (c) => c.items.length);
  const live: Record<string, { value: string; route: string; tab?: string }> = {
    '데이터 요청': { value: 'MILDO Board에서 6개 매체 · 4개 판매 채널 직접 조회', route: 'board' },
    '보고 · 피드백': { value: `리포트 코멘트 · 피드백 ${comments}건 기록`, route: 'reports' },
    '예산 · 세팅 변경': { value: `요청 ${summary.total}건 (반영 ${summary.byStatus.applied} · 롤백 ${summary.byStatus.rolled_back} · 보류 ${summary.byStatus.held}) · 평균 결정 ${fmtDuration(summary.avgDecisionMin)} · p.53 기준 충족 ${fmt.ratio(summary.metRate, 0)}`, route: 'flow', tab: 'board' },
    '프로모션 준비': { value: `${checks.length}개 프로모션 · 점검 ${itemCount}항목 자동 · 실패 ${fails}건 탐지`, route: 'flow', tab: 'promo' },
    '프로모션 결과': { value: `리포트 ${reportsReady}개 자동 생성 · 다음 기획 반영 포인트 포함`, route: 'flow', tab: 'report' },
  };
  return FLOW_SEGMENTS.map((s) => ({ ...s, live: live[s.seg] ?? { value: '—', route: 'flow' } }));
}

/* ================================================================== */
/* 시연용 시드 이력 (TEST DATA · 데이터에서 계산)                            */
/* ================================================================== */

export function seedChanges(data: Dataset): ChangeRequest[] {
  if (!data?.keywords?.length || !data?.campaigns?.length) return [];
  const T = data.today;
  const d1 = addDays(T, -1), d2 = addDays(T, -2), d3 = addDays(T, -3);
  const at = (date: string, h: number, m: number) => kstIso(date, h, m);
  const out: ChangeRequest[] = [];
  const mk = (n: number, c: Omit<ChangeRequest, 'id'>) => out.push({ id: `${SEED_PREFIX}${n}`, ...c });
  const roasOf = (k: Keyword) => (k.last14.cost > 0 ? (k.last14.revenue / k.last14.cost) * 100 : NaN);
  const star = data.keywords.filter((k) => !k.isBrand && k.status === 'on' && k.impressionShareLost >= AD_PILOT.lostShareTrigger).sort((a, b) => roasOf(b) - roasOf(a))[0];
  // 최근 3일 CPC 급등 키워드 (직전 11일 대비 +50% 이상) — '매트리스 추천' 시나리오
  const spiky = data.keywords.filter((k) => !k.isBrand && k.status === 'on' && (k.daily?.length ?? 0) >= 6).map((k) => {
    const r = k.daily.slice(-3), b = k.daily.slice(0, -3);
    const cpc = (xs: typeof r) => sum(xs, (x) => x.cost) / Math.max(1, sum(xs, (x) => x.clicks));
    const cv = (xs: typeof r) => sum(xs, (x) => x.conversions) / Math.max(1, xs.length);
    return { k, cpcDelta: (cpc(r) / cpc(b) - 1) * 100, convDelta: cv(b) > 0 ? (cv(r) / cv(b) - 1) * 100 : NaN };
  }).filter((x) => finite(x.cpcDelta) && x.cpcDelta >= AD_PILOT.anomalyHoldPct).sort((a, b) => b.cpcDelta - a.cpcDelta)[0];
  const test = data.keywords.find((k) => k.status === 'test' && k.prev14.impressions > 0);
  const gfaPro = data.campaigns.find((c) => c.media === 'naver_gfa' && /Prospecting/.test(c.name)) ?? data.campaigns.find((c) => c.media === 'naver_gfa');
  const kakaoPromo = data.campaigns.find((c) => c.media === 'kakao' && /프로모션/.test(c.name)) ?? data.campaigns.find((c) => c.media === 'kakao');
  const paces = data.campaigns.map((c) => paceCampaign(data, c));
  const saEarly = paces.find((x) => x.campaign.media === 'naver_sa' && x.level === 'before_peak');
  const metaEarly = paces.find((x) => x.campaign.media === 'meta' && x.level !== 'ok' && x.level !== 'off');
  const gfaAcc = data.accounts.find((a) => a.media === 'naver_gfa' && a.balance >= 0);
  const term = [...(data.searchTerms ?? [])].filter((t) => !t.registered && t.conversions > 0).sort((a, b) => b.conversions - a.conversions)[0];
  const promoLive = (data.promotions ?? []).find((p) => promoPhase(p, T) === 'live' && daysBetween(T, p.end) <= 3 && p.channel === 'brandstore') ?? (data.promotions ?? []).find((p) => promoPhase(p, T) === 'live');
  const guards = dataGuards(data);
  const gfaPace = monthlyPacing(data).find((m) => m.media === 'naver_gfa');

  /** 변경 폭 → 위임 범위 승인 주체 · 승인자 역할명 · 근거 (시드도 같은 규칙으로 라우팅) */
  const routeOf = (pct: number) => {
    const row = GFA_DELEGATION[delegationIndexByPct(pct)];
    return { approver: row.approver, by: APPROVER_LABEL[row.approver], note: `변경 폭 ${fmt.delta(pct, 1)} · 위임 범위 ${row.range.split(' · ')[0].replace('일 예산 ', '')} → ${row.label} (p.15)` };
  };
  if (star) {
    const after = star.bid;
    const before = Math.max(70, round(after / 1.12, 10));
    const pct = Math.round(((after - before) / before) * 1000) / 10;
    const r = routeOf(pct);
    mk(1, { createdAt: at(d3, 10, 5), module: 'adpilot', kind: 'bid', target: `${star.text} 입찰가`, targetId: `seed:bid:${star.id}`, before, after, changePct: pct, reason: `고효율 키워드 (14일 ROAS ${fmt.roas(roasOf(star))} ≥ 목표 ${AD_PILOT.targetRoas}% × ${AD_PILOT.highEfficiencyRoasRatio}) · 노출 기회 손실 ${fmt.ratio(star.impressionShareLost, 0)} ≥ 25% → 입찰 상향 (p.14)`, requestedBy: 'AD Pilot', approver: r.approver, status: 'applied',
      history: [
        { at: at(d3, 10, 5), by: 'AD Pilot', action: '요청 생성', note: '고효율 · 노출 기회 손실 규칙' },
        { at: at(d3, 10, 41), by: r.by, action: '승인', note: r.note },
        { at: at(d3, 10, 52), by: r.by, action: '반영', note: 'AD Pilot 반영 · 롤백 가능' },
      ] });
  }
  if (spiky) {
    const k = spiky.k;
    const before = k.bid;
    const after = Math.max(70, round(before * 1.08, 10));
    const pct = Math.round(((after - before) / before) * 1000) / 10;
    const r = routeOf(pct);
    mk(2, { createdAt: at(d3, 15, 20), module: 'adpilot', kind: 'bid', target: `${k.text} 입찰가`, targetId: `seed:bid:${k.id}`, before, after, changePct: pct, reason: `비교 · 검토 의도 순위 방어 — 평균 순위 ${k.avgRank.toFixed(1)}위 · 노출 기회 손실 ${fmt.ratio(k.impressionShareLost, 0)} (p.14)`, requestedBy: 'AD Pilot', approver: r.approver, status: 'rolled_back',
      history: [
        { at: at(d3, 15, 20), by: 'AD Pilot', action: '요청 생성', note: '순위 방어' },
        { at: at(d3, 15, 38), by: r.by, action: '승인', note: r.note },
        { at: at(d3, 15, 46), by: r.by, action: '반영' },
        { at: at(d1, 9, 18), by: 'PM', action: '롤백', note: `반영 후 최근 3일 CPC ${fmt.delta(spiky.cpcDelta, 0)} · 전환 ${fmt.delta(spiky.convDelta, 0)} (직전 11일 대비) — 경쟁사 입찰 상승 추정 · 직전 입찰 ${fmt.won(before)} 복원 후 자동 조정 보류` },
      ] });
  }
  if (gfaPro) {
    const before = gfaPro.dailyBudget;
    const after = round(before * 1.35, 10_000);
    mk(3, { createdAt: at(d2, 16, 10), module: 'gfa', kind: 'budget', target: `${gfaPro.name} 일 예산`, targetId: `seed:gfa:${gfaPro.id}`, before, after, changePct: 35, reason: '신규 수요 환기 · 브랜드 검색 동행 구간 확대 — 30% 초과 → 수면밀도 승인 (p.15)', requestedBy: 'GFA Control', approver: 'CLIENT', status: 'rejected',
      history: [
        { at: at(d2, 16, 10), by: 'GFA Control', action: '요청 생성', note: 'PM 제안 · 30% 초과' },
        { at: at(d1, 10, 32), by: '수면밀도', action: '반려', note: gfaPace?.status === 'over' ? `월 예산 초과 페이스 (예상 ${fmt.krw(gfaPace.projected)} / 예산 ${fmt.krw(gfaPace.budget)}) — 11월 기획전 이후 재검토` : '신규 CPA 근거 보완 후 11월 기획전 기간에 재요청' },
      ] });
  }
  if (test) {
    mk(4, { createdAt: at(d1, 11, 0), module: 'lab', kind: 'keyword_add', target: `${test.text} 테스트 그룹 등록`, targetId: `seed:lab:${test.id}`, before: '미등록', after: `${test.adgroup} · 입찰 상한 ${fmt.won(test.maxBid)}`, reason: '구문형 후보 · 생활 상황 의도 — 14일 또는 최소 클릭 100 테스트 (p.26)', requestedBy: 'MILDO Lab', approver: 'AE', status: 'applied',
      history: [
        { at: at(d1, 11, 0), by: 'MILDO Lab', action: '요청 생성' },
        { at: at(d1, 11, 18), by: '담당 AE', action: '승인', note: '승인 범위 내 운영 조정' },
        { at: at(d1, 11, 26), by: '담당 AE', action: '반영' },
      ] });
  }
  if (promoLive) {
    mk(5, { createdAt: at(T, 9, 40), module: 'flow', kind: 'setting', target: `${promoLive.name} 종료 시각 소재 교체 예약`, targetId: `flow:promo:${promoLive.id}:endswap`, before: `기획전 소재 (${promoLive.discountRate}%)`, after: `${fmtDate(promoLive.end)} 23:59 기본 소재 복귀`, reason: `종료 D-${daysBetween(T, promoLive.end)} · 종료 후 할인 문구 노출 방지 (p.45 가격 · 프로모션 불일치)`, requestedBy: '담당 AE', approver: 'AE', status: 'approved',
      history: [
        { at: at(T, 9, 40), by: '담당 AE', action: '요청 생성', note: '프로모션 체크리스트 · 종료 소재 교체' },
        { at: at(T, 10, 6), by: 'PM', action: '승인' },
      ] });
  }
  if (kakaoPromo) {
    const before = kakaoPromo.dailyBudget;
    const after = round(before * 1.15, 10_000);
    const tb = guards.find((g) => g.media === kakaoPromo.media && g.kind === 'tracking_break');
    mk(6, { createdAt: at(T, 13, 42), module: 'adpilot', kind: 'budget', target: `${kakaoPromo.name} 일 예산`, targetId: `seed:budget:${kakaoPromo.id}`, before, after, changePct: 15, reason: '기획전 리마케팅 확대 — 장바구니 방문자 증가', requestedBy: 'AD Pilot', approver: 'PM', status: 'held',
      history: [
        { at: at(T, 13, 42), by: 'AD Pilot', action: '요청 생성' },
        { at: at(T, 14, 2), by: 'PM', action: '승인' },
        { at: at(T, 15, 12), by: 'MILDO Flow', action: '실행 보류', note: tb ? `전환 추적 단절 의심 — ${tb.basis} · 자동 조정 보류 (p.45)` : '실행 점검 보류' },
      ] });
  }
  if (saEarly) {
    const before = saEarly.budget;
    const after = round(before * 1.2, 10_000);
    const np = paceCampaign(data, saEarly.campaign, [], after);
    mk(7, { createdAt: at(T, 14, 20), module: 'adpilot', kind: 'budget', target: `${saEarly.campaign.name} 일 예산`, targetId: `budget:${saEarly.campaign.id}:`, before, after, changePct: 20, reason: `일 예산 조기 소진 예상 — ${saEarly.basis}. +20% (PM 위임 상한 30% 내) 시 예상 마감 ${np.exhaustHour === null ? '일 예산 내' : fmtHour(np.exhaustHour)} · 부족분은 시간대 입찰 조정으로 보완`, requestedBy: 'AD Pilot', approver: 'PM', status: 'pending',
      history: [{ at: at(T, 14, 20), by: 'AD Pilot', action: '요청 생성', note: '일 예산 조기 소진 규칙 (p.14)' }] });
  }
  if (metaEarly) {
    const meta = (data.mediaDaily ?? []).filter((r) => r.media === metaEarly.campaign.media && r.date < T && r.date >= addDays(T, -7));
    const cpc = sum(meta, (r) => r.cost) / Math.max(1, sum(meta, (r) => r.clicks));
    const cap = round(cpc * 1.1, 10);
    const spike = guards.find((g) => g.media === metaEarly.campaign.media && g.kind === 'spend_spike');
    mk(8, { createdAt: at(T, 14, 52), module: 'alert', kind: 'setting', target: `${metaEarly.campaign.name} 시간대 입찰 상한`, targetId: `seed:cap:${metaEarly.campaign.id}`, before: '자동 입찰 (상한 없음)', after: `16~23시 CPC 상한 ${fmt.won(cap)}`, reason: `${spike ? spike.basis : '광고비 급변'} · ${metaEarly.basis} — 최근 7일 평균 CPC ${fmt.won(cpc)} × 1.1 상한으로 저녁 피크 노출 확보`, requestedBy: 'MILDO Alert', approver: 'AE', status: 'pending',
      history: [{ at: at(T, 14, 52), by: 'MILDO Alert', action: '요청 생성', note: '데이터 급변 P2 · 1시간 내 원인 보고' }] });
  }
  if (gfaAcc) {
    const runway = gfaAcc.avgDailySpend > 0 ? gfaAcc.balance / gfaAcc.avgDailySpend : Infinity;
    const topup = Math.max(0, Math.ceil((gfaAcc.avgDailySpend * RUNWAY_TARGET_DAYS - gfaAcc.balance) / 100_000) * 100_000);
    if (runway < RUNWAY_TARGET_DAYS && topup > 0) {
      mk(9, { createdAt: at(T, 15, 2), module: 'alert', kind: 'setting', target: `${gfaAcc.name} 충전`, targetId: topupTargetId(gfaAcc), before: gfaAcc.balance, after: gfaAcc.balance + topup, changePct: Math.round((topup / Math.max(1, gfaAcc.balance)) * 1000) / 10, reason: `잔액 ${runway.toFixed(2)}일치 · 자동충전 ${AUTO_CHARGE_LABEL[gfaAcc.autoCharge]} → ${RUNWAY_TARGET_DAYS}일치 확보 (${fmt.krw(topup)}원) · 결제 수단 수면밀도 (p.50)`, requestedBy: 'MILDO Alert', approver: 'CLIENT', status: 'pending',
        history: [{ at: at(T, 15, 2), by: 'MILDO Alert', action: '요청 생성', note: 'P1 계정 · 결제' }] });
    }
  }
  if (term) {
    mk(10, { createdAt: at(T, 15, 15), module: 'lab', kind: 'keyword_add', target: `${term.term} 테스트 그룹 등록`, targetId: `seed:term:${slug(term.term)}`, before: '미등록', after: 'TEST 그룹 · 입찰 상한 내', reason: `검색어 보고서 미등록 · 전환 ${fmt.dec1(term.conversions)}건 · 클릭 ${fmt.int(term.clicks)} — 신규 구매 의도 후보 (p.14 · p.26)`, requestedBy: 'MILDO Lab', approver: 'AE', status: 'pending',
      history: [{ at: at(T, 15, 15), by: 'MILDO Lab', action: '요청 생성', note: '검색어 보고서 신규 후보' }] });
  }
  return out;
}

/* ================================================================== */
/* 규칙 기반 브리프 (AI 미연결)                                           */
/* ================================================================== */

export function pendingBrief(data: Dataset, changes: readonly ChangeRequest[], incidents: readonly Incident[], role: string, nowMs: number, toMs: ToMs): Brief {
  const s = flowSummary(changes, role, nowMs, toMs, data.today);
  const q = s.queue;
  const facts = [
    `요청 · 승인 · 반영 이력 ${s.total}건: 승인 대기 ${s.byStatus.pending} · 승인(반영 대기) ${s.byStatus.approved} · 반영 ${s.byStatus.applied} · 반려 ${s.byStatus.rejected} · 롤백 ${s.byStatus.rolled_back} · 보류 ${s.byStatus.held}.${s.seeds ? ` 이 중 ${s.seeds}건은 시연용 이력(TEST DATA)입니다.` : ''}`,
    `현재 역할 ${role}(승인 범위 ${roleScopeLabel(role)}) 기준 처리할 것: 승인 ${q.approve.length}건 · 반영 ${q.apply.length}건 · 보류 판단 ${q.held.length}건. 권한 밖 승인 대기 ${q.blocked.length}건${q.blocked.length ? ` (${q.blocked.map((c) => `${c.target} → ${APPROVER_LABEL[c.approver]}`).join(', ')})` : ''}.`,
  ];
  if (q.approve.length) facts.push(`승인 대기 목록: ${q.approve.map((c) => `${c.target} ${fmtValue(c, c.before)} → ${fmtValue(c, c.after)}${finite(c.changePct ?? NaN) ? ` (${fmt.delta(c.changePct!)})` : ''} · ${leadState(c, nowMs, toMs).text}`).join(' / ')}.`);
  const patterns: string[] = [];
  if (finite(s.avgDecisionMin)) patterns.push(`결정까지 평균 ${fmtDuration(s.avgDecisionMin)}, p.53 소요 기준 충족률 ${fmt.ratio(s.metRate, 0)} (결정 ${s.decided}건 기준).`);
  if (s.overdue.length) patterns.push(`기준 시간을 넘긴 대기 ${s.overdue.length}건: ${s.overdue.map((c) => `${c.target}(${decisionOf(c).row.lead})`).join(', ')}.`);
  const held = changes.filter((c) => c.status === 'held');
  if (held.length) patterns.push(`보류 ${held.length}건 (실행 점검 보류 또는 결정 보류): ${held.map((c) => `${c.target} — ${lastHistory(c, /보류/)?.note ?? '사유 기록 없음'}`).join(' / ')}.`);
  const bulkAlerts = bulkChangeAlerts(changes, data.today, incidents);
  if (bulkAlerts.length) facts.push(`대량 변경 실수 감지 ${bulkAlerts.length}건 (MILDO Alert 기준 · p.45): ${bulkAlerts.map((b) => `${b.title} — ${b.basis}`).join(' / ')}.`);
  const interpretation: string[] = [];
  const blockedApply = q.apply.map((c) => ({ c, ex: executionCheck(data, changes, incidents, c) })).filter((x) => !x.ex.ok);
  if (blockedApply.length) interpretation.push(`반영 대기 중 ${blockedApply.length}건은 지금 반영하면 실행 점검에서 보류됩니다 (${blockedApply.map((x) => `${x.c.target}: ${x.ex.blocks[0]}`).join(' / ')}). 결제 · 데이터 이상이 정상화된 뒤 반영하는 순서가 안전합니다.`);
  interpretation.push(`승인 순서는 지출 증가 · 노출 손실과 직결된 건(조기 소진 예산, 잔액 충전)을 먼저, 테스트 등록 · 소재 교체처럼 손실이 누적되지 않는 건을 뒤에 둡니다. 증액은 해당 매체에 전환 추적 · 급변 이슈가 없을 때만 의미가 있습니다.`);
  return {
    title: `승인 대기 · ${role} 기준`,
    facts, patterns, interpretation,
    conditions: [`권한: 담당 AE는 AE건, PM은 AE · PM건, 수면밀도는 전부 (p.53). 위임 범위: 일 예산 ±10% 이내 AE · ±10~30% · ON/OFF PM · 30% 초과 · 신규 캠페인 수면밀도 (p.15, 예시 · 계약 시 확정).`, `소요 기준: 운영 조정 즉시(60분, 운영 기본값) · 예산 · 구조 변경 당일 17:00 · 알림 기준 주간 · 전략 방향 월간 리뷰.`],
    counter: ['승인 대기가 길어지는 원인이 승인 주체 부재(휴가 · 주말)라면 처리 속도가 아니라 백업 지정 문제입니다. 주말에는 당번 AE가 AE건만 처리할 수 있어 PM · 수면밀도 건은 다음 영업일로 넘어갑니다.'],
    actions: [
      ...(bulkAlerts.length ? [`PM: 대량 변경 감지 ${bulkAlerts.length}건의 관련 요청을 건별로 확인하고, 잘못 반영된 건은 최신 건부터 롤백합니다 (p.45 즉시 롤백).`] : []),
      q.approve.length ? `${role}: 승인 대기 ${q.approve.length}건을 오늘 처리하고, 권한 밖 ${q.blocked.length}건은 승인 주체에게 메신저로 전달합니다.` : `${role}: 승인할 건이 없습니다. 권한 밖 ${q.blocked.length}건의 승인 주체 응답을 확인합니다.`,
      blockedApply.length ? 'PM: 실행 보류 예상 건은 계정 충전 · 추적 정상화 확인 후 반영합니다.' : '담당 AE: 승인된 건을 반영하고 반영 후 1시간 성과를 확인합니다.',
    ],
  };
}

export function promoCheckBrief(data: Dataset, changes: readonly ChangeRequest[], incidents: readonly Incident[]): Brief {
  const checks = checkAllPromotions(data, { changes, incidents });
  const facts = checks.map((c) => `${c.promotion.name}(${c.channelName} · ${c.phaseLabel}${c.phase === 'pre' ? ` D-${c.dday}` : c.phase === 'live' ? ` · 종료 D-${c.dday}` : ''}): ${c.verdict.label} — 실패 ${c.counts.fail} · 주의 ${c.counts.warn} · 통과 ${c.counts.pass}. (TEST DATA)`);
  const fails = checks.flatMap((c) => c.items.filter((i) => i.level === 'fail').map((i) => ({ c, i })));
  const byGroup = new Map<string, number>();
  for (const f of fails) byGroup.set(f.i.group, (byGroup.get(f.i.group) ?? 0) + 1);
  const patterns = [
    byGroup.size ? `실패 항목은 ${[...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}건`).join(' · ')}에 몰려 있습니다.` : '실패 항목이 없습니다.',
    ...fails.slice(0, 6).map((f) => `${f.c.promotion.name} · ${f.i.group} · ${f.i.label}: ${f.i.detail}`),
  ];
  const open = fails.filter((f) => f.i.fix && !f.i.fixState).length;
  return {
    title: '프로모션 오픈 전 자동 점검',
    facts,
    patterns,
    interpretation: [
      `실패 중 조치 요청이 아직 없는 항목이 ${open}건입니다. 재고 · 계정 상태처럼 광고 설정으로 풀 수 없는 항목은 수면밀도 확인이 먼저이고, 예산 · 문구 · 랜딩 항목은 승인 요청으로 바로 넘길 수 있습니다.`,
      '진행 중 기획전의 조기 소진은 피크 시간대 노출 손실로 이어져 할인 매출이 회수되지 않는 구간을 만듭니다. 오픈 전 기획전은 직전 기획전의 광고비 증감을 기간 예산 사전 승인의 참고값으로 씁니다.',
    ],
    conditions: [`가격 대조: 판매가 × (1 − 할인율) · 허용 오차 ±${PRICE_TOLERANCE_PCT}%. 조기 소진: 시간대 가중 예상 마감이 매출 피크 시각 전. 잔액: 1일치 미만 · 자동충전 실패 = P1 (p.44), 확보 목표 ${RUNWAY_TARGET_DAYS}일치 또는 기획전 잔여 일수.`],
    counter: ['소재 문구 · 랜딩 · 재고는 데모 등록 정보 기준입니다. 실제 운영에서는 매체 검수 상태와 판매 채널 재고 연동 여부에 따라 결과가 달라집니다.'],
    actions: fails.slice(0, 5).map((f) => `${f.c.promotion.name} ${f.i.label}: ${f.i.action}${f.i.fixState ? ` (요청 ${STATUS_META[f.i.fixState.status].label})` : ''}.`),
  };
}

/** p.49 SLA 표기 — constants SLA에서 생성 (화면 · 브리프 · 에이전트 공용) */
export function slaText(): string {
  return `P1 인지 ${SLA.P1.label.ack} · 1차 조치 ${SLA.P1.label.action} · 결과 보고 ${SLA.P1.label.report}, P2 인지 ${SLA.P2.label.ack} · 조치 ${SLA.P2.label.action} · 보고 ${SLA.P2.label.report}`;
}

export function opsBrief(data: Dataset, incidents: readonly Incident[], changes: readonly ChangeRequest[], toMs: ToMs): Brief {
  const cases = opsCases(data, incidents, changes, toMs);
  const sc = stageCounts(cases);
  const open = cases.filter((c) => c.current !== 'done');
  const p1Wait = open.filter((c) => c.incident.severity === 'P1' && c.linked.some((l) => l.change.status === 'pending'));
  return {
    title: '운영 프로세스 · 감지 → 배정 → 조치 → 보고',
    facts: [
      `이슈 ${cases.length}건 중 현재 단계: 배정(인지 대기) ${sc.assign} · 조치 ${sc.action} · 보고 ${sc.report} · 완료 ${sc.done}. (TEST DATA)`,
      ...open.slice(0, 5).map((c) => `${c.incident.severity} ${c.incident.title}: ${STAGE_LABEL[c.current as OpsStage] ?? '완료'} 단계 · ${c.stages.find((s) => s.stage === 'action')?.note ?? ''}`),
    ],
    patterns: [`연결된 변경 요청이 있는 이슈 ${cases.filter((c) => c.linked.length).length}건 — 조치가 승인 흐름(MILDO Flow)으로 넘어간 건입니다.`],
    interpretation: p1Wait.length
      ? [`P1 ${p1Wait.length}건(${p1Wait.map((c) => c.incident.title).join(', ')})은 조치 요청이 승인 대기(${p1Wait.flatMap((c) => c.linked.filter((l) => l.change.status === 'pending').map((l) => `${l.change.target} → ${APPROVER_LABEL[l.change.approver]}`)).join(', ')})에 걸려 있어 1차 조치 SLA ${SLA.P1.label.action}을 넘길 수 있습니다. 승인 주체가 수면밀도인 건은 요청 생성과 동시에 메신저로 전달해야 병목이 줄어듭니다.`]
      : [`승인 대기에 걸린 P1 조치 요청은 없습니다. P1은 1차 조치 SLA ${SLA.P1.label.action} 기준이라 조치가 승인 흐름으로 넘어가는 순간 승인 주체 응답 시간이 SLA를 좌우합니다.`],
    conditions: [`SLA: ${slaText()} (p.49).`],
    counter: ['연결 요청 중 \'관련 추정\'은 같은 매체 · 대상 기준 추정 연결입니다. 실제 원인 조치가 아닐 수 있습니다.'],
    actions: open.slice(0, 4).map((c) => `${c.incident.assignee ?? '담당 AE'}: ${c.incident.title} — ${c.next ? c.next.label : 'MILDO Alert에서 해결 · 재발 방지 기록'}.`),
  };
}
