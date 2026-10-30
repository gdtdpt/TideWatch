import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// UI 开发期走 Vite dev server，/api 反代到 daemon；生产期由 server 以 SPA 静态分发。
const target = process.env.TIDEWATCH_API ?? 'http://127.0.0.1:8686';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
