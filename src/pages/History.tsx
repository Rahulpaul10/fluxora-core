import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useAccount } from 'wagmi'
import { useHistoryRows, type HistoryKind } from '@/hooks/useHistoryRows'
import { fmtDate, shortHash } from '@/lib/format'
import { explorerTx, networkById } from '@/config/networks'
import { ArcGate } from '@/components/Gate'
import { HistoryKindBadge, kindLabel } from '@/components/HistoryKindBadge'
import { Card, CopyButton, ExplorerLink, Notice, PageTitle, Spinner } from '@/components/ui'
import clsx from 'clsx'

const FILTERS: { value: 'all' | HistoryKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'send', label: 'Send' },
  { value: 'receive', label: 'Receive' },
  { value: 'swap', label: 'Swap' },
  { value: 'bridge', label: 'Bridge' },
  { value: 'payment', label: 'Payments' },
]

export function History() {
  const { isConnected } = useAccount()
  return (
    <>
      <PageTitle title="History" subtitle="Real transfers read from Arc, labelled with what you did in FLUXORA." />
      {isConnected ? <HistoryList /> : <ArcGate feature="History"><span /></ArcGate>}
    </>
  )
}

function groupByDay<T extends { timestamp: number }>(items: T[]): [string, T[]][] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const day = new Date(item.timestamp * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    map.set(day, [...(map.get(day) ?? []), item])
  }
  return [...map.entries()]
}

function HistoryList() {
  const { rows, transfers } = useHistoryRows()
  const [filter, setFilter] = useState<'all' | HistoryKind>('all')
  const [q, setQ] = useState('')

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter !== 'all' && r.kind !== filter) return false
      if (!needle) return true
      return (
        r.summary.toLowerCase().includes(needle) ||
        (r.hash?.toLowerCase().includes(needle) ?? false) ||
        r.legs.some((l) => l.counterparty.toLowerCase().includes(needle)) ||
        (networkById(r.chainId)?.name.toLowerCase().includes(needle) ?? false)
      )
    })
  }, [rows, filter, q])

  const scanned = transfers.head !== undefined && transfers.oldestScanned !== undefined ? transfers.head - transfers.oldestScanned : undefined

  return (
    <div className="space-y-4">
      <Card className="space-y-3 !p-4">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-3.5 text-slate-500" />
          <input className="field pl-10" placeholder="Search hash, address, token or network" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search history" />
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={clsx('min-h-[40px] rounded-xl px-4 text-sm font-semibold transition', filter === f.value ? 'theme-chip shadow-glow' : 'bg-white/5 text-slate-300 hover:bg-white/10')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Card>

      {transfers.isError && (
        <Notice tone="warn" action={<button className="btn-ghost !min-h-[36px]" onClick={() => void transfers.refetch()}>Retry</button>}>
          Could not read onchain history right now. Transactions made in FLUXORA are still listed below.
        </Notice>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          ['Shown', shown.length, 'text-white'],
          ['Received', shown.filter((r) => r.kind === 'receive').length, 'text-flux-green'],
          ['Sent', shown.filter((r) => r.kind === 'send').length, 'text-flux-pink'],
        ].map(([label, n, tone]) => (
          <Card key={label as string} className="!p-4 text-center">
            <p className="label">{label}</p>
            <p className={clsx('mt-1 font-display text-2xl font-bold tabular', tone as string)}>{n}</p>
          </Card>
        ))}
      </div>

      {transfers.isLoading ? (
        <Card><p className="flex items-center gap-2 p-4 text-sm text-slate-400"><Spinner /> Reading recent Arc blocks…</p></Card>
      ) : shown.length === 0 ? (
        <Card><p className="p-6 text-center text-sm text-slate-400">No matching transactions in the blocks scanned so far.</p></Card>
      ) : (
        groupByDay(shown).map(([day, items]) => (
          <section key={day} className="space-y-2">
            <h2 className="label px-1">{day}</h2>
            <ul className="space-y-2">
              {items.map((r) => (
                <li key={r.key} className="lift glass flex flex-wrap items-center gap-3 rounded-2xl px-3.5 py-3 sm:flex-nowrap">
                  <HistoryKindBadge kind={r.kind} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{r.summary}</p>
                    <p className="text-xs text-slate-400">
                      {kindLabel(r.kind)} · {networkById(r.chainId)?.name ?? `Chain ${r.chainId}`} · {fmtDate(r.timestamp)}
                      {r.note ? ` · ${r.note}` : ''}
                    </p>
                    {r.hash && <p className="mt-0.5 font-mono text-xs text-slate-500">{shortHash(r.hash)}</p>}
                  </div>
                  <span
                    className={clsx(
                      'rounded-full px-2.5 py-1 text-xs font-semibold',
                      r.status === 'success' && 'bg-flux-green/15 text-flux-green',
                      r.status === 'pending' && 'bg-amber-400/15 text-amber-300',
                      r.status === 'failed' && 'bg-flux-pink/15 text-flux-pink',
                      r.status === 'dropped' && 'bg-slate-500/20 text-slate-300',
                    )}
                    title={r.status === 'dropped' ? 'The network never recorded this transaction. Check the explorer.' : undefined}
                  >
                    {r.status === 'success' ? 'Confirmed' : r.status === 'pending' ? 'Pending' : r.status === 'failed' ? 'Reverted' : 'Not found'}
                  </span>
                  <div className="flex items-center gap-2">
                    {r.hash && <CopyButton value={r.hash} label="Hash" className="!min-h-[44px] !px-3" />}
                    {r.hash && <ExplorerLink href={explorerTx(r.chainId, r.hash)}>Explorer</ExplorerLink>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <div className="flex flex-col items-center gap-2">
        <p className="text-xs text-slate-500">
          {scanned !== undefined ? `Scanned about ${Number(scanned).toLocaleString()} recent blocks (≈ ${(Number(scanned) * 0.5 / 3600).toFixed(1)} hours). ` : ''}
          Arc history is read directly from the network in small ranges.
        </p>
        {transfers.hasMore && (
          <button className="btn-ghost" disabled={transfers.loadingMore} onClick={() => void transfers.loadMore()}>
            {transfers.loadingMore ? <><Spinner /> Scanning older blocks…</> : 'Load older transactions'}
          </button>
        )}
      </div>
    </div>
  )
}
