/**
 * MILDO Watch 화면 상태 훅 — 스토어(state.data · changes · incidents) + 모듈 진행 기록 + 데이터 기준 시계.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useActions, useStore } from '@/core/store';
import { computeWatch, type WatchSnapshot } from './briefs';
import { advanceProgress, competitorIncident, fmtKst, kstIso, testChangePayload, type ArchiveRow, type EvaluatedEvent, type StepAction } from './engine';
import { getWatchStore, resetWatchStore, setWatchStore, subscribeWatchStore } from './progress';

const SESSION_START = Date.now();

/** 데이터 기준 시각(generatedAt)에서 시작해 실제 경과 시간만큼 흐르는 시계 — 표시 · 기한 계산 전용 */
export function useDataClock(generatedAt: string, tickMs = 30_000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  const base = Date.parse(generatedAt);
  return (Number.isFinite(base) ? base : 0) + (Date.now() - SESSION_START);
}

/** 기록 시각(ISO) → 표시 문자열. 실제 시각(…Z)으로 남은 기록은 세션 경과로 데이터 시계에 맞춘다 */
export function fmtLogAt(iso: string, generatedAt: string): string {
  if (!iso) return '—';
  const ms = iso.endsWith('Z') ? Date.parse(generatedAt) + (Date.parse(iso) - SESSION_START) : Date.parse(iso);
  return fmtKst(ms);
}

export interface WatchCtx extends WatchSnapshot {
  state: ReturnType<typeof useStore>['state'];
  actions: ReturnType<typeof useActions>;
  alerts: string[];
  /** 이번 주 브리프 담당 AE 코멘트 */
  aeNote: { text: string; by: string; at: string } | null;
  setAeNote: (text: string) => void;
  advance: (ev: EvaluatedEvent, action: StepAction, note?: string) => void;
  close: (ev: EvaluatedEvent, note?: string) => void;
  createAlert: (row: ArchiveRow) => void;
  alertExists: (row: ArchiveRow) => boolean;
  reset: () => void;
  byId: (id: string) => EvaluatedEvent | undefined;
}

export function useWatch(): WatchCtx {
  const { state } = useStore();
  const actions = useActions();
  const store = useSyncExternalStore(subscribeWatchStore, getWatchStore, getWatchStore);
  const nowMs = useDataClock(state.data.generatedAt);
  const minute = Math.floor(nowMs / 60_000);
  const snap = useMemo(
    () => computeWatch(state.data, { changes: state.changes, overrides: store.progress, nowMs }),
    // 1분 단위로만 재계산 (기한 표시용)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.data, state.changes, store.progress, minute],
  );
  const by = state.role;
  const at = () => kstIso(nowMs);

  const advance = (ev: EvaluatedEvent, action: StepAction, note?: string) => {
    // 버튼이 비활성인 단계(보류 · 진행 중 테스트)는 어떤 경로로 호출돼도 진행하지 않는다
    if (ev.next.disabled || ev.next.action !== action) {
      actions.toast({ tone: 'warning', title: `${ev.next.label} 보류`, body: ev.next.disabled ?? '현재 단계에서 진행할 수 없는 작업입니다.' });
      return;
    }
    if (action === 'test') {
      const ch = actions.addChange(testChangePayload(ev, by));
      setWatchStore((s) => ({ ...s, progress: advanceProgress(s.progress, ev, 'test', by, at(), { testStart: state.data.today, note: note ?? `${ch.id} · 승인 ${ev.design.approverLabel} 대기`, changes: state.changes }) }));
      actions.toast({ tone: 'info', title: 'MILDO Lab 테스트 등록 요청', body: `${ev.design.arms} · 일 ${Math.round(ev.design.perDay / 10_000)}만원 × ${ev.design.days}일 · 승인 ${ev.design.approverLabel} (MILDO Flow)`, route: 'flow' });
      return;
    }
    if (action === 'wrapup') {
      setWatchStore((s) => ({ ...s, progress: advanceProgress(s.progress, ev, 'wrapup', by, at(), { note: note ?? `${ev.judge.label} — ${ev.judge.basis}`, wrapup: { verdict: ev.judge.verdict, label: ev.judge.label }, changes: state.changes }) }));
      actions.toast({ tone: ev.judge.verdict === 'expand' ? 'good' : 'info', title: `랩업 기록 · ${ev.judge.label}`, body: ev.title });
      return;
    }
    setWatchStore((s) => ({ ...s, progress: advanceProgress(s.progress, ev, action, by, at(), { note, changes: state.changes }) }));
    if (action === 'plan') actions.toast({ tone: 'info', title: '실행안 확정', body: `${snap.report.label}에 반영합니다 — ${ev.plan}` });
  };

  const close = (ev: EvaluatedEvent, note?: string) => {
    setWatchStore((s) => ({ ...s, progress: advanceProgress(s.progress, ev, 'close', by, at(), { note: note ?? `${ev.diag.label} — ${ev.diag.basis}`, changes: state.changes }) }));
  };

  const alertId = (row: ArchiveRow) => `watch_competitor:${row.id}:${state.data.today}`;
  const alertExists = (row: ArchiveRow) => state.incidents.some((i) => i.id === alertId(row));
  const createAlert = (row: ArchiveRow) => {
    if (alertExists(row)) {
      actions.toast({ tone: 'info', title: '이미 MILDO Alert에 등록된 이슈입니다', route: 'alert' });
      return;
    }
    // 감지 시각 = 데이터 기준 시계 (MILDO Alert SLA 타이머와 같은 시계) — 생성 버튼을 누른 시점부터 SLA가 흐른다
    const inc = competitorIncident(row, state.data, snap.cfg, nowMs);
    actions.addIncident(inc);
    setWatchStore((s) => ({ ...s, alerts: [...new Set([...s.alerts, inc.id])] }));
    actions.toast({ tone: 'warning', title: 'MILDO Alert P3 이슈 생성', body: `${inc.title} · 24시간 내 영향 분석 (p.44)`, route: 'alert' });
  };

  return {
    ...snap,
    state,
    actions,
    alerts: store.alerts,
    aeNote: store.aeNotes?.[snap.brief.period.from] ?? null,
    setAeNote: (text: string) => {
      const key = snap.brief.period.from;
      setWatchStore((s) => ({ ...s, aeNotes: { ...(s.aeNotes ?? {}), [key]: { text, by, at: fmtKst(nowMs) } } }));
    },
    advance,
    close,
    createAlert,
    alertExists,
    reset: () => {
      resetWatchStore();
      actions.toast({ tone: 'info', title: 'MILDO Watch 시연 상태를 처음으로 되돌렸습니다', body: 'Lab 등록 요청 · Alert 이슈는 각 화면 이력에 남습니다.' });
    },
    byId: (id: string) => snap.events.find((e) => e.id === id),
  };
}
