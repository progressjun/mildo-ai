/* 공통 유틸: 시드 난수 · 포맷 · 날짜 · 통계 */

/** mulberry32 — 시드 고정 PRNG (데모 데이터 재현성) */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + (max - min) * next(),
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
    pick: <T,>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)],
    /** 평균 1, 표준편차 sd 근사의 노이즈 (Box-Muller) */
    noise: (sd: number) => {
      const u = Math.max(1e-9, next());
      const v = next();
      return 1 + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ---------- 숫자 포맷 ---------- */

const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const fmt = {
  int: (n: number) => (Number.isFinite(n) ? nf0.format(Math.round(n)) : '—'),
  dec1: (n: number) => (Number.isFinite(n) ? nf1.format(n) : '—'),
  /** 원 단위 → '1,234원' */
  won: (n: number) => (Number.isFinite(n) ? `${nf0.format(Math.round(n))}원` : '—'),
  /** 원 단위 → 억/만 축약 ('21.5억', '1,370만', '9,800') */
  krw: (n: number) => {
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(a >= 1e13 ? 0 : 1).replace(/\.0$/, '')}조`;
    if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e10 ? 0 : a >= 1e9 ? 1 : 2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}억`;
    if (a >= 1e4) return `${sign}${nf0.format(Math.round(a / 1e4))}만`;
    return `${sign}${nf0.format(Math.round(a))}`;
  },
  pct: (n: number, digits = 1) => (Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—'),
  /** 비율(0~1) → % */
  ratio: (r: number, digits = 1) => (Number.isFinite(r) ? `${(r * 100).toFixed(digits)}%` : '—'),
  /** 증감률 → '+12.3%' */
  delta: (pct: number, digits = 1) => (Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct.toFixed(digits)}%` : '—'),
  /** ROAS(%) */
  roas: (pct: number) => (Number.isFinite(pct) ? `${nf0.format(Math.round(pct))}%` : '—'),
  minutes: (m: number) => (m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${Math.round(m % 60)}분` : ''}` : `${Math.round(m)}분`),
};

/* ---------- 지표 계산 ---------- */

export const metrics = {
  ctr: (clicks: number, imps: number) => (imps > 0 ? (clicks / imps) * 100 : NaN),
  cpc: (cost: number, clicks: number) => (clicks > 0 ? cost / clicks : NaN),
  cvr: (conv: number, clicks: number) => (clicks > 0 ? (conv / clicks) * 100 : NaN),
  cpa: (cost: number, conv: number) => (conv > 0 ? cost / conv : NaN),
  roas: (rev: number, cost: number) => (cost > 0 ? (rev / cost) * 100 : NaN),
  pctChange: (cur: number, prev: number) => (prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : cur === 0 ? 0 : NaN),
};

export function sum<T>(arr: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of arr) s += f(x);
  return s;
}
export function mean(arr: readonly number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
export function stdev(arr: readonly number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
/** 피어슨 상관계수 */
export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}
/** 단순 선형회귀 y = a + b x */
export function linreg(x: readonly number[], y: readonly number[]) {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  const ssTot = y.slice(0, n).reduce((s, v) => s + (v - my) ** 2, 0);
  const ssRes = y.slice(0, n).reduce((s, v, i) => s + (v - (a + b * x[i])) ** 2, 0);
  return { a, b, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}
/** 두 비율 z-검정 (양측) → p-value */
export function twoProportionZ(c1: number, n1: number, c2: number, n2: number) {
  if (n1 <= 0 || n2 <= 0) return { z: NaN, p: NaN };
  const p1 = c1 / n1, p2 = c2 / n2;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  return { z, p: 2 * (1 - normCdf(Math.abs(z))) };
}
export function normCdf(z: number): number {
  // Abramowitz-Stegun 근사
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ---------- 날짜 ---------- */

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
export function weekday(s: string): number {
  return parseDate(s).getDay();
}
export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
export function fmtDate(s: string, withWeekday = true): string {
  if (!s) return '—';
  const d = parseDate(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}${withWeekday ? `(${WEEKDAY_KO[d.getDay()]})` : ''}`;
}
export function daysInMonth(s: string): number {
  const d = parseDate(s);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
export function monthKey(s: string): string {
  return s.slice(0, 7);
}
export function nowIso(): string {
  return new Date().toISOString();
}
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * 공휴일 (2026–2027, 관공서 공휴일 기준 · 대체공휴일 포함 여부는 정부 고시로 최종 확인 필요)
 * 주말·공휴일 감시 모드와 연휴 전날 사전 점검에 사용.
 */
export const KR_HOLIDAYS: Record<string, string> = {
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴',
  '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절',
  '2026-03-02': '대체공휴일(확인 필요)',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날',
  '2026-05-25': '대체공휴일(확인 필요)',
  '2026-06-03': '전국동시지방선거',
  '2026-06-06': '현충일',
  '2026-08-15': '광복절',
  '2026-08-17': '대체공휴일(확인 필요)',
  '2026-09-24': '추석 연휴',
  '2026-09-25': '추석',
  '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절',
  '2026-10-05': '대체공휴일(확인 필요)',
  '2026-10-09': '한글날',
  '2026-12-25': '성탄절',
  '2027-01-01': '신정',
  '2027-02-06': '설날',
  '2027-02-07': '설날 연휴',
  '2027-02-08': '설날 연휴',
  '2027-02-09': '대체공휴일(확인 필요)',
  '2027-03-01': '삼일절',
  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',
  '2027-08-15': '광복절',
  '2027-08-16': '대체공휴일(확인 필요)',
  '2027-09-14': '추석 연휴',
  '2027-09-15': '추석',
  '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절',
  '2027-10-04': '대체공휴일(확인 필요)',
  '2027-10-09': '한글날',
  '2027-10-11': '대체공휴일(확인 필요)',
  '2027-12-25': '성탄절',
};

export function isOffDay(s: string): { off: boolean; label: string } {
  const h = KR_HOLIDAYS[s];
  if (h) return { off: true, label: h };
  const w = weekday(s);
  if (w === 0 || w === 6) return { off: true, label: w === 0 ? '일요일' : '토요일' };
  return { off: false, label: '' };
}
