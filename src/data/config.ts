/**
 * 워크스페이스 설정 (docs/SAAS_SPEC.md §4 settings) — 스키마 · 기본값 · 병합 · 런타임 적용.
 *
 * 기본값(DEFAULT_CONFIG) = 지금의 src/data/constants.ts(수면밀도 RFP · 제안서 v3) 값. 워크스페이스는 바꾸고 싶은 항목만
 * 덮어쓰기(override)로 저장한다(workspaces.config). 덮어쓰지 않은 항목은 기본값을 따른다.
 *
 * applyWorkspaceConfig(cfg): constants.ts가 내보낸 객체 · 배열(과 그 값을 모듈 로드 시 복사해 둔 엔진 기본값)을 제자리에서 갱신한다.
 *   이 파일만 고치면 되도록 constants.ts는 건드리지 않는다 — 모든 모듈이 import한 같은 객체를 보므로 바로 반영된다.
 *   applyWorkspaceConfig(null)은 모듈 로드 시점에 structuredClone으로 떠 둔 원래 값으로 정확히 되돌린다.
 *   프런트: 워크스페이스가 정해지면 플랫폼이 호출(src/saas/context.tsx). 서버: 엔진 실행 직전 withWorkspaceConfig로 감싼다.
 *
 * withWorkspaceConfig(cfg, fn): cfg를 적용한 채로 fn을 동기 실행하고, 예외가 나도 직전 상태로 되돌린다.
 *   서버는 여러 워크스페이스를 한 프로세스에서 처리하므로 await를 사이에 두면 안 된다(fn은 동기 함수).
 *
 * 순수 모듈 — React · DOM 의존 없음(서버가 그대로 import한다).
 */
import { z } from 'zod';
import type { MediaId, Severity } from '@/core/types';
import {
  AD_PILOT, ANOMALY_THRESHOLDS, DATA_TIMETABLE, GFA_DELEGATION, MEDIA, MEDIA_IDS, REVIEW_RULES, RFP, SKU_EXPANSION, SLA, TF_ROLES,
} from './constants';
import { KR_HOLIDAYS } from '@/core/util';
import { DEFAULT_CONFIG as ADPILOT_DEFAULTS } from '@/modules/adpilot/engine';
import { MODULE_ASSUMPTIONS } from '@/modules/adpilot/data';
import { BOARD_RULES } from '@/modules/board/data';
import { LAB_DEFAULT_CRITERIA } from '@/modules/lab/data';
import { ON_DUTY_POOL as ALERT_DUTY_POOL } from '@/modules/alert/data';
import { ON_DUTY_POOL as OPS_DUTY_POOL } from '@/modules/ops/data';
import { PROPOSAL_SHARES as GROWTH_PLAN_SHARES } from '@/modules/growth/engine';

// zod 4의 JIT 감지(new Function)는 앱 CSP(script-src 'self')에서 위반 보고를 남긴다 — 결과는 같으므로 JIT를 끈다
z.config({ jitless: true });

/* ============================== 식별자 ============================== */

export const MEDIA_ID_LIST = ['naver_sa', 'naver_gfa', 'google', 'meta', 'kakao', 'vertical'] as const satisfies readonly MediaId[];
export const SEVERITY_LIST = ['P1', 'P2', 'P3'] as const satisfies readonly Severity[];
export const ANOMALY_METRICS = ['cost', 'clicks', 'conversions', 'cpa', 'roas'] as const;
export type AnomalyMetric = (typeof ANOMALY_METRICS)[number];
/** DATA_TIMETABLE 순서와 1:1 (p.18) — 키로 덮어쓴다 */
export const TIMETABLE_KEYS = ['collect', 'daily_report', 'issue_brief', 'morning_check', 'budget_check', 'next_plan', 'day_close'] as const;
export type TimetableKey = (typeof TIMETABLE_KEYS)[number];
export const TF_ROLE_IDS = ['pm', 'sa_lead', 'sa_ae', 'da_ae', 'global_ae', 'analyst', 'dev'] as const;
export type TfRoleId = (typeof TF_ROLE_IDS)[number];
/** src/modules/registry.ts MODULES의 id (테스트로 같은지 확인) — 사용 모듈 설정 검증용. 레지스트리는 React를 쓰므로 여기서 import하지 않는다 */
export const KNOWN_MODULE_IDS = [
  'home', 'agent', 'board', 'adpilot', 'reports', 'watch', 'lab', 'geo', 'growth', 'flow', 'alert', 'ops',
  'impact', 'connections', 'notify', 'team', 'audit', 'workspace',
] as const;
/** 메뉴에서 끌 수 없는 모듈 (src/saas/sync.ts visibleModuleIds — 커맨드 센터는 항상, 워크스페이스 설정은 설정 권한자에게 항상) */
export const ALWAYS_ON_MODULES = ['home', 'workspace'] as const;
/** server/src/ai/service.ts DEFAULT_MONTHLY_TOKEN_LIMIT과 같은 값 (서버 테스트로 확인) */
export const DEFAULT_AI_MONTHLY_TOKENS = 30_000_000;
/** 월 구독료 기준 (성과 증명 회수 배수 계산의 분모 · 계약 시 확정) */
export const DEFAULT_MONTHLY_FEE = 5_000_000;
/** 성과 증명 추정 입력 — src/modules/impact/engine.ts DEFAULT_MARGIN · DEFAULT_HOURLY_COST와 같은 값 (테스트로 확인) */
export const DEFAULT_CONTRIBUTION_MARGIN = 0.4;
export const DEFAULT_HOURLY_COST = 40_000;
/**
 * 소유자(owner 권한)만 바꿀 수 있는 설정 묶음 — 월 구독료는 계약 금액이자 성과 증명 회수 배수의 분모라서,
 * 설정 권한(PM · 관리자)이 바꾸면 회수 배수가 부풀려질 수 있다. 서버 PUT이 403으로 막고 화면은 읽기 전용으로 보여 준다.
 */
export const OWNER_ONLY_SECTIONS = ['billing'] as const;
export const isOwnerOnlyPath = (path: string): boolean => OWNER_ONLY_SECTIONS.some((s) => path === s || path.startsWith(`${s}.`));

/* ============================== 원래 값 스냅샷 ============================== */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ORIGINAL = structuredClone({
  rfpBrand: RFP.brand as string,
  rfpAnnual: RFP.annualBudget as number,
  competitors: [...RFP.competitors] as string[],
  adPilot: { ...AD_PILOT } as Mutable<typeof AD_PILOT>,
  adpilotDefaults: { ...ADPILOT_DEFAULTS },
  moduleAssumptions: { ...MODULE_ASSUMPTIONS } as Mutable<typeof MODULE_ASSUMPTIONS>,
  boardRules: { ...BOARD_RULES } as Mutable<typeof BOARD_RULES>,
  labCriteria: { ...LAB_DEFAULT_CRITERIA },
  media: Object.fromEntries(MEDIA_IDS.map((id) => [id, { share: MEDIA[id].share, annualBudget: MEDIA[id].annualBudget }])) as Record<MediaId, { share: number; annualBudget: number }>,
  /** 매출 성장 엔진이 모듈 로드 시 MEDIA 비중을 복사해 둔 배분 가안 (src/modules/growth/engine.ts PROPOSAL_SHARES) */
  growthShares: { ...GROWTH_PLAN_SHARES } as Record<MediaId, number>,
  delegation: GFA_DELEGATION.map((g) => ({ ...g })),
  timetable: DATA_TIMETABLE.map((t) => t.time as string),
  sla: Object.fromEntries(SEVERITY_LIST.map((s) => [s, { ...SLA[s], label: { ...SLA[s].label } }])) as unknown as typeof SLA,
  thresholds: ANOMALY_THRESHOLDS.map((t) => ({ metric: t.metric, warnPct: t.warnPct, dangerPct: t.dangerPct })),
  holidays: { ...KR_HOLIDAYS },
  sku: { problems: [...SKU_EXPANSION.problems], situations: [...SKU_EXPANSION.situations], criteria: [...SKU_EXPANSION.criteria] } as Record<'problems' | 'situations' | 'criteria', string[]>,
  alertPool: [...ALERT_DUTY_POOL] as string[],
  opsPool: [...OPS_DUTY_POOL] as string[],
  tfBackups: Object.fromEntries(TF_ROLES.map((r) => [r.id, r.backup])) as Record<string, string>,
  competitorRule: (REVIEW_RULES.find((r) => r.id === 'competitor')?.pattern ?? '') as string,
});

/* ============================== 기본값 ============================== */

export interface EffectiveConfig {
  brand: { name: string; competitors: string[]; productLine: string };
  /** 브랜드명 외 추가 브랜드 키워드 (수집 시 브랜드 키워드 판정 — server/src/ingest/pipeline.ts brandTerms가 brand_name과 함께 쓴다) */
  brandKeywords: string[];
  budget: { annual: number; allocation: Record<MediaId, number> };
  targets: { roas: number; brandRoas: number; cpa: number | null; highEfficiencyRatio: number };
  safety: { dailyChangeCapPct: number; minConversionsForDown: number; lostShareTrigger: number; anomalyHoldPct: number; bulkWarnCount: number; bulkBlockCount: number };
  delegation: { aeMaxPct: number; pmMaxPct: number };
  timetable: Record<TimetableKey, string>;
  sla: Record<Severity, { ackMin: number; actionMin: number | null; reportMin: number | null }>;
  anomalyThresholds: Record<AnomalyMetric, { warnPct: number; dangerPct: number }>;
  holidays: { extra: Record<string, string>; exclude: string[] };
  sku: { problems: string[]; situations: string[]; criteria: string[] };
  onDuty: { pool: TfRoleId[] };
  tf: { backups: Record<TfRoleId, TfRoleId> };
  /**
   * 주말 · 공휴일 당번 체계 강제 (평일 포함 — 연휴 전후 · 임시 휴무 · 비상 운영). 켜면 서버 24시간 감지가 새 이슈를
   * 당번 순번으로 배정하고 전 등급 인지 30분(p.48) 규칙을 쓴다. server/src/alerts/scan.ts가 최상위 cfg.offHoursMode로 읽는다.
   */
  offHoursMode: boolean;
  /** null = 모든 모듈 */
  modules: string[] | null;
  ai: { monthlyTokenLimit: number; enabled: boolean };
  billing: { monthlyFee: number };
  /** 성과 증명 회수 배수 입력 (impact 도메인 impactConfig) */
  impact: { contributionMargin: number; hourlyCost: number };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const thresholdOf = (m: AnomalyMetric) => {
  const t = ORIGINAL.thresholds.find((x) => x.metric === m);
  return { warnPct: t?.warnPct ?? 30, dangerPct: t?.dangerPct ?? 50 };
};

/** 기본값 — 현재 constants.ts (수면밀도 · 제안서 v3) */
export const DEFAULT_CONFIG: EffectiveConfig = deepFreeze({
  brand: { name: ORIGINAL.rfpBrand, competitors: [...ORIGINAL.competitors], productLine: '매트리스' },
  brandKeywords: [],
  budget: {
    annual: ORIGINAL.rfpAnnual,
    allocation: Object.fromEntries(MEDIA_ID_LIST.map((id) => [id, ORIGINAL.media[id].share])) as Record<MediaId, number>,
  },
  targets: { roas: ORIGINAL.adPilot.targetRoas, brandRoas: ORIGINAL.adPilot.brandTargetRoas, cpa: null, highEfficiencyRatio: ORIGINAL.adPilot.highEfficiencyRoasRatio },
  safety: {
    dailyChangeCapPct: ORIGINAL.adPilot.dailyChangeCapPct,
    minConversionsForDown: ORIGINAL.adPilot.minConversionsForDown,
    lostShareTrigger: ORIGINAL.adPilot.lostShareTrigger,
    anomalyHoldPct: ORIGINAL.adPilot.anomalyHoldPct,
    bulkWarnCount: ORIGINAL.adpilotDefaults.bulkWarnCount,
    bulkBlockCount: ORIGINAL.adpilotDefaults.bulkBlockCount,
  },
  delegation: { aeMaxPct: ORIGINAL.delegation[0].maxPct, pmMaxPct: ORIGINAL.delegation[1].maxPct },
  timetable: Object.fromEntries(TIMETABLE_KEYS.map((k, i) => [k, ORIGINAL.timetable[i]])) as Record<TimetableKey, string>,
  sla: Object.fromEntries(SEVERITY_LIST.map((s) => [s, { ackMin: ORIGINAL.sla[s].ackMin, actionMin: ORIGINAL.sla[s].actionMin, reportMin: ORIGINAL.sla[s].reportMin }])) as EffectiveConfig['sla'],
  anomalyThresholds: Object.fromEntries(ANOMALY_METRICS.map((m) => [m, thresholdOf(m)])) as EffectiveConfig['anomalyThresholds'],
  holidays: { extra: {}, exclude: [] },
  sku: { problems: [...ORIGINAL.sku.problems], situations: [...ORIGINAL.sku.situations], criteria: [...ORIGINAL.sku.criteria] },
  onDuty: { pool: [...ORIGINAL.alertPool] as TfRoleId[] },
  tf: { backups: { ...ORIGINAL.tfBackups } as Record<TfRoleId, TfRoleId> },
  offHoursMode: false,
  modules: null,
  ai: { monthlyTokenLimit: DEFAULT_AI_MONTHLY_TOKENS, enabled: true },
  billing: { monthlyFee: DEFAULT_MONTHLY_FEE },
  impact: { contributionMargin: DEFAULT_CONTRIBUTION_MARGIN, hourlyCost: DEFAULT_HOURLY_COST },
});

/* ============================== 숫자 항목 메타 (스키마 · 화면 공용) ============================== */

export interface NumberFieldMeta {
  path: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  int?: boolean;
  /** 출처 · 근거 (장표 · 모듈 가정) */
  source: string;
  hint?: string;
}

const NUM: NumberFieldMeta[] = [
  { path: 'budget.annual', label: '연 광고 예산', unit: '원', min: 1_000_000, max: 1_000_000_000_000, step: 100_000_000, int: true, source: 'RFP · 약 50억', hint: 'VAT · 수수료 별도. 매체별 연 예산 = 연 예산 × 배분 비중' },
  { path: 'targets.roas', label: '목표 ROAS', unit: '%', min: 50, max: 5000, step: 10, int: true, source: 'p.14 · 온보딩 중 확정' },
  { path: 'targets.brandRoas', label: '브랜드 목표 ROAS', unit: '%', min: 50, max: 10000, step: 50, int: true, source: 'p.14 브랜드 별도 기준' },
  { path: 'targets.cpa', label: '목표 CPA', unit: '원', min: 100, max: 100_000_000, step: 1000, int: true, source: '선택 · 제안서 수치 없음', hint: '비워 두면 CPA 목표 없음. 지금은 MILDO Agent 설정 요약에 기준으로만 표기하고, 입찰 · 감지 · 리포트 판정은 ROAS 기준이라 이 값을 쓰지 않습니다' },
  { path: 'targets.highEfficiencyRatio', label: '고효율 기준 (목표 대비 배수)', unit: '배', min: 1, max: 5, step: 0.05, source: 'p.14 · 130%' },
  { path: 'safety.dailyChangeCapPct', label: '일 조정 폭 상한', unit: '%', min: 1, max: 100, step: 1, source: 'p.14 SAFETY · 사전 합의' },
  { path: 'safety.minConversionsForDown', label: '입찰 하향 전 최소 전환', unit: '건', min: 0, max: 100, step: 1, int: true, source: 'p.14' },
  { path: 'safety.lostShareTrigger', label: '노출 기회 손실 기준', unit: '비율', min: 0.01, max: 0.95, step: 0.01, source: 'p.14 · 25%' },
  { path: 'safety.anomalyHoldPct', label: '성과 급변 보류 기준', unit: '±%', min: 5, max: 500, step: 5, source: 'p.14 · p.44' },
  { path: 'safety.bulkWarnCount', label: '대량 변경 경고', unit: '건 이상', min: 1, max: 100, step: 1, int: true, source: 'p.45 · 모듈 가정' },
  { path: 'safety.bulkBlockCount', label: '대량 변경 차단', unit: '건 이상', min: 2, max: 200, step: 1, int: true, source: 'p.45 · 모듈 가정' },
  { path: 'delegation.aeMaxPct', label: '담당 AE 위임 (일 예산 변경 폭)', unit: '±% 이내', min: 1, max: 100, step: 1, source: 'p.15 GFA_DELEGATION · 예시, 계약 시 확정' },
  { path: 'delegation.pmMaxPct', label: 'PM 승인 상한 (초과는 광고주 승인)', unit: '±% 이내', min: 2, max: 1000, step: 1, source: 'p.15 GFA_DELEGATION · 예시, 계약 시 확정' },
  { path: 'ai.monthlyTokenLimit', label: 'AI 월 사용 한도', unit: '토큰', min: 0, max: 10_000_000_000, step: 1_000_000, int: true, source: 'MILDO OS Cloud · 기본 3,000만', hint: '입력 + 출력 토큰 합계 · KST 월 기준. 한도에 닿으면 화면은 규칙 엔진으로 동작합니다' },
  { path: 'billing.monthlyFee', label: '월 구독료 (회수 배수 분모)', unit: '원', min: 1, max: 10_000_000_000, step: 100_000, int: true, source: '계약 시 확정', hint: '성과 증명 화면의 구독료 대비 회수 배수 계산에 씁니다. 회수 배수의 분모라 소유자만 바꿀 수 있습니다' },
  { path: 'impact.contributionMargin', label: '공헌이익률 (광고비 차감 전)', unit: '비율', min: 0.01, max: 1, step: 0.01, source: '성과 증명 추정 가정 · 광고주 확인 필요', hint: '증분 매출 → 증분 이익 환산 비율 (0.4 = 40%)' },
  { path: 'impact.hourlyCost', label: '시간당 인건비', unit: '원', min: 0, max: 10_000_000, step: 1000, int: true, source: '성과 증명 추정 가정', hint: '업무 절감 시간 → 금액 환산' },
];
for (const s of SEVERITY_LIST) {
  NUM.push(
    { path: `sla.${s}.ackMin`, label: `${s} 인지`, unit: '분', min: 1, max: 10080, step: 1, int: true, source: 'p.49' },
    { path: `sla.${s}.actionMin`, label: `${s} 1차 조치`, unit: '분', min: 1, max: 10080, step: 5, int: true, source: 'p.49', hint: '비우면 협의' },
    { path: `sla.${s}.reportMin`, label: `${s} 결과 보고`, unit: '분', min: 1, max: 43200, step: 5, int: true, source: 'p.49', hint: '비우면 당일 · 주간 보고(기본 문구)' },
  );
}
for (const m of ANOMALY_METRICS) {
  NUM.push(
    { path: `anomalyThresholds.${m}.warnPct`, label: '주의', unit: '%', min: 1, max: 500, step: 1, int: true, source: 'p.47 초기값' },
    { path: `anomalyThresholds.${m}.dangerPct`, label: '위험', unit: '%', min: 2, max: 1000, step: 1, int: true, source: 'p.47 초기값' },
  );
}
export const NUMBER_FIELDS: Readonly<Record<string, NumberFieldMeta>> = Object.fromEntries(NUM.map((f) => [f.path, f]));

/* ============================== 스키마 ============================== */

const n = (path: string) => {
  const f = NUMBER_FIELDS[path];
  if (!f) throw new Error(`숫자 항목 메타 없음: ${path}`);
  const base = f.int ? z.number().int() : z.number();
  return base.min(f.min).max(f.max);
};
const text = (max: number) => z.string().trim().min(1).max(max);
const uniqueList = <T extends z.ZodType>(item: T, min: number, max: number) =>
  z.array(item).min(min).max(max).refine((a) => new Set(a.map((x) => (typeof x === 'string' ? x.trim() : JSON.stringify(x)))).size === a.length, { message: '같은 값이 두 번 들어 있습니다' });
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'HH:MM 형식(00:00~23:59)이어야 합니다' });
const isRealDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const DATE = z.string().refine(isRealDate, { message: 'YYYY-MM-DD 형식의 실제 날짜여야 합니다' });
const MediaEnum = z.enum(MEDIA_ID_LIST);
const TfEnum = z.enum(TF_ROLE_IDS);
const opt = <T extends z.ZodType>(s: T) => s.optional();

const slaRow = (s: Severity) => z.strictObject({
  ackMin: opt(n(`sla.${s}.ackMin`)),
  actionMin: opt(n(`sla.${s}.actionMin`).nullable()),
  reportMin: opt(n(`sla.${s}.reportMin`).nullable()),
});
const thresholdRow = (m: AnomalyMetric) => z.strictObject({
  warnPct: opt(n(`anomalyThresholds.${m}.warnPct`)),
  dangerPct: opt(n(`anomalyThresholds.${m}.dangerPct`)),
});

export const WorkspaceConfigSchema = z.strictObject({
  brand: opt(z.strictObject({
    name: opt(text(40)),
    competitors: opt(uniqueList(text(30), 1, 10)),
    productLine: opt(text(40)),
  })),
  brandKeywords: opt(uniqueList(text(40), 0, 30)),
  budget: opt(z.strictObject({
    annual: opt(n('budget.annual')),
    allocation: opt(z.partialRecord(MediaEnum, z.number().min(0).max(1))),
  })),
  targets: opt(z.strictObject({
    roas: opt(n('targets.roas')),
    brandRoas: opt(n('targets.brandRoas')),
    cpa: opt(n('targets.cpa').nullable()),
    highEfficiencyRatio: opt(n('targets.highEfficiencyRatio')),
  })),
  safety: opt(z.strictObject({
    dailyChangeCapPct: opt(n('safety.dailyChangeCapPct')),
    minConversionsForDown: opt(n('safety.minConversionsForDown')),
    lostShareTrigger: opt(n('safety.lostShareTrigger')),
    anomalyHoldPct: opt(n('safety.anomalyHoldPct')),
    bulkWarnCount: opt(n('safety.bulkWarnCount')),
    bulkBlockCount: opt(n('safety.bulkBlockCount')),
  })),
  delegation: opt(z.strictObject({
    aeMaxPct: opt(n('delegation.aeMaxPct')),
    pmMaxPct: opt(n('delegation.pmMaxPct')),
  })),
  timetable: opt(z.strictObject(Object.fromEntries(TIMETABLE_KEYS.map((k) => [k, opt(HHMM)])) as Record<TimetableKey, z.ZodOptional<typeof HHMM>>)),
  sla: opt(z.strictObject({ P1: opt(slaRow('P1')), P2: opt(slaRow('P2')), P3: opt(slaRow('P3')) })),
  anomalyThresholds: opt(z.strictObject(Object.fromEntries(ANOMALY_METRICS.map((m) => [m, opt(thresholdRow(m))])) as Record<AnomalyMetric, z.ZodOptional<ReturnType<typeof thresholdRow>>>)),
  holidays: opt(z.strictObject({
    extra: opt(z.record(DATE, text(30)).refine((r) => Object.keys(r).length <= 100, { message: '추가 공휴일은 100개까지입니다' })),
    exclude: opt(uniqueList(DATE.refine((d) => d in ORIGINAL.holidays, { message: '기본 공휴일 목록에 없는 날짜입니다' }), 0, 50)),
  })),
  sku: opt(z.strictObject({
    problems: opt(uniqueList(text(30), 1, 8)),
    situations: opt(uniqueList(text(30), 1, 8)),
    criteria: opt(uniqueList(text(30), 1, 8)),
  })),
  onDuty: opt(z.strictObject({ pool: opt(uniqueList(TfEnum, 1, TF_ROLE_IDS.length)) })),
  tf: opt(z.strictObject({ backups: opt(z.partialRecord(TfEnum, TfEnum)) })),
  offHoursMode: opt(z.boolean()),
  modules: opt(uniqueList(z.enum(KNOWN_MODULE_IDS), 0, KNOWN_MODULE_IDS.length).nullable()),
  ai: opt(z.strictObject({ monthlyTokenLimit: opt(n('ai.monthlyTokenLimit')), enabled: opt(z.boolean()) })),
  billing: opt(z.strictObject({ monthlyFee: opt(n('billing.monthlyFee')) })),
  impact: opt(z.strictObject({ contributionMargin: opt(n('impact.contributionMargin')), hourlyCost: opt(n('impact.hourlyCost')) })),
});

/** 저장 형식: 바꾼 항목만 (모든 필드 선택) */
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export const CONFIG_SECTIONS = Object.keys(WorkspaceConfigSchema.shape) as (keyof WorkspaceConfig)[];

export interface ConfigIssue { path: string; message: string }

/* ============================== 오류 문구 (한국어) ============================== */

const fmtNum = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? Number(v).toLocaleString('ko-KR') : String(v));
const koError: z.core.$ZodErrorMap = (iss) => {
  switch (iss.code) {
    case 'invalid_type': {
      const exp = iss.expected;
      if (exp === 'int') return '정수를 입력해 주세요';
      if (exp === 'number') return '숫자를 입력해 주세요';
      if (exp === 'string') return '글자를 입력해 주세요';
      if (exp === 'array') return '목록 형식이어야 합니다';
      if (exp === 'object') return '항목 묶음 형식이어야 합니다';
      if (exp === 'boolean') return '켜기 · 끄기 값이어야 합니다';
      return '형식이 맞지 않습니다';
    }
    case 'too_small':
      if (iss.origin === 'string') return `${fmtNum(iss.minimum)}자 이상 입력해 주세요`;
      if (iss.origin === 'array' || iss.origin === 'set') return `${fmtNum(iss.minimum)}개 이상이어야 합니다`;
      return `${fmtNum(iss.minimum)} 이상이어야 합니다`;
    case 'too_big':
      if (iss.origin === 'string') return `${fmtNum(iss.maximum)}자 이하로 입력해 주세요`;
      if (iss.origin === 'array' || iss.origin === 'set') return `${fmtNum(iss.maximum)}개까지 넣을 수 있습니다`;
      return `${fmtNum(iss.maximum)} 이하여야 합니다`;
    case 'invalid_format': return '형식이 맞지 않습니다';
    case 'invalid_value': return `허용 값이 아닙니다 (${(iss.values ?? []).map(String).slice(0, 8).join(' · ')}${(iss.values?.length ?? 0) > 8 ? ' …' : ''})`;
    case 'invalid_key': return '알 수 없는 항목입니다';
    case 'unrecognized_keys': return '알 수 없는 항목입니다';
    case 'not_multiple_of': return '단위가 맞지 않습니다';
    default: return '값을 확인해 주세요';
  }
};

/* ============================== 병합 ============================== */

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

function mergeInto(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (isPlain(v) && isPlain(base[k])) base[k] = mergeInto(base[k] as Record<string, unknown>, v);
    else base[k] = clone(v);
  }
  return base;
}

/** 기본값 + 덮어쓰기 → 전체 설정 (객체는 깊게 합치고, 배열 · 값 · null은 통째로 바꾼다) */
export function mergeConfig(defaults: EffectiveConfig, overrides: WorkspaceConfig | null | undefined): EffectiveConfig {
  const base = clone(defaults) as unknown as Record<string, unknown>;
  if (!overrides) return base as unknown as EffectiveConfig;
  return mergeInto(base, overrides as Record<string, unknown>) as unknown as EffectiveConfig;
}

/* ============================== 교차 검증 (병합 결과 기준) ============================== */

interface CrossIssue extends ConfigIssue { drop: string[] }

const sumOf = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + v, 0);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function crossCheck(eff: EffectiveConfig, over: WorkspaceConfig): CrossIssue[] {
  const out: CrossIssue[] = [];
  const has = (path: string) => getPath(over, path) !== undefined;
  const sum = sumOf(eff.budget.allocation);
  if (Math.abs(sum - 1) > 0.001) {
    out.push({ path: 'budget.allocation', message: `매체 배분 비중 합계가 100%여야 합니다 (현재 ${(Math.round(sum * 1000) / 10).toLocaleString('ko-KR')}%, 허용 ±0.1%p)`, drop: ['budget.allocation'] });
  }
  if (eff.safety.bulkBlockCount <= eff.safety.bulkWarnCount) {
    out.push({ path: has('safety.bulkBlockCount') ? 'safety.bulkBlockCount' : 'safety.bulkWarnCount', message: `대량 변경 차단 기준(${eff.safety.bulkBlockCount}건)은 경고 기준(${eff.safety.bulkWarnCount}건)보다 커야 합니다`, drop: ['safety.bulkBlockCount', 'safety.bulkWarnCount'] });
  }
  if (eff.delegation.pmMaxPct <= eff.delegation.aeMaxPct) {
    out.push({ path: has('delegation.pmMaxPct') ? 'delegation.pmMaxPct' : 'delegation.aeMaxPct', message: `PM 승인 상한(±${eff.delegation.pmMaxPct}%)은 담당 AE 위임(±${eff.delegation.aeMaxPct}%)보다 커야 합니다`, drop: ['delegation.aeMaxPct', 'delegation.pmMaxPct'] });
  }
  const times = TIMETABLE_KEYS.map((k) => minutes(eff.timetable[k]));
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      const k = TIMETABLE_KEYS[i];
      out.push({ path: has(`timetable.${k}`) ? `timetable.${k}` : `timetable.${TIMETABLE_KEYS[i - 1]}`, message: `데이터 시간표는 시간 순서여야 합니다 (${TIMETABLE_LABEL[TIMETABLE_KEYS[i - 1]]} ${eff.timetable[TIMETABLE_KEYS[i - 1]]} → ${TIMETABLE_LABEL[k]} ${eff.timetable[k]})`, drop: ['timetable'] });
      break;
    }
  }
  for (const s of SEVERITY_LIST) {
    const r = eff.sla[s];
    const seq = [r.ackMin, r.actionMin, r.reportMin].filter((x): x is number => typeof x === 'number');
    if (seq.some((v, i) => i > 0 && v < seq[i - 1])) out.push({ path: `sla.${s}`, message: `${s} SLA는 인지 ≤ 1차 조치 ≤ 결과 보고 순서여야 합니다`, drop: [`sla.${s}`] });
  }
  if (!(eff.sla.P1.ackMin <= eff.sla.P2.ackMin && eff.sla.P2.ackMin <= eff.sla.P3.ackMin)) {
    out.push({ path: 'sla', message: `인지 기한은 P1 ≤ P2 ≤ P3이어야 합니다 (현재 ${eff.sla.P1.ackMin} · ${eff.sla.P2.ackMin} · ${eff.sla.P3.ackMin}분)`, drop: SEVERITY_LIST.filter((s) => has(`sla.${s}.ackMin`)).map((s) => `sla.${s}.ackMin`) });
  }
  for (const m of ANOMALY_METRICS) {
    const t = eff.anomalyThresholds[m];
    if (t.dangerPct <= t.warnPct) out.push({ path: `anomalyThresholds.${m}`, message: `${ANOMALY_LABEL[m]} 위험 기준(${t.dangerPct}%)은 주의 기준(${t.warnPct}%)보다 커야 합니다`, drop: [`anomalyThresholds.${m}`] });
  }
  for (const [role, backup] of Object.entries(eff.tf.backups)) {
    if (role === backup) out.push({ path: `tf.backups.${role}`, message: `${TF_LABEL[role as TfRoleId] ?? role}의 백업은 본인이 될 수 없습니다`, drop: [`tf.backups.${role}`] });
  }
  return out;
}

/* ============================== 경로 헬퍼 ============================== */

const splitPath = (p: string | readonly PropertyKey[]): string[] => (typeof p === 'string' ? (p ? p.split('.') : []) : p.map(String));

export function getPath(o: unknown, path: string | readonly PropertyKey[]): unknown {
  let cur: unknown = o;
  for (const k of splitPath(path)) {
    if (!isPlain(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** 경로의 값을 지운다(빈 부모 묶음도 정리). 배열 안 경로는 배열 전체를 지운다 */
function deletePath(o: Record<string, unknown>, path: readonly PropertyKey[]): void {
  const segs: string[] = [];
  for (const k of path) {
    if (typeof k === 'number') break;
    segs.push(String(k));
  }
  if (!segs.length) {
    for (const k of Object.keys(o)) delete o[k];
    return;
  }
  const parents: Record<string, unknown>[] = [o];
  let cur: unknown = o;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = (cur as Record<string, unknown>)[segs[i]];
    if (!isPlain(cur)) return;
    parents.push(cur);
  }
  const last = parents[parents.length - 1];
  if (Array.isArray(last)) return;
  delete last[segs[segs.length - 1]];
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]).length) break;
    delete parents[i - 1][segs[i - 1]];
  }
}

/** undefined · 빈 묶음 제거 (null · 빈 배열은 의미가 있어 남긴다) */
function prune<T>(v: T): T {
  if (!isPlain(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    const p = prune(x);
    if (isPlain(p) && !Object.keys(p).length) continue;
    out[k] = p;
  }
  return out as T;
}

/** 덮어쓴 항목(잎) 경로 목록 — 객체는 펼치고 배열 · 값 · null은 잎 */
export function leafPaths(o: unknown, prefix = ''): string[] {
  if (!isPlain(o)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v) && Object.keys(v).length) out.push(...leafPaths(v, p));
    else if (!isPlain(v)) out.push(p);
  }
  return out;
}

/** 불변 갱신: 경로에 값을 넣은 새 덮어쓰기 */
export function setOverride(over: WorkspaceConfig, path: string, value: unknown): WorkspaceConfig {
  const root = clone(over ?? {}) as Record<string, unknown>;
  const segs = splitPath(path);
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!isPlain(cur[segs[i]])) cur[segs[i]] = {};
    cur = cur[segs[i]] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = clone(value);
  return root as WorkspaceConfig;
}

/** 불변 갱신: 경로의 덮어쓰기를 지운다 (기본값으로) */
export function removeOverride(over: WorkspaceConfig, path: string): WorkspaceConfig {
  const root = clone(over ?? {}) as Record<string, unknown>;
  deletePath(root, splitPath(path));
  return root as WorkspaceConfig;
}

export const isEmptyConfig = (c: unknown) => !isPlain(c) || leafPaths(c).length === 0;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ConfigChange { path: string; before: unknown; after: unknown }

/** 전체 설정 두 개의 잎 단위 차이 (경로 순서는 스키마 순서) */
export function diffConfig(before: EffectiveConfig | WorkspaceConfig, after: EffectiveConfig | WorkspaceConfig): ConfigChange[] {
  const paths = new Set([...leafPaths(before), ...leafPaths(after)]);
  const out: ConfigChange[] = [];
  for (const p of paths) {
    const a = getPath(before, p);
    const b = getPath(after, p);
    if (!same(a, b)) out.push({ path: p, before: a === undefined ? null : clone(a), after: b === undefined ? null : clone(b) });
  }
  return out;
}

export interface ConfigChangeRow extends ConfigChange { label: string; beforeSource: 'default' | 'override'; afterSource: 'default' | 'override' }

/** 덮어쓴 경로 목록이 path를 포함(같거나 상위 · 하위)하는지 */
const covers = (overridden: string[], path: string) => overridden.some((p) => p === path || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));

/**
 * 덮어쓰기 두 개 → 사람이 읽는 변경 목록 (저장 전 미리보기 · 감사 기록 공용).
 * 값 차이(기본값 병합 기준) + 값은 같지만 출처만 바뀐 항목(기본값과 같은 값을 명시 저장 · 해제)을 담는다.
 */
export function overrideChanges(beforeCfg: WorkspaceConfig, afterCfg: WorkspaceConfig, defaults: EffectiveConfig = DEFAULT_CONFIG): ConfigChangeRow[] {
  const b = mergeConfig(defaults, beforeCfg);
  const a = mergeConfig(defaults, afterCfg);
  const bo = leafPaths(beforeCfg);
  const ao = leafPaths(afterCfg);
  const rows: ConfigChangeRow[] = diffConfig(b, a).map((d) => ({
    ...d, label: configFieldLabel(d.path),
    beforeSource: covers(bo, d.path) ? 'override' : 'default',
    afterSource: covers(ao, d.path) ? 'override' : 'default',
  }));
  for (const p of new Set([...bo, ...ao])) {
    if (rows.some((r) => r.path === p || p.startsWith(`${r.path}.`) || r.path.startsWith(`${p}.`))) continue;
    const inB = bo.includes(p);
    const inA = ao.includes(p);
    if (inB === inA) continue;
    const v = getPath(a, p);
    rows.push({ path: p, label: configFieldLabel(p), before: v ?? null, after: v ?? null, beforeSource: inB ? 'override' : 'default', afterSource: inA ? 'override' : 'default' });
  }
  return rows;
}

/** 스키마에 있는 최상위 항목만 (다른 도메인이 쓴 스키마 밖 키는 적용 · 검증 대상이 아니다) */
export function pickKnownSections(cfg: unknown): Record<string, unknown> {
  if (!isPlain(cfg)) return {};
  const known = new Set<string>(CONFIG_SECTIONS as string[]);
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => known.has(k)));
}

/* ============================== 파싱 ============================== */

/**
 * 덮어쓰기 검증. 결과 config에는 통과한 항목만 남고(잘못된 항목은 빠진다), errors에 항목별 사유가 담긴다.
 *   저장(PUT): errors가 있으면 거부 · 읽기(loadWorkspaceConfig · applyWorkspaceConfig): config만 쓰고 errors는 경고로 남긴다.
 */
export function parseWorkspaceConfig(input: unknown, defaults: EffectiveConfig = DEFAULT_CONFIG): { config: WorkspaceConfig; errors: ConfigIssue[] } {
  const errors: ConfigIssue[] = [];
  const seen = new Set<string>();
  const add = (path: string, message: string) => {
    const key = `${path}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({ path, message });
  };
  if (input === null || input === undefined) return { config: {}, errors };
  if (!isPlain(input)) {
    add('', '설정은 항목 묶음(객체) 형식이어야 합니다');
    return { config: {}, errors };
  }
  let work = clone(input) as Record<string, unknown>;
  for (let round = 0; round < 12; round++) {
    const r = WorkspaceConfigSchema.safeParse(work, { error: koError });
    if (r.success) {
      const data = prune(r.data) as WorkspaceConfig;
      const cross = crossCheck(mergeConfig(defaults, data), data);
      if (!cross.length) return { config: data, errors };
      for (const c of cross) {
        add(c.path, c.message);
        for (const d of c.drop) deletePath(work, splitPath(d));
      }
      continue;
    }
    for (const iss of r.error.issues) {
      if (iss.code === 'unrecognized_keys') {
        for (const k of iss.keys) {
          add([...iss.path, k].map(String).join('.'), '알 수 없는 항목입니다');
          deletePath(work, [...iss.path, k]);
        }
        continue;
      }
      const cut: string[] = [];
      for (const k of iss.path) { if (typeof k === 'number') break; cut.push(String(k)); }
      add(cut.join('.'), iss.message);
      deletePath(work, iss.path);
    }
    work = prune(work);
  }
  return { config: {}, errors: errors.length ? errors : [{ path: '', message: '설정을 해석하지 못했습니다' }] };
}

/** 저장된 덮어쓰기(검증 전 가능) → 전체 설정 */
export function effectiveConfig(overrides: unknown): EffectiveConfig {
  return mergeConfig(DEFAULT_CONFIG, parseWorkspaceConfig(overrides).config);
}

/* ============================== 표시 문구 ============================== */

export const TIMETABLE_LABEL: Record<TimetableKey, string> = Object.fromEntries(
  TIMETABLE_KEYS.map((k, i) => [k, DATA_TIMETABLE[i]?.title ?? k]),
) as Record<TimetableKey, string>;
export const ANOMALY_LABEL: Record<AnomalyMetric, string> = Object.fromEntries(
  ANOMALY_METRICS.map((m) => [m, ANOMALY_THRESHOLDS.find((t) => t.metric === m)?.label ?? m]),
) as Record<AnomalyMetric, string>;
export const TF_LABEL: Record<TfRoleId, string> = Object.fromEntries(TF_ROLES.map((r) => [r.id, r.role])) as Record<TfRoleId, string>;
export const MEDIA_LABEL: Record<MediaId, string> = Object.fromEntries(MEDIA_ID_LIST.map((id) => [id, MEDIA[id].name])) as Record<MediaId, string>;

const SECTION_LABEL: Record<string, string> = {
  brand: '브랜드', brandKeywords: '브랜드 키워드', budget: '예산', targets: '목표', safety: 'SAFETY', delegation: '위임 범위', timetable: '데이터 시간표', sla: 'SLA',
  anomalyThresholds: '이상 징후 기준', holidays: '공휴일', sku: 'SKU 진입점', onDuty: '당번', tf: 'TF 백업', offHoursMode: '당번 체계 강제', modules: '사용 모듈', ai: 'AI', billing: '구독', impact: '성과 증명',
};
const FIXED_LABEL: Record<string, string> = {
  'brand.name': '브랜드명', 'brand.competitors': '경쟁사', 'brand.productLine': '제품군', brandKeywords: '브랜드 키워드',
  'budget.allocation': '매체 배분', 'holidays.extra': '추가 공휴일', 'holidays.exclude': '공휴일 제외(근무일)',
  'sku.problems': 'SKU 진입점 · 고객의 문제', 'sku.situations': 'SKU 진입점 · 구매 상황', 'sku.criteria': 'SKU 진입점 · 비교 기준',
  'onDuty.pool': '주말 · 공휴일 당번 순번', offHoursMode: '주말 · 공휴일 당번 체계 강제 (평일 포함)', modules: '사용 모듈', 'ai.enabled': 'AI 사용',
};

/** 설정 경로 → 사람이 읽는 이름 (화면 · 감사 이력 · 에이전트 공용) */
export function configFieldLabel(path: string): string {
  if (FIXED_LABEL[path]) return FIXED_LABEL[path];
  const num = NUMBER_FIELDS[path];
  const segs = path.split('.');
  if (segs[0] === 'anomalyThresholds' && segs.length === 3) return `이상 징후 ${ANOMALY_LABEL[segs[1] as AnomalyMetric] ?? segs[1]} ${num?.label ?? segs[2]}`;
  if (num) return num.label;
  if (segs[0] === 'budget' && segs[1] === 'allocation' && segs[2]) return `${MEDIA_LABEL[segs[2] as MediaId] ?? segs[2]} 배분 비중`;
  if (segs[0] === 'timetable' && segs[1]) return `시간표 · ${TIMETABLE_LABEL[segs[1] as TimetableKey] ?? segs[1]}`;
  if (segs[0] === 'holidays' && segs[1] === 'extra' && segs[2]) return `추가 공휴일 ${segs[2]}`;
  if (segs[0] === 'tf' && segs[1] === 'backups' && segs[2]) return `${TF_LABEL[segs[2] as TfRoleId] ?? segs[2]} 백업`;
  if (segs.length === 1 && SECTION_LABEL[path]) return SECTION_LABEL[path];
  return segs.map((s, i) => (i === 0 ? SECTION_LABEL[s] ?? s : s)).join(' · ');
}

/** 분 → '15분' · '2시간' · '1일' (SLA 표기) */
export function minutesLabel(min: number): string {
  if (!Number.isFinite(min)) return '—';
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440}일`;
  if (min >= 60 && min % 60 === 0) return `${min / 60}시간`;
  if (min > 60) return `${Math.floor(min / 60)}시간 ${min % 60}분`;
  return `${min}분`;
}

/** 위임 범위 문장 (GFA_DELEGATION range) — 기본값이면 원문과 같다 */
export function delegationRanges(aeMaxPct: number, pmMaxPct: number): [string, string, string] {
  return [`일 예산 ±${aeMaxPct}% 이내 · 상태 점검`, `일 예산 ±${aeMaxPct}~${pmMaxPct}% · 광고그룹 ON/OFF`, `${pmMaxPct}% 초과 · 신규 캠페인`];
}

const UNIT_SUFFIX: Record<string, string> = { '원': '원', '토큰': '토큰', '건': '건', '건 이상': '건', '분': '분', '%': '%', '±%': '%', '±% 이내': '%', '배': '배' };

/** 화면 · 감사 표시용 값 문구 */
export function formatConfigValue(path: string, v: unknown): string {
  if (v === null || v === undefined) {
    if (path.startsWith('sla.')) return '협의 · 기본 문구';
    if (path === 'modules') return '모든 모듈';
    if (path === 'targets.cpa') return '없음';
    return '—';
  }
  if (Array.isArray(v)) return v.length ? v.map((x) => (path === 'onDuty.pool' ? TF_LABEL[x as TfRoleId] ?? String(x) : String(x))).join(', ') : '없음';
  if (typeof v === 'boolean') return v ? '켜짐' : '꺼짐';
  if (typeof v === 'number') {
    if (path.startsWith('budget.allocation')) return `${(Math.round(v * 1000) / 10).toLocaleString('ko-KR')}%`;
    if (path === 'safety.lostShareTrigger' || path === 'impact.contributionMargin') return `${Math.round(v * 100)}%`;
    if (path.startsWith('sla.')) return minutesLabel(v);
    const unit = NUMBER_FIELDS[path]?.unit ?? '';
    return `${v.toLocaleString('ko-KR')}${UNIT_SUFFIX[unit] ?? ''}`;
  }
  if (isPlain(v)) return Object.entries(v).map(([k, x]) => `${k} ${formatConfigValue(`${path}.${k}`, x)}`).join(' · ');
  return String(v);
}

/* ============================== 런타임 적용 ============================== */

const resolvedCache = new WeakMap<object, EffectiveConfig>();
let applied: EffectiveConfig | null = null;
let appliedInput: unknown = null;

function resolveForApply(cfg: unknown): EffectiveConfig | null {
  if (cfg === null || cfg === undefined) return null;
  if (typeof cfg === 'object') {
    const hit = resolvedCache.get(cfg);
    if (hit) return hit;
  }
  const { config, errors } = parseWorkspaceConfig(pickKnownSections(cfg));
  if (errors.length) {
    console.warn(`[MILDO OS] 워크스페이스 설정 중 ${errors.length}개 항목을 무시하고 기본값을 씁니다: ${errors.map((e) => `${e.path || '(전체)'} ${e.message}`).join(' · ')}`);
  }
  const eff = isEmptyConfig(config) ? null : mergeConfig(DEFAULT_CONFIG, config);
  if (eff && typeof cfg === 'object') resolvedCache.set(cfg, eff);
  return eff;
}

const w = <T>(o: T) => o as unknown as Record<string, unknown>;
const replaceArray = (arr: readonly unknown[], next: readonly unknown[]) => {
  (arr as unknown[]).splice(0, arr.length, ...next);
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function restoreOriginal(): void {
  Object.assign(w(RFP), { brand: ORIGINAL.rfpBrand, annualBudget: ORIGINAL.rfpAnnual });
  replaceArray(RFP.competitors, ORIGINAL.competitors);
  Object.assign(w(AD_PILOT), ORIGINAL.adPilot);
  Object.assign(ADPILOT_DEFAULTS, ORIGINAL.adpilotDefaults);
  Object.assign(w(MODULE_ASSUMPTIONS), ORIGINAL.moduleAssumptions);
  Object.assign(w(BOARD_RULES), ORIGINAL.boardRules);
  Object.assign(LAB_DEFAULT_CRITERIA, ORIGINAL.labCriteria);
  for (const id of MEDIA_IDS) Object.assign(MEDIA[id], ORIGINAL.media[id]);
  Object.assign(GROWTH_PLAN_SHARES, ORIGINAL.growthShares);
  GFA_DELEGATION.forEach((g, i) => Object.assign(g, ORIGINAL.delegation[i]));
  DATA_TIMETABLE.forEach((t, i) => { w(t).time = ORIGINAL.timetable[i]; });
  for (const s of SEVERITY_LIST) Object.assign(SLA[s], { ...ORIGINAL.sla[s], label: { ...ORIGINAL.sla[s].label } });
  for (const t of ANOMALY_THRESHOLDS) {
    const o = ORIGINAL.thresholds.find((x) => x.metric === t.metric);
    if (o) Object.assign(t, { warnPct: o.warnPct, dangerPct: o.dangerPct });
  }
  for (const k of Object.keys(KR_HOLIDAYS)) if (!(k in ORIGINAL.holidays)) delete KR_HOLIDAYS[k];
  Object.assign(KR_HOLIDAYS, ORIGINAL.holidays);
  replaceArray(SKU_EXPANSION.problems, ORIGINAL.sku.problems);
  replaceArray(SKU_EXPANSION.situations, ORIGINAL.sku.situations);
  replaceArray(SKU_EXPANSION.criteria, ORIGINAL.sku.criteria);
  replaceArray(ALERT_DUTY_POOL, ORIGINAL.alertPool);
  replaceArray(OPS_DUTY_POOL, ORIGINAL.opsPool);
  for (const r of TF_ROLES) w(r).backup = ORIGINAL.tfBackups[r.id];
  const rule = REVIEW_RULES.find((r) => r.id === 'competitor');
  if (rule) w(rule).pattern = ORIGINAL.competitorRule;
}

function writeEffective(e: EffectiveConfig): void {
  const D = DEFAULT_CONFIG;
  // 브랜드 · 경쟁사 (경쟁사명 검수 규칙도 같은 목록으로)
  w(RFP).brand = e.brand.name;
  if (!same(e.brand.competitors, D.brand.competitors)) {
    replaceArray(RFP.competitors, e.brand.competitors);
    const rule = REVIEW_RULES.find((r) => r.id === 'competitor');
    if (rule) w(rule).pattern = `(${e.brand.competitors.map(escapeRe).join('|')})`;
  }
  // 예산 · 매체 배분 (매체 연 예산 = 연 예산 × 비중)
  w(RFP).annualBudget = e.budget.annual;
  for (const id of MEDIA_ID_LIST) {
    const share = e.budget.allocation[id];
    if (share === D.budget.allocation[id] && e.budget.annual === D.budget.annual) continue;
    Object.assign(MEDIA[id], { share, annualBudget: Math.round(e.budget.annual * share) });
  }
  // 매출 성장 배분 탭 · 균등화안의 기준(가안) = 워크스페이스 매체 배분
  for (const id of MEDIA_ID_LIST) GROWTH_PLAN_SHARES[id] = e.budget.allocation[id];
  // 목표 · SAFETY → AD_PILOT + 엔진 기본값(모듈 로드 시 복사본)
  const ap = {
    targetRoas: e.targets.roas, brandTargetRoas: e.targets.brandRoas, highEfficiencyRoasRatio: e.targets.highEfficiencyRatio,
    dailyChangeCapPct: e.safety.dailyChangeCapPct, minConversionsForDown: e.safety.minConversionsForDown,
    lostShareTrigger: e.safety.lostShareTrigger, anomalyHoldPct: e.safety.anomalyHoldPct,
  };
  Object.assign(w(AD_PILOT), ap);
  Object.assign(ADPILOT_DEFAULTS, ap, { bulkWarnCount: e.safety.bulkWarnCount, bulkBlockCount: e.safety.bulkBlockCount });
  Object.assign(w(MODULE_ASSUMPTIONS), { bulkWarnCount: e.safety.bulkWarnCount, bulkBlockCount: e.safety.bulkBlockCount });
  LAB_DEFAULT_CRITERIA.targetRoas = e.targets.roas;
  const th = e.anomalyThresholds;
  Object.assign(w(BOARD_RULES), {
    roasDropWarnPct: th.roas.warnPct, roasDropDangerPct: th.roas.dangerPct,
    cpaRiseWarnPct: th.cpa.warnPct, cpaRiseDangerPct: th.cpa.dangerPct,
    costSwingWarnPct: th.cost.warnPct, costSwingDangerPct: th.cost.dangerPct,
    targetRoas: e.targets.roas, brandTargetRoas: e.targets.brandRoas, highEfficiencyRatio: e.targets.highEfficiencyRatio,
    lostShareTrigger: e.safety.lostShareTrigger, minConversionsForVerdict: e.safety.minConversionsForDown, keywordAnomalyPct: e.safety.anomalyHoldPct,
  });
  // 이상 징후 기준
  for (const t of ANOMALY_THRESHOLDS) {
    const v = th[t.metric as AnomalyMetric];
    if (v) Object.assign(t, { warnPct: v.warnPct, dangerPct: v.dangerPct });
  }
  // 위임 범위
  if (e.delegation.aeMaxPct !== D.delegation.aeMaxPct || e.delegation.pmMaxPct !== D.delegation.pmMaxPct) {
    const ranges = delegationRanges(e.delegation.aeMaxPct, e.delegation.pmMaxPct);
    Object.assign(GFA_DELEGATION[0], { maxPct: e.delegation.aeMaxPct, range: ranges[0] });
    Object.assign(GFA_DELEGATION[1], { maxPct: e.delegation.pmMaxPct, range: ranges[1] });
    Object.assign(GFA_DELEGATION[2], { range: ranges[2] });
  }
  // 데이터 시간표
  TIMETABLE_KEYS.forEach((k, i) => { if (DATA_TIMETABLE[i]) w(DATA_TIMETABLE[i]).time = e.timetable[k]; });
  // SLA (바뀐 값만 표기 문구를 다시 만든다)
  for (const s of SEVERITY_LIST) {
    const o = ORIGINAL.sla[s];
    const v = e.sla[s];
    const lab = (cur: number | null, orig: number | null, origLabel: string) => (cur === orig ? origLabel : cur === null ? '협의' : minutesLabel(cur));
    Object.assign(SLA[s], {
      ackMin: v.ackMin, actionMin: v.actionMin, reportMin: v.reportMin,
      label: { ack: lab(v.ackMin, o.ackMin, o.label.ack), action: lab(v.actionMin, o.actionMin, o.label.action), report: lab(v.reportMin, o.reportMin, o.label.report) },
    });
  }
  // 공휴일
  for (const d of e.holidays.exclude) delete KR_HOLIDAYS[d];
  for (const [d, label] of Object.entries(e.holidays.extra)) KR_HOLIDAYS[d] = label;
  // SKU 진입점 · 당번 · TF 백업
  replaceArray(SKU_EXPANSION.problems, e.sku.problems);
  replaceArray(SKU_EXPANSION.situations, e.sku.situations);
  replaceArray(SKU_EXPANSION.criteria, e.sku.criteria);
  replaceArray(ALERT_DUTY_POOL, e.onDuty.pool);
  replaceArray(OPS_DUTY_POOL, e.onDuty.pool);
  for (const r of TF_ROLES) {
    const b = e.tf.backups[r.id as TfRoleId];
    if (b) w(r).backup = b;
  }
}

/**
 * 워크스페이스 설정을 constants의 내보낸 객체에 제자리 적용한다. null · undefined · {}이면 원래 값으로 되돌린다.
 * 잘못된 항목은 무시하고(콘솔 경고) 나머지만 적용한다.
 */
export function applyWorkspaceConfig(cfg: WorkspaceConfig | Record<string, unknown> | null | undefined): void {
  const eff = resolveForApply(cfg);
  restoreOriginal();
  if (eff) writeEffective(eff);
  applied = eff;
  appliedInput = eff ? cfg : null;
}

/** 지금 적용된 전체 설정 (적용 전이면 기본값) */
export function activeWorkspaceConfig(): EffectiveConfig {
  return applied ?? DEFAULT_CONFIG;
}

/** cfg를 적용한 상태로 fn을 실행하고 직전 상태로 되돌린다 (fn은 동기 함수여야 한다 — 예외가 나도 되돌린다) */
export function withWorkspaceConfig<T>(cfg: WorkspaceConfig | Record<string, unknown> | null | undefined, fn: () => T): T {
  const prev = appliedInput as WorkspaceConfig | null;
  applyWorkspaceConfig(cfg);
  try {
    const out = fn();
    if (out && typeof (out as { then?: unknown }).then === 'function') {
      console.warn('[MILDO OS] withWorkspaceConfig의 fn은 동기 함수여야 합니다 — 비동기 구간에서는 설정이 이미 되돌려져 있습니다');
    }
    return out;
  } finally {
    applyWorkspaceConfig(prev);
  }
}
