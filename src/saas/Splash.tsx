/**
 * 셸 밖 전체 화면 (서버 모드 시작 · 연결 확인). 공용 프리미티브를 쓰지 않는다 — 스토어보다 먼저 그려지기 때문.
 */
import type { ReactNode } from 'react';

export function AuthFrame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-screen">
      <div className={`auth-card${wide ? ' wide' : ''}`}>
        <div className="auth-brand">
          <div className="brand-mark">MILDO <span className="os">OS</span></div>
          <div className="auth-brand-sub">Cloud · 마케팅 운영 SaaS</div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Splash({ title = 'MILDO OS를 여는 중', sub }: { title?: string; sub?: ReactNode }) {
  return (
    <AuthFrame>
      <div className="auth-loading" role="status" aria-live="polite">
        <span className="auth-spinner" aria-hidden="true" />
        <div className="stack-sm" style={{ gap: 2 }}>
          <strong>{title}</strong>
          {sub ? <span className="small muted">{sub}</span> : null}
        </div>
      </div>
    </AuthFrame>
  );
}

/** 서버 모드 시작 화면 (StoreProvider가 모듈 화면을 마운트하기 전) */
export function BootScreen({ step }: { step: string }) {
  return <Splash title="워크스페이스를 준비하는 중" sub={step} />;
}
