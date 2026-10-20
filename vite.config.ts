import { defineConfig } from 'vite';

// GitHub Pages はサブパス配信になるため相対パスでビルドする
export default defineConfig({
  base: './',
  // three.js 本体で 500kB を超えるため
  build: { chunkSizeWarningLimit: 700 },
});
