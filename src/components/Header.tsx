import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi'
import { AlertTriangle, Check, ChevronDown, Copy, ExternalLink, LogOut, Plug } from 'lucide-react'
import { toast } from 'sonner'
import { NETWORKS, networkById, ARC_CHAIN_ID, asChainId, explorerAddress, isSupportedChain } from '@/config/networks'
import { shortAddr } from '@/lib/format'
import { ConnectionStatus } from './ConnectionStatus'
import { Wordmark } from './Logo'

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

function Menu({ trigger, children, open, setOpen, align = 'right' }: { trigger: ReactNode; children: ReactNode; open: boolean; setOpen: (v: boolean) => void; align?: 'left' | 'right' }) {
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="glass flex min-h-[44px] items-center gap-2 rounded-2xl px-3 text-sm font-semibold text-white transition hover:border-white/25"
      >
        {trigger}
        <ChevronDown size={15} className={clsx('text-slate-400 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          className={clsx('glass absolute top-[calc(100%+8px)] z-50 w-64 animate-rise rounded-2xl p-2 shadow-card', align === 'right' ? 'right-0' : 'left-0')}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function NetworkSelector() {
  const { chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [open, setOpen] = useState(false)
  const current = networkById(chainId)
  const unsupported = isConnected && !isSupportedChain(chainId)
  const shown = current ?? networkById(ARC_CHAIN_ID)

  return (
    <Menu
      open={open}
      setOpen={setOpen}
      trigger={
        unsupported ? (
          <span className="flex items-center gap-2 text-amber-200">
            <AlertTriangle size={16} /> <span className="hidden sm:inline">Wrong network</span>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: shown?.color, boxShadow: `0 0 12px ${shown?.color}` }} />
            <span className="hidden sm:inline">{shown?.name}</span>
            <span className="sm:hidden">{shown?.short}</span>
          </span>
        )
      }
    >
      <p className="label px-3 pb-1 pt-2">Network</p>
      {NETWORKS.map((n) => (
        <button
          key={n.id}
          role="menuitem"
          disabled={!isConnected}
          onClick={() => {
            switchChainAsync({ chainId: asChainId(n.id) })
              .then(() => setOpen(false))
              .catch(() => toast.error(`Could not switch to ${n.name}.`))
          }}
          className="flex min-h-[46px] w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-sm transition hover:bg-white/10 disabled:cursor-default disabled:opacity-70"
        >
          <span className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: n.color }} />
            <span>
              <span className="block font-semibold text-white">{n.name}</span>
              <span className="block text-[11px] text-slate-400">{n.isHome ? 'Home network · all features' : 'Bridge only'}</span>
            </span>
          </span>
          {chainId === n.id && <Check size={16} className="text-flux-green" />}
        </button>
      ))}
      {!isConnected && <p className="px-3 pb-2 pt-1 text-[11px] text-slate-500">Connect a wallet to switch networks.</p>}
    </Menu>
  )
}

function avatarGradient(address: string): string {
  const n = parseInt(address.slice(2, 8), 16)
  const hues = [265, 190, 330, 160]
  return `linear-gradient(135deg, hsl(${hues[n % 4]} 90% 62%), hsl(${hues[(n >> 3) % 4]} 90% 55%))`
}

function WalletMenu() {
  const { address, chainId, connector } = useAccount()
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)

  return (
    <ConnectKitButton.Custom>
      {({ isConnected, isConnecting, show }) => {
        if (!isConnected || !address) {
          return (
            <button onClick={show} aria-label="Connect wallet" className="btn-primary !min-h-[44px] !rounded-2xl !px-3.5 text-sm sm:!px-4">
              <Plug size={16} />
              {isConnecting ? 'Connecting…' : <>Connect<span className="max-[419px]:hidden">&nbsp;wallet</span></>}
            </button>
          )
        }
        return (
          <Menu
            open={open}
            setOpen={setOpen}
            trigger={
              <span className="flex items-center gap-2">
                <span className="h-6 w-6 rounded-full" style={{ background: avatarGradient(address) }} />
                <span className="font-mono text-[13px] max-[419px]:hidden">{shortAddr(address, 6, 4)}</span>
                <span className="font-mono text-[13px] min-[420px]:hidden">{shortAddr(address, 4, 3)}</span>
              </span>
            }
          >
            <div className="px-3 pb-2 pt-2">
              <p className="label">Connected with</p>
              <p className="mt-0.5 text-sm font-semibold text-white">{connector?.name ?? 'Wallet'}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{address}</p>
            </div>
            <button
              role="menuitem"
              className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-sm hover:bg-white/10"
              onClick={() => {
                navigator.clipboard
                  .writeText(address)
                  .then(() => toast.success('Address copied'))
                  .catch(() => toast.error('Copy failed'))
              }}
            >
              <Copy size={15} /> Copy address
            </button>
            <a
              role="menuitem"
              href={explorerAddress(chainId && isSupportedChain(chainId) ? chainId : ARC_CHAIN_ID, address)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-sm hover:bg-white/10"
            >
              <ExternalLink size={15} /> View on explorer
            </a>
            <button
              role="menuitem"
              className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-sm text-flux-pink hover:bg-flux-pink/10"
              onClick={() => {
                disconnect()
                setOpen(false)
              }}
            >
              <LogOut size={15} /> Disconnect
            </button>
          </Menu>
        )
      }}
    </ConnectKitButton.Custom>
  )
}

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-navy-900/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 lg:px-8">
        <span className="shrink-0 lg:invisible" aria-label="FLUXORA">
          {/* Narrow phones show the symbol only, so the wallet button always fits */}
          <Wordmark size={32} textClassName="max-[459px]:hidden" />
        </span>
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <ConnectionStatus />
          <NetworkSelector />
          <WalletMenu />
        </div>
      </div>
    </header>
  )
}
