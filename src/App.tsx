import { SaasProvider } from '@/saas/context';
import { AppGate } from '@/saas/Gate';

/**
 * 앱 루트 — 데모 모드(아티팩트 · 정적 호스팅)는 셸을 그대로, 서버 모드(MILDO OS Cloud)는 로그인 · 워크스페이스 동기화 후 셸을 연다.
 */
export default function App() {
  return (
    <SaasProvider>
      <AppGate />
    </SaasProvider>
  );
}
