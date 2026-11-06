import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useAccountSync } from '@/hooks/useAccountSync'
import { sameAddress } from '@/lib/accountSync'
import { shortAddr } from '@/lib/format'
import { Notice } from './ui'

/**
 * Tells the user, in the page, whenever the wallet account in use is not the one they were looking at:
 *  - the wallet moved to another account without telling the app: sends are blocked until the user chooses;
 *  - the wallet announced a switch: balances and sends now follow it, and this says so.
 * Nothing here switches accounts by itself.
 */
export function AccountNotice() {
  const { address, isConnected } = useAccount()
  const { mismatch, adopt } = useAccountSync()
  const shown = isConnected ? address : undefined

  // Remember which account was in use, and what it changed from. Adjusted while rendering (not in an effect)
  // so the notice appears in the same render in which the address changes.
  const [track, setTrack] = useState<{ current?: string; changed?: { from: string; to: string } }>({ current: shown })
  if ((track.current ?? '').toLowerCase() !== (shown ?? '').toLowerCase()) {
    setTrack({ current: shown, changed: track.current && shown ? { from: track.current, to: shown } : undefined })
  }
  const changed = track.changed

  if (!shown) return null

  if (mismatch) {
    return (
      <div className="mb-4" role="alert">
        <Notice
          tone="warn"
          action={
            <button className="min-h-[44px] shrink-0 px-2 font-semibold underline underline-offset-2" onClick={() => void adopt()}>
              Use {shortAddr(mismatch)}
            </button>
          }
        >
          <p className="font-semibold">Your wallet is on a different account</p>
          <p className="mt-1">
            Your wallet is on <span className="font-mono">{shortAddr(mismatch)}</span>, but FLUXORA is showing <span className="font-mono">{shortAddr(shown)}</span>.
            Balances and transfers use <span className="font-mono">{shortAddr(shown)}</span>, and sending is blocked until you choose an account.
          </p>
        </Notice>
      </div>
    )
  }

  if (changed && sameAddress(changed.to, shown)) {
    return (
      <div className="mb-4" role="status" title={`Previous account: ${changed.from}`}>
        <Notice
          tone="warn"
          action={
            <button className="min-h-[44px] shrink-0 px-2 font-semibold underline underline-offset-2" onClick={() => setTrack({ current: track.current })}>
              Dismiss
            </button>
          }
        >
          <p className="font-semibold">Your wallet switched accounts</p>
          <p className="mt-1">
            FLUXORA is now using <span className="font-mono">{shortAddr(shown)}</span>. The balance shown and any transfer you send come from this account.
          </p>
        </Notice>
      </div>
    )
  }

  return null
}
