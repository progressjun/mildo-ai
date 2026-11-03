/* 공용 UI 프리미티브 — 모든 모듈은 이 컴포넌트와 app.css 클래스를 사용한다. */
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { Severity, SourceKind } from '@/core/types';
import { copyText, saveFile } from '@/core/download';
import { fmt } from '@/core/util';
import { useActions, useStoreOptional } from '@/core/store';
import { srcDemoLabel } from '@/saas/sync';

/* ---------- 버튼 ---------- */
type BtnVariant = 'default' | 'primary' | 'accent' | 'danger' | 'ghost';
export function Button({
  children, onClick, variant = 'default', size, icon, disabled, title, type = 'button', id, style,
}: {
  children?: ReactNode; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; variant?: BtnVariant; size?: 'sm' | 'lg'; icon?: string; disabled?: boolean; title?: string; type?: 'button' | 'submit'; id?: string; style?: CSSProperties;
}) {
  const cls = ['btn', variant !== 'default' ? variant : '', size ?? ''].filter(Boolean).join(' ');
  return (
    <button id={id} type={type} className={cls} onClick={onClick} disabled={disabled} title={title} style={style}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, onClick, size = 16 }: { icon: string; label: string; onClick?: () => void; size?: number }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={label} title={label}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ---------- 레이아웃 ---------- */
export function PageHeader({ eyebrow, title, sub, sources, actions }: { eyebrow: string; title: ReactNode; sub?: ReactNode; sources?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="eyebrow">{eyebrow}</div>
      <div className="page-head-row">
        <h1 className="page-title">{title}</h1>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
      {sub ? <p className="page-sub">{sub}</p> : null}
      {sources ? <div className="row">{sources}</div> : null}
    </header>
  );
}

export function Card({ title, sub, actions, children, tone, className, style, id }: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; tone?: 'dark' | 'accent' | 'flat'; className?: string; style?: CSSProperties; id?: string;
}) {
  return (
    <section id={id} className={['card', tone ?? '', className ?? ''].filter(Boolean).join(' ')} style={style}>
      {title || actions ? (
        <div className="card-head">
          <div className="stack-sm" style={{ gap: 2 }}>
            {title ? <h2 className="card-title">{title}</h2> : null}
            {sub ? <div className="card-sub">{sub}</div> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/* ---------- KPI ---------- */
export function Delta({ pct, invert = false, digits = 1 }: { pct: number; invert?: boolean; digits?: number }) {
  if (!Number.isFinite(pct)) return <span className="delta-flat">—</span>;
  const good = invert ? pct < 0 : pct > 0;
  const flat = Math.abs(pct) < 0.05;
  return (
    <span className={flat ? 'delta-flat' : good ? 'delta-up' : 'delta-down'} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {!flat ? <Icon name={pct > 0 ? 'up' : 'down'} size={12} stroke={2.4} /> : null}
      {fmt.delta(pct, digits)}
    </span>
  );
}

export function Stat({ label, value, delta, invert, foot, spark, src }: { label: ReactNode; value: ReactNode; delta?: number; invert?: boolean; foot?: ReactNode; spark?: ReactNode; src?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}{src}</div>
      <div className="stat-value num">{value}</div>
      <div className="stat-foot">
        {delta !== undefined ? <Delta pct={delta} invert={invert} /> : null}
        {foot}
      </div>
      {spark}
    </div>
  );
}

/* ---------- 배지 ---------- */
export type Tone = 'neutral' | 'good' | 'warning' | 'serious' | 'critical' | 'accent' | 'dark' | 'outline';
export function Pill({ tone = 'neutral', children, icon, title }: { tone?: Tone; children: ReactNode; icon?: string; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {icon ? <Icon name={icon} size={12} stroke={2.2} /> : null}
      {children}
    </span>
  );
}

const SRC_LABEL: Record<SourceKind, string> = { RFP: 'RFP', PROPOSAL: '제안서', DEMO: 'TEST DATA', AI: 'AI 해석', LIVE: 'LIVE' };
/**
 * 출처 태그 — 화면마다 실제 작동/테스트 데이터를 구분 표기 (제안서 p.60).
 * kind 'DEMO'(성과 데이터 출처)는 현재 Dataset 메타를 따른다: 메타 없음 · demo → TEST DATA, live → LIVE DATA, mixed → LIVE + TEST
 * (서버 모드에서 실연동 데이터일 때, 툴팁에 매체별 출처 · 최신 시각).
 */
/**
 * 출처 태그. kind='DEMO'는 데이터 출처를 따른다 — 데모 모드 · 테스트 데이터는 TEST DATA, 서버 모드 실연동은 LIVE DATA · LIVE + TEST.
 * fixture(또는 '실제 … 아님' · '가정' · '데모 추정' 같은 문구의 title)는 데이터셋과 무관한 시연용 예시라 언제나 TEST DATA (src/saas/sync srcDemoLabel).
 */
export function Src({ kind, page, title, fixture }: { kind: SourceKind; page?: string; title?: string; fixture?: boolean }) {
  const store = useStoreOptional();
  if (kind === 'DEMO') {
    const ds = srcDemoLabel(store?.state.data.meta, { title, fixture });
    return <span className={`src ${ds.cls}`} title={ds.title} data-source={ds.tone}>{ds.label}{page ? ` ${page}` : ''}</span>;
  }
  const cls = { RFP: 'rfp', PROPOSAL: 'proposal', DEMO: 'demo', AI: 'ai', LIVE: 'live' }[kind];
  const t = title ?? (kind === 'PROPOSAL' ? '프로그레스미디어 2027 제안서 기준' : kind === 'RFP' ? '수면밀도 RFP 명시 사항' : undefined);
  return <span className={`src ${cls}`} title={t}>{SRC_LABEL[kind]}{page ? ` ${page}` : ''}</span>;
}

export function Sev({ level }: { level: Severity }) {
  return <span className={`sev ${level}`}><Icon name="alert" size={11} stroke={2.4} />{level}</span>;
}

/* ---------- 입력 ---------- */
export function Tabs<T extends string>({ tabs, value, onChange, id }: { tabs: { id: T; label: ReactNode; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; id?: string }) {
  return (
    <div className="tabs" role="tablist" id={id}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" className="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>
          {t.label}{t.badge}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children, id, hint }: { label: ReactNode; children: ReactNode; id?: string; hint?: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <div className="xs muted">{hint}</div> : null}
    </div>
  );
}

/**
 * 숫자 입력 — 입력 중인 글자(draft)를 그대로 보여 준다. 부모가 범위를 보정해도 타이핑 도중 값이 튀지 않고
 * ('20' 입력 중 '2'가 최솟값 5로 바뀌어 '50'이 되는 문제), 칸을 비워도 0으로 바뀌지 않는다.
 * 유한한 숫자일 때만 onChange를 부르고, 포커스를 잃거나 Enter를 누르면 부모 값(보정 결과)으로 표시를 맞춘다.
 */
export function NumberInput({ id, value, onChange, step = 1, min, max, suffix, style }: { id: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; style?: CSSProperties }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap', ...style }}>
      <input id={id} className="input num" type="number" value={shown} step={step} min={min} max={max}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() === '') return;
          const v = Number(raw);
          if (Number.isFinite(v)) onChange(v);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === 'Enter') setDraft(null); }} />
      {suffix ? <span className="small muted nowrap">{suffix}</span> : null}
    </div>
  );
}

export function Toggle({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ---------- 테이블 ---------- */
export interface Column<T> {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => ReactNode;
  sort?: (row: T) => number | string;
  width?: number | string;
}
export function DataTable<T>({ rows, columns, rowKey, initialSort, maxHeight, onRowClick, selectedKey, footer, empty }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; initialSort?: { key: string; dir: 'asc' | 'desc' }; maxHeight?: number; onRowClick?: (r: T) => void; selectedKey?: string | null; footer?: ReactNode; empty?: ReactNode;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const f = col.sort;
    return [...rows].sort((a, b) => {
      const va = f(a), vb = f(b);
      const na = typeof va === 'number' && !Number.isFinite(va), nb = typeof vb === 'number' && !Number.isFinite(vb);
      if (na !== nb) return na ? 1 : -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, sort, columns]);
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => {
              const cls = [c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : '', c.sort ? 'sortable' : ''].join(' ');
              const active = sort?.key === c.key;
              return (
                <th key={c.key} className={cls} style={{ width: c.width }}
                  onClick={c.sort ? () => setSort({ key: c.key, dir: active && sort?.dir === 'desc' ? 'asc' : 'desc' }) : undefined}
                  tabIndex={c.sort ? 0 : undefined}
                  onKeyDown={c.sort ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort({ key: c.key, dir: active && sort?.dir === 'desc' ? 'asc' : 'desc' }); } } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.label}{active ? (sort!.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={columns.length} className="c muted" style={{ padding: 24 }}>{empty ?? '표시할 데이터가 없습니다'}</td></tr>
          ) : sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={selectedKey === k ? 'selected' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onRowClick(r); } } : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : undefined}>
                    {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

/* ---------- 콜아웃 ---------- */
export function Callout({ tone = 'info', icon, children, title }: { tone?: 'info' | 'warning' | 'critical' | 'good' | 'accent'; icon?: string; children: ReactNode; title?: ReactNode }) {
  const ic = icon ?? { info: 'sparkle', warning: 'alert', critical: 'alert', good: 'check', accent: 'zap' }[tone];
  return (
    <div className={`callout ${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <Icon name={ic} size={16} />
      <div className="stack-sm" style={{ gap: 2 }}>
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/* ---------- 진행 바 ---------- */
export function ProgressBar({ value, max = 100, marker, tone, label }: { value: number; max?: number; marker?: number; tone?: 'accent' | 'good' | 'warning' | 'critical' | 'ink'; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone === 'good' ? 'var(--good)' : tone === 'warning' ? 'var(--warning)' : tone === 'critical' ? 'var(--critical)' : tone === 'accent' ? 'var(--accent)' : 'var(--ink)';
  return (
    <div className="bar" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <span style={{ width: `${pct}%`, background: color }} />
      {marker !== undefined ? <i className="marker" style={{ left: `calc(${Math.max(0, Math.min(100, (marker / max) * 100))}% - 1px)` }} /> : null}
    </div>
  );
}

/* ---------- 모달 · 드로어 ---------- */
function useEsc(onClose: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
}
export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEsc(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && e.detail < 2 && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="row-between">
          <h2 style={{ fontSize: 'var(--fs-xl)' }}>{title}</h2>
          <IconButton icon="x" label="닫기" onClick={onClose} />
        </div>
        {children}
        {footer ? <div className="row" style={{ justifyContent: 'flex-end' }}>{footer}</div> : null}
      </div>
    </div>
  );
}
export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEsc(onClose);
  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && e.detail < 2 && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="row-between">
          <h2 style={{ fontSize: 'var(--fs-xl)' }}>{title}</h2>
          <IconButton icon="x" label="닫기" onClick={onClose} />
        </div>
        {children}
      </aside>
    </div>
  );
}

/* ---------- 복사 · 내보내기 ---------- */
export function CopyButton({ text, label = '복사', size = 'sm' }: { text: string | (() => string); label?: string; size?: 'sm' | 'lg' }) {
  const { toast } = useActions();
  return (
    <Button size={size} icon="copy" onClick={async () => {
      const ok = await copyText(typeof text === 'function' ? text() : text);
      toast({ tone: ok ? 'good' : 'warning', title: ok ? '클립보드에 복사했습니다' : '복사하지 못했습니다', body: ok ? undefined : '텍스트를 직접 선택해 복사하세요.' });
    }}>{label}</Button>
  );
}
export function DownloadButton({ filename, data, mime, label = '내보내기', size = 'sm' }: { filename: string; data: string | (() => string); mime?: string; label?: string; size?: 'sm' | 'lg' }) {
  const { toast } = useActions();
  return (
    <Button size={size} icon="download" onClick={async () => {
      const body = typeof data === 'function' ? data() : data;
      if (!body) {
        toast({ tone: 'warning', title: '내보낼 내용이 없습니다', body: '조건을 바꿔 표시되는 항목이 있을 때 다시 시도하세요.' });
        return;
      }
      const r = await saveFile(filename, body, mime);
      if (r === 'unavailable') toast({ tone: 'warning', title: '이 화면에서는 파일 저장을 지원하지 않습니다', body: '복사 버튼을 사용하세요.' });
      if (r === 'failed') toast({ tone: 'warning', title: '파일을 저장하지 못했습니다', body: `${filename} · 복사 버튼을 사용하세요.` });
    }}>{label}</Button>
  );
}

export function Empty({ icon = 'inbox', title, children }: { icon?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="stack" style={{ alignItems: 'center', textAlign: 'center', padding: '28px 12px', color: 'var(--muted)' }}>
      <Icon name={icon} size={28} />
      <strong style={{ color: 'var(--ink-2)' }}>{title}</strong>
      {children ? <div className="small">{children}</div> : null}
    </div>
  );
}

/** 색 점 + 라벨 (범례/매체 표기) */
export function Swatch({ colorVar, label }: { colorVar: string; label: ReactNode }) {
  return (
    <span className="legend-item">
      <span className="legend-swatch" style={{ background: `var(${colorVar})` }} />
      {label}
    </span>
  );
}
