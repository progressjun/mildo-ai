/**
 * 워크스페이스 설정 — settings 도메인이 구현한다 (docs/SAAS_SPEC.md §4 settings).
 * applyWorkspaceConfig(cfg): constants.ts의 내보낸 객체를 제자리 갱신(프런트 로드 시 · 서버 엔진 실행 직전).
 * 서버에서 여러 워크스페이스를 처리할 때는 withWorkspaceConfig로 감싸 동기 구간 안에서만 적용한다.
 */
export type WorkspaceConfig = Record<string, unknown>;

export function applyWorkspaceConfig(_cfg: WorkspaceConfig | null | undefined): void {
  /* settings 도메인 구현 예정 — 지금은 기본값(constants.ts) 그대로 */
}

/** cfg를 적용한 상태로 fn을 실행하고 기본값으로 되돌린다 (fn은 동기 함수여야 한다) */
export function withWorkspaceConfig<T>(cfg: WorkspaceConfig | null | undefined, fn: () => T): T {
  applyWorkspaceConfig(cfg);
  try {
    return fn();
  } finally {
    applyWorkspaceConfig(null);
  }
}
