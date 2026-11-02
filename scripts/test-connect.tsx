/* oxlint-disable typescript/require-await -- the fake provider methods must return promises like a real EIP-1193 provider */
/**
 * Connect-screen test: MetaMask detection (EIP-6963 and legacy injection), the mobile deep link,
 * the real wagmi connect flow through an EIP-1193 provider, and the WalletConnect configuration state.
 *
 * Honest scope: the "wallet" here is a small fake EIP-1193 provider that behaves like MetaMask on the wire
 * (announces itself, answers eth_requestAccounts / eth_chainId). It proves FLUXORA's detection and connection
 * code works against that protocol. It does NOT prove a real MetaMask extension, the MetaMask mobile app or the
 * WalletConnect relay work: those need a real wallet and a real WalletConnect project id.
 *
 * Run:  bun run test:connect                      (WalletConnect not configured)
 *       WC=off bun run test:connect               (forces the id empty: the "Needs a project id" state)
 *       WC=1 bun run test:connect                 (uses a dummy, well-formed project id to test the configured UI state only)
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// WC=off  -> force the variable empty (the "Needs a project id" state)
// WC=1    -> dummy, well-formed id (UI-state test only, never used to open a session)
// default -> use whatever .env provides (the real configuration)
if (process.env.WC === 'off') process.env.VITE_WALLETCONNECT_PROJECT_ID = ''
else if (process.env.WC === '1') process.env.VITE_WALLETCONNECT_PROJECT_ID = '0123456789abcdef0123456789abcdef'
const WC = (process.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim().length > 0

GlobalRegistrator.register({ url: 'http://localhost/', width: 390, height: 844 })
const g = globalThis as unknown as Record<string, unknown>
g.IS_REACT_ACT_ENVIRONMENT = false
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
g.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { WagmiProvider } = await import('wagmi')
const { getAccount, disconnect } = await import('wagmi/actions')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ConnectKitProvider } = await import('connectkit')
const { config, WALLETCONNECT_PROJECT_ID, walletConnectEnabled } = await import('../src/config/wallet')
const { ConnectPanel } = await import('../src/components/Gate')
const { metamaskDeepLink } = await import('../src/lib/walletEnv')

const ACCOUNT = '0x000000000000000000000000000000000000dEaD'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok: boolean, name: string, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -  ${detail}` : ''}`)
}
async function waitFor(fn: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(50)
  }
  return fn()
}

// A MetaMask-like EIP-1193 provider (Arc Mainnet, one account)
const provider = {
  isMetaMask: true,
  requests: [] as string[],
  request: async ({ method }: { method: string }) => {
    provider.requests.push(method)
    switch (method) {
      case 'eth_chainId': return '0x13b2' // 5042
      case 'eth_accounts':
      case 'eth_requestAccounts': return [ACCOUNT]
      case 'wallet_switchEthereumChain': return null
      default: throw Object.assign(new Error(`fake MetaMask: unsupported ${method}`), { code: -32601 })
    }
  },
  on: () => undefined,
  removeListener: () => undefined,
}

/** Behave like a wallet extension: announce now and whenever a page asks (EIP-6963). */
function installEip6963MetaMask() {
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info: { uuid: 'fluxora-test-1', name: 'MetaMask', icon: 'data:image/svg+xml,%3Csvg/%3E', rdns: 'io.metamask' }, provider }),
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
}

const qc = new QueryClient()
function mount() {
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(
    <React.StrictMode>
      <WagmiProvider config={config} reconnectOnMount={false}>
        <QueryClientProvider client={qc}>
          <ConnectKitProvider>
            <ConnectPanel />
          </ConnectKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </React.StrictMode>,
  )
  return root
}
const text = () => document.body.textContent ?? ''
const metamaskTile = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('MetaMask') && !b.textContent.includes('Using another'))

console.log(`WalletConnect project id configured for this run: ${WC ? (process.env.WC === '1' ? 'yes (dummy id, UI-state test only)' : 'yes (from the environment)') : 'no'}\n`)

// ---------------------------------------------------------------- desktop, no wallet installed
let root = mount()
await sleep(400)
check(text().includes('Not detected. Click to install'), 'Desktop without a wallet: MetaMask tile says it is not detected')
const opened: string[] = []
const realOpen = window.open.bind(window)
window.open = ((url?: string | URL) => {
  opened.push(String(url))
  return null
})
metamaskTile()?.click()
check(opened.length === 1 && opened[0] === 'https://metamask.io/download/', 'Desktop: clicking the tile opens the MetaMask install page', opened[0] ?? 'nothing opened')
check(getAccount(config).status === 'disconnected', 'Nothing is connected without a wallet (no fake connected state)')

// WalletConnect state
const wcConnector = config.connectors.find((c) => c.id === 'walletConnect')
if (WC) {
  check(Boolean(wcConnector), 'WalletConnect connector is registered when VITE_WALLETCONNECT_PROJECT_ID is set')
  check(walletConnectEnabled && WALLETCONNECT_PROJECT_ID === (process.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim(), 'The wallet config reads the project id from VITE_WALLETCONNECT_PROJECT_ID (not hardcoded)')
  check(text().includes('Scan with any mobile wallet'), 'WalletConnect tile shows it is ready', 'desktop wording')
} else {
  check(!wcConnector, 'No WalletConnect connector is registered without a project id (nothing is faked)')
  check(text().includes('Needs a project id (see .env.example)'), 'WalletConnect tile tells you exactly what is missing')
}
root.unmount()

// ---------------------------------------------------------------- mobile browser, no wallet
Object.defineProperty(window.navigator, 'userAgent', {
  value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  configurable: true,
})
window.history.pushState({}, '', '/pay?request=7')
root = mount()
await sleep(400)
check(text().includes('Open in the MetaMask app'), 'Mobile browser without MetaMask: tile offers the MetaMask app')
opened.length = 0
metamaskTile()?.click()
check(opened[0] === 'https://metamask.app.link/dapp/localhost/pay?request=7', 'Mobile: deep link keeps the current host, path and query', opened[0] ?? 'nothing opened')
check(metamaskDeepLink() === 'https://metamask.app.link/dapp/localhost/pay?request=7', 'Deep link is built from the page location, never a hardcoded domain')
if (WC) check(text().includes('Pick a wallet app on this phone'), 'Mobile WalletConnect wording')
root.unmount()

// ---------------------------------------------------------------- legacy window.ethereum injected late (ethereum#initialized)
Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', configurable: true })
window.history.pushState({}, '', '/')
root = mount()
await sleep(300)
check(text().includes('Not detected. Click to install'), 'Legacy injection, before the provider appears: not detected')
;(window as unknown as { ethereum?: unknown }).ethereum = provider
window.dispatchEvent(new Event('ethereum#initialized'))
check(await waitFor(() => text().includes('Detected. Click to connect'), 3000), 'window.ethereum injected late (ethereum#initialized): detected without reloading')
delete (window as unknown as { ethereum?: unknown }).ethereum
root.unmount()

// ---------------------------------------------------------------- MetaMask announced after the page loaded (EIP-6963)
root = mount()
await sleep(300)
check(text().includes('Not detected. Click to install'), 'Before the wallet announces itself: not detected')
installEip6963MetaMask()
check(await waitFor(() => text().includes('Detected. Click to connect')), 'After the late EIP-6963 announcement: detected without reloading')
metamaskTile()?.click()
const connected = await waitFor(() => getAccount(config).status === 'connected')
const acc = getAccount(config)
check(connected, 'Clicking the tile connects through the wallet provider')
check(acc.address?.toLowerCase() === ACCOUNT.toLowerCase(), 'The connected address is the wallet account', acc.address)
check(acc.chainId === 5042, 'The wallet chain is detected as Arc Mainnet (5042)', String(acc.chainId))
check(provider.requests.includes('eth_requestAccounts'), 'The real connect request (eth_requestAccounts) reached the wallet')
await disconnect(config)
check(getAccount(config).status === 'disconnected', 'Disconnect clears the connection')
root.unmount()

window.open = realOpen
console.log(failures === 0 ? '\nAll connect-screen checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
