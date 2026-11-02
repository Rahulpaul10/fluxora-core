import { useState } from 'react'
import { erc20Abi, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { useGuardedWrite } from '@/hooks/useGuardedWallet'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight } from 'lucide-react'
import { toast } from 'sonner'
import { Amount } from '@/onchain-money'
import { useTokenBalances } from '@/hooks/useBalances'
import { ARC_TOKENS, USDC, type TokenInfo } from '@/lib/tokens'
import { ARC_CHAIN_ID, explorerAddress } from '@/config/networks'
import { arcGasCostUsdc, fmtGasUsdc, getFees } from '@/lib/fees'
import { fmtToken, shortAddr } from '@/lib/format'
import { parseTxError } from '@/lib/errors'
import { recordActivity } from '@/lib/activity'
import { ArcGate } from '@/components/Gate'
import { TokenButton, TokenPicker } from '@/components/TokenSelect'
import { WalletSpeedTest } from '@/components/WalletSpeedTest'
import { TxStatus } from '@/components/TxStatus'
import { Card, ExplorerLink, Notice, PageTitle, Row, Spinner } from '@/components/ui'

const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'

export function Send({ presetTo, presetAmount, presetToken }: { presetTo?: string; presetAmount?: string; presetToken?: string }) {
  return (
    <>
      <PageTitle
        title="Send"
        subtitle="Send USDC or any supported token on Arc. On Arc, USDC is the native asset, so it is sent with a standard token transfer."
      />
      <ArcGate feature="Send">
        <SendForm presetTo={presetTo} presetAmount={presetAmount} presetToken={presetToken} />
      </ArcGate>
    </>
  )
}

function SendForm({ presetTo, presetAmount, presetToken }: { presetTo?: string; presetAmount?: string; presetToken?: string }) {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  const { writeContractAsync } = useGuardedWrite()
  const balances = useTokenBalances()

  const [symbol, setSymbol] = useState(ARC_TOKENS.find((t) => t.symbol === presetToken)?.symbol ?? USDC.symbol)
  const [to, setTo] = useState(presetTo ?? '')
  const [amount, setAmount] = useState(presetAmount ?? '')
  const [picker, setPicker] = useState(false)
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState(false)
  const [hash, setHash] = useState<Hex>()
  const [error, setError] = useState<string>()

  const row = balances.rows.find((r) => r.token.symbol === symbol) ?? balances.rows[0]
  const token: TokenInfo = row.token
  const usdcRow = balances.rows.find((r) => r.token.symbol === 'USDC')
  const balance = row.raw

  // Real gas estimate for an ERC-20 transfer, priced in USDC with the 20 gwei Arc fee floor.
  const gas = useQuery({
    queryKey: ['send-gas', address, token.address],
    enabled: Boolean(client && address),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!client || !address) throw new Error('no client')
      const [units, fees] = await Promise.all([
        client.estimateContractGas({ account: address, address: token.address, abi: erc20Abi, functionName: 'transfer', args: [address, 1n] }),
        getFees(client, ARC_CHAIN_ID),
      ])
      return { units, fees, cost: arcGasCostUsdc(units, fees.maxFeePerGas) }
    },
  })

  const check = (() => {
    const result: { recipient?: Address; raw?: bigint; toError?: string; amountError?: string; warn?: string } = {}
    const t = to.trim()
    if (t) {
      if (!isAddress(t)) result.toError = 'Enter a valid 0x wallet address.'
      else {
        const lower = t.toLowerCase()
        if (lower === zeroAddress) result.toError = 'Sending to the zero address is not allowed on Arc.'
        else if (lower === NATIVE_SENTINEL || lower === SYSTEM_EMITTER) result.toError = 'That is a system address, not a wallet.'
        else if (ARC_TOKENS.some((x) => x.address.toLowerCase() === lower))
          result.toError = 'That is a token contract. Tokens sent to it would be lost.'
        else {
          result.recipient = getAddress(t)
          if (address && lower === address.toLowerCase()) result.warn = 'This is your own address.'
        }
      }
    }
    if (amount) {
      try {
        const a = Amount.parse(amount, token.decimals)
        if (!a.isPositive()) result.amountError = 'Amount must be greater than zero.'
        else if (balance !== undefined && a.raw > balance) result.amountError = `Insufficient balance. You have ${fmtToken(balance, token.decimals)} ${token.symbol}.`
        else {
          result.raw = a.raw
          const cost = gas.data?.cost
          if (cost && usdcRow?.raw !== undefined) {
            const need = token.symbol === 'USDC' ? a.raw + cost.raw : cost.raw
            if (usdcRow.raw < need) result.amountError = 'Not enough USDC to cover the amount plus the network fee.'
          }
        }
      } catch {
        result.amountError = `Enter a number with up to ${token.decimals} decimals.`
      }
    }
    return result
  })()

  const ready = Boolean(check.recipient && check.raw && !check.toError && !check.amountError)

  const setMax = () => {
    if (balance === undefined) return
    let max = balance
    if (token.symbol === 'USDC') {
      const cost = gas.data?.cost.raw ?? 0n
      const reserve = (cost * 12n) / 10n // 20% buffer over the live estimate
      max = balance > reserve ? balance - reserve : 0n
    }
    setAmount(Amount.fromRaw(max, token.decimals).toString())
  }

  const submit = async () => {
    if (!client || !address || !check.recipient || !check.raw) return
    setBusy(true)
    setError(undefined)
    try {
      // The guarded wallet estimates gas first (a call that would revert never reaches the wallet) and attaches fees
      const h = await writeContractAsync({
        chainId: ARC_CHAIN_ID,
        address: token.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [check.recipient, check.raw],
      })
      setHash(h)
      recordActivity({
        hash: h,
        kind: 'send',
        chainId: ARC_CHAIN_ID,
        account: address,
        summary: `Sent ${fmtToken(check.raw, token.decimals, 4)} ${token.symbol} to ${shortAddr(check.recipient)}`,
      })
    } catch (e) {
      const parsed = parseTxError(e)
      if (parsed.rejected) toast('Transaction cancelled')
      else setError(parsed.message)
    } finally {
      setBusy(false)
    }
  }

  if (hash) {
    return (
      <Card className="space-y-4">
        <TxStatus hash={hash} chainId={ARC_CHAIN_ID} title="Transfer" onSettled={() => void balances.refetch()} />
        <button
          className="btn-ghost w-full"
          onClick={() => {
            setHash(undefined)
            setStep('edit')
            setAmount('')
            setTo('')
          }}
        >
          Send another
        </button>
      </Card>
    )
  }

  return (
    <Card className="mx-auto max-w-xl space-y-5">
      {step === 'edit' ? (
        <>
          <div>
            <label className="label" htmlFor="to">
              Recipient address
            </label>
            <input
              id="to"
              className="field mt-2 font-mono text-sm"
              placeholder="0x…"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {check.toError && <p className="mt-1.5 text-sm text-flux-pink">{check.toError}</p>}
            {check.warn && <p className="mt-1.5 text-sm text-amber-300">{check.warn}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="label" htmlFor="amt">
                Amount
              </label>
              <button className="-my-3.5 py-3.5 text-xs font-semibold text-[var(--a)] hover:brightness-125" onClick={setMax} type="button">
                Balance {balance === undefined ? '…' : fmtToken(balance, token.decimals, 4)} · Max
              </button>
            </div>
            <div className="mt-2 flex items-center gap-3 rounded-2xl border border-white/10 bg-navy-950/60 p-2 pl-4 focus-within:border-volt/70">
              <input
                id="amt"
                inputMode="decimal"
                className="min-w-0 flex-1 bg-transparent font-display text-3xl font-semibold text-white outline-none placeholder:text-slate-600 tabular"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/,/g, '.'))}
              />
              <TokenButton token={token} onClick={() => setPicker(true)} />
            </div>
            {check.amountError && <p className="mt-1.5 text-sm text-flux-pink">{check.amountError}</p>}
          </div>

          <Row
            label="Network fee (estimate)"
            value={gas.data ? `${fmtGasUsdc(gas.data.cost)} USDC` : gas.isLoading ? <Spinner /> : 'Unavailable'}
          />

          <button className="btn-primary w-full" disabled={!ready} onClick={() => setStep('review')}>
            Review transfer
          </button>
          <WalletSpeedTest />
        </>
      ) : (
        <>
          <button className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white" onClick={() => setStep('edit')}>
            <ArrowLeft size={16} /> Edit
          </button>
          <div className="glass-inner rounded-2xl p-4 text-center">
            <p className="label">You are sending</p>
            <p className="mt-1 font-display text-4xl font-bold tabular">
              {check.raw ? fmtToken(check.raw, token.decimals, token.decimals) : ''} {token.symbol}
            </p>
          </div>
          <div className="divide-y divide-white/5">
            <Row label="Network" value="Arc mainnet" />
            <Row label="From" value={address ? shortAddr(address) : ''} mono />
            <Row label="To" value={check.recipient ? shortAddr(check.recipient, 10, 8) : ''} mono />
            <Row label="Network fee (estimate)" value={gas.data ? `${fmtGasUsdc(gas.data.cost)} USDC` : '—'} />
          </div>
          {check.recipient && <ExplorerLink href={explorerAddress(ARC_CHAIN_ID, check.recipient)}>Inspect recipient</ExplorerLink>}
          <Notice tone="warn">Transfers on Arc mainnet are final. Check the address character by character before you confirm.</Notice>
          {error && <Notice tone="error">{error}</Notice>}
          <button className="btn-primary w-full" disabled={busy} onClick={() => void submit()}>
            {busy ? (
              <>
                <Spinner /> Confirm in your wallet…
              </>
            ) : (
              <>
                <ArrowUpRight size={18} /> Confirm and sign
              </>
            )}
          </button>
        </>
      )}

      <TokenPicker open={picker} onClose={() => setPicker(false)} rows={balances.rows} onSelect={(t) => setSymbol(t.symbol)} />
    </Card>
  )
}
