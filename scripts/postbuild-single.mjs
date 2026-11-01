// dist-single/index.html 후처리 (Claude 아티팩트 배포용 한 파일)
// 번들 라이브러리 문자열 안의 U+FFFD 리터럴을 JS 이스케이프(�)로 바꾼다.
// Claude 아티팩트 업로드는 U+FFFD 리터럴을 인코딩 오류로 보고 거부한다. JS 문자열 · 정규식 안에서 두 표기는 같은 값이다.
// Google Fonts(fonts.googleapis.com 스타일시트 · fonts.gstatic.com 글꼴)는 아티팩트 CSP 허용 목록에 있으므로 그대로 둔다.
// 사용: node scripts/postbuild-single.mjs [출력 폴더 또는 index.html 경로]  (기본 dist-single)
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = process.argv[2];
const target = arg ? resolve(arg) : fileURLToPath(new URL('../dist-single/', import.meta.url));
const file = statSync(target).isDirectory() ? join(target, 'index.html') : target;

const html = readFileSync(file, 'utf8');
const count = html.split('�').length - 1;
if (count > 0) writeFileSync(file, html.replaceAll('�', '\\uFFFD'));
console.log(`postbuild-single: U+FFFD ${count}건 이스케이프`);
