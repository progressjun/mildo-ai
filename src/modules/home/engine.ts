/**
 * 커맨드 센터 집계 — 오늘의 운영 상태를 한 화면 요약으로.
 */
import type { ChangeRequest, Dataset, Incident } from '@/core/types';
import { DATA_TIMETABLE, MEDIA } from '@/data/constants';
import { campaignPacing, headline, monthlyPacing } from '@/core/selectors';
import { fmt, isOffDay, metrics } from '@/core/util';
import type { Brief } from '@/ai/prompts';

export type SlotState = 'done' | 'now' | 'next';

/** 데이터 시간표 진행 상태 (기준 시각 hh:mm) */
export function timetableProgress(currentHour: number, minute = 30) {
  const nowMin = currentHour * 60 + minute;
  let nextAssigned = false;
  return DATA_TIMETABLE.map((t) => {
    const [h, m] = t.time.split(':').map(Number);
    const at = h * 60 + m;
    let state: SlotState = at <= nowMin ? 'done' : 'next';
    if (state === 'next' && !nextAssigned) {
      nextAssigned = true;
      state = 'now';
    }
    return { ...t, state, minutesUntil: at - nowMin };
  });
}

export function operatingSummary(data: Dataset, incidents: Incident[], changes: ChangeRequest[]) {
  const h = headline(data);
  const open = incidents.filter((i) => i.status !== 'resolved');
  const early = campaignPacing(data).filter((c) => c.earlyExhaust);
  const pacing = monthlyPacing(data);
  const over = pacing.filter((p) => p.status === 'over');
  const under = pacing.filter((p) => p.status === 'under');
  const pending = changes.filter((c) => c.status === 'pending');
  const off = isOffDay(data.today);
  return {
    h,
    open,
    p1: open.filter((i) => i.severity === 'P1'),
    p2: open.filter((i) => i.severity === 'P2'),
    p3: open.filter((i) => i.severity === 'P3'),
    early,
    over,
    under,
    pending,
    off,
    roasDelta: metrics.pctChange(h.yesterday.roas, h.dayBefore.roas),
    costDelta: metrics.pctChange(h.yesterday.cost, h.dayBefore.cost),
    salesDelta: metrics.pctChange(h.salesYesterday, h.salesDayBefore),
  };
}

/** 오프라인 모닝 브리프 — 확정 팩트 / 패턴 / 해석 분리 */
export function morningBrief(data: Dataset, incidents: Incident[], changes: ChangeRequest[], proposalCount: number): Brief {
  const s = operatingSummary(data, incidents, changes);
  const y = s.h.yesterday;
  const w = s.h.last7;
  const pw = s.h.prev7;
  const mer = s.h.salesYesterday / (y.cost || 1);
  const facts = [
    `어제 광고비 ${fmt.krw(y.cost)}원, 광고 매출 ${fmt.krw(y.revenue)}원으로 ROAS ${fmt.roas(y.roas)} (전날 대비 ${fmt.delta(s.roasDelta)}). 판매 채널 합산 실매출은 ${fmt.krw(s.h.salesYesterday)}원으로 광고비 대비 ${mer.toFixed(1)}배입니다. (TEST DATA)`,
    `최근 7일 ROAS ${fmt.roas(w.roas)}, 직전 7일 ${fmt.roas(pw.roas)}. CPA ${fmt.won(w.cpa)}, 신규 고객 CAC ${fmt.won(w.cac)}. (TEST DATA)`,
    `열린 이슈 ${s.open.length}건 (P1 ${s.p1.length} · P2 ${s.p2.length} · P3 ${s.p3.length}), 승인 대기 변경 ${s.pending.length}건, AD Pilot 조정 후보 ${proposalCount}건.`,
  ];
  const patterns: string[] = [];
  if (s.early.length) patterns.push(`일 예산 조기 소진 예상 캠페인 ${s.early.length}개: ${s.early.slice(0, 3).map((c) => `${c.name}(예상 마감 ${Math.floor(c.exhaustHour ?? 0)}시)`).join(', ')}. 현재 소진 속도가 유지된다는 가정입니다.`);
  if (s.over.length) patterns.push(`월 예산 초과 페이스 매체: ${s.over.map((p) => `${MEDIA[p.media].name}(예상 월 소진 ${fmt.krw(p.projected)} / 예산 ${fmt.krw(p.budget)})`).join(', ')}.`);
  if (s.under.length) patterns.push(`월 예산 미달 페이스 매체: ${s.under.map((p) => MEDIA[p.media].name).join(', ')} — 소진율이 기대치의 90% 미만입니다.`);
  const interpretation = [
    s.p1.length
      ? `P1 이슈가 열려 있는 동안 해당 매체의 자동 입찰 조정은 보류하는 것이 안전합니다. 근거가 되는 데이터(전환 · 결제)가 정상인지 확인되기 전 조정은 잘못된 신호로 움직일 위험이 큽니다.`
      : `P1 이슈가 없으므로 AD Pilot 조정 후보를 승인 범위 내에서 처리할 수 있는 상태입니다.`,
    `조기 소진 캠페인은 증액보다 시간대 입찰 조정이 먼저입니다. 증액은 해당 캠페인의 한계 ROAS가 목표 이상일 때만 의미가 있고, 확인 전에는 소진 속도만 늦추는 편이 볼륨 손실이 작습니다.`,
  ];
  const conditions = [
    `목표 ROAS 400%(초기값 · 온보딩 중 확정), 브랜드 키워드 800%. 데이터 급변 기준 동요일 · 동시간 대비 ±50% (제안서 p.44).`,
    s.off.off ? `오늘은 ${s.off.label}로 주말 · 공휴일 체계(당번 AE 30분 내 확인, P1은 PM 에스컬레이션)가 적용됩니다.` : `평일 운영 체계 적용.`,
  ];
  const counter = [
    `급변 이슈가 매체 집계 지연이라면 1~2시간 뒤 수치가 정상화됩니다. 이 경우 조치보다 재확인이 맞고, 오탐으로 기록해 탐지 기준 튜닝에 반영합니다.`,
  ];
  const actions = [
    s.p1.length ? `담당 AE: P1 ${s.p1.length}건 30분 내 1차 조치, 2시간 내 결과 보고 (MILDO Alert).` : `담당 AE: 승인 범위 내 AD Pilot 후보 처리.`,
    `PM: 16:30 익일 조정안 공유 전에 조기 소진 캠페인 처리 방향 결정.`,
  ];
  return { title: '오늘의 운영 브리프', facts, patterns, interpretation, conditions, counter, actions };
}
