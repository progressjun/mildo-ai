/**
 * MILDO Alert '알림 이력' — 서버 모드에서는 실제 발송 기록(GET /api/w/:ws/notify/log, 알림 설정 › 발송 이력과 같은 원본)을 보여 준다.
 * 화면이 이슈 문서로 만든 알림 목록(engine notificationLog)은 데모 시뮬레이션이라, 서버 모드에서 쓰면 보내지 않은 메신저 발송을 '보냈다'고 표시하게 된다 (SAAS_SPEC §0).
 */
import { useCallback, useEffect, useState } from 'react';
import type { Incident, Severity } from '@/core/types';
import { onServerEvent } from '@/saas/events';
import { apiErrorMessage } from '@/saas/sync';
import { fetchLog } from '@/modules/notify/api';
import type { LogEntry } from '@/modules/notify/model';

export type { LogEntry };

const EVENT_TEXT: Record<string, string> = { incident: '새 이슈', sla: 'SLA 기한 초과', resolved: '해결 공유', report: '리포트', test: '테스트 데이터 이슈', channel_test: '연결 테스트' };
const STATUS: Record<LogEntry['status'], { label: string; tone: 'good' | 'critical' | 'neutral' }> = {
  sent: { label: '발송', tone: 'good' }, failed: { label: '실패', tone: 'critical' }, skipped: { label: '보내지 않음', tone: 'neutral' },
};
const CHANNEL_TYPE: Record<string, string> = { slack: 'Slack', email: '이메일', webhook: '웹훅' };

export interface ServerLogRow {
  id: number;
  atMs: number;
  severity: Severity | null;
  event: string;
  channel: string;
  status: LogEntry['status'];
  statusLabel: string;
  tone: 'good' | 'critical' | 'neutral';
  title: string;
  reason: string;
  incidentId: string | null;
  isTest: boolean;
}

/** 발송 기록 → 표 행 (이슈 제목은 같은 id의 이슈에서 · 없으면 기록의 제목 · 메일 제목) */
export function serverLogRows(entries: readonly LogEntry[], incidents: readonly Pick<Incident, 'id' | 'title' | 'isTest'>[]): ServerLogRow[] {
  const byId = new Map(incidents.map((i) => [i.id, i]));
  return entries.map((e) => {
    const inc = e.refId ? byId.get(e.refId) : undefined;
    const st = STATUS[e.status] ?? { label: e.status, tone: 'neutral' as const };
    const stage = e.detail?.stage ? ` · ${e.detail.stage === 'ack' ? '인지' : e.detail.stage === 'action' ? '1차 조치' : e.detail.stage === 'report' ? '결과 보고' : e.detail.stage}` : '';
    return {
      id: e.id,
      atMs: Date.parse(e.at),
      severity: e.severity,
      event: `${EVENT_TEXT[e.event] ?? e.event}${stage}`,
      channel: `${e.channelName}${e.channelType ? ` · ${CHANNEL_TYPE[e.channelType] ?? e.channelType}` : ''}`,
      status: e.status,
      statusLabel: e.attempts > 1 ? `${st.label} · ${e.attempts}회 시도` : st.label,
      tone: st.tone,
      title: inc?.title ?? e.detail?.title ?? e.detail?.subject ?? e.refId ?? '—',
      reason: [e.detail?.reason, e.detail?.retrying ? '재시도 예정' : ''].filter(Boolean).join(' · '),
      incidentId: inc ? inc.id : null,
      isTest: !!(e.detail?.isTest ?? inc?.isTest),
    };
  });
}

export function summarizeServerLog(rows: readonly ServerLogRow[]): { sent: number; failed: number; skipped: number } {
  return { sent: rows.filter((r) => r.status === 'sent').length, failed: rows.filter((r) => r.status === 'failed').length, skipped: rows.filter((r) => r.status === 'skipped').length };
}

export interface ServerLogState { entries: LogEntry[]; loading: boolean; error: string | null; reload: () => void }

/** 서버 발송 기록 (최근 100건) — 이슈 · 발송 결과 이벤트가 오면 다시 읽는다. ws가 null(데모)이면 아무것도 하지 않는다. */
export function useServerNotifyLog(ws: string | null, load: typeof fetchLog = fetchLog): ServerLogState {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(!!ws);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!ws) return;
    load(ws, { limit: 100 })
      .then((r) => { setEntries(r.entries); setError(null); })
      .catch((e) => setError(apiErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [ws, load]);
  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    reload();
    let t: ReturnType<typeof setTimeout> | null = null;
    const later = () => { if (t) clearTimeout(t); t = setTimeout(reload, 1200); };
    const offs = [onServerEvent('notify', later), onServerEvent('incident', later)];
    return () => { offs.forEach((off) => off()); if (t) clearTimeout(t); };
  }, [ws, reload]);
  return { entries, loading, error, reload };
}
