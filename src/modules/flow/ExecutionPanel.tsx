/* 매체 반영 실행 상태 (서버 모드) — 목록 배지 · 상세 패널. 서버 실행 정보가 없으면(데모 모드) 아무것도 그리지 않는다 */
import { useEffect, useState } from 'react';
import { Pill } from '@/ui/primitives';
import { useSaas } from '@/saas/context';
import { api, wsPath } from '@/saas/api';
import { attemptLine, executionState, kstStamp, modeLine, phaseLabel, providerLabel, requestPreview, UNVERIFIED_BASIS, UNVERIFIED_LABEL, type ExecutionAttempt, type ServerChangeView } from './execution';
import { KV } from './parts';

/** 목록 · 카드용 배지 — 판정 근거는 툴팁 */
export function ExecBadge({ c }: { c: ServerChangeView }) {
  const s = executionState(c);
  if (!s) return null;
  return (
    <span className="flow-exec" data-exec={s.kind}>
      <Pill tone={s.tone} icon={s.icon} title={s.basis}>{s.label}</Pill>
      {s.unverified && s.kind !== 'dry_run' ? <Pill tone="warning" icon="alert" title={UNVERIFIED_BASIS}>{UNVERIFIED_LABEL}</Pill> : null}
    </span>
  );
}

/** 상세 패널: 실행 방식 · 매체 · 시각 · 반영 값 · 점검 · 보낸(보낼) 요청 · 시도 기록 */
export function ExecutionPanel({ c }: { c: ServerChangeView }) {
  const saas = useSaas();
  const s = executionState(c);
  const ex = c.execution;
  const ws = saas.mode === 'server' ? saas.workspace?.id ?? null : null;
  const [attempts, setAttempts] = useState<ExecutionAttempt[] | null>(null);
  const [full, setFull] = useState<ServerChangeView['execution'] | null>(null);
  const stamp = `${ex?.at ?? ''}|${c.executing?.since ?? ''}|${c.status}`;

  // 서버 모드: 시도 기록 · 전체 실행 기록(목록 응답은 요약본)을 불러온다 — 실행 정보가 있는 건만
  useEffect(() => {
    if (!ws || !s) return undefined;
    let alive = true;
    const id = encodeURIComponent(c.id);
    api<{ executions?: ExecutionAttempt[] }>(wsPath(ws, `/changes/${id}/executions`), { silent: true })
      .then((r) => { if (alive) setAttempts(Array.isArray(r?.executions) ? r.executions : []); })
      .catch(() => { if (alive) setAttempts(null); });
    api<{ change?: ServerChangeView }>(wsPath(ws, `/changes/${id}`), { silent: true })
      .then((r) => { if (alive && r?.change?.execution) setFull(r.change.execution); })
      .catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, c.id, stamp]);

  if (!s) return null;
  const detail = full && full.at === ex?.at ? full : ex;
  const req = requestPreview(detail?.request);
  const checks = detail?.checks;
  return (
    <div className="stack-sm flow-exec-panel" data-exec={s.kind}>
      <div className="zone-label">매체 반영 · 서버 실행 기록</div>
      <div className="row" style={{ gap: 6 }}>
        <Pill tone={s.tone} icon={s.icon}>{s.label}</Pill>
        {s.unverified ? <Pill tone="warning" icon="alert" title={UNVERIFIED_BASIS}>{UNVERIFIED_LABEL}</Pill> : null}
      </div>
      <div className="xs ink2">{s.basis}</div>
      {c.executing ? (
        <KV k="진행" v={<>{phaseLabel(c.executing.phase)} · {kstStamp(c.executing.since)} 시작{c.executing.background ? ' · 서버 백그라운드 처리' : ''}</>} />
      ) : null}
      {detail ? (
        <>
          <KV k="실행 방식" v={modeLine(detail)} />
          {detail.provider ? <KV k="매체 커넥터" v={<>{providerLabel(detail.provider)}{detail.verifiedLive === false ? ` · ${UNVERIFIED_LABEL} (공식 문서 기준 구현 · 실계정 호출 미검증)` : detail.verifiedLive === true ? ' · 실계정 호출 검증됨' : ''}</>} /> : null}
          {detail.at ? <KV k="기록 시각" v={<span className="num">{kstStamp(detail.at)}</span>} /> : null}
          {detail.appliedValue !== undefined && detail.appliedValue !== '' ? <KV k="반영 값" v={<span className="num">{String(detail.appliedValue)}</span>} /> : null}
          {detail.error ? <KV k={s.kind === 'held' ? '보류 사유' : '오류'} v={<span style={{ color: 'var(--critical-ink)' }}>{detail.error}</span>} /> : null}
          {checks && ((checks.blocks?.length ?? 0) + (checks.warnings?.length ?? 0)) > 0 ? (
            <KV k="서버 점검" v={<span className="stack-sm" style={{ gap: 2 }}>{[...(checks.blocks ?? []), ...(checks.warnings ?? [])].map((t, k) => <span key={k} className="xs">{t}</span>)}</span>} />
          ) : null}
        </>
      ) : null}
      {req ? (
        <details className="flow-exec-req">
          <summary className="xs">{detail?.mode === 'dry_run' ? '보낼 요청 내용 (dry-run · 비밀값 제외)' : '보낸 요청 내용 (비밀값 제외)'}</summary>
          <pre className="flow-exec-pre">{req}</pre>
        </details>
      ) : null}
      {attempts && attempts.length ? (
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="xs muted">실행 시도 {attempts.length}건 (최근 순)</div>
          {attempts.slice(0, 6).map((a) => {
            const l = attemptLine(a);
            return <div key={String(a.id)} className={`xs flow-exec-attempt tone-${l.tone}`}>{l.text}</div>;
          })}
        </div>
      ) : null}
    </div>
  );
}
