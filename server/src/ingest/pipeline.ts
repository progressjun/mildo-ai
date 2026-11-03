/**
 * 수집 파이프라인 — 커넥터 fetch → 정제 · 품질 검사 → 웨어하우스 멱등 upsert → ingest_runs 기록.
 * 커넥터는 DB에 쓰지 않는다(§3). 여기서만 wh_*에 쓴다.
 *
 *   daily     : 매체(media · 기타)는 어제 포함 3일(어제 · 그제 · 사흘 전) — 늦게 잡히는 전환 반영,
 *               판매 채널(def.kind === 'sales')은 어제 포함 14일 — 늦게 들어오는 취소 · 반품을 결제일 매출에서 빼기 위해 (dailyRangeFor)
 *   intraday  : 오늘 시간대 + 캠페인 오늘 소진액 (capabilities.intraday인 커넥터만)
 *   backfill  : 지정 기간을 31일 단위로 나눠 수집 (capabilities.maxBackfillDays · 400일 상한).
 *               묶음마다 · 끝의 intraday 전에 커넥션 행을 다시 읽는다 — 앞 묶음이 OAuth 토큰을 회전(ctx.saveCredentials)시켰으면 새 자격증명으로 이어 간다
 *   upload    : CSV 업로드 (출처 'csv:<업로드 id>')
 * 성공하면 alerts.scan을 enqueue(dedupe alerts.scan:<ws>)하고 'dataset' · 'connection' 이벤트를 발행한다.
 *
 * 동시성: 웨어하우스 쓰기 트랜잭션은 먼저 커넥션 행(업로드는 업로드 행)을 잠근다(FOR NO KEY UPDATE).
 *  - 같은 커넥션의 수집(예약 daily · 수동 daily · 백필)이 겹쳐도 쓰기는 하나씩 — 엔티티 스냅샷 교체가 섞이지 않는다
 *  - 삭제(DELETE 라우트도 같은 행을 먼저 잠근다)와 겹치면 둘 중 하나가 기다린다. 이미 삭제됐으면 쓰지 않고 끝낸다(고아 행 방지 · 재시도 없음)
 */
import type { Db, Queryable } from '../db/pool';
import { one } from '../db/pool';
import type { AppConfig } from '../config';
import type { ConnectorDef, ConnectorHttp, DateRange, NormalizedBatch } from '../connectors/types';
import { getConnector } from '../connectors/registry';
import { buildConnectorContext, credentialIssueText, loadConnection, MAX_BACKFILL_DAYS, sourceKeyOf, type ConnectionRow } from '../connectors/service';
import { scrubSecrets, type FetchLike } from '../connectors/http';
import { needsOAuthApproval, oauthApprovalMessage } from '../connectors/credentials';
import { blockingIssues, csvToBatch, normalizeCsv, type NormalizeResult, type UploadTemplate } from '../connectors/csv';
import type { CsvIssue } from '@/modules/connections/csv';
import { writeBatch } from '../warehouse/write';
import { checkBatch, hasErrors, historyRange, type CheckResult, type HistoryRow, type QualityIssue } from './quality';
import { enqueue } from '../jobs/queue';
import { publish } from '../events/hub';
import { addDaysStr, kstParts, nowMs } from '../lib/time';

export type IngestJob = 'daily' | 'intraday' | 'backfill' | 'upload';
export const BACKFILL_CHUNK_DAYS = 31;

export interface IngestRunResult {
  runId: string;
  status: 'succeeded' | 'partial' | 'failed';
  rowsIn: number;
  rowsWritten: number;
  issues: QualityIssue[];
  error?: string;
  range: DateRange;
  /** 쓰기 직전에 커넥션 · 업로드가 삭제됨 (취소) */
  gone?: boolean;
}

export interface IngestOptions {
  job: IngestJob;
  range: DateRange;
  intradayDate?: string;
  trigger?: string;
  /** false면 이벤트 · alerts.scan을 이 실행에서 보내지 않는다 (백필 묶음 실행 — 마지막에 한 번) */
  notify?: boolean;
  http?: ConnectorHttp;
  fetchImpl?: FetchLike;
  log?: (msg: string, extra?: unknown) => void;
}

/** 수집 성공 후 공통 후처리: 이상 감지 예약 + 화면 갱신 이벤트 */
export async function afterIngest(q: Queryable, wsId: string, connectionId?: string | null): Promise<void> {
  await enqueue(q, { type: 'alerts.scan', workspaceId: wsId, payload: { reason: 'ingest', connectionId: connectionId ?? null }, dedupeKey: `alerts.scan:${wsId}` });
  await publish(q, wsId, { type: 'dataset' });
  if (connectionId) await publish(q, wsId, { type: 'connection', id: connectionId });
}

/** 기간을 n일 묶음으로 (오래된 쪽부터) */
export function chunkRange(range: DateRange, size = BACKFILL_CHUNK_DAYS): DateRange[] {
  const out: DateRange[] = [];
  for (let from = range.from; from <= range.to; from = addDaysStr(from, size)) {
    const to = addDaysStr(from, size - 1);
    out.push({ from, to: to > range.to ? range.to : to });
  }
  return out;
}

/** 예약 · 수동 daily 재수집 일수: 매체 3일(늦은 전환), 판매 채널 14일(늦은 취소 · 반품) */
export const DAILY_RECOLLECT_DAYS = { media: 3, sales: 14 } as const;

/** 어제 포함 days일 (기본 3일) */
export function dailyRange(today: string, days: number = DAILY_RECOLLECT_DAYS.media): DateRange {
  return { from: addDaysStr(today, -Math.max(1, Math.round(days))), to: addDaysStr(today, -1) };
}

/** 커넥터 종류별 daily 기간 — 판매 채널 14일, 나머지 3일 */
export function dailyRangeFor(def: Pick<ConnectorDef, 'kind'> | null | undefined, today: string): DateRange {
  return dailyRange(today, def?.kind === 'sales' ? DAILY_RECOLLECT_DAYS.sales : DAILY_RECOLLECT_DAYS.media);
}

async function loadHistory(q: Queryable, wsId: string, source: string, range: DateRange): Promise<HistoryRow[]> {
  const h = historyRange(range);
  return (await q.query<HistoryRow>(
    `SELECT date, media, cost, revenue, conversions FROM wh_media_daily WHERE workspace_id = $1 AND source = $2 AND date BETWEEN $3 AND $4`,
    [wsId, source, h.from, h.to],
  )).rows;
}

const errMsg = (e: unknown) => scrubSecrets((e as Error)?.message ?? String(e)).slice(0, 1000);

/** 쓰기 직전에 커넥션 · 업로드가 지워진 경우 — 실패가 아니라 취소 (재시도하지 않는다) */
export class SourceGoneError extends Error {
  constructor(what: string) {
    super(`${what}이(가) 삭제되어 수집 결과를 쓰지 않았습니다`);
    this.name = 'SourceGoneError';
  }
}
export const GONE_MESSAGE = '커넥션이 삭제되어 수집 결과를 쓰지 않았습니다';

/** 커넥션 하나 · 기간 하나 수집. 실패하면 ingest_runs(failed) · 커넥션 오류 상태를 남기고 예외를 다시 던진다(잡 재시도). */
export async function ingestConnection(db: Db, config: AppConfig, conn: ConnectionRow, o: IngestOptions): Promise<IngestRunResult> {
  const def = getConnector(conn.provider);
  const wsId = conn.workspace_id;
  const source = sourceKeyOf(conn);
  const now = kstParts();
  const run = await one<{ id: string }>(
    db,
    `INSERT INTO ingest_runs (workspace_id, connection_id, job, range_from, range_to, status, source, triggered_by) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7) RETURNING id`,
    [wsId, conn.id, o.job, o.range.from, o.range.to, source, o.trigger ?? 'schedule'],
  );
  const runId = run!.id;
  try {
    if (!def) throw new Error(`알 수 없는 공급자: ${conn.provider}`);
    const ctx = buildConnectorContext(db, config, conn, { dryRun: true, http: o.http, fetchImpl: o.fetchImpl, log: o.log });
    const parsedCreds = def.credentialsSchema.safeParse(ctx.credentials);
    if (!parsedCreds.success) {
      // OAuth 승인 대기(앱 정보만 저장 — 카페24): 토큰 필드 오류 대신 인증 시작 버튼을 안내한다
      if (needsOAuthApproval(def.provider, ctx.credentials)) throw new Error(oauthApprovalMessage(def));
      throw new Error(credentialIssueText(def, parsedCreds.error.issues));
    }
    const raw: NormalizedBatch = await def.fetch({ ...ctx, credentials: parsedCreds.data }, o.range, o.intradayDate ? { intradayDate: o.intradayDate } : undefined);
    const history = o.job === 'intraday' ? [] : await loadHistory(db, wsId, source, o.range);
    const { batch, issues, rowsIn } = checkBatch(raw ?? {}, {
      range: o.range, job: o.job, today: now.date, hour: now.hour, provider: conn.provider, channel: conn.channel, reads: def.capabilities.reads, history,
    });
    const written = await db.tx(async (q) => {
      const alive = await one(q, 'SELECT id FROM connections WHERE id = $1 AND workspace_id = $2 FOR NO KEY UPDATE', [conn.id, wsId]);
      if (!alive) throw new SourceGoneError('커넥션');
      const w = await writeBatch(q, wsId, source, batch, { replaceEntities: o.job === 'daily' || o.job === 'backfill', keywordChannel: conn.channel ?? 'naver_sa' });
      const status = hasErrors(issues) ? 'partial' : 'succeeded';
      await q.query(
        `UPDATE ingest_runs SET status = $2, rows_in = $3, rows_written = $4, issues = $5, stats = $6, finished_at = clock_timestamp() WHERE id = $1`,
        [runId, status, rowsIn, w.total, JSON.stringify(issues), JSON.stringify(w.byTable)],
      );
      await q.query(
        `UPDATE connections SET last_sync_at = $2, last_error = NULL, status = CASE WHEN status IN ('pending', 'error') THEN 'active' ELSE status END, updated_at = now() WHERE id = $1`,
        [conn.id, new Date(nowMs()).toISOString()],
      );
      if (o.notify !== false) await afterIngest(q, wsId, conn.id);
      return { w, status: status as 'succeeded' | 'partial' };
    });
    return { runId, status: written.status, rowsIn, rowsWritten: written.w.total, issues, range: o.range };
  } catch (e) {
    if (e instanceof SourceGoneError) {
      return { runId, status: 'failed', rowsIn: 0, rowsWritten: 0, issues: [], error: GONE_MESSAGE, range: o.range, gone: true };
    }
    const msg = errMsg(e);
    await db.query(`UPDATE ingest_runs SET status = 'failed', error = $2, finished_at = clock_timestamp() WHERE id = $1`, [runId, msg]);
    await db.query(`UPDATE connections SET status = CASE WHEN status = 'disabled' THEN status ELSE 'error' END, last_error = $2, updated_at = now() WHERE id = $1`, [conn.id, msg]);
    await publish(db, wsId, { type: 'connection', id: conn.id });
    const err = new Error(msg) as Error & { runId?: string };
    err.runId = runId;
    throw err;
  }
}

/** 백필: 기간 → 31일 묶음 (오래된 쪽부터). 끝나면 intraday(지원 시)와 후처리를 한 번 */
export async function backfillConnection(db: Db, config: AppConfig, conn: ConnectionRow, range: DateRange, o: Omit<IngestOptions, 'job' | 'range'> = {}): Promise<IngestRunResult[]> {
  const def = getConnector(conn.provider);
  if (!def) throw new Error(`알 수 없는 공급자: ${conn.provider}`);
  const results: IngestRunResult[] = [];
  // 묶음마다 커넥션 행을 다시 읽는다: 앞 묶음이 갱신 토큰을 회전시켜 저장했으면(카페24 · 네이버 등 OAuth) 옛 자격증명(폐기된 토큰)으로 이어 가지 않게
  const fresh = () => loadConnection(db, conn.workspace_id, conn.id);
  for (const r of chunkRange(range)) {
    const cur = await fresh();
    if (!cur) return results; // 삭제됨 — 나머지 묶음 · 후처리 생략
    const res = await ingestConnection(db, config, cur, { ...o, job: 'backfill', range: r, notify: false });
    results.push(res);
    if (res.gone) return results; // 삭제됨 — 나머지 묶음 · 후처리 생략
  }
  const today = kstParts().date;
  if (def.capabilities.intraday && range.to >= addDaysStr(today, -1)) {
    const cur = await fresh();
    if (!cur) return results;
    results.push(await ingestConnection(db, config, cur, { ...o, job: 'intraday', range: { from: today, to: today }, intradayDate: today, notify: false }));
  }
  await afterIngest(db, conn.workspace_id, conn.id);
  return results;
}

/** 백필 기간 계산: days(어제까지 n일) 또는 from/to — 커넥터 maxBackfillDays · 400일 상한 */
export function backfillRange(today: string, maxBackfillDays: number, p: { days?: number; from?: string; to?: string }): DateRange {
  const cap = Math.min(MAX_BACKFILL_DAYS, Math.max(0, maxBackfillDays));
  if (cap <= 0) throw new Error('이 커넥터는 기간 지정 수집(백필)을 지원하지 않습니다');
  const yesterday = addDaysStr(today, -1);
  let to = p.to && p.to < today ? p.to : p.to === today ? today : yesterday;
  let from = p.from ?? addDaysStr(yesterday, -(Math.max(1, Math.min(cap, Math.round(p.days ?? 30))) - 1));
  const earliest = addDaysStr(today, -cap);
  if (from < earliest) from = earliest;
  if (to < from) to = from;
  return { from, to };
}

/* ---------- 업로드 ---------- */

export interface UploadRow {
  id: string;
  workspace_id: string;
  connection_id: string | null;
  template: string;
  filename: string;
  bytes: number;
  mapping: Record<string, string | null>;
  status: 'received' | 'imported' | 'failed';
  summary: Record<string, unknown>;
  content: string | null;
  channel: string | null;
  created_by: string | null;
  created_at: Date | string;
  imported_at: Date | string | null;
}

/**
 * 실데이터 출처(api · 다른 csv) 키워드 문구 → id — CSV 키워드 일별을 기존 키워드에 붙인다.
 * 데모 키워드에는 붙이지 않는다: 실데이터가 들어오면 Dataset 빌더가 그 채널의 데모 엔티티를 빼므로 일별 행이 고아가 된다.
 * 커넥션 출처를 업로드 출처보다 우선한다.
 */
export async function keywordIdByText(q: Queryable, wsId: string): Promise<Map<string, string>> {
  const rows = (await q.query<{ id: string; text: string; source: string }>(
    `SELECT external_id AS id, doc->>'text' AS text, source FROM wh_entities WHERE workspace_id = $1 AND entity_type = 'keyword' AND source <> 'demo'
      ORDER BY CASE WHEN source LIKE 'csv:%' THEN 0 ELSE 1 END, updated_at`, [wsId],
  )).rows;
  const m = new Map<string, string>();
  for (const r of rows) if (r.text) m.set(r.text.replace(/\s+/g, ' ').trim(), r.id); // 뒤(우선순위 높은 출처)가 덮어쓴다
  return m;
}

/** 브랜드 키워드 판정어: 워크스페이스 brand_name + 설정 brand.name(비어 있지 않은 문자열) + 설정 brandKeywords */
export async function brandTerms(q: Queryable, wsId: string): Promise<string[]> {
  const w = await one<{ brand_name: string; config: Record<string, unknown> }>(q, 'SELECT brand_name, config FROM workspaces WHERE id = $1', [wsId]);
  const terms = new Set<string>();
  if (w?.brand_name) terms.add(w.brand_name);
  const name = (w?.config as { brand?: { name?: unknown } } | undefined)?.brand?.name;
  if (typeof name === 'string' && name.trim()) terms.add(name.trim());
  const kw = (w?.config as { brandKeywords?: unknown } | undefined)?.brandKeywords;
  if (Array.isArray(kw)) for (const k of kw) if (typeof k === 'string' && k.trim()) terms.add(k.trim());
  return [...terms];
}

export interface UploadAnalysis {
  norm: NormalizeResult;
  /** 가져오기를 막는 오류 (필수 열 누락 · 가져올 행 없음 등) — 있으면 checked는 null */
  blocking: CsvIssue[];
  /** 수집 품질 검사(checkBatch)까지 마친 쓰기 배치 */
  checked: CheckResult | null;
  range: DateRange;
  /** 정규화 이슈 + 품질 검사 이슈 (미리보기 · 가져오기 · 수집 실행 기록에 같은 목록) */
  issues: QualityIssue[];
}

/** 쓸 수 있는 행 수 (웨어하우스 행 테이블 기준) */
export function batchRowCount(b: NormalizedBatch): number {
  return (['mediaDaily', 'mediaHourly', 'salesDaily', 'keywordDaily', 'searchTermDaily', 'brandSearchDaily'] as const)
    .reduce((n, k) => n + ((b[k] as unknown[] | undefined)?.length ?? 0), 0);
}

/** 쓸 행들의 날짜 범위 (없으면 null) */
export function batchDateRange(b: NormalizedBatch): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const k of ['mediaDaily', 'mediaHourly', 'salesDaily', 'keywordDaily', 'searchTermDaily', 'brandSearchDaily'] as const) {
    for (const r of (b[k] as { date?: string }[] | undefined) ?? []) {
      if (typeof r.date !== 'string') continue;
      if (!from || r.date < from) from = r.date;
      if (!to || r.date > to) to = r.date;
    }
  }
  return from && to ? { from, to } : null;
}

/**
 * 업로드 내용 분석 — 미리보기(dryRun) · 업로드 등록 · 워커 가져오기가 같은 함수를 쓴다:
 * 정규화(형식 · 템플릿 예시 행 · 음수 지표 · 미래 날짜) → NormalizedBatch → 수집 품질 검사(checkBatch).
 * 미리보기가 '통과'라고 한 파일을 워커가 0행으로 끝내지 않게 한다.
 */
export async function analyzeUpload(
  q: Queryable, wsId: string,
  u: { template: UploadTemplate; content: string; mapping?: Record<string, string | null | undefined> | null; channel?: string | null },
  now: { date: string; hour: number } = kstParts(),
): Promise<UploadAnalysis> {
  const norm = normalizeCsv(u.template, u.content, { mapping: u.mapping ?? {}, channel: u.channel ?? null, today: now.date });
  const range = { from: norm.summary.dateFrom ?? now.date, to: norm.summary.dateTo ?? now.date };
  const blocking = blockingIssues(norm.issues);
  if (blocking.length) return { norm, blocking, checked: null, range, issues: norm.issues };
  const batch = csvToBatch(norm, { keywordIdByText: await keywordIdByText(q, wsId), brandTerms: await brandTerms(q, wsId) });
  const checked = checkBatch(batch, { range, job: 'upload', today: now.date, hour: now.hour, provider: 'csv', channel: null });
  const issues: QualityIssue[] = [...norm.issues, ...checked.issues];
  if (!batchRowCount(checked.batch)) {
    const none: QualityIssue = { code: 'no_valid_rows', severity: 'error', message: '가져올 수 있는 행이 없습니다 — 모든 행이 품질 검사에서 제외됩니다 (위 사유를 고친 뒤 다시 올려 주세요)' };
    return { norm, blocking: [none], checked: null, range, issues: [...issues, none] };
  }
  return { norm, blocking: [], checked, range, issues };
}

/** 업로드 가져오기 (잡 ingest.upload). 원본은 가져온 뒤 비운다. */
export async function importUpload(db: Db, uploadId: string, o: { trigger?: string; finalAttempt?: boolean } = {}): Promise<IngestRunResult> {
  const up = await one<UploadRow>(db, 'SELECT * FROM uploads WHERE id = $1', [uploadId]);
  // 지워진 업로드 — 재시도할 일이 아니다
  if (!up) return { runId: '', status: 'failed', rowsIn: 0, rowsWritten: 0, issues: [], error: '업로드를 찾을 수 없습니다 (삭제됨)', range: { from: '', to: '' }, gone: true };
  const wsId = up.workspace_id;
  const source = `csv:${up.id}`;
  const now = kstParts();
  // 이미 가져왔거나 원본이 없으면 재시도할 일이 아니다 — 새 실행 기록 없이 끝낸다
  if (up.status === 'imported' || !up.content) {
    return { runId: '', status: up.status === 'imported' ? 'succeeded' : 'failed', rowsIn: 0, rowsWritten: 0, issues: [], error: up.status === 'imported' ? undefined : '업로드 원본이 없습니다 (이미 처리됐거나 삭제됨)', range: { from: '', to: '' } };
  }
  const run = await one<{ id: string }>(
    db,
    `INSERT INTO ingest_runs (workspace_id, connection_id, upload_id, job, status, source, triggered_by) VALUES ($1, $2, $3, 'upload', 'running', $4, $5) RETURNING id`,
    [wsId, up.connection_id, up.id, source, o.trigger ?? 'upload'],
  );
  const runId = run!.id;
  try {
    const a = await analyzeUpload(db, wsId, { template: up.template as UploadTemplate, content: up.content!, mapping: up.mapping ?? {}, channel: up.channel }, now);
    const { norm, blocking, issues, range } = a;
    if (blocking.length || !a.checked) {
      const why = blocking[0]?.message ?? '가져올 수 있는 행이 없습니다';
      await db.tx(async (q) => {
        await q.query(`UPDATE ingest_runs SET status = 'failed', rows_in = $2, issues = $3, error = $4, finished_at = clock_timestamp() WHERE id = $1`, [runId, norm.summary.rows, JSON.stringify(issues), why]);
        await q.query(`UPDATE uploads SET status = 'failed', summary = $2, content = NULL WHERE id = $1`, [up.id, JSON.stringify({ ...norm.summary, error: why, runId })]);
        await publish(q, wsId, { type: 'connection', id: up.connection_id ?? undefined });
      });
      return { runId, status: 'failed', rowsIn: norm.summary.rows, rowsWritten: 0, issues, error: why, range: { from: norm.summary.dateFrom ?? '', to: norm.summary.dateTo ?? '' } };
    }
    const checked = a.checked;
    const result = await db.tx(async (q) => {
      const alive = await one(q, 'SELECT id FROM uploads WHERE id = $1 AND workspace_id = $2 FOR NO KEY UPDATE', [up.id, wsId]);
      if (!alive) throw new SourceGoneError('업로드');
      const w = await writeBatch(q, wsId, source, checked.batch, { replaceEntities: false });
      const status = issues.some((i) => i.severity === 'error') ? 'partial' : 'succeeded';
      await q.query(
        `UPDATE ingest_runs SET status = $2, rows_in = $3, rows_written = $4, issues = $5, stats = $6, range_from = $7, range_to = $8, finished_at = clock_timestamp() WHERE id = $1`,
        [runId, status, norm.summary.rows, w.total, JSON.stringify(issues), JSON.stringify(w.byTable), range.from, range.to],
      );
      // 업로드 이력: 기간은 실제로 쓴 행 기준(파일 전체 기간은 fileDateFrom/To), 결과(outcome)는 수집 실행 상태와 같게 — 0행이면 'empty'
      const written = batchDateRange(checked.batch);
      const counts = { error: 0, warning: 0, info: 0 };
      for (const i of issues) counts[i.severity]++;
      const summary = {
        ...norm.summary, fileDateFrom: norm.summary.dateFrom, fileDateTo: norm.summary.dateTo,
        dateFrom: w.total ? written?.from ?? null : null, dateTo: w.total ? written?.to ?? null : null,
        rowsWritten: w.total, byTable: w.byTable, outcome: !w.total ? 'empty' : status === 'partial' ? 'partial' : 'imported', issueCounts: counts, runId,
        issueSummary: issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => i.message.slice(0, 200)),
      };
      await q.query(`UPDATE uploads SET status = 'imported', imported_at = now(), content = NULL, summary = $2 WHERE id = $1`, [up.id, JSON.stringify(summary)]);
      if (up.connection_id) await q.query(`UPDATE connections SET last_sync_at = $2, last_error = NULL, updated_at = now() WHERE id = $1`, [up.connection_id, new Date(nowMs()).toISOString()]);
      await afterIngest(q, wsId, up.connection_id);
      return { w, status: status as 'succeeded' | 'partial' };
    });
    return { runId, status: result.status, rowsIn: norm.summary.rows, rowsWritten: result.w.total, issues, range };
  } catch (e) {
    if (e instanceof SourceGoneError) return { runId, status: 'failed', rowsIn: 0, rowsWritten: 0, issues: [], error: e.message, range: { from: '', to: '' }, gone: true };
    const msg = errMsg(e);
    await db.query(`UPDATE ingest_runs SET status = 'failed', error = $2, finished_at = clock_timestamp() WHERE id = $1`, [runId, msg]);
    // 마지막 시도면 원본을 비운다 (재시도 안 함 — 원본 CSV를 DB에 남겨 두지 않는다)
    await db.query(
      `UPDATE uploads SET status = 'failed', summary = summary || $2::jsonb, content = CASE WHEN $3 THEN NULL ELSE content END WHERE id = $1 AND status <> 'imported'`,
      [up.id, JSON.stringify({ error: msg }), !!o.finalAttempt],
    );
    throw e;
  }
}
