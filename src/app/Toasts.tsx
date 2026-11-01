import { useEffect } from 'react';
import { useStore } from '@/core/store';
import { navigate } from '@/core/router';
import { Icon } from '@/ui/Icon';
import { IconButton } from '@/ui/primitives';

export function Toasts() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    if (!state.toasts.length) return;
    const timers = state.toasts.map((t) => setTimeout(() => dispatch({ type: 'toast/dismiss', id: t.id }), t.tone === 'critical' ? 9000 : 5000));
    return () => timers.forEach(clearTimeout);
  }, [state.toasts, dispatch]);
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <Icon name={t.tone === 'critical' || t.tone === 'warning' ? 'alert' : t.tone === 'good' ? 'check' : 'bell'} size={16} />
          <div className="stack-sm" style={{ gap: 2, flex: 1 }}>
            <div className="toast-title">{t.title}</div>
            {t.body ? <div className="muted">{t.body}</div> : null}
            {t.route ? (
              <button type="button" className="btn sm" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => { navigate(t.route!); dispatch({ type: 'toast/dismiss', id: t.id }); }}>
                바로 가기
              </button>
            ) : null}
          </div>
          <IconButton icon="x" label="알림 닫기" onClick={() => dispatch({ type: 'toast/dismiss', id: t.id })} />
        </div>
      ))}
    </div>
  );
}
