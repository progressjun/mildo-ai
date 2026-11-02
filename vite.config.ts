import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

// `vite build --mode single` → dist-single/index.html 한 파일 (Claude 아티팩트 배포용)
export default defineConfig(({ mode }) => ({
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  // 개발: 프런트(5173) → API 서버(8080) 프록시. SSE(/api/w/:ws/events)도 그대로 통과한다.
  server: { proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:8080', changeOrigin: false } } },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 2000,
  },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
}));
