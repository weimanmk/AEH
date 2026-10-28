/**
 * Node 24 验证脚本的解析钩子：让 Node 能直接加载与浏览器相同的 TS 源码。
 *
 * 只做两件事：
 * 1. 把 Vite 的 `@aeh/*` alias 映射到 `dsh-plugin/src/*`；
 * 2. 给前端源码里省略扩展名的相对导入补 `.ts` / `/index.ts`。
 *
 * 不改变模块内容，也不 mock 任何核心；Node 的类型剥离负责去掉类型标注。
 */

import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CORE_ROOT = new URL('../../dsh-plugin/src/', import.meta.url)

async function exists(url) {
  try {
    await access(fileURLToPath(url))
    return true
  } catch {
    return false
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@aeh/')) {
    const target = new URL(specifier.slice('@aeh/'.length), CORE_ROOT)
    return nextResolve(target.href, context)
  }

  const isRelative =
    specifier.startsWith('./') || specifier.startsWith('../')
  const hasExtension = /\.[a-z0-9]+$/i.test(specifier)
  if (isRelative && !hasExtension && context.parentURL !== undefined) {
    const base = new URL(specifier, context.parentURL)
    for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
      if (await exists(candidate)) {
        return nextResolve(candidate, context)
      }
    }
  }

  return nextResolve(specifier, context)
}
