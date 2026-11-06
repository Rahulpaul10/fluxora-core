import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { sameAddress } from '@/lib/accountSync'

/**
 * Compares the account FLUXORA is showing (wagmi's cached connection) with the account the wallet itself reports.
 * Wallets such as Rabby do not always announce an account switch, so the two can differ. It never switches on its own:
 * `mismatch` is set and the user decides, via `adopt`.
 */
export function useAccountSync() {
  const { address, connector, isConnected } = useAccount()
  // What the wallet answered, together with the shown account and connector it was asked for. An answer that belongs
  // to an older shown account (for example right after the wallet announced a switch) is ignored until it is refreshed.
  const [snap, setSnap] = useState<{ live?: Address; shown?: string; uid?: string }>({})

  const refresh = useCallback(async () => {
    if (!connector || !isConnected) return
    try {
      const accounts = await connector.getAccounts()
      setSnap({ live: accounts[0], shown: address, uid: connector.uid })
    } catch {
      // Wallet locked or asleep: keep the last answer instead of guessing
    }
  }, [connector, isConnected, address])

  useEffect(() => {
    const again = () => void refresh()
    const first = setTimeout(again, 0) // asynchronous on purpose: the answer arrives after the wallet replies
    const timer = setInterval(again, 10_000)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [refresh])

  const current = connector && snap.uid === connector.uid && sameAddress(snap.shown, address)
  const live = current ? snap.live : undefined
  const mismatch: Address | undefined = isConnected && address && live && !sameAddress(live, address) ? live : undefined

  /** The user's explicit choice: start using the wallet's account. */
  const adopt = useCallback(async () => {
    if (!connector) return
    const accounts = await connector.getAccounts()
    if (accounts.length > 0) connector.onAccountsChanged?.(accounts as string[])
  }, [connector])

  return { shown: address, live, mismatch, adopt, refresh }
}
