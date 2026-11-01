import { StoreProvider } from '@/core/store';
import { Shell } from '@/app/Shell';

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
