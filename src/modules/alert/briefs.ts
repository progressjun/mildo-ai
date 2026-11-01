/**
 * MILDO Alert 오프라인 브리프 (AI 미연결 시 규칙 엔진 답변).
 * 확정 팩트 / 반복 관측 패턴 / AI 해석(규칙 해석) / 전제 조건 / 반례 / 다음 액션을 분리한다.
 */
import type { Brief } from '@/ai/prompts';
import type { Dataset, Incident } from '@/core/types';
import { SLA } from '@/data/constants';
import { fmt, sum } from '@/core/util';
import {
  checkAccounts, fmtDateShort, fmtStamp, heldMedia, historyRecords, holidayPrecheck, nextAction, nextBusinessDay, offBlocks, onDutyFor,
  primaryEvidence, regimeOf, sessionRecords, slaReport, slaState, typeOf, type AlertConfig, type AlertIncident,
} from './engine';
import { TYPE_LABEL } from './data';
import { MEDIA } from '@/data/constants';

const mediaLabel = (m?: string) => (m ? MEDIA[m as keyof typeof MEDIA]?.name ?? m : '');

function interpret(i: AlertIncident): string | null {
  const ev = (label: string) => i.evidence?.find((e) => e.label === label);
  switch (i.ruleId) {
    case 'tracking_break': {
      const c = ev('클릭');
      const ratio = c && c.baseline ? c.observed / c.baseline : NaN;
      return `${mediaLabel(i.media)} 전환 0은 매출 감소보다 측정 단절일 가능성이 높다고 본다. 클릭은 최근 7일 동시간 대비 ${fmt.ratio(ratio, 0)}(판정 기준 50% 이상)로 유입은 유지되고 있고, 전환과 매출이 동시에 0으로 고정되는 패턴은 평소 같은 시간대에 기록되지 않았다. 자동 입찰이 이 신호로 입찰을 낮추면 재방문 퍼널 볼륨이 줄어 측정 오류가 실제 손실로 바뀌므로 보류가 우선이다.`;
    }
    case 'data_spike': {
      const cost = ev('광고비');
      const cpa = ev('CPA');
      return `${mediaLabel(i.media)} 광고비 ${cost?.deltaPct !== undefined ? fmt.delta(cost.deltaPct) : ''}는 원인 후보 1순위 '${i.causes?.[0]?.label ?? '확인 중'}'(${i.causes?.[0]?.basis ?? ''}) 기준으로 먼저 확인한다. CAC 관점에서 같은 구간 CPA ${cpa?.deltaPct !== undefined && Number.isFinite(cpa.deltaPct) ? fmt.delta(cpa.deltaPct) : '—'}${cpa?.note ? ` (${cpa.note})` : ''}이므로 원인 확인 전 증액 · 자동 조정은 하지 않는다.`;
    }
    case 'account_payment':
      return `${i.target} 문제는 단순 충전 누락이 아니라 운영 시간 구조 문제다. ${i.impactNote ?? ''} 결제 수단 소유가 수면밀도이므로 충전 요청 → 승인까지의 리드타임이 주말에 길어진다.`;
    case 'budget_forecast':
      return `${i.target}: ${i.impactNote ?? ''} 증액은 한계 ROAS가 목표 이상일 때만 의미가 있고, 확인 전에는 시간대 입찰 조정으로 저녁 구간 노출을 남기는 편이 볼륨 손실이 작다.`;
    case 'keyword_spike':
      return `${i.target}의 CPC 상승은 원인 후보 1순위 '${i.causes?.[0]?.label ?? ''}'와 맞는다. 단가 상승을 입찰 상향으로 따라가면 비교 · 검토 단계 CPA가 구조적으로 올라가므로, 3일 이상 지속 여부와 순위 손실 규모를 보고 판단한다.`;
    case 'brand_intrusion':
      return `브랜드 키워드는 수요 회수 단계 마지막 접점이라 상위 지면을 내주면 이미 만든 수요를 경쟁사가 회수한다. 다만 순위 · 노출 손실 기반 추정이므로 SERP 스냅샷 확인 전에는 방어 입찰 폭을 브랜드 기준(목표 ROAS 800%) 안에서만 쓴다.`;
    case 'soldout_landing':
      return `옵션 지정 키워드가 품절 상세로 들어가면 클릭 비용은 그대로 쓰고 전환 경로는 막힌다. 다른 사이즈 구매 전환이 일부 있을 수 있어 손실액은 상한 추정이다.`;
    default:
      return null;
  }
}

export function issuesBrief(data: Dataset, incidents: readonly Incident[], nowMs = Date.parse(data.generatedAt), toMs: (iso: string) => number = Date.parse, offHours = false): Brief {
  const list = (incidents as AlertIncident[]).filter((i) => i.status !== 'resolved');
  const p = { P1: list.filter((i) => i.severity === 'P1'), P2: list.filter((i) => i.severity === 'P2'), P3: list.filter((i) => i.severity === 'P3') };
  const regime = regimeOf(data.today, offHours);
  const top = [...p.P1, ...p.P2].slice(0, 6);
  const facts = [
    `기준 ${fmtDateShort(data.today)} ${String(data.currentHour).padStart(2, '0')}:30 열린 이슈 ${list.length}건 (P1 ${p.P1.length} · P2 ${p.P2.length} · P3 ${p.P3.length}). 수치는 시연용 TEST DATA.`,
    ...top.map((i) => `${i.severity} ${i.title}: ${primaryEvidence(i)} (판정 기준 ${i.basis ?? '—'}, 제안서 ${i.page ?? 'p.44'}).`),
  ];
  const held = heldMedia(list);
  const patterns: string[] = [];
  if (held.length) patterns.push(`자동 조정 보류 매체 ${held.map((m) => MEDIA[m].name).join(', ')} — 원인 확인 전 AD Pilot 자동 조정이 멈춘 상태.`);
  const rec = list.filter((i) => i.recurrence?.count);
  for (const i of rec) patterns.push(`${i.title.replace(/^\[테스트\] /, '')}: 최근 30일 같은 유형 · 매체 ${i.recurrence!.count}회 (${i.recurrence!.dates.join(', ')}) — 재발 이슈로 재발 방지 항목 필요.`);
  const byMedia = new Map<string, AlertIncident[]>();
  for (const i of list) if (i.media) (byMedia.get(i.media) ?? byMedia.set(i.media, []).get(i.media)!).push(i);
  for (const [m, l] of byMedia) if (l.length >= 2) patterns.push(`${mediaLabel(m)}에서 ${l.length}건이 동시에 열림 (${l.map((x) => x.ruleLabel ?? TYPE_LABEL[typeOf(x)] ?? x.ruleId).join(' / ')}) — 같은 원인에서 이어진 연쇄인지 먼저 확인.`);
  const PRIORITY = ['tracking_break', 'account_payment', 'data_spike', 'keyword_spike', 'budget_forecast', 'brand_intrusion', 'soldout_landing'];
  const interpretation = [...list].filter((i) => PRIORITY.includes(i.ruleId))
    .sort((a, b) => PRIORITY.indexOf(a.ruleId) - PRIORITY.indexOf(b.ruleId))
    .filter((i, k, arr) => arr.findIndex((x) => x.ruleId === i.ruleId) === k)
    .map(interpret).filter((x): x is string => !!x).slice(0, 5);
  const conditions = [
    '데이터 급변 동요일 · 동시간 ±50% (p.44), 이상 징후 주의 ±30% · 위험 ±50%, 전환 −30/−50%, CPA +30/+50%, ROAS −20/−35% (p.47). 수치 기준은 초기값이며 온보딩 중 오탐률을 보며 조정.',
    `SLA P1 인지 ${SLA.P1.label.ack} · 1차 조치 ${SLA.P1.label.action} · 결과 보고 ${SLA.P1.label.report}, P2 ${SLA.P2.label.ack} · ${SLA.P2.label.action} · ${SLA.P2.label.report} (p.49).`,
    regime.off ? `${regime.label} — 당번 ${regime.duty?.role ?? 'AE'} 30분 내 확인, P1은 PM 에스컬레이션, 나머지는 다음 영업일 ${fmtDateShort(nextBusinessDay(data.today))} 09:30 브리핑 (p.44 · p.48).` : '평일 운영 체계.',
    '시간 단위 전환은 표본이 작아(구간 기대 전환 1건 미만) 전환 · CPA · ROAS는 단독 판정하지 않고 참고로 표시.',
  ];
  const counter = [
    '전환 집계가 1~3시간 늦게 소급 반영되는 매체라면 다음 수집 주기에 수치가 채워진다. 이 경우 오탐으로 종료하고 연속 시간 기준을 재검토한다.',
    '광고비 급증이 프로모션 · 소재 교체에 따른 의도된 증액이면 이상이 아니다. MILDO Flow 변경 이력으로 먼저 확인한다.',
  ];
  const actions = top.slice(0, 5).map((i) => {
    const st = slaState(i, nowMs, toMs, offHours);
    return `${i.assignee ?? '담당 AE'}${i.onDuty ? '(당번)' : ''} · ${st.deadlineMs ? `${fmtStamp(st.deadlineMs)}까지 ${st.stageLabel}` : st.stageLabel} — ${i.title.replace(/^\[테스트\] /, '')}: ${nextAction(i.ruleId)}.`;
  });
  return { title: 'MILDO Alert 이슈 브리프', facts, patterns, interpretation, conditions, counter, actions };
}

export function accountsBrief(data: Dataset, cfg?: AlertConfig): Brief {
  const checks = checkAccounts(data, cfg);
  const bad = checks.filter((c) => c.worst === 'fail' || c.worst === 'warn');
  const prepaid = checks.filter((c) => c.prepaid);
  const facts = [
    `광고 계정 ${checks.length}개 중 점검 실패 ${checks.filter((c) => c.worst === 'fail').length} · 주의 ${checks.filter((c) => c.worst === 'warn').length} (TEST DATA). 선결제 잔액 합계 ${fmt.krw(sum(prepaid, (c) => c.account.balance))}원.`,
    ...bad.map((c) => `${c.account.name}: ${c.findings.filter((f) => f.level === 'fail' || f.level === 'warn').map((f) => f.detail).join(' / ')}.`),
  ];
  const minRun = prepaid.filter((c) => Number.isFinite(c.runwayDays)).sort((a, b) => a.runwayDays - b.runwayDays)[0];
  const patterns = [
    minRun ? `잔액 소진이 가장 빠른 계정은 ${minRun.account.name} (${fmt.dec1(minRun.runwayDays)}일치${minRun.exhaustAtMs ? `, ${fmtStamp(minRun.exhaustAtMs)} 소진 예상` : ''}).` : '선결제 계정 없음.',
    ...historyRecords().filter((r) => r.typeId === 'account_payment').length ? [`10월 계정 · 결제 이슈 이력 ${historyRecords().filter((r) => r.typeId === 'account_payment').length}건 — 같은 GFA 계정에서 반복.`] : [],
  ];
  return {
    title: '계정 · 결제 · 권한 점검',
    facts,
    patterns,
    interpretation: [
      '계정 · 결제 이슈는 성과 지표보다 먼저 집행 자체를 멈추게 하므로 P1로 둔다. 결제 수단 소유가 수면밀도이므로 대행사 역할은 잔액 모니터링과 충전 요청이고, 승인 리드타임이 주말에 길어지는 것이 실제 위험이다.',
      '비실명 공유 관리자 계정은 금액 손실이 바로 나타나지 않지만, 캠페인 · 결제 변경 권한이 통제 범위 밖에 있다는 뜻이다.',
    ],
    conditions: ['잔액 1일치 미만 · 자동충전 실패 · 권한 변경 · 계정 제재 → P1 (p.44). 접근 권한은 담당자 실명 계정 · 최소 권한, 교체 시 즉시 회수 (p.50). 주말 대비 잔액 3일치는 운영 가정.'],
    counter: ['후불 계정(Google · Meta)은 카드 한도 정보가 연동되지 않아 이 화면에서 소진 위험을 판단하지 못한다. 한도는 수면밀도 확인이 필요하다.'],
    actions: [
      ...bad.filter((c) => c.findings.some((f) => f.level === 'fail' && (f.label === '잔액' || f.label === '자동충전'))).map((c) => `PM · 즉시: ${c.account.name} 충전 요청 (승인: 수면밀도) · 자동충전 카드 확인.`),
      ...bad.filter((c) => c.nonRealName).map((c) => `PM · 당일: ${c.account.name} 비실명 계정 권한 회수 요청 (PM → 수면밀도 통보).`),
    ],
  };
}

export function holidayBrief(data: Dataset, cfg?: AlertConfig, tfNames?: Record<string, string>): Brief {
  const blocks = offBlocks(data.today, 120);
  const cur = blocks[0];
  const long = blocks.find((b) => b.days >= 3 && b.start > data.today);
  const pc = cur ? holidayPrecheck(data, cur, { config: cfg ?? undefined, tfNames }) : null;
  const fails = pc?.items.filter((i) => i.level === 'fail') ?? [];
  const duty = onDutyFor(data.today);
  return {
    title: '주말 · 공휴일 대응 · 연휴 전 점검',
    facts: [
      duty ? `${fmtDateShort(data.today)}은 ${duty.label} — 당번 ${duty.role}${tfNames?.[duty.roleId] ? `(${tfNames[duty.roleId]})` : ''}, 백업 ${duty.backup}, P1은 PM 에스컬레이션.` : `${fmtDateShort(data.today)}은 평일.`,
      cur && pc ? `현재 휴무 구간 ${fmtDateShort(cur.start)}~${fmtDateShort(cur.end)} 점검: 실패 ${fails.length} · 주의 ${pc.items.filter((i) => i.level === 'warn').length} · 통과 ${pc.items.filter((i) => i.level === 'pass').length} (커버 ${fmt.dec1(pc.coverHours)}시간).` : '휴무 구간 없음.',
      ...fails.slice(0, 5).map((f) => `${f.group} · ${f.item}: ${f.detail}.`),
    ],
    patterns: long ? [`다음 3일 이상 연휴는 ${fmtDateShort(long.start)}~${fmtDateShort(long.end)} (${long.labels.join(' · ')}), 사전 점검일 ${fmtDateShort(long.prevBusinessDay)}.`] : [],
    interpretation: ['주말 이슈의 손실은 감지 지연이 아니라 조치 권한 공백에서 커진다. 당번 AE가 해당 매체 계정 권한이 없으면 30분 확인은 지켜도 1차 조치는 PM 대행으로 넘어가므로, 연휴 전 권한 · 잔액을 같이 점검한다.'],
    conditions: ['1차 MILDO Alert 상시 → 2차 당번 AE 30분 내 확인 → 3차 PM 에스컬레이션(P1 한정) (p.48). 연휴 전날 사전 점검: 예산 · 소재 · 결제 잔액 (p.48). 당번 순번 방식은 운영 가정.'],
    counter: ['점검 결과는 현재 데이터 기준 시뮬레이션이다. 연휴 전날 17:00 데이터로 다시 돌려야 실제 잔액 · 소재 상태를 반영한다.'],
    actions: fails.slice(0, 4).map((f) => `${f.group === '결제 잔액' ? 'PM' : '담당 AE'} · 연휴 전: ${f.item} — ${f.action}.`),
  };
}

export function slaBrief(incidents: readonly Incident[], toMs: (iso: string) => number = Date.parse): Brief {
  const rec = [...historyRecords(), ...sessionRecords(incidents, toMs)];
  const r = slaReport(rec);
  const p = (x: number) => (Number.isFinite(x) ? `${x.toFixed(0)}%` : '—');
  return {
    title: '월간 SLA 리포트 요약',
    facts: [
      `2026년 10월 이슈 ${r.total.total}건 (지난 이력 DEMO + 이번 세션 처리). 인지 SLA 달성 ${p(r.total.ack.pct)}, 1차 조치 ${p(r.total.action.pct)}, 결과 보고 ${p(r.total.report.pct)}.`,
      ...r.rows.map((x) => `${x.severity} ${x.total}건 · 인지 ${p(x.ack.pct)} · 조치 ${p(x.action.pct)} · 보고 ${p(x.report.pct)} · 오탐 ${x.falsePositive.n}건 · 재발 ${x.recurrence}건 · 매체 지연 ${x.mediaDelay.n}건(${x.mediaDelay.min}분).`),
    ],
    patterns: [`오탐률 ${p(r.total.falsePositive.pct)} — 오탐은 주로 매체 집계 지연에서 발생 (이력 기준).`],
    interpretation: ['달성률은 매체 지연(검수 대기 · 집계 지연) 시간을 빼고 산정한다. 매체 지연을 포함하면 대행사 통제 밖 요인이 달성률을 흔들어 개선 대상이 흐려진다.'],
    conditions: ['P1 15분 · 30분 · 2시간, P2 1시간 · 4시간 · 당일, P3 1일 · 협의 · 주간 (p.49). 주말 · 공휴일은 당번 30분 확인 (p.48).'],
    counter: ['지난 이력은 시연용 DEMO 데이터라 실제 달성률이 아니다. 온보딩 후 실제 처리 이력으로 대체된다.'],
    actions: ['PM · 매월 3영업일: 월간 SLA 리포트 공개 (p.49) · 오탐 상위 지표 기준 조정 요청.'],
  };
}
