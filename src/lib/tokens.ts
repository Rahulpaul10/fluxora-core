import { zeroAddress, type Address } from 'viem'
import { getUsdc } from '@/onchain-facts'
import { ARC_CHAIN_ID } from '@/config/networks'
import { FLUXORA } from '@/config/contracts'

export interface TokenInfo {
  symbol: string
  name: string
  address: Address
  decimals: number
  /** Brand tint for the fallback icon */
  color: string
}

const usdc = getUsdc(ARC_CHAIN_ID)
if (!usdc) throw new Error('Arc USDC is missing from the onchain facts registry')

export const USDC: TokenInfo = {
  symbol: 'USDC',
  name: 'USD Coin',
  address: usdc.address as Address,
  decimals: usdc.decimals,
  color: '#2775CA',
}

/**
 * Existing Arc mainnet tokens that have live Uniswap pools, so Swap works without any FLUXORA token.
 * Addresses come from the official Arc contract list (https://docs.arc.io/arc/references/contract-addresses).
 * Symbol and decimals were confirmed onchain, and each token was checked for a live Uniswap v3/v4 pool against
 * USDC. Nothing here is deployed or issued by FLUXORA, and no environment variable is needed.
 *
 * USYC (0x8a5D989Bbb96929F689B0200f435f53dA42bF490) is deliberately left out: it has no Uniswap pool on Arc
 * and is restricted to allowlisted institutions.
 */
export const EURC: TokenInfo = { symbol: 'EURC', name: 'Euro Coin', address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6, color: '#3B82F6' }
export const WETH: TokenInfo = { symbol: 'WETH', name: 'Wrapped Ether', address: '0x128cC466B61f542da60c70e3aA11c10e19B84EDB', decimals: 18, color: '#627EEA' }
export const CIRBTC: TokenInfo = { symbol: 'cirBTC', name: 'Circle Wrapped Bitcoin', address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8, color: '#F7931A' }

/**
 * Tokens FLUXORA supports on Arc: USDC plus the verified tokens above. FLUX is added only if you have deployed
 * your own FluxoraToken and set VITE_FLUXORA_TOKEN_ADDRESS. Decimals are re-read onchain by the balance hook.
 */
export const ARC_TOKENS: TokenInfo[] = [
  USDC,
  EURC,
  WETH,
  CIRBTC,
  ...(FLUXORA.token
    ? [{ symbol: 'FLUX', name: 'FLUXORA', address: FLUXORA.token, decimals: 18, color: '#8B5CF6' } satisfies TokenInfo]
    : []),
]

export const tokenBySymbol = (symbol: string) => ARC_TOKENS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase())
export const tokenByAddress = (address: string) =>
  ARC_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase())

/** Rejects the 0x0 / native sentinel that must never be used as a token on Arc. */
export const isSentinel = (address: string) => address.toLowerCase() === zeroAddress
