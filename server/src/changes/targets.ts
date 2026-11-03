/**
 * 변경 요청 대상 해석 — targetId 규칙 → 웨어하우스 엔티티(wh_entities) → 출처 커넥션.
 *
 * targetId 규칙 (프런트 모듈이 만드는 형식 — src/modules/adpilot/engine.ts · src/modules/flow/engine.ts · src/modules/alert):
 *   '<keyword id>'                  AD Pilot 입찰 · 키워드 ON/OFF (kind bid · status)
 *   'budget:<받는 캠페인>:<주는 캠페인>' AD Pilot 예산 재배분 (주는 캠페인이 비어 있으면 받는 캠페인만)
 *   'gfa:budget:<campaign id>'      GFA Control 일 예산
 *   'flow:budget:<campaign id>'     MILDO Flow 일 예산 요청
 *   'gfa:adgroup:<cid>:<agid>'      GFA 광고그룹 ON/OFF
 *   'gfa:new:<account id>:<이름>'   GFA 신규 캠페인 (kind gfa)
 *   'alert:<이슈 id>:pause'         MILDO Alert 이슈 드로어의 키워드 일시 중지 (대상 '<키워드> 키워드')
 *   'alert:account:<계정>:topup'    잔액 충전 요청 — 결제 수단 승인이 필요해 API로 보내지 않는다(기록만)
 *   'adpilot.cfg.<키>' · 'alert_rule:<키>' · 'media:<매체>' · 'seed:…' · 'flow:promo:…' · 'flow:new:…' · 'flow:strategy…'
 *                                   내부 기준 · 시연 · 프로모션 단위 · 구조 변경 — 기록만
 */
import type { ChangeRequest, MediaId } from '@/core/types';
import type { Queryable } from '../db/pool';

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  kind: string;
  channel: string | null;
  label: string;
  status: 'pending' | 'active' | 'error' | 'disabled';
  credentials_enc: string | null;
  settings: Record<string, unknown>;
  write_mode: 'off' | 'dry_run' | 'live';
  priority: number;
}

export type EntityType = 'keyword' | 'campaign' | 'account';

export type TargetRef =
  | { type: 'record'; reason: string }
  | {
      type: 'entity';
      entityTypes: EntityType[];
      id?: string;
      /** 키워드 텍스트로 찾기 (MILDO Alert 일시 중지) */
      text?: string;
      adGroupId?: string;
      donorId?: string;
      newName?: string;
    }
  | { type: 'media'; media: MediaId; reason: string };

const RECORD_KINDS = new Set<ChangeRequest['kind']>(['setting', 'alert_rule', 'test']);

/** targetId 규칙 해석 (DB 없이) */
export function parseTarget(c: Pick<ChangeRequest, 'kind' | 'targetId' | 'module' | 'target'>): TargetRef {
  const tid = (c.targetId ?? '').trim();
  if (tid.startsWith('seed:') || tid.startsWith('seed_')) return { type: 'record', reason: '시연 이력(TEST DATA) — 매체에 보내지 않음' };
  if (/^alert:account:.+:topup$/.test(tid) || /^alert:.+:topup$/.test(tid)) return { type: 'record', reason: '잔액 충전은 결제 수단 소유자(광고주) 승인 · 매체 화면 충전이 필요해 API로 보내지 않습니다' };
  if (RECORD_KINDS.has(c.kind)) {
    if (tid.startsWith('adpilot.cfg.')) return { type: 'record', reason: 'AD Pilot 기준 변경 — MILDO OS 내부 기준에 반영' };
    if (tid.startsWith('alert_rule:') || c.kind === 'alert_rule') return { type: 'record', reason: '알림 · 탐지 기준 변경 — MILDO OS 내부 기준에 반영' };
    if (c.kind === 'test') return { type: 'record', reason: '테스트 요청 — 매체에 보내지 않음' };
    return { type: 'record', reason: '세팅 · 구조 변경 — 매체 화면에서 작업 후 결과를 이력에 남깁니다' };
  }
  if (tid.startsWith('flow:promo:')) return { type: 'record', reason: '프로모션 단위 예산 — 캠페인별 요청으로 나눠 반영해야 합니다' };
  if (tid.startsWith('flow:new:') || tid.startsWith('flow:strategy')) return { type: 'record', reason: '신규 캠페인 · 전략 방향 — 매체 화면에서 구성 후 기록' };
  if (tid.startsWith('media:')) return { type: 'record', reason: '매체 단위 보류 · 해제 — MILDO OS 내부 판정에 반영' };

  let m: RegExpMatchArray | null;
  if ((m = tid.match(/^budget:([^:]+):([^:]*)$/))) return { type: 'entity', entityTypes: ['campaign'], id: m[1], donorId: m[2] || undefined };
  if ((m = tid.match(/^(?:gfa|flow):budget:(.+)$/))) return { type: 'entity', entityTypes: ['campaign'], id: m[1] };
  if ((m = tid.match(/^gfa:adgroup:([^:]+):(.+)$/))) return { type: 'entity', entityTypes: ['campaign'], id: m[1], adGroupId: m[2] };
  if ((m = tid.match(/^gfa:new:([^:]+):(.*)$/))) return { type: 'entity', entityTypes: ['account'], id: m[1], newName: m[2] };
  if (/^alert:.+:pause$/.test(tid)) {
    const kw = (c.target ?? '').match(/^(.+) 키워드$/);
    if (c.kind === 'status' && kw) return { type: 'entity', entityTypes: ['keyword'], text: kw[1].trim() };
    return { type: 'record', reason: 'MILDO Alert 조치 요청 — 대상 키워드를 특정할 수 없어 기록만' };
  }
  if (tid.startsWith('alert:')) return { type: 'record', reason: 'MILDO Alert 조치 요청 — 매체 반영 대상 없음' };

  if (c.kind === 'keyword_add' || c.kind === 'keyword_exclude') {
    if (tid && !tid.startsWith('term:')) return { type: 'entity', entityTypes: ['keyword', 'campaign'], id: tid };
    const media: MediaId = c.module === 'gfa' ? 'naver_gfa' : 'naver_sa';
    return { type: 'media', media, reason: '키워드 추가 · 제외 — 매체 커넥션 기준' };
  }
  if (!tid) return { type: 'record', reason: '대상 id가 없어 매체 반영 대상을 찾을 수 없습니다' };
  const types: EntityType[] = c.kind === 'bid' ? ['keyword'] : c.kind === 'budget' ? ['campaign'] : ['keyword', 'campaign', 'account'];
  return { type: 'entity', entityTypes: types, id: tid };
}

export interface EntityHit {
  entityType: EntityType;
  externalId: string;
  source: string;
  doc: Record<string, unknown>;
  /** 웨어하우스에 마지막으로 쓰인 시각 (수집 기준 시각) */
  updatedAt: Date | null;
  connection: ConnectionRow | null;
}

const CONN_COLS = 'c.id, c.workspace_id, c.provider, c.kind, c.channel, c.label, c.status, c.credentials_enc, c.settings, c.write_mode, c.priority';

/**
 * 엔티티 찾기 — 같은 id가 여러 출처에 있으면 커넥션 출처(우선순위 높은 순)를 먼저.
 * 출처 키(warehouse): 실연동 = 커넥션 id, 데모 = 'demo'(워크스페이스의 provider 'demo' 커넥션), CSV = 'csv:<업로드 id>'(반영 커넥션 없음).
 */
export async function findEntities(q: Queryable, ws: string, types: EntityType[], by: { id?: string; text?: string }): Promise<EntityHit[]> {
  if (!by.id && !by.text) return [];
  const cond = by.id ? 'e.external_id = $3' : `e.doc->>'text' = $3`;
  const r = await q.query<{ entity_type: EntityType; external_id: string; source: string; doc: Record<string, unknown> } & { [k: string]: unknown }>(
    `SELECT e.entity_type, e.external_id, e.source, e.doc, e.updated_at AS e_updated_at, c.id AS c_id, ${CONN_COLS.replace(/c\.id, /, '')}
       FROM wh_entities e
       LEFT JOIN connections c ON c.workspace_id = e.workspace_id
             AND (c.id::text = e.source OR (e.source = 'demo' AND c.provider = 'demo'))
      WHERE e.workspace_id = $1 AND e.entity_type = ANY($2) AND ${cond}
      ORDER BY (c.id IS NULL), (c.status = 'disabled') NULLS LAST, c.priority DESC NULLS LAST, e.updated_at DESC
      LIMIT 20`,
    [ws, types, by.id ?? by.text],
  );
  return r.rows.map((row) => ({
    entityType: row.entity_type,
    externalId: row.external_id,
    source: row.source,
    doc: row.doc ?? {},
    updatedAt: row.e_updated_at ? new Date(row.e_updated_at as string | Date) : null,
    connection: row.c_id
      ? {
          id: row.c_id as string, workspace_id: row.workspace_id as string, provider: row.provider as string, kind: row.kind as string,
          channel: (row.channel as string | null) ?? null, label: row.label as string, status: row.status as ConnectionRow['status'],
          credentials_enc: (row.credentials_enc as string | null) ?? null, settings: (row.settings as Record<string, unknown>) ?? {},
          write_mode: row.write_mode as ConnectionRow['write_mode'], priority: Number(row.priority ?? 0),
        }
      : null,
  }));
}

export async function getConnection(q: Queryable, ws: string, id: string): Promise<ConnectionRow | null> {
  const r = await q.query<ConnectionRow>(`SELECT ${CONN_COLS} FROM connections c WHERE c.workspace_id = $1 AND c.id = $2`, [ws, id]);
  return r.rows[0] ?? null;
}

/** 매체 채널 기준 활성 커넥션 (키워드 추가 · 제외처럼 기존 엔티티가 없는 요청) */
export async function connectionsForChannel(q: Queryable, ws: string, channel: string): Promise<ConnectionRow[]> {
  const r = await q.query<ConnectionRow>(
    `SELECT ${CONN_COLS} FROM connections c WHERE c.workspace_id = $1 AND c.channel = $2 AND c.status <> 'disabled' ORDER BY c.priority DESC, c.created_at`,
    [ws, channel],
  );
  return r.rows;
}

export const numOf = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
