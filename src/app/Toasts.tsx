import { useEffect, useRef } from 'react';
import { useStore } from '@/core/store';
import { navigate } from '@/core/router';
import { Icon } from '@/ui/Icon';
import { IconButton } from '@/ui/primitives';

export function Toasts() {
  const { state, dispatch } = useStore();
  // 알림마다 한 번만 타이머를 건다 — 새 알림이 와도 기존 알림의 표시 시간이 늘어나지 않는다
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = new Set(state.toasts.map((t) => t.id));
    for (const t of state.toasts) {
      if (timers.current.has(t.id)) continue;
      timers.current.set(t.id, setTimeout(() => {
        timers.current.delete(t.id);
        dispatch({ type: 'toast/dismiss', id: t.id });
      }, t.tone === 'critical' ? 9000 : 5000));
    }
    for (const [id, h] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(h);
        timers.current.delete(id);
      }
    }
  }, [state.toasts, dispatch]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);
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
