/**
 * 실행 모드 감지 — 'demo'(claude.ai 아티팩트 · file: · 정적 호스팅, 서버 없음) 또는 'server'(MILDO OS Cloud API 연결).
 * 서버 모드 판정: 같은 오리진 /api/health가 1.5초 안에 { ok: true }.
 */
export type AppMode = 'demo' | 'server';

let cached: Promise<AppMode> | null = null;

/**
 * 서버 확인 없이 바로 알 수 있는 경우 — claude.ai 아티팩트 · file: · window 없음 → 'demo'. 나머지는 null(/api/health 확인 필요).
 * 앱 첫 렌더에서 데모 모드를 기다림 없이 그대로 보여 주는 데 쓴다.
 */
export function quickMode(): AppMode | null {
  try {
    if (typeof window === 'undefined') return 'demo';
    const w = window as unknown as { claude?: unknown };
    if (w.claude) return 'demo';
    if (typeof location === 'undefined' || location.protocol === 'file:' || location.protocol === 'about:' || location.protocol === 'data:' || location.protocol === 'blob:') return 'demo';
    return null;
  } catch {
    return 'demo';
  }
}

export function detectMode(): Promise<AppMode> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const quick = quickMode();
      if (quick) return quick;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch('/api/health', { signal: ctl.signal, credentials: 'same-origin' }).finally(() => clearTimeout(timer));
      if (!res.ok) return 'demo';
      const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      return j?.ok ? 'server' : 'demo';
    } catch {
      return 'demo';
    }
  })();
  return cached;
}

/** 테스트용 */
export function _resetModeForTest(): void {
  cached = null;
}
