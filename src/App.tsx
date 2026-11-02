import { StoreProvider } from '@/core/store';
import { Shell } from '@/app/Shell';
import { SaasProvider } from '@/saas/context';

export default function App() {
  return (
    <SaasProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </SaasProvider>
  );
}
