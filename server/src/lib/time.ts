/**
 * KST(Asia/Seoul, UTC+9, 서머타임 없음) 시간 헬퍼 — 서버 · 워커의 업무 시각 계산은 모두 여기서.
 * 프런트 Dataset의 today / currentHour와 같은 기준을 만든다.
 */
const KST_OFFSET_MS = 9 * 3600_000;

/** 지금 시각 (테스트에서 고정 가능) */
let fixedNow: number | null = null;
export function setNowForTest(ms: number | null): void {
  fixedNow = ms;
}
export function nowMs(): number {
  return fixedNow ?? Date.now();
}

/** KST 기준 벽시계 성분 */
export function kstParts(ms = nowMs()): { date: string; hour: number; minute: number; weekday: number } {
  const d = new Date(ms + KST_OFFSET_MS);
  const date = d.toISOString().slice(0, 10);
  return { date, hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}
export const kstToday = (ms = nowMs()) => kstParts(ms).date;
export const kstHour = (ms = nowMs()) => kstParts(ms).hour;

/** KST 날짜 + 시각 → ISO 문자열(+09:00) */
export function kstIso(date: string, hour = 0, minute = 0): string {
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
}

/** YYYY-MM-DD ± n일 */
export function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** from ~ to (포함) 날짜 목록 */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysStr(d, 1)) out.push(d);
  return out;
}
