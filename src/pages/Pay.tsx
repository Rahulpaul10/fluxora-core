import { useMemo, useState } from 'react'
import { getAddress, isAddress, zeroAddress, type Hex } from 'viem'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { useGuardedWrite } from '@/hooks/useGuardedWallet'
import { toast } from 'sonner'
import { Amount } from '@/onchain-money'
import { useTokenBalances } from '@/hooks/useBalances'
import { usePaymentConfig, toRequest } from '@/hooks/usePaymentData'
import { FLUXORA, fluxoraPaymentsAbi } from '@/config/contracts'
import { ARC_TOKENS, USDC, tokenByAddress } from '@/lib/tokens'
import { ARC_CHAIN_ID } from '@/config/networks'
import { getFees } from '@/lib/fees'
import { fmtToken, shortAddr } from '@/lib/format'
import { parseTxError } from '@/lib/errors'
import { recordActivity } from '@/lib/activity'
import { ensureAllowance } from '@/lib/tx'
import { bytes32ToRef, refToBytes32 } from '@/lib/payments'
import type { View } from '@/lib/router'
import { ArcGate, NotDeployed } from '@/components/Gate'
import { TokenButton, TokenPicker } from '@/components/TokenSelect'
import { TxStatus } from '@/components/TxStatus'
import { Card, Notice, PageTitle, Row, Segmented, Spinner } from '@/components/ui'
import { useNow } from '@/hooks/useNow'
import { RequestTab } from '@/components/pay/RequestTab'
import { ReceiptsTab } from '@/components/pay/ReceiptsTab'

type Tab = 'pay' | 'request' | 'receipts'

export function Pay({ params, navigate }: { params: URLSearchParams; navigate: (v: View, search?: string) => void }) {
  const [tab, setTab] = useState<Tab>('pay')
  return (
    <>
      <PageTitle
        title="Pay"
        subtitle="Pay any wallet, ask others to pay you with a link or QR code, and keep receipts."
      />
      <div className="mx-auto max-w-xl space-y-4">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pay', label: 'Pay' },
            { value: 'request', label: 'Request' },
            { value: 'receipts', label: 'Receipts' },
          ]}
        />
        {tab === 'pay' && (
          <ArcGate feature="Payments">
            <PayTab params={params} navigate={navigate} />
          </ArcGate>
        )}
        {tab === 'request' && (
          <ArcGate feature="Payment requests">
            <RequestTab />
          </ArcGate>
        )}
        {tab === 'receipts' && (
          <ArcGate feature="Receipts">
            <ReceiptsTab />
          </ArcGate>
        )}
      </div>
    </>
  )
}

function PayTab({ params, navigate }: { params: URLSearchParams; navigate: (v: View, search?: string) => void }) {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  const { writeContractAsync } = useGuardedWrite()
  const balances = useTokenBalances()
  const config = usePaymentConfig()

  const requestParam = params.get('request')
  const [to, setTo] = useState(params.get('to') ?? '')
  const [symbol, setSymbol] = useState(ARC_TOKENS.find((t) => t.symbol === params.get('token'))?.symbol ?? USDC.symbol)
  const [amount, setAmount] = useState(params.get('amount') ?? '')
  const [note, setNote] = useState(params.get('ref') ?? '')
  const [picker, setPicker] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'approving' | 'paying'>('idle')
  const [hash, setHash] = useState<Hex>()
  const [error, setError] = useState<string>()

  const row = balances.rows.find((r) => r.token.symbol === symbol) ?? balances.rows[0]
  const token = row.token

  // An onchain request opened from a payment link
  const requestId = requestParam && /^\d+$/.test(requestParam) ? BigInt(requestParam) : undefined
  const request = useReadContract({
    address: FLUXORA.payments,
    abi: fluxoraPaymentsAbi,
    functionName: 'getRequest',
    args: requestId !== undefined ? [requestId] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(FLUXORA.payments && requestId !== undefined) },
  })
  const req = requestId !== undefined && request.data ? toRequest(requestId, request.data) : undefined
  const reqToken = req ? tokenByAddress(req.token) : undefined

  // Is the selected token enabled in the payments contract?
  const supported = useReadContract({
    address: FLUXORA.payments,
    abi: fluxoraPaymentsAbi,
    functionName: 'supportedTokens',
    args: [token.address],
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(FLUXORA.payments) },
  })

  const payingToken = req && reqToken ? reqToken : token
  const rawFromForm = useMemo(() => {
    try {
      if (!amount) return undefined
      const a = Amount.parse(amount, token.decimals)
      return a.isPositive() ? a.raw : undefined
    } catch {
      return undefined
    }
  }, [amount, token.decimals])
  const raw = req ? req.amount : rawFromForm
  const feeBps = config.data?.feeBps ?? 0n
  const fee = raw ? (raw * feeBps + 9_999n) / 10_000n : 0n // contract rounds up
  const total = raw ? raw + fee : 0n
  const payRow = balances.rows.find((r) => r.token.symbol === payingToken.symbol)
  const insufficient = Boolean(raw && payRow?.raw !== undefined && total > payRow.raw)

  const toError = !req && to && (!isAddress(to) || to.toLowerCase() === zeroAddress) ? 'Enter a valid wallet address.' : undefined
  const selfPay = !req && address && to && isAddress(to) && to.toLowerCase() === address.toLowerCase()
  const nowSec = useNow()
  const expired = req && req.expiry !== 0 && req.expiry <= nowSec
  const reqUnavailable = req && (req.status !== 'Open' || expired)

  const valid = Boolean(
    FLUXORA.payments &&
      !config.data?.paused &&
      raw &&
      !insufficient &&
      (req ? !reqUnavailable : isAddress(to) && !toError && !selfPay && supported.data === true),
  )

  const pay = async () => {
    if (!client || !address || !FLUXORA.payments || !raw) return
    setError(undefined)
    try {
      // Read the live fee so the on-chain cap (maxFee) matches what the payer is shown
      const [fees, liveFee] = await Promise.all([
        getFees(client, ARC_CHAIN_ID),
        client.readContract({ address: FLUXORA.payments, abi: fluxoraPaymentsAbi, functionName: 'quoteFee', args: [raw] }),
      ])
      if (liveFee !== fee) throw new Error('The payment fee changed. Review the new total and try again.')
      setPhase('approving')
      await ensureAllowance({
        client, write: (req) => writeContractAsync(req), token: payingToken.address, symbol: payingToken.symbol,
        owner: address, spender: FLUXORA.payments, amount: total, fees,
      })
      setPhase('paying')
      let h: Hex
      if (req && requestId !== undefined) {
        h = await writeContractAsync({
          chainId: ARC_CHAIN_ID, address: FLUXORA.payments, abi: fluxoraPaymentsAbi, functionName: 'payRequest', args: [requestId, liveFee],
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        })
      } else {
        const recipient = getAddress(to)
        const args = [payingToken.address, recipient, raw, refToBytes32(note), note.trim(), liveFee] as const
        h = await writeContractAsync({
          chainId: ARC_CHAIN_ID, address: FLUXORA.payments, abi: fluxoraPaymentsAbi, functionName: 'pay', args,
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        })
      }
      setHash(h)
      recordActivity({
        hash: h, kind: 'payment', chainId: ARC_CHAIN_ID, account: address,
        summary: `Paid ${fmtToken(raw, payingToken.decimals, 4)} ${payingToken.symbol} to ${shortAddr(req ? req.creator : to)}`,
      })
    } catch (e) {
      const p = parseTxError(e)
      if (p.rejected) toast('Payment cancelled')
      else setError(p.message)
    } finally {
      setPhase('idle')
    }
  }

  if (!FLUXORA.payments) {
    return (
      <Card className="space-y-4">
        <NotDeployed contracts={['payments']} />
        <Notice tone="info">Payments with receipts are off until the contract is configured. You can still send directly to any address with a normal transfer.</Notice>
        <button className="btn-primary w-full" onClick={() => navigate('send', `?to=${encodeURIComponent(to)}&amount=${encodeURIComponent(amount)}&token=${symbol}`)}>
          Continue to Send
        </button>
      </Card>
    )
  }

  if (hash) {
    return (
      <Card className="space-y-4">
        <TxStatus hash={hash} chainId={ARC_CHAIN_ID} title="Payment" onSettled={() => { void balances.refetch(); void config.refetch() }} />
        <p className="text-sm text-slate-400">Your receipt is stored onchain. Open the Receipts tab to view it.</p>
        <button className="btn-ghost w-full" onClick={() => { setHash(undefined); setAmount(''); navigate('pay') }}>
          Make another payment
        </button>
      </Card>
    )
  }

  return (
    <Card className="space-y-5">
      {req ? (
        <div className="space-y-2">
          <Notice tone={reqUnavailable ? 'error' : 'info'}>
            Payment request #{requestId?.toString()} from <span className="font-mono">{shortAddr(req.creator)}</span>
            {reqUnavailable ? ` is not payable (${expired ? 'expired' : req.status.toLowerCase()}).` : '. Review the details below.'}
          </Notice>
          <div className="divide-y divide-white/5">
            <Row label="Pay to" value={shortAddr(req.creator, 10, 8)} mono />
            <Row label="Amount" value={reqToken ? `${fmtToken(req.amount, reqToken.decimals, reqToken.decimals)} ${reqToken.symbol}` : 'Unsupported token'} />
            {bytes32ToRef(req.ref) && <Row label="Reference" value={bytes32ToRef(req.ref)} />}
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="pay-to">Wallet address</label>
            <input id="pay-to" className="field mt-2 font-mono text-sm" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} spellCheck={false} />
            {toError && <p className="mt-1.5 text-sm text-flux-pink">{toError}</p>}
            {selfPay && <p className="mt-1.5 text-sm text-flux-pink">You cannot pay your own address.</p>}
          </div>
          <div>
            <label className="label" htmlFor="pay-amt">Amount</label>
            <div className="mt-2 flex items-center gap-3 rounded-2xl border border-white/10 bg-navy-950/60 p-2 pl-4 focus-within:border-volt/70">
              <input id="pay-amt" inputMode="decimal" className="min-w-0 flex-1 bg-transparent font-display text-3xl font-semibold text-white outline-none placeholder:text-slate-600 tabular" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/,/g, '.'))} />
              <TokenButton token={token} onClick={() => setPicker(true)} />
            </div>
            {supported.data === false && <p className="mt-1.5 text-sm text-flux-pink">{token.symbol} is not enabled for FLUXORA payments yet.</p>}
          </div>
          <div>
            <label className="label" htmlFor="pay-note">Note (optional, shared onchain)</label>
            <input id="pay-note" className="field mt-2" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Invoice 42" />
          </div>
        </>
      )}

      {raw ? (
        <div className="divide-y divide-white/5 rounded-2xl border border-white/5 px-4">
          <Row label="Recipient receives" value={`${fmtToken(raw, payingToken.decimals, payingToken.decimals)} ${payingToken.symbol}`} />
          <Row label={`FLUXORA fee (${Number(feeBps) / 100}%)`} value={`${fmtToken(fee, payingToken.decimals, payingToken.decimals)} ${payingToken.symbol}`} />
          <Row label="You pay in total" value={`${fmtToken(total, payingToken.decimals, payingToken.decimals)} ${payingToken.symbol}`} />
        </div>
      ) : null}

      {insufficient && <Notice tone="error">Insufficient {payingToken.symbol} balance for the amount plus fee.</Notice>}
      {config.data?.paused && <Notice tone="warn">Payments are paused by the contract admins.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <button className="btn-primary w-full" disabled={!valid || phase !== 'idle'} onClick={() => void pay()}>
        {phase === 'approving' ? <><Spinner /> Approve {payingToken.symbol} in your wallet…</> : phase === 'paying' ? <><Spinner /> Confirm the payment…</> : 'Pay now'}
      </button>
      <p className="text-center text-xs text-slate-500">
        Funds go straight from your wallet to the recipient. The contract never holds your tokens.
      </p>
      <TokenPicker open={picker} onClose={() => setPicker(false)} rows={balances.rows} onSelect={(t) => setSymbol(t.symbol)} />
    </Card>
  )
}
