/**
 * 리포트 생성 · 보관 — 화면과 같은 순수 빌더(src/modules/reports/engine.ts)를 서버 Dataset으로 돌려 reports 테이블에 저장한다.
 *
 *  일간 · 주간 · 월간 · 이슈: buildDataset → withWorkspaceConfig(설정) 안에서 generateReport(이슈 · 변경 요청 · Lab 판정 기준 포함)
 *     → 섹션 코멘트(comments.target = reports:<scope>:<섹션>) · AE 해석(reports:<scope>:ae) · 규칙 엔진 해석을 붙여 reportToMarkdown
 *  가치(value): 성과 증명 장부 지난달 요약 (server/src/impact/service.ts)
 *
 * 데이터 출처 표기: 엔진 문구는 TEST DATA 기준으로 쓰여 있으므로, Dataset.meta.mode가 live · mixed면 표기를 실제 출처로 바꾼다(relabel).
 * 예약 생성은 dedupe_key(daily:<날짜> · weekly:<주 시작> · monthly:<월> · value:<월> · issue:<이슈 id>)로 같은 대상 리포트를 한 번만 만든다.
 */
import type { Dataset } from '@/core/types';
import { withWorkspaceConfig } from '@/data/config';
import { briefToMarkdown } from '@/ai/prompts';
import { generateReport as engineReport, isClientAuthor, reportToMarkdown, scopeOf, type IssueLike, type Report, type ReportType } from '@/modules/reports/engine';
import type { Queryable } from '../db/pool';
import { one } from '../db/pool';
import { addDaysStr, kstHour, kstToday, nowMs } from '../lib/time';
import { notFound } from '../lib/errors';
import { loadWorkspaceConfig } from '../settings/service';
import { engineChanges } from '../changes/model';
import { listIncidents, getIncident } from '../alerts/incidents';
import { valueReportFor } from '../impact/service';
import { deps } from './deps';
import { weeklyPeriodFor } from './schedule';

export type ServerReportType = ReportType | 'value';
export const SERVER_REPORT_TYPES: readonly ServerReportType[] = ['daily', 'weekly', 'monthly', 'issue', 'value'];
export type ReportTrigger = 'schedule' | 'incident' | 'manual';
export type DataMode = 'demo' | 'live' | 'mixed';

export interface DeliveryRecord {
  channelId: string | null;
  channelType: 'slack' | 'email' | 'webhook' | null;
  channelName: string;
  /** notify.send = alerts 잡 큐 (재시도 · 서명 · SSRF 차단), direct = 바로 발송 (메일 전문 · 큐 없는 환경) */
  via: 'notify.send' | 'direct' | 'none';
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  jobId?: number | null;
  target?: string;
  reason?: string | null;
  at: string;
  by: string;
}

export interface ReportRow {
  id: string;
  workspace_id: string;
  type: ServerReportType;
  period_start: string | null;
  period_end: string | null;
  generated_at: Date;
  title: string;
  markdown: string;
  messenger: string | null;
  ae_comment: string | null;
  delivered: DeliveryRecord[];
  status: 'generated' | 'delivered' | 'failed';
  doc: Record<string, unknown> | null;
  scope: string | null;
  trigger: ReportTrigger;
  dedupe_key: string | null;
  ref_id: string | null;
  data_mode: DataMode | null;
  data_as_of: string | null;
  delivered_at: Date | null;
}

export interface ReportDto {
  id: string;
  type: ServerReportType;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string;
  status: ReportRow['status'];
  trigger: ReportTrigger;
  scope: string | null;
  refId: string | null;
  dataMode: DataMode | null;
  dataAsOf: string | null;
  messenger: string | null;
  aeComment: string | null;
  delivered: DeliveryRecord[];
  deliveredAt: string | null;
  excerpt: string;
  markdown?: string;
  doc?: Record<string, unknown> | null;
}

export function toDto(r: ReportRow, full = false): ReportDto {
  const dto: ReportDto = {
    id: r.id, type: r.type, title: r.title, periodStart: r.period_start, periodEnd: r.period_end, generatedAt: new Date(r.generated_at).toISOString(),
    status: r.status, trigger: r.trigger, scope: r.scope, refId: r.ref_id, dataMode: r.data_mode, dataAsOf: r.data_as_of,
    messenger: r.messenger, aeComment: r.ae_comment, delivered: Array.isArray(r.delivered) ? r.delivered : [], deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
    excerpt: (r.messenger ?? r.markdown).split('\n').find((l) => l.trim()) ?? '',
  };
  if (full) { dto.markdown = r.markdown; dto.doc = r.doc; }
  return dto;
}

export const REPORT_COLS = 'id, workspace_id, type, period_start, period_end, generated_at, title, markdown, messenger, ae_comment, delivered, status, doc, scope, trigger, dedupe_key, ref_id, data_mode, data_as_of, delivered_at';

/* ============================== 데이터 출처 표기 ============================== */

const DEMO_HEADER = '> 데이터: TEST DATA (시연용 테스트 데이터 · 실제 성과 아님) · 제안서 기준값은 장표 번호 병기';

/** 엔진 문구의 TEST DATA 표기를 실제 출처로 — demo는 그대로, live는 LIVE DATA, mixed는 '일부 TEST DATA' */
export function relabel(text: string, mode: DataMode, asOf?: string | null): string {
  if (mode === 'demo' || !text) return text;
  if (mode === 'live') {
    return text
      .replace(DEMO_HEADER, `> 데이터: LIVE DATA (연동 출처${asOf ? ` · 데이터 기준 ${asOf}` : ''}) · 제안서 기준값은 장표 번호 병기`)
      .replace(/TEST DATA 기반 탐지/g, '연동 데이터 기반 탐지')
      .replace(/ \(TEST DATA\)/g, '')
      .replace(/\(TEST DATA · /g, '(')
      .replace(/\(TEST DATA\)/g, '')
      .replace(/수치는 시연용 TEST DATA임을 전제한다/g, '수치는 연동 데이터 기준이다')
      .replace(/TEST DATA/g, 'LIVE DATA');
  }
  return text
    .replace(DEMO_HEADER, `> 데이터: 일부 TEST DATA 포함 (매체 · 채널별 출처는 데이터 연결 화면에서 확인${asOf ? ` · 데이터 기준 ${asOf}` : ''}) · 제안서 기준값은 장표 번호 병기`)
    .replace(/(?<!일부 )TEST DATA/g, '일부 TEST DATA');
}

/* ============================== 기간 계산 ============================== */

export interface GenerateInput {
  type: ServerReportType;
  /** 일간: 성과 날짜 · 주간: 대상 주 시작(월) · 월간 · 가치: 그 달의 아무 날짜 */
  periodStart?: string;
  month?: string;
  incidentId?: string;
  trigger: ReportTrigger;
  /** 예약 생성 중복 방지 — 없으면 매번 새로 만든다(화면에서 생성) */
  dedupe?: boolean;
  userId?: string | null;
  actor: string;
}

export interface Plan { today: string; hour: number; days: number; periodStart: string | null; periodEnd: string | null; month?: string; dedupeKey: string | null }

const lastDayOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const prevMonthOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** 리포트 종류 · 입력 → Dataset 기준일 · 시각 · 대상 기간 · 중복 방지 키 (미래 기간은 오늘 기준으로 당긴다) */
export function planFor(input: Pick<GenerateInput, 'type' | 'periodStart' | 'month' | 'incidentId' | 'dedupe'>, now: { today: string; hour: number }): Plan {
  const { today, hour } = now;
  const yesterday = addDaysStr(today, -1);
  const key = (k: string) => (input.dedupe ? k : null);
  const hourFor = (d: string, sendHour: number) => (d === today ? hour : sendHour);
  switch (input.type) {
    case 'daily': {
      const p = input.periodStart && input.periodStart <= yesterday ? input.periodStart : yesterday;
      const t = addDaysStr(p, 1);
      return { today: t, hour: hourFor(t, 8), days: 120, periodStart: p, periodEnd: p, dedupeKey: key(`daily:${p}`) };
    }
    case 'weekly': {
      if (input.periodStart) {
        const start = input.periodStart;
        const end = addDaysStr(start, 6);
        if (end <= yesterday) {
          const t = addDaysStr(start, 7);
          return { today: t, hour: hourFor(t, 10), days: 120, periodStart: start, periodEnd: end, dedupeKey: key(`weekly:${start}`) };
        }
      }
      // 최근 7일 (어제까지) — 화면 미리보기와 같은 기간
      const start = addDaysStr(today, -7);
      return { today, hour, days: 120, periodStart: start, periodEnd: yesterday, dedupeKey: key(`weekly:${start}`) };
    }
    case 'monthly':
    case 'value': {
      let month = input.month ?? (input.periodStart ? input.periodStart.slice(0, 7) : input.type === 'value' ? prevMonthOf(today.slice(0, 7)) : yesterday.slice(0, 7));
      if (month > yesterday.slice(0, 7)) month = yesterday.slice(0, 7);
      const last = lastDayOf(month);
      // 월간: 마감된 달은 다음 날(익월 1일) 기준으로 만들어 월 전체가 확정 · 진행 중인 달은 오늘 기준 잠정
      const t = last < yesterday ? addDaysStr(last, 1) : today;
      const days = Math.min(400, Math.max(120, daysBetween(`${prevMonthOf(month)}-01`, t) + 2));
      return { today: t, hour: t === today ? hour : 10, days, periodStart: `${month}-01`, periodEnd: last < yesterday ? last : yesterday, month, dedupeKey: key(`${input.type}:${month}`) };
    }
    case 'issue':
      return { today, hour, days: 60, periodStart: today, periodEnd: today, dedupeKey: input.incidentId ? key(`issue:${input.incidentId}`) : null };
  }
}
export { weeklyPeriodFor };

/* ============================== 생성 ============================== */

interface CommentLite { id: string; target: string; author: string; author_role: string | null; text: string; at: Date; resolved: boolean }

const kstStamp = (ms: number) => {
  const s = new Date(ms + 9 * 3600_000).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
};

async function labCriteria(q: Queryable, wsId: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await one<{ value: { criteria?: Record<string, unknown> } | null }>(q, `SELECT value FROM workspace_state WHERE workspace_id = $1 AND key = 'mildo-os/lab/v1'`, [wsId]);
    const c = r?.value?.criteria;
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

export interface Built {
  title: string;
  markdown: string;
  messenger: string;
  aeComment: string | null;
  doc: Record<string, unknown>;
  scope: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  refId: string | null;
  dataMode: DataMode;
  dataAsOf: string | null;
}

/** 리포트 본문 만들기 (저장하지 않음) */
export async function buildReport(q: Queryable, wsId: string, input: GenerateInput, appUrl: string, now = { today: kstToday(), hour: kstHour() }): Promise<{ plan: Plan; built: Built }> {
  const plan = planFor(input, now);
  if (input.type === 'value') {
    const v = await valueReportFor(q, wsId, plan.month!, appUrl);
    return {
      plan,
      built: {
        title: v.doc.title, markdown: v.doc.markdown, messenger: v.doc.messenger, aeComment: null,
        doc: { kind: 'value', ...v.doc, summary: v.summary }, scope: `value-${plan.month}`, periodStart: v.doc.periodStart, periodEnd: v.doc.periodEnd, refId: null,
        dataMode: v.dataMode, dataAsOf: v.summary.generatedAt,
      },
    };
  }
  const ds: Dataset = await deps.buildDataset(q, wsId, { today: plan.today, hour: plan.hour, days: plan.days });
  const mode: DataMode = ds.meta?.mode ?? 'demo';
  const [cfg, changes, incidentsAll, crit] = await Promise.all([loadWorkspaceConfig(q, wsId), engineChanges(q, wsId), listIncidents(q, wsId), labCriteria(q, wsId)]);
  let incidents = incidentsAll as unknown as IssueLike[];
  if (input.type === 'issue' && input.incidentId) {
    let sel = incidents.find((i) => i.id === input.incidentId);
    if (!sel) {
      const one1 = await getIncident(q, wsId, input.incidentId);
      if (!one1) throw notFound('이슈를 찾을 수 없습니다');
      sel = one1 as unknown as IssueLike;
      incidents = [sel, ...incidents];
    }
  }
  const report: Report = withWorkspaceConfig(cfg, () => engineReport(input.type as ReportType, ds, {
    incidents, month: plan.month, selectedIssueId: input.incidentId ?? null, changes, labCriteria: crit as never,
  }));
  const scope = scopeOf(report);
  const prefix = `reports:${scope}:`;
  const comments = (await q.query<CommentLite>(
    `SELECT id, target, author, author_role, text, at, resolved FROM comments WHERE workspace_id = $1 AND starts_with(target, $2) ORDER BY at ASC, id ASC LIMIT 500`,
    [wsId, prefix],
  )).rows;
  const aeT = `${prefix}ae`;
  const aeNotes = comments.filter((c) => c.target === aeT);
  const feedback = comments.filter((c) => c.target !== aeT);
  const sectionTitle = (t: string) => report.sections.find((s) => `${prefix}${s.id}` === t)?.title ?? t.slice(prefix.length);
  const ruleText = briefToMarkdown({ ...report.brief, facts: [], patterns: [] });
  const markdown0 = withWorkspaceConfig(cfg, () => reportToMarkdown(report, {
    interpretation: ruleText.trim() ? { text: ruleText, by: 'rule' } : null,
    aeNotes: aeNotes.map((n) => ({ author: n.author, text: n.text, at: kstStamp(new Date(n.at).getTime()) })),
    feedback: feedback.map((f) => {
      const client = f.author_role === 'client' || isClientAuthor(f.author);
      return { sectionTitle: sectionTitle(f.target), author: client && !isClientAuthor(f.author) ? `${f.author} (광고주 담당자)` : f.author, text: f.text, resolved: f.resolved, client };
    }),
  }));
  const asOf = ds.generatedAt ?? null;
  const doc = JSON.parse(relabel(JSON.stringify({ kind: 'report', ...report }), mode, asOf)) as Record<string, unknown>;
  return {
    plan,
    built: {
      title: relabel(report.title, mode), markdown: relabel(markdown0, mode, asOf), messenger: relabel(report.messenger, mode), doc, scope,
      aeComment: aeNotes.length ? aeNotes.slice(-3).map((n) => `${n.author}: ${n.text}`).join('\n').slice(0, 4000) : null,
      periodStart: report.from ?? plan.periodStart, periodEnd: report.to ?? plan.periodEnd,
      refId: input.type === 'issue' ? (scope.startsWith('issue-') ? scope.slice(6) : input.incidentId ?? null) : null,
      dataMode: mode, dataAsOf: asOf,
    },
  };
}

/** 만들고 저장 — 예약 생성은 같은 대상이 이미 있으면 기존 행을 돌려준다(created: false) */
export async function generateAndStore(q: Queryable, wsId: string, input: GenerateInput, appUrl: string): Promise<{ row: ReportRow; created: boolean }> {
  const pre = planFor(input, { today: kstToday(), hour: kstHour() });
  if (pre.dedupeKey) {
    const ex = await one<ReportRow>(q, `SELECT ${REPORT_COLS} FROM reports WHERE workspace_id = $1 AND dedupe_key = $2`, [wsId, pre.dedupeKey]);
    if (ex) return { row: ex, created: false };
  }
  const { plan, built } = await buildReport(q, wsId, input, appUrl);
  const ins = await one<ReportRow>(
    q,
    `INSERT INTO reports (workspace_id, type, period_start, period_end, generated_at, title, markdown, messenger, ae_comment, delivered, status, doc, scope, trigger, dedupe_key, ref_id, data_mode, data_as_of, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]'::jsonb, 'generated', $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING ${REPORT_COLS}`,
    [wsId, input.type, built.periodStart, built.periodEnd, new Date(nowMs()).toISOString(), built.title.slice(0, 300), built.markdown, built.messenger, built.aeComment,
      JSON.stringify(built.doc), built.scope, input.trigger, plan.dedupeKey, built.refId, built.dataMode, built.dataAsOf, input.userId ?? null],
  );
  if (ins) return { row: ins, created: true };
  const ex = await one<ReportRow>(q, `SELECT ${REPORT_COLS} FROM reports WHERE workspace_id = $1 AND dedupe_key = $2`, [wsId, plan.dedupeKey]);
  return { row: ex!, created: false };
}

export async function getReport(q: Queryable, wsId: string, id: string): Promise<ReportRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<ReportRow>(q, `SELECT ${REPORT_COLS} FROM reports WHERE workspace_id = $1 AND id = $2`, [wsId, id]);
}
