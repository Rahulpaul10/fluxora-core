import { Suspense, lazy, memo, useDeferredValue, useEffect } from 'react'
import { Shell } from '@/components/Shell'
import { PendingReconciler } from '@/components/PendingReconciler'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ConfigNotice } from '@/components/ConfigNotice'
import { WalletWarmup } from '@/components/WalletWarmup'
import { WalletPromptBanner } from '@/components/WalletPromptBanner'
import { WalletEvents } from '@/hooks/useWallet'
import { useRoute } from '@/lib/router'
import { Dashboard } from '@/pages/Dashboard'
import { PageLoader } from '@/components/Logo'
import { prefetchAllViewsWhenIdle, viewLoaders } from '@/lib/viewLoaders'

const Send = lazy(viewLoaders.send)
const Receive = lazy(viewLoaders.receive)
const Swap = lazy(viewLoaders.swap)
const Bridge = lazy(viewLoaders.bridge)
const Pay = lazy(viewLoaders.pay)
const History = lazy(viewLoaders.history)

type RouteView = ReturnType<typeof useRoute>

/** The page for a route. Memoized so unrelated App renders do not re-render the page. */
const Outlet = memo(function Outlet({ view, params, navigate }: Pick<RouteView, 'view' | 'params' | 'navigate'>) {
  return (
    <>
      {view === 'dashboard' && <Dashboard navigate={navigate} />}
      {view === 'send' && <Send presetTo={params.get('to') ?? undefined} presetAmount={params.get('amount') ?? undefined} presetToken={params.get('token') ?? undefined} />}
      {view === 'receive' && <Receive />}
      {view === 'swap' && <Swap />}
      {view === 'bridge' && <Bridge />}
      {view === 'pay' && <Pay params={params} navigate={navigate} />}
      {view === 'history' && <History />}
    </>
  )
})

export default function App() {
  const { view, params, navigate } = useRoute()
  // The navigation highlight follows `view` at once. The page itself follows `shownView`, which switches only when
  // the next page is ready, so the current page stays on screen instead of flashing a loader while a chunk loads.
  const shownView = useDeferredValue(view)
  const shownParams = useDeferredValue(params)
  const switching = shownView !== view

  useEffect(() => {
    const titles: Record<string, string> = { dashboard: 'Dashboard', send: 'Send', receive: 'Receive', swap: 'Swap', bridge: 'Bridge', pay: 'Pay', history: 'History' }
    document.title = `${titles[view]} · FLUXORA`
  }, [view])

  // Warm every page in the background once the first screen is done.
  useEffect(() => prefetchAllViewsWhenIdle(), [])

  return (
    <Shell view={view} navigate={navigate}>
      {/* Always-on services live outside the keyed page wrapper, so they mount once and are not restarted on every navigation. */}
      <WalletEvents />
      <ConfigNotice />
      <PendingReconciler />
      <WalletWarmup />
      <WalletPromptBanner />
      {switching && <div className="fx-progress" aria-hidden="true" />}
      <div key={shownView} className="animate-rise">
        <ErrorBoundary resetKey={shownView}>
          <Suspense fallback={<PageLoader />}>
            <Outlet view={shownView} params={shownParams} navigate={navigate} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </Shell>
  )
}
