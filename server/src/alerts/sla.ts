/**
 * SLA 타이머 (alerts.sla, 1분마다) — 제안서 p.49 등급별 목표: P1 인지 15분 · 1차 조치 30분 · 결과 2시간, P2 1시간 · 4시간 · 당일, P3 1일 · 협의 · 주간.
 * 주말 · 공휴일(또는 당번 배정 이슈)은 인지 30분 (p.48). 기한 계산은 MILDO Alert 엔진(slaTargets)을 그대로 쓴다.
 *
 * 단계 기한이 지났는데 그 단계 처리가 없으면: 타임라인 '에스컬레이션: <단계> 기한 초과' + 'sla' 이벤트 알림(백업 · PM 채널) — 단계마다 한 번만
 * (doc.escalations에 기록). 담당이 비어 있으면 당번표(regimeOf · onDutyFor)로 채운다. 운영자가 정한 담당은 바꾸지 않는다.
 * 같은 잡에서 intakeSweep이 다른 도메인이 직접 넣은 이슈(대량 변경 등)에 '새 이슈' 알림을 한 번 보낸다.
 */
import { fmtStamp, msToKstIso, regimeOf, withDeliveryNote } from '@/modules/alert/engine';
import { withWorkspaceConfig } from '@/data/config';
import type { Db } from '../db/pool';
import { loadWorkspaceConfig } from '../settings/service';
import { publish } from '../events/hub';
import { audit } from '../audit/audit';
import { nowMs, kstToday } from '../lib/time';
import { fanOutIncident } from './deliver';
import { getIncident, rosterAssignment, rowToIncident, saveIncident, type EscStage, type StoredIncident } from './incidents';
import { slaDeadlines, stageLabel } from './messages';

export interface DueEscalation { stage: EscStage; label: string; target: string; deadlineMs: number }

/** 기한이 지났고 아직 처리 · 에스컬레이션되지 않은 단계 */
export function dueEscalations(inc: StoredIncident, now = nowMs()): DueEscalation[] {
  if (inc.status === 'resolved') return [];
  const sla = inc.sla ?? {};
  const done: Record<EscStage, boolean> = {
    ack: inc.status !== 'open' || !!sla.ackAt,
    action: inc.status === 'action' || !!sla.actionAt,
    report: !!sla.reportAt,
  };
  return slaDeadlines(inc)
    .filter((d) => now > d.deadlineMs && !done[d.stage] && !inc.escalations?.[d.stage])
    .map((d) => ({ stage: d.stage, label: d.label, target: d.target, deadlineMs: d.deadlineMs }));
}

export interface SlaSweepResult { checked: number; escalated: { id: string; stage: EscStage }[]; notified: number; errors: { id: string; error: string }[] }

interface OpenRow { id: string; status: StoredIncident['status']; severity: StoredIncident['severity']; rule_id: string; doc: StoredIncident; detected_at: Date; resolved_at: Date | null }

/**
 * 1분마다: 열린 이슈의 단계 기한을 먼저 잠금 없이 계산하고, 기한이 지난 이슈만 행 잠금 후 다시 판정해 기록한다.
 * 이슈 하나가 실패해도(깨진 문서 등) 나머지는 계속 처리하고 실패는 결과(errors)에 남긴다 — 한 건 때문에 워크스페이스 전체 에스컬레이션이 멈추지 않게.
 */
export async function slaSweep(db: Db, wsId: string): Promise<SlaSweepResult> {
  const now = nowMs();
  const rows = (await db.query<OpenRow>(
    `SELECT id, status, severity, rule_id, doc, detected_at, resolved_at FROM incidents WHERE workspace_id = $1 AND status <> 'resolved' ORDER BY detected_at LIMIT 2000`,
    [wsId],
  )).rows;
  const out: SlaSweepResult = { checked: rows.length, escalated: [], notified: 0, errors: [] };
  // SLA 목표 · 당번표는 워크스페이스 설정(settings)이 덮어쓸 수 있다 — 계산은 설정을 적용한 동기 구간 안에서
  const cfg = await loadWorkspaceConfig(db, wsId);
  const forcedOff = (cfg as { offHoursMode?: unknown }).offHoursMode === true;
  const regime = withWorkspaceConfig(cfg, () => regimeOf(kstToday(now), forcedOff));
  const candidates = rows.filter((r) => {
    try {
      return withWorkspaceConfig(cfg, () => dueEscalations(rowToIncident(r), now)).length > 0;
    } catch (e) {
      out.errors.push({ id: r.id, error: ((e as Error)?.message ?? String(e)).slice(0, 200) });
      return false;
    }
  });
  for (const { id } of candidates) {
    try {
      await db.tx(async (q) => {
        // 다른 워커 · 운영자 처리와 겹치지 않게 행 잠금 후 다시 판정
        const locked = await q.query<{ id: string }>(`SELECT id FROM incidents WHERE workspace_id = $1 AND id = $2 FOR UPDATE SKIP LOCKED`, [wsId, id]);
        if (!locked.rowCount) return;
        const inc = await getIncident(q, wsId, id);
        if (!inc) return;
        const due = withWorkspaceConfig(cfg, () => dueEscalations(inc, now));
        if (!due.length) return;
        const at = msToKstIso(now);
        const doc: StoredIncident = { ...inc, timeline: [...(inc.timeline ?? [])], escalations: { ...(inc.escalations ?? {}) } };
        if (!doc.assignee) Object.assign(doc, withWorkspaceConfig(cfg, () => rosterAssignment(doc, kstToday(now), forcedOff)));
        const duty = regime.off && regime.duty ? ` · ${regime.label} 당번 ${regime.duty.role} (백업 ${regime.duty.backup})` : '';
        for (const d of due) {
          doc.timeline.push({
            at, by: 'MILDO Alert',
            action: `에스컬레이션: ${d.label} 기한 초과 (목표 ${d.target} · 기한 ${fmtStamp(d.deadlineMs)}) → 백업 ${doc.backup ?? '담당'} · 총괄 PM 알림${duty}${doc.severity === 'P1' ? ' · P1 브랜드 담당자 연락' : ''}`,
          });
          doc.escalations![d.stage] = { at, deadline: msToKstIso(d.deadlineMs), notified: 0 };
        }
        const escalated: { id: string; stage: EscStage }[] = [];
        let notified = 0;
        for (const d of due) {
          const r = await fanOutIncident(q, wsId, { event: 'sla', incident: doc, stage: d.stage });
          doc.escalations![d.stage]!.notified = r.enqueued;
          notified += r.enqueued;
          escalated.push({ id, stage: d.stage });
        }
        await saveIncident(q, wsId, doc);
        await audit(q, {
          workspaceId: wsId, actor: 'MILDO Alert', action: 'incident.escalate', targetType: 'incident', targetId: id,
          detail: { stages: due.map((d) => d.stage), severity: doc.severity, deadlines: due.map((d) => msToKstIso(d.deadlineMs)), backup: doc.backup ?? null, onDuty: regime.off, notified },
        });
        await publish(q, wsId, { type: 'incident', id });
        // 커밋된 뒤에만 결과에 더한다
        out.escalated.push(...escalated);
        out.notified += notified;
      });
    } catch (e) {
      out.errors.push({ id, error: ((e as Error)?.message ?? String(e)).slice(0, 200) });
    }
  }
  return out;
}

export interface IntakeResult { checked: number; notified: { id: string; enqueued: number }[]; errors: { id: string; error: string }[] }

/**
 * 다른 도메인이 incidents에 직접 넣은 이슈(docs/SAAS_SPEC.md §6 '다른 도메인 테이블에 직접 써야 할 때' — 예: changes의 대량 변경 bulk_change)는
 * 알림 경로를 거치지 않는다. 1분마다 그런 이슈(doc.source 없음 · doc.notifiedAt 없음 · 열림 · 최근 24시간 감지)를 찾아
 * 담당이 비어 있으면 당번표로 채우고 '새 이슈' 알림을 한 번 보낸다(notifiedAt 기록 → 다시 보내지 않음). 감지 · 수동 생성 이슈는 이미 알렸으므로 대상이 아니다.
 */
export async function intakeSweep(db: Db, wsId: string): Promise<IntakeResult> {
  const now = nowMs();
  const rows = (await db.query<{ id: string }>(
    `SELECT id FROM incidents
      WHERE workspace_id = $1 AND status <> 'resolved' AND doc->>'source' IS NULL AND doc->>'notifiedAt' IS NULL AND detected_at >= $2
      ORDER BY detected_at LIMIT 200`,
    [wsId, new Date(now - 24 * 3600_000)],
  )).rows;
  const out: IntakeResult = { checked: rows.length, notified: [], errors: [] };
  if (!rows.length) return out;
  const cfg = await loadWorkspaceConfig(db, wsId);
  const forcedOff = (cfg as { offHoursMode?: unknown }).offHoursMode === true;
  for (const { id } of rows) {
    try {
      await db.tx(async (q) => {
        const locked = await q.query<{ id: string }>(`SELECT id FROM incidents WHERE workspace_id = $1 AND id = $2 FOR UPDATE SKIP LOCKED`, [wsId, id]);
        if (!locked.rowCount) return;
        const inc = await getIncident(q, wsId, id);
        if (!inc || inc.status === 'resolved' || inc.notifiedAt || inc.source) return;
        const at = msToKstIso(now);
        const doc: StoredIncident = { ...inc, timeline: [...(inc.timeline ?? [])], notifiedAt: at };
        if (!doc.detectedAt || !Number.isFinite(Date.parse(doc.detectedAt))) doc.detectedAt = at;
        if (!doc.assignee) Object.assign(doc, withWorkspaceConfig(cfg, () => rosterAssignment(doc, kstToday(now), forcedOff)));
        const r = await fanOutIncident(q, wsId, { event: 'incident', incident: doc });
        // 다른 도메인이 넣은 이슈(일괄 변경 등)의 엔진 문구 '메신저 즉시 알림'을 실제 발송 요청 결과로 바꾼다
        Object.assign(doc, withDeliveryNote(doc, r));
        doc.timeline.push({ at, by: 'MILDO Alert', action: `알림 접수: 담당 ${doc.assignee ?? '—'} · 백업 ${doc.backup ?? '—'} · 알림 잡 ${r.enqueued}건` });
        await saveIncident(q, wsId, doc);
        await audit(q, {
          workspaceId: wsId, actor: 'MILDO Alert', action: 'incident.intake', targetType: 'incident', targetId: id,
          detail: { ruleId: doc.ruleId, severity: doc.severity, assignee: doc.assignee ?? null, enqueued: r.enqueued, skipped: r.skipped },
        });
        await publish(q, wsId, { type: 'incident', id });
        out.notified.push({ id, enqueued: r.enqueued });
      });
    } catch (e) {
      out.errors.push({ id, error: ((e as Error)?.message ?? String(e)).slice(0, 200) });
    }
  }
  return out;
}

export { stageLabel };
