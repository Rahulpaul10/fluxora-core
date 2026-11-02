/** Pure receipt tracking (no wallet or wagmi imports) so it can be tested outside the browser. */
import type { Address, Hex, TransactionReceipt } from 'viem'

/* ------------------------------------------------------------------ */
/* Receipt tracking                                                    */
/* ------------------------------------------------------------------ */

/** The slice of a viem public client the tracker needs. Kept small so it can be tested with a fake. */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>
  getTransaction(args: { hash: Hex }): Promise<{ nonce: number; from: Address }>
  getTransactionCount(args: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>
}

/**
 * pending    broadcast, waiting for inclusion
 * slow       still not included after SLOW_AFTER_MS (it may still land: do NOT resend)
 * queued     waiting behind an earlier transaction from the same wallet (lower nonce)
 * rpc-issue  the RPC is failing to answer; we keep trying and the transaction may already be mined
 * unknown    the RPC has never heard of this hash after UNKNOWN_AFTER_MS (dropped, or the RPC is lagging)
 * confirmed  receipt found with status success
 * reverted   receipt found with status reverted
 */
export type TrackPhase = 'pending' | 'slow' | 'queued' | 'rpc-issue' | 'unknown' | 'confirmed' | 'reverted'

export interface TrackState {
  phase: TrackPhase
  receipt?: TransactionReceipt
  elapsedMs: number
  attempts: number
  /** Human sentence describing why the transaction is waiting, when we know */
  detail?: string
}

export const SLOW_AFTER_MS = 45_000
export const UNKNOWN_AFTER_MS = 5 * 60_000

/**
 * Receipt polling cadence. Arc produces a block every ~0.5s and a receipt is normally visible within a second,
 * so the first minutes poll quickly (0.5s, 0.75s, 1.1s, 1.7s, 2.5s, then every 3s). A transaction that is still
 * pending after ~2 minutes backs off slowly towards 10s to spare the RPC.
 */
export const backoffDelay = (attempt: number) =>
  attempt < 40 ? Math.min(Math.round(500 * 1.5 ** attempt), 3_000) : Math.min(3_000 + (attempt - 40) * 500, 10_000)

/** One receipt lookup may not stall the loop longer than this: a hung request is abandoned and the next poll goes out. */
export const POLL_TIMEOUT_MS = 4_000

/** Lets the app wake a sleeping poller early, e.g. when the tab becomes visible again. */
export interface Poker {
  subscribe(wake: () => void): () => void
}

const isNotFound = (e: unknown) => {
  const o = e as { name?: string; message?: string }
  return o?.name === 'TransactionReceiptNotFoundError' || o?.name === 'TransactionNotFoundError' || /could not be found/i.test(o?.message ?? '')
}

interface TrackOptions {
  onUpdate?: (s: TrackState) => void
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  poke?: Poker
  /** Overrides POLL_TIMEOUT_MS (tests) */
  pollTimeoutMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Resolves with the lookup, or rejects after ms so one hung request cannot freeze the poll loop. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Receipt lookup timed out'), { name: 'PollTimeout' })), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Polls for the receipt with exponential backoff until the transaction is mined (success or reverted).
 * It never gives up on its own and never reports success without a receipt whose status is "success".
 * It only READS from the chain: it can never cause a transaction to be re-sent.
 */
export async function trackTransaction(client: ReceiptClient, hash: Hex, opts: TrackOptions = {}): Promise<TrackState> {
  const now = opts.now ?? Date.now
  const baseSleep = opts.sleep ?? defaultSleep
  // Sleeps for ms, or less if the poker wakes us (tab visible again, window focused)
  const sleep = (ms: number) =>
    opts.poke
      ? new Promise<void>((resolve) => {
          let off: () => void = () => undefined
          const done = () => {
            off()
            resolve()
          }
          off = opts.poke ? opts.poke.subscribe(done) : off
          void baseSleep(ms).then(done)
        })
      : baseSleep(ms)
  const pollTimeout = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS
  const startedAt = now()
  let attempts = 0
  let rpcFailures = 0
  let known: boolean | undefined
  let detail: string | undefined
  let queued = false

  const emit = (phase: TrackPhase, receipt?: TransactionReceipt): TrackState => {
    const s: TrackState = { phase, receipt, elapsedMs: now() - startedAt, attempts, detail }
    opts.onUpdate?.(s)
    return s
  }

  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Tracking stopped', 'AbortError')
    try {
      const receipt = await withTimeout(client.getTransactionReceipt({ hash }), pollTimeout)
      rpcFailures = 0
      return emit(receipt.status === 'success' ? 'confirmed' : 'reverted', receipt)
    } catch (e) {
      if (isNotFound(e)) rpcFailures = 0
      else rpcFailures++
    }
    attempts++

    // Not mined yet: find out whether the node knows the transaction, and whether it is waiting in a nonce queue.
    if (rpcFailures === 0 && (attempts === 3 || attempts % 5 === 0)) {
      try {
        const tx = await client.getTransaction({ hash })
        known = true
        const latest = await client.getTransactionCount({ address: tx.from, blockTag: 'latest' })
        queued = tx.nonce > latest
        detail = queued
          ? `It is queued behind ${tx.nonce - latest} earlier transaction(s) from your wallet. Those must finish first.`
          : 'The network has it and it is waiting to be included.'
      } catch (e) {
        if (isNotFound(e)) {
          known = false
          detail = 'The RPC does not know this transaction (yet).'
        }
      }
    }

    const elapsed = now() - startedAt
    let phase: TrackPhase = 'pending'
    if (rpcFailures >= 2) {
      phase = 'rpc-issue'
      detail = 'The Arc RPC is not answering. Your transaction may already be confirmed. We keep checking.'
    } else if (elapsed >= UNKNOWN_AFTER_MS && known === false) phase = 'unknown'
    else if (queued) phase = 'queued'
    else if (elapsed >= SLOW_AFTER_MS) phase = 'slow'
    emit(phase)

    await sleep(backoffDelay(attempts))
  }
}


/**
 * Waits for a receipt using the same backoff poller as the status card (first check immediately, then 0.8s,
 * 1.2s, ...). Faster than viem's fixed 4 second polling. Throws if the transaction reverted.
 */
export async function waitForReceipt(client: unknown, hash: Hex, signal?: AbortSignal): Promise<TransactionReceipt> {
  const final = await trackTransaction(client as ReceiptClient, hash, { signal })
  if (!final.receipt) throw new Error('No receipt was returned for this transaction.')
  if (final.phase === 'reverted') throw new Error('The transaction was reverted onchain.')
  return final.receipt
}
