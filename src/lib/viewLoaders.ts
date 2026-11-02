import type { View } from './router'

/**
 * One loader per page. App uses them for React.lazy, and the same loaders are used to prefetch pages, so the code
 * for a page is usually already in the browser before the user opens it. Calling a loader twice is free: the
 * browser module cache returns the same module.
 */
export const viewLoaders = {
  send: () => import('@/pages/Send').then((m) => ({ default: m.Send })),
  receive: () => import('@/pages/Receive').then((m) => ({ default: m.Receive })),
  swap: () => import('@/pages/Swap').then((m) => ({ default: m.Swap })),
  bridge: () => import('@/pages/Bridge').then((m) => ({ default: m.Bridge })),
  pay: () => import('@/pages/Pay').then((m) => ({ default: m.Pay })),
  history: () => import('@/pages/History').then((m) => ({ default: m.History })),
} as const

type LazyView = keyof typeof viewLoaders

const started = new Set<LazyView>()

/** Starts loading one page (and, for Bridge, the Circle bridge kit it needs). Safe to call repeatedly. */
export function prefetchView(view: View): void {
  if (!(view in viewLoaders)) return
  const key = view as LazyView
  if (started.has(key)) return
  started.add(key)
  void viewLoaders[key]().catch(() => started.delete(key)) // a failed prefetch is retried on the next hint
  if (key === 'bridge') void import('./bridgeKit').then((m) => m.preloadBridgeKit())
}

const ORDER: LazyView[] = ['send', 'swap', 'receive', 'pay', 'history', 'bridge']

/** After the first screen is interactive, warm the remaining pages one at a time while the browser is idle. */
export function prefetchAllViewsWhenIdle(): () => void {
  let cancelled = false
  let i = 0
  // Safari has no requestIdleCallback: fall back to a short timer.
  const idle = (cb: () => void) => {
    const ric = (window as { requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    if (typeof ric === 'function') ric(cb, { timeout: 4_000 })
    else globalThis.setTimeout(cb, 1_500)
  }
  const step = () => {
    if (cancelled || i >= ORDER.length) return
    prefetchView(ORDER[i++])
    idle(step)
  }
  idle(step)
  return () => {
    cancelled = true
  }
}
