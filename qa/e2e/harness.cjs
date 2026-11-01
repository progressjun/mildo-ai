/**
 * MILDO OS 기능 점검 하네스 — Playwright + 가짜 claude.ai 아티팩트 런타임 (계약 0.2.96 기준)
 *
 * const { open } = require(require('path').join(__dirname, 'harness.cjs'));
 * const h = await open({ file: '<repo>/dist-single/index.html', route: 'agent', ai: 'artifact', downloads: 'accept', width: 1440 });
 *   ai: 'none'      → window.claude 없음 (규칙 엔진, 일반 브라우저 Blob 다운로드)
 *       'artifact'  → sample 정상: onText 3회 스트리밍 후 resolve, tools가 있으면 각 도구 execute({})를 실제 호출
 *       'denied'    → 모든 호출 reject {code:'not_granted'}
 *       'rate'      → reject {code:'rate_limited'}
 *       'error-mid' → 첫 조각 스트리밍 후 reject {code:'upstream_error', text}
 *       'slow'      → 조각 사이 1.5초 (중지 버튼 · 취소 테스트용)
 *       'unavailable' → claude.use('sample') 가 null (아티팩트지만 AI 불가)
 *   downloads: 'accept' | 'decline' | 'none'(use('downloads') → null)   (ai:'none'이면 무시: Playwright download 이벤트로 수집)
 * h.page, h.browser, h.errors (콘솔 error + pageerror), h.downloads (일반 브라우저 다운로드 파일명)
 * await h.calls()  → [{kind:'sample'|'json', inputBytes, turns, tools:[names], toolResults:[{name, bytes, error?}], modelTier, cache}]
 * await h.saves()  → [{filename, bytes, head}]
 * await h.dismissToasts();  await h.close();
 * JSON 응답(sample.json)은 페이지에서 window.__mockJson = (input) => 값  으로 지정 (기본: 빈 배열 [])
 * 텍스트 응답은 window.__mockText = (input) => '...' 로 바꿀 수 있음
 */
const { chromium } = require('playwright');

const INIT = (cfg) => {
  const ALLOWED = 'gif png jpg jpeg webp mp4 webm mov txt json md docx pptx epub csv ttf html svg pdf xlsx zip fig'.split(' ');
  window.__sampleCalls = [];
  window.__saves = [];
  if (cfg.ai === 'none') return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rej = (code, message, text) => { const e = { code, message }; if (text !== undefined) e.text = text; return e; };
  const bytes = (s) => new TextEncoder().encode(s).length;
  const defaultText = (input) => {
    const q = typeof input === 'string' ? input : input[input.length - 1].content;
    return `### 확정 팩트\n- (모의 응답) 질문 길이 ${q.length}자를 받았습니다.\n\n### 반복 관측 패턴\n- 모의 패턴.\n\n### AI 해석\n- 모의 해석입니다.\n\n### 전제 조건 · 기준값\n- 목표 ROAS 400%.\n\n### 반례 · 대체 시나리오\n- 모의 반례.\n\n### 다음 액션\n- 모의 액션.`;
  };
  async function run(kind, input, opts = {}) {
    if (!(typeof input === 'string' && input.length) && !(Array.isArray(input) && input.length && input[0].role === 'user' && input[input.length - 1].role === 'user' && input.every((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.length))) {
      throw rej('invalid_request', 'input must be a non-empty string or turns starting and ending on user');
    }
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw rej('invalid_request', 'options must be a plain object');
    if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) throw rej('invalid_request', 'signal must be an AbortSignal');
    if (opts.tools && opts.cache !== undefined && opts.cache !== false) throw rej('invalid_request', 'cache with tools');
    if (opts.modelTier !== undefined && !['default', 'complex', 'quick', 'inherit'].includes(opts.modelTier)) throw rej('invalid_request', 'unknown modelTier');
    const text0 = typeof input === 'string' ? input : input.map((t) => t.content).join('\n');
    const call = { kind, inputBytes: bytes(text0), turns: Array.isArray(input) ? input.length : 1, tools: (opts.tools || []).map((t) => t.name), toolResults: [], modelTier: opts.modelTier, cache: opts.cache };
    window.__sampleCalls.push(call);
    if (call.inputBytes > 262144) throw rej('prompt_too_large', 'over 256 KiB');
    await sleep(30);
    if (opts.signal?.aborted) throw rej('cancelled', 'aborted');
    if (cfg.ai === 'denied') throw rej('not_granted', 'viewer declined');
    if (cfg.ai === 'rate') throw rej('rate_limited', 'too many');
    if (opts.tools) {
      for (const t of opts.tools.slice(0, 3)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(t.name) || !t.description) throw rej('invalid_request', `bad tool ${t.name}`);
        try {
          const ac = new AbortController();
          const r = await t.execute({}, { signal: ac.signal });
          const s = typeof r === 'string' ? r : JSON.stringify(r);
          call.toolResults.push({ name: t.name, bytes: bytes(s ?? '') });
          if (bytes(s ?? '') > 32768) call.toolResults[call.toolResults.length - 1].error = 'over 32KB';
        } catch (e) {
          call.toolResults.push({ name: t.name, bytes: 0, error: String(e && e.message || e) });
        }
      }
    }
    const full = kind === 'json' ? JSON.stringify((window.__mockJson || (() => []))(input)) : (window.__mockText || defaultText)(input);
    const parts = [full.slice(0, Math.ceil(full.length / 3)), full.slice(Math.ceil(full.length / 3), Math.ceil((2 * full.length) / 3)), full.slice(Math.ceil((2 * full.length) / 3))].filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      await sleep(cfg.ai === 'slow' ? 1500 : 40);
      if (opts.signal?.aborted) throw rej('cancelled', 'aborted', acc || undefined);
      acc += parts[i];
      try { opts.onText && opts.onText({ text: acc, delta: parts[i] }); } catch (e) { console.warn('onText threw', e); }
      if (cfg.ai === 'error-mid' && i === 0) throw rej('upstream_error', 'connection dropped', acc);
    }
    return kind === 'json' ? JSON.parse(full) : { text: acc, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  }
  const sample = (input, opts) => run('sample', input, opts);
  sample.json = (input, opts) => run('json', input, opts);
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 20 }, modelTiers: ['default', 'complex', 'quick', 'inherit'] });
  Object.freeze(sample);
  const downloads = Object.freeze({
    save: async ({ filename, data }) => {
      if (typeof filename !== 'string' || !filename || filename.length > 512) throw rej('bad_request', 'filename');
      const ext = (filename.split('.').pop() || '').toLowerCase();
      if (!filename.includes('.') || !ALLOWED.includes(ext)) throw rej('rejected_extension', `.${ext} not allowed`);
      let text = '';
      if (typeof data === 'string') text = data; else if (data instanceof Blob) text = await data.text(); else throw rej('bad_request', 'data');
      if (!text.length) throw rej('bad_request', 'empty data');
      if (cfg.downloads === 'decline') throw rej('declined', 'viewer declined');
      window.__saves.push({ filename, bytes: bytes(text), head: text.slice(0, 300) });
      return { status: 'saved' };
    },
  });
  window.claude = Object.freeze({
    use: async (name) => {
      await sleep(20);
      if (name === 'sample') return cfg.ai === 'unavailable' ? null : sample;
      if (name === 'downloads') return cfg.downloads === 'none' ? null : downloads;
      return null;
    },
  });
};

async function open({ file, route = 'home', ai = 'none', downloads = 'accept', width = 1440, height = 1000, keepStorage = null } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  const dls = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 400)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 400)); });
  page.on('download', (d) => dls.push(d.suggestedFilename()));
  await page.addInitScript(INIT, { ai, downloads });
  await page.goto('file://' + file + '#' + route);
  await page.waitForTimeout(900);
  return {
    browser, context, page, errors, downloads: dls,
    calls: () => page.evaluate(() => window.__sampleCalls),
    saves: () => page.evaluate(() => window.__saves),
    dismissToasts: async () => { for (const b of await page.$$('.toasts button[aria-label*="닫기"]')) { await b.click().catch(() => {}); } },
    reload: async () => { await page.reload(); await page.waitForTimeout(900); },
    close: () => browser.close(),
  };
}
module.exports = { open };
