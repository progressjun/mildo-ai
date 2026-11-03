/**
 * 페이지 수명 플래그 — 셸(모듈 화면 묶음)을 이미 불러왔는지.
 * 모듈 로컬 저장소(Lab · Watch 등)는 처음 불러올 때 localStorage를 읽어 메모리에 둔다. 그래서 로그인 사용자 · 워크스페이스가
 * 바뀌면 페이지를 새로 읽어 이전 사용자 · 워크스페이스의 화면 상태가 메모리에 남지 않게 한다.
 */
let shellLoaded = false;

export function markShellLoaded(): void {
  shellLoaded = true;
}
export function isShellLoaded(): boolean {
  return shellLoaded;
}

/** 페이지 새로 읽기 (테스트 · SSR에서는 아무것도 하지 않음) */
export function hardReload(): void {
  try {
    if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
  } catch {
    /* 새로 읽을 수 없는 환경 */
  }
}
