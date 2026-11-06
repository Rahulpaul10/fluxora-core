/**
 * Tests for the Send gas reserve (no network). Run:  bun run test:send
 *
 * Arc pays gas in the same USDC pool that is being sent, and the chain takes gasLimit x maxFeePerGas up front
 * before the token contract runs. `execute()` below models that rule, so the tests check what really decides
 * whether a transfer reverts with "ERC20: transfer amount exceeds balance".
 */
import { readFileSync } from 'node:fs'
import { parseGwei } from 'viem'
import { getUsdc } from '../src/onchain-facts'
import { bufferedGasLimit, GAS_BUFFER_DEN, GAS_BUFFER_NUM, prepaidGasReserveUsdc, WALLET_GAS_RATIO_DEN, WALLET_GAS_RATIO_NUM } from '../src/lib/fees'
import { checkSend, maxSendable } from '../src/lib/sendReserve'

let passed = 0
const ok = (cond: boolean, name: string) => {
  if (!cond) throw new Error(`FAIL: ${name}`)
  passed++
  console.log(`  ok  ${name}`)
}

const E12 = 10n ** 12n
const FEE = parseGwei('20')
const USDC1 = 1_000_000n // 1 USDC in the 6-decimal view

/** Real gas used by measurements against Arc: a transfer to another account vs the old transfer(self, 1) estimate. */
const REAL_TRANSFER_GAS = 49_338n
const OLD_SELF_ESTIMATE_GAS = 43_045n

/**
 * Chain model. `nativeBalance` is the 18-decimal gas-token view. The chain first takes gasLimit x maxFeePerGas, then
 * the USDC contract compares the amount with the 6-decimal view of what is left (rounded down).
 */
function execute(nativeBalance: bigint, amount: bigint, gasLimit: bigint, maxFee: bigint): 'ok' | 'no-gas' | 'revert' {
  const prepay = gasLimit * maxFee
  if (nativeBalance < prepay) return 'no-gas'
  return (nativeBalance - prepay) / E12 >= amount ? 'ok' : 'revert'
}
/** The gas limit the wallet picks for a plain transfer (Rabby reports 1.3 x the gas used). */
const walletGasLimit = (estimate: bigint) => (estimate * WALLET_GAS_RATIO_NUM) / WALLET_GAS_RATIO_DEN

function main() {
  console.log('Configuration is untouched')
  const usdc = getUsdc(5042)
  ok(usdc?.address === '0x3600000000000000000000000000000000000000' && usdc.decimals === 6, 'Arc USDC address and 6 decimals are unchanged')
  ok(GAS_BUFFER_NUM === 125n && GAS_BUFFER_DEN === 100n, 'gas multiplier is 1.25')
  ok(WALLET_GAS_RATIO_NUM === 130n && WALLET_GAS_RATIO_DEN === 100n && WALLET_GAS_RATIO_NUM * GAS_BUFFER_DEN >= GAS_BUFFER_NUM * WALLET_GAS_RATIO_DEN, 'the reserve assumes the wallet\'s 1.3 gas multiplier, never less than FLUXORA\'s 1.25')
  ok(bufferedGasLimit(100n) === 125n, 'other pages that still attach gas use the 1.25 multiplier')
  const guarded = readFileSync(new URL('../src/hooks/useGuardedWallet.ts', import.meta.url), 'utf8')
  const send = readFileSync(new URL('../src/pages/Send.tsx', import.meta.url), 'utf8')
  ok(send.includes('useGuardedWrite({ walletManagedFees: true })'), 'Send lets the wallet price the transfer (no gas or fee fields in its request)')
  ok(guarded.includes('if (walletManagedFees) return args'), 'wallet-managed mode returns the request untouched, after the revert-check estimate has run')

  console.log('Reserve covers the prepaid gas')
  {
    const reserve = prepaidGasReserveUsdc(REAL_TRANSFER_GAS, FEE)
    const prepaid = walletGasLimit(REAL_TRANSFER_GAS) * FEE
    ok(reserve * E12 >= prepaid, 'reserve (USDC) is at least gasLimit x maxFee')
    ok(reserve * E12 < prepaid * 2n, 'reserve is not wildly larger than needed')
    ok(reserve === 1412n, 'reserve for 49,338 gas at 20 gwei is 0.001412 USDC (wallet 1.3x gas, +10% fee headroom, rounded up)')
    let worst = true
    for (let i = 0; i < 2000; i++) {
      const gas = BigInt(21_000 + ((i * 7919) % 400_000))
      const fee = FEE + BigInt((i * 104729) % 200) * 1_000_000_000n
      if (prepaidGasReserveUsdc(gas, fee) * E12 < walletGasLimit(gas) * fee) worst = false
    }
    ok(worst, 'reserve covers the prepayment for 2,000 gas and fee combinations')
  }

  console.log('Max')
  {
    const gasLimit = walletGasLimit(REAL_TRANSFER_GAS)
    const reserve = prepaidGasReserveUsdc(REAL_TRANSFER_GAS, FEE)
    // the old logic: 1.2 x cost of transfer(self, 1) left in the account
    const oldCost = (OLD_SELF_ESTIMATE_GAS * FEE) / E12
    const oldReserve = (oldCost * 12n) / 10n
    const balance = 25n * USDC1
    ok(execute(balance * E12, balance - oldReserve, gasLimit, FEE) === 'revert', 'regression: the OLD Max amount reverts with insufficient balance once gas is prepaid')
    const max = maxSendable(balance, reserve)
    ok(max > 0n && max < balance, 'Max is below the balance')
    ok(execute(balance * E12, max, gasLimit, FEE) === 'ok', 'the NEW Max amount executes')
    ok(balance - max >= reserve, 'Max leaves at least the reserve')
    ok(checkSend({ isUsdc: true, amount: max, tokenBalance: balance, usdcBalance: balance, reserve }).kind === 'ok', 'Max passes validation')
    // after Max is filled in, the amount changes and gas is re-estimated: a slightly larger estimate must still pass
    const reserve2 = prepaidGasReserveUsdc(REAL_TRANSFER_GAS + 60n, FEE)
    ok(checkSend({ isUsdc: true, amount: max, tokenBalance: balance, usdcBalance: balance, reserve: reserve2 }).kind === 'ok', 'Max is still valid after a re-estimate that is a little higher')
    ok(maxSendable(0n, reserve) === 0n && maxSendable(reserve, reserve) === 0n && maxSendable(reserve + 1n, reserve) === 0n, 'Max is 0 when the balance cannot cover the gas reserve')
  }

  console.log('Near-full-balance transfers')
  {
    const reserve = prepaidGasReserveUsdc(REAL_TRANSFER_GAS, FEE)
    const gasLimit = walletGasLimit(REAL_TRANSFER_GAS)
    const balance = 3n * USDC1
    const largestAllowed = balance - reserve
    const v = (amount: bigint) => checkSend({ isUsdc: true, amount, tokenBalance: balance, usdcBalance: balance, reserve })
    ok(v(largestAllowed).kind === 'ok', 'exactly balance minus reserve is allowed')
    ok(execute(balance * E12, largestAllowed, gasLimit, FEE) === 'ok', '... and executes')
    const over = v(largestAllowed + 1n)
    ok(over.kind === 'insufficient-gas' && over.kind === 'insufficient-gas' && over.reserve === reserve, 'one unit more is refused with the reserve in the result')
    ok(over.kind === 'insufficient-gas' && over.max === maxSendable(balance, reserve), '... and reports the most that can be sent')
    const exactNeed = (gasLimit * FEE + E12 - 1n) / E12 // what the chain really takes, rounded up to a unit
    ok(execute(balance * E12, balance - exactNeed + 1n, gasLimit, FEE) !== 'ok' && v(balance - exactNeed + 1n).kind === 'insufficient-gas', 'an amount that really would fail on chain is refused (the reserve adds a safety margin on top)')
    ok(v(balance).kind === 'insufficient-gas', 'sending the entire balance is refused')
    ok(v(balance - 1n).kind === 'insufficient-gas', 'leaving 1 micro-USDC is refused')
    ok(v(balance - reserve + 1n).kind === 'insufficient-gas', 'leaving one unit less than the reserve is refused')
  }

  console.log('Insufficient balance')
  {
    const reserve = prepaidGasReserveUsdc(REAL_TRANSFER_GAS, FEE)
    ok(checkSend({ isUsdc: true, amount: 5n * USDC1 + 1n, tokenBalance: 5n * USDC1, usdcBalance: 5n * USDC1, reserve }).kind === 'insufficient-balance', 'more than the balance is "insufficient balance"')
    ok(checkSend({ isUsdc: true, amount: 1n, tokenBalance: 0n, usdcBalance: 0n, reserve }).kind === 'insufficient-balance', 'an empty wallet cannot send')
    ok(checkSend({ isUsdc: true, amount: 5n * USDC1 + 1n, tokenBalance: 5n * USDC1, usdcBalance: 5n * USDC1, reserve: undefined }).kind === 'insufficient-balance', 'the balance check does not wait for the fee')
    const tiny = checkSend({ isUsdc: true, amount: 1n, tokenBalance: reserve, usdcBalance: reserve, reserve })
    ok(tiny.kind === 'insufficient-gas' && tiny.max === 0n, 'a balance that only covers the gas cannot send anything')
  }

  console.log('Other tokens pay gas in USDC')
  {
    const reserve = prepaidGasReserveUsdc(REAL_TRANSFER_GAS, FEE)
    const c = (usdcBalance: bigint | undefined) => checkSend({ isUsdc: false, amount: 10n ** 18n, tokenBalance: 10n ** 18n, usdcBalance, reserve })
    ok(c(reserve).kind === 'ok', 'the full token balance can be sent when USDC covers the gas')
    ok(c(reserve - 1n).kind === 'insufficient-gas', 'not enough USDC for gas blocks a non-USDC transfer')
    const blocked = c(0n)
    ok(blocked.kind === 'insufficient-gas' && blocked.max === 0n, 'no USDC at all: blocked')
    ok(c(undefined).kind === 'fee-unknown', 'USDC balance not loaded yet: not allowed through')
  }

  console.log('Fee unknown never passes')
  ok(checkSend({ isUsdc: true, amount: 1n, tokenBalance: USDC1, usdcBalance: USDC1, reserve: undefined }).kind === 'fee-unknown', 'no fee estimate: the transfer is not allowed')

  console.log('Property: whatever validation accepts executes on the chain model')
  {
    let seed = 12345
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    let accepted = 0
    let refusedThatWouldFail = 0
    let refusedButFine = 0
    for (let i = 0; i < 20_000; i++) {
      const gasEstimate = BigInt(30_000 + rnd(200_000))
      const maxFee = FEE + BigInt(rnd(120)) * 1_000_000_000n
      const walletFee = maxFee + (BigInt(rnd(10)) * maxFee) / 100n // wallet may use a fee up to 9% higher than the estimate
      const balanceView = BigInt(rnd(40_000_000)) // up to 40 USDC
      const dust = BigInt(rnd(1_000_000)) * 1_000_000n // sub-microdollar native dust the 6-decimal view hides
      const nativeBalance = balanceView * E12 + dust
      const reserve = prepaidGasReserveUsdc(gasEstimate, maxFee)
      // amounts concentrated around the boundary
      const amount = balanceView > reserve ? balanceView - reserve + BigInt(rnd(5000)) - 2500n : BigInt(rnd(100))
      if (amount <= 0n || amount > balanceView) continue
      const verdict = checkSend({ isUsdc: true, amount, tokenBalance: balanceView, usdcBalance: balanceView, reserve })
      const result = execute(nativeBalance, amount, walletGasLimit(gasEstimate), walletFee)
      if (verdict.kind === 'ok') {
        accepted++
        if (result !== 'ok') throw new Error(`FAIL: accepted ${amount} of ${balanceView} (gas ${gasEstimate}, fee ${maxFee}) but chain says ${result}`)
      } else if (result !== 'ok') refusedThatWouldFail++
      else refusedButFine++
    }
    ok(accepted > 1000, `validation accepted ${accepted} boundary amounts, and every one executes (with a wallet fee up to 9% above the estimate)`)
    ok(refusedThatWouldFail > 0, `validation refused ${refusedThatWouldFail} amounts that would fail on chain, and ${refusedButFine} that would have fit (safety margin)`)
    // Max itself
    for (let i = 0; i < 5000; i++) {
      const gasEstimate = BigInt(30_000 + rnd(200_000))
      const maxFee = FEE + BigInt(rnd(120)) * 1_000_000_000n
      const balanceView = BigInt(2_000_000 + rnd(50_000_000))
      const dust = BigInt(rnd(1_000_000)) * 1_000_000n
      const reserve = prepaidGasReserveUsdc(gasEstimate, maxFee)
      const max = maxSendable(balanceView, reserve)
      if (max === 0n) continue
      const result = execute(balanceView * E12 + dust, max, walletGasLimit(gasEstimate), maxFee)
      if (result !== 'ok') throw new Error(`FAIL: Max ${max} of ${balanceView} reverts (${result}) for gas ${gasEstimate}, fee ${maxFee}`)
    }
    ok(true, 'Max executes for 5,000 random balances, gas estimates and fees')
  }

  console.log(`\n${passed} checks passed`)
}

main()
