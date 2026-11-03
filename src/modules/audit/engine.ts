/**
 * 감사 로그 — 순수 함수 (화면 · 에이전트 · 서버 CSV가 같이 쓴다).
 * 작업 코드(action)는 '<도메인>.<동작>' 형식이다. 아는 코드는 한국어 설명을, 모르는 코드는 도메인 이름 + 원문 코드를 보여 준다.
 */

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  /** 서버가 저장 전에 비밀값을 가린 상세 (••••) */
  detail: Record<string, unknown>;
  ip: string | null;
  /** 워크스페이스 밖 계정 기록(로그인 · 비밀번호) 여부 */
  account?: boolean;
}

export interface AuditFilters {
  /** 작업 코드 접두어 (예: 'invite.' · 'change') */
  action?: string;
  userId?: string;
  /** KST 날짜 YYYY-MM-DD (포함) */
  from?: string;
  to?: string;
  /** 구성원 로그인 · 계정 보안 기록 포함 */
  auth?: boolean;
  targetType?: string;
  targetId?: string;
}

/** 도메인(접두어) 이름 */
export const DOMAIN_LABEL: Record<string, string> = {
  auth: '계정 · 로그인',
  invite: '초대',
  member: '구성원',
  audit: '감사 로그',
  change: '변경 요청',
  connection: '데이터 연결',
  ingest: '수집',
  upload: 'CSV 업로드',
  incident: '이슈',
  alerts: '감지',
  notify: '알림',
  report: '리포트',
  impact: '성과 증명',
  ai: 'AI',
  config: '워크스페이스 설정',
  comment: '코멘트',
  state: '모듈 입력',
  workspace: '워크스페이스',
};

/** 아는 작업 코드 */
export const ACTION_LABEL: Record<string, string> = {
  'auth.login': '로그인',
  'auth.login_failed': '로그인 실패',
  'auth.login_locked': '로그인 잠금 (실패 반복)',
  'auth.logout': '로그아웃',
  'auth.password_change': '비밀번호 변경',
  'auth.password_change_failed': '비밀번호 변경 실패 (현재 비밀번호 불일치)',
  'auth.password_reset_request': '비밀번호 재설정 메일 요청',
  'auth.password_reset': '비밀번호 재설정 완료',
  'auth.session_revoke': '접속 세션 종료',
  'auth.sessions_revoke_others': '다른 기기 세션 모두 종료',
  'invite.create': '초대 발송',
  'invite.resend': '초대 다시 보내기',
  'invite.revoke': '초대 취소',
  'invite.accept': '초대 수락 · 합류',
  'member.role_change': '역할 변경',
  'member.title_change': '직함 변경',
  'member.disable': '계정 비활성화',
  'member.enable': '계정 재활성화',
  'member.remove': '구성원 제외',
  'member.leave': '워크스페이스 나가기',
  'audit.export': '감사 로그 CSV 내보내기',
  // 아래는 다른 도메인 서버 코드가 실제로 남기는 작업 코드 (server/src/<domain> audit 호출 기준). 모르는 코드는 도메인 이름 + 원문으로 보인다
  'change.create': '변경 요청 생성',
  'change.update': '변경 요청 내용 수정',
  'change.note': '변경 요청 메모',
  'change.approve': '변경 승인',
  'change.reject': '변경 반려',
  'change.hold': '보류',
  'change.resume': '보류 해제',
  'change.cancel': '변경 요청 취소',
  'change.apply': '매체 반영',
  'change.apply_held': '반영 보류 (검증 · 가드)',
  'change.retry': '반영 재시도',
  'change.execute_deferred': '반영 대기 (백그라운드 실행)',
  'change.rollback': '롤백',
  'change.rollback_failed': '롤백 실패',
  'connection.create': '커넥션 추가',
  'connection.update': '커넥션 수정',
  'connection.delete': '커넥션 삭제',
  'connection.sync': '수동 수집',
  'connection.write_mode': '쓰기 모드 변경',
  'connection.credentials_refreshed': '자격증명 갱신',
  'upload.create': 'CSV 업로드',
  'upload.delete': 'CSV 업로드 삭제',
  'config.update': '설정 변경',
  'config.review': '설정 검토',
  'report.generate': '리포트 생성',
  'report.deliver': '리포트 발송',
  'impact.measure': '성과 측정',
  'incident.create': '이슈 등록',
  'incident.update': '이슈 갱신',
  'incident.reopen': '이슈 다시 열기',
  'incident.escalate': '이슈 에스컬레이션',
  'incident.scan': '이상 감지 실행',
  'alerts.scan': '이상 감지 실행',
  'notify.channel.create': '알림 채널 추가',
  'notify.channel.update': '알림 채널 수정',
  'notify.channel.delete': '알림 채널 삭제',
  'notify.send': '알림 발송',
  'comment.create': '코멘트 작성',
  'state.update': '모듈 입력 저장',
  'state.delete': '모듈 입력 삭제',
  'ai.budget_exceeded': 'AI 월 사용 한도 초과',
};

export function actionDomain(action: string): string {
  return action.split('.')[0] ?? action;
}

/** 작업 코드 → 한국어 설명 */
export function actionLabel(action: string): string {
  const known = ACTION_LABEL[action];
  if (known) return known;
  const d = DOMAIN_LABEL[actionDomain(action)];
  return d ? `${d} · ${action}` : action;
}

/** 보안상 눈여겨볼 작업 (화면 강조 · 브리프) */
export function isSensitive(action: string): boolean {
  return /^(auth\.login_(failed|locked)|auth\.password_|member\.(role_change|disable|remove)|invite\.create|connection\.(write_mode|delete)|audit\.export|change\.(apply|rollback))/.test(action);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 필터 → 쿼리 문자열 (빈 값은 뺀다) */
export function buildAuditQuery(f: AuditFilters, extra: { before?: number | null; limit?: number } = {}): string {
  const p = new URLSearchParams();
  if (f.action?.trim()) p.set('action', f.action.trim());
  if (f.userId) p.set('userId', f.userId);
  if (f.from && DATE_RE.test(f.from)) p.set('from', f.from);
  if (f.to && DATE_RE.test(f.to)) p.set('to', f.to);
  if (f.auth) p.set('auth', '1');
  if (f.targetType) p.set('targetType', f.targetType);
  if (f.targetId) p.set('targetId', f.targetId);
  if (extra.before) p.set('before', String(extra.before));
  if (extra.limit) p.set('limit', String(extra.limit));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** 날짜 범위 검사 (화면 입력) */
export function filterProblem(f: AuditFilters): string | null {
  if (f.from && !DATE_RE.test(f.from)) return '시작일 형식은 YYYY-MM-DD입니다';
  if (f.to && !DATE_RE.test(f.to)) return '종료일 형식은 YYYY-MM-DD입니다';
  if (f.from && f.to && f.from > f.to) return '시작일이 종료일보다 늦습니다';
  return null;
}

/** ISO → KST 'YYYY-MM-DD HH:mm:ss' */
export function kstStamp(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const ms = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 3600_000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** 상세 JSON 보기 (2칸 들여쓰기, 너무 길면 자른다) */
export function prettyDetail(detail: unknown, max = 20_000): string {
  let s: string;
  try {
    s = JSON.stringify(detail ?? {}, null, 2);
  } catch {
    s = String(detail);
  }
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max}자 생략)` : s;
}

/** 표에 보일 한 줄 요약 */
export function detailSummary(e: Pick<AuditEntry, 'action' | 'detail'>): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (d[k] === undefined || d[k] === null || d[k] === '' ? null : String(d[k]));
  if (e.action === 'member.role_change' && pick('from') && pick('to')) return `${pick('email') ?? ''} ${pick('from')} → ${pick('to')}`.trim();
  const parts = ['email', 'role', 'from', 'to', 'label', 'status', 'reason', 'via'].map((k) => (pick(k) ? `${k}=${pick(k)}` : null)).filter(Boolean) as string[];
  return parts.join(' · ').slice(0, 140);
}

/** CSV 셀 — 수식 주입(=, +, -, @로 시작) 방지 + 따옴표 처리 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = ['ID', '시각(KST)', '행위자', '이메일', '작업', '작업 설명', '대상 유형', '대상 ID', '상세(JSON)', 'IP', '기록 범위'] as const;

/** 감사 로그 CSV (UTF-8 BOM 포함 — 엑셀 한글 깨짐 방지) */
export function auditCsv(entries: AuditEntry[]): string {
  const rows = entries.map((e) =>
    [e.id, kstStamp(e.at), e.actor, e.user_email ?? '', e.action, actionLabel(e.action), e.target_type ?? '', e.target_id ?? '', e.detail ?? {}, e.ip ?? '', e.account ? '계정' : '워크스페이스']
      .map(csvCell)
      .join(','),
  );
  return '﻿' + [CSV_COLUMNS.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}

export interface AuditSummary {
  total: number;
  byDomain: { domain: string; label: string; count: number }[];
  actors: { actor: string; count: number }[];
  sensitive: AuditEntry[];
  failedLogins: number;
  first: string | null;
  last: string | null;
}

export function summarizeAudit(entries: AuditEntry[]): AuditSummary {
  const dom = new Map<string, number>();
  const act = new Map<string, number>();
  for (const e of entries) {
    const d = actionDomain(e.action);
    dom.set(d, (dom.get(d) ?? 0) + 1);
    act.set(e.actor, (act.get(e.actor) ?? 0) + 1);
  }
  const sortedAt = entries.map((e) => e.at).filter(Boolean).sort();
  return {
    total: entries.length,
    byDomain: [...dom.entries()].map(([domain, count]) => ({ domain, label: DOMAIN_LABEL[domain] ?? domain, count })).sort((a, b) => b.count - a.count),
    actors: [...act.entries()].map(([actor, count]) => ({ actor, count })).sort((a, b) => b.count - a.count),
    sensitive: entries.filter((e) => isSensitive(e.action)),
    failedLogins: entries.filter((e) => e.action === 'auth.login_failed').length,
    first: sortedAt[0] ?? null,
    last: sortedAt[sortedAt.length - 1] ?? null,
  };
}

/** 화면 · 데모용 로컬 필터 (서버 필터와 같은 의미: 접두어 · 사용자 · KST 날짜 포함 범위 · 계정 기록) */
export function filterEntries(entries: AuditEntry[], f: AuditFilters): AuditEntry[] {
  const prefix = f.action?.trim() ?? '';
  const fromMs = f.from && DATE_RE.test(f.from) ? Date.parse(`${f.from}T00:00:00+09:00`) : null;
  const toMs = f.to && DATE_RE.test(f.to) ? Date.parse(`${f.to}T00:00:00+09:00`) + 86_400_000 : null;
  return entries.filter((e) => {
    if (prefix && !e.action.startsWith(prefix)) return false;
    if (f.userId && e.user_id !== f.userId) return false;
    if (!f.auth && e.account) return false;
    if (f.targetType && e.target_type !== f.targetType) return false;
    if (f.targetId && e.target_id !== f.targetId) return false;
    const ms = Date.parse(e.at);
    if (fromMs !== null && ms < fromMs) return false;
    if (toMs !== null && ms >= toMs) return false;
    return true;
  });
}

/** 필터 입력 자동완성: 도메인 접두어('invite.') + 아는 작업 코드 */
export function actionSuggestions(seen: string[] = []): { value: string; label: string }[] {
  const domains = Object.entries(DOMAIN_LABEL).map(([d, label]) => ({ value: `${d}.`, label: `${label} 전체` }));
  const codes = [...new Set([...Object.keys(ACTION_LABEL), ...seen])].sort().map((a) => ({ value: a, label: actionLabel(a) }));
  return [...domains, ...codes];
}
