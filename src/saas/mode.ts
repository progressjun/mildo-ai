/**
 * 실행 모드 감지 — 'demo'(claude.ai 아티팩트 · file: · 정적 호스팅, 서버 없음) 또는 'server'(MILDO OS Cloud API 연결).
 * 서버 모드 판정: 같은 오리진 /api/health가 1.5초 안에 { ok: true }.
 */
export type AppMode = 'demo' | 'server';

let cached: Promise<AppMode> | null = null;

export function detectMode(): Promise<AppMode> {
  if (cached) return cached;
  cached = (async () => {
    try {
      if (typeof window === 'undefined') return 'demo';
      const w = window as unknown as { claude?: unknown };
      if (w.claude) return 'demo';
      if (location.protocol === 'file:' || location.protocol === 'about:') return 'demo';
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
