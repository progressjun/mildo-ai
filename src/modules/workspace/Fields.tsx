/* 워크스페이스 설정 — 항목 한 줄(기본값 · 워크스페이스 값 · 기본값으로) 과 입력 부품 */
import { useState, type ReactNode } from 'react';
import { Button, NumberInput, Pill, Toggle } from '@/ui/primitives';
import { formatConfigValue, NUMBER_FIELDS, type ConfigIssue, type EffectiveConfig, type WorkspaceConfig } from '@/data/config';
import { fieldState, issueFor, type FieldState } from './model';

export interface FormCtx {
  draft: WorkspaceConfig;
  defaults: EffectiveConfig;
  readOnly: boolean;
  issues: ConfigIssue[];
  set: (path: string, value: unknown) => void;
  reset: (path: string) => void;
}

const idOf = (path: string) => `ws-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;

/** 항목 한 줄 — 라벨 · 출처 배지 · 입력 · 기본값 · 근거 · 오류 · 기본값으로 */
export function FieldRow({ ctx, path, label, source, hint, children, compact }: {
  ctx: FormCtx; path: string; label?: ReactNode; source?: string; hint?: ReactNode; compact?: boolean;
  children: (st: FieldState, id: string) => ReactNode;
}) {
  const st = fieldState(ctx.draft, path, ctx.defaults);
  const err = issueFor(ctx.issues, path);
  const meta = NUMBER_FIELDS[path];
  const id = idOf(path);
  return (
    <div className={['ws-field', st.overridden ? 'is-override' : '', err ? 'has-error' : '', compact ? 'compact' : ''].filter(Boolean).join(' ')} data-path={path}>
      <div className="ws-field-head">
        <label htmlFor={id} className="ws-field-label">{label ?? meta?.label ?? path}</label>
        {st.overridden ? <Pill tone="accent" title="이 워크스페이스에서 바꾼 값">워크스페이스 값</Pill> : <Pill tone="neutral" title="제안서 · RFP 기준 기본값">기본값</Pill>}
      </div>
      <div className="ws-field-input">{children(st, id)}</div>
      <div className="ws-field-foot">
        <span>기본값 <strong>{st.defaultText}</strong></span>
        {source ?? meta?.source ? <span>근거 {source ?? meta?.source}</span> : null}
        {hint ?? meta?.hint ? <span>{hint ?? meta?.hint}</span> : null}
        {st.overridden && !ctx.readOnly ? (
          <Button size="sm" variant="ghost" icon="rollback" onClick={(e) => { if (e.detail > 1) return; ctx.reset(path); }}>기본값으로</Button>
        ) : null}
      </div>
      {err ? <div className="ws-field-error" role="alert">{err}</div> : null}
    </div>
  );
}

/** 숫자 항목 (NUMBER_FIELDS 범위 · 단위) */
export function NumField({ ctx, path, label, hint, scale = 1, suffix, step }: { ctx: FormCtx; path: string; label?: ReactNode; hint?: ReactNode; scale?: number; suffix?: string; step?: number }) {
  const meta = NUMBER_FIELDS[path];
  return (
    <FieldRow ctx={ctx} path={path} label={label} hint={hint}>
      {(st, id) => ctx.readOnly
        ? <span className="num ws-value">{formatConfigValue(path, st.value)}</span>
        : (
          <NumberInput id={id} value={typeof st.value === 'number' ? Math.round(st.value * scale * 1e6) / 1e6 : NaN}
            min={meta ? meta.min * scale : undefined} max={meta ? meta.max * scale : undefined} step={step ?? (meta ? meta.step * scale : 1)}
            suffix={suffix ?? meta?.unit} onChange={(v) => ctx.set(path, scale === 1 ? v : Math.round((v / scale) * 1e6) / 1e6)} style={{ maxWidth: 320 }} />
        )}
    </FieldRow>
  );
}

/** 비울 수 있는 숫자 (null = 없음 · 협의) */
export function NullableNumField({ ctx, path, label, emptyLabel, fallback }: { ctx: FormCtx; path: string; label?: ReactNode; emptyLabel: string; fallback: number }) {
  const meta = NUMBER_FIELDS[path];
  return (
    <FieldRow ctx={ctx} path={path} label={label}>
      {(st, id) => {
        const v = typeof st.value === 'number' ? st.value : null;
        if (ctx.readOnly) return <span className="num ws-value">{v === null ? emptyLabel : formatConfigValue(path, v)}</span>;
        return (
          <div className="row" style={{ gap: 10 }}>
            <Toggle id={`${id}-on`} checked={v !== null} onChange={(on) => ctx.set(path, on ? (typeof st.defaultValue === 'number' ? st.defaultValue : fallback) : null)} label={v === null ? emptyLabel : '값 지정'} />
            {v !== null ? <NumberInput id={id} value={v} min={meta?.min} max={meta?.max} step={meta?.step} suffix={meta?.unit} onChange={(x) => ctx.set(path, x)} style={{ maxWidth: 220 }} /> : null}
          </div>
        );
      }}
    </FieldRow>
  );
}

export function TextField({ ctx, path, label, maxLength = 40, placeholder }: { ctx: FormCtx; path: string; label: ReactNode; maxLength?: number; placeholder?: string }) {
  return (
    <FieldRow ctx={ctx} path={path} label={label}>
      {(st, id) => ctx.readOnly
        ? <span className="ws-value">{String(st.value ?? '—')}</span>
        : <input id={id} className="input" value={String(st.value ?? '')} maxLength={maxLength} placeholder={placeholder} onChange={(e) => ctx.set(path, e.target.value)} style={{ maxWidth: 360 }} />}
    </FieldRow>
  );
}

/** 목록 (한 줄에 하나) — 입력 중 글자를 그대로 보여 주고 빈 줄은 빼서 저장 */
export function ListField({ ctx, path, label, hint, rows = 4 }: { ctx: FormCtx; path: string; label: ReactNode; hint?: ReactNode; rows?: number }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <FieldRow ctx={ctx} path={path} label={label} hint={hint}>
      {(st, id) => {
        const list = Array.isArray(st.value) ? (st.value as string[]) : [];
        if (ctx.readOnly) return <div className="ws-chips">{list.length ? list.map((x) => <Pill key={x} tone="outline">{x}</Pill>) : <span className="muted small">없음</span>}</div>;
        return (
          <textarea id={id} className="textarea ws-list" rows={rows} value={text ?? list.join('\n')}
            onChange={(e) => {
              setText(e.target.value);
              ctx.set(path, e.target.value.split('\n').map((x) => x.trim()).filter(Boolean));
            }}
            onBlur={() => setText(null)} />
        );
      }}
    </FieldRow>
  );
}

export function TimeField({ ctx, path, label, hint }: { ctx: FormCtx; path: string; label: ReactNode; hint?: ReactNode }) {
  return (
    <FieldRow ctx={ctx} path={path} label={label} hint={hint} compact>
      {(st, id) => ctx.readOnly
        ? <span className="num ws-value">{String(st.value)}</span>
        : <input id={id} type="time" className="input num" value={String(st.value ?? '')} onChange={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) ctx.set(path, e.target.value); }} style={{ maxWidth: 140 }} />}
    </FieldRow>
  );
}

export function ToggleField({ ctx, path, label, onText, offText }: { ctx: FormCtx; path: string; label: ReactNode; onText: string; offText: string }) {
  return (
    <FieldRow ctx={ctx} path={path} label={label}>
      {(st, id) => ctx.readOnly
        ? <span className="ws-value">{st.value ? onText : offText}</span>
        : <Toggle id={id} checked={!!st.value} onChange={(v) => ctx.set(path, v)} label={st.value ? onText : offText} />}
    </FieldRow>
  );
}
