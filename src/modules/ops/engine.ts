/**
 * 전담 TF · 온보딩 · 계약 · RFP 커버리지 엔진 (순수 함수 · React 없음) — 제안서 p.48, p.50–59 · RFP
 *
 *  - TF 명단 검증(실명 · 연차 · 투입률 미입력 · 오입력) · 1:1 백업 그래프(상호 백업 · 단방향 · 공백 · 집중)
 *  - 휴가 시뮬레이터: 부재 인원 업무가 백업 체인으로 넘어갈 때 합산 투입률 과부하 · 응답 공백 · 당번 충돌
 *  - 주말 · 공휴일 당번 순번 (MILDO Alert와 같은 규칙)
 *  - 계정 · 결제 · 권한 구조(p.50) 데이터 점검
 *  - 90일 온보딩 날짜 환산 · 성과 기준선
 *  - 레퍼런스 빈칸 · 침구 카테고리 월 합산 대조
 *  - 수수료 · 계약 계산기 (연 50억 배분 p.37 기준)
 *  - RFP 커버리지 맵 · 평가 비중 준비도 · 선정 일정 D-day
 * 모든 날짜 판단은 Dataset 기준일(today · currentHour)을 쓴다.
 */
import type { AdAccount, ChangeRequest, Dataset } from '@/core/types';
import type { Brief } from '@/ai/prompts';
import {
  CONTRACT_TERMS, DECISION_MATRIX, MEDIA, MEDIA_IDS, ONBOARDING_GANTT, ONBOARDING_MILESTONES, ONBOARDING_PHASES, OWNERSHIP, RFP, SALES_CHANNELS, TF_ROLES,
} from '@/data/constants';
import { mediaRows, rangeOf, totalsOf } from '@/core/selectors';
import { addDays, fmt, isOffDay, KR_HOLIDAYS, WEEKDAY_KO } from '@/core/util';
import {
  BASELINE_TOLERANCE_PCT, BEDDING_MATCH_TOLERANCE_PCT, BEDDING_MONTHLY_CLAIM, clampAnnualBudget, DECISION_APPROVER, FEE_INPUT_RANGE, FEE_MEDIA_MAP, GEO_CASE_BLANK,
  INTERNAL_FREEZE_BUSINESS_DAYS, LEAVE_ASSUMPTIONS, ON_DUTY_POOL, ONBOARDING_WEEKS, PROPOSAL_PAGES, REFERENCES, RFP_DEDICATED_COVERAGE, RFP_ITEMS,
  RFP_GROUP_LABEL, RFP_NOTES, RFP_PAGE_LIMIT, ROLE_ACCOUNT_USER, ROLE_DOMAIN, TF_INPUT_RULES, type EvalId, type ReferenceField, type ReferenceRow, type RfpGroup,
  type RfpItem,
} from './data';

/* ============================== 공통 ============================== */

export const round = {
  r0: (v: number) => (Number.isFinite(v) ? Math.round(v) : null),
  r1: (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null),
  r2: (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null),
};

/** 날짜 문자열 → UTC 일 번호 (타임존 무관) */
export function dayNum(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
export function dayDiff(a: string, b: string): number {
  return dayNum(a) - dayNum(b);
}
export function isDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
/** '11/16(월)' */
export function shortDate(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${WEEKDAY_KO[weekdayOf(date)]})`;
}
export function nextBusinessDay(from: string): string {
  let d = addDays(from, 1);
  for (let i = 0; i < 30 && isOffDay(d).off; i++) d = addDays(d, 1);
  return d;
}
export function prevBusinessDay(from: string, n = 1): string {
  let d = from;
  for (let k = 0; k < n; k++) {
    d = addDays(d, -1);
    for (let i = 0; i < 30 && isOffDay(d).off; i++) d = addDays(d, -1);
  }
  return d;
}

/** 빈칸 판정: 공백 · 장표 placeholder('[성명]' '[n]년' '[n]%' '[입력]' '[ROAS · 매출 성장률]') */
export function isBlank(s: string | null | undefined): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;
  if (/^\[[^\]]*\]$/.test(t)) return true;
  if (/^\[?n\]?\s*(년|%)?$/i.test(t)) return true;
  return /\[(입력|성명|n)\]/.test(t);
}
/** '7년' · '80%' · '7' → 숫자 (없으면 null) */
export function parseNum(s: string | number | null | undefined): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = (s ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!t) return null;
  const v = Number(t[0]);
  return Number.isFinite(v) ? v : null;
}
/** '월 약 4억 원' · '11억' · '3,000만' · '4억 5천만' → 원 (해석 불가면 null) */
export function parseKrwText(s: string | null | undefined): number | null {
  const t = (s ?? '').replace(/,/g, '').replace(/\s+/g, '');
  if (!t || isBlank(s)) return null;
  let total = 0;
  let found = false;
  const eok = t.match(/(\d+(?:\.\d+)?)억/);
  if (eok) { total += Number(eok[1]) * 1e8; found = true; }
  const cheonman = t.match(/(\d+(?:\.\d+)?)천만/);
  if (cheonman) { total += Number(cheonman[1]) * 1e7; found = true; }
  const man = !cheonman ? t.match(/(\d+(?:\.\d+)?)만/) : null;
  if (man && !(eok && t.indexOf(man[0]) < t.indexOf(eok[0]))) { total += Number(man[1]) * 1e4; found = true; }
  if (!found) {
    const plain = t.match(/^(?:월)?(?:약)?(\d+(?:\.\d+)?)(?:원)?$/);
    if (plain) { total = Number(plain[1]); found = true; }
  }
  return found && Number.isFinite(total) ? total : null;
}

/* ============================== TF 명단 (p.52) ============================== */

export interface TfInput { name?: string; years?: string; allocation?: string }

export interface TfRow {
  id: string;
  role: string;
  scope: string;
  domain: string;
  /** 제안서 지정 백업 */
  defaultBackupId: string;
  backupId: string;
  backupRole: string;
  backupOverridden: boolean;
  name: string;
  years: number | null;
  allocation: number | null;
  raw: { name: string; years: string; allocation: string };
  missing: { name: boolean; years: boolean; allocation: boolean };
  invalid: { name: boolean; years: boolean; allocation: boolean };
}

export function roleLabel(id: string | null | undefined): string {
  if (!id) return '—';
  return TF_ROLES.find((r) => r.id === id)?.role ?? id;
}

/** 블라인드 · 마스킹 성명 표기 */
export const MASKED_NAME = /(OO|ＯＯ|○|●|◯|\*|＊|XX|xx|△)/;

export function tfRoster(tf: Record<string, TfInput | undefined>, backupOverrides: Record<string, string> = {}): TfRow[] {
  return TF_ROLES.map((r) => {
    const t = tf[r.id] ?? {};
    const raw = { name: (t.name ?? '').trim(), years: (t.years ?? '').trim(), allocation: (t.allocation ?? '').trim() };
    const ov = backupOverrides[r.id];
    const backupId = ov !== undefined ? ov : r.backup;
    const yearsMissing = isBlank(raw.years);
    const allocMissing = isBlank(raw.allocation);
    const years = yearsMissing ? null : parseNum(raw.years);
    const allocation = allocMissing ? null : parseNum(raw.allocation);
    return {
      id: r.id, role: r.role, scope: r.scope, domain: ROLE_DOMAIN[r.id] ?? '—',
      defaultBackupId: r.backup, backupId, backupRole: backupId ? roleLabel(backupId) : '—', backupOverridden: ov !== undefined && ov !== r.backup,
      name: isBlank(raw.name) ? '' : raw.name, years, allocation, raw,
      missing: { name: isBlank(raw.name), years: yearsMissing, allocation: allocMissing },
      invalid: {
        // RFP는 '실명'을 요구 — 마스킹(김OO · 김** · 김○○) 표기는 오입력으로 본다
        name: !isBlank(raw.name) && MASKED_NAME.test(raw.name),
        years: !yearsMissing && (years === null || years < 0 || years > TF_INPUT_RULES.yearsMax),
        allocation: !allocMissing && (allocation === null || allocation < TF_INPUT_RULES.allocationMin || allocation > TF_INPUT_RULES.allocationMax),
      },
    };
  });
}

export interface TfMissingSummary {
  cells: number;
  total: number;
  name: number;
  years: number;
  allocation: number;
  invalid: number;
  incompleteRoles: string[];
  complete: boolean;
  /** 입력된 투입률 합 (FTE) */
  fte: number;
  fteEntered: number;
  dedicated: { key: string; label: string; ok: boolean; roles: string[] }[];
}
export function tfMissing(rows: TfRow[]): TfMissingSummary {
  const name = rows.filter((r) => r.missing.name).length;
  const years = rows.filter((r) => r.missing.years).length;
  const allocation = rows.filter((r) => r.missing.allocation).length;
  const invalid = rows.filter((r) => r.invalid.name || r.invalid.years || r.invalid.allocation).length;
  const entered = rows.filter((r) => r.allocation !== null && !r.invalid.allocation);
  const ids = new Set(rows.map((r) => r.id));
  return {
    cells: rows.length * 3,
    total: name + years + allocation,
    name, years, allocation, invalid,
    incompleteRoles: rows.filter((r) => r.missing.name || r.missing.years || r.missing.allocation || r.invalid.name || r.invalid.years || r.invalid.allocation).map((r) => r.role),
    complete: name + years + allocation + invalid === 0,
    fte: entered.reduce((s, r) => s + (r.allocation ?? 0), 0) / 100,
    fteEntered: entered.length,
    dedicated: RFP_DEDICATED_COVERAGE.map((c) => ({ key: c.key, label: c.label, roles: [...c.roles], ok: c.roles.every((id) => ids.has(id)) })),
  };
}

/* ============================== 1:1 백업 그래프 ============================== */

export type BackupIssueCode = 'no_backup' | 'self' | 'unknown' | 'one_way' | 'concentration' | 'domain';
export interface BackupIssue { level: 'gap' | 'warn' | 'info'; code: BackupIssueCode; memberId: string; text: string }
export interface BackupGraph {
  edges: { from: string; to: string; mutual: boolean; valid: boolean }[];
  dependents: Record<string, string[]>;
  mutualPairs: [string, string][];
  issues: BackupIssue[];
  gaps: number;
  oneWay: number;
  concentration: number;
  covered: number;
}

export function backupGraph(rows: TfRow[]): BackupGraph {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dependents: Record<string, string[]> = Object.fromEntries(rows.map((r) => [r.id, [] as string[]]));
  const edges = rows.map((r) => {
    const target = byId.get(r.backupId);
    const valid = !!r.backupId && r.backupId !== r.id && !!target;
    if (valid) dependents[r.backupId].push(r.id);
    return { from: r.id, to: r.backupId, valid, mutual: valid && target!.backupId === r.id };
  });
  const issues: BackupIssue[] = [];
  for (const r of rows) {
    if (!r.backupId) issues.push({ level: 'gap', code: 'no_backup', memberId: r.id, text: `${r.role} 백업 미지정 → 부재 시 응답 공백` });
    else if (r.backupId === r.id) issues.push({ level: 'gap', code: 'self', memberId: r.id, text: `${r.role} 백업이 본인으로 지정됨 → 부재 시 응답 공백` });
    else if (!byId.has(r.backupId)) issues.push({ level: 'gap', code: 'unknown', memberId: r.id, text: `${r.role} 백업(${r.backupId})이 TF 명단에 없음` });
    else {
      const b = byId.get(r.backupId)!;
      if (b.backupId !== r.id) issues.push({ level: 'info', code: 'one_way', memberId: r.id, text: `단방향 백업: ${r.role} → ${b.role} (${b.role}의 백업은 ${roleLabel(b.backupId)})` });
      if (r.id !== 'pm' && r.domain !== b.domain) issues.push({ level: 'warn', code: 'domain', memberId: r.id, text: `업무 영역 상이: ${r.role}(${r.domain}) ← ${b.role}(${b.domain}) · 인수 범위 사전 정의 필요` });
    }
  }
  for (const [id, deps] of Object.entries(dependents)) {
    if (deps.length >= 2) issues.push({ level: 'warn', code: 'concentration', memberId: id, text: `백업 집중: ${roleLabel(id)}가 ${deps.length}명(${deps.map(roleLabel).join(' · ')})을 백업 → 동시 부재 시 과부하` });
  }
  const pairs: [string, string][] = [];
  for (const e of edges) if (e.mutual && e.from < e.to) pairs.push([e.from, e.to]);
  return {
    edges, dependents, mutualPairs: pairs, issues,
    gaps: issues.filter((i) => i.level === 'gap').length,
    oneWay: issues.filter((i) => i.code === 'one_way').length,
    concentration: issues.filter((i) => i.code === 'concentration').length,
    covered: edges.filter((e) => e.valid).length,
  };
}

/* ============================== 주말 · 공휴일 당번 (p.48 · Alert와 같은 규칙) ============================== */

export interface DutyRow { date: string; label: string; roleId: string; role: string; backupId: string; backup: string; escalation: string }

export function onDutyFor(date: string): DutyRow | null {
  if (!isDateStr(date)) return null;
  const off = isOffDay(date);
  if (!off.off) return null;
  const w = weekdayOf(date);
  const anchor = w === 0 ? addDays(date, -1) : date;
  const isWeekend = w === 0 || w === 6;
  const n = ON_DUTY_POOL.length;
  const idx = isWeekend ? Math.floor(dayNum(anchor) / 7) % n : dayNum(date) % n;
  const roleId = ON_DUTY_POOL[(idx + n) % n];
  const backupId = TF_ROLES.find((r) => r.id === roleId)?.backup ?? 'pm';
  return { date, label: off.label, roleId, role: roleLabel(roleId), backupId, backup: roleLabel(backupId), escalation: '총괄 PM (P1 한정)' };
}

export interface DutyBlock { start: string; end: string; days: number; labels: string[]; hasHoliday: boolean; duties: DutyRow[]; briefing: string }
/** 기준일부터 n일 안의 연속 휴무 구간 (기준일이 휴무면 진행 중 구간 시작부터) */
export function dutyBlocks(from: string, horizonDays: number): DutyBlock[] {
  if (!isDateStr(from) || !(horizonDays > 0)) return [];
  let start = from;
  for (let i = 0; i < 10 && isOffDay(addDays(start, -1)).off; i++) start = addDays(start, -1);
  const total = horizonDays + dayDiff(from, start);
  const out: DutyBlock[] = [];
  let cur: DutyRow[] = [];
  const flush = () => {
    if (!cur.length) return;
    const labels = cur.map((d) => d.label);
    const end = cur[cur.length - 1].date;
    out.push({ start: cur[0].date, end, days: cur.length, labels, hasHoliday: labels.some((l) => l !== '토요일' && l !== '일요일'), duties: cur, briefing: nextBusinessDay(end) });
    cur = [];
  };
  for (let i = 0; i <= total; i++) {
    const row = onDutyFor(addDays(start, i));
    if (row) cur.push(row);
    else flush();
  }
  flush();
  return out;
}
export function dutyRoster(from: string, horizonDays: number): DutyRow[] {
  return dutyBlocks(from, horizonDays).flatMap((b) => b.duties);
}
/** 역할별 당번 일수 (공정성 확인) */
export function dutyLoad(rows: DutyRow[]): { roleId: string; role: string; days: number }[] {
  return ON_DUTY_POOL.map((id) => ({ roleId: id, role: roleLabel(id), days: rows.filter((r) => r.roleId === id).length }));
}

/** 당번 역할이 실명 권한을 가진 광고 계정 수 — 권한 없는 계정의 P1은 백업 · PM이 대행 */
export function dutyAccess(data: Dataset, roleId: string): { has: number; total: number; missing: string[] } {
  const user = ROLE_ACCOUNT_USER[roleId];
  const accts = data.accounts ?? [];
  const missing = accts.filter((a) => !a.permissions.some((p) => p.user === user && p.realName)).map((a) => a.name.replace(/ \(수면밀도\)/, ''));
  return { has: accts.length - missing.length, total: accts.length, missing };
}

/* ============================== 휴가 시뮬레이터 ============================== */

export interface LeaveOptions {
  transferPct?: number;
  overloadPct?: number;
  assumedAllocation?: number;
  /** 부재 시작일 · 일수 → 당번 충돌 검사 */
  start?: string;
  days?: number;
}
export interface LeaveMember {
  id: string; role: string; absent: boolean;
  base: number; baseAssumed: boolean;
  incoming: { fromId: string; fromRole: string; alloc: number; hops: number; fallback: boolean }[];
  load: number; overload: boolean;
}
export interface LeaveTransfer { fromId: string; toId: string | null; path: string[]; hops: number; alloc: number; fallback: boolean }
export interface LeaveGap { fromId: string; role: string; reason: string; fallbackId: string | null }
export interface DutyConflict { date: string; label: string; roleId: string; role: string; replacementId: string | null; replacement: string }
export interface LeaveResult {
  absent: string[];
  members: LeaveMember[];
  transfers: LeaveTransfer[];
  gaps: LeaveGap[];
  overloaded: string[];
  maxLoad: number;
  dutyConflicts: DutyConflict[];
  period: { start: string; end: string } | null;
  assumptions: { transferPct: number; overloadPct: number; assumedAllocation: number; assumedRoles: string[] };
}

function clampPct(v: number | undefined, def: number, lo = 0, hi = 300): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

export function simulateLeave(rows: TfRow[], absentIds: string[], opts: LeaveOptions = {}): LeaveResult {
  const transferPct = clampPct(opts.transferPct, LEAVE_ASSUMPTIONS.transferPct, 0, 100);
  const overloadPct = clampPct(opts.overloadPct, LEAVE_ASSUMPTIONS.overloadPct, 1, 300);
  const assumedAllocation = clampPct(opts.assumedAllocation, LEAVE_ASSUMPTIONS.assumedAllocation, 0, 100);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const absent = new Set(absentIds.filter((id) => byId.has(id)));
  const baseOf = (r: TfRow) => (r.allocation !== null && !r.invalid.allocation ? { v: r.allocation, assumed: false } : { v: assumedAllocation, assumed: true });

  const members: LeaveMember[] = rows.map((r) => {
    const b = baseOf(r);
    return { id: r.id, role: r.role, absent: absent.has(r.id), base: b.v, baseAssumed: b.assumed, incoming: [], load: absent.has(r.id) ? 0 : b.v, overload: false };
  });
  const mById = new Map(members.map((m) => [m.id, m]));
  const transfers: LeaveTransfer[] = [];
  const gaps: LeaveGap[] = [];

  for (const id of absent) {
    const r = byId.get(id)!;
    const alloc = (baseOf(r).v * transferPct) / 100;
    const path = [id];
    let cur: string | undefined = r.backupId;
    let reason = '';
    for (let step = 0; step < rows.length + 1; step++) {
      if (!cur || !byId.has(cur)) { reason = cur ? `백업(${cur})이 명단에 없음` : '백업 미지정'; cur = undefined; break; }
      if (path.includes(cur)) { reason = `백업 체인 순환 (${[...path, cur].map(roleLabel).join(' → ')}) · 모두 부재`; cur = undefined; break; }
      if (!absent.has(cur)) break;
      path.push(cur);
      cur = byId.get(cur)!.backupId;
    }
    if (cur) {
      const hops = path.length;
      transfers.push({ fromId: id, toId: cur, path: [...path, cur], hops, alloc, fallback: false });
      mById.get(cur)!.incoming.push({ fromId: id, fromRole: r.role, alloc, hops, fallback: false });
    } else {
      const fallbackId = id !== 'pm' && !absent.has('pm') && byId.has('pm') ? 'pm' : null;
      gaps.push({ fromId: id, role: r.role, reason: reason || '백업 인력 모두 부재', fallbackId });
      transfers.push({ fromId: id, toId: fallbackId, path, hops: path.length, alloc: fallbackId ? alloc : 0, fallback: true });
      if (fallbackId) mById.get(fallbackId)!.incoming.push({ fromId: id, fromRole: r.role, alloc, hops: path.length, fallback: true });
    }
  }
  for (const m of members) {
    if (!m.absent) m.load = m.base + m.incoming.reduce((s, x) => s + x.alloc, 0);
    m.overload = !m.absent && m.load > overloadPct + 1e-9;
  }

  let period: LeaveResult['period'] = null;
  const dutyConflicts: DutyConflict[] = [];
  if (opts.start && isDateStr(opts.start) && typeof opts.days === 'number' && opts.days >= 1) {
    const days = Math.min(60, Math.floor(opts.days));
    const end = addDays(opts.start, days - 1);
    period = { start: opts.start, end };
    for (let i = 0; i < days; i++) {
      const duty = onDutyFor(addDays(opts.start, i));
      if (!duty || !absent.has(duty.roleId)) continue;
      const t = transfers.find((x) => x.fromId === duty.roleId);
      const repl = t?.toId ?? null;
      dutyConflicts.push({ date: duty.date, label: duty.label, roleId: duty.roleId, role: duty.role, replacementId: repl, replacement: repl ? roleLabel(repl) : '대체 인력 없음' });
    }
  }
  const active = members.filter((m) => !m.absent);
  return {
    absent: [...absent],
    members, transfers, gaps,
    overloaded: members.filter((m) => m.overload).map((m) => m.id),
    maxLoad: active.length ? Math.max(...active.map((m) => m.load)) : 0,
    dutyConflicts, period,
    assumptions: { transferPct, overloadPct, assumedAllocation, assumedRoles: members.filter((m) => m.baseAssumed).map((m) => m.role) },
  };
}

/** 휴가 시뮬레이터 프리셋 */
export const LEAVE_PRESETS = [
  { id: 'sa_ae', label: 'SA AE 휴가', absent: ['sa_ae'] },
  { id: 'sa_lead', label: 'SA Lead AE 휴가', absent: ['sa_lead'] },
  { id: 'sa_pair', label: 'SA 2인 동시 부재', absent: ['sa_lead', 'sa_ae'] },
  { id: 'media_pair', label: 'DA · 글로벌 동시 부재', absent: ['da_ae', 'global_ae'] },
  { id: 'data_pair', label: '데이터 · 개발 동시 부재 (전사 교육)', absent: ['analyst', 'dev'] },
] as const;

/* ============================== 계정 · 결제 · 권한 (p.50) ============================== */

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info';
export interface AccountCheck {
  id: string; name: string; channel: string;
  owner: string; ownerOk: boolean;
  payment: string; autoCharge: AdAccount['autoCharge'];
  runwayDays: number | null;
  nonRealName: { user: string; role: string; lastLogin: string }[];
  agencyUsers: string[];
  status: AdAccount['status'];
  findings: { level: CheckLevel; item: string; text: string; action: string }[];
  level: CheckLevel;
}
const LEVEL_ORDER: Record<CheckLevel, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
function worst(levels: CheckLevel[]): CheckLevel {
  return levels.reduce<CheckLevel>((w, l) => (LEVEL_ORDER[l] < LEVEL_ORDER[w] ? l : w), 'pass');
}
function channelName(m: AdAccount['media']): string {
  return (MEDIA as Record<string, { name: string }>)[m]?.name ?? (SALES_CHANNELS as Record<string, { name: string }>)[m]?.name ?? String(m);
}

export function accountChecks(data: Dataset): AccountCheck[] {
  return (data.accounts ?? []).map((a) => {
    const findings: AccountCheck['findings'] = [];
    const ownerOk = a.owner.trim() === '수면밀도';
    if (!ownerOk) findings.push({ level: 'fail', item: '광고 계정', text: `소유 주체 ${a.owner || '미기재'} · 기준 수면밀도 소유`, action: '계정 소유권 수면밀도로 이전 · 운영 권한만 위임' });
    const runway = a.balance >= 0 && a.avgDailySpend > 0 ? a.balance / a.avgDailySpend : null;
    if (a.autoCharge === 'failed') findings.push({ level: 'fail', item: '결제 수단', text: '자동충전 실패', action: 'PM → 수면밀도 결제 담당자 충전 요청 · 결제 수단 확인' });
    if (runway !== null && runway < 1) findings.push({ level: 'fail', item: '결제 수단', text: `잔액 ${fmt.krw(a.balance)}원 · 일 평균 소진 ${fmt.krw(a.avgDailySpend)}원 → ${runway.toFixed(1)}일치 (기준 1일치)`, action: '즉시 충전 요청 · 소진 시 광고 중단 위험' });
    else if (runway !== null && runway < 3) findings.push({ level: 'warn', item: '결제 수단', text: `잔액 ${runway.toFixed(1)}일치 (주의 기준 3일치 · 운영 가정)`, action: '연휴 전 사전 충전 확인' });
    if (a.autoCharge === 'off' && runway !== null && runway >= 1) findings.push({ level: 'info', item: '결제 수단', text: '선충전 · 자동충전 없음', action: '잔액 모니터링 유지' });
    const nonReal = a.permissions.filter((p) => !p.realName);
    for (const p of nonReal) findings.push({ level: 'fail', item: '접근 권한', text: `비실명 계정 ${p.user} (${p.role}, 마지막 로그인 ${p.lastLogin}) · 기준 담당자 실명 계정`, action: '즉시 회수 · 실명 계정 최소 권한 재발급 (PM → 수면밀도 통보)' });
    if (a.status === 'review') findings.push({ level: 'warn', item: '광고 계정', text: '계정 상태 검수 · 확인 필요', action: '매체 검수 사유 확인 · 당일 보고' });
    if (a.status === 'restricted') findings.push({ level: 'fail', item: '광고 계정', text: '계정 제재', action: '제재 사유 확인 · 매체 소명 · 수면밀도 보고' });
    if (!findings.some((f) => f.level !== 'info')) findings.push({ level: 'pass', item: '광고 계정', text: '소유 · 결제 · 권한 기준 충족', action: '—' });
    return {
      id: a.id, name: a.name, channel: channelName(a.media), owner: a.owner, ownerOk,
      payment: a.paymentMethod, autoCharge: a.autoCharge, runwayDays: runway,
      nonRealName: nonReal.map((p) => ({ user: p.user, role: p.role, lastLogin: p.lastLogin })),
      agencyUsers: a.permissions.filter((p) => p.realName).map((p) => p.user),
      status: a.status, findings, level: worst(findings.map((f) => f.level)),
    };
  });
}

export interface OwnershipRow { item: string; owner: string; role: string; approval: string; level: CheckLevel; live: string }
/** OWNERSHIP 표(p.50) × 데이터 점검 결과 */
export function ownershipStatus(data: Dataset, changes: ChangeRequest[] = []): { rows: OwnershipRow[]; checks: AccountCheck[]; summary: { accounts: number; ownerOk: number; nonRealName: number; paymentRisk: number; review: number; pass: number } } {
  const checks = accountChecks(data);
  const n = checks.length;
  const ownerOk = checks.filter((c) => c.ownerOk).length;
  const nonReal = checks.reduce((s, c) => s + c.nonRealName.length, 0);
  const pay = checks.filter((c) => c.findings.some((f) => f.item === '결제 수단' && f.level === 'fail')).length;
  const review = checks.filter((c) => c.status !== 'active').length;
  const clientPending = changes.filter((c) => c.status === 'pending' && decisionTypeOf(c) === '예산 · 구조 변경').length;
  const rows: OwnershipRow[] = OWNERSHIP.map((o) => {
    let level: CheckLevel = 'info';
    let live = '';
    const noData = n === 0 && (o.item === '광고 계정' || o.item === '결제 수단' || o.item === '접근 권한');
    if (noData) return { item: o.item, owner: o.owner, role: o.role, approval: o.approval, level: 'info' as const, live: '계정 데이터 없음 · 점검 불가 (연동 후 확인)' };
    switch (o.item) {
      case '광고 계정':
        level = ownerOk === n && review === 0 ? 'pass' : ownerOk < n ? 'fail' : 'warn';
        live = `${n}개 계정 중 수면밀도 소유 ${ownerOk}개${review ? ` · 검수/제재 ${review}개` : ''}`;
        break;
      case '결제 수단':
        level = pay ? 'fail' : 'pass';
        live = pay ? `결제 위험 ${pay}개 (잔액 1일치 미만 · 자동충전 실패)` : '잔액 1일치 이상 · 자동충전 이상 없음';
        break;
      case '접근 권한':
        level = nonReal ? 'fail' : 'pass';
        live = nonReal ? `비실명 권한 ${nonReal}건 → 즉시 회수 대상` : '전 계정 실명 권한';
        break;
      case '예산 · 구조 변경':
        level = 'info';
        live = `수면밀도 승인 대기 ${clientPending}건 (MILDO Flow)`;
        break;
      default:
        level = 'info';
        live = '계약 종료 시 전체 이관 (계약서 조항)';
    }
    return { item: o.item, owner: o.owner, role: o.role, approval: o.approval, level, live };
  });
  return { rows, checks, summary: { accounts: n, ownerOk, nonRealName: nonReal, paymentRisk: pay, review, pass: checks.filter((c) => c.level === 'pass' || c.level === 'info').length } };
}

/**
 * 승인 요청 → p.53 결정 유형 분류.
 *  - 알림 · 시스템 기준: 탐지 기준 변경(kind 'alert_rule') — 승인 주체와 무관
 *  - 예산 · 구조 변경: 수면밀도 승인 건(GFA 30% 초과 · 신규 캠페인 등)
 *  - 승인 범위 내 운영 조정: 담당 AE · PM 승인 건(입찰 · 일 예산 ±30% 이내 · ON/OFF 등)
 *  - 전략 방향: 승인 요청으로 들어오지 않음 (월간 리뷰 안건)
 */
export function decisionTypeOf(c: Pick<ChangeRequest, 'kind' | 'approver'>): string | null {
  if (c.kind === 'alert_rule') return '알림 · 시스템 기준';
  if (c.approver === 'CLIENT') return '예산 · 구조 변경';
  if (c.approver === 'AE' || c.approver === 'PM') return '승인 범위 내 운영 조정';
  return null;
}

/** p.53 의사결정 체계 × 현재 승인 대기 */
export function decisionLoad(changes: ChangeRequest[]): { type: string; decider: string; lead: string; pending: number | null }[] {
  const pending = changes.filter((c) => c.status === 'pending');
  return DECISION_MATRIX.map((d) => {
    const tracked = DECISION_APPROVER[d.type] !== null && d.type in DECISION_APPROVER;
    return { type: d.type, decider: d.decider, lead: d.lead, pending: tracked ? pending.filter((c) => decisionTypeOf(c) === d.type).length : null };
  });
}

/* ============================== 90일 온보딩 (p.54 · p.20) ============================== */

export interface OnboardingWeek { week: number; start: string; end: string; holidays: { date: string; label: string }[]; offDays: number }
export interface OnboardingPlan {
  valid: boolean;
  kickoff: string;
  kickoffOff: { off: boolean; label: string };
  end: string;
  weeks: OnboardingWeek[];
  tasks: { task: string; start: number; end: number; from: string; to: string }[];
  /**
   * week = 장표 간트 위치(p.54 W4 · W8 · W12), calendarWeek = 실제 날짜(Kick-off + D일)가 속한 주차.
   * 12주(84일)와 D+90이 정확히 맞지 않으므로 두 값이 최대 1주 다를 수 있다 (W13 = W12 종료 후).
   */
  milestones: { week: number; calendarWeek: number; label: string; day: number; date: string; off: { off: boolean; label: string }; reportDay: string }[];
  phases: { id: string; label: string; from: string; to: string; items: readonly string[]; metric: string }[];
  daysToKickoff: number;
  currentWeek: number | null;
  selection: { label: string; weekStart: string; weekEnd: string; gapDays: number; beforeSelection: boolean };
  holidays: { date: string; label: string; week: number }[];
}

/** 'D+30 계정 인수 완료' → 30 */
function milestoneDay(label: string, fallbackWeek: number): number {
  const m = label.match(/D\+(\d+)/);
  return m ? Number(m[1]) : fallbackWeek * 7;
}

export function onboardingPlan(kickoff: string, today: string): OnboardingPlan {
  const valid = isDateStr(kickoff) && isDateStr(today);
  const k = valid ? kickoff : '2026-12-01';
  const t = isDateStr(today) ? today : k;
  const weeks: OnboardingWeek[] = Array.from({ length: ONBOARDING_WEEKS }, (_, i) => {
    const start = addDays(k, i * 7);
    const end = addDays(start, 6);
    const holidays: { date: string; label: string }[] = [];
    let offDays = 0;
    for (let j = 0; j < 7; j++) {
      const d = addDays(start, j);
      if (KR_HOLIDAYS[d]) holidays.push({ date: d, label: KR_HOLIDAYS[d] });
      if (isOffDay(d).off) offDays++;
    }
    return { week: i + 1, start, end, holidays, offDays };
  });
  const wk = (w: number) => weeks[Math.min(weeks.length, Math.max(1, w)) - 1];
  const tasks = ONBOARDING_GANTT.map((g) => ({ task: g.task, start: g.start, end: g.end, from: wk(g.start).start, to: wk(g.end).end }));
  const milestones = ONBOARDING_MILESTONES.map((m) => {
    const day = milestoneDay(m.label, m.week);
    const date = addDays(k, day);
    const off = isOffDay(date);
    return { week: m.week, calendarWeek: Math.floor(day / 7) + 1, label: m.label, day, date, off, reportDay: off.off ? prevBusinessDay(date) : date };
  });
  const bounds = [0, ...milestones.map((m) => m.day)];
  const phases = ONBOARDING_PHASES.map((p, i) => ({
    id: p.id, label: p.label, items: p.items, metric: p.metric,
    from: addDays(k, i === 0 ? 0 : (bounds[i] ?? 0) + 1),
    to: addDays(k, bounds[i + 1] ?? (i + 1) * 30),
  }));
  const diff = dayDiff(t, k);
  const end = addDays(k, milestones[milestones.length - 1]?.day ?? 90);
  // RFP '최종 선정 및 계약 26.11.24 주차'
  const sel = RFP.schedule.find((s) => s.step.startsWith('최종 선정'));
  const selParsed = sel ? parseRfpDate(sel.date) : null;
  const weekStart = selParsed?.start ?? '2026-11-23';
  const weekEnd = selParsed?.end ?? addDays(weekStart, 6);
  return {
    valid, kickoff: k, kickoffOff: isOffDay(k), end, weeks, tasks, milestones, phases,
    daysToKickoff: dayDiff(k, t),
    currentWeek: diff >= 0 && diff < ONBOARDING_WEEKS * 7 ? Math.floor(diff / 7) + 1 : null,
    selection: { label: sel ? `${sel.step} ${sel.date}` : '최종 선정 및 계약', weekStart, weekEnd, gapDays: dayDiff(k, weekEnd), beforeSelection: dayDiff(k, weekStart) < 0 },
    holidays: weeks.flatMap((w) => w.holidays.map((h) => ({ ...h, week: w.week }))),
  };
}

/** D+30 측정 기준(전월 대비 성과 유지) 기준선 — 최근 30일 (TEST DATA) */
export function performanceBaseline(data: Dataset, tolerancePct = BASELINE_TOLERANCE_PCT) {
  const r = rangeOf(data, 'last30');
  const t = totalsOf(mediaRows(data, r.from, r.to));
  const tol = Number.isFinite(tolerancePct) && tolerancePct >= 0 ? tolerancePct : BASELINE_TOLERANCE_PCT;
  return {
    from: r.from, to: r.to, label: r.label, tolerancePct: tol,
    cost: t.cost, revenue: t.revenue, roas: t.roas, cpa: t.cpa, cvr: t.cvr, cac: t.cac, conversions: t.conversions,
    roasFloor: Number.isFinite(t.roas) ? t.roas * (1 - tol / 100) : NaN,
    cpaCeiling: Number.isFinite(t.cpa) ? t.cpa * (1 + tol / 100) : NaN,
  };
}

/* ============================== 레퍼런스 (p.55–57) ============================== */

export type RefInputs = Record<string, Partial<Record<ReferenceField, string>>>;
export interface RefCell { field: ReferenceField; value: string; original: string; editable: boolean; blank: boolean }
export interface RefView { ref: ReferenceRow; cells: Record<ReferenceField, RefCell>; monthlyKrw: number | null }

export function referenceRows(inputs: RefInputs = {}, refs: ReferenceRow[] = REFERENCES): RefView[] {
  return refs.map((ref) => {
    const cell = (field: ReferenceField): RefCell => {
      const original = ref[field];
      const editable = isBlank(original);
      const input = (inputs[ref.id]?.[field] ?? '').trim();
      const value = editable ? input : original;
      return { field, value, original, editable, blank: editable ? isBlank(input) : false };
    };
    const cells = { period: cell('period'), monthly: cell('monthly'), metric: cell('metric') };
    return { ref, cells, monthlyKrw: parseKrwText(cells.monthly.value) };
  });
}

export function referenceCheck(rows: RefView[]) {
  const blanks = rows.flatMap((r) => (Object.values(r.cells) as RefCell[]).filter((c) => c.blank).map((c) => ({ refId: r.ref.id, brand: r.ref.brand, field: c.field })));
  const editable = rows.reduce((s, r) => s + (Object.values(r.cells) as RefCell[]).filter((c) => c.editable).length, 0);
  const bedding = rows.filter((r) => r.ref.bedding);
  const beddingParsed = bedding.filter((r) => r.monthlyKrw !== null);
  const beddingSum = beddingParsed.reduce((s, r) => s + (r.monthlyKrw ?? 0), 0);
  const gapPct = BEDDING_MONTHLY_CLAIM > 0 ? ((beddingSum - BEDDING_MONTHLY_CLAIM) / BEDDING_MONTHLY_CLAIM) * 100 : NaN;
  const unparsed = rows.filter((r) => !r.cells.monthly.blank && r.monthlyKrw === null && r.cells.monthly.value).map((r) => r.ref.brand);
  return {
    blanks, total: blanks.length, editable,
    sameFormat: rows.every((r) => !r.cells.period.blank && !r.cells.monthly.blank && !r.cells.metric.blank),
    bedding: {
      brands: bedding.map((r) => r.ref.brand), parsed: beddingParsed.length, sum: beddingSum, claim: BEDDING_MONTHLY_CLAIM,
      gapPct, matches: beddingParsed.length === bedding.length && Number.isFinite(gapPct) && Math.abs(gapPct) <= BEDDING_MATCH_TOLERANCE_PCT,
      tolerancePct: BEDDING_MATCH_TOLERANCE_PCT,
    },
    unparsed,
  };
}

/* ============================== 수수료 · 계약 (p.58) ============================== */

export type PaybackChoice = 'unset' | 'yes' | 'no';
export interface FeeInput { fee?: string; payback?: PaybackChoice; paybackPct?: string }
export interface FeeRow {
  media: string; mediaIds: string[]; share: number; budget: number;
  feePct: number | null; feeInvalid: boolean; fee: number | null;
  payback: PaybackChoice; paybackPct: number | null; paybackInvalid: boolean; paybackAmt: number | null;
  net: number | null; effectivePct: number;
  missing: string[];
}
export interface FeeCalc {
  annualBudget: number;
  rows: FeeRow[];
  totals: { budget: number; enteredBudget: number; fee: number; payback: number; net: number; monthlyNet: number; effectivePct: number; grossPct: number };
  missing: { fee: number; payback: number; paybackPct: number; invalid: number; total: number };
  complete: boolean;
  /** 수수료율 1%p당 연 수수료 변화 */
  perPointKrw: number;
  warnings: string[];
}

export function feeCalc(inputs: Record<string, FeeInput | undefined> = {}, annualBudget: number = RFP.annualBudget): FeeCalc {
  const budgetTotal = clampAnnualBudget(annualBudget);
  const warnings: string[] = [];
  const rows: FeeRow[] = CONTRACT_TERMS.fees.map((f) => {
    const ids = FEE_MEDIA_MAP[f.media] ?? [];
    const share = ids.reduce((s, id) => s + (MEDIA[id]?.share ?? 0), 0);
    const budget = Math.round(budgetTotal * share);
    const inp = inputs[f.media] ?? {};
    const rawFee = (inp.fee ?? '').trim();
    const feeParsed = rawFee === '' ? (f.fee ?? null) : parseNum(rawFee);
    const feeInvalid = rawFee !== '' && (feeParsed === null || feeParsed < FEE_INPUT_RANGE.min || feeParsed > FEE_INPUT_RANGE.max);
    const feePct = feeInvalid ? null : feeParsed;
    const fee = feePct !== null ? (budget * feePct) / 100 : null;
    const payback: PaybackChoice = inp.payback === 'yes' || inp.payback === 'no' ? inp.payback : 'unset';
    const rawPb = (inp.paybackPct ?? '').trim();
    const pbParsed = rawPb === '' ? null : parseNum(rawPb);
    const paybackInvalid = payback === 'yes' && rawPb !== '' && (pbParsed === null || pbParsed < 0 || pbParsed > FEE_INPUT_RANGE.max);
    const paybackPct = payback === 'yes' && !paybackInvalid ? pbParsed : payback === 'no' ? 0 : null;
    const paybackAmt = payback === 'no' ? 0 : paybackPct !== null ? (budget * paybackPct) / 100 : null;
    const net = fee !== null ? fee - (paybackAmt ?? 0) : null;
    const missing: string[] = [];
    if (feePct === null) missing.push(feeInvalid ? '수수료율 오입력' : '수수료율');
    if (payback === 'unset') missing.push('페이백 적용 여부');
    else if (payback === 'yes' && paybackPct === null) missing.push(paybackInvalid ? '페이백율 오입력' : '페이백율');
    if (net !== null && net < 0) warnings.push(`${f.media}: 페이백이 수수료를 초과 (순 수수료 ${fmt.krw(net)}) · 조건 확인 필요`);
    return {
      media: f.media, mediaIds: ids, share, budget, feePct, feeInvalid, fee, payback, paybackPct, paybackInvalid, paybackAmt, net,
      effectivePct: net !== null && budget > 0 ? (net / budget) * 100 : NaN, missing,
    };
  });
  const entered = rows.filter((r) => r.net !== null);
  const enteredBudget = entered.reduce((s, r) => s + r.budget, 0);
  const fee = rows.reduce((s, r) => s + (r.fee ?? 0), 0);
  const payback = rows.reduce((s, r) => s + (r.fee !== null ? r.paybackAmt ?? 0 : 0), 0);
  const net = fee - payback;
  // 오입력 칸은 invalid로만 센다 (미입력과 중복 집계하지 않음)
  const missingFee = rows.filter((r) => r.feePct === null && !r.feeInvalid).length;
  const missingPb = rows.filter((r) => r.payback === 'unset').length;
  const missingPbPct = rows.filter((r) => r.payback === 'yes' && r.paybackPct === null && !r.paybackInvalid).length;
  const invalid = rows.filter((r) => r.feeInvalid).length + rows.filter((r) => r.paybackInvalid).length;
  if (budgetTotal <= 0) warnings.push('연간 광고비가 0원 이하 — 계산 불가');
  return {
    annualBudget: budgetTotal,
    rows,
    totals: {
      budget: budgetTotal, enteredBudget, fee, payback, net, monthlyNet: net / 12,
      effectivePct: enteredBudget > 0 ? (net / enteredBudget) * 100 : NaN,
      grossPct: enteredBudget > 0 ? (fee / enteredBudget) * 100 : NaN,
    },
    missing: { fee: missingFee, payback: missingPb, paybackPct: missingPbPct, invalid, total: missingFee + missingPb + missingPbPct },
    complete: missingFee + missingPb + missingPbPct + invalid === 0,
    perPointKrw: budgetTotal / 100,
    warnings,
  };
}

/** p.37 배분 가안 표기 ('SA 43% · GFA 18% · …') — MEDIA 상수에서 생성 */
export function allocationText(withPct = true): string {
  return MEDIA_IDS.map((m) => `${MEDIA[m].short} ${Math.round(MEDIA[m].share * 1000) / 10}${withPct ? '%' : ''}`).join(' · ');
}

export type SolutionFeeChoice = 'unset' | 'included' | 'separate';
export interface ContractInput { terminationDays?: string; solutionFee?: SolutionFeeChoice; solutionMonthly?: string }
export interface ContractItem { id: string; label: string; value: string; status: 'ok' | 'missing' | 'invalid'; basis: string }
export function contractCheck(c: ContractInput = {}) {
  const items: ContractItem[] = [];
  items.push({
    id: 'months', label: '계약 기간', value: `${CONTRACT_TERMS.months}개월`,
    status: CONTRACT_TERMS.months === RFP.contractMonths ? 'ok' : 'invalid',
    basis: `RFP 계약 체결일로부터 ${RFP.contractMonths}개월 · 제안서 p.58 ${CONTRACT_TERMS.months}개월${CONTRACT_TERMS.months === RFP.contractMonths ? ' 일치' : ' 불일치'}`,
  });
  const rawT = (c.terminationDays ?? '').trim();
  const tDays = rawT ? parseNum(rawT) : null;
  const tInvalid = !!rawT && (tDays === null || tDays < 0 || tDays > 365);
  items.push({
    id: 'termination', label: '해지 조건', value: tDays !== null && !tInvalid ? `해지 ${Math.round(tDays)}일 전 서면 통보` : CONTRACT_TERMS.termination,
    status: !rawT ? 'missing' : tInvalid ? 'invalid' : 'ok', basis: 'p.58 [통보 기한 입력] · RFP 평가 항목 비용 · 계약 조건(해지 조건)',
  });
  const sf: SolutionFeeChoice = c.solutionFee === 'included' || c.solutionFee === 'separate' ? c.solutionFee : 'unset';
  const rawS = (c.solutionMonthly ?? '').trim();
  const sMonthly = rawS ? parseNum(rawS) : null;
  const sInvalid = sf === 'separate' && !!rawS && (sMonthly === null || sMonthly < 0);
  const solutionAnnual = sf === 'separate' && sMonthly !== null && !sInvalid ? sMonthly * 12 : 0;
  items.push({
    id: 'solution', label: '솔루션 이용료 (MILDO OS)',
    value: sf === 'included' ? '수수료에 포함 · 별도 청구 없음' : sf === 'separate' ? (sMonthly !== null && !sInvalid ? `별도 월 ${fmt.krw(sMonthly)}원 (연 ${fmt.krw(solutionAnnual)}원)` : '별도 · [월 금액 입력]') : CONTRACT_TERMS.solutionFee,
    status: sf === 'unset' ? 'missing' : sf === 'separate' && (sMonthly === null || sInvalid) ? (sInvalid ? 'invalid' : 'missing') : 'ok',
    basis: 'p.58 솔루션 이용 조건 분리 명시',
  });
  items.push({ id: 'owner', label: '계정 · 결제', value: CONTRACT_TERMS.accountOwner, status: 'ok', basis: 'p.50 계정 · 데이터 소유권 수면밀도 · p.58' });
  return { items, missing: items.filter((i) => i.status !== 'ok').length, solutionAnnual, complete: items.every((i) => i.status === 'ok') };
}

/** 연간 총 비용 = 광고비 + 순 수수료 + 솔루션 이용료 (VAT 별도) */
export function annualCost(fee: FeeCalc, contract: ReturnType<typeof contractCheck>) {
  const extra = fee.totals.net + contract.solutionAnnual;
  return { media: fee.annualBudget, fee: fee.totals.net, solution: contract.solutionAnnual, total: fee.annualBudget + extra, overheadPct: fee.annualBudget > 0 ? (extra / fee.annualBudget) * 100 : NaN };
}

/* ============================== RFP 일정 · D-day ============================== */

export interface ParsedRfpDate { start: string; end: string; hour: number | null; week: boolean }
/** '26.10.27~28' · '26.10.28~11.06' · '26.11.16 (월) 17시' · '26.11.24 주차' · '협의' */
export function parseRfpDate(s: string): ParsedRfpDate | null {
  const m = s.match(/(\d{2})\.(\d{1,2})\.(\d{1,2})(?:\s*~\s*(?:(\d{1,2})\.)?(\d{1,2}))?/);
  if (!m) return null;
  const y = 2000 + Number(m[1]);
  const mo = Number(m[2]);
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${y}-${pad(mo)}-${pad(Number(m[3]))}`;
  if (!isDateStr(start)) return null;
  let end = start;
  if (m[5]) {
    const em = m[4] ? Number(m[4]) : mo;
    const ey = em < mo ? y + 1 : y;
    const e = `${ey}-${pad(em)}-${pad(Number(m[5]))}`;
    if (isDateStr(e)) end = e;
  }
  const hm = s.match(/(\d{1,2})\s*시/);
  const week = /주차/.test(s);
  if (week) {
    const wd = weekdayOf(start);
    const mon = addDays(start, wd === 0 ? -6 : 1 - wd);
    return { start: mon, end: addDays(mon, 6), hour: null, week };
  }
  return { start, end, hour: hm ? Number(hm[1]) : null, week };
}

export type ScheduleStatus = 'done' | 'now' | 'next' | 'upcoming' | 'tbd';
export interface ScheduleRow { step: string; date: string; parsed: ParsedRfpDate | null; status: ScheduleStatus; dday: number | null; ddayLabel: string }
export function ddayLabel(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '협의';
  return days === 0 ? 'D-DAY' : days > 0 ? `D-${days}` : `D+${-days}`;
}
export function rfpSchedule(today: string, currentHour: number): { rows: ScheduleRow[]; deadline: { date: string; hour: number; days: number; hoursLeft: number; passed: boolean; freeze: string } } {
  const hour = Number.isFinite(currentHour) ? currentHour : 0;
  let nextMarked = false;
  const rows: ScheduleRow[] = RFP.schedule.map((s) => {
    const p = parseRfpDate(s.date);
    if (!p) return { step: s.step, date: s.date, parsed: null, status: 'tbd' as const, dday: null, ddayLabel: '협의' };
    const toStart = dayDiff(p.start, today);
    const toEnd = dayDiff(p.end, today);
    let status: ScheduleStatus;
    if (toEnd < 0 || (toEnd === 0 && p.hour !== null && hour >= p.hour)) status = 'done';
    else if (toStart <= 0) status = 'now';
    else if (!nextMarked) { status = 'next'; nextMarked = true; }
    else status = 'upcoming';
    return { step: s.step, date: s.date, parsed: p, status, dday: toStart, ddayLabel: status === 'done' ? '완료' : status === 'now' ? '진행 중' : ddayLabel(toStart) };
  });
  const dl = rows.find((r) => r.step.includes('제출 마감'))?.parsed ?? { start: '2026-11-16', end: '2026-11-16', hour: 17, week: false };
  const dlHour = dl.hour ?? 17;
  const days = dayDiff(dl.start, today);
  const hoursLeft = days * 24 + dlHour - hour;
  return { rows, deadline: { date: dl.start, hour: dlHour, days, hoursLeft, passed: hoursLeft <= 0, freeze: prevBusinessDay(dl.start, INTERNAL_FREEZE_BUSINESS_DAYS) } };
}

/* ============================== RFP 커버리지 맵 ============================== */

export interface Readiness {
  tfBlank: number;
  tfInvalid: number;
  feeMissing: number;
  contractMissing: number;
  refBlank: number;
  /** GEO 사례 수치(p.29) 입력 여부 — 화면에서 체크 */
  geoCaseDone?: boolean;
}
export interface CoverageRow extends RfpItem {
  groupLabel: string;
  status: 'done' | 'input';
  note: string;
  missingModules: string[];
}

/** moduleIds(동작하는 모듈 = 레지스트리 등록 · '준비 중' 아님)를 주면 그 밖의 모듈에 기대는 항목을 '입력 필요'로 표시 (null이면 검사 생략) */
export function rfpCoverage(readiness: Readiness, moduleIds: string[] | null = null, items: RfpItem[] = RFP_ITEMS, groupLabel: Record<RfpGroup, string> = RFP_GROUP_LABEL): CoverageRow[] {
  const known = moduleIds ? new Set(moduleIds) : null;
  return items.map((it) => {
    const missingModules = known ? it.modules.filter((m) => !known.has(m)) : [];
    let status: CoverageRow['status'] = 'done';
    let note = '';
    switch (it.need) {
      case 'tf': {
        const n = readiness.tfBlank + readiness.tfInvalid;
        if (n > 0) { status = 'input'; note = `TF 명단 ${readiness.tfBlank}칸 미입력${readiness.tfInvalid ? ` · 오입력 ${readiness.tfInvalid}명` : ''} (실명 · 연차 · 투입률)`; }
        break;
      }
      case 'fees': {
        const n = readiness.feeMissing + readiness.contractMissing;
        if (n > 0) { status = 'input'; note = `수수료 · 페이백 ${readiness.feeMissing}칸 · 계약 조건 ${readiness.contractMissing}건 미입력`; }
        break;
      }
      case 'references':
        if (readiness.refBlank > 0) { status = 'input'; note = `레퍼런스 빈칸 ${readiness.refBlank}칸 (같은 양식 미충족)`; }
        break;
      case 'geo_case':
        if (!readiness.geoCaseDone) { status = 'input'; note = `p.29 ${GEO_CASE_BLANK}`; }
        break;
      default:
        break;
    }
    if (missingModules.length) { status = 'input'; note = [note, `모듈 준비 중 · 미등록: ${missingModules.join(', ')}`].filter(Boolean).join(' · '); }
    if (status === 'done' && !note) note = '화면 · 데이터로 시연 가능';
    return { ...it, groupLabel: groupLabel[it.group] ?? it.group, status, note, missingModules };
  });
}

export interface EvalReadiness { id: EvalId; label: string; detail: string; weight: number; items: number; done: number; ratio: number; weighted: number; priority: boolean }
export function evaluationReadiness(rows: CoverageRow[]): { rows: EvalReadiness[]; total: number; priorityWeight: number; priorityReady: number } {
  const ev = RFP.evaluation.map((e) => {
    const its = rows.filter((r) => r.criterion === e.id);
    const done = its.filter((r) => r.status === 'done').length;
    const ratio = its.length ? done / its.length : 0;
    return { id: e.id as EvalId, label: e.label, detail: e.detail, weight: e.weight, items: its.length, done, ratio, weighted: e.weight * ratio, priority: e.id === 'automation' || e.id === 'stability' };
  });
  const pr = ev.filter((e) => e.priority);
  return {
    rows: ev,
    total: ev.reduce((s, e) => s + e.weighted, 0),
    priorityWeight: pr.reduce((s, e) => s + e.weight, 0),
    priorityReady: pr.reduce((s, e) => s + e.weighted, 0),
  };
}

export function proposalPageCheck() {
  return { pages: PROPOSAL_PAGES, limit: RFP_PAGE_LIMIT, ok: PROPOSAL_PAGES <= RFP_PAGE_LIMIT };
}

/* ============================== 모듈 요약 ============================== */

export interface OpsInputs {
  tf: Record<string, TfInput | undefined>;
  backupOverrides?: Record<string, string>;
  refs?: RefInputs;
  fees?: Record<string, FeeInput | undefined>;
  annualBudget?: number;
  contract?: ContractInput;
  geoCaseDone?: boolean;
}

export function opsSummary(data: Dataset, inp: OpsInputs, moduleIds: string[] | null = null, changes: ChangeRequest[] = []) {
  const roster = tfRoster(inp.tf, inp.backupOverrides);
  const tfm = tfMissing(roster);
  const graph = backupGraph(roster);
  const refRows = referenceRows(inp.refs);
  const refs = referenceCheck(refRows);
  const fee = feeCalc(inp.fees, inp.annualBudget ?? RFP.annualBudget);
  const contract = contractCheck(inp.contract);
  const coverage = rfpCoverage({ tfBlank: tfm.total, tfInvalid: tfm.invalid, feeMissing: fee.missing.total + fee.missing.invalid, contractMissing: contract.missing, refBlank: refs.total, geoCaseDone: inp.geoCaseDone }, moduleIds);
  const evalR = evaluationReadiness(coverage);
  const sched = rfpSchedule(data.today, data.currentHour);
  const own = ownershipStatus(data, changes);
  return {
    roster, tf: tfm, graph, refRows, refs, fee, contract, coverage, eval: evalR, schedule: sched, ownership: own,
    inputsMissing: tfm.total + tfm.invalid + refs.total + fee.missing.total + fee.missing.invalid + contract.missing,
    coverageDone: coverage.filter((c) => c.status === 'done').length,
  };
}

/* ============================== 오프라인 브리프 ============================== */

export function tfBrief(data: Dataset, inp: OpsInputs, absent: string[] = ['sa_ae']): Brief {
  const roster = tfRoster(inp.tf, inp.backupOverrides);
  const m = tfMissing(roster);
  const g = backupGraph(roster);
  const sim = simulateLeave(roster, absent, { start: addDays(data.today, 2), days: LEAVE_ASSUMPTIONS.defaultDays });
  const sched = rfpSchedule(data.today, data.currentHour);
  const pairs = g.mutualPairs.map(([a, b]) => `${roleLabel(a)} ↔ ${roleLabel(b)}`).join(', ');
  const conc = g.issues.filter((i) => i.code === 'concentration').map((i) => i.text);
  const over = sim.members.filter((x) => x.overload);
  const facts = [
    `전담 TF는 ${roster.length}개 역할(${roster.map((r) => r.role).join(' · ')})로 구성되며 RFP가 요구한 매체별 전담자는 ${m.dedicated.map((x) => `${x.label} ${x.ok ? '지정' : '미지정'}`).join(' · ')} 상태입니다 (제안서 p.52).`,
    m.complete
      ? `TF 명단 ${m.cells}칸이 모두 입력되었고 입력 투입률 합계는 ${fmt.dec1(m.fte)} FTE입니다.`
      : `TF 명단 ${m.cells}칸 중 ${m.total}칸이 미입력입니다 (성명 ${m.name} · 연차 ${m.years} · 투입률 ${m.allocation}${m.invalid ? ` · 오입력 ${m.invalid}명` : ''}). RFP 필수 제출물 4) TF 명단은 실명 · 연차 · 투입률 · 백업을 요구합니다.`,
    `1:1 백업은 상호 백업 ${g.mutualPairs.length}쌍(${pairs || '없음'}), 단방향 ${g.oneWay}건, 백업 공백 ${g.gaps}건입니다.`,
  ];
  const patterns = [
    ...conc,
    `휴가 시뮬레이션(${absent.map(roleLabel).join(' · ')} 부재, 인수 비율 ${sim.assumptions.transferPct}% 가정): ${over.length ? `${over.map((x) => `${x.role} ${fmt.int(x.load)}%`).join(', ')} → 과부하 기준 ${sim.assumptions.overloadPct}% 초과` : `과부하 없음 (최대 ${fmt.int(sim.maxLoad)}% · 기준 ${sim.assumptions.overloadPct}%)`}${sim.gaps.length ? ` · 응답 공백 ${sim.gaps.length}건` : ''}.`,
  ];
  if (sim.dutyConflicts.length) patterns.push(`부재 기간 당번 충돌 ${sim.dutyConflicts.length}일: ${sim.dutyConflicts.map((c) => `${shortDate(c.date)} ${c.role} → ${c.replacement}`).join(', ')}.`);
  const interp = [
    `평가 비중 '인력 · 백업 · 온보딩' ${RFP.evaluation.find((e) => e.id === 'people')?.weight ?? 15}%는 명단 실명 여부와 백업이 실제로 작동하는지로 판단될 가능성이 높습니다. 상호 백업 쌍이 동시에 비는 경우(예: SA 2인 동시 휴가)는 2차 백업이 없으므로 PM이 직접 대행하는 규칙을 명단에 함께 적는 편이 응답 공백 최소화 요건을 직접 충족합니다.`,
  ];
  if (sim.assumptions.assumedRoles.length) interp.push(`투입률이 입력되지 않은 ${sim.assumptions.assumedRoles.length}명은 전담 100%로 가정해 계산했으므로 과부하 판정은 입력 후 다시 확인해야 합니다.`);
  return {
    title: 'TF 명단 · 1:1 백업 · 휴가 공백 점검',
    facts, patterns, interpretation: interp,
    conditions: [
      `과부하 기준 합산 투입률 ${sim.assumptions.overloadPct}% 초과, 부재 인원 업무 인수 비율 ${sim.assumptions.transferPct}%, 미입력 투입률 ${sim.assumptions.assumedAllocation}% — 모두 운영 가정이며 화면에서 조정합니다.`,
      '당번 순번은 MILDO Alert와 같은 규칙(매체 AE 4인 순환 · 주말 토 · 일 동일 당번 · 평일 공휴일 일자 순번)입니다 (p.48).',
    ],
    counter: [
      '백업이 긴급 대응만 맡고 전략 · 보고 업무를 복귀 후로 미루면 실제 부하는 계산보다 낮습니다. 반대로 휴가가 월말 보고 · 기획전 오픈과 겹치면 인수 비율 50% 가정은 과소 추정입니다.',
    ],
    actions: [
      `PM: ${shortDate(sched.deadline.freeze)}까지 7인 실명 · 연차 · 투입률을 확정하고 제출 마감 ${shortDate(sched.deadline.date)} ${sched.deadline.hour}시 전에 p.52 표에 반영합니다.`,
      'PM: 상호 백업 쌍 동시 부재 시 PM 직접 대행 · 휴가 일정 분산 규칙을 명단 하단에 명시합니다.',
    ],
  };
}

export function feeBrief(inp: OpsInputs): Brief {
  const f = feeCalc(inp.fees, inp.annualBudget ?? RFP.annualBudget);
  const c = contractCheck(inp.contract);
  const cost = annualCost(f, c);
  const entered = f.rows.filter((r) => r.net !== null);
  const facts = [
    `연간 광고비 ${fmt.krw(f.annualBudget)}원을 p.37 배분 가안(${allocationText()})으로 나누면 수수료 표 기준 ${f.rows.map((r) => `${r.media} ${fmt.krw(r.budget)}원`).join(', ')}입니다.`,
    entered.length
      ? `입력된 ${entered.length}개 매체 기준 연간 수수료 ${fmt.krw(f.totals.fee)}원 · 페이백 ${fmt.krw(f.totals.payback)}원 · 순 수수료 ${fmt.krw(f.totals.net)}원, 실효 수수료율 ${fmt.pct(f.totals.effectivePct, 2)}입니다.`
      : `p.58 수수료율이 5개 매체 모두 미입력 상태입니다. 수수료율 1%p당 연 수수료는 ${fmt.krw(f.perPointKrw)}원씩 달라집니다.`,
    `계약 ${c.items[0].value} · 해지 조건 ${c.items[1].value} · 솔루션 이용료 ${c.items[2].value} · 계정 · 결제 ${c.items[3].value}.`,
  ];
  return {
    title: '수수료 · 계약 조건 계산',
    facts,
    patterns: [],
    interpretation: [
      `RFP는 우선 협상 대상자를 리소스 절감 자동화 · 운영 안정성 점수로 먼저 고르고 동점일 때 수수료 조건을 종합 고려한다고 명시했습니다. 수수료는 평가 비중 10%(비용 · 계약 조건)이자 동점 처리 기준이므로, 낮은 요율보다 매체별 요율 · 페이백 · 솔루션 이용료를 모두 공개해 비교 가능하게 만드는 것이 조건 항목의 완결성 측면에서 유리합니다.`,
      f.complete && c.complete ? `연간 총 비용은 광고비 포함 ${fmt.krw(cost.total)}원이며 광고비 대비 부대 비용은 ${fmt.pct(cost.overheadPct, 2)}입니다.` : `미입력 ${f.missing.total + f.missing.invalid + c.missing}건이 남아 있어 총 비용 비교는 아직 확정할 수 없습니다.`,
    ],
    conditions: ['배분은 p.37 연 50억 가안 기준 · VAT 별도. 실제 배분은 월 1회 재배분 원칙에 따라 바뀌므로 수수료 총액도 같이 변합니다. 페이백은 광고비 대비 비율로 계산했습니다.'],
    counter: ['연 예산이 RFP 표기처럼 브랜드 운영 방향에 따라 변동되면 정액(솔루션 이용료)과 정률(수수료)의 비중이 달라집니다. 예산이 줄면 정액 비용의 실효율이 올라갑니다.'],
    actions: [
      `PM: 매체별 수수료율 · 페이백 미입력 ${f.missing.total}칸${f.missing.invalid ? ` · 오입력 ${f.missing.invalid}칸` : ''}과 계약 조건 ${c.missing}건을 확정해 p.58에 반영합니다 (제안서 제출 마감 전).`,
    ],
  };
}

export function rfpBrief(data: Dataset, inp: OpsInputs, moduleIds: string[] | null = null): Brief {
  const s = opsSummary(data, inp, moduleIds);
  const dl = s.schedule.deadline;
  const inputRows = s.coverage.filter((r) => r.status === 'input');
  const now = s.schedule.rows.filter((r) => r.status === 'now').map((r) => `${r.step}(${r.date})`);
  return {
    title: 'RFP 커버리지 · 제출 준비',
    facts: [
      `기준일 ${shortDate(data.today)} ${data.currentHour}시 기준 제안서 제출 마감 ${shortDate(dl.date)} ${dl.hour}시까지 ${ddayLabel(dl.days)} · ${fmt.int(dl.hoursLeft)}시간 남았습니다${now.length ? `. 진행 중 단계: ${now.join(', ')}` : ''}.`,
      `RFP 요청 항목 · 필수 제출물 ${s.coverage.length}개 중 ${s.coverageDone}개는 MILDO OS 화면 · 데이터로 시연 가능하고 ${inputRows.length}개는 입력이 필요합니다.`,
      `선정 기준 비중은 ${RFP.evaluation.map((e) => `${e.label} ${e.weight}`).join(' · ')}이며, 항목 준비도를 비중으로 가중하면 ${fmt.dec1(s.eval.total)} / 100입니다 (자체 점검 지표 · RFP 배점 아님).`,
    ],
    patterns: inputRows.map((r) => `${r.groupLabel} · ${r.text.slice(0, 40)}${r.text.length > 40 ? '…' : ''} → ${r.note}`),
    interpretation: [
      `${RFP_NOTES.priority}. 따라서 ${s.eval.rows.filter((e) => e.priority).map((e) => `${e.label}(${e.weight})`).join('와 ')} 합계 ${s.eval.priorityWeight}% 항목의 시연 완성도가 1차 판단 기준이고, 현재 이 두 영역 준비도는 ${fmt.dec1(s.eval.priorityReady)} / ${s.eval.priorityWeight}입니다. 남은 입력 항목은 인력 · 비용 · 레퍼런스 영역이므로 화면 개발보다 사실 확인 · 증빙 일정이 제출 리스크입니다.`,
    ],
    conditions: [`${RFP_NOTES.undisclosed} 준비도는 RFP 항목 대비 입력 완료 여부만 셉니다.`],
    counter: ['구현됨 표시는 시연 화면이 있다는 뜻이며 평가자가 수치 근거(실집행 사례 · 증빙)를 요구하면 별도 자료가 필요합니다. GEO 사례 수치처럼 실제 집행 데이터가 없으면 공란 대신 진단 방식만 제시하는 대안을 검토합니다.'],
    actions: [
      `PM: 입력 필요 ${inputRows.length}개 항목을 내부 확정일 ${shortDate(dl.freeze)}(마감 ${INTERNAL_FREEZE_BUSINESS_DAYS}영업일 전 · 운영 가정)까지 채우고, 제안서 PPT + PDF와 사업자 등록증을 별도 파일로 준비합니다.`,
    ],
  };
}

/** p.54 간트에서 병행 운영 · AD Pilot 단계 적용 구간 (상수에서 읽음) */
export function onboardingWindows() {
  const parallel = ONBOARDING_GANTT.find((g) => g.task.startsWith('병행'));
  const pilot = ONBOARDING_GANTT.find((g) => g.task.startsWith('AD Pilot'));
  const keep = ONBOARDING_GANTT.find((g) => g.task.startsWith('기존 입찰'));
  return {
    parallel: parallel ? { start: parallel.start, end: parallel.end } : null,
    pilot: pilot ? { start: pilot.start, end: pilot.end } : null,
    keep: keep ? { start: keep.start, end: keep.end } : null,
  };
}

export function onboardingBrief(data: Dataset, kickoff: string): Brief {
  const p = onboardingPlan(kickoff, data.today);
  const b = performanceBaseline(data);
  const own = ownershipStatus(data);
  const win = onboardingWindows();
  const hw = [...new Set(p.holidays.map((h) => h.week))].sort((x, y) => x - y);
  return {
    title: '계정 인수 · 90일 온보딩',
    facts: [
      `Kick-off ${shortDate(p.kickoff)} 가정 시 D+30 ${shortDate(p.milestones[0]?.date ?? p.end)} · D+60 ${shortDate(p.milestones[1]?.date ?? p.end)} · D+90 ${shortDate(p.end)}입니다. RFP 최종 선정 및 계약은 26.11.24 주차, Kick-off OT는 협의입니다.`,
      `온보딩 기간 공휴일 ${p.holidays.length}일(${p.holidays.map((h) => `W${h.week} ${shortDate(h.date)} ${h.label}`).join(', ') || '없음'})은 당번 체계로 운영합니다.`,
      `D+30 측정 기준 '전월 대비 성과 유지'의 기준선 후보(TEST DATA, ${b.label} ${b.from}~${b.to}): ROAS ${fmt.roas(b.roas)} · CPA ${fmt.won(b.cpa)} · 광고비 ${fmt.krw(b.cost)}원.`,
      `인수 대상 계정 ${own.summary.accounts}개 중 비실명 권한 ${own.summary.nonRealName}건 · 결제 위험 ${own.summary.paymentRisk}개 · 검수 상태 ${own.summary.review}개가 현재 데이터에서 확인됩니다.`,
    ],
    patterns: [],
    interpretation: [
      `성과 공백 최소화 요건은 ${win.parallel ? `W${win.parallel.start}–W${win.parallel.end}` : ''} 병행 운영 · 기존 입찰 로직 유지 구간이 핵심입니다. AD Pilot 자동 조정은 ${win.pilot ? `W${win.pilot.start}부터` : '병행 운영 이후'} 단계 적용이므로 인수 직후 입찰 구조 변경으로 인한 CPA 변동은 구조적으로 제한됩니다. 인수 첫 주에는 비실명 권한 회수와 결제 수단 확인이 계정 · 권한 · 결제 인수 항목의 선행 조건입니다.`,
    ],
    conditions: [`성과 유지 판정 허용 폭 ±${b.tolerancePct}%는 운영 가정이며 온보딩 중 수면밀도와 확정합니다 (ROAS 하한 ${fmt.roas(b.roasFloor)} · CPA 상한 ${fmt.won(b.cpaCeiling)}).`],
    counter: [
      hw.length
        ? `공휴일이 ${hw.length === 1 ? `W${hw[0]}` : `W${hw[0]}–W${hw[hw.length - 1]}`}에 걸쳐 있어 영업일 수와 계절 수요 변화가 기준선 비교를 왜곡할 수 있습니다. 전년 동기 데이터가 확보되면 전월 대비 대신 전년 동기 대비 지표를 함께 봅니다.`
        : '온보딩 기간에 공휴일은 없지만 기획전 · 시즌 수요 변화가 기준선 비교를 왜곡할 수 있습니다. 전년 동기 데이터가 확보되면 전년 동기 대비 지표를 함께 봅니다.',
      `마일스톤 날짜는 Kick-off + 일수(D+30 · D+60 · D+90)로 환산했고, 장표 간트(W1–W${ONBOARDING_WEEKS}, ${ONBOARDING_WEEKS * 7}일)와는 최대 1주 차이가 납니다.`,
    ],
    actions: [
      'PM: Kick-off 전 계정 · 권한 목록과 기존 입찰 로직 문서를 요청하고, D+30 기준선 지표를 수면밀도와 합의합니다.',
    ],
  };
}

/* ============================== 마크다운 내보내기 ============================== */

export function tfMarkdown(rows: TfRow[]): string {
  const cell = (v: string, ph: string) => (v ? v : ph);
  const lines = [
    '| 역할 | 성명 | 연차 | 담당 | 투입률 | 백업 |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.role} | ${cell(r.invalid.name ? '' : r.name, '[성명]')} | ${r.years !== null && !r.invalid.years ? `${r.years}년` : '[n]년'} | ${r.scope} | ${r.allocation !== null && !r.invalid.allocation ? `${r.allocation}%` : '[n]%'} | ${r.backupRole} |`),
  ];
  return `## 전담 TF 명단 (제안서 p.52)\n\n${lines.join('\n')}\n`;
}

export function coverageMarkdown(rows: CoverageRow[], moduleTitle: (id: string) => string): string {
  const out = ['## RFP 커버리지 맵', '', '| 구분 | RFP 요청 항목 | MILDO OS | 제안서 | 상태 |', '|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.groupLabel} | ${r.text.replace(/\|/g, '/')} | ${r.modules.map(moduleTitle).join(', ')} | ${r.pages} | ${r.status === 'done' ? '구현됨' : `입력 필요 · ${r.note}`} |`);
  return out.join('\n') + '\n';
}

export function onboardingMarkdown(p: OnboardingPlan): string {
  const out = [`## 계정 인수 · 90일 온보딩 (Kick-off ${p.kickoff} 가정)`, '', '| 작업 | 주차 | 기간 |', '|---|---|---|'];
  for (const t of p.tasks) out.push(`| ${t.task} | W${t.start}–W${t.end} | ${t.from} ~ ${t.to} |`);
  out.push('', '| 마일스톤 | 날짜 |', '|---|---|');
  for (const m of p.milestones) out.push(`| ${m.label} | ${m.date} |`);
  out.push('', ...p.phases.map((ph) => `- ${ph.label} (${ph.from} ~ ${ph.to}): ${ph.items.join(' · ')} · 측정 기준 ${ph.metric}`));
  return out.join('\n') + '\n';
}
