/**
 * 데이터 연결 화면 상태 — 서버 모드: API에서 카탈로그 · 커넥션 · 수집 실행 · 품질 · 업로드를 읽고, 수집 대기 · 실행 중이면 4초마다 다시 읽는다.
 * 다른 사용자 · 워커의 변경은 SSE 'connection' · 'dataset' 이벤트로 받아 0.4초 디바운스 뒤 다시 읽는다.
 * 데모 모드: 예시 상태(읽기 전용, TEST DATA).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSaas } from '@/saas/context';
import { ApiError } from '@/saas/api';
import { onServerEvent, type ServerEventData } from '@/saas/events';
import { useStore } from '@/core/store';
import type { Permission } from '@/core/permissions';
import type { CatalogProvider, ConnectionView, QualityItem, QualitySummary, RunView, UploadView } from './model';
import { qualityCounts } from './model';
import { exampleState } from './demoState';
import { connectionsApi, setSnapshot } from './client';

export interface ConnectionsState {
  mode: 'demo' | 'server' | 'checking';
  /** 서버 모드인데 로그인 · 워크스페이스가 없으면 false */
  ready: boolean;
  readOnly: boolean;
  workspaceId: string | null;
  can: (p: Permission) => boolean;
  catalog: CatalogProvider[];
  connections: ConnectionView[];
  runs: RunView[];
  nextBefore: string | null;
  quality: QualityItem[];
  qualitySummary: QualitySummary;
  uploads: UploadView[];
  loading: boolean;
  error: string | null;
  nowMs: number;
  today: string;
  refresh: () => Promise<void>;
  loadMoreRuns: () => Promise<void>;
  /** 응답의 connections로 바로 갱신 */
  setConnections: (c: ConnectionView[]) => void;
}

const POLL_MS = 4000;
const EVENT_DEBOUNCE_MS = 400;
/** 이 화면을 다시 읽게 하는 서버 이벤트 */
export const SERVER_EVENTS = ['connection', 'dataset'] as const;

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return (e as Error)?.message ?? '요청을 처리하지 못했습니다';
}

export function useConnections(): ConnectionsState {
  const saas = useSaas();
  const data = useStore().state.data;
  const server = saas.mode === 'server';
  const ws = saas.workspace?.id ?? null;
  const example = useMemo(() => exampleState(data), [data]);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [quality, setQuality] = useState<{ issues: QualityItem[]; summary: QualitySummary } | null>(null);
  const [uploads, setUploads] = useState<UploadView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!server || !ws) return;
    setLoading(true);
    try {
      const [cat, conns, rr, qq, ups] = await Promise.all([
        catalog.length ? Promise.resolve({ providers: catalog }) : connectionsApi.catalog(),
        connectionsApi.list(ws),
        connectionsApi.runs(ws, { limit: 50 }),
        connectionsApi.quality(ws),
        connectionsApi.uploads(ws),
      ]);
      if (!alive.current) return;
      setCatalog(cat.providers);
      setConnections(conns.connections);
      setRuns(rr.runs);
      setNextBefore(rr.nextBefore);
      setQuality(qq);
      setUploads(ups.uploads);
      setError(null);
      setNowMs(Date.now());
      setSnapshot({ workspaceId: ws, at: Date.now(), connections: conns.connections, runs: rr.runs, quality: qq });
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [server, ws, catalog]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, ws]);

  // SSE: 커넥션 추가 · 수정 · 수집 완료 · 업로드 가져오기(다른 사용자 · 워커) → 다시 읽기
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!server || !ws) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (e: ServerEventData) => {
      if (e.ws && e.ws !== ws) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void refreshRef.current(); }, EVENT_DEBOUNCE_MS);
    };
    const offs = SERVER_EVENTS.map((t) => onServerEvent(t, later));
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [server, ws]);

  // 수집 대기 · 실행 중이거나 업로드를 가져오는 중이면 짧게 다시 읽는다
  const busy = connections.some((c) => c.pendingJobs > 0) || runs.some((r) => r.status === 'running') || uploads.some((u) => u.status === 'received');
  useEffect(() => {
    if (!server || !ws || !busy) return;
    const id = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(id);
  }, [server, ws, busy, refresh, connections, runs, uploads]);

  const loadMoreRuns = useCallback(async () => {
    if (!server || !ws || !nextBefore) return;
    try {
      const r = await connectionsApi.runs(ws, { limit: 50, before: nextBefore });
      setRuns((prev) => [...prev, ...r.runs.filter((x) => !prev.some((p) => p.id === x.id))]);
      setNextBefore(r.nextBefore);
    } catch (e) {
      setError(errorText(e));
    }
  }, [server, ws, nextBefore]);

  if (!server) {
    const c = qualityCounts(example.quality);
    return {
      mode: saas.mode === 'checking' ? 'checking' : 'demo', ready: true, readOnly: true, workspaceId: null, can: () => false,
      catalog: example.catalog, connections: example.connections, runs: example.runs, nextBefore: null, quality: example.quality,
      qualitySummary: { ...c, connections: example.connections.length, checkedAt: new Date(example.nowMs).toISOString() },
      uploads: example.uploads, loading: false, error: null, nowMs: example.nowMs, today: data.today,
      refresh: async () => undefined, loadMoreRuns: async () => undefined, setConnections: () => undefined,
    };
  }
  return {
    mode: 'server', ready: !!ws, readOnly: false, workspaceId: ws, can: saas.can,
    catalog, connections, runs, nextBefore, quality: quality?.issues ?? [],
    qualitySummary: quality?.summary ?? { error: 0, warning: 0, info: 0, connections: connections.length, checkedAt: new Date(nowMs).toISOString() },
    uploads, loading, error, nowMs, today: data.today, refresh, loadMoreRuns, setConnections,
  };
}
