/**
 * 워크스페이스 설정 (settings 도메인) — 저장 · 검증 · 기본값 병합 · 변경 이력 · 첫 실행 온보딩 판정.
 *
 * 다른 도메인은 loadWorkspaceConfig만 쓴다(검증을 통과한 덮어쓰기 — 잘못 저장된 항목은 경고를 남기고 뺀다):
 *   const cfg = await loadWorkspaceConfig(db, wsId);
 *   const result = withWorkspaceConfig(cfg, () => detectIncidents(dataset, ...));   // src/data/config.ts (동기 함수만)
 * 기본값을 합친 전체 값이 필요하면 loadEffectiveConfig(예: 시간표 · 월 구독료 · AI 한도).
 *
 * 저장 형식: workspaces.config = 바꾼 항목만(스키마 src/data/config.ts WorkspaceConfigSchema).
 * 스키마 밖의 최상위 키(다른 도메인이 직접 쓴 값)는 저장 시 그대로 보존하고, 새로 넣으려 하면 거부한다.
 * 이력: audit_log(target_type = 'workspace_config') — action 'config.update' · 'config.reset' · 'config.review'.
 */
import type { Db, Queryable } from '../db/pool';
import { one } from '../db/pool';
import type { WorkspaceCtx } from '../http/context';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { conflict, HttpError } from '../lib/errors';
import {
  CONFIG_SECTIONS, configFieldLabel, DEFAULT_CONFIG, isEmptyConfig, leafPaths, mergeConfig, overrideChanges, parseWorkspaceConfig,
  type ConfigChangeRow, type ConfigIssue, type EffectiveConfig, type WorkspaceConfig,
} from '@/data/config';

export const CONFIG_TARGET = 'workspace_config';
const KNOWN = new Set<string>(CONFIG_SECTIONS as string[]);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 경고 로그 (같은 내용은 한 번만) ---------- */

const warned = new Set<string>();
function warnInvalid(workspaceId: string, errors: ConfigIssue[]): void {
  const key = `${workspaceId}|${errors.map((e) => `${e.path}:${e.message}`).join(';')}`;
  if (warned.has(key)) return;
  if (warned.size > 500) warned.clear();
  warned.add(key);
  console.warn(`[settings] 워크스페이스 ${workspaceId} 설정 중 ${errors.length}개 항목을 무시하고 기본값을 씁니다: ${errors.map((e) => `${e.path || '(전체)'} — ${e.message}`).join(' · ')}`);
}

/** 저장된 원본 → 스키마 항목(검증) · 스키마 밖 최상위 키(보존) */
function splitStored(raw: unknown): { known: Record<string, unknown>; extra: Record<string, unknown> } {
  const known: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  if (isPlain(raw)) for (const [k, v] of Object.entries(raw)) (KNOWN.has(k) ? known : extra)[k] = v;
  return { known, extra };
}

/* ---------- 읽기 ---------- */

/** 검증을 통과한 덮어쓰기 (다른 도메인 공용 — 서명 유지) */
export async function loadWorkspaceConfig(q: Queryable, workspaceId: string): Promise<WorkspaceConfig> {
  const r = await one<{ config: unknown }>(q, 'SELECT config FROM workspaces WHERE id = $1', [workspaceId]);
  const { known } = splitStored(r?.config);
  const { config, errors } = parseWorkspaceConfig(known);
  if (errors.length) warnInvalid(workspaceId, errors);
  return config;
}

/** 기본값 + 덮어쓰기 = 전체 설정 */
export async function loadEffectiveConfig(q: Queryable, workspaceId: string): Promise<EffectiveConfig> {
  return mergeConfig(DEFAULT_CONFIG, await loadWorkspaceConfig(q, workspaceId));
}

export interface ConfigState {
  /** 저장된 덮어쓰기 (검증 통과분) */
  config: WorkspaceConfig;
  /** 기본값 + 덮어쓰기 */
  effective: EffectiveConfig;
  /** 기본값 (constants.ts · 수면밀도) */
  defaults: EffectiveConfig;
  /** 덮어쓴 항목 경로 */
  overridden: string[];
  /** 저장돼 있지만 검증을 통과하지 못해 무시하는 항목 */
  invalid: ConfigIssue[];
  /** 스키마 밖 최상위 키 (다른 도메인 값 — 저장 시 보존) */
  preserved: string[];
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}

interface WsConfigRow {
  config: unknown;
  config_version: number;
  config_updated_at: Date | null;
  config_updated_by: string | null;
  updated_by_name: string | null;
}

async function readRow(q: Queryable, workspaceId: string, lock = false): Promise<WsConfigRow | null> {
  return one<WsConfigRow>(
    q,
    `SELECT w.config, w.config_version, w.config_updated_at, w.config_updated_by, u.name AS updated_by_name
       FROM workspaces w LEFT JOIN users u ON u.id = w.config_updated_by
      WHERE w.id = $1${lock ? ' FOR UPDATE OF w' : ''}`,
    [workspaceId],
  );
}

function stateOf(row: WsConfigRow): ConfigState {
  const { known, extra } = splitStored(row.config);
  const { config, errors } = parseWorkspaceConfig(known);
  return {
    config,
    effective: mergeConfig(DEFAULT_CONFIG, config),
    defaults: DEFAULT_CONFIG,
    overridden: leafPaths(config),
    invalid: errors,
    preserved: Object.keys(extra),
    version: row.config_version ?? 0,
    updatedAt: row.config_updated_at ? new Date(row.config_updated_at).toISOString() : null,
    updatedBy: row.config_updated_by ? { id: row.config_updated_by, name: row.updated_by_name ?? '알 수 없음' } : null,
  };
}

export async function readConfigState(q: Queryable, workspaceId: string): Promise<ConfigState> {
  const row = await readRow(q, workspaceId);
  if (!row) throw new HttpError(404, 'not_found', '워크스페이스를 찾을 수 없습니다');
  return stateOf(row);
}

/* ---------- 저장 ---------- */

export type { ConfigChangeRow };

export interface SaveResult extends ConfigState {
  changed: boolean;
  dryRun: boolean;
  changes: ConfigChangeRow[];
}

export class ConfigValidationError extends HttpError {
  constructor(public issues: ConfigIssue[]) {
    super(400, 'invalid_config', `설정값을 확인해 주세요: ${issues.slice(0, 6).map((i) => `${configFieldLabel(i.path) || '(전체)'} — ${i.message}`).join(' · ')}${issues.length > 6 ? ` 외 ${issues.length - 6}건` : ''}`, issues);
  }
}

/**
 * 덮어쓰기 전체를 바꾼다(PUT). 검증 실패 → 400(항목별 사유), baseVersion이 지금 버전과 다르면 409.
 * 바뀐 항목이 없으면 기록하지 않는다. dryRun이면 검증 · 차이만 돌려준다.
 */
export async function saveConfig(db: Db, c: WorkspaceCtx, input: unknown, o: { baseVersion?: number; dryRun?: boolean } = {}): Promise<SaveResult> {
  if (!isPlain(input)) throw new ConfigValidationError([{ path: '', message: '설정은 항목 묶음(객체) 형식이어야 합니다' }]);
  return db.tx(async (q) => {
    const row = await readRow(q, c.workspace.id, true);
    if (!row) throw new HttpError(404, 'not_found', '워크스페이스를 찾을 수 없습니다');
    const cur = stateOf(row);
    if (o.baseVersion !== undefined && o.baseVersion !== cur.version) {
      throw conflict('다른 사용자가 먼저 설정을 바꿨습니다. 최신 설정을 다시 불러온 뒤 저장해 주세요', { version: cur.version, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy });
    }
    const { known: storedKnown, extra: storedExtra } = splitStored(row.config);
    const { known, extra } = splitStored(input);
    const issues: ConfigIssue[] = [];
    // 스키마 밖 키: 저장된 값과 같으면 보존, 새 키 · 다른 값은 거부
    for (const [k, v] of Object.entries(extra)) {
      if (!(k in storedExtra)) issues.push({ path: k, message: '알 수 없는 항목입니다' });
      else if (!same(v, storedExtra[k])) issues.push({ path: k, message: '이 화면에서 바꿀 수 없는 항목입니다' });
    }
    const parsed = parseWorkspaceConfig(known);
    issues.push(...parsed.errors);
    if (issues.length) throw new ConfigValidationError(issues);
    const next = parsed.config;
    const prevParsed = parseWorkspaceConfig(storedKnown).config;
    const changes = overrideChanges(prevParsed, next);
    // 저장돼 있던 잘못된 항목이 빠지는 것도 변경이다
    const cleansInvalid = cur.invalid.length > 0;
    const changed = changes.length > 0 || cleansInvalid;
    const toStore = { ...storedExtra, ...next };
    const nextState: ConfigState = {
      ...cur,
      config: next,
      effective: mergeConfig(DEFAULT_CONFIG, next),
      overridden: leafPaths(next),
      invalid: [],
    };
    if (!changed || o.dryRun) return { ...(o.dryRun ? nextState : cur), changed, dryRun: !!o.dryRun, changes };

    const up = await one<{ config_version: number; config_updated_at: Date }>(
      q,
      `UPDATE workspaces SET config = $2::jsonb, config_version = config_version + 1, config_updated_at = now(), config_updated_by = $3, updated_at = now()
        WHERE id = $1 RETURNING config_version, config_updated_at`,
      [c.workspace.id, JSON.stringify(toStore), c.user.id],
    );
    const version = up!.config_version;
    const reset = isEmptyConfig(next) && !isEmptyConfig(prevParsed);
    await audit(q, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, ip: c.ip,
      action: reset ? 'config.reset' : 'config.update', targetType: CONFIG_TARGET, targetId: String(version),
      detail: {
        version,
        changes: changes.map((x) => ({ path: x.path, label: x.label, before: x.before, after: x.after, beforeSource: x.beforeSource, afterSource: x.afterSource })),
        overriddenCount: leafPaths(next).length,
        droppedInvalid: cur.invalid.map((i) => i.path),
      },
    });
    await publish(q, c.workspace.id, { type: 'config', id: 'workspace' });
    return {
      ...nextState,
      version,
      updatedAt: new Date(up!.config_updated_at).toISOString(),
      updatedBy: { id: c.user.id, name: c.user.name },
      changed: true,
      dryRun: false,
      changes,
    };
  });
}

/* ---------- 이력 ---------- */

export interface HistoryEntry {
  id: number;
  at: string;
  actor: string;
  userId: string | null;
  action: string;
  version: number | null;
  changes: { path: string; label: string; before: unknown; after: unknown; beforeSource?: string; afterSource?: string }[];
  note?: string;
}

export async function configHistory(q: Queryable, workspaceId: string, o: { before?: number; limit?: number } = {}): Promise<{ entries: HistoryEntry[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100);
  const r = await q.query<{ id: number; at: Date; actor: string; user_id: string | null; action: string; detail: Record<string, unknown> }>(
    `SELECT id, at, actor, user_id, action, detail FROM audit_log
      WHERE workspace_id = $1 AND target_type = $2 AND ($3::bigint IS NULL OR id < $3)
      ORDER BY id DESC LIMIT $4`,
    [workspaceId, CONFIG_TARGET, o.before ?? null, limit + 1],
  );
  const rows = r.rows.slice(0, limit);
  const entries = rows.map((x): HistoryEntry => {
    const d = x.detail ?? {};
    const changes = Array.isArray(d.changes) ? (d.changes as HistoryEntry['changes']).map((ch) => ({ ...ch, label: ch.label ?? configFieldLabel(ch.path) })) : [];
    return {
      id: Number(x.id), at: new Date(x.at).toISOString(), actor: x.actor, userId: x.user_id, action: x.action,
      version: typeof d.version === 'number' ? d.version : null, changes,
      note: typeof d.note === 'string' ? d.note : undefined,
    };
  });
  return { entries, nextBefore: r.rows.length > limit ? Number(rows[rows.length - 1].id) : null };
}

/* ---------- 목표 · 예산 확인 (온보딩) ---------- */

export async function reviewConfig(db: Db, c: WorkspaceCtx, note?: string): Promise<void> {
  await db.tx(async (q) => {
    const st = stateOf((await readRow(q, c.workspace.id))!);
    await audit(q, {
      workspaceId: c.workspace.id, userId: c.user.id, actor: c.actor, ip: c.ip,
      action: 'config.review', targetType: CONFIG_TARGET, targetId: String(st.version),
      detail: {
        version: st.version,
        note: note?.trim() || '목표 · 예산 기준을 확인했습니다',
        reviewed: {
          targets: st.effective.targets, annualBudget: st.effective.budget.annual, allocation: st.effective.budget.allocation,
          dailyChangeCapPct: st.effective.safety.dailyChangeCapPct, delegation: st.effective.delegation,
        },
        changes: [],
      },
    });
    await publish(q, c.workspace.id, { type: 'config', id: 'review' });
  });
}

/* ---------- 첫 실행 온보딩 ---------- */

export type OnboardingStepId = 'data' | 'team' | 'goals' | 'notify';
export interface OnboardingStep { id: OnboardingStepId; label: string; href: string; done: boolean; detail: string; at?: string }
export interface OnboardingState {
  /** 덮어쓴 설정이 없고 실데이터(데모 제외) 연결도 없는 첫 실행 상태 */
  firstRun: boolean;
  steps: OnboardingStep[];
  done: number;
  total: number;
}

export async function onboardingState(q: Queryable, workspaceId: string): Promise<OnboardingState> {
  const r = await one<{ conns: number; uploads: number; demo: number; members: number; invites: number; channels: number; reviewed: number; reviewed_at: Date | null }>(
    q,
    `SELECT
       (SELECT count(*) FROM connections WHERE workspace_id = $1 AND provider <> 'demo' AND status <> 'disabled')::int AS conns,
       (SELECT count(*) FROM uploads WHERE workspace_id = $1 AND status = 'imported')::int AS uploads,
       (SELECT count(*) FROM connections WHERE workspace_id = $1 AND provider = 'demo')::int AS demo,
       (SELECT count(*) FROM memberships WHERE workspace_id = $1)::int AS members,
       (SELECT count(*) FROM invites WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())::int AS invites,
       (SELECT count(*) FROM notification_channels WHERE workspace_id = $1 AND enabled)::int AS channels,
       (SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND target_type = $2 AND action = 'config.review')::int AS reviewed,
       (SELECT max(at) FROM audit_log WHERE workspace_id = $1 AND target_type = $2 AND action = 'config.review') AS reviewed_at`,
    [workspaceId, CONFIG_TARGET],
  );
  const cfg = await loadWorkspaceConfig(q, workspaceId);
  const overridden = leafPaths(cfg);
  const goalOverrides = overridden.filter((p) => p.startsWith('targets.') || p.startsWith('budget.'));
  const x = r ?? { conns: 0, uploads: 0, demo: 0, members: 0, invites: 0, channels: 0, reviewed: 0, reviewed_at: null };
  const steps: OnboardingStep[] = [
    {
      id: 'data', label: '데이터 연결', href: '#connections', done: x.conns > 0 || x.uploads > 0,
      detail: x.conns > 0 || x.uploads > 0
        ? `실데이터 연결 ${x.conns}개 · 가져온 CSV ${x.uploads}건`
        : x.demo > 0 ? '데모 데이터만 연결됨 — 매체 · 판매 채널 API를 연결하거나 CSV를 올려 주세요' : '연결된 데이터가 없습니다 — 매체 · 판매 채널 API를 연결하거나 CSV를 올려 주세요',
    },
    {
      id: 'team', label: '팀 초대', href: '#team', done: x.members >= 2 || x.invites > 0,
      detail: x.members >= 2 || x.invites > 0 ? `구성원 ${x.members}명 · 수락 대기 초대 ${x.invites}건` : '아직 혼자입니다 — 담당 AE · PM · 광고주 담당자를 초대해 주세요',
    },
    {
      id: 'goals', label: '목표 · 예산 확인', href: '#workspace', done: goalOverrides.length > 0 || x.reviewed > 0,
      detail: goalOverrides.length > 0
        ? `목표 · 예산 항목 ${goalOverrides.length}개를 워크스페이스 값으로 바꿈`
        : x.reviewed > 0 ? '기본값(제안서 기준)을 그대로 쓰기로 확인함' : '목표 ROAS · 연 예산 · 매체 배분이 제안서 기본값입니다 — 확인하거나 바꿔 주세요',
      at: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : undefined,
    },
    {
      id: 'notify', label: '알림 채널', href: '#notify', done: x.channels > 0,
      detail: x.channels > 0 ? `켜진 알림 채널 ${x.channels}개` : 'P1 이슈 · SLA 초과를 받을 Slack · 이메일 · 웹훅 채널이 없습니다',
    },
  ];
  return { firstRun: overridden.length === 0 && x.conns === 0 && x.uploads === 0, steps, done: steps.filter((s) => s.done).length, total: steps.length };
}
