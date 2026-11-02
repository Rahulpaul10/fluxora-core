import { useSyncExternalStore } from 'react'
import type { Hex, PublicClient } from 'viem'
import { useSendTransaction, useSignTypedData, useWriteContract } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { config } from '@/config/wallet'
import { ARC_CHAIN_ID, asChainId } from '@/config/networks'
import { TxError } from '@/lib/errors'
import { getFees } from '@/lib/fees'
import { recordTiming } from '@/lib/txRegistry'
import { mark, newTimeline, type Timeline } from '@/lib/txTimeline'
import { assertWalletReady } from '@/lib/txLifecycle'

/**
 * Wallet actions with safeguards that every FLUXORA transaction goes through:
 *  1. Pre-flight: the wallet is connected, its LIVE chain matches the target chain, and the RPC serves that chain.
 *  2. Prepared transaction: gas is estimated here (this is also the revert check: a call that would fail never reaches
 *     the wallet) and fees are attached, in ONE round trip. MetaMask is handed a complete transaction, so it does not
 *     have to estimate gas itself through its own RPC before it can show the confirmation screen.
 *  3. Single flight: only one wallet prompt can be open at a time, so a double click can never submit twice.
 * Nothing here retries: a failure before a hash exists is reported once and the user decides what to do.
 */
let inFlight = false

/** What the wallet flow is doing right now: idle -> preparing (pre-flight + gas estimate) -> wallet (prompt is open). */
export type PromptStage = 'idle' | 'preparing' | 'wallet'
interface PromptSnapshot { stage: PromptStage; since: number; popupSeen: boolean }
let snapshot: PromptSnapshot = { stage: 'idle', since: 0, popupSeen: false }
const listeners = new Set<() => void>()
const setStage = (stage: PromptStage) => {
  snapshot = { stage, since: Math.floor(Date.now() / 1000), popupSeen: false }
  listeners.forEach((l) => l())
}
/** The page lost focus while the prompt was open: the wallet window did appear. */
const popupSeen = () => {
  if (snapshot.stage !== 'wallet' || snapshot.popupSeen) return
  snapshot = { ...snapshot, popupSeen: true }
  listeners.forEach((l) => l())
}
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const useWalletPrompt = (): PromptSnapshot => useSyncExternalStore(subscribe, () => snapshot, () => snapshot)

const GAS_BUFFER_NUM = 125n
const GAS_BUFFER_DEN = 100n

interface Timed<T> { value: T; prepareMs: number; walletMs: number; timeline: Timeline }

async function guarded<P, T>(
  chainId: number | undefined,
  prepare: (address: Hex, tl: Timeline) => Promise<P>,
  run: (prepared: P) => Promise<T>,
): Promise<Timed<T>> {
  if (inFlight) throw new TxError('busy', 'A wallet request is already open. Finish or reject it in your wallet first.')
  inFlight = true
  setStage('preparing')
  const tl = newTimeline()
  const t0 = performance.now()
  // While the wallet prompt is open the page normally loses focus (the wallet opens its own window) and gets it back
  // when that window closes. These two marks show when the popup appeared and when it was dismissed.
  const onBlur = () => {
    mark(tl, 'Page lost focus (wallet window opened)')
    popupSeen()
  }
  const onFocus = () => {
    if (tl.marks.some((m) => m.name.startsWith('Page lost focus'))) mark(tl, 'Page regained focus (wallet window closed)')
  }
  try {
    const { address } = await assertWalletReady({ chainId })
    mark(tl, 'Pre-flight done (wallet connected, chain and RPC verified)')
    const prepared = await prepare(address, tl)
    const t1 = performance.now()
    setStage('wallet')
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    mark(tl, 'Wallet request issued')
    const value = await run(prepared)
    mark(tl, 'Wallet returned the transaction hash')
    return { value, prepareMs: Math.round(t1 - t0), walletMs: Math.round(performance.now() - t1), timeline: tl }
  } finally {
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
    inFlight = false
    setStage('idle')
  }
}

/** The two estimate calls we use, typed loosely because wagmi's client type is a large union */
interface GasClient {
  estimateContractGas(args: unknown): Promise<bigint>
  estimateGas(args: unknown): Promise<bigint>
}

type Loose = Record<string, unknown> & { chainId?: number; gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint; account?: unknown }

/** Adds gas (estimated, +25%) and fees when the caller did not set them. Gas and fees are fetched in parallel. */
async function withGasAndFees(args: Loose, address: Hex, tl: Timeline, estimate: (client: GasClient, account: Hex) => Promise<bigint>): Promise<Loose> {
  const chainId = args.chainId ?? ARC_CHAIN_ID
  const client = getPublicClient(config, { chainId: asChainId(chainId) }) as unknown as (GasClient & PublicClient) | undefined
  if (!client) return args
  const needGas = args.gas === undefined
  const needFees = args.maxFeePerGas === undefined && args.gasPrice === undefined
  mark(tl, 'Gas and fee estimation started')
  const [gas, fees] = await Promise.all([
    needGas ? estimate(client, address).then((g) => (mark(tl, 'Gas estimate answered by the app RPC'), g)) : Promise.resolve(args.gas as bigint),
    needFees ? getFees(client, chainId).then((f) => (mark(tl, 'Fee quote answered'), f)) : Promise.resolve(undefined),
  ])
  mark(tl, 'Gas and fee estimation done')
  return {
    ...args,
    gas: needGas ? (gas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN : gas,
    ...(fees ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : {}),
  }
}

const noteTiming = (hash: unknown, chainId: number | undefined, t: { prepareMs: number; walletMs: number; timeline: Timeline }) => {
  if (typeof hash === 'string' && hash.startsWith('0x')) recordTiming(hash as Hex, chainId ?? ARC_CHAIN_ID, t)
}

export function useGuardedWrite() {
  const w = useWriteContract()
  const writeContractAsync = (async (args: Loose) => {
    const { value, prepareMs, walletMs, timeline } = await guarded(
      args.chainId,
      (address, tl) =>
        withGasAndFees(args, address, tl, (client, account) =>
          client.estimateContractGas({ ...(args as object), account }),
        ),
      (prepared) => w.writeContractAsync(prepared as never),
    )
    noteTiming(value, args.chainId, { prepareMs, walletMs, timeline })
    return value
  }) as unknown as typeof w.writeContractAsync
  return { ...w, writeContractAsync }
}

export function useGuardedSend() {
  const s = useSendTransaction()
  const sendTransactionAsync = (async (args: Loose) => {
    const { value, prepareMs, walletMs, timeline } = await guarded(
      args.chainId,
      (address, tl) =>
        withGasAndFees(args, address, tl, (client, account) =>
          client.estimateGas({ ...(args as object), account }),
        ),
      (prepared) => s.sendTransactionAsync(prepared as never),
    )
    noteTiming(value, args.chainId, { prepareMs, walletMs, timeline })
    return value
  }) as unknown as typeof s.sendTransactionAsync
  return { ...s, sendTransactionAsync }
}

export function useGuardedSign() {
  const s = useSignTypedData()
  const signTypedDataAsync = ((args: Parameters<typeof s.signTypedDataAsync>[0]) =>
    guarded(undefined, () => Promise.resolve(args), (a) => s.signTypedDataAsync(a)).then((r) => r.value)) as typeof s.signTypedDataAsync
  return { ...s, signTypedDataAsync }
}
