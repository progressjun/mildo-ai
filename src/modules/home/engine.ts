/**
 * 커맨드 센터 집계 — 오늘의 운영 상태를 한 화면 요약으로.
 */
import type { ChangeRequest, Dataset, Incident } from '@/core/types';
import { DATA_TIMETABLE, GFA_DELEGATION, MEDIA } from '@/data/constants';
import { headline, monthlyPacing, previousRange, rangeOf } from '@/core/selectors';
import { comparableScope, comparableTotals } from '@/modules/board/engine';
import { paceCampaigns } from '@/modules/adpilot/engine';
import { buildTimetable, dataNowMinutes } from '@/modules/reports/engine';
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

/** '1시간 후' · '45분 후' · '1시간 5분 후' */
export function untilLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '곧';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h ? `${h}시간 ` : ''}${m ? `${m}분 ` : ''}후`;
}

export interface HomeSlot {
  time: string;
  title: string;
  channel: string;
  state: SlotState;
  /** 오른쪽 상태 문구 (완료 · N분 후 · 다음 영업일 이동 등) */
  label: string;
  /** 주말 · 공휴일 처리 규칙 (리포트 · 데이터 시간표 화면과 같은 문구) */
  offNote?: string;
}

/**
 * 커맨드 센터 시간표 — '리포트 · 데이터 시간표' 화면과 같은 계산(buildTimetable)을 써서
 * 주말 · 공휴일 이동(이슈 브리핑 → 다음 영업일 09:30 등)과 완료 상태가 두 화면에서 같게 한다.
 */
export function homeTimetable(data: Dataset, opts: { offHours?: boolean; incidents?: readonly Incident[]; changes?: readonly ChangeRequest[] } = {}) {
  const t = buildTimetable(data, { offHours: opts.offHours, incidents: opts.incidents, changes: opts.changes });
  const nowMin = dataNowMinutes(data);
  let nextAssigned = false;
  const items: HomeSlot[] = t.items.map((i) => {
    const base = { time: i.time, title: i.title, channel: i.channel, offNote: i.offMode ? i.offNote : undefined };
    if (i.status === 'done') return { ...base, state: 'done', label: '완료' };
    if (i.status === 'now') {
      nextAssigned = true;
      return { ...base, state: 'now', label: '진행 중' };
    }
    if (i.effectiveDate !== data.today) return { ...base, state: 'next', label: i.statusLabel };
    const [h, m] = i.effectiveTime.split(':').map(Number);
    if (!nextAssigned) {
      nextAssigned = true;
      return { ...base, state: 'now', label: untilLabel(h * 60 + m - nowMin) };
    }
    return { ...base, state: 'next', label: i.channel };
  });
  return { off: t.off, offLabel: t.offLabel, nextBusinessDay: t.nextBusinessDay, items };
}

/**
 * KPI 증감 근거 — 데이터가 없는 구간끼리 '0.0%'를 만들지 않고(출처 없음 · 수집 전), 직전 구간에 아직 데이터가 없던 매체 · 채널은
 * Board와 같은 기준(comparableScope)으로 증감에서 뺀다. 두 구간 모두 데이터가 있어야 증감을 낸다(없으면 NaN → 화면 '—').
 */
export function kpiCoverage(data: Dataset) {
  const y = rangeOf(data, 'yesterday');
  const py = previousRange(y);
  const w = rangeOf(data, 'last7');
  const pw = previousRange(w);
  const media = (r: { from: string; to: string }) => data.mediaDaily.some((x) => x.date >= r.from && x.date <= r.to);
  const sales = (r: { from: string; to: string }) => data.salesDaily.some((x) => x.date >= r.from && x.date <= r.to);
  const dayScope = comparableScope(data, y, py);
  const weekScope = comparableScope(data, w, pw);
  return {
    /** 웨어하우스 · 데모 어디에도 매체 · 판매 데이터가 없다 (출처 없음) */
    none: !data.mediaDaily.length && !data.salesDaily.length,
    mediaYesterday: media(y), mediaDayBefore: media(py), media7: media(w), mediaPrev7: media(pw),
    salesYesterday: sales(y), salesDayBefore: sales(py),
    day: comparableTotals(data, dayScope, y, py), week: comparableTotals(data, weekScope, w, pw),
    /** 증감 기준 문구 (같은 기준 비교로 뺀 매체 · 채널이 있을 때) */
    notes: [...new Set([dayScope.note, weekScope.note].filter((x): x is string => !!x))],
  };
}

export function operatingSummary(data: Dataset, incidents: Incident[], changes: ChangeRequest[]) {
  const h = headline(data);
  const cov = kpiCoverage(data);
  const pc = metrics.pctChange;
  const dayMedia = cov.mediaYesterday && cov.mediaDayBefore;
  const weekMedia = cov.media7 && cov.mediaPrev7;
  const open = incidents.filter((i) => i.status !== 'resolved');
  // 예산 조기 소진: Board · AD Pilot · Alert와 같은 기준(최근 28일 시간대 소진 곡선, 23시 전 마감)
  const early = paceCampaigns(data)
    .filter((c) => c.earlyExhaust)
    .map((c) => ({ id: c.id, name: c.name, media: c.media, pacePct: c.pacePct, exhaustHour: c.curveExhaustHour ?? c.linearExhaustHour, missesPeak: c.missesPeak }))
    .sort((a, b) => (a.exhaustHour ?? 24) - (b.exhaustHour ?? 24));
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
    cov,
    roasDelta: dayMedia ? pc(cov.day.cur.roas, cov.day.prev.roas) : NaN,
    costDelta: dayMedia ? pc(cov.day.cur.cost, cov.day.prev.cost) : NaN,
    salesDelta: cov.salesYesterday && cov.salesDayBefore ? pc(cov.day.sales, cov.day.prevSales) : NaN,
    cpa7Delta: weekMedia ? pc(cov.week.cur.cpa, cov.week.prev.cpa) : NaN,
    cac7Delta: weekMedia ? pc(cov.week.cur.cac, cov.week.prev.cac) : NaN,
  };
}

/** 오프라인 모닝 브리프 — 확정 팩트 / 패턴 / 해석 분리 */
export function morningBrief(data: Dataset, incidents: Incident[], changes: ChangeRequest[], proposalCount: number): Brief {
  const s = operatingSummary(data, incidents, changes);
  const y = s.h.yesterday;
  const w = s.h.last7;
  const pw = s.h.prev7;
  const mer = y.cost > 0 ? s.h.salesYesterday / y.cost : NaN;
  const facts = s.cov.none
    ? ['연결된 데이터 출처가 없어 어제 광고비 · 매출 · 실매출 데이터가 없습니다. 데이터 연결에서 매체 API를 연결하거나 CSV를 올린 뒤 다시 확인합니다.']
    : [
      s.cov.mediaYesterday
        ? `어제 광고비 ${fmt.krw(y.cost)}원, 광고 매출 ${fmt.krw(y.revenue)}원으로 ROAS ${fmt.roas(y.roas)} (전날 대비 ${fmt.delta(s.roasDelta)}). 판매 채널 합산 실매출은 ${s.cov.salesYesterday ? `${fmt.krw(s.h.salesYesterday)}원으로 광고비 대비 ${fmt.dec1(mer)}배` : '데이터 없음'}입니다. (TEST DATA)`
        : '어제 매체 광고비 · 매출 데이터가 아직 없습니다 (수집 전 또는 지연 — 데이터 연결 수집 현황 확인).',
      `최근 7일 ROAS ${fmt.roas(w.roas)}, 직전 7일 ${fmt.roas(pw.roas)}. CPA ${fmt.won(w.cpa)}, 신규 고객 CAC ${fmt.won(w.cac)}. (TEST DATA)`,
    ];
  facts.push(`열린 이슈 ${s.open.length}건 (P1 ${s.p1.length} · P2 ${s.p2.length} · P3 ${s.p3.length}), 승인 대기 변경 ${s.pending.length}건, AD Pilot 조정 후보 ${proposalCount}건.`);
  for (const n of s.cov.notes) facts.push(`${n}.`);
  const patterns: string[] = [];
  if (s.early.length) patterns.push(`일 예산 조기 소진 예상 캠페인 ${s.early.length}개(23시 전 마감, 21~23시 피크 전 마감 ${s.early.filter((c) => c.missesPeak).length}개): ${s.early.slice(0, 3).map((c) => `${c.name}(예상 마감 ${hhmmOf(c.exhaustHour)})`).join(', ')}. 최근 28일 시간대별 소진 비중이 오늘도 유지된다는 가정입니다.`);
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

/** 소수 시각(20.37) → '20:22' */
export function hhmmOf(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return '—';
  const hh = Math.floor(h);
  const mm = Math.min(59, Math.round((h - hh) * 60));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* ---------------- p.23 작동 시나리오 → 승인 요청 ---------------- */

/** 시나리오가 만든 요청을 알아보는 사유 접두어 */
export const SCENARIO_TAG = '작동 시나리오:';
/** 시나리오 GFA 일 예산 증액 폭 (p.23 예시 — 위임 범위 ±10~30% 구간) */
export const SCENARIO_BUDGET_PCT = 12;

/** GFA 쇼핑 고객 확장 예산 변경안: 천 원 단위로 반올림해 표시 변경 폭과 실제 금액이 어긋나지 않게 한다 */
export function scenarioBudget(dailyBudget: number, pct = SCENARIO_BUDGET_PCT) {
  const before = Number.isFinite(dailyBudget) && dailyBudget > 0 ? dailyBudget : 0;
  const after = Math.round((before * (1 + pct / 100)) / 1000) * 1000;
  const changePct = before > 0 ? Math.round(((after - before) / before) * 1000) / 10 : 0;
  const route = GFA_DELEGATION.find((g) => Math.abs(changePct) <= g.maxPct) ?? GFA_DELEGATION[GFA_DELEGATION.length - 1];
  return { before, after, changePct, approver: route.approver, approverLabel: route.label };
}

type ScenarioRequest = Pick<ChangeRequest, 'module' | 'kind' | 'target' | 'targetId' | 'before' | 'after' | 'changePct' | 'reason' | 'requestedBy' | 'approver'>;

/** 시나리오 승인 요청 2건: Lab 키워드 테스트 등록(담당 AE) · GFA 예산 변경(위임 범위 → PM) */
export function scenarioRequests(data: Dataset): ScenarioRequest[] {
  const out: ScenarioRequest[] = [
    { module: 'lab', kind: 'keyword_add', target: '생활 상황_TEST (신혼 구문형 4개)', before: '-', after: '테스트 그룹 등록', reason: `${SCENARIO_TAG} '신혼' 수요 증가 가정 → 구문형 후보 테스트`, requestedBy: 'AD Pilot', approver: 'AE' },
  ];
  const gfa = data.campaigns.find((c) => c.name.includes('쇼핑 고객 확장'));
  if (gfa) {
    const b = scenarioBudget(gfa.dailyBudget);
    out.push({ module: 'gfa', kind: 'budget', target: gfa.name, targetId: gfa.id, before: b.before, after: b.after, changePct: b.changePct, reason: `${SCENARIO_TAG} 신혼 수요 환기 — 쇼핑 고객 확장 예산 증액`, requestedBy: 'GFA Control', approver: b.approver });
  }
  return out;
}

/** 시나리오 요청이 아직 승인 대기 중인지 — 대기 중이면 같은 요청을 다시 만들지 않는다 (화면 이동 · 재실행 뒤에도) */
export function scenarioPending(changes: readonly ChangeRequest[]): boolean {
  return changes.some((c) => c.status === 'pending' && typeof c.reason === 'string' && c.reason.startsWith(SCENARIO_TAG));
}
