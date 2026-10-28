import { useSyncExternalStore } from 'react'
import { getStore, subscribe } from '../lib/store'
import type { AppStore } from '../lib/model'

/** React 18 外部 store 订阅；任何写操作后自动重渲染。 */
export function useStore(): AppStore {
  return useSyncExternalStore(subscribe, getStore, getStore)
}
