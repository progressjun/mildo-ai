// dist-single/index.html 후처리: 번들 라이브러리 문자열 안의 U+FFFD 리터럴을 JS 이스케이프(�)로 바꾼다.
// Claude 아티팩트 업로드는 U+FFFD 리터럴을 인코딩 오류로 보고 거부한다. JS 문자열 · 정규식 안에서 두 표기는 같은 값이다.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist-single/index.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const count = html.split('�').length - 1;
if (count > 0) writeFileSync(file, html.replaceAll('�', '\\uFFFD'));
console.log(`postbuild-single: U+FFFD ${count}건 이스케이프`);
