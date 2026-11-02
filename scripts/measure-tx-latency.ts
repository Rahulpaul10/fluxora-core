/**
 * Measures where time goes in a transfer on Arc TESTNET, using a throwaway key (never mainnet, never stored
 * beyond /tmp). Phases: prepare (gas + fees), submit (sign + broadcast to the RPC), propagate (until the RPC
 * can return a receipt, polled every 100ms), plus whether the RPC ever "forgets" a receipt it already returned.
 *
 *   bun run scripts/measure-tx-latency.ts init     -> prints a throwaway address to fund from the faucet
 *   bun run scripts/measure-tx-latency.ts run [n]  -> sends n small transfers and prints timings
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, erc20Abi, http, parseGwei, type Address, type Hex } from 'viem'
import { arcTestnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getUsdc, requireChain } from '../src/onchain-facts'

const KEY_FILE = '/tmp/fluxora-latency-key'
const now = () => performance.now()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if (process.argv[2] === 'init') {
  const key = generatePrivateKey()
  writeFileSync(KEY_FILE, key, { mode: 0o600 })
  console.log('Throwaway TESTNET address:', privateKeyToAccount(key).address)
  process.exit(0)
}

if (!existsSync(KEY_FILE)) throw new Error('Run init first')
const rpc = requireChain(arcTestnet.id).rpcUrls[0]
if (!rpc) throw new Error('no testnet rpc')
const usdc = getUsdc(arcTestnet.id)?.address as Address
const account = privateKeyToAccount(readFileSync(KEY_FILE, 'utf8').trim() as Hex)
const pub = createPublicClient({ chain: arcTestnet, transport: http(rpc, { batch: { batchSize: 25, wait: 16 } }) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const runs = Number(process.argv[3] ?? 3)

const rows: Record<string, number>[] = []
for (let i = 0; i < runs; i++) {
  const to = privateKeyToAccount(generatePrivateKey()).address
  const args = [to, 1000n] as const

  // What the app does before opening the wallet: estimate gas (this is also the revert check) and fetch fees in parallel
  let t = now()
  const [gas, fees] = await Promise.all([
    pub.estimateContractGas({ account: account.address, address: usdc, abi: erc20Abi, functionName: 'transfer', args }),
    pub.estimateFeesPerGas(),
  ])
  const prepare = now() - t
  const maxFeePerGas = fees.maxFeePerGas < parseGwei('20') ? parseGwei('20') : fees.maxFeePerGas

  t = now()
  const hash = await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: 'transfer', args, gas: (gas * 125n) / 100n, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
  const submit = now() - t // sign locally + eth_sendRawTransaction round trip

  // Poll every 100ms: when does the RPC first return the receipt, and does it ever flip back to "not found"?
  const t0 = now()
  let firstSeen = -1
  let flips = 0
  let seenBefore = false
  let lastRoundTrip = 0
  for (let k = 0; k < 150; k++) {
    const s = now()
    let found = false
    try {
      await pub.getTransactionReceipt({ hash })
      found = true
    } catch {
      found = false
    }
    lastRoundTrip = now() - s
    if (found && firstSeen < 0) firstSeen = now() - t0
    if (found) seenBefore = true
    else if (seenBefore) flips++
    if (found && k > 0 && firstSeen >= 0 && now() - t0 > firstSeen + 1500) break
    await sleep(100)
  }
  rows.push({ prepare, submit, propagate: firstSeen, flips, rtt: lastRoundTrip })
  console.log(`tx ${i + 1}: prepare ${prepare.toFixed(0)} ms | submit ${submit.toFixed(0)} ms | receipt visible ${firstSeen.toFixed(0)} ms after submit | receipt flip-flops ${flips} | one lookup ${lastRoundTrip.toFixed(0)} ms`)
  await sleep(1000)
}
const avg = (k: string) => (rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length).toFixed(0)
console.log(`average: prepare ${avg('prepare')} ms, submit ${avg('submit')} ms, receipt visible ${avg('propagate')} ms`)
rmSync(KEY_FILE, { force: true })
console.log('throwaway key deleted')
