import { memo, useCallback, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { MoreHorizontal, X } from 'lucide-react'
import type { View } from '@/lib/router'
import { ViewContext, VIEW_THEMES } from '@/lib/theme'
import { Header } from './Header'
import { Wordmark } from './Logo'
import { ConnectionStatus } from './ConnectionStatus'
import { prefetchView } from '@/lib/viewLoaders'

const DESKTOP: View[] = ['dashboard', 'send', 'receive', 'swap', 'bridge', 'pay', 'history']
const MOBILE_MAIN: View[] = ['dashboard', 'send', 'swap', 'bridge']
const MOBILE_MORE: View[] = ['receive', 'pay', 'history']

const Backdrop = memo(function Backdrop() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="orb o1" />
      <div className="orb o2" />
      <div className="orb o3" />
      <div className="orb o4" />
      <div className="grid" />
    </div>
  )
})

const NavButton = memo(function NavButton({ view, active, onClick, compact }: { view: View; active: boolean; onClick: (v: View) => void; compact?: boolean }) {
  const t = VIEW_THEMES[view]
  const Icon = t.icon
  return (
    <button
      onClick={() => onClick(view)}
      // Start loading the page as soon as the user shows intent, so the click lands on a page that is ready.
      onPointerEnter={() => prefetchView(view)}
      onFocus={() => prefetchView(view)}
      onTouchStart={() => prefetchView(view)}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative flex items-center transition',
        compact ? 'min-h-[56px] flex-1 flex-col justify-center gap-1 rounded-2xl px-1 text-[11px] font-semibold' : 'min-h-[48px] w-full gap-3 rounded-2xl px-3 text-sm font-semibold',
        active ? 'text-white' : 'text-slate-400 hover:text-white',
      )}
    >
      {active && <motion.span layoutId={compact ? 'nav-m' : 'nav-d'} className="absolute inset-0 rounded-2xl border border-white/10 bg-white/[0.07]" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
      <span
        className={clsx('relative flex shrink-0 items-center justify-center rounded-xl transition', compact ? 'h-8 w-8' : 'h-9 w-9', active ? 'text-white shadow-glow' : 'bg-white/5 group-hover:bg-white/10')}
        style={active ? { background: t.gradient } : undefined}
      >
        <Icon size={compact ? 17 : 18} />
      </span>
      <span className="relative">{t.label}</span>
    </button>
  )
})

export function Shell({ view, navigate, children }: { view: View; navigate: (v: View) => void; children: ReactNode }) {
  const [more, setMore] = useState(false)
  const go = useCallback(
    (v: View) => {
      setMore(false)
      navigate(v)
    },
    [navigate],
  )

  return (
    <ViewContext.Provider value={view}>
      <div data-theme={view} className="relative min-h-dvh">
        <Backdrop />
        <div className="relative z-10 lg:flex">
          {/* Desktop sidebar */}
          <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col justify-between border-r border-white/5 bg-navy-900/50 p-5 backdrop-blur-xl lg:flex">
            <div>
              <button onClick={() => go('dashboard')} className="mb-8 mt-1 px-1" aria-label="FLUXORA home">
                <Wordmark size={38} />
              </button>
              <nav className="flex flex-col gap-1" aria-label="Main">
                {DESKTOP.map((v) => (
                  <NavButton key={v} view={v} active={v === view} onClick={go} />
                ))}
              </nav>
            </div>
            <div className="space-y-3">
              <ConnectionStatus variant="card" />
              <p className="px-1 text-xs leading-relaxed text-slate-500">
                <span className="gradient-text font-semibold">One Wallet. Every Possibility.</span>
                <br />
                Arc mainnet moves real funds.
              </p>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            <Header />
            <main className="mx-auto w-full max-w-6xl px-4 pb-36 pt-6 lg:px-8 lg:pb-16 lg:pt-8">
              {children}
            </main>
          </div>
        </div>

        {/* Mobile navigation */}
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 px-3 lg:hidden" aria-label="Main">
          <div className="glass mx-auto flex max-w-md items-stretch gap-1 rounded-[26px] p-1.5">
            {MOBILE_MAIN.map((v) => (
              <NavButton key={v} view={v} compact active={v === view} onClick={go} />
            ))}
            <button
              onClick={() => setMore(true)}
              className={clsx('flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-semibold', MOBILE_MORE.includes(view) ? 'text-white' : 'text-slate-400')}
              aria-haspopup="dialog"
            >
              <span className={clsx('flex h-8 w-8 items-center justify-center rounded-xl', MOBILE_MORE.includes(view) ? 'theme-chip' : 'bg-white/5')}>
                <MoreHorizontal size={17} />
              </span>
              More
            </button>
          </div>
        </nav>

        <AnimatePresence>
          {more && (
            <motion.div className="fixed inset-0 z-50 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <button className="absolute inset-0 bg-navy-950/70 backdrop-blur-sm" onClick={() => setMore(false)} aria-label="Close menu" />
              <motion.div
                role="dialog"
                aria-label="More pages"
                className="glass safe-bottom absolute inset-x-3 bottom-3 rounded-[28px] p-4"
                initial={{ y: 60, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 60, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              >
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-display text-lg font-bold">More</p>
                  <button onClick={() => setMore(false)} className="rounded-xl p-2 text-slate-400 hover:text-white" aria-label="Close">
                    <X size={20} />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  {MOBILE_MORE.map((v) => {
                    const t = VIEW_THEMES[v]
                    const Icon = t.icon
                    return (
                      <button key={v} onClick={() => go(v)} className="glass-inner flex min-h-[64px] items-center gap-3 rounded-2xl p-3 text-left">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: t.gradient }}>
                          <Icon size={18} />
                        </span>
                        <span className="text-sm font-semibold">{t.label}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-3">
                  <ConnectionStatus variant="card" />
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ViewContext.Provider>
  )
}
