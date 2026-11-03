/**
 * 안전한 경량 마크다운 렌더러 (innerHTML 미사용).
 * "### 확정 팩트" 등 에이전트 소제목을 만나면 영역(zone) 스타일로 구분해 그린다.
 */
import { Fragment, type ReactNode } from 'react';

const ZONE_CLASS: Record<string, { cls: string; label: string }> = {
  '확정 팩트': { cls: 'fact', label: '확정 팩트' },
  '반복 관측 패턴': { cls: 'pattern', label: '반복 관측 패턴' },
  'AI 해석': { cls: 'ai', label: 'AI 해석' },
  '전제 조건 · 기준값': { cls: 'cond', label: '전제 조건 · 기준값' },
  '전제 조건': { cls: 'cond', label: '전제 조건' },
  '반례 · 대체 시나리오': { cls: 'counter', label: '반례 · 대체 시나리오' },
  '다음 액션': { cls: 'action', label: '다음 액션' },
};

/**
 * 인라인 문법: **굵게** · `코드` · [이름](https://…) · 맨 URL(https://…) · _기울임_.
 * 기울임은 단어 경계의 밑줄만 본다 (snake_case · kw_6 같은 식별자는 그대로). 뒤보기(lookbehind) 없이 앞 글자를 캡처해 오래된 브라우저에서도 동작한다.
 */
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:[^)\s]+)\)|https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"_]|(^|[^A-Za-z0-9_])_(\S(?:[^_\n]*?\S)?)_(?![A-Za-z0-9_]))/g;

export function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (!tok) { re.lastIndex++; continue; }
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[4] !== undefined) {
      // _기울임_ — 앞 글자(공백 · 문장부호)는 그대로 두고 안쪽은 다시 인라인 처리(링크 · 굵게)
      if (m[3]) out.push(m[3]);
      out.push(<em key={k}>{inline(m[4], `${k}e`)}</em>);
    } else if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\((.+)\)$/);
      out.push(lm ? <a key={k} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a> : tok);
    } else out.push(<a key={k} href={tok} target="_blank" rel="noreferrer">{tok}</a>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 인용(>) 블록 — 전역 스타일 없이 CSS 변수만 쓴다 */
const QUOTE_STYLE = { margin: '0 0 8px', padding: '2px 0 2px 10px', borderLeft: '3px solid var(--line-strong)', color: 'var(--ink-2)' } as const;

function renderBlocks(lines: string[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let table: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(<blockquote key={`${keyBase}-q${out.length}`} style={QUOTE_STYLE}>{inline(quote.join(' '), `${keyBase}-q${out.length}`)}</blockquote>);
    quote = [];
  };
  const flushPara = () => {
    if (para.length) out.push(<p key={`${keyBase}-p${out.length}`}>{inline(para.join(' '), `${keyBase}-p${out.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(<ul key={`${keyBase}-u${out.length}`}>{list.map((l, i) => <li key={i}>{inline(l, `${keyBase}-l${i}`)}</li>)}</ul>);
    list = [];
  };
  const flushTable = () => {
    if (table.length >= 2) {
      const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r.replace(/\|/g, '|').trim())).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const [head, ...body] = rows;
      out.push(
        <table key={`${keyBase}-t${out.length}`}>
          <thead><tr>{head.map((h, i) => <th key={i}>{inline(h, `${keyBase}-th${i}`)}</th>)}</tr></thead>
          <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `${keyBase}-td${ri}${ci}`)}</td>)}</tr>)}</tbody>
        </table>,
      );
    } else if (table.length) {
      para.push(...table);
    }
    table = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushTable(); flushPara(); flushList(); if (q[1].trim()) quote.push(q[1].trim()); else flushQuote(); continue; }
    flushQuote();
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); table.push(line.trim()); continue; }
    flushTable();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(<h4 key={`${keyBase}-h${out.length}`}>{inline(h[1], `${keyBase}-h${out.length}`)}</h4>); continue; }
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { flushPara(); list.push(li[1]); continue; }
    flushList();
    para.push(line.trim());
  }
  flushQuote(); flushTable(); flushPara(); flushList();
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  // 존 단위로 분할
  const sections: { zone: string | null; lines: string[] }[] = [{ zone: null, lines: [] }];
  for (const l of lines) {
    const h = l.match(/^#{2,4}\s+(.+?)\s*$/);
    const zoneKey = h ? Object.keys(ZONE_CLASS).find((k) => h[1].replace(/[*_]/g, '').trim().startsWith(k)) : undefined;
    if (zoneKey) sections.push({ zone: zoneKey, lines: [] });
    else sections[sections.length - 1].lines.push(l);
  }
  return (
    <div className="md stack" style={{ gap: 10 }}>
      {sections.map((s, i) => {
        if (!s.zone) {
          const blocks = renderBlocks(s.lines, `s${i}`);
          return blocks.length ? <Fragment key={i}>{blocks}</Fragment> : null;
        }
        const z = ZONE_CLASS[s.zone];
        return (
          <div key={i} className={`zone ${z.cls}`}>
            <div className="zone-label">{z.label}</div>
            <div>{renderBlocks(s.lines, `s${i}`)}</div>
          </div>
        );
      })}
    </div>
  );
}
