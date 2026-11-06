/**
 * Account consistency rules. Pure functions, no wagmi or network imports, so they run in unit tests
 * (bun run test:account).
 *
 * Three views of "the sender" must always be the same account:
 *   shown    the account FLUXORA displays and reads balances for (wagmi's cached connection)
 *   request  the account named in the transaction request (`from`)
 *   live     the account the wallet itself reports right now (eth_accounts)
 * wagmi only updates `shown` when the wallet announces a change, and wallets such as Rabby do not announce every
 * switch, so `live` can differ from `shown`. Sending in that state would simulate and sign a different account
 * than the one whose balance was checked.
 */
import type { Address } from 'viem'

export const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase())

const short = (a: string) => (a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`)

export type AccountCheck =
  | { ok: true }
  | { ok: false; code: 'no-account' | 'account-changed' | 'sender-mismatch'; message: string; live?: Address }

/**
 * @param shown     the account shown in FLUXORA (balances, "From")
 * @param request   the account that will be the transaction's `from` (defaults to `shown`)
 * @param live      what the wallet reports right now (eth_accounts); the first entry is its active account
 */
export function checkSender(opts: { shown: Address; request?: Address; live: readonly Address[] }): AccountCheck {
  const { shown, live } = opts
  const request = opts.request ?? shown
  if (!sameAddress(request, shown)) {
    return {
      ok: false,
      code: 'sender-mismatch',
      message: `This transfer was prepared for ${short(request)}, but FLUXORA is showing ${short(shown)}. Nothing was sent. Reload the page and try again.`,
    }
  }
  const active = live[0]
  if (!active) {
    return { ok: false, code: 'no-account', message: 'Your wallet did not report a connected account. Unlock it or reconnect, then try again. Nothing was sent.' }
  }
  if (!sameAddress(active, shown)) {
    return {
      ok: false,
      code: 'account-changed',
      live: active,
      message: `Your wallet is on account ${short(active)}, but FLUXORA is showing ${short(shown)}. Nothing was sent. Choose which account to use (see the notice at the top), then try again.`,
    }
  }
  return { ok: true }
}

export type SenderVerdict = { status: 'match' } | { status: 'mismatch'; actual: Address } | { status: 'unknown' }

/**
 * After a wallet returns a hash, reads the transaction back and compares its `from` with the account FLUXORA
 * showed. A new transaction may take a moment to be visible, so a few short retries are allowed; if it never
 * shows up the answer is "unknown", never "match".
 */
export async function verifySender(
  client: { getTransaction(args: { hash: `0x${string}` }): Promise<{ from: Address }> },
  hash: `0x${string}`,
  expected: Address,
  opts: { tries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<SenderVerdict> {
  const tries = opts.tries ?? 5
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await client.getTransaction({ hash })
      return sameAddress(tx.from, expected) ? { status: 'match' } : { status: 'mismatch', actual: tx.from }
    } catch {
      if (i < tries - 1) await wait(1_000)
    }
  }
  return { status: 'unknown' }
}
