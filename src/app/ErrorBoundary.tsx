/**
 * 모듈 화면 오류 격리 — 한 화면에서 렌더 오류가 나도 사이드바 · 상단 바 · 다른 화면은 그대로 쓴다.
 * Shell이 라우트를 key로 넘기므로 다른 화면으로 이동하면 자동으로 초기화된다.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ModuleErrorBoundary extends Component<{ children: ReactNode; title: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 콘솔에는 남겨 점검 시 원인을 찾을 수 있게 한다
    console.warn(`[MILDO OS] ${this.props.title} 화면 오류`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <section className="card" role="alert">
          <h2 className="card-title">{this.props.title} 화면을 표시하지 못했습니다</h2>
          <div className="small ink2">다른 화면과 저장된 승인 · 이슈 이력은 영향을 받지 않습니다. 다시 시도하거나 커맨드 센터로 이동하세요.</div>
          <div className="xs muted num">{String(this.state.error.message || this.state.error).slice(0, 200)}</div>
          <div className="row">
            <button type="button" className="btn sm primary" onClick={() => this.setState({ error: null })}>다시 시도</button>
            <a className="btn sm" href="#home">커맨드 센터</a>
          </div>
        </section>
      </div>
    );
  }
}
