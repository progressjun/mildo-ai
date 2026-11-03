/**
 * SLA 타이머 (alerts.sla, 1분마다) — 제안서 p.49 등급별 목표: P1 인지 15분 · 1차 조치 30분 · 결과 2시간, P2 1시간 · 4시간 · 당일, P3 1일 · 협의 · 주간.
 * 주말 · 공휴일(또는 당번 배정 이슈)은 인지 30분 (p.48). 기한 계산은 MILDO Alert 엔진(slaTargets)을 그대로 쓴다.
 *
 * 단계 기한이 지났는데 그 단계 처리가 없으면: 타임라인 '에스컬레이션: <단계> 기한 초과' + 'sla' 이벤트 알림(백업 · PM 채널) — 단계마다 한 번만
 * (doc.escalations에 기록). 담당이 비어 있으면 당번표(regimeOf · onDutyFor)로 채운다. 운영자가 정한 담당은 바꾸지 않는다.
 */
import { fmtStamp, msToKstIso, regimeOf } from '@/modules/alert/engine';
import { withWorkspaceConfig } from '@/data/config';
import type { Db } from '../db/pool';
import { loadWorkspaceConfig } from '../settings/service';
import { publish } from '../events/hub';
import { audit } from '../audit/audit';
import { nowMs, kstToday } from '../lib/time';
import { fanOutIncident } from './deliver';
import { getIncident, rosterAssignment, saveIncident, type EscStage, type StoredIncident } from './incidents';
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

export interface SlaSweepResult { checked: number; escalated: { id: string; stage: EscStage }[]; notified: number }

export async function slaSweep(db: Db, wsId: string): Promise<SlaSweepResult> {
  const now = nowMs();
  const rows = (await db.query<{ id: string }>(`SELECT id FROM incidents WHERE workspace_id = $1 AND status <> 'resolved' ORDER BY detected_at LIMIT 2000`, [wsId])).rows;
  const out: SlaSweepResult = { checked: rows.length, escalated: [], notified: 0 };
  // SLA 목표 · 당번표는 워크스페이스 설정(settings)이 덮어쓸 수 있다 — 계산은 설정을 적용한 동기 구간 안에서
  const cfg = await loadWorkspaceConfig(db, wsId);
  const regime = withWorkspaceConfig(cfg, () => regimeOf(kstToday(now)));
  for (const { id } of rows) {
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
      if (!doc.assignee) Object.assign(doc, withWorkspaceConfig(cfg, () => rosterAssignment(doc, kstToday(now))));
      const duty = regime.off && regime.duty ? ` · ${regime.label} 당번 ${regime.duty.role} (백업 ${regime.duty.backup})` : '';
      for (const d of due) {
        doc.timeline.push({
          at, by: 'MILDO Alert',
          action: `에스컬레이션: ${d.label} 기한 초과 (목표 ${d.target} · 기한 ${fmtStamp(d.deadlineMs)}) → 백업 ${doc.backup ?? '담당'} · 총괄 PM 알림${duty}${doc.severity === 'P1' ? ' · P1 브랜드 담당자 연락' : ''}`,
        });
        doc.escalations![d.stage] = { at, deadline: msToKstIso(d.deadlineMs), notified: 0 };
      }
      await saveIncident(q, wsId, doc);
      for (const d of due) {
        const r = await fanOutIncident(q, wsId, { event: 'sla', incident: doc, stage: d.stage });
        doc.escalations![d.stage]!.notified = r.enqueued;
        out.notified += r.enqueued;
        out.escalated.push({ id, stage: d.stage });
      }
      await saveIncident(q, wsId, doc);
      await audit(q, {
        workspaceId: wsId, actor: 'MILDO Alert', action: 'incident.escalate', targetType: 'incident', targetId: id,
        detail: { stages: due.map((d) => d.stage), severity: doc.severity, deadlines: due.map((d) => msToKstIso(d.deadlineMs)), backup: doc.backup ?? null, onDuty: regime.off },
      });
      await publish(q, wsId, { type: 'incident', id });
    });
  }
  return out;
}

export { stageLabel };
