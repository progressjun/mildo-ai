/**
 * MILDO Watch 스냅샷 · 오프라인 브리프 (React 없음).
 * 화면 · 에이전트 도구 · 규칙 기반 브리프가 같은 계산 결과를 쓰도록 한 곳에서 묶는다.
 */
import type { ChangeRequest, Dataset } from '@/core/types';
import type { Brief } from '@/ai/prompts';
import { fmt, fmtDate } from '@/core/util';
import { MEDIA } from '@/data/constants';
import {
  archiveMatrix, archiveRows, brandSearchTrend, brandSerpCheck, dataNowMs, evaluateEvents, intentExposure, nextWeeklyReport, pipelineCounts,
  resolveWatchConfig, seasonCalendar, trackingOverview, weeklyBrief, type ProgressMap, type WatchConfig,
} from './engine';
import { MEDIA_TRACKING } from './data';

export function computeWatch(d: Dataset, opts: { changes?: readonly ChangeRequest[]; overrides?: ProgressMap; nowMs?: number; cfg?: WatchConfig } = {}) {
  const cfg = opts.cfg ?? resolveWatchConfig();
  const nowMs = opts.nowMs ?? dataNowMs(d);
  const events = evaluateEvents(d, { cfg, overrides: opts.overrides ?? {}, changes: opts.changes ?? [], nowMs });
  const archive = archiveRows(d, undefined, events);
  const matrix = archiveMatrix(d, archive, 30);
  const serp = brandSerpCheck(d, cfg);
  const calendar = seasonCalendar(d, 120);
  const trend = brandSearchTrend(d, 56, cfg);
  const exposure = intentExposure(d);
  const tracking = trackingOverview(d, events);
  const counts = pipelineCounts(events);
  const brief = weeklyBrief(d, events, archive, serp, calendar, cfg, nowMs);
  return { cfg, nowMs, events, archive, matrix, serp, calendar, trend, exposure, tracking, counts, brief, report: nextWeeklyReport(d, nowMs) };
}
export type WatchSnapshot = ReturnType<typeof computeWatch>;

const mediaName = (m: string) => MEDIA_TRACKING.find((t) => t.media === m)?.name ?? MEDIA[m as keyof typeof MEDIA]?.name ?? m;

/** 매체 변동 선제 트래킹 브리프 */
export function changesBrief(s: WatchSnapshot): Brief {
  const open = s.events.filter((e) => !e.closed && e.stage !== 'wrapup');
  const impact = open.filter((e) => e.diag.verdict === 'high' || e.diag.verdict === 'impact');
  const urgent = open.filter((e) => e.stage === 'detect').sort((a, b) => (a.due.remainingH ?? 1e9) - (b.due.remainingH ?? 1e9));
  const hold = open.filter((e) => e.diag.verdict === 'hold');
  const wrap = open.filter((e) => e.stage === 'test' && !e.next.disabled);
  return {
    title: 'MILDO Watch · 매체 변동 선제 트래킹',
    facts: [
      `진행 중 매체 변동 ${open.length}건 — 감지 ${s.counts.detect} · 영향 진단 ${s.counts.diagnose} · 실행안 ${s.counts.plan} · 소액 테스트 ${s.counts.test}, 랩업 완료 ${s.counts.wrapup}건 (TEST DATA · 매체 공지는 시연용 가상 이벤트).`,
      ...impact.slice(0, 4).map((e) => `${mediaName(e.media)} · ${e.title}: ${e.diag.label} — ${e.diag.basis}.`),
      ...(urgent[0] ? [`진단 기한이 가장 가까운 건은 ${mediaName(urgent[0].media)} · ${urgent[0].title} (${urgent[0].due.label}).`] : []),
    ],
    patterns: [
      ...s.tracking.filter((t) => t.open > 1).map((t) => `${t.name}: 진행 중 ${t.open}건 (공지 ${t.notices} · 데이터 감지 ${t.signals}) — 7일 ROAS ${fmt.roas(t.roas)} (${fmt.delta(t.roasDelta)}).`),
    ],
    interpretation: [
      '규칙 기반 해석: 매체 공지와 데이터 변화가 같은 시기에 겹쳐도 공지가 원인이라는 근거는 아니다. 원인 후보는 경쟁 입찰 · 매체 로직 · 집계 지연으로 나눠 보고, 소액 테스트로 분리 측정한 결과로만 확대한다.',
    ],
    conditions: [
      `영향 진단: p.47 주의 기준 (광고비 · 클릭 ±${s.cfg.warn.cost}%, CPA +${s.cfg.warn.cpa}%, ROAS −${s.cfg.warn.roas}%) · 감지 후 ${s.cfg.diagnoseSlaHours}시간 내 (p.24).`,
      `소액 테스트: 영향 캠페인 일 예산 ${Math.round(s.cfg.testBudgetShare * 100)}% × ${s.cfg.testDays}일 (운영 가정), 중단 ${s.cfg.stopDay}일차 −${s.cfg.stopCvrDropPct}% · 확대 +${s.cfg.expandCvrLiftPct}% (p.28).`,
    ],
    counter: hold.length ? hold.map((e) => `${e.diag.holdReason} — ${mediaName(e.media)} 변동은 전환 추적 확인 전까지 진단 · 테스트 등록을 보류한다.`) : ['보류 매체 없음. 다만 일 단위 수집 지표는 07:00 수집 이후에만 갱신된다.'],
    actions: [
      ...urgent.slice(0, 3).map((e) => `${mediaName(e.media)} · ${e.title}: 영향 진단 완료 처리 (${e.due.label}) — 담당 AE.`),
      ...wrap.slice(0, 2).map((e) => `${mediaName(e.media)} · ${e.title}: 랩업 기록 (${e.judge.label}) — PM.`),
      `실행안은 ${s.report.label}에 반영하고, 테스트는 Lab 등록 요청(승인 PM)으로 넘긴다.`,
    ],
  };
}

/** 경쟁사 아카이브 · 브랜드 지면 브리프 */
export function competitorsBrief(s: WatchSnapshot): Brief {
  const high = s.archive.filter((r) => r.impact.level === 'high' && r.date >= s.matrix.from);
  const above = s.serp.filter((x) => x.verdict === 'above');
  return {
    title: 'MILDO Watch · 경쟁 6개사 아카이브',
    facts: [
      `최근 ${s.matrix.days}일(${fmtDate(s.matrix.from)}~${fmtDate(s.matrix.to)}) 아카이브 변경 ${s.archive.filter((r) => r.date >= s.matrix.from).length}건, 영향도 높음 ${high.length}건 (시연용 가상 스냅샷).`,
      ...s.matrix.byCompetitor.filter((c) => c.count).map((c) => `${c.competitor}: 변경 ${c.count}건 · 높음 ${c.high}건${c.latest ? ` · 최근 ${fmtDate(c.latest.date)} ${c.latest.title}` : ''}.`),
      `브랜드 키워드 ${s.serp.length}개 중 ${above.length}개에서 경쟁사 광고가 자사보다 위 (자사 순위는 키워드 평균 순위 TEST DATA 기준).`,
    ],
    patterns: high.slice(0, 4).map((r) => `${fmtDate(r.date)} ${r.competitor ?? '공통'} ${r.itemLabel}: ${r.title} — ${r.impact.basis}.`),
    interpretation: [
      '규칙 기반 해석: 경쟁사 가격 인하 · 기획전은 일반 제품 · 비교 검토 키워드의 CVR · CPC에 먼저 나타난다. 할인율을 맞추는 대응은 CAC를 올리므로, CPA 상한을 지키는 입찰 유지와 혜택 · 배송 메시지 보완을 우선 검토한다.',
    ],
    conditions: ['영향도 기준(운영 가정): 실판매가 −10% 이상 높음 · −5% 이상 중간, 자사 기획전과 기간 중복 · 할인율 ≥ 자사 높음, 브랜드 키워드 지면 경쟁사 광고 = 높음 (p.45 브랜드 키워드 침투).', '수집 주기: 소재 · 프로모션 변경 즉시 알림, 가격 · 혜택 일 단위, 파트너 매체 인사이트 월간 (p.25).'],
    counter: ['스냅샷은 하루 1회 기준이라 장중 변경은 다음 날 반영된다. 일시 쿠폰이면 영향이 1~2일에 그칠 수 있다.'],
    actions: [
      ...high.filter((r) => r.alertable).slice(0, 2).map((r) => `${r.competitor} ${r.itemLabel} 변경: MILDO Alert P3 등록 · 24시간 내 영향 분석 (p.44) — SA Lead AE.`),
      ...(above.length ? [`브랜드 키워드 ${above.map((x) => `'${x.keyword}'`).join(' · ')}: 방어 입찰 검토 → AD Pilot (브랜드 목표 ROAS ${s.cfg.brandTargetRoas}% · 순위 방어 우선) — PM 승인.`] : []),
    ],
  };
}

/** 외부 변수 · 시즌 브리프 */
export function seasonBrief(s: WatchSnapshot): Brief {
  const active = s.calendar.filter((c) => c.active);
  const next = s.calendar.filter((c) => c.dday > 0).slice(0, 4);
  const y = s.trend.yesterday;
  const life = s.exposure.find((e) => e.intent === 'life');
  return {
    title: 'MILDO Watch · 외부 변수 · 시즌 캘린더',
    facts: [
      ...(y ? [`브랜드 검색량 ${fmtDate(y.date)} ${fmt.int(y.volume)} — 최근 4주 동요일 평균 ${fmt.int(y.base)} 대비 ${fmt.delta(y.deltaPct)} (기준 ±${s.cfg.searchShiftPct}%, TEST DATA).`] : ['브랜드 검색량 데이터 없음.']),
      ...(life ? [`생활 상황 키워드 노출 최근 14일 ${fmt.int(life.last)} (직전 ${fmt.delta(life.delta)})${life.newKeywords.length ? ` · 신규 노출 ${life.newKeywords.join(' · ')}` : ''}.`] : []),
      ...active.map((c) => `진행 중: ${c.label} (${c.kindLabel}, ${fmtDate(c.start, false)}~${fmtDate(c.end, false)}, ${c.basis}).`),
    ],
    patterns: [],
    interpretation: ['규칙 기반 해석: 이사 · 혼인 시즌은 일반 관측을 옮긴 가설이다. 생활 상황 구문형 유입 증가가 시즌 때문인지 매체 노출 확대 때문인지는 검색 트렌드 연동 후 같은 기간 전년 대비로 분리해야 한다.'],
    conditions: ['시즌 창 · 수요 지수는 가설 표기 (검색 트렌드 API 연동 전). 공휴일은 KR_HOLIDAYS 기준이며 대체공휴일은 정부 고시로 확인.'],
    counter: ['시즌 수요가 실제로 늘어도 경쟁사 프로모션이 같은 구간에 몰리면 CPC 상승으로 ROAS가 오히려 낮아질 수 있다.'],
    actions: next.map((c) => `${c.label} D-${c.dday} (${c.kindLabel}): ${c.prep}.`),
  };
}

export function weeklyBriefOf(s: WatchSnapshot): Brief {
  return s.brief.brief;
}
