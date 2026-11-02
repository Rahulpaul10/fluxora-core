import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import { checkNow, getTxState, subscribeTx, watchTransaction } from '@/lib/txRegistry'

/**
 * View of the shared per-hash tracker (see txRegistry). The status comes only from the chain receipt. Starting the
 * view starts tracking if nothing else did; "check again" re-reads the chain and never sends anything.
 */
export function useTxTracker(hash: Hex, chainId: number, onSettled?: (success: boolean) => void) {
  const state = useSyncExternalStore(
    subscribeTx,
    () => getTxState(hash, chainId),
    () => getTxState(hash, chainId),
  )

  useEffect(() => {
    watchTransaction(hash, chainId)
  }, [hash, chainId])

  const callback = useRef(onSettled)
  useEffect(() => {
    callback.current = onSettled
  })
  const notified = useRef<string>('')
  useEffect(() => {
    if (state.phase !== 'confirmed' && state.phase !== 'reverted') return
    const key = `${chainId}:${hash}`
    if (notified.current === key) return
    notified.current = key
    callback.current?.(state.phase === 'confirmed')
  }, [state.phase, hash, chainId])

  return { state, checkAgain: () => checkNow(hash, chainId) }
}
