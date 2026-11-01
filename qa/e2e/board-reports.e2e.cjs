/**
 * MILDO OS 기능 점검 e2e — MILDO Board (#board) · 리포트 · 데이터 시간표 (#reports)
 * 사용: NODE_PATH=$(npm root -g) node qa/e2e/board-reports.e2e.cjs dist-single/index.html
 * 한 줄에 하나씩 'PASS <name>' 또는 'FAIL <name>: <reason>' 출력, FAIL이 하나라도 있으면 exit 1.
 * 하네스: qa/e2e/harness.cjs (claude.ai 런타임 모의 — sample · downloads)
 */
const { open } = require(require('path').join(__dirname, 'harness.cjs'));

const FILE = process.argv[2];
if (!FILE) { console.error('usage: node e2e.cjs <path/to/index.html>'); process.exit(2); }

let fails = 0;
const results = [];
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`PASS ${name}`); results.push([name, true]); }
    else { fails++; console.log(`FAIL ${name}: ${r}`); results.push([name, false]); }
  } catch (e) {
    fails++; console.log(`FAIL ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 200)}`); results.push([name, false]);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = async (loc) => (await loc.textContent()).replace(/\s+/g, ' ');
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(450); };
const cardOf = (p, title) => p.locator('.card', { has: p.locator(`.card-title:has-text("${title}")`) }).first();
const clip = (p) => p.evaluate(() => navigator.clipboard.readText());
const noErr = (h) => (h.errors.length ? `console errors: ${h.errors.slice(0, 2).join(' | ')}` : true);

async function withPage(opts, fn) {
  const h = await open({ file: FILE, downloads: 'accept', ...opts });
  try { return await fn(h, h.page); } finally { await h.close(); }
}

(async () => {
  /* ======================= MILDO Board ======================= */
  await withPage({ route: 'board', ai: 'artifact' }, async (h, p) => {
    await check('board: 로드 시 AI 호출 없음 · 콘솔 오류 없음', async () => {
      const c = await h.calls();
      if (c.length) return `AI calls on load: ${c.length}`;
      return noErr(h);
    });
    await check('board: 기간 프리셋 5종이 KPI를 바꾼다', async () => {
      const seen = new Set();
      for (const lbl of ['어제', '최근 7일', '최근 14일', '최근 30일', '이번 달']) {
        await p.click(`.seg[aria-label="기간 선택"] button:has-text("${lbl}")`); await p.waitForTimeout(150);
        const pressed = await p.getAttribute(`.seg[aria-label="기간 선택"] button:has-text("${lbl}")`, 'aria-pressed');
        if (pressed !== 'true') return `${lbl} not pressed`;
        const sub = await txt(cardOf(p, '핵심 지표').locator('.card-sub'));
        if (lbl === '이번 달' && !sub.includes('부분일')) return 'MTD sub lacks 부분일 표기';
        seen.add(await txt(p.locator('.board-kpis')));
      }
      await p.click('.seg[aria-label="기간 선택"] button:has-text("최근 7일")');
      return seen.size === 5 || `distinct KPI sets ${seen.size}/5`;
    });
    await check('board: 6개 탭 모두 렌더 · 탭 순회 후에도 AI 호출 0', async () => {
      const n = await p.locator('#board-tabs [role=tab]').count();
      if (n !== 6) return `tabs ${n}`;
      for (let i = 0; i < n; i++) {
        await p.locator('#board-tabs [role=tab]').nth(i).click(); await p.waitForTimeout(150);
        if ((await p.locator('#board-tabs [role=tab]').nth(i).getAttribute('aria-selected')) !== 'true') return `tab ${i} not selected`;
      }
      const c = await h.calls();
      return c.length === 0 || `AI calls after tabs: ${c.length}`;
    });
    await check('board: 매체 표 정렬 (광고비 내림 ↔ 오름) · 변동 판정 정렬 키', async () => {
      await p.locator('#board-tabs [role=tab]').nth(0).click(); await p.waitForTimeout(150);
      const t = cardOf(p, '매체 통합 성과 · 동일 기준 비교');
      const first = async () => (await t.locator('tbody tr td:nth-child(1)').first().textContent()).slice(0, 6);
      const desc = await first();
      await t.locator('thead th:has-text("광고비")').click(); await p.waitForTimeout(80);
      const asc = await first();
      if (desc === asc) return `order unchanged (${desc})`;
      if ((await t.locator('thead th:has-text("광고비")').getAttribute('aria-sort')) !== 'ascending') return 'aria-sort not ascending';
      await t.locator('thead th:has-text("광고비")').click();
      return true;
    });
    await check('board: 일자별 추이 — 지표 · 매체 칩 · 합계 토글 · 호버 툴팁', async () => {
      const tr = cardOf(p, '일자별 추이');
      await tr.locator('.seg[aria-label="지표"] button:has-text("ROAS")').click(); await p.waitForTimeout(80);
      const chips = tr.locator('.board-chip');
      await chips.nth(4).click(); await p.waitForTimeout(80);
      if ((await chips.nth(4).getAttribute('aria-pressed')) !== 'true') return 'kakao chip not pressed';
      if (!(await txt(tr.locator('.row.xs.muted'))).includes('카카오')) return 'kakao series missing';
      for (const i of [0, 1, 2, 3, 4]) await chips.nth(i).click();
      if ((await chips.nth(4).getAttribute('aria-pressed')) !== 'true') return 'last chip must stay selected';
      await p.click('label[for="board-trend-total"]'); await p.waitForTimeout(80);
      if (!(await txt(tr.locator('.row.xs.muted'))).includes('합계')) return 'total series missing';
      const rect = tr.locator('svg rect[fill="transparent"]'); await rect.scrollIntoViewIfNeeded();
      const bb = await rect.boundingBox();
      await p.mouse.move(bb.x + bb.width / 2, bb.y + 10); await p.waitForTimeout(120);
      const tip = await tr.locator('.chart-tip').textContent({ timeout: 1500 }).catch(() => null);
      if (!tip || !/\d+\/\d+/.test(tip)) return `tooltip ${tip}`;
      await p.mouse.move(0, 0); await p.waitForTimeout(80);
      return (await tr.locator('.chart-tip').count()) === 0 || 'tooltip stays after leave';
    });
    await check('board: 키워드 필터 (의도 · 상태 · 제품군 · 신호 · 검색어) · 빈 결과 · 초기화', async () => {
      await p.click('#board-tabs [role=tab]:has-text("02 키워드")'); await p.waitForTimeout(150);
      const card = cardOf(p, '키워드 성과 필터');
      const count = async () => Number((await card.locator('button:has-text("CSV 내보내기")').textContent()).match(/\((\d+)\)/)[1]);
      const all = await count();
      if (all < 20) return `only ${all} keywords`;
      await card.locator('.board-chips[aria-label="구매 의도"] .board-chip').nth(1).click(); await p.waitForTimeout(60);
      const brand = await count();
      const intents = new Set(await card.locator('table.tbl').first().locator('tbody tr td:nth-child(2)').allTextContents());
      if (!(brand > 0 && brand < all && intents.size === 1)) return `intent filter ${brand} ${[...intents]}`;
      await card.locator('.board-chips[aria-label="구매 의도"] .board-chip').nth(0).click();
      await card.locator('.seg[aria-label="키워드 상태"] button:has-text("테스트")').click(); await p.waitForTimeout(60);
      const test = await count();
      await card.locator('.seg[aria-label="키워드 상태"] button:has-text("전체")').click();
      await p.selectOption('#board-kw-group', 'size:킹'); await p.waitForTimeout(60);
      const king = await count();
      await p.selectOption('#board-kw-group', 'all');
      await p.selectOption('#board-kw-signal', 'soldout'); await p.waitForTimeout(60);
      const sold = await txt(card.locator('table.tbl').first().locator('tbody'));
      await p.selectOption('#board-kw-signal', 'all');
      if (!(test > 0 && test < all && king === 1 && sold.includes('킹 매트리스'))) return `status ${test} king ${king} soldout ${sold.slice(0, 30)}`;
      await p.fill('#board-kw-q', 'zzz없는키워드'); await p.waitForTimeout(80);
      const empty = await txt(card.locator('table.tbl').first().locator('tbody'));
      if (!empty.includes('조건에 맞는 키워드가 없습니다')) return 'no readable empty state';
      await card.locator('table.tbl').first().locator('button.board-linkbtn:has-text("필터 초기화")').click(); await p.waitForTimeout(80);
      return ((await count()) === all && (await p.inputValue('#board-kw-q')) === '') || 'reset failed';
    });
    await check('board: 키워드 신호 정렬 첫 클릭에 신호 많은 키워드가 위 (회귀)', async () => {
      const t = cardOf(p, '키워드 성과 필터').locator('table.tbl').first();
      await t.locator('thead th:has-text("신호")').click(); await p.waitForTimeout(80);
      const firstSig = await t.locator('tbody tr').first().locator('td').last().textContent();
      await t.locator('thead th:has-text("광고비")').click();
      return firstSig.trim() !== '—' || 'first row has no signal';
    });
    await check('board: 키워드 행 → 드로어 (CPC 툴팁 · AD Pilot 링크 이동)', async () => {
      const t = cardOf(p, '키워드 성과 필터').locator('table.tbl').first();
      await t.locator('tbody tr').first().click(); await p.waitForTimeout(200);
      const dr = p.locator('.drawer');
      if (!(await dr.count())) return 'drawer not opened';
      const rect = dr.locator('svg rect[fill="transparent"]'); const bb = await rect.boundingBox();
      await p.mouse.move(bb.x + bb.width / 3, bb.y + 10); await p.waitForTimeout(100);
      const tip = await dr.locator('.chart-tip').textContent({ timeout: 1500 }).catch(() => null);
      if (!tip || !tip.includes('CPC')) return `drawer tooltip ${tip}`;
      await dr.locator('a.btn:has-text("AD Pilot")').click(); await p.waitForTimeout(400);
      const hash = await p.evaluate(() => location.hash);
      await go(p, '#board');
      return hash === '#adpilot' || `hash ${hash}`;
    });
    await check('board: CSV 다운로드(아티팩트 수락) — .csv · 한글 머리글 · 행', async () => {
      await p.click('#board-tabs [role=tab]:has-text("02 키워드")'); await p.waitForTimeout(150);
      await p.locator('button:has-text("CSV 내보내기")').click(); await p.waitForTimeout(400);
      const s = (await h.saves()).at(-1);
      if (!s) return 'no save';
      if (!/\.csv$/.test(s.filename)) return `filename ${s.filename}`;
      if (!s.head.includes('키워드,구매 의도') || !s.head.includes('\n')) return `head ${s.head.slice(0, 40)}`;
      return true;
    });
    await check('board: 0행 필터 CSV도 머리글 파일로 저장 (회귀: 빈 데이터 bad_request 무반응)', async () => {
      const n0 = (await h.saves()).length;
      await p.fill('#board-kw-q', 'zzz없는키워드'); await p.waitForTimeout(80);
      await p.locator('button:has-text("CSV 내보내기")').click(); await p.waitForTimeout(400);
      const sv = await h.saves();
      await p.fill('#board-kw-q', '');
      if (sv.length !== n0 + 1) return 'no save for empty result';
      return sv.at(-1).head.startsWith('키워드') || sv.at(-1).head.charCodeAt(0) === 0xfeff || `head ${sv.at(-1).head.slice(0, 20)}`;
    });
    await check('board: CSV 복사 — 클립보드에 머리글 + 행 (BOM 제외)', async () => {
      await p.locator('button:has-text("CSV 복사")').click(); await p.waitForTimeout(200);
      const c = await clip(p);
      return (c.startsWith('키워드,') && c.split('\n').length > 20) || `clip ${c.slice(0, 30)}`;
    });
    await check('board: 예산 소진 — 조기 소진 범위 · 피크 경고', async () => {
      await p.click('#board-tabs [role=tab]:has-text("03 예산")'); await p.waitForTimeout(150);
      const c = cardOf(p, '캠페인별 일 예산 소진');
      const all = await c.locator('tbody tr').count();
      await c.locator('.seg button:has-text("조기 소진")').click(); await p.waitForTimeout(80);
      const early = await txt(c.locator('tbody'));
      const n = await c.locator('tbody tr').count();
      if (!(n > 0 && n < all && early.includes('Meta_넓은 타겟') && early.includes('SA_일반 제품'))) return `early ${n}/${all}`;
      return (await p.locator('.callout:has-text("피크 시간 전")').count()) > 0 || 'no peak callout';
    });
    await check('board: 판매 채널 — 기간 변경 반영 · 추이 툴팁', async () => {
      await p.click('#board-tabs [role=tab]:has-text("판매 채널")'); await p.waitForTimeout(150);
      const a = await txt(cardOf(p, '광고비 대비 실매출'));
      await p.click('.seg[aria-label="기간 선택"] button:has-text("어제")'); await p.waitForTimeout(150);
      const b = await txt(cardOf(p, '광고비 대비 실매출'));
      await p.click('.seg[aria-label="기간 선택"] button:has-text("최근 7일")');
      if (a === b) return 'sales card did not change with period';
      const tr = cardOf(p, '채널별 일자 추이'); const rect = tr.locator('svg rect[fill="transparent"]');
      await rect.scrollIntoViewIfNeeded(); const bb = await rect.boundingBox();
      await p.mouse.move(bb.x + bb.width / 2, bb.y + 10); await p.waitForTimeout(120);
      const tip = await tr.locator('.chart-tip').textContent({ timeout: 1500 }).catch(() => null);
      return (tip && tip.includes('브랜드스토어')) || `tip ${tip}`;
    });
    await check('board: 시간대 × 요일 — 지표 · 매체 선택 · 셀 호버 값 · 막대 툴팁', async () => {
      await p.click('#board-tabs [role=tab]:has-text("시간대")'); await p.waitForTimeout(150);
      const hc = cardOf(p, '시간대 × 요일');
      const cell = hc.locator('.board-heat-grid tbody tr:nth-child(1) td:nth-child(21)');
      await cell.hover(); await p.waitForTimeout(60);
      const v1 = await hc.locator('.board-heat-readout').textContent();
      await hc.locator('.seg[aria-label="히트맵 지표"] button:has-text("ROAS")').click();
      await p.selectOption('#board-heat-media', 'meta'); await p.waitForTimeout(80);
      await cell.hover(); await p.waitForTimeout(60);
      const v2 = await hc.locator('.board-heat-readout').textContent();
      if (!(v1.includes('시') && v2.includes('%') && v1 !== v2)) return `readout ${v1} / ${v2}`;
      const bc = cardOf(p, '시간대별 전환 효율 지수');
      await bc.locator('svg g').nth(21).hover(); await p.waitForTimeout(80);
      const tip = await bc.locator('.chart-tip').textContent({ timeout: 1500 }).catch(() => null);
      return (tip && tip.includes('광고비')) || `bar tip ${tip}`;
    });
    await check('board: 지금 확인할 것 → 해당 탭 · 수집 상세 버튼 · Alert 링크', async () => {
      const todo = cardOf(p, '지금 확인할 것').locator('button.icon-btn');
      if ((await todo.count()) < 3) return 'todo items < 3';
      await todo.first().click(); await p.waitForTimeout(80);
      const sel = await p.locator('#board-tabs [aria-selected=true]').textContent();
      if (!sel.includes('예산')) return `first todo opened ${sel}`;
      await p.click('button.board-linkbtn:has-text("수집 · 검증 상세")'); await p.waitForTimeout(100);
      if (!(await p.locator('#board-tabs [aria-selected=true]').textContent()).includes('데이터 수집')) return 'strip button did not open data tab';
      await p.locator('a.btn:has-text("MILDO Alert 열린 이슈")').click(); await p.waitForTimeout(350);
      const hash = await p.evaluate(() => location.hash);
      return hash === '#alert' || `hash ${hash}`;
    });
    await check('board: 상호작용 전체에서 콘솔 오류 없음', async () => noErr(h));
  });

  /* ---------- Board AiInsight · AI 모드별 ---------- */
  const boardAi = async (ai, fn) => withPage({ route: 'board', ai }, async (h, p) => {
    const card = cardOf(p, '기간 성과 해석');
    await card.scrollIntoViewIfNeeded();
    return fn(h, p, card);
  });
  await check('board AI none: 규칙 엔진 브리프 6영역 · 호출 0 · 복사', () => boardAi('none', async (h, p, card) => {
    await card.locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(300);
    const t = await txt(card);
    for (const k of ['확정 팩트', '반복 관측 패턴', 'AI 해석', '전제 조건', '반례', '다음 액션']) if (!t.includes(k)) return `missing ${k}`;
    if ((await h.calls()).length) return 'AI called in none mode';
    await card.locator('button:has-text("복사")').click(); await p.waitForTimeout(150);
    return (await clip(p)).startsWith('### 확정 팩트') || 'clipboard mismatch';
  }));
  await check('board AI artifact: 스트리밍 완료 텍스트 · AI 태그 · cache:false', () => boardAi('artifact', async (h, p, card) => {
    await card.locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(1200);
    const t = await txt(card);
    const c = await h.calls();
    if (c.length !== 1) return `calls ${c.length}`;
    if (c[0].cache !== false) return `cache ${c[0].cache}`;
    if (!t.includes('모의 액션')) return 'stream not finished with full text';
    return (await card.locator('.src').allTextContents()).some((s) => s.includes('AI')) || 'no AI tag';
  }));
  for (const [ai, msg] of [['denied', '허용되지 않았습니다'], ['rate', '요청이 많습니다']]) {
    await check(`board AI ${ai}: 한글 안내 · 규칙 엔진 대체 · 자동 재시도 없음 · 버튼 유지`, () => boardAi(ai, async (h, p, card) => {
      await card.locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(900);
      const t = await txt(card);
      if (!t.includes(msg)) return 'no Korean message';
      if (!t.includes('확정 팩트') || !t.includes('다음 액션')) return 'no rule fallback';
      await p.waitForTimeout(2000);
      if ((await h.calls()).length !== 1) return `calls grew to ${(await h.calls()).length}`;
      return (await card.locator('button:has-text("다시 생성")').isEnabled()) || 'button not usable';
    }));
  }
  await check('board AI error-mid: 부분 텍스트 유지 · 재시도 안내', () => boardAi('error-mid', async (h, p, card) => {
    await card.locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(900);
    const t = await txt(card);
    return (t.includes('모의 응답') && t.includes('다시 시도하세요') && (await h.calls()).length === 1) || `text ${t.slice(-80)}`;
  }));
  await check('board AI slow: 중지 → 취소 (오류 안내 없음 · 부분 유지)', () => boardAi('slow', async (h, p, card) => {
    await card.locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(1800);
    await card.locator('button:has-text("중지")').click(); await p.waitForTimeout(2200);
    const t = await txt(card);
    if (t.includes('오류') || t.includes('중지했습니다')) return 'cancel shown as error';
    if (t.includes('모의 액션')) return 'not cancelled';
    return (await card.locator('button:has-text("다시 생성"), button:has-text("기간 성과 해석")').count()) > 0 || 'button not restored';
  }));
  await check('board AI unavailable: 규칙 엔진 · 호출 0', () => boardAi('unavailable', async (h, p, card) => {
    await card.locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(400);
    return ((await txt(card)).includes('확정 팩트') && (await h.calls()).length === 0) || 'unexpected';
  }));
  await check('board 다운로드 ai:none → 브라우저 다운로드 이벤트', () => withPage({ route: 'board', ai: 'none' }, async (h, p) => {
    await p.click('#board-tabs [role=tab]:has-text("02 키워드")'); await p.waitForTimeout(150);
    await p.locator('button:has-text("CSV 내보내기")').click(); await p.waitForTimeout(500);
    return (h.downloads.some((f) => /\.csv$/.test(f))) || `downloads ${h.downloads}`;
  }));
  await check('board 다운로드 decline → 오류 상태 · 크래시 없음', () => withPage({ route: 'board', ai: 'artifact', downloads: 'decline' }, async (h, p) => {
    await p.click('#board-tabs [role=tab]:has-text("02 키워드")'); await p.waitForTimeout(150);
    await p.locator('button:has-text("CSV 내보내기")').click(); await p.waitForTimeout(500);
    if (!(await p.locator('button:has-text("CSV 내보내기")').isEnabled())) return 'button disabled';
    return noErr(h);
  }));

  /* ======================= 리포트 · 데이터 시간표 ======================= */
  await withPage({ route: 'reports', ai: 'artifact' }, async (h, p) => {
    const doc = p.locator('.reports-doc');
    await check('reports: 로드 · 3개 탭 순회 시 AI 호출 0 · 오류 없음', async () => {
      for (const t of ['데이터 제공', '절감 실측', '리포트 4종']) { await p.click(`#reports-tabs [role=tab]:has-text("${t}")`); await p.waitForTimeout(150); }
      if ((await h.calls()).length) return 'AI called without click';
      return noErr(h);
    });
    await check('reports: 리포트 4종 생성 (발송 현황 버튼 · 섹션 · 메신저)', async () => {
      const titles = [];
      for (let i = 0; i < 4; i++) {
        await p.locator('.reports-cad').nth(i).click(); await p.waitForTimeout(150);
        const secs = await doc.locator('.reports-section').count();
        if (secs < 4) return `type ${i} sections ${secs}`;
        if (!(await p.locator('.reports-bubble').textContent()).includes('[MILDO')) return `type ${i} messenger missing`;
        titles.push(await doc.locator('.reports-doc-title').textContent());
      }
      return (titles[0].includes('일간') && titles[1].includes('주간') && titles[2].includes('월간') && titles[3].includes('이슈')) || titles.join('|');
    });
    await check('reports: 월간 대상 월 · 이슈 알림 대상 이슈 선택', async () => {
      await p.locator('.reports-cad').nth(2).click(); await p.waitForTimeout(120);
      await p.selectOption('#reports-month', '2026-09'); await p.waitForTimeout(120);
      const sep = await doc.locator('.reports-doc-title').textContent();
      if (!sep.includes('9월')) return `month title ${sep}`;
      await p.selectOption('#reports-month', '2026-10');
      await p.locator('.reports-cad').nth(3).click(); await p.waitForTimeout(120);
      const opts = await p.$$eval('#reports-issue option', (es) => es.map((e) => e.value));
      if (opts.length < 3) return 'issue options < 3';
      await p.selectOption('#reports-issue', opts[2]); await p.waitForTimeout(120);
      const t2 = await doc.locator('.reports-doc-title').textContent();
      await p.selectOption('#reports-issue', opts[1]); await p.waitForTimeout(120);
      const t1 = await doc.locator('.reports-doc-title').textContent();
      return t1 !== t2 || 'issue selection did not change report';
    });
    await check('reports: AE 초안 → 병합 (더블클릭 1건) · 토스트 · .md에 병합', async () => {
      await p.locator('.reports-cad').nth(0).click(); await p.waitForTimeout(120);
      await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(80);
      const merge = p.locator('button:has-text("리포트에 병합")');
      if (!(await merge.isDisabled())) return 'merge enabled when empty';
      await p.click('button:has-text("규칙 엔진 초안")'); await p.waitForTimeout(60);
      const draft = await p.inputValue('#reports-ae-note');
      if (!draft.startsWith('해석:')) return `draft ${draft.slice(0, 20)}`;
      await p.fill('#reports-ae-note', `${draft}\nE2E-AE-노트`);
      await merge.dblclick(); await p.waitForTimeout(250);
      const n = await doc.locator('.reports-zone.ae .reports-comment').count();
      if (n !== 1) return `ae notes ${n}`;
      if (!(await p.locator('.toast:has-text("AE 코멘트")').count())) return 'no toast';
      const n0 = (await h.saves()).length;
      await p.click('button:has-text(".md 다운로드")'); await p.waitForTimeout(400);
      const s = (await h.saves()).at(-1);
      if ((await h.saves()).length !== n0 + 1 || !/\.md$/.test(s.filename) || !s.head.startsWith('# ')) return `md save ${s && s.filename}`;
      await p.click('button:has-text("문서 복사")'); await p.waitForTimeout(150);
      return (await clip(p)).includes('E2E-AE-노트') || 'md lacks AE note';
    });
    await check('reports: 메신저 문구 복사 = 미리보기 첫 줄', async () => {
      await p.click('button:has-text("메신저 문구 복사")'); await p.waitForTimeout(150);
      const c = await clip(p);
      const bubble = await p.locator('.reports-bubble strong').first().textContent();
      return c.split('\n')[0] === bubble || `clip ${c.split('\n')[0]} vs ${bubble}`;
    });
    await check('reports: 수면밀도 역할 섹션 피드백 (Enter 2회 → 1건) → AE 반영 완료 · 반영 대기 수 (회귀)', async () => {
      await p.selectOption('#role-select', '수면밀도'); await p.waitForTimeout(80);
      if (!(await p.isDisabled('#reports-ae-note'))) return 'AE textarea enabled for client';
      const sec = doc.locator('.reports-section').nth(1);
      await sec.locator('.reports-thread-toggle button').click();
      const inp = sec.locator('.reports-comment-form input');
      await inp.fill('E2E 피드백'); await inp.press('Enter'); await inp.press('Enter'); await p.waitForTimeout(100);
      if ((await sec.locator('.reports-thread .reports-comment').count()) !== 1) return 'duplicate feedback';
      if (!(await sec.locator('.reports-thread').textContent()).includes('반영 대기')) return 'no 반영 대기';
      if (await sec.locator('.reports-thread button:has-text("반영 완료")').count()) return 'client can resolve';
      await p.selectOption('#role-select', '담당 AE'); await p.waitForTimeout(80);
      await sec.locator('.reports-comment-form input').fill('E2E AE 답변');
      await sec.locator('.reports-comment-form button:has-text("등록")').click(); await p.waitForTimeout(80);
      const lbl = await sec.locator('.reports-thread-toggle button').textContent();
      if (!lbl.includes('반영 대기 1')) return `pending label counts AE comment: ${lbl}`;
      await sec.locator('.reports-thread button:has-text("반영 완료")').click(); await p.waitForTimeout(100);
      if ((await sec.locator('.reports-thread-toggle button').textContent()).includes('반영 대기')) return 'still pending after resolve';
      const sub = await cardOf(p, '코멘트 단위 피드백').locator('.card-sub').textContent();
      if (!sub.includes('반영 대기 0 · 반영 완료 1')) return `panel ${sub}`;
      await p.click('button:has-text("문서 복사")'); await p.waitForTimeout(150);
      const md = await clip(p);
      if (!md.includes('E2E 피드백 — 수면밀도 담당자 · 반영 완료')) return 'md feedback status';
      return !/E2E AE 답변[^\n]*반영 대기/.test(md) || 'md marks AE comment 반영 대기';
    });
    await check('reports: 코멘트 · 역할이 새로고침 후 유지', async () => {
      await h.reload();
      const sec = p.locator('.reports-doc .reports-section').nth(1);
      const t = await sec.locator('.reports-thread').textContent().catch(() => '');
      if (!t.includes('E2E 피드백') || !t.includes('반영 완료')) return 'feedback lost on reload';
      if ((await p.locator('.reports-doc .reports-zone.ae .reports-comment').count()) !== 1) return 'AE note lost';
      return (await p.inputValue('#role-select')) === '담당 AE' || 'role not persisted';
    });
    await check('reports: 시간표 — 주말 모드 토글 · 기준일 버튼 · 날짜 선택', async () => {
      await p.click('#reports-tabs [role=tab]:has-text("데이터 제공")'); await p.waitForTimeout(150);
      const stats = async () => txt(p.locator('.grid.g-4').first());
      const s0 = await stats();
      if (!s0.includes('15:30') || !s0.includes('4 / 7')) return `today stats ${s0.slice(0, 80)}`;
      await p.fill('#reports-tt-date', '2026-11-02'); await p.waitForTimeout(120);
      if (!(await stats()).includes('평일')) return 'weekday not 평일';
      await p.click('label[for="reports-offhours"]'); await p.waitForTimeout(120);
      const s1 = await stats();
      await p.click('label[for="reports-offhours"]');
      if (!s1.includes('주말 모드')) return `offhours sim not applied ${s1.slice(0, 60)}`;
      await p.locator('button:has-text("공휴일")').first().click(); await p.waitForTimeout(120);
      const moved = await txt(p.locator('.reports-tt-table tbody'));
      await p.locator('button:has-text("오늘")').first().click();
      return moved.includes('→') || 'holiday did not move briefing';
    });
    await check('reports: 절감 — 기존 값 수정 재계산 (두 방식) · 실측 · 음수 오류 · 0분 판정 불가 · 이중 부호 없음', async () => {
      await p.click('#reports-tabs [role=tab]:has-text("절감 실측")'); await p.waitForTimeout(150);
      const head = async () => txt(p.locator('.reports-sv-head'));
      if (!(await head()).includes('1,070분 → 435분')) return 'default totals';
      await p.fill('#reports-sv-before-0', '600'); await p.waitForTimeout(100);
      if (!(await head()).includes('1,370분 → 525분')) return `ratio recalc ${(await head()).slice(0, 60)}`;
      await p.click('.seg[aria-label="재계산 방식"] button:has-text("고정")'); await p.waitForTimeout(100);
      if (!(await head()).includes('1,370분 → 435분')) return `fixed recalc ${(await head()).slice(0, 60)}`;
      await p.click('.seg[aria-label="재계산 방식"] button:has-text("유지")');
      await p.fill('#reports-sv-before-0', '-5'); await p.waitForTimeout(80);
      if ((await p.getAttribute('#reports-sv-before-0', 'aria-invalid')) !== 'true' || !(await p.locator('.reports-input-err').count())) return 'negative not flagged';
      await p.locator('#reports-sv-before-0').blur();
      await p.click('button:has-text("제안서 기본값")'); await p.waitForTimeout(80);
      await p.fill('#reports-sv-measured-0', '400'); await p.waitForTimeout(80);
      const r0 = await txt(p.locator('.reports-sv-table tbody tr').first());
      if (/−-/.test(r0) || !r0.includes('증가')) return `measured > before: ${r0.slice(-60)}`;
      await p.fill('#reports-sv-measured-0', '60'); await p.waitForTimeout(80);
      if (!(await txt(p.locator('.reports-sv-table tfoot'))).includes('목표 달성')) return 'measured verdict missing';
      for (let i = 0; i < 5; i++) await p.fill(`#reports-sv-before-${i}`, '0');
      await p.waitForTimeout(100);
      const z = await head();
      await p.click('button:has-text("제안서 기본값")');
      return (z.includes('판정 불가') && !z.includes('−0%')) || `zero ${z.slice(0, 80)}`;
    });
    await check('reports: 재투입 비중 정규화 · 기본 비율 · Kick-off 날짜 변경 → 90일 단계', async () => {
      await p.fill('#reports-sv-share-keyword', '100'); await p.waitForTimeout(80);
      const t = await txt(cardOf(p, '절감 시간 재투입 계획').locator('tbody'));
      if (!t.includes('정규화')) return 'no normalization note';
      await p.click('button:has-text("기본 비율")'); await p.waitForTimeout(80);
      if ((await p.inputValue('#reports-sv-share-keyword')) !== '40') return 'share reset';
      const ph0 = await txt(p.locator('.reports-phase').first());
      await p.fill('#reports-kickoff', '2026-08-01'); await p.waitForTimeout(100);
      const ph1 = await txt(p.locator('.reports-phase').first());
      await p.fill('#reports-kickoff', '2026-12-01');
      return (ph0 !== ph1 && ph1.includes('완료')) || `phase ${ph1.slice(0, 40)}`;
    });
    await check('reports: 시연 상태 초기화(2단계) → 코멘트 삭제', async () => {
      await p.click('#reports-tabs [role=tab]:has-text("리포트 4종")'); await p.waitForTimeout(100);
      await p.click('button:has-text("설정")'); await p.waitForTimeout(150);
      await p.click('button:has-text("시연 상태 초기화")'); await p.waitForTimeout(80);
      await p.click('button:has-text("정말 초기화")'); await p.waitForTimeout(400);
      const n = await p.evaluate(() => JSON.parse(localStorage.getItem('mildo-os/v1')).comments.length);
      return (n === 0 && (await p.locator('.reports-doc .reports-zone.ae .reports-comment').count()) === 0) || `comments ${n}`;
    });
    await check('reports: 상호작용 전체에서 콘솔 오류 없음', async () => noErr(h));
  });

  /* ---------- Reports AI 해석 · 모드별 ---------- */
  const repAi = async (ai, fn) => withPage({ route: 'reports', ai }, async (h, p) => fn(h, p, p.locator('.reports-zone.ai')));
  await check('reports AI none: 규칙 엔진 해석 · 호출 0 · .md 포함', () => repAi('none', async (h, p, z) => {
    await z.locator('button:has-text("규칙 엔진 해석 추가")').click(); await p.waitForTimeout(200);
    const t = await txt(z);
    if (!t.includes('규칙 엔진 해석') || !t.includes('전제 조건') || !t.includes('다음 액션')) return 'rule content incomplete';
    await p.click('button:has-text("문서 복사")'); await p.waitForTimeout(150);
    return ((await clip(p)).includes('## AI 해석') && (await h.calls()).length === 0) || 'md / calls';
  }));
  await check('reports AI artifact: 완료 텍스트 · AI 태그 · cache:false · 더블클릭이 중지되지 않음 (회귀)', () => repAi('artifact', async (h, p, z) => {
    await z.locator('button:has-text("AI 해석 추가")').dblclick(); await p.waitForTimeout(1300);
    const c = await h.calls();
    if (c.length !== 1 || c[0].cache !== false) return `calls ${JSON.stringify(c.map((x) => x.cache))}`;
    if (!(await txt(z)).includes('모의 액션')) return 'not completed (double-click cancelled?)';
    return (await z.locator('.src').count()) > 0 || 'no AI tag';
  }));
  for (const [ai, msg] of [['denied', '허용되지 않았습니다'], ['rate', '요청이 많습니다'], ['error-mid', '다시 시도하세요']]) {
    await check(`reports AI ${ai}: 한글 안내 · 대체/부분 유지 · 자동 재시도 없음 · 비우기 시 안내 제거`, () => repAi(ai, async (h, p, z) => {
      await z.locator('button:has-text("AI 해석 추가")').click(); await p.waitForTimeout(900);
      const t = await txt(z);
      if (!t.includes(msg)) return 'no Korean message';
      if (ai === 'error-mid' ? !t.includes('모의 응답') : !t.includes('다음 액션')) return 'no fallback/partial';
      await p.waitForTimeout(1800);
      if ((await h.calls()).length !== 1) return `calls ${(await h.calls()).length}`;
      await z.locator('button:has-text("해석 영역 비우기")').click(); await p.waitForTimeout(80);
      return !(await txt(z)).includes(msg) || 'note persists after clear';
    }));
  }
  await check('reports AI slow: 중지 → 오류 안내 없이 취소 · 재생성 중지 시 직전 해석 유지', () => repAi('slow', async (h, p, z) => {
    await z.locator('button:has-text("AI 해석 추가")').click(); await p.waitForTimeout(1800);
    await z.locator('button:has-text("중지")').click(); await p.waitForTimeout(2000);
    const t = await txt(z);
    if (t.includes('모의 액션') || t.includes('오류')) return 'not cancelled / error shown';
    if (!t.includes('모의 응답')) return 'partial lost';
    await z.locator('button:has-text("해석 다시 생성")').click(); await p.waitForTimeout(300);
    await z.locator('button:has-text("중지")').click(); await p.waitForTimeout(1800);
    return (await txt(z)).includes('모의 응답') || 'previous interpretation wiped';
  }));
  await check('reports 다운로드 ai:none → 4종 .md 브라우저 다운로드', () => withPage({ route: 'reports', ai: 'none' }, async (h, p) => {
    for (let i = 0; i < 4; i++) { await p.locator('.reports-cad').nth(i).click(); await p.waitForTimeout(120); await p.click('button:has-text(".md 다운로드")'); await p.waitForTimeout(400); }
    return h.downloads.filter((f) => /^MILDO_(daily|weekly|monthly|issue)_report_.*\.md$/.test(f)).length === 4 || `downloads ${h.downloads}`;
  }));
  await check('reports 다운로드 decline → 오류 상태 · 크래시 없음', () => withPage({ route: 'reports', ai: 'artifact', downloads: 'decline' }, async (h, p) => {
    await p.click('button:has-text(".md 다운로드")'); await p.waitForTimeout(500);
    return noErr(h);
  }));

  /* ---------- 모듈 간 흐름 · 링크 ---------- */
  await check('cross: MILDO Alert 인지 → 이슈 알림 리포트 상태 반영', () => withPage({ route: 'alert', ai: 'artifact' }, async (h, p) => {
    await h.dismissToasts();
    const row = p.locator('table.tbl tbody tr:has-text("카카오 전환 추적")').first();
    if (await row.count()) await row.click(); else await p.locator('button.row:has-text("카카오 전환 추적")').first().click();
    await p.waitForTimeout(250);
    await p.locator('.drawer button:has-text("인지")').click(); await p.waitForTimeout(150);
    await p.keyboard.press('Escape');
    await go(p, '#reports');
    await p.locator('.reports-cad').nth(3).click(); await p.waitForTimeout(150);
    const first = await txt(p.locator('.reports-doc .reports-section').first().locator('tbody tr').first());
    return (first.includes('카카오') && first.includes('인지')) || `row ${first.slice(0, 80)}`;
  }));
  await check('cross: Board · Reports 화면 링크가 모두 실제 화면으로 이동', () => withPage({ route: 'board', ai: 'artifact' }, async (h, p) => {
    const hrefs = new Set();
    const collect = async () => (await p.locator('.page a[href^="#"]').evaluateAll((es) => es.map((e) => e.getAttribute('href')))).forEach((x) => hrefs.add(x));
    const n = await p.locator('#board-tabs [role=tab]').count();
    for (let i = 0; i < n; i++) { await p.locator('#board-tabs [role=tab]').nth(i).click(); await p.waitForTimeout(100); await collect(); }
    await go(p, '#reports');
    for (let i = 0; i < 4; i++) { await p.locator('.reports-cad').nth(i).click(); await p.waitForTimeout(80); await collect(); }
    for (const t of ['데이터 제공', '절감 실측']) { await p.click(`#reports-tabs [role=tab]:has-text("${t}")`); await p.waitForTimeout(100); await collect(); }
    const bad = [];
    for (const href of hrefs) {
      await go(p, href);
      const title = await p.title();
      if (!title || title.startsWith('커맨드 센터') && href !== '#home') bad.push(`${href}->${title}`);
    }
    if (hrefs.size < 8) return `only ${hrefs.size} links`;
    return bad.length === 0 ? noErr(h) : bad.join(', ');
  }));

  /* ======================= 세션 2 추가 점검 ======================= */
  const bad = (s) => /NaN|undefined|Infinity|\[object/.test(s);
  const numOf = (s) => {
    if (s == null) return NaN;
    const t = s.replace(/\s+/g, ' ').trim();
    const tm = t.match(/^(\d{1,2}):(\d{2})/); if (tm) return Number(tm[1]) + Number(tm[2]) / 60;
    const m = t.match(/([−-]?\d[\d,]*(?:\.\d+)?)(억|만)?/);
    if (!m) return NaN;
    return Number(m[1].replace(/,/g, '').replace('−', '-')) * (m[2] === '억' ? 1e8 : m[2] === '만' ? 1e4 : 1);
  };
  await withPage({ route: 'board', ai: 'artifact' }, async (h, p) => {
    await check('board: 모든 표 · 모든 정렬 열 내림 ↔ 오름 순서 (숫자 열 단조)', async () => {
      // 범주형 정렬 열(판정 · 신호 · 텍스트)은 순서 키가 숫자 표기와 다르므로 숫자 단조 검사에서 제외 (unit test에서 정렬 키 검증)
      const CATEGORICAL = /판정|신호|매체|키워드|구매 의도|캠페인|판매 채널|원천|최근 수집|예상 마감|가이드|직전 대비 변동|역할/;
      const issues = []; let cols = 0;
      for (let ti = 0; ti < 6; ti++) {
        await p.locator('#board-tabs [role=tab]').nth(ti).click(); await p.waitForTimeout(150);
        const tables = p.locator('.page table.tbl');
        for (let k = 0; k < await tables.count(); k++) {
          const t = tables.nth(k); if (!(await t.isVisible())) continue;
          const ths = t.locator('thead th');
          for (let ci = 0; ci < await ths.count(); ci++) {
            const th = ths.nth(ci);
            if (!((await th.getAttribute('class')) || '').includes('sortable')) continue;
            const name = (await th.textContent()).replace(/[↑↓]/g, '').trim();
            for (let pass = 0; pass < 2; pass++) {
              await th.click(); await p.waitForTimeout(40);
              const dir = await th.getAttribute('aria-sort');
              if (dir !== (pass === 0 ? 'descending' : 'ascending')) { issues.push(`${name} aria-sort ${dir}`); continue; }
              cols++;
              if (CATEGORICAL.test(name)) continue;
              const v = (await t.locator(`tbody tr > td:nth-child(${ci + 1})`).allInnerTexts()).map((x) => numOf(x.split('\n')[0])).filter(Number.isFinite);
              for (let i = 1; i < v.length; i++) if (dir === 'descending' ? v[i] > v[i - 1] + 1e-9 : v[i] < v[i - 1] - 1e-9) { issues.push(`tab${ti} ${name} ${dir}`); break; }
            }
          }
        }
      }
      return (!issues.length && cols >= 60) || `${cols} sorts, issues: ${issues.slice(0, 4).join(', ')}`;
    });
    await check('board: 지금 확인할 것 — 모든 항목이 해당 탭을 연다', async () => {
      await go(p, '#board');
      const items = cardOf(p, '지금 확인할 것').locator('.board-list-item');
      const map = { 예산: '03 예산', 키워드: '02 키워드', 수집: '데이터 수집', 매체: '01 매체' };
      const n = await items.count(); const bad = [];
      for (let i = 0; i < n; i++) {
        const pill = (await items.nth(i).locator('.pill').first().textContent()).trim();
        await items.nth(i).locator('button.icon-btn').click(); await p.waitForTimeout(60);
        if (!(await p.locator('#board-tabs [aria-selected=true]').textContent()).includes(map[pill])) bad.push(pill);
      }
      return (n >= 3 && !bad.length) || `${n} items, wrong: ${bad}`;
    });
    await check('board: 일자별 추이 지표 5종이 각각 다시 그린다 (NaN 없음)', async () => {
      await p.click('#board-tabs [role=tab]:has-text("01 매체")'); await p.waitForTimeout(100);
      const tr = cardOf(p, '일자별 추이'); const seen = new Set();
      for (const m of ['광고비', '광고 매출', 'ROAS', 'CPA', '전환']) {
        await tr.locator(`.seg[aria-label="지표"] button:text-is("${m}")`).click(); await p.waitForTimeout(60);
        const d = await tr.locator('svg path').evaluateAll((es) => es.map((e) => e.getAttribute('d')).join('|'));
        if (bad(d)) return `${m} NaN path`;
        seen.add(d);
      }
      return seen.size === 5 || `distinct ${seen.size}`;
    });
    await check('board: 키워드 의도 다중 선택 합집합 · 상태 ON+테스트=전체 · 신호 옵션 전부 · 상단 필터 초기화', async () => {
      await p.click('#board-tabs [role=tab]:has-text("02 키워드")'); await p.waitForTimeout(150);
      const card = cardOf(p, '키워드 성과 필터');
      const count = async () => Number((await card.locator('button:has-text("CSV 내보내기")').textContent()).match(/\((\d+)\)/)[1]);
      const all = await count();
      const chips = card.locator('.board-chips[aria-label="구매 의도"] .board-chip');
      const single = [];
      for (let i = 1; i <= 5; i++) { await chips.nth(i).click(); single.push(await count()); await chips.nth(i).click(); }
      await chips.nth(1).click(); await chips.nth(2).click(); await p.waitForTimeout(40);
      const two = await count();
      await chips.nth(1).click(); await chips.nth(2).click(); await p.waitForTimeout(40);
      if (two !== single[0] + single[1] || single.reduce((a, b) => a + b, 0) !== all || (await chips.nth(0).getAttribute('aria-pressed')) !== 'true') return `intents ${single} two ${two} all ${all}`;
      await card.locator('.seg[aria-label="키워드 상태"] button:has-text("ON")').click(); const on = await count();
      await card.locator('.seg[aria-label="키워드 상태"] button:has-text("테스트")').click(); const test = await count();
      await card.locator('.seg[aria-label="키워드 상태"] button:has-text("전체")').click();
      if (on + test !== all) return `status ${on}+${test}≠${all}`;
      const opts = await p.$$eval('#board-kw-signal option', (es) => es.map((e) => e.value));
      for (const v of opts) {
        await p.selectOption('#board-kw-signal', v); await p.waitForTimeout(40);
        if ((await count()) === 0 && !(await txt(card.locator('table.tbl').first().locator('tbody'))).includes('조건에 맞는 키워드가 없습니다')) return `signal ${v} empty state`;
      }
      await chips.nth(2).click(); await card.locator('.seg[aria-label="키워드 상태"] button:has-text("ON")').click();
      await p.selectOption('#board-kw-signal', 'any'); await p.fill('#board-kw-q', '매트리스'); await p.waitForTimeout(60);
      const btn = card.locator('.board-filters button:has-text("필터 초기화")');
      if ((await btn.count()) !== 1) return 'top reset button missing when dirty';
      await btn.click(); await p.waitForTimeout(60);
      return ((await count()) === all && (await btn.count()) === 0 && (await p.inputValue('#board-kw-signal')) === 'all') || 'top reset incomplete';
    });
    await check('board: 키워드 집계 창 7일 (통계 · 부제 · CSV · 드로어) · 스파크라인 지표 · 드로어 Escape/X · Lab 링크', async () => {
      const card = cardOf(p, '키워드 성과 필터');
      await card.locator('.seg[aria-label="집계 창"] button').first().click(); await p.waitForTimeout(100);
      if (!(await txt(card.locator('.board-mini-stats'))).includes('광고비 (7일)') || !(await txt(card.locator('.card-sub'))).includes('최근 7일 vs 직전 7일')) return '7-day labels';
      const n0 = (await h.saves()).length;
      await card.locator('button:has-text("CSV 내보내기")').click(); await p.waitForTimeout(300);
      const sv = (await h.saves()).at(-1);
      if ((await h.saves()).length !== n0 + 1 || !sv.head.includes('노출(7일)')) return `7-day csv ${sv && sv.head.slice(0, 60)}`;
      await card.locator('table.tbl').first().locator('tbody tr').first().click(); await p.waitForTimeout(150);
      if (!(await txt(p.locator('.drawer'))).includes('최근 7일 vs 직전 7일')) return 'drawer window';
      await p.keyboard.press('Escape'); await p.waitForTimeout(150);
      if (await p.locator('.drawer').count()) return 'Escape did not close drawer';
      await card.locator('.seg[aria-label="집계 창"] button').nth(1).click();
      const lbl = () => card.locator('table.tbl').first().locator('tbody tr').first().locator('[aria-label*="일별"]').first().getAttribute('aria-label');
      await card.locator('.seg[aria-label="스파크라인 지표"] button:has-text("매출")').click(); await p.waitForTimeout(60);
      const b = await lbl();
      await card.locator('.seg[aria-label="스파크라인 지표"] button:has-text("광고비")').click();
      if (!b.includes('매출')) return `spark ${b}`;
      await card.locator('.seg[aria-label="키워드 상태"] button:has-text("테스트")').click(); await p.waitForTimeout(60);
      await card.locator('table.tbl').first().locator('tbody tr').first().click(); await p.waitForTimeout(150);
      if ((await p.locator('.drawer a[target="_blank"]').count()) !== 1) return 'landing link not _blank';
      await p.locator('.drawer button[aria-label="닫기"]').first().click(); await p.waitForTimeout(150);
      if (await p.locator('.drawer').count()) return 'X did not close drawer';
      await card.locator('table.tbl').first().locator('tbody tr').first().click(); await p.waitForTimeout(150);
      await p.locator('.drawer a.btn:has-text("MILDO Lab")').click(); await p.waitForTimeout(350);
      const hash = await p.evaluate(() => location.hash);
      await go(p, '#board');
      return hash === '#lab' || `hash ${hash}`;
    });
    await check('board: 히트맵 지표 3종 × 매체 7종 모두 렌더 (NaN 없음)', async () => {
      await p.click('#board-tabs [role=tab]:has-text("시간대")'); await p.waitForTimeout(150);
      const hc = cardOf(p, '시간대 × 요일'); const seen = new Set();
      const media = await p.$$eval('#board-heat-media option', (es) => es.map((e) => e.value));
      for (const m of ['광고비', '전환', 'ROAS']) {
        await hc.locator(`.seg[aria-label="히트맵 지표"] button:has-text("${m}")`).click();
        for (const md of media) { await p.selectOption('#board-heat-media', md); await p.waitForTimeout(30); if (bad(await txt(hc))) return `${m}/${md} NaN`; seen.add(await hc.locator('.board-heat-grid tbody').innerHTML()); }
      }
      await p.selectOption('#board-heat-media', 'all');
      return (media.length === 7 && seen.size >= 14) || `combos ${seen.size}`;
    });
    await check('board: 기간 5종 × 탭 6종 화면에 NaN · undefined 없음 · AI 호출 0 · 오류 없음', async () => {
      for (const per of ['어제', '최근 7일', '최근 14일', '최근 30일', '이번 달']) {
        await p.click(`.seg[aria-label="기간 선택"] button:has-text("${per}")`); await p.waitForTimeout(60);
        for (let i = 0; i < 6; i++) { await p.locator('#board-tabs [role=tab]').nth(i).click(); await p.waitForTimeout(60); if (bad(await p.locator('.page').innerText())) return `${per} tab${i}`; }
      }
      await p.click('.seg[aria-label="기간 선택"] button:has-text("최근 7일")');
      if ((await h.calls()).length) return `AI calls ${(await h.calls()).length}`;
      return noErr(h);
    });
  });
  await check('board AI: 기간마다 다른 프롬프트(≤256KiB) · 기간 변경 시 이전 해석 제거 · 다시 생성 = 호출 +1', () => withPage({ route: 'board', ai: 'artifact' }, async (h, p) => {
    await p.evaluate(() => { window.__inputs = []; const d = window.__mockText; window.__mockText = (i) => { window.__inputs.push(i); return `### 확정 팩트\n- 모의\n\n### 다음 액션\n- 모의 액션 ${window.__inputs.length}`; }; });
    for (const per of ['어제', '최근 7일', '최근 14일', '최근 30일', '이번 달']) {
      await p.click(`.seg[aria-label="기간 선택"] button:has-text("${per}")`); await p.waitForTimeout(60);
      await cardOf(p, '기간 성과 해석').locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(500);
    }
    const ins = await p.evaluate(() => window.__inputs);
    const c = await h.calls();
    if (c.length !== 5 || new Set(ins).size !== 5 || c.some((x) => x.inputBytes > 262144 || x.cache !== false)) return `calls ${c.length} distinct ${new Set(ins).size}`;
    await p.click('.seg[aria-label="기간 선택"] button:has-text("어제")'); await p.waitForTimeout(100);
    if ((await txt(cardOf(p, '기간 성과 해석'))).includes('모의 액션')) return 'stale interpretation after period change';
    await cardOf(p, '기간 성과 해석').locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(400);
    await cardOf(p, '기간 성과 해석').locator('button:has-text("다시 생성")').click(); await p.waitForTimeout(400);
    return (await h.calls()).length === 7 || `calls ${(await h.calls()).length}`;
  }));
  await check('board AI: 더블클릭이 방금 시작한 생성을 중지하지 않음 (src/ui/AiInsight.tsx)', () => withPage({ route: 'board', ai: 'artifact' }, async (h, p) => {
    await cardOf(p, '기간 성과 해석').locator('button:has-text("기간 성과 해석")').dblclick(); await p.waitForTimeout(1200);
    return ((await txt(cardOf(p, '기간 성과 해석'))).includes('모의 액션') && (await h.calls()).length === 1) || 'double-click cancelled the run';
  }));
  await check('board AI slow: 생성 중 기간 변경 → 중지 · 새 카드 깨끗 · 오류 없음', () => withPage({ route: 'board', ai: 'slow' }, async (h, p) => {
    await cardOf(p, '기간 성과 해석').locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(1700);
    await p.click('.seg[aria-label="기간 선택"] button:has-text("최근 30일")'); await p.waitForTimeout(3300);
    const t = await txt(cardOf(p, '기간 성과 해석'));
    if (t.includes('모의') || /오류|실패/.test(t) || (await h.calls()).length !== 1) return `card ${t.slice(0, 60)}`;
    return noErr(h);
  }));
  await check('board AI denied: 두 번째 클릭은 재요청 없이 규칙 엔진 (not_granted 재요청 금지)', () => withPage({ route: 'board', ai: 'denied' }, async (h, p) => {
    await cardOf(p, '기간 성과 해석').locator('button:has-text("기간 성과 해석")').click(); await p.waitForTimeout(700);
    await cardOf(p, '기간 성과 해석').locator('button:has-text("다시 생성")').click(); await p.waitForTimeout(700);
    return ((await h.calls()).length === 1 && (await txt(cardOf(p, '기간 성과 해석'))).includes('규칙 엔진')) || `calls ${(await h.calls()).length}`;
  }));
  await check('board 다운로드 downloads:none(아티팩트 저장 불가) → 안내 토스트 · 오류 없음', () => withPage({ route: 'board', ai: 'artifact', downloads: 'none' }, async (h, p) => {
    await p.click('#board-tabs [role=tab]:has-text("02 키워드")'); await p.waitForTimeout(150);
    await p.locator('button:has-text("CSV 내보내기")').click(); await p.waitForTimeout(400);
    if (!(await p.locator('.toast:has-text("파일 저장을 지원하지 않습니다")').count())) return 'no toast';
    return noErr(h);
  }));

  await withPage({ route: 'reports', ai: 'none' }, async (h, p) => {
    const doc = p.locator('.reports-doc'); const cad = (i) => p.locator('.reports-cad').nth(i);
    await check('reports: PM 역할 AE 코멘트 병합 · 피드백 패널 역할 선택 ↔ 상단 역할', async () => {
      await p.selectOption('#role-select', 'PM'); await p.waitForTimeout(50);
      await p.fill('#reports-ae-note', 'E2E PM 노트'); await p.click('button:has-text("리포트에 병합")'); await p.waitForTimeout(100);
      if (!(await txt(doc.locator('.reports-zone.ae'))).includes('E2E PM 노트')) return 'PM note not merged';
      const seg = cardOf(p, '코멘트 단위 피드백').locator('.seg[aria-label="작성 역할"]');
      await seg.locator('button:has-text("수면밀도 담당자")').click(); await p.waitForTimeout(50);
      if ((await p.inputValue('#role-select')) !== '수면밀도' || !(await p.isDisabled('#reports-ae-note'))) return 'panel role → top role';
      await seg.locator('button:has-text("담당 AE")').click(); await p.waitForTimeout(50);
      return (await p.inputValue('#role-select')) === '담당 AE' || 'role back';
    });
    await check('reports: AE 초안은 리포트별 — 일간 초안이 주간 리포트로 넘어가지 않음 (회귀)', async () => {
      await cad(0).click(); await p.waitForTimeout(80);
      await p.click('button:has-text("규칙 엔진 초안")'); await p.waitForTimeout(40);
      const daily = await p.inputValue('#reports-ae-note');
      await cad(1).click(); await p.waitForTimeout(80);
      const weekly = await p.inputValue('#reports-ae-note');
      await cad(0).click(); await p.waitForTimeout(80);
      const back = await p.inputValue('#reports-ae-note');
      await p.fill('#reports-ae-note', '');
      return (daily.startsWith('해석:') && weekly === '' && back === daily) || `weekly="${weekly.slice(0, 30)}" back ok=${back === daily}`;
    });
    await check('reports: 섹션 코멘트 열기/닫기 · 등록 더블클릭 1건 · 피드백 목록 클릭 → 해당 섹션으로 스크롤', async () => {
      await p.selectOption('#role-select', '수면밀도'); await p.waitForTimeout(50);
      const sec = doc.locator('.reports-section').nth(3); const tg = sec.locator('.reports-thread-toggle button');
      await tg.click(); const o1 = await sec.locator('.reports-comment-form').count();
      await tg.click(); const o2 = await sec.locator('.reports-comment-form').count();
      await tg.click();
      await sec.locator('.reports-comment-form input').fill('E2E 섹션4');
      await sec.locator('.reports-comment-form button:has-text("등록")').dblclick(); await p.waitForTimeout(100);
      const n = await sec.locator('.reports-thread .reports-comment').count();
      await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200);
      await cardOf(p, '코멘트 단위 피드백').locator('button.reports-comment:has-text("E2E 섹션4")').click(); await p.waitForTimeout(900);
      const inView = await sec.evaluate((e) => { const r = e.getBoundingClientRect(); return Math.abs(r.top) < 200; });
      return (o1 === 1 && o2 === 0 && n === 1 && inView) || `open ${o1}/${o2} count ${n} inView ${inView}`;
    });
    await check('reports: 코멘트 범위 — 월간은 월별, 이슈는 이슈별, 일간 · 주간과 섞이지 않음', async () => {
      await cad(2).click(); await p.waitForTimeout(100); await p.selectOption('#reports-month', '2026-10'); await p.waitForTimeout(60);
      let sec = doc.locator('.reports-section').nth(0);
      await sec.locator('.reports-thread-toggle button').click();
      await sec.locator('.reports-comment-form input').fill('E2E 10월'); await sec.locator('.reports-comment-form input').press('Enter'); await p.waitForTimeout(60);
      await p.selectOption('#reports-month', '2026-09'); await p.waitForTimeout(100);
      if ((await txt(doc)).includes('E2E 10월')) return 'October feedback leaks into September';
      await p.selectOption('#reports-month', '2026-10'); await p.waitForTimeout(100);
      if (!(await txt(doc)).includes('E2E 10월')) return 'October feedback lost';
      await cad(3).click(); await p.waitForTimeout(100);
      const opts = await p.$$eval('#reports-issue option', (es) => es.map((e) => e.value));
      await p.selectOption('#reports-issue', opts[1]); await p.waitForTimeout(80);
      sec = doc.locator('.reports-section').nth(0);
      await sec.locator('.reports-thread-toggle button').click();
      await sec.locator('.reports-comment-form input').fill('E2E 이슈1'); await sec.locator('.reports-comment-form input').press('Enter'); await p.waitForTimeout(60);
      await p.selectOption('#reports-issue', opts[2]); await p.waitForTimeout(80);
      if ((await txt(doc)).includes('E2E 이슈1')) return 'issue feedback leaks to other issue';
      await cad(1).click(); await p.waitForTimeout(80);
      const wk = await txt(doc);
      await cad(0).click(); await p.waitForTimeout(80);
      const dl = await txt(doc);
      return (!/E2E (10월|이슈1|섹션4)/.test(wk) && dl.includes('E2E 섹션4') && !dl.includes('E2E 10월')) || 'scope leak daily/weekly';
    });
    await check('reports: 열린 피드백 입력칸 · 작성 중 문구가 다른 월 · 리포트로 넘어가지 않음 (회귀: 섹션 id 공유)', async () => {
      await p.selectOption('#role-select', '수면밀도');
      await cad(2).click(); await p.waitForTimeout(80); await p.selectOption('#reports-month', '2026-10'); await p.waitForTimeout(60);
      const sec = doc.locator('.reports-section').nth(0);
      if (!(await sec.locator('.reports-comment-form').count())) await sec.locator('.reports-thread-toggle button').click();
      await sec.locator('.reports-comment-form input').fill('DRAFT-OCT');
      await p.selectOption('#reports-month', '2026-09'); await p.waitForTimeout(100);
      const carried = (await sec.locator('.reports-comment-form').count()) ? await sec.locator('.reports-comment-form input').inputValue() : '';
      await p.selectOption('#reports-month', '2026-10'); await p.waitForTimeout(60);
      await cad(3).click(); await p.waitForTimeout(100);
      const issueOpen = await doc.locator('.reports-section').nth(0).locator('.reports-comment-form').count();
      return (carried !== 'DRAFT-OCT' && issueOpen === 0) || `draft carried="${carried}" issue form open=${issueOpen}`;
    });
    await check('reports: 해석은 리포트별로 유지 · 4종 메신저 복사 · .md 구조 · 주간 메일 · 월간 안건', async () => {
      await p.selectOption('#role-select', '담당 AE');
      await cad(0).click(); await p.waitForTimeout(60);
      await p.locator('.reports-zone.ai button:has-text("규칙 엔진 해석 추가")').click(); await p.waitForTimeout(60);
      const d1 = await txt(p.locator('.reports-zone.ai'));
      await cad(1).click(); await p.waitForTimeout(60);
      if (!(await txt(p.locator('.reports-zone.ai'))).includes('규칙 엔진 해석 추가')) return 'daily interpretation shown in weekly';
      await cad(0).click(); await p.waitForTimeout(60);
      if ((await txt(p.locator('.reports-zone.ai'))) !== d1) return 'daily interpretation lost';
      for (let i = 0; i < 4; i++) {
        await cad(i).click(); await p.waitForTimeout(80);
        await p.click('button:has-text("메신저 문구 복사")'); await p.waitForTimeout(80);
        if ((await clip(p)).split('\n')[0] !== (await p.locator('.reports-bubble strong').first().textContent())) return `messenger ${i}`;
        await p.click('button:has-text("문서 복사")'); await p.waitForTimeout(80);
        const md = await clip(p);
        if (!md.startsWith('# ') || !md.includes('## 확정 팩트') || bad(md)) return `md ${i}`;
        if (i === 1 && !(await p.locator('.reports-mail').count())) return 'weekly mail preview';
        if (i === 2 && !(await txt(p.locator('.reports-side'))).includes('월간 미팅 안건')) return 'monthly agenda';
      }
      return true;
    });
    await check('reports: 모든 월 · 모든 이슈 옵션 · 시간표 · 절감 화면에 NaN/undefined/내부 id 없음', async () => {
      const RX = /NaN|undefined|Infinity|\[object|\b(adpilot|keyword_add|pending|rolled_back)\b|\(lab\b/;
      await cad(2).click(); await p.waitForTimeout(60);
      for (const m of await p.$$eval('#reports-month option', (es) => es.map((e) => e.value))) { await p.selectOption('#reports-month', m); await p.waitForTimeout(60); if (RX.test(await p.locator('.page').innerText())) return `month ${m}`; }
      await cad(3).click(); await p.waitForTimeout(60);
      for (const v of await p.$$eval('#reports-issue option', (es) => es.map((e) => e.value))) { await p.selectOption('#reports-issue', v); await p.waitForTimeout(60); if (RX.test(await p.locator('.page').innerText())) return `issue ${v}`; }
      for (const t of ['데이터 제공', '절감 실측']) { await p.click(`#reports-tabs [role=tab]:has-text("${t}")`); await p.waitForTimeout(100); const s = await p.locator('.page').innerText(); if (RX.test(s)) return `${t}: ${s.match(new RegExp('.{0,30}' + RX.source + '.{0,20}'))[0]}`; }
      return true;
    });
    await check('reports: 시간표 다음 영업일 · 공휴일 · 날짜 극단값/비우기 · 발송 현황 카드가 리포트 탭으로 이동', async () => {
      await p.click('#reports-tabs [role=tab]:has-text("데이터 제공")'); await p.waitForTimeout(100);
      const stats = async () => txt(p.locator('.grid.g-4').first());
      await p.locator('button:has-text("다음 영업일")').click(); await p.waitForTimeout(80);
      if ((await p.inputValue('#reports-tt-date')) !== '2026-11-02' || !(await stats()).includes('평일')) return 'next business day';
      await p.locator('button:has-text("공휴일")').first().click(); await p.waitForTimeout(80);
      if ((await stats()).includes('평일')) return 'holiday shown as 평일';
      for (const v of ['2026-10-30', '2030-01-01']) { await p.fill('#reports-tt-date', v); await p.waitForTimeout(60); if (bad(await p.locator('.page').innerText())) return `date ${v}`; }
      await p.fill('#reports-tt-date', ''); await p.waitForTimeout(60);
      if (!(await p.inputValue('#reports-tt-date'))) return 'cleared date left empty state';
      await p.evaluate(() => { const i = document.querySelector('#reports-tt-date'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '275760-09-13'); i.dispatchEvent(new Event('input', { bubbles: true })); });
      await p.waitForTimeout(100);
      if (h.errors.length) return 'extreme year crashed';
      await p.locator('button:has-text("오늘")').first().click();
      await cad(1).click(); await p.waitForTimeout(100);
      return (await p.locator('#reports-tabs [aria-selected=true]').textContent()).includes('리포트 4종') || 'cadence did not open reports tab';
    });
    await check('reports: 주말 모드 토글이 MILDO Alert와 양방향 공유', async () => {
      await p.click('#reports-tabs [role=tab]:has-text("데이터 제공")'); await p.waitForTimeout(100);
      await p.click('label[for="reports-offhours"]'); await p.waitForTimeout(60);
      await go(p, '#alert');
      const tab = p.locator('[role=tab]:has-text("주말"), [role=tab]:has-text("휴일")'); if (await tab.count()) { await tab.first().click(); await p.waitForTimeout(150); }
      if (!(await p.isChecked('#alert-offhours'))) return 'Alert toggle not on';
      await p.click('label[for="alert-offhours"]'); await p.waitForTimeout(60);
      await go(p, '#reports'); await p.click('#reports-tabs [role=tab]:has-text("데이터 제공")'); await p.waitForTimeout(100);
      return !(await p.isChecked('#reports-offhours')) || 'reports toggle not off after Alert';
    });
    await check('reports: 절감 — 탭 배지 연동 · 절감표 복사 · 상한 10,080분 초과/문자 거부 · 고정 방식 실측 · 비중 0/음수/100 초과 · Kick-off 비우기/당일 (회귀)', async () => {
      await p.click('#reports-tabs [role=tab]:has-text("절감 실측")'); await p.waitForTimeout(120);
      const head = async () => txt(p.locator('.reports-sv-head'));
      const badge = async () => txt(p.locator('#reports-tabs [role=tab]:has-text("절감 실측")'));
      const b0 = await badge(); await p.fill('#reports-sv-before-0', '2000'); await p.waitForTimeout(60);
      if (!b0.includes('−59%') || (await badge()) === b0) return 'badge';
      await p.click('button:has-text("제안서 기본값")'); await p.waitForTimeout(60);
      await p.click('button:has-text("절감표 복사")'); await p.waitForTimeout(80);
      const c = await clip(p);
      if (!c.startsWith('## SA 업무 자동화') || !c.includes('| 업무 |') || !c.includes('1,070')) return 'copy';
      await p.fill('#reports-sv-before-0', '10080'); await p.waitForTimeout(60);
      if (!(await head()).includes('10,850분')) return 'boundary 10,080 not applied';
      await p.fill('#reports-sv-before-0', '1e12'); await p.waitForTimeout(60);
      if ((await p.getAttribute('#reports-sv-before-0', 'aria-invalid')) !== 'true' || !(await head()).includes('10,850분')) return 'huge value applied';
      await p.locator('#reports-sv-before-0').blur(); await p.fill('#reports-sv-before-0', ''); await p.locator('#reports-sv-before-0').type('abc'); await p.locator('#reports-sv-before-0').blur(); await p.waitForTimeout(60);
      if (bad(await p.locator('.page').innerText())) return 'letters NaN';
      await p.click('button:has-text("제안서 기본값")'); await p.waitForTimeout(60);
      await p.click('.seg[aria-label="재계산 방식"] button:has-text("고정")'); await p.waitForTimeout(60);
      await p.fill('#reports-sv-before-2', '500'); await p.fill('#reports-sv-measured-2', '100'); await p.waitForTimeout(60);
      const row = await txt(p.locator('.reports-sv-table tbody tr').nth(2));
      if (!row.includes('390') || !row.includes('목표 달성')) return `fixed measured ${row.slice(-60)}`;
      await p.fill('#reports-sv-measured-2', '-3'); await p.waitForTimeout(40);
      if ((await p.getAttribute('#reports-sv-measured-2', 'aria-invalid')) !== 'true') return 'negative measured not flagged';
      await p.locator('#reports-sv-measured-2').blur();
      await p.click('.seg[aria-label="재계산 방식"] button:has-text("유지")'); await p.click('button:has-text("제안서 기본값")');
      const ids = await p.$$eval('input[id^="reports-sv-share-"]', (es) => es.map((e) => e.id));
      for (const id of ids) await p.fill('#' + id, '0');
      await p.waitForTimeout(60);
      if (!(await txt(cardOf(p, '절감 시간 재투입 계획'))).includes('정규화 33%')) return 'all-zero shares not equal split';
      await p.fill('#' + ids[1], '101'); await p.waitForTimeout(40);
      if ((await p.getAttribute('#' + ids[1], 'aria-invalid')) !== 'true') return 'share >100 not flagged';
      await p.locator('#' + ids[1]).blur(); await p.click('button:has-text("기본 비율")');
      await p.fill('#reports-kickoff', ''); await p.waitForTimeout(60);
      if ((await p.inputValue('#reports-kickoff')) !== '2026-12-01') return 'kickoff cleared not default';
      await p.fill('#reports-kickoff', '2026-10-31'); await p.waitForTimeout(60);
      const pill = await txt(cardOf(p, '자동화 적용 일정').locator('.pill').first());
      await p.fill('#reports-kickoff', '2026-12-01');
      return pill.includes('당일') || `kickoff pill ${pill}`;
    });
    await check('reports 세션2: 콘솔 오류 없음 · AI 호출 0 (ai:none)', async () => ((await h.calls()).length === 0 ? noErr(h) : 'calls'));
  });
  await check('reports AI slow: 생성 중 리포트 전환 → 다른 리포트에 중지 표시 없음 · 생성 중지 · 부분 유지 (회귀)', () => withPage({ route: 'reports', ai: 'slow' }, async (h, p) => {
    const z = () => p.locator('.reports-zone.ai');
    await z().locator('button:has-text("AI 해석 추가")').click(); await p.waitForTimeout(1700);
    await p.locator('.reports-cad').nth(1).click(); await p.waitForTimeout(150);
    const wk = await txt(z());
    if (wk.includes('중지') || wk.includes('작성 중')) return 'weekly shows daily busy state';
    await p.waitForTimeout(3500);
    await p.locator('.reports-cad').nth(0).click(); await p.waitForTimeout(150);
    const dl = await txt(z());
    if (!dl.includes('모의 응답') || dl.includes('모의 액션')) return `daily not aborted/partial lost: ${dl.slice(0, 80)}`;
    await z().locator('button:has-text("해석 다시 생성")').click(); await p.waitForTimeout(300);
    await go(p, '#board'); await p.waitForTimeout(3500);
    return ((await h.calls()).length === 2) ? noErr(h) : `calls ${(await h.calls()).length}`;
  }));
  await check('reports AI unavailable · denied 재클릭: 규칙 엔진 · 재요청 없음', async () => {
    const r1 = await withPage({ route: 'reports', ai: 'unavailable' }, async (h, p) => {
      const z = p.locator('.reports-zone.ai');
      await z.locator('button:has-text("규칙 엔진 해석 추가")').click(); await p.waitForTimeout(200);
      return ((await txt(z)).includes('다음 액션') && (await h.calls()).length === 0) || 'unavailable';
    });
    if (r1 !== true) return r1;
    return withPage({ route: 'reports', ai: 'denied' }, async (h, p) => {
      const z = p.locator('.reports-zone.ai');
      await z.locator('button:has-text("AI 해석 추가")').click(); await p.waitForTimeout(700);
      await z.locator('button:has-text("해석 다시 생성")').click(); await p.waitForTimeout(700);
      return (await h.calls()).length === 1 || `denied re-requested: ${(await h.calls()).length}`;
    });
  });
  await check('reports 다운로드 downloads:none → 안내 토스트 · 오류 없음', () => withPage({ route: 'reports', ai: 'artifact', downloads: 'none' }, async (h, p) => {
    await p.click('button:has-text(".md 다운로드")'); await p.waitForTimeout(400);
    return (await p.locator('.toast:has-text("파일 저장을 지원하지 않습니다")').count()) ? noErr(h) : 'no toast';
  }));
  await check('cross: MILDO Lab 등록 요청(승인 대기) → 시간표 16:30 "승인 대기 n건 (MILDO Lab …)" · 주간 리포트 반영 (회귀: 내부 id)', () => withPage({ route: 'reports', ai: 'none' }, async (h, p) => {
    const row = async () => { await go(p, '#reports'); await p.click('#reports-tabs [role=tab]:has-text("데이터 제공")'); await p.waitForTimeout(120); return txt(p.locator('.reports-tt-table tbody tr:has-text("16:30")').first()); };
    const n = (s) => Number((s.match(/승인 대기 (\d+)건/) || [0, -1])[1]);
    const before = n(await row());
    await go(p, '#lab');
    let clicked = false;
    for (let i = 0; i < await p.locator('[role=tab]').count() && !clicked; i++) {
      await p.locator('[role=tab]').nth(i).click(); await p.waitForTimeout(150);
      const b = p.locator('button:text-is("등록 요청")'); if (await b.count()) { await b.first().click(); clicked = true; }
    }
    const after = await row();
    if (!clicked || n(after) !== before + 1 || !after.includes('MILDO Lab') || /\(lab\b/.test(after)) return `before ${before} after "${after.slice(-120)}"`;
    await p.click('#reports-tabs [role=tab]:has-text("리포트 4종")'); await p.locator('.reports-cad').nth(1).click(); await p.waitForTimeout(120);
    return (await txt(p.locator('.reports-doc'))).includes('Lab 등록 요청') ? noErr(h) : 'weekly report lacks Lab request';
  }));

  await check('reports: AE 병합 토스트 "바로 가기" → 다른 화면에서도 리포트로 이동', () => withPage({ route: 'reports', ai: 'none' }, async (h, p) => {
    await p.fill('#reports-ae-note', 'E2E 토스트'); await p.click('button:has-text("리포트에 병합")'); await p.waitForTimeout(100);
    await go(p, '#board');
    const t = p.locator('.toast:has-text("AE 코멘트")');
    if (!(await t.count())) return 'toast gone';
    await t.locator('button:has-text("바로 가기"), a:has-text("바로 가기")').first().click(); await p.waitForTimeout(400);
    const hash = await p.evaluate(() => location.hash);
    return hash === '#reports' ? noErr(h) : `hash ${hash}`;
  }));

  const pass = results.filter((r) => r[1]).length;
  console.log(`SUMMARY ${pass}/${results.length} PASS${fails ? ` · ${fails} FAIL` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
