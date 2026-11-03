/**
 * 서버 24시간 감지 (alerts.scan) — 웨어하우스 Dataset → 워크스페이스 설정 적용 → MILDO Alert 탐지 엔진(detectIncidents) → 새 이슈만 저장.
 *
 * 규칙
 *  - 이슈 id는 엔진이 결정적으로 만든다(`${ruleId}:${target}:${today}`) → 같은 날 같은 이슈는 한 번만 생긴다(ON CONFLICT DO NOTHING).
 *  - 이미 있는 이슈의 운영자 처리 필드(상태 · 담당 · 메모 · SLA 기록 · 타임라인)는 절대 덮어쓰지 않는다.
 *  - 자동 해결하지 않는다: 같은 날 열려 있던 감지 이슈가 이번에 안 잡히면 doc.stillDetected=false + 타임라인 한 줄(한 번만).
 *  - 데이터가 없으면(빌더 예외 · 빈 Dataset) 오류 없이 끝내고 경고를 감지 실행 기록에 남긴다.
 *  - 테스트 데이터(Dataset.meta.mode demo, 또는 mixed에서 그 매체의 출처가 전부 demo)로 감지한 이슈는 isTest=true —
 *    알림은 'test' 이벤트를 켠 채널로만 가고(TEST DATA 표기), 성과 증명 집계에서 빠진다. 엔진은 데이터 출처를 모르므로 서버가 정한다.
 */
import type { ChangeRequest, Dataset, DatasetMeta } from '@/core/types';
import { activeConfig, detectIncidents, msToKstIso, type AlertIncident } from '@/modules/alert/engine';
import { DEMO_CREATIVES, type CreativeReview } from '@/modules/alert/data';
import { withWorkspaceConfig } from '@/data/config';
import type { Db, Queryable } from '../db/pool';
import { loadWorkspaceConfig } from '../settings/service';
import { publish } from '../events/hub';
import { audit } from '../audit/audit';
import { nowMs } from '../lib/time';
import { deps } from './deps';
import { fanOutIncident } from './deliver';
import { insertIncident, normImpact, saveIncident, type StoredIncident } from './incidents';

export interface ScanResult {
  found: number;
  created: number;
  cleared: number;
  redetected: number;
  notified: number;
  createdIds: string[];
  warning?: string;
  dataToday?: string;
}

/** 반영된 탐지 기준 변경(alert_rule)만 읽어 엔진 설정으로 (change_requests는 changes 도메인 소유 — 읽기만) */
async function appliedRuleChanges(q: Queryable, wsId: string): Promise<ChangeRequest[]> {
  const r = await q.query<{ id: string; target_id: string | null; after: unknown; created_at: Date; target: string }>(
    `SELECT id, target, target_id, after, created_at FROM change_requests
      WHERE workspace_id = $1 AND kind = 'alert_rule' AND status = 'applied' ORDER BY created_at`,
    [wsId],
  );
  return r.rows.map((c) => ({
    id: c.id, createdAt: new Date(c.created_at).toISOString(), module: 'alert', kind: 'alert_rule', target: c.target, targetId: c.target_id ?? undefined,
    before: '', after: typeof c.after === 'number' || typeof c.after === 'string' ? c.after : JSON.stringify(c.after ?? ''), reason: '', requestedBy: '', approver: 'PM', status: 'applied', history: [],
  }));
}

function emptyDataset(d: Dataset | null | undefined): string | null {
  if (!d || !d.today) return '수집된 데이터가 없어 감지를 건너뛰었습니다 (데이터 연결 · 수집 상태 확인)';
  if (!d.mediaHourly?.length && !d.mediaDaily?.length && !d.salesDaily?.length) return `기준일 ${d.today} 데이터가 비어 있어 감지를 건너뛰었습니다`;
  return null;
}

/**
 * 감지 이슈가 테스트 데이터에서 나왔는지: 메타가 없거나 demo → true, live → false,
 * mixed → 그 이슈 매체(채널)의 사용 출처가 있고 전부 demo면 true (매체를 모르면 실데이터로 본다 — 실제 알림을 막지 않도록).
 */
export function isTestData(meta: DatasetMeta | undefined, media: string | undefined): boolean {
  if (!meta || meta.mode === 'demo') return true;
  if (meta.mode === 'live') return false;
  if (!media) return false;
  const used = (meta.sources ?? []).filter((x) => x.channel === media);
  return used.length > 0 && used.every((x) => x.kind === 'demo');
}

async function recordRun(db: Queryable, wsId: string, trigger: string, t: { at: number; t0: number }, r: Partial<ScanResult> & { status: 'ok' | 'warning' | 'failed'; dataHour?: number; dataMode?: string }) {
  await db.query(
    `INSERT INTO alert_scan_runs (workspace_id, trigger, status, found, created, cleared, notified, data_today, data_hour, data_mode, warning, duration_ms, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [wsId, trigger.slice(0, 40), r.status, r.found ?? 0, r.created ?? 0, r.cleared ?? 0, r.notified ?? 0, r.dataToday ?? null, r.dataHour ?? null, r.dataMode ?? null,
      r.warning?.slice(0, 1000) ?? null, Math.max(0, Date.now() - t.t0), new Date(t.at), new Date(nowMs())],
  );
  // 감지 실행 기록은 30일 보관
  await db.query(`DELETE FROM alert_scan_runs WHERE workspace_id = $1 AND started_at < $2`, [wsId, new Date(nowMs() - 30 * 86_400_000)]);
}

export async function scanWorkspace(db: Db, wsId: string, opts: { trigger?: string; actor?: string } = {}): Promise<ScanResult> {
  const trigger = opts.trigger ?? 'job';
  const started = { at: nowMs(), t0: Date.now() };
  const empty: ScanResult = { found: 0, created: 0, cleared: 0, redetected: 0, notified: 0, createdIds: [] };

  let data: Dataset;
  try {
    data = await deps.buildDataset(db, wsId, {});
  } catch (e) {
    const warning = `데이터를 불러오지 못해 감지를 건너뛰었습니다 · ${((e as Error)?.message ?? String(e)).slice(0, 300)}`;
    await recordRun(db, wsId, trigger, started, { status: 'warning', warning });
    return { ...empty, warning };
  }
  const noData = emptyDataset(data);
  if (noData) {
    await recordRun(db, wsId, trigger, started, { status: 'warning', warning: noData, dataToday: data?.today });
    return { ...empty, warning: noData, dataToday: data?.today };
  }

  const result: ScanResult = { ...empty, dataToday: data.today };
  try {
    const cfg = await loadWorkspaceConfig(db, wsId);
    const changes = await appliedRuleChanges(db, wsId);
    // 소재 검수 상태: Dataset이 소재 목록(creatives)을 실어 오면 그것을, 데모 데이터면 데모 소재 목록을, 그 밖(실데이터)에는 빈 목록 —
    // 지금 웨어하우스는 소재 검수 상태를 수집하지 않으므로 실데이터에서는 소재 이슈를 만들지 않는다(지어낸 소재 이슈 방지).
    const isDemo = !data.meta || data.meta.mode === 'demo';
    const collected = (data as Dataset & { creatives?: CreativeReview[] }).creatives;
    const creatives = Array.isArray(collected) ? collected : isDemo ? DEMO_CREATIVES : [];
    const offHours = (cfg as { offHoursMode?: unknown }).offHoursMode === true;
    const found: AlertIncident[] = withWorkspaceConfig(cfg, () => detectIncidents(data, { config: activeConfig(changes), creatives, offHours }));

    const at = msToKstIso(nowMs());
    const foundIds = new Set(found.map((f) => f.id));
    result.found = found.length;
    const toNotify: StoredIncident[] = [];

    await db.tx(async (q) => {
      for (const f of found) {
        // 감지 시각 = 서버가 실제로 잡은 시각 (SLA 기준점). 데이터 기준 시각은 dataAsOf로 따로 보관.
        const doc: StoredIncident = {
          ...f,
          impact: normImpact(f.impact),
          detectedAt: at,
          timeline: f.timeline.map((t, k) => (k === 0 ? { ...t, at } : t)),
          source: 'scan', dataDate: data.today, dataAsOf: data.generatedAt, stillDetected: true, dataMode: data.meta?.mode ?? 'demo',
          isTest: f.isTest || isTestData(data.meta, f.media),
          notifiedAt: at,
        };
        if (await insertIncident(q, wsId, doc)) {
          result.created++;
          result.createdIds.push(doc.id);
          toNotify.push(doc);
        }
      }
      // 같은 날 감지 이슈 중 열려 있는 것: 이번에 안 잡힘 → stillDetected=false(한 번만 기록), 다시 잡힘 → true
      const openRows = (await q.query<{ id: string; doc: StoredIncident; status: StoredIncident['status'] }>(
        `SELECT id, doc, status FROM incidents
          WHERE workspace_id = $1 AND status <> 'resolved' AND doc->>'source' = 'scan' AND doc->>'dataDate' = $2 ORDER BY id FOR UPDATE`,
        [wsId, data.today],
      )).rows;
      for (const row of openRows) {
        const doc = { ...row.doc, id: row.id, status: row.status } as StoredIncident;
        const seen = foundIds.has(row.id);
        if (!seen && doc.stillDetected !== false) {
          doc.stillDetected = false;
          doc.clearedAt = at;
          doc.timeline = [...(doc.timeline ?? []), { at, by: 'MILDO Alert', action: '자동 확인: 최근 감지에서 더 이상 잡히지 않음 · 자동 해결하지 않음 (운영자 확인 후 해결 처리)' }];
          await saveIncident(q, wsId, doc);
          result.cleared++;
        } else if (seen && doc.stillDetected === false && !result.createdIds.includes(row.id)) {
          doc.stillDetected = true;
          delete doc.clearedAt;
          doc.timeline = [...(doc.timeline ?? []), { at, by: 'MILDO Alert', action: '자동 확인: 다시 감지됨' }];
          await saveIncident(q, wsId, doc);
          result.redetected++;
        }
      }
      for (const inc of toNotify) {
        const r = await fanOutIncident(q, wsId, { event: 'incident', incident: inc });
        result.notified += r.enqueued;
      }
      if (result.created || result.cleared || result.redetected) {
        await audit(q, {
          workspaceId: wsId, actor: opts.actor ?? 'MILDO Alert', action: 'incident.scan', targetType: 'incident',
          detail: { trigger, found: result.found, created: result.created, cleared: result.cleared, redetected: result.redetected, createdIds: result.createdIds.slice(0, 50) },
        });
      }
      // 이벤트는 커밋 시점에 전달된다 (NOTIFY in tx)
      const touched = result.createdIds.length + result.cleared + result.redetected;
      if (touched > 0 && result.createdIds.length <= 20) for (const id of result.createdIds) await publish(q, wsId, { type: 'incident', id });
      if (touched > 0 && (result.createdIds.length > 20 || result.cleared || result.redetected)) await publish(q, wsId, { type: 'incident' });
    });
  } catch (e) {
    // 탐지 · 저장 실패: 감지 기록에 'failed'로 남기고(화면 '24시간 감지 기록') 잡 재시도를 위해 다시 던진다 — 트랜잭션은 롤백되어 이슈 · 알림이 반쯤 남지 않는다
    const warning = `감지 실패 · ${((e as Error)?.message ?? String(e)).slice(0, 300)}`;
    await recordRun(db, wsId, trigger, started, { status: 'failed', warning, dataToday: data.today, dataHour: data.currentHour, dataMode: data.meta?.mode ?? 'demo' }).catch(() => undefined);
    throw e;
  }

  await recordRun(db, wsId, trigger, started, { status: 'ok', ...result, dataHour: data.currentHour, dataMode: data.meta?.mode ?? 'demo' });
  return result;
}
