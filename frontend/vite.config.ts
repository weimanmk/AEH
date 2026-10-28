import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地教师工具前端：无后端、无代理、无外部请求。
// `node:crypto` 只被 dsh-plugin 的 curriculum-graph 用于同步 SHA-256 内容摘要；
// 浏览器没有该内置模块，因此 alias 到同输出的小型同步实现。
const sha256Shim = new URL('./src/lib/shims/sha256.ts', import.meta.url).pathname
const coreSource = new URL('../dsh-plugin/src', import.meta.url).pathname

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'node:crypto': sha256Shim,
      '@aeh': coreSource,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 关闭 Vite 的 modulepreload polyfill：它会在产物里注入 fetch() 调用，
    // 与“运行期零网络、grep 无 fetch(”的自查口径冲突。现代浏览器原生支持 modulepreload。
    modulePreload: { polyfill: false },
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
