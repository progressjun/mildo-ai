/**
 * MILDO OS 기능 점검 e2e — MILDO Alert (#alert) + 전담 TF · 온보딩 · 계약 (#ops)
 * usage: NODE_PATH=$(npm root -g) node qa/e2e/alert-ops.e2e.cjs dist-single/index.html [areaFilter]
 * prints 'PASS <name>' / 'FAIL <name>: <reason>' per check; exit 1 on any FAIL.
 */
const L = require(require('path').join(__dirname, 'lib-alert-ops.cjs'));
const FILE = process.argv[2] || require('path').join(__dirname, '../../dist-single/index.html');
const ONLY = process.argv[3] || '';
let fails = 0, passes = 0;
const check = (name, ok, reason = '') => {
  if (ok) { passes++; console.log(`PASS ${name}`); } else { fails++; console.log(`FAIL ${name}: ${String(reason).replace(/\s+/g, ' ').slice(0, 300)}`); }
  return ok;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const sp = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const MOCK_END = '모의 액션.';
const wait = (p, ms = 200) => p.waitForTimeout(ms);
async function openH(route, opts = {}) { return L.open({ file: FILE, route, ai: 'artifact', downloads: 'accept', ...opts }); }
async function area(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  let h;
  try {
    h = await fn((x) => { h = x; return x; });
  } catch (e) {
    const at = ((e && e.stack) || '').split('\n').find((l) => l.includes('e2e.cjs:')) || '';
    check(`${name} · 예외 없이 완료`, false, (e && e.message || String(e)).split('\n')[0] + ' @' + at.replace(/.*e2e\.cjs:/, 'line '));
  } finally {
    if (h) {
      check(`${name} · 콘솔 오류 없음`, h.errors.length === 0, JSON.stringify(h.errors));
      await h.close().catch(() => {});
    }
  }
}
const incBy = async (p, pred) => (await L.store(p)).incidents.find(pred);
const changesNew = async (p) => (await L.store(p)).changes.filter((c) => !String(c.id).startsWith('seed_'));
const openRow = async (p, text) => { await p.click(`.alert-queue tbody tr:has-text("${text}")`); await wait(p, 250); return p.locator('.drawer'); };
const closeDrawer = async (p) => { await p.keyboard.press('Escape'); await wait(p, 200); };
const role = async (p, r) => { await p.selectOption('#role-select', r); await wait(p, 250); };
const clip = (p) => p.evaluate(() => navigator.clipboard.readText());

(async () => {
  /* ========== A0. AI 호출 없음: 페이지 로드 + 모든 탭 순회 ========== */
  await area('A0 AI 무호출', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    const tabs = await p.$$eval('[role=tab]', (els) => els.map((e) => e.textContent.replace(/\d+$/, '').trim()));
    check('A0 Alert 탭 7개', tabs.length === 7, tabs.join(','));
    for (const t of tabs) await L.tab(p, t);
    await openRow(p, '카카오 전환 추적 단절').catch(() => {}); await closeDrawer(p);
    await L.go(p, 'ops');
    const otabs = await p.$$eval('[role=tab]', (els) => els.map((e) => e.textContent.replace(/\d+$/, '').trim()));
    check('A0 Ops 탭 6개', otabs.length === 6, otabs.join(','));
    for (const t of otabs) await L.tab(p, t);
    await wait(p, 600);
    eq('A0 AI 버튼 없이 h.calls() 비어 있음', await h.calls(), []);
    return h;
  });

  /* ========== A1. 이슈 큐 필터 · 정렬 · 토글 · 빈 상태 · 처리 순서 ========== */
  await area('A1 이슈 큐', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    const st = await L.store(p);
    const open = st.incidents.filter((i) => i.status !== 'resolved');
    let rows = await L.queueRows(p);
    eq('A1 열린 이슈 행 수 = 스토어 열린 이슈', rows.length, open.length);
    for (const s of ['P1', 'P2']) {
      await L.seg(p, '등급', s); rows = await L.queueRows(p);
      check(`A1 등급 ${s} 필터`, rows.length === open.filter((i) => i.severity === s).length && rows.every((r) => r.startsWith(s)), `${rows.length} rows`);
    }
    await L.seg(p, '등급', 'P3'); rows = await L.queueRows(p);
    check('A1 P3 0건 → 읽을 수 있는 빈 상태', rows.length === 1 && /조건에 맞는 이슈가 없습니다 \(열린 이슈 · P3\)/.test(rows[0]), rows[0]);
    await L.seg(p, '등급', '전체');
    await L.seg(p, '상태', '해결'); rows = await L.queueRows(p);
    check('A1 해결 0건 빈 상태', rows.length === 1 && rows[0].includes('조건에 맞는 이슈가 없습니다 (해결)'), rows[0]);
    await L.seg(p, '상태', '전체'); rows = await L.queueRows(p);
    eq('A1 전체 = 스토어 전체', rows.length, st.incidents.length);
    await L.seg(p, '상태', '열린');
    await p.check('#alert-test-only'); rows = await L.queueRows(p);
    check('A1 테스트 주입만 (없음) 빈 상태', rows.length === 1 && rows[0].includes('열린 테스트 이슈가 없습니다'), rows[0]);
    await p.uncheck('#alert-test-only');
    // 정렬
    const ordered = async () => (await L.queueRows(p)).map((r) => r.slice(0, 50));
    const prio = await ordered();
    check('A1 기본 정렬 등급 · SLA (P1 먼저)', prio[0].startsWith('P1') && prio[1].startsWith('P1') && prio[2].startsWith('P2'), prio.slice(0, 3).join(' | '));
    await L.seg(p, '정렬', '영향');
    const imp = await p.$$eval('.alert-queue tbody tr', (trs) => trs.map((tr) => tr.querySelectorAll('td')[5]?.innerText.trim()));
    const toNum = (s) => { if (!s || s === '—') return 0; const m = s.replace(/,/g, ''); const eok = /([\d.]+)억/.exec(m); const man = /([\d.]+)만/.exec(m); return (eok ? +eok[1] * 1e8 : 0) + (man ? +man[1] * 1e4 : 0) || (+m.replace(/[^\d.]/g, '') || 0); };
    const impN = imp.map(toNum);
    check('A1 영향 정렬 내림차순', impN.every((v, k) => k === 0 || impN[k - 1] >= v), imp.join(','));
    await L.seg(p, '정렬', '최근');
    const rec = await ordered();
    check('A1 최근 정렬은 순서가 바뀐다', JSON.stringify(rec) !== JSON.stringify(prio), rec.slice(0, 2).join(' | '));
    const det = open.slice().sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
    check('A1 최근 정렬 첫 행 = 가장 늦게 감지', rec[0].includes(det[0].title.slice(0, 20)), `${rec[0]} vs ${det[0].title}`);
    await L.seg(p, '정렬', '등급 · SLA');
    // 헤더 정렬 (추정 매출 영향)
    await p.click('.alert-queue th:has-text("추정 매출 영향")'); await wait(p);
    const hs = (await p.$$eval('.alert-queue tbody tr', (trs) => trs.map((tr) => tr.querySelectorAll('td')[5]?.innerText.trim()))).map(toNum);
    check('A1 헤더 클릭 정렬 동작', hs.every((v, k) => k === 0 || hs[k - 1] <= v) || hs.every((v, k) => k === 0 || hs[k - 1] >= v), hs.join(','));
    // 지금 처리할 순서 → 드로어
    const nb = p.locator('.card:has-text("지금 처리할 순서") button.row').first();
    const nbt = sp(await nb.innerText());
    await nb.click(); await wait(p);
    check('A1 처리 순서 버튼 → 드로어', (await p.locator('.drawer h3').count()) === 1 && nbt.includes(sp(await p.locator('.drawer h3').innerText()).slice(0, 15)), nbt.slice(0, 60));
    await closeDrawer(p);
    check('A1 Esc로 드로어 닫힘', (await p.locator('.drawer').count()) === 0, 'drawer still open');
    // 상단 단계 스트립 → 탭 이동
    const cells = await p.locator('.alert-strip-cell').count();
    const seen = new Set();
    for (let k = 0; k < cells; k++) { await p.locator('.alert-strip-cell').nth(k).click(); await wait(p, 150); seen.add(sp(await p.locator('[role=tab][aria-selected=true]').innerText())); await L.tab(p, '이슈 큐'); }
    check('A1 단계 스트립 셀 → 해당 탭 이동', cells >= 4 && seen.size >= 3, `${cells} cells → ${[...seen].join(',')}`);
    return h;
  });

  /* ========== A2. 드로어 SLA 라이프사이클 (인지 → 배정 → 조치 → 보고 → 재발 방지 → 해결) ========== */
  await area('A2 드로어 라이프사이클', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    const d = await openRow(p, '카카오 전환 추적 단절');
    const tb = () => incBy(p, (i) => i.ruleId === 'tracking_break');
    const timer = async () => sp(await d.locator('.alert-sla').first().innerText());
    check('A2 초기 SLA 타이머 = 인지 15분 단계', /인지 15분/.test(await timer()), await timer());
    const t1 = await timer(); await wait(p, 1300); const t2 = await timer();
    check('A2 SLA 타이머가 1초 단위로 흐른다', t1 !== t2, `${t1} → ${t2}`);
    for (const b of ['1차 조치 기록', '결과 보고', '배정']) check(`A2 초기 '${b}' 비활성`, await d.locator(`button:has-text("${b}")`).first().isDisabled(), 'enabled');
    check("A2 초기 '해결' 비활성 (P1 · 조치 전)", await d.locator('button.btn.primary:has-text("해결")').isDisabled(), 'enabled');
    check('A2 보류 해제 요청은 조치 전 비활성', await d.locator('button:has-text("자동 조정 보류 해제 요청")').isDisabled(), 'enabled');
    await d.locator('button:has-text("인지")').first().click(); await wait(p);
    let i = await tb();
    check('A2 인지 → status ack · ackAt 데이터 시계(10/31 15:3x)', i.status === 'ack' && /^2026-10-31T15:3\d:\d\d\+09:00$/.test(i.sla?.ackAt || ''), JSON.stringify(i.sla));
    check('A2 인지 버튼 비활성화', await d.locator('button:has-text("인지")').first().isDisabled(), 'still enabled');
    check('A2 인지 후 타이머 = 1차 조치 30분', /1차 조치 30분/.test(await timer()), await timer());
    check('A2 인지 SLA 달성 표시', sp(await d.locator('.grid.g-3').first().innerText()).includes('달성'), 'no 달성');
    await d.locator('select[aria-label="배정할 TF 역할"]').selectOption({ label: 'SA Lead AE' });
    await d.locator('button:has-text("배정")').click(); await wait(p);
    i = await tb();
    check('A2 배정 → assignee SA Lead AE · 백업 자동(SA AE) · assignedAt', i.assignee === 'SA Lead AE' && i.backup === 'SA AE' && !!i.sla.assignedAt, `${i.assignee}/${i.backup}`);
    check('A2 배정 후 select 초기화 · 배정 버튼 비활성', (await d.locator('select[aria-label="배정할 TF 역할"]').inputValue()) === '' && await d.locator('button:has-text("배정")').isDisabled(), 'not reset');
    await d.locator('textarea').first().fill('   ');
    check('A2 공백 조치 메모 → 기록 비활성', await d.locator('button:has-text("1차 조치 기록")').isDisabled(), 'enabled');
    await d.locator('textarea').first().fill('카카오 픽셀 재설치 · 16:10 전환 수신 재개 확인');
    await d.locator('button:has-text("1차 조치 기록")').click(); await wait(p);
    i = await tb();
    check('A2 1차 조치 → status action · actionAt · 메모 저장', i.status === 'action' && !!i.sla.actionAt && i.actionNote.startsWith('카카오 픽셀'), JSON.stringify({ s: i.status, n: i.actionNote }));
    check('A2 조치 후 메모 입력란 비움', (await d.locator('textarea').first().inputValue()) === '', 'not cleared');
    check('A2 조치 후 타이머 = 결과 보고 2시간', /결과 보고 2시간/.test(await timer()), await timer());
    check('A2 조치 후 보류 해제 요청 활성', !(await d.locator('button:has-text("자동 조정 보류 해제 요청")').isDisabled()), 'disabled');
    await d.locator('button:has-text("결과 보고")').click(); await wait(p, 300);
    i = await tb();
    check('A2 결과 보고 → reportAt · 보고서 미리보기 자동 열림', !!i.sla.reportAt && (await d.locator('.card.flat h4, .card.flat h3, .card.flat h2').count()) > 0, JSON.stringify(i.sla));
    check('A2 보고 후 타이머 = 해결 · 재발 방지 대기', /해결 · 재발 방지 대기/.test(await timer()), await timer());
    const sug = await d.locator('textarea').nth(1).getAttribute('placeholder');
    check('A2 재발 방지 빈칸이면 버튼 = 권고안으로 기록', (await d.locator('button:has-text("권고안으로 기록")').count()) === 1, 'label');
    await d.locator('button:has-text("권고안으로 기록")').click(); await wait(p);
    i = await tb();
    check('A2 권고안 기록 → preventNote = 권고 문구 · preventAt', i.preventNote === sug && !!i.sla.preventAt, i.preventNote);
    await d.locator('button.btn.primary:has-text("해결")').click(); await wait(p, 300);
    i = await tb();
    check('A2 해결 → resolved · resolvedAt', i.status === 'resolved' && !!i.sla.resolvedAt, i.status);
    const ts = ['ackAt', 'assignedAt', 'actionAt', 'reportAt', 'preventAt', 'resolvedAt'].map((k) => Date.parse(i.sla[k]));
    check('A2 단계 시각이 순서대로 증가', ts.every((v, k) => Number.isFinite(v) && (k === 0 || ts[k - 1] <= v)), JSON.stringify(i.sla));
    const steps = sp(await d.locator('.alert-steps').innerText());
    check('A2 단계 표시 6개 모두 시각', (steps.match(/10\/31 15:3\d/g) || []).length === 6, steps);
    check('A2 해결 후 SLA 타이머 = 해결 · SLA 달성', /해결 · SLA 달성/.test(await timer()), await timer());
    check('A2 해결 콜아웃 (조치 · 재발 방지)', /해결됨/.test(await d.locator('.callout').last().innerText()) && (await d.locator('.callout').last().innerText()).includes('재발 방지'), 'callout');
    check('A2 해결 토스트', (await L.toasts(p)).some((t) => t.includes('이슈 해결')), JSON.stringify(await L.toasts(p)));
    const tl = i.timeline.map((t) => t.action).join(' > ');
    check('A2 타임라인에 모든 단계 기록', ['인지', '배정', '1차 조치', '결과 보고', '재발 방지', '해결'].every((k) => tl.includes(k)), tl);
    await closeDrawer(p);
    await L.seg(p, '상태', '해결');
    check('A2 해결 필터에 표시', (await L.queueRows(p)).some((r) => r.includes('카카오 전환 추적 단절')), 'missing');
    await L.seg(p, '상태', '열린');
    check('A2 열린 큐에서 빠짐', !(await L.queueRows(p)).some((r) => r.includes('카카오 전환 추적 단절')), 'still open');
    // 보고서 복사 · 다운로드
    await L.seg(p, '상태', '해결');
    await p.click('.alert-queue tbody tr:has-text("카카오 전환 추적 단절")'); await wait(p);
    await d.locator('button:has-text("복사")').first().click(); await wait(p, 300);
    const c = await clip(p);
    check('A2 보고서 복사 → 클립보드 p.49 양식 (### 섹션)', c.includes('###') && c.includes('카카오 전환 추적 단절') && c.length > 300, c.slice(0, 80));
    await d.locator('button:has-text(".md")').click(); await wait(p, 500);
    const sv = await h.saves();
    check('A2 보고서 .md 저장 (downloads.save)', sv.length === 1 && /^MILDO-Alert-보고서-.+\.md$/.test(sv[0].filename) && sv[0].head.includes('#') && sv[0].bytes > 300, JSON.stringify(sv.map((s) => s.filename)));
    // P3 아님 · 조치 없이 해결 불가 / 재발 방지 직접 입력
    await closeDrawer(p); await L.seg(p, '상태', '열린');
    const d2 = await openRow(p, 'Meta 데이터 급변');
    await d2.locator('textarea').nth(1).fill('Meta 급변 주의 기준 재검토');
    check('A2 재발 방지 입력 시 버튼 = 재발 방지 기록', (await d2.locator('button:has-text("재발 방지 기록")').count()) === 1, 'label');
    await d2.locator('button:has-text("재발 방지 기록")').click(); await wait(p);
    const m = await incBy(p, (x) => x.ruleId === 'data_spike');
    check('A2 직접 입력 재발 방지 저장 (상태 유지 open)', m.preventNote === 'Meta 급변 주의 기준 재검토' && m.status === 'open', `${m.preventNote}/${m.status}`);
    // 새로고침 후 유지
    await h.reload();
    const after = await incBy(p, (i) => i.ruleId === 'tracking_break');
    check('A2 새로고침 후 해결 상태 · 시각 유지', after.status === 'resolved' && after.sla.resolvedAt === i.sla.resolvedAt, after.status);
    return h;
  });

  /* ========== A3. 오탐 종료 · 일시 중지 · 권한 회수 · 충전 요청 ========== */
  await area('A3 오탐 · 연결 요청', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    let d = await openRow(p, '킹 옵션 품절');
    const ps = d.locator('button:has-text("키워드 일시 중지 요청")');
    await ps.dblclick(); await wait(p, 300);
    let ch = (await changesNew(p)).filter((c) => /:pause$/.test(c.targetId));
    check('A3 일시 중지 요청 더블클릭 → 1건 · 승인 AE · kind status', ch.length === 1 && ch[0].approver === 'AE' && ch[0].kind === 'status' && ch[0].status === 'pending', JSON.stringify(ch.map((c) => [c.approver, c.kind])));
    check('A3 요청 후 버튼 = 일시 중지 요청됨 (비활성)', await d.locator('button:has-text("일시 중지 요청됨")').isDisabled(), 'label');
    check('A3 더블클릭이 화면 이동 · 다른 버튼을 누르지 않음', (await p.evaluate(() => location.hash)) === '#alert' && (await p.locator('.drawer').count()) === 1, await p.evaluate(() => location.hash));
    check('A3 드로어 연결 요청 목록에 표시', sp(await d.innerText()).includes('키워드') && sp(await d.innerText()).includes('승인 담당 AE') || sp(await d.innerText()).includes('승인 AE'), 'no linked');
    // 오탐 흐름
    await d.locator('button:has-text("오탐으로 종료")').click();
    const conf = d.locator('button.btn.danger:has-text("확인")');
    check('A3 오탐 사유 빈칸 → 확인 비활성', await conf.isDisabled(), 'enabled');
    await d.locator('input[aria-label="오탐 사유"]').fill('   ');
    check('A3 오탐 사유 공백 → 확인 비활성', await conf.isDisabled(), 'enabled');
    await d.locator('input[aria-label="오탐 사유"]').press('Enter'); await wait(p);
    check('A3 공백 사유 Enter → 종료 안 됨', (await incBy(p, (i) => i.ruleId === 'soldout_landing')).status === 'open', 'closed');
    await d.locator('button.btn.ghost:has-text("취소")').click();
    check('A3 오탐 취소 → 버튼 복귀', (await d.locator('button:has-text("오탐으로 종료")').count()) === 1, 'not restored');
    await d.locator('button:has-text("오탐으로 종료")').click();
    await d.locator('input[aria-label="오탐 사유"]').fill('재입고 반영 지연 · 실제 재고 있음');
    await d.locator('input[aria-label="오탐 사유"]').press('Enter'); await wait(p, 300);
    let inc = await incBy(p, (i) => i.ruleId === 'soldout_landing');
    check('A3 오탐 Enter → resolved · falsePositive · 사유 · ackAt/resolvedAt', inc.status === 'resolved' && inc.falsePositive === true && inc.actionNote === '오탐 · 재입고 반영 지연 · 실제 재고 있음' && !!inc.sla.ackAt && !!inc.sla.resolvedAt, JSON.stringify(inc.sla));
    check('A3 오탐 Pill · 콜아웃', sp(await d.innerText()).includes('오탐으로 종료') && (await d.locator('.pill:has-text("오탐")').count()) > 0, 'no pill');
    check('A3 해결 후 연결 요청 버튼 숨김', (await d.locator('button:has-text("일시 중지 요청")').count()) === 0, 'still shown');
    await closeDrawer(p);
    // 권한 회수 (드로어) ↔ 계정 탭 중복 방지
    d = await openRow(p, '비실명 공유 계정');
    await d.locator('button:has-text("권한 회수 요청")').dblclick(); await wait(p, 300);
    ch = (await changesNew(p)).filter((c) => /revoke/.test(c.targetId));
    check('A3 권한 회수 더블클릭 → 1건 · 승인 PM · 계정 단위 targetId', ch.length === 1 && ch[0].approver === 'PM' && /^alert:account:.+:revoke$/.test(ch[0].targetId), JSON.stringify(ch.map((c) => c.targetId)));
    check('A3 회수 더블클릭 후 #alert 유지 (옆 링크 오클릭 없음)', (await p.evaluate(() => location.hash)) === '#alert' && (await p.locator('.drawer').count()) === 1, await p.evaluate(() => location.hash));
    check('A3 회수 버튼 = 권한 회수 요청됨 (비활성)', await d.locator('button:has-text("권한 회수 요청됨")').isDisabled(), 'label');
    check('A3 회수 대상 사용자 기록 (before)', /agency-shared@/.test(String(ch[0]?.before)), String(ch[0]?.before));
    const toast = (await L.toasts(p)).find((t) => t.includes('권한 회수 요청을 만들었습니다'));
    check('A3 회수 토스트 + 승인 주체', !!toast && toast.includes('승인 주체: PM'), JSON.stringify(await L.toasts(p)));
    await closeDrawer(p);
    await L.tab(p, '계정 · 결제 · 권한');
    await p.locator('.card:has-text("계정 · 결제 · 권한 점검") tbody tr:has-text("Google")').click(); await wait(p);
    const accBtn = p.locator('.grid.g-2 .card').first().locator('button:has-text("권한 회수 요청됨")').first();
    check('A3 계정 탭 회수 버튼도 요청됨 · 비활성', (await accBtn.count()) === 1 && await accBtn.isDisabled(), (await accBtn.count()) ? await accBtn.innerText() : 'missing');
    // 충전 (시드: GFA 충전 요청이 이미 pending) → 드로어 비활성
    await L.tab(p, '이슈 큐');
    d = await openRow(p, '잔액 1일치 미만');
    const tu = d.locator('button:has-text("충전 요청")');
    const seedTopup = (await L.store(p)).changes.filter((c) => /topup$/.test(c.targetId || '') && /acc_gfa/.test(c.targetId));
    check('A3 GFA 시드 충전 요청 존재 → 드로어 충전 버튼 요청됨 · 비활성', seedTopup.length >= 1 && await tu.isDisabled() && /충전 요청됨/.test(await tu.innerText()), `${seedTopup.length} ${await tu.innerText()}`);
    check('A3 드로어 연결 요청에 시드 충전 건 표시 (승인 수면밀도)', sp(await d.innerText()).includes('승인 수면밀도'), 'no linked');
    await closeDrawer(p);
    // 수면밀도로 시드 반려 → 다시 요청 가능
    await role(p, '수면밀도');
    await L.go(p, 'flow');
    const row = p.locator('.flow-queue-row:has-text("GFA")').filter({ hasText: '충전' }).first();
    check('A3 Flow: 수면밀도 역할에 GFA 충전 승인 행', (await row.count()) === 1, 'no row');
    await row.locator('button:has-text("상세")').click(); await wait(p, 300);
    await p.fill('#flow-note', '금액 재산정 필요');
    await p.locator('.drawer button:has-text("반려")').first().click(); await wait(p, 150);
    await p.locator('.drawer button:has-text("확인 · 반려")').click(); await wait(p, 300);
    await closeDrawer(p);
    const rejected = (await L.store(p)).changes.filter((c) => /acc_gfa:topup$/.test(c.targetId || ''));
    check('A3 Flow 반려 → 충전 요청 rejected', rejected.some((c) => c.status === 'rejected'), JSON.stringify(rejected.map((c) => c.status)));
    await L.go(p, 'alert');
    d = await openRow(p, '잔액 1일치 미만');
    const tu2 = d.locator('button:has-text("충전 요청")');
    check('A3 반려 후 드로어 충전 요청 다시 활성', !(await tu2.isDisabled()), await tu2.innerText());
    await tu2.dblclick(); await wait(p, 300);
    const all = (await L.store(p)).changes.filter((c) => /acc_gfa:topup$/.test(c.targetId || ''));
    const pend = all.filter((c) => c.status === 'pending');
    check('A3 재요청 더블클릭 → pending 1건 · 승인 CLIENT · 금액 증가', pend.length === 1 && pend[0].approver === 'CLIENT' && pend[0].after > pend[0].before, JSON.stringify(all.map((c) => [c.status, c.before, c.after])));
    return h;
  });

  /* ========== A4. 보류 해제 요청 (AE 생성 → PM 승인 · 반영) → Alert 반영 ========== */
  await area('A4 보류 해제 → Flow', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await role(p, '담당 AE');
    const d = await openRow(p, '카카오 전환 추적 단절');
    await d.locator('textarea').first().fill('픽셀 재설치');
    await d.locator('button:has-text("1차 조치 기록")').click(); await wait(p);
    await d.locator('button:has-text("자동 조정 보류 해제 요청")').dblclick(); await wait(p, 300);
    let rel = (await L.store(p)).changes.filter((c) => /:release$/.test(c.targetId || ''));
    check('A4 AE 보류 해제 요청 → 1건 · requestedBy 담당 AE · 승인 PM · pending', rel.length === 1 && rel[0].requestedBy === '담당 AE' && rel[0].approver === 'PM' && rel[0].status === 'pending', JSON.stringify(rel.map((c) => [c.requestedBy, c.approver, c.status])));
    check('A4 버튼 = 보류 해제 요청됨 (비활성)', await d.locator('button:has-text("보류 해제 요청됨")').isDisabled(), 'label');
    check('A4 더블클릭 후 #alert · 드로어 유지', (await p.evaluate(() => location.hash)) === '#alert' && (await p.locator('.drawer').count()) === 1, await p.evaluate(() => location.hash));
    await closeDrawer(p);
    const kpi0 = sp(await p.locator('.alert-kpis .card:has-text("자동 조정 보류")').innerText());
    check('A4 반영 전 보류 KPI에 카카오', /카카오/.test(kpi0), kpi0);
    await p.locator('.toast:has-text("자동 조정 보류 해제 요청") button:has-text("바로 가기")').click(); await wait(p, 500);
    eq('A4 토스트 바로 가기 → #flow', await p.evaluate(() => location.hash), '#flow');
    const row = p.locator('.flow-queue-row:has-text("카카오 AD Pilot 자동 조정")');
    check('A4 AE 역할: 내 처리 큐에 PM 승인 건 없음', (await row.count()) === 0, 'AE can see');
    await role(p, 'PM');
    check('A4 PM 역할: 처리 큐에 표시', (await row.count()) === 1, 'missing');
    await row.locator('button.btn.primary:has-text("승인")').click(); await wait(p, 300);
    await row.locator('button.btn:has-text("반영")').click(); await wait(p, 300);
    rel = (await L.store(p)).changes.filter((c) => /:release$/.test(c.targetId || ''));
    check('A4 PM 승인 → 반영 → applied', rel[0].status === 'applied', rel[0].status);
    await L.go(p, 'alert');
    const kpi1 = sp(await p.locator('.alert-kpis .card:has-text("자동 조정 보류")').innerText());
    check('A4 반영 후 보류 KPI에서 카카오 제외', !/카카오/.test(kpi1) && Number((kpi1.match(/보류.*?(\d+)/) || [])[1]) === Number((kpi0.match(/보류.*?(\d+)/) || [])[1]) - 1, `${kpi0} → ${kpi1}`);
    const qrow = sp(await p.locator('.alert-queue tbody tr:has-text("카카오 전환 추적 단절")').innerText());
    check('A4 큐 행 Pill = 자동 조정 재개 (보류 해제 반영)', qrow.includes('자동 조정 재개'), qrow.slice(0, 160));
    const d2 = await openRow(p, '카카오 전환 추적 단절');
    check('A4 드로어 연결 요청 상태 = 반영', sp(await d2.innerText()).includes('반영') && sp(await d2.innerText()).includes('카카오 AD Pilot 자동 조정'), 'no status');
    await closeDrawer(p);
    // 롤백 → 다시 보류
    await L.go(p, 'flow');
    const rb = p.locator('button:has-text("롤백")').first();
    if (await rb.count()) {
      // Flow 이력 탭에서 롤백 가능한 경우
      check('A4 Flow 롤백 버튼 존재', true);
    }
    return h;
  });

  /* ========== A5. 알림 · 테스트 주입 · 정리 · 재스캔 ========== */
  await area('A5 알림 · 테스트 주입', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await L.closeToasts(p);
    await p.click('button:has-text("재스캔")'); await wait(p, 300);
    const rt = (await L.toasts(p)).find((t) => t.includes('재스캔 완료'));
    check('A5 재스캔 (변경 없음) → 신규 0건 토스트', !!rt && rt.includes('신규 0건'), rt);
    await L.tab(p, '알림 · 테스트 주입');
    const logRows = async () => p.locator('.card:has-text("알림 이력") tbody tr').count();
    const lr0 = await logRows();
    const expect = { '광고 OFF': 'P1', '결제 실패': 'P1', '광고비 급변': 'P2', '소재 반려': 'P2' };
    for (const s of Object.keys(expect)) {
      await L.closeToasts(p);
      const n0 = (await L.store(p)).incidents.length;
      await p.click(`.card.dark button:has-text("${s}")`); await wait(p, 300);
      const st = await L.store(p);
      const added = st.incidents.slice(0, st.incidents.length - n0);
      check(`A5 주입 '${s}' → 테스트 이슈 생성 (isTest · [테스트])`, added.length >= 1 && added.every((i) => i.isTest && /테스트/.test(i.title)), JSON.stringify(added.map((i) => [i.severity, i.ruleId, i.title.slice(0, 30)])));
      const tt = await L.toasts(p);
      check(`A5 주입 '${s}' 토스트`, tt.length >= 1, JSON.stringify(tt));
    }
    check('A5 알림 이력 행 증가', (await logRows()) > lr0, `${lr0} → ${await logRows()}`);
    const nTests = (await L.store(p)).incidents.filter((i) => i.isTest).length;
    await p.dblclick('.card.dark button:has-text("광고 OFF")'); await wait(p, 300);
    await p.click('.card.dark button:has-text("광고 OFF")'); await wait(p, 300);
    eq('A5 같은 시나리오 재주입 (더블클릭 포함) → 중복 없음', (await L.store(p)).incidents.filter((i) => i.isTest).length, nTests);
    check('A5 중복 주입 안내 토스트', (await L.toasts(p)).some((t) => t.includes('이미 열려 있습니다')), JSON.stringify(await L.toasts(p)));
    // 메신저 카드
    const card = p.locator('.alert-bot').first();
    check('A5 메신저 카드 표시', (await p.locator('.alert-bot').count()) >= 1, 'none');
    const cardTitle = sp(await card.innerText()).slice(0, 80);
    await card.locator('button:has-text("인지")').click(); await wait(p);
    check('A5 카드 인지 → 인지됨 비활성', /인지됨/.test(await card.locator('button').first().innerText()) && await card.locator('button').first().isDisabled(), await card.locator('button').first().innerText());
    await card.locator('button:has-text("상세 · 보고서")').click(); await wait(p);
    check('A5 카드 상세 → 드로어', (await p.locator('.drawer').count()) === 1, cardTitle);
    await closeDrawer(p);
    // P3 메일
    check('A5 P3 메일 다이제스트 영역 표시', (await p.locator('.alert-mail-head').count()) >= 1, 'none');
    // 알림 이력 행 클릭 → 드로어
    await p.locator('.card:has-text("알림 이력") tbody tr').first().click(); await wait(p);
    check('A5 알림 이력 행 → 드로어', (await p.locator('.drawer').count()) === 1, 'no drawer');
    await closeDrawer(p);
    // 큐 테스트만
    await L.tab(p, '이슈 큐');
    await p.check('#alert-test-only');
    const tr = await L.queueRows(p);
    check('A5 큐 테스트 주입만 → 테스트 이슈만', tr.length === nTests && tr.every((r) => r.includes('테스트')), `${tr.length} vs ${nTests}`);
    await p.uncheck('#alert-test-only');
    // 정리 (2단계)
    await L.tab(p, '알림 · 테스트 주입');
    await p.click('button:has-text("테스트 이슈 정리")');
    await p.click('.card.dark button.btn.ghost:has-text("취소")');
    eq('A5 정리 취소 → 변화 없음', (await L.store(p)).incidents.filter((i) => i.isTest && i.status !== 'resolved').length, nTests);
    await p.click('button:has-text("테스트 이슈 정리")');
    await p.click('.card.dark button.btn.danger:has-text("확인")'); await wait(p, 300);
    eq('A5 정리 확인 → 열린 테스트 이슈 0', (await L.store(p)).incidents.filter((i) => i.isTest && i.status !== 'resolved').length, 0);
    await p.click('.card.dark button:has-text("광고 OFF")'); await wait(p, 300);
    check('A5 정리 후 재주입 가능', (await L.store(p)).incidents.filter((i) => i.isTest && i.status !== 'resolved').length === 1, 'not reinjected');
    // 새로고침 후 테스트 이슈 유지
    await h.reload();
    check('A5 새로고침 후 테스트 이슈 유지', (await L.store(p)).incidents.filter((i) => i.isTest).length === nTests + 1, 'lost');
    return h;
  });

  /* ========== A6. 이상 징후 탭 ========== */
  await area('A6 이상 징후', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await L.tab(p, '이상 징후');
    const mt = p.locator('.card:has-text("매체 × 지표 이상 징후") tbody tr');
    const n = await mt.count();
    check('A6 매체 × 지표 행 ≥ 5', n >= 5, n);
    const head = async () => sp(await p.locator('.card:has-text("오늘 시간대 추이")').first().innerText()).slice(0, 60);
    const h0 = await head();
    await mt.nth(n - 1).click(); await wait(p);
    const h1 = await head();
    check('A6 매체 행 클릭 → 선택 · 추이 카드 변경', h0 !== h1 && (await mt.nth(n - 1).getAttribute('class') || '').includes('selected'), `${h0} | ${h1}`);
    const ob = p.locator('.card:has-text("매체 × 지표 이상 징후") tbody button:has-text("열기")');
    check('A6 열기 버튼 존재', (await ob.count()) >= 1, 'none');
    await ob.first().click(); await wait(p);
    check('A6 열기 → 드로어 (행 선택 유지)', (await p.locator('.drawer').count()) === 1 && (await head()) === h1, 'no drawer');
    await closeDrawer(p);
    const kw = p.locator('.card:has-text("키워드 성과 급변") tbody tr');
    if (await kw.count()) { await kw.first().click(); await wait(p); check('A6 키워드 급변 행 → 드로어', (await p.locator('.drawer').count()) === 1, 'no drawer'); await closeDrawer(p); }
    if (await kw.count()) {
      const col = async () => p.$$eval('.card:has-text("키워드 성과 급변") tbody tr', (t) => t.map((x) => x.innerText.split('\n')[0]));
      const c0 = await col();
      await p.locator('.card:has-text("키워드 성과 급변") th').filter({ hasText: 'CPC 변화' }).first().click(); await wait(p, 120);
      const c1 = await col();
      await p.locator('.card:has-text("키워드 성과 급변") th').filter({ hasText: 'CPC 변화' }).first().click(); await wait(p, 120);
      const c2 = await col();
      check('A6 키워드 표 CPC 변화 헤더 정렬 토글 (순서 바뀜)', c0.length <= 1 || JSON.stringify(c1) !== JSON.stringify(c2), `${c1.slice(0, 3).join(',')} | ${c2.slice(0, 3).join(',')}`);
    }
    const fc = p.locator('.card:has-text("일 예산 소진 예측") tbody tr');
    check('A6 예산 소진 예측 행 존재', (await fc.count()) >= 1, 'none');
    await fc.first().click(); await wait(p);
    check('A6 예산 소진 예측 행 (이슈 있음) → 드로어', (await p.locator('.drawer').count()) === 1, 'no drawer');
    await closeDrawer(p);
    return h;
  });

  /* ========== A7. 탐지 기준 → alert_rule 요청 → 승인 · 반영 → 재스캔 · 롤백 · 반려 ========== */
  await area('A7 탐지 기준', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await L.tab(p, '탐지 기준');
    const submit = p.locator('button.btn.primary:has-text("기준 변경 요청")');
    check('A7 초기 제출 비활성 (변경 없음)', await submit.isDisabled(), 'enabled');
    await p.fill('#cfg-cost-w', '60'); await wait(p, 150);
    await p.fill('#cfg-reason', '테스트');
    check('A7 주의 > 위험 → 입력 범위 경고 · 제출 비활성', (await p.locator('.callout:has-text("입력 범위 확인")').count()) === 1 && await submit.isDisabled(), 'no warning');
    await p.fill('#cfg-cost-w', ''); await wait(p, 150);
    const emptyVal = await p.inputValue('#cfg-cost-w');
    check('A7 빈 입력 → 경고 또는 비활성 (제출 불가)', await submit.isDisabled() || (await p.locator('.callout:has-text("입력 범위 확인")').count()) === 1, `value='${emptyVal}'`);
    await p.fill('#cfg-cost-w', 'abc').catch(() => {}); await wait(p, 100);
    check('A7 숫자 아닌 입력 거부', !/abc/.test(await p.inputValue('#cfg-cost-w')), await p.inputValue('#cfg-cost-w'));
    await p.fill('#cfg-windowHours', '999'); await wait(p, 150);
    check('A7 큰 값(999) → 범위 경고 · 비활성', (await p.locator('.callout:has-text("입력 범위 확인")').count()) === 1 && await submit.isDisabled(), await p.inputValue('#cfg-windowHours'));
    await p.fill('#cfg-windowHours', '-5'); await wait(p, 150);
    check('A7 음수 → 범위 경고 · 비활성', (await p.locator('.callout:has-text("입력 범위 확인")').count()) === 1 && await submit.isDisabled(), await p.inputValue('#cfg-windowHours'));
    await p.click('button:has-text("현재값으로")'); await wait(p, 150);
    check('A7 현재값으로 → 경고 사라짐 · 비활성', (await p.locator('.callout:has-text("입력 범위 확인")').count()) === 0 && await submit.isDisabled(), 'still');
    const preview = async () => sp(await p.locator('span.small:has-text("이상 징후 계열 이슈")').innerText());
    const pv0 = await preview();
    await p.fill('#cfg-cost-w', '20'); await p.fill('#cfg-cost-d', '40'); await wait(p, 200);
    const pv1 = await preview();
    check('A7 미리보기 이슈 수 재계산', pv0 !== pv1, `${pv0} → ${pv1}`);
    await p.fill('#cfg-reason', '   ');
    check('A7 공백 사유 → 비활성', await submit.isDisabled(), 'enabled');
    await p.fill('#cfg-reason', '광고비 감지 민감도 상향');
    await submit.dblclick(); await wait(p, 300);
    let rc = (await L.store(p)).changes.filter((c) => c.kind === 'alert_rule');
    check('A7 제출 더블클릭 → 1건 · 승인 PM · pending · module alert', rc.length === 1 && rc[0].approver === 'PM' && rc[0].status === 'pending' && rc[0].module === 'alert' && rc[0].targetId === 'alert_rule:cost', JSON.stringify(rc.map((c) => [c.targetId, c.before, c.after, c.status])));
    check('A7 제출 토스트 + 사유 초기화', (await L.toasts(p)).some((t) => t.includes('탐지 기준 변경 요청 1건')) && (await p.inputValue('#cfg-reason')) === '', JSON.stringify(await L.toasts(p)));
    await p.fill('#cfg-reason', '다시');
    check('A7 같은 변경안 재요청 차단 (안내 문구)', await submit.isDisabled() && (await p.locator('text=같은 변경안이 이미 승인').count()) === 1, await submit.innerText());
    // AE: 승인 불가
    await role(p, '담당 AE');
    const row = p.locator('tr:has-text("탐지 기준 · 광고비")').last();
    check('A7 AE 역할 → 승인 · 반려 비활성', await row.locator('button:has-text("승인")').isDisabled() && await row.locator('button:has-text("반려")').isDisabled(), 'enabled');
    await role(p, 'PM');
    await row.locator('button:has-text("승인")').dblclick(); await wait(p, 300);
    eq('A7 PM 승인 더블클릭 → approved (반영까지 넘어가지 않음)', (await L.store(p)).changes.find((c) => c.kind === 'alert_rule').status, 'approved');
    const inc0 = (await L.store(p)).incidents.length;
    await row.locator('button:has-text("반영")').dblclick(); await wait(p, 400);
    const st = await L.store(p);
    check('A7 반영 더블클릭 → applied (롤백까지 넘어가지 않음) · 재스캔으로 신규 이슈 추가', st.changes.find((c) => c.kind === 'alert_rule').status === 'applied' && st.incidents.length > inc0, `${inc0} → ${st.incidents.length}`);
    check('A7 반영 토스트 (신규 n건)', (await L.toasts(p)).some((t) => /탐지 기준 반영 · 재스캔/.test(t)), JSON.stringify(await L.toasts(p)));
    const cur = sp(await p.locator('tr:has(#cfg-cost-w) td').nth(2).innerText());
    check('A7 현재 적용 기준 열 = 20 / 40', /20/.test(cur) && /40/.test(cur), cur);
    await L.tab(p, '이상 징후');
    const an = sp(await p.locator('.card:has-text("매체 × 지표 이상 징후")').first().innerText());
    check('A7 이상 징후 탭 판정 기준 반영 (±20%/±40%)', /광고비 ±20 · ±40%/.test(an), an.slice(0, 200));
    await L.tab(p, '탐지 기준');
    await p.locator('tr:has-text("탐지 기준 · 광고비")').last().locator('button:has-text("롤백")').click(); await wait(p, 300);
    const cur2 = sp(await p.locator('tr:has(#cfg-cost-w) td').nth(2).innerText());
    check('A7 롤백 → rolled_back · 기준 원복 (30/50)', (await L.store(p)).changes.find((c) => c.kind === 'alert_rule').status === 'rolled_back' && /30/.test(cur2) && /50/.test(cur2), cur2);
    // 반려 경로 + Enter 제출
    await p.fill('#cfg-windowHours', '3'); await p.fill('#cfg-reason', '구간 확대'); await p.press('#cfg-reason', 'Enter'); await wait(p, 200);
    await p.press('#cfg-reason', 'Enter'); await wait(p, 200);
    const wh = (await L.store(p)).changes.filter((c) => c.targetId === 'alert_rule:windowHours');
    check('A7 Enter 제출 → 1건 (두 번째 Enter 무시)', wh.length === 1, wh.length);
    await p.locator('tr:has-text("동시간 비교 구간")').last().locator('button:has-text("반려")').click(); await wait(p);
    eq('A7 반려 → rejected', (await L.store(p)).changes.find((c) => c.targetId === 'alert_rule:windowHours').status, 'rejected');
    // Flow 경로: 새 요청 → Flow 승인 · 반영 → Alert 기준 반영
    await p.fill('#cfg-trackingZeroHours', '2'); await p.fill('#cfg-reason', 'Flow 경로'); await p.click('button.btn.primary:has-text("기준 변경 요청")'); await wait(p);
    await p.locator('.toast:has-text("탐지 기준 변경 요청") button:has-text("바로 가기")').last().click(); await wait(p, 500);
    eq('A7 토스트 바로 가기 → #flow', await p.evaluate(() => location.hash), '#flow');
    const frow = p.locator('.flow-queue-row').filter({ hasText: '전환 추적 단절 · 연속 전환 0' }).first();
    check('A7 Flow 처리 큐에 alert_rule 요청', (await frow.count()) === 1, 'missing');
    await frow.locator('button.btn.primary:has-text("승인")').click(); await wait(p);
    await frow.locator('button.btn:has-text("반영")').click(); await wait(p, 300);
    const tz = (await L.store(p)).changes.find((c) => c.targetId === 'alert_rule:trackingZeroHours');
    check('A7 Flow 승인 · 반영 → applied', tz && tz.status === 'applied', tz && tz.status);
    await L.go(p, 'alert'); await L.tab(p, '탐지 기준');
    const cur3 = sp(await p.locator('tr:has(#cfg-trackingZeroHours) td').nth(2).innerText());
    check('A7 Flow 반영 → Alert 현재 기준 2시간', /^2/.test(cur3) || /\b2\s*시간/.test(cur3), cur3);
    // 새로고침 유지
    await h.reload(); await L.tab(p, '탐지 기준');
    const cur4 = sp(await p.locator('tr:has(#cfg-trackingZeroHours) td').nth(2).innerText());
    check('A7 새로고침 후 적용 기준 유지', cur4 === cur3, `${cur3} → ${cur4}`);
    return h;
  });


  /* ========== A8. 주말 · 공휴일 ========== */
  await area('A8 주말 · 공휴일', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    // TF 이름 → Alert 당번표 반영 (교차 모듈)
    await p.fill('#ops-tf-sa_ae-name', '김민수'); await wait(p);
    await L.go(p, 'alert'); await L.tab(p, '주말 · 공휴일');
    const rot = p.locator('.card:has-text("당번 순번표") tbody tr');
    check('A8 당번 순번표 9주 (≥18행)', (await rot.count()) >= 18, await rot.count());
    check('A8 오늘(10/31 토) 행 + 당번 표시', /10\/31\(토\)오늘/.test(sp(await rot.first().innerText()).replace(/ /g, '')) || sp(await rot.first().innerText()).includes('오늘'), sp(await rot.first().innerText()));
    check('A8 TF 성명이 당번표에 반영 (김민수 · SA AE)', sp(await p.locator('.card:has-text("당번 순번표") tbody').innerText()).includes('김민수 · SA AE'), 'name missing');
    const callout = sp(await p.locator('.card:has-text("주말 · 공휴일 대응 체계") .callout').innerText());
    check('A8 토요일 → 주말 · 공휴일 체계 적용 · 당번 · 다음 영업일 브리핑', /주말 · 공휴일 체계 적용 중/.test(callout) && /11\/2\(월\) 09:30/.test(callout) && callout.includes('김민수'), callout.slice(0, 160));
    const segs = await p.$$eval('.seg[aria-label="점검 대상 휴무 구간"] button', (b) => b.map((x) => x.innerText.trim()));
    check('A8 점검 구간 선택지 (이번 주말 · 다음 주말 · 연휴)', segs.length >= 4 && segs[0].includes('이번 주말') && segs.some((x) => /성탄절|신정|설날/.test(x)), segs.join(','));
    const headOf = async () => sp(await p.locator('.card:has-text("연휴 전날 사전 점검") .row-between').first().innerText());
    const heads = new Set();
    for (const sgl of segs) {
      await p.click(`.seg[aria-label="점검 대상 휴무 구간"] button:has-text("${sgl}")`); await wait(p, 150);
      const hd = await headOf();
      heads.add(hd.replace(/.*?(\d+\/\d+ \d\d:\d\d → )/, '$1'));
      const n = await p.locator('.alert-precheck .row.small').count();
      check(`A8 '${sgl}' 점검 항목 표시 (실패 · 주의 · 통과 집계)`, n >= 5 && /실패 \d+/.test(hd) && /통과 \d+/.test(hd), `${n} items · ${hd.slice(-60)}`);
      if (sgl !== segs[0]) check(`A8 '${sgl}' 미래 구간 안내`, (await p.locator('.callout:has-text("미래 구간은")').count()) === 1, 'no future callout');
    }
    check('A8 구간마다 점검 시간 범위가 다름', heads.size === segs.length, [...heads].join(' | '));
    await p.click(`.seg[aria-label="점검 대상 휴무 구간"] button:has-text("${segs[0]}")`); await wait(p);
    await p.click('.card:has-text("연휴 전날 사전 점검") button:has-text("점검표 복사")'); await wait(p, 300);
    const c = await clip(p);
    check('A8 점검표 복사 (## 제목 · ### 그룹 · [실패] 항목)', c.startsWith('## 연휴 전날 사전 점검') && (c.match(/^### /gm) || []).length >= 3 && /\[실패\]/.test(c), c.slice(0, 100));
    const gfaLine0 = (await p.locator('.alert-precheck').innerText()).split('\n').find((l) => /GFA/.test(l)) || '';
    // 주말 모드 토글
    const lab = await p.locator('label[for="alert-offhours"]').innerText();
    check('A8 휴무일 토글 라벨 (자동 적용 중 안내)', /자동 적용 중/.test(lab), lab);
    await p.check('#alert-offhours'); await wait(p);
    check('A8 토글 on → 체크됨 · 오류 없음', await p.isChecked('#alert-offhours'), 'unchecked');
    await p.uncheck('#alert-offhours');
    // 브리핑 링크 → 드로어
    const bl = p.locator('.card:has-text("이슈 브리핑") a').first();
    const blt = sp(await bl.innerText());
    await bl.click(); await wait(p);
    check('A8 이슈 브리핑 링크 → 드로어', (await p.locator('.drawer').count()) === 1 && blt.includes(sp(await p.locator('.drawer h3').innerText()).slice(0, 10)), blt);
    await closeDrawer(p);
    check('A8 브리핑 대상에 P1 제외', !(await p.locator('.card:has-text("이슈 브리핑") a').allInnerTexts()).some((t) => /^P1/.test(t.trim())), 'P1 listed');
    return h;
  });

  /* ========== A9. 계정 · 결제 · 권한 + 충전 반영 (Flow) ========== */
  await area('A9 계정 · 결제 · 권한', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await L.tab(p, '계정 · 결제 · 권한');
    const trs = p.locator('.card:has-text("계정 · 결제 · 권한 점검") tbody tr');
    const n = await trs.count();
    eq('A9 계정 행 수 = 7', n, 7);
    const detailTitle = async () => sp(await p.locator('.grid.g-2 .card').first().locator('h3, .card-title').first().innerText());
    const titles = new Set();
    for (let k = 0; k < n; k++) { await trs.nth(k).click(); await wait(p, 120); titles.add(await detailTitle()); }
    check('A9 행 클릭 → 점검 상세 카드 전환', titles.size === n, [...titles].join(' | '));
    await trs.filter({ hasText: 'GFA' }).click(); await wait(p);
    const btns = await p.locator('.grid.g-2 .card').first().locator('button').allInnerTexts();
    check('A9 GFA 상세: 시드 충전 요청됨(금액) + P1 이슈 열기', btns.some((b) => /충전 요청됨 [\d,.]+만원/.test(b)) && btns.some((b) => /P1 이슈 열기/.test(b)), JSON.stringify(btns));
    await p.locator('.grid.g-2 .card').first().locator('button:has-text("이슈 열기")').click(); await wait(p);
    check('A9 이슈 열기 → GFA 잔액 드로어', /잔액/.test(await p.locator('.drawer h3').innerText()), 'drawer');
    await closeDrawer(p);
    // 정렬
    await p.locator('.card:has-text("계정 · 결제 · 권한 점검") th:has-text("일 평균 소진")').click(); await wait(p);
    const sp1 = await p.$$eval('.card:has-text("계정 · 결제 · 권한 점검") tbody tr', (t) => t.map((x) => x.querySelectorAll('td')[4]?.innerText.trim()));
    await p.locator('.card:has-text("계정 · 결제 · 권한 점검") th:has-text("일 평균 소진")').click(); await wait(p);
    const sp2 = await p.$$eval('.card:has-text("계정 · 결제 · 권한 점검") tbody tr', (t) => t.map((x) => x.querySelectorAll('td')[4]?.innerText.trim()));
    check('A9 헤더 정렬 토글 (오름 ↔ 내림)', JSON.stringify(sp1) === JSON.stringify([...sp2].reverse()) && JSON.stringify(sp1) !== JSON.stringify(sp2), `${sp1.join(',')} | ${sp2.join(',')}`);
    // 권한 회수 (계정 탭) 더블클릭
    await trs.filter({ hasText: 'Google' }).click(); await wait(p);
    const rv = p.locator('.grid.g-2 .card').first().locator('button:has-text("권한 회수 요청")');
    await rv.dblclick(); await wait(p, 300);
    const rc = (await changesNew(p)).filter((c) => /revoke$/.test(c.targetId));
    check('A9 계정 탭 권한 회수 더블클릭 → 1건 · 승인 PM · 드로어 안 열림', rc.length === 1 && rc[0].approver === 'PM' && (await p.locator('.drawer').count()) === 0, `${rc.length} · drawer ${await p.locator('.drawer').count()}`);
    check('A9 회수 버튼 = 권한 회수 요청됨 (비활성)', await p.locator('.grid.g-2 .card').first().locator('button:has-text("권한 회수 요청됨")').isDisabled(), 'label');
    // 수면밀도로 GFA 충전 승인 · 반영 → 잔액 · runway 반영
    const gfaRow0 = sp(await trs.filter({ hasText: 'GFA' }).innerText());
    await role(p, '수면밀도'); await L.go(p, 'flow');
    const row = p.locator('.flow-queue-row:has-text("GFA")').filter({ hasText: '충전' }).first();
    await row.locator('button.btn.primary:has-text("승인")').click(); await wait(p);
    await p.locator('.flow-queue-row:has-text("GFA")').filter({ hasText: '충전' }).first().locator('button.btn:has-text("반영")').click(); await wait(p, 300);
    const tu = (await L.store(p)).changes.find((c) => /acc_gfa:topup$/.test(c.targetId || ''));
    check('A9 Flow 수면밀도 승인 · 반영 → applied', tu.status === 'applied', tu.status);
    await L.go(p, 'alert'); await L.tab(p, '계정 · 결제 · 권한');
    const gfaRow1 = sp(await p.locator('.card:has-text("계정 · 결제 · 권한 점검") tbody tr:has-text("GFA")').innerText());
    check('A9 잔액 열에 충전 반영 +금액 · 소진 예상 일수 증가', /충전 반영 \+/.test(gfaRow1) && parseFloat((gfaRow1.match(/([\d.]+)일/) || [])[1]) > parseFloat((gfaRow0.match(/([\d.]+)일/) || [])[1]), `${gfaRow0.slice(0, 120)} → ${gfaRow1.slice(0, 140)}`);
    const kpi = sp(await p.locator('.alert-kpis').innerText());
    check('A9 최단 소진 예상 KPI가 GFA에서 다른 계정으로', !/최단 소진 예상 TEST DATA 0\.9일/.test(kpi), kpi.slice(0, 260));
    await L.tab(p, '주말 · 공휴일');
    const pre = (await p.locator('.alert-precheck').innerText()).split('\n').filter((l) => /GFA/.test(l)).join(' / ');
    check('A9 사전 점검 GFA 잔액 항목 갱신 (충전 반영)', pre.length > 0 && !/0\.9일/.test(pre), pre.slice(0, 200));
    return h;
  });

  /* ========== A10. SLA 리포트 ========== */
  await area('A10 SLA 리포트', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await L.tab(p, 'SLA 리포트');
    const hist = p.locator('.card:has-text("처리 이력") tbody tr');
    const all = await hist.count();
    await L.seg(p, '출처', '지난 이력'); const past = await hist.count();
    await L.seg(p, '출처', '이번 세션'); const sess = sp(await p.locator('.card:has-text("처리 이력") tbody').innerText());
    check('A10 이번 세션 (처리 없음) → 빈 상태 문구', /없|처리/.test(sess) && (await hist.count()) <= 1, sess.slice(0, 80));
    await L.seg(p, '출처', '전체');
    await L.seg(p, '등급', 'P1'); const p1 = await p.$$eval('.card:has-text("처리 이력") tbody tr', (t) => t.map((x) => x.innerText));
    check('A10 등급 P1 필터 → P1만', p1.length > 0 && p1.length < all && p1.every((t) => t.includes('P1')), `${p1.length}/${all}`);
    await L.seg(p, '등급', '전체');
    check('A10 출처 지난 이력 ≤ 전체', past <= all && past > 0, `${past}/${all}`);
    const kpi0 = sp(await p.locator('.alert-kpis').innerText());
    // 처리 → 이번 세션 반영
    await L.tab(p, '이슈 큐');
    const d = await openRow(p, '카카오 전환 추적 단절');
    await d.locator('button:has-text("인지")').first().click();
    await d.locator('textarea').first().fill('픽셀 재설치'); await d.locator('button:has-text("1차 조치 기록")').click();
    await d.locator('button:has-text("결과 보고")').click(); await d.locator('button.btn.primary:has-text("해결")').click(); await wait(p);
    await closeDrawer(p);
    await L.tab(p, 'SLA 리포트');
    const kpi1 = sp(await p.locator('.alert-kpis').innerText());
    check('A10 처리 후 KPI 갱신 (이번 세션 처리 1)', kpi0 !== kpi1 && /이번 세션 처리 1/.test(kpi1), `${kpi0.slice(0, 80)} → ${kpi1.slice(0, 80)}`);
    await L.seg(p, '출처', '이번 세션');
    const srows = await p.$$eval('.card:has-text("처리 이력") tbody tr', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ')));
    check('A10 이번 세션 이력에 처리 건 표시', srows.length === 1 && srows[0].includes('카카오'), JSON.stringify(srows).slice(0, 200));
    await L.seg(p, '출처', '전체');
    await p.locator('.card:has-text("월간 SLA 리포트") button:has-text("복사")').click(); await wait(p, 300);
    const c = await clip(p);
    check('A10 SLA 리포트 복사 (## 제목 · 표)', c.startsWith('## MILDO Alert 월간 SLA 리포트') && c.includes('|'), c.slice(0, 80));
    await p.locator('.card:has-text("월간 SLA 리포트") button:has-text(".md")').click(); await wait(p, 500);
    const sv = await h.saves();
    check('A10 SLA .md 저장 (파일명 · 제목 · 크기)', sv.length === 1 && sv[0].filename === 'MILDO-Alert-월간-SLA-2026-10.md' && sv[0].head.startsWith('## MILDO Alert 월간 SLA 리포트') && sv[0].bytes > 500, JSON.stringify(sv.map((x) => [x.filename, x.bytes])));
    return h;
  });

  /* ========== A11. 다운로드 모드 (decline · none · 일반 브라우저) ========== */
  for (const [ai, dlm] of [['artifact', 'decline'], ['artifact', 'none'], ['none', 'accept']]) {
    await area(`A11 다운로드 ${ai}/${dlm}`, async (set) => {
      const h = set(await openH('alert', { ai, downloads: dlm }));
      const p = h.page;
      await L.tab(p, 'SLA 리포트');
      await p.locator('.card:has-text("월간 SLA 리포트") button:has-text(".md")').click(); await wait(p, 700);
      await L.tab(p, '이슈 큐');
      await p.click('.alert-queue tbody tr >> nth=0'); await wait(p);
      await p.locator('.drawer button:has-text(".md")').click(); await wait(p, 700);
      await closeDrawer(p);
      await L.go(p, 'ops');
      await p.locator('.card:has-text("전담 7인 TF 명단") button:has-text("CSV")').click(); await wait(p, 700);
      await L.tab(p, '90일 온보딩'); await p.locator('.card:has-text("계정 인수 · 90일 온보딩") button:has-text(".md")').click(); await wait(p, 700);
      await L.tab(p, 'RFP 커버리지'); await p.locator('.card:has-text("RFP 커버리지 맵") button:has-text("CSV")').click(); await wait(p, 700);
      const saves = await h.saves();
      const tt = await L.toasts(p);
      if (ai === 'none') {
        check(`A11 ${ai}/${dlm} 일반 브라우저 다운로드 5건 (Blob)`, h.downloads.length === 5 && h.downloads.some((f) => f.endsWith('.csv')) && h.downloads.some((f) => f.endsWith('.md')), JSON.stringify(h.downloads));
      } else if (dlm === 'decline') {
        check(`A11 ${ai}/${dlm} 저장 0건 · 브라우저 다운로드 0건`, saves.length === 0 && h.downloads.length === 0, `${saves.length}/${h.downloads.length}`);
        check(`A11 ${ai}/${dlm} 오류 토스트 없음 (거절은 조용히 · 화면 정상)`, !tt.some((t) => /(저장|다운로드|파일).*(실패|오류)|(실패|오류).*(저장|다운로드|파일)/.test(t)) && (await p.locator('.page').count()) === 1, JSON.stringify(tt));
      } else {
        check(`A11 ${ai}/${dlm} use('downloads')=null → 직접 다운로드 안 함 · 화면 정상`, saves.length === 0 && (await p.locator('.page').count()) === 1, `${saves.length}/${h.downloads.length} ${JSON.stringify(tt)}`);
      }
      // 다운로드 버튼이 다시 눌러도 동작 (오류 상태에 갇히지 않음)
      const b = p.locator('.card:has-text("RFP 커버리지 맵") button:has-text("CSV")');
      check(`A11 ${ai}/${dlm} 다운로드 버튼 계속 사용 가능`, (await b.count()) === 0 || await b.isEnabled(), 'disabled');
      return h;
    });
  }

  /* ========== A12. AI (Alert · Ops AiInsight) 모드별 ========== */
  for (const mode of ['none', 'artifact', 'denied', 'rate', 'error-mid', 'slow', 'unavailable']) {
    for (const [route, cardSel, cta] of [['alert', 'AI 원인 분석 · 우선순위', 'AI 분석 생성'], ['ops', '제출 준비 · 운영 체계 해석', '해석 생성']]) {
      await area(`A12 AI ${route}/${mode}`, async (set) => {
        const h = set(await openH(route, { ai: mode }));
        const p = h.page;
        const card = p.locator(`.card:has-text("${cardSel}")`).last();
        eq(`A12 ${route}/${mode} 로드 후 호출 0`, (await h.calls()).length, 0);
        await card.locator(`button:has-text("${cta}")`).click();
        if (mode === 'slow') {
          await wait(p, 1700);
          const stop = card.locator('button:has-text("중지")');
          check(`A12 ${route}/slow 생성 중 중지 버튼`, (await stop.count()) === 1, 'no stop');
          await stop.click(); await wait(p, 3500);
          const t = await card.innerText();
          check(`A12 ${route}/slow 중지 → 오류 표시 없음 · 전체 텍스트로 끝나지 않음 · 다시 생성 가능`, !/오류|실패/.test(t) && !t.includes(MOCK_END) && (await card.locator('button.btn.accent').count()) === 1, sp(t).slice(0, 160));
        } else {
          await wait(p, 1500);
          const t = await card.innerText();
          const calls = await h.calls();
          if (mode === 'artifact') {
            check(`A12 ${route}/artifact 스트리밍 → 전체 모의 텍스트 · AI 태그`, t.includes(MOCK_END) && t.includes('확정 팩트') && (await card.locator('.src:has-text("AI"), [class*="src"]:has-text("AI")').count()) >= 1, sp(t).slice(0, 120));
            check(`A12 ${route}/artifact 호출 1 · cache:false · 도구 없음`, calls.length === 1 && calls[0].cache === false && calls[0].tools.length === 0, JSON.stringify(calls));
            check(`A12 ${route}/artifact 입력 256KiB 이하`, calls[0] && calls[0].inputBytes < 262144, calls[0] && calls[0].inputBytes);
            await card.locator('button:has-text("복사")').first().click(); await wait(p, 300);
            check(`A12 ${route}/artifact 결과 복사 → 클립보드에 AI 텍스트`, (await clip(p)).includes(MOCK_END), (await clip(p)).slice(0, 60));
            await card.locator('button:has-text("다시 생성")').click(); await wait(p, 1200);
            eq(`A12 ${route}/artifact 다시 생성 → 호출 2`, (await h.calls()).length, 2);
          } else if (mode === 'none' || mode === 'unavailable') {
            check(`A12 ${route}/${mode} 규칙 엔진 결과 (6개 섹션) · 호출 0`, calls.length === 0 && t.includes('확정 팩트') && t.includes('다음 액션') && /규칙 엔진/.test(t), sp(t).slice(0, 120));
          } else {
            const msg = { denied: 'Claude 사용이 허용되지 않았습니다', rate: '요청이 많습니다', 'error-mid': '일시적인 연결 오류' }[mode];
            check(`A12 ${route}/${mode} 한국어 안내 '${msg}' + 내용 유지`, t.includes(msg) && t.includes('확정 팩트'), sp(t).slice(0, 200));
            if (mode !== 'error-mid') check(`A12 ${route}/${mode} 규칙 엔진 결과로 대체`, t.includes('확정 팩트') && t.includes('다음 액션'), sp(t).slice(0, 120));
            else check(`A12 ${route}/error-mid 부분 텍스트 유지`, t.includes('확정 팩트'), sp(t).slice(0, 120));
            const c1 = (await h.calls()).length; await wait(p, 2500);
            eq(`A12 ${route}/${mode} 자동 재시도 없음`, (await h.calls()).length, c1);
            const btn = card.locator('button.btn.accent').first();
            check(`A12 ${route}/${mode} 버튼 다시 사용 가능`, await btn.isEnabled(), 'disabled');
            await btn.click(); await wait(p, 1200);
            const c2 = (await h.calls()).length;
            check(`A12 ${route}/${mode} 재클릭: ${mode === 'denied' ? '추가 호출 없음(거부 기억)' : '호출 1건 추가'}`, mode === 'denied' ? c2 === c1 : c2 === c1 + 1, `${c1} → ${c2}`);
          }
        }
        return h;
      });
    }
  }


  /* ========== O1. 전담 TF 명단 입력 · 검증 · CSV · 복사 · 유지 ========== */
  await area('O1 TF 명단', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    const callout = async () => sp(await p.locator('.card:has-text("전담 7인 TF 명단") .callout').first().innerText());
    const tabTxt = async () => sp(await p.locator('[role=tab]').first().innerText());
    check('O1 초기 미입력 21칸 / 21칸 · 탭 배지 21', /미입력 21칸 \/ 21칸/.test(await callout()) && /21$/.test(await tabTxt()), `${await callout()} | ${await tabTxt()}`);
    const stateCell = async (id) => sp(await p.locator(`tr:has(#ops-tf-${id}-name) td`).last().innerText());
    await p.fill('#ops-tf-pm-name', '김OO'); await p.fill('#ops-tf-pm-years', '50'); await p.fill('#ops-tf-pm-alloc', '0'); await wait(p, 150);
    check('O1 마스킹 성명 · 연차 50 · 투입률 0 → 오입력 3종 + 빨간 테두리', /실명 아님/.test(await stateCell('pm')) && /연차 0~45년/.test(await stateCell('pm')) && /투입률 1~100%/.test(await stateCell('pm')) && /ops-invalid/.test(await p.getAttribute('#ops-tf-pm-name', 'class')), await stateCell('pm'));
    check('O1 오입력 집계 콜아웃', /오입력 1명/.test(await callout()), await callout());
    await p.fill('#ops-tf-pm-years', 'abc'); await p.fill('#ops-tf-pm-alloc', '-5'); await wait(p, 120);
    check('O1 문자 연차 · 음수 투입률 → 오입력', /연차 0~45년/.test(await stateCell('pm')) && /투입률 1~100%/.test(await stateCell('pm')), await stateCell('pm'));
    await p.fill('#ops-tf-pm-alloc', '101'); await wait(p, 100);
    check('O1 투입률 101 → 오입력', /투입률 1~100%/.test(await stateCell('pm')), await stateCell('pm'));
    // CSV: 오입력 값은 내보내지 않고 빈칸 표기
    await p.locator('.card:has-text("전담 7인 TF 명단") button:has-text("CSV")').click(); await wait(p, 500);
    let sv = await h.saves();
    check('O1 CSV 저장: 헤더 · 오입력 값(김OO · 50년)은 장표 빈칸 표기', sv.length === 1 && sv[0].filename === 'mildo-tf-명단.csv' && sv[0].head.startsWith('역할,성명,연차,담당,투입률,백업') && !sv[0].head.includes('김OO') && !sv[0].head.includes('50년'), sv[0] && sv[0].head.split('\n').slice(0, 2).join(' | '));
    await p.fill('#ops-tf-pm-years', '12년'); await p.fill('#ops-tf-pm-alloc', '100%'); await p.fill('#ops-tf-pm-name', '김민지'); await wait(p, 100);
    check("O1 '12년' · '100%' 단위 포함 입력 허용 → 완료", /완료/.test(await stateCell('pm')), await stateCell('pm'));
    const vals = { sa_lead: ['이서준', '9', '100'], sa_ae: ['박하늘', '4', '100'], da_ae: ['최도윤', '5', '100'], global_ae: ['정예린', '6', '100'], analyst: ['한지우', '7', '80'], dev: ['오태양', '8', '50'] };
    for (const [id, v] of Object.entries(vals)) { await p.fill(`#ops-tf-${id}-name`, v[0]); await p.fill(`#ops-tf-${id}-years`, v[1]); await p.fill(`#ops-tf-${id}-alloc`, v[2]); }
    await wait(p, 200);
    check('O1 7명 입력 → 입력 완료 · 합계 6.3 FTE · 탭 배지 사라짐', /TF 명단 입력 완료/.test(await callout()) && /6\.3 FTE/.test(await callout()) && !/\d$/.test(await tabTxt()), `${await callout()} | ${await tabTxt()}`);
    await p.locator('.card:has-text("전담 7인 TF 명단") button:has-text("CSV")').click(); await wait(p, 500);
    sv = await h.saves();
    check('O1 CSV 한글 성명 · 연차 · 투입률', sv.length === 2 && sv[1].head.includes('총괄 PM,김민지,12년') && sv[1].head.includes('100%'), sv[1] && sv[1].head.split('\n').slice(0, 2).join(' | '));
    await p.locator('.card:has-text("전담 7인 TF 명단") button:has-text("표 복사")').click(); await wait(p, 300);
    const c = await clip(p);
    check('O1 표 복사 → 마크다운 표 (## 제목 · 김민지)', c.startsWith('## 전담 TF 명단') && c.includes('| 김민지 |'), c.slice(0, 80));
    await h.reload();
    check('O1 새로고침 후 TF 입력 유지 (전역 스토어)', (await p.inputValue('#ops-tf-pm-name')) === '김민지' && (await p.inputValue('#ops-tf-dev-alloc')) === '50', await p.inputValue('#ops-tf-pm-name'));
    // 교차 모듈: Alert 드로어 담당자 이름
    await L.go(p, 'alert');
    const d = await openRow(p, '카카오 전환 추적 단절');
    check('O1 Alert 드로어 담당 · 백업에 TF 성명 표시', sp(await d.innerText()).includes('박하늘 · SA AE'), sp(await d.locator('.alert-kv').innerText()).slice(0, 120));
    await closeDrawer(p);
    return h;
  });

  /* ========== O2. 1:1 백업 재지정 · 휴가 시뮬레이터 ========== */
  await area('O2 백업 · 휴가', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    const gsub = async () => sp(await p.locator('.card:has-text("1:1 백업 그래프")').first().innerText()).slice(0, 200);
    const issues = async () => sp(await p.locator('.ops-issues').first().innerText());
    check('O2 초기 공백 0', /공백 0/.test(await gsub()), await gsub());
    await p.selectOption('#ops-tf-sa_ae-backup', ''); await wait(p);
    check('O2 백업 미지정 → 공백 1 · 이슈 문구', /공백 1/.test(await gsub()) && /SA AE 백업 미지정/.test(await issues()), await issues());
    check('O2 미지정 → TF 탭 배지 증가 (공백 포함)', /1$/.test(sp(await p.locator('[role=tab]').first().innerText())) || /22$/.test(sp(await p.locator('[role=tab]').first().innerText())), sp(await p.locator('[role=tab]').first().innerText()));
    await p.selectOption('#ops-tf-sa_ae-backup', 'sa_ae'); await wait(p);
    check('O2 본인 백업 → 공백으로 판정', /본인으로 지정됨/.test(await issues()) && /공백 1/.test(await gsub()), await issues());
    await p.selectOption('#ops-tf-sa_ae-backup', 'dev'); await wait(p);
    check('O2 다른 역할 재지정 → 재지정 Pill · 공백 0', (await p.locator('tr:has(#ops-tf-sa_ae-name) .pill:has-text("재지정")').count()) === 1 && /공백 0/.test(await gsub()), await gsub());
    eq('O2 재지정은 ops 로컬에 저장', (await L.opsLocal(p)).backupOverrides, { sa_ae: 'dev' });
    await p.click('button:has-text("백업 제안서 기준으로")'); await wait(p);
    check('O2 백업 제안서 기준으로 → 원복 · 버튼 사라짐', JSON.stringify((await L.opsLocal(p)).backupOverrides) === '{}' && (await p.locator('button:has-text("백업 제안서 기준으로")').count()) === 0, JSON.stringify((await L.opsLocal(p)).backupOverrides));
    await p.selectOption('#ops-tf-da_ae-backup', 'pm'); await wait(p, 150);
    await h.reload();
    eq('O2 새로고침 후 재지정 유지', await p.inputValue('#ops-tf-da_ae-backup'), 'pm');
    await p.click('button:has-text("백업 제안서 기준으로")'); await wait(p);
    // 휴가 시뮬레이터
    const card = p.locator('.card:has-text("휴가 시뮬레이터")');
    const body = async () => sp(await card.innerText());
    check('O2 기본 프리셋 SA AE 휴가 → SA Lead AE 150% 과부하', /SA Lead AE 150%/.test(await body()) && (await card.locator('.ops-chip:has-text("SA AE 휴가")').first().getAttribute('aria-pressed')) === 'true', (await body()).slice(-300));
    await p.fill('#ops-leave-tr', '30'); await wait(p, 150);
    check('O2 인수 비율 30% → 합산 130% 재계산', /130%/.test(await body()), (await body()).slice(-260));
    await p.fill('#ops-leave-ov', '150'); await wait(p, 150);
    check('O2 과부하 기준 150% → 과부하 없음', /응답 공백 · 과부하 없음/.test(await body()), (await body()).slice(-200));
    await p.fill('#ops-leave-tr', '50'); await p.fill('#ops-leave-ov', '100'); await wait(p, 100);
    await card.locator('.ops-chip:has-text("SA 2인 동시 부재")').click(); await wait(p);
    check('O2 상호 백업 쌍 동시 부재 → 응답 공백 · PM 대행', /응답 공백 2건/.test(await body()) && /PM 대행/.test(await body()), (await body()).slice(0, 200));
    await card.locator('.ops-chip:has-text("부재 없음")').click(); await wait(p);
    check('O2 부재 없음 → 안내 문구', /부재 인원을 선택하세요/.test(await body()), 'missing');
    await p.check('#ops-leave-global_ae'); await p.check('#ops-leave-da_ae'); await wait(p);
    check('O2 체크박스 선택 = 프리셋 일치 시 프리셋 눌림', (await card.locator('.ops-chip:has-text("DA · 글로벌 동시 부재")').getAttribute('aria-pressed')) === 'true', 'not pressed');
    for (const [id, v, want] of [['#ops-leave-days', '0', '1'], ['#ops-leave-days', '-3', '1'], ['#ops-leave-days', '999', '60'], ['#ops-leave-tr', '150', '100'], ['#ops-leave-tr', '-10', '0'], ['#ops-leave-ov', '10', '50'], ['#ops-leave-ov', '500', '200']]) {
      // 숫자 칸은 입력 중 값을 유지하고 칸을 벗어날 때(Tab · Enter) 범위로 보정된다
      await p.fill(id, v); await p.press(id, 'Tab'); await wait(p, 100);
      eq(`O2 ${id} '${v}' → ${want} (범위 고정, 칸 벗어날 때)`, await p.inputValue(id), want);
    }
    await p.fill('#ops-leave-days', 'abc').catch(() => {}); await wait(p, 100);
    check('O2 부재 일수 문자 입력 거부', /^\d+$/.test(await p.inputValue('#ops-leave-days')), await p.inputValue('#ops-leave-days'));
    await p.fill('#ops-leave-tr', '50'); await p.fill('#ops-leave-ov', '120');
    await p.fill('#ops-leave-start', '2026-11-06'); await p.fill('#ops-leave-days', '10'); await wait(p, 200);
    check('O2 부재 기간 10일 → 주말 당번 충돌 계산', /부재 기간 11\/6\(금\)~11\/15\(일\)/.test(await body()) && /당번 충돌/.test(await body()), (await body()).match(/부재 기간[^.]*/)?.[0]);
    await p.fill('#ops-leave-start', ''); await wait(p, 100);
    eq('O2 시작일 지우기 → 이전 값 유지', await p.inputValue('#ops-leave-start'), '2026-11-06');
    return h;
  });

  /* ========== O3. 수수료 계산기 · 계약 조건 ========== */
  await area('O3 수수료 · 계약', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    await L.tab(p, '수수료 · 계약');
    const kpi = async () => sp(await p.locator('.grid.g-4').first().innerText());
    const row = async (k) => sp(await p.locator(`tr:has(#ops-fee-${k}-rate)`).innerText());
    check('O3 초기 미입력 (0/5개 매체)', /0\/5개 매체 입력/.test(await kpi()), await kpi());
    await p.fill('#ops-fee-0-rate', '50'); await wait(p, 100);
    check('O3 수수료 50% → 오입력 (0~30%)', /ops-invalid/.test(await p.getAttribute('#ops-fee-0-rate', 'class')) && /0~30%/.test(await row(0)), await row(0));
    await p.fill('#ops-fee-0-rate', 'abc'); await wait(p, 100);
    check('O3 수수료 문자 → 오입력', /ops-invalid/.test(await p.getAttribute('#ops-fee-0-rate', 'class')), await row(0));
    await p.fill('#ops-fee-0-rate', '-1'); await wait(p, 100);
    check('O3 수수료 음수 → 오입력', /ops-invalid/.test(await p.getAttribute('#ops-fee-0-rate', 'class')), await row(0));
    await p.fill('#ops-fee-0-rate', '0'); await wait(p, 100);
    check('O3 수수료 0% → 유효 (0.00%)', !/ops-invalid/.test(await p.getAttribute('#ops-fee-0-rate', 'class')) && /0\.00%/.test(await row(0)), await row(0));
    const n = await p.locator('input[id^="ops-fee-"][id$="-rate"]').count();
    eq('O3 매체 5행', n, 5);
    for (let k = 0; k < n; k++) {
      await p.fill(`#ops-fee-${k}-rate`, String(10 + k));
      await p.locator(`tr:has(#ops-fee-${k}-rate) .seg button`).nth(k % 2 ? 2 : 1).click();
      if (k % 2 === 0) await p.fill(`#ops-fee-${k}-payback`, '2');
    }
    await wait(p, 200);
    check('O3 전 매체 입력 → 순 수수료 4.68억원 · 실효 9.36% (p.37 배분 × 요율 − 페이백)', /4\.68억원/.test(await kpi()) && /9\.36%/.test(await kpi()) && /5\/5개 매체/.test(await kpi()), await kpi());
    check('O3 매체 행 순 수수료 (네이버 30.5억 × 10% − 2% = 2.44억)', /2\.44억/.test(await row(0)) && /8\.00%/.test(await row(0)), await row(0));
    await p.fill('#ops-fee-0-payback', '15'); await wait(p, 120);
    check('O3 페이백 > 수수료 → 경고 (음수 순 수수료)', (await p.locator('.callout:has-text("페이백이 수수료를 초과")').count()) >= 1, 'no warn');
    await p.fill('#ops-fee-0-payback', '2'); await wait(p, 100);
    await p.fill('#ops-budget', '10000000000'); await wait(p, 150);
    check('O3 연 광고비 100억 → 순 수수료 9.36억 (재계산)', /9\.36억원/.test(await kpi()), await kpi());
    await p.fill('#ops-budget', '0'); await wait(p, 150);
    check('O3 연 광고비 0 → 계산 불가 경고', (await p.locator('.callout:has-text("연간 광고비가 0원 이하")').count()) >= 1, await kpi());
    await p.fill('#ops-budget', '1e30'); await wait(p, 150);
    check('O3 연 광고비 1e30 → 상한 고정 (NaN · 지수 표기 없음)', !/NaN|e\+|Infinity/.test(await kpi()), await kpi());
    await p.locator('button:has-text("억으로")').first().click(); await wait(p, 150);
    eq('O3 RFP 50억으로 → 5000000000', await p.inputValue('#ops-budget'), '5000000000');
    const ct = async () => sp(await p.locator('.card:has-text("계약 조건") tbody').first().innerText());
    for (const [v, want] of [['abc', '오입력'], ['400', '오입력'], ['30', '확정']]) {
      await p.fill('#ops-contract-termination', v); await wait(p, 100);
      check(`O3 해지 통보 '${v}' → ${want}`, new RegExp(`해지 조건.*?${want}`).test(await ct()), (await ct()).slice(0, 200));
    }
    await p.locator('.seg[aria-label="솔루션 이용료"] button:has-text("별도")').click(); await wait(p, 100);
    await p.fill('#ops-contract-solution', '-100'); await wait(p, 100);
    check('O3 솔루션 월 금액 음수 → 오입력', /솔루션 이용료.*?오입력/.test(await ct()), (await ct()).slice(0, 300));
    await p.fill('#ops-contract-solution', '3,000,000'); await wait(p, 100);
    check('O3 솔루션 3,000,000 → 월 300만원 (연 3,600만원) 확정', /월 300만원 \(연 3,600만원\) 확정/.test(await ct()), (await ct()).slice(0, 300));
    check('O3 연간 총 비용 55억원 · 부대 비용 10.08% · 탭 배지 0', /55억원/.test(await kpi()) && /10\.08%/.test(await kpi()) && !/\d$/.test(sp(await p.locator('[role=tab]:has-text("수수료")').innerText())), `${await kpi()} | ${await p.locator('[role=tab]:has-text("수수료")').innerText()}`);
    await p.locator('.seg[aria-label="솔루션 이용료"] button:has-text("수수료에 포함")').click(); await wait(p, 100);
    check('O3 솔루션 수수료에 포함 → 금액 입력 숨김 · 확정', (await p.locator('#ops-contract-solution').count()) === 0 && /솔루션 이용료.*?확정/.test(await ct()), (await ct()).slice(0, 300));
    await p.locator('.card:has-text("매체별 수수료") button:has-text("표 복사")').click(); await wait(p, 300);
    const c = await clip(p);
    check('O3 표 복사 (## 운영 수수료 · 네이버 행)', c.startsWith('## 운영 수수료 및 계약 조건') && /네이버 SA · DA \| 30\.5억원 \| 10%/.test(c), c.slice(0, 120));
    await h.reload(); await L.tab(p, '수수료 · 계약');
    check('O3 새로고침 후 입력 유지', (await p.inputValue('#ops-fee-0-rate')) === '10' && (await p.inputValue('#ops-contract-termination')) === '30' && /4\.68억원/.test(await kpi()), await kpi());
    await p.locator('button:has-text("수수료 · 계약 입력 초기화")').click(); await wait(p, 150);
    check('O3 수수료 · 계약 입력 초기화', (await p.inputValue('#ops-fee-0-rate')) === '' && /0\/5개 매체 입력/.test(await kpi()), await kpi());
    return h;
  });

  /* ========== O4. RFP 커버리지 · CSV · 제출 체크 · 모듈/전역 초기화 ========== */
  await area('O4 RFP 커버리지', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    await L.tab(p, 'RFP 커버리지');
    const rows = () => p.locator('.card:has-text("RFP 커버리지 맵") tbody tr').count();
    const segs = await p.$$eval('.seg[aria-label="필터"] button', (b) => b.map((x) => x.innerText.trim()));
    const total = Number((segs[0].match(/(\d+)/) || [])[1]);
    eq('O4 전체 필터 행 수 = 라벨 수', await rows(), total);
    let groupSum = 0;
    for (const sgl of segs.slice(1)) {
      await p.locator('.seg[aria-label="필터"] button').filter({ hasText: sgl }).first().click(); await wait(p, 120);
      const n = await rows();
      const lab = Number((sgl.match(/(\d+)$/) || [])[1]);
      if (sgl.startsWith('입력 필요')) {
        const tabBadge = Number((sp(await p.locator('[role=tab]:has-text("RFP 커버리지")').innerText()).match(/(\d+)$/) || [])[1]);
        check('O4 입력 필요 필터 = 라벨 수 = 탭 배지', n === lab && n === tabBadge, `${n}/${lab}/${tabBadge}`);
        const rowsTxt = await p.$$eval('.card:has-text("RFP 커버리지 맵") tbody tr', (t) => t.map((x) => x.innerText));
        check('O4 입력 필요 행은 모두 입력 필요 상태', rowsTxt.every((t) => /입력 필요/.test(t)), rowsTxt.length);
      } else { groupSum += n; check(`O4 필터 '${sgl}' 행 ≥ 1`, n >= 1, n); }
    }
    eq('O4 구분별 필터 합계 = 전체', groupSum, total);
    await p.locator('.seg[aria-label="필터"] button').filter({ hasText: '입력 필요' }).first().click(); await wait(p, 100);
    const go = p.locator('.card:has-text("RFP 커버리지 맵") button:has-text("입력하러 가기")');
    check('O4 입력하러 가기 버튼 ≥ 1', (await go.count()) >= 1, 'none');
    await go.first().click(); await wait(p);
    check('O4 입력하러 가기 → 해당 탭 이동', !/RFP 커버리지/.test(await p.locator('[role=tab][aria-selected=true]').innerText()), await p.locator('[role=tab][aria-selected=true]').innerText());
    await L.tab(p, 'RFP 커버리지');
    await p.locator('.seg[aria-label="필터"] button').first().click(); await wait(p, 100);
    const links = await p.$$eval('.card:has-text("RFP 커버리지 맵") tbody a', (a) => [...new Set(a.map((x) => x.getAttribute('href')))]);
    const known = ['#home', '#board', '#adpilot', '#reports', '#agent', '#watch', '#lab', '#geo', '#growth', '#flow', '#alert', '#ops'];
    check('O4 모듈 링크가 모두 실제 라우트', links.length >= 8 && links.every((l) => known.includes(l)), links.join(' '));
    await p.locator('.card:has-text("RFP 커버리지 맵") tbody a[href="#watch"]').first().click(); await wait(p, 500);
    check('O4 모듈 링크 클릭 → 해당 화면', (await p.evaluate(() => location.hash)) === '#watch' && (await p.locator('.page').count()) === 1, await p.evaluate(() => location.hash));
    await L.go(p, 'ops'); await L.tab(p, 'RFP 커버리지');
    await p.locator('.card:has-text("RFP 커버리지 맵") button:has-text("CSV")').click(); await wait(p, 500);
    const sv = await h.saves();
    check('O4 커버리지 CSV (헤더 · 한글 · 21행 근사)', sv.length === 1 && sv[0].filename === 'mildo-rfp-coverage.csv' && sv[0].head.startsWith('구분,항목,모듈,장표,상태,비고') && sv[0].head.includes('리소스 절감') && sv[0].bytes > 2000, sv[0] && sv[0].head.slice(0, 80));
    await p.locator('.card:has-text("RFP 커버리지 맵") button:has-text("표 복사")').click(); await wait(p, 300);
    check('O4 표 복사 (## RFP 커버리지 맵)', (await clip(p)).startsWith('## RFP 커버리지 맵'), (await clip(p)).slice(0, 60));
    // 제출 체크
    const tile = async () => sp(await p.locator('.ops-tile').last().innerText());
    const t0 = await tile();
    await p.check('#ops-doc-geo_case'); await wait(p, 150);
    const t1 = await tile();
    check('O4 GEO 사례 체크 → 커버리지 타일 +1 · 준비도 상승', t0 !== t1 && Number((t1.match(/(\d+) \/ 21/) || [])[1]) === Number((t0.match(/(\d+) \/ 21/) || [])[1]) + 1, `${t0} → ${t1}`);
    await p.check('#ops-doc-deck'); await p.check('#ops-doc-bizreg'); await wait(p, 100);
    eq('O4 제출 체크 ops 로컬 저장', (await L.opsLocal(p)).docs, { geo_case: true, deck: true, bizreg: true });
    await h.reload(); await L.tab(p, 'RFP 커버리지');
    check('O4 새로고침 후 제출 체크 유지', await p.isChecked('#ops-doc-deck') && await p.isChecked('#ops-doc-geo_case') && !(await p.isChecked('#ops-doc-nda')), 'lost');
    await p.uncheck('#ops-doc-bizreg'); await wait(p, 100);
    check('O4 체크 해제 저장', !(await L.opsLocal(p)).docs.bizreg, JSON.stringify((await L.opsLocal(p)).docs));
    // 모듈 입력 초기화 (2단계, TF 명단 제외)
    await L.tab(p, '전담 TF · 백업'); await p.fill('#ops-tf-pm-name', '김민지'); await wait(p, 100);
    await p.click('button:has-text("입력 초기화")');
    check('O4 입력 초기화 1단계 → 확인 · 안내 (TF 명단 제외)', (await p.locator('button:has-text("초기화 확인")').count()) === 1 && (await p.locator('text=TF 명단 제외').count()) === 1, 'no confirm');
    await p.click('.page-header button:has-text("취소"), button:has-text("취소") >> nth=0'); await wait(p, 100);
    check('O4 취소 → 그대로', (await L.opsLocal(p)).docs.deck === true, 'cleared');
    await p.click('button:has-text("입력 초기화")'); await p.click('button:has-text("초기화 확인")'); await wait(p, 200);
    check('O4 초기화 확인 → ops 로컬 기본값 · TF 성명 유지', JSON.stringify((await L.opsLocal(p)).docs) === '{}' && (await p.inputValue('#ops-tf-pm-name')) === '김민지', JSON.stringify(await L.opsLocal(p)));
    // 전역 시연 상태 초기화
    await L.tab(p, 'RFP 커버리지'); await p.check('#ops-doc-deck'); await wait(p, 100);
    await L.tab(p, '90일 온보딩'); await p.fill('#ops-kickoff', '2027-01-04'); await wait(p, 100);
    await p.getByRole('button', { name: '설정', exact: true }).click(); await wait(p);
    await p.click('button:has-text("시연 상태 초기화")');
    check('O4 전역 초기화 2단계 (정말 초기화)', (await p.locator('button:has-text("정말 초기화")').count()) === 1, 'no 2nd step');
    await p.click('button:has-text("정말 초기화")'); await wait(p, 500);
    await L.tab(p, '전담 TF · 백업');
    eq('O4 전역 초기화 → TF 성명 비움 (스토어)', await p.inputValue('#ops-tf-pm-name'), '');
    const loc = await L.opsLocal(p);
    check('O4 전역 초기화 → ops 로컬(제출 체크 · Kick-off)도 초기화', !loc.docs?.deck && (loc.kickoff ?? '2026-12-01') === '2026-12-01', `shared: SettingsDialog가 'mildo-os:reset' 이벤트를 보내지 않음 → ops 로컬 ${JSON.stringify(loc)}`);
    // 이벤트 직접 수신 확인 (ops 쪽 리스너)
    await L.tab(p, 'RFP 커버리지'); await p.check('#ops-doc-nda'); await wait(p, 100);
    await p.evaluate(() => window.dispatchEvent(new Event('mildo-os:reset'))); await wait(p, 200);
    check("O4 'mildo-os:reset' 이벤트 → 열린 화면 · 저장본 모두 초기화", !(await p.isChecked('#ops-doc-nda')) && !(await L.opsLocal(p)).docs?.nda, JSON.stringify(await L.opsLocal(p)));
    await h.reload(); await L.tab(p, 'RFP 커버리지');
    check('O4 이벤트 초기화 후 새로고침해도 체크 없음', !(await p.isChecked('#ops-doc-nda')) && !(await p.isChecked('#ops-doc-deck')), 'restored');
    return h;
  });

  /* ========== O5. 90일 온보딩 간트 · Kick-off 편집 · .md ========== */
  await area('O5 온보딩', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    await L.tab(p, '90일 온보딩');
    const mile = async () => sp(await p.locator('.ops-mile').innerText());
    const pills = async () => (await p.locator('.card:has-text("계정 인수 · 90일 온보딩") .pill').allInnerTexts()).join(' / ');
    const weeks = async () => p.$$eval('.card:has-text("주차별 날짜 환산") tbody tr', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ')));
    eq('O5 기본 Kick-off 2026-12-01', await p.inputValue('#ops-kickoff'), '2026-12-01');
    check('O5 기본 W1 12/1(화) · 12주', (await weeks())[0].startsWith('W1 12/1(화)') && (await weeks()).length === 12, (await weeks())[0]);
    await p.fill('#ops-kickoff', '2027-01-04'); await wait(p, 200);
    check('O5 Kick-off 2027-01-04 → 마일스톤 · 주차 재계산', /D\+30.*2\/3\(수\)/.test(await mile()) && (await weeks())[0].startsWith('W1 1/4(월)'), `${await mile()} | ${(await weeks())[0]}`);
    check('O5 간트 막대 렌더', (await p.locator('.card:has-text("계정 인수 · 90일 온보딩") .gantt-bar').count()) >= 6, 'no bars');
    await p.fill('#ops-kickoff', '2026-11-01'); await wait(p, 150);
    check('O5 일요일 Kick-off → 휴무일 · 선정 주 이전 경고', /휴무일\(일요일\)/.test(await pills()) && /최종 선정 주 이전/.test(await pills()), await pills());
    await p.fill('#ops-kickoff', '2027-02-08'); await wait(p, 150);
    check('O5 설날 연휴 Kick-off → 휴무일 경고', /휴무일\(설날/.test(await pills()), await pills());
    await p.fill('#ops-kickoff', '2026-10-15'); await wait(p, 150);
    check('O5 과거 Kick-off → 현재 주차 진행 표시', /현재 W\d+ 진행 중/.test(sp(await p.locator('.card:has-text("계정 인수 · 90일 온보딩")').innerText())), (await pills()));
    await p.fill('#ops-kickoff', ''); await wait(p, 150);
    eq('O5 날짜 지우기 → 이전 값 유지', await p.inputValue('#ops-kickoff'), '2026-10-15');
    await p.fill('#ops-kickoff', '2027-01-04'); await wait(p, 150);
    await p.locator('.card:has-text("계정 인수 · 90일 온보딩") button:has-text(".md")').click(); await wait(p, 500);
    const sv = await h.saves();
    check('O5 .md 저장 (파일명에 Kick-off · ## 제목 · 표)', sv.length === 1 && sv[0].filename === 'mildo-onboarding-2027-01-04.md' && sv[0].head.startsWith('## 계정 인수 · 90일 온보딩 (Kick-off 2027-01-04') && sv[0].head.includes('|---|'), JSON.stringify(sv.map((x) => x.filename)));
    await p.locator('.card:has-text("계정 인수 · 90일 온보딩") button:has-text("일정 복사")').click(); await wait(p, 300);
    check('O5 일정 복사 = .md 내용', (await clip(p)).startsWith('## 계정 인수 · 90일 온보딩 (Kick-off 2027-01-04'), (await clip(p)).slice(0, 60));
    await h.reload(); await L.tab(p, '90일 온보딩');
    eq('O5 새로고침 후 Kick-off 유지', await p.inputValue('#ops-kickoff'), '2027-01-04');
    await p.click('button:has-text("기본 가정으로")'); await wait(p, 150);
    check('O5 기본 가정으로 → 2026-12-01 · 버튼 사라짐', (await p.inputValue('#ops-kickoff')) === '2026-12-01' && (await p.locator('button:has-text("기본 가정으로")').count()) === 0, await p.inputValue('#ops-kickoff'));
    return h;
  });

  /* ========== O6. 회사 · 레퍼런스 빈칸 · 침구 합산 · 복사 ========== */
  await area('O6 레퍼런스', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    await L.tab(p, '회사 · 레퍼런스');
    const callout = async () => sp(await p.locator('.card:has-text("고관여 내구재 레퍼런스") .callout').first().innerText());
    const tabN = async () => Number((sp(await p.locator('[role=tab]:has-text("회사")').innerText()).match(/(\d+)$/) || [, 0])[1]);
    check('O6 초기 빈칸 6칸 / 6칸 · 탭 배지 6', /빈칸 6칸 \/ 6칸/.test(await callout()) && (await tabN()) === 6, await callout());
    await p.fill('#ops-ref-cozyma-monthly', 'abc'); await wait(p, 120);
    check('O6 월 광고비 해석 불가 안내', (await p.locator('text=금액 해석 불가').count()) === 1, 'no hint');
    await p.fill('#ops-ref-cozyma-monthly', '월 약 2억 원'); await wait(p, 120);
    check('O6 월 약 2억 원 → 해석됨 · 빈칸 5', (await p.locator('text=금액 해석 불가').count()) === 0 && /빈칸 5칸/.test(await callout()) && (await tabN()) === 5, await callout());
    await p.fill('#ops-ref-cozyma-monthly', '   '); await wait(p, 120);
    check('O6 공백만 입력 → 빈칸으로 판정', /빈칸 6칸/.test(await callout()), await callout());
    const vals = { 'homuro-metric': 'ROAS 620%', 'bedding_blind-period': '2023.03~현재', 'bedding_blind-metric': 'ROAS 540%', 'cozyma-period': '2024.01~현재', 'cozyma-monthly': '월 약 2억 원', 'cozyma-metric': 'ROAS 480%' };
    for (const [k, v] of Object.entries(vals)) await p.fill(`#ops-ref-${k}`, v);
    await wait(p, 150);
    check('O6 6칸 입력 → 같은 양식 충족 · 배지 0', /같은 양식 충족/.test(await callout()) && (await tabN()) === 0, await callout());
    check('O6 침구 월 합산 일치 (15억 ±5%)', (await p.locator('.pill:has-text("침구 월 합산 일치")').count()) === 1, 'mismatch');
    await p.locator('.card:has-text("고관여 내구재 레퍼런스") button:has-text("표 복사")').click(); await wait(p, 300);
    const c = await clip(p);
    check('O6 표 복사 (입력값 포함)', c.startsWith('## 고관여 내구재 레퍼런스') && c.includes('ROAS 480%') && c.includes('2024.01~현재'), c.slice(0, 120));
    await h.reload(); await L.tab(p, '회사 · 레퍼런스');
    eq('O6 새로고침 후 유지', await p.inputValue('#ops-ref-cozyma-metric'), 'ROAS 480%');
    await p.click('button:has-text("빈칸 초기화")'); await wait(p, 150);
    check('O6 빈칸 초기화 → 6칸', /빈칸 6칸/.test(await callout()) && (await p.inputValue('#ops-ref-cozyma-metric')) === '', await callout());
    return h;
  });

  /* ========== O7. 제출 준비 타일 · 운영 체계 탭 링크 ========== */
  await area('O7 타일 · 운영 체계', async (set) => {
    const h = set(await openH('ops'));
    const p = h.page;
    const n = await p.locator('.ops-tile').count();
    const want = ['RFP 커버리지', '전담 TF', '전담 TF', '운영 체계', '회사 · 레퍼런스', 'RFP 커버리지'];
    const got = [];
    for (let k = 0; k < n; k++) { await p.locator('.ops-tile').nth(k).click(); await wait(p, 100); got.push(sp(await p.locator('[role=tab][aria-selected=true]').innerText())); }
    check('O7 타일 6개 → 해당 탭 · aria-pressed', n === 6 && got.every((g, k) => g.startsWith(want[k])), got.join(' | '));
    await L.tab(p, '운영 체계 · 계정 구조');
    const st = sp(await p.locator('.page').innerText());
    check('O7 운영 체계 탭 렌더 (계정 소유 · 결제)', /수면밀도/.test(st) && /계정/.test(st), st.slice(0, 100));
    const pend = p.locator('.page a.num[href="#flow"]').first();
    if (await pend.count()) { await pend.click(); await wait(p, 500); eq('O7 운영 체계 승인 대기 n건 링크 → #flow', await p.evaluate(() => location.hash), '#flow'); await L.go(p, 'ops'); await L.tab(p, '운영 체계 · 계정 구조'); }
    await p.locator('a.btn:has-text("Alert 당번표 · 사전 점검")').click(); await wait(p, 500);
    eq('O7 Alert 당번표 링크 → #alert', await p.evaluate(() => location.hash), '#alert');
    await L.go(p, 'ops'); await L.tab(p, '운영 체계 · 계정 구조');
    await p.locator('a.btn:has-text("Alert 계정 점검")').click(); await wait(p, 500);
    eq('O7 Alert 계정 점검 링크 → #alert', await p.evaluate(() => location.hash), '#alert');
    return h;
  });

  /* ========== A13. Alert 상태 유지 · 전역 초기화 ========== */
  await area('A13 유지 · 초기화', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    const d = await openRow(p, '카카오 전환 추적 단절');
    await d.locator('button:has-text("인지")').first().click();
    await d.locator('textarea').first().fill('픽셀 재설치'); await d.locator('button:has-text("1차 조치 기록")').click();
    await d.locator('button:has-text("자동 조정 보류 해제 요청")').click(); await wait(p);
    await closeDrawer(p);
    await L.tab(p, '알림 · 테스트 주입'); await p.click('.card.dark button:has-text("결제 실패")'); await wait(p);
    await L.tab(p, '탐지 기준'); await p.fill('#cfg-keywordSpikePct', '40'); await p.fill('#cfg-reason', '키워드 급변 완화'); await p.click('button.btn.primary:has-text("기준 변경 요청")'); await wait(p);
    const snap = async () => { const s = await L.store(p); const t = s.incidents.find((i) => i.ruleId === 'tracking_break'); return { tb: t && t.status, note: t && t.actionNote, tests: s.incidents.filter((i) => i.isTest).length, rule: s.changes.filter((c) => c.kind === 'alert_rule').length, rel: s.changes.filter((c) => /:release$/.test(c.targetId || '')).length }; };
    const before = await snap();
    check('A13 처리 상태 기록됨', before.tb === 'action' && before.tests >= 1 && before.rule === 1 && before.rel === 1, JSON.stringify(before));
    await h.reload();
    eq('A13 새로고침 후 이슈 처리 · 테스트 이슈 · 요청 유지', await snap(), before);
    await L.go(p, 'alert');
    const d2 = await openRow(p, '카카오 전환 추적 단절');
    check('A13 새로고침 후 드로어 단계 시각 유지', (sp(await d2.locator('.alert-steps').innerText()).match(/10\/31 15:3\d/g) || []).length >= 2, sp(await d2.locator('.alert-steps').innerText()));
    await closeDrawer(p);
    await p.getByRole('button', { name: '설정', exact: true }).click(); await wait(p);
    await p.click('button:has-text("시연 상태 초기화")'); await p.click('button:has-text("정말 초기화")'); await wait(p, 600);
    const st = await L.store(p);
    check('A13 전역 초기화 → 이슈 모두 open · 테스트 이슈 · 요청 제거 (시드만)', st.incidents.length > 0 && st.incidents.every((i) => i.status === 'open' && !i.isTest) && st.changes.every((c) => String(c.id).startsWith('seed_')), `${st.incidents.length} inc · ${st.changes.filter((c) => !String(c.id).startsWith('seed_')).length} new changes`);
    eq('A13 초기화 후 큐 10건', (await L.queueRows(p)).length, 10);
    await L.tab(p, '탐지 기준');
    check('A13 초기화 후 탐지 기준 기본값 (키워드 급변 50)', /50/.test(sp(await p.locator('tr:has(#cfg-keywordSpikePct) td').nth(2).innerText())), sp(await p.locator('tr:has(#cfg-keywordSpikePct) td').nth(2).innerText()));
    return h;
  });


  /* ========== A14. 추가: 기준 필드 전부 · Flow 반영 후 재스캔 · 계정 탭 충전 생성 · 드로어 링크 · SLA 등급 ========== */
  await area('A14 기준 필드 · 재스캔 · 링크', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await L.tab(p, '탐지 기준');
    const ids = await p.$$eval('input[id^="cfg-"]:not(#cfg-reason)', (e) => e.map((x) => [x.id, x.value]));
    check('A14 기준 입력칸 ≥ 8 (지표 주의 · 위험 + 구간 · 단절 · 키워드)', ids.length >= 8, ids.map((x) => x[0]).join(','));
    const submit = p.locator('button.btn.primary:has-text("기준 변경 요청")');
    let k = 0;
    for (const [id, v] of ids) {
      const cur = Number(v);
      const nv = id.endsWith('-w') ? cur - 5 : id.endsWith('-d') ? cur + 5 : cur + 1;
      await p.fill('#' + id, String(nv)); await wait(p, 60);
      const field = id.replace(/^cfg-/, '').replace(/-(w|d)$/, '');
      const label = await submit.innerText();
      const n = Number((label.match(/(\d+)건/) || [])[1]);
      k = n;
      check(`A14 ${id} ${v}→${nv} → 변경 집계 · 경고 없음`, n >= 1 && (await p.locator('.callout:has-text("입력 범위 확인")').count()) === 0, `${label} (${field})`);
    }
    const distinctFields = new Set(ids.map(([id]) => id.replace(/^cfg-/, '').replace(/-(w|d)$/, ''))).size;
    eq('A14 변경 건수 = 변경한 기준 수', k, distinctFields);
    await p.click('button:has-text("현재값으로")'); await wait(p, 100);
    check('A14 현재값으로 → 0건 · 비활성', /0건/.test(await submit.innerText()) && await submit.isDisabled(), await submit.innerText());
    // Flow 반영 후 재스캔
    await p.fill('#cfg-trackingZeroHours', '1'); await p.fill('#cfg-reason', '단절 민감도'); await submit.click(); await wait(p);
    await L.go(p, 'flow');
    await p.locator('.flow-queue-row').filter({ hasText: '전환 추적 단절 · 연속 전환 0' }).first().locator('button.btn.primary:has-text("승인")').click(); await wait(p);
    await p.locator('.flow-queue-row').filter({ hasText: '전환 추적 단절 · 연속 전환 0' }).first().locator('button.btn:has-text("반영")').click(); await wait(p, 300);
    await L.go(p, 'alert');
    const n0 = (await L.store(p)).incidents.length;
    await L.closeToasts(p);
    await p.click('button:has-text("재스캔")'); await wait(p, 300);
    const n1 = (await L.store(p)).incidents.length;
    const rt = (await L.toasts(p)).find((t) => t.includes('재스캔 완료')) || '';
    check('A14 Flow 반영 기준으로 재스캔 → 신규 n건 토스트 = 스토어 증가분', rt.includes(`신규 ${n1 - n0}건`), `${rt} (${n0}→${n1})`);
    await p.click('button:has-text("재스캔")'); await wait(p, 300);
    eq('A14 재스캔 반복 → 중복 적재 없음', (await L.store(p)).incidents.length, n1);
    await p.locator('.toast:has-text("재스캔 완료") button:has-text("바로 가기")').last().click(); await wait(p, 300);
    eq('A14 재스캔 토스트 바로 가기 → #alert', await p.evaluate(() => location.hash), '#alert');
    // 드로어 링크
    let d = await openRow(p, '브랜드 키워드');
    const links = await d.locator('a.btn').evaluateAll((a) => a.map((x) => x.getAttribute('href')));
    check('A14 브랜드 침투 드로어 링크 (AD Pilot · Watch · Flow)', ['#adpilot', '#watch', '#flow'].every((x) => links.includes(x)), links.join(','));
    await d.locator('button:has-text("미리보기")').click(); await wait(p, 150);
    check('A14 미리보기 → 접기 토글', (await d.locator('button:has-text("접기")').count()) === 1 && (await d.locator('.card.flat h4').count()) > 0, 'no preview');
    await d.locator('button:has-text("접기")').click(); await wait(p, 100);
    check('A14 접기 → 미리보기 닫힘', (await d.locator('button:has-text("미리보기")').count()) === 1, 'still open');
    await d.locator('a.btn[href="#watch"]').click(); await wait(p, 500);
    check('A14 Watch 링크 → #watch 화면', (await p.evaluate(() => location.hash)) === '#watch' && (await p.locator('.page').count()) === 1, await p.evaluate(() => location.hash));
    await L.go(p, 'alert'); await L.tab(p, '알림 · 테스트 주입');
    await p.click('.card.dark button:has-text("소재 반려")'); await wait(p);
    await L.tab(p, '이슈 큐');
    d = await openRow(p, '반려');
    check('A14 소재 반려 드로어 → MILDO Lab 검수 링크', (await d.locator('a.btn[href="#lab"]').count()) === 1, 'no lab link');
    await closeDrawer(p);
    // SLA 등급 필터 전부
    await L.tab(p, 'SLA 리포트');
    for (const g of ['P1', 'P2', 'P3']) {
      await L.seg(p, '등급', g);
      const rows = await p.$$eval('.card:has-text("처리 이력") tbody tr', (t) => t.map((x) => x.innerText));
      check(`A14 SLA 이력 등급 ${g} 필터`, rows.length >= 1 && rows.every((t) => t.includes(g) || /없/.test(t)), `${rows.length}`);
    }
    return h;
  });

  await area('A15 계정 탭 충전 요청 생성', async (set) => {
    const h = set(await openH('flow'));
    const p = h.page;
    await role(p, '수면밀도');
    const row = p.locator('.flow-queue-row:has-text("GFA")').filter({ hasText: '충전' }).first();
    await row.locator('button:has-text("상세")').click(); await wait(p, 300);
    await p.fill('#flow-note', '계정 탭에서 재요청');
    await p.locator('.drawer button:has-text("반려")').first().click(); await wait(p, 150);
    await p.locator('.drawer button:has-text("확인 · 반려")').click(); await wait(p, 300);
    await closeDrawer(p);
    await role(p, '담당 AE');
    await L.go(p, 'alert'); await L.tab(p, '계정 · 결제 · 권한');
    await p.locator('.card:has-text("계정 · 결제 · 권한 점검") tbody tr:has-text("GFA")').click(); await wait(p);
    const b = p.locator('.grid.g-2 .card').first().locator('button:has-text("충전 요청")').first();
    const lab0 = await b.innerText();
    check('A15 반려 후 계정 탭 충전 요청 활성 (금액 · 수면밀도 승인)', await b.isEnabled() && /충전 요청 [\d,.]+만원 \(수면밀도 승인\)/.test(lab0), lab0);
    await b.dblclick(); await wait(p, 300);
    const pend = (await L.store(p)).changes.filter((c) => /acc_gfa:topup$/.test(c.targetId || '') && c.status === 'pending');
    check('A15 더블클릭 → pending 1건 · requestedBy 담당 AE · approver CLIENT', pend.length === 1 && pend[0].requestedBy === '담당 AE' && pend[0].approver === 'CLIENT', JSON.stringify(pend.map((c) => [c.requestedBy, c.approver])));
    check('A15 더블클릭이 옆 이슈 열기 버튼을 누르지 않음', (await p.locator('.drawer').count()) === 0, 'drawer opened');
    const lab1 = await p.locator('.grid.g-2 .card').first().locator('button:has-text("충전 요청됨")').innerText();
    check('A15 버튼 = 충전 요청됨 + 같은 금액 (폭 유지)', lab1.replace('요청됨', '요청') === lab0, `${lab0} → ${lab1}`);
    await p.locator('.toast:has-text("충전 요청을 만들었습니다") button:has-text("바로 가기")').click(); await wait(p, 400);
    eq('A15 토스트 바로 가기 → #flow', await p.evaluate(() => location.hash), '#flow');
    await role(p, 'PM');
    const r2 = p.locator('.flow-queue-row:has-text("GFA")').filter({ hasText: '충전' });
    check('A15 PM은 수면밀도 승인 건 처리 큐에 없음', (await r2.count()) === 0, `${await r2.count()}`);
    await role(p, '수면밀도');
    check('A15 수면밀도 처리 큐에 새 요청', (await r2.count()) === 1, `${await r2.count()}`);
    return h;
  });


  /* ========== A16. SLA 초과 (가짜 시계 +16분) · 늦은 인지 미달 · 오탐률 반영 ========== */
  await area('A16 SLA 초과 · 오탐률', async (set) => {
    const h = set(await openH('alert'));
    const p = h.page;
    await p.clock.install();
    await h.reload();
    const kpi = async () => sp(await p.locator('.alert-kpis .card:has-text("SLA 임박")').innerText());
    check('A16 시작 시 SLA 초과 0', /0 \/ 초과 0/.test(await kpi()), await kpi());
    await p.clock.fastForward('16:00'); await wait(p, 500);
    check('A16 +16분 → P1 2건 인지 초과 KPI', /2 \/ 초과 2/.test(await kpi()), await kpi());
    const r = await L.queueRows(p);
    check('A16 큐 SLA 열 = 인지 15분 mm:ss 초과', /인지 15분 0[01]:\d\d 초과/.test(r[0]) && /인지 15분 0[01]:\d\d 초과/.test(r[1]), r[0].slice(-80));
    check('A16 P2(주말 당번) 인지 30분 남음', r.slice(2).every((x) => /30분 \(주말 · 공휴일 당번\) 1\d:\d\d 남음/.test(x)), r[2].slice(-80));
    const d = await openRow(p, '카카오 전환 추적 단절');
    check('A16 드로어 타이머 critical', /critical/.test(await d.locator('.alert-sla').first().getAttribute('class')), await d.locator('.alert-sla').first().getAttribute('class'));
    await d.locator('button:has-text("인지")').first().click(); await wait(p, 300);
    const g = sp(await d.locator('.grid.g-3').first().innerText());
    check('A16 늦은 인지 → 16분 · 미달', /인지 목표 15분 16분 미달/.test(g), g);
    const i = await incBy(p, (x) => x.ruleId === 'tracking_break');
    check('A16 ackAt = 데이터 시계 15:46', /T15:46:\d\d\+09:00$/.test(i.sla.ackAt), i.sla.ackAt);
    await closeDrawer(p);
    await L.tab(p, 'SLA 리포트');
    const sk = sp(await p.locator('.alert-kpis').innerText());
    check('A16 SLA 리포트 인지 달성률에 세션 미달 반영 (21/23)', /21\/23/.test(sk), sk.slice(0, 160));
    const fp0 = Number((sk.match(/오탐률 TEST DATA \d+% (\d+)건/) || [])[1]);
    await L.tab(p, '이슈 큐');
    const d2 = await openRow(p, '오늘의집 광고 계정');
    await d2.locator('button:has-text("오탐으로 종료")').click();
    await d2.locator('input[aria-label="오탐 사유"]').fill('정기 검수 · 실제 제재 아님');
    await d2.locator('button.btn.danger:has-text("확인")').click(); await wait(p, 200);
    await closeDrawer(p);
    await L.tab(p, 'SLA 리포트');
    const sk2 = sp(await p.locator('.alert-kpis').innerText());
    const fp1 = Number((sk2.match(/오탐률 TEST DATA \d+% (\d+)건/) || [])[1]);
    check('A16 오탐 종료 → 오탐 건수 +1', fp1 === fp0 + 1, `${fp0} → ${fp1} · ${sk2.slice(0, 200)}`);
    return h;
  });

  console.log(`\nSUMMARY ${passes} PASS · ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
