/**
 * Send-amount rules for Arc, where gas is paid from the same USDC pool that is being sent.
 *
 * A transfer executes only if  balance - amount >= reserve  (reserve = gasLimit x maxFeePerGas, rounded up;
 * see prepaidGasReserveUsdc in ./fees). Pure functions, no network, so they are unit tested (bun run test:send).
 */

/** "Max" leaves the reserve plus this extra share, so re-estimating after the amount changes cannot flip it to invalid. */
const MAX_CUSHION_DIVISOR = 50n // 2% of the reserve

/** Largest USDC amount (raw, 6 decimals) the Max button may fill in. Never negative. */
export function maxSendable(usdcBalance: bigint, reserve: bigint): bigint {
  const keep = reserve + (reserve + MAX_CUSHION_DIVISOR - 1n) / MAX_CUSHION_DIVISOR
  return usdcBalance > keep ? usdcBalance - keep : 0n
}

export type SendCheck =
  | { kind: 'ok' }
  | { kind: 'insufficient-balance' }
  /** Not enough USDC for the network fee. `max` is the most that could be sent (USDC raw), 0 for a non-USDC token. */
  | { kind: 'insufficient-gas'; reserve: bigint; max: bigint }
  /** The fee could not be estimated yet, so the transfer cannot be proven safe. */
  | { kind: 'fee-unknown' }

/**
 * Decides whether a transfer can succeed. `tokenBalance` is the balance of the token being sent, `usdcBalance` the
 * USDC balance (the same value for USDC), `reserve` the prepaid gas in USDC raw, undefined while it is unknown.
 */
export function checkSend(opts: {
  isUsdc: boolean
  amount: bigint
  tokenBalance: bigint | undefined
  usdcBalance: bigint | undefined
  reserve: bigint | undefined
}): SendCheck {
  const { isUsdc, amount, tokenBalance, usdcBalance, reserve } = opts
  if (tokenBalance !== undefined && amount > tokenBalance) return { kind: 'insufficient-balance' }
  if (reserve === undefined || usdcBalance === undefined) return { kind: 'fee-unknown' }
  const need = isUsdc ? amount + reserve : reserve
  if (usdcBalance < need) return { kind: 'insufficient-gas', reserve, max: isUsdc ? maxSendable(usdcBalance, reserve) : 0n }
  return { kind: 'ok' }
}
