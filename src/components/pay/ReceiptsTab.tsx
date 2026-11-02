import { useState } from 'react'
import type { Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { toast } from 'sonner'
import { usePaymentReceipts } from '@/hooks/usePaymentData'
import { FLUXORA } from '@/config/contracts'
import { ARC_CHAIN_ID, explorerAddress, explorerTx } from '@/config/networks'
import { fmtDate, fmtToken, shortAddr } from '@/lib/format'
import { bytes32ToRef, findPaymentTx, type ReceiptData } from '@/lib/payments'
import { tokenByAddress } from '@/lib/tokens'
import { NotDeployed } from '@/components/Gate'
import { Card, CopyButton, ExplorerLink, Row, Spinner } from '@/components/ui'

export function ReceiptsTab() {
  const receipts = usePaymentReceipts()
  const [open, setOpen] = useState<bigint>()

  if (!FLUXORA.payments) {
    return <NotDeployed contracts={['payments']} />
  }
  if (receipts.isLoading) return <Card><Spinner /></Card>
  const list = receipts.data ?? []
  if (list.length === 0) {
    return <Card><p className="py-8 text-center text-sm text-slate-400">No payments with receipts yet.</p></Card>
  }
  return (
    <Card className="!p-2 sm:!p-3">
      <ul className="divide-y divide-white/5">
        {list.map((r) => {
          const t = tokenByAddress(r.token)
          return (
            <li key={r.id.toString()}>
              <button className="flex min-h-[60px] w-full items-center gap-3 px-3 py-2 text-left" onClick={() => setOpen(open === r.id ? undefined : r.id)} aria-expanded={open === r.id}>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-white">{r.direction === 'sent' ? 'Paid' : 'Received'} {t ? `${fmtToken(r.amount, t.decimals, t.decimals)} ${t.symbol}` : ''}</p>
                  <p className="text-xs text-slate-400">{r.direction === 'sent' ? 'to' : 'from'} {shortAddr(r.direction === 'sent' ? r.recipient : r.payer)} · {fmtDate(r.timestamp)}</p>
                </div>
                <span className="text-xs text-slate-500">Receipt #{r.id.toString()}</span>
              </button>
              {open === r.id && <ReceiptDetail r={r} />}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function ReceiptDetail({ r }: { r: ReceiptData }) {
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  const t = tokenByAddress(r.token)
  const [tx, setTx] = useState<Hex | null | undefined>()
  const [looking, setLooking] = useState(false)
  const amount = t ? `${fmtToken(r.amount, t.decimals, t.decimals)} ${t.symbol}` : r.amount.toString()
  const fee = t ? `${fmtToken(r.fee, t.decimals, t.decimals)} ${t.symbol}` : r.fee.toString()
  const note = bytes32ToRef(r.ref)

  const text = [
    `FLUXORA payment receipt #${r.id}`,
    `Network: Arc mainnet`,
    `Date: ${fmtDate(r.timestamp)}`,
    `From: ${r.payer}`,
    `To: ${r.recipient}`,
    `Amount: ${amount}`,
    `Fee: ${fee}`,
    note ? `Reference: ${note}` : '',
    tx ? `Transaction: ${tx}` : '',
  ].filter(Boolean).join('\n')

  const find = async () => {
    if (!client) return
    setLooking(true)
    try {
      const h = await findPaymentTx(client, r.id, r.timestamp)
      setTx(h)
      if (!h) toast('Transaction not found in the expected block range.')
    } catch {
      toast.error('Could not look up the transaction.')
    } finally {
      setLooking(false)
    }
  }

  return (
    <div className="mx-3 mb-3 space-y-1 rounded-2xl bg-navy-950/60 p-4">
      <Row label="Payer" value={r.payer} mono />
      <Row label="Recipient" value={r.recipient} mono />
      <Row label="Amount" value={amount} />
      <Row label="Fee" value={fee} />
      {note && <Row label="Reference" value={note} />}
      <Row label="Time" value={fmtDate(r.timestamp)} />
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <CopyButton value={text} label="Copy receipt" className="!min-h-[40px]" />
        {tx ? <ExplorerLink href={explorerTx(ARC_CHAIN_ID, tx)}>Transaction</ExplorerLink> : (
          <button className="btn-ghost !min-h-[40px]" onClick={() => void find()} disabled={looking}>{looking ? <Spinner /> : 'Find transaction'}</button>
        )}
        {FLUXORA.payments && <ExplorerLink href={explorerAddress(ARC_CHAIN_ID, FLUXORA.payments)}>Contract</ExplorerLink>}
      </div>
    </div>
  )
}
