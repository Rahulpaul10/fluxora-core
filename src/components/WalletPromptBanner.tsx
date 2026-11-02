import { useNow } from '@/hooks/useNow'
import { useWalletPrompt } from '@/hooks/useGuardedWallet'
import { Spinner } from './ui'

/** Shown while a wallet confirmation is open, so the user always knows the app is waiting for their wallet. */
export function WalletPromptBanner() {
  const { stage, since, popupSeen } = useWalletPrompt()
  const now = useNow(1_000)
  if (stage !== 'wallet') return null
  const waited = Math.max(0, now - since)
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 top-[72px] z-[60] mx-auto flex max-w-md items-start gap-3 rounded-2xl border border-white/15 bg-navy-800/95 p-3.5 text-sm shadow-glow backdrop-blur-xl"
    >
      <Spinner />
      <div className="min-w-0">
        <p className="font-semibold text-white">Confirm in your wallet</p>
        <p className="text-xs text-slate-300">
          {waited < 8 || popupSeen
            ? waited < 12
              ? 'Review the details in the wallet popup and approve to continue.'
              : 'Your wallet window is open. Approve or reject there; this page keeps waiting and will not send twice.'
            : 'No wallet window came to the front. Click the MetaMask icon in your browser toolbar to see the pending request. Do not click Send again; the request is already waiting.'}
        </p>
      </div>
    </div>
  )
}
