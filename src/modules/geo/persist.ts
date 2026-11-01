/**
 * SearchTuneOS 로컬 저장 — Claude 라이브 진단 기록 · 진단 전후 지표 입력.
 * 전역 스토어(core/store)를 바꾸지 않기 위해 모듈 전용 키를 쓴다. 저장 불가 환경(artifact 등)에서는 조용히 무시한다.
 */
import { EMPTY_CASE, type CaseInput, type LiveRecord } from './engine';

const LIVE_KEY = 'mildo-os/geo/live/v1';
const CASE_KEY = 'mildo-os/geo/case/v1';
const MAX_LIVE = 60;

function read<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 불가 — 무시 */
  }
}

function isLive(x: unknown): x is LiveRecord {
  const o = x as LiveRecord;
  return !!o && typeof o === 'object' && typeof o.queryId === 'string' && typeof o.mentioned === 'boolean' && Array.isArray(o.order) && Array.isArray(o.competitors) && Array.isArray(o.citations);
}

export function loadLive(): LiveRecord[] {
  const v = read<unknown>(LIVE_KEY, []);
  return Array.isArray(v) ? v.filter(isLive).slice(0, MAX_LIVE) : [];
}
export function saveLive(records: LiveRecord[]): void {
  write(LIVE_KEY, records.slice(0, MAX_LIVE));
}

/** 질의별 최신 기록 1건 */
export function latestByQuery(records: LiveRecord[]): Record<string, LiveRecord> {
  const out: Record<string, LiveRecord> = {};
  for (const r of records) if (!out[r.queryId] || out[r.queryId].at < r.at) out[r.queryId] = r;
  return out;
}

export function loadCase(): CaseInput {
  const v = read<Partial<CaseInput>>(CASE_KEY, {});
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    brand: s(v.brand), beforeLabel: s(v.beforeLabel), afterLabel: s(v.afterLabel), engines: s(v.engines),
    beforeRate: num(v.beforeRate), afterRate: num(v.afterRate), beforeCites: num(v.beforeCites), afterCites: num(v.afterCites),
  } satisfies CaseInput;
}
export function saveCase(c: CaseInput): void {
  write(CASE_KEY, c);
}
export { EMPTY_CASE };
