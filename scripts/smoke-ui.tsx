/**
 * UI smoke test: renders every page in a simulated browser (happy-dom) twice, once with no wallet and once with
 * a mock wallet connected on Arc. It uses the real RPC for READS only (balances, quotes, logs). Nothing is signed
 * or sent. It catches render crashes, console errors and pages that stay empty. Run: bun run test:ui
 *
 * It cannot test real wallet popups, extensions or layout/CSS; those need a real browser.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/', width: 390, height: 844 })
const g = globalThis as unknown as Record<string, unknown>
g.IS_REACT_ACT_ENVIRONMENT = false
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
g.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }

// Count RPC traffic per page so request volume regressions are visible
const rpcStats = { http: 0, calls: 0 }
const methods = new Map<string, number>()
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  if (typeof init?.body === 'string' && init.body.startsWith('[') || (typeof init?.body === 'string' && init.body.includes('"jsonrpc"'))) {
    rpcStats.http++
    try {
      const parsed = JSON.parse(init?.body) as unknown
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      rpcStats.calls += arr.length
      for (const c of arr as { method?: string; params?: { to?: string; data?: string }[] }[]) {
        const k = `${c.method}${c.params?.[0]?.to ? ' ' + c.params[0].to.slice(0, 8) + ' ' + (c.params[0].data ?? '').slice(0, 10) : ''}`
        methods.set(k, (methods.get(k) ?? 0) + 1)
      }
    } catch { rpcStats.calls++ }
  }
  return realFetch(input, init)
})

const errors: string[] = []
const origError = console.error
console.error = (...args: unknown[]) => {
  errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 300))
}
window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${String((e).reason).slice(0, 300)}`))

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { WagmiProvider, createConfig } = await import('wagmi')
const { connect, disconnect } = await import('wagmi/actions')
const { mock } = await import('wagmi/connectors')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ConnectKitProvider } = await import('connectkit')
const { config, queryRetry, queryRetryDelay } = await import('../src/config/wallet')
const { default: App } = await import('../src/App')

// A neutral, public address with no keys held here: read-only data only.
const ACCOUNT = '0x000000000000000000000000000000000000dEaD' as const
const ALL_ROUTES = ['/', '/send', '/receive', '/swap', '/bridge', '/pay', '/history', '/pay?to=0x000000000000000000000000000000000000dEaD&amount=1&token=USDC']

const ROUTES = process.env.ONLY ? ALL_ROUTES.filter((r) => process.env.ONLY?.split(',').includes(r)) : ALL_ROUTES
const WAIT = Number(process.env.WAIT ?? 0)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0

type AppConfig = typeof config
async function renderRoute(route: string, label: string, cfg: AppConfig = config) {
  errors.length = 0
  rpcStats.http = 0
  rpcStats.calls = 0
  methods.clear()
  window.history.pushState({}, "", route)
  document.body.innerHTML = '<div id="root"></div>'
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: queryRetry, retryDelay: queryRetryDelay, refetchOnWindowFocus: false } } })
  const root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(
    React.createElement(
      WagmiProvider,
      { config: cfg },
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(ConnectKitProvider, null, React.createElement(App))),
    ),
  )
  await sleep(WAIT || (route === '/swap' || route === '/history' ? 6000 : 3500))
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
  const crashed = text.includes('This page hit an error')
  const empty = text.length < 120
  const real = errors.filter((e) => !/act\(|not wrapped in act|Failed to fetch|favicon/i.test(e))
  const ok = !crashed && !empty && real.length === 0
  if (!ok) failures++
  if (process.env.METHODS) console.log('     methods:', [...methods.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v}x ${k}`).join(' | '))
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${label}] ${route}  (${text.length} chars, rpc ${rpcStats.http} http / ${rpcStats.calls} calls)${crashed ? '  PAGE CRASHED' : ''}${empty ? '  EMPTY' : ''}`)
  if (process.env.DUMP && label === 'connected' && process.env.DUMP.split(',').includes(route)) console.log(`       TEXT: ${text.slice(0, 900)}`)
  for (const e of real.slice(0, 4)) console.log(`       console.error: ${e}`)
  root.unmount()
  queryClient.clear()
}

console.log('Disconnected')
for (const r of ROUTES) await renderRoute(r, 'no wallet')

console.log('Connected (mock wallet, read-only)')
// The mock connector must live in the config (not be added later) or the provider's reconnect step drops it.
const testConfig = createConfig({
  chains: config.chains,
  transports: config._internal.transports as never,
  connectors: [mock({ accounts: [ACCOUNT], features: { reconnect: true } })],
}) as unknown as AppConfig
const connector = testConfig.connectors[0]
if (!connector) throw new Error('mock connector missing')
await connect(testConfig, { connector })
for (const r of ROUTES) await renderRoute(r, 'connected', testConfig)
await disconnect(testConfig)

console.error = origError
console.log(failures === 0 ? '\nAll pages rendered without crashes or console errors.' : `\n${failures} page(s) had problems.`)
process.exit(failures === 0 ? 0 : 1)
