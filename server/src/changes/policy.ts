/**
 * 변경 요청 규칙 (순수 함수) — 상태 전이 · 권한 · 승인 주체 재판정 · 이력 문구.
 *
 * MILDO Flow 엔진(@/modules/flow/engine)과 같은 규칙을 쓴다:
 *   전이 표 = ACTIONS_BY_STATUS(대기 → 승인 · 반려 · 보류, 승인 → 반영 · 보류 · 실행 취소, 보류 → 보류 해제 · 반려, 반영 → 롤백),
 *   보류 해제 결과 = nextStatus(wasApproved ? 승인 : 승인 대기), 롤백 조건 = canRollback(같은 대상 · 유형의 최신 반영 건만),
 *   승인 주체 = delegationIndexByPct(±10% 이내 AE · ±30% 이내 PM · 초과 · 계산 불가 CLIENT).
 *
 * 화면(데모)과 의도적으로 다른 점 — 서버가 최종 판정:
 *   승인 범위는 데모 3역할(canAct)이 아니라 멤버십 권한표(approve:AE|PM|CLIENT, src/core/permissions.ts)로 본다.
 *     owner는 CLIENT 건까지 승인할 수 있다(§2 표). 데모 매핑에서는 owner가 'PM'으로 보인다.
 *   반영 · 재실행 · 롤백은 승인 권한에 더해 'operate'(운영) 권한이 있어야 한다 — 광고주 담당자(client)는 승인 · 반려까지만 하고,
 *     매체 반영은 대행사 운영 역할이 한다. CLIENT 등급 건의 반영 · 롤백은 approve:CLIENT + operate를 모두 가진 owner만 할 수 있다.
 *   보류 · 보류 해제는 'operate'만 있으면 된다(사고 대응은 승인 등급과 무관하게 막을 수 있어야 한다).
 *   보류 → 반영('재실행', AD Pilot 화면)을 허용한다 — 이전에 승인된 건만, 반영과 같은 점검 · 권한으로.
 *   보류 → 승인은 이전에 승인된 건만(승인 전 보류 건이 승인 없이 승인 상태가 되지 않게). 승인 전 보류 건의 해제는 승인 대기로.
 *   승인 주체 하한(approverFloor): 점검 기준 자체를 바꾸는 요청은 화면이 붙이는 승인 주체를 서버가 강제한다 —
 *     AD Pilot 기준(adpilot.cfg.<키>)은 항목별 승인 주체(CONFIG_FIELDS — 일 조정 폭 상한 · 목표 ROAS는 수면밀도),
 *     알림 · 탐지 기준(alert_rule)은 PM, 잔액 충전(…:topup)은 수면밀도, 자동 조정 보류 해제(alert:<이슈>:release)는 PM,
 *     전략 방향(flow:strategy)은 수면밀도. 담당 AE가 승인 주체를 AE로 보내 상한을 스스로 올리는 우회를 막는다.
 *   승인 주체 낮추기: PM 이상이면서 현재 승인 주체를 직접 승인할 수 있는 역할만(PM은 PM → AE, CLIENT 건은 소유자만).
 */
import type { ApprovalLevel, ChangeKind, ChangeRequest } from '@/core/types';
import { can, type Role } from '../auth/permissions';
import { APPROVER_LABEL, delegationIndexByPct, nextStatus, wasApproved, type FlowAction } from '@/modules/flow/engine';
import { CONFIG_FIELDS as ADPILOT_CONFIG_FIELDS, CONFIG_TARGET_PREFIX } from '@/modules/adpilot/engine';
import { GFA_DELEGATION } from '@/data/constants';
import type { ChangeStatus } from './model';

export type ServerAction = FlowAction | 'retry';

export const LEVEL_RANK: Record<ApprovalLevel, number> = { AE: 0, PM: 1, CLIENT: 2 };
export const maxLevel = (a: ApprovalLevel, b: ApprovalLevel): ApprovalLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: number) => Math.round(n * 10) / 10;
export function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ''));
  return NaN;
}

/* ------------------------------------------------------------------ */
/* 변경 폭 · 승인 주체                                                    */
/* ------------------------------------------------------------------ */

/** 반올림 차이 허용 폭 (%p) — GFA 일 예산은 만 원 단위로 반올림되어 요청 폭과 실제 폭이 조금 다르다 */
export const PCT_TOLERANCE = 1;

/**
 * 판정에 쓸 변경 폭: 클라이언트 changePct와 before → after 계산값을 대조한다.
 * 둘 다 있고 차이가 허용 폭 이내면 클라이언트 값, 넘으면 절대값이 큰 쪽(보수적으로).
 */
export function effectivePct(c: Pick<ChangeRequest, 'before' | 'after' | 'changePct'>): { pct: number; computed: number; mismatch: boolean } {
  const client = finite(c.changePct) ? c.changePct : NaN;
  const b = toNum(c.before), a = toNum(c.after);
  const computed = finite(b) && finite(a) && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : NaN;
  if (finite(client) && finite(computed)) {
    if (Math.abs(client - computed) <= PCT_TOLERANCE) return { pct: client, computed, mismatch: false };
    return { pct: Math.abs(computed) > Math.abs(client) ? computed : client, computed, mismatch: true };
  }
  if (finite(client)) return { pct: client, computed, mismatch: false };
  return { pct: computed, computed, mismatch: false };
}

export const isNewCampaign = (c: Pick<ChangeRequest, 'kind' | 'targetId'>) =>
  c.kind === 'gfa' || /^(flow|gfa):new:/.test(c.targetId ?? '');

export interface ApproverRoute {
  approver: ApprovalLevel;
  /** 저장할 변경 폭 (클라이언트 값이 없으면 계산값) */
  changePct: number | null;
  notes: string[];
}

/** 점검 기준 · 결제 · 전략을 바꾸는 요청의 최소 승인 주체 (화면이 붙이는 값과 같은 기준) */
export function approverFloor(c: Pick<ChangeRequest, 'kind' | 'targetId'>): { level: ApprovalLevel; basis: string } | null {
  const tid = (c.targetId ?? '').trim();
  if (tid.startsWith(CONFIG_TARGET_PREFIX)) {
    const key = tid.slice(CONFIG_TARGET_PREFIX.length);
    const f = ADPILOT_CONFIG_FIELDS.find((x) => x.key === key);
    const level = f?.approver ?? 'PM';
    return { level, basis: `AD Pilot 기준 '${f?.label ?? key}' 변경 → ${APPROVER_LABEL[level]} 승인 (p.14 · 사전 합의)` };
  }
  if (c.kind === 'alert_rule' || tid.startsWith('alert_rule:')) return { level: 'PM', basis: '알림 · 탐지 기준 변경 → PM 승인 (p.53)' };
  if (/^alert:.+:topup$/.test(tid)) return { level: 'CLIENT', basis: '잔액 충전 → 결제 수단 소유자(수면밀도) 승인 (p.50)' };
  if (/^alert:.+:release$/.test(tid)) return { level: 'PM', basis: '자동 조정 보류 해제 → PM 승인' };
  if (tid.startsWith('flow:strategy')) return { level: 'CLIENT', basis: '전략 방향 · 월 예산 재배분 → 수면밀도 승인 (p.53)' };
  return null;
}

/**
 * 서버 승인 주체 재판정 (p.15 위임 범위 — 워크스페이스 설정의 위임 범위가 적용된 상태에서 호출).
 * 예산(budget) · GFA 신규(gfa): 변경 폭으로 다시 계산. 신규 캠페인은 CLIENT. 클라이언트가 보낸 승인 주체보다 낮추지 않는다.
 */
export function routeApprover(c: Pick<ChangeRequest, 'kind' | 'targetId' | 'before' | 'after' | 'changePct' | 'approver'>): ApproverRoute {
  const notes: string[] = [];
  const e = effectivePct(c);
  let changePct: number | null = finite(c.changePct) ? c.changePct : finite(e.computed) ? round1(e.computed) : null;
  let required: ApprovalLevel = 'AE';
  // 요청 변경 폭과 값 기준 변경 폭이 허용 폭을 넘게 다르면 큰 쪽을 저장한다 (입찰 상한 · 대량 변경 감지가 작은 값에 속지 않게)
  if (e.mismatch) {
    notes.push(`변경 폭 대조: 요청 ${round1(c.changePct as number)}% · 값 기준 ${round1(e.computed)}% — 큰 쪽(${round1(e.pct)}%)으로 판정`);
    changePct = round1(e.pct);
  }
  if (isNewCampaign(c)) {
    required = 'CLIENT';
    if (LEVEL_RANK[c.approver] < LEVEL_RANK.CLIENT) notes.push(`신규 캠페인 → ${APPROVER_LABEL.CLIENT} 승인 (p.15 위임 범위)`);
  } else if (c.kind === 'budget') {
    const idx = delegationIndexByPct(e.pct);
    const row = GFA_DELEGATION[idx];
    required = row.approver;
    if (LEVEL_RANK[required] > LEVEL_RANK[c.approver]) {
      notes.push(finite(e.pct)
        ? `변경 폭 ${round1(e.pct)}% → ${row.range} (p.15 위임 범위) · 승인 주체 ${APPROVER_LABEL[c.approver]} → ${APPROVER_LABEL[required]}`
        : `변경 폭을 계산할 수 없어 최상위 승인(${APPROVER_LABEL.CLIENT})으로 보냅니다`);
    }
  }
  const floor = approverFloor(c);
  if (floor && LEVEL_RANK[floor.level] > LEVEL_RANK[required]) {
    required = floor.level;
    if (LEVEL_RANK[floor.level] > LEVEL_RANK[c.approver]) notes.push(`${floor.basis} · 승인 주체 ${APPROVER_LABEL[c.approver]} → ${APPROVER_LABEL[floor.level]}`);
  }
  return { approver: maxLevel(c.approver, required), changePct, notes };
}

/** 승인 주체를 낮출 수 있는 역할: PM 이상 + 현재 승인 주체를 직접 승인할 수 있음 (CLIENT 건을 PM이 PM 건으로 바꿔 스스로 승인하지 못하게) */
export function canLowerApprover(role: Role, current: ApprovalLevel): boolean {
  return PM_PLUS.includes(role) && can(role, approvePerm(current));
}

/**
 * 이력 메모의 문구: 상태를 바꾸지 않는 메모가 '반영' 이력처럼 읽히면(Flow appliedIso · canRollback 순서 판정이 이력 문구를 본다)
 * 반영 시각이 바뀌므로, 그런 문구는 '메모'로 남기고 원래 문구는 메모 내용 앞에 붙인다.
 */
const APPLY_LIKE = /반영(?!\s*보류)/;
export function noteEntryOf(label: string, note?: string): { action: string; note?: string } {
  const a = label.trim().slice(0, 60);
  const n = note?.trim() || undefined;
  if (APPLY_LIKE.test(a) || /^(일괄 )?(승인|반려)$/.test(a)) return { action: '메모', note: n ? `${a} — ${n}` : a };
  return { action: a, note: n };
}

/* ------------------------------------------------------------------ */
/* 상태 전이                                                            */
/* ------------------------------------------------------------------ */

/** 현재 상태 → 대상 상태 → 액션 (Flow ACTIONS_BY_STATUS + 서버 확장 '재실행') */
const TRANSITIONS: Record<ChangeStatus, Partial<Record<ChangeStatus, ServerAction>>> = {
  pending: { approved: 'approve', rejected: 'reject', held: 'hold' },
  approved: { applied: 'apply', held: 'hold', rejected: 'cancel' },
  held: { approved: 'resume', pending: 'resume', rejected: 'reject', applied: 'retry' },
  applied: { rolled_back: 'rollback' },
  rejected: {},
  rolled_back: {},
};

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  pending: '승인 대기', approved: '승인', applied: '반영', rejected: '반려', rolled_back: '롤백', held: '보류',
};

export const ACTION_LABEL: Record<ServerAction, string> = {
  approve: '승인', reject: '반려', hold: '보류', resume: '보류 해제', apply: '반영', retry: '재실행 · 반영', rollback: '롤백', cancel: '실행 취소',
};

/** 화면이 보내는 이력 문구 중 같은 전이로 인정하는 것 (그 밖의 문구는 기본 문구로 바꾼다) */
const ACCEPTED_LABELS: Record<ServerAction, string[]> = {
  approve: ['승인', '일괄 승인'],
  reject: ['반려', '일괄 반려', '실행 취소'],
  hold: ['보류', '실행 보류', '반영 보류'],
  resume: ['보류 해제'],
  apply: ['반영', '일괄 반영', '실행 · 반영'],
  retry: ['재실행 · 반영', '재실행'],
  rollback: ['롤백', '일괄 롤백'],
  cancel: ['실행 취소', '취소'],
};

const ACTION_KEYS = new Set<ServerAction>(['approve', 'reject', 'hold', 'resume', 'apply', 'retry', 'rollback', 'cancel']);

export function isActionKey(a: unknown): a is ServerAction {
  return typeof a === 'string' && ACTION_KEYS.has(a as ServerAction);
}

/** 이력 문구 → 액션 (모르면 null) */
export function actionOfLabel(label: string | undefined): ServerAction | null {
  if (!label) return null;
  const t = label.trim();
  if (isActionKey(t)) return t;
  for (const [a, ls] of Object.entries(ACCEPTED_LABELS) as [ServerAction, string[]][]) if (ls.includes(t)) return a;
  return null;
}

/** 이력에 남길 문구 — 화면 문구가 같은 전이를 뜻하면 그대로, 아니면 기본 문구 */
export function historyLabel(action: ServerAction, clientLabel?: string): string {
  const t = clientLabel?.trim();
  if (t && ACCEPTED_LABELS[action].includes(t)) return t;
  return ACTION_LABEL[action];
}

/** 패치 · 액션에서 대상 상태를 정한다 (patch.status 우선, 없으면 액션 키) */
export function targetStatusOf(c: Pick<ChangeRequest, 'history'> & { status: ChangeStatus }, patchStatus: ChangeStatus | undefined, action: string | undefined): ChangeStatus | null {
  if (patchStatus) return patchStatus;
  const a = actionOfLabel(action);
  if (!a) return null;
  if (a === 'retry') return 'applied';
  return nextStatus(c as ChangeRequest, a);
}

export interface TransitionResult {
  ok: boolean;
  action?: ServerAction;
  /** 409 사유 */
  reason?: string;
  code?: 'same_status' | 'invalid_transition' | 'not_approved_before';
}

export function resolveTransition(c: Pick<ChangeRequest, 'history'> & { status: ChangeStatus }, to: ChangeStatus): TransitionResult {
  if (c.status === to) return { ok: false, code: 'same_status', reason: `이미 ${STATUS_LABEL[to]} 상태입니다` };
  const action = TRANSITIONS[c.status]?.[to];
  if (!action) {
    const allowed = Object.keys(TRANSITIONS[c.status] ?? {}) as ChangeStatus[];
    return {
      ok: false, code: 'invalid_transition',
      reason: allowed.length
        ? `${STATUS_LABEL[c.status]} → ${STATUS_LABEL[to]}로 바꿀 수 없습니다 (가능: ${allowed.map((s) => STATUS_LABEL[s]).join(' · ')})`
        : `${STATUS_LABEL[c.status]} 상태는 종료 상태라 바꿀 수 없습니다 — 새 요청으로 다시 올려 주세요`,
    };
  }
  if (c.status === 'held' && (to === 'approved' || to === 'applied') && !wasApproved(c as ChangeRequest)) {
    return { ok: false, code: 'not_approved_before', reason: '승인 전에 보류된 건은 보류 해제 시 승인 대기로 돌아갑니다 — 승인 후 반영하세요' };
  }
  return { ok: true, action };
}

/* ------------------------------------------------------------------ */
/* 권한                                                                */
/* ------------------------------------------------------------------ */

const approvePerm = (lvl: ApprovalLevel) => `approve:${lvl}` as const;

export interface PermCheck { ok: boolean; reason: string }

/** 전이별 권한 (서버 최종 판정) */
export function checkActionPermission(role: Role, approver: ApprovalLevel, action: ServerAction): PermCheck {
  const lvl = APPROVER_LABEL[approver];
  const canApproveLvl = can(role, approvePerm(approver));
  const canOperate = can(role, 'operate');
  switch (action) {
    case 'approve':
    case 'reject':
    case 'cancel':
      return canApproveLvl
        ? { ok: true, reason: `${lvl} 승인 범위` }
        : { ok: false, reason: `${lvl} 승인 건 — 현재 역할에는 ${lvl} 승인 권한이 없습니다` };
    case 'hold':
    case 'resume':
      return canOperate
        ? { ok: true, reason: '운영 권한' }
        : { ok: false, reason: '보류 · 보류 해제는 운영 권한(담당 AE · PM · 관리자 · 소유자)이 필요합니다' };
    case 'apply':
    case 'retry':
    case 'rollback': {
      if (!canApproveLvl) return { ok: false, reason: `${lvl} 승인 건의 반영 · 롤백은 ${lvl} 승인 권한이 있는 운영 역할만 할 수 있습니다` };
      if (!canOperate) return { ok: false, reason: '매체 반영 · 롤백은 운영 권한(담당 AE · PM · 관리자 · 소유자)이 필요합니다 — 광고주 담당자는 승인 · 반려까지 합니다' };
      return { ok: true, reason: `${lvl} 승인 범위 · 운영 권한` };
    }
  }
}

const PM_PLUS: readonly Role[] = ['pm', 'admin', 'owner'];

/** 내용 수정: 승인 대기 상태에서 요청자 본인 또는 PM 이상만 */
export function checkEditPermission(role: Role, userId: string, c: { status: ChangeStatus; requested_by_user: string | null }): PermCheck {
  if (c.status !== 'pending') return { ok: false, reason: `내용 수정은 승인 대기 상태에서만 할 수 있습니다 (현재 ${STATUS_LABEL[c.status]})` };
  if (!can(role, 'request')) return { ok: false, reason: '변경 요청 권한이 없습니다' };
  if (c.requested_by_user === userId || PM_PLUS.includes(role)) return { ok: true, reason: c.requested_by_user === userId ? '요청자 본인' : 'PM 이상' };
  return { ok: false, reason: '내용 수정은 요청자 본인 또는 PM · 관리자 · 소유자만 할 수 있습니다' };
}

/** 이력 메모만 남기기 (상태 · 내용 변경 없음): 요청자 · 승인 범위 · 운영 권한 중 하나 */
export function checkNotePermission(role: Role, userId: string, c: { approver: ApprovalLevel; requested_by_user: string | null }): PermCheck {
  if (c.requested_by_user === userId || can(role, approvePerm(c.approver)) || can(role, 'operate')) return { ok: true, reason: '이력 기록' };
  return { ok: false, reason: '이 변경 요청에 이력을 남길 권한이 없습니다' };
}

/** 지출 성격 종류 (반영 대상 해석 · 점검에서 사용) */
export const SPEND_KINDS: readonly ChangeKind[] = ['bid', 'budget', 'status', 'gfa'];
