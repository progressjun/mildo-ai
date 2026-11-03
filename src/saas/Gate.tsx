/**
 * 앱 진입 분기 — 데모 모드는 지금과 같은 셸, 서버 모드는 로그인 → 워크스페이스 정보 → 스토어 동기화 → 셸.
 *
 * 셸(모듈 화면 묶음)은 지연 로드한다: 모듈 저장소(Lab · Watch 등)는 처음 불러올 때 localStorage를 읽으므로,
 * 서버 모드에서는 워크스페이스 입력값(workspace_state)을 localStorage에 쓰고 설정(applyWorkspaceConfig)을 적용한 뒤에 불러와야 한다.
 */
import { lazy, Suspense, useState } from 'react';
import { StoreProvider } from '@/core/store';
import { useSaas } from './context';
import { AuthScreens, currentAuthTokens, NoWorkspaceScreen, WorkspaceErrorScreen } from './AuthScreens';
import { Splash } from './Splash';
import { markShellLoaded } from './runtime';
import { quickMode } from './mode';

const loadShell = () => import('@/app/Shell').then((m) => {
  markShellLoaded();
  return { default: m.Shell };
});
const ShellLazy = lazy(loadShell);
// 데모 모드가 바로 확정되는 환경(아티팩트 · file:)에서는 셸을 미리 불러와 첫 화면을 늦추지 않는다
if (quickMode() === 'demo') void loadShell().catch(() => undefined);

export function AppGate() {
  const saas = useSaas();
  const [tokens, setTokens] = useState(currentAuthTokens);

  if (saas.mode === 'checking') return <Splash title="MILDO OS를 여는 중" sub="서버 연결을 확인하고 있습니다" />;

  if (saas.mode === 'demo') {
    return (
      <StoreProvider>
        <Suspense fallback={null}>
          <ShellLazy />
        </Suspense>
      </StoreProvider>
    );
  }

  // 서버 모드
  if (tokens.invite || tokens.reset) return <AuthScreens tokens={tokens} onTokensUsed={() => setTokens({ invite: null, reset: null })} />;
  if (!saas.me) return <AuthScreens tokens={tokens} onTokensUsed={() => setTokens({ invite: null, reset: null })} />;
  if (!saas.workspace) return <NoWorkspaceScreen />;
  if (!saas.detail || saas.detail.workspace.id !== saas.workspace.id) {
    if (saas.detailError) return <WorkspaceErrorScreen message={saas.detailError} />;
    return <Splash title="워크스페이스를 여는 중" sub={`${saas.workspace.brand_name} · 설정과 권한을 확인하고 있습니다`} />;
  }
  return (
    <StoreProvider key={saas.workspace.id}>
      <Suspense fallback={<Splash title="화면을 불러오는 중" />}>
        <ShellLazy />
      </Suspense>
    </StoreProvider>
  );
}
