import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { ARC_CHAIN_ID } from '@/config/networks'
import { formatDiagnostics, runWalletDiagnostics } from '@/lib/walletDiagnostics'

const INTERVAL_MS = 20_000
const SLOW_MS = 1_500

/**
 * Keeps the wallet extension awake while a wallet is connected and the tab is visible.
 * Browser wallets such as MetaMask run in a service worker that sleeps when idle. Measured in a real session, the
 * first request after idle took 6.3 seconds against 13 ms when awake, and that cold start is paid again when you
 * press Send. A tiny local request (the wallet's chain id: no popup, no permission, no network) every 20 seconds
 * keeps it ready, so the confirmation opens right away.
 */
let diagRan = false

export function WalletWarmup() {
  const { connector, isConnected, chainId } = useAccount()

  // Inside the Arc Studio preview (or with ?diag=1) run the RPC comparison once per page load and log it, so a slow
  // wallet connection shows up in the console without any clicks. Read-only.
  useEffect(() => {
    const wanted = window.parent !== window || new URLSearchParams(window.location.search).has('diag')
    if (!wanted || diagRan || !isConnected || chainId !== ARC_CHAIN_ID) return
    diagRan = true
    const id = setTimeout(() => {
      void runWalletDiagnostics().then((r) => console.info(formatDiagnostics(r)))
    }, 3_000)
    return () => clearTimeout(id)
  }, [isConnected, chainId])

  useEffect(() => {
    if (!isConnected || !connector) return
    const ping = async () => {
      if (document.hidden) return
      const started = performance.now()
      try {
        await connector.getChainId()
      } catch {
        return // locked or unreachable wallets are reported when a transaction is attempted
      }
      const took = Math.round(performance.now() - started)
      if (took > SLOW_MS) console.info(`[FLUXORA timing] the wallet took ${took} ms to answer a ping (it was asleep)`)
    }
    void ping()
    const id = setInterval(() => void ping(), INTERVAL_MS)
    const onVisible = () => {
      if (!document.hidden) void ping()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [connector, isConnected])

  return null
}
