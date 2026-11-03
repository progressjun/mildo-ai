/**
 * 매체 반영 실행 상태 표시 (서버 모드 — changes 도메인이 돌려주는 change.executing · change.execution).
 *  - executing          : 반영 · 롤백이 서버에서 진행 중 ('반영 중')
 *  - execution.mode     : dry_run = 매체 미반영 (보낼 요청만 기록) · live = 매체 API 호출 (성공 · 실패) · none = 기록만 (매체 API 대상 아님 · 커넥션 없음)
 * 데모 모드의 변경 요청에는 두 필드가 없다 → 표시하지 않는다 (데모 화면은 지금과 같다). React 없음 — 단위 테스트 대상.
 */
import type { ChangeExecution, ChangeRequest } from '@/core/types';

export type ExecPhase = 'apply' | 'retry' | 'rollback';

/** 서버 실행 기록 (src/core/types ChangeExecution + changes 도메인 표시 필드 — 모두 선택) */
export interface ServerExecutionView extends ChangeExecution {
  phase?: ExecPhase;
  note?: string;
  reason?: string;
  appliedValue?: string | number;
  checks?: { blocks?: string[]; warnings?: string[]; passes?: string[] };
  /** 반영에 쓴 커넥터가 모두 실계정 호출로 검증됐는지 (changes 도메인) — false면 '실계정 연결 전 확인 필요' (docs/SAAS_SPEC.md §0) */
  verifiedLive?: boolean;
}

/** 변경 요청 + 서버 표시 필드 (GET /changes · PATCH 응답) */
export type ServerChangeView = ChangeRequest & {
  execution?: ServerExecutionView;
  executing?: { phase?: ExecPhase; since?: string; background?: boolean };
};

export type ExecStateKind = 'executing' | 'live' | 'live_failed' | 'dry_run' | 'none';
export interface ExecState {
  kind: ExecStateKind;
  label: string;
  tone: 'accent' | 'good' | 'critical' | 'warning' | 'neutral';
  icon: string;
  /** 판정 근거 (툴팁 · 상세) */
  basis: string;
  /** 커넥터가 실계정 호출로 검증되지 않았다 (execution.verifiedLive === false) — 결과 옆에 '실계정 연결 전 확인 필요' */
  unverified?: boolean;
}

/** 실계정 미검증 커넥터 표시 문구 · 근거 */
export const UNVERIFIED_LABEL = '실계정 연결 전 확인 필요';
export const UNVERIFIED_BASIS = '이 매체 커넥터는 공식 API 문서대로 구현했지만 아직 실계정 호출로 검증하지 않았습니다 (verifiedLive=false). 매체 관리 화면에서 반영 결과를 직접 확인해 주세요';

const PHASE_LABEL: Record<ExecPhase, string> = { apply: '반영', retry: '반영 재시도', rollback: '롤백' };

export const PROVIDER_LABEL: Record<string, string> = {
  naver_sa: '네이버 검색광고', google_ads: 'Google Ads', meta: 'Meta', kakao_moment: '카카오모먼트', naver_gfa: '네이버 GFA',
  naver_commerce: '네이버 커머스', coupang: '쿠팡', cafe24: '카페24', ohouse: '오늘의집', demo: '데모 커넥터',
};
export const providerLabel = (p?: string | null): string => (p ? PROVIDER_LABEL[p] ?? p : '');

export function phaseLabel(p?: ExecPhase | null): string {
  return p ? PHASE_LABEL[p] ?? p : '반영';
}

/** ISO → 'M/D HH:mm' (KST, 브라우저 시간대와 무관) */
export function kstStamp(iso?: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const k = new Date(ms + 9 * 3600_000);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

/** 표시할 실행 상태 — 서버 실행 정보가 없으면 null (데모 모드 · 아직 반영 시도 전) */
export function executionState(c: Pick<ServerChangeView, 'executing' | 'execution'>): ExecState | null {
  const ing = c.executing;
  if (ing) {
    const since = kstStamp(ing.since);
    return {
      kind: 'executing', label: '반영 중', tone: 'accent', icon: 'refresh',
      basis: `${phaseLabel(ing.phase)} 진행 중${since ? ` · ${since} 시작` : ''}${ing.background ? ' · 응답 시간(20초)을 넘겨 서버가 백그라운드에서 마무리합니다' : ''} · 끝나면 화면이 자동으로 갱신됩니다`,
    };
  }
  const ex = c.execution;
  if (!ex || (ex.mode !== 'dry_run' && ex.mode !== 'live' && ex.mode !== 'none')) return null;
  // 서버가 명시적으로 false라고 한 경우만 (필드가 없으면 판단하지 않는다)
  const unverified = ex.verifiedLive === false;
  const who = providerLabel(ex.provider);
  const at = kstStamp(ex.at);
  const tail = [who, at ? `${at} 기록` : '', ex.phase && ex.phase !== 'apply' ? phaseLabel(ex.phase) : ''].filter(Boolean).join(' · ');
  if (ex.mode === 'dry_run') {
    return {
      kind: 'dry_run', label: '매체 미반영 (dry-run 기록)', tone: 'warning', icon: 'pause',
      basis: `커넥션 쓰기 모드가 dry_run이라 매체 API를 호출하지 않고 보낼 요청만 기록했습니다${tail ? ` · ${tail}` : ''}. 매체에 실제로 반영하려면 관리자가 데이터 연결에서 live를 켭니다${unverified ? ` · 요청 형식은 공식 문서 기준이며 ${UNVERIFIED_LABEL}` : ''}`,
      unverified,
    };
  }
  if (ex.mode === 'live') {
    const note = unverified ? ` · ${UNVERIFIED_LABEL}: ${UNVERIFIED_BASIS}` : '';
    return ex.ok
      ? { kind: 'live', label: '매체 반영됨', tone: 'good', icon: 'check', basis: `매체 API 호출 성공${ex.appliedValue !== undefined && ex.appliedValue !== '' ? ` · 반영 값 ${ex.appliedValue}` : ''}${tail ? ` · ${tail}` : ''}${note}`, unverified }
      : { kind: 'live_failed', label: '매체 반영 실패', tone: 'critical', icon: 'x', basis: `매체 API 호출 실패${ex.error ? ` · ${ex.error}` : ''}${tail ? ` · ${tail}` : ''}${note}`, unverified };
  }
  return {
    kind: 'none', label: '기록만', tone: 'neutral', icon: 'sparkle',
    basis: `${ex.reason ?? ex.note ?? '매체 API로 반영하는 유형이 아니거나 연결된 쓰기 커넥션이 없어 상태만 기록했습니다'}${tail ? ` · ${tail}` : ''}`,
  };
}

/** CSV 열 '매체반영' 값 — 라벨 + 실계정 미검증 표시 (실행 정보가 없으면 빈 칸) */
export function execCsvLabel(c: Pick<ServerChangeView, 'executing' | 'execution'>): string {
  const s = executionState(c);
  if (!s) return '';
  return s.unverified && s.kind !== 'dry_run' ? `${s.label} · ${UNVERIFIED_LABEL}` : s.label;
}

/** 반영 · 롤백이 진행 중이면 다른 처리를 막는다 (서버도 409 executing으로 거절) */
export function isExecuting(c: ServerChangeView): boolean {
  return !!c.executing;
}

/** 실행 요청 요약을 사람이 읽는 JSON으로 (비밀값은 서버가 이미 제외) — 너무 길면 자른다 */
export function requestPreview(v: unknown, max = 1600): string | null {
  if (v === undefined || v === null || v === '') return null;
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { return null; }
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max}자 생략)` : s;
}

/** GET /api/w/:ws/changes/:id/executions 의 한 행 */
export interface ExecutionAttempt {
  id: string | number;
  attemptId?: string | null;
  phase?: ExecPhase | string | null;
  mode: 'dry_run' | 'live' | 'none' | string;
  ok: boolean;
  provider?: string | null;
  targetExternalId?: string | null;
  request?: unknown;
  error?: string | null;
  appliedValue?: string | number | null;
  actor?: string | null;
  startedAt?: string;
  finishedAt?: string;
}

const MODE_SHORT: Record<string, string> = { dry_run: 'dry-run 기록', live: '매체 호출', none: '기록만' };

/** 시도 한 줄 요약: '11/2 14:05 · 반영 · dry-run 기록 · 네이버 검색광고 · 대상 nkw-1 · 김PM' */
export function attemptLine(a: ExecutionAttempt): { text: string; tone: ExecState['tone'] } {
  const parts = [
    kstStamp(a.finishedAt ?? a.startedAt),
    phaseLabel((a.phase as ExecPhase) ?? 'apply'),
    `${MODE_SHORT[a.mode] ?? a.mode}${a.mode === 'live' ? (a.ok ? ' 성공' : ' 실패') : ''}`,
    providerLabel(a.provider),
    a.targetExternalId ? `대상 ${a.targetExternalId}` : '',
    a.actor ?? '',
  ].filter(Boolean);
  const tone: ExecState['tone'] = a.mode === 'dry_run' ? 'warning' : a.mode === 'live' ? (a.ok ? 'good' : 'critical') : 'neutral';
  return { text: parts.join(' · ') + (a.error ? ` · ${a.error}` : ''), tone };
}
