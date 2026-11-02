// 서버 · 워커 · DB CLI를 esbuild로 번들 → server/dist/*.mjs (node_modules 패키지는 외부로 둔다)
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];

await build({
  entryPoints: { index: 'server/src/index.ts', worker: 'server/src/worker.ts', cli: 'server/src/db/cli.ts' },
  outdir: 'server/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  alias: { '@': './src' },
  tsconfig: 'tsconfig.json',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { 'process.env.APP_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info',
});
