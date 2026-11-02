import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAllActivity } from '@/lib/activity'
import { onTxSettled, watchTransaction } from '@/lib/txRegistry'
import { explorerTx } from '@/config/networks'

/**
 * Starts tracking every locally recorded pending transaction the moment it appears (and again after a reload),
 * wherever you are in the app. When one settles it refreshes balances and tells you, even if you navigated away
 * from the page that sent it. It only reads from the chain: it never sends or resends anything.
 */
export function PendingReconciler() {
  const all = useAllActivity()
  const queryClient = useQueryClient()

  useEffect(() => {
    for (const r of all) if (r.status === 'pending') watchTransaction(r.hash, r.chainId, r.createdAt)
  }, [all])

  useEffect(() => {
    return onTxSettled(({ hash, chainId, success }) => {
        // Refresh balances and contract reads, but not the block-range history scan (expensive for the public RPC)
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'arc-transfers' && q.queryKey[0] !== 'rpc-health' })
        const link = explorerTx(chainId, hash)
        const action = { label: 'Explorer', onClick: () => window.open(link, '_blank', 'noopener,noreferrer') }
        if (success) toast.success('Transaction confirmed', { action })
        else toast.error('Transaction reverted onchain', { action })
      })
  }, [queryClient])

  return null
}
