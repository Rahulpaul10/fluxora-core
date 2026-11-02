/**
 * Centralized network configuration for FLUXORA.
 *
 * Every chain id, RPC URL and explorer URL the app uses comes from here. Defaults are read from Arc
 * Studio's onchain facts registry (never typed by hand) and can be overridden with environment variables:
 *
 *   VITE_ARC_RPC_URL           RPC endpoint for Arc mainnet (the home network)
 *   VITE_ARC_EXPLORER_URL      Block explorer base URL for Arc mainnet
 *   VITE_RPC_URL_<chainId>     RPC endpoint for any other network, e.g. VITE_RPC_URL_8453 for Base
 *   VITE_EXPLORER_URL_<chainId> Explorer base URL for any other network
 *
 * To add a network later: add a viem chain to NETWORKS below (and to the chain tuple in ./wallet). The network
 * selector, explorer links and RPC settings then pick it up. Features that only
 * run on the home network (Send, Swap, Pay) stay on Arc.
 */
import { fallback, http, type Chain, type Transport } from 'viem'
import { arc, mainnet, base, arbitrum, optimism, polygon, avalanche } from 'viem/chains'
import { requireChain } from '@/onchain-facts'
import { reportConfigIssue } from '@/lib/configIssues'

export type KitChainName = 'Arc' | 'Ethereum' | 'Base' | 'Arbitrum' | 'Optimism' | 'Polygon' | 'Avalanche'

export interface NetworkConfig {
  id: number
  /** Chain identifier used by Circle App Kit (CCTP bridging) */
  kit: KitChainName
  name: string
  short: string
  /** Gas token symbol */
  gas: string
  color: string
  chain: Chain
  /** RPC endpoints in priority order: the configured override first, then the registry default */
  rpcUrls: string[]
  explorerUrl: string
  /** The home network is where Send, Swap and Pay run */
  isHome: boolean
  /** True when an environment variable replaced the default RPC */
  rpcOverridden: boolean
}

type EnvBag = Record<string, string | undefined>
const env = import.meta.env as unknown as EnvBag

function cleanUrl(value: string | undefined, label: string): string | undefined {
  const v = value?.trim()
  if (!v) return undefined
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol')
    return v.replace(/\/+$/, '')
  } catch {
    reportConfigIssue(`${label} is not a valid http(s) URL, so the built-in default is used instead.`)
    return undefined
  }
}

function define(
  chain: Chain,
  meta: Pick<NetworkConfig, 'kit' | 'name' | 'short' | 'gas' | 'color'>,
  opts: { home?: boolean; rpcEnv?: string; explorerEnv?: string } = {},
): NetworkConfig {
  const fact = requireChain(chain.id)
  const override = cleanUrl(opts.rpcEnv ? env[opts.rpcEnv] : undefined, opts.rpcEnv ?? 'RPC') ?? cleanUrl(env[`VITE_RPC_URL_${chain.id}`], `VITE_RPC_URL_${chain.id}`)
  const explorerUrl =
    cleanUrl(opts.explorerEnv ? env[opts.explorerEnv] : undefined, opts.explorerEnv ?? 'explorer') ??
    cleanUrl(env[`VITE_EXPLORER_URL_${chain.id}`], `VITE_EXPLORER_URL_${chain.id}`) ??
    fact.explorerBase.replace(/\/+$/, '')
  const rpcUrls = [...(override ? [override] : []), ...fact.rpcUrls.filter((u) => u !== override)]
  return {
    id: chain.id,
    ...meta,
    chain: {
      ...chain,
      rpcUrls: { ...chain.rpcUrls, default: { http: rpcUrls } },
      blockExplorers: { default: { name: 'Explorer', url: explorerUrl } },
    },
    rpcUrls,
    explorerUrl,
    isHome: Boolean(opts.home),
    rpcOverridden: Boolean(override),
  }
}

export const NETWORKS: NetworkConfig[] = [
  define(arc, { kit: 'Arc', name: 'Arc', short: 'ARC', gas: 'USDC', color: '#8257FF' }, { home: true, rpcEnv: 'VITE_ARC_RPC_URL', explorerEnv: 'VITE_ARC_EXPLORER_URL' }),
  define(mainnet, { kit: 'Ethereum', name: 'Ethereum', short: 'ETH', gas: 'ETH', color: '#627EEA' }),
  define(base, { kit: 'Base', name: 'Base', short: 'BASE', gas: 'ETH', color: '#2F6BFF' }),
  define(arbitrum, { kit: 'Arbitrum', name: 'Arbitrum One', short: 'ARB', gas: 'ETH', color: '#27D9FF' }),
  define(optimism, { kit: 'Optimism', name: 'OP Mainnet', short: 'OP', gas: 'ETH', color: '#FF4B5C' }),
  define(polygon, { kit: 'Polygon', name: 'Polygon', short: 'POL', gas: 'POL', color: '#A06BFF' }),
  define(avalanche, { kit: 'Avalanche', name: 'Avalanche', short: 'AVAX', gas: 'AVAX', color: '#FF5C5C' }),
]

export const HOME_NETWORK = NETWORKS.find((n) => n.isHome) as NetworkConfig
export const ARC_CHAIN_ID = arc.id

/** Chain ids wagmi knows about, as a literal union. Use asChainId() where a plain number comes from state. */
export type SupportedChainId = (typeof import('./wallet').config)['chains'][number]['id']
export const asChainId = (id: number) => id as SupportedChainId
/** Back-compat alias used across the app */
export type NetworkInfo = NetworkConfig

export const networkById = (id: number | undefined) => NETWORKS.find((n) => n.id === id)
export const isSupportedChain = (id: number | undefined) => networkById(id) !== undefined

const join = (n: NetworkConfig, path: string) => `${n.explorerUrl}/${path}`
export const explorerTx = (chainId: number, hash: string) => {
  const n = networkById(chainId)
  return n ? join(n, `tx/${hash}`) : '#'
}
export const explorerAddress = (chainId: number, address: string) => {
  const n = networkById(chainId)
  return n ? join(n, `address/${address}`) : '#'
}

/**
 * Transport with retries and failover. A failed request is retried with backoff, and if an endpoint
 * stays down the next configured RPC URL is tried.
 */
export function rpcTransport(network: NetworkConfig): Transport {
  const endpoints = network.rpcUrls.map((url) => http(url, { retryCount: 3, retryDelay: 400, timeout: 12_000, batch: { batchSize: 25, wait: 16 } }))
  return endpoints.length > 1 ? fallback(endpoints, { rank: false, retryCount: 1 }) : endpoints[0]
}
