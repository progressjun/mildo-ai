/**
 * 라이브 데모 바 — 제안서 부록 p.60 「15분 라이브 데모 시나리오」를 타이머로 진행.
 * 구간이 바뀌면 해당 화면으로 자동 이동한다. 모든 화면은 TEST DATA 표기를 유지한다.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/core/store';
import { navigate } from '@/core/router';
import { LIVE_DEMO } from '@/data/constants';
import { Button, Src } from '@/ui/primitives';

const TOTAL = 900;

export function DemoBar() {
  const { state, dispatch } = useStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const { startedAt, pausedAt } = state.demo;
  const elapsed = startedAt ? Math.max(0, ((pausedAt ?? now) - startedAt) / 1000) : 0;
  const idx = Math.max(0, LIVE_DEMO.findIndex((s) => elapsed >= s.sec[0] && elapsed < s.sec[1]));
  const current = elapsed >= TOTAL ? LIVE_DEMO.length - 1 : idx;
  const lastIdx = useRef<number>(-1);
  useEffect(() => {
    if (lastIdx.current !== current) {
      lastIdx.current = current;
      navigate(LIVE_DEMO[current].route);
    }
  }, [current]);
  const remain = Math.max(0, TOTAL - elapsed);
  const mm = String(Math.floor(remain / 60)).padStart(2, '0');
  const ss = String(Math.floor(remain % 60)).padStart(2, '0');
  const seg = LIVE_DEMO[current];
  return (
    <div className="demobar" role="region" aria-label="라이브 데모 진행">
      <div className="stack-sm" style={{ gap: 0 }}>
        <span className="xs" style={{ color: 'var(--panel-muted)' }}>LIVE DEMO · 남은 시간</span>
        <span className="demo-clock" aria-live="off">{mm}:{ss}</span>
      </div>
      <div className="demo-steps">
        {LIVE_DEMO.map((s, i) => {
          const fill = elapsed <= s.sec[0] ? 0 : elapsed >= s.sec[1] ? 100 : ((elapsed - s.sec[0]) / (s.sec[1] - s.sec[0])) * 100;
          return (
            <button key={s.title} type="button" className="demo-step" aria-current={i === current ? 'step' : undefined} onClick={() => { dispatch({ type: 'demo/seek', seconds: s.sec[0] }); navigate(s.route); }} title={`${s.from}–${s.to} ${s.title} · ${s.detail}`}>
              <i className="fill" style={{ width: `${fill}%` }} />
              <span>{s.from} {s.title}</span>
            </button>
          );
        })}
      </div>
      <div className="stack-sm" style={{ gap: 0, maxWidth: 260 }}>
        <span className="xs" style={{ color: 'var(--panel-muted)' }}>지금 시연</span>
        <span className="small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{seg.detail}</span>
      </div>
      <Src kind="DEMO" title="시연 화면마다 실제 작동 화면과 테스트 데이터를 구분해 표기" />
      {pausedAt ? <Button size="sm" icon="play" onClick={() => dispatch({ type: 'demo/resume' })}>재개</Button> : <Button size="sm" icon="pause" onClick={() => dispatch({ type: 'demo/pause' })}>일시정지</Button>}
      <Button size="sm" icon="stop" onClick={() => dispatch({ type: 'demo/stop' })}>종료</Button>
    </div>
  );
}
