/* MILDO OS 기능 점검 — AD Pilot · GFA Control (#adpilot) + MILDO Flow (#flow) end-to-end
 * usage: NODE_PATH=$(npm root -g) node qa/e2e/adpilot-flow.e2e.cjs dist-single/index.html [areaFilter]
 * prints 'PASS <name>' / 'FAIL <name>: <reason>' per check, exit 1 on any FAIL. */
const { open } = require(require('path').join(__dirname, 'harness.cjs'));
const FILE = process.argv[2] || require('path').join(__dirname, '../../dist-single/index.html');
const ONLY = process.argv[3] || '';
let fails = 0; let passes = 0;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
function expect(cond, msg) { if (!cond) throw new Error(msg); }
async function check(name, fn) {
  try { await fn(); passes++; console.log(`PASS ${name}`); } catch (e) { fails++; console.log(`FAIL ${name}: ${clean(e && e.message || e).slice(0, Number(process.env.ERRLEN || 300))}`); }
}
async function area(name, opts, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  let h;
  try {
    h = await open({ file: FILE, ...opts });
    const p = h.page;
    const H = helpers(h);
    await H.dismiss();
    await fn(h, p, H);
    await check(`${name}: no console errors`, async () => expect(h.errors.length === 0, JSON.stringify(h.errors).slice(0, 300)));
  } catch (e) { fails++; console.log(`FAIL ${name}: area crashed: ${clean(e && e.message || e).slice(0, Number(process.env.ERRLEN || 300))}`); }
  finally { if (h) await h.close().catch(() => {}); }
}
function helpers(h) {
  const p = h.page;
  const H = {
    go: async (r) => { await p.evaluate((x) => { location.hash = x; }, r); await p.waitForTimeout(450); },
    role: async (r) => { await p.selectOption('#role-select', r); await p.waitForTimeout(200); },
    tab: async (label) => { await p.click(`.page .tabs [role=tab]:has-text("${label}")`); await p.waitForTimeout(300); },
    changes: () => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/v1') || '{}').changes || []),
    incidents: () => p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/v1') || '{}').incidents || []),
    toasts: () => p.$$eval('.toast', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' '))),
    dismiss: async () => { for (const b of await p.$$('.toast button[aria-label="알림 닫기"]')) await b.click().catch(() => {}); await p.waitForTimeout(80); },
    text: async (sel) => clean(await p.locator(sel).first().innerText()),
    fresh: (cs) => cs.filter((c) => !String(c.id).startsWith('seed')),
    apRows: '.adpilot-page .card:has(.seg[aria-label="조치 필터"]) table.tbl tbody tr',
    apFilter: async (label) => { await p.locator('.seg[aria-label="조치 필터"] button', { hasText: label }).first().click(); await p.waitForTimeout(150); },
    apRow: (kw) => p.locator('.adpilot-page table.tbl tbody tr', { hasText: kw }).first(),
    btn: (loc, name) => loc.getByRole('button', { name, exact: true }),
    clip: () => p.evaluate(() => navigator.clipboard.readText()),
    setNum: async (sel, v) => { await p.fill(sel, String(v)); await p.waitForTimeout(80); },
    act: async (loc, kind = 'click') => { await p.waitForTimeout(650); await loc[kind](); },
    closeDrawer: async () => { const b = p.locator('.drawer button[aria-label="닫기"]'); if (await b.count()) { await p.waitForTimeout(650); await b.first().click(); await p.waitForTimeout(120); } },
  };
  return H;
}

(async () => {
  /* ---------------- AD Pilot: 조정 후보 · 승인 요청 · 필터 · 일괄 ---------------- */
  await area('adpilot-proposals', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await check('proposals: filter segments change rows', async () => {
      const segs = await p.$$eval('.seg[aria-label="조치 필터"] button', (b) => b.map((x) => x.innerText.replace(/\s+/g, ' ')));
      expect(segs.length === 6, `segments ${segs}`);
      for (const s of segs) {
        await H.apFilter(s);
        const n = Number(s.match(/(\d+)$/)?.[1]);
        const rows = await p.locator(H.apRows).count();
        const empty = await p.locator(H.apRows, { hasText: '해당 조건의 조정 후보가 없습니다' }).count();
        expect(n === 0 ? empty === 1 : rows === n, `${s} → rows ${rows}`);
      }
      await H.apFilter('전체');
    });
    await check('proposals: rule cards toggle the filter', async () => {
      const cards = p.locator('.adpilot-rule');
      expect(await cards.count() >= 5, 'rule cards missing');
      await cards.nth(0).click(); await p.waitForTimeout(150);
      const pressed = await p.$eval('.seg[aria-label="조치 필터"] button[aria-pressed=true]', (b) => b.innerText);
      expect(/상향/.test(pressed), `pressed ${pressed}`);
      await cards.nth(0).click(); await p.waitForTimeout(150);
      expect(/전체/.test(await p.$eval('.seg[aria-label="조치 필터"] button[aria-pressed=true]', (b) => b.innerText)), 'toggle back failed');
    });
    await check('E2E(c): held media (Kakao tracking break, Meta spike) have no 승인 요청 button', async () => {
      await H.apFilter('보류');
      for (const t of ['카카오 · 캠페인', 'Meta · 캠페인', '매트리스 추천']) {
        const r = p.locator(H.apRows, { hasText: t }).first();
        expect(await r.count() === 1, `${t} hold row missing`);
        const txt = clean(await r.innerText());
        expect(/자동 조정 보류/.test(txt), `${t} not hold: ${txt.slice(0, 80)}`);
        expect(await r.locator('button', { hasText: /승인 요청|재요청/ }).count() === 0, `${t} has request button`);
        expect(await r.locator('input[type=checkbox]').isDisabled(), `${t} checkbox selectable`);
      }
      await H.apFilter('전체');
      const all = await p.$$eval(H.apRows, (trs) => trs.map((tr) => tr.innerText));
      expect(!all.some((t) => /(카카오|Meta)/.test(t) && /(입찰 상향|예산 조정)/.test(t)), 'Kakao/Meta increase proposal present');
    });
    await check('proposals: bid_up 승인 요청 → pending, approver PM (18.4%), toast 바로 가기 → #flow', async () => {
      const row = H.apRow('허리 아플때 매트리스');
      await H.act(row.locator('button:has-text("승인 요청")'), 'dblclick'); await p.waitForTimeout(250);
      const cs = H.fresh(await H.changes()).filter((c) => c.target.includes('허리 아플때'));
      expect(cs.length === 1, `created ${cs.length}`);
      expect(cs[0].kind === 'bid' && cs[0].before === 980 && cs[0].after === 1160 && cs[0].approver === 'PM' && cs[0].status === 'pending', JSON.stringify(cs[0]).slice(0, 200));
      const t = (await H.toasts()).find((x) => x.includes('승인 요청을 만들었습니다'));
      expect(t && /승인 주체 PM/.test(t), `toast ${t}`);
      await p.locator('.toast', { hasText: '승인 요청을 만들었습니다' }).locator('button:has-text("바로 가기")').click(); await p.waitForTimeout(400);
      expect(await p.evaluate(() => location.hash) === '#flow', 'not navigated to flow');
      await H.go('adpilot');
    });
    await check('proposals: brand defense 승인 요청 → approver PM even at +4.5%', async () => {
      await H.act(H.apRow('밀도매트리스 후기').locator('button:has-text("승인 요청")'), 'click'); await p.waitForTimeout(200);
      const c = H.fresh(await H.changes()).find((x) => x.target.includes('밀도매트리스 후기'));
      expect(c && c.approver === 'PM' && c.kind === 'bid' && Math.abs(c.changePct) < 10, JSON.stringify(c).slice(0, 200));
    });
    await check('proposals: budget_shift (SA_일반 제품 +5.1%) 승인 요청 → approver AE, kind budget', async () => {
      await H.apFilter('조기 소진');
      await H.act(p.locator(H.apRows, { hasText: 'SA_일반 제품' }).filter({ hasText: '예산 조정' }).first().locator('button:has-text("승인 요청")'), 'click'); await p.waitForTimeout(200);
      const c = H.fresh(await H.changes()).find((x) => x.target.includes('SA_일반 제품') && x.kind === 'budget');
      expect(c && c.approver === 'AE' && c.status === 'pending' && c.after > c.before, JSON.stringify(c).slice(0, 200));
      await H.apFilter('전체');
    });
    await check('proposals: approve/reject permission per role (AE cannot approve PM item, reason shown)', async () => {
      await H.dismiss();
      await H.role('담당 AE');
      const row = H.apRow('허리 아플때 매트리스');
      expect(await H.btn(row, '승인').isDisabled(), 'AE approve enabled');
      expect(/권한 없음/.test(await row.innerText()), 'no reason text');
      await H.role('PM');
      expect(!(await H.btn(row, '승인').isDisabled()), 'PM approve disabled');
    });
    await check('proposals: PM approve → AE cannot 반영 (Flow role rule) → PM 반영 → AE cannot 롤백', async () => {
      const row = H.apRow('허리 아플때 매트리스');
      await p.waitForTimeout(700);
      await H.act(H.btn(row, '승인'), 'dblclick'); await p.waitForTimeout(200);
      await H.closeDrawer();
      let c = H.fresh(await H.changes()).find((x) => x.target.includes('허리 아플때'));
      expect(c.status === 'approved' && c.history.filter((x) => x.action === '승인').length === 1, `status ${c.status}`);
      await H.role('담당 AE');
      expect(await H.btn(row, '반영').isDisabled(), 'AE apply enabled');
      await H.role('PM');
      await p.waitForTimeout(700);
      await H.act(H.btn(row, '반영'), 'click'); await p.waitForTimeout(250);
      c = H.fresh(await H.changes()).find((x) => x.target.includes('허리 아플때'));
      expect(c.status === 'applied', `status ${c.status}`);
      const t = (await H.toasts()).find((x) => x.includes('반영했습니다'));
      expect(t && /980원 → 1,160원/.test(t), `toast ${t}`);
      await H.role('담당 AE');
      expect(await H.btn(row, '롤백').isDisabled(), 'AE rollback enabled');
      await H.role('PM');
    });
    await check('diagnosis after apply: no sub-5% re-proposal (capped)', async () => {
      await H.tab('키워드 진단');
      await p.fill('#adpilot-kw-q', '허리 아플때'); await p.waitForTimeout(200);
      const t = clean(await p.locator('.adpilot-page table.tbl tbody tr', { hasText: '허리 아플때' }).first().innerText());
      expect(/상한 도달/.test(t) && /최소 조정 폭/.test(t) && !/1,160원 → 1,170원/.test(t), t.slice(0, 200));
      await H.tab('조정 후보');
    });
    await check('proposals: reject → status rejected → 재요청 available', async () => {
      const row = H.apRow('퀸 매트리스');
      await H.act(row.locator('button:has-text("승인 요청")'), 'click'); await p.waitForTimeout(800);
      await H.act(H.btn(row, '반려'), 'click'); await p.waitForTimeout(150);
      const c = H.fresh(await H.changes()).find((x) => x.target.includes('퀸 매트리스'));
      expect(c.status === 'rejected', c.status);
      expect(await row.locator('button', { hasText: '재요청' }).count() === 1, 'no 재요청');
    });
    await check('proposals: 알림 발송 on hold row without incident → MILDO Alert incident', async () => {
      // hold rows are linked to seeded Alert incidents; resolve-free path: notify exists only if no linked incident
      const rows = await p.$$eval(H.apRows, (trs) => trs.filter((tr) => /자동 조정 보류/.test(tr.innerText)).map((tr) => [...tr.querySelectorAll('.adpilot-row-actions a, .adpilot-row-actions button')].map((b) => b.innerText).join('/')));
      expect(rows.length === 6 && rows.filter((r) => /Alert 이슈 P[12]/.test(r)).length >= 5, JSON.stringify(rows));
    });
    await check('proposals: bulk select-all ≥15 → blocked callout, no requests', async () => {
      await H.apFilter('전체');
      const before = (await H.changes()).length;
      await p.check('input[aria-label="선택 가능한 후보 전체 선택"]'); await p.waitForTimeout(150);
      await p.locator('button', { hasText: '일괄 승인 요청' }).click(); await p.waitForTimeout(200);
      const co = clean(await p.locator('.callout', { hasText: '차단' }).first().innerText());
      expect(/기준 15건 이상 차단/.test(co), co);
      expect((await H.changes()).length === before, 'requests created despite block');
      await p.uncheck('input[aria-label="선택 가능한 후보 전체 선택"]');
    });
    await check('proposals: bulk 테스트 후보 (≥5) → 2-step confirm; 취소 creates nothing; 확정 creates N once', async () => {
      await H.apFilter('테스트 후보');
      await p.check('input[aria-label="선택 가능한 후보 전체 선택"]'); await p.waitForTimeout(150);
      const before = (await H.changes()).length;
      await p.locator('button', { hasText: '일괄 승인 요청' }).click(); await p.waitForTimeout(150);
      const co = p.locator('.callout', { hasText: '한 번 더 확인' });
      expect(await co.count() === 1, 'no confirm callout');
      await co.locator('button', { hasText: '취소' }).click(); await p.waitForTimeout(100);
      expect((await H.changes()).length === before, 'cancel created');
      await p.locator('button', { hasText: '일괄 승인 요청' }).click(); await p.waitForTimeout(150);
      const n = Number((await p.locator('.callout button', { hasText: '건 확정' }).innerText()).match(/\d+/)[0]);
      await p.locator('.callout button', { hasText: '건 확정' }).dblclick(); await p.waitForTimeout(250);
      await H.closeDrawer();
      const after = (await H.changes()).length;
      expect(after - before === n && n >= 5, `created ${after - before} expected ${n}`);
      await H.apFilter('전체');
    });
    await check('proposals: soldout 킹 매트리스 → 일시 중지 요청 (status on→off)', async () => {
      await H.apFilter('보류');
      const r = p.locator(H.apRows, { hasText: '킹 매트리스' }).first();
      await H.act(r.locator('button', { hasText: '일시 중지 요청' })); await p.waitForTimeout(200);
      const c = H.fresh(await H.changes()).find((x) => x.target.includes('킹 매트리스'));
      expect(c && c.kind === 'status' && c.before === 'on' && c.after === 'off' && c.status === 'pending', JSON.stringify(c).slice(0, 160));
      await H.apFilter('전체');
    });
    await check('proposals: bulk 일괄 승인 (AE scope only) → 일괄 반영 with toast n/total', async () => {
      await H.apFilter('테스트 후보');
      await H.role('담당 AE');
      await p.check('input[aria-label="선택 가능한 후보 전체 선택"]'); await p.waitForTimeout(150);
      const ab = p.locator('button', { hasText: '일괄 승인' }).filter({ hasNotText: '요청' }).first();
      const n = Number((await ab.innerText()).match(/(\d+)/)?.[1] || 0);
      const pend = H.fresh(await H.changes()).filter((c) => c.kind === 'keyword_add' && c.status === 'pending');
      expect(n === pend.filter((c) => c.approver === 'AE').length && n < pend.length, `AE bulk count ${n} of ${pend.length}`);
      await ab.click(); await p.waitForTimeout(150);
      await H.act(p.locator('.callout button', { hasText: '건 확정' })); await p.waitForTimeout(250);
      await H.closeDrawer();
      const ap = H.fresh(await H.changes()).filter((c) => c.kind === 'keyword_add' && c.status === 'approved');
      expect(ap.length === n && ap.every((c) => c.approver === 'AE'), `approved ${ap.length}`);
      await p.check('input[aria-label="선택 가능한 후보 전체 선택"]'); await p.waitForTimeout(150);
      const fb = p.locator('button', { hasText: '일괄 반영' }).first();
      await H.act(fb); await p.waitForTimeout(150);
      if (await p.locator('.callout button', { hasText: '건 확정' }).count()) await H.act(p.locator('.callout button', { hasText: '건 확정' }));
      await p.waitForTimeout(250); await H.closeDrawer();
      const appl = H.fresh(await H.changes()).filter((c) => c.kind === 'keyword_add' && c.status === 'applied');
      expect(appl.length === n, `applied ${appl.length}/${n}`);
      expect((await H.toasts()).some((t) => /일괄 반영/.test(t)), 'no bulk apply toast');
      await H.role('PM'); await H.apFilter('전체');
    });
    await check('proposals: row click opens drawer with basis + approver', async () => {
      await p.locator(H.apRows, { hasText: '신혼 매트리스' }).first().locator('td').nth(2).click(); await p.waitForTimeout(200);
      const d = clean(await p.locator('.drawer').innerText());
      expect(/판정 근거/.test(d) && /승인 주체/.test(d) && /신혼 매트리스/.test(d), d.slice(0, 120));
      await p.locator('.drawer button[aria-label="닫기"]').click(); await p.waitForTimeout(100);
    });
    await check('proposals: no AI call without click', async () => expect((await h.calls()).length === 0, 'calls made'));
  });

  /* ---------------- AD Pilot: SAFETY 패널 · 민감도 ---------------- */
  await area('adpilot-safety', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    const val = (k) => p.inputValue(`#adpilot-cfg-${k}`);
    const counts = () => p.$eval('.seg[aria-label="조치 필터"]', (s) => s.innerText.replace(/\s+/g, ' '));
    await check('sensitivity: BidDownCard 민감도 → 화면 판정 시뮬레이션 button → 하향 후보 보기 filters; 공식 기준 unchanged', async () => {
      const card = p.locator('.card', { has: p.locator('.card-title', { hasText: '입찰 하향 규칙' }) }).first();
      const sim = card.locator('button', { hasText: '화면 판정 시뮬레이션' });
      expect(await sim.count() === 1, 'no sensitivity button');
      const target = (await sim.innerText()).match(/목표 ([\d,]+)%/)[1].replace(/,/g, '');
      await sim.click(); await p.waitForTimeout(200);
      expect(await val('targetRoas') === target, `draft ${await val('targetRoas')} vs ${target}`);
      expect(/공식 기준 목표 ROAS 400%/.test(clean(await p.locator('.page-head').innerText())), 'official changed');
      await card.locator('button', { hasText: '하향 후보 보기' }).click(); await p.waitForTimeout(150);
      expect(/하향/.test(await p.$eval('.seg[aria-label="조치 필터"] button[aria-pressed=true]', (b) => b.innerText)) && await p.locator(H.apRows).filter({ hasText: '입찰 하향' }).count() >= 1, 'filter not applied');
      await p.locator('.adpilot-safety button', { hasText: '공식 기준으로' }).click(); await p.waitForTimeout(150);
      await H.apFilter('전체');
    });
    await check('safety: typing does not commit; Enter commits; Esc reverts', async () => {
      const c0 = await counts();
      await p.fill('#adpilot-cfg-targetRoas', '1050'); await p.waitForTimeout(100);
      expect(await counts() === c0, 'changed before commit');
      await p.press('#adpilot-cfg-targetRoas', 'Enter'); await p.waitForTimeout(200);
      expect(await val('targetRoas') === '1050' && await counts() !== c0, 'Enter did not commit');
      expect(await p.locator('.adpilot-safety .pill', { hasText: '미승인' }).count() >= 1, 'no 미승인 pill');
      await p.fill('#adpilot-cfg-targetRoas', '777'); await p.press('#adpilot-cfg-targetRoas', 'Escape'); await p.waitForTimeout(100);
      expect(await val('targetRoas') === '1050', 'Esc did not revert');
    });
    await check('sensitivity: target ROAS 1050 → 하향 후보 appears (bid_down, cites 1,050%)', async () => {
      const s = await counts();
      expect(/하향 [1-9]/.test(s), s);
      await H.apFilter('하향');
      const t = clean(await p.locator(H.apRows).first().innerText());
      expect(/입찰 하향/.test(t) && /1,050%/.test(t), t.slice(0, 160));
      await H.apFilter('전체');
    });
    await check('safety: blur commits with bounds clamp (99999 → max, -5 → min, empty/abc ignored)', async () => {
      await p.fill('#adpilot-cfg-brandTargetRoas', '99999'); await p.locator('#adpilot-cfg-targetRoas').focus(); await p.waitForTimeout(150);
      const mx = await val('brandTargetRoas');
      expect(Number(mx) < 99999 && Number(mx) > 800, `max clamp ${mx}`);
      await p.fill('#adpilot-cfg-brandTargetRoas', '-5'); await p.press('#adpilot-cfg-brandTargetRoas', 'Enter'); await p.waitForTimeout(100);
      const mn = Number(await val('brandTargetRoas'));
      expect(mn > 0, `min clamp ${mn}`);
      await p.fill('#adpilot-cfg-brandTargetRoas', ''); await p.press('#adpilot-cfg-brandTargetRoas', 'Enter'); await p.waitForTimeout(100);
      expect(Number(await val('brandTargetRoas')) === mn, 'empty changed value');
    });
    await check('safety: 기준 변경 승인 요청 → setting requests; second click creates no duplicates', async () => {
      const btn = p.locator('.adpilot-safety button', { hasText: '기준 변경 승인 요청' });
      const n = Number((await btn.innerText()).match(/(\d+)건/)[1]);
      await btn.click(); await p.waitForTimeout(200);
      const s1 = (await H.changes()).filter((c) => c.kind === 'setting' && c.module === 'adpilot').length;
      expect(s1 === n, `created ${s1} expected ${n}`);
      const again = p.locator('.adpilot-safety button', { hasText: /기준 변경 승인 요청|승인 요청됨/ }).first();
      if (!(await again.isDisabled())) { await again.click(); await p.waitForTimeout(200); }
      const s2 = (await H.changes()).filter((c) => c.kind === 'setting' && c.module === 'adpilot').length;
      expect(s2 === s1, `duplicates: ${s1} → ${s2}`);
      const tr = (await H.changes()).find((c) => c.targetId === 'adpilot.cfg.targetRoas');
      expect(tr && tr.approver === 'CLIENT' && tr.status === 'pending', JSON.stringify(tr).slice(0, 160));
    });
    await check('safety: 공식 기준으로 resets draft + counts', async () => {
      await p.locator('.adpilot-safety button', { hasText: '공식 기준으로' }).click(); await p.waitForTimeout(200);
      expect(await val('targetRoas') === '400', await val('targetRoas'));
      expect(/하향 0/.test(await counts()), await counts());
    });
    await check('safety: 전체 이력 → history tab', async () => {
      await p.locator('.adpilot-safety button', { hasText: '전체 이력' }).click(); await p.waitForTimeout(250);
      expect(/변경 이력 전체 기록/.test(await H.text('.adpilot-page')), 'not on history');
      await H.tab('조정 후보');
    });
    await check('safety: 반영분 전체 롤백 two-step (취소 keeps, 확정 rolls back in-scope only)', async () => {
      // create + apply two AE-level changes and one PM change
      for (const kw of ['독립스프링 vs 포켓스프링', '아이방 슈퍼싱글']) {
        const r = H.apRow(kw); await H.act(r.locator('button:has-text("승인 요청")'), 'click'); await p.waitForTimeout(750);
        await H.act(H.btn(r, '승인'), 'click'); await p.waitForTimeout(750); await H.act(H.btn(r, '반영'), 'click'); await p.waitForTimeout(150);
      }
      const r = H.apRow('신혼 매트리스'); await H.act(r.locator('button:has-text("승인 요청")'), 'click'); await p.waitForTimeout(750);
      await H.act(H.btn(r, '승인'), 'click'); await p.waitForTimeout(750); await H.act(H.btn(r, '반영'), 'click'); await p.waitForTimeout(150);
      await H.role('담당 AE');
      const rb = p.locator('.adpilot-safety button', { hasText: '반영분 전체 롤백' });
      await rb.click(); await p.waitForTimeout(100);
      const conf = p.locator('.adpilot-safety button', { hasText: '모두 복원 확정' });
      expect(/2건 모두 복원 확정/.test(await conf.innerText()), await conf.innerText());
      await p.locator('.adpilot-safety button', { hasText: '취소' }).click(); await p.waitForTimeout(100);
      expect(H.fresh(await H.changes()).filter((c) => c.status === 'applied').length === 3, 'cancel rolled back');
      // 더블 클릭: 첫 클릭이 확인을 펼치고, 같은 자리 '모두 복원 확정'에 떨어진 두 번째 클릭(detail 2)은 무시되어야 함
      await rb.dblclick(); await p.waitForTimeout(150);
      expect(H.fresh(await H.changes()).filter((c) => c.status === 'rolled_back').length === 0, 'double-click passed the confirm step');
      expect(await conf.count() === 1, 'confirm not armed after double-click');
      await H.act(conf); await p.waitForTimeout(200);
      const cs = H.fresh(await H.changes());
      expect(cs.filter((c) => c.status === 'rolled_back').length === 2 && cs.find((c) => c.target.includes('신혼 매트리스')).status === 'applied', cs.map((c) => `${c.target}:${c.status}`).join(','));
      await H.role('PM');
    });
  });

  /* ---------------- AD Pilot: 키워드 진단 · 신규 후보 · 자동 입찰 검증 · 이력 · 알림 ---------------- */
  await area('adpilot-tabs', { route: 'adpilot', ai: 'artifact', downloads: 'accept' }, async (h, p, H) => {
    const diagRows = '.card:has(.card-title:text("키워드 진단")) table.tbl tbody tr';
    await check('tabs: clicking every AD Pilot tab makes no AI call', async () => {
      for (const t of ['키워드 진단', '신규 후보', '자동 입찰 검증', 'GFA Control', '변경 이력', '조정 후보']) await H.tab(t);
      expect((await h.calls()).length === 0, `calls ${(await h.calls()).length}`);
    });
    await H.tab('키워드 진단');
    await check('diagnosis: verdict filters partition rows; 판정 필터 해제 restores', async () => {
      const all = await p.locator(diagRows).count();
      const vb = await p.$$eval('.card:has(.card-title:text("키워드 진단")) .row > button.btn.sm[aria-pressed]', (b) => b.map((x) => x.innerText.replace(/\s+/g, ' ')));
      let sum = 0;
      for (const v of vb) {
        await p.locator('.card:has(.card-title:text("키워드 진단")) button[aria-pressed]', { hasText: v.split(' ')[0] }).first().click(); await p.waitForTimeout(100);
        const n = await p.locator(diagRows).count();
        expect(n === Number(v.match(/(\d+)$/)[1]), `${v} rows ${n}`); sum += n;
        await p.locator('button', { hasText: '판정 필터 해제' }).click(); await p.waitForTimeout(80);
      }
      expect(sum === all && all > 20, `sum ${sum} all ${all}`);
    });
    await check('diagnosis: intent segment + search + empty state', async () => {
      await p.locator('.seg[aria-label="구매 의도"] button', { hasText: '브랜드' }).click(); await p.waitForTimeout(80);
      const b = await p.locator(diagRows).count();
      expect(b >= 1 && b < 10, `brand rows ${b}`);
      await p.locator('.seg[aria-label="구매 의도"] button', { hasText: '전체' }).click();
      await p.fill('#adpilot-kw-q', '  추천 '); await p.waitForTimeout(100);
      const n = await p.locator(diagRows).count();
      expect(n >= 1 && (await p.$$eval(diagRows, (t) => t.every((x) => x.innerText.includes('추천')))), `search rows ${n}`);
      await p.fill('#adpilot-kw-q', 'zzz없는키워드'); await p.waitForTimeout(100);
      expect(/조건에 맞는 키워드가 없습니다/.test(await p.locator(diagRows).first().innerText()), 'no empty state');
      await p.fill('#adpilot-kw-q', '');
    });
    await check('diagnosis: header sort toggles order', async () => {
      const th = p.locator('.card:has(.card-title:text("키워드 진단")) th', { hasText: 'ROAS 14일' });
      await th.click(); await p.waitForTimeout(100);
      const a = await p.$$eval(diagRows, (t) => t.slice(0, 2).map((x) => x.innerText.slice(0, 20)).join('|'));
      await th.click(); await p.waitForTimeout(100);
      const b = await p.$$eval(diagRows, (t) => t.slice(0, 2).map((x) => x.innerText.slice(0, 20)).join('|'));
      expect(a !== b, 'sort no effect');
    });
    await check('diagnosis: CSV → downloads.save .csv with Korean header', async () => {
      await p.locator('.card:has(.card-title:text("키워드 진단")) button', { hasText: 'CSV' }).click(); await p.waitForTimeout(400);
      const s = (await h.saves()).find((x) => x.filename.endsWith('.csv'));
      expect(s && /^﻿?키워드,구매 의도,판정/.test(s.head) && s.bytes > 1000, JSON.stringify(s).slice(0, 160));
    });
    await check('diagnosis: 검증 button → verify tab with that keyword', async () => {
      await p.locator(diagRows, { hasText: '퀸 매트리스' }).first().locator('button', { hasText: '검증' }).click(); await p.waitForTimeout(250);
      const kw = await p.$eval('#adpilot-verify-kw', (s) => s.options[s.selectedIndex].text);
      expect(/퀸 매트리스/.test(kw), kw);
    });
    const vcard = () => p.locator('.card', { has: p.locator('.card-title', { hasText: 'SAFETY 검증 결과' }) });
    await check('verify: extreme bids blocked (0, -100, 99999999, 10), +10% allowed, non-numeric ignored', async () => {
      const req = vcard().locator('button', { hasText: '승인 요청' });
      for (const v of ['0', '-100', '99999999', '10']) { await p.fill('#adpilot-verify-bid', v); await p.waitForTimeout(100); expect(await req.isDisabled(), `bid ${v} not blocked`); }
      await p.locator('.card', { has: p.locator('.card-title', { hasText: '자동 입찰 검증' }) }).first().locator('button', { hasText: '+10%' }).click(); await p.waitForTimeout(100);
      const b10 = await p.inputValue('#adpilot-verify-bid');
      expect(!(await req.isDisabled()), `+10% (${b10}) blocked`);
      await p.locator('#adpilot-verify-bid').pressSequentially('x').catch(() => {}); await p.waitForTimeout(80);
      expect(await p.inputValue('#adpilot-verify-bid') === b10, 'non-numeric changed value');
      await H.setNum('#adpilot-verify-bid', 1710); await p.waitForTimeout(80); // 1,420원 대비 +20.4% > 상한 20%
      expect(await req.isDisabled(), '+20.4% over daily cap not blocked');
      await H.setNum('#adpilot-verify-bid', 1700); await p.waitForTimeout(80); // +19.7%
      expect(!(await req.isDisabled()), '+19.7% blocked');
    });
    await check('verify: elasticity assumption changes simulated clicks; note + request → pending with route', async () => {
      const eff = async () => clean(await p.locator('.card', { has: p.locator('.card-title', { hasText: '예상 효과' }) }).first().innerText());
      await p.locator('.card', { has: p.locator('.card-title', { hasText: '자동 입찰 검증' }) }).first().locator('button', { hasText: '+10%' }).click(); await p.waitForTimeout(100);
      const e1 = await eff();
      await p.fill('#adpilot-e-click', '1.2'); await p.waitForTimeout(120);
      const e2 = await eff();
      expect(e1 !== e2 && /가정/.test(e2), 'elasticity no effect');
      await p.fill('#adpilot-e-click', '0.6');
      await p.fill('#adpilot-verify-note', 'QA 검증 메모');
      await vcard().locator('button', { hasText: '승인 요청' }).dblclick(); await p.waitForTimeout(250);
      const cs = H.fresh(await H.changes()).filter((c) => c.target.includes('퀸 매트리스'));
      expect(cs.length === 1 && cs[0].approver === 'AE' && /QA 검증 메모/.test(cs[0].reason) && cs[0].status === 'pending', JSON.stringify(cs).slice(0, 200));
      const t = (await H.toasts()).find((x) => x.includes('승인 요청을 만들었습니다'));
      expect(t && /1,420원 → 1,560원/.test(t), `toast ${t}`);
    });
    await check('verify: AD Pilot 제안값 button sets proposed bid', async () => {
      await p.selectOption('#adpilot-verify-kw', { label: (await p.$$eval('#adpilot-verify-kw option', (o) => o.map((x) => x.textContent))).find((x) => x.includes('허리 아플때')) });
      await p.waitForTimeout(150);
      await p.locator('button', { hasText: 'AD Pilot 제안값' }).click(); await p.waitForTimeout(100);
      expect(await p.inputValue('#adpilot-verify-bid') === '1160', await p.inputValue('#adpilot-verify-bid'));
    });
    await H.tab('신규 후보');
    const dc = () => p.locator('.card', { has: p.locator('.card-title', { hasText: '등록 후보' }) });
    await check('discover: register 2 test groups → keyword_add pending; ≥5 needs confirm', async () => {
      const reg = dc().locator('button', { hasText: '등록 요청' });
      expect(await reg.isDisabled(), 'enabled with 0 selected');
      const boxes = dc().locator('tbody input[type=checkbox]:not([disabled])');
      await boxes.nth(0).check(); await boxes.nth(1).check();
      await reg.click(); await p.waitForTimeout(250);
      const n1 = H.fresh(await H.changes()).filter((c) => c.kind === 'keyword_add').length;
      expect(n1 === 2, `created ${n1}`);
      await dc().locator('button', { hasText: '요청 가능 전체 선택' }).click(); await p.waitForTimeout(80);
      await reg.click(); await p.waitForTimeout(150);
      expect(await dc().locator('.callout', { hasText: '한 번 더 확인' }).count() === 1, 'no confirm');
      await dc().locator('.callout button', { hasText: '취소' }).click(); await p.waitForTimeout(80);
      expect(H.fresh(await H.changes()).filter((c) => c.kind === 'keyword_add').length === 2, 'cancel created');
    });
    await check('discover: ≥5 확정 creates the remaining requests once; rows show 승인 대기', async () => {
      const reg = dc().locator('button', { hasText: '등록 요청' });
      await dc().locator('button', { hasText: '요청 가능 전체 선택' }).click(); await p.waitForTimeout(80);
      const n = Number((await reg.innerText()).match(/(\d+)건/)[1]);
      await reg.click(); await p.waitForTimeout(150);
      await H.act(dc().locator('.callout button', { hasText: '건 확정' }), 'dblclick'); await p.waitForTimeout(250);
      const k = H.fresh(await H.changes()).filter((c) => c.kind === 'keyword_add').length;
      expect(k === 2 + n, `keyword_add ${k} expected ${2 + n}`);
      expect(await dc().locator('tbody tr', { hasText: '승인 대기' }).count() >= n, 'rows not pending');
    });
    await H.tab('변경 이력');
    const hc = () => p.locator('.card', { has: p.locator('.card-title', { hasText: '변경 이력 전체 기록' }) });
    await check('history: scope segments filter; 마크다운 복사 → clipboard md table; CSV save', async () => {
      const segs = await hc().locator('.seg button').allInnerTexts();
      expect(segs.length === 3, segs.join());
      await hc().locator('.seg button', { hasText: 'GFA' }).click(); await p.waitForTimeout(80);
      const g = await hc().locator('tbody tr').count();
      await hc().locator('.seg button', { hasText: '전체' }).click(); await p.waitForTimeout(80);
      const a = await hc().locator('tbody tr').count();
      expect(a > g, `all ${a} gfa ${g}`);
      await hc().locator('button', { hasText: '마크다운 복사' }).click(); await p.waitForTimeout(200);
      const clip = await H.clip();
      expect(/^# AD Pilot · GFA Control 변경 이력/.test(clip) && /\| 시각 \| 누가 \|/.test(clip) && /퀸 매트리스/.test(clip), clip.slice(0, 120));
      await hc().locator('button', { hasText: 'CSV' }).click(); await p.waitForTimeout(400);
      const s = (await h.saves()).find((x) => x.filename.startsWith('adpilot-history'));
      expect(s && /^﻿?at,by,action,target/.test(s.head), JSON.stringify(s).slice(0, 160));
    });
    await check('notify: 알림 발송 (when no open Alert issue) → MILDO Alert incident + toast; 2nd click links existing', async () => {
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('mildo-os/v1')); s.incidents = s.incidents.map((i) => ({ ...i, status: 'resolved' })); localStorage.setItem('mildo-os/v1', JSON.stringify(s)); });
      await h.reload(); await H.dismiss();
      await H.apFilter('보류');
      const r = p.locator(H.apRows, { hasText: '카카오 · 캠페인' }).first();
      const before = (await H.incidents()).length;
      await r.locator('button', { hasText: '알림 발송' }).click(); await p.waitForTimeout(250);
      const inc = await H.incidents();
      expect(inc.length === before + 1 && inc[0].severity === 'P1' && inc[0].status === 'open', `incidents ${before}→${inc.length}`);
      const t = (await H.toasts()).find((x) => /P1/.test(x));
      expect(t, 'no toast');
      expect(/Alert 이슈 P1/.test(await r.innerText()), 'row not linked to incident');
    });
    await check('adpilot-tabs: AI calls only via explicit click (none so far)', async () => expect((await h.calls()).length === 0, 'calls'));
  });

  /* ---------------- AD Pilot: GFA Control v1 ---------------- */
  await area('adpilot-gfa', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await H.tab('GFA Control');
    const st = () => p.evaluate(() => {
      const f = document.querySelector('#adpilot-gfa-form');
      const btn = [...f.querySelectorAll('button')].find((b) => b.textContent.includes('승인 요청 →'));
      return { btn: btn?.textContent, dis: btn?.disabled, callouts: [...f.querySelectorAll('.callout')].map((c) => c.textContent).join(' | '), hl: document.querySelector('.adpilot-route-row')?.textContent };
    });
    await check('gfa: routing table shows 3 delegation rows and highlights by %', async () => {
      const t = clean(await p.locator('.adpilot-page').innerText());
      expect(/±10% 이내/.test(t) && /±10~30%/.test(t) && /30% 초과/.test(t), 'delegation rows missing');
      for (const [v, who] of [['5', '담당 AE'], ['10', '담당 AE'], ['10.5', 'PM'], ['30', 'PM'], ['31', '수면밀도'], ['-10', '담당 AE'], ['-30', 'PM']]) {
        await H.setNum('#adpilot-gfa-pct', v);
        const s = await st();
        expect(s.btn.includes(who), `${v}% → ${s.btn}`);
      }
    });
    await check('gfa: validation (0, ≤-100, >100, rounds-to-0) blocks; low-balance warning on increase', async () => {
      for (const v of ['0', '-100', '101', '-99.9']) { await H.setNum('#adpilot-gfa-pct', v); const s = await st(); expect(s.dis && /요청 불가/.test(s.callouts), `${v}% not blocked: ${s.callouts.slice(0, 80)}`); }
      await H.setNum('#adpilot-gfa-pct', '5');
      const s = await st();
      expect(!s.dis && /잔액 0\.91일치/.test(s.callouts) && /실행 보류/.test(s.callouts), s.callouts.slice(0, 120));
      await H.setNum('#adpilot-gfa-pct', '-10');
      expect(!/잔액/.test((await st()).callouts), 'low-balance warning on decrease');
    });
    await check('gfa: quick % buttons set value; role permission line updates', async () => {
      await p.locator('#adpilot-gfa-form button', { hasText: '+35%' }).click(); await p.waitForTimeout(80);
      expect(await p.inputValue('#adpilot-gfa-pct') === '35' && (await st()).btn.includes('수면밀도'), 'quick +35%');
      await H.role('담당 AE');
      const t1 = clean(await p.locator('#adpilot-gfa-form').innerText());
      expect(/현재 역할 담당 AE: 수면밀도 승인 범위 건입니다/.test(t1), t1.match(/현재 역할[^|]{0,80}/)?.[0]);
      await H.role('수면밀도');
      expect(/현재 역할 수면밀도: 이 건을 직접 승인할 수 있습니다/.test(clean(await p.locator('#adpilot-gfa-form').innerText())), 'CLIENT perm text');
      await H.role('PM');
    });
    await check('gfa: budget +5% request → AE pending; approve → 실행 held (low balance) with reason', async () => {
      await p.locator('#adpilot-gfa-form button', { hasText: '+5%' }).click();
      await p.fill('#adpilot-gfa-reason', 'QA 증액 테스트');
      await p.locator('#adpilot-gfa-form button', { hasText: '승인 요청 →' }).dblclick(); await p.waitForTimeout(250);
      let cs = H.fresh(await H.changes()).filter((c) => c.module === 'gfa');
      expect(cs.length === 1 && cs[0].approver === 'AE' && cs[0].before === 1200000 && cs[0].after === 1260000, JSON.stringify(cs).slice(0, 200));
      const t = (await H.toasts()).find((x) => x.includes('승인 요청을 만들었습니다'));
      expect(t && /120만 → 126만/.test(t), `toast raw numbers: ${t}`);
      const q = p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'QA 증액' }).first();
      await p.waitForTimeout(700);
      await H.act(H.btn(q, '승인'), 'click'); await p.waitForTimeout(750);
      await H.act(H.btn(p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'GFA_Prospecting 일 예산' }).filter({ has: p.getByRole('button', { name: '실행', exact: true }) }), '실행'), 'click'); await p.waitForTimeout(300);
      cs = H.fresh(await H.changes()).filter((c) => c.module === 'gfa');
      expect(cs[0].status === 'held' && /잔액/.test(cs[0].history.slice(-1)[0].note), `${cs[0].status}`);
    });
    await check('gfa: held → 재실행 still held (toast) ; 실행 취소 → rejected', async () => {
      const row = p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'GFA_Prospecting 일 예산' }).filter({ has: p.getByRole('button', { name: '재실행' }) }).first();
      await p.waitForTimeout(700);
      await H.act(row.getByRole('button', { name: '재실행' }), 'click'); await p.waitForTimeout(250);
      expect((await H.toasts()).some((x) => x.includes('여전히 실행할 수 없습니다')), 'no still-held toast');
      expect(H.fresh(await H.changes()).find((c) => c.module === 'gfa').status === 'held', 'not held');
    });
    await check('gfa: held → 실행 취소 → rejected with history (role in scope)', async () => {
      const row = p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'GFA_Prospecting 일 예산' }).filter({ has: p.getByRole('button', { name: '실행 취소' }) }).first();
      await H.act(row.getByRole('button', { name: '실행 취소' })); await p.waitForTimeout(250);
      const c = H.fresh(await H.changes()).find((x) => x.module === 'gfa');
      expect(c.status === 'rejected' && c.history.slice(-1)[0].action === '실행 취소', `${c.status}`);
      expect((await H.toasts()).some((t) => /실행을 취소했습니다/.test(t)), 'no cancel toast');
    });
    await check('gfa: adgroup ON/OFF (PM) — none selected / same status blocked; request ok', async () => {
      await p.locator('#adpilot-gfa-form .seg[aria-label="변경 유형"] button', { hasText: '광고그룹' }).click(); await p.waitForTimeout(80);
      let s = await st(); expect(s.dis && /광고그룹을 선택하세요/.test(s.callouts), 'no adgroup error');
      const ags = await p.$$eval('#adpilot-gfa-ag option', (o) => o.map((x) => [x.value, x.textContent]));
      await p.selectOption('#adpilot-gfa-ag', ags[1][0]); await p.waitForTimeout(80);
      const cur = ags[1][1].includes('(ON') ? 'ON' : 'OFF';
      await p.locator('#adpilot-gfa-form .seg[aria-label="변경 후 상태"] button', { hasText: cur }).click(); await p.waitForTimeout(80);
      s = await st(); expect(s.dis && /이미/.test(s.callouts), 'same status allowed');
      await p.locator('#adpilot-gfa-form .seg[aria-label="변경 후 상태"] button', { hasText: cur === 'ON' ? 'OFF' : 'ON' }).click(); await p.waitForTimeout(80);
      s = await st(); expect(!s.dis && s.btn.includes('PM'), s.btn);
      await p.locator('#adpilot-gfa-form button', { hasText: '승인 요청 →' }).click(); await p.waitForTimeout(200);
      expect(H.fresh(await H.changes()).some((c) => c.module === 'gfa' && c.kind === 'status' && c.approver === 'PM'), 'no status request');
    });
    await check('gfa: new campaign — empty/dup/negative blocked; valid → CLIENT approver', async () => {
      await p.locator('#adpilot-gfa-form .seg[aria-label="변경 유형"] button', { hasText: '신규' }).click(); await p.waitForTimeout(80);
      let s = await st(); expect(s.dis && /캠페인 이름을 입력하세요/.test(s.callouts), 'empty allowed');
      await p.fill('#adpilot-gfa-name', 'GFA_Prospecting'); await H.setNum('#adpilot-gfa-nb', 500000);
      s = await st(); expect(s.dis && /같은 이름/.test(s.callouts), 'dup allowed');
      await p.fill('#adpilot-gfa-name', 'GFA_QA 신규'); await H.setNum('#adpilot-gfa-nb', -5);
      s = await st(); expect(s.dis && /일 예산을 입력하세요/.test(s.callouts), 'negative allowed');
      await H.setNum('#adpilot-gfa-nb', 500000);
      s = await st(); expect(!s.dis && s.btn.includes('수면밀도'), s.btn);
      await p.locator('#adpilot-gfa-form button', { hasText: '승인 요청 →' }).click(); await p.waitForTimeout(200);
      const c = H.fresh(await H.changes()).find((x) => x.module === 'gfa' && x.kind === 'gfa');
      expect(c && c.approver === 'CLIENT' && c.after === 500000, JSON.stringify(c).slice(0, 160));
    });
    await check('gfa: campaign row 변경 요청 prefills the form (early-exhaust campaign)', async () => {
      await p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'GFA_쇼핑 고객 확장' }).first().locator('button', { hasText: '변경 요청' }).click(); await p.waitForTimeout(200);
      expect(await p.inputValue('#adpilot-gfa-pct') !== '' && /쇼핑 고객 확장/.test(await p.$eval('#adpilot-gfa-cmp', (s) => s.options[s.selectedIndex].text)), 'not prefilled');
    });
  });

  /* ---------------- MILDO Flow: 보드 · 역할 · 상세 액션 · 일괄 ---------------- */
  await area('flow-board', { route: 'flow', ai: 'none' }, async (h, p, H) => {
    const queue = () => p.$$eval('.flow-queue-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
    const dbtn = (name) => p.locator('.drawer').getByRole('button', { name, exact: true });
    const st = async (id) => (await H.changes()).find((c) => c.id === id);
    const openCard = async (t) => { await p.locator('.flow-card', { hasText: t }).first().click(); await p.waitForTimeout(200); };
    await check('flow: 내가 처리할 것 per role (AE 3 ⊂ PM 5 ⊂ 수면밀도 6, CLIENT 충전 only for 수면밀도)', async () => {
      const n = {};
      for (const r of ['담당 AE', 'PM', '수면밀도']) { await H.role(r); n[r] = await queue(); }
      expect(n['담당 AE'].length === 3 && n.PM.length === 5 && n['수면밀도'].length === 6, JSON.stringify(Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.length]))));
      expect(!n.PM.some((x) => x.includes('충전')) && n['수면밀도'].some((x) => x.includes('충전')), 'CLIENT item scope wrong');
      expect(!n['담당 AE'].some((x) => x.includes('SA_일반 제품 일 예산')), 'AE sees PM item');
      await H.role('PM');
    });
    await check('flow: View 역할 segment syncs with top-bar role', async () => {
      await p.locator('.seg[aria-label="현재 역할"] button', { hasText: '수면밀도' }).click(); await p.waitForTimeout(150);
      expect(await p.inputValue('#role-select') === '수면밀도', 'topbar not synced');
      await H.role('PM');
      expect(/PM/.test(await p.$eval('.seg[aria-label="현재 역할"] button[aria-pressed=true]', (b) => b.innerText)), 'segment not synced');
    });
    await check('flow: board columns = 6 statuses, counts sum to total', async () => {
      const cols = await p.$$eval('.flow-col', (c) => c.map((x) => [x.getAttribute('aria-label'), x.querySelectorAll('.flow-card').length]));
      const total = (await H.changes()).length;
      expect(cols.length === 6 && cols.reduce((a, c) => a + c[1], 0) === total, JSON.stringify(cols) + ' total ' + total);
    });
    await check('flow: out-of-scope drawer buttons disabled with reason (AE on PM item)', async () => {
      await H.role('담당 AE');
      await openCard('SA_일반 제품 일 예산');
      expect(await dbtn('승인').isDisabled() && /PM 승인 건 · 현재 역할 담당 AE/.test(await p.locator('.drawer').innerText()), 'AE can approve PM item');
      await H.closeDrawer(); await H.role('PM');
    });
    await check('flow: drawer reject needs note + two-step; dblclick does not pass the 2nd step', async () => {
      await openCard('Meta_넓은 타겟 시간대 입찰 상한');
      const id = (await H.changes()).find((c) => c.target.includes('Meta_넓은 타겟 시간대')).id;
      expect(await dbtn('반려').isDisabled(), 'reject enabled without note');
      await p.fill('#flow-note', '   ');
      expect(await dbtn('반려').isDisabled(), 'whitespace note accepted');
      await p.fill('#flow-note', 'QA 반려 사유');
      await dbtn('반려').dblclick(); await p.waitForTimeout(200);
      expect((await st(id)).status === 'pending', 'dblclick passed two-step');
      await H.act(p.locator('.drawer button', { hasText: '확인 · 반려' })); await p.waitForTimeout(200);
      const c = await st(id);
      expect(c.status === 'rejected' && c.history.slice(-1)[0].note === 'QA 반려 사유' && c.history.slice(-1)[0].by === 'PM', JSON.stringify(c.history.slice(-1)));
      expect(/종료된 요청입니다/.test(await p.locator('.drawer').innerText()), 'closed text missing');
      await H.closeDrawer();
    });
    await check('flow: hold (note) → held → resume → pending → approve → apply → rollback (2-step) on SA_일반 제품', async () => {
      await openCard('SA_일반 제품 일 예산');
      const id = 'seed_flow_7';
      await p.fill('#flow-note', 'QA 보류'); await H.act(dbtn('보류')); await p.waitForTimeout(150);
      expect((await st(id)).status === 'held', 'not held');
      await H.act(dbtn('보류 해제')); await p.waitForTimeout(150);
      expect((await st(id)).status === 'pending', 'resume not back to pending');
      await H.act(dbtn('승인')); await p.waitForTimeout(150);
      expect((await st(id)).status === 'approved', 'not approved');
      expect(/반영 전 실행 점검 통과/.test(await p.locator('.drawer').innerText()), 'no exec check');
      await H.act(dbtn('반영')); await p.waitForTimeout(150);
      expect((await st(id)).status === 'applied', 'not applied');
      await H.act(dbtn('롤백')); await p.waitForTimeout(100);
      await H.act(p.locator('.drawer button', { hasText: '확인 · 롤백' })); await p.waitForTimeout(200);
      const c = await st(id);
      expect(c.status === 'rolled_back' && /직전 상태로 복원/.test(c.history.slice(-1)[0].note), c.status);
      expect((await H.toasts()).some((t) => /롤백했습니다/.test(t) && /원로 복원/.test(t)), 'no rollback toast');
      await H.closeDrawer();
    });
    await check('flow: held Kakao budget → resume → approved → apply re-held by tracking-break check', async () => {
      await openCard('카카오_프로모션 일 예산');
      await H.act(dbtn('보류 해제')); await p.waitForTimeout(150);
      expect((await st('seed_flow_6')).status === 'approved', (await st('seed_flow_6')).status);
      expect(/반영 시 실행 보류 예상/.test(await p.locator('.drawer').innerText()), 'no hold forecast');
      await H.act(dbtn('반영')); await p.waitForTimeout(200);
      const c = await st('seed_flow_6');
      expect(c.status === 'held' && /전환 추적 단절/.test(c.history.slice(-1)[0].note), `${c.status}`);
      await H.closeDrawer();
    });
    await check('flow: approved → 실행 취소 needs note + 2-step → rejected', async () => {
      await openCard('기획전 종료 시각 소재 교체');
      await p.fill('#flow-note', 'QA 실행 취소');
      await H.act(dbtn('실행 취소')); await p.waitForTimeout(100);
      await H.act(p.locator('.drawer button', { hasText: '확인 · 실행 취소' })); await p.waitForTimeout(200);
      expect((await st('seed_flow_5')).status === 'rejected', (await st('seed_flow_5')).status);
      await H.closeDrawer();
    });
    await check('flow: queue dblclick 승인 approves exactly one request', async () => {
      await H.role('수면밀도'); await p.waitForTimeout(700);
      const before = (await H.changes()).map((c) => `${c.id}:${c.status}`);
      await p.locator('.flow-queue-row').nth(0).getByRole('button', { name: '승인', exact: true }).dblclick(); await p.waitForTimeout(300);
      const changed = (await H.changes()).map((c) => `${c.id}:${c.status}`).filter((x) => !before.includes(x));
      expect(changed.length === 1, `changed ${changed}`);
      await H.role('PM');
    });
    await check('flow: table view + filters (module/approver/kind/search/scope) + empty state', async () => {
      await p.locator('.seg[aria-label="보기"] button', { hasText: '표' }).click(); await p.waitForTimeout(150);
      const rows = () => p.locator('.card:has(.seg[aria-label="보기"]) table.tbl tbody tr');
      const all = await rows().count();
      expect(all === (await H.changes()).length, `rows ${all}`);
      await p.selectOption('select[aria-label="모듈"]', 'lab'); await p.waitForTimeout(100);
      const lab = await rows().count();
      expect(lab >= 1 && lab < all, `lab ${lab}`);
      await p.selectOption('select[aria-label="승인 주체"]', 'CLIENT'); await p.waitForTimeout(100);
      const t = clean(await rows().first().innerText());
      expect(/조건에 맞는 요청이 없습니다/.test(t) || (await rows().count()) <= lab, t.slice(0, 80));
      await p.selectOption('select[aria-label="모듈"]', 'all'); await p.selectOption('select[aria-label="승인 주체"]', 'all');
      await p.selectOption('select[aria-label="유형"]', 'bid'); await p.waitForTimeout(100);
      expect((await p.$$eval('.card:has(.seg[aria-label="보기"]) table.tbl tbody tr', (r) => r.map((x) => x.innerText))).every((x) => /입찰/.test(x)), 'kind filter');
      await p.selectOption('select[aria-label="유형"]', 'all');
      await p.fill('input[aria-label="검색"]', 'zzz없음'); await p.waitForTimeout(100);
      expect(/조건에 맞는 요청이 없습니다/.test(await rows().first().innerText()), 'no empty state');
      await p.fill('input[aria-label="검색"]', '');
      await p.locator('.seg[aria-label="범위"] button', { hasText: '시연 이력' }).click(); await p.waitForTimeout(100);
      const seeds = await rows().count();
      await p.locator('.seg[aria-label="범위"] button', { hasText: '전체' }).click(); await p.waitForTimeout(100);
      expect(seeds === 10, `seed rows ${seeds}`);
      await p.locator('.seg[aria-label="보기"] button', { hasText: '보드' }).click();
    });
    await check('flow: 신규 요청 button → request tab with empty draft', async () => {
      await p.locator('.card', { has: p.locator('.card-title', { hasText: '내가 처리할 것' }) }).first().locator('button', { hasText: '신규 요청' }).click(); await p.waitForTimeout(200);
      expect(/신규 요청/.test(await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText)) && await p.inputValue('#flow-reason') === '', 'not request tab');
      await H.tab('요청 · 승인');
    });
    await check('flow: hero items switch tabs', async () => {
      const items = p.locator('.flow-hero-item');
      expect(await items.count() === 6, 'hero count');
      await items.nth(4).click(); await p.waitForTimeout(150);
      expect(/프로모션 점검/.test(await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText)), 'promo tab');
      await items.nth(5).click(); await p.waitForTimeout(150);
      expect(/운영 타임라인/.test(await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText)), 'timeline tab');
      await items.nth(0).click(); await p.waitForTimeout(150);
      expect(/요청 · 승인 · 반영/.test(await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText)), 'board tab');
    });
    await check('flow: module tag link in card navigates to source module', async () => {
      await openCard('밀도 매트리스 경도');
      await p.locator('.drawer a', { hasText: 'MILDO Lab' }).first().click(); await p.waitForTimeout(400);
      expect(await p.evaluate(() => location.hash) === '#lab', await p.evaluate(() => location.hash));
      await H.go('flow');
    });
  });

  /* ---------------- MILDO Flow: 일괄 승인 가드 ---------------- */
  await area('flow-bulk', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await check('bulk: 12 AE test requests → Flow 수면밀도 16 blocked (≥15), PM 15 blocked, AE 12 warn 2-step → 12/12', async () => {
      await H.apFilter('테스트 후보');
      await p.check('input[aria-label="선택 가능한 후보 전체 선택"]');
      await p.locator('button', { hasText: '일괄 승인 요청' }).click(); await p.waitForTimeout(150);
      await H.act(p.locator('.callout button', { hasText: '건 확정' })); await p.waitForTimeout(250);
      await H.go('flow');
      const card = p.locator('.card', { has: p.locator('.card-title', { hasText: '내가 처리할 것' }) }).first();
      const b = () => card.locator('button', { hasText: '일괄 승인' }).first();
      await H.role('수면밀도');
      expect(await b().isDisabled() && /기준 15건 이상 차단/.test(await b().getAttribute('title')), `${await b().innerText()} ${await b().getAttribute('title')}`);
      await H.role('PM');
      expect(await b().isDisabled(), 'PM 15 not blocked');
      await H.role('담당 AE');
      expect(!(await b().isDisabled()) && /5건 이상, 2단계 확인/.test(await b().getAttribute('title')), 'AE warn missing');
      await b().dblclick(); await p.waitForTimeout(200);
      expect(H.fresh(await H.changes()).filter((c) => c.status === 'approved').length === 0, 'dblclick passed two-step');
      await H.act(card.locator('button', { hasText: '확인 · 일괄 승인' })); await p.waitForTimeout(300);
      const ap = (await H.changes()).filter((c) => c.status === 'approved' && c.history.some((x) => x.action === '일괄 승인'));
      expect(ap.length === 12 && ap.every((c) => c.approver === 'AE'), `approved ${ap.length}`);
      expect((await H.toasts()).some((t) => /일괄 승인 12\/12건/.test(t)), 'toast');
    });
    await check('bulk: 10 bid/budget/status requests in 10 min (same requester) → 대량 변경 실수 감지 callout (P1 Alert incident) + related buttons open drawer', async () => {
      await H.role('PM'); await H.go('adpilot');
      await H.apFilter('상향');
      await p.check('input[aria-label="선택 가능한 후보 전체 선택"]'); await p.waitForTimeout(120);
      await p.locator('button', { hasText: '일괄 승인 요청' }).click(); await p.waitForTimeout(150);
      await H.act(p.locator('.callout button', { hasText: '건 확정' })); await p.waitForTimeout(250);
      await H.apFilter('조기 소진');
      await H.act(p.locator(H.apRows, { hasText: 'SA_일반 제품' }).filter({ hasText: '예산 조정' }).first().locator('button:has-text("승인 요청")'));
      await H.apFilter('보류');
      await H.act(p.locator(H.apRows, { hasText: '킹 매트리스' }).first().locator('button', { hasText: '일시 중지 요청' })); await p.waitForTimeout(300);
      expect(H.fresh(await H.changes()).filter((c) => ['bid', 'budget', 'status'].includes(c.kind)).length === 10, 'setup count');
      await H.go('flow');
      const co = p.locator('.callout', { hasText: '대량 변경 실수 감지' }).first();
      expect(await co.count() === 1, 'no bulk callout');
      expect((await H.incidents()).some((i) => i.ruleId === 'bulk_change'), 'no Alert bulk incident');
      await co.locator('button').first().click(); await p.waitForTimeout(250);
      expect(await p.locator('.drawer').count() === 1 && /대량 변경 실수 감지 대상/.test(await p.locator('.drawer').innerText()), 'drawer/bulk hit missing');
      await H.closeDrawer();
    });
  });

  /* ---------------- MILDO Flow: 신규 요청 폼 ---------------- */
  await area('flow-request', { route: 'flow', ai: 'none' }, async (h, p, H) => {
    await H.tab('신규 요청');
    const errs = async () => clean(await p.locator('.callout', { hasText: '제출 불가' }).first().innerText().catch(() => ''));
    const submit = () => p.locator('button', { hasText: '승인 요청 생성 (pending)' });
    const approver = async () => clean(await p.locator('.flow-big-approver').innerText());
    await check('request: empty form → errors (사유 8자, 캠페인) and submit disabled', async () => {
      const e = await errs();
      expect(/8자/.test(e) && /캠페인을 선택/.test(e) && await submit().isDisabled(), e.slice(0, 160));
    });
    await check('request: budget routing by % (5 AE, 20 PM, 35 수면밀도) + bounds (-99.9, 101 blocked)', async () => {
      await p.selectOption('#flow-media', 'naver_sa');
      const opt = (await p.$$eval('#flow-target option', (o) => o.map((x) => [x.value, x.textContent]))).find((x) => x[1].includes('SA_일반 제품'));
      await p.selectOption('#flow-target', opt[0]);
      await p.fill('#flow-reason', 'QA 피크 시간대 전 소진 방지 증액');
      for (const [v, who] of [['5', '담당 AE'], ['20', 'PM'], ['35', '수면밀도'], ['-10', '담당 AE']]) { await H.setNum('#flow-pct', v); expect((await approver()).includes(who), `${v}% → ${await approver()}`); }
      for (const v of ['-99.9', '101', '0']) { await H.setNum('#flow-pct', v); expect(await submit().isDisabled() && (await errs()).length > 0, `${v}% not blocked`); }
      await H.setNum('#flow-pct', '20');
      expect(!(await submit().isDisabled()), 'valid blocked');
      expect(/증액 후 예상/.test(clean(await p.locator('.callout', { hasText: '확인 필요' }).first().innerText().catch(() => ''))), 'no pacing preview');
    });
    await check('request: submit (dblclick) → 1 pending request, switches to board with its drawer open', async () => {
      const before = (await H.changes()).length;
      await submit().dblclick(); await p.waitForTimeout(300);
      const cs = H.fresh(await H.changes());
      expect((await H.changes()).length === before + 1, `created ${(await H.changes()).length - before}`);
      const c = cs.find((x) => x.target.includes('SA_일반 제품 일 예산'));
      expect(c && c.approver === 'PM' && c.status === 'pending' && c.module === 'adpilot' && c.requestedBy === 'PM' && c.changePct === 20, JSON.stringify(c).slice(0, 200));
      expect(await p.locator('.drawer').count() === 1 && /SA_일반 제품 일 예산/.test(await p.locator('.drawer').innerText()), 'drawer not open');
      await H.closeDrawer();
      await H.tab('신규 요청');
    });
    await check('request: bid type cap 20% (25 blocked), 10% AE; brand keyword warning', async () => {
      await p.selectOption('#flow-type', 'bid'); await p.waitForTimeout(80);
      const opt = (await p.$$eval('#flow-kw option', (o) => o.map((x) => [x.value, x.textContent]))).find((x) => x[1].includes('퀸 매트리스'));
      await p.selectOption('#flow-kw', opt[0]);
      await p.fill('#flow-reason', 'QA 입찰 상향 검토 요청 사유');
      await H.setNum('#flow-pct', '25');
      expect(/일 조정 폭 상한 20% 초과/.test(await errs()), await errs());
      await H.setNum('#flow-pct', '10');
      expect(!(await submit().isDisabled()) && (await approver()).includes('담당 AE'), await approver());
      const b = (await p.$$eval('#flow-kw option', (o) => o.map((x) => [x.value, x.textContent]))).find((x) => x[1].includes('브랜드'));
      await p.selectOption('#flow-kw', b[0]);
      expect(/브랜드 키워드 별도 기준/.test(clean(await p.locator('.page').innerText())), 'no brand warning');
    });
    await check('request: on/off same-status blocked; new campaign validation; fixed approvers per type', async () => {
      await p.selectOption('#flow-type', 'onoff'); await p.waitForTimeout(80);
      await p.selectOption('#flow-media', 'naver_sa');
      const kw = (await p.$$eval('#flow-target option', (o) => o.map((x) => [x.value, x.textContent]))).find((x) => x[1].includes('키워드 · 퀸 매트리스'));
      await p.selectOption('#flow-target', kw[0]);
      await p.locator('.seg[aria-label="상태"] button', { hasText: 'ON' }).click(); await p.waitForTimeout(80);
      expect(/이미 ON 상태/.test(await errs()), await errs());
      await p.locator('.seg[aria-label="상태"] button', { hasText: 'OFF' }).click(); await p.waitForTimeout(80);
      expect((await approver()).includes('PM') && !(await submit().isDisabled()), 'onoff PM');
      await p.selectOption('#flow-type', 'new_campaign'); await p.waitForTimeout(80);
      await p.selectOption('#flow-media2', ''); await p.waitForTimeout(60);
      expect(/캠페인 이름/.test(await errs()) && /매체를 선택/.test(await errs()), await errs());
      await p.selectOption('#flow-media2', 'naver_gfa'); await p.fill('#flow-name', 'GFA_Prospecting'); await p.fill('#flow-nb', 'abc');
      expect(/같은 이름/.test(await errs()) && /숫자로 입력/.test(await errs()), await errs());
      await p.fill('#flow-name', 'GFA_11월 QA'); await p.fill('#flow-nb', '1000000');
      await p.fill('#flow-reason', 'QA 신규 캠페인 요청 사유입니다');
      expect(!(await submit().isDisabled()) && (await approver()).includes('수면밀도'), await approver());
      for (const [t, who] of [['creative', '담당 AE'], ['keyword', '담당 AE'], ['alert_rule', 'PM'], ['strategy', '수면밀도']]) {
        await p.selectOption('#flow-type', t); await p.waitForTimeout(60);
        expect((await approver()).includes(who), `${t} → ${await approver()}`);
      }
    });
    await check('request: 초기화 clears target/reason', async () => {
      await p.selectOption('#flow-type', 'creative'); await p.fill('#flow-tt', 'QA 소재'); await p.fill('#flow-reason', 'QA 사유 여덟자 이상');
      await p.locator('button', { hasText: '초기화' }).click(); await p.waitForTimeout(80);
      expect(await p.inputValue('#flow-tt') === '' && await p.inputValue('#flow-reason') === '', 'not cleared');
    });
    await check('request: role changes approver-permission pill', async () => {
      await p.selectOption('#flow-type', 'strategy'); await H.role('PM');
      expect(/승인 범위 밖/.test(clean(await p.locator('.card', { hasText: '승인 주체 자동 결정' }).first().innerText())), 'PM pill');
      await H.role('수면밀도');
      expect(/직접 승인 가능/.test(clean(await p.locator('.card', { hasText: '승인 주체 자동 결정' }).first().innerText())), 'CLIENT pill');
      await H.role('PM');
    });
  });

  /* ---------------- MILDO Flow: 프로모션 점검 · 리포트 ---------------- */
  await area('flow-promo', { route: 'flow', ai: 'artifact', downloads: 'accept' }, async (h, p, H) => {
    await H.tab('프로모션 점검');
    await check('promo: promotion cards select checklist; matrix row click selects', async () => {
      const cards = p.locator('.flow-promo');
      expect(await cards.count() >= 3, 'promo cards');
      await cards.nth(1).click(); await p.waitForTimeout(150);
      const t1 = clean(await p.locator('.card-title', { hasText: '체크리스트' }).first().innerText());
      expect(await cards.nth(1).getAttribute('aria-pressed') === 'true', 'not pressed');
      await p.locator('.card:has(.card-title:text("전 프로모션 점검 매트릭스")) tbody tr').nth(0).click(); await p.waitForTimeout(150);
      const t0 = clean(await p.locator('.card-title', { hasText: '체크리스트' }).first().innerText());
      expect(t0 !== t1, `${t0} vs ${t1}`);
    });
    await check('promo: 점검 다시 실행 → toast with fail/warn counts + 마지막 실행', async () => {
      await p.locator('button', { hasText: '점검 다시 실행' }).click(); await p.waitForTimeout(200);
      expect((await H.toasts()).some((t) => /오픈 전 자동 점검 · 실패 \d+ · 주의 \d+/.test(t)), JSON.stringify(await H.toasts()));
      expect(/마지막 실행/.test(await p.locator('.page').innerText()), 'no last-run stamp');
      await H.dismiss();
    });
    await check('promo: one-click fix request → pending with approver, button → 요청됨 → opens drawer', async () => {
      const cards = p.locator('.flow-promo');
      let fixBtn = null;
      for (let i = 0; i < await cards.count() && !fixBtn; i++) {
        await cards.nth(i).click(); await p.waitForTimeout(120);
        const b = p.locator('.flow-check button:has(.muted)').first();
        if (await b.count()) fixBtn = b;
      }
      expect(fixBtn, 'no fix button in any promo');
      const label = clean(await fixBtn.innerText());
      const before = (await H.changes()).length;
      await fixBtn.dblclick(); await p.waitForTimeout(250);
      await H.closeDrawer();
      const cs = await H.changes();
      expect(cs.length === before + 1, `created ${cs.length - before} (${label})`);
      const who = label.split('·').pop().trim();
      const c = cs[0];
      const lab = { AE: '담당 AE', PM: 'PM', CLIENT: '수면밀도' }[c.approver];
      expect(c.status === 'pending' && who.includes(lab.replace(' 승인', '')) && /프로모션/.test(c.reason), `${label} → ${c.approver} ${c.reason.slice(0, 60)}`);
      const done = p.locator('.flow-check button', { hasText: '요청됨' }).first();
      expect(await done.count() === 1, 'no 요청됨 state');
      await done.click(); await p.waitForTimeout(200);
      expect(await p.locator('.drawer').count() === 1, 'drawer not opened');
      await H.closeDrawer();
    });
    await check('promo: 프로모션 리포트 button → report tab of that promotion', async () => {
      const name = clean(await p.locator('.flow-promo[aria-pressed=true] strong').first().innerText());
      await p.locator('button', { hasText: '프로모션 리포트' }).first().click(); await p.waitForTimeout(250);
      expect(/프로모션 리포트/.test(await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText)), 'tab');
      expect(clean(await p.$eval('.seg[aria-label="프로모션"] button[aria-pressed=true]', (b) => b.innerText)).includes(name), 'promo mismatch');
    });
    await check('report: 리포트 복사 → clipboard md with headings; .md 다운로드 → save .md', async () => {
      await p.locator('.seg[aria-label="프로모션"] button').first().click(); await p.waitForTimeout(150);
      await p.locator('button', { hasText: '리포트 복사' }).click(); await p.waitForTimeout(200);
      const md = await H.clip();
      expect(/^#/m.test(md) && /##/.test(md) && md.length > 300, md.slice(0, 120));
      await p.locator('button', { hasText: '.md 다운로드' }).click(); await p.waitForTimeout(400);
      const s = (await h.saves()).find((x) => x.filename.endsWith('.md'));
      expect(s && /^mildo-promo-report-.*\.md$/.test(s.filename) && /^#/.test(s.head), JSON.stringify(s).slice(0, 160));
    });
    await check('report: 다음 기획 반영 요청 → CLIENT pending, then shows 반영 요청됨 (no duplicate)', async () => {
      let btn = p.locator('button', { hasText: '다음 기획 반영 요청' });
      if (!(await btn.count())) { await p.locator('.seg[aria-label="프로모션"] button').nth(1).click(); await p.waitForTimeout(150); btn = p.locator('button', { hasText: '다음 기획 반영 요청' }); }
      expect(await btn.count() === 1, 'no next-plan button');
      const before = (await H.changes()).length;
      await btn.dblclick(); await p.waitForTimeout(250);
      const cs = await H.changes();
      expect(cs.length === before + 1 && cs[0].approver === 'CLIENT' && cs[0].status === 'pending', `${cs.length - before} ${cs[0].approver}`);
      expect(/반영 요청됨 · 승인 대기/.test(await p.locator('.flow-next-card').innerText()), 'state pill');
    });
    await check('report: segment switches promotion (different numbers)', async () => {
      const segs = p.locator('.seg[aria-label="프로모션"] button');
      await segs.nth(0).click(); await p.waitForTimeout(120);
      const a = clean(await p.locator('.flow-next-card').innerText());
      await segs.nth(2).click(); await p.waitForTimeout(120);
      const b = clean(await p.locator('.flow-next-card').innerText());
      expect(a !== b, 'same content');
    });
  });

  /* ---------------- MILDO Flow: 운영 타임라인 · 시스템 ---------------- */
  await area('flow-timeline', { route: 'flow', ai: 'none' }, async (h, p, H) => {
    await H.tab('운영 타임라인');
    await check('timeline: feed stage/source filters change items', async () => {
      const n = () => p.locator('.flow-feed .flow-ev').count();
      const all = await n();
      await p.locator('.seg[aria-label="출처"] button', { hasText: '이슈' }).click(); await p.waitForTimeout(100);
      const inc = await n();
      await p.locator('.seg[aria-label="출처"] button', { hasText: '요청' }).click(); await p.waitForTimeout(100);
      const chg = await n();
      await p.locator('.seg[aria-label="출처"] button', { hasText: '전체' }).click(); await p.waitForTimeout(100);
      expect(all > 0 && inc > 0 && chg > 0 && inc < all && chg < all, `all ${all} inc ${inc} chg ${chg}`);
      const segs = await p.$$eval('.seg[aria-label="단계"] button', (b) => b.map((x) => x.innerText));
      await p.locator('.seg[aria-label="단계"] button', { hasText: segs[1] }).click(); await p.waitForTimeout(100);
      const st = await n();
      expect(st <= all, 'stage filter');
      await p.locator('.seg[aria-label="단계"] button', { hasText: '전체' }).click();
    });
    await check('timeline: 완료 포함 toggle shows done cases', async () => {
      const b = p.locator('button', { hasText: /완료 포함|완료 숨기기/ }).first();
      const n0 = await p.locator('.flow-case').count();
      await b.click(); await p.waitForTimeout(120);
      const n1 = await p.locator('.flow-case').count();
      await p.locator('button', { hasText: /완료 포함|완료 숨기기/ }).first().click(); await p.waitForTimeout(120);
      expect(n1 >= n0, `${n0} → ${n1}`);
    });
    await check('timeline: incident step 배정 → 1차 조치 (note required) → advances, Alert incident updated', async () => {
      const card = p.locator('.flow-case').first();
      const id0 = (await H.incidents()).map((i) => `${i.id}:${i.status}`);
      const next = card.locator('.row > button.btn.primary').first();
      const lbl = clean(await next.innerText());
      if (await card.locator('input[aria-label="1차 조치 내용"]').count() === 0) { await next.click(); await p.waitForTimeout(200); }
      const inp = card.locator('input[aria-label="1차 조치 내용"]');
      expect(await inp.count() === 1, `no action input after '${lbl}'`);
      const actBtn = inp.locator('xpath=following-sibling::button[1]');
      expect(await actBtn.isDisabled(), 'action enabled with empty note');
      await inp.fill('QA 1차 조치: 자동 조정 보류 유지'); await actBtn.click(); await p.waitForTimeout(200);
      const id1 = (await H.incidents()).map((i) => `${i.id}:${i.status}`);
      expect(id1.some((x) => !id0.includes(x) && /:action$/.test(x)), `no incident moved to action: ${id1.filter((x) => !id0.includes(x))}`);
    });
    await check('timeline: next step after 조치 (결과 보고) advances the same incident', async () => {
      const card = p.locator('.flow-case').first();
      const title = clean(await card.locator('strong').first().innerText());
      const inc0 = (await H.incidents()).find((i) => i.title === title);
      const next = card.locator('.row > button.btn.primary').first();
      expect(await next.count() === 1, 'no next step button');
      const lbl = clean(await next.innerText());
      await next.click(); await p.waitForTimeout(200);
      const inc1 = (await H.incidents()).find((i) => i.id === inc0.id);
      expect(inc1.timeline.length > inc0.timeline.length, `'${lbl}' did not log (status ${inc0.status}→${inc1.status})`);
      expect((await H.toasts()).some((t) => t.includes(title.slice(0, 10))), 'no step toast');
    });
    await check('timeline: linked change row 승인 respects role (disabled out of scope, works in scope)', async () => {
      await p.locator('button', { hasText: '완료 포함' }).first().click().catch(() => {}); await p.waitForTimeout(150);
      const rows = p.locator('.flow-link-row').filter({ has: p.getByRole('button', { name: '승인', exact: true }) });
      expect(await rows.count() >= 1, 'no linked pending change rows');
      await H.role('담당 AE');
      let found = false;
      for (let i = 0; i < await rows.count(); i++) {
        const b = H.btn(rows.nth(i), '승인');
        if (await b.isDisabled()) { found = true; expect(/승인 범위 밖/.test(await b.getAttribute('title')), 'no reason'); break; }
      }
      await H.role('수면밀도');
      const r = rows.first();
      const tgt = clean(await r.locator('strong').first().innerText());
      await H.act(H.btn(r, '승인')); await p.waitForTimeout(250);
      const c = (await H.changes()).find((x) => x.target === tgt);
      expect(c && c.status === 'approved', `${tgt} ${c && c.status}`);
      expect(found, 'no out-of-scope linked row found for AE');
      await H.role('PM');
    });
    await check('timeline: 운영 보고 copy → clipboard text', async () => {
      await p.locator('.flow-case').first().locator('button', { hasText: '운영 보고' }).click(); await p.waitForTimeout(200);
      const t = await H.clip();
      expect(t.length > 50 && /(감지|배정|조치|보고)/.test(t), t.slice(0, 120));
    });
    await check('timeline: fix request button → pending request; 조치 요청 작성 → request tab prefilled with incident', async () => {
      const fixBtn = p.locator('.flow-case button:has(svg)', { hasText: /요청/ }).filter({ hasNotText: '조치 요청 작성' }).first();
      if (await fixBtn.count()) {
        const before = (await H.changes()).length;
        await fixBtn.click(); await p.waitForTimeout(200);
        expect((await H.changes()).length === before + 1, 'fix not created');
      }
      await p.locator('.flow-case').first().locator('button', { hasText: '조치 요청 작성' }).click(); await p.waitForTimeout(250);
      expect(/신규 요청/.test(await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText)), 'not request tab');
      expect(/연결된 조치 요청/.test(await p.locator('.page').innerText()) && (await p.inputValue('#flow-reason')).length > 0, 'not prefilled');
    });
    await H.tab('반복 구간');
    await check('system: segments + decision matrix shown; 열기 buttons navigate', async () => {
      const t = clean(await p.locator('.page').innerText());
      expect(/결정 유형/.test(t) && /지금/.test(t), 'tables missing');
      const opens = p.locator('button', { hasText: '열기' });
      expect(await opens.count() >= 1, 'no 열기');
      await opens.first().click(); await p.waitForTimeout(350);
      const hash = await p.evaluate(() => location.hash);
      const tab = await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText).catch(() => '');
      expect(hash !== '#flow' || !/반복 구간/.test(tab), `${hash} ${tab}`);
    });
  });

  /* ---------------- END-TO-END (a): AD Pilot bid_up → Flow PM 승인 → 반영 → AD Pilot 이력 → 롤백 ---------------- */
  await area('e2e-a', { route: 'adpilot', ai: 'artifact', downloads: 'accept' }, async (h, p, H) => {
    await check('E2E(a): bid_up request → Flow (AE cannot see, PM approves + applies) → AD Pilot history applied → rollback restores bid', async () => {
      const row = H.apRow('허리 아플때 매트리스');
      await row.locator('button:has-text("승인 요청")').click(); await p.waitForTimeout(250);
      await p.locator('.toast', { hasText: '승인 요청을 만들었습니다' }).locator('button:has-text("바로 가기")').click(); await p.waitForTimeout(500);
      expect(await p.evaluate(() => location.hash) === '#flow', 'toast 바로 가기');
      await H.role('담당 AE');
      expect(await p.locator('.flow-queue-row', { hasText: '허리 아플때' }).count() === 0, 'AE queue has PM item');
      await H.role('PM');
      const q = p.locator('.flow-queue-row', { hasText: '허리 아플때' });
      await H.act(H.btn(q, '승인')); await p.waitForTimeout(250);
      await H.act(H.btn(q, '반영')); await p.waitForTimeout(250);
      let c = H.fresh(await H.changes()).find((x) => x.target.includes('허리 아플때'));
      expect(c.status === 'applied' && c.history.map((x) => `${x.by}:${x.action}`).join(',') === 'PM:요청 생성,PM:승인,PM:반영', c.history.map((x) => `${x.by}:${x.action}`).join(','));
      await H.go('adpilot'); await H.tab('변경 이력');
      const hr = p.locator('.adpilot-page table.tbl tbody tr', { hasText: '허리 아플때' }).first();
      expect(/반영/.test(await hr.innerText()) && /980원 → 1,160원/.test(clean(await hr.innerText())), clean(await hr.innerText()).slice(0, 160));
      await H.act(H.btn(hr, '롤백')); await p.waitForTimeout(250);
      c = H.fresh(await H.changes()).find((x) => x.target.includes('허리 아플때'));
      expect(c.status === 'rolled_back' && /1,160원 → 980원/.test(c.history.slice(-1)[0].note), `${c.status} ${c.history.slice(-1)[0].note}`);
      await H.tab('키워드 진단'); await p.fill('#adpilot-kw-q', '허리 아플때'); await p.waitForTimeout(150);
      expect(/980원 → 1,160원 \+18\.4%/.test(clean(await p.locator('.adpilot-page table.tbl tbody tr', { hasText: '허리 아플때' }).first().innerText())), 'bid not restored');
      await H.tab('조정 후보');
      expect(await H.apRow('허리 아플때 매트리스').locator('button', { hasText: '재요청' }).count() === 1, 'no 재요청 after rollback');
    });
  });

  /* ---------------- END-TO-END (b): Alert 충전 요청 → Flow 수면밀도 승인 · 반영 → GFA 잔액 · 증액 실행 ---------------- */
  await area('e2e-b', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await check('E2E(b): GFA +5% held → Alert 충전 요청 (CLIENT) → Flow 수면밀도 승인/반영 → GFA balance 785만 → held increase 재실행 applied', async () => {
      await H.tab('GFA Control');
      await p.locator('#adpilot-gfa-form button', { hasText: '+5%' }).click();
      await p.fill('#adpilot-gfa-reason', 'QA 증액');
      await p.locator('#adpilot-gfa-form button', { hasText: '승인 요청 →' }).click(); await p.waitForTimeout(250);
      const q = p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'QA 증액' }).first();
      await H.act(H.btn(q, '승인')); await p.waitForTimeout(200);
      await H.act(H.btn(p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'GFA_Prospecting 일 예산' }).filter({ has: p.getByRole('button', { name: '실행', exact: true }) }), '실행')); await p.waitForTimeout(250);
      expect(H.fresh(await H.changes()).find((c) => c.module === 'gfa').status === 'held', 'not held before top-up');
      // seed 충전 요청이 이미 대기 중 → Flow에서 반려 후 Alert 화면에서 새로 요청
      await H.go('flow'); await H.role('수면밀도');
      await p.locator('.flow-queue-row', { hasText: '충전' }).first().locator('button:has-text("상세")').click(); await p.waitForTimeout(200);
      await p.fill('#flow-note', 'QA: Alert 화면에서 다시 요청');
      await H.act(p.locator('.drawer').getByRole('button', { name: '반려', exact: true })); await p.waitForTimeout(100);
      await H.act(p.locator('.drawer button', { hasText: '확인 · 반려' })); await p.waitForTimeout(200);
      await H.closeDrawer();
      await H.go('alert');
      await p.click('.page .tabs [role=tab]:has-text("계정 · 결제")'); await p.waitForTimeout(300);
      const btn = p.locator('button', { hasText: /충전 요청 .*수면밀도/ }).first();
      expect(await btn.count() === 1 && !(await btn.isDisabled()), 'Alert 충전 요청 button unavailable');
      await btn.click(); await p.waitForTimeout(300);
      const top = H.fresh(await H.changes()).find((c) => /topup/.test(c.targetId || ''));
      expect(top && top.approver === 'CLIENT' && top.status === 'pending', JSON.stringify(top).slice(0, 160));
      await H.go('flow');
      await H.role('PM');
      expect(await p.locator('.flow-queue-row', { hasText: '충전' }).count() === 0, 'PM can process CLIENT top-up');
      await H.role('수면밀도');
      const fq = p.locator('.flow-queue-row', { hasText: '충전' }).first();
      await H.act(H.btn(fq, '승인')); await p.waitForTimeout(200);
      await H.act(H.btn(p.locator('.flow-queue-row', { hasText: '충전' }).first(), '반영')); await p.waitForTimeout(250);
      expect((await H.changes()).find((c) => c.id === top.id).status === 'applied', 'top-up not applied');
      await H.go('adpilot'); await H.tab('GFA Control');
      const card = clean(await p.locator('.card', { hasText: '네이버 GFA (수면밀도)' }).first().innerText());
      expect(/잔액 785만/.test(card) && /3\.03일/.test(card), card.slice(0, 200));
      const row = p.locator('.adpilot-page table.tbl tbody tr', { hasText: 'GFA_Prospecting 일 예산' }).filter({ has: p.getByRole('button', { name: '재실행' }) }).first();
      await H.act(row.getByRole('button', { name: '재실행' })); await p.waitForTimeout(250);
      expect(H.fresh(await H.changes()).find((c) => c.module === 'gfa').status === 'applied', 'held increase not executed after top-up');
      await p.locator('#adpilot-gfa-form button', { hasText: '+10%' }).click(); await p.waitForTimeout(100);
      expect(!/잔액 0\.91일치/.test(clean(await p.locator('#adpilot-gfa-form').innerText())), 'low-balance warning persists');
    });
  });

  /* ---------------- AI: 규칙 엔진 · 스트리밍 · 오류 · 중지 ---------------- */
  const aiBtn = (p, title) => p.locator('.card', { has: p.locator('.card-title', { hasText: title }) }).first();
  await area('ai-none', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await check('AI none: 조정안 해석 → full rule-engine brief (6 sections, 규칙 엔진 tag)', async () => {
      const c = aiBtn(p, 'AD Pilot 조정안 해석');
      await c.locator('button', { hasText: '조정안 해석' }).click(); await p.waitForTimeout(250);
      const t = clean(await c.innerText());
      expect(/규칙 엔진/.test(t) && /확정 팩트/.test(t) && /반복 관측 패턴/.test(t) && /(해석)/.test(t) && /다음 액션/.test(t), t.slice(0, 200));
      await H.go('flow');
      const f = aiBtn(p, '승인 대기 우선순위 해석');
      await f.locator('button', { hasText: '해석 생성' }).click(); await p.waitForTimeout(250);
      expect(/규칙 엔진/.test(await f.innerText()) && /확정 팩트/.test(await f.innerText()), 'flow fallback');
    });
  });
  await area('ai-artifact', { route: 'adpilot', ai: 'artifact' }, async (h, p, H) => {
    await check('AI: no call on load or tab navigation (AD Pilot + Flow tabs)', async () => {
      for (const t of ['키워드 진단', '신규 후보', '자동 입찰 검증', 'GFA Control', '변경 이력', '조정 후보']) await H.tab(t);
      await H.go('flow');
      for (const t of ['운영 타임라인', '프로모션 점검', '프로모션 리포트', '신규 요청', '반복 구간', '요청 · 승인']) await H.tab(t);
      await p.waitForTimeout(500);
      expect((await h.calls()).length === 0, `calls ${(await h.calls()).length}`);
    });
    await check('AI artifact: 5 AiInsight buttons stream full mock text, tagged AI, cache:false, no tools, ≤256KiB', async () => {
      const targets = [['flow', '요청 · 승인', '승인 대기 우선순위 해석', '해석 생성'], ['flow', '운영 타임라인', '운영 프로세스 해석', '해석 생성'], ['flow', '프로모션 점검', '오픈 전 점검 해석', '해석 생성'], ['flow', '프로모션 리포트', 'AI 해석 추가', 'AI 해석 추가'], ['adpilot', '조정 후보', 'AD Pilot 조정안 해석', '조정안 해석']];
      for (const [route, tab, title, cta] of targets) {
        await H.go(route); await H.tab(tab);
        const c = aiBtn(p, title);
        await c.locator('button', { hasText: cta }).click(); await p.waitForTimeout(700);
        const t = clean(await c.innerText());
        expect(/모의 액션\./.test(t) && /확정 팩트/.test(t), `${title}: ${t.slice(-120)}`);
        expect(await c.locator('.src, [class*="src"]').filter({ hasText: 'AI' }).count() >= 1 || /AI/.test(t), `${title} no AI tag`);
        expect(/다시 생성/.test(t), `${title} button not reusable`);
      }
      const calls = await h.calls();
      expect(calls.length === 5 && calls.every((c) => c.cache === false && c.tools.length === 0 && c.inputBytes < 262144), JSON.stringify(calls).slice(0, 300));
      await p.waitForTimeout(1500);
      expect((await h.calls()).length === 5, 'auto retry/extra calls');
    });
  });
  for (const mode of ['denied', 'rate', 'error-mid', 'unavailable']) {
    await area(`ai-${mode}`, { route: 'adpilot', ai: mode }, async (h, p, H) => {
      await check(`AI ${mode}: clear Korean message, content kept/fallback, button usable, no auto-retry`, async () => {
        const c = aiBtn(p, 'AD Pilot 조정안 해석');
        await c.locator('button', { hasText: '조정안 해석' }).click(); await p.waitForTimeout(800);
        const t = clean(await c.innerText());
        const n1 = (await h.calls()).length;
        if (mode === 'unavailable') expect(n1 === 0 && /규칙 엔진/.test(t) && /확정 팩트/.test(t), `unavailable: ${n1} ${t.slice(0, 120)}`);
        if (mode === 'denied') expect(/허용되지 않았습니다/.test(t) && /확정 팩트/.test(t), t.slice(0, 200));
        if (mode === 'rate') expect(/요청이 많습니다/.test(t) && /확정 팩트/.test(t), t.slice(0, 200));
        if (mode === 'error-mid') expect(/일시적인 연결 오류/.test(t) && /확정 팩트/.test(t), t.slice(0, 200));
        await p.waitForTimeout(1500);
        expect((await h.calls()).length === n1, 'auto retry');
        const b = c.locator('button', { hasText: /다시 생성|조정안 해석/ }).first();
        expect(!(await b.isDisabled()), 'button not usable');
        // 계약: not_granted 는 기능 숨김 · 재요청 금지 → 다시 눌러도 규칙 엔진, rate/upstream 은 수동 재시도 가능
        if (mode === 'denied') { await b.click(); await p.waitForTimeout(800); expect((await h.calls()).length === n1 && /규칙 엔진/.test(clean(await c.innerText())), 'denied re-requested'); }
        if (mode === 'rate' || mode === 'error-mid') { await b.click(); await p.waitForTimeout(800); expect((await h.calls()).length === n1 + 1, 'manual retry did not call'); }
      });
    });
  }
  await area('ai-slow', { route: 'flow', ai: 'slow' }, async (h, p, H) => {
    await check('AI slow: 중지 cancels (no error shown), dblclick on start does not stop', async () => {
      const c = aiBtn(p, '승인 대기 우선순위 해석');
      await c.locator('button', { hasText: '해석 생성' }).dblclick(); await p.waitForTimeout(400);
      expect(await c.locator('button', { hasText: '중지' }).count() === 1, 'dblclick stopped the run');
      await p.waitForTimeout(1500);
      await c.locator('button', { hasText: '중지' }).click(); await p.waitForTimeout(400);
      const t = clean(await c.innerText());
      expect(!/오류|실패/.test(t) && /다시 생성|해석 생성/.test(t), t.slice(0, 200));
      expect((await h.calls()).length === 1, `calls ${(await h.calls()).length}`);
      await p.waitForTimeout(3500);
      expect(!/모의 액션/.test(clean(await c.innerText())), 'stream continued after stop');
    });
  });

  /* ---------------- 다운로드 모드 ---------------- */
  await area('downloads-decline', { route: 'flow', ai: 'artifact', downloads: 'decline' }, async (h, p, H) => {
    await check('downloads decline: Flow CSV + promo .md → no save, no error state, page usable', async () => {
      await p.locator('.card:has(.seg[aria-label="보기"]) button', { hasText: 'CSV' }).click(); await p.waitForTimeout(400);
      await H.tab('프로모션 리포트');
      await p.locator('button', { hasText: '.md 다운로드' }).click(); await p.waitForTimeout(400);
      expect((await h.saves()).length === 0, 'saved despite decline');
      expect(!(await H.toasts()).some((t) => /오류|실패/.test(t)), JSON.stringify(await H.toasts()));
      await H.tab('요청 · 승인');
      expect(await p.locator('.flow-queue-row').count() > 0, 'page broken');
    });
  });
  await area('downloads-accept', { route: 'flow', ai: 'artifact', downloads: 'accept' }, async (h, p, H) => {
    await check('downloads accept: Flow CSV save — header row, Korean intact, all rows', async () => {
      await p.locator('.card:has(.seg[aria-label="보기"]) button', { hasText: 'CSV' }).click(); await p.waitForTimeout(400);
      const s = (await h.saves()).find((x) => x.filename.endsWith('.csv'));
      expect(s && /^mildo-flow-history-2026-10-31\.csv$/.test(s.filename) && /^﻿?id,요청시각,상태,모듈,유형,대상/.test(s.head) && /시연 이력|충전|매트리스/.test(s.head), JSON.stringify(s).slice(0, 200));
    });
  });
  await area('downloads-none', { route: 'flow', ai: 'none' }, async (h, p, H) => {
    await check('downloads (no claude runtime): Flow CSV + AD Pilot history CSV → browser download events', async () => {
      await p.locator('.card:has(.seg[aria-label="보기"]) button', { hasText: 'CSV' }).click(); await p.waitForTimeout(600);
      await H.go('adpilot'); await H.tab('변경 이력');
      await p.locator('.card', { has: p.locator('.card-title', { hasText: '변경 이력 전체 기록' }) }).locator('button', { hasText: 'CSV' }).click(); await p.waitForTimeout(600);
      expect(h.downloads.includes('mildo-flow-history-2026-10-31.csv') && h.downloads.some((d) => d.startsWith('adpilot-history')), JSON.stringify(h.downloads));
    });
  });

  /* ---------------- 저장 · 초기화 ---------------- */
  await area('persistence', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await check('persistence: requests/approvals survive reload; Settings 시연 상태 초기화 (2-step) clears; 시연 이력 불러오기 restores seeds', async () => {
      await H.act(H.apRow('허리 아플때 매트리스').locator('button:has-text("승인 요청")')); await p.waitForTimeout(200);
      await H.act(H.btn(H.apRow('허리 아플때 매트리스'), '승인')); await p.waitForTimeout(200);
      await H.role('수면밀도');
      await h.reload();
      const c = H.fresh(await H.changes()).find((x) => x.target.includes('허리 아플때'));
      expect(c && c.status === 'approved' && await p.inputValue('#role-select') === '수면밀도', 'not persisted');
      expect(/승인/.test(await H.apRow('허리 아플때 매트리스').innerText()) && await H.btn(H.apRow('허리 아플때 매트리스'), '반영').count() === 1, 'row state lost');
      await p.locator('button', { hasText: '설정' }).first().click(); await p.waitForTimeout(200);
      await p.locator('button', { hasText: '시연 상태 초기화' }).click(); await p.waitForTimeout(100);
      expect(H.fresh(await H.changes()).length === 1, 'reset without confirm');
      await p.locator('button', { hasText: '정말 초기화' }).click(); await p.waitForTimeout(400);
      const after = await H.changes();
      // 초기화 = 첫 시연 상태 (세션 요청 0건 + 시연 이력 10건은 Shell 이 다시 적재)
      expect(H.fresh(after).length === 0 && after.length === 10, `after reset fresh ${H.fresh(after).length} total ${after.length}`);
      expect(await H.apRow('허리 아플때 매트리스').locator('button:has-text("승인 요청")').count() === 1, 'AD Pilot row not reset');
      await H.go('flow');
      expect(await p.locator('button', { hasText: '시연 이력 불러오기' }).count() === 0 && (await p.$$eval('.flow-queue-row', (r) => r.length)) > 0, 'seeds missing in Flow');
      await h.reload();
      expect(H.fresh(await H.changes()).length === 0 && (await H.changes()).length === 10, 'reset not persisted');
    });
  });

  /* ---------------- 남은 컨트롤 ---------------- */
  await area('extra-adpilot', { route: 'adpilot', ai: 'none' }, async (h, p, H) => {
    await check('proposals: row double-click opens the detail drawer and it stays open', async () => {
      await p.locator(H.apRows, { hasText: '신혼 매트리스' }).first().locator('td').nth(2).dblclick(); await p.waitForTimeout(300);
      expect(await p.locator('.drawer').count() === 1, 'drawer closed by 2nd click');
      await H.closeDrawer();
      expect(await p.locator('.drawer').count() === 0, 'close button did not close');
    });
    await H.tab('GFA Control');
    await check('gfa: account select switches campaign list; new-campaign objective + huge budget warning', async () => {
      const accs = await p.$$eval('#adpilot-gfa-acc option', (o) => o.map((x) => x.value));
      expect(accs.length >= 2, 'accounts');
      const lists = [];
      for (const a of accs) { await p.selectOption('#adpilot-gfa-acc', a); await p.waitForTimeout(80); lists.push(await p.$$eval('#adpilot-gfa-cmp option', (o) => o.map((x) => x.textContent).join(','))); }
      expect(new Set(lists).size === accs.length, JSON.stringify(lists));
      await p.selectOption('#adpilot-gfa-acc', accs[0]);
      await p.locator('#adpilot-gfa-form .seg[aria-label="변경 유형"] button', { hasText: '신규' }).click(); await p.waitForTimeout(80);
      const objs = await p.$$eval('#adpilot-gfa-obj option', (o) => o.map((x) => x.value));
      await p.selectOption('#adpilot-gfa-obj', objs[objs.length - 1]);
      await p.fill('#adpilot-gfa-name', 'GFA_QA 대형'); await H.setNum('#adpilot-gfa-nb', 99999999);
      const t = clean(await p.locator('#adpilot-gfa-form').innerText());
      expect(/계정 잔액 235만보다 큽니다/.test(t), t.slice(0, 200));
      await p.locator('#adpilot-gfa-form button', { hasText: '승인 요청 →' }).click(); await p.waitForTimeout(200);
      const c = H.fresh(await H.changes()).find((x) => x.kind === 'gfa');
      expect(c && c.reason.includes(objs[objs.length - 1]) && c.approver === 'CLIENT', JSON.stringify(c).slice(0, 200));
    });
    await H.tab('자동 입찰 검증');
    await check('verify: CPC elasticity changes cost; request → ChangeButtons in verify panel approve (in scope)', async () => {
      const eff = async () => clean(await p.locator('.card', { has: p.locator('.card-title', { hasText: '예상 효과' }) }).first().innerText());
      await p.locator('.card', { has: p.locator('.card-title', { hasText: '자동 입찰 검증' }) }).first().locator('button', { hasText: '+10%' }).click(); await p.waitForTimeout(100);
      const a = await eff(); await p.fill('#adpilot-e-cpc', '1.2'); await p.waitForTimeout(120); const b = await eff();
      expect(a !== b, 'cpc elasticity no effect');
      await p.fill('#adpilot-e-cpc', '0.7');
      const vc = p.locator('.card', { has: p.locator('.card-title', { hasText: 'SAFETY 검증 결과' }) });
      await H.act(vc.locator('button', { hasText: '승인 요청' })); await p.waitForTimeout(200);
      await H.act(H.btn(vc, '승인')); await p.waitForTimeout(200);
      const c = H.fresh(await H.changes()).find((x) => x.kind === 'bid');
      expect(c && c.status === 'approved', JSON.stringify(c).slice(0, 120));
    });
  });
  await area('extra-flow', { route: 'flow', ai: 'none' }, async (h, p, H) => {
    await check('flow: board card double-click opens drawer and it stays open', async () => {
      await p.locator('.flow-card').first().dblclick(); await p.waitForTimeout(300);
      expect(await p.locator('.drawer').count() === 1, 'drawer closed by 2nd click');
      await H.closeDrawer();
    });
    await check('flow: queue main row click opens drawer; queue 보류 해제 → approved', async () => {
      await p.locator('.flow-queue-row .flow-queue-main').first().click(); await p.waitForTimeout(200);
      expect(await p.locator('.drawer').count() === 1, 'no drawer');
      await H.closeDrawer();
      const r = p.locator('.flow-queue-row', { hasText: '카카오_프로모션' }).first();
      await H.act(r.getByRole('button', { name: '보류 해제' })); await p.waitForTimeout(200);
      expect((await H.changes()).find((c) => c.id === 'seed_flow_6').status === 'approved', 'resume failed');
    });
    await check('request: keyword exclude on brand blocked; creative needs before/after + copy review', async () => {
      await H.tab('신규 요청');
      await p.selectOption('#flow-type', 'keyword'); await p.waitForTimeout(60);
      await p.locator('.seg[aria-label="키워드 요청"] button', { hasText: '제외' }).click(); await p.waitForTimeout(60);
      await p.fill('#flow-kwt', '수면밀도'); await p.fill('#flow-reason', 'QA 제외 키워드 등록 요청');
      expect(/브랜드 키워드는 제외할 수 없습니다/.test(clean(await p.locator('.callout', { hasText: '제출 불가' }).first().innerText())), 'brand exclude allowed');
      await p.fill('#flow-kwt', '매트리스 중고'); await p.waitForTimeout(60);
      expect(!(await p.locator('button', { hasText: '승인 요청 생성' }).isDisabled()), 'valid exclude blocked');
      await p.selectOption('#flow-type', 'creative'); await p.waitForTimeout(60);
      await p.fill('#flow-tt', 'GFA 쇼핑 고객 확장 · 가격형'); await p.fill('#flow-reason', 'QA 소재 교체 요청 사유');
      expect(/변경 후 문구/.test(clean(await p.locator('.callout', { hasText: '제출 불가' }).first().innerText())), 'creative empty after');
      await p.fill('#flow-bt', '기존 소재'); await p.fill('#flow-at', '혼수 매트리스 퀸 841,500원 · 기획전 15%');
      await p.waitForTimeout(80);
      expect(!(await p.locator('button', { hasText: '승인 요청 생성' }).isDisabled()), 'valid creative blocked');
    });
    await check('timeline: feed change item opens drawer; linked change row opens drawer', async () => {
      await H.tab('운영 타임라인');
      await p.locator('.seg[aria-label="출처"] button', { hasText: '요청' }).click(); await p.waitForTimeout(100);
      await p.locator('.flow-feed .flow-ev-body').first().click(); await p.waitForTimeout(200);
      expect(await p.locator('.drawer').count() === 1, 'feed click no drawer');
      await H.closeDrawer();
      await p.locator('button', { hasText: '완료 포함' }).first().click().catch(() => {}); await p.waitForTimeout(120);
      await p.locator('.flow-link-main').first().click(); await p.waitForTimeout(200);
      expect(await p.locator('.drawer').count() === 1, 'link row no drawer');
      await H.closeDrawer();
    });
    await check('system: every 열기 button navigates (route or Flow tab)', async () => {
      await H.tab('반복 구간');
      const n = await p.locator('button', { hasText: '열기' }).count();
      expect(n >= 3, `열기 ${n}`);
      for (let i = 0; i < n; i++) {
        await H.go('flow'); await H.tab('반복 구간');
        await p.locator('button', { hasText: '열기' }).nth(i).click(); await p.waitForTimeout(300);
        const hash = await p.evaluate(() => location.hash);
        const tab = await p.$eval('.page .tabs [aria-selected=true]', (x) => x.innerText).catch(() => '');
        expect(hash !== '#flow' || !/반복 구간/.test(tab), `열기 #${i} stayed (${hash} ${tab})`);
      }
    });
  });

  console.log(`\n${passes} PASS · ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})();
