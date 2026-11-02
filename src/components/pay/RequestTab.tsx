import { useEffect, useMemo, useState } from 'react'
import { parseEventLogs, type Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { useGuardedWrite } from '@/hooks/useGuardedWallet'
import { QRCodeSVG } from 'qrcode.react'
import { Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Amount } from '@/onchain-money'
import { useTokenBalances } from '@/hooks/useBalances'
import { useMyRequests } from '@/hooks/usePaymentData'
import { FLUXORA, fluxoraPaymentsAbi } from '@/config/contracts'
import { ARC_TOKENS, USDC, tokenByAddress } from '@/lib/tokens'
import { ARC_CHAIN_ID } from '@/config/networks'
import { getFees } from '@/lib/fees'
import { waitForReceipt } from '@/lib/txTracker'
import { fmtDate, fmtToken } from '@/lib/format'
import { parseTxError } from '@/lib/errors'
import { recordActivity } from '@/lib/activity'
import { bytes32ToRef, refToBytes32 } from '@/lib/payments'
import { buildShareLink } from '@/lib/share'
import { TokenButton, TokenPicker } from '@/components/TokenSelect'
import { TxStatus } from '@/components/TxStatus'
import { NotDeployed } from '@/components/Gate'
import { Card, CopyButton, Notice, Segmented, Spinner } from '@/components/ui'

type Mode = 'link' | 'onchain'
const EXPIRIES = [
  { label: 'No expiry', seconds: 0 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86_400 },
  { label: '7 days', seconds: 604_800 },
]

export function RequestTab() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  const { writeContractAsync } = useGuardedWrite()
  const balances = useTokenBalances()
  const mine = useMyRequests()

  const [mode, setMode] = useState<Mode>('link')
  const [symbol, setSymbol] = useState(USDC.symbol)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [expiry, setExpiry] = useState(0)
  const [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hash, setHash] = useState<Hex>()
  const [requestId, setRequestId] = useState<bigint>()
  const [error, setError] = useState<string>()
  const [resolved, setResolved] = useState<{ path: string; url: string }>()

  const token = balances.rows.find((r) => r.token.symbol === symbol)?.token ?? ARC_TOKENS[0]
  const raw = useMemo(() => {
    try {
      if (!amount) return undefined
      const a = Amount.parse(amount, token.decimals)
      return a.isPositive() ? a.raw : undefined
    } catch {
      return undefined
    }
  }, [amount, token.decimals])

  // The path is derived during render; the share base is resolved once per path so Copy/Share stay instant
  let linkPath: string | undefined
  if (mode === 'link' && address && raw) {
    const q = new URLSearchParams({ to: address, token: token.symbol, amount: Amount.fromRaw(raw, token.decimals).toString() })
    if (note.trim()) q.set('ref', note.trim().slice(0, 31))
    linkPath = `/pay?${q.toString()}`
  } else if (mode === 'onchain' && requestId !== undefined) {
    linkPath = `/pay?request=${requestId.toString()}`
  }
  useEffect(() => {
    if (!linkPath) return
    let live = true
    buildShareLink(linkPath)
      .then((url) => live && setResolved({ path: linkPath, url }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [linkPath])
  const link = resolved && resolved.path === linkPath ? resolved.url : undefined

  const createOnchain = async () => {
    if (!client || !address || !FLUXORA.payments || !raw) return
    setBusy(true)
    setError(undefined)
    try {
      const exp = expiry === 0 ? 0n : BigInt(Math.floor(Date.now() / 1000) + expiry)
      const args = [token.address, raw, exp, refToBytes32(note), note.trim()] as const
      const fees = await getFees(client, ARC_CHAIN_ID)
      const h = await writeContractAsync({
        chainId: ARC_CHAIN_ID, address: FLUXORA.payments, abi: fluxoraPaymentsAbi, functionName: 'createRequest', args,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
      setHash(h)
      recordActivity({ hash: h, kind: 'request', chainId: ARC_CHAIN_ID, account: address, summary: `Created a request for ${amount} ${token.symbol}` })
      const receipt = await waitForReceipt(client, h)
      if (receipt.status === 'success') {
        const logs = parseEventLogs({ abi: fluxoraPaymentsAbi, logs: receipt.logs, eventName: 'RequestCreated' })
        setRequestId(logs[0]?.args.requestId)
        void mine.refetch()
      }
    } catch (e) {
      const p = parseTxError(e)
      if (p.rejected) toast('Cancelled')
      else setError(p.message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (id: bigint) => {
    if (!client || !address || !FLUXORA.payments) return
    try {
      const fees = await getFees(client, ARC_CHAIN_ID)
      const h = await writeContractAsync({
        chainId: ARC_CHAIN_ID, address: FLUXORA.payments, abi: fluxoraPaymentsAbi, functionName: 'cancelRequest', args: [id],
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
      recordActivity({ hash: h, kind: 'request', chainId: ARC_CHAIN_ID, account: address, summary: `Cancelled request #${id}` })
      await waitForReceipt(client, h)
      void mine.refetch()
      toast.success('Request cancelled')
    } catch (e) {
      const p = parseTxError(e)
      if (!p.rejected) toast.error(p.message)
    }
  }

  const share = async () => {
    if (!link) return
    try {
      if (navigator.share) await navigator.share({ title: 'FLUXORA payment request', url: link })
      else {
        await navigator.clipboard.writeText(link)
        toast.success('Link copied')
      }
    } catch {
      // dismissed
    }
  }

  const ready = Boolean(raw && address)

  return (
    <div className="space-y-4">
      <Card className="space-y-5">
        <Segmented
          value={mode}
          onChange={(m) => { setMode(m); setRequestId(undefined); setHash(undefined) }}
          options={[{ value: 'link', label: 'Payment link' }, { value: 'onchain', label: 'Onchain request' }]}
        />
        <p className="text-sm text-slate-400">
          {mode === 'link'
            ? 'A link and QR code that open a pre-filled payment to your address. Free, no transaction needed.'
            : 'Recorded in the FLUXORA Payments contract. The payer gets a request they can only pay once, and you get an onchain receipt.'}
        </p>

        {mode === 'onchain' && !FLUXORA.payments ? (
          <NotDeployed contracts={['payments']} />
        ) : (
          <>
            <div>
              <label className="label" htmlFor="req-amt">Amount to receive</label>
              <div className="mt-2 flex items-center gap-3 rounded-2xl border border-white/10 bg-navy-950/60 p-2 pl-4 focus-within:border-volt/70">
                <input id="req-amt" inputMode="decimal" className="min-w-0 flex-1 bg-transparent font-display text-3xl font-semibold text-white outline-none placeholder:text-slate-600 tabular" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/,/g, '.'))} />
                <TokenButton token={token} onClick={() => setPicker(true)} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="req-note">Note (optional)</label>
              <input id="req-note" className="field mt-2" maxLength={31} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Invoice 42" />
            </div>
            {mode === 'onchain' && (
              <div>
                <label className="label" htmlFor="req-exp">Expires</label>
                <select id="req-exp" className="field mt-2 !bg-navy-900" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                  {EXPIRIES.map((x) => <option key={x.seconds} value={x.seconds}>{x.label}</option>)}
                </select>
              </div>
            )}
            {mode === 'onchain' && !hash && (
              <button className="btn-primary w-full" disabled={!ready || busy} onClick={() => void createOnchain()}>
                {busy ? <><Spinner /> Confirm in your wallet…</> : 'Create request'}
              </button>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            {hash && <TxStatus hash={hash} chainId={ARC_CHAIN_ID} title="Request creation" />}

            {link && (
              <div className="flex flex-col items-center gap-3 rounded-2xl bg-white/5 p-4">
                <div className="rounded-2xl bg-white p-3"><QRCodeSVG value={link} size={176} level="M" fgColor="#070B1F" /></div>
                <p className="break-all text-center font-mono text-xs text-slate-300">{link}</p>
                <div className="grid w-full grid-cols-2 gap-2">
                  <CopyButton value={link} label="Copy link" />
                  <button className="btn-ghost" onClick={() => void share()}><Share2 size={16} /> Share</button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {FLUXORA.payments && (
        <Card>
          <p className="label mb-3">My onchain requests</p>
          {mine.isLoading ? <Spinner /> : (mine.data ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {(mine.data ?? []).map((r) => {
                const t = tokenByAddress(r.token)
                return (
                  <li key={r.id.toString()} className="flex items-center gap-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-white">#{r.id.toString()} · {t ? `${fmtToken(r.amount, t.decimals, t.decimals)} ${t.symbol}` : 'Unknown token'}</p>
                      <p className="text-xs text-slate-400">{r.status}{r.expiry ? ` · expires ${fmtDate(r.expiry)}` : ''}{bytes32ToRef(r.ref) ? ` · ${bytes32ToRef(r.ref)}` : ''}</p>
                    </div>
                    {r.status === 'Open' && <button className="btn-ghost !min-h-[40px]" onClick={() => void cancel(r.id)}>Cancel</button>}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}
      <TokenPicker open={picker} onClose={() => setPicker(false)} rows={balances.rows} onSelect={(t) => setSymbol(t.symbol)} />
    </div>
  )
}
