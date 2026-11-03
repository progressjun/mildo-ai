/**
 * 리포트 발송 일정 규칙 (KST) — 화면(src/modules/reports/engine.ts sendSchedule)과 같은 영업일 달력(KR_HOLIDAYS + 설정 공휴일)을 쓴다.
 *  일간: 매일 08:00 · 전일 성과
 *  주간: 매주 월 10:00 · 월요일이 휴무면 다음 영업일 10:00 · 직전 주 월~일
 *  월간: 매월 3영업일 10:00 · 지난달 전체
 *  가치: 매월 1일 09:00 · 지난달 성과 증명 (회수 배수)
 *  이슈: P1 감지 즉시 (5분마다 확인 · 이슈당 1건)
 * 설정 공휴일을 반영하려면 호출부가 withWorkspaceConfig(cfg, () => …) 안에서 부른다(동기 함수).
 */
import { isBusinessDay, nextBusinessDay, nthBusinessDay, prevMonthKey } from '@/modules/reports/engine';
import { MONTHLY_BUSINESS_DAY } from '@/modules/reports/data';
import { addDaysStr } from '../lib/time';

/** 날짜가 속한 주의 월요일 (UTC 산술) */
export function mondayOf(date: string): string {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDaysStr(date, -((wd + 6) % 7));
}

/** 그 주의 주간 리포트 발송일 — 월요일, 휴무면 다음 영업일 */
export function weeklySendDate(date: string): string {
  const mon = mondayOf(date);
  return isBusinessDay(mon) ? mon : nextBusinessDay(mon);
}
export const isWeeklySendDay = (date: string) => weeklySendDate(date) === date;
/** 발송일 기준 대상 주 (직전 주 월~일) */
export function weeklyPeriodFor(sendDate: string): { start: string; end: string } {
  const mon = mondayOf(sendDate);
  return { start: addDaysStr(mon, -7), end: addDaysStr(mon, -1) };
}

/** 월간 리포트 발송일 — 그 달의 3영업일 */
export const monthlySendDate = (month: string) => nthBusinessDay(month, MONTHLY_BUSINESS_DAY);
export const isMonthlySendDay = (date: string) => monthlySendDate(date.slice(0, 7)) === date;
export const monthlyTargetFor = (sendDate: string) => prevMonthKey(sendDate.slice(0, 7));

/** 다음 예약 실행 (화면 표시용, KST 날짜 · 시각) */
export function upcomingRuns(today: string, hour: number, minute: number): { type: 'daily' | 'weekly' | 'monthly' | 'value' | 'issue'; at: string; covers: string; rule: string }[] {
  const now = hour * 60 + minute;
  const at = (date: string, h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+09:00`;
  const daily = now < 8 * 60 ? today : addDaysStr(today, 1);
  let weekly = weeklySendDate(today);
  if (weekly < today || (weekly === today && now >= 10 * 60)) weekly = weeklySendDate(addDaysStr(mondayOf(today), 7));
  let month = today.slice(0, 7);
  let monthly = monthlySendDate(month);
  if (monthly < today || (monthly === today && now >= 10 * 60)) { month = nextMonthOf(month); monthly = monthlySendDate(month); }
  let vMonth = today.slice(0, 7);
  let value = `${vMonth}-01`;
  if (value < today || (value === today && now >= 9 * 60)) { vMonth = nextMonthOf(vMonth); value = `${vMonth}-01`; }
  const wp = weeklyPeriodFor(weekly);
  return [
    { type: 'daily', at: at(daily, 8), covers: addDaysStr(daily, -1), rule: '매일 08:00 · 전일 성과' },
    { type: 'weekly', at: at(weekly, 10), covers: `${wp.start} ~ ${wp.end}`, rule: '매주 월 10:00 · 월요일이 휴무면 다음 영업일 10:00' },
    { type: 'monthly', at: at(monthly, 10), covers: monthlyTargetFor(monthly), rule: `매월 ${MONTHLY_BUSINESS_DAY}영업일 10:00 · 지난달` },
    { type: 'value', at: at(value, 9), covers: prevMonthKey(vMonth), rule: '매월 1일 09:00 · 지난달 성과 증명' },
    { type: 'issue', at: '감지 즉시', covers: 'P1 이슈', rule: 'P1 이슈 감지 후 5분 안 (이슈당 1건)' },
  ];
}
function nextMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
