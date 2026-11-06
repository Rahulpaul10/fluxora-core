import { useEffect, useState } from 'react'
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
import { arcGasCostUsdc, fmtGasUsdc, getFees, prepaidGasReserveUsdc } from '@/lib/fees'
import { checkSend, maxSendable } from '@/lib/sendReserve'
import { verifySender } from '@/lib/accountSync'
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
/** Only used to price gas before a recipient has been typed (a fresh account costs the most). It is never sent to. */
const ESTIMATE_RECIPIENT: Address = '0x2222222222222222222222222222222222222222'

/** Follows `value` after it has stopped changing for `ms`, so typing does not fire one RPC call per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

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
  // The wallet prices a plain transfer itself: the request carries only from, to and data (no gas or fee fields), so its
  // own simulation and fee estimate run on a standard request. The page still estimates gas to catch a transfer that
  // would revert, and keeps a USDC reserve for the gas the wallet will prepay.
  const { writeContractAsync } = useGuardedWrite({ walletManagedFees: true })
  const balances = useTokenBalances()

  const [symbol, setSymbol] = useState(ARC_TOKENS.find((t) => t.symbol === presetToken)?.symbol ?? USDC.symbol)
  const [to, setTo] = useState(presetTo ?? '')
  const [amount, setAmount] = useState(presetAmount ?? '')
  const [picker, setPicker] = useState(false)
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState(false)
  const [hash, setHash] = useState<Hex>()
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()

  const row = balances.rows.find((r) => r.token.symbol === symbol) ?? balances.rows[0]
  const token: TokenInfo = row.token
  const usdcRow = balances.rows.find((r) => r.token.symbol === 'USDC')
  const balance = row.raw

  // What the gas estimate is priced on: the real recipient and amount once they are valid and affordable, otherwise a
  // placeholder recipient and 1 unit. Never a transfer to yourself, which costs less than a transfer to another account.
  const trimmedTo = to.trim()
  const draftRecipient = isAddress(trimmedTo) ? getAddress(trimmedTo) : undefined
  const draftRaw = (() => {
    try {
      const a = Amount.parse(amount, token.decimals)
      return a.isPositive() ? a.raw : undefined
    } catch {
      return undefined
    }
  })()
  const estimateTo = useDebounced(draftRecipient ?? ESTIMATE_RECIPIENT, 300)
  const estimateAmount = useDebounced(draftRaw !== undefined && balance !== undefined && draftRaw <= balance ? draftRaw : 1n, 300)

  // Real gas estimate for the ERC-20 transfer, priced in USDC. `reserve` is the USDC the chain takes up front
  // (estimate x the wallet's gas multiplier x max fee, rounded up) and is what must stay in the account.
  const gas = useQuery({
    queryKey: ['send-gas', address, token.address, estimateTo, estimateAmount.toString()],
    enabled: Boolean(client && address),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!client || !address) throw new Error('no client')
      const [units, fees] = await Promise.all([
        client.estimateContractGas({ account: address, address: token.address, abi: erc20Abi, functionName: 'transfer', args: [estimateTo, estimateAmount] }),
        getFees(client, ARC_CHAIN_ID),
      ])
      return { units, fees, cost: arcGasCostUsdc(units, fees.maxFeePerGas), reserve: prepaidGasReserveUsdc(units, fees.maxFeePerGas) }
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
        else {
          const verdict = checkSend({ isUsdc: token.symbol === 'USDC', amount: a.raw, tokenBalance: balance, usdcBalance: usdcRow?.raw, reserve: gas.data?.reserve })
          if (verdict.kind === 'ok') result.raw = a.raw
          else if (verdict.kind === 'insufficient-balance') result.amountError = `Insufficient balance. You have ${fmtToken(balance ?? 0n, token.decimals)} ${token.symbol}.`
          else if (verdict.kind === 'insufficient-gas') {
            const reserve = fmtToken(verdict.reserve, 6, 6)
            result.amountError =
              token.symbol !== 'USDC'
                ? `Not enough USDC to pay the network fee. Keep about ${reserve} USDC for gas.`
                : verdict.max > 0n
                  ? `Not enough USDC once the network fee (about ${reserve} USDC) is reserved. The most you can send is ${fmtToken(verdict.max, 6, 6)} USDC.`
                  : `Not enough USDC to cover the network fee (about ${reserve} USDC).`
          } else if (gas.isError && !gas.isFetching) {
            // No fee, no proof the transfer can succeed: do not let it through. Say why when the node did.
            result.amountError = `The network fee could not be estimated, so this transfer cannot be checked. ${parseTxError(gas.error).message}`
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
      // Leave the full prepaid gas (not just the estimated cost): the chain reserves gasLimit x maxFee up front.
      const reserve = gas.data?.reserve
      if (reserve === undefined) {
        setHint('The network fee is still being estimated. Try Max again in a moment.')
        return
      }
      max = maxSendable(balance, reserve)
    }
    setHint(undefined)
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
        // The same account whose balance was checked on this page. The guard refuses the request if the wallet is
        // on a different account, so the sender can never silently differ from the one shown.
        account: address,
        address: token.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [check.recipient, check.raw],
      })
      setHash(h)
      // Read the transaction back: if the wallet signed from another account than the one shown, say so loudly.
      void verifySender(client, h, address).then((v) => {
        if (v.status === 'mismatch') {
          toast.error(`The wallet sent this transfer from ${shortAddr(v.actual)}, not from ${shortAddr(address)} as shown. Check your wallet before sending again.`, { duration: 30_000 })
        }
      })
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
                onChange={(e) => {
                  setHint(undefined)
                  setAmount(e.target.value.replace(/,/g, '.'))
                }}
              />
              <TokenButton token={token} onClick={() => setPicker(true)} />
            </div>
            {(check.amountError ?? hint) && <p className="mt-1.5 text-sm text-flux-pink">{check.amountError ?? hint}</p>}
          </div>

          <Row label="From" value={address ? shortAddr(address) : ''} mono />
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
