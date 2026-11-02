import { useState } from 'react'
import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import type { Hex } from 'viem'
import { useTxTracker } from '@/hooks/useTxTracker'
import { useNow } from '@/hooks/useNow'
import type { TrackPhase, TrackState } from '@/lib/txTracker'
import { getTiming } from '@/lib/txRegistry'
import { formatTimeline } from '@/lib/txTimeline'
import { explorerTx } from '@/config/networks'
import { ExplorerLink, Notice, Spinner } from './ui'

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`
const seconds = (ms: number) => `${Math.floor(ms / 1000)}s`

/** Idle -> Wallet confirmation -> Submitted -> Pending -> Confirmed / Failed. Wallet and Submitted are already done once a hash exists. */
function TxSteps({ phase }: { phase: TrackPhase }) {
  const done = phase === 'confirmed' || phase === 'reverted'
  const steps = [
    { label: 'Wallet confirmed', state: 'done' },
    { label: 'Submitted', state: 'done' },
    { label: 'Pending', state: done ? 'done' : 'active' },
    { label: phase === 'reverted' ? 'Failed' : 'Confirmed', state: phase === 'confirmed' ? 'done' : phase === 'reverted' ? 'failed' : 'todo' },
  ] as const
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold" aria-label="Transaction progress">
      {steps.map((st, i) => (
        <li key={st.label} className="flex items-center gap-1.5">
          <span
            className={clsx(
              'flex h-4 w-4 items-center justify-center rounded-full',
              st.state === 'done' && 'bg-flux-green text-navy-950',
              st.state === 'active' && 'animate-pulse bg-amber-300 text-navy-950',
              st.state === 'failed' && 'bg-flux-pink text-white',
              st.state === 'todo' && 'bg-white/10 text-slate-500',
            )}
          >
            {st.state === 'done' && <Check size={10} strokeWidth={3} />}
            {st.state === 'failed' && <X size={10} strokeWidth={3} />}
          </span>
          <span className={clsx(st.state === 'todo' ? 'text-slate-500' : 'text-slate-200')}>{st.label}</span>
          {i < steps.length - 1 && <span className="text-slate-600">›</span>}
        </li>
      ))}
    </ol>
  )
}

/**
 * Real transaction tracking. The status is read from the chain receipt, never from a timer:
 * submitted (pending) -> confirmed or reverted. A slow transaction is explained, never resent.
 */
export function TxStatus({
  hash,
  chainId,
  title,
  onSettled,
}: {
  hash: Hex
  chainId: number
  title: string
  onSettled?: (success: boolean) => void
}) {
  const { state, checkAgain } = useTxTracker(hash, chainId, onSettled)
  return (
    <div className="space-y-2.5">
      <TxSteps phase={state.phase} />
      <TxNotice hash={hash} chainId={chainId} title={title} state={state} checkAgain={checkAgain} />
    </div>
  )
}

function TxNotice({ hash, chainId, title, state, checkAgain }: { hash: Hex; chainId: number; title: string; state: TrackState; checkAgain: () => void }) {
  const [startedAt] = useState(() => Math.floor(Date.now() / 1000))
  const waited = Math.max(0, useNow(1_000) - startedAt)
  const link = <ExplorerLink href={explorerTx(chainId, hash)} />
  const hashLine = <span className="mt-1 block break-all font-mono text-xs opacity-80">Hash {short(hash)}</span>
  const retry = (
    <button className="underline underline-offset-2" onClick={checkAgain}>
      Check again
    </button>
  )
  const lower = title.toLowerCase()

  switch (state.phase) {
    case 'confirmed': {
      const t = getTiming(hash, chainId)
      return (
        <Notice tone="success" action={link}>
          {title} confirmed in block {state.receipt?.blockNumber.toString()}.
          <span className="mt-1 block text-xs opacity-80">
            {t ? `Checks ${(t.prepareMs / 1000).toFixed(1)}s · wallet ${(t.walletMs / 1000).toFixed(1)}s · ` : ''}confirmed {(state.elapsedMs / 1000).toFixed(1)}s after submission
          </span>
          {t?.timeline && (
            <details className="mt-1 text-xs opacity-90">
              <summary className="cursor-pointer">Timing details</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-5">{formatTimeline(t.timeline)}</pre>
            </details>
          )}
          {hashLine}
        </Notice>
      )
    }
    case 'reverted':
      return (
        <Notice tone="error" action={link}>
          {title} was reverted onchain. Nothing changed except the network fee.{hashLine}
        </Notice>
      )
    case 'rpc-issue':
      return (
        <Notice tone="warn" action={link}>
          <span className="flex items-center gap-2"><Spinner /> Cannot reach the Arc RPC right now.</span>
          <span className="mt-1 block text-xs opacity-90">
            Your {lower} was submitted and may already be confirmed. We keep checking. Do not send it again; verify it on the explorer. {retry}
          </span>
          {hashLine}
        </Notice>
      )
    case 'unknown':
      return (
        <Notice tone="warn" action={link}>
          The RPC has no record of this {lower} after {seconds(state.elapsedMs)}. It may have been dropped, or the RPC is behind.
          <span className="mt-1 block text-xs opacity-90">Check the explorer before trying again, so the same payment is never made twice. {retry}</span>
          {hashLine}
        </Notice>
      )
    case 'queued':
    case 'slow':
      return (
        <Notice tone="warn" action={link}>
          <span className="flex items-center gap-2"><Spinner /> {title} still pending after {seconds(state.elapsedMs)}.</span>
          <span className="mt-1 block text-xs opacity-90">
            It was already broadcast, so do not send it again. {state.detail ?? 'It can still confirm.'} {retry}
          </span>
          {hashLine}
        </Notice>
      )
    default:
      return (
        <Notice tone="info" action={link}>
          <span className="flex items-center gap-2"><Spinner /> {title} submitted. Waiting for onchain confirmation… ({waited}s)</span>
          {hashLine}
        </Notice>
      )
  }
}
