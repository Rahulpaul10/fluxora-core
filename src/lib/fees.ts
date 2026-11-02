import { parseGwei, type PublicClient } from 'viem'
import { Amount, gasTokenToUsdc } from '@/onchain-money'
import { ARC_CHAIN_ID } from '@/config/networks'

/** Arc enforces a 20 gwei maxFeePerGas floor; anything lower is rejected or silently dropped. */
export const ARC_MIN_FEE = parseGwei('20')

export interface Fees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

const FEE_TTL_MS = 10_000
let feeCache: { chainId: number; at: number; fees: Fees } | undefined
let feeInflight: { chainId: number; promise: Promise<Fees> } | undefined

/**
 * Fee quote for a transaction. Cached for 10 seconds and shared between callers, so opening the wallet never
 * waits on a fee request that was just made (Arc's base fee moves slowly; maxFeePerGas keeps ~20% headroom).
 */
export async function getFees(client: PublicClient, chainId: number): Promise<Fees> {
  if (feeCache && feeCache.chainId === chainId && Date.now() - feeCache.at < FEE_TTL_MS) return feeCache.fees
  if (feeInflight && feeInflight.chainId === chainId) return feeInflight.promise
  const promise = client.estimateFeesPerGas().then((fees) => {
    let maxFeePerGas = fees.maxFeePerGas
    if (chainId === ARC_CHAIN_ID && maxFeePerGas < ARC_MIN_FEE) maxFeePerGas = ARC_MIN_FEE
    const result = { maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
    feeCache = { chainId, at: Date.now(), fees: result }
    return result
  })
  feeInflight = { chainId, promise }
  try {
    return await promise
  } finally {
    if (feeInflight?.promise === promise) feeInflight = undefined
  }
}

/** Gas cost on Arc, expressed in 6-decimal USDC (the gas token is USDC in its 18-decimal native view). */
export function arcGasCostUsdc(gas: bigint, maxFeePerGas: bigint): Amount {
  const native = Amount.fromRaw(gas * maxFeePerGas, 18)
  return gasTokenToUsdc(ARC_CHAIN_ID, native, 'trunc')
}

/** Rounds a small USDC cost UP to 4 decimals so we never under-state the fee. */
export function fmtGasUsdc(cost: Amount): string {
  const fixed = cost.toFixed(4)
  return Number(fixed) === 0 && cost.isPositive() ? '< 0.0001' : fixed
}
