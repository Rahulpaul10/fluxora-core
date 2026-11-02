import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { ARC_CHAIN_ID, HOME_NETWORK, asChainId } from '@/config/networks'

export type RpcStatus = 'checking' | 'online' | 'degraded' | 'offline' | 'wrong-chain'

const SLOW_MS = 2_000

/**
 * Live health of the home network RPC: block height and round-trip latency, refreshed every 12 seconds.
 * The request itself retries with backoff (see rpcTransport), so "offline" means the endpoint stayed down
 * across all retries and any configured fallback RPC.
 */
export function useRpcHealth() {
  const client = usePublicClient({ chainId: asChainId(HOME_NETWORK.id) })
  const query = useQuery({
    queryKey: ['rpc-health', HOME_NETWORK.id],
    enabled: Boolean(client),
    refetchInterval: 12_000,
    retry: 1,
    retryDelay: 800,
    queryFn: async () => {
      if (!client) throw new Error('No RPC client')
      const started = performance.now()
      const [block, servedChain] = await Promise.all([client.getBlockNumber(), client.getChainId()])
      return { block, servedChain, latency: Math.round(performance.now() - started) }
    },
  })

  const status: RpcStatus = query.isError
    ? 'offline'
    : !query.data
      ? 'checking'
      : query.data.servedChain !== ARC_CHAIN_ID
        ? 'wrong-chain'
        : query.data.latency > SLOW_MS
          ? 'degraded'
          : 'online'
  let host = ''
  try {
    host = new URL(HOME_NETWORK.rpcUrls[0]).host
  } catch {
    host = HOME_NETWORK.rpcUrls[0]
  }
  return {
    status,
    block: query.data?.block,
    servedChain: query.data?.servedChain,
    latency: query.data?.latency,
    host,
    custom: HOME_NETWORK.rpcOverridden,
    retry: () => void query.refetch(),
    retrying: query.isFetching,
  }
}
