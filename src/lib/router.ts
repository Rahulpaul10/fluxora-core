import { useCallback, useEffect, useMemo, useState } from 'react'

export type View = 'dashboard' | 'send' | 'receive' | 'swap' | 'bridge' | 'pay' | 'history'

export const VIEW_PATHS: Record<View, string> = {
  dashboard: '/',
  send: '/send',
  receive: '/receive',
  swap: '/swap',
  bridge: '/bridge',
  pay: '/pay',
  history: '/history',
}

function viewFromPath(pathname: string): View {
  const clean = pathname.replace(/\/+$/, '') || '/'
  const hit = (Object.entries(VIEW_PATHS) as [View, string][]).find(([, p]) => p === clean)
  return hit ? hit[0] : 'dashboard'
}

/** Minimal path router. Shareable state (payment links) lives in the path and query, never the hash. */
export function useRoute() {
  const [loc, setLoc] = useState(() => ({ view: viewFromPath(window.location.pathname), search: window.location.search }))

  useEffect(() => {
    const onPop = () => setLoc({ view: viewFromPath(window.location.pathname), search: window.location.search })
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((view: View, search = '') => {
    const url = VIEW_PATHS[view] + search
    window.history.pushState(null, '', url)
    setLoc({ view, search })
    window.scrollTo({ top: 0 })
  }, [])

  // Stable identity: pages and effects that depend on the params do not re-run on unrelated renders.
  const params = useMemo(() => new URLSearchParams(loc.search), [loc.search])
  return { view: loc.view, params, navigate }
}
