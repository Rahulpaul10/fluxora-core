import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import { ARC_TOKENS, USDC, type TokenInfo } from '@/lib/tokens'
import { ARC_CHAIN_ID } from '@/config/networks'
import { isRangeError, pool, withRateLimitRetry } from '@/lib/rpcUtils'
import { Amount, gasTokenToUsdc } from '@/onchain-money'

/**
 * Arc logs every USDC Transfer (native and ERC-20 interface) from the system emitter, with an
 * 18-decimal amount. The USDC contract at 0x3600... logs the same transfer again, so we read ONLY the
 * system emitter for USDC to avoid double counting, and convert the amount with the app's rescale helper.
 */
export const SYSTEM_EMITTER: Address = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

export interface TransferLeg {
  direction: 'in' | 'out'
  token: TokenInfo
  amount: bigint
  counterparty: Address
}

export interface TransferTx {
  hash: Hex
  blockNumber: bigint
  timestamp: number
  legs: TransferLeg[]
}

/** RPC providers cap getLogs ranges. Ask for 5000 blocks; if rejected, split the window and retry. */
const WINDOW = 5000n
const WINDOWS_PER_PAGE = 5n

async function logsFor(client: PublicClient, user: Address, from: bigint, to: bigint, depth = 0): Promise<RawLog[]> {
  const address = [SYSTEM_EMITTER, ...ARC_TOKENS.filter((t) => t.symbol !== 'USDC').map((t) => t.address)]
  try {
    const [out, inn] = await withRateLimitRetry(() =>
      Promise.all([
        client.getLogs({ address, event: transferEvent, args: { from: user }, fromBlock: from, toBlock: to }),
        client.getLogs({ address, event: transferEvent, args: { to: user }, fromBlock: from, toBlock: to }),
      ]),
    )
    return [...out, ...inn] as RawLog[]
  } catch (error) {
    // Only a too-wide query is split. A throttled endpoint is retried above, never hammered harder.
    if (!isRangeError(error) || to - from < 250n || depth > 5) throw error
    const mid = from + (to - from) / 2n
    const [a, b] = await Promise.all([logsFor(client, user, from, mid, depth + 1), logsFor(client, user, mid + 1n, to, depth + 1)])
    return [...a, ...b]
  }
}

interface RawLog {
  address: Address
  blockNumber: bigint
  transactionHash: Hex
  logIndex: number
  args: { from?: Address; to?: Address; value?: bigint }
}

const blockTime = new Map<bigint, number>()
async function timestampOf(client: PublicClient, blockNumber: bigint) {
  const cached = blockTime.get(blockNumber)
  if (cached) return cached
  const block = await client.getBlock({ blockNumber })
  const ts = Number(block.timestamp)
  blockTime.set(blockNumber, ts)
  return ts
}

function toLeg(log: RawLog, user: Address): TransferLeg | null {
  const { from, to, value } = log.args
  if (!from || !to || value === undefined) return null
  const isUsdc = log.address.toLowerCase() === SYSTEM_EMITTER.toLowerCase()
  const token = isUsdc ? USDC : ARC_TOKENS.find((t) => t.address.toLowerCase() === log.address.toLowerCase())
  if (!token) return null
  const amount = isUsdc ? gasTokenToUsdc(ARC_CHAIN_ID, Amount.fromRaw(value, 18), 'trunc').raw : value
  const outgoing = from.toLowerCase() === user.toLowerCase()
  const incoming = to.toLowerCase() === user.toLowerCase()
  if (outgoing && incoming) return null // self transfer, nothing to show
  if (amount === 0n) return null
  return { direction: outgoing ? 'out' : 'in', token, amount, counterparty: outgoing ? to : from }
}

export function useOnchainTransfers() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })

  const query = useInfiniteQuery({
    queryKey: ['arc-transfers', address],
    enabled: Boolean(address && client),
    initialPageParam: undefined as bigint | undefined,
    refetchOnWindowFocus: false,
    staleTime: 180_000, // scanning blocks is expensive: reuse the result when moving between pages
    queryFn: async ({ pageParam }) => {
      if (!client || !address) return { txs: [] as TransferTx[], next: 0n, head: 0n }
      const head = await client.getBlockNumber()
      const to = pageParam ?? head
      const span = WINDOW * WINDOWS_PER_PAGE
      const lowest = to + 1n > span ? to + 1n - span : 0n
      const ranges: [bigint, bigint][] = []
      for (let hi = to; hi >= lowest; ) {
        const lo = hi + 1n > WINDOW ? hi + 1n - WINDOW : 0n
        ranges.push([lo < lowest ? lowest : lo, hi])
        if (lo === 0n) break
        hi = lo - 1n
      }
      const logs = (await pool(ranges, 2, ([lo, hi]) => logsFor(client, address, lo, hi))).flat()
      const byTx = new Map<Hex, { blockNumber: bigint; legs: TransferLeg[] }>()
      for (const log of logs) {
        const leg = toLeg(log, address)
        if (!leg) continue
        const entry = byTx.get(log.transactionHash) ?? { blockNumber: log.blockNumber, legs: [] }
        entry.legs.push(leg)
        byTx.set(log.transactionHash, entry)
      }
      const txs: TransferTx[] = await pool([...byTx.entries()], 4, async ([hash, v]) => ({
        hash,
        blockNumber: v.blockNumber,
        timestamp: await timestampOf(client, v.blockNumber),
        legs: v.legs,
      }))
      txs.sort((a, b) => Number(b.blockNumber - a.blockNumber))
      return { txs, next: lowest, head }
    },
    getNextPageParam: (last) => (last.next > 0n ? last.next - 1n : undefined),
  })

  const pages = query.data?.pages ?? []
  const txs = pages.flatMap((p) => p.txs)
  const head = pages[0]?.head
  const oldestScanned = pages.length ? pages[pages.length - 1].next : undefined
  return {
    txs,
    head,
    oldestScanned,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
    refetch: query.refetch,
  }
}
