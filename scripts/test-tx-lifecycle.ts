/* oxlint-disable typescript/require-await -- the fake client methods must return promises to match the real client */
/**
 * Tests for the transaction receipt tracker.
 *
 *   bun run test:tx            unit tests with a fake client (no network)
 *   bun run test:tx live-init  creates a throwaway TESTNET key in /tmp and prints its address
 *   bun run test:tx live       sends one real USDC transfer on Arc TESTNET and tracks it end to end
 *
 * The live mode only ever talks to Arc Testnet and uses a throwaway key that lives in /tmp and is deleted
 * at the end of the run. It never touches mainnet and never reads a wallet.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, erc20Abi, http, parseGwei, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getUsdc, requireChain } from '../src/onchain-facts'
import { backoffDelay, SLOW_AFTER_MS, trackTransaction, UNKNOWN_AFTER_MS, type ReceiptClient, type TrackPhase } from '../src/lib/txTracker'

let passed = 0
const ok = (cond: boolean, name: string) => {
  if (!cond) throw new Error(`FAIL: ${name}`)
  passed++
  console.log(`  ok  ${name}`)
}

const HASH = ('0x' + 'ab'.repeat(32)) as Hex
const notFound = () => Object.assign(new Error('Transaction receipt could not be found.'), { name: 'TransactionReceiptNotFoundError' })
const receipt = (status: 'success' | 'reverted') => ({ status, blockNumber: 7n }) as unknown as Awaited<ReturnType<ReceiptClient['getTransactionReceipt']>>

/** A virtual clock: sleeping advances time instantly so minutes of waiting run in milliseconds. */
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

async function unit() {
  console.log('Unit tests')
  ok(backoffDelay(0) === 500 && backoffDelay(1) === 750 && backoffDelay(2) === 1125, 'polling starts at 0.5s and backs off exponentially')
  ok(backoffDelay(10) === 3_000 && backoffDelay(39) === 3_000, 'polling stays at 3s during the first ~2 minutes')
  ok(backoffDelay(41) === 3_500 && backoffDelay(500) === 10_000, 'a long-pending transaction slowly backs off to 10s')

  // 0. a hung lookup does not freeze polling; the next poll goes out and finds the receipt
  {
    let calls = 0
    const client: ReceiptClient = {
      getTransactionReceipt: () => (++calls === 1 ? new Promise<never>(() => undefined) : Promise.resolve(receipt('success'))),
      getTransaction: async () => ({ nonce: 1, from: '0x0000000000000000000000000000000000000001' }),
      getTransactionCount: async () => 1,
    }
    const started = Date.now()
    const final = await trackTransaction(client, HASH, { pollTimeoutMs: 50, sleep: async () => undefined })
    ok(final.phase === 'confirmed' && calls === 2 && Date.now() - started < 1500, 'a hung receipt lookup is abandoned after the poll timeout and the next poll confirms')
  }

  // 0b. the poker wakes a long sleep immediately (tab visible again)
  {
    let wake: () => void = () => undefined
    let calls = 0
    const client: ReceiptClient = {
      getTransactionReceipt: async () => { if (++calls < 2) throw notFound(); return receipt('success') },
      getTransaction: async () => ({ nonce: 1, from: '0x0000000000000000000000000000000000000001' }),
      getTransactionCount: async () => 1,
    }
    const started = Date.now()
    const run = trackTransaction(client, HASH, {
      sleep: () => new Promise<void>((r) => setTimeout(r, 30_000)),
      poke: { subscribe: (w) => { wake = w; return () => undefined } },
    })
    await new Promise((r) => setTimeout(r, 100))
    wake()
    const final = await run
    ok(final.phase === 'confirmed' && Date.now() - started < 2000, 'a wake-up poke skips the remaining sleep and polls at once')
  }

  // 1. confirmed
  {
    const c = clock()
    let calls = 0
    const client: ReceiptClient = {
      getTransactionReceipt: async () => { if (++calls < 4) throw notFound(); return receipt('success') },
      getTransaction: async () => ({ nonce: 5, from: '0x0000000000000000000000000000000000000001' }),
      getTransactionCount: async () => 5,
    }
    const phases: TrackPhase[] = []
    const final = await trackTransaction(client, HASH, { ...c, onUpdate: (s) => phases.push(s.phase) })
    ok(final.phase === 'confirmed' && final.receipt?.status === 'success', 'confirmed only when a receipt with status success exists')
    ok(!phases.slice(0, -1).includes('confirmed'), 'never reports confirmed before the receipt')
  }

  // 2. reverted receipt
  {
    const client: ReceiptClient = {
      getTransactionReceipt: async () => receipt('reverted'),
      getTransaction: async () => { throw notFound() },
      getTransactionCount: async () => 0,
    }
    const final = await trackTransaction(client, HASH, clock())
    ok(final.phase === 'reverted', 'a reverted receipt is reported as reverted, not success')
  }

  // 3. slow then confirmed (and never resends: the client has no send method at all)
  {
    const c = clock()
    const client: ReceiptClient = {
      getTransactionReceipt: async () => { if (c.now() < SLOW_AFTER_MS + 20_000) throw notFound(); return receipt('success') },
      getTransaction: async () => ({ nonce: 9, from: '0x0000000000000000000000000000000000000001' }),
      getTransactionCount: async () => 9,
    }
    const phases = new Set<TrackPhase>()
    const final = await trackTransaction(client, HASH, { ...c, onUpdate: (s) => phases.add(s.phase) })
    ok(phases.has('pending') && phases.has('slow') && final.phase === 'confirmed', 'pending -> slow -> confirmed')
  }

  // 4. queued behind an earlier nonce
  {
    const c = clock()
    const client: ReceiptClient = {
      getTransactionReceipt: async () => { if (c.now() < 60_000) throw notFound(); return receipt('success') },
      getTransaction: async () => ({ nonce: 12, from: '0x0000000000000000000000000000000000000001' }),
      getTransactionCount: async () => 10,
    }
    let detail = ''
    const phases = new Set<TrackPhase>()
    await trackTransaction(client, HASH, { ...c, onUpdate: (s) => { phases.add(s.phase); if (s.detail) detail = s.detail } })
    ok(phases.has('queued') && detail.includes('2 earlier'), 'detects a transaction queued behind earlier nonces')
  }

  // 5. RPC failures are not treated as "not mined" and do not stop tracking
  {
    const c = clock()
    let calls = 0
    const client: ReceiptClient = {
      getTransactionReceipt: async () => { calls++; if (calls <= 3) throw Object.assign(new Error('Failed to fetch'), { name: 'HttpRequestError' }); return receipt('success') },
      getTransaction: async () => { throw notFound() },
      getTransactionCount: async () => 0,
    }
    const phases = new Set<TrackPhase>()
    const final = await trackTransaction(client, HASH, { ...c, onUpdate: (s) => phases.add(s.phase) })
    ok(phases.has('rpc-issue') && final.phase === 'confirmed', 'RPC outage -> rpc-issue, then confirmed once the RPC recovers')
  }

  // 6. unknown hash: reported as unknown, polling continues (abort ends it)
  {
    const c = clock()
    const controller = new AbortController()
    const client: ReceiptClient = {
      getTransactionReceipt: async () => { throw notFound() },
      getTransaction: async () => { throw notFound() },
      getTransactionCount: async () => 0,
    }
    let sawUnknown = false
    try {
      await trackTransaction(client, HASH, {
        now: c.now,
        sleep: c.sleep,
        signal: controller.signal,
        onUpdate: (s) => { if (s.phase === 'unknown') { sawUnknown = true; controller.abort() } },
      })
    } catch (e) {
      ok((e as Error).name === 'AbortError', 'tracking stops cleanly when aborted')
    }
    ok(sawUnknown && c.now() >= UNKNOWN_AFTER_MS, 'a hash the node never knew becomes "unknown" only after the grace period')
  }
}

const KEY_FILE = '/tmp/fluxora-testnet-key'

async function liveInit() {
  const key = generatePrivateKey()
  writeFileSync(KEY_FILE, key, { mode: 0o600 })
  console.log('Throwaway TESTNET address:', privateKeyToAccount(key).address)
}

async function live() {
  if (!existsSync(KEY_FILE)) throw new Error('Run "live-init" first')
  console.log('Live test on Arc TESTNET')
  const fact = requireChain(arcTestnet.id)
  const rpc = fact.rpcUrls[0]
  if (!rpc) throw new Error('No testnet RPC in the registry')
  const account = privateKeyToAccount(readFileSync(KEY_FILE, 'utf8').trim() as Hex)
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
  const usdcInfo = getUsdc(arcTestnet.id)
  if (!usdcInfo) throw new Error('No testnet USDC in the registry')
  const usdc = usdcInfo.address as Address

  ok((await publicClient.getChainId()) === arcTestnet.id, `RPC serves chain ${arcTestnet.id} (testnet)`)
  const balance = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  console.log('  throwaway USDC balance (6 dec):', balance.toString())
  if (balance === 0n) throw new Error('Fund the throwaway address from the faucet first')

  const to = privateKeyToAccount(generatePrivateKey()).address
  const fees = await publicClient.estimateFeesPerGas()
  const maxFeePerGas = fees.maxFeePerGas < parseGwei('20') ? parseGwei('20') : fees.maxFeePerGas

  // Unknown hash on the real RPC is reported as not-yet-mined, not as success
  {
    const c = clock()
    const controller = new AbortController()
    const seen: { phase: TrackPhase } = { phase: 'pending' }
    await trackTransaction(publicClient as unknown as ReceiptClient, ('0x' + '11'.repeat(32)) as Hex, {
      now: c.now,
      sleep: async (ms) => { await c.sleep(ms); await new Promise((r) => setTimeout(r, 30)) },
      signal: controller.signal,
      onUpdate: (s) => { seen.phase = s.phase; if (s.phase === 'unknown') controller.abort() },
    }).catch(() => undefined)
    ok(seen.phase === 'unknown', 'real RPC: an unknown hash is never reported as confirmed')
  }

  const started = Date.now()
  const hash = await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: 'transfer', args: [to, 1000n], maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
  console.log('  submitted', hash)
  const phases: TrackPhase[] = []
  const final = await trackTransaction(publicClient, hash, { onUpdate: (s) => phases.push(s.phase) })
  console.log(`  tracker finished in ${Date.now() - started} ms, phases: ${[...new Set(phases)].join(' > ')}`)
  ok(final.phase === 'confirmed' && final.receipt?.status === 'success', 'real transfer confirmed from its receipt')
  const received = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [to] })
  ok(received === 1000n, 'recipient balance changed by exactly the amount sent')
  rmSync(KEY_FILE, { force: true })
  console.log('  throwaway key deleted')
}

const mode = process.argv[2]
try {
  if (mode === 'live-init') await liveInit()
  else if (mode === 'live') {
    await unit()
    await live()
  } else await unit()
  if (mode !== 'live-init') console.log(`\n${passed} checks passed`)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
