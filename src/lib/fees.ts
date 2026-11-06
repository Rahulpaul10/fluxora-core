import { parseGwei, type PublicClient } from 'viem'
import { Amount, gasTokenToUsdc, usdcToGasToken } from '@/onchain-money'
import { ARC_CHAIN_ID } from '@/config/networks'

/**
 * Every transaction gets its estimated gas multiplied by this before the wallet is asked to sign
 * (see useGuardedWallet). The wallet and the chain reserve gasLimit x maxFeePerGas up front.
 */
export const GAS_BUFFER_NUM = 125n
export const GAS_BUFFER_DEN = 100n
export const bufferedGasLimit = (estimate: bigint): bigint => (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN

/**
 * When the wallet prices a transfer itself (Send), it picks its own gas limit. Rabby's simulation reports a gas limit of
 * 1.3 x the gas used (its `gas_ratio`), so the reserve assumes that, which is above the 1.25 FLUXORA uses elsewhere.
 */
export const WALLET_GAS_RATIO_NUM = 130n
export const WALLET_GAS_RATIO_DEN = 100n

/** Extra headroom on maxFeePerGas for the reserve, because the fee can move between the estimate and the signature. */
const FEE_HEADROOM_NUM = 110n
const FEE_HEADROOM_DEN = 100n

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

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/**
 * USDC (6-decimal ERC-20 view, rounded UP) that must stay in the account for a transfer to execute.
 * On Arc gas is paid in the same USDC pool, and the chain takes gasLimit x maxFeePerGas up front, so a transfer
 * only succeeds if balance - amount >= that prepayment. Assumes the wallet's own gas multiplier (1.3, never less than
 * FLUXORA's 1.25), plus fee headroom, and rounds up so the ERC-20 view (which rounds balances down) can never fall short.
 */
export function prepaidGasReserveUsdc(estimatedGas: bigint, maxFeePerGas: bigint): bigint {
  const gasLimit = ceilDiv(estimatedGas * WALLET_GAS_RATIO_NUM, WALLET_GAS_RATIO_DEN)
  const fee = ceilDiv(maxFeePerGas * FEE_HEADROOM_NUM, FEE_HEADROOM_DEN)
  const native = Amount.fromRaw(gasLimit * fee, 18)
  const floor = gasTokenToUsdc(ARC_CHAIN_ID, native, 'trunc')
  const exact = usdcToGasToken(ARC_CHAIN_ID, floor).raw >= native.raw
  return exact ? floor.raw : floor.raw + 1n
}

/** Rounds a small USDC cost UP to 4 decimals so we never under-state the fee. */
export function fmtGasUsdc(cost: Amount): string {
  const fixed = cost.toFixed(4)
  return Number(fixed) === 0 && cost.isPositive() ? '< 0.0001' : fixed
}
