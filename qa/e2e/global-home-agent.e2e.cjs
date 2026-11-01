/**
 * MILDO OS 기능 점검 (GLOBAL · 커맨드 센터 · MILDO Agent · 공용 AiInsight · 다운로드 · CLI)
 * 빌드: cd /home/user/mildo-ai && npx vite build --mode single --outDir /tmp/qa-f1/dist --emptyOutDir && node scripts/postbuild-single.mjs /tmp/qa-f1/dist
 *       (postbuild = npm run build:single 의 후처리: 외부 글꼴 링크 제거 · U+FFFD 이스케이프 — 배포본과 같은 HTML)
 * 사용: NODE_PATH=$(npm root -g) node qa/e2e/global-home-agent.e2e.cjs dist-single/index.html   (ONLY=<정규식> 으로 일부만)
 * 한 줄씩 'PASS <name>' / 'FAIL <name>: <reason>' — FAIL이 하나라도 있으면 exit 1
 */
const { open } = require(require('path').join(__dirname, 'harness.cjs'));
const { spawnSync } = require('child_process');
const FILE = process.argv[2];
if (!FILE) { console.error('usage: node e2e.cjs <index.html>'); process.exit(2); }
const REPO = require('path').join(__dirname, '../..');
const MOCK_END = '모의 액션.';
let fails = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

function assert(c, msg) { if (!c) throw new Error(msg); }
async function check(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
}
async function withPage(opts, fn) {
  const h = await open({ file: FILE, ...opts });
  const net = [];
  // 아티팩트 CSP가 허용하는 Google Fonts 요청은 외부 요청 집계에서 뺀다
  h.page.on('request', (r) => { const u = r.url(); if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:') && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) net.push(u); });
  h.net = net;
  try { await fn(h, h.page); } finally { await h.close(); }
}
const card = (p, title) => p.locator('section.card', { has: p.locator('h2.card-title', { hasText: title }) }).first();
const ls = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/v1') || '{}'));
const hash = (p) => p.evaluate(() => location.hash);
const go = async (p, r) => { await p.evaluate((x) => { location.hash = x; }, r); await p.waitForTimeout(450); };
const closeToasts = async (p) => { for (const b of await p.$$('.toast .icon-btn')) await b.click().catch(() => {}); await p.waitForTimeout(100); };
async function until(fn, ms = 4000, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); } return false; }
const noErr = (h) => assert(h.errors.length === 0, `console errors: ${h.errors.join(' | ').slice(0, 200)}`);
const topPill = (p) => p.locator('header.topbar .pill').first().textContent();
const ROUTES = { home: '오늘의 운영', agent: 'MILDO Agent', board: 'MILDO Board', adpilot: 'AD Pilot · GFA Control v1', reports: '리포트 · 데이터 시간표', watch: 'MILDO Watch', lab: 'MILDO Lab', geo: 'SearchTuneOS · GEO', growth: '매출 성장 고도화', flow: 'MILDO Flow', alert: 'MILDO Alert', ops: '전담 TF · 온보딩 · 계약' };

async function runScenario(p) {
  const c = card(p, '작동 시나리오');
  await c.getByRole('button', { name: /시나리오 실행|다시 실행/ }).click();
  const btn = c.getByRole('button', { name: /이 시나리오로 승인 요청 만들기|승인 요청 생성됨/ });
  await btn.waitFor({ timeout: 12000 });
  return c;
}

(async () => {
  /* ================= GLOBAL ================= */
  await check('global: load home (rule mode) — P1 toast, no AI calls, no console errors', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    assert((await p.locator('main h1').textContent()) === '오늘의 운영', 'home h1');
    const t = await p.locator('.toast').allTextContents();
    assert(t.some((x) => x.includes('P1 이슈') && x.includes('바로 가기')), `P1 toast missing: ${t}`);
    assert((await h.calls()).length === 0, 'AI call on load');
    assert((await topPill(p)) === '규칙 엔진 (AI 미연결)', 'pill');
    noErr(h);
  }));

  await check('global: AI status label per ai mode (artifact / unavailable / none)', async () => {
    for (const [ai, want] of [['artifact', 'Claude 연결됨 (claude.ai)'], ['unavailable', '규칙 엔진 (AI 미연결)'], ['none', '규칙 엔진 (AI 미연결)']]) {
      await withPage({ route: 'home', ai }, async (h, p) => { const got = await topPill(p); assert(got === want, `${ai}: ${got}`); noErr(h); });
    }
  });

  await check('global: sidebar navigation (12 modules) + badges match store counts', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    const s = await ls(p);
    const pend = s.changes.filter((c) => c.status === 'pending').length;
    const open_ = s.incidents.filter((i) => i.status !== 'resolved').length;
    assert((await p.locator('.nav-item[href="#flow"] .nav-badge').textContent()) === String(pend), 'flow badge');
    assert((await p.locator('.nav-item[href="#alert"] .nav-badge').textContent()) === String(open_), 'alert badge');
    for (const [r, h1] of Object.entries(ROUTES)) {
      await p.locator(`.nav-item[href="#${r}"]`).click(); await p.waitForTimeout(350);
      assert((await hash(p)) === `#${r}`, `hash ${r}`);
      assert((await p.locator('.nav-item[aria-current=page]').getAttribute('href')) === `#${r}`, `aria-current ${r}`);
      assert((await p.locator('main h1').first().textContent()) === h1, `h1 ${r}`);
    }
    noErr(h);
  }));

  await check('global: unknown hash → 커맨드 센터, back/forward', () => withPage({ route: 'board', ai: 'none' }, async (h, p) => {
    await go(p, 'nosuch-route');
    assert((await p.locator('main h1').textContent()) === '오늘의 운영', 'unknown → home');
    await go(p, 'board');
    await p.locator('.nav-item[href="#alert"]').click(); await p.waitForTimeout(300);
    await p.locator('.nav-item[href="#flow"]').click(); await p.waitForTimeout(300);
    await p.goBack(); await p.waitForTimeout(400);
    assert((await p.locator('main h1').textContent()) === 'MILDO Alert', 'back → alert');
    await p.goForward(); await p.waitForTimeout(400);
    assert((await p.locator('main h1').textContent()) === 'MILDO Flow', 'forward → flow');
    noErr(h);
  }));

  await check('global: no AI call without user action (all routes + all tabs, ai artifact)', () => withPage({ route: 'home', ai: 'artifact' }, async (h, p) => {
    for (const r of Object.keys(ROUTES)) {
      await go(p, r);
      const tabs = p.locator('main [role=tab]');
      const n = await tabs.count();
      for (let i = 0; i < n; i++) { await tabs.nth(i).click().catch(() => {}); await p.waitForTimeout(120); }
    }
    const c = await h.calls();
    assert(c.length === 0, `calls without click: ${JSON.stringify(c).slice(0, 200)}`);
    noErr(h);
  }));

  await check('global: role select persists and changes Flow approval queue', () => withPage({ route: 'flow', ai: 'none' }, async (h, p) => {
    await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(300);
    const ae = await p.locator('.flow-queue-row').allTextContents();
    assert(ae.length > 0 && ae.every((t) => !t.includes('승인 PM') && !t.includes('수면밀도 승인')), `AE queue has non-AE: ${ae.length}`);
    await p.selectOption('#role-select', '수면밀도'); await p.waitForTimeout(300);
    const cl = await p.locator('.flow-queue-row').count();
    assert(cl > ae.length, 'client sees more');
    assert((await ls(p)).role === '수면밀도', 'role saved');
    await h.reload();
    assert((await p.inputValue('#role-select')) === '수면밀도', 'role after reload');
    noErr(h);
  }));

  await check('global: live demo bar — start/pause/resume/seek ×5/same-segment seek/stop', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    const clock = () => p.locator('.demo-clock').textContent();
    await p.locator('header.topbar').getByRole('button', { name: '라이브 데모 15분' }).click(); await p.waitForTimeout(600);
    assert((await hash(p)) === '#board', 'start → board');
    assert((await p.locator('.demo-step').count()) === 5, '5 segments');
    const routes = ['#board', '#adpilot', '#alert', '#reports', '#flow'];
    for (let i = 0; i < 5; i++) {
      await go(p, 'ops');
      await p.locator('.demo-step').nth(i).click(); await p.waitForTimeout(500);
      assert((await hash(p)) === routes[i], `seek ${i} → ${await hash(p)}`);
      assert((await p.locator('.demo-step[aria-current=step]').count()) === 1, 'current step');
    }
    // 같은 구간을 다시 눌러도 그 화면으로 (회귀)
    await go(p, 'ops');
    await p.locator('.demo-step').nth(4).click(); await p.waitForTimeout(400);
    assert((await hash(p)) === '#flow', 'same-segment seek navigates');
    await p.locator('.demo-step').nth(1).click(); await p.waitForTimeout(300);
    await p.getByRole('button', { name: '일시정지' }).click();
    const c1 = await clock(); await p.waitForTimeout(1600);
    assert((await clock()) === c1, 'paused clock frozen');
    await p.getByRole('button', { name: '재개' }).click(); await p.waitForTimeout(1600);
    assert((await clock()) !== c1, 'resumed clock runs');
    await p.getByRole('button', { name: '종료' }).click(); await p.waitForTimeout(300);
    assert((await p.locator('.demobar').count()) === 0, 'stopped');
    assert((await p.locator('header.topbar').getByRole('button', { name: '라이브 데모 15분' }).count()) === 1, 'start button back');
    noErr(h);
  }));

  await check('global: demo auto-advances segment and route with time', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await p.evaluate(() => { const o = Date.now; window.__off = 0; Date.now = () => o() + window.__off; });
    await p.getByRole('button', { name: '15분 데모 시작' }).click(); await p.waitForTimeout(500);
    for (const [sec, r] of [[200, '#adpilot'], [450, '#alert'], [650, '#reports'], [800, '#flow']]) {
      await p.evaluate((s) => { window.__off = s * 1000; }, sec);
      assert(await until(async () => (await hash(p)) === r, 2500), `t=${sec}s → ${await hash(p)}`);
    }
    await p.evaluate(() => { window.__off = 960 * 1000; }); await p.waitForTimeout(800);
    assert((await p.locator('.demo-clock').textContent()) === '00:00', 'clock ends 00:00');
    noErr(h);
  }));

  await check('global: settings — 4 AI modes, API key/model persist, no network, close by Esc/X/overlay', () => withPage({ route: 'home', ai: 'artifact' }, async (h, p) => {
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    const want = { '규칙 엔진만': '규칙 엔진 (AI 미연결)', 'claude.ai': 'Claude 연결됨 (claude.ai)', 'API 키': '규칙 엔진 (AI 미연결)', '자동': 'Claude 연결됨 (claude.ai)' };
    for (const [lbl, pill] of Object.entries(want)) {
      await p.locator('[role=dialog] .seg button', { hasText: lbl }).click(); await p.waitForTimeout(250);
      assert((await topPill(p)) === pill, `${lbl}: ${await topPill(p)}`);
      assert((await p.locator('[role=dialog] .seg button[aria-pressed=true]').textContent()) === lbl, 'pressed');
    }
    await p.locator('[role=dialog] .seg button', { hasText: 'API 키' }).click();
    await p.fill('#api-key', '  sk-ant-qa  ');
    assert((await p.getAttribute('#api-key', 'type')) === 'password', 'password field');
    await p.selectOption('#ai-model', 'claude-haiku-5-5');
    await p.getByRole('button', { name: '저장' }).click(); await p.waitForTimeout(300);
    assert((await p.locator('[role=dialog]').count()) === 0, 'save closes');
    await h.reload();
    const s = await ls(p);
    assert(s.ai.mode === 'anthropic' && s.ai.apiKey === 'sk-ant-qa' && s.ai.model === 'claude-haiku-5-5', `ai saved ${JSON.stringify(s.ai)}`);
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    assert((await p.inputValue('#api-key')) === 'sk-ant-qa' && (await p.inputValue('#ai-model')) === 'claude-haiku-5-5', 'fields restored');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    assert((await p.locator('[role=dialog]').count()) === 0, 'Esc');
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    await p.locator('[role=dialog]').getByRole('button', { name: '닫기' }).click(); await p.waitForTimeout(200);
    assert((await p.locator('[role=dialog]').count()) === 0, 'X');
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    await p.mouse.click(4, 4); await p.waitForTimeout(200);
    assert((await p.locator('[role=dialog]').count()) === 0, 'overlay');
    assert(h.net.length === 0, `network: ${h.net.join(',')}`);
    assert((await h.calls()).length === 0, 'no sample calls');
    noErr(h);
  }));

  await check('global: two-step reset clears changes/incidents/comments → Alert rescan + Flow seeds', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    const seeds = (await ls(p)).changes.map((c) => c.id).sort();
    await closeToasts(p);
    const c = await runScenario(p);
    await c.getByRole('button', { name: '이 시나리오로 승인 요청 만들기' }).click(); await p.waitForTimeout(200);
    await p.evaluate(() => { const k = 'mildo-os/v1'; }); // (코멘트는 리포트 화면에서 — 저장본에 직접 넣어 검증)
    await go(p, 'flow');
    await p.locator('.flow-queue-row', { hasText: '생활 상황_TEST' }).getByRole('button', { name: '승인', exact: true }).click(); await p.waitForTimeout(200);
    assert((await ls(p)).changes.length === seeds.length + 2, 'scenario added');
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    await p.getByRole('button', { name: '시연 상태 초기화' }).click();
    assert((await p.getByRole('button', { name: '정말 초기화' }).count()) === 1, 'second step shown');
    assert((await ls(p)).changes.length === seeds.length + 2, 'first step does nothing');
    await p.getByRole('button', { name: '정말 초기화' }).click(); await p.waitForTimeout(800);
    const s = await ls(p);
    assert(JSON.stringify(s.changes.map((x) => x.id).sort()) === JSON.stringify(seeds), `changes not reset to seeds: ${s.changes.length}`);
    assert(s.incidents.length > 0 && s.incidents.every((i) => i.status === 'open'), 'incidents rescanned');
    assert(s.comments.length === 0, 'comments cleared');
    assert((await p.locator('.toast', { hasText: 'P1 이슈' }).count()) === 1, 'P1 toast after reset');
    noErr(h);
  }));

  await check('global: toasts — close, 바로 가기 navigates, each toast keeps its own timer', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await p.locator('.toast', { hasText: 'P1 이슈' }).getByRole('button', { name: '바로 가기' }).click(); await p.waitForTimeout(400);
    assert((await hash(p)) === '#alert', '바로 가기 → alert');
    assert((await p.locator('.toast', { hasText: 'P1 이슈' }).count()) === 0, 'toast dismissed on 바로 가기');
    await go(p, 'agent');
    await p.locator('button', { hasText: '오늘 무엇부터' }).click(); await p.waitForTimeout(300);
    const copy = p.locator('.msg.assistant').last().getByRole('button', { name: '복사' });
    await copy.click(); await p.waitForTimeout(150);
    assert((await p.locator('.toast', { hasText: '클립보드에 복사했습니다' }).count()) === 1, 'copy toast');
    await p.waitForTimeout(2500);
    await copy.click(); await p.waitForTimeout(150); // 두 번째 알림 — 첫 알림 타이머를 늘리면 안 된다
    await p.waitForTimeout(2700);
    assert((await p.locator('.toast', { hasText: '클립보드에 복사했습니다' }).count()) === 1, 'first toast should have expired at ~5s');
    await p.locator('.toast .icon-btn').first().click(); await p.waitForTimeout(150);
    assert((await p.locator('.toast').count()) === 0, 'close button');
    noErr(h);
  }));

  await check('global: localStorage throws / corrupt / wrong-shape → app still works', async () => {
    for (const mode of ['getter-throws', 'methods-throw', 'quota', 'corrupt', 'wrong-shape']) {
      await withPage({ route: 'home', ai: 'none' }, async (h, p) => {
        if (mode === 'corrupt') await p.evaluate(() => localStorage.setItem('mildo-os/v1', '{not json'));
        if (mode === 'wrong-shape') await p.evaluate(() => localStorage.setItem('mildo-os/v1', JSON.stringify({ changes: 'x', incidents: { a: 1 }, comments: null, ai: 5, role: 'hacker', tf: [], extra: 1 })));
        await p.addInitScript((m) => {
          if (m === 'getter-throws') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
          if (m === 'methods-throw') { Storage.prototype.getItem = () => { throw new Error('no'); }; Storage.prototype.setItem = () => { throw new Error('no'); }; }
          if (m === 'quota') Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
        }, mode);
        await h.reload();
        assert((await p.locator('main h1').first().textContent({ timeout: 3000 })) === '오늘의 운영', `${mode}: home not rendered`);
        await p.selectOption('#role-select', '담당 AE', { timeout: 3000 });
        await go(p, 'agent');
        await p.locator('button', { hasText: '오늘 무엇부터' }).click({ timeout: 3000 }); await p.waitForTimeout(300);
        assert((await p.locator('.msg.assistant').count()) === 1, `${mode}: agent`);
        await go(p, 'flow');
        assert((await p.locator('main h1').first().textContent({ timeout: 3000 })) === 'MILDO Flow', `${mode}: flow`);
        assert(h.errors.length === 0, `${mode}: ${h.errors[0]}`);
      });
    }
  });

  /* ================= 커맨드 센터 ================= */
  await check('home: KPI tiles (5) have finite values and deltas', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    const tiles = await p.locator('.home-kpis .card').allTextContents();
    assert(tiles.length === 5, `tiles ${tiles.length}`);
    for (const t of tiles) assert(!/NaN|Infinity|undefined|—/.test(t) && /\d/.test(t) && /[+-]\d/.test(t), `bad tile: ${t}`);
    noErr(h);
  }));

  await check("home: '지금 처리할 것' items navigate; Flow pending card equals store", () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    const todo = card(p, '지금 처리할 것');
    const links = todo.locator('a');
    const n = await links.count();
    assert(n >= 4, 'items');
    const pend = (await ls(p)).changes.filter((c) => c.status === 'pending').length;
    assert((await todo.locator('a[href="#flow"]').textContent()).includes(`${pend}건`), 'pending count');
    for (let i = 0; i < n; i++) {
      await go(p, 'home');
      const a = links.nth(i); const href = await a.getAttribute('href');
      await a.click(); await p.waitForTimeout(300);
      assert((await hash(p)) === href, `${href}`);
    }
    noErr(h);
  }));

  await check('home: timetable matches Reports (Saturday → 09:30 briefing moved, no "0분")', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    const rows = await card(p, '데이터 제공 시간표').locator('li').allTextContents();
    assert(rows.length === 7, `rows ${rows.length}`);
    const brief = rows.find((r) => r.startsWith('09:30'));
    assert(brief && !brief.endsWith('완료') && brief.includes('이동'), `09:30 row: ${brief}`);
    assert(!rows.some((r) => / 0분/.test(r)), `0분: ${rows.join('|')}`);
    await go(p, 'reports');
    await p.locator('main [role=tab]', { hasText: '데이터 제공 시간표' }).click(); await p.waitForTimeout(400);
    assert((await p.locator('main').textContent()).includes('09:30 이동'), 'reports shows moved');
    noErr(h);
  }));

  await check('home: MILDO OS map (5), live demo segments (5), RFP D-day + links, Board open', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    for (const [title, sel, want] of [['MILDO OS · 수면밀도', 'a.card', ['#board', '#watch', '#lab', '#alert', '#flow']], ['라이브 데모 15분', 'a.home-demo-seg', ['#board', '#adpilot', '#alert', '#reports', '#flow']]]) {
      for (let i = 0; i < want.length; i++) {
        await go(p, 'home');
        await card(p, title).locator(sel).nth(i).click(); await p.waitForTimeout(300);
        assert((await hash(p)) === want[i], `${title} ${i} → ${await hash(p)}`);
      }
    }
    await go(p, 'home');
    const rfp = card(p, 'RFP 대응 현황');
    assert((await rfp.locator('.card-sub').textContent()).includes('D-16'), 'D-16');
    assert((await rfp.locator('.home-rfp-row').count()) === 6, '6 rows');
    await rfp.locator('a[href="#ops"]').click(); await p.waitForTimeout(300);
    assert((await hash(p)) === '#ops', 'rfp link');
    await go(p, 'home');
    await card(p, '데이터 제공 시간표').locator('a[href="#reports"]').click(); await p.waitForTimeout(300);
    assert((await hash(p)) === '#reports', 'timetable link');
    await go(p, 'home');
    await p.getByRole('button', { name: 'MILDO Board 열기' }).click(); await p.waitForTimeout(300);
    assert((await hash(p)) === '#board' && (await p.locator('.demobar').count()) === 0, 'board open');
    noErr(h);
  }));

  await check("home: '신혼 매트리스' scenario → 2 ChangeRequests (Lab AE · GFA +12% PM) in Flow, no duplicates", () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    const before = (await ls(p)).changes.map((c) => c.id);
    const c = await runScenario(p);
    const steps = await c.locator('.home-scn-step').allTextContents();
    assert(steps.length === 6, 'six steps');
    assert(steps[4].includes('+12%') && steps[4].includes('896,000원') && steps[4].includes('PM 승인'), `step5: ${steps[4]}`);
    await c.getByRole('button', { name: '이 시나리오로 승인 요청 만들기' }).dblclick(); await p.waitForTimeout(300);
    let fresh = (await ls(p)).changes.filter((x) => !before.includes(x.id));
    assert(fresh.length === 2, `created ${fresh.length}`);
    const lab = fresh.find((x) => x.module === 'lab'); const gfa = fresh.find((x) => x.module === 'gfa');
    assert(lab && lab.kind === 'keyword_add' && lab.approver === 'AE' && lab.status === 'pending', 'lab req');
    assert(gfa && gfa.kind === 'budget' && gfa.approver === 'PM' && gfa.changePct === 12 && gfa.after === 896000 && gfa.status === 'pending', `gfa req ${JSON.stringify(gfa)}`);
    // 토스트(5초) 바로 가기 → Flow, 승인 대기 열
    const toasts = await p.locator('.toast', { hasText: '승인 요청' }).count();
    assert(toasts === 1, `one toast for double click (${toasts})`);
    await p.locator('.toast', { hasText: '승인 요청 2건' }).getByRole('button', { name: '바로 가기' }).click(); await p.waitForTimeout(500);
    assert((await hash(p)) === '#flow', 'toast → flow');
    assert((await p.locator('.toast', { hasText: '승인 요청 2건' }).count()) === 0, 'toast dismissed after 바로 가기');
    // 화면 이동 후 재실행해도 중복 생성 안 됨 (회귀)
    await go(p, 'board'); await go(p, 'home');
    const c2 = await runScenario(p);
    const b2 = c2.getByRole('button', { name: '승인 요청 생성됨' });
    assert((await b2.count()) === 1 && (await b2.isDisabled()), 'disabled after revisit');
    await b2.click({ force: true }).catch(() => {}); await p.waitForTimeout(200);
    fresh = (await ls(p)).changes.filter((x) => !before.includes(x.id));
    assert(fresh.length === 2, 'no dup after revisit');
    await go(p, 'flow');
    for (const t of ['생활 상황_TEST', '쇼핑 고객 확장']) {
      const cards = p.locator('.flow-card', { hasText: t });
      assert((await cards.count()) === 1, `${t} cards ${await cards.count()}`);
      assert((await cards.first().evaluate((el) => el.closest('section')?.getAttribute('aria-label'))) === '승인 대기', `${t} column`);
    }
    // 역할 규칙: AE는 GFA(PM)건 승인 불가, PM은 둘 다
    await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(300);
    assert((await p.locator('.flow-queue-row', { hasText: '쇼핑 고객 확장' }).count()) === 0, 'AE must not get PM item');
    await p.locator('.flow-queue-row', { hasText: '생활 상황_TEST' }).getByRole('button', { name: '승인', exact: true }).click(); await p.waitForTimeout(200);
    await p.selectOption('#role-select', 'PM'); await p.waitForTimeout(300);
    await p.locator('.flow-queue-row', { hasText: '쇼핑 고객 확장' }).getByRole('button', { name: '승인', exact: true }).click(); await p.waitForTimeout(200);
    const s = await ls(p);
    assert(s.changes.find((x) => x.id === lab.id).status === 'approved' && s.changes.find((x) => x.id === gfa.id).status === 'approved', 'approved');
    // 승인되면 시나리오를 다시 만들 수 있다
    await go(p, 'home');
    const c3 = await runScenario(p);
    assert((await c3.getByRole('button', { name: '이 시나리오로 승인 요청 만들기' }).isEnabled()), 'enabled after approval');
    // 새로고침 뒤에도 유지
    await h.reload();
    assert((await ls(p)).changes.filter((x) => !before.includes(x.id)).length === 2, 'persisted');
    noErr(h);
  }));

  async function aiInsightCase(route, title, ai, tabText) {
    await withPage({ route, ai }, async (h, p) => {
      if (tabText) { await p.locator('main [role=tab]', { hasText: tabText }).click(); await p.waitForTimeout(300); }
      const c = card(p, title);
      assert((await c.count()) === 1, 'card');
      const btn = c.locator('.card-head button.accent').first();
      await btn.click();
      if (ai === 'slow') {
        assert(await until(async () => (await c.locator('.md, .markdown').count()) > 0 || (await c.textContent()).includes('확정 팩트'), 4000), 'partial streamed');
        await c.getByRole('button', { name: '중지' }).click();
        const t0 = Date.now();
        assert(await until(async () => (await c.locator('.card-head button.accent').count()) === 1, 3000, 30), 'idle after stop');
        assert(Date.now() - t0 < 500, `stop took ${Date.now() - t0}ms`);
        const t = await c.textContent();
        assert(t.includes('확정 팩트') && !t.includes('중지했습니다') && !t.includes('오류'), 'partial kept, no error');
        await p.waitForTimeout(3500);
        assert(!(await c.textContent()).includes(MOCK_END), 'late chunks ignored after stop');
      } else {
        await p.waitForTimeout(1300);
        const t = await c.textContent();
        const pills = await c.locator('.card-head .pill, .card-head .src').allTextContents();
        if (ai === 'artifact') assert(t.includes(MOCK_END) && pills.includes('AI 해석'), `artifact text/tag ${pills}`);
        if (ai === 'none' || ai === 'unavailable') assert(t.includes('확정 팩트') && t.includes('다음 액션') && pills.includes('규칙 엔진'), `rule ${pills}`);
        if (ai === 'denied') assert(t.includes('Claude 사용이 허용되지 않았습니다') && t.includes('확정 팩트') && pills.includes('규칙 엔진'), 'denied copy');
        if (ai === 'rate') assert(t.includes('요청이 많습니다') && t.includes('다음 액션'), 'rate copy');
        if (ai === 'error-mid') assert(t.includes('일시적인 연결 오류') && t.includes('모의 응답'), 'error-mid partial');
        assert((await c.locator('.card-head button.accent').count()) === 1, 'button usable');
      }
      const n1 = (await h.calls()).length; await p.waitForTimeout(1500); const n2 = (await h.calls()).length;
      assert(n1 === n2, 'auto retry');
      const want = ['none', 'unavailable'].includes(ai) ? 0 : 1;
      assert(n2 === want, `calls ${n2} want ${want}`);
      for (const call of await h.calls()) assert(call.cache === false && call.tools.length === 0, 'AiInsight must pass cache:false');
      if (ai === 'denied') {
        assert(await until(async () => (await topPill(p)) === '규칙 엔진 (AI 미연결)', 2000), `top pill after denied: ${await topPill(p)}`);
        await c.locator('.card-head button.accent').first().click(); await p.waitForTimeout(800);
        assert((await h.calls()).length === 1, 'no re-request after denied');
      }
      noErr(h);
    });
  }
  for (const ai of ['none', 'artifact', 'denied', 'rate', 'error-mid', 'slow', 'unavailable']) {
    await check(`home: AI 브리프 (AiInsight) ai=${ai}`, () => aiInsightCase('home', '오늘의 운영 브리프', ai));
  }
  for (const [route, title] of [['board', '기간 성과 해석'], ['alert', 'AI 원인 분석'], ['growth', '성장 과제 해석']]) {
    for (const ai of ['none', 'artifact', 'denied', 'rate', 'error-mid', 'slow', 'unavailable']) {
      await check(`shared AiInsight: ${route} ai=${ai}`, () => aiInsightCase(route, title, ai));
    }
  }

  await check('home: AiInsight copy button → clipboard has markdown', () => withPage({ route: 'home', ai: 'artifact' }, async (h, p) => {
    const c = card(p, '오늘의 운영 브리프');
    await c.locator('.card-head button.accent').click(); await p.waitForTimeout(1200);
    await c.getByRole('button', { name: '복사' }).click(); await p.waitForTimeout(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    assert(clip.includes('### 확정 팩트') && clip.endsWith(MOCK_END), `clip ${clip.slice(0, 60)}`);
    noErr(h);
  }));

  /* ================= MILDO Agent ================= */
  await check('agent: 8 quick prompts (rule mode) → zoned briefs + tool chips, no AI calls', () => withPage({ route: 'agent', ai: 'none' }, async (h, p) => {
    const quick = () => card(p, '무엇을 판단해야').locator('button');
    assert((await quick().count()) === 8, 'eight prompts');
    for (let i = 0; i < 8; i++) {
      const q = await quick().nth(i).textContent();
      await quick().nth(i).click(); await p.waitForTimeout(300);
      const a = p.locator('.msg.assistant').last();
      assert((await a.locator('h4').count()) >= 1, `Q${i + 1} no brief`);
      assert((await a.locator('.zone.fact').count()) >= 1 && (await a.locator('.zone.action').count()) >= 1, `Q${i + 1} zones`);
      const chips = await a.locator('.tool-chip').allTextContents();
      assert(chips.length >= 1, `Q${i + 1} chips`);
      if (q.includes('신혼')) assert(chips.some((c) => c.startsWith('lab:')), `Q5 should use Lab brief: ${chips}`);
      assert((await a.locator('.pill').first().textContent()) === '규칙 엔진', 'rule pill');
      await p.getByRole('button', { name: '새 대화' }).click(); await p.waitForTimeout(150);
      assert((await p.locator('.msg').count()) === 0, 'new chat clears');
    }
    assert((await h.calls()).length === 0, 'no calls');
    noErr(h);
  }));

  await check('agent: artifact — tools executed via runtime, chips, streamed, no cache with tools, turns trimmed', () => withPage({ route: 'agent', ai: 'artifact' }, async (h, p) => {
    await card(p, '무엇을 판단해야').locator('button').first().click();
    const lens = [];
    for (let i = 0; i < 25; i++) { await p.waitForTimeout(40); lens.push((await p.locator('.msg.assistant').last().textContent()).length); }
    await p.waitForTimeout(600);
    const a = p.locator('.msg.assistant').last();
    const final = (await a.textContent());
    assert(final.includes(MOCK_END), 'full mock text');
    assert(new Set(lens).size >= 3, `not streamed: ${[...new Set(lens)]}`);
    const chips = await a.locator('.tool-chip').allTextContents();
    const [call] = await h.calls();
    assert(call && call.tools.length > 0 && call.tools.length <= 20, 'tools passed');
    assert(JSON.stringify(chips) === JSON.stringify(call.toolResults.map((t) => t.name)), `chips ${chips} vs ${call.toolResults.map((t) => t.name)}`);
    assert(call.toolResults.every((t) => !t.error && t.bytes > 0 && t.bytes <= 32768), `tool results ${JSON.stringify(call.toolResults)}`);
    assert(call.cache === undefined, `cache with tools: ${call.cache}`);
    assert(call.turns === 2, 'turns start/end with user');
    assert((await a.locator('.src').allTextContents()).includes('AI 해석'), 'AI tag');
    for (let i = 0; i < 6; i++) { await p.fill('#agent-input', `후속 ${i}`); await p.keyboard.press('Enter'); await p.waitForTimeout(650); }
    const turns = (await h.calls()).map((c) => c.turns);
    assert(Math.max(...turns) <= 10 && turns[turns.length - 1] === 10, `turns ${turns}`);
    noErr(h);
  }));

  await check('agent: Stop with ai=slow → immediate, partial kept, no error, late chunks ignored', () => withPage({ route: 'agent', ai: 'slow' }, async (h, p) => {
    await p.fill('#agent-input', '오늘 현황'); await p.keyboard.press('Enter');
    assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes('모의 응답'), 6000), 'partial');
    assert(await p.getByRole('button', { name: '보내기' }).isDisabled(), 'send disabled while busy');
    await p.getByRole('button', { name: '중지' }).click();
    const t0 = Date.now();
    assert(await until(async () => (await p.getByRole('button', { name: '중지' }).count()) === 0, 3000, 30), 'idle');
    assert(Date.now() - t0 < 500, `stop took ${Date.now() - t0}ms`);
    await p.waitForTimeout(3500);
    const a = p.locator('.msg.assistant').last();
    const t = await a.textContent();
    assert(t.includes('모의 응답') && !t.includes(MOCK_END), 'partial kept / late ignored');
    assert((await a.locator('.xs.muted').count()) === 0, 'no error line');
    assert((await h.calls()).length === 1, 'calls');
    noErr(h);
  }));

  await check("agent: '새 대화' while streaming aborts and stays cleared", () => withPage({ route: 'agent', ai: 'slow' }, async (h, p) => {
    await p.fill('#agent-input', '오늘 현황'); await p.keyboard.press('Enter');
    await p.waitForTimeout(1800);
    await p.getByRole('button', { name: '새 대화' }).click();
    await p.waitForTimeout(4000);
    assert((await p.locator('.msg').count()) === 0, `msgs ${await p.locator('.msg').count()}`);
    assert((await p.getByRole('button', { name: '중지' }).count()) === 0, 'not busy');
    await p.fill('#agent-input', '다시'); await p.keyboard.press('Enter');
    assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes(MOCK_END), 8000), 'second run completes');
    noErr(h);
  }));

  for (const [ai, copy] of [['denied', 'Claude 사용이 허용되지 않았습니다'], ['rate', '요청이 많습니다'], ['error-mid', '일시적인 연결 오류']]) {
    await check(`agent: ai=${ai} → Korean error copy + rule fallback, no auto retry`, () => withPage({ route: 'agent', ai }, async (h, p) => {
      await p.fill('#agent-input', '오늘 무엇부터 처리해야 하나'); await p.keyboard.press('Enter');
      await p.waitForTimeout(1300);
      const a = p.locator('.msg.assistant').last();
      const t = await a.textContent();
      assert(t.includes(copy) && t.includes('오늘의 운영 브리프'), 'copy+fallback');
      if (ai === 'error-mid') assert(t.includes('모의 응답'), 'partial kept');
      const n = (await h.calls()).length; await p.waitForTimeout(2000);
      assert((await h.calls()).length === n && n === 1, 'auto retry');
      if (ai === 'denied') {
        assert((await topPill(p)) === '규칙 엔진 (AI 미연결)', `top pill ${await topPill(p)}`);
        assert((await p.locator('.page-head .pill').first().textContent()) === '규칙 엔진 (AI 미연결)', 'page pill');
        await p.fill('#agent-input', '두 번째'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
        assert((await h.calls()).length === 1, 'no re-request after denied');
        assert((await p.locator('.msg.assistant').last().locator('.pill').first().textContent()) === '규칙 엔진', 'rule answer');
      } else {
        await p.fill('#agent-input', '두 번째'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
        assert((await h.calls()).length === 2, 'manual retry allowed');
      }
      noErr(h);
    }));
  }

  await check('agent: Enter sends, Shift+Enter newline, IME composing (isComposing / keyCode 229) does not send', () => withPage({ route: 'agent', ai: 'none' }, async (h, p) => {
    const ta = p.locator('#agent-input');
    await ta.click(); await p.keyboard.type('첫 줄'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('둘째 줄 오늘');
    assert((await ta.inputValue()) === '첫 줄\n둘째 줄 오늘' && (await p.locator('.msg').count()) === 0, 'shift+enter');
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await p.evaluate((i) => document.getElementById('agent-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...i })), init);
      await p.waitForTimeout(200);
      assert((await p.locator('.msg').count()) === 0, `IME ${JSON.stringify(init)} sent`);
    }
    await ta.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    assert((await p.locator('.msg').count()) === 2 && (await ta.inputValue()) === '', 'enter sends');
    assert((await p.locator('.msg.user').evaluate((e) => getComputedStyle(e).whiteSpace)) === 'pre-wrap', 'user msg keeps line breaks');
    await ta.fill('   '); await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    assert((await p.locator('.msg').count()) === 2 && (await p.getByRole('button', { name: '보내기' }).isDisabled()), 'blank not sent');
    await ta.fill('보내기 버튼 테스트 현황'); await p.getByRole('button', { name: '보내기' }).click(); await p.waitForTimeout(300);
    assert((await p.locator('.msg').count()) === 4, 'send button');
    noErr(h);
  }));

  await check('agent: copy button → clipboard equals answer markdown; tool module links navigate', () => withPage({ route: 'agent', ai: 'none' }, async (h, p) => {
    await card(p, '무엇을 판단해야').locator('button').nth(2).click(); await p.waitForTimeout(300);
    await p.locator('.msg.assistant').last().getByRole('button', { name: '복사' }).click(); await p.waitForTimeout(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    assert(clip.startsWith('#### ') && clip.includes('### 확정 팩트'), `clip ${clip.slice(0, 50)}`);
    const links = p.locator('.agent-tools a');
    assert((await links.count()) === 12, 'module links');
    await links.nth(10).click(); await p.waitForTimeout(300);
    assert((await hash(p)) === '#alert', 'tool module link');
    noErr(h);
  }));

  await check('agent: conversation survives navigating away and back', () => withPage({ route: 'agent', ai: 'artifact' }, async (h, p) => {
    await p.fill('#agent-input', '오늘 현황'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
    await go(p, 'board'); await go(p, 'agent');
    assert((await p.locator('.msg').count()) === 2, `msgs ${await p.locator('.msg').count()}`);
    assert((await p.locator('.msg.assistant').last().textContent()).includes(MOCK_END), 'answer kept');
    await p.fill('#agent-input', '후속'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
    assert((await h.calls()).map((c) => c.turns).join(',') === '2,4', `turns ${(await h.calls()).map((c) => c.turns)}`);
    noErr(h);
  }));

  /* ================= 다운로드 (core/download.ts) ================= */
  await check('downloads: artifact accept → CSV saved (header, Korean) and MD saved (headings)', () => withPage({ route: 'board', ai: 'artifact', downloads: 'accept' }, async (h, p) => {
    await p.locator('main [role=tab]', { hasText: '키워드' }).first().click(); await p.waitForTimeout(400);
    await p.locator('main button', { hasText: '내보내기' }).first().click(); await p.waitForTimeout(500);
    await go(p, 'reports');
    await p.locator('main button', { hasText: '.md 다운로드' }).first().click(); await p.waitForTimeout(500);
    const s = await h.saves();
    const csv = s.find((x) => x.filename.endsWith('.csv')); const md = s.find((x) => x.filename.endsWith('.md'));
    assert(csv && csv.bytes > 100 && /키워드/.test(csv.head.split('\n')[0]), `csv ${csv && csv.head.slice(0, 80)}`);
    assert(md && md.bytes > 100 && /^#{1,3} /m.test(md.head), `md ${md && md.head.slice(0, 80)}`);
    assert(h.downloads.length === 0, 'no a[download] inside artifact');
    noErr(h);
  }));

  await check('downloads: decline → no error state; none → fallback toast; plain browser → download event', async () => {
    await withPage({ route: 'reports', ai: 'artifact', downloads: 'decline' }, async (h, p) => {
      await closeToasts(p);
      await p.locator('main button', { hasText: '.md 다운로드' }).first().click(); await p.waitForTimeout(500);
      assert((await h.saves()).length === 0 && (await p.locator('.toast.warning, .toast.critical').count()) === 0, 'decline shows no error');
      assert((await p.locator('main h1').textContent()) === '리포트 · 데이터 시간표', 'still on page');
      noErr(h);
    });
    await withPage({ route: 'reports', ai: 'artifact', downloads: 'none' }, async (h, p) => {
      await closeToasts(p);
      await p.locator('main button', { hasText: '.md 다운로드' }).first().click(); await p.waitForTimeout(500);
      assert((await p.locator('.toast', { hasText: '파일 저장을 지원하지 않습니다' }).count()) === 1, 'unavailable toast');
      noErr(h);
    });
    await withPage({ route: 'reports', ai: 'none' }, async (h, p) => {
      await p.locator('main button', { hasText: '.md 다운로드' }).first().click(); await p.waitForTimeout(800);
      assert(h.downloads.length === 1 && h.downloads[0].endsWith('.md'), `downloads ${h.downloads}`);
      noErr(h);
    });
  });

  /* ================= 2차 점검 추가분 ================= */
  await check('global: no external request except allowed Google Fonts on any route (artifact CSP)', () => withPage({ route: 'home', ai: 'artifact' }, async (h, p) => {
    for (const r of Object.keys(ROUTES)) await go(p, r);
    // 아티팩트 CSP 허용 목록: Google Fonts 스타일시트(fonts.googleapis.com) · 글꼴(fonts.gstatic.com)만 허용
    const FONT = /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/;
    const net = h.net.filter((u) => !FONT.test(u));
    assert(net.length === 0, `net ${net.slice(0, 3)}`);
    const ext = await p.evaluate(() => [...document.querySelectorAll('link[href^="http"], script[src^="http"], img[src^="http"]')].map((e) => e.getAttribute('href') || e.getAttribute('src')));
    const bad = ext.filter((u) => !FONT.test(u));
    assert(bad.length === 0, `external refs ${bad}`);
    noErr(h);
  }));

  await check('global: settings — Esc does not save key, API 키+key label, auto+key in claude.ai, blank key = none, offline no calls', () => withPage({ route: 'home', ai: 'artifact' }, async (h, p) => {
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    await p.fill('#api-key', 'sk-ant-unsaved'); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    assert((await ls(p)).ai.apiKey === '', 'Esc must not save key');
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    assert((await p.inputValue('#api-key')) === '', 'unsaved key shown again');
    await p.locator('[role=dialog] .seg button', { hasText: 'API 키' }).click();
    await p.fill('#api-key', 'sk-ant-qa'); await p.getByRole('button', { name: '저장' }).click(); await p.waitForTimeout(300);
    assert((await topPill(p)) === 'Claude API 연결됨', `anthropic+key ${await topPill(p)}`);
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    assert((await p.locator('[role=dialog] .small.ink2').textContent()).includes('Claude API 연결됨'), 'status line');
    await p.locator('[role=dialog] .seg button', { hasText: '자동' }).click(); await p.waitForTimeout(250);
    assert((await topPill(p)) === 'Claude 연결됨 (claude.ai)', `auto+key in artifact ${await topPill(p)}`);
    await p.locator('[role=dialog] .seg button', { hasText: '규칙 엔진만' }).click(); await p.waitForTimeout(250);
    await p.keyboard.press('Escape');
    await card(p, '오늘의 운영 브리프').locator('.card-head button.accent').click(); await p.waitForTimeout(500);
    assert((await h.calls()).length === 0 && (await card(p, '오늘의 운영 브리프').textContent()).includes('다음 액션'), 'offline → rule, no call');
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    await p.locator('[role=dialog] .seg button', { hasText: 'API 키' }).click();
    await p.fill('#api-key', '    '); await p.getByRole('button', { name: '저장' }).click(); await p.waitForTimeout(300);
    assert((await topPill(p)) === '규칙 엔진 (AI 미연결)' && (await ls(p)).ai.apiKey === '', 'blank key trimmed → none');
    await go(p, 'agent');
    await p.fill('#agent-input', '오늘 현황'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    assert((await p.locator('.msg.assistant .pill').first().textContent()) === '규칙 엔진', 'agent rule in key-less API mode');
    assert(h.net.length === 0, `net ${h.net}`);
    noErr(h);
  }));

  await check('global: reset with real comment + resolved incident + running demo → cleared, role/AI kept, armed state not sticky', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    const incId = (await ls(p)).incidents[0].id;
    await p.evaluate((id) => { const k = 'mildo-os/v1'; const s = JSON.parse(localStorage.getItem(k)); s.comments.push({ id: 'cm-qa', target: 'weekly', author: 'PM', text: 'QA 코멘트', at: '2026-10-31T15:00:00+09:00' }); s.incidents = s.incidents.map((i) => (i.id === id ? { ...i, status: 'resolved' } : i)); s.role = '담당 AE'; s.ai = { ...s.ai, mode: 'offline', model: 'claude-sonnet-5-5' }; localStorage.setItem(k, JSON.stringify(s)); }, incId);
    const LOCAL = ['mildo-os/lab/v1', 'mildo-os/watch/v1', 'mildo-os/ops-v1', 'mildo-os/geo/live/v1', 'mildo-os/geo/case/v1'];
    await p.evaluate((ks) => { for (const k of ks) localStorage.setItem(k, '{"qa":1}'); }, LOCAL);
    await h.reload();
    let s = await ls(p);
    assert(s.comments.length === 1 && s.incidents.find((i) => i.id === incId).status === 'resolved', 'seeded state persisted across reload');
    await p.locator('header.topbar').getByRole('button', { name: '라이브 데모 15분' }).click(); await p.waitForTimeout(400);
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    await p.getByRole('button', { name: '시연 상태 초기화' }).click();
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
    await p.getByRole('button', { name: '설정' }).click(); await p.waitForTimeout(200);
    assert((await p.getByRole('button', { name: '정말 초기화' }).count()) === 0, 'armed state sticky');
    await p.getByRole('button', { name: '시연 상태 초기화' }).click();
    await p.getByRole('button', { name: '정말 초기화' }).click(); await p.waitForTimeout(900);
    s = await ls(p);
    assert(s.comments.length === 0, 'comments');
    assert(s.incidents.find((i) => i.id === incId)?.status === 'open', 'incident rescanned open');
    assert(s.role === '담당 AE' && s.ai.mode === 'offline' && s.ai.model === 'claude-sonnet-5-5', 'role/AI settings kept');
    assert((await p.locator('.demobar').count()) === 0, 'demo stopped by reset');
    // 'mildo-os:reset' 알림 → 모듈 로컬 기록(Lab · Watch · Ops · GEO)도 처음 상태 (회귀: 이벤트를 아무도 보내지 않았음)
    const left = await p.evaluate((ks) => ks.filter((k) => localStorage.getItem(k) === '{"qa":1}'), LOCAL);
    assert(left.length === 0, `module-local records not reset: ${left}`);
    assert(Number(await p.locator('.nav-item[href="#alert"] .nav-badge').textContent()) === s.incidents.filter((i) => i.status !== 'resolved').length, 'alert badge');
    noErr(h);
  }));

  await check('global: sidebar/todo badges update live (scenario +2, approve −1)', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await closeToasts(p);
    const fb = async () => Number(await p.locator('.nav-item[href="#flow"] .nav-badge').textContent());
    const b0 = await fb();
    const c = await runScenario(p);
    await c.getByRole('button', { name: '이 시나리오로 승인 요청 만들기' }).click(); await p.waitForTimeout(300);
    assert((await fb()) === b0 + 2, `flow badge ${b0} → ${await fb()}`);
    assert((await card(p, '지금 처리할 것').locator('a[href="#flow"]').textContent()).includes(`${b0 + 2}건`), 'todo count');
    await go(p, 'flow');
    await p.locator('.flow-queue-row', { hasText: '생활 상황_TEST' }).getByRole('button', { name: '승인', exact: true }).click(); await p.waitForTimeout(200);
    assert((await fb()) === b0 + 1, 'badge after approve');
    noErr(h);
  }));

  await check('global: module render error → error card (sidebar intact), 다시 시도, 커맨드 센터 link, route change resets', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await p.evaluate(() => {
      const d = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
      Object.defineProperty(Intl.NumberFormat.prototype, 'format', { configurable: true, get() { if (window.__boom) throw new Error('QA 강제 렌더 오류'); return d.get.call(this); } });
    });
    const box = p.locator('main section.card[role=alert]');
    await p.evaluate(() => { window.__boom = true; location.hash = 'board'; }); await p.waitForTimeout(600);
    assert((await box.count()) === 1 && (await box.textContent()).includes('MILDO Board 화면을 표시하지 못했습니다'), 'error card');
    assert((await p.locator('.nav-item').count()) === 12 && (await p.locator('header.topbar').count()) === 1, 'shell intact');
    await p.evaluate(() => { window.__boom = false; });
    await box.getByRole('button', { name: '다시 시도' }).click(); await p.waitForTimeout(500);
    assert((await p.locator('main h1').first().textContent()) === 'MILDO Board', 'retry renders');
    await p.evaluate(() => { window.__boom = true; location.hash = 'geo'; }); await p.waitForTimeout(600);
    await p.evaluate(() => { window.__boom = false; });
    await box.getByRole('link', { name: '커맨드 센터' }).click(); await p.waitForTimeout(500);
    assert((await hash(p)) === '#home' && (await p.locator('main h1').first().textContent()) === '오늘의 운영', 'home link');
    await go(p, 'geo');
    assert((await box.count()) === 0, 'boundary reset on route change');
    // 강제 오류는 React가 console.error로 남긴다 — 그 외 오류는 없어야 한다
    assert(h.errors.every((e) => e.includes('QA 강제 렌더 오류')), `other errors: ${h.errors.find((e) => !e.includes('QA 강제 렌더 오류'))}`);
  }));

  await check('global: demo seek while paused stays paused at segment start', () => withPage({ route: 'home', ai: 'none' }, async (h, p) => {
    await p.locator('header.topbar').getByRole('button', { name: '라이브 데모 15분' }).click(); await p.waitForTimeout(500);
    await p.getByRole('button', { name: '일시정지' }).click(); await p.waitForTimeout(200);
    await p.locator('.demo-step').nth(2).click(); await p.waitForTimeout(400);
    assert((await hash(p)) === '#alert', 'seek route');
    const c1 = await p.locator('.demo-clock').textContent(); await p.waitForTimeout(1300);
    assert((await p.locator('.demo-clock').textContent()) === c1 && (await p.getByRole('button', { name: '재개' }).count()) === 1, 'still paused');
    assert((await p.locator('.demo-step[aria-current=step]').textContent()).includes((await p.locator('.demo-step').nth(2).textContent())), 'current = seeked');
    noErr(h);
  }));

  await check('AiInsight: double-click start does not cancel; double-click 중지 does not restart; keyboard Enter runs (regression)', async () => {
    for (const ai of ['artifact', 'slow']) {
      await withPage({ route: 'home', ai }, async (h, p) => {
        const c = card(p, '오늘의 운영 브리프');
        await c.locator('.card-head button.accent').dblclick();
        assert(await until(async () => (await c.textContent()).includes(MOCK_END), ai === 'slow' ? 7000 : 2500), `${ai}: dblclick cancelled the run`);
        assert((await h.calls()).length === 1, `${ai}: calls ${(await h.calls()).length}`);
        noErr(h);
      });
    }
    await withPage({ route: 'home', ai: 'slow' }, async (h, p) => {
      const c = card(p, '오늘의 운영 브리프');
      await c.locator('.card-head button.accent').click();
      assert(await until(async () => (await c.textContent()).includes('확정 팩트'), 4000), 'partial');
      await c.getByRole('button', { name: '중지' }).dblclick(); await p.waitForTimeout(600);
      assert((await h.calls()).length === 1 && (await c.getByRole('button', { name: '중지' }).count()) === 0, 'dblclick stop restarted');
      await c.locator('.card-head button.accent').focus(); await p.keyboard.press('Enter');
      assert(await until(async () => (await h.calls()).length === 2, 1500), 'keyboard Enter runs');
      await c.getByRole('button', { name: '중지' }).click();
      noErr(h);
    });
  });

  await check('agent: ai=unavailable → rule answer, no calls', () => withPage({ route: 'agent', ai: 'unavailable' }, async (h, p) => {
    assert((await p.locator('.page-head .pill').first().textContent()) === '규칙 엔진 (AI 미연결)', 'page pill');
    await card(p, '무엇을 판단해야').locator('button').nth(1).click(); await p.waitForTimeout(400);
    assert((await p.locator('.msg.assistant .pill').first().textContent()) === '규칙 엔진' && (await h.calls()).length === 0, 'rule, no call');
    noErr(h);
  }));

  await check('agent: rapid double clicks (quick prompt none/slow, 보내기) + Enter while busy → one question, one call', async () => {
    await withPage({ route: 'agent', ai: 'none' }, async (h, p) => {
      await card(p, '무엇을 판단해야').locator('button').first().dblclick(); await p.waitForTimeout(400);
      assert((await p.locator('.msg').count()) === 2, `none msgs ${await p.locator('.msg').count()}`);
    });
    await withPage({ route: 'agent', ai: 'slow' }, async (h, p) => {
      await card(p, '무엇을 판단해야').locator('button').first().dblclick(); await p.waitForTimeout(300);
      await p.fill('#agent-input', '바쁠 때 엔터'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
      assert((await h.calls()).length === 1 && (await p.locator('.msg').count()) === 2, 'one call');
      assert((await p.inputValue('#agent-input')) === '바쁠 때 엔터', 'input kept while busy');
      assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes(MOCK_END), 8000), 'completes');
      await p.fill('#agent-input', '두 번 보내기'); await p.getByRole('button', { name: '보내기' }).dblclick();
      assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes(MOCK_END) && (await p.locator('.msg').count()) === 4, 8000), 'send dblclick completes once');
      assert((await h.calls()).length === 2, `calls ${(await h.calls()).length}`);
      noErr(h);
    });
  });

  await check('agent: stop before first chunk → neutral note (no error); leaving mid-stream keeps partial, not busy', async () => {
    await withPage({ route: 'agent', ai: 'slow' }, async (h, p) => {
      await p.fill('#agent-input', '오늘 현황'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
      await p.getByRole('button', { name: '중지' }).click(); await p.waitForTimeout(3500);
      const a = p.locator('.msg.assistant').last();
      assert((await a.textContent()).includes('중지했습니다') && (await a.locator('.xs.muted').count()) === 0, 'neutral note');
      await p.fill('#agent-input', '다시'); await p.keyboard.press('Enter');
      assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes(MOCK_END), 8000), 'next run');
      const c = await h.calls(); assert(c.length === 2 && c[1].turns % 2 === 0, `turns ${c.map((x) => x.turns)}`);
      noErr(h);
    });
    await withPage({ route: 'agent', ai: 'slow' }, async (h, p) => {
      await p.fill('#agent-input', '오늘 현황'); await p.keyboard.press('Enter');
      assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes('모의 응답'), 6000), 'partial');
      await go(p, 'board'); await p.waitForTimeout(3500); await go(p, 'agent');
      const a = p.locator('.msg.assistant').last(); const t = await a.textContent();
      assert(t.includes('모의 응답') && !t.includes(MOCK_END), 'partial kept, late chunks ignored');
      assert((await p.getByRole('button', { name: '중지' }).count()) === 0 && (await a.locator('.xs.muted').count()) === 0, 'idle, no error');
      noErr(h);
    });
  });

  await check('agent: navigate tool within 20-tool limit → 화면 열기 button (no jump mid-answer); every tool result ≤32KB in browser (regression)', () => withPage({ route: 'agent', ai: 'artifact' }, async (h, p) => {
    await p.addInitScript(() => {
      const orig = window.claude; if (!orig) return;
      window.__allTools = [];
      window.claude = Object.freeze({ use: async (n) => {
        const s = await orig.use(n); if (n !== 'sample' || !s) return s;
        const w = async (input, opts = {}) => {
          for (const tl of opts.tools || []) {
            try { const r = await tl.execute(tl.name === 'navigate' ? { route: 'flow' } : {}, { signal: new AbortController().signal }); const str = typeof r === 'string' ? r : JSON.stringify(r); window.__allTools.push({ name: tl.name, bytes: new TextEncoder().encode(str).length }); }
            catch (e) { window.__allTools.push({ name: tl.name, error: String(e.message || e) }); }
          }
          return s(input, opts);
        };
        w.json = s.json; w.limits = s.limits; return w;
      } });
    });
    await h.reload();
    await p.fill('#agent-input', '승인 대기 보여줘'); await p.keyboard.press('Enter');
    assert(await until(async () => (await p.locator('.msg.assistant').last().textContent()).includes(MOCK_END), 6000), 'done');
    assert((await hash(p)) === '#agent', 'jumped away mid-answer');
    const all = await p.evaluate(() => window.__allTools);
    assert(all.length === 20 && all.some((x) => x.name === 'navigate'), `navigate not passed: ${all.map((x) => x.name)}`);
    assert(all.every((x) => !x.error && x.bytes > 0 && x.bytes <= 32768), `tool results ${JSON.stringify(all.filter((x) => x.error || x.bytes > 32768))}`);
    const btn = p.locator('.msg.assistant').last().getByRole('button', { name: 'MILDO Flow 화면 열기' });
    assert((await btn.count()) === 1, 'nav button');
    await btn.click(); await p.waitForTimeout(400);
    assert((await hash(p)) === '#flow', 'nav → flow');
    noErr(h);
  }));

  /* ================= CLI (네트워크 없음) ================= */
  const run = (args) => spawnSync('npm', ['run', '-s', ...args], { cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, NAVER_API_KEY: '', NAVER_SECRET_KEY: '', NAVER_CUSTOMER_ID: '', SLACK_WEBHOOK_URL: '' } });
  await check('cli: npm run -s sentinel (text report)', async () => {
    const r = run(['sentinel']);
    assert(r.status === 0, `exit ${r.status} ${r.stderr.slice(0, 200)}`);
    assert(r.stdout.length > 200 && /P1/.test(r.stdout), 'report content');
  });
  await check('cli: npm run -s sentinel -- --json (valid JSON)', async () => {
    const r = run(['sentinel', '--', '--json']);
    assert(r.status === 0, `exit ${r.status}`);
    const j = JSON.parse(r.stdout);
    assert(j && typeof j === 'object', 'json');
  });
  await check('cli: npm run -s keywords (header + 48 rows)', async () => {
    const r = run(['keywords']);
    assert(r.status === 0, `exit ${r.status}`);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert(lines.length === 49, `lines ${lines.length}`);
  });

  console.log(fails ? `SUMMARY: ${fails} FAIL` : 'SUMMARY: ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log(`FAIL e2e-crash: ${e.message}`); process.exit(1); });
