import type { Hex } from 'viem'
import { getPublicClient } from 'wagmi/actions'
import { config } from '@/config/wallet'
import { asChainId } from '@/config/networks'
import { updateActivity } from './activity'
import { formatTimeline, mark, type Timeline } from './txTimeline'
import { trackTransaction, type Poker, type ReceiptClient, type TrackState } from './txTracker'

/**
 * One receipt tracker per transaction hash for the whole app, independent of which page is open.
 *
 * Before this existed the tracker lived inside the status card. If you navigated away while MetaMask was still
 * open, the hash arrived at a page that no longer existed and nothing watched the transaction until a delayed
 * background job picked it up. Now tracking starts the moment a pending record is created, the status card is just a
 * view of the shared state, and a hidden tab is woken the instant it becomes visible again.
 * It only reads from the chain: it can never send or resend anything.
 */

const PENDING: TrackState = { phase: 'pending', elapsedMs: 0, attempts: 0 }
/** A hash the network has never recorded after this long is shown as "Not found", not "Pending" forever. */
const DROPPED_AFTER_SECONDS = 30 * 60

const keyOf = (hash: Hex, chainId: number) => `${chainId}:${hash.toLowerCase()}`

let states = new Map<string, TrackState>()
const running = new Map<string, AbortController>()
const listeners = new Set<() => void>()
const settledListeners = new Set<(info: { hash: Hex; chainId: number; success: boolean; state: TrackState }) => void>()
const wakers = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())
const setState = (key: string, state: TrackState) => {
  states = new Map(states).set(key, state)
  emit()
}

/* ---- wake-ups: tab visible, window focused, network back ---- */
let wakeInstalled = false
export const poker: Poker = {
  subscribe(wake) {
    wakers.add(wake)
    return () => {
      wakers.delete(wake)
    }
  },
}
export function wakeTrackers() {
  ;[...wakers].forEach((w) => w())
}
function installWakeListeners() {
  if (wakeInstalled || typeof document === 'undefined') return
  wakeInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wakeTrackers()
  })
  window.addEventListener('focus', wakeTrackers)
  window.addEventListener('online', wakeTrackers)
}

/* ---- timing of the wallet round trip, shown next to the final status ---- */
export interface TxTiming {
  /** Gas estimate + safety checks before the wallet was opened */
  prepareMs: number
  /** From opening the wallet prompt to the wallet returning a hash (includes your own reading and clicking time) */
  walletMs: number
  /** Every stage from the click to confirmation (see txTimeline) */
  timeline?: Timeline
}
const timings = new Map<string, TxTiming>()
export const recordTiming = (hash: Hex, chainId: number, t: TxTiming) => void timings.set(keyOf(hash, chainId), t)
export const getTiming = (hash: Hex, chainId: number) => timings.get(keyOf(hash, chainId))

/* ---- tracking ---- */
export function watchTransaction(hash: Hex, chainId: number, createdAtSeconds?: number): void {
  const key = keyOf(hash, chainId)
  const known = states.get(key)
  if (running.has(key) || known?.phase === 'confirmed' || known?.phase === 'reverted') return
  const client = getPublicClient(config, { chainId: asChainId(chainId) })
  if (!client) return
  installWakeListeners()
  const controller = new AbortController()
  running.set(key, controller)
  setState(key, known ?? PENDING)
  const real = client as unknown as ReceiptClient
  const tl = timings.get(key)?.timeline
  let lookupStarted = false
  let lookupAnswered = false
  const timed: ReceiptClient = {
    getTransaction: (a) => real.getTransaction(a),
    getTransactionCount: (a) => real.getTransactionCount(a),
    getTransactionReceipt: async (a) => {
      if (!lookupStarted) {
        lookupStarted = true
        mark(tl, 'First receipt lookup sent')
      }
      try {
        return await real.getTransactionReceipt(a)
      } finally {
        if (!lookupAnswered) {
          lookupAnswered = true
          mark(tl, 'First receipt lookup answered')
        }
      }
    },
  }
  trackTransaction(timed, hash, {
    signal: controller.signal,
    poke: poker,
    onUpdate: (s) => {
      setState(key, s)
      if (s.phase === 'unknown' && createdAtSeconds !== undefined && Date.now() / 1000 - createdAtSeconds > DROPPED_AFTER_SECONDS) {
        updateActivity(hash, chainId, 'dropped')
        controller.abort()
      }
    },
  })
    .then((final) => {
      running.delete(key)
      const success = final.phase === 'confirmed'
      updateActivity(hash, chainId, success ? 'success' : 'failed')
      setState(key, final)
      const t = timings.get(key)
      mark(tl, success ? 'Confirmed (receipt status success)' : 'Reverted (receipt status reverted)')
      if (tl) console.info(`[FLUXORA timeline] ${hash.slice(0, 10)}…\n${formatTimeline(tl)}`)
      console.info(
        `[FLUXORA timing] ${hash.slice(0, 10)}… ${success ? 'confirmed' : 'reverted'} ${(final.elapsedMs / 1000).toFixed(1)}s after submission` +
          (t ? ` | prepare ${t.prepareMs} ms | wallet ${(t.walletMs / 1000).toFixed(1)} s` : ''),
      )
      settledListeners.forEach((l) => l({ hash, chainId, success, state: final }))
    })
    .catch(() => {
      running.delete(key)
    })
}

export const getTxState = (hash: Hex, chainId: number): TrackState => states.get(keyOf(hash, chainId)) ?? PENDING
export const subscribeTx = (cb: () => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const onTxSettled = (cb: (info: { hash: Hex; chainId: number; success: boolean; state: TrackState }) => void) => {
  settledListeners.add(cb)
  return () => {
    settledListeners.delete(cb)
  }
}
/** Re-reads the chain right now (no resend). Restarts the tracker if it had stopped. */
export function checkNow(hash: Hex, chainId: number) {
  wakeTrackers()
  watchTransaction(hash, chainId)
}
