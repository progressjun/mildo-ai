/**
 * 커넥션 서비스 — CRUD · 연결 확인 · 수동 수집 요청 API, 그리고 커넥터 실행 컨텍스트 빌더.
 *
 *   buildConnectorContext(db, config, connectionRow, { dryRun })  → ConnectorContext
 *     수집(ingest)과 매체 반영(changes 도메인 실행기)이 같이 쓴다. 자격증명은 여기서만 복호화한다.
 *     dryRun 기본값 = write_mode !== 'live'. http는 타임아웃 · 재시도 · 마스킹 로그가 붙은 래퍼(테스트는 fetchImpl · http 주입).
 *
 * API (docs/SAAS_SPEC.md §6): GET/POST /api/w/:ws/connections · PATCH/DELETE …/:id · POST …/:id/test · POST …/:id/sync
 * 권한: 읽기 read, 생성 · 수정 · 삭제 · 연결 확인 configure, 수동 수집 operate, write_mode='live'로 켜기 live_write.
 *   live 커넥션의 자격증명 교체도 live_write — 반영 대상 계정을 바꾸는 일이라 live를 켜는 것과 같은 권한으로 본다.
 * CSV 전용 공급자(수집 항목 reads가 비어 있는 API 공급자 — 예: 오늘의집): 커넥션을 만들지 않고 400 csv_only + CSV 경로 안내(csvOnlyGuide).
 * OAuth 공급자(카페24): 토큰 없이 앱 정보(쇼핑몰 ID · Client ID · Client Secret)만으로 저장할 수 있다(상태 pending) —
 *   커넥션 카드의 '카페24 인증 시작'(connectors/oauth.ts)으로 운영자 승인을 받으면 토큰이 저장된다(credentials.ts OAUTH_APPS).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Db, Queryable } from '../db/pool';
import { one } from '../db/pool';
import type { AppConfig } from '../config';
import type { ConnectorContext, ConnectorDef, ConnectorHttp } from './types';
import { getConnector } from './registry';
import { createConnectorHttp, scrubSecrets, type FetchLike } from './http';
import { cleanCredentials, decryptCredentials, encryptCredentials, maskedCredentials, mergeCredentials, needsOAuthApproval, oauthApprovalMessage, oauthPendingCredentials, type Credentials } from './credentials';
import { csvGuide as ohouseCsvGuide } from './ohouse';
import { z, parseBody } from '../lib/validate';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../lib/errors';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { enqueue } from '../jobs/queue';
import { can } from '../auth/permissions';
import { addDaysStr, kstToday } from '../lib/time';
import { purgeSource } from '../warehouse/write';
import { MEDIA_IDS, SALES_CHANNEL_IDS } from '@/data/constants';

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  kind: 'media' | 'sales' | 'other';
  channel: string | null;
  label: string;
  status: 'pending' | 'active' | 'error' | 'disabled';
  credentials_enc: string | null;
  settings: Record<string, unknown>;
  write_mode: 'off' | 'dry_run' | 'live';
  priority: number;
  last_test_at: Date | string | null;
  last_sync_at: Date | string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export type SourceKind = 'api' | 'csv' | 'demo';
export const DEFAULT_PRIORITY: Record<SourceKind, number> = { api: 100, csv: 50, demo: 10 };
export const MAX_BACKFILL_DAYS = 400;
/** 연결 확인 성공 후 처음 한 번 자동으로 채우는 기간 (Dataset 기본 기간과 같음) */
export const INITIAL_BACKFILL_DAYS = 120;

export const sourceKindOf = (provider: string): SourceKind => (provider === 'demo' ? 'demo' : provider === 'csv' ? 'csv' : 'api');
/** 웨어하우스 출처 키 — 데모는 'demo', 나머지는 커넥션 id (업로드는 'csv:<업로드 id>') */
export const sourceKeyOf = (c: { id: string; provider: string }): string => (c.provider === 'demo' ? 'demo' : c.id);
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/** 설정에 비밀값처럼 보이는 키가 섞여 들어와도 응답에는 내보내지 않는다 (자격증명은 credentials로만 받는다) */
const SECRET_SETTING = /(secret|token|password|passwd|apikey|api_key|credential|private|signature)/i;
export function safeSettings(settings: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings ?? {})) out[k] = SECRET_SETTING.test(k) ? (v === undefined || v === null || v === '' ? null : '••••') : v;
  return out;
}

/* ---------- CSV 전용 공급자 ---------- */

export interface CsvOnlyGuide {
  /** 업로드 템플릿 id (src/modules/connections/csv.ts UPLOAD_TEMPLATES) */
  template: 'sales_daily' | 'media_daily';
  /** 템플릿의 채널 · 매체 값 */
  channel: string | null;
  /** 화면 · 오류 응답 안내 (한국어) */
  message: string;
}

/** 공급자별 CSV 경로 안내 — 공급자 파일이 내보낸 안내를 쓴다 (없으면 종류별 기본 안내) */
const CSV_ONLY_GUIDES: Record<string, CsvOnlyGuide> = {
  ohouse: { template: ohouseCsvGuide.template, channel: ohouseCsvGuide.channel, message: ohouseCsvGuide.message },
};

/** API 수집 항목이 없는 공급자(csv · demo 제외)면 CSV 업로드 안내, 아니면 null */
export function csvOnlyGuide(def: Pick<ConnectorDef, 'provider' | 'kind' | 'channel' | 'label' | 'capabilities'>): CsvOnlyGuide | null {
  if (def.provider === 'csv' || def.provider === 'demo' || def.capabilities.reads.length > 0) return null;
  const known = CSV_ONLY_GUIDES[def.provider];
  if (known) return { ...known };
  const template = def.kind === 'sales' ? 'sales_daily' : 'media_daily';
  return { template, channel: def.channel, message: `${def.label}은(는) API 수집을 지원하지 않습니다 — ${template} CSV 템플릿${def.channel ? `(채널 · 매체 값 ${def.channel})` : ''}으로 데이터 연결 화면의 업로드에 올려 주세요` };
}

/* ---------- 컨텍스트 빌더 ---------- */

export interface BuildContextOptions {
  /** 기본: write_mode !== 'live' */
  dryRun?: boolean;
  /** 테스트 · 실행기: http 래퍼 직접 주입 */
  http?: ConnectorHttp;
  /** 테스트: 가짜 fetch (http를 주지 않을 때) */
  fetchImpl?: FetchLike;
  log?: (msg: string, extra?: unknown) => void;
  timeoutMs?: number;
  maxRetries?: number;
}

export function buildConnectorContext(db: Queryable, config: AppConfig, row: ConnectionRow, opts: BuildContextOptions = {}): ConnectorContext {
  const tag = `[connector ${row.provider}:${row.id.slice(0, 8)}]`;
  const log = (msg: string, extra?: unknown) => {
    const m = scrubSecrets(String(msg));
    if (opts.log) return opts.log(m, extra);
    if (config.env !== 'test') console.log(`${tag} ${m}`);
  };
  const credentials = decryptCredentials<Credentials>(row.credentials_enc, config.encryptionKey);
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const http = opts.http ?? createConnectorHttp({ fetchImpl: opts.fetchImpl, log, maxRetries: opts.maxRetries ?? 3, timeoutMs: opts.timeoutMs ?? 30_000 });
  return {
    workspaceId: row.workspace_id,
    connectionId: row.id,
    credentials,
    settings,
    http,
    log,
    dryRun: opts.dryRun ?? row.write_mode !== 'live',
    saveCredentials: async (next: Credentials) => {
      await db.query(`UPDATE connections SET credentials_enc = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2`, [row.id, row.workspace_id, encryptCredentials(next, config.encryptionKey)]);
      await audit(db, { workspaceId: row.workspace_id, actor: 'system', action: 'connection.credentials_refreshed', targetType: 'connection', targetId: row.id, detail: { provider: row.provider, keys: Object.keys(next ?? {}) } });
    },
  };
}

/* ---------- 조회 · 화면용 표현 ---------- */

export async function loadConnection(q: Queryable, wsId: string, id: string): Promise<ConnectionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<ConnectionRow>(q, 'SELECT * FROM connections WHERE workspace_id = $1 AND id = $2', [wsId, id]);
}

export interface RunSummary {
  id: string;
  job: string;
  status: string;
  rowsIn: number;
  rowsWritten: number;
  issueCounts: { error: number; warning: number; info: number };
  error: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ConnectionView {
  id: string;
  provider: string;
  providerLabel: string;
  kind: string;
  channel: string | null;
  label: string;
  status: ConnectionRow['status'];
  writeMode: ConnectionRow['write_mode'];
  priority: number;
  sourceKind: SourceKind;
  source: string;
  settings: Record<string, unknown>;
  credentials: Record<string, string | null>;
  hasCredentials: boolean;
  verifiedLive: boolean;
  docsUrl: string;
  capabilities: ConnectorDef['capabilities'] | null;
  lastTestAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** 대기 · 실행 중 수집 잡 수 */
  pendingJobs: number;
  lastRun: RunSummary | null;
}

export function issueCounts(issues: unknown): RunSummary['issueCounts'] {
  const c = { error: 0, warning: 0, info: 0 };
  if (Array.isArray(issues)) for (const i of issues) {
    const s = (i as { severity?: string })?.severity;
    if (s === 'error' || s === 'warning' || s === 'info') c[s]++;
  }
  return c;
}

export function toRunSummary(r: Record<string, any>): RunSummary {
  return {
    id: r.id, job: r.job, status: r.status, rowsIn: Number(r.rows_in ?? 0), rowsWritten: Number(r.rows_written ?? 0), issueCounts: issueCounts(r.issues),
    error: r.error ?? null, rangeFrom: r.range_from ?? null, rangeTo: r.range_to ?? null, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}

export function toConnectionView(row: ConnectionRow, config: AppConfig, extras: { pendingJobs?: number; lastRun?: RunSummary | null } = {}): ConnectionView {
  const def = getConnector(row.provider);
  let creds: Credentials = {};
  let credError: string | null = null;
  try { creds = decryptCredentials(row.credentials_enc, config.encryptionKey); } catch (e) { credError = (e as Error).message; }
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: def?.label ?? row.provider,
    kind: row.kind,
    channel: row.channel,
    label: row.label,
    status: row.status,
    writeMode: row.write_mode,
    priority: row.priority,
    sourceKind: sourceKindOf(row.provider),
    source: sourceKeyOf(row),
    settings: safeSettings(row.settings),
    credentials: maskedCredentials(def, creds),
    hasCredentials: !!row.credentials_enc && Object.keys(creds).length > 0,
    verifiedLive: def?.verifiedLive ?? false,
    docsUrl: def?.docsUrl ?? '',
    capabilities: def?.capabilities ?? null,
    lastTestAt: iso(row.last_test_at),
    lastSyncAt: iso(row.last_sync_at),
    lastError: row.last_error ?? credError,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    pendingJobs: extras.pendingJobs ?? 0,
    lastRun: extras.lastRun ?? null,
  };
}

export async function listConnectionViews(q: Queryable, config: AppConfig, wsId: string): Promise<ConnectionView[]> {
  const rows = (await q.query<ConnectionRow>('SELECT * FROM connections WHERE workspace_id = $1 ORDER BY priority DESC, created_at', [wsId])).rows;
  if (!rows.length) return [];
  const jobs = (await q.query<{ cid: string; n: number }>(
    `SELECT payload->>'connectionId' AS cid, count(*)::int AS n FROM jobs
      WHERE workspace_id = $1 AND status IN ('queued', 'running') AND type LIKE 'ingest.%' AND payload ? 'connectionId'
      GROUP BY 1`, [wsId],
  )).rows;
  const runs = (await q.query(
    `SELECT DISTINCT ON (connection_id) * FROM ingest_runs WHERE workspace_id = $1 AND connection_id IS NOT NULL
      ORDER BY connection_id, started_at DESC`, [wsId],
  )).rows as Record<string, any>[];
  const jobMap = new Map(jobs.map((j) => [j.cid, Number(j.n)]));
  const runMap = new Map(runs.map((r) => [r.connection_id as string, toRunSummary(r)]));
  return rows.map((r) => toConnectionView(r, config, { pendingJobs: jobMap.get(r.id) ?? 0, lastRun: runMap.get(r.id) ?? null }));
}

/* ---------- 연결 확인 ---------- */

const TEST_TIMEOUT_MS = 30_000;

export async function runConnectionTest(db: Queryable, config: AppConfig, row: ConnectionRow, opts: BuildContextOptions = {}): Promise<{ ok: boolean; message: string; account?: string }> {
  const def = getConnector(row.provider);
  if (!def) return { ok: false, message: `알 수 없는 공급자: ${row.provider}` };
  let result: { ok: boolean; message: string; account?: string };
  try {
    const ctx = buildConnectorContext(db, config, row, { ...opts, dryRun: true });
    const parsed = def.credentialsSchema.safeParse(ctx.credentials);
    if (!parsed.success && needsOAuthApproval(def.provider, ctx.credentials)) {
      result = { ok: false, message: oauthApprovalMessage(def) };
    } else if (!parsed.success) {
      result = { ok: false, message: `자격증명 항목을 확인해 주세요: ${parsed.error.issues.map((i) => i.path.join('.') || '(전체)').join(', ')}` };
    } else {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`연결 확인 시간 초과 (${TEST_TIMEOUT_MS / 1000}초)`)), TEST_TIMEOUT_MS); });
      try {
        result = await Promise.race([def.test({ ...ctx, credentials: parsed.data }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (e) {
    result = { ok: false, message: scrubSecrets((e as Error)?.message ?? String(e)).slice(0, 500) };
  }
  const message = scrubSecrets(String(result.message ?? '')).slice(0, 500);
  return { ok: !!result.ok, message, account: result.account ? String(result.account).slice(0, 200) : undefined };
}

/* ---------- 라우트 ---------- */

const ALL_CHANNELS = [...MEDIA_IDS, ...SALES_CHANNEL_IDS] as string[];
const WriteMode = z.enum(['off', 'dry_run', 'live']);
const CreateBody = z.object({
  provider: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(80).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  writeMode: WriteMode.optional(),
  channel: z.string().max(40).nullable().optional(),
});
const PatchBody = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  clearCredentials: z.array(z.string().max(80)).max(40).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  writeMode: WriteMode.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  channel: z.string().max(40).nullable().optional(),
});
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const SyncBody = z.object({ from: DateStr.optional(), to: DateStr.optional() });

function validateWith<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = r.error.issues.map((i) => i.path.join('.') || '(전체)');
    throw badRequest(`${what} 항목을 확인해 주세요: ${[...new Set(fields)].join(', ')}`, fields.map((path) => ({ path })));
  }
  return r.data;
}

/**
 * 자격증명 검증 — 공급자 스키마 그대로. 단 OAuth 공급자는 토큰 없이 앱 정보만 넣은 경우를 승인 대기로 받아 준다
 * (정규화된 앱 정보만 저장 · 상태 pending, 인증 시작 버튼으로 토큰을 받는다).
 */
function validateCredentials(def: ConnectorDef, input: Credentials): Credentials {
  const r = def.credentialsSchema.safeParse(input);
  if (r.success) return r.data as Credentials;
  const pending = oauthPendingCredentials(def.provider, input, r.error.issues);
  if (pending) return pending;
  return validateWith(def.credentialsSchema, input, '자격증명') as Credentials;
}

function resolveChannel(def: ConnectorDef, requested: string | null | undefined): string | null {
  if (def.channel) return def.channel;
  if (requested === undefined || requested === null || requested === '') return null;
  if (!ALL_CHANNELS.includes(requested)) throw badRequest(`알 수 없는 매체 · 채널: ${requested}`);
  return requested;
}

/** 연결 확인 성공 후 처음이면 초기 백필을 건다 */
async function maybeInitialBackfill(q: Queryable, row: ConnectionRow, def: ConnectorDef): Promise<boolean> {
  if (row.last_sync_at || def.capabilities.maxBackfillDays <= 0 || row.provider === 'csv') return false;
  const days = Math.min(def.capabilities.maxBackfillDays, INITIAL_BACKFILL_DAYS, MAX_BACKFILL_DAYS);
  const id = await enqueue(q, { type: 'ingest.backfill', workspaceId: row.workspace_id, payload: { connectionId: row.id, days, trigger: 'initial' }, dedupeKey: `ingest.backfill:${row.id}` });
  return id !== null;
}

export const connectionRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const list = (wsId: string) => listConnectionViews(db, config, wsId);
  /** 변경 응답: 바뀐 커넥션 + 전체 목록 (목록 한 번만 읽는다) */
  const withList = async <T extends object>(wsId: string, id: string, extra: T) => {
    const connections = await list(wsId);
    return { ...extra, connection: connections.find((c) => c.id === id) ?? null, connections };
  };

  app.get('/w/:ws/connections', async (req) => {
    const c = await req.workspace('read');
    return { connections: await list(c.workspace.id) };
  });

  app.post('/w/:ws/connections', async (req) => {
    const c = await req.workspace('configure');
    const body = parseBody(CreateBody, req.body);
    const def = getConnector(body.provider);
    if (!def) throw badRequest(`알 수 없는 공급자입니다: ${body.provider}`);
    const csvOnly = csvOnlyGuide(def);
    if (csvOnly) throw new HttpError(400, 'csv_only', csvOnly.message, { template: csvOnly.template, channel: csvOnly.channel });
    if (body.writeMode === 'live' && !can(c.role, 'live_write')) throw forbidden('실제 반영(live)은 관리자 · 소유자만 켤 수 있습니다');
    const creds = validateCredentials(def, cleanCredentials(body.credentials));
    const settings = validateWith(def.settingsSchema, body.settings ?? {}, '설정') as Record<string, unknown>;
    const channel = resolveChannel(def, body.channel);
    const kindOfSource = sourceKindOf(def.provider);
    const ws = c.workspace.id;
    const created = await db.tx(async (q) => {
      if (def.provider === 'demo') {
        const ex = await one(q, `SELECT id FROM connections WHERE workspace_id = $1 AND provider = 'demo'`, [ws]);
        if (ex) throw conflict('데모 데이터 커넥션은 워크스페이스에 하나만 둘 수 있습니다');
      }
      const row = await one<ConnectionRow>(
        q,
        `INSERT INTO connections (workspace_id, provider, kind, channel, label, status, credentials_enc, settings, write_mode, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [ws, def.provider, def.kind, channel, body.label ?? def.label, kindOfSource === 'api' ? 'pending' : 'active',
          Object.keys(creds).length ? encryptCredentials(creds, config.encryptionKey) : null, JSON.stringify(settings),
          body.writeMode ?? 'dry_run', body.priority ?? DEFAULT_PRIORITY[kindOfSource], c.user.id],
      );
      await audit(q, {
        workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'connection.create', targetType: 'connection', targetId: row!.id, ip: c.ip,
        detail: { provider: def.provider, label: row!.label, channel, writeMode: row!.write_mode, priority: row!.priority, fields: Object.keys(creds) },
      });
      if (def.provider === 'demo') {
        await enqueue(q, { type: 'ingest.backfill', workspaceId: ws, payload: { connectionId: row!.id, days: INITIAL_BACKFILL_DAYS, trigger: 'initial' }, dedupeKey: `ingest.backfill:${row!.id}` });
      }
      await publish(q, ws, { type: 'connection', id: row!.id });
      return row!;
    });
    return withList(ws, created.id, {});
  });

  app.patch('/w/:ws/connections/:id', async (req) => {
    const c = await req.workspace('configure');
    const ws = c.workspace.id;
    const { id } = req.params as { id: string };
    const body = parseBody(PatchBody, req.body);
    const row = await loadConnection(db, ws, id);
    if (!row) throw notFound('커넥션을 찾을 수 없습니다');
    const def = getConnector(row.provider);
    if (!def) throw badRequest(`알 수 없는 공급자입니다: ${row.provider}`);
    if (body.writeMode === 'live' && row.write_mode !== 'live' && !can(c.role, 'live_write')) throw forbidden('실제 반영(live)은 관리자 · 소유자만 켤 수 있습니다');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (k: string, b: unknown, a: unknown) => { if (JSON.stringify(b) !== JSON.stringify(a)) { before[k] = b; after[k] = a; } };
    let credsChanged: string[] = [];
    const liveAfter = (body.writeMode ?? row.write_mode) === 'live';
    if (body.label !== undefined) { track('label', row.label, body.label); set('label', body.label); }
    if (body.priority !== undefined) { track('priority', row.priority, body.priority); set('priority', body.priority); }
    if (body.writeMode !== undefined) { track('writeMode', row.write_mode, body.writeMode); set('write_mode', body.writeMode); }
    if (body.channel !== undefined) { const ch = resolveChannel(def, body.channel); track('channel', row.channel, ch); set('channel', ch); }
    if (body.settings !== undefined) {
      const s = validateWith(def.settingsSchema, body.settings, '설정');
      track('settings', row.settings, s);
      set('settings', JSON.stringify(s));
    }
    let nextStatus: ConnectionRow['status'] | undefined;
    if (body.credentials !== undefined || body.clearCredentials?.length) {
      const prev = decryptCredentials<Credentials>(row.credentials_enc, config.encryptionKey);
      const next = mergeCredentials(prev, body.credentials, body.clearCredentials);
      validateCredentials(def, next);
      credsChanged = Object.keys({ ...prev, ...next }).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
      if (credsChanged.length && liveAfter && !can(c.role, 'live_write')) {
        throw forbidden('실제 반영(live) 중인 커넥션의 자격증명은 관리자 · 소유자만 바꿀 수 있습니다 — 먼저 쓰기 모드를 dry_run으로 내리세요');
      }
      if (credsChanged.length) {
        set('credentials_enc', Object.keys(next).length ? encryptCredentials(next, config.encryptionKey) : null);
        // 자격증명이 바뀌면 다시 연결 확인을 받아야 한다
        if (sourceKindOf(row.provider) === 'api' && row.status !== 'disabled') nextStatus = 'pending';
      }
    }
    if (body.status !== undefined && body.status !== row.status && !(body.status === 'active' && row.status !== 'disabled')) {
      nextStatus = body.status === 'disabled' ? 'disabled' : sourceKindOf(row.provider) === 'api' ? 'pending' : 'active';
    }
    if (nextStatus && nextStatus !== row.status) {
      track('status', row.status, nextStatus);
      set('status', nextStatus);
    }
    if (!sets.length) return withList(ws, id, {});
    await db.tx(async (q) => {
      await q.query(`UPDATE connections SET ${sets.join(', ')}, updated_at = now() WHERE workspace_id = $1 AND id = $2`, [ws, id, ...vals]);
      if (Object.keys(after).length || credsChanged.length) {
        await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'connection.update', targetType: 'connection', targetId: id, ip: c.ip, detail: { provider: row.provider, before, after, fieldsChanged: credsChanged } });
      }
      if ('writeMode' in after) {
        await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'connection.write_mode', targetType: 'connection', targetId: id, ip: c.ip, detail: { provider: row.provider, label: row.label, before: before.writeMode, after: after.writeMode } });
      }
      await publish(q, ws, { type: 'connection', id });
    });
    return withList(ws, id, {});
  });

  app.delete('/w/:ws/connections/:id', async (req) => {
    const c = await req.workspace('configure');
    const ws = c.workspace.id;
    const { id } = req.params as { id: string };
    const row = await loadConnection(db, ws, id);
    if (!row) throw notFound('커넥션을 찾을 수 없습니다');
    const purged = await db.tx(async (q) => {
      // 먼저 행을 잠근다 — 진행 중인 수집의 쓰기(같은 행을 잠근다)가 끝난 뒤 지우므로, 지운 뒤 고아 행이 생기지 않는다
      if (!(await one(q, 'SELECT id FROM connections WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, id]))) throw notFound('커넥션을 찾을 수 없습니다');
      const n = await purgeSource(q, ws, sourceKeyOf(row));
      // 대기 중 수집은 취소 (실패가 아니므로 done + 사유)
      await q.query(
        `UPDATE jobs SET status = 'done', finished_at = now(), result = $3, last_error = NULL
          WHERE workspace_id = $1 AND status = 'queued' AND payload->>'connectionId' = $2`,
        [ws, id, JSON.stringify({ cancelled: '커넥션 삭제로 취소' })],
      );
      await q.query('DELETE FROM connections WHERE workspace_id = $1 AND id = $2', [ws, id]);
      await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'connection.delete', targetType: 'connection', targetId: id, ip: c.ip, detail: { provider: row.provider, label: row.label, purgedRows: n } });
      await publish(q, ws, { type: 'connection', id });
      if (n) await publish(q, ws, { type: 'dataset' });
      return n;
    });
    return { ok: true, purgedRows: purged, connections: await list(ws) };
  });

  // 외부 API를 부르는 요청은 사용자 · IP 단위로 묶어 과호출을 막는다
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/w/:ws/connections/:id/test', limited, async (req) => {
    const c = await req.workspace('configure');
    const ws = c.workspace.id;
    const { id } = req.params as { id: string };
    const row = await loadConnection(db, ws, id);
    if (!row) throw notFound('커넥션을 찾을 수 없습니다');
    const def = getConnector(row.provider);
    if (!def) throw badRequest(`알 수 없는 공급자입니다: ${row.provider}`);
    const result = await runConnectionTest(db, config, row);
    let backfillQueued = false;
    await db.tx(async (q) => {
      const nextStatus = row.status === 'disabled' ? 'disabled' : result.ok ? 'active' : 'error';
      await q.query(`UPDATE connections SET last_test_at = now(), status = $3, last_error = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
        [ws, id, nextStatus, result.ok ? null : result.message]);
      await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'connection.test', targetType: 'connection', targetId: id, ip: c.ip, detail: { provider: row.provider, ok: result.ok, message: result.message } });
      if (result.ok && row.status !== 'disabled') backfillQueued = await maybeInitialBackfill(q, row, def);
      await publish(q, ws, { type: 'connection', id });
    });
    return withList(ws, id, { result, backfillQueued });
  });

  app.post('/w/:ws/connections/:id/sync', limited, async (req) => {
    const c = await req.workspace('operate');
    const ws = c.workspace.id;
    const { id } = req.params as { id: string };
    const body = parseBody(SyncBody, req.body);
    const row = await loadConnection(db, ws, id);
    if (!row) throw notFound('커넥션을 찾을 수 없습니다');
    const def = getConnector(row.provider);
    if (!def) throw badRequest(`알 수 없는 공급자입니다: ${row.provider}`);
    if (row.status === 'disabled') throw conflict('사용 중지된 커넥션입니다. 먼저 다시 켜 주세요');
    if (row.provider === 'csv') throw badRequest('CSV 커넥션은 파일 업로드로 수집합니다');
    const today = kstToday();
    const jobIds: (number | null)[] = [];
    let range: { from: string; to: string } | null = null;
    if (body.from || body.to) {
      const to = body.to ?? addDaysStr(today, -1);
      const from = body.from ?? addDaysStr(to, -2);
      if (from > to) throw badRequest('시작일이 종료일보다 늦습니다');
      if (to > today) throw badRequest('미래 날짜는 수집할 수 없습니다');
      const maxDays = Math.min(MAX_BACKFILL_DAYS, def.capabilities.maxBackfillDays || 0);
      if (maxDays <= 0) throw badRequest(`${def.label}은(는) 기간 지정 수집을 지원하지 않습니다`);
      const earliest = addDaysStr(today, -maxDays);
      if (from < earliest) throw new HttpError(400, 'range_too_old', `${def.label}은(는) 최근 ${maxDays}일(${earliest} 이후)까지만 수집할 수 있습니다`);
      range = { from, to };
    }
    await db.tx(async (q) => {
      if (range) {
        jobIds.push(await enqueue(q, { type: 'ingest.backfill', workspaceId: ws, payload: { connectionId: id, from: range.from, to: range.to, trigger: 'manual' }, dedupeKey: `ingest.sync:${id}` }));
      } else {
        jobIds.push(await enqueue(q, { type: 'ingest.daily', workspaceId: ws, payload: { connectionId: id, trigger: 'manual' }, dedupeKey: `ingest.manual-daily:${id}` }));
        if (def.capabilities.intraday) jobIds.push(await enqueue(q, { type: 'ingest.intraday', workspaceId: ws, payload: { connectionId: id, trigger: 'manual' }, dedupeKey: `ingest.manual-intraday:${id}` }));
      }
      await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'connection.sync', targetType: 'connection', targetId: id, ip: c.ip, detail: { provider: row.provider, range, queued: jobIds.filter((x) => x !== null).length } });
      await publish(q, ws, { type: 'connection', id });
    });
    const queued = jobIds.some((x) => x !== null);
    return withList(ws, id, { queued, alreadyQueued: !queued, jobIds: jobIds.filter((x) => x !== null), range });
  });
};

/** 다른 도메인 · 잡에서: id로 커넥션을 읽고 실행 컨텍스트를 만든다 */
export async function contextForConnection(db: Db, config: AppConfig, wsId: string, connectionId: string, opts: BuildContextOptions = {}): Promise<{ row: ConnectionRow; def: ConnectorDef; ctx: ConnectorContext } | null> {
  const row = await loadConnection(db, wsId, connectionId);
  if (!row) return null;
  const def = getConnector(row.provider);
  if (!def) return null;
  return { row, def, ctx: buildConnectorContext(db, config, row, opts) };
}
