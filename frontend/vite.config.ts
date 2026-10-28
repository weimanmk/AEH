import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地演示前端：无后端、无代理、无外部请求。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // SPA history fallback（preview 时 /student 等深链回退到 index.html）。
  appType: 'spa',
  preview: {
    port: 4173,
    strictPort: true,
  },
})
