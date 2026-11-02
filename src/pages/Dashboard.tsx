import { Suspense, lazy, useMemo } from 'react'
import { CheckCircle2, CircleSlash, ShieldCheck, Sparkles, Waves } from 'lucide-react'
import { useAccount } from 'wagmi'
import { useTokenBalances, useTokenPrices } from '@/hooks/useBalances'
import { useHistoryRows } from '@/hooks/useHistoryRows'
import { useArcWallet } from '@/hooks/useWallet'
import { fmtToken, fmtUsd, shortAddr, timeAgo } from '@/lib/format'
import { USDC } from '@/lib/tokens'
import { explorerAddress, explorerTx, ARC_CHAIN_ID } from '@/config/networks'
import { CONTRACT_DEFINITIONS } from '@/config/contracts'
import { VIEW_THEMES } from '@/lib/theme'
import { prefetchView } from '@/lib/viewLoaders'
import type { View } from '@/lib/router'
import { Card, CopyButton, ExplorerLink, Notice, Spinner, TokenIcon } from '@/components/ui'
import { ConnectPanel } from '@/components/Gate'
import { Wordmark } from '@/components/Logo'
import { ConnectionStatus } from '@/components/ConnectionStatus'
import { HistoryKindBadge } from '@/components/HistoryKindBadge'

const AllocationDonut = lazy(() => import('@/components/DashboardCharts').then((m) => ({ default: m.AllocationDonut })))
const FlowBars = lazy(() => import('@/components/DashboardCharts').then((m) => ({ default: m.FlowBars })))

/** Placeholder with the final size, so the layout does not jump when the chart arrives. */
const ChartSkeleton = ({ round }: { round?: boolean }) => <div className={`skeleton h-full w-full ${round ? '!rounded-full' : ''}`} aria-busy="true" />
const ACTIONS: View[] = ['send', 'receive', 'swap', 'bridge', 'pay']

const HERO_BG =
  'radial-gradient(circle at 12% 8%, rgba(130,87,255,.55), transparent 46%), radial-gradient(circle at 92% 14%, rgba(39,217,255,.38), transparent 46%), radial-gradient(circle at 58% 125%, rgba(255,85,184,.42), transparent 52%), #141A2E'

function Landing() {
  return (
    <div className="space-y-6">
      <div className="glass relative overflow-hidden rounded-[32px] p-6 sm:p-10" style={{ background: HERO_BG }}>
        <div className="relative grid items-center gap-8 sm:grid-cols-2">
          <div className="lg:col-span-3">
            <Wordmark size={40} className="mb-6" />
            <span className="pill"><Sparkles size={13} className="text-neon" /> Live on Arc mainnet</span>
            <h1 className="mt-4 text-balance font-display text-4xl font-bold leading-[1.05] tracking-[-0.04em] text-white sm:text-6xl">
              One Wallet.
              <br />
              <span className="gradient-text">Every Possibility.</span>
            </h1>
            <p className="mt-4 max-w-lg text-pretty text-slate-300">
              Send, swap, bridge and get paid in USDC on Arc. Real balances, real quotes, real transactions. Your keys never leave your wallet.
            </p>
          </div>
          <div className="lg:col-span-2">
            <ConnectionStatus variant="card" />
          </div>
        </div>
        <div className="relative mt-8">
          <p className="label mb-3">Connect to begin</p>
          <ConnectPanel />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['Real data only', 'Balances, quotes and history come from the chain. Nothing is simulated.', '#20D6A0'],
          ['Your keys stay yours', 'FLUXORA never sees a private key or seed phrase. Every action is signed in your wallet.', '#8257FF'],
          ['Mainnet, so be careful', 'Transactions move real funds on Arc and cannot be reversed.', '#FF55B8'],
        ].map(([t, d, c]) => (
          <Card key={t} className="lift !p-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${c}26`, color: c }}>
              <ShieldCheck size={20} />
            </span>
            <h3 className="mt-3 font-display font-semibold">{t}</h3>
            <p className="mt-1 text-sm text-slate-400">{d}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}

export function Dashboard({ navigate }: { navigate: (v: View) => void }) {
  const { isConnected, address } = useAccount()
  const { onArc, switchToArc } = useArcWallet()
  const balances = useTokenBalances()
  const prices = useTokenPrices()
  const { rows, transfers } = useHistoryRows()

  const valued = useMemo(
    () =>
      balances.rows.map((r) => {
        const price = prices.data?.[r.token.symbol]
        // value in 6-decimal USDC base units; unknown price => unknown value (never guessed)
        const value = r.raw === undefined || price === undefined || price === null ? null : (r.raw * price) / 10n ** BigInt(r.token.decimals)
        return { ...r, value }
      }),
    [balances.rows, prices.data],
  )

  const total = valued.reduce((sum, r) => sum + (r.value ?? 0n), 0n)
  const unpriced = valued.filter((r) => r.raw !== undefined && r.raw > 0n && r.value === null)
  const totalNum = Number(total) / 10 ** USDC.decimals
  const chartData = useMemo(() => valued.filter((r) => r.value && r.value > 0n).map((r) => ({ name: r.token.symbol, value: Number(r.value) / 10 ** USDC.decimals })), [valued])

  // Real money flow: USDC in/out from the transfer logs we actually read, grouped into time buckets
  const flow = useMemo(() => {
    const legs = transfers.txs.flatMap((t) => t.legs.filter((l) => l.token.symbol === 'USDC').map((l) => ({ ts: t.timestamp, l })))
    if (legs.length === 0) return []
    const min = Math.min(...legs.map((x) => x.ts))
    const max = Math.max(...legs.map((x) => x.ts))
    const buckets = 8
    const span = Math.max(1, max - min + 1)
    const out = Array.from({ length: buckets }, (_, i) => ({ label: timeAgo(min + Math.floor((span * (i + 0.5)) / buckets)), In: 0, Out: 0 }))
    for (const { ts, l } of legs) {
      const i = Math.min(buckets - 1, Math.floor(((ts - min) / span) * buckets))
      const v = Number(l.amount) / 10 ** l.token.decimals
      if (l.direction === 'in') out[i].In += v
      else out[i].Out += v
    }
    return out
  }, [transfers.txs])

  if (!isConnected || !address) return <Landing />

  return (
    <div className="space-y-5">
      {!onArc && (
        <Notice tone="warn" action={<button className="btn-ghost !min-h-[36px]" onClick={() => void switchToArc()}>Switch to Arc</button>}>
          Your wallet is not on Arc mainnet. Balances below are Arc balances.
        </Notice>
      )}

      {/* Hero portfolio card */}
      <div className="glass relative overflow-hidden rounded-[32px] p-6 sm:p-8" style={{ background: HERO_BG }}>
        <div className="relative grid items-center gap-6 md:grid-cols-5">
          <div className="min-w-0 md:col-span-3">
            <p className="label">Total wallet balance</p>
            <p className="mt-2 break-words font-display text-5xl font-bold tracking-[-0.045em] text-white tabular sm:text-7xl">
              {balances.isLoading || prices.isLoading ? <span className="skeleton inline-block h-12 w-56 align-middle sm:h-16 sm:w-80" aria-busy="true" aria-label="Loading balance" /> : <>${fmtUsd(total, USDC.decimals)}</>}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="pill font-mono">{shortAddr(address)} <CopyButton value={address} label="Copy address" /></span>
              <a className="pill hover:border-white/25" href={explorerAddress(ARC_CHAIN_ID, address)} target="_blank" rel="noopener noreferrer">Arc mainnet</a>
            </div>
            <p className="mt-4 max-w-md text-xs text-slate-400">
              Valued in USDC from live Uniswap quotes on Arc. USDC is counted once (its native and ERC-20 views are one pool).
            </p>
            {unpriced.length > 0 && (
              <p className="mt-2 text-xs text-amber-200">No live liquidity to price {unpriced.map((u) => u.token.symbol).join(', ')}. Held, but not in the total.</p>
            )}
          </div>

          <div className="relative mx-auto h-52 w-52 md:col-span-2 md:h-60 md:w-60">
            {balances.isLoading || prices.isLoading ? (
              <ChartSkeleton round />
            ) : chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-full border border-dashed border-white/15 p-8 text-center text-xs text-slate-400">No priced holdings yet</div>
            ) : (
              <Suspense fallback={<ChartSkeleton round />}>
                <AllocationDonut data={chartData} total={totalNum} />
              </Suspense>
            )}
          </div>
        </div>

        {/* Quick actions, each with its own color */}
        <div className="relative mt-7 grid grid-cols-5 gap-2 sm:gap-3">
          {ACTIONS.map((v) => {
            const t = VIEW_THEMES[v]
            const Icon = t.icon
            return (
              <button key={v} onClick={() => navigate(v)} onPointerEnter={() => prefetchView(v)} onTouchStart={() => prefetchView(v)} className="lift glass-inner group flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-2xl px-1 text-[11px] font-semibold text-slate-100 sm:text-sm">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white transition group-hover:scale-110" style={{ background: t.gradient }}>
                  <Icon size={19} />
                </span>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Assets */}
      <section>
        <h2 className="label mb-3 px-1">Assets</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {valued.map((r) => {
            const share = r.value && total > 0n ? Number((r.value * 1000n) / total) / 10 : 0
            return (
              <div key={r.token.address} className="lift glass relative overflow-hidden rounded-3xl p-4" style={{ background: `linear-gradient(150deg, ${r.token.color}33, transparent 60%), rgba(20,26,46,.78)` }}>
                <div className="flex items-center gap-3">
                  <TokenIcon token={r.token} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-lg font-semibold text-white">{r.token.symbol}</p>
                    <p className="truncate text-xs text-slate-400">{r.token.name}</p>
                  </div>
                  <span className="pill tabular">{share.toFixed(1)}%</span>
                </div>
                <p className="mt-4 truncate font-display text-2xl font-bold tabular text-white">{r.raw === undefined ? '—' : fmtToken(r.raw, r.token.decimals, 4)}</p>
                <p className="text-xs text-slate-400">{prices.isLoading || r.raw === undefined ? <span className="skeleton inline-block h-3.5 w-16 align-middle" aria-busy="true" /> : r.value === null ? (r.raw === 0n ? '$0.00' : 'No live price') : `$${fmtUsd(r.value, USDC.decimals)}`}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(share, r.raw ? 2 : 0)}%`, background: `linear-gradient(90deg, ${r.token.color}, #fff6)` }} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Card className="min-w-0 lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <p className="label flex items-center gap-2"><Waves size={14} className="text-neon" /> USDC money flow</p>
            <span className="text-xs text-slate-500">from recent blocks</span>
          </div>
          {transfers.isLoading ? (
            <p className="flex items-center gap-2 py-12 text-sm text-slate-400"><Spinner /> Reading recent blocks…</p>
          ) : flow.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">No USDC movement in the recent blocks scanned.</p>
          ) : (
            <div className="h-56">
              <Suspense fallback={<ChartSkeleton />}>
                <FlowBars data={flow} />
              </Suspense>
            </div>
          )}
          <div className="mt-2 flex gap-4 text-xs text-slate-300">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-flux-green" /> Received</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-flux-pink" /> Sent</span>
          </div>
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <p className="label">Recent transactions</p>
            <button className="-my-3 min-h-[44px] px-1 text-sm font-medium text-neon hover:brightness-125" onClick={() => navigate('history')}>View all</button>
          </div>
          {transfers.isLoading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-slate-400"><Spinner /> Reading recent blocks…</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">No activity in the recent blocks scanned. Older history is on the History page.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {rows.slice(0, 5).map((r) => (
                <li key={r.key} className="flex min-h-[56px] items-center gap-3 py-2">
                  <HistoryKindBadge kind={r.kind} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{r.summary}</p>
                    <p className="text-xs text-slate-400">{timeAgo(r.timestamp)}</p>
                  </div>
                  {r.hash && <ExplorerLink href={explorerTx(r.chainId, r.hash)}>Tx</ExplorerLink>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* FLUXORA contracts status: honest about what is deployed */}
      <Card>
        <p className="label mb-3">FLUXORA contracts</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {Object.values(CONTRACT_DEFINITIONS).map((c) => (
            <li key={c.name} className="glass-inner flex items-center gap-2.5 rounded-2xl p-3">
              {c.address ? <CheckCircle2 size={18} className="shrink-0 text-flux-green" /> : <CircleSlash size={18} className="shrink-0 text-slate-500" />}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{c.label.replace('FLUXORA ', '')}</p>
                {c.address ? (
                  <a className="block truncate font-mono text-[11px] text-neon hover:underline" href={explorerAddress(c.chainId, c.address)} target="_blank" rel="noopener noreferrer">{shortAddr(c.address)}</a>
                ) : (
                  <p className="text-[11px] text-slate-500">Contract Not Deployed</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
