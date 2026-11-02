import clsx from 'clsx'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpRight, Landmark, Receipt, Check } from 'lucide-react'
import type { HistoryKind } from '@/hooks/useHistoryRows'

const META: Record<HistoryKind, { label: string; icon: typeof ArrowUpRight; tone: string }> = {
  send: { label: 'Send', icon: ArrowUpRight, tone: 'bg-flux-pink/15 text-flux-pink' },
  receive: { label: 'Receive', icon: ArrowDownToLine, tone: 'bg-flux-green/15 text-flux-green' },
  swap: { label: 'Swap', icon: ArrowLeftRight, tone: 'bg-cyan-400/15 text-[var(--a)]' },
  bridge: { label: 'Bridge', icon: Landmark, tone: 'bg-volt/20 text-volt' },
  payment: { label: 'Payment', icon: Receipt, tone: 'bg-amber-400/15 text-amber-300' },
  request: { label: 'Request', icon: Receipt, tone: 'bg-amber-400/15 text-amber-300' },
  approve: { label: 'Approve', icon: Check, tone: 'bg-white/10 text-slate-300' },
  transfer: { label: 'Transfer', icon: ArrowLeftRight, tone: 'bg-white/10 text-slate-300' },
}

export const kindLabel = (kind: HistoryKind) => META[kind].label

export function HistoryKindBadge({ kind }: { kind: HistoryKind }) {
  const { icon: Icon, tone, label } = META[kind]
  return (
    <span className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', tone)} title={label} aria-label={label}>
      <Icon size={18} />
    </span>
  )
}
