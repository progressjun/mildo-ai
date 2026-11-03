/**
 * 경량 마크다운 렌더러 — 리포트 보관함 서랍에서 인용(>) · 기울임(_…_) · 맨 URL이 문법 기호 그대로 새지 않는다 (QA G3b).
 * 식별자 밑줄(kw_6 · rule_id)은 기울임으로 바꾸지 않는다. 기존 문법(굵게 · 코드 · 링크 · 표 · 목록 · 영역)은 그대로.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

const md = (text: string) => renderToStaticMarkup(h(Markdown, { text }));
/** 태그를 뺀 눈에 보이는 문단 텍스트 */
const visible = (html: string) => html.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);

describe('Markdown', () => {
  it("'> ' 인용 줄은 blockquote로 그리고 '> ' 기호를 보이지 않는다 (연속 줄은 한 블록)", () => {
    const html = md('# 일간 리포트\n> 전일 성과 · 예산 소진 · 주요 변동 · 메신저 · 11/3(화) 08:00 발송분\n> 데이터: TEST DATA (시연용 테스트 데이터)\n\n본문');
    expect(html).toContain('<blockquote');
    expect(html).toContain('전일 성과 · 예산 소진 · 주요 변동 · 메신저 · 11/3(화) 08:00 발송분 데이터: TEST DATA (시연용 테스트 데이터)</blockquote>');
    expect(visible(html).some((l) => l.startsWith('&gt;') || l.startsWith('>'))).toBe(false);
    expect(html).toMatch(/border-left:3px solid var\(--line-strong\)/);
  });

  it('_기울임_은 em으로 · 밑줄 기호를 보이지 않는다 · 안의 URL은 링크', () => {
    const html = md('_성과 증명 장부(MILDO OS Cloud)에서 자동 생성 · 장부 보기: http://localhost:9150/#impact_');
    expect(html).toContain('<em>');
    expect(html).toContain('<a href="http://localhost:9150/#impact" target="_blank" rel="noreferrer">http://localhost:9150/#impact</a>');
    expect(visible(html).join(' ')).not.toMatch(/(^|\s)_|_($|\s)/);
    expect(md('_발송 전 미리보기 · 최근 7일 기준 — 확정 수치는 08:00 발송본_')).toBe('<div class="md stack" style="gap:10px"><p><em>발송 전 미리보기 · 최근 7일 기준 — 확정 수치는 08:00 발송본</em></p></div>');
  });

  it('식별자 밑줄 · 수식은 그대로 (kw_6 · rule_id · a_b_c)', () => {
    const html = md('대상 kw_6 · rule_id · snake_case_name · 2_000원');
    expect(html).not.toContain('<em>');
    expect(html).toContain('kw_6 · rule_id · snake_case_name · 2_000원');
  });

  it('기존 문법 유지: 굵게 · 코드 · 링크 · 목록 · 표 · 영역 · 맨 URL 끝 문장부호 제외', () => {
    const html = md('**회수 배수 —** (계산하지 않음)\n\n- `kw_1` [보관함](https://os.mildo.test/#impact)\n\n| 항목 | 값 |\n| --- | ---: |\n| 광고비 | 0원 |\n\n### 확정 팩트\n- 자세히: https://os.mildo.test/#reports.');
    expect(html).toContain('<strong>회수 배수 —</strong> (계산하지 않음)');
    expect(html).toContain('<code>kw_1</code>');
    expect(html).toContain('<a href="https://os.mildo.test/#impact" target="_blank" rel="noreferrer">보관함</a>');
    expect(html).toContain('<table>');
    expect(html).toContain('class="zone fact"');
    expect(html).toContain('<a href="https://os.mildo.test/#reports" target="_blank" rel="noreferrer">https://os.mildo.test/#reports</a>.');
    expect(md('javascript:alert(1) 링크 아님')).not.toContain('<a ');
  });
});
