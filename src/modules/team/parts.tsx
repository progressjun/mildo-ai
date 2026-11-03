/** 팀 · 감사 화면 공용 부품 */
import { useState, type ReactNode } from 'react';
import { Button, Callout, Pill, Src } from '@/ui/primitives';
import { ROLE_LABEL, type Role } from '@/core/permissions';
import type { Tone } from '@/ui/primitives';

/**
 * 화면 안 2단계 확인 버튼 (window.confirm 대신). 첫 클릭은 확인 단계로만 바꾸고,
 * 더블 클릭의 두 번째 클릭(event.detail > 1)은 확인으로 처리하지 않는다 — 두 단계가 한 번에 통과되지 않게.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, icon, danger, disabled, title, busy }: {
  label: ReactNode; confirmLabel?: ReactNode; onConfirm: () => void; icon?: string; danger?: boolean; disabled?: boolean; title?: string; busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return <Button size="sm" icon={icon} disabled={disabled || busy} title={title} onClick={(e) => { if (e.detail > 1) return; setArmed(true); }}>{busy ? '처리 중…' : label}</Button>;
  }
  return (
    <span className="row team-confirm" style={{ gap: 4 }}>
      <Button size="sm" variant={danger ? 'danger' : 'primary'} icon="check" onClick={(e) => { if (e.detail > 1) return; setArmed(false); onConfirm(); }}>
        {confirmLabel ?? <>확인 · {label}</>}
      </Button>
      <Button size="sm" variant="ghost" onClick={(e) => { if (e.detail > 1) return; setArmed(false); }}>취소</Button>
    </span>
  );
}

const ROLE_TONE: Record<Role, Tone> = { owner: 'dark', admin: 'accent', pm: 'outline', ae: 'outline', client: 'neutral', viewer: 'neutral' };
export function RolePill({ role }: { role: Role }) {
  return <Pill tone={ROLE_TONE[role]}>{ROLE_LABEL[role]}</Pill>;
}

/** 데모 모드 안내 — 예시 상태 · 읽기 전용 */
export function DemoNote({ what, controls = '시연 모드에서는 조작 버튼이 꺼져 있습니다.' }: { what: string; controls?: string }) {
  return (
    <Callout tone="warning" title={<span className="row" style={{ gap: 6 }}>예시 화면 <Src kind="DEMO" /></span>}>
      서버(MILDO OS Cloud)에 연결하지 않은 시연 모드입니다. 아래 {what}는 예시이며 실제 계정 · 작업 기록이 아닙니다.
      서버에 연결하면 같은 화면에서 실제로 동작하고, 모든 변경은 감사 로그에 남습니다. {controls}
    </Callout>
  );
}

export function errorText(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요';
}
