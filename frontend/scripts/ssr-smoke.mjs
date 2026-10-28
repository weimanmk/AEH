/**
 * SSR 冒烟：在没有无头浏览器的环境里，用 Vite SSR 加载真实视图与路由，
 * 逐路由渲染成 HTML 并断言关键文案存在。
 *
 *   node scripts/ssr-smoke.mjs
 *
 * 这不能替代真实浏览器交互测试，但能证明：
 * - 5 个路由的组件树可以实际渲染（不是只打包成功）；
 * - 视图在 store 初始状态（预置合成示例）下没有渲染期异常；
 * - 关键标题确实出现在输出 HTML 中。
 */

import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'

const ROUTES = [
  ['/', 'AEH 教师工作台'],
  ['/student', '学生进度、复习、诊断与门禁'],
  ['/teacher', '课程图谱、题库、干预准备与教学策略'],
  ['/report', '仅聚合的教师报告'],
  ['/metrics', '覆盖率、到期负担、回忆率与同意账本'],
]

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  const appModule = await server.ssrLoadModule('/src/App.tsx')
  const App = appModule.default
  for (const [path, expected] of ROUTES) {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(App),
      ),
    )
    assert.ok(html.length > 500, `${path} 渲染结果过短`)
    assert.ok(
      html.includes(expected),
      `${path} 应包含关键文案：${expected}`,
    )
    console.log(`PASS SSR ${path} -> ${html.length} bytes，含“${expected}”`)
  }

  // 空 store 的分支也要能渲染：清空后不应因取不到学生/报告而崩溃。
  const storeModule = await server.ssrLoadModule('/src/lib/store.ts')
  storeModule.clearAll()
  const EMPTY_ROUTES = [
    ['/student', '还没有学生'],
    ['/report', '当前没有可纳入报告的学生'],
    ['/metrics', '还没有学生'],
  ]
  for (const [path, expected] of EMPTY_ROUTES) {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(App),
      ),
    )
    assert.ok(html.includes(expected), `空 store ${path} 应包含：${expected}`)
    console.log(`PASS SSR empty ${path} -> ${html.length} bytes，含“${expected}”`)
  }
  storeModule.resetToSynthetic()
  console.log('SSR_SMOKE_PASS')
} finally {
  await server.close()
}
