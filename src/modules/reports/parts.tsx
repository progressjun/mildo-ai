/* Reports 하위 컴포넌트 — 리포트 문서 렌더러 · 섹션 코멘트 · 메신저/메일 미리보기 */
import { useState, type ReactNode } from 'react';
import { useStore, type Comment } from '@/core/store';
import { fmt, nowIso, uid } from '@/core/util';
import { Button, Pill, Src, Stat, type Tone as UiTone } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { Markdown } from '@/ui/Markdown';
import { commentTarget, aeTarget, ownerText, scopeOf, zoneLabelOf, type Block, type Cell, type Item, type Level, type Report, type ReportSection, type Zone } from './engine';

export const LEVEL_META: Record<Level, { tone: UiTone; icon: string; label: string }> = {
  danger: { tone: 'critical', icon: 'alert', label: '위험' },
  warn: { tone: 'warning', icon: 'alert', label: '주의' },
  info: { tone: 'neutral', icon: 'sparkle', label: '참고' },
  ok: { tone: 'good', icon: 'check', label: '정상' },
};

export function LevelPill({ level }: { level: Level }) {
  const m = LEVEL_META[level];
  return <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>;
}

/** 증감에 좋고 나쁨을 붙이지 않는 지표(광고비)용 — 색 없이 부호만 (MILDO Board와 같은 표기) */
export function NeutralDelta({ pct }: { pct: number }) {
  if (!Number.isFinite(pct)) return <span className="delta-flat">—</span>;
  return <span className="delta-flat num" title="증감 방향만 표시 · 좋고 나쁨 판정 없음">{fmt.delta(pct)}</span>;
}

export function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function CellView({ c }: { c: Cell }) {
  if (typeof c === 'string') return <>{c}</>;
  if (c.badge) return <Pill tone={(c.tone ?? 'neutral') as UiTone}>{c.text}</Pill>;
  return <span className={c.tone && c.tone !== 'neutral' ? `reports-tone-${c.tone}` : undefined}>{c.text}</span>;
}

function ItemView({ it }: { it: Item }) {
  return (
    <div className="reports-item">
      <div><LevelPill level={it.level} /></div>
      <div className="stack-sm" style={{ gap: 2 }}>
        <div className="reports-item-title">{it.title}</div>
        <div className="reports-item-text">{it.text}</div>
        {it.basis || it.owner || it.route ? (
          <div className="reports-item-basis">
            {it.basis ? <span>기준 · {it.basis}</span> : null}
            {it.owner ? <span>· 담당 {ownerText(it.owner)}</span> : null}
            {it.route ? <a className="reports-noprint" href={`#${it.route}`}>화면 열기 →</a> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'p':
      return <p className="reports-p">{b.text}</p>;
    case 'stats':
      return (
        <div className="reports-stats">
          {b.items.map((s) => {
            const has = s.delta !== undefined && Number.isFinite(s.delta);
            return s.neutral
              ? <Stat key={s.label} label={s.label} value={s.value} foot={<>{has ? <NeutralDelta pct={s.delta as number} /> : null}{s.foot}</>} />
              : <Stat key={s.label} label={s.label} value={s.value} delta={has ? s.delta : undefined} invert={s.invert} foot={s.foot} />;
          })}
        </div>
      );
    case 'items':
      return <div className="reports-items">{b.items.map((it, i) => <ItemView key={i} it={it} />)}</div>;
    case 'table':
      return (
        <div className="stack-sm" style={{ gap: 4 }}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>{b.columns.map((c, i) => <th key={i} className={c.align === 'right' ? 'r' : undefined}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => <td key={ci} className={b.columns[ci]?.align === 'right' ? 'r' : undefined}><CellView c={c} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {b.caption ? <div className="reports-caption">{b.caption}</div> : null}
        </div>
      );
  }
}

/* ---------- 섹션 단위 코멘트 · 피드백 (state.comments, target = reports:<type>:<section>) ---------- */

export function SectionComments({ target, title }: { target: string; title: string }) {
  const { state, dispatch } = useStore();
  const list = state.comments.filter((c) => c.target === target);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const isClient = state.role === '수면밀도';
  const openCount = list.filter((c) => !c.resolved).length;
  const add = () => {
    const t = text.trim();
    if (!t) return;
    dispatch({ type: 'comment/add', comment: { id: uid('cm'), target, author: state.role, text: t, at: nowIso() } });
    setText('');
  };
  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      {list.length ? (
        <div className="reports-thread">
          {list.map((c) => <CommentRow key={c.id} c={c} canResolve={!isClient} />)}
        </div>
      ) : null}
      <div className="row reports-thread-toggle" style={{ gap: 6 }}>
        <Button size="sm" variant="ghost" icon="edit" onClick={() => setOpen((v) => !v)}>
          {isClient ? '이 섹션에 피드백' : '이 섹션에 코멘트'}{openCount ? ` · 반영 대기 ${openCount}` : ''}
        </Button>
      </div>
      {open ? (
        <div className="reports-comment-form">
          <input id={`rc-${target.replace(/[^A-Za-z0-9_-]/g, '_')}`} className="input" aria-label={`${title} 코멘트`} placeholder={isClient ? '수면밀도 담당자 피드백 (섹션 단위)' : '코멘트 (담당 AE · PM)'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add(); }} />
          <Button size="sm" variant="primary" onClick={add} disabled={!text.trim()}>등록</Button>
        </div>
      ) : null}
    </div>
  );
}

function CommentRow({ c, canResolve }: { c: Comment; canResolve: boolean }) {
  const { dispatch } = useStore();
  const client = c.author === '수면밀도';
  return (
    <div className={`reports-comment${client ? ' client' : ''}${c.resolved ? ' resolved' : ''}`}>
      <Icon name={client ? 'users' : 'edit'} size={14} />
      <div className="reports-comment-body">
        <div>{c.text}</div>
        <div className="reports-comment-meta">
          <strong>{client ? '수면밀도 담당자' : c.author}</strong>
          <span className="num">{fmtAt(c.at)}</span>
          {c.resolved ? <Pill tone="good" icon="check">반영 완료</Pill> : client ? <Pill tone="warning">반영 대기</Pill> : null}
        </div>
      </div>
      {canResolve && client && !c.resolved ? <Button size="sm" onClick={() => dispatch({ type: 'comment/resolve', id: c.id })}>반영 완료</Button> : null}
    </div>
  );
}

/* ---------- 문서형 ---------- */

const ZONES: Zone[] = ['fact', 'pattern', 'ai', 'action'];

export function ReportDocument({ report, interp, aeNotes, aiSlot }: {
  report: Report;
  interp: { text: string; by: 'ai' | 'rule'; at: string } | null;
  aeNotes: Comment[];
  aiSlot: ReactNode;
}) {
  return (
    <section className="card reports-doc" aria-label="문서형 리포트">
      <div className="reports-print-only">수면밀도 × 프로그레스미디어 · MILDO OS 자동 리포트 · TEST DATA (시연용 테스트 데이터)</div>
      <header className="reports-doc-head">
        <div className="reports-doc-eyebrow">PRO-BOARD REPORT · {report.channel}</div>
        <h2 className="reports-doc-title">{report.title}</h2>
        <div className="reports-doc-meta">
          <span>{report.subtitle}</span>
          <span>· {report.schedule}</span>
          <span className="num">· 생성 기준 {report.generatedAt}</span>
          {report.provisional ? <Pill tone="warning">잠정 · 월 마감 전</Pill> : null}
          <Src kind="DEMO" />
          <Src kind="PROPOSAL" page="p.17" />
        </div>
      </header>
      {ZONES.map((z) => {
        const secs = report.sections.filter((s) => s.zone === z);
        if (z === 'ai') {
          return (
            <div key={z} className={`reports-zone ai${interp?.text ? '' : ' reports-noprint'}`}>
              <div className="reports-zone-label">
                <Icon name="sparkle" size={13} />{zoneLabelOf(report, 'ai')}
                {interp ? (interp.by === 'ai' ? <Src kind="AI" /> : <Pill tone="neutral">규칙 엔진 · AI 미연결</Pill>) : null}
              </div>
              {interp?.text ? <Markdown text={interp.text} /> : null}
              {aiSlot}
            </div>
          );
        }
        if (!secs.length) return null;
        return (
          <div key={z} className={`reports-zone ${z}`}>
            <div className="reports-zone-label">{zoneLabelOf(report, z)}</div>
            {secs.map((s) => <SectionView key={s.id} report={report} s={s} />)}
          </div>
        );
      })}
      <div className="reports-zone ae">
        <div className="reports-zone-label">담당 AE 해석 · 다음 액션</div>
        {aeNotes.length ? aeNotes.map((n) => (
          <div key={n.id} className="reports-comment">
            <Icon name="edit" size={14} />
            <div className="reports-comment-body">
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
              <div className="reports-comment-meta"><strong>{n.author}</strong><span className="num">{fmtAt(n.at)}</span></div>
            </div>
          </div>
        )) : <div className="small muted">아직 병합된 AE 코멘트가 없습니다. 오른쪽 패널에서 해석과 다음 액션을 덧붙입니다.</div>}
      </div>
      <div className="xs muted">보고서는 시스템이 만들고, 담당 AE는 해석과 다음 액션을 덧붙입니다 (제안서 p.17). 확정 팩트는 데이터 계산값, 반복 관측 패턴은 다기간 비교, 해석은 별도 영역입니다.</div>
    </section>
  );
}

function SectionView({ report, s }: { report: Report; s: ReportSection }) {
  return (
    <article className="reports-section" id={`rs-${report.type}-${s.id}`}>
      <div className="reports-section-head">
        <h3 className="reports-section-title">{s.title}</h3>
        {s.note ? <span className="reports-caption">{s.note}</span> : null}
      </div>
      {s.blocks.map((b, i) => <BlockView key={i} b={b} />)}
      <SectionComments target={commentTarget(scopeOf(report), s.id)} title={s.title} />
    </article>
  );
}

export { aeTarget };

/* ---------- 메신저 · 메일 미리보기 ---------- */

export function MessengerPreview({ report, sendLabel }: { report: Report; sendLabel: string }) {
  const lines = report.messenger.split('\n');
  return (
    <div className="reports-phone" aria-label="메신저 미리보기">
      <div className="reports-phone-head"><span>MILDO OS 알림봇 · 수면밀도 마케팅방</span><span className="num">{sendLabel}</span></div>
      <div className="reports-bot">
        <span className="reports-bot-avatar">M</span>
        <div className="reports-bubble">
          <strong>{lines[0]}</strong>
          {'\n'}{lines.slice(1).join('\n')}
          <div><span className="reports-bubble-link">전체 리포트 열기 · 코멘트 남기기</span></div>
        </div>
      </div>
      <div className="reports-phone-foot"><span>{lines.length}줄 · {report.messenger.length}자</span><span>메신저형 (짧게)</span></div>
    </div>
  );
}

export function MailPreview({ report, to }: { report: Report; to: string }) {
  return (
    <div className="reports-mail" aria-label="메일 미리보기">
      <div className="reports-mail-head">
        <span>받는 사람</span><span>{to}</span>
        <span>제목</span><strong>[MILDO] {report.title}</strong>
        <span>발송</span><span>{report.schedule}</span>
      </div>
      <div className="reports-mail-body">{report.messenger}{'\n\n'}— 본문 전체는 첨부 문서(.md)와 MILDO OS 리포트 화면에서 확인합니다.</div>
    </div>
  );
}
