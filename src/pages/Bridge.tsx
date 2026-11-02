import { useEffect, useMemo, useRef, useState } from 'react'
import { erc20Abi, isAddress, type EIP1193Provider } from 'viem'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import type { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { AppKit, BridgeResult } from '@circle-fin/app-kit'
import { loadBridgeKit, loadViemAdapter } from '@/lib/bridgeKit'
import { ArrowDown, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { getUsdc } from '@/onchain-facts'
import { Amount } from '@/onchain-money'
import { NETWORKS, networkById, explorerTx, asChainId, type NetworkInfo } from '@/config/networks'
import { fmtToken } from '@/lib/format'
import { parseTxError } from '@/lib/errors'
import { recordActivity, updateActivity } from '@/lib/activity'
import { Card, ExplorerLink, Notice, PageTitle, Row, Segmented, Spinner, TokenIcon } from '@/components/ui'
import { USDC } from '@/lib/tokens'
import { ConnectKitButton } from 'connectkit'

type Speed = 'FAST' | 'SLOW'
interface StepView {
  name: string
  state: string
  txHash?: string
  explorerUrl?: string
}

function NetworkPick({ label, value, onChange, exclude }: { label: string; value: number; onChange: (id: number) => void; exclude?: number }) {
  return (
    <div className="glass-inner rounded-2xl p-4">
      <label className="label" htmlFor={`net-${label}`}>
        {label}
      </label>
      <select
        id={`net-${label}`}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="field mt-2 !bg-navy-900"
      >
        {NETWORKS.filter((n) => n.id !== exclude).map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
          </option>
        ))}
      </select>
    </div>
  )
}

export function Bridge() {
  const { address, isConnected, chainId, connector } = useAccount()
  const { switchChainAsync, isPending: switching } = useSwitchChain()

  const [fromId, setFromId] = useState(NETWORKS[1].id) // Ethereum -> Arc by default
  const [toId, setToId] = useState(NETWORKS[0].id)
  const [amount, setAmount] = useState('')
  const [speed, setSpeed] = useState<Speed>('FAST')
  const [recipient, setRecipient] = useState('')
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<StepView[]>([])
  const [result, setResult] = useState<BridgeResult<string>>()
  const [error, setError] = useState<string>()
  const adapterRef = useRef<Awaited<ReturnType<typeof createViemAdapterFromProvider>>>()

  const from = networkById(fromId) as NetworkInfo
  const to = networkById(toId) as NetworkInfo
  const usdcFact = getUsdc(fromId)

  const balance = useReadContract({
    address: usdcFact?.address as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: asChainId(fromId),
    query: { enabled: Boolean(address && usdcFact), refetchInterval: 20_000 },
  })

  const parsed = useMemo(() => {
    if (!amount) return { raw: undefined as bigint | undefined, error: undefined as string | undefined }
    try {
      const a = Amount.parse(amount, USDC.decimals)
      if (!a.isPositive()) return { raw: undefined, error: 'Amount must be greater than zero.' }
      if (balance.data !== undefined && a.raw > balance.data) return { raw: undefined, error: `Insufficient USDC on ${from.name}.` }
      return { raw: a.raw, error: undefined }
    } catch {
      return { raw: undefined, error: 'Enter a number with up to 6 decimals.' }
    }
  }, [amount, balance.data, from.name])

  const recipientError = recipient && !isAddress(recipient) ? 'Enter a valid 0x address, or leave empty to use your wallet.' : undefined
  const destination = recipient && !recipientError ? recipient : address
  const onSource = chainId === fromId

  const getAdapter = async () => {
    if (!connector) throw new Error('Wallet not connected')
    const provider = (await connector.getProvider()) as EIP1193Provider
    const { createViemAdapterFromProvider } = await loadViemAdapter()
    const adapter = await createViemAdapterFromProvider({ provider })
    adapterRef.current = adapter
    return adapter
  }

  // Real quote from Circle's bridge service. Requires the wallet to be on the source chain.
  const [debounced, setDebounced] = useState<{ raw?: bigint; speed: Speed }>({ speed })
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ raw: parsed.raw, speed }), 600)
    return () => clearTimeout(t)
  }, [parsed.raw, speed])

  const quote = useQuery({
    queryKey: ['bridge-quote', fromId, toId, debounced.raw?.toString(), debounced.speed, destination],
    enabled: Boolean(debounced.raw && address && destination && onSource && !recipientError && fromId !== toId),
    retry: false,
    staleTime: 20_000,
    queryFn: async () => {
      if (!debounced.raw || !destination) throw new Error('missing input')
      const [adapter, kit] = await Promise.all([getAdapter(), loadBridgeKit()])
      return kit.estimateBridge({
        from: { adapter, chain: from.kit },
        to: { chain: to.kit, recipientAddress: destination, useForwarder: true },
        amount: Amount.fromRaw(debounced.raw, USDC.decimals).toString(),
        config: { transferSpeed: debounced.speed },
      })
    },
  })

  const fees = quote.data?.fees ?? []
  const totalFee = fees.reduce((s, f) => s + (f.amount ? Number(f.amount) : 0), 0)
  const stale = parsed.raw !== debounced.raw || speed !== debounced.speed
  const q = quote.data
  const canBridge = Boolean(q && !stale && !running && onSource && parsed.raw && !recipientError && !result)

  const run = async () => {
    if (!address || !destination || !parsed.raw) return
    setRunning(true)
    setError(undefined)
    setSteps([])
    setResult(undefined)
    const handler = (payload: unknown) => {
      {
        const p = payload as { method?: string; values?: { state?: string; txHash?: string; transactionHash?: string; explorerUrl?: string } }
        if (!p.method || !p.values) return
        const name = p.method
        const txHash = p.values.txHash ?? p.values.transactionHash
        setSteps((prev) => {
          const next = prev.filter((s) => s.name !== name)
          next.push({ name, state: p.values?.state ?? 'success', txHash, explorerUrl: p.values?.explorerUrl })
          return next
        })
        if (name === 'burn' || name === 'transfer') {
          if (txHash) {
            recordActivity({
              hash: txHash as `0x${string}`, kind: 'bridge', chainId: fromId, account: address,
              summary: `Bridged ${amount} USDC from ${from.name} to ${to.name}`,
              note: 'Funds arrive on the destination after Circle attestation',
            })
          }
        }
      }
    }
    let kit: AppKit | undefined
    try {
      kit = await loadBridgeKit()
      kit.on('*', handler)
      const adapter = adapterRef.current ?? (await getAdapter())
      const res = await kit.bridge({
        from: { adapter, chain: from.kit },
        to: { chain: to.kit, recipientAddress: destination, useForwarder: true },
        amount: Amount.fromRaw(parsed.raw, USDC.decimals).toString(),
        config: { transferSpeed: speed },
      })
      setResult(res)
      setSteps(res.steps.map((s) => ({ name: s.name, state: s.state, txHash: s.txHash, explorerUrl: s.explorerUrl })))
      for (const s of res.steps) {
        if ((s.name === 'burn' || s.name === 'transfer') && s.txHash) updateActivity(s.txHash as `0x${string}`, fromId, s.state === 'success' ? 'success' : 'failed')
      }
      if (res.state === 'error') setError('The transfer stopped part-way. Your funds are safe: retry resumes from the failed step.')
      else void balance.refetch()
    } catch (e) {
      const p = parseTxError(e)
      if (p.rejected) toast('Bridge cancelled')
      else setError(p.message)
    } finally {
      kit?.off('*', handler)
      setRunning(false)
    }
  }

  const retry = async () => {
    if (!result || !adapterRef.current) return
    setRunning(true)
    setError(undefined)
    try {
      const kit = await loadBridgeKit()
      const res = await kit.retryBridge(result, { from: adapterRef.current, to: adapterRef.current })
      setResult(res)
      setSteps(res.steps.map((s) => ({ name: s.name, state: s.state, txHash: s.txHash, explorerUrl: s.explorerUrl })))
      if (res.state === 'error') setError('Still not complete. You can retry again.')
    } catch (e) {
      setError(parseTxError(e).message)
    } finally {
      setRunning(false)
    }
  }

  const swapDirection = () => {
    setFromId(toId)
    setToId(fromId)
    setResult(undefined)
    setSteps([])
  }

  return (
    <>
      <PageTitle
        title="Bridge"
        subtitle="Move USDC between Arc and other networks with Circle CCTP. Only networks officially supported by Circle are listed."
      />
      <Card className="mx-auto max-w-xl space-y-4">
        <Notice tone="warn">Mainnet. Bridging burns USDC on the source network and mints it on the destination. It cannot be undone.</Notice>

        <NetworkPick label="From" value={fromId} onChange={(id) => { setFromId(id); if (id === toId) setToId(fromId) }} exclude={toId} />
        <div className="relative z-10 -my-6 flex justify-center">
          <button onClick={swapDirection} className="rounded-xl border border-white/10 bg-navy-800 p-2.5 text-[var(--a)] shadow-cyan hover:bg-navy-700" aria-label="Swap direction">
            <ArrowDown size={18} />
          </button>
        </div>
        <NetworkPick label="To" value={toId} onChange={(id) => { setToId(id); if (id === fromId) setFromId(toId) }} exclude={fromId} />

        <div className="glass-inner rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <label className="label" htmlFor="bridge-amt">Amount</label>
            <button
              className="-my-3.5 py-3.5 text-xs font-semibold text-[var(--a)]"
              onClick={() => balance.data !== undefined && setAmount(Amount.fromRaw(balance.data, USDC.decimals).toString())}
            >
              Balance {balance.data === undefined ? (isConnected ? '…' : '—') : fmtToken(balance.data, USDC.decimals)} · Max
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              id="bridge-amt"
              inputMode="decimal"
              className="min-w-0 flex-1 bg-transparent font-display text-3xl font-semibold text-white outline-none placeholder:text-slate-600 tabular"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/,/g, '.'))
                setResult(undefined)
                setSteps([])
              }}
            />
            <span className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 font-semibold">
              <TokenIcon token={USDC} size={22} /> USDC
            </span>
          </div>
          {parsed.error && <p className="mt-2 text-sm text-flux-pink">{parsed.error}</p>}
        </div>

        <div>
          <p className="label mb-2">Transfer speed</p>
          <Segmented value={speed} onChange={setSpeed} options={[{ value: 'FAST', label: 'Fast' }, { value: 'SLOW', label: 'Standard (lower fee)' }]} />
        </div>

        <div>
          <label className="label" htmlFor="bridge-rcpt">Recipient on {to.name} (optional)</label>
          <input id="bridge-rcpt" className="field mt-2 font-mono text-sm" placeholder={address ?? '0x…'} value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} spellCheck={false} />
          {recipientError && <p className="mt-1.5 text-sm text-flux-pink">{recipientError}</p>}
        </div>

        {!isConnected ? (
          <ConnectKitButton.Custom>
            {({ show }) => <button className="btn-primary w-full" onClick={show}>Connect wallet</button>}
          </ConnectKitButton.Custom>
        ) : !onSource ? (
          <button
            className="btn-primary w-full"
            disabled={switching}
            onClick={() => {
              switchChainAsync({ chainId: asChainId(fromId) }).catch(() => toast.error(`Could not switch to ${from.name}.`))
            }}
          >
            {switching ? 'Check your wallet…' : `Switch wallet to ${from.name}`}
          </button>
        ) : (
          <>
            {parsed.raw && (
              <div className="divide-y divide-white/5 rounded-2xl border border-white/5 px-4">
                {quote.isFetching || stale ? (
                  <p className="flex items-center gap-2 py-3 text-sm text-slate-400"><Spinner /> Getting a live quote…</p>
                ) : quote.isError ? (
                  <p className="py-3 text-sm text-amber-200">No quote available for this route or amount: {quote.error instanceof Error ? quote.error.message.split('\n')[0] : 'unknown error'}</p>
                ) : q ? (
                  <>
                    <Row label="You send" value={`${q.amount} USDC on ${from.name}`} />
                    {fees.map((f, i) => (
                      <Row key={i} label={`${f.type === 'forwarder' ? 'Forwarding' : f.type === 'kit' ? 'Service' : 'Protocol'} fee`} value={f.amount ? `${f.amount} ${f.token}` : 'n/a'} />
                    ))}
                    {q.gasFees.map((g, i) => (
                      <Row key={`g${i}`} label={`Network fee (${g.name})`} value={g.fees ? `${g.fees.fee} ${g.token}` : 'n/a'} />
                    ))}
                    <Row label="Estimated receive" value={`≈ ${Math.max(0, Number(q.amount) - totalFee).toFixed(6)} USDC`} />
                    <Row label="Estimated arrival" value={speed === 'FAST' ? 'Typically under a minute' : 'Typically 15 to 20 minutes'} />
                  </>
                ) : null}
              </div>
            )}
            {Number(amount) > 100 && <Notice tone="warn">Large transfer. Double-check networks and recipient before confirming.</Notice>}
            <button className="btn-primary w-full" disabled={!canBridge} onClick={() => void run()}>
              {running ? <><Spinner /> Bridging, follow your wallet prompts…</> : <>Bridge to {to.name} <ArrowRight size={18} /></>}
            </button>
          </>
        )}

        {error && (
          <Notice tone="error" action={result?.state === 'error' ? <button className="btn-ghost !min-h-[36px]" disabled={running} onClick={() => void retry()}>Retry</button> : undefined}>
            {error}
          </Notice>
        )}

        {steps.length > 0 && (
          <div className="glass-inner space-y-2 rounded-2xl p-4">
            <p className="label">Transfer progress (live from the bridge)</p>
            {steps.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-200">{stepLabel(s.name)}</span>
                <span className="flex items-center gap-3">
                  <span className={s.state === 'success' ? 'text-flux-green' : s.state === 'error' ? 'text-flux-pink' : 'text-amber-300'}>{s.state}</span>
                  {s.txHash && <ExplorerLink href={s.explorerUrl ?? explorerTx(fromId, s.txHash)}>Tx</ExplorerLink>}
                </span>
              </div>
            ))}
            {result?.state === 'success' && <Notice tone="success">Bridge complete. USDC was delivered on {to.name}.</Notice>}
          </div>
        )}
        <p className="text-center text-xs text-slate-500">Powered by Circle CCTP. Arrival times depend on source-chain finality and Circle attestation.</p>
      </Card>
    </>
  )
}

function stepLabel(name: string) {
  const map: Record<string, string> = {
    approve: 'Approve USDC',
    burn: 'Burn on source',
    fetchAttestation: 'Circle attestation',
    mint: 'Mint on destination',
    transfer: 'Submit transfer',
    forward: 'Forward to destination',
  }
  return map[name] ?? name
}
