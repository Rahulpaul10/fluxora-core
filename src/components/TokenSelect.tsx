import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Search, X } from 'lucide-react'
import { isAddress } from 'viem'
import type { TokenInfo } from '@/lib/tokens'
import type { BalanceRow } from '@/hooks/useBalances'
import { fmtToken, shortAddr } from '@/lib/format'
import { TokenIcon } from './ui'

export function TokenButton({ token, onClick, disabled }: { token: TokenInfo | undefined; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="lift inline-flex min-h-[46px] shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.07] px-3 font-semibold text-white disabled:opacity-50"
    >
      {token ? (
        <>
          <TokenIcon token={token} size={24} />
          {token.symbol}
        </>
      ) : (
        'Select token'
      )}
      <ChevronDown size={16} className="text-slate-400" />
    </button>
  )
}

/** Searchable token picker (by symbol, name or address). Only tokens FLUXORA supports on Arc are listed. */
export function TokenPicker({
  open,
  onClose,
  rows,
  onSelect,
  exclude,
}: {
  open: boolean
  onClose: () => void
  rows: BalanceRow[]
  onSelect: (t: TokenInfo) => void
  exclude?: string
}) {
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter(
      (r) =>
        r.token.symbol !== exclude &&
        (!needle ||
          r.token.symbol.toLowerCase().includes(needle) ||
          r.token.name.toLowerCase().includes(needle) ||
          r.token.address.toLowerCase().includes(needle)),
    )
  }, [rows, q, exclude])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="glass max-h-[86dvh] w-full max-w-md overflow-hidden rounded-t-[28px] sm:rounded-[28px]"
            initial={{ y: 40 }}
            animate={{ y: 0 }}
            exit={{ y: 40 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Select token"
          >
            <div className="flex items-center justify-between p-4 pb-2">
              <h2 className="font-display text-lg font-semibold">Select token</h2>
              <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:text-white" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="relative px-4 pb-3">
              <Search size={16} className="pointer-events-none absolute left-7 top-3.5 text-slate-500" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, symbol or address"
                className="field pl-10"
              />
            </div>
            <ul className="grid max-h-[56dvh] gap-2 overflow-y-auto px-4 pb-5 sm:max-h-[50dvh]">
              {list.map((r) => (
                <li key={r.token.address}>
                  <button
                    onClick={() => {
                      onSelect(r.token)
                      onClose()
                      setQ('')
                    }}
                    className="lift flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-white/10 px-3.5 text-left"
                    style={{ background: `linear-gradient(120deg, ${r.token.color}30, transparent 65%), rgba(9,13,28,.55)` }}
                  >
                    <TokenIcon token={r.token} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-white">{r.token.symbol}</span>
                      <span className="block truncate text-xs text-slate-400">{r.token.name}</span>
                    </span>
                    <span className="text-right text-sm text-slate-300 tabular">
                      {r.raw === undefined ? '—' : fmtToken(r.raw, r.token.decimals, 4)}
                    </span>
                  </button>
                </li>
              ))}
              {list.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-slate-400">
                  {isAddress(q.trim())
                    ? `${shortAddr(q.trim())} is not a supported token on Arc.`
                    : 'No supported token matches your search.'}
                </li>
              )}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
