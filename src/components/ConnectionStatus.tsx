import clsx from 'clsx'
import { RefreshCw } from 'lucide-react'
import { useRpcHealth, type RpcStatus } from '@/hooks/useRpcHealth'
import { ARC_CHAIN_ID, HOME_NETWORK } from '@/config/networks'

const TONE: Record<RpcStatus, { dot: string; label: string }> = {
  checking: { dot: 'bg-slate-400', label: 'Connecting' },
  online: { dot: 'bg-flux-green', label: 'Connected' },
  degraded: { dot: 'bg-amber-300', label: 'Slow connection' },
  offline: { dot: 'bg-flux-pink', label: 'RPC unreachable' },
  'wrong-chain': { dot: 'bg-flux-pink', label: 'Wrong chain' },
}

/** Compact RPC health indicator. variant="card" shows details, "dot" is the small header version. */
export function ConnectionStatus({ variant = 'dot' }: { variant?: 'dot' | 'card' }) {
  const h = useRpcHealth()
  const tone = TONE[h.status]

  if (variant === 'dot') {
    return (
      <span
        className="pill !px-2.5 max-[379px]:hidden"
        title={`${HOME_NETWORK.name} RPC (${h.host}): ${tone.label}${h.latency ? ` · ${h.latency} ms` : ''}`}
        role="status"
        aria-label={`${HOME_NETWORK.name} network ${tone.label}`}
      >
        <span className={clsx('relative h-2 w-2 rounded-full', tone.dot, h.status === 'online' && 'dot-live')} />
        <span className="hidden sm:inline">{tone.label}</span>
      </span>
    )
  }

  return (
    <div className="glass-inner rounded-2xl p-3.5" role="status">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-white">
          <span className={clsx('relative h-2.5 w-2.5 rounded-full', tone.dot, h.status === 'online' && 'dot-live')} />
          {HOME_NETWORK.name} · {tone.label}
        </span>
        <button onClick={h.retry} className="-m-2 flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:text-white" aria-label="Retry connection check" disabled={h.retrying}>
          <RefreshCw size={14} className={clsx(h.retrying && 'animate-spin')} />
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400 tabular">
        {h.block !== undefined ? `Block ${h.block.toLocaleString()}` : 'Waiting for the network…'}
        {h.latency !== undefined ? ` · ${h.latency} ms` : ''}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-slate-500">
        {h.custom ? 'Custom RPC' : 'RPC'}: {h.host}
      </p>
      {h.status === 'wrong-chain' && <p className="mt-2 text-xs text-flux-pink">The configured RPC serves chain {h.servedChain}, not Arc ({ARC_CHAIN_ID}). Check VITE_ARC_RPC_URL. Transactions are blocked.</p>}
      {h.status === 'offline' && <p className="mt-2 text-xs text-flux-pink">Balances and transactions need the RPC. Retrying automatically.</p>}
    </div>
  )
}
