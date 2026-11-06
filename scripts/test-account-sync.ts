/**
 * Tests for account consistency (no network). Run:  bun run test:account
 *
 * The shown account (balances, "From"), the account named in the transaction request and the account the wallet
 * reports must be the same. These tests cover the rules; test:wallet covers the same behavior in the real page.
 */
import type { Address } from 'viem'
import { checkSender, sameAddress, verifySender } from '../src/lib/accountSync'
import { TxError, parseTxError } from '../src/lib/errors'

let passed = 0
const ok = (cond: boolean, name: string) => {
  if (!cond) throw new Error(`FAIL: ${name}`)
  passed++
  console.log(`  ok  ${name}`)
}

const A = '0x000000000000000000000000000000000000dEaD' as Address
const B = '0x000000000000000000000000000000000000bEEF' as Address
const HASH = `0x${'ab'.repeat(32)}` as `0x${string}`
const noWait = async () => undefined

async function main() {
  console.log('Address comparison')
  ok(sameAddress(A, A.toLowerCase()) && sameAddress(A.toUpperCase().replace('0X', '0x'), A), 'checksummed, lower and upper case are the same account')
  ok(!sameAddress(A, B) && !sameAddress(undefined, A) && !sameAddress(A, undefined), 'different or missing addresses are not the same')

  console.log('Shown account vs the wallet')
  ok(checkSender({ shown: A, live: [A] }).ok, 'wallet reports the shown account: allowed')
  ok(checkSender({ shown: A, live: [A.toLowerCase() as Address] }).ok, 'case does not matter')
  {
    const r = checkSender({ shown: A, live: [B] })
    ok(!r.ok && r.code === 'account-changed' && r.live === B, 'wallet on another account: blocked as account-changed, with the wallet account')
    ok(!r.ok && r.message.includes('0x0000…bEEF') && r.message.includes('0x0000…dEaD') && r.message.includes('Nothing was sent'), '... and the message names both accounts and says nothing was sent')
  }
  ok(!checkSender({ shown: A, live: [B, A] }).ok, 'the wallet\'s FIRST (active) account decides, even if the shown account is also in the list')
  {
    const r = checkSender({ shown: A, live: [] })
    ok(!r.ok && r.code === 'no-account', 'wallet reports no account: blocked')
  }

  console.log('Request sender vs shown account')
  ok(checkSender({ shown: A, request: A, live: [A] }).ok, 'request sender equals the shown account: allowed')
  {
    const r = checkSender({ shown: A, request: B, live: [A] })
    ok(!r.ok && r.code === 'sender-mismatch', 'request prepared for a different account than the one shown: blocked as sender-mismatch')
    ok(!r.ok && r.message.includes('0x0000…bEEF') && r.message.includes('Nothing was sent'), '... naming the account and saying nothing was sent')
  }
  {
    const r = checkSender({ shown: A, request: B, live: [B] })
    ok(!r.ok && r.code === 'sender-mismatch', 'the request matching only the wallet (not the shown account) is still blocked')
  }

  console.log('Errors reach the user unchanged')
  {
    const r = checkSender({ shown: A, live: [B] })
    if (r.ok) throw new Error('unexpected')
    const parsed = parseTxError(new TxError(r.code, r.message))
    ok(!parsed.rejected && parsed.message === r.message, 'the guard message is shown as written, and is not treated as a cancelled prompt')
  }

  console.log('Sender read back from the chain')
  {
    const same = await verifySender({ getTransaction: async () => ({ from: A.toLowerCase() as Address }) }, HASH, A, { wait: noWait })
    ok(same.status === 'match', 'transaction from the shown account: match')
    const other = await verifySender({ getTransaction: async () => ({ from: B }) }, HASH, A, { wait: noWait })
    ok(other.status === 'mismatch' && other.actual === B, 'transaction from another account: mismatch, reporting the real sender')
    let calls = 0
    const late = await verifySender(
      { getTransaction: async () => { calls++; if (calls < 3) throw new Error('not found'); return { from: A } } },
      HASH, A, { wait: noWait },
    )
    ok(late.status === 'match' && calls === 3, 'a transaction that appears after a moment is still verified')
    const never = await verifySender({ getTransaction: async () => { throw new Error('not found') } }, HASH, A, { tries: 4, wait: noWait })
    ok(never.status === 'unknown', 'a transaction that never shows up is "unknown", never "match"')
  }

  console.log(`\n${passed} checks passed`)
}

await main()
