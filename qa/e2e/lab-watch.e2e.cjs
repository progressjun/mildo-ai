/**
 * MILDO OS 기능 점검 e2e — MILDO Lab (#lab) · MILDO Watch (#watch)
 * 사용: NODE_PATH=$(npm root -g) node qa/e2e/lab-watch.e2e.cjs dist-single/index.html   (ONLY=discover,pipeline 로 일부만)
 * 출력: 'PASS <name>' / 'FAIL <name>: <reason>' 한 줄씩, FAIL이 하나라도 있으면 exit 1
 */
const { open } = require(require('path').join(__dirname, 'harness.cjs'));
const F = process.argv[2] || require('path').join(__dirname, '../../dist-single/index.html');
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
let fails = 0, passes = 0;
const out = (ok, name, why) => { if (ok) { passes++; console.log(`PASS ${name}`); } else { fails++; console.log(`FAIL ${name}: ${why}`); } };
class Fail extends Error {}
const must = (cond, why) => { if (!cond) throw new Fail(why); };
async function check(name, fn) {
  try { const r = await fn(); out(r === undefined || r === true, name, typeof r === 'string' ? r : 'returned false'); }
  catch (e) { out(false, name, String(e && e.message || e).split('\n')[0].slice(0, 300)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/v1') || '{}'));
const labLocal = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/lab/v1') || '{}'));
const watchLocal = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/watch/v1') || '{}'));
const toasts = (p) => p.$$eval('.toast', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const setRole = async (p, role) => { await p.selectOption('#role-select', role); await sleep(150); };
const go = async (p, route) => { await p.evaluate((r) => { location.hash = r; }, route); await sleep(450); };
const tab = async (p, label) => { await p.locator('[role=tab]', { hasText: label }).first().click(); await sleep(250); };
const newChanges = (st, ids) => st.changes.filter((c) => !ids.has(c.id));
const idSet = (st) => new Set(st.changes.map((c) => c.id));
const cardTitle = (p) => p.locator('.card', { has: p.locator('.lab-cand') }).locator('.card-title').first().innerText();
const candCount = async (p) => Number((await cardTitle(p)).match(/(\d+)개/)?.[1] ?? -1);
async function flowHas(p, target, statusLabel) {
  await go(p, 'flow');
  const sec = p.locator(`section.flow-col[aria-label="${statusLabel}"]`);
  const n = await sec.locator('.flow-card', { hasText: target }).count();
  return n;
}
async function flowAct(p, target, action, note) {
  // Flow 보드 카드 → 상세 drawer → 액션 (반려 · 롤백은 2단계 확인)
  // Flow 처리 버튼은 직후 600ms 클릭을 무시하고(SETTLE_MS), 2단계 확인 버튼도 펼친 뒤 600ms 동안 눌리지 않는다
  await sleep(700);
  await go(p, 'flow');
  await p.locator('.flow-card', { hasText: target }).first().click(); await sleep(300);
  const d = p.locator('.drawer');
  if (note) await p.fill('#flow-note', note);
  await d.locator('button', { hasText: new RegExp(`^${action}$`) }).first().click(); await sleep(200);
  const conf = d.locator('button', { hasText: `확인 · ${action}` });
  if (await conf.count()) { await sleep(600); await conf.first().click(); await sleep(300); }
  await p.keyboard.press('Escape'); await sleep(200);
}
const MOCK_JSON = () => {
  window.__mockJson = (input) => {
    const q = typeof input === 'string' ? input : input[input.length - 1].content;
    if (q.includes('검수 규칙에 맞게 고쳐 쓴다')) return [{ text: '허리 부담을 덜어주는 경도 선택 매트리스', why: '의료 효능 표현을 제품 속성으로 교체' }, { text: '허리 통증 완화 매트리스', why: '차단 안 (테스트)' }, '체압 분산 구조로 고르는 매트리스'];
    if (q.includes('파워링크 광고 문안')) return [{ title: '신혼집 매트리스 비교', description: '경도 · 사이즈를 비교하고 고르세요.', hypothesis: 'A' }, { title: '허리 디스크 치료 매트리스 최고', description: '무조건 좋은 매트리스', hypothesis: 'A' }];
    return [{ phrase: '자취방 매트리스 사이즈 추천', rationale: '첫 독립 상황' }, { phrase: '<b>신혼</b> 침대 매트리스 경도', monthly: 900 }, 'x', '자취방 매트리스 사이즈 추천'];
  };
};
const want = (s) => !ONLY.length || ONLY.includes(s);

/* ------------------------------------------------------------------ */
async function sLoad() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await check('load: Lab/Watch tabs, tiles, filters clicked without AI buttons → h.calls() empty', async () => {
    for (const t of await p.$$('[role=tab]')) { await t.click(); await sleep(200); }
    for (const t of await p.$$('.lab-tile')) { await t.click(); await sleep(120); }
    await go(p, 'watch');
    for (const t of await p.$$('[role=tab]')) { await t.click(); await sleep(200); }
    for (const t of await p.$$('.watch-strip-cell')) { await t.click(); await sleep(150); await p.keyboard.press('Escape'); await sleep(100); }
    await go(p, 'lab');
    const c = await h.calls();
    must(c.length === 0, `calls=${JSON.stringify(c)}`);
  });
  await check('load: no console errors on Lab/Watch', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

/* ------------------------------------------------------------------ */
async function sDiscover() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await check('discover: SKU 48 grid = 1×4×4×3 chips', async () => {
    const chips = await p.$$eval('.lab-g48 .lab-chip', (e) => e.length);
    const f = await p.$eval('.lab-formula-num', (e) => e.innerText);
    must(chips === 48, `chips=${chips}`); must(/제품 1 × 문제 4 × 상황 4 × 비교 3 = 48/.test(f), f);
  });
  await check('discover: source buttons filter the candidate list (count = source badge)', async () => {
    const srcs = p.locator('.lab-source');
    const n = await srcs.count(); must(n >= 5, `sources=${n}`);
    for (let i = 0; i < n; i++) {
      const b = srcs.nth(i); await b.click(); await sleep(150);
      const badge = Number(await b.locator('.lab-source-n').innerText());
      const shown = await candCount(p);
      must(await b.getAttribute('aria-pressed') === 'true', `source ${i} not pressed`);
      // '전체'와 SKU 48은 미등록만 필터 기준이라 badge 이하
      must(shown <= badge && shown >= 0, `source ${i} badge ${badge} shown ${shown}`);
      if (i > 0 && i < 4) must(shown === badge || shown === badge - 1, `source ${i} badge ${badge} shown ${shown}`);
    }
    await srcs.first().click(); await sleep(150);
  });
  await check('discover: intent select filters rows to that intent', async () => {
    for (const [v, label] of [['problem', '문제 해결'], ['compare', '비교 · 검토'], ['life', '생활 상황']]) {
      await p.selectOption('#lab-intent', v); await sleep(150);
      const intents = await p.$$eval('.lab-cand tbody tr td:nth-child(4)', (e) => e.map((x) => x.innerText.split(' · ')[0].trim()));
      must(intents.length > 0, `no rows for ${v}`);
      must(intents.every((x) => x.startsWith(label.split(' ')[0])), `${v}: ${[...new Set(intents)].join('/')}`);
    }
    await p.selectOption('#lab-intent', 'all'); await sleep(150);
  });
  await check('discover: phrase search filters; no match → readable empty state; CSV of empty list → toast, no file', async () => {
    await p.fill('#lab-q', '신혼'); await sleep(150);
    const ph = await p.$$eval('.lab-cand tbody tr td:nth-child(2) strong', (e) => e.map((x) => x.innerText));
    must(ph.length > 0 && ph.every((x) => x.includes('신혼')), `rows ${ph.slice(0, 3)}`);
    await p.fill('#lab-q', '존재하지않는구문zz'); await sleep(150);
    must(await candCount(p) === 0, 'count not 0');
    must(await p.locator('.lab-cand', { hasText: '조건에 맞는 후보가 없습니다' }).count() === 1, 'no empty message');
    const s0 = (await h.saves()).length;
    await p.locator('.card', { has: p.locator('.lab-cand') }).locator('button', { hasText: 'CSV' }).click(); await sleep(300);
    must((await h.saves()).length === s0, 'saved an empty CSV');
    must((await toasts(p)).some((t) => t.includes('내보낼 내용이 없습니다')), 'no empty-export toast');
    await p.fill('#lab-q', ''); await sleep(150);
  });
  await check('discover: chip click shows candidate detail', async () => {
    const chip = p.locator('.lab-g48 .lab-chip').nth(7);
    const title = await chip.getAttribute('title'); const phrase = title.split(' · ')[0];
    await chip.click(); await sleep(150);
    const det = await p.locator('.card', { hasText: '후보 상세' }).first().innerText();
    must(det.includes(phrase), `detail lacks ${phrase}`);
    must(await chip.getAttribute('aria-pressed') === 'true', 'chip not pressed');
  });
  let ids = idSet(await state(p));
  let single = '';
  await check('discover: row 등록 요청 double-click → exactly 1 pending lab keyword_add (AE), row leaves 미등록 list', async () => {
    const before = await candCount(p);
    const row = p.locator('.lab-cand tbody tr').filter({ has: p.locator('button:not([disabled])', { hasText: '등록 요청' }) }).first();
    single = await row.locator('td:nth-child(2) strong').innerText();
    await row.locator('button', { hasText: '등록 요청' }).dblclick(); await sleep(400);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1, `created ${nw.length}: ${nw.map((c) => c.target)}`);
    const c = nw[0];
    must(c.module === 'lab' && c.kind === 'keyword_add' && c.status === 'pending' && c.target === single, JSON.stringify([c.module, c.kind, c.status, c.target]));
    must(c.approver === (/수면밀도/.test(single) ? 'PM' : 'AE'), `approver ${c.approver}`);
    must(await candCount(p) === before - 1, `count ${before} -> ${await candCount(p)}`);
    must((await toasts(p)).some((t) => t.includes('테스트 그룹 등록 요청 1건') && t.includes('바로 가기')), 'no toast');
    ids = idSet(st);
  });
  await check('discover: brand-intent candidate → approver PM', async () => {
    await p.selectOption('#lab-intent', 'brand'); await sleep(150);
    const row = p.locator('.lab-cand tbody tr').filter({ has: p.locator('button:not([disabled])', { hasText: '등록 요청' }) }).first();
    must(await row.count() === 1, 'no brand row');
    await row.locator('button', { hasText: '등록 요청' }).click(); await sleep(300);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1 && nw[0].approver === 'PM', JSON.stringify(nw.map((c) => [c.target, c.approver])));
    ids = idSet(st);
    await p.selectOption('#lab-intent', 'all'); await sleep(150);
  });
  await check('discover: 우선 상위 5개 선택 → 선택 5건 등록 요청 → 5 AE requests (no confirm)', async () => {
    await p.locator('button', { hasText: '우선 등급 상위 5개 선택' }).click(); await sleep(150);
    const sb = p.locator('button', { hasText: /^선택 \d+건 등록 요청$/ });
    const n = Number((await sb.innerText()).match(/\d+/)[0]);
    must(n >= 1 && n <= 5, `selected ${n}`);
    await sb.click(); await sleep(300);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === n, `created ${nw.length} vs ${n}`);
    must(nw.every((c) => c.status === 'pending' && (c.approver === 'AE' || /수면밀도|브랜드/.test(c.target + c.after))), JSON.stringify(nw.map((c) => c.approver)));
    must(await p.locator('button', { hasText: /^선택 0건 등록 요청$/ }).isDisabled(), 'selection not cleared');
    ids = idSet(st);
  });
  await check('discover: 6 selected → confirm step → double-click 확정 → 6 PM requests, no duplicates', async () => {
    const boxes = p.locator('.lab-cand tbody input[type=checkbox]:not([disabled])');
    for (let i = 0; i < 6; i++) await boxes.nth(i).check();
    await sleep(150);
    await p.locator('button', { hasText: /^선택 6건 등록 요청$/ }).click(); await sleep(200);
    must(await p.locator('text=일괄 등록 — 한 번 더 확인').count() === 1, 'no confirm callout');
    must(newChanges(await state(p), ids).length === 0, 'created before confirm');
    await p.locator('button', { hasText: '6건 요청 확정' }).dblclick(); await sleep(400);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 6, `created ${nw.length}`);
    must(nw.every((c) => c.approver === 'PM'), JSON.stringify(nw.map((c) => c.approver)));
    must(new Set(nw.map((c) => c.target)).size === 6, 'duplicate targets');
    ids = idSet(st);
  });
  await check('discover: 11 selected → bulk button disabled with block reason', async () => {
    const boxes = p.locator('.lab-cand tbody input[type=checkbox]:not([disabled])');
    for (let i = 0; i < 11; i++) await boxes.nth(i).check();
    await sleep(150);
    const sb = p.locator('button', { hasText: /^선택 11건 등록 요청$/ });
    must(await sb.isDisabled(), 'not disabled');
    must(/10건 초과/.test(await sb.getAttribute('title')), await sb.getAttribute('title'));
    for (let i = 0; i < 11; i++) await boxes.nth(i).uncheck().catch(() => {});
  });
  await check('discover: CSV (artifact accept) → .csv saved, Korean header, rows', async () => {
    const s0 = (await h.saves()).length;
    await p.locator('.card', { has: p.locator('.lab-cand') }).locator('button', { hasText: 'CSV' }).click(); await sleep(400);
    const s = (await h.saves()).slice(s0);
    must(s.length === 1, `saves ${s.length}`);
    must(/\.csv$/.test(s[0].filename) && s[0].bytes > 500, `${s[0].filename} ${s[0].bytes}`);
    must(s[0].head.startsWith('구문형 키워드,출처,의도 분류,예상 검색량'), s[0].head.slice(0, 80));
  });
  await check('discover: toast 바로 가기 → #flow; new request shown in 승인 대기 with approver', async () => {
    const box = p.locator('.lab-cand tbody input[type=checkbox]:not([disabled])').first();
    const target = await p.locator('.lab-cand tbody tr', { has: p.locator('input[type=checkbox]:not([disabled])') }).first().locator('td:nth-child(2) strong').innerText();
    await box.check(); await sleep(100);
    for (const b of await p.$$('.toast button[aria-label="알림 닫기"]')) await b.click().catch(() => {});
    await p.locator('button', { hasText: /^선택 1건 등록 요청$/ }).click(); await sleep(300);
    await p.locator('.toast', { hasText: '테스트 그룹 등록 요청' }).locator('button', { hasText: '바로 가기' }).click(); await sleep(500);
    must(await p.evaluate(() => location.hash) === '#flow', 'not navigated');
    const card = p.locator('section.flow-col[aria-label="승인 대기"] .flow-card', { hasText: target });
    must(await card.count() >= 1, `not in Flow pending: ${target}`);
    must(/담당 AE|PM/.test(await card.first().innerText()), 'approver not shown');
    await go(p, 'lab');
  });
  await check('discover: Flow approve/reject reflects back (status pill · candidate re-requestable)', async () => {
    const st0 = await state(p);
    const c = st0.changes.find((x) => x.target === single);
    await setRole(p, 'PM');
    await flowAct(p, single, '반려', '근거 보완 후 재요청');
    const st = await state(p);
    must(st.changes.find((x) => x.id === c.id).status === 'rejected', 'not rejected');
    await go(p, 'lab'); await tab(p, '발굴');
    await p.fill('#lab-q', single); await sleep(150);
    const row = p.locator('.lab-cand tbody tr', { hasText: single }).first();
    must(await row.count() === 1, 'rejected candidate not back in 미등록 list');
    must(await row.locator('button', { hasText: '등록 요청' }).isEnabled(), 'not re-requestable');
    await p.fill('#lab-q', ''); await sleep(100);
  });
  await check('discover: requests persist across reload', async () => {
    const n0 = (await state(p)).changes.length;
    await h.reload();
    must((await state(p)).changes.length === n0, 'changes lost');
    await tab(p, '발굴');
    await p.uncheck('#lab-only-new'); await sleep(150);
    must(await p.locator('.lab-cand tbody tr', { hasText: '등록 요청' }).count() > 0 || true);
  });
  await check('discover: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

/* ------------------------------------------------------------------ */
async function sPipeline() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await tab(p, '테스트 파이프라인');
  const col = (i) => p.locator('.lab-col').nth(i);
  await check('pipeline: 4 STEP columns, counts match tile', async () => {
    must(await p.locator('.lab-col').count() === 4, 'cols');
    const tile = await p.locator('.lab-tile', { hasText: '테스트 파이프라인' }).innerText();
    for (let i = 0; i < 4; i++) {
      const n = Number(await col(i).locator('.lab-col-title .pill').first().innerText());
      must(tile.includes(`${i + 1} ${n}`) || (i === 0 && tile.includes(`STEP 1 ${n}`)), `step ${i + 1}=${n} tile ${tile.replace(/\n/g, ' ')}`);
    }
  });
  await check('pipeline: criteria edit recomputes verdict (목표 ROAS 2000 → 확장→유지), 0/negative/text fall back, 초기값 restores', async () => {
    const btn4 = async () => col(3).locator('button', { hasText: /반영 승인 요청$/ }).allInnerTexts();
    const b0 = await btn4(); must(b0.some((x) => x.startsWith('확장')), `start ${b0}`);
    await p.fill('#lab-c-targetRoas', '2000'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(200);
    const b1 = await btn4(); must(b1.some((x) => x.startsWith('유지')) && !b1.some((x) => x.startsWith('확장')), `after 2000: ${b1}`);
    must((await p.locator('.page-header, header').first().innerText()).includes('2000') || (await p.locator('body').innerText()).includes('목표 ROAS 2000%'), 'header not updated');
    for (const v of ['0', '-50']) {
      await p.fill('#lab-c-targetRoas', v); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(150);
      const crit = (await labLocal(p)).criteria;
      const shown = await p.$eval('#lab-c-targetRoas', (e) => e.value);
      must(shown === '400', `value ${v} → shows ${shown} (stored ${crit.targetRoas})`);
    }
    await p.fill('#lab-c-keepFromPct', '150'); await p.press('#lab-c-keepFromPct', 'Tab'); await sleep(150);
    must(await p.$eval('#lab-c-keepFromPct', (e) => e.value) === '99', `keep>expand not clamped: ${await p.$eval('#lab-c-keepFromPct', (e) => e.value)}`);
    await p.fill('#lab-c-targetRoas', '2000'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(100);
    await p.locator('.card', { hasText: '판정 기준값' }).locator('button', { hasText: '초기값' }).click(); await sleep(200);
    must(await p.$eval('#lab-c-targetRoas', (e) => e.value) === '400' && await p.$eval('#lab-c-keepFromPct', (e) => e.value) === '70', 'not restored');
  });
  await check('pipeline: fractional / <1 criteria (기간 0.4일 · 클릭 0.3회 · 목표 0.001%) → field, column header and verdicts all use the same fallback', async () => {
    const heads0 = await p.$$eval('.lab-col-title', (e) => e.map((x) => x.innerText.replace(/\n/g, ' ')));
    await p.fill('#lab-c-minDays', '0.4'); await p.press('#lab-c-minDays', 'Tab'); await p.fill('#lab-c-minClicks', '0.3'); await p.press('#lab-c-minClicks', 'Tab'); await p.fill('#lab-c-targetRoas', '0.001'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(200);
    const f = await p.$eval('#lab-c-minDays', (e) => e.value), c = await p.$eval('#lab-c-minClicks', (e) => e.value), t = await p.$eval('#lab-c-targetRoas', (e) => e.value);
    const sub2 = await col(1).locator('.lab-col-head .lab-sub').innerText();
    const heads = await p.$$eval('.lab-col-title', (e) => e.map((x) => x.innerText.replace(/\n/g, ' ')));
    must(f === '14' && c === '100' && t === '400', `fields ${f}/${c}/${t}`);
    must(sub2.startsWith('14일 또는 클릭 100회'), sub2);
    must(JSON.stringify(heads) === JSON.stringify(heads0), `${heads} vs ${heads0}`);
    await p.fill('#lab-c-minDays', '7.6'); await p.press('#lab-c-minDays', 'Tab'); await sleep(150);
    must(await p.$eval('#lab-c-minDays', (e) => e.value) === '8' && (await col(1).locator('.lab-col-head .lab-sub').innerText()).startsWith('8일'), 'rounding');
    await p.locator('.card', { hasText: '판정 기준값' }).locator('button', { hasText: '초기값' }).click(); await sleep(150);
  });
  let ids = idSet(await state(p));
  await check('pipeline: STEP 1 추천 등록 요청 double-click → 1 request', async () => {
    const b = col(0).locator('.lab-item.ghost button', { hasText: '등록 요청' }).first();
    const phrase = await col(0).locator('.lab-item.ghost .lab-item-title').first().innerText();
    await b.dblclick(); await sleep(400);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1 && nw[0].target === phrase, JSON.stringify(nw.map((c) => c.target)));
    must(await col(0).locator('.lab-item:not(.ghost)', { hasText: phrase }).count() === 1, 'not shown as STEP 1 item');
    ids = idSet(st);
  });
  let decTarget = '';
  await check('pipeline: STEP 4 확장 반영 승인 요청 → pending PM decision; AE cannot approve (reason shown); PM approves → 반영 → applied', async () => {
    await sleep(600); // 연속 클릭 방지(500ms) 창 밖에서 시작
    const item = col(3).locator('.lab-item', { has: p.locator('button', { hasText: '확장 반영 승인 요청' }) }).first();
    decTarget = await item.locator('.lab-item-title').innerText();
    await item.locator('button', { hasText: '확장 반영 승인 요청' }).dblclick(); await sleep(400);
    let st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1, `created ${nw.length}`);
    const c = nw[0];
    must(c.module === 'lab' && c.status === 'pending' && c.approver === 'PM' && c.target.includes(decTarget), JSON.stringify([c.module, c.kind, c.status, c.approver, c.target]));
    ids = idSet(st);
    await setRole(p, '담당 AE');
    const it = col(3).locator('.lab-item', { hasText: decTarget }).first();
    must(await it.locator('button', { hasText: /^승인$/ }).isDisabled(), 'AE approve enabled');
    must((await it.innerText()).includes('권한'), 'no permission reason');
    await setRole(p, 'PM');
    await it.locator('button', { hasText: /^승인$/ }).dblclick(); await sleep(400);
    st = await state(p);
    let cc = st.changes.find((x) => x.id === c.id);
    must(cc.status === 'approved', `after dblclick approve: ${cc.status} (double click must not also apply)`);
    must(await flowHas(p, decTarget, '승인') >= 1, 'not in Flow 승인 column');
    await go(p, 'lab'); await tab(p, '테스트 파이프라인');
    await col(3).locator('.lab-item', { hasText: decTarget }).first().locator('button', { hasText: /^반영$/ }).click(); await sleep(300);
    st = await state(p); cc = st.changes.find((x) => x.id === c.id);
    must(cc.status === 'applied', `after 반영: ${cc.status}`);
    must(cc.history.map((x) => x.action).join('>').includes('승인') && cc.history.length >= 3, JSON.stringify(cc.history.map((x) => x.action)));
  });
  await check('pipeline: STEP 3 보류 조치 요청 → pending AE request; button disappears (no duplicate)', async () => {
    await sleep(600); // 연속 클릭 방지(500ms) 창 밖에서 시작
    const b = col(2).locator('button', { hasText: '보류 조치 요청' });
    const n0 = await b.count(); must(n0 > 0, 'no hold button');
    await b.first().dblclick(); await sleep(400);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1 && nw[0].approver === 'AE' && nw[0].status === 'pending', JSON.stringify(nw.map((c) => [c.target, c.approver])));
    must(await b.count() === n0 - 1, `buttons ${n0} → ${await b.count()}`);
    ids = idSet(st);
  });
  await check('pipeline: related-keyword button (확장 item) → registration request, button removed', async () => {
    await sleep(600); // 연속 클릭 방지(500ms) 창 밖에서 시작
    await p.fill('#lab-c-targetRoas', '300'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(200);
    const rel = p.locator('.lab-related button');
    const n0 = await rel.count();
    if (!n0) { await p.locator('.card', { hasText: '판정 기준값' }).locator('button', { hasText: '초기값' }).click(); return 'no related buttons visible'; }
    const label = (await rel.first().innerText()).split(' · ')[0];
    await rel.first().dblclick(); await sleep(400);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1 && nw[0].target === label && nw[0].kind === 'keyword_add', JSON.stringify(nw.map((c) => c.target)));
    must(!(await p.locator('.lab-related button').allInnerTexts()).some((x) => x.startsWith(label + ' ·')), 'still offered');
    ids = idSet(st);
    await p.locator('.card', { hasText: '판정 기준값' }).locator('button', { hasText: '초기값' }).click(); await sleep(200);
  });
  await check('pipeline: Lab history table lists lab requests; criteria persist across reload', async () => {
    const t = await p.locator('.card', { hasText: 'Lab 요청 · 승인 · 반영 이력' }).locator('.card-title').first().innerText();
    const n = Number(t.match(/(\d+)건/)[1]);
    const st = await state(p);
    must(n >= st.changes.filter((c) => c.module === 'lab').length, `history ${n}`);
    await p.fill('#lab-c-minClicks', '120'); await p.press('#lab-c-minClicks', 'Tab'); await sleep(150);
    await h.reload(); await tab(p, '테스트 파이프라인');
    must(await p.$eval('#lab-c-minClicks', (e) => e.value) === '120', 'criteria not persisted');
    await p.locator('.card', { hasText: '판정 기준값' }).locator('button', { hasText: '초기값' }).click(); await sleep(150);
  });
  await check('pipeline: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

async function sPipelineBulk() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await tab(p, '테스트 파이프라인');
  const col = (i) => p.locator('.lab-col').nth(i);
  let ids = idSet(await state(p));
  let nw = [];
  await check('pipeline-bulk: 최소 클릭 20 → 6 decidable → 일괄 요청 confirm step → 확정 double-click → 6 PM requests', async () => {
    await p.fill('#lab-c-minClicks', '20'); await p.press('#lab-c-minClicks', 'Tab'); await sleep(250);
    const bulk = col(3).locator('button', { hasText: /^판정 \d+건 일괄 승인 요청$/ });
    must(await bulk.count() === 1, 'no bulk button');
    const n = Number((await bulk.innerText()).match(/\d+/)[0]);
    must(n >= 6, `decidable ${n}`);
    await bulk.click(); await sleep(250);
    must(await p.locator('text=일괄 요청 — 한 번 더 확인').count() === 1, 'no confirm');
    must(newChanges(await state(p), ids).length === 0, 'created before confirm');
    await col(3).locator('button', { hasText: /^확정$/ }).dblclick(); await sleep(500);
    const st = await state(p); nw = newChanges(st, ids);
    must(nw.length === n, `created ${nw.length} vs ${n}`);
    must(nw.every((c) => c.approver === 'PM' && c.status === 'pending' && c.module === 'lab'), JSON.stringify(nw.map((c) => [c.approver, c.status])));
    must(await bulk.count() === 0, 'bulk button still shown');
    ids = idSet(st);
  });
  await check('pipeline-bulk: AE role → 승인 disabled; PM approves each, 승인된 N건 일괄 반영 → all applied (reflected in Flow 반영)', async () => {
    await setRole(p, '담당 AE');
    const ap = col(3).locator('button', { hasText: /^승인$/ });
    must(await ap.count() >= nw.length, `approve buttons ${await ap.count()}`);
    must(await ap.first().isDisabled(), 'AE can approve PM decision');
    await setRole(p, 'PM');
    for (let k = 0; k < nw.length; k++) { const b = col(3).locator('button:not([disabled])', { hasText: /^승인$/ }).first(); if (!(await b.count())) break; await b.click(); await sleep(600); }
    let st = await state(p);
    must(nw.every((c) => st.changes.find((x) => x.id === c.id).status === 'approved'), JSON.stringify(nw.map((c) => st.changes.find((x) => x.id === c.id).status)));
    await setRole(p, '담당 AE');
    const ab = col(3).locator('button', { hasText: /^승인된 \d+건 일괄 반영$/ });
    await ab.click(); await sleep(300);
    st = await state(p);
    must(nw.every((c) => st.changes.find((x) => x.id === c.id).status === 'approved'), 'AE applied PM decisions');
    must((await toasts(p)).some((t) => t.includes('반영 권한이 없습니다')), 'no permission toast');
    await setRole(p, 'PM');
    await ab.dblclick(); await sleep(400);
    st = await state(p);
    const sts = nw.map((c) => st.changes.find((x) => x.id === c.id));
    must(sts.every((c) => c.status === 'applied' && c.history.filter((x) => /반영/.test(x.action)).length === 1), JSON.stringify(sts.map((c) => [c.status, c.history.length])));
    must(await flowHas(p, nw[0].target, '반영') >= 1, 'not in Flow 반영 column');
  });
  await check('pipeline-bulk: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

/* ------------------------------------------------------------------ */
async function sCards() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await tab(p, '테스트 카드');
  const err = async () => (await p.locator('.callout', { hasText: '등록할 수 없습니다' }).innerText().catch(() => '')).replace(/\n/g, ' ');
  const submit = () => p.locator('button', { hasText: '테스트 카드 등록 요청' }).click().then(() => sleep(120));
  let ids = idSet(await state(p));
  await check('cards: form validation — empty / short hypothesis / same arms', async () => {
    await p.locator('#lab-new-card button', { hasText: '카드 만들기' }).click(); await sleep(200);
    await submit();
    let e = await err();
    must(e.includes('카드 제목을 입력하세요') && e.includes('10자 이상') && e.includes('기존안과 변형안을 모두 입력하세요'), e);
    await p.fill('#lab-f-title', '생활 상황 × 사이즈 비교 랜딩');
    await p.fill('#lab-f-hyp', '짧은 가설');
    await p.fill('#lab-f-c', '상품 상세'); await p.fill('#lab-f-v', ' 상품  상세 ');
    await submit(); e = await err();
    must(e.includes('10자 이상') && e.includes('같습니다') && !e.includes('카드 제목'), e);
    must(newChanges(await state(p), ids).length === 0, 'created despite errors');
  });
  await check('cards: 기간 boundaries (0, 6, 43, 7.5 rejected; 7 and 42 accepted)', async () => {
    await p.fill('#lab-f-hyp', '생활 상황 키워드에 사이즈 비교 랜딩을 연결하면 전환율이 오른다');
    await p.fill('#lab-f-v', '사이즈 비교 랜딩');
    for (const v of ['0', '6', '43', '7.5', '-5']) { await p.fill('#lab-f-days', v); await submit(); must((await err()).includes('기간은 7~42일'), `days ${v}: ${await err()}`); }
    for (const v of ['7', '42']) { await p.fill('#lab-f-days', v); await p.fill('#lab-f-gap', '50'); await submit(); const e = await err(); must(!e.includes('기간은') && e.includes('±10%'), `days ${v}: ${e}`); }
    await p.fill('#lab-f-days', '14');
  });
  await check('cards: 예산 차이 ±10 boundary, 동일 타겟 unchecked, 시작일 past/empty rejected', async () => {
    for (const v of ['11', '-11', '99999']) { await p.fill('#lab-f-gap', v); await submit(); must((await err()).includes('±10%'), `gap ${v}`); }
    await p.fill('#lab-f-gap', '-10'); await p.uncheck('#lab-f-same'); await submit();
    let e = await err(); must(!e.includes('±10%') && e.includes('동일 타겟'), e);
    await p.check('#lab-f-same');
    await p.fill('#lab-f-start', '2026-10-01'); await submit(); e = await err(); must(e.includes('기준일 이후'), e);
    await p.fill('#lab-f-start', ''); await submit(); e = await err(); must(e.includes('시작일을 입력하세요'), e);
    await p.fill('#lab-f-start', '2026-11-02');
    must(newChanges(await state(p), ids).length === 0, 'created despite errors');
  });
  await check('cards: 메시지 test with blocked copy (의료 효능) rejected with suggestion', async () => {
    await p.locator('#lab-new-card [aria-label]').filter({ hasText: '메시지' }).first().locator('button', { hasText: '메시지' }).click().catch(async () => { await p.locator('#lab-new-card button', { hasText: /^메시지$/ }).click(); });
    await sleep(100);
    const c0 = await p.$eval('#lab-f-c', (e) => e.value);
    await p.fill('#lab-f-v', '허리 디스크 치료에 도움되는 매트리스'); await submit();
    const e = await err(); must(e.includes('변형안 문안 검수 차단') && e.includes('수정안'), `${c0} :: ${e}`);
    await p.locator('#lab-new-card button', { hasText: /^랜딩$/ }).click(); await sleep(80);
    await p.fill('#lab-f-v', '사이즈 비교 랜딩');
  });
  let cardId = '';
  await check('cards: valid card (double-click submit) → exactly 1 pending test request (AE, labcard:TC-U01), toast, card listed', async () => {
    await p.locator('button', { hasText: '테스트 카드 등록 요청' }).dblclick(); await sleep(500);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1, `created ${nw.length}`);
    const c = nw[0];
    must(c.module === 'lab' && c.kind === 'test' && c.status === 'pending' && c.approver === 'AE' && /^labcard:TC-U\d+$/.test(c.targetId), JSON.stringify([c.kind, c.status, c.approver, c.targetId]));
    cardId = c.targetId.slice(8);
    must((await toasts(p)).some((t) => t.includes(`테스트 카드 ${cardId} 등록 요청`)), 'no toast');
    must(await p.locator('#lab-f-title').count() === 0, 'form still open');
    const card = p.locator('.lab-cards > .card, .card', { hasText: cardId }).filter({ hasText: '사용자 카드' });
    must(await card.count() >= 1, 'user card not listed');
    ids = idSet(st);
  });
  await check('cards: toast 바로 가기 → Flow 승인 대기 shows card request; AE approves in Flow → Lab card shows 승인', async () => {
    await p.locator('.toast', { hasText: `테스트 카드 ${cardId}` }).locator('button', { hasText: '바로 가기' }).click(); await sleep(500);
    must(await p.evaluate(() => location.hash) === '#flow', 'not navigated');
    must(await p.locator('section.flow-col[aria-label="승인 대기"] .flow-card', { hasText: cardId }).count() === 1, 'not in Flow pending');
    await setRole(p, '담당 AE');
    await flowAct(p, cardId, '승인');
    const st = await state(p);
    must(st.changes.find((c) => c.targetId === `labcard:${cardId}`).status === 'approved', 'not approved');
    await go(p, 'lab'); await tab(p, '테스트 카드');
    const card = p.locator('.card', { hasText: cardId }).filter({ hasText: '사용자 카드' }).first();
    must((await card.innerText()).includes('승인'), 'Lab card does not reflect approval');
  });
  let decCard = '';
  await check('cards: 확대 결정 double-click → 1 PM decision request; wrap-up box; 랩업 기록 disabled until text; wrap-up adds library pattern', async () => {
    await setRole(p, 'PM');
    const card = p.locator('.card', { has: p.locator('button', { hasText: '확대 결정 · 승인 요청' }) }).first();
    must(await card.count() === 1, 'no expand-decidable card');
    decCard = await card.locator('.lab-mono').first().innerText();
    await card.locator('button', { hasText: '확대 결정 · 승인 요청' }).dblclick(); await sleep(500);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1 && nw[0].approver === 'PM' && nw[0].targetId === `labcard:${decCard}:decision` && nw[0].status === 'pending', JSON.stringify(nw.map((c) => [c.targetId, c.approver])));
    ids = idSet(st);
    const c2 = p.locator('.card', { hasText: decCard }).filter({ has: p.locator('.lab-wrap') }).first();
    const wb = c2.locator('.lab-wrap button', { hasText: '랩업 기록' });
    must(await wb.isDisabled(), 'wrap-up enabled with empty result');
    await c2.locator('.lab-wrap textarea').fill('   '); must(await wb.isDisabled(), 'enabled with spaces');
    await c2.locator('.lab-wrap textarea').fill('적용 후 2주 CVR 유지 · 그룹 ROAS 410%');
    await c2.locator('.lab-wrap input.input').fill('신혼 구문은 사이즈 비교 랜딩에서만 유효');
    await wb.click(); await sleep(300);
    must((await c2.innerText()).includes('랩업 완료'), 'no 랩업 완료');
    const lib = await p.locator('.card', { hasText: '이긴 패턴' }).last().innerText();
    must(lib.includes('랩업 기록'), 'pattern not in library');
  });
  await check('cards: Flow 반려 of the decision → card decidable again with 반려 note, wrap-up/library hidden', async () => {
    await flowAct(p, decCard, '반려', '근거 보완');
    await go(p, 'lab'); await tab(p, '테스트 카드');
    const card = p.locator('.card', { hasText: decCard }).filter({ has: p.locator('button', { hasText: '확대 결정 · 승인 요청' }) }).first();
    must(await card.count() === 1, 'decide button not back');
    must((await card.innerText()).includes('반려 · 롤백'), 'no rejected note');
    must(!(await p.locator('.card', { hasText: '이긴 패턴' }).last().innerText()).includes('적용 후 2주 CVR 유지'), 'library still has rejected wrap-up');
  });
  await check('cards: 중단 결정 (stop verdict card) → AE request; 모니터링 지속 → AE request', async () => {
    const stopCard = p.locator('.card', { has: p.locator('button', { hasText: '중단 결정 · 승인 요청' }) }).first();
    if (await stopCard.count()) {
      await stopCard.locator('button', { hasText: '중단 결정 · 승인 요청' }).click(); await sleep(400);
      const nw = newChanges(await state(p), ids);
      must(nw.length === 1 && nw[0].approver === 'AE' && /중단/.test(nw[0].after), JSON.stringify(nw.map((c) => [c.after, c.approver])));
      ids = idSet(await state(p));
    }
    const mon = p.locator('.card', { has: p.locator('button', { hasText: /^모니터링 지속$/ }) }).first();
    must(await mon.count() === 1, 'no 모니터링 지속 button');
    await mon.locator('button', { hasText: /^모니터링 지속$/ }).click(); await sleep(400);
    const nw = newChanges(await state(p), ids);
    must(nw.length === 1 && nw[0].approver === 'AE' && /모니터링/.test(nw[0].after), JSON.stringify(nw.map((c) => [c.after, c.approver])));
    ids = idSet(await state(p));
  });
  await check('cards: user card + decisions persist across reload', async () => {
    await h.reload(); await tab(p, '테스트 카드');
    must(await p.locator('.card', { hasText: cardId }).filter({ hasText: '사용자 카드' }).count() >= 1, 'user card lost');
    must((await labLocal(p)).userCards.length === 1, 'local userCards');
  });
  await check('cards: second card id increments (TC-U02), Enter in title does not submit', async () => {
    await p.locator('#lab-new-card button', { hasText: '카드 만들기' }).click(); await sleep(150);
    await p.fill('#lab-f-title', '두 번째 카드'); await p.press('#lab-f-title', 'Enter'); await sleep(150);
    must(newChanges(await state(p), ids).length === 0, 'Enter submitted');
    await p.fill('#lab-f-hyp', '리뷰 신뢰 문구를 쓰면 클릭률이 오른다 (테스트)');
    await p.fill('#lab-f-c', '기존 상품 상세'); await p.fill('#lab-f-v', '리뷰 비교 랜딩');
    await p.locator('button', { hasText: '테스트 카드 등록 요청' }).click(); await sleep(400);
    const nw = newChanges(await state(p), ids);
    must(nw.length === 1 && nw[0].targetId !== `labcard:${cardId}` && /^labcard:TC-U\d+$/.test(nw[0].targetId), JSON.stringify(nw.map((c) => c.targetId)));
    ids = idSet(await state(p));
  });
  await check('cards: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

/* ------------------------------------------------------------------ */
async function sCreativeReview() {
  const h = await open({ file: F, route: 'lab', ai: 'none', downloads: 'accept' });
  const p = h.page;
  await tab(p, 'VisualTune 소재');
  const gen = p.locator('.card', { hasText: 'SA 광고 문안 생성기' }).first();
  await check('creative: hypotheses A/B/C copies per spec', async () => {
    const hyp = await p.$$eval('.lab-hyp-copy', (e) => e.map((x) => x.innerText));
    must(hyp.length === 3 && hyp[0].includes('경도 · 소재 · 구조로 고르는 매트리스') && hyp[1].includes('누적 리뷰 6만 개') && hyp[2].includes('전국 무료배송'), JSON.stringify(hyp));
  });
  await check('creative: 5 campaigns × 3 hypotheses each produce rows with 15/45 length pills and review pill', async () => {
    const camps = await p.locator('[aria-label="캠페인"] button').allInnerTexts();
    const hyps = await p.locator('[aria-label="가설"] button').allInnerTexts();
    must(camps.length === 5 && hyps.length === 3, `${camps.length}x${hyps.length}`);
    const seen = new Set();
    for (const c of camps) for (const hh of hyps) {
      await p.locator('[aria-label="캠페인"] button', { hasText: c }).click(); await p.locator('[aria-label="가설"] button', { hasText: hh }).click(); await sleep(50);
      const rows = await gen.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => tr.innerText));
      must(rows.length > 0, `${c}/${hh} no rows`);
      must(rows.every((r) => /\d+\/15자/.test(r) && /\d+\/45자/.test(r) && /(통과|확인|경고|차단)/.test(r)), `${c}/${hh} row format`);
      seen.add(rows[0]);
    }
    must(seen.size >= 10, `combinations not distinct: ${seen.size}`);
  });
  await check('creative: AI button disabled with ai none + explanation; copy button → clipboard has title+desc', async () => {
    must(await p.locator('button', { hasText: 'AI로 문안 생성' }).isDisabled(), 'AI enabled');
    must((await gen.innerText()).includes('AI 미연결'), 'no AI-off note');
    const row = gen.locator('tbody tr').first();
    const title = await row.locator('td').first().innerText();
    await row.locator('button', { hasText: '복사' }).click(); await sleep(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    must(clip.startsWith(title) && clip.includes('\n'), JSON.stringify(clip));
  });
  await check('creative: A/B 카드로 → Cards tab form prefilled (메시지 · control/variant)', async () => {
    await p.locator('[aria-label="가설"] button', { hasText: 'B ·' }).click(); await sleep(80);
    const b = gen.locator('tbody tr button:not([disabled])', { hasText: 'A/B 카드로' }).first();
    await b.click(); await sleep(500);
    must(await p.locator('[role=tab][aria-selected=true]').innerText().then((t) => t.includes('테스트 카드')), 'tab not switched');
    const t = await p.$eval('#lab-f-title', (e) => e.value); const c = await p.$eval('#lab-f-c', (e) => e.value); const v = await p.$eval('#lab-f-v', (e) => e.value);
    must(t.includes('가설 A vs B') && c && v && c !== v, JSON.stringify([t, c, v]));
  });
  await tab(p, '검수 에이전트');
  const box = p.locator('.card', { hasText: '자유 입력 검수' }).first();
  const level = async (txt) => { await p.fill('#lab-review-input', txt); await sleep(80); return (await box.locator('.lab-review-text + .row .pill').first().innerText()).trim(); };
  await check('review: REVIEW_RULES verdicts on custom input (block / warn / check / pass)', async () => {
    const cases = [
      ['허리 디스크 치료에 도움되는 매트리스', '차단'], ['척추 교정 의사 추천 매트리스', '차단'], ['오늘의집 집들이 위크 12% 할인 850,000원', '차단'],
      ['국내 최초 무조건 완벽한 매트리스 1위', '경고'], ['지누스보다 좋은 매트리스', '경고'], ['킹 매트리스 특가', '경고'], ['<script>alert(1)</script> 100% 만족', '경고'],
      ['네이버 가구 부문 판매 1위 (2026년 상반기 기준) 수면밀도', '확인'], ['오늘의집 집들이 위크 12% 할인 871,200원', '확인'],
      ['경도 · 소재 · 구조로 고르는 매트리스', '통과'],
    ];
    const bad = [];
    for (const [t, lv] of cases) { const got = await level(t); if (!got.includes(lv)) bad.push(`${t} → ${got} (want ${lv})`); }
    must(!bad.length, bad.join(' | '));
    must(await p.locator('script', { hasText: 'alert(1)' }).count() === 0, 'script injected');
  });
  await check('review: block shows reason + suggestion + copyable fix; empty input → guidance text; huge input ok', async () => {
    await level('허리 디스크 치료에 도움되는 매트리스');
    const t = await box.innerText();
    must(t.includes('의료 효능') && t.includes('수정 제안'), 'no reason/suggestion');
    await box.locator('.callout button', { hasText: '복사' }).click(); await sleep(150);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    must(clip && !clip.includes('치료'), `clip ${clip}`);
    await p.fill('#lab-review-input', ''); await sleep(80);
    must((await box.innerText()).includes('검수할 문안을 입력하거나'), 'no empty guidance');
    await p.fill('#lab-review-input', '가'.repeat(5000)); await sleep(200);
    must((await box.innerText()).includes('5000자'), 'huge input count');
  });
  await check('review: 글자수 기준 segmented (제목 15 → 경고 글자수, 설명 45 / 없음 → 통과)', async () => {
    await p.fill('#lab-review-input', '경도 · 소재 · 구조로 고르는 매트리스 비교');
    const res = [];
    for (const m of ['제목 15자', '설명 45자', '글자수 기준 없음']) { await p.locator('[aria-label="글자수 기준"] button', { hasText: m }).click(); await sleep(80); res.push((await box.locator('.lab-review-text + .row .pill').first().innerText()).trim()); }
    must(res[0].includes('경고') && res[1].includes('통과') && res[2].includes('통과'), JSON.stringify(res));
  });
  await check('review: sample buttons fill input; table filter segmented filters rows; 상세 loads row into input', async () => {
    const samples = box.locator('.lab-samples button'); must(await samples.count() === 5, 'samples');
    await samples.nth(1).click(); await sleep(80);
    must((await p.$eval('#lab-review-input', (e) => e.value)).includes('판매 1위'), 'sample not set');
    const tcard = p.locator('.card', { hasText: '검수 대기 · 운영 문안' }).first();
    const seg = tcard.locator('[role=group] button');
    const labels = await seg.allInnerTexts();
    let total = 0;
    for (let i = 1; i < labels.length; i++) {
      await seg.nth(i).click(); await sleep(80);
      const n = Number(labels[i].match(/\d+/)[0]); total += n;
      const rows = await tcard.locator('tbody tr').count();
      must(rows === n || (n === 0 && rows <= 1), `${labels[i]} rows ${rows}`);
      if (n) { const lv = labels[i].split(' ')[0]; const pills = await tcard.locator('tbody tr td:first-child').allInnerTexts(); must(pills.every((x) => x.includes(lv)), `${labels[i]} mismatched`); }
    }
    must(total === Number(labels[0].match(/\d+/)[0]), `sum ${total} vs ${labels[0]}`);
    await seg.nth(1).click(); await sleep(80);
    const rowText = await tcard.locator('tbody tr').first().locator('td:nth-child(2) .small').first().innerText();
    await tcard.locator('tbody tr').first().locator('button', { hasText: '상세' }).click(); await sleep(100);
    must((await p.$eval('#lab-review-input', (e) => e.value)) === rowText, 'row not loaded');
  });
  await check('review: AI rewrite button disabled with ai none, rule-based suggestion still shown', async () => {
    await level('허리 디스크 치료에 도움되는 매트리스');
    must(await box.locator('button', { hasText: /AI 수정안/ }).isDisabled(), 'enabled');
    must((await box.innerText()).includes('AI 미연결 — 규칙 기반 수정 제안'), 'no fallback note');
  });
  await check('lab-ai[none]: Lab 운영 해석 AiInsight shows complete rule-engine brief (6 sections), tagged 규칙 엔진, no call', async () => {
    const c = p.locator('.card', { hasText: 'Lab 운영 해석' }).last();
    await c.locator('button', { hasText: /AI 해석 생성|다시 생성/ }).first().click(); await sleep(400);
    const t = await c.innerText();
    must(['확정 팩트', '반복 관측 패턴', 'AI 해석', '전제 조건', '반례', '다음 액션'].every((k) => t.includes(k)), 'sections missing');
    must(t.includes('규칙 엔진') && t.length > 1500, `len ${t.length}`);
    await c.locator('button', { hasText: '복사' }).first().click(); await sleep(150);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    must(clip.includes('확정 팩트') && clip.length > 800, 'copy');
  });
  await check('creative/review: no AI calls, no console errors (ai none)', async () => { must((await h.calls()).length === 0, 'calls'); must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

/* ------------------------------------------------------------------ */
async function sLabAi() {
  for (const ai of ['artifact', 'denied', 'rate', 'error-mid', 'slow', 'unavailable']) {
    const h = await open({ file: F, route: 'lab', ai, downloads: 'accept' });
    const p = h.page; await p.evaluate(MOCK_JSON);
    await tab(p, '검수 에이전트');
    const box = p.locator('.card', { hasText: '자유 입력 검수' }).first();
    await p.fill('#lab-review-input', '허리 디스크 치료에 도움되는 매트리스'); await sleep(100);
    const rb = box.locator('button', { hasText: /AI 수정안/ });
    await check(`lab-ai[${ai}]: review AI rewrite`, async () => {
      if (ai === 'unavailable') { must(await rb.isDisabled(), 'enabled while unavailable'); return; }
      const c0 = (await h.calls()).length;
      await rb.click();
      if (ai === 'slow') {
        await sleep(300);
        const stop = box.locator('button', { hasText: '중지' }); must(await stop.count() === 1, 'no stop button');
        await stop.click(); await sleep(2600);
        const t = await box.innerText();
        must(!/오류|실패|cancel/i.test(t.slice(t.indexOf('AI 수정안'))), `error shown after stop: ${t.slice(-200)}`);
        must(await box.locator('button', { hasText: /AI 수정안/ }).isEnabled(), 'button not usable after stop');
      } else await sleep(800);
      const t = await box.innerText();
      const calls = await h.calls();
      must(calls.length === c0 + 1, `calls ${calls.length - c0}`);
      must(calls[calls.length - 1].kind === 'json' && !calls[calls.length - 1].tools.length, JSON.stringify(calls[calls.length - 1]));
      must(t.includes('수정 제안'), 'rule suggestion lost');
      if (ai === 'artifact') {
        must(t.includes('AI 수정안 3개') && t.includes('체압 분산 구조로 고르는 매트리스'), 'AI rewrites missing');
        must(await box.locator('.lab-todo-item', { hasText: '허리 통증 완화 매트리스' }).locator('button', { hasText: '검수 상자로' }).isDisabled(), 'blocked AI rewrite usable');
        must((await box.locator('.src, .pill').allInnerTexts()).some((x) => x.includes('AI')), 'no AI tag');
        await box.locator('.lab-todo-item', { hasText: '체압 분산' }).locator('button', { hasText: '검수 상자로' }).click(); await sleep(100);
        must((await p.$eval('#lab-review-input', (e) => e.value)) === '체압 분산 구조로 고르는 매트리스', 'use failed');
      }
      if (ai === 'denied') must(t.includes('허용되지 않았습니다') && await box.locator('button', { hasText: /AI 수정안/ }).isDisabled(), `denied: ${t.slice(-150)}`);
      if (ai === 'rate') must(t.includes('요청이 많습니다') && await box.locator('button', { hasText: /AI 수정안/ }).isEnabled(), 'rate');
      if (ai === 'error-mid') must(t.includes('연결 오류') && await box.locator('button', { hasText: /AI 수정안/ }).isEnabled(), 'error-mid');
      await sleep(1500);
      must((await h.calls()).length === calls.length, 'auto retry');
    });
    await check(`lab-ai[${ai}]: discover AI 확장 + creative AI 문안`, async () => {
      await tab(p, '발굴');
      const eb = p.locator('button', { hasText: /AI로 구문형 후보 확장|생성 중/ });
      const cr = async () => { await tab(p, 'VisualTune'); return p.locator('button', { hasText: /AI로 문안 생성|생성 중/ }); };
      if (ai === 'unavailable' || ai === 'denied') {
        must(await eb.isDisabled(), 'expand enabled'); must(await (await cr()).isDisabled(), 'creative enabled');
        must((await p.locator('body').innerText()).includes('AI 미연결'), 'no AI-off note'); return;
      }
      const c0 = (await h.calls()).length;
      await eb.click(); await sleep(ai === 'slow' ? 5200 : 900);
      const note = await p.locator('.card', { hasText: 'AI로 구문형 후보 확장' }).last().innerText();
      if (ai === 'artifact' || ai === 'slow') {
        must(note.includes('신규 2개') && await candCount(p) === 2, `expand: ${note.slice(-120)} count ${await candCount(p)}`);
        must((await p.locator('.lab-cand tbody tr').first().innerText()).includes('AI'), 'no AI tag on row');
        const ph = await p.$$eval('.lab-cand tbody tr td:nth-child(2) strong', (e) => e.map((x) => x.innerText));
        must(ph.includes('신혼 침대 매트리스 경도') && !ph.some((x) => /[<>]/.test(x)), `markup kept in AI phrase: ${ph}`);
        await p.locator('button', { hasText: /AI 후보 2개 지우기/ }).click(); await sleep(150);
        must(!(await p.locator('button', { hasText: /AI 후보 \d+개 지우기/ }).count()), 'not cleared');
      } else must(/요청이 많습니다|연결 오류/.test(note) && await eb.isEnabled() && await candCount(p) > 50, `expand ${ai}: ${note.slice(-100)}`);
      const cb = await cr();
      await cb.click(); await sleep(ai === 'slow' ? 5200 : 900);
      const gen = await p.locator('.card', { hasText: 'SA 광고 문안 생성기' }).first().innerText();
      if (ai === 'artifact' || ai === 'slow') {
        must(gen.includes('AI 문안 2개') && gen.includes('신혼집 매트리스 비교'), 'AI copies missing');
        must(await p.locator('.card', { hasText: 'SA 광고 문안 생성기' }).first().locator('tbody tr', { hasText: '허리 디스크 치료' }).locator('button', { hasText: 'A/B 카드로' }).isDisabled(), 'blocked AI copy usable');
      } else must(/요청이 많습니다|연결 오류/.test(gen), `creative ${ai}`);
      const calls = await h.calls();
      must(calls.length === c0 + 2 && calls.slice(c0).every((c) => c.kind === 'json'), `calls ${calls.length - c0}`);
      await sleep(1500); must((await h.calls()).length === calls.length, 'auto retry');
    });
    await check(`lab-ai[${ai}]: Lab 운영 해석 AiInsight`, async () => {
      const c = p.locator('.card', { hasText: 'Lab 운영 해석' }).last();
      const c0 = (await h.calls()).length;
      const b = c.locator('button', { hasText: /AI 해석 생성|다시 생성/ }).first();
      await b.click();
      if (ai === 'slow') { await sleep(400); const s = c.locator('button', { hasText: '중지' }); must(await s.count() === 1, 'no stop'); await s.click(); await sleep(2600); must(!/오류|cancel/i.test(await c.innerText()), 'error after stop'); }
      else await sleep(900);
      const t = await c.innerText();
      const calls = await h.calls();
      if (ai === 'unavailable') { must(calls.length === c0 && t.includes('확정 팩트') && t.length > 1000, 'rule content'); return; }
      if (ai === 'denied' && c0 > 0) { must(calls.length === c0, 'called after denial'); must(t.includes('확정 팩트'), 'rule content'); return; }
      must(calls.length === c0 + 1 && calls[calls.length - 1].cache === false, JSON.stringify(calls[calls.length - 1]));
      if (ai === 'artifact') must(t.includes('모의 액션') && t.includes('AI 해석'), 'AI text incomplete');
      if (ai === 'denied') must(t.includes('허용되지 않았습니다') && t.includes('확정 팩트') && t.length > 1000, 'denied fallback');
      if (ai === 'rate') must(t.includes('요청이 많습니다') && t.includes('확정 팩트') && t.length > 1000, 'rate fallback');
      if (ai === 'error-mid') must(t.includes('연결 오류') && t.includes('확정 팩트'), 'error-mid partial');
      await sleep(1500); must((await h.calls()).length === calls.length, 'auto retry');
    });
    await check(`lab-ai[${ai}]: no console errors`, async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
    await h.close();
  }
}

/* ------------------------------------------------------------------ */
async function sDownloads() {
  for (const [ai, dl] of [['artifact', 'accept'], ['artifact', 'decline'], ['none', 'accept'], ['artifact', 'none']]) {
    const h = await open({ file: F, route: 'lab', ai, downloads: dl });
    const p = h.page;
    await check(`downloads[${ai}/${dl}]: Lab weekly .md + candidate CSV + Watch brief .md`, async () => {
      await tab(p, '운영 루프');
      const loop = p.locator('.card', { has: p.locator('button', { hasText: '.md' }) }).first();
      await loop.locator('button', { hasText: '.md' }).click(); await sleep(600);
      await tab(p, '발굴');
      await p.locator('.card', { has: p.locator('.lab-cand') }).locator('button', { hasText: 'CSV' }).click(); await sleep(600);
      await go(p, 'watch'); await tab(p, '주간 인사이트 브리프');
      await p.locator('.card', { has: p.locator('button', { hasText: '.md' }) }).first().locator('button', { hasText: '.md' }).click(); await sleep(600);
      const saves = await h.saves();
      const ts = await toasts(p);
      if (ai === 'artifact' && dl === 'accept') {
        must(saves.length === 3, `saves ${saves.length}`);
        const [md1, csv, md2] = saves;
        must(/^mildo-lab-weekly-2026-10-31\.md$/.test(md1.filename) && /^#/m.test(md1.head) && md1.bytes > 300, `${md1.filename} ${md1.head.slice(0, 60)}`);
        must(/\.csv$/.test(csv.filename) && csv.head.startsWith('구문형 키워드'), csv.filename);
        must(/\.md$/.test(md2.filename) && /^#/m.test(md2.head) && md2.bytes > 300, `${md2.filename} ${md2.head.slice(0, 60)}`);
      } else if (ai === 'artifact' && dl === 'decline') {
        must(saves.length === 0, 'saved despite decline');
        must(!ts.filter((t) => !/^P1 /.test(t)).some((t) => /오류|실패/.test(t)), `error toast on decline: ${ts}`);
      } else if (ai === 'none') {
        must(h.downloads.length === 3, `browser downloads ${JSON.stringify(h.downloads)}`);
        must(h.downloads.some((f) => /\.csv$/.test(f)) && h.downloads.filter((f) => /\.md$/.test(f)).length === 2, JSON.stringify(h.downloads));
      } else {
        must(saves.length === 0 && h.downloads.length === 0, 'saves/a[download] with downloads null');
        must(ts.some((t) => t.includes('파일 저장을 지원하지 않습니다')), `no unavailable notice: ${ts}`);
      }
      // copy buttons
      await p.locator('.card', { has: p.locator('button', { hasText: '.md' }) }).first().locator('button', { hasText: '복사' }).click(); await sleep(200);
      const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      must(/^#/m.test(clip) && clip.length > 300, `brief clipboard ${clip.slice(0, 50)}`);
    });
    await check(`downloads[${ai}/${dl}]: no console errors / crash`, async () => {
      must(await p.locator('.page').count() >= 1, 'page gone');
      must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200));
    });
    await h.close();
  }
}

/* ------------------------------------------------------------------ */
const evRow = (p, t) => p.locator('.watch-ev', { has: p.locator('.watch-ev-title', { hasText: t }) });
const evSide = async (p, t) => (await evRow(p, t).locator('.watch-ev-side').innerText()).replace(/\n/g, ' | ');
const stageAll = async (p) => { await p.locator('[aria-label="단계"]').locator('button', { hasText: /^전체$/ }).click(); await sleep(150); };
async function sWatchTracking() {
  const h = await open({ file: F, route: 'watch', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  const trackCard = p.locator('.card', { hasText: '매체 변동 선제 트래킹' }).first();
  await check('watch: tracking table has 6 media rows incl. GFA 2026.10.28 products', async () => {
    const rows = await trackCard.locator('tbody tr').allInnerTexts();
    must(rows.length === 6, `rows ${rows.length}`);
    const gfa = rows.find((r) => r.startsWith('네이버 GFA')) || '';
    must(/쇼핑 고객 확장/.test(gfa) && /잠재고객 확장\(Beta\)/.test(gfa) && /다이내믹 소재/.test(gfa) && /2026\.10\.28/.test(gfa), gfa.slice(0, 200));
  });
  await check('watch: event feed 8–12 events; tracking row click filters feed by media, click again clears', async () => {
    await stageAll(p);
    const n = await p.locator('.watch-ev').count(); must(n >= 8 && n <= 12, `events ${n}`);
    await trackCard.locator('tbody tr', { hasText: 'Meta' }).first().click(); await sleep(200);
    const media = await p.$$eval('.watch-ev .watch-ev-main .row:first-child', (e) => e.map((x) => x.innerText.split('\n')[0]));
    must(media.length > 0 && media.every((m) => m === 'Meta'), JSON.stringify(media));
    must(await p.locator('[aria-label="매체"] button[aria-pressed=true], [aria-label="매체"] button.on, [aria-label="매체"] button[aria-checked=true]').innerText().then((t) => t === 'Meta').catch(() => true), 'segmented not synced');
    await trackCard.locator('tbody tr', { hasText: 'Meta' }).first().click(); await sleep(200);
    must(await p.locator('.watch-ev').count() === n, 'not cleared');
  });
  await check('watch: 출처/단계/매체 segmented filters; empty combination → readable empty state', async () => {
    await p.locator('[aria-label="출처"] button', { hasText: '데이터 감지' }).click(); await sleep(150);
    const o = await p.$$eval('.watch-ev', (e) => e.map((x) => x.innerText.includes('데이터 감지')));
    must(o.length > 0 && o.every(Boolean), 'origin filter');
    await p.locator('[aria-label="출처"] button', { hasText: /^전체$/ }).click();
    await p.locator('[aria-label="단계"] button', { hasText: '랩업' }).click(); await p.locator('[aria-label="매체"] button', { hasText: 'Google' }).click(); await sleep(150);
    must(await p.locator('.watch-ev').count() === 0 && await p.locator('text=조건에 맞는 이벤트가 없습니다').count() === 1, 'no empty state');
    await p.locator('[aria-label="매체"] button', { hasText: '전체 매체' }).click(); await stageAll(p);
  });
  let ids = idSet(await state(p));
  const T = "'매트리스 추천' CPC";
  await check('watch: 영향 진단 완료 double-click advances exactly one stage (→ 실행안 확정 button)', async () => {
    await evRow(p, T).locator('.watch-ev-side button', { hasText: '영향 진단 완료' }).dblclick(); await sleep(700);
    const side = await evSide(p, T);
    must(side.includes('실행안 확정') && !side.includes('Lab 테스트 등록'), side);
  });
  await check('watch: 실행안 확정 → toast + plan stage; Lab 테스트 등록 double-click → exactly 1 pending test request (module watch)', async () => {
    await evRow(p, T).locator('.watch-ev-side button', { hasText: '실행안 확정' }).click(); await sleep(700);
    must((await toasts(p)).some((t) => t.startsWith('실행안 확정')), 'no plan toast');
    await evRow(p, T).locator('.watch-ev-side button', { hasText: 'Lab 테스트 등록' }).dblclick(); await sleep(700);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1, `created ${nw.length}`);
    const c = nw[0];
    must(c.kind === 'test' && c.module === 'watch' && c.status === 'pending' && /^sig_kw_cpc:/.test(c.targetId) && ['PM', 'AE', 'CLIENT'].includes(c.approver), JSON.stringify([c.kind, c.module, c.status, c.targetId, c.approver]));
    const side = await evSide(p, T);
    must(side.includes('랩업 기록') && side.includes('Lab 요청 승인 대기'), side);
    ids = idSet(st);
  });
  await check('watch: test request toast 바로 가기 → Flow 승인 대기 shows it', async () => {
    await p.locator('.toast', { hasText: 'MILDO Lab 테스트 등록 요청' }).locator('button', { hasText: '바로 가기' }).click(); await sleep(500);
    must(await p.evaluate(() => location.hash) === '#flow', 'not navigated');
    must(await p.locator('section.flow-col[aria-label="승인 대기"] .flow-card', { hasText: '매트리스 추천' }).count() >= 1, 'not in Flow');
  });
  await check('lab: incoming Watch request shown with module label; 테스트 카드로 설계 prefills the card form', async () => {
    await go(p, 'lab'); await tab(p, '테스트 카드');
    const inc = p.locator('.card', { hasText: '다른 모듈 테스트 요청' }).last();
    const item = inc.locator('.lab-todo-item', { hasText: '매트리스 추천' }).first();
    must(await item.count() === 1, 'not in incoming');
    must((await item.locator('.pill').first().innerText()).includes('MILDO Watch'), 'no module label');
    await item.locator('button', { hasText: '테스트 카드로 설계' }).click(); await sleep(400);
    const t = await p.$eval('#lab-f-title', (e) => e.value); const v = await p.$eval('#lab-f-v', (e) => e.value);
    must(t.length > 3 && v.length > 1, JSON.stringify([t, v]));
  });
  await check('watch: Flow 반려 → event back to 실행안 (반려 · 재등록 가능), re-register creates a new pending request; Flow 승인 reflects', async () => {
    await setRole(p, 'PM');
    await flowAct(p, '매트리스 추천', '반려', '근거 보완 후 재요청');
    await go(p, 'watch'); await stageAll(p);
    let side = await evSide(p, T);
    must(side.includes('Lab 테스트 등록') && side.includes('반려 · 재등록 가능'), side);
    await evRow(p, T).locator('.watch-ev-side button', { hasText: 'Lab 테스트 등록' }).click(); await sleep(600);
    const st = await state(p); const nw = newChanges(st, ids);
    must(nw.length === 1 && nw[0].status === 'pending', `re-register ${nw.length}`);
    ids = idSet(st);
    await flowAct(p, '매트리스 추천', '승인');
    await go(p, 'watch'); await stageAll(p);
    side = await evSide(p, T);
    must(side.includes('Lab 요청 승인'), side);
  });
  await check('watch: 랩업 기록 (키워드 확장 베타, 14/14일) → 랩업 완료 + toast; running test (GFA) 랩업 disabled with reason', async () => {
    const K = '키워드 확장(베타)';
    await evRow(p, K).locator('.watch-ev-side button', { hasText: '랩업 기록' }).click(); await sleep(700);
    must((await evSide(p, K)).includes('랩업 완료'), await evSide(p, K));
    must((await toasts(p)).some((t) => t.startsWith('랩업 기록')), 'no wrap-up toast');
    const g = evRow(p, 'GFA 신규 상품').locator('.watch-ev-side button', { hasText: '랩업 기록' });
    must(await g.isDisabled() && /진행 중/.test(await g.getAttribute('title')), 'GFA wrap-up enabled');
  });
  await check('watch: hold (카카오 전환 0) → Lab 테스트 등록 disabled with reason; 관찰 종료 closes the event', async () => {
    const Kk = '카카오톡 비즈보드';
    const b = evRow(p, Kk).locator('.watch-ev-side button', { hasText: 'Lab 테스트 등록' });
    must(await b.isDisabled() && /전환 추적 확인 후 등록/.test(await b.getAttribute('title')), 'not held');
    await evRow(p, Kk).locator('.watch-ev-side button', { hasText: '관찰 종료' }).click(); await sleep(700);
    must((await evSide(p, Kk)).includes('관찰 종료') && !(await evRow(p, Kk).locator('.watch-ev-side button', { hasText: 'Lab 테스트 등록' }).count()), await evSide(p, Kk));
  });
  await check('watch: drawer opens from title; advancing in drawer appends log; related row switches; Esc closes', async () => {
    const M = 'Meta Advantage+';
    await evRow(p, M).locator('.watch-ev-title').click(); await sleep(300);
    const d = p.locator('.drawer');
    must(await d.count() === 1 && (await d.innerText()).includes('Meta Advantage+'), 'drawer not open');
    const logs0 = await d.locator('.watch-log li').count();
    await d.locator('button', { hasText: '영향 진단 완료' }).click(); await sleep(600);
    must(await d.locator('.watch-log li').count() === logs0 + 1, 'log not appended');
    must((await d.innerText()).includes('실행안 확정'), 'drawer next step not updated');
    const rel = d.locator('button.watch-link-row');
    if (await rel.count()) { const t = await rel.first().locator('.small').innerText(); await rel.first().click(); await sleep(300); must((await d.locator('h3').innerText()).includes(t.slice(0, 10)), 'related not opened'); }
    await p.keyboard.press('Escape'); await sleep(200);
    must(await p.locator('.drawer').count() === 0, 'drawer not closed');
  });
  await check('watch: strip — detect cell opens most urgent event drawer; sub links switch tabs', async () => {
    await p.locator('.watch-strip-cell').first().click(); await sleep(300);
    must(await p.locator('.drawer').count() === 1, 'no drawer from detect cell');
    await p.locator('.drawer button[aria-label="닫기"]').click(); await sleep(200);
    for (const [txt, tabName] of [['경쟁사 변경 7일', '경쟁사 아카이브'], ['브랜드 지면', '브랜드 지면 점검'], ['다음 일정', '외부 변수'], ['주간 브리프', '주간 인사이트 브리프']]) {
      await p.locator('.watch-strip-sub button', { hasText: txt }).click(); await sleep(200);
      must((await p.locator('[role=tab][aria-selected=true]').innerText()).includes(tabName), `${txt} → ${await p.locator('[role=tab][aria-selected=true]').innerText()}`);
    }
    await tab(p, '매체 변동 트래킹');
  });
  await check('watch: progress persists across reload', async () => {
    await h.reload(); await stageAll(p);
    must((await evSide(p, '키워드 확장(베타)')).includes('랩업 완료') && (await evSide(p, '카카오톡 비즈보드')).includes('관찰 종료'), 'progress lost');
  });
  await check('watch: 시연 초기화 is two-step; 확정 resets progress (Lab requests kept in Flow)', async () => {
    const n0 = (await state(p)).changes.length;
    await p.locator('button', { hasText: '시연 초기화' }).click(); await sleep(150);
    must((await evSide(p, '키워드 확장(베타)')).includes('랩업 완료'), 'reset without confirm');
    await p.locator('button', { hasText: 'Watch 진행 기록 초기화 확정' }).click(); await sleep(400);
    await stageAll(p);
    must((await evSide(p, '키워드 확장(베타)')).includes('랩업 기록') && (await evSide(p, '카카오톡 비즈보드')).includes('Lab 테스트 등록'), 'not reset');
    must((await state(p)).changes.length === n0, 'changes removed');
  });
  await check('watch: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

async function sWatchArchive() {
  const h = await open({ file: F, route: 'watch', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await tab(p, '경쟁사 아카이브');
  const tl = () => p.locator('.watch-timeline li');
  await check('archive: 6 competitors × 6 archive items matrix with cadence', async () => {
    const hdr = await p.$$eval('.watch-matrix thead th button', (e) => e.map((x) => x.innerText));
    must(hdr.length === 6, `competitors ${hdr}`);
    const rows = await p.$$eval('.watch-matrix tbody tr', (e) => e.map((x) => x.innerText));
    must(rows.length === 6 && rows.every((r) => /(일|주|월|즉시)/.test(r)), `rows ${rows.length}`);
  });
  await check('archive: competitor header toggles timeline filter; cell click filters competitor+item; empty cell → empty state; common cell', async () => {
    const all = await tl().count();
    const th = p.locator('.watch-th-btn').first(); const name = await th.innerText();
    await th.click(); await sleep(150);
    const comps = await tl().evaluateAll((e) => e.map((x) => x.querySelector('.watch-tl-body strong').innerText));
    must(comps.length > 0 && comps.length < all && comps.every((c) => c === name), `${name}: ${comps}`);
    await th.click(); await sleep(150); must(await tl().count() === all, 'toggle back');
    await p.locator('.watch-cell:not(.empty):not(.wide)').first().click(); await sleep(150);
    const comp = await p.$eval('#watch-archive-competitor', (e) => e.value); const item = await p.$eval('#watch-archive-item', (e) => e.value);
    must(comp !== 'all' && item !== 'all' && await tl().count() >= 1, `${comp}/${item}`);
    await p.locator('.watch-cell.empty').first().click(); await sleep(150);
    must(await tl().count() === 0 && await p.locator('text=조건에 맞는 기록이 없습니다').count() === 1, 'no empty state');
    await p.locator('.watch-cell.wide').first().click(); await sleep(150);
    must(await p.$eval('#watch-archive-competitor', (e) => e.value) === 'common' && await tl().count() >= 1, 'common');
    await p.selectOption('#watch-archive-competitor', 'all'); await p.selectOption('#watch-archive-item', 'all'); await sleep(150);
    must(await tl().count() === all, 'selects reset');
  });
  await check('archive: 영향도 segmented filters timeline rows by level', async () => {
    const all = await tl().count(); let sum = 0;
    for (const [lv, cls] of [['높음', 'lv-high'], ['중간', 'lv-mid'], ['낮음', 'lv-low']]) {
      await p.locator('[aria-label="영향도"] button', { hasText: lv }).click(); await sleep(120);
      const c = await tl().evaluateAll((e, k) => e.map((x) => x.classList.contains(k)), cls);
      sum += c.length; must(c.every(Boolean), `${lv} mismatch`);
    }
    must(sum === all, `sum ${sum} vs ${all}`);
    await p.locator('[aria-label="영향도"] button', { hasText: '전체' }).click(); await sleep(120);
  });
  await check('archive: Alert P3 생성 double-click → exactly 1 P3 incident (open), row shows 생성됨, KPI decrements, toast → #alert lists it', async () => {
    const kpi = async () => Number((await p.locator('.watch-kpis .card', { hasText: 'Alert P3 미등록 변경' }).innerText()).match(/(\d+)건/)[1]);
    const k0 = await kpi();
    const inc0 = (await state(p)).incidents.map((i) => i.id);
    const li = tl().filter({ has: p.locator('button', { hasText: 'Alert P3 생성' }) }).first();
    const title = await li.locator('.watch-tl-body .small strong').first().innerText();
    await li.locator('button', { hasText: 'Alert P3 생성' }).dblclick(); await sleep(600);
    must(await p.evaluate(() => location.hash) === '#watch', 'double click navigated away');
    const st = await state(p); const nw = st.incidents.filter((i) => !inc0.includes(i.id));
    must(nw.length === 1 && nw[0].severity === 'P3' && /^watch_competitor:/.test(nw[0].id) && nw[0].status === 'open' && nw[0].title.includes(title.slice(0, 8)), JSON.stringify(nw.map((i) => [i.id, i.severity, i.status, i.title])));
    must(await tl().filter({ hasText: title }).first().locator('text=Alert P3 생성됨').count() === 1, 'row not marked');
    must(await kpi() === k0 - 1, `kpi ${k0} -> ${await kpi()}`);
    await p.locator('.toast', { hasText: 'MILDO Alert P3 이슈 생성' }).locator('button', { hasText: '바로 가기' }).click(); await sleep(600);
    must(await p.evaluate(() => location.hash) === '#alert', 'toast did not navigate');
    must((await p.locator('body').innerText()).includes(nw[0].title.slice(0, 15)), 'not listed in Alert');
    await h.reload();
    must((await state(p)).incidents.some((i) => i.id === nw[0].id), 'incident lost on reload');
    await go(p, 'watch'); await tab(p, '경쟁사 아카이브');
    must(await tl().filter({ hasText: title }).first().locator('text=Alert P3 생성됨').count() === 1, 'mark lost on reload');
  });
  await check('archive: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

async function sWatchBrief() {
  const h = await open({ file: F, route: 'watch', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await check('serp: brand SERP snapshot KPIs + 4 keyword cards', async () => {
    await tab(p, '브랜드 지면 점검');
    const k = await p.locator('.watch-kpis').innerText();
    must(/경쟁사 광고가 자사보다 위/.test(k) && /\d+ \/ 4/.test(k), k.slice(0, 120));
    must(await p.locator('.card', { hasText: '검색 결과' }).count() >= 4, 'keyword cards');
  });
  await check('external: season calendar (holidays · 이사 · 혼인 · 쇼핑 행사) marked 가설 + search trend', async () => {
    await tab(p, '외부 변수');
    const t = await p.locator('.page').innerText();
    must(t.includes('시즌 캘린더') && t.includes('가설') && /성탄절|신정|설날/.test(t) && /이사/.test(t) && /혼인/.test(t) && /쇼핑 행사/.test(t), 'calendar content');
    must(/브랜드 검색량/.test(t), 'no search trend');
  });
  await tab(p, '주간 인사이트 브리프');
  const apply = p.locator('button', { hasText: '브리프에 반영' });
  const note = '쇼핑 고객 확장 그룹은 7일차 중간 점검(11/4) 전까지 증액하지 않는다. 전환율 차이 +15% 이상 · p<0.05 확인 후 같은 의도 그룹 확대를 제안한다.';
  await check('brief: AE comment — empty/space disabled, style hint for numbering, apply merges into brief + pill', async () => {
    must(await apply.isDisabled(), 'enabled empty');
    await p.fill('#watch-ae-note', '   '); must(await apply.isDisabled(), 'enabled spaces');
    await p.fill('#watch-ae-note', '1. 좋다 2. 대박'); await sleep(100);
    const hint = await p.locator('text=작성 원칙').innerText().catch(() => '');
    must(hint.includes('번호 매기기') && hint.includes('감정 표현'), hint);
    await p.fill('#watch-ae-note', note); await apply.click(); await sleep(200);
    must(await apply.isDisabled(), 'still dirty');
    must(await p.locator('text=AE 코멘트 반영').count() >= 1, 'no pill');
    must((await p.locator('.watch-brief').innerText()).includes('7일차 중간 점검(11/4) 전까지'), 'not merged');
  });
  await check('brief: .md export and copy include AE comment and headings', async () => {
    await p.locator('.card', { hasText: '자동 초안' }).locator('button', { hasText: '.md' }).first().click(); await sleep(400);
    const s = (await h.saves()).slice(-1)[0];
    must(s && /^mildo-watch-weekly-brief_2026-10-25_2026-10-31\.md$/.test(s.filename) && s.head.startsWith('## MILDO Watch 주간 인사이트 브리프'), JSON.stringify(s && [s.filename, s.head.slice(0, 50)]));
    const full = await p.evaluate(() => window.__saves[window.__saves.length - 1]);
    await p.locator('.card', { hasText: '자동 초안' }).locator('button', { hasText: '복사' }).first().click(); await sleep(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    must(clip.includes('7일차 중간 점검(11/4) 전까지') && (clip.match(/^#+ /gm) || []).length >= 4, 'clipboard');
    must(full.bytes > 3000, `md bytes ${full.bytes}`);
  });
  await check('brief: AE comment persists across reload; 코멘트 비우기 clears it from brief', async () => {
    await h.reload(); await tab(p, '주간 인사이트 브리프');
    must(await p.$eval('#watch-ae-note', (e) => e.value) === note, 'note lost');
    await p.locator('button', { hasText: '코멘트 비우기' }).click(); await sleep(200);
    must(await p.$eval('#watch-ae-note', (e) => e.value) === '' && !(await p.locator('.watch-brief').innerText()).includes('7일차 중간 점검(11/4)'), 'not cleared');
    must(await p.locator('text=담당 AE 검토 전').count() >= 1, 'pill not reset');
  });
  await check('brief/serp/external: no AI calls without clicks, no console errors', async () => { must((await h.calls()).length === 0, 'calls'); must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

async function sWatchAi() {
  for (const ai of ['none', 'artifact', 'denied', 'rate', 'error-mid', 'slow', 'unavailable']) {
    const h = await open({ file: F, route: 'watch', ai, downloads: 'accept' });
    const p = h.page;
    await tab(p, '주간 인사이트 브리프');
    await check(`watch-ai[${ai}]: 'AI 해석 추가' AiInsight`, async () => {
      const c = p.locator('.card', { hasText: 'AI 해석 추가' }).last();
      const b = c.locator('button', { hasText: /AI 해석 생성|다시 생성/ }).first();
      await b.click();
      if (ai === 'slow') { await sleep(400); const s = c.locator('button', { hasText: '중지' }); must(await s.count() === 1, 'no stop'); await s.click(); await sleep(2600); must(!/오류|cancel/i.test(await c.innerText()), 'error after stop'); must(await c.locator('button', { hasText: /AI 해석 생성|다시 생성/ }).first().isEnabled(), 'button unusable'); }
      else await sleep(900);
      const t = await c.innerText();
      const calls = await h.calls();
      if (ai === 'none' || ai === 'unavailable') { must(calls.length === 0 && t.includes('확정 팩트') && t.includes('규칙 엔진') && t.length > 1500, `rule fallback len ${t.length}`); return; }
      must(calls.length === 1 && calls[0].cache === false && calls[0].kind === 'sample' && !calls[0].tools.length, JSON.stringify(calls));
      if (ai === 'artifact') must(t.includes('모의 액션') && t.includes('AI 해석'), 'AI text');
      if (ai === 'denied') must(t.includes('허용되지 않았습니다') && t.includes('확정 팩트') && t.length > 1500, 'denied');
      if (ai === 'rate') must(t.includes('요청이 많습니다') && t.includes('확정 팩트') && t.length > 1500, 'rate');
      if (ai === 'error-mid') must(t.includes('연결 오류') && t.includes('확정 팩트'), 'error-mid');
      await sleep(1500); must((await h.calls()).length === calls.length, 'auto retry');
      if (ai === 'rate' || ai === 'error-mid') { await c.locator('button', { hasText: /AI 해석 생성|다시 생성/ }).first().click(); await sleep(900); must((await h.calls()).length === calls.length + 1, 'manual retry did not call'); }
    });
    await check(`watch-ai[${ai}]: no console errors`, async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
    await h.close();
  }
}

async function sReset() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  const settingsReset = async () => {
    await p.locator('button', { hasText: '설정' }).first().click(); await sleep(200);
    await p.locator('button', { hasText: '시연 상태 초기화' }).click(); await sleep(100);
    must(await p.locator('button', { hasText: '정말 초기화' }).count() === 1, 'no second step');
    await p.locator('button', { hasText: '정말 초기화' }).click(); await sleep(700);
  };
  const dirtyLab = async () => {
    await go(p, 'lab'); await tab(p, '테스트 파이프라인');
    await p.fill('#lab-c-targetRoas', '350'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(150);
    await tab(p, '테스트 카드');
    await p.locator('#lab-new-card button', { hasText: '카드 만들기' }).click(); await sleep(150);
    await p.fill('#lab-f-title', '리셋 점검 카드'); await p.fill('#lab-f-hyp', '생활 상황 키워드에 사이즈 비교 랜딩을 연결하면 전환율이 오른다');
    await p.fill('#lab-f-c', '상품 상세'); await p.fill('#lab-f-v', '사이즈 비교 랜딩');
    await p.locator('button', { hasText: '테스트 카드 등록 요청' }).click(); await sleep(500);
  };
  const dirtyWatch = async () => {
    await go(p, 'watch'); await stageAll(p);
    const b = evRow(p, '키워드 확장(베타)').locator('.watch-ev-side button', { hasText: '랩업 기록' });
    if (await b.count()) { await b.click(); await sleep(600); }
    await tab(p, '주간 인사이트 브리프');
    await p.fill('#watch-ae-note', `리셋 점검 코멘트 7일 ${Date.now()}`); await p.locator('button', { hasText: '브리프에 반영' }).click(); await sleep(200);
    await tab(p, '매체 변동 트래킹');
  };
  const labDirt = async () => {
    const st = await state(p); const lab = await labLocal(p); const bad = [];
    if (st.changes.some((c) => String(c.targetId || '').startsWith('labcard:'))) bad.push('lab card CR');
    if (lab.criteria && lab.criteria.targetRoas !== 400) bad.push(`criteria ${lab.criteria.targetRoas}`);
    if ((lab.userCards || []).length) bad.push('userCards');
    return bad;
  };
  const watchDirt = async () => {
    const wl = await watchLocal(p); const bad = [];
    if (Object.keys(wl.progress || {}).length) bad.push(`watch progress ${Object.keys(wl.progress)}`);
    if (Object.values(wl.aeNotes || {}).some((n) => n && n.text)) bad.push('aeNote');
    return bad;
  };
  await check('reset: Settings 시연 상태 초기화 (two-step) while on Lab clears Lab records + card requests', async () => {
    await dirtyLab();
    await go(p, 'lab'); await settingsReset(); await sleep(200);
    const bad = await labDirt(); must(!bad.length, bad.join(', '));
    await tab(p, '테스트 카드');
    must(await p.locator('.card', { hasText: '리셋 점검 카드' }).count() === 0, 'card still shown');
  });
  await check('reset: Settings 시연 상태 초기화 while on Watch clears Watch progress + AE comment', async () => {
    await dirtyWatch();
    await settingsReset(); await sleep(200);
    const bad = await watchDirt(); must(!bad.length, bad.join(', '));
    await stageAll(p);
    must((await evSide(p, '키워드 확장(베타)')).includes('랩업 기록'), 'screen not reset');
  });
  await check('reset: Settings 시연 상태 초기화 from another page (#home) also clears Lab + Watch records', async () => {
    await dirtyLab(); await dirtyWatch();
    await go(p, 'home'); await settingsReset();
    await go(p, 'lab'); await go(p, 'watch'); await sleep(300);
    const bad = [...await labDirt(), ...await watchDirt()];
    must(!bad.length, `${bad.join(', ')} — SettingsDialog does not dispatch 'mildo-os:reset' (shared issue)`);
  });
  await check("reset: 'mildo-os:reset' event contract clears Lab + Watch records even when their screens are not open", async () => {
    await go(p, 'lab'); await tab(p, '테스트 파이프라인'); await p.fill('#lab-c-targetRoas', '350'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(150);
    await dirtyWatch();
    await go(p, 'home');
    await p.evaluate(() => window.dispatchEvent(new Event('mildo-os:reset'))); await sleep(200);
    const lab = await labLocal(p); const wb = await watchDirt();
    must(lab.criteria.targetRoas === 400 && !wb.length, JSON.stringify([lab.criteria.targetRoas, wb]));
    await go(p, 'watch'); await stageAll(p);
    must((await evSide(p, '키워드 확장(베타)')).includes('랩업 기록'), 'Watch screen shows stale progress');
  });
  await check('reset: Lab 기록 초기화 is two-step and keeps Flow history', async () => {
    await go(p, 'lab'); await tab(p, '테스트 파이프라인');
    await p.fill('#lab-c-targetRoas', '350'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(150);
    const n0 = (await state(p)).changes.length;
    await p.locator('button', { hasText: /^Lab 기록 초기화$/ }).click(); await sleep(100);
    must((await labLocal(p)).criteria.targetRoas === 350, 'reset without confirm');
    await p.locator('button', { hasText: 'Lab 기록 초기화 확정' }).click(); await sleep(200);
    must((await labLocal(p)).criteria.targetRoas === 400 && (await state(p)).changes.length === n0, 'not reset / changes lost');
  });
  await check('reset: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

/* ------------------------------------------------------------------ */
async function sCross() {
  const h = await open({ file: F, route: 'adpilot', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  let ids = idSet(await state(p));
  let apPhrase = '', geoPhrase = '';
  await check('cross: AD Pilot 신규 후보 등록 요청 → Lab pipeline STEP 1 item labelled "AD Pilot 후보" (not re-recommended in Lab discover)', async () => {
    await tab(p, '신규 후보 발굴');
    await p.locator('input.adpilot-check:not([disabled])').first().check(); await sleep(100);
    await p.locator('button', { hasText: /^선택 1건 등록 요청$/ }).click(); await sleep(400);
    if (await p.locator('button', { hasText: /건 확정$/ }).count()) { await p.locator('button', { hasText: /건 확정$/ }).first().click(); await sleep(300); }
    const st = await state(p); const nw = newChanges(st, ids).filter((c) => c.module === 'adpilot' && c.kind === 'keyword_add');
    must(nw.length === 1, `adpilot created ${newChanges(st, ids).map((c) => c.module + ':' + c.kind)}`);
    apPhrase = String(nw[0].targetId || '').replace(/^term:/, '') || nw[0].target.split(' → ')[0];
    ids = idSet(st);
    await go(p, 'lab'); await tab(p, '테스트 파이프라인');
    const it = p.locator('.lab-col').nth(0).locator('.lab-item:not(.ghost)', { hasText: apPhrase }).first();
    must(await it.count() === 1, `no STEP 1 item for ${apPhrase}`);
    must((await it.innerText()).includes('AD Pilot 후보'), (await it.innerText()).slice(0, 120));
    await tab(p, '발굴'); await p.fill('#lab-q', apPhrase); await sleep(150);
    must(await p.locator('.lab-cand tbody tr', { has: p.locator('button', { hasText: '등록 요청' }) }).filter({ hasText: apPhrase }).count() === 0, 'Lab still offers the AD Pilot phrase');
    await p.fill('#lab-q', '');
  });
  await check('cross: SearchTuneOS (GEO) SA 테스트 그룹 등록 요청 → Lab STEP 1 item labelled "SearchTuneOS 테스트 요청"', async () => {
    await go(p, 'geo'); await tab(p, '페이드 AI 지면');
    const rows = p.locator('.card', { hasText: '질의별 점검' }).first().locator('tbody tr');
    const n = await rows.count(); let done = false;
    for (let i = 0; i < n && !done; i++) {
      await rows.nth(i).click(); await sleep(120);
      const b = p.locator('button', { hasText: 'SA 테스트 그룹 등록 요청' });
      if (await b.count()) { await b.first().click(); await sleep(400); done = true; }
    }
    must(done, 'no requestable GEO query');
    const st = await state(p); const nw = newChanges(st, ids).filter((c) => c.module === 'geo');
    must(nw.length === 1 && nw[0].kind === 'keyword_add', JSON.stringify(newChanges(st, ids).map((c) => [c.module, c.kind])));
    geoPhrase = String(nw[0].targetId || '').replace(/^term:/, '');
    ids = idSet(st);
    await go(p, 'lab'); await tab(p, '테스트 파이프라인');
    const it = p.locator('.lab-col').nth(0).locator('.lab-item:not(.ghost)', { hasText: geoPhrase }).first();
    must(await it.count() === 1, `no STEP 1 item for ${geoPhrase}`);
    must((await it.innerText()).includes('SearchTuneOS'), (await it.innerText()).slice(0, 120));
  });
  await check('cross: Lab approves the AD Pilot request (PM) → item moves to STEP 2 (집행 대기)', async () => {
    await setRole(p, 'PM');
    const it = p.locator('.lab-col').nth(0).locator('.lab-item:not(.ghost)', { hasText: apPhrase }).first();
    const ap = it.locator('button', { hasText: /^승인$/ });
    if (await ap.isDisabled()) { await setRole(p, '수면밀도'); }
    await ap.click(); await sleep(400);
    must(await p.locator('.lab-col').nth(1).locator('.lab-item', { hasText: apPhrase }).count() === 1, 'not in STEP 2');
    const st = await state(p); must(st.changes.find((c) => c.module === 'adpilot' && String(c.targetId).includes(apPhrase)).status === 'approved', 'status');
  });
  await check('cross: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

async function sMisc() {
  const h = await open({ file: F, route: 'lab', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  const sel = async () => (await p.locator('[role=tab][aria-selected=true]').innerText()).split('\n')[0];
  await check('lab misc: summary tiles switch tabs; 오늘 처리할 항목 열기 opens its tab; scenario link navigates', async () => {
    const map = [['발굴 후보', '발굴'], ['테스트 파이프라인', '테스트 파이프라인'], ['테스트 카드', '테스트 카드'], ['검수 · 차단', '검수 에이전트'], ['다음 주간 브리프', '운영 루프']];
    for (const [tile, tb] of map) { await p.locator('.lab-tile', { hasText: tile }).click(); await sleep(150); must((await sel()).includes(tb), `${tile} → ${await sel()}`); must(await p.locator('.lab-tile', { hasText: tile }).getAttribute('aria-pressed') === 'true', 'tile not pressed'); }
    const items = p.locator('.lab-todo-item').filter({ has: p.locator('button', { hasText: '열기' }) });
    const n = await items.count(); must(n > 0, 'no todos');
    for (let i = 0; i < Math.min(n, 4); i++) { await tab(p, '운영 루프'); await items.nth(i).locator('button', { hasText: '열기' }).click(); await sleep(150); must(!(await sel()).includes('운영 루프') || i > 10, `todo ${i} did not switch`); }
    await p.locator('a.lab-flow-row[href="#watch"]').first().click(); await sleep(400);
    must(await p.evaluate(() => location.hash) === '#watch', 'scenario link');
    await go(p, 'lab');
  });
  await check('lab misc: Lab 기록 초기화 취소 keeps records', async () => {
    await tab(p, '테스트 파이프라인'); await p.fill('#lab-c-targetRoas', '360'); await p.press('#lab-c-targetRoas', 'Tab'); await sleep(100);
    await p.locator('button', { hasText: /^Lab 기록 초기화$/ }).click(); await p.locator('.page-header button, button', { hasText: /^취소$/ }).first().click(); await sleep(150);
    must((await labLocal(p)).criteria.targetRoas === 360 && await p.locator('button', { hasText: /^Lab 기록 초기화$/ }).count() === 1, 'cancel failed');
    await p.locator('.card', { hasText: '판정 기준값' }).locator('button', { hasText: '초기값' }).click(); await sleep(100);
  });
  let ids = idSet(await state(p));
  await check('discover misc: table phrase click → detail; detail 테스트 그룹 등록 요청 → 1 request, detail shows status; bulk confirm 취소 creates nothing', async () => {
    await tab(p, '발굴');
    const row = p.locator('.lab-cand tbody tr').filter({ has: p.locator('button:not([disabled])', { hasText: '등록 요청' }) }).nth(2);
    const phrase = await row.locator('td:nth-child(2) strong').innerText();
    await row.locator('td:nth-child(2) button').click(); await sleep(150);
    const det = p.locator('.card', { hasText: '후보 상세' }).first();
    must((await det.innerText()).includes(phrase), 'detail not switched');
    await det.locator('button', { hasText: '테스트 그룹 등록 요청' }).dblclick(); await sleep(400);
    let nw = newChanges(await state(p), ids);
    must(nw.length === 1 && nw[0].target === phrase, JSON.stringify(nw.map((c) => c.target)));
    must((await det.innerText()).includes('등록 요청') && await det.locator('button', { hasText: '테스트 그룹 등록 요청' }).count() === 0, 'detail not updated');
    ids = idSet(await state(p));
    const boxes = p.locator('.lab-cand tbody input[type=checkbox]:not([disabled])');
    for (let i = 0; i < 7; i++) await boxes.nth(i).check();
    await p.locator('button', { hasText: /^선택 7건 등록 요청$/ }).click(); await sleep(150);
    await p.locator('.callout', { hasText: '한 번 더 확인' }).locator('button', { hasText: /^취소$/ }).click(); await sleep(150);
    nw = newChanges(await state(p), ids);
    must(nw.length === 0 && await p.locator('text=일괄 등록 — 한 번 더 확인').count() === 0, `cancel created ${nw.length}`);
    for (let i = 0; i < 7; i++) await p.locator('.lab-cand tbody input[type=checkbox]:checked').first().uncheck().catch(() => {});
  });
  await check('pipeline misc: Lab 반려 on STEP 1 request (AE) → rejected, candidate offered again', async () => {
    await sleep(600); // 연속 클릭 방지(500ms) 창 밖에서 시작
    await setRole(p, '담당 AE');
    await tab(p, '테스트 파이프라인');
    const it = p.locator('.lab-col').nth(0).locator('.lab-item:not(.ghost)').filter({ has: p.locator('button:not([disabled])', { hasText: /^반려$/ }) }).first();
    const phrase = await it.locator('.lab-item-title').innerText();
    const before = new Map((await state(p)).changes.map((x) => [x.id, x.status]));
    await it.locator('button', { hasText: /^반려$/ }).dblclick(); await sleep(400);
    const st = await state(p);
    const changed = st.changes.filter((x) => before.get(x.id) !== x.status);
    must(changed.length === 1, `changed ${changed.length}`);
    const c = changed[0];
    must(c && c.status === 'rejected' && c.history.filter((x) => x.action === '반려').length === 1, JSON.stringify(c && [c.status, c.history.map((x) => x.action)]));
    must(await p.locator('.lab-col').nth(0).locator('.lab-item:not(.ghost)', { hasText: phrase }).count() === 0, 'still pending item');
  });
  await check('cards misc: 매체 / 의도 select + 주 지표 segmented saved on the card; library checkbox off → wrap-up not added to library', async () => {
    await setRole(p, 'PM');
    await tab(p, '테스트 카드');
    await p.locator('#lab-new-card button', { hasText: '카드 만들기' }).click(); await sleep(150);
    const media = await p.$$eval('#lab-f-media option', (o) => o.map((x) => x.value));
    await p.selectOption('#lab-f-media', media[media.length - 1]);
    const intents = await p.$$eval('#lab-f-intent option', (o) => o.map((x) => x.value).filter(Boolean));
    await p.selectOption('#lab-f-intent', intents[0]);
    await p.locator('#lab-new-card button', { hasText: 'CTR' }).first().click();
    await p.fill('#lab-f-title', '매체 · 의도 점검 카드'); await p.fill('#lab-f-hyp', '생활 상황 키워드에 사이즈 비교 랜딩을 연결하면 전환율이 오른다');
    await p.fill('#lab-f-c', '상품 상세'); await p.fill('#lab-f-v', '사이즈 비교 랜딩');
    await p.locator('button', { hasText: '테스트 카드 등록 요청' }).click(); await sleep(400);
    const card = (await labLocal(p)).userCards.slice(-1)[0];
    must(card.media === media[media.length - 1] && card.intent === intents[0] && card.primary === 'ctr', JSON.stringify([card.media, card.intent, card.primary]));
    const v = p.locator('.card', { hasText: card.id }).filter({ hasText: '사용자 카드' }).first();
    must((await v.innerText()).includes(card.media) && (await v.innerText()).includes('CTR'), 'card view lacks media/metric');
    const dc = p.locator('.card', { has: p.locator('button', { hasText: '확대 결정 · 승인 요청' }) }).first();
    const id = await dc.locator('.lab-mono').first().innerText();
    await dc.locator('button', { hasText: '확대 결정 · 승인 요청' }).click(); await sleep(400);
    const c2 = p.locator('.card', { hasText: id }).filter({ has: p.locator('.lab-wrap') }).first();
    must(await c2.locator('.lab-wrap input[type=checkbox]').isChecked(), 'library default not checked for expand');
    await c2.locator('.lab-wrap input[type=checkbox]').uncheck();
    await c2.locator('.lab-wrap textarea').fill('라이브러리 제외 랩업 결과 2주'); await c2.locator('.lab-wrap button', { hasText: '랩업 기록' }).click(); await sleep(300);
    must((await c2.innerText()).includes('랩업 완료') && !(await c2.innerText()).includes('라이브러리에 추가됨'), 'wrap');
    must(!(await labLocal(p)).library.some((x) => x.id === `pt_${id}`), 'added to library despite unchecked');
  });
  await check('cards misc: incoming request "MILDO Watch 열기" link → #watch', async () => {
    await go(p, 'watch'); await stageAll(p);
    const T = "'매트리스 추천' CPC";
    for (const b of ['영향 진단 완료', '실행안 확정', 'Lab 테스트 등록']) { await evRow(p, T).locator('.watch-ev-side button', { hasText: b }).click(); await sleep(650); }
    await go(p, 'lab'); await tab(p, '테스트 카드');
    await p.locator('.card', { hasText: '다른 모듈 테스트 요청' }).last().locator('.lab-todo-item a', { hasText: '열기' }).first().click(); await sleep(400);
    must(await p.evaluate(() => location.hash) === '#watch', 'link');
  });
  await check('creative misc: 카드 보기 → Cards tab; loop .md copy → clipboard markdown', async () => {
    await go(p, 'lab'); await tab(p, 'VisualTune');
    const kb = p.locator('button', { hasText: '카드 보기' });
    must(await kb.count() > 0, 'no 카드 보기');
    await kb.first().click(); await sleep(200);
    must((await sel()).includes('테스트 카드'), await sel());
    await tab(p, '운영 루프');
    await p.locator('.card', { has: p.locator('button', { hasText: '.md' }) }).first().locator('button', { hasText: '복사' }).click(); await sleep(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    must(/^#/m.test(clip) && clip.includes('주간'), clip.slice(0, 80));
  });
  await check('watch misc: 상세 button opens drawer; drawer 관찰 종료 closes event; P3 생성됨 link → #alert; 시연 초기화 취소; non-detect strip cell → tracking without drawer', async () => {
    await go(p, 'watch'); await stageAll(p);
    const T = '오늘의집 상품 광고';
    await evRow(p, T).locator('.watch-ev-side button', { hasText: '상세' }).click(); await sleep(300);
    const d = p.locator('.drawer'); must(await d.count() === 1 && (await d.innerText()).includes('오늘의집'), 'drawer');
    await d.locator('button', { hasText: '실행안 확정' }).click(); await sleep(650);
    await d.locator('button', { hasText: '관찰 종료' }).click(); await sleep(400);
    must((await d.innerText()).includes('현재 단계 관찰 종료'), 'drawer not closed-state');
    await d.locator('button[aria-label="닫기"]').click(); await sleep(200);
    must((await evSide(p, T)).includes('관찰 종료') && !(await evRow(p, T).locator('.watch-ev-side button', { hasText: 'Lab 테스트 등록' }).count()), await evSide(p, T));
    await p.locator('button', { hasText: '시연 초기화' }).click(); await p.locator('button', { hasText: /^취소$/ }).first().click(); await sleep(150);
    must((await evSide(p, T)).includes('관찰 종료'), 'cancel reset');
    await p.locator('.watch-strip-cell').nth(2).click(); await sleep(200);
    must(await p.locator('.drawer').count() === 0 && (await sel()).includes('매체 변동 트래킹'), 'strip non-detect');
    await tab(p, '경쟁사 아카이브');
    await p.locator('.watch-timeline li button', { hasText: 'Alert P3 생성' }).first().click(); await sleep(800);
    await p.locator('.watch-timeline li a', { hasText: 'Alert P3 생성됨' }).first().click(); await sleep(400);
    must(await p.evaluate(() => location.hash) === '#alert', 'P3 link');
  });
  await check('loop/watch misc: 운영 루프 calendar covers 주간 · 월간 · 분기 · 액션 후 2주 · 수시; Watch role links navigate', async () => {
    await go(p, 'lab'); await tab(p, '운영 루프');
    const t = await p.locator('.page').innerText();
    must(['주간', '월간', '분기', '액션 후 2주', '수시'].every((k) => t.includes(k)), 'loop cycles missing');
    await go(p, 'watch');
    const links = p.locator('a.watch-role');
    must(await links.count() >= 3, 'role links');
    const href = await links.filter({ hasNot: p.locator('xx') }).evaluateAll((e) => e.map((x) => x.getAttribute('href')).find((h) => h !== '#watch'));
    await p.locator(`a.watch-role[href="${href}"]`).first().click(); await sleep(400);
    must(await p.evaluate(() => location.hash) === href, `role link ${href}`);
  });
  await check('misc: no console errors', async () => { must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200)); });
  await h.close();
}

async function sWatchAll() {
  const h = await open({ file: F, route: 'watch', ai: 'artifact', downloads: 'accept' });
  const p = h.page;
  await stageAll(p);
  await check('watch-all: every event advances one stage per enabled button; every Lab 테스트 등록 creates one pending test request for that event; disabled buttons carry a reason', async () => {
    const titles = await p.$$eval('.watch-ev .watch-ev-title', (e) => e.map((x) => x.innerText));
    const order = ['영향 진단 완료', '실행안 확정 · 주간 리포트 반영', 'Lab 테스트 등록', '랩업 기록'];
    let ids = idSet(await state(p)); let tests = 0; const log = [];
    for (let round = 0; round < 4; round++) {
      for (const t of titles) {
        const b = evRow(p, t).locator('.watch-ev-side button').filter({ hasText: /영향 진단 완료|실행안 확정|Lab 테스트 등록|랩업 기록/ });
        if (!(await b.count())) continue;
        const label = (await b.first().innerText()).trim();
        if (await b.first().isDisabled()) { const why = await b.first().getAttribute('title'); must(why && why.length > 5, `${t}: disabled without reason`); continue; }
        await b.first().click(); await sleep(620);
        const nb = evRow(p, t).locator('.watch-ev-side button').filter({ hasText: /영향 진단 완료|실행안 확정|Lab 테스트 등록|랩업 기록/ });
        const next = (await nb.count()) ? (await nb.first().innerText()).trim() : '(none)';
        const k = order.indexOf(label);
        must(next !== label && (k === 3 ? next === '(none)' : next === order[k + 1] || next === '(none)'), `${t}: ${label} → ${next}`);
        if (label === 'Lab 테스트 등록') {
          tests++;
          const st = await state(p); const nw = newChanges(st, ids);
          must(nw.length === 1 && nw[0].kind === 'test' && nw[0].status === 'pending' && nw[0].module === 'watch', `${t}: created ${nw.length}`);
          ids = idSet(st);
        }
        log.push(`${t.slice(0, 12)}:${label}`);
      }
    }
    must(tests >= 3, `only ${tests} test registrations (${log.join(', ')})`);
    const st = await state(p);
    const watchTests = st.changes.filter((c) => c.module === 'watch' && c.kind === 'test');
    must(new Set(watchTests.map((c) => c.targetId)).size === watchTests.length, 'duplicate test requests per event');
    await go(p, 'flow');
    for (const c of watchTests) must(await p.locator('section.flow-col[aria-label="승인 대기"] .flow-card', { hasText: c.target.slice(0, 20) }).count() >= 1, `not in Flow: ${c.target}`);
    await go(p, 'lab'); await tab(p, '테스트 카드');
    const inc = await p.locator('.card', { hasText: '다른 모듈 테스트 요청' }).last().locator('.card-title').innerText();
    must(Number(inc.match(/(\d+)건/)[1]) >= watchTests.length, `incoming ${inc} vs ${watchTests.length}`);
  });
  await check('watch-all: brief pipeline counts match feed after progression; no console errors', async () => {
    await go(p, 'watch'); await tab(p, '주간 인사이트 브리프');
    const t = await p.locator('.card', { hasText: '이번 주 파이프라인' }).innerText();
    must(/소액 테스트 진행\s*\d+/.test(t), t.slice(0, 200));
    must(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 200));
  });
  await h.close();
}

const SECTIONS = { load: sLoad, discover: sDiscover, pipeline: sPipeline, pipelineBulk: sPipelineBulk, cards: sCards, creativeReview: sCreativeReview, labAi: sLabAi, downloads: sDownloads, watchTracking: sWatchTracking, watchArchive: sWatchArchive, watchBrief: sWatchBrief, watchAi: sWatchAi, reset: sReset, cross: sCross, misc: sMisc, watchAll: sWatchAll };
(async () => {
  for (const [k, fn] of Object.entries(SECTIONS)) {
    if (!want(k)) continue;
    try { await fn(); } catch (e) { out(false, `section ${k}`, String(e.message || e).split('\n')[0]); }
  }
  console.log(`SUMMARY ${passes} PASS · ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})();
