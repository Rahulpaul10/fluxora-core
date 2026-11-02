import { useEffect, useMemo, useState } from 'react'
import { erc20Abi, type Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { useGuardedWrite, useGuardedSend, useGuardedSign } from '@/hooks/useGuardedWallet'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Amount } from '@/onchain-money'
import { useTokenBalances } from '@/hooks/useBalances'
import { ARC_TOKENS, USDC, type TokenInfo } from '@/lib/tokens'
import { ARC_CHAIN_ID } from '@/config/networks'
import { getFees } from '@/lib/fees'
import { waitForReceipt } from '@/lib/txTracker'
import { fmtToken } from '@/lib/format'
import { parseTxError } from '@/lib/errors'
import { recordActivity } from '@/lib/activity'
import {
  PERMIT2, PERMIT2_DOMAIN, PERMIT2_TYPES, PRICE_IMPACT_BLOCK, PRICE_IMPACT_WARN, SLIPPAGE_DEFAULT_BPS, SLIPPAGE_MAX_BPS, SLIPPAGE_WARN_BPS,
  UNISWAP_ERRORS, assertSlippage, bestQuote, buildSwap, findRoutes, minOut, permitNeeded,
} from '@/lib/uniswap-arc'
import { ArcGate } from '@/components/Gate'
import { TokenButton, TokenPicker } from '@/components/TokenSelect'
import { TxStatus } from '@/components/TxStatus'
import { Card, Notice, PageTitle, Row, Spinner, TokenIcon } from '@/components/ui'

type Phase = 'idle' | 'approving' | 'signing' | 'sending'

export function Swap() {
  return (
    <>
      <PageTitle
        title="Swap"
        subtitle="Live quotes from Uniswap v3 and v4 pools on Arc. The best live route is used. Swaps run on Arc mainnet only."
      />
      <ArcGate feature="Swap">
        <SwapForm />
      </ArcGate>
    </>
  )
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function SwapForm() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  const { writeContractAsync } = useGuardedWrite()
  const { sendTransactionAsync } = useGuardedSend()
  const { signTypedDataAsync } = useGuardedSign()
  const balances = useTokenBalances()

  const [inSym, setInSym] = useState('USDC')
  const [outSym, setOutSym] = useState(ARC_TOKENS.find((t) => t.symbol !== 'USDC')?.symbol ?? '')
  const [amount, setAmount] = useState('')
  const [picker, setPicker] = useState<'in' | 'out' | null>(null)
  const [slipOpen, setSlipOpen] = useState(false)
  const [slipText, setSlipText] = useState((SLIPPAGE_DEFAULT_BPS / 100).toString())
  const [acceptLoss, setAcceptLoss] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [hash, setHash] = useState<Hex>()
  const [error, setError] = useState<string>()

  const rowIn = balances.rows.find((r) => r.token.symbol === inSym)
  const rowOut = balances.rows.find((r) => r.token.symbol === outSym)
  const tokenIn = rowIn?.token
  const tokenOut = rowOut?.token

  const slipPct = Number(slipText)
  const slipBps = Number.isFinite(slipPct) ? Math.round(slipPct * 100) : NaN
  const slipError =
    !Number.isFinite(slipBps) || slipBps < 1
      ? 'Enter a slippage above 0%.'
      : slipBps > SLIPPAGE_MAX_BPS
        ? `Slippage is capped at ${SLIPPAGE_MAX_BPS / 100}% to protect you.`
        : undefined

  const parsed = useMemo(() => {
    if (!tokenIn || !amount) return { raw: undefined as bigint | undefined, error: undefined as string | undefined }
    try {
      const a = Amount.parse(amount, tokenIn.decimals)
      if (!a.isPositive()) return { raw: undefined, error: 'Amount must be greater than zero.' }
      if (rowIn?.raw !== undefined && a.raw > rowIn.raw) return { raw: undefined, error: 'Amount exceeds your balance.' }
      return { raw: a.raw, error: undefined }
    } catch {
      return { raw: undefined, error: `Enter a number with up to ${tokenIn.decimals} decimals.` }
    }
  }, [amount, tokenIn, rowIn?.raw])

  const debouncedRaw = useDebounced(parsed.raw, 450)
  const sameToken = inSym === outSym

  const pairKey = tokenIn && tokenOut ? `${tokenIn.address}:${tokenOut.address}` : ''

  const quote = useQuery({
    queryKey: ['swap-quote', tokenIn?.address, tokenOut?.address, debouncedRaw?.toString()],
    enabled: Boolean(client && tokenIn && tokenOut && debouncedRaw && !sameToken),
    // Only refresh a quote that worked: a pair with no pool is not hammered every 15 seconds.
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
    retry: false,
    // While a new amount is being priced, keep showing the previous quote for the SAME pair (dimmed), not a blank.
    placeholderData: (previous) => previous,
    queryFn: async () => {
      if (!client || !tokenIn || !tokenOut || !debouncedRaw) throw new Error('missing input')
      return { ...(await bestQuote(client, tokenIn.address, tokenOut.address, 'exactIn', debouncedRaw)), pairKey }
    },
  })

  // Only when pricing failed: find out whether the pair has no pool at all, and which tokens it can trade with.
  const partners = useQuery({
    queryKey: ['swap-partners', tokenIn?.address],
    enabled: Boolean(client && tokenIn && quote.isError && !sameToken),
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      if (!client || !tokenIn) return [] as string[]
      const others = ARC_TOKENS.filter((t) => t.symbol !== tokenIn.symbol)
      const found = await Promise.all(others.map(async (t) => ((await findRoutes(client, tokenIn.address, t.address)).length > 0 ? t.symbol : null)))
      return found.filter((s): s is string => s !== null)
    },
  })
  const noPool = Boolean(quote.isError && !sameToken && tokenOut && partners.isSuccess && !partners.data.includes(tokenOut.symbol))

  // Keep room for network fees when swapping USDC (gas is paid in the same USDC pool)
  const feeReserve = useQuery({
    queryKey: ['swap-fee-reserve'],
    enabled: Boolean(client),
    staleTime: 60_000,
    queryFn: async () => {
      if (!client) return 0n
      const fees = await getFees(client, ARC_CHAIN_ID)
      // generous upper bound on gas units for an approve plus a router swap
      return Amount.fromRaw(500_000n * fees.maxFeePerGas, 18).toDecimals(USDC.decimals, 'trunc').raw
    },
  })

  // A quote from another pair (kept as a placeholder while switching tokens) is never used.
  const q = parsed.raw !== undefined && quote.data && quote.data.pairKey === pairKey ? quote.data : undefined
  const stale = parsed.raw !== debouncedRaw || quote.isPlaceholderData
  const impact = q?.priceImpact ?? 0
  const highImpact = impact > PRICE_IMPACT_BLOCK
  const reserveShort =
    inSym === 'USDC' && parsed.raw !== undefined && rowIn?.raw !== undefined && feeReserve.data !== undefined && rowIn.raw - parsed.raw < feeReserve.data

  const canSwap =
    Boolean(q && !stale && !slipError && !parsed.error && !sameToken && phase === 'idle' && (!highImpact || acceptLoss)) && !reserveShort

  const rate = q && tokenIn && tokenOut ? Number(Amount.fromRaw(q.amountOut, tokenOut.decimals).toString()) / Number(Amount.fromRaw(q.amountIn, tokenIn.decimals).toString()) : undefined

  const flip = () => {
    setInSym(outSym)
    setOutSym(inSym)
    setAmount('')
  }

  const execute = async () => {
    if (!client || !address || !tokenIn || !tokenOut || !parsed.raw) return
    setError(undefined)
    try {
      assertSlippage(slipBps)
      // Re-quote right before signing so the bounds come from a fresh price
      const [fresh, balance, fees, allowance] = await Promise.all([
        bestQuote(client, tokenIn.address, tokenOut.address, 'exactIn', parsed.raw),
        client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        getFees(client, ARC_CHAIN_ID),
        client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: 'allowance', args: [address, PERMIT2] }),
      ])
      if (fresh.priceImpact > PRICE_IMPACT_BLOCK && !acceptLoss) throw new Error('Price impact rose above 5%. Review the new quote.')
      if (parsed.raw > balance) throw new Error('Amount exceeds your balance.')
      if (allowance < parsed.raw) {
        setPhase('approving')
        const approveHash = await writeContractAsync({
          chainId: ARC_CHAIN_ID, address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, parsed.raw],
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        })
        recordActivity({ hash: approveHash, kind: 'approve', chainId: ARC_CHAIN_ID, account: address, summary: `Approved ${tokenIn.symbol} for swapping` })
        const receipt = await waitForReceipt(client, approveHash)
        if (receipt.status !== 'success') throw new Error('The approval transaction reverted.')
      }

      const now = (await client.getBlock()).timestamp
      const permit = await permitNeeded(client, address, tokenIn.address, parsed.raw, now)
      let signature: Hex | undefined
      if (permit) {
        setPhase('signing')
        signature = await signTypedDataAsync({ domain: PERMIT2_DOMAIN, types: PERMIT2_TYPES, primaryType: 'PermitSingle', message: permit })
      }

      setPhase('sending')
      const tx = buildSwap(fresh, tokenIn.address, tokenOut.address, address, slipBps, now + 1200n, permit && signature ? { permit, signature } : undefined)
      await client.call({ account: address, to: tx.to, data: tx.data }) // simulate: throws on revert
      const gas = await client.estimateGas({ account: address, to: tx.to, data: tx.data })
      const h = await sendTransactionAsync({
        chainId: ARC_CHAIN_ID, to: tx.to, data: tx.data, value: 0n, gas: (gas * 12n) / 10n,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
      setHash(h)
      recordActivity({
        hash: h, kind: 'swap', chainId: ARC_CHAIN_ID, account: address,
        summary: `Swapped ${fmtToken(fresh.amountIn, tokenIn.decimals, 4)} ${tokenIn.symbol} for ${tokenOut.symbol}`,
      })
    } catch (e) {
      const p = parseTxError(e)
      const decoded = decodeRouterError(e)
      if (p.rejected) toast('Swap cancelled')
      else setError(decoded ?? p.message)
    } finally {
      setPhase('idle')
    }
  }

  if (hash && tokenIn && tokenOut) {
    return (
      <Card className="mx-auto max-w-xl space-y-4">
        <TxStatus hash={hash} chainId={ARC_CHAIN_ID} title="Swap" onSettled={() => void balances.refetch()} />
        <button className="btn-ghost w-full" onClick={() => { setHash(undefined); setAmount('') }}>
          New swap
        </button>
      </Card>
    )
  }

  return (
    <Card className="mx-auto max-w-xl space-y-4">
      <Notice tone="warn">Arc mainnet. Swaps use real funds. Prices come from live pools and can move before you confirm.</Notice>

      <div className="glass-inner rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <span className="label">You pay</span>
          <button
            className="-my-3.5 py-3.5 text-xs font-semibold text-[var(--a)]"
            onClick={() => rowIn?.raw !== undefined && tokenIn && setAmount(Amount.fromRaw(rowIn.raw, tokenIn.decimals).toString())}
          >
            Balance {rowIn?.raw === undefined || !tokenIn ? '…' : fmtToken(rowIn.raw, tokenIn.decimals)} · Max
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <input
            inputMode="decimal"
            className="min-w-0 flex-1 bg-transparent font-display text-3xl font-semibold text-white outline-none placeholder:text-slate-600 tabular"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/,/g, '.'))}
            aria-label="Amount to pay"
          />
          <TokenButton token={tokenIn} onClick={() => setPicker('in')} />
        </div>
        {parsed.error && <p className="mt-2 text-sm text-flux-pink">{parsed.error}</p>}
      </div>

      <div className="relative z-10 -my-6 flex justify-center">
        <button onClick={flip} className="rounded-xl border border-white/10 bg-navy-800 p-2.5 text-[var(--a)] shadow-cyan hover:bg-navy-700" aria-label="Flip tokens">
          <ArrowDown size={18} />
        </button>
      </div>

      <div className="glass-inner rounded-2xl p-4">
        <span className="label">You receive (estimated)</span>
        <div className="mt-2 flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate font-display text-3xl font-semibold tabular text-white">
            {quote.isFetching && !q ? <span className="skeleton inline-block h-8 w-40 align-middle" aria-busy="true" aria-label="Getting best price" /> : q && tokenOut ? <span className={stale ? 'opacity-50 transition-opacity' : 'transition-opacity'}>{fmtToken(q.amountOut, tokenOut.decimals, 6)}</span> : '0.00'}
          </p>
          <TokenButton token={tokenOut} onClick={() => setPicker('out')} />
        </div>
      </div>

      {sameToken && <Notice tone="warn">Choose two different tokens.</Notice>}
      {noPool && tokenIn && tokenOut && (
        <Notice tone="warn">
          There is no Uniswap pool for {tokenIn.symbol} and {tokenOut.symbol} on Arc, so this pair cannot be swapped.{' '}
          {partners.data && partners.data.length > 0
            ? `${tokenIn.symbol} can be swapped with ${partners.data.join(', ')}.`
            : `No live pool currently pairs ${tokenIn.symbol} with another supported token.`}
        </Notice>
      )}
      {partners.isError && !sameToken && <Notice tone="warn">Could not check which pools exist. Check your connection and try again.</Notice>}
      {quote.isError && !sameToken && partners.isFetching && <Notice tone="info">Checking which pools exist…</Notice>}
      {quote.isError && !sameToken && !noPool && !partners.isFetching && debouncedRaw !== undefined && (
        <Notice tone="warn">No route at this size. No live pool can fill it, so no price is shown.</Notice>
      )}

      {q && tokenIn && tokenOut && (
        <div className={`divide-y divide-white/5 rounded-2xl border border-white/5 px-4 transition-opacity ${stale ? 'opacity-50' : ''}`} aria-busy={stale}>
          <Row label="Exchange rate" value={rate !== undefined ? `1 ${tokenIn.symbol} ≈ ${rate.toLocaleString(undefined, { maximumSignificantDigits: 6 })} ${tokenOut.symbol}` : '—'} />
          <Row label="Route" value={`Uniswap ${q.route.version} · ${(q.route.feeFraction * 100).toFixed(2)}% fee`} />
          <Row
            label="Price impact"
            value={<span className={impact > PRICE_IMPACT_WARN ? 'text-amber-300' : 'text-flux-green'}>{(impact * 100).toFixed(2)}%</span>}
          />
          <Row label={`Minimum received (${(slipBps / 100).toFixed(2)}% slippage)`} value={Number.isFinite(slipBps) && !slipError ? `${fmtToken(minOut(q.amountOut, slipBps), tokenOut.decimals, 6)} ${tokenOut.symbol}` : '—'} />
          <Row label="Deadline" value="20 minutes" />
        </div>
      )}

      {impact > PRICE_IMPACT_WARN && (
        <Notice tone={highImpact ? 'error' : 'warn'}>
          This trade moves the pool price by {(impact * 100).toFixed(2)}%. Consider a smaller amount.
          {highImpact && (
            <label className="mt-2 flex items-center gap-2 font-medium">
              <input type="checkbox" checked={acceptLoss} onChange={(e) => setAcceptLoss(e.target.checked)} className="h-4 w-4" />
              I accept a loss of about {(impact * 100).toFixed(1)}%
            </label>
          )}
        </Notice>
      )}
      {reserveShort && <Notice tone="warn">Keep some USDC for network fees. Lower the amount.</Notice>}

      <button className="btn-ghost w-full" onClick={() => setSlipOpen((o) => !o)}>
        <Settings2 size={16} /> Slippage {Number.isFinite(slipPct) ? slipPct : '—'}%
      </button>
      {slipOpen && (
        <div className="glass-inner space-y-2 rounded-2xl p-4">
          <div className="flex gap-2">
            {['0.1', '0.5', '1'].map((p) => (
              <button key={p} className={`btn-ghost flex-1 ${slipText === p ? '!border-[var(--a)] !bg-white/10' : ''}`} onClick={() => setSlipText(p)}>
                {p}%
              </button>
            ))}
            <input className="field !w-24 text-center" value={slipText} onChange={(e) => setSlipText(e.target.value)} inputMode="decimal" aria-label="Custom slippage percent" />
          </div>
          {slipError && <p className="text-sm text-flux-pink">{slipError}</p>}
          {!slipError && slipBps > SLIPPAGE_WARN_BPS && <p className="text-sm text-amber-300">High slippage can let others trade against you.</p>}
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <button className="btn-primary w-full" disabled={!canSwap} onClick={() => void execute()}>
        {phase === 'approving' && <><Spinner /> Approve {tokenIn?.symbol} in your wallet…</>}
        {phase === 'signing' && <><Spinner /> Sign the permit in your wallet…</>}
        {phase === 'sending' && <><Spinner /> Confirm the swap in your wallet…</>}
        {phase === 'idle' && (stale || quote.isFetching ? 'Getting best price…' : 'Swap')}
      </button>

      <TokenPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        rows={balances.rows}
        exclude={picker === 'in' ? outSym : inSym}
        onSelect={(t: TokenInfo) => (picker === 'in' ? setInSym(t.symbol) : setOutSym(t.symbol))}
      />
      <p className="flex items-center justify-center gap-2 text-center text-xs text-slate-500">
        <TokenIcon token={USDC} size={14} /> Execution through Uniswap Universal Router 2.1.2 and Permit2 on Arc.
      </p>
    </Card>
  )
}

function decodeRouterError(e: unknown): string | undefined {
  const text = e instanceof Error ? e.message : ''
  for (const item of UNISWAP_ERRORS) {
    if (text.includes(item.name)) {
      if (item.name === 'V3TooLittleReceived' || item.name === 'V4TooLittleReceived') return 'The price moved beyond your slippage limit. Get a new quote and try again.'
      if (item.name === 'TransactionDeadlinePassed') return 'The swap deadline passed. Try again.'
      if (item.name === 'AllowanceExpired' || item.name === 'InsufficientAllowance') return 'The swap permission expired. Try again to sign a new one.'
    }
  }
  return undefined
}
