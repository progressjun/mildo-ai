/**
 * MILDO OS · SearchTuneOS(#geo) · 매출 성장(#growth) 기능 점검 E2E
 *   NODE_PATH=$(npm root -g) node qa/e2e/geo-growth.e2e.cjs dist-single/index.html
 * 한 줄에 하나씩 'PASS <이름>' / 'FAIL <이름>: <이유>' 를 출력하고, FAIL이 하나라도 있으면 exit 1.
 * claude.ai 런타임은 qa/e2e/harness.cjs 의 모의 런타임(ai · downloads 모드)으로 대체한다.
 * 범위 밖(사용자 API 필요): 네이버 SearchAd 실호출 · Slack 전송 · 'API 키' 모드(api.anthropic.com).
 */
const fs = require('fs');
const { open } = require(require('path').join(__dirname, 'harness.cjs'));

const FILE = process.argv[2];
if (!FILE || !fs.existsSync(FILE)) { console.error('usage: node e2e.cjs <dist/index.html>'); process.exit(2); }

const results = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`PASS ${name}`); }
  catch (e) { results.push([false, name]); console.log(`FAIL ${name}: ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300)}`); }
}
/** 하네스 열기 + 콘솔 에러 없음 확인을 묶은 실행기 */
async function withPage(opts, fn) {
  const h = await open({ file: FILE, ...opts });
  try {
    await fn(h, h.page);
    assert(h.errors.length === 0, `console/page errors: ${h.errors.slice(0, 2).join(' / ')}`);
  } finally { await h.close(); }
}
const go = async (p, route) => { await p.goto(p.url().split('#')[0] + '#' + route); await p.waitForTimeout(700); };
const tab = async (p, mod, idx) => { await p.click(`#${mod}-tabs [role=tab] >> nth=${idx}`); await p.waitForTimeout(350); };
const cardText = (p, title) => p.evaluate((t) => {
  const c = [...document.querySelectorAll('section.card')].find((s) => (s.querySelector(':scope > .card-head .card-title')?.textContent ?? '').startsWith(t));
  return c ? c.innerText.replace(/\n/g, ' | ') : '';
}, title);
const cardLoc = (p, title) => p.locator('section.card').filter({ has: p.locator(':scope > .card-head .card-title', { hasText: title }) }).first();
const state = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/v1') || '{}'));
const closeToasts = async (p) => { for (const b of await p.$$('.toast button[aria-label]')) await b.click().catch(() => {}); };
const paidRow = (p, q) => p.locator('.geo-split .tbl tbody tr', { hasText: q }).first();
const matrixRow = (p, q) => p.locator('.geo-matrix tbody tr', { hasText: q }).first();
const clip = (p) => p.evaluate(() => navigator.clipboard.readText());
/** 숫자 칸: 값 입력 후 포커스 이동(범위 보정은 blur/Enter 시) */
const setNum = async (p, sel, v) => { await p.fill(sel, v); await p.press(sel, 'Tab'); await p.waitForTimeout(250); };
/** 실제 키보드 입력 (전체 선택 후 한 글자씩) */
const typeNum = async (p, sel, v, end = 'Tab') => { await p.click(sel); await p.keyboard.press('Control+A'); await p.keyboard.type(v, { delay: 15 }); await p.waitForTimeout(120); if (end) await p.keyboard.press(end); await p.waitForTimeout(200); return p.inputValue(sel); };

(async () => {
  /* ---------------- 공통: AI 호출 없음 · 화면 품질 ---------------- */
  await check('no AI call on load/tab clicks (geo+growth, artifact)', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    for (let i = 0; i < 5; i++) await tab(p, 'geo', i);
    await go(p, 'growth');
    for (let i = 0; i < 7; i++) await tab(p, 'growth', i);
    const calls = await h.calls();
    assert(calls.length === 0, `calls=${calls.length}`);
  }));

  await check('all tabs render without NaN/undefined/Infinity (ai none)', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    for (const [mod, n] of [['growth', 7], ['geo', 5]]) {
      await go(p, mod);
      for (let i = 0; i < n; i++) {
        await tab(p, mod, i);
        const t = await p.evaluate(() => document.querySelector('main, .content')?.innerText ?? document.body.innerText);
        const bad = ['NaN', 'undefined', 'Infinity', '[object'].filter((w) => t.includes(w));
        assert(!bad.length, `${mod} tab ${i}: ${bad.join(',')}`);
      }
    }
  }));

  /* ---------------- GEO · 제품페이지 진단기 ---------------- */
  await check('geo audit: defect sample < fixed sample score, per-item table', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await tab(p, 'geo', 1);
    const score = async () => p.$eval('.geo-score-num', (e) => e.textContent);
    const s1 = Number(await score());
    const rows = await cardLoc(p, '항목별 판정').locator('tbody tr').count();
    await p.click('button:has-text("개선안 샘플")'); await p.waitForTimeout(500);
    const s2 = Number(await score());
    assert(Number.isFinite(s1) && Number.isFinite(s2) && s1 < 60 && s2 >= 85, `defect=${s1} fixed=${s2}`);
    assert(rows >= 15, `rows=${rows}`);
  }));

  await check('geo audit: empty input → readable empty state (no fail count, no export)', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await tab(p, 'geo', 1);
    await p.click('button:has-text("지우기")'); await p.waitForTimeout(400);
    const t = await cardText(p, '항목별 판정');
    assert(t.includes('진단할 HTML이 없습니다'), 'no empty state');
    assert(!(await cardLoc(p, '항목별 판정').locator('button:has-text(".md 다운로드")').count()), 'download still shown');
    const tabLabel = await p.$eval('#geo-tabs [role=tab]:nth-child(2)', (e) => e.textContent);
    assert(tabLabel === '제품페이지 진단', `tab badge on empty: ${tabLabel}`);
    assert((await p.$eval('.geo-score-num', (e) => e.textContent)) === '—', 'score not —');
  }));

  await check('geo audit: malformed JSON-LD flagged · huge input (1MB) no crash · no script exec', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await tab(p, 'geo', 1);
    await p.fill('#geo-html', '<html><head><title>수면밀도 매트리스 퀸</title><script type="application/ld+json">{ "@type": "Product", "name": "x", </script></head><body><h1>t</h1><img src=a.jpg></body></html>');
    await p.waitForTimeout(500);
    const t = await cardText(p, '항목별 판정');
    assert(/JSON-LD 구문 \| 실패/.test(t.replace(/\t/g, ' | ')) || t.includes('오류 1'), 'syntax error not flagged');
    const base = await p.evaluate(() => document.querySelector('#geo-html').value);
    const huge = base + '<div>' + '<p class="price">1,234,000원</p><img src="x.jpg" onerror="window.__xss=1">'.repeat(14000) + '</div>';
    await p.$eval('#geo-html', (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }, huge);
    await p.waitForFunction(() => /1,0\d\d,\d{3}자/.test(document.querySelector('.geo-html-card')?.textContent ?? ''), null, { timeout: 30000 });
    assert(!(await p.evaluate(() => window.__xss)), 'pasted script executed');
  }));

  await check('geo audit: .md download (artifact accept) + copy to clipboard', () => withPage({ route: 'geo', ai: 'artifact', downloads: 'accept' }, async (h, p) => {
    await tab(p, 'geo', 1);
    await p.click('button:has-text(".md 다운로드")'); await p.waitForTimeout(700);
    const s = (await h.saves()).find((x) => x.filename.endsWith('.md'));
    assert(s && s.bytes > 500 && s.head.startsWith('# SearchTuneOS 제품페이지 진단'), `save=${JSON.stringify(s)}`);
    await p.click('button:has-text("진단 결과 복사")'); await p.waitForTimeout(300);
    assert((await clip(p)).includes('| 축 | 항목 | 판정 |'), 'clipboard missing table');
  }));

  /* ---------------- GEO · 모니터링 매트릭스 ---------------- */
  await check('geo matrix: intent filter changes rows · round switch changes KPI · row select', () => withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
    const n = async () => p.locator('.geo-matrix tbody tr').count();
    assert((await n()) === 20, 'not 20 rows');
    await p.click('.seg[aria-label="구매 의도"] button:has-text("브랜드 방어")'); await p.waitForTimeout(200);
    assert((await n()) === 2, `brand rows=${await n()}`);
    await p.click('.seg[aria-label="구매 의도"] button:has-text("생활 상황")'); await p.waitForTimeout(200);
    assert((await n()) === 6, `life rows=${await n()}`);
    await p.click('.seg[aria-label="구매 의도"] button:has-text("전체")');
    const k1 = await p.$eval('.geo-kpis', (e) => e.innerText);
    await p.click('.seg[aria-label="진단 회차"] button >> nth=0'); await p.waitForTimeout(300);
    const k2 = await p.$eval('.geo-kpis', (e) => e.innerText);
    assert(k1 !== k2 && k2.includes('30.0%'), 'round KPI unchanged');
    await matrixRow(p, '신혼 매트리스 추천').click(); await p.waitForTimeout(200);
    assert((await p.$$eval('h2.card-title', (els) => els.map((e) => e.textContent))).includes("'신혼 매트리스 추천'"), 'detail not opened');
  }));

  await check('geo matrix: CSV/MD export (artifact save; CSV header + Korean)', () => withPage({ route: 'geo', ai: 'artifact', downloads: 'accept' }, async (h, p) => {
    await p.click('button:has-text("CSV")'); await p.waitForTimeout(600);
    await cardLoc(p, '질의 × 엔진 매트릭스').locator('button:has-text(".md")').click(); await p.waitForTimeout(600);
    const sv = await h.saves();
    const csv = sv.find((s) => s.filename.endsWith('.csv'));
    const md = sv.find((s) => s.filename.endsWith('.md'));
    assert(csv && /^﻿?진단일,질의,구매의도,판정/.test(csv.head) && csv.head.includes('Claude(LIVE)'), `csv=${csv && csv.head.slice(0, 80)}`);
    assert(md && md.head.startsWith('# SearchTuneOS GEO 정기 진단'), 'md heading');
  }));

  await check('downloads: ai none → browser download · decline → no error · downloads none → toast', async () => {
    await withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("CSV")')]);
      const buf = fs.readFileSync(await dl.path());
      assert(dl.suggestedFilename().endsWith('.csv') && buf[0] === 0xef && buf.toString('utf8').includes('진단일'), 'browser csv');
    });
    await withPage({ route: 'geo', ai: 'artifact', downloads: 'decline' }, async (h, p) => {
      await p.click('button:has-text("CSV")'); await p.waitForTimeout(600);
      assert((await h.saves()).length === 0, 'saved despite decline');
      assert(!(await p.locator('.toast.critical:has-text("저장")').count()), 'error toast');
    });
    await withPage({ route: 'geo', ai: 'artifact', downloads: 'none' }, async (h, p) => {
      await p.click('button:has-text("CSV")'); await p.waitForTimeout(600);
      assert(await p.locator('.toast:has-text("파일 저장을 지원하지 않습니다")').count(), 'no unavailable toast');
    });
  });

  /* ---------------- GEO · Claude 라이브 진단 ---------------- */
  await check('geo live (artifact): parse into Claude column · URL not counted · cache:false · persists · clear', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await p.evaluate(() => {
      window.__mockText = (input) => {
        const q = typeof input === 'string' ? input : input[input.length - 1].content;
        if (q.includes('후기')) return '참고할 곳은 지누스입니다. 자세한 정보: https://mildo.kr/review , https://www.zinus.com/kr';
        return '많이 비교되는 브랜드는 지누스와 수면밀도입니다. 수면밀도는 경도 선택이 장점입니다. 출처: https://www.zinus.com/ko https://mildo.kr/products/1';
      };
    });
    await matrixRow(p, '퀸 매트리스 추천').click();
    await p.click('button:has-text("선택 질의 진단")');
    await p.waitForFunction(() => !document.body.innerText.includes('진단 중…'), null, { timeout: 10000 });
    const cell = async (q) => matrixRow(p, q).locator('.geo-cell.live').first().textContent();
    assert((await cell('퀸 매트리스 추천')).startsWith('2번째'), `퀸 cell=${await cell('퀸 매트리스 추천')}`);
    await matrixRow(p, '수면밀도 매트리스 후기').locator('input[type=checkbox]').check();
    await matrixRow(p, '신혼 매트리스 추천').locator('input[type=checkbox]').check();
    await p.click('button:has-text("체크한 2개 일괄 진단")');
    await p.waitForFunction(() => !document.body.innerText.includes('진단 중…'), null, { timeout: 15000 });
    await p.waitForTimeout(200);
    assert((await cell('수면밀도 매트리스 후기')).startsWith('인용만'), `URL-only answer counted as mention: ${await cell('수면밀도 매트리스 후기')}`);
    const calls = await h.calls();
    assert(calls.length === 3 && calls.every((c) => c.kind === 'sample' && c.cache === false && c.tools.length === 0), `calls=${JSON.stringify(calls)}`);
    assert(calls[0].inputBytes === Buffer.byteLength('퀸 매트리스 추천'), 'query not sent verbatim');
    assert((await p.$eval('.geo-kpis', (e) => e.innerText)).includes('2/3 질의 언급'), 'KPI not updated');
    await h.reload();
    assert((await cell('퀸 매트리스 추천')).startsWith('2번째'), 'live record not persisted');
    await p.click('button:has-text("기록 지우기")'); await p.waitForTimeout(200);
    assert((await cell('퀸 매트리스 추천')) === '미진단', 'clear failed');
  }));

  await check('geo live: ai none → disabled with reason', () => withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
    const b = p.locator('button:has-text("선택 질의 진단")');
    assert(await b.isDisabled(), 'enabled');
    assert(((await b.getAttribute('title')) || '').includes('AI 미연결'), 'no reason');
  }));

  await check('geo live: denied → Korean message, disabled, no re-request', () => withPage({ route: 'geo', ai: 'denied' }, async (h, p) => {
    await p.click('button:has-text("선택 질의 진단")'); await p.waitForTimeout(800);
    const t = await cardText(p, '라이브 진단 · Claude');
    assert(t.includes('Claude 사용이 허용되지 않아') && t.includes('Claude 사용 불가'), t.slice(0, 200));
    assert(await p.locator('button:has-text("선택 질의 진단")').isDisabled(), 'still enabled');
    await p.waitForTimeout(1500);
    assert((await h.calls()).length === 1, 'retried');
  }));

  await check('geo live: error-mid/rate → message, button usable, no auto retry · slow → stop without error', async () => {
    for (const mode of ['error-mid', 'rate']) {
      await withPage({ route: 'geo', ai: mode }, async (h, p) => {
        await p.click('button:has-text("선택 질의 진단")'); await p.waitForTimeout(900);
        const t = await cardText(p, '라이브 진단 · Claude');
        assert(/일시적인 연결 오류|요청이 많습니다/.test(t), `${mode}: no message`);
        await p.waitForTimeout(1500);
        assert((await h.calls()).length === 1, `${mode}: auto retry`);
        assert(!(await p.locator('button:has-text("선택 질의 진단")').isDisabled()), `${mode}: button disabled`);
      });
    }
    await withPage({ route: 'geo', ai: 'slow' }, async (h, p) => {
      await p.click('button:has-text("선택 질의 진단")'); await p.waitForTimeout(600);
      await cardLoc(p, '라이브 진단').locator('button:has-text("중지")').click(); await p.waitForTimeout(2500);
      const t = await cardText(p, '라이브 진단 · Claude');
      assert(!/오류|중지했습니다/.test(t) && t.includes('선택 질의 진단'), `slow: ${t.slice(0, 200)}`);
    });
  });

  /* ---------------- GEO · AEO FAQ ---------------- */
  await check('geo FAQ: rule template · medical claim blocked · restore · add/delete · JSON-LD copy/.json', () => withPage({ route: 'geo', ai: 'artifact', downloads: 'accept' }, async (h, p) => {
    await tab(p, 'geo', 2);
    assert((await p.locator('.geo-faq').count()) === 12, 'rule items != 12');
    const it = p.locator('.geo-faq').nth(3);
    await it.locator('textarea').fill('이 매트리스는 허리 디스크 치료에 좋습니다.'); await p.waitForTimeout(200);
    assert((await it.innerText()).includes('차단'), 'medical claim not blocked');
    await it.locator('button:has-text("초안으로")').click(); await p.waitForTimeout(200);
    assert((await p.locator('.geo-faq').nth(3).innerText()).includes('게시 가능'), 'restore failed');
    await p.click('button:has-text("문항 추가")'); await p.waitForTimeout(200);
    assert((await p.locator('.geo-faq').count()) === 13, 'add failed');
    await p.locator('.geo-faq').last().locator('button:has-text("삭제")').click(); await p.waitForTimeout(200);
    assert((await p.locator('.geo-faq').count()) === 12, 'delete failed');
    await p.click('button:has-text("JSON-LD 복사")'); await p.waitForTimeout(300);
    const ld = JSON.parse(await clip(p));
    assert(ld['@type'] === 'FAQPage' && ld.mainEntity.length > 0, 'clipboard JSON-LD');
    await p.click('button:has-text(".json")'); await p.waitForTimeout(500);
    const s = (await h.saves()).find((x) => x.filename.endsWith('.json'));
    assert(s && JSON.parse(s.head.length < 300 ? s.head : '{}') !== null, 'json save');
  }));

  await check('geo FAQ AI draft: valid array added (AI tag, review applied) · invalid shape → message, nothing added', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await tab(p, 'geo', 2);
    await p.evaluate(() => { window.__mockJson = () => ({ items: [
      { topic: '경도', q: '수면밀도 매트리스 경도는?', a: '경도 단계는 [경도 단계 입력]입니다.' },
      { topic: '소재', q: '커버는 세탁할 수 있나요?', a: '커버 세탁 방법은 상품 페이지에서 확인하세요.' },
      { topic: '사이즈', q: '디스크에 좋나요?', a: '디스크 치료에 도움이 됩니다.' },
    ] }); });
    await p.click('button:has-text("AI 초안 생성")'); await p.waitForTimeout(1200);
    assert((await p.locator('.geo-faq').count()) === 15, `items=${await p.locator('.geo-faq').count()}`);
    const ai = p.locator('.geo-faq').filter({ has: p.locator('.src.ai') });
    assert((await ai.count()) === 3, 'AI tag');
    assert((await ai.filter({ hasText: '디스크 치료' }).innerText()).includes('차단'), 'AI item not reviewed');
    const calls = await h.calls();
    assert(calls.length === 1 && calls[0].kind === 'json', 'json call');
    await p.evaluate(() => { window.__mockJson = () => ({ foo: 'bar' }); });
    await p.click('button:has-text("AI 초안 생성")'); await p.waitForTimeout(1200);
    assert((await cardText(p, 'AI로 FAQ 초안 추가')).includes('읽지 못했습니다'), 'no invalid message');
    assert((await p.locator('.geo-faq').count()) === 15, 'invalid shape changed items');
  }));

  /* ---------------- GEO · 진단 전후 기록 ---------------- */
  await check('geo case: decimal entry · range validation · non-numeric flag · TEST DATA flag · persists', () => withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
    await tab(p, 'geo', 4);
    await p.fill('#geo-case-brand', '테스트');
    await p.locator('#geo-case-beforeRate').pressSequentially('41.');
    assert((await p.inputValue('#geo-case-beforeRate')) === '41.', 'decimal point dropped');
    await p.locator('#geo-case-beforeRate').pressSequentially('5');
    await p.fill('#geo-case-afterRate', '140'); await p.fill('#geo-case-beforeCites', 'abc'); await p.fill('#geo-case-afterCites', '5');
    await p.waitForTimeout(200);
    const out = await p.$eval('.geo-case-out', (e) => e.textContent);
    assert(out.includes('41.5% → [범위 확인]') && !out.includes('140'), `out=${out}`);
    const t = await cardText(p, '적용 사례');
    assert(t.includes('범위 확인 1개') && t.includes('숫자 아님 1개'), 'validation callouts');
    await p.fill('#geo-case-afterRate', '55'); await p.fill('#geo-case-beforeCites', '3'); await p.waitForTimeout(200);
    await h.reload(); await tab(p, 'geo', 4);
    assert((await p.$eval('.geo-case-out', (e) => e.textContent)).includes('41.5% → 55% (+13.5pp)'), 'not persisted');
    await p.click('button:has-text("데모 스냅샷 값 채우기")'); await p.waitForTimeout(200);
    assert((await p.$eval('.geo-case-out', (e) => e.textContent)).includes('TEST DATA'), 'TEST DATA flag');
    await p.click('button:has-text("문구 복사")'); await p.waitForTimeout(200);
    assert((await clip(p)).includes('TEST DATA · 실제 사례 아님'), 'copy');
    await cardLoc(p, '적용 사례').locator('button:has-text("지우기")').click(); await p.waitForTimeout(200);
    assert((await p.$eval('.geo-case-out', (e) => e.textContent)).startsWith('[브랜드]'), 'clear');
  }));

  /* ---------------- GEO · 페이드 AI 지면 → SA ---------------- */
  await check('geo paid → SA request: pending in Flow (AE) · dblclick no dup · toast 바로 가기 · AE approve → reflects', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await closeToasts(p);
    await tab(p, 'geo', 3);
    await paidRow(p, '매트리스 경도 고르는 법').locator('button:has-text("등록 요청")').dblclick(); await p.waitForTimeout(400);
    const geo = (await state(p)).changes.filter((c) => c.module === 'geo');
    assert(geo.length === 1 && geo[0].approver === 'AE' && geo[0].status === 'pending' && geo[0].targetId === 'term:매트리스 경도 고르는 법', JSON.stringify(geo));
    await p.locator('.toast:has-text("SA 테스트 그룹 등록 요청") button:has-text("바로 가기")').click(); await p.waitForTimeout(700);
    assert(p.url().endsWith('#flow'), 'toast nav');
    const card = p.locator('.flow-card', { hasText: '매트리스 경도 고르는 법' }).first();
    assert(await card.count(), 'not in Flow');
    await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(200);
    await card.click(); await p.waitForTimeout(400);
    await p.locator('.drawer button:has-text("승인")').first().click(); await p.waitForTimeout(300);
    await p.keyboard.press('Escape');
    await go(p, 'geo'); await tab(p, 'geo', 3);
    assert((await paidRow(p, '매트리스 경도 고르는 법').locator('td').last().innerText()).includes('승인됨'), 'status not reflected');
    await go(p, 'lab');
    await p.click('[role=tab]:has-text("테스트 파이프라인")'); await p.waitForTimeout(500);
    assert((await p.evaluate(() => document.body.innerText)).includes('매트리스 경도 고르는 법'), 'not visible in Lab pipeline');
  }));

  await check('geo paid: brand term → PM approver · AE cannot approve · cross-module dup guard (Flow seed / AD Pilot)', () => withPage({ route: 'adpilot', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    // AD Pilot에서 먼저 올린 검색어
    const ap = p.locator('tr', { hasText: '첫 자취 매트리스 추천' }).filter({ has: p.locator('button:has-text("승인 요청")') }).first();
    await ap.locator('button:has-text("승인 요청")').click(); await p.waitForTimeout(300);
    await go(p, 'geo'); await tab(p, 'geo', 3);
    assert((await paidRow(p, '첫 자취 매트리스 추천').locator('td').last().innerText()).includes('AD Pilot에서 요청'), 'AD Pilot request not detected');
    // MILDO Flow 시연 이력(Lab 등록 '밀도 매트리스 경도')과 같은 브랜드 검색어 → 다시 요청할 수 없어야 함
    assert((await paidRow(p, '밀도 매트리스 경도').locator('td').last().innerText()).includes('MILDO Lab에서 요청'), 'Flow seed registration not detected (duplicate possible)');
    // 브랜드 검색어 등록 요청의 승인 주체: payload 규칙(PM) — 다른 브랜드 행이 없으므로 Flow seed를 반려한 뒤 재요청
    await go(p, 'flow');
    const seed = p.locator('.flow-card', { hasText: '밀도 매트리스 경도' }).first();
    await seed.click(); await p.waitForTimeout(300);
    await p.fill('#flow-note', '중복 정리');
    await p.locator('.drawer button:has-text("반려")').first().click(); await p.waitForTimeout(150);
    await p.locator('.drawer button:has-text("확인")').first().click(); await p.waitForTimeout(300);
    await p.keyboard.press('Escape');
    await go(p, 'geo'); await tab(p, 'geo', 3);
    await paidRow(p, '밀도 매트리스 경도').locator('button:has-text("등록 요청")').click(); await p.waitForTimeout(300);
    const b = (await state(p)).changes.find((c) => c.module === 'geo' && c.target === '밀도 매트리스 경도');
    assert(b && b.approver === 'PM' && b.status === 'pending', `brand payload ${JSON.stringify(b)}`);
    await go(p, 'flow');
    await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(200);
    await p.locator('.flow-card', { hasText: '밀도 매트리스 경도' }).filter({ hasText: 'SearchTuneOS' }).first().click(); await p.waitForTimeout(300);
    assert(await p.locator('.drawer button:has-text("승인")').first().isDisabled(), 'AE could approve PM item');
    await p.selectOption('#role-select', 'PM'); await p.waitForTimeout(200);
    assert(!(await p.locator('.drawer button:has-text("승인")').first().isDisabled()), 'PM cannot approve PM item');
  }));

  /* ---------------- GROWTH · 재배분 시뮬레이터 ---------------- */
  await check('growth alloc: slider changes revenue/marginal ROAS · sum 100% · budget clamp · guardrail warning · "—%" never shown', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await tab(p, 'growth', 2);
    const sim = () => cardText(p, '예산 배분 · 한계 효율 재배분 시뮬레이터');
    const before = await sim();
    await p.locator('input.growth-range[aria-label="네이버 SA 비중"]').fill('0.3'); await p.waitForTimeout(300);
    const after = await sim();
    assert(before !== after && after.includes('-4.5%'), 'scenario revenue unchanged');
    const sum = await p.$$eval('input.growth-range', (els) => els.reduce((a, e) => a + Number(e.value), 0));
    assert(Math.abs(sum - 1) < 0.01, `sum=${sum}`);
    const tbl = await cardText(p, '매체별 배분 · 예상 결과');
    assert(tbl.includes('하한 미달'), 'guard flag');
    await setNum(p, '#growth-budget', '0'); await p.waitForTimeout(200);
    assert((await p.inputValue('#growth-budget')) === '100000000', 'budget min clamp');
    await setNum(p, '#growth-budget', '1000000000000'); await p.waitForTimeout(300);
    assert(!(await p.evaluate(() => document.body.innerText)).includes('—%'), '"—%" shown');
    await setNum(p, '#growth-budget', '5000000000');
    await setNum(p, '#growth-gmin-naver_sa', '90'); await p.waitForTimeout(300);
    assert((await cardText(p, '매체별 배분 · 예상 결과')).includes('가드레일 입력 확인'), 'no guard warning');
    await setNum(p, '#growth-gmin-naver_sa', '35');
    for (const b of ['데이터 적합', '직접 입력']) { await p.click(`.seg[aria-label="곡선 형태"] button:has-text("${b}")`); await p.waitForTimeout(250); }
    await setNum(p, '#growth-b-naver_sa', '5'); await p.waitForTimeout(200);
    assert((await p.inputValue('#growth-b-naver_sa')) === '0.98', 'b clamp');
    await setNum(p, '#growth-stepcap', '1'); await p.waitForTimeout(200);
    assert((await p.inputValue('#growth-stepcap')) === '5', 'step clamp');
  }));

  await check('growth requests → Flow (CLIENT): realloc/holdout/pilot · dup guard · PM blocked · 수면밀도 approves · reflect · reset clears', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    await tab(p, 'growth', 2);
    const opt = p.locator('button:has-text("균등화안 승인 요청")');
    await opt.dblclick(); await p.waitForTimeout(300);
    assert(await opt.isDisabled(), 'optimized not guarded');
    await tab(p, 'growth', 3);
    await p.locator('button:has-text("홀드아웃 승인 요청")').dblclick(); await p.waitForTimeout(300);
    assert(await p.locator('text=홀드아웃 요청이 승인 흐름에 있습니다').count(), 'holdout dup text');
    await tab(p, 'growth', 5);
    await p.locator('button:has-text("승인 요청")').first().click(); await p.waitForTimeout(300);
    let g = (await state(p)).changes.filter((c) => c.module === 'growth');
    assert(g.length === 3 && g.every((c) => c.approver === 'CLIENT' && c.status === 'pending'), JSON.stringify(g.map((c) => [c.target, c.approver, c.status])));
    const pb = await p.$$eval('input[id^=growth-pb-]', (els) => els.map((e) => e.id));
    await setNum(p, '#' + pb[0], '300000000'); await p.waitForTimeout(250);
    assert((await cardText(p, '파일럿 계산기')).includes('파일럿 한도 초과'), 'over-cap not flagged');
    assert(await p.$$eval('button', (bs) => bs.filter((b) => b.textContent.trim() === '승인 요청').every((b) => b.disabled)), 'over-cap requests enabled');
    await go(p, 'flow');
    const card = p.locator('.flow-card', { hasText: '신규 매체 파일럿' }).first();
    await card.click(); await p.waitForTimeout(300);
    assert(await p.locator('.drawer button:has-text("승인")').first().isDisabled(), 'PM could approve CLIENT item');
    await p.selectOption('#role-select', '수면밀도'); await p.waitForTimeout(200);
    await p.locator('.drawer button:has-text("승인")').first().click(); await p.waitForTimeout(300);
    g = (await state(p)).changes.filter((c) => c.module === 'growth' && c.kind === 'test' && c.target.includes('파일럿'));
    assert(g[0].status === 'approved', 'approve failed');
    await p.keyboard.press('Escape');
    await go(p, 'growth'); await tab(p, 'growth', 5);
    assert((await cardText(p, '파일럿 계산기')).includes('승인 흐름 · 금액 고정'), 'pilot state not reflected');
    await h.reload();
    assert((await state(p)).changes.filter((c) => c.module === 'growth').length === 3, 'not persisted');
    await p.click('button:has-text("설정")'); await p.waitForTimeout(200);
    await p.click('button:has-text("시연 상태 초기화")'); await p.click('button:has-text("정말 초기화")'); await p.waitForTimeout(700);
    assert((await state(p)).changes.filter((c) => c.module === 'growth').length === 0, 'reset did not clear');
  }));

  await check('growth DA→SA: holdout inputs clamp · unit/metric switch · credit → alloc tab with toggle on', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await tab(p, 'growth', 3);
    const m2 = () => cardText(p, 'METHOD 2');
    const d0 = (await m2()).match(/그룹당 필요 일수 \| ([^|]+)/)?.[1];
    await setNum(p, '#growth-mde', '0'); await p.waitForTimeout(200);
    assert((await p.inputValue('#growth-mde')) === '1', 'mde clamp');
    await setNum(p, '#growth-mde', '5'); await p.waitForTimeout(200);
    const d1 = (await m2()).match(/그룹당 필요 일수 \| ([^|]+)/)?.[1];
    assert(d0 && d1 && d0 !== d1, `days ${d0} → ${d1}`);
    await setNum(p, '#growth-power', '100'); await p.waitForTimeout(200);
    assert((await p.inputValue('#growth-power')) === '99', 'power clamp');
    await p.click('.seg[aria-label="단위"] button:has-text("기간 단위")'); await p.waitForTimeout(200);
    assert((await m2()).includes('ON · OFF 구간별 필요 일수'), 'period unit');
    await p.click('button:has-text("기여 반영 재배분 보기")'); await p.waitForTimeout(400);
    assert((await p.$eval('#growth-tabs [aria-selected=true]', (e) => e.textContent)).startsWith('예산 재배분') && (await p.isChecked('#growth-credit')), 'credit apply');
  }));

  await check('growth overview pillars/signals navigate · funnel/target render · demand weights re-rank · calendar links', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    const sel = () => p.$eval('#growth-tabs [aria-selected=true]', (e) => e.textContent);
    await p.click('.growth-pillar >> nth=2'); await p.waitForTimeout(200);
    assert((await sel()).startsWith('신규 매체'), 'pillar nav');
    await tab(p, 'growth', 0);
    await p.click('.growth-signal >> nth=0 >> button:has-text("열기")'); await p.waitForTimeout(200);
    assert((await sel()) !== '성장 공식 · 과제', 'signal nav');
    await tab(p, 'growth', 4);
    const f = await cardText(p, '단계별 진단 → 액션');
    assert(f.includes('장바구니') && f.includes('우선 개선'), 'funnel');
    await tab(p, 'growth', 1);
    assert((await p.locator('.growth-camp-table tbody tr').count()) === 5, 'SA 5 campaigns');
    await tab(p, 'growth', 5);
    const ranks = () => p.evaluate(() => { const t = [...document.querySelectorAll('section.card')].find((s) => s.querySelector('.card-title')?.textContent.startsWith('신규 매체 발굴')); return [...t.querySelectorAll('tbody tr')].map((r) => r.querySelector('strong').textContent); });
    const r0 = await ranks();
    await setNum(p, '#growth-w-fit', '0'); await setNum(p, '#growth-w-context', '100'); await p.waitForTimeout(300);
    const r1 = await ranks();
    assert(JSON.stringify(r0) !== JSON.stringify(r1), 'weights did not re-rank');
    for (const id of ['fit', 'context', 'measure', 'cost', 'brand']) await setNum(p, `#growth-w-${id}`, '0');
    await p.waitForTimeout(200);
    assert(!(await cardText(p, '신규 매체 발굴')).includes('1순위'), 'rank shown without scores');
    await tab(p, 'growth', 6);
    assert((await p.$$eval('.growth-cal a', (as) => as.length)) > 0, 'calendar links');
  }));

  /* ---------------- AiInsight (모든 AI 모드) ---------------- */
  await check('AiInsight: none → rule brief · artifact → full mock text tagged AI (cache:false) · rate → message + rule · error-mid → partial kept · slow → stop', async () => {
    const MOCK = '### 확정 팩트\n- 모의 응답 끝 ZZEND';
    const titles = [['growth', 0, '성장 과제 해석'], ['growth', 2, '재배분 해석'], ['geo', 0, 'SearchTuneOS 진단 해석']];
    for (const mode of ['none', 'artifact', 'rate', 'error-mid', 'slow']) {
      await withPage({ route: 'growth', ai: mode }, async (h, p) => {
        for (const [mod, idx, title] of titles) {
          if (!p.url().endsWith('#' + mod)) await go(p, mod);
          await p.evaluate((m) => { window.__mockText = () => m; }, MOCK);
          await tab(p, mod, idx);
          const c = cardLoc(p, title);
          const before = (await h.calls()).length;
          await c.locator('.card-head button').first().click();
          if (mode === 'slow') {
            await p.waitForTimeout(600);
            await c.locator('button:has-text("중지")').click(); await p.waitForTimeout(2200);
            const t = await c.innerText();
            assert(!t.includes('오류') && !t.includes('중지했습니다'), `${mode}/${title}: cancel shown as error`);
            continue;
          }
          await p.waitForTimeout(mode === 'none' ? 300 : 900);
          const t = await c.innerText();
          const n = (await h.calls()).length - before;
          if (mode === 'none') assert(n === 0 && t.includes('확정 팩트') && t.includes('규칙 엔진 결과'), `${title}: rule`);
          if (mode === 'artifact') {
            const call = (await h.calls())[before];
            assert(n === 1 && t.includes('ZZEND') && (await c.locator('.src.ai').count()) && call.cache === false, `${title}: artifact`);
          }
          if (mode === 'rate') assert(n === 1 && t.includes('요청이 많습니다') && t.includes('확정 팩트'), `${title}: rate`);
          if (mode === 'error-mid') assert(n === 1 && t.includes('일시적인 연결 오류') && t.includes('확정 팩트'), `${title}: error-mid partial`);
          await p.waitForTimeout(800);
          assert((await h.calls()).length - before === n, `${title}: auto retry`);
          assert(!(await c.locator('.card-head button').first().isDisabled()), `${title}: button not usable`);
        }
      });
    }
  });

  /* ================= 2차 점검 추가 (재개 세션) ================= */
  await check('geo: axis buttons open tabs · monitor copy · gap chip → detail', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    const want = ['제품페이지 진단', 'AEO FAQ 생성기', 'GEO 모니터링', '페이드 AI 지면 → SA'];
    for (let i = 0; i < 4; i++) {
      await p.click(`.geo-axis >> nth=${i}`); await p.waitForTimeout(250);
      const sel = await p.$eval('#geo-tabs [aria-selected=true]', (e) => e.textContent);
      assert(sel.startsWith(want[i]), `axis ${i} → ${sel}`);
    }
    await tab(p, 'geo', 0);
    await cardLoc(p, '질의 × 엔진 매트릭스').locator('button:has-text("진단 결과 복사")').click(); await p.waitForTimeout(300);
    assert((await clip(p)).startsWith('# SearchTuneOS GEO 정기 진단'), 'monitor copy');
    const chip = p.locator('.geo-chips button').nth(1);
    const q = (await chip.textContent()).trim();
    await chip.click(); await p.waitForTimeout(250);
    assert((await p.$$eval('h2.card-title', (els) => els.map((e) => e.textContent))).includes(`'${q}'`), `chip ${q} not opened`);
  }));

  await check('geo AI: rapid double click on 선택 질의 진단 / AI 초안 생성 runs once and completes (2nd click not on 중지)', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await p.evaluate(() => { window.__mockText = () => '수면밀도와 지누스가 있습니다.'; window.__mockJson = () => ({ items: [{ topic: '경도', q: 'Q1?', a: 'A1.' }] }); });
    await p.locator('button:has-text("선택 질의 진단")').dblclick(); await p.waitForTimeout(1200);
    assert((await h.calls()).length === 1, `live calls=${(await h.calls()).length}`);
    assert((await cardText(p, '라이브 진단 · Claude')).includes('라이브 기록 1개'), 'live record not saved (cancelled by 2nd click)');
    await tab(p, 'geo', 2);
    const n0 = await p.locator('.geo-faq').count();
    await p.locator('button:has-text("AI 초안 생성")').dblclick(); await p.waitForTimeout(1200);
    assert((await h.calls()).length === 2, `faq calls=${(await h.calls()).length}`);
    assert((await p.locator('.geo-faq').count()) === n0 + 1, 'FAQ AI draft cancelled by 2nd click');
  }));

  await check('geo live: unavailable → disabled with reason', () => withPage({ route: 'geo', ai: 'unavailable' }, async (h, p) => {
    const b = p.locator('button:has-text("선택 질의 진단")');
    assert(await b.isDisabled() && ((await b.getAttribute('title')) || '').includes('AI 미연결'), 'not disabled');
    await tab(p, 'geo', 2);
    assert(await p.locator('button:has-text("AI 초안 생성")').isDisabled(), 'faq enabled');
    assert((await h.calls()).length === 0, 'calls');
  }));

  await check('geo FAQ: topic filter · add under topic · q edit → JSON-LD · 게시 가능만 toggle · .md copy · .json valid', () => withPage({ route: 'geo', ai: 'artifact', downloads: 'accept' }, async (h, p) => {
    await tab(p, 'geo', 2);
    const segs = await p.$$eval('.seg[aria-label="주제"] button', (b) => b.map((x) => x.textContent));
    for (let i = 1; i < segs.length; i++) {
      await p.click(`.seg[aria-label="주제"] button >> nth=${i}`); await p.waitForTimeout(120);
      const n = Number(segs[i].match(/(\d+)$/)[1]);
      assert((await p.locator('.geo-faq').count()) === n, `${segs[i]} rows`);
    }
    await p.click('.seg[aria-label="주제"] button >> nth=2'); await p.waitForTimeout(120);
    const topic = segs[2].replace(/\s*\d+$/, '');
    await p.click('button:has-text("문항 추가")'); await p.waitForTimeout(150);
    assert((await p.locator('.geo-faq').last().innerText()).startsWith(topic), 'new item not in filtered topic');
    await p.click('.seg[aria-label="주제"] button >> nth=0'); await p.waitForTimeout(120);
    const pub = p.locator('.geo-faq', { hasText: '게시 가능' }).first();
    await pub.locator('input').fill('수정된 질문 ZZQ?'); await p.waitForTimeout(200);
    assert((await p.$eval('pre.geo-code', (e) => e.textContent)).includes('수정된 질문 ZZQ?'), 'q edit not in JSON-LD');
    const sub = () => p.evaluate(() => [...document.querySelectorAll('section.card')].find((x) => x.querySelector('.card-title')?.textContent.startsWith('FAQPage JSON-LD')).querySelector('.card-sub').textContent);
    const s1 = await sub();
    await p.click('label[for="geo-faq-pub"]'); await p.waitForTimeout(200);
    const s2 = await sub();
    assert(s1 !== s2 && await p.locator('text=검수 미통과 문항이 포함되어 있습니다').count(), `toggle ${s1} → ${s2}`);
    const ld = JSON.parse((await p.$eval('pre.geo-code', (e) => e.textContent)).replace(/^<script[^>]*>\n/, '').replace(/\n<\/script>$/, ''));
    assert(ld.mainEntity.every((e) => e.name && e.acceptedAnswer.text), 'empty Q/A in JSON-LD');
    await p.click('button:has-text("FAQ 문서 복사 (.md)")'); await p.waitForTimeout(250);
    const md = await clip(p);
    assert(md.startsWith('# AEO FAQ 초안') && md.includes('## '), 'md copy');
    await p.click('button:has-text(".json")'); await p.waitForTimeout(500);
    const sv = (await h.saves()).find((x) => x.filename.endsWith('.json'));
    assert(sv && sv.bytes > 500 && /"@type": "FAQPage"/.test(sv.head), 'json save');
  }));

  await check('geo FAQ AI: none disabled+reason · denied → blocked msg · rate/error-mid → msg, no retry, usable · slow → stop silent', async () => {
    for (const mode of ['none', 'denied', 'rate', 'error-mid', 'slow']) {
      await withPage({ route: 'geo', ai: mode }, async (h, p) => {
        await tab(p, 'geo', 2);
        const b = p.locator('button:has-text("AI 초안 생성")');
        const card = () => cardText(p, 'AI로 FAQ 초안 추가');
        if (mode === 'none') { assert(await b.isDisabled() && (await card()).includes('AI 미연결'), 'none'); return; }
        await b.click();
        if (mode === 'slow') { await p.waitForTimeout(400); await p.click('button:has-text("중지")'); await p.waitForTimeout(2200); }
        else await p.waitForTimeout(1000);
        await p.waitForTimeout(900);
        const t = await card();
        assert((await h.calls()).length === 1, `${mode}: calls=${(await h.calls()).length}`);
        assert((await p.locator('.geo-faq').count()) === 12, `${mode}: items changed`);
        if (mode === 'denied') assert(t.includes('Claude 사용이 허용되지 않아') && await b.isDisabled(), 'denied');
        if (mode === 'rate') assert(t.includes('요청이 많습니다') && !(await b.isDisabled()), 'rate');
        if (mode === 'error-mid') assert(t.includes('일시적인 연결 오류') && !(await b.isDisabled()), 'error-mid');
        if (mode === 'slow') assert(!/오류|중지했습니다/.test(t) && !(await b.isDisabled()), 'slow');
      });
    }
  });

  await check('geo case: label inputs in text · negative/huge/non-integer → 범위 확인 · 1,200건 · 0/100 boundary', () => withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
    await tab(p, 'geo', 4);
    const out = () => p.$eval('.geo-case-out', (e) => e.textContent);
    await p.fill('#geo-case-brand', '브랜드X'); await p.fill('#geo-case-bl', '2026-03'); await p.fill('#geo-case-al', '2026-06'); await p.fill('#geo-case-eng', '5개 엔진 · 질의 20개');
    await p.fill('#geo-case-beforeRate', '-5'); await p.fill('#geo-case-afterRate', '1e9'); await p.fill('#geo-case-beforeCites', '3.5'); await p.fill('#geo-case-afterCites', '1200');
    await p.waitForTimeout(200);
    const o1 = await out();
    assert(o1.startsWith('브랜드X · 2026-03 → 2026-06 · 5개 엔진 · 질의 20개'), `labels: ${o1}`);
    assert(o1.includes('[범위 확인] → [범위 확인]') && o1.includes('[범위 확인] → 1,200건') && !o1.includes('pp'), `range: ${o1}`);
    await p.fill('#geo-case-beforeRate', '0'); await p.fill('#geo-case-afterRate', '100'); await p.fill('#geo-case-beforeCites', '1000'); await p.fill('#geo-case-afterCites', '12000');
    await p.waitForTimeout(200);
    assert((await out()).includes('0% → 100% (+100.0pp) · 인용 수 1,000건 → 12,000건 (+11,000건, +1100.0%)'), await out());
  }));

  await check('geo paid: detail-panel request (dblclick no dup) · hold/resume/approve/apply/rollback reflect · re-request after rollback', () => withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    await tab(p, 'geo', 3);
    const T = '매트리스 경도 고르는 법';
    await paidRow(p, T).click(); await p.waitForTimeout(250);
    await p.locator('.geo-paid-detail button:has-text("SA 테스트 그룹 등록 요청")').dblclick(); await p.waitForTimeout(300);
    assert((await state(p)).changes.filter((c) => c.module === 'geo').length === 1, 'dup');
    const status = async () => (await paidRow(p, T).locator('td').last().innerText()).trim();
    const act = async (label, note) => {
      await go(p, 'flow');
      await p.locator('.flow-card', { hasText: T }).filter({ hasText: 'SearchTuneOS' }).first().click(); await p.waitForTimeout(350);
      if (note) await p.fill('#flow-note', note);
      await p.locator(`.drawer button:has-text("${label}")`).first().click(); await p.waitForTimeout(200);
      const c = p.locator('.drawer button:has-text("확인")');
      if (await c.count()) { await c.first().click(); await p.waitForTimeout(250); }
      await p.keyboard.press('Escape'); await go(p, 'geo'); await tab(p, 'geo', 3);
      return status();
    };
    await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(150);
    assert((await act('보류', '테스트 보류')) === '보류', 'hold');
    assert((await act('보류 해제')) === '승인 대기', 'resume');
    assert((await act('승인')) === '승인됨', 'approve');
    assert((await act('반영')) === '반영됨', 'apply');
    assert((await act('롤백', '테스트 롤백')) === '등록 요청', 'rollback → requestable');
    await paidRow(p, T).locator('button:has-text("등록 요청")').click(); await p.waitForTimeout(250);
    assert((await status()) === '승인 대기', 're-request');
  }));

  await check('geo audit: defect ↔ fixed ↔ defect buttons · fixed sample has no 실패 · custom edit deselects samples', () => withPage({ route: 'geo', ai: 'none' }, async (h, p) => {
    await tab(p, 'geo', 1);
    const score = () => p.$eval('.geo-score-num', (e) => Number(e.textContent));
    const fails = () => cardLoc(p, '항목별 판정').locator('tbody tr', { hasText: '실패' }).count();
    const s0 = await score(); const f0 = await fails();
    await p.click('button:has-text("개선안 샘플")'); await p.waitForTimeout(400);
    assert((await fails()) === 0 && (await score()) > s0, 'fixed sample');
    await p.click('button:has-text("샘플 HTML (결함 포함)")'); await p.waitForTimeout(400);
    assert((await score()) === s0 && (await fails()) === f0 && f0 >= 5, 'defect again');
    await p.locator('#geo-html').press('End'); await p.locator('#geo-html').type(' '); await p.waitForTimeout(300);
    const cls = await p.$$eval('.geo-html-card .card-head button', (bs) => bs.map((b) => b.className));
    assert(cls.every((c) => !c.includes('primary')), 'sample still highlighted after edit');
  }));

  await check('geo reset: 시연 상태 초기화 clears Claude live records · case inputs (mounted) · mildo-os:reset event clears storage', () => withPage({ route: 'geo', ai: 'artifact' }, async (h, p) => {
    await p.evaluate(() => { window.__mockText = () => '수면밀도와 지누스'; });
    await p.click('button:has-text("선택 질의 진단")'); await p.waitForTimeout(800);
    await tab(p, 'geo', 4); await p.click('button:has-text("데모 스냅샷 값 채우기")'); await p.waitForTimeout(200);
    await p.click('button:has-text("설정")'); await p.waitForTimeout(200);
    await p.click('button:has-text("시연 상태 초기화")'); await p.click('button:has-text("정말 초기화")'); await p.waitForTimeout(800);
    // 초기화는 열려 있던 화면을 다시 마운트한다(resetSeq) — 첫 탭으로 돌아오므로 사례 탭을 다시 연다
    await tab(p, 'geo', 4);
    assert((await p.$eval('.geo-case-out', (e) => e.textContent)).startsWith('[브랜드]'), 'case not cleared');
    assert((await p.$eval('.geo-kpis', (e) => e.innerText)).includes('진단 기록 없음'), 'live not cleared');
    await h.reload();
    assert((await p.$eval('.geo-kpis', (e) => e.innerText)).includes('진단 기록 없음'), 'live came back after reload');
    await p.click('button:has-text("선택 질의 진단")'); await p.waitForTimeout(800);
    await p.evaluate(() => window.dispatchEvent(new Event('mildo-os:reset'))); await p.waitForTimeout(200);
    assert((await p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/geo/live/v1') || '[]').length)) === 0, 'event did not clear storage');
    assert((await p.$eval('.geo-kpis', (e) => e.innerText)).includes('진단 기록 없음'), 'event did not clear screen');
  }));

  await check('growth number fields: real keyboard typing keeps value (budget/stepcap/b/power/hshare) · clamps on blur/Enter', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await tab(p, 'growth', 2);
    assert((await typeNum(p, '#growth-budget', '3000000000')) === '3000000000', `budget typed → ${await p.inputValue('#growth-budget')}`);
    assert((await p.$eval('#growth-budget', (e) => e.parentElement.innerText)).includes('30억'), 'budget not applied');
    assert((await typeNum(p, '#growth-budget', '0')) === '100000000', 'budget min clamp on blur');
    assert((await typeNum(p, '#growth-stepcap', '20')) === '20', 'stepcap 20');
    assert((await typeNum(p, '#growth-stepcap', '500', 'Enter')) === '100', 'stepcap max clamp on Enter');
    await p.click('.seg[aria-label="곡선 형태"] button:has-text("직접 입력")'); await p.waitForTimeout(200);
    assert((await typeNum(p, '#growth-b-naver_sa', '0.75')) === '0.75', `b → ${await p.inputValue('#growth-b-naver_sa')}`);
    await tab(p, 'growth', 3);
    assert((await typeNum(p, '#growth-power', '90')) === '90', `power → ${await p.inputValue('#growth-power')}`);
    assert((await typeNum(p, '#growth-hshare', '30')) === '30', `hshare → ${await p.inputValue('#growth-hshare')}`);
    assert((await typeNum(p, '#growth-alpha', '0')) === '1', 'alpha min clamp');
    assert(!(await p.evaluate(() => document.body.innerText)).includes('NaN'), 'NaN shown');
  }));

  await check('growth alloc: 균등화안 적용 · 가안으로 · scenario request dup guard · step toggle · credit toggle', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    await p.click('button:has-text("재배분 시뮬레이터")'); await p.waitForTimeout(300);
    assert((await p.$eval('#growth-tabs [aria-selected=true]', (e) => e.textContent)).startsWith('예산 재배분'), 'overview button');
    const shares = () => p.$$eval('input.growth-range', (els) => els.map((e) => e.value).join(','));
    const s0 = await shares();
    assert(await p.locator('button:has-text("가안으로")').isDisabled() && await p.locator('button:has-text("시나리오 승인 요청")').isDisabled(), 'baseline buttons');
    await p.click('button:has-text("균등화안 적용")'); await p.waitForTimeout(300);
    const s1 = await shares();
    assert(s1 !== s0, 'equalize not applied');
    const scen = p.locator('button:has-text("시나리오 승인 요청")');
    await scen.dblclick(); await p.waitForTimeout(300);
    const g = (await state(p)).changes.filter((c) => c.module === 'growth');
    assert(g.length === 1 && g[0].approver === 'CLIENT' && g[0].kind === 'budget', JSON.stringify(g));
    assert(await scen.isDisabled() && await p.locator('button:has-text("균등화안 승인 요청")').isDisabled(), 'dup guard (scenario == optimized)');
    await p.click('button:has-text("가안으로")'); await p.waitForTimeout(250);
    assert((await shares()) === s0, 'reset to proposal');
    await p.click('label[for="growth-step"]'); await p.waitForTimeout(250);
    await p.click('button:has-text("균등화안 적용")'); await p.waitForTimeout(250);
    assert((await shares()) !== s1, 'step cap toggle had no effect');
    const t0 = await cardText(p, '매체별 배분 · 예상 결과');
    await p.click('label[for="growth-credit"]'); await p.waitForTimeout(250);
    assert(await p.isChecked('#growth-credit') && (await cardText(p, '매체별 배분 · 예상 결과')) !== t0, 'credit toggle');
  }));

  await check('growth DA→SA: metric/hshare/alpha change outputs · per-unit holdout dup · 수면밀도 reject → re-requestable', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    await tab(p, 'growth', 3);
    const pick = async () => (await cardText(p, 'METHOD 2')).match(/(필요 일수) \| ([^|]+)/)?.[2];
    const d0 = await pick();
    await p.click('.seg[aria-label="지표"] button >> nth=1'); await p.waitForTimeout(200);
    const d1 = await pick();
    await setNum(p, '#growth-hshare', '20'); const d2 = await pick();
    await setNum(p, '#growth-alpha', '10'); const d3 = await pick();
    assert(new Set([d0, d1, d2, d3]).size === 4, `outputs ${[d0, d1, d2, d3]}`);
    await p.click('.seg[aria-label="단위"] button >> nth=1'); await p.waitForTimeout(200);
    await p.click('button:has-text("홀드아웃 승인 요청")'); await p.waitForTimeout(250);
    await p.click('.seg[aria-label="단위"] button >> nth=2'); await p.waitForTimeout(200);
    assert(await p.locator('button:has-text("홀드아웃 승인 요청")').count(), 'other unit blocked');
    await p.click('.seg[aria-label="단위"] button >> nth=1'); await p.waitForTimeout(200);
    assert(!(await p.locator('button:has-text("홀드아웃 승인 요청")').count()), 'same unit dup');
    await go(p, 'flow');
    await p.selectOption('#role-select', '수면밀도'); await p.waitForTimeout(150);
    await p.locator('.flow-card', { hasText: '홀드아웃' }).first().click(); await p.waitForTimeout(300);
    await p.fill('#flow-note', '기간 조정 후 재요청');
    await p.locator('.drawer button:has-text("반려")').first().click(); await p.waitForTimeout(150);
    const c = p.locator('.drawer button:has-text("확인")'); if (await c.count()) await c.first().click();
    await p.waitForTimeout(250); await p.keyboard.press('Escape');
    assert((await state(p)).changes.find((x) => x.module === 'growth').status === 'rejected', 'not rejected');
    await go(p, 'growth'); await tab(p, 'growth', 3);
    await p.click('.seg[aria-label="단위"] button >> nth=1'); await p.waitForTimeout(200);
    assert(await p.locator('button:has-text("홀드아웃 승인 요청")').count(), 'not re-requestable after reject');
  }));

  await check('growth demand: score clamp 1–5 + re-rank · budget 0 disables request · pilot dblclick stays on page, 1 request', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    await tab(p, 'growth', 5);
    const ranks = () => p.evaluate(() => { const t = [...document.querySelectorAll('section.card')].find((s) => s.querySelector('.card-title')?.textContent.startsWith('신규 매체 발굴')); return [...t.querySelectorAll('tbody tr')].map((r) => r.querySelector('strong').textContent); });
    const r0 = await ranks();
    const last = r0[r0.length - 1];
    const ids = await p.evaluate((nm) => { const t = [...document.querySelectorAll('section.card')].find((s) => s.querySelector('.card-title')?.textContent.startsWith('신규 매체 발굴')); const r = [...t.querySelectorAll('tbody tr')].find((x) => x.querySelector('strong').textContent === nm); return [...r.querySelectorAll('input')].map((i) => i.id); }, last);
    for (const id of ids) await setNum(p, '#' + id, '9');
    assert((await p.inputValue('#' + ids[0])) === '5', 'max clamp');
    assert((await ranks())[0] === last, 're-rank');
    await setNum(p, '#' + ids[0], '0'); assert((await p.inputValue('#' + ids[0])) === '1', 'min clamp');
    await setNum(p, '#' + ids[0], '3.6'); assert((await p.inputValue('#' + ids[0])) === '4', 'round');
    const pilot = cardLoc(p, '파일럿 계산기');
    const row = pilot.locator('tbody tr').filter({ has: p.locator('button:has-text("승인 요청"):not([disabled])') }).first();
    const name = (await row.locator('strong').first().textContent()).trim();
    await row.locator('input').fill('0'); await row.locator('input').press('Tab'); await p.waitForTimeout(250);
    const r2 = pilot.locator('tbody tr', { hasText: name }).first();
    assert(await r2.locator('button:has-text("승인 요청")').isDisabled(), 'budget 0 still requestable');
    const b = pilot.locator('button:has-text("승인 요청"):not([disabled])').first();
    await b.dblclick(); await p.waitForTimeout(500);
    assert(p.url().endsWith('#growth'), `navigated to ${p.url().split('#')[1]}`);
    assert((await state(p)).changes.filter((c) => c.module === 'growth').length === 1, 'pilot dup');
  }));

  await check('growth partner: every link navigates · calendar growth links open the matching tab', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await tab(p, 'growth', 6);
    const links = await p.$$eval('.growth-page a[href^="#"]', (as) => as.map((a) => [a.getAttribute('href'), a.textContent]));
    assert(links.length >= 8, `links=${links.length}`);
    for (const [href, label] of links) {
      if (href === '#growth') {
        await p.locator('.growth-page a', { hasText: label }).first().click(); await p.waitForTimeout(250);
        const sel = await p.$eval('#growth-tabs [aria-selected=true]', (e) => e.textContent);
        assert(sel !== '줄인 시간 · 매체 협력 · 캘린더' && p.url().endsWith('#growth'), `${label}: dead link`);
        await tab(p, 'growth', 6);
        continue;
      }
      await p.locator(`.growth-page a[href="${href}"]`).first().click(); await p.waitForTimeout(400);
      assert(p.url().endsWith(href), `${label} → ${p.url()}`);
      await go(p, 'growth'); await tab(p, 'growth', 6);
    }
  }));

  await check('AiInsight remaining tabs (target · dasa · funnel · demand) × none/artifact/denied/unavailable', async () => {
    const T = [[1, '타겟 · 캠페인 구조 해석'], [3, 'DA → SA 기여 해석'], [4, '전환 개선 해석'], [5, '새 수요 해석']];
    for (const mode of ['none', 'artifact', 'denied', 'unavailable']) {
      await withPage({ route: 'growth', ai: mode }, async (h, p) => {
        await p.evaluate(() => { window.__mockText = () => '### 확정 팩트\n- 모의 응답 끝 ZZEND'; });
        for (const [idx, title] of T) {
          await tab(p, 'growth', idx);
          const c = cardLoc(p, title);
          const before = (await h.calls()).length;
          await c.locator('.card-head button').first().click(); await p.waitForTimeout(900);
          const t = await c.innerText();
          const n = (await h.calls()).length - before;
          if (mode === 'artifact') assert(n === 1 && t.includes('ZZEND') && (await c.locator('.src.ai').count()) && (await h.calls())[before].cache === false, `${title}: artifact`);
          else assert(t.includes('확정 팩트') && t.includes('규칙 엔진') && n <= (mode === 'denied' && idx === 1 ? 1 : 0), `${mode}/${title}: n=${n}`);
          if (mode === 'denied' && idx === 1) assert(t.includes('허용되지 않'), 'denied message');
          await p.waitForTimeout(400);
          assert((await h.calls()).length - before === n, `${title}: auto retry`);
          assert(!(await c.locator('.card-head button').first().isDisabled()), `${title}: button unusable`);
        }
      });
    }
  });

  await check('no AI call on load/tab clicks in unavailable/denied modes either', async () => {
    for (const mode of ['denied', 'unavailable', 'slow']) {
      await withPage({ route: 'geo', ai: mode }, async (h, p) => {
        for (let i = 0; i < 5; i++) await tab(p, 'geo', i);
        await go(p, 'growth');
        for (let i = 0; i < 7; i++) await tab(p, 'growth', i);
        assert((await h.calls()).length === 0, `${mode}: calls=${(await h.calls()).length}`);
      });
    }
  });

  await check('in-module links (growth target/alloc/dasa/funnel/demand · geo paid detail) navigate to their module', () => withPage({ route: 'growth', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    // 승인 흐름 링크가 보이도록 요청 1건씩 (균등화안 · 홀드아웃)
    await tab(p, 'growth', 2); await p.click('button:has-text("균등화안 승인 요청")'); await p.waitForTimeout(250);
    await tab(p, 'growth', 3); await p.click('button:has-text("홀드아웃 승인 요청")'); await p.waitForTimeout(250);
    await closeToasts(p);
    const plan = [['growth', 1], ['growth', 2], ['growth', 3], ['growth', 4], ['growth', 5], ['geo', 3]];
    let n = 0;
    for (const [mod, idx] of plan) {
      await go(p, mod); await tab(p, mod, idx);
      const links = await p.$$eval(`.${mod}-page a[href^="#"]`, (as) => as.map((a) => a.getAttribute('href')));
      for (let i = 0; i < links.length; i++) {
        if (links[i] === `#${mod}`) continue;
        await go(p, mod); await tab(p, mod, idx);
        await p.locator(`.${mod}-page a[href^="#"]`).nth(i).click(); await p.waitForTimeout(350);
        assert(p.url().endsWith(links[i]), `${mod}/${idx} link ${links[i]} → ${p.url().split('#')[1]}`);
        assert(await p.locator('h1').count(), `${links[i]} no page title`);
        n++;
      }
    }
    assert(n >= 9, `links clicked=${n}`);
  }));

  const failed = results.filter((r) => !r[0]).length;
  console.log(`SUMMARY ${results.length - failed}/${results.length} PASS${failed ? ` · ${failed} FAIL` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
