import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(__dirname, 'postbuild-single.mjs');

describe('postbuild-single (아티팩트 한 파일 후처리)', () => {
  it('U+FFFD 리터럴을 이스케이프하고, CSP 허용 목록인 Google Fonts 링크는 그대로 둔다 (업로드 거부 회귀)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbs-'));
    const file = join(dir, 'index.html');
    writeFileSync(file, [
      '<!DOCTYPE html><html><head>',
      '    <title>MILDO OS</title>',
      '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
      '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      '    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet" />',
      '<script type="module">const r=/�/;</script>',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n'));
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('U+FFFD 1건');
    const out = readFileSync(file, 'utf8');
    expect(out).toContain('https://fonts.googleapis.com/css2?family=Noto+Sans+KR');
    expect(out).toContain('https://fonts.gstatic.com');
    expect(out).not.toContain('�');
    expect(out).toContain('const r=/\\uFFFD/;');
    expect(out).toContain('<title>MILDO OS</title>');
    expect(out).toContain('<div id="root"></div>');
  });
});
