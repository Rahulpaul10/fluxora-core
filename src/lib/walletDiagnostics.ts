import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { config } from '@/config/wallet'
import { ARC_CHAIN_ID, HOME_NETWORK, asChainId } from '@/config/networks'
import { USDC } from '@/lib/tokens'

/**
 * Compares the RPC this app uses with the RPC your wallet is configured to use for the same network.
 * A browser wallet answers read-only calls (eth_blockNumber, eth_gasPrice, eth_estimateGas ...) through the RPC saved in
 * ITS network settings, so timing the same calls both ways shows which side is slow or behind. Nothing is signed or sent.
 */
interface Requester {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

export interface DiagRow {
  call: string
  appMs: number | null
  walletMs: number | null
  appValue: string
  walletValue: string
}

export interface DiagResult {
  rows: DiagRow[]
  appHost: string
  walletChainId?: number
  /** wallet block minus app block (negative = the wallet's RPC is behind) */
  blockLag?: number
  error?: string
}

const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 28 ? `${s.slice(0, 26)}…` : s
}

/** Compact, comparable text for the fee-related answers (the raw objects are too long to eyeball). */
function summarize(method: string, raw: unknown): string {
  const o = raw as { baseFeePerGas?: unknown; reward?: unknown[]; gasUsedRatio?: unknown[] } | null
  if (method === 'eth_feeHistory' && o && Array.isArray(o.baseFeePerGas)) {
    const base = String(o.baseFeePerGas[o.baseFeePerGas.length - 1] ?? '')
    return `baseFee ${base} · ${o.reward?.length ?? 0} reward rows`
  }
  if (method === 'eth_getBlockByNumber' && o) return `baseFeePerGas ${typeof o.baseFeePerGas === 'string' ? o.baseFeePerGas : 'MISSING'}`
  return short(raw)
}

async function timeIt(req: Requester, method: string, params: unknown[] = []): Promise<{ ms: number | null; value: string; raw?: unknown }> {
  const t = performance.now()
  try {
    const raw = await req.request({ method, params })
    return { ms: Math.round(performance.now() - t), value: summarize(method, raw), raw }
  } catch (e) {
    return { ms: null, value: `error: ${(e as Error).message?.slice(0, 40) ?? 'failed'}` }
  }
}

export async function runWalletDiagnostics(): Promise<DiagResult> {
  const appClient = getPublicClient(config, { chainId: asChainId(ARC_CHAIN_ID) }) as unknown as Requester | undefined
  const account = getAccount(config)
  const appHost = (() => {
    try {
      return new URL(HOME_NETWORK.rpcUrls[0] ?? '').host
    } catch {
      return 'unknown'
    }
  })()
  if (!appClient) return { rows: [], appHost, error: 'The app RPC client is not available.' }
  if (!account.isConnected || !account.connector || !account.address) return { rows: [], appHost, error: 'Connect a wallet first.' }

  const provider = (await account.connector.getProvider()) as Requester | undefined
  if (!provider?.request) return { rows: [], appHost, error: 'This wallet does not expose a provider to test.' }

  const me: Address = account.address
  const data: Hex = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [me, 1n] })
  const calls: { call: string; method: string; params: unknown[] }[] = [
    { call: 'eth_blockNumber (1st)', method: 'eth_blockNumber', params: [] },
    { call: 'eth_blockNumber (2nd)', method: 'eth_blockNumber', params: [] },
    { call: 'eth_blockNumber (3rd)', method: 'eth_blockNumber', params: [] },
    { call: 'eth_gasPrice', method: 'eth_gasPrice', params: [] },
    { call: 'eth_getTransactionCount (pending)', method: 'eth_getTransactionCount', params: [me, 'pending'] },
    { call: 'eth_getCode (USDC contract)', method: 'eth_getCode', params: [USDC.address, 'latest'] },
    { call: 'eth_estimateGas (USDC transfer)', method: 'eth_estimateGas', params: [{ from: me, to: USDC.address, data }] },
    // What a wallet needs to show "Network fee" for an EIP-1559 transaction
    { call: 'eth_feeHistory (5 blocks)', method: 'eth_feeHistory', params: ['0x5', 'latest', [10, 20, 30]] },
    { call: 'eth_maxPriorityFeePerGas', method: 'eth_maxPriorityFeePerGas', params: [] },
    { call: 'eth_getBlockByNumber (latest)', method: 'eth_getBlockByNumber', params: ['latest', false] },
    // Capability probes used by transaction-preview features ("Estimated changes"); an error here means unsupported
    { call: 'eth_createAccessList (probe)', method: 'eth_createAccessList', params: [{ from: me, to: USDC.address, data }, 'latest'] },
    { call: 'debug_traceCall (probe)', method: 'debug_traceCall', params: [{ from: me, to: USDC.address, data }, 'latest', { tracer: 'callTracer' }] },
  ]

  const rows: DiagRow[] = []
  let appBlock: bigint | undefined
  let walletBlock: bigint | undefined
  for (const c of calls) {
    // Alternate which side goes first so a warm-up penalty does not always land on the same one
    const walletFirst = rows.length % 2 === 0
    const first = await timeIt(walletFirst ? provider : appClient, c.method, c.params)
    const second = await timeIt(walletFirst ? appClient : provider, c.method, c.params)
    const wallet = walletFirst ? first : second
    const app = walletFirst ? second : first
    if (c.method === 'eth_blockNumber') {
      if (typeof app.raw === 'string') appBlock = BigInt(app.raw)
      if (typeof wallet.raw === 'string') walletBlock = BigInt(wallet.raw)
    }
    rows.push({ call: c.call, appMs: app.ms, walletMs: wallet.ms, appValue: app.value, walletValue: wallet.value })
  }

  let walletChainId: number | undefined
  try {
    walletChainId = Number(BigInt((await provider.request({ method: 'eth_chainId' })) as string))
  } catch {
    walletChainId = undefined
  }
  return {
    rows,
    appHost,
    walletChainId,
    blockLag: appBlock !== undefined && walletBlock !== undefined ? Number(walletBlock - appBlock) : undefined,
  }
}

/** One console line a person can paste back for analysis. */
export function formatDiagnostics(r: DiagResult): string {
  if (r.error) return `[FLUXORA diag] ${r.error}`
  const lines = r.rows.map((x) => `  ${x.call.padEnd(36)} app ${String(x.appMs ?? 'ERR').padStart(5)} ms | wallet ${String(x.walletMs ?? 'ERR').padStart(5)} ms | ${x.appValue} vs ${x.walletValue}`)
  return `[FLUXORA diag] app RPC ${r.appHost} vs the wallet's own RPC (wallet chain ${r.walletChainId ?? '?'}, block lag ${r.blockLag ?? '?'})\n${lines.join('\n')}`
}
