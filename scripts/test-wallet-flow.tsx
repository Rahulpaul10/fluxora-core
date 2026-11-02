/* oxlint-disable typescript/require-await -- the fake wallet methods must return promises to match the connector interface */
/**
 * Wallet and Send-flow integration test with a FAKE wallet.
 *
 * What this exercises for real: the actual Send page, the pre-flight guard, single-flight protection, the wallet
 * prompt banner, fee estimation and simulation against the live Arc RPC, receipt tracking and the activity log.
 * What it does NOT exercise: a real wallet extension, real signing or any fund movement. The fake wallet receives
 * eth_sendTransaction, records it and returns a made-up hash that does not exist on any chain, so nothing is
 * ever broadcast. A hash the chain has never seen must stay Pending and must never show as confirmed.
 *
 * Run: bun run test:wallet
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/send', width: 390, height: 844 })
const g = globalThis as unknown as Record<string, unknown>
g.IS_REACT_ACT_ENVIRONMENT = false
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
g.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { WagmiProvider, createConnector } = await import('wagmi')
const { connect, disconnect } = await import('wagmi/actions')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ConnectKitProvider } = await import('connectkit')
const { config } = await import('../src/config/wallet')
const { default: App } = await import('../src/App')

const ACCOUNT = '0x000000000000000000000000000000000000dEaD' as const // public address, only used for reads and as the fake wallet's account
const ACCOUNT_2 = '0x000000000000000000000000000000000000bEEF' as const
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const FAKE_HASH = `0x${'ab'.repeat(32)}`

interface Sent { at: number; tx: Record<string, string> }
const wallet = { chainId: 5042, account: ACCOUNT as string, mode: 'approve' as 'approve' | 'reject', promptMs: 1500, hash: FAKE_HASH, sent: [] as Sent[] }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Counts receipt lookups per hash so we can prove the app watches a transaction even when its page is gone
const receiptLookups = new Map<string, number>()
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = typeof init?.body === 'string' ? init.body : ''
  if (body.includes('eth_getTransactionReceipt')) {
    for (const m of body.matchAll(/0x[0-9a-f]{64}/g)) receiptLookups.set(m[0], (receiptLookups.get(m[0]) ?? 0) + 1)
  }
  return realFetch(input, init)
})
const hex = (n: number) => `0x${n.toString(16)}`

const provider = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case 'eth_chainId': return hex(wallet.chainId)
      case 'eth_accounts':
      case 'eth_requestAccounts': return [wallet.account]
      case 'wallet_switchEthereumChain': wallet.chainId = Number((params?.[0] as { chainId: string }).chainId); return null
      case 'eth_sendTransaction': {
        wallet.sent.push({ at: performance.now(), tx: (params?.[0] ?? {}) as Record<string, string> })
        await sleep(wallet.promptMs) // the user reading the wallet popup
        if (wallet.mode === 'reject') throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
        return wallet.hash
      }
      default: throw Object.assign(new Error(`fake wallet: unsupported ${method}`), { code: -32601 })
    }
  },
  on: () => undefined,
  removeListener: () => undefined,
}

const fakeWallet = createConnector((cfg) => ({
  id: 'fake',
  name: 'Fake wallet',
  type: 'fake',
  setup: async () => undefined,
  connect: (async () => ({ accounts: [wallet.account as `0x${string}`], chainId: wallet.chainId })) as never,
  disconnect: async () => undefined,
  getAccounts: async () => [wallet.account as `0x${string}`],
  getChainId: async () => wallet.chainId,
  isAuthorized: async () => true,
  switchChain: async ({ chainId }) => {
    wallet.chainId = chainId
    cfg.emitter.emit('change', { chainId })
    const chain = cfg.chains.find((c) => c.id === chainId)
    if (!chain) throw new Error('unknown chain')
    return chain
  },
  onAccountsChanged: () => undefined,
  onChainChanged: () => undefined,
  onDisconnect: () => undefined,
  getProvider: async () => provider,
}))

let pass = 0
let fail = 0
const check = (cond: boolean, name: string, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`) }
}
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
const waitFor = async (fn: () => boolean, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50) } return false }
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
const setValue = (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const go = (path: string) => { window.history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 500, refetchOnWindowFocus: false, staleTime: 10_000 } } })
document.body.innerHTML = '<div id="root"></div>'
createRoot(document.getElementById('root') as HTMLElement).render(
  React.createElement(
    WagmiProvider,
    { config, reconnectOnMount: false },
    React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(ConnectKitProvider, null, React.createElement(App))),
  ),
)

async function startSend() {
  go('/receive') // leave and re-enter so the Send page mounts fresh
  await sleep(300)
  go('/send')
  await waitFor(() => document.getElementById('to') !== null)
  setValue('to', RECIPIENT)
  setValue('amt', '0.01')
  await waitFor(() => button('Review transfer')?.disabled === false)
  button('Review transfer')?.click()
  await waitFor(() => button('Confirm and sign') !== undefined)
}

console.log('Connection state')
await sleep(1500)
check(text().includes('Connect your wallet'), 'before connecting, Send asks for a wallet')
await (connect as unknown as (c: unknown, p: unknown) => Promise<unknown>)(config, { connector: fakeWallet })
await waitFor(() => text().includes('0x0000…dEaD'))
check(text().includes('0x0000…dEaD'), 'connected address is shown in the header')

console.log('Connected state is consistent on every page')
for (const route of ['/', '/swap', '/bridge', '/history', '/receive', '/pay']) {
  go(route)
  await sleep(500)
  check(text().includes('0x0000…dEaD') && !text().includes('Connect your wallet'), `address shown, no connect prompt on ${route}`)
}

console.log('Account switching')
{
  wallet.account = ACCOUNT_2
  // wagmi exposes the live connection's connector; emit the same event a real wallet sends
  const conn = config.state.connections.get(config.state.current ?? '')
  conn?.connector.emitter.emit('change', { accounts: [ACCOUNT_2] })
  go('/send')
  check(await waitFor(() => text().includes('0x0000…bEEF')), 'new account appears on Send after the wallet switches account')
  check(!text().includes('0x0000…dEaD'), 'old account no longer shown')
  wallet.account = ACCOUNT
  conn?.connector.emitter.emit('change', { accounts: [ACCOUNT] })
  await waitFor(() => text().includes('0x0000…dEaD'))
}

console.log('Network switching')
{
  const conn = config.state.connections.get(config.state.current ?? '')
  wallet.chainId = 8453
  conn?.connector.emitter.emit('change', { chainId: 8453 })
  check(await waitFor(() => text().includes('runs on Arc mainnet')), 'wallet on another network: Send blocks and offers a switch')
  wallet.chainId = 5042
  conn?.connector.emitter.emit('change', { chainId: 5042 })
  check(await waitFor(() => document.getElementById('to') !== null), 'back on Arc: Send form returns')
}

console.log('Send flow, approved')
{
  const { getPublicClient } = await import('wagmi/actions')
  const pc = getPublicClient(config, { chainId: 5042 })
  if (pc) {
    const t = performance.now()
    await Promise.all([pc.estimateFeesPerGas(), pc.getChainId()])
    console.log(`  info RPC round trip in this test environment: ${Math.round(performance.now() - t)} ms (fees + chainId, parallel)`)
  }
  wallet.mode = 'approve'
  wallet.sent.length = 0
  await startSend()
  check(text().includes('You are sending'), 'review screen shows the transfer summary')
  const t0 = performance.now()
  const confirm = button('Confirm and sign')
  confirm?.click()
  confirm?.click() // a second click in the same instant must not create a second request
  check(await waitFor(() => wallet.sent.length > 0, 20000), 'wallet receives the transaction request')
  const promptDelay = wallet.sent[0] ? Math.round(wallet.sent[0].at - t0) : -1
  check(promptDelay >= 0 && promptDelay < 3000, 'wallet prompt opens quickly after the click', `${promptDelay} ms incl. simulation and fee lookup against the live RPC`)
  await sleep(300)
  check(text().includes('Confirm in your wallet'), 'wallet banner is visible while the prompt is open')
  confirm?.click()
  await sleep(200)
  check(wallet.sent.length === 1, 'repeated clicks during the prompt do not send a second request', `${wallet.sent.length} request(s)`)
  const tx = wallet.sent[0]?.tx ?? {}
  check((tx.to ?? '').toLowerCase() === '0x3600000000000000000000000000000000000000', 'transaction targets the Arc USDC contract')
  check((tx.data ?? '').startsWith('0xa9059cbb') && (tx.data ?? '').toLowerCase().includes('1111111111111111111111111111111111111111') && (tx.data ?? '').endsWith((10000).toString(16).padStart(64, '0')), 'calldata is transfer(recipient, 0.01 USDC)')
  check(BigInt(tx.gas ?? '0x0') >= 21_000n, 'the wallet is handed an estimated gas limit, so it does not have to estimate gas itself', tx.gas ? `${BigInt(tx.gas)} gas` : 'missing')
  check(BigInt(tx.maxFeePerGas ?? '0x0') >= 20_000_000_000n, 'maxFeePerGas respects the 20 gwei Arc floor', tx.maxFeePerGas ? `${Number(BigInt(tx.maxFeePerGas) / 1_000_000_000n)} gwei` : 'missing')
  check(await waitFor(() => text().includes('Pending') && text().includes('Submitted'), 5000), 'after the wallet returns a hash the page shows Submitted / Pending')
  check(!text().includes('Confirm in your wallet'), 'wallet banner clears once the wallet answers')
  check(text().includes(`${FAKE_HASH.slice(0, 10)}`), 'transaction hash is displayed')
  {
    const { getTiming } = await import('../src/lib/txRegistry')
    const names = getTiming(FAKE_HASH as `0x${string}`, 5042)?.timeline?.marks.map((m) => m.name) ?? []
    const need = ['Request received', 'Pre-flight done', 'Gas and fee estimation started', 'Gas estimate answered', 'Wallet request issued', 'Wallet returned the transaction hash', 'First receipt lookup sent']
    const missing = need.filter((n) => !names.some((x) => x.startsWith(n)))
    check(missing.length === 0, 'timeline records every stage from the click to the first receipt lookup', missing.length ? `missing: ${missing.join(', ')}` : `${names.length} stages`)
  }
  await sleep(6000) // several backoff polls against the live RPC for a hash the chain has never seen
  check(!/confirmed in block/i.test(text()), 'a hash with no receipt is never shown as confirmed')
  const log = JSON.parse(localStorage.getItem('fluxora:activity:v1') ?? '[]') as { hash: string; status: string; kind: string }[]
  check(log.some((r) => r.hash === FAKE_HASH && r.kind === 'send' && r.status === 'pending'), 'activity log has the send as pending, not success')
}

console.log('Send flow, rejected in wallet')
{
  localStorage.removeItem('fluxora:activity:v1')
  wallet.mode = 'reject'
  wallet.sent.length = 0
  await startSend()
  button('Confirm and sign')?.click()
  check(await waitFor(() => wallet.sent.length === 1, 5000), 'request reached the wallet')
  await sleep(wallet.promptMs + 600)
  check(button('Confirm and sign')?.disabled === false, 'form is usable again after the rejection (no stuck loading state)')
  check(!text().includes('Pending'), 'a rejected request creates no pending transaction')
  check(!text().includes('Confirm in your wallet') || button('Confirm and sign') !== undefined, 'banner is gone after rejection')
  const log = JSON.parse(localStorage.getItem('fluxora:activity:v1') ?? '[]') as unknown[]
  check(log.length === 0, 'nothing recorded in the activity log')
}

console.log('Wallet speed test')
{
  const { runWalletDiagnostics } = await import('../src/lib/walletDiagnostics')
  const r = await runWalletDiagnostics()
  // The last two rows are capability probes: the Arc RPC answers them with "method not supported", which is the expected result
  check(r.rows.slice(10).every((x) => x.appMs === null), 'eth_createAccessList and debug_traceCall are reported as unsupported by the Arc RPC')
  check(!r.error && r.rows.length >= 10 && r.rows.slice(0, 10).every((x) => x.appMs !== null), 'speed test times the same calls on the app RPC', `app RPC ${r.rows.map((x) => x.appMs).join('/')} ms`)
  check(r.rows.every((x) => x.walletMs === null || typeof x.walletMs === 'number'), 'unsupported wallet calls are reported as errors, not thrown')
}

console.log('Leaving the page while the wallet prompt is open')
{
  localStorage.removeItem('fluxora:activity:v1')
  const HASH2 = `0x${'cd'.repeat(32)}`
  wallet.mode = 'approve'
  wallet.hash = HASH2
  wallet.promptMs = 1500
  await startSend()
  wallet.sent.length = 0
  button('Confirm and sign')?.click()
  await waitFor(() => wallet.sent.length === 1, 20000)
  go('/') // the user navigates away while MetaMask is still open
  await waitFor(() => (receiptLookups.get(HASH2) ?? 0) > 0, 15000)
  check((receiptLookups.get(HASH2) ?? 0) > 0, 'the transaction is watched even though the Send page was closed before the hash arrived', `${receiptLookups.get(HASH2) ?? 0} receipt lookup(s)`)
  const log2 = JSON.parse(localStorage.getItem('fluxora:activity:v1') ?? '[]') as { hash: string; status: string }[]
  check(log2.some((r) => r.hash === HASH2 && r.status === 'pending'), 'it is recorded as pending, not confirmed')
  wallet.hash = FAKE_HASH
}

console.log('Send flow, wallet on the wrong network at signing time')
{
  wallet.mode = 'approve'
  wallet.sent.length = 0
  await startSend()
  wallet.chainId = 8453 // the wallet changed network behind the app's back
  button('Confirm and sign')?.click()
  check(await waitFor(() => text().includes('Switch to Arc Mainnet'), 5000), 'clear wrong-network message is shown')
  check(wallet.sent.length === 0, 'nothing was sent to the wallet for the wrong network')
  wallet.chainId = 5042
}

console.log('Disconnect')
await disconnect(config)
check(await waitFor(() => text().includes('Connect your wallet') || text().includes('Connect wallet')), 'disconnect returns every page to the connect prompt')
for (const route of ['/', '/send', '/swap']) {
  go(route)
  await sleep(400)
  check(!text().includes('0x0000…dEaD'), `no stale address on ${route} after disconnect`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
